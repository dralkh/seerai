/**
 * Tool Definitions for Agentic Chat
 * OpenAI-compatible function schemas
 */

import { ToolDefinition, TOOL_NAMES } from "./toolTypes";

/**
 * All available tools for the agent
 */
export const agentTools: ToolDefinition[] = [
    // ==================== Search & Discovery ====================
    {
        type: "function",
        function: {
            name: TOOL_NAMES.SEARCH_LIBRARY,
            description: "Search the Zotero library for papers and items matching a query. Returns a list of matching items with basic metadata. Use this to find relevant papers before reading their content.",
            parameters: {
                type: "object",
                properties: {
                    query: {
                        type: "string",
                        description: "Search query - searches across titles, authors, abstracts, and full text. Use relevant keywords from the user's question."
                    },
                    filters: {
                        type: "object",
                        description: "Optional filters to narrow search results",
                        properties: {
                            year_from: {
                                type: "integer",
                                description: "Minimum publication year (inclusive)"
                            },
                            year_to: {
                                type: "integer",
                                description: "Maximum publication year (inclusive)"
                            },
                            authors: {
                                type: "array",
                                items: { type: "string" },
                                description: "Filter by author names (partial match)"
                            },
                            tags: {
                                type: "array",
                                items: { type: "string" },
                                description: "Filter by tags - items must have all of these tags"
                            },
                            collection: {
                                type: "string",
                                description: "Filter by collection name"
                            },
                            item_types: {
                                type: "array",
                                items: {
                                    type: "string",
                                    enum: ["journalArticle", "book", "bookSection", "conferencePaper", "report", "thesis", "webpage", "preprint"]
                                },
                                description: "Filter by item types"
                            }
                        }
                    },
                    limit: {
                        type: "integer",
                        description: "Maximum number of results to return (default: 10, max: 50)",
                        default: 10
                    }
                },
                required: ["query"]
            }
        }
    },

    {
        type: "function",
        function: {
            name: TOOL_NAMES.GET_ITEM_METADATA,
            description: "Get detailed metadata for a specific Zotero item by its ID. Returns full bibliographic information including authors, abstract, DOI, tags, and collections.",
            parameters: {
                type: "object",
                properties: {
                    item_id: {
                        type: "integer",
                        description: "The Zotero item ID to get metadata for"
                    }
                },
                required: ["item_id"]
            }
        }
    },

    // ==================== Content Reading ====================
    {
        type: "function",
        function: {
            name: TOOL_NAMES.READ_ITEM_CONTENT,
            description: "Read the full content of a paper/item. This retrieves text from notes, PDF content, or OCR depending on availability. Use this when you need to analyze the actual content of a paper, not just its metadata.",
            parameters: {
                type: "object",
                properties: {
                    item_id: {
                        type: "integer",
                        description: "The Zotero item ID to read content from"
                    },
                    include_notes: {
                        type: "boolean",
                        description: "Whether to include attached notes (default: true)",
                        default: true
                    },
                    include_pdf: {
                        type: "boolean",
                        description: "Whether to include text from PDF attachments (indexed or OCR)"
                    },
                    trigger_ocr: {
                        type: "boolean",
                        description: "If true, triggers OCR if no other content is found. Use this for image-only or poorly indexed PDFs."
                    },
                    max_length: {
                        type: "integer",
                        description: "Maximum content length to return. If content exceeds this, it will be truncated. Use 0 for no limit."
                    }
                },
                required: ["item_id"]
            }
        }
    },

    // ==================== Note Creation ====================
    {
        type: "function",
        function: {
            name: TOOL_NAMES.CREATE_NOTE,
            description: "Create a new note attached to a Zotero item. Use this to save summaries, analyses, or extracted information for the user.",
            parameters: {
                type: "object",
                properties: {
                    parent_item_id: {
                        type: "integer",
                        description: "Optional: The Zotero item ID to attach the note to as a child."
                    },
                    collection_id: {
                        type: "integer",
                        description: "Optional: The collection ID to create a standalone note in."
                    },
                    title: {
                        type: "string",
                        description: "Title for the note (will be shown as first line)"
                    },
                    content: {
                        type: "string",
                        description: "Note content in HTML or plain text. Markdown will be converted to HTML."
                    },
                    tags: {
                        type: "array",
                        items: { type: "string" },
                        description: "Optional tags to add to the note"
                    }
                },
                required: ["title", "content"]
            }
        }
    },

    {
        type: "function",
        function: {
            name: TOOL_NAMES.EDIT_NOTE,
            description: "Edit an existing Zotero note by applying one or more operations. Use this to update, append to, or modify existing notes instead of creating new ones. Supports replace, insert, append, prepend, and delete operations.",
            parameters: {
                type: "object",
                properties: {
                    note_id: {
                        type: "integer",
                        description: "The ID of the existing note to edit"
                    },
                    operations: {
                        type: "array",
                        description: "List of edit operations to apply in sequence",
                        items: {
                            type: "object",
                            properties: {
                                type: {
                                    type: "string",
                                    enum: ["replace", "insert", "append", "prepend", "delete"],
                                    description: "Type of edit operation"
                                },
                                search: {
                                    type: "string",
                                    description: "Text to search for (required for 'replace' and 'delete')"
                                },
                                content: {
                                    type: "string",
                                    description: "New content (markdown or HTML). Required for replace/insert/append/prepend"
                                },
                                position: {
                                    type: "string",
                                    description: "For 'insert': where to insert ('start', 'end', or HTML tag like 'h1')"
                                },
                                replace_all: {
                                    type: "boolean",
                                    description: "For 'replace': replace all occurrences (default: first only)"
                                }
                            },
                            required: ["type"]
                        }
                    },
                    convert_markdown: {
                        type: "boolean",
                        description: "Convert markdown content to HTML before applying (default: true)"
                    }
                },
                required: ["note_id", "operations"]
            }
        }
    },

    // ==================== Context Management ====================
    {
        type: "function",
        function: {
            name: TOOL_NAMES.ADD_TO_CONTEXT,
            description: "Add items to the current chat context. This makes papers, tags, authors, collections, or topics available for the conversation. Added items will be included in all subsequent responses.",
            parameters: {
                type: "object",
                properties: {
                    items: {
                        type: "array",
                        items: {
                            type: "object",
                            properties: {
                                type: {
                                    type: "string",
                                    enum: ["paper", "tag", "author", "collection", "topic", "table"],
                                    description: "Type of item to add"
                                },
                                id: {
                                    type: "integer",
                                    description: "Item ID (for papers, tables)"
                                },
                                name: {
                                    type: "string",
                                    description: "Name (for tags, authors, collections, topics)"
                                }
                            },
                            required: ["type"]
                        },
                        description: "Items to add to context"
                    }
                },
                required: ["items"]
            }
        }
    },

    {
        type: "function",
        function: {
            name: TOOL_NAMES.REMOVE_FROM_CONTEXT,
            description: "Remove items from the current chat context.",
            parameters: {
                type: "object",
                properties: {
                    items: {
                        type: "array",
                        items: {
                            type: "object",
                            properties: {
                                type: {
                                    type: "string",
                                    enum: ["paper", "tag", "author", "collection", "topic", "table"],
                                    description: "Type of item to remove"
                                },
                                id: {
                                    type: "integer",
                                    description: "Item ID (for papers, tables)"
                                }
                            },
                            required: ["type"]
                        },
                        description: "Items to remove from context"
                    }
                },
                required: ["items"]
            }
        }
    },

    {
        type: "function",
        function: {
            name: TOOL_NAMES.LIST_CONTEXT,
            description: "List all items currently in the chat context. Use this to understand what papers and resources are currently available for the conversation.",
            parameters: {
                type: "object",
                properties: {},
                required: []
            }
        }
    },

    // ==================== Table Management ====================
    {
        type: "function",
        function: {
            name: TOOL_NAMES.LIST_TABLES,
            description: "List all paper analysis tables. Tables contain structured data extracted from papers with AI-generated columns.",
            parameters: {
                type: "object",
                properties: {},
                required: []
            }
        }
    },
    {
        type: "function",
        function: {
            name: TOOL_NAMES.CREATE_TABLE,
            description: "Create a new paper analysis table. Use this when the user wants to start a new analysis or if no tables exist.",
            parameters: {
                type: "object",
                properties: {
                    name: {
                        type: "string",
                        description: "Name of the new table (e.g. 'Acoustic AI Comparison')"
                    },
                    item_ids: {
                        type: "array",
                        items: { type: "integer" },
                        description: "Optional: Initial list of Zotero item IDs to add to the table"
                    }
                },
                required: ["name"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: TOOL_NAMES.ADD_TO_TABLE,
            description: "Add one or more papers to an existing table.",
            parameters: {
                type: "object",
                properties: {
                    table_id: {
                        type: "string",
                        description: "ID of the table to add to"
                    },
                    item_ids: {
                        type: "array",
                        items: { type: "integer" },
                        description: "List of Zotero item IDs to add"
                    }
                },
                required: ["table_id", "item_ids"]
            }
        }
    },

    {
        type: "function",
        function: {
            name: TOOL_NAMES.CREATE_TABLE_COLUMN,
            description: "Create a new AI-powered column in a table. The column will use an AI prompt to extract or generate data from papers.",
            parameters: {
                type: "object",
                properties: {
                    table_id: {
                        type: "string",
                        description: "ID of the table to add the column to"
                    },
                    column_name: {
                        type: "string",
                        description: "Name/title for the new column"
                    },
                    ai_prompt: {
                        type: "string",
                        description: "AI prompt to use for generating column values. Should be a question or instruction like 'What is the sample size?' or 'Summarize the methodology in 2-3 sentences.'"
                    }
                },
                required: ["table_id", "column_name", "ai_prompt"]
            }
        }
    },

    {
        type: "function",
        function: {
            name: TOOL_NAMES.GENERATE_TABLE_DATA,
            description: "Generate AI-powered data for table cells. This runs the column prompts against papers to fill in the table.",
            parameters: {
                type: "object",
                properties: {
                    table_id: {
                        type: "string",
                        description: "ID of the table to generate data for"
                    },
                    column_id: {
                        type: "string",
                        description: "Optional: specific column to generate. If not provided, generates all columns."
                    },
                    item_ids: {
                        type: "array",
                        items: { type: "integer" },
                        description: "Optional: specific item IDs to generate for. If not provided, generates for all items in the table."
                    }
                },
                required: ["table_id"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: TOOL_NAMES.READ_TABLE,
            description: "Read the complete contents of a table including all papers, columns, and generated data. Use this to review table contents, verify generated data, or prepare summaries. Returns structured data with all rows and columns.",
            parameters: {
                type: "object",
                properties: {
                    table_id: {
                        type: "string",
                        description: "ID of the table to read. If not provided, reads the most recently created/updated table."
                    },
                    include_data: {
                        type: "boolean",
                        description: "Whether to include all AI-generated cell data (default: true). Set to false for just structure."
                    }
                },
                required: []
            }
        }
    },
    {
        type: "function",
        function: {
            name: TOOL_NAMES.SEARCH_EXTERNAL,
            description: "Search Semantic Scholar for new academic papers. Use this to find papers that are not yet in the user's Zotero library.",
            parameters: {
                type: "object",
                properties: {
                    query: {
                        type: "string",
                        description: "Search keywords (titles, authors, topics)"
                    },
                    year: {
                        type: "string",
                        description: "Year range, e.g., '2022-' for recent papers or '2020-2023'"
                    },
                    limit: {
                        type: "integer",
                        description: "Max results (1-50, default 10)"
                    },
                    openAccessPdf: {
                        type: "boolean",
                        description: "If true, only returns papers with available Open Access PDFs"
                    }
                },
                required: ["query"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: TOOL_NAMES.IMPORT_PAPER,
            description: "Import a paper from Semantic Scholar into the Zotero library. This will create a new item, attempt to download/attach the PDF, and can place it in a specific collection.",
            parameters: {
                type: "object",
                properties: {
                    paper_id: {
                        type: "string",
                        description: "The Semantic Scholar paper ID (obtained from search_external)"
                    },
                    target_collection_id: {
                        type: "integer",
                        description: "Optional: Collection ID to add the imported paper to"
                    },
                    trigger_ocr: {
                        type: "boolean",
                        description: "Automatically trigger OCR after import if PDF is found"
                    }
                },
                required: ["paper_id"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: TOOL_NAMES.CREATE_COLLECTION,
            description: "Create a new Zotero collection (folder).",
            parameters: {
                type: "object",
                properties: {
                    name: {
                        type: "string",
                        description: "Name of the new collection"
                    },
                    parent_collection_id: {
                        type: "integer",
                        description: "Optional: ID of the parent collection to create this within"
                    },
                    library_id: {
                        type: "integer",
                        description: "Optional: Library ID. Defaults to current or user library."
                    }
                },
                required: ["name"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: TOOL_NAMES.LIST_COLLECTION,
            description: "List the items and sub-collections within a specific Zotero collection. Use this to find notes or specific items by name.",
            parameters: {
                type: "object",
                properties: {
                    collection_id: {
                        type: "integer",
                        description: "ID of the collection to list"
                    }
                },
                required: ["collection_id"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: TOOL_NAMES.FIND_COLLECTION,
            description: "Find Zotero collections by name. Use this to get the collection ID. If parent_collection_id is provided, it searches within that folder.",
            parameters: {
                type: "object",
                properties: {
                    name: {
                        type: "string",
                        description: "Name of the collection to find"
                    },
                    library_id: {
                        type: "integer",
                        description: "Optional: Specific library ID to search in"
                    },
                    parent_collection_id: {
                        type: "integer",
                        description: "Optional: ID of a parent collection to search within"
                    }
                },
                required: ["name"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: TOOL_NAMES.MOVE_ITEM,
            description: "Add an item to a collection and optionally remove it from others. Use this to organize papers into folders like 'Highly Relevant' or 'To Review'.",
            parameters: {
                type: "object",
                properties: {
                    item_id: {
                        type: "integer",
                        description: "Zotero item ID to move"
                    },
                    target_collection_id: {
                        type: "integer",
                        description: "Collection ID to add to"
                    },
                    remove_from_others: {
                        type: "boolean",
                        description: "If true, removes the item from all other collections (effectively moving it)"
                    }
                },
                required: ["item_id", "target_collection_id"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: TOOL_NAMES.REMOVE_ITEM_FROM_COLLECTION,
            description: "Remove an item from a specific collection (without deleting it from the library). Use this to clean up review folders or remove irrelevant papers.",
            parameters: {
                type: "object",
                properties: {
                    item_id: {
                        type: "integer",
                        description: "Zotero item ID to remove"
                    },
                    collection_id: {
                        type: "integer",
                        description: "Collection ID to remove the item from"
                    }
                },
                required: ["item_id", "collection_id"]
            }
        }
    },

    // ==================== Web Research Tools ====================
    {
        type: "function",
        function: {
            name: TOOL_NAMES.SEARCH_WEB,
            description: "Search the general web for information. Use this for finding documentation, blogs, GitHub repositories, or non-academic information.",
            parameters: {
                type: "object",
                properties: {
                    query: {
                        type: "string",
                        description: "Search query"
                    },
                    limit: {
                        type: "integer",
                        description: "Max results (default 5)"
                    }
                },
                required: ["query"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: TOOL_NAMES.READ_WEBPAGE,
            description: "Read the content of any webpage URL as clean markdown. Use this to read blogs, documentation, or news articles found via search_web.",
            parameters: {
                type: "object",
                properties: {
                    url: {
                        type: "string",
                        description: "The URL to read"
                    }
                },
                required: ["url"]
            }
        }
    },

    // ==================== Citation Network Tools ====================
    {
        type: "function",
        function: {
            name: TOOL_NAMES.GET_CITATIONS,
            description: "Find papers that cite a specific paper (Forward Citations). Use this to find newer research that builds upon a key paper.",
            parameters: {
                type: "object",
                properties: {
                    paper_id: {
                        type: "string",
                        description: "Semantic Scholar Paper ID"
                    },
                    limit: {
                        type: "integer",
                        description: "Max results (default 10)"
                    }
                },
                required: ["paper_id"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: TOOL_NAMES.GET_REFERENCES,
            description: "Find papers cited by a specific paper (Backward References). Use this to understand the foundational work that a paper is based on.",
            parameters: {
                type: "object",
                properties: {
                    paper_id: {
                        type: "string",
                        description: "Semantic Scholar Paper ID"
                    },
                    limit: {
                        type: "integer",
                        description: "Max results (default 10)"
                    }
                },
                required: ["paper_id"]
            }
        }
    },

    // ==================== Tag Management Tools ====================
    {
        type: "function",
        function: {
            name: TOOL_NAMES.GENERATE_ITEM_TAGS,
            description: "Generate AI-powered tags for a Zotero item based on its content (notes, PDF, or metadata). Tags are automatically applied to the item.",
            parameters: {
                type: "object",
                properties: {
                    item_id: {
                        type: "integer",
                        description: "The Zotero item ID to generate tags for"
                    }
                },
                required: ["item_id"]
            }
        }
    },

    // ==================== Consolidated Tools ====================

    {
        type: "function",
        function: {
            name: TOOL_NAMES.CONTEXT,
            description: "Manage conversation context. Add items (papers, tags, collections) to focus the conversation, remove them, or list current context.",
            parameters: {
                type: "object",
                properties: {
                    action: {
                        type: "string",
                        enum: ["add", "remove", "list"],
                        description: "Action to perform: 'add' items to context, 'remove' items, or 'list' current context"
                    },
                    items: {
                        type: "array",
                        description: "Items to add/remove (required for add/remove actions)",
                        items: {
                            type: "object",
                            properties: {
                                type: { type: "string", enum: ["paper", "tag", "author", "collection", "topic", "table"] },
                                id: { type: "string", description: "Item ID (string or number)" },
                                name: { type: "string" }
                            },
                            required: ["type"]
                        }
                    }
                },
                required: ["action"]
            }
        }
    },

    {
        type: "function",
        function: {
            name: TOOL_NAMES.COLLECTION,
            description: "Manage Zotero collections. Find, create, list contents, or add/remove items from collections.",
            parameters: {
                type: "object",
                properties: {
                    action: {
                        type: "string",
                        enum: ["find", "create", "list", "add_item", "remove_item"],
                        description: "Action to perform on collections"
                    },
                    name: { type: "string", description: "Collection name (for find/create)" },
                    collection_id: { type: "integer", description: "Collection ID (for list/add_item/remove_item)" },
                    parent_id: { type: "integer", description: "Parent collection ID (for create/find)" },
                    library_id: { type: "integer", description: "Library ID" },
                    item_ids: { type: "array", items: { type: "integer" }, description: "Item IDs (for add_item/remove_item)" },
                    remove_from_others: { type: "boolean", description: "Remove from other collections when adding" }
                },
                required: ["action"]
            }
        }
    },

    {
        type: "function",
        function: {
            name: TOOL_NAMES.TABLE,
            description: "Manage research analysis tables. List tables, create new tables, add papers, add columns, generate AI data, or read table contents.",
            parameters: {
                type: "object",
                properties: {
                    action: {
                        type: "string",
                        enum: ["list", "create", "add_papers", "add_column", "generate", "read"],
                        description: "Action to perform on tables"
                    },
                    table_id: { type: "string", description: "Table ID (optional for list/read, required for others)" },
                    name: { type: "string", description: "Table name (for create)" },
                    paper_ids: { type: "array", items: { type: "integer" }, description: "Paper IDs (for create/add_papers)" },
                    column_name: { type: "string", description: "Column name (for add_column)" },
                    ai_prompt: { type: "string", description: "AI prompt for column data generation (for add_column)" },
                    column_id: { type: "string", description: "Specific column ID (for generate)" },
                    item_ids: { type: "array", items: { type: "integer" }, description: "Specific items (for generate)" },
                    include_data: { type: "boolean", description: "Include cell data (for read)" }
                },
                required: ["action"]
            }
        }
    },

    {
        type: "function",
        function: {
            name: TOOL_NAMES.NOTE,
            description: "Create or edit Zotero notes. Create new notes attached to items/collections, or edit existing notes with replace/insert/append/prepend/delete operations.",
            parameters: {
                type: "object",
                properties: {
                    action: {
                        type: "string",
                        enum: ["create", "edit"],
                        description: "Action: 'create' new note or 'edit' existing note"
                    },
                    parent_item_id: { type: "integer", description: "Parent item ID (for create)" },
                    collection_id: { type: "integer", description: "Collection ID for orphan note (for create)" },
                    title: { type: "string", description: "Note title (for create)" },
                    content: { type: "string", description: "Note content in markdown (for create)" },
                    tags: { type: "array", items: { type: "string" }, description: "Tags (for create)" },
                    note_id: { type: "integer", description: "Note ID to edit (for edit)" },
                    operations: {
                        type: "array",
                        description: "Edit operations (for edit)",
                        items: {
                            type: "object",
                            properties: {
                                type: { type: "string", enum: ["replace", "insert", "append", "prepend", "delete"] },
                                search: { type: "string" },
                                content: { type: "string" },
                                position: { type: "string" },
                                replace_all: { type: "boolean" }
                            },
                            required: ["type"]
                        }
                    },
                    convert_markdown: { type: "boolean", description: "Convert markdown to HTML (for edit)" }
                },
                required: ["action"]
            }
        }
    },

    {
        type: "function",
        function: {
            name: TOOL_NAMES.RELATED_PAPERS,
            description: "Get related papers via citation network. Find papers that cite a given paper (forward citations) or papers it references (backward references).",
            parameters: {
                type: "object",
                properties: {
                    action: {
                        type: "string",
                        enum: ["citations", "references"],
                        description: "Action: 'citations' for papers citing this one, 'references' for papers this one cites"
                    },
                    paper_id: { type: "string", description: "Semantic Scholar paper ID" },
                    limit: { type: "integer", description: "Maximum results (default: 10)" }
                },
                required: ["action", "paper_id"]
            }
        }
    },

    {
        type: "function",
        function: {
            name: TOOL_NAMES.WEB,
            description: "Web research tools. Search the web for information or read/scrape a specific webpage.",
            parameters: {
                type: "object",
                properties: {
                    action: {
                        type: "string",
                        enum: ["search", "read"],
                        description: "Action: 'search' the web or 'read' a specific URL"
                    },
                    query: { type: "string", description: "Search query (for search)" },
                    url: { type: "string", description: "URL to read (for read)" },
                    limit: { type: "integer", description: "Max results (for search, default: 5)" }
                },
                required: ["action"]
            }
        }
    }
];

/**
 * Get all tool definitions for API requests
 */
export function getAgentTools(): ToolDefinition[] {
    return agentTools;
}

/**
 * Get a specific tool definition by name
 */
export function getToolByName(name: string): ToolDefinition | undefined {
    return agentTools.find(t => t.function.name === name);
}
