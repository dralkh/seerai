/**
 * BM25 sparse retrieval index for hybrid search.
 *
 * Complements dense vector search with lexical matching for precise
 * terminology (gene names, chemical compounds, author names, etc.).
 *
 * Storage: term→document frequency map serialized alongside vector data.
 * Cache is persisted to disk (_bm25_cache.json) for fast restart recovery.
 */

import { config } from "../../../../package.json";
import { getVectorStore } from "./vectorStore";

const BM25_K1 = 1.2;
const BM25_B = 0.75;

const BM25_CACHE_FILE = "_bm25_cache.json";
const SAVE_DEBOUNCE_MS = 5000;

interface Bm25Document {
  id: string;
  itemId: number;
  terms: Map<string, number>;
  length: number;
  text: string;
  source: import("./types").ChunkSource;
  title?: string;
}

interface Bm25Cache {
  documents: Map<number, Bm25Document[]>;
  docFreqs: Map<string, number>;
  totalDocs: number;
  avgDocLen: number;
  version: number;
  builtAt: string;
}

let _cache: Bm25Cache | null = null;
let _cacheItemIds: Set<number> | null = null;
let _dirty = false;
let _saveTimer: ReturnType<typeof setTimeout> | null = null;

function tokenize(text: string): string[] {
  const lowerText = text.toLowerCase();

  if (typeof Intl !== "undefined" && typeof Intl.Segmenter === "function") {
    try {
      const segmenter = new Intl.Segmenter([], { granularity: "word" });
      const tokens: string[] = [];
      for (const { segment, isWordLike } of segmenter.segment(lowerText)) {
        if (isWordLike && segment.length > 1 && segment.length < 40) {
          tokens.push(segment);
        }
      }
      return tokens;
    } catch {
      // Fall back to regex
      Zotero.debug(
        "[seerai] BM25: Intl.Segmenter failed, using regex fallback",
      );
    }
  }

  return lowerText
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .split(/\s+/)
    .filter((t: string) => t.length > 1 && t.length < 40);
}

function buildTermFreq(terms: string[]): Map<string, number> {
  const tf = new Map<string, number>();
  for (const t of terms) {
    tf.set(t, (tf.get(t) ?? 0) + 1);
  }
  return tf;
}

const STOP_WORDS = new Set([
  "the",
  "and",
  "for",
  "that",
  "this",
  "with",
  "from",
  "are",
  "was",
  "were",
  "been",
  "have",
  "has",
  "had",
  "not",
  "but",
  "its",
  "his",
  "her",
  "their",
  "our",
  "all",
  "can",
  "may",
  "will",
  "would",
  "could",
  "should",
  "also",
  "into",
  "than",
  "then",
  "about",
  "which",
  "these",
  "those",
  "each",
  "other",
  "some",
  "such",
  "more",
  "only",
  "over",
  "very",
  "just",
  "being",
  "when",
  "where",
  "while",
  "after",
  "before",
  "between",
  "through",
  "during",
  "above",
  "below",
  "的",
  "是",
  "在",
  "了",
  "和",
  "也",
  "就",
  "都",
  "而",
  "及",
  "与",
  "着",
  "或",
  "一个",
  "没有",
  "我们",
  "你们",
  "他们",
  "它们",
  "自己",
  "这",
  "那",
  "这些",
  "那些",
  "这个",
  "那个",
  "どの",
  "その",
  "この",
  "あの",
  "ます",
  "した",
  "して",
  "いる",
  "ある",
  "から",
  "ため",
  "より",
]);

function buildDocFreqs(
  documents: Map<number, Bm25Document[]>,
): Map<string, number> {
  const df = new Map<string, number>();
  for (const chunks of documents.values()) {
    for (const doc of chunks) {
      for (const term of doc.terms.keys()) {
        if (!STOP_WORDS.has(term)) {
          df.set(term, (df.get(term) ?? 0) + 1);
        }
      }
    }
  }
  return df;
}

// ─── Disk persistence ────────────────────────────────────────────────────

function getCachePath(): string {
  return PathUtils.join(
    Zotero.DataDirectory.dir,
    config.addonRef,
    "vectors",
    BM25_CACHE_FILE,
  );
}

interface SerializedBm25Doc {
  id: string;
  itemId: number;
  terms: Array<[string, number]>;
  length: number;
  text: string;
  source: string;
  title?: string;
}

interface SerializedBm25Cache {
  documents: Record<string, SerializedBm25Doc[]>;
  docFreqs: Array<[string, number]>;
  totalDocs: number;
  avgDocLen: number;
  version: number;
  builtAt: string;
}

async function loadBm25CacheFromDisk(): Promise<Bm25Cache | null> {
  try {
    const path = getCachePath();
    if (!(await IOUtils.exists(path))) return null;

    const raw = await IOUtils.readUTF8(path);
    if (!raw || !raw.trim()) return null;

    const serialized: SerializedBm25Cache = JSON.parse(raw);
    if (!serialized.documents || serialized.totalDocs === 0) return null;

    const documents = new Map<number, Bm25Document[]>();
    for (const [key, docs] of Object.entries(serialized.documents)) {
      const itemId = parseInt(key, 10);
      if (isNaN(itemId)) continue;
      documents.set(
        itemId,
        docs.map((d) => ({
          id: d.id,
          itemId: d.itemId,
          terms: new Map(d.terms),
          length: d.length,
          text: d.text,
          source: d.source as import("./types").ChunkSource,
          title: d.title,
        })),
      );
    }

    const docFreqs = new Map(serialized.docFreqs);

    Zotero.debug(
      `[seerai] BM25: loaded cache from disk — ` +
        `${serialized.totalDocs} docs, ${docFreqs.size} unique terms, ` +
        `${documents.size} items`,
    );

    return {
      documents,
      docFreqs,
      totalDocs: serialized.totalDocs,
      avgDocLen: serialized.avgDocLen,
      version: serialized.version,
      builtAt: serialized.builtAt,
    };
  } catch (e) {
    Zotero.debug(`[seerai] BM25: failed to load cache from disk: ${e}`);
    return null;
  }
}

function markDirty(): void {
  _dirty = true;
  if (_saveTimer) clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => {
    saveBm25CacheToDisk().catch(() => {});
  }, SAVE_DEBOUNCE_MS);
}

async function saveBm25CacheToDisk(): Promise<void> {
  if (!_cache || !_dirty) return;
  _dirty = false;

  try {
    const path = getCachePath();
    const dir = PathUtils.parent(path);
    if (dir && !(await IOUtils.exists(dir))) {
      await IOUtils.makeDirectory(dir, { ignoreExisting: true });
    }

    const serialized: SerializedBm25Cache = {
      documents: {},
      docFreqs: [..._cache.docFreqs],
      totalDocs: _cache.totalDocs,
      avgDocLen: _cache.avgDocLen,
      version: _cache.version,
      builtAt: _cache.builtAt,
    };

    for (const [itemId, docs] of _cache.documents) {
      serialized.documents[String(itemId)] = docs.map((d) => ({
        id: d.id,
        itemId: d.itemId,
        terms: [...d.terms],
        length: d.length,
        text: d.text,
        source: d.source,
        title: d.title,
      }));
    }

    await IOUtils.writeUTF8(path, JSON.stringify(serialized));
    Zotero.debug(
      `[seerai] BM25: saved cache to disk — ` +
        `${_cache.totalDocs} docs, ${_cache.docFreqs.size} terms`,
    );
  } catch (e) {
    Zotero.debug(`[seerai] BM25: failed to save cache to disk: ${e}`);
  }
}

async function ensureCache(
  filterItemIds?: number[],
): Promise<Bm25Cache | null> {
  const store = getVectorStore();

  let targetIds: number[];
  if (filterItemIds && filterItemIds.length > 0) {
    targetIds = filterItemIds;
  } else {
    targetIds = [];
    const stats = await store.getStats();
    if (stats.totalItems === 0) return null;
    const allIds = await store.getIndexedItemIds();
    targetIds = allIds;
  }

  if (targetIds.length === 0) return null;

  const targetSet = new Set(targetIds);
  if (
    _cache &&
    _cacheItemIds &&
    _cacheItemIds.size === targetSet.size &&
    [...targetSet].every((id) => _cacheItemIds!.has(id))
  ) {
    return _cache;
  }

  // ── Try loading from disk before full rebuild ──
  const diskCache = await loadBm25CacheFromDisk();
  if (diskCache && diskCache.totalDocs > 0) {
    _cache = diskCache;
    _cacheItemIds = targetSet;
    _dirty = false;
    return _cache;
  }

  const documents = new Map<number, Bm25Document[]>();
  let totalTerms = 0;
  let docCount = 0;

  for (const itemId of targetIds) {
    const entry = await store.loadEntryForBm25(itemId);
    if (!entry) continue;
    const chunks: Bm25Document[] = [];
    for (const chunk of entry.chunks) {
      const terms = tokenize(chunk.text);
      if (terms.length === 0) continue;
      const tf = buildTermFreq(terms);
      chunks.push({
        id: chunk.id,
        itemId,
        terms: tf,
        length: terms.length,
        text: chunk.text,
        source: chunk.source,
        title: chunk.metadata?.title,
      });
      totalTerms += terms.length;
      docCount++;
    }
    if (chunks.length > 0) {
      documents.set(itemId, chunks);
    }
  }

  if (docCount === 0) return null;

  const docFreqs = buildDocFreqs(documents);

  _cache = {
    documents,
    docFreqs,
    totalDocs: docCount,
    avgDocLen: docCount > 0 ? totalTerms / docCount : 1,
    version: 1,
    builtAt: new Date().toISOString(),
  };
  _cacheItemIds = targetSet;
  markDirty();

  return _cache;
}

export function invalidateBm25Cache(): void {
  _cache = null;
  _cacheItemIds = null;
  _dirty = false;
}

export async function incrementalAddToBm25Cache(itemId: number): Promise<void> {
  if (!_cache || !_cacheItemIds) {
    // No cache yet — defer to full rebuild on next search
    return;
  }

  const store = getVectorStore();
  const entry = await store.loadEntryForBm25(itemId);
  if (!entry || entry.chunks.length === 0) return;

  // Don't double-add
  if (_cache.documents.has(itemId)) return;

  const chunks: Bm25Document[] = [];
  let itemTotalTerms = 0;

  for (const chunk of entry.chunks) {
    const terms = tokenize(chunk.text);
    if (terms.length === 0) continue;
    const tf = buildTermFreq(terms);
    chunks.push({
      id: chunk.id,
      itemId,
      terms: tf,
      length: terms.length,
      text: chunk.text,
      source: chunk.source,
      title: chunk.metadata?.title,
    });
    itemTotalTerms += terms.length;

    for (const term of tf.keys()) {
      if (!STOP_WORDS.has(term)) {
        _cache.docFreqs.set(term, (_cache.docFreqs.get(term) ?? 0) + 1);
      }
    }
  }

  if (chunks.length === 0) return;

  _cache.documents.set(itemId, chunks);
  _cacheItemIds.add(itemId);

  const oldTotalTerms = _cache.avgDocLen * _cache.totalDocs;
  _cache.totalDocs += chunks.length;
  _cache.avgDocLen =
    _cache.totalDocs > 0
      ? (oldTotalTerms + itemTotalTerms) / _cache.totalDocs
      : 1;
  _cache.version++;
  _cache.builtAt = new Date().toISOString();
  markDirty();

  Zotero.debug(
    `[seerai] BM25: incremental add item ${itemId} ` +
      `(${chunks.length} chunks, ${_cache.totalDocs} total docs)`,
  );
}

export function incrementalRemoveFromBm25Cache(itemId: number): void {
  if (!_cache || !_cacheItemIds) return;

  const chunks = _cache.documents.get(itemId);
  if (!chunks) return;

  let removedTerms = 0;
  for (const doc of chunks) {
    for (const term of doc.terms.keys()) {
      if (!STOP_WORDS.has(term)) {
        const current = _cache.docFreqs.get(term);
        if (current !== undefined) {
          if (current <= 1) {
            _cache.docFreqs.delete(term);
          } else {
            _cache.docFreqs.set(term, current - 1);
          }
        }
      }
    }
    removedTerms += doc.length;
  }

  _cache.documents.delete(itemId);
  _cacheItemIds.delete(itemId);

  const oldTotalTerms = _cache.avgDocLen * _cache.totalDocs;
  _cache.totalDocs -= chunks.length;
  _cache.avgDocLen =
    _cache.totalDocs > 0
      ? (oldTotalTerms - removedTerms) / _cache.totalDocs
      : 1;
  _cache.version++;
  _cache.builtAt = new Date().toISOString();
  markDirty();

  Zotero.debug(
    `[seerai] BM25: incremental remove item ${itemId} ` +
      `(-${chunks.length} chunks, ${_cache.totalDocs} remaining docs)`,
  );
}

function bm25Score(
  queryTerms: string[],
  doc: Bm25Document,
  cache: Bm25Cache,
): number {
  let score = 0;
  for (const term of queryTerms) {
    const tf = doc.terms.get(term) ?? 0;
    if (tf === 0) continue;
    const df = cache.docFreqs.get(term) ?? 0;
    if (df === 0) continue;
    const idf = Math.log((cache.totalDocs - df + 0.5) / (df + 0.5) + 1);
    const numerator = tf * (BM25_K1 + 1);
    const denominator =
      tf + BM25_K1 * (1 - BM25_B + BM25_B * (doc.length / cache.avgDocLen));
    score += idf * (numerator / denominator);
  }
  return score;
}

export interface Bm25SearchResult {
  chunkId: string;
  itemId: number;
  score: number;
  text: string;
  source: import("./types").ChunkSource;
  title?: string;
}

export async function bm25Search(
  query: string,
  filterItemIds?: number[],
  topK: number = 40,
): Promise<Bm25SearchResult[]> {
  const cache = await ensureCache(filterItemIds);
  if (!cache) return [];

  const queryTerms = tokenize(query);
  if (queryTerms.length === 0) return [];

  const results: Bm25SearchResult[] = [];
  for (const [itemId, chunks] of cache.documents) {
    if (filterItemIds && !filterItemIds.includes(itemId)) continue;
    for (const doc of chunks) {
      const score = bm25Score(queryTerms, doc, cache);
      if (score > 0) {
        results.push({
          chunkId: doc.id,
          itemId,
          score,
          text: doc.text,
          source: doc.source,
          title: doc.title,
        });
      }
    }
  }

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, topK);
}

/**
 * Reciprocal Rank Fusion: merge dense and sparse result sets.
 *
 * RRF(d) = alpha * 1/(k + rank_dense(d)) + (1-alpha) * 1/(k + rank_sparse(d))
 * where k=60 is the standard smoothing constant.
 * alpha=0.55 gives a slight bias toward dense for semantic queries while
 * preserving BM25's strength on entity/terminology matching.
 */
export function reciprocalRankFusion(
  denseResults: Array<{
    chunkId?: string;
    id?: string;
    itemId: number;
    score: number;
  }>,
  sparseResults: Bm25SearchResult[],
  k: number = 60,
  alpha: number = 0.55,
): Map<string, number> {
  const fused = new Map<string, number>();

  for (let i = 0; i < denseResults.length; i++) {
    const r = denseResults[i];
    const chunkId = r.chunkId || r.id || "";
    if (!chunkId) continue;
    const existing = fused.get(chunkId) ?? 0;
    fused.set(chunkId, existing + alpha * (1 / (k + i + 1)));
  }

  for (let i = 0; i < sparseResults.length; i++) {
    const r = sparseResults[i];
    const existing = fused.get(r.chunkId) ?? 0;
    fused.set(r.chunkId, existing + (1 - alpha) * (1 / (k + i + 1)));
  }

  return fused;
}

/**
 * Merge dense vector search results with BM25 lexical results using RRF.
 *
 * Encapsulates the full hybrid search merge: runs BM25, fuses scores with
 * reciprocal rank fusion, and merges BM25-only chunks into the result set.
 * Used by both retrievalEngine.ts and ragTool.ts.
 */
export async function mergeHybridResults(
  denseResults: import("./types").RetrievedChunk[],
  query: string,
  filterItemIds: number[],
  topK: number,
  rrfAlpha: number,
): Promise<import("./types").RetrievedChunk[]> {
  const bm25Results = await bm25Search(query, filterItemIds, topK);
  if (bm25Results.length === 0) return denseResults;

  const denseFlat = denseResults.map((r) => ({
    chunkId: r.chunk.id,
    itemId: r.chunk.itemId,
    score: r.score,
  }));
  const fused = reciprocalRankFusion(denseFlat, bm25Results, 60, rrfAlpha);

  const denseChunkIds = new Set(denseResults.map((r) => r.chunk.id));
  const merged: import("./types").RetrievedChunk[] = denseResults.map((r) => {
    const fusedScore = fused.get(r.chunk.id);
    if (fusedScore !== undefined) {
      return { ...r, score: fusedScore };
    }
    return r;
  });

  for (const bm25 of bm25Results) {
    if (!denseChunkIds.has(bm25.chunkId)) {
      const fusedScore = fused.get(bm25.chunkId);
      if (fusedScore !== undefined) {
        merged.push({
          chunk: {
            id: bm25.chunkId,
            itemId: bm25.itemId,
            text: bm25.text,
            source: bm25.source,
            chunkIndex: -1,
            embedding: [],
            embeddingModel: "bm25",
            metadata: {
              title: bm25.title,
              startOffset: 0,
              endOffset: 0,
            },
          },
          score: fusedScore,
          sourceItem: {
            title: bm25.title || `Item ${bm25.itemId}`,
            id: bm25.itemId,
            publicationYear: await extractPubYear(bm25.itemId),
          },
        });
      }
    }
  }

  merged.sort((a, b) => b.score - a.score);
  return merged;
}

async function extractPubYear(itemId: number): Promise<number | undefined> {
  const entry = await getVectorStore().getIndexEntry(itemId);
  return entry?.publicationYear;
}
