import { assert } from "chai";
import { ScholarlyProviderId, scholarlyProviders } from "../src/modules/search";
import { getPref, setPref } from "../src/utils/prefs";

type MockResponse = { body: string; contentType?: string; status?: number };

async function withResponses<T>(
  responses: MockResponse[],
  run: () => Promise<T>,
): Promise<T> {
  const original = globalThis.fetch;
  const queue = [...responses];
  globalThis.fetch = (async () => {
    const next = queue.shift();
    if (!next) throw new Error("Unexpected fixture request");
    return new Response(next.body, {
      status: next.status || 200,
      headers: { "content-type": next.contentType || "application/json" },
    });
  }) as typeof fetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

async function searchFixture(id: ScholarlyProviderId) {
  return scholarlyProviders[id].search(
    {
      text: "fixture",
      mode: "source",
      providers: [id],
      limit: 1,
      sort: "relevance",
      filters: {},
      providerFilters: {},
    },
    undefined,
    {},
  );
}

describe("Scholarly provider fixtures", function () {
  it("parses Semantic Scholar JSON", async function () {
    const page = await withResponses(
      [
        {
          body: JSON.stringify({
            total: 1,
            data: [
              {
                paperId: "s2",
                title: "Semantic fixture",
                authors: [{ authorId: "a", name: "Ada Lovelace" }],
                citationCount: 2,
                url: "https://example.test/s2",
              },
            ],
          }),
        },
      ],
      () => searchFixture("semantic-scholar"),
    );
    assert.equal(page.items[0].source, "semantic-scholar");
  });

  it("parses arXiv Atom XML", async function () {
    const xml = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom" xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/"><opensearch:totalResults>1</opensearch:totalResults><entry><id>http://arxiv.org/abs/2401.00001v2</id><updated>2024-01-02T00:00:00Z</updated><published>2024-01-01T00:00:00Z</published><title>Arxiv fixture</title><summary>Abstract</summary><author><name>Ada Lovelace</name></author><link type="application/pdf" href="https://arxiv.org/pdf/2401.00001"/><category term="cs.AI"/></entry></feed>`;
    const page = await withResponses(
      [{ body: xml, contentType: "application/atom+xml" }],
      () => searchFixture("arxiv"),
    );
    assert.equal(page.items[0].externalIds?.ArXiv, "2401.00001v2");
    assert.equal(page.items[0].year, 2024);
  });

  it("parses PubMed History Server XML", async function () {
    const history = JSON.stringify({
      esearchresult: {
        count: "1",
        idlist: [],
        querykey: "1",
        webenv: "fixture-history",
      },
    });
    const xml = `<PubmedArticleSet><PubmedArticle><MedlineCitation><PMID>123</PMID><Article><ArticleTitle>PubMed fixture</ArticleTitle><Abstract><AbstractText>Abstract</AbstractText></Abstract><AuthorList><Author><ForeName>Ada</ForeName><LastName>Lovelace</LastName></Author></AuthorList><Journal><Title>Journal</Title><JournalIssue><PubDate><Year>2024</Year></PubDate></JournalIssue></Journal></Article></MedlineCitation><PubmedData><ArticleIdList><ArticleId IdType="doi">10.1000/pubmed</ArticleId></ArticleIdList></PubmedData></PubmedArticle></PubmedArticleSet>`;
    const page = await withResponses(
      [{ body: history }, { body: xml, contentType: "application/xml" }],
      () => searchFixture("pubmed"),
    );
    assert.equal(page.items[0].externalIds?.PMID, "123");
    assert.include(page.cursor || "", "fixture-history");
  });

  it("parses scoped Europe PMC and preprint JSON", async function () {
    for (const id of ["europe-pmc", "biorxiv", "medrxiv"] as const) {
      const page = await withResponses(
        [
          {
            body: JSON.stringify({
              hitCount: 1,
              nextCursorMark: "next",
              resultList: {
                result: [
                  {
                    id: "PPR1",
                    source: "PPR",
                    title: `${id} fixture`,
                    authorList: { author: [{ fullName: "Ada Lovelace" }] },
                    pubYear: "2024",
                    doi: "10.1101/fixture",
                    journalTitle: id === "medrxiv" ? "medRxiv" : "bioRxiv",
                  },
                ],
              },
            }),
          },
        ],
        () => searchFixture(id),
      );
      assert.equal(page.items[0].source, id);
    }
  });

  it("parses IACR HTML without injecting provider markup", async function () {
    const html = `<html><body><div class="mb-4"><a class="paperlink" href="/2024/1">2024/1</a><div class="ms-md-4"><strong>IACR fixture</strong></div><span class="fst-italic">Ada Lovelace</span><p class="search-abstract">Abstract</p></div></body></html>`;
    const page = await withResponses(
      [{ body: html, contentType: "text/html" }],
      () => searchFixture("iacr"),
    );
    assert.equal(page.items[0].externalIds?.IACR, "2024/1");
  });

  it("parses CORE JSON anonymously", async function () {
    setPref("coreApiKey", "");
    const page = await withResponses(
      [
        {
          body: JSON.stringify({
            totalHits: 1,
            results: [
              {
                id: 1,
                title: "CORE fixture",
                authors: [{ name: "Ada Lovelace" }],
                yearPublished: 2024,
                doi: "10.1000/core",
              },
            ],
          }),
        },
      ],
      () => searchFixture("core"),
    );
    assert.equal(page.items[0].externalIds?.CORE, "1");
  });

  it("falls back to an anonymous CORE request when a key is rejected", async function () {
    // CORE's anonymous rate window (6 s) is enforced between the rejected keyed
    // request and the anonymous retry, so allow generous time.
    this.timeout(15000);
    const previousKey = getPref("coreApiKey");
    setPref("coreApiKey", "rejected-key");
    const authHeaders: Array<string | undefined> = [];
    const original = globalThis.fetch;
    const queue: MockResponse[] = [
      { body: "unauthorized", status: 401 },
      {
        body: JSON.stringify({
          totalHits: 1,
          results: [
            {
              id: 7,
              title: "CORE anonymous fallback",
              authors: [{ name: "Ada Lovelace" }],
              yearPublished: 2024,
              doi: "10.1000/core-anon",
            },
          ],
        }),
      },
    ];
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      authHeaders.push(
        new Headers(init?.headers || {}).get("authorization") || undefined,
      );
      const next = queue.shift();
      if (!next) throw new Error("Unexpected fixture request");
      return new Response(next.body, {
        status: next.status || 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    try {
      const page = await searchFixture("core");
      assert.equal(page.items[0].externalIds?.CORE, "7");
      // First request carried the (rejected) key; the retry was anonymous.
      assert.match(authHeaders[0] || "", /^Bearer /);
      assert.isUndefined(authHeaders[1]);
    } finally {
      globalThis.fetch = original;
      setPref("coreApiKey", previousKey || "");
    }
  });

  it("parses registered BASE JSON", async function () {
    const previousKey = getPref("baseApiKey");
    setPref("baseApiKey", "fixture-key");
    try {
      const page = await withResponses(
        [
          {
            body: JSON.stringify({
              response: {
                numFound: 1,
                docs: [
                  {
                    dcid: "base-1",
                    dctitle: "BASE fixture",
                    dccreator: ["Ada Lovelace"],
                    dcyear: "2024",
                    dclink: ["https://example.test/base"],
                  },
                ],
              },
            }),
          },
        ],
        () => searchFixture("base"),
      );
      assert.equal(page.items[0].paperId, "base:base-1");
    } finally {
      setPref("baseApiKey", previousKey || "");
    }
  });

  it("parses Zenodo JSON and response pagination links", async function () {
    const page = await withResponses(
      [
        {
          body: JSON.stringify({
            hits: {
              total: { value: 2 },
              hits: [
                {
                  id: 1,
                  doi: "10.5281/zenodo.1",
                  metadata: {
                    title: "Zenodo fixture",
                    creators: [{ name: "Lovelace, Ada" }],
                    publication_date: "2024-01-01",
                    resource_type: { type: "publication" },
                  },
                  links: { html: "https://zenodo.org/records/1" },
                },
              ],
            },
            links: { next: "https://zenodo.org/api/records?page=2" },
          }),
        },
      ],
      () => searchFixture("zenodo"),
    );
    assert.equal(page.cursor, "https://zenodo.org/api/records?page=2");
  });

  it("parses HAL cursor JSON", async function () {
    const page = await withResponses(
      [
        {
          body: JSON.stringify({
            response: {
              numFound: 1,
              docs: [
                {
                  halId_s: "hal-1",
                  title_s: ["HAL fixture"],
                  authFullName_s: ["Ada Lovelace"],
                  publicationDateY_i: 2024,
                  uri_s: "https://hal.science/hal-1",
                },
              ],
            },
            nextCursorMark: "next-hal",
          }),
        },
      ],
      () => searchFixture("hal"),
    );
    assert.equal(page.cursor, "next-hal");
  });

  describe("malformed-response resilience", function () {
    // A provider that returns an unexpected/empty payload (a schema change or a
    // transient broken response) must degrade to an empty page rather than
    // throwing and crashing the federated search.
    it("treats an empty Semantic Scholar object as zero results", async function () {
      const page = await withResponses([{ body: "{}" }], () =>
        searchFixture("semantic-scholar"),
      );
      assert.lengthOf(page.items, 0);
      assert.isTrue(page.exhausted);
    });

    it("treats an empty PubMed ESearch result as zero results", async function () {
      const page = await withResponses([{ body: "{}" }], () =>
        searchFixture("pubmed"),
      );
      assert.lengthOf(page.items, 0);
      assert.isTrue(page.exhausted);
    });

    it("treats an empty Europe PMC payload as zero results", async function () {
      const page = await withResponses([{ body: "{}" }], () =>
        searchFixture("europe-pmc"),
      );
      assert.lengthOf(page.items, 0);
    });

    it("treats an empty Zenodo payload as zero results", async function () {
      const page = await withResponses([{ body: "{}" }], () =>
        searchFixture("zenodo"),
      );
      assert.lengthOf(page.items, 0);
    });

    it("treats an empty HAL payload as zero results", async function () {
      const page = await withResponses([{ body: "{}" }], () =>
        searchFixture("hal"),
      );
      assert.lengthOf(page.items, 0);
    });

    it("treats an empty CORE payload as zero results", async function () {
      setPref("coreApiKey", "");
      const page = await withResponses([{ body: "{}" }], () =>
        searchFixture("core"),
      );
      assert.lengthOf(page.items, 0);
    });

    it("treats an empty arXiv feed as zero results", async function () {
      const xml = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"></feed>`;
      const page = await withResponses(
        [{ body: xml, contentType: "application/atom+xml" }],
        () => searchFixture("arxiv"),
      );
      assert.lengthOf(page.items, 0);
    });
  });
});
