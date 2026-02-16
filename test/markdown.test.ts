import { assert } from "chai";
import { parseMarkdown, balanceTags } from "../src/modules/chat/markdown";

describe("Markdown Parser Robustness", function () {
  // Direct test of balanceTags since it's the core fix
  describe("balanceTags", function () {
    it("should close single unclosed tag", function () {
      const input = "<div>text";
      const output = balanceTags(input);
      assert.equal(output, "<div>text</div>");
    });

    it("should close nested unclosed tags", function () {
      const input = "<div><span>text";
      const output = balanceTags(input);
      assert.equal(output, "<div><span>text</span></div>");
    });

    it("should fix interleaved tags (XHTML validity)", function () {
      // Case where inner tag is not closed before outer tag closes
      const input = "<strong><em>text</strong>";
      const output = balanceTags(input);
      // Expect inner tag to be auto-closed before outer tag
      assert.equal(output, "<strong><em>text</em></strong>");
    });

    it("should handle self-closing tags correctly", function () {
      const input = "<div>text<br>more</div>";
      const output = balanceTags(input);
      assert.equal(output, "<div>text<br>more</div>");
    });

    it("should handle already balanced tags", function () {
      const input = "<div>text</div>";
      const output = balanceTags(input);
      assert.equal(output, "<div>text</div>");
    });

    it("should ignore orphaned closing tags", function () {
      const input = "text</div>";
      const output = balanceTags(input);
      assert.equal(output, "text");
    });

    it("should handle attributes", function () {
      const input = '<div class="foo">text';
      const output = balanceTags(input);
      assert.equal(output, '<div class="foo">text</div>');
    });
  });

  // Integration test with parseMarkdown
  describe("parseMarkdown", function () {
    it("should ensure valid table structure output", function () {
      const input = "| Header |\n| --- |\n| Cell |";
      const output = parseMarkdown(input);
      // balanceTags should ensure the output is well-formed
      assert.isTrue(output.startsWith("<div"), "Start with container");
      assert.include(output, "</table>");
      // Check for balanced tags
      const openDivs = (output.match(/<div/g) || []).length;
      const closeDivs = (output.match(/<\/div>/g) || []).length;
      assert.equal(openDivs, closeDivs, "Div tags should be balanced");
    });
  });
});
