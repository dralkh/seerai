import { assert } from "chai";
import { buildExtractionRows } from "../src/modules/systematicReview/extractionWorkflow";
import { validateExtractionRow } from "../src/modules/systematicReview/scientific";
import {
  ExtractionRow,
  ExtractionTemplate,
} from "../src/modules/systematicReview/types";

function template(): ExtractionTemplate {
  return {
    id: "tpl",
    revisionId: "tpl_r1",
    protocolRevisionId: "rev",
    name: "Diagnostic ML template",
    instructions: "",
    outcomes: [
      {
        id: "disc",
        name: "Discriminative Performance",
        aliases: ["discrimination"],
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
        required: false,
      },
      {
        id: "hosp",
        name: "Hospital Admission",
        aliases: [],
        description: "",
        measures: ["percentage"],
        timepoints: [],
        required: true,
      },
    ],
    status: "active",
    source: "user",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

const CONTENT =
  "In the validation cohort the model achieved an AUROC of 0.91 " +
  "(95% CI 0.87-0.96). Mortality occurred in 12% of patients. " +
  "Sensitivity was 0.88 overall.";

describe("buildExtractionRows safeguards", function () {
  it("accepts diagnostic measures without warnings and grounds their quotes", function () {
    const { rows } = buildExtractionRows({
      proposals: [
        {
          outcomeId: "disc",
          effectType: "AUROC",
          effectSize: 0.91,
          ciLow: 0.87,
          ciHigh: 0.96,
          sourceQuote: "AUROC of 0.91 (95% CI 0.87-0.96)",
          confidence: 0.9,
        },
        {
          outcome: "Mortality",
          effectType: "percentage",
          effectSize: 12,
          sourceQuote: "Mortality occurred in 12% of patients",
          confidence: null,
        },
        {
          // Absence placeholder — no value, ungrounded quote, missingReason.
          outcome: "Hospital Admission",
          effectType: "",
          sourceQuote: "No data on hospital admission reported",
          missingReason: "not reported in the paper",
          confidence: null,
        },
        {
          // Fabricated quote that is not in the source.
          outcomeId: "disc",
          effectType: "AUROC",
          effectSize: 0.99,
          sourceQuote:
            "The model reached an AUROC of 0.99 in an external cohort of one million patients",
          confidence: 0.7,
        },
        {
          // Unrecognised measure but grounded quote.
          outcomeId: "disc",
          effectType: "Flux capacitance",
          effectSize: 1,
          sourceQuote: "Sensitivity was 0.88 overall",
          confidence: 0.5,
        },
      ],
      template: template(),
      content: CONTENT,
      itemId: 1,
      model: "test-model",
      jobId: "job-1",
    });

    // The absence-placeholder row is dropped silently.
    assert.equal(rows.length, 4);

    const auroc = rows.find(
      (row) => row.effectType === "AUROC" && row.effectSize === 0.91,
    )!;
    assert.equal(auroc.measureFamily, "discrimination");
    assert.isFalse(auroc.poolable);
    assert.deepEqual(auroc.issues, []);

    const mortality = rows.find((row) => row.outcomeId === "mort")!;
    assert.equal(mortality.measureFamily, "proportion");
    // null confidence must not raise invalid_confidence.
    assert.isUndefined(
      mortality.issues?.find((issue) => issue.code === "invalid_confidence"),
    );
    assert.deepEqual(mortality.issues, []);

    const fabricated = rows.find((row) => row.effectSize === 0.99)!;
    assert.isOk(
      fabricated.issues?.find(
        (issue) =>
          issue.code === "ungrounded_quote" && issue.severity === "error",
      ),
    );

    const unrecognised = rows.find(
      (row) => row.effectType === "Flux capacitance",
    )!;
    assert.isOk(unrecognised, "unrecognised measure row is retained");
    assert.isOk(
      unrecognised.issues?.find(
        (issue) =>
          issue.code === "unrecognized_measure" && issue.severity === "warning",
      ),
    );
    // A recognised-but-non-poolable measure never produces unrecognized_measure.
    assert.isUndefined(
      auroc.issues?.find((issue) => issue.code === "unrecognized_measure"),
    );
  });
});

describe("validateExtractionRow by measure family", function () {
  const base = {
    id: "r",
    outcome: "Discriminative Performance",
    verificationStatus: "proposed" as const,
  };

  it("accepts a non-poolable diagnostic row with a single value", function () {
    const row = {
      ...base,
      effectType: "AUROC",
      effectSize: 0.91,
    } as ExtractionRow;
    assert.isTrue(validateExtractionRow(row).valid);
  });

  it("still requires full effect + CI for poolable ratio measures", function () {
    const incomplete = {
      ...base,
      outcome: "Mortality",
      effectType: "RR",
      effectSize: 0.8,
    } as ExtractionRow;
    const result = validateExtractionRow(incomplete);
    assert.isFalse(result.valid);
    assert.isOk(
      result.errors.find((error) => /confidence interval/i.test(error)),
    );

    const complete = {
      ...base,
      outcome: "Mortality",
      effectType: "RR",
      effectSize: 0.8,
      ciLow: 0.6,
      ciHigh: 1.0,
      n: 100,
      events: 10,
    } as ExtractionRow;
    assert.isTrue(validateExtractionRow(complete).valid);
  });

  it("rejects an unrecognised measure", function () {
    const row = {
      ...base,
      effectType: "Flux capacitance",
      effectSize: 1,
    } as ExtractionRow;
    assert.isFalse(validateExtractionRow(row).valid);
  });
});
