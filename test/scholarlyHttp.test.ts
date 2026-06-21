import { assert } from "chai";
import {
  ProviderRequestError,
  redactScholarlyUrl,
  scholarlyFetch,
  migrateSearchHistoryData,
} from "../src/modules/search";

type Handler = (
  input: string,
  init: RequestInit,
) => Response | Promise<Response>;

async function withFetch<T>(
  handler: Handler,
  run: () => Promise<T>,
): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    Promise.resolve(handler(String(input), init || {}))) as typeof fetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

let providerCounter = 0;
function uniqueProvider(): string {
  return `test-provider-${providerCounter++}`;
}

describe("Scholarly HTTP and persistence", function () {
  describe("HTTP behavior", function () {
    this.timeout(15000);

    it("retries transient 5xx responses and eventually succeeds", async function () {
      let calls = 0;
      const response = await withFetch(
        () => {
          calls += 1;
          return calls < 2
            ? new Response("upstream error", { status: 503 })
            : new Response("ok", { status: 200 });
        },
        () =>
          scholarlyFetch(
            uniqueProvider(),
            "https://example.test/retry",
            {},
            { minIntervalMs: 0, retries: 3 },
          ),
      );
      assert.equal(calls, 2);
      assert.isTrue(response.ok);
    });

    it("classifies a 400 as a non-retryable query error", async function () {
      let calls = 0;
      let captured: ProviderRequestError | undefined;
      await withFetch(
        () => {
          calls += 1;
          return new Response("bad query", { status: 400 });
        },
        async () => {
          try {
            await scholarlyFetch(
              uniqueProvider(),
              "https://example.test/bad",
              {},
              { minIntervalMs: 0, retries: 3 },
            );
          } catch (error) {
            captured = error as ProviderRequestError;
          }
        },
      );
      assert.equal(calls, 1, "must not retry a 400");
      assert.instanceOf(captured, ProviderRequestError);
      assert.equal(captured?.kind, "query");
      assert.equal(captured?.status, 400);
    });

    it("classifies 401 / 403 / 429 distinctly", async function () {
      const cases: Array<[number, string]> = [
        [401, "authentication"],
        [403, "permission"],
        [429, "quota"],
      ];
      for (const [status, kind] of cases) {
        let captured: ProviderRequestError | undefined;
        await withFetch(
          () => new Response("x", { status }),
          async () => {
            try {
              await scholarlyFetch(
                uniqueProvider(),
                "https://example.test/auth",
                {},
                // retries: 0 so 429 fails immediately instead of backing off
                { minIntervalMs: 0, retries: 0 },
              );
            } catch (error) {
              captured = error as ProviderRequestError;
            }
          },
        );
        assert.equal(captured?.kind, kind, `status ${status}`);
      }
    });

    it("spaces sequential requests by the configured minimum interval", async function () {
      const provider = uniqueProvider();
      const starts: number[] = [];
      await withFetch(
        () => {
          starts.push(Date.now());
          return new Response("ok", { status: 200 });
        },
        async () => {
          await scholarlyFetch(
            provider,
            "https://example.test/a",
            {},
            {
              minIntervalMs: 150,
            },
          );
          await scholarlyFetch(
            provider,
            "https://example.test/b",
            {},
            {
              minIntervalMs: 150,
            },
          );
        },
      );
      assert.lengthOf(starts, 2);
      assert.isAtLeast(
        starts[1] - starts[0],
        140,
        "second request should wait out the rate window",
      );
    });

    it("propagates an aborted signal as an AbortError without retrying", async function () {
      const controller = new AbortController();
      controller.abort();
      let calls = 0;
      let aborted = false;
      await withFetch(
        // Mimic the platform fetch: reject with AbortError when the signal is set.
        (_input, init) => {
          calls += 1;
          if (init.signal?.aborted) {
            throw new DOMException("Aborted", "AbortError");
          }
          return new Response("ok", { status: 200 });
        },
        async () => {
          try {
            await scholarlyFetch(
              uniqueProvider(),
              "https://example.test/abort",
              { signal: controller.signal },
              { minIntervalMs: 50, retries: 3 },
            );
          } catch (error) {
            aborted = (error as DOMException)?.name === "AbortError";
          }
        },
      );
      assert.isTrue(aborted, "aborted request should reject with AbortError");
      assert.equal(calls, 1, "an aborted request must not be retried");
    });

    it("redacts credentials from URLs across query-key variants", function () {
      assert.equal(
        redactScholarlyUrl("https://api.test/v1?apikey=SECRET&q=cells"),
        "https://api.test/v1?apikey=REDACTED&q=cells",
      );
      assert.equal(
        redactScholarlyUrl("https://api.test/v1?access_token=abc123"),
        "https://api.test/v1?access_token=REDACTED",
      );
      // Non-URL strings still get scrubbed via the regex fallback.
      assert.include(
        redactScholarlyUrl("core endpoint key=topsecret&page=2"),
        "key=REDACTED",
      );
    });
  });

  describe("Search history migration", function () {
    it("upgrades schema-v1 Semantic Scholar entries to v2", function () {
      const { entries, migrated } = migrateSearchHistoryData([
        {
          id: "legacy-1",
          query: "crispr",
          state: { provider: "semantic-scholar" },
          results: [
            {
              paperId: "abc123",
              title: "Legacy paper",
              citationCount: 4,
              authors: [{ name: "Ada Lovelace" }],
              url: "https://example.test/abc",
            },
          ],
          totalResults: 1,
          savedAt: "2024-01-01T00:00:00.000Z",
        },
      ]);
      assert.isTrue(migrated);
      assert.lengthOf(entries, 1);
      assert.equal(entries[0].schemaVersion, 2);
      assert.equal(entries[0].results[0].source, "semantic-scholar");
      assert.deepEqual(entries[0].results[0].sources, ["semantic-scholar"]);
      assert.equal(
        entries[0].results[0].providerIds?.["semantic-scholar"],
        "abc123",
      );
    });

    it("drops corrupted entries and non-array payloads without throwing", function () {
      const corrupted = migrateSearchHistoryData([
        null,
        { query: 12 },
        { query: "ok", state: null },
        {
          query: "valid",
          state: { provider: "arxiv" },
          results: "not-an-array",
        },
      ]);
      // Only the last entry is structurally valid; its bad results become [].
      assert.lengthOf(corrupted.entries, 1);
      assert.deepEqual(corrupted.entries[0].results, []);

      const notArray = migrateSearchHistoryData({ junk: true } as unknown);
      assert.deepEqual(notArray.entries, []);
      assert.isFalse(notArray.migrated);
    });

    it("preserves already-v2 entries without flagging migration", function () {
      const { migrated } = migrateSearchHistoryData([
        {
          schemaVersion: 2,
          id: "v2",
          query: "graphene",
          state: { provider: "arxiv", providerFilters: {} },
          results: [
            {
              paperId: "arxiv:1",
              title: "Already migrated",
              source: "arxiv",
              sources: ["arxiv"],
              citationCount: 0,
              authors: [],
              url: "https://example.test/1",
            },
          ],
          totalResults: 1,
          searchToken: null,
          savedAt: "2024-01-01T00:00:00.000Z",
        },
      ]);
      assert.isFalse(migrated);
    });
  });
});
