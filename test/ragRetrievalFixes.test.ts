import { assert } from "chai";
import { resolveMinScore } from "../src/modules/chat/rag/vectorStore";
import {
  countTokens,
  truncateToTokenBudget,
} from "../src/modules/chat/tokenizer";
import { computeTokenBudget } from "../src/modules/chat/rag/retrievalEngine";
import { formatBulkIndexStatus } from "../src/modules/chat/rag/bulkIndexer";

describe("RAG retrieval fixes", function () {
  describe("minimum score semantics (issue #13)", function () {
    it("treats zero and negative min scores as no lower bound", function () {
      assert.strictEqual(resolveMinScore(0), -Infinity);
      assert.strictEqual(resolveMinScore(-0.5), -Infinity);
      assert.strictEqual(resolveMinScore(-Infinity), -Infinity);
    });

    it("keeps positive thresholds", function () {
      assert.strictEqual(resolveMinScore(0.3), 0.3);
      assert.strictEqual(resolveMinScore(1), 1);
    });
  });

  describe("truncateToTokenBudget (issues #12/#13)", function () {
    it("returns short text unchanged", function () {
      const text = "short context";
      assert.strictEqual(truncateToTokenBudget(text, 100), text);
    });

    it("trims long text near the token budget", function () {
      const text = Array.from(
        { length: 400 },
        (_, i) => `Paragraph ${i} with some words to count tokens.`,
      ).join("\n\n");
      const maxTokens = 200;
      const trimmed = truncateToTokenBudget(text, maxTokens);
      assert.isBelow(trimmed.length, text.length);
      assert.isAtMost(countTokens(trimmed), maxTokens + 10);
    });

    it("prefers a paragraph boundary", function () {
      const text = (
        "A complete sentence for the paragraph. ".repeat(10) + "\n\n"
      ).repeat(50);
      const trimmed = truncateToTokenBudget(text, 80);
      assert.isBelow(trimmed.length, text.length);
      assert.match(trimmed, /\.\s*$/);
    });

    it("returns empty string for non-positive budgets", function () {
      assert.strictEqual(truncateToTokenBudget("abc", 0), "");
      assert.strictEqual(truncateToTokenBudget("abc", -5), "");
    });
  });

  describe("computeTokenBudget", function () {
    it("never returns a negative content budget", function () {
      const budget = computeTokenBudget(8000, 2000, 6000, 500, 4096);
      assert.isAtLeast(budget.availableForContent, 0);
      assert.strictEqual(budget.contextLength, 8000);
    });

    it("reserves output and a safety margin", function () {
      const budget = computeTokenBudget(100000, 2000, 10000, 0, 4096);
      assert.isBelow(budget.availableForContent, 100000 - 2000 - 10000 - 4096);
      assert.isAbove(budget.availableForContent, 0);
    });
  });

  describe("bulk index status formatting (issue #14)", function () {
    it("formats indexing progress with counts", function () {
      const text = formatBulkIndexStatus({
        total: 120,
        done: 15,
        indexed: 14,
        failed: 1,
        skipped: 0,
        phase: "indexing",
        currentTitle: "A Paper",
      });
      assert.include(text, "15/120");
      assert.include(text, "1 failed");
      assert.include(text, "A Paper");
    });

    it("formats completion and cancellation", function () {
      const done = formatBulkIndexStatus({
        total: 5,
        done: 5,
        indexed: 5,
        failed: 0,
        skipped: 0,
        phase: "done",
      });
      assert.include(done, "5 indexed");

      const cancelled = formatBulkIndexStatus({
        total: 5,
        done: 3,
        indexed: 3,
        failed: 0,
        skipped: 2,
        phase: "cancelled",
      });
      assert.include(cancelled, "cancelled");
      assert.include(cancelled, "2 skipped");
    });
  });
});
