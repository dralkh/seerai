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
import { getWorkspaceStore } from "../chat/workspace/store";
import { getMessageStore } from "../chat/messageStore";
import { getSkillsFilesystemDir } from "../chat/skills/registry";

registerWorkspaceInfoEndpoint();

function registerWorkspaceInfoEndpoint(): void {
  Zotero.Server.Endpoints["/seerai/workspace_info"] = function () {
    return {
      supportedMethods: ["GET"],
      supportedDataTypes: ["application/json"],
      permitBookmarklet: false,
      init: async function (_requestData: any) {
        try {
          const store = getWorkspaceStore();
          return [
            200,
            "application/json",
            JSON.stringify({
              workspaceDir: store.workspaceDir,
              conversationId: getMessageStore().getConversationId(),
              skillsDir: getSkillsFilesystemDir(),
            }),
          ];
        } catch (e: any) {
          return [
            500,
            "application/json",
            JSON.stringify({ error: e?.message || String(e) }),
          ];
        }
      },
    };
  };
}

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
  TOOL_NAMES.SYSTEMATIC_REVIEW,

  // TODO management
  TOOL_NAMES.TODO_WRITE,
  TOOL_NAMES.TODO_READ,

  // Completion signal
  TOOL_NAMES.TASK_COMPLETE,
  TOOL_NAMES.SKILLS_LIST,
  TOOL_NAMES.SKILL_VIEW,
  TOOL_NAMES.SKILL_MANAGE,
  TOOL_NAMES.SKILL_REFERENCE,
  TOOL_NAMES.SKILL_INFO,
  TOOL_NAMES.TERMINAL,
  TOOL_NAMES.PROCESS,
  TOOL_NAMES.EXECUTE_CODE,
  TOOL_NAMES.CHECK_ENVIRONMENT,
  TOOL_NAMES.TODO,
  TOOL_NAMES.CLARIFY,
  TOOL_NAMES.DELEGATE_TASK,
  TOOL_NAMES.MIXTURE_OF_AGENTS,

  // Semantic & keyword search tools
  TOOL_NAMES.SEMANTIC_SEARCH,
  TOOL_NAMES.KEYWORD_SEARCH,
  TOOL_NAMES.READ_CHUNKS,

  // Workspace tools
  TOOL_NAMES.WORKSPACE_READ_FILE,
  TOOL_NAMES.WORKSPACE_WRITE_FILE,
  TOOL_NAMES.WORKSPACE_EDIT_FILE,
  TOOL_NAMES.WORKSPACE_GLOB,
  TOOL_NAMES.WORKSPACE_GREP,
  TOOL_NAMES.WORKSPACE_QUESTION,
  TOOL_NAMES.WORKSPACE_BASH,
  TOOL_NAMES.WORKSPACE_DIFF,
  TOOL_NAMES.WORKSPACE_LOG,
  TOOL_NAMES.READ_FILE,
  TOOL_NAMES.WRITE_FILE,
  TOOL_NAMES.PATCH,
  TOOL_NAMES.SEARCH_FILES,
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
