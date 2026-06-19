import type { IconName } from "./ui/icons";

export type AuthMethod =
  | "bearer"
  | "x-api-key"
  | "api-key-header"
  | "aws-sigv4"
  | "none";

export interface ProviderPreset {
  id: string;
  name: string;
  icon?: IconName;
  apiURL: string;
  modelsURL?: string;
  authMethod: AuthMethod;
  authHeaderName?: string;
  authPrefix?: string;
  extraHeaders?: Record<string, string>;
  apiKeyPlaceholder?: string;
  requiresApiKey: boolean;
  supportsModelDiscovery: boolean;
  isLocal: boolean;
  isAgent?: boolean;
  defaultModel?: string;
  notes?: string;
  adapterId?: ProviderAdapterId;
  verifiedCapabilities?: ModelCapability[];
}

export interface DiscoveredModel {
  id: string;
  object: string;
  created?: number;
  owned_by?: string;
  displayName?: string;
  contextLength?: number;
  capabilities?: ModelCapability[];
}

export type ProviderAdapterId =
  | "openai-compatible"
  | "openrouter"
  | "anthropic"
  | "azure-openai"
  | "nanogpt";

export type ProviderModelPolicy = "automatic" | "scoped";

export interface ModelRef {
  providerId: string;
  localModelId: string;
}

export interface ModelRoutingPreset {
  id: string;
  name: string;
  models: Partial<
    Record<"chat" | "embedding" | "image" | "video" | "tts" | "stt", ModelRef>
  >;
  createdAt: string;
  updatedAt: string;
}

export interface ProviderModel {
  id: string;
  modelId: string;
  displayName: string;
  capabilities: ModelCapability[];
  endpointOverrides?: Partial<
    Record<Exclude<ModelCapability, "reasoning">, string>
  >;
  contextLength?: number;
  reasoningEffort?: "low" | "medium" | "high";
  toolChoice?: "auto" | "required" | "none";
  rateLimit?: {
    type: "tpm" | "rpm" | "concurrency";
    value: number;
  };
  voice?: string;
  dimensions?: number;
  maxTokens?: number;
  ragTokenThreshold?: number;
  ragAlwaysUse?: boolean;
  ragTopK?: number;
  ragMinScore?: number;
  createdAt: string;
  updatedAt: string;
}

export type ModelCapability =
  | "chat"
  | "embedding"
  | "image"
  | "tts"
  | "stt"
  | "video"
  | "reasoning";

export interface ProviderConfig {
  id: string;
  presetId?: string;
  name: string;
  apiURL: string;
  apiKey: string;
  authMethod: AuthMethod;
  authHeaderName?: string;
  authPrefix?: string;
  extraHeaders?: Record<string, string>;
  models: DiscoveredModel[];
  configuredModels?: ProviderModel[];
  modelPolicy?: ProviderModelPolicy;
  modelsLastFetched?: string;
  isActive: boolean;
  enabled?: boolean;
  adapterId?: ProviderAdapterId;
  modelsURL?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProviderRegistryState {
  version: 2;
  providers: ProviderConfig[];
  defaults: Partial<
    Record<"chat" | "embedding" | "image" | "video" | "tts" | "stt", ModelRef>
  >;
  routingPresets?: ModelRoutingPreset[];
  migratedAt?: string;
}

export interface ResolvedModel {
  ref: ModelRef;
  provider: ProviderConfig;
  model: ProviderModel;
  adapterId: ProviderAdapterId;
  endpoint: string;
  headers: Record<string, string>;
}

/**
 * Infer model capabilities from a model ID string.
 */
export function inferCapabilities(modelId: string): ModelCapability[] {
  const id = modelId.toLowerCase();

  if (id.includes("embed")) return ["embedding"];
  if (id.includes("tts") || id.includes("speech")) return ["tts"];
  if (id.includes("whisper") || id.includes("stt")) return ["stt"];
  if (
    id.includes("dall-e") ||
    id.includes("imagen") ||
    id.includes("flux") ||
    id.includes("stable-diffusion") ||
    id.includes("midjourney")
  )
    return ["image"];
  if (id.includes("sora") || id.includes("video")) return ["video"];
  if (
    id.startsWith("o1") ||
    id.startsWith("o3") ||
    id.startsWith("o4") ||
    id.includes("reason") ||
    id.includes("think")
  )
    return ["reasoning", "chat"];

  return ["chat"];
}

/**
 * Convert a model ID like 'gpt-5-mini' to a display name like 'GPT 5 Mini'.
 * Preserves dots (e.g. 'claude-sonnet-4.5' → 'Claude Sonnet 4.5').
 */
export function formatModelDisplayName(id: string): string {
  return id
    .split(/[-_]/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}
