import { assert } from "chai";
import { resolveMinScore } from "../src/modules/chat/rag/vectorStore";
import {
  countTokens,
  truncateToTokenBudget,
} from "../src/modules/chat/tokenizer";
import {
  computeTokenBudget,
  contextSafetyMargin,
  fitContextToModelWindow,
} from "../src/modules/chat/rag/retrievalEngine";
import { formatBulkIndexStatus } from "../src/modules/chat/rag/bulkIndexer";
import { isIndexableAttachmentContentType } from "../src/modules/chat/rag/itemSources";
import {
  SemanticSearchParamsSchema,
  SearchSimilarParamsSchema,
} from "../src/modules/chat/tools/schemas";

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

    it("actually respects the budget when token density varies", function () {
      // Dense CJK prefix followed by sparse English: a single length-ratio cut
      // overshoots badly because the prefix is far denser than the average.
      const text = "漢字".repeat(1000) + " a".repeat(10000);
      const budget = 200;
      const trimmed = truncateToTokenBudget(text, budget);
      assert.isAtMost(
        countTokens(trimmed),
        budget,
        "trimmed text must fit the requested token budget",
      );
      assert.isAbove(trimmed.length, 0);
    });

    it("stays within budget for several densities", function () {
      const samples = [
        "word ".repeat(5000),
        "字".repeat(3000) + "word ".repeat(3000),
        "word ".repeat(3000) + "字".repeat(3000),
      ];
      for (const budget of [50, 200, 1000]) {
        for (const sample of samples) {
          const trimmed = truncateToTokenBudget(sample, budget);
          assert.isAtMost(
            countTokens(trimmed),
            budget,
            `budget=${budget} sample=${sample.substring(0, 12)}`,
          );
        }
      }
    });
  });

  describe("contextSafetyMargin", function () {
    it("is shared by budgeting and pre-flight (10%)", function () {
      assert.strictEqual(contextSafetyMargin(128000), 12800);
      const budget = computeTokenBudget(100000, 2000, 10000, 0, 4096);
      assert.strictEqual(budget.safetyMargin, 10000);
    });
  });

  describe("fitContextToModelWindow (issues #12/#13)", function () {
    it("trims an over-sized raw context to fit a medium model window", function () {
      const context = "paragraph with several words. ".repeat(8000);
      const fitted = fitContextToModelWindow({
        context,
        contextLength: 32768,
        reservedOutputTokens: 4096,
        historyTokens: 2000,
        userMessageTokens: 100,
      });
      assert.isTrue(fitted.truncated);
      assert.isAtMost(countTokens(fitted.context), fitted.budget);
      assert.isAtMost(
        fitted.budget + 4096 + contextSafetyMargin(32768) + 2000 + 5000 + 100,
        32768,
        "all reservations together must fit the model window",
      );
    });

    it("keeps a context that already fits untouched", function () {
      const context = "short context";
      const fitted = fitContextToModelWindow({
        context,
        contextLength: 128000,
        reservedOutputTokens: 4096,
        historyTokens: 0,
        userMessageTokens: 10,
      });
      assert.isFalse(fitted.truncated);
      assert.strictEqual(fitted.context, context);
    });

    it("caps history at 20% so long chats don't zero out the content budget", function () {
      const fitted = fitContextToModelWindow({
        context: "context",
        contextLength: 128000,
        reservedOutputTokens: 4096,
        historyTokens: 1_000_000,
        userMessageTokens: 100,
      });
      assert.isAtLeast(fitted.budget, 128000 * 0.5);
    });

    it("still trims retrieved context that exceeds the budget", function () {
      const fitted = fitContextToModelWindow({
        context: "passage text. ".repeat(20000),
        contextLength: 16384,
        reservedOutputTokens: 2048,
        historyTokens: 500,
        userMessageTokens: 50,
      });
      assert.isTrue(fitted.truncated);
      assert.isAtMost(countTokens(fitted.context), fitted.budget);
    });
  });

  describe("tool min_score schema (issue #13)", function () {
    it("does not inject a default min_score", function () {
      const semantic = SemanticSearchParamsSchema.parse({
        query: "test",
        scope: "library",
      });
      assert.notProperty(
        semantic,
        "min_score",
        "omitting min_score must reach the handler as undefined so the configured score applies",
      );

      const similar = SearchSimilarParamsSchema.parse({ item_id: 1 });
      assert.notProperty(similar, "min_score");
    });

    it("keeps explicit values, including 0", function () {
      assert.equal(
        SemanticSearchParamsSchema.parse({
          query: "test",
          scope: "library",
          min_score: 0,
        }).min_score,
        0,
      );
      assert.equal(
        SearchSimilarParamsSchema.parse({ item_id: 1, min_score: 75 })
          .min_score,
        75,
      );
    });
  });

  describe("indexable attachment content types", function () {
    it("accepts PDFs and text, rejects everything else", function () {
      assert.isTrue(isIndexableAttachmentContentType("application/pdf"));
      assert.isTrue(isIndexableAttachmentContentType("text/plain"));
      assert.isTrue(isIndexableAttachmentContentType("text/html"));
      assert.isFalse(isIndexableAttachmentContentType("image/png"));
      assert.isFalse(isIndexableAttachmentContentType("application/epub+zip"));
      assert.isFalse(isIndexableAttachmentContentType(undefined));
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
