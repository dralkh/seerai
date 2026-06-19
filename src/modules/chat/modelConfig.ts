import type { AIModelConfig, ModelType } from "./types";
import {
  addProviderConfig,
  addProviderModel,
  deleteProviderModel,
  getConfiguredProviderModels,
  getDefaultModelRef,
  getProviderConfig,
  getProviderConfigs,
  initProviderConfigs,
  setDefaultModelRef,
  updateProviderConfig,
  updateProviderModel,
} from "./providerRegistry";
import { getAvailableModels, resolveModel } from "./modelResolver";
import type {
  ModelRef,
  ProviderConfig,
  ProviderModel,
  ResolvedModel,
} from "./providerTypes";

function endpointConfig(capability: Exclude<ModelType, "chat">) {
  const resolved = resolveModel(capability);
  if (!resolved) return undefined;
  return {
    model: resolved.model.modelId,
    endpoint: resolved.endpoint,
    ...(capability === "tts" && resolved.model.voice
      ? { voice: resolved.model.voice }
      : {}),
    ...(capability === "embedding" && resolved.model.dimensions
      ? { dimensions: resolved.model.dimensions }
      : {}),
    ...(capability === "embedding" && resolved.model.maxTokens
      ? { maxTokens: resolved.model.maxTokens }
      : {}),
  };
}

function toLegacy(resolved: ResolvedModel): AIModelConfig {
  const { provider, model } = resolved;
  return {
    id: model.id,
    name: `${provider.name} · ${model.displayName}`,
    apiURL: provider.apiURL,
    apiKey: provider.apiKey,
    model: model.modelId,
    isDefault:
      getDefaultModelRef("chat")?.providerId === provider.id &&
      getDefaultModelRef("chat")?.localModelId === model.id,
    rateLimit: model.rateLimit,
    reasoningEffort: model.reasoningEffort,
    toolChoice: model.toolChoice,
    contextLength: model.contextLength,
    ragTokenThreshold: model.ragTokenThreshold,
    ragAlwaysUse: model.ragAlwaysUse,
    ragTopK: model.ragTopK,
    ragMinScore: model.ragMinScore,
    ttsConfig: endpointConfig("tts"),
    sttConfig: endpointConfig("stt"),
    embeddingConfig: endpointConfig("embedding"),
    imageConfig: endpointConfig("image"),
    videoConfig: endpointConfig("video"),
    createdAt: model.createdAt,
    updatedAt: model.updatedAt,
  };
}

function findByLocalId(
  id: string,
):
  | { provider: ProviderConfig; model: ProviderModel; ref: ModelRef }
  | undefined {
  for (const provider of getProviderConfigs()) {
    const model = getConfiguredProviderModels(provider).find(
      (candidate) => candidate.id === id,
    );
    if (model) {
      return {
        provider,
        model,
        ref: { providerId: provider.id, localModelId: model.id },
      };
    }
  }
  return undefined;
}

export async function initModelConfigs(): Promise<void> {
  await initProviderConfigs();
}

export function getModelConfigs(): AIModelConfig[] {
  return getAvailableModels("chat").map(({ provider, model, ref }) =>
    toLegacy({
      provider,
      model,
      ref,
      adapterId: provider.adapterId || "openai-compatible",
      endpoint: `${provider.apiURL.replace(/\/+$/, "")}/chat/completions`,
      headers: {},
    }),
  );
}

export function getModelConfig(id: string): AIModelConfig | undefined {
  const found = findByLocalId(id);
  if (!found) return undefined;
  return getModelConfigs().find((model) => model.id === found.model.id);
}

export function getDefaultModelConfig(): AIModelConfig | undefined {
  const resolved = resolveModel("chat");
  return resolved ? toLegacy(resolved) : undefined;
}

export function getActiveModelId(): string | undefined {
  return getDefaultModelRef("chat")?.localModelId;
}

export function setActiveModelId(id: string): void {
  const found = findByLocalId(id);
  if (found) setDefaultModelRef("chat", found.ref);
}

export function getActiveModelConfig(): AIModelConfig | undefined {
  return getDefaultModelConfig();
}

export function addModelConfig(
  value: Omit<AIModelConfig, "id" | "createdAt" | "updatedAt">,
): AIModelConfig {
  const provider = addProviderConfig({
    name: value.name,
    apiURL: value.apiURL,
    apiKey: value.apiKey,
    authMethod: "bearer",
    models: [],
    configuredModels: [],
    modelPolicy: "scoped",
    isActive: true,
    enabled: true,
    adapterId: value.apiURL.includes("nano-gpt.com")
      ? "nanogpt"
      : "openai-compatible",
  });
  const model = addProviderModel(provider.id, {
    modelId: value.model,
    displayName: value.name,
    capabilities: ["chat"],
    rateLimit: value.rateLimit,
    reasoningEffort: value.reasoningEffort,
    toolChoice: value.toolChoice,
    contextLength: value.contextLength,
    ragTokenThreshold: value.ragTokenThreshold,
    ragAlwaysUse: value.ragAlwaysUse,
    ragTopK: value.ragTopK,
    ragMinScore: value.ragMinScore,
  })!;
  if (!getDefaultModelRef("chat") || value.isDefault) {
    setDefaultModelRef("chat", {
      providerId: provider.id,
      localModelId: model.id,
    });
  }
  return getModelConfig(model.id)!;
}

export function updateModelConfig(
  id: string,
  updates: Partial<Omit<AIModelConfig, "id" | "createdAt">>,
): AIModelConfig | undefined {
  const found = findByLocalId(id);
  if (!found) return undefined;
  updateProviderConfig(found.provider.id, {
    ...(updates.apiURL !== undefined && { apiURL: updates.apiURL }),
    ...(updates.apiKey !== undefined && { apiKey: updates.apiKey }),
  });
  updateProviderModel(found.provider.id, id, {
    ...(updates.model !== undefined && { modelId: updates.model }),
    ...(updates.name !== undefined && { displayName: updates.name }),
    ...(updates.rateLimit !== undefined && { rateLimit: updates.rateLimit }),
    ...(updates.reasoningEffort !== undefined && {
      reasoningEffort: updates.reasoningEffort,
    }),
    ...(updates.toolChoice !== undefined && { toolChoice: updates.toolChoice }),
    ...(updates.contextLength !== undefined && {
      contextLength: updates.contextLength,
    }),
    ...(updates.ragTokenThreshold !== undefined && {
      ragTokenThreshold: updates.ragTokenThreshold,
    }),
    ...(updates.ragAlwaysUse !== undefined && {
      ragAlwaysUse: updates.ragAlwaysUse,
    }),
    ...(updates.ragTopK !== undefined && { ragTopK: updates.ragTopK }),
    ...(updates.ragMinScore !== undefined && {
      ragMinScore: updates.ragMinScore,
    }),
  });
  if (updates.isDefault) setDefaultModelConfig(id);
  return getModelConfig(id);
}

export function deleteModelConfig(id: string): boolean {
  const found = findByLocalId(id);
  return found ? deleteProviderModel(found.provider.id, id) : false;
}

export function setDefaultModelConfig(id: string): boolean {
  const found = findByLocalId(id);
  if (!found) return false;
  setDefaultModelRef("chat", found.ref);
  return true;
}

export function validateModelConfig(value: Partial<AIModelConfig>): string[] {
  const errors: string[] = [];
  if (!value.name?.trim()) errors.push("Name is required");
  if (!value.model?.trim()) errors.push("Model is required");
  try {
    if (!value.apiURL?.trim()) errors.push("API URL is required");
    else new URL(value.apiURL);
  } catch {
    errors.push("API URL must be a valid URL");
  }
  return errors;
}

export function hasModelConfigs(): boolean {
  return getAvailableModels("chat").length > 0;
}
