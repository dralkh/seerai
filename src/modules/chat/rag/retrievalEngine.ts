/**
 * Retrieval engine for the RAG system.
 * Orchestrates the full pipeline: indexing → embedding → search → ranking → context assembly.
 *
 * Integration point: called from assistant.ts when RAG is activated.
 */

import { config } from "../../../../package.json";
import { ChatStateManager } from "../stateManager";
import { getEmbeddingService } from "./embeddingService";
import { chunkPaperContent } from "./chunker";
import { getVectorStore, VectorStore } from "./vectorStore";
import type {
  RetrievalOptions,
  RetrievalResult,
  RetrievedChunk,
  RAGConfig,
  VectorSearchResult,
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
    }
  }

  // ── Step 3: Embed the user query ──────────────────────────────────────────
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
  let rankedResults: RetrievedChunk[];

  if (rerank && rawResults.length > 0) {
    rankedResults = rerankResults(rawResults);
  } else {
    rankedResults = rawResults;
  }

  // ── Step 6: Assemble context within token budget ──────────────────────────
  // Reserve token budget for passthrough content (tables, files, topics)
  const passthroughTokens = passthroughContext
    ? ChatStateManager.countTokens(passthroughContext)
    : 0;
  const ragTokenBudget = Math.max(
    maxTokens - passthroughTokens,
    maxTokens * 0.5,
  );

  const {
    context: ragContext,
    selectedChunks,
    tokensUsed: ragTokensUsed,
  } = assembleContext(rankedResults, ragTokenBudget, itemTitles);

  // Append passthrough content (tables, files, topics) after RAG passages
  let finalContext = ragContext;
  let totalTokensUsed = ragTokensUsed;
  if (passthroughContext) {
    finalContext += "\n\n" + passthroughContext;
    totalTokensUsed += passthroughTokens;
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
      `${totalTokensUsed} tokens (${passthroughTokens} passthrough), ${stats.queryTimeMs}ms`,
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
    `[seerai] RAG: indexed item ${itemId} — ${chunks.length} chunks embedded`,
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
          remainingTokens * 4,
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
