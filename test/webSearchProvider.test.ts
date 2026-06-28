import { assert } from "chai";
import { executeWeb } from "../src/modules/chat/tools/webTool";
import { getActiveProviderType } from "../src/modules/webSearchProvider";

const prefValues = new Map<string, boolean | string | number>();

function setPrefValue(key: string, value: boolean | string | number): void {
  prefValues.set(`extensions.zotero.seerai.${key}`, value);
}

describe("Web search provider preferences", function () {
  before(function () {
    (globalThis as any).Zotero = {
      Prefs: {
        get(pref: string, global?: boolean) {
          if (!global) {
            return undefined;
          }
          return prefValues.get(pref);
        },
      },
      debug() {},
    };
  });

  beforeEach(function () {
    prefValues.clear();
  });

  it("reads the selected provider from the global plugin pref branch", function () {
    setPrefValue("webSearchProvider", "tavily");

    assert.equal(getActiveProviderType(), "tavily");
  });

  it("falls back to Firecrawl for missing or unknown provider values", function () {
    assert.equal(getActiveProviderType(), "firecrawl");

    setPrefValue("webSearchProvider", "unknown");

    assert.equal(getActiveProviderType(), "firecrawl");
  });

  it("reports Tavily configuration errors when Tavily is selected", async function () {
    setPrefValue("webSearchProvider", "tavily");

    const result = await executeWeb(
      { action: "search", query: "zotero ai", limit: 1 },
      {} as any,
    );

    assert.isFalse(result.success);
    assert.equal(
      result.error,
      "Tavily API is not configured. Please set the API key in settings.",
    );
  });
});
