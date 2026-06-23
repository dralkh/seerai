import { assert } from "chai";
import { buildExtractionCompatibility } from "../src/modules/systematicReview/compatibility";
import { buildSynthesisRun } from "../src/modules/systematicReview/analysisEngine";
import { SystematicReviewService } from "../src/modules/systematicReview/service";
import { SystematicReviewStore } from "../src/modules/systematicReview/store";
import {
  buildReviewState,
  goldExtractions,
  reviewFixtures,
} from "./fixtures/reviews/reviewFixture";

const ratioFixture = reviewFixtures.find(
  (fixture) => fixture.id === "corticosteroids-or",
)!;
const diagnosticFixture = reviewFixtures.find(
  (fixture) => fixture.id === "dl-imaging-diagnostic",
)!;

describe("Systematic review extraction compatibility", function () {
  it("does not split synthesis domains by row-level direction or unconstrained timepoint", function () {
    const extractions = goldExtractions(ratioFixture);
    const rows = Object.values(extractions)
      .flat()
      .filter((row) => row.outcome === "28-day all-cause mortality");
    rows.forEach((row, index) => {
      row.direction = index % 2 === 0 ? "higher_better" : "lower_better";
      row.timepoint = index % 2 === 0 ? "28 days" : "28-day";
    });
    const synthesis = buildSynthesisRun(
      buildReviewState(ratioFixture, extractions),
    );
    const mortalityDomains = synthesis.domains.filter(
      (domain) =>
        domain.outcome === "28-day all-cause mortality" &&
        domain.measure === "OR",
    );
    assert.lengthOf(mortalityDomains, 1);
    assert.equal(mortalityDomains[0].status, "poolable");
    assert.isAtLeast(mortalityDomains[0].paperIds.length, 4);
  });

  it("reports incomplete poolable rows as compatibility blockers", function () {
    const extractions = goldExtractions(ratioFixture);
    const firstPaper = ratioFixture.studies[0].paperId;
    const incomplete = {
      ...extractions[firstPaper][0],
      id: "incomplete_poolable",
      ciLow: undefined,
      ciHigh: undefined,
      events: undefined,
    };
    extractions[firstPaper] = [incomplete];
    const state = buildReviewState(ratioFixture, extractions);
    const compatibility = buildExtractionCompatibility(
      state.papers,
      state.extractions,
    ).report;
    assert.equal(compatibility.incompletePoolableRows, 1);
    assert.isTrue(
      compatibility.issues.some(
        (issue) =>
          issue.rowId === "incomplete_poolable" && issue.severity === "blocker",
      ),
    );
  });

  it("excludes duplicate same-paper rows from synthesis", function () {
    const extractions = goldExtractions(ratioFixture);
    const firstPaper = ratioFixture.studies[0].paperId;
    extractions[firstPaper] = [
      extractions[firstPaper][0],
      {
        ...extractions[firstPaper][0],
        id: "duplicate_lower_quality",
        confidence: 0.1,
      },
    ];
    const synthesis = buildSynthesisRun(
      buildReviewState(ratioFixture, extractions),
    );
    assert.equal(synthesis.compatibilityReport?.duplicateRows, 1);
    assert.isTrue(
      synthesis.domains.some((domain) =>
        domain.excludedRows?.some(
          (row) => row.rowId === "duplicate_lower_quality",
        ),
      ),
    );
  });

  it("counts diagnostic rows as valid readiness without CI bounds", function () {
    const state = buildReviewState(
      diagnosticFixture,
      goldExtractions(diagnosticFixture),
    );
    const readiness = new SystematicReviewService(
      {} as SystematicReviewStore,
    ).getSynthesisReadiness(state);
    assert.equal(readiness.invalid, 0);
    assert.isAtLeast(readiness.narrativeReadyDomains, 3);
  });
});
