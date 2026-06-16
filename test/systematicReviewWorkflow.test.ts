import { assert } from "chai";
import {
  getPapersWithFailedExtractions,
  hasFailedExtractionMetrics,
} from "../src/modules/systematicReview/extractionHealth";
import { createProtocolFromLegacy } from "../src/modules/systematicReview/protocol";
import { SystematicReviewService } from "../src/modules/systematicReview/service";
import { SystematicReviewStore } from "../src/modules/systematicReview/store";
import {
  ExtractionTemplate,
  SystematicReviewState,
} from "../src/modules/systematicReview/types";
import {
  runProtocolGeneration,
  type ExtractedDocument,
} from "../src/modules/systematicReview/documentAnalyzer";
import { generateSourceLabel } from "../src/modules/systematicReview/utils";

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

  it("auto-verifies valid proposed rows across included papers", function () {
    const state = workflowState();
    const result = service.autoVerifyValidProposals(state);
    assert.equal(result.verifiedRows, 1);
    assert.equal(result.papers, 1);
    assert.equal(state.extractions[1][0].verificationStatus, "verified");
    assert.isAtLeast(state.extractions[1][0].revision || 0, 2);
  });

  it("skips proposed rows with blocking issues during auto-verify", function () {
    const state = workflowState();
    state.extractions[1][0].issues = [
      { code: "bad", severity: "error", message: "Effect size missing" },
    ];
    const result = service.autoVerifyValidProposals(state);
    assert.equal(result.verifiedRows, 0);
    assert.equal(state.extractions[1][0].verificationStatus, "proposed");
  });

  it("skips proposed rows lacking a source quote during auto-verify", function () {
    const state = workflowState();
    state.extractions[1][0].sourceQuote = "";
    const result = service.autoVerifyValidProposals(state);
    assert.equal(result.verifiedRows, 0);
    assert.equal(state.extractions[1][0].verificationStatus, "proposed");
  });

  it("auto-verifies only the requested paper IDs", function () {
    const state = workflowState();
    state.papers.push({
      id: 3,
      status: "included",
      screeningStage: "final",
      aiStatus: "manual",
      confidence: 1,
      manualAdded: true,
    });
    state.extractions[3] = [
      {
        id: "ext-3",
        outcomeId: "mortality",
        outcome: "Mortality",
        effectType: "RR",
        effectSize: 0.5,
        ciLow: 0.3,
        ciHigh: 0.8,
        n: 50,
        events: 5,
        sourceQuote: "Five events among fifty participants.",
        verificationStatus: "proposed",
      },
    ];
    const result = service.autoVerifyValidProposals(state, [3]);
    assert.equal(result.verifiedRows, 1);
    assert.equal(result.papers, 1);
    assert.equal(state.extractions[1][0].verificationStatus, "proposed");
    assert.equal(state.extractions[3][0].verificationStatus, "verified");
  });

  it("treats papers with a failed extraction job as needing retry", function () {
    const state = workflowState();
    assert.isFalse(hasFailedExtractionMetrics(state, 1));
    const now = "2026-01-01T00:00:00.000Z";
    state.reviewJobs = [
      {
        id: "job-1",
        kind: "extraction",
        projectId: "review-1",
        protocolRevisionId: state.protocol.activeRevisionId,
        templateRevisionId: "template-1_r1",
        status: "completed_with_issues",
        paperIds: [1],
        papers: [
          {
            paperId: 1,
            stage: "failed",
            attempts: 1,
            error: "Model output could not be parsed",
            startedAt: now,
          },
        ],
        concurrency: 2,
        createdAt: now,
        updatedAt: now,
      },
    ];
    assert.isTrue(hasFailedExtractionMetrics(state, 1));
    assert.deepEqual(getPapersWithFailedExtractions(state), [1]);
  });

  it("runs all four protocol-generation steps and aggregates errors", async function () {
    const protocol = createProtocolFromLegacy(
      "PICO",
      { P: "Adults", I: "Treatment", C: "Control", O: "Mortality" },
      [],
      [],
      {},
    );
    const documents: ExtractedDocument[] = [
      {
        fileName: "doc.txt",
        text: "Sample document text.",
        charCount: 24,
      },
    ];
    const baselineTemplate: ExtractionTemplate = {
      id: "template-1",
      revisionId: "template-1_r1",
      protocolRevisionId: protocol.activeRevisionId,
      name: "Baseline",
      instructions: "",
      outcomes: [
        {
          id: "outcome-1",
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
    const failingLlm = async () => {
      throw new Error("model offline");
    };
    const result = await runProtocolGeneration({
      documents,
      baselineRevision: protocol.revisions[protocol.revisions.length - 1],
      baselineTemplate,
      labelDefs: [],
      space: { protocol },
      options: { llm: failingLlm },
    });
    assert.isDefined(result.scope);
    assert.isDefined(result.eligibility);
    assert.isDefined(result.mapping);
    assert.isDefined(result.template);
    assert.include(result.errors.scope || "", "model offline");
    assert.include(result.errors.eligibility || "", "model offline");
    assert.include(result.errors.mapping || "", "model offline");
    assert.include(result.errors.template || "", "model offline");
  });

  it("adds multiple papers with a generated source label", function () {
    const state = workflowState();
    const added = service.addPapers(state, [100, 101, 102]);
    assert.equal(added.length, 3);
    assert.isUndefined(added[0].sourceLabel);
  });

  it("sets the source label on newly added papers", function () {
    const state = workflowState();
    const added = service.addPapers(state, [200, 201], "swift-river");
    assert.equal(added.length, 2);
    assert.equal(added[0].sourceLabel, "swift-river");
    assert.equal(added[1].sourceLabel, "swift-river");
  });

  it("does not overwrite an existing paper's source label", function () {
    const state = workflowState();
    state.papers.push({
      id: 300,
      status: "undecided",
      aiStatus: "manual",
      confidence: 0,
      manualAdded: true,
      sourceLabel: "original-label",
    });
    service.addPapers(state, [300, 301], "new-label");
    const existing = state.papers.find((p) => p.id === 300);
    const newPaper = state.papers.find((p) => p.id === 301);
    assert.equal(existing?.sourceLabel, "original-label");
    assert.equal(newPaper?.sourceLabel, "new-label");
  });

  it("generates a two-word source label", function () {
    const label = generateSourceLabel();
    assert.match(label, /^[a-z]+-[a-z]+$/);
  });

  it("sets the source type on every manual paper with a given label", function () {
    const state = workflowState();
    service.addPapers(state, [400, 401, 402], "manual-batch");
    const updated = service.setManualSourceType(
      state,
      "manual-batch",
      "Database",
    );
    assert.equal(updated, 3);
    const papers = state.papers.filter((p) => p.sourceLabel === "manual-batch");
    assert.equal(papers.length, 3);
    assert.equal(papers[0].sourceType, "Database");
  });

  it("does not set source type on folder-linked papers", function () {
    const state = workflowState();
    state.papers.push({
      id: 500,
      status: "undecided",
      aiStatus: "manual",
      confidence: 0,
      manualAdded: false,
      folderId: "col_db",
      sourceLabel: "pubmed",
    });
    state.papers.push({
      id: 501,
      status: "undecided",
      aiStatus: "manual",
      confidence: 0,
      manualAdded: true,
      sourceLabel: "pubmed",
    });
    const updated = service.setManualSourceType(state, "pubmed", "Register");
    assert.equal(updated, 1);
    const folderPaper = state.papers.find((p) => p.id === 500);
    const manualPaper = state.papers.find((p) => p.id === 501);
    assert.isUndefined(folderPaper?.sourceType);
    assert.equal(manualPaper?.sourceType, "Register");
  });

  it("clears the source type when passed undefined", function () {
    const state = workflowState();
    service.addPapers(state, [600, 601], "manual-batch");
    service.setManualSourceType(state, "manual-batch", "Database");
    const updated = service.setManualSourceType(
      state,
      "manual-batch",
      undefined,
    );
    assert.equal(updated, 2);
    const papers = state.papers.filter((p) => p.sourceLabel === "manual-batch");
    assert.isUndefined(papers[0].sourceType);
  });

  it("adds a draft extraction template proposal", function () {
    const state = workflowState();
    const proposal: ExtractionTemplate = {
      id: "template-new",
      revisionId: "template-new_r1",
      protocolRevisionId: state.protocol.activeRevisionId,
      name: "Generated",
      instructions: "",
      outcomes: [
        {
          id: "outcome_new",
          name: "Pain",
          aliases: [],
          description: "",
          measures: ["MD"],
          timepoints: [],
          required: true,
        },
      ],
      status: "draft",
      source: "model",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const added = service.addExtractionTemplateProposal(state, proposal);
    assert.equal(added.status, "draft");
    const drafts = state.extractionTemplates.filter(
      (template) => template.status === "draft",
    );
    assert.equal(drafts.length, 1);
    assert.equal(drafts[0].name, "Generated");
    const active = state.extractionTemplates.find(
      (template) => template.status === "active",
    );
    assert.isDefined(active);
  });
});
