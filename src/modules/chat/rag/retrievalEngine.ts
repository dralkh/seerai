/**
 * Retrieval engine for the RAG system.
 * Orchestrates the full pipeline: indexing → embedding → search → ranking → context assembly.
 *
 * Integration point: called from assistant.ts when RAG is activated.
 */

import { config } from "../../../../package.json";
import { ChatStateManager } from "../stateManager";
import { getEmbeddingService } from "./embeddingService";
import { chunkPaperContent, chunkDocument } from "./chunker";
import { getVectorStore, VectorStore } from "./vectorStore";
import type {
  RetrievalOptions,
  RetrievalResult,
  RetrievedChunk,
  RAGConfig,
  VectorSearchResult,
  TokenBudget,
  RAGProgressCallback,
} from "./types";

// ─── RAG Configuration from preferences ─────────────────────────────────────

/** Max items to index concurrently (each item makes multiple embedding API calls) */
const MAX_CONCURRENT_ITEM_INDEXING = 3;

/**
 * Load RAG configuration from Zotero preferences.
 */
export function getRAGConfig(): RAGConfig {
  const pref = (key: string, fallback: any) => {
    try {
      const val = Zotero.Prefs.get(`${config.prefsPrefix}.${key}`);
      return val !== undefined && val !== null ? val : fallback;
    } catch {
      return fallback;
    }
  };

  return {
    enabled: pref("ragEnabled", true) as boolean,
    tokenThreshold: pref("ragTokenThreshold", 64000) as number,
    topK: pref("ragTopK", 20) as number,
    minScore: (pref("ragMinScore", 30) as number) / 100,
    chunkSize: pref("ragChunkSize", 512) as number,
    chunkOverlap: pref("ragChunkOverlap", 64) as number,
  };
}

// ─── Main retrieval function ─────────────────────────────────────────────────

/**
 * Retrieve relevant context for a user query using semantic search.
 *
 * This is the main entry point called from assistant.ts when RAG is activated.
 * It handles the full pipeline:
 *   1. Check which context items need indexing
 *   2. Index unindexed items on-demand (extract text → chunk → embed → store)
 *   3. Embed the user query
 *   4. Search the vector store for similar chunks
 *   5. Re-rank results by relevance + source priority + recency
 *   6. Assemble context string within the token budget
 *
 * @param query         The user's query text
 * @param contextItems  Items from ChatContextManager that need to be searched
 * @param contentExtractor  Function to extract text content for a Zotero item
 * @param options       Retrieval parameters
 * @returns RetrievalResult with formatted context and metadata
 */
export async function retrieveContext(
  query: string,
  contextItems: Array<{
    id: number | string;
    type: string;
    displayName: string;
    metadata?: Record<string, any>;
  }>,
  contentExtractor: (itemId: number) => Promise<{
    abstract?: string;
    notes?: string[];
    pdfText?: string;
    title?: string;
    authors?: string[];
  } | null>,
  options?: RetrievalOptions,
): Promise<RetrievalResult> {
  const startTime = Date.now();
  const ragConfig = getRAGConfig();
  const embeddingService = getEmbeddingService();
  const vectorStore = getVectorStore();

  const topK = options?.topK ?? ragConfig.topK;
  const maxTokens = options?.maxTokens ?? ragConfig.tokenThreshold;
  const minScore = options?.minScore ?? ragConfig.minScore;
  const rerank = options?.rerank ?? true;
  const passthroughContext = options?.passthroughContext ?? "";
  const onProgress = options?.onProgress;

  let itemsIndexedOnDemand = 0;

  Zotero.debug(
    `[seerai] RAG retrieval: query="${query.substring(0, 80)}...", ` +
      `contextItems=${contextItems.length}, topK=${topK}, maxTokens=${maxTokens}`,
  );

  // ── Step 1: Collect paper-type item IDs that can be indexed ────────────────
  const paperItemIds: number[] = [];
  const itemTitles: Map<number, string> = new Map();

  for (const item of contextItems) {
    if (item.type === "paper" && typeof item.id === "number") {
      paperItemIds.push(item.id);
      itemTitles.set(item.id, item.displayName);
    }
    // For collections, tags, authors — their expanded item IDs
    // should be resolved by the caller before passing to this function.
    // We only handle direct paper references here.
  }

  if (paperItemIds.length === 0) {
    // No paper items to search, but we may still have passthrough content
    if (passthroughContext) {
      Zotero.debug(
        "[seerai] RAG: no paper items, returning passthrough context only",
      );
      const ptTokens = ChatStateManager.countTokens(passthroughContext);
      return {
        context: "=== Context (Semantic Search) ===\n" + passthroughContext,
        chunks: [],
        stats: {
          totalChunksSearched: 0,
          chunksRetrieved: 0,
          tokensUsed: ptTokens,
          itemsIndexedOnDemand: 0,
          queryTimeMs: Date.now() - startTime,
        },
      };
    }
    Zotero.debug("[seerai] RAG: no paper items in context, returning empty");
    return {
      context: "",
      chunks: [],
      stats: {
        totalChunksSearched: 0,
        chunksRetrieved: 0,
        tokensUsed: 0,
        itemsIndexedOnDemand: 0,
        queryTimeMs: Date.now() - startTime,
      },
    };
  }

  // ── Step 2: Index unindexed items on-demand (parallel) ─────────────────────
  // Collect items that need indexing, then process them in parallel waves.
  const itemsToIndex: Array<{ itemId: number; reason: string }> = [];

  for (const itemId of paperItemIds) {
    try {
      const isIndexed = await vectorStore.isIndexed(itemId);

      if (!isIndexed) {
        itemsToIndex.push({ itemId, reason: "new" });
      } else {
        // Check staleness — re-index if content has changed
        const content = await contentExtractor(itemId);
        if (content) {
          const currentHash = VectorStore.contentHash(
            (content.abstract || "") +
              (content.notes?.join("") || "") +
              (content.pdfText || ""),
          );
          if (await vectorStore.isStale(itemId, currentHash)) {
            itemsToIndex.push({ itemId, reason: "stale" });
          }
        }
      }
    } catch (e) {
      Zotero.debug(`[seerai] RAG: failed to check item ${itemId}: ${e}`);
    }
  }

  if (itemsToIndex.length > 0) {
    onProgress?.({
      step: "indexing",
      message: `Indexing ${itemsToIndex.length} paper${itemsToIndex.length > 1 ? "s" : ""}...`,
      stats: { itemsToIndex: itemsToIndex.length, itemsIndexed: 0 },
    });

    Zotero.debug(
      `[seerai] RAG: indexing ${itemsToIndex.length} items in parallel ` +
        `(concurrency: ${MAX_CONCURRENT_ITEM_INDEXING})`,
    );

    // Process in waves of MAX_CONCURRENT_ITEM_INDEXING
    for (
      let i = 0;
      i < itemsToIndex.length;
      i += MAX_CONCURRENT_ITEM_INDEXING
    ) {
      const wave = itemsToIndex.slice(i, i + MAX_CONCURRENT_ITEM_INDEXING);
      const results = await Promise.allSettled(
        wave.map(async ({ itemId, reason }) => {
          Zotero.debug(
            `[seerai] RAG: on-demand indexing item ${itemId} (${reason})`,
          );
          await indexSingleItem(
            itemId,
            contentExtractor,
            embeddingService,
            vectorStore,
            ragConfig,
          );
        }),
      );

      for (let j = 0; j < results.length; j++) {
        if (results[j].status === "fulfilled") {
          itemsIndexedOnDemand++;
        } else {
          const err = (results[j] as PromiseRejectedResult).reason;
          Zotero.debug(
            `[seerai] RAG: failed to index item ${wave[j].itemId}: ${err}`,
          );
        }
      }

      onProgress?.({
        step: "indexing",
        message: `Indexed ${itemsIndexedOnDemand}/${itemsToIndex.length} papers...`,
        stats: {
          itemsToIndex: itemsToIndex.length,
          itemsIndexed: itemsIndexedOnDemand,
        },
      });
    }
  }

  // ── Step 3: Embed the user query ──────────────────────────────────────────
  onProgress?.({
    step: "embedding-query",
    message: "Embedding your query...",
  });

  let queryEmbedding: number[];
  try {
    queryEmbedding = await embeddingService.getEmbedding(query);
  } catch (e) {
    Zotero.debug(`[seerai] RAG: failed to embed query: ${e}`);
    // Return empty — caller will fall back to full-text context
    return {
      context: "",
      chunks: [],
      stats: {
        totalChunksSearched: 0,
        chunksRetrieved: 0,
        tokensUsed: 0,
        itemsIndexedOnDemand,
        queryTimeMs: Date.now() - startTime,
      },
    };
  }

  // ── Step 4: Search vector store ───────────────────────────────────────────
  onProgress?.({
    step: "searching",
    message: `Searching ${paperItemIds.length} paper${paperItemIds.length > 1 ? "s" : ""} for relevant passages...`,
  });

  let searchResult = await vectorStore.searchSimilar(
    queryEmbedding,
    topK * 2, // Fetch extra for re-ranking
    paperItemIds,
    minScore,
  );

  // ── Step 4b: Handle dimension mismatch — clear stale items, re-index, retry
  if (
    searchResult.dimensionMismatch &&
    searchResult.mismatchedItemIds.length > 0
  ) {
    Zotero.debug(
      `[seerai] RAG: dimension mismatch on ${searchResult.mismatchedItemIds.length} item(s). ` +
        `Clearing stale vectors and re-indexing with current model...`,
    );

    // Remove stale vectors for mismatched items
    for (const itemId of searchResult.mismatchedItemIds) {
      try {
        await vectorStore.removeItem(itemId);
      } catch (e) {
        Zotero.debug(
          `[seerai] RAG: failed to remove stale vectors for item ${itemId}: ${e}`,
        );
      }
    }

    // Re-index the mismatched items
    const reindexItems = searchResult.mismatchedItemIds.map((itemId) => ({
      itemId,
      reason: "dimension-mismatch",
    }));

    for (
      let i = 0;
      i < reindexItems.length;
      i += MAX_CONCURRENT_ITEM_INDEXING
    ) {
      const wave = reindexItems.slice(i, i + MAX_CONCURRENT_ITEM_INDEXING);
      const results = await Promise.allSettled(
        wave.map(async ({ itemId, reason }) => {
          Zotero.debug(`[seerai] RAG: re-indexing item ${itemId} (${reason})`);
          await indexSingleItem(
            itemId,
            contentExtractor,
            embeddingService,
            vectorStore,
            ragConfig,
          );
        }),
      );

      for (let j = 0; j < results.length; j++) {
        if (results[j].status === "fulfilled") {
          itemsIndexedOnDemand++;
        } else {
          const err = (results[j] as PromiseRejectedResult).reason;
          Zotero.debug(
            `[seerai] RAG: failed to re-index item ${wave[j].itemId}: ${err}`,
          );
        }
      }
    }

    // Retry search after re-indexing
    Zotero.debug(
      "[seerai] RAG: retrying search after dimension-mismatch re-index",
    );
    searchResult = await vectorStore.searchSimilar(
      queryEmbedding,
      topK * 2,
      paperItemIds,
      minScore,
    );

    if (searchResult.dimensionMismatch) {
      // Still mismatched after re-index — something is wrong, give up
      Zotero.debug(
        "[seerai] RAG: dimension mismatch persists after re-index, falling back to full context",
      );
      return {
        context: "",
        chunks: [],
        stats: {
          totalChunksSearched: 0,
          chunksRetrieved: 0,
          tokensUsed: 0,
          itemsIndexedOnDemand,
          queryTimeMs: Date.now() - startTime,
        },
      };
    }
  }

  const rawResults = searchResult.chunks;

  Zotero.debug(
    `[seerai] RAG: vector search returned ${rawResults.length} candidates`,
  );

  // ── Step 5: Re-rank ───────────────────────────────────────────────────────
  onProgress?.({
    step: "reranking",
    message: `Ranking ${rawResults.length} candidates by relevance...`,
    stats: { candidateCount: rawResults.length },
  });

  let rankedResults: RetrievedChunk[];

  if (rerank && rawResults.length > 0) {
    rankedResults = rerankResults(rawResults);
  } else {
    rankedResults = rawResults;
  }

  // ── Step 5b: Adaptive retrieval — detect relevance cliff ────────────────
  const useAdaptive = options?.adaptiveRetrieval ?? true;
  if (useAdaptive && rankedResults.length > 1) {
    rankedResults = applyAdaptiveSelection(rankedResults);
  }

  // Hard-cap at topK after adaptive selection. We over-fetched topK*2 candidates
  // for reranking, but the final list must respect the user's Max Passages setting.
  if (rankedResults.length > topK) {
    Zotero.debug(
      `[seerai] RAG: trimming ${rankedResults.length} results to topK=${topK}`,
    );
    rankedResults = rankedResults.slice(0, topK);
  }

  // Emit ranked results so the UI can show live rankings
  if (onProgress && rankedResults.length > 0) {
    const rerankEntries: Array<{
      title: string;
      score: number;
      source: string;
      description?: string;
    }> = rankedResults.map((r) => ({
      title: r.sourceItem.title,
      score: r.score,
      source: r.chunk.source,
      description:
        r.chunk.text.substring(0, 300).trim() +
        (r.chunk.text.length > 300 ? "..." : ""),
    }));

    // Include passthrough items so the user can see them during ranking
    if (passthroughContext) {
      rerankEntries.push(...parsePassthroughSections(passthroughContext));
    }

    onProgress({
      step: "reranking",
      message: `${rankedResults.length} passages ranked by relevance`,
      rankedResults: rerankEntries,
      stats: {
        candidateCount: rawResults.length,
        selectedCount: rankedResults.length,
      },
    });
  }

  // ── Step 6: Budget-aware context assembly with passthrough management ────
  onProgress?.({
    step: "assembling",
    message: "Assembling context within token budget...",
  });

  // Determine effective token budget: prefer explicit tokenBudget from model
  // context window, fall back to legacy maxTokens parameter.
  const tokenBudget = options?.tokenBudget;
  const effectiveBudget = tokenBudget
    ? tokenBudget.availableForContent
    : maxTokens;

  const passthroughTokens = passthroughContext
    ? ChatStateManager.countTokens(passthroughContext)
    : 0;

  let finalContext: string;
  let totalTokensUsed: number;
  let selectedChunks: RetrievedChunk[];

  if (passthroughTokens <= effectiveBudget * 0.6) {
    // ── Tier 1: Passthrough fits comfortably — keep verbatim ──────────────
    const ragTokenBudget = Math.max(effectiveBudget - passthroughTokens, 0);

    const assembled = assembleContext(
      rankedResults,
      ragTokenBudget,
      itemTitles,
    );
    selectedChunks = assembled.selectedChunks;

    finalContext = assembled.context;
    totalTokensUsed = assembled.tokensUsed;
    if (passthroughContext) {
      finalContext += "\n\n" + passthroughContext;
      totalTokensUsed += passthroughTokens;
    }

    Zotero.debug(
      `[seerai] RAG budget tier 1 (passthrough verbatim): ` +
        `passthrough=${passthroughTokens}, ragBudget=${ragTokenBudget}, ` +
        `effectiveBudget=${effectiveBudget}`,
    );
  } else if (passthroughTokens <= effectiveBudget * 0.85) {
    // ── Tier 2: Passthrough is large — give RAG a minimum budget ──────────
    const ragMinBudget = Math.max(effectiveBudget * 0.15, 8000);
    const passthroughBudget = effectiveBudget - ragMinBudget;

    const assembled = assembleContext(rankedResults, ragMinBudget, itemTitles);
    selectedChunks = assembled.selectedChunks;

    // Trim passthrough to fit its budget
    const trimmedPassthrough = trimToTokenBudget(
      passthroughContext,
      passthroughBudget,
    );

    finalContext = assembled.context;
    totalTokensUsed = assembled.tokensUsed;
    if (trimmedPassthrough) {
      finalContext += "\n\n" + trimmedPassthrough;
      totalTokensUsed += ChatStateManager.countTokens(trimmedPassthrough);
    }

    Zotero.debug(
      `[seerai] RAG budget tier 2 (passthrough trimmed): ` +
        `passthrough=${passthroughTokens}→${ChatStateManager.countTokens(trimmedPassthrough)}, ` +
        `ragBudget=${ragMinBudget}, effectiveBudget=${effectiveBudget}`,
    );
  } else {
    // ── Tier 3: Passthrough alone exceeds budget — RAG over passthrough ───
    // Chunk the passthrough content and create in-memory similarity search
    Zotero.debug(
      `[seerai] RAG budget tier 3 (passthrough→RAG): passthrough=${passthroughTokens} ` +
        `exceeds 85% of budget=${effectiveBudget}, chunking passthrough for vector search`,
    );

    const passthroughChunks = chunkPassthroughForRAG(
      passthroughContext,
      ragConfig,
    );

    onProgress?.({
      step: "embedding-passthrough",
      message: `Chunked passthrough into ${passthroughChunks.length} segments — embedding for relevance search...`,
      stats: { tier: 3 },
    });

    if (passthroughChunks.length > 0 && queryEmbedding) {
      // Embed passthrough chunks
      try {
        const ptTexts = passthroughChunks.map((c) => c.text);

        // Use single getEmbeddings call for optimal concurrency (internal batching)
        const ptEmbeddings = await embeddingService.getEmbeddings(ptTexts);

        // Score passthrough chunks against query
        const ptResults: RetrievedChunk[] = passthroughChunks.map(
          (chunk, i) => ({
            chunk: {
              ...chunk,
              embedding: ptEmbeddings[i],
              embeddingModel:
                embeddingService.getConfiguredModel() || "unknown",
            },
            score: cosineSimilarityDirect(queryEmbedding, ptEmbeddings[i]),
            sourceItem: {
              title: chunk.metadata.title || "Context",
              id: chunk.itemId,
            },
          }),
        );

        // Emit passthrough scoring results
        if (onProgress) {
          const topPt = [...ptResults].sort((a, b) => b.score - a.score);
          onProgress({
            step: "embedding-passthrough",
            message: `Scored ${ptResults.length} passthrough chunks by relevance`,
            rankedResults: topPt.map((r) => ({
              title: r.sourceItem.title,
              score: r.score,
              source: r.chunk.source,
              description:
                r.chunk.text.substring(0, 120).trim() +
                (r.chunk.text.length > 120 ? "..." : ""),
            })),
            stats: {
              candidateCount: ptTexts.length,
              selectedCount: ptResults.length,
              tier: 3,
            },
          });
        }

        // Merge paper RAG results with passthrough RAG results, re-sort
        const allResults = [...rankedResults, ...ptResults];
        allResults.sort((a, b) => b.score - a.score);

        // Emit post-merge ranking showing both paper and passthrough results
        if (onProgress) {
          onProgress({
            step: "reranking",
            message: `Merged ${rankedResults.length} paper + ${ptResults.length} passthrough → ${allResults.length} candidates`,
            rankedResults: allResults.map((r) => ({
              title: r.sourceItem.title,
              score: r.score,
              source: r.chunk.source,
              description:
                r.chunk.text.substring(0, 120).trim() +
                (r.chunk.text.length > 120 ? "..." : ""),
            })),
            stats: {
              candidateCount: allResults.length,
              selectedCount: allResults.length,
            },
          });
        }

        // Apply adaptive selection to merged results
        const adaptiveAll = useAdaptive
          ? applyAdaptiveSelection(allResults)
          : allResults;

        onProgress?.({
          step: "assembling",
          message: `Selecting top ${adaptiveAll.length} passages within ${effectiveBudget.toLocaleString()}-token budget...`,
        });

        const assembled = assembleContext(
          adaptiveAll,
          effectiveBudget,
          itemTitles,
        );
        selectedChunks = assembled.selectedChunks;
        finalContext = assembled.context;
        totalTokensUsed = assembled.tokensUsed;

        Zotero.debug(
          `[seerai] RAG tier 3 complete: ${ptResults.length} passthrough chunks + ` +
            `${rankedResults.length} paper chunks → ${selectedChunks.length} selected, ` +
            `${totalTokensUsed} tokens`,
        );
      } catch (e) {
        // Embedding passthrough failed — fall back to trimmed passthrough
        Zotero.debug(
          `[seerai] RAG tier 3 passthrough embedding failed: ${e}, falling back to trim`,
        );
        onProgress?.({
          step: "embedding-passthrough",
          message: `Passthrough embedding failed — trimming to fit budget`,
        });
        const ragMinBudget = Math.max(effectiveBudget * 0.3, 8000);
        const passthroughBudget = effectiveBudget - ragMinBudget;

        const assembled = assembleContext(
          rankedResults,
          ragMinBudget,
          itemTitles,
        );
        selectedChunks = assembled.selectedChunks;

        const trimmedPassthrough = trimToTokenBudget(
          passthroughContext,
          passthroughBudget,
        );
        finalContext = assembled.context;
        totalTokensUsed = assembled.tokensUsed;
        if (trimmedPassthrough) {
          finalContext += "\n\n" + trimmedPassthrough;
          totalTokensUsed += ChatStateManager.countTokens(trimmedPassthrough);
        }
      }
    } else {
      // No passthrough chunks (empty) — just use RAG results
      const assembled = assembleContext(
        rankedResults,
        effectiveBudget,
        itemTitles,
      );
      selectedChunks = assembled.selectedChunks;
      finalContext = assembled.context;
      totalTokensUsed = assembled.tokensUsed;
    }
  }

  const stats = {
    totalChunksSearched: rawResults.length,
    chunksRetrieved: selectedChunks.length,
    tokensUsed: totalTokensUsed,
    itemsIndexedOnDemand,
    queryTimeMs: Date.now() - startTime,
  };

  Zotero.debug(
    `[seerai] RAG retrieval complete: ${selectedChunks.length} chunks, ` +
      `${totalTokensUsed} tokens (${passthroughTokens} passthrough original), ${stats.queryTimeMs}ms`,
  );

  // Emit final rankings with selected chunks
  if (onProgress) {
    const rankedEntries: Array<{
      title: string;
      score: number;
      source: string;
      description: string;
    }> = selectedChunks.map((r) => ({
      title: r.sourceItem.title,
      score: r.score,
      source: r.chunk.source,
      description:
        r.chunk.text.substring(0, 300).trim() +
        (r.chunk.text.length > 300 ? "..." : ""),
    }));

    // For Tiers 1 & 2, passthrough items were included verbatim but don't
    // appear in the ranked list. Add them so the UI shows what was included.
    if (passthroughContext && passthroughTokens > 0) {
      const ptEntries = parsePassthroughSections(passthroughContext);
      // Append verbatim entries at the end (score -1 signals verbatim)
      rankedEntries.push(...ptEntries);
    }

    onProgress({
      step: "complete",
      message: `Selected ${selectedChunks.length} passages (${totalTokensUsed.toLocaleString()} tokens) in ${stats.queryTimeMs}ms`,
      rankedResults: rankedEntries,
      stats: {
        candidateCount: rawResults.length,
        selectedCount: selectedChunks.length,
        tokensUsed: totalTokensUsed,
      },
    });
  }

  return { context: finalContext, chunks: selectedChunks, stats };
}

// ─── On-demand indexing ──────────────────────────────────────────────────────

/**
 * Index a single Zotero item: extract content → chunk → embed → store.
 */
async function indexSingleItem(
  itemId: number,
  contentExtractor: (itemId: number) => Promise<{
    abstract?: string;
    notes?: string[];
    pdfText?: string;
    title?: string;
    authors?: string[];
  } | null>,
  embeddingService: ReturnType<typeof getEmbeddingService>,
  vectorStore: ReturnType<typeof getVectorStore>,
  ragConfig: RAGConfig,
): Promise<void> {
  const content = await contentExtractor(itemId);
  if (!content) {
    Zotero.debug(`[seerai] RAG: no content to index for item ${itemId}`);
    return;
  }

  // Generate content hash for staleness detection
  const contentHash = VectorStore.contentHash(
    (content.abstract || "") +
      (content.notes?.join("") || "") +
      (content.pdfText || ""),
  );

  // Chunk the document
  const chunks = chunkPaperContent(itemId, content, {
    chunkSize: ragConfig.chunkSize,
    chunkOverlap: ragConfig.chunkOverlap,
  });

  if (chunks.length === 0) {
    Zotero.debug(`[seerai] RAG: no chunks produced for item ${itemId}`);
    return;
  }

  // Embed all chunks in batch
  const texts = chunks.map((c) => c.text);
  const embeddings = await embeddingService.getEmbeddings(texts);

  // Store in vector store
  const model = embeddingService.getConfiguredModel() || "unknown";
  await vectorStore.indexItem(itemId, chunks, embeddings, model, contentHash);

  Zotero.debug(
    `[seerai] RAG: indexed item ${itemId} — ${chunks.length} chunks embedded ` +
      `(${chunks.filter((c) => c.source === "pdf").length} pdf, ` +
      `${chunks.filter((c) => c.source === "note").length} note, ` +
      `${chunks.filter((c) => c.source === "abstract").length} abstract)`,
  );
}

// ─── Re-ranking ──────────────────────────────────────────────────────────────

/** Source priority weights (higher = more important) */
const SOURCE_PRIORITY: Record<string, number> = {
  abstract: 1.0,
  note: 0.85,
  pdf: 0.6,
  metadata: 0.4,
};

/**
 * Re-rank results by combining:
 *   - Cosine similarity (weight: 0.7)
 *   - Source priority (weight: 0.2)
 *   - Position bonus — earlier chunks get a small boost (weight: 0.1)
 */
function rerankResults(results: RetrievedChunk[]): RetrievedChunk[] {
  const maxScore = Math.max(...results.map((r) => r.score), 0.001);

  const reranked = results.map((result) => {
    const normalizedSimilarity = result.score / maxScore;
    const sourcePriority = SOURCE_PRIORITY[result.chunk.source] ?? 0.5;
    // Earlier chunks (lower index) get a slight boost
    const positionBonus = Math.max(0, 1 - result.chunk.chunkIndex * 0.02);

    const combinedScore =
      normalizedSimilarity * 0.7 + sourcePriority * 0.2 + positionBonus * 0.1;

    return { ...result, score: combinedScore };
  });

  reranked.sort((a, b) => b.score - a.score);
  return reranked;
}

// ─── Context assembly ────────────────────────────────────────────────────────

/**
 * Assemble a context string from ranked chunks, respecting the token budget.
 * Groups chunks by source item for readability.
 */
function assembleContext(
  rankedResults: RetrievedChunk[],
  maxTokens: number,
  itemTitles: Map<number, string>,
): {
  context: string;
  selectedChunks: RetrievedChunk[];
  tokensUsed: number;
} {
  if (rankedResults.length === 0) {
    return { context: "", selectedChunks: [], tokensUsed: 0 };
  }

  const selectedChunks: RetrievedChunk[] = [];
  let tokensUsed = 0;

  // Header tokens
  const headerText =
    "=== Context (Semantic Search — most relevant passages) ===\n";
  tokensUsed += ChatStateManager.countTokens(headerText);

  // Greedily select chunks within budget
  const seenChunkIds = new Set<string>();

  for (const result of rankedResults) {
    if (seenChunkIds.has(result.chunk.id)) continue; // Skip duplicates

    const chunkTokens = ChatStateManager.countTokens(result.chunk.text);
    const attributionTokens = 20; // Approximate for "[From: ...]"

    if (tokensUsed + chunkTokens + attributionTokens > maxTokens) {
      // Try to fit partial chunk if it's significantly over budget
      if (tokensUsed < maxTokens * 0.5) {
        // We're less than half full — include a truncated version
        const remainingTokens = maxTokens - tokensUsed - attributionTokens;
        const truncatedText = result.chunk.text.substring(
          0,
          Math.floor(remainingTokens * 3.2),
        );
        if (truncatedText.length > 100) {
          selectedChunks.push({
            ...result,
            chunk: { ...result.chunk, text: truncatedText + "..." },
          });
          tokensUsed +=
            ChatStateManager.countTokens(truncatedText) + attributionTokens;
        }
      }
      break;
    }

    selectedChunks.push(result);
    seenChunkIds.add(result.chunk.id);
    tokensUsed += chunkTokens + attributionTokens;
  }

  // Build context string grouped by source item
  const byItem = new Map<number, RetrievedChunk[]>();
  for (const chunk of selectedChunks) {
    const itemId = chunk.chunk.itemId;
    if (!byItem.has(itemId)) byItem.set(itemId, []);
    byItem.get(itemId)!.push(chunk);
  }

  const parts: string[] = [headerText];

  for (const [itemId, chunks] of byItem) {
    const title =
      itemTitles.get(itemId) ||
      chunks[0]?.chunk.metadata.title ||
      `Item ${itemId}`;
    parts.push(`\n--- ${title} ---`);

    // Sort chunks within each item by original position
    chunks.sort((a, b) => a.chunk.chunkIndex - b.chunk.chunkIndex);

    for (const { chunk, score } of chunks) {
      const sourceLabel =
        chunk.source === "abstract"
          ? "Abstract"
          : chunk.source === "note"
            ? "Note"
            : chunk.source === "pdf"
              ? "Content"
              : chunk.source === "table"
                ? "Table"
                : chunk.source === "file"
                  ? "File"
                  : "Metadata";
      parts.push(`[${sourceLabel} | relevance: ${(score * 100).toFixed(0)}%]`);
      parts.push(chunk.text);
    }
  }

  return {
    context: parts.join("\n"),
    selectedChunks,
    tokensUsed,
  };
}

// ─── Utility: check if RAG should activate ──────────────────────────────────

/**
 * Compute token budget from the model's context window.
 *
 * Formula:
 *   availableForContent = contextLength - systemPrompt - history - webResults
 *                       - reservedOutput - safetyMargin
 *
 * @param contextLength       Model context window (tokens)
 * @param systemPromptTokens  Estimated system prompt tokens
 * @param conversationTokens  All conversation history tokens
 * @param webResultTokens     Web search results tokens
 * @param reservedOutputTokens  Reserved for model response (default: 4096)
 * @returns TokenBudget with all allocations computed
 */
export function computeTokenBudget(
  contextLength: number,
  systemPromptTokens: number,
  conversationTokens: number,
  webResultTokens: number,
  reservedOutputTokens: number = 4096,
): TokenBudget {
  // 12% safety margin: the char-based token heuristic can underestimate
  // by up to 20-30%, so a generous margin prevents context_length_exceeded.
  const safetyMargin = Math.ceil(contextLength * 0.12);
  const availableForContent = Math.max(
    0,
    contextLength -
      systemPromptTokens -
      conversationTokens -
      webResultTokens -
      reservedOutputTokens -
      safetyMargin,
  );

  return {
    contextLength,
    systemPromptTokens,
    conversationTokens,
    webResultTokens,
    reservedOutputTokens,
    safetyMargin,
    availableForContent,
  };
}

// ─── Adaptive Retrieval ─────────────────────────────────────────────────────

/**
 * CAR-inspired adaptive selection: find the "relevance cliff" where
 * similarity scores drop sharply, and only include results above it.
 *
 * Algorithm:
 * 1. Compute score gaps between consecutive results
 * 2. Find the largest gap (the "cliff")
 * 3. Include all results above the cliff
 * 4. Require at least 3 results and at most the original set
 */
function applyAdaptiveSelection(results: RetrievedChunk[]): RetrievedChunk[] {
  if (results.length <= 3) return results; // Too few to detect a cliff

  // Compute gaps between consecutive scores
  const gaps: { index: number; gap: number }[] = [];
  for (let i = 0; i < results.length - 1; i++) {
    gaps.push({
      index: i,
      gap: results[i].score - results[i + 1].score,
    });
  }

  // Find the largest gap (relevance cliff)
  // Only consider gaps after the first 2 results (always keep at least 3)
  const candidateGaps = gaps.slice(2);
  if (candidateGaps.length === 0) return results;

  const maxGap = candidateGaps.reduce(
    (best, g) => (g.gap > best.gap ? g : best),
    candidateGaps[0],
  );

  // Only apply if the cliff is significant (>15% relative drop or >0.05 absolute)
  const avgScore =
    results.reduce((sum, r) => sum + r.score, 0) / results.length;
  const isSignificant = maxGap.gap > avgScore * 0.15 || maxGap.gap > 0.05;

  if (isSignificant) {
    const cutoff = maxGap.index + 1; // Include up to and including the item before the cliff
    Zotero.debug(
      `[seerai] Adaptive retrieval: cliff at position ${cutoff} ` +
        `(gap=${maxGap.gap.toFixed(4)}), keeping ${cutoff} of ${results.length} results`,
    );
    return results.slice(0, cutoff);
  }

  // No significant cliff — return all (caller will budget-constrain)
  return results;
}

// ─── Passthrough Section Parsing (for progress UI) ──────────────────────────

/**
 * Parse passthrough content into display entries for the RAG progress UI.
 * Passthrough items that are included verbatim (Tiers 1 & 2) don't go through
 * the ranking pipeline, so this extracts section headers to show them in the
 * results list with a score of -1 (signaling "included verbatim").
 */
function parsePassthroughSections(passthroughContent: string): Array<{
  title: string;
  score: number;
  source: string;
  description: string;
}> {
  const entries: Array<{
    title: string;
    score: number;
    source: string;
    description: string;
  }> = [];
  if (!passthroughContent) return entries;

  // Match top-level section headers: --- Table: ..., --- File: ..., Focus Topic: ...
  const sectionRe =
    /(?:^|\n)---\s+(Table|File):\s+(.+?)\s+---|\nFocus Topic:\s+"(.+?)"/g;
  let match;
  while ((match = sectionRe.exec(passthroughContent)) !== null) {
    const type = match[1]; // "Table" or "File" (or undefined for Focus Topic)
    if (type) {
      entries.push({
        title: match[2],
        score: -1,
        source: type.toLowerCase(), // "table" or "file"
        description: `Included verbatim (${type.toLowerCase()})`,
      });
    } else if (match[3]) {
      entries.push({
        title: `Focus: "${match[3]}"`,
        score: -1,
        source: "metadata",
        description: "Focus topic included verbatim",
      });
    }
  }

  // If no sections were parsed but there's content, add a generic entry
  if (entries.length === 0 && passthroughContent.trim().length > 0) {
    const tokens = ChatStateManager.countTokens(passthroughContent);
    entries.push({
      title: "Additional context",
      score: -1,
      source: "metadata",
      description: `${tokens.toLocaleString()} tokens included verbatim`,
    });
  }

  return entries;
}

// ─── Passthrough Chunking (for Tier 3 budget) ───────────────────────────────

/**
 * Chunk passthrough content (tables, files, topics) for vector search.
 * Used when passthrough is too large to include verbatim.
 */
function chunkPassthroughForRAG(
  passthroughContent: string,
  ragConfig: RAGConfig,
): import("./types").DocumentChunk[] {
  if (!passthroughContent || passthroughContent.trim().length === 0) return [];

  // ── Parse passthrough content into sections with meaningful titles/sources ──
  // The passthrough string uses section delimiters:
  //   Tables:  "\n--- Table: {name} ---\n..." with sub-sections "--- Paper: {title} ---"
  //   Files:   "\n--- File: {filename} ---\n..."
  //   Topics:  "\nFocus Topic: \"{topic}\" - ..."
  const sections: Array<{
    text: string;
    title: string;
    source: import("./types").ChunkSource;
  }> = [];

  // Split on TOP-LEVEL section headers only (--- Table:, --- File:, Focus Topic:).
  // Do NOT split on "--- Paper:" because those appear as sub-headers within
  // table sections and should stay grouped with their parent table.
  const sectionPattern = /(?:^|\n)(?=---\s+(?:Table|File):\s|Focus Topic:\s)/;
  const rawSections = passthroughContent.split(sectionPattern).filter(Boolean);

  for (const raw of rawSections) {
    const trimmed = raw.trim();
    if (!trimmed) continue;

    // Detect section type from header
    const tableMatch = trimmed.match(/^---\s+Table:\s+(.+?)\s+---/);
    const fileMatch = trimmed.match(/^---\s+File:\s+(.+?)\s+---/);
    const topicMatch = trimmed.match(/^Focus Topic:\s+"(.+?)"/);

    if (tableMatch) {
      sections.push({
        text: trimmed,
        title: `Table: ${tableMatch[1]}`,
        source: "table",
      });
    } else if (fileMatch) {
      sections.push({
        text: trimmed,
        title: `File: ${fileMatch[1]}`,
        source: "file",
      });
    } else if (topicMatch) {
      sections.push({
        text: trimmed,
        title: `Topic: ${topicMatch[1]}`,
        source: "note",
      });
    } else {
      sections.push({
        text: trimmed,
        title: "Context",
        source: "note",
      });
    }
  }

  // If no sections were parsed (no recognizable headers), chunk the whole thing
  if (sections.length === 0) {
    return chunkDocument(
      -1,
      passthroughContent,
      "note",
      { title: "Passthrough Content" },
      { chunkSize: ragConfig.chunkSize, chunkOverlap: ragConfig.chunkOverlap },
    );
  }

  // Chunk each section separately, preserving its title and source.
  // Use distinct negative IDs per section so assembleContext groups them separately.
  const allChunks: import("./types").DocumentChunk[] = [];
  for (let sIdx = 0; sIdx < sections.length; sIdx++) {
    const section = sections[sIdx];
    const sectionItemId = -(sIdx + 1); // -1, -2, -3, ...
    const sectionChunks = chunkDocument(
      sectionItemId,
      section.text,
      section.source,
      { title: section.title },
      { chunkSize: ragConfig.chunkSize, chunkOverlap: ragConfig.chunkOverlap },
    );
    // Make IDs unique across sections
    for (const chunk of sectionChunks) {
      chunk.id = `pt_${allChunks.length}_${chunk.id}`;
    }
    allChunks.push(...sectionChunks);
  }

  return allChunks;
}

/**
 * Trim text to fit within a token budget by removing content from the end.
 * Tries to cut at a paragraph or sentence boundary.
 */
function trimToTokenBudget(text: string, budgetTokens: number): string {
  if (!text) return "";
  const currentTokens = ChatStateManager.countTokens(text);
  if (currentTokens <= budgetTokens) return text;

  // Estimate characters to keep (3.2 chars per token, matching countTokens)
  const targetChars = Math.floor(budgetTokens * 3.2);
  let trimmed = text.substring(0, targetChars);

  // Try to cut at a paragraph break
  const lastParagraph = trimmed.lastIndexOf("\n\n");
  if (lastParagraph > targetChars * 0.7) {
    trimmed = trimmed.substring(0, lastParagraph);
  } else {
    // Try sentence boundary
    const lastSentence = trimmed.lastIndexOf(". ");
    if (lastSentence > targetChars * 0.7) {
      trimmed = trimmed.substring(0, lastSentence + 1);
    }
  }

  return trimmed + "\n\n[... content trimmed to fit context window budget ...]";
}

// ─── Cosine Similarity (for in-memory passthrough scoring) ──────────────────

/**
 * Compute cosine similarity between two vectors.
 * Duplicate of vectorStore's private function — needed for in-memory
 * passthrough chunk scoring in Tier 3 budget mode.
 */
function cosineSimilarityDirect(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const magnitude = Math.sqrt(normA) * Math.sqrt(normB);
  if (magnitude === 0) return 0;

  return dotProduct / magnitude;
}

/**
 * Determine whether RAG should be activated for the current context.
 *
 * Activation rules:
 * 1. An embedding model must be configured
 * 2. Either "always use RAG" is on, OR estimated tokens exceed the threshold
 *
 * The caller is responsible for checking the per-conversation enabled flag.
 * Strategy C (API context-length error recovery) is handled externally in
 * assistant.ts — it bypasses this function entirely.
 *
 * @param estimatedContextTokens  Estimated tokens for the full context
 * @param ragAlwaysUse            Whether "always use RAG" is enabled for this model config
 * @param tokenThreshold          Token threshold from model config (falls back to global pref)
 * @returns true if RAG should be used
 */
export function shouldActivateRAG(
  estimatedContextTokens: number,
  ragAlwaysUse: boolean,
  tokenThreshold: number,
): boolean {
  const embeddingService = getEmbeddingService();

  // RAG requires an embedding model to be configured
  if (!embeddingService.isConfigured()) return false;

  // Always-use: bypass threshold check entirely
  if (ragAlwaysUse) {
    Zotero.debug(
      `[seerai] RAG activated: always-use is enabled (tokens=${estimatedContextTokens})`,
    );
    return true;
  }

  // Threshold check
  if (estimatedContextTokens > tokenThreshold) {
    Zotero.debug(
      `[seerai] RAG activated: tokens (${estimatedContextTokens}) > threshold (${tokenThreshold})`,
    );
    return true;
  }

  return false;
}
