// Cursor Agent CLI (`cursor-agent`): invoke
// `cursor-agent -p --mode ask --trust --output-format text` for a one-shot
// literature-chat turn. Auth is inherited from `cursor-agent login`. seerai
// stores no credentials.
//
// Binary MUST be `cursor-agent`, never `agent`. Several tools ship an `agent`
// binary (including Grok's TUI); resolving the short name is a silent
// mis-route. Print mode cannot complete OAuth — the user signs in once in a
// terminal. `cursor-agent about` is the truthful auth probe; `status`/`whoami`
// can report success while print mode still rejects.

import type { ModelCapability } from "../providerTypes";
import type { CliAgentDef, CliInvokeOptions } from "./cliTypes";
import { isHarnessConnected } from "./mcpBridge";

export function parseCursorModels(
  output: string,
): Array<{ id: string; label?: string; capabilities?: ModelCapability[] }> {
  const models: Array<{
    id: string;
    label?: string;
    capabilities?: ModelCapability[];
  }> = [];
  const seen = new Set<string>();
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (/^no models/i.test(line)) continue;
    if (/^available models/i.test(line)) continue;
    if (/^(error|usage|cli version)/i.test(line)) continue;
    const id = line.split(/\s+/)[0];
    if (!id || id.startsWith("-") || seen.has(id)) continue;
    seen.add(id);
    models.push({ id, capabilities: ["chat", "reasoning"] });
  }
  return models;
}

export function buildCursorArgs(options: CliInvokeOptions): string[] {
  // -p = one-shot print. --trust skips the workspace prompt (headless).
  // Chat (agentic OFF) uses --mode ask (read-only Q&A, no writes).
  // Agentic ON drops ask so the harness can use its own tools in the
  // workspace — never --force / --yolo.
  const args = ["-p", "--trust", "--output-format", "text"];
  if (!options.agentic) {
    args.push("--mode", "ask");
  }
  // When the seerai MCP bridge is connected, auto-approve its server so a
  // headless turn doesn't stall on an interactive approval prompt.
  if (options.agentic && isHarnessConnected("cursor")) {
    args.push("--approve-mcps");
  }
  if (options.model && options.model !== "default") {
    args.push("--model", options.model);
  }
  return args;
}

export const cursorAgentDef: CliAgentDef = {
  id: "cursor",
  name: "Cursor Agent CLI",
  bin: "cursor-agent",
  buildArgs: buildCursorArgs,
  versionArgs: ["--version"],
  authProbe: { args: ["about"] },
  streamFormat: "raw-text",
  listModels: { args: ["--list-models"], parse: parseCursorModels },
  authFailurePatterns: [
    /not logged in/i,
    /authentication required/i,
    /please run\s+'?agent login'?/i,
    /please run\s+'?cursor-agent login'?/i,
    /not authenticated/i,
    /unauthorized/i,
    /\b401\b/,
  ],
  loginCommand: "cursor-agent login",
  loginGuidance:
    "Cursor Agent CLI is not signed in. Open a terminal and run `cursor-agent login` (browser sign-in). Desktop Cursor being logged in does not count. Then retry. seerai inherits the CLI session — it never stores your credentials.",
  notFoundGuidance:
    "The `cursor-agent` CLI was not found on your PATH. Install Cursor CLI (https://cursor.com/docs/cli) so the binary is named `cursor-agent`, run `cursor-agent login`, then click Detect again. Do not use a bare `agent` binary — that name is shared by other tools. If it is installed but not detected, launch Zotero from a terminal so it inherits your shell PATH.",
  catalogModels: [
    { id: "default", capabilities: ["chat", "reasoning"] },
    { id: "gpt-5", capabilities: ["chat", "reasoning"] },
    { id: "sonnet-4", capabilities: ["chat", "reasoning"] },
    { id: "sonnet-4-thinking", capabilities: ["chat", "reasoning"] },
  ],
};
