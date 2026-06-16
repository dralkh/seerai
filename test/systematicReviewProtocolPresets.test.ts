import { assert } from "chai";
import {
  applyProtocolPreset,
  parseProtocolPresetJson,
  protocolPresetToJson,
  revisionToProtocolPreset,
} from "../src/modules/systematicReview/protocolPresets";
import { createProtocolRevision } from "../src/modules/systematicReview/protocol";

describe("Systematic review protocol presets", function () {
  it("applies a preset without retaining model provenance", function () {
    const revision = createProtocolRevision({
      actor: "model",
      researchQuestion: "Old question",
      framework: "PICO",
      dimensions: [],
      eligibilityRules: [],
      includeKeywordAids: [],
      excludeKeywordAids: [],
      provenance: [{ field: "P", source: "document" }],
      warnings: [],
    });
    const applied = applyProtocolPreset(revision, {
      id: "preset_1",
      name: "Qualitative",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      researchQuestion: "How do nurses experience remote care?",
      framework: "SPIDER",
      dimensions: [
        {
          key: "S",
          label: "Sample",
          description: "Sample population",
          value: "Nurses",
          keywordAids: ["nurse"],
          evidenceLabels: ["cohort"],
        },
      ],
      eligibilityRules: [],
      includeKeywordAids: ["interview"],
      excludeKeywordAids: ["editorial"],
    });
    assert.equal(applied.framework, "SPIDER");
    assert.equal(
      applied.researchQuestion,
      "How do nurses experience remote care?",
    );
    assert.deepEqual(applied.provenance, []);
    assert.notStrictEqual(applied.dimensions, revision.dimensions);
  });

  it("round-trips a protocol revision through preset JSON", function () {
    const revision = createProtocolRevision({
      actor: "user",
      researchQuestion: "Effect of X on Y",
      framework: "PICO",
      dimensions: [
        {
          key: "P",
          label: "Population",
          description: "Patients",
          value: "Adults",
          keywordAids: ["adult"],
          evidenceLabels: ["rct"],
        },
      ],
      eligibilityRules: [],
      includeKeywordAids: ["trial"],
      excludeKeywordAids: ["protocol"],
      provenance: [],
      warnings: [],
    });
    const preset = revisionToProtocolPreset(revision, "X on Y");
    const json = protocolPresetToJson(preset);
    const parsed = parseProtocolPresetJson(json);
    assert.equal(parsed.name, "X on Y");
    assert.equal(parsed.framework, "PICO");
    assert.equal(parsed.researchQuestion, "Effect of X on Y");
    assert.equal(parsed.dimensions.length, 1);
    assert.equal(parsed.dimensions[0].value, "Adults");
  });
});
