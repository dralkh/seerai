import { assert } from "chai";
import {
  applyProtocolCompatibility,
  createProtocolFromLegacy,
  createProtocolRevision,
  dimensionsForFramework,
  getActiveProtocolRevision,
  newEligibilityRule,
  validateProtocolRevision,
} from "../src/modules/systematicReview/protocol";
import { SystematicReviewProjectData } from "../src/modules/systematicReview/types";

describe("Systematic review protocol", function () {
  it("migrates legacy criteria with a stable framework key", function () {
    const protocol = createProtocolFromLegacy(
      "PECO",
      {
        P: "Adults",
        E: "Air pollution",
        C: "Lower exposure",
        O: "Mortality",
      },
      ["pollution"],
      ["animal"],
      { E: ["biomarker"] },
      "Does air pollution affect mortality?",
    );
    const revision = getActiveProtocolRevision(protocol);
    assert.equal(revision.framework, "PECO");
    assert.deepEqual(
      revision.dimensions.map((dimension) => dimension.key),
      ["P", "E", "C", "O"],
    );
    assert.deepEqual(
      revision.dimensions.find((dimension) => dimension.key === "E")
        ?.evidenceLabels,
      ["biomarker"],
    );
  });

  it("preserves matching values when switching to a non-PICO framework", function () {
    const dimensions = dimensionsForFramework("PCC", [
      {
        key: "P",
        label: "Population",
        description: "",
        value: "Older adults",
        keywordAids: ["aged"],
        evidenceLabels: ["cohort"],
      },
      {
        key: "Co",
        label: "Context",
        description: "",
        value: "Primary care",
        keywordAids: [],
        evidenceLabels: [],
      },
    ]);
    assert.deepEqual(
      dimensions.map((dimension) => dimension.key),
      ["P", "Ca", "Co"],
    );
    assert.equal(dimensions[0].value, "Older adults");
    assert.equal(dimensions[2].value, "Primary care");
  });

  it("validates missing rules, criteria, and duplicate dimensions", function () {
    const revision = createProtocolRevision({
      actor: "user",
      researchQuestion: "",
      framework: "PICO",
      dimensions: [
        {
          key: "P",
          label: "Population",
          description: "",
          value: "",
          keywordAids: [],
          evidenceLabels: [],
        },
        {
          key: "P",
          label: "Population duplicate",
          description: "",
          value: "Adults",
          keywordAids: [],
          evidenceLabels: [],
        },
      ],
      eligibilityRules: [],
      includeKeywordAids: [],
      excludeKeywordAids: [],
      provenance: [],
      warnings: [],
    });
    const warnings = validateProtocolRevision(revision);
    assert.include(warnings, "Research question is empty");
    assert.include(warnings, "Population criterion is empty");
    assert.include(warnings, "Duplicate dimension key: P");
    assert.include(warnings, "No explicit inclusion rules are defined");
    assert.include(warnings, "No explicit exclusion rules are defined");
  });

  it("derives legacy compatibility fields from the active revision", function () {
    const first = createProtocolRevision({
      actor: "migration",
      researchQuestion: "Question",
      framework: "SPIDER",
      dimensions: dimensionsForFramework("SPIDER"),
      eligibilityRules: [
        newEligibilityRule("include", "Qualitative research"),
        newEligibilityRule("exclude", "Editorials"),
      ],
      includeKeywordAids: ["interview"],
      excludeKeywordAids: ["editorial"],
      provenance: [],
      warnings: [],
    });
    first.dimensions[0].value = "Nurses";
    first.dimensions[0].evidenceLabels = ["cohort"];
    const data = {
      protocol: {
        activeRevisionId: first.id,
        revisions: [first],
      },
    } as SystematicReviewProjectData;
    applyProtocolCompatibility(data);
    assert.equal(data.framework, "SPIDER");
    assert.equal(data.frameworkValues.S, "Nurses");
    assert.deepEqual(data.incKeywords, ["interview"]);
    assert.deepEqual(data.picoLabelMap.S, ["cohort"]);
  });
});
