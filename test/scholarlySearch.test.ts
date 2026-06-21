import { assert } from "chai";
import {
  deduplicateScholarlyPapers,
  getScholarlyPaperKey,
  normalizeTitleForMatch,
  normalizeDoiForMatch,
  papersToBibtex,
  reciprocalRankFusion,
  redactScholarlyUrl,
  ScholarlyPaper,
  ScholarlySearchQuery,
  fetchScholarlyPapersForExport,
  scholarlyProviders,
  searchScholarlyPapers,
  migrateSearchHistoryData,
} from "../src/modules/search";

function work(
  source: ScholarlyPaper["source"],
  id: string,
  overrides: Partial<ScholarlyPaper> = {},
): ScholarlyPaper {
  return {
    paperId: `${source}:${id}`,
    source,
    sources: [source],
    title: "A Useful Study",
    authors: [{ name: "Ada Lovelace" }],
    year: 2024,
    citationCount: 0,
    url: `https://example.test/${id}`,
    providerIds: { [source]: id },
    ...overrides,
  };
}

describe("Scholarly search core", function () {
  it("deduplicates DOI variants and merges richer metadata", function () {
    const first = work("semantic-scholar", "one", {
      abstract: "Short",
      externalIds: { DOI: "https://doi.org/10.1000/TEST" },
      citationCount: 7,
    });
    const second = work("core", "two", {
      abstract: "A substantially richer abstract",
      externalIds: { DOI: "doi:10.1000/test" },
      openAccessPdf: { url: "https://example.test/paper.pdf" },
    });
    const merged = deduplicateScholarlyPapers([first, second]);
    assert.lengthOf(merged, 1);
    assert.equal(merged[0].abstract, "A substantially richer abstract");
    assert.deepEqual(merged[0].sources, ["semantic-scholar", "core"]);
    assert.equal(merged[0].citationCount, 7);
    assert.equal(
      merged[0].openAccessPdf?.url,
      "https://example.test/paper.pdf",
    );
  });

  it("normalizes titles and DOIs consistently for library matching", function () {
    // The library-item index (Add to Zotero reuse) and the in-memory dedup key
    // must agree, so a result and an existing item that differ only by case,
    // punctuation, diacritics, or a doi.org prefix still match.
    assert.equal(
      normalizeTitleForMatch("A Study: of Çellular  Growth!"),
      normalizeTitleForMatch("a study of cellular growth"),
    );
    assert.equal(
      normalizeDoiForMatch("https://doi.org/10.1000/TEST"),
      normalizeDoiForMatch("doi:10.1000/test"),
    );
    assert.equal(normalizeDoiForMatch(undefined), "");
    // Agrees with the canonical dedup key used during search.
    const a = work("hal", "a", { title: "Graphene & Beyond" });
    const b = work("zenodo", "b", { title: "graphene  and beyond" });
    assert.notEqual(getScholarlyPaperKey(a), getScholarlyPaperKey(b));
    assert.equal(
      getScholarlyPaperKey(work("hal", "x", { title: "Graphene & Beyond" })),
      getScholarlyPaperKey(
        work("zenodo", "y", { title: "Graphene & Beyond!" }),
      ),
    );
  });

  it("uses conservative title/year/author fallback keys", function () {
    const a = work("hal", "a");
    const b = work("zenodo", "b", { title: "A useful study!" });
    const c = work("zenodo", "c", { year: 2023 });
    assert.equal(getScholarlyPaperKey(a), getScholarlyPaperKey(b));
    assert.notEqual(getScholarlyPaperKey(a), getScholarlyPaperKey(c));
  });

  it("boosts records found by multiple providers with RRF", function () {
    const sharedA = work("semantic-scholar", "shared-a", {
      externalIds: { DOI: "10.1000/shared" },
    });
    const sharedB = work("core", "shared-b", {
      externalIds: { DOI: "10.1000/shared" },
    });
    const onlyA = work("semantic-scholar", "only-a", {
      title: "Only A",
      externalIds: { DOI: "10.1000/a" },
    });
    const result = reciprocalRankFusion({
      "semantic-scholar": [onlyA, sharedA],
      core: [sharedB],
    });
    assert.equal(result[0].externalIds?.DOI?.toLowerCase(), "10.1000/shared");
  });

  it("serializes valid, unique BibTeX entries", function () {
    const first = work("arxiv", "1", {
      title: "A {Study} of 50% & More",
      externalIds: { ArXiv: "2401.00001" },
      publicationTypes: ["Preprint"],
    });
    const second = work("pubmed", "2", {
      title: "Another Study",
      externalIds: { DOI: "10.1000/two", PMID: "123" },
      venue: "Journal of Tests",
    });
    const output = papersToBibtex([first, second]);
    assert.include(output, "@misc{");
    assert.include(output, "@article{");
    assert.include(output, "50\\%");
    assert.include(output, "\\&");
    assert.include(output, "pmid = {123}");
    assert.equal((output.match(/^@/gm) || []).length, 2);
  });

  it("serializes two thousand records without key collisions", function () {
    const papers = Array.from({ length: 2000 }, (_, index) =>
      work("hal", String(index), {
        title: `Study ${index}`,
        externalIds: { DOI: `10.1000/${index}` },
      }),
    );
    const output = papersToBibtex(papers);
    const keys = Array.from(output.matchAll(/^@\w+\{([^,]+),/gm)).map(
      (match) => match[1],
    );
    assert.lengthOf(keys, 2000);
    assert.equal(new Set(keys).size, 2000);
  });

  it("does not merge title-only records without year and author", function () {
    const first = work("hal", "missing-a", { year: undefined, authors: [] });
    const second = work("zenodo", "missing-b", {
      year: undefined,
      authors: [],
    });
    assert.lengthOf(deduplicateScholarlyPapers([first, second]), 2);
  });

  it("uses valid alphabetic suffixes after twenty-six key collisions", function () {
    const papers = Array.from({ length: 30 }, (_, index) =>
      work("hal", String(index), {
        externalIds: { DOI: `10.1000/collision-${index}` },
      }),
    );
    const keys = Array.from(
      papersToBibtex(papers).matchAll(/^@\w+\{([^,]+),/gm),
    ).map((match) => match[1]);
    assert.match(keys[27], /aa$/);
    assert.equal(new Set(keys).size, 30);
  });

  it("redacts credentials from scholarly API URLs", function () {
    const redacted = redactScholarlyUrl(
      "https://example.test/search?query=test&api_key=secret&access_token=hidden",
    );
    assert.notInclude(redacted, "secret");
    assert.notInclude(redacted, "hidden");
    assert.include(redacted, "query=test");
  });

  it("migrates legacy Semantic Scholar search history to schema v2", function () {
    const legacyPaper = {
      paperId: "legacy-id",
      title: "Legacy paper",
      authors: [{ name: "Ada Lovelace", authorId: "author" }],
      citationCount: 1,
      url: "https://example.test/legacy",
    };
    const { entries, migrated } = migrateSearchHistoryData([
      {
        id: "legacy",
        query: "legacy query",
        state: { query: "legacy query" },
        results: [legacyPaper],
      },
      { invalid: true },
    ]);
    assert.isTrue(migrated);
    assert.lengthOf(entries, 1);
    assert.equal(entries[0].schemaVersion, 2);
    assert.equal(entries[0].state.mode, "source");
    assert.equal(entries[0].state.provider, "semantic-scholar");
    assert.deepEqual(entries[0].results[0].sources, ["semantic-scholar"]);
  });

  it("keeps provider-native rankings across pagination", async function () {
    const pubmed = scholarlyProviders.pubmed;
    const europePmc = scholarlyProviders["europe-pmc"];
    const query: ScholarlySearchQuery = {
      text: "test",
      mode: "biomedical",
      providers: [],
      limit: 2,
      sort: "relevance",
      filters: {},
      providerFilters: {},
    };
    scholarlyProviders.pubmed = {
      ...pubmed,
      isConfigured: () => true,
      search: async (_query, cursor) => ({
        items: [work("pubmed", cursor ? "p2" : "p1")],
        cursor: cursor ? undefined : "next",
        exhausted: Boolean(cursor),
      }),
    };
    scholarlyProviders["europe-pmc"] = {
      ...europePmc,
      isConfigured: () => true,
      search: async (_query, cursor) => ({
        items: [work("europe-pmc", cursor ? "e2" : "e1")],
        cursor: cursor ? undefined : "next",
        exhausted: Boolean(cursor),
      }),
    };
    try {
      const first = await searchScholarlyPapers(query, undefined);
      const second = await searchScholarlyPapers(query, first);
      assert.deepEqual(
        second.rankedByProvider?.pubmed?.map((paper) => paper.paperId),
        ["pubmed:p1", "pubmed:p2"],
      );
    } finally {
      scholarlyProviders.pubmed = pubmed;
      scholarlyProviders["europe-pmc"] = europePmc;
    }
  });

  it("fetches a mocked two-thousand-record bulk export", async function () {
    const original = scholarlyProviders["semantic-scholar"];
    const query: ScholarlySearchQuery = {
      text: "test",
      mode: "source",
      providers: ["semantic-scholar"],
      limit: 1000,
      sort: "relevance",
      filters: {},
      providerFilters: {},
    };
    scholarlyProviders["semantic-scholar"] = {
      ...original,
      isConfigured: () => true,
      search: async () => ({ items: [], exhausted: true }),
      bulkSearch: async (_query, cursor) => {
        const start = Number(cursor || 0);
        return {
          items: Array.from({ length: 1000 }, (_, index) =>
            work("semantic-scholar", String(start + index), {
              externalIds: { DOI: `10.1000/bulk-${start + index}` },
            }),
          ),
          cursor: start === 0 ? "1000" : undefined,
          exhausted: start > 0,
        };
      },
    };
    try {
      const papers = await fetchScholarlyPapersForExport(query, 2000, []);
      assert.lengthOf(papers, 2000);
    } finally {
      scholarlyProviders["semantic-scholar"] = original;
    }
  });
});
