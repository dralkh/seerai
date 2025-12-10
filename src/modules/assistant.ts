import { openAIService, OpenAIMessage, VisionMessage, VisionMessageContentPart } from "./openai";
import { config } from "../../package.json";
import { getChatStateManager, resetChatStateManager } from "./chat/stateManager";
import { SelectedItem, SelectedNote, ChatMessage, selectionConfigs, AIModelConfig } from "./chat/types";
import { getModelConfigs, getActiveModelConfig, setActiveModelId, hasModelConfigs } from "./chat/modelConfig";
import { parseMarkdown } from "./chat/markdown";
import { getMessageStore } from "./chat/messageStore";
import { createImageContentParts, countImageAttachments } from "./chat/imageUtils";

// Stored messages for conversation continuity (loaded from persistence)
let conversationMessages: ChatMessage[] = [];

// Track the current item ID to detect navigation
let currentItemId: number | null = null;

// Store container reference for re-rendering
let currentContainer: HTMLElement | null = null;
let currentItem: Zotero.Item | null = null;

export class Assistant {
    // UI state
    private static isStreaming: boolean = false;

    static register() {
        Zotero.ItemPaneManager.registerSection({
            paneID: "smart-assistant",
            pluginID: config.addonID,
            header: {
                l10nID: "assistant-header-label",
                icon: `chrome://${config.addonRef}/content/icons/icon-16.png`,
            },
            sidenav: {
                l10nID: "assistant-sidenav-tooltip",
                icon: `chrome://${config.addonRef}/content/icons/icon-20.png`,
            },
            onRender: ({ body, item, setSectionSummary }) => {
                // Update current item tracking (no longer resets state on navigation)
                // This allows multi-selection to persist across item changes
                currentItemId = item.id;
                currentContainer = body;
                currentItem = item;

                this.renderInterface(body, item);
                const stateManager = getChatStateManager();
                setSectionSummary(stateManager.getSummary());
            },
        });
    }

    /**
     * Re-render just the selection area (for efficient updates)
     */
    private static reRenderSelectionArea() {
        if (!currentContainer || !currentItem) return;

        const selectionArea = currentContainer.querySelector('#selection-area');
        if (selectionArea) {
            const doc = currentContainer.ownerDocument!;
            const stateManager = getChatStateManager();
            const newSelectionArea = this.createSelectionArea(doc, stateManager);
            selectionArea.replaceWith(newSelectionArea);
        }
    }

    /**
     * Convert Zotero item to SelectedItem format
     */
    private static itemToSelection(item: Zotero.Item): SelectedItem {
        const creators = item.getCreators().map(c => `${c.firstName || ''} ${c.lastName || ''}`.trim());
        return {
            id: item.id,
            type: (item.itemType as SelectedItem['type']) || 'other',
            title: item.getField("title") as string || "Untitled",
            abstract: item.getField("abstractNote") as string || undefined,
            creators,
            year: item.getField("year") as string || undefined,
        };
    }

    /**
     * Get ALL notes from a Zotero item as SelectedNote objects
     */
    private static async getItemNotesAsSelections(item: Zotero.Item): Promise<SelectedNote[]> {
        const notes: SelectedNote[] = [];

        let targetItem = item;
        if (item.isAttachment() && item.parentID) {
            const parent = Zotero.Items.get(item.parentID);
            if (parent) targetItem = parent as Zotero.Item;
        }

        if (!targetItem.isRegularItem()) return notes;

        const noteIDs = targetItem.getNotes();
        for (const id of noteIDs) {
            const noteItem = Zotero.Items.get(id);
            if (noteItem) {
                const noteHTML = noteItem.getNote();
                const plainText = this.stripHtml(noteHTML);
                if (plainText.trim()) {
                    notes.push({
                        id: noteItem.id,
                        type: 'note',
                        title: `Note: ${(targetItem.getField("title") as string || "").slice(0, 30)}...`,
                        parentItemId: targetItem.id,
                        content: plainText.trim(),
                        dateModified: noteItem.dateModified,
                    });
                }
            }
        }
        return notes;
    }

    /**
     * Strips HTML tags from a string to get plain text
     */
    private static stripHtml(html: string): string {
        const temp = new DOMParser().parseFromString(html, "text/html");
        return temp.body?.textContent || "";
    }

    /**
     * Add an item and its notes to the selection
     */
    private static async addItemWithNotes(item: Zotero.Item) {
        const stateManager = getChatStateManager();

        // Add the item itself
        const selection = this.itemToSelection(item);
        stateManager.addSelection('items', selection);

        // Auto-fetch and add all notes from this item
        const notes = await this.getItemNotesAsSelections(item);
        for (const note of notes) {
            stateManager.addSelection('notes', note);
        }

        // Re-render selection area
        this.reRenderSelectionArea();
    }

    /**
     * Remove an item and its associated notes
     */
    private static removeItemWithNotes(itemId: number) {
        const stateManager = getChatStateManager();

        // Remove any notes that belong to this item
        const states = stateManager.getStates();
        const notesToRemove = states.notes.filter(n => n.parentItemId === itemId);
        for (const note of notesToRemove) {
            stateManager.removeSelection('notes', note.id);
        }

        // Remove the item
        stateManager.removeSelection('items', itemId);

        // Re-render selection area
        this.reRenderSelectionArea();
    }

    /**
     * Main interface renderer
     */
    private static async renderInterface(container: HTMLElement, item: Zotero.Item) {
        container.innerHTML = "";
        const doc = container.ownerDocument!;
        const stateManager = getChatStateManager();

        // Load persisted messages if not already loaded
        if (conversationMessages.length === 0) {
            try {
                const messageStore = getMessageStore();
                conversationMessages = await messageStore.loadMessages();
                Zotero.debug(`[Seer AI] Loaded ${conversationMessages.length} messages from storage`);
            } catch (e) {
                Zotero.debug(`[Seer AI] Error loading messages, starting fresh: ${e}`);
                conversationMessages = [];  // Start fresh on error
            }
        }

        // Auto-add current item with its notes if not already selected
        if (!stateManager.isSelected('items', item.id)) {
            // Use async but don't await - will re-render when done
            this.addItemWithNotes(item);
        }

        // Main Chat Container
        const chatContainer = ztoolkit.UI.createElement(doc, "div", {
            styles: {
                display: "flex",
                flexDirection: "column",
                height: "100%",
                minHeight: "350px",
                gap: "8px",
                padding: "8px",
                fontFamily: "system-ui, -apple-system, sans-serif"
            }
        });

        // === SELECTION AREA ===
        const selectionArea = this.createSelectionArea(doc, stateManager);

        // === CONTROLS BAR ===
        const controlsBar = this.createControlsBar(doc, container);

        // === MESSAGES AREA ===
        const messagesArea = ztoolkit.UI.createElement(doc, "div", {
            styles: {
                flex: "1",
                overflowY: "auto",
                border: "1px solid #ddd",
                borderRadius: "6px",
                padding: "10px",
                backgroundColor: "#fafafa",
                display: "flex",
                flexDirection: "column",
                gap: "10px",
                minHeight: "150px"
            },
            properties: { id: "assistant-messages-area" }
        }) as HTMLElement;

        // Restore previous messages
        const lastUserMsgIndex = conversationMessages.map(m => m.role).lastIndexOf('user');
        conversationMessages.forEach((msg, idx) => {
            const isLastUserMsg = msg.role === 'user' && idx === lastUserMsgIndex;
            this.renderStoredMessage(messagesArea, msg, isLastUserMsg);
        });

        // === INPUT AREA ===
        const inputArea = this.createInputArea(doc, messagesArea, stateManager);

        // Assemble
        chatContainer.appendChild(selectionArea);
        chatContainer.appendChild(controlsBar);
        chatContainer.appendChild(messagesArea);
        chatContainer.appendChild(inputArea);
        container.appendChild(chatContainer);
    }

    /**
     * Create the selection chips area
     */
    private static createSelectionArea(doc: Document, stateManager: ReturnType<typeof getChatStateManager>): HTMLElement {
        const selectionArea = ztoolkit.UI.createElement(doc, "div", {
            properties: { id: "selection-area" },
            styles: {
                display: "flex",
                flexWrap: "wrap",
                gap: "6px",
                padding: "8px",
                backgroundColor: "#f5f5f5",
                borderRadius: "6px",
                minHeight: "40px",
                alignItems: "center"
            }
        });

        const states = stateManager.getStates();

        // Label
        if (states.items.length > 0 || states.notes.length > 0) {
            const label = ztoolkit.UI.createElement(doc, "span", {
                properties: { innerText: "Context:" },
                styles: { fontSize: "11px", color: "#666", marginRight: "4px", fontWeight: "600" }
            });
            selectionArea.appendChild(label);
        }

        // Render item chips
        states.items.forEach(item => {
            const chip = this.createChip(doc, item.title, selectionConfigs.items, () => {
                this.removeItemWithNotes(item.id);
            });
            selectionArea.appendChild(chip);
        });

        // Render note chips (show count instead of individual notes if many)
        if (states.notes.length > 3) {
            const notesSummary = ztoolkit.UI.createElement(doc, "div", {
                styles: {
                    display: "inline-flex",
                    alignItems: "center",
                    padding: "3px 8px",
                    backgroundColor: selectionConfigs.notes.backgroundColor,
                    border: `1px solid ${selectionConfigs.notes.borderColor}`,
                    borderRadius: "12px",
                    fontSize: "11px"
                },
                properties: { innerText: `📝 ${states.notes.length} notes included` }
            });
            selectionArea.appendChild(notesSummary);
        } else {
            states.notes.forEach(note => {
                const chip = this.createChip(doc, note.title, selectionConfigs.notes, () => {
                    stateManager.removeSelection('notes', note.id);
                    this.reRenderSelectionArea();
                });
                selectionArea.appendChild(chip);
            });
        }

        // Add Papers button - opens searchable paper picker
        const addBtn = ztoolkit.UI.createElement(doc, "button", {
            properties: { innerText: "📄 Add Papers" },
            styles: {
                padding: "4px 10px",
                fontSize: "11px",
                border: "1px dashed #2196f3",
                borderRadius: "4px",
                backgroundColor: "transparent",
                cursor: "pointer",
                color: "#1565c0"
            },
            listeners: [{
                type: "click",
                listener: () => {
                    Zotero.debug("[Seer AI] Add Papers button clicked");
                    this.showPaperPicker(doc, stateManager);
                }
            }]
        });
        selectionArea.appendChild(addBtn);

        // Add by Tag button
        const addByTagBtn = ztoolkit.UI.createElement(doc, "button", {
            properties: { innerText: "🏷️ Add by Tag" },
            styles: {
                padding: "4px 10px",
                fontSize: "11px",
                border: "1px dashed #ff9800",
                borderRadius: "4px",
                backgroundColor: "transparent",
                cursor: "pointer",
                color: "#e65100"
            },
            listeners: [{
                type: "click",
                listener: () => {
                    Zotero.debug("[Seer AI] Add by Tag button clicked");
                    this.showTagPicker(doc, stateManager);
                }
            }]
        });
        selectionArea.appendChild(addByTagBtn);

        // Render tag chips (if any selected)
        if (states.tags.length > 0) {
            states.tags.forEach(tag => {
                const chip = this.createChip(doc, tag.title, selectionConfigs.tags, () => {
                    stateManager.removeSelection('tags', tag.id);
                    this.reRenderSelectionArea();
                });
                selectionArea.appendChild(chip);
            });
        }

        // Clear all button (if more than 1 item)
        if (states.items.length > 1 || states.tags.length > 0) {
            const clearAllBtn = ztoolkit.UI.createElement(doc, "button", {
                properties: { innerText: "✕ Clear All" },
                styles: {
                    padding: "4px 8px",
                    fontSize: "10px",
                    border: "none",
                    borderRadius: "4px",
                    backgroundColor: "#ffebee",
                    cursor: "pointer",
                    color: "#c62828"
                },
                listeners: [{
                    type: "click",
                    listener: async () => {
                        stateManager.clearAll();
                        // Re-add current item and re-render
                        if (currentItem) {
                            await this.addItemWithNotes(currentItem);
                        }
                    }
                }]
            });
            selectionArea.appendChild(clearAllBtn);
        }

        return selectionArea;
    }

    /**
     * Show tag picker dialog with optional collection filtering
     */
    private static async showTagPicker(doc: Document, stateManager: ReturnType<typeof getChatStateManager>) {
        // Remove existing picker if any
        const existing = doc.getElementById("tag-picker-dialog");
        if (existing) {
            existing.remove();
            return;
        }

        // Get all collections for the filter dropdown
        const allCollections = await this.getAllCollections();
        const libraries = Zotero.Libraries.getAll();

        // Track selected collection/library filter
        let selectedCollectionId: number | null = null;
        let selectedLibraryId: number | null = null;

        // Function to get tags based on current filter
        const getFilteredTags = async (): Promise<{ tag: string }[]> => {
            const tags: { tag: string }[] = [];

            if (selectedCollectionId !== null) {
                // Get tags only from items in the selected collection
                try {
                    const collection = Zotero.Collections.get(selectedCollectionId);
                    if (collection) {
                        const itemIDs = collection.getChildItems(true);
                        const tagSet = new Set<string>();
                        for (const itemId of itemIDs) {
                            const item = Zotero.Items.get(itemId);
                            if (item && item.isRegularItem()) {
                                const itemTags = item.getTags();
                                for (const t of itemTags) {
                                    tagSet.add(t.tag);
                                }
                            }
                        }
                        for (const tag of tagSet) {
                            tags.push({ tag });
                        }
                    }
                } catch (e) {
                    Zotero.debug(`[Seer AI] Error loading tags from collection: ${e}`);
                }
            } else if (selectedLibraryId !== null) {
                // Get tags from a specific library
                try {
                    const libraryTags = await Zotero.Tags.getAll(selectedLibraryId);
                    if (libraryTags && libraryTags.length > 0) {
                        for (const t of libraryTags) {
                            if (!tags.some(existing => existing.tag === t.tag)) {
                                tags.push({ tag: t.tag });
                            }
                        }
                    }
                } catch (e) {
                    Zotero.debug(`[Seer AI] Error loading tags from library: ${e}`);
                }
            } else {
                // Get all tags from all libraries (default)
                for (const library of libraries) {
                    try {
                        const libraryTags = await Zotero.Tags.getAll(library.libraryID);
                        if (libraryTags && libraryTags.length > 0) {
                            for (const t of libraryTags) {
                                if (!tags.some(existing => existing.tag === t.tag)) {
                                    tags.push({ tag: t.tag });
                                }
                            }
                        }
                    } catch (e) {
                        Zotero.debug(`[Seer AI] Error loading tags from library ${library.name}: ${e}`);
                    }
                }
            }

            return tags.sort((a, b) => a.tag.localeCompare(b.tag));
        };

        // Initial tag load
        let allTags = await getFilteredTags();

        if (allTags.length === 0 && selectedCollectionId === null && selectedLibraryId === null) {
            Zotero.debug("[Seer AI] No tags found in any library");
            return;
        }

        // Create modal dialog
        const overlay = ztoolkit.UI.createElement(doc, "div", {
            properties: { id: "tag-picker-dialog" },
            styles: {
                position: "fixed",
                top: "0",
                left: "0",
                width: "100%",
                height: "100%",
                backgroundColor: "rgba(0,0,0,0.5)",
                display: "flex",
                justifyContent: "center",
                alignItems: "center",
                zIndex: "10000"
            }
        });

        const dialog = ztoolkit.UI.createElement(doc, "div", {
            styles: {
                backgroundColor: "#fff",
                borderRadius: "12px",
                padding: "20px",
                maxWidth: "450px",
                width: "90%",
                maxHeight: "80vh",
                display: "flex",
                flexDirection: "column",
                gap: "12px",
                boxShadow: "0 8px 32px rgba(0,0,0,0.2)"
            }
        });

        // Title
        const title = ztoolkit.UI.createElement(doc, "div", {
            properties: { innerText: "🏷️ Select Tags" },
            styles: { fontSize: "16px", fontWeight: "600", marginBottom: "4px" }
        });

        // Collection filter dropdown
        const filterContainer = ztoolkit.UI.createElement(doc, "div", {
            styles: {
                display: "flex",
                flexDirection: "column",
                gap: "4px",
                marginBottom: "8px"
            }
        });

        const filterLabel = ztoolkit.UI.createElement(doc, "label", {
            properties: { innerText: "📁 Filter by collection:" },
            styles: { fontSize: "12px", color: "#666" }
        });

        const filterSelect = ztoolkit.UI.createElement(doc, "select", {
            styles: {
                padding: "8px 12px",
                border: "1px solid #ddd",
                borderRadius: "6px",
                fontSize: "13px",
                backgroundColor: "#fff",
                cursor: "pointer"
            }
        }) as HTMLSelectElement;

        // Add "All Libraries" option
        const allOption = ztoolkit.UI.createElement(doc, "option", {
            properties: { value: "all", innerText: "All Libraries" }
        });
        filterSelect.appendChild(allOption);

        // Add library options with their collections
        for (const library of libraries) {
            // Library option
            const libOption = ztoolkit.UI.createElement(doc, "option", {
                properties: {
                    value: `lib_${library.libraryID}`,
                    innerText: `📚 ${library.name}`
                }
            });
            filterSelect.appendChild(libOption);

            // Collection options for this library
            const libraryCollections = allCollections.filter(c => c.libraryId === library.libraryID);
            for (const col of libraryCollections) {
                const indent = "    ".repeat(col.depth + 1);
                const colOption = ztoolkit.UI.createElement(doc, "option", {
                    properties: {
                        value: `col_${col.id}`,
                        innerText: `${indent}📁 ${col.name}`
                    }
                });
                filterSelect.appendChild(colOption);
            }
        }

        filterContainer.appendChild(filterLabel);
        filterContainer.appendChild(filterSelect);

        // Search input
        const searchInput = ztoolkit.UI.createElement(doc, "input", {
            attributes: { type: "text", placeholder: "Search tags..." },
            styles: {
                padding: "8px 12px",
                border: "1px solid #ddd",
                borderRadius: "6px",
                fontSize: "13px"
            }
        }) as HTMLInputElement;

        // Tag list container
        const tagList = ztoolkit.UI.createElement(doc, "div", {
            styles: {
                maxHeight: "280px",
                overflowY: "auto",
                display: "flex",
                flexDirection: "column",
                gap: "4px"
            }
        });

        // Selected tags tracker
        const selectedTags: Set<string> = new Set();

        // Render tag options
        const renderTags = (filter: string = "") => {
            tagList.innerHTML = "";

            if (allTags.length === 0) {
                const noTags = ztoolkit.UI.createElement(doc, "div", {
                    properties: { innerText: "No tags found in selected scope" },
                    styles: { padding: "12px", color: "#666", textAlign: "center" }
                });
                tagList.appendChild(noTags);
                return;
            }

            const filteredTags = allTags
                .filter((t: { tag: string }) => t.tag.toLowerCase().includes(filter.toLowerCase()))
                .slice(0, 50); // Limit to 50 for performance

            if (filteredTags.length === 0) {
                const noResults = ztoolkit.UI.createElement(doc, "div", {
                    properties: { innerText: filter ? "No tags match your search" : "No tags available" },
                    styles: { padding: "12px", color: "#666", textAlign: "center" }
                });
                tagList.appendChild(noResults);
                return;
            }

            filteredTags.forEach((tagData: { tag: string }) => {
                const tagName = tagData.tag;
                const isChecked = selectedTags.has(tagName);

                const tagRow = ztoolkit.UI.createElement(doc, "label", {
                    styles: {
                        display: "flex",
                        alignItems: "center",
                        gap: "8px",
                        padding: "6px 8px",
                        borderRadius: "4px",
                        cursor: "pointer",
                        backgroundColor: isChecked ? "#fff3e0" : "transparent"
                    }
                });

                const checkbox = ztoolkit.UI.createElement(doc, "input", {
                    attributes: { type: "checkbox" }
                }) as HTMLInputElement;
                checkbox.checked = isChecked;

                checkbox.addEventListener("change", () => {
                    if (checkbox.checked) {
                        selectedTags.add(tagName);
                        tagRow.style.backgroundColor = "#fff3e0";
                    } else {
                        selectedTags.delete(tagName);
                        tagRow.style.backgroundColor = "transparent";
                    }
                });

                const label = ztoolkit.UI.createElement(doc, "span", {
                    properties: { innerText: tagName },
                    styles: { fontSize: "13px" }
                });

                tagRow.appendChild(checkbox);
                tagRow.appendChild(label);
                tagList.appendChild(tagRow);
            });

            // Show count
            const countEl = ztoolkit.UI.createElement(doc, "div", {
                properties: { innerText: `Showing ${filteredTags.length} of ${allTags.length} tags` },
                styles: { fontSize: "11px", color: "#888", padding: "8px", textAlign: "center" }
            });
            tagList.appendChild(countEl);
        };

        renderTags();

        // Filter change event
        filterSelect.addEventListener("change", async () => {
            const value = filterSelect.value;
            if (value === "all") {
                selectedCollectionId = null;
                selectedLibraryId = null;
            } else if (value.startsWith("lib_")) {
                selectedCollectionId = null;
                selectedLibraryId = parseInt(value.replace("lib_", ""), 10);
            } else if (value.startsWith("col_")) {
                selectedCollectionId = parseInt(value.replace("col_", ""), 10);
                selectedLibraryId = null;
            }

            // Reload tags for new filter
            allTags = await getFilteredTags();
            renderTags(searchInput.value);
        });

        // Search event
        searchInput.addEventListener("input", () => {
            renderTags(searchInput.value);
        });

        // Button row
        const buttonRow = ztoolkit.UI.createElement(doc, "div", {
            styles: { display: "flex", gap: "8px", justifyContent: "flex-end", marginTop: "8px" }
        });

        const cancelBtn = ztoolkit.UI.createElement(doc, "button", {
            properties: { innerText: "Cancel" },
            styles: {
                padding: "8px 16px",
                border: "1px solid #ddd",
                borderRadius: "6px",
                backgroundColor: "#f5f5f5",
                cursor: "pointer"
            },
            listeners: [{
                type: "click",
                listener: () => overlay.remove()
            }]
        });

        const addTagsBtn = ztoolkit.UI.createElement(doc, "button", {
            properties: { innerText: "Add Items with Tags" },
            styles: {
                padding: "8px 16px",
                border: "none",
                borderRadius: "6px",
                backgroundColor: "#ff9800",
                color: "#fff",
                cursor: "pointer",
                fontWeight: "600"
            },
            listeners: [{
                type: "click",
                listener: async () => {
                    if (selectedTags.size === 0) {
                        overlay.remove();
                        return;
                    }

                    // Add selected tags to state
                    for (const tagName of selectedTags) {
                        stateManager.addSelection('tags', {
                            id: tagName,
                            type: 'tag',
                            title: tagName
                        });
                    }

                    // Find and add all items with these tags (respecting the filter)
                    await this.addItemsByTags(Array.from(selectedTags), selectedCollectionId, selectedLibraryId);

                    overlay.remove();
                    this.reRenderSelectionArea();
                }
            }]
        });

        buttonRow.appendChild(cancelBtn);
        buttonRow.appendChild(addTagsBtn);

        dialog.appendChild(title);
        dialog.appendChild(filterContainer);
        dialog.appendChild(searchInput);
        dialog.appendChild(tagList);
        dialog.appendChild(buttonRow);
        overlay.appendChild(dialog);

        // Close on overlay click
        overlay.addEventListener("click", (e) => {
            if (e.target === overlay) overlay.remove();
        });

        // Append to documentElement (works better in Zotero's XUL context)
        const target = doc.documentElement || doc.body;
        if (target) {
            target.appendChild(overlay);
            searchInput.focus();
        } else {
            Zotero.debug("[Seer AI] Error: No valid append target for tag picker modal");
        }
    }

    /**
     * Show paper picker dialog with searchable list of library items and collection filtering
     */
    private static async showPaperPicker(doc: Document, stateManager: ReturnType<typeof getChatStateManager>) {
        // Remove existing picker if any
        const existing = doc.getElementById("paper-picker-dialog");
        if (existing) {
            existing.remove();
            return;
        }

        // Get all collections for the filter dropdown
        const allCollections = await this.getAllCollections();
        const libraries = Zotero.Libraries.getAll();

        // Track selected collection/library filter
        let selectedCollectionId: number | null = null;
        let selectedLibraryId: number | null = null;

        // Function to get items based on current filter
        const getFilteredItems = async (): Promise<{ id: number; title: string; creators: string; year: string; libraryName: string; collectionName?: string }[]> => {
            const items: { id: number; title: string; creators: string; year: string; libraryName: string; collectionName?: string }[] = [];

            const addItem = (item: Zotero.Item, libraryName: string, collectionName?: string) => {
                const creators = item.getCreators().map((c: any) => c.lastName || c.name || '').slice(0, 2).join(', ');
                items.push({
                    id: item.id,
                    title: item.getField("title") as string || "Untitled",
                    creators: creators || "Unknown",
                    year: item.getField("year") as string || "",
                    libraryName: libraryName,
                    collectionName: collectionName
                });
            };

            if (selectedCollectionId !== null) {
                // Get items from the selected collection only
                try {
                    const collection = Zotero.Collections.get(selectedCollectionId);
                    if (collection) {
                        const libraryResult = Zotero.Libraries.get(collection.libraryID);
                        const libraryName = libraryResult ? libraryResult.name : "Unknown";
                        const itemIDs = collection.getChildItems(true);
                        for (const id of itemIDs.slice(0, 500)) {
                            const item = Zotero.Items.get(id);
                            if (item && item.isRegularItem()) {
                                addItem(item, libraryName, collection.name);
                            }
                        }
                    }
                } catch (e) {
                    Zotero.debug(`[Seer AI] Error loading items from collection: ${e}`);
                }
            } else if (selectedLibraryId !== null) {
                // Get items from a specific library
                try {
                    const libraryResult = Zotero.Libraries.get(selectedLibraryId);
                    const libraryName = libraryResult ? libraryResult.name : "Unknown";
                    const search = new Zotero.Search();
                    search.addCondition('libraryID', 'is', selectedLibraryId.toString());
                    search.addCondition('itemType', 'isNot', 'attachment');
                    search.addCondition('itemType', 'isNot', 'note');
                    const itemIDs = await search.search();

                    if (itemIDs && itemIDs.length > 0) {
                        for (const id of itemIDs.slice(0, 500)) {
                            const item = Zotero.Items.get(id);
                            if (item && item.isRegularItem()) {
                                addItem(item, libraryName);
                            }
                        }
                    }
                } catch (e) {
                    Zotero.debug(`[Seer AI] Error loading items from library: ${e}`);
                }
            } else {
                // Get all items from all libraries (default)
                for (const library of libraries) {
                    try {
                        const search = new Zotero.Search();
                        search.addCondition('libraryID', 'is', library.libraryID.toString());
                        search.addCondition('itemType', 'isNot', 'attachment');
                        search.addCondition('itemType', 'isNot', 'note');
                        const itemIDs = await search.search();

                        if (itemIDs && itemIDs.length > 0) {
                            const maxPerLibrary = Math.min(itemIDs.length, Math.floor(500 / libraries.length));
                            for (const id of itemIDs.slice(0, maxPerLibrary)) {
                                const item = Zotero.Items.get(id);
                                if (item && item.isRegularItem()) {
                                    addItem(item, library.name);
                                }
                            }
                        }
                    } catch (e) {
                        Zotero.debug(`[Seer AI] Error loading items from library ${library.name}: ${e}`);
                    }
                }
            }

            return items;
        };

        // Initial item load
        let allItems = await getFilteredItems();

        if (allItems.length === 0 && selectedCollectionId === null && selectedLibraryId === null) {
            Zotero.debug("[Seer AI] No items found in any library");
            return;
        }

        // Create modal dialog
        const overlay = ztoolkit.UI.createElement(doc, "div", {
            properties: { id: "paper-picker-dialog" },
            styles: {
                position: "fixed",
                top: "0",
                left: "0",
                width: "100%",
                height: "100%",
                backgroundColor: "rgba(0,0,0,0.5)",
                display: "flex",
                justifyContent: "center",
                alignItems: "center",
                zIndex: "10000"
            }
        });

        const dialog = ztoolkit.UI.createElement(doc, "div", {
            styles: {
                backgroundColor: "#fff",
                borderRadius: "12px",
                padding: "20px",
                maxWidth: "550px",
                width: "90%",
                maxHeight: "85vh",
                display: "flex",
                flexDirection: "column",
                gap: "12px",
                boxShadow: "0 8px 32px rgba(0,0,0,0.2)"
            }
        });

        // Title
        const title = ztoolkit.UI.createElement(doc, "div", {
            properties: { innerText: "📄 Select Papers" },
            styles: { fontSize: "16px", fontWeight: "600", marginBottom: "4px" }
        });

        // Collection filter dropdown
        const filterContainer = ztoolkit.UI.createElement(doc, "div", {
            styles: {
                display: "flex",
                flexDirection: "column",
                gap: "4px",
                marginBottom: "8px"
            }
        });

        const filterLabel = ztoolkit.UI.createElement(doc, "label", {
            properties: { innerText: "📁 Filter by collection:" },
            styles: { fontSize: "12px", color: "#666" }
        });

        const filterSelect = ztoolkit.UI.createElement(doc, "select", {
            styles: {
                padding: "8px 12px",
                border: "1px solid #ddd",
                borderRadius: "6px",
                fontSize: "13px",
                backgroundColor: "#fff",
                cursor: "pointer"
            }
        }) as HTMLSelectElement;

        // Add "All Libraries" option
        const allOption = ztoolkit.UI.createElement(doc, "option", {
            properties: { value: "all", innerText: "All Libraries" }
        });
        filterSelect.appendChild(allOption);

        // Add library options with their collections
        for (const library of libraries) {
            // Library option
            const libOption = ztoolkit.UI.createElement(doc, "option", {
                properties: {
                    value: `lib_${library.libraryID}`,
                    innerText: `📚 ${library.name}`
                }
            });
            filterSelect.appendChild(libOption);

            // Collection options for this library
            const libraryCollections = allCollections.filter(c => c.libraryId === library.libraryID);
            for (const col of libraryCollections) {
                const indent = "    ".repeat(col.depth + 1);
                const colOption = ztoolkit.UI.createElement(doc, "option", {
                    properties: {
                        value: `col_${col.id}`,
                        innerText: `${indent}📁 ${col.name}`
                    }
                });
                filterSelect.appendChild(colOption);
            }
        }

        filterContainer.appendChild(filterLabel);
        filterContainer.appendChild(filterSelect);

        // Search input
        const searchInput = ztoolkit.UI.createElement(doc, "input", {
            attributes: { type: "text", placeholder: "Search by title, author, or year..." },
            styles: {
                padding: "8px 12px",
                border: "1px solid #ddd",
                borderRadius: "6px",
                fontSize: "13px"
            }
        }) as HTMLInputElement;

        // Paper list container
        const paperList = ztoolkit.UI.createElement(doc, "div", {
            styles: {
                maxHeight: "320px",
                overflowY: "auto",
                display: "flex",
                flexDirection: "column",
                gap: "4px"
            }
        });

        // Selected papers tracker
        const selectedPapers: Set<number> = new Set();

        // Render paper options
        const renderPapers = (filter: string = "") => {
            paperList.innerHTML = "";

            if (allItems.length === 0) {
                const noItems = ztoolkit.UI.createElement(doc, "div", {
                    properties: { innerText: "No papers found in selected scope" },
                    styles: { padding: "12px", color: "#666", textAlign: "center" }
                });
                paperList.appendChild(noItems);
                return;
            }

            const filterLower = filter.toLowerCase();
            const filteredItems = allItems
                .filter(item =>
                    item.title.toLowerCase().includes(filterLower) ||
                    item.creators.toLowerCase().includes(filterLower) ||
                    item.year.includes(filter)
                )
                .slice(0, 50); // Limit to 50 for performance

            if (filteredItems.length === 0) {
                const noResults = ztoolkit.UI.createElement(doc, "div", {
                    properties: { innerText: filter ? "No papers match your search" : "No papers available" },
                    styles: { padding: "12px", color: "#666", textAlign: "center" }
                });
                paperList.appendChild(noResults);
                return;
            }

            filteredItems.forEach(item => {
                const isChecked = selectedPapers.has(item.id);
                const alreadyAdded = stateManager.isSelected('items', item.id);

                const paperRow = ztoolkit.UI.createElement(doc, "label", {
                    styles: {
                        display: "flex",
                        alignItems: "flex-start",
                        gap: "8px",
                        padding: "8px",
                        borderRadius: "6px",
                        cursor: alreadyAdded ? "default" : "pointer",
                        backgroundColor: isChecked ? "#e3f2fd" : (alreadyAdded ? "#f0f0f0" : "transparent"),
                        opacity: alreadyAdded ? "0.6" : "1"
                    }
                });

                const checkbox = ztoolkit.UI.createElement(doc, "input", {
                    attributes: { type: "checkbox" }
                }) as HTMLInputElement;
                checkbox.checked = isChecked || alreadyAdded;
                checkbox.disabled = alreadyAdded;

                checkbox.addEventListener("change", () => {
                    if (alreadyAdded) return;
                    if (checkbox.checked) {
                        selectedPapers.add(item.id);
                        (paperRow as HTMLElement).style.backgroundColor = "#e3f2fd";
                    } else {
                        selectedPapers.delete(item.id);
                        (paperRow as HTMLElement).style.backgroundColor = "transparent";
                    }
                });

                const labelContent = ztoolkit.UI.createElement(doc, "div", {
                    styles: { flex: "1", overflow: "hidden" }
                });

                const titleEl = ztoolkit.UI.createElement(doc, "div", {
                    properties: { innerText: item.title.length > 60 ? item.title.slice(0, 60) + "..." : item.title },
                    styles: { fontSize: "13px", fontWeight: "500" }
                });

                // Show collection name if filtering by collection
                const metaText = item.collectionName
                    ? `${item.creators}${item.year ? ` (${item.year})` : ''} • ${item.collectionName}${alreadyAdded ? ' — already added' : ''}`
                    : `${item.creators}${item.year ? ` (${item.year})` : ''}${alreadyAdded ? ' — already added' : ''}`;

                const metaEl = ztoolkit.UI.createElement(doc, "div", {
                    properties: { innerText: metaText },
                    styles: { fontSize: "11px", color: "#666" }
                });

                labelContent.appendChild(titleEl);
                labelContent.appendChild(metaEl);
                paperRow.appendChild(checkbox);
                paperRow.appendChild(labelContent);
                paperList.appendChild(paperRow);
            });

            // Show count
            const countEl = ztoolkit.UI.createElement(doc, "div", {
                properties: { innerText: `Showing ${filteredItems.length} of ${allItems.length} papers` },
                styles: { fontSize: "11px", color: "#888", padding: "8px", textAlign: "center" }
            });
            paperList.appendChild(countEl);
        };

        renderPapers();

        // Filter change event
        filterSelect.addEventListener("change", async () => {
            const value = filterSelect.value;
            if (value === "all") {
                selectedCollectionId = null;
                selectedLibraryId = null;
            } else if (value.startsWith("lib_")) {
                selectedCollectionId = null;
                selectedLibraryId = parseInt(value.replace("lib_", ""), 10);
            } else if (value.startsWith("col_")) {
                selectedCollectionId = parseInt(value.replace("col_", ""), 10);
                selectedLibraryId = null;
            }

            // Reload items for new filter
            allItems = await getFilteredItems();
            renderPapers(searchInput.value);
        });

        // Search event
        searchInput.addEventListener("input", () => {
            renderPapers(searchInput.value);
        });

        // Button row
        const buttonRow = ztoolkit.UI.createElement(doc, "div", {
            styles: { display: "flex", gap: "8px", justifyContent: "flex-end", marginTop: "8px" }
        });

        const cancelBtn = ztoolkit.UI.createElement(doc, "button", {
            properties: { innerText: "Cancel" },
            styles: {
                padding: "8px 16px",
                border: "1px solid #ddd",
                borderRadius: "6px",
                backgroundColor: "#f5f5f5",
                cursor: "pointer"
            },
            listeners: [{
                type: "click",
                listener: () => overlay.remove()
            }]
        });

        const addPapersBtn = ztoolkit.UI.createElement(doc, "button", {
            properties: { innerText: "Add Selected Papers" },
            styles: {
                padding: "8px 16px",
                border: "none",
                borderRadius: "6px",
                backgroundColor: "#2196f3",
                color: "#fff",
                cursor: "pointer",
                fontWeight: "600"
            },
            listeners: [{
                type: "click",
                listener: async () => {
                    if (selectedPapers.size === 0) {
                        overlay.remove();
                        return;
                    }

                    // Add selected papers to state
                    for (const itemId of selectedPapers) {
                        const item = Zotero.Items.get(itemId);
                        if (item) {
                            await this.addItemWithNotes(item);
                        }
                    }

                    overlay.remove();
                    this.reRenderSelectionArea();
                    Zotero.debug(`[Seer AI] Added ${selectedPapers.size} papers from picker`);
                }
            }]
        });

        buttonRow.appendChild(cancelBtn);
        buttonRow.appendChild(addPapersBtn);

        dialog.appendChild(title);
        dialog.appendChild(filterContainer);
        dialog.appendChild(searchInput);
        dialog.appendChild(paperList);
        dialog.appendChild(buttonRow);
        overlay.appendChild(dialog);

        // Close on overlay click
        overlay.addEventListener("click", (e) => {
            if (e.target === overlay) overlay.remove();
        });

        // Append to documentElement (works better in Zotero's XUL context)
        const target = doc.documentElement || doc.body;
        if (target) {
            target.appendChild(overlay);
            searchInput.focus();
        } else {
            Zotero.debug("[Seer AI] Error: No valid append target for paper picker modal");
        }
    }

    /**
     * Add all items matching the given tags, optionally filtered by collection/library
     */
    private static async addItemsByTags(tagNames: string[], collectionId?: number | null, libraryId?: number | null) {
        let addedCount = 0;

        // If a collection is specified, get items from that collection
        if (collectionId) {
            try {
                const collection = Zotero.Collections.get(collectionId);
                if (collection) {
                    const itemIDs = collection.getChildItems(true);
                    const itemTagSet = new Set(tagNames);

                    for (const itemId of itemIDs) {
                        const item = Zotero.Items.get(itemId);
                        if (item && item.isRegularItem()) {
                            const itemTags = item.getTags().map((t: { tag: string }) => t.tag);
                            // Check if item has any of the selected tags
                            if (itemTags.some((tag: string) => itemTagSet.has(tag))) {
                                await this.addItemWithNotes(item);
                                addedCount++;
                            }
                        }
                    }
                }
            } catch (e) {
                Zotero.debug(`[Seer AI] Error adding items from collection: ${e}`);
            }
        } else {
            // Get items from specified library or all libraries
            const libraries = libraryId
                ? [{ libraryID: libraryId }]
                : Zotero.Libraries.getAll();

            for (const library of libraries) {
                for (const tagName of tagNames) {
                    // Get items with this tag
                    const tagID = Zotero.Tags.getID(tagName);
                    if (!tagID) continue;

                    const itemIDs = await Zotero.Tags.getTagItems(library.libraryID, tagID);
                    for (const itemID of itemIDs) {
                        const item = Zotero.Items.get(itemID);
                        if (item && item.isRegularItem()) {
                            await this.addItemWithNotes(item);
                            addedCount++;
                        }
                    }
                }
            }
        }

        Zotero.debug(`[Seer AI] Added ${addedCount} items from ${tagNames.length} tag(s)`);
    }

    /**
     * Add items from library selection
     */
    private static async addFromLibrarySelection() {
        const selectedItems = Zotero.getActiveZoteroPane()?.getSelectedItems() || [];

        if (selectedItems.length === 0) {
            Zotero.debug("[Seer AI] No items selected in library pane");
            return;
        }

        let added = 0;
        for (const item of selectedItems) {
            if (item.isRegularItem()) {
                await this.addItemWithNotes(item);
                added++;
            }
        }

        Zotero.debug(`[Seer AI] Added ${added} items with notes to chat context`);
    }

    /**
     * Get all collections from all libraries for filtering
     */
    private static async getAllCollections(): Promise<{ id: number; name: string; libraryName: string; libraryId: number; depth: number }[]> {
        const allCollections: { id: number; name: string; libraryName: string; libraryId: number; depth: number }[] = [];
        const libraries = Zotero.Libraries.getAll();

        for (const library of libraries) {
            try {
                const collections = Zotero.Collections.getByLibrary(library.libraryID);
                if (collections && collections.length > 0) {
                    // Build a hierarchical list with proper indentation
                    const addCollectionsRecursive = (parentId: number | null, depth: number) => {
                        for (const collection of collections) {
                            const collectionParentId = collection.parentID || null;
                            if (collectionParentId === parentId) {
                                allCollections.push({
                                    id: collection.id,
                                    name: collection.name,
                                    libraryName: library.name,
                                    libraryId: library.libraryID,
                                    depth: depth
                                });
                                // Recursively add children
                                addCollectionsRecursive(collection.id, depth + 1);
                            }
                        }
                    };
                    addCollectionsRecursive(null, 0);
                }
            } catch (e) {
                Zotero.debug(`[Seer AI] Error loading collections from library ${library.name}: ${e}`);
            }
        }

        return allCollections;
    }

    /**
     * Create a removable chip element
     */
    private static createChip(doc: Document, label: string, config: typeof selectionConfigs.items, onRemove: () => void): HTMLElement {
        const chip = ztoolkit.UI.createElement(doc, "div", {
            styles: {
                display: "inline-flex",
                alignItems: "center",
                gap: "4px",
                padding: "3px 8px",
                backgroundColor: config.backgroundColor,
                border: `1px solid ${config.borderColor}`,
                borderRadius: "12px",
                fontSize: "11px",
                maxWidth: "180px"
            }
        });

        const icon = ztoolkit.UI.createElement(doc, "span", {
            properties: { innerText: config.icon },
            styles: { fontSize: "10px" }
        });

        const displayLabel = label.length > 20 ? label.slice(0, 20) + "..." : label;
        const text = ztoolkit.UI.createElement(doc, "span", {
            properties: { innerText: displayLabel, title: label },
            styles: {
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap"
            }
        });

        const removeBtn = ztoolkit.UI.createElement(doc, "span", {
            properties: { innerText: "✕" },
            styles: {
                cursor: "pointer",
                fontSize: "10px",
                color: "#666",
                marginLeft: "2px",
                padding: "2px",
                borderRadius: "50%"
            },
            listeners: [{
                type: "click",
                listener: (e: Event) => {
                    e.stopPropagation();
                    onRemove();
                }
            }]
        });

        chip.appendChild(icon);
        chip.appendChild(text);
        chip.appendChild(removeBtn);
        return chip;
    }

    /**
     * Create the controls bar (Model Selector, Settings, Stop, Clear, Save)
     */
    private static createControlsBar(doc: Document, container: HTMLElement): HTMLElement {
        const controlsBar = ztoolkit.UI.createElement(doc, "div", {
            styles: {
                display: "flex",
                gap: "6px",
                justifyContent: "space-between",
                alignItems: "center"
            }
        });

        // Left side: Model selector
        const leftControls = ztoolkit.UI.createElement(doc, "div", {
            styles: { display: "flex", gap: "6px", alignItems: "center" }
        });

        // Model selector dropdown
        const modelSelect = ztoolkit.UI.createElement(doc, "select", {
            properties: { id: "model-selector" },
            styles: {
                padding: "4px 8px",
                fontSize: "11px",
                border: "1px solid #ddd",
                borderRadius: "4px",
                backgroundColor: "#fff",
                cursor: "pointer",
                maxWidth: "150px"
            },
            listeners: [{
                type: "change",
                listener: (e: Event) => {
                    const select = e.target as HTMLSelectElement;
                    setActiveModelId(select.value);
                    Zotero.debug(`[Seer AI] Active model changed to: ${select.value}`);
                }
            }]
        }) as HTMLSelectElement;

        // Populate model options
        this.populateModelSelector(modelSelect);

        // Settings button

        leftControls.appendChild(modelSelect);

        // Right side: Action buttons
        const rightControls = ztoolkit.UI.createElement(doc, "div", {
            styles: { display: "flex", gap: "6px" }
        });

        // Stop button
        const stopBtn = ztoolkit.UI.createElement(doc, "button", {
            properties: { innerText: "⏹ Stop", id: "stop-btn" },
            styles: {
                padding: "4px 10px",
                fontSize: "11px",
                border: "1px solid #dc3545",
                borderRadius: "4px",
                backgroundColor: "#fff",
                color: "#dc3545",
                cursor: "pointer",
                display: "none" // Hidden by default
            },
            listeners: [{
                type: "click",
                listener: () => {
                    openAIService.abortRequest();
                    this.isStreaming = false;
                    (stopBtn as HTMLElement).style.display = "none";
                }
            }]
        });

        // Clear button
        const clearBtn = ztoolkit.UI.createElement(doc, "button", {
            properties: { innerText: "🗑 Clear" },
            styles: {
                padding: "4px 10px",
                fontSize: "11px",
                border: "1px solid #6c757d",
                borderRadius: "4px",
                backgroundColor: "#fff",
                color: "#6c757d",
                cursor: "pointer"
            },
            listeners: [{
                type: "click",
                listener: async () => {
                    conversationMessages = [];
                    const messagesArea = container.querySelector("#assistant-messages-area");
                    if (messagesArea) messagesArea.innerHTML = "";

                    // Clear persistent storage
                    try {
                        await getMessageStore().clearMessages();
                    } catch (e) {
                        Zotero.debug(`[Seer AI] Error clearing message store: ${e}`);
                    }

                    Zotero.debug("[Seer AI] Chat history cleared");
                }
            }]
        });

        // Save button
        const saveBtn = ztoolkit.UI.createElement(doc, "button", {
            properties: { innerText: "💾 Save" },
            styles: {
                padding: "4px 10px",
                fontSize: "11px",
                border: "1px solid #28a745",
                borderRadius: "4px",
                backgroundColor: "#fff",
                color: "#28a745",
                cursor: "pointer"
            },
            listeners: [{
                type: "click",
                listener: async () => {
                    await this.saveConversationAsNote();
                }
            }]
        });

        rightControls.appendChild(stopBtn);
        rightControls.appendChild(clearBtn);
        rightControls.appendChild(saveBtn);

        controlsBar.appendChild(leftControls);
        controlsBar.appendChild(rightControls);
        return controlsBar;
    }

    /**
     * Populate model selector with configured models
     */
    private static populateModelSelector(select: HTMLSelectElement) {
        const doc = select.ownerDocument;
        if (!doc) return;
        select.innerHTML = "";

        const configs = getModelConfigs();
        const activeConfig = getActiveModelConfig();

        if (configs.length === 0) {
            // No custom configs - show default option
            const defaultOpt = doc.createElement("option");
            defaultOpt.value = "default";
            defaultOpt.textContent = "Default (from preferences)";
            select.appendChild(defaultOpt);
        } else {
            configs.forEach(cfg => {
                const opt = doc.createElement("option");
                opt.value = cfg.id;
                opt.textContent = cfg.name;
                if (activeConfig && cfg.id === activeConfig.id) {
                    opt.selected = true;
                }
                select.appendChild(opt);
            });
        }
    }

    /**
     * Show chat settings popover
     */
    private static showChatSettingsPopover(container: HTMLElement) {
        const doc = container.ownerDocument!;
        const stateManager = getChatStateManager();
        const options = stateManager.getOptions();

        // Remove existing popover if any
        const existing = container.querySelector("#chat-settings-popover");
        if (existing) {
            existing.remove();
            return;
        }

        const popover = ztoolkit.UI.createElement(doc, "div", {
            properties: { id: "chat-settings-popover" },
            styles: {
                position: "absolute",
                top: "80px",
                left: "10px",
                backgroundColor: "#fff",
                border: "1px solid #ddd",
                borderRadius: "8px",
                padding: "12px",
                boxShadow: "0 4px 12px rgba(0,0,0,0.15)",
                zIndex: "1000",
                minWidth: "200px"
            }
        });

        const title = ztoolkit.UI.createElement(doc, "div", {
            properties: { innerText: "Chat Settings" },
            styles: { fontWeight: "600", marginBottom: "12px", fontSize: "13px" }
        });

        // Include Notes toggle
        const notesRow = this.createToggleRow(doc, "Include Notes", options.includeNotes, (checked) => {
            stateManager.setOptions({ includeNotes: checked });
        });

        // Include Abstracts toggle
        const abstractsRow = this.createToggleRow(doc, "Include Abstracts", options.includeAbstracts, (checked) => {
            stateManager.setOptions({ includeAbstracts: checked });
        });

        // Include Images toggle (for vision models)
        const imagesRow = this.createToggleRow(doc, "Include Images (Vision)", options.includeImages, (checked) => {
            stateManager.setOptions({ includeImages: checked });
        });

        // Close button
        const closeBtn = ztoolkit.UI.createElement(doc, "button", {
            properties: { innerText: "Close" },
            styles: {
                marginTop: "12px",
                padding: "6px 12px",
                fontSize: "11px",
                border: "1px solid #ddd",
                borderRadius: "4px",
                backgroundColor: "#f5f5f5",
                cursor: "pointer",
                width: "100%"
            },
            listeners: [{
                type: "click",
                listener: () => popover.remove()
            }]
        });

        popover.appendChild(title);
        popover.appendChild(notesRow);
        popover.appendChild(abstractsRow);
        popover.appendChild(imagesRow);
        popover.appendChild(closeBtn);

        // Find the chat container and append
        const chatContainer = container.querySelector("div");
        if (chatContainer) {
            (chatContainer as HTMLElement).style.position = "relative";
            chatContainer.appendChild(popover);
        }
    }

    /**
     * Create a toggle row for settings
     */
    private static createToggleRow(doc: Document, label: string, initialValue: boolean, onChange: (checked: boolean) => void): HTMLElement {
        const row = ztoolkit.UI.createElement(doc, "div", {
            styles: {
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                marginBottom: "8px"
            }
        });

        const labelEl = ztoolkit.UI.createElement(doc, "span", {
            properties: { innerText: label },
            styles: { fontSize: "12px" }
        });

        const checkbox = ztoolkit.UI.createElement(doc, "input", {
            attributes: { type: "checkbox" },
            styles: { cursor: "pointer" },
            listeners: [{
                type: "change",
                listener: (e: Event) => {
                    onChange((e.target as HTMLInputElement).checked);
                }
            }]
        }) as HTMLInputElement;
        checkbox.checked = initialValue;

        row.appendChild(labelEl);
        row.appendChild(checkbox);
        return row;
    }


    /**
     * Create the input area with send button and image paste support
     */
    private static createInputArea(doc: Document, messagesArea: HTMLElement, stateManager: ReturnType<typeof getChatStateManager>): HTMLElement {
        // Track pasted images (session-only, not persisted)
        const pastedImages: { id: string; image: string; mimeType: string }[] = [];

        // Container for everything
        const inputContainer = ztoolkit.UI.createElement(doc, "div", {
            styles: {
                display: "flex",
                flexDirection: "column",
                gap: "6px"
            }
        });

        // Image preview area (hidden by default)
        const imagePreviewArea = ztoolkit.UI.createElement(doc, "div", {
            properties: { id: "image-preview-area" },
            styles: {
                display: "none",
                flexWrap: "wrap",
                gap: "6px",
                padding: "8px",
                backgroundColor: "#f0f8ff",
                borderRadius: "6px",
                border: "1px dashed #03a9f4"
            }
        });

        const updateImagePreview = () => {
            imagePreviewArea.innerHTML = "";
            if (pastedImages.length === 0) {
                (imagePreviewArea as HTMLElement).style.display = "none";
                return;
            }
            (imagePreviewArea as HTMLElement).style.display = "flex";

            const label = ztoolkit.UI.createElement(doc, "div", {
                properties: { innerText: `🖼️ ${pastedImages.length} image(s) attached:` },
                styles: { width: "100%", fontSize: "11px", color: "#0288d1", marginBottom: "4px" }
            });
            imagePreviewArea.appendChild(label);

            pastedImages.forEach((img, idx) => {
                const thumbnail = ztoolkit.UI.createElement(doc, "div", {
                    styles: {
                        position: "relative",
                        width: "60px",
                        height: "60px",
                        borderRadius: "4px",
                        overflow: "hidden",
                        border: "1px solid #ddd"
                    }
                });

                const imgEl = ztoolkit.UI.createElement(doc, "img", {
                    attributes: { src: img.image },
                    styles: { width: "100%", height: "100%", objectFit: "cover" }
                });

                const removeBtn = ztoolkit.UI.createElement(doc, "div", {
                    properties: { innerText: "✕" },
                    styles: {
                        position: "absolute",
                        top: "2px",
                        right: "2px",
                        width: "16px",
                        height: "16px",
                        backgroundColor: "rgba(255,0,0,0.7)",
                        color: "#fff",
                        borderRadius: "50%",
                        fontSize: "10px",
                        textAlign: "center",
                        lineHeight: "16px",
                        cursor: "pointer"
                    },
                    listeners: [{
                        type: "click",
                        listener: () => {
                            pastedImages.splice(idx, 1);
                            updateImagePreview();
                        }
                    }]
                });

                thumbnail.appendChild(imgEl);
                thumbnail.appendChild(removeBtn);
                imagePreviewArea.appendChild(thumbnail);
            });
        };

        // Input row (text input + send button)
        const inputArea = ztoolkit.UI.createElement(doc, "div", {
            styles: {
                display: "flex",
                gap: "8px"
            }
        });

        const input = ztoolkit.UI.createElement(doc, "input", {
            attributes: {
                type: "text",
                placeholder: "Ask about selected items... (paste images with Cmd+V)"
            },
            styles: {
                flex: "1",
                padding: "8px 12px",
                border: "1px solid #ddd",
                borderRadius: "6px",
                fontSize: "13px"
            },
            listeners: [
                {
                    type: "keypress",
                    listener: (e: KeyboardEvent) => {
                        if (e.key === "Enter" && !this.isStreaming) {
                            this.handleSendWithStreamingAndImages(
                                input as unknown as HTMLInputElement,
                                messagesArea,
                                stateManager,
                                pastedImages,
                                () => { pastedImages.length = 0; updateImagePreview(); }
                            );
                        }
                    }
                },
                {
                    type: "paste",
                    listener: async (e: ClipboardEvent) => {
                        const items = e.clipboardData?.items;
                        if (!items) return;

                        for (const item of Array.from(items)) {
                            if (item.type.startsWith("image/")) {
                                e.preventDefault();
                                const blob = item.getAsFile();
                                if (blob) {
                                    const reader = new FileReader();
                                    reader.onload = () => {
                                        const dataUrl = reader.result as string;
                                        pastedImages.push({
                                            id: Date.now().toString(),
                                            image: dataUrl,
                                            mimeType: item.type
                                        });
                                        updateImagePreview();
                                        Zotero.debug(`[Seer AI] Pasted image: ${item.type}`);
                                    };
                                    reader.readAsDataURL(blob);
                                }
                            }
                        }
                    }
                }
            ]
        }) as unknown as HTMLInputElement;

        const sendBtn = ztoolkit.UI.createElement(doc, "button", {
            properties: { innerText: "➤ Send" },
            styles: {
                padding: "8px 16px",
                border: "none",
                borderRadius: "6px",
                backgroundColor: "#007bff",
                color: "#fff",
                cursor: "pointer",
                fontSize: "13px"
            },
            listeners: [{
                type: "click",
                listener: () => {
                    if (!this.isStreaming) {
                        this.handleSendWithStreamingAndImages(
                            input,
                            messagesArea,
                            stateManager,
                            pastedImages,
                            () => { pastedImages.length = 0; updateImagePreview(); }
                        );
                    }
                }
            }]
        });

        inputArea.appendChild(input);
        inputArea.appendChild(sendBtn);

        inputContainer.appendChild(imagePreviewArea);
        inputContainer.appendChild(inputArea);
        return inputContainer;
    }

    /**
     * Handle send with streaming response
     */
    private static async handleSendWithStreaming(
        input: HTMLInputElement,
        messagesArea: HTMLElement,
        stateManager: ReturnType<typeof getChatStateManager>
    ) {
        const text = input.value.trim();
        if (!text || this.isStreaming) return;

        // Store and display user message
        const userMsg: ChatMessage = {
            id: Date.now().toString(),
            role: 'user',
            content: text,
            timestamp: new Date()
        };
        conversationMessages.push(userMsg);

        // Persist user message
        try {
            await getMessageStore().appendMessage(userMsg);
        } catch (e) {
            Zotero.debug(`[Seer AI] Error saving user message: ${e}`);
        }

        this.appendMessage(messagesArea, "You", text, "#e3f2fd", "#1976d2");

        input.value = "";
        input.disabled = true;
        this.isStreaming = true;

        // Show stop button
        const stopBtn = messagesArea.ownerDocument?.getElementById("stop-btn") as HTMLElement;
        if (stopBtn) stopBtn.style.display = "inline-block";

        // Create streaming message placeholder
        const streamingDiv = this.appendMessage(messagesArea, "Assistant", "", "#f5f5f5", "#424242");
        const contentDiv = streamingDiv.querySelector('[data-content]') as HTMLElement;

        try {
            // Build context from all selected items and notes
            const states = stateManager.getStates();
            let context = "=== Selected Papers ===\n";

            for (const item of states.items) {
                context += `\n--- ${item.title} ---`;
                if (item.year) context += ` (${item.year})`;
                if (item.creators && item.creators.length > 0) {
                    context += `\nAuthors: ${item.creators.join(', ')}`;
                }
                if (item.abstract) {
                    context += `\nAbstract: ${item.abstract}`;
                }
            }

            // Include notes
            if (states.notes.length > 0) {
                context += "\n\n=== Notes ===";
                for (const note of states.notes) {
                    context += `\n\n--- ${note.title} ---\n${note.content}`;
                }
            }

            const systemPrompt = `You are a helpful research assistant for Zotero. You help users understand and analyze their academic papers and notes.

${context}

Be concise, accurate, and helpful. When referencing papers, cite them by title or author.`;

            // Check if we should include images (vision mode)
            const options = stateManager.getOptions();
            let messages: (OpenAIMessage | VisionMessage)[];

            if (options.includeImages) {
                // Build vision-compatible messages with images
                // Get Zotero items for image extraction
                const zoteroItems: Zotero.Item[] = [];
                for (const item of states.items) {
                    const zItem = Zotero.Items.get(item.id);
                    if (zItem) zoteroItems.push(zItem);
                }

                // Get image content parts
                const imageParts = await createImageContentParts(zoteroItems, 5);

                if (imageParts.length > 0) {
                    Zotero.debug(`[Seer AI] Including ${imageParts.length} images in request`);

                    // Build user message with images
                    const userMessageContent: VisionMessageContentPart[] = [
                        { type: "text", text: text },
                        ...imageParts
                    ];

                    messages = [
                        { role: "system", content: systemPrompt },
                        ...conversationMessages.filter(m => m.role !== 'system' && m.role !== 'error').map(m => ({
                            role: m.role as "user" | "assistant",
                            content: m.content
                        })),
                        { role: "user", content: userMessageContent }
                    ];

                    // Remove the last user message we added (text only) since we're replacing it with vision content
                    messages = messages.slice(0, -2).concat(messages.slice(-1));
                } else {
                    // No images found, use standard messages
                    messages = [
                        { role: "system", content: systemPrompt },
                        ...conversationMessages.filter(m => m.role !== 'system' && m.role !== 'error').map(m => ({
                            role: m.role as "user" | "assistant",
                            content: m.content
                        }))
                    ];
                }
            } else {
                // Standard text-only messages
                messages = [
                    { role: "system", content: systemPrompt },
                    ...conversationMessages.filter(m => m.role !== 'system' && m.role !== 'error').map(m => ({
                        role: m.role as "user" | "assistant",
                        content: m.content
                    }))
                ];
            }

            let fullResponse = "";

            // Get active model config for API call
            const activeModel = getActiveModelConfig();
            const configOverride = activeModel ? {
                apiURL: activeModel.apiURL,
                apiKey: activeModel.apiKey,
                model: activeModel.model
            } : undefined;

            await openAIService.chatCompletionStream(messages, {
                onToken: (token) => {
                    fullResponse += token;
                    if (contentDiv) {
                        contentDiv.setAttribute("data-raw", fullResponse);
                        contentDiv.innerHTML = parseMarkdown(fullResponse);
                        messagesArea.scrollTop = messagesArea.scrollHeight;
                    }
                },
                onComplete: async (content) => {
                    const assistantMsg: ChatMessage = {
                        id: Date.now().toString(),
                        role: 'assistant',
                        content: content,
                        timestamp: new Date()
                    };
                    conversationMessages.push(assistantMsg);

                    // Persist assistant message
                    try {
                        await getMessageStore().appendMessage(assistantMsg);
                    } catch (e) {
                        Zotero.debug(`[Seer AI] Error saving assistant message: ${e}`);
                    }

                    // Final render with markdown
                    if (contentDiv) {
                        contentDiv.setAttribute("data-raw", content);
                        contentDiv.innerHTML = parseMarkdown(content);
                    }
                },
                onError: (error) => {
                    if (contentDiv) {
                        contentDiv.innerHTML = `<span style="color: #c62828;">Error: ${error.message}</span>`;
                    }
                }
            }, configOverride);

        } catch (error) {
            const errMsg = error instanceof Error && error.message === "Request was cancelled"
                ? "Generation stopped"
                : String(error);
            if (contentDiv) {
                const isError = error instanceof Error && error.message !== "Request was cancelled";
                contentDiv.innerHTML = isError
                    ? `<span style="color: #c62828;">${errMsg}</span>`
                    : errMsg;
            }
        } finally {
            input.disabled = false;
            input.focus();
            this.isStreaming = false;
            if (stopBtn) stopBtn.style.display = "none";
        }
    }

    /**
     * Handle send with streaming response and pasted images (vision mode)
     */
    private static async handleSendWithStreamingAndImages(
        input: HTMLInputElement,
        messagesArea: HTMLElement,
        stateManager: ReturnType<typeof getChatStateManager>,
        pastedImages: { id: string; image: string; mimeType: string }[],
        clearImages: () => void
    ) {
        const text = input.value.trim();
        // Allow sending with just images
        if ((!text && pastedImages.length === 0) || this.isStreaming) return;

        // Store and display user message
        const userMsg: ChatMessage = {
            id: Date.now().toString(),
            role: 'user',
            content: pastedImages.length > 0 ? `${text} [+${pastedImages.length} image(s)]` : text,
            timestamp: new Date()
        };
        conversationMessages.push(userMsg);

        // Persist user message
        try {
            await getMessageStore().appendMessage(userMsg);
        } catch (e) {
            Zotero.debug(`[Seer AI] Error saving user message: ${e}`);
        }

        const displayText = pastedImages.length > 0
            ? `${text || "(no text)"} 🖼️ ${pastedImages.length} image(s)`
            : text;
        this.appendMessage(messagesArea, "You", displayText, "#e3f2fd", "#1976d2");

        input.value = "";
        input.disabled = true;
        this.isStreaming = true;

        // Show stop button
        const stopBtn = messagesArea.ownerDocument?.getElementById("stop-btn") as HTMLElement;
        if (stopBtn) stopBtn.style.display = "inline-block";

        // Create streaming message placeholder
        const streamingDiv = this.appendMessage(messagesArea, "Assistant", "", "#f5f5f5", "#424242");
        const contentDiv = streamingDiv.querySelector('[data-content]') as HTMLElement;

        try {
            // Build context from selected items and notes
            const states = stateManager.getStates();
            let context = "=== Selected Papers ===\n";

            for (const item of states.items) {
                context += `\n--- ${item.title} ---`;
                if (item.year) context += ` (${item.year})`;
                if (item.creators && item.creators.length > 0) {
                    context += `\nAuthors: ${item.creators.join(', ')}`;
                }
                if (item.abstract) {
                    context += `\nAbstract: ${item.abstract}`;
                }
            }

            if (states.notes.length > 0) {
                context += "\n\n=== Notes ===";
                for (const note of states.notes) {
                    context += `\n\n--- ${note.title} ---\n${note.content}`;
                }
            }

            const systemPrompt = `You are a helpful research assistant for Zotero. You help users understand and analyze their academic papers and notes.

${context}

Be concise, accurate, and helpful. When referencing papers, cite them by title or author.`;

            // Build vision-compatible messages with pasted images
            const userMessageContent: VisionMessageContentPart[] = [
                { type: "text", text: text || "Please analyze these images." }
            ];

            // Add pasted images
            for (const img of pastedImages) {
                userMessageContent.push({
                    type: "image_url",
                    image_url: {
                        url: img.image,  // Already a data URL
                        detail: "auto"
                    }
                });
            }

            Zotero.debug(`[Seer AI] Sending message with ${pastedImages.length} pasted images`);

            const messages: (OpenAIMessage | VisionMessage)[] = [
                { role: "system", content: systemPrompt },
                ...conversationMessages.slice(0, -1).filter(m => m.role !== 'system' && m.role !== 'error').map(m => ({
                    role: m.role as "user" | "assistant",
                    content: m.content
                })),
                { role: "user", content: userMessageContent }
            ];

            let fullResponse = "";

            // Get active model config for API call
            const activeModel = getActiveModelConfig();
            const configOverride = activeModel ? {
                apiURL: activeModel.apiURL,
                apiKey: activeModel.apiKey,
                model: activeModel.model
            } : undefined;

            await openAIService.chatCompletionStream(messages, {
                onToken: (token) => {
                    fullResponse += token;
                    if (contentDiv) {
                        contentDiv.setAttribute("data-raw", fullResponse);
                        contentDiv.innerHTML = parseMarkdown(fullResponse);
                        messagesArea.scrollTop = messagesArea.scrollHeight;
                    }
                },
                onComplete: async (content) => {
                    const assistantMsg: ChatMessage = {
                        id: Date.now().toString(),
                        role: 'assistant',
                        content: content,
                        timestamp: new Date()
                    };
                    conversationMessages.push(assistantMsg);

                    try {
                        await getMessageStore().appendMessage(assistantMsg);
                    } catch (e) {
                        Zotero.debug(`[Seer AI] Error saving assistant message: ${e}`);
                    }

                    // Clear pasted images after successful send
                    clearImages();
                },
                onError: (error) => {
                    if (contentDiv) {
                        contentDiv.innerHTML = `<span style="color: #c62828;">Error: ${error.message}</span>`;
                    }
                }
            }, configOverride);

        } catch (error) {
            const errMsg = error instanceof Error && error.message === "Request was cancelled"
                ? "Generation stopped"
                : String(error);
            if (contentDiv) {
                const isError = error instanceof Error && error.message !== "Request was cancelled";
                contentDiv.innerHTML = isError
                    ? `<span style="color: #c62828;">${errMsg}</span>`
                    : errMsg;
            }
        } finally {
            input.disabled = false;
            input.focus();
            this.isStreaming = false;
            if (stopBtn) stopBtn.style.display = "none";
        }
    }

    /**
     * Append a message bubble to the chat area with action buttons
     * @param msgId The message ID for reference
     * @param isLastUserMsg Whether this is the last user message (for edit button)
     */
    private static appendMessage(
        container: HTMLElement,
        sender: string,
        text: string,
        bgColor: string,
        textColor: string = "#000",
        msgId?: string,
        isLastUserMsg?: boolean
    ): HTMLElement {
        const doc = container.ownerDocument!;
        const isUser = sender === "You";
        const isAssistant = sender === "Assistant";

        const msgDiv = ztoolkit.UI.createElement(doc, "div", {
            attributes: { "data-msg-id": msgId || "" },
            styles: {
                backgroundColor: bgColor,
                padding: "10px 14px",
                borderRadius: isUser ? "12px 12px 4px 12px" : "12px 12px 12px 4px",
                fontSize: "13px",
                maxWidth: "90%",
                alignSelf: isUser ? "flex-end" : "flex-start",
                color: textColor,
                boxShadow: "0 1px 2px rgba(0,0,0,0.1)",
                position: "relative"
            }
        });

        // Header with sender and actions
        const headerDiv = ztoolkit.UI.createElement(doc, "div", {
            styles: {
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                marginBottom: "4px"
            }
        });

        const senderDiv = ztoolkit.UI.createElement(doc, "span", {
            styles: { fontWeight: "600", fontSize: "11px", opacity: "0.8" },
            properties: { innerText: sender }
        });

        // Action buttons container
        const actionsDiv = ztoolkit.UI.createElement(doc, "div", {
            styles: {
                display: "flex",
                gap: "4px",
                opacity: "0.6"
            }
        });

        // Copy button (for all messages)
        const copyBtn = this.createActionButton(doc, "📋", "Copy", () => {
            this.copyToClipboard(text, copyBtn as HTMLElement);
        });
        actionsDiv.appendChild(copyBtn);

        // Edit button (only for last user message)
        if (isUser && isLastUserMsg) {
            const editBtn = this.createActionButton(doc, "✏️", "Edit", () => {
                this.handleEditMessage(container, msgDiv as HTMLElement, msgId || "");
            });
            actionsDiv.appendChild(editBtn);
        }

        // Retry button (for assistant messages)
        if (isAssistant && !this.isStreaming) {
            const retryBtn = this.createActionButton(doc, "🔄", "Retry", () => {
                this.handleRetryMessage(container);
            });
            actionsDiv.appendChild(retryBtn);
        }

        headerDiv.appendChild(senderDiv);
        headerDiv.appendChild(actionsDiv);

        const contentDiv = ztoolkit.UI.createElement(doc, "div", {
            attributes: { "data-content": "true", "data-raw": text },
            styles: { lineHeight: "1.5" }
        });
        // Parse markdown to HTML for rendering
        contentDiv.innerHTML = parseMarkdown(text);

        // Bind copy button events for code blocks
        const copyBtns = contentDiv.querySelectorAll('.code-copy-btn');
        copyBtns.forEach((btn: Element) => {
            btn.addEventListener('click', () => {
                const codeId = btn.getAttribute('data-code-id');
                const codeEl = contentDiv.querySelector(`#${codeId}`);
                if (codeEl) {
                    const codeText = codeEl.textContent || '';
                    this.copyToClipboard(codeText, btn as HTMLElement);
                }
            });
        });

        msgDiv.appendChild(headerDiv);
        msgDiv.appendChild(contentDiv);
        container.appendChild(msgDiv);
        container.scrollTop = container.scrollHeight;

        return msgDiv;
    }

    /**
     * Create an action button with tooltip
     */
    private static createActionButton(doc: Document, icon: string, tooltip: string, onClick: () => void): HTMLElement {
        const btn = ztoolkit.UI.createElement(doc, "span", {
            properties: { innerText: icon, title: tooltip },
            styles: {
                cursor: "pointer",
                fontSize: "12px",
                padding: "2px 4px",
                borderRadius: "4px",
                transition: "background-color 0.1s"
            },
            listeners: [{
                type: "click",
                listener: (e: Event) => {
                    e.stopPropagation();
                    onClick();
                }
            }, {
                type: "mouseenter",
                listener: () => {
                    (btn as HTMLElement).style.backgroundColor = "rgba(0,0,0,0.1)";
                    (btn as HTMLElement).style.opacity = "1";
                }
            }, {
                type: "mouseleave",
                listener: () => {
                    (btn as HTMLElement).style.backgroundColor = "transparent";
                    (btn as HTMLElement).style.opacity = "0.6";
                }
            }]
        });
        return btn;
    }

    /**
     * Copy text to clipboard and show feedback
     */
    private static copyToClipboard(text: string, buttonElement: HTMLElement) {
        try {
            // Use navigator.clipboard API
            navigator.clipboard.writeText(text).then(() => {
                // Visual feedback
                const originalText = buttonElement.innerText;
                buttonElement.innerText = "✓";
                setTimeout(() => {
                    buttonElement.innerText = originalText;
                }, 1500);

                Zotero.debug("[Seer AI] Copied message to clipboard");
            }).catch((e) => {
                Zotero.debug(`[Seer AI] Clipboard API failed: ${e}`);
                // Fallback: create a temporary textarea
                this.fallbackCopyToClipboard(text, buttonElement);
            });
        } catch (e) {
            Zotero.debug(`[Seer AI] Failed to copy to clipboard: ${e}`);
            this.fallbackCopyToClipboard(text, buttonElement);
        }
    }

    /**
     * Fallback clipboard copy for older environments
     */
    private static fallbackCopyToClipboard(text: string, buttonElement: HTMLElement) {
        try {
            const doc = buttonElement.ownerDocument;
            if (!doc || !doc.body) {
                Zotero.debug("[Seer AI] Cannot access document for clipboard fallback");
                return;
            }
            const textarea = doc.createElement('textarea');
            textarea.value = text;
            textarea.style.position = 'fixed';
            textarea.style.left = '-9999px';
            doc.body.appendChild(textarea);
            textarea.select();
            doc.execCommand('copy');
            doc.body.removeChild(textarea);

            // Visual feedback
            const originalText = buttonElement.innerText;
            buttonElement.innerText = "✓";
            setTimeout(() => {
                buttonElement.innerText = originalText;
            }, 1500);

            Zotero.debug("[Seer AI] Copied message to clipboard (fallback)");
        } catch (e) {
            Zotero.debug(`[Seer AI] Fallback copy failed: ${e}`);
        }
    }

    /**
     * Handle edit message action
     */
    private static handleEditMessage(container: HTMLElement, msgDiv: HTMLElement, msgId: string) {
        const contentDiv = msgDiv.querySelector('[data-content]') as HTMLElement;
        if (!contentDiv) return;

        const originalText = contentDiv.innerText;
        const doc = container.ownerDocument!;

        // Replace content with input
        const inputContainer = ztoolkit.UI.createElement(doc, "div", {
            styles: { display: "flex", gap: "4px", marginTop: "4px" }
        });

        const input = ztoolkit.UI.createElement(doc, "input", {
            attributes: { type: "text", value: originalText },
            styles: {
                flex: "1",
                padding: "6px 10px",
                border: "1px solid #1976d2",
                borderRadius: "4px",
                fontSize: "13px"
            }
        }) as HTMLInputElement;

        const saveBtn = ztoolkit.UI.createElement(doc, "button", {
            properties: { innerText: "Send" },
            styles: {
                padding: "6px 12px",
                backgroundColor: "#1976d2",
                color: "#fff",
                border: "none",
                borderRadius: "4px",
                cursor: "pointer",
                fontSize: "12px"
            },
            listeners: [{
                type: "click",
                listener: () => {
                    const newText = input.value.trim();
                    if (newText && newText !== originalText) {
                        this.submitEditedMessage(container, msgId, newText);
                    } else {
                        // Restore original
                        contentDiv.innerText = originalText;
                        inputContainer.remove();
                        contentDiv.style.display = "block";
                    }
                }
            }]
        });

        const cancelBtn = ztoolkit.UI.createElement(doc, "button", {
            properties: { innerText: "Cancel" },
            styles: {
                padding: "6px 12px",
                backgroundColor: "#f5f5f5",
                color: "#666",
                border: "1px solid #ddd",
                borderRadius: "4px",
                cursor: "pointer",
                fontSize: "12px"
            },
            listeners: [{
                type: "click",
                listener: () => {
                    contentDiv.style.display = "block";
                    inputContainer.remove();
                }
            }]
        });

        input.addEventListener("keypress", (e: KeyboardEvent) => {
            if (e.key === "Enter") {
                saveBtn.click();
            } else if (e.key === "Escape") {
                cancelBtn.click();
            }
        });

        inputContainer.appendChild(input);
        inputContainer.appendChild(saveBtn);
        inputContainer.appendChild(cancelBtn);

        contentDiv.style.display = "none";
        msgDiv.appendChild(inputContainer);
        input.focus();
        input.select();
    }

    /**
     * Submit edited message and regenerate response
     */
    private static submitEditedMessage(container: HTMLElement, msgId: string, newText: string) {
        // Find the message index
        const msgIndex = conversationMessages.findIndex(m => m.id === msgId);
        if (msgIndex === -1) return;

        // Update the message
        conversationMessages[msgIndex].content = newText;

        // Remove all messages after this one
        conversationMessages = conversationMessages.slice(0, msgIndex + 1);

        // Re-render chat and regenerate
        this.rerenderChat(container);
        this.regenerateLastResponse(container);
    }

    /**
     * Handle retry message action - regenerates the last assistant response
     */
    private static handleRetryMessage(container: HTMLElement) {
        if (this.isStreaming) return;

        // Remove the last assistant message
        const lastMsg = conversationMessages[conversationMessages.length - 1];
        if (lastMsg && (lastMsg.role === 'assistant' || lastMsg.role === 'error')) {
            conversationMessages.pop();
        }

        // Re-render and regenerate
        this.rerenderChat(container);
        this.regenerateLastResponse(container);
    }

    /**
     * Re-render the chat area with current messages
     */
    private static rerenderChat(container: HTMLElement) {
        const messagesArea = container.querySelector("#assistant-messages-area") as HTMLElement;
        if (!messagesArea) return;

        messagesArea.innerHTML = "";

        const lastUserMsgIndex = conversationMessages.map(m => m.role).lastIndexOf('user');

        conversationMessages.forEach((msg, idx) => {
            const isUser = msg.role === 'user';
            const bgColor = isUser ? "#e3f2fd" : (msg.role === 'error' ? "#ffebee" : "#f5f5f5");
            const textColor = isUser ? "#1976d2" : (msg.role === 'error' ? "#c62828" : "#424242");
            const sender = isUser ? "You" : (msg.role === 'error' ? "Error" : "Assistant");
            const isLastUserMsg = isUser && idx === lastUserMsgIndex;

            this.appendMessage(messagesArea, sender, msg.content, bgColor, textColor, msg.id, isLastUserMsg);
        });
    }

    /**
     * Regenerate the last response based on the last user message
     */
    private static async regenerateLastResponse(container: HTMLElement) {
        const messagesArea = container.querySelector("#assistant-messages-area") as HTMLElement;
        if (!messagesArea) return;

        const stateManager = getChatStateManager();
        const input = container.querySelector("input[type='text']") as HTMLInputElement;

        if (input) input.disabled = true;
        this.isStreaming = true;

        const stopBtn = container.ownerDocument?.getElementById("stop-btn") as HTMLElement;
        if (stopBtn) stopBtn.style.display = "inline-block";

        // Create streaming message placeholder
        const streamingDiv = this.appendMessage(messagesArea, "Assistant", "", "#f5f5f5", "#424242");
        const contentDiv = streamingDiv.querySelector('[data-content]') as HTMLElement;

        try {
            const states = stateManager.getStates();
            let context = "=== Selected Papers ===\n";

            for (const item of states.items) {
                context += `\n--- ${item.title} ---`;
                if (item.year) context += ` (${item.year})`;
                if (item.creators && item.creators.length > 0) {
                    context += `\nAuthors: ${item.creators.join(', ')}`;
                }
                if (item.abstract) {
                    context += `\nAbstract: ${item.abstract}`;
                }
            }

            if (states.notes.length > 0) {
                context += "\n\n=== Notes ===";
                for (const note of states.notes) {
                    context += `\n\n--- ${note.title} ---\n${note.content}`;
                }
            }

            const systemPrompt = `You are a helpful research assistant for Zotero. You help users understand and analyze their academic papers and notes.

${context}

Be concise, accurate, and helpful. When referencing papers, cite them by title or author.`;

            const messages: OpenAIMessage[] = [
                { role: "system", content: systemPrompt },
                ...conversationMessages.filter(m => m.role !== 'system' && m.role !== 'error').map(m => ({
                    role: m.role as "user" | "assistant",
                    content: m.content
                }))
            ];

            let fullResponse = "";

            // Get active model config for API call
            const activeModel = getActiveModelConfig();
            const configOverride = activeModel ? {
                apiURL: activeModel.apiURL,
                apiKey: activeModel.apiKey,
                model: activeModel.model
            } : undefined;

            await openAIService.chatCompletionStream(messages, {
                onToken: (token) => {
                    fullResponse += token;
                    if (contentDiv) {
                        contentDiv.setAttribute("data-raw", fullResponse);
                        contentDiv.innerHTML = parseMarkdown(fullResponse);
                        messagesArea.scrollTop = messagesArea.scrollHeight;
                    }
                },
                onComplete: (content) => {
                    const assistantMsg: ChatMessage = {
                        id: Date.now().toString(),
                        role: 'assistant',
                        content: content,
                        timestamp: new Date()
                    };
                    conversationMessages.push(assistantMsg);
                    // Final render with markdown
                    if (contentDiv) {
                        contentDiv.setAttribute("data-raw", content);
                        contentDiv.innerHTML = parseMarkdown(content);
                    }
                },
                onError: (error) => {
                    if (contentDiv) {
                        contentDiv.innerHTML = `<span style="color: #c62828;">Error: ${error.message}</span>`;
                    }
                }
            }, configOverride);

        } catch (error) {
            const errMsg = error instanceof Error && error.message === "Request was cancelled"
                ? "Generation stopped"
                : String(error);
            if (contentDiv) {
                const isError = error instanceof Error && error.message !== "Request was cancelled";
                contentDiv.innerHTML = isError
                    ? `<span style="color: #c62828;">${errMsg}</span>`
                    : errMsg;
            }
        } finally {
            if (input) input.disabled = false;
            if (input) input.focus();
            this.isStreaming = false;
            if (stopBtn) stopBtn.style.display = "none";
        }
    }

    /**
     * Render a stored message (for restoring conversation)
     */
    private static renderStoredMessage(container: HTMLElement, msg: ChatMessage, isLastUserMsg: boolean = false) {
        const isUser = msg.role === 'user';
        const bgColor = isUser ? "#e3f2fd" : (msg.role === 'error' ? "#ffebee" : "#f5f5f5");
        const textColor = isUser ? "#1976d2" : (msg.role === 'error' ? "#c62828" : "#424242");
        const sender = isUser ? "You" : (msg.role === 'error' ? "Error" : "Assistant");
        this.appendMessage(container, sender, msg.content, bgColor, textColor, msg.id, isLastUserMsg);
    }

    /**
     * Save current conversation as a Zotero note
     */
    private static async saveConversationAsNote() {
        if (conversationMessages.length === 0) {
            Zotero.debug("[Seer AI] No messages to save");
            return;
        }

        const stateManager = getChatStateManager();
        const states = stateManager.getStates();

        const parentItem = states.items[0];
        if (!parentItem) {
            Zotero.debug("[Seer AI] No items to attach note to");
            return;
        }

        let noteContent = `<h2>AI Chat Conversation</h2>`;
        noteContent += `<p><em>Saved: ${new Date().toLocaleString()}</em></p>`;
        noteContent += `<p><strong>Context:</strong> ${stateManager.getSummary()}</p><hr/>`;

        for (const msg of conversationMessages) {
            const role = msg.role === 'user' ? '🧑 You' : '🤖 Assistant';
            noteContent += `<p><strong>${role}:</strong></p>`;
            noteContent += `<p>${msg.content.replace(/\n/g, '<br/>')}</p>`;
            noteContent += `<hr/>`;
        }

        try {
            const zoteroItem = Zotero.Items.get(parentItem.id);
            const note = new Zotero.Item('note');
            note.setNote(noteContent);
            note.parentID = zoteroItem.id;
            await note.saveTx();
            Zotero.debug("[Seer AI] Conversation saved as note");
        } catch (error) {
            Zotero.debug(`[Seer AI] Failed to save note: ${error}`);
        }
    }
}
