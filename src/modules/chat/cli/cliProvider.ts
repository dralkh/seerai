import type {
  AgentProvider,
  AgentQuery,
  AnyOpenAIMessage,
  ProviderEvent,
  QueryInput,
} from "../../openai";
import type { ResolvedModel } from "../providerTypes";
import { runCli } from "./cliRunner";
import { getCliAgent } from "./agents";
import { codexAgentDef } from "./codexAgent";
import { isAuthFailureText, type CliAgentDef } from "./cliTypes";

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
export function createCliProvider(resolved: ResolvedModel): AgentProvider {
  const agent: CliAgentDef =
    getCliAgent(resolved.provider.cliAgentId) || codexAgentDef;

  return {
    isSessionInvalid(): boolean {
      return false;
    },
    query(input: QueryInput): AgentQuery {
      let handle: { abort: () => void } | null = null;

      const events = (async function* (): AsyncGenerator<ProviderEvent> {
        const prompt = buildPrompt(input.messages);
        const invokeOptions = {
          model: resolved.model.modelId,
          reasoningEffort: resolved.model.reasoningEffort,
        };
        if (agent.prepare) {
          try {
            await agent.prepare(invokeOptions);
          } catch (e) {
            Zotero.debug(`[seerai] cli prepare failed for ${agent.id}: ${e}`);
          }
        }
        const args = agent.buildArgs(invokeOptions);
        const run = runCli({ bin: agent.bin, args, stdinText: prompt });
        handle = run;

        yield { type: "init", continuation: "" };

        let sawText = false;
        let errorEmitted = false;
        let buffer = "";
        // Plain-text CLIs (Antigravity) compute their answer then print it, and
        // emit an auth-prompt URL to stdout when not signed in. So we buffer raw
        // output and decide at exit, rather than streaming an auth URL as if it
        // were the answer.
        let rawBuffer = "";

        const handleLine = function* (line: string): Generator<ProviderEvent> {
          if (!agent.parseLine) return;
          const parsed = agent.parseLine(line);
          if (parsed.kind === "text") {
            sawText = true;
            yield { type: "token", text: parsed.text };
          } else if (parsed.kind === "error" && !errorEmitted) {
            errorEmitted = true;
            yield { type: "error", message: parsed.message, retryable: false };
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

/** Back-compat alias. */
export const createCodexProvider = createCliProvider;
