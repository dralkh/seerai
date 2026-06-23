import { assert } from "chai";
import {
  gapCoversOutcome,
  goldExtractions,
  normalizeOutcomeName,
  reviewFixtures,
  runPipeline,
} from "./fixtures/reviews/reviewFixture";
import { classifyMeasure } from "../src/modules/systematicReview/measures";
import { validateExtractionRow } from "../src/modules/systematicReview/scientific";
import { SynthesisDomainResult } from "../src/modules/systematicReview/types";

function findDomain(
  domains: SynthesisDomainResult[],
  outcome: string,
  measure: string,
): SynthesisDomainResult | undefined {
  const wantOutcome = normalizeOutcomeName(outcome);
  const wantMeasure = classifyMeasure(measure).canonical;
  return domains.find(
    (domain) =>
      normalizeOutcomeName(domain.outcome) === wantOutcome &&
      domain.measure === wantMeasure,
  );
}

describe("Systematic review pipeline (gold extractions -> synthesis -> gap)", function () {
  it("has well-formed, recognised, complete gold extraction rows", function () {
    for (const fixture of reviewFixtures) {
      const extractions = goldExtractions(fixture);
      for (const rows of Object.values(extractions)) {
        for (const row of rows) {
          assert.notEqual(
            classifyMeasure(row.effectType).family,
            "other",
            `${fixture.id}: measure ${row.effectType} should be recognised by the taxonomy`,
          );
          const validation = validateExtractionRow(row);
          assert.isTrue(
            validation.valid,
            `${fixture.id}: gold row for "${row.outcome}" (${row.effectType}) should validate: ${validation.errors.join("; ")}`,
          );
        }
      }
    }
  });

  it("produces the expected synthesis domains", function () {
    for (const fixture of reviewFixtures) {
      const { synthesis } = runPipeline(fixture, goldExtractions(fixture));
      assert.isAbove(
        synthesis.domains.length,
        0,
        `${fixture.id}: synthesis should produce at least one domain`,
      );

      for (const gold of fixture.gold.synthesis) {
        const domain = findDomain(
          synthesis.domains,
          gold.outcome,
          gold.measure,
        );
        assert.exists(
          domain,
          `${fixture.id}: expected a "${gold.outcome}" (${gold.measure}) domain`,
        );
        if (!domain) continue;
        assert.equal(domain.method, gold.method, `${fixture.id}: method`);
        assert.equal(domain.status, gold.status, `${fixture.id}: status`);
        assert.equal(
          domain.direction,
          gold.direction,
          `${fixture.id}: direction`,
        );
        assert.isAtLeast(
          domain.paperIds.length,
          gold.minStudies,
          `${fixture.id}: contributing studies`,
        );
        if (gold.estimate) {
          assert.exists(
            domain.randomEffects,
            `${fixture.id}: ${gold.outcome} should have a random-effects estimate`,
          );
          assert.closeTo(
            domain.randomEffects!.estimate,
            gold.estimate.value,
            gold.estimate.tolerance,
            `${fixture.id}: pooled estimate`,
          );
        }
        if (gold.i2Max !== undefined && domain.randomEffects) {
          assert.isAtMost(
            domain.randomEffects.i2,
            gold.i2Max,
            `${fixture.id}: heterogeneity I^2`,
          );
        }
      }
    }
  });

  it("classifies non-poolable outcomes as narrative", function () {
    for (const fixture of reviewFixtures) {
      const { synthesis } = runPipeline(fixture, goldExtractions(fixture));
      for (const name of fixture.gold.narrativeOutcomes) {
        const matches = synthesis.domains.filter(
          (domain) =>
            normalizeOutcomeName(domain.outcome) === normalizeOutcomeName(name),
        );
        assert.isAbove(
          matches.length,
          0,
          `${fixture.id}: expected a narrative domain for "${name}"`,
        );
        for (const domain of matches) {
          assert.notEqual(
            domain.status,
            "poolable",
            `${fixture.id}: "${name}" should not be pooled`,
          );
        }
      }
    }
  });

  it("flags the expected research gaps and clears adequate outcomes", function () {
    for (const fixture of reviewFixtures) {
      const { gap } = runPipeline(fixture, goldExtractions(fixture));
      assert.isAbove(
        gap.cells.length,
        0,
        `${fixture.id}: gap analysis should produce cells`,
      );

      for (const name of fixture.gold.gaps.expectGapOutcomes) {
        assert.isTrue(
          gap.gaps.some((candidate) => gapCoversOutcome(candidate, name)),
          `${fixture.id}: expected a gap candidate covering "${name}"`,
        );
      }
      for (const name of fixture.gold.gaps.expectAdequateOutcomes) {
        assert.isFalse(
          gap.gaps.some((candidate) => gapCoversOutcome(candidate, name)),
          `${fixture.id}: "${name}" is adequately covered and should not be flagged as a gap`,
        );
      }
    }
  });
});
