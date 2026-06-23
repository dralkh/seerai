import { assert } from "chai";
import {
  classifyMeasure,
  isPoolableMeasure,
} from "../src/modules/systematicReview/measures";

describe("Measure taxonomy", function () {
  it("classifies ratio and continuous measures as poolable", function () {
    for (const code of ["OR", "RR", "HR"]) {
      const info = classifyMeasure(code);
      assert.equal(info.canonical, code);
      assert.equal(info.family, "ratio");
      assert.isTrue(info.poolable);
    }
    for (const code of ["MD", "SMD"]) {
      const info = classifyMeasure(code);
      assert.equal(info.family, "continuous");
      assert.isTrue(info.poolable);
    }
    assert.isTrue(isPoolableMeasure("relative risk"));
    assert.equal(classifyMeasure("relative risk").canonical, "RR");
    assert.equal(
      classifyMeasure("standardised mean difference").canonical,
      "SMD",
    );
  });

  it("recognises diagnostic/prognostic measures as valid but non-poolable", function () {
    const cases: Array<[string, string, string]> = [
      ["AUROC", "AUROC", "discrimination"],
      ["AUC", "AUROC", "discrimination"],
      ["AUC-ROC", "AUROC", "discrimination"],
      [
        "area under the receiver operating characteristic",
        "AUROC",
        "discrimination",
      ],
      ["AUPRC", "AUPRC", "discrimination"],
      ["c-statistic", "C-index", "discrimination"],
      ["Sensitivity", "Sensitivity", "diagnostic"],
      ["recall", "Sensitivity", "diagnostic"],
      ["Specificity", "Specificity", "diagnostic"],
      ["PPV", "PPV", "diagnostic"],
      ["Brier score", "Brier score", "calibration"],
      ["NRI", "NRI", "reclassification"],
      ["net reclassification index", "NRI", "reclassification"],
      ["percentage", "PERCENTAGE", "proportion"],
      ["%", "PERCENTAGE", "proportion"],
    ];
    for (const [raw, canonical, family] of cases) {
      const info = classifyMeasure(raw);
      assert.equal(info.canonical, canonical, `canonical for ${raw}`);
      assert.equal(info.family, family, `family for ${raw}`);
      assert.isFalse(info.poolable, `poolable for ${raw}`);
    }
  });

  it("distinguishes positive and negative likelihood ratios", function () {
    assert.equal(classifyMeasure("LR+").canonical, "LR+");
    assert.equal(classifyMeasure("positive likelihood ratio").canonical, "LR+");
    assert.equal(classifyMeasure("LR-").canonical, "LR-");
    assert.equal(classifyMeasure("negative likelihood ratio").canonical, "LR-");
  });

  it("falls back to 'other' for unrecognised labels without discarding them", function () {
    const info = classifyMeasure("Flux capacitance");
    assert.equal(info.family, "other");
    assert.isFalse(info.poolable);
    assert.equal(info.canonical, "Flux capacitance");
    // Risk difference is a real but unsupported measure — preserved, not mapped.
    assert.equal(classifyMeasure("Risk Difference").family, "other");
  });

  it("treats empty input as unspecified/other", function () {
    const info = classifyMeasure("");
    assert.equal(info.family, "other");
    assert.isFalse(info.poolable);
  });
});
