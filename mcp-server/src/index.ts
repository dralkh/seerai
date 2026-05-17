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
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { resolve as pathResolve } from "node:path";

import { TOOL_DEFINITIONS } from "./tools.js";
import { getZoteroClient, ZoteroClient } from "./zoteroClient.js";

const execAsync = promisify(exec);
const EXEC_TIMEOUT = 30000;

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

      // Handle workspace_bash directly — execute real shell commands
      if (name === "workspace_bash") {
        return await this.handleBashExecution(args || {});
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

  private async getWorkspaceBase(): Promise<string | null> {
    const info = await this.zoteroClient.getWorkspaceInfo();
    if (!info?.workspaceDir) return null;
    return info.workspaceDir;
  }

  private async handleBashExecution(args: Record<string, unknown>): Promise<{
    content: Array<{ type: "text"; text: string }>;
    isError?: boolean;
  }> {
    const command = args.command as string;
    const workdir = (args.workdir as string) || "";
    const description = (args.description as string) || "";

    if (!command) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              success: false,
              error: 'Missing required parameter: "command"',
            }),
          },
        ],
        isError: true,
      };
    }

    const wsBase = await this.getWorkspaceBase();
    if (!wsBase) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              success: false,
              error:
                "No active workspace. Open a conversation with a workspace in Zotero first.",
            }),
          },
        ],
        isError: true,
      };
    }

    const cwd = workdir ? pathResolve(wsBase, workdir) : wsBase;

    try {
      const { stdout, stderr } = await execAsync(command, {
        cwd,
        timeout: EXEC_TIMEOUT,
        maxBuffer: 1024 * 1024,
        env: { ...process.env, HOME: process.env.HOME || "/root" },
      });

      const output = (stdout || "") + (stderr ? `\n[stderr]\n${stderr}` : "");
      const trimmed = output.trim() || "(no output)";

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              success: true,
              data: {
                command,
                workdir: cwd,
                description,
                output: trimmed,
                exitCode: 0,
                executedAt: new Date().toISOString(),
              },
              summary: `Executed: ${command.slice(0, 80)}${command.length > 80 ? "..." : ""}`,
            }),
          },
        ],
      };
    } catch (e: any) {
      const stdout = e?.stdout || "";
      const stderr = e?.stderr || "";
      const output = (stdout || "") + (stderr ? `\n[stderr]\n${stderr}` : "");
      const trimmed = output.trim() || e?.message || "Command failed";

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              success: true,
              data: {
                command,
                workdir: cwd,
                description,
                output: trimmed,
                exitCode: e?.code || 1,
                killed: e?.killed || false,
                executedAt: new Date().toISOString(),
              },
              summary: `Executed: ${command.slice(0, 80)}${command.length > 80 ? "..." : ""} (exit ${e?.code || 1})`,
            }),
          },
        ],
      };
    }
  }
}

// Main entry point
const server = new SeerAIMcpServer();
server.run().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
