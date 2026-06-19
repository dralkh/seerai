import { config } from "../../../package.json";
import type { AIModelConfig, ModelType } from "./types";
import {
  formatModelDisplayName,
  inferCapabilities,
  type ModelCapability,
  type ModelRef,
  type ModelRoutingPreset,
  type ProviderConfig,
  type ProviderModel,
  type ProviderRegistryState,
} from "./providerTypes";
import { getPresetById, providerPresets } from "./providerPresets";

const PROVIDER_CONFIGS_FILE = "providerConfigs.json";
const LEGACY_MODEL_CONFIGS_FILE = "modelConfigs.json";
const ACTIVE_MODEL_KEY = `${config.prefsPrefix}.activeModelId`;
const LEGACY_MODELS_PREF = `${config.prefsPrefix}.modelConfigs`;

let state: ProviderRegistryState | null = null;
let writeQueue: Promise<void> = Promise.resolve();
const listeners = new Set<() => void>();

function configPath(file: string): string {
  return PathUtils.join(Zotero.DataDirectory.dir, config.addonRef, file);
}

function generateId(): string {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function emptyState(): ProviderRegistryState {
  return { version: 2, providers: [], defaults: {}, routingPresets: [] };
}

function normalizeProvider(provider: ProviderConfig): ProviderConfig {
  const preset = provider.presetId
    ? getPresetById(provider.presetId)
    : undefined;
  return {
    ...provider,
    adapterId: provider.adapterId || preset?.adapterId || "openai-compatible",
    enabled: provider.enabled ?? provider.isActive ?? true,
    isActive: provider.isActive ?? true,
    modelPolicy: provider.modelPolicy || "automatic",
    configuredModels: provider.configuredModels || [],
    models: provider.models || [],
  };
}

function providerFingerprint(configValue: AIModelConfig): string {
  return `${configValue.apiURL.trim().replace(/\/+$/, "").toLowerCase()}\n${configValue.apiKey}`;
}

function presetForURL(apiURL: string) {
  const normalized = apiURL.replace(/\/+$/, "").toLowerCase();
  return providerPresets.find(
    (preset) => preset.apiURL.replace(/\/+$/, "").toLowerCase() === normalized,
  );
}

function modelFromLegacy(
  modelId: string,
  capability: ModelCapability,
  legacy: AIModelConfig,
  endpoint?: string,
): ProviderModel {
  const now = new Date().toISOString();
  return {
    id: generateId(),
    modelId,
    displayName: formatModelDisplayName(modelId),
    capabilities: Array.from(
      new Set<ModelCapability>([
        capability,
        ...(capability === "chat" ? inferCapabilities(modelId) : []),
      ]),
    ),
    ...(endpoint && { endpointOverrides: { [capability]: endpoint } }),
    ...(capability === "chat" && legacy.contextLength
      ? { contextLength: legacy.contextLength }
      : {}),
    ...(capability === "chat" && legacy.reasoningEffort
      ? { reasoningEffort: legacy.reasoningEffort }
      : {}),
    ...(capability === "chat" && legacy.toolChoice
      ? { toolChoice: legacy.toolChoice }
      : {}),
    ...(capability === "chat" && legacy.rateLimit
      ? { rateLimit: legacy.rateLimit }
      : {}),
    createdAt: legacy.createdAt || now,
    updatedAt: legacy.updatedAt || now,
  };
}

export function migrateLegacyModels(
  legacyModels: AIModelConfig[],
  base: ProviderRegistryState,
  activeId?: string,
): ProviderRegistryState {
  if (legacyModels.length === 0) return base;
  const providers = [...base.providers];
  const legacyRefs = new Map<string, Partial<Record<ModelType, ModelRef>>>();

  for (const legacy of legacyModels) {
    const fingerprint = providerFingerprint(legacy);
    let provider = providers.find(
      (candidate) =>
        (candidate as ProviderConfig & { legacyFingerprint?: string })
          .legacyFingerprint === fingerprint,
    );
    if (!provider) {
      const preset = presetForURL(legacy.apiURL);
      const now = new Date().toISOString();
      provider = normalizeProvider({
        id: generateId(),
        presetId: preset?.id,
        name: preset?.name || legacy.name,
        apiURL: legacy.apiURL,
        apiKey: legacy.apiKey,
        authMethod: preset?.authMethod || "bearer",
        authHeaderName: preset?.authHeaderName,
        authPrefix: preset?.authPrefix,
        extraHeaders: preset?.extraHeaders,
        models: [],
        configuredModels: [],
        modelPolicy: "scoped",
        isActive: true,
        enabled: true,
        adapterId: preset?.adapterId || "openai-compatible",
        createdAt: legacy.createdAt || now,
        updatedAt: legacy.updatedAt || now,
      });
      Object.assign(provider, { legacyFingerprint: fingerprint });
      providers.push(provider);
    }

    const refs: Partial<Record<ModelType, ModelRef>> = {};
    const add = (
      capability: ModelType,
      modelId: string | undefined,
      endpoint?: string,
      settings?: { voice?: string; dimensions?: number; maxTokens?: number },
    ) => {
      if (!modelId) return;
      const model = modelFromLegacy(modelId, capability, legacy, endpoint);
      if (settings?.voice) model.voice = settings.voice;
      if (settings?.dimensions) model.dimensions = settings.dimensions;
      if (settings?.maxTokens) model.maxTokens = settings.maxTokens;
      provider!.configuredModels!.push(model);
      refs[capability] = {
        providerId: provider!.id,
        localModelId: model.id,
      };
    };

    add("chat", legacy.model);
    add("tts", legacy.ttsConfig?.model, legacy.ttsConfig?.endpoint, {
      voice: legacy.ttsConfig?.voice,
    });
    add("stt", legacy.sttConfig?.model, legacy.sttConfig?.endpoint);
    add(
      "embedding",
      legacy.embeddingConfig?.model,
      legacy.embeddingConfig?.endpoint,
      {
        dimensions: legacy.embeddingConfig?.dimensions,
        maxTokens: legacy.embeddingConfig?.maxTokens,
      },
    );
    add("image", legacy.imageConfig?.model, legacy.imageConfig?.endpoint);
    add("video", legacy.videoConfig?.model, legacy.videoConfig?.endpoint);
    legacyRefs.set(legacy.id, refs);
  }

  for (const provider of providers) {
    delete (provider as ProviderConfig & { legacyFingerprint?: string })
      .legacyFingerprint;
  }

  const selected =
    legacyModels.find((item) => item.id === activeId) ||
    legacyModels.find((item) => item.isDefault) ||
    legacyModels[0];
  const selectedRefs = selected ? legacyRefs.get(selected.id) : undefined;
  return {
    version: 2,
    providers,
    defaults: { ...base.defaults, ...selectedRefs },
    migratedAt: new Date().toISOString(),
  };
}

async function readLegacyModels(): Promise<AIModelConfig[]> {
  const legacyPath = configPath(LEGACY_MODEL_CONFIGS_FILE);
  try {
    if (await IOUtils.exists(legacyPath)) {
      const raw = await IOUtils.readUTF8(legacyPath);
      const parsed = JSON.parse(raw || "[]") as AIModelConfig[];
      if (Array.isArray(parsed)) return parsed;
    }
  } catch (error) {
    Zotero.debug(`[seerai] Failed to read legacy model configs: ${error}`);
  }
  try {
    const raw = Zotero.Prefs.get(LEGACY_MODELS_PREF) as string | undefined;
    const parsed = JSON.parse(raw || "[]") as AIModelConfig[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function persist(): Promise<void> {
  if (!state) return;
  const snapshot = JSON.stringify(state);
  writeQueue = writeQueue.then(async () => {
    const filePath = configPath(PROVIDER_CONFIGS_FILE);
    const dir = PathUtils.parent(filePath);
    if (dir && !(await IOUtils.exists(dir))) {
      await IOUtils.makeDirectory(dir, { ignoreExisting: true });
    }
    await Zotero.File.putContentsAsync(filePath, snapshot);
  });
  await writeQueue;
}

function changed(): void {
  void persist().catch((error) => {
    Zotero.debug(`[seerai] Failed to save provider registry: ${error}`);
  });
  listeners.forEach((listener) => listener());
}

export async function initProviderConfigs(): Promise<void> {
  let loaded = emptyState();
  let needsMigration = false;
  const filePath = configPath(PROVIDER_CONFIGS_FILE);
  try {
    if (await IOUtils.exists(filePath)) {
      const raw = await IOUtils.readUTF8(filePath);
      const parsed = JSON.parse(raw || "[]") as
        | ProviderRegistryState
        | ProviderConfig[];
      if (Array.isArray(parsed)) {
        loaded.providers = parsed.map(normalizeProvider);
        needsMigration = true;
      } else if (parsed.version === 2) {
        loaded = {
          ...parsed,
          providers: parsed.providers.map(normalizeProvider),
          routingPresets: parsed.routingPresets || [],
        };
      }
    } else {
      needsMigration = true;
    }
  } catch (error) {
    Zotero.debug(`[seerai] Failed to load provider registry: ${error}`);
    needsMigration = true;
  }

  if (needsMigration || !loaded.migratedAt) {
    loaded = migrateLegacyModels(
      await readLegacyModels(),
      loaded,
      Zotero.Prefs.get(ACTIVE_MODEL_KEY) as string | undefined,
    );
  }
  state = loaded;
  await persist();
}

export function getProviderRegistryState(): ProviderRegistryState {
  if (!state) state = emptyState();
  return state;
}

export function replaceProviderRegistryState(
  value: ProviderRegistryState,
): void {
  state = {
    version: 2,
    providers: value.providers.map(normalizeProvider),
    defaults: { ...value.defaults },
    routingPresets: [...(value.routingPresets || [])],
    migratedAt: value.migratedAt || new Date().toISOString(),
  };
  changed();
}

export function subscribeProviderRegistry(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getProviderConfigs(): ProviderConfig[] {
  return getProviderRegistryState().providers;
}

export function saveProviderConfigs(configs: ProviderConfig[]): void {
  getProviderRegistryState().providers = configs.map(normalizeProvider);
  changed();
}

export function getProviderConfig(id: string): ProviderConfig | undefined {
  return getProviderConfigs().find((provider) => provider.id === id);
}

export function addProviderConfig(
  value: Omit<ProviderConfig, "id" | "createdAt" | "updatedAt">,
): ProviderConfig {
  const now = new Date().toISOString();
  const provider = normalizeProvider({
    ...value,
    id: generateId(),
    createdAt: now,
    updatedAt: now,
  });
  getProviderConfigs().push(provider);
  changed();
  return provider;
}

export function updateProviderConfig(
  id: string,
  updates: Partial<Omit<ProviderConfig, "id" | "createdAt">>,
): ProviderConfig | undefined {
  const providers = getProviderConfigs();
  const index = providers.findIndex((provider) => provider.id === id);
  if (index < 0) return undefined;
  providers[index] = normalizeProvider({
    ...providers[index],
    ...updates,
    updatedAt: new Date().toISOString(),
  });
  changed();
  return providers[index];
}

export function deleteProviderConfig(id: string): boolean {
  const registry = getProviderRegistryState();
  const index = registry.providers.findIndex((provider) => provider.id === id);
  if (index < 0) return false;
  registry.providers.splice(index, 1);
  for (const capability of Object.keys(registry.defaults) as ModelType[]) {
    if (registry.defaults[capability]?.providerId === id) {
      delete registry.defaults[capability];
    }
  }
  for (const preset of registry.routingPresets || []) {
    for (const capability of Object.keys(preset.models) as ModelType[]) {
      if (preset.models[capability]?.providerId === id) {
        delete preset.models[capability];
      }
    }
  }
  changed();
  return true;
}

export function getProviderConfigByPresetId(
  presetId: string,
): ProviderConfig | undefined {
  return getProviderConfigs().find(
    (provider) => provider.presetId === presetId,
  );
}

export function getDefaultModelRef(
  capability: ModelType,
): ModelRef | undefined {
  return getProviderRegistryState().defaults[capability];
}

export function setDefaultModelRef(
  capability: ModelType,
  ref: ModelRef | undefined,
): void {
  const defaults = getProviderRegistryState().defaults;
  if (ref) defaults[capability] = ref;
  else delete defaults[capability];
  changed();
}

export function getModelRoutingPresets(): ModelRoutingPreset[] {
  return getProviderRegistryState().routingPresets || [];
}

export function saveModelRoutingPreset(
  name: string,
  models: ModelRoutingPreset["models"] = {
    ...getProviderRegistryState().defaults,
  },
): ModelRoutingPreset {
  const registry = getProviderRegistryState();
  const now = new Date().toISOString();
  const existing = getModelRoutingPresets().find(
    (preset) => preset.name.toLowerCase() === name.trim().toLowerCase(),
  );
  if (existing) {
    existing.models = { ...models };
    existing.updatedAt = now;
    changed();
    return existing;
  }
  const preset: ModelRoutingPreset = {
    id: generateId(),
    name: name.trim(),
    models: { ...models },
    createdAt: now,
    updatedAt: now,
  };
  registry.routingPresets = [...getModelRoutingPresets(), preset];
  changed();
  return preset;
}

export function applyModelRoutingPreset(id: string): boolean {
  const preset = getModelRoutingPresets().find((item) => item.id === id);
  if (!preset) return false;
  const defaults: ProviderRegistryState["defaults"] = {};
  for (const capability of Object.keys(preset.models) as ModelType[]) {
    const ref = preset.models[capability];
    const provider = ref ? getProviderConfig(ref.providerId) : undefined;
    const model = provider
      ? getConfiguredProviderModels(provider).find(
          (item) =>
            item.id === ref?.localModelId &&
            item.capabilities.includes(capability),
        )
      : undefined;
    if (ref && provider?.enabled !== false && model) {
      defaults[capability] = ref;
    }
  }
  getProviderRegistryState().defaults = defaults;
  changed();
  return true;
}

export function updateModelRoutingPreset(
  id: string,
  models: ModelRoutingPreset["models"],
): ModelRoutingPreset | undefined {
  const preset = getModelRoutingPresets().find((item) => item.id === id);
  if (!preset) return undefined;
  preset.models = { ...models };
  preset.updatedAt = new Date().toISOString();
  changed();
  return preset;
}

export function renameModelRoutingPreset(
  id: string,
  name: string,
): ModelRoutingPreset | undefined {
  const preset = renameModelRoutingPresetInState(
    getProviderRegistryState(),
    id,
    name,
  );
  if (preset) changed();
  return preset;
}

export function renameModelRoutingPresetInState(
  registry: ProviderRegistryState,
  id: string,
  name: string,
): ModelRoutingPreset | undefined {
  const normalizedName = name.trim();
  if (!normalizedName) return undefined;
  const presets = registry.routingPresets || [];
  if (
    presets.some(
      (item) =>
        item.id !== id &&
        item.name.toLowerCase() === normalizedName.toLowerCase(),
    )
  ) {
    return undefined;
  }
  const preset = presets.find((item) => item.id === id);
  if (!preset) return undefined;
  preset.name = normalizedName;
  preset.updatedAt = new Date().toISOString();
  return preset;
}

export function deleteModelRoutingPreset(id: string): boolean {
  const registry = getProviderRegistryState();
  const presets = getModelRoutingPresets();
  const next = presets.filter((preset) => preset.id !== id);
  if (next.length === presets.length) return false;
  registry.routingPresets = next;
  changed();
  return true;
}

export function getConfiguredProviderModels(
  provider: ProviderConfig,
): ProviderModel[] {
  if (provider.modelPolicy === "scoped") {
    return provider.configuredModels || [];
  }
  const configuredByRemoteId = new Map(
    (provider.configuredModels || []).map((model) => [model.modelId, model]),
  );
  return provider.models.map((model) => {
    const configured = configuredByRemoteId.get(model.id);
    if (configured) return configured;
    const now = provider.modelsLastFetched || provider.updatedAt;
    return {
      id: `discovered:${model.id}`,
      modelId: model.id,
      displayName: model.displayName || formatModelDisplayName(model.id),
      capabilities: model.capabilities || inferCapabilities(model.id),
      contextLength: model.contextLength,
      createdAt: now,
      updatedAt: now,
    };
  });
}

export function addProviderModel(
  providerId: string,
  model: Omit<ProviderModel, "id" | "createdAt" | "updatedAt">,
): ProviderModel | undefined {
  const provider = getProviderConfig(providerId);
  if (!provider) return undefined;
  const now = new Date().toISOString();
  const created: ProviderModel = {
    ...model,
    id: generateId(),
    createdAt: now,
    updatedAt: now,
  };
  provider.configuredModels = [...(provider.configuredModels || []), created];
  provider.modelPolicy = "scoped";
  provider.updatedAt = now;
  changed();
  return created;
}

export function updateProviderModel(
  providerId: string,
  localModelId: string,
  updates: Partial<Omit<ProviderModel, "id" | "createdAt">>,
): ProviderModel | undefined {
  const provider = getProviderConfig(providerId);
  if (!provider) return undefined;
  const updated = mergeProviderModelUpdate(provider, localModelId, updates);
  if (!updated) return undefined;
  changed();
  return updated;
}

export function mergeProviderModelUpdate(
  provider: ProviderConfig,
  localModelId: string,
  updates: Partial<Omit<ProviderModel, "id" | "createdAt">>,
): ProviderModel | undefined {
  const index = provider.configuredModels?.findIndex(
    (model) => model.id === localModelId,
  );
  if (index === undefined || index < 0) {
    const discovered = getConfiguredProviderModels(provider).find(
      (model) => model.id === localModelId,
    );
    if (!discovered) return undefined;
    const configured = {
      ...discovered,
      ...updates,
      updatedAt: new Date().toISOString(),
    };
    provider.configuredModels = [
      ...(provider.configuredModels || []),
      configured,
    ];
    return configured;
  }
  provider.configuredModels![index] = {
    ...provider.configuredModels![index],
    ...updates,
    updatedAt: new Date().toISOString(),
  };
  return provider.configuredModels![index];
}

export function deleteProviderModel(
  providerId: string,
  localModelId: string,
): boolean {
  const registry = getProviderRegistryState();
  const provider = registry.providers.find((item) => item.id === providerId);
  const index = provider?.configuredModels?.findIndex(
    (model) => model.id === localModelId,
  );
  if (!provider || index === undefined || index < 0) return false;
  provider.configuredModels!.splice(index, 1);
  for (const capability of Object.keys(registry.defaults) as ModelType[]) {
    const ref = registry.defaults[capability];
    if (ref?.providerId === providerId && ref.localModelId === localModelId) {
      delete registry.defaults[capability];
    }
  }
  for (const preset of registry.routingPresets || []) {
    for (const capability of Object.keys(preset.models) as ModelType[]) {
      const ref = preset.models[capability];
      if (ref?.providerId === providerId && ref.localModelId === localModelId) {
        delete preset.models[capability];
      }
    }
  }
  changed();
  return true;
}

export function setProviderModelPolicy(
  providerId: string,
  policy: "automatic" | "scoped",
): void {
  const provider = getProviderConfig(providerId);
  if (!provider) return;
  provider.modelPolicy = policy;
  if (policy === "automatic") provider.configuredModels = [];
  provider.updatedAt = new Date().toISOString();
  changed();
}

export function replaceDiscoveredModels(
  providerId: string,
  models: ProviderConfig["models"],
): void {
  const provider = getProviderConfig(providerId);
  if (!provider) return;
  provider.models = models;
  provider.modelsLastFetched = new Date().toISOString();
  provider.updatedAt = provider.modelsLastFetched;
  changed();
}
