import { assert } from "chai";
import { parseSkillMarkdown } from "../src/modules/chat/skills/registry";

describe("Agent Skills registry", function () {
  it("parses standard frontmatter skills", function () {
    const skill = parseSkillMarkdown(
      [
        "---",
        "name: Paper Lookup",
        "description: Find relevant papers.",
        "tags: papers, search",
        "---",
        "# Paper Lookup",
        "Use Zotero tools.",
      ].join("\n"),
      "bundled",
    );

    assert.isNotNull(skill);
    assert.equal(skill?.id, "paper-lookup");
    assert.equal(skill?.description, "Find relevant papers.");
    assert.deepEqual(skill?.tags, ["papers", "search"]);
  });

  it("uses heading as a fallback name", function () {
    const skill = parseSkillMarkdown(
      [
        "---",
        "description: Write scientific prose.",
        "---",
        "# Scientific Writing",
        "Ground claims in evidence.",
      ].join("\n"),
      "user",
    );

    assert.isNotNull(skill);
    assert.equal(skill?.id, "scientific-writing");
    assert.equal(skill?.source, "user");
  });

  it("rejects skills without a description", function () {
    const skill = parseSkillMarkdown("# Missing Description\nBody", "custom");
    assert.isNull(skill);
  });
});
