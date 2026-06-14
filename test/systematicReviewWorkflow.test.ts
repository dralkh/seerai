import { assert } from "chai";
import { createProtocolFromLegacy } from "../src/modules/systematicReview/protocol";
import { SystematicReviewService } from "../src/modules/systematicReview/service";
import { SystematicReviewStore } from "../src/modules/systematicReview/store";
import {
  ExtractionTemplate,
  SystematicReviewState,
} from "../src/modules/systematicReview/types";

function workflowState(): SystematicReviewState {
  const protocol = createProtocolFromLegacy(
    "PICO",
    { P: "Adults", I: "Treatment", C: "Control", O: "Mortality" },
    [],
    [],
    {},
  );
  const template: ExtractionTemplate = {
    id: "template-1",
    revisionId: "template-1_r1",
    protocolRevisionId: protocol.activeRevisionId,
    name: "Mortality outcomes",
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
        analysis: {
          evidence: [],
          model: "test",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      },
      {
        id: 2,
        status: "maybe",
        screeningStage: "final",
        aiStatus: "manual",
        confidence: 1,
        manualAdded: true,
      },
    ],
    extractionTemplates: [template],
    activeExtractionTemplateId: template.id,
    reviewJobs: [],
    extractions: {
      1: [
        {
          id: "ext-1",
          outcomeId: "mortality",
          outcome: "Mortality",
          effectType: "RR",
          effectSize: 0.8,
          ciLow: 0.6,
          ciHigh: 1,
          n: 100,
          events: 10,
          sourceQuote: "Ten deaths occurred among one hundred participants.",
          verificationStatus: "proposed",
        },
      ],
    },
    synthesisRuns: [],
  } as unknown as SystematicReviewState;
}

describe("Systematic review extraction workflow", function () {
  const service = new SystematicReviewService({} as SystematicReviewStore);

  it("reports readiness from final-included papers and verified outcomes", function () {
    const state = workflowState();
    let readiness = service.getSynthesisReadiness(state);
    assert.equal(readiness.included, 1);
    assert.equal(readiness.analyzed, 1);
    assert.equal(readiness.proposed, 1);
    assert.equal(readiness.complete, 0);
    service.reviewExtraction(state, 1, "ext-1", "verified");
    readiness = service.getSynthesisReadiness(state);
    assert.equal(readiness.verified, 1);
    assert.equal(readiness.complete, 1);
  });

  it("requires source-grounded valid rows before verification", function () {
    const state = workflowState();
    state.extractions[1][0].sourceQuote = undefined;
    assert.throws(
      () => service.reviewExtraction(state, 1, "ext-1", "verified"),
      "supporting quote",
    );
  });

  it("keeps partial proposals visible but incomplete for synthesis", function () {
    const state = workflowState();
    state.extractions[1][0].effectSize = undefined;
    const readiness = service.getSynthesisReadiness(state);
    assert.equal(readiness.proposed, 1);
    assert.equal(readiness.invalid, 1);
    assert.equal(readiness.complete, 0);
    assert.throws(
      () => service.reviewExtraction(state, 1, "ext-1", "verified"),
      "Effect size is required",
    );
  });

  it("creates a new editable template revision and stales synthesis", function () {
    const state = workflowState();
    state.synthesisRuns = [
      {
        id: "run-1",
        projectId: "review-1",
        protocolRevisionId: state.protocol.activeRevisionId,
        inputFingerprint: "input",
        includedPaperIds: [1],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        status: "draft",
        staleReasons: [],
        warnings: [],
        domains: [],
      },
    ];
    const updated = service.updateTemplate(state, {
      ...state.extractionTemplates[0],
      name: "Updated outcomes",
    });
    assert.equal(updated.revisionId, "template-1_r2");
    service.activateTemplate(state, updated.id);
    assert.equal(state.activeExtractionTemplateId, "template-1_r2");
    assert.equal(state.extractionTemplates[0].status, "archived");
    assert.equal(state.synthesisRuns[0].status, "stale");
  });

  it("resolves the exact template revision captured by a job", function () {
    const state = workflowState();
    const original = state.extractionTemplates[0];
    const updated = service.updateTemplate(state, {
      ...original,
      name: "Updated outcomes",
    });
    service.activateTemplate(state, updated.id);
    assert.equal(
      service.getExtractionTemplateRevision(state, original.revisionId)?.name,
      "Mortality outcomes",
    );
    assert.equal(
      service.getExtractionTemplateRevision(state, updated.revisionId)?.name,
      "Updated outcomes",
    );
  });

  it("rejects duplicate active jobs for the same papers", async function () {
    const state = workflowState();
    const now = new Date().toISOString();
    state.reviewJobs.push({
      id: "job-1",
      kind: "analysis",
      projectId: "review-1",
      protocolRevisionId: state.protocol.activeRevisionId,
      status: "running",
      paperIds: [1],
      papers: [{ paperId: 1, stage: "extracting", attempts: 1 }],
      concurrency: 2,
      createdAt: now,
      updatedAt: now,
    });
    let error = "";
    try {
      await service.startReviewJob(state, "analysis", [1]);
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    }
    assert.include(error, "already have an active job");
  });

  it("blocks project navigation while review jobs are active", function () {
    const state = workflowState();
    state.spaces = [
      { id: "review-1", name: "One" },
      { id: "review-2", name: "Two" },
    ] as SystematicReviewState["spaces"];
    state.reviewJobs.push({
      id: "job-1",
      kind: "extraction",
      projectId: "review-1",
      protocolRevisionId: state.protocol.activeRevisionId,
      templateRevisionId: "template-1_r1",
      status: "paused",
      paperIds: [1],
      papers: [{ paperId: 1, stage: "queued", attempts: 0 }],
      concurrency: 2,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    assert.throws(
      () => service.switchProject(state, "review-2"),
      "Cancel or finish active review jobs",
    );
  });
});
