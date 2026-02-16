/**
 * Configuration Manager
 * Handles export and import of all Seer-AI configurations (Preferences, Tables, Prompts)
 */

import { getTableStore } from "./tableStore";
import {
  loadPrompts,
  savePrompts,
  getAllPromptTags,
  PromptTemplate,
  getDefaultTemplates,
} from "./promptLibrary";

interface SeerAIConfig {
  meta: {
    version: number;
    exportedAt: string;
    addonVersion?: string;
  };
  preferences: Record<string, any>;
  tables: {
    config: any;
    history: any;
    presets: any[];
  };
  prompts: any[];
}

const CONFIG_VERSION = 1;

// Helper to get all preference keys for a branch
function getPrefKeys(branchName: string): string[] {
  try {
    // @ts-ignore
    const branch = Services.prefs.getBranch(branchName);
    const children = (branch as any).getChildList(""); // Fix lint: only 1 argument expected
    return children.map((child: string) => branchName + child);
  } catch (e) {
    Zotero.debug(
      `[seerai] Error getting preference branch ${branchName}: ${e}`,
    );
    return [];
  }
}

// Branches to export
const PREFERENCE_BRANCHES = ["extensions.seerai.", "extensions.zotero.seerai."];

/**
 * Get all preference keys that should be exported
 */
function getAllPreferenceKeys(): string[] {
  const keys = new Set<string>();
  for (const branch of PREFERENCE_BRANCHES) {
    getPrefKeys(branch).forEach((key) => keys.add(key));
  }
  return Array.from(keys);
}

/**
 * Export all configuration data to a JSON object
 */
export async function exportAllData(): Promise<SeerAIConfig> {
  const tableStore = getTableStore();

  // 1. Preferences
  const preferences: Record<string, any> = {};
  const keys = getAllPreferenceKeys();
  for (const key of keys) {
    const val = Zotero.Prefs.get(key);
    if (val !== undefined) {
      preferences[key] = val;
    }
  }

  // 2. Tables
  const tableConfig = await tableStore.loadConfig();
  const tableHistory = await tableStore.loadHistory();
  const tablePresets = await tableStore.loadPresets();

  // 3. Prompts
  // Only export custom prompts (isBuiltIn is falsy or false)
  const allPrompts = await loadPrompts();
  const customPrompts = allPrompts.filter((p) => !p.isBuiltIn);

  return {
    meta: {
      version: CONFIG_VERSION,
      exportedAt: new Date().toISOString(),
      addonVersion: "1.0.0", // TODO: Get actual version if possible
    },
    preferences,
    tables: {
      config: tableConfig,
      history: tableHistory,
      presets: tablePresets,
    },
    prompts: customPrompts,
  };
}

/**
 * Import configuration data from a JSON object
 * @param data The configuration object to import
 * @returns Object with stats on what was imported
 */
export async function importAllData(
  data: SeerAIConfig,
): Promise<{ success: boolean; stats: string; error?: string }> {
  try {
    if (!data || !data.meta || data.meta.version !== CONFIG_VERSION) {
      // Basic version check, potentially handle migrations here in future
      Zotero.debug(
        `[seerai] Config version mismatch or invalid format. Expected ${CONFIG_VERSION}, got ${data?.meta?.version}`,
      );
      // For now, proceed if it looks roughly right, or throw?
      // Lets adhere to strict version matching for safety initially.
      if (data?.meta?.version > CONFIG_VERSION) {
        throw new Error(
          `Unsupported configuration version: ${data.meta.version}`,
        );
      }
    }

    const tableStore = getTableStore();
    let importedPrefs = 0;
    let importedTables = 0;
    let importedPresets = 0;
    let importedPrompts = 0;

    // 1. Preferences
    if (data.preferences) {
      for (const [key, value] of Object.entries(data.preferences)) {
        // Security check: Ensure key belongs to Seer-AI
        if (
          key.startsWith("extensions.seerai.") ||
          key.startsWith("extensions.zotero.seerai.")
        ) {
          Zotero.Prefs.set(key, value);
          importedPrefs++;
        }
      }
    }

    // 2. Tables
    if (data.tables) {
      if (data.tables.config) {
        await tableStore.saveConfig(data.tables.config);
        // saveConfig adds to history internally, maybe we just want to set state?
        // But we want to restore exact state.
      }

      if (data.tables.history) {
        await tableStore.saveHistory(data.tables.history);
        importedTables = data.tables.history.entries?.length || 0;
      }

      if (data.tables.presets) {
        await tableStore.restorePresets(data.tables.presets);
        importedPresets = data.tables.presets.length;
      }
    }

    // 3. Prompts
    if (data.prompts) {
      const defaults = getDefaultTemplates();
      // We want to replace existing custom prompts with imported ones
      // But we must keep defaults.
      // data.prompts should be an array of custom templates.

      // Validate prompts?
      const validPrompts = data.prompts.filter((p) => p.id && p.template);

      // Merge Defaults + Imported Custom
      const merged = [...defaults, ...validPrompts];
      await savePrompts(merged);
      importedPrompts = validPrompts.length;
    }

    const stats = `Imported: ${importedPrefs} preferences, ${importedTables} table history items, ${importedPresets} column presets, ${importedPrompts} custom prompts.`;
    Zotero.debug(`[seerai] Configuration import successful. ${stats}`);

    return { success: true, stats };
  } catch (e) {
    Zotero.debug(`[seerai] Error importing configuration: ${e}`);
    return { success: false, stats: "", error: String(e) };
  }
}
