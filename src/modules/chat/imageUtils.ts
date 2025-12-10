/**
 * Image utilities for multimodal vision model support
 * Handles detection of image attachments and base64 encoding
 */

import { VisionMessageContentPart } from "../openai";

// Supported image MIME types for vision models
const SUPPORTED_IMAGE_TYPES = [
    'image/jpeg',
    'image/jpg',
    'image/png',
    'image/gif',
    'image/webp'
];

/**
 * Check if an attachment is a supported image type
 */
export function isImageAttachment(attachment: Zotero.Item): boolean {
    if (!attachment.isAttachment()) return false;

    const contentType = attachment.attachmentContentType;
    return SUPPORTED_IMAGE_TYPES.includes(contentType?.toLowerCase() || '');
}

/**
 * Get all image attachments from a Zotero item
 */
export async function getImageAttachments(item: Zotero.Item): Promise<Zotero.Item[]> {
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
 * Read file and encode as base64
 */
export async function encodeImageAsBase64(attachment: Zotero.Item): Promise<string | null> {
    try {
        const filePath = await attachment.getFilePathAsync();
        if (!filePath) {
            Zotero.debug(`[Seer AI] No file path for attachment ${attachment.id}`);
            return null;
        }

        // Read file as bytes
        const fileBytes = await IOUtils.read(filePath);

        // Convert to base64
        const binaryString = Array.from(fileBytes)
            .map(byte => String.fromCharCode(byte))
            .join('');
        const base64 = btoa(binaryString);

        return base64;
    } catch (e) {
        Zotero.debug(`[Seer AI] Error encoding image: ${e}`);
        return null;
    }
}

/**
 * Create vision message content parts from image attachments
 */
export async function createImageContentParts(
    items: Zotero.Item[],
    maxImages: number = 5
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
                const contentType = image.attachmentContentType || 'image/jpeg';
                parts.push({
                    type: "image_url",
                    image_url: {
                        url: `data:${contentType};base64,${base64}`,
                        detail: "auto"  // Let API decide optimal resolution
                    }
                });
                imageCount++;
                Zotero.debug(`[Seer AI] Added image: ${image.attachmentFilename}`);
            }
        }
    }

    return parts;
}

/**
 * Count total images across items
 */
export async function countImageAttachments(items: Zotero.Item[]): Promise<number> {
    let count = 0;
    for (const item of items) {
        const images = await getImageAttachments(item);
        count += images.length;
    }
    return count;
}
