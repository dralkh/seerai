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

// ==================== Workspace Tool Parameter Schemas ====================

const workspaceReadFileParams = z.object({
  path: z.string().describe("File path relative to workspace root"),
  offset: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Start reading at line (1-indexed)"),
  limit: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Maximum lines to read"),
});

const workspaceWriteFileParams = z.object({
  path: z.string().describe("File path relative to workspace root"),
  content: z.string().describe("Full content to write"),
  message: z.string().optional().describe("Description of the change"),
});

const workspaceEditFileParams = z.object({
  path: z.string().describe("File path relative to workspace root"),
  oldString: z.string().describe("Exact text to replace"),
  newString: z.string().describe("Text to replace with"),
  replaceAll: z
    .boolean()
    .default(false)
    .optional()
    .describe("Replace all occurrences"),
  message: z.string().optional().describe("Description of the change"),
});

const workspaceGlobParams = z.object({
  pattern: z.string().describe("Glob pattern (e.g. '**/*.ts', '*.json')"),
  path: z.string().optional().describe("Directory to search within"),
});

const workspaceGrepParams = z.object({
  pattern: z.string().describe("Regex pattern to search for"),
  include: z.string().optional().describe("File pattern filter (e.g. '*.ts')"),
  path: z.string().optional().describe("Directory to search within"),
});

const workspaceQuestionParams = z.object({
  questions: z
    .array(
      z.object({
        question: z.string().describe("The complete question text"),
        header: z.string().max(30).describe("Very short label (max 30 chars)"),
        options: z
          .array(
            z.object({
              label: z.string().describe("Display text (1-5 words, concise)"),
              description: z.string().describe("Explanation of choice"),
            }),
          )
          .describe("Available choices"),
        multiple: z
          .boolean()
          .default(false)
          .optional()
          .describe("Allow selecting multiple choices"),
      }),
    )
    .describe("Questions to ask the user"),
});

const workspaceBashParams = z.object({
  command: z.string().describe("The bash command to execute"),
  workdir: z
    .string()
    .optional()
    .describe("Working directory relative to workspace root"),
  description: z
    .string()
    .describe("Clear, concise description of what this command does"),
});

const workspaceDiffParams = z.object({
  path: z.string().describe("File path relative to workspace root"),
  previous: z
    .boolean()
    .default(true)
    .optional()
    .describe("Compare with previous version"),
  versionId: z.string().optional().describe("Specific version ID to compare"),
});

const workspaceLogParams = z.object({
  path: z.string().describe("File path relative to workspace root"),
  limit: z
    .number()
    .int()
    .positive()
    .default(20)
    .optional()
    .describe("Max history entries"),
});

// ==================== TODO Tool Parameter Schemas ====================

const todoWriteParams = z.object({
  todos: z
    .array(
      z.object({
        id: z.string().describe("Unique identifier for this todo item"),
        content: z.string().describe("Brief description of the task"),
        status: z
          .enum(["pending", "in_progress", "completed", "cancelled"])
          .describe("Current status of the task"),
        priority: z
          .enum(["high", "medium", "low"])
          .describe("Priority level of the task"),
      }),
    )
    .describe("The complete todo list"),
});

const todoReadParams = z.object({});

const taskCompleteParams = z.object({
  summary: z.string().describe("Brief summary of what was accomplished"),
});

// ==================== Tool Definitions ====================

export const TOOL_DEFINITIONS = [
  // ==================== TODO Tools ====================
  {
    name: "todowrite",
    description:
      "Create or update a structured task list (TODO list) for the current session. " +
      "Use this at the start of multi-step tasks to plan your work, then update statuses as you progress. " +
      "Do NOT call 'task_complete' until ALL todos are either completed or cancelled.",
    inputSchema: todoWriteParams,
  },
  {
    name: "todoread",
    description:
      "Read the current TODO list for this session. Call this when you lose track of what remains to be done or after context compaction to recover your task state.",
    inputSchema: todoReadParams,
  },
  {
    name: "task_complete",
    description:
      "Signal that the current task is fully complete. Call this ONLY when ALL requested work has been DONE. " +
      "You MUST call this tool before producing final answer text. If any work remains, do NOT call this tool.",
    inputSchema: taskCompleteParams,
  },

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

  // ==================== Workspace Tools ====================
  {
    name: "workspace_read_file",
    description:
      "Read a file from the workspace. Returns the file content and metadata.",
    inputSchema: workspaceReadFileParams,
  },
  {
    name: "workspace_write_file",
    description:
      "Write a file to the workspace. Creates the file if it does not exist, overwrites if it does.",
    inputSchema: workspaceWriteFileParams,
  },
  {
    name: "workspace_edit_file",
    description:
      "Edit a file in the workspace by replacing an exact string match with new content.",
    inputSchema: workspaceEditFileParams,
  },
  {
    name: "workspace_glob",
    description:
      "Find files in the workspace matching a glob pattern (e.g. '**/*.ts', '*.json').",
    inputSchema: workspaceGlobParams,
  },
  {
    name: "workspace_grep",
    description: "Search for a regex pattern across files in the workspace.",
    inputSchema: workspaceGrepParams,
  },
  {
    name: "workspace_question",
    description:
      "Ask the user one or more questions during execution. Returns the user's selected answers. Use when you need clarification, decisions, or preferences to proceed with the task.",
    inputSchema: workspaceQuestionParams,
  },
  {
    name: "workspace_bash",
    description:
      "Request execution of a bash command. In the Zotero context, bash commands cannot be executed directly - this tool records the command and prompts the user to run it manually. Use sparingly and prefer workspace file tools for file operations.",
    inputSchema: workspaceBashParams,
  },
  {
    name: "workspace_diff",
    description:
      "Show the diff (changes) for a workspace file between versions.",
    inputSchema: workspaceDiffParams,
  },
  {
    name: "workspace_log",
    description: "Show version history for a workspace file.",
    inputSchema: workspaceLogParams,
  },
];

export type ToolName = (typeof TOOL_DEFINITIONS)[number]["name"];
