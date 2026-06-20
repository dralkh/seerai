// Claude Code CLI: invoke `claude -p --output-format stream-json --verbose` for
// a one-shot chat turn and parse its JSONL stream. Auth is inherited from the
// user's Claude login (Pro/Max subscription or API key).

import type { CliAgentDef, CliInvokeOptions, CliParseResult } from "./cliTypes";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Parse one line of Claude Code's stream-json output. We surface assistant
 * text blocks (one message per turn) and turn errors; everything else (system
 * init, tool use, usage) is ignored.
 */
export function parseClaudeEventLine(line: string): CliParseResult {
  const trimmed = line.trim();
  if (!trimmed) return { kind: "ignore" };
  let obj: Record<string, unknown> | null;
  try {
    obj = asRecord(JSON.parse(trimmed));
  } catch {
    return { kind: "ignore" };
  }
  if (!obj) return { kind: "ignore" };

  const type = typeof obj.type === "string" ? obj.type : "";

  if (type === "assistant") {
    const message = asRecord(obj.message);
    const content = message?.content;
    if (Array.isArray(content)) {
      const text = content
        .map((block) => {
          const rec = asRecord(block);
          return rec && rec.type === "text" && typeof rec.text === "string"
            ? rec.text
            : "";
        })
        .filter(Boolean)
        .join("");
      if (text) return { kind: "text", text };
    }
    return { kind: "ignore" };
  }

  if (type === "result") {
    const subtype = typeof obj.subtype === "string" ? obj.subtype : "";
    if (subtype && subtype !== "success") {
      const message =
        typeof obj.result === "string"
          ? obj.result
          : `Claude ended with: ${subtype}`;
      return { kind: "error", message };
    }
    return { kind: "done" };
  }

  return { kind: "ignore" };
}

function buildClaudeArgs(options: CliInvokeOptions): string[] {
  // -p (print/non-interactive); stream-json needs --verbose. Prompt via stdin.
  const args = ["-p", "--output-format", "stream-json", "--verbose"];
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
