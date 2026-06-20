// Antigravity CLI (`agy`): Google's successor to the now-deprecated Gemini CLI
// for individuals. Print mode `agy -p -` reads the prompt from stdin and prints
// the answer as plain text. Auth is inherited from `agy`'s Google login (stored
// in the system keyring); it cannot complete OAuth in print mode, so the user
// must run `agy` once in a terminal to sign in.
//
// `agy` has no `--model` flag (upstream limitation); the selected model is
// persisted to ~/.gemini/antigravity-cli/settings.json before each spawn, which
// agy re-reads on startup. "default" leaves the file untouched (uses whatever
// the user last picked in agy's own TUI).

import { getEnvVar } from "./cliRunner";
import type { CliAgentDef, CliInvokeOptions } from "./cliTypes";

const SETTINGS_PARTS = [".gemini", "antigravity-cli", "settings.json"];

function settingsPath(): string | null {
  const home = getEnvVar("HOME") || getEnvVar("USERPROFILE");
  if (!home) return null;
  return PathUtils.join(home, ...SETTINGS_PARTS);
}

async function writeModelSelection(label: string): Promise<void> {
  const path = settingsPath();
  if (!path) return;
  let existing: Record<string, unknown> = {};
  try {
    if (await IOUtils.exists(path)) {
      const raw = await IOUtils.readUTF8(path);
      const parsed = JSON.parse(raw || "{}");
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        existing = parsed as Record<string, unknown>;
      }
    }
  } catch {
    // Corrupt JSON — rewrite from scratch so the next spawn is known-good.
  }
  existing.model = label;
  const dir = PathUtils.parent(path);
  if (dir) await IOUtils.makeDirectory(dir, { ignoreExisting: true });
  await IOUtils.writeUTF8(path, `${JSON.stringify(existing, null, 2)}\n`);
}

export const antigravityAgentDef: CliAgentDef = {
  id: "antigravity",
  name: "Antigravity (agy)",
  bin: "agy",
  // Print mode + stdin sentinel `-`. The prompt is piped to stdin by cliRunner.
  buildArgs: () => ["-p", "-"],
  prepare: async (options: CliInvokeOptions) => {
    if (options.model && options.model !== "default") {
      await writeModelSelection(options.model).catch(() => undefined);
    }
  },
  versionArgs: ["--version"],
  // Print mode emits the answer as plain text (no JSON event protocol).
  streamFormat: "raw-text",
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
    "Antigravity is not signed in. Open a terminal and run `agy` once — it opens Google sign-in in your browser and stores the token in your system keyring (print mode can't complete sign-in on its own). Then retry. seerai inherits agy's login.",
  notFoundGuidance:
    "The `agy` (Antigravity) CLI was not found on your PATH. Install it from https://antigravity.google/cli and run `agy` once to sign in, then click Detect again. If it is installed but not detected, launch Zotero from a terminal so it inherits your shell PATH.",
  // No programmatic model list; these are the consumer-tier labels agy's
  // Switch-Model picker exposes. "default" uses agy's own current selection.
  catalogModels: [
    { id: "default", capabilities: ["chat", "reasoning"] },
    { id: "Gemini 3.1 Pro (High)", capabilities: ["chat", "reasoning"] },
    { id: "Gemini 3.1 Pro (Low)", capabilities: ["chat", "reasoning"] },
    { id: "Gemini 3.5 Flash (High)", capabilities: ["chat", "reasoning"] },
    { id: "Gemini 3.5 Flash (Medium)", capabilities: ["chat"] },
    { id: "Gemini 3.5 Flash (Low)", capabilities: ["chat"] },
    { id: "Claude Sonnet 4.6 (Thinking)", capabilities: ["chat", "reasoning"] },
    { id: "Claude Opus 4.6 (Thinking)", capabilities: ["chat", "reasoning"] },
    { id: "GPT-OSS 120B (Medium)", capabilities: ["chat", "reasoning"] },
  ],
};
