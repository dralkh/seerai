import { assert } from "chai";
import {
  buildGapCsv,
  buildGapMarkdown,
  buildScopedReviewContext,
  buildSynthesisMarkdown,
  capReviewContext,
  safeFileSlug,
} from "../src/modules/systematicReview/reviewExport";
import {
  GapAnalysisRun,
  SynthesisRun,
  SystematicReviewState,
} from "../src/modules/systematicReview/types";

function gapRun(): GapAnalysisRun {
  return {
    id: "gaprun_abc",
    projectId: "review-1",
    synthesisRunId: "syn_abc",
    inputFingerprint: "fp",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
    status: "draft",
    rowDimensionKey: "population",
    columnDimensionKey: "outcome",
    warnings: ["Sparse evidence for several outcomes"],
    cells: [
      {
        id: "cell-1",
        rowKey: "population",
        rowValue: "Adults",
        columnKey: "outcome",
        columnValue: "Mortality",
        status: "no_evidence",
        domainIds: [],
        paperIds: [],
        studyCount: 0,
        rationale: "No verified evidence.",
      },
    ],
    gaps: [
      {
        id: "gap-1",
        canonicalKey: "adults|mortality|insufficient",
        // Comma + quote to exercise CSV escaping.
        title: 'No evidence: Mortality, "primary" outcome',
        severity: "high",
        reasonCode: "insufficient",
        dimensionTags: ["Adults", "Mortality"],
        description: "There is no verified evidence for this outcome.",
        implication: "Additional studies are needed.",
        domainIds: [],
        paperIds: [],
        status: "draft",
        updatedAt: "2026-01-02T00:00:00.000Z",
      },
    ],
  } as unknown as GapAnalysisRun;
}

function synthesisRun(): SynthesisRun {
  return {
    id: "syn_abc",
    projectId: "review-1",
    protocolRevisionId: "rev-1",
    inputFingerprint: "fp",
    includedPaperIds: [1, 2],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
    status: "draft",
    staleReasons: [],
    warnings: [],
    domains: [
      {
        id: "domain-1",
        key: "mortality|common_effect",
        outcome: "Mortality",
        method: "common_effect",
        status: "poolable",
        studies: [],
        paperIds: [1, 2],
        direction: "positive",
        summary: "Pooled estimate favours treatment.",
        nonPoolableReasons: [],
        methodConfirmed: false,
        grade: {
          certainty: "moderate",
          riskOfBias: 0,
          inconsistency: 0,
          indirectness: 0,
          imprecision: 0,
          publicationBias: 0,
          upgrade: 0,
          rationale: [],
        },
        narrativeConfirmed: false,
      },
    ],
  } as unknown as SynthesisRun;
}

describe("Systematic review export and scoped context", function () {
  it("builds CSV with the expected header and escaped fields", function () {
    const csv = buildGapCsv(gapRun());
    const lines = csv.split("\n");
    assert.equal(
      lines[0],
      "id,title,severity,reasonCode,status,tags,studies,description,implication",
    );
    assert.lengthOf(lines, 2);
    // Embedded double-quotes are doubled per CSV escaping.
    assert.include(lines[1], '""primary""');
    assert.include(lines[1], '"Adults; Mortality"');
  });

  it("builds Markdown including gaps and the evidence map", function () {
    const md = buildGapMarkdown(gapRun(), "Demo Review");
    assert.include(md, "# Evidence Gap Analysis — Demo Review");
    assert.include(md, "## Gaps (1)");
    assert.include(md, "**Severity:** high");
    assert.include(md, "## Evidence Map");
    assert.include(md, "| Adults | Mortality | no_evidence | 0 |");
  });

  it("builds synthesis Markdown with GRADE certainty", function () {
    const md = buildSynthesisMarkdown(synthesisRun(), "Demo Review");
    assert.include(md, "# Evidence Synthesis — Demo Review");
    assert.include(md, "## Domains (1)");
    assert.include(md, "**Certainty (GRADE):** moderate");
  });

  it("produces a filesystem-safe slug", function () {
    assert.equal(
      safeFileSlug("My Review: Diabetes/2026"),
      "My_Review_Diabetes_2026",
    );
    assert.equal(safeFileSlug(""), "review");
  });

  it("caps overly long context", function () {
    const capped = capReviewContext("x".repeat(50), 10);
    assert.isTrue(capped.startsWith("xxxxxxxxxx"));
    assert.include(capped, "truncated");
  });

  it("resolves a scoped synthesis context item by exact run id", function () {
    const state = {
      synthesisRuns: [synthesisRun()],
      gapAnalysisRuns: [gapRun()],
    } as unknown as SystematicReviewState;
    const text = buildScopedReviewContext(
      state,
      "evidence_synthesis",
      { synthesisRunId: "syn_abc" },
      "Demo Review",
    );
    assert.isString(text);
    assert.include(text as string, "# Evidence Synthesis — Demo Review");
    assert.include(text as string, "Mortality");
  });

  it("resolves a scoped gap context item by exact run id", function () {
    const state = {
      synthesisRuns: [synthesisRun()],
      gapAnalysisRuns: [gapRun()],
    } as unknown as SystematicReviewState;
    const text = buildScopedReviewContext(
      state,
      "gap_analysis",
      { gapAnalysisRunId: "gaprun_abc" },
      "Demo Review",
    );
    assert.isString(text);
    assert.include(text as string, "# Evidence Gap Analysis — Demo Review");
  });

  it("returns null when the referenced run is missing", function () {
    const state = {
      synthesisRuns: [synthesisRun()],
      gapAnalysisRuns: [gapRun()],
    } as unknown as SystematicReviewState;
    assert.isNull(
      buildScopedReviewContext(
        state,
        "gap_analysis",
        { gapAnalysisRunId: "does-not-exist" },
        "Demo Review",
      ),
    );
  });
});
