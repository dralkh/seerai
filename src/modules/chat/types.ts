/**
 * Type definitions for AI Chat multi-selection system
 */

// Base selection interface
export interface BaseSelection {
  id: number | string;
  title: string;
}

// Item selection (Zotero library items)
export interface SelectedItem extends BaseSelection {
  id: number;
  type:
    | "journalArticle"
    | "book"
    | "conferencePaper"
    | "report"
    | "thesis"
    | "webpage"
    | "other";
  abstract?: string;
  creators?: string[];
  year?: string;
}

// Creator selection
export interface SelectedCreator extends BaseSelection {
  id: string;
  type: "creator";
}

// Tag selection
export interface SelectedTag extends BaseSelection {
  id: string;
  type: "tag";
}

// Collection selection
export interface SelectedCollection extends BaseSelection {
  id: number;
  type: "collection";
  itemCount?: number;
}

// Note selection
export interface SelectedNote extends BaseSelection {
  id: number;
  type: "note";
  parentItemId?: number;
  content: string;
  dateModified?: string;
}

// Attachment with extracted text
export interface SelectedAttachment extends BaseSelection {
  id: number;
  type: "attachment";
  parentItemId: number;
  filename: string;
  hasOCRText?: boolean;
}

// Pasted image from clipboard
export interface SelectedImage extends BaseSelection {
  id: string; // Unique ID (timestamp)
  type: "image";
  image: string; // Base64 data URL
  mimeType: string; // image/png, image/jpeg, etc.
}

// Table context (extracted data from Paper Tables)
export interface SelectedTable extends BaseSelection {
  id: string; // Unique ID (table config name or timestamp)
  type: "table";
  content: string; // Formatted table data (rows/columns as text)
  rowCount: number; // Number of rows in the table
  columnNames: string[]; // Column names for reference
}

// Union type for any selection
export type Selection =
  | SelectedItem
  | SelectedCreator
  | SelectedTag
  | SelectedCollection
  | SelectedNote
  | SelectedAttachment
  | SelectedImage
  | SelectedTable;

// Chat states containing all selections
export interface ChatStates {
  items: SelectedItem[];
  creators: SelectedCreator[];
  tags: SelectedTag[];
  collections: SelectedCollection[];
  notes: SelectedNote[];
  attachments: SelectedAttachment[];
  images: SelectedImage[];
  tables: SelectedTable[];
}

// Empty default states
export const defaultChatStates: ChatStates = {
  items: [],
  creators: [],
  tags: [],
  collections: [],
  notes: [],
  attachments: [],
  images: [],
  tables: [],
};

// State type names for iteration
export type StateName = keyof ChatStates;

// Chat message types
export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system" | "error";
  content: string;
  timestamp: Date;
  isStreaming?: boolean;
  canRetry?: boolean; // For assistant messages - user can regenerate
  canEdit?: boolean; // For user messages - can be edited
  toolResults?: { toolCall: any; result?: any }[]; // Persisted tool executions
  iterationCount?: number; // Total reasoning turns/iterations
}

// Model type categories for different API capabilities
export type ModelType =
  | "chat" // Chat Completions: POST /api/v1/chat/completions
  | "embedding" // Embeddings: POST /api/v1/embeddings
  | "image" // Image Generation: POST /api/generate-image
  | "video" // Video Generation: POST /api/generate-video (async, poll /api/generate-video/status)
  | "tts" // Text-to-Speech: POST /api/text-to-speech
  | "stt"; // Speech-to-Text: POST /api/transcribe

// API endpoint paths per model type
export const MODEL_TYPE_ENDPOINTS: Record<
  ModelType,
  { path: string; label: string; icon: string; description: string }
> = {
  chat: {
    path: "/chat/completions",
    label: "Chat",
    icon: "\u{1F4AC}", // 💬
    description: "Text generation with streaming support",
  },
  embedding: {
    path: "/embeddings",
    label: "Embeddings",
    icon: "\u{1F9E0}", // 🧠
    description: "Vector embeddings for semantic search",
  },
  image: {
    path: "/images/generations",
    label: "Image",
    icon: "\u{1F3A8}", // 🎨
    description: "DALL-E, Midjourney, Flux, and more",
  },
  video: {
    path: "/generate-video",
    label: "Video",
    icon: "\u{1F3AC}", // 🎬
    description: "Kling, Veo, Hunyuan (async with polling)",
  },
  tts: {
    path: "/audio/speech",
    label: "TTS",
    icon: "\u{1F50A}", // 🔊
    description: "Convert text to natural-sounding audio",
  },
  stt: {
    path: "/audio/transcriptions",
    label: "STT",
    icon: "\u{1F3A4}", // 🎤
    description: "Transcribe audio to text (Whisper, etc.)",
  },
};

// Per-capability model + endpoint override
export interface ModelEndpointConfig {
  model: string; // Model identifier for this capability
  endpoint?: string; // Full override URL; if empty, uses apiURL + default path
  voice?: string; // Voice identifier for TTS (e.g. "af_bella", "nova")
  dimensions?: number; // Output embedding dimensions (embedding models only)
  maxTokens?: number; // Max input tokens per request (embedding models only)
}

// AI Model Configuration - user-defined model settings
export interface AIModelConfig {
  id: string; // Unique identifier (UUID)
  name: string; // Display name (e.g., "My GPT-4")
  apiURL: string; // Base API endpoint URL (origin)
  apiKey: string; // API key
  model: string; // Primary model identifier (chat/completions)
  modelType?: ModelType; // Kept for backward compat; ignored in new configs
  isDefault?: boolean; // Default model for new chats
  rateLimit?: {
    type: "tpm" | "rpm" | "concurrency";
    value: number;
  };
  reasoningEffort?: "low" | "medium" | "high"; // For o1/o3/reasoning models (chat only)
  // Per-capability model + endpoint configs (optional; empty = not configured)
  ttsConfig?: ModelEndpointConfig; // Text-to-Speech
  sttConfig?: ModelEndpointConfig; // Speech-to-Text
  embeddingConfig?: ModelEndpointConfig; // Embeddings
  imageConfig?: ModelEndpointConfig; // Image Generation
  videoConfig?: ModelEndpointConfig; // Video Generation
  ragTokenThreshold?: number; // Token count threshold to activate RAG (default: 64000)
  ragAlwaysUse?: boolean; // Always use RAG regardless of threshold
  createdAt?: string; // ISO date string
  updatedAt?: string; // ISO date string
}

// Conversation metadata
export interface Conversation {
  id: string;
  title: string;
  createdAt: Date;
  updatedAt: Date;
  messages: ChatMessage[];
  states: ChatStates;
  options: ChatOptions; // Persisted options for this conversation
}

// Metadata for history listing
export interface ConversationMetadata {
  id: string;
  title: string;
  createdAt: Date;
  updatedAt: Date;
  messageCount: number;
  preview: string; // Snippet of the last message
}

// Index of all conversations
export interface ConversationHistoryIndex {
  conversations: ConversationMetadata[];
  lastActiveId?: string;
}

// Selection mode for navigation behavior
export type SelectionMode = "lock" | "default" | "explore";

// Chat options/preferences
export interface ChatOptions {
  includeNotes: boolean;
  includeFullText: boolean;
  includeAbstracts: boolean;
  includeImages: boolean; // Include image attachments for vision models
  webSearchEnabled: boolean; // Enable Firecrawl web search for AI context
  selectionMode: SelectionMode; // Navigation behavior: lock (no add), default (single focus), explore (multi-add)
  includeNotesOnly?: boolean; // Only use notes from items, skip PDF full text
  disableSameTitleNoteSkip?: boolean; // Don't skip PDF text even if same-title note exists
  autoPlayTts?: boolean; // Auto-play TTS for assistant responses on completion
  maxTokens?: number;
  temperature?: number; // 0.0 - 2.0, undefined = provider default
  model?: string;
  ragEnabled?: boolean; // Enable semantic search (RAG) for large context
  ragTokenThreshold?: number; // Token count threshold to auto-activate RAG
}

export const defaultChatOptions: ChatOptions = {
  includeNotes: true,
  includeFullText: true,
  includeAbstracts: true,
  includeImages: true, // Enabled by default for vision models
  webSearchEnabled: false, // Disabled by default - requires Firecrawl API
  selectionMode: "default",
  includeNotesOnly: false,
  disableSameTitleNoteSkip: false,
  autoPlayTts: false,
  ragEnabled: undefined, // undefined = inherit from global pref
  ragTokenThreshold: undefined, // undefined = inherit from global pref
};

// Selection chip display config
export interface SelectionConfig {
  icon: string;
  label: string;
  className: string;
}

export const selectionConfigs: Record<StateName, SelectionConfig> = {
  items: {
    icon: "📄",
    label: "Items",
    className: "chip-items",
  },
  creators: {
    icon: "👤",
    label: "Creators",
    className: "chip-creators",
  },
  tags: {
    icon: "🏷️",
    label: "Tags",
    className: "chip-tags",
  },
  collections: {
    icon: "📁",
    label: "Collections",
    className: "chip-collections",
  },
  notes: {
    icon: "📝",
    label: "Notes",
    className: "chip-notes",
  },
  attachments: {
    icon: "📎",
    label: "Attachments",
    className: "chip-attachments",
  },
  images: {
    icon: "🖼️",
    label: "Images",
    className: "chip-images",
  },
  tables: {
    icon: "📊",
    label: "Tables",
    className: "chip-tables",
  },
};
