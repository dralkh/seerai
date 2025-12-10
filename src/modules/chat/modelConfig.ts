/**
 * Model Configuration Manager
 * Handles CRUD operations for user-defined AI model configurations
 */

import { config } from "../../../package.json";
import { AIModelConfig } from "./types";

const PREFS_KEY = `${config.prefsPrefix}.modelConfigs`;
const ACTIVE_MODEL_KEY = `${config.prefsPrefix}.activeModelId`;

/**
 * Generate a simple UUID for model config IDs
 */
function generateId(): string {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = Math.random() * 16 | 0;
        const v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}

/**
 * Get all model configurations from preferences
 */
export function getModelConfigs(): AIModelConfig[] {
    try {
        const stored = Zotero.Prefs.get(PREFS_KEY) as string;
        if (!stored) return [];
        return JSON.parse(stored) as AIModelConfig[];
    } catch (e) {
        Zotero.debug(`[Seer AI] Error loading model configs: ${e}`);
        return [];
    }
}

/**
 * Save all model configurations to preferences
 */
function saveModelConfigs(configs: AIModelConfig[]): void {
    try {
        Zotero.Prefs.set(PREFS_KEY, JSON.stringify(configs));
        Zotero.debug(`[Seer AI] Saved ${configs.length} model configurations`);
    } catch (e) {
        Zotero.debug(`[Seer AI] Error saving model configs: ${e}`);
    }
}

/**
 * Get a specific model configuration by ID
 */
export function getModelConfig(id: string): AIModelConfig | undefined {
    const configs = getModelConfigs();
    return configs.find(c => c.id === id);
}

/**
 * Get the default model configuration
 */
export function getDefaultModelConfig(): AIModelConfig | undefined {
    const configs = getModelConfigs();
    return configs.find(c => c.isDefault) || configs[0];
}

/**
 * Get the currently active model ID
 */
export function getActiveModelId(): string | undefined {
    return Zotero.Prefs.get(ACTIVE_MODEL_KEY) as string | undefined;
}

/**
 * Set the currently active model ID
 */
export function setActiveModelId(id: string): void {
    Zotero.Prefs.set(ACTIVE_MODEL_KEY, id);
}

/**
 * Get the active model configuration (or default if not set)
 */
export function getActiveModelConfig(): AIModelConfig | undefined {
    const activeId = getActiveModelId();
    if (activeId) {
        const config = getModelConfig(activeId);
        if (config) return config;
    }
    return getDefaultModelConfig();
}

/**
 * Add a new model configuration
 */
export function addModelConfig(config: Omit<AIModelConfig, 'id' | 'createdAt' | 'updatedAt'>): AIModelConfig {
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
        configs.forEach(c => c.isDefault = false);
        newConfig.isDefault = true;
    }

    configs.push(newConfig);
    saveModelConfigs(configs);

    Zotero.debug(`[Seer AI] Added model config: ${newConfig.name} (${newConfig.id})`);
    return newConfig;
}

/**
 * Update an existing model configuration
 */
export function updateModelConfig(id: string, updates: Partial<Omit<AIModelConfig, 'id' | 'createdAt'>>): AIModelConfig | undefined {
    const configs = getModelConfigs();
    const index = configs.findIndex(c => c.id === id);

    if (index === -1) {
        Zotero.debug(`[Seer AI] Model config not found: ${id}`);
        return undefined;
    }

    // If setting as default, unset others
    if (updates.isDefault) {
        configs.forEach(c => c.isDefault = false);
    }

    configs[index] = {
        ...configs[index],
        ...updates,
        updatedAt: new Date().toISOString(),
    };

    saveModelConfigs(configs);
    Zotero.debug(`[Seer AI] Updated model config: ${configs[index].name}`);
    return configs[index];
}

/**
 * Delete a model configuration
 */
export function deleteModelConfig(id: string): boolean {
    const configs = getModelConfigs();
    const index = configs.findIndex(c => c.id === id);

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

    Zotero.debug(`[Seer AI] Deleted model config: ${id}`);
    return true;
}

/**
 * Set a model as the default
 */
export function setDefaultModelConfig(id: string): boolean {
    const configs = getModelConfigs();
    const target = configs.find(c => c.id === id);

    if (!target) {
        return false;
    }

    configs.forEach(c => c.isDefault = (c.id === id));
    saveModelConfigs(configs);

    Zotero.debug(`[Seer AI] Set default model: ${target.name}`);
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

    if (!config.apiKey?.trim()) {
        errors.push("API Key is required");
    }

    if (!config.model?.trim()) {
        errors.push("Model is required");
    }

    return errors;
}

/**
 * Check if any model configurations exist
 */
export function hasModelConfigs(): boolean {
    return getModelConfigs().length > 0;
}
