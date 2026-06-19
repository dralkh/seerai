import { discoverModels } from "../modelDiscovery";
import { getAvailableModels } from "../modelResolver";
import {
  addProviderConfig,
  deleteProviderConfig,
  getDefaultModelRef,
  getProviderConfig,
  getProviderConfigs,
  replaceDiscoveredModels,
  setDefaultModelRef,
  updateProviderConfig,
} from "../providerRegistry";
import { getProviderPresets, getPresetById } from "../providerPresets";
import type {
  AuthMethod,
  DiscoveredModel,
  ModelCapability,
  ProviderConfig,
  ProviderModel,
} from "../providerTypes";
import { MODEL_TYPE_ENDPOINTS, type ModelType } from "../types";
import type { ChatStateManager } from "../stateManager";
import { createSvgIcon } from "./icons";

const CAPABILITIES: ModelType[] = [
  "chat",
  "embedding",
  "image",
  "video",
  "tts",
  "stt",
];

function element<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  className?: string,
): HTMLElementTagNameMap[K] {
  const value = doc.createElement(tag);
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

export interface ProviderManagerOptions {
  providerId?: string;
  onChange?: () => void;
}

export function showProviderManagerDialog(
  doc: Document,
  options: ProviderManagerOptions = {},
): void {
  doc.getElementById("seerai-provider-dialog")?.remove();
  const existing = options.providerId
    ? getProviderConfig(options.providerId)
    : undefined;
  const overlay = element(doc, "div", "seerai-provider-overlay");
  overlay.id = "seerai-provider-dialog";
  const dialog = element(doc, "div", "seerai-provider-dialog");
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
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
  connectionTitle.textContent = "1. Connection";
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
  testButton.textContent = "Test and discover models";
  const connectionStatus = element(doc, "span", "seerai-connection-status");
  connectionActions.append(testButton, connectionStatus);
  connection.append(
    presetField,
    nameField,
    keyField,
    advanced,
    connectionActions,
  );

  const modelsSection = element(doc, "section", "seerai-provider-section");
  const modelsTitle = element(doc, "h3");
  modelsTitle.textContent = "2. Models";
  const policyRow = element(doc, "div", "seerai-policy-row");
  const policyText = element(doc, "div");
  const policyName = element(doc, "strong");
  policyName.textContent = "Available models";
  const policyHelp = element(doc, "span");
  policyHelp.textContent =
    "Automatic uses all discovered models. Adding a model below switches to Selected only.";
  policyText.append(policyName, policyHelp);
  const policySelect = element(doc, "select");
  for (const [value, label] of [
    ["automatic", "All discovered"],
    ["scoped", "Selected only"],
  ]) {
    const option = element(doc, "option");
    option.value = value;
    option.textContent = label;
    policySelect.appendChild(option);
  }
  policySelect.value = existing?.modelPolicy || "automatic";
  policyRow.append(policyText, policySelect);
  modelsSection.append(modelsTitle, policyRow);

  let discovered: DiscoveredModel[] = [...(existing?.models || [])];
  let configured: ProviderModel[] = [...(existing?.configuredModels || [])];
  const lanes = element(doc, "div", "seerai-capability-lanes");

  const renderLanes = () => {
    lanes.replaceChildren();
    for (const capability of CAPABILITIES) {
      const lane = element(doc, "div", "seerai-capability-lane");
      const laneHeader = element(doc, "div", "seerai-capability-header");
      const laneTitle = element(doc, "strong");
      laneTitle.textContent = capabilityLabel(capability);
      laneHeader.appendChild(laneTitle);
      const chips = element(doc, "div", "seerai-model-chips");
      for (const model of configured.filter((item) =>
        item.capabilities.includes(capability),
      )) {
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
      const add = element(doc, "button", "seerai-secondary-button");
      add.type = "button";
      add.appendChild(createSvgIcon(doc, "add", { size: 13 }));
      add.append(" Add");
      add.addEventListener("click", () => {
        const modelId = modelInput.value.trim();
        if (!modelId) return;
        const existingModel = configured.find(
          (item) => item.modelId === modelId,
        );
        if (existingModel) {
          if (!existingModel.capabilities.includes(capability)) {
            existingModel.capabilities.push(capability);
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
            createdAt: now,
            updatedAt: now,
          });
        }
        policySelect.value = "scoped";
        modelInput.value = "";
        renderLanes();
      });
      addRow.append(modelInput, suggestions, add);
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
  dialog.append(body, error, footer);
  overlay.appendChild(dialog);
  (doc.body || doc.documentElement)?.appendChild(overlay);

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
  };
  if (!existing) applyPreset();
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
    connectionStatus.textContent = "Testing…";
    try {
      const draft = draftConnection();
      discovered = await discoverModels(draft);
      connectionStatus.textContent =
        discovered.length > 0
          ? `Connected · ${discovered.length} models`
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

  const dismiss = () => overlay.remove();
  close.addEventListener("click", dismiss);
  cancel.addEventListener("click", dismiss);
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) dismiss();
  });
  const onKey = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      dismiss();
      doc.defaultView?.removeEventListener("keydown", onKey);
    }
  };
  doc.defaultView?.addEventListener("keydown", onKey);

  save.addEventListener("click", () => {
    error.hidden = true;
    try {
      const draft = draftConnection();
      if (!draft.name) throw new Error("Display name is required.");
      new URL(draft.apiURL);
      const preset = getPresetById(presetSelect.value);
      if (preset?.requiresApiKey && !draft.apiKey) {
        throw new Error("This provider requires an API key.");
      }
      const value = {
        ...draft,
        adapterId: existing?.adapterId || draft.adapterId,
        modelsURL: existing?.modelsURL || draft.modelsURL,
        enabled: existing?.enabled ?? draft.enabled,
        isActive: existing?.isActive ?? draft.isActive,
        models: discovered,
        configuredModels: policySelect.value === "scoped" ? configured : [],
        modelPolicy: policySelect.value as "automatic" | "scoped",
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
      dismiss();
      options.onChange?.();
    } catch (reason) {
      error.textContent =
        reason instanceof Error ? reason.message : String(reason);
      error.hidden = false;
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
    identity.appendChild(
      createSvgIcon(doc, preset?.icon || "server", { size: 18 }),
    );
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
    status.textContent = provider.enabled === false ? "Disabled" : "Enabled";
    cardHeader.append(identity, status);
    const meta = element(doc, "div", "seerai-provider-meta");
    const available = CAPABILITIES.filter((capability) =>
      getAvailableModels(capability).some(
        (item) => item.provider.id === provider.id,
      ),
    );
    meta.textContent = `${provider.modelPolicy === "scoped" ? provider.configuredModels?.length || 0 : provider.models.length} models · ${available.map(capabilityLabel).join(", ") || "No capabilities"}`;
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
    card.append(cardHeader, meta, actions);
    list.appendChild(card);
    edit.addEventListener("click", () =>
      showProviderManagerDialog(doc, {
        providerId: provider.id,
        onChange: () => renderProviderSettings(doc, container),
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
      onChange: () => renderProviderSettings(doc, container),
    }),
  );
}

export function renderModelDefaults(
  doc: Document,
  container: HTMLElement,
): void {
  container.replaceChildren();
  const header = element(doc, "div", "seerai-settings-section-header");
  const heading = element(doc, "div");
  const title = element(doc, "h3");
  title.textContent = "Default models";
  const subtitle = element(doc, "p");
  subtitle.textContent =
    "Choose each capability independently, or assign one provider in bulk.";
  heading.append(title, subtitle);
  header.appendChild(heading);
  container.appendChild(header);

  const bulk = element(doc, "div", "seerai-default-bulk");
  const bulkLabel = element(doc, "span");
  bulkLabel.textContent = "Use one provider where compatible";
  const bulkSelect = element(doc, "select");
  const placeholder = element(doc, "option");
  placeholder.value = "";
  placeholder.textContent = "Choose provider";
  bulkSelect.appendChild(placeholder);
  for (const provider of getProviderConfigs().filter(
    (item) => item.enabled !== false,
  )) {
    const option = element(doc, "option");
    option.value = provider.id;
    option.textContent = provider.name;
    bulkSelect.appendChild(option);
  }
  const apply = element(doc, "button", "seerai-secondary-button");
  apply.type = "button";
  apply.textContent = "Apply";
  bulk.append(bulkLabel, bulkSelect, apply);
  container.appendChild(bulk);

  const rows = element(doc, "div", "seerai-default-rows");
  for (const capability of CAPABILITIES) {
    const row = element(doc, "label", "seerai-default-row");
    const info = element(doc, "div");
    const label = element(doc, "strong");
    label.textContent = capabilityLabel(capability);
    const description = element(doc, "span");
    description.textContent = MODEL_TYPE_ENDPOINTS[capability].description;
    info.append(label, description);
    const select = element(doc, "select");
    select.dataset.capability = capability;
    const none = element(doc, "option");
    none.value = "";
    none.textContent =
      capability === "chat" ? "Select a model" : "Not configured";
    none.disabled = capability === "chat";
    select.appendChild(none);
    for (const item of getAvailableModels(capability)) {
      const option = element(doc, "option");
      option.value = refValue(item.provider.id, item.model.id);
      option.textContent = `${item.provider.name} · ${item.model.displayName}`;
      select.appendChild(option);
    }
    const current = getDefaultModelRef(capability);
    if (current)
      select.value = refValue(current.providerId, current.localModelId);
    select.addEventListener("change", () => {
      if (!select.value) {
        if (capability === "chat") {
          select.value = current
            ? refValue(current.providerId, current.localModelId)
            : "";
          return;
        }
        setDefaultModelRef(capability, undefined);
      } else {
        setDefaultModelRef(capability, JSON.parse(select.value));
      }
    });
    row.append(info, select);
    rows.appendChild(row);
  }
  container.appendChild(rows);
  apply.addEventListener("click", () => {
    if (!bulkSelect.value) return;
    for (const capability of CAPABILITIES) {
      const match = getAvailableModels(capability).find(
        (item) => item.provider.id === bulkSelect.value,
      );
      if (match) setDefaultModelRef(capability, match.ref);
    }
    renderModelDefaults(doc, container);
  });
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
    popup.style.left = `${Math.max(8, rect.left)}px`;
    popup.style.bottom = `${Math.max(8, (doc.defaultView?.innerHeight || 0) - rect.top + 6)}px`;
    const search = element(doc, "input");
    search.type = "search";
    search.placeholder = "Search providers and models";
    const results = element(doc, "div", "seerai-chat-model-results");
    const render = () => {
      results.replaceChildren();
      const query = search.value.trim().toLowerCase();
      const inherited = element(doc, "button", "seerai-chat-model-option");
      inherited.type = "button";
      inherited.textContent = "Use app default";
      inherited.addEventListener("click", () => {
        stateManager.setOptions({ modelRef: undefined });
        refreshLabel();
        onChange();
        popup.remove();
      });
      results.appendChild(inherited);
      const grouped = new Map<string, ReturnType<typeof getAvailableModels>>();
      for (const item of getAvailableModels("chat")) {
        const haystack =
          `${item.provider.name} ${item.model.displayName} ${item.model.modelId}`.toLowerCase();
        if (query && !haystack.includes(query)) continue;
        const values = grouped.get(item.provider.id) || [];
        values.push(item);
        grouped.set(item.provider.id, values);
      }
      for (const values of grouped.values()) {
        const group = element(doc, "div", "seerai-chat-model-group");
        group.textContent = values[0].provider.name;
        results.appendChild(group);
        for (const item of values) {
          const option = element(doc, "button", "seerai-chat-model-option");
          option.type = "button";
          const name = element(doc, "strong");
          name.textContent = item.model.displayName;
          const id = element(doc, "span");
          id.textContent = item.model.modelId;
          option.append(name, id);
          option.addEventListener("click", () => {
            stateManager.setOptions({ modelRef: item.ref });
            refreshLabel();
            onChange();
            popup.remove();
          });
          results.appendChild(option);
        }
      }
    };
    const manage = element(doc, "button", "seerai-chat-model-manage");
    manage.type = "button";
    manage.appendChild(createSvgIcon(doc, "settings", { size: 13 }));
    manage.append(" Add or manage providers");
    manage.addEventListener("click", () => {
      popup.remove();
      showProviderManagerDialog(doc, {
        onChange: () => {
          refreshLabel();
          onChange();
        },
      });
    });
    search.addEventListener("input", render);
    popup.append(search, results, manage);
    (doc.body || doc.documentElement)?.appendChild(popup);
    render();
    search.focus();
    const closePopup = (closeEvent: MouseEvent) => {
      if (
        !popup.contains(closeEvent.target as Node) &&
        closeEvent.target !== button
      ) {
        popup.remove();
        doc.removeEventListener("mousedown", closePopup);
      }
    };
    setTimeout(() => doc.addEventListener("mousedown", closePopup), 0);
  });
  return button;
}
