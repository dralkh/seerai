import { assert } from "chai";
import {
  getMissingRequiredOutcomes,
  hasFailedExtractionMetrics,
} from "../src/modules/systematicReview/extractionHealth";
import { createProtocolFromLegacy } from "../src/modules/systematicReview/protocol";
import { SystematicReviewService } from "../src/modules/systematicReview/service";
import { SystematicReviewStore } from "../src/modules/systematicReview/store";
import {
  ExtractionTemplate,
  SystematicReviewState,
} from "../src/modules/systematicReview/types";

function template(status: ExtractionTemplate["status"]): ExtractionTemplate {
  return {
    id: "tpl",
    revisionId: "tpl_r1",
    protocolRevisionId: "rev",
    name: "Template",
    instructions: "",
    outcomes: [
      {
        id: "disc",
        name: "Discriminative Performance",
        aliases: [],
        description: "",
        measures: ["AUROC"],
        timepoints: [],
        required: false,
      },
      {
        id: "mort",
        name: "Mortality",
        aliases: [],
        description: "",
        measures: ["percentage"],
        timepoints: [],
        required: true,
      },
    ],
    status,
    source: "model",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function baseState(tpl: ExtractionTemplate): SystematicReviewState {
  const protocol = createProtocolFromLegacy(
    "PICO",
    { P: "Adults", I: "Model", C: "Clinician", O: "Mortality" },
    [],
    [],
    {},
  );
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
    ],
    extractionTemplates: [tpl],
    activeExtractionTemplateId: tpl.status === "active" ? tpl.id : undefined,
    reviewJobs: [],
    extractions: {},
    synthesisRuns: [],
  } as unknown as SystematicReviewState;
}

describe("Required outcomes are informational, not failures", function () {
  it("does not mark a paper failed for row errors or missing required outcomes", function () {
    const state = baseState(template("active"));
    // A grounded but error-flagged row for a non-required outcome; the required
    // Mortality outcome has no row at all.
    state.extractions[1] = [
      {
        id: "ext-1",
        outcomeId: "disc",
        outcome: "Discriminative Performance",
        effectType: "AUROC",
        effectSize: 0.91,
        sourceQuote: "AUROC of 0.91",
        verificationStatus: "proposed",
        issues: [{ code: "ungrounded_quote", severity: "error", message: "x" }],
      },
    ];
    state.reviewJobs = [
      {
        id: "job-1",
        kind: "extraction",
        projectId: "review-1",
        protocolRevisionId: state.protocol.activeRevisionId,
        templateRevisionId: "tpl_r1",
        status: "completed_with_issues",
        paperIds: [1],
        papers: [{ paperId: 1, stage: "completed", attempts: 1 }],
        concurrency: 2,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ] as unknown as SystematicReviewState["reviewJobs"];

    // Missing-required is still reported for display…
    assert.deepEqual(
      getMissingRequiredOutcomes(state, 1).map((outcome) => outcome.name),
      ["Mortality"],
    );
    // …but it no longer flags the paper as failed / needing retry.
    assert.isFalse(hasFailedExtractionMetrics(state, 1));
  });

  it("still treats a genuinely failed job stage as a failure", function () {
    const state = baseState(template("active"));
    state.reviewJobs = [
      {
        id: "job-1",
        kind: "extraction",
        projectId: "review-1",
        protocolRevisionId: state.protocol.activeRevisionId,
        templateRevisionId: "tpl_r1",
        status: "completed_with_issues",
        paperIds: [1],
        papers: [
          {
            paperId: 1,
            stage: "failed",
            attempts: 1,
            error: "Model output could not be parsed",
          },
        ],
        concurrency: 2,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ] as unknown as SystematicReviewState["reviewJobs"];
    assert.isTrue(hasFailedExtractionMetrics(state, 1));
  });
});

describe("Extraction no longer requires manual template approval", function () {
  const service = new SystematicReviewService({} as SystematicReviewStore);

  it("auto-activates the latest draft template when none is approved", async function () {
    const state = baseState(template("draft"));
    assert.isUndefined(state.activeExtractionTemplateId);
    try {
      await service.startReviewJob(state, "extraction", [1]);
    } catch {
      // Persisting via the stub store rejects; the auto-activation has already
      // happened synchronously before the save.
    }
    assert.equal(state.activeExtractionTemplateId, "tpl");
    assert.equal(state.extractionTemplates[0].status, "active");
  });

  it("errors clearly when no template exists at all", async function () {
    const state = baseState(template("draft"));
    state.extractionTemplates = [];
    state.activeExtractionTemplateId = undefined;
    let message = "";
    try {
      await service.startReviewJob(state, "extraction", [1]);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    assert.include(message, "Generate an extraction template");
  });
});
