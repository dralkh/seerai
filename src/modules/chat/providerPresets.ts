import type { ProviderPreset } from "./providerTypes";
import type { IconName } from "./ui/icons";

const ICON_OPENAI: IconName = "sparkles";
const ICON_ANTHROPIC: IconName = "brain";
const ICON_GOOGLE: IconName = "sparkle";
const ICON_XAI: IconName = "zap";
const ICON_MISTRAL: IconName = "idea";
const ICON_DEEPSEEK: IconName = "terminal";
const ICON_TOGETHER: IconName = "users";
const ICON_GROQ: IconName = "lightning";
const ICON_FIREWORKS: IconName = "fire";
const ICON_COHERE: IconName = "compass";
const ICON_OPENROUTER: IconName = "swap";
const ICON_OLLAMA: IconName = "server";
const ICON_LMSTUDIO: IconName = "home";
const ICON_AZURE: IconName = "cloud";
const ICON_HERMES: IconName = "robot";
const ICON_OPENCODE: IconName = "terminal";

export const providerPresets: ProviderPreset[] = [
  {
    id: "openai",
    name: "OpenAI",
    requiresApiKey: true,
    isLocal: false,
    icon: ICON_OPENAI,
    apiURL: "https://api.openai.com/v1/",
    authMethod: "bearer",
    apiKeyPlaceholder: "sk-...",
    defaultModel: "gpt-5-mini",
    supportsModelDiscovery: true,
    adapterId: "openai-compatible",
    verifiedCapabilities: ["chat", "embedding", "image", "video", "tts", "stt"],
  },
  {
    id: "anthropic",
    name: "Anthropic (Claude)",
    requiresApiKey: true,
    isLocal: false,
    icon: ICON_ANTHROPIC,
    apiURL: "https://api.anthropic.com/v1/",
    authMethod: "x-api-key",
    authHeaderName: "x-api-key",
    authPrefix: "",
    extraHeaders: { "anthropic-version": "2023-06-01" },
    apiKeyPlaceholder: "sk-ant-...",
    defaultModel: "claude-sonnet-4.5",
    supportsModelDiscovery: true,
    adapterId: "anthropic",
    verifiedCapabilities: ["chat"],
    notes: "Uses x-api-key header, not standard Bearer token",
  },
  {
    id: "google",
    name: "Google Gemini",
    requiresApiKey: true,
    isLocal: false,
    icon: ICON_GOOGLE,
    apiURL: "https://generativelanguage.googleapis.com/v1beta/openai/",
    authMethod: "bearer",
    apiKeyPlaceholder: "AIza...",
    defaultModel: "gemini-2.5-flash",
    supportsModelDiscovery: true,
    adapterId: "openai-compatible",
    verifiedCapabilities: ["chat"],
  },
  {
    id: "xai",
    name: "xAI (Grok)",
    requiresApiKey: true,
    isLocal: false,
    icon: ICON_XAI,
    apiURL: "https://api.x.ai/v1/",
    authMethod: "bearer",
    apiKeyPlaceholder: "xai-...",
    defaultModel: "grok-4.1-fast",
    supportsModelDiscovery: true,
  },
  {
    id: "mistral",
    name: "Mistral AI",
    requiresApiKey: true,
    isLocal: false,
    icon: ICON_MISTRAL,
    apiURL: "https://api.mistral.ai/v1/",
    authMethod: "bearer",
    defaultModel: "mistral-large-latest",
    supportsModelDiscovery: true,
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    requiresApiKey: true,
    isLocal: false,
    icon: ICON_DEEPSEEK,
    apiURL: "https://api.deepseek.com/v1/",
    authMethod: "bearer",
    defaultModel: "deepseek-chat",
    supportsModelDiscovery: true,
  },
  {
    id: "together",
    name: "Together AI",
    requiresApiKey: true,
    isLocal: false,
    icon: ICON_TOGETHER,
    apiURL: "https://api.together.xyz/v1/",
    authMethod: "bearer",
    defaultModel: "meta-llama/Meta-Llama-3.1-70B-Instruct-Turbo",
    supportsModelDiscovery: true,
  },
  {
    id: "groq",
    name: "Groq",
    requiresApiKey: true,
    isLocal: false,
    icon: ICON_GROQ,
    apiURL: "https://api.groq.com/openai/v1/",
    authMethod: "bearer",
    apiKeyPlaceholder: "gsk_...",
    defaultModel: "llama-3.3-70b-versatile",
    supportsModelDiscovery: true,
  },
  {
    id: "fireworks",
    name: "Fireworks AI",
    requiresApiKey: true,
    isLocal: false,
    icon: ICON_FIREWORKS,
    apiURL: "https://api.fireworks.ai/inference/v1/",
    authMethod: "bearer",
    apiKeyPlaceholder: "fw_...",
    defaultModel: "accounts/fireworks/models/llama-v3p3-70b-instruct",
    supportsModelDiscovery: true,
  },
  {
    id: "cohere",
    name: "Cohere",
    requiresApiKey: true,
    isLocal: false,
    icon: ICON_COHERE,
    apiURL: "https://api.cohere.com/compatibility/v1/",
    authMethod: "bearer",
    defaultModel: "command-r-plus",
    supportsModelDiscovery: true,
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    requiresApiKey: true,
    isLocal: false,
    icon: ICON_OPENROUTER,
    apiURL: "https://openrouter.ai/api/v1/",
    authMethod: "bearer",
    apiKeyPlaceholder: "sk-or-...",
    defaultModel: "openai/gpt-5-mini",
    supportsModelDiscovery: true,
    notes: "Meta-router: access 500+ models from 60+ providers with one key",
  },
  {
    id: "ollama",
    name: "Ollama (Local)",
    icon: ICON_OLLAMA,
    apiURL: "http://localhost:11434/v1/",
    authMethod: "none",
    requiresApiKey: false,
    isLocal: true,
    defaultModel: "llama3.3:70b",
    supportsModelDiscovery: true,
  },
  {
    id: "lmstudio",
    name: "LM Studio (Local)",
    icon: ICON_LMSTUDIO,
    apiURL: "http://localhost:1234/v1/",
    authMethod: "none",
    requiresApiKey: false,
    isLocal: true,
    supportsModelDiscovery: true,
    notes: "Run LM Studio with a model loaded first",
  },
  {
    id: "azure",
    name: "Azure OpenAI",
    requiresApiKey: true,
    isLocal: false,
    icon: ICON_AZURE,
    apiURL:
      "https://{resource}.openai.azure.com/openai/deployments/{deployment}/",
    authMethod: "api-key-header",
    authHeaderName: "api-key",
    supportsModelDiscovery: false,
    adapterId: "azure-openai",
    verifiedCapabilities: ["chat", "embedding", "image", "tts", "stt"],
    notes: "Replace {resource} and {deployment} in URL",
  },
  {
    id: "nanogpt",
    name: "NanoGPT",
    icon: ICON_OPENROUTER,
    apiURL: "https://nano-gpt.com/api/v1",
    authMethod: "bearer",
    apiKeyPlaceholder: "nano-...",
    requiresApiKey: true,
    isLocal: false,
    supportsModelDiscovery: true,
    adapterId: "nanogpt",
    verifiedCapabilities: ["chat", "image", "video", "tts", "stt"],
  },
  {
    id: "hermes-agent",
    name: "Hermes Agent",
    icon: ICON_HERMES,
    apiURL: "http://localhost:8642/v1/",
    authMethod: "bearer",
    apiKeyPlaceholder: "change-me-local-dev",
    requiresApiKey: true,
    isLocal: true,
    isAgent: true,
    defaultModel: "hermes-agent",
    supportsModelDiscovery: true,
    notes:
      "Full research agent with terminal, file ops, web search. OpenAI-compatible API.",
  },
  {
    id: "opencode",
    name: "OpenCode",
    icon: ICON_OPENCODE,
    apiURL: "http://localhost:3000/v1/",
    authMethod: "none",
    requiresApiKey: false,
    isLocal: true,
    isAgent: true,
    supportsModelDiscovery: true,
    notes: "Coding agent. Run opencode serve first.",
  },
];

export function getPresetById(id: string): ProviderPreset | undefined {
  return providerPresets.find((p) => p.id === id);
}

export function getProviderPresets(): ProviderPreset[] {
  return providerPresets;
}
