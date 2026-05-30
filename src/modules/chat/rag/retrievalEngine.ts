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
import { mergeHybridResults, invalidateBm25Cache } from "./bm25";
import { crossEncodeRerank, isRerankerConfigured } from "./reranker";
import { isTokenizerAvailable } from "../tokenizer";
import { traverseCitationGraph } from "./citationGraph";
import {
  isEvalEnabled,
  loadGroundTruth,
  findGroundTruth,
  evaluateRetrieval,
} from "./evaluator";
import type {
  RetrievalOptions,
  RetrievalResult,
  RetrievedChunk,
  RAGConfig,
  VectorSearchResult,
  TokenBudget,
  RAGProgressCallback,
  RetrievalStats,
  DocumentChunk,
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
    tokenThreshold: pref("ragTokenThreshold", 16000) as number,
    topK: pref("ragTopK", 20) as number,
    minScore: (pref("ragMinScore", 30) as number) / 100,
    chunkSize: pref("ragChunkSize", 512) as number,
    chunkOverlap: pref("ragChunkOverlap", 64) as number,
    rrfAlpha: (pref("ragRrfAlpha", 55) as number) / 100,
    mmrEnabled: pref("ragMmrEnabled", true) as boolean,
    mmrLambda: (pref("ragMmrLambda", 70) as number) / 100,
    queryExpansion: pref("ragQueryExpansion", true) as boolean,
    multiQueryExpansion: pref("ragMultiQueryExpansion", true) as boolean,
    hydeEnabled: pref("ragHydeEnabled", false) as boolean,
    contextualRetrieval: pref("ragContextualRetrieval", false) as boolean,
    sentenceWindow: pref("ragSentenceWindow", false) as boolean,
    sentenceWindowSize: pref("ragSentenceWindowSize", 3) as number,
    queryDecomposition: pref("ragQueryDecomposition", false) as boolean,
    citationGraphHops: pref("ragCitationGraphHops", 0) as number,
    correctiveEnabled: pref("ragCorrectiveEnabled", false) as boolean,
  };
}

// ─── Corrective RAG (LLM-as-judge → rewrite → re-retrieve) ──────────────────

const CORRECTIVE_EVAL_PROMPT = `You are evaluating whether retrieved text chunks contain sufficient information to fully answer a research query. Be honest and critical.

Query: {query}

Retrieved context chunks:
{chunks}

Evaluate:
1. Does the combined context contain the information needed to answer the query?
2. Is there any critical gap that would prevent a complete answer?

Return a JSON object with no other text:
{"sufficient":true,"reasoning":"...","missing":""}
or
{"sufficient":false,"reasoning":"...","missing":"Describe what critical information is missing"}`;

const CORRECTIVE_REWRITE_PROMPT = `The retrieved information was insufficient to answer a research query. Help by rewriting the query to find the missing information.

Original query: {query}

Missing information: {missing}

Rewrite the query into a more specific, targeted search query that would find this missing information. Focus on keywords and concepts rather than natural language questions. Keep it concise (one sentence).

Return a JSON object with no other text:
{"rewritten_query":"..."}`;

async function evaluateRetrievalSufficiency(
  chunks: RetrievedChunk[],
  query: string,
): Promise<{ sufficient: boolean; reasoning: string; missing: string } | null> {
  if (chunks.length === 0) return null;

  const chunkTexts = chunks
    .slice(0, 10)
    .map(
      (rc, i) =>
        `[${i + 1}] ${rc.chunk.text.substring(0, 500)}${rc.chunk.text.length > 500 ? "..." : ""}`,
    )
    .join("\n\n");

  try {
    const { OpenAIService } = await import("../../openai");
    const service = new OpenAIService();
    const response = await service.chatCompletion([
      {
        role: "system",
        content:
          "You are a research quality evaluator. Always respond with valid JSON only.",
      },
      {
        role: "user",
        content: CORRECTIVE_EVAL_PROMPT.replace("{query}", query).replace(
          "{chunks}",
          chunkTexts,
        ),
      },
    ]);
    const parsed = JSON.parse(response);
    if (typeof parsed.sufficient === "boolean") {
      Zotero.debug(
        `[seerai] RAG corrective: sufficiency=${parsed.sufficient}, reasoning=${parsed.reasoning?.substring(0, 80)}`,
      );
      return {
        sufficient: parsed.sufficient,
        reasoning: parsed.reasoning || "",
        missing: parsed.missing || "",
      };
    }
  } catch (e) {
    Zotero.debug(`[seerai] RAG: corrective eval failed: ${e}`);
  }
  return null;
}

async function rewriteQueryForRetrieval(
  query: string,
  missing: string,
): Promise<string | null> {
  try {
    const { OpenAIService } = await import("../../openai");
    const service = new OpenAIService();
    const response = await service.chatCompletion([
      {
        role: "system",
        content:
          "You are a research query rewriter. Always respond with valid JSON only.",
      },
      {
        role: "user",
        content: CORRECTIVE_REWRITE_PROMPT.replace("{query}", query).replace(
          "{missing}",
          missing,
        ),
      },
    ]);
    const parsed = JSON.parse(response);
    if (parsed.rewritten_query && parsed.rewritten_query.length > 10) {
      Zotero.debug(
        `[seerai] RAG corrective: rewritten query: "${parsed.rewritten_query}"`,
      );
      return parsed.rewritten_query;
    }
  } catch (e) {
    Zotero.debug(`[seerai] RAG: corrective rewrite failed: ${e}`);
  }
  return null;
}

// ─── Content extractor type alias ──────────────────────────────────────────────

type ContentExtractorFn = (itemId: number) => Promise<{
  abstract?: string;
  notes?: string[];
  pdfText?: string;
  title?: string;
  authors?: string[];
  date?: string;
} | null>;

type EmbeddingServiceType = ReturnType<typeof getEmbeddingService>;
type VectorStoreType = ReturnType<typeof getVectorStore>;

type IndexItem = { itemId: number; reason: string };

// ─── Shared parallel indexing ─────────────────────────────────────────────────

/**
 * Index multiple items in parallel waves of MAX_CONCURRENT_ITEM_INDEXING.
 * Returns the count of successfully indexed items.
 */
async function indexItemsInWaves(
  items: IndexItem[],
  contentExtractor: ContentExtractorFn,
  embeddingService: EmbeddingServiceType,
  vectorStore: VectorStoreType,
  ragConfig: RAGConfig,
): Promise<number> {
  let succeeded = 0;

  for (let i = 0; i < items.length; i += MAX_CONCURRENT_ITEM_INDEXING) {
    const wave = items.slice(i, i + MAX_CONCURRENT_ITEM_INDEXING);
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
        succeeded++;
      } else {
        const err = (results[j] as PromiseRejectedResult).reason;
        Zotero.debug(
          `[seerai] RAG: failed to index item ${wave[j].itemId}: ${err}`,
        );
      }
    }
  }

  return succeeded;
}

// ─── Staleness checking ──────────────────────────────────────────────────────

/**
 * Determine which paper items need (re-)indexing.
 * Checks: never indexed → "new", modification timestamp changed or content hash stale → "stale".
 */
async function collectItemsToIndex(
  paperItemIds: number[],
  vectorStore: VectorStoreType,
  contentExtractor: ContentExtractorFn,
): Promise<IndexItem[]> {
  const itemsToIndex: IndexItem[] = [];

  for (const itemId of paperItemIds) {
    try {
      const isIndexed = await vectorStore.isIndexed(itemId);

      if (!isIndexed) {
        itemsToIndex.push({ itemId, reason: "new" });
      } else {
        const zItem = Zotero.Items.get(itemId);
        const currentModified = zItem?.dateModified;
        const indexEntry = await vectorStore.getIndexEntry(itemId);

        if (
          currentModified &&
          indexEntry?.lastModified === currentModified &&
          !(await vectorStore.isStale(itemId, ""))
        ) {
          continue;
        }

        const content = await contentExtractor(itemId);
        if (content) {
          const currentHash = VectorStore.contentHash(
            (content.abstract || "") +
              (content.notes?.join("") || "") +
              (content.pdfText || ""),
          );
          if (
            currentModified !== indexEntry?.lastModified ||
            (await vectorStore.isStale(itemId, currentHash))
          ) {
            itemsToIndex.push({ itemId, reason: "stale" });
          }
        }
      }
    } catch (e) {
      Zotero.debug(`[seerai] RAG: failed to check item ${itemId}: ${e}`);
    }
  }

  return itemsToIndex;
}

// ─── Dense semantic search ───────────────────────────────────────────────────

/**
 * Embed query variants and search the vector store.
 * Handles multi-query fallback, deduplication, and score sorting.
 * Returns the base embedding for downstream MMR/dimension checks.
 */
async function performDenseSearch(
  queryVariants: string[],
  baseQuery: string,
  paperItemIds: number[],
  embeddingService: EmbeddingServiceType,
  vectorStore: VectorStoreType,
  topK: number,
  minScore: number,
  onProgress?: RAGProgressCallback,
): Promise<{
  allDenseChunks: RetrievedChunk[];
  baseEmbedding: number[] | null;
}> {
  onProgress?.({
    step: "embedding-query",
    message:
      queryVariants.length > 1
        ? `Embedding ${queryVariants.length} query variants...`
        : "Embedding your query...",
  });

  let allDenseChunks: RetrievedChunk[] = [];
  let baseEmbedding: number[] | null = null;

  const variantEmbeddings = await Promise.all(
    queryVariants.map((v) =>
      embeddingService
        .getQueryEmbedding(v)
        .catch(() => null as number[] | null),
    ),
  );

  for (let vi = 0; vi < queryVariants.length; vi++) {
    const emb = variantEmbeddings[vi];
    if (!emb) continue;

    if (!baseEmbedding) baseEmbedding = emb;

    const result = await vectorStore.searchSimilar(
      emb,
      topK * 2,
      paperItemIds,
      minScore,
    );

    if (result.dimensionMismatch) continue;

    allDenseChunks.push(...result.chunks);
  }

  if (allDenseChunks.length === 0) {
    const baseEmb = await embeddingService.getQueryEmbedding(baseQuery);
    baseEmbedding = baseEmb;
    const result = await vectorStore.searchSimilar(
      baseEmb,
      topK * 2,
      paperItemIds,
      minScore,
    );
    if (!result.dimensionMismatch) {
      allDenseChunks = result.chunks;
    }
  }

  const seen = new Set<string>();
  allDenseChunks = allDenseChunks
    .filter((c) => {
      const key = c.chunk.id;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, topK * 4);

  return { allDenseChunks, baseEmbedding };
}

// ─── Dimension mismatch handling ─────────────────────────────────────────────

/**
 * Detect and handle embedding dimension mismatches.
 * If stored vectors have different dimensions than the query embedding,
 * clears stale items, re-indexes, and retries the search.
 * Returns the final search result and count of items re-indexed.
 */
async function handleDimensionMismatch(
  allDenseChunks: RetrievedChunk[],
  baseEmbedding: number[] | null,
  paperItemIds: number[],
  contentExtractor: ContentExtractorFn,
  embeddingService: EmbeddingServiceType,
  vectorStore: VectorStoreType,
  ragConfig: RAGConfig,
  topK: number,
  minScore: number,
): Promise<{
  searchResult: VectorSearchResult;
  itemsReindexed: number;
}> {
  let searchResult: VectorSearchResult = {
    chunks: allDenseChunks,
    dimensionMismatch: false,
    mismatchedItemIds: [],
  };
  let itemsReindexed = 0;

  if (baseEmbedding && paperItemIds.length > 0) {
    const index = await vectorStore.getIndexEntry(paperItemIds[0]);
    const queryDim = baseEmbedding.length;
    if (index && queryDim > 0 && index.dimensions !== queryDim) {
      const mismatchedIds: number[] = [];
      for (const itemId of paperItemIds) {
        const entry = await vectorStore.getIndexEntry(itemId);
        if (entry && entry.dimensions !== queryDim) {
          mismatchedIds.push(itemId);
        }
      }
      if (mismatchedIds.length > 0) {
        searchResult = {
          chunks: [],
          dimensionMismatch: true,
          mismatchedItemIds: mismatchedIds,
        };
      }
    }
  }

  if (
    searchResult.dimensionMismatch &&
    searchResult.mismatchedItemIds.length > 0
  ) {
    Zotero.debug(
      `[seerai] RAG: dimension mismatch on ${searchResult.mismatchedItemIds.length} item(s). ` +
        `Clearing stale vectors and re-indexing with current model...`,
    );

    for (const itemId of searchResult.mismatchedItemIds) {
      try {
        await vectorStore.removeItem(itemId);
      } catch (e) {
        Zotero.debug(
          `[seerai] RAG: failed to remove stale vectors for item ${itemId}: ${e}`,
        );
      }
    }

    const reindexItems = searchResult.mismatchedItemIds.map((itemId) => ({
      itemId,
      reason: "dimension-mismatch" as const,
    }));

    itemsReindexed = await indexItemsInWaves(
      reindexItems,
      contentExtractor,
      embeddingService,
      vectorStore,
      ragConfig,
    );

    Zotero.debug(
      "[seerai] RAG: retrying search after dimension-mismatch re-index",
    );
    searchResult = await vectorStore.searchSimilar(
      baseEmbedding!,
      topK * 2,
      paperItemIds,
      minScore,
    );
  }

  return { searchResult, itemsReindexed };
}

// ─── Tiered context assembly ─────────────────────────────────────────────────

/**
 * Assemble final context using a 3-tier budget strategy:
 *   Tier 1: Passthrough ≤ 60% of budget → keep verbatim
 *   Tier 2: Passthrough ≤ 85% → trim passthrough, give RAG a minimum budget
 *   Tier 3: Passthrough > 85% → chunk passthrough, embed, merge with RAG results
 */
async function assembleTieredContext(
  rankedResults: RetrievedChunk[],
  rawResultsCount: number,
  passthroughContext: string,
  tokenBudget: TokenBudget | undefined,
  maxTokens: number,
  ragConfig: RAGConfig,
  itemTitles: Map<number, string>,
  baseEmbedding: number[] | null,
  embeddingService: EmbeddingServiceType,
  query: string,
  topK: number,
  useAdaptive: boolean,
  onProgress?: RAGProgressCallback,
): Promise<{
  finalContext: string;
  selectedChunks: RetrievedChunk[];
  totalTokensUsed: number;
}> {
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
      message:
        passthroughChunks.length > 50
          ? `Large context (${passthroughChunks.length} segments) — chunking for relevance search. This may take a moment...`
          : `Chunked passthrough into ${passthroughChunks.length} segments — embedding for relevance search...`,
      stats: { tier: 3, segmentCount: passthroughChunks.length },
    });

    if (passthroughChunks.length > 0 && baseEmbedding) {
      try {
        const ptTexts = passthroughChunks.map((c) => c.text);

        const ptEmbeddings = await embeddingService.getEmbeddings(ptTexts);

        const ptResults: RetrievedChunk[] = passthroughChunks.map(
          (chunk, i) => ({
            chunk: {
              ...chunk,
              embedding: ptEmbeddings[i],
              embeddingModel:
                embeddingService.getConfiguredModel() || "unknown",
            },
            score: cosineSimilarityDirect(baseEmbedding!, ptEmbeddings[i]),
            sourceItem: {
              title: chunk.metadata.title || "Context",
              id: chunk.itemId,
            },
          }),
        );

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
              itemId: r.sourceItem.id,
              chunkId: r.chunk.id,
            })),
            stats: {
              candidateCount: ptTexts.length,
              selectedCount: ptResults.length,
              tier: 3,
            },
          });
        }

        const allResults = [...rankedResults, ...ptResults];
        allResults.sort((a, b) => b.score - a.score);

        let rerankedAll = allResults;
        if (isRerankerConfigured() && allResults.length > 1) {
          onProgress?.({
            step: "reranking",
            message: `Applying cross-encoder reranker to ${allResults.length} merged results...`,
            stats: { candidateCount: allResults.length },
          });

          const crossEncoded = await crossEncodeRerank(query, allResults, topK);

          if (crossEncoded.length > 0) {
            rerankedAll = crossEncoded;
            Zotero.debug(
              `[seerai] RAG tier 3: cross-encoder reranked ${crossEncoded.length} merged results`,
            );
          }
        }

        if (onProgress) {
          onProgress({
            step: "reranking",
            message: `Merged ${rankedResults.length} paper + ${ptResults.length} passthrough → ${rerankedAll.length} candidates`,
            rankedResults: rerankedAll.map((r) => ({
              title: r.sourceItem.title,
              score: r.score,
              source: r.chunk.source,
              description:
                r.chunk.text.substring(0, 120).trim() +
                (r.chunk.text.length > 120 ? "..." : ""),
              itemId: r.sourceItem.id,
              chunkId: r.chunk.id,
            })),
            stats: {
              candidateCount: rerankedAll.length,
              selectedCount: rerankedAll.length,
            },
          });
        }

        const adaptiveAll = useAdaptive
          ? applyAdaptiveSelection(rerankedAll)
          : rerankedAll;

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

  return { finalContext, selectedChunks, totalTokensUsed };
}

// ─── Parent-document expansion ────────────────────────────────────────────────

/**
 * Expand results by boosting other chunks from the same parent papers.
 * After MMR diversity selection, some papers may have only one chunk selected
 * even though other sections of the same paper are also relevant. This function
 * finds sibling chunks from the top papers and boosts their scores.
 *
 * @param selected   MMR-selected diverse chunks
 * @param rawResults Full dense search results (all candidates before MMR)
 * @param topN       Max number of parent papers to expand (default: 3)
 * @param boost      Score multiplier for sibling chunks (default: 1.15)
 */
function expandParentDocuments(
  selected: RetrievedChunk[],
  rawResults: RetrievedChunk[],
  topN: number = 3,
  boost: number = 1.15,
): RetrievedChunk[] {
  if (selected.length === 0 || rawResults.length === 0) return selected;

  const selectedChunkIds = new Set(selected.map((c) => c.chunk.id));
  const selectedItemIds = new Set<number>();

  for (const c of selected) {
    selectedItemIds.add(c.sourceItem.id);
    if (selectedItemIds.size >= topN) break;
  }

  if (selectedItemIds.size === 0) return selected;

  const siblingChunks: RetrievedChunk[] = [];

  for (const r of rawResults) {
    if (
      selectedItemIds.has(r.sourceItem.id) &&
      !selectedChunkIds.has(r.chunk.id)
    ) {
      siblingChunks.push({
        ...r,
        score: r.score * boost,
      });
    }
  }

  if (siblingChunks.length === 0) return selected;

  Zotero.debug(
    `[seerai] RAG: parent expansion — ${siblingChunks.length} sibling chunks ` +
      `from ${selectedItemIds.size} papers boosted by ${boost}x`,
  );

  const merged = [...selected, ...siblingChunks];
  merged.sort((a, b) => b.score - a.score);
  return merged;
}

async function expandToSentenceWindows(
  selectedChunks: RetrievedChunk[],
  vectorStore: ReturnType<typeof getVectorStore>,
): Promise<RetrievedChunk[]> {
  const expanded: RetrievedChunk[] = [];
  const seenParentIds = new Set<string>();

  for (const rc of selectedChunks) {
    const parentChunkId = rc.chunk.metadata.parentChunkId;
    if (!parentChunkId) {
      expanded.push(rc);
      continue;
    }
    if (seenParentIds.has(parentChunkId)) continue;
    seenParentIds.add(parentChunkId);

    const parentText = await vectorStore.getParentWindow(
      rc.sourceItem.id,
      parentChunkId,
    );
    if (parentText) {
      expanded.push({
        chunk: { ...rc.chunk, text: parentText },
        score: rc.score,
        sourceItem: rc.sourceItem,
      });
    } else {
      expanded.push(rc);
    }
  }

  return expanded;
}

const DECOMPOSITION_PROMPT = `You are helping decompose complex research queries for better retrieval.

Given a user query, break it into 2-3 simpler, self-contained sub-queries that together cover all aspects of the original. Each sub-query should be answerable independently.

Guidelines:
- For comparison queries (e.g., "compare X in paper A and paper B"), split into focused queries about each subject
- For multi-aspect queries (e.g., "methods and limitations of..."), split by aspect
- For simple factual queries, do not split
- Each sub-query must be self-contained (include necessary context)

Return a JSON object: {"sub_queries": ["query 1", "query 2", ...]}

Query: {query}
`;

async function decomposeQuery(query: string): Promise<string[]> {
  if (query.length < 40) return [query];

  const comparisonKeywords = [
    "compare",
    "versus",
    "vs.",
    "difference between",
    "similarities",
    "contrast",
    "better",
    "worse",
    "alternative",
  ];
  const hasComparison = comparisonKeywords.some((k) =>
    query.toLowerCase().includes(k),
  );
  const hasConjunction = /\band\b.*\band\b/i.test(query);

  if (!hasComparison && !hasConjunction) return [query];

  try {
    const { OpenAIService } = await import("../../openai");
    const service = new OpenAIService();
    const response = await service.chatCompletion([
      {
        role: "system",
        content:
          "You are a research assistant. Always respond with valid JSON only.",
      },
      {
        role: "user",
        content: DECOMPOSITION_PROMPT.replace("{query}", query),
      },
    ]);
    const parsed = JSON.parse(response);
    if (parsed.sub_queries?.length > 1 && parsed.sub_queries.length <= 3) {
      Zotero.debug(
        `[seerai] RAG: decomposed into ${parsed.sub_queries.length} sub-queries`,
      );
      return parsed.sub_queries;
    }
  } catch (e) {
    Zotero.debug(`[seerai] RAG: query decomposition failed: ${e}`);
  }
  return [query];
}

// ─── HyDE (Hypothetical Document Embeddings) ──────────────────────────────────

const HYDE_SYSTEM_PROMPT =
  "You are a research assistant. Write a short, factual answer to the user's query. " +
  "Include key findings, methods, or concepts relevant to the question. " +
  "Keep your response under 300 words. Do not use markdown formatting.";

/**
 * Generate a HyDE hypothetical document for query-guided semantic search.
 * Uses the configured chat model to produce a short answer that is then embedded
 * as a search query instead of the raw user query.
 */
async function generateHyDE(query: string): Promise<string | null> {
  try {
    const { OpenAIService } = await import("../../openai");
    const service = new OpenAIService();
    const response = await service.chatCompletion([
      { role: "system", content: HYDE_SYSTEM_PROMPT },
      { role: "user", content: query },
    ]);

    if (response && response.trim().length > 20) {
      Zotero.debug(
        `[seerai] RAG: HyDE generated ${response.length} chars — ` +
          `"${response.substring(0, 120)}..."`,
      );
      return response;
    }

    Zotero.debug("[seerai] RAG: HyDE response too short, using raw query");
    return null;
  } catch (e) {
    Zotero.debug(`[seerai] RAG: HyDE generation failed: ${e}`);
    return null;
  }
}

// ─── Contextual Retrieval ───────────────────────────────────────────────────

const CONTEXTUAL_RETRIEVAL_PROMPT = `You are helping prepare a document for semantic search. 
Below is the full text of an academic paper, split into chunks. 

For each chunk, write a concise context (1-2 sentences, under 100 words) that situates it 
within the overall document. The context should explain:
1. What section this chunk belongs to (e.g., Introduction, Methods, Results, Discussion)
2. What topic/concept the chunk discusses
3. How it relates to the paper's overall contribution

Return a JSON object of the form: {"contexts": ["context for chunk 1", "context for chunk 2", ...]}
The number of contexts must match the number of chunks exactly.

Document title: {title}
Authors: {authors}

Full document text:
{fullDocumentText}

Chunks (with indices):
{chunkTexts}
`;

async function generateChunkContexts(
  chunks: DocumentChunk[],
  fullText: string,
  title: string,
  authors: string[],
): Promise<string[]> {
  try {
    const { OpenAIService } = await import("../../openai");
    const service = new OpenAIService();

    const chunkDescriptions = chunks
      .map((c, i) => `[Chunk ${i}] ${c.text}`)
      .join("\n\n");

    const prompt = CONTEXTUAL_RETRIEVAL_PROMPT.replace("{title}", title)
      .replace("{authors}", authors.join(", "))
      .replace("{fullDocumentText}", fullText)
      .replace("{chunkTexts}", chunkDescriptions);

    const response = await service.chatCompletion([
      {
        role: "system",
        content:
          "You are a research assistant. Always respond with valid JSON only.",
      },
      { role: "user", content: prompt },
    ]);

    const parsed = JSON.parse(response);
    if (
      !parsed ||
      !Array.isArray(parsed.contexts) ||
      parsed.contexts.length !== chunks.length
    ) {
      Zotero.debug(
        `[seerai] RAG: contextual retrieval failed — expected ${chunks.length} contexts, got ${parsed?.contexts?.length ?? "invalid"}`,
      );
      return [];
    }

    return parsed.contexts as string[];
  } catch (e) {
    Zotero.debug(`[seerai] RAG: contextual retrieval generation failed: ${e}`);
    return [];
  }
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
 *   5. Re-rank results by relevance + source priority + position bonus
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
  contentExtractor: ContentExtractorFn,
  options?: RetrievalOptions,
): Promise<RetrievalResult> {
  const startTime = Date.now();
  const timings: Record<string, number> = {};
  let phaseStart = startTime;
  const markPhase = (name: string) => {
    timings[name] = Date.now() - phaseStart;
    phaseStart = Date.now();
  };

  const ragConfig = getRAGConfig();
  const embeddingService = getEmbeddingService();
  const vectorStore = getVectorStore();

  const topK = options?.topK ?? ragConfig.topK;
  const maxTokens = options?.maxTokens ?? ragConfig.tokenThreshold;
  const minScore = options?.minScore ?? ragConfig.minScore;
  const rerank = options?.rerank ?? true;
  const passthroughContext = options?.passthroughContext ?? "";
  const rrfAlpha = options?.rrfAlpha ?? ragConfig.rrfAlpha ?? 0.55;
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
  }

  if (ragConfig.citationGraphHops && ragConfig.citationGraphHops > 0) {
    const existingCount = paperItemIds.length;
    const citedIds = traverseCitationGraph(
      paperItemIds,
      ragConfig.citationGraphHops,
    );
    for (const citedId of citedIds) {
      if (!paperItemIds.includes(citedId)) {
        paperItemIds.push(citedId);
        if (!itemTitles.has(citedId)) {
          const zItem = Zotero.Items.get(citedId);
          itemTitles.set(
            citedId,
            zItem?.getField("title") || `Item ${citedId}`,
          );
        }
      }
    }
    if (citedIds.length > 0) {
      onProgress?.({
        step: "graph-traversal",
        message: `Citation graph: ${existingCount} → ${paperItemIds.length} papers (${ragConfig.citationGraphHops} hop${ragConfig.citationGraphHops > 1 ? "s" : ""})`,
      });
    }
  }

  if (paperItemIds.length === 0) {
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

  // ── Step 2: On-demand indexing ────────────────────────────────────────────
  const itemsToIndex = await collectItemsToIndex(
    paperItemIds,
    vectorStore,
    contentExtractor,
  );

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

    itemsIndexedOnDemand += await indexItemsInWaves(
      itemsToIndex,
      contentExtractor,
      embeddingService,
      vectorStore,
      ragConfig,
    );

    onProgress?.({
      step: "indexing",
      message: `Indexed ${itemsIndexedOnDemand}/${itemsToIndex.length} papers...`,
      stats: {
        itemsToIndex: itemsToIndex.length,
        itemsIndexed: itemsIndexedOnDemand,
      },
    });
  }

  markPhase("indexing");

  // ── Step 3: Query expansion ────────────────────────────────────────────────
  const useExpansion =
    options?.queryExpansion !== false && ragConfig.queryExpansion !== false;
  const baseQuery = useExpansion
    ? expandQueryFromContext(query, contextItems)
    : query;

  if (baseQuery !== query) {
    Zotero.debug(
      `[seerai] RAG: expanded query "${query.substring(0, 60)}" → ` +
        `"${baseQuery.substring(0, 120)}"`,
    );
  }

  // ── Step 3b: HyDE query rewriting (optional) ──────────────────────────────
  const useHyde =
    options?.hydeEnabled !== false && ragConfig.hydeEnabled !== false;
  let hydeDoc: string | null = null;
  if (useHyde) {
    onProgress?.({
      step: "embedding-query",
      message: "Generating hypothetical answer for better retrieval...",
    });
    hydeDoc = await generateHyDE(query);
    if (hydeDoc) {
      onProgress?.({
        step: "embedding-query",
        message: "Embedding HyDE-augmented query...",
      });
    }
  }

  const useMultiQuery =
    options?.multiQueryExpansion !== false &&
    ragConfig.multiQueryExpansion !== false;
  const rawVariants = useMultiQuery
    ? generateQueryVariants(query, contextItems, 3)
    : [baseQuery];

  // Append HyDE document as an additional recall variant.
  // baseEmbedding stays as the raw query embedding for MMR/tier-3.
  const queryVariants = hydeDoc ? [...rawVariants, hydeDoc] : rawVariants;

  Zotero.debug(
    `[seerai] RAG: ${useMultiQuery ? `multi-query: ${queryVariants.length} variants` : "single query"}${hydeDoc ? " (HyDE-augmented)" : ""}`,
  );

  // ── Step 4: Dense semantic search ──────────────────────────────────────────
  let allDenseChunks: RetrievedChunk[];
  let baseEmbedding: number[] | null;

  if (options?.queryDecomposition ?? ragConfig.queryDecomposition) {
    const subQueries = await decomposeQuery(baseQuery);
    const allResults: RetrievedChunk[] = [];
    let firstEmbedding: number[] | null = null;

    for (const subQuery of subQueries) {
      const result = await performDenseSearch(
        [subQuery],
        subQuery,
        paperItemIds,
        embeddingService,
        vectorStore,
        Math.ceil(topK / subQueries.length),
        minScore,
        onProgress,
      ).catch((e) => {
        Zotero.debug(`[seerai] RAG: sub-query search failed: ${e}`);
        return { allDenseChunks: [] as RetrievedChunk[], baseEmbedding: null };
      });
      allResults.push(...result.allDenseChunks);
      if (!firstEmbedding && result.baseEmbedding) {
        firstEmbedding = result.baseEmbedding;
      }
    }

    const seen = new Set<string>();
    allDenseChunks = allResults.filter((rc) => {
      const key = rc.chunk.id;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    baseEmbedding = firstEmbedding;
  } else {
    const result = await performDenseSearch(
      queryVariants,
      baseQuery,
      paperItemIds,
      embeddingService,
      vectorStore,
      topK,
      minScore,
      onProgress,
    ).catch((e) => {
      Zotero.debug(`[seerai] RAG: failed to embed query: ${e}`);
      return { allDenseChunks: [] as RetrievedChunk[], baseEmbedding: null };
    });
    allDenseChunks = result.allDenseChunks;
    baseEmbedding = result.baseEmbedding;
  }

  if (allDenseChunks.length === 0 && baseEmbedding === null) {
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

  markPhase("embedSearch");

  // ── Step 5: Dimension mismatch handling ────────────────────────────────────
  onProgress?.({
    step: "searching",
    message: `Searching ${paperItemIds.length} paper${paperItemIds.length > 1 ? "s" : ""} for relevant passages...`,
  });

  const { searchResult, itemsReindexed: dimReindexed } =
    await handleDimensionMismatch(
      allDenseChunks,
      baseEmbedding,
      paperItemIds,
      contentExtractor,
      embeddingService,
      vectorStore,
      ragConfig,
      topK,
      minScore,
    );
  itemsIndexedOnDemand += dimReindexed;

  if (searchResult.dimensionMismatch) {
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

  const rawResults = searchResult.chunks;

  Zotero.debug(
    `[seerai] RAG: vector search returned ${rawResults.length} candidates`,
  );

  markPhase("denseSearch");

  // ── Step 6: BM25 hybrid fusion ─────────────────────────────────────────────
  let hybridResults: RetrievedChunk[] = rawResults;

  const useHybrid = options?.hybridSearch !== false;
  if (useHybrid && rawResults.length > 0) {
    try {
      const bm25Start = Date.now();
      hybridResults = await mergeHybridResults(
        rawResults,
        baseQuery,
        paperItemIds,
        topK * 2,
        rrfAlpha,
      );

      Zotero.debug(
        `[seerai] RAG: hybrid merged: ${hybridResults.length} unique ` +
          `in ${Date.now() - bm25Start}ms`,
      );
    } catch (e) {
      Zotero.debug(`[seerai] RAG: BM25 search failed, using dense only: ${e}`);
    }
  }

  markPhase("hybridMerge");

  // ── Step 7: MMR diversity selection ────────────────────────────────────────
  const useMmr =
    options?.mmrEnabled !== false && ragConfig.mmrEnabled !== false;
  if (useMmr && hybridResults.length > 1) {
    const chunksWithEmb = hybridResults.filter(
      (c) => c.chunk.embedding && c.chunk.embedding.length > 0,
    );
    const chunksWithoutEmb = hybridResults.filter(
      (c) => !c.chunk.embedding || c.chunk.embedding.length === 0,
    );

    if (chunksWithEmb.length > 1) {
      const mmrLambda = options?.mmrLambda ?? ragConfig.mmrLambda ?? 0.7;
      const k = Math.min(topK * 2, chunksWithEmb.length);

      onProgress?.({
        step: "reranking",
        message: `Selecting ${k} diverse results (MMR λ=${mmrLambda.toFixed(2)})...`,
        stats: { candidateCount: chunksWithEmb.length },
      });

      const diverse = selectMMR(chunksWithEmb, baseEmbedding!, mmrLambda, k);

      Zotero.debug(
        `[seerai] RAG: MMR selected ${diverse.length} diverse chunks from ` +
          `${chunksWithEmb.length} (λ=${mmrLambda.toFixed(2)})`,
      );

      hybridResults = [...diverse, ...chunksWithoutEmb];
    }
  }

  markPhase("mmr");

  // ── Step 7b: Parent-document expansion (optional) ─────────────────────────
  const useParentExpansion = options?.parentExpansion === true;
  if (useParentExpansion && hybridResults.length > 1) {
    hybridResults = expandParentDocuments(hybridResults, rawResults);
  }

  // ── Step 8: Re-ranking ─────────────────────────────────────────────────────
  onProgress?.({
    step: "reranking",
    message: `Ranking ${hybridResults.length} candidates by relevance...`,
    stats: { candidateCount: hybridResults.length },
  });

  let rankedResults: RetrievedChunk[];

  if (rerank && hybridResults.length > 0) {
    if (isRerankerConfigured()) {
      onProgress?.({
        step: "reranking",
        message: "Applying cross-encoder reranker...",
        stats: { candidateCount: hybridResults.length },
      });

      const crossEncoded = await crossEncodeRerank(query, hybridResults, topK);

      if (crossEncoded.length > 0) {
        rankedResults = crossEncoded;
      } else {
        rankedResults = rerankResults(hybridResults);
      }
    } else {
      rankedResults = rerankResults(hybridResults);
    }
  } else {
    rankedResults = rawResults;
  }

  markPhase("rerank");

  // ── Step 9: Adaptive retrieval + topK cap ─────────────────────────────────
  const useAdaptive = options?.adaptiveRetrieval ?? true;
  if (useAdaptive && rankedResults.length > 1) {
    rankedResults = applyAdaptiveSelection(rankedResults);
  }

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
      itemId: number;
      chunkId: string;
    }> = rankedResults.map((r) => ({
      title: r.sourceItem.title,
      score: r.score,
      source: r.chunk.source,
      description:
        r.chunk.text.substring(0, 300).trim() +
        (r.chunk.text.length > 300 ? "..." : ""),
      itemId: r.sourceItem.id,
      chunkId: r.chunk.id,
    }));

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

  markPhase("adaptive");

  // ── Step 9b: Corrective RAG (evaluate → rewrite → re-retrieve) ─────────────
  let correctiveApplied = false;
  if (
    (options?.correctiveEnabled ?? ragConfig.correctiveEnabled) &&
    rankedResults.length > 0 &&
    isEvalEnabled()
  ) {
    const evalResult = await evaluateRetrievalSufficiency(rankedResults, query);
    if (evalResult && !evalResult.sufficient) {
      const rewrittenQuery = await rewriteQueryForRetrieval(
        query,
        evalResult.missing,
      );
      if (rewrittenQuery) {
        onProgress?.({
          step: "searching",
          message: `Corrective re-retrieval with rewritten query...`,
        });

        const reResult = await performDenseSearch(
          [rewrittenQuery],
          rewrittenQuery,
          paperItemIds,
          embeddingService,
          vectorStore,
          topK,
          minScore,
          onProgress,
        ).catch((e) => {
          Zotero.debug(`[seerai] RAG: corrective re-search failed: ${e}`);
          return {
            allDenseChunks: [] as RetrievedChunk[],
            baseEmbedding: null,
          };
        });

        if (reResult.allDenseChunks.length > 0) {
          const existingIds = new Set(rankedResults.map((r) => r.chunk.id));
          const newChunks = reResult.allDenseChunks.filter(
            (rc) => !existingIds.has(rc.chunk.id),
          );
          if (newChunks.length > 0) {
            rankedResults = [...rankedResults, ...newChunks];
            correctiveApplied = true;
            Zotero.debug(
              `[seerai] RAG corrective: added ${newChunks.length} chunks from rewritten query`,
            );
          }
        }
      }
    }
  }

  if (ragConfig.sentenceWindow) {
    rankedResults = await expandToSentenceWindows(rankedResults, vectorStore);
  }

  // ── Step 10: Budget-aware context assembly ─────────────────────────────────
  onProgress?.({
    step: "assembling",
    message: "Assembling context within token budget...",
  });

  const { finalContext, selectedChunks, totalTokensUsed } =
    await assembleTieredContext(
      rankedResults,
      rawResults.length,
      passthroughContext,
      options?.tokenBudget,
      maxTokens,
      ragConfig,
      itemTitles,
      baseEmbedding,
      embeddingService,
      query,
      topK,
      useAdaptive,
      onProgress,
    );

  markPhase("assemble");

  const passthroughTokens = passthroughContext
    ? ChatStateManager.countTokens(passthroughContext)
    : 0;

  const stats: RetrievalStats = {
    totalChunksSearched: rawResults.length,
    chunksRetrieved: selectedChunks.length,
    tokensUsed: totalTokensUsed,
    itemsIndexedOnDemand,
    queryTimeMs: Date.now() - startTime,
  };

  if (isEvalEnabled()) {
    const groundTruth = loadGroundTruth();
    const match = findGroundTruth(query, groundTruth);
    if (match) {
      const evalMetrics = evaluateRetrieval(
        selectedChunks,
        match.relevant_item_ids,
      );
      stats.evaluation = evalMetrics;
      Zotero.debug(
        `[seerai] Eval: recall@5=${evalMetrics.recall_at_k[5]?.toFixed(3)}, ` +
          `MRR=${evalMetrics.mrr.toFixed(3)}, hit_rate=${evalMetrics.hit_rate}`,
      );
    }
  }

  Zotero.debug(
    `[seerai] RAG retrieval complete: ${selectedChunks.length} chunks, ` +
      `${totalTokensUsed} tokens (${passthroughTokens} passthrough original), ${stats.queryTimeMs}ms`,
  );

  Zotero.debug(
    `[seerai] RAG timing: ${Object.entries(timings)
      .map(([k, v]) => `${k}=${v}ms`)
      .join(", ")}`,
  );

  if (onProgress) {
    const rankedEntries: Array<{
      title: string;
      score: number;
      source: string;
      description: string;
      itemId: number;
      chunkId: string;
    }> = selectedChunks.map((r) => ({
      title: r.sourceItem.title,
      score: r.score,
      source: r.chunk.source,
      description:
        r.chunk.text.substring(0, 300).trim() +
        (r.chunk.text.length > 300 ? "..." : ""),
      itemId: r.sourceItem.id,
      chunkId: r.chunk.id,
    }));

    if (passthroughContext && passthroughTokens > 0) {
      const ptEntries = parsePassthroughSections(passthroughContext);
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

  logRetrievalMetrics(
    selectedChunks,
    rawResults.length,
    stats.queryTimeMs,
    totalTokensUsed,
  );

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
    date?: string;
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
  const { chunks, parentWindows } = chunkPaperContent(itemId, content, {
    chunkSize: ragConfig.chunkSize,
    chunkOverlap: ragConfig.chunkOverlap,
    sentenceWindow: ragConfig.sentenceWindow,
    windowSize: ragConfig.sentenceWindowSize,
  });

  if (chunks.length === 0) {
    Zotero.debug(`[seerai] RAG: no chunks produced for item ${itemId}`);
    return;
  }

  if (ragConfig.contextualRetrieval) {
    const fullText =
      (content.abstract || "") +
      "\n\n" +
      (content.notes?.join("\n\n") || "") +
      "\n\n" +
      (content.pdfText || "");
    const contexts = await generateChunkContexts(
      chunks,
      fullText,
      content.title || `Item ${itemId}`,
      content.authors || [],
    );
    if (contexts.length === chunks.length) {
      for (let i = 0; i < chunks.length; i++) {
        chunks[i].metadata.contextText = contexts[i];
        chunks[i].text = `<context>${contexts[i]}</context>\n${chunks[i].text}`;
      }
      Zotero.debug(
        `[seerai] RAG: contextual retrieval enriched ${chunks.length} chunks for item ${itemId}`,
      );
    } else {
      Zotero.debug(
        `[seerai] RAG: contextual retrieval failed for item ${itemId}, embedding raw chunks`,
      );
    }
  }

  // Embed all chunks in batch
  const texts = chunks.map((c) => c.text);
  const embeddings = await embeddingService.getEmbeddings(texts);

  // Store in vector store
  const model = embeddingService.getConfiguredModel() || "unknown";
  const pubYearMatch = (content.date || "").match(/\b(1[89]\d{2}|20\d{2})\b/);
  const publicationYear = pubYearMatch
    ? parseInt(pubYearMatch[1], 10)
    : undefined;
  const firstCreator = content.authors?.[0]?.split(/\s/).pop() || undefined;
  await vectorStore.indexItem(
    itemId,
    chunks,
    embeddings,
    model,
    contentHash,
    parentWindows,
    publicationYear,
    content.title,
    firstCreator,
  );

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
 *   - Cosine similarity (weight: 0.65)
 *   - Source priority (weight: 0.2)
 *   - Position bonus — earlier chunks get a small boost (weight: 0.1)
 *   - Recency — recent papers get a small boost (weight: 0.05)
 */
function rerankResults(results: RetrievedChunk[]): RetrievedChunk[] {
  const maxScore = Math.max(...results.map((r) => r.score), 0.001);
  const currentYear = new Date().getFullYear();

  const reranked = results.map((result) => {
    const normalizedSimilarity = result.score / maxScore;
    const sourcePriority = SOURCE_PRIORITY[result.chunk.source] ?? 0.5;
    // Earlier chunks (lower index) get a slight boost
    const positionBonus = Math.max(0, 1 - result.chunk.chunkIndex * 0.02);

    // Recency boost: linear from 1990→currentYear, clamped 0-1
    const year = result.sourceItem.publicationYear;
    const recencyBoost =
      typeof year === "number" && year >= 1900 && year <= currentYear
        ? Math.max(0, Math.min(1, (year - 1990) / (currentYear - 1990)))
        : 0.5;

    const combinedScore =
      normalizedSimilarity * 0.65 +
      sourcePriority * 0.2 +
      positionBonus * 0.1 +
      recencyBoost * 0.05;

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
  const safetyMargin = isTokenizerAvailable()
    ? Math.ceil(contextLength * 0.03)
    : Math.ceil(contextLength * 0.12);
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
  itemId: number;
  chunkId: string;
}> {
  const entries: Array<{
    title: string;
    score: number;
    source: string;
    description: string;
    itemId: number;
    chunkId: string;
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
        source: type.toLowerCase(),
        description: `Included verbatim (${type.toLowerCase()})`,
        itemId: -1,
        chunkId: "",
      });
    } else if (match[3]) {
      entries.push({
        title: `Focus: "${match[3]}"`,
        score: -1,
        source: "metadata",
        description: "Focus topic included verbatim",
        itemId: -1,
        chunkId: "",
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
      itemId: -1,
      chunkId: "",
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

/**
 * Maximal Marginal Relevance (MMR) diversity selection.
 *
 * Greedily selects k documents from a candidate pool, balancing relevance
 * to the query against redundancy with already-selected documents.
 *
 * MMR(D_i) = λ * sim(D_i, Q) - (1-λ) * max_{D_j ∈ S} sim(D_i, D_j)
 *
 * - First document: highest relevance to query
 * - Each subsequent document: highest MMR score
 *
 * @param results       Candidates with embeddings (must have chunk.embedding)
 * @param queryEmbedding  Embedded query vector
 * @param lambda        Relevance-diversity trade-off (0-1, default 0.7)
 * @param k             Number of documents to select
 * @returns Diverse subset, ordered by MMR selection sequence
 */
function selectMMR(
  results: RetrievedChunk[],
  queryEmbedding: number[],
  lambda: number,
  k: number,
): RetrievedChunk[] {
  if (results.length <= 1) return results;
  if (k >= results.length) k = results.length;

  const n = results.length;

  const relevance = results.map((r) => {
    const emb = r.chunk.embedding;
    if (!emb || emb.length === 0) return 0;
    return cosineSimilarityDirect(queryEmbedding, emb);
  });

  const sim: number[][] = new Array(n);
  for (let i = 0; i < n; i++) {
    sim[i] = new Array(n).fill(0);
  }
  for (let i = 0; i < n; i++) {
    const eI = results[i].chunk.embedding;
    if (!eI || eI.length === 0) continue;
    for (let j = i + 1; j < n; j++) {
      const eJ = results[j].chunk.embedding;
      if (!eJ || eJ.length === 0) continue;
      const s = cosineSimilarityDirect(eI, eJ);
      sim[i][j] = s;
      sim[j][i] = s;
    }
  }

  const selected = new Set<number>();
  const order: number[] = [];

  let bestIdx = 0;
  let bestRel = relevance[0];
  for (let i = 1; i < n; i++) {
    if (relevance[i] > bestRel) {
      bestRel = relevance[i];
      bestIdx = i;
    }
  }
  selected.add(bestIdx);
  order.push(bestIdx);

  while (selected.size < k) {
    let candidateIdx = -1;
    let bestMmr = -Infinity;

    for (let i = 0; i < n; i++) {
      if (selected.has(i)) continue;

      let maxSim = 0;
      for (const j of selected) {
        maxSim = Math.max(maxSim, sim[i][j]);
      }

      const mmrScore = lambda * relevance[i] - (1 - lambda) * maxSim;

      if (mmrScore > bestMmr) {
        bestMmr = mmrScore;
        candidateIdx = i;
      }
    }

    if (candidateIdx === -1) break;

    selected.add(candidateIdx);
    order.push(candidateIdx);
  }

  return order.map((idx) => results[idx]);
}

const EXPANSION_STOP_WORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "that",
  "this",
  "from",
  "have",
  "been",
  "were",
  "their",
  "which",
  "each",
  "also",
  "into",
  "more",
  "some",
  "such",
  "than",
  "about",
  "other",
  "these",
  "those",
  "using",
  "based",
  "study",
  "paper",
  "research",
  "analysis",
  "approach",
  "method",
  "results",
  "data",
  "model",
  "effect",
  "role",
  "impact",
  "review",
  "overview",
  "introduction",
  "conclusion",
  "discussion",
  "related",
  "towards",
  "toward",
  "novel",
  "efficient",
  "effective",
  "improved",
  "proposed",
  "existing",
  "different",
  "between",
  "through",
]);

function expandQueryFromContext(
  query: string,
  contextItems: Array<{ displayName: string }>,
): string {
  const queryTerms = new Set(tokenizeForExpansion(query));
  const added = new Set<string>();
  const newTerms: string[] = [];

  for (const item of contextItems) {
    const tokens = tokenizeForExpansion(item.displayName);
    for (const token of tokens) {
      if (
        token.length < 3 ||
        EXPANSION_STOP_WORDS.has(token) ||
        queryTerms.has(token) ||
        added.has(token)
      ) {
        continue;
      }
      added.add(token);
      newTerms.push(token);
      if (newTerms.length >= 12) break;
    }
    if (newTerms.length >= 12) break;
  }

  if (newTerms.length === 0) return query;
  return query + " " + newTerms.join(" ");
}

function tokenizeForExpansion(text: string): string[] {
  const lower = text.toLowerCase();
  if (typeof Intl !== "undefined" && typeof Intl.Segmenter === "function") {
    try {
      const segmenter = new Intl.Segmenter([], { granularity: "word" });
      const tokens: string[] = [];
      for (const { segment, isWordLike } of segmenter.segment(lower)) {
        if (isWordLike && segment.length > 1 && segment.length < 40) {
          tokens.push(segment);
        }
      }
      if (tokens.length > 0) return tokens;
    } catch {
      // fall through to regex
    }
  }
  return lower
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1 && t.length < 40);
}

function generateQueryVariants(
  query: string,
  contextItems: Array<{ displayName: string }>,
  maxVariants: number = 3,
): string[] {
  const variants: string[] = [query];

  const queryLower = query.toLowerCase();
  for (const item of contextItems) {
    if (variants.length >= maxVariants) break;
    const tokens = tokenizeForExpansion(item.displayName);
    if (tokens.length === 0) continue;
    const keyTerm = tokens.find(
      (t) =>
        t.length > 3 && !EXPANSION_STOP_WORDS.has(t) && !queryLower.includes(t),
    );
    if (keyTerm) {
      variants.push(`${query} ${keyTerm}`);
    }
  }

  if (variants.length === 1) return variants;

  Zotero.debug(
    `[seerai] RAG query variants: ${variants.map((v) => `"${v}"`).join(", ")}`,
  );
  return variants;
}

function logRetrievalMetrics(
  chunks: RetrievedChunk[],
  candidatesSearched: number,
  queryTimeMs: number,
  tokensUsed: number,
): void {
  if (chunks.length === 0) {
    Zotero.debug(
      `[seerai] RAG metrics: 0 results from ${candidatesSearched} candidates in ${queryTimeMs}ms`,
    );
    return;
  }

  const scores = chunks.map((c) => c.score);
  const topScore = scores[0] ?? 0;
  const bottomScore = scores[scores.length - 1] ?? 0;
  const avgScore = scores.reduce((sum, s) => sum + s, 0) / (scores.length || 1);

  const uniqueItems = new Set(chunks.map((c) => c.sourceItem.id)).size;

  Zotero.debug(
    `[seerai] RAG metrics: ${chunks.length} results / ${candidatesSearched} candidates, ` +
      `${uniqueItems} unique items, ${tokensUsed} tokens, ${queryTimeMs}ms. ` +
      `Scores: top=${topScore.toFixed(3)} avg=${avgScore.toFixed(3)} bottom=${bottomScore.toFixed(3)}`,
  );

  const buckets = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0];
  const dist: number[] = new Array(buckets.length - 1).fill(0);
  for (const c of chunks) {
    for (let i = 0; i < buckets.length - 1; i++) {
      if (c.score >= buckets[i] && c.score < buckets[i + 1]) {
        dist[i]++;
        break;
      }
    }
  }
  Zotero.debug(
    `[seerai] RAG score dist: ${buckets
      .slice(0, -1)
      .map(
        (b, i) => `[${b.toFixed(1)}-${buckets[i + 1].toFixed(1)})=${dist[i]}`,
      )
      .join(", ")}`,
  );
}
