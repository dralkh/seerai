/**
 * State manager for AI Chat multi-selection system
 * Manages the selection state and compiles context for AI prompts
 */

import {
    ChatStates,
    defaultChatStates,
    StateName,
    Selection,
    SelectedItem,
    SelectedCreator,
    SelectedTag,
    SelectedCollection,
    SelectedNote,
    SelectedAttachment,
    ChatOptions,
    defaultChatOptions,
} from './types';

export class ChatStateManager {
    private states: ChatStates;
    private options: ChatOptions;
    private listeners: Set<(states: ChatStates) => void>;

    constructor(
        initialStates: ChatStates = defaultChatStates,
        initialOptions: ChatOptions = defaultChatOptions
    ) {
        // Create deep copy of initial states to avoid mutation of defaults
        this.states = {
            items: [...initialStates.items],
            creators: [...initialStates.creators],
            tags: [...initialStates.tags],
            collections: [...initialStates.collections],
            notes: [...initialStates.notes],
            attachments: [...initialStates.attachments],
            images: [...(initialStates.images || [])],
        };
        this.options = { ...initialOptions };
        this.listeners = new Set();
    }

    // Subscribe to state changes
    subscribe(listener: (states: ChatStates) => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    private notify(): void {
        this.listeners.forEach(listener => listener(this.getStates()));
    }

    // Get current states (immutable copy)
    getStates(): ChatStates {
        return {
            items: [...this.states.items],
            creators: [...this.states.creators],
            tags: [...this.states.tags],
            collections: [...this.states.collections],
            notes: [...this.states.notes],
            attachments: [...this.states.attachments],
            images: [...this.states.images],
        };
    }

    // Get options
    getOptions(): ChatOptions {
        return { ...this.options };
    }

    // Set options
    setOptions(options: Partial<ChatOptions>): void {
        this.options = { ...this.options, ...options };
    }

    // Add a selection
    addSelection<T extends StateName>(type: T, selection: ChatStates[T][number]): boolean {
        const existing = this.states[type].find(s => s.id === selection.id);
        if (existing) {
            return false; // Already exists
        }

        // Use type assertion to handle the union type correctly
        const arr = this.states[type] as Selection[];
        arr.push(selection as Selection);
        this.notify();
        return true;
    }

    // Add multiple selections
    addSelections<T extends StateName>(type: T, selections: ChatStates[T]): number {
        let added = 0;
        for (const selection of selections) {
            if (this.addSelection(type, selection)) {
                added++;
            }
        }
        return added;
    }

    // Remove a selection by ID
    removeSelection(type: StateName, id: number | string): boolean {
        const index = this.states[type].findIndex(s => s.id === id);
        if (index === -1) {
            return false;
        }

        this.states[type].splice(index, 1);
        this.notify();
        return true;
    }

    // Clear selections of a specific type
    clearSelections(type: StateName): void {
        this.states[type] = [];
        this.notify();
    }

    // Clear all selections
    clearAll(): void {
        this.states = {
            items: [],
            creators: [],
            tags: [],
            collections: [],
            notes: [],
            attachments: [],
            images: [],
        };
        this.notify();
    }

    // Check if any selections exist
    hasSelections(): boolean {
        return Object.values(this.states).some(arr => arr.length > 0);
    }

    // Get total selection count
    getSelectionCount(): number {
        return Object.values(this.states).reduce((sum, arr) => sum + arr.length, 0);
    }

    // Get count by type
    getCountByType(type: StateName): number {
        return this.states[type].length;
    }

    // Check if a specific item is selected
    isSelected(type: StateName, id: number | string): boolean {
        return this.states[type].some(s => s.id === id);
    }

    // Toggle selection
    toggleSelection<T extends StateName>(type: T, selection: ChatStates[T][number]): boolean {
        if (this.isSelected(type, selection.id)) {
            this.removeSelection(type, selection.id);
            return false;
        } else {
            this.addSelection(type, selection);
            return true;
        }
    }

    /**
     * Compile all selections into a context string for AI prompts
     */
    async compileContext(): Promise<string> {
        const contextParts: string[] = [];

        // Add items context
        if (this.states.items.length > 0) {
            contextParts.push('=== Selected Papers/Items ===');
            for (const item of this.states.items) {
                let itemContext = `\n--- ${item.title} ---`;
                if (item.year) {
                    itemContext += ` (${item.year})`;
                }
                if (item.creators && item.creators.length > 0) {
                    itemContext += `\nAuthors: ${item.creators.join(', ')}`;
                }
                if (this.options.includeAbstracts && item.abstract) {
                    itemContext += `\nAbstract: ${item.abstract}`;
                }
                contextParts.push(itemContext);
            }
        }

        // Add collections context
        if (this.states.collections.length > 0) {
            contextParts.push('\n=== Selected Collections ===');
            for (const collection of this.states.collections) {
                contextParts.push(`- ${collection.title}${collection.itemCount ? ` (${collection.itemCount} items)` : ''}`);
            }
        }

        // Add creators context
        if (this.states.creators.length > 0) {
            contextParts.push('\n=== Selected Creators ===');
            contextParts.push(this.states.creators.map(c => c.title).join(', '));
        }

        // Add tags context
        if (this.states.tags.length > 0) {
            contextParts.push('\n=== Selected Tags ===');
            contextParts.push(this.states.tags.map(t => t.title).join(', '));
        }

        // Add notes context (if enabled)
        if (this.options.includeNotes && this.states.notes.length > 0) {
            contextParts.push('\n=== Notes ===');
            for (const note of this.states.notes) {
                contextParts.push(`\n--- Note: ${note.title} ---`);
                contextParts.push(note.content);
            }
        }

        // Add attachments context (for OCR text)
        if (this.options.includeFullText && this.states.attachments.length > 0) {
            contextParts.push('\n=== Attachments with Text ===');
            for (const attachment of this.states.attachments) {
                contextParts.push(`- ${attachment.filename}`);
            }
        }

        return contextParts.join('\n');
    }

    /**
     * Create a summary of current selections for display
     */
    getSummary(): string {
        const parts: string[] = [];

        if (this.states.items.length > 0) {
            parts.push(`${this.states.items.length} item(s)`);
        }
        if (this.states.notes.length > 0) {
            parts.push(`${this.states.notes.length} note(s)`);
        }
        if (this.states.collections.length > 0) {
            parts.push(`${this.states.collections.length} collection(s)`);
        }
        if (this.states.creators.length > 0) {
            parts.push(`${this.states.creators.length} creator(s)`);
        }
        if (this.states.tags.length > 0) {
            parts.push(`${this.states.tags.length} tag(s)`);
        }

        return parts.length > 0 ? parts.join(', ') : 'No selections';
    }

    /**
     * Export state for persistence
     */
    toJSON(): { states: ChatStates; options: ChatOptions } {
        return {
            states: this.getStates(),
            options: this.getOptions(),
        };
    }

    /**
     * Import state from persistence
     */
    fromJSON(data: { states?: Partial<ChatStates>; options?: Partial<ChatOptions> }): void {
        if (data.states) {
            this.states = {
                ...defaultChatStates,
                ...data.states,
            };
        }
        if (data.options) {
            this.options = {
                ...defaultChatOptions,
                ...data.options,
            };
        }
        this.notify();
    }
}

// Singleton instance for global access
let globalStateManager: ChatStateManager | null = null;

export function getChatStateManager(): ChatStateManager {
    if (!globalStateManager) {
        globalStateManager = new ChatStateManager();
    }
    return globalStateManager;
}

export function resetChatStateManager(): void {
    globalStateManager = null;
}
