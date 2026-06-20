import { assert } from "chai";
import { resolveModelFromState } from "../src/modules/chat/modelResolver";
import type {
  ModelCapability,
  ProviderConfig,
  ProviderRegistryState,
} from "../src/modules/chat/providerTypes";

function stateFor(
  capability: ModelCapability,
  presetId = "openrouter",
): ProviderRegistryState {
  const now = new Date().toISOString();
  const provider: ProviderConfig = {
    id: "openrouter-provider",
    presetId,
    name: presetId,
    apiURL:
      presetId === "openai"
        ? "https://api.openai.com/v1/"
        : "https://openrouter.ai/api/v1/",
    apiKey: "test-key",
    authMethod: "bearer",
    models: [],
    configuredModels: [
      {
        id: `${capability}-model`,
        modelId: `provider/${capability}-model`,
        displayName: `${capability} model`,
        capabilities: [capability],
        createdAt: now,
        updatedAt: now,
      },
    ],
    modelPolicy: "scoped",
    isActive: true,
    enabled: true,
    adapterId: "openai-compatible",
    createdAt: now,
    updatedAt: now,
  };
  return {
    version: 2,
    providers: [provider],
    defaults: {
      [capability]: {
        providerId: provider.id,
        localModelId: `${capability}-model`,
      },
    },
  };
}

function routedEndpoint(
  capability: ModelCapability,
  presetId: string,
  apiURL: string,
): string | undefined {
  const state = stateFor(capability, presetId);
  state.providers[0].apiURL = apiURL;
  return resolveModelFromState(state, capability)?.endpoint;
}

describe("Model resolver", function () {
  it("uses OpenRouter chat completions for image generation", function () {
    assert.equal(
      resolveModelFromState(stateFor("image"), "image")?.endpoint,
      "https://openrouter.ai/api/v1/chat/completions",
    );
  });

  it("uses the dedicated OpenRouter video endpoint", function () {
    assert.equal(
      resolveModelFromState(stateFor("video"), "video")?.endpoint,
      "https://openrouter.ai/api/v1/videos",
    );
  });

  it("retains the OpenRouter speech endpoint", function () {
    assert.equal(
      resolveModelFromState(stateFor("tts"), "tts")?.endpoint,
      "https://openrouter.ai/api/v1/audio/speech",
    );
  });

  it("uses the OpenAI Video API endpoint", function () {
    assert.equal(
      resolveModelFromState(stateFor("video", "openai"), "video")?.endpoint,
      "https://api.openai.com/v1/videos",
    );
  });

  it("routes MiMo speech models through chat completions", function () {
    const state = stateFor("stt", "mimo");
    state.providers[0].adapterId = "mimo";
    state.providers[0].apiURL = "https://api.xiaomimimo.com/v1";
    assert.equal(
      resolveModelFromState(state, "stt")?.endpoint,
      "https://api.xiaomimimo.com/v1/chat/completions",
    );
  });

  it("uses the xAI video generation endpoint", function () {
    const state = stateFor("video", "xai");
    state.providers[0].apiURL = "https://api.x.ai/v1/";
    assert.equal(
      resolveModelFromState(state, "video")?.endpoint,
      "https://api.x.ai/v1/videos/generations",
    );
  });

  it("uses the native xAI audio endpoints", function () {
    assert.equal(
      routedEndpoint("tts", "xai", "https://api.x.ai/v1/"),
      "https://api.x.ai/v1/tts",
    );
    assert.equal(
      routedEndpoint("stt", "xai", "https://api.x.ai/v1/"),
      "https://api.x.ai/v1/stt",
    );
  });

  it("uses the native MiniMax media endpoints", function () {
    assert.equal(
      routedEndpoint("image", "minimax", "https://api.minimax.io/v1"),
      "https://api.minimax.io/v1/image_generation",
    );
    assert.equal(
      routedEndpoint("video", "minimax", "https://api.minimax.io/v1"),
      "https://api.minimax.io/v1/video_generation",
    );
    assert.equal(
      routedEndpoint("tts", "minimax", "https://api.minimax.io/v1"),
      "https://api.minimax.io/v1/t2a_v2",
    );
  });

  it("uses Z.AI video generations and Gemini chat image endpoints", function () {
    assert.equal(
      routedEndpoint("video", "zai", "https://api.z.ai/api/paas/v4"),
      "https://api.z.ai/api/paas/v4/videos/generations",
    );
    assert.equal(
      routedEndpoint(
        "image",
        "google",
        "https://generativelanguage.googleapis.com/v1beta/openai/",
      ),
      "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    );
  });

  it("uses the Together video jobs endpoint", function () {
    const state = stateFor("video", "together");
    state.providers[0].adapterId = "together";
    state.providers[0].apiURL = "https://api.together.xyz/v1/";
    assert.equal(
      resolveModelFromState(state, "video")?.endpoint,
      "https://api.together.xyz/v1/videos",
    );
  });
});
