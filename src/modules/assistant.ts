import {
  openAIService,
  OpenAIMessage,
  VisionMessage,
  VisionMessageContentPart,
  ToolCall,
} from "./openai";
import { config } from "../../package.json";
import {
  getChatStateManager,
  resetChatStateManager,
} from "./chat/stateManager";
import {
  SelectedItem,
  SelectedNote,
  SelectedTable,
  ChatMessage,
  selectionConfigs,
  AIModelConfig,
  ConversationMetadata,
} from "./chat/types";
import {
  getModelConfigs,
  getActiveModelConfig,
  setActiveModelId,
  hasModelConfigs,
} from "./chat/modelConfig";
import { parseMarkdown } from "./chat/markdown";
import { getMessageStore } from "./chat/messageStore";
import {
  createImageContentParts,
  countImageAttachments,
} from "./chat/imageUtils";
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
  SearchAnalysisColumn,
  SearchColumnConfig,
  defaultSearchColumnConfig,
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
import { firecrawlService, PdfDiscoveryResult } from "./firecrawl";
import { getTheme } from "../utils/theme";
// Prompt Library & Placeholder System imports
import { PromptTemplate, loadPrompts } from "./chat/promptLibrary";
import { showPromptPicker } from "./chat/ui/promptPicker";
import {
  initPlaceholderAutocomplete,
  createPlaceholderMenuButton,
  hideDropdown,
  triggerNextPlaceholder,
  isDropdownOpen,
} from "./chat/ui/placeholderDropdown";
import { showChatSettings } from "./chat/ui/chatSettings";
import { ChatContextManager } from "./chat/context/contextManager";
import { createContextChipsArea } from "./chat/context/contextUI";
import { ContextItem, ContextItemType } from "./chat/context/contextTypes";
import { handleAgenticChat, isAgenticModeEnabled, AgentUIObserver, createToolExecutionUI, createToolProcessUI } from "./chat/agenticChat";
import { ToolResult } from "./chat/tools/toolTypes";


// Debounce timer for autocomplete
let autocompleteTimeout: ReturnType<typeof setTimeout> | null = null;

// Stored messages for conversation continuity (loaded from persistence)
let conversationMessages: ChatMessage[] = [];

// Track the current item ID to detect navigation
let currentItemId: number | null = null;
// Track last interacted row for range selection
let lastInteractedRowId: number | null = null;

// Store container reference for re-rendering
let currentContainer: HTMLElement | null = null;
let currentItem: Zotero.Item | null = null;

// Active tab state
let activeTab: AssistantTab = "chat";
// Table state cache
let currentTableConfig: TableConfig | null = null;
let currentTableData: TableData | null = null;

// Search state
let currentSearchState: SearchState = { ...defaultSearchState };
let currentSearchResults: SemanticScholarPaper[] = [];
let currentSearchToken: string | null = null; // For pagination

/**
 * Persistable state for an active agent operation
 */
interface AgentSession {
  text: string;
  fullResponse: string;
  toolResults: { toolCall: ToolCall; result?: ToolResult; uiElement?: HTMLElement }[];
  isThinking: boolean;
  messagesArea: HTMLElement | null;
  contentDiv: HTMLElement | null;
  toolContainer: HTMLElement | null; // Keeps track of the tool list container for direct access
  toolProcessState?: {
    container: HTMLElement;
    setThinking: () => void;
    setCompleted: (count: number) => void;
    setFailed: (error: string) => void;
  };
}

let activeAgentSession: AgentSession | null = null;
let currentDraftText = "";
let currentPastedImages: { id: string; image: string; mimeType: string }[] = [];
let totalSearchResults: number = 0; // Total count from API
let isSearching = false;

// Cache for Unpaywall PDF URLs (paperId -> pdfUrl)
const unpaywallPdfCache = new Map<string, string>();

// Cache for Firecrawl PDF discovery results (paperId -> result)
const firecrawlPdfCache = new Map<string, PdfDiscoveryResult>();

// Cache for Zotero Find Full Text results (cacheKey -> pdfPath or null)
const zoteroFindPdfCache: Map<string, string | null> = new Map();

// Search analysis column configuration (persisted)
let searchColumnConfig: SearchColumnConfig = { ...defaultSearchColumnConfig };
let searchColumnConfigFilePath: string | null = null;

// Chat History State
let conversationHistory: ConversationMetadata[] = [];
let isHistorySidebarVisible: boolean = true;

/**
 * Use Zotero's Find Full Text resolver to fetch PDF for a paper.
 * Creates a temporary item, calls addAvailablePDF, extracts PDF path, then deletes the temp item.
 * Returns PDF URL/path if found, null otherwise.
 */
async function findPdfViaZotero(
  doi?: string,
  arxivId?: string,
  pmid?: string,
  title?: string,
  url?: string,
): Promise<string | null> {
  const cacheKey = doi || arxivId || pmid || title?.slice(0, 50) || "";
  if (!cacheKey) return null;

  if (zoteroFindPdfCache.has(cacheKey)) {
    return zoteroFindPdfCache.get(cacheKey) || null;
  }

  let tempItem: Zotero.Item | null = null;

  try {
    // Create temporary item with minimal metadata for resolver lookup
    tempItem = new Zotero.Item("journalArticle");
    tempItem.libraryID = Zotero.Libraries.userLibraryID;
    if (title) tempItem.setField("title", title);
    if (doi) tempItem.setField("DOI", doi);
    if (url) tempItem.setField("url", url);
    await tempItem.saveTx();

    Zotero.debug(
      `[seerai] Zotero Find Full Text: Created temp item ${tempItem.id}`,
    );

    // Call Zotero's Find Full Text resolver
    const attachment = await (Zotero.Attachments as any).addAvailablePDF(
      tempItem,
    );

    let pdfPath: string | null = null;
    if (attachment && attachment.id) {
      pdfPath = await attachment.getFilePathAsync();
      Zotero.debug(`[seerai] Zotero Find Full Text: Found PDF at ${pdfPath}`);
    }

    zoteroFindPdfCache.set(cacheKey, pdfPath);
    return pdfPath;
  } catch (error) {
    Zotero.debug(`[seerai] Zotero Find Full Text error: ${error}`);
    zoteroFindPdfCache.set(cacheKey, null);
    return null;
  } finally {
    // Always delete temporary item
    if (tempItem) {
      try {
        await tempItem.eraseTx();
        Zotero.debug(`[seerai] Zotero Find Full Text: Deleted temp item`);
      } catch (e) {
        Zotero.debug(`[seerai] Error deleting temp item: ${e}`);
      }
    }
  }
}

/**
 * Find PDF via arXiv - direct URL pattern for arXiv papers
 * ArXiv PDFs are always at https://arxiv.org/pdf/{id}.pdf
 */
async function findPdfViaArxiv(arxivId?: string): Promise<string | null> {
  if (!arxivId) return null;

  // Normalize arXiv ID (remove version suffix if present for URL, keep for specificity)
  const normalizedId = arxivId.replace(/^arxiv:/i, "");
  const pdfUrl = `https://arxiv.org/pdf/${normalizedId}.pdf`;

  try {
    Zotero.debug(`[seerai] arXiv: Checking ${pdfUrl}`);
    const response = await Zotero.HTTP.request("HEAD", pdfUrl, {
      timeout: 5000,
    });
    if (response.status === 200) {
      Zotero.debug(`[seerai] arXiv: Found PDF at ${pdfUrl}`);
      return pdfUrl;
    }
  } catch (error) {
    Zotero.debug(`[seerai] arXiv: Request failed: ${error}`);
  }
  return null;
}

/**
 * Find PDF via PubMed Central using PMID
 * First converts PMID to PMCID, then constructs PDF URL
 */
async function findPdfViaPmc(pmid?: string): Promise<string | null> {
  if (!pmid) return null;

  try {
    // Use NCBI ELink to convert PMID to PMCID
    const idUrl = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/elink.fcgi?dbfrom=pubmed&db=pmc&id=${pmid}&retmode=json`;
    Zotero.debug(`[seerai] PMC: Looking up PMCID for PMID ${pmid}`);

    const resp = await Zotero.HTTP.request("GET", idUrl, {
      responseType: "json",
      timeout: 10000,
    });

    const data = resp.response as any;
    const linksets = data?.linksets?.[0]?.linksetdbs;
    const pmcLink = linksets?.find((l: any) => l.dbto === "pmc");

    if (pmcLink?.links?.[0]) {
      const pmcid = pmcLink.links[0];
      const pdfUrl = `https://www.ncbi.nlm.nih.gov/pmc/articles/PMC${pmcid}/pdf/`;
      Zotero.debug(`[seerai] PMC: Found PMCID ${pmcid}, PDF at ${pdfUrl}`);
      return pdfUrl;
    }
    Zotero.debug(`[seerai] PMC: No PMCID found for PMID ${pmid}`);
  } catch (error) {
    Zotero.debug(`[seerai] PMC: Request failed: ${error}`);
  }
  return null;
}

/**
 * Find PDF via bioRxiv/medRxiv for preprints
 * Only works for DOIs starting with 10.1101/
 */
async function findPdfViaBiorxiv(doi?: string): Promise<string | null> {
  if (!doi || !doi.startsWith("10.1101/")) return null;

  // Try bioRxiv first
  const biorxivUrl = `https://www.biorxiv.org/content/${doi}v1.full.pdf`;
  try {
    Zotero.debug(`[seerai] bioRxiv: Checking ${biorxivUrl}`);
    const response = await Zotero.HTTP.request("HEAD", biorxivUrl, {
      timeout: 5000,
    });
    if (response.status === 200) {
      Zotero.debug(`[seerai] bioRxiv: Found PDF`);
      return biorxivUrl;
    }
  } catch {
    /* try medRxiv */
  }

  // Try medRxiv
  const medrxivUrl = `https://www.medrxiv.org/content/${doi}v1.full.pdf`;
  try {
    Zotero.debug(`[seerai] medRxiv: Checking ${medrxivUrl}`);
    const response = await Zotero.HTTP.request("HEAD", medrxivUrl, {
      timeout: 5000,
    });
    if (response.status === 200) {
      Zotero.debug(`[seerai] medRxiv: Found PDF`);
      return medrxivUrl;
    }
  } catch (error) {
    Zotero.debug(`[seerai] bioRxiv/medRxiv: Request failed: ${error}`);
  }
  return null;
}

/**
 * Find PDF via Europe PMC - alternative OA source
 * Searches by DOI or PMID and returns PDF link if available
 */
async function findPdfViaEuropePmc(
  doi?: string,
  pmid?: string,
): Promise<string | null> {
  const query = doi ? `DOI:${doi}` : pmid ? `EXT_ID:${pmid}` : null;
  if (!query) return null;

  try {
    const url = `https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=${encodeURIComponent(query)}&format=json`;
    Zotero.debug(`[seerai] EuropePMC: Searching with query ${query}`);

    const resp = await Zotero.HTTP.request("GET", url, {
      responseType: "json",
      timeout: 10000,
    });

    const data = resp.response as any;
    const result = data?.resultList?.result?.[0];

    if (result?.pmcid) {
      const pdfUrl = `https://europepmc.org/backend/ptpmcrender.fcgi?accid=${result.pmcid}&blobtype=pdf`;
      Zotero.debug(`[seerai] EuropePMC: Found PMCID ${result.pmcid}`);
      return pdfUrl;
    }
    Zotero.debug(`[seerai] EuropePMC: No PMCID found`);
  } catch (error) {
    Zotero.debug(`[seerai] EuropePMC: Request failed: ${error}`);
  }
  return null;
}

/**
 * Download PDF from URL and attach to a Zotero item
 */
async function downloadAndAttachPdf(
  item: Zotero.Item,
  pdfUrl: string,
): Promise<boolean> {
  try {
    Zotero.debug(`[seerai] Downloading PDF from: ${pdfUrl}`);
    const attachment = await Zotero.Attachments.importFromURL({
      url: pdfUrl,
      parentItemID: item.id,
      title: `${item.getField("title")}.pdf`,
      contentType: "application/pdf",
    });

    if (attachment) {
      Zotero.debug(`[seerai] PDF attached successfully: ${attachment.id}`);
      return true;
    } else {
      Zotero.debug(
        `[seerai] PDF attachment failed: check Zotero logs for network/permission issues`,
      );
      return false;
    }
  } catch (error) {
    Zotero.debug(`[seerai] PDF download/attach failed for ${pdfUrl}: ${error}`);
    return false;
  }
}

/**
 * Extract PMID from Zotero item's Extra field
 * Looks for patterns like "PMID: 12345678" or "pmid: 12345678"
 */
function extractPmidFromItem(item: Zotero.Item): string | undefined {
  const extra = (item.getField("extra") as string) || "";
  const match = extra.match(/pmid:\s*(\d+)/i);
  return match ? match[1] : undefined;
}

/**
 * Extract ArXiv ID from Zotero item's Extra field
 * Looks for patterns like "arXiv: 2301.12345" or "arxiv:2301.12345v1"
 */
function extractArxivFromItem(item: Zotero.Item): string | undefined {
  const extra = (item.getField("extra") as string) || "";
  const match = extra.match(/arxiv:\s*([\d.]+(?:v\d+)?)/i);
  return match ? match[1] : undefined;
}

/**
 * Run 6-step PDF discovery for a Zotero item and attach if found
 * Returns true if PDF was successfully found and attached
 */
export async function findAndAttachPdfForItem(
  item: Zotero.Item,
  onProgress?: (step: string) => void,
): Promise<boolean> {
  let doi = (item.getField("DOI") as string) || undefined;
  let pmid = extractPmidFromItem(item);
  let arxivId = extractArxivFromItem(item);
  const title = (item.getField("title") as string) || undefined;
  const url = (item.getField("url") as string) || undefined;

  Zotero.debug(
    `[seerai] findAndAttachPdfForItem: DOI=${doi}, PMID=${pmid}, ArXiv=${arxivId}`,
  );

  // Step 1: Semantic Scholar Open Access (OA) Check
  const ssId = doi
    ? `DOI:${doi}`
    : pmid
      ? `PMID:${pmid}`
      : arxivId
        ? `ARXIV:${arxivId}`
        : null;
  if (ssId) {
    onProgress?.("📖 Checking SS OA...");
    try {
      const paper = await semanticScholarService.getPaper(ssId);
      if (paper?.openAccessPdf?.url) {
        onProgress?.("📥 Attaching SS PDF...");
        if (await downloadAndAttachPdf(item, paper.openAccessPdf.url)) {
          return true;
        }
      }
    } catch (e) {
      Zotero.debug(`[seerai] SS OA lookup failed for ${ssId}: ${e}`);
    }
  }

  // Step 1b: SS Title Fallback (if title exists and no ID-based success)
  if (title) {
    onProgress?.("🔍 SS Title search...");
    try {
      const results = await semanticScholarService.searchPapers({
        query: title,
        limit: 5,
      });
      if (results && results.data.length > 0) {
        const lowerTitle = title.toLowerCase().trim();
        for (const paper of results.data) {
          if (
            paper.title.toLowerCase().trim() === lowerTitle ||
            paper.title.toLowerCase().includes(lowerTitle) ||
            lowerTitle.includes(paper.title.toLowerCase())
          ) {
            // Extract identifiers from SS result to enable subsequent discovery steps
            const discoveredDoi = paper.externalIds?.DOI;
            const discoveredPmid = paper.externalIds?.PMID;
            const discoveredArxivId = paper.externalIds?.ArXiv;

            let metadataUpdated = false;
            if (discoveredDoi && !doi) {
              doi = discoveredDoi;
              item.setField("DOI", discoveredDoi);
              metadataUpdated = true;
            }
            if (discoveredPmid && !pmid) {
              pmid = discoveredPmid;
              const currentExtra = (item.getField("extra") as string) || "";
              if (!currentExtra.includes("PMID:")) {
                item.setField(
                  "extra",
                  currentExtra +
                  (currentExtra ? "\n" : "") +
                  `PMID: ${discoveredPmid}`,
                );
                metadataUpdated = true;
              }
            }
            if (discoveredArxivId && !arxivId) {
              arxivId = discoveredArxivId;
              const currentExtra = (item.getField("extra") as string) || "";
              if (!currentExtra.includes("arXiv:")) {
                item.setField(
                  "extra",
                  currentExtra +
                  (currentExtra ? "\n" : "") +
                  `arXiv: ${discoveredArxivId}`,
                );
                metadataUpdated = true;
              }
            }

            if (metadataUpdated) {
              await item.saveTx();
              Zotero.debug(
                `[seerai] Updated item metadata from SS title match: DOI=${doi}, PMID=${pmid}, ArXiv=${arxivId}`,
              );
            }

            if (paper.openAccessPdf?.url) {
              onProgress?.("📥 Attaching SS PDF (Title)...");
              if (await downloadAndAttachPdf(item, paper.openAccessPdf.url)) {
                return true;
              }
            }

            // Found a match, so we stop searching results even if PDF attach failed.
            // The updated IDs will be used in subsequent steps (arXiv, Unpaywall, etc.)
            break;
          }
        }
      }
    } catch (e) {
      Zotero.debug(`[seerai] SS Title search failed: ${e}`);
    }
  }

  // Step 2: Zotero resolver
  onProgress?.("📚 Zotero...");
  const zoteroResult = await findPdfViaZotero(doi, arxivId, pmid, title, url);
  if (zoteroResult) {
    // Zotero already attached the PDF via temp item, need to re-run with real item
    try {
      const attachment = await (Zotero.Attachments as any).addAvailablePDF(
        item,
      );
      if (attachment) return true;
    } catch {
      /* continue to other methods */
    }
  }

  // Step 3: arXiv
  if (arxivId) {
    onProgress?.("📄 arXiv...");
    const arxivResult = await findPdfViaArxiv(arxivId);
    if (arxivResult && (await downloadAndAttachPdf(item, arxivResult))) {
      return true;
    }
  }

  // Step 4: PubMed Central
  if (pmid) {
    onProgress?.("🏥 PMC...");
    const pmcResult = await findPdfViaPmc(pmid);
    if (pmcResult && (await downloadAndAttachPdf(item, pmcResult))) {
      return true;
    }
  }

  // Step 5: bioRxiv/medRxiv
  if (doi?.startsWith("10.1101/")) {
    onProgress?.("🧬 bioRxiv...");
    const biorxivResult = await findPdfViaBiorxiv(doi);
    if (biorxivResult && (await downloadAndAttachPdf(item, biorxivResult))) {
      return true;
    }
  }

  // Step 6: Unpaywall
  if (doi) {
    onProgress?.("🔍 Unpaywall...");
    const unpaywallResult = await unpaywallService.getPdfUrl(doi);
    if (
      unpaywallResult &&
      (await downloadAndAttachPdf(item, unpaywallResult))
    ) {
      return true;
    }
  }

  // Step 7: Europe PMC
  onProgress?.("🇪🇺 EuropePMC...");
  const epmcResult = await findPdfViaEuropePmc(doi, pmid);
  if (epmcResult && (await downloadAndAttachPdf(item, epmcResult))) {
    return true;
  }

  // Step 8: Source Link
  const sourceLink = getSourceLinkForPaper(doi, arxivId, pmid, undefined, url);
  if (sourceLink) {
    onProgress?.("🔗 Source Link...");
    if (await downloadAndAttachPdf(item, sourceLink)) {
      return true;
    }
  }

  // Step 9: Firecrawl (if configured)
  if (firecrawlService.isConfigured() && title) {
    onProgress?.("🔥 Firecrawl...");
    try {
      const creators = item.getCreators();
      const authors = creators.map((c) =>
        `${c.firstName || ""} ${c.lastName || ""}`.trim(),
      );
      const pdfResult = await firecrawlService.researchSearch(
        title,
        authors,
        doi,
      );
      if (
        pdfResult &&
        (pdfResult.status === "pdf_found" || pdfResult.status === "page_found")
      ) {
        const foundUrl = pdfResult.pdfUrl || pdfResult.pageUrl;
        if (foundUrl && (await downloadAndAttachPdf(item, foundUrl))) {
          return true;
        }
      }
    } catch (e) {
      Zotero.debug(`[seerai] Firecrawl search failed: ${e}`);
    }
  }

  return false;
}

/**
 * Get the canonical source URL for a paper based on available identifiers
 * Priority: DOI > ArXiv > PMC > PMID > URL field
 */
function getSourceLinkForPaper(
  doi?: string,
  arxivId?: string,
  pmid?: string,
  pmcid?: string,
  url?: string,
): string | null {
  if (doi) return `https://doi.org/${doi}`;
  if (arxivId) return `https://arxiv.org/${arxivId.replace(/^arxiv:/i, "")}`;
  if (pmcid) return `https://pmc.ncbi.nlm.nih.gov/articles/${pmcid}/`;
  if (pmid) return `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`;
  if (url) return url;
  return null;
}

/**
 * Get PDF text for a Zotero item, auto-indexing if needed.
 * Uses Zotero 7 APIs: item.attachmentText, Zotero.FullText.indexItems()
 *
 * Content Hierarchy:
 * 1. ALL notes are always included
 * 2. If a same-title note exists (contains OCR/extracted content), skip indexed PDF to avoid duplication
 * 3. If NO same-title note exists, add indexed PDF text (auto-index if needed)
 * 4. If no PDF found, just return notes content (or null if no notes either)
 *
 * @param item - The parent Zotero item (regular item, not attachment)
 * @param maxLength - Maximum text length to return (0 = no limit)
 * @param autoIndex - Whether to auto-index unindexed PDFs (default true)
 * @param includeAllNotes - Whether to include all notes (default true)
 * @returns Combined content from notes and/or PDF, or null if not available
 */


interface FilterPreset {
  name: string;
  filters: SearchState;
}

function getFilterPresets(): FilterPreset[] {
  try {
    const stored = Zotero.Prefs.get(
      "extensions.seerai.filterPresets",
    ) as string;
    return stored ? JSON.parse(stored) : [];
  } catch {
    return [];
  }
}

function saveFilterPresets(presets: FilterPreset[]): void {
  Zotero.Prefs.set("extensions.seerai.filterPresets", JSON.stringify(presets));
}

function addFilterPreset(name: string, filters: SearchState): void {
  const presets = getFilterPresets();
  presets.push({ name, filters: { ...filters } });
  saveFilterPresets(presets);
}

function deleteFilterPreset(name: string): void {
  const presets = getFilterPresets().filter((p) => p.name !== name);
  saveFilterPresets(presets);
}

function getNextPresetName(): string {
  const presets = getFilterPresets();
  let num = 1;
  while (presets.some((p) => p.name === `Preset ${num}`)) num++;
  return `Preset ${num}`;
}

// ==================== Search History (File-based Persistence) ====================

interface SearchHistoryEntry {
  id: string;
  query: string;
  state: SearchState;
  results: SemanticScholarPaper[];
  totalResults: number;
  searchToken: string | null;
  savedAt: string;
}

const SEARCH_HISTORY_MAX_ENTRIES = 20;
let searchHistoryDataDir: string | null = null;
let searchHistoryFilePath: string | null = null;

function getSearchHistoryFilePath(): string {
  if (!searchHistoryFilePath) {
    searchHistoryDataDir = PathUtils.join(
      Zotero.DataDirectory.dir,
      config.addonRef,
    );
    searchHistoryFilePath = PathUtils.join(
      searchHistoryDataDir,
      "search_history.json",
    );
  }
  return searchHistoryFilePath;
}

async function ensureSearchHistoryDir(): Promise<void> {
  const dataDir = PathUtils.join(Zotero.DataDirectory.dir, config.addonRef);
  if (!(await IOUtils.exists(dataDir))) {
    await IOUtils.makeDirectory(dataDir, { ignoreExisting: true });
  }
}

async function getSearchHistory(): Promise<SearchHistoryEntry[]> {
  try {
    await ensureSearchHistoryDir();
    const filePath = getSearchHistoryFilePath();

    if (!(await IOUtils.exists(filePath))) {
      return [];
    }

    const contentBytes = await IOUtils.read(filePath);
    const content = new TextDecoder().decode(contentBytes);
    if (!content) return [];

    return JSON.parse(content) as SearchHistoryEntry[];
  } catch (e) {
    Zotero.debug(`[seerai] Error loading search history: ${e}`);
    return [];
  }
}

async function saveSearchHistory(entries: SearchHistoryEntry[]): Promise<void> {
  try {
    await ensureSearchHistoryDir();
    const filePath = getSearchHistoryFilePath();
    const encoder = new TextEncoder();
    await IOUtils.write(
      filePath,
      encoder.encode(JSON.stringify(entries, null, 2)),
    );
  } catch (e) {
    Zotero.debug(`[seerai] Error saving search history: ${e}`);
  }
}

async function addSearchHistoryEntry(entry: SearchHistoryEntry): Promise<void> {
  const history = await getSearchHistory();

  // Remove any existing entry with the same query (avoid duplicates)
  const filtered = history.filter(
    (h) => h.query.toLowerCase() !== entry.query.toLowerCase(),
  );

  // Add new entry at the beginning
  filtered.unshift(entry);

  // Keep only max entries
  const trimmed = filtered.slice(0, SEARCH_HISTORY_MAX_ENTRIES);

  await saveSearchHistory(trimmed);
  Zotero.debug(
    `[seerai] Added search history entry: "${entry.query}" (${entry.results.length} results)`,
  );
}

async function deleteSearchHistoryEntry(id: string): Promise<void> {
  const history = await getSearchHistory();
  const filtered = history.filter((h) => h.id !== id);
  await saveSearchHistory(filtered);
  Zotero.debug(`[seerai] Deleted search history entry: ${id}`);
}

/**
 * Update the most recent history entry for a query with AI insights
 */
async function updateSearchHistoryWithInsights(
  query: string,
  insights: string,
): Promise<void> {
  const history = await getSearchHistory();
  const entry = history.find(
    (h) => h.query.toLowerCase() === query.toLowerCase(),
  );
  if (entry) {
    entry.state.cachedAiInsights = insights;
    await saveSearchHistory(history);
    Zotero.debug(
      `[seerai] Updated search history entry with AI insights: "${query}"`,
    );
  }
}

// ==================== Search Column Configuration Persistence ====================

function getSearchColumnConfigPath(): string {
  if (!searchColumnConfigFilePath) {
    const dataDir = PathUtils.join(Zotero.DataDirectory.dir, config.addonRef);
    searchColumnConfigFilePath = PathUtils.join(dataDir, "search_columns.json");
  }
  return searchColumnConfigFilePath;
}

async function loadSearchColumnConfig(): Promise<SearchColumnConfig> {
  try {
    await ensureSearchHistoryDir(); // Reuse the same data directory
    const filePath = getSearchColumnConfigPath();

    if (!(await IOUtils.exists(filePath))) {
      return { ...defaultSearchColumnConfig };
    }

    const contentBytes = await IOUtils.read(filePath);
    const content = new TextDecoder().decode(contentBytes);
    if (!content) return { ...defaultSearchColumnConfig };

    const parsed = JSON.parse(content) as SearchColumnConfig;
    // Ensure structure is valid
    return {
      columns: parsed.columns || [],
      generatedData: parsed.generatedData || {},
      responseLength: parsed.responseLength || 100,
    };
  } catch (e) {
    Zotero.debug(`[seerai] Error loading search column config: ${e}`);
    return { ...defaultSearchColumnConfig };
  }
}

async function saveSearchColumnConfig(): Promise<void> {
  try {
    await ensureSearchHistoryDir();
    const filePath = getSearchColumnConfigPath();
    const encoder = new TextEncoder();
    await IOUtils.write(
      filePath,
      encoder.encode(JSON.stringify(searchColumnConfig, null, 2)),
    );
    Zotero.debug(
      `[seerai] Saved search column config (${searchColumnConfig.columns.length} columns)`,
    );
  } catch (e) {
    Zotero.debug(`[seerai] Error saving search column config: ${e}`);
  }
}

// DataLabs service for PDF-to-note conversion
const ocrService = new OcrService();

export class Assistant {
  public static getOcrService() {
    return ocrService;
  }

  public static async getPdfTextForItem(
    item: Zotero.Item,
    maxLength: number = 0,
    autoIndex: boolean = true,
    includeAllNotes: boolean = true,
  ): Promise<string | null> {
    const parts: string[] = [];
    let hasSameTitleNote = false;
    const itemTitle = ((item.getField("title") as string) || "")
      .toLowerCase()
      .trim();

    // Step 1: Always collect all notes
    if (includeAllNotes) {
      const noteIds = item.getNotes();
      for (const noteId of noteIds) {
        const note = Zotero.Items.get(noteId);
        if (note) {
          const noteHTML = note.getNote();
          // Strip HTML tags to get plain text
          const plainText = noteHTML
            .replace(/<[^>]*>/g, " ")
            .replace(/\s+/g, " ")
            .trim();

          if (plainText.length > 0) {
            // Get note title
            const noteTitle = (note.getNoteTitle() || "").toLowerCase().trim();

            // Check if this is a same-title note (contains extracted PDF content)
            if (
              noteTitle &&
              itemTitle &&
              noteTitle.includes(
                itemTitle.substring(0, Math.min(30, itemTitle.length)),
              )
            ) {
              hasSameTitleNote = true;
              Zotero.debug(`[seerai] Found same-title note for item ${item.id}`);
            }

            parts.push(
              `[Note: ${note.getNoteTitle() || "Untitled Note"}]\n${plainText}`,
            );
          }
        }
      }
    }

    // Step 2: Add indexed PDF text ONLY if no same-title note exists (to avoid duplication)
    if (!hasSameTitleNote) {
      const attachmentIds = item.getAttachments();

      for (const attId of attachmentIds) {
        const att = Zotero.Items.get(attId);
        if (!att || att.attachmentContentType !== "application/pdf") continue;

        try {
          // Try Zotero 7 high-level API (item.attachmentText is async getter)
          let text = await (att as any).attachmentText;

          if (text && text.length > 0) {
            Zotero.debug(
              `[seerai] Got indexed PDF text for attachment ${attId} (${text.length} chars)`,
            );
            parts.push(`[Indexed PDF Text]\n${text}`);
            break; // Only need one PDF's text
          }

          // Not indexed - try to index if autoIndex enabled
          if (autoIndex) {
            Zotero.debug(
              `[seerai] PDF not indexed, triggering indexing for attachment ${attId}`,
            );

            // Ensure DB is ready before indexing
            await att.saveTx();

            // Call the asynchronous indexer
            await (Zotero.FullText as any).indexItems([attId]);

            // Retry after indexing
            text = await (att as any).attachmentText;
            if (text && text.length > 0) {
              Zotero.debug(
                `[seerai] Indexing complete, got ${text.length} chars`,
              );
              parts.push(`[Indexed PDF Text]\n${text}`);
              break;
            }

            Zotero.debug(
              `[seerai] No text after indexing - likely image-only PDF`,
            );
          }
        } catch (e) {
          Zotero.debug(
            `[seerai] Error getting PDF text for attachment ${attId}: ${e}`,
          );
        }
      }
    } else {
      Zotero.debug(
        `[seerai] Skipping indexed PDF for item ${item.id} - same-title note already included`,
      );
    }

    // Return combined content
    if (parts.length === 0) {
      return null;
    }

    const combined = parts.join("\n\n");
    return maxLength > 0 ? combined.substring(0, maxLength) : combined;
  }
  public static getSearchState(): SearchState {
    return currentSearchState;
  }

  public static setSearchState(state: SearchState): void {
    currentSearchState = state;
  }

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
  private static reRenderSelectionArea(): void {
    // Selection area is currently hidden, so no-op
    // If it becomes visible in future, implement re-rendering logic here
  }

  /**
   * Convert Zotero item to SelectedItem format
   */
  private static itemToSelection(item: Zotero.Item): SelectedItem {
    const creators = item
      .getCreators()
      .map((c) => `${c.firstName || ""} ${c.lastName || ""}`.trim());
    return {
      id: item.id,
      type: (item.itemType as SelectedItem["type"]) || "other",
      title: (item.getField("title") as string) || "Untitled",
      abstract: (item.getField("abstractNote") as string) || undefined,
      creators,
      year: (item.getField("year") as string) || undefined,
    };
  }

  /**
   * Get ALL notes from a Zotero item as SelectedNote objects
   */
  private static async getItemNotesAsSelections(
    item: Zotero.Item,
  ): Promise<SelectedNote[]> {
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
            type: "note",
            title: `Note: ${((targetItem.getField("title") as string) || "").slice(0, 30)}...`,
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
   * Format a date as relative time (e.g., "2 hours ago", "Yesterday")
   */
  private static formatRelativeTime(date: Date): string {
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffSecs = Math.floor(diffMs / 1000);
    const diffMins = Math.floor(diffSecs / 60);
    const diffHours = Math.floor(diffMins / 60);
    const diffDays = Math.floor(diffHours / 24);

    if (diffSecs < 60) return "Just now";
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays === 1) return "Yesterday";
    if (diffDays < 7) return `${diffDays}d ago`;
    return date.toLocaleDateString();
  }

  /**
   * Restore search state from a history entry
   */
  private static restoreSearchFromHistory(
    entry: SearchHistoryEntry,
    doc: Document,
    searchInput: HTMLInputElement,
  ): void {
    // Restore state
    currentSearchState = { ...entry.state };
    currentSearchResults = [...entry.results];
    totalSearchResults = entry.totalResults;
    currentSearchToken = entry.searchToken;

    // Update search input
    searchInput.value = entry.query;

    // Re-render filters (requires rebuilding the filters UI)
    const filtersContainer = doc.querySelector(".search-filters-container");
    if (filtersContainer && filtersContainer.parentElement) {
      const parent = filtersContainer.parentElement;
      const newFilters = this.createSearchFilters(doc);
      filtersContainer.replaceWith(newFilters);
    }

    // Re-render results
    const resultsArea = doc.getElementById("semantic-scholar-results");
    if (resultsArea && currentItem) {
      this.renderSearchResults(doc, resultsArea as HTMLElement, currentItem);
    }

    Zotero.debug(
      `[seerai] Restored search from history: "${entry.query}" (${entry.results.length} results)`,
    );
  }

  /**
   * Add an item and its notes to the selection
   */
  /**
   * Add an item to the unified context manager
   */
  private static async addItemWithNotes(item: Zotero.Item) {
    const contextManager = ChatContextManager.getInstance();
    const stateManager = getChatStateManager();

    // Map Zotero Item to ContextItem
    const contextItem: ContextItem = {
      id: item.id,
      type: "paper",
      displayName: item.getField("title"),
      fullName: item.getField("title"),
      trigger: "/",
      source: "selection",
      metadata: {
        itemKey: item.key,
        libraryID: item.libraryID,
      },
    };

    const mode = stateManager.getOptions().selectionMode;

    if (mode === "explore") {
      // Additive - Treat as command so it persists
      contextManager.addItem(
        contextItem.id,
        contextItem.type,
        contextItem.displayName,
        "command",
        contextItem.metadata,
      );
    } else {
      // Default/Focus: Replace
      contextManager.syncFromSelection([item]);
    }
  }

  /**
   * Remove an item and its associated notes
   */
  private static removeItemWithNotes(itemId: number) {
    const stateManager = getChatStateManager();

    // Remove any notes that belong to this item
    const states = stateManager.getStates();
    const notesToRemove = states.notes.filter((n) => n.parentItemId === itemId);
    for (const note of notesToRemove) {
      stateManager.removeSelection("notes", note.id);
    }

    // Remove the item
    stateManager.removeSelection("items", itemId);

    // Re-render selection area
    this.reRenderSelectionArea();
  }

  /**
   * Session Management
   */

  public static async loadHistory() {
    try {
      conversationHistory = await getMessageStore().getHistory();
    } catch (e) {
      Zotero.debug(`[seerai] Error loading history: ${e}`);
    }
  }

  public static async createNewChat() {
    const store = getMessageStore();
    const newId = `chat_${Date.now()}`;

    // Save current state if any before switching
    if (conversationMessages.length > 0) {
      const stateManager = getChatStateManager();
      await store.saveConversationState(stateManager.getStates(), stateManager.getOptions());
    }

    store.setConversationId(newId);
    conversationMessages = [];
    resetChatStateManager();

    // Initial history entry for the new chat
    await store.updateConversationMetadata({
      id: newId,
      title: "New Chat",
      messageCount: 0,
      preview: "Start a new conversation..."
    });

    await this.loadHistory();

    if (currentContainer && currentItem) {
      this.renderInterface(currentContainer, currentItem);
    }
  }

  public static async loadChat(id: string) {
    const store = getMessageStore();

    // Save current state before switching
    if (conversationMessages.length > 0) {
      const stateManager = getChatStateManager();
      await store.saveConversationState(stateManager.getStates(), stateManager.getOptions());
    }

    store.setConversationId(id);

    // Load messages
    conversationMessages = await store.loadMessages();

    // Load state
    const savedState = await store.getConversationState();
    resetChatStateManager();
    const stateManager = getChatStateManager();
    if (savedState) {
      stateManager.fromJSON(savedState);
    }

    if (currentContainer && currentItem) {
      this.renderInterface(currentContainer, currentItem);
    }
  }

  public static async deleteChat(id: string) {
    const store = getMessageStore();
    await store.deleteConversation(id);

    // If the deleted chat was the current one, create a new one or load the most recent
    if (store.getConversationId() === id) {
      const history = await store.getHistory();
      if (history.length > 0) {
        await this.loadChat(history[0].id);
      } else {
        await this.createNewChat();
      }
    } else {
      await this.loadHistory();
      if (currentContainer && currentItem) {
        this.renderInterface(currentContainer, currentItem);
      }
    }
  }

  public static async updateConversationTitle(firstMessage: string) {
    const store = getMessageStore();
    const currentId = store.getConversationId();
    const history = await store.getHistory();
    const conv = history.find(h => h.id === currentId);

    if (conv && (conv.title === "New Chat" || !conv.title)) {
      // Simple auto-titling: use first 30 chars of the message
      let newTitle = firstMessage.trim().slice(0, 40);
      if (firstMessage.length > 40) newTitle += "...";

      await store.updateConversationMetadata({
        id: currentId,
        title: newTitle
      });

      await this.loadHistory();

      // Re-render to show new title in sidebar
      if (currentContainer && currentItem) {
        this.renderInterface(currentContainer, currentItem);
      }
    }
  }

  /**
   * Main interface renderer
   */
  private static async renderInterface(
    container: HTMLElement,
    item: Zotero.Item,
  ) {
    container.innerHTML = "";
    const doc = container.ownerDocument!;

    // Ensure stylesheet is loaded
    const styleId = "seerai-stylesheet";
    if (!doc.getElementById(styleId)) {
      const link = ztoolkit.UI.createElement(doc, "link", {
        properties: {
          id: styleId,
          type: "text/css",
          rel: "stylesheet",
          href: `chrome://${config.addonRef}/content/zoteroPane.css`,
        },
      });
      doc.documentElement?.appendChild(link);
    }

    const stateManager = getChatStateManager();

    // Load history and persisted messages if not already loaded
    if (conversationHistory.length === 0) {
      await this.loadHistory();
    }

    if (conversationMessages.length === 0) {
      try {
        const store = getMessageStore();
        // If history exists, load the most recent one if no ID is set
        if (conversationHistory.length > 0 && store.getConversationId() === "default") {
          store.setConversationId(conversationHistory[0].id);
        }
        conversationMessages = await store.loadMessages();

        // Also load state for this chat
        const savedState = await store.getConversationState();
        if (savedState) {
          stateManager.fromJSON(savedState);
        }

        Zotero.debug(
          `[seerai] Loaded ${conversationMessages.length} messages for session ${store.getConversationId()}`,
        );
      } catch (e) {
        Zotero.debug(`[seerai] Error loading messages: ${e}`);
      }
    }

    // Load table config - ALWAYS reload from disk when viewing table tab to get latest changes from tools
    if (!currentTableConfig || activeTab === "table") {
      try {
        const tableStore = getTableStore();
        currentTableConfig = await tableStore.loadConfig();
        Zotero.debug(`[seerai] Loaded table config: ${currentTableConfig.id} (activeTab=${activeTab})`);
      } catch (e) {
        Zotero.debug(`[seerai] Error loading table config: ${e}`);
      }
    }

    // Auto-add current item with its notes based on selection mode
    const options = stateManager.getOptions();
    const mode = options.selectionMode;

    if (mode === "explore") {
      // Explore mode: add items without clearing (multi-add)
      if (!stateManager.isSelected("items", item.id)) {
        this.addItemWithNotes(item);
      }
    } else if (mode === "default") {
      // Default mode: switch to single item (clear others, focus on this one)
      if (!stateManager.isSelected("items", item.id)) {
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
        fontFamily: "system-ui, -apple-system, sans-serif",
      },
    });

    try {
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
          overflow: "hidden",
        },
      });

      // Render active tab content
      if (activeTab === "chat") {
        const chatTabContent = await this.createChatTabContent(
          doc,
          item,
          stateManager,
        );
        tabContent.appendChild(chatTabContent);
      } else if (activeTab === "table") {
        const tableTabContent = await this.createTableTabContent(doc, item);
        tabContent.appendChild(tableTabContent);
      } else if (activeTab === "search") {
        const searchTabContent = await this.createSearchTabContent(doc, item);
        tabContent.appendChild(searchTabContent);
      }

      mainContainer.appendChild(tabContent);
      container.appendChild(mainContainer);
    } catch (error) {
      Zotero.debug(`[seerai] Error rendering interface: ${error}`);
      const errorDiv = doc.createElement("div");
      errorDiv.style.cssText = "padding: 20px; color: red;";
      errorDiv.textContent = `Error rendering interface: ${error}`;
      container.appendChild(errorDiv);
    }
  }

  /**
   * Create the tab bar navigation
   */
  private static createTabBar(
    doc: Document,
    container: HTMLElement,
    item: Zotero.Item,
  ): HTMLElement {
    const tabBar = ztoolkit.UI.createElement(doc, "div", {
      properties: { className: "tab-bar" },
      styles: {
        display: "flex",
        gap: "0",
        borderBottom: "1px solid var(--border-primary)",
        backgroundColor: "var(--background-secondary)",
        borderRadius: "6px 6px 0 0",
        overflow: "hidden",
      },
    });

    const tabs: { id: AssistantTab; label: string; icon: string }[] = [
      { id: "chat", label: "Chat", icon: "💬" },
      { id: "table", label: "Papers Table", icon: "📊" },
      { id: "search", label: "Search", icon: "🔍" },
    ];

    tabs.forEach((tab) => {
      const tabItem = ztoolkit.UI.createElement(doc, "button", {
        properties: {
          className: `tab-item ${activeTab === tab.id ? "active" : ""}`,
          innerText: `${tab.icon} ${tab.label}`,
        },
        styles: {
          padding: "8px 16px",
          cursor: "pointer",
          fontSize: "12px",
          fontWeight: "500",
          color:
            activeTab === tab.id
              ? "var(--highlight-primary)"
              : "var(--text-secondary)",
          backgroundColor:
            activeTab === tab.id ? "var(--background-primary)" : "transparent",
          border: "none",
          borderBottom:
            activeTab === tab.id
              ? "2px solid var(--highlight-primary)"
              : "2px solid transparent",
          flex: "1",
          textAlign: "center",
          transition: "all 0.2s ease",
        },
        listeners: [
          {
            type: "click",
            listener: () => {
              if (activeTab !== tab.id) {
                activeTab = tab.id;
                this.renderInterface(container, item);
              }
            },
          },
        ],
      });
      tabBar.appendChild(tabItem);
    });

    return tabBar;
  }

  /**
   * Create the History Sidebar
   */
  private static createHistorySidebar(doc: Document): HTMLElement {
    const sidebar = doc.createElement("div");
    sidebar.className = "history-sidebar";
    sidebar.style.cssText = `
      width: ${isHistorySidebarVisible ? "250px" : "0px"};
      min-width: ${isHistorySidebarVisible ? "200px" : "0px"};
      display: flex;
      flex-direction: column;
      border-right: 1px solid var(--border-primary);
      background-color: var(--background-secondary);
      transition: width 0.3s ease, min-width 0.3s ease;
      overflow: hidden;
      height: 100%;
    `;

    // Header with New Chat button
    const header = doc.createElement("div");
    header.style.cssText = "padding: 12px; border-bottom: 1px solid var(--border-primary); display: flex; flex-direction: column; gap: 8px;";

    const newChatBtn = doc.createElement("button");
    newChatBtn.className = "new-chat-btn";
    newChatBtn.innerHTML = "➕ New Chat";
    newChatBtn.style.cssText = `
      width: 100%;
      padding: 8px;
      border-radius: 6px;
      background: var(--highlight-primary);
      color: white;
      border: none;
      cursor: pointer;
      font-weight: 500;
      transition: opacity 0.2s;
    `;
    newChatBtn.onclick = () => this.createNewChat();
    header.appendChild(newChatBtn);
    sidebar.appendChild(header);

    // List of conversations
    const list = doc.createElement("div");
    list.className = "history-list";
    list.style.cssText = "flex: 1; overflow-y: auto; display: flex; flex-direction: column;";

    const currentId = getMessageStore().getConversationId();

    conversationHistory.forEach(conv => {
      const item = doc.createElement("div");
      item.className = `history-item ${conv.id === currentId ? "active" : ""}`;
      item.style.cssText = `
        padding: 10px 12px;
        cursor: pointer;
        display: flex;
        flex-direction: column;
        gap: 4px;
        border-bottom: 1px solid var(--border-secondary);
        background: ${conv.id === currentId ? "var(--background-primary)" : "transparent"};
        position: relative;
        transition: background 0.2s;
      `;

      item.onclick = (e) => {
        if ((e.target as HTMLElement).classList.contains('delete-btn')) return;
        this.loadChat(conv.id);
      };

      const title = doc.createElement("div");
      title.textContent = conv.title || "Untitled Chat";
      title.style.cssText = "font-size: 13px; font-weight: 600; color: var(--text-primary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; padding-right: 20px;";
      item.appendChild(title);

      const preview = doc.createElement("div");
      preview.textContent = conv.preview || "No messages";
      preview.style.cssText = "font-size: 11px; color: var(--text-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;";
      item.appendChild(preview);

      const date = doc.createElement("div");
      date.textContent = this.formatRelativeTime(new Date(conv.updatedAt));
      date.style.cssText = "font-size: 10px; color: var(--text-tertiary);";
      item.appendChild(date);

      // Delete button (hidden by default, shown on hover via CSS in zoteroPane.css)
      const deleteBtn = doc.createElement("button");
      deleteBtn.className = "delete-btn";
      deleteBtn.innerHTML = "✕";
      deleteBtn.title = "Delete conversation";
      deleteBtn.style.cssText = `
        position: absolute;
        top: 8px;
        right: 8px;
        background: transparent;
        border: none;
        color: var(--text-tertiary);
        cursor: pointer;
        font-size: 14px;
        padding: 4px;
        display: none;
      `;
      deleteBtn.onclick = (e) => {
        e.stopPropagation();
        if (doc.defaultView?.confirm("Are you sure you want to delete this conversation?")) {
          this.deleteChat(conv.id);
        }
      };
      item.appendChild(deleteBtn);

      // Simple hover effect for JS toggle
      item.onmouseenter = () => { deleteBtn.style.display = "block"; };
      item.onmouseleave = () => { deleteBtn.style.display = "none"; };

      list.appendChild(item);
    });

    if (conversationHistory.length === 0) {
      const empty = doc.createElement("div");
      empty.textContent = "No history yet";
      empty.style.cssText = "padding: 20px; text-align: center; color: var(--text-tertiary); font-style: italic; font-size: 12px;";
      list.appendChild(empty);
    }

    sidebar.appendChild(list);
    return sidebar;
  }

  /**
   * Create the Chat tab content (existing chat UI)
   */
  private static async createChatTabContent(
    doc: Document,
    item: Zotero.Item,
    stateManager: ReturnType<typeof getChatStateManager>,
  ): Promise<HTMLElement> {
    const mainWrapper = doc.createElement("div");
    mainWrapper.style.cssText = "display: flex; height: 100%; width: 100%; overflow: hidden;";

    // === CHAT CONTENT ===
    const chatContainer = ztoolkit.UI.createElement(doc, "div", {
      styles: {
        display: "flex",
        flexDirection: "column",
        height: "100%",
        flex: "1",
        gap: "8px",
        padding: "8px",
        minWidth: "0",
        position: "relative",
      },
    });

    // === SELECTION AREA ===
    let selectionArea: HTMLElement;
    try {
      selectionArea = this.createSelectionArea(doc, stateManager);
    } catch (e) {
      Zotero.debug(`[seerai] Error creating selection area: ${e}`);
      selectionArea = doc.createElement("div");
      selectionArea.textContent = `Error in selection area: ${e}`;
      selectionArea.style.color = "red";
    }

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
        minHeight: "450px",
        maxHeight: "600px",
        overflow: "auto",
      },
      properties: { id: "assistant-messages-area" },
    }) as HTMLElement;

    // Restore previous messages
    try {
      const lastUserMsgIndex = conversationMessages
        .map((m) => m.role)
        .lastIndexOf("user");
      conversationMessages.forEach((msg, idx) => {
        const isLastUserMsg = msg.role === "user" && idx === lastUserMsgIndex;
        this.renderStoredMessage(messagesArea, msg, isLastUserMsg);
      });
    } catch (e) {
      Zotero.debug(`[seerai] Error restoring messages: ${e}`);
    }

    // === RESTORE ACTIVE SESSION ===
    if (activeAgentSession) {
      try {
        Zotero.debug(`[seerai] Restoring active agent session UI - isThinking: ${activeAgentSession.isThinking}, toolResults: ${activeAgentSession.toolResults.length}, fullResponse length: ${activeAgentSession.fullResponse?.length || 0}`);

        const streamingDiv = this.appendMessage(messagesArea, "Assistant", "");
        const contentDiv = streamingDiv.querySelector(
          "[data-content]",
        ) as HTMLElement;

        // CRITICAL: Update session references IMMEDIATELY so any concurrent callbacks use new DOM
        activeAgentSession.messagesArea = messagesArea;
        activeAgentSession.contentDiv = contentDiv;

        // Restore response content
        if (activeAgentSession.isThinking && !activeAgentSession.fullResponse) {
          contentDiv.innerHTML = `
            <div class="typing-indicator" style="display: flex; align-items: center; gap: 4px; color: var(--text-secondary); font-style: italic;">
                <span>Thinking</span>
                <span class="dot" style="animation: blink 1.4s infinite .2s;">.</span>
                <span class="dot" style="animation: blink 1.4s infinite .4s;">.</span>
                <span class="dot" style="animation: blink 1.4s infinite .6s;">.</span>
            </div>
          `;
        } else if (activeAgentSession.fullResponse) {
          // Create markdown container for text content
          const mdContainer = doc.createElement("div");
          mdContainer.className = "markdown-content";
          mdContainer.setAttribute("data-raw", activeAgentSession.fullResponse);
          mdContainer.innerHTML = parseMarkdown(activeAgentSession.fullResponse);
          contentDiv.appendChild(mdContainer);
        }

        // ALWAYS create toolProcessState if session is active (even with 0 results)
        // This ensures subsequent tool calls have a valid container
        const { container, setThinking, setCompleted, setFailed } = createToolProcessUI(doc);
        contentDiv.appendChild(container);

        // Access internal list container
        const listContainer = container.querySelector(".tool-list-container");
        const targetContainer = (listContainer || container) as HTMLElement;

        // Update session references for tool container
        activeAgentSession.toolProcessState = { container, setThinking, setCompleted, setFailed };
        activeAgentSession.toolContainer = targetContainer;

        // Re-hydrate existing tool cards
        activeAgentSession.toolResults.forEach(tr => {
          const toolUI = createToolExecutionUI(doc, tr.toolCall, tr.result);
          targetContainer.appendChild(toolUI);
          // CRITICAL: Update the reference so the observer updates THIS element
          tr.uiElement = toolUI;
        });

        // Set appropriate state indicator
        if (activeAgentSession.isThinking || activeAgentSession.toolResults.some(tr => !tr.result)) {
          setThinking();
        } else if (activeAgentSession.toolResults.length > 0) {
          setCompleted(activeAgentSession.toolResults.length);
        }

        // Show stop button if streaming
        const stopBtn = doc.getElementById("stop-btn") as HTMLElement | null;
        if (stopBtn && this.isStreaming) {
          stopBtn.style.display = "inline-block";
        }

        // Auto-scroll
        messagesArea.scrollTop = messagesArea.scrollHeight;

        Zotero.debug("[seerai] Active session restoration complete");
      } catch (e) {
        Zotero.debug(`[seerai] Error restoring active session: ${e}`);
        const errDiv = doc.createElement("div");
        errDiv.textContent = `Error restoring session: ${e}`;
        errDiv.style.color = "red";
        messagesArea.appendChild(errDiv);
      }
    }

    // === INPUT AREA ===
    let inputArea: HTMLElement;
    try {
      inputArea = this.createInputArea(doc, messagesArea, stateManager);
    } catch (e) {
      Zotero.debug(`[seerai] Error creating input area: ${e}`);
      inputArea = doc.createElement("div");
      inputArea.textContent = `Error in input area: ${e}`;
      inputArea.style.color = "red";
    }

    // Assemble
    chatContainer.appendChild(selectionArea);

    chatContainer.appendChild(messagesArea);
    chatContainer.appendChild(inputArea);

    mainWrapper.appendChild(chatContainer);
    return mainWrapper;
  }

  /**
   * Create the Papers Table tab content
   */
  private static async createTableTabContent(
    doc: Document,
    item: Zotero.Item,
  ): Promise<HTMLElement> {
    const tableContainer = ztoolkit.UI.createElement(doc, "div", {
      properties: { className: "papers-table-container" },
      styles: {
        display: "flex",
        flexDirection: "column",
        height: "100%",
        overflow: "hidden",
      },
    });

    // Load table data
    const tableData = await this.loadTableData();

    // === TOOLBAR ===
    const toolbar = this.createTableToolbar(doc, item);
    tableContainer.appendChild(toolbar);

    // === TABLE + SIDE STRIP CONTAINER ===
    const tableWithSideStrip = ztoolkit.UI.createElement(doc, "div", {
      styles: {
        display: "flex",
        flexDirection: "row",
        flex: "1",
        minHeight: "0",
        overflow: "hidden",
      },
    });

    // === TABLE WRAPPER ===
    const tableWrapper = ztoolkit.UI.createElement(doc, "div", {
      properties: { className: "table-wrapper" },
      styles: {
        flex: "1",
        overflow: "auto",
        backgroundColor: "var(--background-primary)",
      },
    });

    if (tableData.rows.length === 0) {
      // Empty state
      const emptyState = this.createTableEmptyState(doc, item);
      tableWrapper.appendChild(emptyState);
    } else {
      // Render table
      const table = this.createPapersTable(doc, tableData);
      tableWrapper.appendChild(table);
    }

    tableWithSideStrip.appendChild(tableWrapper);

    // === SIDE STRIP (Right Side) ===
    const sideStrip = this.createTableSideStrip(doc, item, tableWithSideStrip);
    tableWithSideStrip.appendChild(sideStrip);

    tableContainer.appendChild(tableWithSideStrip);

    return tableContainer;
  }

  /**
   * Create vertical side strip for Tables tab with 3 action buttons
   * Matches the Search tab's side strip pattern
   */
  private static createTableSideStrip(
    doc: Document,
    item: Zotero.Item,
    container: HTMLElement,
  ): HTMLElement {
    const sideStrip = ztoolkit.UI.createElement(doc, "div", {
      styles: {
        width: "30px",
        minWidth: "30px",
        borderLeft: "1px solid var(--border-primary)",
        backgroundColor: "var(--background-secondary)",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: "8px",
        paddingTop: "8px",
      },
    });

    // Helper for side buttons (same pattern as search tab)
    const createSideBtn = (
      icon: string,
      title: string,
      onClick: (e: Event) => void,
    ) => {
      const btn = ztoolkit.UI.createElement(doc, "button", {
        properties: { innerText: icon },
        attributes: { title: title },
        styles: {
          width: "24px",
          height: "24px",
          display: "flex",
          justifyContent: "center",
          alignItems: "center",
          border: "1px solid var(--border-primary)",
          borderRadius: "4px",
          backgroundColor: "var(--background-primary)",
          cursor: "pointer",
          fontSize: "14px",
          color: "var(--text-primary)",
          transition: "all 0.2s ease",
        },
        listeners: [
          {
            type: "click",
            listener: onClick,
          },
        ],
      });

      // Hover effects
      btn.addEventListener("mouseenter", () => {
        btn.style.backgroundColor = "var(--highlight-primary)";
        btn.style.color = "var(--highlight-text)";
        btn.style.borderColor = "var(--highlight-primary)";
      });
      btn.addEventListener("mouseleave", () => {
        btn.style.backgroundColor = "var(--background-primary)";
        btn.style.color = "var(--text-primary)";
        btn.style.borderColor = "var(--border-primary)";
      });

      return btn;
    };

    // 1. (+) Add Column - immediately adds a new column with inline editing
    const addColumnBtn = createSideBtn(
      "➕",
      "Add Analysis Column",
      async (e) => {
        e.stopPropagation();
        await this.addImmediateTableColumn(doc, item, container);
      },
    );
    sideStrip.appendChild(addColumnBtn);

    // 2. (⚡) Generate All
    const generateAllBtn = createSideBtn("⚡", "Generate All Analysis", (e) => {
      e.stopPropagation();
      this.generateAllEmptyColumns(doc, item);
    });
    sideStrip.appendChild(generateAllBtn);

    // 3. (⚙️) Settings
    const settingsBtn = createSideBtn(
      "⚙️",
      "Manage Columns & Settings",
      (e) => {
        e.stopPropagation();
        this.showTableSettingsPopover(
          doc,
          e.currentTarget as HTMLElement,
          container,
          item,
        );
      },
    );
    sideStrip.appendChild(settingsBtn);

    // === BULK ACTIONS (Hidden by default) ===
    const bulkActionsContainer = ztoolkit.UI.createElement(doc, "div", {
      properties: { id: "table-bulk-actions" },
      styles: {
        display: "none", // Hidden by default
        flexDirection: "column",
        gap: "8px",
        marginTop: "16px",
        paddingTop: "16px",
        borderTop: "1px solid var(--border-primary)",
        width: "100%",
        alignItems: "center",
      },
    });

    // 4. (💾) Save Selected
    const saveSelectedBtn = createSideBtn(
      "💾",
      "Save Selected as Notes",
      async (e) => {
        e.stopPropagation();
        if (!currentTableData || currentTableData.selectedRowIds.size === 0)
          return;
        if (
          doc.defaultView?.confirm(
            `Save ${currentTableData.selectedRowIds.size} selected rows as notes?`,
          )
        ) {
          // Filter rows
          const rowsToSave = currentTableData.rows.filter((r) =>
            currentTableData!.selectedRowIds.has(r.paperId),
          );
          const cols = currentTableConfig?.columns || defaultColumns;
          let saved = 0;
          for (const row of rowsToSave) {
            if (await this.saveRowAsNote(row, cols)) saved++;
          }
          doc.defaultView?.alert(`Saved ${saved} notes.`);
        }
      },
    );
    bulkActionsContainer.appendChild(saveSelectedBtn);

    // 5. (⚡) Generate/Regenerate Selected
    const genSelectedBtn = createSideBtn(
      "⚡",
      "Generate/Regenerate Selected",
      (e) => {
        e.stopPropagation();
        if (!currentTableData || currentTableData.selectedRowIds.size === 0)
          return;
        // Logic will be handled in generateAllEmptyColumns by checking selection
        this.generateAllEmptyColumns(doc, item);
      },
    );
    bulkActionsContainer.appendChild(genSelectedBtn);

    // 6. (🗑️) Trash (Remove from Table)
    const trashSelectedBtn = createSideBtn(
      "🗑️",
      "Remove Selected from Table",
      async (e) => {
        e.stopPropagation();
        if (!currentTableData || currentTableData.selectedRowIds.size === 0)
          return;
        if (
          doc.defaultView?.confirm(
            `Remove ${currentTableData.selectedRowIds.size} papers from this table?`,
          )
        ) {
          if (currentTableConfig) {
            const idsToRemove = Array.from(currentTableData.selectedRowIds);
            currentTableConfig.addedPaperIds =
              currentTableConfig.addedPaperIds.filter(
                (id) => !idsToRemove.includes(id),
              );
            // Cleanup generated data
            idsToRemove.forEach((id) => {
              if (currentTableConfig!.generatedData?.[id]) {
                delete currentTableConfig!.generatedData![id];
              }
            });
            const tableStore = getTableStore();
            await tableStore.saveConfig(currentTableConfig);
            // Refresh
            if (currentContainer && currentItem) {
              this.renderInterface(currentContainer, currentItem);
            }
          }
        }
      },
    );
    bulkActionsContainer.appendChild(trashSelectedBtn);

    // 7. (💣) Bomb (Delete from Zotero)
    const bombSelectedBtn = createSideBtn(
      "💣",
      "Delete Selected from Zotero",
      async (e) => {
        e.stopPropagation();
        if (!currentTableData || currentTableData.selectedRowIds.size === 0)
          return;
        if (
          doc.defaultView?.confirm(
            `PERMANENTLY DELETE ${currentTableData.selectedRowIds.size} items from Zotero?\n\nThis cannot be undone!`,
          )
        ) {
          const idsToDelete = Array.from(currentTableData.selectedRowIds);
          try {
            await Zotero.Items.erase(idsToDelete);
            // Also remove from config
            if (currentTableConfig) {
              currentTableConfig.addedPaperIds =
                currentTableConfig.addedPaperIds.filter(
                  (id) => !idsToDelete.includes(id),
                );
              idsToDelete.forEach((id) => {
                if (currentTableConfig!.generatedData?.[id]) {
                  delete currentTableConfig!.generatedData![id];
                }
              });
              const tableStore = getTableStore();
              await tableStore.saveConfig(currentTableConfig);
            }
            // Refresh
            if (currentContainer && currentItem) {
              this.renderInterface(currentContainer, currentItem);
            }
          } catch (err) {
            doc.defaultView?.alert(`Error deleting items: ${err}`);
          }
        }
      },
    );
    // Style bomb button red
    bombSelectedBtn.style.color = "#c62828";
    bombSelectedBtn.style.borderColor = "#c62828";
    bulkActionsContainer.appendChild(bombSelectedBtn);

    sideStrip.appendChild(bulkActionsContainer);

    return sideStrip;
  }

  /**
       * Create the Search tab content with Semantic Scholar integration
  
       */
  private static async createSearchTabContent(
    doc: Document,
    item: Zotero.Item,
  ): Promise<HTMLElement> {
    // Load search column configuration
    searchColumnConfig = await loadSearchColumnConfig();

    const searchContainer = ztoolkit.UI.createElement(doc, "div", {
      properties: { className: "search-tab-container" },
      styles: {
        display: "flex",
        flexDirection: "column",
        height: "100%",
        overflow: "hidden",
        gap: "8px",
        padding: "8px",
      },
    });

    // === SEARCH INPUT ===
    const searchInputContainer = ztoolkit.UI.createElement(doc, "div", {
      styles: {
        display: "flex",
        gap: "8px",
        alignItems: "center",
      },
    });

    const searchInput = ztoolkit.UI.createElement(doc, "input", {
      attributes: {
        type: "text",
        placeholder: "🔍 Search Semantic Scholar...",
        value: currentSearchState.query || "",
      },
      properties: { id: "semantic-scholar-search-input" },
      styles: {
        flex: "1",
        padding: "10px 14px",
        border: "1px solid var(--border-primary)",
        borderRadius: "6px",
        fontSize: "13px",
        backgroundColor: "var(--background-primary)",
        color: "var(--text-primary)",
      },
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
        cursor: "pointer",
      },
      listeners: [
        {
          type: "click",
          listener: async () => {
            currentSearchState.query = searchInput.value;
            currentSearchResults = [];
            currentSearchToken = null;
            await this.performSearch(doc);
          },
        },
      ],
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
      attributes: {
        title:
          'Syntax: "phrase" | word1+word2 | word1|word2 | -exclude | word* | word~3',
      },
      styles: {
        fontSize: "14px",
        cursor: "help",
        opacity: "0.6",
      },
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
        marginLeft: "4px",
      },
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
        overflowY: "auto",
      },
    });

    // Close dropdown when clicking outside
    doc.addEventListener("click", (e: Event) => {
      if (
        !suggestionsDropdown.contains(e.target as Node) &&
        e.target !== suggestionsBtn
      ) {
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
            fontSize: "12px",
          },
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
          fontSize: "12px",
        },
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
              fontSize: "12px",
            },
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
            backgroundColor: "var(--background-secondary)",
          },
        });
        header.innerHTML = `💡 ${suggestions.length} suggestion${suggestions.length > 1 ? "s" : ""} for "${query}"`;
        suggestionsDropdown.appendChild(header);

        suggestions.slice(0, 8).forEach((sugg) => {
          const item = ztoolkit.UI.createElement(doc, "div", {
            styles: {
              padding: "10px 12px",
              fontSize: "12px",
              cursor: "pointer",
              borderBottom: "1px solid var(--border-primary)",
              lineHeight: "1.4",
            },
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
        Zotero.debug(`[seerai] Suggestions error: ${e}`);
        suggestionsDropdown.innerHTML = "";
        const errorDiv = ztoolkit.UI.createElement(doc, "div", {
          styles: {
            padding: "16px",
            textAlign: "center",
            color: "var(--error-color, #d32f2f)",
            fontSize: "12px",
          },
        });
        errorDiv.innerHTML = "⚠️ Failed to load suggestions";
        suggestionsDropdown.appendChild(errorDiv);
      }
    });

    // AI Query Refiner button (🤖)
    const aiRefineBtn = ztoolkit.UI.createElement(doc, "button", {
      properties: {
        innerText: "🤖",
        title: "AI: Refine query for Semantic Scholar",
      },
      styles: {
        padding: "8px 10px",
        backgroundColor: "var(--background-secondary)",
        color: "var(--text-primary)",
        border: "1px solid var(--border-primary)",
        borderRadius: "6px",
        fontSize: "14px",
        cursor: "pointer",
        marginLeft: "4px",
      },
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
        overflowY: "auto",
      },
    });

    // Close AI dropdown when clicking outside
    doc.addEventListener("click", (e: Event) => {
      if (
        !aiRefineDropdown.contains(e.target as Node) &&
        e.target !== aiRefineBtn
      ) {
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
            fontSize: "12px",
          },
        });
        msgDiv.innerHTML =
          "Enter your search criteria, research question, or PICO/FINER parameters";
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
            fontSize: "12px",
          },
        });
        errorDiv.innerHTML =
          "⚠️ No AI model configured. Please add a model in Settings.";
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
          fontSize: "12px",
        },
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
          { role: "user" as const, content: userInput },
        ];

        let refinedQuery = "";

        await openAIService.chatCompletionStream(
          messages,
          {
            onToken: (token) => {
              refinedQuery += token;
              // Update live
              aiRefineDropdown.innerHTML = "";
              const previewDiv = ztoolkit.UI.createElement(doc, "div", {
                styles: { padding: "12px" },
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
                styles: { padding: "12px" },
              });

              const headerDiv = ztoolkit.UI.createElement(doc, "div", {
                styles: {
                  fontSize: "11px",
                  color: "var(--text-secondary)",
                  marginBottom: "8px",
                },
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
                  marginBottom: "12px",
                },
              });
              queryDiv.innerText = refinedQuery;
              resultDiv.appendChild(queryDiv);

              // Action buttons
              const actionsDiv = ztoolkit.UI.createElement(doc, "div", {
                styles: {
                  display: "flex",
                  gap: "8px",
                },
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
                  cursor: "pointer",
                },
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
                  cursor: "pointer",
                },
              });
              copyBtn.addEventListener("click", () => {
                new ztoolkit.Clipboard()
                  .addText(refinedQuery, "text/unicode")
                  .copy();
                copyBtn.innerText = "✓ Copied!";
                setTimeout(() => {
                  copyBtn.innerText = "📋 Copy";
                }, 1500);
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
                  fontSize: "12px",
                },
              });
              errorDiv.innerHTML = `⚠️ AI Error: ${error.message}`;
              aiRefineDropdown.appendChild(errorDiv);
            },
          },
          {
            apiURL: activeModel.apiURL,
            apiKey: activeModel.apiKey,
            model: activeModel.model,
          },
        );
      } catch (e) {
        Zotero.debug(`[seerai] AI Refine error: ${e}`);
        aiRefineDropdown.innerHTML = "";
        const errorDiv = ztoolkit.UI.createElement(doc, "div", {
          styles: {
            padding: "16px",
            textAlign: "center",
            color: "var(--error-color, #d32f2f)",
            fontSize: "12px",
          },
        });
        errorDiv.innerHTML = "⚠️ Failed to refine query";
        aiRefineDropdown.appendChild(errorDiv);
      }
    });

    // === PAST SEARCHES BUTTON AND DROPDOWN ===
    const pastSearchesBtn = ztoolkit.UI.createElement(doc, "button", {
      properties: { innerText: "📜", title: "Past Searches" },
      styles: {
        padding: "8px 10px",
        backgroundColor: "var(--background-secondary)",
        color: "var(--text-primary)",
        border: "1px solid var(--border-primary)",
        borderRadius: "6px",
        fontSize: "14px",
        cursor: "pointer",
        marginLeft: "4px",
      },
    });

    const pastSearchesDropdown = ztoolkit.UI.createElement(doc, "div", {
      properties: { id: "past-searches-dropdown" },
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
        maxHeight: "350px",
        overflowY: "auto",
      },
    });

    // Close dropdown when clicking outside
    doc.addEventListener("click", (e: Event) => {
      if (
        !pastSearchesDropdown.contains(e.target as Node) &&
        e.target !== pastSearchesBtn
      ) {
        pastSearchesDropdown.style.display = "none";
      }
    });

    // Past Searches button click handler
    pastSearchesBtn.addEventListener("click", async () => {
      if (pastSearchesDropdown.style.display === "block") {
        pastSearchesDropdown.style.display = "none";
        return;
      }

      pastSearchesDropdown.innerHTML = "";
      const history = await getSearchHistory();

      if (history.length === 0) {
        const emptyMsg = ztoolkit.UI.createElement(doc, "div", {
          styles: {
            padding: "24px",
            textAlign: "center",
            color: "var(--text-secondary)",
            fontSize: "12px",
          },
        });
        emptyMsg.innerHTML =
          "📭 No past searches yet<br><br>Your search history will appear here after you perform searches.";
        pastSearchesDropdown.appendChild(emptyMsg);
      } else {
        // Header
        const header = ztoolkit.UI.createElement(doc, "div", {
          styles: {
            padding: "10px 12px",
            fontSize: "11px",
            fontWeight: "600",
            color: "var(--text-secondary)",
            borderBottom: "1px solid var(--border-primary)",
            backgroundColor: "var(--background-secondary)",
          },
        });
        header.innerHTML = `📜 ${history.length} Past Searches`;
        pastSearchesDropdown.appendChild(header);

        // History entries
        history.forEach((entry) => {
          const item = ztoolkit.UI.createElement(doc, "div", {
            styles: {
              padding: "10px 12px",
              borderBottom: "1px solid var(--border-primary)",
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              gap: "8px",
            },
          });

          // Entry content
          const content = ztoolkit.UI.createElement(doc, "div", {
            styles: { flex: "1", minWidth: "0" },
          });

          // Query (truncated)
          const queryEl = ztoolkit.UI.createElement(doc, "div", {
            styles: {
              fontSize: "12px",
              fontWeight: "500",
              color: "var(--text-primary)",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            },
          });
          queryEl.innerText =
            entry.query.length > 50
              ? entry.query.slice(0, 50) + "..."
              : entry.query;
          content.appendChild(queryEl);

          // Meta info
          const metaEl = ztoolkit.UI.createElement(doc, "div", {
            styles: {
              fontSize: "10px",
              color: "var(--text-secondary)",
              marginTop: "2px",
            },
          });
          const savedDate = new Date(entry.savedAt);
          const dateStr = this.formatRelativeTime(savedDate);
          metaEl.innerText = `${entry.results.length} results • ${dateStr}`;
          content.appendChild(metaEl);

          item.appendChild(content);

          // Delete button
          const deleteBtn = ztoolkit.UI.createElement(doc, "button", {
            properties: { innerText: "🗑️", title: "Delete this search" },
            styles: {
              padding: "4px 6px",
              backgroundColor: "transparent",
              color: "var(--text-secondary)",
              border: "none",
              borderRadius: "4px",
              fontSize: "12px",
              cursor: "pointer",
              opacity: "0.6",
            },
          });
          deleteBtn.addEventListener("mouseenter", () => {
            deleteBtn.style.opacity = "1";
            deleteBtn.style.backgroundColor = "#ffebee";
          });
          deleteBtn.addEventListener("mouseleave", () => {
            deleteBtn.style.opacity = "0.6";
            deleteBtn.style.backgroundColor = "transparent";
          });
          deleteBtn.addEventListener("click", async (e) => {
            e.stopPropagation();
            await deleteSearchHistoryEntry(entry.id);
            item.remove();
            // Update header count
            const newHistory = await getSearchHistory();
            if (newHistory.length === 0) {
              pastSearchesDropdown.innerHTML = "";
              const emptyMsg = ztoolkit.UI.createElement(doc, "div", {
                styles: {
                  padding: "24px",
                  textAlign: "center",
                  color: "var(--text-secondary)",
                  fontSize: "12px",
                },
              });
              emptyMsg.innerHTML = "📭 No past searches";
              pastSearchesDropdown.appendChild(emptyMsg);
            } else {
              const headerEl =
                pastSearchesDropdown.querySelector("div:first-child");
              if (headerEl)
                headerEl.innerHTML = `📜 ${newHistory.length} Past Searches`;
            }
          });
          item.appendChild(deleteBtn);

          // Click to restore
          item.addEventListener("mouseenter", () => {
            item.style.backgroundColor = "var(--background-secondary)";
          });
          item.addEventListener("mouseleave", () => {
            item.style.backgroundColor = "transparent";
          });
          item.addEventListener("click", () => {
            this.restoreSearchFromHistory(entry, doc, searchInput);
            pastSearchesDropdown.style.display = "none";
          });

          pastSearchesDropdown.appendChild(item);
        });
      }

      pastSearchesDropdown.style.display = "block";
    });

    // Make input container relative for dropdown positioning
    searchInputContainer.style.position = "relative";
    searchInputContainer.appendChild(searchInput);
    searchInputContainer.appendChild(suggestionsBtn);
    searchInputContainer.appendChild(aiRefineBtn);
    searchInputContainer.appendChild(pastSearchesBtn);
    searchInputContainer.appendChild(syntaxHelp);
    searchInputContainer.appendChild(searchBtn);
    searchInputContainer.appendChild(suggestionsDropdown);
    searchInputContainer.appendChild(aiRefineDropdown);
    searchInputContainer.appendChild(pastSearchesDropdown);

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
        backgroundColor: "var(--background-primary)",
      },
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
        marginBottom: "4px",
      },
    });

    // Header (non-collapsible, always expanded)
    const header = ztoolkit.UI.createElement(doc, "div", {
      styles: {
        display: "none", // Hidden - no header needed
      },
    });

    // Filters body (always visible, compact)
    const filtersBody = ztoolkit.UI.createElement(doc, "div", {
      properties: { id: "search-filters-body" },
      styles: {
        display: "block",
        padding: "8px",
        backgroundColor: "var(--background-primary)",
      },
    });

    // === PRESET ROW ===
    const presetRow = ztoolkit.UI.createElement(doc, "div", {
      styles: {
        display: "flex",
        gap: "8px",
        alignItems: "center",
        marginBottom: "12px",
        paddingBottom: "12px",
        borderBottom: "1px solid var(--border-primary)",
      },
    });

    const presetLabel = ztoolkit.UI.createElement(doc, "span", {
      properties: { innerText: "📁 Presets:" },
      styles: {
        fontSize: "11px",
        fontWeight: "500",
        color: "var(--text-secondary)",
      },
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
        color: "var(--text-primary)",
      },
      listeners: [
        {
          type: "change",
          listener: () => {
            const selectedName = (presetSelect as HTMLSelectElement).value;
            if (!selectedName) return;

            const presets = getFilterPresets();
            const preset = presets.find((p) => p.name === selectedName);
            if (preset) {
              // Apply preset filters
              Object.assign(currentSearchState, preset.filters);
              // Re-render filters to show updated values
              const parent = container.parentElement;
              if (parent) {
                // Get references before removing
                const searchInputContainer = parent.querySelector(
                  "div[style*='position: relative']",
                );
                const resultsArea = parent.querySelector(
                  "#semantic-scholar-results",
                );

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
                const newSelect = newFilters.querySelector(
                  "#preset-select",
                ) as HTMLSelectElement;
                if (newSelect) newSelect.value = selectedName;
              }
            }
          },
        },
      ],
    }) as HTMLSelectElement;

    // Populate dropdown
    const defaultOpt = ztoolkit.UI.createElement(doc, "option", {
      attributes: { value: "" },
      properties: { innerText: "-- Select preset --" },
    });
    presetSelect.appendChild(defaultOpt);

    getFilterPresets().forEach((preset) => {
      const opt = ztoolkit.UI.createElement(doc, "option", {
        attributes: { value: preset.name },
        properties: { innerText: preset.name },
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
        fontWeight: "500",
      },
      listeners: [
        {
          type: "click",
          listener: () => {
            const name = getNextPresetName();
            addFilterPreset(name, currentSearchState);

            // Add new option to dropdown
            const newOpt = ztoolkit.UI.createElement(doc, "option", {
              attributes: { value: name },
              properties: { innerText: name },
            });
            presetSelect.appendChild(newOpt);
            presetSelect.value = name;

            Zotero.debug(`[seerai] Saved filter preset: ${name}`);
          },
        },
      ],
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
        cursor: "pointer",
      },
      listeners: [
        {
          type: "click",
          listener: () => {
            const selectedName = presetSelect.value;
            if (!selectedName) return;

            const newName = (doc.defaultView as Window).prompt(
              "Enter new preset name:",
              selectedName,
            );
            if (!newName || newName === selectedName) return;

            // Rename in storage
            const presets = getFilterPresets();
            const preset = presets.find((p) => p.name === selectedName);
            if (preset) {
              preset.name = newName;
              saveFilterPresets(presets);
            }

            // Update dropdown option
            const opt = presetSelect.querySelector(
              `option[value="${selectedName}"]`,
            ) as HTMLOptionElement;
            if (opt) {
              opt.value = newName;
              opt.textContent = newName;
            }
            presetSelect.value = newName;

            Zotero.debug(
              `[seerai] Renamed preset: ${selectedName} -> ${newName}`,
            );
          },
        },
      ],
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
        cursor: "pointer",
      },
      listeners: [
        {
          type: "click",
          listener: () => {
            const selectedName = presetSelect.value;
            if (!selectedName) return;

            deleteFilterPreset(selectedName);

            // Remove option from dropdown
            const opt = presetSelect.querySelector(
              `option[value="${selectedName}"]`,
            );
            if (opt) opt.remove();
            presetSelect.value = "";

            Zotero.debug(`[seerai] Deleted filter preset: ${selectedName}`);
          },
        },
      ],
    });
    presetRow.appendChild(deleteBtn);

    // Toggle button for advanced filters
    const toggleBtn = ztoolkit.UI.createElement(doc, "button", {
      properties: { innerText: "⚙️ Advanced" },
      attributes: { title: "Show/hide advanced filters" },
      styles: {
        padding: "4px 10px",
        border: "1px solid var(--border-primary)",
        borderRadius: "4px",
        fontSize: "11px",
        backgroundColor: "var(--background-secondary)",
        color: "var(--text-primary)",
        cursor: "pointer",
        marginLeft: "4px",
        display: "flex",
        alignItems: "center",
        gap: "4px",
      },
    });
    presetRow.appendChild(toggleBtn);

    filtersBody.appendChild(presetRow);

    // Collapsible container for advanced filters
    const advancedFiltersContainer = ztoolkit.UI.createElement(doc, "div", {
      properties: { id: "advanced-search-filters" },
      styles: {
        display: "none", // Hidden by default
        borderTop: "1px solid var(--border-primary)",
        marginTop: "8px",
        paddingTop: "8px",
      },
    });

    toggleBtn.addEventListener("click", () => {
      const isHidden = advancedFiltersContainer.style.display === "none";
      advancedFiltersContainer.style.display = isHidden ? "block" : "none";
      toggleBtn.style.backgroundColor = isHidden
        ? "var(--highlight-primary)"
        : "var(--background-secondary)";
      toggleBtn.style.color = isHidden
        ? "var(--highlight-text)"
        : "var(--text-primary)";
    });

    const gridStyle = {
      display: "grid",
      gridTemplateColumns: "1fr 1fr",
      gap: "6px",
      marginBottom: "6px",
    };

    const labelStyle = {
      fontSize: "10px",
      fontWeight: "500",
      color: "var(--text-secondary)",
      marginBottom: "2px",
      display: "block",
    };

    const inputStyle = {
      width: "100%",
      padding: "6px 10px",
      border: "1px solid var(--border-primary)",
      borderRadius: "4px",
      fontSize: "12px",
      backgroundColor: "var(--background-primary)",
      color: "var(--text-primary)",
      boxSizing: "border-box" as const,
    };

    // Row 1: Results limit + Year range
    const row1 = ztoolkit.UI.createElement(doc, "div", { styles: gridStyle });

    // Results per page (slider)
    const limitGroup = ztoolkit.UI.createElement(doc, "div", {});
    const limitLabel = ztoolkit.UI.createElement(doc, "label", {
      properties: {
        innerText: `Results per page: ${currentSearchState.limit}`,
      },
      styles: labelStyle,
    });
    const limitSlider = ztoolkit.UI.createElement(doc, "input", {
      attributes: {
        type: "range",
        min: "10",
        max: "100",
        step: "10",
        value: String(currentSearchState.limit),
      },
      styles: { ...inputStyle, padding: "0", cursor: "pointer" },
      listeners: [
        {
          type: "input",
          listener: (e: Event) => {
            const target = e.target as HTMLInputElement;
            currentSearchState.limit = parseInt(target.value, 10);
            limitLabel.innerText = `Results per page: ${currentSearchState.limit}`;
          },
        },
      ],
    }) as HTMLInputElement;
    limitGroup.appendChild(limitLabel);
    limitGroup.appendChild(limitSlider);
    row1.appendChild(limitGroup);

    // Year range
    const yearGroup = ztoolkit.UI.createElement(doc, "div", {});
    const yearLabel = ztoolkit.UI.createElement(doc, "label", {
      properties: { innerText: "Year range" },
      styles: labelStyle,
    });
    const yearInputs = ztoolkit.UI.createElement(doc, "div", {
      styles: { display: "flex", gap: "4px", alignItems: "center" },
    });
    const yearStart = ztoolkit.UI.createElement(doc, "input", {
      attributes: {
        type: "number",
        placeholder: "From",
        min: "1900",
        max: "2030",
        value: currentSearchState.yearStart || "",
      },
      styles: { ...inputStyle, width: "70px" },
      listeners: [
        {
          type: "change",
          listener: (e: Event) => {
            currentSearchState.yearStart = (e.target as HTMLInputElement).value;
          },
        },
      ],
    }) as HTMLInputElement;
    const yearDash = ztoolkit.UI.createElement(doc, "span", {
      properties: { innerText: "-" },
      styles: { color: "var(--text-secondary)" },
    });
    const yearEnd = ztoolkit.UI.createElement(doc, "input", {
      attributes: {
        type: "number",
        placeholder: "To",
        min: "1900",
        max: "2030",
        value: currentSearchState.yearEnd || "",
      },
      styles: { ...inputStyle, width: "70px" },
      listeners: [
        {
          type: "change",
          listener: (e: Event) => {
            currentSearchState.yearEnd = (e.target as HTMLInputElement).value;
          },
        },
      ],
    }) as HTMLInputElement;
    yearInputs.appendChild(yearStart);
    yearInputs.appendChild(yearDash);
    yearInputs.appendChild(yearEnd);
    yearGroup.appendChild(yearLabel);
    yearGroup.appendChild(yearInputs);
    row1.appendChild(yearGroup);

    advancedFiltersContainer.appendChild(row1);

    // Row 2: Checkboxes (Has PDF, Hide Library Duplicates)
    const row2 = ztoolkit.UI.createElement(doc, "div", {
      styles: { display: "flex", gap: "16px", marginBottom: "12px" },
    });

    const hasPdfCheck = this.createFilterCheckbox(
      doc,
      "📄 Has PDF",
      currentSearchState.openAccessPdf,
      (val) => {
        currentSearchState.openAccessPdf = val;
      },
    );
    row2.appendChild(hasPdfCheck);

    const hideDupsCheck = this.createFilterCheckbox(
      doc,
      "🚫 Hide Library Duplicates",
      currentSearchState.hideLibraryDuplicates,
      (val) => {
        currentSearchState.hideLibraryDuplicates = val;
      },
    );
    row2.appendChild(hideDupsCheck);

    advancedFiltersContainer.appendChild(row2);

    // Row 3: Min Citations + Sort By
    const row3 = ztoolkit.UI.createElement(doc, "div", { styles: gridStyle });

    const minCitGroup = ztoolkit.UI.createElement(doc, "div", {});
    const minCitLabel = ztoolkit.UI.createElement(doc, "label", {
      properties: { innerText: "Min citations" },
      styles: labelStyle,
    });
    const minCitInput = ztoolkit.UI.createElement(doc, "input", {
      attributes: {
        type: "number",
        placeholder: "0",
        min: "0",
        value: String(currentSearchState.minCitationCount || ""),
      },
      styles: inputStyle,
      listeners: [
        {
          type: "change",
          listener: (e: Event) => {
            const val = parseInt((e.target as HTMLInputElement).value, 10);
            currentSearchState.minCitationCount = isNaN(val) ? undefined : val;
          },
        },
      ],
    }) as HTMLInputElement;
    minCitGroup.appendChild(minCitLabel);
    minCitGroup.appendChild(minCitInput);
    row3.appendChild(minCitGroup);

    const sortGroup = ztoolkit.UI.createElement(doc, "div", {});
    const sortLabel = ztoolkit.UI.createElement(doc, "label", {
      properties: { innerText: "Sort by" },
      styles: labelStyle,
    });
    const sortSelect = ztoolkit.UI.createElement(doc, "select", {
      styles: { ...inputStyle, appearance: "auto" as const },
      listeners: [
        {
          type: "change",
          listener: (e: Event) => {
            currentSearchState.sortBy = (e.target as HTMLSelectElement)
              .value as SearchState["sortBy"];
          },
        },
      ],
    }) as HTMLSelectElement;

    const sortOptions = [
      { value: "relevance", label: "Relevance" },
      { value: "citationCount:desc", label: "Most Cited" },
      { value: "publicationDate:desc", label: "Newest First" },
    ];
    sortOptions.forEach((opt) => {
      const option = ztoolkit.UI.createElement(doc, "option", {
        attributes: { value: opt.value },
        properties: { innerText: opt.label },
      }) as HTMLOptionElement;
      if (opt.value === currentSearchState.sortBy) option.selected = true;
      sortSelect.appendChild(option);
    });
    sortGroup.appendChild(sortLabel);
    sortGroup.appendChild(sortSelect);
    row3.appendChild(sortGroup);

    advancedFiltersContainer.appendChild(row3);

    // Row 4: Fields of Study multi-select
    const fosGroup = ztoolkit.UI.createElement(doc, "div", {
      styles: { marginBottom: "12px" },
    });
    const fosLabel = ztoolkit.UI.createElement(doc, "label", {
      properties: { innerText: "Fields of Study" },
      styles: labelStyle,
    });
    const fosContainer = ztoolkit.UI.createElement(doc, "div", {
      styles: { display: "flex", flexWrap: "wrap", gap: "4px" },
    });

    const commonFields = [
      "Computer Science",
      "Medicine",
      "Biology",
      "Physics",
      "Psychology",
      "Engineering",
    ];
    commonFields.forEach((field) => {
      const isSelected = currentSearchState.fieldsOfStudy.includes(field);
      const chip = ztoolkit.UI.createElement(doc, "span", {
        properties: {
          innerText: field,
          className: `fos-chip ${isSelected ? "selected" : ""}`,
        },
        styles: {
          padding: "4px 10px",
          borderRadius: "14px",
          fontSize: "10px",
          cursor: "pointer",
          backgroundColor: isSelected ? "#1976d2" : "transparent",
          color: isSelected ? "#ffffff" : "var(--text-primary)",
          border: isSelected ? "2px solid #1976d2" : "2px solid #888888",
          fontWeight: isSelected ? "600" : "400",
          transition: "all 0.15s ease",
        },
        listeners: [
          {
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
            },
          },
        ],
      });
      fosContainer.appendChild(chip);
    });

    fosGroup.appendChild(fosLabel);
    fosGroup.appendChild(fosContainer);
    advancedFiltersContainer.appendChild(fosGroup);

    // Row 5: Publication Types
    const pubTypeGroup = ztoolkit.UI.createElement(doc, "div", {
      styles: { marginBottom: "12px" },
    });
    const pubTypeLabel = ztoolkit.UI.createElement(doc, "label", {
      properties: { innerText: "Publication Types" },
      styles: labelStyle,
    });
    const pubTypeContainer = ztoolkit.UI.createElement(doc, "div", {
      styles: { display: "flex", flexWrap: "wrap", gap: "4px" },
    });

    const pubTypes = [
      "JournalArticle",
      "Conference",
      "Review",
      "Book",
      "Dataset",
      "ClinicalTrial",
      "MetaAnalysis",
      "Study",
    ];
    pubTypes.forEach((ptype) => {
      const isSelected = currentSearchState.publicationTypes.includes(ptype);
      const chip = ztoolkit.UI.createElement(doc, "span", {
        properties: { innerText: ptype.replace(/([A-Z])/g, " $1").trim() },
        styles: {
          padding: "4px 10px",
          borderRadius: "14px",
          fontSize: "10px",
          cursor: "pointer",
          backgroundColor: isSelected ? "#1976d2" : "transparent",
          color: isSelected ? "#ffffff" : "var(--text-primary)",
          border: isSelected ? "2px solid #1976d2" : "2px solid #888888",
          fontWeight: isSelected ? "600" : "400",
          transition: "all 0.15s ease",
        },
        listeners: [
          {
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
            },
          },
        ],
      });
      pubTypeContainer.appendChild(chip);
    });

    pubTypeGroup.appendChild(pubTypeLabel);
    pubTypeGroup.appendChild(pubTypeContainer);
    advancedFiltersContainer.appendChild(pubTypeGroup);

    // Row 6: Venue filter
    const venueGroup = ztoolkit.UI.createElement(doc, "div", {
      styles: { marginBottom: "8px" },
    });
    const venueLabel = ztoolkit.UI.createElement(doc, "label", {
      properties: { innerText: "Venue (e.g., Nature, Cell, ICML)" },
      styles: labelStyle,
    });
    const venueInput = ztoolkit.UI.createElement(doc, "input", {
      attributes: {
        type: "text",
        placeholder: "Comma-separated venues...",
        value: currentSearchState.venue || "",
      },
      styles: { ...inputStyle, width: "100%" },
      listeners: [
        {
          type: "change",
          listener: (e: Event) => {
            currentSearchState.venue =
              (e.target as HTMLInputElement).value || undefined;
          },
        },
      ],
    }) as HTMLInputElement;
    venueGroup.appendChild(venueLabel);
    venueGroup.appendChild(venueInput);
    advancedFiltersContainer.appendChild(venueGroup);

    // Row 7: Save Location dropdown
    const saveLocationGroup = ztoolkit.UI.createElement(doc, "div", {
      styles: {
        marginBottom: "8px",
        marginTop: "8px",
        paddingTop: "8px",
        borderTop: "1px solid var(--border-primary)",
      },
    });
    const saveLocationLabel = ztoolkit.UI.createElement(doc, "label", {
      properties: { innerText: "📥 Save imported papers to:" },
      styles: { ...labelStyle, fontWeight: "600" },
    });
    const saveLocationSelect = ztoolkit.UI.createElement(doc, "select", {
      properties: { id: "save-location-select" },
      styles: {
        ...inputStyle,
        width: "100%",
        appearance: "auto" as const,
        marginTop: "4px",
      },
      listeners: [
        {
          type: "change",
          listener: (e: Event) => {
            currentSearchState.saveLocation = (
              e.target as HTMLSelectElement
            ).value;
            Zotero.debug(
              `[seerai] Save location changed to: ${currentSearchState.saveLocation}`,
            );
          },
        },
      ],
    }) as HTMLSelectElement;

    // Populate save location dropdown with libraries and collections
    this.populateSaveLocationSelect(saveLocationSelect);

    saveLocationGroup.appendChild(saveLocationSelect);
    advancedFiltersContainer.appendChild(saveLocationGroup);

    // Row 8: AI Insights Section (Directly Visible)
    const insightsHeader = ztoolkit.UI.createElement(doc, "div", {
      styles: {
        marginTop: "12px",
        paddingTop: "12px",
        borderTop: "1px solid var(--border-primary)",
        marginBottom: "8px",
        fontSize: "11px",
        fontWeight: "600",
        color: "var(--text-primary)",
        display: "flex",
        alignItems: "center",
        gap: "6px",
      },
    });
    insightsHeader.innerHTML = "<span>💡</span><span>AI Insights Configuration</span>";
    advancedFiltersContainer.appendChild(insightsHeader);

    const insightsSection = ztoolkit.UI.createElement(doc, "div", {
      styles: {
        display: "flex",
        flexDirection: "column",
        gap: "8px",
        padding: "8px",
        backgroundColor: "var(--background-secondary)",
        borderRadius: "6px",
      },
    });

    // Auto Insights Toggle
    const autoInsightsToggle = this.createFilterCheckbox(
      doc,
      "Enable Auto AI Insights",
      Zotero.Prefs.get("extensions.seerai.searchAutoAiInsights") !== false,
      (val) => {
        Zotero.Prefs.set("extensions.seerai.searchAutoAiInsights", val);
      },
    );
    insightsSection.appendChild(autoInsightsToggle);

    // Prompt configuration
    const promptContainer = ztoolkit.UI.createElement(doc, "div", {
      styles: { display: "flex", flexDirection: "column", gap: "4px" },
    });
    const promptLabel = ztoolkit.UI.createElement(doc, "label", {
      properties: { innerText: "Synthesis System Prompt:" },
      styles: labelStyle,
    });
    const promptArea = ztoolkit.UI.createElement(doc, "textarea", {
      properties: {
        value:
          currentSearchState.searchAiInsightsPrompt ||
          (Zotero.Prefs.get("extensions.seerai.searchAiInsightsPrompt") as string),
        rows: 4,
      },
      styles: {
        ...inputStyle,
        width: "100%",
        minHeight: "80px",
        fontFamily: "inherit",
        resize: "both",
        boxSizing: "border-box",
      },
    }) as HTMLTextAreaElement;
    promptArea.addEventListener("change", () => {
      currentSearchState.searchAiInsightsPrompt = promptArea.value;
      Zotero.Prefs.set("extensions.seerai.searchAiInsightsPrompt", promptArea.value);
    });
    promptContainer.appendChild(promptLabel);
    promptContainer.appendChild(promptArea);
    insightsSection.appendChild(promptContainer);

    // Length configuration with slider
    const lengthGroup = ztoolkit.UI.createElement(doc, "div", {
      styles: { display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" },
    });
    const lengthLabel = ztoolkit.UI.createElement(doc, "label", {
      properties: { innerText: "Response length:" },
      styles: { ...labelStyle, marginBottom: "0" },
    });
    const currentLength = currentSearchState.searchAiInsightsResponseLength ||
      (Zotero.Prefs.get("extensions.seerai.searchAiInsightsResponseLength") as number) || 500;

    const lengthValue = ztoolkit.UI.createElement(doc, "span", {
      properties: { innerText: `${currentLength} chars` },
      styles: { fontSize: "11px", color: "var(--text-secondary)", minWidth: "70px" },
    });
    const lengthSlider = ztoolkit.UI.createElement(doc, "input", {
      attributes: {
        type: "range",
        min: "100",
        max: "2000",
        step: "100",
        value: String(currentLength),
      },
      styles: { flex: "1", minWidth: "100px", cursor: "pointer" },
    }) as HTMLInputElement;
    lengthSlider.addEventListener("input", () => {
      const val = parseInt(lengthSlider.value, 10);
      lengthValue.innerText = `${val} chars`;
    });
    lengthSlider.addEventListener("change", () => {
      const val = parseInt(lengthSlider.value, 10);
      currentSearchState.searchAiInsightsResponseLength = val;
      Zotero.Prefs.set("extensions.seerai.searchAiInsightsResponseLength", val);
    });

    lengthGroup.appendChild(lengthLabel);
    lengthGroup.appendChild(lengthSlider);
    lengthGroup.appendChild(lengthValue);
    insightsSection.appendChild(lengthGroup);

    advancedFiltersContainer.appendChild(insightsSection);

    filtersBody.appendChild(advancedFiltersContainer);

    container.appendChild(filtersBody);
    return container;
  }

  /**
   * Helper to create a filter checkbox
   */
  private static createFilterCheckbox(
    doc: Document,
    label: string,
    checked: boolean,
    onChange: (val: boolean) => void,
  ): HTMLElement {
    const container = ztoolkit.UI.createElement(doc, "label", {
      styles: {
        display: "flex",
        alignItems: "center",
        gap: "6px",
        fontSize: "12px",
        color: "var(--text-primary)",
        cursor: "pointer",
      },
    });

    const checkbox = ztoolkit.UI.createElement(doc, "input", {
      attributes: { type: "checkbox" },
      styles: { cursor: "pointer" },
      listeners: [
        {
          type: "change",
          listener: (e: Event) => {
            onChange((e.target as HTMLInputElement).checked);
          },
        },
      ],
    }) as HTMLInputElement;
    checkbox.checked = checked;

    const labelText = ztoolkit.UI.createElement(doc, "span", {
      properties: { innerText: label },
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
      // Clear cached AI insights for new query
      currentSearchState.cachedAiInsights = undefined;
      resultsArea.innerHTML = "";
      const loadingEl = ztoolkit.UI.createElement(doc, "div", {
        properties: { id: "initial-search-loading" },
        styles: {
          padding: "40px",
          textAlign: "center",
          color: "var(--text-secondary)",
        },
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
        fieldsOfStudy:
          currentSearchState.fieldsOfStudy.length > 0
            ? currentSearchState.fieldsOfStudy
            : undefined,
        publicationTypes:
          currentSearchState.publicationTypes.length > 0
            ? currentSearchState.publicationTypes
            : undefined,
        minCitationCount: currentSearchState.minCitationCount,
        venue: currentSearchState.venue,
      });

      Zotero.debug(`[seerai] Search response - total: ${result.total}, data length: ${result.data?.length ?? 'undefined'}`);

      // Defensive check: ensure result.data exists and is an array
      if (!result.data || !Array.isArray(result.data)) {
        Zotero.debug(`[seerai] Invalid search response - data is ${typeof result.data}`);
        throw new Error("Invalid search response from API - no results data");
      }

      // Capture total count from result
      if (currentSearchResults.length === 0) {
        totalSearchResults = result.total || 0;
      }

      // Filter library duplicates if enabled
      let papers = result.data;
      const papersBeforeFilter = papers.length;
      if (currentSearchState.hideLibraryDuplicates && papers.length > 0) {
        papers = await this.filterLibraryDuplicates(papers);
        const filtered = papersBeforeFilter - papers.length;
        if (filtered > 0) {
          Zotero.debug(`[seerai] Duplicate filter: ${papersBeforeFilter} → ${papers.length} (removed ${filtered} already in library)`);
        }
      }

      const previousCount = currentSearchResults.length;
      currentSearchResults = [...currentSearchResults, ...papers];

      // If this is a fresh search (previousCount === 0), render everything
      // Otherwise, just append the new cards
      if (previousCount === 0) {
        this.renderSearchResults(doc, resultsArea as HTMLElement, currentItem!);

        // Auto-save to search history (only for fresh searches with results)
        if (currentSearchResults.length > 0) {
          addSearchHistoryEntry({
            id: `search_${Date.now()}`,
            query: currentSearchState.query,
            state: { ...currentSearchState },
            results: [...currentSearchResults],
            totalResults: totalSearchResults,
            searchToken: currentSearchToken,
            savedAt: new Date().toISOString(),
          });
        }
      } else {
        // Append new cards without clearing existing content
        this.appendSearchCards(
          doc,
          resultsArea as HTMLElement,
          papers,
          currentItem!,
        );
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Search failed";
      Zotero.debug(`[seerai] Search error: ${error}`);

      if (isPagination) {
        // For pagination errors: only remove loading indicator and show inline error
        const loadingIndicator =
          resultsArea.querySelector("#show-more-loading");
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
            fontSize: "12px",
          },
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
            color: "var(--error-color, #d32f2f)",
          },
        });
        errorEl.innerHTML = `<div style="font-size: 24px; margin-bottom: 8px;">⚠️</div><div>${errorMessage}</div>`;
        resultsArea.appendChild(errorEl);
      }
    } finally {
      isSearching = false;
    }
  }

  /**
   * Filter out papers that already exist in any Zotero library (User or Group)
   */
  private static async filterLibraryDuplicates(
    papers: SemanticScholarPaper[],
  ): Promise<SemanticScholarPaper[]> {
    // Build lookup sets for DOI, PMID, and titles across ALL libraries
    const existingDOIs = new Set<string>();
    const existingPMIDs = new Set<string>();
    const existingTitles = new Set<string>();

    const libraries = Zotero.Libraries.getAll();

    for (const lib of libraries) {
      try {
        const libraryItems = await Zotero.Items.getAll(lib.libraryID);
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
      } catch (e) {
        Zotero.debug(
          `[seerai] Error checking duplicates in library ${lib.name}: ${e}`,
        );
      }
    }

    return papers.filter((paper) => {
      // Check DOI
      if (
        paper.externalIds?.DOI &&
        existingDOIs.has(paper.externalIds.DOI.toLowerCase())
      ) {
        return false;
      }
      // Check PMID
      if (
        paper.externalIds?.PMID &&
        existingPMIDs.has(paper.externalIds.PMID)
      ) {
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
  private static renderSearchResults(
    doc: Document,
    container: HTMLElement,
    item: Zotero.Item,
  ): void {
    container.innerHTML = "";

    if (currentSearchResults.length === 0 && !currentSearchState.query) {
      // Initial empty state
      const emptyState = ztoolkit.UI.createElement(doc, "div", {
        styles: {
          padding: "60px 20px",
          textAlign: "center",
          color: "var(--text-secondary)",
        },
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
          color: "var(--text-secondary)",
        },
      });
      noResults.innerHTML = `
                <div style="font-size: 32px; margin-bottom: 8px;">📭</div>
                <div>No papers found for "${currentSearchState.query}"</div>
            `;
      container.appendChild(noResults);
      return;
    }

    // Total count header with export button
    const countHeader = ztoolkit.UI.createElement(doc, "div", {
      styles: {
        padding: "8px 12px",
        backgroundColor: "var(--background-secondary)",
        borderBottom: "1px solid var(--border-primary)",
        fontSize: "12px",
        color: "var(--text-secondary)",
        fontWeight: "500",
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
      },
    });

    const countText = ztoolkit.UI.createElement(doc, "span", {});
    const filterNote = currentSearchState.hideLibraryDuplicates ? " (hiding library duplicates)" : "";
    countText.innerHTML = `📊 Found <strong>${totalSearchResults.toLocaleString()}</strong> papers • Showing ${currentSearchResults.length}${filterNote}`;
    countHeader.appendChild(countText);

    const headerButtons = ztoolkit.UI.createElement(doc, "div", {
      styles: { display: "flex", gap: "8px" },
    });


    // Export BibTeX button (Keep only this button in header)
    const exportBtn = ztoolkit.UI.createElement(doc, "button", {
      properties: { innerText: "📥 Export BibTeX" },
      styles: {
        padding: "4px 10px",
        fontSize: "11px",
        border: "1px solid var(--border-primary)",
        borderRadius: "4px",
        backgroundColor: "var(--background-primary)",
        color: "var(--text-primary)",
        cursor: "pointer",
      },
      listeners: [
        {
          type: "click",
          listener: async (e: Event) => {
            e.stopPropagation();
            const btn = e.target as HTMLButtonElement;
            const originalText = btn.textContent;
            btn.textContent = "⏳ Exporting...";
            btn.disabled = true;
            try {
              await this.exportResultsAsBibtex();
              btn.textContent = "✓ Exported!";
              setTimeout(() => {
                btn.textContent = originalText;
                btn.disabled = false;
              }, 2000);
            } catch (err) {
              btn.textContent = "⚠️ Failed";
              setTimeout(() => {
                btn.textContent = originalText;
                btn.disabled = false;
              }, 2000);
            }
          },
        },
      ],
    });
    headerButtons.appendChild(exportBtn);
    countHeader.appendChild(headerButtons);
    container.appendChild(countHeader);

    // AI Insights Container
    const summaryContainer = ztoolkit.UI.createElement(doc, "div", {
      properties: { id: "search-ai-summary-container" },
      styles: {
        display: "none",
        padding: "16px",
        margin: "12px",
        backgroundColor: "var(--background-primary)",
        border: "1px solid var(--border-primary)",
        borderRadius: "8px",
        boxShadow: "0 2px 8px rgba(0,0,0,0.05)",
        maxHeight: "350px",
        overflowY: "auto",
        position: "relative",
        userSelect: "text", // Make text selectable
        cursor: "text",
      },
    });
    container.appendChild(summaryContainer);

    // Render Unified Search Results (Table Layout with Card First Column)
    const wrapper = this.renderUnifiedSearchResults(doc, container, item);
    container.appendChild(wrapper);

    // Auto-generate AI insights if enabled in settings
    const autoInsights = Zotero.Prefs.get("extensions.seerai.searchAutoAiInsights") as boolean;

    // Check for cached insights first
    if (currentSearchState.cachedAiInsights) {
      // Display cached insights immediately
      this.displayCachedInsights(doc, currentSearchState.cachedAiInsights);
    } else if (autoInsights !== false) {
      // Run asynchronously without blocking the render
      this.generateSearchInsights(doc, container).catch((err) =>
        Zotero.debug(`[seerai] Auto AI insights error: ${err}`),
      );
    }
  }

  /**
   * Generate AI insights for current search results
   */
  private static async generateSearchInsights(
    doc: Document,
    container: HTMLElement,
  ): Promise<void> {
    const summaryContainer = doc.getElementById(
      "search-ai-summary-container",
    ) as HTMLElement;
    if (!summaryContainer) return;

    if (currentSearchResults.length === 0) {
      summaryContainer.style.display = "none";
      return;
    }

    // Show loading
    summaryContainer.style.display = "block";
    summaryContainer.innerHTML = `<div style="text-align: center; color: var(--text-secondary); padding: 20px;">⏳ Analyzing ${currentSearchResults.length} papers from results...</div>`;
    summaryContainer.scrollIntoView({ behavior: "smooth", block: "start" });

    try {
      const activeModel = getActiveModelConfig();
      if (!activeModel) {
        summaryContainer.innerHTML = `<div style="color: var(--error-color, #d32f2f); padding: 10px;">⚠️ No AI model configured. Please add a model in Settings.</div>`;
        return;
      }

      // Prepare context: limited to top N papers if there are too many to avoid token limits
      const topPapers = currentSearchResults.slice(0, 15);
      const context = topPapers
        .map((p, i) => {
          return `[${i + 1}] Title: ${p.title}\nAbstract: ${p.abstract || "No abstract available"}`;
        })
        .join("\n\n");

      const systemPrompt =
        currentSearchState.searchAiInsightsPrompt ||
        (Zotero.Prefs.get("extensions.seerai.searchAiInsightsPrompt") as string) ||
        `You are an expert research analyst specializing in academic literature synthesis. Your role is to provide rigorous, insightful analysis of research papers.

For the given search results:
1. **Research Landscape**: Identify the key research themes, methodological approaches, and theoretical frameworks
2. **Critical Analysis**: Highlight significant findings, notable gaps, and areas of consensus or controversy
3. **Connections**: Draw connections between papers using citation format [N] to reference specific works
4. **Implications**: Discuss practical implications and future research directions

Format in clean Markdown with clear headings. Be analytical and substantive, not just descriptive. When referencing papers, use [N] format so readers can click to navigate.`;

      const responseLength =
        currentSearchState.searchAiInsightsResponseLength ||
        (Zotero.Prefs.get("extensions.seerai.searchAiInsightsResponseLength") as number) ||
        500;

      const messages = [
        { role: "system" as const, content: systemPrompt },
        {
          role: "user" as const,
          content: `Analyze these ${topPapers.length} papers based on my search query "${currentSearchState.query}". Provide in-depth insights:\n\n${context}`,
        },
      ];

      let fullSummary = "";
      await openAIService.chatCompletionStream(
        messages,
        {
          onToken: (token) => {
            fullSummary += token;
            summaryContainer.innerHTML = `
                        <div style="font-weight: 600; margin-bottom: 12px; display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid var(--border-primary); padding-bottom: 8px;">
                            <div style="display: flex; align-items: center; gap: 6px;">
                                <span style="font-size: 16px;">💡</span>
                                <span>AI Insights Summary</span>
                            </div>
                            <span style="font-size: 11px; font-weight: 400; opacity: 0.6; font-style: italic;">AI is thinking...</span>
                        </div>
                        <div class="markdown-content" style="font-size: 13px; line-height: 1.6; color: var(--text-primary);">${parseMarkdown(fullSummary)}</div>
                    `;
          },
          onComplete: (content) => {
            fullSummary = content;
            // Cache the insights for persistence
            currentSearchState.cachedAiInsights = fullSummary;
            // Also update the persisted search history entry
            updateSearchHistoryWithInsights(
              currentSearchState.query,
              fullSummary,
            );
            summaryContainer.innerHTML = `
                        <div style="font-weight: 600; margin-bottom: 12px; display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid var(--border-primary); padding-bottom: 8px;">
                            <div style="display: flex; align-items: center; gap: 6px;">
                                <span style="font-size: 16px;">💡</span>
                                <span>AI Insights Summary</span>
                            </div>
                            <div style="display: flex; gap: 6px;">
                                <button id="copy-summary-btn" style="padding: 4px 10px; font-size: 11px; cursor: pointer; border-radius: 4px; border: 1px solid var(--border-primary); background: var(--background-primary); color: var(--text-primary); transition: all 0.2s;">📋 Copy</button>
                                <button id="close-summary-btn" style="padding: 4px 10px; font-size: 11px; cursor: pointer; border-radius: 4px; border: 1px solid var(--border-primary); background: var(--background-primary); color: var(--text-primary); transition: all 0.2s;">✕ Close</button>
                            </div>
                        </div>
                        <div class="markdown-content" style="font-size: 13px; line-height: 1.6; color: var(--text-primary);">${parseMarkdown(fullSummary)}</div>
                    `;

            // Hover effects for buttons
            const btns = [
              doc.getElementById("copy-summary-btn") as HTMLElement,
              doc.getElementById("close-summary-btn") as HTMLElement,
            ];
            btns.forEach((btn) => {
              if (btn) {
                btn.addEventListener("mouseenter", () => {
                  btn.style.backgroundColor = "var(--background-secondary)";
                });
                btn.addEventListener("mouseleave", () => {
                  btn.style.backgroundColor = "var(--background-primary)";
                });
              }
            });

            // Click listeners
            doc
              .getElementById("copy-summary-btn")
              ?.addEventListener("click", () => {
                new ztoolkit.Clipboard()
                  .addText(fullSummary, "text/unicode")
                  .copy();
                const btn = doc.getElementById(
                  "copy-summary-btn",
                ) as HTMLButtonElement;
                btn.innerText = "✓ Copied!";
                setTimeout(() => (btn.innerText = "📋 Copy"), 2000);
              });

            doc
              .getElementById("close-summary-btn")
              ?.addEventListener("click", () => {
                summaryContainer.style.display = "none";
              });

            // Attach click handlers to citation links for navigation
            this.attachCitationClickHandlers(doc, summaryContainer);

            // Append Follow-up Question UI
            this.createFollowUpUI(doc, summaryContainer);
          },
          onError: (error) => {
            Zotero.debug(`[seerai] Search insights error: ${error}`);
            summaryContainer.innerHTML = `<div style="color: var(--error-color, #d32f2f); padding: 10px;">⚠️ AI Error: ${error.message}</div>`;
          },
        },
        {
          apiURL: activeModel.apiURL,
          apiKey: activeModel.apiKey,
          model: activeModel.model,
        },
      );
    } catch (e) {
      Zotero.debug(`[seerai] Failed to generate insights: ${e}`);
      summaryContainer.innerHTML = `<div style="color: var(--error-color, #d32f2f); padding: 10px;">⚠️ Failed to generate insights: ${e}</div>`;
    }
  }

  /**
   * Display cached AI insights without regenerating
   */
  private static displayCachedInsights(doc: Document, cachedContent: string): void {
    const summaryContainer = doc.getElementById(
      "search-ai-summary-container",
    ) as HTMLElement;
    if (!summaryContainer) return;

    summaryContainer.style.display = "block";
    summaryContainer.innerHTML = `
      <div style="font-weight: 600; margin-bottom: 12px; display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid var(--border-primary); padding-bottom: 8px;">
        <div style="display: flex; align-items: center; gap: 6px;">
          <span style="font-size: 16px;">💡</span>
          <span>AI Insights Summary</span>
        </div>
        <div style="display: flex; gap: 6px;">
          <button id="copy-summary-btn" style="padding: 4px 10px; font-size: 11px; cursor: pointer; border-radius: 4px; border: 1px solid var(--border-primary); background: var(--background-primary); color: var(--text-primary); transition: all 0.2s;">📋 Copy</button>
          <button id="close-summary-btn" style="padding: 4px 10px; font-size: 11px; cursor: pointer; border-radius: 4px; border: 1px solid var(--border-primary); background: var(--background-primary); color: var(--text-primary); transition: all 0.2s;">✕ Close</button>
        </div>
      </div>
      <div class="markdown-content" style="font-size: 13px; line-height: 1.6; color: var(--text-primary);">${parseMarkdown(cachedContent)}</div>
    `;

    // Hover effects for buttons
    const btns = [
      doc.getElementById("copy-summary-btn") as HTMLElement,
      doc.getElementById("close-summary-btn") as HTMLElement,
    ];
    btns.forEach((btn) => {
      if (btn) {
        btn.addEventListener("mouseenter", () => {
          btn.style.backgroundColor = "var(--background-secondary)";
        });
        btn.addEventListener("mouseleave", () => {
          btn.style.backgroundColor = "var(--background-primary)";
        });
      }
    });

    // Click listeners
    doc
      .getElementById("copy-summary-btn")
      ?.addEventListener("click", () => {
        new ztoolkit.Clipboard()
          .addText(cachedContent, "text/unicode")
          .copy();
        const btn = doc.getElementById(
          "copy-summary-btn",
        ) as HTMLButtonElement;
        btn.innerText = "✓ Copied!";
        setTimeout(() => (btn.innerText = "📋 Copy"), 2000);
      });

    doc
      .getElementById("close-summary-btn")
      ?.addEventListener("click", () => {
        summaryContainer.style.display = "none";
      });

    // Attach click handlers to citation links for navigation
    this.attachCitationClickHandlers(doc, summaryContainer);

    // Append Follow-up Question UI
    this.createFollowUpUI(doc, summaryContainer);
  }

  /**
   * Create and append the Follow-up Question UI
   */
  private static createFollowUpUI(doc: Document, container: HTMLElement): void {
    const wrapper = ztoolkit.UI.createElement(doc, "div", {
      styles: {
        marginTop: "12px",
        paddingTop: "12px",
        borderTop: "1px solid var(--border-primary)",
      },
    });

    const inputContainer = ztoolkit.UI.createElement(doc, "div", {
      styles: {
        display: "flex",
        gap: "8px",
        marginTop: "8px",
      },
    });

    const input = ztoolkit.UI.createElement(doc, "input", {
      attributes: {
        type: "text",
        placeholder: "Ask a follow-up about these papers...",
      },
      styles: {
        flex: "1",
        padding: "8px 10px",
        borderRadius: "4px",
        border: "1px solid var(--border-primary)",
        fontSize: "12px",
        backgroundColor: "var(--background-secondary)",
        color: "var(--text-primary)",
      },
    }) as HTMLInputElement;

    const sendBtn = ztoolkit.UI.createElement(doc, "button", {
      properties: { innerText: "➤" },
      styles: {
        padding: "8px 12px",
        borderRadius: "4px",
        border: "none",
        backgroundColor: "var(--highlight-primary)",
        color: "var(--highlight-text)",
        cursor: "pointer",
        fontWeight: "bold",
      },
    });

    // Helper to submit
    const submit = async () => {
      const question = input.value.trim();
      if (!question) return;
      input.value = "";
      input.disabled = true;
      sendBtn.disabled = true;

      await this.handleFollowUpQuestion(doc, wrapper, question);

      input.disabled = false;
      sendBtn.disabled = false;
      input.focus();
    };

    sendBtn.addEventListener("click", submit);
    input.addEventListener("keypress", (e: Event) => {
      const ke = e as KeyboardEvent;
      if (ke.key === "Enter") submit();
    });

    inputContainer.appendChild(input);
    inputContainer.appendChild(sendBtn);
    wrapper.appendChild(inputContainer);
    container.appendChild(wrapper);
  }

  /**
   * Handle follow-up question submission
   */
  private static async handleFollowUpQuestion(
    doc: Document,
    container: HTMLElement,
    question: string
  ): Promise<void> {
    // create response area
    const responseArea = ztoolkit.UI.createElement(doc, "div", {
      styles: {
        marginTop: "12px",
        backgroundColor: "var(--background-secondary)",
        borderRadius: "6px",
        padding: "10px",
        fontSize: "13px",
        lineHeight: "1.5",
        color: "var(--text-primary)",
      },
    });

    // Insert before the input container (last child)
    container.insertBefore(responseArea, container.lastChild);

    responseArea.innerHTML = `
      <div style="font-weight: 600; margin-bottom: 4px; font-size: 11px; color: var(--text-secondary);">You asked: "${question}"</div>
      <div class="ai-answer">Thinking...</div>
    `;

    try {
      const activeModel = getActiveModelConfig();
      if (!activeModel) {
        responseArea.innerHTML += `<div style="color: var(--error-color);">⚠️ No AI model configured.</div>`;
        return;
      }

      // Gather context from ALL current results (including Show More loaded ones)
      // Limit to first 30 to prevent context overflow, or maybe token count
      // For now, take up to 25 papers
      const contextPapers = currentSearchResults.slice(0, 25);
      const context = contextPapers
        .map((p, i) => `[${i + 1}] Title: ${p.title}\nAbstract: ${p.abstract || "N/A"}`)
        .join("\n\n");

      const systemPrompt = `You are a helpful research assistant. Answer the user's question based ONLY on the provided research papers.
      Use [N] format to cite specific papers. Be concise and direct.`;

      const messages = [
        { role: "system" as const, content: systemPrompt },
        {
          role: "user" as const,
          content: `Context of ${contextPapers.length} papers:\n${context}\n\nQuestion: ${question}`,
        },
      ];

      let fullAnswer = "";
      const answerDiv = responseArea.querySelector(".ai-answer") as HTMLElement;

      await openAIService.chatCompletionStream(
        messages,
        {
          onToken: (token) => {
            fullAnswer += token;
            answerDiv.innerHTML = parseMarkdown(fullAnswer);
          },
          onComplete: (content) => {
            fullAnswer = content;
            answerDiv.innerHTML = parseMarkdown(fullAnswer);
            // Re-attach citation handlers for the new content
            this.attachCitationClickHandlers(doc, answerDiv);
          },
          onError: (error) => {
            answerDiv.innerHTML += `<div style="color: var(--error-color);">Error: ${error.message}</div>`;
          }
        },
        {
          apiURL: activeModel.apiURL,
          apiKey: activeModel.apiKey,
          model: activeModel.model,
        }
      );

    } catch (e) {
      Zotero.debug(`[seerai] Follow-up error: ${e}`);
      responseArea.innerHTML += `<div style="color: var(--error-color);">Failed to generate answer.</div>`;
    }
  }

  /**
   * Scroll to and highlight a search result row by its index
   * Used when clicking citation references in AI insights
   */
  private static scrollToSearchResult(doc: Document, index: number): void {
    const rows = doc.querySelectorAll("tbody tr");
    const targetRow = rows[index] as HTMLElement;
    if (!targetRow) {
      Zotero.debug(`[seerai] Citation link: Row ${index} not found`);
      return;
    }

    // Scroll into view
    targetRow.scrollIntoView({ behavior: "smooth", block: "center" });

    // Highlight effect
    const originalBg = targetRow.style.backgroundColor;
    targetRow.style.backgroundColor = "var(--highlight-primary, #fff9c4)";
    targetRow.style.transition = "background-color 0.5s ease-out";

    setTimeout(() => {
      targetRow.style.backgroundColor = originalBg;
    }, 2000);

    Zotero.debug(`[seerai] Citation link: Scrolled to paper at index ${index}`);
  }

  /**
   * Attach click and hover handlers to citation links in AI insights container
   */
  private static attachCitationClickHandlers(doc: Document, container: HTMLElement): void {
    const citationLinks = container.querySelectorAll(".citation-link");
    citationLinks.forEach((link: Element) => {
      const htmlLink = link as HTMLElement;
      const indicesStr = htmlLink.dataset.citationIndices;
      if (!indicesStr) return;

      const indices = indicesStr.split(',').map(s => parseInt(s.trim(), 10));

      // 1. Hover effect: Show titles
      const titles = indices.map(idx => {
        const paper = currentSearchResults[idx - 1];
        return paper ? `[${idx}] ${paper.title}` : `[${idx}] Paper not found`;
      }).join('\n');
      htmlLink.title = titles;

      // 2. Click handler
      link.addEventListener("click", (e: Event) => {
        e.stopPropagation();
        Zotero.debug(`[seerai] Citation clicked: ${indicesStr} (found ${indices.length} indices)`);
        if (indices.length === 1) {
          Assistant.scrollToSearchResult(doc, indices[0] - 1);
        } else {
          Assistant.showCitationMenu(doc, htmlLink, indices);
        }
      });
    });
  }

  /**
   * Show a "drop up" menu for multi-citations
   * Uses a backdrop pattern for better compatibility with Zotero/XUL
   */
  private static showCitationMenu(doc: Document, anchor: HTMLElement, indices: number[]): void {
    // Remove any existing menus
    const existingMenu = doc.getElementById("citation-menu-popover");
    if (existingMenu) existingMenu.remove();
    const existingBackdrop = doc.getElementById("citation-menu-backdrop");
    if (existingBackdrop) existingBackdrop.remove();

    // 1. Create Backdrop (for click-outside behavior)
    const backdrop = ztoolkit.UI.createElement(doc, "div", {
      properties: { id: "citation-menu-backdrop" },
      styles: {
        position: "fixed",
        top: "0",
        left: "0",
        right: "0",
        bottom: "0",
        zIndex: "9998", // Below menu
        backgroundColor: "transparent",
      },
      listeners: [
        {
          type: "click",
          listener: (e: Event) => {
            e.stopPropagation();
            backdrop.remove();
            const m = doc.getElementById("citation-menu-popover");
            if (m) m.remove();
          },
        },
      ],
    });

    // 2. Create Menu
    const menu = ztoolkit.UI.createElement(doc, "div", {
      properties: { id: "citation-menu-popover" },
      styles: {
        position: "fixed",
        backgroundColor: "var(--background-primary, #fff)",
        border: "1px solid var(--border-primary, #ccc)",
        borderRadius: "6px",
        boxShadow: "0 4px 12px rgba(0,0,0,0.2)",
        padding: "4px",
        zIndex: "10000",
        minWidth: "150px",
        maxWidth: "300px",
      },
      listeners: [
        { type: "click", listener: (e: Event) => e.stopPropagation() },
      ],
    });

    const header = ztoolkit.UI.createElement(doc, "div", {
      styles: {
        fontSize: "10px",
        fontWeight: "600",
        color: "var(--text-secondary, #666)",
        padding: "4px 8px",
        borderBottom: "1px solid var(--border-primary, #ccc)",
        marginBottom: "4px",
      },
    });
    header.innerText = "Select paper to view:";
    menu.appendChild(header);

    indices.forEach(idx => {
      const paper = currentSearchResults[idx - 1];
      if (!paper) return;

      const item = ztoolkit.UI.createElement(doc, "div", {
        styles: {
          padding: "6px 8px",
          fontSize: "12px",
          cursor: "pointer",
          borderRadius: "4px",
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
          color: "var(--text-primary, #000)",
        },
      });
      item.innerText = `[${idx}] ${paper.title}`;
      item.title = paper.title;

      item.addEventListener("mouseenter", () => {
        item.style.backgroundColor = "var(--background-secondary, #f5f5f5)";
      });
      item.addEventListener("mouseleave", () => {
        item.style.backgroundColor = "transparent";
      });
      item.addEventListener("click", (e) => {
        e.stopPropagation();
        Assistant.scrollToSearchResult(doc, idx - 1);
        menu.remove();
        backdrop.remove();
      });

      menu.appendChild(item);
    });

    // 3. Append to DOM (Fallback to documentElement for XUL)
    if (doc.body) {
      doc.body.appendChild(backdrop);
      doc.body.appendChild(menu);
    } else {
      doc.documentElement?.appendChild(backdrop);
      doc.documentElement?.appendChild(menu);
    }

    // 4. Position Logic
    const rect = anchor.getBoundingClientRect();
    const menuRect = menu.getBoundingClientRect();
    const view = doc.defaultView;
    if (!view) return;

    // Default: Position above
    let top = rect.top - menuRect.height - 8;

    // If not enough space above, flip to below
    if (top < 0) {
      top = rect.bottom + 8;
    }

    let left = rect.left;
    // Prevent going off-screen right
    if (left + menuRect.width > view.innerWidth) {
      left = view.innerWidth - menuRect.width - 8;
    }
    // Prevent going off-screen left
    if (left < 0) left = 8;

    menu.style.top = `${top}px`;
    menu.style.left = `${left}px`;
  }

  /**
   * Batch check Unpaywall for papers without PDFs
   * Updates badges in the DOM as results come in
   */
  private static async batchCheckUnpaywall(
    doc: Document,
    papers: SemanticScholarPaper[],
  ): Promise<void> {
    // Filter papers that need checking (no openAccessPdf but have DOI)
    const papersToCheck = papers.filter(
      (p) =>
        !p.openAccessPdf &&
        p.externalIds?.DOI &&
        !unpaywallPdfCache.has(p.paperId),
    );

    if (papersToCheck.length === 0) return;

    Zotero.debug(
      `[seerai] Batch checking Unpaywall for ${papersToCheck.length} papers`,
    );

    // Check in parallel (UnpaywallService handles batching internally)
    const dois = papersToCheck.map((p) => p.externalIds!.DOI!);
    const results = await unpaywallService.checkMultipleDois(dois);

    // Update cache and UI for each result
    papersToCheck.forEach((paper) => {
      const doi = paper.externalIds!.DOI!;
      const pdfUrl = results.get(doi.toLowerCase().trim());

      if (pdfUrl) {
        unpaywallPdfCache.set(paper.paperId, pdfUrl);
      }

      // Find and update the badge in the DOM
      // Cards are identified by paper title text content
      const cards = doc.querySelectorAll(".search-result-card");
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
   * Append new search result cards to the unified table
   */
  private static appendSearchCards(
    doc: Document,
    container: HTMLElement,
    newPapers: SemanticScholarPaper[],
    item: Zotero.Item,
  ): void {
    // Find and remove the loading indicator if present
    const loadingIndicator = container.querySelector("#show-more-loading");
    if (loadingIndicator) {
      loadingIndicator.remove();
    }

    // Find the table body in the container
    const tbody = container.querySelector("tbody");
    if (tbody) {
      newPapers.forEach((paper) => {
        const tr = this.createUnifiedResultRow(
          doc,
          paper,
          item,
          searchColumnConfig.columns,
        );
        tbody.appendChild(tr);
      });
    }

    // Re-append the "Show More" button at the bottom of the scrollable area
    // We look for the scrollable table container
    const tableContainer = container.querySelector(
      "div[style*='overflow: auto']",
    );
    if (tableContainer) {
      // Create new Show More button
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
          cursor: "pointer",
        },
        listeners: [
          {
            type: "click",
            listener: async () => {
              // Replace button with loading indicator
              const loadingDiv = ztoolkit.UI.createElement(doc, "div", {
                properties: { id: "show-more-loading" },
                styles: {
                  textAlign: "center",
                  padding: "16px",
                  color: "var(--text-secondary)",
                  fontSize: "12px",
                },
              });
              loadingDiv.innerHTML = "⏳ Loading more papers...";
              showMoreBtn.replaceWith(loadingDiv);

              await this.performSearch(doc);
            },
          },
        ],
      });
      tableContainer.appendChild(showMoreBtn);
    }
  }
  /**
   * Create a paper result card
   */
  private static createSearchResultCard(
    doc: Document,
    paper: SemanticScholarPaper,
    item: Zotero.Item,
    isTableCell: boolean = false,
  ): HTMLElement {
    const card = ztoolkit.UI.createElement(doc, "div", {
      properties: { className: "search-result-card" },
      styles: {
        padding: "12px",
        borderBottom: "1px solid var(--border-primary)",
        cursor: "pointer",
      },
    });

    // Header: Title + PDF indicator
    const header = ztoolkit.UI.createElement(doc, "div", {
      styles: {
        display: "flex",
        justifyContent: "space-between",
        alignItems: "flex-start",
        marginBottom: "6px",
      },
    });

    const title = ztoolkit.UI.createElement(doc, "div", {
      properties: { innerText: paper.title },
      styles: {
        fontSize: "13px",
        fontWeight: "600",
        color: "var(--text-primary)",
        flex: "1",
        lineHeight: "1.3",
        wordBreak: "break-word", // FORCE WORD BREAK
        minWidth: "0", // ALLOW SHRINKING
        cursor: "pointer",
      },
      listeners: [
        {
          type: "click",
          listener: (e: Event) => {
            e.stopPropagation();
            if (paper.url) {
              Zotero.launchURL(paper.url);
            }
          },
        },
      ],
    });
    // Add hover effect for title
    title.addEventListener("mouseenter", () => {
      title.style.textDecoration = "underline";
      title.style.color = "var(--highlight-primary)";
    });
    title.addEventListener("mouseleave", () => {
      title.style.textDecoration = "none";
      title.style.color = "var(--text-primary)";
    });
    header.appendChild(title);

    // PDF badge removed - PDF access available via action buttons below

    card.appendChild(header);

    // Meta: Authors (clickable), Year, Venue
    const meta = ztoolkit.UI.createElement(doc, "div", {
      styles: {
        fontSize: "11px",
        color: "var(--text-secondary)",
        marginBottom: "6px",
        display: "flex",
        flexWrap: "wrap",
        alignItems: "center",
        gap: "2px",
      },
    });

    // Clickable author links
    const displayedAuthors = paper.authors?.slice(0, 3) || [];
    displayedAuthors.forEach((author, idx) => {
      const authorLink = ztoolkit.UI.createElement(doc, "span", {
        properties: { innerText: author.name },
        styles: {
          color: "var(--highlight-primary)",
          cursor: "pointer",
          textDecoration: "underline",
        },
        listeners: [
          {
            type: "click",
            listener: async (e: Event) => {
              e.stopPropagation();
              await this.showAuthorModal(doc, author.authorId, author.name);
            },
          },
        ],
      });
      meta.appendChild(authorLink);
      if (idx < displayedAuthors.length - 1) {
        const comma = ztoolkit.UI.createElement(doc, "span", {
          properties: { innerText: ", " },
        });
        meta.appendChild(comma);
      }
    });

    if (paper.authors?.length > 3) {
      const more = ztoolkit.UI.createElement(doc, "span", {
        properties: { innerText: ` +${paper.authors.length - 3} more` },
      });
      meta.appendChild(more);
    }

    const yearVenue = paper.year ? ` • ${paper.year}` : "";
    const venueText = paper.venue
      ? ` • ${paper.venue.slice(0, 30)}${paper.venue.length > 30 ? "..." : ""}`
      : "";
    const extraMeta = ztoolkit.UI.createElement(doc, "span", {
      properties: { innerText: yearVenue + venueText },
    });
    meta.appendChild(extraMeta);
    card.appendChild(meta);

    // Citation count
    const citationBadge = ztoolkit.UI.createElement(doc, "div", {
      styles: {
        fontSize: "11px",
        color: "var(--text-secondary)",
        marginBottom: "6px",
      },
    });
    citationBadge.innerHTML = `📈 <strong>${paper.citationCount.toLocaleString()}</strong> citations`;
    card.appendChild(citationBadge);

    // Abstract preview (TLDR or truncated abstract)
    const abstractText = paper.tldr?.text || paper.abstract;
    if (abstractText) {
      const abstractEl = ztoolkit.UI.createElement(doc, "div", {
        properties: {
          innerText:
            abstractText.slice(0, 200) +
            (abstractText.length > 200 ? "..." : ""),
        },
        styles: {
          fontSize: "11px",
          color: "var(--text-secondary)",
          lineHeight: "1.4",
          marginBottom: "8px",
          wordBreak: "break-word",
          minWidth: "0",
        },
      });
      card.appendChild(abstractEl);
    }

    // Action buttons
    const actions = ztoolkit.UI.createElement(doc, "div", {
      styles: {
        display: "flex",
        gap: "8px",
        marginTop: "8px",
        flexWrap: "wrap", // Allow buttons to wrap
      },
    });

    const actionBtnStyle = {
      padding: "6px 10px",
      fontSize: "11px",
      border: "1px solid var(--border-primary)",
      borderRadius: "4px",
      backgroundColor: "var(--background-secondary)",
      color: "var(--text-primary)",
      cursor: "pointer",
    };

    // Add to Zotero button with full PDF discovery integration
    const addToZoteroBtn = ztoolkit.UI.createElement(doc, "button", {
      properties: { innerText: "➕ Add to Zotero" },
      styles: {
        ...actionBtnStyle,
        backgroundColor: "var(--highlight-primary)",
        color: "var(--highlight-text)",
        border: "none",
      },
      listeners: [
        {
          type: "click",
          listener: async (e: Event) => {
            e.stopPropagation();
            const btn = e.target as HTMLButtonElement;
            const originalText = btn.textContent;

            // Show importing status
            btn.textContent = "⬇️ Importing...";
            btn.disabled = true;
            btn.style.backgroundColor = "#e3f2fd";
            btn.style.color = "#1976d2";

            try {
              // Create the Zotero item with PDF discovery
              const result = await this.addPaperToZoteroWithPdfDiscovery(
                paper,
                btn,
              );

              if (result.item) {
                if (result.pdfAttached) {
                  // Show imported status with green styling when PDF attached
                  btn.textContent = "✅ Imported";
                  btn.style.backgroundColor = "#e8f5e9";
                  btn.style.color = "#2e7d32";
                } else if (result.sourceUrl) {
                  // No PDF but item created - show Source-Link option
                  btn.textContent = "🔗 Source-Link";
                  btn.style.backgroundColor = "#e8eaf6";
                  btn.style.color = "#3f51b5";
                  btn.disabled = false;
                  const createdItem = result.item; // Capture for use in nested handlers
                  btn.onclick = (clickEvent: Event) => {
                    clickEvent.stopPropagation();
                    if (result.sourceUrl) Zotero.launchURL(result.sourceUrl);
                    // After opening, replace button with Attach + Retry container
                    const container = doc.createElement("span");
                    container.style.display = "inline-flex";
                    container.style.gap = "6px";

                    // Attach button
                    const attachBtn = ztoolkit.UI.createElement(doc, "button", {
                      properties: { innerText: "⬇️ Attach" },
                      styles: {
                        padding: "4px 8px",
                        fontSize: "10px",
                        border: "1px solid var(--border-primary)",
                        borderRadius: "4px",
                        backgroundColor: "#e3f2fd",
                        color: "#1976d2",
                        cursor: "pointer",
                      },
                      listeners: [
                        {
                          type: "click",
                          listener: async (attachEvent: Event) => {
                            attachEvent.stopPropagation();
                            (
                              attachEvent.target as HTMLButtonElement
                            ).textContent = "📥 Attaching...";
                            (attachEvent.target as HTMLButtonElement).disabled =
                              true;
                            try {
                              // Use Zotero's file picker to attach a PDF
                              const fp = new (
                                Zotero.getMainWindow() as any
                              ).FilePicker();
                              fp.init(
                                Zotero.getMainWindow(),
                                "Select PDF to attach",
                                fp.modeOpen,
                              );
                              fp.appendFilter("PDF Files", "*.pdf");
                              const fpResult = await fp.show();
                              if (fpResult === fp.returnOK && fp.file) {
                                await Zotero.Attachments.importFromFile({
                                  file: fp.file,
                                  parentItemID: createdItem.id,
                                });
                                container.innerHTML = `<span style="color: #2e7d32; font-size: 11px;">✅ Imported</span>`;
                              } else {
                                (
                                  attachEvent.target as HTMLButtonElement
                                ).textContent = "⬇️ Attach";
                                (
                                  attachEvent.target as HTMLButtonElement
                                ).disabled = false;
                              }
                            } catch (err) {
                              Zotero.debug(`[seerai] Attach error: ${err}`);
                              (
                                attachEvent.target as HTMLButtonElement
                              ).textContent = "⬇️ Attach";
                              (
                                attachEvent.target as HTMLButtonElement
                              ).disabled = false;
                            }
                          },
                        },
                      ],
                    });

                    // Retry button
                    const retryBtn = ztoolkit.UI.createElement(doc, "button", {
                      properties: { innerText: "🔁 Retry" },
                      styles: {
                        padding: "4px 8px",
                        fontSize: "10px",
                        border: "1px solid var(--border-primary)",
                        borderRadius: "4px",
                        backgroundColor: "#fafafa",
                        color: "#757575",
                        cursor: "pointer",
                      },
                      listeners: [
                        {
                          type: "click",
                          listener: async (retryEvent: Event) => {
                            retryEvent.stopPropagation();
                            (
                              retryEvent.target as HTMLButtonElement
                            ).textContent = "⏳ Searching...";
                            (retryEvent.target as HTMLButtonElement).disabled =
                              true;
                            // Clear caches and retry PDF discovery
                            const zoteroCacheKey =
                              paper.externalIds?.DOI ||
                              paper.externalIds?.ArXiv ||
                              paper.externalIds?.PMID ||
                              paper.title?.slice(0, 50) ||
                              "";
                            if (zoteroCacheKey)
                              zoteroFindPdfCache.delete(zoteroCacheKey);
                            if (paper.externalIds?.DOI) {
                              unpaywallService.clearCacheForDoi(
                                paper.externalIds.DOI,
                              );
                            }
                            // Try to find and attach PDF again
                            try {
                              const pdfUrl = await this.tryFindPdfForItem(
                                paper,
                                createdItem,
                              );
                              if (pdfUrl) {
                                container.innerHTML = `<span style="color: #2e7d32; font-size: 11px;">✅ Imported</span>`;
                              } else {
                                (
                                  retryEvent.target as HTMLButtonElement
                                ).textContent = "🔁 Retry";
                                (
                                  retryEvent.target as HTMLButtonElement
                                ).disabled = false;
                              }
                            } catch (err) {
                              (
                                retryEvent.target as HTMLButtonElement
                              ).textContent = "🔁 Retry";
                              (
                                retryEvent.target as HTMLButtonElement
                              ).disabled = false;
                            }
                          },
                        },
                      ],
                    });

                    container.appendChild(attachBtn);
                    container.appendChild(retryBtn);
                    btn.replaceWith(container);
                  };
                } else {
                  // No PDF and no source URL - show retry
                  btn.textContent = "🔁 Retry";
                  btn.style.backgroundColor = "#fafafa";
                  btn.style.color = "#757575";
                  btn.disabled = false;
                }
              } else {
                btn.textContent = "⚠️ Failed";
                btn.style.backgroundColor = "#ffebee";
                btn.style.color = "#c62828";
                setTimeout(() => {
                  btn.textContent = originalText || "➕ Add to Zotero";
                  btn.style.backgroundColor = "var(--highlight-primary)";
                  btn.style.color = "var(--highlight-text)";
                  btn.disabled = false;
                }, 2000);
              }
            } catch (error) {
              Zotero.debug(`[seerai] Add to Zotero error: ${error}`);
              btn.textContent = "⚠️ Error";
              btn.style.backgroundColor = "#ffebee";
              btn.style.color = "#c62828";
              setTimeout(() => {
                btn.textContent = originalText || "➕ Add to Zotero";
                btn.style.backgroundColor = "var(--highlight-primary)";
                btn.style.color = "var(--highlight-text)";
                btn.disabled = false;
              }, 2000);
            }
          },
        },
      ],
    });
    actions.appendChild(addToZoteroBtn);

    // Add to Table button with full PDF discovery integration
    const addToTableBtn = ztoolkit.UI.createElement(doc, "button", {
      properties: { innerText: "📊 Add to Table" },
      styles: actionBtnStyle,
      listeners: [
        {
          type: "click",
          listener: async (e: Event) => {
            e.stopPropagation();
            const btn = e.target as HTMLButtonElement;
            const originalText = btn.textContent;

            // Show importing status immediately
            btn.textContent = "⬇️ Importing...";
            btn.disabled = true;
            btn.style.backgroundColor = "#e3f2fd";
            btn.style.color = "#1976d2";

            try {
              const result = await this.addPaperToZoteroWithPdfDiscovery(
                paper,
                btn,
              );
              if (result.item && currentTableConfig) {
                if (
                  !currentTableConfig.addedPaperIds.includes(result.item.id)
                ) {
                  currentTableConfig.addedPaperIds.push(result.item.id);
                  const tableStore = getTableStore();
                  await tableStore.saveConfig(currentTableConfig);
                }
              }

              if (result.item) {
                if (result.pdfAttached) {
                  // Show imported status with green styling when PDF attached
                  btn.textContent = "✅ Imported";
                  btn.style.backgroundColor = "#e8f5e9";
                  btn.style.color = "#2e7d32";
                } else if (result.sourceUrl) {
                  // No PDF but item created - show Source-Link option
                  btn.textContent = "🔗 Source-Link";
                  btn.style.backgroundColor = "#e8eaf6";
                  btn.style.color = "#3f51b5";
                  btn.disabled = false;
                  const createdItem = result.item; // Capture for use in nested handlers
                  btn.onclick = (clickEvent: Event) => {
                    clickEvent.stopPropagation();
                    if (result.sourceUrl) Zotero.launchURL(result.sourceUrl);
                    // After opening, replace button with Attach + Retry container
                    const container = doc.createElement("span");
                    container.style.display = "inline-flex";
                    container.style.gap = "6px";

                    // Attach button
                    const attachBtn = ztoolkit.UI.createElement(doc, "button", {
                      properties: { innerText: "⬇️ Attach" },
                      styles: {
                        padding: "4px 8px",
                        fontSize: "10px",
                        border: "1px solid var(--border-primary)",
                        borderRadius: "4px",
                        backgroundColor: "#e3f2fd",
                        color: "#1976d2",
                        cursor: "pointer",
                      },
                      listeners: [
                        {
                          type: "click",
                          listener: async (attachEvent: Event) => {
                            attachEvent.stopPropagation();
                            (
                              attachEvent.target as HTMLButtonElement
                            ).textContent = "📥 Attaching...";
                            (attachEvent.target as HTMLButtonElement).disabled =
                              true;
                            try {
                              const fp = new (
                                Zotero.getMainWindow() as any
                              ).FilePicker();
                              fp.init(
                                Zotero.getMainWindow(),
                                "Select PDF to attach",
                                fp.modeOpen,
                              );
                              fp.appendFilter("PDF Files", "*.pdf");
                              const fpResult = await fp.show();
                              if (fpResult === fp.returnOK && fp.file) {
                                await Zotero.Attachments.importFromFile({
                                  file: fp.file,
                                  parentItemID: createdItem.id,
                                });
                                container.innerHTML = `<span style="color: #2e7d32; font-size: 11px;">✅ Imported</span>`;
                              } else {
                                (
                                  attachEvent.target as HTMLButtonElement
                                ).textContent = "⬇️ Attach";
                                (
                                  attachEvent.target as HTMLButtonElement
                                ).disabled = false;
                              }
                            } catch (err) {
                              Zotero.debug(`[seerai] Attach error: ${err}`);
                              (
                                attachEvent.target as HTMLButtonElement
                              ).textContent = "⬇️ Attach";
                              (
                                attachEvent.target as HTMLButtonElement
                              ).disabled = false;
                            }
                          },
                        },
                      ],
                    });

                    // Retry button
                    const retryBtn = ztoolkit.UI.createElement(doc, "button", {
                      properties: { innerText: "🔁 Retry" },
                      styles: {
                        padding: "4px 8px",
                        fontSize: "10px",
                        border: "1px solid var(--border-primary)",
                        borderRadius: "4px",
                        backgroundColor: "#fafafa",
                        color: "#757575",
                        cursor: "pointer",
                      },
                      listeners: [
                        {
                          type: "click",
                          listener: async (retryEvent: Event) => {
                            retryEvent.stopPropagation();
                            (
                              retryEvent.target as HTMLButtonElement
                            ).textContent = "⏳ Searching...";
                            (retryEvent.target as HTMLButtonElement).disabled =
                              true;
                            const zoteroCacheKey =
                              paper.externalIds?.DOI ||
                              paper.externalIds?.ArXiv ||
                              paper.externalIds?.PMID ||
                              paper.title?.slice(0, 50) ||
                              "";
                            if (zoteroCacheKey)
                              zoteroFindPdfCache.delete(zoteroCacheKey);
                            if (paper.externalIds?.DOI) {
                              unpaywallService.clearCacheForDoi(
                                paper.externalIds.DOI,
                              );
                            }
                            try {
                              const pdfUrl = await this.tryFindPdfForItem(
                                paper,
                                createdItem,
                              );
                              if (pdfUrl) {
                                container.innerHTML = `<span style="color: #2e7d32; font-size: 11px;">✅ Imported</span>`;
                              } else {
                                (
                                  retryEvent.target as HTMLButtonElement
                                ).textContent = "🔁 Retry";
                                (
                                  retryEvent.target as HTMLButtonElement
                                ).disabled = false;
                              }
                            } catch (err) {
                              (
                                retryEvent.target as HTMLButtonElement
                              ).textContent = "🔁 Retry";
                              (
                                retryEvent.target as HTMLButtonElement
                              ).disabled = false;
                            }
                          },
                        },
                      ],
                    });

                    container.appendChild(attachBtn);
                    container.appendChild(retryBtn);
                    btn.replaceWith(container);
                  };
                } else {
                  // No PDF and no source URL - show retry
                  btn.textContent = "🔁 Retry";
                  btn.style.backgroundColor = "#fafafa";
                  btn.style.color = "#757575";
                  btn.disabled = false;
                }
              } else {
                btn.textContent = "⚠️ Failed";
                btn.style.backgroundColor = "#ffebee";
                btn.style.color = "#c62828";
                setTimeout(() => {
                  btn.textContent = originalText || "📊 Add to Table";
                  btn.style.backgroundColor = "var(--background-secondary)";
                  btn.style.color = "var(--text-primary)";
                  btn.disabled = false;
                }, 2000);
              }
            } catch (error) {
              Zotero.debug(`[seerai] Add to Table error: ${error}`);
              btn.textContent = "⚠️ Error";
              btn.style.backgroundColor = "#ffebee";
              btn.style.color = "#c62828";
              setTimeout(() => {
                btn.textContent = originalText || "📊 Add to Table";
                btn.style.backgroundColor = "var(--background-secondary)";
                btn.style.color = "var(--text-primary)";
                btn.disabled = false;
              }, 2000);
            }
          },
        },
      ],
    });
    actions.appendChild(addToTableBtn);

    // Open in browser button
    const openBtn = ztoolkit.UI.createElement(doc, "button", {
      properties: { innerText: "🔗 Open" },
      styles: actionBtnStyle,
      listeners: [
        {
          type: "click",
          listener: (e: Event) => {
            e.stopPropagation();
            Zotero.launchURL(paper.url);
          },
        },
      ],
    });
    actions.appendChild(openBtn);

    // PDF Download button (only if open access PDF available)
    if (paper.openAccessPdf?.url) {
      const pdfBtn = ztoolkit.UI.createElement(doc, "button", {
        properties: { innerText: "🔗 PDF" },
        styles: {
          ...actionBtnStyle,
          backgroundColor: "#e3f2fd",
          color: "#1976d2",
          border: "1px solid #90caf9",
        },
        listeners: [
          {
            type: "click",
            listener: (e: Event) => {
              e.stopPropagation();
              Zotero.launchURL(paper.openAccessPdf!.url);
            },
          },
        ],
      });
      actions.appendChild(pdfBtn);
    } else {
      // No Semantic Scholar PDF - create PDF Discovery button with state-based handling
      Zotero.debug(
        `[seerai] Creating PDF discovery button for paper: ${paper.title.slice(0, 50)}...`,
      );

      // State to track what the button should do when clicked
      let buttonState:
        | "initial"
        | "searching"
        | "retry"
        | "pdf"
        | "page"
        | "source" = "initial";
      let pdfUrl: string | null = null;
      let pageUrl: string | null = null;
      let sourceUrl: string | null = null;

      const pdfDiscoveryBtn = ztoolkit.UI.createElement(doc, "button", {
        properties: { innerText: "🔍 Find PDF" },
        styles: {
          ...actionBtnStyle,
          backgroundColor: "#e3f2fd",
          color: "#1976d2",
          border: "1px solid #90caf9",
        },
        listeners: [
          {
            type: "click",
            listener: (e: Event) => {
              e.stopPropagation();
              Zotero.debug(`[seerai] Button clicked, state: ${buttonState}`);

              if (buttonState === "initial") {
                runPdfDiscovery();
              } else if (buttonState === "pdf" && pdfUrl) {
                Zotero.launchURL(pdfUrl);
              } else if (buttonState === "page" && pageUrl) {
                Zotero.launchURL(pageUrl);
              } else if (buttonState === "source" && sourceUrl) {
                // Open source link in browser
                Zotero.launchURL(sourceUrl);
                // Change to retry state after opening
                buttonState = "retry";
                pdfDiscoveryBtn.textContent = "🔁 Retry";
                pdfDiscoveryBtn.style.backgroundColor = "#fafafa";
                pdfDiscoveryBtn.style.color = "#757575";
                pdfDiscoveryBtn.style.border = "1px solid #e0e0e0";
              } else if (buttonState === "retry") {
                Zotero.debug(
                  `[seerai] Retry clicked for: ${paper.title.slice(0, 50)}...`,
                );
                // Clear caches for this paper so retry makes fresh API calls
                const zoteroCacheKey =
                  paper.externalIds?.DOI ||
                  paper.externalIds?.ArXiv ||
                  paper.externalIds?.PMID ||
                  paper.title?.slice(0, 50) ||
                  "";
                if (zoteroCacheKey) zoteroFindPdfCache.delete(zoteroCacheKey);
                if (paper.externalIds?.DOI) {
                  unpaywallService.clearCacheForDoi(paper.externalIds.DOI);
                }
                firecrawlService.clearPdfCacheForPaper(
                  paper.title,
                  paper.authors?.map((a) => a.name),
                  paper.externalIds?.DOI,
                );
                runPdfDiscovery();
              }
              // Do nothing if still searching
            },
          },
        ],
      });
      actions.appendChild(pdfDiscoveryBtn);

      // PDF discovery function that updates the button state and appearance
      const runPdfDiscovery = async () => {
        Zotero.debug(
          `[seerai] runPdfDiscovery started for: ${paper.title.slice(0, 50)}...`,
        );
        buttonState = "searching";
        pdfDiscoveryBtn.textContent = "📚 Zotero Lookup...";
        pdfDiscoveryBtn.style.backgroundColor = "#e3f2fd";
        pdfDiscoveryBtn.style.color = "#1976d2";
        pdfDiscoveryBtn.style.border = "1px solid #90caf9";
        pdfDiscoveryBtn.disabled = true;

        try {
          // Step 1: Try Zotero's Find Full Text resolver
          const zoteroResult = await findPdfViaZotero(
            paper.externalIds?.DOI,
            paper.externalIds?.ArXiv,
            paper.externalIds?.PMID,
            paper.title,
            paper.url,
          );
          if (zoteroResult) {
            Zotero.debug(`[seerai] Zotero found PDF: ${zoteroResult}`);
            buttonState = "pdf";
            pdfUrl = zoteroResult;
            pdfDiscoveryBtn.textContent = "📚 Zotero PDF";
            pdfDiscoveryBtn.style.backgroundColor = "#e8f5e9";
            pdfDiscoveryBtn.style.color = "#2e7d32";
            pdfDiscoveryBtn.style.border = "1px solid #a5d6a7";
            pdfDiscoveryBtn.disabled = false;
            return;
          }

          // Step 2: Try arXiv if ArXiv ID available (100% reliable)
          if (paper.externalIds?.ArXiv) {
            pdfDiscoveryBtn.textContent = "📄 arXiv...";
            const arxivResult = await findPdfViaArxiv(paper.externalIds.ArXiv);
            if (arxivResult) {
              Zotero.debug(`[seerai] arXiv found PDF: ${arxivResult}`);
              buttonState = "pdf";
              pdfUrl = arxivResult;
              pdfDiscoveryBtn.textContent = "📄 arXiv PDF";
              pdfDiscoveryBtn.style.backgroundColor = "#e8f5e9";
              pdfDiscoveryBtn.style.color = "#2e7d32";
              pdfDiscoveryBtn.style.border = "1px solid #a5d6a7";
              pdfDiscoveryBtn.disabled = false;
              return;
            }
          }

          // Step 3: Try PubMed Central if PMID available
          if (paper.externalIds?.PMID) {
            pdfDiscoveryBtn.textContent = "🏥 PMC...";
            const pmcResult = await findPdfViaPmc(paper.externalIds.PMID);
            if (pmcResult) {
              Zotero.debug(`[seerai] PMC found PDF: ${pmcResult}`);
              buttonState = "pdf";
              pdfUrl = pmcResult;
              pdfDiscoveryBtn.textContent = "🏥 PMC PDF";
              pdfDiscoveryBtn.style.backgroundColor = "#e8f5e9";
              pdfDiscoveryBtn.style.color = "#2e7d32";
              pdfDiscoveryBtn.style.border = "1px solid #a5d6a7";
              pdfDiscoveryBtn.disabled = false;
              return;
            }
          }

          // Step 4: Try bioRxiv/medRxiv if DOI starts with 10.1101
          if (paper.externalIds?.DOI?.startsWith("10.1101/")) {
            pdfDiscoveryBtn.textContent = "🧬 bioRxiv...";
            const biorxivResult = await findPdfViaBiorxiv(
              paper.externalIds.DOI,
            );
            if (biorxivResult) {
              Zotero.debug(`[seerai] bioRxiv found PDF: ${biorxivResult}`);
              buttonState = "pdf";
              pdfUrl = biorxivResult;
              pdfDiscoveryBtn.textContent = "🧬 bioRxiv PDF";
              pdfDiscoveryBtn.style.backgroundColor = "#e8f5e9";
              pdfDiscoveryBtn.style.color = "#2e7d32";
              pdfDiscoveryBtn.style.border = "1px solid #a5d6a7";
              pdfDiscoveryBtn.disabled = false;
              return;
            }
          }

          // Step 5: Try Unpaywall if DOI available
          if (paper.externalIds?.DOI) {
            pdfDiscoveryBtn.textContent = "🔍 Unpaywall...";
            Zotero.debug(
              `[seerai] Trying Unpaywall for DOI: ${paper.externalIds.DOI}`,
            );
            const unpaywallResult = await unpaywallService.getPdfUrl(
              paper.externalIds.DOI,
            );
            if (unpaywallResult) {
              Zotero.debug(`[seerai] Unpaywall found PDF: ${unpaywallResult}`);
              unpaywallPdfCache.set(paper.paperId, unpaywallResult);
              buttonState = "pdf";
              pdfUrl = unpaywallResult;
              pdfDiscoveryBtn.textContent = "📄 Unpaywall PDF";
              pdfDiscoveryBtn.style.backgroundColor = "#e8f5e9";
              pdfDiscoveryBtn.style.color = "#2e7d32";
              pdfDiscoveryBtn.style.border = "1px solid #a5d6a7";
              pdfDiscoveryBtn.disabled = false;
              return;
            }
          }

          // Step 6: Try Europe PMC as final fallback
          pdfDiscoveryBtn.textContent = "🇪🇺 EuropePMC...";
          const epmcResult = await findPdfViaEuropePmc(
            paper.externalIds?.DOI,
            paper.externalIds?.PMID,
          );
          if (epmcResult) {
            Zotero.debug(`[seerai] EuropePMC found PDF: ${epmcResult}`);
            buttonState = "pdf";
            pdfUrl = epmcResult;
            pdfDiscoveryBtn.textContent = "🇪🇺 EuropePMC PDF";
            pdfDiscoveryBtn.style.backgroundColor = "#e8f5e9";
            pdfDiscoveryBtn.style.color = "#2e7d32";
            pdfDiscoveryBtn.style.border = "1px solid #a5d6a7";
            pdfDiscoveryBtn.disabled = false;
            return;
          }

          // Step 7: Try Firecrawl if configured (commented out)
          /*
                              if (firecrawlService.isConfigured()) {
                                  Zotero.debug(`[seerai] Trying Firecrawl for: ${paper.title.slice(0, 50)}...`);
                                  pdfDiscoveryBtn.textContent = "🔥 Searching...";
                                  pdfDiscoveryBtn.style.backgroundColor = "#fff8e1";
                                  pdfDiscoveryBtn.style.color = "#ff8f00";
                                  pdfDiscoveryBtn.style.border = "1px solid #ffcc80";
          
                                  const firecrawlResult = await firecrawlService.searchForPdf(
                                      paper.title,
                                      paper.authors?.map(a => a.name),
                                      paper.externalIds?.DOI
                                  );
          
                                  Zotero.debug(`[seerai] Firecrawl result: ${JSON.stringify(firecrawlResult)}`);
          
                                  if (firecrawlResult.status === 'pdf_found' && firecrawlResult.pdfUrl) {
                                      firecrawlPdfCache.set(paper.paperId, firecrawlResult);
                                      buttonState = 'pdf';
                                      pdfUrl = firecrawlResult.pdfUrl;
                                      pdfDiscoveryBtn.textContent = "🔥 Fire PDF";
                                      pdfDiscoveryBtn.style.backgroundColor = "#fff3e0";
                                      pdfDiscoveryBtn.style.color = "#e65100";
                                      pdfDiscoveryBtn.style.border = "1px solid #ffcc80";
                                      pdfDiscoveryBtn.disabled = false;
                                      return;
                                  } else if (firecrawlResult.status === 'page_found' && firecrawlResult.pageUrl) {
                                      firecrawlPdfCache.set(paper.paperId, firecrawlResult);
                                      buttonState = 'page';
                                      pageUrl = firecrawlResult.pageUrl;
                                      pdfDiscoveryBtn.textContent = "🔗 Fire-page";
                                      pdfDiscoveryBtn.style.backgroundColor = "#e8eaf6";
                                      pdfDiscoveryBtn.style.color = "#3f51b5";
                                      pdfDiscoveryBtn.style.border = "1px solid #9fa8da";
                                      pdfDiscoveryBtn.disabled = false;
                                      return;
                                  }
                              }
                              */

          // Step 7: Show Source-Link if identifiers available, otherwise Retry
          Zotero.debug(`[seerai] All methods failed, checking for source link`);
          const sourceLink = getSourceLinkForPaper(
            paper.externalIds?.DOI,
            paper.externalIds?.ArXiv,
            paper.externalIds?.PMID,
            undefined,
            paper.url,
          );

          if (sourceLink) {
            buttonState = "source";
            sourceUrl = sourceLink;
            pdfDiscoveryBtn.textContent = "🔗 Source-Link";
            pdfDiscoveryBtn.style.backgroundColor = "#e8eaf6";
            pdfDiscoveryBtn.style.color = "#3f51b5";
            pdfDiscoveryBtn.style.border = "1px solid #9fa8da";
            pdfDiscoveryBtn.disabled = false;
          } else {
            buttonState = "retry";
            pdfDiscoveryBtn.textContent = "🔁 Retry";
            pdfDiscoveryBtn.style.backgroundColor = "#fafafa";
            pdfDiscoveryBtn.style.color = "#757575";
            pdfDiscoveryBtn.style.border = "1px solid #e0e0e0";
            pdfDiscoveryBtn.disabled = false;
          }
        } catch (error) {
          Zotero.debug(
            `[seerai] PDF discovery error for ${paper.paperId}: ${error}`,
          );
          buttonState = "retry";
          pdfDiscoveryBtn.textContent = "🔁 Retry";
          pdfDiscoveryBtn.style.backgroundColor = "#fafafa";
          pdfDiscoveryBtn.style.color = "#757575";
          pdfDiscoveryBtn.style.border = "1px solid #e0e0e0";
          pdfDiscoveryBtn.disabled = false;
        }
      };

      // Removed automatic discovery trigger to improve performance
      // Discovery is now initiated only by user click
    }

    // Find Similar button (recommendations)

    const similarBtn = ztoolkit.UI.createElement(doc, "button", {
      properties: { innerText: "🔮 Similar" },
      styles: actionBtnStyle,
      listeners: [
        {
          type: "click",
          listener: async (e: Event) => {
            e.stopPropagation();
            const btn = e.target as HTMLButtonElement;
            btn.textContent = "Loading...";
            btn.disabled = true;
            try {
              // Get recommendations based on this paper
              const recommendations =
                await semanticScholarService.getRecommendations([
                  paper.paperId,
                ]);
              if (recommendations.length > 0) {
                // Replace current results with recommendations
                currentSearchResults = recommendations;
                totalSearchResults = recommendations.length;
                currentSearchState.query = `Similar to: ${paper.title.slice(0, 50)}...`;
                const resultsArea = doc.getElementById(
                  "semantic-scholar-results",
                );
                if (resultsArea) {
                  this.renderSearchResults(
                    doc,
                    resultsArea as HTMLElement,
                    currentItem!,
                  );
                }
              } else {
                btn.textContent = "No similar";
              }
            } catch (error) {
              Zotero.debug(`[seerai] Recommendations error: ${error}`);
              btn.textContent = "Error";
            }
          },
        },
      ],
    });
    actions.appendChild(similarBtn);

    card.appendChild(actions);

    return card;
  }

  /**
   * Show author details modal
   */
  private static async showAuthorModal(
    doc: Document,
    authorId: string,
    authorName: string,
  ): Promise<void> {
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
        zIndex: "9999",
      },
      listeners: [
        {
          type: "click",
          listener: (e: Event) => {
            if (e.target === overlay) overlay.remove();
          },
        },
      ],
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
        boxShadow: "0 8px 32px rgba(0,0,0,0.3)",
      },
    });

    // Header
    const header = ztoolkit.UI.createElement(doc, "div", {
      styles: {
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        marginBottom: "12px",
      },
    });
    const title = ztoolkit.UI.createElement(doc, "h3", {
      properties: { innerText: `👤 ${authorName}` },
      styles: { margin: "0", fontSize: "14px", fontWeight: "600" },
    });
    const closeBtn = ztoolkit.UI.createElement(doc, "button", {
      properties: { innerText: "✕" },
      styles: {
        border: "none",
        background: "transparent",
        fontSize: "16px",
        cursor: "pointer",
      },
      listeners: [{ type: "click", listener: () => overlay.remove() }],
    });
    header.appendChild(title);
    header.appendChild(closeBtn);
    modal.appendChild(header);

    // Loading state
    const loadingEl = ztoolkit.UI.createElement(doc, "div", {
      properties: { innerText: "Loading author details..." },
      styles: { color: "var(--text-secondary)", fontSize: "12px" },
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
        styles: {
          display: "grid",
          gridTemplateColumns: "1fr 1fr 1fr",
          gap: "8px",
          marginBottom: "12px",
        },
      });

      const statItems = [
        { label: "h-Index", value: author.hIndex ?? "N/A" },
        {
          label: "Papers",
          value: author.paperCount?.toLocaleString() ?? "N/A",
        },
        {
          label: "Citations",
          value: author.citationCount?.toLocaleString() ?? "N/A",
        },
      ];

      statItems.forEach((stat) => {
        const statEl = ztoolkit.UI.createElement(doc, "div", {
          styles: {
            textAlign: "center",
            padding: "8px",
            backgroundColor: "var(--background-secondary)",
            borderRadius: "4px",
          },
        });
        statEl.innerHTML = `<div style="font-size: 16px; font-weight: 600;">${stat.value}</div><div style="font-size: 10px; color: var(--text-secondary);">${stat.label}</div>`;
        stats.appendChild(statEl);
      });
      modal.appendChild(stats);

      // Recent papers
      if (author.papers && author.papers.length > 0) {
        const papersLabel = ztoolkit.UI.createElement(doc, "div", {
          properties: { innerText: "📑 Recent Papers" },
          styles: { fontSize: "12px", fontWeight: "500", marginBottom: "8px" },
        });
        modal.appendChild(papersLabel);

        author.papers.slice(0, 5).forEach((paper) => {
          const paperEl = ztoolkit.UI.createElement(doc, "div", {
            properties: {
              innerText: `${paper.year ? `[${paper.year}] ` : ""}${paper.title}`,
            },
            styles: {
              fontSize: "11px",
              padding: "6px",
              marginBottom: "4px",
              backgroundColor: "var(--background-secondary)",
              borderRadius: "4px",
              cursor: "pointer",
            },
            listeners: [
              {
                type: "click",
                listener: () => {
                  Zotero.launchURL(
                    `https://www.semanticscholar.org/paper/${paper.paperId}`,
                  );
                },
              },
            ],
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
            cursor: "pointer",
          },
          listeners: [
            {
              type: "click",
              listener: () => Zotero.launchURL(author.url!),
            },
          ],
        });
        modal.appendChild(linkBtn);
      }
    } catch (error) {
      loadingEl.textContent = `Error: ${error instanceof Error ? error.message : "Failed to load"}`;
      Zotero.debug(`[seerai] Author modal error: ${error}`);
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
  private static async addPaperToZotero(
    paper: SemanticScholarPaper,
  ): Promise<Zotero.Item | null> {
    try {
      Zotero.debug(`[seerai] Adding paper to Zotero: ${paper.title}`);

      // Determine item type based on publication types
      type ZoteroItemType = "journalArticle" | "conferencePaper" | "book";
      let itemType: ZoteroItemType = "journalArticle";
      if (paper.publicationTypes) {
        if (paper.publicationTypes.includes("Conference")) {
          itemType = "conferencePaper";
        } else if (paper.publicationTypes.includes("Book")) {
          itemType = "book";
        }
      }

      // 1. Create the item
      const newItem = new Zotero.Item(itemType);

      // 2. Determine library ownership based on selected save location
      const saveLocation = currentSearchState.saveLocation || "user";
      let targetLibraryId = Zotero.Libraries.userLibraryID;
      let targetCollectionId: number | null = null;

      if (saveLocation === "user") {
        // Default: user library
        targetLibraryId = Zotero.Libraries.userLibraryID;
      } else if (saveLocation.startsWith("lib_")) {
        // Group library
        targetLibraryId = parseInt(saveLocation.replace("lib_", ""), 10);
      } else if (saveLocation.startsWith("col_")) {
        // Collection - need to find its library ID
        targetCollectionId = parseInt(saveLocation.replace("col_", ""), 10);
        try {
          const collection = Zotero.Collections.get(targetCollectionId);
          if (collection) {
            targetLibraryId = collection.libraryID;
          }
        } catch (e) {
          Zotero.debug(
            `[seerai] Error getting collection ${targetCollectionId}: ${e}`,
          );
        }
      }

      newItem.libraryID = targetLibraryId;

      // 3. Populate metadata fields
      newItem.setField("title", paper.title);

      if (paper.abstract) {
        newItem.setField("abstractNote", paper.abstract);
      }
      if (paper.year) {
        newItem.setField("date", String(paper.year));
      }
      if (paper.venue) {
        // Use appropriate field based on item type
        if (itemType === "conferencePaper") {
          newItem.setField("proceedingsTitle", paper.venue);
        } else {
          newItem.setField("publicationTitle", paper.venue);
        }
      }
      if (paper.externalIds?.DOI) {
        newItem.setField("DOI", paper.externalIds.DOI);
      }
      if (paper.url) {
        newItem.setField("url", paper.url);
      }

      // Add authors/creators
      if (paper.authors && paper.authors.length > 0) {
        const creators = paper.authors.slice(0, 20).map((author) => {
          const nameParts = author.name.trim().split(" ");
          const lastName = nameParts.pop() || author.name;
          const firstName = nameParts.join(" ");
          return {
            firstName,
            lastName,
            creatorType: "author" as const,
          };
        });
        newItem.setCreators(creators);
      }

      // 4. First save to generate item ID (required before collection assignment)
      await newItem.saveTx();
      Zotero.debug(
        `[seerai] Item saved with ID: ${newItem.id} to library ${targetLibraryId}`,
      );

      // 5. Add to collection if one was selected
      if (targetCollectionId !== null) {
        try {
          newItem.addToCollection(targetCollectionId);
          await newItem.saveTx(); // Second save to persist collection relationship
          Zotero.debug(
            `[seerai] Item added to collection ${targetCollectionId}`,
          );
        } catch (colError) {
          Zotero.debug(`[seerai] Error adding to collection: ${colError}`);
        }
      }

      // 6. Attach PDF if open access URL is available, otherwise try Find Full Text
      if (paper.openAccessPdf?.url) {
        try {
          Zotero.debug(
            `[seerai] Downloading PDF from: ${paper.openAccessPdf.url}`,
          );

          // Use Zotero's built-in attachment import from URL
          await Zotero.Attachments.importFromURL({
            url: paper.openAccessPdf.url,
            parentItemID: newItem.id,
            title: `${paper.title}.pdf`,
            contentType: "application/pdf",
          });

          Zotero.debug(`[seerai] PDF attached successfully`);
        } catch (pdfError) {
          // PDF download failure - try Find Full Text as fallback
          Zotero.debug(
            `[seerai] PDF download failed, trying Find Full Text: ${pdfError}`,
          );
          try {
            await (Zotero.Attachments as any).addAvailablePDF(newItem);
            Zotero.debug(`[seerai] Find Full Text initiated`);
          } catch (findError) {
            Zotero.debug(
              `[seerai] Find Full Text failed (non-fatal): ${findError}`,
            );
          }
        }
      } else {
        // No Semantic Scholar PDF - check Unpaywall cache first
        const cachedUnpaywallUrl = unpaywallPdfCache.get(paper.paperId);
        if (cachedUnpaywallUrl) {
          try {
            Zotero.debug(`[seerai] Using Unpaywall PDF: ${cachedUnpaywallUrl}`);
            await Zotero.Attachments.importFromURL({
              url: cachedUnpaywallUrl,
              parentItemID: newItem.id,
              title: `${paper.title}.pdf`,
              contentType: "application/pdf",
            });
            Zotero.debug(`[seerai] Unpaywall PDF attached successfully`);
          } catch (pdfError) {
            // Unpaywall download failed - try Find Full Text
            Zotero.debug(
              `[seerai] Unpaywall PDF download failed, trying Find Full Text: ${pdfError}`,
            );
            try {
              await (Zotero.Attachments as any).addAvailablePDF(newItem);
              Zotero.debug(`[seerai] Find Full Text initiated`);
            } catch (findError) {
              Zotero.debug(
                `[seerai] Find Full Text failed (non-fatal): ${findError}`,
              );
            }
          }
        } else {
          // No cached Unpaywall PDF - check Firecrawl cache
          const cachedFirecrawlResult = firecrawlPdfCache.get(paper.paperId);
          if (cachedFirecrawlResult?.pdfUrl) {
            try {
              Zotero.debug(
                `[seerai] Using Firecrawl PDF: ${cachedFirecrawlResult.pdfUrl}`,
              );
              await Zotero.Attachments.importFromURL({
                url: cachedFirecrawlResult.pdfUrl,
                parentItemID: newItem.id,
                title: `${paper.title}.pdf`,
                contentType: "application/pdf",
              });
              Zotero.debug(`[seerai] Firecrawl PDF attached successfully`);
            } catch (pdfError) {
              // Firecrawl download failed - try Find Full Text
              Zotero.debug(
                `[seerai] Firecrawl PDF download failed, trying Find Full Text: ${pdfError}`,
              );
              try {
                await (Zotero.Attachments as any).addAvailablePDF(newItem);
                Zotero.debug(`[seerai] Find Full Text initiated`);
              } catch (findError) {
                Zotero.debug(
                  `[seerai] Find Full Text failed (non-fatal): ${findError}`,
                );
              }
            }
          } else {
            // No cached PDF - trigger Zotero's "Find Full Text"
            try {
              Zotero.debug(
                `[seerai] No PDF available, initiating Find Full Text...`,
              );
              await (Zotero.Attachments as any).addAvailablePDF(newItem);
              Zotero.debug(`[seerai] Find Full Text initiated`);
            } catch (findError) {
              // Find Full Text failure is non-fatal
              Zotero.debug(
                `[seerai] Find Full Text failed (non-fatal): ${findError}`,
              );
            }
          }
        }
      }

      return newItem;
    } catch (error) {
      Zotero.debug(`[seerai] Error adding paper to Zotero: ${error}`);
      return null;
    }
  }

  /**
   * Add paper to Zotero with full PDF discovery pipeline (steps 1-6)
   * Uses the same discovery process as the search card PDF button
   * Returns both the item and whether PDF was successfully attached
   */
  public static async addPaperToZoteroWithPdfDiscovery(
    paper: SemanticScholarPaper,
    statusBtn?: HTMLButtonElement,
    targetColId?: number,
    waitForPdf: boolean = true,
    triggerOcr: boolean = false,
  ): Promise<{
    item: Zotero.Item | null;
    pdfAttached: boolean;
    sourceUrl?: string;
  }> {
    try {
      Zotero.debug(
        `[seerai] Adding paper to Zotero with PDF discovery: ${paper.title}`,
      );

      // Determine item type based on publication types
      type ZoteroItemType = "journalArticle" | "conferencePaper" | "book";
      let itemType: ZoteroItemType = "journalArticle";
      if (paper.publicationTypes) {
        if (paper.publicationTypes.includes("Conference")) {
          itemType = "conferencePaper";
        } else if (paper.publicationTypes.includes("Book")) {
          itemType = "book";
        }
      }

      // 1. Determine library ownership and collection
      const saveLocation = currentSearchState.saveLocation || "user";
      let targetLibraryId = Zotero.Libraries.userLibraryID;
      let targetCollectionId: number | null = targetColId || null;

      // If a collection ID was explicitly provided, use its library
      if (targetCollectionId) {
        try {
          const collection = Zotero.Collections.get(targetCollectionId);
          if (collection) {
            targetLibraryId = collection.libraryID;
          }
        } catch (e) {
          Zotero.debug(
            `[seerai] Error getting library for collection ${targetCollectionId}: ${e}`,
          );
        }
      } else if (saveLocation === "user") {
        targetLibraryId = Zotero.Libraries.userLibraryID;
      } else if (saveLocation.startsWith("lib_")) {
        targetLibraryId = parseInt(saveLocation.replace("lib_", ""), 10);
      } else if (saveLocation.startsWith("col_")) {
        targetCollectionId = parseInt(saveLocation.replace("col_", ""), 10);
        try {
          const collection = Zotero.Collections.get(targetCollectionId);
          if (collection) {
            targetLibraryId = collection.libraryID;
          }
        } catch (e) {
          Zotero.debug(
            `[seerai] Error getting collection ${targetCollectionId}: ${e}`,
          );
        }
      }

      // 2. Create the item
      const newItem = new Zotero.Item(itemType);
      newItem.libraryID = targetLibraryId;

      // 3. Populate metadata fields
      newItem.setField("title", paper.title);

      if (paper.abstract) {
        newItem.setField("abstractNote", paper.abstract);
      }
      if (paper.year) {
        newItem.setField("date", String(paper.year));
      }
      if (paper.venue) {
        if (itemType === "conferencePaper") {
          newItem.setField("proceedingsTitle", paper.venue);
        } else {
          newItem.setField("publicationTitle", paper.venue);
        }
      }
      if (paper.externalIds?.DOI) {
        newItem.setField("DOI", paper.externalIds.DOI);
      }
      if (paper.url) {
        newItem.setField("url", paper.url);
      }

      // Add authors/creators
      if (paper.authors && paper.authors.length > 0) {
        const creators = paper.authors.slice(0, 20).map((author) => {
          const nameParts = author.name.trim().split(" ");
          const lastName = nameParts.pop() || author.name;
          const firstName = nameParts.join(" ");
          return {
            firstName,
            lastName,
            creatorType: "author" as const,
          };
        });
        newItem.setCreators(creators);
      }

      // 4. Save to generate item ID
      await newItem.saveTx();
      Zotero.debug(
        `[seerai] Item saved with ID: ${newItem.id} to library ${targetLibraryId}`,
      );

      // 5. Add to collection if one was selected
      if (targetCollectionId !== null) {
        try {
          newItem.addToCollection(targetCollectionId);
          await newItem.saveTx();
          Zotero.debug(
            `[seerai] Item added to collection ${targetCollectionId}`,
          );
        } catch (colError) {
          Zotero.debug(`[seerai] Error adding to collection: ${colError}`);
        }
      }

      // Helper for status updates
      const updateStatus = (text: string) => {
        if (statusBtn) {
          statusBtn.textContent = text;
        }
      };

      // 6. Define PDF discovery logic
      const performDiscovery = async (): Promise<boolean> => {
        let pdfAttached = false;

        // If Semantic Scholar open access PDF is available, use it directly
        if (paper.openAccessPdf?.url) {
          updateStatus("📥 Attaching PDF...");
          try {
            await Zotero.Attachments.importFromURL({
              url: paper.openAccessPdf.url,
              parentItemID: newItem.id,
              title: `${paper.title}.pdf`,
              contentType: "application/pdf",
            });
            Zotero.debug(`[seerai] Semantic Scholar PDF attached`);
            pdfAttached = true;
          } catch (pdfError) {
            Zotero.debug(`[seerai] SS PDF attach failed: ${pdfError}`);
          }
        }

        // Run PDF discovery pipeline if no PDF attached yet
        if (!pdfAttached) {
          // Use unified PDF discovery pipeline
          pdfAttached = await findAndAttachPdfForItem(newItem, updateStatus);
        }

        // Trigger OCR if requested and PDF attached
        if (triggerOcr && pdfAttached) {
          const ocrService = Assistant.getOcrService();
          const pdf = ocrService.getFirstPdfAttachment(newItem);
          if (pdf) {
            Zotero.debug(
              `[seerai] Triggering background OCR for imported paper ${newItem.id}`,
            );
            // We don't await this if it's already in a background task, 
            // but if we are waiting for PDF, we might want to wait for OCR too?
            // User said "until all series of import paper completed", which might include OCR.
            // For now, let's await it so the agent knows when it's FULLY done if waitForPdf is true.
            await ocrService.convertToMarkdown(pdf, { showProgress: false });
          }
        }

        Zotero.debug(
          `[seerai] Paper import discovery complete for ${newItem.id}, success: ${pdfAttached}`,
        );
        return pdfAttached;
      };

      // Handle backgrounding vs waiting
      if (waitForPdf) {
        const attached = await performDiscovery();
        return { item: newItem, pdfAttached: attached };
      } else {
        // Run in background
        performDiscovery().catch((e) =>
          Zotero.debug(`[seerai] Background PDF discovery failed: ${e}`),
        );
        return { item: newItem, pdfAttached: false };
      }
    } catch (error) {
      Zotero.debug(`[seerai] Error adding paper with PDF discovery: ${error}`);
      return { item: null, pdfAttached: false };
    }
  }

  /**
   * Try to find and attach PDF for an already-created Zotero item
   * Used for retry functionality after Source-Link is clicked
   */
  private static async tryFindPdfForItem(
    paper: SemanticScholarPaper,
    item: Zotero.Item,
  ): Promise<boolean> {
    try {
      Zotero.debug(
        `[seerai] Retrying PDF discovery for item ${item.id}: ${paper.title.slice(0, 50)}...`,
      );

      // Step 1: Try Zotero's Find Full Text resolver
      const zoteroResult = await findPdfViaZotero(
        paper.externalIds?.DOI,
        paper.externalIds?.ArXiv,
        paper.externalIds?.PMID,
        paper.title,
        paper.url,
      );
      if (zoteroResult) {
        await Zotero.Attachments.importFromURL({
          url: zoteroResult,
          parentItemID: item.id,
          title: `${paper.title}.pdf`,
          contentType: "application/pdf",
        });
        return true;
      }

      // Step 2: Try arXiv
      if (paper.externalIds?.ArXiv) {
        const arxivResult = await findPdfViaArxiv(paper.externalIds.ArXiv);
        if (arxivResult) {
          await Zotero.Attachments.importFromURL({
            url: arxivResult,
            parentItemID: item.id,
            title: `${paper.title}.pdf`,
            contentType: "application/pdf",
          });
          return true;
        }
      }

      // Step 3: Try PMC
      if (paper.externalIds?.PMID) {
        const pmcResult = await findPdfViaPmc(paper.externalIds.PMID);
        if (pmcResult) {
          await Zotero.Attachments.importFromURL({
            url: pmcResult,
            parentItemID: item.id,
            title: `${paper.title}.pdf`,
            contentType: "application/pdf",
          });
          return true;
        }
      }

      // Step 4: Try bioRxiv
      if (paper.externalIds?.DOI?.startsWith("10.1101/")) {
        const biorxivResult = await findPdfViaBiorxiv(paper.externalIds.DOI);
        if (biorxivResult) {
          await Zotero.Attachments.importFromURL({
            url: biorxivResult,
            parentItemID: item.id,
            title: `${paper.title}.pdf`,
            contentType: "application/pdf",
          });
          return true;
        }
      }

      // Step 5: Try Unpaywall
      if (paper.externalIds?.DOI) {
        const unpaywallResult = await unpaywallService.getPdfUrl(
          paper.externalIds.DOI,
        );
        if (unpaywallResult) {
          await Zotero.Attachments.importFromURL({
            url: unpaywallResult,
            parentItemID: item.id,
            title: `${paper.title}.pdf`,
            contentType: "application/pdf",
          });
          return true;
        }
      }

      // Step 6: Try Europe PMC
      const epmcResult = await findPdfViaEuropePmc(
        paper.externalIds?.DOI,
        paper.externalIds?.PMID,
      );
      if (epmcResult) {
        await Zotero.Attachments.importFromURL({
          url: epmcResult,
          parentItemID: item.id,
          title: `${paper.title}.pdf`,
          contentType: "application/pdf",
        });
        return true;
      }

      // Final fallback: Zotero Find Full Text
      try {
        await (Zotero.Attachments as any).addAvailablePDF(item);
      } catch (err) {
        // Non-fatal
      }

      return false;
    } catch (error) {
      Zotero.debug(`[seerai] Retry PDF discovery error: ${error}`);
      return false;
    }
  }

  /**
   * Convert a Semantic Scholar paper to BibTeX format
   */
  private static paperToBibtex(paper: SemanticScholarPaper): string {
    // Generate a unique cite key: firstAuthorLastName + year + firstTitleWord
    let citeKey = "unknown";
    if (paper.authors && paper.authors.length > 0) {
      const firstAuthor = paper.authors[0].name.trim();
      const lastName = firstAuthor.split(" ").pop() || "unknown";
      const year = paper.year || "nd";
      const titleWord =
        paper.title.split(/\s+/)[0]?.replace(/[^a-zA-Z]/g, "") || "paper";
      citeKey = `${lastName.toLowerCase()}${year}${titleWord.toLowerCase()}`;
    }

    // Determine entry type
    let entryType = "@article";
    if (paper.publicationTypes) {
      if (paper.publicationTypes.includes("Conference")) {
        entryType = "@inproceedings";
      } else if (paper.publicationTypes.includes("Book")) {
        entryType = "@book";
      }
    }

    // Format authors: "LastName, FirstName and LastName, FirstName"
    let authorsStr = "";
    if (paper.authors && paper.authors.length > 0) {
      authorsStr = paper.authors
        .map((a) => {
          const parts = a.name.trim().split(" ");
          const lastName = parts.pop() || "";
          const firstName = parts.join(" ");
          return firstName ? `${lastName}, ${firstName}` : lastName;
        })
        .join(" and ");
    }

    // Escape special BibTeX characters
    const escapeLatex = (str: string): string => {
      return str
        .replace(/\\/g, "\\textbackslash{}")
        .replace(/&/g, "\\&")
        .replace(/%/g, "\\%")
        .replace(/\$/g, "\\$")
        .replace(/#/g, "\\#")
        .replace(/_/g, "\\_")
        .replace(/\{/g, "\\{")
        .replace(/\}/g, "\\}")
        .replace(/~/g, "\\textasciitilde{}")
        .replace(/\^/g, "\\textasciicircum{}");
    };

    // Build the BibTeX entry
    const lines: string[] = [];
    lines.push(`${entryType}{${citeKey},`);
    lines.push(`  title = {${escapeLatex(paper.title)}},`);

    if (authorsStr) {
      lines.push(`  author = {${escapeLatex(authorsStr)}},`);
    }
    if (paper.year) {
      lines.push(`  year = {${paper.year}},`);
    }
    if (paper.venue) {
      const venueField =
        entryType === "@inproceedings" ? "booktitle" : "journal";
      lines.push(`  ${venueField} = {${escapeLatex(paper.venue)}},`);
    }
    if (paper.externalIds?.DOI) {
      lines.push(`  doi = {${paper.externalIds.DOI}},`);
    }
    if (paper.url) {
      lines.push(`  url = {${paper.url}},`);
    }
    if (paper.abstract) {
      lines.push(`  abstract = {${escapeLatex(paper.abstract)}},`);
    }

    // Remove trailing comma from last field
    if (lines.length > 1) {
      lines[lines.length - 1] = lines[lines.length - 1].replace(/,$/, "");
    }
    lines.push("}");

    return lines.join("\n");
  }

  /**
   * Export all current search results as a BibTeX file
   */
  private static async exportResultsAsBibtex(): Promise<void> {
    if (currentSearchResults.length === 0) {
      Zotero.debug("[seerai] No search results to export");
      return;
    }

    try {
      // Generate BibTeX for all papers
      const bibtexEntries = currentSearchResults.map((paper) =>
        this.paperToBibtex(paper),
      );
      const bibtexContent = bibtexEntries.join("\n\n");

      // Create file picker for save location using ztoolkit
      const defaultFileName = `semantic_scholar_export_${new Date().toISOString().slice(0, 10)}.bib`;

      const filePath = await new ztoolkit.FilePicker(
        "Export BibTeX",
        "save",
        [["BibTeX Files", "*.bib"]],
        defaultFileName,
      ).open();

      if (filePath) {
        // Write the file using Zotero.File
        await Zotero.File.putContentsAsync(filePath, bibtexContent);
        Zotero.debug(
          `[seerai] Exported ${currentSearchResults.length} papers to BibTeX: ${filePath}`,
        );
      }
    } catch (error) {
      Zotero.debug(`[seerai] Error exporting BibTeX: ${error}`);
    }
  }

  /**
   * Create the table toolbar with filter, add papers, generate, export buttons
   */
  private static createTableToolbar(
    doc: Document,
    item: Zotero.Item,
  ): HTMLElement {
    const toolbar = ztoolkit.UI.createElement(doc, "div", {
      properties: { className: "table-toolbar" },
      styles: {
        display: "flex",
        gap: "8px",
        padding: "8px",
        backgroundColor: "var(--background-secondary)",
        borderBottom: "1px solid var(--border-primary)",
        alignItems: "center",
        flexWrap: "wrap",
      },
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
        transition: "all 0.2s",
      },
      listeners: [
        {
          type: "mouseenter",
          listener: () => {
            if (!titleContainer.classList.contains("editing")) {
              titleContainer.style.backgroundColor =
                "var(--background-secondary)";
              titleContainer.style.border = "1px solid var(--border-primary)";
            }
          },
        },
        {
          type: "mouseleave",
          listener: () => {
            if (!titleContainer.classList.contains("editing")) {
              titleContainer.style.backgroundColor = "transparent";
              titleContainer.style.border = "1px solid transparent";
            }
          },
        },
        {
          type: "click",
          listener: () => {
            if (titleContainer.classList.contains("editing")) return;

            const nameLabel = titleContainer.querySelector(
              ".workspace-name-label",
            ) as HTMLElement;
            const currentName =
              currentTableConfig?.name || "Untitled Workspace";

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
                backgroundColor: "var(--background-primary)",
              },
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
          },
        },
      ],
    });

    const renderTitle = () => {
      titleContainer.innerHTML = "";
      const prefix = ztoolkit.UI.createElement(doc, "span", {
        properties: { innerText: "WORKSPACE:" },
        styles: {
          fontSize: "10px",
          color: "var(--text-secondary)",
          fontWeight: "600",
          letterSpacing: "0.5px",
        },
      });

      const name = ztoolkit.UI.createElement(doc, "span", {
        properties: {
          className: "workspace-name-label",
          innerText: currentTableConfig?.name || "Untitled Workspace",
        },
        styles: {
          fontSize: "12px",
          fontWeight: "600",
          color: "var(--text-primary)",
        },
      });

      const editIcon = ztoolkit.UI.createElement(doc, "span", {
        properties: { innerText: "✎" },
        styles: {
          fontSize: "10px",
          color: "var(--text-tertiary)",
          opacity: "0.5",
        },
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
        gap: "4px",
      },
    });

    const filterLabel = ztoolkit.UI.createElement(doc, "span", {
      properties: { innerText: "📁" },
      styles: { fontSize: "12px" },
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
        minWidth: "120px",
      },
      listeners: [
        {
          type: "change",
          listener: async (e: Event) => {
            const select = e.target as HTMLSelectElement;
            const value = select.value;
            if (currentTableConfig) {
              if (value === "all") {
                currentTableConfig.filterLibraryId = null;
                currentTableConfig.filterCollectionId = null;
              } else if (value.startsWith("lib_")) {
                currentTableConfig.filterLibraryId = parseInt(
                  value.replace("lib_", ""),
                  10,
                );
                currentTableConfig.filterCollectionId = null;
              } else if (value.startsWith("col_")) {
                currentTableConfig.filterCollectionId = parseInt(
                  value.replace("col_", ""),
                  10,
                );
              }
              const tableStore = getTableStore();
              await tableStore.saveConfig(currentTableConfig);
            }
          },
        },
      ],
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
        color: "var(--text-primary)",
        outline: "none",
      },
      listeners: [
        {
          type: "input",
          listener: (e: Event) => {
            const target = e.target as HTMLInputElement;
            if (currentTableConfig) {
              currentTableConfig.filterQuery = target.value;
            }
            this.debounceTableRefresh(doc, item);
          },
        },
      ],
    }) as HTMLInputElement;

    if (currentTableConfig?.filterQuery) {
      searchInput.value = currentTableConfig.filterQuery;
    }
    toolbar.appendChild(searchInput);

    // Add Papers button
    const addPapersBtn = ztoolkit.UI.createElement(doc, "button", {
      properties: {
        className: "table-btn table-btn-primary",
        innerText: "➕ Add Papers",
      },
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
        gap: "4px",
      },
      listeners: [
        {
          type: "click",
          listener: () => {
            this.showTablePaperPicker(doc, item);
          },
        },
      ],
    });
    toolbar.appendChild(addPapersBtn);

    // Extract All button (for OCR)
    const extractBtn = ztoolkit.UI.createElement(doc, "button", {
      properties: {
        className: "table-btn extract-all-btn",
        innerText: "📄 Extract All",
      },
      attributes: { id: "extract-all-btn" },
      styles: {
        padding: "6px 12px",
        fontSize: "11px",
        border: "1px solid var(--border-primary)",
        borderRadius: "4px",
        backgroundColor: "var(--background-primary)",
        color: "var(--text-primary)",
        cursor: "pointer",
      },
      listeners: [
        {
          type: "click",
          listener: async () => {
            await this.extractAllEmptyPDFs(doc, item);
          },
        },
      ],
    });
    toolbar.appendChild(extractBtn);

    // Search all PDF button (find PDFs for items without attachments)
    const searchPdfBtn = ztoolkit.UI.createElement(doc, "button", {
      properties: {
        className: "table-btn search-pdf-all-btn",
        innerText: "🔍 Search all PDF",
      },
      attributes: { id: "search-pdf-all-btn" },
      styles: {
        padding: "6px 12px",
        fontSize: "11px",
        border: "1px solid var(--border-primary)",
        borderRadius: "4px",
        backgroundColor: "var(--background-primary)",
        color: "var(--text-primary)",
        cursor: "pointer",
      },
      listeners: [
        {
          type: "click",
          listener: async () => {
            await this.searchAllPdfsInTable(doc, searchPdfBtn);
          },
        },
      ],
    });
    toolbar.appendChild(searchPdfBtn);

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
        cursor: "pointer",
      },
      listeners: [
        {
          type: "click",
          listener: async () => {
            await this.exportTableToCSV();
          },
        },
      ],
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
        cursor: "pointer",
      },
      listeners: [
        {
          type: "click",
          listener: async () => {
            const rowCount = currentTableConfig?.addedPaperIds?.length || 0;
            if (rowCount === 0) {
              doc.defaultView?.alert("No papers in table to save as notes.");
              return;
            }
            const confirmed = doc.defaultView?.confirm(
              `Save table data for ${rowCount} paper(s) as notes?\n\nThis will create/update a "📊 Tables" note attached to each paper.`,
            );
            if (confirmed) {
              await this.saveAllRowsAsNotes(doc);
            }
          },
        },
      ],
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
        cursor: "pointer",
      },
      listeners: [
        {
          type: "click",
          listener: async () => {
            await this.saveWorkspaceToHistory(doc);
          },
        },
      ],
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
        cursor: "pointer",
      },
      listeners: [
        {
          type: "click",
          listener: () => {
            this.showWorkspacePicker(doc, item);
          },
        },
      ],
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
        cursor: "pointer",
      },
      listeners: [
        {
          type: "click",
          listener: async () => {
            await this.startFreshWorkspace(doc, item);
          },
        },
      ],
    });
    toolbar.appendChild(startFreshBtn);

    // === PAGINATION CONTROLS ===
    const paginationContainer = ztoolkit.UI.createElement(doc, "div", {
      styles: {
        display: "flex",
        alignItems: "center",
        gap: "8px",
        marginLeft: "auto", // Push to right
        padding: "2px 8px",
        borderLeft: "1px solid var(--border-primary)",
      },
    });

    // Page Size Selector
    const pageSizeLabel = ztoolkit.UI.createElement(doc, "span", {
      properties: { innerText: "Lines:" },
      styles: { fontSize: "11px", color: "var(--text-secondary)" },
    });
    paginationContainer.appendChild(pageSizeLabel);

    const pageSizeSelect = ztoolkit.UI.createElement(doc, "select", {
      styles: {
        padding: "2px 4px",
        fontSize: "11px",
        border: "1px solid var(--border-primary)",
        borderRadius: "3px",
        backgroundColor: "var(--background-primary)",
        color: "var(--text-primary)",
      },
      listeners: [
        {
          type: "change",
          listener: async (e: Event) => {
            const select = e.target as HTMLSelectElement;
            const newSize = parseInt(select.value, 10);
            if (currentTableConfig) {
              currentTableConfig.pageSize = newSize;
              currentTableConfig.currentPage = 1; // Reset to page 1 on size change
              const tableStore = getTableStore();
              await tableStore.saveConfig(currentTableConfig);
              if (currentContainer && currentItem) {
                this.renderInterface(currentContainer, currentItem);
              }
            }
          },
        },
      ],
    }) as HTMLSelectElement;

    [25, 50, 100, 200].forEach((size) => {
      const opt = ztoolkit.UI.createElement(doc, "option", {
        properties: {
          value: String(size),
          innerText: String(size),
          selected: currentTableConfig?.pageSize === size,
        },
      });
      pageSizeSelect.appendChild(opt);
    });
    paginationContainer.appendChild(pageSizeSelect);

    // Page info
    const currentPage = currentTableConfig?.currentPage || 1;
    const pageSize = currentTableConfig?.pageSize || 25;
    const totalItems = currentTableConfig?.addedPaperIds?.length || 0;
    const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));

    // Prev Button
    const prevBtn = ztoolkit.UI.createElement(doc, "button", {
      properties: { innerText: "◀", disabled: currentPage <= 1 },
      styles: {
        background: "none",
        border: "none",
        cursor: currentPage <= 1 ? "default" : "pointer",
        padding: "2px 4px",
        opacity: currentPage <= 1 ? "0.3" : "0.7",
        fontSize: "12px",
        color: "var(--text-primary)",
      },
      listeners: [
        {
          type: "click",
          listener: async () => {
            if (currentTableConfig && currentPage > 1) {
              currentTableConfig.currentPage = currentPage - 1;
              const tableStore = getTableStore();
              await tableStore.saveConfig(currentTableConfig);
              if (currentContainer && currentItem) {
                this.renderInterface(currentContainer, currentItem);
              }
            }
          },
        },
      ],
    });
    paginationContainer.appendChild(prevBtn);

    // Page Indicator
    const pageIndicator = ztoolkit.UI.createElement(doc, "span", {
      properties: { innerText: `${currentPage} / ${totalPages}` },
      styles: {
        fontSize: "11px",
        fontWeight: "600",
        minWidth: "40px",
        textAlign: "center",
      },
    });
    paginationContainer.appendChild(pageIndicator);

    // Next Button
    const nextBtn = ztoolkit.UI.createElement(doc, "button", {
      properties: { innerText: "▶", disabled: currentPage >= totalPages },
      styles: {
        background: "none",
        border: "none",
        cursor: currentPage >= totalPages ? "default" : "pointer",
        padding: "2px 4px",
        opacity: currentPage >= totalPages ? "0.3" : "0.7",
        fontSize: "12px",
        color: "var(--text-primary)",
      },
      listeners: [
        {
          type: "click",
          listener: async () => {
            if (currentTableConfig && currentPage < totalPages) {
              currentTableConfig.currentPage = currentPage + 1;
              const tableStore = getTableStore();
              await tableStore.saveConfig(currentTableConfig);
              if (currentContainer && currentItem) {
                this.renderInterface(currentContainer, currentItem);
              }
            }
          },
        },
      ],
    });
    paginationContainer.appendChild(nextBtn);

    toolbar.appendChild(paginationContainer);

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
        if (
          currentTableConfig?.filterLibraryId === library.libraryID &&
          !currentTableConfig?.filterCollectionId
        ) {
          libOption.selected = true;
        }
        select.appendChild(libOption);

        // Get collections for this library (recursive)
        const collections = Zotero.Collections.getByLibrary(
          library.libraryID,
          true,
        );

        // Build hierarchy
        const colMap = new Map<number, Zotero.Collection>();
        const childrenMap = new Map<number, Zotero.Collection[]>();
        const rootCols: Zotero.Collection[] = [];

        // First pass: map all collections
        collections.forEach((col) => {
          colMap.set(col.id, col);
          if (!childrenMap.has(col.id)) {
            childrenMap.set(col.id, []);
          }
        });

        // Second pass: organize into tree
        collections.forEach((col) => {
          if (col.parentID && colMap.has(col.parentID)) {
            if (!childrenMap.has(col.parentID)) {
              childrenMap.set(col.parentID, []);
            }
            childrenMap.get(col.parentID)?.push(col);
          } else {
            rootCols.push(col);
          }
        });

        // Sort by name
        const sortCols = (a: Zotero.Collection, b: Zotero.Collection) =>
          a.name.localeCompare(b.name);

        rootCols.sort(sortCols);
        childrenMap.forEach((children) => children.sort(sortCols));

        // Recursive function to render options
        const renderCollections = (
          cols: Zotero.Collection[],
          level: number,
        ) => {
          for (const col of cols) {
            const colOption = doc.createElement("option");
            colOption.value = `col_${col.id}`;
            // Add indentation based on level
            const prefix = "  ".repeat(level + 1);
            colOption.textContent = `${prefix}📁 ${col.name}`;

            if (currentTableConfig?.filterCollectionId === col.id) {
              colOption.selected = true;
            }
            select.appendChild(colOption);

            // Render children
            const children = childrenMap.get(col.id);
            if (children && children.length > 0) {
              renderCollections(children, level + 1);
            }
          }
        };

        // Start rendering from roots
        renderCollections(rootCols, 0);
      }
    } catch (e) {
      Zotero.debug(`[seerai] Error populating filter select: ${e}`);
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
        libOption.value =
          library.libraryID === Zotero.Libraries.userLibraryID
            ? "user"
            : `lib_${library.libraryID}`;
        libOption.textContent = `📚 ${library.name}`;
        if (currentSearchState.saveLocation === libOption.value) {
          libOption.selected = true;
        }
        select.appendChild(libOption);

        // Get collections for this library
        const collections = Zotero.Collections.getByLibrary(
          library.libraryID,
          true,
        );

        // Build hierarchy
        const colMap = new Map<number, Zotero.Collection>();
        const childrenMap = new Map<number, Zotero.Collection[]>();
        const rootCols: Zotero.Collection[] = [];

        // First pass: map all collections
        collections.forEach((col) => {
          colMap.set(col.id, col);
          if (!childrenMap.has(col.id)) {
            childrenMap.set(col.id, []);
          }
        });

        // Second pass: organize into tree
        collections.forEach((col) => {
          if (col.parentID && colMap.has(col.parentID)) {
            if (!childrenMap.has(col.parentID)) {
              childrenMap.set(col.parentID, []);
            }
            childrenMap.get(col.parentID)?.push(col);
          } else {
            rootCols.push(col);
          }
        });

        // Sort by name
        const sortCols = (a: Zotero.Collection, b: Zotero.Collection) =>
          a.name.localeCompare(b.name);

        rootCols.sort(sortCols);
        childrenMap.forEach((children) => children.sort(sortCols));

        // Recursive function to render options
        const renderCollections = (
          cols: Zotero.Collection[],
          level: number,
        ) => {
          for (const col of cols) {
            const colOption = doc.createElement("option");
            colOption.value = `col_${col.id}`;
            // Add indentation based on level
            const prefix = "  ".repeat(level + 1); // +1 for initial indent under library
            colOption.textContent = `${prefix}📁 ${col.name}`;

            if (currentSearchState.saveLocation === colOption.value) {
              colOption.selected = true;
            }
            select.appendChild(colOption);

            // Render children
            const children = childrenMap.get(col.id);
            if (children && children.length > 0) {
              renderCollections(children, level + 1);
            }
          }
        };

        // Start rendering from roots
        renderCollections(rootCols, 0);
      }
    } catch (e) {
      Zotero.debug(`[seerai] Error populating save location select: ${e}`);
    }
  }

  /**
   * Show paper picker as a beautiful inline dropdown panel
   */
  private static async showTablePaperPicker(
    doc: Document,
    item: Zotero.Item,
  ): Promise<void> {
    // Toggle existing dropdown
    const existing = doc.getElementById(
      "table-paper-picker-dropdown",
    ) as HTMLElement | null;
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
        margin: "8px",
      },
    });

    // Header with gradient
    const header = ztoolkit.UI.createElement(doc, "div", {
      styles: {
        background:
          "linear-gradient(135deg, var(--highlight-primary) 0%, color-mix(in srgb, var(--highlight-primary) 80%, purple) 100%)",
        padding: "12px 16px",
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        gap: "12px",
      },
    });

    const headerTitle = ztoolkit.UI.createElement(doc, "div", {
      properties: { innerText: "📚 Add Papers" },
      styles: {
        fontSize: "14px",
        fontWeight: "600",
        color: "var(--highlight-text)",
        textShadow: "0 1px 2px rgba(0,0,0,0.1)",
      },
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
        transition: "background 0.2s",
      },
      listeners: [
        {
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
          },
        },
      ],
    });
    closeBtn.addEventListener("mouseenter", () => {
      closeBtn.style.background = "rgba(0,0,0,0.15)";
    });
    closeBtn.addEventListener("mouseleave", () => {
      closeBtn.style.background = "rgba(0,0,0,0.1)";
    });
    header.appendChild(closeBtn);
    dropdown.appendChild(header);

    // Content area
    const content = ztoolkit.UI.createElement(doc, "div", {
      styles: {
        padding: "12px 16px",
        display: "flex",
        flexDirection: "column",
        gap: "10px",
      },
    });

    // Filter and search row
    const controlsRow = ztoolkit.UI.createElement(doc, "div", {
      styles: {
        display: "flex",
        gap: "8px",
        alignItems: "center",
      },
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
        transition: "border-color 0.2s, box-shadow 0.2s",
      },
    }) as HTMLSelectElement;
    filterSelect.addEventListener("focus", () => {
      filterSelect.style.borderColor = "var(--highlight-primary)";
      filterSelect.style.boxShadow =
        "0 0 0 3px color-mix(in srgb, var(--highlight-primary) 20%, transparent)";
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
        transition: "border-color 0.2s, box-shadow 0.2s",
      },
    }) as HTMLInputElement;
    searchInput.addEventListener("focus", () => {
      searchInput.style.borderColor = "var(--highlight-primary)";
      searchInput.style.boxShadow =
        "0 0 0 3px color-mix(in srgb, var(--highlight-primary) 20%, transparent)";
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
        backgroundColor: "var(--background-secondary)",
      },
    });
    content.appendChild(listContainer);

    // State for infinite scroll and Add All
    let allFilteredItems: Zotero.Item[] = [];
    let displayedCount = 0;
    const BATCH_SIZE = 50;
    let isLoadingMore = false;

    // Render papers with beautiful styling
    const renderPaperBatch = (
      items: Zotero.Item[],
      startIndex: number,
      count: number,
    ) => {
      const endIndex = Math.min(startIndex + count, items.length);
      for (let i = startIndex; i < endIndex; i++) {
        const paperItem = items[i];
        const paperTitle =
          (paperItem.getField("title") as string) || "Untitled";
        const creators = paperItem.getCreators();
        const authorStr =
          creators.length > 0
            ? creators.map((c) => c.lastName).join(", ")
            : "Unknown";
        const year = paperItem.getField("year") || "";

        const row = ztoolkit.UI.createElement(doc, "div", {
          attributes: { "data-paper-id": String(paperItem.id) },
          styles: {
            padding: "10px 14px",
            borderBottom: "1px solid var(--border-primary)",
            cursor: "pointer",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            transition: "background-color 0.15s, transform 0.1s",
          },
        });

        const info = ztoolkit.UI.createElement(doc, "div", {
          styles: { flex: "1", overflow: "hidden", marginRight: "10px" },
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
            wordBreak: "break-word",
          },
          listeners: [
            {
              type: "click",
              listener: async (e: Event) => {
                e.stopPropagation();
                const attachmentIds = paperItem.getAttachments();
                for (const attachId of attachmentIds) {
                  const attachment = Zotero.Items.get(attachId);
                  if (
                    attachment &&
                    attachment.isPDFAttachment &&
                    attachment.isPDFAttachment()
                  ) {
                    await Zotero.Reader.open(attachment.id);
                    return;
                  }
                }
                const zp = Zotero.getActiveZoteroPane();
                if (zp) zp.selectItem(paperItem.id);
              },
            },
          ],
        });
        titleEl.addEventListener("mouseenter", () => {
          (titleEl as HTMLElement).style.textDecoration = "underline";
        });
        titleEl.addEventListener("mouseleave", () => {
          (titleEl as HTMLElement).style.textDecoration = "none";
        });

        const metaEl = ztoolkit.UI.createElement(doc, "div", {
          properties: { innerText: `${authorStr}${year ? ` • ${year}` : ""}` },
          styles: {
            fontSize: "11px",
            color: "var(--text-secondary)",
            marginTop: "2px",
          },
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
            flexShrink: "0",
          },
          listeners: [
            {
              type: "click",
              listener: async (e: Event) => {
                e.stopPropagation();
                if (currentTableConfig) {
                  if (!currentTableConfig.addedPaperIds) {
                    currentTableConfig.addedPaperIds = [];
                  }
                  if (
                    !currentTableConfig.addedPaperIds.includes(paperItem.id)
                  ) {
                    currentTableConfig.addedPaperIds.push(paperItem.id);
                    const tableStore = getTableStore();
                    await tableStore.saveConfig(currentTableConfig);

                    // Update table view immediately
                    const tableWrapper = doc.querySelector(".table-wrapper");
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
                      const idx = allFilteredItems.findIndex(
                        (item) => item.id === paperItem.id,
                      );
                      if (idx !== -1) {
                        allFilteredItems.splice(idx, 1);
                        displayedCount--;
                      }
                    }, 150);
                  }
                }
              },
            },
          ],
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
        row.addEventListener("mouseenter", () => {
          row.style.backgroundColor = "var(--background-primary)";
        });
        row.addEventListener("mouseleave", () => {
          row.style.backgroundColor = "";
        });

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
        styles: {
          padding: "20px",
          textAlign: "center",
          color: "var(--text-secondary)",
        },
      });
      listContainer.appendChild(loadingEl);

      let items: Zotero.Item[] = [];
      try {
        if (filterValue === "all") {
          const libraries = Zotero.Libraries.getAll();
          for (const lib of libraries) {
            const libItems = await Zotero.Items.getAll(lib.libraryID);
            items.push(
              ...libItems.filter((i: Zotero.Item) => i.isRegularItem()),
            );
          }
        } else if (filterValue.startsWith("lib_")) {
          const libraryId = parseInt(filterValue.replace("lib_", ""), 10);
          const libItems = await Zotero.Items.getAll(libraryId);
          items = libItems.filter((i: Zotero.Item) => i.isRegularItem());
        } else if (filterValue.startsWith("col_")) {
          const collectionId = parseInt(filterValue.replace("col_", ""), 10);
          const collection = Zotero.Collections.get(collectionId);
          if (collection) {
            items = collection
              .getChildItems()
              .filter((i: Zotero.Item) => i.isRegularItem());
          }
        }

        const addedIds = new Set(currentTableConfig?.addedPaperIds || []);
        allFilteredItems = items.filter((i) => {
          if (addedIds.has(i.id)) return false;
          if (!searchQuery) return true;
          const itemTitle = (
            (i.getField("title") as string) || ""
          ).toLowerCase();
          const creators = i
            .getCreators()
            .map((c) => `${c.firstName} ${c.lastName}`.toLowerCase())
            .join(" ");
          return (
            itemTitle.includes(searchQuery) || creators.includes(searchQuery)
          );
        });

        listContainer.innerHTML = "";

        if (allFilteredItems.length === 0) {
          const emptyMsg = ztoolkit.UI.createElement(doc, "div", {
            properties: { innerText: "No papers found" },
            styles: {
              padding: "30px",
              textAlign: "center",
              color: "var(--text-tertiary)",
              fontSize: "13px",
            },
          });
          listContainer.appendChild(emptyMsg);
          return;
        }

        renderPaperBatch(allFilteredItems, 0, BATCH_SIZE);
      } catch (e) {
        listContainer.innerHTML = "";
        const errorMsg = ztoolkit.UI.createElement(doc, "div", {
          properties: { innerText: `Error loading papers: ${e}` },
          styles: { padding: "20px", textAlign: "center", color: "#c62828" },
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
        borderTop: "1px solid var(--border-primary)",
      },
    });

    // Add All button
    const addAllBtn = ztoolkit.UI.createElement(doc, "button", {
      properties: { innerText: "➕ Add All" },
      styles: {
        padding: "10px 18px",
        border: "none",
        borderRadius: "8px",
        background:
          "linear-gradient(135deg, var(--highlight-primary) 0%, color-mix(in srgb, var(--highlight-primary) 80%, purple) 100%)",
        color: "var(--highlight-text)",
        cursor: "pointer",
        fontWeight: "600",
        fontSize: "12px",
        transition: "transform 0.15s, box-shadow 0.15s",
        boxShadow: "0 2px 8px rgba(0,0,0,0.15)",
      },
      listeners: [
        {
          type: "click",
          listener: async () => {
            let count = 0;
            for (const paperItem of allFilteredItems) {
              if (
                currentTableConfig &&
                !currentTableConfig.addedPaperIds.includes(paperItem.id)
              ) {
                currentTableConfig.addedPaperIds.push(paperItem.id);
                count++;
              }
            }
            listContainer.innerHTML = "";
            allFilteredItems = [];
            displayedCount = 0;
            const emptyMsg = ztoolkit.UI.createElement(doc, "div", {
              properties: { innerText: "All papers added!" },
              styles: {
                padding: "30px",
                textAlign: "center",
                color: "var(--text-secondary)",
                fontSize: "13px",
              },
            });
            listContainer.appendChild(emptyMsg);
            if (count > 0) {
              (addAllBtn as HTMLElement).innerText = `✓ Added ${count}`;
              setTimeout(() => {
                (addAllBtn as HTMLElement).innerText = "➕ Add All";
              }, 1500);
            }
          },
        },
      ],
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
        transition: "background-color 0.15s",
      },
      listeners: [
        {
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
          },
        },
      ],
    });
    doneBtn.addEventListener("mouseenter", () => {
      doneBtn.style.backgroundColor = "var(--background-primary)";
    });
    doneBtn.addEventListener("mouseleave", () => {
      doneBtn.style.backgroundColor = "var(--background-secondary)";
    });
    buttonRow.appendChild(doneBtn);
    content.appendChild(buttonRow);

    dropdown.appendChild(content);

    // Insert dropdown after the toolbar
    const toolbar = tabContent.querySelector(".table-toolbar");
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
  private static async generateAllEmptyColumns(
    doc: Document,
    item: Zotero.Item,
  ): Promise<void> {
    Zotero.debug("[seerai] Generate All clicked");

    if (!currentTableConfig) return;

    // Get visible columns and computed columns
    const columns = currentTableConfig.columns || defaultColumns;
    const visibleCols = columns.filter((col) => col.visible);
    const computedCols = visibleCols.filter((col) => col.type === "computed");

    if (computedCols.length === 0) {
      Zotero.debug("[seerai] No computed columns visible");
      return;
    }

    // Find all visible rows
    const table = doc.querySelector(".papers-table");
    if (!table) return;

    const rows = table.querySelectorAll("tr[data-paper-id]");
    if (rows.length === 0) return;

    // Get max concurrent from settings
    const maxConcurrent =
      (Zotero.Prefs.get(
        `${addon.data.config.prefsPrefix}.aiMaxConcurrent`,
      ) as number) || 5;
    Zotero.debug(`[seerai] AI Max concurrent queries: ${maxConcurrent}`);

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
      const paperId = parseInt(tr.getAttribute("data-paper-id") || "0", 10);
      if (!paperId) continue;

      // Get paper item
      const paperItem = Zotero.Items.get(paperId);
      if (!paperItem || !paperItem.isRegularItem()) continue;

      const existingRowData = currentTableData?.rows.find(
        (r) => r.paperId === paperId,
      );

      // Filter by selection if active
      if (
        currentTableData?.selectedRowIds.size &&
        !currentTableData.selectedRowIds.has(paperId)
      ) {
        continue;
      }

      // Check each computed column
      for (const col of computedCols) {
        // Check if cell is empty in DATA
        const val = existingRowData?.data[col.id];
        // If val is undefined or null, it's empty. If it's a string, trim it.
        // Note: For now we only fill empty cells to avoid accidental overwrite.
        if (val && val.toString().trim().length > 0) {
          // Zotero.debug(`[seerai] Skipping ${paperId}/${col.id} - content exists`);
          continue;
        }

        // Calculate correct DOM index
        // In createPapersTable:
        // Index 0: Paper (Title + Author + Year + Sources) - Combined
        // Index 1..N: Other Columns (excluding core columns)
        // Index N+1: Actions

        // Find index of this column in "otherColumns"
        const coreColumnIds = ["title", "author", "year", "sources"];
        const visibleOtherColumns = visibleCols.filter(
          (c) => !coreColumnIds.includes(c.id),
        );
        const otherColIndex = visibleOtherColumns.findIndex(
          (c) => c.id === col.id,
        );

        if (otherColIndex === -1) continue;

        // Map to DOM index (1-based because 0 is "Paper")
        const domIndex = otherColIndex + 1;

        // Target the specific TD
        if (domIndex >= tr.children.length) continue;
        const td = tr.children[domIndex] as HTMLElement;
        if (!td) continue;

        // Add to tasks
        tasks.push({
          paperId,
          col,
          td,
          item: paperItem,
        });

        // Immediate visual feedback
        td.innerHTML = `<span style="color: var(--text-tertiary); font-size: 11px;">⏳ Generating...</span>`;
        td.style.cursor = "wait";
      }
    }

    if (tasks.length === 0) {
      Zotero.debug("[seerai] No empty cells to generate in visible rows");
      return;
    }

    Zotero.debug(`[seerai] ${tasks.length} visible cells to generate`);

    // Update button status
    const generateBtn = doc.getElementById(
      "generate-all-btn",
    ) as HTMLButtonElement | null;
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
        let content = "";

        if (noteIds.length > 0) {
          // Only generate from notes
          content = await this.generateColumnContent(
            task.item,
            task.col,
            noteIds,
          );
        } else {
          // Try to generate from PDF (indexed text or OCR)
          try {
            content = await this.generateFromPDF(task.item, task.col);
          } catch (err) {
            Zotero.debug(
              `[seerai] Failed to generate from PDF for item ${task.paperId}: ${err}`,
            );
          }
        }

        if (content) {
          // Update DOM immediately
          task.td.innerHTML = parseMarkdown(content);
          task.td.style.cursor = "pointer";
          task.td.style.backgroundColor = ""; // Remove any special bg

          // Update Data
          const row = currentTableData?.rows.find(
            (r) => r.paperId === task.paperId,
          );
          if (row) {
            row.data[task.col.id] = content;
          }

          // Persist generated data
          if (currentTableConfig) {
            if (!currentTableConfig.generatedData) {
              currentTableConfig.generatedData = {};
            }
            if (!currentTableConfig.generatedData[task.paperId]) {
              currentTableConfig.generatedData[task.paperId] = {};
            }
            currentTableConfig.generatedData[task.paperId][task.col.id] =
              content;
          }

          generated++;
        } else {
          // No content generated
          task.td.innerHTML = `<span style="color: var(--text-tertiary); font-size: 11px; font-style: italic;">Empty - no notes</span>`;
          task.td.title =
            "No notes found. Use '🔍 Extract with ocr' to create notes first.";
          task.td.style.cursor = "default";
        }
      } catch (e) {
        Zotero.debug(
          `[seerai] Error generating for ${task.paperId}/${task.col.id}: ${e}`,
        );
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

    Zotero.debug(
      `[seerai] Generation complete: ${generated} generated, ${failed} failed`,
    );
  }

  /**
   * Extract text from all visible PDFs that don't have notes
   */
  private static async extractAllEmptyPDFs(
    doc: Document,
    item: Zotero.Item,
  ): Promise<void> {
    Zotero.debug("[seerai] Extract All clicked");

    // Find all visible rows
    const table = doc.querySelector(".papers-table");
    if (!table) return;

    const rows = table.querySelectorAll("tr[data-paper-id]");
    if (rows.length === 0) return;

    // Get max concurrent from settings (OCR-specific setting)
    const maxConcurrent =
      (Zotero.Prefs.get(
        `${addon.data.config.prefsPrefix}.datalabMaxConcurrent`,
      ) as number) || 5;
    Zotero.debug(`[seerai] OCR Max concurrent: ${maxConcurrent}`);

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
      const paperId = parseInt(tr.getAttribute("data-paper-id") || "0", 10);
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
          if (col.type === "computed" && col.visible) {
            const cellVal =
              currentTableData?.rows.find((r) => r.paperId === paperId)?.data[
              col.id
              ] || "";
            if (!cellVal.trim()) {
              // This cell is empty, so it might show the "OCR" prompt
              // Actual index in DOM depends on visible columns
              const visibleIdx = currentTableConfig!.columns
                .filter((c) => c.visible)
                .findIndex((c) => c.id === col.id);
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
        item: paperItem,
      });

      // Immediate feedback
      tds.forEach((td) => {
        td.innerHTML = `<span style="color: var(--text-tertiary); font-size: 11px;">📄 Queued...</span>`;
        td.style.cursor = "wait";
      });
    }

    if (tasks.length === 0) {
      Zotero.debug("[seerai] No PDFs to extract");
      return;
    }

    Zotero.debug(`[seerai] ${tasks.length} PDFs to extract`);

    const extractBtn = doc.getElementById(
      "extract-all-btn",
    ) as HTMLButtonElement | null;
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
        task.tds.forEach((td) => {
          td.innerHTML = `<span style="color: var(--highlight-primary); font-size: 11px;">📄 OCR Processing...</span>`;
        });

        // Run silent OCR
        await ocrService.convertToMarkdown(task.pdf, { showProgress: false });

        // Update cells to "Done"
        task.tds.forEach((td) => {
          td.innerHTML = `<span style="color: green; font-size: 11px;">✓ Note Extracted</span>`;
        });
        success++;
      } catch (e) {
        Zotero.debug(`[seerai] OCR Error for ${task.paperId}: ${e}`);
        task.tds.forEach((td) => {
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
   * Search for PDFs for all table items that don't have PDF attachments
   * Processes items sequentially (one at a time) through the 6-step pipeline
   */
  private static async searchAllPdfsInTable(
    doc: Document,
    btn: HTMLElement,
  ): Promise<void> {
    Zotero.debug("[seerai] Search all PDF clicked");

    // Find all visible rows
    const table = doc.querySelector(".papers-table");
    if (!table) return;

    const rows = table.querySelectorAll("tr[data-paper-id]");
    if (rows.length === 0) return;

    // Build list of items without PDF
    interface SearchTask {
      paperId: number;
      item: Zotero.Item;
    }
    const tasks: SearchTask[] = [];

    for (let i = 0; i < rows.length; i++) {
      const tr = rows[i] as HTMLElement;
      const paperId = parseInt(tr.getAttribute("data-paper-id") || "0", 10);
      if (!paperId) continue;

      const item = Zotero.Items.get(paperId);
      if (!item || !item.isRegularItem()) continue;

      // Check if has PDF already
      const attachments = item.getAttachments() || [];
      const hasPdf = attachments.some((attId: number) => {
        const att = Zotero.Items.get(attId);
        return (
          att &&
          (att.attachmentContentType === "application/pdf" ||
            att.attachmentPath?.toLowerCase().endsWith(".pdf"))
        );
      });

      if (!hasPdf) {
        // Check if has identifiers for search
        const doi = item.getField("DOI") as string;
        const arxivId = extractArxivFromItem(item);
        const pmid = extractPmidFromItem(item);
        const title = item.getField("title") as string;

        // Allow search if we have IDs OR at least a title (for Firecrawl/SS fallback)
        if (doi || arxivId || pmid || title) {
          tasks.push({ paperId, item });
        }
      }
    }

    if (tasks.length === 0) {
      Zotero.debug("[seerai] No items without PDF to search");
      btn.innerText = "✓ All have PDFs";
      setTimeout(() => {
        btn.innerText = "🔍 Search all PDF";
      }, 2000);
      return;
    }

    Zotero.debug(`[seerai] ${tasks.length} items to search for PDFs`);

    const originalBtnText = btn.innerText;
    let completed = 0;
    let found = 0;

    // Process sequentially (one at a time)
    for (const task of tasks) {
      completed++;
      btn.innerText = `🔍 Searching ${completed}/${tasks.length}...`;
      (btn as HTMLButtonElement).disabled = true;
      btn.style.cursor = "wait";

      // Find the table row and computed cells for this item
      const tr = doc.querySelector(`tr[data-paper-id="${task.paperId}"]`);
      const computedCells = tr ? tr.querySelectorAll("td") : [];

      try {
        const success = await findAndAttachPdfForItem(task.item, (step) => {
          btn.innerText = `🔍 ${completed}/${tasks.length} ${step}`;
        });
        if (success) {
          found++;
          Zotero.debug(`[seerai] Found PDF for item ${task.paperId}`);
          // Update computed column cells to show "📄 Process PDF"
          computedCells.forEach((td: Element) => {
            const content = String(td.innerHTML);
            if (
              content.includes("Search PDF") ||
              content.includes("Source-Link") ||
              content.includes("Searching")
            ) {
              (td as HTMLElement).innerHTML =
                `<span style="color: var(--highlight-primary); font-size: 11px;">📄 Process PDF</span>`;
            }
          });
        } else {
          // Update cells to show fallback buttons (SS and Firecrawl)
          computedCells.forEach((td: Element) => {
            const content = String(td.innerHTML);
            if (
              content.includes("Search PDF") ||
              content.includes("Searching")
            ) {
              const cell = td as HTMLElement;
              cell.innerHTML = "";

              const container = doc.createElement("div");
              container.className = "fallback-actions";
              container.style.display = "flex";
              container.style.gap = "6px";
              container.style.justifyContent = "center";
              container.style.alignItems = "center";

              // 1. Semantic Scholar Link
              const ssLink = doc.createElement("a");
              ssLink.innerText = "[Semantic Search]";
              ssLink.title = "Search Metadata and PDF on Semantic Scholar";
              ssLink.style.color = "var(--highlight-primary)";
              ssLink.style.cursor = "pointer";
              ssLink.style.fontSize = "10px";
              ssLink.style.textDecoration = "underline";
              ssLink.onclick = (e) => {
                e.stopPropagation();
                Assistant.searchSemanticScholarForTableItem(task.item, ssLink);
              };
              container.appendChild(ssLink);

              // 2. Firecrawl Link (if configured)
              if (firecrawlService.isConfigured()) {
                const fireLink = doc.createElement("a");
                fireLink.innerText = "[Firecrawl Search]";
                fireLink.title = "Deep web search for PDF via Firecrawl";
                fireLink.style.color = "var(--highlight-primary)";
                fireLink.style.cursor = "pointer";
                fireLink.style.fontSize = "10px";
                fireLink.style.textDecoration = "underline";
                fireLink.style.marginLeft = "4px";
                fireLink.onclick = (e) => {
                  e.stopPropagation();
                  Assistant.searchFirecrawlForTableItem(task.item, fireLink);
                };
                container.appendChild(fireLink);
              }

              // 3. Keep Source Link if available (small icon) can be added here if needed,
              // but user requested just SS and Firecrawl buttons in the prompt.

              cell.appendChild(container);
            }
          });
        }
      } catch (e) {
        Zotero.debug(`[seerai] Search error for ${task.paperId}: ${e}`);
      }
    }

    // Restore button
    btn.innerText = `✓ Found ${found}/${tasks.length}`;
    (btn as HTMLButtonElement).disabled = false;
    btn.style.cursor = "pointer";
    setTimeout(() => {
      btn.innerText = originalBtnText;
    }, 3000);
  }

  /**
   * Helper: Search Semantic Scholar for a table item (fallback interaction)
   * Parses metadata from SS results (DOI, PMID, ArXiv) and uses them for full PDF discovery
   */
  private static async searchSemanticScholarForTableItem(
    item: Zotero.Item,
    btn: HTMLElement,
  ): Promise<void> {
    const originalText = btn.innerText;
    btn.innerHTML = "⏳";
    (btn as HTMLButtonElement).disabled = true;
    btn.style.cursor = "wait";

    try {
      // Get query
      const title = item.getField("title") as string;
      if (!title) {
        btn.title = "No title to search";
        btn.innerText = "❌";
        return;
      }

      // Search SS
      const results = await semanticScholarService.searchPapers({
        query: title,
        limit: 1,
      });
      if (results && results.data.length > 0) {
        const paper = results.data[0];
        let pdfAttached = false;

        // Extract identifiers from SS result
        const discoveredDoi = paper.externalIds?.DOI;
        const discoveredPmid = paper.externalIds?.PMID;
        const discoveredArxivId = paper.externalIds?.ArXiv;

        Zotero.debug(
          `[seerai] SS found identifiers - DOI: ${discoveredDoi}, PMID: ${discoveredPmid}, ArXiv: ${discoveredArxivId}`,
        );

        // Update Zotero item metadata if missing
        let metadataUpdated = false;
        if (discoveredDoi && !item.getField("DOI")) {
          item.setField("DOI", discoveredDoi);
          metadataUpdated = true;
          Zotero.debug(`[seerai] Updated item DOI: ${discoveredDoi}`);
        }
        // PMID and ArXiv are typically stored in 'extra' field
        const currentExtra = (item.getField("extra") as string) || "";
        if (discoveredPmid && !currentExtra.includes("PMID:")) {
          item.setField(
            "extra",
            currentExtra +
            (currentExtra ? "\n" : "") +
            `PMID: ${discoveredPmid}`,
          );
          metadataUpdated = true;
          Zotero.debug(`[seerai] Updated item PMID: ${discoveredPmid}`);
        }
        if (discoveredArxivId && !currentExtra.includes("arXiv:")) {
          const extra = (item.getField("extra") as string) || "";
          item.setField(
            "extra",
            extra + (extra ? "\n" : "") + `arXiv: ${discoveredArxivId}`,
          );
          metadataUpdated = true;
          Zotero.debug(`[seerai] Updated item ArXiv: ${discoveredArxivId}`);
        }
        if (metadataUpdated) {
          await item.saveTx();
          Zotero.debug(`[seerai] Saved updated metadata for item`);
        }

        // Step 1: Try SS Open Access PDF first
        if (paper.openAccessPdf?.url) {
          btn.innerText = "📥 SS PDF...";
          const attached = await downloadAndAttachPdf(
            item,
            paper.openAccessPdf.url,
          );
          if (attached) {
            pdfAttached = true;
            btn.innerText = "✓";
            btn.title = "PDF Attached from Semantic Scholar!";

            // Update cell to show "Process PDF"
            const tr = btn.closest("tr");
            if (tr) {
              const cells = tr.querySelectorAll("td");
              cells.forEach((td: HTMLElement) => {
                if (td.contains(btn)) {
                  td.innerHTML = `<span style="color: var(--highlight-primary); font-size: 11px;">📄 Process PDF</span>`;
                }
              });
            }
            return;
          }
        }

        // Step 2: Run full PDF discovery pipeline with updated item (now has identifiers)
        if (!pdfAttached) {
          btn.innerText = "🔍 Searching...";
          const success = await findAndAttachPdfForItem(item, (step) => {
            // Truncate step text to fit in button
            btn.innerText = step.length > 15 ? step.slice(0, 15) + "..." : step;
          });
          if (success) {
            btn.innerText = "✓";
            btn.title = "PDF Attached via discovery pipeline!";
            pdfAttached = true;

            // Update cell to show "Process PDF"
            const tr = btn.closest("tr");
            if (tr) {
              const cells = tr.querySelectorAll("td");
              cells.forEach((td: HTMLElement) => {
                if (td.contains(btn)) {
                  td.innerHTML = `<span style="color: var(--highlight-primary); font-size: 11px;">📄 Process PDF</span>`;
                }
              });
            }
            return;
          }
        }

        // Fallback to launching URL if all PDF attempts failed
        if (!pdfAttached && paper.url) {
          Zotero.launchURL(paper.url);
          btn.innerText = "📖";
          btn.title = "Opened Semantic Scholar page (no PDF found)";
        } else if (!pdfAttached) {
          btn.title = "No PDF found via any source";
          btn.innerText = "❌";
        }
      } else {
        btn.title = "Not found on Semantic Scholar";
        btn.innerText = "❌";
      }
    } catch (e) {
      Zotero.debug(`[seerai] SS Search error: ${e}`);
      btn.title = `Error: ${e}`;
      btn.innerText = "⚠️";
    } finally {
      if (
        btn.innerText === "⏳" ||
        btn.innerText.includes("📥") ||
        btn.innerText.includes("🔍")
      ) {
        btn.innerText = originalText;
      }
      (btn as HTMLButtonElement).disabled = false;
      btn.style.cursor = "pointer";
    }
  }

  /**
   * Helper: Interactive Firecrawl search for table item
   */
  private static async searchFirecrawlForTableItem(
    item: Zotero.Item,
    btn: HTMLElement,
  ): Promise<void> {
    const originalText = btn.innerText;
    btn.innerHTML = "⏳";
    (btn as HTMLButtonElement).disabled = true;
    btn.style.cursor = "wait";

    try {
      const title = item.getField("title") as string;
      const doi = (item.getField("DOI") as string) || undefined;
      // Get creators
      const creators = item.getCreators();
      const authors = creators.map((c) =>
        `${c.firstName || ""} ${c.lastName || ""}`.trim(),
      );

      // Search
      const result = await firecrawlService.researchSearch(title, authors, doi);

      if (
        result &&
        (result.status === "pdf_found" || result.status === "page_found")
      ) {
        const url = result.pdfUrl || result.pageUrl;
        if (url) {
          const doc = btn.ownerDocument;
          const win = doc?.defaultView;
          if (win) {
            const choice = win.confirm(
              `Firecrawl found: ${url}\n\nDo you want to attach this file?`,
            );
            if (choice) {
              btn.innerText = "📥";
              await Zotero.Attachments.importFromURL({
                url: url,
                parentItemID: item.id,
                title: "firecrawl_found.pdf",
                contentType: "application/pdf",
              });
              // Update UI to "Process PDF" on success
              const cell = btn.parentElement?.parentElement;
              if (cell) {
                cell.innerHTML = `<span style="color: var(--highlight-primary); font-size: 11px;">📄 Process PDF</span>`;
              }
            } else {
              // User cancelled, revert button
              btn.innerText = originalText;
            }
          }
        } else {
          btn.title = "No suitable URL found";
          btn.innerText = "❌";
        }
      } else {
        btn.title = "Not found via Firecrawl";
        btn.innerText = "❌";
      }
    } catch (e) {
      Zotero.debug(`[seerai] Firecrawl search error: ${e}`);
      btn.title = `Error: ${e}`;
      btn.innerText = "⚠️";
    } finally {
      if (btn.innerText === "⏳") btn.innerText = originalText;
      (btn as HTMLButtonElement).disabled = false;
      btn.style.cursor = "pointer";
    }
  }

  /**
   * Generate content for a single cell
   */
  private static async generateCellContent(
    doc: Document,
    row: TableRow,
    col: TableColumn,
    td: HTMLElement,
  ): Promise<void> {
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
      Zotero.debug(`[seerai] Cell generation error: ${e}`);
    }
  }

  /**
   * Extract text from PDF and generate content
   */
  private static async extractPDFAndGenerate(
    doc: Document,
    row: TableRow,
    col: TableColumn,
    td: HTMLElement,
  ): Promise<void> {
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
        if (att && att.attachmentContentType === "application/pdf") {
          // Try to get full-text content (Zotero indexes PDFs)
          try {
            // Try different Zotero Fulltext APIs (varies by version)
            let fullText = "";
            if ((Zotero.Fulltext as any).getItemContent) {
              const content = await (Zotero.Fulltext as any).getItemContent(
                att.id,
              );
              fullText = content?.content || "";
            } else if ((Zotero.Fulltext as any).getTextForItem) {
              fullText =
                (await (Zotero.Fulltext as any).getTextForItem(att.id)) || "";
            }
            if (fullText) {
              pdfText += fullText; // Use full context - no limit
              break;
            }
          } catch (e) {
            Zotero.debug(`[seerai] Error getting fulltext: ${e}`);
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

      const content = await this.generateColumnContentFromText(
        item,
        col,
        pdfText,
      );

      // Update cell display
      td.innerText = content || "(No content generated)";
      td.style.cursor = "default";
      td.style.backgroundColor = "";

      // Update row data
      row.data[col.id] = content;
    } catch (e) {
      td.innerHTML = `<span style="color: #c62828; font-size: 11px;">Error: ${e}</span>`;
      td.style.cursor = "pointer";
      Zotero.debug(`[seerai] PDF extraction error: ${e}`);
    }
  }

  /**
   * Generate table data for specified items and columns (public for agent tools)
   * This runs AI analysis and saves results to the table config
   */
  public static async generateDataForTable(
    tableId: string,
    itemIds?: number[],
    columnIds?: string[]
  ): Promise<{ generatedCount: number; errors: string[] }> {
    const tableStore = getTableStore();
    const allTables = await tableStore.getAllTables();
    const table = allTables.find(t => t.id === tableId);

    if (!table) {
      throw new Error(`Table ${tableId} not found`);
    }

    const errors: string[] = [];
    let generatedCount = 0;

    // Determine which items to process
    const items = itemIds || table.addedPaperIds || [];

    // Determine which columns to generate (AI columns only)
    const columnsToGenerate = columnIds
      ? table.columns.filter((c: TableColumn) => columnIds.includes(c.id))
      : table.columns.filter((c: TableColumn) => c.type === 'computed' || c.aiPrompt);

    if (columnsToGenerate.length === 0 || items.length === 0) {
      return { generatedCount: 0, errors: [] };
    }

    Zotero.debug(
      `[seerai] generateDataForTable: ${items.length} items × ${columnsToGenerate.length} columns`
    );

    // Initialize generatedData if needed
    if (!table.generatedData) {
      table.generatedData = {};
    }

    // Process each item/column combination
    for (const paperId of items) {
      const item = Zotero.Items.get(paperId);
      if (!item) {
        errors.push(`Item ${paperId} not found`);
        continue;
      }

      // Initialize data for this paper
      if (!table.generatedData[paperId]) {
        table.generatedData[paperId] = {};
      }

      // Get note content for this item
      let noteContent = "";
      const childNotes = item.getNotes();
      for (const noteId of childNotes) {
        const noteItem = Zotero.Items.get(noteId);
        if (noteItem) {
          const noteHTML = noteItem.getNote();
          noteContent += this.stripHtml(noteHTML) + "\n\n";
        }
      }

      // Try to get PDF text if no notes
      if (!noteContent.trim()) {
        const attachmentIds = item.getAttachments();
        for (const attId of attachmentIds) {
          const att = Zotero.Items.get(attId);
          if (att && att.attachmentContentType === "application/pdf") {
            try {
              if ((Zotero.Fulltext as any).getItemContent) {
                const content = await (Zotero.Fulltext as any).getItemContent(att.id);
                noteContent = content?.content || "";
              } else if ((Zotero.Fulltext as any).getTextForItem) {
                noteContent = await (Zotero.Fulltext as any).getTextForItem(att.id) || "";
              }
              if (noteContent) break;
            } catch (e) {
              Zotero.debug(`[seerai] Error getting fulltext: ${e}`);
            }
          }
        }
      }

      if (!noteContent.trim()) {
        errors.push(`No content available for item ${paperId}`);
        continue;
      }

      // Generate data for each column
      for (const col of columnsToGenerate) {
        try {
          // Create a TableColumn object for the generation
          const tableCol: TableColumn = {
            id: col.id,
            name: col.name,
            width: col.width || 150,
            minWidth: col.minWidth || 80,
            visible: true,
            sortable: false,
            resizable: true,
            type: col.type || 'computed',
            aiPrompt: col.aiPrompt
          };

          const content = await this.generateColumnContentFromText(
            item,
            tableCol,
            noteContent
          );

          table.generatedData![paperId]![col.id] = content;
          generatedCount++;

          Zotero.debug(
            `[seerai] Generated: item=${paperId} col=${col.name} length=${content.length}`
          );
        } catch (e) {
          const errMsg = `Error generating ${col.name} for item ${paperId}: ${e}`;
          errors.push(errMsg);
          Zotero.debug(`[seerai] ${errMsg}`);
        }
      }
    }

    // Save the updated table config
    await tableStore.saveConfig(table);
    Zotero.debug(`[seerai] Saved generatedData for table ${tableId}`);

    return { generatedCount, errors };
  }

  /**
   * Generate column content using AI
   */
  private static async generateColumnContent(
    item: Zotero.Item,
    col: TableColumn,
    noteIds: number[],
  ): Promise<string> {
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
    const paperTitle = (item.getField("title") as string) || "Untitled";
    const creators = item.getCreators();
    const authors = creators
      .map((c) => `${c.firstName || ""} ${c.lastName || ""}`.trim())
      .join(", ");

    return this.generateColumnContentFromText(item, col, noteContent);
  }

  /**
   * Generate column content from text using AI
   */
  private static async generateColumnContentFromText(
    item: Zotero.Item,
    col: TableColumn,
    sourceText: string,
  ): Promise<string> {
    const paperTitle = (item.getField("title") as string) || "Untitled";
    const responseLength = currentTableConfig?.responseLength || 100;

    // Build a targeted prompt using column title and description
    const lengthInstruction =
      responseLength === 0 ? "" : `Be concise (max ${responseLength} words).`;

    let columnPrompt = "";
    if (col.aiPrompt) {
      // Use both column name (title) and aiPrompt (description)
      columnPrompt = `For the column "${col.name}": ${col.aiPrompt} ${lengthInstruction}`;
    } else {
      // Fallback prompts for known columns
      switch (col.id) {
        case "analysisMethodology":
          columnPrompt = `For the column "${col.name}": Identify and briefly describe the analysis methodology or research method used in this paper. ${lengthInstruction}`;
          break;
        default:
          columnPrompt = `For the column "${col.name}": Extract relevant information. ${lengthInstruction}`;
      }
    }

    const systemPrompt = `You are extracting structured information from academic papers for a research table. Be concise and factual. Return ONLY the requested information, no explanations or preamble.`;

    const userPrompt = `Paper: "${paperTitle}"

Source content:
${sourceText}

Task: ${columnPrompt}`;

    // Get active model config (same as chat uses)
    const activeModel = getActiveModelConfig();
    if (!activeModel) {
      throw new Error(
        "No active model configured. Please set up a model in settings.",
      );
    }

    const configOverride = {
      apiURL: activeModel.apiURL,
      apiKey: activeModel.apiKey,
      model: activeModel.model,
    };

    // Use non-streaming completion for simpler cell generation
    try {
      const messages: OpenAIMessage[] = [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ];

      // Use chatCompletionStream but collect the full response
      let fullResponse = "";
      await openAIService.chatCompletionStream(
        messages,
        {
          onToken: (token) => {
            fullResponse += token;
          },
          onComplete: () => { },
          onError: (err) => {
            throw err;
          },
        },
        configOverride,
      );

      return fullResponse.trim();
    } catch (e) {
      Zotero.debug(`[seerai] AI generation error: ${e}`);
      throw e;
    }
  }

  /**
   * Show cell detail modal for viewing/generating content
   */
  private static showCellDetailModal(
    doc: Document,
    row: TableRow,
    col: TableColumn,
    currentValue: string,
  ): void {
    // Remove any existing modal
    const existing = doc.getElementById("cell-detail-modal");
    if (existing) existing.remove();

    const win = doc.defaultView;
    const isDarkMode =
      (win as any)?.matchMedia?.("(prefers-color-scheme: dark)").matches ??
      false;
    const isComputed = col.type === "computed";
    const hasNotes = row.noteIds && row.noteIds.length > 0;

    // Check for PDF
    const item = Zotero.Items.get(row.paperId);
    const attachments = item?.getAttachments() || [];
    const hasPDF = attachments.some((attId: number) => {
      const att = Zotero.Items.get(attId);
      return att && att.attachmentContentType === "application/pdf";
    });

    // Create overlay
    const overlay = ztoolkit.UI.createElement(doc, "div", {
      properties: { id: "cell-detail-modal" },
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
        zIndex: "10000",
      },
    });

    // Create dialog
    const dialog = ztoolkit.UI.createElement(doc, "div", {
      styles: {
        backgroundColor: `var(--background-primary, ${isDarkMode ? "#333" : "#fafafa"})`,
        color: `var(--text-primary, ${isDarkMode ? "#eee" : "#212121"})`,
        borderRadius: "12px",
        padding: "20px",
        maxWidth: "600px",
        width: "90%",
        maxHeight: "70vh",
        display: "flex",
        flexDirection: "column",
        gap: "16px",
        boxShadow: "0 8px 32px rgba(0,0,0,0.3)",
      },
    });

    // Header
    const header = ztoolkit.UI.createElement(doc, "div", {
      styles: {
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
      },
    });
    const title = ztoolkit.UI.createElement(doc, "div", {
      properties: { innerText: col.name },
      styles: { fontSize: "16px", fontWeight: "600" },
    });
    header.appendChild(title);

    const closeX = ztoolkit.UI.createElement(doc, "button", {
      properties: { innerText: "✕" },
      styles: {
        background: "none",
        border: "none",
        fontSize: "18px",
        cursor: "pointer",
        color: "var(--text-secondary)",
      },
      listeners: [{ type: "click", listener: () => overlay.remove() }],
    });
    header.appendChild(closeX);
    dialog.appendChild(header);

    // Paper info
    const paperInfo = ztoolkit.UI.createElement(doc, "div", {
      properties: { innerText: row.paperTitle },
      styles: {
        fontSize: "13px",
        color: "var(--text-secondary)",
        fontStyle: "italic",
      },
    });
    dialog.appendChild(paperInfo);

    // Mode toggle (Preview / Edit)
    let isEditMode = !currentValue; // Start in edit mode if empty, preview if has content

    const modeToggle = ztoolkit.UI.createElement(doc, "div", {
      styles: {
        display: "flex",
        gap: "4px",
        marginBottom: "8px",
      },
    });

    const previewBtn = ztoolkit.UI.createElement(doc, "button", {
      properties: { innerText: "👁 Preview" },
      styles: {
        padding: "6px 12px",
        border: "1px solid var(--border-primary)",
        borderRadius: "4px",
        backgroundColor: !isEditMode
          ? "var(--highlight-primary)"
          : "var(--background-secondary)",
        color: !isEditMode ? "var(--highlight-text)" : "var(--text-primary)",
        cursor: "pointer",
        fontSize: "12px",
      },
    });

    const editBtn = ztoolkit.UI.createElement(doc, "button", {
      properties: { innerText: "✏️ Edit" },
      styles: {
        padding: "6px 12px",
        border: "1px solid var(--border-primary)",
        borderRadius: "4px",
        backgroundColor: isEditMode
          ? "var(--highlight-primary)"
          : "var(--background-secondary)",
        color: isEditMode ? "var(--highlight-text)" : "var(--text-primary)",
        cursor: "pointer",
        fontSize: "12px",
      },
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
        flexDirection: "column",
      },
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
        display: isEditMode ? "none" : "block",
      },
    });
    previewArea.innerHTML = currentValue
      ? parseMarkdown(currentValue)
      : '<span style="color: var(--text-tertiary); font-style: italic;">No content yet</span>';

    // Content area (editable textarea)
    const contentArea = ztoolkit.UI.createElement(doc, "textarea", {
      properties: { value: currentValue || "" },
      styles: {
        flex: "1",
        minHeight: "200px",
        padding: "12px",
        border: "1px solid var(--border-primary)",
        borderRadius: "8px",
        resize: "vertical",
        fontSize: "13px",
        lineHeight: "1.6",
        fontFamily: "inherit",
        backgroundColor: "var(--background-secondary)",
        display: isEditMode ? "block" : "none",
      },
    }) as HTMLTextAreaElement;

    contentContainer.appendChild(previewArea);
    contentContainer.appendChild(contentArea);

    // Toggle handlers
    const updateModeStyles = () => {
      previewBtn.style.backgroundColor = !isEditMode
        ? "var(--highlight-primary)"
        : "var(--background-secondary)";
      previewBtn.style.color = !isEditMode
        ? "var(--highlight-text)"
        : "var(--text-primary)";
      editBtn.style.backgroundColor = isEditMode
        ? "var(--highlight-primary)"
        : "var(--background-secondary)";
      editBtn.style.color = isEditMode
        ? "var(--highlight-text)"
        : "var(--text-primary)";
      previewArea.style.display = isEditMode ? "none" : "block";
      contentArea.style.display = isEditMode ? "block" : "none";
    };

    previewBtn.addEventListener("click", () => {
      // Update preview with current textarea content before switching
      previewArea.innerHTML = contentArea.value
        ? parseMarkdown(contentArea.value)
        : '<span style="color: var(--text-tertiary); font-style: italic;">No content yet</span>';
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
      styles: {
        display: "flex",
        gap: "8px",
        justifyContent: "flex-end",
        flexWrap: "wrap",
      },
    });

    // Generate button (only for computed columns with sources)
    if (isComputed) {
      if (hasNotes || hasPDF) {
        const genBtn = ztoolkit.UI.createElement(doc, "button", {
          properties: {
            innerText: hasNotes
              ? "⚡ Generate from Notes"
              : "📄 Generate from PDF",
          },
          styles: {
            padding: "10px 16px",
            border: "none",
            borderRadius: "6px",
            backgroundColor: "var(--highlight-primary)",
            color: "var(--highlight-text)",
            cursor: "pointer",
            fontWeight: "500",
          },
          listeners: [
            {
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
                  previewArea.innerHTML = content
                    ? parseMarkdown(content)
                    : '<span style="color: var(--text-tertiary); font-style: italic;">No content generated</span>';
                } catch (e) {
                  contentArea.value = `Error: ${e}`;
                  previewArea.innerHTML = `<span style="color: #c62828;">Error: ${e}</span>`;
                }
                genBtn.innerText = hasNotes ? "⚡ Regenerate" : "📄 Regenerate";
                (genBtn as HTMLButtonElement).disabled = false;
              },
            },
          ],
        });
        buttonRow.appendChild(genBtn);
      } else {
        const noSourceMsg = ztoolkit.UI.createElement(doc, "span", {
          properties: { innerText: "No notes or PDFs to generate from" },
          styles: {
            fontSize: "12px",
            color: "var(--text-tertiary)",
            alignSelf: "center",
          },
        });
        buttonRow.appendChild(noSourceMsg);
      }
    }

    // Copy button
    const copyBtn = ztoolkit.UI.createElement(doc, "button", {
      properties: { innerText: "📋 Copy" },
      styles: {
        padding: "10px 16px",
        border: "1px solid var(--border-primary)",
        borderRadius: "6px",
        backgroundColor: "var(--background-secondary)",
        color: "var(--text-primary)",
        cursor: "pointer",
      },
      listeners: [
        {
          type: "click",
          listener: () => {
            this.copyToClipboard(contentArea.value, copyBtn);
          },
        },
      ],
    });
    buttonRow.appendChild(copyBtn);

    // Save as Note button
    const saveAsNoteBtn = ztoolkit.UI.createElement(doc, "button", {
      properties: { innerText: "📝 Save as Note" },
      attributes: { title: "Save content as a new note" },
      styles: {
        padding: "10px 16px",
        border: "1px solid var(--border-primary)",
        borderRadius: "6px",
        backgroundColor: "var(--background-secondary)",
        color: "var(--text-primary)",
        cursor: "pointer",
      },
      listeners: [
        {
          type: "click",
          listener: async () => {
            const originalText = saveAsNoteBtn.innerText;
            saveAsNoteBtn.innerText = "⏳ Saving...";
            saveAsNoteBtn.style.cursor = "wait";

            try {
              const item = Zotero.Items.get(row.paperId);
              if (item) {
                const note = new Zotero.Item("note");
                note.libraryID = item.libraryID;
                note.parentID = item.id;
                const noteContent = `<h1>${col.name}</h1>\n${parseMarkdown(contentArea.value)}`;
                note.setNote(noteContent);
                await note.saveTx();

                saveAsNoteBtn.innerText = "✓ Saved";
                setTimeout(() => {
                  saveAsNoteBtn.innerText = originalText;
                  saveAsNoteBtn.style.cursor = "pointer";
                }, 2000);
              } else {
                throw new Error("Item not found");
              }
            } catch (e) {
              saveAsNoteBtn.innerText = "❌ Error";
              Zotero.debug(`[seerai] Error saving as note: ${e}`);
              setTimeout(() => {
                saveAsNoteBtn.innerText = originalText;
                saveAsNoteBtn.style.cursor = "pointer";
              }, 2000);
            }
          },
        },
      ],
    });
    buttonRow.appendChild(saveAsNoteBtn);

    // Save button
    const saveBtn = ztoolkit.UI.createElement(doc, "button", {
      properties: { innerText: "💾 Save" },
      styles: {
        padding: "10px 16px",
        border: "1px solid var(--border-primary)",
        borderRadius: "6px",
        backgroundColor: "var(--background-secondary)",
        color: "var(--text-primary)",
        cursor: "pointer",
      },
      listeners: [
        {
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
          },
        },
      ],
    });
    buttonRow.appendChild(saveBtn);

    // Cancel button
    const cancelBtn = ztoolkit.UI.createElement(doc, "button", {
      properties: { innerText: "Cancel" },
      styles: {
        padding: "10px 16px",
        border: "1px solid var(--border-primary)",
        borderRadius: "6px",
        backgroundColor: "var(--background-primary)",
        cursor: "pointer",
      },
      listeners: [{ type: "click", listener: () => overlay.remove() }],
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
   * Show cell detail modal for search results (Analysis Columns)
   */
  private static showSearchCellDetailModal(
    doc: Document,
    paper: SemanticScholarPaper,
    col: SearchAnalysisColumn,
    currentValue: string,
    resultsContainer: HTMLElement,
    item: Zotero.Item,
  ): void {
    const existing = doc.getElementById("search-cell-detail-modal");
    if (existing) existing.remove();

    const win = doc.defaultView;
    const isDarkMode =
      (win as any)?.matchMedia?.("(prefers-color-scheme: dark)").matches ??
      false;

    const overlay = ztoolkit.UI.createElement(doc, "div", {
      properties: { id: "search-cell-detail-modal" },
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
        zIndex: "10000",
      },
    });

    const dialog = ztoolkit.UI.createElement(doc, "div", {
      styles: {
        backgroundColor: `var(--background-primary, ${isDarkMode ? "#333" : "#fafafa"})`,
        color: `var(--text-primary, ${isDarkMode ? "#eee" : "#212121"})`,
        borderRadius: "12px",
        padding: "20px",
        maxWidth: "600px",
        width: "90%",
        maxHeight: "70vh",
        display: "flex",
        flexDirection: "column",
        gap: "16px",
        boxShadow: "0 8px 32px rgba(0,0,0,0.3)",
      },
    });

    // Header
    const header = ztoolkit.UI.createElement(doc, "div", {
      styles: {
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
      },
    });
    const title = ztoolkit.UI.createElement(doc, "div", {
      properties: { innerText: col.name },
      styles: { fontSize: "16px", fontWeight: "600" },
    });
    header.appendChild(title);

    const closeX = ztoolkit.UI.createElement(doc, "button", {
      properties: { innerText: "✕" },
      styles: {
        background: "none",
        border: "none",
        fontSize: "18px",
        cursor: "pointer",
        color: "var(--text-secondary)",
      },
      listeners: [{ type: "click", listener: () => overlay.remove() }],
    });
    header.appendChild(closeX);
    dialog.appendChild(header);

    // Paper info
    const paperInfo = ztoolkit.UI.createElement(doc, "div", {
      properties: { innerText: paper.title },
      styles: {
        fontSize: "13px",
        color: "var(--text-secondary)",
        fontStyle: "italic",
      },
    });
    dialog.appendChild(paperInfo);

    // Mode toggle
    let isEditMode = !currentValue;
    const modeToggle = ztoolkit.UI.createElement(doc, "div", {
      styles: { display: "flex", gap: "4px", marginBottom: "8px" },
    });

    const previewBtn = ztoolkit.UI.createElement(doc, "button", {
      properties: { innerText: "👁 Preview" },
      styles: {
        padding: "6px 12px",
        border: "1px solid var(--border-primary)",
        borderRadius: "4px",
        backgroundColor: !isEditMode
          ? "var(--highlight-primary)"
          : "var(--background-secondary)",
        color: !isEditMode ? "var(--highlight-text)" : "var(--text-primary)",
        cursor: "pointer",
        fontSize: "12px",
      },
    });

    const editBtn = ztoolkit.UI.createElement(doc, "button", {
      properties: { innerText: "✏️ Edit" },
      styles: {
        padding: "6px 12px",
        border: "1px solid var(--border-primary)",
        borderRadius: "4px",
        backgroundColor: isEditMode
          ? "var(--highlight-primary)"
          : "var(--background-secondary)",
        color: isEditMode ? "var(--highlight-text)" : "var(--text-primary)",
        cursor: "pointer",
        fontSize: "12px",
      },
    });

    modeToggle.appendChild(previewBtn);
    modeToggle.appendChild(editBtn);
    dialog.appendChild(modeToggle);

    // Content container
    const contentContainer = ztoolkit.UI.createElement(doc, "div", {
      styles: {
        flex: "1",
        minHeight: "200px",
        display: "flex",
        flexDirection: "column",
      },
    });

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
        display: isEditMode ? "none" : "block",
      },
    });
    previewArea.innerHTML = currentValue
      ? parseMarkdown(currentValue)
      : '<span style="color: var(--text-tertiary); font-style: italic;">No content yet</span>';

    const contentArea = ztoolkit.UI.createElement(doc, "textarea", {
      properties: { value: currentValue || "" },
      styles: {
        flex: "1",
        minHeight: "200px",
        padding: "12px",
        border: "1px solid var(--border-primary)",
        borderRadius: "8px",
        resize: "vertical",
        fontSize: "13px",
        lineHeight: "1.6",
        fontFamily: "inherit",
        backgroundColor: "var(--background-secondary)",
        display: isEditMode ? "block" : "none",
      },
    }) as HTMLTextAreaElement;

    contentContainer.appendChild(previewArea);
    contentContainer.appendChild(contentArea);
    dialog.appendChild(contentContainer);

    // Toggle handlers
    const updateModeStyles = () => {
      previewBtn.style.backgroundColor = !isEditMode
        ? "var(--highlight-primary)"
        : "var(--background-secondary)";
      previewBtn.style.color = !isEditMode
        ? "var(--highlight-text)"
        : "var(--text-primary)";
      editBtn.style.backgroundColor = isEditMode
        ? "var(--highlight-primary)"
        : "var(--background-secondary)";
      editBtn.style.color = isEditMode
        ? "var(--highlight-text)"
        : "var(--text-primary)";
      previewArea.style.display = isEditMode ? "none" : "block";
      contentArea.style.display = isEditMode ? "block" : "none";
    };

    previewBtn.addEventListener("click", () => {
      previewArea.innerHTML = contentArea.value
        ? parseMarkdown(contentArea.value)
        : '<span style="color: var(--text-tertiary); font-style: italic;">No content yet</span>';
      isEditMode = false;
      updateModeStyles();
    });

    editBtn.addEventListener("click", () => {
      isEditMode = true;
      updateModeStyles();
      contentArea.focus();
    });

    // Button row
    const buttonRow = ztoolkit.UI.createElement(doc, "div", {
      styles: {
        display: "flex",
        gap: "8px",
        justifyContent: "flex-end",
      },
    });

    // Copy button
    const copyBtn = ztoolkit.UI.createElement(doc, "button", {
      properties: { innerText: "📋 Copy" },
      styles: {
        padding: "10px 16px",
        border: "1px solid var(--border-primary)",
        borderRadius: "6px",
        backgroundColor: "var(--background-secondary)",
        color: "var(--text-primary)",
        cursor: "pointer",
      },
      listeners: [
        {
          type: "click",
          listener: () => {
            this.copyToClipboard(contentArea.value, copyBtn);
          },
        },
      ],
    });
    buttonRow.appendChild(copyBtn);

    // Save button
    const saveBtn = ztoolkit.UI.createElement(doc, "button", {
      properties: { innerText: "💾 Save" },
      styles: {
        padding: "10px 16px",
        border: "1px solid var(--border-primary)",
        borderRadius: "6px",
        backgroundColor: "var(--background-secondary)",
        color: "var(--text-primary)",
        cursor: "pointer",
      },
      listeners: [
        {
          type: "click",
          listener: async () => {
            const value = contentArea.value;

            // Save to generatedData
            if (!searchColumnConfig.generatedData[paper.paperId]) {
              searchColumnConfig.generatedData[paper.paperId] = {};
            }
            searchColumnConfig.generatedData[paper.paperId][col.id] = value;
            await saveSearchColumnConfig();

            overlay.remove();
            // Refresh search results to show updated content
            if (resultsContainer && item) {
              this.renderSearchResults(doc, resultsContainer, item);
            }
          },
        },
      ],
    });
    buttonRow.appendChild(saveBtn);

    // Cancel button
    const cancelBtn = ztoolkit.UI.createElement(doc, "button", {
      properties: { innerText: "Cancel" },
      styles: {
        padding: "10px 16px",
        border: "1px solid var(--border-primary)",
        borderRadius: "6px",
        backgroundColor: "var(--background-primary)",
        cursor: "pointer",
      },
      listeners: [{ type: "click", listener: () => overlay.remove() }],
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
   * Generate content from PDF using indexed text or DataLabs OCR as fallback
   * Priority: Notes → Indexed PDF text → OCR extraction
   */
  private static async generateFromPDF(
    item: Zotero.Item,
    col: TableColumn,
  ): Promise<string> {
    // Check if there's already a note with matching title (prioritize OCR notes)
    if (ocrService.hasExistingNote(item)) {
      const noteIds = item.getNotes();
      if (noteIds.length > 0) {
        Zotero.debug(`[seerai] Using existing note for item ${item.id}`);
        return this.generateColumnContent(item, col, noteIds);
      }
    }

    // Try indexed PDF text (auto-indexes if needed, skips note check since we already did it)
    const pdfText = await Assistant.getPdfTextForItem(item, 0, true, false);
    if (pdfText) {
      Zotero.debug(
        `[seerai] Using indexed PDF text for generation (${pdfText.length} chars)`,
      );
      return this.generateColumnContentFromText(item, col, pdfText);
    }

    // PDF not available or image-only - need OCR via DataLabs
    const pdf = ocrService.getFirstPdfAttachment(item);
    if (!pdf) {
      throw new Error("No PDF attachment found");
    }

    // Process PDF with DataLabs - this creates a note
    Zotero.debug("[seerai] Image-only PDF, processing with OCR...");
    await ocrService.convertToMarkdown(pdf);

    // Wait a moment for the note to be saved
    await new Promise((r) => setTimeout(r, 500));

    // Get the newly created note IDs
    const newNoteIds = item.getNotes();
    if (newNoteIds.length === 0) {
      throw new Error("DataLabs processing completed but no note was created");
    }

    Zotero.debug(
      `[seerai] DataLabs created note, now generating content with ${newNoteIds.length} notes`,
    );

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
      if (
        currentTableConfig.name === "Default Table" ||
        !currentTableConfig.name
      ) {
        currentTableConfig.name = `Workspace (${paperCount} papers) - ${new Date().toLocaleDateString()}`;
      }

      const tableStore = getTableStore();
      await tableStore.saveConfig(currentTableConfig);
      Zotero.debug(`[seerai] Workspace saved with ${paperCount} papers`);
    } catch (e) {
      Zotero.debug(`[seerai] Error saving workspace: ${e}`);
    }
  }

  /**
   * Show table history/workspace picker with renaming support
   */
  private static async showWorkspacePicker(
    doc: Document,
    item: Zotero.Item,
  ): Promise<void> {
    // Toggle existing dropdown
    const existing = doc.getElementById(
      "workspace-picker-dropdown",
    ) as HTMLElement;
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
        marginRight: "8px",
      },
    });

    // Header
    const header = ztoolkit.UI.createElement(doc, "div", {
      styles: {
        background:
          "linear-gradient(135deg, var(--highlight-primary) 0%, color-mix(in srgb, var(--highlight-primary) 80%, black) 100%)",
        padding: "10px 14px",
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        borderRadius: "8px 8px 0 0",
      },
    });

    const headerTitle = ztoolkit.UI.createElement(doc, "div", {
      properties: { innerText: "📂 Saved Workspaces" },
      styles: {
        fontSize: "13px",
        fontWeight: "600",
        color: "var(--highlight-text)",
        textShadow: "0 1px 2px rgba(0,0,0,0.1)",
      },
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
        justifyContent: "center",
      },
      listeners: [
        {
          type: "click",
          listener: () => {
            dropdown.style.opacity = "0";
            setTimeout(() => dropdown.remove(), 200);
          },
        },
      ],
    });
    header.appendChild(closeBtn);
    dropdown.appendChild(header);

    // Content
    const content = ztoolkit.UI.createElement(doc, "div", {
      styles: {
        padding: "8px",
        display: "flex",
        flexDirection: "column",
        gap: "8px",
      },
    });

    const listContainer = ztoolkit.UI.createElement(doc, "div", {
      styles: {
        maxHeight: "240px",
        overflowY: "auto",
        borderRadius: "6px",
        backgroundColor: "var(--background-secondary)",
      },
    });

    // Load history
    const tableStore = getTableStore();
    const history = await tableStore.loadHistory();

    const renderList = async () => {
      listContainer.innerHTML = "";
      if (history.entries.length === 0) {
        listContainer.appendChild(
          ztoolkit.UI.createElement(doc, "div", {
            properties: { innerText: "No saved workspaces." },
            styles: {
              padding: "16px",
              textAlign: "center",
              color: "var(--text-secondary)",
              fontSize: "12px",
            },
          }),
        );
      } else {
        for (const entry of history.entries) {
          const isActive =
            currentTableConfig && currentTableConfig.id === entry.config.id;
          const row = ztoolkit.UI.createElement(doc, "div", {
            styles: {
              padding: "8px 10px",
              borderBottom: "1px solid var(--border-primary)",
              cursor: "pointer",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              backgroundColor: isActive
                ? "var(--background-hover)"
                : "transparent",
            },
          });

          // Left side: Name and meta
          const info = ztoolkit.UI.createElement(doc, "div", {
            styles: { flex: "1", overflow: "hidden", marginRight: "8px" },
            listeners: [
              {
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
                },
              },
            ],
          });

          const nameEl = ztoolkit.UI.createElement(doc, "div", {
            properties: { innerText: entry.config.name || "Untitled Workpace" },
            styles: {
              fontSize: "12px",
              fontWeight: isActive ? "600" : "500",
              color: "var(--text-primary)",
            },
          });

          const metaEl = ztoolkit.UI.createElement(doc, "div", {
            properties: {
              innerText: `${new Date(entry.usedAt).toLocaleDateString()} • ${entry.config.addedPaperIds?.length || 0} papers`,
            },
            styles: {
              fontSize: "10px",
              color: "var(--text-secondary)",
              marginTop: "2px",
            },
          });

          info.appendChild(nameEl);
          info.appendChild(metaEl);
          row.appendChild(info);

          // Actions
          const actions = ztoolkit.UI.createElement(doc, "div", {
            styles: { display: "flex", gap: "4px" },
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
              padding: "2px",
            },
            listeners: [
              {
                type: "click",
                listener: async (e: Event) => {
                  e.stopPropagation();
                  const newName = doc.defaultView?.prompt(
                    "Rename workspace:",
                    entry.config.name,
                  );
                  if (newName) {
                    entry.config.name = newName;
                    await tableStore.saveHistory(history);
                    if (isActive && currentTableConfig) {
                      currentTableConfig.name = newName;
                      await tableStore.saveConfig(currentTableConfig);
                    }
                    renderList(); // Re-render list
                  }
                },
              },
            ],
          });
          renameBtn.addEventListener(
            "mouseenter",
            () => (renameBtn.style.opacity = "1"),
          );
          renameBtn.addEventListener(
            "mouseleave",
            () => (renameBtn.style.opacity = "0.6"),
          );

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
              padding: "2px",
            },
            listeners: [
              {
                type: "click",
                listener: async (e: Event) => {
                  e.stopPropagation();
                  if (
                    doc.defaultView?.confirm(
                      `Delete workspace "${entry.config.name}"?`,
                    )
                  ) {
                    const idx = history.entries.indexOf(entry);
                    if (idx > -1) {
                      history.entries.splice(idx, 1);
                      await tableStore.saveHistory(history);
                      // If deleted active one, maybe reset? keeping it simple for now
                      renderList();
                    }
                  }
                },
              },
            ],
          });
          deleteBtn.addEventListener(
            "mouseenter",
            () => (deleteBtn.style.opacity = "1"),
          );
          deleteBtn.addEventListener(
            "mouseleave",
            () => (deleteBtn.style.opacity = "0.6"),
          );

          actions.appendChild(deleteBtn);
          row.appendChild(actions);

          // Highlight active
          if (isActive) {
            const check = ztoolkit.UI.createElement(doc, "div", {
              properties: { innerText: "✓" },
              styles: {
                fontSize: "14px",
                color: "var(--highlight-primary)",
                marginRight: "6px",
              },
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
  private static async showChatTablePicker(
    doc: Document,
    stateManager: ReturnType<typeof getChatStateManager>,
  ): Promise<void> {
    // Toggle existing dropdown
    const existing = doc.getElementById(
      "chat-table-picker-dropdown",
    ) as HTMLElement;
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
        marginRight: "8px",
      },
    });

    // Header
    const header = ztoolkit.UI.createElement(doc, "div", {
      styles: {
        background:
          "linear-gradient(135deg, var(--highlight-primary) 0%, color-mix(in srgb, var(--highlight-primary) 80%, purple) 100%)",
        padding: "10px 14px",
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        gap: "12px",
      },
    });

    const headerTitle = ztoolkit.UI.createElement(doc, "div", {
      properties: { innerText: "📊 Add From Table" },
      styles: {
        fontSize: "13px",
        fontWeight: "600",
        color: "var(--highlight-text)",
        textShadow: "0 1px 2px rgba(0,0,0,0.1)",
      },
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
        justifyContent: "center",
      },
      listeners: [
        {
          type: "click",
          listener: () => {
            dropdown.style.opacity = "0";
            dropdown.style.transform = "translateY(-10px)";
            setTimeout(() => dropdown.remove(), 200);
          },
        },
      ],
    });
    header.appendChild(closeBtn);
    dropdown.appendChild(header);

    // Content
    const content = ztoolkit.UI.createElement(doc, "div", {
      styles: {
        padding: "10px 14px",
        display: "flex",
        flexDirection: "column",
        gap: "8px",
      },
    });

    const listContainer = ztoolkit.UI.createElement(doc, "div", {
      styles: {
        maxHeight: "240px",
        overflowY: "auto",
        border: "1px solid var(--border-primary)",
        borderRadius: "6px",
        backgroundColor: "var(--background-secondary)",
      },
    });

    // Load tables
    const tableStore = getTableStore();
    const history = await tableStore.loadHistory();

    if (history.entries.length === 0) {
      listContainer.appendChild(
        ztoolkit.UI.createElement(doc, "div", {
          properties: { innerText: "No saved tables found." },
          styles: {
            padding: "20px",
            textAlign: "center",
            color: "var(--text-secondary)",
            fontSize: "12px",
          },
        }),
      );
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
            transition: "background-color 0.1s",
          },
        });
        row.addEventListener("mouseenter", () => {
          row.style.backgroundColor = "var(--background-primary)";
        });
        row.addEventListener("mouseleave", () => {
          row.style.backgroundColor = "";
        });

        const info = ztoolkit.UI.createElement(doc, "div", {
          styles: { flex: "1", overflow: "hidden", marginRight: "10px" },
        });

        const nameEl = ztoolkit.UI.createElement(doc, "div", {
          properties: { innerText: entry.config.name || "Untitled Table" },
          styles: {
            fontSize: "12px",
            fontWeight: "600",
            color: "var(--text-primary)",
          },
        });

        const count = entry.config.addedPaperIds?.length || 0;
        const metaEl = ztoolkit.UI.createElement(doc, "div", {
          properties: {
            innerText: `${count} papers • ${new Date(entry.usedAt).toLocaleDateString()}`,
          },
          styles: {
            fontSize: "11px",
            color: "var(--text-secondary)",
            marginTop: "1px",
          },
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
            transition: "all 0.15s",
          },
          listeners: [
            {
              type: "click",
              listener: async (e: Event) => {
                e.stopPropagation();
                const paperIds = entry.config.addedPaperIds || [];
                if (paperIds.length === 0) {
                  doc.defaultView?.alert("This table is empty.");
                  return;
                }

                // Build table context from the saved table data
                const columns =
                  entry.config.columns?.filter((c) => c.visible) ||
                  defaultColumns.filter((c) => c.visible);
                const columnNames = columns.map((c) => c.name);
                const generatedData = entry.config.generatedData || {};

                // Format table data as text context
                let tableContent = "";
                let rowCount = 0;

                for (const paperId of paperIds) {
                  const item = Zotero.Items.get(paperId);
                  if (!item || !item.isRegularItem()) continue;

                  const paperTitle =
                    (item.getField("title") as string) || "Untitled";
                  const creators = item.getCreators();
                  const authorNames =
                    creators
                      .map((c) =>
                        `${c.firstName || ""} ${c.lastName || ""}`.trim(),
                      )
                      .join(", ") || "Unknown";
                  const year = (item.getField("year") as string) || "";
                  const noteIDs = item.getNotes();
                  const persistedData = generatedData[paperId] || {};

                  // Build row data
                  const rowData: Record<string, string> = {
                    title: paperTitle,
                    author: authorNames,
                    year: year,
                    sources: String(noteIDs.length),
                    ...persistedData,
                  };

                  // Format as readable entry
                  tableContent += `\n### ${paperTitle}\n`;
                  for (const col of columns) {
                    if (col.id === "title") continue; // Title already in header
                    const value = rowData[col.id] || "";
                    if (value) {
                      tableContent += `- **${col.name}**: ${value}\n`;
                    }
                  }
                  rowCount++;
                }

                // Create table selection object
                const tableSelection: SelectedTable = {
                  id: entry.config.id || `table_${Date.now()}`,
                  type: "table",
                  title: entry.config.name || "Untitled Table",
                  content: tableContent,
                  rowCount: rowCount,
                  columnNames: columnNames,
                };

                // Add to state manager
                stateManager.addSelection("tables", tableSelection);
                this.reRenderSelectionArea();

                // Feedback
                addBtn.innerText = "✓ Added";
                addBtn.style.backgroundColor = "var(--highlight-primary)";
                addBtn.style.color = "var(--highlight-text)";
                setTimeout(() => {
                  dropdown.style.opacity = "0";
                  setTimeout(() => dropdown.remove(), 200);
                }, 500);
              },
            },
          ],
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
      styles: {
        padding: "8px 14px",
        borderTop: "1px solid var(--border-primary)",
        display: "flex",
        justifyContent: "flex-end",
      },
    });
    const doneBtn = ztoolkit.UI.createElement(doc, "button", {
      properties: { innerText: "Done" },
      styles: {
        padding: "6px 14px",
        border: "1px solid var(--border-primary)",
        borderRadius: "6px",
        fontSize: "12px",
        backgroundColor: "var(--background-secondary)",
        cursor: "pointer",
      },
      listeners: [
        {
          type: "click",
          listener: () => {
            dropdown.style.opacity = "0";
            dropdown.style.transform = "translateY(-10px)";
            setTimeout(() => dropdown.remove(), 200);
          },
        },
      ],
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
  private static async startFreshWorkspace(
    doc: Document,
    item: Zotero.Item,
  ): Promise<void> {
    try {
      // Reset to default config with a new ID
      const tableStore = getTableStore();
      const now = new Date().toISOString();
      currentTableConfig = {
        id: `table_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        name: "Default Table",
        columns: [...defaultColumns],
        sortBy: "title",
        sortOrder: "asc",
        filterQuery: "",
        responseLength: 100,
        filterLibraryId: null,
        filterCollectionId: null,
        pageSize: 25,
        currentPage: 1,
        addedPaperIds: [],
        createdAt: now,
        updatedAt: now,
      };
      await tableStore.saveConfig(currentTableConfig);

      // Re-render
      if (currentContainer && currentItem) {
        this.renderInterface(currentContainer, currentItem);
      }
      Zotero.debug("[seerai] Fresh workspace started");
    } catch (e) {
      Zotero.debug(`[seerai] Error starting fresh workspace: ${e}`);
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
        borderRadius: "4px",
      },
    });

    const label = ztoolkit.UI.createElement(doc, "span", {
      properties: {
        className: "response-length-label",
        innerText: "Response:",
      },
      styles: {
        fontSize: "11px",
        color: "var(--text-secondary)",
        whiteSpace: "nowrap",
      },
    });

    const slider = ztoolkit.UI.createElement(doc, "input", {
      attributes: { type: "range", min: "0", max: "4200", step: "100" },
      properties: { className: "response-length-slider" },
      styles: { width: "80px", cursor: "pointer" },
    }) as HTMLInputElement;

    slider.value = String(currentTableConfig?.responseLength || 100);

    const getDisplayValue = (val: string) => {
      const num = parseInt(val, 10);
      return num >= 4192 ? "∞" : val;
    };

    const valueDisplay = ztoolkit.UI.createElement(doc, "span", {
      properties: {
        className: "response-length-value",
        innerText: getDisplayValue(slider.value),
      },
      styles: {
        fontSize: "11px",
        color: "var(--text-primary)",
        minWidth: "30px",
      },
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
  private static createTableEmptyState(
    doc: Document,
    item: Zotero.Item,
  ): HTMLElement {
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
        gap: "8px",
      },
    });

    const icon = ztoolkit.UI.createElement(doc, "div", {
      properties: { className: "table-empty-state-icon", innerText: "📋" },
      styles: { fontSize: "32px", opacity: "0.5" },
    });

    const text = ztoolkit.UI.createElement(doc, "div", {
      properties: {
        className: "table-empty-state-text",
        innerText: "Start by adding papers to create a comparison table.",
      },
      styles: { fontSize: "13px" },
    });
    emptyState.appendChild(icon);
    emptyState.appendChild(text);

    // Add Button
    const addBtn = ztoolkit.UI.createElement(doc, "button", {
      properties: { innerText: "➕ Add Papers" },
      styles: {
        marginTop: "12px",
        padding: "8px 16px",
        fontSize: "13px",
        border: "none",
        borderRadius: "6px",
        backgroundColor: "var(--highlight-primary)",
        color: "var(--highlight-text)",
        cursor: "pointer",
        fontWeight: "500",
      },
      listeners: [
        {
          type: "click",
          listener: () => {
            this.showTablePaperPicker(doc, item);
          },
        },
      ],
    });
    emptyState.appendChild(addBtn);

    return emptyState;
  }

  /**
   * Create the papers table element
   */
  private static createPapersTable(
    doc: Document,
    tableData: TableData,
  ): HTMLElement {
    const table = ztoolkit.UI.createElement(doc, "table", {
      properties: { className: "papers-table" },
      styles: {
        width: "100%",
        borderCollapse: "collapse",
        fontSize: "12px",
        tableLayout: "fixed",
      },
    });

    // Create header
    const thead = ztoolkit.UI.createElement(doc, "thead", {});
    const headerRow = ztoolkit.UI.createElement(doc, "tr", {});

    const columns = currentTableConfig?.columns || defaultColumns;

    // Core columns to combine into "Paper"
    const coreColumnIds = ["title", "author", "year", "sources"];
    const otherColumns = columns.filter(
      (col) => col.visible && !coreColumnIds.includes(col.id),
    );

    // Paper column width (stored in config or default to 280)
    let paperColumnWidth = (currentTableConfig as any)?.paperColumnWidth ?? 280;

    // Add combined "Paper" header (for title, author, year, sources)
    const paperHeader = ztoolkit.UI.createElement(doc, "th", {
      properties: { innerText: "Paper", className: "sortable" },
      styles: {
        position: "relative",
        backgroundColor: "var(--background-secondary)",
        borderBottom: "1px solid rgba(128, 128, 128, 0.4)",
        borderRight: "1px solid rgba(128, 128, 128, 0.4)",
        padding: "8px 10px",
        textAlign: "left",
        fontWeight: "600",
        width: `${paperColumnWidth}px`,
        minWidth: "40px",
        cursor: "pointer",
        userSelect: "none",
      },
      listeners: [
        {
          type: "click",
          listener: async () => {
            if (currentTableConfig) {
              if (currentTableConfig.sortBy === "title") {
                currentTableConfig.sortOrder =
                  currentTableConfig.sortOrder === "asc" ? "desc" : "asc";
              } else {
                currentTableConfig.sortBy = "title";
                currentTableConfig.sortOrder = "asc";
              }
              const tableStore = getTableStore();
              await tableStore.saveConfig(currentTableConfig);
              if (currentContainer && currentItem) {
                this.renderInterface(currentContainer, currentItem);
              }
            }
          },
        },
      ],
    });

    // Add resize handle for Paper column
    const paperResizeHandle = ztoolkit.UI.createElement(doc, "div", {
      properties: { className: "column-resize-handle" },
      styles: {
        position: "absolute",
        right: "0",
        top: "0",
        bottom: "0",
        width: "6px",
        cursor: "col-resize",
        backgroundColor: "transparent",
      },
    });
    paperResizeHandle.addEventListener("mouseenter", () => {
      (paperResizeHandle as HTMLElement).style.backgroundColor =
        "var(--highlight-primary)";
    });
    paperResizeHandle.addEventListener("mouseleave", () => {
      (paperResizeHandle as HTMLElement).style.backgroundColor = "transparent";
    });
    paperResizeHandle.addEventListener("mousedown", (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();

      const startX = e.clientX;
      const startWidth = paperColumnWidth;

      const onMouseMove = (moveE: MouseEvent) => {
        const delta = moveE.clientX - startX;
        const newWidth = Math.max(40, startWidth + delta);
        paperColumnWidth = newWidth;

        // Update header width
        (paperHeader as HTMLElement).style.width = `${newWidth}px`;

        // Update all Paper cells (first column)
        const cells = table.querySelectorAll(
          `td:nth-child(1), th:nth-child(1)`,
        );
        cells.forEach((cell: Element) => {
          (cell as HTMLElement).style.width = `${newWidth}px`;
        });
      };

      const onMouseUp = async () => {
        doc.removeEventListener("mousemove", onMouseMove);
        doc.removeEventListener("mouseup", onMouseUp);

        // Save Paper column width
        if (currentTableConfig) {
          (currentTableConfig as any).paperColumnWidth = paperColumnWidth;
          const tableStore = getTableStore();
          await tableStore.saveConfig(currentTableConfig);
        }
      };

      doc.addEventListener("mousemove", onMouseMove);
      doc.addEventListener("mouseup", onMouseUp);
    });
    paperHeader.appendChild(paperResizeHandle);
    headerRow.appendChild(paperHeader);

    // Add other column headers (computed/custom columns)
    otherColumns.forEach((col) => {
      const isComputedColumn = col.type === "computed";
      const th = ztoolkit.UI.createElement(doc, "th", {
        properties: {
          className: `${col.sortable ? "sortable" : ""} ${currentTableConfig?.sortBy === col.id ? `sort-${currentTableConfig.sortOrder}` : ""}`,
        },
        attributes: isComputedColumn ? { "data-column-id": col.id } : {},
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
          cursor: isComputedColumn
            ? "pointer"
            : col.sortable
              ? "pointer"
              : "default",
          userSelect: "none",
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
        },
      });

      // For computed columns, wrap content with edit capability
      if (isComputedColumn) {
        const headerContent = ztoolkit.UI.createElement(doc, "div", {
          styles: {
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: "4px",
            width: "100%",
          },
        });

        const nameSpan = ztoolkit.UI.createElement(doc, "span", {
          properties: { innerText: col.name, className: "column-header-text" },
          attributes: { title: col.aiPrompt || "" },
          styles: {
            flex: "1",
            overflow: "hidden",
            textOverflow: "ellipsis",
          },
        });
        headerContent.appendChild(nameSpan);

        // Edit icon (pencil)
        const editIcon = ztoolkit.UI.createElement(doc, "span", {
          properties: { innerHTML: "✎" },
          styles: { fontSize: "11px", opacity: "0.4" },
        });
        headerContent.appendChild(editIcon);

        // Hover effect
        th.addEventListener("mouseenter", () => (editIcon.style.opacity = "1"));
        th.addEventListener(
          "mouseleave",
          () => (editIcon.style.opacity = "0.4"),
        );

        // Click to edit
        th.addEventListener("click", (e: Event) => {
          e.stopPropagation();
          if (currentItem) {
            this.showTableColumnEditPopover(
              doc,
              th,
              col,
              currentItem,
              currentContainer!,
            );
          }
        });

        th.appendChild(headerContent);
      } else {
        // Non-computed columns just show text
        th.innerText = col.name;

        // Sorting for sortable columns
        if (col.sortable) {
          th.addEventListener("click", async () => {
            if (currentTableConfig) {
              if (currentTableConfig.sortBy === col.id) {
                currentTableConfig.sortOrder =
                  currentTableConfig.sortOrder === "asc" ? "desc" : "asc";
              } else {
                currentTableConfig.sortBy = col.id;
                currentTableConfig.sortOrder = "asc";
              }
              const tableStore = getTableStore();
              await tableStore.saveConfig(currentTableConfig);
              if (currentContainer && currentItem) {
                this.renderInterface(currentContainer, currentItem);
              }
            }
          });
        }
      }

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
            backgroundColor: "transparent",
          },
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
          const colIndex = otherColumns.findIndex((c) => c.id === col.id) + 1; // +1 for Paper column

          const onMouseMove = (moveE: MouseEvent) => {
            const delta = moveE.clientX - startX;
            const newWidth = Math.max(col.minWidth, startWidth + delta);
            col.width = newWidth;

            // Update header width
            th.style.width = `${newWidth}px`;

            // Update all cells in this column (+2 because Paper is +1 and nth-child is 1-indexed)
            const cells = table.querySelectorAll(
              `td:nth-child(${colIndex + 1}), th:nth-child(${colIndex + 1})`,
            );
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
      properties: { innerText: "Actions" },
      attributes: { title: "Save or remove row" },
      styles: {
        padding: "8px 6px",
        backgroundColor: "var(--background-secondary)",
        borderBottom: "2px solid rgba(128, 128, 128, 0.5)",
        borderRight: "1px solid rgba(128, 128, 128, 0.4)",
        fontSize: "11px",
        fontWeight: "600",
        width: "70px",
        textAlign: "center",
      },
    });
    headerRow.appendChild(actionsHeader);

    thead.appendChild(headerRow);
    table.appendChild(thead);

    // Create body
    const tbody = ztoolkit.UI.createElement(doc, "tbody", {});

    tableData.rows.forEach((row) => {
      const tr = ztoolkit.UI.createElement(doc, "tr", {
        properties: {
          className: tableData.selectedRowIds.has(row.paperId)
            ? "selected"
            : "",
        },
        attributes: { "data-paper-id": String(row.paperId) },
        listeners: [
          {
            type: "click",
            listener: (e: MouseEvent) => {
              const id = row.paperId;
              let newSelection = new Set(tableData.selectedRowIds);

              if (e.shiftKey && lastInteractedRowId) {
                // Range selection
                const startIdx = tableData.rows.findIndex(
                  (r) => r.paperId === lastInteractedRowId,
                );
                const endIdx = tableData.rows.findIndex(
                  (r) => r.paperId === id,
                );
                if (startIdx !== -1 && endIdx !== -1) {
                  const low = Math.min(startIdx, endIdx);
                  const high = Math.max(startIdx, endIdx);
                  for (let i = low; i <= high; i++) {
                    newSelection.add(tableData.rows[i].paperId);
                  }
                }
              } else if (e.ctrlKey || e.metaKey) {
                // Toggle
                if (newSelection.has(id)) {
                  newSelection.delete(id);
                } else {
                  newSelection.add(id);
                }
                lastInteractedRowId = id;
              } else {
                // Single Select
                newSelection.clear();
                newSelection.add(id);
                lastInteractedRowId = id;
              }

              tableData.selectedRowIds = newSelection;

              // Update UI (all rows)
              const allRows = tbody.querySelectorAll("tr[data-paper-id]");
              allRows.forEach((r: Element) => {
                const rId = parseInt(r.getAttribute("data-paper-id") || "0");
                if (tableData.selectedRowIds.has(rId)) {
                  r.classList.add("selected");
                } else {
                  r.classList.remove("selected");
                }
              });

              // Update Bulk Actions Visibility
              const bulkActions = doc.getElementById(
                "table-bulk-actions",
              ) as HTMLElement;
              if (bulkActions) {
                bulkActions.style.display =
                  tableData.selectedRowIds.size > 0 ? "flex" : "none";
              }
            },
          },
        ],
      });

      // Create combined "Paper" cell (title, author, year, sources)
      const paperCell = ztoolkit.UI.createElement(doc, "td", {
        styles: {
          padding: "8px 10px",
          borderBottom: "1px solid rgba(128, 128, 128, 0.4)",
          borderRight: "1px solid rgba(128, 128, 128, 0.4)",
          verticalAlign: "top",
          cursor: "pointer",
          width: `${paperColumnWidth}px`,
          minWidth: "40px",
        },
      });

      // Title (clickable, opens PDF)
      const titleDiv = ztoolkit.UI.createElement(doc, "div", {
        properties: { innerText: row.data["title"] || "Untitled" },
        styles: {
          fontWeight: "600",
          fontSize: "12px",
          color: "var(--highlight-primary)",
          marginBottom: "3px",
          lineHeight: "1.4",
          whiteSpace: "normal",
          wordBreak: "break-word",
        },
      }) as HTMLDivElement;
      titleDiv.addEventListener("mouseenter", () => {
        titleDiv.style.textDecoration = "underline";
      });
      titleDiv.addEventListener("mouseleave", () => {
        titleDiv.style.textDecoration = "none";
      });
      titleDiv.addEventListener("click", async (event: Event) => {
        const e = event as MouseEvent;
        e.preventDefault();
        e.stopPropagation();

        const id = row.paperId;
        let newSelection = new Set(tableData.selectedRowIds);

        if (e.shiftKey && lastInteractedRowId) {
          // Range selection
          const startIdx = tableData.rows.findIndex(
            (r) => r.paperId === lastInteractedRowId,
          );
          const endIdx = tableData.rows.findIndex((r) => r.paperId === id);
          if (startIdx !== -1 && endIdx !== -1) {
            const low = Math.min(startIdx, endIdx);
            const high = Math.max(startIdx, endIdx);
            for (let i = low; i <= high; i++) {
              newSelection.add(tableData.rows[i].paperId);
            }
          }
        } else if (e.ctrlKey || e.metaKey) {
          // Toggle
          if (newSelection.has(id)) {
            newSelection.delete(id);
          } else {
            newSelection.add(id);
          }
          lastInteractedRowId = id;
        } else {
          // Single Select
          newSelection.clear();
          newSelection.add(id);
          lastInteractedRowId = id;
        }

        tableData.selectedRowIds = newSelection;

        // Update UI (all rows)
        const allRows = table.querySelectorAll("tr[data-paper-id]");
        allRows.forEach((r: Element) => {
          const rId = parseInt(r.getAttribute("data-paper-id") || "0");
          if (tableData.selectedRowIds.has(rId)) {
            r.classList.add("selected");
          } else {
            r.classList.remove("selected");
          }
        });

        // Update Bulk Actions Visibility
        const bulkActions = doc.getElementById(
          "table-bulk-actions",
        ) as HTMLElement;
        if (bulkActions) {
          bulkActions.style.display =
            tableData.selectedRowIds.size > 0 ? "flex" : "none";
        }

        const item = Zotero.Items.get(row.paperId);
        if (!item) return;

        // Interactions (Only if no modifiers)
        if (!e.shiftKey && !e.ctrlKey && !e.metaKey) {
          // Single Click: Select item in Zotero
          if (e.detail === 1) {
            const zp = Zotero.getActiveZoteroPane();
            if (zp) zp.selectItem(item.id);
          }
          // Double Click: Open PDF
          else if (e.detail === 2) {
            const attachmentIds = item.getAttachments();
            for (const attachId of attachmentIds) {
              const attachment = Zotero.Items.get(attachId);
              if (
                attachment &&
                attachment.isPDFAttachment &&
                attachment.isPDFAttachment()
              ) {
                await Zotero.Reader.open(attachment.id);
                return;
              }
            }
          }
        }
      });

      paperCell.appendChild(titleDiv);

      // Author, Year, Sources on one line
      const author = row.data["author"] || "";
      const year = row.data["year"] || "";
      const sources = row.data["sources"] || "0";
      const metaText = [
        author
          ? `${author.length > 30 ? author.substring(0, 30) + "..." : author}`
          : "",
        year ? `(${year})` : "",
        `📝 ${sources}`,
      ]
        .filter(Boolean)
        .join(" · ");

      const metaDiv = ztoolkit.UI.createElement(doc, "div", {
        properties: { innerText: metaText },
        styles: {
          fontSize: "10px",
          color: "var(--text-secondary)",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        },
      });
      paperCell.appendChild(metaDiv);
      tr.appendChild(paperCell);

      // Render other columns (computed/custom only)
      otherColumns.forEach((col) => {
        const cellValue = row.data[col.id] || "";
        const isComputed = col.type === "computed";
        const isEmpty = !cellValue || cellValue.trim() === "";

        const td = ztoolkit.UI.createElement(doc, "td", {
          styles: {
            padding: "8px 10px",
            borderBottom: "1px solid rgba(128, 128, 128, 0.4)",
            borderRight: "1px solid rgba(128, 128, 128, 0.4)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "normal",
            wordBreak: "break-word",
            maxWidth: `${col.width}px`,
            width: `${col.width}px`,
            maxHeight: "60px",
            lineHeight: "1.4",
            verticalAlign: "top",
            cursor: "pointer",
          },
        });

        // Show content or empty indicator
        if (isEmpty && isComputed) {
          const hasNotes = row.noteIds && row.noteIds.length > 0;
          const itemForIndicator = Zotero.Items.get(row.paperId);
          const attachmentsForIndicator =
            itemForIndicator?.getAttachments() || [];
          const hasPDFForIndicator = attachmentsForIndicator.some(
            (attId: number) => {
              const att = Zotero.Items.get(attId);
              return (
                att &&
                (att.attachmentContentType === "application/pdf" ||
                  att.attachmentPath?.toLowerCase().endsWith(".pdf"))
              );
            },
          );

          if (hasNotes) {
            td.innerHTML = `<span style="color: var(--highlight-primary); font-size: 11px;">⚡ Generate</span>`;
          } else if (hasPDFForIndicator) {
            // Show both options: Generate (uses indexed PDF text) and OCR (creates refined notes)
            td.innerHTML = `<span style="font-size: 11px;">
                            <span class="generate-indexed-btn" style="color: var(--highlight-primary); cursor: pointer;">⚡ Generate</span>
                            <span style="margin: 0 4px; color: var(--text-tertiary);">|</span>
                            <span class="process-pdf-btn" style="color: var(--text-secondary); cursor: pointer;">📄 OCR</span>
                        </span>`;
            td.title = "Generate: uses PDF text | OCR: extracts refined notes";
          } else {
            // Check if paper has identifiers for PDF search
            const hasDoi = !!itemForIndicator?.getField("DOI");
            const hasArxiv = !!extractArxivFromItem(itemForIndicator);
            const hasPmid = !!extractPmidFromItem(itemForIndicator);
            const hasTitle = !!itemForIndicator?.getField("title");

            if (hasDoi || hasArxiv || hasPmid || hasTitle) {
              td.innerHTML = `<span class="search-pdf-btn" style="color: var(--highlight-primary); font-size: 11px; cursor: pointer;">🔍 Search PDF</span>`;
            } else {
              td.innerHTML = `<span style="color: var(--text-tertiary); font-size: 11px; font-style: italic;">No source</span>`;
            }
          }
        } else {
          td.innerHTML = parseMarkdown(cellValue);
        }

        // Click behavior
        td.addEventListener("click", async (e) => {
          e.stopPropagation();

          const currentValue = row.data[col.id] || "";
          const currentlyEmpty = !currentValue || currentValue.trim() === "";
          const hasNotes = row.noteIds && row.noteIds.length > 0;

          const item = Zotero.Items.get(row.paperId);
          const attachments = item?.getAttachments() || [];
          const hasPDF = attachments.some((attId: number) => {
            const att = Zotero.Items.get(attId);
            return (
              att &&
              (att.attachmentContentType === "application/pdf" ||
                att.attachmentPath?.toLowerCase().endsWith(".pdf"))
            );
          });

          if (currentlyEmpty && isComputed) {
            // Handle Attach PDF click FIRST (before Search PDF)
            const attachPdfBtn = (e.target as Element).closest(
              ".attach-pdf-btn",
            );
            if (attachPdfBtn && item) {
              // Open file picker to attach PDF
              const fp = new (Zotero.getMainWindow() as any).FilePicker();
              fp.init(
                Zotero.getMainWindow(),
                "Select PDF to attach",
                fp.modeOpen,
              );
              fp.appendFilter("PDF Files", "*.pdf");
              const result = await fp.show();
              if (result === fp.returnOK && fp.file) {
                try {
                  await Zotero.Attachments.importFromFile({
                    file: fp.file,
                    parentItemID: item.id,
                    contentType: "application/pdf",
                  });
                  td.innerHTML = `<span style="color: var(--highlight-primary); font-size: 11px;">📄 Process PDF</span>`;
                } catch (e) {
                  td.innerHTML = `<span style="color: #c62828; font-size: 11px;">Attach failed</span>`;
                }
              }
              return;
            }

            // Handle Generate from indexed PDF click
            const generateIndexedBtn = (e.target as Element).closest(
              ".generate-indexed-btn",
            );
            if (generateIndexedBtn && item) {
              td.innerHTML = `<span style="color: var(--text-tertiary); font-size: 11px;">⏳ Generating...</span>`;
              td.style.cursor = "wait";
              try {
                // Use generateFromPDF which now uses indexed text first
                const content = await this.generateFromPDF(item, col);
                row.data[col.id] = content;
                td.innerHTML = content
                  ? parseMarkdown(content)
                  : '<span style="color: var(--text-tertiary); font-size: 11px;">(Empty)</span>';
                td.style.cursor = "pointer";

                if (currentTableConfig) {
                  if (!currentTableConfig.generatedData)
                    currentTableConfig.generatedData = {};
                  if (!currentTableConfig.generatedData[row.paperId])
                    currentTableConfig.generatedData[row.paperId] = {};
                  currentTableConfig.generatedData[row.paperId][col.id] =
                    content;
                  const tableStore = getTableStore();
                  await tableStore.saveConfig(currentTableConfig);
                }
              } catch (err) {
                td.innerHTML = `<span style="color: #c62828; font-size: 11px;">Error: ${err}</span>`;
                td.style.cursor = "pointer";
              }
              return;
            }

            // Handle OCR (Process PDF with DataLabs) click
            const processPdfBtn = (e.target as Element).closest(
              ".process-pdf-btn",
            );
            if (processPdfBtn && item) {
              const pdf = ocrService.getFirstPdfAttachment(item);
              if (!pdf) {
                td.innerHTML = `<span style="color: #c62828; font-size: 11px;">No PDF found</span>`;
                return;
              }
              td.innerHTML = `<span style="color: var(--text-tertiary); font-size: 11px;">📄 OCR Processing...</span>`;
              td.style.cursor = "wait";
              try {
                await ocrService.convertToMarkdown(pdf);
                await new Promise((r) => setTimeout(r, 500));

                // Now generate content using the new notes
                const newNoteIds = item.getNotes();
                if (newNoteIds.length > 0) {
                  // CRITICAL: Update row.noteIds so subsequent clicks know we have notes
                  row.noteIds = newNoteIds;
                  row.data["sources"] = String(newNoteIds.length);

                  // Update metadata UI in the first cell
                  const tr = td.parentElement as HTMLTableRowElement;
                  if (tr) {
                    const paperCell = tr.cells[0];
                    if (paperCell && paperCell.children.length > 1) {
                      const metaDiv = paperCell.children[1] as HTMLElement;
                      const author = row.data["author"] || "";
                      const year = row.data["year"] || "";
                      const sources = row.data["sources"];
                      const metaText = [
                        author
                          ? `${author.length > 30 ? author.substring(0, 30) + "..." : author}`
                          : "",
                        year ? `(${year})` : "",
                        `📝 ${sources}`,
                      ]
                        .filter(Boolean)
                        .join(" · ");
                      metaDiv.innerText = metaText;
                    }
                  }

                  const content = await this.generateColumnContent(
                    item,
                    col,
                    newNoteIds,
                  );
                  row.data[col.id] = content;
                  td.innerHTML = content
                    ? parseMarkdown(content)
                    : '<span style="color: var(--text-tertiary); font-size: 11px;">(Empty)</span>';
                  td.style.cursor = "pointer";

                  if (currentTableConfig) {
                    if (!currentTableConfig.generatedData)
                      currentTableConfig.generatedData = {};
                    if (!currentTableConfig.generatedData[row.paperId])
                      currentTableConfig.generatedData[row.paperId] = {};
                    currentTableConfig.generatedData[row.paperId][col.id] =
                      content;
                    const tableStore = getTableStore();
                    await tableStore.saveConfig(currentTableConfig);
                  }
                } else {
                  td.innerHTML = `<span style="color: #ff9800; font-size: 11px;">OCR done, no note created</span>`;
                }
              } catch (err) {
                td.innerHTML = `<span style="color: #c62828; font-size: 11px;">OCR Error</span>`;
                td.title = String(err);
                td.style.cursor = "pointer";
              }
              return;
            }

            // Check if "Search PDF" button was clicked
            const searchPdfBtn = (e.target as Element).closest(
              ".search-pdf-btn",
            );
            if (searchPdfBtn && !hasNotes && !hasPDF && item) {
              // Run PDF discovery pipeline
              td.innerHTML = `<span style="color: var(--text-tertiary); font-size: 11px;">⏳ Searching...</span>`;
              td.style.cursor = "wait";

              try {
                const success = await findAndAttachPdfForItem(item, (step) => {
                  td.innerHTML = `<span style="color: var(--text-tertiary); font-size: 11px;">⏳ ${step}</span>`;
                });

                if (success) {
                  td.innerHTML = `<span style="color: var(--highlight-primary); font-size: 11px;">📄 Process PDF</span>`;
                  td.style.cursor = "pointer";
                } else {
                  // Step 7: Show Source-Link if identifiers available
                  const doi = (item.getField("DOI") as string) || undefined;
                  const arxivId = extractArxivFromItem(item);
                  const pmid = extractPmidFromItem(item);
                  const itemUrl = (item.getField("url") as string) || undefined;
                  const sourceLink = getSourceLinkForPaper(
                    doi,
                    arxivId,
                    pmid,
                    undefined,
                    itemUrl,
                  );

                  if (sourceLink) {
                    td.innerHTML = `<span class="source-link-btn" data-url="${sourceLink}" style="color: var(--highlight-primary); font-size: 11px; cursor: pointer;">🔗 Source-Link</span>`;
                    td.style.cursor = "pointer";
                  } else {
                    td.innerHTML = `<span style="color: var(--text-tertiary); font-size: 11px; font-style: italic;">❌ Not found</span>`;
                    td.style.cursor = "pointer";
                  }
                }
              } catch (err) {
                td.innerHTML = `<span style="color: #c62828; font-size: 11px;">Error</span>`;
                td.style.cursor = "pointer";
              }
              return;
            }

            // Handle Source-Link click
            const sourceLinkBtn = td.querySelector(".source-link-btn");
            if (sourceLinkBtn && item) {
              const linkUrl = sourceLinkBtn.getAttribute("data-url");
              if (linkUrl) {
                Zotero.launchURL(linkUrl);
                // Show Attach and Retry buttons
                td.innerHTML = `<span style="font-size: 11px;">
                                    <span class="attach-pdf-btn" data-item-id="${row.paperId}" style="color: var(--highlight-primary); cursor: pointer; margin-right: 8px;">⬇️ Attach</span>
                                    <span class="search-pdf-btn" style="color: var(--highlight-primary); cursor: pointer;">🔁 Retry</span>
                                </span>`;
                td.style.cursor = "pointer";
              }
              return;
            }

            if (hasNotes || hasPDF) {
              td.innerHTML = `<span style="color: var(--text-tertiary); font-size: 11px;">⏳ ${hasNotes ? "Generating..." : "Processing..."}</span>`;
              td.style.cursor = "wait";

              try {
                if (item) {
                  const content = hasNotes
                    ? await this.generateColumnContent(item, col, row.noteIds)
                    : await this.generateFromPDF(item, col);

                  row.data[col.id] = content;
                  td.innerHTML = content
                    ? parseMarkdown(content)
                    : '<span style="color: var(--text-tertiary); font-size: 11px;">(Empty)</span>';
                  td.style.cursor = "pointer";

                  if (currentTableConfig) {
                    if (!currentTableConfig.generatedData)
                      currentTableConfig.generatedData = {};
                    if (!currentTableConfig.generatedData[row.paperId])
                      currentTableConfig.generatedData[row.paperId] = {};
                    currentTableConfig.generatedData[row.paperId][col.id] =
                      content;
                    const tableStore = getTableStore();
                    await tableStore.saveConfig(currentTableConfig);
                  }
                }
              } catch (err) {
                td.innerHTML = `<span style="color: #c62828; font-size: 11px;">Error</span>`;
                td.style.cursor = "pointer";
              }
            }
          } else {
            this.showCellDetailModal(doc, row, col, row.data[col.id] || "");
          }
        });

        tr.appendChild(td);
      });

      // Add actions cell with save and remove buttons
      const actionsCell = ztoolkit.UI.createElement(doc, "td", {
        styles: {
          padding: "4px 8px",
          borderBottom: "1px solid rgba(128, 128, 128, 0.4)",
          borderRight: "1px solid rgba(128, 128, 128, 0.4)",
          width: "70px",
          textAlign: "center",
          verticalAlign: "middle",
          display: "flex",
          gap: "4px",
          justifyContent: "center",
        },
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
          transition: "background-color 0.15s",
        },
        listeners: [
          {
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
            },
          },
        ],
      });
      saveRowBtn.addEventListener("mouseenter", () => {
        saveRowBtn.style.backgroundColor = "rgba(128,128,128,0.2)";
      });
      saveRowBtn.addEventListener("mouseleave", () => {
        saveRowBtn.style.backgroundColor = "";
      });
      actionsCell.appendChild(saveRowBtn);

      // Bomb button (Delete from Zotero)
      const bombBtn = ztoolkit.UI.createElement(doc, "button", {
        properties: { innerText: "💣" },
        attributes: { title: "Delete item from Zotero completely" },
        styles: {
          background: "none",
          border: "none",
          fontSize: "14px",
          cursor: "pointer",
          padding: "4px",
          borderRadius: "4px",
          transition: "background-color 0.15s",
        },
        listeners: [
          {
            type: "click",
            listener: async (e: Event) => {
              e.stopPropagation();
              const btn = e.target as HTMLElement;

              if (btn.dataset.confirmBomb !== "true") {
                btn.dataset.confirmBomb = "true";
                btn.innerText = "💥";
                btn.style.color = "#c62828";
                btn.style.backgroundColor = "rgba(198,40,40,0.15)";
                btn.title = "Click again to PERMANENTLY DELETE from Zotero";
                setTimeout(() => {
                  btn.dataset.confirmBomb = "";
                  btn.innerText = "💣";
                  btn.style.color = "";
                  btn.style.backgroundColor = "";
                  btn.title = "Delete item from Zotero completely";
                }, 3000);
                return;
              }

              // Execute delete
              try {
                btn.innerText = "⌛";
                await Zotero.Items.erase([row.paperId]);

                // Also remove from table config if present
                if (currentTableConfig) {
                  currentTableConfig.addedPaperIds =
                    currentTableConfig.addedPaperIds.filter(
                      (id) => id !== row.paperId,
                    );
                  if (
                    currentTableConfig.generatedData &&
                    currentTableConfig.generatedData[row.paperId]
                  ) {
                    delete currentTableConfig.generatedData[row.paperId];
                  }
                  const tableStore = getTableStore();
                  await tableStore.saveConfig(currentTableConfig);
                }

                // Refresh table
                if (currentContainer && currentItem) {
                  this.renderInterface(currentContainer, currentItem);
                }
              } catch (err) {
                Zotero.debug(`[seerai] Error deleting item: ${err}`);
                btn.innerText = "❌";
              }
            },
          },
        ],
      });
      bombBtn.addEventListener("mouseenter", () => {
        bombBtn.style.backgroundColor = "rgba(198,40,40,0.2)";
      });
      bombBtn.addEventListener("mouseleave", () => {
        if (bombBtn.dataset.confirmBomb !== "true") {
          bombBtn.style.backgroundColor = "";
        }
      });
      actionsCell.appendChild(bombBtn);

      // Remove button
      const removeRowBtn = ztoolkit.UI.createElement(doc, "button", {
        properties: { innerText: "🗑️" },
        attributes: { title: "Remove this paper from the table" },
        styles: {
          background: "none",
          border: "none",
          fontSize: "14px",
          cursor: "pointer",
          padding: "4px",
          borderRadius: "4px",
          transition: "background-color 0.15s",
        },
        listeners: [
          {
            type: "click",
            listener: async (e: Event) => {
              e.stopPropagation();
              const btn = e.target as HTMLElement;

              // Confirm removal with visual feedback
              if (btn.dataset.confirmRemove !== "true") {
                btn.dataset.confirmRemove = "true";
                btn.innerText = "❌";
                btn.style.color = "#c62828";
                btn.style.backgroundColor = "rgba(198,40,40,0.15)";
                btn.title = "Click again to confirm removal";
                setTimeout(() => {
                  btn.dataset.confirmRemove = "";
                  btn.innerText = "🗑️";
                  btn.style.color = "";
                  btn.style.backgroundColor = "";
                  btn.title = "Remove this paper from the table";
                }, 3000);
                return;
              }

              // Remove paper from table
              if (currentTableConfig) {
                // Remove from addedPaperIds
                currentTableConfig.addedPaperIds =
                  currentTableConfig.addedPaperIds.filter(
                    (id) => id !== row.paperId,
                  );

                // Remove generated data for this paper
                if (
                  currentTableConfig.generatedData &&
                  currentTableConfig.generatedData[row.paperId]
                ) {
                  delete currentTableConfig.generatedData[row.paperId];
                }

                // Save config
                const tableStore = getTableStore();
                await tableStore.saveConfig(currentTableConfig);

                // Refresh the table UI
                if (currentContainer && currentItem) {
                  this.renderInterface(currentContainer, currentItem);
                }
              }
            },
          },
        ],
      });
      removeRowBtn.addEventListener("mouseenter", () => {
        removeRowBtn.style.backgroundColor = "rgba(198,40,40,0.2)";
      });
      removeRowBtn.addEventListener("mouseleave", () => {
        removeRowBtn.style.backgroundColor = "";
      });
      actionsCell.appendChild(removeRowBtn);
      tr.appendChild(actionsCell);

      tbody.appendChild(tr);
    });

    table.appendChild(tbody);

    // Return table directly - side strip handles add column button
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
        const tableWrapper = doc.querySelector(".table-wrapper");
        if (tableWrapper) {
          const tableData = await this.loadTableData();
          tableWrapper.innerHTML = "";
          if (tableData.rows.length === 0) {
            tableWrapper.appendChild(this.createTableEmptyState(doc, item));
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
    // Preserve previous selection if available
    const previousSelection =
      currentTableData?.selectedRowIds || new Set<number>();

    const tableData: TableData = {
      rows: [],
      selectedRowIds: previousSelection,
      isLoading: false,
      totalRows: 0,
      totalPages: 1,
      currentPage: currentTableConfig?.currentPage || 1,
      pageSize: currentTableConfig?.pageSize || 25,
    };

    try {
      // Only show papers that have been manually added
      const addedIds = currentTableConfig?.addedPaperIds || [];

      if (addedIds.length === 0) {
        // Table starts empty - user needs to add papers
        return tableData;
      }

      // Get filter settings
      const filterQuery = currentTableConfig?.filterQuery?.toLowerCase() || "";

      const allFilteredRows: TableRow[] = [];

      for (const paperId of addedIds) {
        const item = Zotero.Items.get(paperId);
        if (!item || !item.isRegularItem()) continue;

        // Get paper metadata
        const paperTitle = (item.getField("title") as string) || "Untitled";
        const creators = item.getCreators();
        const authorNames =
          creators
            .map((c) => `${c.firstName || ""} ${c.lastName || ""}`.trim())
            .join(", ") || "Unknown";
        const year = (item.getField("year") as string) || "";

        // Load any persisted generated data for this paper
        const persistedData =
          currentTableConfig?.generatedData?.[item.id] || {};

        // Apply search filter (check title, author, year, AND all other columns)
        if (filterQuery) {
          const searchTargets = [
            paperTitle,
            authorNames,
            year,
            // Add all other column data values
            ...Object.values(persistedData).map((v) => String(v || "")),
          ];

          const matches = searchTargets.some((target) =>
            target.toLowerCase().includes(filterQuery),
          );

          if (!matches) continue;
        }

        // Get note count for sources column
        const noteIDs = item.getNotes();

        allFilteredRows.push({
          paperId: item.id,
          paperTitle: paperTitle,
          noteIds: noteIDs,
          noteTitle: "", // Not used in manual add mode
          data: {
            title: paperTitle,
            author: authorNames,
            year: year,
            sources: String(noteIDs.length),
            analysisMethodology: persistedData["analysisMethodology"] || "",
            // Merge any other persisted computed columns
            ...persistedData,
          },
        });
      }

      // Sort
      const sortBy = currentTableConfig?.sortBy || "title";
      const sortOrder = currentTableConfig?.sortOrder || "asc";
      allFilteredRows.sort((a, b) => {
        const aVal = a.data[sortBy] || "";
        const bVal = b.data[sortBy] || "";
        const cmp = aVal.localeCompare(bVal);
        return sortOrder === "asc" ? cmp : -cmp;
      });

      // Set total rows
      tableData.totalRows = allFilteredRows.length;

      // Calculate pagination
      const pageSize = tableData.pageSize;
      tableData.totalPages = Math.max(
        1,
        Math.ceil(tableData.totalRows / pageSize),
      );

      // Ensure current page is within bounds
      if (tableData.currentPage > tableData.totalPages) {
        tableData.currentPage = tableData.totalPages;
        if (currentTableConfig)
          currentTableConfig.currentPage = tableData.currentPage;
      }
      if (tableData.currentPage < 1) {
        tableData.currentPage = 1;
        if (currentTableConfig) currentTableConfig.currentPage = 1;
      }

      // Slice rows for current page
      const startIndex = (tableData.currentPage - 1) * pageSize;
      const endIndex = startIndex + pageSize;
      tableData.rows = allFilteredRows.slice(startIndex, endIndex);
    } catch (e) {
      Zotero.debug(`[seerai] Error loading table data: ${e}`);
      tableData.error = String(e);
    }

    currentTableData = tableData;
    return tableData;
  }

  /**
   * Show column manager as a dropdown panel (like paper picker)
   */
  private static showColumnManagerModal(
    doc: Document,
    item: Zotero.Item,
  ): void {
    // Toggle existing dropdown
    const existing = doc.getElementById(
      "column-manager-dropdown",
    ) as HTMLElement;
    if (existing) {
      existing.style.opacity = "0";
      existing.style.transform = "translateY(-10px)";
      setTimeout(() => existing.remove(), 200);
      return;
    }

    // Find the toolbar to position dropdown below it
    const toolbar = doc.querySelector(".table-toolbar") as HTMLElement;
    const tabContent = doc.getElementById("tab-content");
    if (!toolbar || !tabContent) return;

    // Helper to close dropdown with animation
    const closeDropdown = () => {
      dropdown.style.opacity = "0";
      dropdown.style.transform = "translateY(-10px)";
      setTimeout(() => dropdown.remove(), 200);
    };

    // Create dropdown panel
    const dropdown = ztoolkit.UI.createElement(doc, "div", {
      properties: { id: "column-manager-dropdown" },
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
        marginTop: "4px",
        marginLeft: "8px",
        marginRight: "8px",
        maxHeight: "70vh",
        display: "flex",
        flexDirection: "column",
      },
    });

    // Header with gradient
    const header = ztoolkit.UI.createElement(doc, "div", {
      styles: {
        background:
          "linear-gradient(135deg, var(--highlight-primary) 0%, color-mix(in srgb, var(--highlight-primary) 80%, purple) 100%)",
        padding: "10px 14px",
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        gap: "12px",
      },
    });

    const headerTitle = ztoolkit.UI.createElement(doc, "div", {
      properties: { innerText: "⚙️ Manage Columns" },
      styles: {
        fontSize: "13px",
        fontWeight: "600",
        color: "var(--highlight-text)",
        textShadow: "0 1px 2px rgba(0,0,0,0.1)",
      },
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
        justifyContent: "center",
      },
      listeners: [
        {
          type: "click",
          listener: () => closeDropdown(),
        },
      ],
    });
    header.appendChild(closeBtn);
    dropdown.appendChild(header);

    // Content container (scrollable)
    const content = ztoolkit.UI.createElement(doc, "div", {
      styles: {
        padding: "10px 14px",
        display: "flex",
        flexDirection: "column",
        gap: "10px",
        overflowY: "auto",
        flex: "1",
      },
    });

    // --- Presets Section ---
    const presetSection = ztoolkit.UI.createElement(doc, "div", {
      styles: {
        display: "flex",
        gap: "6px",
        padding: "10px",
        backgroundColor: "var(--background-secondary)",
        borderRadius: "6px",
        border: "1px solid var(--border-primary)",
        flexWrap: "wrap",
        alignItems: "center",
      },
    });

    // Preset selector
    const presetSelect = ztoolkit.UI.createElement(doc, "select", {
      styles: {
        flex: "1",
        padding: "6px 10px",
        borderRadius: "6px",
        border: "1px solid var(--border-primary)",
        minWidth: "120px",
        fontSize: "12px",
        backgroundColor: "var(--background-secondary)",
        color: "var(--text-primary)",
        cursor: "pointer",
        outline: "none",
      },
    }) as HTMLSelectElement;

    const defaultOption = ztoolkit.UI.createElement(doc, "option", {
      properties: { value: "", innerText: "Select a preset..." },
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

      presets.forEach((p) => {
        const opt = ztoolkit.UI.createElement(doc, "option", {
          properties: { value: p.id, innerText: p.name },
        });
        presetSelect.appendChild(opt);
      });
      return presets;
    };
    // Initial load
    loadPresetsList();

    // Preset buttons container
    const presetBtnsRow = ztoolkit.UI.createElement(doc, "div", {
      styles: { display: "flex", gap: "4px" },
    });

    // Load Button
    const loadPresetBtn = ztoolkit.UI.createElement(doc, "button", {
      properties: { innerText: "📥" },
      attributes: { title: "Load preset" },
      styles: {
        padding: "6px 10px",
        border: "1px solid var(--border-primary)",
        borderRadius: "6px",
        cursor: "pointer",
        backgroundColor: "var(--background-primary)",
        fontSize: "12px",
      },
      listeners: [
        {
          type: "click",
          listener: async () => {
            const selectedId = presetSelect.value;
            if (!selectedId) return;

            const tableStore = getTableStore();
            const presets = await tableStore.loadPresets();
            const preset = presets.find((p) => p.id === selectedId);

            if (preset && currentTableConfig) {
              // confirm overwrite
              const confirmLoad = doc.defaultView?.confirm(
                `Load preset "${preset.name}"? This will replace current columns.`,
              );
              if (confirmLoad) {
                currentTableConfig.columns = [...preset.columns];
                await tableStore.saveConfig(currentTableConfig);
                closeDropdown();
                if (currentContainer && currentItem) {
                  this.renderInterface(currentContainer, currentItem);
                }
              }
            }
          },
        },
      ],
    });

    // Save Button
    const savePresetBtn = ztoolkit.UI.createElement(doc, "button", {
      properties: { innerText: "💾" },
      attributes: { title: "Save current as preset" },
      styles: {
        padding: "6px 10px",
        border: "1px solid var(--border-primary)",
        borderRadius: "6px",
        cursor: "pointer",
        backgroundColor: "var(--background-primary)",
        fontSize: "12px",
      },
      listeners: [
        {
          type: "click",
          listener: async () => {
            if (!currentTableConfig) return;

            const name = doc.defaultView?.prompt(
              "Enter name for this column preset:",
              "My Custom Columns",
            );
            if (name) {
              const newPreset: ColumnPreset = {
                id: `preset_${Date.now()}`,
                name: name,
                columns: [...currentTableConfig.columns],
                createdAt: new Date().toISOString(),
              };

              const tableStore = getTableStore();
              await tableStore.savePreset(newPreset);
              await loadPresetsList(); // Refresh list
              presetSelect.value = newPreset.id; // Select it
              doc.defaultView?.alert(`Preset "${name}" saved!`);
            }
          },
        },
      ],
    });

    // Delete Button
    const deletePresetBtn = ztoolkit.UI.createElement(doc, "button", {
      properties: { innerText: "🗑" },
      attributes: { title: "Delete selected preset" },
      styles: {
        padding: "6px 10px",
        border: "1px solid var(--border-primary)",
        borderRadius: "6px",
        cursor: "pointer",
        color: "#c62828",
        backgroundColor: "var(--background-primary)",
        fontSize: "12px",
      },
      listeners: [
        {
          type: "click",
          listener: async () => {
            const selectedId = presetSelect.value;
            if (!selectedId) return;

            const tableStore = getTableStore();
            const presets = await tableStore.loadPresets();
            const preset = presets.find((p) => p.id === selectedId);

            if (preset) {
              const confirmDelete = doc.defaultView?.confirm(
                `Delete preset "${preset.name}"?`,
              );
              if (confirmDelete) {
                await tableStore.deletePreset(selectedId);
                await loadPresetsList();
                presetSelect.value = "";
              }
            }
          },
        },
      ],
    });

    presetBtnsRow.appendChild(loadPresetBtn);
    presetBtnsRow.appendChild(savePresetBtn);
    presetBtnsRow.appendChild(deletePresetBtn);

    presetSection.appendChild(presetSelect);
    presetSection.appendChild(presetBtnsRow);
    content.appendChild(presetSection);

    // Column list
    const columnList = ztoolkit.UI.createElement(doc, "div", {
      properties: { className: "column-manager-list" },
      styles: {
        display: "flex",
        flexDirection: "column",
        gap: "4px",
        maxHeight: "200px",
        overflowY: "auto",
        border: "1px solid var(--border-primary)",
        borderRadius: "6px",
        backgroundColor: "var(--background-secondary)",
      },
    });

    const columns = currentTableConfig?.columns || defaultColumns;
    columns.forEach((col) => {
      const row = ztoolkit.UI.createElement(doc, "label", {
        properties: { className: "column-manager-item" },
        styles: {
          display: "flex",
          alignItems: "center",
          gap: "8px",
          padding: "8px 10px",
          cursor: "pointer",
          borderBottom: "1px solid var(--border-primary)",
        },
      });

      const checkbox = ztoolkit.UI.createElement(doc, "input", {
        attributes: { type: "checkbox" },
      }) as HTMLInputElement;
      checkbox.checked = col.visible;
      checkbox.addEventListener("change", async () => {
        col.visible = checkbox.checked;
        if (currentTableConfig) {
          const tableStore = getTableStore();
          await tableStore.saveConfig(currentTableConfig);
        }
      });

      const label = ztoolkit.UI.createElement(doc, "span", {
        properties: { innerText: col.name },
        styles: { flex: "1", fontSize: "12px" },
      });

      row.appendChild(checkbox);
      row.appendChild(label);

      // Delete button (only for non-core columns)
      const coreColumns = ["title", "author", "year", "sources"];
      if (!coreColumns.includes(col.id)) {
        const deleteBtn = ztoolkit.UI.createElement(doc, "button", {
          properties: { innerText: "🗑" },
          styles: {
            background: "none",
            border: "none",
            fontSize: "12px",
            cursor: "pointer",
            color: "#c62828",
            padding: "2px 4px",
          },
          listeners: [
            {
              type: "click",
              listener: async (e: Event) => {
                e.preventDefault();
                e.stopPropagation();
                if (currentTableConfig) {
                  currentTableConfig.columns =
                    currentTableConfig.columns.filter((c) => c.id !== col.id);
                  const tableStore = getTableStore();
                  await tableStore.saveConfig(currentTableConfig);
                  row.remove();
                }
              },
            },
          ],
        });
        row.appendChild(deleteBtn);
      }

      columnList.appendChild(row);
    });

    content.appendChild(columnList);

    // Add new column section
    const addSection = ztoolkit.UI.createElement(doc, "div", {
      styles: {
        borderTop: "1px solid var(--border-primary)",
        paddingTop: "10px",
        display: "flex",
        flexDirection: "column",
        gap: "6px",
      },
    });

    const addLabel = ztoolkit.UI.createElement(doc, "div", {
      properties: { innerText: "➕ Add New Column" },
      styles: {
        fontSize: "12px",
        fontWeight: "600",
        color: "var(--text-secondary)",
      },
    });
    addSection.appendChild(addLabel);

    const newColumnInput = ztoolkit.UI.createElement(doc, "input", {
      attributes: { type: "text", placeholder: "Column name..." },
      styles: {
        width: "100%",
        padding: "8px 10px",
        border: "1px solid var(--border-primary)",
        borderRadius: "6px",
        fontSize: "12px",
        backgroundColor: "var(--background-secondary)",
        color: "var(--text-primary)",
        outline: "none",
        boxSizing: "border-box",
      },
    }) as HTMLInputElement;
    addSection.appendChild(newColumnInput);

    const newColumnDesc = ztoolkit.UI.createElement(doc, "textarea", {
      attributes: {
        placeholder: 'AI Prompt (e.g. "Extract the main findings...")',
      },
      styles: {
        width: "100%",
        padding: "8px 10px",
        border: "1px solid var(--border-primary)",
        borderRadius: "6px",
        fontSize: "12px",
        minHeight: "50px",
        resize: "vertical",
        backgroundColor: "var(--background-secondary)",
        color: "var(--text-primary)",
        outline: "none",
        boxSizing: "border-box",
      },
    }) as HTMLTextAreaElement;
    addSection.appendChild(newColumnDesc);

    const addColumnBtn = ztoolkit.UI.createElement(doc, "button", {
      properties: { innerText: "Add Column" },
      styles: {
        padding: "8px 16px",
        border: "none",
        borderRadius: "6px",
        backgroundColor: "var(--highlight-primary)",
        color: "var(--highlight-text)",
        cursor: "pointer",
        fontWeight: "600",
        fontSize: "12px",
        width: "100%",
      },
      listeners: [
        {
          type: "click",
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
                type: "computed", // AI-generated column
                aiPrompt:
                  aiPrompt ||
                  `Extract information related to "${name}" from this paper.`,
              };
              currentTableConfig.columns.push(newColumn);
              const tableStore = getTableStore();
              await tableStore.saveConfig(currentTableConfig);
              closeDropdown();
              if (currentContainer && currentItem) {
                this.renderInterface(currentContainer, currentItem);
              }
            }
          },
        },
      ],
    });
    addSection.appendChild(addColumnBtn);
    content.appendChild(addSection);

    dropdown.appendChild(content);

    // Insert dropdown after toolbar
    toolbar.insertAdjacentElement("afterend", dropdown);

    // Animate in
    setTimeout(() => {
      dropdown.style.opacity = "1";
      dropdown.style.transform = "translateY(0)";
    }, 10);

    // Click outside to close
    const handleClickOutside = (e: Event) => {
      if (
        !dropdown.contains(e.target as Node) &&
        !toolbar.contains(e.target as Node)
      ) {
        closeDropdown();
        doc.removeEventListener("click", handleClickOutside);
      }
    };
    // Delay to avoid immediate trigger
    setTimeout(() => {
      doc.addEventListener("click", handleClickOutside);
    }, 100);
  }

  /**
   * Show quick dropdown for adding a new column (triggered from + in table header)
   */
  private static showQuickAddColumnDropdown(
    doc: Document,
    anchorEl: HTMLElement,
  ): void {
    // Toggle existing dropdown
    const existing = doc.getElementById(
      "quick-add-column-dropdown",
    ) as HTMLElement;
    if (existing) {
      existing.style.opacity = "0";
      existing.style.transform = "translateY(-5px)";
      setTimeout(() => existing.remove(), 150);
      return;
    }

    // Helper to close dropdown with animation
    const closeDropdown = () => {
      dropdown.style.opacity = "0";
      dropdown.style.transform = "translateY(-5px)";
      setTimeout(() => dropdown.remove(), 150);
    };

    // Create dropdown panel
    const dropdown = ztoolkit.UI.createElement(doc, "div", {
      properties: { id: "quick-add-column-dropdown" },
      styles: {
        position: "absolute",
        top: "100%",
        right: "0",
        zIndex: "1000",
        backgroundColor: "var(--background-primary)",
        borderRadius: "8px",
        padding: "0",
        boxShadow: "0 4px 16px rgba(0,0,0,0.15)",
        overflow: "hidden",
        border: "1px solid var(--border-primary)",
        transition: "all 0.15s ease-out",
        opacity: "0",
        transform: "translateY(-5px)",
        marginTop: "4px",
        minWidth: "220px",
      },
    });

    // Header
    const header = ztoolkit.UI.createElement(doc, "div", {
      styles: {
        background:
          "linear-gradient(135deg, var(--highlight-primary) 0%, color-mix(in srgb, var(--highlight-primary) 80%, purple) 100%)",
        padding: "8px 12px",
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
      },
    });

    const headerTitle = ztoolkit.UI.createElement(doc, "div", {
      properties: { innerText: "➕ New Column" },
      styles: {
        fontSize: "12px",
        fontWeight: "600",
        color: "var(--highlight-text)",
      },
    });
    header.appendChild(headerTitle);

    const closeBtn = ztoolkit.UI.createElement(doc, "button", {
      properties: { innerText: "✕" },
      styles: {
        background: "rgba(0,0,0,0.1)",
        border: "none",
        borderRadius: "50%",
        width: "18px",
        height: "18px",
        cursor: "pointer",
        color: "var(--highlight-text)",
        fontSize: "10px",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      },
      listeners: [
        {
          type: "click",
          listener: () => closeDropdown(),
        },
      ],
    });
    header.appendChild(closeBtn);
    dropdown.appendChild(header);

    // Content
    const content = ztoolkit.UI.createElement(doc, "div", {
      styles: {
        padding: "10px 12px",
        display: "flex",
        flexDirection: "column",
        gap: "8px",
      },
    });

    // Name input
    const nameInput = ztoolkit.UI.createElement(doc, "input", {
      attributes: { type: "text", placeholder: "Column name..." },
      styles: {
        width: "100%",
        padding: "8px 10px",
        border: "1px solid var(--border-primary)",
        borderRadius: "6px",
        fontSize: "12px",
        backgroundColor: "var(--background-secondary)",
        color: "var(--text-primary)",
        outline: "none",
        boxSizing: "border-box",
      },
    }) as HTMLInputElement;
    content.appendChild(nameInput);

    // AI Prompt input
    const promptInput = ztoolkit.UI.createElement(doc, "textarea", {
      attributes: { placeholder: 'AI Prompt (e.g. "Extract findings...")' },
      styles: {
        width: "100%",
        padding: "8px 10px",
        border: "1px solid var(--border-primary)",
        borderRadius: "6px",
        fontSize: "11px",
        minHeight: "50px",
        resize: "vertical",
        backgroundColor: "var(--background-secondary)",
        color: "var(--text-primary)",
        outline: "none",
        boxSizing: "border-box",
      },
    }) as HTMLTextAreaElement;
    content.appendChild(promptInput);

    // Add button
    const addBtn = ztoolkit.UI.createElement(doc, "button", {
      properties: { innerText: "Add Column" },
      styles: {
        padding: "8px 12px",
        border: "none",
        borderRadius: "6px",
        backgroundColor: "var(--highlight-primary)",
        color: "var(--highlight-text)",
        cursor: "pointer",
        fontWeight: "600",
        fontSize: "12px",
        width: "100%",
      },
      listeners: [
        {
          type: "click",
          listener: async () => {
            const name = nameInput.value.trim();
            if (!name) {
              nameInput.style.borderColor = "#c62828";
              return;
            }

            if (currentTableConfig) {
              const aiPrompt = promptInput.value.trim();
              const newColumn: TableColumn = {
                id: `custom_${Date.now()}`,
                name,
                width: 150,
                minWidth: 80,
                visible: true,
                sortable: false,
                resizable: true,
                type: "computed",
                aiPrompt:
                  aiPrompt ||
                  `Extract information related to "${name}" from this paper.`,
              };
              currentTableConfig.columns.push(newColumn);
              const tableStore = getTableStore();
              await tableStore.saveConfig(currentTableConfig);
              closeDropdown();
              if (currentContainer && currentItem) {
                this.renderInterface(currentContainer, currentItem);
              }
            }
          },
        },
      ],
    });
    content.appendChild(addBtn);

    dropdown.appendChild(content);

    // Position dropdown to the left of the + button
    anchorEl.style.position = "relative";
    dropdown.style.position = "absolute";
    dropdown.style.top = "0";
    dropdown.style.right = "100%"; // Position to the left of the button
    dropdown.style.marginRight = "4px";
    anchorEl.appendChild(dropdown);

    // Stop propagation on inputs to prevent click-outside from triggering
    nameInput.addEventListener("click", (e) => e.stopPropagation());
    nameInput.addEventListener("mousedown", (e) => e.stopPropagation());
    promptInput.addEventListener("click", (e) => e.stopPropagation());
    promptInput.addEventListener("mousedown", (e) => e.stopPropagation());

    // Animate in
    setTimeout(() => {
      dropdown.style.opacity = "1";
      dropdown.style.transform = "translateY(0)";
    }, 10);

    // Focus name input
    setTimeout(() => nameInput.focus(), 50);

    // Click outside to close
    const handleClickOutside = (e: Event) => {
      const target = e.target as Node;
      // Check if click is inside dropdown or on the anchor button
      if (!dropdown.contains(target) && !anchorEl.contains(target)) {
        closeDropdown();
        doc.removeEventListener("click", handleClickOutside);
      }
    };
    setTimeout(() => {
      doc.addEventListener("click", handleClickOutside);
    }, 150);
  }

  /**
   * Immediately add a new table column and open inline editor
   */
  private static async addImmediateTableColumn(
    doc: Document,
    item: Zotero.Item,
    container: HTMLElement,
  ): Promise<void> {
    if (!currentTableConfig) return;

    const newColumn: TableColumn = {
      id: `custom_${Date.now()}`,
      name: "New Column",
      width: 150,
      minWidth: 80,
      visible: true,
      sortable: false,
      resizable: true,
      type: "computed",
      aiPrompt: "Describe what information to extract from this paper...",
    };

    currentTableConfig.columns.push(newColumn);
    const tableStore = getTableStore();
    await tableStore.saveConfig(currentTableConfig);

    // Re-render the interface
    if (currentContainer && currentItem) {
      this.renderInterface(currentContainer, currentItem);

      // After render, find the new column header and open editor
      setTimeout(() => {
        const headerCells = doc.querySelectorAll("th[data-column-id]");
        const newColHeader = (Array.from(headerCells) as HTMLElement[]).find(
          (th) => th.getAttribute("data-column-id") === newColumn.id,
        );

        if (newColHeader) {
          this.showTableColumnEditPopover(
            doc,
            newColHeader,
            newColumn,
            item,
            container,
          );
        }
      }, 100);
    }
  }

  /**
   * Show inline editor popover for a table column header
   * Auto-saves changes on input blur/change
   */
  private static showTableColumnEditPopover(
    doc: Document,
    anchorEl: HTMLElement,
    column: TableColumn,
    item: Zotero.Item,
    container: HTMLElement,
  ): void {
    // Remove any existing popover
    const existing = doc.getElementById("table-column-editor-popover");
    if (existing) existing.remove();
    const existingBackdrop = doc.getElementById("table-column-editor-backdrop");
    if (existingBackdrop) existingBackdrop.remove();

    // Debounce timer for auto-save
    let saveDebounceTimer: ReturnType<typeof setTimeout> | null = null;

    const autoSave = async () => {
      if (saveDebounceTimer) clearTimeout(saveDebounceTimer);
      saveDebounceTimer = setTimeout(async () => {
        if (currentTableConfig) {
          const tableStore = getTableStore();
          await tableStore.saveConfig(currentTableConfig);
          // Update header text in place
          const headerText = anchorEl.querySelector(
            ".column-header-text",
          ) as HTMLElement;
          if (headerText) {
            headerText.innerText = column.name;
          }
        }
      }, 300);
    };

    // Backdrop for click-outside-to-close
    const backdrop = ztoolkit.UI.createElement(doc, "div", {
      properties: { id: "table-column-editor-backdrop" },
      styles: {
        position: "fixed",
        top: "0",
        left: "0",
        right: "0",
        bottom: "0",
        zIndex: "998",
      },
      listeners: [
        {
          type: "click",
          listener: (e: Event) => {
            e.stopPropagation();
            if (saveDebounceTimer) clearTimeout(saveDebounceTimer);
            backdrop.remove();
            const p = doc.getElementById("table-column-editor-popover");
            if (p) p.remove();
          },
        },
      ],
    });
    if (doc.body) {
      doc.body.appendChild(backdrop);
    } else {
      doc.documentElement?.appendChild(backdrop);
    }

    // Create popover
    const popover = ztoolkit.UI.createElement(doc, "div", {
      properties: { id: "table-column-editor-popover" },
      styles: {
        position: "fixed",
        zIndex: "999",
        backgroundColor: "var(--background-primary)",
        border: "1px solid var(--border-primary)",
        borderRadius: "8px",
        padding: "12px",
        boxShadow: "0 4px 12px rgba(0,0,0,0.15)",
        width: "280px",
        display: "flex",
        flexDirection: "column",
        gap: "10px",
      },
      listeners: [
        {
          type: "click",
          listener: (e: Event) => e.stopPropagation(),
        },
      ],
    });

    // Title label
    const nameLabel = ztoolkit.UI.createElement(doc, "div", {
      properties: { innerText: "Column Title" },
      styles: {
        fontSize: "11px",
        fontWeight: "600",
        color: "var(--text-secondary)",
      },
    });
    popover.appendChild(nameLabel);

    // Title input
    const nameInput = ztoolkit.UI.createElement(doc, "input", {
      properties: { value: column.name, placeholder: "Column Name" },
      styles: {
        padding: "8px 10px",
        border: "1px solid var(--border-primary)",
        borderRadius: "6px",
        fontSize: "13px",
        width: "100%",
        boxSizing: "border-box",
        backgroundColor: "var(--background-secondary)",
        color: "var(--text-primary)",
      },
    }) as HTMLInputElement;

    nameInput.addEventListener("input", () => {
      column.name = nameInput.value;
      autoSave();
    });
    popover.appendChild(nameInput);

    // AI Prompt label
    const promptLabel = ztoolkit.UI.createElement(doc, "div", {
      properties: { innerText: "AI Instructions" },
      styles: {
        fontSize: "11px",
        fontWeight: "600",
        color: "var(--text-secondary)",
        marginTop: "4px",
      },
    });
    popover.appendChild(promptLabel);

    // AI Prompt textarea
    const promptInput = ztoolkit.UI.createElement(doc, "textarea", {
      properties: {
        value: column.aiPrompt || "",
        placeholder: "E.g., Summarize the methodology...",
      },
      styles: {
        padding: "8px 10px",
        border: "1px solid var(--border-primary)",
        borderRadius: "6px",
        fontSize: "12px",
        width: "100%",
        height: "80px",
        resize: "vertical",
        fontFamily: "inherit",
        boxSizing: "border-box",
        backgroundColor: "var(--background-secondary)",
        color: "var(--text-primary)",
        lineHeight: "1.4",
      },
    }) as HTMLTextAreaElement;

    promptInput.addEventListener("input", () => {
      column.aiPrompt = promptInput.value;
      autoSave();
    });
    popover.appendChild(promptInput);

    // Remove Column button
    const removeBtn = ztoolkit.UI.createElement(doc, "button", {
      properties: { innerText: "🗑️ Remove Column" },
      styles: {
        padding: "8px 12px",
        fontSize: "12px",
        color: "#c62828",
        border: "1px solid #c62828",
        borderRadius: "6px",
        backgroundColor: "transparent",
        cursor: "pointer",
        marginTop: "6px",
      },
      listeners: [
        {
          type: "click",
          listener: async () => {
            if (currentTableConfig) {
              // Remove column from config
              currentTableConfig.columns = currentTableConfig.columns.filter(
                (c) => c.id !== column.id,
              );
              // Remove generated data for this column
              if (currentTableConfig.generatedData) {
                for (const paperId in currentTableConfig.generatedData) {
                  delete currentTableConfig.generatedData[paperId][column.id];
                }
              }
              const tableStore = getTableStore();
              await tableStore.saveConfig(currentTableConfig);
              backdrop.remove();
              popover.remove();
              // Re-render
              if (currentContainer && currentItem) {
                this.renderInterface(currentContainer, currentItem);
              }
            }
          },
        },
      ],
    });

    // Hover effect for remove button
    removeBtn.addEventListener("mouseenter", () => {
      removeBtn.style.backgroundColor = "#c62828";
      removeBtn.style.color = "white";
    });
    removeBtn.addEventListener("mouseleave", () => {
      removeBtn.style.backgroundColor = "transparent";
      removeBtn.style.color = "#c62828";
    });

    popover.appendChild(removeBtn);

    // Position popover below the anchor element
    const rect = anchorEl.getBoundingClientRect();
    const view = doc.defaultView || { innerHeight: 800, innerWidth: 1200 };
    const spaceBelow = view.innerHeight - rect.bottom;

    if (spaceBelow < 280) {
      // Position above if not enough space below
      popover.style.bottom = `${view.innerHeight - rect.top + 5}px`;
    } else {
      popover.style.top = `${rect.bottom + 5}px`;
    }

    // Horizontal positioning - try to align left edge with anchor
    let leftPos = rect.left;
    if (leftPos + 280 > view.innerWidth) {
      leftPos = view.innerWidth - 290;
    }
    popover.style.left = `${leftPos}px`;

    if (doc.body) {
      doc.body.appendChild(popover);
    } else {
      doc.documentElement?.appendChild(popover);
    }

    // Focus the name input
    nameInput.focus();
    nameInput.select();
  }

  // ==================== Search Results Table ====================

  /**
   * Helper to create a unified result row (Card + AI Columns)
   */
  private static createUnifiedResultRow(
    doc: Document,
    paper: SemanticScholarPaper,
    item: Zotero.Item,
    columns: SearchColumnConfig["columns"],
  ): HTMLTableRowElement {
    const tr = ztoolkit.UI.createElement(doc, "tr", {
      styles: {
        borderBottom: "1px solid var(--border-primary)",
      },
    }) as HTMLTableRowElement;

    // Hover effect
    tr.addEventListener("mouseenter", () => {
      tr.style.backgroundColor = "var(--background-secondary)";
    });
    tr.addEventListener("mouseleave", () => {
      tr.style.backgroundColor = "";
    });

    // === CARD CELL ===
    const cardCell = ztoolkit.UI.createElement(doc, "td", {
      styles: {
        padding: "0",
        width: "100%", // Take mostly all space if no columns
        verticalAlign: "top",
      },
    });

    // Create the card with Table Cell mode (optional logic could reside in createSearchResultCard,
    // but here we just manually unset border since we returned HTMLElement)
    const card = this.createSearchResultCard(doc, paper, item, true);
    card.style.borderBottom = "none"; // Ensure no double border
    card.style.width = "100%";
    card.style.boxSizing = "border-box"; // Ensure padding doesn't overflow
    cardCell.appendChild(card);
    tr.appendChild(cardCell);

    // === AI COLUMN CELLS ===
    columns.forEach((col) => {
      const td = ztoolkit.UI.createElement(doc, "td", {
        styles: {
          padding: "12px",
          verticalAlign: "top",
          borderLeft: "1px solid var(--border-primary)",
          minWidth: "150px",
          maxWidth: "250px",
          backgroundColor: "rgba(0,0,0,0.01)", // Slight tint for AI columns
        },
      });

      const cachedValue =
        searchColumnConfig.generatedData[paper.paperId]?.[col.id];

      if (cachedValue) {
        const contentDiv = ztoolkit.UI.createElement(doc, "div", {
          styles: {
            whiteSpace: "pre-wrap",
            lineHeight: "1.4",
            fontSize: "11px",
            color: "var(--text-secondary)",
            cursor: "pointer",
          },
          listeners: [
            {
              type: "click",
              listener: (e: Event) => {
                e.stopPropagation();
                // Find results container (ancestor)
                const resultsContainer = tr.closest(
                  "#semantic-scholar-results",
                );
                if (resultsContainer) {
                  this.showSearchCellDetailModal(
                    doc,
                    paper,
                    col,
                    cachedValue,
                    resultsContainer as HTMLElement,
                    item,
                  );
                }
              },
            },
          ],
        });
        contentDiv.innerHTML = parseMarkdown(cachedValue);
        td.appendChild(contentDiv);
      } else {
        // Generate button
        const genBtn = ztoolkit.UI.createElement(doc, "button", {
          properties: { innerText: "✨ Generate" },
          styles: {
            padding: "6px 12px",
            fontSize: "11px",
            border: "1px solid var(--highlight-primary)",
            borderRadius: "4px",
            backgroundColor: "var(--background-primary)",
            color: "var(--highlight-primary)",
            cursor: "pointer",
            width: "100%",
          },
          listeners: [
            {
              type: "click",
              listener: async (e: Event) => {
                e.stopPropagation();
                const btn = e.target as HTMLButtonElement;
                const originalText = btn.innerText;
                btn.innerText = "⏳ Thinking...";
                btn.disabled = true;

                try {
                  const result = await this.analyzeSearchPaperColumn(
                    paper,
                    col,
                  );
                  td.innerHTML = "";
                  const contentDiv = ztoolkit.UI.createElement(doc, "div", {
                    styles: {
                      whiteSpace: "pre-wrap",
                      lineHeight: "1.4",
                      fontSize: "11px",
                      color: "var(--text-primary)",
                      cursor: "pointer",
                    },
                    listeners: [
                      {
                        type: "click",
                        listener: (e: Event) => {
                          e.stopPropagation();
                          const resultsContainer = tr.closest(
                            "#semantic-scholar-results",
                          );
                          if (resultsContainer) {
                            this.showSearchCellDetailModal(
                              doc,
                              paper,
                              col,
                              result,
                              resultsContainer as HTMLElement,
                              item,
                            );
                          }
                        },
                      },
                    ],
                  });
                  contentDiv.innerHTML = parseMarkdown(result);
                  td.appendChild(contentDiv);
                } catch (err) {
                  btn.innerText = "❌ Error";
                  btn.title = String(err);
                  setTimeout(() => {
                    btn.innerText = originalText;
                    btn.disabled = false;
                  }, 3000);
                }
              },
            },
          ],
        });
        td.appendChild(genBtn);
      }

      tr.appendChild(td);
    });

    return tr;
  }

  /**
   * Render the unified search results table (Card + Optional Columns)
   */
  private static renderUnifiedSearchResults(
    doc: Document,
    resultsContainer: HTMLElement,
    item: Zotero.Item,
  ): HTMLElement {
    // Main flex container: table on left, + button on right
    const wrapper = ztoolkit.UI.createElement(doc, "div", {
      styles: {
        display: "flex",
        flexDirection: "row",
        width: "100%",
        flex: "1",
        minHeight: "0",
        overflow: "hidden",
      },
    });

    // Scrollable table container
    const tableContainer = ztoolkit.UI.createElement(doc, "div", {
      styles: {
        flex: "1",
        overflow: "auto",
      },
    });

    // Create HTML table
    const table = ztoolkit.UI.createElement(doc, "table", {
      styles: {
        width: "100%",
        borderCollapse: "collapse",
        fontSize: "11px",
        tableLayout: "fixed", // CRITICAL FOR RESIZING
      },
    });

    // === TABLE HEADER ===
    // Only show header if we have AI columns
    if (searchColumnConfig.columns.length > 0) {
      const thead = ztoolkit.UI.createElement(doc, "thead", {});
      const headerRow = ztoolkit.UI.createElement(doc, "tr", {
        styles: {
          backgroundColor: "var(--background-tertiary)",
          position: "sticky",
          top: "0",
          zIndex: "10",
        },
      });

      // Paper column header (Main Card Column)

      // Paper column header (Main Card Column)
      const paperHeader = ztoolkit.UI.createElement(doc, "th", {
        properties: { innerText: "Paper Details" },
        styles: {
          padding: "8px 12px",
          textAlign: "left",
          fontWeight: "600",
          borderBottom: "2px solid var(--border-primary)",
          width: "300px", // Default start width
          color: "var(--text-primary)",
          position: "relative",
          userSelect: "none",
          boxSizing: "border-box",
          overflow: "hidden",
          whiteSpace: "nowrap",
          textOverflow: "ellipsis",
        },
      });

      // === RESIZER HANDLE FOR PAPER COLUMN ===
      const paperResizer = ztoolkit.UI.createElement(doc, "div", {
        styles: {
          position: "absolute",
          right: "0",
          top: "0",
          bottom: "0",
          width: "5px",
          cursor: "col-resize",
          backgroundColor: "transparent",
          zIndex: "11",
        },
      });

      paperResizer.addEventListener("mouseenter", () => {
        paperResizer.style.backgroundColor = "var(--highlight-primary)";
      });
      paperResizer.addEventListener("mouseleave", () => {
        paperResizer.style.backgroundColor = "transparent";
      });

      paperResizer.addEventListener("mousedown", (e: MouseEvent) => {
        e.stopPropagation();
        e.preventDefault(); // Prevent text selection
        // Use rect for stable calculation
        const startLeft = paperHeader.getBoundingClientRect().left;

        // Set global cursor to prevent fluttering
        if (doc.body) doc.body.style.cursor = "col-resize";

        const onMouseMove = (moveEvent: MouseEvent) => {
          // Calculate exact width based on current mouse position relative to left edge
          const newWidth = moveEvent.clientX - startLeft;
          if (newWidth > 60) {
            // Ultra-low min width
            paperHeader.style.width = `${newWidth}px`;
            paperHeader.style.minWidth = `${newWidth}px`;
          }
        };

        const onMouseUp = () => {
          doc.removeEventListener("mousemove", onMouseMove);
          doc.removeEventListener("mouseup", onMouseUp);
          if (doc.body) doc.body.style.cursor = ""; // Reset cursor
        };

        doc.addEventListener("mousemove", onMouseMove);
        doc.addEventListener("mouseup", onMouseUp);
      });
      paperHeader.appendChild(paperResizer);
      headerRow.appendChild(paperHeader);

      // AI column headers
      searchColumnConfig.columns.forEach((col) => {
        const th = ztoolkit.UI.createElement(doc, "th", {
          styles: {
            padding: "8px 10px",
            textAlign: "left",
            fontWeight: "600",
            borderBottom: "2px solid var(--border-primary)",
            borderLeft: "1px solid var(--border-primary)",
            minWidth: `${col.width || 200}px`, // Use saved width
            width: `${col.width || 200}px`,
            maxWidth: "600px",
            color: "var(--text-primary)",
            position: "relative", // For absolute positioning of resizer
            userSelect: "none",
          },
        });

        // Column name with Edit capability (Title & Description adjustable)
        const headerContent = ztoolkit.UI.createElement(doc, "div", {
          styles: {
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: "4px",
            cursor: "pointer",
            width: "100%",
          },
          listeners: [
            {
              type: "click",
              listener: (e: Event) => {
                e.stopPropagation();
                this.showColumnEditor(doc, th, col, resultsContainer, item);
              },
            },
          ],
        });

        // Name + Edit Hint Container
        const nameContainer = ztoolkit.UI.createElement(doc, "div", {
          styles: {
            display: "flex",
            alignItems: "center",
            gap: "6px",
            overflow: "hidden",
            flex: "1",
          },
        });

        const colName = ztoolkit.UI.createElement(doc, "span", {
          properties: { innerText: col.name },
          attributes: { title: col.aiPrompt },
          styles: {
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
            fontSize: "12px",
            fontWeight: "600",
          },
        });
        nameContainer.appendChild(colName);

        // Edit Icon (Pencil)
        const editIcon = ztoolkit.UI.createElement(doc, "span", {
          properties: { innerHTML: "✎" },
          styles: { fontSize: "12px", opacity: "0.4" },
        });

        // Hover effect for edit icon
        headerContent.addEventListener(
          "mouseenter",
          () => (editIcon.style.opacity = "1"),
        );
        headerContent.addEventListener(
          "mouseleave",
          () => (editIcon.style.opacity = "0.4"),
        );

        nameContainer.appendChild(editIcon);
        headerContent.appendChild(nameContainer);

        th.appendChild(headerContent);

        // === RESIZER HANDLE ===
        const resizer = ztoolkit.UI.createElement(doc, "div", {
          styles: {
            position: "absolute",
            right: "0",
            top: "0",
            bottom: "0",
            width: "5px",
            cursor: "col-resize",
            backgroundColor: "transparent",
            zIndex: "11",
          },
        });

        resizer.addEventListener("mouseenter", () => {
          resizer.style.backgroundColor = "var(--highlight-primary)";
        });
        resizer.addEventListener("mouseleave", () => {
          resizer.style.backgroundColor = "transparent";
        });

        resizer.addEventListener("mousedown", (e: MouseEvent) => {
          e.stopPropagation();
          e.preventDefault();
          // Use rect for stable calculation
          const startLeft = th.getBoundingClientRect().left;

          if (doc.body) doc.body.style.cursor = "col-resize";

          const onMouseMove = (moveEvent: MouseEvent) => {
            const newWidth = moveEvent.clientX - startLeft;
            if (newWidth > 50) {
              // Min width
              th.style.width = `${newWidth}px`;
              th.style.minWidth = `${newWidth}px`;
            }
          };

          const onMouseUp = async () => {
            doc.removeEventListener("mousemove", onMouseMove);
            doc.removeEventListener("mouseup", onMouseUp);
            if (doc.body) doc.body.style.cursor = ""; // Reset cursor
            // Save new width
            col.width = parseInt(th.style.width);
            await saveSearchColumnConfig();
          };

          doc.addEventListener("mousemove", onMouseMove);
          doc.addEventListener("mouseup", onMouseUp);
        });

        th.appendChild(resizer);
        headerRow.appendChild(th);
      });

      thead.appendChild(headerRow);
      table.appendChild(thead);
    }

    // === TABLE BODY ===
    const tbody = ztoolkit.UI.createElement(doc, "tbody", {});
    currentSearchResults.forEach((paper) => {
      const tr = this.createUnifiedResultRow(
        doc,
        paper,
        item,
        searchColumnConfig.columns,
      );
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    tableContainer.appendChild(table);

    // "Show More" button (Initial placement at bottom of table container)
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
        cursor: "pointer",
      },
      listeners: [
        {
          type: "click",
          listener: async () => {
            const loadingDiv = ztoolkit.UI.createElement(doc, "div", {
              properties: { id: "show-more-loading" },
              styles: {
                textAlign: "center",
                padding: "16px",
                color: "var(--text-secondary)",
                fontSize: "12px",
              },
            });
            loadingDiv.innerHTML = "⏳ Loading more papers...";
            showMoreBtn.replaceWith(loadingDiv);
            await this.performSearch(doc);
          },
        },
      ],
    });
    tableContainer.appendChild(showMoreBtn);

    wrapper.appendChild(tableContainer);

    // === SIDE + BUTTON STRIP (Right Side) ===
    const sideStrip = ztoolkit.UI.createElement(doc, "div", {
      styles: {
        width: "30px",
        minWidth: "30px",
        borderLeft: "1px solid var(--border-primary)",
        backgroundColor: "var(--background-secondary)",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: "8px",
        paddingTop: "8px",
      },
    });

    // Helper for side buttons
    const createSideBtn = (
      icon: string,
      title: string,
      onClick: (e: Event) => void,
    ) => {
      const btn = ztoolkit.UI.createElement(doc, "button", {
        properties: { innerText: icon },
        attributes: { title: title },
        styles: {
          width: "24px",
          height: "24px",
          display: "flex",
          justifyContent: "center",
          alignItems: "center",
          border: "1px solid var(--border-primary)",
          borderRadius: "4px",
          backgroundColor: "var(--background-primary)",
          cursor: "pointer",
          fontSize: "14px",
          color: "var(--text-primary)",
          transition: "all 0.2s ease",
        },
        listeners: [
          {
            type: "click",
            listener: onClick,
          },
        ],
      });

      // Hover effects
      btn.addEventListener("mouseenter", () => {
        btn.style.backgroundColor = "var(--highlight-primary)";
        btn.style.color = "var(--highlight-text)";
        btn.style.borderColor = "var(--highlight-primary)";
      });
      btn.addEventListener("mouseleave", () => {
        btn.style.backgroundColor = "var(--background-primary)";
        btn.style.color = "var(--text-primary)";
        btn.style.borderColor = "var(--border-primary)";
      });

      return btn;
    };

    // 1. (+) Add Column (Immediate)
    const addColumnBtn = createSideBtn("➕", "Add Analysis Column", (e) => {
      e.stopPropagation();
      this.addImmediateSearchColumn(doc, resultsContainer, item);
    });
    sideStrip.appendChild(addColumnBtn);

    // 2. (⚡) Generate All
    const generateAllBtn = createSideBtn("⚡", "Generate All Analysis", (e) => {
      e.stopPropagation();
      this.generateAllSearchColumns(doc, wrapper);
    });
    sideStrip.appendChild(generateAllBtn);

    // 3. (⚙️) Settings
    const settingsBtn = createSideBtn(
      "⚙️",
      "Manage Columns & Settings",
      (e) => {
        e.stopPropagation();
        this.showSearchSettingsPopover(
          doc,
          e.currentTarget as HTMLElement,
          resultsContainer,
          item,
        );
      },
    );
    sideStrip.appendChild(settingsBtn);

    wrapper.appendChild(sideStrip);

    return wrapper;
  }

  // ==================== Search Column Feature ====================

  /**
   * Show editor popover for a search column
   */
  private static showColumnEditor(
    doc: Document,
    anchorEl: HTMLElement,
    column: SearchAnalysisColumn,
    resultsContainer: HTMLElement,
    item: Zotero.Item,
  ): void {
    const existing = doc.getElementById("column-editor-popover");
    if (existing) existing.remove();
    const existingBackdrop = doc.getElementById("column-editor-backdrop");
    if (existingBackdrop) existingBackdrop.remove();

    // Backdrop
    const backdrop = ztoolkit.UI.createElement(doc, "div", {
      properties: { id: "column-editor-backdrop" },
      styles: {
        position: "fixed",
        top: "0",
        left: "0",
        right: "0",
        bottom: "0",
        zIndex: "998",
      },
      listeners: [
        {
          type: "click",
          listener: (e: Event) => {
            e.stopPropagation();
            backdrop.remove();
            const p = doc.getElementById("column-editor-popover");
            if (p) p.remove();
          },
        },
      ],
    });
    if (doc.body) {
      doc.body.appendChild(backdrop);
    } else {
      doc.documentElement?.appendChild(backdrop);
    }

    const popover = ztoolkit.UI.createElement(doc, "div", {
      properties: { id: "column-editor-popover" },
      styles: {
        position: "fixed",
        zIndex: "999",
        backgroundColor: "var(--background-primary)",
        border: "1px solid var(--border-primary)",
        borderRadius: "8px",
        padding: "12px",
        boxShadow: "0 4px 12px rgba(0,0,0,0.15)",
        width: "320px",
        display: "flex",
        flexDirection: "column",
        gap: "8px",
      },
      listeners: [
        {
          type: "click",
          listener: (e: Event) => e.stopPropagation(),
        },
      ],
    });

    // Input: Name
    const nameLabel = ztoolkit.UI.createElement(doc, "div", {
      properties: { innerText: "Column Title" },
      styles: {
        fontSize: "11px",
        fontWeight: "600",
        color: "var(--text-secondary)",
      },
    });
    popover.appendChild(nameLabel);

    const nameInput = ztoolkit.UI.createElement(doc, "input", {
      properties: { value: column.name, placeholder: "Column Name" },
      styles: {
        padding: "6px 8px",
        border: "1px solid var(--border-primary)",
        borderRadius: "4px",
        fontSize: "13px",
        width: "100%",
        boxSizing: "border-box",
        backgroundColor: "var(--background-secondary)",
        color: "var(--text-primary)",
      },
    });
    popover.appendChild(nameInput);

    // Textarea: Prompt
    const promptLabel = ztoolkit.UI.createElement(doc, "div", {
      properties: { innerText: "AI Instructions" },
      styles: {
        fontSize: "11px",
        fontWeight: "600",
        color: "var(--text-secondary)",
      },
    });
    popover.appendChild(promptLabel);

    const promptInput = ztoolkit.UI.createElement(doc, "textarea", {
      properties: {
        value: column.aiPrompt,
        placeholder: "E.g., Summarize the methodology...",
      },
      styles: {
        padding: "8px",
        border: "1px solid var(--border-primary)",
        borderRadius: "4px",
        fontSize: "12px",
        width: "100%",
        height: "100px",
        resize: "vertical",
        fontFamily: "inherit",
        boxSizing: "border-box",
        backgroundColor: "var(--background-secondary)",
        color: "var(--text-primary)",
        lineHeight: "1.4",
      },
    });
    popover.appendChild(promptInput);

    // Actions: Save, Remove
    const actions = ztoolkit.UI.createElement(doc, "div", {
      styles: {
        display: "flex",
        justifyContent: "space-between",
        marginTop: "8px",
      },
    });

    const removeBtn = ztoolkit.UI.createElement(doc, "button", {
      properties: { innerText: "🗑️ Remove Column" },
      styles: {
        padding: "6px 10px",
        fontSize: "11px",
        color: "var(--button-clear-text)",
        border: "1px solid var(--button-clear-border)",
        borderRadius: "4px",
        backgroundColor: "var(--button-clear-background)",
        cursor: "pointer",
      },
      listeners: [
        {
          type: "click",
          listener: async () => {
            // Simple confirm
            // Note: ztoolkit doesn't have confirm modal, using native for speed or could build one.
            // Given constraints, I'll execute immediately but maybe safer to ask?
            // User said "adjustable at any time".
            searchColumnConfig.columns = searchColumnConfig.columns.filter(
              (c) => c.id !== column.id,
            );
            for (const pId in searchColumnConfig.generatedData) {
              delete searchColumnConfig.generatedData[pId][column.id];
            }
            await saveSearchColumnConfig();
            backdrop.remove();
            popover.remove();
            this.renderSearchResults(doc, resultsContainer, item);
          },
        },
      ],
    });
    actions.appendChild(removeBtn);

    const saveBtn = ztoolkit.UI.createElement(doc, "button", {
      properties: { innerText: "Save Changes" },
      styles: {
        padding: "6px 12px",
        fontSize: "11px",
        fontWeight: "600",
        color: "var(--highlight-text)",
        backgroundColor: "var(--highlight-primary)",
        border: "1px solid var(--highlight-primary)",
        borderRadius: "4px",
        cursor: "pointer",
      },
      listeners: [
        {
          type: "click",
          listener: async () => {
            column.name = nameInput.value;
            column.aiPrompt = promptInput.value;
            await saveSearchColumnConfig();
            backdrop.remove();
            popover.remove();
            this.renderSearchResults(doc, resultsContainer, item);
          },
        },
      ],
    });
    actions.appendChild(saveBtn);
    popover.appendChild(actions);

    // Positioning
    const rect = anchorEl.getBoundingClientRect();
    // Check if fits below
    const view = doc.defaultView || { innerHeight: 800, innerWidth: 1200 };
    const spaceBelow = view.innerHeight - rect.bottom;
    if (spaceBelow < 250) {
      popover.style.bottom = `${view.innerHeight - rect.top + 5}px`;
    } else {
      popover.style.top = `${rect.bottom + 5}px`;
    }

    // Horizontal clamping
    let leftObj = rect.left;
    if (leftObj + 320 > view.innerWidth) {
      leftObj = view.innerWidth - 330;
    }
    popover.style.left = `${leftObj}px`;

    if (doc.body) {
      doc.body.appendChild(popover);
    } else {
      doc.documentElement?.appendChild(popover);
    }
    nameInput.focus();
  }

  /**
   * Immediately add a new analysis column
   */
  private static async addImmediateSearchColumn(
    doc: Document,
    container: HTMLElement,
    item: Zotero.Item,
  ): Promise<void> {
    const newCol: SearchAnalysisColumn = {
      id: Math.random().toString(36).substring(2, 9),
      name: "New Analysis",
      aiPrompt: "Summarize this paper in one sentence.",
      width: 250,
    };
    searchColumnConfig.columns.push(newCol);
    await saveSearchColumnConfig();
    this.renderSearchResults(doc, container, item);
  }

  /**
   * Trigger batch generation for all empty cells
   */
  /**
   * Trigger batch generation for all empty cells
   */
  private static async generateAllSearchColumns(
    doc: Document,
    container: HTMLElement,
  ): Promise<void> {
    // Find all "Generate" buttons within the container and click them
    const buttons = Array.from(container.querySelectorAll("button")).filter(
      (b) => (b as HTMLElement).innerText?.includes("Generate"),
    ) as HTMLButtonElement[];

    if (buttons.length === 0) {
      return;
    }

    // Click them with a slight stagger to avoid UI freeze (though they are async)
    buttons.forEach((btn, index) => {
      setTimeout(() => {
        if (!btn.disabled) btn.click();
      }, index * 50);
    });
  }

  /**
   * Show search settings popover (Presets, Response Length)
   */
  private static showSearchSettingsPopover(
    doc: Document,
    anchorEl: HTMLElement,
    container: HTMLElement,
    item: Zotero.Item,
  ): void {
    const existing = doc.getElementById("settings-popover");
    if (existing) existing.remove();
    const existingBackdrop = doc.getElementById("settings-backdrop");
    if (existingBackdrop) existingBackdrop.remove();

    const backdrop = ztoolkit.UI.createElement(doc, "div", {
      properties: { id: "settings-backdrop" },
      styles: {
        position: "fixed",
        top: "0",
        left: "0",
        right: "0",
        bottom: "0",
        zIndex: "998",
      },
      listeners: [
        {
          type: "click",
          listener: (e: Event) => {
            e.stopPropagation();
            backdrop.remove();
            const p = doc.getElementById("settings-popover");
            if (p) p.remove();
          },
        },
      ],
    });

    const popover = ztoolkit.UI.createElement(doc, "div", {
      properties: { id: "settings-popover" },
      styles: {
        position: "fixed",
        backgroundColor: "var(--background-primary)",
        width: "320px",
        maxHeight: "400px",
        overflowY: "auto",
        borderRadius: "8px",
        boxShadow: "0 4px 12px rgba(0,0,0,0.15)",
        border: "1px solid var(--border-primary)",
        padding: "16px",
        display: "flex",
        flexDirection: "column",
        gap: "12px",
        zIndex: "999",
      },
      listeners: [
        { type: "click", listener: (e: Event) => e.stopPropagation() },
      ],
    });

    // Header
    const header = ztoolkit.UI.createElement(doc, "div", {
      properties: { innerText: "Search Settings" },
      styles: {
        fontSize: "14px",
        fontWeight: "600",
        borderBottom: "1px solid var(--border-primary)",
        paddingBottom: "8px",
      },
    });
    popover.appendChild(header);

    // === AI Model Selection ===
    const modelSection = ztoolkit.UI.createElement(doc, "div", {
      styles: { display: "flex", flexDirection: "column", gap: "4px" },
    });
    const modelLabel = ztoolkit.UI.createElement(doc, "div", {
      properties: { innerText: "AI Model" },
      styles: { fontSize: "12px", fontWeight: "600" },
    });
    modelSection.appendChild(modelLabel);

    const modelSelect = ztoolkit.UI.createElement(doc, "select", {
      styles: {
        width: "100%",
        padding: "6px 8px",
        borderRadius: "4px",
        fontSize: "12px",
        border: "1px solid var(--border-primary)",
        backgroundColor: "var(--background-secondary)",
        color: "var(--text-primary)",
        cursor: "pointer",
      },
    }) as HTMLSelectElement;

    const configs = getModelConfigs();
    const activeConfig = getActiveModelConfig();

    if (configs.length === 0) {
      const opt = doc.createElement("option");
      opt.value = "default";
      opt.innerText = "Default (configure in Settings)";
      modelSelect.appendChild(opt);
    } else {
      configs.forEach((cfg) => {
        const opt = doc.createElement("option");
        opt.value = cfg.id;
        opt.innerText = cfg.name;
        if (activeConfig && cfg.id === activeConfig.id) opt.selected = true;
        modelSelect.appendChild(opt);
      });
    }

    modelSelect.addEventListener("change", () => {
      setActiveModelId(modelSelect.value);
      Zotero.debug(`[seerai] Search: Model changed to ${modelSelect.value}`);
    });
    modelSection.appendChild(modelSelect);
    popover.appendChild(modelSection);

    // === Response Length ===
    const lengthSection = ztoolkit.UI.createElement(doc, "div", {
      styles: { display: "flex", flexDirection: "column", gap: "8px" },
    });
    const currentLen = searchColumnConfig.responseLength || 100;
    const lenText = currentLen > 4200 ? "Limitless" : `${currentLen} words`;
    const lenLabel = ztoolkit.UI.createElement(doc, "div", {
      properties: { innerText: `Max Response Length: ${lenText}` },
      styles: { fontSize: "12px", fontWeight: "600" },
    });
    lengthSection.appendChild(lenLabel);

    const sliderContainer = ztoolkit.UI.createElement(doc, "div", {
      styles: { display: "flex", alignItems: "center", gap: "10px" },
    });
    const slider = ztoolkit.UI.createElement(doc, "input", {
      attributes: {
        type: "range",
        min: "20",
        max: "4300",
        step: "10",
        value: String(currentLen),
      },
      styles: { flex: "1" },
    });
    sliderContainer.appendChild(slider);
    lengthSection.appendChild(sliderContainer);

    slider.addEventListener("input", async () => {
      const val = parseInt((slider as HTMLInputElement).value);
      if (val > 4200) {
        lenLabel.innerText = `Max Response Length: Limitless`;
      } else {
        lenLabel.innerText = `Max Response Length: ${val} words`;
      }
      searchColumnConfig.responseLength = val;
      // Debounce save? Or simple save.
      await saveSearchColumnConfig();
    });
    popover.appendChild(lengthSection);

    // === Presets ===
    const presetsSection = ztoolkit.UI.createElement(doc, "div", {
      styles: {
        display: "flex",
        flexDirection: "column",
        gap: "8px",
        marginTop: "10px",
      },
    });
    const presetsHeader = ztoolkit.UI.createElement(doc, "div", {
      styles: {
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
      },
    });
    presetsHeader.appendChild(
      ztoolkit.UI.createElement(doc, "span", {
        properties: { innerText: "Column Presets" },
        styles: { fontSize: "12px", fontWeight: "600" },
      }),
    );

    // Save Current Preset UI (Inline)
    const saveRow = ztoolkit.UI.createElement(doc, "div", {
      styles: { display: "flex", gap: "6px", alignItems: "center" },
    });

    const saveInput = ztoolkit.UI.createElement(doc, "input", {
      properties: { placeholder: "New Preset Name" },
      styles: {
        flex: "1",
        padding: "4px 6px",
        fontSize: "11px",
        border: "1px solid var(--border-primary)",
        borderRadius: "4px",
        backgroundColor: "var(--background-secondary)",
        color: "var(--text-primary)",
      },
    });
    saveRow.appendChild(saveInput);

    const savePresetBtn = ztoolkit.UI.createElement(doc, "button", {
      properties: { innerText: "💾 Save" },
      styles: {
        padding: "4px 8px",
        fontSize: "11px",
        borderRadius: "4px",
        border: "1px solid var(--highlight-primary)",
        color: "var(--highlight-text)",
        backgroundColor: "var(--highlight-primary)",
        cursor: "pointer",
      },
    });
    saveRow.appendChild(savePresetBtn);
    presetsHeader.appendChild(saveRow);
    presetsSection.appendChild(presetsHeader);

    const presetsList = ztoolkit.UI.createElement(doc, "div", {
      styles: {
        maxHeight: "150px",
        overflowY: "auto",
        border: "1px solid var(--border-primary)",
        borderRadius: "6px",
        padding: "4px",
      },
    });

    // Load presets logic
    const loadPresets = () => {
      presetsList.innerHTML = "";
      let savedPresets: any = {};
      try {
        const raw = Zotero.Prefs.get("extensions.seer-ai.search.presets");
        if (raw) savedPresets = JSON.parse(raw as string);
      } catch (e) {
        Zotero.debug(`Error loading presets: ${e}`);
      }

      if (Object.keys(savedPresets).length === 0) {
        const empty = ztoolkit.UI.createElement(doc, "div", {
          properties: { innerText: "No saved presets" },
          styles: {
            padding: "10px",
            fontSize: "11px",
            color: "var(--text-secondary)",
            textAlign: "center",
          },
        });
        presetsList.appendChild(empty);
      } else {
        Object.keys(savedPresets).forEach((key) => {
          const itemRow = ztoolkit.UI.createElement(doc, "div", {
            styles: {
              display: "flex",
              justifyContent: "space-between",
              padding: "6px 8px",
              alignItems: "center",
              borderBottom: "1px solid var(--border-secondary)",
            },
          });

          const nameSpan = ztoolkit.UI.createElement(doc, "span", {
            properties: { innerText: key },
            styles: { fontSize: "12px", fontWeight: "500" },
          });
          itemRow.appendChild(nameSpan);

          const btns = ztoolkit.UI.createElement(doc, "div", {
            styles: { display: "flex", gap: "4px" },
          });

          // Load
          const loadBtn = ztoolkit.UI.createElement(doc, "button", {
            properties: { innerText: "Load" },
            styles: {
              fontSize: "10px",
              padding: "2px 6px",
              cursor: "pointer",
              backgroundColor: "var(--highlight-primary)",
              color: "white",
              border: "none",
              borderRadius: "3px",
            },
            listeners: [
              {
                type: "click",
                listener: async () => {
                  if (
                    doc.defaultView &&
                    doc.defaultView.confirm(
                      `Load preset "${key}"? Current columns will be replaced.`,
                    )
                  ) {
                    searchColumnConfig.columns = savedPresets[key];
                    await saveSearchColumnConfig();
                    backdrop.remove();
                    popover.remove();
                    this.renderSearchResults(doc, container, item);
                  }
                },
              },
            ],
          });
          btns.appendChild(loadBtn);

          // Delete
          const delBtn = ztoolkit.UI.createElement(doc, "button", {
            properties: { innerText: "✕" },
            styles: {
              fontSize: "10px",
              padding: "2px 6px",
              cursor: "pointer",
              backgroundColor: "transparent",
              color: "var(--text-secondary)",
              border: "1px solid var(--border-secondary)",
              borderRadius: "3px",
            },
            listeners: [
              {
                type: "click",
                listener: () => {
                  if (
                    doc.defaultView &&
                    doc.defaultView.confirm(`Delete preset "${key}"?`)
                  ) {
                    delete savedPresets[key];
                    Zotero.Prefs.set(
                      "extensions.seer-ai.search.presets",
                      JSON.stringify(savedPresets),
                    );
                    loadPresets();
                  }
                },
              },
            ],
          });
          btns.appendChild(delBtn);

          itemRow.appendChild(btns);
          presetsList.appendChild(itemRow);
        });
      }
    };

    savePresetBtn.addEventListener("click", () => {
      const name = (saveInput as HTMLInputElement).value;
      if (name && name.trim()) {
        let savedPresets: any = {};
        try {
          const raw = Zotero.Prefs.get("extensions.seer-ai.search.presets");
          if (raw) savedPresets = JSON.parse(raw as string);
        } catch (e) { }

        savedPresets[name.trim()] = searchColumnConfig.columns;
        Zotero.Prefs.set(
          "extensions.seer-ai.search.presets",
          JSON.stringify(savedPresets),
        );
        (saveInput as HTMLInputElement).value = ""; // Clear input
        loadPresets();
      } else {
        (saveInput as HTMLInputElement).style.borderColor = "red";
        setTimeout(() => {
          (saveInput as HTMLInputElement).style.borderColor =
            "var(--border-primary)";
        }, 2000);
      }
    });

    loadPresets();
    presetsSection.appendChild(presetsList);
    popover.appendChild(presetsSection);

    // Footer / Close (Optional for popover, but nice to have)
    /*
            const footer = ztoolkit.UI.createElement(doc, 'div', { styles: { display: "flex", justifyContent: "flex-end", marginTop: "10px" } });
            const closeBtn = ztoolkit.UI.createElement(doc, 'button', {
                properties: { innerText: "Close" },
                styles: { padding: "4px 10px", cursor: "pointer", backgroundColor: "var(--background-secondary)", border: "1px solid var(--border-primary)", borderRadius: "4px", fontSize: "11px" },
                listeners: [{ type: "click", listener: () => { backdrop.remove(); popover.remove(); } }]
            });
            footer.appendChild(closeBtn);
            popover.appendChild(footer);
            */

    // Positioning
    const rect = anchorEl.getBoundingClientRect();
    const view = doc.defaultView || { innerHeight: 800, innerWidth: 1200 };

    // Default: to the left of button
    let top = rect.top;
    let left = rect.left - 330; // Width + margin

    if (left < 10) {
      // Not enough space left? Right side? (Unlikely for side strip on right edge)
      // Or below?
      left = rect.right - 320;
      top = rect.bottom + 5;
    }

    // Vertical Clamping
    const h = 400; // max height
    if (top + h > view.innerHeight) {
      top = view.innerHeight - h - 10;
    }
    if (top < 10) top = 10;

    popover.style.top = `${top}px`;
    popover.style.left = `${left}px`;

    if (doc.body) {
      doc.body.appendChild(backdrop);
      doc.body.appendChild(popover);
    } else {
      doc.documentElement?.appendChild(backdrop);
      doc.documentElement?.appendChild(popover);
    }
  }

  /**
   * Show table settings popover (Response Length, Presets, Columns)
   * Matches the search settings popover pattern
   */
  private static showTableSettingsPopover(
    doc: Document,
    anchorEl: HTMLElement,
    container: HTMLElement,
    item: Zotero.Item,
  ): void {
    const existing = doc.getElementById("table-settings-popover");
    if (existing) existing.remove();
    const existingBackdrop = doc.getElementById("table-settings-backdrop");
    if (existingBackdrop) existingBackdrop.remove();

    const backdrop = ztoolkit.UI.createElement(doc, "div", {
      properties: { id: "table-settings-backdrop" },
      styles: {
        position: "fixed",
        top: "0",
        left: "0",
        right: "0",
        bottom: "0",
        zIndex: "998",
      },
      listeners: [
        {
          type: "click",
          listener: (e: Event) => {
            e.stopPropagation();
            backdrop.remove();
            const p = doc.getElementById("table-settings-popover");
            if (p) p.remove();
          },
        },
      ],
    });

    const popover = ztoolkit.UI.createElement(doc, "div", {
      properties: { id: "table-settings-popover" },
      styles: {
        position: "fixed",
        backgroundColor: "var(--background-primary)",
        width: "320px",
        maxHeight: "450px",
        overflowY: "auto",
        borderRadius: "8px",
        boxShadow: "0 4px 12px rgba(0,0,0,0.15)",
        border: "1px solid var(--border-primary)",
        padding: "16px",
        display: "flex",
        flexDirection: "column",
        gap: "12px",
        zIndex: "999",
      },
      listeners: [
        { type: "click", listener: (e: Event) => e.stopPropagation() },
      ],
    });

    // Header
    const header = ztoolkit.UI.createElement(doc, "div", {
      properties: { innerText: "Table Settings" },
      styles: {
        fontSize: "14px",
        fontWeight: "600",
        borderBottom: "1px solid var(--border-primary)",
        paddingBottom: "8px",
      },
    });
    popover.appendChild(header);

    // === AI Model Selection ===
    const modelSection = ztoolkit.UI.createElement(doc, "div", {
      styles: { display: "flex", flexDirection: "column", gap: "4px" },
    });
    const modelLabel = ztoolkit.UI.createElement(doc, "div", {
      properties: { innerText: "AI Model" },
      styles: { fontSize: "12px", fontWeight: "600" },
    });
    modelSection.appendChild(modelLabel);

    const modelSelect = ztoolkit.UI.createElement(doc, "select", {
      styles: {
        width: "100%",
        padding: "6px 8px",
        borderRadius: "4px",
        fontSize: "12px",
        border: "1px solid var(--border-primary)",
        backgroundColor: "var(--background-secondary)",
        color: "var(--text-primary)",
        cursor: "pointer",
      },
    }) as HTMLSelectElement;

    const configs = getModelConfigs();
    const activeConfig = getActiveModelConfig();

    if (configs.length === 0) {
      const opt = doc.createElement("option");
      opt.value = "default";
      opt.innerText = "Default (configure in Settings)";
      modelSelect.appendChild(opt);
    } else {
      configs.forEach((cfg) => {
        const opt = doc.createElement("option");
        opt.value = cfg.id;
        opt.innerText = cfg.name;
        if (activeConfig && cfg.id === activeConfig.id) opt.selected = true;
        modelSelect.appendChild(opt);
      });
    }

    modelSelect.addEventListener("change", () => {
      setActiveModelId(modelSelect.value);
      Zotero.debug(`[seerai] Table: Model changed to ${modelSelect.value}`);
    });
    modelSection.appendChild(modelSelect);
    popover.appendChild(modelSection);

    // === Response Length ===
    const lengthSection = ztoolkit.UI.createElement(doc, "div", {
      styles: { display: "flex", flexDirection: "column", gap: "8px" },
    });
    const currentLen = currentTableConfig?.responseLength || 100;
    const lenText =
      currentLen >= 4192 || currentLen === 0
        ? "Limitless"
        : `${currentLen} words`;
    const lenLabel = ztoolkit.UI.createElement(doc, "div", {
      properties: { innerText: `Max Response Length: ${lenText}` },
      styles: { fontSize: "12px", fontWeight: "600" },
    });
    lengthSection.appendChild(lenLabel);

    const sliderContainer = ztoolkit.UI.createElement(doc, "div", {
      styles: { display: "flex", alignItems: "center", gap: "10px" },
    });
    const sliderValue = currentLen === 0 ? 4200 : currentLen; // 0 means unlimited
    const slider = ztoolkit.UI.createElement(doc, "input", {
      attributes: {
        type: "range",
        min: "20",
        max: "4300",
        step: "10",
        value: String(sliderValue),
      },
      styles: { flex: "1" },
    }) as HTMLInputElement;
    sliderContainer.appendChild(slider);
    lengthSection.appendChild(sliderContainer);

    slider.addEventListener("input", async () => {
      const val = parseInt(slider.value);
      if (val > 4200) {
        lenLabel.innerText = `Max Response Length: Limitless`;
      } else {
        lenLabel.innerText = `Max Response Length: ${val} words`;
      }
      if (currentTableConfig) {
        currentTableConfig.responseLength = val > 4200 ? 0 : val;
        const tableStore = getTableStore();
        await tableStore.saveConfig(currentTableConfig);
      }
    });
    popover.appendChild(lengthSection);

    // === Column Presets ===
    const presetsSection = ztoolkit.UI.createElement(doc, "div", {
      styles: {
        display: "flex",
        flexDirection: "column",
        gap: "8px",
        marginTop: "10px",
      },
    });
    const presetsHeader = ztoolkit.UI.createElement(doc, "div", {
      styles: {
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
      },
    });
    presetsHeader.appendChild(
      ztoolkit.UI.createElement(doc, "span", {
        properties: { innerText: "Column Presets" },
        styles: { fontSize: "12px", fontWeight: "600" },
      }),
    );

    // Save row
    const saveRow = ztoolkit.UI.createElement(doc, "div", {
      styles: { display: "flex", gap: "6px", alignItems: "center" },
    });

    const saveInput = ztoolkit.UI.createElement(doc, "input", {
      properties: { placeholder: "New Preset Name" },
      styles: {
        flex: "1",
        padding: "4px 6px",
        fontSize: "11px",
        border: "1px solid var(--border-primary)",
        borderRadius: "4px",
        backgroundColor: "var(--background-secondary)",
        color: "var(--text-primary)",
      },
    }) as HTMLInputElement;
    saveRow.appendChild(saveInput);

    const savePresetBtn = ztoolkit.UI.createElement(doc, "button", {
      properties: { innerText: "💾 Save" },
      styles: {
        padding: "4px 8px",
        fontSize: "11px",
        borderRadius: "4px",
        border: "1px solid var(--highlight-primary)",
        color: "var(--highlight-text)",
        backgroundColor: "var(--highlight-primary)",
        cursor: "pointer",
      },
    });
    saveRow.appendChild(savePresetBtn);
    presetsHeader.appendChild(saveRow);
    presetsSection.appendChild(presetsHeader);

    const presetsList = ztoolkit.UI.createElement(doc, "div", {
      styles: {
        maxHeight: "100px",
        overflowY: "auto",
        border: "1px solid var(--border-primary)",
        borderRadius: "6px",
        padding: "4px",
      },
    });

    // Load presets logic using tableStore
    const loadPresets = async () => {
      presetsList.innerHTML = "";
      const tableStore = getTableStore();
      const presets = await tableStore.loadPresets();

      if (presets.length === 0) {
        const empty = ztoolkit.UI.createElement(doc, "div", {
          properties: { innerText: "No saved presets" },
          styles: {
            padding: "10px",
            fontSize: "11px",
            color: "var(--text-secondary)",
            textAlign: "center",
          },
        });
        presetsList.appendChild(empty);
      } else {
        presets.forEach((preset) => {
          const itemRow = ztoolkit.UI.createElement(doc, "div", {
            styles: {
              display: "flex",
              justifyContent: "space-between",
              padding: "6px 8px",
              alignItems: "center",
              borderBottom: "1px solid var(--border-secondary)",
            },
          });

          const nameSpan = ztoolkit.UI.createElement(doc, "span", {
            properties: { innerText: preset.name },
            styles: { fontSize: "12px", fontWeight: "500" },
          });
          itemRow.appendChild(nameSpan);

          const btns = ztoolkit.UI.createElement(doc, "div", {
            styles: { display: "flex", gap: "4px" },
          });

          // Load
          const loadBtn = ztoolkit.UI.createElement(doc, "button", {
            properties: { innerText: "Load" },
            styles: {
              fontSize: "10px",
              padding: "2px 6px",
              cursor: "pointer",
              backgroundColor: "var(--highlight-primary)",
              color: "white",
              border: "none",
              borderRadius: "3px",
            },
            listeners: [
              {
                type: "click",
                listener: async () => {
                  if (
                    doc.defaultView &&
                    doc.defaultView.confirm(
                      `Load preset "${preset.name}"? Current columns will be replaced.`,
                    )
                  ) {
                    if (currentTableConfig) {
                      currentTableConfig.columns = [...preset.columns];
                      await tableStore.saveConfig(currentTableConfig);
                      backdrop.remove();
                      popover.remove();
                      if (currentContainer && currentItem) {
                        this.renderInterface(currentContainer, currentItem);
                      }
                    }
                  }
                },
              },
            ],
          });
          btns.appendChild(loadBtn);

          // Delete
          const delBtn = ztoolkit.UI.createElement(doc, "button", {
            properties: { innerText: "✕" },
            styles: {
              fontSize: "10px",
              padding: "2px 6px",
              cursor: "pointer",
              backgroundColor: "transparent",
              color: "var(--text-secondary)",
              border: "1px solid var(--border-secondary)",
              borderRadius: "3px",
            },
            listeners: [
              {
                type: "click",
                listener: async () => {
                  if (
                    doc.defaultView &&
                    doc.defaultView.confirm(`Delete preset "${preset.name}"?`)
                  ) {
                    await tableStore.deletePreset(preset.id);
                    loadPresets();
                  }
                },
              },
            ],
          });
          btns.appendChild(delBtn);

          itemRow.appendChild(btns);
          presetsList.appendChild(itemRow);
        });
      }
    };

    savePresetBtn.addEventListener("click", async () => {
      const name = saveInput.value.trim();
      if (name && currentTableConfig) {
        const newPreset: ColumnPreset = {
          id: `preset_${Date.now()}`,
          name: name,
          columns: [...currentTableConfig.columns],
          createdAt: new Date().toISOString(),
        };
        const tableStore = getTableStore();
        await tableStore.savePreset(newPreset);
        saveInput.value = "";
        loadPresets();
      } else {
        saveInput.style.borderColor = "red";
        setTimeout(() => {
          saveInput.style.borderColor = "var(--border-primary)";
        }, 2000);
      }
    });

    loadPresets();
    presetsSection.appendChild(presetsList);
    popover.appendChild(presetsSection);

    // === Columns List ===
    const columnsSection = ztoolkit.UI.createElement(doc, "div", {
      styles: {
        display: "flex",
        flexDirection: "column",
        gap: "8px",
        marginTop: "10px",
      },
    });
    columnsSection.appendChild(
      ztoolkit.UI.createElement(doc, "div", {
        properties: { innerText: "Column Visibility" },
        styles: { fontSize: "12px", fontWeight: "600" },
      }),
    );

    const columnsList = ztoolkit.UI.createElement(doc, "div", {
      styles: {
        maxHeight: "120px",
        overflowY: "auto",
        border: "1px solid var(--border-primary)",
        borderRadius: "6px",
        padding: "4px",
        backgroundColor: "var(--background-secondary)",
      },
    });

    const columns = currentTableConfig?.columns || defaultColumns;
    const coreColumnIds = ["title", "author", "year", "sources"];
    columns.forEach((col) => {
      const row = ztoolkit.UI.createElement(doc, "div", {
        styles: {
          display: "flex",
          alignItems: "center",
          gap: "8px",
          padding: "6px 8px",
          borderBottom: "1px solid var(--border-primary)",
        },
      });

      const checkbox = ztoolkit.UI.createElement(doc, "input", {
        attributes: { type: "checkbox" },
      }) as HTMLInputElement;
      checkbox.checked = col.visible;
      checkbox.style.cursor = "pointer";
      checkbox.addEventListener("change", async () => {
        col.visible = checkbox.checked;
        if (currentTableConfig) {
          const tableStore = getTableStore();
          await tableStore.saveConfig(currentTableConfig);
        }
      });

      const label = ztoolkit.UI.createElement(doc, "span", {
        properties: { innerText: col.name },
        styles: { flex: "1", fontSize: "12px" },
      });

      row.appendChild(checkbox);
      row.appendChild(label);

      // Delete button for non-core columns
      if (!coreColumnIds.includes(col.id)) {
        const deleteBtn = ztoolkit.UI.createElement(doc, "button", {
          properties: { innerText: "🗑" },
          attributes: { title: "Delete column" },
          styles: {
            background: "none",
            border: "none",
            fontSize: "12px",
            cursor: "pointer",
            color: "#c62828",
            padding: "2px 4px",
          },
          listeners: [
            {
              type: "click",
              listener: async (e: Event) => {
                e.preventDefault();
                e.stopPropagation();
                if (
                  currentTableConfig &&
                  doc.defaultView?.confirm(`Delete column "${col.name}"?`)
                ) {
                  currentTableConfig.columns =
                    currentTableConfig.columns.filter((c) => c.id !== col.id);
                  const tableStore = getTableStore();
                  await tableStore.saveConfig(currentTableConfig);
                  row.remove();
                  // Refresh the interface
                  if (currentContainer && currentItem) {
                    backdrop.remove();
                    popover.remove();
                    this.renderInterface(currentContainer, currentItem);
                  }
                }
              },
            },
          ],
        });
        row.appendChild(deleteBtn);
      }

      columnsList.appendChild(row);
    });

    columnsSection.appendChild(columnsList);
    popover.appendChild(columnsSection);

    // Positioning (left of anchor button)
    const rect = anchorEl.getBoundingClientRect();
    const view = doc.defaultView || { innerHeight: 800, innerWidth: 1200 };

    let top = rect.top;
    let left = rect.left - 330;

    if (left < 10) {
      left = rect.right - 320;
      top = rect.bottom + 5;
    }

    const h = 450;
    if (top + h > view.innerHeight) {
      top = view.innerHeight - h - 10;
    }
    if (top < 10) top = 10;

    popover.style.top = `${top}px`;
    popover.style.left = `${left}px`;

    if (doc.body) {
      doc.body.appendChild(backdrop);
      doc.body.appendChild(popover);
    } else {
      doc.documentElement?.appendChild(backdrop);
      doc.documentElement?.appendChild(popover);
    }
  }

  /**
  
       * Show dropdown to add a new analysis column for search results
       * (Deprecated, replaced by immediate add + settings)
       */
  private static showSearchColumnDropdown(
    doc: Document,
    anchorEl: HTMLElement,
    resultsContainer: HTMLElement,
    item: Zotero.Item,
  ): void {
    // Deprecated
  }

  /**
   * Create horizontal bar showing active search columns as tags
   */
  private static createSearchColumnTagsBar(
    doc: Document,
    resultsContainer: HTMLElement,
    item: Zotero.Item,
  ): HTMLElement {
    const tagsBar = ztoolkit.UI.createElement(doc, "div", {
      styles: {
        display: "flex",
        flexWrap: "wrap",
        gap: "6px",
        padding: "8px 12px",
        backgroundColor: "var(--background-tertiary)",
        borderBottom: "1px solid var(--border-primary)",
        alignItems: "center",
      },
    });

    const label = ztoolkit.UI.createElement(doc, "span", {
      properties: { innerText: "📊 Columns:" },
      styles: {
        fontSize: "11px",
        color: "var(--text-secondary)",
        marginRight: "4px",
      },
    });
    tagsBar.appendChild(label);

    searchColumnConfig.columns.forEach((col) => {
      const tag = ztoolkit.UI.createElement(doc, "span", {
        styles: {
          display: "inline-flex",
          alignItems: "center",
          gap: "4px",
          padding: "3px 8px",
          backgroundColor: "var(--highlight-primary)",
          color: "var(--highlight-text)",
          borderRadius: "12px",
          fontSize: "11px",
          fontWeight: "500",
        },
      });

      const nameSpan = ztoolkit.UI.createElement(doc, "span", {
        properties: { innerText: col.name },
      });
      tag.appendChild(nameSpan);

      // Remove button
      const removeBtn = ztoolkit.UI.createElement(doc, "span", {
        properties: { innerText: "✕" },
        styles: {
          cursor: "pointer",
          marginLeft: "2px",
          opacity: "0.8",
          fontSize: "10px",
        },
        listeners: [
          {
            type: "click",
            listener: async (e: Event) => {
              e.stopPropagation();
              // Remove column
              searchColumnConfig.columns = searchColumnConfig.columns.filter(
                (c) => c.id !== col.id,
              );
              // Remove generated data for this column
              for (const paperId in searchColumnConfig.generatedData) {
                delete searchColumnConfig.generatedData[paperId][col.id];
              }
              await saveSearchColumnConfig();
              // Re-render
              this.renderSearchResults(doc, resultsContainer, item);
            },
          },
        ],
      });
      tag.appendChild(removeBtn);

      tagsBar.appendChild(tag);
    });

    return tagsBar;
  }

  /**
   * Create column values section for a search result card
   */
  private static createSearchCardColumns(
    doc: Document,
    paper: SemanticScholarPaper,
    resultsContainer: HTMLElement,
    item: Zotero.Item,
  ): HTMLElement {
    const columnsSection = ztoolkit.UI.createElement(doc, "div", {
      styles: {
        marginTop: "8px",
        padding: "8px",
        backgroundColor: "var(--background-secondary)",
        borderRadius: "6px",
        border: "1px solid var(--border-primary)",
      },
    });

    searchColumnConfig.columns.forEach((col) => {
      const cachedValue =
        searchColumnConfig.generatedData[paper.paperId]?.[col.id];

      const row = ztoolkit.UI.createElement(doc, "div", {
        styles: {
          display: "flex",
          marginBottom: "6px",
          alignItems: "flex-start",
        },
      });

      // Column name
      const nameEl = ztoolkit.UI.createElement(doc, "span", {
        properties: { innerText: `${col.name}:` },
        styles: {
          fontSize: "11px",
          fontWeight: "600",
          color: "var(--text-primary)",
          minWidth: "100px",
          marginRight: "8px",
        },
      });
      row.appendChild(nameEl);

      // Value or generate button
      const valueEl = ztoolkit.UI.createElement(doc, "div", {
        styles: {
          flex: "1",
          fontSize: "11px",
          color: "var(--text-secondary)",
          lineHeight: "1.4",
        },
      });

      if (cachedValue) {
        valueEl.textContent = cachedValue;
      } else {
        // Generate button
        const generateBtn = ztoolkit.UI.createElement(doc, "button", {
          properties: { innerText: "🔄 Generate" },
          styles: {
            padding: "3px 8px",
            fontSize: "10px",
            border: "1px solid var(--border-primary)",
            borderRadius: "4px",
            backgroundColor: "var(--background-primary)",
            color: "var(--text-primary)",
            cursor: "pointer",
          },
          listeners: [
            {
              type: "click",
              listener: async (e: Event) => {
                e.stopPropagation();
                const btn = e.target as HTMLButtonElement;
                btn.textContent = "⏳ Analyzing...";
                btn.disabled = true;

                try {
                  const result = await this.analyzeSearchPaperColumn(
                    paper,
                    col,
                  );
                  // Update display
                  valueEl.textContent = result;
                } catch (err) {
                  valueEl.textContent = `❌ Error: ${err}`;
                }
              },
            },
          ],
        });
        valueEl.appendChild(generateBtn);
      }

      row.appendChild(valueEl);
      columnsSection.appendChild(row);
    });

    return columnsSection;
  }

  /**
   * Analyze a search paper for a specific column using AI
   * Uses PDF if available, otherwise falls back to abstract/TLDR/metadata
   */
  private static async analyzeSearchPaperColumn(
    paper: SemanticScholarPaper,
    column: SearchAnalysisColumn,
  ): Promise<string> {
    let sourceText = "";

    // Priority 1: Use abstract + TLDR (most common for search results)
    if (paper.abstract) {
      sourceText = `Abstract: ${paper.abstract}`;
    }
    if (paper.tldr?.text) {
      sourceText += `\n\nTLDR: ${paper.tldr.text}`;
    }

    // Priority 2: Fall back to metadata if no abstract
    if (!sourceText.trim()) {
      const authors = paper.authors?.map((a) => a.name).join(", ") || "Unknown";
      sourceText = `Title: ${paper.title}\nAuthors: ${authors}\nYear: ${paper.year || "Unknown"}\nVenue: ${paper.venue || "Unknown"}\nCitations: ${paper.citationCount}`;
    }

    // Generate using AI
    const result = await this.generateSearchColumnContent(
      paper,
      column,
      sourceText,
    );

    // Cache result
    if (!searchColumnConfig.generatedData[paper.paperId]) {
      searchColumnConfig.generatedData[paper.paperId] = {};
    }
    searchColumnConfig.generatedData[paper.paperId][column.id] = result;
    await saveSearchColumnConfig();

    return result;
  }

  /**
   * Generate column content for a search result using AI
   */
  private static async generateSearchColumnContent(
    paper: SemanticScholarPaper,
    column: SearchAnalysisColumn,
    sourceText: string,
  ): Promise<string> {
    const systemPrompt = `You are extracting structured information from academic papers. Be concise and factual. Return ONLY the requested information, no explanations.`;

    const limit = searchColumnConfig.responseLength || 100;
    const lengthConstraint =
      limit > 4200 ? "" : `Keep response under ${limit} words.`;

    const userPrompt = `Paper: "${paper.title}"

Source content:
${sourceText}

Task: For the column "${column.name}": ${column.aiPrompt}
${lengthConstraint}`;

    const activeModel = getActiveModelConfig();
    if (!activeModel) {
      throw new Error(
        "No AI model configured. Please set up a model in settings.",
      );
    }

    let fullResponse = "";
    await openAIService.chatCompletionStream(
      [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      {
        onToken: (token) => {
          fullResponse += token;
        },
        onComplete: () => { },
        onError: (err) => {
          throw err;
        },
      },
      {
        apiURL: activeModel.apiURL,
        apiKey: activeModel.apiKey,
        model: activeModel.model,
      },
    );

    return fullResponse.trim();
  }

  /**
   * Export table data to CSV
   */
  private static async exportTableToCSV(): Promise<void> {
    try {
      const tableData = await this.loadTableData();
      if (tableData.rows.length === 0) {
        Zotero.debug("[seerai] No data to export");
        return;
      }

      const columns =
        currentTableConfig?.columns.filter((c) => c.visible) ||
        defaultColumns.filter((c) => c.visible);

      // Build CSV header
      const header = columns.map((c) => `"${c.name}"`).join(",");

      // Build CSV rows
      const rows = tableData.rows.map((row) => {
        return columns
          .map((col) => {
            const value = row.data[col.id] || "";
            // Escape quotes and wrap in quotes
            return `"${value.replace(/"/g, '""')}"`;
          })
          .join(",");
      });

      const csvContent = [header, ...rows].join("\n");

      // Create file path
      const filename = `papers_table_${new Date().toISOString().replace(/[:.]/g, "-")}.csv`;
      const downloadsDir = PathUtils.join(
        Zotero.DataDirectory.dir,
        "seerai",
        "exports",
      );

      // Ensure directory exists
      if (!(await IOUtils.exists(downloadsDir))) {
        await IOUtils.makeDirectory(downloadsDir, { ignoreExisting: true });
      }

      const filepath = PathUtils.join(downloadsDir, filename);
      const encoder = new TextEncoder();
      await IOUtils.write(filepath, encoder.encode(csvContent));

      Zotero.debug(`[seerai] Table exported to: ${filepath}`);

      // Show success notification
      const progressWindow = new Zotero.ProgressWindow({ closeOnClick: true });
      progressWindow.changeHeadline("Export Complete");
      progressWindow.addDescription(`Table exported to:\n${filepath}`);
      progressWindow.show();
      progressWindow.startCloseTimer(3000);
    } catch (e) {
      Zotero.debug(`[seerai] Error exporting table: ${e}`);
    }
  }

  /**
   * Find existing "Tables" note for a given paper item
   * Returns the note item if found, null otherwise
   */
  private static findExistingTablesNote(
    parentItemId: number,
  ): Zotero.Item | null {
    try {
      const parentItem = Zotero.Items.get(parentItemId);
      if (!parentItem || !parentItem.isRegularItem()) return null;

      const noteIDs = parentItem.getNotes();
      for (const noteID of noteIDs) {
        const note = Zotero.Items.get(noteID);
        if (note) {
          const noteContent = note.getNote();
          // Check if note has the Tables marker
          if (noteContent.includes("<h2>📊 Tables")) {
            return note as Zotero.Item;
          }
        }
      }
      return null;
    } catch (e) {
      Zotero.debug(`[seerai] Error finding Tables note: ${e}`);
      return null;
    }
  }

  /**
   * Parse existing table data from a Tables note
   * Returns a map of columnId -> value
   */
  private static parseTablesNoteContent(
    noteContent: string,
  ): Record<string, string> {
    const data: Record<string, string> = {};
    try {
      // Extract table rows using regex
      // Format: <tr><td>ColumnName</td><td>Value</td></tr>
      const rowRegex =
        /<tr>\s*<td[^>]*>([^<]+)<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<\/tr>/gi;
      let match;
      while ((match = rowRegex.exec(noteContent)) !== null) {
        const columnName = match[1].trim();
        const value = match[2].trim();
        // Use column name as key (we'll match by name)
        data[columnName] = value;
      }
    } catch (e) {
      Zotero.debug(`[seerai] Error parsing Tables note: ${e}`);
    }
    return data;
  }

  /**
   * Generate HTML table content for a row
   */
  private static generateTablesNoteHtml(
    paperTitle: string,
    row: TableRow,
    columns: TableColumn[],
  ): string {
    const timestamp = new Date().toLocaleString();

    let tableRows = "";
    for (const col of columns) {
      if (!col.visible) continue;
      // Skip non-data columns like title (already in header)
      if (col.id === "title") continue;

      const value = row.data[col.id] || "";
      const escapedValue = value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/\n/g, "<br/>");

      tableRows += `    <tr><td style="padding: 8px; border: 1px solid #ddd; font-weight: 600;">${col.name}</td><td style="padding: 8px; border: 1px solid #ddd;">${escapedValue}</td></tr>\n`;
    }

    return `<h2>📊 Tables - ${paperTitle.replace(/</g, "&lt;").replace(/>/g, "&gt;")}</h2>
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
  private static async saveRowAsNote(
    row: TableRow,
    columns: TableColumn[],
  ): Promise<boolean> {
    try {
      const parentItem = Zotero.Items.get(row.paperId);
      if (!parentItem || !parentItem.isRegularItem()) {
        Zotero.debug(
          `[seerai] Cannot save note: Invalid parent item ${row.paperId}`,
        );
        return false;
      }

      const paperTitle = (parentItem.getField("title") as string) || "Untitled";

      // Check for existing Tables note
      const existingNote = this.findExistingTablesNote(row.paperId);

      if (existingNote) {
        // Merge: Parse existing data and update with new columns
        const existingData = this.parseTablesNoteContent(
          existingNote.getNote(),
        );

        // Create merged row data - preserve existing values, add new ones
        const mergedData: TableRow = {
          ...row,
          data: { ...row.data },
        };

        // For each column, if existing note has a value and current row doesn't, use existing
        for (const colName in existingData) {
          const col = columns.find((c) => c.name === colName);
          if (
            col &&
            (!mergedData.data[col.id] || mergedData.data[col.id].trim() === "")
          ) {
            mergedData.data[col.id] = existingData[colName];
          }
        }

        // Generate updated HTML
        const newContent = this.generateTablesNoteHtml(
          paperTitle,
          mergedData,
          columns,
        );
        existingNote.setNote(newContent);
        await existingNote.saveTx();

        Zotero.debug(
          `[seerai] Updated existing Tables note for: ${paperTitle}`,
        );
      } else {
        // Create new note
        const note = new Zotero.Item("note");
        note.libraryID = parentItem.libraryID;
        note.parentID = parentItem.id;

        const noteContent = this.generateTablesNoteHtml(
          paperTitle,
          row,
          columns,
        );
        note.setNote(noteContent);
        await note.saveTx();

        Zotero.debug(`[seerai] Created new Tables note for: ${paperTitle}`);
      }

      return true;
    } catch (e) {
      Zotero.debug(`[seerai] Error saving row as note: ${e}`);
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
        Zotero.debug("[seerai] No rows to save as notes");
        return;
      }

      const columns = currentTableConfig?.columns || defaultColumns;

      // Show progress
      const progressWindow = new Zotero.ProgressWindow({ closeOnClick: true });
      progressWindow.changeHeadline("Saving Table as Notes");
      progressWindow.addDescription("Processing...");
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

      progressWindow.changeHeadline("Save Complete");
      progressWindow.addDescription(`Saved: ${saved} | Failed: ${failed}`);
      progressWindow.startCloseTimer(3000);

      Zotero.debug(
        `[seerai] Batch save complete: ${saved} saved, ${failed} failed`,
      );
    } catch (e) {
      Zotero.debug(`[seerai] Error in batch save: ${e}`);
    }
  }

  /**
   * Create the selection chips area
   */
  private static createSelectionArea(
    doc: Document,
    stateManager: ReturnType<typeof getChatStateManager>,
  ): HTMLElement {
    // Return hidden element to maintain layout compatibility if needed, but empty
    return ztoolkit.UI.createElement(doc, "div", {
      styles: { display: "none" },
      properties: { id: "selection-area" },
    });
  }

  /**
   * Show tag picker as a beautiful inline dropdown panel for Chat
   */
  private static async showTagPicker(
    doc: Document,
    stateManager: ReturnType<typeof getChatStateManager>,
  ): Promise<void> {
    // Toggle existing dropdown
    const existing = doc.getElementById(
      "chat-tag-picker-dropdown",
    ) as HTMLElement;
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
        marginRight: "8px",
      },
    });

    // Header
    const header = ztoolkit.UI.createElement(doc, "div", {
      styles: {
        background:
          "linear-gradient(135deg, var(--highlight-primary) 0%, color-mix(in srgb, var(--highlight-primary) 80%, orange) 100%)", // Orange hint for tags
        padding: "10px 14px",
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        gap: "12px",
      },
    });

    const headerTitle = ztoolkit.UI.createElement(doc, "div", {
      properties: { innerText: "🏷️ Add Tags to Chat" },
      styles: {
        fontSize: "13px",
        fontWeight: "600",
        color: "var(--highlight-text)",
        textShadow: "0 1px 2px rgba(0,0,0,0.1)",
      },
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
        justifyContent: "center",
      },
      listeners: [
        {
          type: "click",
          listener: () => {
            dropdown.style.opacity = "0";
            setTimeout(() => dropdown.remove(), 200);
          },
        },
      ],
    });
    header.appendChild(closeBtn);
    dropdown.appendChild(header);

    // Content
    const content = ztoolkit.UI.createElement(doc, "div", {
      styles: {
        padding: "10px 14px",
        display: "flex",
        flexDirection: "column",
        gap: "8px",
      },
    });

    // Controls
    const controlsRow = ztoolkit.UI.createElement(doc, "div", {
      styles: { display: "flex", gap: "6px", alignItems: "center" },
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
        outline: "none",
      },
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
        outline: "none",
      },
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
        backgroundColor: "var(--background-secondary)",
      },
    });
    content.appendChild(listContainer);
    dropdown.appendChild(content);

    // Tags Logic
    let allTags: { tag: string }[] = [];

    const renderTags = () => {
      listContainer.innerHTML = "";
      const searchQuery = searchInput.value.toLowerCase();
      const filtered = allTags
        .filter((t) => t.tag.toLowerCase().includes(searchQuery))
        .slice(0, 50);

      if (filtered.length === 0) {
        listContainer.appendChild(
          ztoolkit.UI.createElement(doc, "div", {
            properties: { innerText: "No tags found." },
            styles: {
              padding: "20px",
              textAlign: "center",
              color: "var(--text-secondary)",
              fontSize: "12px",
            },
          }),
        );
        return;
      }

      filtered.forEach((t) => {
        const row = ztoolkit.UI.createElement(doc, "div", {
          styles: {
            padding: "8px 10px",
            borderBottom: "1px solid var(--border-primary)",
            cursor: "pointer",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          },
        });
        row.addEventListener("mouseenter", () => {
          row.style.backgroundColor = "var(--background-primary)";
        });
        row.addEventListener("mouseleave", () => {
          row.style.backgroundColor = "";
        });

        const label = ztoolkit.UI.createElement(doc, "div", {
          properties: { innerText: t.tag },
          styles: {
            fontSize: "12px",
            color: "var(--text-primary)",
            fontWeight: "500",
          },
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
            transition: "all 0.15s",
          },
          listeners: [
            {
              type: "click",
              listener: async (e: Event) => {
                e.stopPropagation();
                // Add tag to state
                stateManager.addSelection("tags", {
                  id: t.tag,
                  type: "tag",
                  title: t.tag,
                });

                // Add items with this tag
                const filterVal = filterSelect.value;
                let libId: number | null = null;
                let colId: number | null = null;
                if (filterVal.startsWith("lib_"))
                  libId = parseInt(filterVal.replace("lib_", ""));
                if (filterVal.startsWith("col_"))
                  colId = parseInt(filterVal.replace("col_", ""));

                await this.addItemsByTags([t.tag], colId, libId);
                this.reRenderSelectionArea();

                // Feedback
                row.style.backgroundColor = "var(--background-hover)";
                addBtn.replaceWith(
                  ztoolkit.UI.createElement(doc, "span", {
                    properties: { innerText: "✓" },
                    styles: {
                      fontSize: "14px",
                      color: "green",
                      fontWeight: "bold",
                    },
                  }),
                );
              },
            },
          ],
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
      listContainer.appendChild(
        ztoolkit.UI.createElement(doc, "div", {
          properties: { innerText: "Loading tags..." },
          styles: {
            padding: "20px",
            textAlign: "center",
            color: "var(--text-secondary)",
            fontSize: "12px",
          },
        }),
      );

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
            tags = Array.from(tagSet).map((t) => ({ tag: t }));
          }
        }
        // Deduplicate
        const uniqueTags = new Map();
        tags.forEach((t) => uniqueTags.set(t.tag, t));
        allTags = Array.from(uniqueTags.values()).sort((a, b) =>
          a.tag.localeCompare(b.tag),
        );

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
    setTimeout(() => {
      dropdown.style.opacity = "1";
      dropdown.style.transform = "translateY(0)";
    }, 10);
    loadTags();
  }

  /**
   * Show paper picker as a beautiful inline dropdown panel for Chat
   */
  private static async showPaperPicker(
    doc: Document,
    stateManager: ReturnType<typeof getChatStateManager>,
  ): Promise<void> {
    // Toggle existing dropdown
    const existing = doc.getElementById(
      "chat-paper-picker-dropdown",
    ) as HTMLElement;
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
        marginRight: "8px",
      },
    });

    // Header
    const header = ztoolkit.UI.createElement(doc, "div", {
      styles: {
        background:
          "linear-gradient(135deg, var(--highlight-primary) 0%, color-mix(in srgb, var(--highlight-primary) 80%, purple) 100%)",
        padding: "10px 14px",
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        gap: "12px",
      },
    });

    const headerTitle = ztoolkit.UI.createElement(doc, "div", {
      properties: { innerText: "📚 Add Papers to Chat" },
      styles: {
        fontSize: "13px",
        fontWeight: "600",
        color: "var(--highlight-text)",
        textShadow: "0 1px 2px rgba(0,0,0,0.1)",
      },
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
        justifyContent: "center",
      },
      listeners: [
        {
          type: "click",
          listener: () => {
            dropdown.style.opacity = "0";
            dropdown.style.transform = "translateY(-10px)";
            setTimeout(() => dropdown.remove(), 200);
          },
        },
      ],
    });
    header.appendChild(closeBtn);
    dropdown.appendChild(header);

    // Content
    const content = ztoolkit.UI.createElement(doc, "div", {
      styles: {
        padding: "10px 14px",
        display: "flex",
        flexDirection: "column",
        gap: "8px",
      },
    });

    // Controls
    const controlsRow = ztoolkit.UI.createElement(doc, "div", {
      styles: { display: "flex", gap: "6px", alignItems: "center" },
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
        outline: "none",
      },
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
        outline: "none",
      },
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
        backgroundColor: "var(--background-secondary)",
      },
    });
    content.appendChild(listContainer);

    // State
    let allFilteredItems: Zotero.Item[] = [];
    let displayedCount = 0;
    const BATCH_SIZE = 50;

    const renderPaperBatch = (
      items: Zotero.Item[],
      startIndex: number,
      count: number,
    ) => {
      const endIndex = Math.min(startIndex + count, items.length);
      for (let i = startIndex; i < endIndex; i++) {
        const paperItem = items[i];
        const paperTitle =
          (paperItem.getField("title") as string) || "Untitled";
        const creators = paperItem.getCreators();
        const authorStr =
          creators.length > 0
            ? creators.map((c) => c.lastName).join(", ")
            : "Unknown";
        const year = paperItem.getField("year") || "";

        const row = ztoolkit.UI.createElement(doc, "div", {
          styles: {
            padding: "8px 10px",
            borderBottom: "1px solid var(--border-primary)",
            cursor: "pointer",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            transition: "background-color 0.1s",
          },
        });
        row.addEventListener("mouseenter", () => {
          row.style.backgroundColor = "var(--background-primary)";
        });
        row.addEventListener("mouseleave", () => {
          row.style.backgroundColor = "";
        });

        const info = ztoolkit.UI.createElement(doc, "div", {
          styles: { flex: "1", overflow: "hidden", marginRight: "10px" },
        });

        const titleEl = ztoolkit.UI.createElement(doc, "div", {
          properties: { innerText: paperTitle },
          styles: {
            fontSize: "12px",
            fontWeight: "500",
            whiteSpace: "normal",
            wordBreak: "break-word",
            lineHeight: "1.3",
            color: "var(--text-primary)",
          },
        });

        const metaEl = ztoolkit.UI.createElement(doc, "div", {
          properties: { innerText: `${authorStr}${year ? ` • ${year}` : ""}` },
          styles: {
            fontSize: "11px",
            color: "var(--text-secondary)",
            marginTop: "1px",
          },
        });
        info.appendChild(titleEl);
        info.appendChild(metaEl);
        row.appendChild(info);

        // Check if already added
        const isAdded = stateManager
          .getStates()
          .items.some((it) => it.id === paperItem.id);

        if (isAdded) {
          const addedLabel = ztoolkit.UI.createElement(doc, "span", {
            properties: { innerText: "Added" },
            styles: {
              fontSize: "10px",
              color: "var(--text-secondary)",
              fontStyle: "italic",
            },
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
              transition: "all 0.15s",
            },
            listeners: [
              {
                type: "click",
                listener: async (e: Event) => {
                  e.stopPropagation();
                  await this.addItemWithNotes(paperItem);
                  // Animate removal or change to added
                  row.style.backgroundColor = "var(--background-hover)";
                  addBtn.replaceWith(
                    ztoolkit.UI.createElement(doc, "span", {
                      properties: { innerText: "✓" },
                      styles: {
                        fontSize: "14px",
                        color: "green",
                        fontWeight: "bold",
                      },
                    }),
                  );
                  setTimeout(() => {
                    row.style.opacity = "0.5";
                  }, 200);
                },
              },
            ],
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
      const loading = ztoolkit.UI.createElement(doc, "div", {
        properties: { innerText: "Loading..." },
        styles: {
          padding: "20px",
          textAlign: "center",
          color: "var(--text-secondary)",
          fontSize: "12px",
        },
      });
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
            items.push(
              ...libItems.filter((i: Zotero.Item) => i.isRegularItem()),
            );
          }
        } else if (filterValue.startsWith("lib_")) {
          const libraryId = parseInt(filterValue.replace("lib_", ""), 10);
          items = await Zotero.Items.getAll(libraryId);
          items = items.filter((i) => i.isRegularItem());
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

        allFilteredItems = items.filter((i) => {
          const title = ((i.getField("title") as string) || "").toLowerCase();
          const creators = i
            .getCreators()
            .map((c: any) => (c.lastName || c.name || "").toLowerCase())
            .join(" ");
          return title.includes(searchQuery) || creators.includes(searchQuery);
        });

        listContainer.innerHTML = "";
        if (allFilteredItems.length === 0) {
          listContainer.appendChild(
            ztoolkit.UI.createElement(doc, "div", {
              properties: { innerText: "No papers found." },
              styles: {
                padding: "20px",
                textAlign: "center",
                color: "var(--text-secondary)",
                fontSize: "12px",
              },
            }),
          );
        } else {
          renderPaperBatch(allFilteredItems, 0, BATCH_SIZE);
        }
      } catch (e) {
        listContainer.innerHTML = "";
        listContainer.appendChild(
          ztoolkit.UI.createElement(doc, "div", {
            properties: { innerText: "Error loading papers." },
            styles: { color: "red", padding: "10px" },
          }),
        );
        Zotero.debug(`[seerai] Error loading papers: ${e}`);
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
      styles: {
        padding: "8px 14px",
        borderTop: "1px solid var(--border-primary)",
        display: "flex",
        justifyContent: "flex-end",
      },
    });
    const doneBtn = ztoolkit.UI.createElement(doc, "button", {
      properties: { innerText: "Done" },
      styles: {
        padding: "6px 14px",
        border: "1px solid var(--border-primary)",
        borderRadius: "6px",
        fontSize: "12px",
        backgroundColor: "var(--background-secondary)",
        cursor: "pointer",
      },
      listeners: [
        {
          type: "click",
          listener: () => {
            dropdown.style.opacity = "0";
            setTimeout(() => dropdown.remove(), 200);
          },
        },
      ],
    });
    buttonRow.appendChild(doneBtn);
    dropdown.appendChild(buttonRow);

    selectionArea.parentNode.insertBefore(dropdown, selectionArea.nextSibling);

    // Auto focus
    setTimeout(() => searchInput.focus(), 100);
    setTimeout(() => {
      dropdown.style.opacity = "1";
      dropdown.style.transform = "translateY(0)";
    }, 10);

    loadPapers();
  }
  // Remove existing picker if any

  /**
   * Add all items matching the given tags, optionally filtered by collection/library
   */
  private static async addItemsByTags(
    tagNames: string[],
    collectionId?: number | null,
    libraryId?: number | null,
  ) {
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
              const itemTags = item
                .getTags()
                .map((t: { tag: string }) => t.tag);
              // Check if item has any of the selected tags
              if (itemTags.some((tag: string) => itemTagSet.has(tag))) {
                await this.addItemWithNotes(item);
                addedCount++;
              }
            }
          }
        }
      } catch (e) {
        Zotero.debug(`[seerai] Error adding items from collection: ${e}`);
      }
    } else {
      // Get items from specified library or all libraries
      const libraries = libraryId
        ? [{ libraryID: libraryId }]
        : Zotero.Libraries.getAll();

      for (const library of libraries) {
        for (const tagName of tagNames) {
          // Get items with this tag using Zotero Search
          try {
            const s = new Zotero.Search({ libraryID: library.libraryID });
            s.addCondition("tag", "is", tagName);
            s.addCondition("itemType", "isNot", "attachment");
            s.addCondition("itemType", "isNot", "note");
            const itemIDs = await s.search();

            for (const itemID of itemIDs) {
              const item = Zotero.Items.get(itemID);
              if (item && item.isRegularItem()) {
                await this.addItemWithNotes(item);
                addedCount++;
              }
            }
          } catch (e) {
            Zotero.debug(`[seerai] Error searching for tag "${tagName}": ${e}`);
          }
        }
      }
    }

    Zotero.debug(
      `[seerai] Added ${addedCount} items from ${tagNames.length} tag(s)`,
    );
  }

  /**
   * Add items from library selection
   */
  private static async addFromLibrarySelection() {
    const selectedItems =
      Zotero.getActiveZoteroPane()?.getSelectedItems() || [];

    if (selectedItems.length === 0) {
      Zotero.debug("[seerai] No items selected in library pane");
      return;
    }

    let added = 0;
    for (const item of selectedItems) {
      if (item.isRegularItem()) {
        await this.addItemWithNotes(item);
        added++;
      }
    }

    Zotero.debug(`[seerai] Added ${added} items with notes to chat context`);
  }

  /**
   * Get all collections from all libraries for filtering
   */
  private static async getAllCollections(): Promise<
    {
      id: number;
      name: string;
      libraryName: string;
      libraryId: number;
      depth: number;
    }[]
  > {
    const allCollections: {
      id: number;
      name: string;
      libraryName: string;
      libraryId: number;
      depth: number;
    }[] = [];
    const libraries = Zotero.Libraries.getAll();

    for (const library of libraries) {
      try {
        const collections = Zotero.Collections.getByLibrary(library.libraryID);
        if (collections && collections.length > 0) {
          // Build a hierarchical list with proper indentation
          const addCollectionsRecursive = (
            parentId: number | null,
            depth: number,
          ) => {
            for (const collection of collections) {
              const collectionParentId = collection.parentID || null;
              if (collectionParentId === parentId) {
                allCollections.push({
                  id: collection.id,
                  name: collection.name,
                  libraryName: library.name,
                  libraryId: library.libraryID,
                  depth: depth,
                });
                // Recursively add children
                addCollectionsRecursive(collection.id, depth + 1);
              }
            }
          };
          addCollectionsRecursive(null, 0);
        }
      } catch (e) {
        Zotero.debug(
          `[seerai] Error loading collections from library ${library.name}: ${e}`,
        );
      }
    }

    return allCollections;
  }

  /**
   * Create a removable chip element
   */
  private static createChip(
    doc: Document,
    label: string,
    config: typeof selectionConfigs.items,
    onRemove: () => void,
  ): HTMLElement {
    // Detect dark mode using Zotero's theme
    const isDark = getTheme() === "dark";

    // Get chip colors based on theme
    const chipColors = this.getChipColors(config.className, isDark);

    const chip = ztoolkit.UI.createElement(doc, "div", {
      properties: {
        className: `chip ${config.className}`,
      },
      styles: {
        display: "inline-flex",
        alignItems: "center",
        gap: "4px",
        padding: "3px 8px",
        borderRadius: "12px",
        fontSize: "11px",
        maxWidth: "180px",
        border: "1px solid",
        backgroundColor: chipColors.bg,
        borderColor: chipColors.border,
        color: chipColors.text,
      },
    });

    const icon = ztoolkit.UI.createElement(doc, "span", {
      properties: { innerText: config.icon },
      styles: { fontSize: "10px" },
    });

    const displayLabel = label.length > 20 ? label.slice(0, 20) + "..." : label;
    const text = ztoolkit.UI.createElement(doc, "span", {
      properties: { innerText: displayLabel, title: label },
      styles: {
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
      },
    });

    const removeBtn = ztoolkit.UI.createElement(doc, "span", {
      properties: { innerText: "✕" },
      styles: {
        cursor: "pointer",
        fontSize: "10px",
        color: isDark ? "#bbb" : "#666",
        marginLeft: "2px",
        padding: "2px",
        borderRadius: "50%",
      },
      listeners: [
        {
          type: "click",
          listener: (e: Event) => {
            e.stopPropagation();
            onRemove();
          },
        },
      ],
    });

    chip.appendChild(icon);
    chip.appendChild(text);
    chip.appendChild(removeBtn);
    return chip;
  }

  /**
   * Get chip colors based on chip type and dark mode
   */
  private static getChipColors(
    className: string,
    isDark: boolean,
  ): { bg: string; border: string; text: string } {
    const colors: Record<
      string,
      {
        light: { bg: string; border: string; text: string };
        dark: { bg: string; border: string; text: string };
      }
    > = {
      "chip-items": {
        light: { bg: "#e3f2fd", border: "#2196f3", text: "#1565c0" },
        dark: { bg: "#0d47a1", border: "#4dabf5", text: "#fff" },
      },
      "chip-creators": {
        light: { bg: "#f3e5f5", border: "#9c27b0", text: "#7b1fa2" },
        dark: { bg: "#4a148c", border: "#ab47bc", text: "#fff" },
      },
      "chip-tags": {
        light: { bg: "#fff3e0", border: "#ff9800", text: "#e65100" },
        dark: { bg: "#6d4d00", border: "#ffc94d", text: "#fff" },
      },
      "chip-collections": {
        light: { bg: "#e8f5e9", border: "#4caf50", text: "#2e7d32" },
        dark: { bg: "#1b5e20", border: "#66bb6a", text: "#fff" },
      },
      "chip-notes": {
        light: { bg: "#fffde7", border: "#ffeb3b", text: "#f57f17" },
        dark: { bg: "#fff59d", border: "#ffc107", text: "#000" },
      },
      "chip-notes-summary": {
        light: { bg: "#fffde7", border: "#ffeb3b", text: "#f57f17" },
        dark: { bg: "#fff59d", border: "#ffc107", text: "#000" },
      },
      "chip-attachments": {
        light: { bg: "#fce4ec", border: "#e91e63", text: "#c2185b" },
        dark: { bg: "#880e4f", border: "#f06292", text: "#fff" },
      },
      "chip-images": {
        light: { bg: "#e1f5fe", border: "#03a9f4", text: "#0277bd" },
        dark: { bg: "#01579b", border: "#4fc3f7", text: "#fff" },
      },
      "chip-tables": {
        light: { bg: "#f3e5f5", border: "#7b1fa2", text: "#4a148c" },
        dark: { bg: "#4a148c", border: "#ab47bc", text: "#fff" },
      },
    };

    const colorSet = colors[className] || colors["chip-items"];
    return isDark ? colorSet.dark : colorSet.light;
  }

  /**
   * Create the controls bar (Model Selector, Settings, Stop, Clear, Save)
   */
  // Controls bar removed (migrated to Chat Settings)

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
      configs.forEach((cfg) => {
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
   * Show Firecrawl settings popover for inline configuration
   */
  private static showFirecrawlSettingsPopover(
    container: HTMLElement,
    doc: Document,
  ) {
    // Remove existing popover if any
    const existing = doc.getElementById("firecrawl-settings-popover");
    if (existing) {
      existing.remove();
      return;
    }

    const prefPrefix = "extensions.seerai";
    const currentLimit =
      (Zotero.Prefs.get(`${prefPrefix}.firecrawlSearchLimit`) as number) || 3;
    const currentConcurrent =
      (Zotero.Prefs.get(`${prefPrefix}.firecrawlMaxConcurrent`) as number) || 3;

    const popover = ztoolkit.UI.createElement(doc, "div", {
      properties: {
        id: "firecrawl-settings-popover",
        className: "firecrawl-popover",
      },
      // Styles handled by CSS class
    });

    // Title
    const title = ztoolkit.UI.createElement(doc, "div", {
      properties: { innerText: "🔥 Firecrawl Settings" },
      styles: {
        fontWeight: "bold",
        marginBottom: "12px",
        fontSize: "12px",
      },
    });
    popover.appendChild(title);

    // Search Result Count
    const limitRow = ztoolkit.UI.createElement(doc, "div", {
      styles: {
        display: "flex",
        alignItems: "center",
        marginBottom: "8px",
        gap: "8px",
      },
    });
    const limitLabel = ztoolkit.UI.createElement(doc, "label", {
      properties: { innerText: "Search Results:" },
      styles: { fontSize: "11px", flex: "1" },
    });
    const limitInput = ztoolkit.UI.createElement(doc, "input", {
      attributes: {
        type: "number",
        min: "1",
        max: "10",
        value: String(currentLimit),
        class: "firecrawl-input",
      },
      styles: {
        width: "50px",
        padding: "4px",
        fontSize: "11px",
        textAlign: "center",
      },
      listeners: [
        {
          type: "change",
          listener: (e: Event) => {
            const value = parseInt((e.target as HTMLInputElement).value, 10);
            if (value >= 1 && value <= 10) {
              Zotero.Prefs.set(`${prefPrefix}.firecrawlSearchLimit`, value);
              Zotero.debug(`[seerai] Firecrawl search limit set to: ${value}`);
            }
          },
        },
      ],
    }) as HTMLInputElement;
    limitRow.appendChild(limitLabel);
    limitRow.appendChild(limitInput);
    popover.appendChild(limitRow);

    // Max Concurrent
    const concurrentRow = ztoolkit.UI.createElement(doc, "div", {
      styles: { display: "flex", alignItems: "center", gap: "8px" },
    });
    const concurrentLabel = ztoolkit.UI.createElement(doc, "label", {
      properties: { innerText: "Max Concurrent:" },
      styles: { fontSize: "11px", flex: "1" },
    });
    const concurrentInput = ztoolkit.UI.createElement(doc, "input", {
      attributes: {
        type: "number",
        min: "1",
        max: "10",
        value: String(currentConcurrent),
        class: "firecrawl-input",
      },
      styles: {
        width: "50px",
        padding: "4px",
        fontSize: "11px",
        textAlign: "center",
      },
      listeners: [
        {
          type: "change",
          listener: (e: Event) => {
            const value = parseInt((e.target as HTMLInputElement).value, 10);
            if (value >= 1 && value <= 10) {
              Zotero.Prefs.set(`${prefPrefix}.firecrawlMaxConcurrent`, value);
              Zotero.debug(
                `[seerai] Firecrawl max concurrent set to: ${value}`,
              );
            }
          },
        },
      ],
    }) as HTMLInputElement;
    concurrentRow.appendChild(concurrentLabel);
    concurrentRow.appendChild(concurrentInput);
    popover.appendChild(concurrentRow);

    container.appendChild(popover);

    // Close on outside click
    const closeHandler = (e: MouseEvent) => {
      if (!container.contains(e.target as Node)) {
        popover.remove();
        doc.removeEventListener("click", closeHandler);
      }
    };
    setTimeout(() => doc.addEventListener("click", closeHandler), 10);
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
        backgroundColor: "var(--background-primary)",
        border: "1px solid var(--border-primary)",
        borderRadius: "8px",
        padding: "12px",
        boxShadow: "0 4px 12px rgba(0,0,0,0.15)",
        zIndex: "1000",
        minWidth: "200px",
        color: "var(--text-primary)",
      },
    });

    const title = ztoolkit.UI.createElement(doc, "div", {
      properties: { innerText: "Chat Settings" },
      styles: { fontWeight: "600", marginBottom: "12px", fontSize: "13px" },
    });

    // Include Notes toggle
    const notesRow = this.createToggleRow(
      doc,
      "Include Notes",
      options.includeNotes,
      (checked) => {
        stateManager.setOptions({ includeNotes: checked });
      },
    );

    // Include Abstracts toggle
    const abstractsRow = this.createToggleRow(
      doc,
      "Include Abstracts",
      options.includeAbstracts,
      (checked) => {
        stateManager.setOptions({ includeAbstracts: checked });
      },
    );

    // Include Images toggle (for vision models)
    const imagesRow = this.createToggleRow(
      doc,
      "Include Images (Vision)",
      options.includeImages,
      (checked) => {
        stateManager.setOptions({ includeImages: checked });
      },
    );

    // Close button
    const closeBtn = ztoolkit.UI.createElement(doc, "button", {
      properties: { innerText: "Close" },
      styles: {
        marginTop: "12px",
        padding: "6px 12px",
        fontSize: "11px",
        border: "1px solid var(--border-primary)",
        borderRadius: "4px",
        backgroundColor: "var(--background-secondary)",
        color: "var(--text-primary)",
        cursor: "pointer",
        width: "100%",
      },
      listeners: [
        {
          type: "click",
          listener: () => popover.remove(),
        },
      ],
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
  private static createToggleRow(
    doc: Document,
    label: string,
    initialValue: boolean,
    onChange: (checked: boolean) => void,
  ): HTMLElement {
    const row = ztoolkit.UI.createElement(doc, "div", {
      styles: {
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        marginBottom: "8px",
      },
    });

    const labelEl = ztoolkit.UI.createElement(doc, "span", {
      properties: { innerText: label },
      styles: { fontSize: "12px" },
    });

    const checkbox = ztoolkit.UI.createElement(doc, "input", {
      attributes: { type: "checkbox" },
      styles: { cursor: "pointer" },
      listeners: [
        {
          type: "change",
          listener: (e: Event) => {
            onChange((e.target as HTMLInputElement).checked);
          },
        },
      ],
    }) as HTMLInputElement;
    checkbox.checked = initialValue;

    row.appendChild(labelEl);
    row.appendChild(checkbox);
    return row;
  }

  /**
   * Get current library scope preference
   */
  private static getScopePref(): string {
    try {
      return (Zotero.Prefs.get("extensions.seerai.libraryScope") as string) || "all";
    } catch (e) {
      return "all";
    }
  }

  /**
   * Get human-readable label for a scope string
   */
  private static getScopeLabel(scope: string): string {
    if (scope === "user") return "My Library";
    if (scope === "all") return "All Libraries";
    if (scope.startsWith("group:")) {
      const groupId = parseInt(scope.split(":")[1], 10);
      try {
        const group = Zotero.Groups.get(groupId);
        return group ? group.name : "Group: " + groupId;
      } catch (e) {
        return "Group: " + groupId;
      }
    }
    if (scope.startsWith("collection:")) {
      const parts = scope.split(":");
      const colId = parseInt(parts[parts.length - 1], 10);
      try {
        const col = Zotero.Collections.get(colId);
        return col ? "Folder: " + col.name : "Collection";
      } catch (e) {
        return "Collection";
      }
    }
    return "All Libraries";
  }

  /**
   * Show dropdown to select agentic mode scope (library/collection)
   */
  private static showScopeDropdown(
    doc: Document,
    anchorEl: HTMLElement,
    onSelect: (scope: string) => void
  ): void {
    // Remove any existing dropdown
    const existing = doc.getElementById("agentic-scope-dropdown");
    if (existing) existing.remove();

    const dropdown = doc.createElement("div");
    dropdown.id = "agentic-scope-dropdown";
    dropdown.style.cssText = `
      position: absolute;
      bottom: 100%;
      left: 0;
      margin-bottom: 4px;
      min-width: 240px;
      max-height: 500px;
      overflow-y: auto;
      background: var(--background-primary, #fff);
      border: 1px solid var(--border-primary, #ccc);
      border-radius: 8px;
      box-shadow: 0 -4px 12px rgba(0,0,0,0.15);
      z-index: 1000;
      padding: 4px 0;
    `;

    const currentScope = Assistant.getScopePref();

    const addOption = (label: string, value: string, icon: string = "📁", level: number = 0) => {
      const opt = doc.createElement("div");
      const isSelected = currentScope === value;

      opt.style.cssText = `
        padding: 8px 12px;
        padding-left: ${12 + (level * 16)}px;
        cursor: pointer;
        display: flex;
        align-items: center;
        gap: 8px;
        font-size: 12px;
        color: ${isSelected ? "#fff" : "var(--text-primary, #333)"};
        background-color: ${isSelected ? "var(--accent-blue, #007AFF)" : "transparent"};
        font-weight: ${isSelected ? "600" : "normal"};
      `;

      opt.innerHTML = `<span>${icon}</span><span style="flex-grow: 1">${label}</span>`;

      opt.addEventListener("mouseenter", () => {
        if (!isSelected) opt.style.backgroundColor = "var(--fill-quinary, #f5f5f5)";
      });
      opt.addEventListener("mouseleave", () => {
        if (!isSelected) opt.style.backgroundColor = "transparent";
      });
      opt.addEventListener("click", () => {
        onSelect(value);
        dropdown.remove();
      });
      dropdown.appendChild(opt);

      if (isSelected) {
        setTimeout(() => opt.scrollIntoView({ block: 'nearest' }), 50);
      }
    };

    const addCollectionTree = (libraryID: number, parentID: number | null, level: number) => {
      try {
        const collections = parentID
          ? Zotero.Collections.getByParent(parentID)
          : Zotero.Collections.getByLibrary(libraryID);

        for (const col of collections) {
          addOption(col.name, `collection:${col.libraryID}:${col.id}`, "📂", level);
          addCollectionTree(libraryID, col.id, level + 1);
        }
      } catch (e) {
        Zotero.debug(`[seerai] Error rendering collection tree: ${e}`);
      }
    };

    // 1. All Libraries (Global)
    addOption("All Libraries", "all", "🌐");

    // Separator
    const sep1 = doc.createElement("div");
    sep1.style.cssText = "height: 1px; background: var(--border-primary, #ccc); margin: 4px 0;";
    dropdown.appendChild(sep1);

    // 2. Personal Library
    addOption("My Library", "user", "📚");
    addCollectionTree(Zotero.Libraries.userLibraryID, null, 1);

    // 3. Group Libraries
    try {
      const groups = Zotero.Groups.getAll();
      for (const group of groups) {
        // Separator for groups if not the first one
        const groupSep = doc.createElement("div");
        groupSep.style.cssText = "height: 1px; background: var(--border-primary, #ccc); margin: 4px 12px; opacity: 0.5;";
        dropdown.appendChild(groupSep);

        addOption(group.name, `group:${group.groupID}`, "👥");
        addCollectionTree(group.libraryID, null, 1);
      }
    } catch (e) {
      Zotero.debug(`[seerai] Error getting groups: ${e}`);
    }

    // Agent Iteration Limit & Auto-OCR moved to Chat Settings (gear icon)

    // Position dropdown
    anchorEl.parentElement?.appendChild(dropdown);

    // Close on click outside
    const closeHandler = (e: Event) => {
      if (!dropdown.contains(e.target as Node) && e.target !== anchorEl) {
        dropdown.remove();
        doc.removeEventListener("click", closeHandler);
      }
    };
    setTimeout(() => doc.addEventListener("click", closeHandler), 10);
  }

  /**
   * Create the input area with send button and image paste support
   */

  private static createInputArea(
    doc: Document,
    messagesArea: HTMLElement,
    stateManager: ReturnType<typeof getChatStateManager>,
  ): HTMLElement {
    // Track pasted images (persisted across re-renders)
    const pastedImages = currentPastedImages;

    // Container for everything
    const inputContainer = ztoolkit.UI.createElement(doc, "div", {
      styles: {
        display: "flex",
        flexDirection: "column",
        gap: "6px",
      },
    });

    // Unified Context Chips Area
    let contextChipsArea: HTMLElement | null = null;
    try {
      contextChipsArea = createContextChipsArea(doc);
    } catch (e) {
      Zotero.debug(`[seerai] Error creating context chips area: ${e}`);
    }
    const contextManager = ChatContextManager.getInstance();

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
        border: "1px dashed var(--image-preview-border)",
      },
    });

    const updateImagePreview = () => {
      imagePreviewArea.innerHTML = "";
      if (pastedImages.length === 0) {
        (imagePreviewArea as HTMLElement).style.display = "none";
        return;
      }
      (imagePreviewArea as HTMLElement).style.display = "flex";

      const label = ztoolkit.UI.createElement(doc, "div", {
        properties: {
          innerText: `🖼️ ${pastedImages.length} image(s) attached:`,
        },
        styles: {
          width: "100%",
          fontSize: "11px",
          color: "var(--image-preview-text)",
          marginBottom: "4px",
        },
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
            border: "1px solid var(--border-primary)",
          },
        });

        const imgEl = ztoolkit.UI.createElement(doc, "img", {
          attributes: { src: img.image },
          styles: { width: "100%", height: "100%", objectFit: "cover" },
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
            cursor: "pointer",
          },
          listeners: [
            {
              type: "click",
              listener: () => {
                pastedImages.splice(idx, 1);
                updateImagePreview();
              },
            },
          ],
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
        gap: "8px",
      },
    });

    const input = ztoolkit.UI.createElement(doc, "textarea", {
      attributes: {
        placeholder:
          "Ask about selected items... (paste images with Cmd+V or Ctrl+Shift+V)",
        rows: "1",
        disabled: this.isStreaming ? "true" : undefined,
      },
      properties: {
        value: currentDraftText,
      },
      styles: {
        flex: "1",
        padding: "6px 10px",
        border: "1px solid var(--border-primary)",
        borderRadius: "6px",
        fontSize: "13px",
        resize: "vertical",
        height: "32px",
        minHeight: "32px",
        maxHeight: "150px", // Reduced max height to prevent it from taking too much space
        fontFamily: "inherit",
        lineHeight: "1.4",
        boxSizing: "border-box",
        overflow: "auto", // Changed from hidden to auto to allow scrolling immediately if needed
      },
      listeners: [
        {
          type: "keydown",
          listener: (e: KeyboardEvent) => {
            // Handle Ctrl+V/Cmd+V for explicit image paste
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "v") {
              // Use clipboard API to check for images
              // This ensures Ctrl+V works the same as Ctrl+Shift+V for images
              if (
                typeof navigator !== "undefined" &&
                navigator.clipboard &&
                navigator.clipboard.read
              ) {
                navigator.clipboard
                  .read()
                  .then(async (clipboardItems) => {
                    for (const clipboardItem of clipboardItems) {
                      for (const type of clipboardItem.types) {
                        if (type.startsWith("image/")) {
                          // Found an image in clipboard
                          e.preventDefault();
                          try {
                            const blob = await clipboardItem.getType(type);
                            const reader = new FileReader();
                            reader.onload = () => {
                              const dataUrl = reader.result as string;
                              pastedImages.push({
                                id: Date.now().toString(),
                                image: dataUrl,
                                mimeType: type,
                              });
                              updateImagePreview();
                              Zotero.debug(
                                `[seerai] Pasted image via Ctrl+V: ${type}`,
                              );
                            };
                            reader.readAsDataURL(blob);
                          } catch (err) {
                            Zotero.debug(
                              `[seerai] Clipboard read error: ${err}`,
                            );
                          }
                          return;
                        }
                      }
                    }
                    // No image found, let default paste happen (text)
                  })
                  .catch((err) => {
                    // Clipboard API failed, fall back to default paste event handler
                    Zotero.debug(
                      `[seerai] Clipboard API unavailable, using fallback: ${err}`,
                    );
                  });
              }
              // If clipboard API not available, paste event handler will catch it
              return;
            }

            if (e.key === "Enter") {
              // If dropdown is open, let the dropdown handler handle Enter
              if (isDropdownOpen()) {
                return; // Don't send message, dropdown will handle selection
              }
              if (
                !e.shiftKey &&
                !e.ctrlKey &&
                !e.altKey &&
                !e.metaKey &&
                !this.isStreaming
              ) {
                e.preventDefault(); // Prevent newline
                this.handleSendWithStreamingAndImages(
                  input as unknown as HTMLInputElement,
                  messagesArea,
                  stateManager,
                  pastedImages,
                  () => {
                    pastedImages.length = 0;
                    updateImagePreview();
                  },
                );
              } else if (e.ctrlKey || e.altKey || e.metaKey) {
                // Explicitly insert newline for modifiers that might not default to it
                e.preventDefault();
                const start = input.selectionStart || 0;
                const end = input.selectionEnd || 0;
                const val = input.value;
                input.value =
                  val.substring(0, start) + "\n" + val.substring(end);
                input.selectionStart = input.selectionEnd = start + 1;
                // Trigger input event to auto-resize
                input.dispatchEvent(new Event("input"));
              }
              // Shift+Enter falls through to default behavior (newline)
            }
          },
        },
        {
          type: "input",
          listener: () => {
            // Auto-expand
            const el = input as unknown as HTMLTextAreaElement;
            currentDraftText = el.value; // Store draft
            el.style.height = "auto";
            const newHeight = Math.max(32, el.scrollHeight);
            el.style.height = newHeight + "px";
            // Show scrollbar if content exceeds single line
            el.style.overflow = newHeight > 32 ? "auto" : "hidden";
          },
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
                      mimeType: item.type,
                    });
                    updateImagePreview();
                    Zotero.debug(`[seerai] Pasted image: ${item.type}`);
                  };
                  reader.readAsDataURL(blob);
                }
              }
            }
          },
        },
      ],
    }) as unknown as HTMLInputElement;

    const sendBtn = ztoolkit.UI.createElement(doc, "button", {
      properties: {
        innerText: "➤ Send",
        disabled: this.isStreaming,
      },
      styles: {
        padding: "0 16px",
        height: "32px",
        backgroundColor: "var(--accent-color, #007AFF)",
        color: "#fff",
        border: "none",
        borderRadius: "6px",
        cursor: "pointer",
        fontWeight: "600",
        fontSize: "13px",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      },
      listeners: [
        {
          type: "click",
          listener: () => {
            if (!this.isStreaming) {
              this.handleSendWithStreamingAndImages(
                input as unknown as HTMLInputElement,
                messagesArea,
                stateManager,
                pastedImages,
                () => {
                  pastedImages.length = 0;
                  updateImagePreview();
                },
              );
            }
          },
        },
      ],
    });

    // Initial UI sync for restored drafts
    if (currentPastedImages.length > 0) {
      updateImagePreview();
    }
    if (currentDraftText) {
      setTimeout(() => {
        input.dispatchEvent(new Event("input"));
      }, 0);
    }

    // Stop button
    const stopBtn = ztoolkit.UI.createElement(doc, "button", {
      properties: { innerText: "⏹", id: "stop-btn", title: "Stop Generation" },
      styles: {
        padding: "0 12px",
        height: "32px",
        fontSize: "13px",
        border: "1px solid var(--button-stop-border, #d32f2f)",
        borderRadius: "6px",
        backgroundColor: "var(--button-stop-background, #ffebee)",
        color: "var(--button-stop-text, #c62828)",
        cursor: "pointer",
        display: this.isStreaming ? "inline-flex" : "none",
        alignItems: "center",
        justifyContent: "center",
      },
      listeners: [
        {
          type: "click",
          listener: () => {
            openAIService.abortRequest();
            this.isStreaming = false;
            (stopBtn as HTMLElement).style.display = "none";
          },
        },
      ],
    });

    // Clear button with two-click confirmation
    let clearConfirmState = false;
    let clearConfirmTimeout: ReturnType<typeof setTimeout> | null = null;

    const clearBtn = ztoolkit.UI.createElement(doc, "button", {
      properties: { innerText: "🗑", title: "Clear Chat" },
      styles: {
        padding: "0 12px",
        height: "32px",
        fontSize: "13px",
        border: "1px solid var(--border-primary)",
        borderRadius: "6px",
        backgroundColor: "var(--background-secondary)",
        color: "var(--text-secondary)",
        cursor: "pointer",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        transition: "all 0.2s ease",
      },
      listeners: [
        {
          type: "click",
          listener: async () => {
            if (!clearConfirmState) {
              // First click: enter confirmation state
              clearConfirmState = true;
              (clearBtn as HTMLElement).innerText = "Clear?";
              (clearBtn as HTMLElement).style.backgroundColor = "#ffebee";
              (clearBtn as HTMLElement).style.borderColor = "#c62828";
              (clearBtn as HTMLElement).style.color = "#c62828";
              (clearBtn as HTMLElement).title = "Click again to confirm";

              // Reset after 3 seconds if not clicked
              clearConfirmTimeout = setTimeout(() => {
                clearConfirmState = false;
                (clearBtn as HTMLElement).innerText = "🗑";
                (clearBtn as HTMLElement).style.backgroundColor =
                  "var(--background-secondary)";
                (clearBtn as HTMLElement).style.borderColor =
                  "var(--border-primary)";
                (clearBtn as HTMLElement).style.color = "var(--text-secondary)";
                (clearBtn as HTMLElement).title = "Clear Chat";
              }, 3000);
            } else {
              // Second click: perform clear
              if (clearConfirmTimeout) clearTimeout(clearConfirmTimeout);
              clearConfirmState = false;

              conversationMessages = [];
              if (messagesArea) messagesArea.innerHTML = "";
              try {
                await getMessageStore().clearMessages();
              } catch (e) {
                Zotero.debug(`[seerai] Error clearing message store: ${e}`);
              }

              // Reset button appearance
              (clearBtn as HTMLElement).innerText = "🗑";
              (clearBtn as HTMLElement).style.backgroundColor =
                "var(--background-secondary)";
              (clearBtn as HTMLElement).style.borderColor =
                "var(--border-primary)";
              (clearBtn as HTMLElement).style.color = "var(--text-secondary)";
              (clearBtn as HTMLElement).title = "Clear Chat";
            }
          },
        },
      ],
    });

    // Save button
    const saveBtn = ztoolkit.UI.createElement(doc, "button", {
      properties: { innerText: "💾", title: "Save Chat" },
      styles: {
        padding: "0 12px",
        height: "32px",
        fontSize: "13px",
        border: "1px solid var(--border-primary)",
        borderRadius: "6px",
        backgroundColor: "var(--background-secondary)",
        color: "var(--text-secondary)",
        cursor: "pointer",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      },
      listeners: [
        {
          type: "click",
          listener: async () => {
            await this.saveConversationAsNote();
          },
        },
      ],
    });

    // Settings / Config button
    const settingsBtn = ztoolkit.UI.createElement(doc, "button", {
      properties: {
        innerText: "⚙️",
        title: "Chat Settings (Model, Mode, Web Search)",
      },
      styles: {
        width: "32px",
        height: "32px",
        border: "1px solid var(--border-primary)",
        borderRadius: "6px",
        backgroundColor: "var(--background-primary)",
        color: "var(--text-secondary)",
        cursor: "pointer",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: "14px",
        transition: "all 0.15s ease",
      },
      listeners: [
        {
          type: "click",
          listener: () => {
            showChatSettings(doc, settingsBtn as HTMLElement, {
              onModeChange: async (mode) => {
                // If switching to default or explore mode, auto-add current item
                if (mode !== "lock" && currentItem) {
                  if (mode === "default") {
                    stateManager.clearAll();
                  }
                  await this.addItemWithNotes(currentItem);
                }
              },
            });
          },
        },
        {
          type: "mouseenter",
          listener: () => {
            (settingsBtn as HTMLElement).style.backgroundColor =
              "var(--background-secondary)";
            (settingsBtn as HTMLElement).style.borderColor =
              "var(--border-secondary)";
          },
        },
        {
          type: "mouseleave",
          listener: () => {
            (settingsBtn as HTMLElement).style.backgroundColor =
              "var(--background-primary)";
            (settingsBtn as HTMLElement).style.borderColor =
              "var(--border-primary)";
          },
        },
      ],
    });

    const settingsContainer = doc.createElement("div");
    settingsContainer.style.cssText = "position: relative; margin-right: 4px;";
    settingsContainer.appendChild(settingsBtn);

    // Agentic mode toggle button
    let agenticEnabled = isAgenticModeEnabled();

    const updateAgenticBtnStyle = (btn: HTMLElement, enabled: boolean) => {
      btn.innerText = enabled ? "🤖" : "💬";
      btn.title = enabled ? `Agentic Mode: ON - Scope: ${this.getScopeLabel(this.getScopePref())}` : "Agentic Mode: OFF (click to enable)";
      btn.style.backgroundColor = enabled ? "var(--accent-blue, #007AFF)" : "var(--background-secondary)";
      btn.style.color = enabled ? "#fff" : "var(--text-secondary)";
      btn.style.borderColor = enabled ? "var(--accent-blue, #007AFF)" : "var(--border-primary)";
    };

    const agenticBtn = ztoolkit.UI.createElement(doc, "button", {
      properties: { innerText: agenticEnabled ? "🤖" : "💬", title: "Toggle Agentic Mode (tool calling)" },
      styles: {
        width: "32px",
        height: "32px",
        border: "1px solid var(--border-primary)",
        borderRadius: "6px 0 0 6px",
        backgroundColor: agenticEnabled ? "var(--accent-blue, #007AFF)" : "var(--background-secondary)",
        color: agenticEnabled ? "#fff" : "var(--text-secondary)",
        cursor: "pointer",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: "14px",
        transition: "all 0.15s ease",
      },
      listeners: [
        {
          type: "click",
          listener: () => {
            agenticEnabled = !agenticEnabled;
            try {
              Zotero.Prefs.set("extensions.seerai.agenticMode", agenticEnabled);
            } catch (e) {
              Zotero.debug(`[seerai] Error saving agentic mode pref: ${e}`);
            }
            updateAgenticBtnStyle(agenticBtn as HTMLElement, agenticEnabled);
            // Update scope button visibility
            (scopeBtn as HTMLElement).style.display = agenticEnabled ? "flex" : "none";
            Zotero.debug(`[seerai] Agentic mode toggled: ${agenticEnabled}`);
          },
        },
      ],
    });

    // Scope selector button (dropdown trigger)
    const scopeBtn = ztoolkit.UI.createElement(doc, "button", {
      properties: { innerText: "▼", title: `Scope: ${this.getScopeLabel(this.getScopePref())}` },
      styles: {
        width: "20px",
        height: "32px",
        border: "1px solid var(--accent-blue, #007AFF)",
        borderLeft: "none",
        borderRadius: "0 6px 6px 0",
        backgroundColor: "var(--accent-blue, #007AFF)",
        color: "#fff",
        cursor: "pointer",
        display: agenticEnabled ? "flex" : "none",
        alignItems: "center",
        justifyContent: "center",
        fontSize: "10px",
        transition: "all 0.15s ease",
      },
      listeners: [
        {
          type: "click",
          listener: (e: Event) => {
            e.stopPropagation();
            this.showScopeDropdown(doc, scopeBtn as HTMLElement, (newScope: string) => {
              try {
                Zotero.Prefs.set("extensions.seerai.libraryScope", newScope);
                (scopeBtn as HTMLElement).title = `Scope: ${this.getScopeLabel(newScope)}`;
                updateAgenticBtnStyle(agenticBtn as HTMLElement, agenticEnabled);
                Zotero.debug(`[seerai] Agent scope changed to: ${newScope}`);
              } catch (err) {
                Zotero.debug(`[seerai] Error saving scope: ${err}`);
              }
            });
          },
        },

      ],
    });

    const agenticContainer = doc.createElement("div");
    agenticContainer.style.cssText = "position: relative; display: flex; margin-right: 4px;";
    agenticContainer.appendChild(agenticBtn);
    agenticContainer.appendChild(scopeBtn);


    // Prompt Library button
    const promptsBtn = ztoolkit.UI.createElement(doc, "button", {
      properties: { innerText: "📚", title: "Prompt Library" },
      styles: {
        width: "32px",
        height: "32px",
        border: "1px solid var(--border-primary)",
        borderRadius: "6px",
        backgroundColor: "var(--background-primary)",
        color: "var(--text-secondary)",
        cursor: "pointer",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: "14px",
        transition: "all 0.15s ease",
      },
      listeners: [
        {
          type: "click",
          listener: () => {
            showPromptPicker(doc, promptsBtn as HTMLElement, {
              onSelect: (template) => {
                // Insert template text into input
                const currentVal = input.value;
                if (currentVal) {
                  input.value = currentVal + " " + template.template;
                } else {
                  input.value = template.template;
                }
                input.focus();
                // Trigger input event for autocomplete (Zotero-compatible)
                const inputEvent = doc.createEvent("Event");
                inputEvent.initEvent("input", true, true);
                input.dispatchEvent(inputEvent);

                // Trigger first placeholder
                triggerNextPlaceholder(doc, input);
              },
            });
          },
        },
        {
          type: "mouseenter",
          listener: () => {
            (promptsBtn as HTMLElement).style.backgroundColor =
              "var(--background-secondary)";
            (promptsBtn as HTMLElement).style.borderColor =
              "var(--border-secondary)";
          },
        },
        {
          type: "mouseleave",
          listener: () => {
            (promptsBtn as HTMLElement).style.backgroundColor =
              "var(--background-primary)";
            (promptsBtn as HTMLElement).style.borderColor =
              "var(--border-primary)";
          },
        },
      ],
    });

    const promptsContainer = doc.createElement("div");
    promptsContainer.style.cssText = "position: relative;";
    promptsContainer.appendChild(promptsBtn);

    // Placeholder menu button (for manually inserting placeholders)
    const placeholderBtn = createPlaceholderMenuButton(doc, input);

    // Initialize placeholder autocomplete on input with chip insertion
    initPlaceholderAutocomplete(
      doc,
      input,
      (value, itemType, itemId, trigger) => {
        // Add to centralized context manager
        const type = itemType as ContextItemType;
        contextManager.addItem(
          itemId || value,
          type,
          value,
          "command",
          { itemKey: String(itemId) }, // Store metadata if available
        );

        // Clear the trigger text from input
        const currentValue = input.value;
        // Find and remove the trigger pattern from input
        const cleanedValue = currentValue.replace(/\[[^\]]+\]\s*$/, "").trim();
        input.value = cleanedValue;

        // Trigger next placeholder
        triggerNextPlaceholder(doc, input);
      },
    );

    inputArea.appendChild(agenticContainer);
    inputArea.appendChild(settingsContainer);
    inputArea.appendChild(promptsContainer);
    inputArea.appendChild(placeholderBtn);
    inputArea.appendChild(input);
    inputArea.appendChild(sendBtn);
    inputArea.appendChild(stopBtn);
    inputArea.appendChild(clearBtn);
    inputArea.appendChild(saveBtn);

    // History Button
    const historyBtn = ztoolkit.UI.createElement(doc, "button", {
      properties: { innerText: "📜", title: "Chat History" },
      styles: {
        padding: "0 12px",
        height: "32px",
        fontSize: "13px",
        border: "1px solid var(--border-primary)",
        borderRadius: "6px",
        backgroundColor: "var(--background-secondary)",
        color: "var(--text-secondary)",
        cursor: "pointer",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      },
      listeners: [
        {
          type: "click",
          listener: (e: MouseEvent) => {
            this.showHistoryPopover(doc, historyBtn as HTMLElement);
          },
        },
      ],
    });
    inputArea.appendChild(historyBtn);


    if (contextChipsArea) {
      inputContainer.appendChild(contextChipsArea);
    }
    inputContainer.appendChild(imagePreviewArea);
    inputContainer.appendChild(inputArea);
    return inputContainer;
  }

  /**
   * Show history popover with past conversations
   */
  private static async showHistoryPopover(doc: Document, anchorBtn: HTMLElement) {
    const dropdown = doc.createElement("div");
    dropdown.className = "history-popover";
    dropdown.style.cssText = `
      position: absolute;
      bottom: 45px;
      right: 0;
      width: 280px;
      max-height: 400px;
      background: var(--background-primary);
      border: 1px solid var(--border-primary);
      border-radius: 8px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.15);
      z-index: 1000;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      animation: slide-up 0.2s ease-out;
    `;

    const header = doc.createElement("div");
    header.style.cssText = "padding: 8px 12px; border-bottom: 1px solid var(--border-primary); display: flex; justify-content: space-between; align-items: center; background: var(--background-secondary);";

    const title = doc.createElement("span");
    title.textContent = "Chat History";
    title.style.fontWeight = "600";
    title.style.fontSize = "12px";
    header.appendChild(title);

    const newChatBtn = doc.createElement("button");
    newChatBtn.textContent = "+ New Chat";
    newChatBtn.style.cssText = "padding: 4px 8px; font-size: 11px; background: var(--highlight-primary); color: white; border: none; border-radius: 4px; cursor: pointer;";
    newChatBtn.onclick = () => {
      this.createNewChat();
      dropdown.remove();
    };
    header.appendChild(newChatBtn);
    dropdown.appendChild(header);

    const listContainer = doc.createElement("div");
    listContainer.className = "history-list";
    listContainer.style.cssText = "overflow-y: auto; flex: 1; max-height: 350px;";

    if (conversationHistory.length === 0) {
      const emptyMsg = doc.createElement("div");
      emptyMsg.textContent = "No history yet";
      emptyMsg.style.cssText = "padding: 20px; text-align: center; color: var(--text-tertiary); font-style: italic;";
      listContainer.appendChild(emptyMsg);
    } else {
      conversationHistory.forEach(conv => {
        const item = doc.createElement("div");
        item.className = "history-item" + (getMessageStore().getConversationId() === conv.id ? " active" : "");
        item.style.cssText = "padding: 10px 12px; border-bottom: 1px solid var(--border-quaternary); cursor: pointer; position: relative; transition: background 0.2s;";

        const itemTitle = doc.createElement("div");
        itemTitle.textContent = conv.title || "Untitled Chat";
        itemTitle.style.cssText = "font-weight: 500; font-size: 13px; color: var(--text-primary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; padding-right: 25px;";
        item.appendChild(itemTitle);

        const itemMeta = doc.createElement("div");
        itemMeta.textContent = this.formatRelativeTime(new Date(conv.updatedAt));
        itemMeta.style.cssText = "font-size: 11px; color: var(--text-tertiary); margin-top: 2px;";
        item.appendChild(itemMeta);

        const deleteBtn = doc.createElement("span");
        deleteBtn.innerHTML = "🗑️";
        deleteBtn.className = "delete-btn";
        deleteBtn.style.cssText = "position: absolute; right: 8px; top: 10px; opacity: 0; transition: opacity 0.2s; font-size: 12px;";
        deleteBtn.onclick = (e) => {
          e.stopPropagation();
          if (doc.defaultView?.confirm("Delete this conversation?")) {
            this.deleteChat(conv.id);
            dropdown.remove();
          }
        };
        item.appendChild(deleteBtn);

        item.onmouseenter = () => { deleteBtn.style.opacity = "0.7"; };
        item.onmouseleave = () => { deleteBtn.style.opacity = "0"; };

        item.onclick = () => {
          this.loadChat(conv.id);
          dropdown.remove();
        };
        listContainer.appendChild(item);
      });
    }

    dropdown.appendChild(listContainer);
    anchorBtn.parentElement?.appendChild(dropdown);

    // Close on outside click
    const outsideClick = (e: MouseEvent) => {
      if (!dropdown.contains(e.target as Node) && e.target !== anchorBtn) {
        dropdown.remove();
        doc.removeEventListener("click", outsideClick);
      }
    };
    setTimeout(() => doc.addEventListener("click", outsideClick), 0);
  }


  /**
   * Handle an inline permission request from the agent engine.
   * Finds the UI element for the tool call and appends Allow/Deny buttons.
   */
  private static async handleInlinePermissionRequest(toolCallId: string, toolName: string): Promise<boolean> {
    Zotero.debug(`[seerai] handleInlinePermissionRequest started for ${toolName} (${toolCallId})`);

    if (!activeAgentSession) {
      Zotero.debug("[seerai] Permission Error: No activeAgentSession found");
      return false;
    }

    if (!activeAgentSession.contentDiv) {
      Zotero.debug("[seerai] Permission Error: activeAgentSession.contentDiv is null");
      return false;
    }

    Zotero.debug(`[seerai] session.toolResults count: ${activeAgentSession.toolResults.length}`);
    activeAgentSession.toolResults.forEach(r => Zotero.debug(`[seerai] candidate tool id: ${r.toolCall.id}`));

    const tr = activeAgentSession.toolResults.find(t => t.toolCall.id === toolCallId);
    const toolElement = tr?.uiElement;

    if (!toolElement) {
      Zotero.debug(`[seerai] Permission Error: Could not find UI element for tool call ${toolCallId} in session results`);
      return false;
    }

    Zotero.debug("[seerai] Found toolElement, looking for .tool-details-content");

    // Find the details content area to inject buttons
    const detailsContent = toolElement.querySelector(".tool-details-content");
    if (!detailsContent) {
      Zotero.debug("[seerai] Permission Error: Could not find .tool-details-content in toolElement");
      return false;
    }

    Zotero.debug("[seerai] Found detailsContent, creating permission buttons");

    // Automatically expand the parent tool list and the individual tool card
    if (activeAgentSession.toolProcessState?.container) {
      (activeAgentSession.toolProcessState.container as any).open = true;
    }
    if (toolElement.tagName === "DETAILS" || (toolElement as any).open !== undefined) {
      (toolElement as any).open = true;
    }

    // Create the permission UI container
    const doc = toolElement.ownerDocument;
    if (!doc) return false;
    const permissionContainer = doc.createElement("div");
    permissionContainer.className = "permission-request-ui";
    permissionContainer.style.cssText = `
          margin-top: 10px;
          padding: 8px;
          background: var(--background-secondary, #f5f5f5);
          border-radius: 6px;
          border-left: 3px solid #ff9800;
          animation: fade-in 0.3s ease;
      `;

    const promptText = doc.createElement("div");
    promptText.style.cssText = "margin-bottom: 8px; font-weight: 500; font-size: 0.9em;";
    promptText.textContent = "⚠️ Permission Required";

    const subText = doc.createElement("div");
    subText.style.cssText = "margin-bottom: 8px; font-size: 0.85em; color: var(--text-secondary);";
    subText.textContent = "The agent wants to execute this tool. Allow?";

    const btnContainer = doc.createElement("div");
    btnContainer.style.cssText = "display: flex; gap: 8px; justify-content: flex-end;";

    const denyBtn = doc.createElement("button");
    denyBtn.textContent = "Deny";
    denyBtn.style.cssText = `
          padding: 4px 12px;
          border: 1px solid var(--border-primary);
          border-radius: 4px;
          background: var(--background-primary);
          cursor: pointer;
          font-size: 0.85em;
      `;

    const allowBtn = doc.createElement("button");
    allowBtn.textContent = "Allow";
    allowBtn.style.cssText = `
          padding: 4px 12px;
          border: none;
          border-radius: 4px;
          background: var(--highlight-primary, #1976d2);
          color: white;
          cursor: pointer;
          font-size: 0.85em;
      `;

    permissionContainer.appendChild(promptText);
    permissionContainer.appendChild(subText);
    btnContainer.appendChild(denyBtn);
    btnContainer.appendChild(allowBtn);
    permissionContainer.appendChild(btnContainer);

    detailsContent.appendChild(permissionContainer);

    return new Promise<boolean>((resolve) => {
      const cleanup = () => {
        permissionContainer.remove();
      };

      allowBtn.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        cleanup();
        resolve(true);
      };

      denyBtn.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        cleanup();
        resolve(false);
      };
    });
  }

  /**
   * Handle send with streaming response and pasted images (vision mode)
   */
  private static async handleSendWithStreamingAndImages(
    input: HTMLInputElement,
    messagesArea: HTMLElement,
    stateManager: ReturnType<typeof getChatStateManager>,
    pastedImages: { id: string; image: string; mimeType: string }[],
    clearImages: () => void,
  ) {
    const text = input.value.trim();
    // Allow sending with just images
    if ((!text && pastedImages.length === 0) || this.isStreaming) return;

    // Store and display user message
    const userMsg: ChatMessage = {
      id: Date.now().toString(),
      role: "user",
      content:
        pastedImages.length > 0
          ? `${text} [+${pastedImages.length} image(s)]`
          : text,
      timestamp: new Date(),
    };
    conversationMessages.push(userMsg);

    // Persist user message
    try {
      await getMessageStore().appendMessage(userMsg);
    } catch (e) {
      Zotero.debug(`[seerai] Error saving user message: ${e}`);
    }

    const displayText =
      pastedImages.length > 0
        ? `${text || "(no text)"} 🖼️ ${pastedImages.length} image(s)`
        : text;
    this.appendMessage(messagesArea, "You", displayText, userMsg.id, true);

    input.value = "";
    currentDraftText = ""; // Clear persisted draft
    input.disabled = true;
    this.isStreaming = true;

    // Show stop button
    const stopBtn = messagesArea.ownerDocument?.getElementById(
      "stop-btn",
    ) as HTMLElement;
    if (stopBtn) stopBtn.style.display = "inline-block";

    // Create streaming message placeholder with loading indicator
    const loadingHtml = `
            <div class="typing-indicator" style="display: flex; align-items: center; gap: 4px; color: var(--text-secondary); font-style: italic;">
                <span>Thinking</span>
                <span class="dot" style="animation: blink 1.4s infinite .2s;">.</span>
                <span class="dot" style="animation: blink 1.4s infinite .4s;">.</span>
                <span class="dot" style="animation: blink 1.4s infinite .6s;">.</span>
            </div>
            <style>
                @keyframes blink { 0% { opacity: .2; } 20% { opacity: 1; } 100% { opacity: .2; } }
            </style>
        `;
    const streamingDiv = this.appendMessage(messagesArea, "Assistant", "");
    const contentDiv = streamingDiv.querySelector(
      "[data-content]",
    ) as HTMLElement;
    contentDiv.innerHTML = loadingHtml;

    // Initialize active agent session
    activeAgentSession = {
      text,
      fullResponse: "",
      toolResults: [],
      isThinking: true,
      messagesArea: messagesArea,
      contentDiv: contentDiv,
      toolContainer: null,
    };

    const session = activeAgentSession;

    const smartScrollToBottom = () => {
      if (!messagesArea) return;
      const threshold = 100; // pixels from bottom
      const isNearBottom = messagesArea.scrollHeight - messagesArea.scrollTop <= messagesArea.clientHeight + threshold;
      if (isNearBottom) {
        messagesArea.scrollTop = messagesArea.scrollHeight;
      }
    };

    const observer: AgentUIObserver = {
      onToken: (token: string, fullResponse: string) => {
        session.fullResponse = fullResponse;
        if (session.contentDiv) {
          // Ensure markdown container exists
          let mdContainer = session.contentDiv.querySelector(".markdown-content");
          if (!mdContainer) {
            // If we are upgrading from a plain div, wrap existing content? 
            // Or just create it. For streaming, we are usually starting fresh or appending.
            mdContainer = session.contentDiv.ownerDocument!.createElement("div");
            mdContainer.className = "markdown-content";
            // Prepend or append? If tools exist, tools are appended. 
            // Text usually comes first or wraps. For simplicity, we keep text at top.
            if (session.contentDiv.firstChild) {
              session.contentDiv.insertBefore(mdContainer, session.contentDiv.firstChild);
            } else {
              session.contentDiv.appendChild(mdContainer);
            }
          }

          if (session.isThinking) {
            mdContainer.innerHTML = "";
            session.isThinking = false;
          }
          // Update only the markdown container
          mdContainer.setAttribute("data-raw", fullResponse);
          mdContainer.innerHTML = parseMarkdown(fullResponse);
        }
        if (session.messagesArea) {
          smartScrollToBottom();
        }
      },
      onToolCallStarted: (toolCall: ToolCall) => {
        session.isThinking = false;

        if (session.messagesArea && session.contentDiv) {
          const doc = session.messagesArea.ownerDocument!;

          // Initial creation of the process container logic
          if (!session.toolProcessState) {
            const processUI = createToolProcessUI(doc);
            session.toolProcessState = processUI;
            session.contentDiv.appendChild(processUI.container);

            // Set initial state
            processUI.setThinking();

            // Store the list container for appending tool cards
            // The list container is the div inside the details
            session.toolContainer = processUI.container.querySelector(".tool-list-container") as HTMLElement;
          }

          const toolUI = createToolExecutionUI(doc, toolCall);

          if (session.toolContainer) {
            session.toolContainer.appendChild(toolUI);
          } else {
            // Fallback if list container missing (shouldn't happen given createToolProcessUI structure)
            session.contentDiv.appendChild(toolUI);
          }

          session.toolResults.push({ toolCall, uiElement: toolUI });
          smartScrollToBottom();
        } else {
          session.toolResults.push({ toolCall });
        }
      },
      onToolCallCompleted: (toolCall: ToolCall, result: ToolResult) => {
        const tr = session.toolResults.find(t => t.toolCall.id === toolCall.id);
        if (tr) tr.result = result;

        if (session.messagesArea && session.toolContainer && tr?.uiElement) {
          const doc = session.messagesArea.ownerDocument!;
          const newUI = createToolExecutionUI(doc, toolCall, result);
          session.toolContainer.replaceChild(newUI, tr.uiElement);
          tr.uiElement = newUI;
          smartScrollToBottom();
        }
      },
      onMessageUpdate: (content: string) => {
        session.fullResponse = content;
        if (session.contentDiv) {
          let mdContainer = session.contentDiv.querySelector(".markdown-content");
          if (!mdContainer) {
            mdContainer = session.contentDiv.ownerDocument!.createElement("div");
            mdContainer.className = "markdown-content";
            if (session.contentDiv.firstChild) {
              session.contentDiv.insertBefore(mdContainer, session.contentDiv.firstChild);
            } else {
              session.contentDiv.appendChild(mdContainer);
            }
          }
          mdContainer.innerHTML = parseMarkdown(content);
        }
      },
      onComplete: async (content: string) => {
        session.fullResponse = content;
        session.isThinking = false;

        // Remove the thinking indicator if it still exists
        if (session.contentDiv) {
          const typingIndicator = session.contentDiv.querySelector('.typing-indicator');
          if (typingIndicator) {
            typingIndicator.remove();
          }
        }

        // Finalize tool process UI if exists
        if (session.toolProcessState) {
          const count = session.toolResults.length;
          session.toolProcessState.setCompleted(count);
        }

        const assistantMsg: ChatMessage = {
          id: Date.now().toString(),
          role: "assistant",
          content: content,
          timestamp: new Date(),
          toolResults: session.toolResults.length > 0 ? session.toolResults : undefined,
        };
        conversationMessages.push(assistantMsg);

        // Persist assistant message
        try {
          await getMessageStore().appendMessage(assistantMsg);

          // NEW: Auto-titling if this is the first message
          if (conversationMessages.length <= 2) {
            await this.updateConversationTitle(text);
          }
        } catch (e) {
          Zotero.debug(`[seerai] Error saving assistant message: ${e}`);
        }

        // Cleanup session
        activeAgentSession = null;
        this.isStreaming = false;
        input.disabled = false;
        if (stopBtn) stopBtn.style.display = "none";

        // Clear pasted images after successful send
        clearImages();
      },
      onError: (error: Error) => {
        Zotero.debug(`[seerai] Agent error: ${error}`);
        if (session.contentDiv) {
          if (session.toolProcessState) {
            session.toolProcessState.setFailed(error.message);
          } else {
            session.contentDiv.innerHTML = `<span style="color: #c62828;">Error: ${error.message}</span>`;
          }
        }
        activeAgentSession = null;
        this.isStreaming = false;
        input.disabled = false;
        if (stopBtn) stopBtn.style.display = "none";
      }
    };

    let isFirstToken = true;

    try {
      // Build context from ChatContextManager
      const contextManager = ChatContextManager.getInstance();
      const options = stateManager.getOptions();

      // Fetch Table Configs if needed (for table items)
      const contextItems = contextManager.getItems();

      // Check for tables
      let storedTables: any[] = [];
      const hasTable = contextItems.some((i) => i.type === "table");
      if (hasTable) {
        try {
          storedTables = await getTableStore().getAllTables();
        } catch (e) {
          Zotero.debug(`[seerai] Error fetching tables for context: ${e}`);
        }
      }

      let context = "=== Context ===\n";
      if (contextItems.length === 0) {
        context +=
          "(No specific context provided. Answer based on general knowledge and web search if enabled.)";
      }

      for (const item of contextItems) {
        if (item.type === "paper") {
          const zoteroItem = Zotero.Items.get(item.id as number);
          if (!zoteroItem) continue;

          context += `\n\n--- Paper: ${item.displayName} ---`;

          const year = zoteroItem.getField("date");
          if (year) context += ` (${year})`;

          const creators = zoteroItem
            .getCreators()
            .map((c: any) => `${c.firstName} ${c.lastName}`);
          if (creators.length > 0)
            context += `\nAuthors: ${creators.join(", ")}`;

          const abstract = zoteroItem.getField("abstractNote");
          if (abstract) context += `\nAbstract: ${abstract}`;

          // Fetch PDF/note content for this item
          try {
            if (zoteroItem.isRegularItem()) {
              // Fetch text (priority logic inside getPdfTextForItem: Notes -> Indexed PDF -> Metadata)
              // We pass includeNotes=true, includeMetadata=true.
              const itemContent = await Assistant.getPdfTextForItem(
                zoteroItem,
                0,
                true,
                true,
              );
              if (itemContent) {
                context += `\n\nContent:\n${itemContent}`;
              }
            }
          } catch (e) {
            Zotero.debug(
              `[seerai] Error fetching content for item ${item.id}: ${e}`,
            );
          }
        } else if (item.type === "table") {
          const tableConfig = storedTables.find((t) => t.id === item.id);
          if (tableConfig) {
            context += `\n\n--- Table: ${tableConfig.name} ---`;

            // List column definitions
            const columnNames = tableConfig.columns.map(
              (c: any) => c.name || c.title,
            );
            context += `\nColumns: ${columnNames.join(", ")}`;
            context += `\nTotal papers: ${tableConfig.addedPaperIds.length}`;

            // Include actual table data (paper rows with all generated column values)
            const generatedData = tableConfig.generatedData || {};

            if (tableConfig.addedPaperIds.length > 0) {
              context += `\n\n=== Table Data ===`;

              // Process all papers in the table (no limit)
              for (const paperId of tableConfig.addedPaperIds) {
                const zoteroItem = Zotero.Items.get(paperId);
                if (!zoteroItem) continue;

                const title = zoteroItem.getField("title") || "Untitled";
                const creators = zoteroItem.getCreators();
                const authorStr =
                  creators.length > 0
                    ? creators
                      .map((c: any) => c.lastName || c.name)
                      .slice(0, 3)
                      .join(", ") + (creators.length > 3 ? " et al." : "")
                    : "";
                const year =
                  zoteroItem.getField("year") ||
                  zoteroItem.getField("date")?.substring(0, 4) ||
                  "";

                context += `\n\n--- Paper: ${title} ---`;
                if (authorStr) context += `\nAuthors: ${authorStr}`;
                if (year) context += ` (${year})`;

                // Include all generated column values for this paper
                const paperData = generatedData[paperId];
                if (paperData && Object.keys(paperData).length > 0) {
                  context += `\n`;
                  for (const column of tableConfig.columns) {
                    const columnId = column.id;
                    const columnName = column.name || column.title || columnId;
                    const value = paperData[columnId];

                    // Skip standard columns that are just metadata
                    if (
                      ["title", "author", "year", "sources"].includes(columnId)
                    )
                      continue;

                    if (value) {
                      context += `\n${columnName}: ${value}`;
                    }
                  }
                }
              }
            }
          }
        } else if (item.type === "tag") {
          const tagName = item.displayName;
          context += `\n\n--- Tag: ${tagName} ---`;

          // Fetch all papers with this tag and include their content
          try {
            const libraryID = Zotero.Libraries.userLibraryID;
            const s = new Zotero.Search({ libraryID });
            s.addCondition("tag", "is", tagName);
            s.addCondition("itemType", "isNot", "attachment");
            s.addCondition("itemType", "isNot", "note");
            const itemIDs = await s.search();

            if (itemIDs.length === 0) {
              context += `\n(No papers found with this tag)`;
            } else {
              context += `\nPapers with this tag: ${itemIDs.length}`;

              // Process all papers with this tag
              for (const itemID of itemIDs) {
                const zoteroItem = Zotero.Items.get(itemID);
                if (!zoteroItem || !zoteroItem.isRegularItem()) continue;

                const title = zoteroItem.getField("title");
                context += `\n\n--- Paper: ${title} ---`;

                const year = zoteroItem.getField("date");
                if (year) context += ` (${year})`;

                const creators = zoteroItem
                  .getCreators()
                  .map((c: any) => `${c.firstName} ${c.lastName}`);
                if (creators.length > 0)
                  context += `\nAuthors: ${creators.join(", ")}`;

                const abstract = zoteroItem.getField("abstractNote");
                if (abstract) context += `\nAbstract: ${abstract}`;

                // Fetch content with hierarchy: All Notes + (Indexed PDF only if no same-title note)
                try {
                  const itemContent = await Assistant.getPdfTextForItem(
                    zoteroItem,
                    0,
                    true,
                    true,
                  );
                  if (itemContent) {
                    context += `\n\nContent:\n${itemContent}`;
                  }
                } catch (e) {
                  Zotero.debug(
                    `[seerai] Error fetching content for tagged item ${itemID}: ${e}`,
                  );
                }
              }
            }
          } catch (e) {
            Zotero.debug(
              `[seerai] Error fetching papers for tag "${tagName}": ${e}`,
            );
            context += `\n(Error fetching papers for this tag)`;
          }
        } else if (item.type === "collection") {
          const collectionId = item.id as number;
          const collectionName = item.displayName;
          context += `\n\n--- Collection: ${collectionName} ---`;

          // Fetch all papers in this collection and include their content
          try {
            const collection = Zotero.Collections.get(collectionId);
            if (collection) {
              const itemIDs = collection.getChildItems(true); // true = recursive

              // Filter to regular items only
              const regularItems: Zotero.Item[] = [];
              for (const id of itemIDs) {
                const zItem = Zotero.Items.get(id);
                if (zItem && zItem.isRegularItem()) {
                  regularItems.push(zItem);
                }
              }

              if (regularItems.length === 0) {
                context += `\n(No papers found in this collection)`;
              } else {
                context += `\nPapers in collection: ${regularItems.length}`;

                // Process all papers in this collection
                for (const zoteroItem of regularItems) {
                  const title = zoteroItem.getField("title");
                  context += `\n\n--- Paper: ${title} ---`;

                  const year = zoteroItem.getField("date");
                  if (year) context += ` (${year})`;

                  const creators = zoteroItem
                    .getCreators()
                    .map((c: any) => `${c.firstName} ${c.lastName}`);
                  if (creators.length > 0)
                    context += `\nAuthors: ${creators.join(", ")}`;

                  const abstract = zoteroItem.getField("abstractNote");
                  if (abstract) context += `\nAbstract: ${abstract}`;

                  // Fetch content with hierarchy: All Notes + (Indexed PDF only if no same-title note)
                  try {
                    const itemContent = await Assistant.getPdfTextForItem(
                      zoteroItem,
                      0,
                      true,
                      true,
                    );
                    if (itemContent) {
                      context += `\n\nContent:\n${itemContent}`;
                    }
                  } catch (e) {
                    Zotero.debug(
                      `[seerai] Error fetching content for collection item ${zoteroItem.id}: ${e}`,
                    );
                  }
                }
              }
            } else {
              context += `\n(Collection not found)`;
            }
          } catch (e) {
            Zotero.debug(
              `[seerai] Error fetching papers for collection "${collectionName}": ${e}`,
            );
            context += `\n(Error fetching papers for this collection)`;
          }
        } else if (item.type === "author") {
          const authorName = item.displayName;
          context += `\n\n--- Author: ${authorName} ---`;

          // Fetch all papers by this author and include their content
          try {
            const libraryID = Zotero.Libraries.userLibraryID;
            const s = new Zotero.Search({ libraryID });
            s.addCondition("creator", "contains", authorName);
            s.addCondition("itemType", "isNot", "attachment");
            s.addCondition("itemType", "isNot", "note");
            const itemIDs = await s.search();

            if (itemIDs.length === 0) {
              context += `\n(No papers found by this author)`;
            } else {
              context += `\nPapers by this author: ${itemIDs.length}`;

              // Process all papers by this author
              for (const itemID of itemIDs) {
                const zoteroItem = Zotero.Items.get(itemID);
                if (!zoteroItem || !zoteroItem.isRegularItem()) continue;

                const title = zoteroItem.getField("title");
                context += `\n\n--- Paper: ${title} ---`;

                const year = zoteroItem.getField("date");
                if (year) context += ` (${year})`;

                const creators = zoteroItem
                  .getCreators()
                  .map((c: any) => `${c.firstName} ${c.lastName}`);
                if (creators.length > 0)
                  context += `\nAuthors: ${creators.join(", ")}`;

                const abstract = zoteroItem.getField("abstractNote");
                if (abstract) context += `\nAbstract: ${abstract}`;

                // Fetch content with hierarchy: All Notes + (Indexed PDF only if no same-title note)
                try {
                  const itemContent = await Assistant.getPdfTextForItem(
                    zoteroItem,
                    0,
                    true,
                    true,
                  );
                  if (itemContent) {
                    context += `\n\nContent:\n${itemContent}`;
                  }
                } catch (e) {
                  Zotero.debug(
                    `[seerai] Error fetching content for author item ${itemID}: ${e}`,
                  );
                }
              }
            }
          } catch (e) {
            Zotero.debug(
              `[seerai] Error fetching papers for author "${authorName}": ${e}`,
            );
            context += `\n(Error fetching papers for this author)`;
          }
        } else if (item.type === "topic") {
          // Topic is a user-specified keyword/focus area
          context += `\n\nFocus Topic: "${item.displayName}" - Please consider this topic when answering.`;
        }
      }

      // Web Search Context
      let webContext = "";
      if (options.webSearchEnabled && firecrawlService.isConfigured()) {
        try {
          Zotero.debug(`[seerai] Fetching web search context for: ${text}`);
          const webResults = await firecrawlService.webSearch(
            text,
            firecrawlService.getSearchLimit(),
          );

          if (webResults.length > 0) {
            webContext = "\n\n=== Web Search Results ===";
            for (const result of webResults) {
              webContext += `\n\n--- ${result.title || "Web Page"} ---`;
              webContext += `\nSource: ${result.url}`;
              if (result.description) {
                webContext += `\n${result.description}`;
              }
              if (result.markdown) {
                // Include full web content (no limit)
                webContext += `\n${result.markdown}`;
              }
            }
            Zotero.debug(
              `[seerai] Added ${webResults.length} web results to context`,
            );
          }
        } catch (e) {
          Zotero.debug(`[seerai] Web search failed: ${e}`);
        }
      }

      const scopeLabel = this.getScopeLabel(this.getScopePref());
      const systemPrompt = `You are a helpful research assistant for Zotero. You help users understand and analyze their academic papers, notes, and research data tables.

Current Library/Folder Scope: ${scopeLabel} (Tools will only find items within this scope).

${context}${webContext}

Be concise, accurate, and helpful. When referencing papers, cite them by title or author.

Table Management:
1. To analyze papers in a structured way, use 'create_table' to start a new analysis or 'add_to_table' to add papers to an existing one.
2. Use 'create_table_column' to add AI-powered analysis columns (e.g., "Methodology", "Result Summary").
3. Use 'generate_table_data' to trigger the background analysis of those columns.
4. Always 'list_tables' first if you need to find an existing table ID. If no table is found, create one.
5. You can fall back to using 'active' or 'undefined' as a table_id if you believe a table was just created or is active, and the tools will try to find the most recent one.

Research & Paper Discovery:
1. Use 'search_external' to find new papers on Semantic Scholar.
2. Use 'import_paper' to bring a paper into Zotero. Specify 'target_collection_id' for subfolders. Set 'trigger_ocr: true' for immediate PDF text extraction.
3. Use 'find_collection' to find folders by name. If not found, use 'list_collection' to explore or 'create_collection' to make them.
4. Use 'create_collection' to create new subfolders (e.g., "reviewing" under a project folder).
5. Use 'list_collection' to browse contents of a folder (child collections and items with metadata).
6. Use 'move_item' and 'remove_item_from_collection' for organization.
7. Use 'read_item_content' with 'trigger_ocr: true' to extract text from PDFs for quantitative analysis if notes are missing.
8. Use 'create_note' with 'collection_id' for standalone notes (e.g., search strategies) inside folders.

${webContext ? " When using web search results, cite the source URL." : ""}`;


      // Merge pasted images with Zotero item images
      const manuallyPastedParts: VisionMessageContentPart[] = pastedImages.map(
        (img) => ({
          type: "image_url",
          image_url: {
            url: img.image,
            detail: "auto",
          },
        }),
      );

      // Check if we should include images (vision mode)
      let messages: (OpenAIMessage | VisionMessage)[];

      if (options.includeImages || manuallyPastedParts.length > 0) {
        // Get Zotero items for image extraction (Only from selected PAPER items)
        const zoteroItems: Zotero.Item[] = [];
        for (const item of contextItems) {
          if (item.type === "paper") {
            const zItem = Zotero.Items.get(item.id as number);
            if (zItem) zoteroItems.push(zItem);
          }
        }

        // Get image content parts from Zotero items if enabled
        let imageParts: VisionMessageContentPart[] = [];
        if (options.includeImages) {
          imageParts = await createImageContentParts(zoteroItems, 5);
        }

        // Combine with manually pasted images
        const allImageParts = [...manuallyPastedParts, ...imageParts];

        if (allImageParts.length > 0) {
          Zotero.debug(
            `[seerai] Including ${allImageParts.length} images in request (${manuallyPastedParts.length} pasted, ${imageParts.length} from papers)`,
          );

          // Build vision message content
          const visionContent: VisionMessageContentPart[] = [
            { type: "text", text: text },
            ...allImageParts,
          ];

          // Build messages array
          messages = [
            { role: "system", content: systemPrompt },
            // Include history except the LAST message (which is the current one we're building with vision)
            ...conversationMessages
              .filter((m) => m.role !== "system" && m.role !== "error")
              .slice(0, -1) // Remove the text-only version of current message
              .map((m) => ({
                role: m.role as "user" | "assistant",
                content: m.content,
              })),
            { role: "user", content: visionContent },
          ];
        } else {
          // No images found even though vision mode checked, use standard messages
          messages = [
            { role: "system", content: systemPrompt },
            ...conversationMessages
              .filter((m) => m.role !== "system" && m.role !== "error")
              .map((m) => ({
                role: m.role as "user" | "assistant",
                content: m.content,
              })),
          ];
        }
      } else {
        // Standard text-only messages
        messages = [
          { role: "system", content: systemPrompt },
          ...conversationMessages
            .filter((m) => m.role !== "system" && m.role !== "error")
            .map((m) => ({
              role: m.role as "user" | "assistant",
              content: m.content,
            })),
        ];
      }

      let fullResponse = "";

      // Get active model config for API call
      const activeModel = getActiveModelConfig();
      const configOverride = activeModel
        ? {
          apiURL: activeModel.apiURL,
          apiKey: activeModel.apiKey,
          model: activeModel.model,
        }
        : undefined;

      // Check if agentic mode is enabled
      const agenticEnabled = isAgenticModeEnabled();
      Zotero.debug(`[seerai] Agentic mode: ${agenticEnabled}`);

      if (agenticEnabled) {
        // Use agentic chat handler with tool calling
        await handleAgenticChat(
          text,
          systemPrompt,
          conversationMessages.slice(0, -1), // Exclude current user message (already in text)
          {
            enableTools: true,
            includeImages: options.includeImages || manuallyPastedParts.length > 0,
            pastedImages: pastedImages,
            permissionHandler: Assistant.handleInlinePermissionRequest,
          },
          observer
        );
      } else {
        // Standard chat without tools
        await openAIService.chatCompletionStream(
          messages,
          {
            onToken: (token) => {
              fullResponse += token;
              if (contentDiv) {
                if (isFirstToken) {
                  contentDiv.innerHTML = ""; // Clear loading indicator
                  isFirstToken = false;
                }
                contentDiv.setAttribute("data-raw", fullResponse);
                contentDiv.innerHTML = parseMarkdown(fullResponse);
                messagesArea.scrollTop = messagesArea.scrollHeight;
              }
            },
            onComplete: async (content) => {
              const assistantMsg: ChatMessage = {
                id: Date.now().toString(),
                role: "assistant",
                content: content,
                timestamp: new Date(),
              };
              conversationMessages.push(assistantMsg);

              // Persist assistant message
              try {
                await getMessageStore().appendMessage(assistantMsg);
              } catch (e) {
                Zotero.debug(`[seerai] Error saving assistant message: ${e}`);
              }

              // Final render with markdown
              if (contentDiv) {
                contentDiv.setAttribute("data-raw", content);
                contentDiv.innerHTML = parseMarkdown(content);
              }

              // Clear pasted images after successful send
              clearImages();
            },
            onError: (error) => {
              if (contentDiv) {
                contentDiv.innerHTML = `<span style="color: #c62828;">Error: ${error.message}</span>`;
              }
            },
          },
          configOverride,
        );
      }

    } catch (error) {
      const errMsg =
        error instanceof Error && error.message === "Request was cancelled"
          ? "Generation stopped"
          : String(error);
      if (contentDiv) {
        const isError =
          error instanceof Error && error.message !== "Request was cancelled";
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
    isLastUserMsg?: boolean,
    toolResults?: { toolCall: ToolCall; result?: ToolResult }[],
  ): HTMLElement {
    const doc = container.ownerDocument!;
    const isUser = sender === "You";
    const isAssistant = sender === "Assistant";

    const msgDiv = ztoolkit.UI.createElement(doc, "div", {
      properties: {
        className: `message-bubble ${isUser ? "message-user" : "message-assistant"}`,
      },
      attributes: { "data-msg-id": msgId || "" },
      styles: {
        padding: "12px 16px",
        borderRadius: isUser ? "12px 12px 4px 12px" : "12px 12px 12px 4px",
        fontSize: "13px",
        maxWidth: "90%",
        minHeight: "auto",
        alignSelf: isUser ? "flex-end" : "flex-start",
        flexShrink: "0", // Prevent bubble from shrinking in flex container
        boxShadow: "0 1px 3px rgba(0,0,0,0.12)",
        position: "relative",
        backgroundColor: isUser ? "var(--accent-blue, #1976d2)" : "var(--background-secondary, #f5f5f5)",
        color: isUser ? "#ffffff" : "var(--text-primary, #212121)",
        border: isUser ? "none" : "1px solid var(--border-primary, #e0e0e0)",
      },
    });

    // Header with sender and actions
    const headerDiv = ztoolkit.UI.createElement(doc, "div", {
      styles: {
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        marginBottom: "4px",
      },
    });

    const senderDiv = ztoolkit.UI.createElement(doc, "span", {
      styles: { fontWeight: "600", fontSize: "11px", opacity: "0.8" },
      properties: { innerText: sender },
    });

    // Action buttons container
    const actionsDiv = ztoolkit.UI.createElement(doc, "div", {
      styles: {
        display: "flex",
        gap: "4px",
        opacity: "0.6",
      },
    });

    // Copy button (for all messages) with Smart Copy logic
    let clickTimeout: ReturnType<typeof setTimeout> | null = null;

    // We create the button first, then assign the logic to use the variable reference
    // Use a temp handler that delegators to the logic defined below
    const copyBtn = this.createActionButton(doc, "📋", "Click: Copy Text\nDouble-Click: Copy + Logs", () => {
      // Get the current text from data-raw attribute (for streaming messages)
      // or from the markdown container's data-raw, or fallback to initial text
      const msgBubble = (copyBtn as HTMLElement).closest('.message-bubble');
      const contentEl = msgBubble?.querySelector('[data-content]');
      const mdContainer = contentEl?.querySelector('.markdown-content');
      const currentText = mdContainer?.getAttribute('data-raw')
        || contentEl?.getAttribute('data-raw')
        || text;

      if (clickTimeout) {
        // Double click: Clear timer and copy all
        clearTimeout(clickTimeout);
        clickTimeout = null;

        let copyText = currentText;
        if (toolResults && toolResults.length > 0) {
          const toolLogs = toolResults.map(tr => {
            const args = tr.toolCall.function.arguments;
            const result = tr.result ? JSON.stringify(tr.result, null, 2) : "No result";
            return `[Tool: ${tr.toolCall.function.name}]\nInput: ${args}\nOutput: ${result}`;
          }).join("\n\n");
          copyText = `${currentText}\n\n--- Tool Executions ---\n${toolLogs}`;
        }
        this.copyToClipboard(copyText, copyBtn as HTMLElement);
      } else {
        // First click: Set timer
        clickTimeout = setTimeout(() => {
          this.copyToClipboard(currentText, copyBtn as HTMLElement);
          clickTimeout = null;
        }, 250);
      }
    });



    actionsDiv.appendChild(copyBtn);

    // Edit button (only for last user message)
    if (isUser && isLastUserMsg) {
      const editBtn = this.createActionButton(doc, "✏️", "Edit", () => {
        this.handleEditMessage(container, msgDiv as HTMLElement, msgId || "");
      });
      actionsDiv.appendChild(editBtn);
    }

    headerDiv.appendChild(senderDiv);
    headerDiv.appendChild(actionsDiv);

    const contentDiv = ztoolkit.UI.createElement(doc, "div", {
      attributes: { "data-content": "true", "data-raw": text },
      styles: { lineHeight: "1.6" }, // Increased line height
    });
    // Parse markdown to HTML for rendering
    contentDiv.innerHTML = parseMarkdown(text);

    // Bind copy button events for code blocks
    const copyBtns = contentDiv.querySelectorAll(".code-copy-btn");
    copyBtns.forEach((btn: Element) => {
      btn.addEventListener("click", () => {
        const codeId = btn.getAttribute("data-code-id");
        const codeEl = contentDiv.querySelector(`#${codeId}`);
        if (codeEl) {
          const codeText = codeEl.textContent || "";
          this.copyToClipboard(codeText, btn as HTMLElement);
        }
      });
    });

    msgDiv.appendChild(headerDiv);
    msgDiv.appendChild(contentDiv);

    // Render persisted tool executions
    if (toolResults && toolResults.length > 0) {
      const { container, setCompleted } = createToolProcessUI(doc);
      container.style.marginTop = "8px";

      const listContainer = container.querySelector(".tool-list-container");
      const targetContainer = listContainer || container;

      toolResults.forEach(tr => {
        const toolUI = createToolExecutionUI(doc, tr.toolCall, tr.result);
        targetContainer.appendChild(toolUI);
      });

      // Set state to completed
      setCompleted(toolResults.length);

      msgDiv.appendChild(container);
    }

    container.appendChild(msgDiv);
    container.scrollTop = container.scrollHeight;

    return msgDiv;
  }

  /**
   * Create an action button with tooltip
   */
  private static createActionButton(
    doc: Document,
    icon: string,
    tooltip: string,
    onClick: () => void,
  ): HTMLElement {
    const btn = ztoolkit.UI.createElement(doc, "span", {
      properties: { innerText: icon, title: tooltip },
      styles: {
        cursor: "pointer",
        fontSize: "12px",
        padding: "2px 4px",
        borderRadius: "4px",
        transition: "background-color 0.1s",
      },
      listeners: [
        {
          type: "click",
          listener: (e: Event) => {
            e.stopPropagation();
            onClick();
          },
        },
        {
          type: "mouseenter",
          listener: () => {
            (btn as HTMLElement).style.backgroundColor = "rgba(0,0,0,0.1)";
            (btn as HTMLElement).style.opacity = "1";
          },
        },
        {
          type: "mouseleave",
          listener: () => {
            (btn as HTMLElement).style.backgroundColor = "transparent";
            (btn as HTMLElement).style.opacity = "0.6";
          },
        },
      ],
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
      new ztoolkit.Clipboard().addText(text, "text/unicode").copy();

      // Visual feedback - success
      buttonElement.innerText = "✓";
      setTimeout(() => {
        buttonElement.innerText = originalText;
      }, 1500);

      Zotero.debug("[seerai] Copied message to clipboard");
    } catch (e) {
      Zotero.debug(`[seerai] ztoolkit.Clipboard failed: ${e}`);
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
  private static handleEditMessage(
    container: HTMLElement,
    msgDiv: HTMLElement,
    msgId: string,
  ) {
    const contentDiv = msgDiv.querySelector("[data-content]") as HTMLElement;
    if (!contentDiv) return;

    const originalText = contentDiv.innerText;
    const doc = container.ownerDocument!;

    // Replace content with input
    const inputContainer = ztoolkit.UI.createElement(doc, "div", {
      styles: { display: "flex", gap: "4px", marginTop: "4px" },
    });

    const input = ztoolkit.UI.createElement(doc, "input", {
      attributes: { type: "text", value: originalText },
      styles: {
        flex: "1",
        padding: "6px 10px",
        border: "1px solid #1976d2",
        borderRadius: "4px",
        fontSize: "13px",
      },
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
        fontSize: "12px",
      },
      listeners: [
        {
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
          },
        },
      ],
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
        fontSize: "12px",
      },
      listeners: [
        {
          type: "click",
          listener: () => {
            contentDiv.style.display = "block";
            inputContainer.remove();
          },
        },
      ],
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
  private static submitEditedMessage(
    container: HTMLElement,
    msgId: string,
    newText: string,
  ) {
    // Find the message index
    const msgIndex = conversationMessages.findIndex((m) => m.id === msgId);
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
   * Re-render the chat area with current messages
   */
  private static rerenderChat(container: HTMLElement) {
    const messagesArea = container.querySelector(
      "#assistant-messages-area",
    ) as HTMLElement;
    if (!messagesArea) return;

    messagesArea.innerHTML = "";

    const lastUserMsgIndex = conversationMessages
      .map((m) => m.role)
      .lastIndexOf("user");

    conversationMessages.forEach((msg, idx) => {
      const isUser = msg.role === "user";
      const sender = isUser
        ? "You"
        : msg.role === "error"
          ? "Error"
          : "Assistant";
      const isLastUserMsg = isUser && idx === lastUserMsgIndex;

      this.appendMessage(
        messagesArea,
        sender,
        msg.content,
        msg.id,
        isLastUserMsg,
      );
    });
  }

  /**
   * Regenerate the last response based on the last user message
   */
  private static async regenerateLastResponse(container: HTMLElement) {
    const messagesArea = container.querySelector(
      "#assistant-messages-area",
    ) as HTMLElement;
    if (!messagesArea) return;

    const stateManager = getChatStateManager();
    const input = container.querySelector(
      "input[type='text']",
    ) as HTMLInputElement;

    if (input) input.disabled = true;
    this.isStreaming = true;

    const stopBtn = container.ownerDocument?.getElementById(
      "stop-btn",
    ) as HTMLElement;
    if (stopBtn) stopBtn.style.display = "inline-block";

    // Create streaming message placeholder
    const streamingDiv = this.appendMessage(messagesArea, "Assistant", "");
    const contentDiv = streamingDiv.querySelector(
      "[data-content]",
    ) as HTMLElement;

    try {
      const states = stateManager.getStates();
      let context = "=== Selected Papers ===\n";

      for (const item of states.items) {
        context += `\n--- ${item.title} ---`;
        if (item.year) context += ` (${item.year})`;
        if (item.creators && item.creators.length > 0) {
          context += `\nAuthors: ${item.creators.join(", ")}`;
        }
        if (item.abstract) {
          context += `\nAbstract: ${item.abstract}`;
        }

        // Fetch PDF/note content for this item
        try {
          const zoteroItem = Zotero.Items.get(item.id);
          if (zoteroItem && zoteroItem.isRegularItem()) {
            const itemContent = await Assistant.getPdfTextForItem(
              zoteroItem,
              0,
              true,
              true,
            );
            if (itemContent) {
              context += `\n\nContent:\n${itemContent}`;
            }
          }
        } catch (e) {
          Zotero.debug(
            `[seerai] Error fetching content for item ${item.id}: ${e}`,
          );
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
          context += `\nColumns: ${table.columnNames.join(", ")}`;
          context += `\n${table.content}`;
        }
      }

      const systemPrompt = `You are a helpful research assistant for Zotero. You help users understand and analyze their academic papers, notes, and research data tables.

${context}

Be concise, accurate, and helpful. When referencing papers, cite them by title or author. When referencing table data, cite the table name and relevant columns.`;

      const messages: OpenAIMessage[] = [
        { role: "system", content: systemPrompt },
        ...conversationMessages
          .filter((m) => m.role !== "system" && m.role !== "error")
          .map((m) => ({
            role: m.role as "user" | "assistant",
            content: m.content,
          })),
      ];

      let fullResponse = "";

      // Get active model config for API call
      const activeModel = getActiveModelConfig();
      const configOverride = activeModel
        ? {
          apiURL: activeModel.apiURL,
          apiKey: activeModel.apiKey,
          model: activeModel.model,
        }
        : undefined;

      await openAIService.chatCompletionStream(
        messages,
        {
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
              role: "assistant",
              content: content,
              timestamp: new Date(),
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
          },
        },
        configOverride,
      );
    } catch (error) {
      const errMsg =
        error instanceof Error && error.message === "Request was cancelled"
          ? "Generation stopped"
          : String(error);
      if (contentDiv) {
        const isError =
          error instanceof Error && error.message !== "Request was cancelled";
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
  private static renderStoredMessage(
    container: HTMLElement,
    msg: ChatMessage,
    isLastUserMsg: boolean = false,
  ) {
    const isUser = msg.role === "user";
    const sender = isUser
      ? "You"
      : msg.role === "error"
        ? "Error"
        : "Assistant";
    this.appendMessage(container, sender, msg.content, msg.id, isLastUserMsg, msg.toolResults);
  }

  /**
   * Save current conversation as a Zotero note
   */
  private static async saveConversationAsNote() {
    if (conversationMessages.length === 0) {
      Zotero.debug("[seerai] No messages to save");
      return;
    }

    const stateManager = getChatStateManager();
    const states = stateManager.getStates();

    const parentItem = states.items[0];
    if (!parentItem) {
      Zotero.debug("[seerai] No items to attach note to");
      return;
    }

    let noteContent = `<h2>AI Chat Conversation</h2>`;
    noteContent += `<p><em>Saved: ${new Date().toLocaleString()}</em></p>`;
    noteContent += `<p><strong>Context:</strong> ${stateManager.getSummary()}</p><hr/>`;

    for (const msg of conversationMessages) {
      const role = msg.role === "user" ? "🧑 You" : "🤖 Assistant";
      noteContent += `<p><strong>${role}:</strong></p>`;
      noteContent += `<p>${msg.content.replace(/\n/g, "<br/>")}</p>`;
      noteContent += `<hr/>`;
    }

    try {
      const zoteroItem = Zotero.Items.get(parentItem.id);
      const note = new Zotero.Item("note");
      note.setNote(noteContent);
      note.parentID = zoteroItem.id;
      await note.saveTx();
      Zotero.debug("[seerai] Conversation saved as note");
    } catch (error) {
      Zotero.debug(`[seerai] Failed to save note: ${error}`);
    }
  }

  /**
   * Check if an item is in the current table
   */
  static isItemInCurrentTable(itemId: number): boolean {
    return currentTableConfig?.addedPaperIds.includes(itemId) || false;
  }

  /**
   * Add items to the currently active table (if any)
   */
  static async addItemsToCurrentTable(items: Zotero.Item[]): Promise<void> {
    if (!currentTableConfig) {
      new ztoolkit.ProgressWindow("DataLab")
        .createLine({
          text: "No active table found. Please open the Assistant Table tab first.",
          progress: 100,
          icon: "warning",
        })
        .show();
      return;
    }

    const newIds = items
      .filter((item) => item.isRegularItem())
      .map((item) => item.id)
      .filter((id) => !currentTableConfig!.addedPaperIds.includes(id));

    if (newIds.length === 0) {
      new ztoolkit.ProgressWindow("DataLab")
        .createLine({
          text: "Selected items are already in the table.",
          progress: 100,
        })
        .show();
      return;
    }

    currentTableConfig.addedPaperIds.push(...newIds);
    const tableStore = getTableStore();
    await tableStore.saveConfig(currentTableConfig);

    // Refresh if visible
    if (activeTab === "table" && currentContainer && currentItem) {
      this.renderInterface(currentContainer, currentItem);
    }

    new ztoolkit.ProgressWindow("DataLab")
      .createLine({
        text: `Added ${newIds.length} items to table`,
        progress: 100,
      })
      .show();
  }

  /**
   * Remove items from the currently active table (if present)
   */
  static async removeItemsFromCurrentTable(
    items: Zotero.Item[],
  ): Promise<void> {
    if (!currentTableConfig) return;

    const idsToRemove = items.map((item) => item.id);
    const initialLength = currentTableConfig.addedPaperIds.length;

    currentTableConfig.addedPaperIds = currentTableConfig.addedPaperIds.filter(
      (id) => !idsToRemove.includes(id),
    );

    if (currentTableConfig.addedPaperIds.length === initialLength) {
      new ztoolkit.ProgressWindow("DataLab")
        .createLine({
          text: "Selected items are not in the table.",
          progress: 100,
        })
        .show();
      return;
    }

    // Cleanup generated data
    idsToRemove.forEach((id) => {
      if (currentTableConfig!.generatedData?.[id]) {
        delete currentTableConfig!.generatedData![id];
      }
    });

    const tableStore = getTableStore();
    await tableStore.saveConfig(currentTableConfig);

    // Refresh if visible
    if (activeTab === "table" && currentContainer && currentItem) {
      this.renderInterface(currentContainer, currentItem);
    }

    new ztoolkit.ProgressWindow("DataLab")
      .createLine({
        text: `Removed items from table`,
        progress: 100,
      })
      .show();
  }
}
