/**
 * Shared definition of "indexable item" for the RAG pipeline.
 *
 * A searchable unit is either:
 *   - a regular item (abstract, notes, metadata), or
 *   - an attachment whose extracted text is meaningful (PDF or plain text).
 *
 * Parent items with PDF/text attachments contribute metadata/notes, while each
 * attachment is indexed separately so every PDF of a multi-PDF book is
 * searchable. Keeping this in one module keeps bulk enumeration, search
 * scoping, coverage counts, and on-demand indexing in agreement.
 */

export function isIndexableAttachmentContentType(
  contentType: string | undefined | null,
): boolean {
  if (!contentType) return false;
  return contentType === "application/pdf" || contentType.startsWith("text/");
}

export function isIndexableAttachment(
  item: Zotero.Item | false | null | undefined,
): boolean {
  if (!item || !item.isAttachment() || item.deleted) return false;
  return isIndexableAttachmentContentType(item.attachmentContentType);
}

export function isIndexableRegularItem(
  item: Zotero.Item | false | null | undefined,
): boolean {
  return !!item && item.isRegularItem() && !item.deleted;
}

/** Whether an item is a searchable RAG unit in any scope. */
export function isIndexableItem(
  item: Zotero.Item | false | null | undefined,
): boolean {
  return isIndexableRegularItem(item) || isIndexableAttachment(item);
}

/**
 * Synchronously resolve a regular item's indexable attachment IDs.
 * Unloaded attachments are skipped — use the async variant when certainty
 * matters (bulk indexing, search scoping).
 */
export function getIndexableAttachmentIds(item: Zotero.Item): number[] {
  if (!item?.isRegularItem()) return [];
  const ids: number[] = [];
  for (const attId of item.getAttachments()) {
    try {
      if (isIndexableAttachment(Zotero.Items.get(attId))) ids.push(attId);
    } catch {
      // Unloaded item — skip.
    }
  }
  return ids;
}

/** Async variant that loads unloaded attachments before testing them. */
export async function getIndexableAttachmentIdsAsync(
  item: Zotero.Item,
): Promise<number[]> {
  if (!item?.isRegularItem()) return [];
  const ids: number[] = [];
  for (const attId of item.getAttachments()) {
    try {
      if (isIndexableAttachment(await Zotero.Items.getAsync(attId))) {
        ids.push(attId);
      }
    } catch {
      // Ignore unloadable attachments.
    }
  }
  return ids;
}
