import type {
  AuthMethod,
  DiscoveredModel,
  ModelCapability,
  ProviderAdapterId,
} from "./providerTypes";
import { formatModelDisplayName, inferCapabilities } from "./providerTypes";
import { getPresetById } from "./providerPresets";

interface ProviderConfig {
  apiURL: string;
  modelsURL?: string;
  presetId?: string;
  adapterId?: ProviderAdapterId;
  cliAgentId?: string;
  authMethod?: AuthMethod;
  apiKey?: string;
  authHeaderName?: string;
  authPrefix?: string;
  extraHeaders?: Record<string, string>;
}

type ModelRecord = Record<string, unknown>;

function asRecord(value: unknown): ModelRecord | undefined {
  return value && typeof value === "object"
    ? (value as ModelRecord)
    : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function capabilitiesFromMetadata(item: ModelRecord): ModelCapability[] {
  const result = new Set<ModelCapability>();
  const architecture = asRecord(item.architecture);
  const inputModalities = stringArray(
    architecture?.input_modalities || item.input_modalities,
  ).map((value) => value.toLowerCase());
  const outputModalities = stringArray(
    architecture?.output_modalities || item.output_modalities,
  ).map((value) => value.toLowerCase());
  if (outputModalities.includes("embeddings")) result.add("embedding");
  if (outputModalities.includes("image")) result.add("image");
  if (outputModalities.includes("video")) result.add("video");
  if (outputModalities.includes("audio")) result.add("tts");
  if (inputModalities.includes("audio") && outputModalities.includes("text")) {
    result.add("stt");
  }
  if (
    outputModalities.includes("text") &&
    !result.has("stt") &&
    !result.has("embedding")
  ) {
    result.add("chat");
  }

  const typeValues = [item.type, item.display_type, item.model_type, item.task]
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.toLowerCase());
  for (const value of typeValues) {
    if (value.includes("embed")) result.add("embedding");
    else if (value.includes("image")) result.add("image");
    else if (value.includes("video")) result.add("video");
    else if (
      value.includes("transcri") ||
      value.includes("speech-to-text") ||
      value.includes("asr")
    )
      result.add("stt");
    else if (
      value.includes("text-to-speech") ||
      value.includes("speech") ||
      value.includes("audio")
    )
      result.add("tts");
    else if (
      value.includes("chat") ||
      value.includes("language") ||
      value.includes("text-generation")
    )
      result.add("chat");
  }

  const endpoints = [
    ...stringArray(item.endpoints),
    ...stringArray(item.supported_endpoints),
    ...stringArray(item.supportedGenerationMethods),
    ...stringArray(item.supported_generation_methods),
  ].map((value) => value.toLowerCase());
  for (const endpoint of endpoints) {
    if (endpoint.includes("embed")) result.add("embedding");
    if (endpoint.includes("image")) result.add("image");
    if (endpoint.includes("video")) result.add("video");
    if (endpoint.includes("transcri")) result.add("stt");
    if (endpoint.includes("speech")) result.add("tts");
    if (
      endpoint.includes("chat") ||
      endpoint.includes("generatecontent") ||
      endpoint.includes("completion")
    )
      result.add("chat");
  }

  const capabilities = asRecord(item.capabilities);
  if (capabilities) {
    if (
      capabilities.completion_chat === true ||
      capabilities.chat === true ||
      capabilities.text === true
    )
      result.add("chat");
    if (capabilities.embedding === true || capabilities.embeddings === true)
      result.add("embedding");
    if (capabilities.image_generation === true) result.add("image");
    if (capabilities.video_generation === true) result.add("video");
    if (capabilities.text_to_speech === true) result.add("tts");
    if (capabilities.speech_to_text === true) result.add("stt");
  }
  for (const capability of stringArray(item.capabilities)) {
    const normalized = capability.toLowerCase();
    if (normalized === "text" || normalized === "chat") result.add("chat");
    if (normalized.includes("embed")) result.add("embedding");
    if (normalized.includes("image")) result.add("image");
    if (normalized.includes("video")) result.add("video");
    if (normalized === "tts" || normalized.includes("text-to-speech"))
      result.add("tts");
    if (normalized === "stt" || normalized.includes("speech-to-text"))
      result.add("stt");
  }
  return [...result];
}

function responseItems(value: unknown): ModelRecord[] {
  if (Array.isArray(value))
    return value.map(asRecord).filter(Boolean) as ModelRecord[];
  const root = asRecord(value);
  if (!root) return [];
  for (const candidate of [root.data, root.models, root.items, root.results]) {
    if (Array.isArray(candidate)) {
      return candidate.map(asRecord).filter(Boolean) as ModelRecord[];
    }
  }
  const data = asRecord(root.data);
  if (Array.isArray(data?.models)) {
    return data.models.map(asRecord).filter(Boolean) as ModelRecord[];
  }
  return [];
}

function isOpenCodeChatCompletionsModel(
  presetId: string | undefined,
  modelId: string,
): boolean {
  const id = modelId.toLowerCase();
  if (presetId === "opencode-zen") {
    return !["claude-", "gemini-", "gpt-", "qwen"].some((prefix) =>
      id.startsWith(prefix),
    );
  }
  if (presetId === "opencode-go") {
    return !["minimax-", "qwen"].some((prefix) => id.startsWith(prefix));
  }
  return true;
}

export function parseModelsResponse(
  value: unknown,
  config: Pick<ProviderConfig, "presetId"> = {},
): DiscoveredModel[] {
  const verifiedCapabilities = config.presetId
    ? getPresetById(config.presetId)?.verifiedCapabilities
    : undefined;
  const models: DiscoveredModel[] = [];
  const seen = new Set<string>();
  for (const item of responseItems(value)) {
    const rawId = item.id || item.model || item.model_id || item.name;
    if (typeof rawId !== "string" || !rawId.trim()) continue;
    let id = rawId.trim();
    if (config.presetId === "google" && id.startsWith("models/")) {
      id = id.slice("models/".length);
    }
    if (!isOpenCodeChatCompletionsModel(config.presetId, id)) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    const metadataCapabilities = capabilitiesFromMetadata(item);
    const inferredCapabilities = inferCapabilities(id);
    const specializedInference = inferredCapabilities.some(
      (capability) => capability !== "chat" && capability !== "reasoning",
    );
    const specializedMetadata = metadataCapabilities.some(
      (capability) => capability !== "chat" && capability !== "reasoning",
    );
    const detectedCapabilities = specializedInference
      ? inferredCapabilities
      : specializedMetadata
        ? metadataCapabilities
        : metadataCapabilities.length > 0
          ? Array.from(
              new Set([...metadataCapabilities, ...inferredCapabilities]),
            )
          : inferredCapabilities;
    const capabilities = verifiedCapabilities
      ? detectedCapabilities.filter(
          (capability) =>
            capability === "reasoning" ||
            verifiedCapabilities.includes(capability),
        )
      : detectedCapabilities;
    const displayNameValue =
      item.displayName || item.display_name || item.name || item.id;
    const contextLengthValue =
      item.context_length || item.contextLength || item.max_context_length;
    models.push({
      id,
      object: typeof item.object === "string" ? item.object : "model",
      created: typeof item.created === "number" ? item.created : undefined,
      owned_by: typeof item.owned_by === "string" ? item.owned_by : undefined,
      displayName:
        typeof displayNameValue === "string" && displayNameValue !== rawId
          ? displayNameValue
          : formatModelDisplayName(id),
      contextLength:
        typeof contextLengthValue === "number" ? contextLengthValue : undefined,
      capabilities,
    });
  }
  return models;
}

export function buildAuthHeaders(
  config: ProviderConfig,
): Record<string, string> {
  const headers: Record<string, string> = {};
  const authMethod = config.authMethod || "bearer";
  const apiKey = config.apiKey || "";

  switch (authMethod) {
    case "bearer":
      headers["Authorization"] = `${config.authPrefix ?? "Bearer "}${apiKey}`;
      break;
    case "x-api-key":
      headers[config.authHeaderName || "x-api-key"] = apiKey;
      break;
    case "api-key-header":
      headers[config.authHeaderName || "api-key"] = apiKey;
      break;
    case "none":
      break;
    case "aws-sigv4":
      break;
  }

  if (config.extraHeaders) {
    for (const key of Object.keys(config.extraHeaders)) {
      headers[key] = config.extraHeaders[key];
    }
  }

  return headers;
}

export async function discoverModels(
  config: ProviderConfig,
): Promise<DiscoveredModel[]> {
  const preset = config.presetId ? getPresetById(config.presetId) : undefined;
  const catalogFallback = (): DiscoveredModel[] =>
    (preset?.catalogModels || []).map((model) => ({
      id: model.id,
      object: "model",
      displayName: formatModelDisplayName(model.id),
      capabilities: model.capabilities,
      contextLength: model.contextLength,
    }));

  // Local CLI providers: pull the live model list from the installed CLI
  // (e.g. `codex debug models`); fall back to the preset catalog if the CLI
  // can't list or isn't reachable.
  const cliAgentId = config.cliAgentId || preset?.cliAgentId;
  if (config.adapterId === "local-cli" || preset?.adapterId === "local-cli") {
    const { fetchCliModels } = await import("./cli/cliModels");
    const live = await fetchCliModels(cliAgentId);
    return live.length ? live : catalogFallback();
  }

  if (preset?.supportsModelDiscovery === false && preset.catalogModels) {
    return catalogFallback();
  }
  const modelsURL =
    config.modelsURL || config.apiURL.replace(/\/+$/, "") + "/models";
  const headers = buildAuthHeaders(config);

  const response = await Zotero.HTTP.request("GET", modelsURL, { headers });
  const text = response.responseText || "{}";
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    const preview = text.replace(/\s+/g, " ").slice(0, 160);
    throw new Error(
      `Model discovery returned a non-JSON response from ${modelsURL}: ${preview}`,
    );
  }
  const models = parseModelsResponse(parsed, config);
  for (const catalogModel of preset?.catalogModels || []) {
    const existing = models.find((model) => model.id === catalogModel.id);
    if (existing) {
      existing.capabilities = Array.from(
        new Set([
          ...(existing.capabilities || []),
          ...catalogModel.capabilities,
        ]),
      );
      existing.contextLength ??= catalogModel.contextLength;
    } else {
      models.push({
        id: catalogModel.id,
        object: "model",
        displayName: formatModelDisplayName(catalogModel.id),
        capabilities: catalogModel.capabilities,
        contextLength: catalogModel.contextLength,
      });
    }
  }
  if (models.length === 0) {
    throw new Error(
      `Model discovery returned no recognizable models from ${modelsURL}`,
    );
  }
  return models;
}

export async function testProviderConnection(
  config: ProviderConfig,
): Promise<{ success: boolean; modelCount?: number; error?: string }> {
  try {
    const models = await discoverModels(config);
    return { success: true, modelCount: models.length };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { success: false, error: msg };
  }
}
