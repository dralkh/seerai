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
  library_id: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Library ID to restrict search (user library or group library)"),
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
            "review",
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
            "review",
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

const systematicReviewParams = z.discriminatedUnion("action", [
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
    action: z.literal("run_evidence_analysis"),
    project_id: z.string().optional(),
    paper_ids: z.array(z.number().int().positive()).min(1).optional(),
  }),
  z.object({
    action: z.literal("run_gap_analysis"),
    project_id: z.string().optional(),
    paper_ids: z.array(z.number().int().positive()).min(1).optional(),
  }),
  z.object({
    action: z.literal("retry_failed_extractions"),
    project_id: z.string().optional(),
  }),
  z.object({
    action: z.literal("get_extraction_logs"),
    project_id: z.string().optional(),
    paper_id: z.number().int().positive().optional(),
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

const workspacePatchParams = z.object({
  path: z.string().describe("File path relative to workspace root"),
  oldString: z.string().describe("Target block to replace"),
  newString: z.string().describe("Replacement block"),
  message: z.string().optional(),
  dryRun: z.boolean().default(false).optional(),
});

const workspaceSearchFilesParams = z.object({
  query: z.string().describe("Filename fragment or content regex"),
  mode: z.enum(["content", "name", "both"]).default("both").optional(),
  include: z.string().optional(),
  path: z.string().optional(),
  limit: z.number().int().min(1).max(500).default(100).optional(),
});

const skillsListParams = z.object({
  query: z.string().optional().describe("Optional skill search query"),
});

const skillViewParams = z.object({
  name: z.string().describe("Skill name or ID"),
});

const skillManageParams = z.object({
  action: z.enum([
    "refresh",
    "enable",
    "disable",
    "trust_source",
    "untrust_source",
    "add_source",
    "remove_source",
  ]),
  skill: z.string().optional(),
  source_path: z.string().optional(),
});

const skillReferenceParams = z.object({
  name: z.string().describe("Skill name or ID"),
  path: z
    .string()
    .optional()
    .describe(
      "Reference file path relative to skill directory (e.g., 'references/api.md')",
    ),
});

const skillInfoParams = z.object({
  name: z.string().describe("Skill name or ID"),
});

const todoAdapterParams = z.discriminatedUnion("action", [
  z.object({ action: z.literal("read") }),
  z.object({
    action: z.literal("write"),
    todos: z.array(
      z.object({
        id: z.string(),
        content: z.string(),
        status: z.enum(["pending", "in_progress", "completed", "cancelled"]),
      }),
    ),
  }),
]);

const delegateTaskParams = z.object({
  task: z.string(),
  context: z.string().optional(),
});

const mixtureOfAgentsParams = z.object({
  task: z.string(),
  agents: z
    .array(
      z.object({
        name: z.string().optional(),
        instruction: z.string(),
      }),
    )
    .max(4)
    .optional(),
});

const terminalParams = z.object({
  command: z.string().describe("Command to execute"),
  workdir: z.string().optional(),
  timeoutMs: z.number().int().min(1000).max(300000).optional(),
  maxOutputBytes: z.number().int().min(1024).max(262144).optional(),
  background: z.boolean().default(false).optional(),
});

const processParams = z.object({
  action: z.enum(["list", "poll", "log", "wait", "kill", "write"]),
  processId: z.string().optional(),
  input: z.string().optional(),
  timeoutMs: z.number().int().min(1000).max(300000).optional(),
});

const executeCodeParams = z.object({
  language: z.enum(["python", "javascript", "bash"]),
  code: z.string(),
  workdir: z.string().optional(),
  timeoutMs: z.number().int().min(1000).max(300000).optional(),
  maxOutputBytes: z.number().int().min(1024).max(262144).optional(),
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
      "If any work remains, do NOT call this tool. For simple tasks, just provide a text-only answer instead.",
    inputSchema: taskCompleteParams,
  },
  {
    name: "skills_list",
    description: "List and search SeerAI Agent Skills.",
    inputSchema: skillsListParams,
  },
  {
    name: "skill_view",
    description: "View and activate the full instructions for one Agent Skill.",
    inputSchema: skillViewParams,
  },
  {
    name: "skill_manage",
    description:
      "Manage local Agent Skills registry state and trusted sources.",
    inputSchema: skillManageParams,
  },
  {
    name: "skill_reference",
    description:
      "Read a reference or script file from a bundled skill directory. Use this to access API documentation, configuration templates, or utility scripts included with a skill.",
    inputSchema: skillReferenceParams,
  },
  {
    name: "skill_info",
    description:
      "Get filesystem information about a bundled skill: absolute skill directory path, available scripts, references, and assets. Use before executing skill scripts so you know the correct paths.",
    inputSchema: skillInfoParams,
  },
  {
    name: "todo",
    description: "PAgent-compatible TODO wrapper over todoread/todowrite.",
    inputSchema: todoAdapterParams,
  },
  {
    name: "clarify",
    description: "PAgent-compatible clarification tool.",
    inputSchema: workspaceQuestionParams,
  },
  {
    name: "delegate_task",
    description: "Run a bounded non-tool sub-agent task through the plugin.",
    inputSchema: delegateTaskParams,
  },
  {
    name: "mixture_of_agents",
    description: "Run bounded non-tool sub-agent perspectives and synthesize.",
    inputSchema: mixtureOfAgentsParams,
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
  {
    name: "systematic_review",
    description:
      "Read and update systematic review projects, analyze papers, save grounded extraction data, and run or inspect evidence synthesis and gap analysis.",
    inputSchema: systematicReviewParams,
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
      "Read the full content of a paper including notes and PDF text. Returns pre-indexed chunks from the semantic index when available.",
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

  // ==================== RAG / Search Tools ====================
  {
    name: "semantic_search",
    description:
      "Semantically search your Zotero library for relevant passages. " +
      "Use this to find information across your papers, notes, and PDFs, " +
      "even when the exact wording differs from your query. " +
      "Returns ranked passages with relevance scores and source attribution. " +
      "This is ideal for finding concepts, themes, and evidence across your entire library.",
    inputSchema: z.object({
      query: z
        .string()
        .describe(
          "Natural language search query. Be specific about what you're looking for.",
        ),
      scope: z
        .enum(["context", "library", "collection"])
        .default("context")
        .optional()
        .describe(
          "What to search: 'context' (items currently in chat context), " +
            "'library' (entire library), or 'collection' (specific collection)",
        ),
      library_id: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          "Library ID to restrict search (user library or group library)",
        ),
      collection_id: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          "Collection ID (if scope is 'collection'). Collections are always searched recursively including sub-collections.",
        ),
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
          "Filter results to specific chunk sources (e.g. ['pdf', 'abstract'])",
        ),
      include_full_text: z
        .boolean()
        .default(false)
        .optional()
        .describe("Include full passage text instead of 1000-char preview"),
    }),
  },
  {
    name: "keyword_search",
    description:
      "Fast keyword-based search of your Zotero library using BM25 lexical matching. " +
      "Use for exact terminology searches (gene names, chemical compounds, " +
      "mathematical concepts, author names) where precise word matching matters. " +
      "This is faster and cheaper than semantic_search — " +
      "try this first, then escalate to semantic_search for conceptual understanding.",
    inputSchema: z.object({
      query: z.string().describe("Search terms for exact matching"),
      scope: z
        .enum(["context", "library", "collection"])
        .default("context")
        .optional()
        .describe("What to search"),
      library_id: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          "Library ID to restrict search (user library or group library)",
        ),
      collection_id: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          "Collection ID (if scope is 'collection'). Collections are always searched recursively including sub-collections.",
        ),
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
    }),
  },
  {
    name: "read_chunks",
    description:
      "Read specific text chunks/passages from indexed papers by chunk ID or item ID. " +
      "Use after semantic_search or keyword_search to get the full text of interesting passages. " +
      "Respects scope restrictions — chunks outside the specified scope are excluded.",
    inputSchema: z.object({
      chunk_ids: z
        .array(z.string())
        .optional()
        .describe(
          "List of chunk IDs to read (e.g. from semantic_search results)",
        ),
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
        .default("context")
        .optional()
        .describe(
          "Scope: 'context' (items in chat), 'library' (all indexed), or 'collection' (specific collection)",
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
        .describe(
          "Collection ID (required if scope is 'collection'). Collections are always searched recursively.",
        ),
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
      "Execute a bash command within the workspace. The command runs in a shell with full filesystem access confined to the workspace directory. Use for package installation (pip install, npm install), running scripts, git operations, and file processing. Prefer workspace file tools (read_file, write_file, edit_file, glob, grep) for simple file operations.",
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
  {
    name: "read_file",
    description: "Read a workspace text file with pagination.",
    inputSchema: workspaceReadFileParams,
  },
  {
    name: "write_file",
    description: "Write or overwrite a workspace file completely.",
    inputSchema: workspaceWriteFileParams,
  },
  {
    name: "patch",
    description: "Apply a targeted fuzzy patch to a workspace file.",
    inputSchema: workspacePatchParams,
  },
  {
    name: "search_files",
    description: "Search workspace filenames and file contents.",
    inputSchema: workspaceSearchFilesParams,
  },
  {
    name: "terminal",
    description:
      "Execute a shell command in the workspace through guarded MCP execution.",
    inputSchema: terminalParams,
  },
  {
    name: "process",
    description: "Manage background terminal processes.",
    inputSchema: processParams,
  },
  {
    name: "execute_code",
    description: "Run a temporary Python, JavaScript, or Bash snippet.",
    inputSchema: executeCodeParams,
  },
  {
    name: "check_environment",
    description:
      "Check available runtimes and tools on the host computer. Reports Python, Node, Git, pip/npm versions, and shell availability. Use before installing packages or running skill scripts.",
    inputSchema: z.object({}),
  },
  {
    name: "search_similar",
    description:
      "Find papers similar to a given item using embedding similarity. " +
      "Use this to discover related papers, find alternative sources, or explore a research topic. " +
      "The source item must be indexed first.",
    inputSchema: z.object({
      item_id: z
        .number()
        .int()
        .positive()
        .describe("Item ID to find similar papers to"),
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
        .describe("Minimum similarity score 0-100"),
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
        .describe(
          "Collection ID (if scope is 'collection'). Collections are always searched recursively with sub-collections.",
        ),
    }),
  },
];

export type ToolName = (typeof TOOL_DEFINITIONS)[number]["name"];
