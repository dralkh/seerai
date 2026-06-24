import { assert } from "chai";
import {
  buildGapAnalysisRun,
  buildSynthesisRun,
  computeSynthesisFingerprint,
} from "../src/modules/systematicReview/analysisEngine";
import { createProtocolFromLegacy } from "../src/modules/systematicReview/protocol";
import {
  ExtractionTemplate,
  SystematicReviewState,
} from "../src/modules/systematicReview/types";

function reviewState(): SystematicReviewState {
  const protocol = createProtocolFromLegacy(
    "PICO",
    {
      P: "Adults",
      I: "Treatment",
      C: "Usual care",
      O: "Mortality",
    },
    [],
    [],
    {},
    "Does treatment reduce mortality?",
  );
  const template: ExtractionTemplate = {
    id: "template-1",
    revisionId: "template-1_r1",
    protocolRevisionId: protocol.activeRevisionId,
    name: "Outcomes",
    instructions: "",
    outcomes: [
      {
        id: "mortality",
        name: "Mortality",
        aliases: [],
        description: "",
        measures: ["RR"],
        timepoints: [],
        required: true,
      },
      {
        id: "icu",
        name: "ICU Admission",
        aliases: [],
        description: "",
        measures: ["PERCENTAGE"],
        timepoints: [],
        required: true,
      },
    ],
    status: "active",
    source: "user",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  return {
    activeSpaceId: "review-1",
    protocol,
    papers: [
      {
        id: 1,
        status: "included",
        screeningStage: "final",
        aiStatus: "manual",
        confidence: 1,
        manualAdded: true,
      },
      {
        id: 2,
        status: "included",
        screeningStage: "final",
        aiStatus: "manual",
        confidence: 1,
        manualAdded: true,
      },
      {
        id: 3,
        status: "maybe",
        screeningStage: "final",
        aiStatus: "manual",
        confidence: 1,
        manualAdded: true,
      },
    ],
    extractions: {
      1: [
        {
          id: "ext-1",
          outcome: "Mortality",
          effectType: "RR",
          effectSize: 0.8,
          ciLow: 0.64,
          ciHigh: 1,
          n: 100,
          events: 10,
          sourceQuote:
            "Mortality occurred in 10 participants in the treatment group.",
          verificationStatus: "verified",
        },
      ],
      2: [
        {
          id: "ext-2",
          outcome: "Mortality",
          effectType: "RR",
          effectSize: 0.9,
          ciLow: 0.72,
          ciHigh: 1.125,
          n: 120,
          events: 12,
          sourceQuote:
            "Twelve mortality events were observed during follow-up.",
          verificationStatus: "verified",
        },
      ],
      3: [
        {
          id: "ext-3",
          outcome: "Mortality",
          effectType: "RR",
          effectSize: 0.5,
          ciLow: 0.4,
          ciHigh: 0.6,
          n: 50,
          events: 5,
          sourceQuote: "Five deaths were recorded in the intervention arm.",
          verificationStatus: "verified",
        },
      ],
    },
    extractionTemplates: [template],
    activeExtractionTemplateId: template.id,
    robData: {
      1: {
        randomization: "low",
        deviations: "low",
        missing: "low",
        measurement: "low",
        selective: "low",
        verificationStatus: "verified",
      },
      2: {
        randomization: "low",
        deviations: "low",
        missing: "low",
        measurement: "low",
        selective: "low",
        verificationStatus: "verified",
      },
    },
    synthesisRuns: [],
    gapAnalysisRuns: [],
    analysisSettings: {
      automation: "auto_draft",
      sparseStudyThreshold: 2,
    },
  } as unknown as SystematicReviewState;
}

describe("Systematic review synthesis and gap engine", function () {
  it("uses verified evidence from final included papers only", function () {
    const run = buildSynthesisRun(reviewState());
    assert.deepEqual(run.includedPaperIds, [1, 2]);
    assert.lengthOf(run.domains, 1);
    assert.deepEqual(run.domains[0].paperIds, [1, 2]);
    assert.equal(run.domains[0].status, "poolable");
    assert.isDefined(run.domains[0].commonEffect);
    assert.isDefined(run.domains[0].randomEffects);
  });

  it("excludes unverified extraction proposals", function () {
    const state = reviewState();
    state.extractions[2][0].verificationStatus = "proposed";
    const run = buildSynthesisRun(state);
    assert.lengthOf(run.domains[0].studies, 1);
    assert.equal(run.domains[0].status, "not_poolable");
  });

  it("changes the input fingerprint when verified evidence changes", function () {
    const state = reviewState();
    const first = computeSynthesisFingerprint(state);
    state.extractions[1][0].effectSize = 0.7;
    const second = computeSynthesisFingerprint(state);
    assert.notEqual(first, second);
  });

  it("preserves a reviewed gap decision by canonical identity", function () {
    const state = reviewState();
    state.analysisSettings.sparseStudyThreshold = 3;
    const synthesis = buildSynthesisRun(state);
    const first = buildGapAnalysisRun(state, synthesis);
    assert.isAtLeast(first.gaps.length, 4);
    first.gaps[0].status = "accepted";
    first.gaps[0].reviewerNote = "Confirmed priority";
    state.gapAnalysisRuns.push(first);
    const second = buildGapAnalysisRun(state, synthesis);
    assert.equal(second.gaps[0].id, first.gaps[0].id);
    assert.equal(second.gaps[0].status, "accepted");
    assert.equal(second.gaps[0].reviewerNote, "Confirmed priority");
  });

  it("maps every configured protocol dimension against outcomes", function () {
    const state = reviewState();
    const synthesis = buildSynthesisRun(state);
    const gaps = buildGapAnalysisRun(state, synthesis);
    assert.deepEqual(
      Array.from(new Set(gaps.cells.map((cell) => cell.rowKey))).sort(),
      ["C", "I", "O", "P"],
    );
    assert.equal(gaps.columnDimensionKey, "outcome");
  });

  it("creates no-evidence gap cells for required outcomes with no verified rows", function () {
    const state = reviewState();
    const synthesis = buildSynthesisRun(state);
    const gaps = buildGapAnalysisRun(state, synthesis);
    const icuCells = gaps.cells.filter(
      (cell) => cell.columnValue === "ICU Admission",
    );
    assert.lengthOf(icuCells, 4);
    assert.isTrue(icuCells.every((cell) => cell.status === "no_evidence"));
    assert.isTrue(
      gaps.gaps.some((gap) =>
        gap.dimensionTags.some((tag) => tag === "ICU Admission"),
      ),
    );
  });

  it("keeps non-poolable narrative estimates without confidence intervals", function () {
    const state = reviewState();
    state.extractionTemplates[0].outcomes[0].measures = ["Specificity"];
    state.extractions = {
      1: [
        {
          id: "spec-1",
          outcomeId: "mortality",
          outcome: "Mortality",
          effectType: "Specificity",
          effectSize: 0.8,
          sourceQuote: "Specificity was 0.80.",
          verificationStatus: "verified",
        },
      ],
    };
    const synthesis = buildSynthesisRun(state);
    assert.equal(synthesis.domains[0].method, "narrative");
    assert.equal(synthesis.domains[0].studies[0].estimate, 0.8);
    assert.isUndefined(synthesis.domains[0].studies[0].ciLow);
    assert.isUndefined(synthesis.domains[0].studies[0].ciHigh);
  });
});
