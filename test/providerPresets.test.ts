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

  it("requests every OpenRouter output modality during discovery", function () {
    assert.equal(
      getPresetById("openrouter")?.modelsURL,
      "https://openrouter.ai/api/v1/models?output_modalities=all",
    );
  });

  it("uses Cohere's native model catalog endpoint", function () {
    assert.equal(
      getPresetById("cohere")?.modelsURL,
      "https://api.cohere.com/v1/models?page_size=1000",
    );
  });

  it("does not route Fireworks workflow images through OpenAI images", function () {
    assert.notInclude(
      getPresetById("fireworks")?.verifiedCapabilities,
      "image",
    );
  });

  it("supplements providers whose model endpoint omits media models", function () {
    assert.include(
      getPresetById("minimax")?.catalogModels?.find(
        (model) => model.id === "MiniMax-Hailuo-2.3",
      )?.capabilities,
      "video",
    );
    assert.include(
      getPresetById("together")?.catalogModels?.find(
        (model) => model.id === "deepgram/nova-3-en",
      )?.capabilities,
      "stt",
    );
  });

  it("provides the documented MiMo speech catalog", function () {
    const mimo = getPresetById("mimo");
    assert.isFalse(mimo?.supportsModelDiscovery);
    assert.include(
      mimo?.catalogModels?.find((model) => model.id === "mimo-v2.5-asr")
        ?.capabilities,
      "stt",
    );
    assert.include(
      mimo?.catalogModels?.find((model) => model.id === "mimo-v2.5-tts")
        ?.capabilities,
      "tts",
    );
  });
});
