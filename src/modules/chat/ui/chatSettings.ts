import {
  getModelConfigs,
  getActiveModelConfig,
  setActiveModelId,
  updateModelConfig,
} from "../modelConfig";
import { getChatStateManager } from "../stateManager";
import { config } from "../../../../package.json";
import { TOOL_NAMES } from "../tools/toolTypes";
import { isTtsConfigured } from "./messageRenderer";
import { getEmbeddingService } from "../rag/embeddingService";
import { getRAGConfig } from "../rag/retrievalEngine";

export interface ChatSettingsOptions {
  onModeChange?: (mode: "lock" | "default" | "explore") => void;
  onClose?: () => void;
}

export function showChatSettings(
  doc: Document,
  anchor: HTMLElement,
  options: ChatSettingsOptions = {},
): void {
  Zotero.debug("[seerai] showChatSettings called");
  const stateManager = getChatStateManager();
  // Remove existing if open (check body scope)
  const existing = doc.getElementById("chat-settings-popover-portal");
  if (existing) {
    Zotero.debug("[seerai] Removing existing settings popover");
    existing.remove();
    return;
  }

  const rect = anchor.getBoundingClientRect();
  const win = doc.defaultView as Window;

  const container = doc.createElement("div");
  container.id = "chat-settings-popover-portal";
  Object.assign(container.style, {
    position: "fixed",
    // Position above the anchor (sidebar footer usually)
    bottom: `${win.innerHeight - rect.top + 8}px`,
    left: `${rect.left}px`,
    width: "240px",
    backgroundColor: "var(--background-primary, #fff)",
    border: "1px solid var(--border-primary, #d1d1d1)",
    borderRadius: "8px",
    boxShadow: "0 4px 16px rgba(0,0,0,0.15)",
    display: "flex",
    flexDirection: "column",
    // Removed overflow:hidden to allow dropdowns to potentially exceed if we change strategy later,
    // but kept structure.
    fontSize: "13px",
    color: "var(--text-primary, #000)",
    zIndex: "200000", // Extreme high z-index
    pointerEvents: "auto",
  });

  // Header
  const header = doc.createElement("div");
  Object.assign(header.style, {
    padding: "8px 10px",
    borderBottom: "1px solid var(--border-primary)",
    backgroundColor: "var(--background-secondary, #f5f5f5)",
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    fontWeight: "600",
    fontSize: "12px",
  });
  header.innerHTML = "<span>Configuration</span>";
  container.appendChild(header);

  const body = doc.createElement("div");
  Object.assign(body.style, {
    padding: "10px",
    display: "flex",
    flexDirection: "column",
    gap: "12px", // Reduce gap for compactness
    maxHeight: "350px",
    overflowY: "auto",
  });

  // --- 1. Model Selection (Custom dropdown to avoid XUL <select> issues) ---
  const modelSection = doc.createElement("div");
  modelSection.style.position = "relative";

  const modelLabel = doc.createElement("div");
  modelLabel.innerText = "AI Model";
  modelLabel.style.marginBottom = "4px";
  modelLabel.style.fontSize = "11px";
  modelLabel.style.color = "var(--text-secondary, #666)";
  modelSection.appendChild(modelLabel);

  const configs = getModelConfigs();
  const activeConfig = getActiveModelConfig();

  // Custom dropdown button
  const modelButton = doc.createElement("div");
  Object.assign(modelButton.style, {
    width: "100%",
    padding: "6px 8px",
    borderRadius: "4px",
    fontSize: "12px",
    border: "1px solid var(--border-primary)",
    backgroundColor: "var(--background-secondary, #f5f5f5)",
    cursor: "pointer",
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    boxSizing: "border-box",
  });
  modelButton.innerText =
    activeConfig?.name ||
    (configs.length === 0 ? "Default" : configs[0]?.name || "Select Model");

  // Dropdown arrow
  const arrow = doc.createElement("span");
  arrow.innerText = "▼";
  arrow.style.fontSize = "8px";
  arrow.style.marginLeft = "8px";
  modelButton.appendChild(arrow);

  // Dropdown options container
  const optionsContainer = doc.createElement("div");
  Object.assign(optionsContainer.style, {
    position: "absolute",
    top: "100%",
    left: "0",
    right: "0",
    backgroundColor: "var(--background-primary, #fff)",
    border: "1px solid var(--border-primary)",
    borderRadius: "4px",
    boxShadow: "0 4px 8px rgba(0,0,0,0.15)",
    zIndex: "10005",
    display: "none",
    maxHeight: "150px",
    overflowY: "auto",
  });

  // Populate options
  if (configs.length === 0) {
    const optEl = doc.createElement("div");
    Object.assign(optEl.style, {
      padding: "8px 10px",
      fontSize: "12px",
      color: "var(--text-secondary)",
    });
    optEl.innerText = "No models configured";
    optionsContainer.appendChild(optEl);
  } else {
    configs.forEach((cfg) => {
      const optEl = doc.createElement("div");
      Object.assign(optEl.style, {
        padding: "8px 10px",
        fontSize: "12px",
        cursor: "pointer",
        backgroundColor:
          activeConfig && cfg.id === activeConfig.id
            ? "var(--background-secondary)"
            : "transparent",
        fontWeight:
          activeConfig && cfg.id === activeConfig.id ? "600" : "normal",
      });
      optEl.innerText = cfg.name;

      optEl.addEventListener("mouseenter", () => {
        optEl.style.backgroundColor = "var(--background-tertiary, #e0e0e0)";
      });
      optEl.addEventListener("mouseleave", () => {
        optEl.style.backgroundColor =
          activeConfig && cfg.id === activeConfig.id
            ? "var(--background-secondary)"
            : "transparent";
      });

      optEl.addEventListener("click", (e) => {
        e.stopPropagation();
        setActiveModelId(cfg.id);
        modelButton.childNodes[0].textContent = cfg.name;
        optionsContainer.style.display = "none";
        Zotero.debug(`[seerai] Model changed to ${cfg.id} (${cfg.name})`);
      });

      optionsContainer.appendChild(optEl);
    });
  }

  // Toggle dropdown
  modelButton.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    Zotero.debug("[seerai] Model button clicked");
    const isVisible = optionsContainer.style.display === "block";
    optionsContainer.style.display = isVisible ? "none" : "block";
  });

  modelSection.appendChild(modelButton);
  modelSection.appendChild(optionsContainer);
  body.appendChild(modelSection);

  // --- 1.5. Model Parameters (Temp & Max Tokens) ---
  const paramSection = doc.createElement("div");
  paramSection.style.marginTop = "4px";
  paramSection.style.display = "flex";
  paramSection.style.flexDirection = "column";
  paramSection.style.gap = "8px";

  const currentOptions = stateManager.getOptions();

  // Temperature Row
  const tempRow = doc.createElement("div");
  Object.assign(tempRow.style, {
    display: "flex",
    flexDirection: "column",
    gap: "4px",
  });

  const tempHeader = doc.createElement("div");
  Object.assign(tempHeader.style, {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    fontSize: "11px",
    color: "var(--text-secondary)",
  });

  const tempLabel = doc.createElement("span");
  tempLabel.innerText = "Temperature:";

  // Value display or "Default"
  const tempValueDisplay = doc.createElement("span");
  const formatTemp = (t?: number) =>
    t === undefined ? "Default" : t.toFixed(1);
  tempValueDisplay.innerText = formatTemp(currentOptions.temperature);
  tempValueDisplay.style.fontWeight = "600";
  tempValueDisplay.style.color = "var(--text-primary)";

  const tempResetBtn = doc.createElement("span");
  tempResetBtn.innerText = "↺";
  tempResetBtn.title = "Reset to Default";
  Object.assign(tempResetBtn.style, {
    marginLeft: "10px",
    fontSize: "14px",
    cursor: "pointer",
    color: "var(--text-tertiary, #999)",
    display: currentOptions.temperature === undefined ? "none" : "inline-block",
  });

  const infoGroup = doc.createElement("div");
  infoGroup.style.display = "flex";
  infoGroup.style.alignItems = "center";
  infoGroup.appendChild(tempValueDisplay);
  infoGroup.appendChild(tempResetBtn);

  tempHeader.appendChild(tempLabel);
  tempHeader.appendChild(infoGroup);

  // Slider
  const tempSlider = doc.createElement("input");
  tempSlider.type = "range";
  tempSlider.min = "0";
  tempSlider.max = "2";
  tempSlider.step = "0.1";
  tempSlider.value = String(currentOptions.temperature ?? 0.7);
  tempSlider.disabled = false;
  Object.assign(tempSlider.style, {
    flex: "1",
    height: "4px",
    cursor: "pointer",
  });

  tempResetBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    stateManager.setOptions({
      ...stateManager.getOptions(),
      temperature: undefined,
    });
    tempValueDisplay.innerText = "Default";
    tempSlider.value = "0.7";
    tempResetBtn.style.display = "none";
    Zotero.debug("[seerai] Temperature reset to default");
  });

  tempSlider.addEventListener("input", (e) => {
    const val = parseFloat((e.target as HTMLInputElement).value);
    tempValueDisplay.innerText = val.toFixed(1);
    tempResetBtn.style.display = "inline-block";
    stateManager.setOptions({ ...stateManager.getOptions(), temperature: val });
  });

  tempRow.appendChild(tempHeader);
  tempRow.appendChild(tempSlider);
  paramSection.appendChild(tempRow);

  // Max Tokens Row
  const tokensRow = doc.createElement("div");
  Object.assign(tokensRow.style, {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    fontSize: "11px",
  });

  const tokensInfo = doc.createElement("div");
  Object.assign(tokensInfo.style, {
    display: "flex",
    alignItems: "center",
    gap: "4px",
  });

  const tokensLabel = doc.createElement("span");
  tokensLabel.innerText = "Max Response Length:";
  tokensLabel.style.color = "var(--text-secondary)";

  const tokensResetBtn = doc.createElement("span");
  tokensResetBtn.innerText = "↺";
  tokensResetBtn.title = "Reset to Default";
  Object.assign(tokensResetBtn.style, {
    fontSize: "14px",
    cursor: "pointer",
    color: "var(--text-tertiary, #999)",
    display: currentOptions.maxTokens ? "inline-block" : "none",
  });

  tokensInfo.appendChild(tokensLabel);
  tokensInfo.appendChild(tokensResetBtn);
  tokensRow.appendChild(tokensInfo);
  const tokensInput = doc.createElement("input");
  tokensInput.type = "number";
  tokensInput.min = "1";
  tokensInput.placeholder = "Default"; // or model max
  if (currentOptions.maxTokens) {
    tokensInput.value = String(currentOptions.maxTokens);
  }

  Object.assign(tokensInput.style, {
    width: "50px",
    padding: "2px",
    fontSize: "11px",
    border: "1px solid var(--border-primary)",
    borderRadius: "4px",
    textAlign: "center",
  });

  tokensInput.addEventListener("input", () => {
    const val = parseInt(tokensInput.value);
    if (!isNaN(val) && val > 0) {
      tokensResetBtn.style.display = "inline-block";
      stateManager.setOptions({ ...stateManager.getOptions(), maxTokens: val });
    } else {
      tokensResetBtn.style.display = "none";
      stateManager.setOptions({
        ...stateManager.getOptions(),
        maxTokens: undefined,
      });
    }
  });

  tokensResetBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    stateManager.setOptions({
      ...stateManager.getOptions(),
      maxTokens: undefined,
    });
    tokensInput.value = "";
    tokensResetBtn.style.display = "none";
    Zotero.debug("[seerai] Max tokens reset to default");
  });

  tokensRow.appendChild(tokensInput);
  paramSection.appendChild(tokensRow);

  body.appendChild(paramSection);

  // --- 2. Context Mode ---
  const currentMode = stateManager.getOptions().selectionMode;

  const modeSection = doc.createElement("div");
  const modeLabel = doc.createElement("div");
  modeLabel.innerText = "Context Mode";
  modeLabel.style.marginBottom = "4px";
  modeLabel.style.fontSize = "11px";
  modeLabel.style.color = "var(--text-secondary, #666)";
  modeSection.appendChild(modeLabel);

  const modeContainer = doc.createElement("div");
  Object.assign(modeContainer.style, {
    display: "flex",
    backgroundColor: "var(--background-secondary)",
    borderRadius: "4px",
    padding: "2px",
    border: "1px solid var(--border-primary)",
  });

  const modes = [
    { value: "lock", label: "🔒", title: "Lock: Manual only" },
    { value: "default", label: "📌", title: "Focus: Single item" },
    { value: "explore", label: "📚", title: "Explore: Additive" },
  ];

  modes.forEach((m) => {
    const btn = doc.createElement("div");
    Object.assign(btn.style, {
      flex: "1",
      textAlign: "center",
      padding: "4px 2px",
      fontSize: "12px",
      cursor: "pointer",
      borderRadius: "3px",
      transition: "background 0.2s",
    });
    btn.innerText = m.label;
    btn.title = m.title;

    if (m.value === currentMode) {
      btn.style.backgroundColor = "var(--background-primary)";
      btn.style.boxShadow = "0 1px 2px rgba(0,0,0,0.1)";
      btn.style.fontWeight = "600";
    } else {
      btn.style.color = "var(--text-secondary)";
    }

    btn.addEventListener("click", () => {
      // Update UI visually
      Array.from(modeContainer.children).forEach((child: any) => {
        child.style.backgroundColor = "transparent";
        child.style.boxShadow = "none";
        child.style.fontWeight = "normal";
        child.style.color = "var(--text-secondary)";
      });
      btn.style.backgroundColor = "var(--background-primary)";
      btn.style.boxShadow = "0 1px 2px rgba(0,0,0,0.1)";
      btn.style.fontWeight = "600";
      btn.style.color = "var(--text-primary)";

      stateManager.setOptions({ selectionMode: m.value as any });
      // Persist selection mode to preferences
      Zotero.Prefs.set("extensions.seerai.selectionMode", m.value);
      Zotero.debug(`[seerai] Selection mode changed to: ${m.value}`);
      options.onModeChange?.(m.value as any);
    });

    modeContainer.appendChild(btn);
  });
  modeSection.appendChild(modeContainer);
  body.appendChild(modeSection);

  // --- 3. Web Search --- (moved to input area search button)

  // --- 4. Agent Config (Max Iterations & Auto-OCR) ---
  const configSection = doc.createElement("div");
  configSection.style.marginTop = "8px";
  configSection.style.borderTop = "1px solid var(--border-primary)";
  configSection.style.paddingTop = "8px";
  configSection.style.display = "flex";
  configSection.style.flexDirection = "column";
  configSection.style.gap = "8px";

  // Header
  const configHeader = doc.createElement("div");
  configHeader.innerText = "Agent Settings";
  configHeader.style.marginBottom = "2px";
  configHeader.style.fontSize = "11px";
  configHeader.style.color = "var(--text-secondary, #666)";
  configSection.appendChild(configHeader);

  // Max Iterations Row
  const iterRow = doc.createElement("div");
  Object.assign(iterRow.style, {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    fontSize: "11px",
  });

  const iterLabel = doc.createElement("span");
  iterLabel.innerText = "Max Iterations:";

  const iterInput = doc.createElement("input");
  iterInput.type = "number";
  iterInput.min = "1";
  iterInput.max = "50";
  const currentMaxIter =
    Zotero.Prefs.get("extensions.seerai.agentMaxIterations") || 10;
  iterInput.value = String(currentMaxIter);
  Object.assign(iterInput.style, {
    width: "40px",
    padding: "2px",
    fontSize: "11px",
    border: "1px solid var(--border-primary)",
    borderRadius: "4px",
    textAlign: "center",
  });

  iterInput.addEventListener("change", () => {
    let val = parseInt(iterInput.value);
    if (val < 1) val = 1;
    if (val > 50) val = 50;
    iterInput.value = String(val);
    Zotero.Prefs.set("extensions.seerai.agentMaxIterations", val);
    Zotero.debug(`[seerai] Max iterations set to ${val}`);
  });
  iterInput.addEventListener("click", (e) => e.stopPropagation());

  iterRow.appendChild(iterLabel);
  iterRow.appendChild(iterInput);
  configSection.appendChild(iterRow);

  // Auto-OCR Row
  const ocrRow = doc.createElement("div");
  Object.assign(ocrRow.style, {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    fontSize: "11px",
  });

  const ocrLabel = doc.createElement("span");
  ocrLabel.innerText = "Auto-OCR Papers:";

  // Toggle Switch for OCR
  const ocrToggleWrapper = doc.createElement("div");
  const isOcrEnabled =
    Zotero.Prefs.get("extensions.seerai.agentAutoOcr") || false;

  Object.assign(ocrToggleWrapper.style, {
    position: "relative",
    width: "28px",
    height: "16px",
    backgroundColor: isOcrEnabled ? "#4cd964" : "#e5e5ea",
    borderRadius: "8px",
    cursor: "pointer",
    transition: "background 0.2s",
  });

  const ocrToggleKnob = doc.createElement("div");
  Object.assign(ocrToggleKnob.style, {
    position: "absolute",
    top: "2px",
    left: isOcrEnabled ? "14px" : "2px",
    width: "12px",
    height: "12px",
    backgroundColor: "#fff",
    borderRadius: "50%",
    boxShadow: "0 1px 2px rgba(0,0,0,0.2)",
    transition: "left 0.2s",
  });

  ocrToggleWrapper.appendChild(ocrToggleKnob);

  ocrToggleWrapper.addEventListener("click", (e) => {
    e.stopPropagation();
    const current = Zotero.Prefs.get("extensions.seerai.agentAutoOcr") || false;
    const newState = !current;
    Zotero.Prefs.set("extensions.seerai.agentAutoOcr", newState);

    // Update UI
    ocrToggleWrapper.style.backgroundColor = newState ? "#4cd964" : "#e5e5ea";
    ocrToggleKnob.style.left = newState ? "14px" : "2px";
    Zotero.debug(`[seerai] Auto-OCR set to ${newState}`);
  });

  ocrRow.appendChild(ocrLabel);
  ocrRow.appendChild(ocrToggleWrapper);
  configSection.appendChild(ocrRow);

  // Use Notes Only Row
  const notesOnlyRow = doc.createElement("div");
  Object.assign(notesOnlyRow.style, {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    fontSize: "11px",
  });
  const notesOnlyLabel = doc.createElement("span");
  notesOnlyLabel.innerText = "Use notes only:";
  notesOnlyLabel.title = "Exclude PDF full text, only use notes from items";

  const notesOnlyToggle = createToggleSwitch(
    doc,
    !!stateManager.getOptions().includeNotesOnly,
    (newState) => {
      stateManager.setOptions({ includeNotesOnly: newState });
      Zotero.debug(`[seerai] includeNotesOnly set to ${newState}`);
    },
  );
  notesOnlyRow.appendChild(notesOnlyLabel);
  notesOnlyRow.appendChild(notesOnlyToggle);
  configSection.appendChild(notesOnlyRow);

  // Disable Same-Title Note Skip Row
  const skipCheckRow = doc.createElement("div");
  Object.assign(skipCheckRow.style, {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    fontSize: "11px",
  });
  const skipCheckLabel = doc.createElement("span");
  skipCheckLabel.innerText = "Allow duplicates:";
  skipCheckLabel.title = "Include both PDF and note even if titles match";

  const skipCheckToggle = createToggleSwitch(
    doc,
    !!stateManager.getOptions().disableSameTitleNoteSkip,
    (newState) => {
      stateManager.setOptions({ disableSameTitleNoteSkip: newState });
      Zotero.debug(`[seerai] disableSameTitleNoteSkip set to ${newState}`);
    },
  );
  skipCheckRow.appendChild(skipCheckLabel);
  skipCheckRow.appendChild(skipCheckToggle);
  configSection.appendChild(skipCheckRow);

  // Auto-Play TTS Row (only shown when TTS is configured)
  if (isTtsConfigured()) {
    const ttsRow = doc.createElement("div");
    Object.assign(ttsRow.style, {
      display: "flex",
      justifyContent: "space-between",
      alignItems: "center",
      fontSize: "11px",
    });
    const ttsLabel = doc.createElement("span");
    ttsLabel.innerText = "Auto-play TTS:";
    ttsLabel.title = "Automatically play TTS for assistant responses";

    const ttsToggle = createToggleSwitch(
      doc,
      !!stateManager.getOptions().autoPlayTts,
      (newState) => {
        stateManager.setOptions({ autoPlayTts: newState });
        Zotero.debug(`[seerai] autoPlayTts set to ${newState}`);
      },
    );
    ttsRow.appendChild(ttsLabel);
    ttsRow.appendChild(ttsToggle);
    configSection.appendChild(ttsRow);
  }

  body.appendChild(configSection);

  /**
   * Helper to create a toggle switch
   */
  function createToggleSwitch(
    doc: Document,
    initialState: boolean,
    onChange: (state: boolean) => void,
  ): HTMLElement {
    const wrapper = doc.createElement("div");
    Object.assign(wrapper.style, {
      position: "relative",
      width: "28px",
      height: "16px",
      backgroundColor: initialState ? "#4cd964" : "#e5e5ea",
      borderRadius: "8px",
      cursor: "pointer",
      transition: "background 0.2s",
    });

    const knob = doc.createElement("div");
    Object.assign(knob.style, {
      position: "absolute",
      top: "2px",
      left: initialState ? "14px" : "2px",
      width: "12px",
      height: "12px",
      backgroundColor: "#fff",
      borderRadius: "50%",
      boxShadow: "0 1px 2px rgba(0,0,0,0.2)",
      transition: "left 0.2s",
    });
    wrapper.appendChild(knob);

    wrapper.addEventListener("click", (e) => {
      e.stopPropagation();
      const currentState =
        wrapper.style.backgroundColor === "rgb(76, 217, 100)" ||
        wrapper.style.backgroundColor === "#4cd964";
      const newState = !currentState;
      wrapper.style.backgroundColor = newState ? "#4cd964" : "#e5e5ea";
      knob.style.left = newState ? "14px" : "2px";
      onChange(newState);
    });

    return wrapper;
  }

  // --- 5. Smart Context (RAG / Semantic Search) ---
  const ragSection = doc.createElement("div");
  ragSection.style.marginTop = "8px";
  ragSection.style.borderTop = "1px solid var(--border-primary)";
  ragSection.style.paddingTop = "8px";

  const ragHeader = doc.createElement("div");
  Object.assign(ragHeader.style, {
    fontSize: "11px",
    fontWeight: "600",
    color: "var(--text-secondary, #666)",
    marginBottom: "6px",
  });
  ragHeader.innerText = "Smart Context";
  ragSection.appendChild(ragHeader);

  // Embedding status indicator
  const embeddingService = getEmbeddingService();
  const isEmbeddingConfigured = embeddingService.isConfigured();
  const ragConfig = getRAGConfig();

  const statusRow = doc.createElement("div");
  Object.assign(statusRow.style, {
    display: "flex",
    alignItems: "center",
    gap: "6px",
    fontSize: "10px",
    color: "var(--text-tertiary, #999)",
    marginBottom: "6px",
  });

  const statusDot = doc.createElement("span");
  Object.assign(statusDot.style, {
    width: "6px",
    height: "6px",
    borderRadius: "50%",
    backgroundColor: isEmbeddingConfigured ? "#4cd964" : "#e5e5ea",
    display: "inline-block",
  });
  statusRow.appendChild(statusDot);

  const statusText = doc.createElement("span");
  if (isEmbeddingConfigured) {
    const modelName = embeddingService.getConfiguredModel() || "configured";
    statusText.innerText = `Embedding: ${modelName}`;
  } else {
    statusText.innerText = "Embedding: not configured (set in Preferences)";
  }
  statusRow.appendChild(statusText);
  ragSection.appendChild(statusRow);

  // Semantic Search toggle
  const ragToggleRow = doc.createElement("div");
  Object.assign(ragToggleRow.style, {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: "4px",
    opacity: isEmbeddingConfigured ? "1" : "0.5",
  });

  const ragToggleLabel = doc.createElement("span");
  ragToggleLabel.style.fontSize = "11px";
  ragToggleLabel.innerText = "Semantic Search";
  ragToggleLabel.title =
    "When enabled, uses embeddings to retrieve only the most relevant passages instead of sending full document text";

  const currentRagEnabled =
    currentOptions.ragEnabled !== undefined
      ? currentOptions.ragEnabled
      : ragConfig.enabled;

  const ragToggle = createToggleSwitch(
    doc,
    currentRagEnabled && isEmbeddingConfigured,
    (newState) => {
      if (!isEmbeddingConfigured) return;
      stateManager.setOptions({ ragEnabled: newState });
      Zotero.Prefs.set(`${config.prefsPrefix}.ragEnabled`, newState);
      Zotero.debug(`[seerai] RAG enabled set to ${newState}`);
      // Show/hide sub-rows
      if (alwaysUseRow) {
        alwaysUseRow.style.display = newState ? "flex" : "none";
      }
      if (thresholdRow) {
        const showThreshold = newState && !activeModelCfg?.ragAlwaysUse;
        thresholdRow.style.display = showThreshold ? "flex" : "none";
      }
      if (topKRow) {
        topKRow.style.display = newState ? "flex" : "none";
      }
      if (minScoreRow) {
        minScoreRow.style.display = newState ? "flex" : "none";
      }
    },
  );

  ragToggleRow.appendChild(ragToggleLabel);
  ragToggleRow.appendChild(ragToggle);
  ragSection.appendChild(ragToggleRow);

  // "Always Use RAG" toggle — persisted on the active model config
  const activeModelCfg = getActiveModelConfig();
  const currentAlwaysUse = activeModelCfg?.ragAlwaysUse ?? false;

  const alwaysUseRow = doc.createElement("div");
  Object.assign(alwaysUseRow.style, {
    display: currentRagEnabled ? "flex" : "none",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: "4px",
  });

  const alwaysUseLabel = doc.createElement("span");
  alwaysUseLabel.style.fontSize = "11px";
  alwaysUseLabel.innerText = "Always Use RAG";
  alwaysUseLabel.title =
    "Always use semantic search regardless of token threshold (bypass size check)";

  const alwaysUseToggle = createToggleSwitch(
    doc,
    currentAlwaysUse && isEmbeddingConfigured,
    (newState) => {
      if (!isEmbeddingConfigured || !activeModelCfg) return;
      updateModelConfig(activeModelCfg.id, { ragAlwaysUse: newState });
      Zotero.debug(
        `[seerai] RAG always-use set to ${newState} for model ${activeModelCfg.name}`,
      );
      // Hide threshold when always-use is on (threshold is irrelevant)
      if (thresholdRow) {
        thresholdRow.style.display = newState ? "none" : "flex";
      }
    },
  );

  alwaysUseRow.appendChild(alwaysUseLabel);
  alwaysUseRow.appendChild(alwaysUseToggle);
  ragSection.appendChild(alwaysUseRow);

  // Token threshold input — persisted on the active model config
  const currentThreshold =
    activeModelCfg?.ragTokenThreshold ??
    currentOptions.ragTokenThreshold ??
    ragConfig.tokenThreshold;

  const thresholdRow = doc.createElement("div");
  Object.assign(thresholdRow.style, {
    display: currentRagEnabled && !currentAlwaysUse ? "flex" : "none",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: "4px",
  });

  const thresholdLabel = doc.createElement("span");
  thresholdLabel.style.fontSize = "11px";
  thresholdLabel.innerText = "Token Threshold";
  thresholdLabel.title = "RAG activates when context exceeds this token count";

  const thresholdInput = doc.createElement("input");
  Object.assign(thresholdInput.style, {
    width: "60px",
    fontSize: "11px",
    padding: "2px 4px",
    border: "1px solid var(--border-primary)",
    borderRadius: "3px",
    backgroundColor: "var(--background-primary)",
    color: "var(--text-primary)",
    textAlign: "right",
  });
  thresholdInput.type = "number";
  thresholdInput.min = "1000";
  thresholdInput.max = "2000000";
  thresholdInput.step = "1000";
  thresholdInput.value = String(currentThreshold);

  thresholdInput.addEventListener("input", () => {
    const val = parseInt(thresholdInput.value, 10);
    if (!isNaN(val) && val >= 1000) {
      // Save to model config (persistent per model)
      if (activeModelCfg) {
        updateModelConfig(activeModelCfg.id, { ragTokenThreshold: val });
        Zotero.debug(
          `[seerai] RAG token threshold set to ${val} for model ${activeModelCfg.name}`,
        );
      }
      // Also update conversation-level option
      stateManager.setOptions({ ragTokenThreshold: val });
    }
  });

  thresholdRow.appendChild(thresholdLabel);
  thresholdRow.appendChild(thresholdInput);
  ragSection.appendChild(thresholdRow);

  // Max Passages (topK) input — persisted on the active model config
  const currentTopK = activeModelCfg?.ragTopK ?? ragConfig.topK;

  const topKRow = doc.createElement("div");
  Object.assign(topKRow.style, {
    display: currentRagEnabled ? "flex" : "none",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: "4px",
  });

  const topKLabel = doc.createElement("span");
  topKLabel.style.fontSize = "11px";
  topKLabel.innerText = "Max Passages";
  topKLabel.title =
    "Maximum number of passages (chunks) to include in the prompt. Higher values give more context but use more tokens.";

  const topKInput = doc.createElement("input");
  Object.assign(topKInput.style, {
    width: "50px",
    fontSize: "11px",
    padding: "2px 4px",
    border: "1px solid var(--border-primary)",
    borderRadius: "3px",
    backgroundColor: "var(--background-primary)",
    color: "var(--text-primary)",
    textAlign: "right",
  });
  topKInput.type = "number";
  topKInput.min = "5";
  topKInput.max = "500";
  topKInput.step = "5";
  topKInput.value = String(currentTopK);

  // Use "input" event so the value is saved immediately on every change
  // (spinner clicks, typing, etc.) — "change" only fires on blur, which may
  // never occur if the popover is dismissed via an outside click.
  topKInput.addEventListener("input", () => {
    const val = parseInt(topKInput.value, 10);
    if (!isNaN(val) && val >= 5 && val <= 500) {
      if (activeModelCfg) {
        updateModelConfig(activeModelCfg.id, { ragTopK: val });
        Zotero.debug(
          `[seerai] RAG topK set to ${val} for model ${activeModelCfg.name}`,
        );
      }
    }
  });

  topKRow.appendChild(topKLabel);
  topKRow.appendChild(topKInput);
  ragSection.appendChild(topKRow);

  // Min Score input — persisted on the active model config
  const currentMinScore =
    activeModelCfg?.ragMinScore ??
    Math.round((ragConfig.minScore || 0.3) * 100);

  const minScoreRow = doc.createElement("div");
  Object.assign(minScoreRow.style, {
    display: currentRagEnabled ? "flex" : "none",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: "4px",
  });

  const minScoreLabel = doc.createElement("span");
  minScoreLabel.style.fontSize = "11px";
  minScoreLabel.innerText = "Min Score";
  minScoreLabel.title =
    "Minimum similarity score (0-100) for a passage to be included. Higher values are more selective.";

  const minScoreInput = doc.createElement("input");
  Object.assign(minScoreInput.style, {
    width: "50px",
    fontSize: "11px",
    padding: "2px 4px",
    border: "1px solid var(--border-primary)",
    borderRadius: "3px",
    backgroundColor: "var(--background-primary)",
    color: "var(--text-primary)",
    textAlign: "right",
  });
  minScoreInput.type = "number";
  minScoreInput.min = "0";
  minScoreInput.max = "100";
  minScoreInput.step = "5";
  minScoreInput.value = String(currentMinScore);

  minScoreInput.addEventListener("input", () => {
    const val = parseInt(minScoreInput.value, 10);
    if (!isNaN(val) && val >= 0 && val <= 100) {
      if (activeModelCfg) {
        updateModelConfig(activeModelCfg.id, { ragMinScore: val });
        Zotero.debug(
          `[seerai] RAG minScore set to ${val} for model ${activeModelCfg.name}`,
        );
      }
    }
  });

  minScoreRow.appendChild(minScoreLabel);
  minScoreRow.appendChild(minScoreInput);
  ragSection.appendChild(minScoreRow);

  body.appendChild(ragSection);

  // --- 6. Tool Permissions ---
  const permSection = doc.createElement("div");
  permSection.style.marginTop = "8px";
  permSection.style.borderTop = "1px solid var(--border-primary)";
  permSection.style.paddingTop = "8px";

  // Collapsible Header
  const permHeader = doc.createElement("div");
  Object.assign(permHeader.style, {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    cursor: "pointer",
    fontSize: "11px",
    color: "var(--text-secondary, #666)",
    userSelect: "none",
  });

  const permLabel = doc.createElement("div");
  permLabel.innerText = "Tool Permissions";
  const permIcon = doc.createElement("span");
  permIcon.innerText = "▶"; // Collapsed state
  permIcon.style.fontSize = "8px";
  permIcon.style.transition = "transform 0.2s";

  permHeader.appendChild(permLabel);
  permHeader.appendChild(permIcon);
  permSection.appendChild(permHeader);

  // List Container (Hidden by default)
  const permList = doc.createElement("div");
  Object.assign(permList.style, {
    display: "none",
    flexDirection: "column",
    gap: "2px", // Compact
    marginTop: "6px",
    maxHeight: "200px",
    overflowY: "auto",
    fontSize: "11px",
    border: "1px solid var(--border-secondary, #eee)",
    borderRadius: "4px",
    padding: "2px",
  });

  // Toggle behavior
  permHeader.addEventListener("click", (e) => {
    e.stopPropagation();
    const isHidden = permList.style.display === "none";
    permList.style.display = isHidden ? "flex" : "none";
    permIcon.style.transform = isHidden ? "rotate(90deg)" : "rotate(0deg)";
  });

  // Tool List Logic
  const toolDisplayNames: Record<string, string> = {
    [TOOL_NAMES.SEARCH_LIBRARY]: "Search Library",
    [TOOL_NAMES.GET_ITEM_METADATA]: "Get Metadata",
    [TOOL_NAMES.READ_ITEM_CONTENT]: "Read Content",
    [TOOL_NAMES.SEARCH_EXTERNAL]: "Search External",
    [TOOL_NAMES.IMPORT_PAPER]: "Import Paper",
    [TOOL_NAMES.GENERATE_ITEM_TAGS]: "Generate Tags",
    [TOOL_NAMES.CONTEXT]: "Conversation Context",
    [TOOL_NAMES.COLLECTION]: "Zotero Collections",
    [TOOL_NAMES.TABLE]: "Analysis Tables",
    [TOOL_NAMES.NOTE]: "Zotero Notes",
    [TOOL_NAMES.RELATED_PAPERS]: "Related Papers",
    [TOOL_NAMES.WEB]: "Web Tools",
  };

  // --- BULK ACTIONS ---
  const bulkContainer = doc.createElement("div");
  Object.assign(bulkContainer.style, {
    display: "flex",
    justifyContent: "space-between",
    marginBottom: "6px",
    padding: "0 2px",
  });

  const createBulkBtn = (label: string, mode: string, title: string) => {
    const btn = doc.createElement("div");
    Object.assign(btn.style, {
      fontSize: "10px",
      padding: "2px 6px",
      borderRadius: "3px",
      cursor: "pointer",
      backgroundColor: "var(--background-secondary)",
      border: "1px solid var(--border-primary)",
      color: "var(--text-primary)",
    });
    btn.innerText = label;
    btn.title = title;

    btn.onmouseover = () =>
      (btn.style.backgroundColor = "var(--background-tertiary)");
    btn.onmouseout = () =>
      (btn.style.backgroundColor = "var(--background-secondary)");

    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const allTools = Object.values(TOOL_NAMES);
      const perms: Record<string, string> = {};
      allTools.forEach((t) => (perms[t] = mode));
      Zotero.Prefs.set(
        "extensions.seerai.tool_permissions",
        JSON.stringify(perms),
      );
      // Update UI
      renderToolList(perms);
      Zotero.debug(`[seerai] Bulk set all tools to: ${mode}`);
    });

    return btn;
  };

  bulkContainer.appendChild(
    createBulkBtn("✅ All", "allow", "Allow All Tools"),
  );
  bulkContainer.appendChild(
    createBulkBtn("❓ All", "ask", "Ask for All Tools"),
  );
  bulkContainer.appendChild(
    createBulkBtn("⛔ All", "deny", "Disable All Tools"),
  );
  permList.appendChild(bulkContainer);

  const toolsContainer = doc.createElement("div");
  toolsContainer.style.display = "flex";
  toolsContainer.style.flexDirection = "column";
  permList.appendChild(toolsContainer);

  const renderToolList = (currentPerms: Record<string, string>) => {
    toolsContainer.innerHTML = ""; // Clear existing
    const allTools = Object.values(TOOL_NAMES);

    allTools.forEach((toolKey) => {
      const row = doc.createElement("div");
      Object.assign(row.style, {
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        padding: "2px 4px",
        borderRadius: "2px",
      });

      // Hover effect
      row.onmouseover = () => {
        row.style.background = "var(--fill-quinary, rgba(0,0,0,0.02))";
      };
      row.onmouseout = () => {
        row.style.background = "transparent";
      };

      const nameLabel = doc.createElement("span");
      nameLabel.innerText = toolDisplayNames[toolKey] || toolKey;
      nameLabel.title = toolKey; // Tooltip full name
      nameLabel.style.overflow = "hidden";
      nameLabel.style.textOverflow = "ellipsis";
      nameLabel.style.whiteSpace = "nowrap";
      nameLabel.style.flex = "1";

      // Status Button
      const statusBtn = doc.createElement("div");
      const perm = currentPerms[toolKey] || "allow";

      const updateStatusIcon = (p: string) => {
        if (p === "allow") {
          statusBtn.innerText = "✅";
          statusBtn.title = "Allowed";
          statusBtn.style.opacity = "1";
        } else if (p === "ask") {
          statusBtn.innerText = "❓";
          statusBtn.title = "Ask Me";
          statusBtn.style.opacity = "0.8";
        } else {
          statusBtn.innerText = "⛔";
          statusBtn.title = "Disabled";
          statusBtn.style.opacity = "0.6";
        }
      };

      updateStatusIcon(perm);
      statusBtn.style.cursor = "pointer";
      statusBtn.style.fontSize = "12px";
      statusBtn.style.width = "20px";
      statusBtn.style.textAlign = "center";

      // Cycle Click Handler
      statusBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        // Refresh perms to ensure we have latest state if modified elsewhere
        const freshPermsStr = Zotero.Prefs.get(
          "extensions.seerai.tool_permissions",
        ) as string;
        let freshPerms: Record<string, string> = {};
        try {
          freshPerms = JSON.parse(freshPermsStr || "{}");
        } catch (e) {}

        const curr = freshPerms[toolKey] || "allow";
        let next = "allow";
        if (curr === "allow") next = "ask";
        else if (curr === "ask") next = "deny";
        else next = "allow";

        freshPerms[toolKey] = next;
        Zotero.Prefs.set(
          "extensions.seerai.tool_permissions",
          JSON.stringify(freshPerms),
        );

        updateStatusIcon(next);
        Zotero.debug(`[seerai] Tool permission changed: ${toolKey} -> ${next}`);
      });

      row.appendChild(nameLabel);
      row.appendChild(statusBtn);
      toolsContainer.appendChild(row);
    });
  };

  const currentPermsStr = Zotero.Prefs.get(
    "extensions.seerai.tool_permissions",
  ) as string;
  let currentPerms: Record<string, string> = {};
  try {
    currentPerms = JSON.parse(currentPermsStr || "{}");
  } catch (e) {}
  renderToolList(currentPerms);

  permSection.appendChild(permList);
  body.appendChild(permSection);

  body.appendChild(permSection);

  container.appendChild(body);
  const mountPoint = doc.body || doc.documentElement;
  if (mountPoint) {
    mountPoint.appendChild(container);
  }

  // Close on mousedown outside
  const closeHandler = (e: MouseEvent) => {
    // If click is not inside the container AND not on the anchor button
    if (
      !container.contains(e.target as Node) &&
      !anchor.contains(e.target as Node)
    ) {
      Zotero.debug("[seerai] Click outside detected, closing settings");
      container.remove();
      doc.removeEventListener("mousedown", closeHandler);
    }
  };

  // Defer to avoid immediate close
  setTimeout(() => doc.addEventListener("mousedown", closeHandler), 0);
}
