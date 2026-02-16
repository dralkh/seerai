/**
 * Read Tool Implementation
 * Reads item metadata and content from Zotero
 */

import {
  GetItemMetadataParams,
  GetItemMetadataResult,
  ReadItemContentParams,
  ReadItemContentResult,
  ToolResult,
  AgentConfig,
} from "./toolTypes";
import { Assistant } from "../../assistant";

/**
 * Execute get_item_metadata tool
 */
export async function executeGetItemMetadata(
  params: GetItemMetadataParams,
  config: AgentConfig,
): Promise<ToolResult> {
  try {
    const { item_id } = params;
    Zotero.debug(`[seerai] Tool: get_item_metadata id=${item_id}`);

    const item = Zotero.Items.get(item_id);
    if (!item) {
      return {
        success: false,
        error: `Item with ID ${item_id} not found`,
      };
    }

    // Verify scope permission
    if (!Assistant.checkItemInScope(item, config)) {
      return {
        success: false,
        error: `Permission Denied: Item ${item_id} is outside the current restricted scope.`,
      };
    }

    // Get creators
    const creators = item.getCreators().map((c: any) => ({
      firstName: c.firstName || "",
      lastName: c.lastName || c.name || "",
      creatorType: c.creatorType || "author",
    }));

    // Get tags
    const tags = item.getTags().map((t: any) => t.tag);

    // Get collections
    const collectionIDs = item.getCollections();
    const collections: string[] = [];
    for (const collId of collectionIDs) {
      const coll = Zotero.Collections.get(collId);
      if (coll) {
        collections.push(coll.name);
      }
    }

    // Check for PDF attachment
    const attachments = item.getAttachments();
    let hasPdf = false;
    for (const attId of attachments) {
      const att = Zotero.Items.get(attId);
      if (att && att.attachmentContentType === "application/pdf") {
        hasPdf = true;
        break;
      }
    }

    // Count notes
    const noteIDs = item.getNotes();
    const notesCount = noteIDs.length;

    const result: GetItemMetadataResult = {
      id: item.id,
      title: (item.getField("title") || "Untitled") as string,
      authors: creators,
      year: (item.getField("year") ||
        item.getField("date")?.toString().substring(0, 4) ||
        "") as string,
      abstract: (item.getField("abstractNote") || "") as string,
      doi: (item.getField("DOI") || undefined) as string | undefined,
      url: (item.getField("url") || undefined) as string | undefined,
      publication: (item.getField("publicationTitle") ||
        item.getField("bookTitle") ||
        undefined) as string | undefined,
      volume: (item.getField("volume") || undefined) as string | undefined,
      issue: (item.getField("issue") || undefined) as string | undefined,
      pages: (item.getField("pages") || undefined) as string | undefined,
      tags,
      collections,
      item_type: item.itemType,
      date_added: item.dateAdded,
      date_modified: item.dateModified,
      has_pdf: hasPdf,
      notes_count: notesCount,
    };

    return {
      success: true,
      data: result,
      summary: `Retrieved metadata for "${result.title}"`,
    };
  } catch (error) {
    Zotero.debug(`[seerai] Tool: get_item_metadata error: ${error}`);
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Execute read_item_content tool
 * Uses the existing getPdfTextForItem function via dynamic import
 */
export async function executeReadItemContent(
  params: ReadItemContentParams,
  config: AgentConfig,
): Promise<ToolResult> {
  try {
    const {
      item_id,
      include_notes = true,
      include_pdf = true,
      max_length,
      trigger_ocr,
    } = params;

    Zotero.debug(`[seerai] Tool: read_item_content id=${item_id}`);

    const item = Zotero.Items.get(item_id);
    if (!item) {
      return {
        success: false,
        error: `Item with ID ${item_id} not found`,
      };
    }

    // Verify scope permission
    if (!Assistant.checkItemInScope(item, config)) {
      return {
        success: false,
        error: `Permission Denied: Item ${item_id} is outside the current restricted scope.`,
      };
    }

    let content = "";
    let sourceType: ReadItemContentResult["source_type"] = "metadata_only";

    // Handle standalone notes
    if (item.itemType === "note") {
      const noteHTML = item.getNote();
      content = noteHTML
        .replace(/<[^>]*>/g, " ")
        .replace(/\s+/g, " ")
        .trim();

      return {
        success: true,
        data: {
          content,
          source_type: "notes",
          notes_count: 1,
          content_length: content.length,
          truncated:
            (max_length || config.maxContentLength) > 0 &&
            content.length >= (max_length || config.maxContentLength),
        },
        summary: `Read content from standalone note "${item.getNoteTitle() || "Untitled Note"}"`,
      };
    }

    if (!item.isRegularItem()) {
      return {
        success: false,
        error: `Item ${item_id} is not a regular item or note (it's a ${item.itemType})`,
      };
    }

    // Use Assistant's unified logic for content extraction for regular items
    const notesCount = item.getNotes().length;

    const extractedText = await Assistant.getPdfTextForItem(
      item,
      max_length || config.maxContentLength,
      true, // autoIndex
      include_notes,
    );

    if (extractedText) {
      content = extractedText;
      sourceType = item.getNotes().length > 0 ? "notes" : "indexed_pdf";
    }

    // OCR Fallback if requested (explicitly or via global setting) and no text found
    if (
      (!content || content.trim().length < 100) &&
      (trigger_ocr || config.autoOcr) &&
      include_pdf
    ) {
      Zotero.debug(
        `[seerai] No content found, triggering OCR for item ${item.id}`,
      );
      const ocrService = Assistant.getOcrService();
      const pdf = ocrService.getFirstPdfAttachment(item);
      if (pdf) {
        await ocrService.convertToMarkdown(pdf, { showProgress: false });
        // Wait briefly for note to save
        await new Promise((r) => setTimeout(r, 1000));

        // Retry getting text
        const ocrText = await Assistant.getPdfTextForItem(
          item,
          max_length || config.maxContentLength,
          true,
          true,
        );
        if (ocrText) {
          content = ocrText;
          sourceType = "notes"; // OCR creates a note
        }
      }
    }

    // Final fallback to metadata
    if (!content || content.trim().length === 0) {
      const abstract = item.getField("abstractNote");
      const title = item.getField("title");
      const creators = item
        .getCreators()
        .map((c: any) =>
          `${c.firstName || ""} ${c.lastName || c.name || ""}`.trim(),
        )
        .join(", ");

      content = `Title: ${title}\nAuthors: ${creators}\n`;
      if (abstract) {
        content += `Abstract: ${abstract}`;
      } else {
        content += "(No abstract available)";
      }
      sourceType = "metadata_only";
    }

    const result: ReadItemContentResult = {
      content,
      source_type: sourceType,
      notes_count: item.getNotes().length,
      content_length: content.length,
      truncated:
        (max_length || config.maxContentLength) > 0 &&
        content.length >= (max_length || config.maxContentLength),
    };

    return {
      success: true,
      data: result,
      summary: `Read ${content.length} chars from ${sourceType}`,
    };
  } catch (error) {
    Zotero.debug(`[seerai] Tool: read_item_content error: ${error}`);
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
