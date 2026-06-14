/**
 * Tool Executor
 * Central dispatcher for executing tool calls
 *
 * @see agentic.md Section 4.1 - Zod validation with self-correction
 */

import {
  ToolCall,
  ParsedToolCall,
  ToolResult,
  AgentConfig,
  defaultAgentConfig,
  TOOL_NAMES,
  // Core types
  SearchLibraryParams,
  GetItemMetadataParams,
  ReadItemContentParams,
  SearchExternalParams,
  ImportPaperParams,
  GenerateItemTagsParams,
  // Unified types
  ContextParams,
  CollectionParams,
  TableParams,
  NoteParams,
  RelatedPapersParams,
  WebParams,
  SemanticSearchParams,
  KeywordSearchParams,
  ReadChunksParams,
  SearchSimilarParams,
  SystematicReviewParams,
} from "./toolTypes";

import { safeValidateToolArgs, formatZodError } from "./schemas";

import {
  executeSearchLibrary,
  executeSearchExternal,
  executeImportPaper,
} from "./searchTool";
import { executeGetItemMetadata, executeReadItemContent } from "./readTool";
import { executeNote } from "./noteTool";
import { executeContext } from "./contextTool";
import { executeTable } from "./tableTool";
import { executeCollection } from "./collectionTool";
import { executeWeb } from "./webTool";
import { executeRelatedPapers } from "./citationTool";
import { executeGenerateItemTags } from "./tagTool";
import {
  executeTodoWrite,
  executeTodoRead,
  checkTodosBeforeComplete,
} from "./todoTool";
import {
  executeSemanticSearch,
  executeKeywordSearch,
  executeReadChunks,
  executeSearchSimilar,
} from "./ragTool";
import { executeWorkspaceTool } from "../workspace/tools";
import { executeSystematicReview } from "./systematicReviewTool";

/**
 * Parse a tool call from API format to typed format
 */
export function parseToolCall<T = Record<string, unknown>>(
  toolCall: ToolCall,
): ParsedToolCall<T> {
  let args: T;
  try {
    args = JSON.parse(toolCall.function.arguments);
  } catch (e) {
    throw new Error(
      `Failed to parse tool arguments: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  return {
    id: toolCall.id,
    name: toolCall.function.name,
    arguments: args,
  };
}

/**
 * Execute a tool call and return the result
 *
 * Implements the self-correction pattern from agentic.md:
 * 1. Parse tool call arguments from JSON
 * 2. Validate with Zod schema
 * 3. If validation fails, return rich error feedback for LLM to self-correct
 * 4. Execute the validated tool
 */
export async function executeToolCall(
  toolCall: ToolCall,
  config: AgentConfig = defaultAgentConfig,
): Promise<ToolResult> {
  try {
    const parsed = parseToolCall(toolCall);

    Zotero.debug(`[seerai] Executing tool: ${parsed.name}`);
    Zotero.debug(
      `[seerai] Tool arguments: ${JSON.stringify(parsed.arguments)}`,
    );

    // Zod validation with self-correction feedback (agentic.md Section 4.1)
    const validation = safeValidateToolArgs(parsed.name, parsed.arguments);
    if (!validation.success) {
      const errorMessage = formatZodError(validation.error);
      Zotero.debug(`[seerai] Tool validation failed: ${errorMessage}`);

      return {
        success: false,
        error: `Validation Error: ${errorMessage}. Please retry the tool call with corrected arguments.`,
      };
    }

    // Check Permissions
    if (!(await checkToolPermission(parsed.name, toolCall.id, config))) {
      return {
        success: false,
        error: `Permission Denied: User denied permission to execute tool '${parsed.name}'.`,
      };
    }

    // Use validated arguments
    const validatedArgs = validation.data;

    switch (parsed.name) {
      // ==================== Core Tools ====================
      case TOOL_NAMES.SEARCH_LIBRARY:
        return await executeSearchLibrary(
          validatedArgs as SearchLibraryParams,
          config,
        );

      case TOOL_NAMES.GET_ITEM_METADATA:
        return await executeGetItemMetadata(
          validatedArgs as GetItemMetadataParams,
          config,
        );

      case TOOL_NAMES.READ_ITEM_CONTENT:
        return await executeReadItemContent(
          validatedArgs as ReadItemContentParams,
          config,
        );

      case TOOL_NAMES.SEARCH_EXTERNAL:
        return await executeSearchExternal(
          validatedArgs as SearchExternalParams,
          config,
        );

      case TOOL_NAMES.IMPORT_PAPER:
        return await executeImportPaper(
          validatedArgs as ImportPaperParams,
          config,
        );

      case TOOL_NAMES.GENERATE_ITEM_TAGS:
        return await executeGenerateItemTags(
          validatedArgs as GenerateItemTagsParams,
          config,
        );

      // ==================== Semantic Search ====================
      case TOOL_NAMES.SEMANTIC_SEARCH:
        return await executeSemanticSearch(
          validatedArgs as SemanticSearchParams,
          config,
        );

      case TOOL_NAMES.KEYWORD_SEARCH:
        return await executeKeywordSearch(
          validatedArgs as KeywordSearchParams,
          config,
        );

      case TOOL_NAMES.READ_CHUNKS:
        return await executeReadChunks(
          validatedArgs as ReadChunksParams,
          config,
        );

      case TOOL_NAMES.SEARCH_SIMILAR:
        return await executeSearchSimilar(
          validatedArgs as SearchSimilarParams,
          config,
        );

      // ==================== Consolidated Tools ====================

      case TOOL_NAMES.CONTEXT:
        return await executeContext(validatedArgs as ContextParams, config);

      case TOOL_NAMES.COLLECTION:
        return await executeCollection(
          validatedArgs as CollectionParams,
          config,
        );

      case TOOL_NAMES.TABLE:
        return await executeTable(validatedArgs as TableParams, config);

      case TOOL_NAMES.NOTE:
        return await executeNote(validatedArgs as NoteParams, config);

      case TOOL_NAMES.RELATED_PAPERS:
        return await executeRelatedPapers(
          validatedArgs as RelatedPapersParams,
          config,
        );

      case TOOL_NAMES.WEB:
        return await executeWeb(validatedArgs as WebParams, config);

      case TOOL_NAMES.SYSTEMATIC_REVIEW:
        return await executeSystematicReview(
          validatedArgs as SystematicReviewParams,
        );

      // ==================== TODO & Completion ====================

      case TOOL_NAMES.TODO_WRITE:
        return await executeTodoWrite(
          validatedArgs as { todos: import("./toolTypes").TodoItem[] },
        );

      case TOOL_NAMES.TODO_READ:
        return await executeTodoRead();

      case TOOL_NAMES.TASK_COMPLETE: {
        const check = await checkTodosBeforeComplete();
        if (!check.canComplete) {
          return { success: false, error: check.message };
        }
        return {
          success: true,
          summary: "Task complete — all TODOs finished.",
        };
      }

      // ==================== Workspace Tools ====================
      case TOOL_NAMES.WORKSPACE_READ_FILE:
      case TOOL_NAMES.WORKSPACE_WRITE_FILE:
      case TOOL_NAMES.WORKSPACE_EDIT_FILE:
      case TOOL_NAMES.WORKSPACE_GLOB:
      case TOOL_NAMES.WORKSPACE_GREP:
      case TOOL_NAMES.WORKSPACE_QUESTION:
      case TOOL_NAMES.WORKSPACE_BASH:
      case TOOL_NAMES.WORKSPACE_DIFF:
      case TOOL_NAMES.WORKSPACE_LOG:
        return await executeWorkspaceTool(
          parsed.name,
          validatedArgs as Record<string, unknown>,
        );

      default:
        return {
          success: false,
          error: `Unknown tool: ${parsed.name}`,
        };
    }
  } catch (error) {
    Zotero.debug(`[seerai] Tool execution error: ${error}`);
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Execute multiple tool calls in parallel
 */
export async function executeToolCalls(
  toolCalls: ToolCall[],
  config: AgentConfig = defaultAgentConfig,
): Promise<Map<string, ToolResult>> {
  const results = new Map<string, ToolResult>();

  // Execute all tool calls in parallel
  const promises = toolCalls.map(async (toolCall) => {
    const result = await executeToolCall(toolCall, config);
    results.set(toolCall.id, result);
  });

  await Promise.all(promises);
  return results;
}

/**
 * Format tool result for sending back to API
 */
export function formatToolResult(
  toolCallId: string,
  result: ToolResult,
): string {
  if (result.success) {
    return JSON.stringify({
      success: true,
      data: result.data,
      summary: result.summary,
    });
  } else {
    return JSON.stringify({
      success: false,
      error: result.error,
    });
  }
}

/**
 * Get agent config from preferences
 */
export function getAgentConfigFromPrefs(): AgentConfig {
  const config = { ...defaultAgentConfig };

  try {
    // Get library scope preference
    const scopePref = Zotero.Prefs.get(
      "extensions.seerai.libraryScope",
    ) as string;
    if (scopePref === "all") {
      config.libraryScope = { type: "all" };
    } else if (scopePref && scopePref.startsWith("group:")) {
      const groupId = parseInt(scopePref.split(":")[1], 10);
      if (!isNaN(groupId)) {
        config.libraryScope = { type: "group", groupId };
      }
    } else if (scopePref && scopePref.startsWith("collection:")) {
      const parts = scopePref.split(":");
      if (parts.length === 3) {
        // collection:libraryID:collectionID
        const libraryID = parseInt(parts[1], 10);
        const collectionId = parseInt(parts[2], 10);
        if (!isNaN(libraryID) && !isNaN(collectionId)) {
          config.libraryScope = {
            type: "collection",
            collectionId,
            libraryID,
          } as any;
        }
      } else {
        // collection:collectionID (legacy or simple)
        const collectionId = parseInt(parts[1], 10);
        if (!isNaN(collectionId)) {
          config.libraryScope = { type: "collection", collectionId } as any;
        }
      }
    } else {
      config.libraryScope = { type: "user" };
    }

    // Get max search results preference
    const maxResults = Zotero.Prefs.get(
      "extensions.seerai.agentMaxResults",
    ) as number;
    if (maxResults && maxResults > 0) {
      config.maxSearchResults = maxResults;
    }

    // Get max content length preference
    const maxContent = Zotero.Prefs.get(
      "extensions.seerai.agentMaxContentLength",
    ) as number;
    if (maxContent && maxContent > 0) {
      config.maxContentLength = maxContent;
    }

    // Get max iterations preference
    const maxIter = Zotero.Prefs.get(
      "extensions.seerai.agentMaxIterations",
    ) as number;
    if (maxIter && maxIter > 0) {
      config.maxAgentIterations = maxIter;
    }

    // Get auto OCR preference
    const autoOcr = Zotero.Prefs.get(
      "extensions.seerai.agentAutoOcr",
    ) as boolean;
    if (typeof autoOcr === "boolean") {
      config.autoOcr = autoOcr;
    }
  } catch (e) {
    Zotero.debug(`[seerai] Error reading agent config prefs: ${e}`);
  }

  return config;
}

/**
 * Check tool permission
 * Returns true if allowed, false if denied
 */
async function checkToolPermission(
  toolName: string,
  toolCallId: string,
  config: AgentConfig,
): Promise<boolean> {
  try {
    const prefStr = Zotero.Prefs.get(
      "extensions.seerai.tool_permissions",
    ) as string;
    let permissions: Record<string, "allow" | "ask" | "deny"> = {};
    if (prefStr) {
      permissions = JSON.parse(prefStr);
    }

    // Check specific permission first, then valid fallback to wildcard
    const permission = permissions[toolName] || permissions["*"] || "allow";

    if (permission === "allow") {
      Zotero.debug(`[seerai] Permission 'allow' for tool '${toolName}'.`);
      return true;
    }

    if (permission === "deny") {
      // Auto-deny
      Zotero.debug(
        `[seerai] Tool '${toolName}' denied by permission settings.`,
      );
      throw new Error(`Tool '${toolName}' is disabled in settings.`);
    }

    if (permission === "ask" || permission === "?") {
      Zotero.debug(
        `[seerai] Permission '${permission}' for tool '${toolName}'. Prompting user...`,
      );

      // Use inline handler (Mandatory now due to no popup fallback)
      if (config.permissionHandler) {
        Zotero.debug(
          `[seerai] Using inline permission handler for '${toolName}'`,
        );
        return await config.permissionHandler(toolCallId, toolName);
      } else {
        // If no handler is provided, we default to deny because we removed the modal fallback
        Zotero.debug(
          `[seerai] No permission handler provided for 'ask' permission tools. Auto-denying.`,
        );
        throw new Error("UI Error: No permission handler available.");
      }
    }

    Zotero.debug(
      `[seerai] Unknown permission setting '${permission}' for tool '${toolName}'. Defaulting to DENY.`,
    );
    throw new Error(`Unknown permission setting '${permission}'.`);
  } catch (e) {
    Zotero.debug(`[seerai] Error checking permission for ${toolName}: ${e}`);
    if (e instanceof Error) {
      throw e; // Use the specific error message
    }
    return false; // Fail closed for security
  }
}
