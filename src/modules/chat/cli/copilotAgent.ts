// GitHub Copilot CLI: invoke `copilot --allow-all-tools --output-format json`
// for a one-shot chat turn and parse its JSONL stream. Auth is inherited from
// the user's GitHub Copilot login. Prompt is delivered via stdin (omit `-p`),
// which the CLI reads under a non-TTY pipe.

import type { CliAgentDef, CliInvokeOptions, CliParseResult } from "./cliTypes";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Parse one line of GitHub Copilot CLI's `--output-format json` stream. Copilot
 * uses dotted top-level types with the payload under `data`, and emits true
 * streaming deltas via `assistant.message_delta`.
 */
export function parseCopilotEventLine(line: string): CliParseResult {
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
  const data = asRecord(obj.data) || {};

  if (type === "assistant.message_delta") {
    const text = typeof data.deltaContent === "string" ? data.deltaContent : "";
    return text ? { kind: "text", text } : { kind: "ignore" };
  }
  if (type === "assistant.reasoning_delta") {
    const text = typeof data.deltaContent === "string" ? data.deltaContent : "";
    return text ? { kind: "reasoning", text } : { kind: "ignore" };
  }
  if (type === "result") {
    const ok = obj.success === true || obj.exitCode === 0;
    if (ok) return { kind: "done" };
    const message =
      typeof obj.error === "string"
        ? obj.error
        : "GitHub Copilot ended with an error.";
    return { kind: "error", message };
  }
  if (type === "error") {
    const message =
      typeof obj.message === "string"
        ? obj.message
        : "GitHub Copilot reported an error.";
    return { kind: "error", message };
  }
  return { kind: "ignore" };
}

function buildCopilotArgs(options: CliInvokeOptions): string[] {
  // --allow-all-tools: non-interactive runs otherwise block on per-tool
  // approval prompts. Prompt is piped via stdin (no -p).
  const args = ["--allow-all-tools", "--output-format", "json"];
  if (options.model && options.model !== "default") {
    args.push("--model", options.model);
  }
  return args;
}

export const copilotAgentDef: CliAgentDef = {
  id: "copilot",
  name: "GitHub Copilot CLI",
  bin: "copilot",
  buildArgs: buildCopilotArgs,
  versionArgs: ["--version"],
  streamFormat: "json-lines",
  parseLine: parseCopilotEventLine,
  authFailurePatterns: [
    /not logged in/i,
    /not authenticated/i,
    /please.*(login|authenticate|sign in)/i,
    /no github token/i,
    /gh auth login/i,
    /unauthorized/i,
    /\b401\b/,
    /requires? a github copilot subscription/i,
  ],
  loginCommand: "copilot",
  loginGuidance:
    "GitHub Copilot CLI is not authenticated. Run `copilot` in a terminal and complete GitHub sign-in (or set GH_TOKEN / GITHUB_TOKEN with Copilot access), then retry. seerai inherits the Copilot CLI's login.",
  notFoundGuidance:
    "The `copilot` CLI was not found on your PATH. Install GitHub Copilot CLI (`npm install -g @github/copilot`) and sign in, then click Detect again. If it is installed but not detected, launch Zotero from a terminal so it inherits your shell PATH.",
  catalogModels: [
    { id: "gpt-5.2", capabilities: ["chat", "reasoning"] },
    { id: "claude-sonnet-4.6", capabilities: ["chat", "reasoning"] },
  ],
};
