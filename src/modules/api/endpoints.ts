/**
 * Zotero HTTP API Endpoints for MCP Integration
 *
 * Exposes all 20 Seer-AI tools via Zotero.Server.Endpoints
 * for external AI agents to access via HTTP.
 *
 * Default: http://127.0.0.1:23119/seerai/*
 */

import { handleApiRequest, ApiRequest } from "./handlers";
import { TOOL_NAMES } from "../chat/tools/toolTypes";

// All tool endpoints
const ENDPOINTS = [
  // Core tools (unchanged)
  TOOL_NAMES.SEARCH_LIBRARY,
  TOOL_NAMES.GET_ITEM_METADATA,
  TOOL_NAMES.READ_ITEM_CONTENT,
  TOOL_NAMES.SEARCH_EXTERNAL,
  TOOL_NAMES.IMPORT_PAPER,
  TOOL_NAMES.GENERATE_ITEM_TAGS,

  // Consolidated tools
  TOOL_NAMES.CONTEXT,
  TOOL_NAMES.COLLECTION,
  TOOL_NAMES.TABLE,
  TOOL_NAMES.NOTE,
  TOOL_NAMES.RELATED_PAPERS,
  TOOL_NAMES.WEB,
] as const;

/**
 * Register all Seer-AI API endpoints with Zotero.Server
 */
export function registerApiEndpoints(): void {
  Zotero.debug("[seerai] Registering API endpoints...");

  // Health check endpoint
  Zotero.Server.Endpoints["/seerai/health"] = function () {
    return {
      supportedMethods: ["GET"],
      supportedDataTypes: ["application/json"],
      permitBookmarklet: false,
      init: async function (_requestData: any) {
        return [
          200,
          "application/json",
          JSON.stringify({
            status: "ok",
            version: "1.0.0",
            tools: ENDPOINTS.length,
            timestamp: new Date().toISOString(),
          }),
        ];
      },
    };
  };

  // Register each tool endpoint
  for (const toolName of ENDPOINTS) {
    const path = `/seerai/${toolName}`;

    Zotero.Server.Endpoints[path] = function () {
      return {
        supportedMethods: ["POST"],
        supportedDataTypes: ["application/json"],
        permitBookmarklet: false,
        init: async function (requestData: any) {
          try {
            // Parse request body
            let args: Record<string, unknown> = {};

            if (requestData.data) {
              if (typeof requestData.data === "string") {
                args = JSON.parse(requestData.data);
              } else {
                args = requestData.data;
              }
            }

            const request: ApiRequest = {
              tool: toolName,
              arguments: args,
            };

            Zotero.debug(`[seerai] API request: ${toolName}`);
            Zotero.debug(`[seerai] API args: ${JSON.stringify(args)}`);

            const result = await handleApiRequest(request);

            return [
              result.success ? 200 : 400,
              "application/json",
              JSON.stringify(result),
            ];
          } catch (error) {
            Zotero.debug(`[seerai] API error: ${error}`);
            return [
              500,
              "application/json",
              JSON.stringify({
                success: false,
                error: error instanceof Error ? error.message : String(error),
              }),
            ];
          }
        },
      };
    };

    Zotero.debug(`[seerai] Registered endpoint: ${path}`);
  }

  Zotero.debug(`[seerai] Registered ${ENDPOINTS.length + 1} API endpoints`);
}
