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
    type: 'journalArticle' | 'book' | 'conferencePaper' | 'report' | 'thesis' | 'webpage' | 'other';
    abstract?: string;
    creators?: string[];
    year?: string;
}

// Creator selection
export interface SelectedCreator extends BaseSelection {
    id: string;
    type: 'creator';
}

// Tag selection
export interface SelectedTag extends BaseSelection {
    id: string;
    type: 'tag';
}

// Collection selection
export interface SelectedCollection extends BaseSelection {
    id: number;
    type: 'collection';
    itemCount?: number;
}

// Note selection
export interface SelectedNote extends BaseSelection {
    id: number;
    type: 'note';
    parentItemId?: number;
    content: string;
    dateModified?: string;
}

// Attachment with extracted text
export interface SelectedAttachment extends BaseSelection {
    id: number;
    type: 'attachment';
    parentItemId: number;
    filename: string;
    hasOCRText?: boolean;
}

// Pasted image from clipboard
export interface SelectedImage extends BaseSelection {
    id: string;          // Unique ID (timestamp)
    type: 'image';
    image: string;       // Base64 data URL
    mimeType: string;    // image/png, image/jpeg, etc.
}

// Union type for any selection
export type Selection =
    | SelectedItem
    | SelectedCreator
    | SelectedTag
    | SelectedCollection
    | SelectedNote
    | SelectedAttachment
    | SelectedImage;

// Chat states containing all selections
export interface ChatStates {
    items: SelectedItem[];
    creators: SelectedCreator[];
    tags: SelectedTag[];
    collections: SelectedCollection[];
    notes: SelectedNote[];
    attachments: SelectedAttachment[];
    images: SelectedImage[];
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
};

// State type names for iteration
export type StateName = keyof ChatStates;

// Chat message types
export interface ChatMessage {
    id: string;
    role: 'user' | 'assistant' | 'system' | 'error';
    content: string;
    timestamp: Date;
    isStreaming?: boolean;
    canRetry?: boolean;   // For assistant messages - user can regenerate
    canEdit?: boolean;    // For user messages - can be edited
}

// AI Model Configuration - user-defined model settings
export interface AIModelConfig {
    id: string;              // Unique identifier (UUID)
    name: string;            // Display name (e.g., "My GPT-4")
    apiURL: string;          // API endpoint URL
    apiKey: string;          // API key
    model: string;           // Model identifier
    isDefault?: boolean;     // Default model for new chats
    createdAt?: string;      // ISO date string
    updatedAt?: string;      // ISO date string
}

// Conversation metadata
export interface Conversation {
    id: string;
    title: string;
    createdAt: Date;
    updatedAt: Date;
    messages: ChatMessage[];
    states: ChatStates;
}

// Chat options/preferences
export interface ChatOptions {
    includeNotes: boolean;
    includeFullText: boolean;
    includeAbstracts: boolean;
    includeImages: boolean;  // Include image attachments for vision models
    maxTokens?: number;
    model?: string;
}

export const defaultChatOptions: ChatOptions = {
    includeNotes: true,
    includeFullText: true,
    includeAbstracts: true,
    includeImages: true,  // Enabled by default for vision models
};

// Selection chip display config
export interface SelectionConfig {
    backgroundColor: string;
    borderColor: string;
    icon: string;
    label: string;
}

export const selectionConfigs: Record<StateName, SelectionConfig> = {
    items: {
        backgroundColor: '#e3f2fd',
        borderColor: '#2196f3',
        icon: '📄',
        label: 'Items',
    },
    creators: {
        backgroundColor: '#f3e5f5',
        borderColor: '#9c27b0',
        icon: '👤',
        label: 'Creators',
    },
    tags: {
        backgroundColor: '#fff3e0',
        borderColor: '#ff9800',
        icon: '🏷️',
        label: 'Tags',
    },
    collections: {
        backgroundColor: '#e8f5e9',
        borderColor: '#4caf50',
        icon: '📁',
        label: 'Collections',
    },
    notes: {
        backgroundColor: '#fffde7',
        borderColor: '#ffeb3b',
        icon: '📝',
        label: 'Notes',
    },
    attachments: {
        backgroundColor: '#fce4ec',
        borderColor: '#e91e63',
        icon: '📎',
        label: 'Attachments',
    },
    images: {
        backgroundColor: '#e1f5fe',
        borderColor: '#03a9f4',
        icon: '🖼️',
        label: 'Images',
    },
};
