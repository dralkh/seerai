// Claude Code CLI: invoke `claude -p --output-format stream-json --verbose` for
// a one-shot chat turn and parse its JSONL stream. Auth is inherited from the
// user's Claude login (Pro/Max subscription or API key).

import { config } from "../../../../package.json";
import type { CliAgentDef, CliInvokeOptions, CliParseResult } from "./cliTypes";
import { buildClaudeMcpConfig } from "./mcpBridge";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

/** Best-effort one-line summary of a tool's input (command, file, query, …). */
function summarizeToolInput(input: unknown): string | undefined {
  const rec = asRecord(input);
  if (!rec) return undefined;
  for (const key of [
    "command",
    "file_path",
    "path",
    "pattern",
    "query",
    "url",
    "description",
  ]) {
    const value = rec[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function stringField(rec: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = rec[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

/**
 * Parse one line of Claude Code's stream-json output. We surface assistant
 * text blocks (the answer) and tool-use blocks (so the user can see the tools
 * Claude ran on its own), plus turn errors; system init / usage are ignored.
 */
export function parseClaudeEventLine(line: string): CliParseResult[] {
  const trimmed = line.trim();
  if (!trimmed) return [{ kind: "ignore" }];
  let obj: Record<string, unknown> | null;
  try {
    obj = asRecord(JSON.parse(trimmed));
  } catch {
    return [{ kind: "ignore" }];
  }
  if (!obj) return [{ kind: "ignore" }];

  const type = typeof obj.type === "string" ? obj.type : "";

  // Partial-message streaming (from --include-partial-messages): wrapped
  // Anthropic events. We surface text deltas as they arrive for live streaming.
  if (type === "stream_event") {
    const ev = asRecord(obj.event);
    if (ev && ev.type === "content_block_start") {
      const block = asRecord(ev.content_block);
      if (block && block.type === "tool_use") {
        const name = stringField(block, "name") || "tool";
        const id = stringField(block, "id") || undefined;
        return [
          {
            kind: "tool-start",
            id,
            name,
            detail: summarizeToolInput(block.input),
            owner: /seerai-zotero/i.test(name) ? "seerai-mcp" : "cli",
          },
        ];
      }
    }
    if (ev && ev.type === "content_block_delta") {
      const delta = asRecord(ev.delta);
      if (
        delta &&
        delta.type === "text_delta" &&
        typeof delta.text === "string" &&
        delta.text
      ) {
        return [{ kind: "text-delta", text: delta.text }];
      }
      if (
        delta &&
        delta.type === "input_json_delta" &&
        typeof delta.partial_json === "string" &&
        delta.partial_json.trim()
      ) {
        const index =
          typeof ev.index === "number" ? String(ev.index) : undefined;
        return [
          {
            kind: "tool-update",
            id: index,
            name: "tool",
            detail: delta.partial_json,
            owner: "cli",
          },
        ];
      }
    }
    return [{ kind: "ignore" }];
  }

  if (type === "assistant") {
    const message = asRecord(obj.message);
    const content = message?.content;
    if (!Array.isArray(content)) return [{ kind: "ignore" }];
    const results: CliParseResult[] = [];
    for (const block of content) {
      const rec = asRecord(block);
      if (!rec) continue;
      if (rec.type === "text" && typeof rec.text === "string" && rec.text) {
        results.push({ kind: "text", text: rec.text });
      } else if (rec.type === "tool_use") {
        const name = typeof rec.name === "string" ? rec.name : "tool";
        results.push({
          kind: "tool-complete",
          id: typeof rec.id === "string" ? rec.id : undefined,
          name,
          detail: summarizeToolInput(rec.input),
          owner: /seerai-zotero/i.test(name) ? "seerai-mcp" : "cli",
          success: true,
        });
      }
    }
    return results.length ? results : [{ kind: "ignore" }];
  }

  if (type === "result") {
    const subtype = typeof obj.subtype === "string" ? obj.subtype : "";
    if (subtype && subtype !== "success") {
      const message =
        typeof obj.result === "string"
          ? obj.result
          : `Claude ended with: ${subtype}`;
      return [{ kind: "error", message }];
    }
    return [{ kind: "done" }];
  }

  return [{ kind: "ignore" }];
}

function buildClaudeArgs(options: CliInvokeOptions): string[] {
  // -p (print/non-interactive); stream-json needs --verbose.
  // --include-partial-messages streams token deltas for live output (the parser
  // falls back to whole messages if a Claude version doesn't emit deltas).
  // Prompt via stdin.
  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
  ];
  // Permission mode gates agentic behavior. Agentic ON → skip permission
  // prompts so the harness can use its tools / edit files in the workspace.
  // Agentic OFF → `default` mode: every tool needs approval, and headless has
  // no approver, so tools are denied — a plain-chat turn (overriding any
  // permissive setting in the user's own Claude config).
  if (options.agentic) {
    args.push("--dangerously-skip-permissions");
  } else {
    args.push("--permission-mode", "default");
  }
  if (options.model && options.model !== "default") {
    args.push("--model", options.model);
  }
  return args;
}

export const claudeAgentDef: CliAgentDef = {
  id: "claude",
  name: "Claude Code CLI",
  bin: "claude",
  buildArgs: buildClaudeArgs,
  versionArgs: ["--version"],
  // Claude Code has no clean non-interactive auth-status subcommand; detection
  // reports installed + a login hint, and runtime errors surface auth failures.
  streamFormat: "json-lines",
  parseLine: parseClaudeEventLine,
  // Claude Code reads a stdio MCP server from a config file passed via
  // --mcp-config. We write it into the workspace and point Claude at it; with
  // --dangerously-skip-permissions (agentic) its mcp__seerai-zotero__* tools run.
  registerMcp: async ({ serverPath, env, workspaceDir }) => {
    const dir =
      workspaceDir ||
      PathUtils.join(Zotero.DataDirectory.dir, config.addonRef, "bin");
    await IOUtils.makeDirectory(dir, { ignoreExisting: true });
    const configPath = PathUtils.join(dir, ".seerai-mcp.json");
    await IOUtils.writeUTF8(
      configPath,
      JSON.stringify(buildClaudeMcpConfig(serverPath, env), null, 2),
    );
    return ["--mcp-config", configPath];
  },
  authFailurePatterns: [
    /not logged in/i,
    /not authenticated/i,
    /please run\s+`?claude`?/i,
    /invalid api key/i,
    /authentication_error/i,
    /unauthorized/i,
    /\b401\b/,
    /credit balance is too low/i,
  ],
  loginCommand: "claude",
  loginGuidance:
    "Claude Code is not authenticated. Run `claude` in a terminal and complete login (or set ANTHROPIC_API_KEY), then retry. seerai inherits the Claude CLI's login.",
  notFoundGuidance:
    "The `claude` CLI was not found on your PATH. Install Claude Code (`npm install -g @anthropic-ai/claude-code`) and sign in, then click Detect again. If it is installed but not detected, launch Zotero from a terminal so it inherits your shell PATH.",
  catalogModels: [
    { id: "claude-opus-4-8", capabilities: ["chat", "reasoning"] },
    { id: "claude-sonnet-4-6", capabilities: ["chat", "reasoning"] },
    { id: "claude-haiku-4-5", capabilities: ["chat"] },
  ],
};
