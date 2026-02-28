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
import { MODEL_TYPE_ENDPOINTS } from "./chat/types";

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
          "x-seer-ai": "1",
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
          "x-seer-ai": "1",
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
    const activeConfig = getActiveModelConfig();
    if (!activeConfig?.ttsConfig) {
      throw new Error(
        "TTS not configured. Add a TTS model in your model configuration.",
      );
    }

    const ttsModel = activeConfig.ttsConfig.model;
    const apiKey = activeConfig.apiKey;

    // Resolve TTS endpoint:
    // 1. Use explicit ttsConfig.endpoint if set
    // 2. For NanoGPT, use /api/tts (not the standard /audio/speech path)
    // 3. Otherwise fall back to apiURL + default path (/audio/speech)
    let endpoint: string;
    if (activeConfig.ttsConfig.endpoint) {
      endpoint = activeConfig.ttsConfig.endpoint;
    } else if (activeConfig.apiURL.includes("nano-gpt.com")) {
      endpoint = "https://nano-gpt.com/api/tts";
    } else {
      const base = activeConfig.apiURL.endsWith("/")
        ? activeConfig.apiURL
        : `${activeConfig.apiURL}/`;
      endpoint = `${base}${MODEL_TYPE_ENDPOINTS.tts.path.replace(/^\//, "")}`;
    }

    // Voice: use options override, then configured voice, then omit (API default)
    const voice = options?.voice || activeConfig.ttsConfig.voice;

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
        Authorization: `Bearer ${apiKey}`,
        "x-api-key": apiKey,
        "x-seer-ai": "1",
      },
      // Send both "input" (OpenAI standard) and "text" (NanoGPT) fields.
      // Each provider uses the field it recognizes.
      body: JSON.stringify({
        model: ttsModel,
        input: text,
        text: text,
        ...(voice && { voice }),
      }),
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
      if (!json.audioUrl) {
        throw new Error("TTS response missing audioUrl");
      }
      // Fetch the actual audio binary from the returned URL
      const audioResponse = await fetch(json.audioUrl as string, {
        headers: { "x-seer-ai": "1" },
      });
      if (!audioResponse.ok) {
        throw new Error(
          `Failed to fetch TTS audio from ${json.audioUrl}: ${audioResponse.status}`,
        );
      }
      return audioResponse.arrayBuffer();
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
          "x-seer-ai": "1",
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
        const audioRes = await fetch(data.audioUrl as string, {
          headers: { "x-seer-ai": "1" },
        });
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
    const activeConfig = getActiveModelConfig();
    if (!activeConfig?.sttConfig) {
      throw new Error(
        "STT not configured. Add a Speech-to-Text model in your model configuration.",
      );
    }

    const sttModel = activeConfig.sttConfig.model;
    const apiKey = activeConfig.apiKey;

    // Resolve STT endpoint:
    // 1. Use explicit sttConfig.endpoint if set
    // 2. For NanoGPT, use OpenAI-compatible /api/v1/audio/transcriptions
    // 3. Otherwise fall back to apiURL + default path (/audio/transcriptions)
    let endpoint: string;
    let isNanoGpt = false;
    if (activeConfig.sttConfig.endpoint) {
      endpoint = activeConfig.sttConfig.endpoint;
    } else if (activeConfig.apiURL.includes("nano-gpt.com")) {
      // Use the OpenAI-compatible endpoint (field name="file", same as OpenAI)
      endpoint = "https://nano-gpt.com/api/v1/audio/transcriptions";
      isNanoGpt = true;
    } else {
      const base = activeConfig.apiURL.endsWith("/")
        ? activeConfig.apiURL
        : `${activeConfig.apiURL}/`;
      endpoint = `${base}${MODEL_TYPE_ENDPOINTS.stt.path.replace(/^\//, "")}`;
    }

    Zotero.debug(
      `[seerai] STT request: model=${sttModel}, endpoint=${endpoint}, type=${typeof audio === "string" ? "url" : "file"}`,
    );

    let response: Response;

    if (typeof audio === "string") {
      // URL-based upload — JSON body
      response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
          "x-api-key": apiKey,
          "x-seer-ai": "1",
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
      let preFile = `--${boundary}\r\n`;
      preFile += `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n`;
      preFile += `Content-Type: ${fileMime}\r\n\r\n`;

      let postFile = `\r\n--${boundary}\r\n`;
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
            Authorization: `Bearer ${apiKey}`,
            "x-api-key": apiKey,
            "x-seer-ai": "1",
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
          "x-seer-ai": "1",
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
    const activeConfig = getActiveModelConfig();
    if (!activeConfig?.imageConfig) {
      throw new Error(
        "Image generation not configured. Add an Image model in your model configuration.",
      );
    }

    const imageModel = options?.model || activeConfig.imageConfig.model;
    const apiKey = activeConfig.apiKey;

    // Resolve endpoint:
    // 1. Explicit imageConfig.endpoint if set
    // 2. NanoGPT → /v1/images/generations
    // 3. apiURL + default path
    let endpoint: string;
    if (activeConfig.imageConfig.endpoint) {
      endpoint = activeConfig.imageConfig.endpoint;
    } else if (activeConfig.apiURL.includes("nano-gpt.com")) {
      endpoint = "https://nano-gpt.com/v1/images/generations";
    } else {
      const base = activeConfig.apiURL.endsWith("/")
        ? activeConfig.apiURL
        : `${activeConfig.apiURL}/`;
      endpoint = `${base}${MODEL_TYPE_ENDPOINTS.image.path.replace(/^\//, "")}`;
    }

    // Build request body
    const body: Record<string, unknown> = {
      model: imageModel,
      prompt,
      n: options?.n ?? 1,
      size: options?.size ?? "1024x1024",
      response_format: options?.response_format ?? "url",
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
        Authorization: `Bearer ${apiKey}`,
        "x-api-key": apiKey,
        "x-seer-ai": "1",
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
    const activeConfig = getActiveModelConfig();
    if (!activeConfig?.videoConfig) {
      throw new Error(
        "Video generation not configured. Add a Video model in your model configuration.",
      );
    }

    const videoModel = options?.model || activeConfig.videoConfig.model;
    const apiKey = activeConfig.apiKey;

    // Resolve endpoint:
    // 1. Explicit videoConfig.endpoint if set
    // 2. NanoGPT → /api/generate-video
    // 3. apiURL + default path
    let endpoint: string;
    if (activeConfig.videoConfig.endpoint) {
      endpoint = activeConfig.videoConfig.endpoint;
    } else if (activeConfig.apiURL.includes("nano-gpt.com")) {
      endpoint = "https://nano-gpt.com/api/generate-video";
    } else {
      const base = activeConfig.apiURL.endsWith("/")
        ? activeConfig.apiURL
        : `${activeConfig.apiURL}/`;
      endpoint = `${base}${MODEL_TYPE_ENDPOINTS.video.path.replace(/^\//, "")}`;
    }

    // Build request body
    const body: Record<string, unknown> = {
      model: videoModel,
      prompt,
    };
    if (options?.duration) body.duration = options.duration;
    if (options?.aspect_ratio) body.aspect_ratio = options.aspect_ratio;
    if (options?.resolution) body.resolution = options.resolution;
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
        Authorization: `Bearer ${apiKey}`,
        "x-api-key": apiKey,
        "x-seer-ai": "1",
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
    const runId = (data.runId as string) || (data.id as string);

    if (!runId) {
      throw new Error("Video generation response missing runId for polling.");
    }

    Zotero.debug(
      `[seerai] Video generation submitted: runId=${runId}, status=${data.status}, cost=${data.cost}`,
    );

    // Poll for completion
    return this._pollVideoResult(
      runId,
      videoModel,
      apiKey,
      activeConfig.apiURL,
      onStatusUpdate,
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
            "x-seer-ai": "1",
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

export const openAIService = new OpenAIService();
