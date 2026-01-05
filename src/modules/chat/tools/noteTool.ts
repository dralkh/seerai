/**
 * Note Tool Implementation
 * Creates notes attached to Zotero items
 */

import {
    CreateNoteParams,
    CreateNoteResult,
    EditNoteParams,
    EditNoteResult,
    EditNoteOperation,
    NoteParams,
    ToolResult,
    AgentConfig,
} from "./toolTypes";

/**
 * Unified note tool dispatcher
 * Routes to create or edit actions
 */
export async function executeNote(
    params: NoteParams,
    config: AgentConfig
): Promise<ToolResult> {
    Zotero.debug(`[seerai] Tool: note action=${params.action}`);

    switch (params.action) {
        case "create":
            return executeCreateNote({
                parent_item_id: params.parent_item_id,
                collection_id: params.collection_id,
                title: params.title!,
                content: params.content!,
                tags: params.tags,
            }, config);
        case "edit":
            return executeEditNote({
                note_id: params.note_id!,
                operations: params.operations!,
                convert_markdown: params.convert_markdown,
            }, config);
        default:
            return { success: false, error: `Unknown note action: ${(params as any).action}` };
    }
}

/**
 * Convert markdown to HTML for Zotero notes
 */
function markdownToHtml(markdown: string): string {
    if (!markdown) return "";

    const lines = markdown.split("\n");
    const htmlParts: string[] = [];
    let inList = false;
    let listType: "ul" | "ol" = "ul";

    const flushList = () => {
        if (inList) {
            htmlParts.push(`</${listType}>`);
            inList = false;
        }
    };

    const parseInline = (text: string) => {
        return text
            .replace(/\*\*\*(.*?)\*\*\*/g, "<strong><em>$1</em></strong>")
            .replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>")
            .replace(/\*(.*?)\*/g, "<em>$1</em>")
            .replace(/`(.*?)`/g, "<code>$1</code>");
    };

    for (let line of lines) {
        const trimmed = line.trim();

        if (trimmed === "") {
            // If in list, don't flush yet, but don't add break either
            // This allows the next list item to keep the same list group
            if (!inList) {
                htmlParts.push("<br/>");
            }
            continue;
        }

        // Headers
        const headerMatch = line.match(/^(#{1,6})\s+(.*)$/);
        if (headerMatch) {
            flushList();
            const level = headerMatch[1].length;
            htmlParts.push(`<h${level}>${parseInline(headerMatch[2])}</h${level}>`);
            continue;
        }

        // Unordered List (- or *)
        const ulMatch = line.match(/^[\s]*[-*]\s+(.*)$/);
        if (ulMatch) {
            if (!inList || listType !== "ul") {
                flushList();
                htmlParts.push("<ul>");
                inList = true;
                listType = "ul";
            }
            htmlParts.push(`<li>${parseInline(ulMatch[1])}</li>`);
            continue;
        }

        // Ordered List (1. or 1))
        const olMatch = line.match(/^[\s]*\d+[\.\)]\s+(.*)$/);
        if (olMatch) {
            if (!inList || listType !== "ol") {
                flushList();
                htmlParts.push("<ol>");
                inList = true;
                listType = "ol";
            }
            htmlParts.push(`<li>${parseInline(olMatch[1])}</li>`);
            continue;
        }

        // Horizontal Rule
        if (trimmed === "---" || trimmed === "***") {
            flushList();
            htmlParts.push("<hr/>");
            continue;
        }

        // Regular text
        flushList();
        htmlParts.push(`<p>${parseInline(line)}</p>`);
    }

    flushList();
    return htmlParts.join("");
}


/**
 * Execute create_note tool
 */
export async function executeCreateNote(
    params: CreateNoteParams,
    _config: AgentConfig
): Promise<ToolResult> {
    try {
        const { parent_item_id, collection_id, title, content, tags } = params;

        if (!parent_item_id && !collection_id) {
            return {
                success: false,
                error: "Either parent_item_id or collection_id must be provided",
            };
        }

        Zotero.debug(`[seerai] Tool: create_note parent=${parent_item_id} col=${collection_id} title="${title}"`);

        let libraryID: number | undefined;
        let parentID: number | undefined;

        if (parent_item_id) {
            // Verify parent item exists
            const parentItem = Zotero.Items.get(parent_item_id as number);
            if (!parentItem) {
                return {
                    success: false,
                    error: `Parent item with ID ${parent_item_id} not found`,
                };
            }

            if (!parentItem.isRegularItem()) {
                return {
                    success: false,
                    error: `Item ${parent_item_id} is not a regular item`,
                };
            }
            libraryID = parentItem.libraryID;
            parentID = parentItem.id;
        } else if (collection_id) {
            // Verify collection exists
            const collection = Zotero.Collections.get(collection_id);
            if (!collection) {
                return {
                    success: false,
                    error: `Collection with ID ${collection_id} not found`,
                };
            }
            libraryID = collection.libraryID;
        }

        // Convert content to HTML if it looks like markdown
        let htmlContent = content;
        if (!content.trim().startsWith("<")) {
            htmlContent = markdownToHtml(content);
        }

        // Add title as first heading only if it's not already at the start of htmlContent
        const lowerHtml = htmlContent.toLowerCase();
        const lowerTitle = title.toLowerCase();

        // Basic check to avoid duplicate titles
        if (!lowerHtml.includes(`<h1>${lowerTitle}`) && !lowerHtml.includes(`<h2>${lowerTitle}`) && !lowerHtml.includes(`<strong>${lowerTitle}`)) {
            htmlContent = `<h1>${title}</h1>${htmlContent}`;
        }

        // Create note
        const note = new Zotero.Item("note");
        if (libraryID !== undefined) note.libraryID = libraryID;
        if (parentID !== undefined) note.parentID = parentID;

        note.setNote(htmlContent);

        // Add tags if provided
        if (tags && tags.length > 0) {
            for (const tag of tags) {
                note.addTag(tag);
            }
        }

        // Add a tag to identify AI-generated notes
        note.addTag("AI-Generated");

        // Save the note
        await note.saveTx();

        // If collection_id was provided, add the note to that collection
        if (collection_id) {
            note.addToCollection(collection_id);
            await note.saveTx();
        }

        Zotero.debug(`[seerai] Tool: create_note created note ID=${note.id}`);

        const result: CreateNoteResult = {
            note_id: note.id,
            parent_item_id: parentID,
        };

        return {
            success: true,
            data: result,
            summary: parentID
                ? `Created note "${title}" attached to item ${parent_item_id}`
                : `Created standalone note "${title}" in collection ${collection_id}`,
        };

    } catch (error) {
        Zotero.debug(`[seerai] Tool: create_note error: ${error}`);
        return {
            success: false,
            error: error instanceof Error ? error.message : String(error),
        };
    }
}

/**
 * Execute edit_note tool
 * Applies one or more edit operations to an existing note
 */
export async function executeEditNote(
    params: EditNoteParams,
    _config: AgentConfig
): Promise<ToolResult> {
    try {
        const { note_id, operations, convert_markdown = true } = params;

        Zotero.debug(`[seerai] Tool: edit_note id=${note_id} ops=${operations.length}`);

        // Get the item
        let item = Zotero.Items.get(note_id);
        if (!item) {
            return {
                success: false,
                error: `Item with ID ${note_id} not found`,
            };
        }

        // If this is not a note, check if it's a regular item with child notes
        let noteItem = item;
        let actualNoteId = note_id;

        if (!item.isNote()) {
            // Check if this is a regular item with child notes
            if (item.isRegularItem()) {
                const noteIds = item.getNotes();
                if (noteIds && noteIds.length > 0) {
                    // Use the first child note
                    noteItem = Zotero.Items.get(noteIds[0]);
                    actualNoteId = noteIds[0];
                    Zotero.debug(`[seerai] Tool: edit_note resolved parent item ${note_id} to child note ${actualNoteId}`);

                    if (noteIds.length > 1) {
                        Zotero.debug(`[seerai] Tool: edit_note warning: item ${note_id} has ${noteIds.length} child notes, using first one (${actualNoteId})`);
                    }
                } else {
                    return {
                        success: false,
                        error: `Item ${note_id} is not a note and has no child notes. Use create_note to create a new note for this item.`,
                    };
                }
            } else {
                return {
                    success: false,
                    error: `Item ${note_id} is not a note (type: ${item.itemType})`,
                };
            }
        }

        // Verify we have a valid note item now
        if (!noteItem || !noteItem.isNote()) {
            return {
                success: false,
                error: `Could not resolve a valid note from ID ${note_id}`,
            };
        }


        // Get current note content
        let content = noteItem.getNote();
        let operationsApplied = 0;

        // Apply each operation in sequence
        for (const op of operations) {
            const result = applyEditOperation(content, op, convert_markdown);
            if (result.success) {
                content = result.content;
                operationsApplied++;
                Zotero.debug(`[seerai] Tool: edit_note applied op '${op.type}'`);
            } else {
                Zotero.debug(`[seerai] Tool: edit_note op '${op.type}' failed: ${result.error}`);
                // Continue with other operations, but log the failure
            }
        }

        if (operationsApplied === 0) {
            return {
                success: false,
                error: "No operations were successfully applied. Check that search terms exist in the note.",
            };
        }

        // Update the note
        noteItem.setNote(content);

        // Mark as AI-edited if not already tagged
        const existingTags = noteItem.getTags().map((t: { tag: string }) => t.tag);
        if (!existingTags.includes("AI-Edited")) {
            noteItem.addTag("AI-Edited");
        }

        await noteItem.saveTx();

        Zotero.debug(`[seerai] Tool: edit_note completed ${operationsApplied}/${operations.length} ops`);

        const result: EditNoteResult = {
            note_id: actualNoteId,
            operations_applied: operationsApplied,
            new_content_length: content.length,
        };

        const resolvedMsg = actualNoteId !== note_id
            ? ` (resolved from parent item ${note_id})`
            : "";

        return {
            success: true,
            data: result,
            summary: `Applied ${operationsApplied} edit(s) to note ${actualNoteId}${resolvedMsg}`,
        };

    } catch (error) {
        Zotero.debug(`[seerai] Tool: edit_note error: ${error}`);
        return {
            success: false,
            error: error instanceof Error ? error.message : String(error),
        };
    }
}

/**
 * Apply a single edit operation to note content
 */
function applyEditOperation(
    content: string,
    op: EditNoteOperation,
    convertMarkdown: boolean
): { success: true; content: string } | { success: false; error: string } {
    // Convert markdown content to HTML if needed
    const processContent = (text: string): string => {
        if (!text) return "";
        if (convertMarkdown && !text.trim().startsWith("<")) {
            return markdownToHtml(text);
        }
        return text;
    };

    switch (op.type) {
        case "replace": {
            if (!op.search) {
                return { success: false, error: "'replace' operation requires 'search' parameter" };
            }
            if (op.content === undefined) {
                return { success: false, error: "'replace' operation requires 'content' parameter" };
            }

            const replacement = processContent(op.content);

            // Check if search text exists
            if (!content.includes(op.search)) {
                return { success: false, error: `Search text not found: "${op.search.substring(0, 50)}..."` };
            }

            if (op.replace_all) {
                // Replace all occurrences
                content = content.split(op.search).join(replacement);
            } else {
                // Replace first occurrence only
                content = content.replace(op.search, replacement);
            }
            return { success: true, content };
        }

        case "insert": {
            if (op.content === undefined) {
                return { success: false, error: "'insert' operation requires 'content' parameter" };
            }

            const insertContent = processContent(op.content);
            const position = op.position || "end";

            if (position === "start") {
                content = insertContent + content;
            } else if (position === "end") {
                content = content + insertContent;
            } else {
                // Try to find the position as a CSS selector-like marker
                // Look for common HTML patterns
                const positionPatterns = [
                    `</${position}>`,  // End tag: </h1>, </p>
                    `<${position}>`,   // Start tag: <h1>, <p>
                    `id="${position}"`,
                    `class="${position}"`,
                ];

                let inserted = false;
                for (const pattern of positionPatterns) {
                    const idx = content.indexOf(pattern);
                    if (idx !== -1) {
                        // Insert after the found pattern
                        const insertPos = idx + pattern.length;
                        content = content.slice(0, insertPos) + insertContent + content.slice(insertPos);
                        inserted = true;
                        break;
                    }
                }

                if (!inserted) {
                    // Fall back to appending if position not found
                    content = content + insertContent;
                }
            }
            return { success: true, content };
        }

        case "append": {
            if (op.content === undefined) {
                return { success: false, error: "'append' operation requires 'content' parameter" };
            }

            const appendContent = processContent(op.content);
            content = content + appendContent;
            return { success: true, content };
        }

        case "prepend": {
            if (op.content === undefined) {
                return { success: false, error: "'prepend' operation requires 'content' parameter" };
            }

            const prependContent = processContent(op.content);
            content = prependContent + content;
            return { success: true, content };
        }

        case "delete": {
            if (!op.search) {
                return { success: false, error: "'delete' operation requires 'search' parameter" };
            }

            // Check if search text exists
            if (!content.includes(op.search)) {
                return { success: false, error: `Search text not found: "${op.search.substring(0, 50)}..."` };
            }

            // Remove all occurrences
            content = content.split(op.search).join("");
            return { success: true, content };
        }

        default:
            return { success: false, error: `Unknown operation type: ${(op as EditNoteOperation).type}` };
    }
}
