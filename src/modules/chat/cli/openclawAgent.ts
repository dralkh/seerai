// OpenClaw CLI (`openclaw`): a self-hosted gateway that routes a prompt to one
// of its configured agents. Unlike the other harnesses it is session/agent
// oriented rather than a stdin coding agent: a one-shot turn is
//   openclaw agent --agent <id> --message <prompt> --json
// which requires a running gateway and at least one configured agent, takes the
// prompt as a flag (not stdin), and prints a single JSON document (not a stream)
// with stdout reserved for that JSON. seerai's "model" field selects the agent
// identity; `default` uses an agent literally named "default".

import type { CliAgentDef, CliInvokeOptions, CliParseResult } from "./cliTypes";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

// Pull the assistant reply out of OpenClaw's JSON response. The exact schema can
// vary by version, so we probe the common shapes defensively rather than bind to
// one field.
function extractReply(root: Record<string, unknown>): string | undefined {
  const directKeys = [
    "message",
    "text",
    "response",
    "reply",
    "content",
    "output",
    "result",
    "answer",
  ];
  const containers: Array<Record<string, unknown>> = [root];
  for (const key of ["data", "result", "response"]) {
    const nested = asRecord(root[key]);
    if (nested) containers.push(nested);
  }
  for (const container of containers) {
    for (const key of directKeys) {
      const value = container[key];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
    // A messages[] transcript: take the last assistant entry's text.
    const messages = container.messages;
    if (Array.isArray(messages)) {
      for (let i = messages.length - 1; i >= 0; i--) {
        const m = asRecord(messages[i]);
        if (!m) continue;
        const role = typeof m.role === "string" ? m.role : "";
        if (role && role !== "assistant") continue;
        const c = m.content ?? m.text;
        if (typeof c === "string" && c.trim()) return c.trim();
      }
    }
  }
  return undefined;
}

function parseOpenClawFinal(raw: string): CliParseResult {
  const trimmed = raw.trim();
  if (!trimmed) return { kind: "ignore" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    // Not JSON (e.g. an early gateway error printed as text) — surface as-is.
    return { kind: "error", message: trimmed.slice(0, 500) };
  }
  const root = asRecord(parsed);
  if (!root) {
    return typeof parsed === "string" && parsed.trim()
      ? { kind: "text", text: parsed.trim() }
      : { kind: "ignore" };
  }
  // Explicit error envelope.
  const errValue = root.error;
  if (typeof errValue === "string" && errValue.trim()) {
    return { kind: "error", message: errValue.trim() };
  }
  const errObj = asRecord(errValue);
  if (errObj && typeof errObj.message === "string" && errObj.message.trim()) {
    return { kind: "error", message: errObj.message.trim() };
  }
  const reply = extractReply(root);
  return reply ? { kind: "text", text: reply } : { kind: "ignore" };
}

function buildOpenClawArgs(options: CliInvokeOptions): string[] {
  const agentId =
    options.model && options.model !== "default" ? options.model : "default";
  // --json keeps stdout reserved for the JSON response (diagnostics go to
  // stderr). Prompt is delivered as a flag, so stdin stays empty.
  return [
    "agent",
    "--agent",
    agentId,
    "--message",
    options.prompt ?? "",
    "--json",
  ];
}

export const openclawAgentDef: CliAgentDef = {
  id: "openclaw",
  name: "OpenClaw",
  bin: "openclaw",
  buildArgs: buildOpenClawArgs,
  // Prompt goes in `--message`, not stdin.
  stdinPrompt: false,
  versionArgs: ["--version"],
  // OpenClaw prints one JSON document at the end rather than streaming lines.
  streamFormat: "raw-text",
  parseFinal: parseOpenClawFinal,
  authFailurePatterns: [
    /not logged in/i,
    /not authenticated/i,
    /unauthorized/i,
    /no api key/i,
    /missing.*api key/i,
    /gateway.*(not running|unavailable|unreachable)/i,
    /connection refused/i,
    /\b401\b/,
  ],
  loginCommand: "openclaw onboard",
  loginGuidance:
    'OpenClaw isn\'t ready. Run `openclaw onboard` in a terminal to set up the gateway, workspace and at least one agent, make sure the gateway is running, then retry. The seerai model field selects which OpenClaw agent to use (`default` uses an agent named "default").',
  notFoundGuidance:
    "The `openclaw` CLI was not found on your PATH. Install OpenClaw and run `openclaw onboard`, then click Detect again. If it is installed but not detected, launch Zotero from a terminal so it inherits your shell PATH.",
  // Entries map to OpenClaw *agent identities*, not provider models. `default`
  // targets an agent named "default"; add your own configured agent names.
  catalogModels: [{ id: "default", capabilities: ["chat", "reasoning"] }],
};
