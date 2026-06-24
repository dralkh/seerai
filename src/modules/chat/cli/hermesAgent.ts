// Hermes CLI (Nous Research, `hermes`): a personal agent harness with its own
// tools, skills, memory and MCP. We use its purest one-shot mode, `hermes -z`,
// which takes the prompt as an argument and prints only the final reply text
// (no JSON event stream — so its own tool activity isn't surfaced here). Auth is
// inherited from the user's Hermes setup; seerai stores no credentials.

import type { CliAgentDef, CliInvokeOptions } from "./cliTypes";
import { isHarnessConnected, HERMES_TOOLSETS } from "./mcpBridge";

function buildHermesArgs(options: CliInvokeOptions): string[] {
  const args: string[] = [];
  // When the seerai MCP bridge is connected, enable its toolset for this
  // one-shot — `-z` does not load MCP toolsets by default, so its tools would be
  // invisible otherwise. `-t` must come before `-z` (whose value is the prompt).
  if (options.agentic && isHarnessConnected("hermes")) {
    args.push("-t", HERMES_TOOLSETS);
  }
  // `-z` = scripted one-shot, prompt-as-argument (stdin is left empty). Hermes
  // selects its model from its own config, so we pass no --model flag.
  args.push("-z", options.prompt ?? "");
  return args;
}

export const hermesAgentDef: CliAgentDef = {
  id: "hermes",
  name: "Hermes (Nous)",
  bin: "hermes",
  buildArgs: buildHermesArgs,
  // Prompt goes in argv (`-z <prompt>`), not stdin.
  stdinPrompt: false,
  versionArgs: ["--version"],
  // `hermes -z` emits the final reply as plain text (no JSON event protocol).
  streamFormat: "raw-text",
  authFailurePatterns: [
    /not logged in/i,
    /not authenticated/i,
    /unauthorized/i,
    /no api key/i,
    /missing.*api key/i,
    /please.*(login|authenticate|sign in)/i,
    /\b401\b/,
  ],
  loginCommand: "hermes",
  loginGuidance:
    "Hermes is not configured. Run `hermes` in a terminal to complete setup and provider sign-in (or set your provider API key in Hermes' config), then retry. seerai inherits Hermes' own configuration.",
  notFoundGuidance:
    "The `hermes` CLI was not found on your PATH. Install Hermes (Nous Research) and complete `hermes` setup, then click Detect again. If it is installed but not detected, launch Zotero from a terminal so it inherits your shell PATH.",
  // Hermes resolves its model from its own config; `default` defers to that.
  catalogModels: [{ id: "default", capabilities: ["chat", "reasoning"] }],
};
