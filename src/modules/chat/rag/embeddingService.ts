/**
 * OpenAI-compatible embedding API client.
 * Provider-agnostic — works with any OpenAI-compatible embedding endpoint.
 * Uses the embeddingConfig from the active AIModelConfig.
 */

import { config } from "../../../../package.json";
import { RateLimiter } from "../../../utils/rateLimiter";
import { getActiveModelConfig } from "../modelConfig";
import { MODEL_TYPE_ENDPOINTS } from "../types";
import type {
  EmbeddingRequest,
  EmbeddingResponse,
  EmbeddingModelInfo,
  EmbeddingModelsListResponse,
} from "./types";

export class EmbeddingService {
  private static instance: EmbeddingService | null = null;

  /** Cached model list (per-provider, keyed by apiURL) */
  private modelListCache: Map<
    string,
    { models: EmbeddingModelInfo[]; fetchedAt: number }
  > = new Map();

  /** Cache TTL for model list (5 minutes) */
  private static readonly MODEL_CACHE_TTL = 5 * 60 * 1000;

  /** Max concurrent embedding API requests when batching */
  private static readonly MAX_CONCURRENT_BATCHES = 4;

  private constructor() {}

  static getInstance(): EmbeddingService {
    if (!EmbeddingService.instance) {
      EmbeddingService.instance = new EmbeddingService();
    }
    return EmbeddingService.instance;
  }

  /**
   * Check whether the active model config has embedding configured.
   */
  isConfigured(): boolean {
    const cfg = getActiveModelConfig();
    return !!(cfg?.embeddingConfig?.model && cfg.apiKey);
  }

  /**
   * Get the configured embedding model name, or null if not configured.
   */
  getConfiguredModel(): string | null {
    const cfg = getActiveModelConfig();
    return cfg?.embeddingConfig?.model || null;
  }

  /**
   * Resolve the embedding API endpoint URL from the active config.
   *
   * Priority:
   * 1. embeddingConfig.endpoint (full override URL)
   * 2. apiURL + MODEL_TYPE_ENDPOINTS.embedding.path (/embeddings)
   */
  private resolveEndpoint(): {
    endpoint: string;
    apiKey: string;
    model: string;
  } {
    const cfg = getActiveModelConfig();
    if (!cfg) {
      throw new Error(
        "No active model configuration. Please configure a model in preferences.",
      );
    }
    if (!cfg.embeddingConfig?.model) {
      throw new Error(
        "Embedding model not configured. Add an embedding model in your API configuration.",
      );
    }
    if (!cfg.apiKey) {
      throw new Error("API key is missing. Please set it in preferences.");
    }

    let endpoint: string;
    if (cfg.embeddingConfig.endpoint) {
      endpoint = cfg.embeddingConfig.endpoint;
    } else {
      const base = cfg.apiURL.endsWith("/")
        ? cfg.apiURL.slice(0, -1)
        : cfg.apiURL;
      endpoint = `${base}${MODEL_TYPE_ENDPOINTS.embedding.path}`;
    }

    return {
      endpoint,
      apiKey: cfg.apiKey,
      model: cfg.embeddingConfig.model,
    };
  }

  /**
   * Build request headers.
   * Always includes:
   *  - Content-Type
   *  - Authorization: Bearer (OpenAI standard)
   *  - x-api-key (NanoGPT / alternative providers)
   *  - x-seer-ai: 1 (SeerAI marker — required on all embedding requests)
   */
  private buildHeaders(apiKey: string): Record<string, string> {
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      "x-api-key": apiKey,
      "x-seer-ai": "1",
    };
  }

  /**
   * Create embedding(s) for one or more texts.
   *
   * @param input  Single text string or array of strings (max 2048)
   * @param options  Optional: encoding_format, dimensions, user
   * @returns The full EmbeddingResponse
   */
  async createEmbeddings(
    input: string | string[],
    options?: {
      encoding_format?: "float" | "base64";
      dimensions?: number;
      user?: string;
    },
  ): Promise<EmbeddingResponse> {
    const { endpoint, apiKey, model } = this.resolveEndpoint();

    // Use explicitly passed dimensions, or fall back to the configured value
    const cfg = getActiveModelConfig();
    const effectiveDimensions =
      options?.dimensions || cfg?.embeddingConfig?.dimensions || undefined;

    const body: EmbeddingRequest = {
      input,
      model,
      ...(options?.encoding_format && {
        encoding_format: options.encoding_format,
      }),
      ...(effectiveDimensions && { dimensions: effectiveDimensions }),
      ...(options?.user && { user: options.user }),
    };

    // Rate limiting
    const rateLimiter = RateLimiter.getInstance();
    if (cfg) {
      const textLength = Array.isArray(input)
        ? input.reduce((sum, t) => sum + t.length, 0)
        : input.length;
      const estimatedTokens = Math.ceil(textLength / 4);
      await rateLimiter.acquire(cfg, estimatedTokens);
    }

    Zotero.debug(
      `[seerai] Embedding request: model=${model}, endpoint=${endpoint}, ` +
        `inputs=${Array.isArray(input) ? input.length : 1}`,
    );

    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: this.buildHeaders(apiKey),
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const errorText = await response.text();
        let errorMessage: string;
        try {
          const errorJson = JSON.parse(errorText);
          errorMessage =
            errorJson.error?.message || `HTTP ${response.status}: ${errorText}`;
        } catch {
          errorMessage = `HTTP ${response.status}: ${errorText}`;
        }
        throw new Error(`Embedding API error: ${errorMessage}`);
      }

      const data = (await response.json()) as unknown as EmbeddingResponse;

      Zotero.debug(
        `[seerai] Embedding response: model=${data.model}, ` +
          `embeddings=${data.data.length}, ` +
          `dimensions=${data.data[0]?.embedding?.length || 0}, ` +
          `tokens=${data.usage?.total_tokens || "N/A"}`,
      );

      return data;
    } catch (error) {
      if ((error as Error).message.startsWith("Embedding API error:")) {
        throw error;
      }
      Zotero.debug(`[seerai] Embedding request failed: ${error}`);
      throw new Error(`Embedding request failed: ${(error as Error).message}`);
    } finally {
      if (cfg) {
        rateLimiter.release(cfg.id);
      }
    }
  }

  /**
   * Convenience: get a single embedding vector for one text.
   */
  async getEmbedding(text: string): Promise<number[]> {
    const response = await this.createEmbeddings(text);
    if (!response.data?.[0]?.embedding) {
      throw new Error("No embedding returned in response");
    }
    return response.data[0].embedding;
  }

  /**
   * Convenience: get embedding vectors for multiple texts.
   * Batches by both item count (max 2048) and estimated token count
   * (respects the configured maxTokens for the embedding model).
   *
   * Batches are sent in parallel (up to MAX_CONCURRENT_BATCHES at a time)
   * to reduce total latency.
   */
  async getEmbeddings(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    const MAX_ITEMS_PER_BATCH = 2048;
    // Use the user-configured max tokens for the embedding model.
    // Fall back to a conservative 8000 if not set.
    const cfg = getActiveModelConfig();
    const configuredMaxTokens = cfg?.embeddingConfig?.maxTokens;
    const MAX_TOKENS_PER_BATCH = configuredMaxTokens || 8000;

    // ── Build all batches first ─────────────────────────────────────────────
    const batches: { startIdx: number; texts: string[] }[] = [];
    let batchStart = 0;

    while (batchStart < texts.length) {
      let batchEnd = batchStart;
      let batchTokens = 0;

      while (batchEnd < texts.length) {
        const itemTokens = Math.ceil(texts[batchEnd].length / 4);
        if (
          batchEnd > batchStart &&
          (batchTokens + itemTokens > MAX_TOKENS_PER_BATCH ||
            batchEnd - batchStart >= MAX_ITEMS_PER_BATCH)
        ) {
          break;
        }
        batchTokens += itemTokens;
        batchEnd++;
      }

      // Safety: always include at least one item per batch even if it exceeds the limit
      if (batchEnd === batchStart) batchEnd = batchStart + 1;

      batches.push({
        startIdx: batchStart,
        texts: texts.slice(batchStart, batchEnd),
      });
      batchStart = batchEnd;
    }

    Zotero.debug(
      `[seerai] Embedding ${texts.length} texts in ${batches.length} batches ` +
        `(concurrency: ${EmbeddingService.MAX_CONCURRENT_BATCHES})`,
    );

    // ── Fire batches in parallel with concurrency limit ─────────────────────
    const results: { startIdx: number; embeddings: number[][] }[] = [];

    // Process batches in waves of MAX_CONCURRENT_BATCHES
    for (
      let i = 0;
      i < batches.length;
      i += EmbeddingService.MAX_CONCURRENT_BATCHES
    ) {
      const wave = batches.slice(
        i,
        i + EmbeddingService.MAX_CONCURRENT_BATCHES,
      );
      const waveResults = await Promise.all(
        wave.map(async (batch) => {
          const response = await this.createEmbeddings(batch.texts);
          // Sort by index to ensure correct ordering within batch
          const sorted = [...response.data].sort((a, b) => a.index - b.index);
          return {
            startIdx: batch.startIdx,
            embeddings: sorted.map((item) => item.embedding),
          };
        }),
      );
      results.push(...waveResults);
    }

    // ── Reassemble in original order ────────────────────────────────────────
    results.sort((a, b) => a.startIdx - b.startIdx);
    const allEmbeddings: number[][] = [];
    for (const result of results) {
      allEmbeddings.push(...result.embeddings);
    }

    return allEmbeddings;
  }

  /**
   * Fetch available embedding models from the provider.
   * Currently only NanoGPT exposes a model list endpoint.
   * For other providers, returns an empty array (user configures model manually).
   */
  async fetchEmbeddingModels(): Promise<EmbeddingModelInfo[]> {
    const cfg = getActiveModelConfig();
    if (!cfg) return [];

    // Only NanoGPT has a dedicated embedding models endpoint
    const isNanoGPT = cfg.apiURL.includes("nano-gpt.com");
    if (!isNanoGPT) return [];

    // Check cache
    const cacheKey = cfg.apiURL;
    const cached = this.modelListCache.get(cacheKey);
    if (
      cached &&
      Date.now() - cached.fetchedAt < EmbeddingService.MODEL_CACHE_TTL
    ) {
      return cached.models;
    }

    try {
      const modelsUrl = "https://nano-gpt.com/api/v1/embedding-models";

      Zotero.debug(`[seerai] Fetching embedding models from ${modelsUrl}`);

      const response = await fetch(modelsUrl, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${cfg.apiKey}`,
          "x-api-key": cfg.apiKey,
          "x-seer-ai": "1",
        },
      });

      if (!response.ok) {
        Zotero.debug(
          `[seerai] Failed to fetch embedding models: ${response.status}`,
        );
        return [];
      }

      const data =
        (await response.json()) as unknown as EmbeddingModelsListResponse;
      const models = data.data || [];

      // Update cache
      this.modelListCache.set(cacheKey, {
        models,
        fetchedAt: Date.now(),
      });

      Zotero.debug(
        `[seerai] Fetched ${models.length} embedding models from ${modelsUrl}`,
      );
      return models;
    } catch (error) {
      Zotero.debug(`[seerai] Error fetching embedding models: ${error}`);
      return [];
    }
  }

  /**
   * Clear the model list cache (e.g., when provider config changes).
   */
  clearModelCache(): void {
    this.modelListCache.clear();
  }
}

/** Singleton accessor */
export function getEmbeddingService(): EmbeddingService {
  return EmbeddingService.getInstance();
}
