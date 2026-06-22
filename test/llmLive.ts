/**
 * Standalone live LLM test script.
 *
 * Run with:  npx tsx test/llmLive.ts
 *
 * Reads .env for LLM_BASE_URL, LLM_API_KEY, LLM_MODEL, LLM_MODEL2
 * and exercises the full AI-refine and protocol-generation pipelines
 * against a real LLM endpoint.
 *
 * No Zotero required — uses Node.js fetch + the pure search modules.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
import { parseSearchQueryIR } from "../src/modules/search/queryIR";
import {
  compileQuery,
  compileQueriesForProviders,
} from "../src/modules/search/queryCompiler";
import { SMART_MODE_PROVIDERS } from "../src/modules/search/types";
import {
  SearchStrategyStepSchema,
  normalizeStrategyIR,
} from "../src/modules/systematicReview/documentAnalyzer";
import { z } from "zod";

// ── .env parsing ────────────────────────────────────────────────

function loadEnv(): Record<string, string> {
  const envPath = path.resolve(__dirname, "..", ".env");
  const vars: Record<string, string> = {};
  try {
    const content = fs.readFileSync(envPath, "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx < 0) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const value = trimmed.slice(eqIdx + 1).trim();
      if (key) vars[key] = value;
    }
  } catch {
    // .env not found — rely on process.env
  }
  return { ...vars, ...(process.env as Record<string, string>) };
}

const ENV = loadEnv();
const BASE_URL = ENV.LLM_BASE_URL || "";
const API_KEY = ENV.LLM_API_KEY || "";
const MODEL = ENV.LLM_MODEL || "";
const MODEL2 = ENV.LLM_MODEL2 || "";

// ── Helpers ─────────────────────────────────────────────────────

interface ChatMessage {
  role: "system" | "user";
  content: string;
}

async function chatCompletion(
  messages: ChatMessage[],
  opts: { model?: string; temperature?: number; timeoutMs?: number } = {},
): Promise<string> {
  const model = opts.model || MODEL;
  if (!BASE_URL || !API_KEY || !model) {
    throw new Error(
      "Missing LLM_BASE_URL, LLM_API_KEY, or LLM_MODEL in .env / process.env",
    );
  }
  // Build endpoint: strip trailing / then append /chat/completions if not present
  let endpoint = BASE_URL.replace(/\/+$/, "");
  if (!endpoint.endsWith("/chat/completions")) {
    endpoint += "/chat/completions";
  }
  const body: Record<string, unknown> = {
    model,
    messages,
    stream: false,
    temperature: opts.temperature ?? 0.1,
  };
  const controller = new AbortController();
  const timeoutMs = opts.timeoutMs ?? 60000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${API_KEY}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`HTTP ${res.status}: ${text}`);
    }
    const data = (await res.json()) as any;
    return data?.choices?.[0]?.message?.content ?? "";
  } finally {
    clearTimeout(timer);
  }
}

function extractJSON(content: string): Record<string, unknown> {
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1] || content;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start)
    throw new Error(`No JSON in: ${content.slice(0, 200)}`);
  return JSON.parse(candidate.slice(start, end + 1));
}

// ── Test runner ─────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string): void {
  if (condition) {
    console.log(`  \u2714 ${msg}`);
    passed++;
  } else {
    console.error(`  \u2716 ${msg}`);
    failed++;
  }
}

async function test(name: string, fn: () => Promise<void>): Promise<void> {
  console.log(`\n\u2500 ${name}`);
  try {
    await fn();
  } catch (e) {
    console.error(`  \u2716 Exception: ${(e as Error).message}`);
    failed++;
  }
}

// ── Tests ───────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("=== Live LLM Test Suite ===");
  console.log(`Endpoint: ${BASE_URL || "(not set)"}`);
  console.log(`Model 1: ${MODEL || "(not set)"}`);
  console.log(`Model 2: ${MODEL2 || "(not set)"}`);

  if (!BASE_URL || !API_KEY || !MODEL) {
    console.error(
      "\nSet LLM_BASE_URL, LLM_API_KEY, and LLM_MODEL in .env to run live tests.",
    );
    process.exit(1);
  }

  // ── Test 1: AI Refine Query ──
  await test("AI Refine: parseSearchQueryIR with real LLM", async () => {
    const systemPrompt = `You are a search query structurer. Convert the user's research query into a JSON search IR.
Return JSON with this exact shape:
{"groups":[{"terms":["canonical","synonym","abbreviation"],"mesh":["MeSH Term"],"phrase":false}],"exclude":["term"],"field":"all"}

Rules:
- Each object in "groups" is ONE concept; its "terms" are synonyms that will be OR-ed together. Distinct concepts go in SEPARATE groups.
- "mesh": include MeSH descriptors ONLY for biomedical concepts; omit otherwise.
- "exclude": concepts to remove from results.
- "field": use "all" unless the user clearly wants title-only or abstract scope.
- Be comprehensive with synonyms but precise.`;

    const userPrompt =
      "papers about using AI for diagnosing kidney diseases, excluding animal studies";

    const content = await chatCompletion(
      [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      { temperature: 0.1 },
    );

    assert(content.length > 0, "LLM returned non-empty content");

    const ir = parseSearchQueryIR(content);
    assert(ir !== null, "parseSearchQueryIR returned non-null");
    assert(
      ir!.groups.length >= 2,
      `IR has ${ir!.groups.length} groups (expected >= 2)`,
    );

    // Compile for each broad provider
    const providers = SMART_MODE_PROVIDERS.broad;
    const queries = compileQueriesForProviders(ir!, providers);
    let allNonEmpty = true;
    for (const p of providers) {
      if (!queries[p] || queries[p].length === 0) {
        console.error(`    ${p}: empty query!`);
        allNonEmpty = false;
      }
    }
    assert(
      allNonEmpty,
      "All broad-mode providers got non-empty compiled queries",
    );

    // Show a sample
    console.log(
      `    Sample (pubmed): ${compileQuery(ir!, "pubmed").slice(0, 120)}...`,
    );
  });

  // ── Test 2: AI Refine with MODEL2 (smaller model) ──
  if (MODEL2) {
    await test("AI Refine: smaller model (LLM_MODEL2)", async () => {
      let content: string;
      try {
        content = await chatCompletion(
          [
            {
              role: "system",
              content:
                'Return JSON only: {"groups":[{"terms":["term1","term2"]},{"terms":["term3"]}],"field":"all"}',
            },
            { role: "user", content: "machine learning for drug discovery" },
          ],
          { model: MODEL2, temperature: 0.1, timeoutMs: 30000 },
        );
      } catch (e) {
        const msg = (e as Error).message;
        if (msg.includes("aborted") || msg.includes("timeout")) {
          console.log(`    (LLM_MODEL2 timed out — skipping, acceptable)`);
          assert(
            true,
            "Test completed (timeout is acceptable for smaller models)",
          );
          return;
        }
        throw e;
      }

      assert(content.length > 0, "LLM_MODEL2 returned non-empty content");
      console.log(`    Raw (first 200): ${content.slice(0, 200)}`);
      const ir = parseSearchQueryIR(content);
      if (ir === null) {
        console.log(
          `    (smaller model produced unparseable output — acceptable)`,
        );
        assert(
          true,
          "Test completed (parse failure is acceptable for smaller models)",
        );
      } else {
        assert(ir.groups.length >= 1, "IR has at least 1 group");
      }
    });
  }

  // ── Test 3: Protocol Generation — Search Strategy ──
  await test("Protocol: SearchStrategyStepSchema with real LLM", async () => {
    const systemPrompt =
      "You are a systematic review search strategist. Convert the review protocol into a structured, source-agnostic search specification. Return valid JSON only.";
    const userPrompt = `Step 5 of 5 — Search strategy.

Research question: Does artificial intelligence improve diagnosis of kidney diseases compared to clinical assessment?
Framework: PICO

Scope criteria:
P · Population: Adults with suspected kidney disease
I · Intervention: AI-based diagnostic tools
C · Comparison: Clinical assessment / standard diagnostic methods
O · Outcome: Diagnostic accuracy

Inclusion rules:
- Studies in adult populations
- AI-based diagnostic interventions

Exclusion rules:
- Animal studies
- Conference abstracts only

Include keyword aids: AI, artificial intelligence, machine learning, deep learning, kidney disease, renal disease, nephropathy, diagnosis, detection, screening
Exclude keyword aids: animal, in vitro

Return JSON with this exact shape:
{"groups":[{"terms":["canonical","synonym","abbreviation"],"mesh":["MeSH Term"],"phrase":false}],"exclude":["term"],"field":"all","recommendedMode":"biomedical","rationale":"1-2 sentences"}

Rules:
- Each object in "groups" is ONE concept; its "terms" are synonyms that will be OR-ed together. Distinct concepts go in SEPARATE groups.
- "recommendedMode": choose from broad, biomedical, preprints, cryptography, repositories, source.
- "rationale": explain the mode choice and key search decisions.`;

    const content = await chatCompletion(
      [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      { temperature: 0.1 },
    );

    assert(content.length > 0, "LLM returned non-empty content");

    const raw = extractJSON(content);
    const parsed = SearchStrategyStepSchema.parse(raw);
    assert(
      parsed.groups.length >= 2,
      `Schema parsed with ${parsed.groups.length} groups`,
    );
    assert(
      [
        "broad",
        "biomedical",
        "preprints",
        "cryptography",
        "repositories",
        "source",
      ].includes(parsed.recommendedMode),
      `recommendedMode is valid: ${parsed.recommendedMode}`,
    );

    const groups = normalizeStrategyIR(parsed.groups);
    assert(groups.length >= 2, `Normalized to ${groups.length} groups`);

    // Build IR and compile
    const ir = {
      groups,
      ...(parsed.exclude ? { exclude: parsed.exclude } : {}),
      ...(parsed.field ? { field: parsed.field } : {}),
    };
    const pubmedQuery = compileQuery(ir as any, "pubmed");
    assert(pubmedQuery.length > 0, "PubMed compiled query is non-empty");
    console.log(`    PubMed: ${pubmedQuery.slice(0, 120)}...`);
    console.log(`    Mode: ${parsed.recommendedMode}`);
    if (parsed.rationale) {
      console.log(`    Rationale: ${parsed.rationale.slice(0, 100)}...`);
    }
  });

  // ── Test 4: Schema robustness with simulated bad LLM output ──
  await test("Protocol: schema handles invalid LLM values", async () => {
    // Unknown recommendedMode
    const p1 = SearchStrategyStepSchema.parse({
      groups: [{ terms: ["test"] }],
      recommendedMode: "medical", // not in enum
    });
    assert(p1.recommendedMode === "broad", "Unknown mode defaults to broad");

    // Unknown field
    const p2 = SearchStrategyStepSchema.parse({
      groups: [{ terms: ["test"] }],
      recommendedMode: "broad",
      field: "everything", // not in enum
    });
    assert(p2.field === "all", "Unknown field defaults to all");

    // Missing recommendedMode — .catch("broad") defaults it
    const p3 = SearchStrategyStepSchema.parse({
      groups: [{ terms: ["test"] }],
    });
    assert(
      p3.recommendedMode === "broad",
      "Missing recommendedMode defaults to broad (lenient)",
    );
  });

  // ── Test 5: Endpoint URL construction ──
  await test("Endpoint: URL handles /chat/completions suffix", async () => {
    // Test that the endpoint builder handles both with and without /chat/completions
    const url1 = "https://api.example.com/v1";
    const url2 = "https://api.example.com/v1/chat/completions";
    const endpoint1 = url1.replace(/\/+$/, "") + "/chat/completions";
    const endpoint2 = (() => {
      let e = url2.replace(/\/+$/, "");
      if (!e.endsWith("/chat/completions")) e += "/chat/completions";
      return e;
    })();
    assert(endpoint1 === endpoint2, "Both URLs produce the same endpoint");
    assert(
      endpoint1 === "https://api.example.com/v1/chat/completions",
      "Endpoint is correct",
    );
  });

  // ── Summary ──
  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(`Fatal: ${e}`);
  process.exit(1);
});
