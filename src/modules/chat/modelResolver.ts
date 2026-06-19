import { buildAuthHeaders } from "./modelDiscovery";
import {
  getConfiguredProviderModels,
  getDefaultModelRef,
  getProviderConfig,
  getProviderConfigs,
  getProviderRegistryState,
} from "./providerRegistry";
import type {
  ModelRef,
  ProviderConfig,
  ProviderModel,
  ProviderRegistryState,
  ResolvedModel,
} from "./providerTypes";
import { MODEL_TYPE_ENDPOINTS, type ModelType } from "./types";

function findModel(
  provider: ProviderConfig,
  localModelId: string,
): ProviderModel | undefined {
  return getConfiguredProviderModels(provider).find(
    (model) => model.id === localModelId,
  );
}

function endpointFor(
  provider: ProviderConfig,
  model: ProviderModel,
  capability: ModelType,
): string {
  const override = model.endpointOverrides?.[capability];
  if (override) return override;
  const isOpenRouter =
    provider.adapterId === "openrouter" || provider.presetId === "openrouter";
  if (isOpenRouter) {
    const openRouterPaths: Partial<Record<ModelType, string>> = {
      image: "/chat/completions",
      video: "/videos",
    };
    const openRouterPath = openRouterPaths[capability];
    if (openRouterPath) {
      return `${provider.apiURL.replace(/\/+$/, "")}${openRouterPath}`;
    }
  }
  if (provider.adapterId === "nanogpt") {
    const nanoPaths: Partial<Record<ModelType, string>> = {
      tts: "/api/tts",
      stt: "/api/transcribe",
      image: "/api/generate-image",
      video: "/api/generate-video",
    };
    const nanoPath = nanoPaths[capability];
    if (nanoPath) return `https://nano-gpt.com${nanoPath}`;
  }
  if (provider.adapterId === "anthropic" && capability === "chat") {
    return `${provider.apiURL.replace(/\/+$/, "")}/messages`;
  }
  return `${provider.apiURL.replace(/\/+$/, "")}${MODEL_TYPE_ENDPOINTS[capability].path}`;
}

export function isModelRefAvailable(
  ref: ModelRef | undefined,
  capability: ModelType,
): boolean {
  if (!ref) return false;
  const provider = getProviderConfig(ref.providerId);
  if (!provider || provider.enabled === false) return false;
  const model = findModel(provider, ref.localModelId);
  return !!model?.capabilities.includes(capability);
}

export function resolveModel(
  capability: ModelType,
  override?: ModelRef,
): ResolvedModel | undefined {
  return resolveModelFromState(
    getProviderRegistryState(),
    capability,
    override,
  );
}

export function resolveModelFromState(
  state: ProviderRegistryState,
  capability: ModelType,
  override?: ModelRef,
): ResolvedModel | undefined {
  const resolveRef = (ref: ModelRef | undefined) => {
    if (!ref) return undefined;
    const provider = state.providers.find((item) => item.id === ref.providerId);
    if (!provider || provider.enabled === false) return undefined;
    const model = getConfiguredProviderModels(provider).find(
      (item) => item.id === ref.localModelId,
    );
    if (!model?.capabilities.includes(capability)) return undefined;
    return { provider, model, ref };
  };
  const selected =
    resolveRef(override) ||
    resolveRef(state.defaults[capability]) ||
    state.providers
      .filter((provider) => provider.enabled !== false)
      .flatMap((provider) =>
        getConfiguredProviderModels(provider)
          .filter((model) => model.capabilities.includes(capability))
          .map((model) => ({
            provider,
            model,
            ref: { providerId: provider.id, localModelId: model.id },
          })),
      )[0];
  if (!selected) return undefined;
  const { provider, model, ref } = selected;
  const headers = buildAuthHeaders(provider);
  if (provider.adapterId === "nanogpt" && provider.apiKey) {
    headers.Authorization = `Bearer ${provider.apiKey}`;
    headers["x-api-key"] = provider.apiKey;
  }
  return {
    ref,
    provider,
    model,
    adapterId: provider.adapterId || "openai-compatible",
    endpoint: endpointFor(provider, model, capability),
    headers,
  };
}

export function getAvailableModels(
  capability: ModelType,
): Array<{ provider: ProviderConfig; model: ProviderModel; ref: ModelRef }> {
  return getProviderConfigs()
    .filter((provider) => provider.enabled !== false)
    .flatMap((provider) =>
      getConfiguredProviderModels(provider)
        .filter((model) => model.capabilities.includes(capability))
        .map((model) => ({
          provider,
          model,
          ref: { providerId: provider.id, localModelId: model.id },
        })),
    );
}

export function requireResolvedModel(
  capability: ModelType,
  override?: ModelRef,
): ResolvedModel {
  const resolved = resolveModel(capability, override);
  if (!resolved) {
    throw new Error(
      `No ${MODEL_TYPE_ENDPOINTS[capability].label.toLowerCase()} model is configured. Add a provider and choose a default model in Settings > AI Models.`,
    );
  }
  return resolved;
}
