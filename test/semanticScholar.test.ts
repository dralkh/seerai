import { assert } from "chai";

describe("Semantic Scholar service", function () {
  const prefValues = new Map<string, boolean | string | number>();
  let originalZotero: unknown;
  let originalFetch: typeof fetch;
  let serviceModule: typeof import("../src/modules/semanticScholar");

  before(async function () {
    originalZotero = (globalThis as any).Zotero;
    originalFetch = globalThis.fetch;
    (globalThis as any).Zotero = {
      Prefs: {
        get(pref: string, global?: boolean) {
          if (!global) return undefined;
          return prefValues.get(pref);
        },
        set(pref: string, value: boolean | string | number, global?: boolean) {
          if (global) prefValues.set(pref, value);
        },
      },
      debug() {},
    };
    serviceModule = await import("../src/modules/semanticScholar");
  });

  after(function () {
    (globalThis as any).Zotero = originalZotero;
    globalThis.fetch = originalFetch;
  });

  beforeEach(function () {
    prefValues.clear();
    globalThis.fetch = originalFetch;
    (serviceModule.semanticScholarService as any).lastRequestTime = 0;
  });

  function setSemanticScholarKey(value: string): void {
    prefValues.set("extensions.zotero.seerai.semanticScholarApiKey", value);
  }

  it("reads the API key from the global plugin pref branch", function () {
    setSemanticScholarKey("fixture-s2-key");

    assert.isTrue(serviceModule.semanticScholarService.hasApiKey());
  });

  it("sends x-api-key when configured", async function () {
    const headers: Array<string | null> = [];
    setSemanticScholarKey("fixture-s2-key");
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      headers.push(new Headers(init?.headers || {}).get("x-api-key"));
      return new Response(JSON.stringify({ total: 0, data: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    await serviceModule.semanticScholarService.searchPapers({
      query: "fixture",
      limit: 1,
    });

    assert.equal(headers[0], "fixture-s2-key");
  });

  it("omits x-api-key when no key is configured", async function () {
    const headers: Array<string | null> = [];
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      headers.push(new Headers(init?.headers || {}).get("x-api-key"));
      return new Response(JSON.stringify({ total: 0, data: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    await serviceModule.semanticScholarService.searchPapers({
      query: "fixture",
      limit: 1,
    });

    assert.isNull(headers[0]);
  });

  it("classifies rejected-key and unauthenticated rate-limit errors", function () {
    assert.include(
      serviceModule.semanticScholarApiErrorMessage(
        403,
        '{"message":"Forbidden"}',
        true,
      ),
      "API key was rejected",
    );
    assert.include(
      serviceModule.semanticScholarApiErrorMessage(
        429,
        '{"message":"Too Many Requests"}',
        false,
      ),
      "unauthenticated rate limit",
    );
  });
});
