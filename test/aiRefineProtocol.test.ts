import { assert } from "chai";
import { parseSearchQueryIR } from "../src/modules/search/queryIR";
import {
  compileQuery,
  compileQueriesForProviders,
} from "../src/modules/search/queryCompiler";
import { SMART_MODE_PROVIDERS } from "../src/modules/search/types";
import {
  SearchStrategyStepSchema,
  normalizeStrategyIR,
} from "../src/modules/systematicReview/documentAnalyzer";

describe("AI refine and protocol generation", function () {
  // ───────────────────────────────────────────────────────────────
  // 1. parseSearchQueryIR — robustness against real LLM output
  // ───────────────────────────────────────────────────────────────

  describe("parseSearchQueryIR", function () {
    it("parses a clean JSON response", function () {
      const ir = parseSearchQueryIR(
        `{"groups":[{"terms":["artificial intelligence","AI","machine learning"]},{"terms":["kidney disease","renal disease"],"mesh":["Kidney Diseases"]}],"field":"all"}`,
      );
      assert.isNotNull(ir);
      assert.equal(ir!.groups.length, 2);
      assert.deepEqual(ir!.groups[0].terms, [
        "artificial intelligence",
        "AI",
        "machine learning",
      ]);
      assert.deepEqual(ir!.groups[1].mesh, ["Kidney Diseases"]);
      assert.equal(ir!.field, "all");
    });

    it("parses a fenced markdown response", function () {
      const ir = parseSearchQueryIR(
        'Here is the structured query:\n```json\n{"groups":[{"terms":["covid-19","SARS-CoV-2"]}]}\n```\nLet me know if you need changes.',
      );
      assert.isNotNull(ir);
      assert.equal(ir!.groups.length, 1);
      assert.deepEqual(ir!.groups[0].terms, ["covid-19", "SARS-CoV-2"]);
    });

    it("parses JSON embedded in prose", function () {
      const ir = parseSearchQueryIR(
        'I analyzed your query. The result is: {"groups":[{"terms":["vaccine efficacy"]},{"terms":["COVID-19"]}]} Hope this helps!',
      );
      assert.isNotNull(ir);
      assert.equal(ir!.groups.length, 2);
    });

    it("returns null for empty input", function () {
      assert.isNull(parseSearchQueryIR(""));
      assert.isNull(parseSearchQueryIR("   "));
      assert.isNull(parseSearchQueryIR("not json at all"));
    });

    it("returns null when no groups", function () {
      assert.isNull(parseSearchQueryIR('{"groups":[]}'));
      assert.isNull(parseSearchQueryIR('{"exclude":["animal"]}'));
    });

    it("returns null for non-object JSON", function () {
      assert.isNull(parseSearchQueryIR("[1,2,3]"));
      assert.isNull(parseSearchQueryIR('"hello"'));
      assert.isNull(parseSearchQueryIR("42"));
    });

    it("filters out groups with empty terms", function () {
      const ir = parseSearchQueryIR(
        `{"groups":[{"terms":["valid"]},{"terms":[]},{"terms":["  "]},{"terms":["also valid"]}]}`,
      );
      assert.isNotNull(ir);
      assert.equal(ir!.groups.length, 2);
      assert.deepEqual(ir!.groups[0].terms, ["valid"]);
      assert.deepEqual(ir!.groups[1].terms, ["also valid"]);
    });

    it("preserves exclude and field when valid", function () {
      const ir = parseSearchQueryIR(
        `{"groups":[{"terms":["test"]}],"exclude":["animal","in vitro"],"field":"title"}`,
      );
      assert.isNotNull(ir);
      assert.deepEqual(ir!.exclude, ["animal", "in vitro"]);
      assert.equal(ir!.field, "title");
    });

    it("drops invalid field values", function () {
      const ir = parseSearchQueryIR(
        `{"groups":[{"terms":["test"]}],"field":"everything"}`,
      );
      assert.isNotNull(ir);
      assert.isUndefined(ir!.field);
    });
  });

  // ───────────────────────────────────────────────────────────────
  // 2. compileQuery — per-provider compilation correctness
  // ───────────────────────────────────────────────────────────────

  describe("compileQuery", function () {
    let ir: ReturnType<typeof parseSearchQueryIR>;

    before(function () {
      ir = parseSearchQueryIR(
        `{"groups":[{"terms":["AI","artificial intelligence"]},{"terms":["kidney disease","renal disease"],"mesh":["Kidney Diseases"]}],"exclude":["animal"],"field":"all"}`,
      );
    });

    it("compiles for semantic-scholar", function () {
      const q = compileQuery(ir!, "semantic-scholar");
      assert.isString(q);
      assert.include(q.toLowerCase(), "ai");
      assert.match(q, /kidney disease/i);
    });

    it("compiles for pubmed", function () {
      const q = compileQuery(ir!, "pubmed");
      assert.isString(q);
      assert.include(q, "Kidney Diseases");
    });

    it("compiles for arxiv", function () {
      const q = compileQuery(ir!, "arxiv");
      assert.isString(q);
      assert.isAbove(q.length, 0);
    });

    it("compiles for all broad-mode providers", function () {
      const providers = SMART_MODE_PROVIDERS.broad;
      const queries = compileQueriesForProviders(ir!, providers);
      for (const p of providers) {
        assert.isString(queries[p]);
        assert.isAbove(queries[p].length, 0, `${p} query should not be empty`);
      }
    });

    it("handles a single-group IR", function () {
      const single = parseSearchQueryIR(
        `{"groups":[{"terms":["cryptography"]}]}`,
      )!;
      const q = compileQuery(single, "iacr");
      assert.isString(q);
      assert.isAbove(q.length, 0);
    });
  });

  // ───────────────────────────────────────────────────────────────
  // 3. SearchStrategyStepSchema — lenient validation
  // ───────────────────────────────────────────────────────────────

  describe("SearchStrategyStepSchema", function () {
    it("parses a valid response", function () {
      const parsed = SearchStrategyStepSchema.parse({
        groups: [
          {
            terms: ["AI", "machine learning"],
            mesh: ["Artificial Intelligence"],
          },
        ],
        recommendedMode: "biomedical",
        rationale: "Clinical question about AI diagnosis",
        field: "all",
      });
      assert.equal(parsed.recommendedMode, "biomedical");
      assert.equal(parsed.field, "all");
      assert.equal(parsed.groups.length, 1);
    });

    it("defaults recommendedMode to broad for unknown values", function () {
      const parsed = SearchStrategyStepSchema.parse({
        groups: [{ terms: ["quantum computing"] }],
        recommendedMode: "medical",
      });
      assert.equal(parsed.recommendedMode, "broad");
    });

    it("defaults field to all for unknown values", function () {
      const parsed = SearchStrategyStepSchema.parse({
        groups: [{ terms: ["test"] }],
        recommendedMode: "broad",
        field: "everything",
      });
      assert.equal(parsed.field, "all");
    });

    it("accepts missing field", function () {
      const parsed = SearchStrategyStepSchema.parse({
        groups: [{ terms: ["test"] }],
        recommendedMode: "preprints",
      });
      assert.isUndefined(parsed.field);
    });

    it("accepts missing rationale", function () {
      const parsed = SearchStrategyStepSchema.parse({
        groups: [{ terms: ["test"] }],
        recommendedMode: "broad",
      });
      assert.isUndefined(parsed.rationale);
    });

    it("accepts missing mesh and phrase", function () {
      const parsed = SearchStrategyStepSchema.parse({
        groups: [{ terms: ["test"] }],
        recommendedMode: "broad",
      });
      assert.isUndefined(parsed.groups[0].mesh);
      assert.isUndefined(parsed.groups[0].phrase);
    });

    it("rejects empty groups array", function () {
      assert.throws(() =>
        SearchStrategyStepSchema.parse({
          groups: [],
          recommendedMode: "broad",
        }),
      );
    });

    it("rejects missing groups", function () {
      assert.throws(() =>
        SearchStrategyStepSchema.parse({
          recommendedMode: "broad",
        }),
      );
    });

    it("defaults missing recommendedMode to broad", function () {
      const parsed = SearchStrategyStepSchema.parse({
        groups: [{ terms: ["test"] }],
      });
      assert.equal(parsed.recommendedMode, "broad");
    });

    it("accepts groups with empty terms (normalizer filters them)", function () {
      const parsed = SearchStrategyStepSchema.parse({
        groups: [{ terms: [] }, { terms: ["valid"] }],
        recommendedMode: "broad",
      });
      assert.equal(parsed.groups.length, 2);
    });
  });

  // ───────────────────────────────────────────────────────────────
  // 4. normalizeStrategyIR — edge cases
  // ───────────────────────────────────────────────────────────────

  describe("normalizeStrategyIR", function () {
    it("trims terms and filters empty ones", function () {
      const groups = normalizeStrategyIR([
        { terms: ["  valid  ", "", "  also valid  "] },
      ]);
      assert.equal(groups.length, 1);
      assert.deepEqual(groups[0].terms, ["valid", "also valid"]);
    });

    it("removes groups with no valid terms", function () {
      const groups = normalizeStrategyIR([
        { terms: ["", "  "] },
        { terms: ["valid"] },
        { terms: [] },
      ]);
      assert.equal(groups.length, 1);
      assert.deepEqual(groups[0].terms, ["valid"]);
    });

    it("preserves mesh when non-empty", function () {
      const groups = normalizeStrategyIR([
        { terms: ["test"], mesh: ["  MeSH Term  ", ""] },
      ]);
      assert.deepEqual(groups[0].mesh, ["MeSH Term"]);
    });

    it("drops empty mesh arrays", function () {
      const groups = normalizeStrategyIR([
        { terms: ["test"], mesh: ["", "  "] },
      ]);
      assert.isUndefined(groups[0].mesh);
    });

    it("preserves phrase flag when true", function () {
      const groups = normalizeStrategyIR([
        { terms: ["machine learning"], phrase: true },
      ]);
      assert.isTrue(groups[0].phrase);
    });

    it("drops phrase flag when false", function () {
      const groups = normalizeStrategyIR([{ terms: ["test"], phrase: false }]);
      assert.isUndefined(groups[0].phrase);
    });
  });

  // ───────────────────────────────────────────────────────────────
  // 5. SMART_MODE_PROVIDERS — guard against undefined modes
  // ───────────────────────────────────────────────────────────────

  describe("SMART_MODE_PROVIDERS fallback", function () {
    it("provides a broad fallback for all modes", function () {
      assert.isArray(SMART_MODE_PROVIDERS.broad);
      assert.isAbove(SMART_MODE_PROVIDERS.broad.length, 0);
    });

    it("each mode maps to a non-empty provider list", function () {
      const modes = [
        "broad",
        "biomedical",
        "preprints",
        "cryptography",
        "repositories",
      ] as const;
      for (const m of modes) {
        const providers = SMART_MODE_PROVIDERS[m] || SMART_MODE_PROVIDERS.broad;
        assert.isArray(providers);
        assert.isAbove(providers.length, 0, `${m} should have providers`);
      }
    });
  });
});
