// Antigravity CLI (`agy`): Google's successor to the now-deprecated Gemini CLI
// for individuals. We drive its headless stream-json protocol: the process is
// started once with `--input-format stream-json --output-format stream-json`,
// the prompt is written to stdin as one NDJSON user event, and the reply
// arrives as a typed event stream (text deltas + tool activity + result).
//
// Earlier integrations used `agy -p -` and piped the prompt over stdin. Since
// agy 1.2.7 that silently breaks: `-p` takes the prompt as its value, so `-`
// was answered as the literal message "-" (or produced no output at all when
// the run needed a permission headless can't prompt for). See
// https://antigravity.google/docs/cli/headless.
//
// Auth is inherited from `agy`'s Google login (stored in the system keyring);
// it cannot complete OAuth in headless mode, so the user must run `agy` once in
// a terminal to sign in.

import type { CliAgentDef, CliInvokeOptions, CliParseResult } from "./cliTypes";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

function stringField(rec: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = rec[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

/** Legacy display labels written by seerai's old catalog → current slugs. */
const LEGACY_LABEL_SLUGS: Record<string, string> = {
  "Gemini 3.1 Pro (High)": "gemini-3.1-pro-high",
  "Gemini 3.1 Pro (Low)": "gemini-3.1-pro-low",
  "Gemini 3.5 Flash (High)": "gemini-3.8-flash-high",
  "Gemini 3.5 Flash (Medium)": "gemini-3.8-flash-medium",
  "Gemini 3.5 Flash (Low)": "gemini-3.8-flash-low",
  "Claude Sonnet 4.6 (Thinking)": "claude-sonnet-4-6",
  "Claude Opus 4.6 (Thinking)": "claude-opus-4-6-thinking",
  "GPT-OSS 120B (Medium)": "gpt-oss-120b-medium",
};

/**
 * Map a stored model id to an `agy --model` slug. Display labels from the old
 * catalog are translated to their current equivalents; anything else that
 * doesn't look like a slug is dropped so agy uses its own selection instead of
 * failing the run on an unknown model.
 */
export function resolveAntigravityModelSlug(
  model?: string,
): string | undefined {
  if (!model || model === "default") return undefined;
  const alias = LEGACY_LABEL_SLUGS[model];
  if (alias) return alias;
  if (/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(model)) return model;
  (globalThis as any).Zotero?.debug?.(
    `[seerai] Antigravity: ignoring non-slug model id "${model}" (using agy's own selection)`,
  );
  return undefined;
}

function summarizeToolInput(value: unknown): string | undefined {
  const rec = asRecord(value);
  if (!rec) return undefined;
  for (const key of [
    "CommandLine",
    "command",
    "file_path",
    "path",
    "pattern",
    "query",
    "url",
  ]) {
    const field = rec[key];
    if (typeof field === "string" && field.trim()) return field.trim();
  }
  return undefined;
}

/**
 * Parse one line of `agy --output-format stream-json`. Events:
 *   init         → ignore
 *   step_update  → agent_response text deltas, tool activity
 *   result       → final text (deduped by the runner) or an error
 */
export function parseAntigravityEventLine(line: string): CliParseResult[] {
  const trimmed = line.trim();
  if (!trimmed) return [{ kind: "ignore" }];
  let obj: Record<string, unknown> | null;
  try {
    obj = asRecord(JSON.parse(trimmed));
  } catch {
    return [{ kind: "ignore" }];
  }
  if (!obj) return [{ kind: "ignore" }];

  const event = typeof obj.event === "string" ? obj.event : "";

  if (event === "step_update") {
    const step = asRecord(obj.step_update);
    if (!step) return [{ kind: "ignore" }];
    const state = typeof step.state === "string" ? step.state : "";
    const stepType = typeof step.step_type === "string" ? step.step_type : "";
    const results: CliParseResult[] = [];

    if (stepType === "agent_response") {
      const delta = step.text_delta;
      if (typeof delta === "string" && delta) {
        results.push({ kind: "text-delta", text: delta });
      }
    } else if (stepType === "tool") {
      const info = asRecord(step.tool_info) || {};
      const name =
        stringField(step, "tool_name") || stringField(info, "name") || "tool";
      const detail = summarizeToolInput(info.parameters);
      const id =
        typeof step.step_index === "number" ? String(step.step_index) : name;
      if (state === "ACTIVE") {
        results.push({ kind: "tool-start", id, name, detail, owner: "cli" });
      } else if (state === "DONE") {
        const error = asRecord(info.error);
        results.push({
          kind: "tool-complete",
          id,
          name,
          detail,
          owner: "cli",
          success: !error,
          error: error ? stringField(error, "message") : undefined,
        });
      }
    }
    return results.length ? results : [{ kind: "ignore" }];
  }

  if (event === "result") {
    const result = asRecord(obj.result);
    if (!result) return [{ kind: "ignore" }];
    const status = typeof result.status === "string" ? result.status : "";
    const response = typeof result.response === "string" ? result.response : "";
    if (status === "SUCCESS") {
      return response ? [{ kind: "text", text: response }] : [{ kind: "done" }];
    }
    const message =
      stringField(result, "error") ||
      `Antigravity ended with status ${status || "UNKNOWN"}`;
    // A non-success result can still carry the turn's answer: agy runs
    // post-turn steps (checkpoint, summaries) that may fail with a transient
    // provider error after the model already replied. Don't fail the turn when
    // there is a response — fall back to the text and log the error.
    if (response.trim()) {
      (globalThis as any).Zotero?.debug?.(
        `[seerai] Antigravity: result ${status || "UNKNOWN"} with response — ${message}`,
      );
      return [{ kind: "text", text: response }];
    }
    return [{ kind: "error", message }];
  }

  return [{ kind: "ignore" }];
}

/** Parse `agy models` output: one `slug   Display Label` pair per line. */
export function parseAntigravityModels(output: string): Array<{
  id: string;
  label?: string;
}> {
  const models: Array<{ id: string; label?: string }> = [];
  const seen = new Set<string>();
  for (const raw of String(output || "").split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const match = line.match(/^([A-Za-z0-9][A-Za-z0-9._/-]*)\s+(.+)$/);
    if (!match) continue;
    const id = match[1];
    const label = match[2].trim();
    if (!id || seen.has(id)) continue;
    // Skip CLI diagnostics that aren't model rows.
    if (/^(fetching|error|warning|usage)/i.test(id)) continue;
    seen.add(id);
    models.push({ id, label });
  }
  return models;
}

export const antigravityAgentDef: CliAgentDef = {
  id: "antigravity",
  name: "Antigravity (agy)",
  bin: "agy",
  buildArgs: (options: CliInvokeOptions) => {
    // Persistent stream-json session: prompts come over stdin (see wrapStdin),
    // so long conversations are not limited by argv length.
    const args = [
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
    ];
    // Agentic ON → auto-approve tools so headless runs can execute;
    // agentic OFF → default permission policy (tools are soft-denied).
    if (options.agentic) {
      args.push("--dangerously-skip-permissions");
    }
    const model = resolveAntigravityModelSlug(options.model);
    if (model) args.push("--model", model);
    if (options.reasoningEffort) {
      args.push("--effort", options.reasoningEffort);
    }
    return args;
  },
  // Prompts are NDJSON user events on stdin.
  wrapStdin: (prompt: string) =>
    `${JSON.stringify({ event: "user", message: { content: prompt } })}\n`,
  versionArgs: ["--version"],
  // Machine-readable NDJSON: init / step_update / result.
  streamFormat: "json-lines",
  parseLine: parseAntigravityEventLine,
  listModels: { args: ["models"], parse: parseAntigravityModels },
  authFailurePatterns: [
    /not logged into antigravity/i,
    /authentication required/i,
    /authentication timed out/i,
    /not authenticated/i,
    /please.*(login|authenticate|sign in)/i,
    /ineligibletiererror/i,
    /no longer supported for gemini/i,
    /unauthorized/i,
    /\b401\b/,
  ],
  loginCommand: "agy",
  loginGuidance:
    "Antigravity is not signed in. Open a terminal and run `agy` once — it opens Google sign-in in your browser and stores the token in your system keyring (headless mode can't complete sign-in on its own). Then retry. seerai inherits agy's login.",
  notFoundGuidance:
    "The `agy` (Antigravity) CLI was not found. Install it from https://antigravity.google/cli and run `agy` once to sign in, then click Detect again. If it is installed but not detected, launch Zotero from a terminal so it inherits your shell PATH.",
  // Fallback only — live discovery via `agy models` is preferred.
  catalogModels: [
    { id: "default", capabilities: ["chat", "reasoning"] },
    { id: "gemini-3.8-flash-high", capabilities: ["chat", "reasoning"] },
    { id: "gemini-3.8-flash-medium", capabilities: ["chat", "reasoning"] },
    { id: "gemini-3.8-flash-low", capabilities: ["chat"] },
    { id: "gemini-3.1-pro-high", capabilities: ["chat", "reasoning"] },
    { id: "gemini-3.1-pro-low", capabilities: ["chat", "reasoning"] },
    { id: "claude-sonnet-4-6", capabilities: ["chat", "reasoning"] },
    { id: "claude-opus-4-6-thinking", capabilities: ["chat", "reasoning"] },
    { id: "gpt-oss-120b-medium", capabilities: ["chat", "reasoning"] },
  ],
};
