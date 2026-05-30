/**
 * Cross-Encoder Reranker for the RAG pipeline.
 *
 * Provides API-based cross-encoder reranking via Jina Reranker v3 (primary)
 * and Cohere Rerank 4 (fallback). Falls back to the local source-priority
 * reranker when no API key is configured.
 *
 * Integration point: called from retrievalEngine.ts after hybrid fusion,
 * before context assembly.
 */

import { config } from "../../../../package.json";
import type { RetrievedChunk } from "./types";

const MIN_REQUEST_GAP_MS = 200;

let _lastRequestTime = 0;
let _activeRequests = 0;
const MAX_CONCURRENT_RERANK = 2;

async function acquireRateLimitSlot(): Promise<void> {
  while (_activeRequests >= MAX_CONCURRENT_RERANK) {
    await new Promise((r) => setTimeout(r, 50));
  }

  const now = Date.now();
  const gap = now - _lastRequestTime;
  if (gap < MIN_REQUEST_GAP_MS) {
    await new Promise((r) => setTimeout(r, MIN_REQUEST_GAP_MS - gap));
  }

  _lastRequestTime = Date.now();
  _activeRequests++;
}

function releaseRateLimitSlot(): void {
  _activeRequests = Math.max(0, _activeRequests - 1);
}

interface RerankerConfig {
  provider: "none" | "jina" | "cohere";
  apiKey: string;
  model?: string;
  topN: number;
}

interface RerankerResult {
  index: number;
  relevance_score: number;
}

interface JinaRerankResponse {
  results: RerankerResult[];
  usage?: { total_tokens: number; prompt_tokens: number };
}

interface CohereRerankResponse {
  results: RerankerResult[];
  meta?: { api_version?: { version: string } };
}

/**
 * Load reranker configuration from Zotero preferences.
 */
export function getRerankerConfig(): RerankerConfig {
  const pref = (key: string, fallback: any) => {
    try {
      const val = Zotero.Prefs.get(`${config.prefsPrefix}.${key}`);
      return val !== undefined && val !== null ? val : fallback;
    } catch {
      return fallback;
    }
  };

  return {
    provider: pref("ragRerankerProvider", "none") as string as
      | "none"
      | "jina"
      | "cohere",
    apiKey: pref("ragRerankerApiKey", "") as string,
    model: pref("ragRerankerModel", "") as string,
    topN: pref("ragRerankerTopN", 10) as number,
  };
}

/**
 * Check whether a cross-encoder reranker is configured and available.
 */
export function isRerankerConfigured(): boolean {
  const cfg = getRerankerConfig();
  return cfg.provider !== "none" && cfg.apiKey.length > 0;
}

/**
 * Rerank retrieved chunks using the configured cross-encoder API.
 * Falls back to local reranking if no API key is configured.
 *
 * Returns results in the same order (best first).
 */
export async function crossEncodeRerank(
  query: string,
  chunks: RetrievedChunk[],
  topN?: number,
): Promise<RetrievedChunk[]> {
  if (chunks.length <= 1) return chunks;

  const cfg = getRerankerConfig();
  const effectiveTopN = topN ?? cfg.topN;

  if (cfg.provider === "none" || !cfg.apiKey) {
    Zotero.debug(
      "[seerai] Reranker: no provider configured, using local scoring",
    );
    return chunks;
  }

  const texts = chunks.map((c) => c.chunk.text.substring(0, 2000));

  try {
    let scores: Map<string, number>;

    if (cfg.provider === "jina") {
      scores = await jinaRerank(cfg, query, texts, effectiveTopN, chunks);
    } else if (cfg.provider === "cohere") {
      scores = await cohereRerank(cfg, query, texts, effectiveTopN, chunks);
    } else {
      return chunks;
    }

    if (scores.size === 0) {
      Zotero.debug(
        "[seerai] Reranker: API returned no scores, keeping original order",
      );
      return chunks;
    }

    const reranked = chunks.map((c) => ({
      ...c,
      score: scores.get(c.chunk.id) ?? c.score,
    }));

    reranked.sort((a, b) => b.score - a.score);

    Zotero.debug(
      `[seerai] Reranker (${cfg.provider}): reranked ${chunks.length} chunks ` +
        `→ top score ${reranked[0]?.score?.toFixed(3) ?? "N/A"}`,
    );

    return reranked;
  } catch (e) {
    Zotero.debug(`[seerai] Reranker (${cfg.provider}): API call failed: ${e}`);
    return chunks;
  }
}

async function jinaRerank(
  cfg: RerankerConfig,
  query: string,
  texts: string[],
  topN: number,
  chunks: RetrievedChunk[],
): Promise<Map<string, number>> {
  const model = cfg.model || "jina-reranker-v3";
  const url = "https://api.jina.ai/v1/rerank";

  Zotero.debug(
    `[seerai] Reranker (jina): sending ${texts.length} documents to ${model}`,
  );

  await acquireRateLimitSlot();
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cfg.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        query,
        documents: texts,
        top_n: topN,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Jina API error ${response.status}: ${errorText}`);
    }

    const result = (await response.json()) as unknown as JinaRerankResponse;
    Zotero.debug(
      `[seerai] Reranker (jina): ${result.results.length} results, ` +
        `${result.usage?.total_tokens ?? "?"} tokens`,
    );

    return mapResultsToScores(chunks, result.results);
  } finally {
    releaseRateLimitSlot();
  }
}

async function cohereRerank(
  cfg: RerankerConfig,
  query: string,
  texts: string[],
  topN: number,
  chunks: RetrievedChunk[],
): Promise<Map<string, number>> {
  const model = cfg.model || "rerank-v4";
  const url = "https://api.cohere.ai/v2/rerank";

  Zotero.debug(
    `[seerai] Reranker (cohere): sending ${texts.length} documents to ${model}`,
  );

  await acquireRateLimitSlot();
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cfg.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        query,
        documents: texts,
        top_n: topN,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Cohere API error ${response.status}: ${errorText}`);
    }

    const result = (await response.json()) as unknown as CohereRerankResponse;
    Zotero.debug(
      `[seerai] Reranker (cohere): ${result.results.length} results`,
    );

    return mapResultsToScores(chunks, result.results);
  } finally {
    releaseRateLimitSlot();
  }
}

function mapResultsToScores(
  chunks: RetrievedChunk[],
  apiResults: RerankerResult[],
): Map<string, number> {
  const scores = new Map<string, number>();
  for (const r of apiResults) {
    if (r.index >= 0 && r.index < chunks.length) {
      scores.set(chunks[r.index].chunk.id, r.relevance_score);
    }
  }
  return scores;
}
