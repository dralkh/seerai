/**
 * MCP Tool Definitions
 *
 * Defines all Seer-AI tools in MCP format (Core and Consolidated).
 */

import { z } from "zod";

// ==================== Core Tool Parameter Schemas ====================

const searchLibraryParams = z.object({
  query: z
    .string()
    .describe("Search query for titles, authors, abstracts, and full text"),
  filters: z
    .object({
      year_from: z.number().optional().describe("Minimum publication year"),
      year_to: z.number().optional().describe("Maximum publication year"),
      authors: z
        .array(z.string())
        .optional()
        .describe("Filter by author names"),
      tags: z.array(z.string()).optional().describe("Filter by tags"),
      collection: z.string().optional().describe("Filter by collection name"),
      item_types: z
        .array(z.string())
        .optional()
        .describe("Filter by item types"),
    })
    .optional()
    .describe("Optional filters"),
  limit: z
    .number()
    .min(1)
    .max(50)
    .default(10)
    .optional()
    .describe("Max results (default: 10)"),
});

const getItemMetadataParams = z.object({
  item_id: z.number().describe("Zotero item ID"),
});

const readItemContentParams = z.object({
  item_id: z.number().describe("Zotero item ID"),
  include_notes: z.boolean().default(true).optional().describe("Include notes"),
  include_pdf: z
    .boolean()
    .default(true)
    .optional()
    .describe("Include PDF text"),
  trigger_ocr: z
    .boolean()
    .default(false)
    .optional()
    .describe("Trigger OCR if needed"),
  max_length: z
    .number()
    .default(0)
    .optional()
    .describe("Max content length (0 = no limit)"),
});

const searchExternalParams = z.object({
  query: z.string().describe("Search query"),
  year: z.string().optional().describe("Year range (e.g., '2020-2024')"),
  limit: z
    .number()
    .min(1)
    .max(100)
    .default(10)
    .optional()
    .describe("Max results"),
  openAccessPdf: z
    .boolean()
    .default(false)
    .optional()
    .describe("Only open access PDFs"),
});

const importPaperParams = z.object({
  paper_id: z.string().describe("Semantic Scholar paper ID"),
  target_collection_id: z.number().optional().describe("Target collection ID"),
  trigger_ocr: z
    .boolean()
    .default(false)
    .optional()
    .describe("Trigger OCR after import"),
});

// ==================== Consolidated Tool Parameter Schemas ====================

const contextParams = z.discriminatedUnion("action", [
  z.object({ action: z.literal("list") }),
  z.object({
    action: z.literal("add"),
    items: z
      .array(
        z.object({
          type: z.enum([
            "paper",
            "tag",
            "author",
            "collection",
            "topic",
            "table",
          ]),
          id: z.union([z.number(), z.string()]).optional(),
          name: z.string().optional(),
        }),
      )
      .min(1)
      .describe("Items to add to context"),
  }),
  z.object({
    action: z.literal("remove"),
    items: z
      .array(
        z.object({
          type: z.enum([
            "paper",
            "tag",
            "author",
            "collection",
            "topic",
            "table",
          ]),
          id: z.union([z.number(), z.string()]).optional(),
        }),
      )
      .min(1)
      .describe("Items to remove from context"),
  }),
]);

const collectionParams = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("find"),
    name: z.string().min(1).describe("Collection name to search for"),
    library_id: z.number().optional(),
    parent_id: z.number().optional(),
  }),
  z.object({
    action: z.literal("create"),
    name: z.string().min(1).describe("Name for new collection"),
    parent_id: z.number().optional(),
    library_id: z.number().optional(),
  }),
  z.object({
    action: z.literal("list"),
    collection_id: z.number().describe("Collection ID to list"),
  }),
  z.object({
    action: z.literal("add_item"),
    collection_id: z.number().describe("Target collection ID"),
    item_ids: z.array(z.number()).min(1).describe("Item IDs to add"),
    remove_from_others: z.boolean().default(false).optional(),
  }),
  z.object({
    action: z.literal("remove_item"),
    collection_id: z.number().describe("Collection ID"),
    item_ids: z.array(z.number()).min(1).describe("Item IDs to remove"),
  }),
]);

const tableParams = z.discriminatedUnion("action", [
  z.object({ action: z.literal("list") }),
  z.object({
    action: z.literal("create"),
    name: z.string().min(1).describe("Table name"),
    paper_ids: z.array(z.number()).optional().describe("Initial papers"),
  }),
  z.object({
    action: z.literal("add_papers"),
    table_id: z.string().min(1).describe("Table ID"),
    paper_ids: z.array(z.number()).min(1).describe("Paper IDs to add"),
  }),
  z.object({
    action: z.literal("add_column"),
    table_id: z.string().min(1).describe("Table ID"),
    column_name: z.string().min(1).describe("Column name"),
    ai_prompt: z.string().min(1).describe("AI prompt for data generation"),
  }),
  z.object({
    action: z.literal("generate"),
    table_id: z.string().min(1).describe("Table ID"),
    column_id: z.string().optional(),
    item_ids: z.array(z.number()).optional(),
  }),
  z.object({
    action: z.literal("read"),
    table_id: z
      .string()
      .optional()
      .describe("Table ID (most recent if omitted)"),
    include_data: z.boolean().default(true).optional(),
  }),
]);

const noteParams = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("create"),
    parent_item_id: z.number().optional(),
    collection_id: z.number().optional(),
    title: z.string().min(1).describe("Note title"),
    content: z.string().min(1).describe("Note content (markdown)"),
    tags: z.array(z.string()).optional(),
  }),
  z.object({
    action: z.literal("edit"),
    note_id: z.number().describe("Note ID to edit"),
    operations: z
      .array(
        z.object({
          type: z.enum(["replace", "insert", "append", "prepend", "delete"]),
          search: z.string().optional(),
          content: z.string().optional(),
          position: z.string().optional(),
          replace_all: z.boolean().default(false).optional(),
        }),
      )
      .min(1),
    convert_markdown: z.boolean().default(true).optional(),
  }),
]);

const relatedPapersParams = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("citations"),
    paper_id: z.string().describe("Semantic Scholar paper ID"),
    limit: z.number().min(1).max(50).default(10).optional(),
  }),
  z.object({
    action: z.literal("references"),
    paper_id: z.string().describe("Semantic Scholar paper ID"),
    limit: z.number().min(1).max(50).default(10).optional(),
  }),
]);

const webParams = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("search"),
    query: z.string().min(1).describe("Search query"),
    limit: z.number().min(1).max(20).default(5).optional(),
  }),
  z.object({
    action: z.literal("read"),
    url: z.string().describe("URL to read"),
  }),
]);

// ==================== Tool Definitions ====================

export const TOOL_DEFINITIONS = [
  // ==================== Consolidated Tools ====================
  {
    name: "context",
    description:
      "Manage conversation context. Add items (papers, tags, collections) to focus the conversation, remove them, or list current context.",
    inputSchema: contextParams,
  },
  {
    name: "collection",
    description:
      "Manage Zotero collections. Find, create, list contents, or add/remove items from collections.",
    inputSchema: collectionParams,
  },
  {
    name: "table",
    description:
      "Manage research analysis tables. List tables, create new tables, add papers, add columns, generate AI data, or read table contents.",
    inputSchema: tableParams,
  },
  {
    name: "note",
    description:
      "Create or edit Zotero notes. Create new notes attached to items/collections, or edit existing notes with operations.",
    inputSchema: noteParams,
  },
  {
    name: "related_papers",
    description:
      "Find related papers via citations (forward) or references (backward).",
    inputSchema: relatedPapersParams,
  },
  {
    name: "web",
    description: "Search the web or read webpage content.",
    inputSchema: webParams,
  },

  // ==================== Core Tools ====================
  {
    name: "search_library",
    description:
      "Search the Zotero library for papers matching a query. Returns titles, authors, and IDs.",
    inputSchema: searchLibraryParams,
  },
  {
    name: "get_item_metadata",
    description:
      "Get complete metadata for a Zotero item (authors, DOI, abstract, etc.).",
    inputSchema: getItemMetadataParams,
  },
  {
    name: "read_item_content",
    description:
      "Read the full content of a paper including notes and PDF text.",
    inputSchema: readItemContentParams,
  },
  {
    name: "search_external",
    description: "Search Semantic Scholar for external papers.",
    inputSchema: searchExternalParams,
  },
  {
    name: "import_paper",
    description: "Import a paper from Semantic Scholar into Zotero.",
    inputSchema: importPaperParams,
  },
  {
    name: "generate_item_tags",
    description:
      "Generate AI-powered tags for a Zotero item based on its content.",
    inputSchema: z.object({
      item_id: z.number().describe("Zotero item ID to generate tags for"),
    }),
  },
];

export type ToolName = (typeof TOOL_DEFINITIONS)[number]["name"];
