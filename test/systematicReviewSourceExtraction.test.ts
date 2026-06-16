import { assert } from "chai";
import { extractAbstractSection } from "../src/modules/systematicReview/reviewSourceService";

describe("Systematic review source extraction", function () {
  it("extracts the abstract section from a markdown note", function () {
    const note = [
      "# Notes",
      "",
      "Some commentary.",
      "",
      "## Abstract",
      "",
      "This paper investigates the effect of X on Y in a randomized trial.",
      "",
      "## Methods",
      "",
      "We recruited 200 participants.",
    ].join("\n");
    const result = extractAbstractSection(note);
    assert.isTrue(result.matched);
    assert.include(result.text, "randomized trial");
    assert.notInclude(result.text, "Methods");
  });

  it("extracts the abstract section from an HTML note", function () {
    const note =
      "<h1>Notes</h1><p>intro</p><h2>Abstract</h2><p>Findings suggest a 30% improvement.</p><h2>Results</h2><p>...</p>";
    const result = extractAbstractSection(note);
    assert.isTrue(result.matched);
    assert.include(result.text, "30% improvement");
  });

  it("matches the heading case-insensitively", function () {
    const note = "ABSTRACT\n\nThis study explores the topic in depth.";
    const result = extractAbstractSection(note);
    assert.isTrue(result.matched);
    assert.include(result.text, "explores the topic");
  });

  it("returns no match when no abstract heading is present", function () {
    const note = "This note has no abstract heading at all.";
    const result = extractAbstractSection(note);
    assert.isFalse(result.matched);
    assert.equal(result.text, "");
  });

  it("ignores very short sections", function () {
    const note = "## Abstract\n\nToo short.";
    const result = extractAbstractSection(note);
    assert.isFalse(result.matched);
  });
});
