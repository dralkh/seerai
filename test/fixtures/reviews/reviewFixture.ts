/**
 * Shared types + helpers for the multi-study "review" fixtures.
 *
 * A review fixture represents a complete systematic review: a protocol, an
 * extraction template, several included primary studies (each with its own
 * groundable source text and a gold per-study extraction), and gold
 * expectations for the downstream synthesis and gap-analysis stages.
 *
 * The same fixtures drive two things:
 *   - the deterministic pipeline test (gold rows -> engine -> assertions), and
 *   - the live model eval (model extraction -> engine -> scorecard).
 *
 * Everything here is Zotero-free and pure so it runs under both the Mocha
 * harness (zotero-plugin test) and plain tsx.
 */
import {
  buildGapAnalysisRun,
  buildSynthesisRun,
} from "../../../src/modules/systematicReview/analysisEngine";
import { classifyMeasure } from "../../../src/modules/systematicReview/measures";
import { createProtocolFromLegacy } from "../../../src/modules/systematicReview/protocol";
import {
  ExtractionRow,
  ExtractionTemplate,
  GapAnalysisRun,
  SynthesisRun,
  SystematicReviewState,
} from "../../../src/modules/systematicReview/types";

import corticosteroids from "./corticosteroids-or.json";
import meditation from "./meditation-smd.json";
import diagnostic from "./dl-imaging-diagnostic.json";

export interface ExpectedRow {
  outcomeId: string;
  effectType: string;
  effectSize?: number;
  ciLow?: number;
  ciHigh?: number;
  n?: number;
  events?: number;
  quote: string;
  tolerance?: number;
}

export interface ReviewStudy {
  paperId: number;
  label: string;
  source: string;
  expected: ExpectedRow[];
}

export interface GoldSynthesis {
  outcome: string;
  measure: string;
  method: "random_effects" | "common_effect" | "narrative";
  status: "poolable" | "not_poolable" | "narrative";
  direction: "positive" | "mixed" | "none" | "unclear";
  minStudies: number;
  estimate?: { value: number; tolerance: number };
  i2Max?: number;
}

export interface ReviewFixture {
  id: string;
  title: string;
  citation: string;
  regime: "ratio" | "continuous" | "diagnostic";
  protocol: {
    framework: string;
    researchQuestion: string;
    values: Record<string, string>;
  };
  template: ExtractionTemplate;
  studies: ReviewStudy[];
  gold: {
    synthesis: GoldSynthesis[];
    narrativeOutcomes: string[];
    gaps: { expectGapOutcomes: string[]; expectAdequateOutcomes: string[] };
  };
}

export const reviewFixtures: ReviewFixture[] = [
  corticosteroids as unknown as ReviewFixture,
  meditation as unknown as ReviewFixture,
  diagnostic as unknown as ReviewFixture,
];

export function normalizeOutcomeName(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function outcomeDef(fixture: ReviewFixture, outcomeId: string) {
  return fixture.template.outcomes.find((outcome) => outcome.id === outcomeId);
}

/**
 * Build a fully-formed, verified extraction row from a gold per-study
 * expectation: the "perfect reviewer" baseline the deterministic test feeds
 * straight into the synthesis engine.
 */
export function goldRow(
  fixture: ReviewFixture,
  paperId: number,
  expected: ExpectedRow,
  index: number,
): ExtractionRow {
  const outcome = outcomeDef(fixture, expected.outcomeId);
  const info = classifyMeasure(expected.effectType);
  return {
    id: `gold_${paperId}_${index}`,
    outcomeId: outcome?.id,
    outcome: outcome?.name || expected.outcomeId,
    effectType: info.canonical,
    measureFamily: info.family,
    poolable: info.poolable,
    effectSize: expected.effectSize,
    ciLow: expected.ciLow,
    ciHigh: expected.ciHigh,
    n: expected.n,
    events: expected.events,
    direction: outcome?.direction,
    sourceQuote: expected.quote,
    verificationStatus: "verified",
    confidence: 0.95,
    model: "gold",
    templateRevisionId: fixture.template.revisionId,
    revision: 1,
    updatedAt: "2026-01-01T00:00:00.000Z",
    issues: [],
  };
}

export function goldExtractions(
  fixture: ReviewFixture,
): Record<number, ExtractionRow[]> {
  const out: Record<number, ExtractionRow[]> = {};
  for (const study of fixture.studies) {
    out[study.paperId] = study.expected.map((expected, index) =>
      goldRow(fixture, study.paperId, expected, index),
    );
  }
  return out;
}

/**
 * Assemble the minimal SystematicReviewState the deterministic engine reads:
 * an active protocol revision, the included papers, and their verified
 * extractions. Risk-of-bias is intentionally left empty so GRADE certainty is
 * driven purely by heterogeneity/imprecision in these tests.
 */
export function buildReviewState(
  fixture: ReviewFixture,
  extractions: Record<number, ExtractionRow[]>,
): SystematicReviewState {
  const protocol = createProtocolFromLegacy(
    fixture.protocol.framework,
    fixture.protocol.values,
    [],
    [],
    {},
    fixture.protocol.researchQuestion,
  );
  const paperIds = fixture.studies.map((study) => study.paperId);
  return {
    activeSpaceId: fixture.id,
    protocol,
    papers: paperIds.map((id) => ({
      id,
      status: "included",
      screeningStage: "final",
      aiStatus: "manual",
      confidence: 1,
      manualAdded: true,
    })),
    extractionTemplates: [fixture.template],
    activeExtractionTemplateId: fixture.template.id,
    reviewJobs: [],
    extractions,
    robData: {},
    synthesisRuns: [],
    gapAnalysisRuns: [],
    analysisSettings: { automation: "manual", sparseStudyThreshold: 2 },
  } as unknown as SystematicReviewState;
}

export function runPipeline(
  fixture: ReviewFixture,
  extractions: Record<number, ExtractionRow[]>,
): {
  state: SystematicReviewState;
  synthesis: SynthesisRun;
  gap: GapAnalysisRun;
} {
  const state = buildReviewState(fixture, extractions);
  const synthesis = buildSynthesisRun(state);
  const gap = buildGapAnalysisRun(state, synthesis);
  return { state, synthesis, gap };
}

/** A gap candidate "covers" an outcome when that outcome name is one of its
 * dimension tags (the gap engine tags each candidate with [rowValue, columnValue],
 * and columnValue is the synthesis domain's outcome name). */
export function gapCoversOutcome(
  gap: { dimensionTags: string[] },
  outcomeName: string,
): boolean {
  const target = normalizeOutcomeName(outcomeName);
  return gap.dimensionTags.some((tag) => normalizeOutcomeName(tag) === target);
}
