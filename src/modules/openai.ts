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
  onComplete?: (fullContent: string) => void;
  onError?: (error: Error) => void;
  /** Called when tool calls are detected in the response */
  onToolCalls?: (toolCalls: ToolCall[]) => void;
}

import { RateLimiter } from "../utils/rateLimiter";
import { getActiveModelConfig } from "./chat/modelConfig";

export class OpenAIService {
  // Active AbortController for current request (may not be available in Zotero)
   
  private currentController: any = null;
  private isAborted: boolean = false;

  private getPrefs() {
    Zotero.debug(`[seerai] Config Prefix: ${config.prefsPrefix}`);
    Zotero.debug(`[seerai] Reading Key: ${config.prefsPrefix}.apiKey`);
    const val = Zotero.Prefs.get(`${config.prefsPrefix}.apiKey`);
    Zotero.debug(`[seerai] API Key Value: ${val}`);

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
  async chatCompletion(messages: OpenAIMessage[]): Promise<string> {
    let { apiURL, apiKey, model } = this.getPrefs();

    // Try to get full config for rate limiting
    const activeConfig = getActiveModelConfig();
    if (activeConfig) {
      // Use active config values if available, otherwise fallback to prefs
      apiURL = activeConfig.apiURL;
      apiKey = activeConfig.apiKey;
      model = activeConfig.model;
    }

    if (!apiKey) {
      throw new Error(
        "OpenAI API Key is missing. Please set it in preferences.",
      );
    }

    // Apply Rate Limiting
    const rateLimiter = RateLimiter.getInstance();
    if (activeConfig) {
      // Estimate tokens: simplistic count
      const estimatedTokens = JSON.stringify(messages).length / 4;
      await rateLimiter.acquire(activeConfig, estimatedTokens);
    }

    const endpoint = apiURL.endsWith("/")
      ? `${apiURL}chat/completions`
      : `${apiURL}/chat/completions`;

    // Create new AbortController for this request (if available)
    this.isAborted = false;
    let signal: AbortSignal | undefined;
    try {
      // AbortController may not be available in Zotero's environment
      if (typeof AbortController !== "undefined") {
        this.currentController = new AbortController();
        signal = this.currentController.signal;
      }
    } catch (e) {
      // Fallback: no abort support
      Zotero.debug("[seerai] AbortController not available, abort disabled");
    }

    try {
      const requestBody = this.prepareRequestBody(model, messages);

      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
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
      return data.choices?.[0]?.message?.content || "";
    } catch (error) {
      if ((error as Error).name === "AbortError") {
        throw new Error("Request was cancelled");
      }
      Zotero.logError(error as Error);
      throw error;
    } finally {
      this.currentController = null;
      if (activeConfig) {
        rateLimiter.release(activeConfig.id);
      }
    }
  }

  /**
   * Streaming chat completion with token-by-token callbacks
   * @param configOverride Optional config to use instead of preferences (for multi-model support)
   * @param tools Optional tool definitions for function calling
   */
  async chatCompletionStream(
    messages: AnyOpenAIMessage[],
    callbacks: StreamCallbacks,
    configOverride?: {
      apiURL?: string;
      apiKey?: string;
      model?: string;
      temperature?: number;
      max_tokens?: number;
    },
    tools?: ToolDefinition[],
  ): Promise<void> {
    const prefs = this.getPrefs();
    const apiURL = configOverride?.apiURL || prefs.apiURL;
    const apiKey = configOverride?.apiKey || prefs.apiKey;
    const model = configOverride?.model || prefs.model;

    // Try to get full config for rate limiting if no override provided or if override matches active
    // Simplification: Always check active model config if no override, or if override matches
    const activeConfig = getActiveModelConfig();
    // If configOverride is provided, we might not have the ID to check rate limits against the correct model buffer.
    // However, usually configOverride is used for specialized calls.
    // Ideally we should pass the full config object instead of partial override.
    // For now, if activeConfig matches the apiKey/model, we use it.
    const effectiveConfig =
      activeConfig &&
      (!configOverride || configOverride.model === activeConfig.model)
        ? activeConfig
        : undefined;

    if (!apiKey) {
      throw new Error(
        "OpenAI API Key is missing. Please set it in preferences.",
      );
    }

    // Apply Rate Limiting
    const rateLimiter = RateLimiter.getInstance();
    if (effectiveConfig) {
      const estimatedTokens = JSON.stringify(messages).length / 4;
      await rateLimiter.acquire(effectiveConfig, estimatedTokens);
    }

    const endpoint = apiURL.endsWith("/")
      ? `${apiURL}chat/completions`
      : `${apiURL}/chat/completions`;

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
      // Build request body using centralized helper
      const requestBody = this.prepareRequestBody(model, messages, {
        stream: true,
        temperature: configOverride?.temperature,
        max_tokens: configOverride?.max_tokens,
        reasoningEffort: effectiveConfig?.reasoningEffort,
      });

      // Add tools if provided (reasoning models from OpenAI currently have limited tool support,
      // but we follow the standard pattern here unless explicitly restricted)
      if (tools && tools.length > 0) {
        requestBody.tools = tools;
        // Allow the model to choose whether to call tools
        requestBody.tool_choice = "auto";
      }

      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
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
      if (effectiveConfig) {
        rateLimiter.release(effectiveConfig.id);
      }
    }
  }

  async testConnection(): Promise<boolean> {
    try {
      await this.chatCompletion([{ role: "user", content: "Hello" }]);
      return true;
    } catch (e) {
      return false;
    }
  }
}

export const openAIService = new OpenAIService();
