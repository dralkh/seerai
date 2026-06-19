import { assert } from "chai";
import { resolveModelFromState } from "../src/modules/chat/modelResolver";
import {
  mergeProviderModelUpdate,
  migrateLegacyModels,
  renameModelRoutingPresetInState,
} from "../src/modules/chat/providerRegistry";
import type { AIModelConfig } from "../src/modules/chat/types";
import type {
  ProviderConfig,
  ProviderModel,
  ProviderRegistryState,
} from "../src/modules/chat/providerTypes";

const now = "2026-01-01T00:00:00.000Z";

function model(
  id: string,
  modelId: string,
  capabilities: ProviderModel["capabilities"],
): ProviderModel {
  return {
    id,
    modelId,
    displayName: modelId,
    capabilities,
    createdAt: now,
    updatedAt: now,
  };
}

function provider(
  id: string,
  name: string,
  models: ProviderModel[],
  options: Partial<ProviderConfig> = {},
): ProviderConfig {
  return {
    id,
    name,
    apiURL: `https://${id}.example/v1`,
    apiKey: `${id}-key`,
    authMethod: "bearer",
    models: [],
    configuredModels: models,
    modelPolicy: "scoped",
    isActive: true,
    enabled: true,
    adapterId: "openai-compatible",
    createdAt: now,
    updatedAt: now,
    ...options,
  };
}

describe("Provider model routing", function () {
  it("renames routing presets while enforcing unique names", function () {
    const state: ProviderRegistryState = {
      version: 2,
      providers: [],
      defaults: {},
      routingPresets: [
        {
          id: "research",
          name: "Research",
          models: {},
          createdAt: now,
          updatedAt: now,
        },
        {
          id: "coding",
          name: "Coding",
          models: {},
          createdAt: now,
          updatedAt: now,
        },
      ],
    };
    const renamed = renameModelRoutingPresetInState(
      state,
      "research",
      "Evidence Review",
    );
    assert.equal(renamed?.name, "Evidence Review");
    assert.isUndefined(
      renameModelRoutingPresetInState(state, "research", "Coding"),
    );
  });

  it("migrates legacy capability models and active defaults without flattening settings", function () {
    const legacy: AIModelConfig = {
      id: "legacy",
      name: "Legacy",
      apiURL: "https://api.example/v1",
      apiKey: "secret",
      model: "chat-model",
      contextLength: 200000,
      embeddingConfig: {
        model: "embed-model",
        endpoint: "https://embeddings.example/create",
        dimensions: 1536,
      },
      imageConfig: { model: "image-model" },
    };
    const migrated = migrateLegacyModels(
      [legacy],
      { version: 2, providers: [], defaults: {} },
      "legacy",
    );
    assert.lengthOf(migrated.providers, 1);
    assert.equal(migrated.providers[0].configuredModels?.length, 3);
    assert.equal(
      resolveModelFromState(migrated, "chat")?.model.contextLength,
      200000,
    );
    const embedding = resolveModelFromState(migrated, "embedding");
    assert.equal(embedding?.model.dimensions, 1536);
    assert.equal(embedding?.endpoint, "https://embeddings.example/create");
    assert.equal(
      resolveModelFromState(migrated, "image")?.model.modelId,
      "image-model",
    );
  });

  it("uses a conversation override before the global chat default", function () {
    const first = provider("first", "First", [model("a", "alpha", ["chat"])]);
    const second = provider("second", "Second", [model("b", "beta", ["chat"])]);
    const state: ProviderRegistryState = {
      version: 2,
      providers: [first, second],
      defaults: { chat: { providerId: "first", localModelId: "a" } },
    };
    const resolved = resolveModelFromState(state, "chat", {
      providerId: "second",
      localModelId: "b",
    });
    assert.equal(resolved?.provider.id, "second");
    assert.equal(resolved?.model.modelId, "beta");
  });

  it("falls back to the global default when an override is unavailable", function () {
    const first = provider("first", "First", [model("a", "alpha", ["chat"])]);
    const state: ProviderRegistryState = {
      version: 2,
      providers: [first],
      defaults: { chat: { providerId: "first", localModelId: "a" } },
    };
    const resolved = resolveModelFromState(state, "chat", {
      providerId: "missing",
      localModelId: "missing",
    });
    assert.equal(resolved?.model.modelId, "alpha");
  });

  it("routes independent capabilities through different providers", function () {
    const chat = provider("chat", "Chat", [model("c", "text", ["chat"])]);
    const media = provider("media", "Media", [model("i", "image", ["image"])], {
      authMethod: "x-api-key",
      authHeaderName: "x-api-key",
    });
    const state: ProviderRegistryState = {
      version: 2,
      providers: [chat, media],
      defaults: {
        chat: { providerId: "chat", localModelId: "c" },
        image: { providerId: "media", localModelId: "i" },
      },
    };
    const resolved = resolveModelFromState(state, "image");
    assert.equal(resolved?.provider.id, "media");
    assert.equal(resolved?.headers["x-api-key"], "media-key");
    assert.notProperty(resolved?.headers, "Authorization");
  });

  it("uses all discovered models in automatic mode", function () {
    const automatic = provider("auto", "Automatic", [], {
      modelPolicy: "automatic",
      models: [
        {
          id: "discovered-chat",
          object: "model",
          displayName: "Discovered Chat",
          capabilities: ["chat"],
        },
      ],
    });
    const state: ProviderRegistryState = {
      version: 2,
      providers: [automatic],
      defaults: {
        chat: {
          providerId: "auto",
          localModelId: "discovered:discovered-chat",
        },
      },
    };
    const resolved = resolveModelFromState(state, "chat");
    assert.equal(resolved?.model.modelId, "discovered-chat");
  });

  it("persists RAG metadata for an automatically discovered model", function () {
    const automatic = provider("auto", "Automatic", [], {
      modelPolicy: "automatic",
      models: [
        {
          id: "deepseek-v4-flash",
          object: "model",
          capabilities: ["chat"],
        },
      ],
    });
    const updated = mergeProviderModelUpdate(
      automatic,
      "discovered:deepseek-v4-flash",
      { ragAlwaysUse: true },
    );
    assert.isTrue(updated?.ragAlwaysUse);
    assert.equal(automatic.modelPolicy, "automatic");
    assert.isTrue(
      automatic.configuredModels?.find(
        (item) => item.modelId === "deepseek-v4-flash",
      )?.ragAlwaysUse,
    );
  });

  it("does not resolve disabled providers or mismatched capabilities", function () {
    const disabled = provider(
      "disabled",
      "Disabled",
      [model("e", "embed", ["embedding"])],
      { enabled: false },
    );
    const state: ProviderRegistryState = {
      version: 2,
      providers: [disabled],
      defaults: {
        chat: { providerId: "disabled", localModelId: "e" },
      },
    };
    assert.isUndefined(resolveModelFromState(state, "chat"));
  });

  it("applies NanoGPT endpoints and both supported auth headers", function () {
    const nano = provider(
      "nano",
      "NanoGPT",
      [model("v", "video-model", ["video"])],
      {
        apiURL: "https://nano-gpt.com/api/v1",
        adapterId: "nanogpt",
      },
    );
    const state: ProviderRegistryState = {
      version: 2,
      providers: [nano],
      defaults: { video: { providerId: "nano", localModelId: "v" } },
    };
    const resolved = resolveModelFromState(state, "video");
    assert.equal(resolved?.endpoint, "https://nano-gpt.com/api/generate-video");
    assert.equal(resolved?.headers.Authorization, "Bearer nano-key");
    assert.equal(resolved?.headers["x-api-key"], "nano-key");
  });
});
