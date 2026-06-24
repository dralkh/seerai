/**
 * API Request Handlers for MCP Integration
 *
 * Dispatches HTTP API requests to the existing tool executor logic.
 */

import { executeToolCall } from "../chat/tools/toolExecutor";
import {
  ToolCall,
  ToolResult,
  defaultAgentConfig,
} from "../chat/tools/toolTypes";
import {
  emitToolActivityStart,
  emitToolActivityComplete,
} from "../chat/cli/toolActivityBridge";

export interface ApiRequest {
  tool: string;
  arguments: Record<string, unknown>;
}

export interface ApiResponse {
  success: boolean;
  data?: unknown;
  error?: string;
  summary?: string;
}

/**
 * Handle an incoming API request by dispatching to the tool executor
 */
export async function handleApiRequest(
  request: ApiRequest,
): Promise<ApiResponse> {
  const { tool, arguments: args } = request;

  Zotero.debug(`[seerai] Handling API request for tool: ${tool}`);

  // Construct a ToolCall object compatible with existing executor
  const toolCall: ToolCall = {
    id: `api_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
    type: "function",
    function: {
      name: tool,
      arguments: JSON.stringify(args),
    },
  };

  try {
    // Surface a live tool card if a CLI agentic turn is active (the harness
    // called this tool via the seerai MCP server). No-op otherwise.
    emitToolActivityStart(toolCall);
    const result: ToolResult = await executeToolCall(
      toolCall,
      defaultAgentConfig,
    );
    emitToolActivityComplete(toolCall, result);

    return {
      success: result.success,
      data: result.data,
      error: result.error,
      summary: result.summary,
    };
  } catch (error) {
    Zotero.debug(`[seerai] API handler error: ${error}`);
    const result: ToolResult = {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
    emitToolActivityComplete(toolCall, result);
    return {
      success: false,
      error: result.error,
    };
  }
}
