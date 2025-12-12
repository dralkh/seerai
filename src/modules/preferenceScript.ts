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
import { AIModelConfig } from "./chat/types";

// Track selected model config ID
let selectedConfigId: string | null = null;

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
    const checkbox = doc?.querySelector(`#${checkboxId}`) as HTMLInputElement | null;
    if (!checkbox) return;

    // Load current value from preferences
    const currentValue = Zotero.Prefs.get(`${prefPrefix}.${prefKey}`) as boolean;
    checkbox.checked = currentValue ?? false;

    // Save value when changed
    checkbox.addEventListener("command", () => {
      Zotero.Prefs.set(`${prefPrefix}.${prefKey}`, checkbox.checked);
      ztoolkit.log(`Saved ${prefKey}: ${checkbox.checked}`);
    });
  }

  // Function to show/hide settings based on mode selection
  function updateModeVisibility(isLocal: boolean) {
    const localSettings = doc?.querySelector(`#zotero-prefpane-${config.addonRef}-localSettings`) as HTMLElement;
    const cloudSettings = doc?.querySelector(`#zotero-prefpane-${config.addonRef}-cloudSettings`) as HTMLElement;

    if (localSettings) {
      localSettings.style.display = isLocal ? "" : "none";
    }
    if (cloudSettings) {
      cloudSettings.style.display = isLocal ? "none" : "";
    }
  }

  // Bind menulist for mode selection
  const modeSelect = doc?.querySelector(`#zotero-prefpane-${config.addonRef}-datalabMode`) as XUL.MenuList;
  if (modeSelect) {
    // Load current value from preference
    const useLocal = Zotero.Prefs.get(`${prefPrefix}.datalabUseLocal`) as boolean ?? false;
    modeSelect.value = useLocal ? "local" : "cloud";
    updateModeVisibility(useLocal);

    // Save on change
    modeSelect.addEventListener("command", () => {
      const isLocal = modeSelect.value === "local";
      Zotero.Prefs.set(`${prefPrefix}.datalabUseLocal`, isLocal);
      updateModeVisibility(isLocal);
      ztoolkit.log(`Saved datalabUseLocal: ${isLocal}`);
    });
  }

  // Bind other DataLab settings
  bindInput(`zotero-prefpane-${config.addonRef}-datalabUrl`, "datalabUrl");
  bindInput(`zotero-prefpane-${config.addonRef}-datalabApiKey`, "datalabApiKey");
  bindInput(`zotero-prefpane-${config.addonRef}-datalabMaxConcurrent`, "datalabMaxConcurrent");

  // Local-specific settings
  bindCheckbox(`zotero-prefpane-${config.addonRef}-localForceOcr`, "localForceOcr");

  // Cloud-specific settings
  bindCheckbox(`zotero-prefpane-${config.addonRef}-cloudForceOcr`, "cloudForceOcr");
  bindCheckbox(`zotero-prefpane-${config.addonRef}-cloudUseLlm`, "cloudUseLlm");
}

/**
 * Initialize Model Configuration UI
 */
function initModelConfigUI() {
  const doc = addon.data.prefs!.window.document;

  // Render the model list
  renderModelList();

  // Bind button events
  const addBtn = doc?.querySelector(`#zotero-prefpane-${config.addonRef}-models-add`);
  const editBtn = doc?.querySelector(`#zotero-prefpane-${config.addonRef}-models-edit`);
  const deleteBtn = doc?.querySelector(`#zotero-prefpane-${config.addonRef}-models-delete`);
  const defaultBtn = doc?.querySelector(`#zotero-prefpane-${config.addonRef}-models-default`);

  addBtn?.addEventListener("command", () => {
    showModelConfigDialog();
  });

  editBtn?.addEventListener("command", () => {
    if (selectedConfigId) {
      const cfg = getModelConfigs().find(c => c.id === selectedConfigId);
      if (cfg) showModelConfigDialog(cfg);
    }
  });

  deleteBtn?.addEventListener("command", () => {
    if (selectedConfigId) {
      const configs = getModelConfigs();
      const cfg = configs.find(c => c.id === selectedConfigId);
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
  const existingItems = listContainer.querySelectorAll('.model-config-item');
  existingItems.forEach((item: Element) => item.remove());

  const configs = getModelConfigs();

  if (configs.length === 0) {
    if (emptyMsg) (emptyMsg as HTMLElement).style.display = 'block';
    return;
  }

  if (emptyMsg) (emptyMsg as HTMLElement).style.display = 'none';

  configs.forEach(cfg => {
    const item = doc.createElement('div');
    item.className = 'model-config-item';
    item.setAttribute('data-id', cfg.id);
    item.style.cssText = `
      padding: 8px 12px;
      margin: 4px 0;
      border-radius: 4px;
      cursor: pointer;
      background: ${cfg.isDefault ? '#e3f2fd' : '#fff'};
      border: 1px solid ${selectedConfigId === cfg.id ? '#1976d2' : (cfg.isDefault ? '#90caf9' : '#ddd')};
      display: flex;
      justify-content: space-between;
      align-items: center;
    `;

    const info = doc.createElement('div');
    info.innerHTML = `
      <strong style="font-size: 13px;">${escapeHtml(cfg.name)}</strong>
      ${cfg.isDefault ? '<span style="color: #1976d2; font-size: 11px; margin-left: 8px;">★ Default</span>' : ''}
      <div style="font-size: 11px; color: #666; margin-top: 2px;">
        ${escapeHtml(cfg.model)} • ${escapeHtml(new URL(cfg.apiURL).hostname)}
      </div>
    `;

    item.appendChild(info);
    item.addEventListener('click', () => {
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
  const editBtn = doc?.querySelector(`#zotero-prefpane-${config.addonRef}-models-edit`) as HTMLButtonElement;
  const deleteBtn = doc?.querySelector(`#zotero-prefpane-${config.addonRef}-models-delete`) as HTMLButtonElement;
  const defaultBtn = doc?.querySelector(`#zotero-prefpane-${config.addonRef}-models-default`) as HTMLButtonElement;

  const hasSelection = selectedConfigId !== null;
  if (editBtn) editBtn.disabled = !hasSelection;
  if (deleteBtn) deleteBtn.disabled = !hasSelection;
  if (defaultBtn) defaultBtn.disabled = !hasSelection;
}

/**
 * Show dialog to add/edit model configuration
 */
function showModelConfigDialog(existingConfig?: AIModelConfig) {
  const isEdit = !!existingConfig;
  const title = isEdit ? "Edit Model Configuration" : "Add Model Configuration";

  // Create a simple prompt-based dialog (Zotero dialogs are complex)
  const name = addon.data.prefs!.window.prompt(`${title}\n\nName:`, existingConfig?.name || "");
  if (!name) return;

  const apiURL = addon.data.prefs!.window.prompt("API URL:", existingConfig?.apiURL || "https://api.openai.com/v1/");
  if (!apiURL) return;

  const apiKey = addon.data.prefs!.window.prompt("API Key:", existingConfig?.apiKey || "");
  if (!apiKey) return;

  const model = addon.data.prefs!.window.prompt("Model:", existingConfig?.model || "gpt-4o-mini");
  if (!model) return;

  const newConfig = { name, apiURL, apiKey, model };

  // Validate
  const errors = validateModelConfig(newConfig);
  if (errors.length > 0) {
    addon.data.prefs!.window.alert("Validation errors:\n" + errors.join("\n"));
    return;
  }

  if (isEdit && existingConfig) {
    updateModelConfig(existingConfig.id, newConfig);
  } else {
    addModelConfig(newConfig);
  }

  renderModelList();
  updateButtonStates();
}

/**
 * Escape HTML for safe display
 */
function escapeHtml(text: string): string {
  const div = addon.data.prefs!.window.document.createElement('div');
  div.textContent = text;
  return div.innerHTML as string;
}

