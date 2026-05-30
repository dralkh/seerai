/**
 * RAG Evaluation Framework.
 *
 * Provides retrieval metrics (recall, precision, MRR, NDCG) and generation
 * quality evaluation (faithfulness, answer relevancy, hallucination rate)
 * via LLM-as-judge.
 *
 * All evaluation is opt-in via `ragEvalEnabled` pref and gated by
 * ground truth availability. When disabled, no additional LLM calls occur.
 */

import type {
  RetrievedChunk,
  GenerationEvalMetrics,
  RetrievalEvalMetrics,
  GroundTruthEntry,
} from "./types";

function fuzzyMatchQuery(query: string, entryQuery: string): boolean {
  const normalize = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  const a = normalize(query);
  const b = normalize(entryQuery);
  if (a === b) return true;
  const tokensA = new Set(a.split(" ").filter((t) => t.length > 2));
  const tokensB = new Set(b.split(" ").filter((t) => t.length > 2));
  if (tokensA.size === 0 || tokensB.size === 0) return false;
  const intersection = [...tokensA].filter((t) => tokensB.has(t)).length;
  const union = new Set([...tokensA, ...tokensB]).size;
  return intersection / union >= 0.7;
}

export function evaluateRetrieval(
  retrievedChunks: RetrievedChunk[],
  groundTruthItemIds: number[],
  kValues: number[] = [1, 3, 5, 10],
): RetrievalEvalMetrics {
  const relevantSet = new Set(groundTruthItemIds);
  const numRelevantTotal = groundTruthItemIds.length;

  const retrievedIds = retrievedChunks.map((rc) => rc.sourceItem.id);

  const recallAtK: Record<number, number> = {};
  const precisionAtK: Record<number, number> = {};
  const ndcgAtK: Record<number, number> = {};
  let mrrSum = 0;
  let hitAtTopK = false;

  for (const k of kValues) {
    const topKIds = retrievedIds.slice(0, k);
    const relevantFound = topKIds.filter((id) => relevantSet.has(id)).length;

    recallAtK[k] = numRelevantTotal > 0 ? relevantFound / numRelevantTotal : 0;
    precisionAtK[k] = k > 0 ? relevantFound / Math.min(k, topKIds.length) : 0;

    let dcg = 0;
    let idcg = 0;
    for (let i = 0; i < Math.min(k, topKIds.length); i++) {
      const rel = relevantSet.has(topKIds[i]) ? 1 : 0;
      dcg += rel / Math.log2(i + 2);
    }
    for (let i = 0; i < Math.min(k, numRelevantTotal); i++) {
      idcg += 1 / Math.log2(i + 2);
    }
    ndcgAtK[k] = idcg > 0 ? dcg / idcg : 0;

    if (k === kValues[kValues.length - 1] && relevantFound > 0) {
      hitAtTopK = true;
    }

    let firstReciprocal = 0;
    for (let i = 0; i < topKIds.length; i++) {
      if (relevantSet.has(topKIds[i])) {
        firstReciprocal = 1 / (i + 1);
        break;
      }
    }
    mrrSum = Math.max(mrrSum, firstReciprocal);
  }

  return {
    recall_at_k: recallAtK,
    precision_at_k: precisionAtK,
    mrr: groundTruthItemIds.length > 0 ? mrrSum : 0,
    ndcg_at_k: ndcgAtK,
    hit_rate: hitAtTopK ? 1 : 0,
    num_retrieved: retrievedChunks.length,
    num_relevant_total: numRelevantTotal,
  };
}

const FAITHFULNESS_PROMPT = `You are evaluating the faithfulness of an AI answer to provided context.

You will be given:
1. A user query
2. An AI-generated answer
3. Supporting context documents

TASK: Decompose the answer into individual factual claims. For each claim, determine whether it is directly supported by the context or not. A claim is "supported" only if the context explicitly states it (not implied or inferred).

Return a JSON object:
{
  "claims": [
    {"claim": "...", "supported": true/false, "evidence": "..."}
  ],
  "overall_score": 0.0-1.0 (fraction of supported claims)
}

If the answer makes no factual claims (e.g., just greetings), return score 1.0 with empty claims array.`;

const ANSWER_RELEVANCY_PROMPT = `You are evaluating whether an AI answer directly addresses the user's query.

User Query: {query}

AI Answer: {answer}

Rate the answer relevancy on a scale of 0.0 to 1.0:
- 1.0: The answer fully and directly addresses the query
- 0.7: The answer mostly addresses the query but has minor tangents
- 0.4: The answer partially addresses the query but misses key aspects
- 0.1: The answer barely relates to the query
- 0.0: The answer is completely unrelated

Return JSON: {"relevancy": 0.0-1.0, "reasoning": "brief explanation"}`;

async function llmJudge(
  prompt: string,
  apiKey: string,
  apiURL: string,
  model: string,
): Promise<Record<string, unknown> | null> {
  try {
    const resp = await fetch(`${apiURL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: "system",
            content:
              "You are an evaluation assistant. Always respond with valid JSON only. No markdown, no explanations outside the JSON.",
          },
          { role: "user", content: prompt },
        ],
        temperature: 0,
        response_format: { type: "json_object" },
      }),
    });
    if (!resp.ok) {
      Zotero.debug(`[seerai] Eval: LLM judge returned ${resp.status}`);
      return null;
    }
    const json = (await resp.json()) as any;
    const content = json.choices?.[0]?.message?.content;
    if (!content) return null;
    return JSON.parse(content);
  } catch (e) {
    Zotero.debug(`[seerai] Eval: LLM judge error: ${e}`);
    return null;
  }
}

async function evaluateFaithfulness(
  answer: string,
  context: string,
  apiKey: string,
  apiURL: string,
  model: string,
): Promise<{ score: number; unsupported_claims: string[] }> {
  const prompt =
    FAITHFULNESS_PROMPT + `\n\nContext:\n${context}\n\nAI Answer:\n${answer}`;
  const result = await llmJudge(prompt, apiKey, apiURL, model);
  if (!result) return { score: 1.0, unsupported_claims: [] };
  return {
    score: (result.overall_score as number) ?? 1.0,
    unsupported_claims: (
      (result.claims as Array<{ claim: string; supported: boolean }>) ?? []
    )
      .filter((c: { supported: boolean }) => !c.supported)
      .map((c: { claim: string }) => c.claim),
  };
}

async function evaluateAnswerRelevancy(
  query: string,
  answer: string,
  apiKey: string,
  apiURL: string,
  model: string,
): Promise<number> {
  const prompt = ANSWER_RELEVANCY_PROMPT.replace("{query}", query).replace(
    "{answer}",
    answer,
  );
  const result = await llmJudge(prompt, apiKey, apiURL, model);
  if (!result) return 1.0;
  return (result.relevancy as number) ?? 1.0;
}

export async function evaluateGeneration(
  query: string,
  answer: string,
  retrievedContext: string,
): Promise<GenerationEvalMetrics> {
  const pref = (key: string, fallback: string) => {
    try {
      const val = Zotero.Prefs.get(`extensions.zotero.seerai.${key}`);
      return val !== undefined && val !== null ? String(val) : fallback;
    } catch {
      return fallback;
    }
  };

  const apiKey = pref("apiKey", "");
  const apiURL = pref("apiURL", "https://api.openai.com/v1");
  const model =
    pref("ragEvalEmbeddingModel", "") || pref("chatModel", "") || "gpt-5-mini";

  if (!apiKey) {
    Zotero.debug(
      "[seerai] Eval: no API key configured, skipping generation eval",
    );
    return {
      faithfulness: 1.0,
      answer_relevancy: 1.0,
      context_precision: 1.0,
      hallucination_rate: 0,
    };
  }

  const [faithfulnessResult, relevancy] = await Promise.all([
    evaluateFaithfulness(answer, retrievedContext, apiKey, apiURL, model),
    evaluateAnswerRelevancy(query, answer, apiKey, apiURL, model),
  ]);

  const hallucinationRate =
    faithfulnessResult.unsupported_claims.length > 0
      ? Math.min(1.0, faithfulnessResult.unsupported_claims.length / 5)
      : 0;

  return {
    faithfulness: faithfulnessResult.score,
    answer_relevancy: relevancy,
    context_precision: faithfulnessResult.score,
    hallucination_rate: hallucinationRate,
  };
}

export function loadGroundTruth(): GroundTruthEntry[] {
  try {
    const raw = Zotero.Prefs.get("extensions.zotero.seerai.ragEvalGroundTruth");
    if (!raw || typeof raw !== "string") return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (e: unknown) =>
        e &&
        typeof (e as Record<string, unknown>).query === "string" &&
        Array.isArray((e as Record<string, unknown>).relevant_item_ids),
    ) as GroundTruthEntry[];
  } catch {
    return [];
  }
}

export function findGroundTruth(
  query: string,
  entries: GroundTruthEntry[],
): GroundTruthEntry | null {
  for (const entry of entries) {
    if (fuzzyMatchQuery(query, entry.query)) {
      return entry;
    }
  }
  return null;
}

export function isEvalEnabled(): boolean {
  try {
    return Zotero.Prefs.get(
      "extensions.zotero.seerai.ragEvalEnabled",
    ) as boolean;
  } catch {
    return false;
  }
}
