/**
 * Zod Schemas for Tool Parameter Validation
 * Provides runtime validation with rich error feedback for self-correction
 *
 * @see agentic.md Section 4.1 - "Zod serves as the Source of Truth"
 */

import { z } from "zod";
import { TOOL_NAMES, ToolName } from "./toolTypes";

// ==================== CORE SCHEMAS ====================

export const SearchLibraryParamsSchema = z.object({
  query: z
    .string()
    .describe("Search query for titles, authors, abstracts, and full text"),
  filters: z
    .object({
      year_from: z
        .number()
        .int()
        .optional()
        .describe("Minimum publication year (inclusive)"),
      year_to: z
        .number()
        .int()
        .optional()
        .describe("Maximum publication year (inclusive)"),
      authors: z
        .array(z.string())
        .optional()
        .describe("Author names to filter by"),
      tags: z.array(z.string()).optional().describe("Tags to filter by"),
      collection: z
        .string()
        .optional()
        .describe("Collection name to filter by"),
      item_types: z
        .array(z.string())
        .optional()
        .describe("Item types to include"),
    })
    .optional()
    .describe("Optional filters to narrow search results"),
  limit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .default(10)
    .optional()
    .describe("Maximum number of results (default: 10, max: 50)"),
  library_id: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Library ID to restrict search (user library or group library)"),
});

export const GetItemMetadataParamsSchema = z.object({
  item_id: z.number().int().positive().describe("The Zotero item ID"),
});

export const SearchExternalParamsSchema = z.object({
  query: z.string().min(1).describe("Search query for Semantic Scholar"),
  year: z
    .string()
    .optional()
    .describe("Year range, e.g., '2020-2024' or '2023-'"),
  limit: z.number().int().min(1).max(50).default(10).optional(),
  openAccessPdf: z
    .boolean()
    .optional()
    .describe("Only return papers with open access PDFs"),
});

export const ReadItemContentParamsSchema = z.object({
  item_id: z
    .number()
    .int()
    .positive()
    .describe("The Zotero item ID to read content from"),
  include_notes: z
    .boolean()
    .default(true)
    .optional()
    .describe("Include attached notes in content"),
  include_pdf: z
    .boolean()
    .default(true)
    .optional()
    .describe("Include PDF text content if available"),
  trigger_ocr: z
    .boolean()
    .default(false)
    .optional()
    .describe("Trigger OCR if no text content is found"),
  max_length: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Maximum content length (0 for no limit)"),
});

export const SystematicReviewParamsSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("list_projects") }),
  z.object({
    action: z.literal("get_project"),
    project_id: z.string().optional(),
  }),
  z.object({
    action: z.literal("get_records"),
    project_id: z.string().optional(),
  }),
  z.object({
    action: z.literal("get_synthesis"),
    project_id: z.string().optional(),
    run_id: z.string().optional(),
  }),
  z.object({
    action: z.literal("get_gaps"),
    project_id: z.string().optional(),
    run_id: z.string().optional(),
  }),
  z.object({
    action: z.literal("get_prisma"),
    project_id: z.string().optional(),
  }),
  z.object({
    action: z.literal("get_sources"),
    project_id: z.string().optional(),
  }),
  z.object({
    action: z.literal("sync_sources"),
    project_id: z.string().optional(),
    sources: z.array(
      z.object({
        collection_id: z.number().int().positive(),
        type: z.enum(["Database", "Register", "Other source"]),
        label: z.string().trim().min(1),
        include_subfolders: z.boolean().default(true).optional(),
      }),
    ),
  }),
  z.object({
    action: z.literal("get_protocol"),
    project_id: z.string().optional(),
  }),
  z.object({
    action: z.literal("validate_protocol"),
    project_id: z.string().optional(),
  }),
  z.object({
    action: z.literal("rollback_protocol"),
    project_id: z.string().optional(),
    revision_id: z.string().min(1),
  }),
  z.object({
    action: z.literal("update_protocol"),
    project_id: z.string().optional(),
    research_question: z.string().optional(),
    framework: z.string().optional(),
    dimensions: z
      .array(
        z.object({
          key: z.string().min(1),
          label: z.string().min(1),
          description: z.string().optional(),
          value: z.string(),
          keyword_aids: z.array(z.string()).optional(),
          evidence_labels: z.array(z.string()).optional(),
        }),
      )
      .optional(),
    inclusion_rules: z.array(z.string()).optional(),
    exclusion_rules: z.array(z.string()).optional(),
    include_keyword_aids: z.array(z.string()).optional(),
    exclude_keyword_aids: z.array(z.string()).optional(),
  }),
  z.object({
    action: z.literal("create_project"),
    name: z.string().trim().min(1),
  }),
  z.object({
    action: z.literal("add_papers"),
    project_id: z.string().optional(),
    paper_ids: z.array(z.number().int().positive()).min(1),
  }),
  z.object({
    action: z.literal("remove_papers"),
    project_id: z.string().optional(),
    paper_ids: z.array(z.number().int().positive()).min(1),
  }),
  z.object({
    action: z.literal("get_extraction_template"),
    project_id: z.string().optional(),
  }),
  z.object({
    action: z.literal("propose_extraction_template"),
    project_id: z.string().optional(),
    instructions: z.string().optional(),
  }),
  z.object({
    action: z.literal("activate_extraction_template"),
    project_id: z.string().optional(),
    template_id: z.string().min(1),
  }),
  z.object({
    action: z.literal("update_extraction_template"),
    project_id: z.string().optional(),
    template_id: z.string().min(1),
    name: z.string().trim().min(1).optional(),
    instructions: z.string().optional(),
    outcomes: z
      .array(
        z.object({
          id: z.string().optional(),
          name: z.string().trim().min(1),
          aliases: z.array(z.string()).optional(),
          description: z.string().optional(),
          measures: z.array(z.enum(["OR", "RR", "HR", "MD", "SMD"])).min(1),
          timepoints: z.array(z.string()).optional(),
          unit: z.string().optional(),
          direction: z.enum(["higher_better", "lower_better"]).optional(),
          required: z.boolean().optional(),
        }),
      )
      .optional(),
  }),
  z.object({
    action: z.literal("start_analysis_job"),
    project_id: z.string().optional(),
    paper_ids: z.array(z.number().int().positive()).min(1),
  }),
  z.object({
    action: z.literal("start_extraction_job"),
    project_id: z.string().optional(),
    paper_ids: z.array(z.number().int().positive()).min(1),
  }),
  z.object({
    action: z.enum([
      "get_review_job",
      "pause_review_job",
      "cancel_review_job",
      "retry_review_job",
    ]),
    project_id: z.string().optional(),
    job_id: z.string().min(1),
  }),
  z.object({
    action: z.literal("get_extractions"),
    project_id: z.string().optional(),
    paper_id: z.number().int().positive().optional(),
    extraction_status: z.enum(["proposed", "verified", "rejected"]).optional(),
  }),
  z.object({
    action: z.literal("review_extractions"),
    project_id: z.string().optional(),
    paper_id: z.number().int().positive(),
    extraction_ids: z.array(z.string().min(1)).min(1),
    verification_status: z.enum(["verified", "rejected"]),
  }),
  z.object({
    action: z.literal("get_synthesis_readiness"),
    project_id: z.string().optional(),
  }),
  z.object({
    action: z.literal("analyze_papers"),
    project_id: z.string().optional(),
    paper_ids: z.array(z.number().int().positive()).min(1),
  }),
  z.object({
    action: z.literal("save_extraction"),
    project_id: z.string().optional(),
    paper_id: z.number().int().positive(),
    extraction: z.object({
      id: z.string().optional(),
      outcome: z.string().trim().min(1),
      effect_type: z.enum(["OR", "RR", "HR", "MD", "SMD"]),
      effect_size: z.number(),
      ci_low: z.number(),
      ci_high: z.number(),
      n: z.number().int().nonnegative(),
      events: z.number().int().nonnegative(),
      timepoint: z.string().optional(),
      unit: z.string().optional(),
      direction: z.enum(["higher_better", "lower_better"]).optional(),
      source_attachment_id: z.number().int().positive().optional(),
      source_page: z.string().optional(),
      source_quote: z.string().optional(),
      verification_status: z.enum(["proposed", "verified"]).optional(),
    }),
  }),
  z.object({
    action: z.literal("run_synthesis"),
    project_id: z.string().optional(),
    force: z.boolean().optional(),
  }),
  z.object({
    action: z.literal("confirm_synthesis"),
    project_id: z.string().optional(),
    domain_id: z.string().min(1),
    selected_model: z.enum(["common_effect", "random_effects", "narrative"]),
  }),
  z.object({
    action: z.literal("generate_gaps"),
    project_id: z.string().optional(),
    synthesis_run_id: z.string().optional(),
    force: z.boolean().optional(),
  }),
  z.object({
    action: z.literal("update_gap"),
    project_id: z.string().optional(),
    gap_id: z.string().min(1),
    title: z.string().optional(),
    severity: z.enum(["high", "medium", "low"]).optional(),
    description: z.string().optional(),
    implication: z.string().optional(),
    status: z.enum(["draft", "accepted", "rejected", "ignored"]).optional(),
    reviewer_note: z.string().optional(),
  }),
  z.object({
    action: z.literal("screen"),
    project_id: z.string().optional(),
    paper_ids: z.array(z.number().int().positive()).min(1),
    decision: z.enum(["undecided", "included", "maybe", "excluded"]),
    reason: z.string().optional(),
    stage: z
      .enum(["title_abstract", "full_text", "final"])
      .default("title_abstract")
      .optional(),
  }),
]);

export const ImportPaperParamsSchema = z.object({
  paper_id: z.string().min(1).describe("Semantic Scholar paper ID"),
  target_collection_id: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Collection ID to add the imported paper to"),
  trigger_ocr: z
    .boolean()
    .optional()
    .describe("Automatically trigger OCR after import"),
});

export const GenerateItemTagsParamsSchema = z.object({
  item_id: z
    .number()
    .int()
    .positive()
    .describe("Zotero item ID to generate tags for"),
});

// ==================== SUPPORTING SCHEMAS ====================

const ContextItemSchema = z.object({
  type: z
    .enum(["paper", "tag", "author", "collection", "topic", "table", "review"])
    .describe("Type of context item"),
  id: z.union([z.number(), z.string()]).optional().describe("Item ID"),
  name: z.string().optional().describe("Item name (for display)"),
});

const EditNoteOperationSchema = z.object({
  type: z
    .enum(["replace", "insert", "append", "prepend", "delete"])
    .describe("Type of edit operation"),
  search: z
    .string()
    .optional()
    .describe("Text to search for (required for 'replace' and 'delete')"),
  content: z
    .string()
    .optional()
    .describe("New content to insert/append/prepend or replacement text"),
  position: z
    .string()
    .optional()
    .describe("Position for 'insert': 'start', 'end', or CSS selector"),
  replace_all: z
    .boolean()
    .default(false)
    .optional()
    .describe("For 'replace': replace all occurrences (default: first only)"),
});

// ==================== UNIFIED TOOL SCHEMAS (CONSOLIDATED) ====================

export const ContextParamsSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("list"),
  }),
  z.object({
    action: z.literal("add"),
    items: z
      .array(ContextItemSchema)
      .min(1)
      .describe("Items to add to context"),
  }),
  z.object({
    action: z.literal("remove"),
    items: z
      .array(ContextItemSchema)
      .min(1)
      .describe("Items to remove from context"),
  }),
]);

export const CollectionParamsSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("find"),
    name: z.string().min(1).describe("Collection name to search for"),
    library_id: z.number().int().optional(),
    parent_id: z.number().int().positive().optional(),
  }),
  z.object({
    action: z.literal("create"),
    name: z.string().min(1).describe("Name for new collection"),
    parent_id: z.number().int().positive().optional(),
    library_id: z.number().int().optional(),
  }),
  z.object({
    action: z.literal("list"),
    collection_id: z
      .number()
      .int()
      .positive()
      .describe("Collection ID to list"),
  }),
  z.object({
    action: z.literal("add_item"),
    collection_id: z.number().int().positive().describe("Target collection ID"),
    item_ids: z
      .array(z.number().int().positive())
      .min(1)
      .describe("Item IDs to add"),
    remove_from_others: z.boolean().default(false).optional(),
  }),
  z.object({
    action: z.literal("remove_item"),
    collection_id: z.number().int().positive().describe("Collection ID"),
    item_ids: z
      .array(z.number().int().positive())
      .min(1)
      .describe("Item IDs to remove"),
  }),
]);

export const TableParamsSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("list"),
  }),
  z.object({
    action: z.literal("create"),
    name: z.string().min(1).describe("Table name"),
    paper_ids: z
      .array(z.number().int().positive())
      .optional()
      .describe("Initial papers"),
  }),
  z.object({
    action: z.literal("add_papers"),
    table_id: z.string().min(1).describe("Table ID"),
    paper_ids: z
      .array(z.number().int().positive())
      .min(1)
      .describe("Paper IDs to add"),
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
    item_ids: z.array(z.number().int().positive()).optional(),
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

export const NoteParamsSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("create"),
      parent_item_id: z.number().int().positive().optional(),
      collection_id: z.number().int().positive().optional(),
      title: z.string().min(1).describe("Note title"),
      content: z.string().min(1).describe("Note content (markdown)"),
      tags: z.array(z.string()).optional(),
    })
    .refine(
      (data) =>
        data.parent_item_id !== undefined || data.collection_id !== undefined,
      { message: "Either parent_item_id or collection_id required" },
    ),
  z.object({
    action: z.literal("edit"),
    note_id: z.number().int().positive().describe("Note ID to edit"),
    operations: z.array(EditNoteOperationSchema).min(1),
    convert_markdown: z.boolean().default(true).optional(),
  }),
]);

export const RelatedPapersParamsSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("citations"),
    paper_id: z.string().min(1).describe("Semantic Scholar paper ID"),
    limit: z.number().int().min(1).max(50).default(10).optional(),
  }),
  z.object({
    action: z.literal("references"),
    paper_id: z.string().min(1).describe("Semantic Scholar paper ID"),
    limit: z.number().int().min(1).max(50).default(10).optional(),
  }),
]);

export const WebParamsSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("search"),
    query: z.string().min(1).describe("Search query"),
    limit: z.number().int().min(1).max(20).default(5).optional(),
  }),
  z.object({
    action: z.literal("read"),
    url: z.string().url().describe("URL to read"),
  }),
]);

// ==================== WORKSPACE SCHEMAS ====================

export const WorkspaceReadFileParamsSchema = z.object({
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

export const WorkspaceWriteFileParamsSchema = z.object({
  path: z.string().describe("File path relative to workspace root"),
  content: z.string().describe("Full content to write"),
  message: z.string().optional().describe("Description of the change"),
});

export const WorkspaceEditFileParamsSchema = z.object({
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

export const WorkspaceGlobParamsSchema = z.object({
  pattern: z.string().describe("Glob pattern (e.g. '**/*.ts', '*.json')"),
  path: z.string().optional().describe("Directory to search within"),
});

export const WorkspaceGrepParamsSchema = z.object({
  pattern: z.string().describe("Regex pattern to search for"),
  include: z.string().optional().describe("File pattern filter (e.g. '*.ts')"),
  path: z.string().optional().describe("Directory to search within"),
});

export const WorkspaceQuestionParamsSchema = z.object({
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

export const WorkspaceBashParamsSchema = z.object({
  command: z.string().describe("The bash command to execute"),
  workdir: z
    .string()
    .optional()
    .describe("Working directory relative to workspace root"),
  description: z
    .string()
    .describe("Clear, concise description of what this command does"),
});

export const WorkspaceDiffParamsSchema = z.object({
  path: z.string().describe("File path relative to workspace root"),
  previous: z
    .boolean()
    .default(true)
    .optional()
    .describe("Compare with previous version"),
  versionId: z.string().optional().describe("Specific version ID to compare"),
});

export const WorkspaceLogParamsSchema = z.object({
  path: z.string().describe("File path relative to workspace root"),
  limit: z
    .number()
    .int()
    .positive()
    .default(20)
    .optional()
    .describe("Max history entries"),
});

export const SemanticSearchParamsSchema = z.object({
  query: z.string().describe("Natural language search query"),
  scope: z
    .enum(["context", "library", "collection"])
    .default("library")
    .optional()
    .describe("What to search"),
  library_id: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Library ID to restrict search (user library or group library)"),
  collection_id: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Collection ID (if scope is 'collection')"),
  top_k: z
    .number()
    .int()
    .min(1)
    .max(20)
    .default(5)
    .optional()
    .describe("Number of results to return"),
  min_score: z
    .number()
    .int()
    .min(0)
    .max(100)
    .default(30)
    .optional()
    .describe("Minimum relevance score 0-100"),
  sources: z
    .array(z.enum(["abstract", "pdf", "note", "metadata", "table", "file"]))
    .optional()
    .describe(
      "Filter results to specific chunk sources (e.g. ['pdf', 'abstract'] for methods and abstracts only)",
    ),
  include_full_text: z
    .boolean()
    .default(false)
    .optional()
    .describe("Include full passage text instead of a 1000-char preview"),
});

export const KeywordSearchParamsSchema = z.object({
  query: z.string().describe("Search query for keyword matching"),
  scope: z
    .enum(["context", "library", "collection"])
    .default("library")
    .optional()
    .describe("What to search"),
  library_id: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Library ID to restrict search (user library or group library)"),
  collection_id: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Collection ID (if scope is 'collection')"),
  top_k: z
    .number()
    .int()
    .min(1)
    .max(20)
    .default(5)
    .optional()
    .describe("Number of results to return"),
  sources: z
    .array(z.enum(["abstract", "pdf", "note", "metadata", "table", "file"]))
    .optional()
    .describe(
      "Filter results to specific chunk sources (e.g. ['pdf'] for full-text only)",
    ),
});

export const ReadChunksParamsSchema = z.object({
  chunk_ids: z
    .array(z.string())
    .optional()
    .describe("List of chunk IDs to read"),
  item_id: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Item ID to read all chunks from"),
  max_chunks: z
    .number()
    .int()
    .min(1)
    .max(50)
    .default(10)
    .optional()
    .describe("Maximum chunks to return"),
  scope: z
    .enum(["context", "library", "collection"])
    .default("library")
    .optional()
    .describe(
      "Scope: 'library' (all indexed), 'context' (items in chat), or 'collection' (specific collection)",
    ),
  library_id: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Library ID to restrict to a specific library"),
  collection_id: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Collection ID (required if scope is 'collection')"),
});

export const SearchSimilarParamsSchema = z.object({
  item_id: z
    .number()
    .int()
    .positive()
    .describe("Item ID to find similar items to"),
  top_k: z
    .number()
    .int()
    .min(1)
    .max(20)
    .default(5)
    .optional()
    .describe("Number of similar items to return"),
  min_score: z
    .number()
    .int()
    .min(0)
    .max(100)
    .default(30)
    .optional()
    .describe("Minimum relevance score 0-100"),
  scope: z
    .enum(["context", "library", "collection"])
    .default("library")
    .optional()
    .describe("Scope to search within for similar items"),
  library_id: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Library ID to restrict search"),
  collection_id: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Collection ID (if scope is 'collection')"),
});

// ==================== SCHEMA REGISTRY ====================

const schemaRegistry: Partial<Record<ToolName, z.ZodSchema>> = {
  [TOOL_NAMES.SEARCH_LIBRARY]: SearchLibraryParamsSchema,
  [TOOL_NAMES.SEARCH_EXTERNAL]: SearchExternalParamsSchema,
  [TOOL_NAMES.GET_ITEM_METADATA]: GetItemMetadataParamsSchema,
  [TOOL_NAMES.READ_ITEM_CONTENT]: ReadItemContentParamsSchema,
  [TOOL_NAMES.IMPORT_PAPER]: ImportPaperParamsSchema,
  [TOOL_NAMES.GENERATE_ITEM_TAGS]: GenerateItemTagsParamsSchema,
  [TOOL_NAMES.CONTEXT]: ContextParamsSchema,
  [TOOL_NAMES.COLLECTION]: CollectionParamsSchema,
  [TOOL_NAMES.TABLE]: TableParamsSchema,
  [TOOL_NAMES.NOTE]: NoteParamsSchema,
  [TOOL_NAMES.RELATED_PAPERS]: RelatedPapersParamsSchema,
  [TOOL_NAMES.WEB]: WebParamsSchema,
  [TOOL_NAMES.WORKSPACE_READ_FILE]: WorkspaceReadFileParamsSchema,
  [TOOL_NAMES.WORKSPACE_WRITE_FILE]: WorkspaceWriteFileParamsSchema,
  [TOOL_NAMES.WORKSPACE_EDIT_FILE]: WorkspaceEditFileParamsSchema,
  [TOOL_NAMES.WORKSPACE_GLOB]: WorkspaceGlobParamsSchema,
  [TOOL_NAMES.WORKSPACE_GREP]: WorkspaceGrepParamsSchema,
  [TOOL_NAMES.WORKSPACE_QUESTION]: WorkspaceQuestionParamsSchema,
  [TOOL_NAMES.WORKSPACE_BASH]: WorkspaceBashParamsSchema,
  [TOOL_NAMES.WORKSPACE_DIFF]: WorkspaceDiffParamsSchema,
  [TOOL_NAMES.WORKSPACE_LOG]: WorkspaceLogParamsSchema,
  [TOOL_NAMES.SEMANTIC_SEARCH]: SemanticSearchParamsSchema,
  [TOOL_NAMES.KEYWORD_SEARCH]: KeywordSearchParamsSchema,
  [TOOL_NAMES.READ_CHUNKS]: ReadChunksParamsSchema,
  [TOOL_NAMES.SEARCH_SIMILAR]: SearchSimilarParamsSchema,
  [TOOL_NAMES.SYSTEMATIC_REVIEW]: SystematicReviewParamsSchema,
};

// ==================== SENSITIVITY REGISTRY ====================

type SensitivityLevel = "read" | "write" | "destructive";

const sensitivityRegistry: Record<ToolName, SensitivityLevel> = {
  [TOOL_NAMES.SEARCH_LIBRARY]: "read",
  [TOOL_NAMES.SEARCH_EXTERNAL]: "read",
  [TOOL_NAMES.GET_ITEM_METADATA]: "read",
  [TOOL_NAMES.READ_ITEM_CONTENT]: "read",
  [TOOL_NAMES.IMPORT_PAPER]: "write",
  [TOOL_NAMES.GENERATE_ITEM_TAGS]: "write",
  [TOOL_NAMES.CONTEXT]: "write",
  [TOOL_NAMES.COLLECTION]: "write",
  [TOOL_NAMES.TABLE]: "write",
  [TOOL_NAMES.NOTE]: "write",
  [TOOL_NAMES.RELATED_PAPERS]: "read",
  [TOOL_NAMES.WEB]: "read",
  [TOOL_NAMES.WORKSPACE_READ_FILE]: "read",
  [TOOL_NAMES.WORKSPACE_WRITE_FILE]: "write",
  [TOOL_NAMES.WORKSPACE_EDIT_FILE]: "write",
  [TOOL_NAMES.WORKSPACE_GLOB]: "read",
  [TOOL_NAMES.WORKSPACE_GREP]: "read",
  [TOOL_NAMES.WORKSPACE_QUESTION]: "read",
  [TOOL_NAMES.WORKSPACE_BASH]: "write",
  [TOOL_NAMES.WORKSPACE_DIFF]: "read",
  [TOOL_NAMES.WORKSPACE_LOG]: "read",
  [TOOL_NAMES.TODO_WRITE]: "write",
  [TOOL_NAMES.TODO_READ]: "read",
  [TOOL_NAMES.TASK_COMPLETE]: "write",
  [TOOL_NAMES.SEMANTIC_SEARCH]: "read",
  [TOOL_NAMES.KEYWORD_SEARCH]: "read",
  [TOOL_NAMES.READ_CHUNKS]: "read",
  [TOOL_NAMES.SEARCH_SIMILAR]: "read",
  [TOOL_NAMES.SYSTEMATIC_REVIEW]: "write",
};

// ==================== UTILITIES ====================

export function getToolSensitivity(toolName: string): SensitivityLevel {
  return sensitivityRegistry[toolName as ToolName] || "write";
}

export function requiresApproval(
  toolName: string,
  config: { requireApprovalForDestructive: boolean },
): boolean {
  if (!config.requireApprovalForDestructive) return false;
  return getToolSensitivity(toolName) === "destructive";
}

export function getSchemaForTool(toolName: string): z.ZodSchema | undefined {
  return schemaRegistry[toolName as ToolName];
}

export function validateToolArgs<T>(toolName: string, args: unknown): T {
  const schema = getSchemaForTool(toolName);
  if (!schema) {
    return args as T;
  }
  return schema.parse(args) as T;
}

export function safeValidateToolArgs<T>(
  toolName: string,
  args: unknown,
): { success: true; data: T } | { success: false; error: z.ZodError } {
  const schema = getSchemaForTool(toolName);
  if (!schema) {
    return { success: true, data: args as T };
  }

  const result = schema.safeParse(args);
  if (result.success) {
    return { success: true, data: result.data as T };
  }
  return { success: false, error: result.error };
}

export function formatZodError(error: z.ZodError<unknown>): string {
  return error.issues
    .map((issue: z.ZodIssue) => {
      const path = issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
      return `${path}${issue.message}`;
    })
    .join("; ");
}
