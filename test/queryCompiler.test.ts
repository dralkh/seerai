import { assert } from "chai";
import {
  compileQuery,
  compileQueriesForProviders,
  parseSearchQueryIR,
  SearchQueryIR,
} from "../src/modules/search";

const IR: SearchQueryIR = {
  groups: [
    { terms: ["machine learning", "deep learning"] },
    {
      terms: ["kidney disease", "nephropathy"],
      mesh: ["Kidney Diseases"],
    },
  ],
  exclude: ["pediatric"],
  field: "title-abstract",
};

describe("Query compiler", function () {
  it("Semantic Scholar emits no boolean/wildcard operators", function () {
    const q = compileQuery(IR, "semantic-scholar");
    // SS live search supports neither operators nor wildcards.
    assert.notMatch(q, /[+|~*]/);
    assert.notInclude(q, " AND ");
    assert.notInclude(q, " OR ");
    assert.notInclude(q, "NOT");
    // Canonical phrases are quoted.
    assert.include(q, '"machine learning"');
    assert.include(q, '"kidney disease"');
  });

  it("arXiv uses uppercase booleans and field prefixes", function () {
    const q = compileQuery(IR, "arxiv");
    assert.include(q, "all:"); // title-abstract maps to all (no tiab field)
    assert.include(q, " OR ");
    assert.include(q, " AND ");
    assert.include(q, "ANDNOT");
    assert.match(q, /\(all:"machine learning" OR all:"deep learning"\)/);
  });

  it("PubMed pairs the keyword side with [mesh] via OR", function () {
    const q = compileQuery(IR, "pubmed");
    assert.include(q, "[tiab]");
    assert.include(q, '"Kidney Diseases"[mesh]');
    // MeSH descriptor is OR-ed with the keyword side inside the same group.
    assert.match(q, /OR "Kidney Diseases"\[mesh\]/);
    assert.include(q, " AND ");
    assert.include(q, "NOT pediatric[tiab]");
  });

  it("Europe PMC (and bioRxiv/medRxiv keyword) use TITLE/AND/OR/NOT", function () {
    const epmc = compileQuery(IR, "europe-pmc");
    assert.include(epmc, " AND ");
    assert.include(epmc, " OR ");
    assert.include(epmc, "NOT ");
    // bioRxiv/medRxiv keyword mode delegates to Europe PMC, same dialect.
    assert.equal(compileQuery(IR, "biorxiv"), epmc);
    assert.equal(compileQuery(IR, "medrxiv"), epmc);
  });

  it("Lucene providers group with parentheses and field-free terms", function () {
    const core = compileQuery(IR, "core");
    assert.match(core, /\("machine learning" OR "deep learning"\)/);
    assert.include(core, " AND ");
    assert.include(core, "NOT ");
    // CORE/Zenodo/HAL share the portable Lucene dialect.
    assert.equal(compileQuery(IR, "zenodo"), core);
    assert.equal(compileQuery(IR, "hal"), core);
  });

  it("BASE and IACR are plain keyword (no operators)", function () {
    for (const id of ["base", "iacr"] as const) {
      const q = compileQuery(IR, id);
      assert.notInclude(q, " AND ");
      assert.notInclude(q, " OR ");
      assert.notInclude(q, "NOT");
      assert.notMatch(q, /[+|~]/);
    }
  });

  it("a degenerate single-term IR emits no stray operators", function () {
    const single: SearchQueryIR = { groups: [{ terms: ["crispr"] }] };
    for (const id of [
      "semantic-scholar",
      "arxiv",
      "pubmed",
      "europe-pmc",
      "core",
      "base",
    ] as const) {
      const q = compileQuery(single, id);
      assert.notInclude(q, " OR ");
      assert.notInclude(q, " AND ");
      assert.notInclude(q, "NOT");
      assert.include(q, "crispr");
    }
  });

  it("compileQueriesForProviders returns an entry per provider", function () {
    const out = compileQueriesForProviders(IR, [
      "semantic-scholar",
      "pubmed",
      "arxiv",
    ]);
    assert.hasAllKeys(out, ["semantic-scholar", "pubmed", "arxiv"]);
    assert.notMatch(out["semantic-scholar"] || "", /[+|~*]/);
    assert.include(out.pubmed || "", "[tiab]");
  });

  describe("parseSearchQueryIR", function () {
    it("parses well-formed JSON", function () {
      const ir = parseSearchQueryIR(
        '{"groups":[{"terms":["a","b"]}],"exclude":["c"],"field":"title"}',
      );
      assert.isNotNull(ir);
      assert.lengthOf(ir!.groups, 1);
      assert.deepEqual(ir!.exclude, ["c"]);
      assert.equal(ir!.field, "title");
    });

    it("recovers JSON wrapped in code fences or prose", function () {
      const ir = parseSearchQueryIR(
        'Here you go:\n```json\n{"groups":[{"terms":["x"]}]}\n```\nThanks!',
      );
      assert.isNotNull(ir);
      assert.deepEqual(ir!.groups[0].terms, ["x"]);
    });

    it("returns null for malformed or empty output", function () {
      assert.isNull(parseSearchQueryIR("not json at all"));
      assert.isNull(parseSearchQueryIR("{}"));
      assert.isNull(parseSearchQueryIR('{"groups":[]}'));
      assert.isNull(parseSearchQueryIR(""));
    });

    it("drops invalid field values and empty terms", function () {
      const ir = parseSearchQueryIR(
        '{"groups":[{"terms":["a","",123]}],"field":"bogus"}',
      );
      assert.isNotNull(ir);
      assert.deepEqual(ir!.groups[0].terms, ["a"]);
      assert.isUndefined(ir!.field);
    });
  });
});
