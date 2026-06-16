import { z } from "zod";
import { getActiveModelConfig } from "../chat/modelConfig";
import { openAIService } from "../openai";
import {
  ScreeningDecision,
  SystematicReviewPaper,
  SystematicReviewSpace,
} from "./types";
import { getActiveProtocolRevision } from "./protocol";
import { ReviewCancellationSignal } from "./cancellation";
import { modelConfidenceSchema } from "./modelOutput";
import { getReviewSourceDocument } from "./reviewSourceService";

const AnalysisSchema = z.object({
  studyDesign: z.string().nullish(),
  population: z.string().nullish(),
  intervention: z.string().nullish(),
  comparator: z.string().nullish(),
  outcomes: z.array(z.string()).nullish(),
  sampleSize: z.number().int().nonnegative().nullish(),
  methods: z.string().nullish(),
  limitations: z.string().nullish(),
  recommendation: z
    .object({
      decision: z.enum(["included", "maybe", "excluded"]),
      confidence: modelConfidenceSchema,
      rationale: z.string(),
      criteria: z.array(
        z.object({
          criterionId: z.string(),
          verdict: z.enum(["met", "not_met", "unclear"]),
          rationale: z.string(),
          quote: z.string().nullish(),
          confidence: modelConfidenceSchema.nullish(),
        }),
      ),
    })
    .nullish(),
  evidence: z
    .array(
      z.object({
        field: z.string(),
        quote: z.string().min(8),
      }),
    )
    .default([]),
});

function parseJSON(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1] || text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("Model returned no JSON");
  return JSON.parse(candidate.slice(start, end + 1));
}

function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

export function deriveScreeningRecommendation(
  criteria: { id: string; type: "dimension" | "include" | "exclude" }[],
  assessments: {
    criterionId: string;
    verdict: "met" | "not_met" | "unclear";
  }[],
): { decision: ScreeningDecision; rationale: string } {
  const verdicts = new Map(
    assessments.map((assessment) => [
      assessment.criterionId,
      assessment.verdict,
    ]),
  );
  const exclusionMet = criteria.some(
    (criterion) =>
      criterion.type === "exclude" && verdicts.get(criterion.id) === "met",
  );
  const requiredFailed = criteria.some(
    (criterion) =>
      criterion.type !== "exclude" && verdicts.get(criterion.id) === "not_met",
  );
  const unclear = criteria.some(
    (criterion) => (verdicts.get(criterion.id) || "unclear") === "unclear",
  );
  if (exclusionMet) {
    return {
      decision: "excluded",
      rationale: "At least one exclusion criterion is met.",
    };
  }
  if (requiredFailed) {
    return {
      decision: "excluded",
      rationale: "At least one required criterion is not met.",
    };
  }
  if (unclear) {
    return {
      decision: "maybe",
      rationale: "One or more eligibility criteria remain unclear.",
    };
  }
  return {
    decision: "included",
    rationale:
      "All assessed required criteria are met and no exclusion criterion is met.",
  };
}

export async function analyzeReviewPaper(
  item: Zotero.Item,
  project: SystematicReviewSpace,
  options?: {
    signal?: ReviewCancellationSignal;
    sourcePreference?: SystematicReviewPaper["sourcePreference"];
    onStage?: (
      stage: "reading_source" | "extracting" | "validating",
    ) => void | Promise<void>;
  },
): Promise<{
  analysis: NonNullable<SystematicReviewPaper["analysis"]>;
  recommendation?: NonNullable<SystematicReviewPaper["recommendation"]>;
}> {
  const title = (item.getField("title") as string) || `Item ${item.id}`;
  await options?.onStage?.("reading_source");
  Zotero.debug(`[seerai] Review analysis ${item.id}: reading source content`);
  const source = await getReviewSourceDocument(
    item,
    options?.signal,
    options?.sourcePreference,
  );
  const content = source.text;
  const revision = getActiveProtocolRevision(project.protocol);
  const expectedCriteria = [
    ...revision.dimensions.map((dimension) => ({
      id: `dimension:${dimension.key}`,
      type: "dimension" as const,
      text: `${dimension.label}: ${dimension.value || "not specified"}`,
    })),
    ...revision.eligibilityRules.map((rule) => ({
      id: rule.id,
      type: rule.type,
      text: rule.text,
    })),
  ];
  const criteria = expectedCriteria
    .map(
      (criterion) => `${criterion.id} [${criterion.type}]: ${criterion.text}`,
    )
    .join("\n");
  await options?.onStage?.("extracting");
  Zotero.debug(
    `[seerai] Review analysis ${item.id}: sending ${content.length}/${source.summary.totalCharacters} source characters from ${source.summary.kind}`,
  );
  const response = await openAIService.chatCompletion(
    [
      {
        role: "system",
        content:
          "You extract structured research facts and evaluate an explicit review protocol against supplied source text. Return one JSON object only. Evaluate every criterion using its exact supplied ID as met, not_met, or unclear. A keyword match is never sufficient evidence. Every populated fact and non-unclear criterion verdict must have a short verbatim supporting quote. If evidence is absent, use unclear. Do not infer missing values.",
      },
      {
        role: "user",
        content: `Review protocol revision: ${revision.id}
Research question: ${revision.researchQuestion || "Not specified"}
Review framework: ${revision.framework}
Eligibility criteria:
${criteria}

Paper title: ${title}

Source text:
${content}

Use a decimal from 0 to 1 for confidence.

Return:
{"studyDesign"?:string,"population"?:string,"intervention"?:string,"comparator"?:string,"outcomes"?:string[],"sampleSize"?:number,"methods"?:string,"limitations"?:string,"recommendation"?:{"decision":"included"|"maybe"|"excluded","confidence":number,"rationale":string,"criteria":[{"criterionId":string,"verdict":"met"|"not_met"|"unclear","rationale":string,"quote"?:string}]},"evidence":[{"field":string,"quote":string}]}`,
      },
    ],
    { signal: options?.signal, timeoutMs: 180000, isolated: true },
  );
  if (options?.signal?.aborted) {
    throw new Error("Request was cancelled");
  }
  await options?.onStage?.("validating");
  Zotero.debug(`[seerai] Review analysis ${item.id}: validating model output`);
  const parsed = AnalysisSchema.parse(parseJSON(response));
  const stripNull = <T>(value: T | null | undefined): T | undefined =>
    value === null ? undefined : (value as T | undefined);
  const normalizedContent = normalize(content);
  const evidence = parsed.evidence.filter((entry) =>
    normalizedContent.includes(normalize(entry.quote)),
  );
  const groundedFields = new Set(evidence.map((entry) => entry.field));
  const requireEvidence = <T>(field: string, value: T | undefined) =>
    value !== undefined && groundedFields.has(field) ? value : undefined;
  const model = getActiveModelConfig()?.model || "configured model";
  const analysis: NonNullable<SystematicReviewPaper["analysis"]> = {
    studyDesign: requireEvidence("studyDesign", stripNull(parsed.studyDesign)),
    population: requireEvidence("population", stripNull(parsed.population)),
    intervention: requireEvidence(
      "intervention",
      stripNull(parsed.intervention),
    ),
    comparator: requireEvidence("comparator", stripNull(parsed.comparator)),
    outcomes: requireEvidence("outcomes", stripNull(parsed.outcomes)),
    sampleSize: requireEvidence("sampleSize", stripNull(parsed.sampleSize)),
    methods: requireEvidence("methods", stripNull(parsed.methods)),
    limitations: requireEvidence("limitations", stripNull(parsed.limitations)),
    evidence,
    model,
    createdAt: new Date().toISOString(),
    protocolRevisionId: revision.id,
  };
  const recommendation = parsed.recommendation;
  const returnedCriteria = new Map(
    (recommendation?.criteria || []).map((criterion) => [
      criterion.criterionId,
      criterion,
    ]),
  );
  const groundedCriteria = expectedCriteria.map((expected) => {
    const criterion = returnedCriteria.get(expected.id);
    const quote = stripNull(criterion?.quote);
    const grounded = quote && normalizedContent.includes(normalize(quote));
    return {
      criterionId: expected.id,
      verdict:
        criterion?.verdict !== "unclear" && !grounded
          ? ("unclear" as const)
          : criterion?.verdict || ("unclear" as const),
      rationale:
        criterion?.rationale || "The model did not assess this criterion",
      quote: grounded ? quote : undefined,
      confidence: criterion ? stripNull(criterion.confidence) : undefined,
    };
  });
  const { decision, rationale } = deriveScreeningRecommendation(
    expectedCriteria,
    groundedCriteria,
  );
  return {
    analysis: { ...analysis, sourceSummary: source.summary },
    recommendation: {
      decision,
      confidence: recommendation?.confidence ?? 0.5,
      rationale,
      source: "model",
      createdAt: new Date().toISOString(),
      protocolRevisionId: revision.id,
      sourceSummary: source.summary,
      criteria: groundedCriteria,
    },
  };
}

export function withReviewTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  message: string,
  signal?: ReviewCancellationSignal,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = () =>
      finish(() => reject(new Error("Request was cancelled")));
    const timer = setTimeout(
      () => finish(() => reject(new Error(message))),
      timeoutMs,
    );
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort);
    operation.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
  });
}
