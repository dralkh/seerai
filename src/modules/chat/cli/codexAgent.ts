// Codex CLI: invoke `codex exec --json` for a one-shot chat turn and parse its
// JSONL event stream (thread.started / item.completed:agent_message /
// turn.completed). Auth is inherited from `codex login`.

import type { CliAgentDef, CliInvokeOptions, CliParseResult } from "./cliTypes";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Parse a single JSONL line from `codex exec --json`. Returns "ignore" for
 * lines we don't surface (tool calls, item.started, session id) or noise.
 */
export function parseCodexEventLine(line: string): CliParseResult {
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

  if (type === "item.completed") {
    const item = asRecord(obj.item);
    if (!item) return { kind: "ignore" };
    const itemType = typeof item.type === "string" ? item.type : "";
    const text = typeof item.text === "string" ? item.text : "";
    if (itemType === "agent_message" && text) return { kind: "text", text };
    if (itemType === "reasoning" && text) return { kind: "reasoning", text };
    return { kind: "ignore" };
  }

  if (type === "turn.completed") return { kind: "done" };

  if (type === "error" || type === "turn.failed") {
    const errorObj = asRecord(obj.error);
    const message =
      typeof obj.message === "string"
        ? obj.message
        : errorObj && typeof errorObj.message === "string"
          ? errorObj.message
          : "Codex reported an error.";
    return { kind: "error", message };
  }

  return { kind: "ignore" };
}

/**
 * Parse `codex debug models` JSON into the live model list, dropping hidden
 * entries. Every Codex model is chat + reasoning capable.
 */
export function parseCodexDebugModels(output: string): Array<{
  id: string;
  label?: string;
  capabilities?: ("chat" | "reasoning")[];
}> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    // Output may have leading noise; grab the first {...} block.
    const start = output.indexOf('{"models"');
    const end = output.lastIndexOf("}");
    if (start < 0 || end <= start) return [];
    try {
      parsed = JSON.parse(output.slice(start, end + 1));
    } catch {
      return [];
    }
  }
  const models = asRecord(parsed)?.models;
  if (!Array.isArray(models)) return [];
  const out: Array<{
    id: string;
    label?: string;
    capabilities?: ("chat" | "reasoning")[];
  }> = [];
  const seen = new Set<string>();
  for (const raw of models) {
    const entry = asRecord(raw);
    if (!entry) continue;
    const visibility =
      typeof entry.visibility === "string" ? entry.visibility : "";
    if (visibility === "hide" || visibility === "hidden") continue;
    const id =
      typeof entry.slug === "string"
        ? entry.slug.trim()
        : typeof entry.id === "string"
          ? entry.id.trim()
          : "";
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const label =
      typeof entry.display_name === "string" && entry.display_name.trim()
        ? entry.display_name.trim()
        : undefined;
    out.push({ id, label, capabilities: ["chat", "reasoning"] });
  }
  return out;
}

function buildCodexArgs(options: CliInvokeOptions): string[] {
  // read-only sandbox: a Q&A turn must not edit the filesystem (model network
  // access is unaffected). Prompt is delivered via stdin, not argv.
  const args = [
    "exec",
    "--json",
    "--skip-git-repo-check",
    "--sandbox",
    "read-only",
  ];
  if (options.model && options.model !== "default") {
    args.push("-m", options.model);
  }
  if (options.reasoningEffort) {
    args.push("-c", `model_reasoning_effort="${options.reasoningEffort}"`);
  }
  return args;
}

export const codexAgentDef: CliAgentDef = {
  id: "codex",
  name: "Codex CLI (ChatGPT)",
  bin: "codex",
  buildArgs: buildCodexArgs,
  versionArgs: ["--version"],
  authProbe: { args: ["login", "status"] },
  streamFormat: "json-lines",
  parseLine: parseCodexEventLine,
  listModels: { args: ["debug", "models"], parse: parseCodexDebugModels },
  authFailurePatterns: [
    /not logged in/i,
    /not authenticated/i,
    /run\s+`?codex login`?/i,
    /unauthorized/i,
    /\b401\b/,
    /no credentials/i,
  ],
  loginCommand: "codex login",
  loginGuidance:
    "Not signed in to Codex. Open a terminal and run `codex login` (sign in with your ChatGPT account), then retry. seerai inherits the Codex CLI's login — it never stores your credentials.",
  notFoundGuidance:
    "The `codex` CLI was not found on your PATH. Install it (`npm install -g @openai/codex`) and run `codex login`, then click Detect again. If Codex is installed but not detected, launch Zotero from a terminal so it inherits your shell PATH.",
  // Fallback only — live discovery via `codex debug models` is preferred.
  catalogModels: [
    { id: "default", capabilities: ["chat", "reasoning"] },
    { id: "gpt-5.5", capabilities: ["chat", "reasoning"] },
    { id: "gpt-5.4", capabilities: ["chat", "reasoning"] },
    { id: "gpt-5.4-mini", capabilities: ["chat", "reasoning"] },
  ],
};
