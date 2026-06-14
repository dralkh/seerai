import { assert } from "chai";
import {
  deriveScreeningRecommendation,
  withReviewTimeout,
} from "../src/modules/systematicReview/paperAnalyzer";
import { ReviewCancellationController } from "../src/modules/systematicReview/cancellation";
import {
  calculateKeywordConfidence,
  modelConfidenceSchema,
  normalizeModelConfidence,
} from "../src/modules/systematicReview/modelOutput";
import { selectReviewSourceText } from "../src/modules/systematicReview/reviewSourceService";
import {
  ExtractionProposalSchema,
  normalizeExtractionMeasure,
} from "../src/modules/systematicReview/extractionWorkflow";

describe("Systematic review paper analysis lifecycle", function () {
  it("rejects a stalled source operation at the configured deadline", async function () {
    let message = "";
    try {
      await withReviewTimeout(
        new Promise<string>(() => undefined),
        10,
        "Source reading timed out",
      );
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    assert.equal(message, "Source reading timed out");
  });

  it("cancels a pending source operation", async function () {
    const controller = new ReviewCancellationController();
    const pending = withReviewTimeout(
      new Promise<string>(() => undefined),
      1000,
      "Timed out",
      controller.signal,
    );
    controller.abort();
    let message = "";
    try {
      await pending;
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    assert.equal(message, "Request was cancelled");
  });

  it("normalizes provider confidence percentages", function () {
    assert.equal(normalizeModelConfidence(95), 0.95);
    assert.equal(modelConfidenceSchema.parse("87%"), 0.87);
    assert.equal(modelConfidenceSchema.parse(0.76), 0.76);
  });

  it("rejects confidence values outside supported scales", function () {
    assert.throws(() => modelConfidenceSchema.parse(101));
    assert.throws(() => modelConfidenceSchema.parse(-1));
  });

  it("scores keyword evidence transparently and conservatively", function () {
    assert.equal(calculateKeywordConfidence(0, 0, 8, "maybe"), 0.25);
    const decisive = calculateKeywordConfidence(3, 0, 8, "included");
    const conflicting = calculateKeywordConfidence(1, 1, 8, "maybe");
    assert.isAbove(decisive, 0.75);
    assert.isBelow(conflicting, decisive);
  });

  it("derives screening decisions from explicit criterion verdicts", function () {
    const criteria = [
      { id: "population", type: "dimension" as const },
      { id: "exclude-review", type: "exclude" as const },
    ];
    assert.equal(
      deriveScreeningRecommendation(criteria, [
        { criterionId: "population", verdict: "met" },
        { criterionId: "exclude-review", verdict: "not_met" },
      ]).decision,
      "included",
    );
    assert.equal(
      deriveScreeningRecommendation(criteria, [
        { criterionId: "population", verdict: "met" },
        { criterionId: "exclude-review", verdict: "met" },
      ]).decision,
      "excluded",
    );
    assert.equal(
      deriveScreeningRecommendation(criteria, [
        { criterionId: "population", verdict: "unclear" },
        { criterionId: "exclude-review", verdict: "not_met" },
      ]).decision,
      "maybe",
    );
  });

  it("samples the beginning, middle, and end of long papers", function () {
    const source = `${"A".repeat(50000)}MIDDLE_MARKER${"B".repeat(50000)}END_MARKER`;
    const selected = selectReviewSourceText(source, 3000);
    assert.isTrue(selected.truncated);
    assert.include(selected.text, "MIDDLE_MARKER");
    assert.include(selected.text, "END_MARKER");
  });

  it("normalizes extraction measure aliases without discarding others", function () {
    assert.equal(normalizeExtractionMeasure("relative risk"), "RR");
    assert.equal(
      normalizeExtractionMeasure("Risk Difference"),
      "RISK DIFFERENCE",
    );
  });

  it("accepts mixed provider rows for independent validation", function () {
    const parsed = ExtractionProposalSchema.parse({
      extractions: [
        {
          outcomeId: "mortality",
          effectType: "RR",
          sourceQuote: "Mortality was reduced during follow-up.",
        },
        {
          outcomeId: "mortality",
          effectType: "Risk Difference",
          sourceQuote: "p=0.03",
        },
      ],
    });
    assert.lengthOf(parsed.extractions, 2);
  });
});
