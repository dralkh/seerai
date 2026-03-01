/**
 * File-based vector store for the RAG system.
 * Stores embedding vectors in the plugin's data directory as JSON files.
 *
 * Storage layout:
 *   {Zotero.DataDirectory.dir}/{addonRef}/vectors/_index.json  — global manifest
 *   {Zotero.DataDirectory.dir}/{addonRef}/vectors/{itemId}.json — per-item vectors
 *
 * Provides cosine similarity search over stored vectors.
 */

import { config } from "../../../../package.json";
import type {
  DocumentChunk,
  EmbeddedChunk,
  VectorStoreEntry,
  VectorIndexEntry,
  VectorStoreIndex,
  VectorStoreStats,
  RetrievedChunk,
  VectorSearchResult,
} from "./types";

export class VectorStore {
  private static instance: VectorStore | null = null;

  /** In-memory copy of the global index */
  private index: VectorStoreIndex | null = null;

  /** LRU cache of loaded vector entries (keyed by itemId) */
  private entryCache: Map<number, VectorStoreEntry> = new Map();

  /** Max entries in the in-memory cache */
  private static readonly CACHE_MAX = 50;

  /** Current index version */
  private static readonly INDEX_VERSION = 1;

  private constructor() {}

  static getInstance(): VectorStore {
    if (!VectorStore.instance) {
      VectorStore.instance = new VectorStore();
    }
    return VectorStore.instance;
  }

  // ─── Path helpers ──────────────────────────────────────────────────────────

  private getVectorsDir(): string {
    return PathUtils.join(Zotero.DataDirectory.dir, config.addonRef, "vectors");
  }

  private getIndexPath(): string {
    return PathUtils.join(this.getVectorsDir(), "_index.json");
  }

  private getEntryPath(itemId: number): string {
    return PathUtils.join(this.getVectorsDir(), `${itemId}.json`);
  }

  // ─── Directory / index initialisation ──────────────────────────────────────

  /**
   * Ensure the vectors directory and index file exist.
   */
  private async ensureDir(): Promise<void> {
    const dir = this.getVectorsDir();
    try {
      if (!(await IOUtils.exists(dir))) {
        await IOUtils.makeDirectory(dir, { ignoreExisting: true });
        Zotero.debug(`[seerai] Created vectors directory: ${dir}`);
      }
    } catch (e) {
      Zotero.debug(`[seerai] Error creating vectors directory: ${e}`);
      throw e;
    }
  }

  /**
   * Load the global index into memory (lazy — called once, then cached).
   */
  private async loadIndex(): Promise<VectorStoreIndex> {
    if (this.index) return this.index;

    await this.ensureDir();
    const indexPath = this.getIndexPath();

    try {
      if (await IOUtils.exists(indexPath)) {
        const raw = await IOUtils.readUTF8(indexPath);
        this.index = JSON.parse(raw) as VectorStoreIndex;

        // Version migration if needed
        if (
          !this.index.version ||
          this.index.version < VectorStore.INDEX_VERSION
        ) {
          this.index.version = VectorStore.INDEX_VERSION;
          await this.saveIndex();
        }
      } else {
        this.index = {
          version: VectorStore.INDEX_VERSION,
          entries: {},
          updatedAt: new Date().toISOString(),
        };
        await this.saveIndex();
      }
    } catch (e) {
      Zotero.debug(`[seerai] Error loading vector index, reinitialising: ${e}`);
      this.index = {
        version: VectorStore.INDEX_VERSION,
        entries: {},
        updatedAt: new Date().toISOString(),
      };
      await this.saveIndex();
    }

    return this.index;
  }

  /**
   * Persist the in-memory index to disk.
   */
  private async saveIndex(): Promise<void> {
    if (!this.index) return;
    this.index.updatedAt = new Date().toISOString();
    const indexPath = this.getIndexPath();
    await IOUtils.writeUTF8(indexPath, JSON.stringify(this.index));
  }

  // ─── Entry I/O ─────────────────────────────────────────────────────────────

  /**
   * Load a single item's vector entry from disk (with caching).
   */
  private async loadEntry(itemId: number): Promise<VectorStoreEntry | null> {
    // Check cache first
    if (this.entryCache.has(itemId)) {
      return this.entryCache.get(itemId)!;
    }

    const entryPath = this.getEntryPath(itemId);
    try {
      if (!(await IOUtils.exists(entryPath))) return null;
      const raw = await IOUtils.readUTF8(entryPath);
      const entry = JSON.parse(raw) as VectorStoreEntry;

      // Add to cache (evict oldest if full)
      this.addToCache(itemId, entry);
      return entry;
    } catch (e) {
      Zotero.debug(`[seerai] Error loading vector entry ${itemId}: ${e}`);
      return null;
    }
  }

  /**
   * Save a single item's vector entry to disk.
   */
  private async saveEntry(entry: VectorStoreEntry): Promise<void> {
    await this.ensureDir();
    const entryPath = this.getEntryPath(entry.itemId);
    await IOUtils.writeUTF8(entryPath, JSON.stringify(entry));

    // Update cache
    this.addToCache(entry.itemId, entry);
  }

  /**
   * Add an entry to the in-memory LRU cache, evicting the oldest if needed.
   */
  private addToCache(itemId: number, entry: VectorStoreEntry): void {
    // Evict oldest if at capacity
    if (
      this.entryCache.size >= VectorStore.CACHE_MAX &&
      !this.entryCache.has(itemId)
    ) {
      const oldestKey = this.entryCache.keys().next().value;
      if (oldestKey !== undefined) {
        this.entryCache.delete(oldestKey);
      }
    }
    this.entryCache.set(itemId, entry);
  }

  // ─── Public API: Indexing ──────────────────────────────────────────────────

  /**
   * Store embedding vectors for a Zotero item.
   *
   * @param itemId      Zotero item ID
   * @param chunks      Document chunks (text + metadata)
   * @param embeddings  Corresponding embedding vectors (same length as chunks)
   * @param model       Embedding model used
   * @param contentHash Hash of the source content (for staleness detection)
   */
  async indexItem(
    itemId: number,
    chunks: DocumentChunk[],
    embeddings: number[][],
    model: string,
    contentHash: string,
  ): Promise<void> {
    if (chunks.length !== embeddings.length) {
      throw new Error(
        `Chunk/embedding count mismatch: ${chunks.length} chunks vs ${embeddings.length} embeddings`,
      );
    }

    const dimensions = embeddings[0]?.length || 0;

    // Build embedded chunks
    const embeddedChunks: EmbeddedChunk[] = chunks.map((chunk, i) => ({
      ...chunk,
      embedding: embeddings[i],
      embeddingModel: model,
    }));

    // Create entry
    const entry: VectorStoreEntry = {
      itemId,
      chunks: embeddedChunks,
      embeddingModel: model,
      dimensions,
      contentHash,
      indexedAt: new Date().toISOString(),
    };

    // Save to disk
    await this.saveEntry(entry);

    // Update global index
    const index = await this.loadIndex();
    index.entries[itemId] = {
      itemId,
      chunkCount: chunks.length,
      embeddingModel: model,
      dimensions,
      contentHash,
      lastIndexedAt: entry.indexedAt,
    };
    await this.saveIndex();

    Zotero.debug(
      `[seerai] Indexed item ${itemId}: ${chunks.length} chunks, ` +
        `${dimensions} dimensions, model=${model}`,
    );
  }

  /**
   * Remove an item's vectors from the store.
   */
  async removeItem(itemId: number): Promise<boolean> {
    const index = await this.loadIndex();
    if (!index.entries[itemId]) return false;

    // Delete file
    const entryPath = this.getEntryPath(itemId);
    try {
      if (await IOUtils.exists(entryPath)) {
        await IOUtils.remove(entryPath);
      }
    } catch (e) {
      Zotero.debug(`[seerai] Error removing vector file ${itemId}: ${e}`);
    }

    // Remove from index and cache
    delete index.entries[itemId];
    this.entryCache.delete(itemId);
    await this.saveIndex();

    Zotero.debug(`[seerai] Removed vectors for item ${itemId}`);
    return true;
  }

  /**
   * Check whether an item is indexed (has stored embeddings).
   */
  async isIndexed(itemId: number): Promise<boolean> {
    const index = await this.loadIndex();
    return !!index.entries[itemId];
  }

  /**
   * Check whether an item's index is stale (content has changed since last indexing).
   */
  async isStale(itemId: number, currentContentHash: string): Promise<boolean> {
    const index = await this.loadIndex();
    const entry = index.entries[itemId];
    if (!entry) return true; // Not indexed = effectively stale
    return entry.contentHash !== currentContentHash;
  }

  /**
   * Check whether an item's stored vectors have a different dimension count
   * than the currently configured embedding model.
   *
   * @param itemId             Zotero item ID
   * @param currentDimensions  Dimension count of the currently configured model
   * @returns true if stored dimensions differ from currentDimensions (needs re-index)
   */
  async isDimensionStale(
    itemId: number,
    currentDimensions: number,
  ): Promise<boolean> {
    const index = await this.loadIndex();
    const entry = index.entries[itemId];
    if (!entry) return false; // Not indexed — not a mismatch, just unindexed
    return entry.dimensions !== currentDimensions;
  }

  /**
   * Get the index entry for an item (metadata only, no vectors).
   */
  async getIndexEntry(itemId: number): Promise<VectorIndexEntry | null> {
    const index = await this.loadIndex();
    return index.entries[itemId] || null;
  }

  // ─── Public API: Search ────────────────────────────────────────────────────

  /**
   * Search for the most similar chunks to a query embedding.
   *
   * Returns a VectorSearchResult that includes a `dimensionMismatch` flag.
   * When a mismatch is detected (query vector dimensions != stored vector
   * dimensions), the method returns early with `dimensionMismatch: true`
   * and the list of affected item IDs — the caller should clear and re-index
   * those items before retrying.
   *
   * @param queryEmbedding  The query vector
   * @param topK            Maximum number of results
   * @param filterItemIds   If provided, only search within these items
   * @param minScore        Minimum cosine similarity threshold (default: 0)
   * @returns VectorSearchResult with chunks, mismatch flag, and affected IDs
   */
  async searchSimilar(
    queryEmbedding: number[],
    topK: number = 20,
    filterItemIds?: number[],
    minScore: number = 0,
  ): Promise<VectorSearchResult> {
    const index = await this.loadIndex();

    // Determine which items to search
    const itemIds = filterItemIds
      ? filterItemIds.filter((id) => !!index.entries[id])
      : Object.keys(index.entries).map(Number);

    if (itemIds.length === 0) {
      return { chunks: [], dimensionMismatch: false, mismatchedItemIds: [] };
    }

    // ── Early dimension mismatch detection via index metadata ──────────────
    const queryDim = queryEmbedding.length;
    const mismatchedItemIds: number[] = [];

    for (const itemId of itemIds) {
      const entry = index.entries[itemId];
      if (entry && entry.dimensions !== queryDim) {
        mismatchedItemIds.push(itemId);
      }
    }

    if (mismatchedItemIds.length > 0) {
      Zotero.debug(
        `[seerai] Dimension mismatch detected: query has ${queryDim} dimensions, ` +
          `but ${mismatchedItemIds.length} item(s) have different dimensions ` +
          `(e.g., item ${mismatchedItemIds[0]}: ${index.entries[mismatchedItemIds[0]]?.dimensions}d). ` +
          `Returning for re-indexing.`,
      );
      return {
        chunks: [],
        dimensionMismatch: true,
        mismatchedItemIds,
      };
    }

    // ── All dimensions match — perform cosine similarity search ────────────
    const candidates: RetrievedChunk[] = [];

    for (const itemId of itemIds) {
      const entry = await this.loadEntry(itemId);
      if (!entry) continue;

      for (const chunk of entry.chunks) {
        const score = cosineSimilarity(queryEmbedding, chunk.embedding);
        if (score >= minScore) {
          candidates.push({
            chunk,
            score,
            sourceItem: {
              title: chunk.metadata.title || `Item ${itemId}`,
              id: itemId,
            },
          });
        }
      }
    }

    // Sort by score descending, take topK
    candidates.sort((a, b) => b.score - a.score);
    return {
      chunks: candidates.slice(0, topK),
      dimensionMismatch: false,
      mismatchedItemIds: [],
    };
  }

  // ─── Public API: Statistics ────────────────────────────────────────────────

  /**
   * Get statistics about the vector store.
   */
  async getStats(): Promise<VectorStoreStats> {
    const index = await this.loadIndex();
    const entries = Object.values(index.entries);

    return {
      totalItems: entries.length,
      totalChunks: entries.reduce((sum, e) => sum + e.chunkCount, 0),
      embeddingModel: entries[0]?.embeddingModel || null,
      dimensions: entries[0]?.dimensions || null,
    };
  }

  /**
   * Get the count of indexed items that are in the given set of item IDs.
   */
  async getIndexedCount(itemIds: number[]): Promise<number> {
    const index = await this.loadIndex();
    return itemIds.filter((id) => !!index.entries[id]).length;
  }

  /**
   * Clear all stored vectors and reset the index.
   */
  async clearAll(): Promise<void> {
    const index = await this.loadIndex();

    // Delete all entry files
    for (const itemId of Object.keys(index.entries).map(Number)) {
      const entryPath = this.getEntryPath(itemId);
      try {
        if (await IOUtils.exists(entryPath)) {
          await IOUtils.remove(entryPath);
        }
      } catch (e) {
        // Continue on error
      }
    }

    // Reset index
    this.index = {
      version: VectorStore.INDEX_VERSION,
      entries: {},
      updatedAt: new Date().toISOString(),
    };
    await this.saveIndex();

    // Clear cache
    this.entryCache.clear();

    Zotero.debug("[seerai] Cleared all vectors");
  }

  // ─── Content hashing ──────────────────────────────────────────────────────

  /**
   * Generate a simple hash of text content for staleness detection.
   * Uses a fast FNV-1a style hash (good enough for change detection, not crypto).
   */
  static contentHash(text: string): string {
    let hash = 0x811c9dc5; // FNV offset basis
    for (let i = 0; i < text.length; i++) {
      hash ^= text.charCodeAt(i);
      hash = (hash * 0x01000193) | 0; // FNV prime, force 32-bit int
    }
    // Include length to reduce collisions for texts that differ only in length
    hash ^= text.length;
    return (hash >>> 0).toString(16).padStart(8, "0");
  }
}

// ─── Vector math utilities ──────────────────────────────────────────────────

/**
 * Compute cosine similarity between two vectors.
 * Returns a value in [-1, 1] where 1 means identical direction.
 */
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    // Dimension mismatch should be caught by searchSimilar() early detection.
    // If we get here, it's a corrupted per-item file — silently skip.
    return 0;
  }

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

/** Singleton accessor */
export function getVectorStore(): VectorStore {
  return VectorStore.getInstance();
}
