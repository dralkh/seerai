import type {
  AgentProvider,
  AgentQuery,
  AnyOpenAIMessage,
  ProviderEvent,
  QueryInput,
} from "../../openai";
import type { ResolvedModel } from "../providerTypes";
import { getWorkspaceStore } from "../workspace/store";
import { runCli } from "./cliRunner";
import {
  buildMcpEnv,
  ensureMcpServerOnDisk,
  isNodeAvailable,
} from "./mcpBridge";
import { getCliAgent } from "./agents";
import { codexAgentDef } from "./codexAgent";
import {
  isAuthFailureText,
  type CliAgentDef,
  type CliInvokeContext,
  type CliToolActivity,
  type CliParseResult,
} from "./cliTypes";

// Prepended to the prompt when seerai's agentic mode is OFF. CLI harnesses are
// agents by nature; this (plus per-CLI no-tools flags in buildArgs) forces a
// plain-chat turn so the harness can't run tools or modify files.
const NO_TOOLS_PREAMBLE =
  "[seerai: agentic mode is OFF] Answer the user directly, in plain text. " +
  "Do NOT use any tools, run any commands, search, or read/write/modify any " +
  "files. Respond conversationally using only what is already in this prompt.";

function isSeeraiMcpActivity(activity: CliToolActivity): boolean {
  return (
    activity.owner === "seerai-mcp" ||
    /seerai-zotero/i.test(activity.name) ||
    /seerai-zotero/i.test(activity.detail || "")
  );
}

function extractText(content: AnyOpenAIMessage["content"]): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (part.type === "text" && typeof part.text === "string") {
          return part.text;
        }
        if (part.type === "image_url")
          return "[image omitted — local CLI receives text only]";
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

/**
 * Flatten the chat history into a single prompt. CLIs take one prompt over
 * stdin, so we render system context plus the prior turns as a transcript and
 * let the CLI answer the final user turn.
 */
function buildPrompt(messages: AnyOpenAIMessage[]): string {
  const systemParts: string[] = [];
  const turns: string[] = [];
  for (const message of messages) {
    const role = (message as { role?: string }).role || "user";
    const text = extractText(
      (message as { content: AnyOpenAIMessage["content"] }).content,
    );
    if (role === "system") {
      if (text.trim()) systemParts.push(text.trim());
      continue;
    }
    if (role === "tool") {
      if (text.trim()) turns.push(`Tool result:\n${text.trim()}`);
      continue;
    }
    const label = role === "assistant" ? "Assistant" : "User";
    if (text.trim()) turns.push(`${label}: ${text.trim()}`);
  }

  const sections: string[] = [];
  if (systemParts.length) sections.push(systemParts.join("\n\n"));
  if (turns.length > 1) {
    sections.push(`Conversation so far:\n${turns.slice(0, -1).join("\n\n")}`);
  }
  const last = turns[turns.length - 1] || "User: (no input)";
  sections.push(last.startsWith("User:") ? last : `User: ${last}`);
  return sections.join("\n\n");
}

/**
 * AgentProvider backed by a local agent CLI (Codex / Claude Code / Gemini).
 * Spawns the CLI, streams its answer back as chat tokens, and inherits the
 * CLI's own login (no API key, no token storage in seerai). seerai's tool loop
 * stays off for CLI turns — the CLI is its own agent — so each turn is a single
 * streamed response.
 */
export function createCliProvider(
  resolved: ResolvedModel,
  ctx?: CliInvokeContext,
): AgentProvider {
  const agent: CliAgentDef =
    getCliAgent(resolved.provider.cliAgentId) || codexAgentDef;
  const agentic = ctx?.agentic ?? false;
  const workspaceDir = ctx?.workspaceDir;

  return {
    isSessionInvalid(): boolean {
      return false;
    },
    query(input: QueryInput): AgentQuery {
      let handle: { abort: () => void } | null = null;

      const events = (async function* (): AsyncGenerator<ProviderEvent> {
        const basePrompt = buildPrompt(input.messages);
        // Plain-chat gate: when agentic mode is off, lead with a strict
        // no-tools instruction (belt-and-suspenders with per-CLI flags).
        const prompt = agentic
          ? basePrompt
          : `${NO_TOOLS_PREAMBLE}\n\n${basePrompt}`;
        const invokeOptions = {
          model: resolved.model.modelId,
          reasoningEffort: resolved.model.reasoningEffort,
          prompt,
          agentic,
          workspaceDir,
        };
        if (agent.prepare) {
          try {
            await agent.prepare(invokeOptions);
          } catch (e) {
            Zotero.debug(`[seerai] cli prepare failed for ${agent.id}: ${e}`);
          }
        }
        let args = agent.buildArgs(invokeOptions);
        // In agentic mode, give the harness seerai's research tools over MCP
        // (Claude/Codex only — others can't consume MCP in one-shot mode). The
        // harness spawns the stdio server, which calls back into the plugin's
        // HTTP API. Best-effort: skipped silently if the server or Node is
        // unavailable, leaving the harness with just its own tools.
        if (agentic && agent.registerMcp) {
          try {
            const serverPath = await ensureMcpServerOnDisk();
            if (serverPath && (await isNodeAvailable())) {
              const extraArgs = await agent.registerMcp({
                serverPath,
                env: buildMcpEnv(),
                workspaceDir,
              });
              args = [...args, ...extraArgs];
            } else {
              Zotero.debug(
                "[seerai] MCP bridge skipped (server path or node unavailable)",
              );
            }
          } catch (e) {
            Zotero.debug(
              `[seerai] MCP registration failed for ${agent.id}: ${e}`,
            );
          }
        }
        // Most CLIs read the prompt from stdin; arg/flag-delivery ones (Hermes,
        // OpenClaw) take it via buildArgs and get an empty stdin instead.
        const usesStdin = agent.stdinPrompt !== false;
        const run = runCli({
          bin: agent.bin,
          args,
          stdinText: usesStdin ? prompt : "",
          // Run the harness in the active chat's workspace when known.
          cwd: workspaceDir,
        });
        handle = run;

        yield { type: "init", continuation: "" };

        let sawText = false;
        // True once we've streamed at least one token delta this turn. When set,
        // we suppress the duplicate full-message `text` that some CLIs also emit.
        let sawDelta = false;
        let errorEmitted = false;
        let buffer = "";
        const activeToolIds = new Set<string>();
        // Plain-text CLIs (Antigravity) compute their answer then print it, and
        // emit an auth-prompt URL to stdout when not signed in. So we buffer raw
        // output and decide at exit, rather than streaming an auth URL as if it
        // were the answer.
        let rawBuffer = "";

        const toolKey = (activity: CliToolActivity): string =>
          activity.id || `${activity.name}:${activity.detail || ""}`;

        const handleLine = function* (line: string): Generator<ProviderEvent> {
          if (!agent.parseLine) return;
          const out = agent.parseLine(line);
          const results: CliParseResult[] = Array.isArray(out) ? out : [out];
          for (const parsed of results) {
            if (parsed.kind === "text-delta") {
              sawDelta = true;
              sawText = true;
              yield { type: "token", text: parsed.text };
            } else if (parsed.kind === "text") {
              // Suppress the whole-message echo once deltas have streamed it;
              // otherwise emit it (fallback for CLIs that don't stream deltas).
              if (sawDelta) continue;
              sawText = true;
              yield { type: "token", text: parsed.text };
            } else if (parsed.kind === "tool") {
              if (!isSeeraiMcpActivity(parsed)) {
                yield {
                  type: "tool_activity",
                  phase: "start",
                  id: parsed.id,
                  name: parsed.name,
                  detail: parsed.detail,
                  owner: parsed.owner || "cli",
                };
                yield {
                  type: "tool_activity",
                  phase: "complete",
                  id: parsed.id,
                  name: parsed.name,
                  detail: parsed.detail,
                  owner: parsed.owner || "cli",
                  success: true,
                };
              }
            } else if (
              parsed.kind === "tool-start" ||
              parsed.kind === "tool-update" ||
              parsed.kind === "tool-complete"
            ) {
              if (!isSeeraiMcpActivity(parsed)) {
                const key = toolKey(parsed);
                if (
                  parsed.kind === "tool-complete" &&
                  !activeToolIds.has(key)
                ) {
                  yield {
                    type: "tool_activity",
                    phase: "start",
                    id: parsed.id,
                    name: parsed.name,
                    detail: parsed.detail,
                    owner: parsed.owner || "cli",
                  };
                }
                yield {
                  type: "tool_activity",
                  phase:
                    parsed.kind === "tool-start"
                      ? "start"
                      : parsed.kind === "tool-update"
                        ? "update"
                        : "complete",
                  id: parsed.id,
                  name: parsed.name,
                  detail: parsed.detail,
                  owner: parsed.owner || "cli",
                  success:
                    parsed.kind === "tool-complete"
                      ? parsed.success !== false
                      : undefined,
                  error:
                    parsed.kind === "tool-complete" ? parsed.error : undefined,
                };
                if (parsed.kind === "tool-start") activeToolIds.add(key);
                if (parsed.kind === "tool-complete") activeToolIds.delete(key);
              }
            } else if (parsed.kind === "error" && !errorEmitted) {
              errorEmitted = true;
              yield {
                type: "error",
                message: parsed.message,
                retryable: false,
              };
            }
          }
        };

        for await (const ev of run.events) {
          if (ev.type === "stdout") {
            if (agent.streamFormat === "raw-text") {
              rawBuffer += ev.text;
              continue;
            }
            buffer += ev.text;
            let nl = buffer.indexOf("\n");
            while (nl >= 0) {
              const line = buffer.slice(0, nl);
              buffer = buffer.slice(nl + 1);
              yield* handleLine(line);
              nl = buffer.indexOf("\n");
            }
          } else {
            // exit event — flush trailing partial line, then resolve.
            if (agent.streamFormat === "json-lines" && buffer.trim()) {
              yield* handleLine(buffer);
            }
            buffer = "";
            if (errorEmitted) return;

            const stderr = ev.stderr || "";

            if (agent.streamFormat === "raw-text") {
              const combined = `${rawBuffer}\n${stderr}`;
              if (isAuthFailureText(agent, combined)) {
                yield {
                  type: "error",
                  message: agent.loginGuidance,
                  retryable: false,
                };
                return;
              }
              // Single-JSON CLIs (OpenClaw `--json`) print one document at exit;
              // let the agent pull the reply text out of it.
              if (agent.parseFinal) {
                const finalResult = agent.parseFinal(rawBuffer);
                if (finalResult.kind === "text" && finalResult.text.trim()) {
                  yield { type: "token", text: finalResult.text };
                  yield { type: "done", content: "" };
                  return;
                }
                if (finalResult.kind === "error") {
                  yield {
                    type: "error",
                    message: finalResult.message,
                    retryable: false,
                  };
                  return;
                }
                const parseDetail = (stderr || rawBuffer).slice(0, 500);
                yield {
                  type: "error",
                  message: `${agent.name} produced no parseable response${parseDetail ? `: ${parseDetail}` : ""}`,
                  retryable: false,
                };
                return;
              }
              const answer = rawBuffer.trim();
              if (answer) {
                yield { type: "token", text: answer };
                yield { type: "done", content: "" };
                return;
              }
              const detail = (stderr || rawBuffer).slice(0, 500);
              yield {
                type: "error",
                message: `${agent.name} produced no response${detail ? `: ${detail}` : ""}`,
                retryable: false,
              };
              return;
            }

            if (isAuthFailureText(agent, stderr)) {
              yield {
                type: "error",
                message: agent.loginGuidance,
                retryable: false,
              };
              return;
            }
            if (ev.exitCode !== null && ev.exitCode !== 0 && !sawText) {
              const detail = stderr ? `: ${stderr.slice(0, 500)}` : "";
              yield {
                type: "error",
                message: `${agent.name} exited with code ${ev.exitCode}${detail}`,
                retryable: false,
              };
              return;
            }
            if (!sawText && stderr) {
              yield {
                type: "error",
                message: `${agent.name} produced no response: ${stderr.slice(0, 500)}`,
                retryable: false,
              };
              return;
            }
            // We got some text, but the process still exited non-zero (e.g. a
            // Codex sandbox denial mid-turn). Surface a trailing notice so the
            // failure is visible instead of looking like a clean finish.
            if (ev.exitCode !== null && ev.exitCode !== 0) {
              const detail = stderr ? `: ${stderr.slice(0, 300)}` : "";
              yield {
                type: "token",
                text: `\n\n> ⚠️ ${agent.name} exited with code ${ev.exitCode}${detail}`,
              };
            }
            yield { type: "done", content: "" };
          }
        }
      })();

      return {
        push(): void {
          /* CLI turns are one-shot; no interactive input. */
        },
        end(): void {
          /* no-op */
        },
        events,
        abort(): void {
          handle?.abort();
        },
      };
    },
  };
}

/**
 * Build the per-turn CLI context for a call site. `agentic` is the caller's
 * intent (true from the agentic loop, false from the plain-chat path); the
 * workspace dir is resolved from the active chat so the harness runs there.
 */
export function resolveCliContext(agentic: boolean): CliInvokeContext {
  let workspaceDir: string | undefined;
  try {
    workspaceDir = getWorkspaceStore().workspaceDir;
  } catch (e) {
    Zotero.debug(`[seerai] cli workspace resolve failed: ${e}`);
  }
  return { agentic, workspaceDir };
}

/** Back-compat alias. */
export const createCodexProvider = createCliProvider;
