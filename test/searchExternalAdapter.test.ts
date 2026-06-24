import { assert } from "chai";
import { buildExternalSearchQuery } from "../src/modules/chat/tools/searchExternalAdapter.ts";

describe("search_external adapter", function () {
  it("keeps legacy calls on Semantic Scholar", function () {
    const query = buildExternalSearchQuery({
      query: "graph neural networks",
      limit: 5,
    });
    assert.equal(query.mode, "source");
    assert.deepEqual(query.providers, ["semantic-scholar"]);
    assert.equal(query.limit, 5);
    assert.isUndefined(query.providerQueries);
  });

  it("uses explicit provider and provider lists as source searches", function () {
    const single = buildExternalSearchQuery({
      query: "kidney disease",
      provider: "pubmed",
    });
    assert.equal(single.mode, "source");
    assert.deepEqual(single.providers, ["pubmed"]);

    const multi = buildExternalSearchQuery({
      query: "preprints",
      providers: ["arxiv", "biorxiv"],
      mode: "broad",
    });
    assert.equal(multi.mode, "source");
    assert.deepEqual(multi.providers, ["arxiv", "biorxiv"]);
  });

  it("uses smart mode provider sets when no explicit provider is set", function () {
    const query = buildExternalSearchQuery({
      query: "clinical trial",
      mode: "biomedical",
    });
    assert.equal(query.mode, "biomedical");
    assert.deepEqual(query.providers, []);
  });

  it("maps legacy and common filters", function () {
    const query = buildExternalSearchQuery({
      query: "open access",
      year: "2020-2024",
      openAccessPdf: true,
      filters: {
        minCitationCount: 10,
        venue: "Nature",
      },
    });
    assert.equal(query.filters.yearStart, "2020");
    assert.equal(query.filters.yearEnd, "2024");
    assert.isTrue(query.filters.openAccess);
    assert.isTrue(query.filters.hasPdf);
    assert.equal(query.filters.minCitationCount, 10);
    assert.equal(query.filters.venue, "Nature");
  });

  it("compiles structured concepts per selected corpus", function () {
    const query = buildExternalSearchQuery({
      query: "fallback text",
      providers: ["pubmed", "arxiv", "semantic-scholar"],
      concepts: [
        { terms: ["machine learning", "deep learning"] },
        { terms: ["kidney disease"], mesh: ["Kidney Diseases"] },
      ],
      exclude: ["pediatric"],
      field: "title-abstract",
    });
    assert.include(query.providerQueries?.pubmed || "", "[tiab]");
    assert.include(query.providerQueries?.pubmed || "", "[mesh]");
    assert.include(query.providerQueries?.arxiv || "", "all:");
    assert.notInclude(
      query.providerQueries?.["semantic-scholar"] || "",
      " AND ",
    );
  });
});
