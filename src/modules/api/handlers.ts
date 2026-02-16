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
    const result: ToolResult = await executeToolCall(
      toolCall,
      defaultAgentConfig,
    );

    return {
      success: result.success,
      data: result.data,
      error: result.error,
      summary: result.summary,
    };
  } catch (error) {
    Zotero.debug(`[seerai] API handler error: ${error}`);
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
