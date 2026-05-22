/**
 * Image utilities for multimodal vision model support
 * Handles detection of image attachments and base64 encoding
 */

import { VisionMessageContentPart } from "../openai";

// Supported image MIME types for vision models
const SUPPORTED_IMAGE_TYPES = [
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/gif",
  "image/webp",
];

/**
 * Check if an attachment is a supported image type
 */
export function isImageAttachment(attachment: Zotero.Item): boolean {
  if (!attachment.isAttachment()) return false;

  const contentType = attachment.attachmentContentType;
  return SUPPORTED_IMAGE_TYPES.includes(contentType?.toLowerCase() || "");
}

/**
 * Get all image attachments from a Zotero item
 */
export async function getImageAttachments(
  item: Zotero.Item,
): Promise<Zotero.Item[]> {
  const images: Zotero.Item[] = [];

  // Get parent item if this is an attachment
  let targetItem = item;
  if (item.isAttachment() && item.parentID) {
    const parent = Zotero.Items.get(item.parentID);
    if (parent) targetItem = parent as Zotero.Item;
  }

  // Get all attachments
  const attachmentIDs = targetItem.getAttachments();
  for (const attachmentID of attachmentIDs) {
    const attachment = Zotero.Items.get(attachmentID);
    if (attachment && isImageAttachment(attachment)) {
      images.push(attachment);
    }
  }

  // Also check if the item itself is an image attachment
  if (isImageAttachment(item)) {
    images.push(item);
  }

  return images;
}

/**
 * Strip base64-encoded data URIs from text content
 * Handles markdown images, HTML img tags, and inline data URIs
 */
export function stripBase64Data(text: string): string {
  if (!text || text.length < 100) return text;

  let stripped = text;
  let totalRemoved = 0;

  // 1. Remove markdown image tags with base64 data URIs
  //    ![alt](data:image/png;base64,...)
  const mdImgRegex = /!\[.*?\]\(.*?data:[^;]+;base64,[A-Za-z0-9+/=]+.*?\)/g;
  const mdMatches = stripped.match(mdImgRegex);
  if (mdMatches) {
    const removed = mdMatches.reduce((s, m) => s + m.length, 0);
    stripped = stripped.replace(mdImgRegex, "");
    totalRemoved += removed;
  }

  // 2. Remove HTML img tags with base64 data URIs
  //    <img src="data:image/png;base64,..." ...>
  const htmlImgRegex = /<img[^>]*src\s*=\s*"data:[^"]*;base64,[^"]*"[^>]*>/gi;
  const htmlMatches = stripped.match(htmlImgRegex);
  if (htmlMatches) {
    const removed = htmlMatches.reduce((s, m) => s + m.length, 0);
    stripped = stripped.replace(htmlImgRegex, "");
    totalRemoved += removed;
  }

  // 3. Remove standalone base64 data URIs (longer than 100 chars)
  //    data:image/png;base64,ABCD...
  const dataUriRegex = /data:[^;]+;base64,[A-Za-z0-9+/=]{100,}/g;
  const uriMatches = stripped.match(dataUriRegex);
  if (uriMatches) {
    const removed = uriMatches.reduce((s, m) => s + m.length, 0);
    stripped = stripped.replace(dataUriRegex, "[base64 image data removed]");
    totalRemoved += removed;
  }

  if (totalRemoved > 0) {
    Zotero.debug(
      `[seerai] Stripped ${totalRemoved} bytes of base64 image data from content`,
    );
  }

  return stripped;
}

/**
 * Read file and encode as base64
 */
export async function encodeImageAsBase64(
  attachment: Zotero.Item,
): Promise<string | null> {
  try {
    const filePath = await attachment.getFilePathAsync();
    if (!filePath) {
      Zotero.debug(`[seerai] No file path for attachment ${attachment.id}`);
      return null;
    }

    // Read file as bytes
    const fileBytes = await IOUtils.read(filePath);

    // Convert to base64
    const binaryString = Array.from(fileBytes)
      .map((byte) => String.fromCharCode(byte))
      .join("");
    const base64 = btoa(binaryString);

    return base64;
  } catch (e) {
    Zotero.debug(`[seerai] Error encoding image: ${e}`);
    return null;
  }
}

/**
 * Create vision message content parts from image attachments
 */
export async function createImageContentParts(
  items: Zotero.Item[],
  maxImages: number = 5,
): Promise<VisionMessageContentPart[]> {
  const parts: VisionMessageContentPart[] = [];
  let imageCount = 0;

  for (const item of items) {
    if (imageCount >= maxImages) break;

    const images = await getImageAttachments(item);

    for (const image of images) {
      if (imageCount >= maxImages) break;

      const base64 = await encodeImageAsBase64(image);
      if (base64) {
        const contentType = image.attachmentContentType || "image/jpeg";
        parts.push({
          type: "image_url",
          image_url: {
            url: `data:${contentType};base64,${base64}`,
            detail: "auto", // Let API decide optimal resolution
          },
        });
        imageCount++;
        Zotero.debug(`[seerai] Added image: ${image.attachmentFilename}`);
      }
    }
  }

  return parts;
}

/**
 * Count total images across items
 */
export async function countImageAttachments(
  items: Zotero.Item[],
): Promise<number> {
  let count = 0;
  for (const item of items) {
    const images = await getImageAttachments(item);
    count += images.length;
  }
  return count;
}
