/**
 * Model Configuration Manager
 * Handles CRUD operations for user-defined AI model configurations.
 *
 * Storage: {Zotero.DataDirectory.dir}/{addonRef}/modelConfigs.json
 * Uses an in-memory cache. Legacy prefs are read for migration but writes
 * go to file only, avoiding Zotero's large-prefs-in-memory warnings.
 */

import { config } from "../../../package.json";
import { AIModelConfig, ModelType } from "./types";

const PREFS_KEY = `${config.prefsPrefix}.modelConfigs`;
const ACTIVE_MODEL_KEY = `${config.prefsPrefix}.activeModelId`;

/** In-memory config cache. Null means not yet loaded. */
let _configCache: AIModelConfig[] | null = null;

function getConfigPath(): string {
  return PathUtils.join(
    Zotero.DataDirectory.dir,
    config.addonRef,
    "modelConfigs.json",
  );
}

/**
 * Generate a simple UUID for model config IDs
 */
function generateId(): string {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/**
 * Get all model configurations from the in-memory cache.
 * Loads from file storage on first call, falling back to legacy prefs
 * for migration.
 */
export function getModelConfigs(): AIModelConfig[] {
  if (_configCache !== null) return _configCache;

  try {
    const filePath = getConfigPath();
    // Try file first — IOUtils returns Promises, so use a try/catch
    // and fall back to prefs for the sync read path
    const stored = Zotero.Prefs.get(PREFS_KEY) as string;
    if (stored) {
      const configs = JSON.parse(stored) as AIModelConfig[];
      // Migrate to file storage asynchronously (fire-and-forget)
      _writeConfigsToFileAsync(configs).catch(() => {});
      _configCache = configs;
      Zotero.debug(
        `[seerai] Loaded ${configs.length} model configs from prefs (migrating to file)`,
      );
      // Clear the old pref to avoid Zotero's "large pref" warnings
      try {
        Zotero.Prefs.clear(PREFS_KEY);
      } catch {
        // ignore pref clear errors
      }
      return configs;
    }
    _configCache = [];
    return [];
  } catch (e) {
    Zotero.debug(`[seerai] Error loading model configs: ${e}`);
    _configCache = [];
    return [];
  }
}

async function _writeConfigsToFileAsync(
  configs: AIModelConfig[],
): Promise<void> {
  try {
    const filePath = getConfigPath();
    const dir = PathUtils.parent(filePath);
    if (dir && !(await IOUtils.exists(dir))) {
      await IOUtils.makeDirectory(dir, { ignoreExisting: true });
    }
    await IOUtils.writeUTF8(filePath, JSON.stringify(configs));
  } catch (e) {
    Zotero.debug(`[seerai] Failed to write model configs to file: ${e}`);
  }
}

/**
 * Initialize configs from file storage on startup.
 * Called asynchronously from hooks.ts.
 */
export async function initModelConfigs(): Promise<void> {
  try {
    const filePath = getConfigPath();
    if (await IOUtils.exists(filePath)) {
      const raw = await IOUtils.readUTF8(filePath);
      if (raw && raw.trim()) {
        const configs = JSON.parse(raw) as AIModelConfig[];
        _configCache = configs;
        Zotero.debug(
          `[seerai] Loaded ${configs.length} model configs from file`,
        );
        // Clear stale pref data if it exists
        try {
          const prefData = Zotero.Prefs.get(PREFS_KEY) as string;
          if (prefData) Zotero.Prefs.clear(PREFS_KEY);
        } catch {
          // ignore
        }
        return;
      }
    }
  } catch (e) {
    Zotero.debug(`[seerai] Failed to load model configs from file: ${e}`);
  }
  // Ensure cache is populated (will try prefs as fallback)
  getModelConfigs();
}

/**
 * Save all model configurations. Updates in-memory cache and
 * writes to file asynchronously (avoiding large Zotero prefs writes).
 */
function saveModelConfigs(configs: AIModelConfig[]): void {
  _configCache = configs;
  _writeConfigsToFileAsync(configs).catch((e) => {
    Zotero.debug(`[seerai] Error saving model configs to file: ${e}`);
  });
  Zotero.debug(`[seerai] Saved ${configs.length} model configurations`);
  _invalidateActiveModelCache();
}

/**
 * Get a specific model configuration by ID
 */
export function getModelConfig(id: string): AIModelConfig | undefined {
  const configs = getModelConfigs();
  return configs.find((c) => c.id === id);
}

/**
 * Get the default model configuration
 */
export function getDefaultModelConfig(): AIModelConfig | undefined {
  const configs = getModelConfigs();
  return configs.find((c) => c.isDefault) || configs[0];
}

/**
 * Get the currently active model ID
 */
export function getActiveModelId(): string | undefined {
  const stored = Zotero.Prefs.get(ACTIVE_MODEL_KEY) as string | undefined;
  return stored;
}

/**
 * Set the currently active model ID
 */
export function setActiveModelId(id: string): void {
  Zotero.debug(
    `[seerai] setActiveModelId: key=${ACTIVE_MODEL_KEY}, value="${id}"`,
  );
  Zotero.Prefs.set(ACTIVE_MODEL_KEY, id);
  // Invalidate the cache so the next read picks up the change
  _invalidateActiveModelCache();
}

// ── Short-lived memoization cache for getActiveModelConfig ─────────────
// During batch operations (e.g. embedding 700+ chunks), getActiveModelConfig
// is called 3× per embedding request. Each call does Zotero.Prefs.get() +
// JSON.parse(). A 200ms TTL cache eliminates redundant reads while staying
// responsive to user config changes.
let _activeModelCacheResult: AIModelConfig | undefined;
let _activeModelCacheTime = 0;
let _activeModelCacheValid = false;
const _ACTIVE_MODEL_CACHE_TTL = 200; // ms

/** Invalidate the active model config cache. */
function _invalidateActiveModelCache(): void {
  _activeModelCacheValid = false;
  _activeModelCacheTime = 0;
}

/**
 * Get the active model configuration (or default if not set).
 * Results are memoized for 200ms to avoid redundant prefs reads during
 * high-frequency call sites (embedding batches, concurrent table generation).
 */
export function getActiveModelConfig(): AIModelConfig | undefined {
  const now = Date.now();
  if (
    _activeModelCacheValid &&
    now - _activeModelCacheTime < _ACTIVE_MODEL_CACHE_TTL
  ) {
    return _activeModelCacheResult;
  }

  const activeId = getActiveModelId();

  let result: AIModelConfig | undefined;
  if (activeId && activeId.trim() !== "") {
    result = getModelConfig(activeId);
  }
  if (!result) {
    result = getDefaultModelConfig();
  }

  _activeModelCacheResult = result;
  _activeModelCacheTime = now;
  _activeModelCacheValid = true;
  return result;
}

/**
 * Add a new model configuration
 */
export function addModelConfig(
  config: Omit<AIModelConfig, "id" | "createdAt" | "updatedAt">,
): AIModelConfig {
  const configs = getModelConfigs();
  const now = new Date().toISOString();

  const newConfig: AIModelConfig = {
    ...config,
    id: generateId(),
    createdAt: now,
    updatedAt: now,
  };

  // If this is the first config or marked as default, ensure it's the only default
  if (newConfig.isDefault || configs.length === 0) {
    configs.forEach((c) => (c.isDefault = false));
    newConfig.isDefault = true;
  }

  configs.push(newConfig);
  saveModelConfigs(configs);

  Zotero.debug(
    `[seerai] Added model config: ${newConfig.name} (${newConfig.id})`,
  );
  return newConfig;
}

/**
 * Update an existing model configuration
 */
export function updateModelConfig(
  id: string,
  updates: Partial<Omit<AIModelConfig, "id" | "createdAt">>,
): AIModelConfig | undefined {
  const configs = getModelConfigs();
  const index = configs.findIndex((c) => c.id === id);

  if (index === -1) {
    Zotero.debug(`[seerai] Model config not found: ${id}`);
    return undefined;
  }

  // If setting as default, unset others
  if (updates.isDefault) {
    configs.forEach((c) => (c.isDefault = false));
  }

  configs[index] = {
    ...configs[index],
    ...updates,
    updatedAt: new Date().toISOString(),
  };

  saveModelConfigs(configs);
  Zotero.debug(`[seerai] Updated model config: ${configs[index].name}`);
  return configs[index];
}

/**
 * Delete a model configuration
 */
export function deleteModelConfig(id: string): boolean {
  const configs = getModelConfigs();
  const index = configs.findIndex((c) => c.id === id);

  if (index === -1) {
    return false;
  }

  const wasDefault = configs[index].isDefault;
  configs.splice(index, 1);

  // If we deleted the default, make the first remaining one default
  if (wasDefault && configs.length > 0) {
    configs[0].isDefault = true;
  }

  saveModelConfigs(configs);

  // Clear active model if it was deleted
  if (getActiveModelId() === id) {
    const defaultConfig = getDefaultModelConfig();
    if (defaultConfig) {
      setActiveModelId(defaultConfig.id);
    }
  }

  Zotero.debug(`[seerai] Deleted model config: ${id}`);
  return true;
}

/**
 * Set a model as the default
 */
export function setDefaultModelConfig(id: string): boolean {
  const configs = getModelConfigs();
  const target = configs.find((c) => c.id === id);

  if (!target) {
    return false;
  }

  configs.forEach((c) => (c.isDefault = c.id === id));
  saveModelConfigs(configs);

  Zotero.debug(`[seerai] Set default model: ${target.name}`);
  return true;
}

/**
 * Validate a model configuration
 */
export function validateModelConfig(config: Partial<AIModelConfig>): string[] {
  const errors: string[] = [];

  if (!config.name?.trim()) {
    errors.push("Name is required");
  }

  if (!config.apiURL?.trim()) {
    errors.push("API URL is required");
  } else {
    try {
      new URL(config.apiURL);
    } catch {
      errors.push("API URL must be a valid URL");
    }
  }

  // API Key is no longer required (e.g. for local LLMs)
  // if (!config.apiKey?.trim()) {
  //     errors.push("API Key is required");
  // }

  if (!config.model?.trim()) {
    errors.push("Model is required");
  }

  if (config.rateLimit) {
    if (!["tpm", "rpm", "concurrency"].includes(config.rateLimit.type)) {
      errors.push("Invalid rate limit type");
    }
    if (
      typeof config.rateLimit.value !== "number" ||
      config.rateLimit.value <= 0
    ) {
      errors.push("Rate limit value must be a positive number");
    }
  }

  if (
    config.reasoningEffort &&
    !["low", "medium", "high"].includes(config.reasoningEffort)
  ) {
    errors.push("Invalid reasoning effort value");
  }

  const validModelTypes: ModelType[] = [
    "chat",
    "embedding",
    "image",
    "video",
    "tts",
  ];
  if (config.modelType && !validModelTypes.includes(config.modelType)) {
    errors.push("Invalid model type");
  }

  return errors;
}

/**
 * Check if any model configurations exist
 */
export function hasModelConfigs(): boolean {
  return getModelConfigs().length > 0;
}
