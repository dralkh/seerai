#!/usr/bin/env node
/**
 * Seer-AI MCP Server
 *
 * Exposes Zotero tools via Model Context Protocol for external AI agents,
 * and provides an HTTP execution API for the Zotero plugin's agentic mode.
 *
 * Usage:
 *   npx @seerai/mcp-server
 *
 * Environment:
 *   ZOTERO_API_URL  - Zotero API URL (default: http://127.0.0.1:23119)
 *   SEERAI_EXEC_PORT - HTTP execution API port (default: 23120, 0=disabled)
 *   SEERAI_ENABLE_TERMINAL_TOOLS=1 - enable terminal/code execution
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
import { ChildProcess, exec, spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { dirname, join as pathJoin, resolve as pathResolve } from "node:path";
import { randomUUID } from "node:crypto";
import {
  createServer as createHttpServer,
  IncomingMessage,
  ServerResponse,
} from "node:http";

import { TOOL_DEFINITIONS } from "./tools.js";
import { getZoteroClient, ZoteroClient } from "./zoteroClient.js";

const execAsync = promisify(exec);
const EXEC_TIMEOUT = 30000;
const MAX_EXEC_TIMEOUT = 300000;
const DEFAULT_MAX_OUTPUT = 64 * 1024;

const SERVER_NAME = "seerai-zotero";
const SERVER_VERSION = "1.0.0";

class SeerAIMcpServer {
  private server: Server;
  private zoteroClient: ZoteroClient;
  private processes = new Map<
    string,
    {
      child: ChildProcess;
      command: string;
      cwd: string;
      output: string;
      startedAt: string;
      exitCode: number | null;
      killed: boolean;
    }
  >();

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

      const validatedArgs = toolDef.inputSchema.parse(args || {});

      if (
        name === "workspace_bash" ||
        name === "terminal" ||
        name === "process" ||
        name === "execute_code"
      ) {
        if (name === "process") {
          return await this.handleProcess(validatedArgs);
        }
        if (name === "execute_code") {
          return await this.handleExecuteCode(validatedArgs);
        }
        return await this.handleTerminalExecution(validatedArgs);
      }

      try {
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
    this.startHttpServer();
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error(
      `${SERVER_NAME} v${SERVER_VERSION} started (MCP stdio + HTTP execution API)`,
    );
  }

  private startHttpServer(): void {
    const execPort = parseInt(process.env.SEERAI_EXEC_PORT || "23120", 10);
    if (execPort === 0) {
      console.error(
        "[seerai] HTTP execution API disabled (SEERAI_EXEC_PORT=0)",
      );
      return;
    }
    const httpServer = createHttpServer((req, res) =>
      this.handleHttpRequest(req, res),
    );
    httpServer.listen(execPort, "127.0.0.1", () => {
      console.error(
        `[seerai] HTTP execution API listening on http://127.0.0.1:${execPort}`,
      );
    });
    httpServer.on("error", (err) => {
      console.error(`[seerai] HTTP execution server error: ${err.message}`);
    });
  }

  private async handleHttpRequest(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Access-Control-Allow-Origin", "http://127.0.0.1:23119");
    res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    try {
      const body = await this.readRequestBody(req);
      const result = await this.routeHttpRequest(req, body);
      res.writeHead(result.status);
      res.end(JSON.stringify(result.body));
    } catch (e: any) {
      res.writeHead(500);
      res.end(
        JSON.stringify({ success: false, error: e?.message || String(e) }),
      );
    }
  }

  private readRequestBody(
    req: IncomingMessage,
  ): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      let data = "";
      req.on("data", (chunk: Buffer) => {
        data += chunk.toString();
      });
      req.on("end", () => {
        try {
          resolve(data ? JSON.parse(data) : {});
        } catch {
          reject(new Error("Invalid JSON body"));
        }
      });
      req.on("error", reject);
    });
  }

  private async routeHttpRequest(
    req: IncomingMessage,
    body: Record<string, unknown>,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const url = req.url || "/";
    const method = req.method || "GET";

    if (url === "/health" && method === "GET") {
      return {
        status: 200,
        body: { status: "ok", terminalEnabled: this.terminalEnabled() },
      };
    }

    if (url === "/exec" && method === "POST") {
      if (!body.command) {
        return {
          status: 400,
          body: { success: false, error: 'Missing "command"' },
        };
      }
      const response = await this.handleTerminalExecution(body);
      const parsed = JSON.parse(response.content[0].text);
      return { status: parsed.success ? 200 : 500, body: parsed };
    }

    if (url === "/process" && (method === "GET" || method === "POST")) {
      const response = await this.handleProcess(body);
      const parsed = JSON.parse(response.content[0].text);
      return { status: parsed.success ? 200 : 500, body: parsed };
    }

    if (url === "/code" && method === "POST") {
      if (!body.code || !body.language) {
        return {
          status: 400,
          body: { success: false, error: 'Missing "code" or "language"' },
        };
      }
      const response = await this.handleExecuteCode(body);
      const parsed = JSON.parse(response.content[0].text);
      return { status: parsed.success ? 200 : 500, body: parsed };
    }

    return {
      status: 404,
      body: { success: false, error: `Unknown endpoint: ${method} ${url}` },
    };
  }

  private async getWorkspaceBase(): Promise<string | null> {
    const info = await this.zoteroClient.getWorkspaceInfo();
    if (!info?.workspaceDir) return null;
    return info.workspaceDir;
  }

  private terminalEnabled(): boolean {
    return process.env.SEERAI_ENABLE_TERMINAL_TOOLS === "1";
  }

  private toolResponse(
    data: unknown,
    isError = false,
  ): {
    content: Array<{ type: "text"; text: string }>;
    isError?: boolean;
  } {
    return {
      content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      isError: isError || undefined,
    };
  }

  private async resolveWorkspaceCwd(workdir?: string): Promise<{
    workspace: string;
    cwd: string;
  }> {
    const wsBase = await this.getWorkspaceBase();
    if (!wsBase) {
      throw new Error(
        "No active workspace. Open a conversation with a workspace in Zotero first.",
      );
    }
    const workspace = pathResolve(wsBase);
    const cwd = workdir ? pathResolve(workspace, workdir) : workspace;
    if (cwd !== workspace && !cwd.startsWith(workspace + "/")) {
      throw new Error("Working directory escapes the active workspace");
    }
    return { workspace, cwd };
  }

  private capOutput(output: string, maxBytes: number): string {
    const bytes = Buffer.from(output);
    if (bytes.length <= maxBytes) return output;
    return (
      bytes.subarray(0, maxBytes).toString("utf8") +
      `\n[output truncated at ${maxBytes} bytes]`
    );
  }

  private async handleTerminalExecution(
    args: Record<string, unknown>,
  ): Promise<{
    content: Array<{ type: "text"; text: string }>;
    isError?: boolean;
  }> {
    const command = args.command as string;
    const workdir = (args.workdir as string) || "";
    const description = (args.description as string) || "";
    const timeout = Math.min(
      (args.timeoutMs as number) || EXEC_TIMEOUT,
      MAX_EXEC_TIMEOUT,
    );
    const maxOutput = Math.min(
      (args.maxOutputBytes as number) || DEFAULT_MAX_OUTPUT,
      256 * 1024,
    );

    if (!command) {
      return this.toolResponse(
        { success: false, error: 'Missing required parameter: "command"' },
        true,
      );
    }

    if (!this.terminalEnabled()) {
      return this.toolResponse(
        {
          success: false,
          error:
            "Terminal tools are disabled. Set SEERAI_ENABLE_TERMINAL_TOOLS=1 to enable guarded MCP execution.",
        },
        true,
      );
    }

    const { cwd } = await this.resolveWorkspaceCwd(workdir);

    if (args.background) {
      const id = randomUUID();
      const child = spawn(command, {
        cwd,
        shell: true,
        env: { ...process.env, HOME: process.env.HOME || "/root" },
      });
      const record = {
        child,
        command,
        cwd,
        output: "",
        startedAt: new Date().toISOString(),
        exitCode: null as number | null,
        killed: false,
      };
      child.stdout?.on("data", (chunk) => {
        record.output = this.capOutput(
          record.output + chunk.toString(),
          maxOutput,
        );
      });
      child.stderr?.on("data", (chunk) => {
        record.output = this.capOutput(
          record.output + "\n[stderr]\n" + chunk.toString(),
          maxOutput,
        );
      });
      child.on("exit", (code) => {
        record.exitCode = code ?? 0;
      });
      this.processes.set(id, record);
      return this.toolResponse({
        success: true,
        data: {
          processId: id,
          command,
          workdir: cwd,
          startedAt: record.startedAt,
        },
        summary: `Started background process: ${command.slice(0, 80)}`,
      });
    }

    try {
      const { stdout, stderr } = await execAsync(command, {
        cwd,
        timeout,
        maxBuffer: 1024 * 1024,
        env: { ...process.env, HOME: process.env.HOME || "/root" },
      });

      const output = (stdout || "") + (stderr ? `\n[stderr]\n${stderr}` : "");
      const trimmed = this.capOutput(output.trim() || "(no output)", maxOutput);

      return this.toolResponse({
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
      });
    } catch (e: any) {
      const stdout = e?.stdout || "";
      const stderr = e?.stderr || "";
      const output = (stdout || "") + (stderr ? `\n[stderr]\n${stderr}` : "");
      const trimmed = this.capOutput(
        output.trim() || e?.message || "Command failed",
        maxOutput,
      );

      return this.toolResponse(
        {
          success: false,
          error: `Command failed with exit code ${e?.code || 1}`,
          data: {
            command,
            workdir: cwd,
            description,
            output: trimmed,
            exitCode: e?.code || 1,
            killed: e?.killed || false,
            executedAt: new Date().toISOString(),
          },
          summary: `Failed: ${command.slice(0, 80)}${command.length > 80 ? "..." : ""} (exit ${e?.code || 1})`,
        },
        true,
      );
    }
  }

  private async handleProcess(args: Record<string, unknown>): Promise<{
    content: Array<{ type: "text"; text: string }>;
    isError?: boolean;
  }> {
    if (!this.terminalEnabled()) {
      return this.toolResponse(
        {
          success: false,
          error:
            "Process tools are disabled. Set SEERAI_ENABLE_TERMINAL_TOOLS=1 to enable guarded MCP execution.",
        },
        true,
      );
    }
    const action = args.action as string;
    if (action === "list") {
      return this.toolResponse({
        success: true,
        data: Array.from(this.processes.entries()).map(([id, p]) => ({
          processId: id,
          command: p.command,
          cwd: p.cwd,
          startedAt: p.startedAt,
          exitCode: p.exitCode,
          killed: p.killed,
        })),
      });
    }
    const id = args.processId as string;
    const record = id ? this.processes.get(id) : null;
    if (!record) {
      return this.toolResponse(
        { success: false, error: "Unknown processId" },
        true,
      );
    }
    if (action === "kill") {
      record.killed = record.child.kill();
    } else if (action === "write") {
      record.child.stdin?.write(args.input || "");
    } else if (action === "wait" && record.exitCode === null) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(
          resolve,
          Math.min(
            (args.timeoutMs as number) || EXEC_TIMEOUT,
            MAX_EXEC_TIMEOUT,
          ),
        );
        record.child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    return this.toolResponse({
      success: true,
      data: {
        processId: id,
        command: record.command,
        cwd: record.cwd,
        output: record.output,
        exitCode: record.exitCode,
        killed: record.killed,
      },
      summary: `Process ${action}: ${id}`,
    });
  }

  private async handleExecuteCode(args: Record<string, unknown>): Promise<{
    content: Array<{ type: "text"; text: string }>;
    isError?: boolean;
  }> {
    if (!this.terminalEnabled()) {
      return this.toolResponse(
        {
          success: false,
          error:
            "Code execution is disabled. Set SEERAI_ENABLE_TERMINAL_TOOLS=1 to enable guarded MCP execution.",
        },
        true,
      );
    }
    const language = args.language as "python" | "javascript" | "bash";
    const code = args.code as string;
    const { workspace, cwd } = await this.resolveWorkspaceCwd(
      args.workdir as string | undefined,
    );
    const ext =
      language === "python" ? "py" : language === "javascript" ? "js" : "sh";
    const tempPath = pathJoin(
      workspace,
      ".agent",
      "exec",
      `${randomUUID()}.${ext}`,
    );
    await mkdir(dirname(tempPath), { recursive: true });
    await writeFile(tempPath, code, "utf8");
    const runner =
      language === "python"
        ? `python3 ${JSON.stringify(tempPath)}`
        : language === "javascript"
          ? `node ${JSON.stringify(tempPath)}`
          : `bash ${JSON.stringify(tempPath)}`;
    return this.handleTerminalExecution({
      command: runner,
      workdir: cwd.slice(workspace.length).replace(/^\//, ""),
      timeoutMs: args.timeoutMs,
      maxOutputBytes: args.maxOutputBytes,
    });
  }
}

// Main entry point
const server = new SeerAIMcpServer();
server.run().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
