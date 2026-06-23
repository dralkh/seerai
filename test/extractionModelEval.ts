/**
 * Live extraction capability harness.
 *
 * Run with:  npx tsx test/extractionModelEval.ts   (or: npm run test:extraction-eval)
 *
 * Reads .env for LLM_BASE_URL, LLM_API_KEY, LLM_MODEL (small / model1) and
 * LLM_MODEL2 (larger / model2), runs the REAL extraction prompt over the
 * fixtures in test/fixtures/extraction/*.json, feeds the output through the
 * production validation pipeline (buildExtractionRows), and prints a scorecard
 * comparing whether each model clears the quality bar.
 *
 * No Zotero required — uses Node fetch + the pure extraction modules.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildExtractionMessages,
  buildExtractionRows,
  ExtractionProposalSchema,
} from "../src/modules/systematicReview/extractionWorkflow";
import {
  classifyMeasure,
  MeasureFamily,
} from "../src/modules/systematicReview/measures";
import { ExtractionTemplate } from "../src/modules/systematicReview/types";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ── .env parsing ────────────────────────────────────────────────
function loadEnv(): Record<string, string> {
  const envPath = path.resolve(__dirname, "..", ".env");
  const vars: Record<string, string> = {};
  try {
    for (const line of fs.readFileSync(envPath, "utf-8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq < 0) continue;
      vars[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
    }
  } catch {
    /* rely on process.env */
  }
  return { ...vars, ...(process.env as Record<string, string>) };
}

const ENV = loadEnv();
const BASE_URL = ENV.LLM_BASE_URL || "";
const API_KEY = ENV.LLM_API_KEY || "";
const MODEL = ENV.LLM_MODEL || "";
const MODEL2 = ENV.LLM_MODEL2 || "";

// Quality bar a model must clear to "pass".
const THRESHOLDS = {
  groundingRate: 0.75, // share of returned rows whose quote is grounded
  measureRecognized: 0.9, // share of rows with a recognised measure family
  goldRecall: 0.6, // share of gold findings recovered
  maxJsonFailures: 0,
};

interface GoldFinding {
  outcomeId?: string;
  measureFamily: MeasureFamily;
  measure?: string;
  value?: number;
  tolerance?: number;
}

interface Fixture {
  title: string;
  template: ExtractionTemplate;
  source: string;
  gold: GoldFinding[];
}

async function chatCompletion(
  messages: { role: "system" | "user"; content: string }[],
  model: string,
  timeoutMs = 120000,
): Promise<string> {
  let endpoint = BASE_URL.replace(/\/+$/, "");
  if (!endpoint.endsWith("/chat/completions")) endpoint += "/chat/completions";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${API_KEY}`,
      },
      body: JSON.stringify({
        model,
        messages,
        stream: false,
        temperature: 0.1,
      }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as any;
    return data?.choices?.[0]?.message?.content ?? "";
  } finally {
    clearTimeout(timer);
  }
}

function extractJSON(content: string): unknown {
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1] || content;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("No JSON object in response");
  return JSON.parse(candidate.slice(start, end + 1));
}

function loadFixtures(): Fixture[] {
  const dir = path.resolve(__dirname, "fixtures", "extraction");
  return fs
    .readdirSync(dir)
    .filter((file) => file.endsWith(".json"))
    .map((file) => JSON.parse(fs.readFileSync(path.join(dir, file), "utf-8")));
}

interface ModelScore {
  fixtures: number;
  jsonFailures: number;
  totalRows: number;
  groundedRows: number;
  recognisedRows: number;
  ungroundedErrors: number;
  goldTotal: number;
  goldRecovered: number;
}

async function scoreModel(
  model: string,
  fixtures: Fixture[],
): Promise<ModelScore> {
  const score: ModelScore = {
    fixtures: fixtures.length,
    jsonFailures: 0,
    totalRows: 0,
    groundedRows: 0,
    recognisedRows: 0,
    ungroundedErrors: 0,
    goldTotal: 0,
    goldRecovered: 0,
  };

  for (let i = 0; i < fixtures.length; i++) {
    const fixture = fixtures[i];
    score.goldTotal += fixture.gold.length;
    let rows: ReturnType<typeof buildExtractionRows>["rows"] = [];
    try {
      const messages = buildExtractionMessages(
        fixture.template,
        fixture.source,
        fixture.title,
      );
      const response = await chatCompletion(messages, model);
      const parsed = ExtractionProposalSchema.parse(extractJSON(response));
      rows = buildExtractionRows({
        proposals: parsed.extractions,
        template: fixture.template,
        content: fixture.source,
        itemId: i + 1,
        model,
      }).rows;
    } catch (error) {
      score.jsonFailures++;
      console.log(
        `    [${model}] "${fixture.title.slice(0, 48)}…" failed: ${
          (error as Error).message
        }`,
      );
      continue;
    }

    for (const row of rows) {
      score.totalRows++;
      const ungrounded = !!row.issues?.find(
        (issue) => issue.code === "ungrounded_quote",
      );
      if (ungrounded) score.ungroundedErrors++;
      else score.groundedRows++;
      if (classifyMeasure(row.effectType).family !== "other") {
        score.recognisedRows++;
      }
    }

    for (const gold of fixture.gold) {
      const recovered = rows.some((row) => {
        if (row.issues?.some((issue) => issue.code === "ungrounded_quote")) {
          return false;
        }
        if (gold.outcomeId && row.outcomeId !== gold.outcomeId) return false;
        if (classifyMeasure(row.effectType).family !== gold.measureFamily) {
          return false;
        }
        if (gold.value === undefined) return true;
        const tol = gold.tolerance ?? 0.01;
        return (
          row.effectSize !== undefined &&
          Math.abs(row.effectSize - gold.value) <= tol
        );
      });
      if (recovered) score.goldRecovered++;
    }
  }
  return score;
}

function rate(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

function report(model: string, score: ModelScore): boolean {
  const grounding = rate(score.groundedRows, score.totalRows);
  const recognised = rate(score.recognisedRows, score.totalRows);
  const goldRecall = rate(score.goldRecovered, score.goldTotal);
  const pass =
    score.jsonFailures <= THRESHOLDS.maxJsonFailures &&
    grounding >= THRESHOLDS.groundingRate &&
    recognised >= THRESHOLDS.measureRecognized &&
    goldRecall >= THRESHOLDS.goldRecall;

  console.log(`\n── ${model} ${pass ? "✔ PASS" : "✘ FAIL"}`);
  console.log(`   fixtures            : ${score.fixtures}`);
  console.log(
    `   JSON failures       : ${score.jsonFailures} (max ${THRESHOLDS.maxJsonFailures})`,
  );
  console.log(`   rows returned       : ${score.totalRows}`);
  console.log(
    `   grounding rate      : ${(grounding * 100).toFixed(0)}% (>= ${(THRESHOLDS.groundingRate * 100).toFixed(0)}%) — ${score.ungroundedErrors} ungrounded`,
  );
  console.log(
    `   measure recognised  : ${(recognised * 100).toFixed(0)}% (>= ${(THRESHOLDS.measureRecognized * 100).toFixed(0)}%)`,
  );
  console.log(
    `   gold recall         : ${(goldRecall * 100).toFixed(0)}% (>= ${(THRESHOLDS.goldRecall * 100).toFixed(0)}%) — ${score.goldRecovered}/${score.goldTotal}`,
  );
  return pass;
}

async function main(): Promise<void> {
  console.log("=== Extraction Capability Eval ===");
  console.log(`Endpoint : ${BASE_URL || "(not set)"}`);
  console.log(`Model 1  : ${MODEL || "(not set)"}`);
  console.log(`Model 2  : ${MODEL2 || "(not set)"}`);

  if (!BASE_URL || !API_KEY || !MODEL) {
    console.error(
      "\nSet LLM_BASE_URL, LLM_API_KEY, and LLM_MODEL in .env to run the eval.",
    );
    process.exit(1);
  }

  const fixtures = loadFixtures();
  console.log(`Fixtures : ${fixtures.length}`);

  const models = [MODEL, ...(MODEL2 && MODEL2 !== MODEL ? [MODEL2] : [])];
  const results: Array<{ model: string; pass: boolean }> = [];
  for (const model of models) {
    console.log(`\nRunning ${model}…`);
    const score = await scoreModel(model, fixtures);
    results.push({ model, pass: report(model, score) });
  }

  console.log("\n=== Scorecard ===");
  for (const result of results) {
    console.log(`  ${result.pass ? "PASS" : "FAIL"}  ${result.model}`);
  }
  // Exit non-zero only if the larger model (last) fails — the small model is
  // allowed to fall short; the eval's job is to report, not to gate CI.
  const larger = results[results.length - 1];
  process.exit(larger && !larger.pass ? 1 : 0);
}

main().catch((error) => {
  console.error(`Fatal: ${error}`);
  process.exit(1);
});
