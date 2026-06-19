import { assert } from "chai";
import { getPresetById } from "../src/modules/chat/providerPresets";

describe("Provider presets", function () {
  it("includes researched OpenAI-compatible provider URLs", function () {
    assert.equal(getPresetById("minimax")?.apiURL, "https://api.minimax.io/v1");
    assert.equal(
      getPresetById("mimo")?.apiURL,
      "https://api.xiaomimimo.com/v1",
    );
    assert.equal(
      getPresetById("moonshot")?.apiURL,
      "https://api.moonshot.ai/v1",
    );
  });

  it("keeps Z.AI general and Coding Plan endpoints separate", function () {
    assert.equal(getPresetById("zai")?.apiURL, "https://api.z.ai/api/paas/v4");
    assert.equal(
      getPresetById("zai-coding")?.apiURL,
      "https://api.z.ai/api/coding/paas/v4",
    );
  });
});
