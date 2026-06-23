import { assert } from "chai";
import {
  groundQuote,
  isGrounded,
  normalizeText,
} from "../src/modules/systematicReview/grounding";

// Source text deliberately uses an en-dash in the CI range, a CI comma, a
// non-breaking space, and a trailing figure reference — the exact patterns that
// broke the old exact-substring grounding.
const SOURCE =
  "The RF model (AUROC 0.91 (95% CI, 0.87–0.96)) outperformed " +
  "practicing clinicians (AUROC 0.79) (Fig. 2a). Sensitivity was 0.88 and " +
  "specificity 0.90 in the validation cohort.";
const NORMALIZED = normalizeText(SOURCE);

describe("Quote grounding", function () {
  it("normalises dashes, non-breaking spaces, and smart quotes", function () {
    assert.equal(normalizeText("0.87–0.96"), "0.87-0.96");
    assert.equal(normalizeText("AUROC 0.91"), "auroc 0.91");
    assert.equal(normalizeText("“quote”"), '"quote"');
  });

  it("grounds an exact contiguous quote", function () {
    const result = groundQuote(
      "outperformed practicing clinicians",
      NORMALIZED,
    );
    assert.isTrue(result.grounded);
    assert.equal(result.mode, "exact");
  });

  it("grounds despite en-dash vs hyphen and a dropped CI comma", function () {
    // hyphen instead of en-dash, no comma after CI, normal space.
    const result = groundQuote("AUROC 0.91 (95% CI 0.87-0.96)", NORMALIZED);
    assert.isTrue(result.grounded);
    assert.equal(result.mode, "fuzzy");
  });

  it("strips a trailing figure reference before matching", function () {
    assert.isTrue(
      isGrounded("outperformed practicing clinicians (Fig. 2a)", NORMALIZED),
    );
  });

  it("grounds an ellipsis-stitched quote segment by segment", function () {
    assert.isTrue(
      isGrounded("The RF model ... Sensitivity was 0.88", NORMALIZED),
    );
  });

  it("rejects a fabricated quote (true negative)", function () {
    const result = groundQuote(
      "The intervention reduced mortality by fifty percent across every subgroup",
      NORMALIZED,
    );
    assert.isFalse(result.grounded);
    assert.equal(result.mode, "none");
  });

  it("rejects an empty quote", function () {
    assert.isFalse(groundQuote(undefined, NORMALIZED).grounded);
    assert.isFalse(groundQuote("   ", NORMALIZED).grounded);
  });
});
