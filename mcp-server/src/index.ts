#!/usr/bin/env node
/**
 * Seer-AI MCP Server
 *
 * Exposes Zotero tools via Model Context Protocol for external AI agents.
 *
 * Usage:
 *   npx @seerai/mcp-server
 *
 * Environment:
 *   ZOTERO_API_URL - Zotero API URL (default: http://127.0.0.1:23119)
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ErrorCode,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import { zodToJsonSchema } from "zod-to-json-schema";

import { TOOL_DEFINITIONS } from "./tools.js";
import { getZoteroClient, ZoteroClient } from "./zoteroClient.js";

const SERVER_NAME = "seerai-zotero";
const SERVER_VERSION = "1.0.0";

class SeerAIMcpServer {
  private server: Server;
  private zoteroClient: ZoteroClient;

  constructor() {
    this.server = new Server(
      { name: SERVER_NAME, version: SERVER_VERSION },
      { capabilities: { tools: {} } },
    );

    this.zoteroClient = getZoteroClient();
    this.setupHandlers();
  }

  private setupHandlers(): void {
    // List available tools
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: TOOL_DEFINITIONS.map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: zodToJsonSchema(tool.inputSchema, {
            name: tool.name,
            $refStrategy: "none",
          }),
        })),
      };
    });

    // Handle tool calls
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      // Check if Zotero is running
      const isHealthy = await this.zoteroClient.healthCheck();
      if (!isHealthy) {
        throw new McpError(
          ErrorCode.InternalError,
          "Zotero is not running or the Seer-AI plugin is not installed. Please start Zotero first.",
        );
      }

      // Find tool definition
      const toolDef = TOOL_DEFINITIONS.find((t) => t.name === name);
      if (!toolDef) {
        throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
      }

      try {
        // Validate arguments with Zod
        const validatedArgs = toolDef.inputSchema.parse(args || {});

        // Call Zotero API
        const result = await this.zoteroClient.callTool(name, validatedArgs);

        if (!result.success) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    success: false,
                    error: result.error,
                    summary: result.summary,
                  },
                  null,
                  2,
                ),
              },
            ],
            isError: true,
          };
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  success: true,
                  data: result.data,
                  summary: result.summary,
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (error) {
        if (error instanceof McpError) {
          throw error;
        }

        const message = error instanceof Error ? error.message : String(error);
        throw new McpError(
          ErrorCode.InternalError,
          `Tool execution failed: ${message}`,
        );
      }
    });
  }

  async run(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error(`${SERVER_NAME} v${SERVER_VERSION} started`);
  }
}

// Main entry point
const server = new SeerAIMcpServer();
server.run().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
