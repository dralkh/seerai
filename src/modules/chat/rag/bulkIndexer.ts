/**
 * Bulk RAG indexing for collections and libraries.
 *
 * The retrieval engine indexes items lazily, only when they are part of a
 * chat's context. This module lets the user pre-build vectors for a whole
 * collection or library, with progress reporting and cancellation, using the
 * exact same indexing pipeline as on-demand RAG.
 */

import { getEmbeddingService } from "./embeddingService";
import { getVectorStore } from "./vectorStore";
import {
  indexItemsNow,
  type BulkIndexProgress,
  type BulkIndexOptions,
} from "./retrievalEngine";

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

let activeRun: { cancel: () => void } | null = null;

/** Cancel the currently running bulk index, if any. */
export function cancelBulkIndex(): void {
  activeRun?.cancel();
}

export function isBulkIndexRunning(): boolean {
  return activeRun !== null;
}

/**
 * All regular (non-attachment, non-note, non-deleted) items in a scope.
 */
export async function enumerateScopeItems(
  scope: BulkIndexScope,
): Promise<number[]> {
  if (scope.kind === "collection") {
    const collection = Zotero.Collections.get(scope.id);
    if (!collection) return [];
    const seen = new Set<number>();
    const regular: number[] = [];
    for (const id of collection.getChildItems(true)) {
      if (seen.has(id)) continue;
      seen.add(id);
      const item = Zotero.Items.get(id);
      if (!item || !item.isRegularItem() || item.deleted) continue;
      regular.push(id);
    }
    return regular;
  }

  // Library scope: resolve regular items at the DB level so a large library
  // doesn't require loading every item object.
  const rows = await Zotero.DB.columnQueryAsync<number>(REGULAR_ITEM_IDS_SQL, [
    scope.id,
  ]);
  return (rows || []).map((id) => Number(id));
}

// Regular items = top-level non-note/non-attachment/non-annotation items that
// aren't in the trash. Mirrors the item-type filter used elsewhere in the
// codebase (e.g. placeholders.ts year facets).
const REGULAR_ITEM_IDS_SQL = `SELECT i.itemID FROM items i
  WHERE i.libraryID = ?
    AND i.itemID NOT IN (SELECT itemID FROM deletedItems)
    AND i.itemTypeID NOT IN (
      SELECT itemTypeID FROM itemTypes
      WHERE typeName IN ('attachment', 'note', 'annotation')
    )`;

/**
 * Count regular items in a library (same definition as enumerateScopeItems)
 * without loading item objects.
 */
export async function countLibraryRegularItems(
  libraryId: number,
): Promise<number> {
  const value = await Zotero.DB.valueQueryAsync<number>(
    `SELECT COUNT(*) FROM items i
      WHERE i.libraryID = ?
        AND i.itemID NOT IN (SELECT itemID FROM deletedItems)
        AND i.itemTypeID NOT IN (
          SELECT itemTypeID FROM itemTypes
          WHERE typeName IN ('attachment', 'note', 'annotation')
        )`,
    [libraryId],
  );
  return value ? Number(value) : 0;
}

/**
 * Drop items whose vectors are already fresh for the configured embedding
 * model and whose Zotero item hasn't been modified since indexing.
 */
export async function filterItemsNeedingIndex(
  itemIds: number[],
  embeddingModel?: string,
): Promise<number[]> {
  const store = getVectorStore();
  const model =
    embeddingModel ?? getEmbeddingService().getConfiguredModel() ?? undefined;
  const pending: number[] = [];

  for (const itemId of itemIds) {
    try {
      const entry = await store.getIndexEntry(itemId);
      if (!entry) {
        pending.push(itemId);
        continue;
      }
      if (model && entry.embeddingModel && entry.embeddingModel !== model) {
        pending.push(itemId);
        continue;
      }
      const item = Zotero.Items.get(itemId);
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

async function runBulkIndex(
  itemIds: number[],
  scopeLabel: string | undefined,
  onProgress?: ProgressListener,
): Promise<BulkIndexStatus> {
  const embeddingService = getEmbeddingService();
  if (!embeddingService.isConfigured()) {
    throw new Error(
      "No embedding model configured. Set one in Preferences > seerai > API Configuration before indexing.",
    );
  }

  let cancelled = false;
  activeRun = { cancel: () => (cancelled = true) };

  try {
    const pending = await filterItemsNeedingIndex(itemIds);
    Zotero.debug(
      `[seerai] RAG bulk: ${pending.length}/${itemIds.length} items need indexing ` +
        `(${scopeLabel || "selection"})`,
    );

    const options: BulkIndexOptions = {
      isCancelled: () => cancelled,
      onProgress: (progress) =>
        onProgress?.({ ...progress, phase: "indexing", scopeLabel }),
    };

    // Loaded lazily: the Assistant module touches Zotero at import time, and
    // this keeps bulkIndexer importable from plain unit tests.
    const { Assistant } = await import("../../assistant");
    const progress = await indexItemsNow(
      pending,
      Assistant.extractContentForRAG,
      options,
    );

    const status: BulkIndexStatus = {
      ...progress,
      phase: cancelled ? "cancelled" : "done",
      scopeLabel,
    };
    onProgress?.(status);
    return status;
  } finally {
    activeRun = null;
  }
}

/**
 * Pre-index every regular item in a collection or library.
 */
export async function indexScopeForRAG(
  scope: BulkIndexScope,
  onProgress?: ProgressListener,
): Promise<BulkIndexStatus> {
  if (activeRun) {
    throw new Error("A bulk index is already running.");
  }

  onProgress?.({
    total: 0,
    done: 0,
    indexed: 0,
    failed: 0,
    skipped: 0,
    phase: "enumerating",
    scopeLabel: scope.label,
  });

  const itemIds = await enumerateScopeItems(scope);
  return runBulkIndex(itemIds, scope.label, onProgress);
}

/**
 * Pre-index an explicit list of items (e.g. a multi-selection in the item
 * pane).
 */
export async function indexItemsForRAG(
  itemIds: number[],
  onProgress?: ProgressListener,
): Promise<BulkIndexStatus> {
  if (activeRun) {
    throw new Error("A bulk index is already running.");
  }

  const seen = new Set<number>();
  const regular: number[] = [];
  for (const id of itemIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    const item = Zotero.Items.get(id);
    const indexable =
      item &&
      !item.deleted &&
      (item.isRegularItem() ||
        (item.isAttachment() &&
          (item.attachmentContentType === "application/pdf" ||
            (item.attachmentContentType || "").startsWith("text/"))));
    if (indexable) regular.push(id);
  }

  return runBulkIndex(
    regular,
    `${regular.length} selected item(s)`,
    onProgress,
  );
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
      return (
        `Indexing complete: ${status.indexed} indexed${detail}` +
        (status.total === 0 ? " — everything already up to date" : "")
      );
  }
}
