/**
 * Persistent storage for Papers Table configurations and history
 */

import { config } from "../../../package.json";
import {
  TableConfig,
  TableHistory,
  ColumnPreset,
  defaultTableConfig,
  defaultColumns,
  defaultTableHistory,
} from "./tableTypes";

/**
 * File-based store for table configurations
 */
export class TableStore {
  private dataDir: string;
  private configFile: string;
  private historyFile: string;
  private presetsFile: string;
  private writeLock: Promise<void> = Promise.resolve();

  constructor() {
    this.dataDir = PathUtils.join(Zotero.DataDirectory.dir, config.addonRef);
    this.configFile = PathUtils.join(this.dataDir, "table_config.json");
    this.historyFile = PathUtils.join(this.dataDir, "table_history.json");
    this.presetsFile = PathUtils.join(this.dataDir, "column_presets.json");
  }

  /**
   * Execute an operation with write lock to prevent concurrent modifications
   */
  private async withWriteLock<T>(operation: () => Promise<T>): Promise<T> {
    // Chain onto the existing lock
    const previousLock = this.writeLock;
    let releaseLock: () => void;
    this.writeLock = new Promise((resolve) => {
      releaseLock = resolve;
    });

    try {
      // Wait for previous operations to complete
      await previousLock;
      // Execute our operation
      return await operation();
    } finally {
      // Release lock for next operation
      releaseLock!();
    }
  }

  private async ensureDirectory(): Promise<void> {
    try {
      if (!(await IOUtils.exists(this.dataDir))) {
        await IOUtils.makeDirectory(this.dataDir, { ignoreExisting: true });
      }
    } catch (e) {
      Zotero.debug(`[seerai] Error creating table store directory: ${e}`);
    }
  }

  /**
   * Generate a unique ID for table configs
   */
  private generateId(): string {
    return `table_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Load the current table configuration
   */
  async loadConfig(): Promise<TableConfig> {
    try {
      await this.ensureDirectory();

      if (!(await IOUtils.exists(this.configFile))) {
        // Return default config with generated ID
        return this.createDefaultConfig();
      }

      const contentBytes = await IOUtils.read(this.configFile);
      const content = new TextDecoder().decode(contentBytes);
      if (!content) return this.createDefaultConfig();

      const parsed = JSON.parse(content);
      // Ensure all required fields exist
      return {
        ...this.createDefaultConfig(),
        ...parsed,
      };
    } catch (e) {
      Zotero.debug(`[seerai] Error loading table config: ${e}`);
      return this.createDefaultConfig();
    }
  }

  /**
   * Create a default table configuration
   */
  private createDefaultConfig(): TableConfig {
    const now = new Date().toISOString();
    return {
      id: this.generateId(),
      ...defaultTableConfig,
      columns: [...defaultColumns], // Clone to avoid mutation
      createdAt: now,
      updatedAt: now,
    };
  }

  /**
   * Save the current table configuration
   * Uses write lock to prevent race conditions during concurrent saves
   */
  async saveConfig(config: TableConfig): Promise<void> {
    return this.withWriteLock(async () => {
      try {
        await this.ensureDirectory();

        // Update the timestamp
        config.updatedAt = new Date().toISOString();

        const encoder = new TextEncoder();
        await IOUtils.write(
          this.configFile,
          encoder.encode(JSON.stringify(config, null, 2)),
        );

        // Add to history (already within lock, so call internal version)
        await this.addToHistoryInternal(config);
      } catch (e) {
        Zotero.debug(`[seerai] Error saving table config: ${e}`);
      }
    });
  }

  /**
   * Load table configuration history
   */
  async loadHistory(): Promise<TableHistory> {
    try {
      await this.ensureDirectory();

      if (!(await IOUtils.exists(this.historyFile))) {
        return { ...defaultTableHistory };
      }

      const contentBytes = await IOUtils.read(this.historyFile);
      const content = new TextDecoder().decode(contentBytes);
      if (!content) return { ...defaultTableHistory };

      return JSON.parse(content);
    } catch (e) {
      Zotero.debug(`[seerai] Error loading table history: ${e}`);
      return { ...defaultTableHistory };
    }
  }

  /**
   * Get all tables from history
   */
  async getAllTables(): Promise<TableConfig[]> {
    const history = await this.loadHistory();
    return history.entries.map((e) => e.config);
  }

  /**
   * Atomically update a table configuration
   * This ensures read-modify-write happens within a single lock to prevent race conditions
   */
  async updateTable(
    tableId: string,
    modifier: (table: TableConfig) => void,
  ): Promise<TableConfig | null> {
    return this.withWriteLock(async () => {
      const history = await this.loadHistory();
      const entry = history.entries.find((e) => e.config.id === tableId);

      if (!entry) {
        Zotero.debug(`[seerai] updateTable: Table ${tableId} not found`);
        return null;
      }

      // Apply the modification
      modifier(entry.config);
      entry.config.updatedAt = new Date().toISOString();
      entry.usedAt = new Date().toISOString();

      // Save the updated history
      const encoder = new TextEncoder();
      await IOUtils.write(
        this.historyFile,
        encoder.encode(JSON.stringify(history, null, 2)),
      );

      // Also save as current config
      await IOUtils.write(
        this.configFile,
        encoder.encode(JSON.stringify(entry.config, null, 2)),
      );

      return entry.config;
    });
  }

  /**
   * Save table configuration history (for delete operations)
   */
  async saveHistory(history: TableHistory): Promise<void> {
    try {
      await this.ensureDirectory();
      const encoder = new TextEncoder();
      await IOUtils.write(
        this.historyFile,
        encoder.encode(JSON.stringify(history, null, 2)),
      );
    } catch (e) {
      Zotero.debug(`[seerai] Error saving table history: ${e}`);
    }
  }

  /**
   * Add a configuration to history (public API - uses lock)
   */
  async addToHistory(config: TableConfig): Promise<void> {
    return this.withWriteLock(() => this.addToHistoryInternal(config));
  }

  /**
   * Internal: Add a configuration to history (no lock - called from within saveConfig)
   */
  private async addToHistoryInternal(config: TableConfig): Promise<void> {
    try {
      const history = await this.loadHistory();

      // Check if this config already exists in history (by ID)
      const existingIndex = history.entries.findIndex(
        (e) => e.config.id === config.id,
      );
      if (existingIndex >= 0) {
        // Update existing entry with DEEP clone of columns to preserve all changes
        history.entries[existingIndex] = {
          config: {
            ...config,
            columns: config.columns ? [...config.columns] : [],
          },
          usedAt: new Date().toISOString(),
        };
      } else {
        // Add new entry
        history.entries.unshift({
          config: {
            ...config,
            columns: config.columns ? [...config.columns] : [],
          },
          usedAt: new Date().toISOString(),
        });

        // Trim to max entries
        if (history.entries.length > history.maxEntries) {
          history.entries = history.entries.slice(0, history.maxEntries);
        }
      }

      const encoder = new TextEncoder();
      await IOUtils.write(
        this.historyFile,
        encoder.encode(JSON.stringify(history, null, 2)),
      );
    } catch (e) {
      Zotero.debug(`[seerai] Error adding to table history: ${e}`);
    }
  }

  /**
   * Load a configuration from history by ID
   */
  async loadFromHistory(configId: string): Promise<TableConfig | null> {
    try {
      const history = await this.loadHistory();
      const entry = history.entries.find((e) => e.config.id === configId);
      return entry ? entry.config : null;
    } catch (e) {
      Zotero.debug(`[seerai] Error loading from history: ${e}`);
      return null;
    }
  }

  /**
   * Clear all table data
   */
  async clear(): Promise<void> {
    try {
      await this.ensureDirectory();
      const encoder = new TextEncoder();
      await IOUtils.write(this.configFile, encoder.encode(""));
      await IOUtils.write(this.historyFile, encoder.encode(""));
    } catch (e) {
      Zotero.debug(`[seerai] Error clearing table store: ${e}`);
    }
  }

  /**
   * Load all column presets
   */
  async loadPresets(): Promise<ColumnPreset[]> {
    try {
      await this.ensureDirectory();

      if (!(await IOUtils.exists(this.presetsFile))) {
        return [];
      }

      const contentBytes = await IOUtils.read(this.presetsFile);
      const content = new TextDecoder().decode(contentBytes);
      if (!content) return [];

      return JSON.parse(content);
    } catch (e) {
      Zotero.debug(`[seerai] Error loading column presets: ${e}`);
      return [];
    }
  }

  /**
   * Save a new column preset
   */
  async savePreset(preset: ColumnPreset): Promise<void> {
    try {
      await this.ensureDirectory();

      const presets = await this.loadPresets();

      // Check if preset with same ID exists, update it
      const existingIndex = presets.findIndex((p) => p.id === preset.id);
      if (existingIndex >= 0) {
        presets[existingIndex] = preset;
      } else {
        presets.push(preset);
      }

      const encoder = new TextEncoder();
      await IOUtils.write(
        this.presetsFile,
        encoder.encode(JSON.stringify(presets, null, 2)),
      );

      Zotero.debug(`[seerai] Saved column preset: ${preset.name}`);
    } catch (e) {
      Zotero.debug(`[seerai] Error saving column preset: ${e}`);
    }
  }

  /**
   * Delete a column preset by ID
   */
  async deletePreset(presetId: string): Promise<void> {
    try {
      await this.ensureDirectory();

      const presets = await this.loadPresets();
      const filtered = presets.filter((p) => p.id !== presetId);

      const encoder = new TextEncoder();
      await IOUtils.write(
        this.presetsFile,
        encoder.encode(JSON.stringify(filtered, null, 2)),
      );

      Zotero.debug(`[seerai] Deleted column preset: ${presetId}`);
    } catch (e) {
      Zotero.debug(`[seerai] Error deleting column preset: ${e}`);
    }
  }
  /**
   * Restore multiple column presets (overwrite existing)
   */
  async restorePresets(presets: ColumnPreset[]): Promise<void> {
    try {
      await this.ensureDirectory();
      const encoder = new TextEncoder();
      await IOUtils.write(
        this.presetsFile,
        encoder.encode(JSON.stringify(presets, null, 2)),
      );
      Zotero.debug(`[seerai] Restored ${presets.length} column presets`);
    } catch (e) {
      Zotero.debug(`[seerai] Error restoring column presets: ${e}`);
    }
  }
}

// Singleton instance
let tableStoreInstance: TableStore | null = null;

export function getTableStore(): TableStore {
  if (!tableStoreInstance) {
    tableStoreInstance = new TableStore();
  }
  return tableStoreInstance;
}

export function resetTableStore(): void {
  tableStoreInstance = null;
}
