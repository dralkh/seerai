import { assert } from "chai";
import { ScholarlyProviderId, scholarlyProviders } from "../src/modules/search";

const liveEnabled =
  typeof process !== "undefined" &&
  process.env.SEERAI_LIVE_SEARCH_TESTS === "1";

describe("Scholarly search live contracts", function () {
  this.timeout(120000);

  before(function () {
    if (!liveEnabled) this.skip();
  });

  const providers: ScholarlyProviderId[] = [
    "semantic-scholar",
    "arxiv",
    "pubmed",
    "biorxiv",
    "medrxiv",
    "iacr",
    "europe-pmc",
    "core",
    "zenodo",
    "hal",
  ];

  it("normalizes all configured live provider responses", async function () {
    for (const id of providers) {
      const provider = scholarlyProviders[id];
      if (!provider.isConfigured()) continue;
      const page = await provider.search(
        {
          text: id === "iacr" ? "cryptography" : "research",
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
      assert.isAtLeast(page.items.length, 1, id);
      assert.isNotEmpty(page.items[0].title, id);
      assert.equal(page.items[0].source, id);
    }
  });
});
