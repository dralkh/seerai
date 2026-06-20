import { config } from "../../package.json";

// Standard text message
export interface OpenAIMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

// Vision message content parts for multimodal
export interface VisionMessageContentPart {
  type: "text" | "image_url";
  text?: string;
  image_url?: {
    url: string; // Can be URL or base64: "data:image/jpeg;base64,{base64_image}"
    detail?: "auto" | "low" | "high"; // Vision detail level
  };
}

// Vision-enabled message (for GPT-4 Vision, Claude 3, etc.)
export interface VisionMessage {
  role: "system" | "user" | "assistant";
  content: string | VisionMessageContentPart[];
}

// Union type for any message
export type AnyOpenAIMessage =
  | OpenAIMessage
  | VisionMessage
  | ToolCallMessage
  | ToolResultMessage;

// Tool definition in OpenAI format
export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: object;
  };
}

// Tool call from API response
export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

// Message with tool calls (assistant response)
export interface ToolCallMessage {
  role: "assistant";
  content: string | null;
  tool_calls: ToolCall[];
}

// Message with tool result (to send back)
export interface ToolResultMessage {
  role: "tool";
  tool_call_id: string;
  content: string;
}

export interface StreamCallbacks {
  onToken?: (token: string) => void;
  onReasoningContent?: (content: string) => void;
  onComplete?: (fullContent: string) => void;
  onError?: (error: Error) => void;
  /** Called when tool calls are detected in the response */
  onToolCalls?: (toolCalls: ToolCall[]) => void;
}

// ── Agent Provider Abstraction ──────────────────────────────────────
// Decouples the agentic loop from direct chatCompletionStream callbacks,
// enabling future multi-provider support and cleaner streaming lifecycle.
// Inspired by nanoclaw's AgentProvider pattern.

export interface QueryInput {
  messages: AnyOpenAIMessage[];
  tools?: ToolDefinition[];
  configOverride?: {
    apiURL?: string;
    apiKey?: string;
    model?: string;
    temperature?: number;
    max_tokens?: number;
  };
  continuation?: string;
}

export type ProviderEvent =
  | { type: "init"; continuation: string }
  | { type: "token"; text: string }
  | { type: "tool_calls"; toolCalls: ToolCall[]; reasoningContent?: string }
  | { type: "done"; content: string; reasoningContent?: string }
  | { type: "error"; message: string; retryable: boolean };

export interface AgentQuery {
  push(message: string): void;
  end(): void;
  events: AsyncIterable<ProviderEvent>;
  abort(): void;
}

export interface AgentProvider {
  query(input: QueryInput): AgentQuery;
  isSessionInvalid(err: unknown): boolean;
}

export interface AgentModelCapabilities {
  supportsTools: boolean;
  supportsStreamingTools: boolean;
  knownIncompatibleReason?: string;
}

export function getAgentModelCapabilities(
  apiURL: string,
  model: string,
): AgentModelCapabilities {
  const api = (apiURL || "").toLowerCase();
  const m = (model || "").toLowerCase();
  const isDeepSeekProvider = api.includes("deepseek") || m.includes("deepseek");
  const isDeepSeekReasoner =
    m.includes("deepseek-reasoner") ||
    m.includes("deepseek-r1") ||
    m.includes("/r1") ||
    m.endsWith(":r1") ||
    m.includes("reasoner");

  if (isDeepSeekProvider && isDeepSeekReasoner) {
    return {
      supportsTools: false,
      supportsStreamingTools: false,
      knownIncompatibleReason:
        "The selected DeepSeek reasoning model does not support function/tool calling. Agent mode requires a tool-capable chat model. Switch this chat to deepseek-chat, a non-thinking DeepSeek model, or another tool-capable model, then retry.",
    };
  }

  return {
    supportsTools: true,
    supportsStreamingTools: true,
  };
}

export interface ChatCompletionOptions {
  signal?: {
    readonly aborted: boolean;
    addEventListener(type: "abort", listener: () => void): void;
    removeEventListener(type: "abort", listener: () => void): void;
  };
  timeoutMs?: number;
  isolated?: boolean;
  modelRef?: import("./chat/providerTypes").ModelRef;
}

import { RateLimiter } from "../utils/rateLimiter";
import { requireResolvedModel, resolveModel } from "./chat/modelResolver";
import type { ModelRef, ResolvedModel } from "./chat/providerTypes";
import { createCliProvider } from "./chat/cli/cliProvider";

export class OpenAIService {
  // Active AbortController for current request (may not be available in Zotero)

  private currentController: any = null;
  private isAborted: boolean = false;

  private getPrefs() {
    Zotero.debug(`[seerai] Config Prefix: ${config.prefsPrefix}`);
    Zotero.debug(`[seerai] Reading Key: ${config.prefsPrefix}.apiKey`);
    const val = Zotero.Prefs.get(`${config.prefsPrefix}.apiKey`);

    return {
      apiURL: Zotero.Prefs.get(`${config.prefsPrefix}.apiURL`) as string,
      apiKey: Zotero.Prefs.get(`${config.prefsPrefix}.apiKey`) as string,
      model: Zotero.Prefs.get(`${config.prefsPrefix}.model`) as string,
    };
  }

  /**
   * Check if there's an active request that can be aborted
   */
  isRequestActive(): boolean {
    return this.currentController !== null;
  }

  /**
   * Check if the current request has been aborted
   */
  isAbortedState(): boolean {
    return this.isAborted;
  }

  /**
   * Abort the current request if one is active
   */
  abortRequest(): boolean {
    this.isAborted = true;
    if (this.currentController) {
      try {
        this.currentController.abort();
      } catch (e) {
        // AbortController.abort() may not be available
      }
      this.currentController = null;
      Zotero.debug("[seerai] Request aborted by user");
      return true;
    }
    return false;
  }

  /**
   * Clear the abort state for a new request
   */
  resetAbortState(): void {
    this.isAborted = false;
    this.currentController = null;
  }

  private isReasoningModel(model: string): boolean {
    const m = model.toLowerCase();
    // Catch o1, o3, o4, gpt-5, reasoner (OpenRouter/deepseek), r1 (deepseek)
    return (
      m.startsWith("o1") ||
      m.startsWith("o3") ||
      m.startsWith("o4") ||
      m.startsWith("gpt-5") ||
      m.includes("/o1") ||
      m.includes("/o3") ||
      m.includes("/o4") ||
      m.includes("/gpt-5") ||
      m.includes("reasoner") ||
      m.includes("r1")
    );
  }

  /**
   * Prepare request body by handling reasoning model specifics and filtering unsupported parameters.
   */
  private prepareRequestBody(
    model: string,
    messages: AnyOpenAIMessage[],
    options?: {
      stream?: boolean;
      temperature?: number;
      max_tokens?: number;
      reasoningEffort?: "low" | "medium" | "high";
    },
  ): Record<string, unknown> {
    const isReasoning = this.isReasoningModel(model);

    const body: Record<string, unknown> = {
      model,
      messages,
    };

    if (options?.stream) {
      body.stream = true;
    }

    // Handle parameters based on model type
    if (isReasoning) {
      // Reasoning models (o1, o3, reasoner) typically:
      // 1. Don't support 'temperature', 'top_p', etc. (or require them to be default)
      // 2. Use 'max_completion_tokens' instead of 'max_tokens'
      // 3. Support 'reasoning_effort' to control reasoning depth (optional)

      if (options?.max_tokens !== undefined) {
        body.max_completion_tokens = options.max_tokens;
      }

      // Only enable reasoning if explicitly configured by user
      if (options?.reasoningEffort) {
        body.reasoning_effort = options.reasoningEffort;
        Zotero.debug(
          `[seerai] Preparing request for reasoning model: ${model}. Stripping temperature/top_p, setting reasoning_effort=${body.reasoning_effort}.`,
        );
      } else {
        Zotero.debug(
          `[seerai] Preparing request for reasoning model: ${model}. Stripping temperature/top_p, reasoning_effort not configured.`,
        );
      }
    } else {
      // Standard models
      if (options?.temperature !== undefined) {
        body.temperature = options.temperature;
      }
      if (options?.max_tokens !== undefined) {
        body.max_tokens = options.max_tokens;
      }
    }

    return body;
  }

  /**
   * Standard chat completion (non-streaming)
   */
  async chatCompletion(
    messages: OpenAIMessage[],
    options?: ChatCompletionOptions,
  ): Promise<string> {
    const resolved = resolveModel("chat", options?.modelRef);
    const prefs = this.getPrefs();
    const model = resolved?.model.modelId || prefs.model;
    const endpoint =
      resolved?.endpoint ||
      `${prefs.apiURL.replace(/\/+$/, "")}/chat/completions`;
    const rateLimiter = RateLimiter.getInstance();
    if (resolved) {
      const estimatedTokens = JSON.stringify(messages).length / 3.2;
      await rateLimiter.acquire(resolved.model, estimatedTokens);
    }

    if (!options?.isolated) this.isAborted = false;
    let signal: AbortSignal | undefined;
    let controller: AbortController | undefined;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    const abortFromCaller = () => controller?.abort();
    try {
      if (typeof AbortController !== "undefined") {
        controller = new AbortController();
        signal = controller.signal;
        if (!options?.isolated) this.currentController = controller;
        if (options?.signal) {
          if (options.signal.aborted) controller.abort();
          else options.signal.addEventListener("abort", abortFromCaller);
        }
        if (options?.timeoutMs && options.timeoutMs > 0) {
          timeoutId = setTimeout(() => {
            timedOut = true;
            controller?.abort();
          }, options.timeoutMs);
        }
      }
    } catch (e) {
      Zotero.debug("[seerai] AbortController not available, abort disabled");
    }

    try {
      if (resolved?.adapterId === "anthropic") {
        return await this.anthropicCompletion(
          endpoint,
          resolved.headers,
          model,
          messages,
          signal,
        );
      }
      const requestBody = this.prepareRequestBody(model, messages);
      Zotero.debug(
        `[seerai] Starting chat completion with model ${model} at ${endpoint}`,
      );

      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(resolved?.headers || {
            Authorization: `Bearer ${prefs.apiKey}`,
          }),
        },
        body: JSON.stringify(requestBody),
        ...(signal ? { signal } : {}),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(
          `OpenAI API Error: ${response.statusText} - ${errorText}`,
        );
      }

      const data = (await response.json()) as any;
      Zotero.debug(`[seerai] Chat completion finished for model ${model}`);
      return data.choices?.[0]?.message?.content || "";
    } catch (error) {
      if ((error as Error).name === "AbortError") {
        throw new Error(
          timedOut ? "Request timed out" : "Request was cancelled",
        );
      }
      Zotero.logError(error as Error);
      throw error;
    } finally {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
      options?.signal?.removeEventListener("abort", abortFromCaller);
      if (!options?.isolated && this.currentController === controller) {
        this.currentController = null;
      }
      if (resolved) {
        rateLimiter.release(resolved.model.id);
      }
    }
  }

  /**
   * Streaming chat completion with token-by-token callbacks
   * @param configOverride Optional config to use instead of preferences (for multi-model support)
   * @param tools Optional tool definitions for function calling
   */
  /**
   * Stream a chat turn from a local CLI provider (Codex/Claude/Gemini/Copilot)
   * into StreamCallbacks. Inherits the CLI's own login; no HTTP, no API key.
   */
  private async cliCompletionStream(
    resolved: ResolvedModel,
    messages: AnyOpenAIMessage[],
    callbacks: StreamCallbacks,
  ): Promise<void> {
    this.isAborted = false;
    const provider = createCliProvider(resolved);
    const query = provider.query({ messages });
    this.currentController = { abort: () => query.abort() };
    let fullContent = "";
    try {
      for await (const event of query.events) {
        if (this.isAborted) {
          query.abort();
          throw new Error("Request was cancelled");
        }
        switch (event.type) {
          case "token":
            fullContent += event.text;
            callbacks.onToken?.(event.text);
            break;
          case "error":
            throw new Error(event.message);
          case "done":
          case "init":
          case "tool_calls":
            break;
        }
      }
      callbacks.onComplete?.(fullContent);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      callbacks.onError?.(err);
      throw err;
    } finally {
      if (this.currentController && this.currentController.abort) {
        this.currentController = null;
      }
    }
  }

  async chatCompletionStream(
    messages: AnyOpenAIMessage[],
    callbacks: StreamCallbacks,
    configOverride?: {
      apiURL?: string;
      apiKey?: string;
      model?: string;
      temperature?: number;
      max_tokens?: number;
      modelRef?: ModelRef;
      endpoint?: string;
      headers?: Record<string, string>;
    },
    tools?: ToolDefinition[],
  ): Promise<void> {
    const prefs = this.getPrefs();
    const resolved = resolveModel("chat", configOverride?.modelRef);

    // Local CLI providers (Codex/Claude/Gemini/Copilot) don't speak HTTP —
    // delegate to the installed CLI and pump its streamed output through the
    // same callbacks. This covers BOTH the non-agentic streaming path (here)
    // and, separately, the agentic loop in agenticChat.ts.
    if (resolved?.adapterId === "local-cli") {
      await this.cliCompletionStream(resolved, messages, callbacks);
      return;
    }

    const apiURL =
      configOverride?.apiURL || resolved?.provider.apiURL || prefs.apiURL;
    const apiKey =
      configOverride?.apiKey || resolved?.provider.apiKey || prefs.apiKey;
    const model =
      configOverride?.model || resolved?.model.modelId || prefs.model;
    const rateLimiter = RateLimiter.getInstance();
    if (resolved) {
      const estimatedTokens = JSON.stringify(messages).length / 3.2;
      await rateLimiter.acquire(resolved.model, estimatedTokens);
    }

    const endpoint =
      configOverride?.endpoint ||
      resolved?.endpoint ||
      `${apiURL.replace(/\/+$/, "")}/chat/completions`;

    // Create new AbortController for this request (if available)
    this.isAborted = false;
    let signal: AbortSignal | undefined;
    try {
      if (typeof AbortController !== "undefined") {
        this.currentController = new AbortController();
        signal = this.currentController.signal;
      }
    } catch (e) {
      Zotero.debug("[seerai] AbortController not available, abort disabled");
    }

    let fullContent = "";
    let reasoningContent = "";

    // Track tool calls being assembled from streaming chunks
    const toolCallsInProgress: Map<
      number,
      {
        id: string;
        type: "function";
        function: { name: string; arguments: string };
      }
    > = new Map();

    try {
      if (resolved?.adapterId === "anthropic") {
        await this.anthropicCompletionStream(
          endpoint,
          configOverride?.headers || resolved.headers,
          model,
          messages,
          callbacks,
          signal,
          tools,
          configOverride?.max_tokens,
        );
        return;
      }
      // Build request body using centralized helper
      const requestBody = this.prepareRequestBody(model, messages, {
        stream: true,
        temperature: configOverride?.temperature,
        max_tokens: configOverride?.max_tokens,
        reasoningEffort: resolved?.model.reasoningEffort,
      });

      // Add tools if provided
      // NOTE: reasoning_effort is incompatible with function tools on some models
      // (e.g. gpt-5.4-nano). Strip it when tools are present.
      if (tools && tools.length > 0) {
        const capabilities = getAgentModelCapabilities(apiURL, model);
        if (!capabilities.supportsTools) {
          throw new Error(capabilities.knownIncompatibleReason);
        }
        requestBody.tools = tools;
        requestBody.tool_choice = resolved?.model.toolChoice || "auto";
        delete requestBody.reasoning_effort;
      }

      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(configOverride?.headers ||
            resolved?.headers || { Authorization: `Bearer ${apiKey}` }),
        },
        body: JSON.stringify(requestBody),
        ...(signal ? { signal } : {}),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(
          `OpenAI API Error: ${response.statusText} - ${errorText}`,
        );
      }

      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error("Failed to get response reader");
      }

      const decoder = new TextDecoder();

      while (true) {
        const result = await (reader as any).read();
        const { done, value } = result;

        if (done) break;

        // Check if manually aborted (fallback for environments without AbortController)
        if (this.isAborted) {
          callbacks.onComplete?.(fullContent);
          Zotero.debug("[seerai] Stream manually aborted");
          throw new Error("Request was cancelled");
        }

        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split("\n").filter((line) => line.trim() !== "");

        for (const line of lines) {
          if (line.startsWith("data: ")) {
            const data = line.slice(6);

            if (data === "[DONE]") {
              continue;
            }

            try {
              const parsed = JSON.parse(data);
              const delta = parsed.choices?.[0]?.delta;

              // Handle regular content tokens
              if (delta?.content) {
                fullContent += delta.content;
                callbacks.onToken?.(delta.content);
              }

              if (delta?.reasoning_content) {
                reasoningContent += delta.reasoning_content;
                callbacks.onReasoningContent?.(delta.reasoning_content);
              }

              // Handle tool calls (streamed incrementally)
              if (delta?.tool_calls) {
                for (const toolCallDelta of delta.tool_calls) {
                  const index = toolCallDelta.index ?? 0;

                  // Initialize tool call if this is the first chunk for this index
                  if (!toolCallsInProgress.has(index)) {
                    toolCallsInProgress.set(index, {
                      id: toolCallDelta.id || "",
                      type: "function",
                      function: {
                        name: toolCallDelta.function?.name || "",
                        arguments: "",
                      },
                    });
                  }

                  const toolCall = toolCallsInProgress.get(index)!;

                  // Update with new data
                  if (toolCallDelta.id) {
                    toolCall.id = toolCallDelta.id;
                  }
                  if (toolCallDelta.function?.name) {
                    toolCall.function.name = toolCallDelta.function.name;
                  }
                  if (toolCallDelta.function?.arguments) {
                    toolCall.function.arguments +=
                      toolCallDelta.function.arguments;
                  }
                }
              }
            } catch (e) {
              // Skip malformed JSON chunks
            }
          }
        }
      }

      // After stream ends, check if we have tool calls to dispatch
      if (toolCallsInProgress.size > 0) {
        const toolCalls: ToolCall[] = Array.from(toolCallsInProgress.values());
        Zotero.debug(
          `[seerai] Stream completed with ${toolCalls.length} tool call(s)`,
        );

        // Invoke tool calls callback
        if (callbacks.onToolCalls) {
          callbacks.onToolCalls(toolCalls);
        }
      }

      callbacks.onComplete?.(fullContent);
    } catch (error) {
      if ((error as Error).name === "AbortError") {
        // Call onComplete with partial content when aborted
        callbacks.onComplete?.(fullContent);
        Zotero.debug("[seerai] Stream aborted by user");
        throw new Error("Request was cancelled");
      }
      callbacks.onError?.(error as Error);
      Zotero.logError(error as Error);
      throw error;
    } finally {
      this.currentController = null;
      if (resolved) {
        rateLimiter.release(resolved.model.id);
      }
    }
  }

  private anthropicMessages(messages: AnyOpenAIMessage[]) {
    const system = messages
      .filter((message) => message.role === "system")
      .map((message) =>
        typeof message.content === "string"
          ? message.content
          : JSON.stringify(message.content),
      )
      .join("\n\n");
    const converted = messages
      .filter((message) => message.role !== "system")
      .map((message) => {
        if (message.role === "tool") {
          return {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: message.tool_call_id,
                content: message.content,
              },
            ],
          };
        }
        if (message.role === "assistant" && "tool_calls" in message) {
          return {
            role: "assistant",
            content: [
              ...(message.content
                ? [{ type: "text", text: message.content }]
                : []),
              ...message.tool_calls.map((toolCall) => ({
                type: "tool_use",
                id: toolCall.id,
                name: toolCall.function.name,
                input: (() => {
                  try {
                    return JSON.parse(toolCall.function.arguments || "{}");
                  } catch {
                    return {};
                  }
                })(),
              })),
            ],
          };
        }
        if (Array.isArray(message.content)) {
          return {
            role: message.role,
            content: message.content.map((part) => {
              if (part.type === "text") {
                return { type: "text", text: part.text || "" };
              }
              const url = part.image_url?.url || "";
              const dataMatch = url.match(/^data:([^;]+);base64,(.+)$/);
              return dataMatch
                ? {
                    type: "image",
                    source: {
                      type: "base64",
                      media_type: dataMatch[1],
                      data: dataMatch[2],
                    },
                  }
                : {
                    type: "image",
                    source: { type: "url", url },
                  };
            }),
          };
        }
        return { role: message.role, content: message.content };
      });
    return { system, messages: converted };
  }

  private async anthropicCompletion(
    endpoint: string,
    headers: Record<string, string>,
    model: string,
    messages: AnyOpenAIMessage[],
    signal?: AbortSignal,
  ): Promise<string> {
    const converted = this.anthropicMessages(messages);
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({
        model,
        max_tokens: 4096,
        ...(converted.system && { system: converted.system }),
        messages: converted.messages,
      }),
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) {
      throw new Error(
        `Anthropic API error (${response.status}): ${await response.text()}`,
      );
    }
    const data = (await response.json()) as {
      content?: Array<{ type: string; text?: string }>;
    };
    return (data.content || [])
      .filter((block) => block.type === "text")
      .map((block) => block.text || "")
      .join("");
  }

  private async anthropicCompletionStream(
    endpoint: string,
    headers: Record<string, string>,
    model: string,
    messages: AnyOpenAIMessage[],
    callbacks: StreamCallbacks,
    signal: AbortSignal | undefined,
    tools: ToolDefinition[] | undefined,
    maxTokens: number | undefined,
  ): Promise<void> {
    const converted = this.anthropicMessages(messages);
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens || 16384,
        stream: true,
        ...(converted.system && { system: converted.system }),
        messages: converted.messages,
        ...(tools?.length && {
          tools: tools.map((tool) => ({
            name: tool.function.name,
            description: tool.function.description,
            input_schema: tool.function.parameters,
          })),
        }),
      }),
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) {
      throw new Error(
        `Anthropic API error (${response.status}): ${await response.text()}`,
      );
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Failed to get Anthropic response stream");
    const decoder = new TextDecoder();
    const toolCalls = new Map<number, ToolCall>();
    let buffer = "";
    let fullContent = "";
    while (true) {
      const { done, value } = await (reader as any).read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split("\n\n");
      buffer = events.pop() || "";
      for (const event of events) {
        const line = event
          .split("\n")
          .find((candidate) => candidate.startsWith("data: "));
        if (!line) continue;
        const data = JSON.parse(line.slice(6)) as any;
        if (data.type === "content_block_start") {
          const block = data.content_block;
          if (block?.type === "tool_use") {
            toolCalls.set(data.index, {
              id: block.id,
              type: "function",
              function: { name: block.name, arguments: "" },
            });
          }
        } else if (data.type === "content_block_delta") {
          if (data.delta?.type === "text_delta") {
            fullContent += data.delta.text || "";
            callbacks.onToken?.(data.delta.text || "");
          } else if (data.delta?.type === "input_json_delta") {
            const toolCall = toolCalls.get(data.index);
            if (toolCall) {
              toolCall.function.arguments += data.delta.partial_json || "";
            }
          }
        }
      }
    }
    if (toolCalls.size > 0) {
      callbacks.onToolCalls?.(Array.from(toolCalls.values()));
    }
    callbacks.onComplete?.(fullContent);
  }

  async testConnection(): Promise<boolean> {
    try {
      await this.chatCompletion([{ role: "user", content: "Hello" }]);
      return true;
    } catch (e) {
      return false;
    }
  }

  /**
   * Text-to-Speech: converts text to audio using the configured TTS model.
   * Returns an ArrayBuffer of audio data (typically mp3).
   *
   * Handles multiple provider response formats:
   * - Binary audio (OpenAI standard): returns ArrayBuffer directly
   * - JSON with audioUrl (NanoGPT Kokoro etc.): fetches the audio URL
   * - HTTP 202 async (NanoGPT Elevenlabs etc.): polls until complete
   */
  async textToSpeech(
    text: string,
    options?: { voice?: string },
  ): Promise<ArrayBuffer> {
    const resolved = requireResolvedModel("tts");
    const ttsModel = resolved.model.modelId;
    const apiKey = resolved.provider.apiKey;
    const endpoint = resolved.endpoint;
    const voice =
      options?.voice ||
      resolved.model.voice ||
      (ttsModel.toLowerCase().includes("kokoro") ? "af_alloy" : "alloy");
    const isOpenRouter =
      resolved.adapterId === "openrouter" ||
      resolved.provider.presetId === "openrouter";
    const isMimo = resolved.adapterId === "mimo";
    const isXai = resolved.provider.presetId === "xai";
    const isMinimax = resolved.provider.presetId === "minimax";
    const isMistral = resolved.provider.presetId === "mistral";

    Zotero.debug(
      `[seerai] TTS request: model=${ttsModel}, voice=${voice || "(default)"}, endpoint=${endpoint}, text length=${text.length}`,
    );

    // Send both auth header styles for cross-provider compatibility:
    // - "Authorization: Bearer" for OpenAI-compatible endpoints
    // - "x-api-key" for NanoGPT endpoints
    // Each provider ignores the header it doesn't recognize.
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...resolved.headers,
      },
      // Send both "input" (OpenAI standard) and "text" (NanoGPT) fields.
      // Each provider uses the field it recognizes.
      body: JSON.stringify(
        isMimo
          ? {
              model: ttsModel,
              messages: [{ role: "assistant", content: text }],
              modalities: ["text", "audio"],
              audio: { voice, format: "mp3" },
            }
          : isXai
            ? {
                text,
                voice_id: voice === "alloy" ? "eve" : voice,
                language: "auto",
                output_format: {
                  codec: "mp3",
                  sample_rate: 24000,
                  bit_rate: 128000,
                },
              }
            : isMinimax
              ? {
                  model: ttsModel,
                  text,
                  stream: false,
                  language_boost: "auto",
                  output_format: "hex",
                  voice_setting: {
                    voice_id:
                      voice === "alloy" ? "English_expressive_narrator" : voice,
                    speed: 1,
                    vol: 1,
                    pitch: 0,
                  },
                  audio_setting: {
                    sample_rate: 32000,
                    bitrate: 128000,
                    format: "mp3",
                    channel: 1,
                  },
                }
              : isMistral
                ? {
                    model: ttsModel,
                    input: text,
                    voice_id: voice,
                    response_format: "mp3",
                  }
                : {
                    model: ttsModel,
                    input: text,
                    text: text,
                    voice,
                    ...(isOpenRouter && { response_format: "mp3" }),
                  },
      ),
    });

    // Handle HTTP 202 Accepted — async generation (e.g. NanoGPT Elevenlabs)
    // Requires polling GET /api/tts/status?runId=...&model=...
    if (response.status === 202) {
      const asyncResult = (await response.json()) as unknown as Record<
        string,
        unknown
      >;
      if (asyncResult.runId) {
        Zotero.debug(`[seerai] TTS async: polling runId=${asyncResult.runId}`);
        return this._pollTtsResult(
          endpoint,
          asyncResult.runId as string,
          ttsModel,
          apiKey,
        );
      }
      throw new Error("TTS returned 202 but no runId for polling");
    }

    if (!response.ok) {
      const errorText = await response.text();
      Zotero.debug(`[seerai] TTS error: ${response.status} - ${errorText}`);
      throw new Error(`TTS API Error (${response.status}): ${errorText}`);
    }

    // Determine response type from Content-Type header
    const contentType = response.headers.get("Content-Type") || "";

    // JSON response — provider returned metadata with an audioUrl (NanoGPT Kokoro)
    if (contentType.includes("application/json")) {
      const json = (await response.json()) as unknown as Record<
        string,
        unknown
      >;
      Zotero.debug(
        `[seerai] TTS JSON response: audioUrl=${json.audioUrl}, model=${json.model}, cost=${json.cost}`,
      );
      const choices = Array.isArray(json.choices) ? json.choices : [];
      const choice = choices[0] as Record<string, unknown> | undefined;
      const message = choice?.message as Record<string, unknown> | undefined;
      const audio = message?.audio as Record<string, unknown> | undefined;
      const minimaxData = json.data as Record<string, unknown> | undefined;
      const encodedAudio =
        (audio?.data as string | undefined) ||
        (json.audio_data as string | undefined) ||
        (minimaxData?.audio as string | undefined);
      if (typeof encodedAudio === "string") {
        const encoded = encodedAudio.includes(",")
          ? encodedAudio.slice(encodedAudio.indexOf(",") + 1)
          : encodedAudio;
        if (isMinimax) {
          const bytes = new Uint8Array(encoded.length / 2);
          for (let index = 0; index < encoded.length; index += 2) {
            bytes[index / 2] = Number.parseInt(
              encoded.slice(index, index + 2),
              16,
            );
          }
          return bytes.buffer;
        }
        const binary = atob(encoded);
        const bytes = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index++) {
          bytes[index] = binary.charCodeAt(index);
        }
        return bytes.buffer;
      }
      if (!json.audioUrl) {
        throw new Error("TTS response missing audioUrl");
      }
      // Fetch the actual audio binary from the returned URL
      const audioResponse = await fetch(json.audioUrl as string);
      if (!audioResponse.ok) {
        throw new Error(
          `Failed to fetch TTS audio from ${json.audioUrl}: ${audioResponse.status}`,
        );
      }
      return audioResponse.arrayBuffer();
    }

    if (
      !contentType.startsWith("audio/") &&
      !contentType.includes("application/octet-stream")
    ) {
      const responseText = await response.text();
      throw new Error(
        `TTS returned unsupported content type ${contentType || "(missing)"}: ${responseText.substring(0, 200)}`,
      );
    }

    // Binary audio response (OpenAI standard, NanoGPT OpenAI models)
    return response.arrayBuffer();
  }

  /**
   * Poll NanoGPT async TTS status until audio is ready.
   * Used for models like Elevenlabs that return HTTP 202.
   */
  private async _pollTtsResult(
    baseEndpoint: string,
    runId: string,
    model: string,
    apiKey: string,
    maxAttempts = 30,
    intervalMs = 2000,
  ): Promise<ArrayBuffer> {
    // Derive the status URL from the base endpoint
    // e.g. "https://nano-gpt.com/api/tts" → "https://nano-gpt.com/api/tts/status"
    const statusUrl = new URL(baseEndpoint);
    statusUrl.pathname = statusUrl.pathname.replace(/\/?$/, "/status");
    statusUrl.searchParams.set("runId", runId);
    statusUrl.searchParams.set("model", model);

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));

      const res = await fetch(statusUrl.toString(), {
        headers: {
          "x-api-key": apiKey,
          Authorization: `Bearer ${apiKey}`,
        },
      });

      if (!res.ok) {
        Zotero.debug(
          `[seerai] TTS poll error: ${res.status} (attempt ${attempt + 1})`,
        );
        continue;
      }

      const data = (await res.json()) as unknown as Record<string, unknown>;
      Zotero.debug(
        `[seerai] TTS poll attempt ${attempt + 1}: status=${data.status}`,
      );

      if (data.status === "completed" && data.audioUrl) {
        const audioRes = await fetch(data.audioUrl as string);
        if (!audioRes.ok) {
          throw new Error(
            `Failed to fetch async TTS audio: ${audioRes.status}`,
          );
        }
        return audioRes.arrayBuffer();
      }

      if (data.status === "failed" || data.status === "error") {
        throw new Error(
          `TTS async generation failed: ${data.error || "unknown error"}`,
        );
      }
      // Otherwise status is "pending" / "processing" — keep polling
    }

    throw new Error(
      `TTS async generation timed out after ${(maxAttempts * intervalMs) / 1000}s`,
    );
  }

  /**
   * Speech-to-Text: transcribe audio to text.
   *
   * Supports two modes:
   * 1. Direct file upload (ArrayBuffer/Blob, <=3MB) — multipart/form-data
   * 2. URL upload (string URL, <=500MB) — JSON body
   *
   * NanoGPT endpoint: POST /api/transcribe (not /api/v1/audio/transcriptions)
   * OpenAI-compatible: POST /api/v1/audio/transcriptions
   *
   * Synchronous models (Whisper, Wizper, gpt-4o-mini-transcribe) return:
   *   { transcription, metadata }
   * Async models (Elevenlabs-STT) return HTTP 202, poll via POST /api/transcribe/status
   */
  async speechToText(
    audio: ArrayBuffer | Uint8Array | Blob | string,
    options?: {
      language?: string;
      prompt?: string;
      filename?: string;
    },
  ): Promise<{ transcription: string; metadata?: Record<string, unknown> }> {
    const resolved = requireResolvedModel("stt");
    const sttModel = resolved.model.modelId;
    const apiKey = resolved.provider.apiKey;
    const endpoint = resolved.endpoint;
    const isNanoGpt = resolved.adapterId === "nanogpt";
    const isMimo = resolved.adapterId === "mimo";
    const isXai = resolved.provider.presetId === "xai";

    Zotero.debug(
      `[seerai] STT request: model=${sttModel}, endpoint=${endpoint}, type=${typeof audio === "string" ? "url" : "file"}`,
    );

    let response: Response;

    if (isMimo) {
      let dataUrl: string;
      if (typeof audio === "string") {
        const audioResponse = await fetch(audio);
        if (!audioResponse.ok) {
          throw new Error(
            `Failed to fetch audio input (${audioResponse.status})`,
          );
        }
        const mimeType =
          audioResponse.headers.get("Content-Type")?.split(";")[0] ||
          "audio/mpeg";
        const bytes = new Uint8Array(await audioResponse.arrayBuffer());
        let binary = "";
        for (const byte of bytes) binary += String.fromCharCode(byte);
        dataUrl = `data:${mimeType};base64,${btoa(binary)}`;
      } else {
        const value = audio as any;
        let bytes: Uint8Array;
        if (value?.BYTES_PER_ELEMENT != null) {
          bytes = new Uint8Array(
            value.buffer ?? value,
            value.byteOffset ?? 0,
            value.byteLength,
          );
        } else if (value?.size != null) {
          bytes = new Uint8Array(await value.arrayBuffer());
        } else {
          bytes = new Uint8Array(audio as ArrayBuffer);
        }
        const filename = options?.filename || "recording.webm";
        const extension = filename.split(".").pop()?.toLowerCase();
        const mimeType =
          extension === "mp3"
            ? "audio/mpeg"
            : extension === "wav"
              ? "audio/wav"
              : extension === "m4a"
                ? "audio/mp4"
                : "audio/webm";
        let binary = "";
        for (const byte of bytes) binary += String.fromCharCode(byte);
        dataUrl = `data:${mimeType};base64,${btoa(binary)}`;
      }
      response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...resolved.headers,
        },
        body: JSON.stringify({
          model: sttModel,
          messages: [
            {
              role: "user",
              content: [
                { type: "input_audio", input_audio: { data: dataUrl } },
              ],
            },
          ],
          asr_options: { language: options?.language || "auto" },
        }),
      });
      if (!response.ok) {
        throw new Error(
          `STT API Error (${response.status}): ${await response.text()}`,
        );
      }
      const result = (await response.json()) as unknown as Record<
        string,
        unknown
      >;
      const choices = Array.isArray(result.choices) ? result.choices : [];
      const choice = choices[0] as Record<string, unknown> | undefined;
      const message = choice?.message as Record<string, unknown> | undefined;
      return { transcription: String(message?.content || "") };
    }

    if (typeof audio === "string") {
      // URL-based upload — JSON body
      response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...resolved.headers,
        },
        body: JSON.stringify({
          model: sttModel,
          url: audio,
          ...(options?.language && { language: options.language }),
          ...(options?.prompt && { prompt: options.prompt }),
        }),
      });
    } else {
      // Direct file upload — multipart/form-data
      // Gecko's fetch() doesn't reliably send binary multipart bodies.
      // Use Zotero.HTTP.request() with manual multipart construction
      // (same proven pattern as ocr.ts for Mistral/DataLab uploads).
      let fileBytes: Uint8Array;

      // Detect type robustly — instanceof checks fail across Gecko sandbox boundaries.
      // Use duck-typing: ArrayBuffer has byteLength but no 'size' property;
      // Uint8Array has byteLength + BYTES_PER_ELEMENT; Blob has 'size' + 'type'.
      const audioAny = audio as any;
      if (audio instanceof Uint8Array || audioAny?.BYTES_PER_ELEMENT != null) {
        // Already a Uint8Array (or typed array)
        fileBytes = new Uint8Array(
          audioAny.buffer ?? audioAny,
          audioAny.byteOffset ?? 0,
          audioAny.byteLength,
        );
      } else if (
        audio instanceof ArrayBuffer ||
        (audioAny?.byteLength != null &&
          typeof audioAny?.slice === "function" &&
          audioAny?.size == null)
      ) {
        // ArrayBuffer (or cross-realm ArrayBuffer)
        fileBytes = new Uint8Array(audio as ArrayBuffer);
      } else {
        // Blob — convert to Uint8Array
        const blob = audio as Blob;
        if (typeof blob.arrayBuffer === "function") {
          fileBytes = new Uint8Array(await blob.arrayBuffer());
        } else {
          // FileReader fallback for Gecko sandbox compatibility
          fileBytes = await new Promise<Uint8Array>((resolve, reject) => {
            const win = Zotero.getMainWindow() as any;
            const reader = new (win.FileReader || FileReader)();
            reader.onload = () =>
              resolve(new Uint8Array(reader.result as ArrayBuffer));
            reader.onerror = () =>
              reject(new Error("FileReader failed to read audio blob"));
            reader.readAsArrayBuffer(blob);
          });
        }
      }

      const filename = options?.filename || "recording.webm";
      // Infer MIME type from filename extension
      const extMatch = filename.match(/\.(\w+)$/);
      const ext = extMatch ? extMatch[1].toLowerCase() : "webm";
      const mimeMap: Record<string, string> = {
        webm: "audio/webm",
        ogg: "audio/ogg",
        mp3: "audio/mpeg",
        wav: "audio/wav",
        m4a: "audio/mp4",
        flac: "audio/flac",
        aac: "audio/aac",
      };
      const fileMime = mimeMap[ext] || "application/octet-stream";

      const boundary = "----SeerAiSTTBoundary" + Date.now();
      const encoder = new TextEncoder();

      // Build multipart parts
      let preFile = "";
      if (isXai) {
        if (options?.language) {
          preFile += `--${boundary}\r\nContent-Disposition: form-data; name="language"\r\n\r\n${options.language}\r\n`;
          preFile += `--${boundary}\r\nContent-Disposition: form-data; name="format"\r\n\r\ntrue\r\n`;
        }
      }
      preFile += `--${boundary}\r\n`;
      preFile += `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n`;
      preFile += `Content-Type: ${fileMime}\r\n\r\n`;

      let postFile = "";
      if (!isXai) {
        postFile += `\r\n--${boundary}\r\n`;
        postFile += `Content-Disposition: form-data; name="model"\r\n\r\n`;
        postFile += sttModel;
        if (options?.language) {
          postFile += `\r\n--${boundary}\r\n`;
          postFile += `Content-Disposition: form-data; name="language"\r\n\r\n`;
          postFile += options.language;
        }
        if (options?.prompt) {
          postFile += `\r\n--${boundary}\r\n`;
          postFile += `Content-Disposition: form-data; name="prompt"\r\n\r\n`;
          postFile += options.prompt;
        }
      }
      postFile += `\r\n--${boundary}--\r\n`;

      const preBytes = encoder.encode(preFile);
      const postBytes = encoder.encode(postFile);
      const body = new Uint8Array(
        preBytes.length + fileBytes.length + postBytes.length,
      );
      body.set(preBytes, 0);
      body.set(fileBytes, preBytes.length);
      body.set(postBytes, preBytes.length + fileBytes.length);

      Zotero.debug(
        `[seerai] STT upload: fileBytes=${fileBytes.length}, preBytes=${preBytes.length}, postBytes=${postBytes.length}, totalBody=${body.length}, boundary=${boundary}, mime=${fileMime}, endpoint=${endpoint}`,
      );

      // Use Zotero.HTTP.request() — proven to work for binary multipart in Gecko
      // successCodes prevents Zotero from throwing on non-2xx responses so we
      // can read the actual error body from the server.
      let httpResponse: any;
      try {
        httpResponse = await (Zotero.HTTP as any).request("POST", endpoint, {
          headers: {
            "Content-Type": `multipart/form-data; boundary=${boundary}`,
            ...resolved.headers,
          },
          body: body,
          responseType: "json",
          successCodes: [200, 201, 202, 400, 401, 403, 413, 415, 422, 500],
          timeout: 120000,
        });
      } catch (httpErr: any) {
        // Zotero.HTTP.request may still throw for network errors or
        // status codes not in successCodes — log full details
        const errStatus = httpErr?.status ?? httpErr?.xmlhttp?.status ?? "?";
        const errResponse =
          httpErr?.xmlhttp?.response ??
          httpErr?.xmlhttp?.responseText ??
          httpErr?.message ??
          String(httpErr);
        Zotero.debug(
          `[seerai] STT HTTP error (thrown): status=${errStatus}, body=${typeof errResponse === "string" ? errResponse.substring(0, 500) : JSON.stringify(errResponse)?.substring(0, 500)}`,
        );
        throw new Error(
          `STT request failed (${errStatus}): ${typeof errResponse === "string" ? errResponse.substring(0, 200) : JSON.stringify(errResponse)?.substring(0, 200)}`,
        );
      }

      const status = httpResponse.status;
      // responseType:"json" → httpResponse.response is parsed JSON (or null/string on error)
      // Also try responseText as fallback for error bodies
      const responseData = httpResponse.response ?? httpResponse.responseText;

      Zotero.debug(
        `[seerai] STT response: status=${status}, type=${typeof responseData}, data=${JSON.stringify(responseData)?.substring(0, 500)}`,
      );

      // Handle HTTP 202 Accepted — async generation
      if (status === 202) {
        const asyncResult = responseData as Record<string, unknown>;
        if (asyncResult?.runId) {
          Zotero.debug(
            `[seerai] STT async: polling runId=${asyncResult.runId}`,
          );
          return this._pollSttResult(
            endpoint,
            asyncResult.runId as string,
            sttModel,
            apiKey,
          );
        }
        throw new Error("STT returned 202 but no runId for polling");
      }

      if (status < 200 || status >= 300) {
        const errorText =
          typeof responseData === "string"
            ? responseData
            : JSON.stringify(responseData);
        Zotero.debug(`[seerai] STT error: ${status} - ${errorText}`);
        throw new Error(`STT API Error (${status}): ${errorText}`);
      }

      // Parse response — Zotero.HTTP.request with responseType:"json" returns parsed object
      const result =
        typeof responseData === "string"
          ? JSON.parse(responseData)
          : responseData;

      const transcription =
        (result?.transcription as string) || (result?.text as string) || "";

      Zotero.debug(
        `[seerai] STT result: ${transcription.length} chars, metadata=${!!result?.metadata}`,
      );

      return {
        transcription,
        metadata: result?.metadata as Record<string, unknown> | undefined,
      };
    }

    // ── Below handles only the JSON/URL path (fetch-based) ──

    // Handle HTTP 202 Accepted — async generation (e.g. NanoGPT Elevenlabs-STT)
    if (response.status === 202) {
      const asyncResult = (await response.json()) as unknown as Record<
        string,
        unknown
      >;
      if (asyncResult.runId) {
        Zotero.debug(`[seerai] STT async: polling runId=${asyncResult.runId}`);
        return this._pollSttResult(
          endpoint,
          asyncResult.runId as string,
          sttModel,
          apiKey,
        );
      }
      throw new Error("STT returned 202 but no runId for polling");
    }

    if (!response.ok) {
      const errorText = await response.text();
      Zotero.debug(`[seerai] STT error: ${response.status} - ${errorText}`);
      throw new Error(`STT API Error (${response.status}): ${errorText}`);
    }

    const result = (await response.json()) as unknown as Record<
      string,
      unknown
    >;

    // OpenAI returns { text: "..." }, NanoGPT returns { transcription: "...", metadata: {...} }
    const transcription =
      (result.transcription as string) || (result.text as string) || "";

    Zotero.debug(
      `[seerai] STT result: ${transcription.length} chars, metadata=${!!result.metadata}`,
    );

    return {
      transcription,
      metadata: result.metadata as Record<string, unknown> | undefined,
    };
  }

  /**
   * Poll NanoGPT async STT status until transcription is ready.
   * Used for models like Elevenlabs-STT that return HTTP 202.
   */
  private async _pollSttResult(
    baseEndpoint: string,
    runId: string,
    model: string,
    apiKey: string,
    maxAttempts = 60,
    intervalMs = 2000,
  ): Promise<{ transcription: string; metadata?: Record<string, unknown> }> {
    // Derive the status URL from the base endpoint
    // e.g. "https://nano-gpt.com/api/transcribe" → "https://nano-gpt.com/api/transcribe/status"
    const statusUrl = new URL(baseEndpoint);
    statusUrl.pathname = statusUrl.pathname.replace(/\/?$/, "/status");

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));

      // NanoGPT STT status uses POST with body { runId, model }
      const res = await fetch(statusUrl.toString(), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ runId, model }),
      });

      if (!res.ok) {
        Zotero.debug(
          `[seerai] STT poll error: ${res.status} (attempt ${attempt + 1})`,
        );
        continue;
      }

      const data = (await res.json()) as unknown as Record<string, unknown>;
      Zotero.debug(
        `[seerai] STT poll attempt ${attempt + 1}: status=${data.status}`,
      );

      if (data.status === "completed") {
        const transcription =
          (data.transcription as string) || (data.text as string) || "";
        return {
          transcription,
          metadata: data.metadata as Record<string, unknown> | undefined,
        };
      }

      if (data.status === "failed" || data.status === "error") {
        throw new Error(
          `STT async transcription failed: ${data.error || "unknown error"}`,
        );
      }
      // Otherwise status is "pending" / "processing" — keep polling
    }

    throw new Error(
      `STT async transcription timed out after ${(maxAttempts * intervalMs) / 1000}s`,
    );
  }

  // ── Image Generation ──────────────────────────────────────────────────
  // OpenAI-compatible: POST /v1/images/generations
  // Returns { data: [{ b64_json | url }], cost, remainingBalance }

  /**
   * Generate one or more images from a text prompt.
   *
   * Follows the OpenAI /v1/images/generations contract.
   * NanoGPT uses the same endpoint at https://nano-gpt.com/v1/images/generations.
   *
   * Returns an array of image results, each with either a base64 data URL or a signed URL.
   */
  async generateImage(
    prompt: string,
    options?: {
      model?: string;
      n?: number;
      size?: "256x256" | "512x512" | "1024x1024";
      response_format?: "b64_json" | "url";
      imageDataUrl?: string; // img2img: base64 data URL of input image
      strength?: number; // img2img strength (0-1)
      guidance_scale?: number; // prompt adherence (0-20)
      num_inference_steps?: number; // denoising steps (1-100)
      seed?: number; // reproducible seed
    },
  ): Promise<{
    images: { b64_json?: string; url?: string }[];
    cost?: number;
    remainingBalance?: number;
  }> {
    const resolved = requireResolvedModel("image");
    const imageModel = options?.model || resolved.model.modelId;
    const endpoint = resolved.endpoint;
    const isOpenRouter =
      resolved.adapterId === "openrouter" ||
      resolved.provider.presetId === "openrouter";
    const isGoogle = resolved.provider.presetId === "google";
    const isMinimax = resolved.provider.presetId === "minimax";
    const isOllama = resolved.provider.presetId === "ollama";

    // Build request body
    const body: Record<string, unknown> =
      isOpenRouter || isGoogle
        ? {
            model: imageModel,
            messages: [{ role: "user", content: prompt }],
            modalities: ["image", "text"],
            stream: false,
          }
        : isMinimax
          ? {
              model: imageModel,
              prompt,
              n: options?.n ?? 1,
              width: Number(options?.size?.split("x")[0] || 1024),
              height: Number(options?.size?.split("x")[1] || 1024),
              response_format:
                options?.response_format === "b64_json" ? "base64" : "url",
            }
          : {
              model: imageModel,
              prompt,
              n: options?.n ?? 1,
              size: options?.size ?? "1024x1024",
              response_format: isOllama
                ? "b64_json"
                : (options?.response_format ?? "url"),
            };
    if (options?.imageDataUrl) body.imageDataUrl = options.imageDataUrl;
    if (options?.strength !== undefined) body.strength = options.strength;
    if (options?.guidance_scale !== undefined)
      body.guidance_scale = options.guidance_scale;
    if (options?.num_inference_steps !== undefined)
      body.num_inference_steps = options.num_inference_steps;
    if (options?.seed !== undefined) body.seed = options.seed;

    Zotero.debug(
      `[seerai] Image generation request: model=${imageModel}, size=${body.size}, endpoint=${endpoint}, prompt="${prompt.substring(0, 80)}..."`,
    );

    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...resolved.headers,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      Zotero.debug(
        `[seerai] Image generation error: ${response.status} - ${errorText}`,
      );
      throw new Error(
        `Image generation API error (${response.status}): ${errorText}`,
      );
    }

    const data = (await response.json()) as unknown as Record<string, unknown>;
    Zotero.debug(
      `[seerai] Image generation response: cost=${data.cost}, images=${(data.data as unknown[])?.length ?? 0}`,
    );

    const images: { b64_json?: string; url?: string }[] = [];
    if (Array.isArray(data.data)) {
      for (const item of data.data as Record<string, unknown>[]) {
        images.push({
          b64_json: item.b64_json as string | undefined,
          url: item.url as string | undefined,
        });
      }
    }
    const minimaxData = data.data as Record<string, unknown> | undefined;
    if (Array.isArray(minimaxData?.image_urls)) {
      for (const url of minimaxData.image_urls) {
        if (typeof url === "string") images.push({ url });
      }
    }
    if ((isOpenRouter || isGoogle) && Array.isArray(data.choices)) {
      const choice = data.choices[0] as Record<string, unknown> | undefined;
      const message = choice?.message as Record<string, unknown> | undefined;
      if (Array.isArray(message?.images)) {
        for (const item of message.images as Record<string, unknown>[]) {
          const imageUrl = item.image_url as
            | Record<string, unknown>
            | undefined;
          const url = imageUrl?.url;
          if (typeof url === "string") images.push({ url });
        }
      }
    }

    if (images.length === 0) {
      throw new Error(
        "Image generation returned no images. Check the model and prompt.",
      );
    }

    return {
      images,
      cost: data.cost as number | undefined,
      remainingBalance: data.remainingBalance as number | undefined,
    };
  }

  // ── Video Generation ──────────────────────────────────────────────────
  // NanoGPT: POST /generate-video (async, poll /api/video/status)
  // Returns { runId, status: "pending", model, cost }

  /**
   * Generate a video from a text prompt (and optional image/audio inputs).
   *
   * This is always async: the initial POST returns { runId, status: "pending" }.
   * The caller must poll via _pollVideoResult() to get the final video URL.
   *
   * Returns the completed video assets after polling.
   */
  async generateVideo(
    prompt: string,
    options?: {
      model?: string;
      duration?: string; // e.g. "5", "8", "5s"
      aspect_ratio?: "16:9" | "9:16" | "1:1" | "4:3" | "3:4";
      resolution?: "480p" | "720p" | "1080p";
      negative_prompt?: string;
      imageDataUrl?: string; // image-to-video: base64 data URL
      imageUrl?: string; // image-to-video: public URL
      seed?: number;
      num_inference_steps?: number;
      guidance_scale?: number;
    },
    onStatusUpdate?: (
      status: string,
      attempt: number,
      maxAttempts: number,
    ) => void,
  ): Promise<{
    videoUrl?: string;
    thumbnailUrl?: string;
    runId: string;
    cost?: number;
    remainingBalance?: number;
    status: string;
    metadata?: Record<string, unknown>;
  }> {
    const resolved = requireResolvedModel("video");
    const videoModel = options?.model || resolved.model.modelId;
    const apiKey = resolved.provider.apiKey;
    const endpoint = resolved.endpoint;
    const isOpenRouter =
      resolved.adapterId === "openrouter" ||
      resolved.provider.presetId === "openrouter";
    const isOpenAIVideo = resolved.provider.presetId === "openai";
    const isXaiVideo = resolved.provider.presetId === "xai";
    const isTogetherVideo = resolved.adapterId === "together";
    const isMinimaxVideo = resolved.provider.presetId === "minimax";
    const isZaiVideo = resolved.provider.presetId === "zai";

    // Build request body
    const body: Record<string, unknown> = {
      model: videoModel,
      prompt,
    };
    if (options?.duration) {
      if (isOpenAIVideo || isTogetherVideo) body.seconds = options.duration;
      else if (isMinimaxVideo || isZaiVideo)
        body.duration = Number.parseInt(options.duration, 10);
      else {
        body.duration = isOpenRouter
          ? Number.parseInt(options.duration, 10)
          : options.duration;
      }
    }
    if (isOpenAIVideo) {
      const landscape = options?.aspect_ratio !== "9:16";
      body.size = landscape ? "1280x720" : "720x1280";
    } else if (isTogetherVideo) {
      if (options?.aspect_ratio) body.ratio = options.aspect_ratio;
      if (options?.resolution)
        body.resolution = options.resolution.toUpperCase();
    } else if (!isMinimaxVideo && !isZaiVideo) {
      if (options?.aspect_ratio) body.aspect_ratio = options.aspect_ratio;
      if (options?.resolution) body.resolution = options.resolution;
    }
    if (options?.negative_prompt)
      body.negative_prompt = options.negative_prompt;
    if (options?.imageDataUrl) body.imageDataUrl = options.imageDataUrl;
    if (options?.imageUrl) body.imageUrl = options.imageUrl;
    if (options?.seed !== undefined) body.seed = options.seed;
    if (options?.num_inference_steps !== undefined)
      body.num_inference_steps = options.num_inference_steps;
    if (options?.guidance_scale !== undefined)
      body.guidance_scale = options.guidance_scale;

    Zotero.debug(
      `[seerai] Video generation request: model=${videoModel}, endpoint=${endpoint}, prompt="${prompt.substring(0, 80)}..."`,
    );

    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...resolved.headers,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      Zotero.debug(
        `[seerai] Video generation error: ${response.status} - ${errorText}`,
      );
      throw new Error(
        `Video generation API error (${response.status}): ${errorText}`,
      );
    }

    const data = (await response.json()) as unknown as Record<string, unknown>;
    const runId =
      (data.runId as string) ||
      (data.id as string) ||
      (data.request_id as string) ||
      (data.task_id as string);

    if (!runId) {
      throw new Error("Video generation response missing runId for polling.");
    }

    Zotero.debug(
      `[seerai] Video generation submitted: runId=${runId}, status=${data.status}, cost=${data.cost}`,
    );

    // Poll for completion
    if (isOpenRouter || isOpenAIVideo) {
      const pollingUrl = data.polling_url as string | undefined;
      return this._pollOpenRouterVideoResult(
        runId,
        pollingUrl,
        resolved.provider.apiURL,
        resolved.headers,
        onStatusUpdate,
      );
    }

    if (isXaiVideo) {
      return this._pollXaiVideoResult(
        runId,
        resolved.provider.apiURL,
        resolved.headers,
        onStatusUpdate,
      );
    }

    if (isTogetherVideo) {
      return this._pollTogetherVideoResult(
        runId,
        resolved.provider.apiURL,
        resolved.headers,
        onStatusUpdate,
      );
    }

    if (isMinimaxVideo) {
      return this._pollMinimaxVideoResult(
        runId,
        resolved.provider.apiURL,
        resolved.headers,
        onStatusUpdate,
      );
    }

    if (isZaiVideo) {
      return this._pollZaiVideoResult(
        runId,
        resolved.provider.apiURL,
        resolved.headers,
        onStatusUpdate,
      );
    }

    return this._pollVideoResult(
      runId,
      videoModel,
      apiKey,
      resolved.provider.apiURL,
      onStatusUpdate,
    );
  }

  private async _pollMinimaxVideoResult(
    runId: string,
    apiURL: string,
    headers: Record<string, string>,
    onStatusUpdate?: (
      status: string,
      attempt: number,
      maxAttempts: number,
    ) => void,
    maxAttempts = 120,
    intervalMs = 3000,
  ): Promise<{
    videoUrl?: string;
    runId: string;
    status: string;
    metadata?: Record<string, unknown>;
  }> {
    const baseUrl = apiURL.replace(/\/+$/, "");
    const statusUrl = `${baseUrl}/query/video_generation?task_id=${encodeURIComponent(runId)}`;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
      const response = await fetch(statusUrl, { headers });
      if (!response.ok) continue;
      const data = (await response.json()) as unknown as Record<
        string,
        unknown
      >;
      const status = String(data.status || "Processing").toLowerCase();
      onStatusUpdate?.(status, attempt + 1, maxAttempts);
      if (status === "success") {
        const fileId = String(data.file_id || "");
        const fileResponse = await fetch(
          `${baseUrl}/files/retrieve?file_id=${encodeURIComponent(fileId)}`,
          { headers },
        );
        if (!fileResponse.ok) {
          throw new Error(
            `MiniMax video file lookup failed: ${fileResponse.status}`,
          );
        }
        const fileData = (await fileResponse.json()) as unknown as Record<
          string,
          unknown
        >;
        const file = fileData.file as Record<string, unknown> | undefined;
        return {
          videoUrl: file?.download_url as string | undefined,
          runId,
          status,
          metadata: data,
        };
      }
      if (status === "fail") {
        const baseResponse = data.base_resp as
          | Record<string, unknown>
          | undefined;
        throw new Error(
          `Video generation failed: ${String(baseResponse?.status_msg || status)}`,
        );
      }
    }
    throw new Error(
      `Video generation timed out after ${(maxAttempts * intervalMs) / 1000}s. runId=${runId}`,
    );
  }

  private async _pollZaiVideoResult(
    runId: string,
    apiURL: string,
    headers: Record<string, string>,
    onStatusUpdate?: (
      status: string,
      attempt: number,
      maxAttempts: number,
    ) => void,
    maxAttempts = 120,
    intervalMs = 3000,
  ): Promise<{
    videoUrl?: string;
    thumbnailUrl?: string;
    runId: string;
    status: string;
    metadata?: Record<string, unknown>;
  }> {
    const statusUrl = `${apiURL.replace(/\/+$/, "")}/async-result/${encodeURIComponent(runId)}`;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
      const response = await fetch(statusUrl, { headers });
      if (!response.ok) continue;
      const data = (await response.json()) as unknown as Record<
        string,
        unknown
      >;
      const status = String(data.task_status || "PROCESSING").toLowerCase();
      onStatusUpdate?.(status, attempt + 1, maxAttempts);
      if (status === "success") {
        const results = Array.isArray(data.video_result)
          ? (data.video_result as Record<string, unknown>[])
          : [];
        return {
          videoUrl: results[0]?.url as string | undefined,
          thumbnailUrl: results[0]?.cover_image_url as string | undefined,
          runId,
          status,
          metadata: data,
        };
      }
      if (status === "fail") {
        throw new Error(
          `Video generation failed: ${String(data.error || status)}`,
        );
      }
    }
    throw new Error(
      `Video generation timed out after ${(maxAttempts * intervalMs) / 1000}s. runId=${runId}`,
    );
  }

  private async _pollTogetherVideoResult(
    runId: string,
    apiURL: string,
    headers: Record<string, string>,
    onStatusUpdate?: (
      status: string,
      attempt: number,
      maxAttempts: number,
    ) => void,
    maxAttempts = 120,
    intervalMs = 3000,
  ): Promise<{
    videoUrl?: string;
    runId: string;
    cost?: number;
    status: string;
    metadata?: Record<string, unknown>;
  }> {
    const statusUrl = `${apiURL.replace(/\/+$/, "")}/videos/${encodeURIComponent(runId)}`;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
      const response = await fetch(statusUrl, { headers });
      if (!response.ok) continue;
      const data = (await response.json()) as unknown as Record<
        string,
        unknown
      >;
      const status = String(data.status || "in_progress").toLowerCase();
      onStatusUpdate?.(status, attempt + 1, maxAttempts);
      if (status === "completed") {
        const outputs = data.outputs as Record<string, unknown> | undefined;
        return {
          videoUrl: outputs?.video_url as string | undefined,
          runId,
          cost: outputs?.cost as number | undefined,
          status,
          metadata: data,
        };
      }
      if (["failed", "cancelled", "canceled"].includes(status)) {
        const error = data.error as Record<string, unknown> | undefined;
        throw new Error(
          `Video generation failed: ${String(error?.message || status)}`,
        );
      }
    }
    throw new Error(
      `Video generation timed out after ${(maxAttempts * intervalMs) / 1000}s. runId=${runId}`,
    );
  }

  private async _pollXaiVideoResult(
    runId: string,
    apiURL: string,
    headers: Record<string, string>,
    onStatusUpdate?: (
      status: string,
      attempt: number,
      maxAttempts: number,
    ) => void,
    maxAttempts = 120,
    intervalMs = 3000,
  ): Promise<{
    videoUrl?: string;
    thumbnailUrl?: string;
    runId: string;
    status: string;
    metadata?: Record<string, unknown>;
  }> {
    const statusUrl = `${apiURL.replace(/\/+$/, "")}/videos/${encodeURIComponent(runId)}`;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
      const response = await fetch(statusUrl, { headers });
      if (!response.ok) continue;
      const data = (await response.json()) as unknown as Record<
        string,
        unknown
      >;
      const status = String(data.status || "pending").toLowerCase();
      onStatusUpdate?.(status, attempt + 1, maxAttempts);
      if (status === "done" || status === "completed") {
        const video = data.video as Record<string, unknown> | undefined;
        return {
          videoUrl: video?.url as string | undefined,
          runId,
          status,
          metadata: data,
        };
      }
      if (["failed", "expired", "canceled", "cancelled"].includes(status)) {
        throw new Error(
          `Video generation failed: ${String(data.error || status)}`,
        );
      }
    }
    throw new Error(
      `Video generation timed out after ${(maxAttempts * intervalMs) / 1000}s. runId=${runId}`,
    );
  }

  private async _pollOpenRouterVideoResult(
    runId: string,
    pollingUrl: string | undefined,
    apiURL: string,
    headers: Record<string, string>,
    onStatusUpdate?: (
      status: string,
      attempt: number,
      maxAttempts: number,
    ) => void,
    maxAttempts = 120,
    intervalMs = 3000,
  ): Promise<{
    videoUrl?: string;
    thumbnailUrl?: string;
    runId: string;
    cost?: number;
    remainingBalance?: number;
    status: string;
    metadata?: Record<string, unknown>;
  }> {
    const baseUrl = apiURL.replace(/\/+$/, "");
    const statusUrl = pollingUrl
      ? new URL(pollingUrl, `${baseUrl}/`).toString()
      : `${baseUrl}/videos/${encodeURIComponent(runId)}`;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
      const response = await fetch(statusUrl, { headers });
      if (!response.ok) {
        Zotero.debug(
          `[seerai] OpenRouter video poll error: ${response.status} (attempt ${attempt + 1}/${maxAttempts})`,
        );
        continue;
      }

      const data = (await response.json()) as unknown as Record<
        string,
        unknown
      >;
      const status = String(data.status || "pending").toLowerCase();
      onStatusUpdate?.(status, attempt + 1, maxAttempts);

      if (status === "completed") {
        const urls = data.unsigned_urls;
        const usage = data.usage as Record<string, unknown> | undefined;
        return {
          videoUrl:
            (Array.isArray(urls) && typeof urls[0] === "string"
              ? urls[0]
              : undefined) ||
            `${baseUrl}/videos/${encodeURIComponent(runId)}/content`,
          runId,
          cost: usage?.cost as number | undefined,
          status,
          metadata: data,
        };
      }
      if (["failed", "error", "canceled", "cancelled"].includes(status)) {
        throw new Error(
          `Video generation failed: ${String(data.error || "unknown error")}`,
        );
      }
    }

    throw new Error(
      `Video generation timed out after ${(maxAttempts * intervalMs) / 1000}s. runId=${runId}`,
    );
  }

  /**
   * Poll video generation status until completed or failed.
   * Uses the dedicated NanoGPT video status endpoint: /api/video/status?requestId=<runId>
   */
  private async _pollVideoResult(
    runId: string,
    model: string,
    apiKey: string,
    apiURL: string,
    onStatusUpdate?: (
      status: string,
      attempt: number,
      maxAttempts: number,
    ) => void,
    maxAttempts = 120, // Video can take minutes
    intervalMs = 3000,
  ): Promise<{
    videoUrl?: string;
    thumbnailUrl?: string;
    runId: string;
    cost?: number;
    remainingBalance?: number;
    status: string;
    metadata?: Record<string, unknown>;
  }> {
    // Determine status polling URL
    let statusBaseUrl: string;
    if (apiURL.includes("nano-gpt.com")) {
      statusBaseUrl = "https://nano-gpt.com/api/video/status";
    } else {
      // Generic: append /status to the generate-video path
      const base = apiURL.endsWith("/") ? apiURL : `${apiURL}/`;
      statusBaseUrl = `${base}api/video/status`;
    }

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));

      const statusUrl = `${statusBaseUrl}?requestId=${encodeURIComponent(runId)}`;

      try {
        const res = await fetch(statusUrl, {
          headers: {
            "x-api-key": apiKey,
            Authorization: `Bearer ${apiKey}`,
          },
        });

        if (!res.ok) {
          Zotero.debug(
            `[seerai] Video poll error: ${res.status} (attempt ${attempt + 1}/${maxAttempts})`,
          );
          continue;
        }

        const body = (await res.json()) as unknown as Record<string, unknown>;

        // Log full response for debugging
        Zotero.debug(
          `[seerai] Video poll attempt ${attempt + 1} raw response: ${JSON.stringify(body)}`,
        );

        // NanoGPT nests the real status inside body.data.status (uppercase)
        // Top-level body.status may also exist (lowercase)
        const nested = body.data as Record<string, unknown> | undefined;
        const nestedStatus = ((nested?.status as string) || "").toUpperCase();
        const topStatus = ((body.status as string) || "").toUpperCase();
        const status = nestedStatus || topStatus;

        Zotero.debug(
          `[seerai] Video poll attempt ${attempt + 1}: nestedStatus=${nestedStatus}, topStatus=${topStatus}, resolved=${status}`,
        );

        // Human-readable status for UI callback
        if (onStatusUpdate) {
          const statusLabels: Record<string, string> = {
            IN_QUEUE: "Queued",
            IN_PROGRESS: "Processing",
            COMPLETED: "Completed",
            FAILED: "Failed",
            CANCELED: "Cancelled",
            QUEUED: "Queued",
            PROCESSING: "Processing",
            PENDING: "Pending",
          };
          const displayStatus = statusLabels[status] || status || "Waiting";
          onStatusUpdate(displayStatus, attempt + 1, maxAttempts);
        }

        if (status === "COMPLETED") {
          // Extract video URL — check nested data.output.video.url first (NanoGPT format)
          let videoUrl: string | undefined;
          let thumbnailUrl: string | undefined;

          // 1. NanoGPT nested: body.data.output.video.url
          if (nested?.output) {
            const output = nested.output as Record<string, unknown>;
            if (output.video) {
              const video = output.video as Record<string, unknown>;
              videoUrl = video.url as string | undefined;
            }
            videoUrl =
              videoUrl ||
              (output.videoUrl as string) ||
              (output.video_url as string) ||
              (output.url as string);
            thumbnailUrl =
              (output.thumbnailUrl as string) ||
              (output.thumbnail_url as string);
          }

          // 2. Top-level videoUrl (also present in NanoGPT unified response)
          if (!videoUrl) {
            videoUrl =
              (body.videoUrl as string) ||
              (body.video_url as string) ||
              (body.url as string);
          }

          // 3. Top-level output (non-nested)
          if (!videoUrl && body.output) {
            const output = body.output as Record<string, unknown>;
            if (output.video) {
              const video = output.video as Record<string, unknown>;
              videoUrl = video.url as string | undefined;
            }
            videoUrl =
              videoUrl ||
              (output.videoUrl as string) ||
              (output.video_url as string) ||
              (output.url as string);
          }

          // 4. Assets array fallback
          if (!videoUrl && Array.isArray(body.assets)) {
            const assets = body.assets as Record<string, unknown>[];
            const videoAsset = assets.find(
              (a) =>
                (a.type as string)?.includes("video") ||
                (a.url as string)?.match(/\.(mp4|webm|mov)/i),
            );
            if (videoAsset) {
              videoUrl = videoAsset.url as string;
            }
            const thumbAsset = assets.find((a) =>
              (a.type as string)?.includes("thumbnail"),
            );
            if (thumbAsset) {
              thumbnailUrl = thumbAsset.url as string;
            }
          }

          if (!thumbnailUrl && body.thumbnailUrl) {
            thumbnailUrl = body.thumbnailUrl as string;
          }

          // Cost may be nested or top-level
          const cost =
            (nested?.cost as number | undefined) ||
            (body.cost as number | undefined);
          const remainingBalance =
            (nested?.remainingBalance as number | undefined) ||
            (body.remainingBalance as number | undefined);

          Zotero.debug(
            `[seerai] Video completed: videoUrl=${videoUrl}, thumbnailUrl=${thumbnailUrl}, cost=${cost}`,
          );

          return {
            videoUrl,
            thumbnailUrl,
            runId,
            cost,
            remainingBalance,
            status: "completed",
            metadata: body as Record<string, unknown>,
          };
        }

        if (
          status === "FAILED" ||
          status === "ERROR" ||
          status === "CANCELED"
        ) {
          // Error may be in nested data or top-level
          const errorMsg =
            (nested?.userFriendlyError as string) ||
            (nested?.error as string) ||
            (body.error as string) ||
            ((body.error as Record<string, unknown>)?.message as string) ||
            "unknown error";
          throw new Error(`Video generation failed: ${errorMsg}`);
        }

        // Otherwise: IN_QUEUE, IN_PROGRESS, pending, processing — keep polling
      } catch (pollErr: unknown) {
        // Re-throw genuine failures (not network hiccups)
        if (
          pollErr instanceof Error &&
          pollErr.message.includes("Video generation failed")
        ) {
          throw pollErr;
        }
        Zotero.debug(
          `[seerai] Video poll network error (attempt ${attempt + 1}): ${pollErr}`,
        );
      }
    }

    throw new Error(
      `Video generation timed out after ${(maxAttempts * intervalMs) / 1000}s. runId=${runId}`,
    );
  }
}

// ── Push-based async queue for follow-up messages ──

class AsyncQueue<T> {
  private queue: T[] = [];
  private waiting: ((value: IteratorResult<T>) => void) | null = null;
  private _done = false;

  push = (item: T): void => {
    if (this._done) return;
    this.queue.push(item);
    if (this.waiting) {
      this.waiting(this.shiftResult());
      this.waiting = null;
    }
  };

  end = (): void => {
    this._done = true;
    if (this.waiting) {
      this.waiting({ value: undefined, done: true } as IteratorResult<T>);
      this.waiting = null;
    }
  };

  private shiftResult(): IteratorResult<T> {
    const value = this.queue.shift()!;
    return { value, done: false };
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<T> {
    const queue = this.queue;
    const getDone = () => this._done;
    const setDone = () => {
      this._done = true;
    };
    const setWaiting = (w: ((value: IteratorResult<T>) => void) | null) => {
      this.waiting = w;
    };

    const inner: AsyncIterableIterator<T> = {
      [Symbol.asyncIterator]() {
        return inner;
      },
      async next(): Promise<IteratorResult<T>> {
        if (queue.length > 0) {
          const value = queue.shift()!;
          return { value, done: false };
        }
        if (getDone()) {
          return { value: undefined, done: true } as IteratorResult<T>;
        }
        return new Promise<IteratorResult<T>>((resolve) => {
          setWaiting(resolve);
        });
      },
      return(): Promise<IteratorResult<T>> {
        setDone();
        return Promise.resolve({
          value: undefined,
          done: true,
        } as IteratorResult<T>);
      },
    };
    return inner;
  }
}

// ── OpenAI Provider ──

export class OpenAIProvider implements AgentProvider {
  isSessionInvalid(_err: unknown): boolean {
    return false;
  }

  query(input: QueryInput): AgentQuery {
    const eventQueue = new AsyncQueue<ProviderEvent>();
    const pendingPush: string[] = [];
    let ended = false;

    const emit = (event: ProviderEvent) => {
      eventQueue.push(event);
    };

    const runStream = async () => {
      try {
        const allMessages = [...input.messages];
        let reasoningContent = "";

        for (const pushed of pendingPush) {
          allMessages.push({
            role: "system",
            content: pushed,
          } as OpenAIMessage);
        }

        await openAIService.chatCompletionStream(
          allMessages,
          {
            onToken: (token) => emit({ type: "token", text: token }),
            onReasoningContent: (content) => {
              reasoningContent += content;
            },
            onToolCalls: (toolCalls) =>
              emit({
                type: "tool_calls",
                toolCalls,
                reasoningContent: reasoningContent || undefined,
              }),
            onComplete: (content) =>
              emit({
                type: "done",
                content,
                reasoningContent: reasoningContent || undefined,
              }),
            onError: (error) =>
              emit({
                type: "error",
                message: error.message || String(error),
                retryable: false,
              }),
          },
          input.configOverride,
          input.tools,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const isAbort = msg.includes("cancelled") || msg.includes("abort");
        if (!isAbort) {
          emit({ type: "error", message: msg, retryable: false });
        }
      } finally {
        eventQueue.end();
      }
    };

    emit({ type: "init", continuation: input.continuation || "" });

    const streamPromise = runStream();

    return {
      push(message: string) {
        if (ended) return;
        pendingPush.push(message);
      },
      end() {
        ended = true;
        eventQueue.end();
      },
      events: eventQueue,
      abort() {
        ended = true;
        openAIService.abortRequest();
        eventQueue.end();
      },
    };
  }
}

export const openAIProvider = new OpenAIProvider();

export function createProvider(_name?: string): AgentProvider {
  return openAIProvider;
}

export const openAIService = new OpenAIService();
