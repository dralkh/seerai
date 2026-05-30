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
        "Read the full content of a paper/item. When pre-indexed chunks are available in the semantic index, returns those directly for faster retrieval. Otherwise, extracts text from notes, PDF content, or OCR depending on availability. Use this when you need to analyze the actual content of a paper, not just its metadata.",
      parameters: {
        type: "object",
        properties: {
          item_id: {
            type: "integer",
            description: "The Zotero item ID to read content from",
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
        "Search Semantic Scholar for new academic papers. Use this to find papers that are not yet in the user's Zotero library.",
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
            description: "Max results (1-50, default 10)",
          },
          openAccessPdf: {
            type: "boolean",
            description:
              "If true, only returns papers with available Open Access PDFs",
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
        "Import a paper from Semantic Scholar into the Zotero library. This will create a new item, attempt to download/attach the PDF, and can place it in a specific collection.",
      parameters: {
        type: "object",
        properties: {
          paper_id: {
            type: "string",
            description:
              "The Semantic Scholar paper ID (obtained from search_external)",
          },
          target_collection_id: {
            type: "integer",
            description: "Optional: Collection ID to add the imported paper to",
          },
          trigger_ocr: {
            type: "boolean",
            description:
              "Automatically trigger OCR after import if PDF is found",
          },
        },
        required: ["paper_id"],
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
  try {
    const prefStr = Zotero.Prefs.get(
      "extensions.seerai.tool_permissions",
    ) as string;
    if (prefStr) {
      permissions = JSON.parse(prefStr);
    }
  } catch {
    // If prefs can't be read, allow all
  }

  return agentTools.filter((tool) => {
    const name = tool.function.name;
    const perm = permissions[name] || permissions["*"] || "allow";
    return perm !== "deny";
  });
}
