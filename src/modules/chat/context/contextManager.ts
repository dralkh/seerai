
import { ContextItem, ContextItemType, ContextSource, CONTEXT_TRIGGERS, ContentPriority } from './contextTypes';

/**
 * Manages the unified context state for the chat interface.
 * Handles adding/removing items from various sources (toolbar, selection, commands).
 */
export class ChatContextManager {
    private static instance: ChatContextManager;
    private items: ContextItem[] = [];
    private listeners: ((items: ContextItem[]) => void)[] = [];
    private isLocked: boolean = false; // "Lock" mode prevents auto-selection changes

    private constructor() { }

    /**
     * Get the singleton instance
     */
    public static getInstance(): ChatContextManager {
        if (!ChatContextManager.instance) {
            ChatContextManager.instance = new ChatContextManager();
        }
        return ChatContextManager.instance;
    }

    /**
     * Get all current context items
     */
    public getItems(): ContextItem[] {
        return [...this.items];
    }

    /**
     * Set lock state (prevents auto-selection updates)
     */
    public setLock(locked: boolean): void {
        this.isLocked = locked;
    }

    public isContextLocked(): boolean {
        return this.isLocked;
    }

    /**
     * Add a single item to context
     */
    public addItem(
        id: string | number,
        type: ContextItemType,
        displayName: string,
        source: ContextSource,
        metadata?: ContextItem['metadata']
    ): void {
        // Prevent duplicates
        if (this.items.some(item => item.id === id && item.type === type)) {
            return;
        }

        const trigger = Object.keys(CONTEXT_TRIGGERS).find(k => CONTEXT_TRIGGERS[k] === type) || '?';

        const newItem: ContextItem = {
            id,
            type,
            displayName,
            fullName: displayName,
            trigger,
            source,
            metadata
        };

        this.items.push(newItem);
        this.notifyListeners();

        Zotero.debug(`[seerai] Context added: ${trigger}${displayName} (${source})`);
    }

    /**
     * Remove an item by ID and type
     */
    public removeItem(id: string | number, type: ContextItemType): void {
        const initialLength = this.items.length;
        this.items = this.items.filter(item => !(item.id === id && item.type === type));

        if (this.items.length !== initialLength) {
            this.notifyListeners();
            Zotero.debug(`[seerai] Context removed: ${type}:${id}`);
        }
    }

    /**
     * Remove item at specific index (for UI removal)
     */
    public removeAtIndex(index: number): void {
        if (index >= 0 && index < this.items.length) {
            this.items.splice(index, 1);
            this.notifyListeners();
        }
    }

    /**
     * Clear all context items
     */
    public clearAll(): void {
        if (this.items.length > 0) {
            this.items = [];
            this.notifyListeners();
            Zotero.debug(`[seerai] Context cleared`);
        }
    }

    /**
     * Sync context with current Zotero selection (for Explore/Focus mode)
     * Respects lock state.
     */
    public syncFromSelection(items: Zotero.Item[]): void {
        if (this.isLocked) return;

        // In Focus mode, typically we replace previous "selection" items but keep "command"/"toolbar" items?
        // Or for simplicity, if not locked, selection replaces everything? 
        // Let's go with: Selection replaces previous SELECTION-sourced items, keeps others.
        // Actually, "Focus" mode usually implies "this is what I'm looking at".
        // Let's implement: Filter out previous 'selection' items, add new ones.

        const nonSelectionItems = this.items.filter(item => item.source !== 'selection');
        const newSelectionItems: ContextItem[] = [];

        items.forEach(item => {
            // Skip if strictly not a regular item (e.g. note/attachment handling logic might be needed)
            // For now assume top-level items or items with metadata
            if (item.isNote() || item.isAttachment()) {
                // Option: resolve parent? For now, include as is or skip depending on requirements.
                // Let's include them as 'paper' (generic item) or check specifics
            }

            const title = item.getField('title') || `Item ${item.id}`;
            newSelectionItems.push({
                id: item.id,
                type: 'paper',
                displayName: title,
                fullName: title,
                trigger: '/',
                source: 'selection',
                metadata: {
                    itemKey: item.key,
                    itemType: item.itemType,
                    libraryID: item.libraryID
                }
            });
        });

        this.items = [...nonSelectionItems, ...newSelectionItems];
        this.notifyListeners();
    }

    /**
     * Add listener for context changes
     */
    public addListener(listener: (items: ContextItem[]) => void): void {
        this.listeners.push(listener);
        // Immediately notify with current state
        listener(this.items);
    }

    /**
     * Remove listener
     */
    public removeListener(listener: (items: ContextItem[]) => void): void {
        this.listeners = this.listeners.filter(l => l !== listener);
    }

    private notifyListeners(): void {
        this.listeners.forEach(listener => listener(this.getItems()));
    }
}
