import { config } from "../../package.json";
import { getString } from "../utils/locale";
import {
  getModelConfigs,
  addModelConfig,
  updateModelConfig,
  deleteModelConfig,
  setDefaultModelConfig,
  validateModelConfig,
} from "./chat/modelConfig";
import { AIModelConfig, ModelType, MODEL_TYPE_ENDPOINTS } from "./chat/types";

// Track selected model config ID
let selectedConfigId: string | null = null;
const HTML_NS = "http://www.w3.org/1999/xhtml";

/**
 * Helper function to get CSS variable value
 */
function getCssVar(name: string): string {
  const win = addon.data.prefs!.window;
  const doc = win.document;
  const rootElement = doc.documentElement;
  if (!rootElement) return "";
  const styles = win.getComputedStyle(rootElement);
  if (!styles) return "";
  return styles.getPropertyValue(name).trim() || "";
}

export async function registerPrefsScripts(_window: Window) {
  // This function is called when the prefs window is opened
  // See addon/content/preferences.xhtml onpaneload
  if (!addon.data.prefs) {
    addon.data.prefs = {
      window: _window,
      columns: [
        {
          dataKey: "title",
          label: getString("prefs-table-title"),
          fixedWidth: true,
          width: 100,
        },
        {
          dataKey: "detail",
          label: getString("prefs-table-detail"),
        },
      ],
      rows: [
        {
          title: "Orange",
          detail: "It's juicy",
        },
        {
          title: "Banana",
          detail: "It's sweet",
        },
        {
          title: "Apple",
          detail: "I mean the fruit APPLE",
        },
      ],
    };
  } else {
    addon.data.prefs.window = _window;
  }
  updatePrefsUI();
  bindPrefEvents();
  initModelConfigUI();
}

async function updatePrefsUI() {
  // You can initialize some UI elements on prefs window
  // with addon.data.prefs.window.document
  // Or bind some events to the elements
  const renderLock = ztoolkit.getGlobal("Zotero").Promise.defer();
  if (addon.data.prefs?.window == undefined) return;
  const tableHelper = new ztoolkit.VirtualizedTable(addon.data.prefs?.window)
    .setContainerId(`${config.addonRef}-table-container`)
    .setProp({
      id: `${config.addonRef}-prefs-table`,
      // Do not use setLocale, as it modifies the Zotero.Intl.strings
      // Set locales directly to columns
      columns: addon.data.prefs?.columns,
      showHeader: true,
      multiSelect: true,
      staticColumns: true,
      disableFontSizeScaling: true,
    })
    .setProp("getRowCount", () => addon.data.prefs?.rows.length || 0)
    .setProp(
      "getRowData",
      (index) =>
        addon.data.prefs?.rows[index] || {
          title: "no data",
          detail: "no data",
        },
    )
    // Show a progress window when selection changes
    .setProp("onSelectionChange", (selection) => {
      new ztoolkit.ProgressWindow(config.addonName)
        .createLine({
          text: `Selected line: ${addon.data.prefs?.rows
            .filter((v, i) => selection.isSelected(i))
            .map((row) => row.title)
            .join(",")}`,
          progress: 100,
        })
        .show();
    })
    // When pressing delete, delete selected line and refresh table.
    // Returning false to prevent default event.
    .setProp("onKeyDown", (event: KeyboardEvent) => {
      if (event.key == "Delete" || (Zotero.isMac && event.key == "Backspace")) {
        addon.data.prefs!.rows =
          addon.data.prefs?.rows.filter(
            (v, i) => !tableHelper.treeInstance.selection.isSelected(i),
          ) || [];
        tableHelper.render();
        return false;
      }
      return true;
    })
    // For find-as-you-type
    .setProp(
      "getRowString",
      (index) => addon.data.prefs?.rows[index].title || "",
    )
    // Render the table.
    .render(-1, () => {
      renderLock.resolve();
    });
  await renderLock.promise;
  ztoolkit.log("Preference table rendered!");
}

function bindPrefEvents() {
  const doc = addon.data.prefs!.window.document;
  const prefPrefix = config.prefsPrefix;

  // Helper to bind an input element to a preference
  function bindInput(inputId: string, prefKey: string) {
    const input = doc?.querySelector(`#${inputId}`) as HTMLInputElement | null;
    if (!input) return;

    // Load current value from preferences
    const currentValue = Zotero.Prefs.get(`${prefPrefix}.${prefKey}`) as string;
    input.value = currentValue ?? "";

    // Save value when changed
    input.addEventListener("change", () => {
      Zotero.Prefs.set(`${prefPrefix}.${prefKey}`, input.value);
      ztoolkit.log(`Saved ${prefKey}: ${input.value}`);
    });
  }

  // Helper to bind a checkbox element to a boolean preference
  function bindCheckbox(checkboxId: string, prefKey: string) {
    const checkbox = doc?.querySelector(
      `#${checkboxId}`,
    ) as HTMLInputElement | null;
    if (!checkbox) return;

    // Load current value from preferences
    const currentValue = Zotero.Prefs.get(
      `${prefPrefix}.${prefKey}`,
    ) as boolean;
    checkbox.checked = currentValue ?? false;

    // Save value when changed
    checkbox.addEventListener("command", () => {
      Zotero.Prefs.set(`${prefPrefix}.${prefKey}`, checkbox.checked);
      ztoolkit.log(`Saved ${prefKey}: ${checkbox.checked}`);
    });
  }

  // Function to show/hide settings based on mode selection
  function updateModeVisibility(mode: string) {
    const localSettings = doc?.querySelector(
      `#zotero-prefpane-${config.addonRef}-localSettings`,
    ) as HTMLElement;
    const cloudSettings = doc?.querySelector(
      `#zotero-prefpane-${config.addonRef}-cloudSettings`,
    ) as HTMLElement;
    const mistralSettings = doc?.querySelector(
      `#zotero-prefpane-${config.addonRef}-mistralSettings`,
    ) as HTMLElement;

    if (localSettings) {
      localSettings.style.display = mode === "local" ? "" : "none";
    }
    if (cloudSettings) {
      cloudSettings.style.display = mode === "cloud" ? "" : "none";
    }
    if (mistralSettings) {
      mistralSettings.style.display = mode === "mistral" ? "" : "none";
    }
  }

  // Bind menulist for mode selection
  const modeSelect = doc?.querySelector(
    `#zotero-prefpane-${config.addonRef}-datalabMode`,
  ) as XUL.MenuList;
  if (modeSelect) {
    // Load current value from preference (fallback to datalabUseLocal for backward compat)
    let currentMode = Zotero.Prefs.get(`${prefPrefix}.datalabMode`) as string;
    if (!currentMode) {
      // Backward compatibility: check old boolean preference
      const useLocal = Zotero.Prefs.get(
        `${prefPrefix}.datalabUseLocal`,
      ) as boolean;
      currentMode = useLocal ? "local" : "cloud";
    }
    modeSelect.value = currentMode;
    updateModeVisibility(currentMode);

    // Save on change
    modeSelect.addEventListener("command", () => {
      const newMode = modeSelect.value;
      Zotero.Prefs.set(`${prefPrefix}.datalabMode`, newMode);
      // Also update boolean for backward compat
      Zotero.Prefs.set(`${prefPrefix}.datalabUseLocal`, newMode === "local");
      updateModeVisibility(newMode);
      ztoolkit.log(`Saved datalabMode: ${newMode}`);
    });
  }

  // Bind other DataLab settings
  bindInput(`zotero-prefpane-${config.addonRef}-datalabUrl`, "datalabUrl");
  bindInput(
    `zotero-prefpane-${config.addonRef}-datalabApiKey`,
    "datalabApiKey",
  );
  bindInput(
    `zotero-prefpane-${config.addonRef}-mistralApiKey`,
    "mistralApiKey",
  );

  // AI Insights settings
  bindCheckbox(
    `zotero-prefpane-${config.addonRef}-searchAutoAiInsights`,
    "searchAutoAiInsights",
  );
  bindInput(
    `zotero-prefpane-${config.addonRef}-searchAiInsightsPrompt`,
    "searchAiInsightsPrompt",
  );
  bindInput(
    `zotero-prefpane-${config.addonRef}-searchAiInsightsResponseLength`,
    "searchAiInsightsResponseLength",
  );

  // Bind menulist for citation style
  const styleSelect = doc?.querySelector(
    `#zotero-prefpane-${config.addonRef}-searchAiInsightsCitationStyle`,
  ) as XUL.MenuList;
  if (styleSelect) {
    styleSelect.value =
      (Zotero.Prefs.get(
        `${prefPrefix}.searchAiInsightsCitationStyle`,
      ) as string) || "numbered";
    styleSelect.addEventListener("command", () => {
      Zotero.Prefs.set(
        `${prefPrefix}.searchAiInsightsCitationStyle`,
        styleSelect.value,
      );
    });
  }

  // Local-specific settings
  bindCheckbox(
    `zotero-prefpane-${config.addonRef}-localForceOcr`,
    "localForceOcr",
  );

  // Cloud-specific settings
  bindCheckbox(
    `zotero-prefpane-${config.addonRef}-cloudForceOcr`,
    "cloudForceOcr",
  );
  bindCheckbox(`zotero-prefpane-${config.addonRef}-cloudUseLlm`, "cloudUseLlm");

  // Semantic Scholar settings
  bindInput(
    `zotero-prefpane-${config.addonRef}-semanticScholarApiKey`,
    "semanticScholarApiKey",
  );

  // NanoGPT Web Search settings
  bindInput(
    `zotero-prefpane-${config.addonRef}-nanogptWebApiKey`,
    "nanogptWebApiKey",
  );
  bindInput(
    `zotero-prefpane-${config.addonRef}-nanogptWebSearchLimit`,
    "nanogptWebSearchLimit",
  );

  // NanoGPT search depth menulist
  const nanogptDepthSelect = doc?.querySelector(
    `#zotero-prefpane-${config.addonRef}-nanogptWebSearchDepth`,
  ) as XUL.MenuList;
  if (nanogptDepthSelect) {
    nanogptDepthSelect.value =
      (Zotero.Prefs.get(`${prefPrefix}.nanogptWebSearchDepth`) as string) ||
      "standard";
    nanogptDepthSelect.addEventListener("command", () => {
      Zotero.Prefs.set(
        `${prefPrefix}.nanogptWebSearchDepth`,
        nanogptDepthSelect.value,
      );
    });
  }

  // Firecrawl settings
  bindInput(
    `zotero-prefpane-${config.addonRef}-firecrawlApiKey`,
    "firecrawlApiKey",
  );
  bindInput(
    `zotero-prefpane-${config.addonRef}-firecrawlApiUrl`,
    "firecrawlApiUrl",
  );
  bindInput(
    `zotero-prefpane-${config.addonRef}-firecrawlSearchLimit`,
    "firecrawlSearchLimit",
  );

  // Tavily settings
  bindInput(`zotero-prefpane-${config.addonRef}-tavilyApiKey`, "tavilyApiKey");
  bindInput(
    `zotero-prefpane-${config.addonRef}-tavilySearchLimit`,
    "tavilySearchLimit",
  );

  // Tavily search depth menulist
  const tavilyDepthSelect = doc?.querySelector(
    `#zotero-prefpane-${config.addonRef}-tavilySearchDepth`,
  ) as XUL.MenuList;
  if (tavilyDepthSelect) {
    tavilyDepthSelect.value =
      (Zotero.Prefs.get(`${prefPrefix}.tavilySearchDepth`) as string) ||
      "basic";
    tavilyDepthSelect.addEventListener("command", () => {
      Zotero.Prefs.set(
        `${prefPrefix}.tavilySearchDepth`,
        tavilyDepthSelect.value,
      );
    });
  }

  // Web Search Provider selection with show/hide logic
  function updateWebSearchProviderVisibility(provider: string) {
    const nanogptWebSettings = doc?.querySelector(
      `#zotero-prefpane-${config.addonRef}-nanogptWebSettings`,
    ) as HTMLElement;
    const firecrawlSettings = doc?.querySelector(
      `#zotero-prefpane-${config.addonRef}-firecrawlSettings`,
    ) as HTMLElement;
    const tavilySettings = doc?.querySelector(
      `#zotero-prefpane-${config.addonRef}-tavilySettings`,
    ) as HTMLElement;

    if (nanogptWebSettings) {
      nanogptWebSettings.style.display = provider === "nanogpt" ? "" : "none";
    }
    if (firecrawlSettings) {
      firecrawlSettings.style.display = provider === "firecrawl" ? "" : "none";
    }
    if (tavilySettings) {
      tavilySettings.style.display = provider === "tavily" ? "" : "none";
    }
  }

  const webSearchProviderSelect = doc?.querySelector(
    `#zotero-prefpane-${config.addonRef}-webSearchProvider`,
  ) as XUL.MenuList;
  if (webSearchProviderSelect) {
    const currentProvider =
      (Zotero.Prefs.get(`${prefPrefix}.webSearchProvider`) as string) ||
      "firecrawl";
    webSearchProviderSelect.value = currentProvider;
    updateWebSearchProviderVisibility(currentProvider);

    webSearchProviderSelect.addEventListener("command", () => {
      Zotero.Prefs.set(
        `${prefPrefix}.webSearchProvider`,
        webSearchProviderSelect.value,
      );
      updateWebSearchProviderVisibility(webSearchProviderSelect.value);
      ztoolkit.log(`Saved webSearchProvider: ${webSearchProviderSelect.value}`);
    });
  }

  // Initialize MCP Integration UI
  initMcpIntegrationUI();

  // Initialize Advanced Data Management UI
  try {
    initAdvancedDataManagementUI();
  } catch (e) {
    Zotero.debug(
      `[seerai] Error initializing Advanced Data Management UI: ${e}`,
    );
  }
}

/**
 * Initialize MCP Integration UI
 */
function initMcpIntegrationUI() {
  const doc = addon.data.prefs!.window.document;
  const configArea = doc.getElementById(
    `zotero-prefpane-${config.addonRef}-mcpConfigJson`,
  ) as any; // HTMLTextAreaElement
  const copyBtn = doc.getElementById(
    `zotero-prefpane-${config.addonRef}-copyMcpConfig`,
  );

  if (!configArea) return;

  // Default config showing structure
  const mcpConfig = {
    mcpServers: {
      "seerai-zotero": {
        command: "node",
        args: ["/absolute/path/to/seerai-mcp.cjs"],
      },
    },
  };

  configArea.value = JSON.stringify(mcpConfig, null, 2);

  copyBtn?.addEventListener("command", () => {
    // Copy to clipboard
    try {
      const clipboard = (Components.classes as any)[
        "@mozilla.org/widget/clipboardhelper;1"
      ].getService((Components.interfaces as any).nsIClipboardHelper);
      clipboard.copyString(configArea.value);

      // Visual feedback
      const originalLabel = copyBtn.getAttribute("label");
      copyBtn.setAttribute("label", "Copied!");
      setTimeout(() => {
        copyBtn.setAttribute(
          "label",
          originalLabel || "Copy Config to Clipboard",
        );
      }, 2000);
    } catch (e) {
      addon.data.prefs!.window.alert("Failed to copy to clipboard");
      console.error(e);
    }
  });
}

/**
 * Initialize Advanced Data Management UI (Export/Import)
 */
function initAdvancedDataManagementUI() {
  const doc = addon.data.prefs!.window.document;
  const exportBtn = doc.getElementById(
    `zotero-prefpane-${config.addonRef}-exportConfig`,
  );
  const importBtn = doc.getElementById(
    `zotero-prefpane-${config.addonRef}-importConfig`,
  );

  if (!exportBtn || !importBtn) return;

  // Use the API exposed in index.ts
  // @ts-ignore
  const { exportAllData, importAllData } = Zotero.SeerAI.api.ConfigManager;

  exportBtn.addEventListener("command", async () => {
    try {
      const data = await exportAllData();
      const json = JSON.stringify(data, null, 2);

      const win = addon.data.prefs!.window;
      const Cc = (Components as any).classes;
      const Ci = (Components as any).interfaces;

      const fp = Cc["@mozilla.org/filepicker;1"].createInstance(
        Ci.nsIFilePicker,
      );
      fp.init(win, "Export Seer-AI Configuration", Ci.nsIFilePicker.modeSave);
      fp.appendFilter("JSON Files", "*.json");
      fp.defaultString = `seerai-config-${new Date().toISOString().slice(0, 10)}.json`;

      const res = await new Promise((resolve) => fp.open(resolve));
      if (res !== Ci.nsIFilePicker.returnCancel && fp.file) {
        // @ts-ignore
        await IOUtils.writeUTF8(fp.file.path, json);
        Zotero.debug(`[seerai] Exported config to ${fp.file.path}`);
      }
    } catch (e) {
      Zotero.debug(`[seerai] Export failed: ${e}`);
      addon.data.prefs!.window.alert(`Export failed: ${e}`);
    }
  });

  importBtn.addEventListener("command", async () => {
    try {
      const win = addon.data.prefs!.window;
      const Cc = (Components as any).classes;
      const Ci = (Components as any).interfaces;

      const fp = Cc["@mozilla.org/filepicker;1"].createInstance(
        Ci.nsIFilePicker,
      );
      fp.init(win, "Import Seer-AI Configuration", Ci.nsIFilePicker.modeOpen);
      fp.appendFilter("JSON Files", "*.json");

      const res = await new Promise((resolve) => fp.open(resolve));
      if (res !== Ci.nsIFilePicker.returnCancel && fp.file) {
        // @ts-ignore
        const json = await IOUtils.readUTF8(fp.file.path);
        const data = JSON.parse(json);

        if (
          win.confirm(
            "This will overwrite your current Seer-AI configuration (preferences, tables, prompts). Are you sure?",
          )
        ) {
          const result = await importAllData(data);
          if (result.success) {
            win.alert(
              `Import Successful!\n${result.stats}\nPlease restart Zotero/Seer-AI for all changes to take full effect.`,
            );
          } else {
            win.alert(`Import Failed: ${result.error}`);
          }
        }
      }
    } catch (e) {
      Zotero.debug(`[seerai] Import failed: ${e}`);
      addon.data.prefs!.window.alert(`Import failed: ${e}`);
    }
  });
}

/**
 * Initialize Model Configuration UI
 */
function initModelConfigUI() {
  const doc = addon.data.prefs!.window.document;

  // Render the model list
  renderModelList();

  // Bind button events
  const addBtn = doc?.querySelector(
    `#zotero-prefpane-${config.addonRef}-models-add`,
  );
  const editBtn = doc?.querySelector(
    `#zotero-prefpane-${config.addonRef}-models-edit`,
  );
  const deleteBtn = doc?.querySelector(
    `#zotero-prefpane-${config.addonRef}-models-delete`,
  );
  const defaultBtn = doc?.querySelector(
    `#zotero-prefpane-${config.addonRef}-models-default`,
  );

  addBtn?.addEventListener("command", () => {
    showModelConfigDialog();
  });

  editBtn?.addEventListener("command", () => {
    if (selectedConfigId) {
      const cfg = getModelConfigs().find((c) => c.id === selectedConfigId);
      if (cfg) showModelConfigDialog(cfg);
    }
  });

  deleteBtn?.addEventListener("command", () => {
    if (selectedConfigId) {
      const configs = getModelConfigs();
      const cfg = configs.find((c) => c.id === selectedConfigId);
      if (cfg && addon.data.prefs!.window.confirm(`Delete "${cfg.name}"?`)) {
        deleteModelConfig(selectedConfigId);
        selectedConfigId = null;
        renderModelList();
        updateButtonStates();
      }
    }
  });

  defaultBtn?.addEventListener("command", () => {
    if (selectedConfigId) {
      setDefaultModelConfig(selectedConfigId);
      renderModelList();
    }
  });
}

/**
 * Render the model configurations list
 */
function renderModelList() {
  const doc = addon.data.prefs!.window.document;
  const listContainer = doc?.querySelector(`#${config.addonRef}-models-list`);
  const emptyMsg = doc?.querySelector(`#${config.addonRef}-models-empty`);

  if (!listContainer) return;

  // Clear existing items (except empty message)
  const existingItems = listContainer.querySelectorAll(".model-config-item");
  existingItems.forEach((item: Element) => item.remove());

  const configs = getModelConfigs();

  if (configs.length === 0) {
    if (emptyMsg) (emptyMsg as HTMLElement).style.display = "block";
    return;
  }

  if (emptyMsg) (emptyMsg as HTMLElement).style.display = "none";

  configs.forEach((cfg) => {
    const item = doc.createElementNS(HTML_NS, "div") as HTMLElement;
    item.className = "model-config-item";
    item.setAttribute("data-id", cfg.id);

    // Get CSS variables for theme-aware colors
    const itemBg = cfg.isDefault
      ? getCssVar("--model-item-bg-default")
      : getCssVar("--model-item-bg");
    const itemBorder =
      selectedConfigId === cfg.id
        ? getCssVar("--model-item-border-selected")
        : cfg.isDefault
          ? getCssVar("--model-item-border-default")
          : getCssVar("--model-item-border");
    const accentColor = getCssVar("--model-item-accent");
    const secondaryTextColor = getCssVar("--model-item-text-secondary");

    item.style.cssText = `
      padding: 8px 12px;
      margin: 4px 0;
      border-radius: 4px;
      cursor: pointer;
      background: ${itemBg};
      border: 1px solid ${itemBorder};
      display: flex;
      justify-content: space-between;
      align-items: center;
    `;

    const info = doc.createElementNS(HTML_NS, "div") as HTMLElement;
    // Build capability badges
    const configuredTypes: { icon: string; label: string; color: string }[] = [
      { icon: "\u{1F4AC}", label: "Chat", color: accentColor },
    ];
    if (cfg.ttsConfig?.model)
      configuredTypes.push({
        icon: "\u{1F50A}",
        label: "TTS",
        color: "#00bfa5",
      });
    if (cfg.sttConfig?.model)
      configuredTypes.push({
        icon: "\u{1F3A4}",
        label: "STT",
        color: "#ff9100",
      });
    if (cfg.embeddingConfig?.model)
      configuredTypes.push({
        icon: "\u{1F9E0}",
        label: "Embed",
        color: "#7c4dff",
      });
    if (cfg.imageConfig?.model)
      configuredTypes.push({
        icon: "\u{1F3A8}",
        label: "Image",
        color: "#e91e63",
      });
    if (cfg.videoConfig?.model)
      configuredTypes.push({
        icon: "\u{1F3AC}",
        label: "Video",
        color: "#ff6d00",
      });

    const badgesHtml = configuredTypes
      .map(
        (b) => `<span style="
        font-size: 10px;
        padding: 1px 6px;
        border-radius: 10px;
        background: ${b.color}22;
        color: ${b.color};
        border: 1px solid ${b.color}44;
        font-weight: 600;
        letter-spacing: 0.3px;
        white-space: nowrap;
      ">${b.icon} ${b.label}</span>`,
      )
      .join("");

    info.innerHTML = `
      <div style="display: flex; align-items: center; gap: 5px; flex-wrap: wrap;">
        <strong style="font-size: 13px;">${escapeHtml(cfg.name)}</strong>
        ${badgesHtml}
        ${cfg.isDefault ? `<span style="color: ${accentColor}; font-size: 11px;">★ Default</span>` : ""}
      </div>
      <div style="font-size: 11px; color: ${secondaryTextColor}; margin-top: 2px;">
        ${escapeHtml(cfg.model)} • ${escapeHtml(new URL(cfg.apiURL).hostname)}
      </div>
    `;

    item.appendChild(info);
    item.addEventListener("click", () => {
      selectedConfigId = cfg.id;
      renderModelList();
      updateButtonStates();
    });

    listContainer.appendChild(item);
  });
}

/**
 * Update button enabled states based on selection
 */
function updateButtonStates() {
  const doc = addon.data.prefs!.window.document;
  const editBtn = doc?.querySelector(
    `#zotero-prefpane-${config.addonRef}-models-edit`,
  ) as HTMLButtonElement;
  const deleteBtn = doc?.querySelector(
    `#zotero-prefpane-${config.addonRef}-models-delete`,
  ) as HTMLButtonElement;
  const defaultBtn = doc?.querySelector(
    `#zotero-prefpane-${config.addonRef}-models-default`,
  ) as HTMLButtonElement;

  const hasSelection = selectedConfigId !== null;
  if (editBtn) editBtn.disabled = !hasSelection;
  if (deleteBtn) deleteBtn.disabled = !hasSelection;
  if (defaultBtn) defaultBtn.disabled = !hasSelection;
}

/**
 * Show dialog to add/edit model configuration
 * Uses a single modal with all fields visible at once
 */
function showModelConfigDialog(existingConfig?: AIModelConfig) {
  const isEdit = !!existingConfig;
  const title = isEdit ? "Edit Model Configuration" : "Add Model Configuration";
  const doc = addon.data.prefs!.window.document;
  const win = addon.data.prefs!.window;

  // Remove any existing modal
  const existingModal = doc.getElementById("model-config-modal-overlay");
  if (existingModal) existingModal.remove();

  // Get CSS variables for modal colors
  const modalBg = getCssVar("--modal-bg");
  const modalTitleColor = getCssVar("--modal-title-color");

  // Detect color scheme for fallbacks
  const isDark = !!win?.matchMedia?.("(prefers-color-scheme: dark)")?.matches;
  const defaultBg = isDark ? "#1e1e1e" : "#ffffff";
  const defaultTitleColor = isDark ? "#eeeeee" : "#111111";

  // Create modal overlay
  const overlay = doc.createElementNS(HTML_NS, "div") as HTMLElement;
  overlay.id = "model-config-modal-overlay";
  overlay.style.cssText = `
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(0, 0, 0, 0.5);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 10000;
  `;

  // Create modal container
  const modal = doc.createElementNS(HTML_NS, "div") as HTMLElement;
  modal.style.cssText = `
    background: ${modalBg || defaultBg};
    color: ${modalTitleColor || defaultTitleColor};
    border-radius: 8px;
    padding: 24px;
    min-width: 480px;
    max-width: 560px;
    max-height: 90vh;
    overflow-y: auto;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
    border: 1px solid rgba(255, 255, 255, 0.1);
  `;

  // Modal title
  const titleEl = doc.createElementNS(HTML_NS, "h3") as HTMLElement;
  titleEl.textContent = title;
  titleEl.style.cssText = `
    margin: 0 0 20px 0;
    font-size: 18px;
    font-weight: 600;
    color: ${modalTitleColor || defaultTitleColor};
  `;
  modal.appendChild(titleEl);

  // References for conditional fields (will be set after creation)
  let rateLimitSection: HTMLElement | null = null;

  // Endpoint config inputs (populated after form fields are created)
  const endpointInputs: Record<
    string,
    {
      model: HTMLInputElement;
      endpoint: HTMLInputElement;
      voice?: HTMLInputElement;
      dimensions?: HTMLInputElement;
      maxTokens?: HTMLInputElement;
    }
  > = {};

  // Provider presets — rich type supports pre-filling all config fields
  interface ProviderPreset {
    name: string;
    apiURL: string;
    model: string;
    placeholder: string;
    // Optional rich fields for fully pre-configured presets
    rateLimit?: { type: "tpm" | "rpm" | "concurrency"; value: number };
    reasoningEffort?: "low" | "medium" | "high" | "";
    ttsConfig?: { model: string; endpoint?: string; voice?: string };
    sttConfig?: { model: string; endpoint?: string };
    embeddingConfig?: {
      model: string;
      endpoint?: string;
      dimensions?: number;
      maxTokens?: number;
    };
    imageConfig?: { model: string; endpoint?: string };
    videoConfig?: { model: string; endpoint?: string };
    contextLength?: number;
  }

  const providerPresets: ProviderPreset[] = [
    { name: "— Select a preset —", apiURL: "", model: "", placeholder: "" },
    {
      name: "NanoGPT",
      apiURL: "https://nano-gpt.com/api/v1",
      model: "",
      placeholder: "nano-...",
    },
    {
      name: "NanoGPT-preset",
      apiURL: "https://nano-gpt.com/api/v1",
      model: "claude-haiku-4-5-20251001",
      placeholder: "nano-...",
      rateLimit: { type: "rpm", value: 500 },
      ttsConfig: { model: "Kokoro-82m", voice: "am_onyx" },
      sttConfig: { model: "Whisper-Large-V3" },
      embeddingConfig: {
        model: "text-embedding-3-large",
        dimensions: 3072,
        maxTokens: 8191,
      },
      imageConfig: { model: "nano-banana-2" },
      videoConfig: { model: "veo3-1-video" },
      contextLength: 200000,
    },
    {
      name: "OpenAI",
      apiURL: "https://api.openai.com/v1/",
      model: "gpt-5-mini",
      placeholder: "sk-...",
    },
    {
      name: "Anthropic",
      apiURL: "https://api.anthropic.com/v1/",
      model: "claude-sonnet-4.5",
      placeholder: "sk-ant-...",
    },
    {
      name: "Google AI (Gemini)",
      apiURL: "https://generativelanguage.googleapis.com/v1beta/openai/",
      model: "gemini-2.5-flash",
      placeholder: "AIza...",
    },
    {
      name: "Mistral AI",
      apiURL: "https://api.mistral.ai/v1/",
      model: "mistral-large-latest",
      placeholder: "",
    },
    {
      name: "OpenRouter",
      apiURL: "https://openrouter.ai/api/v1/",
      model: "openai/gpt-5-mini",
      placeholder: "sk-or-...",
    },
    {
      name: "Groq",
      apiURL: "https://api.groq.com/openai/v1/",
      model: "openai/gpt-oss-120b",
      placeholder: "gsk_...",
    },
    {
      name: "DeepSeek",
      apiURL: "https://api.deepseek.com/v1/",
      model: "deepseek-chat",
      placeholder: "sk-...",
    },
    {
      name: "xAI (Grok)",
      apiURL: "https://api.x.ai/v1/",
      model: "grok-4.1-fast",
      placeholder: "xai-...",
    },
    {
      name: "Together AI",
      apiURL: "https://api.together.xyz/v1/",
      model: "openai/gpt-oss-120b",
      placeholder: "",
    },
    {
      name: "Ollama (Local)",
      apiURL: "http://localhost:11434/v1/",
      model: "qwen3-vl:8b-thinking-q8_0",
      placeholder: "(optional)",
    },
    {
      name: "OpenAI Compatible",
      apiURL: "https://nano-gpt.com/api/v1",
      model: "local-model",
      placeholder: "(optional)",
    },
  ];

  // Get CSS variables for form elements
  const labelColor = getCssVar("--modal-label-color");
  const inputBg = getCssVar("--modal-input-bg");
  const inputBorder = getCssVar("--modal-input-border");
  const inputFocusBorder = getCssVar("--modal-input-focus-border");
  const inputText = getCssVar("--modal-input-text");
  const inputPlaceholder = getCssVar("--modal-input-placeholder");

  // Field styles
  const labelStyle = `
    display: block;
    font-size: 13px;
    font-weight: 500;
    color: ${labelColor || defaultTitleColor};
    margin-bottom: 4px;
  `;
  const inputStyle = `
    width: 100%;
    padding: 10px 12px;
    border: 1px solid ${inputBorder || (isDark ? "#444" : "#ccc")};
    border-radius: 6px;
    font-size: 14px;
    margin-bottom: 16px;
    box-sizing: border-box;
    transition: border-color 0.2s;
    background: ${inputBg || (isDark ? "#2d2d2d" : "#ffffff")};
    color: ${inputText || defaultTitleColor};
  `;
  const selectStyle = `
    width: 100%;
    padding: 10px 12px;
    border: 1px solid ${inputBorder || (isDark ? "#444" : "#ccc")};
    border-radius: 6px;
    font-size: 14px;
    margin-bottom: 16px;
    box-sizing: border-box;
    background: ${inputBg || (isDark ? "#2d2d2d" : "#ffffff")};
    color: ${inputText || defaultTitleColor};
    cursor: pointer;
  `;

  // Preset selector (only show for new configs)
  const inputs: Record<string, HTMLInputElement> = {};

  // NanoGPT model select container (declared outside if block so form fields can reference it)
  let nanoGptModelSelect: HTMLElement | null = null;
  // Hoisted fetch function reference, assigned inside the if-block
  let fetchNanoGptModelsFn: (() => Promise<void>) | null = null;
  // Hoisted NanoGPT model list so TTS searchable dropdown can share it
  let allNanoModels: string[] = [];
  // Track whether current provider is NanoGPT (for TTS searchable dropdown)
  let isCurrentProviderNanoGpt = !isEdit; // defaults to NanoGPT for new configs

  // Hoisted form element references for the preset change handler (assigned after creation)
  let rlTypeSelect: HTMLSelectElement;
  let rlValueInput: HTMLInputElement;
  let reSelect: HTMLSelectElement;
  let contextLengthInput: HTMLInputElement;

  if (!isEdit) {
    const presetLabel = doc.createElementNS(HTML_NS, "label") as HTMLElement;
    presetLabel.textContent = "Provider Preset";
    presetLabel.style.cssText = labelStyle;
    modal.appendChild(presetLabel);

    const presetSelect = doc.createElementNS(
      HTML_NS,
      "select",
    ) as HTMLSelectElement;
    presetSelect.style.cssText = selectStyle;

    providerPresets.forEach((preset, idx) => {
      const option = doc.createElementNS(
        HTML_NS,
        "option",
      ) as HTMLOptionElement;
      option.value = String(idx);
      option.textContent = preset.name;
      if (idx === 1) option.selected = true; // Default to NanoGPT
      presetSelect.appendChild(option);
    });

    // NanoGPT invitation card (shown when NanoGPT preset is selected)
    const nanoGptCard = doc.createElementNS(HTML_NS, "div") as HTMLElement;
    nanoGptCard.style.cssText = `
      display: block;
      margin: 8px 0 12px 0;
      padding: 12px 14px;
      border-radius: 8px;
      background: linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%);
      border: 1px solid rgba(100, 180, 255, 0.25);
      cursor: pointer;
      transition: all 0.2s;
      text-decoration: none;
    `;
    nanoGptCard.addEventListener("mouseenter", () => {
      nanoGptCard.style.borderColor = "rgba(100, 180, 255, 0.5)";
      nanoGptCard.style.boxShadow = "0 2px 12px rgba(100, 180, 255, 0.15)";
    });
    nanoGptCard.addEventListener("mouseleave", () => {
      nanoGptCard.style.borderColor = "rgba(100, 180, 255, 0.25)";
      nanoGptCard.style.boxShadow = "none";
    });
    nanoGptCard.addEventListener("click", () => {
      // Open NanoGPT referral link in system browser
      Zotero.launchURL("https://nano-gpt.com/r/RwCEN6fR");
    });

    const cardTitle = doc.createElementNS(HTML_NS, "div") as HTMLElement;
    cardTitle.textContent = "NanoGPT — Pay-per-use AI";
    cardTitle.style.cssText = `
      font-size: 14px;
      font-weight: 600;
      color: #e0e0ff;
      margin-bottom: 4px;
    `;
    nanoGptCard.appendChild(cardTitle);

    const cardDesc = doc.createElementNS(HTML_NS, "div") as HTMLElement;
    cardDesc.textContent =
      "Access 300+ AI models. Pay only for what you use via Apple Pay, Google Pay, credit card, or crypto. Click to sign up.";
    cardDesc.style.cssText = `
      font-size: 11px;
      color: #a0b4d0;
      line-height: 1.4;
    `;
    nanoGptCard.appendChild(cardDesc);

    const cardLink = doc.createElementNS(HTML_NS, "div") as HTMLElement;
    cardLink.textContent = "nano-gpt.com →";
    cardLink.style.cssText = `
      font-size: 11px;
      color: #64b4ff;
      margin-top: 6px;
      font-weight: 500;
    `;
    nanoGptCard.appendChild(cardLink);

    // NanoGPT searchable model dropdown (replaces text input when NanoGPT is selected)
    const nanoModelContainer = doc.createElementNS(
      HTML_NS,
      "div",
    ) as HTMLDivElement;
    nanoGptModelSelect = nanoModelContainer;
    nanoModelContainer.id = "model-config-nanogpt-model-select";
    nanoModelContainer.style.cssText = `
      width: 100%;
      margin-bottom: 16px;
      box-sizing: border-box;
      display: none;
      position: relative;
    `;

    // Search input
    const nanoSearchInput = doc.createElementNS(
      HTML_NS,
      "input",
    ) as HTMLInputElement;
    nanoSearchInput.type = "text";
    nanoSearchInput.placeholder = "Search models...";
    nanoSearchInput.style.cssText = `
      width: 100%;
      padding: 10px 12px;
      border: 1px solid ${inputBorder || (isDark ? "#444" : "#ccc")};
      border-radius: 6px;
      font-size: 14px;
      box-sizing: border-box;
      background: ${inputBg || (isDark ? "#2d2d2d" : "#ffffff")};
      color: ${inputText || defaultTitleColor};
    `;
    nanoModelContainer.appendChild(nanoSearchInput);

    // Scrollable model list
    const nanoModelList = doc.createElementNS(HTML_NS, "div") as HTMLDivElement;
    nanoModelList.style.cssText = `
      width: 100%;
      max-height: 200px;
      overflow-y: auto;
      border: 1px solid ${inputBorder || (isDark ? "#444" : "#ccc")};
      border-top: none;
      border-radius: 0 0 6px 6px;
      box-sizing: border-box;
      background: ${inputBg || (isDark ? "#2d2d2d" : "#ffffff")};
      display: none;
    `;
    nanoModelContainer.appendChild(nanoModelList);

    // State for the searchable dropdown
    let selectedNanoModel = "";

    function renderNanoModelItems(filter: string) {
      nanoModelList.innerHTML = "";
      const query = filter.toLowerCase();
      const filtered = query
        ? allNanoModels.filter((m) => m.toLowerCase().includes(query))
        : allNanoModels;

      if (filtered.length === 0) {
        const emptyItem = doc.createElementNS(HTML_NS, "div") as HTMLElement;
        emptyItem.textContent = query
          ? "No matching models"
          : "No models available";
        emptyItem.style.cssText = `
          padding: 8px 12px;
          font-size: 13px;
          color: ${isDark ? "#888" : "#999"};
          font-style: italic;
        `;
        nanoModelList.appendChild(emptyItem);
        return;
      }

      filtered.forEach((modelId) => {
        const item = doc.createElementNS(HTML_NS, "div") as HTMLElement;
        item.textContent = modelId;
        const isSelected = modelId === selectedNanoModel;
        item.style.cssText = `
          padding: 7px 12px;
          font-size: 13px;
          cursor: pointer;
          color: ${inputText || defaultTitleColor};
          background: ${isSelected ? (isDark ? "#3a3a5e" : "#e0e8ff") : "transparent"};
        `;
        item.addEventListener("mouseenter", () => {
          if (modelId !== selectedNanoModel) {
            item.style.background = isDark ? "#333" : "#f0f0f0";
          }
        });
        item.addEventListener("mouseleave", () => {
          item.style.background =
            modelId === selectedNanoModel
              ? isDark
                ? "#3a3a5e"
                : "#e0e8ff"
              : "transparent";
        });
        item.addEventListener("click", () => {
          selectedNanoModel = modelId;
          nanoSearchInput.value = modelId;
          nanoModelList.style.display = "none";
          // Round the search input corners back
          nanoSearchInput.style.borderRadius = "6px";
          nanoSearchInput.style.borderBottom = `1px solid ${inputBorder || (isDark ? "#444" : "#ccc")}`;
          // Sync to hidden model text input and auto-fill name
          if (inputs.model) inputs.model.value = modelId;
          if (inputs.name) inputs.name.value = `nano-${modelId}`;
        });
        nanoModelList.appendChild(item);
      });
    }

    // Show/hide list on focus/blur
    nanoSearchInput.addEventListener("focus", () => {
      nanoSearchInput.style.borderColor = inputFocusBorder;
      nanoSearchInput.style.outline = "none";
      if (allNanoModels.length > 0) {
        nanoModelList.style.display = "";
        // Flatten bottom corners of search input when list is open
        nanoSearchInput.style.borderRadius = "6px 6px 0 0";
        nanoSearchInput.style.borderBottom = "none";
        renderNanoModelItems(
          nanoSearchInput.value === selectedNanoModel
            ? ""
            : nanoSearchInput.value,
        );
      }
    });

    // Filter on input
    nanoSearchInput.addEventListener("input", () => {
      renderNanoModelItems(nanoSearchInput.value);
      if (nanoModelList.style.display === "none" && allNanoModels.length > 0) {
        nanoModelList.style.display = "";
        nanoSearchInput.style.borderRadius = "6px 6px 0 0";
        nanoSearchInput.style.borderBottom = "none";
      }
    });

    // Close list when clicking outside
    doc.addEventListener("click", (e: Event) => {
      if (!nanoModelContainer.contains(e.target as Node)) {
        nanoModelList.style.display = "none";
        nanoSearchInput.style.borderRadius = "6px";
        nanoSearchInput.style.borderBottom = `1px solid ${inputBorder || (isDark ? "#444" : "#ccc")}`;
        nanoSearchInput.style.borderColor =
          inputBorder || (isDark ? "#444" : "#ccc");
        // If user cleared the search without picking, restore previous selection
        if (selectedNanoModel && nanoSearchInput.value !== selectedNanoModel) {
          nanoSearchInput.value = selectedNanoModel;
        }
      }
    });

    // Status message helper
    function setNanoModelStatus(text: string) {
      nanoModelList.style.display = "none";
      nanoSearchInput.value = "";
      nanoSearchInput.placeholder = text;
      allNanoModels = [];
      selectedNanoModel = "";
    }

    setNanoModelStatus("Loading models...");

    // Function to fetch and populate NanoGPT models
    let nanoGptModelsFetched = false;
    async function fetchNanoGptModels() {
      if (nanoGptModelsFetched) return;
      try {
        setNanoModelStatus("Fetching models...");

        const response = await fetch("https://nano-gpt.com/api/v1/models", {
          headers: { "x-seer-ai": "1" },
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = (await response.json()) as {
          data?: { id: string; owned_by?: string }[];
        };

        if (data?.data && Array.isArray(data.data)) {
          allNanoModels = data.data.map((m) => m.id).sort();
          nanoSearchInput.placeholder = "Search models...";
          nanoSearchInput.value = "";
          nanoGptModelsFetched = true;
          Zotero.debug(
            `[seerai] Fetched ${allNanoModels.length} NanoGPT models`,
          );
          // Now that models are loaded, show chat search dropdown if NanoGPT is active
          updateChatModelDropdownVisibility(true);
        }
      } catch (e) {
        Zotero.debug(`[seerai] Failed to fetch NanoGPT models: ${e}`);
        setNanoModelStatus("Failed to load models (type manually below)");
        // Show the text input as fallback
        if (inputs.model) inputs.model.style.display = "";
        nanoModelContainer.style.display = "none";
      }
    }

    presetSelect.addEventListener("change", () => {
      const idx = parseInt(presetSelect.value);
      const preset = providerPresets[idx];

      // Cache the current API key before switching presets
      const currentApiUrl = inputs.apiURL?.value?.trim();
      const currentApiKey = inputs.apiKey?.value?.trim();
      if (currentApiUrl && currentApiKey) {
        try {
          const cached = JSON.parse(
            (Zotero.Prefs.get(
              `${config.prefsPrefix}.cachedProviderApiKeys`,
            ) as string) || "{}",
          );
          cached[currentApiUrl] = currentApiKey;
          Zotero.Prefs.set(
            `${config.prefsPrefix}.cachedProviderApiKeys`,
            JSON.stringify(cached),
          );
        } catch (_) {
          /* ignore parse errors */
        }
      }

      if (preset && idx > 0) {
        if (inputs.apiURL) inputs.apiURL.value = preset.apiURL;
        if (inputs.model) inputs.model.value = preset.model;
        // Also sync to the chat model input in the endpoints section
        if (endpointInputs.chat?.model) {
          endpointInputs.chat.model.value = preset.model;
        }
        if (inputs.apiKey)
          inputs.apiKey.placeholder = preset.placeholder || "API Key";

        // Restore cached API key for this provider
        if (inputs.apiKey && preset.apiURL) {
          try {
            const cached = JSON.parse(
              (Zotero.Prefs.get(
                `${config.prefsPrefix}.cachedProviderApiKeys`,
              ) as string) || "{}",
            );
            inputs.apiKey.value = cached[preset.apiURL] || "";
          } catch (_) {
            /* ignore parse errors */
          }
        }

        // For NanoGPT variants, name is set dynamically on model select; set placeholder
        const isNanoGptVariant =
          preset.name === "NanoGPT" || preset.name === "NanoGPT-preset";
        if (isNanoGptVariant) {
          // NanoGPT-preset gets a fixed name; plain NanoGPT uses dynamic naming
          if (preset.name === "NanoGPT-preset") {
            if (inputs.name) inputs.name.value = "Seerai";
          } else {
            if (inputs.name && !inputs.name.value)
              inputs.name.value = "NanoGPT";
          }
        } else {
          if (inputs.name && !inputs.name.value)
            inputs.name.value = preset.name;
        }

        // ── Populate rich preset fields (capability endpoints, rate limit, RAG) ──
        // Rate limit
        if (preset.rateLimit) {
          rlTypeSelect.value = preset.rateLimit.type;
          rlValueInput.value = String(preset.rateLimit.value);
        }
        // Reasoning effort
        if (preset.reasoningEffort !== undefined) {
          reSelect.value = preset.reasoningEffort;
        }
        // TTS
        if (preset.ttsConfig && endpointInputs.tts) {
          endpointInputs.tts.model.value = preset.ttsConfig.model;
          if (preset.ttsConfig.endpoint)
            endpointInputs.tts.endpoint.value = preset.ttsConfig.endpoint;
          if (preset.ttsConfig.voice && endpointInputs.tts.voice)
            endpointInputs.tts.voice.value = preset.ttsConfig.voice;
        }
        // STT
        if (preset.sttConfig && endpointInputs.stt) {
          endpointInputs.stt.model.value = preset.sttConfig.model;
          if (preset.sttConfig.endpoint)
            endpointInputs.stt.endpoint.value = preset.sttConfig.endpoint;
        }
        // Embedding
        if (preset.embeddingConfig && endpointInputs.embedding) {
          endpointInputs.embedding.model.value = preset.embeddingConfig.model;
          if (preset.embeddingConfig.endpoint)
            endpointInputs.embedding.endpoint.value =
              preset.embeddingConfig.endpoint;
          if (
            preset.embeddingConfig.dimensions &&
            endpointInputs.embedding.dimensions
          )
            endpointInputs.embedding.dimensions.value = String(
              preset.embeddingConfig.dimensions,
            );
          if (
            preset.embeddingConfig.maxTokens &&
            endpointInputs.embedding.maxTokens
          )
            endpointInputs.embedding.maxTokens.value = String(
              preset.embeddingConfig.maxTokens,
            );
        }
        // Image
        if (preset.imageConfig && endpointInputs.image) {
          endpointInputs.image.model.value = preset.imageConfig.model;
          if (preset.imageConfig.endpoint)
            endpointInputs.image.endpoint.value = preset.imageConfig.endpoint;
        }
        // Video
        if (preset.videoConfig && endpointInputs.video) {
          endpointInputs.video.model.value = preset.videoConfig.model;
          if (preset.videoConfig.endpoint)
            endpointInputs.video.endpoint.value = preset.videoConfig.endpoint;
        }
        // RAG settings
        if (preset.contextLength !== undefined) {
          contextLengthInput.value = String(preset.contextLength);
        }
      }

      // NanoGPT-specific behavior (both NanoGPT and NanoGPT-preset use NanoGPT API)
      const isNanoGpt =
        preset?.name === "NanoGPT" || preset?.name === "NanoGPT-preset";
      isCurrentProviderNanoGpt = isNanoGpt;

      if (isNanoGpt) {
        fetchNanoGptModels();
      }

      // Update chat model searchable dropdown visibility
      updateChatModelDropdownVisibility(isNanoGpt);
    });

    modal.appendChild(presetSelect);
    modal.appendChild(nanoGptCard);

    // Divider
    const dividerBg = getCssVar("--divider-bg");

    const divider = doc.createElementNS(HTML_NS, "div") as HTMLElement;
    divider.style.cssText = `
      border-top: 1px solid ${dividerBg};
      margin: 4px 0 16px 0;
    `;
    modal.appendChild(divider);

    // Expose fetchNanoGptModels to outer scope for auto-apply after fields are created
    fetchNanoGptModelsFn = fetchNanoGptModels;
  }

  // Create form fields
  const fields = [
    {
      id: "name",
      label: "Name",
      placeholder: "My OpenAI Config",
      value: existingConfig?.name || "",
      type: "text",
    },
    {
      id: "apiURL",
      label: "API URL",
      placeholder: "https://api.openai.com/v1/",
      value:
        existingConfig?.apiURL ||
        (isEdit ? "https://api.openai.com/v1/" : "https://nano-gpt.com/api/v1"),
      type: "text",
    },
    {
      id: "apiKey",
      label: "API Key",
      placeholder: "sk-...",
      value: existingConfig?.apiKey || "",
      type: "password",
    },
  ];

  // Hidden model input — synced by the chat capability row in the endpoints section
  const hiddenModelInput = doc.createElementNS(
    HTML_NS,
    "input",
  ) as HTMLInputElement;
  hiddenModelInput.type = "hidden";
  hiddenModelInput.value = existingConfig?.model || "gpt-4o-mini";
  hiddenModelInput.id = "model-config-model";
  inputs.model = hiddenModelInput;
  modal.appendChild(hiddenModelInput);

  fields.forEach((field) => {
    const label = doc.createElementNS(HTML_NS, "label") as HTMLElement;
    label.textContent = field.label;
    label.style.cssText = labelStyle;
    modal.appendChild(label);

    const input = doc.createElementNS(HTML_NS, "input") as HTMLInputElement;
    input.type = field.type;
    input.placeholder = field.placeholder;
    input.value = field.value;
    input.id = `model-config-${field.id}`;
    inputs[field.id] = input;

    // Add focus effect
    input.addEventListener("focus", () => {
      input.style.borderColor = inputFocusBorder;
      input.style.outline = "none";
    });
    input.addEventListener("blur", () => {
      input.style.borderColor = inputBorder;
    });

    // All fields use the same simple layout
    input.style.cssText = inputStyle;
    modal.appendChild(input);
  });

  // Auto-apply NanoGPT preset now that form fields exist
  if (!isEdit && fetchNanoGptModelsFn) {
    fetchNanoGptModelsFn();

    // Restore cached API key for the default NanoGPT preset
    if (inputs.apiKey) {
      try {
        const cached = JSON.parse(
          (Zotero.Prefs.get(
            `${config.prefsPrefix}.cachedProviderApiKeys`,
          ) as string) || "{}",
        );
        const nanoUrl = "https://nano-gpt.com/api/v1";
        if (cached[nanoUrl]) inputs.apiKey.value = cached[nanoUrl];
      } catch (_) {
        /* ignore parse errors */
      }
    }
  }

  // --- Rate Limit Section ---
  rateLimitSection = doc.createElementNS(HTML_NS, "div") as HTMLElement;
  rateLimitSection.id = "model-config-rate-limit-section";

  const rlLabel = doc.createElementNS(HTML_NS, "label") as HTMLElement;
  rlLabel.textContent = "Rate Limit";
  rlLabel.style.cssText = labelStyle;
  rateLimitSection.appendChild(rlLabel);

  const rlContainer = doc.createElementNS(HTML_NS, "div") as HTMLElement;
  rlContainer.style.cssText = `
    display: flex;
    gap: 12px;
    margin-bottom: 16px;
  `;

  // Type Selector
  rlTypeSelect = doc.createElementNS(HTML_NS, "select") as HTMLSelectElement;
  rlTypeSelect.style.cssText = selectStyle;
  rlTypeSelect.style.marginBottom = "0";
  rlTypeSelect.style.flex = "1";

  const rlTypes = [
    { value: "concurrency", label: "Concurrency (Simultaneous)" },
    { value: "rpm", label: "RPM (Requests / Minute)" },
    { value: "tpm", label: "TPM (Tokens / Minute)" },
  ];

  rlTypes.forEach((t) => {
    const opt = doc.createElementNS(HTML_NS, "option") as HTMLOptionElement;
    opt.value = t.value;
    opt.textContent = t.label;
    if (existingConfig?.rateLimit?.type === t.value) {
      opt.selected = true;
    }
    rlTypeSelect.appendChild(opt);
  });
  rlContainer.appendChild(rlTypeSelect);

  // Value Input
  rlValueInput = doc.createElementNS(HTML_NS, "input") as HTMLInputElement;
  rlValueInput.type = "number";
  rlValueInput.min = "1";
  rlValueInput.placeholder = "Limit";
  rlValueInput.value = existingConfig?.rateLimit?.value
    ? String(existingConfig.rateLimit.value)
    : "5";
  rlValueInput.style.cssText = inputStyle;
  rlValueInput.style.marginBottom = "0";
  rlValueInput.style.flex = "1";

  // Add focus effect
  rlValueInput.addEventListener("focus", () => {
    rlValueInput.style.borderColor = inputFocusBorder;
    rlValueInput.style.outline = "none";
  });
  rlValueInput.addEventListener("blur", () => {
    rlValueInput.style.borderColor = inputBorder;
  });

  rlContainer.appendChild(rlValueInput);
  rateLimitSection.appendChild(rlContainer);
  modal.appendChild(rateLimitSection);

  // --- Reasoning Effort (created here, appended into the chat capability row below) ---
  reSelect = doc.createElementNS(HTML_NS, "select") as HTMLSelectElement;
  reSelect.style.cssText = `
    flex: 0.5;
    padding: 7px 10px;
    border: 1px solid ${inputBorder || (isDark ? "#444" : "#ccc")};
    border-radius: 5px;
    font-size: 12px;
    box-sizing: border-box;
    background: ${inputBg || (isDark ? "#2d2d2d" : "#ffffff")};
    color: ${inputText || defaultTitleColor};
    cursor: pointer;
  `;

  const reOptions = [
    { value: "", label: "Reasoning: Default" },
    { value: "low", label: "Reasoning: Low" },
    { value: "medium", label: "Reasoning: Medium" },
    { value: "high", label: "Reasoning: High" },
  ];

  reOptions.forEach((opt) => {
    const option = doc.createElementNS(HTML_NS, "option") as HTMLOptionElement;
    option.value = opt.value;
    option.textContent = opt.label;
    if (
      existingConfig?.reasoningEffort === opt.value ||
      (!existingConfig?.reasoningEffort && opt.value === "")
    ) {
      option.selected = true;
    }
    reSelect.appendChild(option);
  });

  // --- Model Endpoints Section — shown BEFORE API URL ---
  const endpointSectionLabel = doc.createElementNS(
    HTML_NS,
    "label",
  ) as HTMLElement;
  endpointSectionLabel.textContent = "Model Endpoints";
  endpointSectionLabel.style.cssText = `
    display: block;
    font-size: 13px;
    font-weight: 600;
    color: ${labelColor || defaultTitleColor};
    margin-bottom: 8px;
  `;

  const endpointSectionDesc = doc.createElementNS(
    HTML_NS,
    "div",
  ) as HTMLElement;
  endpointSectionDesc.textContent =
    "Configure models for each capability. Leave blank to skip. Endpoint defaults to API URL + default path if empty.";
  endpointSectionDesc.style.cssText = `
    font-size: 11px;
    color: ${isDark ? "#888" : "#999"};
    margin-bottom: 12px;
    line-height: 1.4;
  `;

  const endpointSection = doc.createElementNS(HTML_NS, "div") as HTMLElement;
  endpointSection.style.cssText = `
    border: 1px solid ${isDark ? "#3a3a3a" : "#e0e0e0"};
    border-radius: 8px;
    overflow: hidden;
    margin-bottom: 16px;
  `;

  // All capabilities including chat (chat is now the first row with NanoGPT search support)
  const capabilityRows: {
    key: "chat" | "tts" | "stt" | "embedding" | "image" | "video";
    configKey:
      | "model"
      | "ttsConfig"
      | "sttConfig"
      | "embeddingConfig"
      | "imageConfig"
      | "videoConfig";
    type: ModelType;
  }[] = [
    { key: "chat", configKey: "model", type: "chat" },
    { key: "tts", configKey: "ttsConfig", type: "tts" },
    { key: "stt", configKey: "sttConfig", type: "stt" },
    { key: "embedding", configKey: "embeddingConfig", type: "embedding" },
    { key: "image", configKey: "imageConfig", type: "image" },
    { key: "video", configKey: "videoConfig", type: "video" },
  ];

  // Chat NanoGPT searchable dropdown elements (hoisted for visibility toggling)
  let chatNanoSearchContainer: HTMLElement | null = null;
  let chatPlainModelInput: HTMLInputElement | null = null;
  let chatNanoSearchInput: HTMLInputElement | null = null;

  // Called when preset changes to show/hide chat NanoGPT search
  function updateChatModelDropdownVisibility(isNanoGpt: boolean) {
    if (chatNanoSearchContainer && chatPlainModelInput) {
      if (isNanoGpt && allNanoModels.length > 0) {
        chatNanoSearchContainer.style.display = "";
        chatPlainModelInput.style.display = "none";
        // Sync the current model value into the search input so the preset
        // model name is visible (not blank) when the dropdown is shown
        if (chatNanoSearchInput && chatPlainModelInput.value) {
          chatNanoSearchInput.value = chatPlainModelInput.value;
        }
      } else {
        chatNanoSearchContainer.style.display = "none";
        chatPlainModelInput.style.display = "";
      }
    }
  }

  capabilityRows.forEach((cap, idx) => {
    const info = MODEL_TYPE_ENDPOINTS[cap.type];
    // For chat, read from the primary model field; for others, read from sub-config
    const existing =
      cap.type === "chat"
        ? existingConfig
          ? { model: existingConfig.model, endpoint: undefined }
          : undefined
        : existingConfig?.[
            cap.configKey as
              | "ttsConfig"
              | "sttConfig"
              | "embeddingConfig"
              | "imageConfig"
              | "videoConfig"
          ];
    const typeColor =
      cap.type === "chat"
        ? "#4fc3f7"
        : cap.type === "embedding"
          ? "#7c4dff"
          : cap.type === "image"
            ? "#e91e63"
            : cap.type === "video"
              ? "#ff6d00"
              : cap.type === "stt"
                ? "#ff9100" // amber-orange for STT
                : "#00bfa5"; // tts

    const row = doc.createElementNS(HTML_NS, "div") as HTMLElement;
    const isLast = idx === capabilityRows.length - 1;
    row.style.cssText = `
      padding: 10px 14px;
      border-bottom: ${isLast ? "none" : `1px solid ${isDark ? "#333" : "#eee"}`};
      background: ${typeColor}${isDark ? "15" : "0a"};
    `;

    // Row header with icon + label
    const rowHeader = doc.createElementNS(HTML_NS, "div") as HTMLElement;
    rowHeader.style.cssText = `
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 8px;
    `;

    const iconBadge = doc.createElementNS(HTML_NS, "span") as HTMLElement;
    iconBadge.textContent = info.icon;
    iconBadge.style.cssText = `font-size: 15px;`;
    rowHeader.appendChild(iconBadge);

    const capLabel = doc.createElementNS(HTML_NS, "span") as HTMLElement;
    capLabel.textContent =
      cap.type === "chat"
        ? "Text to Text"
        : cap.type === "tts"
          ? "Text to Speech"
          : cap.type === "stt"
            ? "Speech to Text"
            : `Model ${info.label}`;
    capLabel.style.cssText = `
      font-size: 13px;
      font-weight: 600;
      color: ${typeColor};
    `;
    rowHeader.appendChild(capLabel);

    const capDesc = doc.createElementNS(HTML_NS, "span") as HTMLElement;
    capDesc.textContent = info.description;
    capDesc.style.cssText = `
      font-size: 11px;
      color: ${isDark ? "#777" : "#aaa"};
      margin-left: auto;
    `;
    rowHeader.appendChild(capDesc);

    row.appendChild(rowHeader);

    // Two-column: Model + Endpoint
    const fieldRow = doc.createElementNS(HTML_NS, "div") as HTMLElement;
    fieldRow.style.cssText = `
      display: flex;
      gap: 8px;
    `;

    // Model input (plain text — always created, may be hidden for TTS+NanoGPT)
    const modelInput = doc.createElementNS(
      HTML_NS,
      "input",
    ) as HTMLInputElement;
    modelInput.type = "text";
    modelInput.placeholder = "Model name";
    modelInput.value = existing?.model || "";
    modelInput.style.cssText = `
      flex: 1;
      padding: 7px 10px;
      border: 1px solid ${inputBorder || (isDark ? "#444" : "#ccc")};
      border-radius: 5px;
      font-size: 13px;
      box-sizing: border-box;
      background: ${inputBg || (isDark ? "#2d2d2d" : "#ffffff")};
      color: ${inputText || defaultTitleColor};
      transition: border-color 0.2s;
    `;
    modelInput.addEventListener("focus", () => {
      modelInput.style.borderColor = inputFocusBorder;
      modelInput.style.outline = "none";
    });
    modelInput.addEventListener("blur", () => {
      modelInput.style.borderColor = inputBorder || (isDark ? "#444" : "#ccc");
    });

    // Chat: add a NanoGPT searchable model dropdown (shown when provider is NanoGPT)
    if (cap.type === "chat") {
      chatPlainModelInput = modelInput;
      // Sync plain text input to hidden inputs.model
      modelInput.addEventListener("input", () => {
        if (inputs.model) inputs.model.value = modelInput.value;
      });

      const chatSearchContainer = doc.createElementNS(
        HTML_NS,
        "div",
      ) as HTMLElement;
      chatSearchContainer.style.cssText = `
        flex: 1;
        position: relative;
        display: none;
      `;
      chatNanoSearchContainer = chatSearchContainer;

      const chatSearchInput = doc.createElementNS(
        HTML_NS,
        "input",
      ) as HTMLInputElement;
      chatNanoSearchInput = chatSearchInput;
      chatSearchInput.type = "text";
      chatSearchInput.placeholder = "Search models...";
      chatSearchInput.value = existing?.model || "";
      chatSearchInput.style.cssText = `
        width: 100%;
        padding: 7px 10px;
        border: 1px solid ${inputBorder || (isDark ? "#444" : "#ccc")};
        border-radius: 5px;
        font-size: 13px;
        box-sizing: border-box;
        background: ${inputBg || (isDark ? "#2d2d2d" : "#ffffff")};
        color: ${inputText || defaultTitleColor};
        transition: border-color 0.2s;
      `;

      const chatDropdownList = doc.createElementNS(
        HTML_NS,
        "div",
      ) as HTMLElement;
      chatDropdownList.style.cssText = `
        position: absolute;
        top: 100%;
        left: 0;
        right: 0;
        max-height: 180px;
        overflow-y: auto;
        border: 1px solid ${inputBorder || (isDark ? "#444" : "#ccc")};
        border-top: none;
        border-radius: 0 0 5px 5px;
        background: ${inputBg || (isDark ? "#2d2d2d" : "#ffffff")};
        z-index: 10001;
        display: none;
      `;

      let selectedChatModel = existing?.model || "";

      function renderChatModelItems(filter: string) {
        chatDropdownList.innerHTML = "";
        const query = filter.toLowerCase();
        const filtered = query
          ? allNanoModels.filter((m) => m.toLowerCase().includes(query))
          : allNanoModels;

        if (filtered.length === 0) {
          const emptyItem = doc.createElementNS(HTML_NS, "div") as HTMLElement;
          emptyItem.textContent = query
            ? "No matching models"
            : "No models available";
          emptyItem.style.cssText = `
            padding: 7px 10px;
            font-size: 12px;
            color: ${isDark ? "#888" : "#999"};
            font-style: italic;
          `;
          chatDropdownList.appendChild(emptyItem);
          return;
        }

        filtered.forEach((modelId) => {
          const item = doc.createElementNS(HTML_NS, "div") as HTMLElement;
          item.textContent = modelId;
          const isSelected = modelId === selectedChatModel;
          item.style.cssText = `
            padding: 6px 10px;
            font-size: 12px;
            cursor: pointer;
            color: ${inputText || defaultTitleColor};
            background: ${isSelected ? (isDark ? "#3a3a5e" : "#e0e8ff") : "transparent"};
          `;
          item.addEventListener("mouseenter", () => {
            if (modelId !== selectedChatModel) {
              item.style.background = isDark ? "#333" : "#f0f0f0";
            }
          });
          item.addEventListener("mouseleave", () => {
            item.style.background =
              modelId === selectedChatModel
                ? isDark
                  ? "#3a3a5e"
                  : "#e0e8ff"
                : "transparent";
          });
          item.addEventListener("click", () => {
            selectedChatModel = modelId;
            chatSearchInput.value = modelId;
            chatDropdownList.style.display = "none";
            chatSearchInput.style.borderRadius = "5px";
            chatSearchInput.style.borderBottom = `1px solid ${inputBorder || (isDark ? "#444" : "#ccc")}`;
            // Sync to the hidden plain model input and hidden inputs.model
            modelInput.value = modelId;
            if (inputs.model) inputs.model.value = modelId;
            if (inputs.name) inputs.name.value = `nano-${modelId}`;
          });
          chatDropdownList.appendChild(item);
        });
      }

      chatSearchInput.addEventListener("focus", () => {
        chatSearchInput.style.borderColor = inputFocusBorder;
        chatSearchInput.style.outline = "none";
        if (allNanoModels.length > 0) {
          chatDropdownList.style.display = "";
          chatSearchInput.style.borderRadius = "5px 5px 0 0";
          chatSearchInput.style.borderBottom = "none";
          renderChatModelItems(
            chatSearchInput.value === selectedChatModel
              ? ""
              : chatSearchInput.value,
          );
        }
      });

      chatSearchInput.addEventListener("input", () => {
        renderChatModelItems(chatSearchInput.value);
        if (
          chatDropdownList.style.display === "none" &&
          allNanoModels.length > 0
        ) {
          chatDropdownList.style.display = "";
          chatSearchInput.style.borderRadius = "5px 5px 0 0";
          chatSearchInput.style.borderBottom = "none";
        }
      });

      // Close dropdown when clicking outside
      doc.addEventListener("click", (e: Event) => {
        if (!chatSearchContainer.contains(e.target as Node)) {
          chatDropdownList.style.display = "none";
          chatSearchInput.style.borderRadius = "5px";
          chatSearchInput.style.borderBottom = `1px solid ${inputBorder || (isDark ? "#444" : "#ccc")}`;
          chatSearchInput.style.borderColor =
            inputBorder || (isDark ? "#444" : "#ccc");
          if (
            selectedChatModel &&
            chatSearchInput.value !== selectedChatModel
          ) {
            chatSearchInput.value = selectedChatModel;
          }
        }
      });

      chatSearchContainer.appendChild(chatSearchInput);
      chatSearchContainer.appendChild(chatDropdownList);

      // Show NanoGPT search or plain input based on current provider
      if (isCurrentProviderNanoGpt && allNanoModels.length > 0) {
        chatSearchContainer.style.display = "";
        modelInput.style.display = "none";
      } else if (isCurrentProviderNanoGpt) {
        // NanoGPT selected but models not loaded yet — will be toggled after fetch
        chatSearchContainer.style.display = "none";
        modelInput.style.display = "";
      }

      fieldRow.appendChild(chatSearchContainer);
      fieldRow.appendChild(modelInput);

      // Context Window input — placed beside the chat model selection
      contextLengthInput = doc.createElementNS(
        HTML_NS,
        "input",
      ) as HTMLInputElement;
      contextLengthInput.type = "number";
      contextLengthInput.placeholder = "Context (tokens)";
      contextLengthInput.value = existingConfig?.contextLength
        ? String(existingConfig.contextLength)
        : "";
      contextLengthInput.min = "4000";
      contextLengthInput.max = "2000000";
      contextLengthInput.style.cssText = `
        flex: 0.8;
        min-width: 110px;
        padding: 7px 10px;
        border: 1px solid ${inputBorder || (isDark ? "#444" : "#ccc")};
        border-radius: 5px;
        font-size: 12px;
        box-sizing: border-box;
        background: ${inputBg || (isDark ? "#2d2d2d" : "#ffffff")};
        color: ${existingConfig?.contextLength ? inputText || defaultTitleColor : isDark ? "#999" : "#777"};
        font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace;
        transition: border-color 0.2s;
      `;
      contextLengthInput.addEventListener("focus", () => {
        contextLengthInput.style.borderColor = inputFocusBorder;
        contextLengthInput.style.outline = "none";
        contextLengthInput.style.color = inputText || defaultTitleColor;
      });
      contextLengthInput.addEventListener("blur", () => {
        contextLengthInput.style.borderColor =
          inputBorder || (isDark ? "#444" : "#ccc");
        if (!contextLengthInput.value) {
          contextLengthInput.style.color = isDark ? "#999" : "#777";
        }
      });
      fieldRow.appendChild(contextLengthInput);
      fieldRow.appendChild(reSelect);
    } else {
      // Non-chat rows: model name first
      fieldRow.appendChild(modelInput);
    }

    // Endpoint input
    const endpointInput = doc.createElementNS(
      HTML_NS,
      "input",
    ) as HTMLInputElement;
    endpointInput.type = "text";
    endpointInput.placeholder = `Default: {url}${info.path}`;
    endpointInput.value = existing?.endpoint || "";
    endpointInput.style.cssText = `
      flex: 1.3;
      padding: 7px 10px;
      border: 1px solid ${inputBorder || (isDark ? "#444" : "#ccc")};
      border-radius: 5px;
      font-size: 12px;
      box-sizing: border-box;
      background: ${inputBg || (isDark ? "#2d2d2d" : "#ffffff")};
      color: ${isDark ? "#999" : "#777"};
      font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace;
      transition: border-color 0.2s;
    `;
    endpointInput.addEventListener("focus", () => {
      endpointInput.style.borderColor = inputFocusBorder;
      endpointInput.style.outline = "none";
      endpointInput.style.color = inputText || defaultTitleColor;
    });
    endpointInput.addEventListener("blur", () => {
      endpointInput.style.borderColor =
        inputBorder || (isDark ? "#444" : "#ccc");
      if (!endpointInput.value) {
        endpointInput.style.color = isDark ? "#999" : "#777";
      }
    });

    // Type-specific inputs go before endpoint (voice, dimensions, etc.)

    // Voice input (TTS only)
    let voiceInput: HTMLInputElement | undefined;
    if (cap.type === "tts") {
      voiceInput = doc.createElementNS(HTML_NS, "input") as HTMLInputElement;
      voiceInput.type = "text";
      voiceInput.placeholder = "Voice (e.g. af_bella)";
      voiceInput.value = existing?.voice || "";
      voiceInput.style.cssText = `
        flex: 0.7;
        padding: 7px 10px;
        border: 1px solid ${inputBorder || (isDark ? "#444" : "#ccc")};
        border-radius: 5px;
        font-size: 12px;
        box-sizing: border-box;
        background: ${inputBg || (isDark ? "#2d2d2d" : "#ffffff")};
        color: ${voiceInput.value ? inputText || defaultTitleColor : isDark ? "#999" : "#777"};
        font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace;
        transition: border-color 0.2s;
      `;
      voiceInput.addEventListener("focus", () => {
        voiceInput!.style.borderColor = inputFocusBorder;
        voiceInput!.style.outline = "none";
        voiceInput!.style.color = inputText || defaultTitleColor;
      });
      voiceInput.addEventListener("blur", () => {
        voiceInput!.style.borderColor =
          inputBorder || (isDark ? "#444" : "#ccc");
        if (!voiceInput!.value) {
          voiceInput!.style.color = isDark ? "#999" : "#777";
        }
      });
      fieldRow.appendChild(voiceInput);
    }

    // Dimensions + Max Tokens inputs (embedding only)
    let dimensionsInput: HTMLInputElement | undefined;
    let maxTokensInput: HTMLInputElement | undefined;
    if (cap.type === "embedding") {
      dimensionsInput = doc.createElementNS(
        HTML_NS,
        "input",
      ) as HTMLInputElement;
      dimensionsInput.type = "number";
      dimensionsInput.placeholder = "Dimensions";
      dimensionsInput.value = existing?.dimensions
        ? String(existing.dimensions)
        : "";
      dimensionsInput.min = "1";
      dimensionsInput.style.cssText = `
        flex: 0.5;
        padding: 7px 10px;
        border: 1px solid ${inputBorder || (isDark ? "#444" : "#ccc")};
        border-radius: 5px;
        font-size: 12px;
        box-sizing: border-box;
        background: ${inputBg || (isDark ? "#2d2d2d" : "#ffffff")};
        color: ${dimensionsInput.value ? inputText || defaultTitleColor : isDark ? "#999" : "#777"};
        font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace;
        transition: border-color 0.2s;
      `;
      dimensionsInput.addEventListener("focus", () => {
        dimensionsInput!.style.borderColor = inputFocusBorder;
        dimensionsInput!.style.outline = "none";
        dimensionsInput!.style.color = inputText || defaultTitleColor;
      });
      dimensionsInput.addEventListener("blur", () => {
        dimensionsInput!.style.borderColor =
          inputBorder || (isDark ? "#444" : "#ccc");
        if (!dimensionsInput!.value) {
          dimensionsInput!.style.color = isDark ? "#999" : "#777";
        }
      });
      fieldRow.appendChild(dimensionsInput);

      maxTokensInput = doc.createElementNS(
        HTML_NS,
        "input",
      ) as HTMLInputElement;
      maxTokensInput.type = "number";
      maxTokensInput.placeholder = "Max tokens";
      maxTokensInput.value = existing?.maxTokens
        ? String(existing.maxTokens)
        : "";
      maxTokensInput.min = "1";
      maxTokensInput.style.cssText = `
        flex: 0.5;
        padding: 7px 10px;
        border: 1px solid ${inputBorder || (isDark ? "#444" : "#ccc")};
        border-radius: 5px;
        font-size: 12px;
        box-sizing: border-box;
        background: ${inputBg || (isDark ? "#2d2d2d" : "#ffffff")};
        color: ${maxTokensInput.value ? inputText || defaultTitleColor : isDark ? "#999" : "#777"};
        font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace;
        transition: border-color 0.2s;
      `;
      maxTokensInput.addEventListener("focus", () => {
        maxTokensInput!.style.borderColor = inputFocusBorder;
        maxTokensInput!.style.outline = "none";
        maxTokensInput!.style.color = inputText || defaultTitleColor;
      });
      maxTokensInput.addEventListener("blur", () => {
        maxTokensInput!.style.borderColor =
          inputBorder || (isDark ? "#444" : "#ccc");
        if (!maxTokensInput!.value) {
          maxTokensInput!.style.color = isDark ? "#999" : "#777";
        }
      });
      fieldRow.appendChild(maxTokensInput);
    }

    // Endpoint input always last in the row
    fieldRow.appendChild(endpointInput);

    row.appendChild(fieldRow);
    endpointSection.appendChild(row);

    endpointInputs[cap.key] = {
      model: modelInput,
      endpoint: endpointInput,
      ...(voiceInput && { voice: voiceInput }),
      ...(dimensionsInput && { dimensions: dimensionsInput }),
      ...(maxTokensInput && { maxTokens: maxTokensInput }),
    };
  });

  // Append the endpoint section at the end (after Rate Limit)
  modal.appendChild(endpointSectionLabel);
  modal.appendChild(endpointSectionDesc);
  modal.appendChild(endpointSection);

  // contextLengthInput is now created inside the chat capability row above.

  // Error message container
  const errorBg = getCssVar("--modal-error-bg");
  const errorText = getCssVar("--modal-error-text");

  const errorContainer = doc.createElementNS(HTML_NS, "div") as HTMLElement;
  errorContainer.style.cssText = `
    color: ${errorText};
    font-size: 12px;
    margin-bottom: 16px;
    display: none;
    padding: 8px 12px;
    background: ${errorBg};
    border-radius: 4px;
  `;
  modal.appendChild(errorContainer);

  // Button container
  const buttonContainer = doc.createElementNS(HTML_NS, "div") as HTMLElement;
  buttonContainer.style.cssText = `
    display: flex;
    justify-content: flex-end;
    gap: 12px;
    margin-top: 8px;
  `;

  // Get button colors
  const btnBg = getCssVar("--modal-btn-bg");
  const btnHoverBg = getCssVar("--modal-btn-hover-bg");
  const btnText = getCssVar("--modal-btn-text");
  const btnPrimaryBg = getCssVar("--modal-btn-primary-bg");
  const btnPrimaryHoverBg = getCssVar("--modal-btn-primary-hover-bg");
  const btnPrimaryText = getCssVar("--modal-btn-primary-text");
  const btnBorder = getCssVar("--modal-input-border");

  // Cancel button
  const cancelBtn = doc.createElementNS(HTML_NS, "button") as HTMLButtonElement;
  cancelBtn.textContent = "Cancel";
  cancelBtn.style.cssText = `
    padding: 10px 20px;
    border: 1px solid ${btnBorder};
    border-radius: 6px;
    background: ${btnBg};
    color: ${btnText};
    font-size: 14px;
    cursor: pointer;
    transition: all 0.2s;
  `;
  cancelBtn.addEventListener("mouseenter", () => {
    cancelBtn.style.background = btnHoverBg;
  });
  cancelBtn.addEventListener("mouseleave", () => {
    cancelBtn.style.background = btnBg;
  });
  cancelBtn.addEventListener("click", () => {
    overlay.remove();
  });

  // Save button
  const saveBtn = doc.createElementNS(HTML_NS, "button") as HTMLButtonElement;
  saveBtn.textContent = isEdit ? "Save Changes" : "Add Configuration";
  saveBtn.style.cssText = `
    padding: 10px 20px;
    border: none;
    border-radius: 6px;
    background: ${btnPrimaryBg};
    color: ${btnPrimaryText};
    font-size: 14px;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.2s;
  `;
  saveBtn.addEventListener("mouseenter", () => {
    saveBtn.style.background = btnPrimaryHoverBg;
  });
  saveBtn.addEventListener("mouseleave", () => {
    saveBtn.style.background = btnPrimaryBg;
  });

  saveBtn.addEventListener("click", () => {
    // Enforce NanoGPT URL if the config is using a nano-gpt.com endpoint
    let apiURL = inputs.apiURL.value.trim();
    if (apiURL.includes("nano-gpt.com")) {
      apiURL = "https://nano-gpt.com/api/v1";
    }

    const newConfig = {
      name: inputs.name.value.trim(),
      apiURL,
      apiKey: inputs.apiKey.value.trim(),
      model: (endpointInputs.chat?.model.value || inputs.model.value).trim(),
      rateLimit: {
        type: rlTypeSelect.value as "tpm" | "rpm" | "concurrency",
        value: parseInt(rlValueInput.value) || 5,
      },
      ...(reSelect.value && {
        reasoningEffort: reSelect.value as "low" | "medium" | "high",
      }),
      // Per-capability endpoint configs (only include if model is provided)
      ...(endpointInputs.tts?.model.value.trim() && {
        ttsConfig: {
          model: endpointInputs.tts.model.value.trim(),
          ...(endpointInputs.tts.endpoint.value.trim() && {
            endpoint: endpointInputs.tts.endpoint.value.trim(),
          }),
          ...(endpointInputs.tts.voice?.value.trim() && {
            voice: endpointInputs.tts.voice.value.trim(),
          }),
        },
      }),
      ...(endpointInputs.stt?.model.value.trim() && {
        sttConfig: {
          model: endpointInputs.stt.model.value.trim(),
          ...(endpointInputs.stt.endpoint.value.trim() && {
            endpoint: endpointInputs.stt.endpoint.value.trim(),
          }),
        },
      }),
      ...(endpointInputs.embedding?.model.value.trim() && {
        embeddingConfig: {
          model: endpointInputs.embedding.model.value.trim(),
          ...(endpointInputs.embedding.endpoint.value.trim() && {
            endpoint: endpointInputs.embedding.endpoint.value.trim(),
          }),
          ...(endpointInputs.embedding.dimensions?.value.trim() && {
            dimensions:
              parseInt(endpointInputs.embedding.dimensions.value.trim(), 10) ||
              undefined,
          }),
          ...(endpointInputs.embedding.maxTokens?.value.trim() && {
            maxTokens:
              parseInt(endpointInputs.embedding.maxTokens.value.trim(), 10) ||
              undefined,
          }),
        },
      }),
      ...(endpointInputs.image?.model.value.trim() && {
        imageConfig: {
          model: endpointInputs.image.model.value.trim(),
          ...(endpointInputs.image.endpoint.value.trim() && {
            endpoint: endpointInputs.image.endpoint.value.trim(),
          }),
        },
      }),
      ...(endpointInputs.video?.model.value.trim() && {
        videoConfig: {
          model: endpointInputs.video.model.value.trim(),
          ...(endpointInputs.video.endpoint.value.trim() && {
            endpoint: endpointInputs.video.endpoint.value.trim(),
          }),
        },
      }),
      // Model context setting
      ...(contextLengthInput.value.trim() && {
        contextLength:
          parseInt(contextLengthInput.value.trim(), 10) || undefined,
      }),
    };

    // Validate
    const errors = validateModelConfig(newConfig);
    if (errors.length > 0) {
      errorContainer.textContent = errors.join("\n");
      errorContainer.style.display = "block";
      return;
    }

    if (isEdit && existingConfig) {
      updateModelConfig(existingConfig.id, newConfig);
    } else {
      addModelConfig(newConfig);
    }

    // Cache API key per provider URL for future reuse
    if (newConfig.apiKey && newConfig.apiURL) {
      try {
        const cached = JSON.parse(
          (Zotero.Prefs.get(
            `${config.prefsPrefix}.cachedProviderApiKeys`,
          ) as string) || "{}",
        );
        cached[newConfig.apiURL] = newConfig.apiKey;
        Zotero.Prefs.set(
          `${config.prefsPrefix}.cachedProviderApiKeys`,
          JSON.stringify(cached),
        );
      } catch (_) {
        /* ignore parse errors */
      }
    }

    overlay.remove();
    renderModelList();
    updateButtonStates();
  });

  buttonContainer.appendChild(cancelBtn);
  buttonContainer.appendChild(saveBtn);
  modal.appendChild(buttonContainer);

  // Close on overlay click
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) {
      overlay.remove();
    }
  });

  // Close on Escape key
  const handleEscape = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      overlay.remove();
      win.removeEventListener("keydown", handleEscape);
    }
  };
  win.addEventListener("keydown", handleEscape);

  overlay.appendChild(modal);

  const container = doc.body || doc.documentElement;
  if (container) {
    container.appendChild(overlay);
  }

  // Focus first input
  inputs.name.focus();
}

/**
 * Escape HTML for safe display
 */
function escapeHtml(text: string): string {
  const div = addon.data.prefs!.window.document.createElementNS(
    HTML_NS,
    "div",
  ) as HTMLElement;
  div.textContent = text;
  return div.innerHTML as string;
}
