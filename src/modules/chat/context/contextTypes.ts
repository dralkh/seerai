/**
 * Context Types for Unified Context Management
 * Handles papers, tags, authors, collections, topics, and tables
 */

export type ContextItemType = 'paper' | 'tag' | 'author' | 'collection' | 'topic' | 'table';
export type ContextSource = 'toolbar' | 'selection' | 'command';

/**
 * Represents a single context item
 */
export interface ContextItem {
    /** Unique identifier (Zotero item ID, tag name, etc.) */
    id: string | number;

    /** Type of context item */
    type: ContextItemType;

    /** Display name (truncated if needed) */
    displayName: string;

    /** Full name for tooltips and lookups */
    fullName?: string;

    /** Command trigger character (/, ~, @, ^, #, $) */
    trigger: string;

    /** How this item was added */
    source: ContextSource;

    /** Additional metadata for content fetching */
    metadata?: {
        itemKey?: string;
        itemType?: string;
        libraryID?: number;
        creatorType?: string;
        collectionKey?: string;
        tableId?: string;
    };
}

/**
 * Trigger character to type mapping
 */
export const CONTEXT_TRIGGERS: Record<string, ContextItemType> = {
    '/': 'paper',
    '~': 'tag',
    '@': 'author',
    '^': 'collection',
    '#': 'topic',
    '$': 'table',
};

/**
 * Type to icon mapping for UI display
 */
export const CONTEXT_ICONS: Record<ContextItemType, string> = {
    paper: '📄',
    tag: '🏷️',
    author: '👤',
    collection: '📁',
    topic: '#',
    table: '📊',
};

/**
 * Type to color mapping for chips
 */
export const CONTEXT_COLORS: Record<ContextItemType, string> = {
    paper: '#007AFF',     // Blue
    tag: '#34C759',       // Green
    author: '#FF9500',    // Orange
    collection: '#5856D6', // Purple
    topic: '#FF2D55',     // Pink
    table: '#00C7BE',     // Teal
};

/**
 * Content priority hierarchy for fetching paper content
 */
export enum ContentPriority {
    NOTES = 1,          // All notes + OCR title note
    INDEXED_PDF = 2,    // Indexed PDF text
    METADATA = 3,       // Fallback to metadata only
}
