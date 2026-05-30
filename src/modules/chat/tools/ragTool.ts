/**
 * Semantic Search Tool for Agentic RAG.
 * Allows the AI agent to semantically search the Zotero library
 * for relevant passages using the full RAG pipeline.
 */

import {
  SemanticSearchParams,
  SemanticSearchResultData,
  KeywordSearchParams,
  KeywordSearchResultData,
  ReadChunksParams,
  ReadChunksResultData,
  SearchSimilarParams,
  SearchSimilarResultData,
  ToolResult,
  AgentConfig,
} from "./toolTypes";
import { getEmbeddingService } from "../rag/embeddingService";
import { getVectorStore, VectorStore } from "../rag/vectorStore";
import { bm25Search, mergeHybridResults } from "../rag/bm25";
import { crossEncodeRerank, isRerankerConfigured } from "../rag/reranker";
import { getRAGConfig } from "../rag/retrievalEngine";
import { chunkPaperContent } from "../rag/chunker";
import { Assistant } from "../../assistant";

const CONTEXT_TAG_RE = /<context>.*?<\/context>\n?/g;

function stripContextTags(text: string): string {
  return text.replace(CONTEXT_TAG_RE, "").trim();
}

async function deriveScopeLibraryId(
  scope: string,
  libraryId: number | undefined,
  configLibraryScope: AgentConfig["libraryScope"] | undefined,
): Promise<number | undefined> {
  if (libraryId !== undefined) return libraryId;
  if (!configLibraryScope) return undefined;
  if (configLibraryScope.type === "user") return Zotero.Libraries.userLibraryID;
  if (configLibraryScope.type === "group") {
    return Zotero.Groups.getLibraryIDFromGroupID(
      configLibraryScope.groupId,
    ) as number;
  }
  return undefined;
}

function deriveScopeCollectionId(
  scope: string,
  collectionId: number | undefined,
  configLibraryScope: AgentConfig["libraryScope"] | undefined,
): number | undefined {
  if (collectionId !== undefined) return collectionId;
  if (scope === "collection" && configLibraryScope?.type === "collection") {
    return (configLibraryScope as any).collectionId as number | undefined;
  }
  return undefined;
}

async function resolveSearchScope(
  scope: string,
  collectionId: number | undefined,
  libraryId: number | undefined,
  config: AgentConfig,
): Promise<{ itemIds: number[]; titles: Map<number, string> } | null> {
  const itemIds: number[] = [];
  const titles = new Map<number, string>();
  const store = getVectorStore();

  if (scope === "context") {
    const contextMgr = await import("../context/contextManager").then((m) =>
      m.ChatContextManager.getInstance(),
    );
    const items = contextMgr.getItems();
    for (const item of items) {
      if (item.type === "paper" && typeof item.id === "number") {
        if (
          libraryId === undefined ||
          item.id === 0 ||
          (await itemBelongsToLibrary(item.id, libraryId))
        ) {
          itemIds.push(item.id);
          titles.set(item.id, item.displayName);
        }
      }
    }
  } else if (scope === "collection" && collectionId) {
    const collection = Zotero.Collections.get(collectionId);
    if (!collection) return null;
    const childIds = collection.getChildItems(true);
    for (const childId of childIds) {
      const entry = await store.getIndexEntry(childId);
      if (!entry) continue;
      if (
        libraryId !== undefined &&
        !(await itemBelongsToLibrary(childId, libraryId))
      )
        continue;
      itemIds.push(childId);
      titles.set(childId, entry.title || `Item ${childId}`);
    }
  } else {
    const allIds = await store.getIndexedItemIds();
    for (const id of allIds) {
      if (
        libraryId !== undefined &&
        !(await itemBelongsToLibrary(id, libraryId))
      )
        continue;
      itemIds.push(id);
      const entry = await store.getIndexEntry(id);
      titles.set(id, entry?.title || `Item ${id}`);
    }
  }

  if (itemIds.length === 0) return null;

  return { itemIds, titles };
}

async function itemBelongsToLibrary(
  itemId: number,
  libraryId: number,
): Promise<boolean> {
  try {
    const item = (await Zotero.Items.getAsync(itemId)) as Zotero.Item | null;
    return item?.libraryID === libraryId;
  } catch {
    return false;
  }
}

export async function executeSemanticSearch(
  params: SemanticSearchParams,
  config: AgentConfig,
): Promise<ToolResult> {
  try {
    const {
      query,
      scope = "library",
      library_id: userLibraryId,
      collection_id: userCollectionId,
      top_k = 5,
      min_score = 30,
      sources,
      include_full_text,
    } = params;

    const library_id =
      userLibraryId ??
      (await deriveScopeLibraryId(scope, undefined, config.libraryScope));
    const collection_id = await deriveScopeCollectionId(
      scope,
      userCollectionId,
      config.libraryScope,
    );

    const effectiveTopK = Math.min(top_k, 20);

    Zotero.debug(
      `[seerai] Tool: semantic_search query="${query}" scope=${scope} lib=${library_id} col=${collection_id} topK=${effectiveTopK}`,
    );

    const embeddingService = getEmbeddingService();
    if (!embeddingService.isConfigured()) {
      return {
        success: false,
        error:
          "Semantic search is not available — no embedding model configured. " +
          "Set an embedding model in Preferences > API Configuration.",
      };
    }

    const scopeResult = await resolveSearchScope(
      scope,
      collection_id,
      library_id,
      config,
    );
    if (!scopeResult) {
      return {
        success: true,
        data: { query, total_searched: 0, results: [] },
        summary:
          scope === "collection" && collection_id
            ? "Collection not found or is empty"
            : scope === "context"
              ? "No items in chat context. Use scope='library' to search all indexed items, or add papers to context first."
              : "No items found in search scope",
      };
    }

    const { itemIds, titles } = scopeResult;

    const indexedIds: number[] = [];
    const store = getVectorStore();
    for (const id of itemIds) {
      if (await store.isIndexed(id)) {
        indexedIds.push(id);
      }
    }

    if (indexedIds.length === 0) {
      return {
        success: true,
        data: {
          query,
          total_searched: itemIds.length,
          results: [],
        },
        summary: `No indexed items found in scope (${itemIds.length} items total). Index items first by sending a message with them in context.`,
      };
    }

    let queryEmbedding: number[];
    try {
      queryEmbedding = await embeddingService.getEmbedding(query);
    } catch (e) {
      return {
        success: false,
        error: `Failed to embed search query: ${(e as Error).message}`,
      };
    }

    const searchResult = await store.searchSimilar(
      queryEmbedding,
      effectiveTopK * 2,
      indexedIds,
      min_score / 100,
    );

    let denseResults = searchResult.chunks;

    let bm25Failed = false;
    try {
      const ragConfig = getRAGConfig();
      denseResults = await mergeHybridResults(
        denseResults,
        query,
        indexedIds,
        effectiveTopK * 2,
        ragConfig.rrfAlpha ?? 0.55,
      );
    } catch (e) {
      bm25Failed = true;
      Zotero.debug(`[seerai] Tool: semantic_search BM25 failed: ${e}`);
    }

    if (isRerankerConfigured() && denseResults.length > 1) {
      try {
        const topN = Math.min(effectiveTopK * 2, denseResults.length);
        denseResults =
          (await crossEncodeRerank(query, denseResults, topN)) ?? denseResults;
      } catch (e) {
        Zotero.debug(`[seerai] Tool: semantic_search reranker failed: ${e}`);
      }
    }

    const results: SemanticSearchResultData = {
      query,
      total_searched: indexedIds.length,
      results: [],
    };

    const seenChunkIds = new Set<string>();
    for (const r of denseResults) {
      if (seenChunkIds.has(r.chunk.id)) continue;
      if (results.results.length >= effectiveTopK) break;

      // Source filter
      if (sources && sources.length > 0 && !sources.includes(r.chunk.source)) {
        continue;
      }

      seenChunkIds.add(r.chunk.id);

      const sourceLabel =
        r.chunk.source === "abstract"
          ? "abstract"
          : r.chunk.source === "note"
            ? "note"
            : r.chunk.source === "pdf"
              ? "pdf"
              : r.chunk.source === "table"
                ? "table"
                : r.chunk.source;

      const rawPassage = include_full_text
        ? stripContextTags(r.chunk.text)
        : stripContextTags(r.chunk.text).substring(0, 1000);
      results.results.push({
        title: r.sourceItem.title,
        item_id: r.sourceItem.id,
        passage: `[${sourceLabel}] ${rawPassage}`,
        source: sourceLabel,
        relevance: Math.round(r.score * 100),
      });
    }

    // Collect passthrough items (tables, files, topics) from context
    if (scope === "context" && results.results.length < effectiveTopK) {
      const contextMgr = await import("../context/contextManager").then((m) =>
        m.ChatContextManager.getInstance(),
      );
      const allItems = contextMgr.getItems();

      // Collect table content
      for (const item of allItems) {
        if (
          item.type !== "table" &&
          item.type !== "file" &&
          item.type !== "topic"
        ) {
          continue;
        }

        if (results.results.length >= effectiveTopK) break;

        if (item.type === "table") {
          const tableStoreModule = await import("../tableStore");
          const ts = tableStoreModule.getTableStore();
          const storedTables = await ts.getAllTables();
          const tableConfig = storedTables.find(
            (t) => t.id === String(item.id),
          );
          if (tableConfig) {
            results.results.push({
              title: tableConfig.name,
              item_id: typeof item.id === "number" ? item.id : -1,
              passage: `Table "${tableConfig.name}" with ${tableConfig.addedPaperIds.length} papers and ${tableConfig.columns.length} columns`,
              source: "table",
              relevance: 100,
            });
          }
        } else if (item.type === "file") {
          const filename =
            (item.metadata?.filename as string) || item.displayName;
          const content = (item.metadata?.content as string) || "";
          const preview =
            content.length > 200
              ? content.substring(0, 200) + "..."
              : content || filename;
          results.results.push({
            title: item.displayName,
            item_id: typeof item.id === "number" ? item.id : -1,
            passage: preview,
            source: "file",
            relevance: 100,
          });
        } else if (item.type === "topic") {
          results.results.push({
            title: item.displayName,
            item_id: typeof item.id === "number" ? item.id : -1,
            passage: item.displayName,
            source: "topic",
            relevance: 100,
          });
        }
      }
    }

    const methodInfo = bm25Failed ? " (BM25 failed — dense only)" : "";
    const passthroughNote = results.results.some((r) =>
      ["table", "file", "topic"].includes(r.source),
    )
      ? ". Includes table/file/topic context items"
      : "";
    await store.saveIndex();
    return {
      success: true,
      data: results,
      summary:
        `Semantically searched ${indexedIds.length} papers` +
        ` for "${query}"${methodInfo}. Found ${results.results.length} relevant passages${passthroughNote}.`,
    };
  } catch (error) {
    Zotero.debug(`[seerai] Tool: semantic_search error: ${error}`);
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function executeKeywordSearch(
  params: KeywordSearchParams,
  config: AgentConfig,
): Promise<ToolResult> {
  try {
    const {
      query,
      scope = "library",
      library_id: userLibraryId,
      collection_id: userCollectionId,
      top_k = 5,
      sources,
    } = params;

    const library_id =
      userLibraryId ??
      (await deriveScopeLibraryId(scope, undefined, config.libraryScope));
    const collection_id = await deriveScopeCollectionId(
      scope,
      userCollectionId,
      config.libraryScope,
    );

    const effectiveTopK = Math.min(top_k, 20);

    Zotero.debug(
      `[seerai] Tool: keyword_search query="${query}" scope=${scope} lib=${library_id} col=${collection_id} topK=${effectiveTopK}`,
    );

    const scopeResult = await resolveSearchScope(
      scope,
      collection_id,
      library_id,
      config,
    );
    if (!scopeResult) {
      return {
        success: true,
        data: { query, total_searched: 0, results: [] },
        summary:
          scope === "collection" && collection_id
            ? "Collection not found or is empty"
            : scope === "context"
              ? "No items in chat context. Use scope='library' to search all indexed items, or add papers to context first."
              : "No items found in search scope",
      };
    }

    const { itemIds, titles } = scopeResult;

    const bm25Results = await bm25Search(query, itemIds, effectiveTopK * 2);

    const results: KeywordSearchResultData = {
      query,
      total_searched: itemIds.length,
      results: [],
    };

    const seenChunkIds = new Set<string>();
    for (const r of bm25Results) {
      if (seenChunkIds.has(r.chunkId)) continue;
      if (results.results.length >= effectiveTopK) break;

      // Source filter
      if (sources && sources.length > 0 && !sources.includes(r.source)) {
        continue;
      }

      seenChunkIds.add(r.chunkId);

      const sourceLabel =
        r.source === "abstract"
          ? "abstract"
          : r.source === "note"
            ? "note"
            : r.source === "pdf"
              ? "pdf"
              : r.source === "table"
                ? "table"
                : r.source;

      const kwRawPassage = stripContextTags(r.text).substring(0, 1000);
      results.results.push({
        title: r.title || `Item ${r.itemId}`,
        item_id: r.itemId,
        passage: `[${sourceLabel}] ${kwRawPassage}`,
        source: sourceLabel,
        relevance: Math.round(Math.min(r.score * 100, 100)),
      });
    }

    return {
      success: true,
      data: results,
      summary:
        `BM25 keyword search across ${itemIds.length} papers ` +
        `for "${query}". Found ${results.results.length} results. ` +
        `(Tip: use semantic_search for conceptual understanding, ` +
        `not just exact word matches.)`,
    };
  } catch (error) {
    Zotero.debug(`[seerai] Tool: keyword_search error: ${error}`);
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function executeReadChunks(
  params: ReadChunksParams,
  config: AgentConfig,
): Promise<ToolResult> {
  try {
    const {
      chunk_ids,
      item_id,
      max_chunks = 10,
      scope = "library",
      library_id: userLibraryId,
      collection_id: userCollectionId,
    } = params;

    const library_id =
      userLibraryId ??
      (await deriveScopeLibraryId(scope, undefined, config.libraryScope));
    const collection_id = await deriveScopeCollectionId(
      scope,
      userCollectionId,
      config.libraryScope,
    );

    const effectiveMax = Math.min(max_chunks, 50);
    const store = getVectorStore();
    const output: ReadChunksResultData = { chunks: [], total_found: 0 };

    // ── Resolve scope to a whitelist of accessible item IDs ──
    let allowedItemIds: Set<number> | null = null;

    if (scope === "library") {
      const allIds = await store.getIndexedItemIds();
      if (library_id !== undefined) {
        const filteredIds: number[] = [];
        for (const id of allIds) {
          try {
            const item = await Zotero.Items.getAsync(id);
            if (item && item.libraryID === library_id) {
              filteredIds.push(id);
            }
          } catch {
            // Item not loaded or deleted — skip
          }
        }
        allowedItemIds = new Set(filteredIds);
      } else {
        allowedItemIds = new Set(allIds);
      }
    } else {
      // For "context" and "collection" scope, resolve via resolveSearchScope
      const scopeResult = await resolveSearchScope(
        scope,
        collection_id,
        library_id,
        config,
      );
      if (!scopeResult) {
        return {
          success: true,
          data: output,
          summary:
            scope === "collection" && collection_id
              ? "Collection not found or is empty"
              : "No items found in scope",
        };
      }
      allowedItemIds = new Set(scopeResult.itemIds);
    }

    if (chunk_ids && chunk_ids.length > 0) {
      const itemChunks = new Map<number, string[]>();
      for (const cid of chunk_ids) {
        const parts = cid.split("_");
        const itemId = parseInt(parts[0], 10);
        if (isNaN(itemId)) continue;
        if (allowedItemIds && !allowedItemIds.has(itemId)) continue;
        if (!itemChunks.has(itemId)) {
          itemChunks.set(itemId, []);
        }
        itemChunks.get(itemId)!.push(cid);
      }

      for (const [itemId, cids] of itemChunks) {
        const entry = await store.loadEntryForBm25(itemId);
        if (!entry) continue;
        for (const chunk of entry.chunks) {
          if (cids.includes(chunk.id) && output.chunks.length < effectiveMax) {
            output.chunks.push({
              chunk_id: chunk.id,
              item_id: chunk.itemId,
              item_title: chunk.metadata?.title || `Item ${chunk.itemId}`,
              text: stripContextTags(chunk.text),
              source: chunk.source,
              chunk_index: chunk.chunkIndex,
              metadata: chunk.metadata as Record<string, unknown>,
            });
          }
        }
      }
    } else if (item_id) {
      if (allowedItemIds && !allowedItemIds.has(item_id)) {
        return {
          success: true,
          data: output,
          summary: `Item ${item_id} is not in the current scope (${scope}).`,
        };
      }
      const entry = await store.loadEntryForBm25(item_id);
      if (entry) {
        const title = entry.chunks[0]?.metadata?.title || `Item ${item_id}`;
        for (const chunk of entry.chunks) {
          if (output.chunks.length >= effectiveMax) break;
          output.chunks.push({
            chunk_id: chunk.id,
            item_id: chunk.itemId,
            item_title: title,
            text: stripContextTags(chunk.text),
            source: chunk.source,
            chunk_index: chunk.chunkIndex,
            metadata: chunk.metadata as Record<string, unknown>,
          });
        }
      }
    }

    output.total_found = output.chunks.length;

    return {
      success: true,
      data: output,
      summary: `Read ${output.total_found} chunks from ${output.chunks.length > 0 ? output.chunks.map((c) => c.chunk_id).join(", ") : "no matches"}.`,
    };
  } catch (error) {
    Zotero.debug(`[seerai] Tool: read_chunks error: ${error}`);
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function executeSearchSimilar(
  params: SearchSimilarParams,
  config: AgentConfig,
): Promise<ToolResult> {
  try {
    const {
      item_id,
      top_k = 5,
      min_score = 30,
      scope = "library",
      library_id: userLibraryId,
      collection_id: userCollectionId,
    } = params;

    const library_id =
      userLibraryId ??
      (await deriveScopeLibraryId(scope, undefined, config.libraryScope));
    const collection_id = await deriveScopeCollectionId(
      scope,
      userCollectionId,
      config.libraryScope,
    );

    const effectiveTopK = Math.min(top_k, 20);

    Zotero.debug(
      `[seerai] Tool: search_similar item_id=${item_id} lib=${library_id} col=${collection_id} topK=${effectiveTopK}`,
    );

    const embeddingService = getEmbeddingService();
    if (!embeddingService.isConfigured()) {
      return {
        success: false,
        error:
          "Search similar is not available — no embedding model configured.",
      };
    }

    const store = getVectorStore();

    // Load the source item's chunks, auto-index if needed
    let entry = await store.loadEntryForBm25(item_id);
    if (!entry || entry.chunks.length === 0) {
      Zotero.debug(
        `[seerai] Tool: search_similar auto-indexing item ${item_id}`,
      );
      let content = await Assistant.extractContentForRAG(item_id);
      if (!content) {
        const zItem = Zotero.Items.get(item_id);
        if (!zItem) {
          return {
            success: false,
            error: `Item ${item_id} not found.`,
          };
        }
        let title = "";
        try {
          title = (zItem.getField("title") as string) || "";
        } catch {
          title = "";
        }
        if (!title.trim()) {
          return {
            success: false,
            error: `Item ${item_id} has no extractable content for indexing.`,
          };
        }
        content = { title, notes: [title] };
      }
      const ragConfig = getRAGConfig();
      const { chunks, parentWindows } = chunkPaperContent(item_id, content, {
        chunkSize: ragConfig.chunkSize,
        chunkOverlap: ragConfig.chunkOverlap,
        sentenceWindow: ragConfig.sentenceWindow,
        windowSize: ragConfig.sentenceWindowSize,
      });
      if (chunks.length === 0) {
        return {
          success: false,
          error: `No indexable content produced for item ${item_id}.`,
        };
      }
      const contentHash = VectorStore.contentHash(
        (content.abstract || "") +
          (content.notes?.join("") || "") +
          (content.pdfText || ""),
      );
      const texts = chunks.map((c) => c.text);
      const embeddings = await embeddingService.getEmbeddings(texts);
      const model = embeddingService.getConfiguredModel() || "unknown";
      const pubYearMatch = (content.date || "").match(
        /\b(1[89]\d{2}|20\d{2})\b/,
      );
      const publicationYear = pubYearMatch
        ? parseInt(pubYearMatch[1], 10)
        : undefined;
      const firstCreator = content.authors?.[0]?.split(/\s/).pop() || undefined;
      await store.indexItem(
        item_id,
        chunks,
        embeddings,
        model,
        contentHash,
        parentWindows,
        publicationYear,
        content.title,
        firstCreator,
      );
      entry = await store.loadEntryForBm25(item_id);
      if (!entry || entry.chunks.length === 0) {
        return {
          success: false,
          error: `Failed to index item ${item_id}.`,
        };
      }
    }

    const chunksWithEmbs = entry.chunks.filter(
      (c) => c.embedding && c.embedding.length > 0,
    );
    if (chunksWithEmbs.length === 0) {
      return {
        success: false,
        error: `Item ${item_id} has no embedding vectors. Re-index may be needed.`,
      };
    }

    // Average the item's chunk embeddings into one query vector
    const dim = chunksWithEmbs[0].embedding.length;
    const avgEmbedding = new Array(dim).fill(0) as number[];
    for (const chunk of chunksWithEmbs) {
      for (let d = 0; d < dim; d++) {
        avgEmbedding[d] += chunk.embedding[d];
      }
    }
    for (let d = 0; d < dim; d++) {
      avgEmbedding[d] /= chunksWithEmbs.length;
    }

    // Resolve search scope to find similar items within
    const scopeResult = await resolveSearchScope(
      scope,
      collection_id,
      library_id,
      config,
    );
    if (!scopeResult) {
      return {
        success: false,
        error: "No items found in search scope.",
      };
    }

    // Exclude the source item from results
    const searchIds = scopeResult.itemIds.filter((id) => id !== item_id);
    if (searchIds.length === 0) {
      return {
        success: true,
        data: {
          source_item: {
            id: item_id,
            title: scopeResult.titles.get(item_id) || `Item ${item_id}`,
          },
          similar_items: [],
          total_searched: scopeResult.itemIds.length - 1,
        },
        summary: `Item ${item_id} is the only indexed item in scope — no similar items to compare.`,
      };
    }

    let searchResult = await store.searchSimilar(
      avgEmbedding,
      effectiveTopK * 3,
      searchIds,
      min_score / 100,
    );
    let totalSearched = searchIds.length;

    if (searchResult.dimensionMismatch) {
      const mismatchedIds = new Set(searchResult.mismatchedItemIds);
      for (const id of mismatchedIds) {
        await store.removeItem(id);
      }
      const remainingIds = searchIds.filter((id) => !mismatchedIds.has(id));
      if (remainingIds.length === 0) {
        return {
          success: false,
          error:
            "All items in search scope were indexed with a previous embedding model and have been cleared. Run semantic_search to re-index items with the current model, then retry search_similar.",
        };
      }
      searchResult = await store.searchSimilar(
        avgEmbedding,
        effectiveTopK * 3,
        remainingIds,
        min_score / 100,
      );
      if (searchResult.dimensionMismatch) {
        return {
          success: false,
          error:
            "Dimension mismatch persists after clearing stale items. Run semantic_search to re-index items with the current model.",
        };
      }
      totalSearched = remainingIds.length;
    }

    // Aggregate scores by item ID (take the best score per item)
    const itemScores = new Map<number, number>();
    for (const r of searchResult.chunks) {
      const existing = itemScores.get(r.sourceItem.id);
      if (existing === undefined || r.score > existing) {
        itemScores.set(r.sourceItem.id, r.score);
      }
    }

    const sortedItems = [...itemScores]
      .sort((a, b) => b[1] - a[1])
      .slice(0, effectiveTopK);

    const sourceEntry = await store.getIndexEntry(item_id);
    const sourceTitle =
      sourceEntry?.title ||
      scopeResult.titles.get(item_id) ||
      `Item ${item_id}`;

    const similar: SearchSimilarResultData["similar_items"] = [];
    for (const [simId, score] of sortedItems) {
      const entry = await store.getIndexEntry(simId);
      const title = entry?.title || `Item ${simId}`;
      const year = entry?.publicationYear;
      const lastName = entry?.firstCreator || "";
      const citation = year
        ? lastName
          ? `${lastName}, ${year}`
          : `${year}`
        : lastName || undefined;

      similar.push({
        id: simId,
        title,
        score: Math.round(score * 100),
        citation,
        snippet: entry?.snippet,
      });
    }

    await store.saveIndex();

    return {
      success: true,
      data: {
        source_item: { id: item_id, title: sourceTitle },
        similar_items: similar,
        total_searched: totalSearched,
      },
      summary:
        `Found ${similar.length} papers similar to "${sourceTitle.substring(0, 60)}" ` +
        `from ${totalSearched} indexed items.`,
    };
  } catch (error) {
    Zotero.debug(`[seerai] Tool: search_similar error: ${error}`);
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
