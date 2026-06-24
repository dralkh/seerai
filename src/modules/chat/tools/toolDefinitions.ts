/**
 * Tool Definitions for Agentic Chat
 * OpenAI-compatible function schemas
 */

import { ToolDefinition, TOOL_NAMES } from "./toolTypes";
import { workspaceToolDefinitions } from "../workspace/tools";

/**
 * All available tools for the agent
 */
export const agentTools: ToolDefinition[] = [
  // ==================== TODO & Completion ====================
  {
    type: "function",
    function: {
      name: "todowrite",
      description:
        "Create or update a structured task list for your current coding session. Use this to plan multi-step tasks. " +
        "Create items with status 'pending', 'in_progress', 'completed', or 'cancelled'. " +
        "Always create a plan before starting multi-step work. Update status as you progress.",
      parameters: {
        type: "object",
        properties: {
          todos: {
            type: "array",
            description:
              "The full task list. Each item must have id, content, and status.",
            items: {
              type: "object",
              properties: {
                id: { type: "string", description: "Unique identifier" },
                content: { type: "string", description: "Task description" },
                status: {
                  type: "string",
                  enum: ["pending", "in_progress", "completed", "cancelled"],
                },
              },
              required: ["id", "content", "status"],
            },
          },
        },
        required: ["todos"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "todoread",
      description:
        "Read the current TODO list to recover task state after context compaction or to check progress.",
      parameters: {
        type: "object",
        properties: {},
      },
    },
  },
  {
    type: "function",
    function: {
      name: "task_complete",
      description:
        "Signal that ALL work is complete and the user's request has been fully satisfied. " +
        "Only call this when every TODO item is marked 'completed' or 'cancelled'. " +
        "This ends the agent loop and returns control to the user. " +
        "Prefer simply providing a text-only final answer when the task is straightforward; " +
        "use this tool only when you need to explicitly signal completion after tool work.",
      parameters: {
        type: "object",
        properties: {
          summary: {
            type: "string",
            description: "Brief summary of what was accomplished",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: TOOL_NAMES.SKILLS_LIST,
      description:
        "List and search SeerAI Agent Skills. Use this to discover available research workflows before activating one.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Optional skill search query",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: TOOL_NAMES.SKILL_VIEW,
      description:
        "View and activate the full instructions for one Agent Skill by name or ID.",
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "Skill name or ID",
          },
        },
        required: ["name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: TOOL_NAMES.SKILL_MANAGE,
      description:
        "Manage Agent Skills: refresh, enable/disable skills, and add or trust local skill sources.",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: [
              "refresh",
              "enable",
              "disable",
              "trust_source",
              "untrust_source",
              "add_source",
              "remove_source",
            ],
            description: "Management action",
          },
          skill: {
            type: "string",
            description: "Skill name or ID for enable/disable",
          },
          source_path: {
            type: "string",
            description: "Local skill source path",
          },
        },
        required: ["action"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: TOOL_NAMES.SKILL_INFO,
      description:
        "Get filesystem information about a bundled skill. Returns the absolute filesystem path to the skill directory and lists available scripts, references, and assets. Use this before executing skill scripts so the agent knows the correct paths.",
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "Skill name or ID",
          },
        },
        required: ["name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: TOOL_NAMES.SKILL_REFERENCE,
      description:
        "Read a reference, script, or asset file from a bundled skill directory. Use to access API documentation, configuration templates, sample scripts, or reference materials included with a skill. Call after skill_view to inspect skill-specific resources.",
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "Skill name or ID",
          },
          path: {
            type: "string",
            description:
              "File path relative to skill directory (e.g., 'references/api.md', 'scripts/exa_search.py'). Omit to read the main SKILL.md.",
          },
        },
        required: ["name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: TOOL_NAMES.TERMINAL,
      description:
        "Execute a shell command on the host machine through the SeerAI MCP execution server. The command runs in the workspace directory (or a specified subdirectory). Use for: installing packages (pip install, npm install), running scripts (python, bash), file operations (git, curl, unzip), system utilities, and any task that requires real terminal access. The MCP execution server must be running with SEERAI_ENABLE_TERMINAL_TOOLS=1.",
      parameters: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "Shell command to execute",
          },
          workdir: {
            type: "string",
            description:
              "Working directory relative to workspace root (default: workspace root)",
          },
          timeoutMs: {
            type: "integer",
            description:
              "Timeout in milliseconds (default: 30000, max: 300000)",
          },
          maxOutputBytes: {
            type: "integer",
            description: "Max output bytes (default: 65536, max: 262144)",
          },
          background: {
            type: "boolean",
            description:
              "Run in background and return immediately with a processId. Use the 'process' tool to manage background processes.",
          },
        },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: TOOL_NAMES.PROCESS,
      description:
        "Manage background terminal processes started via the terminal tool with background=true. List all processes, poll for output, wait for completion, kill processes, or send input to stdin.",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["list", "poll", "log", "wait", "kill", "write"],
            description: "Process management action",
          },
          processId: {
            type: "string",
            description:
              "Process ID from terminal background call (required for poll/log/wait/kill/write)",
          },
          input: {
            type: "string",
            description: "Text to write to process stdin",
          },
          timeoutMs: {
            type: "integer",
            description: "Timeout in milliseconds for wait (default: 30000)",
          },
        },
        required: ["action"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: TOOL_NAMES.EXECUTE_CODE,
      description:
        "Run a temporary Python, JavaScript, or Bash code snippet. The code is written to a temp file in the workspace and executed. Use for quick calculations, data processing, testing logic, or running code from skill instructions without creating permanent files.",
      parameters: {
        type: "object",
        properties: {
          language: {
            type: "string",
            enum: ["python", "javascript", "bash"],
            description: "Programming language",
          },
          code: {
            type: "string",
            description: "Source code to execute",
          },
          workdir: {
            type: "string",
            description:
              "Working directory relative to workspace root (default: workspace root)",
          },
          timeoutMs: {
            type: "integer",
            description:
              "Timeout in milliseconds (default: 30000, max: 300000)",
          },
          maxOutputBytes: {
            type: "integer",
            description: "Max output bytes (default: 65536, max: 262144)",
          },
        },
        required: ["language", "code"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: TOOL_NAMES.CHECK_ENVIRONMENT,
      description:
        "Check which runtimes and tools are available on this computer. Reports Python, Node, Git, pip/npm versions, and whether the shell is accessible. Use this at the start of a session to determine what commands the agent can run, or before installing packages required by a skill.",
      parameters: {
        type: "object",
        properties: {},
      },
    },
  },
  {
    type: "function",
    function: {
      name: TOOL_NAMES.TODO,
      description:
        "PAgent-compatible TODO wrapper. Use action='read' to inspect tasks or action='write' to replace the task list.",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["read", "write"],
            description: "Read or write TODO state",
          },
          todos: {
            type: "array",
            description: "Full TODO list when action is write",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                content: { type: "string" },
                status: {
                  type: "string",
                  enum: ["pending", "in_progress", "completed", "cancelled"],
                },
              },
              required: ["id", "content", "status"],
            },
          },
        },
        required: ["action"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: TOOL_NAMES.CLARIFY,
      description:
        "PAgent-compatible clarification tool. Ask the user one or more interactive questions.",
      parameters: {
        type: "object",
        properties: {
          questions: {
            type: "array",
            description: "Questions to ask the user",
            items: {
              type: "object",
              properties: {
                question: { type: "string" },
                header: { type: "string" },
                options: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      label: { type: "string" },
                      description: { type: "string" },
                    },
                    required: ["label", "description"],
                  },
                },
                multiple: { type: "boolean" },
              },
              required: ["question", "header", "options"],
            },
          },
        },
        required: ["questions"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: TOOL_NAMES.DELEGATE_TASK,
      description:
        "Run a bounded non-tool sub-agent call for a focused research or writing subtask. The sub-agent cannot access tools or files.",
      parameters: {
        type: "object",
        properties: {
          task: { type: "string", description: "Subtask prompt" },
          context: { type: "string", description: "Optional context" },
        },
        required: ["task"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: TOOL_NAMES.MIXTURE_OF_AGENTS,
      description:
        "Run up to four bounded non-tool sub-agent perspectives and synthesize their outputs.",
      parameters: {
        type: "object",
        properties: {
          task: { type: "string", description: "Task to analyze" },
          agents: {
            type: "array",
            description: "Optional agent instructions, max 4",
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                instruction: { type: "string" },
              },
              required: ["instruction"],
            },
          },
        },
        required: ["task"],
      },
    },
  },

  ...workspaceToolDefinitions,

  // ==================== Search & Discovery ====================
  {
    type: "function",
    function: {
      name: TOOL_NAMES.SEARCH_LIBRARY,
      description:
        "Search the Zotero library for papers and items matching a query. Returns a list of matching items with basic metadata. Use this to find relevant papers before reading their content.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "Search query - searches across titles, authors, abstracts, and full text. Use relevant keywords from the user's question.",
          },
          filters: {
            type: "object",
            description: "Optional filters to narrow search results",
            properties: {
              year_from: {
                type: "integer",
                description: "Minimum publication year (inclusive)",
              },
              year_to: {
                type: "integer",
                description: "Maximum publication year (inclusive)",
              },
              authors: {
                type: "array",
                items: { type: "string" },
                description: "Filter by author names (partial match)",
              },
              tags: {
                type: "array",
                items: { type: "string" },
                description:
                  "Filter by tags - items must have all of these tags",
              },
              collection: {
                type: "string",
                description: "Filter by collection name",
              },
              item_types: {
                type: "array",
                items: {
                  type: "string",
                  enum: [
                    "journalArticle",
                    "book",
                    "bookSection",
                    "conferencePaper",
                    "report",
                    "thesis",
                    "webpage",
                    "preprint",
                  ],
                },
                description: "Filter by item types",
              },
            },
          },
          limit: {
            type: "integer",
            description:
              "Maximum number of results to return (default: 10, max: 50)",
            default: 10,
          },
          library_id: {
            type: "integer",
            description:
              "Library ID to restrict search to a specific library (user library or group library). Omit to search all libraries.",
          },
        },
        required: ["query"],
      },
    },
  },

  {
    type: "function",
    function: {
      name: TOOL_NAMES.GET_ITEM_METADATA,
      description:
        "Get detailed metadata for a specific Zotero item by its ID. Returns full bibliographic information including authors, abstract, DOI, tags, and collections.",
      parameters: {
        type: "object",
        properties: {
          item_id: {
            type: "integer",
            description: "The Zotero item ID to get metadata for",
          },
        },
        required: ["item_id"],
      },
    },
  },

  // ==================== Content Reading ====================
  {
    type: "function",
    function: {
      name: TOOL_NAMES.READ_ITEM_CONTENT,
      description:
        "Read the full content of an existing Zotero paper/item. Numeric item_id values are Zotero item IDs. String item_id values are read-only aliases for existing Zotero items, such as DOI, arXiv ID, PMID, PMCID, URL, or provider-prefixed IDs; if no matching Zotero item exists, import the paper first. When pre-indexed chunks are available in the semantic index, returns those directly for faster retrieval. Otherwise, extracts text from notes, PDF content, or OCR depending on availability.",
      parameters: {
        type: "object",
        properties: {
          item_id: {
            oneOf: [{ type: "integer" }, { type: "string" }],
            description:
              "Zotero item ID, or an external alias for an existing Zotero item such as DOI, arXiv ID, PMID, PMCID, URL, or provider-prefixed ID",
          },
          include_notes: {
            type: "boolean",
            description: "Whether to include attached notes (default: true)",
            default: true,
          },
          include_pdf: {
            type: "boolean",
            description:
              "Whether to include text from PDF attachments (indexed or OCR)",
          },
          trigger_ocr: {
            type: "boolean",
            description:
              "If true, triggers OCR if no other content is found. Use this for image-only or poorly indexed PDFs.",
          },
          max_length: {
            type: "integer",
            description:
              "Maximum content length to return. If content exceeds this, it will be truncated. Use 0 for no limit.",
          },
        },
        required: ["item_id"],
      },
    },
  },

  {
    type: "function",
    function: {
      name: TOOL_NAMES.SEARCH_EXTERNAL,
      description:
        "Search external scholarly corpora for papers that are not yet in the user's Zotero library. Defaults to Semantic Scholar, or choose smart modes and specific corpora such as PubMed, arXiv, Europe PMC, CORE, BASE, Zenodo, HAL, bioRxiv, medRxiv, and IACR.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Search keywords (titles, authors, topics)",
          },
          year: {
            type: "string",
            description:
              "Year range, e.g., '2022-' for recent papers or '2020-2023'",
          },
          limit: {
            type: "integer",
            description: "Max merged results (1-100, default 10)",
          },
          openAccessPdf: {
            type: "boolean",
            description:
              "If true, only returns papers with available Open Access PDFs",
          },
          mode: {
            type: "string",
            enum: [
              "broad",
              "biomedical",
              "preprints",
              "cryptography",
              "repositories",
              "source",
            ],
            description:
              "Smart corpus mode. Omit for legacy Semantic Scholar-only search. Ignored when provider/providers are set.",
          },
          provider: {
            type: "string",
            enum: [
              "semantic-scholar",
              "arxiv",
              "pubmed",
              "biorxiv",
              "medrxiv",
              "iacr",
              "europe-pmc",
              "core",
              "base",
              "zenodo",
              "hal",
            ],
            description: "Single scholarly corpus to search",
          },
          providers: {
            type: "array",
            description:
              "Explicit list of scholarly corpora to search and merge",
            items: {
              type: "string",
              enum: [
                "semantic-scholar",
                "arxiv",
                "pubmed",
                "biorxiv",
                "medrxiv",
                "iacr",
                "europe-pmc",
                "core",
                "base",
                "zenodo",
                "hal",
              ],
            },
          },
          sort: {
            type: "string",
            enum: ["relevance", "newest", "oldest", "citations"],
            description: "Result sort order",
          },
          filters: {
            type: "object",
            description:
              "Common filters: yearStart, yearEnd, openAccess, hasPdf, publicationTypes, fieldsOfStudy, minCitationCount, venue",
          },
          providerFilters: {
            type: "object",
            description:
              "Corpus-specific filters using Search tab keys, e.g. pubmed.articleType, arxiv.category, zenodo.type/subtype, hal.documentType/domain/language, core.hasFullText",
          },
          concepts: {
            type: "array",
            description:
              "Structured concept groups compiled into each corpus query dialect. Each group has terms, optional mesh, and optional phrase.",
            items: {
              type: "object",
              properties: {
                terms: {
                  type: "array",
                  items: { type: "string" },
                  description: "Synonyms OR-ed together for this concept",
                },
                mesh: {
                  type: "array",
                  items: { type: "string" },
                  description: "MeSH terms used by PubMed where applicable",
                },
                phrase: {
                  type: "boolean",
                  description: "Quote multi-word terms where supported",
                },
              },
              required: ["terms"],
            },
          },
          exclude: {
            type: "array",
            items: { type: "string" },
            description: "Terms to exclude where the corpus supports NOT",
          },
          field: {
            type: "string",
            enum: ["all", "title", "abstract", "title-abstract"],
            description: "Field scope applied where the corpus supports it",
          },
        },
        required: ["query"],
      },
    },
  },

  {
    type: "function",
    function: {
      name: TOOL_NAMES.IMPORT_PAPER,
      description:
        "Import a paper from a federated scholarly corpus into the Zotero library. Accepts paper IDs returned by search_external and common identifiers such as arXiv, DOI, PubMed, Europe PMC, repository, preprint, and Semantic Scholar IDs. This will create or reuse a Zotero item, attempt to download/attach the PDF, and can place it in a specific collection.",
      parameters: {
        type: "object",
        properties: {
          paper_id: {
            type: "string",
            description:
              "Federated scholarly paper identifier, e.g. arxiv:2412.08905v1, pubmed:123456, DOI, PMID, PMCID, URL, or a paperId obtained from search_external",
          },
          paper_ids: {
            type: "array",
            description:
              "Batch of federated scholarly paper identifiers to import",
            items: { type: "string" },
          },
          provider: {
            type: "string",
            enum: [
              "semantic-scholar",
              "arxiv",
              "pubmed",
              "biorxiv",
              "medrxiv",
              "iacr",
              "europe-pmc",
              "core",
              "base",
              "zenodo",
              "hal",
            ],
            description: "Optional corpus hint for ambiguous identifiers",
          },
          target_collection_id: {
            type: "integer",
            description: "Optional: Collection ID to add the imported paper to",
          },
          trigger_ocr: {
            type: "boolean",
            description:
              "Request OCR after import if PDF is found. Ignored when Auto-OCR is disabled in configuration.",
          },
          wait_for_pdf: {
            type: "boolean",
            description:
              "If true, wait for PDF discovery and allowed OCR before returning. Defaults to false for faster item-first import.",
          },
        },
      },
    },
  },

  {
    type: "function",
    function: {
      name: TOOL_NAMES.GENERATE_ITEM_TAGS,
      description:
        "Generate AI-powered tags for a Zotero item based on its content (notes, PDF, or metadata). Tags are automatically applied to the item.",
      parameters: {
        type: "object",
        properties: {
          item_id: {
            type: "integer",
            description: "The Zotero item ID to generate tags for",
          },
        },
        required: ["item_id"],
      },
    },
  },

  // ==================== Consolidated Tools ====================

  {
    type: "function",
    function: {
      name: TOOL_NAMES.CONTEXT,
      description:
        "Manage conversation context. Add items (papers, tags, authors, collections) to focus the conversation, remove them, or list current context.",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["add", "remove", "list"],
            description:
              "Action to perform: 'add' items to context, 'remove' items, or 'list' current context",
          },
          items: {
            type: "array",
            description:
              "Items to add/remove (required for add/remove actions)",
            items: {
              type: "object",
              properties: {
                type: {
                  type: "string",
                  enum: [
                    "paper",
                    "tag",
                    "author",
                    "collection",
                    "topic",
                    "table",
                    "review",
                  ],
                },
                id: {
                  type: "string",
                  description: "Item ID (string or number)",
                },
                name: { type: "string" },
              },
              required: ["type"],
            },
          },
        },
        required: ["action"],
      },
    },
  },

  {
    type: "function",
    function: {
      name: TOOL_NAMES.COLLECTION,
      description:
        "Manage Zotero collections. Find, create, list contents, or add/remove items from collections.",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["find", "create", "list", "add_item", "remove_item"],
            description: "Action to perform on collections",
          },
          name: {
            type: "string",
            description: "Collection name (for find/create)",
          },
          collection_id: {
            type: "integer",
            description: "Collection ID (for list/add_item/remove_item)",
          },
          parent_id: {
            type: "integer",
            description: "Parent collection ID (for create/find)",
          },
          library_id: { type: "integer", description: "Library ID" },
          item_ids: {
            type: "array",
            items: { type: "integer" },
            description: "Item IDs (for add_item/remove_item)",
          },
          remove_from_others: {
            type: "boolean",
            description: "Remove from other collections when adding",
          },
        },
        required: ["action"],
      },
    },
  },

  {
    type: "function",
    function: {
      name: TOOL_NAMES.TABLE,
      description:
        "Manage research analysis tables. List tables, create new tables, add papers, add columns, generate AI data, or read table contents.",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: [
              "list",
              "create",
              "add_papers",
              "add_column",
              "generate",
              "read",
            ],
            description: "Action to perform on tables",
          },
          table_id: {
            type: "string",
            description:
              "Table ID (optional for list/read, required for others)",
          },
          name: { type: "string", description: "Table name (for create)" },
          paper_ids: {
            type: "array",
            items: { type: "integer" },
            description: "Paper IDs (for create/add_papers)",
          },
          column_name: {
            type: "string",
            description: "Column name (for add_column)",
          },
          ai_prompt: {
            type: "string",
            description:
              "AI prompt for column data generation (for add_column)",
          },
          column_id: {
            type: "string",
            description: "Specific column ID (for generate)",
          },
          item_ids: {
            type: "array",
            items: { type: "integer" },
            description: "Specific items (for generate)",
          },
          include_data: {
            type: "boolean",
            description: "Include cell data (for read)",
          },
        },
        required: ["action"],
      },
    },
  },

  {
    type: "function",
    function: {
      name: TOOL_NAMES.NOTE,
      description:
        "Create or edit Zotero notes. Create new notes attached to items/collections, or edit existing notes with replace/insert/append/prepend/delete operations.",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["create", "edit"],
            description: "Action: 'create' new note or 'edit' existing note",
          },
          parent_item_id: {
            type: "integer",
            description: "Parent item ID (for create)",
          },
          collection_id: {
            type: "integer",
            description: "Collection ID (for create)",
          },
          note_id: { type: "integer", description: "Note ID (for edit)" },
          title: { type: "string", description: "Note title (for create)" },
          content: {
            type: "string",
            description: "Note content (markdown supported)",
          },
          operations: {
            type: "array",
            items: {
              type: "object",
              properties: {
                type: {
                  type: "string",
                  enum: ["replace", "insert", "append", "prepend", "delete"],
                },
                search: { type: "string" },
                content: { type: "string" },
                position: { type: "string" },
                replace_all: { type: "boolean" },
              },
              required: ["type"],
            },
          },
          convert_markdown: { type: "boolean", default: true },
        },
        required: ["action"],
      },
    },
  },

  {
    type: "function",
    function: {
      name: TOOL_NAMES.RELATED_PAPERS,
      description:
        "Find related papers via citations (forward) or references (backward).",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["citations", "references"],
            description:
              "Action: 'citations' for papers citing this one, 'references' for papers this one cites",
          },
          paper_id: {
            type: "string",
            description: "Semantic Scholar paper ID",
          },
          limit: { type: "integer", default: 10 },
        },
        required: ["action", "paper_id"],
      },
    },
  },

  {
    type: "function",
    function: {
      name: TOOL_NAMES.WEB,
      description: "Search the web or read webpage content.",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["search", "read"],
            description: "Action: 'search' the web or 'read' a specific URL",
          },
          query: { type: "string", description: "Search query (for search)" },
          url: { type: "string", description: "URL to read (for read)" },
          limit: { type: "integer", default: 5 },
        },
        required: ["action"],
      },
    },
  },

  {
    type: "function",
    function: {
      name: TOOL_NAMES.SEMANTIC_SEARCH,
      description:
        "Semantically search your Zotero library for relevant passages. " +
        "Use this to find information across your papers, notes, and PDFs, " +
        "even when the exact wording differs from your query. " +
        "Returns ranked passages with relevance scores and source attribution. " +
        "This is ideal for finding concepts, themes, and evidence across your entire library. " +
        "Default scope is 'library' — searches all indexed items. Use 'collection' with a collection_id to search a specific folder. " +
        "Use 'context' only when the user has explicitly added specific papers to the chat context.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "Natural language search query. Be specific about what you're looking for.",
          },
          scope: {
            type: "string",
            enum: ["context", "library", "collection"],
            description:
              "What to search. Default is 'library' (all indexed items). Use 'collection' with a collection_id for a specific folder. Use 'context' only when user has added papers to chat context.",
          },
          library_id: {
            type: "integer",
            description:
              "Library ID to restrict search to a specific library. Use when scope is 'library' to narrow to a user or group library.",
          },
          collection_id: {
            type: "number",
            description:
              "Collection ID (required if scope is 'collection'). Collections are always searched recursively including sub-collections.",
          },
          top_k: {
            type: "number",
            description: "Number of results to return (default: 5, max: 20)",
          },
          min_score: {
            type: "number",
            description: "Minimum relevance score 0-100 (default: 30)",
          },
          sources: {
            type: "array",
            items: {
              type: "string",
              enum: ["abstract", "pdf", "note", "metadata", "table", "file"],
            },
            description:
              "Filter results to specific chunk sources. 'abstract' for paper abstracts, 'pdf' for full-text PDF content, 'note' for user notes. Omit to search all sources.",
          },
          include_full_text: {
            type: "boolean",
            description:
              "Include full passage text instead of a 1000-character preview (default: false). Set to true when you need complete context from a passage.",
          },
        },
        required: ["query"],
      },
    },
  },

  {
    type: "function",
    function: {
      name: TOOL_NAMES.KEYWORD_SEARCH,
      description:
        "Fast keyword-based search of your Zotero library using BM25 lexical matching. " +
        "Use this for exact terminology searches (gene names, chemical compounds, " +
        "mathematical concepts, author names) where precise word matching matters. " +
        "This is faster and cheaper than semantic_search — use it first, " +
        "then escalate to semantic_search if you need conceptual understanding. " +
        "Default scope is 'library' — searches all indexed items. Use 'collection' with a collection_id for a specific folder. " +
        "Use 'context' only when the user has explicitly added specific papers to chat context.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "Search terms for exact matching. Use specific terminology, gene names, " +
              "compound names, or technical terms",
          },
          scope: {
            type: "string",
            enum: ["context", "library", "collection"],
            description:
              "What to search. Default is 'library' (all indexed items). Use 'collection' with a collection_id for a specific folder. Use 'context' only when user has added papers to chat context.",
          },
          library_id: {
            type: "integer",
            description:
              "Library ID to restrict search to a specific library. Use when scope is 'library' to narrow to a user or group library.",
          },
          collection_id: {
            type: "number",
            description:
              "Collection ID (required if scope is 'collection'). Collections are always searched recursively including sub-collections.",
          },
          top_k: {
            type: "number",
            description: "Number of results to return (default: 5, max: 20)",
          },
          sources: {
            type: "array",
            items: {
              type: "string",
              enum: ["abstract", "pdf", "note", "metadata", "table", "file"],
            },
            description:
              "Filter results to specific chunk sources. 'pdf' for full-text content, 'abstract' for abstracts, 'note' for user notes. Omit to search all sources.",
          },
        },
        required: ["query"],
      },
    },
  },

  {
    type: "function",
    function: {
      name: TOOL_NAMES.READ_CHUNKS,
      description:
        "Read specific text chunks/passages from indexed papers by chunk ID or item ID. Use after semantic_search or keyword_search to get the full text of interesting passages. " +
        "Respects scope restrictions — chunks outside the specified scope are excluded. Requires either chunk_ids or item_id.",
      parameters: {
        type: "object",
        properties: {
          chunk_ids: {
            type: "array",
            items: { type: "string" },
            description:
              "List of chunk IDs to read (e.g. from semantic_search results). Required if item_id is not provided.",
          },
          item_id: {
            type: "number",
            description:
              "Item ID to read all chunks from (returns top matched chunks). Required if chunk_ids is not provided.",
          },
          max_chunks: {
            type: "number",
            description: "Maximum chunks to return (default: 10, max: 50)",
          },
          scope: {
            type: "string",
            enum: ["context", "library", "collection"],
            description:
              "Scope to restrict which items can be read. Default is 'library' (all indexed items). Use 'context' only when user has added papers to chat context.",
          },
          library_id: {
            type: "integer",
            description:
              "Library ID to restrict to a specific library. Use with scope 'library' to narrow to a user or group library.",
          },
          collection_id: {
            type: "number",
            description:
              "Collection ID. Required if scope is 'collection'. (Collections are always searched recursively with sub-collections.)",
          },
        },
      },
    },
  },

  {
    type: "function",
    function: {
      name: TOOL_NAMES.SEARCH_SIMILAR,
      description:
        "Find papers similar to a given item using embedding similarity. " +
        "Use this to discover related papers, find alternative sources, or explore a research topic. " +
        "The source item must be indexed (add it to chat context first).",
      parameters: {
        type: "object",
        properties: {
          item_id: {
            type: "number",
            description: "Item ID to find similar papers to",
          },
          top_k: {
            type: "number",
            description:
              "Number of similar items to return (default: 5, max: 20)",
          },
          min_score: {
            type: "number",
            description: "Minimum similarity score 0-100 (default: 30)",
          },
          scope: {
            type: "string",
            enum: ["context", "library", "collection"],
            description:
              "Where to search for similar items: 'context' (current chat), 'library' (all indexed), or 'collection' (specific collection). Default: 'library'.",
          },
          library_id: {
            type: "integer",
            description: "Library ID to restrict search to a specific library",
          },
          collection_id: {
            type: "number",
            description: "Collection ID (required if scope is 'collection')",
          },
        },
        required: ["item_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: TOOL_NAMES.SYSTEMATIC_REVIEW,
      description:
        "Read and update systematic review projects, analyze included papers, save grounded extraction data, and run or inspect evidence synthesis and gap analysis. Generated judgments remain drafts until reviewed.",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: [
              "list_projects",
              "get_project",
              "get_records",
              "get_synthesis",
              "get_gaps",
              "get_prisma",
              "get_sources",
              "sync_sources",
              "get_protocol",
              "validate_protocol",
              "update_protocol",
              "rollback_protocol",
              "create_project",
              "add_papers",
              "remove_papers",
              "get_extraction_template",
              "propose_extraction_template",
              "update_extraction_template",
              "activate_extraction_template",
              "start_analysis_job",
              "start_extraction_job",
              "run_evidence_analysis",
              "run_gap_analysis",
              "retry_failed_extractions",
              "get_extraction_logs",
              "get_review_job",
              "pause_review_job",
              "cancel_review_job",
              "retry_review_job",
              "get_extractions",
              "review_extractions",
              "get_synthesis_readiness",
              "analyze_papers",
              "save_extraction",
              "run_synthesis",
              "confirm_synthesis",
              "generate_gaps",
              "update_gap",
              "screen",
            ],
          },
          project_id: {
            type: "string",
            description: "Target project ID; defaults to the active project",
          },
          name: { type: "string", description: "New project name" },
          paper_ids: {
            type: "array",
            items: { type: "integer" },
            description: "Zotero item IDs",
          },
          paper_id: {
            type: "integer",
            description: "Single Zotero item ID for extraction",
          },
          template_id: {
            type: "string",
            description: "Extraction template ID",
          },
          instructions: {
            type: "string",
            description: "Reviewer instructions for template generation",
          },
          outcomes: {
            type: "array",
            description: "Editable extraction outcome definitions",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                name: { type: "string" },
                aliases: { type: "array", items: { type: "string" } },
                description: { type: "string" },
                measures: {
                  type: "array",
                  items: {
                    type: "string",
                    description:
                      "Measure label: ratio codes OR/RR/HR, continuous MD/SMD, or diagnostic/prognostic labels (AUROC, AUC, Sensitivity, Specificity, PPV, NPV, Accuracy, C-index, AUPRC, Brier score, NRI, percentage).",
                  },
                },
                timepoints: { type: "array", items: { type: "string" } },
                unit: { type: "string" },
                direction: {
                  type: "string",
                  enum: ["higher_better", "lower_better"],
                },
                required: { type: "boolean" },
              },
              required: ["name", "measures"],
            },
          },
          job_id: {
            type: "string",
            description: "Persisted review job ID",
          },
          extraction_ids: {
            type: "array",
            items: { type: "string" },
            description: "Extraction row IDs to verify or reject",
          },
          verification_status: {
            type: "string",
            enum: ["verified", "rejected"],
          },
          extraction_status: {
            type: "string",
            enum: ["proposed", "verified", "rejected"],
          },
          run_id: {
            type: "string",
            description: "Specific synthesis or gap-analysis run ID",
          },
          synthesis_run_id: {
            type: "string",
            description: "Synthesis run to use for gap generation",
          },
          force: {
            type: "boolean",
            description: "Create a new run even when inputs are unchanged",
          },
          domain_id: {
            type: "string",
            description: "Synthesis domain ID to confirm",
          },
          selected_model: {
            type: "string",
            enum: ["common_effect", "random_effects", "narrative"],
            description: "Reviewer-confirmed synthesis method",
          },
          extraction: {
            type: "object",
            properties: {
              id: { type: "string" },
              outcome: { type: "string" },
              effect_type: {
                type: "string",
                description:
                  "Reported measure: ratio codes OR/RR/HR, continuous MD/SMD, or a diagnostic/prognostic label (AUROC, Sensitivity, Specificity, PPV, NPV, C-index, AUPRC, Brier score, NRI, percentage).",
              },
              effect_size: { type: "number" },
              ci_low: { type: "number" },
              ci_high: { type: "number" },
              n: { type: "integer" },
              events: { type: "integer" },
              timepoint: { type: "string" },
              unit: { type: "string" },
              direction: {
                type: "string",
                enum: ["higher_better", "lower_better"],
              },
              source_attachment_id: { type: "integer" },
              source_page: { type: "string" },
              source_quote: { type: "string" },
              verification_status: {
                type: "string",
                enum: ["proposed", "verified"],
              },
            },
            required: [
              "outcome",
              "effect_type",
              "effect_size",
              "ci_low",
              "ci_high",
              "n",
              "events",
            ],
          },
          gap_id: { type: "string" },
          severity: {
            type: "string",
            enum: ["high", "medium", "low"],
          },
          description: { type: "string" },
          implication: { type: "string" },
          status: {
            type: "string",
            enum: ["draft", "accepted", "rejected", "ignored"],
          },
          reviewer_note: { type: "string" },
          decision: {
            type: "string",
            enum: ["undecided", "included", "maybe", "excluded"],
          },
          reason: { type: "string" },
          stage: {
            type: "string",
            enum: ["title_abstract", "full_text", "final"],
          },
          revision_id: {
            type: "string",
            description: "Protocol revision ID to restore",
          },
          research_question: { type: "string" },
          framework: {
            type: "string",
            enum: [
              "PICOTS",
              "PICO",
              "PICOS",
              "PICOT",
              "PICOTT",
              "PECO",
              "PICo",
              "PEO",
              "SPIDER",
              "SPICE",
              "PCC",
            ],
          },
          dimensions: {
            type: "array",
            items: {
              type: "object",
              properties: {
                key: { type: "string" },
                label: { type: "string" },
                description: { type: "string" },
                value: { type: "string" },
                keyword_aids: {
                  type: "array",
                  items: { type: "string" },
                },
                evidence_labels: {
                  type: "array",
                  items: { type: "string" },
                },
              },
              required: ["key", "label", "value"],
            },
          },
          inclusion_rules: {
            type: "array",
            items: { type: "string" },
          },
          exclusion_rules: {
            type: "array",
            items: { type: "string" },
          },
          include_keyword_aids: {
            type: "array",
            items: { type: "string" },
          },
          exclude_keyword_aids: {
            type: "array",
            items: { type: "string" },
          },
          sources: {
            type: "array",
            description:
              "Zotero folders to synchronize as review sources. Supplying an empty array removes all configured folder sources.",
            items: {
              type: "object",
              properties: {
                collection_id: { type: "integer" },
                type: {
                  type: "string",
                  enum: ["Database", "Register", "Other source"],
                },
                label: { type: "string" },
                include_subfolders: {
                  type: "boolean",
                  description: "Include descendant Zotero folders",
                },
              },
              required: ["collection_id", "type", "label"],
            },
          },
        },
        required: ["action"],
      },
    },
  },
];

/**
 * Get a tool definition by name
 */
export function getToolByName(name: string): ToolDefinition | undefined {
  return agentTools.find((t) => t.function.name === name);
}

/**
 * Get agent tools filtered by permission settings.
 * Tools with "deny" permission are excluded so the LLM never sees them.
 * This prevents wasted turns where the LLM calls a denied tool and gets an error.
 */
export function getFilteredAgentTools(): ToolDefinition[] {
  let permissions: Record<string, string> = {};
  let enableExperimentalAgentTools = false;
  try {
    const prefStr = Zotero.Prefs.get(
      "extensions.seerai.tool_permissions",
    ) as string;
    if (prefStr) {
      permissions = JSON.parse(prefStr);
    }
    enableExperimentalAgentTools =
      Zotero.Prefs.get("extensions.seerai.enableExperimentalAgentTools") ===
      true;
  } catch {
    // If prefs can't be read, allow all
  }

  const experimentalTools = new Set<string>([
    TOOL_NAMES.TODO,
    TOOL_NAMES.CLARIFY,
    TOOL_NAMES.DELEGATE_TASK,
    TOOL_NAMES.MIXTURE_OF_AGENTS,
  ]);

  return agentTools.filter((tool) => {
    const name = tool.function.name;
    if (!enableExperimentalAgentTools && experimentalTools.has(name)) {
      return false;
    }
    const perm = permissions[name] || permissions["*"] || "allow";
    return perm !== "deny";
  });
}
