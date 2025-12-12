import { openAIService, OpenAIMessage, VisionMessage, VisionMessageContentPart } from "./openai";
import { config } from "../../package.json";
import { getChatStateManager, resetChatStateManager } from "./chat/stateManager";
import { SelectedItem, SelectedNote, ChatMessage, selectionConfigs, AIModelConfig } from "./chat/types";
import { getModelConfigs, getActiveModelConfig, setActiveModelId, hasModelConfigs } from "./chat/modelConfig";
import { parseMarkdown } from "./chat/markdown";
import { getMessageStore } from "./chat/messageStore";
import { createImageContentParts, countImageAttachments } from "./chat/imageUtils";
import { getTableStore } from "./chat/tableStore";
import {
    TableConfig,
    TableColumn,
    TableRow,
    TableData,
    AssistantTab,
    ColumnPreset,
    defaultColumns,
} from "./chat/tableTypes";
import { OcrService } from "./ocr";

// Stored messages for conversation continuity (loaded from persistence)
let conversationMessages: ChatMessage[] = [];

// Track the current item ID to detect navigation
let currentItemId: number | null = null;

// Store container reference for re-rendering
let currentContainer: HTMLElement | null = null;
let currentItem: Zotero.Item | null = null;

// Active tab state
let activeTab: AssistantTab = 'chat';
// Table state cache
let currentTableConfig: TableConfig | null = null;
let currentTableData: TableData | null = null;

// DataLabs service for PDF-to-note conversion
const ocrService = new OcrService();


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

        // Load table config if not already loaded
        if (!currentTableConfig) {
            try {
                const tableStore = getTableStore();
                currentTableConfig = await tableStore.loadConfig();
                Zotero.debug(`[Seer AI] Loaded table config: ${currentTableConfig.id}`);
            } catch (e) {
                Zotero.debug(`[Seer AI] Error loading table config: ${e}`);
            }
        }

        // Auto-add current item with its notes based on selection mode
        const options = stateManager.getOptions();
        const mode = options.selectionMode;

        if (mode === 'explore') {
            // Explore mode: add items without clearing (multi-add)
            if (!stateManager.isSelected('items', item.id)) {
                this.addItemWithNotes(item);
            }
        } else if (mode === 'default') {
            // Default mode: switch to single item (clear others, focus on this one)
            if (!stateManager.isSelected('items', item.id)) {
                stateManager.clearAll();
                this.addItemWithNotes(item);
            }
        }
        // Lock mode: do nothing - don't add any items automatically
        // Main Container with tabs
        const mainContainer = ztoolkit.UI.createElement(doc, "div", {
            styles: {
                display: "flex",
                flexDirection: "column",
                height: "100%",
                minHeight: "350px",
                fontFamily: "system-ui, -apple-system, sans-serif"
            }
        });

        // === TAB BAR ===
        const tabBar = this.createTabBar(doc, container, item);
        mainContainer.appendChild(tabBar);

        // === TAB CONTENT CONTAINER ===
        const tabContent = ztoolkit.UI.createElement(doc, "div", {
            properties: { id: "tab-content" },
            styles: {
                flex: "1",
                display: "flex",
                flexDirection: "column",
                overflow: "hidden"
            }
        });

        // Render active tab content
        if (activeTab === 'chat') {
            const chatTabContent = await this.createChatTabContent(doc, item, stateManager);
            tabContent.appendChild(chatTabContent);
        } else {
            const tableTabContent = await this.createTableTabContent(doc, item);
            tabContent.appendChild(tableTabContent);
        }

        mainContainer.appendChild(tabContent);
        container.appendChild(mainContainer);
    }

    /**
     * Create the tab bar navigation
     */
    private static createTabBar(doc: Document, container: HTMLElement, item: Zotero.Item): HTMLElement {
        const tabBar = ztoolkit.UI.createElement(doc, "div", {
            properties: { className: "tab-bar" },
            styles: {
                display: "flex",
                gap: "0",
                borderBottom: "1px solid var(--border-primary)",
                backgroundColor: "var(--background-secondary)",
                borderRadius: "6px 6px 0 0",
                overflow: "hidden"
            }
        });

        const tabs: { id: AssistantTab; label: string; icon: string }[] = [
            { id: 'chat', label: 'Chat', icon: '💬' },
            { id: 'table', label: 'Papers Table', icon: '📊' }
        ];

        tabs.forEach(tab => {
            const tabItem = ztoolkit.UI.createElement(doc, "button", {
                properties: {
                    className: `tab-item ${activeTab === tab.id ? 'active' : ''}`,
                    innerText: `${tab.icon} ${tab.label}`
                },
                styles: {
                    padding: "8px 16px",
                    cursor: "pointer",
                    fontSize: "12px",
                    fontWeight: "500",
                    color: activeTab === tab.id ? "var(--highlight-primary)" : "var(--text-secondary)",
                    backgroundColor: activeTab === tab.id ? "var(--background-primary)" : "transparent",
                    border: "none",
                    borderBottom: activeTab === tab.id ? "2px solid var(--highlight-primary)" : "2px solid transparent",
                    flex: "1",
                    textAlign: "center",
                    transition: "all 0.2s ease"
                },
                listeners: [{
                    type: "click",
                    listener: () => {
                        if (activeTab !== tab.id) {
                            activeTab = tab.id;
                            this.renderInterface(container, item);
                        }
                    }
                }]
            });
            tabBar.appendChild(tabItem);
        });

        return tabBar;
    }

    /**
     * Create the Chat tab content (existing chat UI)
     */
    private static async createChatTabContent(
        doc: Document,
        item: Zotero.Item,
        stateManager: ReturnType<typeof getChatStateManager>
    ): Promise<HTMLElement> {
        const chatContainer = ztoolkit.UI.createElement(doc, "div", {
            styles: {
                display: "flex",
                flexDirection: "column",
                height: "100%",
                gap: "8px",
                padding: "8px"
            }
        });

        // === SELECTION AREA ===
        const selectionArea = this.createSelectionArea(doc, stateManager);

        // === CONTROLS BAR ===
        const controlsBar = this.createControlsBar(doc, currentContainer!);

        // === MESSAGES AREA ===
        const messagesArea = ztoolkit.UI.createElement(doc, "div", {
            styles: {
                flex: "1",
                overflowY: "auto",
                border: "1px solid var(--border-primary)",
                borderRadius: "6px",
                padding: "10px",
                backgroundColor: "var(--background-primary)",
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

        return chatContainer;
    }

    /**
     * Create the Papers Table tab content
     */
    private static async createTableTabContent(doc: Document, item: Zotero.Item): Promise<HTMLElement> {
        const tableContainer = ztoolkit.UI.createElement(doc, "div", {
            properties: { className: "papers-table-container" },
            styles: {
                display: "flex",
                flexDirection: "column",
                height: "100%",
                overflow: "hidden"
            }
        });

        // Load table data
        const tableData = await this.loadTableData();

        // === TOOLBAR ===
        const toolbar = this.createTableToolbar(doc, item);
        tableContainer.appendChild(toolbar);

        // === TABLE WRAPPER ===
        const tableWrapper = ztoolkit.UI.createElement(doc, "div", {
            properties: { className: "table-wrapper" },
            styles: {
                flex: "1",
                overflow: "auto",
                backgroundColor: "var(--background-primary)"
            }
        });

        if (tableData.rows.length === 0) {
            // Empty state
            const emptyState = this.createTableEmptyState(doc);
            tableWrapper.appendChild(emptyState);
        } else {
            // Render table
            const table = this.createPapersTable(doc, tableData);
            tableWrapper.appendChild(table);
        }

        tableContainer.appendChild(tableWrapper);

        return tableContainer;
    }

    /**
     * Create the table toolbar with filter, add papers, generate, export buttons
     */
    private static createTableToolbar(doc: Document, item: Zotero.Item): HTMLElement {
        const toolbar = ztoolkit.UI.createElement(doc, "div", {
            properties: { className: "table-toolbar" },
            styles: {
                display: "flex",
                gap: "8px",
                padding: "8px",
                backgroundColor: "var(--background-secondary)",
                borderBottom: "1px solid var(--border-primary)",
                alignItems: "center",
                flexWrap: "wrap"
            }
        });

        // Library/Collection filter dropdown
        const filterContainer = ztoolkit.UI.createElement(doc, "div", {
            styles: {
                display: "flex",
                alignItems: "center",
                gap: "4px"
            }
        });

        const filterLabel = ztoolkit.UI.createElement(doc, "span", {
            properties: { innerText: "📁" },
            styles: { fontSize: "12px" }
        });
        filterContainer.appendChild(filterLabel);

        const filterSelect = ztoolkit.UI.createElement(doc, "select", {
            styles: {
                padding: "6px 8px",
                border: "1px solid var(--border-primary)",
                borderRadius: "4px",
                fontSize: "12px",
                backgroundColor: "var(--background-primary)",
                color: "var(--text-primary)",
                minWidth: "120px"
            },
            listeners: [{
                type: "change",
                listener: async (e: Event) => {
                    const select = e.target as HTMLSelectElement;
                    const value = select.value;
                    if (currentTableConfig) {
                        if (value === "all") {
                            currentTableConfig.filterLibraryId = null;
                            currentTableConfig.filterCollectionId = null;
                        } else if (value.startsWith("lib_")) {
                            currentTableConfig.filterLibraryId = parseInt(value.replace("lib_", ""), 10);
                            currentTableConfig.filterCollectionId = null;
                        } else if (value.startsWith("col_")) {
                            currentTableConfig.filterCollectionId = parseInt(value.replace("col_", ""), 10);
                        }
                        const tableStore = getTableStore();
                        await tableStore.saveConfig(currentTableConfig);
                    }
                }
            }]
        }) as HTMLSelectElement;

        // Populate filter options
        this.populateFilterSelect(filterSelect);
        filterContainer.appendChild(filterSelect);
        toolbar.appendChild(filterContainer);

        // Search input
        const searchInput = ztoolkit.UI.createElement(doc, "input", {
            attributes: { type: "text", placeholder: "🔍 Filter table..." },
            properties: { className: "table-search-input" },
            styles: {
                flex: "1",
                minWidth: "100px",
                padding: "6px 10px",
                border: "1px solid var(--border-primary)",
                borderRadius: "4px",
                fontSize: "12px",
                backgroundColor: "var(--background-primary)",
                color: "var(--text-primary)"
            },
            listeners: [{
                type: "input",
                listener: (e: Event) => {
                    const target = e.target as HTMLInputElement;
                    if (currentTableConfig) {
                        currentTableConfig.filterQuery = target.value;
                    }
                    this.debounceTableRefresh(doc, item);
                }
            }]
        }) as HTMLInputElement;

        if (currentTableConfig?.filterQuery) {
            searchInput.value = currentTableConfig.filterQuery;
        }
        toolbar.appendChild(searchInput);

        // Add Papers button
        const addPapersBtn = ztoolkit.UI.createElement(doc, "button", {
            properties: { className: "table-btn table-btn-primary", innerText: "➕ Add Papers" },
            styles: {
                padding: "6px 12px",
                fontSize: "11px",
                border: "none",
                borderRadius: "4px",
                backgroundColor: "var(--highlight-primary)",
                color: "var(--highlight-text)",
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                gap: "4px"
            },
            listeners: [{
                type: "click",
                listener: () => {
                    this.showTablePaperPicker(doc, item);
                }
            }]
        });
        toolbar.appendChild(addPapersBtn);

        // Generate All button (for AI columns)
        const generateBtn = ztoolkit.UI.createElement(doc, "button", {
            properties: { className: "table-btn generate-all-btn", innerText: "⚡ Generate All" },
            attributes: { id: "generate-all-btn" },
            styles: {
                padding: "6px 12px",
                fontSize: "11px",
                border: "1px solid var(--border-primary)",
                borderRadius: "4px",
                backgroundColor: "var(--background-primary)",
                color: "var(--text-primary)",
                cursor: "pointer"
            },
            listeners: [{
                type: "click",
                listener: async () => {
                    await this.generateAllEmptyColumns(doc, item);
                }
            }]
        });
        toolbar.appendChild(generateBtn);

        // Response length control
        const responseLengthContainer = this.createResponseLengthControl(doc);
        toolbar.appendChild(responseLengthContainer);

        // Add Column button
        const addColumnBtn = ztoolkit.UI.createElement(doc, "button", {
            properties: { className: "table-btn", innerText: "⚙ Columns" },
            styles: {
                padding: "6px 12px",
                fontSize: "11px",
                border: "1px solid var(--border-primary)",
                borderRadius: "4px",
                backgroundColor: "var(--background-primary)",
                color: "var(--text-primary)",
                cursor: "pointer"
            },
            listeners: [{
                type: "click",
                listener: () => {
                    this.showColumnManagerModal(doc, item);
                }
            }]
        });
        toolbar.appendChild(addColumnBtn);

        // Export button
        const exportBtn = ztoolkit.UI.createElement(doc, "button", {
            properties: { className: "table-btn", innerText: "📤" },
            attributes: { title: "Export to CSV" },
            styles: {
                padding: "6px 10px",
                fontSize: "11px",
                border: "1px solid var(--border-primary)",
                borderRadius: "4px",
                backgroundColor: "var(--background-primary)",
                color: "var(--text-primary)",
                cursor: "pointer"
            },
            listeners: [{
                type: "click",
                listener: async () => {
                    await this.exportTableToCSV();
                }
            }]
        });
        toolbar.appendChild(exportBtn);

        // Save as Notes button (Data Traceability)
        const saveAsNotesBtn = ztoolkit.UI.createElement(doc, "button", {
            properties: { className: "table-btn", innerText: "📋 Notes" },
            attributes: { title: "Save table data as notes attached to each paper" },
            styles: {
                padding: "6px 12px",
                fontSize: "11px",
                border: "1px solid var(--border-primary)",
                borderRadius: "4px",
                backgroundColor: "var(--background-primary)",
                color: "var(--text-primary)",
                cursor: "pointer"
            },
            listeners: [{
                type: "click",
                listener: async () => {
                    const rowCount = currentTableConfig?.addedPaperIds?.length || 0;
                    if (rowCount === 0) {
                        doc.defaultView?.alert("No papers in table to save as notes.");
                        return;
                    }
                    const confirmed = doc.defaultView?.confirm(
                        `Save table data for ${rowCount} paper(s) as notes?\n\nThis will create/update a "📊 Tables" note attached to each paper.`
                    );
                    if (confirmed) {
                        await this.saveAllRowsAsNotes(doc);
                    }
                }
            }]
        });
        toolbar.appendChild(saveAsNotesBtn);

        // Save button
        const saveBtn = ztoolkit.UI.createElement(doc, "button", {
            properties: { className: "table-btn", innerText: "💾" },
            attributes: { title: "Save workspace to history" },
            styles: {
                padding: "6px 10px",
                fontSize: "11px",
                border: "1px solid var(--border-primary)",
                borderRadius: "4px",
                backgroundColor: "var(--background-primary)",
                color: "var(--text-primary)",
                cursor: "pointer"
            },
            listeners: [{
                type: "click",
                listener: async () => {
                    await this.saveWorkspaceToHistory(doc);
                }
            }]
        });
        toolbar.appendChild(saveBtn);

        // History button
        const historyBtn = ztoolkit.UI.createElement(doc, "button", {
            properties: { className: "table-btn", innerText: "📜" },
            attributes: { title: "Load from history" },
            styles: {
                padding: "6px 10px",
                fontSize: "11px",
                border: "1px solid var(--border-primary)",
                borderRadius: "4px",
                backgroundColor: "var(--background-primary)",
                color: "var(--text-primary)",
                cursor: "pointer"
            },
            listeners: [{
                type: "click",
                listener: () => {
                    this.showHistoryPicker(doc, item);
                }
            }]
        });
        toolbar.appendChild(historyBtn);

        // Start Fresh button
        const startFreshBtn = ztoolkit.UI.createElement(doc, "button", {
            properties: { className: "table-btn", innerText: "🔄 New" },
            attributes: { title: "Start fresh workspace" },
            styles: {
                padding: "6px 10px",
                fontSize: "11px",
                border: "1px solid #cc6666",
                borderRadius: "4px",
                backgroundColor: "var(--background-primary)",
                color: "#cc6666",
                cursor: "pointer"
            },
            listeners: [{
                type: "click",
                listener: async () => {
                    await this.startFreshWorkspace(doc, item);
                }
            }]
        });
        toolbar.appendChild(startFreshBtn);

        return toolbar;
    }

    /**
     * Populate the library/collection filter dropdown
     */
    private static populateFilterSelect(select: HTMLSelectElement): void {
        const doc = select.ownerDocument;
        if (!doc) return;
        // All libraries option
        const allOption = doc.createElement("option");
        allOption.value = "all";
        allOption.textContent = "All Libraries";
        select.appendChild(allOption);

        try {
            const libraries = Zotero.Libraries.getAll();
            for (const library of libraries) {
                // Library option
                const libOption = doc.createElement("option");
                libOption.value = `lib_${library.libraryID}`;
                libOption.textContent = `📚 ${library.name}`;
                if (currentTableConfig?.filterLibraryId === library.libraryID && !currentTableConfig?.filterCollectionId) {
                    libOption.selected = true;
                }
                select.appendChild(libOption);

                // Get collections for this library
                const collections = Zotero.Collections.getByLibrary(library.libraryID);
                for (const collection of collections) {
                    const colOption = doc.createElement("option");
                    colOption.value = `col_${collection.id}`;
                    colOption.textContent = `  📁 ${collection.name}`;
                    if (currentTableConfig?.filterCollectionId === collection.id) {
                        colOption.selected = true;
                    }
                    select.appendChild(colOption);
                }
            }
        } catch (e) {
            Zotero.debug(`[Seer AI] Error populating filter select: ${e}`);
        }
    }

    /**
     * Show paper picker as a beautiful inline dropdown panel
     */
    private static async showTablePaperPicker(doc: Document, item: Zotero.Item): Promise<void> {
        // Toggle existing dropdown
        const existing = doc.getElementById("table-paper-picker-dropdown") as HTMLElement | null;
        if (existing) {
            // Animate out
            existing.style.opacity = "0";
            existing.style.transform = "translateY(-10px)";
            setTimeout(() => existing.remove(), 200);
            return;
        }

        // Find the toolbar and table container to position dropdown
        const tabContent = doc.getElementById("tab-content");
        if (!tabContent) return;

        // Create dropdown panel
        const dropdown = ztoolkit.UI.createElement(doc, "div", {
            properties: { id: "table-paper-picker-dropdown" },
            styles: {
                backgroundColor: "var(--background-primary)",
                borderRadius: "8px",
                padding: "0",
                boxShadow: "0 4px 16px rgba(0,0,0,0.12)",
                overflow: "hidden",
                border: "1px solid var(--border-primary)",
                transition: "all 0.2s ease-out",
                opacity: "0",
                transform: "translateY(-10px)",
                margin: "8px"
            }
        });

        // Header with gradient
        const header = ztoolkit.UI.createElement(doc, "div", {
            styles: {
                background: "linear-gradient(135deg, var(--highlight-primary) 0%, color-mix(in srgb, var(--highlight-primary) 80%, purple) 100%)",
                padding: "12px 16px",
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                gap: "12px"
            }
        });

        const headerTitle = ztoolkit.UI.createElement(doc, "div", {
            properties: { innerText: "📚 Add Papers" },
            styles: {
                fontSize: "14px",
                fontWeight: "600",
                color: "var(--highlight-text)",
                textShadow: "0 1px 2px rgba(0,0,0,0.1)"
            }
        });
        header.appendChild(headerTitle);

        // Close button in header
        const closeBtn = ztoolkit.UI.createElement(doc, "button", {
            properties: { innerText: "✕" },
            styles: {
                background: "rgba(0,0,0,0.1)",
                border: "none",
                borderRadius: "50%",
                width: "24px",
                height: "24px",
                cursor: "pointer",
                color: "var(--highlight-text)",
                fontSize: "12px",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                transition: "background 0.2s"
            },
            listeners: [{
                type: "click",
                listener: () => {
                    dropdown.style.opacity = "0";
                    dropdown.style.transform = "translateY(-10px)";
                    setTimeout(() => {
                        dropdown.remove();
                        if (currentContainer && currentItem) {
                            this.renderInterface(currentContainer, currentItem);
                        }
                    }, 200);
                }
            }]
        });
        closeBtn.addEventListener("mouseenter", () => { closeBtn.style.background = "rgba(0,0,0,0.15)"; });
        closeBtn.addEventListener("mouseleave", () => { closeBtn.style.background = "rgba(0,0,0,0.1)"; });
        header.appendChild(closeBtn);
        dropdown.appendChild(header);

        // Content area
        const content = ztoolkit.UI.createElement(doc, "div", {
            styles: {
                padding: "12px 16px",
                display: "flex",
                flexDirection: "column",
                gap: "10px"
            }
        });

        // Filter and search row
        const controlsRow = ztoolkit.UI.createElement(doc, "div", {
            styles: {
                display: "flex",
                gap: "8px",
                alignItems: "center"
            }
        });

        const filterSelect = ztoolkit.UI.createElement(doc, "select", {
            styles: {
                flex: "0 0 auto",
                minWidth: "140px",
                padding: "8px 10px",
                border: "1px solid var(--border-primary)",
                borderRadius: "8px",
                fontSize: "12px",
                backgroundColor: "var(--background-secondary)",
                color: "var(--text-primary)",
                cursor: "pointer",
                outline: "none",
                transition: "border-color 0.2s, box-shadow 0.2s"
            }
        }) as HTMLSelectElement;
        filterSelect.addEventListener("focus", () => {
            filterSelect.style.borderColor = "var(--highlight-primary)";
            filterSelect.style.boxShadow = "0 0 0 3px color-mix(in srgb, var(--highlight-primary) 20%, transparent)";
        });
        filterSelect.addEventListener("blur", () => {
            filterSelect.style.borderColor = "var(--border-primary)";
            filterSelect.style.boxShadow = "none";
        });
        this.populateFilterSelect(filterSelect);
        controlsRow.appendChild(filterSelect);

        const searchInput = ztoolkit.UI.createElement(doc, "input", {
            attributes: { type: "text", placeholder: "🔍 Search papers..." },
            styles: {
                flex: "1",
                padding: "8px 12px",
                border: "1px solid var(--border-primary)",
                borderRadius: "8px",
                fontSize: "12px",
                backgroundColor: "var(--background-secondary)",
                color: "var(--text-primary)",
                outline: "none",
                transition: "border-color 0.2s, box-shadow 0.2s"
            }
        }) as HTMLInputElement;
        searchInput.addEventListener("focus", () => {
            searchInput.style.borderColor = "var(--highlight-primary)";
            searchInput.style.boxShadow = "0 0 0 3px color-mix(in srgb, var(--highlight-primary) 20%, transparent)";
        });
        searchInput.addEventListener("blur", () => {
            searchInput.style.borderColor = "var(--border-primary)";
            searchInput.style.boxShadow = "none";
        });
        controlsRow.appendChild(searchInput);
        content.appendChild(controlsRow);

        // Paper list container with custom scrollbar styling
        const listContainer = ztoolkit.UI.createElement(doc, "div", {
            styles: {
                maxHeight: "280px",
                overflowY: "auto",
                border: "1px solid var(--border-primary)",
                borderRadius: "8px",
                backgroundColor: "var(--background-secondary)"
            }
        });
        content.appendChild(listContainer);

        // State for infinite scroll and Add All
        let allFilteredItems: Zotero.Item[] = [];
        let displayedCount = 0;
        const BATCH_SIZE = 50;
        let isLoadingMore = false;

        // Render papers with beautiful styling
        const renderPaperBatch = (items: Zotero.Item[], startIndex: number, count: number) => {
            const endIndex = Math.min(startIndex + count, items.length);
            for (let i = startIndex; i < endIndex; i++) {
                const paperItem = items[i];
                const paperTitle = (paperItem.getField('title') as string) || 'Untitled';
                const creators = paperItem.getCreators();
                const authorStr = creators.length > 0 ? creators.map(c => c.lastName).join(', ') : 'Unknown';
                const year = paperItem.getField('year') || '';

                const row = ztoolkit.UI.createElement(doc, "div", {
                    attributes: { "data-paper-id": String(paperItem.id) },
                    styles: {
                        padding: "10px 14px",
                        borderBottom: "1px solid var(--border-primary)",
                        cursor: "pointer",
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        transition: "background-color 0.15s, transform 0.1s"
                    }
                });

                const info = ztoolkit.UI.createElement(doc, "div", {
                    styles: { flex: "1", overflow: "hidden", marginRight: "10px" }
                });

                // Clickable title to open PDF
                const titleEl = ztoolkit.UI.createElement(doc, "div", {
                    properties: { innerText: paperTitle },
                    styles: {
                        fontSize: "12px",
                        fontWeight: "500",
                        overflow: "hidden",
                        lineHeight: "1.3",
                        maxHeight: "2.6em",
                        color: "var(--highlight-primary)",
                        cursor: "pointer",
                        transition: "color 0.15s",
                        wordBreak: "break-word"
                    },
                    listeners: [{
                        type: "click",
                        listener: async (e: Event) => {
                            e.stopPropagation();
                            const attachmentIds = paperItem.getAttachments();
                            for (const attachId of attachmentIds) {
                                const attachment = Zotero.Items.get(attachId);
                                if (attachment && attachment.isPDFAttachment && attachment.isPDFAttachment()) {
                                    await Zotero.Reader.open(attachment.id);
                                    return;
                                }
                            }
                            const zp = Zotero.getActiveZoteroPane();
                            if (zp) zp.selectItem(paperItem.id);
                        }
                    }]
                });
                titleEl.addEventListener("mouseenter", () => { (titleEl as HTMLElement).style.textDecoration = "underline"; });
                titleEl.addEventListener("mouseleave", () => { (titleEl as HTMLElement).style.textDecoration = "none"; });

                const metaEl = ztoolkit.UI.createElement(doc, "div", {
                    properties: { innerText: `${authorStr}${year ? ` • ${year}` : ''}` },
                    styles: { fontSize: "11px", color: "var(--text-secondary)", marginTop: "2px" }
                });
                info.appendChild(titleEl);
                info.appendChild(metaEl);
                row.appendChild(info);

                // Add button with animation
                const addBtn = ztoolkit.UI.createElement(doc, "button", {
                    properties: { innerText: "+" },
                    styles: {
                        width: "28px",
                        height: "28px",
                        borderRadius: "50%",
                        border: "2px solid var(--highlight-primary)",
                        backgroundColor: "transparent",
                        color: "var(--highlight-primary)",
                        fontSize: "16px",
                        fontWeight: "bold",
                        cursor: "pointer",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        transition: "all 0.2s ease",
                        flexShrink: "0"
                    },
                    listeners: [{
                        type: "click",
                        listener: async (e: Event) => {
                            e.stopPropagation();
                            if (currentTableConfig) {
                                if (!currentTableConfig.addedPaperIds) {
                                    currentTableConfig.addedPaperIds = [];
                                }
                                if (!currentTableConfig.addedPaperIds.includes(paperItem.id)) {
                                    currentTableConfig.addedPaperIds.push(paperItem.id);
                                    const tableStore = getTableStore();
                                    await tableStore.saveConfig(currentTableConfig);
                                    // Animate removal
                                    row.style.transform = "translateX(20px)";
                                    row.style.opacity = "0";
                                    setTimeout(() => {
                                        row.remove();
                                        const idx = allFilteredItems.findIndex(item => item.id === paperItem.id);
                                        if (idx !== -1) {
                                            allFilteredItems.splice(idx, 1);
                                            displayedCount--;
                                        }
                                    }, 150);
                                }
                            }
                        }
                    }]
                });
                addBtn.addEventListener("mouseenter", () => {
                    addBtn.style.backgroundColor = "var(--highlight-primary)";
                    addBtn.style.color = "var(--highlight-text)";
                    addBtn.style.transform = "scale(1.1)";
                });
                addBtn.addEventListener("mouseleave", () => {
                    addBtn.style.backgroundColor = "transparent";
                    addBtn.style.color = "var(--highlight-primary)";
                    addBtn.style.transform = "scale(1)";
                });
                row.appendChild(addBtn);

                // Row hover effect
                row.addEventListener("mouseenter", () => { row.style.backgroundColor = "var(--background-primary)"; });
                row.addEventListener("mouseleave", () => { row.style.backgroundColor = ""; });

                listContainer.appendChild(row);
            }
            displayedCount = endIndex;
        };

        // Infinite scroll
        const loadMorePapers = () => {
            if (isLoadingMore || displayedCount >= allFilteredItems.length) return;
            isLoadingMore = true;
            renderPaperBatch(allFilteredItems, displayedCount, BATCH_SIZE);
            isLoadingMore = false;
        };

        listContainer.addEventListener("scroll", () => {
            const scrollTop = listContainer.scrollTop;
            const scrollHeight = listContainer.scrollHeight;
            const clientHeight = listContainer.clientHeight;
            if (scrollHeight - scrollTop - clientHeight < 50) {
                loadMorePapers();
            }
        });

        // Load papers
        const loadPapers = async () => {
            listContainer.innerHTML = "";
            allFilteredItems = [];
            displayedCount = 0;
            const filterValue = filterSelect.value;
            const searchQuery = searchInput.value.toLowerCase();

            // Show loading
            const loadingEl = ztoolkit.UI.createElement(doc, "div", {
                properties: { innerText: "⏳ Loading papers..." },
                styles: { padding: "20px", textAlign: "center", color: "var(--text-secondary)" }
            });
            listContainer.appendChild(loadingEl);

            let items: Zotero.Item[] = [];
            try {
                if (filterValue === "all") {
                    const libraries = Zotero.Libraries.getAll();
                    for (const lib of libraries) {
                        const libItems = await Zotero.Items.getAll(lib.libraryID);
                        items.push(...libItems.filter((i: Zotero.Item) => i.isRegularItem()));
                    }
                } else if (filterValue.startsWith("lib_")) {
                    const libraryId = parseInt(filterValue.replace("lib_", ""), 10);
                    const libItems = await Zotero.Items.getAll(libraryId);
                    items = libItems.filter((i: Zotero.Item) => i.isRegularItem());
                } else if (filterValue.startsWith("col_")) {
                    const collectionId = parseInt(filterValue.replace("col_", ""), 10);
                    const collection = Zotero.Collections.get(collectionId);
                    if (collection) {
                        items = collection.getChildItems().filter((i: Zotero.Item) => i.isRegularItem());
                    }
                }

                const addedIds = new Set(currentTableConfig?.addedPaperIds || []);
                allFilteredItems = items.filter(i => {
                    if (addedIds.has(i.id)) return false;
                    if (!searchQuery) return true;
                    const itemTitle = (i.getField('title') as string || '').toLowerCase();
                    const creators = i.getCreators().map(c => `${c.firstName} ${c.lastName}`.toLowerCase()).join(' ');
                    return itemTitle.includes(searchQuery) || creators.includes(searchQuery);
                });

                listContainer.innerHTML = "";

                if (allFilteredItems.length === 0) {
                    const emptyMsg = ztoolkit.UI.createElement(doc, "div", {
                        properties: { innerText: "No papers found" },
                        styles: { padding: "30px", textAlign: "center", color: "var(--text-tertiary)", fontSize: "13px" }
                    });
                    listContainer.appendChild(emptyMsg);
                    return;
                }

                renderPaperBatch(allFilteredItems, 0, BATCH_SIZE);
            } catch (e) {
                listContainer.innerHTML = "";
                const errorMsg = ztoolkit.UI.createElement(doc, "div", {
                    properties: { innerText: `Error loading papers: ${e}` },
                    styles: { padding: "20px", textAlign: "center", color: "#c62828" }
                });
                listContainer.appendChild(errorMsg);
            }
        };

        filterSelect.addEventListener("change", loadPapers);
        searchInput.addEventListener("input", () => {
            clearTimeout((searchInput as any)._debounce);
            (searchInput as any)._debounce = setTimeout(loadPapers, 300);
        });

        // Button row with gradient background
        const buttonRow = ztoolkit.UI.createElement(doc, "div", {
            styles: {
                display: "flex",
                justifyContent: "space-between",
                gap: "10px",
                paddingTop: "8px",
                borderTop: "1px solid var(--border-primary)"
            }
        });

        // Add All button
        const addAllBtn = ztoolkit.UI.createElement(doc, "button", {
            properties: { innerText: "➕ Add All" },
            styles: {
                padding: "10px 18px",
                border: "none",
                borderRadius: "8px",
                background: "linear-gradient(135deg, var(--highlight-primary) 0%, color-mix(in srgb, var(--highlight-primary) 80%, purple) 100%)",
                color: "var(--highlight-text)",
                cursor: "pointer",
                fontWeight: "600",
                fontSize: "12px",
                transition: "transform 0.15s, box-shadow 0.15s",
                boxShadow: "0 2px 8px rgba(0,0,0,0.15)"
            },
            listeners: [{
                type: "click",
                listener: async () => {
                    let count = 0;
                    for (const paperItem of allFilteredItems) {
                        if (currentTableConfig && !currentTableConfig.addedPaperIds.includes(paperItem.id)) {
                            currentTableConfig.addedPaperIds.push(paperItem.id);
                            count++;
                        }
                    }
                    listContainer.innerHTML = "";
                    allFilteredItems = [];
                    displayedCount = 0;
                    const emptyMsg = ztoolkit.UI.createElement(doc, "div", {
                        properties: { innerText: "All papers added!" },
                        styles: { padding: "30px", textAlign: "center", color: "var(--text-secondary)", fontSize: "13px" }
                    });
                    listContainer.appendChild(emptyMsg);
                    if (count > 0) {
                        (addAllBtn as HTMLElement).innerText = `✓ Added ${count}`;
                        setTimeout(() => { (addAllBtn as HTMLElement).innerText = "➕ Add All"; }, 1500);
                    }
                }
            }]
        });
        addAllBtn.addEventListener("mouseenter", () => {
            addAllBtn.style.transform = "translateY(-2px)";
            addAllBtn.style.boxShadow = "0 4px 12px rgba(0,0,0,0.2)";
        });
        addAllBtn.addEventListener("mouseleave", () => {
            addAllBtn.style.transform = "";
            addAllBtn.style.boxShadow = "0 2px 8px rgba(0,0,0,0.15)";
        });
        buttonRow.appendChild(addAllBtn);

        // Done button
        const doneBtn = ztoolkit.UI.createElement(doc, "button", {
            properties: { innerText: "Done" },
            styles: {
                padding: "10px 18px",
                border: "1px solid var(--border-primary)",
                borderRadius: "8px",
                backgroundColor: "var(--background-secondary)",
                color: "var(--text-primary)",
                cursor: "pointer",
                fontWeight: "500",
                fontSize: "12px",
                transition: "background-color 0.15s"
            },
            listeners: [{
                type: "click",
                listener: () => {
                    dropdown.style.opacity = "0";
                    dropdown.style.transform = "translateY(-10px)";
                    setTimeout(() => {
                        dropdown.remove();
                        if (currentContainer && currentItem) {
                            this.renderInterface(currentContainer, currentItem);
                        }
                    }, 200);
                }
            }]
        });
        doneBtn.addEventListener("mouseenter", () => { doneBtn.style.backgroundColor = "var(--background-primary)"; });
        doneBtn.addEventListener("mouseleave", () => { doneBtn.style.backgroundColor = "var(--background-secondary)"; });
        buttonRow.appendChild(doneBtn);
        content.appendChild(buttonRow);

        dropdown.appendChild(content);

        // Insert dropdown after the toolbar
        const toolbar = tabContent.querySelector('.table-toolbar');
        if (toolbar && toolbar.parentNode) {
            toolbar.parentNode.insertBefore(dropdown, toolbar.nextSibling);
        } else {
            tabContent.insertBefore(dropdown, tabContent.firstChild);
        }

        // Auto-focus search
        setTimeout(() => searchInput.focus(), 100);

        // Animate in
        setTimeout(() => {
            dropdown.style.opacity = "1";
            dropdown.style.transform = "translateY(0)";
        }, 10);

        // Load papers
        await loadPapers();
    }

    /**
     * Generate AI content for all empty computed columns
     */
    private static async generateAllEmptyColumns(doc: Document, item: Zotero.Item): Promise<void> {
        Zotero.debug("[Seer AI] Generate All clicked");

        if (!currentTableConfig) return;

        // Get visible columns and computed columns
        const columns = currentTableConfig.columns || defaultColumns;
        const visibleCols = columns.filter(col => col.visible);
        const computedCols = visibleCols.filter(col => col.type === 'computed');

        if (computedCols.length === 0) {
            Zotero.debug("[Seer AI] No computed columns visible");
            return;
        }

        // Map column ID to its index in the row (0-based)
        const colIndices = new Map<string, number>();
        computedCols.forEach(col => {
            const idx = visibleCols.findIndex(c => c.id === col.id);
            if (idx !== -1) colIndices.set(col.id, idx);
        });

        // Find all visible rows
        const table = doc.querySelector('.papers-table');
        if (!table) return;

        const rows = table.querySelectorAll('tr[data-paper-id]');
        if (rows.length === 0) return;

        // Get max concurrent from settings
        const maxConcurrent = (Zotero.Prefs.get(`${addon.data.config.prefsPrefix}.aiMaxConcurrent`) as number) || 5;
        Zotero.debug(`[Seer AI] AI Max concurrent queries: ${maxConcurrent}`);

        // Build tasks by scanning DOM
        interface GenerationTask {
            paperId: number;
            col: TableColumn;
            td: HTMLElement;
            item: Zotero.Item;
        }
        const tasks: GenerationTask[] = [];

        for (let i = 0; i < rows.length; i++) {
            const tr = rows[i] as HTMLElement;
            const paperId = parseInt(tr.getAttribute('data-paper-id') || "0", 10);
            if (!paperId) continue;

            // Get paper item
            const paperItem = Zotero.Items.get(paperId);
            if (!paperItem || !paperItem.isRegularItem()) continue;

            const existingRowData = currentTableData?.rows.find(r => r.paperId === paperId);

            // Check each computed column
            for (const col of computedCols) {
                const colIdx = colIndices.get(col.id);
                if (colIdx === undefined) continue;

                // Check if cell is empty in DATA
                const val = existingRowData?.data[col.id];
                if (val && val.toString().trim().length > 0) continue;

                // Target the specific TD
                const td = tr.children[colIdx] as HTMLElement;
                if (!td) continue;

                // Add to tasks
                tasks.push({
                    paperId,
                    col,
                    td,
                    item: paperItem
                });

                // Immediate visual feedback
                td.innerHTML = `<span style="color: var(--text-tertiary); font-size: 11px;">⏳ Generating...</span>`;
                td.style.cursor = "wait";
            }
        }

        if (tasks.length === 0) {
            Zotero.debug("[Seer AI] No empty cells to generate in visible rows");
            return;
        }

        Zotero.debug(`[Seer AI] ${tasks.length} visible cells to generate`);

        // Update button status
        const generateBtn = doc.getElementById('generate-all-btn') as HTMLButtonElement | null;
        const originalBtnText = generateBtn?.innerText || "⚡ Generate All";
        let completed = 0;
        let generated = 0;
        let failed = 0;

        const updateProgress = () => {
            if (generateBtn) {
                generateBtn.innerText = `⏳ ${completed}/${tasks.length}`;
                generateBtn.disabled = true;
                generateBtn.style.cursor = "wait";
            }
        };

        // Process a single task
        const processTask = async (task: GenerationTask): Promise<void> => {
            try {
                // Get note IDs fresh (might have changed? unlikely but safe)
                const noteIds = task.item.getNotes();

                // First try generating from notes
                let content = await this.generateColumnContent(task.item, task.col, noteIds);

                // If no notes, try PDF extraction
                if (!content) {
                    const attachmentIds = task.item.getAttachments();
                    for (const attId of attachmentIds) {
                        const att = Zotero.Items.get(attId);
                        if (att && att.attachmentContentType === 'application/pdf') {
                            try {
                                let fullText = "";
                                if ((Zotero.Fulltext as any).getItemContent) {
                                    const pdfContent = await (Zotero.Fulltext as any).getItemContent(att.id);
                                    fullText = pdfContent?.content || "";
                                } else if ((Zotero.Fulltext as any).getTextForItem) {
                                    fullText = await (Zotero.Fulltext as any).getTextForItem(att.id) || "";
                                }
                                if (fullText) {
                                    content = await this.generateColumnContentFromText(task.item, task.col, fullText.substring(0, 15000));
                                    break;
                                }
                            } catch (pdfErr) {
                                Zotero.debug(`[Seer AI] PDF extraction failed: ${pdfErr}`);
                            }
                        }
                    }
                }

                if (content) {
                    // Update DOM immediately
                    task.td.innerHTML = parseMarkdown(content);
                    task.td.style.cursor = "pointer";
                    task.td.style.backgroundColor = ""; // Remove any special bg

                    // Update Data
                    const row = currentTableData?.rows.find(r => r.paperId === task.paperId);
                    if (row) {
                        row.data[task.col.id] = content;
                    }
                    generated++;
                } else {
                    // No content generated
                    task.td.innerHTML = `<span style="color: var(--text-tertiary); font-size: 11px; font-style: italic;">Empty - no notes/PDF</span>`;
                    task.td.style.cursor = "default";
                }
            } catch (e) {
                Zotero.debug(`[Seer AI] Error generating for ${task.paperId}/${task.col.id}: ${e}`);
                task.td.innerHTML = `<span style="color: #c62828; font-size: 11px;">Error</span>`;
                task.td.title = String(e);
                failed++;
            } finally {
                completed++;
                updateProgress();
            }
        };

        // Process tasks in parallel batches
        updateProgress();
        for (let i = 0; i < tasks.length; i += maxConcurrent) {
            const batch = tasks.slice(i, i + maxConcurrent);
            await Promise.all(batch.map(processTask));
        }

        // Save at the end
        const tableStore = getTableStore();
        if (currentTableConfig) {
            await tableStore.saveConfig(currentTableConfig);
        }

        // Restore button
        if (generateBtn) {
            generateBtn.innerText = `✓ Done (${generated}/${tasks.length})`;
            generateBtn.disabled = false;
            generateBtn.style.cursor = "pointer";
            setTimeout(() => {
                generateBtn.innerText = originalBtnText;
            }, 2000);
        }

        Zotero.debug(`[Seer AI] Generation complete: ${generated} generated, ${failed} failed`);
    }

    /**
     * Generate content for a single cell
     */
    private static async generateCellContent(doc: Document, row: TableRow, col: TableColumn, td: HTMLElement): Promise<void> {
        // Show loading indicator
        td.innerHTML = `<span style="color: var(--text-tertiary); font-size: 11px;">⏳ Generating...</span>`;
        td.style.cursor = "wait";

        try {
            const item = Zotero.Items.get(row.paperId);
            if (!item) throw new Error("Item not found");

            const content = await this.generateColumnContent(item, col, row.noteIds);

            // Update cell display
            td.innerText = content || "(No content generated)";
            td.style.cursor = "default";
            td.style.backgroundColor = "";

            // Update row data
            row.data[col.id] = content;

            // Save to tableStore (persist the generated data)
            const tableStore = getTableStore();
            await tableStore.saveConfig(currentTableConfig!);

        } catch (e) {
            td.innerHTML = `<span style="color: #c62828; font-size: 11px;">Error: ${e}</span>`;
            td.style.cursor = "pointer";
            Zotero.debug(`[Seer AI] Cell generation error: ${e}`);
        }
    }

    /**
     * Extract text from PDF and generate content
     */
    private static async extractPDFAndGenerate(doc: Document, row: TableRow, col: TableColumn, td: HTMLElement): Promise<void> {
        // Show loading indicator
        td.innerHTML = `<span style="color: var(--text-tertiary); font-size: 11px;">📄 Extracting PDF...</span>`;
        td.style.cursor = "wait";

        try {
            const item = Zotero.Items.get(row.paperId);
            if (!item) throw new Error("Item not found");

            // Get PDF attachments
            const attachmentIds = item.getAttachments();
            let pdfText = "";

            for (const attId of attachmentIds) {
                const att = Zotero.Items.get(attId);
                if (att && att.attachmentContentType === 'application/pdf') {
                    // Try to get full-text content (Zotero indexes PDFs)
                    try {
                        // Try different Zotero Fulltext APIs (varies by version)
                        let fullText = "";
                        if ((Zotero.Fulltext as any).getItemContent) {
                            const content = await (Zotero.Fulltext as any).getItemContent(att.id);
                            fullText = content?.content || "";
                        } else if ((Zotero.Fulltext as any).getTextForItem) {
                            fullText = await (Zotero.Fulltext as any).getTextForItem(att.id) || "";
                        }
                        if (fullText) {
                            pdfText += fullText.substring(0, 15000); // Limit context size
                            break;
                        }
                    } catch (e) {
                        Zotero.debug(`[Seer AI] Error getting fulltext: ${e}`);
                    }
                }
            }

            if (!pdfText) {
                td.innerHTML = `<span style="color: #ff9800; font-size: 11px;">PDF not indexed</span>`;
                td.style.cursor = "default";
                return;
            }

            // Now generate with PDF context
            td.innerHTML = `<span style="color: var(--text-tertiary); font-size: 11px;">⚡ Generating...</span>`;

            const content = await this.generateColumnContentFromText(item, col, pdfText);

            // Update cell display
            td.innerText = content || "(No content generated)";
            td.style.cursor = "default";
            td.style.backgroundColor = "";

            // Update row data
            row.data[col.id] = content;

        } catch (e) {
            td.innerHTML = `<span style="color: #c62828; font-size: 11px;">Error: ${e}</span>`;
            td.style.cursor = "pointer";
            Zotero.debug(`[Seer AI] PDF extraction error: ${e}`);
        }
    }

    /**
     * Generate column content using AI
     */
    private static async generateColumnContent(item: Zotero.Item, col: TableColumn, noteIds: number[]): Promise<string> {
        // Get note content
        let noteContent = "";
        for (const noteId of noteIds) {
            const noteItem = Zotero.Items.get(noteId);
            if (noteItem) {
                const noteHTML = noteItem.getNote();
                noteContent += this.stripHtml(noteHTML) + "\n\n";
            }
        }

        if (!noteContent.trim()) {
            return "";
        }

        // Get paper metadata
        const paperTitle = item.getField('title') as string || 'Untitled';
        const creators = item.getCreators();
        const authors = creators.map(c => `${c.firstName || ''} ${c.lastName || ''}`.trim()).join(', ');

        return this.generateColumnContentFromText(item, col, noteContent);
    }

    /**
     * Generate column content from text using AI
     */
    private static async generateColumnContentFromText(item: Zotero.Item, col: TableColumn, sourceText: string): Promise<string> {
        const paperTitle = item.getField('title') as string || 'Untitled';
        const responseLength = currentTableConfig?.responseLength || 100;

        // Build a targeted prompt using column title and description
        const lengthInstruction = responseLength === 0 ? "" : `Be concise (max ${responseLength} words).`;

        let columnPrompt = "";
        if (col.aiPrompt) {
            // Use both column name (title) and aiPrompt (description)
            columnPrompt = `For the column "${col.name}": ${col.aiPrompt} ${lengthInstruction}`;
        } else {
            // Fallback prompts for known columns
            switch (col.id) {
                case 'analysisMethodology':
                    columnPrompt = `For the column "${col.name}": Identify and briefly describe the analysis methodology or research method used in this paper. ${lengthInstruction}`;
                    break;
                default:
                    columnPrompt = `For the column "${col.name}": Extract relevant information. ${lengthInstruction}`;
            }
        }

        const systemPrompt = `You are extracting structured information from academic papers for a research table. Be concise and factual. Return ONLY the requested information, no explanations or preamble.`;

        const userPrompt = `Paper: "${paperTitle}"

Source content:
${sourceText.substring(0, 10000)}

Task: ${columnPrompt}`;

        // Get active model config (same as chat uses)
        const activeModel = getActiveModelConfig();
        if (!activeModel) {
            throw new Error("No active model configured. Please set up a model in settings.");
        }

        const configOverride = {
            apiURL: activeModel.apiURL,
            apiKey: activeModel.apiKey,
            model: activeModel.model
        };

        // Use non-streaming completion for simpler cell generation
        try {
            const messages: OpenAIMessage[] = [
                { role: "system", content: systemPrompt },
                { role: "user", content: userPrompt }
            ];

            // Use chatCompletionStream but collect the full response
            let fullResponse = "";
            await openAIService.chatCompletionStream(messages, {
                onToken: (token) => { fullResponse += token; },
                onComplete: () => { },
                onError: (err) => { throw err; }
            }, configOverride);

            return fullResponse.trim();
        } catch (e) {
            Zotero.debug(`[Seer AI] AI generation error: ${e}`);
            throw e;
        }
    }

    /**
     * Show cell detail modal for viewing/generating content
     */
    private static showCellDetailModal(doc: Document, row: TableRow, col: TableColumn, currentValue: string): void {
        // Remove any existing modal
        const existing = doc.getElementById("cell-detail-modal");
        if (existing) existing.remove();

        const win = doc.defaultView;
        const isDarkMode = (win as any)?.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
        const isComputed = col.type === 'computed';
        const hasNotes = row.noteIds && row.noteIds.length > 0;

        // Check for PDF
        const item = Zotero.Items.get(row.paperId);
        const attachments = item?.getAttachments() || [];
        const hasPDF = attachments.some((attId: number) => {
            const att = Zotero.Items.get(attId);
            return att && att.attachmentContentType === 'application/pdf';
        });

        // Create overlay
        const overlay = ztoolkit.UI.createElement(doc, "div", {
            properties: { id: "cell-detail-modal" },
            styles: {
                position: "fixed",
                top: "0", left: "0", width: "100%", height: "100%",
                backgroundColor: "rgba(0,0,0,0.5)",
                display: "flex", justifyContent: "center", alignItems: "center",
                zIndex: "10000"
            }
        });

        // Create dialog
        const dialog = ztoolkit.UI.createElement(doc, "div", {
            styles: {
                backgroundColor: `var(--background-primary, ${isDarkMode ? '#333' : '#fafafa'})`,
                color: `var(--text-primary, ${isDarkMode ? '#eee' : '#212121'})`,
                borderRadius: "12px",
                padding: "20px",
                maxWidth: "600px", width: "90%", maxHeight: "70vh",
                display: "flex", flexDirection: "column", gap: "16px",
                boxShadow: "0 8px 32px rgba(0,0,0,0.3)"
            }
        });

        // Header
        const header = ztoolkit.UI.createElement(doc, "div", {
            styles: { display: "flex", justifyContent: "space-between", alignItems: "center" }
        });
        const title = ztoolkit.UI.createElement(doc, "div", {
            properties: { innerText: col.name },
            styles: { fontSize: "16px", fontWeight: "600" }
        });
        header.appendChild(title);

        const closeX = ztoolkit.UI.createElement(doc, "button", {
            properties: { innerText: "✕" },
            styles: { background: "none", border: "none", fontSize: "18px", cursor: "pointer", color: "var(--text-secondary)" },
            listeners: [{ type: "click", listener: () => overlay.remove() }]
        });
        header.appendChild(closeX);
        dialog.appendChild(header);

        // Paper info
        const paperInfo = ztoolkit.UI.createElement(doc, "div", {
            properties: { innerText: row.paperTitle },
            styles: { fontSize: "13px", color: "var(--text-secondary)", fontStyle: "italic" }
        });
        dialog.appendChild(paperInfo);

        // Mode toggle (Preview / Edit)
        let isEditMode = !currentValue; // Start in edit mode if empty, preview if has content

        const modeToggle = ztoolkit.UI.createElement(doc, "div", {
            styles: {
                display: "flex",
                gap: "4px",
                marginBottom: "8px"
            }
        });

        const previewBtn = ztoolkit.UI.createElement(doc, "button", {
            properties: { innerText: "👁 Preview" },
            styles: {
                padding: "6px 12px",
                border: "1px solid var(--border-primary)",
                borderRadius: "4px",
                backgroundColor: !isEditMode ? "var(--highlight-primary)" : "var(--background-secondary)",
                color: !isEditMode ? "var(--highlight-text)" : "var(--text-primary)",
                cursor: "pointer",
                fontSize: "12px"
            }
        });

        const editBtn = ztoolkit.UI.createElement(doc, "button", {
            properties: { innerText: "✏️ Edit" },
            styles: {
                padding: "6px 12px",
                border: "1px solid var(--border-primary)",
                borderRadius: "4px",
                backgroundColor: isEditMode ? "var(--highlight-primary)" : "var(--background-secondary)",
                color: isEditMode ? "var(--highlight-text)" : "var(--text-primary)",
                cursor: "pointer",
                fontSize: "12px"
            }
        });

        modeToggle.appendChild(previewBtn);
        modeToggle.appendChild(editBtn);
        dialog.appendChild(modeToggle);

        // Content container to hold either preview or textarea
        const contentContainer = ztoolkit.UI.createElement(doc, "div", {
            styles: {
                flex: "1",
                minHeight: "200px",
                display: "flex",
                flexDirection: "column"
            }
        });

        // Preview area (shows rendered markdown)
        const previewArea = ztoolkit.UI.createElement(doc, "div", {
            styles: {
                flex: "1",
                minHeight: "200px",
                padding: "12px",
                border: "1px solid var(--border-primary)",
                borderRadius: "8px",
                fontSize: "13px",
                lineHeight: "1.6",
                backgroundColor: "var(--background-secondary)",
                overflowY: "auto",
                display: isEditMode ? "none" : "block"
            }
        });
        previewArea.innerHTML = currentValue ? parseMarkdown(currentValue) : '<span style="color: var(--text-tertiary); font-style: italic;">No content yet</span>';

        // Content area (editable textarea)
        const contentArea = ztoolkit.UI.createElement(doc, "textarea", {
            properties: { value: currentValue || "" },
            styles: {
                flex: "1", minHeight: "200px",
                padding: "12px",
                border: "1px solid var(--border-primary)",
                borderRadius: "8px",
                resize: "vertical",
                fontSize: "13px",
                lineHeight: "1.6",
                fontFamily: "inherit",
                backgroundColor: "var(--background-secondary)",
                display: isEditMode ? "block" : "none"
            }
        }) as HTMLTextAreaElement;

        contentContainer.appendChild(previewArea);
        contentContainer.appendChild(contentArea);

        // Toggle handlers
        const updateModeStyles = () => {
            previewBtn.style.backgroundColor = !isEditMode ? "var(--highlight-primary)" : "var(--background-secondary)";
            previewBtn.style.color = !isEditMode ? "var(--highlight-text)" : "var(--text-primary)";
            editBtn.style.backgroundColor = isEditMode ? "var(--highlight-primary)" : "var(--background-secondary)";
            editBtn.style.color = isEditMode ? "var(--highlight-text)" : "var(--text-primary)";
            previewArea.style.display = isEditMode ? "none" : "block";
            contentArea.style.display = isEditMode ? "block" : "none";
        };

        previewBtn.addEventListener("click", () => {
            // Update preview with current textarea content before switching
            previewArea.innerHTML = contentArea.value ? parseMarkdown(contentArea.value) : '<span style="color: var(--text-tertiary); font-style: italic;">No content yet</span>';
            isEditMode = false;
            updateModeStyles();
        });

        editBtn.addEventListener("click", () => {
            isEditMode = true;
            updateModeStyles();
            contentArea.focus();
        });
        dialog.appendChild(contentContainer);

        // Button row
        const buttonRow = ztoolkit.UI.createElement(doc, "div", {
            styles: { display: "flex", gap: "8px", justifyContent: "flex-end", flexWrap: "wrap" }
        });

        // Generate button (only for computed columns with sources)
        if (isComputed) {
            if (hasNotes || hasPDF) {
                const genBtn = ztoolkit.UI.createElement(doc, "button", {
                    properties: { innerText: hasNotes ? "⚡ Generate from Notes" : "📄 Generate from PDF" },
                    styles: {
                        padding: "10px 16px",
                        border: "none", borderRadius: "6px",
                        backgroundColor: "var(--highlight-primary)",
                        color: "var(--highlight-text)",
                        cursor: "pointer", fontWeight: "500"
                    },
                    listeners: [{
                        type: "click",
                        listener: async () => {
                            genBtn.innerText = "⏳ Generating...";
                            (genBtn as HTMLButtonElement).disabled = true;
                            try {
                                const content = hasNotes
                                    ? await this.generateColumnContent(item!, col, row.noteIds)
                                    : await this.generateFromPDF(item!, col);
                                contentArea.value = content || "(No content generated)";
                                // Also update preview area
                                previewArea.innerHTML = content ? parseMarkdown(content) : '<span style="color: var(--text-tertiary); font-style: italic;">No content generated</span>';
                            } catch (e) {
                                contentArea.value = `Error: ${e}`;
                                previewArea.innerHTML = `<span style="color: #c62828;">Error: ${e}</span>`;
                            }
                            genBtn.innerText = hasNotes ? "⚡ Regenerate" : "📄 Regenerate";
                            (genBtn as HTMLButtonElement).disabled = false;
                        }
                    }]
                });
                buttonRow.appendChild(genBtn);
            } else {
                const noSourceMsg = ztoolkit.UI.createElement(doc, "span", {
                    properties: { innerText: "No notes or PDFs to generate from" },
                    styles: { fontSize: "12px", color: "var(--text-tertiary)", alignSelf: "center" }
                });
                buttonRow.appendChild(noSourceMsg);
            }
        }

        // Save button
        const saveBtn = ztoolkit.UI.createElement(doc, "button", {
            properties: { innerText: "💾 Save" },
            styles: {
                padding: "10px 16px",
                border: "1px solid var(--border-primary)", borderRadius: "6px",
                backgroundColor: "var(--background-secondary)",
                color: "var(--text-primary)",
                cursor: "pointer"
            },
            listeners: [{
                type: "click",
                listener: async () => {
                    const value = contentArea.value;
                    row.data[col.id] = value;

                    // Also save to generatedData for persistence
                    if (currentTableConfig) {
                        if (!currentTableConfig.generatedData) {
                            currentTableConfig.generatedData = {};
                        }
                        if (!currentTableConfig.generatedData[row.paperId]) {
                            currentTableConfig.generatedData[row.paperId] = {};
                        }
                        currentTableConfig.generatedData[row.paperId][col.id] = value;

                        const tableStore = getTableStore();
                        await tableStore.saveConfig(currentTableConfig);
                    }

                    overlay.remove();
                    // Refresh table
                    if (currentContainer && currentItem) {
                        this.renderInterface(currentContainer, currentItem);
                    }
                }
            }]
        });
        buttonRow.appendChild(saveBtn);

        // Cancel button
        const cancelBtn = ztoolkit.UI.createElement(doc, "button", {
            properties: { innerText: "Cancel" },
            styles: {
                padding: "10px 16px",
                border: "1px solid var(--border-primary)", borderRadius: "6px",
                backgroundColor: "var(--background-primary)",
                cursor: "pointer"
            },
            listeners: [{ type: "click", listener: () => overlay.remove() }]
        });
        buttonRow.appendChild(cancelBtn);

        dialog.appendChild(buttonRow);
        overlay.appendChild(dialog);

        overlay.addEventListener("click", (e) => {
            if (e.target === overlay) overlay.remove();
        });

        if (doc.body) {
            doc.body.appendChild(overlay);
        } else {
            (doc.documentElement || doc).appendChild(overlay);
        }
    }

    /**
     * Generate content from PDF using DataLabs (processes PDF to create note first)
     */
    private static async generateFromPDF(item: Zotero.Item, col: TableColumn): Promise<string> {
        // Check if there's already a note we can use
        const existingNoteIds = item.getNotes();
        if (existingNoteIds.length > 0) {
            // Use existing notes
            return this.generateColumnContent(item, col, existingNoteIds);
        }

        // No notes - need to process PDF with DataLabs first
        const pdf = ocrService.getFirstPdfAttachment(item);
        if (!pdf) {
            throw new Error("No PDF attachment found");
        }

        // Check if DataLabs already processed this (note with same title as parent)
        if (ocrService.hasExistingNote(item)) {
            // Note exists but wasn't in noteIds? Refresh and try again
            const refreshedNoteIds = item.getNotes();
            if (refreshedNoteIds.length > 0) {
                return this.generateColumnContent(item, col, refreshedNoteIds);
            }
        }

        // Process PDF with DataLabs - this creates a note
        Zotero.debug("[Seer AI] Processing PDF with OCR...");
        await ocrService.convertToMarkdown(pdf);

        // Wait a moment for the note to be saved
        await new Promise(r => setTimeout(r, 500));

        // Get the newly created note IDs
        const newNoteIds = item.getNotes();
        if (newNoteIds.length === 0) {
            throw new Error("DataLabs processing completed but no note was created");
        }

        Zotero.debug(`[Seer AI] DataLabs created note, now generating content with ${newNoteIds.length} notes`);

        // Now generate content using the new notes
        return this.generateColumnContent(item, col, newNoteIds);
    }

    /**
     * Save current workspace to history
     */
    private static async saveWorkspaceToHistory(doc: Document): Promise<void> {
        try {
            if (!currentTableConfig) return;

            // Give the workspace a name if it doesn't have one
            const paperCount = currentTableConfig.addedPaperIds?.length || 0;
            if (currentTableConfig.name === 'Default Table' || !currentTableConfig.name) {
                currentTableConfig.name = `Workspace (${paperCount} papers) - ${new Date().toLocaleDateString()}`;
            }

            const tableStore = getTableStore();
            await tableStore.saveConfig(currentTableConfig);
            Zotero.debug(`[Seer AI] Workspace saved with ${paperCount} papers`);
        } catch (e) {
            Zotero.debug(`[Seer AI] Error saving workspace: ${e}`);
        }
    }

    /**
     * Show history picker to load a saved workspace
     */
    private static async showHistoryPicker(doc: Document, item: Zotero.Item): Promise<void> {
        // Remove existing picker
        const existing = doc.getElementById("history-picker");
        if (existing) {
            existing.remove();
            return;
        }

        const win = doc.defaultView;
        const isDarkMode = (win as any)?.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;

        // Create overlay
        const overlay = ztoolkit.UI.createElement(doc, "div", {
            properties: { id: "history-picker" },
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

        // Create dialog
        const dialog = ztoolkit.UI.createElement(doc, "div", {
            styles: {
                backgroundColor: `var(--background-primary, ${isDarkMode ? '#333' : '#fafafa'})`,
                color: `var(--text-primary, ${isDarkMode ? '#eee' : '#212121'})`,
                borderRadius: "12px",
                padding: "16px",
                maxWidth: "450px",
                width: "90%",
                maxHeight: "60vh",
                display: "flex",
                flexDirection: "column",
                gap: "12px",
                boxShadow: "0 8px 32px rgba(0,0,0,0.2)"
            }
        });

        // Title
        const title = ztoolkit.UI.createElement(doc, "div", {
            properties: { innerText: "📜 Saved Workspaces" },
            styles: { fontSize: "16px", fontWeight: "600" }
        });
        dialog.appendChild(title);

        // History list container
        const listContainer = ztoolkit.UI.createElement(doc, "div", {
            styles: {
                flex: "1",
                overflowY: "auto",
                border: "1px solid var(--border-primary)",
                borderRadius: "4px",
                maxHeight: "300px"
            }
        });

        // Load history
        const tableStore = getTableStore();
        const history = await tableStore.loadHistory();

        if (history.entries.length === 0) {
            const emptyMsg = ztoolkit.UI.createElement(doc, "div", {
                properties: { innerText: "No saved workspaces yet.\nSave your current workspace using 💾" },
                styles: { padding: "20px", textAlign: "center", color: "var(--text-tertiary)", whiteSpace: "pre-line" }
            });
            listContainer.appendChild(emptyMsg);
        } else {
            for (const entry of history.entries) {
                const row = ztoolkit.UI.createElement(doc, "div", {
                    styles: {
                        padding: "10px 12px",
                        borderBottom: "1px solid var(--border-primary)",
                        cursor: "pointer",
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center"
                    },
                    listeners: [{
                        type: "click",
                        listener: async () => {
                            // Load this config
                            currentTableConfig = { ...entry.config };
                            const tableStore = getTableStore();
                            await tableStore.saveConfig(currentTableConfig);
                            overlay.remove();
                            if (currentContainer && currentItem) {
                                this.renderInterface(currentContainer, currentItem);
                            }
                        }
                    }]
                });

                const info = ztoolkit.UI.createElement(doc, "div", {
                    styles: { flex: "1", overflow: "hidden" }
                });
                const nameEl = ztoolkit.UI.createElement(doc, "div", {
                    properties: { innerText: entry.config.name || 'Unnamed Workspace' },
                    styles: { fontSize: "13px", fontWeight: "500", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }
                });
                const metaEl = ztoolkit.UI.createElement(doc, "div", {
                    properties: { innerText: `${entry.config.addedPaperIds?.length || 0} papers • ${new Date(entry.usedAt).toLocaleDateString()}` },
                    styles: { fontSize: "11px", color: "var(--text-secondary)" }
                });
                info.appendChild(nameEl);
                info.appendChild(metaEl);
                row.appendChild(info);

                // Delete button
                const deleteBtn = ztoolkit.UI.createElement(doc, "span", {
                    properties: { innerText: "🗑" },
                    styles: { fontSize: "14px", color: "#c62828", padding: "4px 8px", cursor: "pointer" },
                    listeners: [{
                        type: "click",
                        listener: async (e: Event) => {
                            e.stopPropagation();
                            // Remove from history
                            const tableStore = getTableStore();
                            const currentHistory = await tableStore.loadHistory();
                            currentHistory.entries = currentHistory.entries.filter(h => h.config.id !== entry.config.id);
                            await tableStore.saveHistory(currentHistory);
                            row.remove();
                        }
                    }]
                });
                row.appendChild(deleteBtn);

                const loadIcon = ztoolkit.UI.createElement(doc, "span", {
                    properties: { innerText: "→" },
                    styles: { fontSize: "16px", color: "var(--highlight-primary)", padding: "4px" }
                });
                row.appendChild(loadIcon);

                row.addEventListener("mouseenter", () => { row.style.backgroundColor = "var(--background-secondary)"; });
                row.addEventListener("mouseleave", () => { row.style.backgroundColor = ""; });

                listContainer.appendChild(row);
            }
        }

        dialog.appendChild(listContainer);

        // Close button
        const buttonRow = ztoolkit.UI.createElement(doc, "div", {
            styles: { display: "flex", justifyContent: "flex-end", gap: "8px" }
        });
        const closeBtn = ztoolkit.UI.createElement(doc, "button", {
            properties: { innerText: "Close" },
            styles: {
                padding: "8px 16px",
                border: "1px solid var(--border-primary)",
                borderRadius: "6px",
                backgroundColor: "var(--background-secondary)",
                cursor: "pointer"
            },
            listeners: [{
                type: "click",
                listener: () => {
                    overlay.remove();
                }
            }]
        });
        buttonRow.appendChild(closeBtn);
        dialog.appendChild(buttonRow);

        overlay.appendChild(dialog);
        overlay.addEventListener("click", (e) => {
            if (e.target === overlay) {
                overlay.remove();
            }
        });

        if (doc.body) {
            doc.body.appendChild(overlay);
        } else {
            (doc.documentElement || doc).appendChild(overlay);
        }
    }

    /**
     * Start a fresh workspace
     */
    private static async startFreshWorkspace(doc: Document, item: Zotero.Item): Promise<void> {
        try {
            // Reset to default config with a new ID
            const tableStore = getTableStore();
            const now = new Date().toISOString();
            currentTableConfig = {
                id: `table_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                name: 'Default Table',
                columns: [...defaultColumns],
                sortBy: 'title',
                sortOrder: 'asc',
                filterQuery: '',
                responseLength: 100,
                filterLibraryId: null,
                filterCollectionId: null,
                addedPaperIds: [],
                createdAt: now,
                updatedAt: now,
            };
            await tableStore.saveConfig(currentTableConfig);

            // Re-render
            if (currentContainer && currentItem) {
                this.renderInterface(currentContainer, currentItem);
            }
            Zotero.debug('[Seer AI] Fresh workspace started');
        } catch (e) {
            Zotero.debug(`[Seer AI] Error starting fresh workspace: ${e}`);
        }
    }

    /**
     * Create response length slider control
     */
    private static createResponseLengthControl(doc: Document): HTMLElement {
        const container = ztoolkit.UI.createElement(doc, "div", {
            properties: { className: "response-length-container" },
            styles: {
                display: "flex",
                alignItems: "center",
                gap: "8px",
                padding: "4px 8px",
                backgroundColor: "var(--background-tertiary)",
                borderRadius: "4px"
            }
        });

        const label = ztoolkit.UI.createElement(doc, "span", {
            properties: { className: "response-length-label", innerText: "Response:" },
            styles: { fontSize: "11px", color: "var(--text-secondary)", whiteSpace: "nowrap" }
        });

        const slider = ztoolkit.UI.createElement(doc, "input", {
            attributes: { type: "range", min: "0", max: "4200", step: "100" },
            properties: { className: "response-length-slider" },
            styles: { width: "80px", cursor: "pointer" }
        }) as HTMLInputElement;

        slider.value = String(currentTableConfig?.responseLength || 100);

        const getDisplayValue = (val: string) => {
            const num = parseInt(val, 10);
            return num >= 4192 ? "∞" : val;
        };

        const valueDisplay = ztoolkit.UI.createElement(doc, "span", {
            properties: { className: "response-length-value", innerText: getDisplayValue(slider.value) },
            styles: { fontSize: "11px", color: "var(--text-primary)", minWidth: "30px" }
        });

        slider.addEventListener("input", async () => {
            const val = parseInt(slider.value, 10);
            valueDisplay.textContent = getDisplayValue(slider.value);
            if (currentTableConfig) {
                // 4192+ means unlimited (store as 0)
                currentTableConfig.responseLength = val >= 4192 ? 0 : val;
                const tableStore = getTableStore();
                await tableStore.saveConfig(currentTableConfig);
            }
        });

        container.appendChild(label);
        container.appendChild(slider);
        container.appendChild(valueDisplay);

        return container;
    }

    /**
     * Create empty state for table
     */
    private static createTableEmptyState(doc: Document): HTMLElement {
        const emptyState = ztoolkit.UI.createElement(doc, "div", {
            properties: { className: "table-empty-state" },
            styles: {
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                padding: "40px 20px",
                color: "var(--text-tertiary)",
                textAlign: "center",
                gap: "8px"
            }
        });

        const icon = ztoolkit.UI.createElement(doc, "div", {
            properties: { className: "table-empty-state-icon", innerText: "📋" },
            styles: { fontSize: "32px", opacity: "0.5" }
        });

        const text = ztoolkit.UI.createElement(doc, "div", {
            properties: { className: "table-empty-state-text", innerText: "No papers with matching notes found. Add papers to your library with notes that share titles to see them here." },
            styles: { fontSize: "13px" }
        });

        emptyState.appendChild(icon);
        emptyState.appendChild(text);

        return emptyState;
    }

    /**
     * Create the papers table element
     */
    private static createPapersTable(doc: Document, tableData: TableData): HTMLElement {
        const table = ztoolkit.UI.createElement(doc, "table", {
            properties: { className: "papers-table" },
            styles: {
                width: "100%",
                borderCollapse: "collapse",
                fontSize: "12px",
                tableLayout: "fixed"
            }
        });

        // Create header
        const thead = ztoolkit.UI.createElement(doc, "thead", {});
        const headerRow = ztoolkit.UI.createElement(doc, "tr", {});

        const columns = currentTableConfig?.columns || defaultColumns;
        columns.filter(col => col.visible).forEach(col => {
            const th = ztoolkit.UI.createElement(doc, "th", {
                properties: {
                    innerText: col.name,
                    className: `${col.sortable ? 'sortable' : ''} ${currentTableConfig?.sortBy === col.id ? `sort-${currentTableConfig.sortOrder}` : ''}`
                },
                styles: {
                    position: "relative",
                    top: "0",
                    backgroundColor: "var(--background-secondary)",
                    borderBottom: "1px solid rgba(128, 128, 128, 0.4)",
                    borderRight: "1px solid rgba(128, 128, 128, 0.4)",
                    padding: "8px 10px",
                    textAlign: "left",
                    fontWeight: "600",
                    width: `${col.width}px`,
                    minWidth: `${col.minWidth}px`,
                    cursor: col.sortable ? "pointer" : "default",
                    userSelect: "none",
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis"
                },
                listeners: col.sortable ? [{
                    type: "click",
                    listener: async () => {
                        if (currentTableConfig) {
                            if (currentTableConfig.sortBy === col.id) {
                                currentTableConfig.sortOrder = currentTableConfig.sortOrder === 'asc' ? 'desc' : 'asc';
                            } else {
                                currentTableConfig.sortBy = col.id;
                                currentTableConfig.sortOrder = 'asc';
                            }
                            const tableStore = getTableStore();
                            await tableStore.saveConfig(currentTableConfig);
                            if (currentContainer && currentItem) {
                                this.renderInterface(currentContainer, currentItem);
                            }
                        }
                    }
                }] : []
            });

            // Add resize handle if resizable
            if (col.resizable) {
                const resizeHandle = ztoolkit.UI.createElement(doc, "div", {
                    properties: { className: "column-resize-handle" },
                    styles: {
                        position: "absolute",
                        right: "0",
                        top: "0",
                        bottom: "0",
                        width: "6px",
                        cursor: "col-resize",
                        backgroundColor: "transparent"
                    }
                });

                // Hover effect
                resizeHandle.addEventListener("mouseenter", () => {
                    resizeHandle.style.backgroundColor = "var(--highlight-primary)";
                });
                resizeHandle.addEventListener("mouseleave", () => {
                    resizeHandle.style.backgroundColor = "transparent";
                });

                // Drag to resize
                resizeHandle.addEventListener("mousedown", (e: MouseEvent) => {
                    e.preventDefault();
                    e.stopPropagation();

                    const startX = e.clientX;
                    const startWidth = col.width;
                    const colIndex = columns.findIndex(c => c.id === col.id);

                    const onMouseMove = (moveE: MouseEvent) => {
                        const delta = moveE.clientX - startX;
                        const newWidth = Math.max(col.minWidth, startWidth + delta);
                        col.width = newWidth;

                        // Update header width
                        th.style.width = `${newWidth}px`;

                        // Update all cells in this column
                        const cells = table.querySelectorAll(`td:nth-child(${colIndex + 1}), th:nth-child(${colIndex + 1})`);
                        cells.forEach((cell: Element) => {
                            (cell as HTMLElement).style.width = `${newWidth}px`;
                            (cell as HTMLElement).style.maxWidth = `${newWidth}px`;
                        });
                    };

                    const onMouseUp = async () => {
                        doc.removeEventListener("mousemove", onMouseMove);
                        doc.removeEventListener("mouseup", onMouseUp);

                        // Save column widths
                        if (currentTableConfig) {
                            const tableStore = getTableStore();
                            await tableStore.saveConfig(currentTableConfig);
                        }
                    };

                    doc.addEventListener("mousemove", onMouseMove);
                    doc.addEventListener("mouseup", onMouseUp);
                });

                th.style.position = "relative";
                th.appendChild(resizeHandle);
            }

            headerRow.appendChild(th);
        });

        // Add Actions header cell
        const actionsHeader = ztoolkit.UI.createElement(doc, "th", {
            properties: { innerText: "💾" },
            attributes: { title: "Save row as note" },
            styles: {
                padding: "8px 6px",
                backgroundColor: "var(--background-secondary)",
                borderBottom: "2px solid rgba(128, 128, 128, 0.5)",
                borderRight: "1px solid rgba(128, 128, 128, 0.4)",
                fontSize: "12px",
                fontWeight: "600",
                width: "40px",
                textAlign: "center"
            }
        });
        headerRow.appendChild(actionsHeader);

        thead.appendChild(headerRow);
        table.appendChild(thead);

        // Create body
        const tbody = ztoolkit.UI.createElement(doc, "tbody", {});

        tableData.rows.forEach(row => {
            const tr = ztoolkit.UI.createElement(doc, "tr", {
                properties: { className: tableData.selectedRowIds.has(row.paperId) ? "selected" : "" },
                attributes: { "data-paper-id": String(row.paperId) },
                listeners: [{
                    type: "click",
                    listener: () => {
                        // Toggle selection
                        if (tableData.selectedRowIds.has(row.paperId)) {
                            tableData.selectedRowIds.delete(row.paperId);
                        } else {
                            tableData.selectedRowIds.add(row.paperId);
                        }
                        tr.classList.toggle("selected");
                    }
                }]
            });

            columns.filter(col => col.visible).forEach(col => {
                const cellValue = row.data[col.id] || "";
                const isComputed = col.type === 'computed';
                const isEmpty = !cellValue || cellValue.trim() === '';

                const td = ztoolkit.UI.createElement(doc, "td", {
                    styles: {
                        padding: "8px 10px",
                        borderBottom: "1px solid rgba(128, 128, 128, 0.4)",
                        borderRight: "1px solid rgba(128, 128, 128, 0.4)",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "normal",           // Allow wrapping
                        wordBreak: "break-word",        // Break long words
                        maxWidth: `${col.width}px`,
                        width: `${col.width}px`,
                        maxHeight: "60px",              // Limit to ~3 lines
                        lineHeight: "1.4",
                        verticalAlign: "top",
                        cursor: "pointer",
                        // Style title column as a link
                        color: col.id === 'title' ? "var(--highlight-primary)" : "inherit"
                    }
                });

                // Add hover effect for title column
                if (col.id === 'title') {
                    td.addEventListener("mouseenter", () => { td.style.textDecoration = "underline"; });
                    td.addEventListener("mouseleave", () => { td.style.textDecoration = "none"; });
                }

                // Show content or empty indicator
                if (isEmpty && isComputed) {
                    const hasNotes = row.noteIds && row.noteIds.length > 0;
                    // Check for PDF to show appropriate indicator
                    const itemForIndicator = Zotero.Items.get(row.paperId);
                    const attachmentsForIndicator = itemForIndicator?.getAttachments() || [];
                    const hasPDFForIndicator = attachmentsForIndicator.some((attId: number) => {
                        const att = Zotero.Items.get(attId);
                        return att && (att.attachmentContentType === 'application/pdf' || att.attachmentPath?.toLowerCase().endsWith('.pdf'));
                    });

                    if (hasNotes) {
                        td.innerHTML = `<span style="color: var(--highlight-primary); font-size: 11px;">⚡ Click to generate</span>`;
                    } else if (hasPDFForIndicator) {
                        td.innerHTML = `<span style="color: var(--highlight-primary); font-size: 11px;">📄 Click to process PDF</span>`;
                    } else {
                        td.innerHTML = `<span style="color: var(--text-tertiary); font-size: 11px; font-style: italic;">Empty - no notes/PDF</span>`;
                    }
                } else {
                    // Render markdown in cell content
                    td.innerHTML = parseMarkdown(cellValue);
                }

                // Click behavior depends on CURRENT cell content (not render-time state)
                td.addEventListener("click", async (e) => {
                    e.stopPropagation();

                    // Special handling for title column - open PDF
                    if (col.id === 'title') {
                        const item = Zotero.Items.get(row.paperId);
                        if (item) {
                            const attachmentIds = item.getAttachments();
                            for (const attachId of attachmentIds) {
                                const attachment = Zotero.Items.get(attachId);
                                if (attachment && attachment.isPDFAttachment && attachment.isPDFAttachment()) {
                                    // Open the PDF in Zotero's reader
                                    await Zotero.Reader.open(attachment.id);
                                    return;
                                }
                            }
                            // Fallback: if no PDF, just select the item in the library
                            const zp = Zotero.getActiveZoteroPane();
                            if (zp) {
                                zp.selectItem(item.id);
                            }
                        }
                        return;
                    }

                    // Check current state at click time (not the captured isEmpty)
                    const currentValue = row.data[col.id] || "";
                    const currentlyEmpty = !currentValue || currentValue.trim() === '';
                    const hasNotes = row.noteIds && row.noteIds.length > 0;

                    // Check for PDF
                    const item = Zotero.Items.get(row.paperId);
                    const attachments = item?.getAttachments() || [];
                    const hasPDF = attachments.some((attId: number) => {
                        const att = Zotero.Items.get(attId);
                        return att && (att.attachmentContentType === 'application/pdf' || att.attachmentPath?.toLowerCase().endsWith('.pdf'));
                    });

                    if (currentlyEmpty && isComputed) {
                        // Empty computed cell - auto-generate immediately
                        if (hasNotes || hasPDF) {
                            // Show generating indicator
                            td.innerHTML = `<span style="color: var(--text-tertiary); font-size: 11px;">⏳ ${hasNotes ? 'Generating...' : 'Processing PDF with OCR...'}</span>`;
                            td.style.cursor = "wait";

                            try {
                                if (item) {
                                    const content = hasNotes
                                        ? await this.generateColumnContent(item, col, row.noteIds)
                                        : await this.generateFromPDF(item, col);

                                    // Update row data
                                    row.data[col.id] = content;
                                    td.innerHTML = content ? parseMarkdown(content) : '<span style="color: var(--text-tertiary); font-size: 11px; font-style: italic;">(No content)</span>';
                                    td.style.cursor = "pointer";

                                    // Save to generatedData for persistence
                                    if (currentTableConfig) {
                                        if (!currentTableConfig.generatedData) {
                                            currentTableConfig.generatedData = {};
                                        }
                                        if (!currentTableConfig.generatedData[row.paperId]) {
                                            currentTableConfig.generatedData[row.paperId] = {};
                                        }
                                        currentTableConfig.generatedData[row.paperId][col.id] = content;

                                        const tableStore = getTableStore();
                                        await tableStore.saveConfig(currentTableConfig);
                                    }
                                }
                            } catch (err) {
                                td.innerHTML = `<span style="color: #c62828; font-size: 11px;">Error: ${err}</span>`;
                                td.style.cursor = "pointer";
                            }
                        }
                    } else {
                        // Cell has content or is not computed - show modal to view/regenerate
                        this.showCellDetailModal(doc, row, col, row.data[col.id] || "");
                    }
                });

                tr.appendChild(td);
            });

            // Add actions cell with save button
            const actionsCell = ztoolkit.UI.createElement(doc, "td", {
                styles: {
                    padding: "4px 8px",
                    borderBottom: "1px solid rgba(128, 128, 128, 0.4)",
                    borderRight: "1px solid rgba(128, 128, 128, 0.4)",
                    width: "40px",
                    textAlign: "center",
                    verticalAlign: "middle"
                }
            });

            const saveRowBtn = ztoolkit.UI.createElement(doc, "button", {
                properties: { innerText: "💾" },
                attributes: { title: "Save this row as a note attached to the paper" },
                styles: {
                    background: "none",
                    border: "none",
                    fontSize: "14px",
                    cursor: "pointer",
                    padding: "4px",
                    borderRadius: "4px",
                    transition: "background-color 0.15s"
                },
                listeners: [{
                    type: "click",
                    listener: async (e: Event) => {
                        e.stopPropagation();
                        const btn = e.target as HTMLElement;
                        btn.innerText = "⏳";
                        btn.style.cursor = "wait";

                        const cols = currentTableConfig?.columns || defaultColumns;
                        const success = await this.saveRowAsNote(row, cols);

                        if (success) {
                            btn.innerText = "✓";
                            btn.style.color = "#4CAF50";
                            setTimeout(() => {
                                btn.innerText = "💾";
                                btn.style.color = "";
                            }, 2000);
                        } else {
                            btn.innerText = "✕";
                            btn.style.color = "#c62828";
                            setTimeout(() => {
                                btn.innerText = "💾";
                                btn.style.color = "";
                            }, 2000);
                        }
                        btn.style.cursor = "pointer";
                    }
                }]
            });
            saveRowBtn.addEventListener("mouseenter", () => { saveRowBtn.style.backgroundColor = "rgba(128,128,128,0.2)"; });
            saveRowBtn.addEventListener("mouseleave", () => { saveRowBtn.style.backgroundColor = ""; });
            actionsCell.appendChild(saveRowBtn);
            tr.appendChild(actionsCell);

            tbody.appendChild(tr);
        });

        table.appendChild(tbody);

        return table;
    }

    // Debounce timer for table refresh
    private static tableRefreshTimer: ReturnType<typeof setTimeout> | null = null;

    /**
     * Debounce table refresh to avoid too-frequent re-renders
     */
    private static debounceTableRefresh(doc: Document, item: Zotero.Item): void {
        if (this.tableRefreshTimer) {
            clearTimeout(this.tableRefreshTimer);
        }
        this.tableRefreshTimer = setTimeout(async () => {
            if (currentContainer && currentItem) {
                // Just refresh the table, not the whole interface
                const tableWrapper = doc.querySelector('.table-wrapper');
                if (tableWrapper) {
                    const tableData = await this.loadTableData();
                    tableWrapper.innerHTML = '';
                    if (tableData.rows.length === 0) {
                        tableWrapper.appendChild(this.createTableEmptyState(doc));
                    } else {
                        tableWrapper.appendChild(this.createPapersTable(doc, tableData));
                    }
                }
            }
        }, 300);
    }

    /**
     * Load table data - find papers with notes that share titles
     */
    private static async loadTableData(): Promise<TableData> {
        const tableData: TableData = {
            rows: [],
            selectedRowIds: new Set(),
            isLoading: false
        };

        try {
            // Only show papers that have been manually added
            const addedIds = currentTableConfig?.addedPaperIds || [];

            if (addedIds.length === 0) {
                // Table starts empty - user needs to add papers
                return tableData;
            }

            // Get filter settings
            const filterQuery = currentTableConfig?.filterQuery?.toLowerCase() || '';

            for (const paperId of addedIds) {
                const item = Zotero.Items.get(paperId);
                if (!item || !item.isRegularItem()) continue;

                // Get paper metadata
                const paperTitle = item.getField('title') as string || 'Untitled';
                const creators = item.getCreators();
                const authorNames = creators.map(c => `${c.firstName || ''} ${c.lastName || ''}`.trim()).join(', ') || 'Unknown';
                const year = item.getField('year') as string || '';

                // Apply search filter
                if (filterQuery &&
                    !paperTitle.toLowerCase().includes(filterQuery) &&
                    !authorNames.toLowerCase().includes(filterQuery) &&
                    !year.toLowerCase().includes(filterQuery)) {
                    continue;
                }

                // Get note count for sources column
                const noteIDs = item.getNotes();

                // Load any persisted generated data for this paper
                const persistedData = currentTableConfig?.generatedData?.[item.id] || {};

                tableData.rows.push({
                    paperId: item.id,
                    paperTitle: paperTitle,
                    noteIds: noteIDs,
                    noteTitle: '', // Not used in manual add mode
                    data: {
                        title: paperTitle,
                        author: authorNames,
                        year: year,
                        sources: String(noteIDs.length),
                        analysisMethodology: persistedData['analysisMethodology'] || '',
                        // Merge any other persisted computed columns
                        ...persistedData
                    }
                });
            }

            // Sort
            const sortBy = currentTableConfig?.sortBy || 'title';
            const sortOrder = currentTableConfig?.sortOrder || 'asc';
            tableData.rows.sort((a, b) => {
                const aVal = a.data[sortBy] || '';
                const bVal = b.data[sortBy] || '';
                const cmp = aVal.localeCompare(bVal);
                return sortOrder === 'asc' ? cmp : -cmp;
            });

        } catch (e) {
            Zotero.debug(`[Seer AI] Error loading table data: ${e}`);
            tableData.error = String(e);
        }

        return tableData;
    }

    /**
     * Show column manager modal for adding/removing columns
     */
    private static showColumnManagerModal(doc: Document, item: Zotero.Item): void {
        // Remove existing modal if any
        const existing = doc.getElementById('column-manager-modal');
        if (existing) {
            existing.remove();
            return;
        }

        const win = doc.defaultView;
        const isDarkMode = (win as any)?.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;

        // Create modal overlay
        const overlay = ztoolkit.UI.createElement(doc, 'div', {
            properties: { id: 'column-manager-modal' },
            styles: {
                position: 'fixed',
                top: '0',
                left: '0',
                width: '100%',
                height: '100%',
                backgroundColor: 'rgba(0,0,0,0.5)',
                display: 'flex',
                justifyContent: 'center',
                alignItems: 'center',
                zIndex: '10000'
            }
        });

        // Create dialog
        const dialog = ztoolkit.UI.createElement(doc, 'div', {
            styles: {
                backgroundColor: `var(--background-primary, ${isDarkMode ? '#333333' : '#fafafa'})`,
                color: `var(--text-primary, ${isDarkMode ? '#eeeeee' : '#212121'})`,
                borderRadius: '12px',
                padding: '20px',
                maxWidth: '400px',
                width: '90%',
                maxHeight: '80vh',
                display: 'flex',
                flexDirection: 'column',
                gap: '12px',
                boxShadow: '0 8px 32px rgba(0,0,0,0.2)'
            }
        });

        // Title
        const title = ztoolkit.UI.createElement(doc, 'div', {
            properties: { innerText: '⚙️ Manage Columns' },
            styles: { fontSize: '16px', fontWeight: '600', marginBottom: '8px' }
        });
        dialog.appendChild(title);

        // --- Presets Section ---
        const presetSection = ztoolkit.UI.createElement(doc, 'div', {
            styles: {
                display: 'flex',
                gap: '8px',
                marginBottom: '12px',
                padding: '12px',
                backgroundColor: 'var(--background-secondary)',
                borderRadius: '6px',
                border: '1px solid var(--border-primary)',
                flexWrap: 'wrap',
                alignItems: 'center'
            }
        });

        // Preset selector
        const presetSelect = ztoolkit.UI.createElement(doc, 'select', {
            styles: {
                flex: '1',
                padding: '6px',
                borderRadius: '4px',
                border: '1px solid var(--border-primary)',
                minWidth: '150px'
            }
        }) as HTMLSelectElement;

        const defaultOption = ztoolkit.UI.createElement(doc, 'option', {
            properties: { value: '', innerText: 'Select a preset...' }
        });
        presetSelect.appendChild(defaultOption);

        // Load presets function
        const loadPresetsList = async () => {
            const tableStore = getTableStore();
            const presets = await tableStore.loadPresets();

            // Clear except default
            while (presetSelect.options.length > 1) {
                presetSelect.remove(1);
            }

            presets.forEach(p => {
                const opt = ztoolkit.UI.createElement(doc, 'option', {
                    properties: { value: p.id, innerText: p.name }
                });
                presetSelect.appendChild(opt);
            });
            return presets;
        };
        // Initial load
        loadPresetsList();

        // Load Button
        const loadPresetBtn = ztoolkit.UI.createElement(doc, 'button', {
            properties: { innerText: '📥 Load' },
            styles: {
                padding: '6px 12px',
                border: '1px solid var(--border-primary)',
                borderRadius: '4px',
                cursor: 'pointer',
                backgroundColor: 'var(--background-primary)'
            },
            listeners: [{
                type: 'click',
                listener: async () => {
                    const selectedId = presetSelect.value;
                    if (!selectedId) return;

                    const tableStore = getTableStore();
                    const presets = await tableStore.loadPresets();
                    const preset = presets.find(p => p.id === selectedId);

                    if (preset && currentTableConfig) {
                        // confirm overwrite
                        const confirmLoad = doc.defaultView?.confirm(`Load preset "${preset.name}"? This will replace current columns.`);
                        if (confirmLoad) {
                            currentTableConfig.columns = [...preset.columns];
                            await tableStore.saveConfig(currentTableConfig);
                            overlay.remove();
                            if (currentContainer && currentItem) {
                                this.renderInterface(currentContainer, currentItem);
                            }
                        }
                    }
                }
            }]
        });

        // Save Button
        const savePresetBtn = ztoolkit.UI.createElement(doc, 'button', {
            properties: { innerText: '💾 Save Current' },
            styles: {
                padding: '6px 12px',
                border: '1px solid var(--border-primary)',
                borderRadius: '4px',
                cursor: 'pointer',
                backgroundColor: 'var(--background-primary)'
            },
            listeners: [{
                type: 'click',
                listener: async () => {
                    if (!currentTableConfig) return;

                    const name = doc.defaultView?.prompt("Enter name for this column preset:", "My Custom Columns");
                    if (name) {
                        const newPreset: ColumnPreset = {
                            id: `preset_${Date.now()}`,
                            name: name,
                            columns: [...currentTableConfig.columns],
                            createdAt: new Date().toISOString()
                        };

                        const tableStore = getTableStore();
                        await tableStore.savePreset(newPreset);
                        await loadPresetsList(); // Refresh list
                        presetSelect.value = newPreset.id; // Select it
                        doc.defaultView?.alert(`Preset "${name}" saved!`);
                    }
                }
            }]
        });

        // Delete Button
        const deletePresetBtn = ztoolkit.UI.createElement(doc, 'button', {
            properties: { innerText: '🗑' },
            styles: {
                padding: '6px 12px',
                border: '1px solid var(--border-primary)',
                borderRadius: '4px',
                cursor: 'pointer',
                color: '#c62828',
                backgroundColor: 'var(--background-primary)'
            },
            listeners: [{
                type: 'click',
                listener: async () => {
                    const selectedId = presetSelect.value;
                    if (!selectedId) return;

                    const tableStore = getTableStore();
                    const presets = await tableStore.loadPresets();
                    const preset = presets.find(p => p.id === selectedId);

                    if (preset) {
                        const confirmDelete = doc.defaultView?.confirm(`Delete preset "${preset.name}"?`);
                        if (confirmDelete) {
                            await tableStore.deletePreset(selectedId);
                            await loadPresetsList();
                            presetSelect.value = "";
                        }
                    }
                }
            }]
        });

        presetSection.appendChild(presetSelect);
        presetSection.appendChild(loadPresetBtn);
        presetSection.appendChild(savePresetBtn);
        presetSection.appendChild(deletePresetBtn);

        dialog.appendChild(presetSection);
        // -------------------------

        // Column list
        const columnList = ztoolkit.UI.createElement(doc, 'div', {
            properties: { className: 'column-manager-list' },
            styles: {
                display: 'flex',
                flexDirection: 'column',
                gap: '4px',
                maxHeight: '300px',
                overflowY: 'auto'
            }
        });

        const columns = currentTableConfig?.columns || defaultColumns;
        columns.forEach(col => {
            const row = ztoolkit.UI.createElement(doc, 'label', {
                properties: { className: 'column-manager-item' },
                styles: {
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px',
                    padding: '8px',
                    borderRadius: '4px',
                    backgroundColor: 'var(--background-secondary)',
                    cursor: 'pointer'
                }
            });

            const checkbox = ztoolkit.UI.createElement(doc, 'input', {
                attributes: { type: 'checkbox' }
            }) as HTMLInputElement;
            checkbox.checked = col.visible;
            checkbox.addEventListener('change', async () => {
                col.visible = checkbox.checked;
                if (currentTableConfig) {
                    const tableStore = getTableStore();
                    await tableStore.saveConfig(currentTableConfig);
                }
            });

            const label = ztoolkit.UI.createElement(doc, 'span', {
                properties: { innerText: col.name },
                styles: { flex: '1', fontSize: '13px' }
            });

            row.appendChild(checkbox);
            row.appendChild(label);

            // Delete button (only for non-core columns)
            const coreColumns = ['title', 'author', 'year', 'sources'];
            if (!coreColumns.includes(col.id)) {
                const deleteBtn = ztoolkit.UI.createElement(doc, 'button', {
                    properties: { innerText: '🗑' },
                    styles: {
                        background: 'none',
                        border: 'none',
                        fontSize: '14px',
                        cursor: 'pointer',
                        color: '#c62828',
                        padding: '2px 6px'
                    },
                    listeners: [{
                        type: 'click',
                        listener: async (e: Event) => {
                            e.preventDefault();
                            e.stopPropagation();
                            if (currentTableConfig) {
                                currentTableConfig.columns = currentTableConfig.columns.filter(c => c.id !== col.id);
                                const tableStore = getTableStore();
                                await tableStore.saveConfig(currentTableConfig);
                                row.remove();
                            }
                        }
                    }]
                });
                row.appendChild(deleteBtn);
            }

            columnList.appendChild(row);
        });

        dialog.appendChild(columnList);

        // Add new column section
        const addSection = ztoolkit.UI.createElement(doc, 'div', {
            styles: {
                borderTop: '1px solid var(--border-primary)',
                paddingTop: '12px',
                marginTop: '8px'
            }
        });

        const addLabel = ztoolkit.UI.createElement(doc, 'div', {
            properties: { innerText: 'Add New Column:' },
            styles: { fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '8px' }
        });
        addSection.appendChild(addLabel);

        const newColumnInput = ztoolkit.UI.createElement(doc, 'input', {
            attributes: { type: 'text', placeholder: 'Column name (title)...' },
            styles: {
                width: '100%',
                padding: '8px',
                border: '1px solid var(--border-primary)',
                borderRadius: '4px',
                fontSize: '13px',
                marginBottom: '8px'
            }
        }) as HTMLInputElement;
        addSection.appendChild(newColumnInput);

        const descLabel = ztoolkit.UI.createElement(doc, 'div', {
            properties: { innerText: 'AI Prompt (what to extract):' },
            styles: { fontSize: '11px', color: 'var(--text-secondary)', marginBottom: '4px' }
        });
        addSection.appendChild(descLabel);

        const newColumnDesc = ztoolkit.UI.createElement(doc, 'textarea', {
            attributes: { placeholder: 'e.g. "Extract the main findings and conclusions from this paper"' },
            styles: {
                width: '100%',
                padding: '8px',
                border: '1px solid var(--border-primary)',
                borderRadius: '4px',
                fontSize: '12px',
                marginBottom: '8px',
                minHeight: '60px',
                resize: 'vertical'
            }
        }) as HTMLTextAreaElement;
        addSection.appendChild(newColumnDesc);

        const addColumnBtn = ztoolkit.UI.createElement(doc, 'button', {
            properties: { innerText: 'Add Column' },
            styles: {
                padding: '8px 16px',
                border: 'none',
                borderRadius: '6px',
                backgroundColor: 'var(--highlight-primary)',
                color: 'var(--highlight-text)',
                cursor: 'pointer',
                fontWeight: '600',
                width: '100%'
            },
            listeners: [{
                type: 'click',
                listener: async () => {
                    const name = newColumnInput.value.trim();
                    const aiPrompt = newColumnDesc.value.trim();
                    if (name && currentTableConfig) {
                        const newColumn: TableColumn = {
                            id: `custom_${Date.now()}`,
                            name,
                            width: 150,
                            minWidth: 80,
                            visible: true,
                            sortable: false,
                            resizable: true,
                            type: 'computed',  // AI-generated column
                            aiPrompt: aiPrompt || `Extract information related to "${name}" from this paper.`
                        };
                        currentTableConfig.columns.push(newColumn);
                        const tableStore = getTableStore();
                        await tableStore.saveConfig(currentTableConfig);
                        overlay.remove();
                        if (currentContainer && currentItem) {
                            this.renderInterface(currentContainer, currentItem);
                        }
                    }
                }
            }]
        });
        addSection.appendChild(addColumnBtn);
        dialog.appendChild(addSection);

        // Button row
        const buttonRow = ztoolkit.UI.createElement(doc, 'div', {
            styles: { display: 'flex', gap: '8px', justifyContent: 'flex-end', marginTop: '8px' }
        });

        const closeBtn = ztoolkit.UI.createElement(doc, 'button', {
            properties: { innerText: 'Done' },
            styles: {
                padding: '8px 16px',
                border: '1px solid var(--border-primary)',
                borderRadius: '6px',
                backgroundColor: 'var(--background-secondary)',
                cursor: 'pointer'
            },
            listeners: [{
                type: 'click',
                listener: () => {
                    overlay.remove();
                    if (currentContainer && currentItem) {
                        this.renderInterface(currentContainer, currentItem);
                    }
                }
            }]
        });
        buttonRow.appendChild(closeBtn);
        dialog.appendChild(buttonRow);

        overlay.appendChild(dialog);

        // Close on overlay click
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) {
                overlay.remove();
                if (currentContainer && currentItem) {
                    this.renderInterface(currentContainer, currentItem);
                }
            }
        });

        // Append to body
        if (doc.body) {
            doc.body.appendChild(overlay);
        } else {
            (doc.documentElement || doc).appendChild(overlay);
        }
    }

    /**
     * Export table data to CSV
     */
    private static async exportTableToCSV(): Promise<void> {
        try {
            const tableData = await this.loadTableData();
            if (tableData.rows.length === 0) {
                Zotero.debug('[Seer AI] No data to export');
                return;
            }

            const columns = currentTableConfig?.columns.filter(c => c.visible) || defaultColumns.filter(c => c.visible);

            // Build CSV header
            const header = columns.map(c => `"${c.name}"`).join(',');

            // Build CSV rows
            const rows = tableData.rows.map(row => {
                return columns.map(col => {
                    const value = row.data[col.id] || '';
                    // Escape quotes and wrap in quotes
                    return `"${value.replace(/"/g, '""')}"`;
                }).join(',');
            });

            const csvContent = [header, ...rows].join('\n');

            // Create file path
            const filename = `papers_table_${new Date().toISOString().replace(/[:.]/g, '-')}.csv`;
            const downloadsDir = PathUtils.join(Zotero.DataDirectory.dir, 'seerai', 'exports');

            // Ensure directory exists
            if (!(await IOUtils.exists(downloadsDir))) {
                await IOUtils.makeDirectory(downloadsDir, { ignoreExisting: true });
            }

            const filepath = PathUtils.join(downloadsDir, filename);
            const encoder = new TextEncoder();
            await IOUtils.write(filepath, encoder.encode(csvContent));

            Zotero.debug(`[Seer AI] Table exported to: ${filepath}`);

            // Show success notification
            const progressWindow = new Zotero.ProgressWindow({ closeOnClick: true });
            progressWindow.changeHeadline('Export Complete');
            progressWindow.addDescription(`Table exported to:\n${filepath}`);
            progressWindow.show();
            progressWindow.startCloseTimer(3000);

        } catch (e) {
            Zotero.debug(`[Seer AI] Error exporting table: ${e}`);
        }
    }

    /**
     * Find existing "Tables" note for a given paper item
     * Returns the note item if found, null otherwise
     */
    private static findExistingTablesNote(parentItemId: number): Zotero.Item | null {
        try {
            const parentItem = Zotero.Items.get(parentItemId);
            if (!parentItem || !parentItem.isRegularItem()) return null;

            const noteIDs = parentItem.getNotes();
            for (const noteID of noteIDs) {
                const note = Zotero.Items.get(noteID);
                if (note) {
                    const noteContent = note.getNote();
                    // Check if note has the Tables marker
                    if (noteContent.includes('<h2>📊 Tables')) {
                        return note as Zotero.Item;
                    }
                }
            }
            return null;
        } catch (e) {
            Zotero.debug(`[Seer AI] Error finding Tables note: ${e}`);
            return null;
        }
    }

    /**
     * Parse existing table data from a Tables note
     * Returns a map of columnId -> value
     */
    private static parseTablesNoteContent(noteContent: string): Record<string, string> {
        const data: Record<string, string> = {};
        try {
            // Extract table rows using regex
            // Format: <tr><td>ColumnName</td><td>Value</td></tr>
            const rowRegex = /<tr>\s*<td[^>]*>([^<]+)<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<\/tr>/gi;
            let match;
            while ((match = rowRegex.exec(noteContent)) !== null) {
                const columnName = match[1].trim();
                const value = match[2].trim();
                // Use column name as key (we'll match by name)
                data[columnName] = value;
            }
        } catch (e) {
            Zotero.debug(`[Seer AI] Error parsing Tables note: ${e}`);
        }
        return data;
    }

    /**
     * Generate HTML table content for a row
     */
    private static generateTablesNoteHtml(paperTitle: string, row: TableRow, columns: TableColumn[]): string {
        const timestamp = new Date().toLocaleString();

        let tableRows = '';
        for (const col of columns) {
            if (!col.visible) continue;
            // Skip non-data columns like title (already in header)
            if (col.id === 'title') continue;

            const value = row.data[col.id] || '';
            const escapedValue = value
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/\n/g, '<br/>');

            tableRows += `    <tr><td style="padding: 8px; border: 1px solid #ddd; font-weight: 600;">${col.name}</td><td style="padding: 8px; border: 1px solid #ddd;">${escapedValue}</td></tr>\n`;
        }

        return `<h2>📊 Tables - ${paperTitle.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</h2>
<table style="border-collapse: collapse; width: 100%; margin: 10px 0;">
  <thead>
    <tr style="background: #f5f5f5;">
      <th style="padding: 8px; border: 1px solid #ddd; text-align: left;">Column</th>
      <th style="padding: 8px; border: 1px solid #ddd; text-align: left;">Value</th>
    </tr>
  </thead>
  <tbody>
${tableRows}  </tbody>
</table>
<p style="color: #888; font-size: 11px;"><em>Last updated: ${timestamp}</em></p>`;
    }

    /**
     * Save a single table row as a Zotero note attached to the source paper
     * If a Tables note already exists, merges new columns without duplicating
     */
    private static async saveRowAsNote(row: TableRow, columns: TableColumn[]): Promise<boolean> {
        try {
            const parentItem = Zotero.Items.get(row.paperId);
            if (!parentItem || !parentItem.isRegularItem()) {
                Zotero.debug(`[Seer AI] Cannot save note: Invalid parent item ${row.paperId}`);
                return false;
            }

            const paperTitle = parentItem.getField('title') as string || 'Untitled';

            // Check for existing Tables note
            const existingNote = this.findExistingTablesNote(row.paperId);

            if (existingNote) {
                // Merge: Parse existing data and update with new columns
                const existingData = this.parseTablesNoteContent(existingNote.getNote());

                // Create merged row data - preserve existing values, add new ones
                const mergedData: TableRow = {
                    ...row,
                    data: { ...row.data }
                };

                // For each column, if existing note has a value and current row doesn't, use existing
                for (const colName in existingData) {
                    const col = columns.find(c => c.name === colName);
                    if (col && (!mergedData.data[col.id] || mergedData.data[col.id].trim() === '')) {
                        mergedData.data[col.id] = existingData[colName];
                    }
                }

                // Generate updated HTML
                const newContent = this.generateTablesNoteHtml(paperTitle, mergedData, columns);
                existingNote.setNote(newContent);
                await existingNote.saveTx();

                Zotero.debug(`[Seer AI] Updated existing Tables note for: ${paperTitle}`);
            } else {
                // Create new note
                const note = new Zotero.Item('note');
                note.libraryID = parentItem.libraryID;
                note.parentID = parentItem.id;

                const noteContent = this.generateTablesNoteHtml(paperTitle, row, columns);
                note.setNote(noteContent);
                await note.saveTx();

                Zotero.debug(`[Seer AI] Created new Tables note for: ${paperTitle}`);
            }

            return true;
        } catch (e) {
            Zotero.debug(`[Seer AI] Error saving row as note: ${e}`);
            return false;
        }
    }

    /**
     * Save all table rows as notes (batch operation)
     */
    private static async saveAllRowsAsNotes(doc: Document): Promise<void> {
        try {
            const tableData = await this.loadTableData();
            if (tableData.rows.length === 0) {
                Zotero.debug('[Seer AI] No rows to save as notes');
                return;
            }

            const columns = currentTableConfig?.columns || defaultColumns;

            // Show progress
            const progressWindow = new Zotero.ProgressWindow({ closeOnClick: true });
            progressWindow.changeHeadline('Saving Table as Notes');
            progressWindow.addDescription('Processing...');
            progressWindow.show();

            let saved = 0;
            let failed = 0;

            for (const row of tableData.rows) {
                const success = await this.saveRowAsNote(row, columns);
                if (success) {
                    saved++;
                } else {
                    failed++;
                }
            }

            progressWindow.changeHeadline('Save Complete');
            progressWindow.addDescription(`Saved: ${saved} | Failed: ${failed}`);
            progressWindow.startCloseTimer(3000);

            Zotero.debug(`[Seer AI] Batch save complete: ${saved} saved, ${failed} failed`);
        } catch (e) {
            Zotero.debug(`[Seer AI] Error in batch save: ${e}`);
        }
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
                backgroundColor: "var(--background-secondary)",
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
                styles: { fontSize: "11px", color: "var(--text-secondary)", marginRight: "4px", fontWeight: "600" }
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
                properties: {
                    innerText: `📝 ${states.notes.length} notes included`,
                    className: "chip chip-notes-summary"
                },
                styles: {
                    display: "inline-flex",
                    alignItems: "center",
                    padding: "3px 8px",
                    borderRadius: "12px",
                    fontSize: "11px"
                }
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
                border: "1px dashed var(--button-dashed-border-blue)",
                borderRadius: "4px",
                backgroundColor: "transparent",
                cursor: "pointer",
                color: "var(--button-dashed-text-blue)"
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
                border: "1px dashed var(--button-dashed-border-orange)",
                borderRadius: "4px",
                backgroundColor: "transparent",
                cursor: "pointer",
                color: "var(--button-dashed-text-orange)"
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

        // Clear all button (allow clearing even single items)
        if (stateManager.hasSelections()) {
            const clearAllBtn = ztoolkit.UI.createElement(doc, "button", {
                properties: { innerText: "✕ Clear All" },
                styles: {
                    padding: "4px 8px",
                    fontSize: "10px",
                    border: "none",
                    borderRadius: "4px",
                    backgroundColor: "var(--button-clear-background)",
                    cursor: "pointer",
                    color: "var(--button-clear-text)"
                },
                listeners: [{
                    type: "click",
                    listener: async () => {
                        stateManager.clearAll();
                        // Re-add current item based on selection mode (not in lock mode)
                        const mode = stateManager.getOptions().selectionMode;
                        if (mode !== 'lock' && currentItem) {
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



        const win = doc.defaultView;
        const isDarkMode = (win as any)?.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
        const dialog = ztoolkit.UI.createElement(doc, "div", {
            styles: {
                backgroundColor: `var(--background-primary, ${isDarkMode ? '#333333' : '#fafafa'})`,
                color: `var(--text-primary, ${isDarkMode ? '#eeeeee' : '#212121'})`,
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
            styles: { fontSize: "12px", color: "var(--text-secondary)" }
        });

        const filterSelect = ztoolkit.UI.createElement(doc, "select", {
            styles: {
                padding: "8px 12px",
                border: "1px solid var(--border-primary)",
                borderRadius: "6px",
                fontSize: "13px",
                backgroundColor: "var(--background-primary)",
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
                border: "1px solid var(--border-primary)",
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
                    styles: { padding: "12px", color: "var(--text-secondary)", textAlign: "center" }
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
                    styles: { padding: "12px", color: "var(--text-secondary)", textAlign: "center" }
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
                        backgroundColor: isChecked ? "var(--tag-checked-background)" : "transparent"
                    }
                });

                const checkbox = ztoolkit.UI.createElement(doc, "input", {
                    attributes: { type: "checkbox" }
                }) as HTMLInputElement;
                checkbox.checked = isChecked;

                checkbox.addEventListener("change", () => {
                    if (checkbox.checked) {
                        selectedTags.add(tagName);
                        tagRow.style.backgroundColor = "var(--tag-checked-background)";
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
                styles: { fontSize: "11px", color: "var(--text-tertiary)", padding: "8px", textAlign: "center" }
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
                border: "1px solid var(--border-primary)",
                borderRadius: "6px",
                backgroundColor: "var(--background-secondary)",
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
                backgroundColor: "var(--button-dashed-border-orange)",
                color: "var(--highlight-text)",
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

        // Append to body to inherit styles (Zotero adds 'dark' class to body)
        if (doc.body) {
            doc.body.appendChild(overlay);
            searchInput.focus();
        } else {
            (doc.documentElement || doc).appendChild(overlay);
            searchInput.focus();
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



        const win = doc.defaultView;
        const isDarkMode = (win as any)?.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
        const dialog = ztoolkit.UI.createElement(doc, "div", {
            styles: {
                backgroundColor: `var(--background-primary, ${isDarkMode ? '#333333' : '#fafafa'})`,
                color: `var(--text-primary, ${isDarkMode ? '#eeeeee' : '#212121'})`,
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
            styles: { fontSize: "12px", color: "var(--text-secondary)" }
        });

        const filterSelect = ztoolkit.UI.createElement(doc, "select", {
            styles: {
                padding: "8px 12px",
                border: "1px solid var(--border-primary)",
                borderRadius: "6px",
                fontSize: "13px",
                backgroundColor: "var(--background-primary)",
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
                border: "1px solid var(--border-primary)",
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
                    styles: { padding: "12px", color: "var(--text-secondary)", textAlign: "center" }
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
                    styles: { padding: "12px", color: "var(--text-secondary)", textAlign: "center" }
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
                        backgroundColor: isChecked ? "var(--paper-checked-background)" : (alreadyAdded ? "var(--paper-added-background)" : "transparent"),
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
                        (paperRow as HTMLElement).style.backgroundColor = "var(--paper-checked-background)";
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
                    styles: { fontSize: "11px", color: "var(--text-secondary)" }
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
                styles: { fontSize: "11px", color: "var(--text-tertiary)", padding: "8px", textAlign: "center" }
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
                border: "1px solid var(--border-primary)",
                borderRadius: "6px",
                backgroundColor: "var(--background-secondary)",
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
                backgroundColor: "var(--button-dashed-border-blue)",
                color: "var(--highlight-text)",
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

        // Append to body to inherit styles (Zotero adds 'dark' class to body)
        if (doc.body) {
            doc.body.appendChild(overlay);
            searchInput.focus();
        } else {
            (doc.documentElement || doc).appendChild(overlay);
            searchInput.focus();
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
            properties: {
                className: `chip ${config.className}`
            },
            styles: {
                display: "inline-flex",
                alignItems: "center",
                gap: "4px",
                padding: "3px 8px",
                borderRadius: "12px",
                fontSize: "11px",
                maxWidth: "180px",
                border: "1px solid"
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
                color: "var(--text-secondary)",
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
                border: "1px solid var(--border-primary)",
                borderRadius: "4px",
                backgroundColor: "var(--background-primary)",
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

        // Selection Mode Selector
        const stateManager = getChatStateManager();
        const modeContainer = ztoolkit.UI.createElement(doc, "div", {
            styles: { display: "flex", alignItems: "center", gap: "4px", marginLeft: "8px" }
        });

        const modeLabel = ztoolkit.UI.createElement(doc, "span", {
            properties: { innerText: "Mode:" },
            styles: { fontSize: "11px", opacity: "0.8" }
        });

        const modeSelect = ztoolkit.UI.createElement(doc, "select", {
            properties: { id: "selection-mode" },
            styles: {
                padding: "3px 6px",
                fontSize: "11px",
                border: "1px solid var(--border-primary)",
                borderRadius: "4px",
                backgroundColor: "var(--select-background)",
                color: "var(--text-primary)",
                cursor: "pointer"
            },
            listeners: [{
                type: "change",
                listener: async (e: Event) => {
                    const mode = (e.target as HTMLSelectElement).value as 'lock' | 'default' | 'explore';
                    stateManager.setOptions({ selectionMode: mode });
                    // If switching to default or explore mode, auto-add current item
                    if (mode !== 'lock' && currentItem) {
                        if (mode === 'default') {
                            stateManager.clearAll();
                        }
                        await this.addItemWithNotes(currentItem);
                    }
                }
            }]
        }) as HTMLSelectElement;

        // Populate mode options
        const currentMode = stateManager.getOptions().selectionMode;
        const modes = [
            { value: 'lock', label: '🔒 Lock', title: 'No items added automatically' },
            { value: 'default', label: '📌 Focus', title: 'Single item focus (switches)' },
            { value: 'explore', label: '📚 Explore', title: 'Add multiple items' }
        ];
        modes.forEach(m => {
            const opt = doc.createElement("option");
            opt.value = m.value;
            opt.textContent = m.label;
            opt.title = m.title;
            if (m.value === currentMode) opt.selected = true;
            modeSelect.appendChild(opt);
        });

        modeContainer.appendChild(modeLabel);
        modeContainer.appendChild(modeSelect);

        leftControls.appendChild(modelSelect);
        leftControls.appendChild(modeContainer);

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
                border: "1px solid var(--button-stop-border)",
                borderRadius: "4px",
                backgroundColor: "var(--button-stop-background)",
                color: "var(--button-stop-text)",
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
                border: "1px solid var(--button-clear-border)",
                borderRadius: "4px",
                backgroundColor: "var(--button-clear-background)",
                color: "var(--button-clear-text)",
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
                border: "1px solid var(--button-save-border)",
                borderRadius: "4px",
                backgroundColor: "var(--button-save-background)",
                color: "var(--button-save-text)",
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
                backgroundColor: "var(--image-preview-background)",
                borderRadius: "6px",
                border: "1px dashed var(--image-preview-border)"
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
                styles: { width: "100%", fontSize: "11px", color: "var(--image-preview-text)", marginBottom: "4px" }
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
                        border: "1px solid var(--border-primary)"
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
                border: "1px solid var(--border-primary)",
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
                backgroundColor: "var(--highlight-primary)",
                color: "var(--highlight-text)",
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

        this.appendMessage(messagesArea, "You", text, userMsg.id, true);

        input.value = "";
        input.disabled = true;
        this.isStreaming = true;

        // Show stop button
        const stopBtn = messagesArea.ownerDocument?.getElementById("stop-btn") as HTMLElement;
        if (stopBtn) stopBtn.style.display = "inline-block";

        // Create streaming message placeholder
        const streamingDiv = this.appendMessage(messagesArea, "Assistant", "");
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
        this.appendMessage(messagesArea, "You", displayText, userMsg.id, true);

        input.value = "";
        input.disabled = true;
        this.isStreaming = true;

        // Show stop button
        const stopBtn = messagesArea.ownerDocument?.getElementById("stop-btn") as HTMLElement;
        if (stopBtn) stopBtn.style.display = "inline-block";

        // Create streaming message placeholder
        const streamingDiv = this.appendMessage(messagesArea, "Assistant", "");
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
        msgId?: string,
        isLastUserMsg?: boolean
    ): HTMLElement {
        const doc = container.ownerDocument!;
        const isUser = sender === "You";
        const isAssistant = sender === "Assistant";

        const msgDiv = ztoolkit.UI.createElement(doc, "div", {
            properties: {
                className: `message-bubble ${isUser ? 'message-user' : 'message-assistant'}`
            },
            attributes: { "data-msg-id": msgId || "" },
            styles: {
                padding: "10px 14px",
                borderRadius: isUser ? "12px 12px 4px 12px" : "12px 12px 12px 4px",
                fontSize: "13px",
                maxWidth: "90%",
                alignSelf: isUser ? "flex-end" : "flex-start",
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
            const sender = isUser ? "You" : (msg.role === 'error' ? "Error" : "Assistant");
            const isLastUserMsg = isUser && idx === lastUserMsgIndex;

            this.appendMessage(messagesArea, sender, msg.content, msg.id, isLastUserMsg);
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
        const streamingDiv = this.appendMessage(messagesArea, "Assistant", "");
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
        const sender = isUser ? "You" : (msg.role === 'error' ? "Error" : "Assistant");
        this.appendMessage(container, sender, msg.content, msg.id, isLastUserMsg);
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
