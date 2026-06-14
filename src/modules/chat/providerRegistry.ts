/**
 * Provider Configuration Registry
 * Handles CRUD operations for user-defined AI provider configurations.
 *
 * Storage: {Zotero.DataDirectory.dir}/{addonRef}/providerConfigs.json
 * Uses an in-memory cache with async file writes, same pattern as modelConfig.ts.
 */

import { config } from "../../../package.json";
import { ProviderConfig } from "./providerTypes";

const PROVIDER_CONFIGS_FILE = "providerConfigs.json";

/** In-memory provider config cache. Null means not yet loaded. */
let _providerCache: ProviderConfig[] | null = null;

function getConfigPath(): string {
  return PathUtils.join(
    Zotero.DataDirectory.dir,
    config.addonRef,
    PROVIDER_CONFIGS_FILE,
  );
}

/**
 * Generate a UUID v4 for provider config IDs.
 */
function generateId(): string {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/**
 * Get all provider configurations from the in-memory cache.
 * Loads from file on first call.
 */
export function getProviderConfigs(): ProviderConfig[] {
  if (_providerCache !== null) return _providerCache;

  // Cache not yet populated — initProviderConfigs() should have been called
  // during startup, but handle the fallback case.
  _providerCache = [];
  return _providerCache;
}

/**
 * Initialize provider configs from file storage on startup.
 * Called asynchronously from hooks.ts.
 */
export async function initProviderConfigs(): Promise<void> {
  try {
    const filePath = getConfigPath();
    if (await IOUtils.exists(filePath)) {
      const raw = await IOUtils.readUTF8(filePath);
      if (raw && raw.trim()) {
        const configs = JSON.parse(raw) as ProviderConfig[];
        _providerCache = configs;
        Zotero.debug(
          `[seerai] Loaded ${configs.length} provider configs from file`,
        );
        return;
      }
    }
  } catch (e) {
    Zotero.debug(`[seerai] Failed to load provider configs from file: ${e}`);
  }
  // Ensure cache is populated with empty array if file doesn't exist yet
  _providerCache = [];
}

/**
 * Async write helper — writes provider configs to disk.
 */
async function _writeConfigsToFileAsync(
  configs: ProviderConfig[],
): Promise<void> {
  try {
    const filePath = getConfigPath();
    const dir = PathUtils.parent(filePath);
    if (dir && !(await IOUtils.exists(dir))) {
      await IOUtils.makeDirectory(dir, { ignoreExisting: true });
    }
    await IOUtils.writeUTF8(filePath, JSON.stringify(configs));
  } catch (e) {
    Zotero.debug(`[seerai] Failed to write provider configs to file: ${e}`);
  }
}

/**
 * Save all provider configurations. Updates in-memory cache and
 * writes to file asynchronously.
 */
export function saveProviderConfigs(configs: ProviderConfig[]): void {
  _providerCache = configs;
  _writeConfigsToFileAsync(configs).catch((e) => {
    Zotero.debug(`[seerai] Error saving provider configs to file: ${e}`);
  });
  Zotero.debug(`[seerai] Saved ${configs.length} provider configurations`);
}

/**
 * Get a specific provider configuration by ID.
 */
export function getProviderConfig(id: string): ProviderConfig | undefined {
  const configs = getProviderConfigs();
  return configs.find((c) => c.id === id);
}

/**
 * Add a new provider configuration.
 * Generates UUID and sets timestamps automatically.
 */
export function addProviderConfig(
  configData: Omit<ProviderConfig, "id" | "createdAt" | "updatedAt">,
): ProviderConfig {
  const configs = getProviderConfigs();
  const now = new Date().toISOString();

  const newConfig: ProviderConfig = {
    ...configData,
    id: generateId(),
    createdAt: now,
    updatedAt: now,
  };

  configs.push(newConfig);
  saveProviderConfigs(configs);

  Zotero.debug(
    `[seerai] Added provider config: ${newConfig.name} (${newConfig.id})`,
  );
  return newConfig;
}

/**
 * Update an existing provider configuration.
 * Applies partial updates and sets updatedAt timestamp.
 */
export function updateProviderConfig(
  id: string,
  updates: Partial<Omit<ProviderConfig, "id" | "createdAt">>,
): ProviderConfig | undefined {
  const configs = getProviderConfigs();
  const index = configs.findIndex((c) => c.id === id);

  if (index === -1) {
    Zotero.debug(`[seerai] Provider config not found: ${id}`);
    return undefined;
  }

  configs[index] = {
    ...configs[index],
    ...updates,
    updatedAt: new Date().toISOString(),
  };

  saveProviderConfigs(configs);
  Zotero.debug(`[seerai] Updated provider config: ${configs[index].name}`);
  return configs[index];
}

/**
 * Delete a provider configuration by ID.
 * Returns true if the config was found and removed, false otherwise.
 */
export function deleteProviderConfig(id: string): boolean {
  const configs = getProviderConfigs();
  const index = configs.findIndex((c) => c.id === id);

  if (index === -1) {
    return false;
  }

  configs.splice(index, 1);
  saveProviderConfigs(configs);

  Zotero.debug(`[seerai] Deleted provider config: ${id}`);
  return true;
}

/**
 * Find a provider configuration by its linked preset ID.
 */
export function getProviderConfigByPresetId(
  presetId: string,
): ProviderConfig | undefined {
  const configs = getProviderConfigs();
  return configs.find((c) => c.presetId === presetId);
}
