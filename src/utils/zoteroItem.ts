/**
 * Guards for Zotero item APIs that throw on attachment/note items.
 *
 * Zotero throws "getAttachments()/getNotes() cannot be called on attachment
 * items" when these are invoked on a child item. Context selection and RAG
 * routinely surface attachment IDs (PDFs are first-class searchable units), so
 * every caller that may receive one needs a regular-item guard.
 */

export function getChildAttachmentIds(
  item: Zotero.Item | false | null | undefined,
): number[] {
  if (!item || !item.isRegularItem()) return [];
  try {
    return item.getAttachments() || [];
  } catch {
    return [];
  }
}

export function getChildNoteIds(
  item: Zotero.Item | false | null | undefined,
): number[] {
  if (!item || !item.isRegularItem()) return [];
  try {
    return item.getNotes() || [];
  } catch {
    return [];
  }
}

/** Parent title for an attachment (used when borrowing metadata). */
export function getParentItemTitle(item: Zotero.Item): string | undefined {
  if (!item.isAttachment()) return undefined;
  const parentId = item.parentItemID;
  if (!parentId) return undefined;
  const parent = Zotero.Items.get(parentId);
  return parent ? (parent.getField("title") as string) || undefined : undefined;
}
