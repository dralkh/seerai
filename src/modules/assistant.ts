import { openAIService, OpenAIMessage, VisionMessage, VisionMessageContentPart } from "./openai";
import { config } from "../../package.json";
import { getChatStateManager, resetChatStateManager } from "./chat/stateManager";
import { SelectedItem, SelectedNote, SelectedTable, ChatMessage, selectionConfigs, AIModelConfig } from "./chat/types";
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
    SearchState,
    defaultSearchState,
} from "./chat/tableTypes";
import { OcrService } from "./ocr";
import {
    semanticScholarService,
    unpaywallService,
    SemanticScholarPaper,
    SemanticScholarAuthorDetails,
    SearchResult,
    FIELDS_OF_STUDY,
    PUBLICATION_TYPES,
} from "./semanticScholar";

// Debounce timer for autocomplete
let autocompleteTimeout: ReturnType<typeof setTimeout> | null = null;

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

// Search state
let currentSearchState: SearchState = { ...defaultSearchState };
let currentSearchResults: SemanticScholarPaper[] = [];
let currentSearchToken: string | null = null;  // For pagination
let totalSearchResults: number = 0;  // Total count from API
let isSearching = false;

// Cache for Unpaywall PDF URLs (paperId -> pdfUrl)
const unpaywallPdfCache = new Map<string, string>();

// Filter presets
interface FilterPreset {
    name: string;
    filters: SearchState;
}

function getFilterPresets(): FilterPreset[] {
    try {
        const stored = Zotero.Prefs.get("extensions.seer-ai.filterPresets") as string;
        return stored ? JSON.parse(stored) : [];
    } catch {
        return [];
    }
}

function saveFilterPresets(presets: FilterPreset[]): void {
    Zotero.Prefs.set("extensions.seer-ai.filterPresets", JSON.stringify(presets));
}

function addFilterPreset(name: string, filters: SearchState): void {
    const presets = getFilterPresets();
    presets.push({ name, filters: { ...filters } });
    saveFilterPresets(presets);
}

function deleteFilterPreset(name: string): void {
    const presets = getFilterPresets().filter(p => p.name !== name);
    saveFilterPresets(presets);
}

function getNextPresetName(): string {
    const presets = getFilterPresets();
    let num = 1;
    while (presets.some(p => p.name === `Preset ${num}`)) num++;
    return `Preset ${num}`;
}

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
        } else if (activeTab === 'table') {
            const tableTabContent = await this.createTableTabContent(doc, item);
            tabContent.appendChild(tableTabContent);
        } else if (activeTab === 'search') {
            const searchTabContent = await this.createSearchTabContent(doc, item);
            tabContent.appendChild(searchTabContent);
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
            { id: 'table', label: 'Papers Table', icon: '📊' },
            { id: 'search', label: 'Search', icon: '🔍' },
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
     * Create the Search tab content with Semantic Scholar integration
     */
    private static async createSearchTabContent(doc: Document, item: Zotero.Item): Promise<HTMLElement> {
        const searchContainer = ztoolkit.UI.createElement(doc, "div", {
            properties: { className: "search-tab-container" },
            styles: {
                display: "flex",
                flexDirection: "column",
                height: "100%",
                overflow: "hidden",
                gap: "8px",
                padding: "8px"
            }
        });

        // === SEARCH INPUT ===
        const searchInputContainer = ztoolkit.UI.createElement(doc, "div", {
            styles: {
                display: "flex",
                gap: "8px",
                alignItems: "center"
            }
        });

        const searchInput = ztoolkit.UI.createElement(doc, "input", {
            attributes: {
                type: "text",
                placeholder: "🔍 Search Semantic Scholar...",
                value: currentSearchState.query || ""
            },
            properties: { id: "semantic-scholar-search-input" },
            styles: {
                flex: "1",
                padding: "10px 14px",
                border: "1px solid var(--border-primary)",
                borderRadius: "6px",
                fontSize: "13px",
                backgroundColor: "var(--background-primary)",
                color: "var(--text-primary)"
            }
        }) as HTMLInputElement;

        const searchBtn = ztoolkit.UI.createElement(doc, "button", {
            properties: { innerText: "Search" },
            styles: {
                padding: "10px 20px",
                backgroundColor: "var(--highlight-primary)",
                color: "var(--highlight-text)",
                border: "none",
                borderRadius: "6px",
                fontSize: "13px",
                fontWeight: "500",
                cursor: "pointer"
            },
            listeners: [{
                type: "click",
                listener: async () => {
                    currentSearchState.query = searchInput.value;
                    currentSearchResults = [];
                    currentSearchToken = null;
                    await this.performSearch(doc);
                }
            }]
        });

        // Enter key triggers search
        searchInput.addEventListener("keypress", async (e: Event) => {
            const ke = e as KeyboardEvent;
            if (ke.key === "Enter") {
                currentSearchState.query = searchInput.value;
                currentSearchResults = [];
                currentSearchToken = null;
                await this.performSearch(doc);
            }
        });

        // Query syntax help tooltip
        const syntaxHelp = ztoolkit.UI.createElement(doc, "span", {
            properties: { innerText: "❓" },
            attributes: { title: 'Syntax: "phrase" | word1+word2 | word1|word2 | -exclude | word* | word~3' },
            styles: {
                fontSize: "14px",
                cursor: "help",
                opacity: "0.6"
            }
        });

        // Suggestions button (replaces auto-dropdown with user-triggered action)
        const suggestionsBtn = ztoolkit.UI.createElement(doc, "button", {
            properties: { innerText: "💡", title: "Get suggestions" },
            styles: {
                padding: "8px 10px",
                backgroundColor: "var(--background-secondary)",
                color: "var(--text-primary)",
                border: "1px solid var(--border-primary)",
                borderRadius: "6px",
                fontSize: "14px",
                cursor: "pointer",
                marginLeft: "4px"
            }
        });

        // Suggestions dropdown container
        const suggestionsDropdown = ztoolkit.UI.createElement(doc, "div", {
            properties: { id: "suggestions-dropdown" },
            styles: {
                display: "none",
                position: "absolute",
                top: "100%",
                left: "0",
                right: "0",
                marginTop: "4px",
                backgroundColor: "var(--background-primary)",
                border: "1px solid var(--border-primary)",
                borderRadius: "6px",
                boxShadow: "0 4px 16px rgba(0,0,0,0.15)",
                zIndex: "9999",
                maxHeight: "250px",
                overflowY: "auto"
            }
        });

        // Close dropdown when clicking outside
        doc.addEventListener("click", (e: Event) => {
            if (!suggestionsDropdown.contains(e.target as Node) && e.target !== suggestionsBtn) {
                suggestionsDropdown.style.display = "none";
            }
        });

        // Suggestions button click handler
        suggestionsBtn.addEventListener("click", async () => {
            const query = searchInput.value.trim();

            if (query.length < 2) {
                // Show message if query too short
                suggestionsDropdown.innerHTML = "";
                const msgDiv = ztoolkit.UI.createElement(doc, "div", {
                    styles: {
                        padding: "16px",
                        textAlign: "center",
                        color: "var(--text-secondary)",
                        fontSize: "12px"
                    }
                });
                msgDiv.innerHTML = "Type at least 2 characters to get suggestions";
                suggestionsDropdown.appendChild(msgDiv);
                suggestionsDropdown.style.display = "block";
                return;
            }

            // Show loading state
            suggestionsDropdown.innerHTML = "";
            const loadingDiv = ztoolkit.UI.createElement(doc, "div", {
                styles: {
                    padding: "16px",
                    textAlign: "center",
                    color: "var(--text-secondary)",
                    fontSize: "12px"
                }
            });
            loadingDiv.innerHTML = "⏳ Loading suggestions...";
            suggestionsDropdown.appendChild(loadingDiv);
            suggestionsDropdown.style.display = "block";

            try {
                const suggestions = await semanticScholarService.autocomplete(query);
                suggestionsDropdown.innerHTML = "";

                if (suggestions.length === 0) {
                    const noResults = ztoolkit.UI.createElement(doc, "div", {
                        styles: {
                            padding: "16px",
                            textAlign: "center",
                            color: "var(--text-secondary)",
                            fontSize: "12px"
                        }
                    });
                    noResults.innerHTML = `No suggestions found for "${query}"`;
                    suggestionsDropdown.appendChild(noResults);
                    return;
                }

                // Header
                const header = ztoolkit.UI.createElement(doc, "div", {
                    styles: {
                        padding: "8px 12px",
                        fontSize: "11px",
                        fontWeight: "600",
                        color: "var(--text-secondary)",
                        borderBottom: "1px solid var(--border-primary)",
                        backgroundColor: "var(--background-secondary)"
                    }
                });
                header.innerHTML = `💡 ${suggestions.length} suggestion${suggestions.length > 1 ? 's' : ''} for "${query}"`;
                suggestionsDropdown.appendChild(header);

                suggestions.slice(0, 8).forEach(sugg => {
                    const item = ztoolkit.UI.createElement(doc, "div", {
                        styles: {
                            padding: "10px 12px",
                            fontSize: "12px",
                            cursor: "pointer",
                            borderBottom: "1px solid var(--border-primary)",
                            lineHeight: "1.4"
                        }
                    });
                    item.innerText = sugg.title;

                    item.addEventListener("mouseenter", () => {
                        item.style.backgroundColor = "var(--background-secondary)";
                    });
                    item.addEventListener("mouseleave", () => {
                        item.style.backgroundColor = "transparent";
                    });
                    item.addEventListener("click", async () => {
                        searchInput.value = sugg.title;
                        currentSearchState.query = sugg.title;
                        suggestionsDropdown.style.display = "none";
                        currentSearchResults = [];
                        await this.performSearch(doc);
                    });

                    suggestionsDropdown.appendChild(item);
                });
            } catch (e) {
                Zotero.debug(`[Seer AI] Suggestions error: ${e}`);
                suggestionsDropdown.innerHTML = "";
                const errorDiv = ztoolkit.UI.createElement(doc, "div", {
                    styles: {
                        padding: "16px",
                        textAlign: "center",
                        color: "var(--error-color, #d32f2f)",
                        fontSize: "12px"
                    }
                });
                errorDiv.innerHTML = "⚠️ Failed to load suggestions";
                suggestionsDropdown.appendChild(errorDiv);
            }
        });

        // AI Query Refiner button (🤖)
        const aiRefineBtn = ztoolkit.UI.createElement(doc, "button", {
            properties: { innerText: "🤖", title: "AI: Refine query for Semantic Scholar" },
            styles: {
                padding: "8px 10px",
                backgroundColor: "var(--background-secondary)",
                color: "var(--text-primary)",
                border: "1px solid var(--border-primary)",
                borderRadius: "6px",
                fontSize: "14px",
                cursor: "pointer",
                marginLeft: "4px"
            }
        });

        // AI Refine dropdown container
        const aiRefineDropdown = ztoolkit.UI.createElement(doc, "div", {
            properties: { id: "ai-refine-dropdown" },
            styles: {
                display: "none",
                position: "absolute",
                top: "100%",
                left: "0",
                right: "0",
                marginTop: "4px",
                backgroundColor: "var(--background-primary)",
                border: "1px solid var(--border-primary)",
                borderRadius: "6px",
                boxShadow: "0 4px 16px rgba(0,0,0,0.15)",
                zIndex: "9999",
                maxHeight: "300px",
                overflowY: "auto"
            }
        });

        // Close AI dropdown when clicking outside
        doc.addEventListener("click", (e: Event) => {
            if (!aiRefineDropdown.contains(e.target as Node) && e.target !== aiRefineBtn) {
                aiRefineDropdown.style.display = "none";
            }
        });

        // AI Refine button click handler
        aiRefineBtn.addEventListener("click", async () => {
            const userInput = searchInput.value.trim();

            if (userInput.length < 3) {
                aiRefineDropdown.innerHTML = "";
                const msgDiv = ztoolkit.UI.createElement(doc, "div", {
                    styles: {
                        padding: "16px",
                        textAlign: "center",
                        color: "var(--text-secondary)",
                        fontSize: "12px"
                    }
                });
                msgDiv.innerHTML = "Enter your search criteria, research question, or PICO/FINER parameters";
                aiRefineDropdown.appendChild(msgDiv);
                aiRefineDropdown.style.display = "block";
                return;
            }

            // Check for model config
            const activeModel = getActiveModelConfig();
            if (!activeModel) {
                aiRefineDropdown.innerHTML = "";
                const errorDiv = ztoolkit.UI.createElement(doc, "div", {
                    styles: {
                        padding: "16px",
                        textAlign: "center",
                        color: "var(--error-color, #d32f2f)",
                        fontSize: "12px"
                    }
                });
                errorDiv.innerHTML = "⚠️ No AI model configured. Please add a model in Settings.";
                aiRefineDropdown.appendChild(errorDiv);
                aiRefineDropdown.style.display = "block";
                return;
            }

            // Show loading state
            aiRefineDropdown.innerHTML = "";
            const loadingDiv = ztoolkit.UI.createElement(doc, "div", {
                styles: {
                    padding: "16px",
                    textAlign: "center",
                    color: "var(--text-secondary)",
                    fontSize: "12px"
                }
            });
            loadingDiv.innerHTML = "🤖 AI is refining your query...";
            aiRefineDropdown.appendChild(loadingDiv);
            aiRefineDropdown.style.display = "block";

            try {
                const systemPrompt = `You are a search query optimization expert for Semantic Scholar academic paper search.

Your task is to convert user input (which may be natural language questions, research objectives, PICO/FINER criteria, PRISMA requirements, or any study parameters) into optimized search queries for Semantic Scholar.

Semantic Scholar Query Syntax:
- Use + between required terms: "machine learning+healthcare" 
- Use | for OR between alternatives: "cancer|tumor|neoplasm"
- Use - to exclude terms: "diabetes -type1"
- Use quotes for exact phrases: "deep learning"
- Use * for prefix/suffix wildcard: "neuro*"
- Use ~ for proximity: "gene~3 expression" (within 3 words)

Guidelines:
1. Extract key concepts from user input
2. Include synonyms using | operator
3. Combine related required terms with +
4. Exclude irrelevant concepts if mentioned
5. Use quotes for multi-word concepts
6. Keep the query focused but comprehensive
7. Output ONLY the refined search query, nothing else

Examples:
Input: "I want papers about using AI for diagnosing kidney diseases"
Output: "artificial intelligence"|"machine learning"|"deep learning"+"kidney disease"|"renal disease"|nephropathy+diagnosis

Input: "PICO: Population=elderly patients, Intervention=exercise, Outcome=cognitive function"
Output: elderly|geriatric|"older adults"+exercise|"physical activity"+"cognitive function"|cognition|"mental performance"

Input: "Systematic review on COVID-19 vaccines effectiveness"  
Output: "COVID-19"|"SARS-CoV-2"|coronavirus+vaccine|vaccination+effectiveness|efficacy+"systematic review"|meta-analysis`;

                const messages = [
                    { role: "system" as const, content: systemPrompt },
                    { role: "user" as const, content: userInput }
                ];

                let refinedQuery = "";

                await openAIService.chatCompletionStream(messages, {
                    onToken: (token) => {
                        refinedQuery += token;
                        // Update live
                        aiRefineDropdown.innerHTML = "";
                        const previewDiv = ztoolkit.UI.createElement(doc, "div", {
                            styles: { padding: "12px" }
                        });
                        previewDiv.innerHTML = `
                            <div style="font-size: 11px; color: var(--text-secondary); margin-bottom: 8px;">🤖 AI Refined Query:</div>
                            <div style="font-family: monospace; font-size: 12px; padding: 8px; background: var(--background-secondary); border-radius: 4px; word-break: break-word;">${refinedQuery}</div>
                        `;
                        aiRefineDropdown.appendChild(previewDiv);
                    },
                    onComplete: (content) => {
                        refinedQuery = content.trim();
                        // Show final result with action buttons
                        aiRefineDropdown.innerHTML = "";

                        const resultDiv = ztoolkit.UI.createElement(doc, "div", {
                            styles: { padding: "12px" }
                        });

                        const headerDiv = ztoolkit.UI.createElement(doc, "div", {
                            styles: {
                                fontSize: "11px",
                                color: "var(--text-secondary)",
                                marginBottom: "8px"
                            }
                        });
                        headerDiv.innerHTML = "🤖 AI Refined Query:";
                        resultDiv.appendChild(headerDiv);

                        const queryDiv = ztoolkit.UI.createElement(doc, "div", {
                            styles: {
                                fontFamily: "monospace",
                                fontSize: "12px",
                                padding: "8px",
                                backgroundColor: "var(--background-secondary)",
                                borderRadius: "4px",
                                wordBreak: "break-word",
                                marginBottom: "12px"
                            }
                        });
                        queryDiv.innerText = refinedQuery;
                        resultDiv.appendChild(queryDiv);

                        // Action buttons
                        const actionsDiv = ztoolkit.UI.createElement(doc, "div", {
                            styles: {
                                display: "flex",
                                gap: "8px"
                            }
                        });

                        const useBtn = ztoolkit.UI.createElement(doc, "button", {
                            properties: { innerText: "✓ Use & Search" },
                            styles: {
                                flex: "1",
                                padding: "8px 12px",
                                backgroundColor: "#1976d2",
                                color: "#fff",
                                border: "none",
                                borderRadius: "4px",
                                fontSize: "12px",
                                cursor: "pointer"
                            }
                        });
                        useBtn.addEventListener("click", async () => {
                            searchInput.value = refinedQuery;
                            currentSearchState.query = refinedQuery;
                            aiRefineDropdown.style.display = "none";
                            currentSearchResults = [];
                            await this.performSearch(doc);
                        });

                        const copyBtn = ztoolkit.UI.createElement(doc, "button", {
                            properties: { innerText: "📋 Copy" },
                            styles: {
                                padding: "8px 12px",
                                backgroundColor: "var(--background-secondary)",
                                color: "var(--text-primary)",
                                border: "1px solid var(--border-primary)",
                                borderRadius: "4px",
                                fontSize: "12px",
                                cursor: "pointer"
                            }
                        });
                        copyBtn.addEventListener("click", () => {
                            new ztoolkit.Clipboard().addText(refinedQuery, "text/unicode").copy();
                            copyBtn.innerText = "✓ Copied!";
                            setTimeout(() => { copyBtn.innerText = "📋 Copy"; }, 1500);
                        });

                        actionsDiv.appendChild(useBtn);
                        actionsDiv.appendChild(copyBtn);
                        resultDiv.appendChild(actionsDiv);
                        aiRefineDropdown.appendChild(resultDiv);
                    },
                    onError: (error) => {
                        aiRefineDropdown.innerHTML = "";
                        const errorDiv = ztoolkit.UI.createElement(doc, "div", {
                            styles: {
                                padding: "16px",
                                textAlign: "center",
                                color: "var(--error-color, #d32f2f)",
                                fontSize: "12px"
                            }
                        });
                        errorDiv.innerHTML = `⚠️ AI Error: ${error.message}`;
                        aiRefineDropdown.appendChild(errorDiv);
                    }
                }, {
                    apiURL: activeModel.apiURL,
                    apiKey: activeModel.apiKey,
                    model: activeModel.model
                });
            } catch (e) {
                Zotero.debug(`[Seer AI] AI Refine error: ${e}`);
                aiRefineDropdown.innerHTML = "";
                const errorDiv = ztoolkit.UI.createElement(doc, "div", {
                    styles: {
                        padding: "16px",
                        textAlign: "center",
                        color: "var(--error-color, #d32f2f)",
                        fontSize: "12px"
                    }
                });
                errorDiv.innerHTML = "⚠️ Failed to refine query";
                aiRefineDropdown.appendChild(errorDiv);
            }
        });

        // Make input container relative for dropdown positioning
        searchInputContainer.style.position = "relative";
        searchInputContainer.appendChild(searchInput);
        searchInputContainer.appendChild(suggestionsBtn);
        searchInputContainer.appendChild(aiRefineBtn);
        searchInputContainer.appendChild(syntaxHelp);
        searchInputContainer.appendChild(searchBtn);
        searchInputContainer.appendChild(suggestionsDropdown);
        searchInputContainer.appendChild(aiRefineDropdown);

        // === FILTERS (shown first) ===
        const filtersContainer = this.createSearchFilters(doc);
        searchContainer.appendChild(filtersContainer);

        // === SEARCH INPUT (below filters) ===
        searchContainer.appendChild(searchInputContainer);

        // === RESULTS AREA ===
        const resultsArea = ztoolkit.UI.createElement(doc, "div", {
            properties: { id: "semantic-scholar-results" },
            styles: {
                flex: "1",
                overflowY: "auto",
                border: "1px solid var(--border-primary)",
                borderRadius: "6px",
                backgroundColor: "var(--background-primary)"
            }
        });

        // Render current results or empty state
        this.renderSearchResults(doc, resultsArea, item);
        searchContainer.appendChild(resultsArea);

        return searchContainer;
    }

    /**
     * Create the advanced search filters UI
     */
    private static createSearchFilters(doc: Document): HTMLElement {
        const container = ztoolkit.UI.createElement(doc, "div", {
            properties: { className: "search-filters-container" },
            styles: {
                border: "1px solid var(--border-primary)",
                borderRadius: "6px",
                overflow: "hidden",
                marginBottom: "4px"
            }
        });

        // Header (non-collapsible, always expanded)
        const header = ztoolkit.UI.createElement(doc, "div", {
            styles: {
                display: "none"  // Hidden - no header needed
            }
        });

        // Filters body (always visible, compact)
        const filtersBody = ztoolkit.UI.createElement(doc, "div", {
            properties: { id: "search-filters-body" },
            styles: {
                display: "block",
                padding: "8px",
                backgroundColor: "var(--background-primary)"
            }
        });

        // === PRESET ROW ===
        const presetRow = ztoolkit.UI.createElement(doc, "div", {
            styles: {
                display: "flex",
                gap: "8px",
                alignItems: "center",
                marginBottom: "12px",
                paddingBottom: "12px",
                borderBottom: "1px solid var(--border-primary)"
            }
        });

        const presetLabel = ztoolkit.UI.createElement(doc, "span", {
            properties: { innerText: "📁 Presets:" },
            styles: { fontSize: "11px", fontWeight: "500", color: "var(--text-secondary)" }
        });
        presetRow.appendChild(presetLabel);

        // Preset dropdown
        const presetSelect = ztoolkit.UI.createElement(doc, "select", {
            properties: { id: "preset-select" },
            styles: {
                flex: "1",
                padding: "4px 8px",
                border: "1px solid var(--border-primary)",
                borderRadius: "4px",
                fontSize: "11px",
                backgroundColor: "var(--background-primary)",
                color: "var(--text-primary)"
            },
            listeners: [{
                type: "change",
                listener: () => {
                    const selectedName = (presetSelect as HTMLSelectElement).value;
                    if (!selectedName) return;

                    const presets = getFilterPresets();
                    const preset = presets.find(p => p.name === selectedName);
                    if (preset) {
                        // Apply preset filters
                        Object.assign(currentSearchState, preset.filters);
                        // Re-render filters to show updated values
                        const parent = container.parentElement;
                        if (parent) {
                            // Get references before removing
                            const searchInputContainer = parent.querySelector("div[style*='position: relative']");
                            const resultsArea = parent.querySelector("#semantic-scholar-results");

                            container.remove();
                            const newFilters = Assistant.createSearchFilters(doc);

                            // Insert in correct order: filters, search input, results
                            if (resultsArea) {
                                parent.insertBefore(newFilters, resultsArea);
                                if (searchInputContainer) {
                                    parent.insertBefore(searchInputContainer, resultsArea);
                                }
                            }

                            // Select the preset in new dropdown
                            const newSelect = newFilters.querySelector("#preset-select") as HTMLSelectElement;
                            if (newSelect) newSelect.value = selectedName;
                        }
                    }
                }
            }]
        }) as HTMLSelectElement;

        // Populate dropdown
        const defaultOpt = ztoolkit.UI.createElement(doc, "option", {
            attributes: { value: "" },
            properties: { innerText: "-- Select preset --" }
        });
        presetSelect.appendChild(defaultOpt);

        getFilterPresets().forEach(preset => {
            const opt = ztoolkit.UI.createElement(doc, "option", {
                attributes: { value: preset.name },
                properties: { innerText: preset.name }
            });
            presetSelect.appendChild(opt);
        });

        presetRow.appendChild(presetSelect);

        // Save button
        const saveBtn = ztoolkit.UI.createElement(doc, "button", {
            properties: { innerText: "💾 Save" },
            styles: {
                padding: "4px 10px",
                border: "1px solid var(--border-primary)",
                borderRadius: "4px",
                fontSize: "11px",
                backgroundColor: "#e3f2fd",
                color: "#1976d2",
                cursor: "pointer",
                fontWeight: "500"
            },
            listeners: [{
                type: "click",
                listener: () => {
                    const name = getNextPresetName();
                    addFilterPreset(name, currentSearchState);

                    // Add new option to dropdown
                    const newOpt = ztoolkit.UI.createElement(doc, "option", {
                        attributes: { value: name },
                        properties: { innerText: name }
                    });
                    presetSelect.appendChild(newOpt);
                    presetSelect.value = name;

                    Zotero.debug(`[Seer AI] Saved filter preset: ${name}`);
                }
            }]
        });
        presetRow.appendChild(saveBtn);

        // Rename button
        const renameBtn = ztoolkit.UI.createElement(doc, "button", {
            properties: { innerText: "✏️" },
            attributes: { title: "Rename preset" },
            styles: {
                padding: "4px 8px",
                border: "1px solid var(--border-primary)",
                borderRadius: "4px",
                fontSize: "11px",
                backgroundColor: "#fff3e0",
                color: "#e65100",
                cursor: "pointer"
            },
            listeners: [{
                type: "click",
                listener: () => {
                    const selectedName = presetSelect.value;
                    if (!selectedName) return;

                    const newName = (doc.defaultView as Window).prompt("Enter new preset name:", selectedName);
                    if (!newName || newName === selectedName) return;

                    // Rename in storage
                    const presets = getFilterPresets();
                    const preset = presets.find(p => p.name === selectedName);
                    if (preset) {
                        preset.name = newName;
                        saveFilterPresets(presets);
                    }

                    // Update dropdown option
                    const opt = presetSelect.querySelector(`option[value="${selectedName}"]`) as HTMLOptionElement;
                    if (opt) {
                        opt.value = newName;
                        opt.textContent = newName;
                    }
                    presetSelect.value = newName;

                    Zotero.debug(`[Seer AI] Renamed preset: ${selectedName} -> ${newName}`);
                }
            }]
        });
        presetRow.appendChild(renameBtn);

        // Delete button
        const deleteBtn = ztoolkit.UI.createElement(doc, "button", {
            properties: { innerText: "🗑️" },
            attributes: { title: "Delete preset" },
            styles: {
                padding: "4px 8px",
                border: "1px solid var(--border-primary)",
                borderRadius: "4px",
                fontSize: "11px",
                backgroundColor: "#ffebee",
                color: "#c62828",
                cursor: "pointer"
            },
            listeners: [{
                type: "click",
                listener: () => {
                    const selectedName = presetSelect.value;
                    if (!selectedName) return;

                    deleteFilterPreset(selectedName);

                    // Remove option from dropdown
                    const opt = presetSelect.querySelector(`option[value="${selectedName}"]`);
                    if (opt) opt.remove();
                    presetSelect.value = "";

                    Zotero.debug(`[Seer AI] Deleted filter preset: ${selectedName}`);
                }
            }]
        });
        presetRow.appendChild(deleteBtn);

        filtersBody.appendChild(presetRow);

        const gridStyle = {
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: "6px",
            marginBottom: "6px"
        };

        const labelStyle = {
            fontSize: "10px",
            fontWeight: "500",
            color: "var(--text-secondary)",
            marginBottom: "2px",
            display: "block"
        };

        const inputStyle = {
            width: "100%",
            padding: "6px 10px",
            border: "1px solid var(--border-primary)",
            borderRadius: "4px",
            fontSize: "12px",
            backgroundColor: "var(--background-primary)",
            color: "var(--text-primary)",
            boxSizing: "border-box" as const
        };

        // Row 1: Results limit + Year range
        const row1 = ztoolkit.UI.createElement(doc, "div", { styles: gridStyle });

        // Results per page (slider)
        const limitGroup = ztoolkit.UI.createElement(doc, "div", {});
        const limitLabel = ztoolkit.UI.createElement(doc, "label", {
            properties: { innerText: `Results per page: ${currentSearchState.limit}` },
            styles: labelStyle
        });
        const limitSlider = ztoolkit.UI.createElement(doc, "input", {
            attributes: { type: "range", min: "10", max: "100", step: "10", value: String(currentSearchState.limit) },
            styles: { ...inputStyle, padding: "0", cursor: "pointer" },
            listeners: [{
                type: "input",
                listener: (e: Event) => {
                    const target = e.target as HTMLInputElement;
                    currentSearchState.limit = parseInt(target.value, 10);
                    limitLabel.innerText = `Results per page: ${currentSearchState.limit}`;
                }
            }]
        }) as HTMLInputElement;
        limitGroup.appendChild(limitLabel);
        limitGroup.appendChild(limitSlider);
        row1.appendChild(limitGroup);

        // Year range
        const yearGroup = ztoolkit.UI.createElement(doc, "div", {});
        const yearLabel = ztoolkit.UI.createElement(doc, "label", {
            properties: { innerText: "Year range" },
            styles: labelStyle
        });
        const yearInputs = ztoolkit.UI.createElement(doc, "div", {
            styles: { display: "flex", gap: "4px", alignItems: "center" }
        });
        const yearStart = ztoolkit.UI.createElement(doc, "input", {
            attributes: { type: "number", placeholder: "From", min: "1900", max: "2030", value: currentSearchState.yearStart || "" },
            styles: { ...inputStyle, width: "70px" },
            listeners: [{
                type: "change",
                listener: (e: Event) => {
                    currentSearchState.yearStart = (e.target as HTMLInputElement).value;
                }
            }]
        }) as HTMLInputElement;
        const yearDash = ztoolkit.UI.createElement(doc, "span", { properties: { innerText: "-" }, styles: { color: "var(--text-secondary)" } });
        const yearEnd = ztoolkit.UI.createElement(doc, "input", {
            attributes: { type: "number", placeholder: "To", min: "1900", max: "2030", value: currentSearchState.yearEnd || "" },
            styles: { ...inputStyle, width: "70px" },
            listeners: [{
                type: "change",
                listener: (e: Event) => {
                    currentSearchState.yearEnd = (e.target as HTMLInputElement).value;
                }
            }]
        }) as HTMLInputElement;
        yearInputs.appendChild(yearStart);
        yearInputs.appendChild(yearDash);
        yearInputs.appendChild(yearEnd);
        yearGroup.appendChild(yearLabel);
        yearGroup.appendChild(yearInputs);
        row1.appendChild(yearGroup);

        filtersBody.appendChild(row1);

        // Row 2: Checkboxes (Has PDF, Hide Library Duplicates)
        const row2 = ztoolkit.UI.createElement(doc, "div", {
            styles: { display: "flex", gap: "16px", marginBottom: "12px" }
        });

        const hasPdfCheck = this.createFilterCheckbox(doc, "📄 Has PDF", currentSearchState.openAccessPdf, (val) => {
            currentSearchState.openAccessPdf = val;
        });
        row2.appendChild(hasPdfCheck);

        const hideDupsCheck = this.createFilterCheckbox(doc, "🚫 Hide Library Duplicates", currentSearchState.hideLibraryDuplicates, (val) => {
            currentSearchState.hideLibraryDuplicates = val;
        });
        row2.appendChild(hideDupsCheck);

        filtersBody.appendChild(row2);

        // Row 3: Min Citations + Sort By
        const row3 = ztoolkit.UI.createElement(doc, "div", { styles: gridStyle });

        const minCitGroup = ztoolkit.UI.createElement(doc, "div", {});
        const minCitLabel = ztoolkit.UI.createElement(doc, "label", {
            properties: { innerText: "Min citations" },
            styles: labelStyle
        });
        const minCitInput = ztoolkit.UI.createElement(doc, "input", {
            attributes: { type: "number", placeholder: "0", min: "0", value: String(currentSearchState.minCitationCount || "") },
            styles: inputStyle,
            listeners: [{
                type: "change",
                listener: (e: Event) => {
                    const val = parseInt((e.target as HTMLInputElement).value, 10);
                    currentSearchState.minCitationCount = isNaN(val) ? undefined : val;
                }
            }]
        }) as HTMLInputElement;
        minCitGroup.appendChild(minCitLabel);
        minCitGroup.appendChild(minCitInput);
        row3.appendChild(minCitGroup);

        const sortGroup = ztoolkit.UI.createElement(doc, "div", {});
        const sortLabel = ztoolkit.UI.createElement(doc, "label", {
            properties: { innerText: "Sort by" },
            styles: labelStyle
        });
        const sortSelect = ztoolkit.UI.createElement(doc, "select", {
            styles: { ...inputStyle, appearance: "auto" as const },
            listeners: [{
                type: "change",
                listener: (e: Event) => {
                    currentSearchState.sortBy = (e.target as HTMLSelectElement).value as SearchState["sortBy"];
                }
            }]
        }) as HTMLSelectElement;

        const sortOptions = [
            { value: "relevance", label: "Relevance" },
            { value: "citationCount:desc", label: "Most Cited" },
            { value: "publicationDate:desc", label: "Newest First" }
        ];
        sortOptions.forEach(opt => {
            const option = ztoolkit.UI.createElement(doc, "option", {
                attributes: { value: opt.value },
                properties: { innerText: opt.label }
            }) as HTMLOptionElement;
            if (opt.value === currentSearchState.sortBy) option.selected = true;
            sortSelect.appendChild(option);
        });
        sortGroup.appendChild(sortLabel);
        sortGroup.appendChild(sortSelect);
        row3.appendChild(sortGroup);

        filtersBody.appendChild(row3);

        // Row 4: Fields of Study multi-select
        const fosGroup = ztoolkit.UI.createElement(doc, "div", { styles: { marginBottom: "12px" } });
        const fosLabel = ztoolkit.UI.createElement(doc, "label", {
            properties: { innerText: "Fields of Study" },
            styles: labelStyle
        });
        const fosContainer = ztoolkit.UI.createElement(doc, "div", {
            styles: { display: "flex", flexWrap: "wrap", gap: "4px" }
        });

        const commonFields = ["Computer Science", "Medicine", "Biology", "Physics", "Psychology", "Engineering"];
        commonFields.forEach(field => {
            const isSelected = currentSearchState.fieldsOfStudy.includes(field);
            const chip = ztoolkit.UI.createElement(doc, "span", {
                properties: { innerText: field, className: `fos-chip ${isSelected ? "selected" : ""}` },
                styles: {
                    padding: "4px 10px",
                    borderRadius: "14px",
                    fontSize: "10px",
                    cursor: "pointer",
                    backgroundColor: isSelected ? "#1976d2" : "transparent",
                    color: isSelected ? "#ffffff" : "var(--text-primary)",
                    border: isSelected ? "2px solid #1976d2" : "2px solid #888888",
                    fontWeight: isSelected ? "600" : "400",
                    transition: "all 0.15s ease"
                },
                listeners: [{
                    type: "click",
                    listener: () => {
                        const idx = currentSearchState.fieldsOfStudy.indexOf(field);
                        if (idx >= 0) {
                            currentSearchState.fieldsOfStudy.splice(idx, 1);
                            chip.style.backgroundColor = "transparent";
                            chip.style.color = "var(--text-primary)";
                            chip.style.border = "2px solid #888888";
                            chip.style.fontWeight = "400";
                        } else {
                            currentSearchState.fieldsOfStudy.push(field);
                            chip.style.backgroundColor = "#1976d2";
                            chip.style.color = "#ffffff";
                            chip.style.border = "2px solid #1976d2";
                            chip.style.fontWeight = "600";
                        }
                    }
                }]
            });
            fosContainer.appendChild(chip);
        });

        fosGroup.appendChild(fosLabel);
        fosGroup.appendChild(fosContainer);
        filtersBody.appendChild(fosGroup);

        // Row 5: Publication Types
        const pubTypeGroup = ztoolkit.UI.createElement(doc, "div", { styles: { marginBottom: "12px" } });
        const pubTypeLabel = ztoolkit.UI.createElement(doc, "label", {
            properties: { innerText: "Publication Types" },
            styles: labelStyle
        });
        const pubTypeContainer = ztoolkit.UI.createElement(doc, "div", {
            styles: { display: "flex", flexWrap: "wrap", gap: "4px" }
        });

        const pubTypes = [
            "JournalArticle", "Conference", "Review", "Book",
            "Dataset", "ClinicalTrial", "MetaAnalysis", "Study"
        ];
        pubTypes.forEach(ptype => {
            const isSelected = currentSearchState.publicationTypes.includes(ptype);
            const chip = ztoolkit.UI.createElement(doc, "span", {
                properties: { innerText: ptype.replace(/([A-Z])/g, ' $1').trim() },
                styles: {
                    padding: "4px 10px",
                    borderRadius: "14px",
                    fontSize: "10px",
                    cursor: "pointer",
                    backgroundColor: isSelected ? "#1976d2" : "transparent",
                    color: isSelected ? "#ffffff" : "var(--text-primary)",
                    border: isSelected ? "2px solid #1976d2" : "2px solid #888888",
                    fontWeight: isSelected ? "600" : "400",
                    transition: "all 0.15s ease"
                },
                listeners: [{
                    type: "click",
                    listener: () => {
                        const idx = currentSearchState.publicationTypes.indexOf(ptype);
                        if (idx >= 0) {
                            currentSearchState.publicationTypes.splice(idx, 1);
                            chip.style.backgroundColor = "transparent";
                            chip.style.color = "var(--text-primary)";
                            chip.style.border = "2px solid #888888";
                            chip.style.fontWeight = "400";
                        } else {
                            currentSearchState.publicationTypes.push(ptype);
                            chip.style.backgroundColor = "#1976d2";
                            chip.style.color = "#ffffff";
                            chip.style.border = "2px solid #1976d2";
                            chip.style.fontWeight = "600";
                        }
                    }
                }]
            });
            pubTypeContainer.appendChild(chip);
        });

        pubTypeGroup.appendChild(pubTypeLabel);
        pubTypeGroup.appendChild(pubTypeContainer);
        filtersBody.appendChild(pubTypeGroup);

        // Row 6: Venue filter
        const venueGroup = ztoolkit.UI.createElement(doc, "div", { styles: { marginBottom: "8px" } });
        const venueLabel = ztoolkit.UI.createElement(doc, "label", {
            properties: { innerText: "Venue (e.g., Nature, Cell, ICML)" },
            styles: labelStyle
        });
        const venueInput = ztoolkit.UI.createElement(doc, "input", {
            attributes: {
                type: "text",
                placeholder: "Comma-separated venues...",
                value: currentSearchState.venue || ""
            },
            styles: { ...inputStyle, width: "100%" },
            listeners: [{
                type: "change",
                listener: (e: Event) => {
                    currentSearchState.venue = (e.target as HTMLInputElement).value || undefined;
                }
            }]
        }) as HTMLInputElement;
        venueGroup.appendChild(venueLabel);
        venueGroup.appendChild(venueInput);
        filtersBody.appendChild(venueGroup);

        // Row 7: Save Location dropdown
        const saveLocationGroup = ztoolkit.UI.createElement(doc, "div", {
            styles: {
                marginBottom: "8px",
                marginTop: "8px",
                paddingTop: "8px",
                borderTop: "1px solid var(--border-primary)"
            }
        });
        const saveLocationLabel = ztoolkit.UI.createElement(doc, "label", {
            properties: { innerText: "📥 Save imported papers to:" },
            styles: { ...labelStyle, fontWeight: "600" }
        });
        const saveLocationSelect = ztoolkit.UI.createElement(doc, "select", {
            properties: { id: "save-location-select" },
            styles: {
                ...inputStyle,
                width: "100%",
                appearance: "auto" as const,
                marginTop: "4px"
            },
            listeners: [{
                type: "change",
                listener: (e: Event) => {
                    currentSearchState.saveLocation = (e.target as HTMLSelectElement).value;
                    Zotero.debug(`[Seer AI] Save location changed to: ${currentSearchState.saveLocation}`);
                }
            }]
        }) as HTMLSelectElement;

        // Populate save location dropdown with libraries and collections
        this.populateSaveLocationSelect(saveLocationSelect);

        saveLocationGroup.appendChild(saveLocationLabel);
        saveLocationGroup.appendChild(saveLocationSelect);
        filtersBody.appendChild(saveLocationGroup);

        container.appendChild(filtersBody);
        return container;
    }

    /**
     * Helper to create a filter checkbox
     */
    private static createFilterCheckbox(doc: Document, label: string, checked: boolean, onChange: (val: boolean) => void): HTMLElement {
        const container = ztoolkit.UI.createElement(doc, "label", {
            styles: {
                display: "flex",
                alignItems: "center",
                gap: "6px",
                fontSize: "12px",
                color: "var(--text-primary)",
                cursor: "pointer"
            }
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
        checkbox.checked = checked;

        const labelText = ztoolkit.UI.createElement(doc, "span", {
            properties: { innerText: label }
        });

        container.appendChild(checkbox);
        container.appendChild(labelText);
        return container;
    }

    /**
     * Perform the search and update results
     */
    private static async performSearch(doc: Document): Promise<void> {
        if (isSearching || !currentSearchState.query.trim()) return;

        isSearching = true;
        const resultsArea = doc.getElementById("semantic-scholar-results");
        if (!resultsArea) {
            isSearching = false;
            return;
        }

        // Determine if this is a pagination request (Show More) or a fresh search
        const isPagination = currentSearchResults.length > 0;

        if (isPagination) {
            // For pagination: show loading indicator BELOW existing content
            // The loading indicator is already placed by the click handler, 
            // so we don't need to do anything else here
        } else {
            // For fresh searches: clear and show loading
            resultsArea.innerHTML = "";
            const loadingEl = ztoolkit.UI.createElement(doc, "div", {
                properties: { id: "initial-search-loading" },
                styles: {
                    padding: "40px",
                    textAlign: "center",
                    color: "var(--text-secondary)"
                }
            });
            loadingEl.innerHTML = `<div style="font-size: 24px; margin-bottom: 8px;">⏳</div><div>Searching Semantic Scholar...</div>`;
            resultsArea.appendChild(loadingEl);
        }

        try {
            // Check for API key
            // API Key is optional now, but checked for rate limiting internally


            // Build year filter
            let yearParam: string | undefined;
            if (currentSearchState.yearStart || currentSearchState.yearEnd) {
                const start = currentSearchState.yearStart || "";
                const end = currentSearchState.yearEnd || "";
                yearParam = `${start}-${end}`;
            }

            const result = await semanticScholarService.searchPapers({
                query: currentSearchState.query,
                limit: currentSearchState.limit,
                offset: currentSearchResults.length,
                year: yearParam,
                openAccessPdf: currentSearchState.openAccessPdf || undefined,
                fieldsOfStudy: currentSearchState.fieldsOfStudy.length > 0 ? currentSearchState.fieldsOfStudy : undefined,
                publicationTypes: currentSearchState.publicationTypes.length > 0 ? currentSearchState.publicationTypes : undefined,
                minCitationCount: currentSearchState.minCitationCount,
                venue: currentSearchState.venue,
            });

            // Capture total count from result
            if (currentSearchResults.length === 0) {
                totalSearchResults = result.total;
            }

            // Filter library duplicates if enabled
            let papers = result.data;
            if (currentSearchState.hideLibraryDuplicates) {
                papers = await this.filterLibraryDuplicates(papers);
            }

            const previousCount = currentSearchResults.length;
            currentSearchResults = [...currentSearchResults, ...papers];

            // If this is a fresh search (previousCount === 0), render everything
            // Otherwise, just append the new cards
            if (previousCount === 0) {
                this.renderSearchResults(doc, resultsArea as HTMLElement, currentItem!);
            } else {
                // Append new cards without clearing existing content
                this.appendSearchCards(doc, resultsArea as HTMLElement, papers, currentItem!);
            }

        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : "Search failed";
            Zotero.debug(`[Seer AI] Search error: ${error}`);

            if (isPagination) {
                // For pagination errors: only remove loading indicator and show inline error
                const loadingIndicator = resultsArea.querySelector("#show-more-loading");
                if (loadingIndicator) {
                    loadingIndicator.remove();
                }
                // Re-add the Show More button so user can retry
                const existingShowMore = resultsArea.querySelector("#show-more-btn");
                if (existingShowMore) {
                    existingShowMore.remove();
                }
                const errorMsg = ztoolkit.UI.createElement(doc, "div", {
                    styles: {
                        padding: "12px",
                        textAlign: "center",
                        color: "var(--error-color, #d32f2f)",
                        fontSize: "12px"
                    }
                });
                errorMsg.innerHTML = `⚠️ ${errorMessage}. <button id="retry-show-more" style="margin-left: 8px; cursor: pointer; padding: 4px 8px; border: 1px solid var(--border-primary); border-radius: 4px; background: var(--background-secondary);">Retry</button>`;
                resultsArea.appendChild(errorMsg);
                // Add retry handler
                const retryBtn = errorMsg.querySelector("#retry-show-more");
                if (retryBtn) {
                    retryBtn.addEventListener("click", async () => {
                        errorMsg.remove();
                        await this.performSearch(doc);
                    });
                }
            } else {
                // For fresh search errors: show full error
                resultsArea.innerHTML = "";
                const errorEl = ztoolkit.UI.createElement(doc, "div", {
                    styles: {
                        padding: "40px",
                        textAlign: "center",
                        color: "var(--error-color, #d32f2f)"
                    }
                });
                errorEl.innerHTML = `<div style="font-size: 24px; margin-bottom: 8px;">⚠️</div><div>${errorMessage}</div>`;
                resultsArea.appendChild(errorEl);
            }
        } finally {
            isSearching = false;
        }
    }

    /**
     * Filter out papers that already exist in the Zotero library
     */
    private static async filterLibraryDuplicates(papers: SemanticScholarPaper[]): Promise<SemanticScholarPaper[]> {
        const libraryItems = await Zotero.Items.getAll(Zotero.Libraries.userLibraryID);

        // Build lookup sets for DOI, PMID, and titles
        const existingDOIs = new Set<string>();
        const existingPMIDs = new Set<string>();
        const existingTitles = new Set<string>();

        for (const item of libraryItems) {
            if (!item.isRegularItem()) continue;

            const doi = item.getField("DOI") as string;
            if (doi) existingDOIs.add(doi.toLowerCase());

            const extra = item.getField("extra") as string;
            if (extra) {
                const pmidMatch = extra.match(/PMID:\s*(\d+)/i);
                if (pmidMatch) existingPMIDs.add(pmidMatch[1]);
            }

            const title = item.getField("title") as string;
            if (title) existingTitles.add(title.toLowerCase().trim());
        }

        return papers.filter(paper => {
            // Check DOI
            if (paper.externalIds?.DOI && existingDOIs.has(paper.externalIds.DOI.toLowerCase())) {
                return false;
            }
            // Check PMID
            if (paper.externalIds?.PMID && existingPMIDs.has(paper.externalIds.PMID)) {
                return false;
            }
            // Check title (exact match, case insensitive)
            if (paper.title && existingTitles.has(paper.title.toLowerCase().trim())) {
                return false;
            }
            return true;
        });
    }

    /**
     * Render search results in the results area
     */
    private static renderSearchResults(doc: Document, container: HTMLElement, item: Zotero.Item): void {
        container.innerHTML = "";

        if (currentSearchResults.length === 0 && !currentSearchState.query) {
            // Initial empty state
            const emptyState = ztoolkit.UI.createElement(doc, "div", {
                styles: {
                    padding: "60px 20px",
                    textAlign: "center",
                    color: "var(--text-secondary)"
                }
            });
            emptyState.innerHTML = `
                <div style="font-size: 48px; margin-bottom: 16px;">🔍</div>
                <div style="font-size: 14px; font-weight: 500; margin-bottom: 8px;">Search Semantic Scholar</div>
                <div style="font-size: 12px;">Enter a query to find relevant papers</div>
            `;
            container.appendChild(emptyState);
            return;
        }

        if (currentSearchResults.length === 0 && currentSearchState.query) {
            // No results
            const noResults = ztoolkit.UI.createElement(doc, "div", {
                styles: {
                    padding: "40px",
                    textAlign: "center",
                    color: "var(--text-secondary)"
                }
            });
            noResults.innerHTML = `
                <div style="font-size: 32px; margin-bottom: 8px;">📭</div>
                <div>No papers found for "${currentSearchState.query}"</div>
            `;
            container.appendChild(noResults);
            return;
        }

        // Total count header
        const countHeader = ztoolkit.UI.createElement(doc, "div", {
            styles: {
                padding: "8px 12px",
                backgroundColor: "var(--background-secondary)",
                borderBottom: "1px solid var(--border-primary)",
                fontSize: "12px",
                color: "var(--text-secondary)",
                fontWeight: "500"
            }
        });
        countHeader.innerHTML = `📊 Found <strong>${totalSearchResults.toLocaleString()}</strong> papers • Showing ${currentSearchResults.length}`;
        container.appendChild(countHeader);

        // Render result cards
        currentSearchResults.forEach(paper => {
            const card = this.createSearchResultCard(doc, paper, item);
            container.appendChild(card);
        });

        // Trigger batch Unpaywall check for papers without PDFs
        this.batchCheckUnpaywall(doc, currentSearchResults);

        // "Show More" button
        const showMoreBtn = ztoolkit.UI.createElement(doc, "button", {
            properties: { innerText: "📥 Show More", id: "show-more-btn" },
            styles: {
                display: "block",
                width: "calc(100% - 24px)",
                margin: "12px",
                padding: "12px",
                backgroundColor: "var(--background-secondary)",
                color: "var(--text-primary)",
                border: "1px solid var(--border-primary)",
                borderRadius: "6px",
                fontSize: "13px",
                cursor: "pointer"
            },
            listeners: [{
                type: "click",
                listener: async () => {
                    // Replace button with loading indicator
                    const loadingDiv = ztoolkit.UI.createElement(doc, "div", {
                        properties: { id: "show-more-loading" },
                        styles: {
                            textAlign: "center",
                            padding: "16px",
                            color: "var(--text-secondary)",
                            fontSize: "12px"
                        }
                    });
                    loadingDiv.innerHTML = "⏳ Loading more papers...";
                    showMoreBtn.replaceWith(loadingDiv);

                    await this.performSearch(doc);
                }
            }]
        });
        container.appendChild(showMoreBtn);
    }

    /**
     * Batch check Unpaywall for papers without PDFs
     * Updates badges in the DOM as results come in
     */
    private static async batchCheckUnpaywall(doc: Document, papers: SemanticScholarPaper[]): Promise<void> {
        // Filter papers that need checking (no openAccessPdf but have DOI)
        const papersToCheck = papers.filter(p =>
            !p.openAccessPdf &&
            p.externalIds?.DOI &&
            !unpaywallPdfCache.has(p.paperId)
        );

        if (papersToCheck.length === 0) return;

        Zotero.debug(`[Seer AI] Batch checking Unpaywall for ${papersToCheck.length} papers`);

        // Check in parallel (UnpaywallService handles batching internally)
        const dois = papersToCheck.map(p => p.externalIds!.DOI!);
        const results = await unpaywallService.checkMultipleDois(dois);

        // Update cache and UI for each result
        papersToCheck.forEach(paper => {
            const doi = paper.externalIds!.DOI!;
            const pdfUrl = results.get(doi.toLowerCase().trim());

            if (pdfUrl) {
                unpaywallPdfCache.set(paper.paperId, pdfUrl);
            }

            // Find and update the badge in the DOM
            // Cards are identified by paper title text content
            const cards = doc.querySelectorAll('.search-result-card');
            for (const card of cards) {
                const titleEl = card.querySelector('div[style*="font-weight: 600"]');
                if (titleEl && titleEl.textContent === paper.title) {
                    const badge = card.querySelector('span[style*="Checking"]');
                    if (badge && badge instanceof HTMLElement) {
                        if (pdfUrl) {
                            badge.innerText = "🔗 PDF (Unpaywall)";
                            badge.style.backgroundColor = "#e3f2fd";
                            badge.style.color = "#1976d2";
                            badge.style.cursor = "pointer";
                            badge.title = pdfUrl;
                            badge.onclick = (e: Event) => {
                                e.stopPropagation();
                                Zotero.launchURL(pdfUrl);
                            };
                        } else {
                            badge.innerText = "📭 No PDF";
                            badge.style.backgroundColor = "#fafafa";
                            badge.style.color = "#9e9e9e";
                        }
                    }
                    break;
                }
            }
        });
    }

    /**
     * Append new search result cards without clearing existing content
     */
    private static appendSearchCards(doc: Document, container: HTMLElement, newPapers: SemanticScholarPaper[], item: Zotero.Item): void {
        // Find and remove the loading indicator if present
        const loadingIndicator = container.querySelector("#show-more-loading");
        if (loadingIndicator) {
            loadingIndicator.remove();
        }

        // Find and remove the existing Show More button (we'll add a new one at the end)
        const existingShowMore = container.querySelector("#show-more-btn");
        if (existingShowMore) {
            existingShowMore.remove();
        }

        // Update the count header
        const countHeader = container.querySelector("div:first-child");
        if (countHeader && (countHeader.textContent || "").includes("Found")) {
            countHeader.innerHTML = `📊 Found <strong>${totalSearchResults.toLocaleString()}</strong> papers • Showing ${currentSearchResults.length}`;
        }

        // Append new paper cards
        newPapers.forEach(paper => {
            const card = this.createSearchResultCard(doc, paper, item);
            container.appendChild(card);
        });

        // Batch check Unpaywall for papers without PDFs
        this.batchCheckUnpaywall(doc, newPapers);

        // Add Show More button at the end
        const showMoreBtn = ztoolkit.UI.createElement(doc, "button", {
            properties: { innerText: "📥 Show More", id: "show-more-btn" },
            styles: {
                display: "block",
                width: "calc(100% - 24px)",
                margin: "12px",
                padding: "12px",
                backgroundColor: "var(--background-secondary)",
                color: "var(--text-primary)",
                border: "1px solid var(--border-primary)",
                borderRadius: "6px",
                fontSize: "13px",
                cursor: "pointer"
            },
            listeners: [{
                type: "click",
                listener: async () => {
                    showMoreBtn.textContent = "Loading...";
                    showMoreBtn.setAttribute("disabled", "true");
                    await this.performSearch(doc);
                }
            }]
        });
        container.appendChild(showMoreBtn);
    }

    /**
     * Create a paper result card
     */
    private static createSearchResultCard(doc: Document, paper: SemanticScholarPaper, item: Zotero.Item): HTMLElement {
        const card = ztoolkit.UI.createElement(doc, "div", {
            properties: { className: "search-result-card" },
            styles: {
                padding: "12px",
                borderBottom: "1px solid var(--border-primary)",
                cursor: "pointer"
            }
        });

        // Header: Title + PDF indicator
        const header = ztoolkit.UI.createElement(doc, "div", {
            styles: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "6px" }
        });

        const title = ztoolkit.UI.createElement(doc, "div", {
            properties: { innerText: paper.title },
            styles: {
                fontSize: "13px",
                fontWeight: "600",
                color: "var(--text-primary)",
                flex: "1",
                lineHeight: "1.3"
            }
        });
        header.appendChild(title);

        if (paper.openAccessPdf) {
            // Paper has open access PDF from Semantic Scholar
            const pdfBadge = ztoolkit.UI.createElement(doc, "span", {
                properties: { innerText: "📄 PDF" },
                styles: {
                    fontSize: "10px",
                    padding: "2px 6px",
                    backgroundColor: "#e8f5e9",
                    color: "#2e7d32",
                    borderRadius: "4px",
                    marginLeft: "8px",
                    whiteSpace: "nowrap"
                }
            });
            header.appendChild(pdfBadge);
        } else if (paper.externalIds?.DOI) {
            // No Semantic Scholar PDF, but has DOI - check Unpaywall async
            const pdfBadge = ztoolkit.UI.createElement(doc, "span", {
                properties: { innerText: "🔍 Checking..." },
                styles: {
                    fontSize: "10px",
                    padding: "2px 6px",
                    backgroundColor: "#fff3e0",
                    color: "#e65100",
                    borderRadius: "4px",
                    marginLeft: "8px",
                    whiteSpace: "nowrap"
                }
            });
            header.appendChild(pdfBadge);

            // Check cache first
            if (unpaywallPdfCache.has(paper.paperId)) {
                const cachedUrl = unpaywallPdfCache.get(paper.paperId)!;
                pdfBadge.innerText = "🔗 PDF (Unpaywall)";
                pdfBadge.style.backgroundColor = "#e3f2fd";
                pdfBadge.style.color = "#1976d2";
                pdfBadge.style.cursor = "pointer";
                pdfBadge.title = cachedUrl;
                pdfBadge.addEventListener("click", (e: Event) => {
                    e.stopPropagation();
                    Zotero.launchURL(cachedUrl);
                });
            } else {
                // Async check Unpaywall
                unpaywallService.getPdfUrl(paper.externalIds.DOI).then(pdfUrl => {
                    if (pdfUrl) {
                        unpaywallPdfCache.set(paper.paperId, pdfUrl);
                        pdfBadge.innerText = "🔗 PDF (Unpaywall)";
                        pdfBadge.style.backgroundColor = "#e3f2fd";
                        pdfBadge.style.color = "#1976d2";
                        pdfBadge.style.cursor = "pointer";
                        pdfBadge.title = pdfUrl;
                        pdfBadge.addEventListener("click", (e: Event) => {
                            e.stopPropagation();
                            Zotero.launchURL(pdfUrl);
                        });
                    } else {
                        // No PDF found
                        pdfBadge.innerText = "📭 No PDF";
                        pdfBadge.style.backgroundColor = "#fafafa";
                        pdfBadge.style.color = "#9e9e9e";
                    }
                }).catch(() => {
                    pdfBadge.innerText = "📭 No PDF";
                    pdfBadge.style.backgroundColor = "#fafafa";
                    pdfBadge.style.color = "#9e9e9e";
                });
            }
        }

        card.appendChild(header);

        // Meta: Authors (clickable), Year, Venue
        const meta = ztoolkit.UI.createElement(doc, "div", {
            styles: { fontSize: "11px", color: "var(--text-secondary)", marginBottom: "6px", display: "flex", flexWrap: "wrap", alignItems: "center", gap: "2px" }
        });

        // Clickable author links
        const displayedAuthors = paper.authors?.slice(0, 3) || [];
        displayedAuthors.forEach((author, idx) => {
            const authorLink = ztoolkit.UI.createElement(doc, "span", {
                properties: { innerText: author.name },
                styles: {
                    color: "var(--highlight-primary)",
                    cursor: "pointer",
                    textDecoration: "underline"
                },
                listeners: [{
                    type: "click",
                    listener: async (e: Event) => {
                        e.stopPropagation();
                        await this.showAuthorModal(doc, author.authorId, author.name);
                    }
                }]
            });
            meta.appendChild(authorLink);
            if (idx < displayedAuthors.length - 1) {
                const comma = ztoolkit.UI.createElement(doc, "span", { properties: { innerText: ", " } });
                meta.appendChild(comma);
            }
        });

        if (paper.authors?.length > 3) {
            const more = ztoolkit.UI.createElement(doc, "span", {
                properties: { innerText: ` +${paper.authors.length - 3} more` }
            });
            meta.appendChild(more);
        }

        const yearVenue = paper.year ? ` • ${paper.year}` : "";
        const venueText = paper.venue ? ` • ${paper.venue.slice(0, 30)}${paper.venue.length > 30 ? "..." : ""}` : "";
        const extraMeta = ztoolkit.UI.createElement(doc, "span", {
            properties: { innerText: yearVenue + venueText }
        });
        meta.appendChild(extraMeta);
        card.appendChild(meta);

        // Citation count
        const citationBadge = ztoolkit.UI.createElement(doc, "div", {
            styles: { fontSize: "11px", color: "var(--text-secondary)", marginBottom: "6px" }
        });
        citationBadge.innerHTML = `📈 <strong>${paper.citationCount.toLocaleString()}</strong> citations`;
        card.appendChild(citationBadge);

        // Abstract preview (TLDR or truncated abstract)
        const abstractText = paper.tldr?.text || paper.abstract;
        if (abstractText) {
            const abstractEl = ztoolkit.UI.createElement(doc, "div", {
                properties: { innerText: abstractText.slice(0, 200) + (abstractText.length > 200 ? "..." : "") },
                styles: {
                    fontSize: "11px",
                    color: "var(--text-secondary)",
                    lineHeight: "1.4",
                    marginBottom: "8px"
                }
            });
            card.appendChild(abstractEl);
        }

        // Action buttons
        const actions = ztoolkit.UI.createElement(doc, "div", {
            styles: { display: "flex", gap: "8px", marginTop: "8px" }
        });

        const actionBtnStyle = {
            padding: "6px 10px",
            fontSize: "11px",
            border: "1px solid var(--border-primary)",
            borderRadius: "4px",
            backgroundColor: "var(--background-secondary)",
            color: "var(--text-primary)",
            cursor: "pointer"
        };

        // Add to Zotero button
        const addToZoteroBtn = ztoolkit.UI.createElement(doc, "button", {
            properties: { innerText: "➕ Add to Zotero" },
            styles: { ...actionBtnStyle, backgroundColor: "var(--highlight-primary)", color: "var(--highlight-text)", border: "none" },
            listeners: [{
                type: "click",
                listener: async (e: Event) => {
                    e.stopPropagation();
                    await this.addPaperToZotero(paper);
                    (e.target as HTMLButtonElement).textContent = "✓ Added";
                    (e.target as HTMLButtonElement).disabled = true;
                }
            }]
        });
        actions.appendChild(addToZoteroBtn);

        // Add to Table button
        const addToTableBtn = ztoolkit.UI.createElement(doc, "button", {
            properties: { innerText: "📊 Add to Table" },
            styles: actionBtnStyle,
            listeners: [{
                type: "click",
                listener: async (e: Event) => {
                    e.stopPropagation();
                    const zoteroItem = await this.addPaperToZotero(paper);
                    if (zoteroItem && currentTableConfig) {
                        if (!currentTableConfig.addedPaperIds.includes(zoteroItem.id)) {
                            currentTableConfig.addedPaperIds.push(zoteroItem.id);
                            const tableStore = getTableStore();
                            await tableStore.saveConfig(currentTableConfig);
                        }
                    }
                    (e.target as HTMLButtonElement).textContent = "✓ Added";
                    (e.target as HTMLButtonElement).disabled = true;
                }
            }]
        });
        actions.appendChild(addToTableBtn);

        // Open in browser button
        const openBtn = ztoolkit.UI.createElement(doc, "button", {
            properties: { innerText: "🔗 Open" },
            styles: actionBtnStyle,
            listeners: [{
                type: "click",
                listener: (e: Event) => {
                    e.stopPropagation();
                    Zotero.launchURL(paper.url);
                }
            }]
        });
        actions.appendChild(openBtn);

        // PDF Download button (only if open access PDF available)
        if (paper.openAccessPdf?.url) {
            const pdfBtn = ztoolkit.UI.createElement(doc, "button", {
                properties: { innerText: "🔗 PDF" },
                styles: { ...actionBtnStyle, backgroundColor: "#e3f2fd", color: "#1976d2", border: "1px solid #90caf9" },
                listeners: [{
                    type: "click",
                    listener: (e: Event) => {
                        e.stopPropagation();
                        Zotero.launchURL(paper.openAccessPdf!.url);
                    }
                }]
            });
            actions.appendChild(pdfBtn);
        }

        // Find Similar button (recommendations)
        const similarBtn = ztoolkit.UI.createElement(doc, "button", {
            properties: { innerText: "🔮 Similar" },
            styles: actionBtnStyle,
            listeners: [{
                type: "click",
                listener: async (e: Event) => {
                    e.stopPropagation();
                    const btn = e.target as HTMLButtonElement;
                    btn.textContent = "Loading...";
                    btn.disabled = true;
                    try {
                        // Get recommendations based on this paper
                        const recommendations = await semanticScholarService.getRecommendations([paper.paperId]);
                        if (recommendations.length > 0) {
                            // Replace current results with recommendations
                            currentSearchResults = recommendations;
                            totalSearchResults = recommendations.length;
                            currentSearchState.query = `Similar to: ${paper.title.slice(0, 50)}...`;
                            const resultsArea = doc.getElementById("semantic-scholar-results");
                            if (resultsArea) {
                                this.renderSearchResults(doc, resultsArea as HTMLElement, currentItem!);
                            }
                        } else {
                            btn.textContent = "No similar";
                        }
                    } catch (error) {
                        Zotero.debug(`[Seer AI] Recommendations error: ${error}`);
                        btn.textContent = "Error";
                    }
                }
            }]
        });
        actions.appendChild(similarBtn);

        card.appendChild(actions);

        // Hover effect
        card.addEventListener("mouseenter", () => {
            card.style.backgroundColor = "var(--background-secondary)";
        });
        card.addEventListener("mouseleave", () => {
            card.style.backgroundColor = "transparent";
        });

        return card;
    }

    /**
     * Show author details modal
     */
    private static async showAuthorModal(doc: Document, authorId: string, authorName: string): Promise<void> {
        // Create modal overlay
        const overlay = ztoolkit.UI.createElement(doc, "div", {
            properties: { id: "author-modal-overlay" },
            styles: {
                position: "fixed",
                top: "0",
                left: "0",
                right: "0",
                bottom: "0",
                backgroundColor: "rgba(0,0,0,0.5)",
                display: "flex",
                justifyContent: "center",
                alignItems: "center",
                zIndex: "9999"
            },
            listeners: [{
                type: "click",
                listener: (e: Event) => {
                    if (e.target === overlay) overlay.remove();
                }
            }]
        });

        // Modal content
        const modal = ztoolkit.UI.createElement(doc, "div", {
            styles: {
                backgroundColor: "var(--background-primary)",
                borderRadius: "8px",
                padding: "16px",
                minWidth: "300px",
                maxWidth: "400px",
                maxHeight: "70vh",
                overflowY: "auto",
                boxShadow: "0 8px 32px rgba(0,0,0,0.3)"
            }
        });

        // Header
        const header = ztoolkit.UI.createElement(doc, "div", {
            styles: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "12px" }
        });
        const title = ztoolkit.UI.createElement(doc, "h3", {
            properties: { innerText: `👤 ${authorName}` },
            styles: { margin: "0", fontSize: "14px", fontWeight: "600" }
        });
        const closeBtn = ztoolkit.UI.createElement(doc, "button", {
            properties: { innerText: "✕" },
            styles: { border: "none", background: "transparent", fontSize: "16px", cursor: "pointer" },
            listeners: [{ type: "click", listener: () => overlay.remove() }]
        });
        header.appendChild(title);
        header.appendChild(closeBtn);
        modal.appendChild(header);

        // Loading state
        const loadingEl = ztoolkit.UI.createElement(doc, "div", {
            properties: { innerText: "Loading author details..." },
            styles: { color: "var(--text-secondary)", fontSize: "12px" }
        });
        modal.appendChild(loadingEl);

        overlay.appendChild(modal);
        if (doc.body) {
            doc.body.appendChild(overlay);
        } else {
            doc.documentElement?.appendChild(overlay);
        }

        try {
            const authors = await semanticScholarService.getAuthorsBatch([authorId]);
            if (authors.length === 0) {
                loadingEl.textContent = "Author not found";
                return;
            }

            const author = authors[0];
            loadingEl.remove();

            // Stats
            const stats = ztoolkit.UI.createElement(doc, "div", {
                styles: { display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "8px", marginBottom: "12px" }
            });

            const statItems = [
                { label: "h-Index", value: author.hIndex ?? "N/A" },
                { label: "Papers", value: author.paperCount?.toLocaleString() ?? "N/A" },
                { label: "Citations", value: author.citationCount?.toLocaleString() ?? "N/A" }
            ];

            statItems.forEach(stat => {
                const statEl = ztoolkit.UI.createElement(doc, "div", {
                    styles: { textAlign: "center", padding: "8px", backgroundColor: "var(--background-secondary)", borderRadius: "4px" }
                });
                statEl.innerHTML = `<div style="font-size: 16px; font-weight: 600;">${stat.value}</div><div style="font-size: 10px; color: var(--text-secondary);">${stat.label}</div>`;
                stats.appendChild(statEl);
            });
            modal.appendChild(stats);

            // Recent papers
            if (author.papers && author.papers.length > 0) {
                const papersLabel = ztoolkit.UI.createElement(doc, "div", {
                    properties: { innerText: "📑 Recent Papers" },
                    styles: { fontSize: "12px", fontWeight: "500", marginBottom: "8px" }
                });
                modal.appendChild(papersLabel);

                author.papers.slice(0, 5).forEach(paper => {
                    const paperEl = ztoolkit.UI.createElement(doc, "div", {
                        properties: { innerText: `${paper.year ? `[${paper.year}] ` : ""}${paper.title}` },
                        styles: {
                            fontSize: "11px",
                            padding: "6px",
                            marginBottom: "4px",
                            backgroundColor: "var(--background-secondary)",
                            borderRadius: "4px",
                            cursor: "pointer"
                        },
                        listeners: [{
                            type: "click",
                            listener: () => {
                                Zotero.launchURL(`https://www.semanticscholar.org/paper/${paper.paperId}`);
                            }
                        }]
                    });
                    modal.appendChild(paperEl);
                });
            }

            // Semantic Scholar link
            if (author.url) {
                const linkBtn = ztoolkit.UI.createElement(doc, "button", {
                    properties: { innerText: "🔗 View on Semantic Scholar" },
                    styles: {
                        width: "100%",
                        marginTop: "12px",
                        padding: "8px",
                        backgroundColor: "var(--highlight-primary)",
                        color: "var(--highlight-text)",
                        border: "none",
                        borderRadius: "4px",
                        fontSize: "12px",
                        cursor: "pointer"
                    },
                    listeners: [{
                        type: "click",
                        listener: () => Zotero.launchURL(author.url!)
                    }]
                });
                modal.appendChild(linkBtn);
            }
        } catch (error) {
            loadingEl.textContent = `Error: ${error instanceof Error ? error.message : "Failed to load"}`;
            Zotero.debug(`[Seer AI] Author modal error: ${error}`);
        }
    }

    /**
     * Add a Semantic Scholar paper to Zotero library
     * 
     * Follows Zotero 7 API patterns:
     * 1. Create item with new Zotero.Item(type)
     * 2. Set libraryID
     * 3. Populate fields with setField()
     * 4. First saveTx() to generate item ID
     * 5. Add to collection if configured
     * 6. Second saveTx() to persist collection relationship
     * 7. Attach PDF if available
     */
    private static async addPaperToZotero(paper: SemanticScholarPaper): Promise<Zotero.Item | null> {
        try {
            Zotero.debug(`[Seer AI] Adding paper to Zotero: ${paper.title}`);

            // Determine item type based on publication types
            type ZoteroItemType = 'journalArticle' | 'conferencePaper' | 'book';
            let itemType: ZoteroItemType = 'journalArticle';
            if (paper.publicationTypes) {
                if (paper.publicationTypes.includes('Conference')) {
                    itemType = 'conferencePaper';
                } else if (paper.publicationTypes.includes('Book')) {
                    itemType = 'book';
                }
            }

            // 1. Create the item
            const newItem = new Zotero.Item(itemType);

            // 2. Determine library ownership based on selected save location
            const saveLocation = currentSearchState.saveLocation || 'user';
            let targetLibraryId = Zotero.Libraries.userLibraryID;
            let targetCollectionId: number | null = null;

            if (saveLocation === 'user') {
                // Default: user library
                targetLibraryId = Zotero.Libraries.userLibraryID;
            } else if (saveLocation.startsWith('lib_')) {
                // Group library
                targetLibraryId = parseInt(saveLocation.replace('lib_', ''), 10);
            } else if (saveLocation.startsWith('col_')) {
                // Collection - need to find its library ID
                targetCollectionId = parseInt(saveLocation.replace('col_', ''), 10);
                try {
                    const collection = Zotero.Collections.get(targetCollectionId);
                    if (collection) {
                        targetLibraryId = collection.libraryID;
                    }
                } catch (e) {
                    Zotero.debug(`[Seer AI] Error getting collection ${targetCollectionId}: ${e}`);
                }
            }

            newItem.libraryID = targetLibraryId;

            // 3. Populate metadata fields
            newItem.setField('title', paper.title);

            if (paper.abstract) {
                newItem.setField('abstractNote', paper.abstract);
            }
            if (paper.year) {
                newItem.setField('date', String(paper.year));
            }
            if (paper.venue) {
                // Use appropriate field based on item type
                if (itemType === 'conferencePaper') {
                    newItem.setField('proceedingsTitle', paper.venue);
                } else {
                    newItem.setField('publicationTitle', paper.venue);
                }
            }
            if (paper.externalIds?.DOI) {
                newItem.setField('DOI', paper.externalIds.DOI);
            }
            if (paper.url) {
                newItem.setField('url', paper.url);
            }

            // Add authors/creators
            if (paper.authors && paper.authors.length > 0) {
                const creators = paper.authors.slice(0, 20).map(author => {
                    const nameParts = author.name.trim().split(' ');
                    const lastName = nameParts.pop() || author.name;
                    const firstName = nameParts.join(' ');
                    return {
                        firstName,
                        lastName,
                        creatorType: 'author' as const
                    };
                });
                newItem.setCreators(creators);
            }

            // 4. First save to generate item ID (required before collection assignment)
            await newItem.saveTx();
            Zotero.debug(`[Seer AI] Item saved with ID: ${newItem.id} to library ${targetLibraryId}`);

            // 5. Add to collection if one was selected
            if (targetCollectionId !== null) {
                try {
                    newItem.addToCollection(targetCollectionId);
                    await newItem.saveTx(); // Second save to persist collection relationship
                    Zotero.debug(`[Seer AI] Item added to collection ${targetCollectionId}`);
                } catch (colError) {
                    Zotero.debug(`[Seer AI] Error adding to collection: ${colError}`);
                }
            }

            // 6. Attach PDF if open access URL is available, otherwise try Find Full Text
            if (paper.openAccessPdf?.url) {
                try {
                    Zotero.debug(`[Seer AI] Downloading PDF from: ${paper.openAccessPdf.url}`);

                    // Use Zotero's built-in attachment import from URL
                    await Zotero.Attachments.importFromURL({
                        url: paper.openAccessPdf.url,
                        parentItemID: newItem.id,
                        title: `${paper.title}.pdf`,
                        contentType: 'application/pdf'
                    });

                    Zotero.debug(`[Seer AI] PDF attached successfully`);
                } catch (pdfError) {
                    // PDF download failure - try Find Full Text as fallback
                    Zotero.debug(`[Seer AI] PDF download failed, trying Find Full Text: ${pdfError}`);
                    try {
                        await (Zotero.Attachments as any).addAvailablePDF(newItem);
                        Zotero.debug(`[Seer AI] Find Full Text initiated`);
                    } catch (findError) {
                        Zotero.debug(`[Seer AI] Find Full Text failed (non-fatal): ${findError}`);
                    }
                }
            } else {
                // No Semantic Scholar PDF - check Unpaywall cache first
                const cachedUnpaywallUrl = unpaywallPdfCache.get(paper.paperId);
                if (cachedUnpaywallUrl) {
                    try {
                        Zotero.debug(`[Seer AI] Using Unpaywall PDF: ${cachedUnpaywallUrl}`);
                        await Zotero.Attachments.importFromURL({
                            url: cachedUnpaywallUrl,
                            parentItemID: newItem.id,
                            title: `${paper.title}.pdf`,
                            contentType: 'application/pdf'
                        });
                        Zotero.debug(`[Seer AI] Unpaywall PDF attached successfully`);
                    } catch (pdfError) {
                        // Unpaywall download failed - try Find Full Text
                        Zotero.debug(`[Seer AI] Unpaywall PDF download failed, trying Find Full Text: ${pdfError}`);
                        try {
                            await (Zotero.Attachments as any).addAvailablePDF(newItem);
                            Zotero.debug(`[Seer AI] Find Full Text initiated`);
                        } catch (findError) {
                            Zotero.debug(`[Seer AI] Find Full Text failed (non-fatal): ${findError}`);
                        }
                    }
                } else {
                    // No cached Unpaywall PDF - trigger Zotero's "Find Full Text"
                    try {
                        Zotero.debug(`[Seer AI] No PDF available, initiating Find Full Text...`);
                        await (Zotero.Attachments as any).addAvailablePDF(newItem);
                        Zotero.debug(`[Seer AI] Find Full Text initiated`);
                    } catch (findError) {
                        // Find Full Text failure is non-fatal
                        Zotero.debug(`[Seer AI] Find Full Text failed (non-fatal): ${findError}`);
                    }
                }
            }

            return newItem;
        } catch (error) {
            Zotero.debug(`[Seer AI] Error adding paper to Zotero: ${error}`);
            return null;
        }
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

        // Workspace Title (Persistent & Editable)
        const titleContainer = ztoolkit.UI.createElement(doc, "div", {
            styles: {
                display: "flex",
                alignItems: "center",
                gap: "4px",
                marginRight: "8px",
                padding: "2px 8px",
                borderRadius: "4px",
                border: "1px solid transparent",
                cursor: "pointer",
                transition: "all 0.2s"
            },
            listeners: [{
                type: "mouseenter",
                listener: () => {
                    if (!titleContainer.classList.contains("editing")) {
                        titleContainer.style.backgroundColor = "var(--background-secondary)";
                        titleContainer.style.border = "1px solid var(--border-primary)";
                    }
                }
            }, {
                type: "mouseleave",
                listener: () => {
                    if (!titleContainer.classList.contains("editing")) {
                        titleContainer.style.backgroundColor = "transparent";
                        titleContainer.style.border = "1px solid transparent";
                    }
                }
            }, {
                type: "click",
                listener: () => {
                    if (titleContainer.classList.contains("editing")) return;

                    const nameLabel = titleContainer.querySelector(".workspace-name-label") as HTMLElement;
                    const currentName = currentTableConfig?.name || "Untitled Workspace";

                    // Switch to edit mode
                    titleContainer.classList.add("editing");
                    titleContainer.innerHTML = "";

                    const input = ztoolkit.UI.createElement(doc, "input", {
                        attributes: { type: "text", value: currentName },
                        styles: {
                            fontSize: "12px",
                            fontWeight: "600",
                            padding: "2px 4px",
                            border: "1px solid var(--highlight-primary)",
                            borderRadius: "2px",
                            outline: "none",
                            width: "150px",
                            color: "var(--text-primary)",
                            backgroundColor: "var(--background-primary)"
                        }
                    }) as HTMLInputElement;

                    const saveName = async () => {
                        const newName = input.value.trim() || "Untitled Workspace";
                        if (currentTableConfig) {
                            currentTableConfig.name = newName;
                            const tableStore = getTableStore();
                            await tableStore.saveConfig(currentTableConfig);
                        }
                        // Re-render title
                        renderTitle();
                        titleContainer.classList.remove("editing");
                    };

                    input.addEventListener("blur", saveName);
                    input.addEventListener("keypress", (e: Event) => {
                        const ke = e as KeyboardEvent;
                        if (ke.key === "Enter") {
                            input.blur();
                        }
                    });

                    titleContainer.appendChild(input);
                    input.focus();
                    input.select();
                }
            }]
        });

        const renderTitle = () => {
            titleContainer.innerHTML = "";
            const prefix = ztoolkit.UI.createElement(doc, "span", {
                properties: { innerText: "WORKSPACE:" },
                styles: { fontSize: "10px", color: "var(--text-secondary)", fontWeight: "600", letterSpacing: "0.5px" }
            });

            const name = ztoolkit.UI.createElement(doc, "span", {
                properties: { className: "workspace-name-label", innerText: currentTableConfig?.name || "Untitled Workspace" },
                styles: { fontSize: "12px", fontWeight: "600", color: "var(--text-primary)" }
            });

            const editIcon = ztoolkit.UI.createElement(doc, "span", {
                properties: { innerText: "✎" },
                styles: { fontSize: "10px", color: "var(--text-tertiary)", opacity: "0.5" }
            });

            titleContainer.appendChild(prefix);
            titleContainer.appendChild(name);
            titleContainer.appendChild(editIcon);
        };

        renderTitle();
        toolbar.appendChild(titleContainer);

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

        // Extract All button (for OCR)
        const extractBtn = ztoolkit.UI.createElement(doc, "button", {
            properties: { className: "table-btn extract-all-btn", innerText: "📄 Extract All" },
            attributes: { id: "extract-all-btn" },
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
                    await this.extractAllEmptyPDFs(doc, item);
                }
            }]
        });
        toolbar.appendChild(extractBtn);

        // Response-length control
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
                    this.showWorkspacePicker(doc, item);
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
     * Populate the save location dropdown for search imports
     */
    private static populateSaveLocationSelect(select: HTMLSelectElement): void {
        const doc = select.ownerDocument;
        if (!doc) return;

        try {
            const libraries = Zotero.Libraries.getAll();
            for (const library of libraries) {
                // Library option
                const libOption = doc.createElement("option");
                // Use 'user' for user library (matches default), 'lib_ID' for group libraries
                libOption.value = library.libraryID === Zotero.Libraries.userLibraryID ? "user" : `lib_${library.libraryID}`;
                libOption.textContent = `📚 ${library.name}`;
                if (currentSearchState.saveLocation === libOption.value) {
                    libOption.selected = true;
                }
                select.appendChild(libOption);

                // Get collections for this library
                const collections = Zotero.Collections.getByLibrary(library.libraryID);
                for (const collection of collections) {
                    const colOption = doc.createElement("option");
                    colOption.value = `col_${collection.id}`;
                    colOption.textContent = `  📁 ${collection.name}`;
                    if (currentSearchState.saveLocation === colOption.value) {
                        colOption.selected = true;
                    }
                    select.appendChild(colOption);
                }
            }
        } catch (e) {
            Zotero.debug(`[Seer AI] Error populating save location select: ${e}`);
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

                                    // Update table view immediately
                                    const tableWrapper = doc.querySelector('.table-wrapper');
                                    if (tableWrapper) {
                                        const newData = await this.loadTableData();
                                        const newTable = this.createPapersTable(doc, newData);
                                        tableWrapper.innerHTML = "";
                                        tableWrapper.appendChild(newTable);
                                    }

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

            // Check if item has notes - skip if no notes to save resources
            if (paperItem.getNotes().length === 0) continue;

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

                // Only generate from notes
                let content = await this.generateColumnContent(task.item, task.col, noteIds);

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
                    task.td.innerHTML = `<span style="color: var(--text-tertiary); font-size: 11px; font-style: italic;">Empty - no notes</span>`;
                    task.td.title = "No notes found. Use 'Extract with OCR' to create notes first.";
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
     * Extract text from all visible PDFs that don't have notes
     */
    private static async extractAllEmptyPDFs(doc: Document, item: Zotero.Item): Promise<void> {
        Zotero.debug("[Seer AI] Extract All clicked");

        // Find all visible rows
        const table = doc.querySelector('.papers-table');
        if (!table) return;

        const rows = table.querySelectorAll('tr[data-paper-id]');
        if (rows.length === 0) return;

        // Get max concurrent from settings (OCR-specific setting)
        const maxConcurrent = (Zotero.Prefs.get(`${addon.data.config.prefsPrefix}.datalabMaxConcurrent`) as number) || 5;
        Zotero.debug(`[Seer AI] OCR Max concurrent: ${maxConcurrent}`);

        // Build list of extraction tasks
        interface ExtractionTask {
            paperId: number;
            pdf: Zotero.Item;
            tds: HTMLElement[]; // Any "Click to process PDF" cells to update
            item: Zotero.Item;
        }
        const tasks: ExtractionTask[] = [];

        // Helper to check for existing notes
        const hasExistingNote = (parent: Zotero.Item): boolean => {
            return ocrService.hasExistingNote(parent);
        };

        for (let i = 0; i < rows.length; i++) {
            const tr = rows[i] as HTMLElement;
            const paperId = parseInt(tr.getAttribute('data-paper-id') || "0", 10);
            if (!paperId) continue;

            // Get paper item
            const paperItem = Zotero.Items.get(paperId);
            if (!paperItem || !paperItem.isRegularItem()) continue;

            // 1. Check if has PDF
            const pdf = ocrService.getFirstPdfAttachment(paperItem);
            if (!pdf) continue;

            // 2. Check if already has notes matching title
            if (hasExistingNote(paperItem)) continue;

            // Find cells that might show "Click to process PDF" status
            // These would be computed cells that are empty
            const tds: HTMLElement[] = [];
            if (currentTableConfig && currentTableConfig.columns) {
                currentTableConfig.columns.forEach((col, idx) => {
                    if (col.type === 'computed' && col.visible) {
                        const cellVal = (currentTableData?.rows.find(r => r.paperId === paperId)?.data[col.id]) || '';
                        if (!cellVal.trim()) {
                            // This cell is empty, so it might show the "OCR" prompt
                            // Actual index in DOM depends on visible columns
                            const visibleIdx = currentTableConfig!.columns.filter(c => c.visible).findIndex(c => c.id === col.id);
                            if (visibleIdx !== -1 && tr.children[visibleIdx]) {
                                tds.push(tr.children[visibleIdx] as HTMLElement);
                            }
                        }
                    }
                });
            }

            tasks.push({
                paperId,
                pdf,
                tds,
                item: paperItem
            });

            // Immediate feedback
            tds.forEach(td => {
                td.innerHTML = `<span style="color: var(--text-tertiary); font-size: 11px;">📄 Queued...</span>`;
                td.style.cursor = "wait";
            });
        }

        if (tasks.length === 0) {
            Zotero.debug("[Seer AI] No PDFs to extract");
            return;
        }

        Zotero.debug(`[Seer AI] ${tasks.length} PDFs to extract`);

        const extractBtn = doc.getElementById('extract-all-btn') as HTMLButtonElement | null;
        const originalBtnText = extractBtn?.innerText || "📄 Extract All";
        let completed = 0;
        let success = 0;
        let failed = 0;

        const updateProgress = () => {
            if (extractBtn) {
                extractBtn.innerText = `📄 OCR ${completed}/${tasks.length}`;
                extractBtn.disabled = true;
                extractBtn.style.cursor = "wait";
            }
        };

        const processTask = async (task: ExtractionTask): Promise<void> => {
            try {
                // Update cells to "Processing"
                task.tds.forEach(td => {
                    td.innerHTML = `<span style="color: var(--highlight-primary); font-size: 11px;">📄 OCR Processing...</span>`;
                });

                // Run silent OCR
                await ocrService.convertToMarkdown(task.pdf, { showProgress: false });

                // Update cells to "Done"
                task.tds.forEach(td => {
                    td.innerHTML = `<span style="color: green; font-size: 11px;">✓ Note Extracted</span>`;
                });
                success++;
            } catch (e) {
                Zotero.debug(`[Seer AI] OCR Error for ${task.paperId}: ${e}`);
                task.tds.forEach(td => {
                    td.innerHTML = `<span style="color: #c62828; font-size: 11px;">OCR Error</span>`;
                    td.title = String(e);
                });
                failed++;
            } finally {
                completed++;
                updateProgress();
            }
        };

        // Process in batches
        updateProgress();
        for (let i = 0; i < tasks.length; i += maxConcurrent) {
            const batch = tasks.slice(i, i + maxConcurrent);
            await Promise.all(batch.map(processTask));

            // Refresh logic - notes added, so we should refresh validity
            // But full refresh might kill our "Done" status
            // Maybe just refresh at very end
        }

        // Restore button
        if (extractBtn) {
            extractBtn.innerText = `✓ OCR Done (${success})`;
            extractBtn.disabled = false;
            extractBtn.style.cursor = "pointer";
            setTimeout(() => {
                extractBtn.innerText = originalBtnText;
            }, 2000);
        }

        // Refresh table to pick up new notes and show "Generate" button
        setTimeout(() => {
            this.debounceTableRefresh(doc, item);
        }, 1500);
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
     * Show table history/workspace picker with renaming support
     */
    private static async showWorkspacePicker(doc: Document, item: Zotero.Item): Promise<void> {
        // Toggle existing dropdown
        const existing = doc.getElementById("workspace-picker-dropdown") as HTMLElement;
        if (existing) {
            existing.style.opacity = "0";
            existing.style.transform = "translateY(-10px)";
            setTimeout(() => existing.remove(), 200);
            return;
        }

        const toolbar = doc.querySelector(".table-toolbar") as HTMLElement;
        if (!toolbar || !toolbar.parentNode) return;

        // Create dropdown - match Add Papers style with inline positioning
        const dropdown = ztoolkit.UI.createElement(doc, "div", {
            properties: { id: "workspace-picker-dropdown" },
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
                marginTop: "8px",
                marginLeft: "8px",
                marginRight: "8px"
            }
        });

        // Header
        const header = ztoolkit.UI.createElement(doc, "div", {
            styles: {
                background: "linear-gradient(135deg, var(--highlight-primary) 0%, color-mix(in srgb, var(--highlight-primary) 80%, black) 100%)",
                padding: "10px 14px",
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                borderRadius: "8px 8px 0 0"
            }
        });

        const headerTitle = ztoolkit.UI.createElement(doc, "div", {
            properties: { innerText: "📂 Saved Workspaces" },
            styles: {
                fontSize: "13px",
                fontWeight: "600",
                color: "var(--highlight-text)",
                textShadow: "0 1px 2px rgba(0,0,0,0.1)"
            }
        });
        header.appendChild(headerTitle);

        const closeBtn = ztoolkit.UI.createElement(doc, "button", {
            properties: { innerText: "✕" },
            styles: {
                background: "rgba(0,0,0,0.1)",
                border: "none",
                borderRadius: "50%",
                width: "22px",
                height: "22px",
                cursor: "pointer",
                color: "var(--highlight-text)",
                fontSize: "11px",
                display: "flex",
                alignItems: "center",
                justifyContent: "center"
            },
            listeners: [{
                type: "click",
                listener: () => {
                    dropdown.style.opacity = "0";
                    setTimeout(() => dropdown.remove(), 200);
                }
            }]
        });
        header.appendChild(closeBtn);
        dropdown.appendChild(header);

        // Content
        const content = ztoolkit.UI.createElement(doc, "div", {
            styles: { padding: "8px", display: "flex", flexDirection: "column", gap: "8px" }
        });

        const listContainer = ztoolkit.UI.createElement(doc, "div", {
            styles: {
                maxHeight: "240px",
                overflowY: "auto",
                borderRadius: "6px",
                backgroundColor: "var(--background-secondary)"
            }
        });

        // Load history
        const tableStore = getTableStore();
        const history = await tableStore.loadHistory();

        const renderList = async () => {
            listContainer.innerHTML = "";
            if (history.entries.length === 0) {
                listContainer.appendChild(ztoolkit.UI.createElement(doc, "div", {
                    properties: { innerText: "No saved workspaces." },
                    styles: { padding: "16px", textAlign: "center", color: "var(--text-secondary)", fontSize: "12px" }
                }));
            } else {
                for (const entry of history.entries) {
                    const isActive = currentTableConfig && currentTableConfig.id === entry.config.id;
                    const row = ztoolkit.UI.createElement(doc, "div", {
                        styles: {
                            padding: "8px 10px",
                            borderBottom: "1px solid var(--border-primary)",
                            cursor: "pointer",
                            display: "flex",
                            justifyContent: "space-between",
                            alignItems: "center",
                            backgroundColor: isActive ? "var(--background-hover)" : "transparent"
                        }
                    });

                    // Left side: Name and meta
                    const info = ztoolkit.UI.createElement(doc, "div", {
                        styles: { flex: "1", overflow: "hidden", marginRight: "8px" },
                        listeners: [{
                            type: "click",
                            listener: async () => {
                                // Load workspace
                                currentTableConfig = { ...entry.config };
                                entry.usedAt = new Date().toISOString();
                                await tableStore.saveHistory(history); // Update last used
                                await tableStore.saveConfig(currentTableConfig); // Set as current

                                dropdown.style.opacity = "0";
                                setTimeout(() => dropdown.remove(), 200);

                                if (currentContainer && currentItem) {
                                    this.renderInterface(currentContainer, currentItem);
                                }
                            }
                        }]
                    });

                    const nameEl = ztoolkit.UI.createElement(doc, "div", {
                        properties: { innerText: entry.config.name || "Untitled Workpace" },
                        styles: { fontSize: "12px", fontWeight: isActive ? "600" : "500", color: "var(--text-primary)" }
                    });

                    const metaEl = ztoolkit.UI.createElement(doc, "div", {
                        properties: { innerText: `${new Date(entry.usedAt).toLocaleDateString()} • ${entry.config.addedPaperIds?.length || 0} papers` },
                        styles: { fontSize: "10px", color: "var(--text-secondary)", marginTop: "2px" }
                    });

                    info.appendChild(nameEl);
                    info.appendChild(metaEl);
                    row.appendChild(info);

                    // Actions
                    const actions = ztoolkit.UI.createElement(doc, "div", {
                        styles: { display: "flex", gap: "4px" }
                    });

                    // Rename button
                    const renameBtn = ztoolkit.UI.createElement(doc, "button", {
                        properties: { innerText: "✏️", title: "Rename" },
                        styles: {
                            background: "none",
                            border: "none",
                            cursor: "pointer",
                            fontSize: "12px",
                            opacity: "0.6",
                            padding: "2px"
                        },
                        listeners: [{
                            type: "click",
                            listener: async (e: Event) => {
                                e.stopPropagation();
                                const newName = doc.defaultView?.prompt("Rename workspace:", entry.config.name);
                                if (newName) {
                                    entry.config.name = newName;
                                    await tableStore.saveHistory(history);
                                    if (isActive && currentTableConfig) {
                                        currentTableConfig.name = newName;
                                        await tableStore.saveConfig(currentTableConfig);
                                    }
                                    renderList(); // Re-render list
                                }
                            }
                        }]
                    });
                    renameBtn.addEventListener("mouseenter", () => (renameBtn.style.opacity = "1"));
                    renameBtn.addEventListener("mouseleave", () => (renameBtn.style.opacity = "0.6"));

                    actions.appendChild(renameBtn);

                    // Delete button
                    const deleteBtn = ztoolkit.UI.createElement(doc, "button", {
                        properties: { innerText: "🗑", title: "Delete" },
                        styles: {
                            background: "none",
                            border: "none",
                            cursor: "pointer",
                            fontSize: "12px",
                            color: "#c62828",
                            opacity: "0.6",
                            padding: "2px"
                        },
                        listeners: [{
                            type: "click",
                            listener: async (e: Event) => {
                                e.stopPropagation();
                                if (doc.defaultView?.confirm(`Delete workspace "${entry.config.name}"?`)) {
                                    const idx = history.entries.indexOf(entry);
                                    if (idx > -1) {
                                        history.entries.splice(idx, 1);
                                        await tableStore.saveHistory(history);
                                        // If deleted active one, maybe reset? keeping it simple for now
                                        renderList();
                                    }
                                }
                            }
                        }]
                    });
                    deleteBtn.addEventListener("mouseenter", () => (deleteBtn.style.opacity = "1"));
                    deleteBtn.addEventListener("mouseleave", () => (deleteBtn.style.opacity = "0.6"));

                    actions.appendChild(deleteBtn);
                    row.appendChild(actions);

                    // Highlight active
                    if (isActive) {
                        const check = ztoolkit.UI.createElement(doc, "div", {
                            properties: { innerText: "✓" },
                            styles: { fontSize: "14px", color: "var(--highlight-primary)", marginRight: "6px" }
                        });
                        row.insertBefore(check, info);
                    }

                    listContainer.appendChild(row);
                }
            }
        };

        await renderList();
        content.appendChild(listContainer);
        dropdown.appendChild(content);

        // Insert after toolbar in the DOM flow (same as Add Papers dropdown)
        toolbar.parentNode.insertBefore(dropdown, toolbar.nextSibling);

        // Animate in
        setTimeout(() => {
            dropdown.style.opacity = "1";
            dropdown.style.transform = "translateY(0)";
        }, 10);
    }

    /**
     * Show picker to add table items to chat - Matched to Add Papers style
     */
    private static async showChatTablePicker(doc: Document, stateManager: ReturnType<typeof getChatStateManager>): Promise<void> {
        // Toggle existing dropdown
        const existing = doc.getElementById("chat-table-picker-dropdown") as HTMLElement;
        if (existing) {
            existing.style.opacity = "0";
            existing.style.transform = "translateY(-10px)";
            setTimeout(() => existing.remove(), 200);
            return;
        }

        const selectionArea = doc.getElementById("selection-area");
        if (!selectionArea || !selectionArea.parentNode) return;

        // Create dropdown panel
        const dropdown = ztoolkit.UI.createElement(doc, "div", {
            properties: { id: "chat-table-picker-dropdown" },
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
                marginTop: "8px",
                marginLeft: "8px",
                marginRight: "8px"
            }
        });

        // Header
        const header = ztoolkit.UI.createElement(doc, "div", {
            styles: {
                background: "linear-gradient(135deg, var(--highlight-primary) 0%, color-mix(in srgb, var(--highlight-primary) 80%, purple) 100%)",
                padding: "10px 14px",
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                gap: "12px"
            }
        });

        const headerTitle = ztoolkit.UI.createElement(doc, "div", {
            properties: { innerText: "📊 Add From Table" },
            styles: {
                fontSize: "13px",
                fontWeight: "600",
                color: "var(--highlight-text)",
                textShadow: "0 1px 2px rgba(0,0,0,0.1)"
            }
        });
        header.appendChild(headerTitle);

        const closeBtn = ztoolkit.UI.createElement(doc, "button", {
            properties: { innerText: "✕" },
            styles: {
                background: "rgba(0,0,0,0.1)",
                border: "none",
                borderRadius: "50%",
                width: "22px",
                height: "22px",
                cursor: "pointer",
                color: "var(--highlight-text)",
                fontSize: "11px",
                display: "flex",
                alignItems: "center",
                justifyContent: "center"
            },
            listeners: [{
                type: "click", listener: () => {
                    dropdown.style.opacity = "0";
                    dropdown.style.transform = "translateY(-10px)";
                    setTimeout(() => dropdown.remove(), 200);
                }
            }]
        });
        header.appendChild(closeBtn);
        dropdown.appendChild(header);

        // Content
        const content = ztoolkit.UI.createElement(doc, "div", {
            styles: { padding: "10px 14px", display: "flex", flexDirection: "column", gap: "8px" }
        });

        const listContainer = ztoolkit.UI.createElement(doc, "div", {
            styles: {
                maxHeight: "240px",
                overflowY: "auto",
                border: "1px solid var(--border-primary)",
                borderRadius: "6px",
                backgroundColor: "var(--background-secondary)"
            }
        });

        // Load tables
        const tableStore = getTableStore();
        const history = await tableStore.loadHistory();

        if (history.entries.length === 0) {
            listContainer.appendChild(ztoolkit.UI.createElement(doc, "div", {
                properties: { innerText: "No saved tables found." },
                styles: { padding: "20px", textAlign: "center", color: "var(--text-secondary)", fontSize: "12px" }
            }));
        } else {
            for (const entry of history.entries) {
                const row = ztoolkit.UI.createElement(doc, "div", {
                    styles: {
                        padding: "8px 10px",
                        borderBottom: "1px solid var(--border-primary)",
                        cursor: "pointer",
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        transition: "background-color 0.1s"
                    }
                });
                row.addEventListener("mouseenter", () => { row.style.backgroundColor = "var(--background-primary)"; });
                row.addEventListener("mouseleave", () => { row.style.backgroundColor = ""; });

                const info = ztoolkit.UI.createElement(doc, "div", {
                    styles: { flex: "1", overflow: "hidden", marginRight: "10px" }
                });

                const nameEl = ztoolkit.UI.createElement(doc, "div", {
                    properties: { innerText: entry.config.name || "Untitled Table" },
                    styles: { fontSize: "12px", fontWeight: "600", color: "var(--text-primary)" }
                });

                const count = entry.config.addedPaperIds?.length || 0;
                const metaEl = ztoolkit.UI.createElement(doc, "div", {
                    properties: { innerText: `${count} papers • ${new Date(entry.usedAt).toLocaleDateString()}` },
                    styles: { fontSize: "11px", color: "var(--text-secondary)", marginTop: "1px" }
                });

                info.appendChild(nameEl);
                info.appendChild(metaEl);
                row.appendChild(info);

                const addBtn = ztoolkit.UI.createElement(doc, "button", {
                    properties: { innerText: "Add Table Context" },
                    styles: {
                        padding: "4px 10px",
                        borderRadius: "12px",
                        border: "1px solid var(--highlight-primary)",
                        backgroundColor: "transparent",
                        color: "var(--highlight-primary)",
                        fontSize: "11px",
                        cursor: "pointer",
                        fontWeight: "600",
                        transition: "all 0.15s"
                    },
                    listeners: [{
                        type: "click",
                        listener: async (e: Event) => {
                            e.stopPropagation();
                            const paperIds = entry.config.addedPaperIds || [];
                            if (paperIds.length === 0) {
                                doc.defaultView?.alert("This table is empty.");
                                return;
                            }

                            // Build table context from the saved table data
                            const columns = entry.config.columns?.filter(c => c.visible) || defaultColumns.filter(c => c.visible);
                            const columnNames = columns.map(c => c.name);
                            const generatedData = entry.config.generatedData || {};

                            // Format table data as text context
                            let tableContent = '';
                            let rowCount = 0;

                            for (const paperId of paperIds) {
                                const item = Zotero.Items.get(paperId);
                                if (!item || !item.isRegularItem()) continue;

                                const paperTitle = item.getField('title') as string || 'Untitled';
                                const creators = item.getCreators();
                                const authorNames = creators.map(c => `${c.firstName || ''} ${c.lastName || ''}`.trim()).join(', ') || 'Unknown';
                                const year = item.getField('year') as string || '';
                                const noteIDs = item.getNotes();
                                const persistedData = generatedData[paperId] || {};

                                // Build row data
                                const rowData: Record<string, string> = {
                                    title: paperTitle,
                                    author: authorNames,
                                    year: year,
                                    sources: String(noteIDs.length),
                                    ...persistedData
                                };

                                // Format as readable entry
                                tableContent += `\n### ${paperTitle}\n`;
                                for (const col of columns) {
                                    if (col.id === 'title') continue; // Title already in header
                                    const value = rowData[col.id] || '';
                                    if (value) {
                                        tableContent += `- **${col.name}**: ${value}\n`;
                                    }
                                }
                                rowCount++;
                            }

                            // Create table selection object
                            const tableSelection: SelectedTable = {
                                id: entry.config.id || `table_${Date.now()}`,
                                type: 'table',
                                title: entry.config.name || 'Untitled Table',
                                content: tableContent,
                                rowCount: rowCount,
                                columnNames: columnNames
                            };

                            // Add to state manager
                            stateManager.addSelection('tables', tableSelection);
                            this.reRenderSelectionArea();

                            // Feedback
                            addBtn.innerText = "✓ Added";
                            addBtn.style.backgroundColor = "var(--highlight-primary)";
                            addBtn.style.color = "var(--highlight-text)";
                            setTimeout(() => {
                                dropdown.style.opacity = "0";
                                setTimeout(() => dropdown.remove(), 200);
                            }, 500);
                        }
                    }]
                });
                addBtn.addEventListener("mouseenter", () => {
                    addBtn.style.backgroundColor = "var(--highlight-primary)";
                    addBtn.style.color = "var(--highlight-text)";
                });
                addBtn.addEventListener("mouseleave", () => {
                    if (addBtn.innerText !== "✓ Added") {
                        addBtn.style.backgroundColor = "transparent";
                        addBtn.style.color = "var(--highlight-primary)";
                    }
                });

                row.appendChild(addBtn);
                listContainer.appendChild(row);
            }
        }

        content.appendChild(listContainer);
        dropdown.appendChild(content);

        // Done button logic (optional, users can just close)
        const buttonRow = ztoolkit.UI.createElement(doc, "div", {
            styles: { padding: "8px 14px", borderTop: "1px solid var(--border-primary)", display: "flex", justifyContent: "flex-end" }
        });
        const doneBtn = ztoolkit.UI.createElement(doc, "button", {
            properties: { innerText: "Done" },
            styles: {
                padding: "6px 14px",
                border: "1px solid var(--border-primary)",
                borderRadius: "6px",
                fontSize: "12px",
                backgroundColor: "var(--background-secondary)",
                cursor: "pointer"
            },
            listeners: [{
                type: "click",
                listener: () => {
                    dropdown.style.opacity = "0";
                    dropdown.style.transform = "translateY(-10px)";
                    setTimeout(() => dropdown.remove(), 200);
                }
            }]
        });
        buttonRow.appendChild(doneBtn);
        dropdown.appendChild(buttonRow);

        selectionArea.parentNode.insertBefore(dropdown, selectionArea.nextSibling);

        // Animate in
        setTimeout(() => {
            dropdown.style.opacity = "1";
            dropdown.style.transform = "translateY(0)";
        }, 10);
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

        // Add Table button
        const addTableBtn = ztoolkit.UI.createElement(doc, "button", {
            properties: { innerText: "📊 Add Table" },
            styles: {
                padding: "4px 10px",
                fontSize: "11px",
                border: "1px dashed var(--highlight-primary)",
                borderRadius: "4px",
                backgroundColor: "transparent",
                cursor: "pointer",
                color: "var(--highlight-primary)"
            },
            listeners: [{
                type: "click",
                listener: () => {
                    Zotero.debug("[Seer AI] Add Table button clicked");
                    this.showChatTablePicker(doc, stateManager);
                }
            }]
        });
        selectionArea.appendChild(addTableBtn);

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

        // Render table chips (if any selected)
        if (states.tables.length > 0) {
            states.tables.forEach(table => {
                const chipLabel = `${table.title} (${table.rowCount} rows)`;
                const chip = this.createChip(doc, chipLabel, selectionConfigs.tables, () => {
                    stateManager.removeSelection('tables', table.id);
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
     * Show tag picker as a beautiful inline dropdown panel for Chat
     */
    private static async showTagPicker(doc: Document, stateManager: ReturnType<typeof getChatStateManager>): Promise<void> {
        // Toggle existing dropdown
        const existing = doc.getElementById("chat-tag-picker-dropdown") as HTMLElement;
        if (existing) {
            existing.style.opacity = "0";
            existing.style.transform = "translateY(-10px)";
            setTimeout(() => existing.remove(), 200);
            return;
        }

        const selectionArea = doc.getElementById("selection-area");
        if (!selectionArea || !selectionArea.parentNode) return;

        // Create dropdown
        const dropdown = ztoolkit.UI.createElement(doc, "div", {
            properties: { id: "chat-tag-picker-dropdown" },
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
                marginTop: "8px",
                marginLeft: "8px",
                marginRight: "8px"
            }
        });

        // Header
        const header = ztoolkit.UI.createElement(doc, "div", {
            styles: {
                background: "linear-gradient(135deg, var(--highlight-primary) 0%, color-mix(in srgb, var(--highlight-primary) 80%, orange) 100%)", // Orange hint for tags
                padding: "10px 14px",
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                gap: "12px"
            }
        });

        const headerTitle = ztoolkit.UI.createElement(doc, "div", {
            properties: { innerText: "🏷️ Add Tags to Chat" },
            styles: {
                fontSize: "13px",
                fontWeight: "600",
                color: "var(--highlight-text)",
                textShadow: "0 1px 2px rgba(0,0,0,0.1)"
            }
        });
        header.appendChild(headerTitle);

        const closeBtn = ztoolkit.UI.createElement(doc, "button", {
            properties: { innerText: "✕" },
            styles: {
                background: "rgba(0,0,0,0.1)",
                border: "none",
                borderRadius: "50%",
                width: "22px",
                height: "22px",
                cursor: "pointer",
                color: "var(--highlight-text)",
                fontSize: "11px",
                display: "flex",
                alignItems: "center",
                justifyContent: "center"
            },
            listeners: [{
                type: "click", listener: () => {
                    dropdown.style.opacity = "0";
                    setTimeout(() => dropdown.remove(), 200);
                }
            }]
        });
        header.appendChild(closeBtn);
        dropdown.appendChild(header);

        // Content
        const content = ztoolkit.UI.createElement(doc, "div", {
            styles: { padding: "10px 14px", display: "flex", flexDirection: "column", gap: "8px" }
        });

        // Controls
        const controlsRow = ztoolkit.UI.createElement(doc, "div", {
            styles: { display: "flex", gap: "6px", alignItems: "center" }
        });

        // Filter Select
        const filterSelect = ztoolkit.UI.createElement(doc, "select", {
            styles: {
                flex: "0 0 auto",
                minWidth: "120px",
                padding: "6px 10px",
                border: "1px solid var(--border-primary)",
                borderRadius: "6px",
                fontSize: "12px",
                backgroundColor: "var(--background-secondary)",
                color: "var(--text-primary)",
                cursor: "pointer",
                outline: "none"
            }
        }) as HTMLSelectElement;

        // Populate filter (using getAllCollections helper or populateFilterSelect)
        // Note: populateFilterSelect adds "All Libraries" etc. works well.
        this.populateFilterSelect(filterSelect);
        controlsRow.appendChild(filterSelect);

        // Search
        const searchInput = ztoolkit.UI.createElement(doc, "input", {
            attributes: { type: "text", placeholder: "🔍 Search tags..." },
            styles: {
                flex: "1",
                padding: "6px 10px",
                border: "1px solid var(--border-primary)",
                borderRadius: "6px",
                fontSize: "12px",
                backgroundColor: "var(--background-secondary)",
                color: "var(--text-primary)",
                outline: "none"
            }
        }) as HTMLInputElement;
        controlsRow.appendChild(searchInput);
        content.appendChild(controlsRow);

        // List
        const listContainer = ztoolkit.UI.createElement(doc, "div", {
            styles: {
                maxHeight: "240px",
                overflowY: "auto",
                border: "1px solid var(--border-primary)",
                borderRadius: "6px",
                backgroundColor: "var(--background-secondary)"
            }
        });
        content.appendChild(listContainer);
        dropdown.appendChild(content);

        // Tags Logic
        let allTags: { tag: string }[] = [];

        const renderTags = () => {
            listContainer.innerHTML = "";
            const searchQuery = searchInput.value.toLowerCase();
            const filtered = allTags.filter(t => t.tag.toLowerCase().includes(searchQuery)).slice(0, 50);

            if (filtered.length === 0) {
                listContainer.appendChild(ztoolkit.UI.createElement(doc, "div", { properties: { innerText: "No tags found." }, styles: { padding: "20px", textAlign: "center", color: "var(--text-secondary)", fontSize: "12px" } }));
                return;
            }

            filtered.forEach(t => {
                const row = ztoolkit.UI.createElement(doc, "div", {
                    styles: {
                        padding: "8px 10px",
                        borderBottom: "1px solid var(--border-primary)",
                        cursor: "pointer",
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center"
                    }
                });
                row.addEventListener("mouseenter", () => { row.style.backgroundColor = "var(--background-primary)"; });
                row.addEventListener("mouseleave", () => { row.style.backgroundColor = ""; });

                const label = ztoolkit.UI.createElement(doc, "div", {
                    properties: { innerText: t.tag },
                    styles: { fontSize: "12px", color: "var(--text-primary)", fontWeight: "500" }
                });
                row.appendChild(label);

                const addBtn = ztoolkit.UI.createElement(doc, "button", {
                    properties: { innerText: "+" },
                    styles: {
                        width: "24px",
                        height: "24px",
                        borderRadius: "50%",
                        border: "1px solid var(--highlight-primary)",
                        backgroundColor: "transparent",
                        color: "var(--highlight-primary)",
                        fontSize: "16px",
                        fontWeight: "bold",
                        cursor: "pointer",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        transition: "all 0.15s"
                    },
                    listeners: [{
                        type: "click",
                        listener: async (e: Event) => {
                            e.stopPropagation();
                            // Add tag to state
                            stateManager.addSelection('tags', { id: t.tag, type: 'tag', title: t.tag });

                            // Add items with this tag
                            const filterVal = filterSelect.value;
                            let libId: number | null = null;
                            let colId: number | null = null;
                            if (filterVal.startsWith("lib_")) libId = parseInt(filterVal.replace("lib_", ""));
                            if (filterVal.startsWith("col_")) colId = parseInt(filterVal.replace("col_", ""));

                            await this.addItemsByTags([t.tag], colId, libId);
                            this.reRenderSelectionArea();

                            // Feedback
                            row.style.backgroundColor = "var(--background-hover)";
                            addBtn.replaceWith(ztoolkit.UI.createElement(doc, "span", {
                                properties: { innerText: "✓" },
                                styles: { fontSize: "14px", color: "green", fontWeight: "bold" }
                            }));
                        }
                    }]
                });
                addBtn.addEventListener("mouseenter", () => {
                    addBtn.style.backgroundColor = "var(--highlight-primary)";
                    addBtn.style.color = "var(--highlight-text)";
                });
                addBtn.addEventListener("mouseleave", () => {
                    addBtn.style.backgroundColor = "transparent";
                    addBtn.style.color = "var(--highlight-primary)";
                });

                row.appendChild(addBtn);
                listContainer.appendChild(row);
            });
        };

        const loadTags = async () => {
            // ... Fetch tags logic ...
            listContainer.innerHTML = "";
            listContainer.appendChild(ztoolkit.UI.createElement(doc, "div", { properties: { innerText: "Loading tags..." }, styles: { padding: "20px", textAlign: "center", color: "var(--text-secondary)", fontSize: "12px" } }));

            const filterValue = filterSelect.value;
            try {
                let tags: { tag: string }[] = [];
                if (filterValue === "all") {
                    const libraries = Zotero.Libraries.getAll();
                    for (const lib of libraries) {
                        const libTags = await Zotero.Tags.getAll(lib.libraryID);
                        tags.push(...libTags.map((t: any) => ({ tag: t.tag })));
                    }
                } else if (filterValue.startsWith("lib_")) {
                    const libId = parseInt(filterValue.replace("lib_", ""), 10);
                    const libTags = await Zotero.Tags.getAll(libId);
                    tags = libTags.map((t: any) => ({ tag: t.tag }));
                } else if (filterValue.startsWith("col_")) {
                    const colId = parseInt(filterValue.replace("col_", ""), 10);
                    const col = Zotero.Collections.get(colId);
                    if (col) {
                        const itemIDs = col.getChildItems(true);
                        const tagSet = new Set<string>();
                        for (const id of itemIDs) {
                            const it = Zotero.Items.get(id);
                            if (it && it.isRegularItem()) {
                                it.getTags().forEach((t: any) => tagSet.add(t.tag));
                            }
                        }
                        tags = Array.from(tagSet).map(t => ({ tag: t }));
                    }
                }
                // Deduplicate
                const uniqueTags = new Map();
                tags.forEach(t => uniqueTags.set(t.tag, t));
                allTags = Array.from(uniqueTags.values()).sort((a, b) => a.tag.localeCompare(b.tag));

                renderTags();
            } catch (e) {
                Zotero.debug(`Error loading tags: ${e}`);
                listContainer.innerText = "Error loading tags.";
            }
        };

        filterSelect.addEventListener("change", loadTags);
        searchInput.addEventListener("input", renderTags);

        selectionArea.parentNode.insertBefore(dropdown, selectionArea.nextSibling);

        // Init
        // Auto focus
        setTimeout(() => searchInput.focus(), 100);
        setTimeout(() => { dropdown.style.opacity = "1"; dropdown.style.transform = "translateY(0)"; }, 10);
        loadTags();
    }

    /**
     * Show paper picker as a beautiful inline dropdown panel for Chat
     */
    private static async showPaperPicker(doc: Document, stateManager: ReturnType<typeof getChatStateManager>): Promise<void> {
        // Toggle existing dropdown
        const existing = doc.getElementById("chat-paper-picker-dropdown") as HTMLElement;
        if (existing) {
            existing.style.opacity = "0";
            existing.style.transform = "translateY(-10px)";
            setTimeout(() => existing.remove(), 200);
            return;
        }

        const selectionArea = doc.getElementById("selection-area");
        if (!selectionArea || !selectionArea.parentNode) return;

        // Create dropdown panel
        const dropdown = ztoolkit.UI.createElement(doc, "div", {
            properties: { id: "chat-paper-picker-dropdown" },
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
                marginTop: "8px",
                marginLeft: "8px",
                marginRight: "8px"
            }
        });

        // Header
        const header = ztoolkit.UI.createElement(doc, "div", {
            styles: {
                background: "linear-gradient(135deg, var(--highlight-primary) 0%, color-mix(in srgb, var(--highlight-primary) 80%, purple) 100%)",
                padding: "10px 14px",
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                gap: "12px"
            }
        });

        const headerTitle = ztoolkit.UI.createElement(doc, "div", {
            properties: { innerText: "📚 Add Papers to Chat" },
            styles: {
                fontSize: "13px",
                fontWeight: "600",
                color: "var(--highlight-text)",
                textShadow: "0 1px 2px rgba(0,0,0,0.1)"
            }
        });
        header.appendChild(headerTitle);

        const closeBtn = ztoolkit.UI.createElement(doc, "button", {
            properties: { innerText: "✕" },
            styles: {
                background: "rgba(0,0,0,0.1)",
                border: "none",
                borderRadius: "50%",
                width: "22px",
                height: "22px",
                cursor: "pointer",
                color: "var(--highlight-text)",
                fontSize: "11px",
                display: "flex",
                alignItems: "center",
                justifyContent: "center"
            },
            listeners: [{
                type: "click",
                listener: () => {
                    dropdown.style.opacity = "0";
                    dropdown.style.transform = "translateY(-10px)";
                    setTimeout(() => dropdown.remove(), 200);
                }
            }]
        });
        header.appendChild(closeBtn);
        dropdown.appendChild(header);

        // Content
        const content = ztoolkit.UI.createElement(doc, "div", {
            styles: { padding: "10px 14px", display: "flex", flexDirection: "column", gap: "8px" }
        });

        // Controls
        const controlsRow = ztoolkit.UI.createElement(doc, "div", {
            styles: { display: "flex", gap: "6px", alignItems: "center" }
        });

        // Filter Select
        const filterSelect = ztoolkit.UI.createElement(doc, "select", {
            styles: {
                flex: "0 0 auto",
                minWidth: "120px",
                padding: "6px 10px",
                border: "1px solid var(--border-primary)",
                borderRadius: "6px",
                fontSize: "12px",
                backgroundColor: "var(--background-secondary)",
                color: "var(--text-primary)",
                cursor: "pointer",
                outline: "none"
            }
        }) as HTMLSelectElement;
        this.populateFilterSelect(filterSelect);
        controlsRow.appendChild(filterSelect);

        // Search Input
        const searchInput = ztoolkit.UI.createElement(doc, "input", {
            attributes: { type: "text", placeholder: "🔍 Search papers..." },
            styles: {
                flex: "1",
                padding: "6px 10px",
                border: "1px solid var(--border-primary)",
                borderRadius: "6px",
                fontSize: "12px",
                backgroundColor: "var(--background-secondary)",
                color: "var(--text-primary)",
                outline: "none"
            }
        }) as HTMLInputElement;
        controlsRow.appendChild(searchInput);
        content.appendChild(controlsRow);

        // List Container
        const listContainer = ztoolkit.UI.createElement(doc, "div", {
            styles: {
                maxHeight: "240px",
                overflowY: "auto",
                border: "1px solid var(--border-primary)",
                borderRadius: "6px",
                backgroundColor: "var(--background-secondary)"
            }
        });
        content.appendChild(listContainer);

        // State
        let allFilteredItems: Zotero.Item[] = [];
        let displayedCount = 0;
        const BATCH_SIZE = 50;

        const renderPaperBatch = (items: Zotero.Item[], startIndex: number, count: number) => {
            const endIndex = Math.min(startIndex + count, items.length);
            for (let i = startIndex; i < endIndex; i++) {
                const paperItem = items[i];
                const paperTitle = (paperItem.getField('title') as string) || 'Untitled';
                const creators = paperItem.getCreators();
                const authorStr = creators.length > 0 ? creators.map(c => c.lastName).join(', ') : 'Unknown';
                const year = paperItem.getField('year') || '';

                const row = ztoolkit.UI.createElement(doc, "div", {
                    styles: {
                        padding: "8px 10px",
                        borderBottom: "1px solid var(--border-primary)",
                        cursor: "pointer",
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        transition: "background-color 0.1s"
                    }
                });
                row.addEventListener("mouseenter", () => { row.style.backgroundColor = "var(--background-primary)"; });
                row.addEventListener("mouseleave", () => { row.style.backgroundColor = ""; });

                const info = ztoolkit.UI.createElement(doc, "div", {
                    styles: { flex: "1", overflow: "hidden", marginRight: "10px" }
                });

                const titleEl = ztoolkit.UI.createElement(doc, "div", {
                    properties: { innerText: paperTitle },
                    styles: {
                        fontSize: "12px",
                        fontWeight: "500",
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        color: "var(--text-primary)"
                    }
                });

                const metaEl = ztoolkit.UI.createElement(doc, "div", {
                    properties: { innerText: `${authorStr}${year ? ` • ${year}` : ''}` },
                    styles: { fontSize: "11px", color: "var(--text-secondary)", marginTop: "1px" }
                });
                info.appendChild(titleEl);
                info.appendChild(metaEl);
                row.appendChild(info);

                // Check if already added
                const isAdded = stateManager.getStates().items.some(it => it.id === paperItem.id);

                if (isAdded) {
                    const addedLabel = ztoolkit.UI.createElement(doc, "span", {
                        properties: { innerText: "Added" },
                        styles: { fontSize: "10px", color: "var(--text-secondary)", fontStyle: "italic" }
                    });
                    row.appendChild(addedLabel);
                } else {
                    const addBtn = ztoolkit.UI.createElement(doc, "button", {
                        properties: { innerText: "+" },
                        styles: {
                            width: "24px",
                            height: "24px",
                            borderRadius: "50%",
                            border: "1px solid var(--highlight-primary)",
                            backgroundColor: "transparent",
                            color: "var(--highlight-primary)",
                            fontSize: "16px",
                            fontWeight: "bold",
                            cursor: "pointer",
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            transition: "all 0.15s"
                        },
                        listeners: [{
                            type: "click",
                            listener: async (e: Event) => {
                                e.stopPropagation();
                                await this.addItemWithNotes(paperItem);
                                // Animate removal or change to added
                                row.style.backgroundColor = "var(--background-hover)";
                                addBtn.replaceWith(ztoolkit.UI.createElement(doc, "span", {
                                    properties: { innerText: "✓" },
                                    styles: { fontSize: "14px", color: "green", fontWeight: "bold" }
                                }));
                                setTimeout(() => {
                                    row.style.opacity = "0.5";
                                }, 200);
                            }
                        }]
                    });
                    addBtn.addEventListener("mouseenter", () => {
                        addBtn.style.backgroundColor = "var(--highlight-primary)";
                        addBtn.style.color = "var(--highlight-text)";
                    });
                    addBtn.addEventListener("mouseleave", () => {
                        addBtn.style.backgroundColor = "transparent";
                        addBtn.style.color = "var(--highlight-primary)";
                    });
                    row.appendChild(addBtn);
                }
                listContainer.appendChild(row);
            }
            displayedCount = endIndex;
        };

        const loadMorePapers = () => {
            renderPaperBatch(allFilteredItems, displayedCount, BATCH_SIZE);
        };

        listContainer.addEventListener("scroll", () => {
            const { scrollTop, scrollHeight, clientHeight } = listContainer;
            if (scrollHeight - scrollTop - clientHeight < 50) {
                loadMorePapers();
            }
        });

        const loadPapers = async () => {
            listContainer.innerHTML = "";
            const loading = ztoolkit.UI.createElement(doc, "div", { properties: { innerText: "Loading..." }, styles: { padding: "20px", textAlign: "center", color: "var(--text-secondary)", fontSize: "12px" } });
            listContainer.appendChild(loading);

            allFilteredItems = [];
            displayedCount = 0;
            const filterValue = filterSelect.value;
            const searchQuery = searchInput.value.toLowerCase();

            try {
                let items: Zotero.Item[] = [];
                if (filterValue === "all") {
                    const libraries = Zotero.Libraries.getAll();
                    for (const lib of libraries) {
                        const libItems = await Zotero.Items.getAll(lib.libraryID);
                        items.push(...libItems.filter((i: Zotero.Item) => i.isRegularItem()));
                    }
                } else if (filterValue.startsWith("lib_")) {
                    const libraryId = parseInt(filterValue.replace("lib_", ""), 10);
                    items = await Zotero.Items.getAll(libraryId);
                    items = items.filter(i => i.isRegularItem());
                } else if (filterValue.startsWith("col_")) {
                    const collectionId = parseInt(filterValue.replace("col_", ""), 10);
                    const collection = Zotero.Collections.get(collectionId);
                    if (collection) {
                        const itemIDs = collection.getChildItems(true);
                        for (const id of itemIDs) {
                            const item = Zotero.Items.get(id);
                            if (item && item.isRegularItem()) items.push(item);
                        }
                    }
                }

                allFilteredItems = items.filter(i => {
                    const title = (i.getField('title') as string || '').toLowerCase();
                    const creators = i.getCreators().map((c: any) => (c.lastName || c.name || '').toLowerCase()).join(' ');
                    return title.includes(searchQuery) || creators.includes(searchQuery);
                });

                listContainer.innerHTML = "";
                if (allFilteredItems.length === 0) {
                    listContainer.appendChild(ztoolkit.UI.createElement(doc, "div", { properties: { innerText: "No papers found." }, styles: { padding: "20px", textAlign: "center", color: "var(--text-secondary)", fontSize: "12px" } }));
                } else {
                    renderPaperBatch(allFilteredItems, 0, BATCH_SIZE);
                }

            } catch (e) {
                listContainer.innerHTML = "";
                listContainer.appendChild(ztoolkit.UI.createElement(doc, "div", { properties: { innerText: "Error loading papers." }, styles: { color: "red", padding: "10px" } }));
                Zotero.debug(`[Seer AI] Error loading papers: ${e}`);
            }
        };

        filterSelect.addEventListener("change", loadPapers);
        searchInput.addEventListener("input", () => {
            clearTimeout((searchInput as any)._debounce);
            (searchInput as any)._debounce = setTimeout(loadPapers, 300);
        });

        dropdown.appendChild(content);

        // Done button logic (optional, users can just close)
        const buttonRow = ztoolkit.UI.createElement(doc, "div", {
            styles: { padding: "8px 14px", borderTop: "1px solid var(--border-primary)", display: "flex", justifyContent: "flex-end" }
        });
        const doneBtn = ztoolkit.UI.createElement(doc, "button", {
            properties: { innerText: "Done" },
            styles: {
                padding: "6px 14px",
                border: "1px solid var(--border-primary)",
                borderRadius: "6px",
                fontSize: "12px",
                backgroundColor: "var(--background-secondary)",
                cursor: "pointer"
            },
            listeners: [{
                type: "click",
                listener: () => {
                    dropdown.style.opacity = "0";
                    setTimeout(() => dropdown.remove(), 200);
                }
            }]
        });
        buttonRow.appendChild(doneBtn);
        dropdown.appendChild(buttonRow);

        selectionArea.parentNode.insertBefore(dropdown, selectionArea.nextSibling);

        // Auto focus
        setTimeout(() => searchInput.focus(), 100);
        setTimeout(() => { dropdown.style.opacity = "1"; dropdown.style.transform = "translateY(0)"; }, 10);

        loadPapers();
    }
    // Remove existing picker if any

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
            // Build context from all selected items, notes, and tables
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

            // Include table context
            if (states.tables.length > 0) {
                context += "\n\n=== Table Data ===";
                for (const table of states.tables) {
                    context += `\n\n--- Table: ${table.title} (${table.rowCount} rows) ---`;
                    context += `\nColumns: ${table.columnNames.join(', ')}`;
                    context += `\n${table.content}`;
                }
            }

            const systemPrompt = `You are a helpful research assistant for Zotero. You help users understand and analyze their academic papers, notes, and research data tables.

${context}

Be concise, accurate, and helpful. When referencing papers, cite them by title or author. When referencing table data, cite the table name and relevant columns.`;

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
            // Build context from selected items, notes, and tables
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

            // Include table context
            if (states.tables.length > 0) {
                context += "\n\n=== Table Data ===";
                for (const table of states.tables) {
                    context += `\n\n--- Table: ${table.title} (${table.rowCount} rows) ---`;
                    context += `\nColumns: ${table.columnNames.join(', ')}`;
                    context += `\n${table.content}`;
                }
            }

            const systemPrompt = `You are a helpful research assistant for Zotero. You help users understand and analyze their academic papers, notes, and research data tables.

${context}

Be concise, accurate, and helpful. When referencing papers, cite them by title or author. When referencing table data, cite the table name and relevant columns.`;

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
                boxShadow: "0 1px 3px rgba(0,0,0,0.12)",
                position: "relative",
                backgroundColor: isUser ? "#1976d2" : "#f5f5f5",
                color: isUser ? "#ffffff" : "#212121",
                border: isUser ? "none" : "1px solid #e0e0e0"
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
     * Uses ztoolkit.Clipboard for Zotero compatibility
     */
    private static copyToClipboard(text: string, buttonElement: HTMLElement) {
        const originalText = buttonElement.innerText;

        try {
            // Use ztoolkit.Clipboard which works in Zotero's environment
            new ztoolkit.Clipboard()
                .addText(text, "text/unicode")
                .copy();

            // Visual feedback - success
            buttonElement.innerText = "✓";
            setTimeout(() => {
                buttonElement.innerText = originalText;
            }, 1500);

            Zotero.debug("[Seer AI] Copied message to clipboard");
        } catch (e) {
            Zotero.debug(`[Seer AI] ztoolkit.Clipboard failed: ${e}`);
            // Visual feedback - failure
            buttonElement.innerText = "❌";
            setTimeout(() => {
                buttonElement.innerText = originalText;
            }, 1500);
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

            // Include table context
            if (states.tables.length > 0) {
                context += "\n\n=== Table Data ===";
                for (const table of states.tables) {
                    context += `\n\n--- Table: ${table.title} (${table.rowCount} rows) ---`;
                    context += `\nColumns: ${table.columnNames.join(', ')}`;
                    context += `\n${table.content}`;
                }
            }

            const systemPrompt = `You are a helpful research assistant for Zotero. You help users understand and analyze their academic papers, notes, and research data tables.

${context}

Be concise, accurate, and helpful. When referencing papers, cite them by title or author. When referencing table data, cite the table name and relevant columns.`;

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
