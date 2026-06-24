import type { ModelCapability } from "../providerTypes";

// Shared contract for delegating a chat turn to a locally installed agent CLI
// (Codex, Claude Code, Gemini, …). Each CLI brings its own login — seerai never
// stores credentials; it inherits whatever session the CLI already holds.

/**
 * Per-turn context for a CLI harness invocation. Resolved at the call site
 * (agentic loop vs plain-chat path) and threaded down to buildArgs/prepare and
 * the runner.
 */
export interface CliInvokeContext {
  /**
   * Whether seerai's agentic mode is ON. When false the harness must behave as
   * plain chat: no tools, no file writes (enforced per-CLI in buildArgs + a
   * strict prompt preamble). When true the harness runs as a full agent in the
   * chat workspace and (where supported) gets seerai's research tools over MCP.
   */
  agentic: boolean;
  /** The active chat's workspace dir — the harness runs here (its cwd). */
  workspaceDir?: string;
}

/** Inputs for registering seerai's MCP server with a harness (see registerMcp). */
export interface McpRegisterParams {
  /** Absolute path to the bundled seerai-mcp.cjs on disk. */
  serverPath: string;
  /** Env the spawned MCP server needs (callback URL, research tool profile, …). */
  env: Record<string, string>;
  /** The chat workspace dir (where a per-project config file may be written). */
  workspaceDir?: string;
}

export interface CliInvokeOptions {
  model?: string;
  reasoningEffort?: "low" | "medium" | "high";
  /**
   * The flattened prompt for this turn. Most CLIs read it from stdin (the
   * default), but some (Hermes, OpenClaw) take it as an argument/flag instead —
   * those read it from here in buildArgs/prepare. See `stdinPrompt`.
   */
  prompt?: string;
  /**
   * Whether seerai's agentic mode is ON for this turn (default false when
   * absent). buildArgs branches on this to gate the harness's own tools/file
   * access — see CliInvokeContext.agentic.
   */
  agentic?: boolean;
  /** The active chat's workspace dir (the harness's cwd), when known. */
  workspaceDir?: string;
}

export type CliToolOwner = "cli" | "seerai-mcp";

export interface CliToolActivity {
  id?: string;
  name: string;
  detail?: string;
  owner?: CliToolOwner;
}

export type CliParseResult =
  | { kind: "text"; text: string }
  // An incremental token delta (e.g. Claude --include-partial-messages). When
  // any delta is seen for a turn, the runner streams deltas and suppresses the
  // duplicate full-message `text` that follows; otherwise it falls back to the
  // full message — so this never regresses CLIs that only emit whole messages.
  | { kind: "text-delta"; text: string }
  | { kind: "reasoning"; text: string }
  // A tool the harness invoked on its own (its built-in tools, or any MCP/skill
  // it has configured). seerai never executes these — the CLI is its own agent —
  // we only surface them so the user can see what the harness did. `name` is the
  // tool the harness reported; `detail` is an optional short summary (command,
  // file, query, …).
  | ({ kind: "tool" } & CliToolActivity)
  | ({ kind: "tool-start" } & CliToolActivity)
  | ({ kind: "tool-update" } & CliToolActivity)
  | ({
      kind: "tool-complete";
      success?: boolean;
      error?: string;
    } & CliToolActivity)
  | { kind: "error"; message: string }
  | { kind: "done" }
  | { kind: "ignore" };

export interface CliAgentDef {
  /** Stable id, also used as ProviderConfig.cliAgentId (e.g. "codex"). */
  id: string;
  name: string;
  /** Binary resolved on the login-shell PATH. */
  bin: string;
  /** Arguments for a one-shot, non-interactive chat turn (prompt via stdin). */
  buildArgs(options: CliInvokeOptions): string[];
  /**
   * Optional async step run just before spawning (e.g. Antigravity has no
   * `--model` flag, so the chosen model is persisted to its settings.json
   * first). Must not throw fatally — failures are logged and ignored.
   */
  prepare?: (options: CliInvokeOptions) => Promise<void> | void;
  versionArgs: string[];
  /** Optional clean auth-status probe; omitted when the CLI has none. */
  authProbe?: { args: string[] };
  /** How to interpret the CLI's stdout. */
  streamFormat: "json-lines" | "raw-text";
  /**
   * Required for "json-lines": parse one stdout line into one or more events.
   * Returning an array lets a single line yield several events (e.g. a Claude
   * assistant message carrying both answer text and tool-use blocks).
   */
  parseLine?: (line: string) => CliParseResult | CliParseResult[];
  /**
   * Optional final-output parser for "raw-text" CLIs that print a single JSON
   * document at the end rather than streaming (e.g. OpenClaw's `--json`). When
   * present it is given the whole buffered stdout at exit and returns the answer
   * text or an error; takes precedence over treating stdout as the literal reply.
   */
  parseFinal?: (raw: string) => CliParseResult;
  /**
   * Whether the prompt is delivered on stdin (default true). When false the
   * prompt is passed via buildArgs/prepare (from CliInvokeOptions.prompt) and an
   * empty stdin is sent — for CLIs like Hermes/OpenClaw that take the prompt as
   * an argument or flag instead of stdin.
   */
  stdinPrompt?: boolean;
  /**
   * Optional: register seerai's MCP server (research tools) with this harness
   * for an agentic turn. Returns CLI args to append (e.g. Claude `--mcp-config`,
   * Codex `-c mcp_servers…`), and may write a config file into the workspace.
   * Omitted for harnesses whose one-shot mode can't consume MCP (Antigravity,
   * Hermes, OpenClaw). Only called when agentic mode is ON and Node is present.
   */
  registerMcp?: (params: McpRegisterParams) => Promise<string[]> | string[];
  /** Optional live model discovery (e.g. `codex debug models`). */
  listModels?: {
    args: string[];
    parse: (output: string) => Array<{
      id: string;
      label?: string;
      capabilities?: ModelCapability[];
    }>;
  };
  /** Patterns that indicate the CLI is not logged in. */
  authFailurePatterns: RegExp[];
  /** The command the user runs to authenticate (shown in guidance). */
  loginCommand: string;
  loginGuidance: string;
  notFoundGuidance: string;
  catalogModels: Array<{ id: string; capabilities: ModelCapability[] }>;
}

export function isAuthFailureText(def: CliAgentDef, text: string): boolean {
  const value = String(text || "");
  if (!value.trim()) return false;
  return def.authFailurePatterns.some((re) => re.test(value));
}
