import { assert } from "chai";
import {
  ScholarlyProviderId,
  ScholarlySearchQuery,
  scholarlyProviders,
} from "../src/modules/search";

/** Run `fn` with fetch stubbed; capture every requested URL. */
async function captureUrls<T>(
  body: string,
  contentType: string,
  fn: () => Promise<T>,
): Promise<{ result: T; urls: string[] }> {
  const original = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    urls.push(typeof input === "string" ? input : input.toString());
    return new Response(body, {
      status: 200,
      headers: { "content-type": contentType },
    });
  }) as typeof fetch;
  try {
    const result = await fn();
    return { result, urls };
  } finally {
    globalThis.fetch = original;
  }
}

function query(
  id: ScholarlyProviderId,
  overrides: Partial<ScholarlySearchQuery> = {},
): ScholarlySearchQuery {
  return {
    text: "RAWTEXT",
    mode: "source",
    providers: [id],
    limit: 1,
    sort: "relevance",
    filters: {},
    providerFilters: {},
    ...overrides,
  };
}

describe("Per-provider query threading", function () {
  it("arXiv uses providerQueries entry over text", async function () {
    const { urls } = await captureUrls(
      `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><opensearch:totalResults xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">0</opensearch:totalResults></feed>`,
      "application/atom+xml",
      () =>
        scholarlyProviders.arxiv.search(
          query("arxiv", { providerQueries: { arxiv: "COMPILED" } }),
          undefined,
          {},
        ),
    );
    const joined = decodeURIComponent(urls.join(" "));
    assert.include(joined, "COMPILED");
    assert.notInclude(joined, "RAWTEXT");
  });

  it("falls back to text when providerQueries is absent", async function () {
    const { urls } = await captureUrls(
      `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><opensearch:totalResults xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">0</opensearch:totalResults></feed>`,
      "application/atom+xml",
      () => scholarlyProviders.arxiv.search(query("arxiv"), undefined, {}),
    );
    const joined = decodeURIComponent(urls.join(" "));
    assert.include(joined, "RAWTEXT");
  });

  it("Zenodo uses its own providerQueries entry", async function () {
    const { urls } = await captureUrls(
      JSON.stringify({ hits: { hits: [], total: 0 } }),
      "application/json",
      () =>
        scholarlyProviders.zenodo.search(
          query("zenodo", { providerQueries: { zenodo: "ZQUERY" } }),
          undefined,
          {},
        ),
    );
    const joined = decodeURIComponent(urls.join(" "));
    assert.include(joined, "ZQUERY");
    assert.notInclude(joined, "RAWTEXT");
  });
});
