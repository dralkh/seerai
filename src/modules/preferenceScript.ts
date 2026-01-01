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
  function updateModeVisibility(mode: string) {
    const localSettings = doc?.querySelector(`#zotero-prefpane-${config.addonRef}-localSettings`) as HTMLElement;
    const cloudSettings = doc?.querySelector(`#zotero-prefpane-${config.addonRef}-cloudSettings`) as HTMLElement;
    const mistralSettings = doc?.querySelector(`#zotero-prefpane-${config.addonRef}-mistralSettings`) as HTMLElement;

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
  const modeSelect = doc?.querySelector(`#zotero-prefpane-${config.addonRef}-datalabMode`) as XUL.MenuList;
  if (modeSelect) {
    // Load current value from preference (fallback to datalabUseLocal for backward compat)
    let currentMode = Zotero.Prefs.get(`${prefPrefix}.datalabMode`) as string;
    if (!currentMode) {
      // Backward compatibility: check old boolean preference
      const useLocal = Zotero.Prefs.get(`${prefPrefix}.datalabUseLocal`) as boolean;
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
  bindInput(`zotero-prefpane-${config.addonRef}-datalabApiKey`, "datalabApiKey");
  bindInput(`zotero-prefpane-${config.addonRef}-mistralApiKey`, "mistralApiKey");
  bindInput(`zotero-prefpane-${config.addonRef}-datalabMaxConcurrent`, "datalabMaxConcurrent");
  bindInput(`zotero-prefpane-${config.addonRef}-aiMaxConcurrent`, "aiMaxConcurrent");

  // AI Insights settings
  bindCheckbox(`zotero-prefpane-${config.addonRef}-searchAutoAiInsights`, "searchAutoAiInsights");
  bindInput(`zotero-prefpane-${config.addonRef}-searchAiInsightsPrompt`, "searchAiInsightsPrompt");
  bindInput(`zotero-prefpane-${config.addonRef}-searchAiInsightsResponseLength`, "searchAiInsightsResponseLength");

  // Bind menulist for citation style
  const styleSelect = doc?.querySelector(`#zotero-prefpane-${config.addonRef}-searchAiInsightsCitationStyle`) as XUL.MenuList;
  if (styleSelect) {
    styleSelect.value = Zotero.Prefs.get(`${prefPrefix}.searchAiInsightsCitationStyle`) as string || "numbered";
    styleSelect.addEventListener("command", () => {
      Zotero.Prefs.set(`${prefPrefix}.searchAiInsightsCitationStyle`, styleSelect.value);
    });
  }

  // Local-specific settings
  bindCheckbox(`zotero-prefpane-${config.addonRef}-localForceOcr`, "localForceOcr");

  // Cloud-specific settings
  bindCheckbox(`zotero-prefpane-${config.addonRef}-cloudForceOcr`, "cloudForceOcr");
  bindCheckbox(`zotero-prefpane-${config.addonRef}-cloudUseLlm`, "cloudUseLlm");

  // Semantic Scholar settings
  bindInput(`zotero-prefpane-${config.addonRef}-semanticScholarApiKey`, "semanticScholarApiKey");

  // Firecrawl settings
  bindInput(`zotero-prefpane-${config.addonRef}-firecrawlApiKey`, "firecrawlApiKey");
  bindInput(`zotero-prefpane-${config.addonRef}-firecrawlApiUrl`, "firecrawlApiUrl");
  bindInput(`zotero-prefpane-${config.addonRef}-firecrawlSearchLimit`, "firecrawlSearchLimit");

  // Initialize MCP Integration UI
  initMcpIntegrationUI();
}

/**
 * Initialize MCP Integration UI
 */
function initMcpIntegrationUI() {
  const doc = addon.data.prefs!.window.document;
  const configArea = doc.getElementById(`zotero-prefpane-${config.addonRef}-mcpConfigJson`) as any; // HTMLTextAreaElement
  const copyBtn = doc.getElementById(`zotero-prefpane-${config.addonRef}-copyMcpConfig`);

  if (!configArea) return;

  // Default config showing structure
  const mcpConfig = {
    "mcpServers": {
      "seerai-zotero": {
        "command": "node",
        "args": ["/absolute/path/to/seerai-mcp.cjs"]
      }
    }
  };

  configArea.value = JSON.stringify(mcpConfig, null, 2);

  copyBtn?.addEventListener("command", () => {
    // Copy to clipboard
    try {
      const clipboard = (Components.classes as any)["@mozilla.org/widget/clipboardhelper;1"]
        .getService((Components.interfaces as any).nsIClipboardHelper);
      clipboard.copyString(configArea.value);

      // Visual feedback
      const originalLabel = copyBtn.getAttribute("label");
      copyBtn.setAttribute("label", "Copied!");
      setTimeout(() => {
        copyBtn.setAttribute("label", originalLabel || "Copy Config to Clipboard");
      }, 2000);
    } catch (e) {
      addon.data.prefs!.window.alert("Failed to copy to clipboard");
      console.error(e);
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
 * Uses a single modal with all fields visible at once
 */
function showModelConfigDialog(existingConfig?: AIModelConfig) {
  const isEdit = !!existingConfig;
  const title = isEdit ? "Edit Model Configuration" : "Add Model Configuration";
  const doc = addon.data.prefs!.window.document;
  const win = addon.data.prefs!.window;

  // Remove any existing modal
  const existingModal = doc.getElementById('model-config-modal-overlay');
  if (existingModal) existingModal.remove();

  // Create modal overlay
  const overlay = doc.createElement('div');
  overlay.id = 'model-config-modal-overlay';
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
  const modal = doc.createElement('div');
  modal.style.cssText = `
    background: #fff;
    border-radius: 8px;
    padding: 24px;
    min-width: 420px;
    max-width: 500px;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.2);
  `;

  // Modal title
  const titleEl = doc.createElement('h3');
  titleEl.textContent = title;
  titleEl.style.cssText = `
    margin: 0 0 20px 0;
    font-size: 18px;
    font-weight: 600;
    color: #333;
  `;
  modal.appendChild(titleEl);

  // Provider presets
  const providerPresets = [
    { name: '— Select a preset —', apiURL: '', model: '', placeholder: '' },
    { name: 'OpenAI', apiURL: 'https://api.openai.com/v1/', model: 'gpt-5-mini', placeholder: 'sk-...' },
    { name: 'Anthropic', apiURL: 'https://api.anthropic.com/v1/', model: 'claude-sonnet-4.5', placeholder: 'sk-ant-...' },
    { name: 'Google AI (Gemini)', apiURL: 'https://generativelanguage.googleapis.com/v1beta/openai/', model: 'gemini-2.5-flash', placeholder: 'AIza...' },
    { name: 'Mistral AI', apiURL: 'https://api.mistral.ai/v1/', model: 'mistral-large-latest', placeholder: '' },
    { name: 'OpenRouter', apiURL: 'https://openrouter.ai/api/v1/', model: 'openai/gpt-5-mini', placeholder: 'sk-or-...' },
    { name: 'Groq', apiURL: 'https://api.groq.com/openai/v1/', model: 'openai/gpt-oss-120b', placeholder: 'gsk_...' },
    { name: 'DeepSeek', apiURL: 'https://api.deepseek.com/v1/', model: 'deepseek-chat', placeholder: 'sk-...' },
    { name: 'xAI (Grok)', apiURL: 'https://api.x.ai/v1/', model: 'grok-4.1-fast', placeholder: 'xai-...' },
    { name: 'Together AI', apiURL: 'https://api.together.xyz/v1/', model: 'openai/gpt-oss-120b', placeholder: '' },
    { name: 'Ollama (Local)', apiURL: 'http://localhost:11434/v1/', model: 'qwen3-vl:8b-thinking-q8_0', placeholder: '(optional)' },
    { name: 'OpenAI Compatible', apiURL: 'http://seerai.com:1234/v1/', model: 'local-model', placeholder: '(optional)' },
  ];

  // Field styles
  const labelStyle = `
    display: block;
    font-size: 13px;
    font-weight: 500;
    color: #555;
    margin-bottom: 4px;
  `;
  const inputStyle = `
    width: 100%;
    padding: 10px 12px;
    border: 1px solid #ddd;
    border-radius: 6px;
    font-size: 14px;
    margin-bottom: 16px;
    box-sizing: border-box;
    transition: border-color 0.2s;
  `;
  const selectStyle = `
    width: 100%;
    padding: 10px 12px;
    border: 1px solid #ddd;
    border-radius: 6px;
    font-size: 14px;
    margin-bottom: 16px;
    box-sizing: border-box;
    background: #fff;
    cursor: pointer;
  `;

  // Preset selector (only show for new configs)
  const inputs: Record<string, HTMLInputElement> = {};

  if (!isEdit) {
    const presetLabel = doc.createElement('label');
    presetLabel.textContent = 'Provider Preset';
    presetLabel.style.cssText = labelStyle;
    modal.appendChild(presetLabel);

    const presetSelect = doc.createElement('select') as HTMLSelectElement;
    presetSelect.style.cssText = selectStyle;

    providerPresets.forEach((preset, idx) => {
      const option = doc.createElement('option');
      option.value = String(idx);
      option.textContent = preset.name;
      presetSelect.appendChild(option);
    });

    presetSelect.addEventListener('change', () => {
      const idx = parseInt(presetSelect.value);
      const preset = providerPresets[idx];
      if (preset && idx > 0) {
        if (inputs.name && !inputs.name.value) inputs.name.value = preset.name;
        if (inputs.apiURL) inputs.apiURL.value = preset.apiURL;
        if (inputs.model) inputs.model.value = preset.model;
        if (inputs.apiKey) inputs.apiKey.placeholder = preset.placeholder || 'API Key';
      }
    });

    modal.appendChild(presetSelect);

    // Divider
    const divider = doc.createElement('div');
    divider.style.cssText = `
      border-top: 1px solid #eee;
      margin: 4px 0 16px 0;
      position: relative;
    `;
    const dividerText = doc.createElement('span');
    dividerText.textContent = 'or fill manually';
    dividerText.style.cssText = `
      position: absolute;
      top: -9px;
      left: 50%;
      transform: translateX(-50%);
      background: #fff;
      padding: 0 12px;
      font-size: 11px;
      color: #999;
    `;
    divider.appendChild(dividerText);
    modal.appendChild(divider);
  }

  // Create form fields
  const fields = [
    { id: 'name', label: 'Name', placeholder: 'My OpenAI Config', value: existingConfig?.name || '', type: 'text' },
    { id: 'apiURL', label: 'API URL', placeholder: 'https://api.openai.com/v1/', value: existingConfig?.apiURL || 'https://api.openai.com/v1/', type: 'text' },
    { id: 'apiKey', label: 'API Key', placeholder: 'sk-...', value: existingConfig?.apiKey || '', type: 'password' },
    { id: 'model', label: 'Model', placeholder: 'gpt-4o-mini', value: existingConfig?.model || 'gpt-4o-mini', type: 'text' },
  ];

  fields.forEach(field => {
    const label = doc.createElement('label');
    label.textContent = field.label;
    label.style.cssText = labelStyle;
    modal.appendChild(label);

    const input = doc.createElement('input') as HTMLInputElement;
    input.type = field.type;
    input.placeholder = field.placeholder;
    input.value = field.value;
    input.style.cssText = inputStyle;
    input.id = `model-config-${field.id}`;
    inputs[field.id] = input;
    modal.appendChild(input);

    // Add focus effect
    input.addEventListener('focus', () => {
      input.style.borderColor = '#1976d2';
      input.style.outline = 'none';
    });
    input.addEventListener('blur', () => {
      input.style.borderColor = '#ddd';
    });
  });

  // Error message container
  const errorContainer = doc.createElement('div');
  errorContainer.style.cssText = `
    color: #d32f2f;
    font-size: 12px;
    margin-bottom: 16px;
    display: none;
    padding: 8px 12px;
    background: #ffebee;
    border-radius: 4px;
  `;
  modal.appendChild(errorContainer);

  // Button container
  const buttonContainer = doc.createElement('div');
  buttonContainer.style.cssText = `
    display: flex;
    justify-content: flex-end;
    gap: 12px;
    margin-top: 8px;
  `;

  // Cancel button
  const cancelBtn = doc.createElement('button');
  cancelBtn.textContent = 'Cancel';
  cancelBtn.style.cssText = `
    padding: 10px 20px;
    border: 1px solid #ddd;
    border-radius: 6px;
    background: #fff;
    color: #666;
    font-size: 14px;
    cursor: pointer;
    transition: all 0.2s;
  `;
  cancelBtn.addEventListener('mouseenter', () => {
    cancelBtn.style.background = '#f5f5f5';
  });
  cancelBtn.addEventListener('mouseleave', () => {
    cancelBtn.style.background = '#fff';
  });
  cancelBtn.addEventListener('click', () => {
    overlay.remove();
  });

  // Save button
  const saveBtn = doc.createElement('button');
  saveBtn.textContent = isEdit ? 'Save Changes' : 'Add Configuration';
  saveBtn.style.cssText = `
    padding: 10px 20px;
    border: none;
    border-radius: 6px;
    background: #1976d2;
    color: #fff;
    font-size: 14px;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.2s;
  `;
  saveBtn.addEventListener('mouseenter', () => {
    saveBtn.style.background = '#1565c0';
  });
  saveBtn.addEventListener('mouseleave', () => {
    saveBtn.style.background = '#1976d2';
  });

  saveBtn.addEventListener('click', () => {
    const newConfig = {
      name: inputs.name.value.trim(),
      apiURL: inputs.apiURL.value.trim(),
      apiKey: inputs.apiKey.value.trim(),
      model: inputs.model.value.trim(),
    };

    // Validate
    const errors = validateModelConfig(newConfig);
    if (errors.length > 0) {
      errorContainer.textContent = errors.join('\n');
      errorContainer.style.display = 'block';
      return;
    }

    if (isEdit && existingConfig) {
      updateModelConfig(existingConfig.id, newConfig);
    } else {
      addModelConfig(newConfig);
    }

    overlay.remove();
    renderModelList();
    updateButtonStates();
  });

  buttonContainer.appendChild(cancelBtn);
  buttonContainer.appendChild(saveBtn);
  modal.appendChild(buttonContainer);

  // Close on overlay click
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) {
      overlay.remove();
    }
  });

  // Close on Escape key
  const handleEscape = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      overlay.remove();
      win.removeEventListener('keydown', handleEscape);
    }
  };
  win.addEventListener('keydown', handleEscape);

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
  const div = addon.data.prefs!.window.document.createElement('div');
  div.textContent = text;
  return div.innerHTML as string;
}

