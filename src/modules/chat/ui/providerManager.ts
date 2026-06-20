import { discoverModels } from "../modelDiscovery";
import { getAvailableModels } from "../modelResolver";
import {
  addProviderConfig,
  applyModelRoutingPreset,
  deleteModelRoutingPreset,
  deleteProviderConfig,
  getDefaultModelRef,
  getProviderConfig,
  getProviderConfigs,
  getProviderRegistryState,
  getModelRoutingPresets,
  replaceDiscoveredModels,
  renameModelRoutingPreset,
  saveModelRoutingPreset,
  setDefaultModelRef,
  updateModelRoutingPreset,
  updateProviderConfig,
} from "../providerRegistry";
import { getProviderPresets, getPresetById } from "../providerPresets";
import { detectCliAgent } from "../cli/cliDetection";
import type {
  AuthMethod,
  DiscoveredModel,
  ModelCapability,
  ModelRef,
  ProviderConfig,
  ProviderModel,
} from "../providerTypes";
import { MODEL_TYPE_ENDPOINTS, type ModelType } from "../types";
import type { ChatStateManager } from "../stateManager";
import { createSvgIcon } from "./icons";
import type { IconName } from "./icons";

const CAPABILITIES: ModelType[] = [
  "chat",
  "embedding",
  "image",
  "video",
  "tts",
  "stt",
];
const HTML_NS = "http://www.w3.org/1999/xhtml";
let defaultRoutingPresetId: string | undefined;

function element<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  className?: string,
): HTMLElementTagNameMap[K] {
  const value = doc.createElementNS(HTML_NS, tag) as HTMLElementTagNameMap[K];
  if (className) value.className = className;
  return value;
}

function localId(): string {
  return `model-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function refValue(providerId: string, localModelId: string): string {
  return JSON.stringify({ providerId, localModelId });
}

function capabilityLabel(capability: ModelType): string {
  const labels: Record<ModelType, string> = {
    chat: "Text & Chat",
    embedding: "Embeddings",
    image: "Image",
    video: "Video",
    tts: "Speech",
    stt: "Transcription",
  };
  return labels[capability];
}

function capabilityIcon(capability: ModelType): IconName {
  const icons: Record<ModelType, IconName> = {
    chat: "message",
    embedding: "database",
    image: "image",
    video: "video",
    tts: "tts",
    stt: "sparkles",
  };
  return icons[capability];
}

function compactLabel(value: string, maxLength = 40): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 1).trimEnd()}…`;
}

function discoverySummary(models: DiscoveredModel[]): string {
  const counts = CAPABILITIES.map((capability) => {
    const count = models.filter((model) =>
      model.capabilities?.includes(capability),
    ).length;
    return `${capabilityLabel(capability)} ${count}`;
  });
  return `Connected · ${models.length} models · ${counts.join(" · ")}`;
}

function matchingRoutingPreset(models: Partial<Record<ModelType, ModelRef>>) {
  return getModelRoutingPresets().find((preset) =>
    CAPABILITIES.every((capability) => {
      const current = models[capability];
      const saved = preset.models[capability];
      return (
        current?.providerId === saved?.providerId &&
        current?.localModelId === saved?.localModelId
      );
    }),
  );
}

function normalizedProvider(
  presetId: string,
  name: string,
  apiURL: string,
  apiKey: string,
  authMethod: AuthMethod,
  authHeaderName: string,
  extraHeaders: Record<string, string>,
): Omit<ProviderConfig, "id" | "createdAt" | "updatedAt"> {
  const preset = getPresetById(presetId);
  return {
    presetId: preset?.id,
    name,
    apiURL,
    apiKey,
    authMethod,
    authHeaderName: authHeaderName || preset?.authHeaderName,
    authPrefix: preset?.authPrefix,
    extraHeaders: { ...preset?.extraHeaders, ...extraHeaders },
    modelsURL: preset?.modelsURL,
    models: [],
    configuredModels: [],
    modelPolicy: "automatic",
    isActive: true,
    enabled: true,
    adapterId: preset?.adapterId || "openai-compatible",
  };
}

function createRoutingPresetBar(
  doc: Document,
  currentModels: () => Partial<Record<ModelType, ModelRef>>,
  onApply: (models: Partial<Record<ModelType, ModelRef>>) => void,
  selection?: {
    get: () => string | undefined;
    set: (id: string | undefined) => void;
  },
): HTMLElement {
  const bar = element(doc, "div", "seerai-routing-presets");
  const select = element(doc, "select");
  const placeholder = element(doc, "option");
  placeholder.value = "";
  placeholder.textContent = "Routing preset";
  select.appendChild(placeholder);
  for (const preset of getModelRoutingPresets()) {
    const option = element(doc, "option");
    option.value = preset.id;
    option.textContent = preset.name;
    select.appendChild(option);
  }
  const selectedId = selection?.get();
  select.value = getModelRoutingPresets().some(
    (preset) => preset.id === selectedId,
  )
    ? selectedId || ""
    : matchingRoutingPreset(currentModels())?.id || "";
  if (!selectedId && select.value) selection?.set(select.value);
  const apply = element(doc, "button", "seerai-secondary-button");
  apply.type = "button";
  apply.textContent = "Save";
  apply.disabled = !select.value;
  const save = element(doc, "button", "seerai-secondary-button");
  save.type = "button";
  save.textContent = "Save new preset";
  const rename = element(doc, "button", "seerai-icon-button");
  rename.type = "button";
  rename.title = "Rename preset";
  rename.appendChild(createSvgIcon(doc, "edit", { size: 12 }));
  const remove = element(doc, "button", "seerai-icon-button");
  remove.type = "button";
  remove.title = "Delete preset";
  remove.appendChild(createSvgIcon(doc, "trash", { size: 12 }));
  const applySelected = () => {
    const preset = getModelRoutingPresets().find(
      (item) => item.id === select.value,
    );
    if (!preset) return;
    selection?.set(preset.id);
    applyModelRoutingPreset(preset.id);
    onApply(preset.models);
  };
  select.addEventListener("change", () => {
    apply.disabled = !select.value;
    applySelected();
  });
  apply.addEventListener("click", () => {
    if (!select.value) return;
    const preset = updateModelRoutingPreset(select.value, currentModels());
    if (preset) onApply(preset.models);
  });
  save.addEventListener("click", () => {
    const name = element(doc, "input", "seerai-routing-preset-name");
    name.placeholder = "Preset name";
    const confirm = element(doc, "button", "seerai-primary-button");
    confirm.type = "button";
    confirm.textContent = "Save";
    const cancel = element(doc, "button", "seerai-secondary-button");
    cancel.type = "button";
    cancel.textContent = "Cancel";
    const restore = () =>
      bar.replaceChildren(select, apply, save, rename, remove);
    confirm.addEventListener("click", () => {
      const value = name.value.trim();
      if (!value) {
        name.focus();
        return;
      }
      const preset = saveModelRoutingPreset(value, currentModels());
      const existingOption = Array.from(select.options).find(
        (option) => (option as HTMLOptionElement).value === preset.id,
      ) as HTMLOptionElement | undefined;
      if (existingOption) {
        existingOption.textContent = preset.name;
      } else {
        const option = element(doc, "option");
        option.value = preset.id;
        option.textContent = preset.name;
        select.appendChild(option);
      }
      select.value = preset.id;
      selection?.set(preset.id);
      apply.disabled = false;
      restore();
      onApply(preset.models);
    });
    cancel.addEventListener("click", restore);
    name.addEventListener("keydown", (event) => {
      const keyEvent = event as KeyboardEvent;
      if (keyEvent.key === "Enter") confirm.click();
      if (keyEvent.key === "Escape") restore();
    });
    bar.replaceChildren(name, confirm, cancel);
    name.focus();
  });
  rename.addEventListener("click", () => {
    const preset = getModelRoutingPresets().find(
      (item) => item.id === select.value,
    );
    if (!preset) return;
    const name = element(doc, "input", "seerai-routing-preset-name");
    name.value = preset.name;
    name.placeholder = "Preset name";
    const confirm = element(doc, "button", "seerai-primary-button");
    confirm.type = "button";
    confirm.textContent = "Rename";
    const cancel = element(doc, "button", "seerai-secondary-button");
    cancel.type = "button";
    cancel.textContent = "Cancel";
    const restore = () =>
      bar.replaceChildren(select, apply, save, rename, remove);
    const commit = () => {
      const updated = renameModelRoutingPreset(preset.id, name.value);
      if (!updated) {
        name.setCustomValidity("Enter a unique preset name.");
        name.reportValidity();
        return;
      }
      const option = Array.from(select.options).find(
        (item) => (item as HTMLOptionElement).value === updated.id,
      ) as HTMLOptionElement | undefined;
      if (option) option.textContent = updated.name;
      restore();
    };
    confirm.addEventListener("click", commit);
    cancel.addEventListener("click", restore);
    name.addEventListener("input", () => name.setCustomValidity(""));
    name.addEventListener("keydown", (event) => {
      const keyEvent = event as KeyboardEvent;
      if (keyEvent.key === "Enter") commit();
      if (keyEvent.key === "Escape") restore();
    });
    bar.replaceChildren(name, confirm, cancel);
    name.focus();
    name.select();
  });
  remove.addEventListener("click", () => {
    if (!select.value || !deleteModelRoutingPreset(select.value)) return;
    select.querySelector(`option[value="${select.value}"]`)?.remove();
    select.value = "";
    selection?.set(undefined);
    apply.disabled = true;
  });
  bar.append(select, apply, save, rename, remove);
  return bar;
}

export interface ProviderManagerOptions {
  providerId?: string;
  onChange?: () => void;
  inlineHost?: HTMLElement;
  onCancel?: () => void;
}

export function showProviderManagerDialog(
  doc: Document,
  options: ProviderManagerOptions = {},
): void {
  doc.getElementById("seerai-provider-dialog")?.remove();
  const existing = options.providerId
    ? getProviderConfig(options.providerId)
    : undefined;
  const overlay = element(
    doc,
    "div",
    options.inlineHost
      ? "seerai-provider-inline-editor"
      : "seerai-provider-overlay",
  );
  overlay.id = "seerai-provider-dialog";
  const dialog = element(doc, "div", "seerai-provider-dialog");
  if (options.inlineHost) dialog.classList.add("is-inline");
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", options.inlineHost ? "false" : "true");
  dialog.setAttribute("aria-labelledby", "seerai-provider-dialog-title");

  const header = element(doc, "div", "seerai-provider-dialog-header");
  const heading = element(doc, "div");
  const title = element(doc, "h2");
  title.id = "seerai-provider-dialog-title";
  title.textContent = existing ? "Edit provider" : "Connect a provider";
  const subtitle = element(doc, "p");
  subtitle.textContent =
    "Configure the connection once, then assign any number of models to its capabilities.";
  heading.append(title, subtitle);
  const close = element(doc, "button", "seerai-icon-button");
  close.type = "button";
  close.title = "Close";
  close.appendChild(createSvgIcon(doc, "close", { size: 16 }));
  header.append(heading, close);
  dialog.appendChild(header);

  const body = element(doc, "div", "seerai-provider-dialog-body");
  const connection = element(doc, "section", "seerai-provider-section");
  const connectionTitle = element(doc, "h3");
  connectionTitle.textContent = "Connection";
  connection.appendChild(connectionTitle);

  const presetField = element(doc, "label", "seerai-field");
  const presetLabel = element(doc, "span");
  presetLabel.textContent = "Provider";
  const presetSelect = element(doc, "select");
  for (const preset of getProviderPresets().filter((item) => !item.isAgent)) {
    const option = element(doc, "option");
    option.value = preset.id;
    option.textContent = preset.name;
    presetSelect.appendChild(option);
  }
  const customOption = element(doc, "option");
  customOption.value = "custom";
  customOption.textContent = "Custom OpenAI-compatible";
  presetSelect.appendChild(customOption);
  presetSelect.value = existing?.presetId || "openai";
  presetSelect.disabled = !!existing;
  presetField.append(presetLabel, presetSelect);

  const nameField = element(doc, "label", "seerai-field");
  const nameLabel = element(doc, "span");
  nameLabel.textContent = "Display name";
  const nameInput = element(doc, "input");
  nameInput.value = existing?.name || "Custom provider";
  nameField.append(nameLabel, nameInput);

  const keyField = element(doc, "label", "seerai-field");
  const keyLabel = element(doc, "span");
  keyLabel.textContent = "API key";
  const keyWrap = element(doc, "div", "seerai-secret-input");
  const keyInput = element(doc, "input");
  keyInput.type = "password";
  keyInput.value = existing?.apiKey || "";
  const reveal = element(doc, "button", "seerai-secondary-button");
  reveal.type = "button";
  reveal.textContent = "Show";
  keyWrap.append(keyInput, reveal);
  keyField.append(keyLabel, keyWrap);

  // Shown only for local-cli providers (e.g. Codex): there is no API key —
  // auth is inherited from the installed CLI's own login session.
  const cliHint = element(doc, "p", "seerai-cli-hint");
  cliHint.hidden = true;

  const advanced = element(doc, "details", "seerai-provider-advanced");
  const advancedSummary = element(doc, "summary");
  advancedSummary.textContent = "Advanced connection settings";
  const urlField = element(doc, "label", "seerai-field");
  const urlLabel = element(doc, "span");
  urlLabel.textContent = "Base URL";
  const urlInput = element(doc, "input");
  urlInput.value = existing?.apiURL || "";
  urlField.append(urlLabel, urlInput);
  const authField = element(doc, "label", "seerai-field");
  const authLabel = element(doc, "span");
  authLabel.textContent = "Authentication";
  const authSelect = element(doc, "select");
  for (const auth of [
    "bearer",
    "x-api-key",
    "api-key-header",
    "none",
  ] as const) {
    const option = element(doc, "option");
    option.value = auth;
    option.textContent = auth;
    authSelect.appendChild(option);
  }
  authSelect.value = existing?.authMethod || "bearer";
  authField.append(authLabel, authSelect);
  const headerField = element(doc, "label", "seerai-field");
  const headerLabel = element(doc, "span");
  headerLabel.textContent = "Authentication header";
  const headerInput = element(doc, "input");
  headerInput.value = existing?.authHeaderName || "";
  headerInput.placeholder = "Uses the provider default";
  headerField.append(headerLabel, headerInput);
  const extraField = element(doc, "label", "seerai-field");
  const extraLabel = element(doc, "span");
  extraLabel.textContent = "Additional headers (JSON)";
  const extraInput = element(doc, "textarea");
  extraInput.value = existing?.extraHeaders
    ? JSON.stringify(existing.extraHeaders, null, 2)
    : "";
  extraField.append(extraLabel, extraInput);
  advanced.append(
    advancedSummary,
    urlField,
    authField,
    headerField,
    extraField,
  );

  const connectionActions = element(doc, "div", "seerai-inline-actions");
  const testButton = element(doc, "button", "seerai-secondary-button");
  testButton.type = "button";
  testButton.textContent = "Test connection";
  const connectionStatus = element(doc, "span", "seerai-connection-status");
  connectionActions.append(testButton, connectionStatus);
  connection.append(
    presetField,
    nameField,
    keyField,
    cliHint,
    advanced,
    connectionActions,
  );

  const modelsSection = element(doc, "section", "seerai-provider-section");
  const modelsTitle = element(doc, "h3");
  modelsTitle.textContent = "Model access";
  const modelsHelp = element(doc, "p", "seerai-model-access-help");
  modelsHelp.textContent =
    "Models are discovered automatically when you save. Add entries only for custom capability or endpoint overrides.";
  modelsSection.append(modelsTitle, modelsHelp);

  let discovered: DiscoveredModel[] = [...(existing?.models || [])];
  let configured: ProviderModel[] = [...(existing?.configuredModels || [])];
  let modelPolicy = existing?.modelPolicy || "automatic";
  const lanes = element(doc, "div", "seerai-capability-lanes");

  const renderLanes = () => {
    lanes.replaceChildren();
    for (const capability of CAPABILITIES) {
      const lane = element(doc, "details", "seerai-capability-lane");
      const configuredForCapability = configured.filter((item) =>
        item.capabilities.includes(capability),
      );
      lane.open = capability === "chat" || configuredForCapability.length > 0;
      const laneHeader = element(doc, "summary", "seerai-capability-header");
      const laneTitle = element(doc, "strong");
      laneTitle.textContent = capabilityLabel(capability);
      const laneCount = element(doc, "span");
      laneCount.textContent =
        configuredForCapability.length === 0
          ? "Add model"
          : `${configuredForCapability.length} configured`;
      laneHeader.append(laneTitle, laneCount);
      const chips = element(doc, "div", "seerai-model-chips");
      for (const model of configuredForCapability) {
        const chip = element(doc, "span", "seerai-model-chip");
        const label = element(doc, "span");
        label.textContent = model.displayName;
        const remove = element(doc, "button");
        remove.type = "button";
        remove.title = `Remove from ${capabilityLabel(capability)}`;
        remove.appendChild(createSvgIcon(doc, "close", { size: 11 }));
        remove.addEventListener("click", () => {
          model.capabilities = model.capabilities.filter(
            (item) => item !== capability,
          );
          configured = configured.filter(
            (item) => item.capabilities.length > 0,
          );
          renderLanes();
        });
        chip.append(label, remove);
        chips.appendChild(chip);
      }
      const addRow = element(doc, "div", "seerai-add-model-row");
      const modelInput = element(doc, "input");
      modelInput.placeholder = "Model ID";
      modelInput.setAttribute("list", `seerai-model-list-${capability}`);
      const suggestions = element(doc, "datalist");
      suggestions.id = `seerai-model-list-${capability}`;
      for (const model of discovered.filter(
        (item) => !item.capabilities || item.capabilities.includes(capability),
      )) {
        const option = element(doc, "option");
        option.value = model.id;
        suggestions.appendChild(option);
      }
      const endpointInput = element(doc, "input");
      endpointInput.type = "url";
      endpointInput.placeholder = "Custom endpoint URL (optional)";
      const add = element(doc, "button", "seerai-secondary-button");
      add.type = "button";
      add.appendChild(createSvgIcon(doc, "add", { size: 13 }));
      add.append(" Add");
      add.addEventListener("click", () => {
        const modelId = modelInput.value.trim();
        if (!modelId) return;
        const endpoint = endpointInput.value.trim();
        if (endpoint) {
          try {
            new URL(endpoint);
            endpointInput.setCustomValidity("");
          } catch {
            endpointInput.setCustomValidity("Enter a valid absolute URL.");
            endpointInput.reportValidity();
            return;
          }
        }
        const existingModel = configured.find(
          (item) => item.modelId === modelId,
        );
        if (existingModel) {
          if (!existingModel.capabilities.includes(capability)) {
            existingModel.capabilities.push(capability);
          }
          if (endpoint) {
            existingModel.endpointOverrides = {
              ...existingModel.endpointOverrides,
              [capability]: endpoint,
            };
          }
        } else {
          const now = new Date().toISOString();
          configured.push({
            id: localId(),
            modelId,
            displayName:
              discovered.find((item) => item.id === modelId)?.displayName ||
              modelId,
            capabilities: [capability],
            ...(endpoint && {
              endpointOverrides: { [capability]: endpoint },
            }),
            createdAt: now,
            updatedAt: now,
          });
        }
        modelPolicy = "scoped";
        modelInput.value = "";
        endpointInput.value = "";
        renderLanes();
      });
      addRow.append(modelInput, suggestions, endpointInput, add);
      lane.append(laneHeader, chips, addRow);
      lanes.appendChild(lane);
    }
  };
  renderLanes();
  modelsSection.appendChild(lanes);
  body.append(connection, modelsSection);

  const error = element(doc, "div", "seerai-provider-error");
  error.hidden = true;
  const footer = element(doc, "div", "seerai-provider-dialog-footer");
  const cancel = element(doc, "button", "seerai-secondary-button");
  cancel.type = "button";
  cancel.textContent = "Cancel";
  const save = element(doc, "button", "seerai-primary-button");
  save.type = "button";
  save.textContent = existing ? "Save changes" : "Connect provider";
  footer.append(cancel, save);
  const compactChatEditor = !!options.inlineHost?.closest(
    ".seerai-chat-model-popover",
  );
  let externalFooter = false;
  if (compactChatEditor) {
    footer.classList.add("is-compact-top");
    const toolbar = options.inlineHost
      ?.closest(".seerai-chat-model-popover")
      ?.querySelector(".seerai-provider-picker-toolbar");
    if (toolbar) {
      toolbar.appendChild(footer);
      externalFooter = true;
    } else {
      dialog.prepend(footer);
    }
    dialog.append(body, error);
  } else {
    dialog.append(body, error, footer);
  }
  overlay.appendChild(dialog);
  if (options.inlineHost) {
    options.inlineHost.replaceChildren(overlay);
  } else {
    (doc.body || doc.documentElement)?.appendChild(overlay);
  }

  const isLocalCliPreset = (presetId: string) =>
    getPresetById(presetId)?.adapterId === "local-cli";

  const applyCliMode = () => {
    const cli = isLocalCliPreset(presetSelect.value);
    keyField.hidden = cli;
    advanced.hidden = cli;
    cliHint.hidden = !cli;
    if (cli) {
      const preset = getPresetById(presetSelect.value);
      cliHint.textContent =
        preset?.notes ||
        "Uses your locally installed CLI and its login. No API key is stored by seerai.";
      testButton.textContent = "Detect";
    } else {
      testButton.textContent = "Test connection";
    }
  };

  const applyPreset = () => {
    const preset = getPresetById(presetSelect.value);
    if (!preset) return;
    nameInput.value = preset.name;
    urlInput.value = preset.apiURL;
    authSelect.value = preset.authMethod;
    headerInput.value = preset.authHeaderName || "";
    keyInput.placeholder = preset.apiKeyPlaceholder || "API key";
    extraInput.value = preset.extraHeaders
      ? JSON.stringify(preset.extraHeaders, null, 2)
      : "";
    applyCliMode();
  };
  if (!existing) applyPreset();
  else applyCliMode();
  presetSelect.addEventListener("change", applyPreset);
  reveal.addEventListener("click", () => {
    keyInput.type = keyInput.type === "password" ? "text" : "password";
    reveal.textContent = keyInput.type === "password" ? "Show" : "Hide";
  });

  const draftConnection = () => {
    let extraHeaders: Record<string, string> = {};
    if (extraInput.value.trim()) {
      extraHeaders = JSON.parse(extraInput.value) as Record<string, string>;
    }
    return normalizedProvider(
      presetSelect.value,
      nameInput.value.trim(),
      urlInput.value.trim(),
      keyInput.value.trim(),
      authSelect.value as AuthMethod,
      headerInput.value.trim(),
      extraHeaders,
    );
  };

  testButton.addEventListener("click", async () => {
    error.hidden = true;
    testButton.disabled = true;
    if (isLocalCliPreset(presetSelect.value)) {
      connectionStatus.textContent = "Detecting…";
      try {
        const draft = draftConnection();
        // Populate the model lanes from the preset catalog (no network).
        discovered = await discoverModels(draft);
        const detection = await detectCliAgent(
          getPresetById(presetSelect.value)?.cliAgentId,
        );
        connectionStatus.textContent = detection.message;
        if (detection.level !== "ok") {
          error.textContent = detection.message;
          error.hidden = false;
        }
        renderLanes();
      } catch (reason) {
        connectionStatus.textContent = "Detection failed";
        error.textContent =
          reason instanceof Error ? reason.message : String(reason);
        error.hidden = false;
      } finally {
        testButton.disabled = false;
      }
      return;
    }
    connectionStatus.textContent = "Testing…";
    try {
      const draft = draftConnection();
      discovered = await discoverModels(draft);
      connectionStatus.textContent =
        discovered.length > 0
          ? discoverySummary(discovered)
          : "Connected · no models returned; add model IDs manually";
      renderLanes();
    } catch (reason) {
      connectionStatus.textContent = "Connection failed";
      error.textContent =
        reason instanceof Error ? reason.message : String(reason);
      error.hidden = false;
    } finally {
      testButton.disabled = false;
    }
  });

  const dismiss = () => {
    overlay.remove();
    if (externalFooter) footer.remove();
    options.onCancel?.();
  };
  close.addEventListener("click", dismiss);
  cancel.addEventListener("click", dismiss);
  if (!options.inlineHost) {
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) dismiss();
    });
  }
  const onKey = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      dismiss();
      doc.defaultView?.removeEventListener("keydown", onKey);
    }
  };
  doc.defaultView?.addEventListener("keydown", onKey);

  save.addEventListener("click", async () => {
    error.hidden = true;
    save.disabled = true;
    try {
      const draft = draftConnection();
      if (!draft.name) throw new Error("Display name is required.");
      new URL(draft.apiURL);
      const preset = getPresetById(presetSelect.value);
      if (preset?.requiresApiKey && !draft.apiKey) {
        throw new Error("This provider requires an API key.");
      }
      try {
        discovered = await discoverModels(draft);
      } catch (reason) {
        if (configured.length === 0) throw reason;
      }
      const value = {
        ...draft,
        adapterId: existing?.adapterId || draft.adapterId,
        modelsURL: existing?.modelsURL || draft.modelsURL,
        enabled: existing?.enabled ?? draft.enabled,
        isActive: existing?.isActive ?? draft.isActive,
        models: discovered,
        configuredModels: modelPolicy === "scoped" ? configured : [],
        modelPolicy,
      };
      let provider: ProviderConfig;
      if (existing) {
        provider = updateProviderConfig(existing.id, value)!;
      } else {
        provider = addProviderConfig(value);
      }
      if (discovered.length > 0) {
        replaceDiscoveredModels(provider.id, discovered);
      }
      const chatModels = getAvailableModels("chat").filter(
        (item) => item.provider.id === provider.id,
      );
      if (!getDefaultModelRef("chat") && chatModels[0]) {
        setDefaultModelRef("chat", chatModels[0].ref);
      }
      overlay.remove();
      if (externalFooter) footer.remove();
      options.onChange?.();
    } catch (reason) {
      error.textContent =
        reason instanceof Error ? reason.message : String(reason);
      error.hidden = false;
    } finally {
      save.disabled = false;
    }
  });
  nameInput.focus();
}

export function renderProviderSettings(
  doc: Document,
  container: HTMLElement,
): void {
  container.replaceChildren();
  const header = element(doc, "div", "seerai-settings-section-header");
  const heading = element(doc, "div");
  const title = element(doc, "h3");
  title.textContent = "AI providers";
  const subtitle = element(doc, "p");
  subtitle.textContent =
    "Connect each service once, then assign its models to one or more capabilities.";
  heading.append(title, subtitle);
  const add = element(doc, "button", "seerai-primary-button");
  add.type = "button";
  add.appendChild(createSvgIcon(doc, "add", { size: 14 }));
  add.append(" Add provider");
  header.append(heading, add);
  container.appendChild(header);

  const list = element(doc, "div", "seerai-provider-grid");
  const providers = getProviderConfigs();
  if (providers.length === 0) {
    const empty = element(doc, "div", "seerai-settings-empty");
    empty.textContent =
      "No AI providers are connected. Add one to configure models and defaults.";
    list.appendChild(empty);
  }
  for (const provider of providers) {
    const card = element(doc, "article", "seerai-provider-card");
    const cardHeader = element(doc, "div", "seerai-provider-card-header");
    const identity = element(doc, "div", "seerai-provider-identity");
    const preset = provider.presetId
      ? getPresetById(provider.presetId)
      : undefined;
    const providerIcon = element(doc, "span", "seerai-provider-icon");
    providerIcon.appendChild(
      createSvgIcon(doc, preset?.icon || "server", { size: 18 }),
    );
    identity.appendChild(providerIcon);
    const identityText = element(doc, "div");
    const name = element(doc, "strong");
    name.textContent = provider.name;
    const endpoint = element(doc, "span");
    try {
      endpoint.textContent = new URL(provider.apiURL).hostname;
    } catch {
      endpoint.textContent = provider.apiURL;
    }
    identityText.append(name, endpoint);
    identity.appendChild(identityText);
    const status = element(doc, "span", "seerai-status-pill");
    const statusDot = element(doc, "span", "seerai-status-dot");
    status.appendChild(statusDot);
    status.append(provider.enabled === false ? "Disabled" : "Connected");
    if (provider.enabled === false) status.classList.add("is-disabled");
    cardHeader.append(identity, status);
    const meta = element(doc, "div", "seerai-provider-meta");
    const available = CAPABILITIES.filter((capability) =>
      getAvailableModels(capability).some(
        (item) => item.provider.id === provider.id,
      ),
    );
    const modelCount = element(doc, "span", "seerai-provider-model-count");
    const count =
      provider.modelPolicy === "scoped"
        ? provider.configuredModels?.length || 0
        : provider.models.length;
    modelCount.textContent = `${count} ${count === 1 ? "model" : "models"}`;
    meta.appendChild(modelCount);
    const capabilityList = element(doc, "div", "seerai-provider-capabilities");
    for (const capability of available) {
      const badge = element(doc, "span", "seerai-capability-badge");
      badge.title = capabilityLabel(capability);
      badge.appendChild(
        createSvgIcon(doc, capabilityIcon(capability), { size: 13 }),
      );
      badge.append(capabilityLabel(capability));
      capabilityList.appendChild(badge);
    }
    if (available.length === 0) {
      const empty = element(doc, "span", "seerai-capability-empty");
      empty.textContent = "No model capabilities configured";
      capabilityList.appendChild(empty);
    }
    meta.appendChild(capabilityList);
    const actions = element(doc, "div", "seerai-inline-actions");
    const edit = element(doc, "button", "seerai-secondary-button");
    edit.type = "button";
    edit.textContent = "Edit";
    const toggle = element(doc, "button", "seerai-secondary-button");
    toggle.type = "button";
    toggle.textContent = provider.enabled === false ? "Enable" : "Disable";
    const remove = element(doc, "button", "seerai-danger-button");
    remove.type = "button";
    remove.textContent = "Delete";
    actions.append(edit, toggle, remove);
    const cardMain = element(doc, "div", "seerai-provider-card-main");
    cardMain.append(cardHeader, meta);
    card.append(cardMain, actions);
    list.appendChild(card);
    edit.addEventListener("click", () =>
      showProviderManagerDialog(doc, {
        providerId: provider.id,
        inlineHost: container,
        onChange: () => renderProviderSettings(doc, container),
        onCancel: () => renderProviderSettings(doc, container),
      }),
    );
    toggle.addEventListener("click", () => {
      if (
        provider.enabled !== false &&
        getDefaultModelRef("chat")?.providerId === provider.id
      ) {
        doc.defaultView?.alert(
          "Choose a Chat default from another provider before disabling this provider.",
        );
        return;
      }
      updateProviderConfig(provider.id, {
        enabled: provider.enabled === false,
      });
      renderProviderSettings(doc, container);
    });
    remove.addEventListener("click", () => {
      if (getDefaultModelRef("chat")?.providerId === provider.id) {
        doc.defaultView?.alert(
          "Choose a Chat default from another provider before deleting this provider.",
        );
        return;
      }
      if (
        doc.defaultView?.confirm(
          `Delete ${provider.name}? Conversations pinned to this provider will return to the app default.`,
        )
      ) {
        deleteProviderConfig(provider.id);
        renderProviderSettings(doc, container);
      }
    });
  }
  container.appendChild(list);
  add.addEventListener("click", () =>
    showProviderManagerDialog(doc, {
      inlineHost: container,
      onChange: () => renderProviderSettings(doc, container),
      onCancel: () => renderProviderSettings(doc, container),
    }),
  );
}

export function renderModelDefaults(
  doc: Document,
  container: HTMLElement,
): void {
  container.replaceChildren();
  const enabledProviders = getProviderConfigs().filter(
    (provider) => provider.enabled !== false,
  );
  if (enabledProviders.length === 0) {
    container.hidden = true;
    return;
  }
  container.hidden = false;
  const header = element(doc, "div", "seerai-settings-section-header");
  const heading = element(doc, "div");
  const title = element(doc, "h3");
  title.textContent = "Default models";
  const subtitle = element(doc, "p");
  subtitle.textContent =
    "Choose explicit defaults, or leave a capability unset to use the first compatible discovered model.";
  heading.append(title, subtitle);
  header.appendChild(heading);
  container.appendChild(header);

  container.appendChild(
    createRoutingPresetBar(
      doc,
      () => ({ ...getProviderRegistryState().defaults }),
      () => renderModelDefaults(doc, container),
      {
        get: () => defaultRoutingPresetId,
        set: (id) => {
          defaultRoutingPresetId = id;
        },
      },
    ),
  );

  const rows = element(doc, "div", "seerai-default-rows");
  for (const capability of CAPABILITIES) {
    const row = element(doc, "div", "seerai-default-row");
    const info = element(doc, "div");
    const icon = element(doc, "span", "seerai-default-icon");
    icon.appendChild(
      createSvgIcon(doc, capabilityIcon(capability), { size: 16 }),
    );
    const copy = element(doc, "div", "seerai-default-copy");
    const label = element(doc, "strong");
    label.textContent = capabilityLabel(capability);
    const description = element(doc, "span");
    description.textContent = MODEL_TYPE_ENDPOINTS[capability].description;
    copy.append(label, description);
    info.append(icon, copy);
    const control = element(doc, "div", "seerai-default-control");
    const search = element(doc, "input", "seerai-default-search");
    search.type = "search";
    search.placeholder = "Automatic · search models";
    const availableModels = getAvailableModels(capability);
    const current = getDefaultModelRef(capability);
    const currentItem = availableModels.find(
      (item) =>
        item.ref.providerId === current?.providerId &&
        item.ref.localModelId === current.localModelId,
    );
    let committedLabel = currentItem
      ? `${currentItem.provider.name} — ${currentItem.model.displayName}`
      : "";
    search.value = committedLabel;
    const showChoices = () => {
      doc.getElementById("seerai-settings-model-picker")?.remove();
      const picker = element(doc, "div", "seerai-settings-model-picker");
      picker.id = "seerai-settings-model-picker";
      const renderChoices = () => {
        picker.replaceChildren();
        const query = search.value.trim().toLowerCase();
        const automatic = element(doc, "div", "seerai-settings-model-choice");
        automatic.textContent = "Automatic · first compatible model";
        automatic.tabIndex = 0;
        automatic.addEventListener("mousedown", (event) =>
          event.preventDefault(),
        );
        automatic.addEventListener("click", () => {
          committedLabel = "";
          search.value = "";
          setDefaultModelRef(capability, undefined);
          picker.remove();
        });
        picker.appendChild(automatic);
        for (const item of availableModels
          .filter((model) => {
            const value =
              `${model.provider.name} ${model.model.displayName} ${model.model.modelId}`.toLowerCase();
            return !query || value.includes(query);
          })
          .slice(0, 40)) {
          const choice = element(doc, "div", "seerai-settings-model-choice");
          const value = `${item.provider.name} — ${item.model.displayName}`;
          choice.textContent = value;
          choice.title = value;
          choice.tabIndex = 0;
          choice.addEventListener("mousedown", (event) =>
            event.preventDefault(),
          );
          choice.addEventListener("click", () => {
            committedLabel = value;
            search.value = value;
            setDefaultModelRef(capability, item.ref);
            picker.remove();
          });
          picker.appendChild(choice);
        }
      };
      (doc.body || doc.documentElement)?.appendChild(picker);
      const rect = search.getBoundingClientRect();
      const viewportWidth = doc.defaultView?.innerWidth || 0;
      const viewportHeight = doc.defaultView?.innerHeight || 0;
      const width = Math.min(360, Math.max(240, rect.width));
      picker.style.width = `${width}px`;
      picker.style.left = `${Math.max(8, Math.min(rect.left, viewportWidth - width - 8))}px`;
      const below = viewportHeight - rect.bottom - 8;
      if (below >= 180) {
        picker.style.top = `${rect.bottom + 4}px`;
      } else {
        picker.style.bottom = `${viewportHeight - rect.top + 4}px`;
      }
      renderChoices();
    };
    search.addEventListener("focus", showChoices);
    search.addEventListener("input", showChoices);
    search.addEventListener("blur", () => {
      search.value = committedLabel;
      setTimeout(
        () => doc.getElementById("seerai-settings-model-picker")?.remove(),
        0,
      );
    });
    control.appendChild(search);
    row.append(info, control);
    rows.appendChild(row);
  }
  container.appendChild(rows);
}

export function createChatModelPicker(
  doc: Document,
  stateManager: ChatStateManager,
  onChange: () => void,
): HTMLButtonElement {
  const button = element(doc, "button", "seerai-chat-model-button");
  button.type = "button";
  const label = element(doc, "span");
  const arrow = createSvgIcon(doc, "chevron-down", { size: 12 });
  const refreshLabel = () => {
    const options = stateManager.getOptions();
    const activeRoutes = {
      ...getProviderRegistryState().defaults,
      ...(options.modelRef && { chat: options.modelRef }),
    };
    const activePreset = matchingRoutingPreset(activeRoutes);
    const selectedPreset = getModelRoutingPresets().find(
      (preset) => preset.id === options.routingPresetId,
    );
    if (selectedPreset && selectedPreset.id !== activePreset?.id) {
      label.textContent = `${selectedPreset.name} · Edited`;
      button.title = `Editing routing preset: ${selectedPreset.name}`;
      return;
    }
    if (activePreset) {
      label.textContent = activePreset.name;
      button.title = `Active routing preset: ${activePreset.name}`;
      return;
    }
    const resolved = getAvailableModels("chat").find(
      (item) =>
        item.ref.providerId === options.modelRef?.providerId &&
        item.ref.localModelId === options.modelRef?.localModelId,
    );
    if (resolved) {
      label.textContent = `${resolved.provider.name} · ${resolved.model.displayName}`;
      button.title = "This conversation uses a model override";
    } else {
      const defaultRef = getDefaultModelRef("chat");
      const inherited = getAvailableModels("chat").find(
        (item) =>
          item.ref.providerId === defaultRef?.providerId &&
          item.ref.localModelId === defaultRef?.localModelId,
      );
      label.textContent = inherited
        ? `${inherited.model.displayName} · Default`
        : "Select model";
      button.title = "This conversation follows the app default";
    }
  };
  refreshLabel();
  button.append(label, arrow);

  button.addEventListener("click", (event) => {
    event.stopPropagation();
    doc.getElementById("seerai-chat-model-popover")?.remove();
    const rect = button.getBoundingClientRect();
    const popup = element(doc, "div", "seerai-chat-model-popover");
    popup.id = "seerai-chat-model-popover";
    popup.addEventListener("mousedown", (popupEvent) => {
      popupEvent.stopPropagation();
    });
    popup.addEventListener("click", (popupEvent) => {
      popupEvent.stopPropagation();
    });
    popup.style.left = `${Math.max(8, rect.left)}px`;
    popup.style.bottom = `${Math.max(8, (doc.defaultView?.innerHeight || 0) - rect.top + 6)}px`;
    const positionPopup = () => {
      const viewportWidth = doc.defaultView?.innerWidth || 0;
      const viewportHeight = doc.defaultView?.innerHeight || 0;
      const left = Math.min(
        Math.max(8, rect.left),
        Math.max(8, viewportWidth - popup.offsetWidth - 8),
      );
      const above = rect.top - popup.offsetHeight - 6;
      const top =
        above >= 8
          ? above
          : Math.min(
              rect.bottom + 6,
              Math.max(8, viewportHeight - popup.offsetHeight - 8),
            );
      popup.style.left = `${left}px`;
      popup.style.top = `${top}px`;
      popup.style.bottom = "auto";
    };
    const routes = element(doc, "div", "seerai-capability-routes");
    let openCapability: ModelType | undefined;
    const renderRoutes = () => {
      routes.replaceChildren();
      for (const capability of CAPABILITIES) {
        const available = getAvailableModels(capability);
        const explicitRef =
          capability === "chat"
            ? stateManager.getOptions().modelRef
            : getDefaultModelRef(capability);
        const effectiveRef = explicitRef || getDefaultModelRef(capability);
        const active = available.find(
          (item) =>
            item.ref.providerId === effectiveRef?.providerId &&
            item.ref.localModelId === effectiveRef.localModelId,
        );
        const route = element(doc, "section", "seerai-capability-route");
        const header = element(doc, "div", "seerai-capability-route-header");
        const routeLabel = element(doc, "strong");
        routeLabel.textContent = capabilityLabel(capability);
        const current = element(doc, "button", "seerai-route-current");
        current.type = "button";
        current.textContent = active
          ? compactLabel(
              `${active.provider.name} — ${active.model.displayName}`,
              34,
            )
          : "Automatic";
        current.title = active
          ? `${active.provider.name} — ${active.model.displayName}`
          : "Use the first compatible discovered model";
        current.appendChild(createSvgIcon(doc, "chevron-down", { size: 11 }));
        current.addEventListener("click", () => {
          openCapability =
            openCapability === capability ? undefined : capability;
          renderRoutes();
        });
        header.append(routeLabel, current);
        route.appendChild(header);
        if (openCapability === capability) {
          const chooser = element(doc, "div", "seerai-route-chooser");
          const search = element(doc, "input", "seerai-route-search");
          search.type = "search";
          search.placeholder = `Search ${available.length} models`;
          const choices = element(doc, "div", "seerai-route-choices");
          const renderChoices = () => {
            choices.replaceChildren();
            const query = search.value.trim().toLowerCase();
            if (capability === "chat") {
              const inherited = element(doc, "div", "seerai-model-choice");
              inherited.tabIndex = 0;
              inherited.setAttribute("role", "option");
              const inheritedLabel = element(
                doc,
                "span",
                "seerai-model-choice-label",
              );
              inheritedLabel.textContent = "Use app default";
              inherited.appendChild(inheritedLabel);
              if (!stateManager.getOptions().modelRef) {
                inherited.classList.add("is-selected");
                inherited.appendChild(
                  createSvgIcon(doc, "check", { size: 13 }),
                );
              }
              const useDefault = () => {
                stateManager.setOptions({ modelRef: undefined });
                refreshLabel();
                onChange();
                openCapability = undefined;
                renderRoutes();
              };
              inherited.addEventListener("click", useDefault);
              choices.appendChild(inherited);
            }
            const matches = available.filter((item) => {
              const haystack =
                `${item.provider.name} ${item.model.displayName} ${item.model.modelId}`.toLowerCase();
              return !query || haystack.includes(query);
            });
            for (const item of matches.slice(0, 24)) {
              const choice = element(doc, "div", "seerai-model-choice");
              choice.tabIndex = 0;
              choice.setAttribute("role", "option");
              const choiceLabel = element(
                doc,
                "span",
                "seerai-model-choice-label",
              );
              choiceLabel.textContent = `${item.provider.name} — ${item.model.displayName}`;
              choice.appendChild(choiceLabel);
              if (
                item.ref.providerId === effectiveRef?.providerId &&
                item.ref.localModelId === effectiveRef.localModelId
              ) {
                choice.classList.add("is-selected");
                choice.appendChild(createSvgIcon(doc, "check", { size: 13 }));
              }
              const choose = () => {
                if (capability === "chat") {
                  stateManager.setOptions({ modelRef: item.ref });
                  onChange();
                } else {
                  setDefaultModelRef(capability, item.ref);
                }
                refreshLabel();
                openCapability = undefined;
                renderRoutes();
              };
              choice.addEventListener("click", choose);
              choice.addEventListener("keydown", (event) => {
                const keyEvent = event as KeyboardEvent;
                if (keyEvent.key === "Enter" || keyEvent.key === " ") choose();
              });
              choices.appendChild(choice);
            }
            if (matches.length === 0) {
              const empty = element(
                doc,
                "button",
                "seerai-chat-model-configure",
              );
              empty.type = "button";
              empty.textContent = "No matching models · Manage providers";
              empty.addEventListener("click", () => manage.click());
              choices.appendChild(empty);
            } else if (matches.length > 24) {
              const limit = element(doc, "div", "seerai-chat-model-limit");
              limit.textContent = `${matches.length - 24} more · refine your search`;
              choices.appendChild(limit);
            }
          };
          search.addEventListener("input", renderChoices);
          chooser.append(search, choices);
          route.appendChild(chooser);
          renderChoices();
          setTimeout(() => search.focus(), 0);
        }
        routes.appendChild(route);
      }
      if (popup.isConnected) setTimeout(positionPopup, 0);
    };
    const presets = createRoutingPresetBar(
      doc,
      () => ({
        ...getProviderRegistryState().defaults,
        ...(stateManager.getOptions().modelRef && {
          chat: stateManager.getOptions().modelRef,
        }),
      }),
      (models) => {
        stateManager.setOptions({ modelRef: models.chat });
        refreshLabel();
        onChange();
        renderRoutes();
      },
      {
        get: () => stateManager.getOptions().routingPresetId,
        set: (routingPresetId) => stateManager.setOptions({ routingPresetId }),
      },
    );
    const manage = element(doc, "button", "seerai-chat-model-manage");
    manage.type = "button";
    manage.appendChild(createSvgIcon(doc, "settings", { size: 13 }));
    manage.append(" Add or manage providers");
    manage.addEventListener("click", () => {
      popup.classList.add("is-managing");
      popup.replaceChildren();
      const toolbar = element(doc, "div", "seerai-provider-picker-toolbar");
      const back = element(doc, "button", "seerai-provider-picker-back");
      back.type = "button";
      back.appendChild(createSvgIcon(doc, "chevron-left", { size: 13 }));
      back.append(" Back to models");
      back.addEventListener("click", () => {
        popup.remove();
        button.click();
      });
      const providerHost = element(doc, "div", "seerai-provider-surface");
      toolbar.appendChild(back);
      popup.append(toolbar, providerHost);
      renderProviderSettings(doc, providerHost);
      positionPopup();
    });
    popup.append(presets, routes, manage);
    (doc.body || doc.documentElement)?.appendChild(popup);
    renderRoutes();
    positionPopup();
    const closePopup = (closeEvent: MouseEvent) => {
      if (
        popup.contains(closeEvent.target as Node) ||
        closeEvent.target === button
      )
        return;
      setTimeout(() => {
        const activeElement = doc.activeElement;
        if (activeElement && popup.contains(activeElement)) return;
        popup.remove();
        doc.removeEventListener("mousedown", closePopup);
      }, 0);
    };
    setTimeout(() => doc.addEventListener("mousedown", closePopup), 0);
  });
  return button;
}
