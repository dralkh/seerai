import { assert } from "chai";
import { resolveModelFromState } from "../src/modules/chat/modelResolver";
import type {
  ModelCapability,
  ProviderConfig,
  ProviderRegistryState,
} from "../src/modules/chat/providerTypes";

function stateFor(capability: ModelCapability): ProviderRegistryState {
  const now = new Date().toISOString();
  const provider: ProviderConfig = {
    id: "openrouter-provider",
    presetId: "openrouter",
    name: "OpenRouter",
    apiURL: "https://openrouter.ai/api/v1/",
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
});
