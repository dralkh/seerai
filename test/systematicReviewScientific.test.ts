import { assert } from "chai";
import {
  fixedEffectMetaAnalysis,
  getPrismaSnapshot,
  validateExtractionRow,
} from "../src/modules/systematicReview/scientific";
import { SystematicReviewState } from "../src/modules/systematicReview/types";

describe("Systematic review scientific validation", function () {
  it("rejects confidence intervals that do not contain the estimate", function () {
    const result = validateExtractionRow({
      outcome: "Mortality",
      effectType: "RR",
      effectSize: 1.2,
      ciLow: 1.3,
      ciHigh: 1.5,
      n: 100,
      events: 10,
    });
    assert.isFalse(result.valid);
    assert.include(
      result.errors,
      "Confidence interval must contain the effect estimate",
    );
  });

  it("rejects events greater than sample size", function () {
    const result = validateExtractionRow({
      outcome: "Mortality",
      effectType: "OR",
      effectSize: 0.8,
      ciLow: 0.6,
      ciHigh: 1.1,
      n: 20,
      events: 21,
    });
    assert.isFalse(result.valid);
    assert.include(result.errors, "Events cannot exceed sample size");
  });

  it("allows partial grounded proposals but not verification", function () {
    const row = {
      outcome: "Mortality",
      effectType: "RR",
      n: 100,
      sourceQuote: "One hundred participants were randomized.",
      verificationStatus: "proposed" as const,
    };
    assert.isTrue(validateExtractionRow(row, false).valid);
    const complete = validateExtractionRow(row);
    assert.isFalse(complete.valid);
    assert.include(complete.errors, "Effect size is required");
    assert.include(
      complete.errors,
      "Both confidence interval bounds are required",
    );
    assert.include(complete.errors, "Event count is required for OR and RR");
  });

  it("does not require events for continuous outcomes", function () {
    const result = validateExtractionRow({
      outcome: "Quality of life",
      effectType: "MD",
      effectSize: 2,
      ciLow: 1,
      ciHigh: 3,
      n: 80,
    });
    assert.isTrue(result.valid);
  });

  it("pools compatible ratio measures on the log scale", function () {
    const result = fixedEffectMetaAnalysis([
      {
        outcome: "Mortality",
        effectType: "RR",
        effectSize: 0.8,
        ciLow: 0.64,
        ciHigh: 1,
        n: 100,
        events: 10,
      },
      {
        outcome: "Mortality",
        effectType: "RR",
        effectSize: 0.9,
        ciLow: 0.72,
        ciHigh: 1.125,
        n: 120,
        events: 12,
      },
    ]);
    assert.equal(result.measure, "RR");
    assert.closeTo(result.estimate, Math.sqrt(0.72), 0.001);
    assert.isBelow(result.ciLow, result.estimate);
    assert.isAbove(result.ciHigh, result.estimate);
    assert.closeTo(
      result.weights.reduce((sum, weight) => sum + weight, 0),
      1,
      0.000001,
    );
  });

  it("pools mean differences without logarithmic transformation", function () {
    const result = fixedEffectMetaAnalysis([
      {
        outcome: "Score",
        effectType: "MD",
        effectSize: -2,
        ciLow: -3,
        ciHigh: -1,
        n: 80,
        events: 0,
      },
      {
        outcome: "Score",
        effectType: "MD",
        effectSize: -1,
        ciLow: -2,
        ciHigh: 0,
        n: 90,
        events: 0,
      },
    ]);
    assert.equal(result.measure, "MD");
    assert.closeTo(result.estimate, -1.5, 0.001);
  });

  it("pools standardized mean differences without logarithmic transformation", function () {
    const result = fixedEffectMetaAnalysis([
      {
        outcome: "Score",
        effectType: "SMD",
        effectSize: -0.4,
        ciLow: -0.7,
        ciHigh: -0.1,
        n: 80,
        events: 0,
      },
      {
        outcome: "Score",
        effectType: "SMD",
        effectSize: -0.2,
        ciLow: -0.5,
        ciHigh: 0.1,
        n: 90,
        events: 0,
      },
    ]);
    assert.equal(result.measure, "SMD");
    assert.closeTo(result.estimate, -0.3, 0.001);
  });

  it("rejects incompatible effect measures", function () {
    assert.throws(
      () =>
        fixedEffectMetaAnalysis([
          {
            outcome: "Mortality",
            effectType: "RR",
            effectSize: 0.8,
            ciLow: 0.6,
            ciHigh: 1,
            n: 100,
            events: 10,
          },
          {
            outcome: "Mortality",
            effectType: "OR",
            effectSize: 0.8,
            ciLow: 0.6,
            ciHigh: 1,
            n: 100,
            events: 10,
          },
        ]),
      "Effect measures cannot be pooled together",
    );
  });

  it("marks unrecorded PRISMA stages as unknown", function () {
    const state = {
      papers: [
        {
          id: 1,
          status: "included",
          aiStatus: "manual",
          confidence: 0,
        },
        {
          id: 2,
          status: "excluded",
          aiStatus: "manual",
          confidence: 0,
        },
        {
          id: 3,
          status: "undecided",
          aiStatus: "manual",
          confidence: 0,
        },
      ],
    } as SystematicReviewState;
    const snapshot = getPrismaSnapshot(state);
    assert.equal(snapshot.identified, 3);
    assert.equal(snapshot.screened, 2);
    assert.equal(snapshot.included, 1);
    assert.equal(snapshot.excluded, 1);
    assert.isNull(snapshot.duplicates);
    assert.isFalse(snapshot.complete);
  });
});
