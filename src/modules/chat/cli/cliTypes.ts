import type { ModelCapability } from "../providerTypes";

// Shared contract for delegating a chat turn to a locally installed agent CLI
// (Codex, Claude Code, Gemini, …). Each CLI brings its own login — seerai never
// stores credentials; it inherits whatever session the CLI already holds.

export interface CliInvokeOptions {
  model?: string;
  reasoningEffort?: "low" | "medium" | "high";
}

export type CliParseResult =
  | { kind: "text"; text: string }
  | { kind: "reasoning"; text: string }
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
  /** Required for "json-lines": parse one stdout line into an event. */
  parseLine?: (line: string) => CliParseResult;
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
