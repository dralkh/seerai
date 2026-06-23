/**
 * Live end-to-end pipeline eval.
 *
 * Run with:  npx tsx test/pipelineEval.ts   (or: npm run test:pipeline-eval)
 *
 * For every model in .env (LLM_MODEL = model1/small, LLM_MODEL2 = model2/larger)
 * and every multi-study review fixture in test/fixtures/reviews/*.json this:
 *   1. runs the REAL extraction prompt over each included study,
 *   2. feeds the output through the production validation pipeline,
 *   3. auto-verifies the surviving rows (what "verify all" would do),
 *   4. runs the deterministic synthesis + gap-analysis engine, and
 *   5. scores extraction, synthesis, and gap analysis against the fixture gold.
 *
 * It writes a full markdown log to test/logs/pipeline-eval-<timestamp>.md and
 * prints a scorecard. No Zotero required; Node fetch + pure modules only.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildExtractionMessages,
  buildExtractionRows,
  ExtractionProposalSchema,
} from "../src/modules/systematicReview/extractionWorkflow";
import { classifyMeasure } from "../src/modules/systematicReview/measures";
import { ExtractionRow } from "../src/modules/systematicReview/types";
import {
  ExpectedRow,
  gapCoversOutcome,
  normalizeOutcomeName,
  ReviewFixture,
  reviewFixtures,
  runPipeline,
} from "./fixtures/reviews/reviewFixture";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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

// Quality bars a model must clear to "pass" the full pipeline.
const THRESHOLDS = {
  extractionGoldRecall: 0.6, // share of gold per-study findings recovered + grounded
  groundingRate: 0.75, // share of returned rows whose quote is grounded
  measureRecognized: 0.9, // share of rows with a recognised measure family
  synthesisRecall: 0.75, // share of gold synthesis domains correctly reproduced
  gapRecall: 0.75, // share of gold gap expectations satisfied
  maxJsonFailures: 1, // tolerate the odd malformed study response
};

const lines: string[] = [];
function log(message = ""): void {
  console.log(message);
  lines.push(message);
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

function rate(numerator: number, denominator: number): number {
  return denominator === 0 ? 1 : numerator / denominator;
}

function isUngrounded(row: ExtractionRow): boolean {
  return !!row.issues?.some((issue) => issue.code === "ungrounded_quote");
}

/** Does a returned row satisfy a gold per-study expectation? */
function rowMatchesExpected(
  row: ExtractionRow,
  expected: ExpectedRow,
): boolean {
  if (isUngrounded(row)) return false;
  const goldFamily = classifyMeasure(expected.effectType).family;
  if (classifyMeasure(row.effectType).family !== goldFamily) return false;
  if (expected.effectSize === undefined) return true;
  const tol = expected.tolerance ?? 0.02;
  return (
    row.effectSize !== undefined &&
    Math.abs(row.effectSize - expected.effectSize) <= tol
  );
}

interface FixtureScore {
  goldTotal: number;
  goldRecovered: number;
  rows: number;
  grounded: number;
  recognised: number;
  jsonFailures: number;
  synthesisTotal: number;
  synthesisOk: number;
  gapTotal: number;
  gapOk: number;
}

async function scoreFixture(
  model: string,
  fixture: ReviewFixture,
): Promise<FixtureScore> {
  const score: FixtureScore = {
    goldTotal: 0,
    goldRecovered: 0,
    rows: 0,
    grounded: 0,
    recognised: 0,
    jsonFailures: 0,
    synthesisTotal: fixture.gold.synthesis.length,
    synthesisOk: 0,
    gapTotal:
      fixture.gold.gaps.expectGapOutcomes.length +
      fixture.gold.gaps.expectAdequateOutcomes.length,
    gapOk: 0,
  };

  const extractions: Record<number, ExtractionRow[]> = {};

  for (const study of fixture.studies) {
    score.goldTotal += study.expected.length;
    let rows: ExtractionRow[] = [];
    try {
      const messages = buildExtractionMessages(
        fixture.template,
        study.source,
        study.label,
      );
      const response = await chatCompletion(messages, model);
      const parsed = ExtractionProposalSchema.parse(extractJSON(response));
      rows = buildExtractionRows({
        proposals: parsed.extractions,
        template: fixture.template,
        content: study.source,
        itemId: study.paperId,
        model,
      }).rows;
    } catch (error) {
      score.jsonFailures++;
      log(
        `    FAIL [${study.label}] extraction failed: ${(error as Error).message}`,
      );
      extractions[study.paperId] = [];
      continue;
    }

    for (const row of rows) {
      score.rows++;
      if (!isUngrounded(row)) score.grounded++;
      if (classifyMeasure(row.effectType).family !== "other")
        score.recognised++;
    }
    for (const expected of study.expected) {
      if (rows.some((row) => rowMatchesExpected(row, expected))) {
        score.goldRecovered++;
      } else {
        const def = fixture.template.outcomes.find(
          (outcome) => outcome.id === expected.outcomeId,
        );
        log(
          `    - [${study.label}] missed gold: ${def?.name || expected.outcomeId} ` +
            `${expected.effectType}=${expected.effectSize ?? "?"}`,
        );
      }
    }

    // Auto-verify: the engine still re-guards (error issues / completeness /
    // grounding), so "verify all" is the right call here.
    extractions[study.paperId] = rows.map((row) => ({
      ...row,
      verificationStatus: "verified" as const,
    }));
  }

  const { synthesis, gap } = runPipeline(fixture, extractions);

  log(
    `    synthesis domains: ${
      synthesis.domains
        .map(
          (d) => `${d.outcome}/${d.measure}=${d.status}(${d.paperIds.length})`,
        )
        .join(", ") || "(none)"
    }`,
  );

  for (const gold of fixture.gold.synthesis) {
    const want = classifyMeasure(gold.measure).canonical;
    const domain = synthesis.domains.find(
      (d) =>
        normalizeOutcomeName(d.outcome) ===
          normalizeOutcomeName(gold.outcome) && d.measure === want,
    );
    let ok =
      !!domain &&
      domain.status === gold.status &&
      domain.method === gold.method &&
      domain.direction === gold.direction &&
      domain.paperIds.length >= gold.minStudies;
    if (ok && gold.estimate) {
      ok =
        !!domain!.randomEffects &&
        Math.abs(domain!.randomEffects.estimate - gold.estimate.value) <=
          gold.estimate.tolerance;
    }
    if (ok) score.synthesisOk++;
    else
      log(
        `    FAIL synthesis miss: ${gold.outcome}/${gold.measure} ` +
          `(got ${domain ? `${domain.status}/${domain.method}/${domain.direction}/${domain.paperIds.length}` : "no domain"})`,
      );
  }

  for (const name of fixture.gold.gaps.expectGapOutcomes) {
    if (gap.gaps.some((candidate) => gapCoversOutcome(candidate, name)))
      score.gapOk++;
    else log(`    FAIL gap miss: expected a gap covering "${name}"`);
  }
  for (const name of fixture.gold.gaps.expectAdequateOutcomes) {
    if (!gap.gaps.some((candidate) => gapCoversOutcome(candidate, name)))
      score.gapOk++;
    else log(`    FAIL gap miss: "${name}" should be adequate, not a gap`);
  }

  return score;
}

function reportFixture(fixture: ReviewFixture, score: FixtureScore): void {
  const recall = rate(score.goldRecovered, score.goldTotal);
  const grounding = rate(score.grounded, score.rows);
  const recognised = rate(score.recognised, score.rows);
  const syn = rate(score.synthesisOk, score.synthesisTotal);
  const gapR = rate(score.gapOk, score.gapTotal);
  log(`  - ${fixture.id} (${fixture.regime})`);
  log(`      JSON failures   : ${score.jsonFailures}`);
  log(
    `      extraction recall: ${(recall * 100).toFixed(0)}% (${score.goldRecovered}/${score.goldTotal})`,
  );
  log(
    `      grounding        : ${(grounding * 100).toFixed(0)}%; measure recognised: ${(recognised * 100).toFixed(0)}% (${score.rows} rows)`,
  );
  log(
    `      synthesis        : ${(syn * 100).toFixed(0)}% (${score.synthesisOk}/${score.synthesisTotal})`,
  );
  log(
    `      gap analysis     : ${(gapR * 100).toFixed(0)}% (${score.gapOk}/${score.gapTotal})`,
  );
}

function aggregate(scores: FixtureScore[]): {
  recall: number;
  grounding: number;
  recognised: number;
  synthesis: number;
  gap: number;
  jsonFailures: number;
  pass: boolean;
} {
  const sum = (pick: (s: FixtureScore) => number) =>
    scores.reduce((acc, s) => acc + pick(s), 0);
  const recall = rate(
    sum((s) => s.goldRecovered),
    sum((s) => s.goldTotal),
  );
  const grounding = rate(
    sum((s) => s.grounded),
    sum((s) => s.rows),
  );
  const recognised = rate(
    sum((s) => s.recognised),
    sum((s) => s.rows),
  );
  const synthesis = rate(
    sum((s) => s.synthesisOk),
    sum((s) => s.synthesisTotal),
  );
  const gap = rate(
    sum((s) => s.gapOk),
    sum((s) => s.gapTotal),
  );
  const jsonFailures = sum((s) => s.jsonFailures);
  const pass =
    jsonFailures <= THRESHOLDS.maxJsonFailures &&
    recall >= THRESHOLDS.extractionGoldRecall &&
    grounding >= THRESHOLDS.groundingRate &&
    recognised >= THRESHOLDS.measureRecognized &&
    synthesis >= THRESHOLDS.synthesisRecall &&
    gap >= THRESHOLDS.gapRecall;
  return { recall, grounding, recognised, synthesis, gap, jsonFailures, pass };
}

async function main(): Promise<void> {
  log("=== End-to-end Pipeline Eval (extraction -> synthesis -> gap) ===");
  log(`Date     : ${new Date().toISOString()}`);
  log(`Endpoint : ${BASE_URL || "(not set)"}`);
  log(`Model 1  : ${MODEL || "(not set)"}`);
  log(`Model 2  : ${MODEL2 || "(not set)"}`);
  log(`Fixtures : ${reviewFixtures.map((f) => f.id).join(", ")}`);

  if (!BASE_URL || !API_KEY || !MODEL) {
    console.error(
      "\nSet LLM_BASE_URL, LLM_API_KEY, and LLM_MODEL in .env to run the eval.",
    );
    process.exit(1);
  }

  const models = [MODEL, ...(MODEL2 && MODEL2 !== MODEL ? [MODEL2] : [])];
  const results: Array<{ model: string; pass: boolean }> = [];

  for (const model of models) {
    log(`\n------------ ${model} ------------`);
    const scores: FixtureScore[] = [];
    for (const fixture of reviewFixtures) {
      log(`\n  Running ${fixture.id}…`);
      const score = await scoreFixture(model, fixture);
      reportFixture(fixture, score);
      scores.push(score);
    }
    const agg = aggregate(scores);
    log(`\n  -- ${model} ${agg.pass ? "PASS" : "FAIL"} (aggregate)`);
    log(
      `     extraction recall ${(agg.recall * 100).toFixed(0)}% (>=${THRESHOLDS.extractionGoldRecall * 100}%); ` +
        `grounding ${(agg.grounding * 100).toFixed(0)}% (>=${THRESHOLDS.groundingRate * 100}%); ` +
        `recognised ${(agg.recognised * 100).toFixed(0)}% (>=${THRESHOLDS.measureRecognized * 100}%)`,
    );
    log(
      `     synthesis ${(agg.synthesis * 100).toFixed(0)}% (>=${THRESHOLDS.synthesisRecall * 100}%); ` +
        `gap ${(agg.gap * 100).toFixed(0)}% (>=${THRESHOLDS.gapRecall * 100}%); ` +
        `JSON failures ${agg.jsonFailures} (<=${THRESHOLDS.maxJsonFailures})`,
    );
    results.push({ model, pass: agg.pass });
  }

  log("\n=== Scorecard ===");
  for (const result of results)
    log(`  ${result.pass ? "PASS" : "FAIL"}  ${result.model}`);

  const logDir = path.resolve(__dirname, "logs");
  fs.mkdirSync(logDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const logPath = path.join(logDir, `pipeline-eval-${stamp}.md`);
  fs.writeFileSync(logPath, lines.join("\n") + "\n", "utf-8");
  console.log(`\nFull log written to ${logPath}`);

  // Report-only by default; exit non-zero only if the larger model fails so it
  // can gate CI if wired up, while the small model is allowed to fall short.
  const larger = results[results.length - 1];
  process.exit(larger && !larger.pass ? 1 : 0);
}

main().catch((error) => {
  console.error(`Fatal: ${error}`);
  process.exit(1);
});
