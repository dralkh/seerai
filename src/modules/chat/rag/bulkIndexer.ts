/**
 * Bulk RAG indexing for collections and libraries.
 *
 * The retrieval engine indexes items lazily, only when they are part of a
 * chat's context. This module lets the user pre-build vectors for a whole
 * collection or library, with progress reporting and cancellation, using the
 * exact same indexing pipeline as on-demand RAG.
 *
 * Scope model (shared with search scoping via itemSources.ts):
 *   - regular items are searchable units (abstract/notes/metadata), and
 *   - every PDF/text attachment is its own searchable unit, so a book with
 *     multiple PDFs contributes all of them.
 * Collections are traversed recursively including subcollections.
 */

import { createAbortController } from "../../search/env";
import { getEmbeddingService } from "./embeddingService";
import { getVectorStore } from "./vectorStore";
import {
  indexItemsNow,
  ragContentHash,
  type BulkIndexProgress,
  type BulkIndexOptions,
  type RAGIndexContent,
} from "./retrievalEngine";
import {
  getIndexableAttachmentIdsAsync,
  isIndexableAttachment,
  isIndexableRegularItem,
} from "./itemSources";

export type BulkIndexPhase = "enumerating" | "indexing" | "done" | "cancelled";

export interface BulkIndexStatus extends BulkIndexProgress {
  phase: BulkIndexPhase;
  scopeLabel?: string;
  error?: string;
}

export interface BulkIndexScope {
  kind: "collection" | "library";
  id: number;
  label: string;
}

type ProgressListener = (status: BulkIndexStatus) => void;

interface BulkIndexJob {
  cancelled: boolean;
  status: BulkIndexStatus;
  listeners: Set<ProgressListener>;
  /** Aborts in-flight embedding requests when the job is cancelled. */
  controller: AbortController | null;
}

let activeJob: BulkIndexJob | null = null;

/**
 * Cancel the currently running bulk index, if any. In-flight embedding
 * requests are aborted immediately (not just between waves).
 */
export function cancelBulkIndex(): void {
  if (!activeJob) return;
  activeJob.cancelled = true;
  try {
    activeJob.controller?.abort();
  } catch (e) {
    Zotero.debug(`[seerai] RAG bulk: abort failed: ${e}`);
  }
}

export function isBulkIndexRunning(): boolean {
  return activeJob !== null;
}

/** Snapshot of the running job's status, or null when idle. */
export function getBulkIndexStatus(): BulkIndexStatus | null {
  return activeJob ? { ...activeJob.status } : null;
}

/**
 * Observe the running bulk index (immediately receives the current status and
 * then every update). Returns an unsubscribe function. No-op when idle, so
 * callers should also read getBulkIndexStatus() on open.
 */
export function subscribeBulkIndex(listener: ProgressListener): () => void {
  const job = activeJob;
  if (!job) return () => {};
  job.listeners.add(listener);
  listener({ ...job.status });
  return () => {
    job.listeners.delete(listener);
  };
}

function emit(job: BulkIndexJob, update: Partial<BulkIndexStatus>): void {
  job.status = { ...job.status, ...update };
  const snapshot = { ...job.status };
  for (const listener of job.listeners) {
    try {
      listener(snapshot);
    } catch (e) {
      Zotero.debug(`[seerai] RAG bulk: progress listener failed: ${e}`);
    }
  }
}

function startJob(
  initial: BulkIndexStatus,
  listener?: ProgressListener,
): BulkIndexJob {
  if (activeJob) {
    throw new Error("A bulk index is already running.");
  }
  let controller: AbortController | null = null;
  try {
    controller = createAbortController();
  } catch {
    // AbortController unavailable — cancellation still works between waves.
  }
  const job: BulkIndexJob = {
    cancelled: false,
    status: initial,
    listeners: new Set(),
    controller,
  };
  if (listener) job.listeners.add(listener);
  activeJob = job;
  return job;
}

// ─── Scope enumeration ───────────────────────────────────────────────────────

// Regular items = top-level non-note/non-attachment/non-annotation items that
// aren't in the trash. Mirrors the item-type filter used elsewhere in the
// codebase (e.g. placeholders.ts year facets).
const REGULAR_ITEM_PREDICATE = `i.itemTypeID NOT IN (
  SELECT itemTypeID FROM itemTypes
  WHERE typeName IN ('attachment', 'note', 'annotation')
)`;

// substr() rather than LIKE: Zotero's DB wrapper rejects LIKE clauses with
// inline (non-bound) patterns.
const INDEXABLE_ATTACHMENT_PREDICATE = `(ia.contentType = 'application/pdf' OR substr(ia.contentType, 1, 5) = 'text/')`;

const INDEXABLE_ITEM_IDS_SQL = `SELECT i.itemID FROM items i
  LEFT JOIN itemAttachments ia ON ia.itemID = i.itemID
  WHERE i.libraryID = ?
    AND i.itemID NOT IN (SELECT itemID FROM deletedItems)
    AND (${REGULAR_ITEM_PREDICATE} OR ${INDEXABLE_ATTACHMENT_PREDICATE})`;

const INDEXABLE_ITEM_COUNT_SQL = `SELECT COUNT(*) FROM items i
  LEFT JOIN itemAttachments ia ON ia.itemID = i.itemID
  WHERE i.libraryID = ?
    AND i.itemID NOT IN (SELECT itemID FROM deletedItems)
    AND (${REGULAR_ITEM_PREDICATE} OR ${INDEXABLE_ATTACHMENT_PREDICATE})`;

/** All collection IDs in a collection tree (root + descendants). */
async function getCollectionTreeIds(rootId: number): Promise<number[]> {
  const result: number[] = [];
  const seen = new Set<number>();
  const queue: number[] = [rootId];
  while (queue.length > 0) {
    const collectionId = queue.shift()!;
    if (seen.has(collectionId)) continue;
    seen.add(collectionId);
    result.push(collectionId);
    try {
      const collection = await Zotero.Collections.getAsync(collectionId);
      if (!collection) continue;
      await collection.loadDataType("childCollections");
      for (const childId of collection.getChildCollections(true) || []) {
        if (!seen.has(childId)) queue.push(childId);
      }
    } catch (e) {
      Zotero.debug(
        `[seerai] RAG bulk: failed to read subcollections of ${collectionId}: ${e}`,
      );
    }
  }
  return result;
}

async function enumerateCollectionItems(
  collectionId: number,
): Promise<number[]> {
  const seen = new Set<number>();
  const items: number[] = [];
  const collectionIds = await getCollectionTreeIds(collectionId);
  for (const id of collectionIds) {
    try {
      const collection = await Zotero.Collections.getAsync(id);
      if (!collection) continue;
      await collection.loadDataType("childItems");
      for (const itemId of collection.getChildItems(true)) {
        if (seen.has(itemId)) continue;
        seen.add(itemId);
        const item = await Zotero.Items.getAsync(itemId);
        if (isIndexableRegularItem(item)) {
          items.push(itemId);
          // A regular item's PDF/text attachments are their own searchable
          // units — cover all of them, not just the first PDF.
          for (const attId of await getIndexableAttachmentIdsAsync(item)) {
            if (seen.has(attId)) continue;
            seen.add(attId);
            items.push(attId);
          }
        } else if (isIndexableAttachment(item)) {
          items.push(itemId);
        }
      }
    } catch (e) {
      Zotero.debug(
        `[seerai] RAG bulk: failed to enumerate collection ${id}: ${e}`,
      );
    }
  }
  return items;
}

/**
 * All indexable items in a scope: regular items plus PDF/text attachments,
 * recursively for collections.
 */
export async function enumerateScopeItems(
  scope: BulkIndexScope,
): Promise<number[]> {
  if (scope.kind === "collection") {
    return enumerateCollectionItems(scope.id);
  }
  const rows = await Zotero.DB.columnQueryAsync<number>(
    INDEXABLE_ITEM_IDS_SQL,
    [scope.id],
  );
  return (rows || []).map((id) => Number(id));
}

/**
 * Count the items a scope enumerates (same universe as enumerateScopeItems),
 * so "indexed X of Y" reporting is consistent with what indexing covers.
 */
export async function countScopeItems(scope: BulkIndexScope): Promise<number> {
  if (scope.kind === "collection") {
    return (await enumerateCollectionItems(scope.id)).length;
  }
  const value = await Zotero.DB.valueQueryAsync<number>(
    INDEXABLE_ITEM_COUNT_SQL,
    [scope.id],
  );
  return value ? Number(value) : 0;
}

/**
 * Count regular items in a library without loading item objects. Kept for
 * callers that specifically want the regular-item count; prefer
 * countScopeItems() for coverage reporting.
 */
export async function countLibraryRegularItems(
  libraryId: number,
): Promise<number> {
  const value = await Zotero.DB.valueQueryAsync<number>(
    `SELECT COUNT(*) FROM items i
      WHERE i.libraryID = ?
        AND i.itemID NOT IN (SELECT itemID FROM deletedItems)
        AND ${REGULAR_ITEM_PREDICATE}`,
    [libraryId],
  );
  return value ? Number(value) : 0;
}

/**
 * Drop items whose vectors are already fresh for the configured embedding
 * pipeline and whose Zotero item hasn't been modified since indexing.
 * Cheap checks only (no content extraction) — content hashes are verified by
 * planIndexRun() during a bulk run.
 */
export async function filterItemsNeedingIndex(
  itemIds: number[],
  embeddingModel?: string,
  embeddingFingerprint?: string,
): Promise<number[]> {
  const store = getVectorStore();
  const service = getEmbeddingService();
  const model = embeddingModel ?? service.getConfiguredModel() ?? undefined;
  const fingerprint =
    embeddingFingerprint ?? service.getConfigFingerprint() ?? undefined;
  const pending: number[] = [];

  for (const itemId of itemIds) {
    try {
      const entry = await store.getIndexEntry(itemId);
      if (!entry) {
        pending.push(itemId);
        continue;
      }
      if (
        fingerprint &&
        entry.embeddingFingerprint &&
        entry.embeddingFingerprint !== fingerprint
      ) {
        pending.push(itemId);
        continue;
      }
      if (model && entry.embeddingModel && entry.embeddingModel !== model) {
        pending.push(itemId);
        continue;
      }
      const item = await Zotero.Items.getAsync(itemId);
      if (
        entry.lastModified &&
        item?.dateModified &&
        entry.lastModified !== item.dateModified
      ) {
        pending.push(itemId);
      }
    } catch (e) {
      Zotero.debug(
        `[seerai] RAG bulk: failed to check index state for ${itemId}: ${e}`,
      );
      pending.push(itemId);
    }
  }

  return pending;
}

interface PlannedItem {
  itemId: number;
  content?: RAGIndexContent;
  contentHash?: string;
}

/**
 * Decide what actually needs embedding. Skips entries that are fresh by
 * embedding identity + dateModified, and verifies with a content hash when the
 * item was modified (metadata-only edits don't change the text). Extracted
 * content is returned so the indexing pass doesn't extract twice.
 */
async function planIndexRun(
  itemIds: number[],
  contentExtractor: (itemId: number) => Promise<RAGIndexContent | null>,
  job: BulkIndexJob,
): Promise<{ planned: PlannedItem[]; skippedFresh: number }> {
  const store = getVectorStore();
  const service = getEmbeddingService();
  const model = service.getConfiguredModel() ?? undefined;
  const fingerprint = service.getConfigFingerprint() ?? undefined;
  const planned: PlannedItem[] = [];
  let skippedFresh = 0;

  for (const itemId of itemIds) {
    if (job.cancelled) break;
    try {
      const entry = await store.getIndexEntry(itemId);
      if (!entry) {
        planned.push({ itemId });
        continue;
      }

      const fingerprintChanged =
        !!fingerprint &&
        !!entry.embeddingFingerprint &&
        entry.embeddingFingerprint !== fingerprint;
      const modelChanged =
        !!model && !!entry.embeddingModel && entry.embeddingModel !== model;
      if (fingerprintChanged || modelChanged) {
        planned.push({ itemId });
        continue;
      }

      const item = await Zotero.Items.getAsync(itemId);
      const dateChanged =
        !entry.lastModified ||
        !item?.dateModified ||
        entry.lastModified !== item.dateModified;
      if (!dateChanged) {
        skippedFresh++;
        continue;
      }

      // dateModified moved — check whether the text actually changed before
      // spending embedding calls.
      const content = await contentExtractor(itemId);
      if (content) {
        const hash = ragContentHash(content);
        if (hash === entry.contentHash) {
          skippedFresh++;
          continue;
        }
        planned.push({ itemId, content, contentHash: hash });
      } else {
        planned.push({ itemId });
      }
    } catch (e) {
      Zotero.debug(`[seerai] RAG bulk: failed to plan item ${itemId}: ${e}`);
      planned.push({ itemId });
    }
  }

  return { planned, skippedFresh };
}

async function runBulkIndex(
  job: BulkIndexJob,
  itemIds: number[],
  scopeLabel: string | undefined,
): Promise<BulkIndexStatus> {
  const embeddingService = getEmbeddingService();
  if (!embeddingService.isConfigured()) {
    throw new Error(
      "No embedding model configured. Set one in Preferences > seerai > API Configuration before indexing.",
    );
  }

  emit(job, {
    phase: "indexing",
    total: itemIds.length,
    done: 0,
    indexed: 0,
    failed: 0,
    skipped: 0,
    scopeLabel,
  });

  // Loaded lazily: the Assistant module touches Zotero at import time, and
  // this keeps bulkIndexer importable from plain unit tests.
  const { Assistant } = await import("../../assistant");
  const contentExtractor = (itemId: number) =>
    Assistant.extractContentForRAG(itemId);

  const { planned, skippedFresh } = await planIndexRun(
    itemIds,
    contentExtractor,
    job,
  );
  Zotero.debug(
    `[seerai] RAG bulk: ${planned.length}/${itemIds.length} items need indexing, ` +
      `${skippedFresh} already fresh (${scopeLabel || "selection"})`,
  );

  const precomputed = new Map<number, RAGIndexContent>();
  for (const item of planned) {
    if (item.content) precomputed.set(item.itemId, item.content);
  }

  const options: BulkIndexOptions = {
    isCancelled: () => job.cancelled,
    signal: job.controller?.signal,
    precomputed,
    onProgress: (progress) =>
      emit(job, {
        ...progress,
        phase: "indexing",
        scopeLabel,
        done: progress.done + skippedFresh,
        skipped: progress.skipped + skippedFresh,
      }),
  };

  const progress = await indexItemsNow(
    planned.map((item) => item.itemId),
    contentExtractor,
    options,
  );

  emit(job, {
    ...progress,
    phase: job.cancelled ? "cancelled" : "done",
    scopeLabel,
    done: progress.done + skippedFresh,
    skipped: progress.skipped + skippedFresh,
  });
  return { ...job.status };
}

async function runScope(
  scope: BulkIndexScope,
  onProgress?: ProgressListener,
): Promise<BulkIndexStatus> {
  // Reserve the job before the first await so two concurrent starts can't both
  // pass the running check (previously the enumeration happened first).
  const job = startJob(
    {
      total: 0,
      done: 0,
      indexed: 0,
      failed: 0,
      skipped: 0,
      phase: "enumerating",
      scopeLabel: scope.label,
    },
    onProgress,
  );

  try {
    const itemIds = await enumerateScopeItems(scope);
    return await runBulkIndex(job, itemIds, scope.label);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    emit(job, { phase: "done", error: message });
    throw e;
  } finally {
    activeJob = null;
  }
}

/**
 * Pre-index every indexable item in a collection (recursively) or library.
 */
export async function indexScopeForRAG(
  scope: BulkIndexScope,
  onProgress?: ProgressListener,
): Promise<BulkIndexStatus> {
  return runScope(scope, onProgress);
}

/**
 * Pre-index an explicit list of items (e.g. a multi-selection in the item
 * pane). Regular items expand to their PDF/text attachments so all of their
 * documents are covered.
 */
export async function indexItemsForRAG(
  itemIds: number[],
  onProgress?: ProgressListener,
): Promise<BulkIndexStatus> {
  const label = `${itemIds.length} selected item(s)`;
  const job = startJob(
    {
      total: 0,
      done: 0,
      indexed: 0,
      failed: 0,
      skipped: 0,
      phase: "enumerating",
      scopeLabel: label,
    },
    onProgress,
  );

  try {
    const seen = new Set<number>();
    const regular: number[] = [];
    const add = (id: number) => {
      if (seen.has(id)) return;
      seen.add(id);
      regular.push(id);
    };

    for (const id of itemIds) {
      const item = await Zotero.Items.getAsync(id);
      if (isIndexableRegularItem(item)) {
        add(id);
        for (const attId of await getIndexableAttachmentIdsAsync(item)) {
          add(attId);
        }
      } else if (isIndexableAttachment(item)) {
        add(id);
      }
    }

    return await runBulkIndex(job, regular, label);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    emit(job, { phase: "done", error: message });
    throw e;
  } finally {
    activeJob = null;
  }
}

/** Human-readable one-line status for progress UIs. */
export function formatBulkIndexStatus(status: BulkIndexStatus): string {
  const parts: string[] = [];
  if (status.failed > 0) parts.push(`${status.failed} failed`);
  if (status.skipped > 0) parts.push(`${status.skipped} skipped`);
  const detail = parts.length > 0 ? ` (${parts.join(", ")})` : "";

  switch (status.phase) {
    case "enumerating":
      return `Scanning ${status.scopeLabel || "scope"}...`;
    case "indexing":
      return (
        `Indexing: ${status.done}/${status.total} processed${detail}` +
        (status.currentTitle ? ` — ${status.currentTitle}` : "")
      );
    case "cancelled":
      return `Indexing cancelled: ${status.indexed}/${status.total} indexed${detail}`;
    case "done":
      if (status.error) {
        return `Indexing failed: ${status.error}`;
      }
      return (
        `Indexing complete: ${status.indexed} indexed${detail}` +
        (status.total === 0 ? " — everything already up to date" : "")
      );
  }
}
