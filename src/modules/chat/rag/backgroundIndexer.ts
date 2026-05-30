/**
 * Background Indexer for on-demand indexing of newly added/modified items.
 *
 * Listens for Zotero item add/modify events and queues items for background
 * indexing. Processes one item at a time with a 5-second gap to avoid
 * flooding the embedding API.
 *
 * Pending items persist via a JSON file in the vectors directory
 * so they survive plugin restarts without triggering pref-size warnings.
 */

import { config } from "../../../../package.json";
import { getEmbeddingService } from "./embeddingService";
import { chunkPaperContent } from "./chunker";
import { getVectorStore, VectorStore } from "./vectorStore";
import { getRAGConfig } from "./retrievalEngine";

const PENDING_FILE_NAME = "_pending.json";
const PROCESS_GAP_MS = 5000;

const pendingQueue: number[] = [];
const enqueuedIds = new Set<number>();
let processing = false;
let intervalId: ReturnType<typeof setInterval> | null = null;

function getPendingPath(): string {
  return PathUtils.join(
    Zotero.DataDirectory.dir,
    config.addonRef,
    "vectors",
    PENDING_FILE_NAME,
  );
}

async function restorePendingFromFile(): Promise<void> {
  try {
    const path = getPendingPath();
    if (await IOUtils.exists(path)) {
      const raw = await IOUtils.readUTF8(path);
      if (raw && raw.trim()) {
        const ids: number[] = JSON.parse(raw);
        for (const id of ids) {
          if (!enqueuedIds.has(id)) {
            pendingQueue.push(id);
            enqueuedIds.add(id);
          }
        }
        Zotero.debug(
          `[seerai] BG Indexer: restored ${pendingQueue.length} pending items from file`,
        );
      }
    }
  } catch {
    Zotero.debug("[seerai] BG Indexer: no pending file (first run)");
  }
}

async function savePendingToFile(): Promise<void> {
  try {
    const path = getPendingPath();
    const dir = PathUtils.parent(path);
    if (dir && !(await IOUtils.exists(dir))) {
      await IOUtils.makeDirectory(dir, { ignoreExisting: true });
    }
    await IOUtils.writeUTF8(path, JSON.stringify(pendingQueue));
  } catch (e) {
    Zotero.debug(`[seerai] BG Indexer: failed to save pending file: ${e}`);
  }
}

export function enqueueForIndexing(itemId: number): void {
  if (enqueuedIds.has(itemId)) return;
  pendingQueue.push(itemId);
  enqueuedIds.add(itemId);
  savePendingToFile();
  Zotero.debug(
    `[seerai] BG Indexer: enqueued item ${itemId} (${pendingQueue.length} pending)`,
  );
}

async function processNext(): Promise<void> {
  if (pendingQueue.length === 0 || processing) return;

  processing = true;
  const itemId = pendingQueue.shift()!;
  enqueuedIds.delete(itemId);
  savePendingToFile();

  try {
    const embeddingService = getEmbeddingService();
    if (!embeddingService.isConfigured()) {
      Zotero.debug("[seerai] BG Indexer: embedding not configured, skipping");
      return;
    }

    const ragConfig = getRAGConfig();
    const { Assistant } = await import("../../assistant");

    const content = await Assistant.extractContentForRAG(itemId);
    if (!content) {
      Zotero.debug(
        `[seerai] BG Indexer: no content for item ${itemId}, skipping`,
      );
      return;
    }

    const contentHash = VectorStore.contentHash(
      (content.abstract || "") +
        (content.notes?.join("") || "") +
        (content.pdfText || ""),
    );

    const vectorStore = getVectorStore();

    const { chunks, parentWindows } = chunkPaperContent(itemId, content, {
      chunkSize: ragConfig.chunkSize,
      chunkOverlap: ragConfig.chunkOverlap,
    });

    if (chunks.length === 0) {
      Zotero.debug(
        `[seerai] BG Indexer: no chunks for item ${itemId}, skipping`,
      );
      return;
    }

    const texts = chunks.map((c) => c.text);
    const embeddings = await embeddingService.getEmbeddings(texts);

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
      `[seerai] BG Indexer: indexed item ${itemId} ` +
        `(${chunks.length} chunks, model=${model})`,
    );
  } catch (e) {
    Zotero.debug(`[seerai] BG Indexer: failed to index item ${itemId}: ${e}`);
  } finally {
    processing = false;
  }
}

export async function startBackgroundIndexer(): Promise<void> {
  if (intervalId) return;
  await restorePendingFromFile();
  Zotero.debug("[seerai] BG Indexer: started");

  // Migrate legacy pref-stored pending items if any exist
  try {
    const legacyRaw = Zotero.Prefs.get(
      `${config.prefsPrefix}.ragPendingIndexIds`,
    ) as string;
    if (legacyRaw) {
      const legacyIds: number[] = JSON.parse(legacyRaw);
      for (const id of legacyIds) {
        if (!enqueuedIds.has(id)) {
          pendingQueue.push(id);
          enqueuedIds.add(id);
        }
      }
      if (legacyIds.length > 0) {
        Zotero.debug(
          `[seerai] BG Indexer: migrated ${legacyIds.length} legacy pending items from prefs`,
        );
        await savePendingToFile();
        try {
          Zotero.Prefs.clear(`${config.prefsPrefix}.ragPendingIndexIds`);
        } catch {
          // ignore clear errors
        }
      }
    }
  } catch {
    // No legacy prefs
  }

  // Process one item immediately, then poll every 5s
  processNext();
  intervalId = setInterval(processNext, PROCESS_GAP_MS);
}

export function stopBackgroundIndexer(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
  Zotero.debug("[seerai] BG Indexer: stopped");
}

export function getPendingCount(): number {
  return pendingQueue.length;
}
