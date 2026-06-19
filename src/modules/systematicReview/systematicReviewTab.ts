/**
 * Systematic Review Tab — main orchestrator
 *
 * Left sidebar nav: Screening, Evidence Synthesis, Gap Analysis, PRISMA
 * Each opens a panel in the main content area.
 */

import {
  SystematicReviewState,
  SRSubTab,
  SystematicReviewPaper,
  SystematicReviewSpace,
  FRAMEWORK_DEFS,
  EXCL_REASONS,
  LabelDefinition,
  EvidenceDomain,
  GapDetail,
  ScreeningDecision,
  ExtractionRow,
  ExtractionTemplate,
  RoBAssessment,
  ProtocolRevision,
  SRFolderConfig,
  ZoteroCollectionTreeNode,
  ProtocolGenerationResult,
  ProtocolGenerationStep,
} from "./types";
import { getSRStore } from "./store";
import { getSRService } from "./service";
import {
  fixedEffectMetaAnalysis,
  getPrismaSnapshot,
  validateExtractionRow,
} from "./scientific";
import { calculateKeywordConfidence } from "./modelOutput";
import {
  ICONS,
  createSvgIcon,
  createSvgButton,
  generateSourceLabel,
} from "./utils";
import {
  extractDocumentContent,
  analyzeDocuments,
  AnalysisProgress,
  ExtractedDocument,
} from "./documentAnalyzer";
import { ChatContextManager } from "../chat/context/contextManager";
import {
  dimensionsForFramework,
  getActiveProtocolRevision,
  newEligibilityRule,
  validateProtocolRevision,
} from "./protocol";
import {
  applyProtocolPreset,
  deleteProtocolPreset,
  importProtocolPreset,
  loadProtocolPresets,
  parseProtocolPresetJson,
  protocolPresetToJson,
  ProtocolPreset,
  revisionToProtocolPreset,
  saveProtocolPreset,
} from "./protocolPresets";
import {
  collectSourceRecords,
  discoverZoteroCollectionTree,
  sourceConfigFromCollection,
} from "./sources";
import {
  collectPaperExtractionLog,
  getIncludedPapers,
  getPapersNeedingExtraction,
  getPapersWithFailedExtractions,
  hasFailedExtractionMetrics,
} from "./extractionHealth";
import {
  findSameTitleNoteAbstract,
  resolveItemAbstract,
} from "./reviewSourceService";
import { ReviewCancellationController } from "./cancellation";

const HTML_NS = "http://www.w3.org/1999/xhtml";
const SVG_NS = "http://www.w3.org/2000/svg";
const SR_SIDEBAR_MIN_WIDTH = 160;
const SR_SIDEBAR_COLLAPSED_WIDTH = 30;
const SR_SIDEBAR_MAX_WIDTH = 500;
const SR_AUTO_COLLAPSE_THRESHOLD = 480;
const SR_FILTERS_AUTO_COLLAPSE_THRESHOLD = 400;
const SR_ARTICLE_LIST_AUTO_COLLAPSE_THRESHOLD = 320;
const SR_RESERVED_FOR_CONTENT = 360;

function appendToBody(doc: Document, el: HTMLElement): void {
  const target = doc.body || doc.documentElement;
  if (target) target.appendChild(el);
}

function mountReviewSheet(doc: Document, wrapper: HTMLElement): void {
  wrapper.setAttribute("data-review-sheet", "true");
  const host =
    mainWrapper && mainWrapper.isConnected
      ? mainWrapper
      : (doc.querySelector(".sr-shell") as HTMLElement | null);
  if (!host) {
    appendToBody(doc, wrapper);
    return;
  }
  host.style.position = "relative";
  wrapper.style.position = "absolute";
  wrapper.style.inset = "0";
  wrapper.style.width = "auto";
  wrapper.style.height = "auto";
  wrapper.style.padding = "0";
  wrapper.style.alignItems = "stretch";
  wrapper.style.justifyContent = "stretch";
  wrapper.style.background = "var(--background-primary)";
  wrapper.style.zIndex = "100";
  wrapper.style.overflow = "hidden";
  const surface = wrapper.firstElementChild as HTMLElement | null;
  if (surface) {
    surface.style.width = "100%";
    surface.style.maxWidth = "none";
    surface.style.height = "100%";
    surface.style.maxHeight = "none";
    surface.style.minHeight = "0";
    surface.style.borderRadius = "0";
    surface.style.boxShadow = "none";
  }
  host.appendChild(wrapper);
}

let currentState: SystematicReviewState | null = null;
let mainWrapper: HTMLElement | null = null;
let sideNav: HTMLElement | null = null;
let contentArea: HTMLElement | null = null;
let _stateLoaded = false;
const _srPaperIdSet: Set<number> = new Set();

// ============================================================
// SIDEBAR NAV ITEMS
// ============================================================
const NAV_ITEMS: {
  id: SRSubTab;
  label: string;
  iconSvg: string;
  badge?: string;
  badgeClass?: string;
}[] = [
  { id: "screening", label: "Screening & Triage", iconSvg: "screening" },
  { id: "evidence", label: "Evidence Synthesis", iconSvg: "evidence" },
  { id: "gaps", label: "Gap Analysis", iconSvg: "gaps" },
  { id: "prisma", label: "PRISMA Diagram", iconSvg: "prisma" },
];

// ============================================================
// MAIN EXPORT
// ============================================================
let scrActive: number | null = null;
const scrSelected: Set<number> = new Set();
const undoStack: {
  id: number;
  prevStatus: ScreeningDecision;
  prevReason?: string;
  prevStage?: "title_abstract" | "full_text" | "final";
}[] = [];
let quickSkip = false;
let showNote = false;
let showReason = false;
let showLabelRow = false;
let showSourceLabelRow = false;
let kwFilterActive = false;
let kwFilterKeyword: string | null = null;
let evTab: "overview" | "ai" = "overview";
let xlMode = false;
const xlQuery: string[] = [];
let evSelectedLabel: string | null = null;
let gapSeverityFilter = "all";
let activeEligibilityType: "include" | "exclude" = "include";
let articleListScrollTop = 0;
let articleDetailScrollTop = 0;
let showPaperCriteria = false;
const filterEnabled: Set<string> = new Set();
const activeFilters: Record<string, Set<string>> = {};
const filterOpen: Set<string> = new Set([
  "includeKeywords",
  "excludeKeywords",
  "labels",
]);
let currentPanel: SRSubTab = "screening";
let picoLabelMap: Record<string, string[]> = {};
let sidebarCollapsed = false;
let sidebarAutoCollapsed = false;
let sidebarUserTouched = false;
let filtersCollapsed = false;
let filtersAutoCollapsed = false;
let filtersUserTouched = false;
let articleListAutoCollapsed = false;
let articleListUserTouched = false;
let reviewSidebarWidth = 210;
let reviewArticleListWidth = 260;
let reviewFiltersWidth = 200;
let articleListCollapsed = false;
let refreshReviewLayout: (() => void) | null = null;
let lastReviewLayoutWidth = 0;
let reviewLayoutRafPending = false;

interface ItemMeta {
  id: number;
  title: string;
  abstract: string;
  abstractSource: "field" | "same_title_note" | "pdf" | "notes" | "none";
  abstractNoteIds: number[];
  abstractAttachmentId?: number;
  abstractPending: boolean;
  abstractFallback?: boolean;
  year: string;
  authors: string;
  journal: string;
  doi: string;
  itemType: string;
  creators: any[];
}
const itemMetaCache: Map<number, ItemMeta> = new Map();
const itemAbstractInflight: Map<number, Promise<void>> = new Map();

function cacheItemMeta(id: number): ItemMeta {
  let m = itemMetaCache.get(id);
  if (m) return m;
  const zItem = Zotero.Items.get(id);
  const creators = zItem ? zItem.getCreators() : [];
  const fieldAbstract =
    (zItem ? (zItem.getField("abstractNote") as string) : "") || "";
  let abstract = fieldAbstract;
  let abstractSource: ItemMeta["abstractSource"] = fieldAbstract
    ? "field"
    : "none";
  let abstractNoteIds: number[] = [];
  let abstractAttachmentId: number | undefined;
  let abstractPending = false;
  if (!abstract && zItem) {
    const noteHit = findSameTitleNoteAbstract(zItem);
    if (noteHit.matched) {
      abstract = noteHit.text;
      abstractSource = "same_title_note";
      abstractNoteIds = noteHit.noteIds;
    }
  }
  if (!abstract && zItem) {
    const attachmentIds = zItem.getAttachments();
    for (const attId of attachmentIds) {
      const att = Zotero.Items.get(attId);
      if (att && att.attachmentContentType === "application/pdf") {
        abstractAttachmentId = attId;
        abstractPending = true;
        break;
      }
    }
  }
  m = {
    id,
    title: (zItem ? (zItem.getField("title") as string) : "") || "",
    abstract,
    abstractSource,
    abstractNoteIds,
    abstractAttachmentId,
    abstractPending,
    year: (zItem ? (zItem.getField("year") as string) : "") || "",
    authors: creators
      .map((c: any) => c.lastName || c.name || "")
      .filter(Boolean)
      .join(", "),
    journal:
      (zItem ? (zItem.getField("publicationTitle") as string) : "") || "",
    doi: (zItem ? (zItem.getField("DOI") as string) : "") || "",
    itemType: (zItem ? (zItem.getField("type") as string) : "") || "",
    creators,
  };
  itemMetaCache.set(id, m);
  return m;
}

function getItemMeta(id: number): ItemMeta {
  return itemMetaCache.get(id) || cacheItemMeta(id);
}

function applyAbstractResolution(
  id: number,
  resolution: {
    text: string;
    kind: ItemMeta["abstractSource"];
    noteIds: number[];
    attachmentId?: number;
    fallback?: boolean;
  },
): boolean {
  const m = itemMetaCache.get(id);
  if (!m) return false;
  if (resolution.text && resolution.kind !== "none") {
    m.abstract = resolution.text;
    m.abstractSource = resolution.kind;
    m.abstractNoteIds = resolution.noteIds;
    m.abstractAttachmentId = resolution.attachmentId;
    m.abstractPending = false;
    m.abstractFallback = resolution.fallback;
    return true;
  }
  m.abstractPending = false;
  return false;
}

async function enrichItemAbstractFromPdf(id: number): Promise<void> {
  if (itemAbstractInflight.has(id)) {
    return itemAbstractInflight.get(id);
  }
  const promise = (async () => {
    const m = itemMetaCache.get(id);
    if (!m) return;
    if (!m.abstractPending) return;
    const zItem = Zotero.Items.get(id);
    if (!zItem) return;
    const controller = new ReviewCancellationController();
    try {
      const resolution = await resolveItemAbstract(zItem, controller.signal);
      if (controller.signal.aborted) return;
      const changed = applyAbstractResolution(id, resolution);
      if (changed) {
        notifyAbstractResolved(id);
      }
    } catch (err) {
      Zotero.debug(
        `[seerai] review tab: abstract fallback failed for ${id}: ${err}`,
      );
      const cached = itemMetaCache.get(id);
      if (cached) cached.abstractPending = false;
    } finally {
      itemAbstractInflight.delete(id);
    }
  })();
  itemAbstractInflight.set(id, promise);
  return promise;
}

function warmItemAbstracts(ids: number[]): void {
  for (const id of ids) {
    if (!itemMetaCache.has(id)) cacheItemMeta(id);
    const m = itemMetaCache.get(id);
    if (m?.abstractPending && !itemAbstractInflight.has(id)) {
      enrichItemAbstractFromPdf(id).catch(() => undefined);
    }
  }
}

function getPaperSources(
  paperId: number,
  state: SystematicReviewState = currentState!,
): SRFolderConfig[] {
  if (!state) return [];
  const sourceIds = new Set(
    state.sourceOccurrences
      .filter((occurrence) => occurrence.paperId === paperId)
      .map((occurrence) => occurrence.sourceId),
  );
  return state.folders.filter((folder) => sourceIds.has(folder.id));
}

function getSourceOccurrenceCount(
  state: SystematicReviewState,
  sourceId: string,
): number {
  return new Set(
    state.sourceOccurrences
      .filter((occurrence) => occurrence.sourceId === sourceId)
      .map((occurrence) => occurrence.paperId),
  ).size;
}

function warmItemCache(ids: number[]): void {
  for (const id of ids) {
    if (!itemMetaCache.has(id)) cacheItemMeta(id);
  }
  warmItemAbstracts(ids);
}

type AbstractListener = (id: number) => void;
const abstractListeners: Set<AbstractListener> = new Set();

function onAbstractResolved(listener: AbstractListener): () => void {
  abstractListeners.add(listener);
  return () => abstractListeners.delete(listener);
}

function notifyAbstractResolved(id: number): void {
  for (const listener of abstractListeners) {
    try {
      listener(id);
    } catch (err) {
      Zotero.debug(`[seerai] review tab abstract listener error: ${err}`);
    }
  }
}

function invalidateItemCache(id?: number): void {
  if (id !== undefined) {
    itemMetaCache.delete(id);
  } else {
    itemMetaCache.clear();
  }
}

function selectItemInZotero(itemId: number): void {
  try {
    const tabs = ztoolkit.getGlobal("Zotero_Tabs");
    if (tabs && typeof tabs.select === "function") {
      tabs.select("zotero-pane");
    }
  } catch {
    // ignore
  }
  try {
    const zp = ztoolkit.getGlobal("ZoteroPane");
    if (zp && typeof zp.selectItem === "function") {
      zp.selectItem(itemId);
      return;
    }
  } catch {
    // ignore
  }
  const zp2 = Zotero.getActiveZoteroPane();
  if (zp2) zp2.selectItem(itemId);
}

const labelHierarchy: Record<string, { labels: string[] }> = {
  "Study Design": {
    labels: ["rct", "meta", "cohort", "review", "guideline", "ml"],
  },
  Outcome: { labels: ["biomarker", "genetic", "follow"] },
  Role: { labels: ["core"] },
};

function syncModuleVarsFromState(): void {
  if (!currentState) return;
  const space = getActiveSpace();
  if (space?.picoLabelMap) {
    picoLabelMap = { ...space.picoLabelMap };
  }
  kwFilterActive = currentState.kwFilterActive;
  kwFilterKeyword = currentState.kwFilterKeyword;
  quickSkip = currentState.quickSkip;
  const ui = currentState.srUIState;
  gapSeverityFilter = ui.gapSeverityFilter || "all";
  filterEnabled.clear();
  (ui.filterEnabled || []).forEach((x: string) => filterEnabled.add(x));
  filterOpen.clear();
  (ui.filterOpen || []).forEach((x: string) => filterOpen.add(x));
  Object.keys(activeFilters).forEach((k) => delete activeFilters[k]);
  Object.entries(ui.activeFilters || {}).forEach(([k, v]) => {
    activeFilters[k] = new Set(v);
  });
}

function persistFilterUIState(): void {
  if (!currentState) return;
  currentState.kwFilterActive = kwFilterActive;
  currentState.kwFilterKeyword = kwFilterKeyword;
  currentState.quickSkip = quickSkip;
  currentState.srUIState = {
    filterEnabled: Array.from(filterEnabled),
    filterOpen: Array.from(filterOpen),
    activeFilters: Object.fromEntries(
      Object.entries(activeFilters).map(([k, v]) => [k, Array.from(v)]),
    ),
    gapSeverityFilter: gapSeverityFilter as "all" | "high" | "medium" | "low",
  };
}

function saveSRState(): void {
  if (!currentState) return;
  persistFilterUIState();
  getSRService().save(currentState);
}
interface ResponsiveSizes {
  autoCollapseSidebar: boolean;
  autoCollapseFilters: boolean;
  autoCollapseArticleList: boolean;
  sidebarWidth: number;
  sidebarMinWidth: number;
  articleListWidth: number;
  articleListMinWidth: number;
  filtersWidth: number;
  filtersMinWidth: number;
}

function computeResponsiveSizes(outerWidth: number): ResponsiveSizes {
  const autoCollapseSidebar =
    !sidebarCollapsed &&
    !sidebarUserTouched &&
    outerWidth < SR_AUTO_COLLAPSE_THRESHOLD;
  const effectiveCollapsed = sidebarCollapsed || autoCollapseSidebar;

  let sidebarWidth: number;
  let sidebarMinWidth: number;
  if (effectiveCollapsed) {
    sidebarWidth = SR_SIDEBAR_COLLAPSED_WIDTH;
    sidebarMinWidth = SR_SIDEBAR_COLLAPSED_WIDTH;
  } else {
    sidebarWidth = Math.max(
      SR_SIDEBAR_MIN_WIDTH,
      Math.min(reviewSidebarWidth, outerWidth - SR_RESERVED_FOR_CONTENT),
    );
    sidebarMinWidth = SR_SIDEBAR_MIN_WIDTH;
  }

  const contentWidth = Math.max(0, outerWidth - sidebarWidth - 5);
  const autoCollapseFilters =
    !filtersCollapsed &&
    !filtersUserTouched &&
    contentWidth < SR_FILTERS_AUTO_COLLAPSE_THRESHOLD;
  const effectiveFiltersCollapsed = filtersCollapsed || autoCollapseFilters;

  const autoCollapseArticleList =
    !articleListCollapsed &&
    !articleListUserTouched &&
    contentWidth < SR_ARTICLE_LIST_AUTO_COLLAPSE_THRESHOLD;
  const effectiveArticleListCollapsed =
    articleListCollapsed || autoCollapseArticleList;

  const detailMinimum = contentWidth < 560 ? 120 : 260;
  const listMinimum = contentWidth < 400 ? 60 : contentWidth < 560 ? 84 : 100;
  const filterMinimum = contentWidth < 400 ? 60 : 80;
  const articleListCollapsedWidth = 32;
  const filterCollapsedWidth = 30;
  const filterRequested = effectiveFiltersCollapsed
    ? filterCollapsedWidth
    : reviewFiltersWidth;
  const listRequested = effectiveArticleListCollapsed
    ? articleListCollapsedWidth
    : reviewArticleListWidth;
  const sideBudget = Math.max(
    (effectiveArticleListCollapsed ? articleListCollapsedWidth : listMinimum) +
      (effectiveFiltersCollapsed ? filterCollapsedWidth : filterMinimum),
    contentWidth - detailMinimum - 8,
  );
  let responsiveListWidth = listRequested;
  let responsiveFilterWidth = filterRequested;
  const requestedTotal = responsiveListWidth + responsiveFilterWidth;
  if (requestedTotal > sideBudget && requestedTotal > 0) {
    const reducibleList = Math.max(
      0,
      responsiveListWidth -
        (effectiveArticleListCollapsed
          ? articleListCollapsedWidth
          : listMinimum),
    );
    const reducibleFilter = Math.max(
      0,
      responsiveFilterWidth -
        (effectiveFiltersCollapsed ? filterCollapsedWidth : filterMinimum),
    );
    const reducibleTotal = reducibleList + reducibleFilter;
    const reduction = requestedTotal - sideBudget;
    if (reducibleTotal > 0) {
      responsiveListWidth -= reduction * (reducibleList / reducibleTotal);
      responsiveFilterWidth -= reduction * (reducibleFilter / reducibleTotal);
    }
  }
  responsiveListWidth = Math.max(
    effectiveArticleListCollapsed ? articleListCollapsedWidth : listMinimum,
    responsiveListWidth,
  );
  responsiveFilterWidth = Math.max(
    effectiveFiltersCollapsed ? filterCollapsedWidth : filterMinimum,
    responsiveFilterWidth,
  );

  return {
    autoCollapseSidebar,
    autoCollapseFilters,
    autoCollapseArticleList,
    sidebarWidth,
    sidebarMinWidth,
    articleListWidth: responsiveListWidth,
    articleListMinWidth: effectiveArticleListCollapsed
      ? articleListCollapsedWidth
      : listMinimum,
    filtersWidth: responsiveFilterWidth,
    filtersMinWidth: effectiveFiltersCollapsed
      ? filterCollapsedWidth
      : filterMinimum,
  };
}

export async function createSystematicReviewTabContent(
  doc: Document,
  _item?: Zotero.Item,
): Promise<HTMLElement> {
  const store = getSRStore();
  currentState = await store.loadState();
  _stateLoaded = true;
  _srPaperIdSet.clear();
  currentState.papers.forEach((p) => _srPaperIdSet.add(p.id));
  syncModuleVarsFromState();
  showPaperCriteria =
    Zotero.Prefs.get("extensions.zotero.seerai.srShowPaperCriteria") === true;
  sidebarCollapsed =
    Zotero.Prefs.get("extensions.zotero.seerai.srSidebarCollapsed") === true;
  filtersCollapsed =
    Zotero.Prefs.get("extensions.zotero.seerai.srFiltersCollapsed") === true;
  reviewSidebarWidth =
    parseInt(
      String(
        Zotero.Prefs.get("extensions.zotero.seerai.srSidebarWidth") || "210",
      ),
      10,
    ) || 210;
  reviewArticleListWidth =
    parseInt(
      String(
        Zotero.Prefs.get("extensions.zotero.seerai.srArticleListWidth") ||
          "260",
      ),
      10,
    ) || 260;
  reviewFiltersWidth =
    parseInt(
      String(
        Zotero.Prefs.get("extensions.zotero.seerai.srFiltersWidth") || "200",
      ),
      10,
    ) || 200;
  articleListCollapsed =
    Zotero.Prefs.get("extensions.zotero.seerai.srArticleListCollapsed") ===
    true;
  loadSpace(doc);
  invalidateItemCache();
  warmItemCache(currentState.papers.map((p) => p.id));

  mainWrapper = doc.createElement("div");
  mainWrapper.className = "sr-shell";
  mainWrapper.style.cssText =
    "position:relative;display:flex;flex-direction:column;height:100%;width:100%;min-width:0;max-width:100%;overflow:hidden;box-sizing:border-box;font-family:system-ui,-apple-system,sans-serif;font-size:12px;color:var(--text-primary);";

  mainWrapper.setAttribute("tabindex", "0");

  // === FOLDER BAR ===
  mainWrapper.appendChild(buildFolderBar(doc));

  // === PICO SUMMARY ===
  mainWrapper.appendChild(buildPicoSummary(doc));

  // === MAIN LAYOUT: sidebar + drag + content ===
  const mainRow = doc.createElement("div");
  mainRow.style.cssText =
    "position:relative;display:flex;flex:1;min-width:0;min-height:0;overflow:hidden;";
  mainWrapper.appendChild(mainRow);

  const initialOuterWidth = mainWrapper.getBoundingClientRect().width || 900;
  const initialSizes = computeResponsiveSizes(initialOuterWidth);
  if (initialSizes.autoCollapseSidebar !== sidebarAutoCollapsed) {
    sidebarAutoCollapsed = initialSizes.autoCollapseSidebar;
  }

  // Left sidebar
  sideNav = buildSidebar(doc, initialSizes);
  mainRow.appendChild(sideNav);

  // Drag handle
  const drag = doc.createElement("div");
  drag.className = "sr-drag-h";
  drag.style.cssText =
    "width:5px;flex-shrink:0;cursor:col-resize;background:transparent;z-index:5;";
  sideNav.style.flexShrink = "0";
  drag.style.display = sidebarCollapsed || sidebarAutoCollapsed ? "none" : "";
  let dragging = false;
  drag.addEventListener("mousedown", (e: MouseEvent) => {
    if (sidebarCollapsed || sidebarAutoCollapsed) return;
    dragging = true;
    drag.style.background = "var(--highlight-primary)";
    doc.addEventListener("mousemove", onDrag);
    doc.addEventListener("mouseup", onDragEnd);
  });
  const onDrag = (e: MouseEvent) => {
    if (!dragging || !sideNav) return;
    const rect = sideNav.getBoundingClientRect();
    const availableWidth = mainWrapper?.getBoundingClientRect().width || 900;
    const maxWidth = Math.max(
      SR_SIDEBAR_MIN_WIDTH,
      Math.min(SR_SIDEBAR_MAX_WIDTH, availableWidth - SR_RESERVED_FOR_CONTENT),
    );
    const w = Math.max(
      SR_SIDEBAR_MIN_WIDTH,
      Math.min(maxWidth, e.clientX - rect.left),
    );
    sideNav.style.setProperty("width", `${w}px`);
    reviewSidebarWidth = Math.round(w);
  };
  const onDragEnd = () => {
    dragging = false;
    drag.style.background = "transparent";
    doc.removeEventListener("mousemove", onDrag);
    doc.removeEventListener("mouseup", onDragEnd);
    if (sideNav) {
      try {
        Zotero.Prefs.set(
          "extensions.zotero.seerai.srSidebarWidth",
          String(reviewSidebarWidth),
        );
      } catch {
        // Prefs may not be registered yet
      }
    }
    refreshReviewLayout?.();
  };
  mainRow.appendChild(drag);

  // Content area
  contentArea = doc.createElement("div");
  contentArea.style.cssText =
    "flex:1;min-width:0;display:flex;flex-direction:column;overflow:hidden;";
  mainRow.appendChild(contentArea);

  // Render active panel
  renderPanel(doc, currentState.activeSubTab);

  const runResponsiveLayout = () => {
    reviewLayoutRafPending = false;
    if (!mainWrapper || !sideNav) return;
    const availableWidth = mainWrapper.getBoundingClientRect().width;
    if (
      !availableWidth ||
      !Number.isFinite(availableWidth) ||
      availableWidth <= 0
    ) {
      return;
    }
    if (availableWidth === lastReviewLayoutWidth) return;
    lastReviewLayoutWidth = availableWidth;
    const filters = mainWrapper.querySelector(
      ".sr-filters-panel",
    ) as HTMLElement | null;
    const articleList = mainWrapper.querySelector(
      ".sr-paper-list",
    ) as HTMLElement | null;
    const articleHandle = mainWrapper.querySelector(
      ".sr-paper-list-handle",
    ) as HTMLElement | null;
    const filterHandle = mainWrapper.querySelector(
      ".sr-filter-handle",
    ) as HTMLElement | null;

    mainWrapper.classList.toggle("sr-layout-narrow", availableWidth < 760);
    mainWrapper.classList.toggle("sr-layout-tight", availableWidth < 560);

    const sizes = computeResponsiveSizes(availableWidth);
    if (sizes.autoCollapseSidebar !== sidebarAutoCollapsed) {
      sidebarAutoCollapsed = sizes.autoCollapseSidebar;
    }
    const effectiveCollapsed = sidebarCollapsed || sidebarAutoCollapsed;

    sideNav.style.setProperty("width", `${sizes.sidebarWidth}px`);
    sideNav.style.setProperty("min-width", `${sizes.sidebarMinWidth}px`);
    drag.style.display = effectiveCollapsed ? "none" : "";

    const sidebarHeader = sideNav.querySelector(
      "[data-sr-sidebar-header]",
    ) as HTMLElement | null;
    const sidebarLabel = sideNav.querySelector(
      "[data-sr-sidebar-label]",
    ) as HTMLElement | null;
    const sidebarPath = sideNav.querySelector(
      "[data-sr-sidebar-toggle-path]",
    ) as SVGPathElement | null;
    if (sidebarHeader) {
      sidebarHeader.style.padding = effectiveCollapsed ? "5px" : "8px 12px 6px";
      sidebarHeader.style.justifyContent = effectiveCollapsed
        ? "center"
        : "space-between";
    }
    if (sidebarLabel) {
      sidebarLabel.style.display = effectiveCollapsed ? "none" : "";
    }
    if (sidebarPath) {
      sidebarPath.setAttribute(
        "d",
        effectiveCollapsed ? "M6 3l5 5-5 5" : "M10 3L5 8l5 5",
      );
    }
    Array.from(sideNav.children).forEach((child) => {
      if (child !== sidebarHeader) {
        (child as HTMLElement).style.display = effectiveCollapsed ? "none" : "";
      }
    });

    if (filters && articleList) {
      if (sizes.autoCollapseFilters !== filtersAutoCollapsed) {
        filtersAutoCollapsed = sizes.autoCollapseFilters;
      }
      if (sizes.autoCollapseArticleList !== articleListAutoCollapsed) {
        articleListAutoCollapsed = sizes.autoCollapseArticleList;
      }
      const effectiveFiltersCollapsed =
        filtersCollapsed || filtersAutoCollapsed;
      const effectiveArticleListCollapsed =
        articleListCollapsed || articleListAutoCollapsed;
      filters.style.setProperty("width", `${sizes.filtersWidth}px`);
      filters.style.setProperty("min-width", `${sizes.filtersMinWidth}px`);
      const filterBody = filters.querySelector(
        "#sr-filters-body",
      ) as HTMLElement | null;
      if (filterBody) {
        filterBody.style.display = effectiveFiltersCollapsed ? "none" : "";
      }
      const filterHdrLabel = filters.querySelector(
        "[data-sr-filters-hdr-label]",
      ) as HTMLElement | null;
      if (filterHdrLabel) {
        filterHdrLabel.style.display = effectiveFiltersCollapsed ? "none" : "";
      }
      const filterHdr = filters.querySelector(
        "[data-sr-filters-hdr]",
      ) as HTMLElement | null;
      if (filterHdr) {
        filterHdr.style.padding = effectiveFiltersCollapsed ? "5px" : "4px 8px";
        filterHdr.style.justifyContent = effectiveFiltersCollapsed
          ? "center"
          : "space-between";
      }
      const filterTogglePath = filters.querySelector(
        "[data-sr-filters-toggle-path]",
      ) as SVGPathElement | null;
      if (filterTogglePath) {
        filterTogglePath.setAttribute(
          "d",
          effectiveFiltersCollapsed ? "M10 3L5 8l5 5" : "M6 3l5 5-5 5",
        );
      }

      articleList.style.setProperty("width", `${sizes.articleListWidth}px`);
      articleList.style.setProperty(
        "min-width",
        `${sizes.articleListMinWidth}px`,
      );

      articleList.classList.toggle(
        "sr-paper-list-compact",
        !effectiveArticleListCollapsed && sizes.articleListWidth < 190,
      );
      articleList.classList.toggle(
        "sr-paper-list-collapsed",
        effectiveArticleListCollapsed,
      );
    }
    if (articleHandle)
      articleHandle.style.display =
        articleListCollapsed || articleListAutoCollapsed ? "none" : "";
    if (filterHandle)
      filterHandle.style.display =
        filtersCollapsed || filtersAutoCollapsed ? "none" : "";
  };

  const applyResponsiveLayout = () => {
    if (reviewLayoutRafPending) return;
    reviewLayoutRafPending = true;
    const raf =
      doc.defaultView?.requestAnimationFrame ||
      ((cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 16));
    raf(runResponsiveLayout);
  };

  refreshReviewLayout = applyResponsiveLayout;
  const ResizeObserverCtor = doc.defaultView?.ResizeObserver;
  if (ResizeObserverCtor) {
    const layoutObserver = new ResizeObserverCtor(applyResponsiveLayout);
    layoutObserver.observe(mainWrapper);
    (mainWrapper as any)._layoutObserver = layoutObserver;
  }
  applyResponsiveLayout();

  return mainWrapper;
}

function applySidebarCollapsedState(
  nav: HTMLElement,
  collapsed: boolean,
  overrideWidth?: number,
): void {
  const header = nav.querySelector(
    "[data-sr-sidebar-header]",
  ) as HTMLElement | null;
  const label = nav.querySelector(
    "[data-sr-sidebar-label]",
  ) as HTMLElement | null;
  const path = nav.querySelector(
    "[data-sr-sidebar-toggle-path]",
  ) as SVGPathElement | null;
  Array.from(nav.children).forEach((child) => {
    if (child !== header) {
      (child as HTMLElement).style.display = collapsed ? "none" : "";
    }
  });
  if (header) {
    header.style.padding = collapsed ? "5px" : "8px 12px 6px";
    header.style.justifyContent = collapsed ? "center" : "space-between";
  }
  if (label) label.style.display = collapsed ? "none" : "";
  if (path) {
    path.setAttribute("d", collapsed ? "M6 3l5 5-5 5" : "M10 3L5 8l5 5");
  }
  if (collapsed) {
    nav.style.setProperty("width", `${SR_SIDEBAR_COLLAPSED_WIDTH}px`);
    nav.style.setProperty("min-width", `${SR_SIDEBAR_COLLAPSED_WIDTH}px`);
    nav.style.overflow = "hidden";
  } else {
    const w = overrideWidth ?? reviewSidebarWidth;
    nav.style.setProperty("width", `${w}px`);
    nav.style.setProperty("min-width", `${SR_SIDEBAR_MIN_WIDTH}px`);
    nav.style.removeProperty("max-width");
    nav.style.overflowY = "auto";
    nav.style.overflowX = "hidden";
  }
}

// ============================================================
// FOLDER BAR
// ============================================================
function buildFolderBar(doc: Document): HTMLElement {
  if (!currentState) return doc.createElement("div");
  const bar = doc.createElement("div");
  bar.style.cssText =
    "display:flex;align-items:center;gap:6px;padding:4px 8px;border-bottom:1px solid var(--border-primary);background:var(--background-secondary);flex-shrink:0;flex-wrap:wrap;font-size:11px;";

  const projectMenu = doc.createElement("details");
  projectMenu.style.cssText = "position:relative;";
  const projectSummary = doc.createElement("summary");
  projectSummary.textContent = `${getActiveSpace()?.name || "Review Project"} ▾`;
  projectSummary.style.cssText =
    "list-style:none;min-width:150px;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:700;color:var(--highlight-primary);background:var(--background-primary);border:1px solid var(--border-primary);border-radius:5px;padding:4px 8px;font-size:11px;cursor:pointer;";
  projectMenu.appendChild(projectSummary);
  const projectPopup = doc.createElement("div");
  projectPopup.style.cssText =
    "position:absolute;top:calc(100% + 4px);left:0;z-index:50;min-width:230px;padding:5px;border:1px solid var(--border-primary);border-radius:7px;background:var(--background-primary);box-shadow:0 8px 24px rgba(0,0,0,.2);";
  const menuButton = (
    label: string,
    action: () => void,
    destructive = false,
  ) => {
    const button = doc.createElement("button");
    button.textContent = label;
    button.style.cssText = `display:block;width:100%;padding:6px 8px;border:none;border-radius:4px;background:transparent;color:${destructive ? "#b91c1c" : "var(--text-primary)"};font:inherit;font-size:11px;text-align:left;cursor:pointer;`;
    button.addEventListener("click", action);
    return button;
  };
  const showProjectNameEditor = (mode: "create" | "rename") => {
    projectPopup.querySelector("[data-project-editor]")?.remove();
    const project = getActiveSpace();
    if (!currentState || (mode === "rename" && !project)) return;
    const editor = doc.createElement("div");
    editor.setAttribute("data-project-editor", mode);
    editor.style.cssText =
      "display:flex;gap:5px;padding:6px;border-top:1px solid var(--border-secondary);";
    const input = doc.createElement("input");
    input.value =
      mode === "rename"
        ? project!.name
        : `Project ${currentState.spaces.length + 1}`;
    input.placeholder = mode === "rename" ? "Project name" : "New project name";
    input.style.cssText =
      "min-width:0;flex:1;padding:5px 6px;border:1px solid var(--border-primary);border-radius:4px;background:var(--background-primary);color:var(--text-primary);font:inherit;font-size:11px;";
    editor.appendChild(input);
    const save = doc.createElement("button");
    save.textContent = mode === "rename" ? "Rename" : "Add";
    save.style.cssText =
      "padding:5px 7px;border:1px solid var(--highlight-primary);border-radius:4px;background:var(--highlight-primary);color:#fff;font:inherit;font-size:10px;cursor:pointer;";
    const submit = () => {
      const name = input.value.trim();
      if (!name || !currentState) return;
      try {
        if (mode === "rename" && project) {
          getSRService().renameProject(currentState, project.id, name);
        } else {
          getSRService().createProject(currentState, name);
          _srPaperIdSet.clear();
          syncModuleVarsFromState();
        }
        saveSRState();
        reRender(doc);
      } catch (error) {
        toast(doc, error instanceof Error ? error.message : String(error));
      }
    };
    save.addEventListener("click", submit);
    input.addEventListener("keydown", (event) => {
      const keyEvent = event as KeyboardEvent;
      if (keyEvent.key === "Enter") submit();
      if (keyEvent.key === "Escape") editor.remove();
    });
    editor.appendChild(save);
    projectPopup.appendChild(editor);
    input.focus();
    input.select();
  };
  currentState.spaces.forEach((project) => {
    projectPopup.appendChild(
      menuButton(
        `${project.id === currentState!.activeSpaceId ? "\u2022 " : ""}${project.name}`,
        () => {
          if (!currentState || project.id === currentState.activeSpaceId)
            return;
          try {
            getSRService().switchProject(currentState, project.id);
          } catch (error) {
            toast(doc, error instanceof Error ? error.message : String(error));
            return;
          }
          _srPaperIdSet.clear();
          currentState.papers.forEach((paper) => _srPaperIdSet.add(paper.id));
          syncModuleVarsFromState();
          invalidateItemCache();
          warmItemCache(currentState.papers.map((paper) => paper.id));
          saveSRState();
          reRender(doc);
        },
      ),
    );
  });
  const divider = doc.createElement("div");
  divider.style.cssText =
    "height:1px;background:var(--border-secondary);margin:4px 0;";
  projectPopup.appendChild(divider);
  projectPopup.appendChild(
    menuButton("+ New project", () => {
      showProjectNameEditor("create");
    }),
  );
  projectPopup.appendChild(
    menuButton("Rename current", () => {
      showProjectNameEditor("rename");
    }),
  );
  const deleteProjectButton = menuButton(
    "Delete current",
    () => {
      const project = getActiveSpace();
      if (!currentState || !project || currentState.spaces.length <= 1) return;
      if (
        !doc.defaultView?.confirm(
          `Delete review project "${project.name}" and its project-scoped data? Zotero items will not be deleted.`,
        )
      ) {
        return;
      }
      getSRService().deleteProject(currentState, project.id);
      _srPaperIdSet.clear();
      currentState.papers.forEach((paper) => _srPaperIdSet.add(paper.id));
      saveSRState();
      reRender(doc);
    },
    true,
  );
  deleteProjectButton.disabled = currentState.spaces.length <= 1;
  if (deleteProjectButton.disabled) {
    deleteProjectButton.style.opacity = "0.45";
    deleteProjectButton.title = "At least one review project must remain";
  }
  projectPopup.appendChild(deleteProjectButton);
  projectMenu.appendChild(projectPopup);
  bar.appendChild(projectMenu);

  // Active folder
  const total = currentState.papers.length;
  const screened = currentState.papers.filter(
    (p: SystematicReviewPaper) => p.status !== "undecided",
  ).length;
  const space = getActiveSpace();
  const activeFolderId = space?.activeFolderId || "all";
  const folderPct =
    total > 0 ? " " + Math.round((screened / total) * 100) + "%" : "";
  const folderSel = doc.createElement("select") as HTMLSelectElement;
  folderSel.style.cssText =
    "flex:1;max-width:200px;min-width:80px;border:1px solid var(--border-primary);border-radius:4px;padding:2px 6px;font-size:11px;font-family:inherit;background:var(--background-primary);color:var(--text-primary);";
  const optAll = doc.createElement("option");
  optAll.value = "all";
  optAll.textContent = `All Sources (${total})` + folderPct;
  if (activeFolderId === "all") optAll.selected = true;
  folderSel.appendChild(optAll);
  currentState.folders.forEach((f: any) => {
    const opt = doc.createElement("option");
    opt.value = f.id;
    const sourcePaperIds = new Set(
      currentState!.sourceOccurrences
        .filter((occurrence) => occurrence.sourceId === f.id)
        .map((occurrence) => occurrence.paperId),
    );
    const fp = currentState!.papers.filter((paper) =>
      sourcePaperIds.has(paper.id),
    );
    const fs = fp.filter(
      (p: SystematicReviewPaper) => p.status !== "undecided",
    ).length;
    opt.textContent =
      f.name +
      " (" +
      fp.length +
      ")" +
      (fp.length > 0 ? " " + Math.round((fs / fp.length) * 100) + "%" : "");
    if (activeFolderId === f.id) opt.selected = true;
    folderSel.appendChild(opt);
  });
  folderSel.addEventListener("change", () => {
    if (space) {
      space.activeFolderId = folderSel.value;
      saveSRState();
      reRender(doc);
    }
  });
  bar.appendChild(folderSel);

  const meta = doc.createElement("span");
  meta.style.cssText =
    "font-size:10px;color:var(--text-tertiary);white-space:nowrap;";
  meta.textContent = `${total} items (${screened} screened)`;
  bar.appendChild(meta);

  const spc = doc.createElement("span");
  spc.style.cssText = "flex:1;";
  bar.appendChild(spc);

  const aiBtn3 = doc.createElement("button");
  aiBtn3.textContent = "Suggest";
  aiBtn3.title = "Generate keyword-based screening suggestions";
  aiBtn3.style.cssText =
    "padding:2px 8px;font-size:10px;font-weight:600;border:1px solid #7c3aed;border-radius:4px;background:#7c3aed;color:#fff;cursor:pointer;font-family:inherit;";
  aiBtn3.addEventListener("click", () => {
    if (!currentState) return;
    const und = currentState.papers.filter(
      (p: SystematicReviewPaper) => p.status === "undecided",
    );
    if (!und.length) return;
    const space = getActiveSpace();
    const iks = space?.incKeywords || [];
    const eks = space?.excKeywords || [];
    und.forEach((p: SystematicReviewPaper) => {
      const z = Zotero.Items.get(p.id);
      const txt = (
        (z ? (z.getField("title") as string) || "" : "") +
        " " +
        (z ? (z.getField("abstractNote") as string) || "" : "")
      ).toLowerCase();
      let is = 0,
        es = 0;
      iks.forEach((k: string) => {
        if (txt.includes(k.toLowerCase())) is++;
      });
      eks.forEach((k: string) => {
        if (txt.includes(k.toLowerCase())) es++;
      });
      const decision =
        is > es + 1 ? "included" : es > is + 1 ? "excluded" : "maybe";
      const confidence = calculateKeywordConfidence(
        is,
        es,
        iks.length + eks.length,
        decision,
      );
      p.keywordConfidence = confidence;
      p.recommendation = {
        decision,
        confidence,
        rationale: `${is} inclusion and ${es} exclusion keyword matches. Keyword confidence is a heuristic based on match strength, separation, and configured-keyword coverage.`,
        source: "keyword",
        createdAt: new Date().toISOString(),
      };
      p.aiStatus = "manual";
    });
    saveSRState();
    toast(doc, "Generated suggestions for " + und.length + " papers");
    reRender(doc);
  });
  bar.appendChild(aiBtn3);

  // Criteria button
  const critBtn = doc.createElement("button");
  critBtn.textContent = "Criteria";
  critBtn.style.cssText =
    "padding:2px 8px;font-size:10px;font-weight:600;border:1px solid #7c3aed;border-radius:4px;background:#7c3aed;color:#fff;cursor:pointer;font-family:inherit;";
  critBtn.addEventListener("click", () => {
    openCriteriaModal(doc);
  });
  bar.appendChild(critBtn);

  // Add folder button
  const srcBtn = doc.createElement("button");
  srcBtn.textContent = "Add Folder";
  srcBtn.style.cssText =
    "padding:2px 8px;font-size:10px;font-weight:600;border:1px solid var(--border-primary);border-radius:4px;background:transparent;color:var(--text-secondary);cursor:pointer;font-family:inherit;";
  srcBtn.addEventListener("click", () => {
    openSourcesModal(doc);
  });
  bar.appendChild(srcBtn);

  // Add paper button
  const addBtn = doc.createElement("button");
  addBtn.textContent = "Add Papers";
  addBtn.style.cssText =
    "padding:3px 8px;font-size:11px;border:1px solid var(--highlight-primary);border-radius:4px;background:var(--highlight-primary);color:#fff;cursor:pointer;font-family:inherit;font-weight:500;";
  addBtn.addEventListener("click", async () => {
    try {
      const pane = Zotero.getActiveZoteroPane();
      const selected = pane
        .getSelectedItems()
        .filter((item: Zotero.Item) => item.isRegularItem());
      if (selected.length === 0) {
        toast(doc, "Select at least one regular Zotero item");
        return;
      }
      const selectedIds = selected.map((item) => item.id);
      const sourceLabel = generateSourceLabel();
      const added = getSRService().addPapers(
        currentState!,
        selectedIds,
        sourceLabel,
      );
      const existingCount = selectedIds.length - added.length;
      selectedIds.forEach((id) => _srPaperIdSet.add(id));
      warmItemCache(selectedIds);
      await getSRService().save(currentState!);
      if (added.length > 0 && existingCount > 0) {
        toast(
          doc,
          `Added ${added.length} paper${added.length === 1 ? "" : "s"} · ${existingCount} already in review · label "${sourceLabel}"`,
        );
      } else if (added.length > 0) {
        toast(
          doc,
          `Added ${added.length} paper${added.length === 1 ? "" : "s"} · label "${sourceLabel}"`,
        );
      } else {
        toast(
          doc,
          `Selected papers are already in this review (label "${sourceLabel}")`,
        );
      }
      reRender(doc);
    } catch (e) {
      Zotero.debug(`[seerai] Error adding papers: ${e}`);
    }
  });
  bar.appendChild(addBtn);

  return bar;
}

// ============================================================
// PICO SUMMARY
// ============================================================
function buildPicoSummary(doc: Document): HTMLElement {
  if (!currentState) return doc.createElement("div");
  const space = currentState.spaces.find(
    (s: SystematicReviewSpace) => s.id === currentState!.activeSpaceId,
  );
  if (!space) return doc.createElement("div");
  const fv = space.frameworkValues;
  const def = FRAMEWORK_DEFS[space.framework] || FRAMEWORK_DEFS.PICOTS;

  const bar = doc.createElement("div");
  bar.style.cssText =
    "display:flex;align-items:center;gap:4px;padding:2px 8px;flex-wrap:wrap;border-bottom:1px solid var(--border-secondary);font-size:9px;flex-shrink:0;";
  def.fields.forEach((f: any) => {
    const val = fv[f.k];
    if (!val) return;
    const chip = doc.createElement("span");
    chip.style.cssText =
      "display:inline-flex;align-items:center;gap:2px;padding:1px 5px;border-radius:4px;font-weight:600;border:1px solid var(--border-primary);";
    const keySpan = doc.createElement("span");
    keySpan.textContent = f.k;
    keySpan.style.cssText =
      "font-size:8px;color:var(--text-tertiary);text-transform:uppercase;font-weight:700;";
    chip.appendChild(keySpan);
    const valSpan = doc.createElement("span");
    valSpan.textContent = val;
    valSpan.style.cssText =
      "max-width:100px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
    chip.appendChild(valSpan);
    bar.appendChild(chip);
  });
  if (!bar.children.length) {
    bar.style.padding = "0";
  }
  return bar;
}

// ============================================================
// LEFT SIDEBAR
// ============================================================
function buildSidebar(
  doc: Document,
  initialSizes?: ResponsiveSizes,
): HTMLElement {
  if (!currentState) return doc.createElement("div");
  const nav = doc.createElement("div");
  nav.className = "sr-sidebar";
  nav.style.cssText =
    "border-right:1px solid var(--border-primary);background:var(--background-secondary);display:flex;flex-direction:column;overflow-y:auto;flex-shrink:0;";

  // Header with toggle
  const hdr = doc.createElement("div");
  hdr.setAttribute("data-sr-sidebar-header", "true");
  hdr.style.cssText =
    "display:flex;align-items:center;justify-content:space-between;padding:8px 12px 6px;font-size:10px;font-weight:600;color:var(--text-tertiary);text-transform:uppercase;letter-spacing:0.5px;";
  const hdrLabel = doc.createElement("span");
  hdrLabel.setAttribute("data-sr-sidebar-label", "true");
  hdrLabel.textContent = "Navigation";
  hdr.appendChild(hdrLabel);

  // Collapse toggle button
  const toggleBtn = doc.createElement("button");
  toggleBtn.title = "Toggle sidebar";
  toggleBtn.style.cssText =
    "display:flex;align-items:center;justify-content:center;width:20px;height:20px;border:none;background:transparent;color:var(--text-tertiary);cursor:pointer;border-radius:3px;padding:0;";
  const toggleSvg = doc.createElementNS(SVG_NS, "svg") as unknown as SVGElement;
  toggleSvg.setAttribute("width", "14");
  toggleSvg.setAttribute("height", "14");
  toggleSvg.setAttribute("viewBox", "0 0 16 16");
  toggleSvg.setAttribute("fill", "none");
  const togglePath = doc.createElementNS(SVG_NS, "path");
  togglePath.setAttribute("data-sr-sidebar-toggle-path", "true");
  togglePath.setAttribute("d", "M10 3L5 8l5 5");
  togglePath.setAttribute("stroke", "currentColor");
  togglePath.setAttribute("stroke-width", "1.8");
  togglePath.setAttribute("stroke-linecap", "round");
  togglePath.setAttribute("stroke-linejoin", "round");
  toggleSvg.appendChild(togglePath);
  toggleBtn.appendChild(toggleSvg);
  toggleBtn.addEventListener("click", () => {
    if (!sideNav) return;
    const effectiveCollapsed = sidebarCollapsed || sidebarAutoCollapsed;
    sidebarCollapsed = !effectiveCollapsed;
    sidebarAutoCollapsed = false;
    sidebarUserTouched = true;
    const shellWidth =
      mainWrapper?.getBoundingClientRect().width ||
      sideNav.getBoundingClientRect().width ||
      900;
    const sizes = computeResponsiveSizes(shellWidth);
    applySidebarCollapsedState(sideNav, sidebarCollapsed, sizes.sidebarWidth);
    Zotero.Prefs.set(
      "extensions.zotero.seerai.srSidebarCollapsed",
      sidebarCollapsed,
    );
    refreshReviewLayout?.();
  });
  hdr.appendChild(toggleBtn);
  nav.appendChild(hdr);

  // Count badges
  const papers = currentState.papers;
  const scrCount = papers.filter(
    (p: SystematicReviewPaper) => p.status !== "undecided",
  ).length;
  const evCount = currentState.evidenceDomains.length;
  const gapCount = currentState.gaps.length;

  const navItems: {
    id: SRSubTab;
    label: string;
    iconSvg: string;
    count: number;
  }[] = [
    {
      id: "screening",
      label: "Screening & Triage",
      iconSvg: "screening",
      count: scrCount,
    },
    {
      id: "evidence",
      label: "Evidence Synthesis",
      iconSvg: "evidence",
      count: evCount,
    },
    { id: "gaps", label: "Gap Analysis", iconSvg: "gaps", count: gapCount },
    { id: "prisma", label: "PRISMA Diagram", iconSvg: "prisma", count: 0 },
  ];

  // Section dividers
  let addedDivider = false;
  navItems.forEach((ni) => {
    if (ni.id === "evidence" && !addedDivider) {
      const div = doc.createElement("div");
      div.style.cssText =
        "border-top:1px solid var(--border-primary);margin:4px 0;";
      nav.appendChild(div);
      const secHdr = doc.createElement("div");
      secHdr.style.cssText =
        "padding:2px 12px;font-size:9px;color:var(--text-tertiary);font-weight:600;text-transform:uppercase;letter-spacing:0.5px;";
      secHdr.textContent = "Synthesis";
      nav.appendChild(secHdr);
      addedDivider = true;
    }
    if (ni.id === "prisma") {
      const div = doc.createElement("div");
      div.style.cssText =
        "border-top:1px solid var(--border-primary);margin:4px 0;";
      nav.appendChild(div);
      const secHdr = doc.createElement("div");
      secHdr.style.cssText =
        "padding:2px 12px;font-size:9px;color:var(--text-tertiary);font-weight:600;text-transform:uppercase;letter-spacing:0.5px;";
      secHdr.textContent = "Outputs";
      nav.appendChild(secHdr);
    }

    const btn = buildNavButton(doc, ni.id, ni.label, ni.count);
    nav.appendChild(btn);
  });

  // Open in Table button
  const tableBtn2 = doc.createElement("button");
  tableBtn2.textContent = "Open in Table";
  tableBtn2.style.cssText =
    "display:flex;align-items:center;gap:6px;padding:6px 12px;margin-top:8px;border:none;border-radius:4px;background:var(--background-primary);color:var(--text-secondary);cursor:pointer;font-size:11px;font-family:inherit;text-align:left;width:100%;transition:all 0.1s;border:1px solid var(--border-primary);";
  tableBtn2.addEventListener("mouseenter", () => {
    tableBtn2.style.background = "var(--highlight-primary)";
    tableBtn2.style.color = "#fff";
  });
  tableBtn2.addEventListener("mouseleave", () => {
    tableBtn2.style.background = "var(--background-primary)";
    tableBtn2.style.color = "var(--text-secondary)";
  });
  tableBtn2.addEventListener("click", () => {
    const included =
      currentState?.papers.filter(
        (p) => p.status === "included" || p.status === "maybe",
      ) || [];
    const items = included
      .map((p) => Zotero.Items.get(p.id) as Zotero.Item)
      .filter(Boolean);
    if (items.length > 0) {
      (addon.api as any).Assistant.addItemsToCurrentTable(items);
    }
  });
  nav.appendChild(tableBtn2);

  const effectiveCollapsed = sidebarCollapsed || sidebarAutoCollapsed;
  applySidebarCollapsedState(
    nav,
    effectiveCollapsed,
    initialSizes?.sidebarWidth,
  );

  return nav;
}

function buildNavButton(
  doc: Document,
  panel: SRSubTab,
  label: string,
  count: number,
): HTMLElement {
  if (!currentState) return doc.createElement("div");
  const isActive = currentState.activeSubTab === panel;

  const btn = doc.createElement("button");
  btn.style.cssText =
    "display:flex;align-items:center;gap:6px;padding:6px 12px;border:none;border-left:2px solid " +
    (isActive ? "var(--highlight-primary)" : "transparent") +
    ";background:" +
    (isActive ? "var(--background-primary)" : "transparent") +
    ";color:" +
    (isActive ? "var(--highlight-primary)" : "var(--text-secondary)") +
    ";cursor:pointer;font-size:11px;font-family:inherit;text-align:left;width:100%;transition:all 0.1s;";
  btn.addEventListener("mouseenter", () => {
    if (!isActive) btn.style.background = "var(--background-primary)";
  });
  btn.addEventListener("mouseleave", () => {
    if (!isActive) btn.style.background = "transparent";
  });

  btn.addEventListener("click", () => {
    if (!currentState || !doc) return;
    currentState.activeSubTab = panel;
    saveSRState();
    renderPanel(doc, panel);
    if (sideNav) {
      const sidebarWidth = mainWrapper?.getBoundingClientRect().width || 900;
      const sidebarSizes = computeResponsiveSizes(sidebarWidth);
      if (sidebarSizes.autoCollapseSidebar !== sidebarAutoCollapsed) {
        sidebarAutoCollapsed = sidebarSizes.autoCollapseSidebar;
      }
      const newNav = buildSidebar(doc, sidebarSizes);
      sideNav.replaceWith(newNav);
      sideNav = newNav;
    }
  });

  // Icon
  const icon = buildNavIcon(doc, panel);
  btn.appendChild(icon);

  const lbl = doc.createElement("span");
  lbl.textContent = label;
  lbl.style.cssText =
    "flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
  btn.appendChild(lbl);

  if (count > 0) {
    const badge = doc.createElement("span");
    badge.textContent = String(count);
    badge.style.cssText =
      "margin-left:auto;font-size:9px;padding:0 5px;border-radius:8px;min-width:16px;text-align:center;font-weight:600;background:var(--background-tertiary);color:var(--text-secondary);";
    btn.appendChild(badge);
  }

  return btn;
}

function buildNavIcon(doc: Document, panel: string): HTMLElement {
  const svg = doc.createElementNS(SVG_NS, "svg") as unknown as SVGElement;
  svg.setAttribute("width", "14");
  svg.setAttribute("height", "14");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("fill", "none");
  svg.style.cssText = "flex-shrink:0;";

  let pathD = "";
  switch (panel) {
    case "screening":
      pathD = "M8 1a7 7 0 100 14A7 7 0 008 1zM5 8l2 2 4-4";
      break;
    case "evidence":
      pathD = "M2 11h4v4H2v-4zm5-5h4v9H7V6zm5-3h4v12h-4V3z";
      break;
    case "gaps":
      pathD =
        "M8 1a7 7 0 100 14A7 7 0 008 1zM8 3a1.5 1.5 0 100 3 1.5 1.5 0 000-3zM5 11a1.5 1.5 0 100 3 1.5 1.5 0 000-3zm6 0a1.5 1.5 0 100 3 1.5 1.5 0 000-3z";
      break;
    case "prisma":
      pathD = "M2 2h12v3H2V2zm0 4h12v3H2V6zm0 4h12v3H2v-3z";
      break;
  }

  const path = doc.createElementNS(SVG_NS, "path");
  path.setAttribute("d", pathD);
  path.setAttribute("stroke", "currentColor");
  path.setAttribute("stroke-width", "1.5");
  path.setAttribute("stroke-linecap", "round");
  path.setAttribute("stroke-linejoin", "round");
  svg.appendChild(path);

  return svg as unknown as HTMLElement;
}

// ============================================================
// PANEL RENDERING
// ============================================================
function renderPanel(doc: Document, panel: SRSubTab): void {
  currentPanel = panel;
  if (!contentArea) return;
  while (contentArea.firstChild) {
    contentArea.removeChild(contentArea.firstChild);
  }

  switch (panel) {
    case "screening":
      contentArea.appendChild(buildScreeningPanel(doc));
      break;
    case "evidence":
      contentArea.appendChild(buildEvidencePanel(doc));
      break;
    case "gaps":
      contentArea.appendChild(buildGapPanel(doc));
      break;
    case "prisma":
      contentArea.appendChild(buildPrismaPanel(doc));
      break;
    default:
      contentArea.appendChild(buildScreeningPanel(doc));
  }
}

// ============================================================
// SCREENING PANEL
// ============================================================

function buildScreeningPanel(doc: Document): HTMLElement {
  if (!currentState) return doc.createElement("div");
  const panel = doc.createElement("div");
  panel.style.cssText =
    "display:flex;flex-direction:column;flex:1;min-height:0;overflow:hidden;";

  // Pipeline progress bar
  panel.appendChild(buildPipeline(doc));

  // Three-column layout
  const row = doc.createElement("div");
  row.className = "sr-screening-layout";
  row.style.cssText =
    "display:flex;flex:1;min-width:0;min-height:0;overflow:hidden;";
  panel.appendChild(row);

  const outerWidth =
    mainWrapper?.getBoundingClientRect().width ||
    contentArea?.getBoundingClientRect().width ||
    900;
  const initialSizes = computeResponsiveSizes(outerWidth);
  if (initialSizes.autoCollapseSidebar !== sidebarAutoCollapsed) {
    sidebarAutoCollapsed = initialSizes.autoCollapseSidebar;
  }
  if (initialSizes.autoCollapseFilters !== filtersAutoCollapsed) {
    filtersAutoCollapsed = initialSizes.autoCollapseFilters;
  }
  if (initialSizes.autoCollapseArticleList !== articleListAutoCollapsed) {
    articleListAutoCollapsed = initialSizes.autoCollapseArticleList;
  }
  mainWrapper?.classList.toggle("sr-layout-narrow", outerWidth < 760);
  mainWrapper?.classList.toggle("sr-layout-tight", outerWidth < 560);

  // Left: Article list
  const left = buildArticleList(doc, initialSizes);
  row.appendChild(left);

  // Drag handle between article list and detail
  const dragLeft = doc.createElement("div");
  dragLeft.className = "sr-paper-list-handle";
  dragLeft.style.cssText =
    "width:4px;flex-shrink:0;cursor:col-resize;background:transparent;z-index:5;";
  let dragLeftActive = false;
  dragLeft.addEventListener("mousedown", (e: MouseEvent) => {
    dragLeftActive = true;
    dragLeft.style.background = "var(--highlight-primary)";
    const onMove = (ev: MouseEvent) => {
      if (!dragLeftActive) return;
      const rect = left.getBoundingClientRect();
      const rowWidth = row.getBoundingClientRect().width;
      const rightWidth = right?.getBoundingClientRect().width || 0;
      const w = Math.max(
        100,
        Math.min(
          Math.min(450, rowWidth - rightWidth - 220),
          ev.clientX - rect.left,
        ),
      );
      reviewArticleListWidth = Math.round(w);
      left.style.setProperty("width", `${w}px`, "important");
      left.style.setProperty("min-width", `${w}px`, "important");
      left.style.setProperty("max-width", `${w}px`, "important");
    };
    const onUp = () => {
      dragLeftActive = false;
      dragLeft.style.background = "transparent";
      doc.removeEventListener("mousemove", onMove);
      doc.removeEventListener("mouseup", onUp);
      Zotero.Prefs.set(
        "extensions.zotero.seerai.srArticleListWidth",
        String(reviewArticleListWidth),
      );
      refreshReviewLayout?.();
    };
    doc.addEventListener("mousemove", onMove);
    doc.addEventListener("mouseup", onUp);
  });
  row.appendChild(dragLeft);

  // Center: Detail view
  const center = buildDetailView(doc);
  row.appendChild(center);

  // Right: Filters
  const right = buildFiltersPanel(doc, initialSizes);

  // Drag handle between detail and filters
  const dragRight = doc.createElement("div");
  dragRight.className = "sr-filter-handle";
  dragRight.style.cssText =
    "width:4px;flex-shrink:0;cursor:col-resize;background:transparent;z-index:5;";
  let dragRightActive = false;
  dragRight.addEventListener("mousedown", (e: MouseEvent) => {
    if (filtersCollapsed) return;
    dragRightActive = true;
    dragRight.style.background = "var(--highlight-primary)";
    const onMove = (ev: MouseEvent) => {
      if (!dragRightActive) return;
      const rightRect = right.getBoundingClientRect();
      const rowWidth = row.getBoundingClientRect().width;
      const leftWidth = left.getBoundingClientRect().width;
      const maxWidth = Math.max(80, Math.min(450, rowWidth - leftWidth - 220));
      const w = Math.max(80, Math.min(maxWidth, rightRect.right - ev.clientX));
      reviewFiltersWidth = Math.round(w);
      right.style.setProperty("width", `${w}px`, "important");
      right.style.setProperty("min-width", `${w}px`, "important");
      right.style.setProperty("max-width", `${w}px`, "important");
    };
    const onUp = () => {
      dragRightActive = false;
      dragRight.style.background = "transparent";
      doc.removeEventListener("mousemove", onMove);
      doc.removeEventListener("mouseup", onUp);
      Zotero.Prefs.set(
        "extensions.zotero.seerai.srFiltersWidth",
        String(reviewFiltersWidth),
      );
      refreshReviewLayout?.();
    };
    doc.addEventListener("mousemove", onMove);
    doc.addEventListener("mouseup", onUp);
  });
  row.appendChild(dragRight);

  row.appendChild(right);

  const articleListEl = left as HTMLElement;
  const effectiveArticleListCollapsed =
    articleListCollapsed || articleListAutoCollapsed;
  articleListEl.classList.toggle(
    "sr-paper-list-compact",
    !effectiveArticleListCollapsed && initialSizes.articleListWidth < 190,
  );
  articleListEl.classList.toggle(
    "sr-paper-list-collapsed",
    effectiveArticleListCollapsed,
  );
  dragLeft.style.display = effectiveArticleListCollapsed ? "none" : "";
  dragRight.style.display =
    filtersCollapsed || filtersAutoCollapsed ? "none" : "";

  return panel;
}

function buildPipeline(doc: Document): HTMLElement {
  if (!currentState) return doc.createElement("div");
  const papers = currentState.papers;
  const total = papers.length || 1;
  const inc = papers.filter(
    (p: SystematicReviewPaper) => p.status === "included",
  ).length;
  const may = papers.filter(
    (p: SystematicReviewPaper) => p.status === "maybe",
  ).length;
  const exc = papers.filter(
    (p: SystematicReviewPaper) => p.status === "excluded",
  ).length;
  const und = papers.filter(
    (p: SystematicReviewPaper) => p.status === "undecided",
  ).length;

  const bar = doc.createElement("div");
  bar.style.cssText =
    "display:flex;align-items:center;gap:0;padding:4px 8px;border-bottom:1px solid var(--border-primary);background:var(--background-primary);flex-shrink:0;";

  // Progress segments
  const segs = [
    { count: inc, color: "#16a34a", label: "Included" },
    { count: may, color: "#d97706", label: "Maybe" },
    { count: und, color: "var(--border-primary)", label: "Undecided" },
    { count: exc, color: "#dc2626", label: "Excluded" },
  ];

  const segWrap = doc.createElement("div");
  segWrap.style.cssText =
    "flex:1;display:flex;height:6px;border-radius:3px;overflow:hidden;margin-right:8px;";
  segs.forEach((s) => {
    if (s.count === 0) return;
    const seg = doc.createElement("div");
    seg.style.cssText = `width:${(s.count / total) * 100}%;height:100%;background:${s.color};transition:width 0.3s;`;
    segWrap.appendChild(seg);
  });
  bar.appendChild(segWrap);

  // Stats
  const stats = doc.createElement("div");
  stats.style.cssText =
    "display:flex;gap:12px;font-size:10px;color:var(--text-secondary);white-space:nowrap;";
  [
    { val: inc, color: "#16a34a", label: "inc" },
    { val: may, color: "#d97706", label: "may" },
    {
      val: und,
      color: "var(--text-primary)",
      label: "und",
    },
    { val: exc, color: "#dc2626", label: "exc" },
  ].forEach((s: { val: number; color: string; label: string }) => {
    const span = doc.createElement("span");
    const strong = doc.createElement("strong");
    strong.textContent = String(s.val);
    strong.style.cssText = `color:${s.color};`;
    span.appendChild(strong);
    span.appendChild(doc.createTextNode(" " + s.label));
    stats.appendChild(span);
  });
  bar.appendChild(stats);

  return bar;
}

function buildArticleList(
  doc: Document,
  initialSizes?: ResponsiveSizes,
): HTMLElement {
  if (!currentState) return doc.createElement("div");
  const filtered = scrFiltered();
  const left = doc.createElement("div");
  left.className = "sr-paper-list";
  const initialWidth = initialSizes?.articleListWidth ?? reviewArticleListWidth;
  const initialMin = initialSizes?.articleListMinWidth ?? 60;
  left.style.cssText = `width:${initialWidth}px;min-width:${initialMin}px;max-width:450px;flex-shrink:0;border-right:1px solid var(--border-primary);display:flex;flex-direction:column;overflow:hidden;`;

  // Header with filter controls
  const hdr = doc.createElement("div");
  hdr.className = "sr-paper-list-header";
  hdr.style.cssText =
    "display:flex;align-items:center;gap:4px;padding:4px 6px;border-bottom:1px solid var(--border-primary);background:var(--background-secondary);flex-shrink:0;flex-wrap:wrap;";

  const listToggle = doc.createElement("button");
  listToggle.className = "sr-paper-list-toggle";
  listToggle.textContent = articleListCollapsed ? "\u25B6" : "\u25C0";
  listToggle.title = articleListCollapsed
    ? "Show paper list"
    : "Hide paper list";
  listToggle.style.cssText =
    "display:flex;align-items:center;justify-content:center;width:20px;height:20px;padding:0;border:none;border-radius:3px;background:transparent;color:var(--text-secondary);cursor:pointer;flex-shrink:0;";
  listToggle.addEventListener("click", () => {
    articleListCollapsed = !articleListCollapsed;
    articleListAutoCollapsed = false;
    articleListUserTouched = true;
    Zotero.Prefs.set(
      "extensions.zotero.seerai.srArticleListCollapsed",
      articleListCollapsed,
    );
    reRenderPanel(doc, "screening");
  });
  hdr.appendChild(listToggle);

  // Status filter
  const statusSel = doc.createElement("select") as HTMLSelectElement;
  statusSel.style.cssText =
    "font-size:10px;padding:2px 4px;border:1px solid var(--border-primary);border-radius:4px;background:var(--background-primary);color:var(--text-primary);font-family:inherit;";
  [
    { v: "undecided", l: "Undecided" },
    { v: "included", l: "Included" },
    { v: "maybe", l: "Maybe" },
    { v: "excluded", l: "Excluded" },
    { v: "all", l: "All" },
  ].forEach((o: { v: string; l: string }) => {
    const opt = doc.createElement("option");
    opt.value = o.v;
    opt.textContent = o.l;
    if (currentState!.scrFilter === o.v) opt.selected = true;
    statusSel.appendChild(opt);
  });
  statusSel.addEventListener("change", () => {
    if (!currentState) return;
    currentState.scrFilter = statusSel.value;
    saveSRState();
    reRenderPanel(doc, "screening");
  });
  hdr.appendChild(statusSel);

  // Sort
  const sortSel = doc.createElement("select") as HTMLSelectElement;
  sortSel.style.cssText =
    "font-size:10px;padding:2px 4px;border:1px solid var(--border-primary);border-radius:4px;background:var(--background-primary);color:var(--text-primary);font-family:inherit;";
  [
    { v: "default", l: "Default" },
    { v: "confidence", l: "Confidence (AI preferred)" },
    { v: "year", l: "Year" },
    { v: "status", l: "Status" },
  ].forEach((o: { v: string; l: string }) => {
    const opt = doc.createElement("option");
    opt.value = o.v;
    opt.textContent = o.l;
    if (currentState!.scrSort === o.v) opt.selected = true;
    sortSel.appendChild(opt);
  });
  sortSel.addEventListener("change", () => {
    if (!currentState) return;
    currentState.scrSort = sortSel.value;
    saveSRState();
    reRenderPanel(doc, "screening");
  });
  hdr.appendChild(sortSel);

  // Select All checkbox
  const selAllLabel = doc.createElement("label");
  selAllLabel.style.cssText =
    "display:flex;align-items:center;gap:2px;font-size:10px;color:var(--text-secondary);cursor:pointer;";
  const selAllCb = doc.createElement("input") as HTMLInputElement;
  selAllCb.type = "checkbox";
  selAllCb.id = "sr-select-all";
  const visibleSelected = filtered.filter((paper) =>
    scrSelected.has(paper.id),
  ).length;
  selAllCb.checked = filtered.length > 0 && visibleSelected === filtered.length;
  selAllCb.indeterminate =
    visibleSelected > 0 && visibleSelected < filtered.length;
  selAllCb.style.cssText =
    "width:12px;height:12px;accent-color:var(--highlight-primary);margin:0;";
  selAllCb.addEventListener("change", () => {
    if (!currentState) return;
    if (selAllCb.checked) {
      filtered.forEach((p: SystematicReviewPaper) => scrSelected.add(p.id));
    } else {
      filtered.forEach((p: SystematicReviewPaper) => scrSelected.delete(p.id));
    }
    reRenderPanel(doc, "screening");
  });
  selAllLabel.appendChild(selAllCb);
  selAllLabel.appendChild(doc.createTextNode(" All"));
  hdr.appendChild(selAllLabel);

  const spc = doc.createElement("span");
  spc.style.cssText = "flex:1;min-width:4px;";
  hdr.appendChild(spc);

  const list = doc.createElement("div");
  list.className = "sr-art-list";
  list.style.cssText = "flex:1;overflow-y:auto;";

  // Search
  const searchInput = doc.createElement("input") as HTMLInputElement;
  searchInput.type = "text";
  searchInput.placeholder = "Search...";
  searchInput.value = currentState.scrSearch;
  searchInput.style.cssText =
    "flex:1 1 80px;min-width:40px;border:none;background:transparent;font-size:10px;outline:none;color:var(--text-primary);padding:2px 0;";
  searchInput.addEventListener("input", () => {
    if (!currentState) return;
    currentState.scrSearch = searchInput.value;
    renderArticleListContents(doc, list);
    updateSelectAll(doc);
  });
  searchInput.addEventListener("change", () => {
    if (!currentState) return;
    currentState.scrSearch = searchInput.value;
    saveSRState();
  });
  hdr.appendChild(searchInput);

  const kwBtn = doc.createElement("button");
  kwBtn.textContent = "KW";
  kwBtn.title = "Toggle configured keyword filters";
  kwBtn.style.cssText =
    "padding:2px 5px;font-size:9px;border:1px solid var(--border-primary);border-radius:4px;cursor:pointer;font-family:inherit;" +
    (kwFilterActive
      ? "background:var(--highlight-primary);color:#fff;border-color:var(--highlight-primary);"
      : "background:var(--background-primary);color:var(--text-secondary);");
  kwBtn.addEventListener("click", () => {
    kwFilterActive = !kwFilterActive;
    kwFilterKeyword = null;
    saveSRState();
    reRenderPanel(doc, "screening");
  });
  hdr.appendChild(kwBtn);

  left.appendChild(hdr);

  // Article list
  renderArticleListContents(doc, list);

  left.appendChild(list);

  // Batch bar
  const batchBar = buildBatchBar(doc);
  batchBar.classList.add("sr-batch-bar");
  left.appendChild(batchBar);

  return left;
}

function renderArticleListContents(doc: Document, list: HTMLElement): void {
  if (!currentState) return;
  while (list.firstChild) list.removeChild(list.firstChild);
  const filtered = scrFiltered();
  if (filtered.length === 0) {
    const empty = doc.createElement("div");
    empty.style.cssText =
      "display:flex;flex-direction:column;align-items:center;justify-content:center;padding:24px;color:var(--text-tertiary);text-align:center;gap:8px;";
    if (currentState.papers.length === 0) {
      const icon = createSvgIcon(
        doc,
        "M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z",
        "No papers",
        32,
      );
      icon.style.cssText = "opacity:0.4;margin-bottom:8px;";
      empty.appendChild(icon);
      const msg = doc.createElement("div");
      msg.textContent = "No papers in the review pool";
      msg.style.cssText =
        "font-size:11px;font-weight:600;color:var(--text-secondary);";
      empty.appendChild(msg);
      const hint = doc.createElement("div");
      hint.textContent =
        "Right-click items in your library \u2192 Add to Systematic Review, or use Sources to import a Zotero collection.";
      hint.style.cssText =
        "font-size:10px;color:var(--text-tertiary);max-width:260px;line-height:1.4;";
      empty.appendChild(hint);
    } else {
      const msg = doc.createElement("div");
      msg.textContent = "No papers match the current filter";
      msg.style.cssText =
        "font-size:11px;font-weight:600;color:var(--text-secondary);";
      empty.appendChild(msg);
      const hint = doc.createElement("div");
      hint.textContent =
        "Try changing the status filter, search text, or keyword settings.";
      hint.style.cssText =
        "font-size:10px;color:var(--text-tertiary);max-width:260px;line-height:1.4;";
      empty.appendChild(hint);
    }
    list.appendChild(empty);
  } else {
    filtered.forEach((paper: SystematicReviewPaper, idx: number) => {
      const row = buildArticleRow(doc, paper, idx + 1);
      list.appendChild(row);
    });
  }
}

function buildArticleRow(
  doc: Document,
  paper: SystematicReviewPaper,
  num: number,
): HTMLElement {
  const m = getItemMeta(paper.id);
  const title = m.title || `Item ${paper.id}`;
  const author =
    m.creators.length > 0
      ? (m.creators[0] as any).lastName || (m.creators[0] as any).name || ""
      : "";
  const year = m.year;

  const isActive = scrActive === paper.id;
  const isExc = paper.status === "excluded";

  const row = doc.createElement("div");
  row.className = "sr-art" + (isActive ? " sr-art-active" : "");
  row.setAttribute("data-sid", String(paper.id));
  row.style.cssText =
    "border-bottom:1px solid var(--border-secondary);padding:3px 4px;cursor:pointer;display:flex;align-items:flex-start;gap:4px;transition:background 0.1s;" +
    (isActive
      ? "background:var(--background-primary);border-left:3px solid var(--highlight-primary);padding-left:" +
        (4 - 3) +
        "px;"
      : "") +
    (isExc ? "opacity:0.45;" : "");
  row.addEventListener("click", (e: Event) => {
    const target = e.target as HTMLElement;
    if (
      target.tagName === "INPUT" &&
      (target as HTMLInputElement).type === "checkbox"
    )
      return;
    if (target.classList.contains("sr-art-act")) return;
    selectScreeningPaper(doc, paper.id, { resetDetailScroll: true });
  });

  // Checkbox
  const cb = doc.createElement("input") as HTMLInputElement;
  cb.type = "checkbox";
  cb.className = "sr-art-cb";
  cb.setAttribute("data-sid", String(paper.id));
  cb.style.cssText =
    "flex-shrink:0;width:10px;height:10px;accent-color:var(--highlight-primary);cursor:pointer;margin-top:1px;";
  cb.checked = scrSelected.has(paper.id);
  cb.addEventListener("click", (e: Event) => {
    e.stopPropagation();
    if (cb.checked) scrSelected.add(paper.id);
    else scrSelected.delete(paper.id);
    updateBatchBar(doc);
    updateSelectAll(doc);
  });
  row.appendChild(cb);

  // Number
  const numEl = doc.createElement("span");
  numEl.textContent = "#" + String(num);
  numEl.className = "sr-art-number";
  numEl.style.cssText =
    "font-size:8px;color:var(--text-tertiary);font-weight:600;min-width:18px;flex-shrink:0;padding-top:1px;";
  row.appendChild(numEl);

  // Body
  const body = doc.createElement("div");
  body.style.cssText = "flex:1;min-width:0;";

  // Title
  const titleEl = doc.createElement("div");
  titleEl.textContent = title;
  titleEl.className = "sr-art-title";
  titleEl.title = "Show in screening detail";
  titleEl.style.cssText =
    "font-size:10px;font-weight:500;color:var(--text-primary);line-height:1.3;max-height:2.6em;overflow:hidden;cursor:pointer;";
  if (paper.status === "excluded") {
    titleEl.style.textDecoration = "line-through";
    titleEl.style.textDecorationColor = "#dc2626";
  }
  titleEl.addEventListener("mouseenter", () => {
    if (paper.status !== "excluded") {
      titleEl.style.textDecoration = "underline";
    }
  });
  titleEl.addEventListener("mouseleave", () => {
    if (paper.status !== "excluded") {
      titleEl.style.textDecoration = "none";
    }
  });
  body.appendChild(titleEl);

  // Sub info
  const sub = doc.createElement("div");
  sub.className = "sr-art-meta";
  sub.style.cssText =
    "display:flex;align-items:center;gap:4px;margin-top:1px;font-size:8px;color:var(--text-tertiary);";
  if (author) sub.appendChild(crEl(doc, author));
  if (year) sub.appendChild(crEl(doc, year));
  const listConfidence = getPaperConfidence(paper);
  if (listConfidence) {
    const cf = doc.createElement("span");
    cf.textContent = `${listConfidence.source === "ai" ? "AI" : "Keyword"} ${Math.round(listConfidence.value * 100)}%`;
    cf.title =
      listConfidence.source === "ai"
        ? "Model-reported confidence from AI paper analysis"
        : "Heuristic keyword confidence based on match strength and coverage";
    cf.style.cssText =
      "padding:1px 4px;border-radius:3px;font-size:7px;font-weight:600;" +
      (listConfidence.value >= 0.8
        ? "background:#e8f5e9;color:#16a34a;"
        : listConfidence.value >= 0.5
          ? "background:#fff8e1;color:#d97706;"
          : "background:#fce4ec;color:#dc2626;");
    sub.appendChild(cf);
  }
  // Source tag
  const paperSources = getPaperSources(paper.id);
  if (paperSources.length > 0) {
    const srcTag = doc.createElement("span");
    srcTag.textContent =
      paperSources.length === 1
        ? paperSources[0].srcLabel
        : `${paperSources[0].srcLabel} +${paperSources.length - 1}`;
    srcTag.title = paperSources
      .map((source) => `${source.srcLabel} (${source.type})`)
      .join("\n");
    srcTag.style.cssText =
      "padding:0 3px;border-radius:2px;font-size:7px;background:var(--background-tertiary);color:var(--text-tertiary);";
    sub.appendChild(srcTag);
  }
  if (paper.sourceLabel) {
    const lblTag = doc.createElement("span");
    lblTag.textContent = paper.sourceLabel;
    lblTag.title = paper.sourceType
      ? `Source label: ${paper.sourceLabel} (${paper.sourceType})`
      : `Source label: ${paper.sourceLabel}`;
    lblTag.style.cssText =
      "padding:0 3px;border-radius:2px;font-size:7px;background:var(--background-tertiary);color:var(--text-tertiary);";
    sub.appendChild(lblTag);
  }
  // Extraction indicator
  const exCount = (currentState!.extractions[paper.id] || []).length;
  if (exCount > 0) {
    const exDot = doc.createElement("span");
    exDot.replaceChildren(
      createSvgIcon(exDot.ownerDocument!, ICONS.check, "included", 14),
    );
    exDot.title = exCount + " extractions";
    exDot.style.cssText = "font-size:8px;color:#16a34a;";
    sub.appendChild(exDot);
  }
  body.appendChild(sub);

  // Exclusion reason
  if (paper.status === "excluded" && paper.exclReason) {
    const reason = doc.createElement("div");
    reason.textContent = paper.exclReason;
    reason.style.cssText =
      "font-size:8px;color:#dc2626;font-style:italic;margin-top:1px;";
    body.appendChild(reason);
  }

  // Labels
  if (currentState!.paperLabels[paper.id]?.length > 0) {
    const lblRow = doc.createElement("div");
    lblRow.className = "sr-art-labels";
    lblRow.style.cssText =
      "display:flex;gap:2px;flex-wrap:wrap;margin-top:1px;";
    currentState!.paperLabels[paper.id].forEach((lk: string) => {
      const def = currentState!.labelDefs.find(
        (l: LabelDefinition) => l.k === lk,
      );
      const lblChip = doc.createElement("span");
      lblChip.textContent = def ? def.name : lk;
      lblChip.style.cssText =
        "padding:0 3px;border-radius:3px;font-size:7px;font-weight:600;cursor:default;background:" +
        (def ? def.bg : "var(--background-tertiary)") +
        ";color:" +
        (def ? def.color : "var(--text-secondary)") +
        ";";
      lblRow.appendChild(lblChip);
    });
    body.appendChild(lblRow);
  }

  // Quick action buttons
  const actions = doc.createElement("div");
  actions.className = "sr-art-actions";
  actions.style.cssText = "display:flex;gap:2px;margin-top:1px;";
  const reaBtn = doc.createElement("button");
  reaBtn.textContent = "R";
  reaBtn.title = "Quick reason";
  reaBtn.className = "sr-art-act";
  reaBtn.style.cssText =
    "width:14px;height:12px;border:none;background:transparent;color:var(--text-tertiary);cursor:pointer;font-size:8px;border-radius:2px;display:flex;align-items:center;justify-content:center;padding:0;";
  reaBtn.addEventListener("click", (e: Event) => {
    e.stopPropagation();
    if (paper.status !== "excluded") {
      getSRService().setDecision(currentState!, paper.id, "excluded");
      saveSRState();
    }
    showReason = true;
    showNote = false;
    showSourceLabelRow = false;
    const list = contentArea?.querySelector(".sr-art-list");
    const row = list?.querySelector(
      `.sr-art[data-sid="${paper.id}"]`,
    ) as HTMLElement | null;
    if (row) applyArticleRowStatusStyles(row, paper);
    selectScreeningPaper(doc, paper.id, {
      resetDetailScroll: false,
      preserveTransientFlags: true,
    });
  });
  actions.appendChild(reaBtn);

  const lblBtn2 = doc.createElement("button");
  lblBtn2.textContent = "L";
  lblBtn2.title = "Quick label";
  lblBtn2.className = "sr-art-act";
  lblBtn2.style.cssText =
    "width:14px;height:12px;border:none;background:transparent;color:var(--text-tertiary);cursor:pointer;font-size:8px;border-radius:2px;display:flex;align-items:center;justify-content:center;padding:0;";
  lblBtn2.addEventListener("click", (e: Event) => {
    e.stopPropagation();
    scrActive = paper.id;
    showReason = false;
    toggleLabelRow(doc);
  });
  actions.appendChild(lblBtn2);
  body.appendChild(actions);

  row.appendChild(body);

  // Status dot
  const dot = doc.createElement("span");
  dot.style.cssText =
    "width:6px;height:6px;border-radius:50%;flex-shrink:0;margin-top:3px;";
  switch (paper.status) {
    case "included":
      dot.style.background = "#16a34a";
      break;
    case "maybe":
      dot.style.background = "#d97706";
      break;
    case "excluded":
      dot.style.background = "#dc2626";
      break;
    default:
      dot.style.background = "var(--border-primary)";
      break;
  }
  row.appendChild(dot);
  return row;
}

function crEl(doc: Document, text: string): HTMLElement {
  const el = doc.createElement("span");
  el.textContent = text;
  el.style.cssText = "flex-shrink:0;";
  return el;
}

function abstractSourceLabel(
  source: ItemMeta["abstractSource"],
  fallback?: boolean,
): string {
  switch (source) {
    case "field":
      return "Abstract (Zotero field)";
    case "same_title_note":
      return "Abstract (from same-title note)";
    case "pdf":
      return fallback
        ? "Abstract (PDF, first paragraph — no abstract section found)"
        : "Abstract (from PDF)";
    case "notes":
      return "Abstract (from notes)";
    default:
      return "Abstract";
  }
}

function buildAbstractSection(doc: Document, m: ItemMeta): HTMLElement | null {
  const wrapper = doc.createElement("div");
  wrapper.className = "sr-abstract-section";
  wrapper.setAttribute("data-paper-id", String(m.id));
  wrapper.style.cssText =
    "margin-bottom:12px;min-width:0;max-width:100%;overflow:hidden;";

  const renderLabel = (labelText: string, titleText?: string): HTMLElement => {
    const absLbl = doc.createElement("div");
    absLbl.textContent = labelText;
    absLbl.style.cssText =
      "font-size:10px;font-weight:600;color:var(--text-tertiary);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;";
    if (titleText) absLbl.title = titleText;
    return absLbl;
  };

  const renderText = (text: string): HTMLElement => {
    const absTxt = doc.createElement("div");
    const absFragments = hlText(doc, text);
    absFragments.forEach((f) => absTxt.appendChild(f));
    absTxt.style.cssText =
      "font-size:12px;color:var(--text-primary);line-height:1.6;max-width:100%;min-width:0;overflow-wrap:break-word;word-break:break-word;white-space:pre-wrap;";
    return absTxt;
  };

  const renderPlaceholder = (msg: string): HTMLElement => {
    const ph = doc.createElement("div");
    ph.style.cssText =
      "font-size:11px;color:var(--text-tertiary);font-style:italic;line-height:1.5;";
    ph.textContent = msg;
    return ph;
  };

  if (m.abstract) {
    wrapper.appendChild(
      renderLabel(
        abstractSourceLabel(m.abstractSource, m.abstractFallback),
        `Resolved from ${m.abstractSource}${m.abstractFallback ? " (first paragraph fallback)" : ""}`,
      ),
    );
    wrapper.appendChild(renderText(m.abstract));
  } else if (m.abstractPending) {
    wrapper.appendChild(
      renderLabel(
        abstractSourceLabel("none"),
        "Falling back to same-title notes, then PDF",
      ),
    );
    wrapper.appendChild(
      renderPlaceholder(
        "No abstract found yet. Looking up same-title notes and PDF…",
      ),
    );
    enrichItemAbstractFromPdf(m.id).catch(() => undefined);
  } else {
    wrapper.appendChild(renderLabel(abstractSourceLabel("none")));
    wrapper.appendChild(
      renderPlaceholder(
        "No abstract, same-title note, or PDF text was found for this paper.",
      ),
    );
  }

  if (m.abstractPending || (!m.abstract && m.abstractSource === "none")) {
    const unsubscribe = onAbstractResolved((resolvedId) => {
      if (resolvedId !== m.id) return;
      const cached = itemMetaCache.get(m.id);
      if (!cached) return;
      wrapper.replaceChildren();
      if (cached.abstract) {
        wrapper.appendChild(
          renderLabel(
            abstractSourceLabel(cached.abstractSource, cached.abstractFallback),
            `Resolved from ${cached.abstractSource}${cached.abstractFallback ? " (first paragraph fallback)" : ""}`,
          ),
        );
        wrapper.appendChild(renderText(cached.abstract));
      } else {
        wrapper.appendChild(renderLabel(abstractSourceLabel("none")));
        wrapper.appendChild(
          renderPlaceholder(
            "No abstract, same-title note, or PDF text was found for this paper.",
          ),
        );
      }
    });
    wrapper.addEventListener("DOMNodeRemoved", unsubscribe, { once: true });
  }

  return wrapper;
}

// ============================================================
// DETAIL VIEW (CENTER PANEL)
// ============================================================
function buildDetailView(doc: Document): HTMLElement {
  if (!currentState) return doc.createElement("div");
  const center = doc.createElement("div");
  center.className = "sr-screening-detail";
  center.setAttribute("tabindex", "0");
  center.style.cssText =
    "flex:1;min-width:0;display:flex;flex-direction:column;overflow:hidden;border-right:1px solid var(--border-primary);outline:none;";
  center.addEventListener("pointerdown", (event: Event) => {
    if (isShortcutInput(event.target)) return;
    center.focus({ preventScroll: true });
  });
  center.addEventListener("keydown", (event: Event) => {
    handleScreeningShortcut(doc, event as KeyboardEvent);
  });

  if (scrActive === null) {
    const empty = doc.createElement("div");
    empty.style.cssText =
      "display:flex;flex-direction:column;align-items:center;justify-content:center;flex:1;color:var(--text-tertiary);text-align:center;gap:8px;";
    const svgIcon = doc.createElementNS(SVG_NS, "svg") as unknown as SVGElement;
    svgIcon.setAttribute("width", "40");
    svgIcon.setAttribute("height", "40");
    svgIcon.setAttribute("viewBox", "0 0 48 48");
    svgIcon.setAttribute("fill", "none");
    svgIcon.style.cssText = "opacity:0.3;flex-shrink:0;";
    const svgRect = doc.createElementNS(SVG_NS, "rect");
    svgRect.setAttribute("x", "8");
    svgRect.setAttribute("y", "6");
    svgRect.setAttribute("width", "32");
    svgRect.setAttribute("height", "36");
    svgRect.setAttribute("rx", "3");
    svgRect.setAttribute("stroke", "currentColor");
    svgRect.setAttribute("stroke-width", "2");
    svgIcon.appendChild(svgRect);
    empty.appendChild(svgIcon);
    const text = doc.createElement("div");
    text.textContent = "Select an article";
    text.style.cssText =
      "font-size:13px;font-weight:500;color:var(--text-secondary);";
    empty.appendChild(text);
    center.appendChild(empty);
    return center;
  }

  const paper = currentState.papers.find(
    (p: SystematicReviewPaper) => p.id === scrActive,
  );
  if (!paper) {
    center.appendChild(doc.createElement("div"));
    return center;
  }

  const m = getItemMeta(paper.id);
  const title = m.title || `Item ${paper.id}`;
  const authors = m.authors;
  const year = m.year;
  const doi = m.doi;
  const journal = m.journal;

  // Body
  const body = doc.createElement("div");
  body.className = "sr-article-detail-scroll";
  body.style.cssText =
    "flex:1;overflow-y:auto;overflow-x:hidden;padding:16px;min-width:0;max-width:100%;";

  // Title
  const titleEl = doc.createElement("div");
  titleEl.textContent = title;
  titleEl.className = "sr-detail-title";
  titleEl.title = "Click to select in Zotero library";
  titleEl.style.cssText =
    "font-size:14px;font-weight:600;color:var(--text-primary);line-height:1.4;margin-bottom:8px;cursor:pointer;overflow-wrap:break-word;word-break:break-word;max-width:100%;min-width:0;";
  titleEl.addEventListener("mouseenter", () => {
    titleEl.style.textDecoration = "underline";
  });
  titleEl.addEventListener("mouseleave", () => {
    titleEl.style.textDecoration = "none";
  });
  titleEl.addEventListener("click", async (e: MouseEvent) => {
    if (e.shiftKey || e.ctrlKey || e.metaKey) return;
    if (e.detail === 2) {
      const item = Zotero.Items.get(paper.id);
      if (item) {
        const attachmentIds = item.getAttachments();
        for (const attachId of attachmentIds) {
          const attachment = Zotero.Items.get(attachId);
          if (
            attachment &&
            attachment.isPDFAttachment &&
            attachment.isPDFAttachment()
          ) {
            try {
              const tabs = ztoolkit.getGlobal("Zotero_Tabs");
              if (tabs && typeof tabs.select === "function") {
                tabs.select("zotero-pane");
              }
              await Zotero.Reader.open(attachment.id);
              return;
            } catch {
              // fall through to selectItem
            }
          }
        }
      }
    }
    selectItemInZotero(paper.id);
  });
  body.appendChild(titleEl);

  // Status + Confidence row
  const statusRow = doc.createElement("div");
  statusRow.style.cssText =
    "display:flex;align-items:center;gap:8px;margin-bottom:10px;flex-wrap:wrap;";
  const statusColors: Record<string, string> = {
    included: "#16a34a",
    maybe: "#d97706",
    excluded: "#dc2626",
    undecided: "var(--text-tertiary)",
  };
  const statusBg: Record<string, string> = {
    included: "#dcfce7",
    maybe: "#fef3c7",
    excluded: "#fce4ec",
    undecided: "var(--background-secondary)",
  };
  const statusBadge = doc.createElement("span");
  statusBadge.textContent =
    paper.status.charAt(0).toUpperCase() + paper.status.slice(1);
  statusBadge.style.cssText =
    "padding:2px 8px;border-radius:10px;font-size:10px;font-weight:600;background:" +
    (statusBg[paper.status] || "var(--background-secondary)") +
    ";color:" +
    (statusColors[paper.status] || "var(--text-tertiary)") +
    ";";
  statusRow.appendChild(statusBadge);

  const confidence = getPaperConfidence(paper);
  if (confidence) {
    const cfColor =
      confidence.value >= 0.8
        ? "#16a34a"
        : confidence.value >= 0.5
          ? "#d97706"
          : "#dc2626";
    const cfLabel =
      confidence.value >= 0.8
        ? "High"
        : confidence.value >= 0.5
          ? "Medium"
          : "Low";
    const cfPill = doc.createElement("span");
    cfPill.textContent = `${confidence.source === "ai" ? "AI" : "Keyword"} confidence: ${cfLabel} ${Math.round(confidence.value * 100)}%`;
    cfPill.title =
      confidence.source === "ai"
        ? "Model-reported confidence from AI paper analysis"
        : "Heuristic keyword confidence based on match strength, separation, and configured-keyword coverage";
    cfPill.style.cssText =
      "padding:2px 8px;border-radius:10px;font-size:10px;font-weight:600;background:" +
      cfColor +
      "22;color:" +
      cfColor +
      ";";
    statusRow.appendChild(cfPill);
  }

  if (paper.recommendation) {
    const aiTag = doc.createElement("span");
    aiTag.textContent =
      paper.recommendation.source === "model"
        ? `AI suggestion: ${paper.recommendation.decision}`
        : `Keyword suggestion: ${paper.recommendation.decision}`;
    aiTag.title = paper.recommendation.rationale;
    aiTag.style.cssText =
      "padding:2px 6px;border-radius:3px;font-size:8px;font-weight:700;background:#e0f2fe;color:#0369a1;";
    statusRow.appendChild(aiTag);
  }

  if (paper.status === "excluded" && paper.exclReason) {
    const reasonTag = doc.createElement("span");
    reasonTag.textContent = paper.exclReason;
    reasonTag.style.cssText =
      "padding:2px 6px;border-radius:3px;font-size:9px;color:#dc2626;background:#fce4ec;";
    statusRow.appendChild(reasonTag);
  }

  const extrCount = (currentState?.extractions[paper.id] || []).length;
  if (extrCount > 0) {
    const rows = currentState?.extractions[paper.id] || [];
    const proposed = rows.filter(
      (row) => row.verificationStatus === "proposed",
    ).length;
    const verified = rows.filter(
      (row) => row.verificationStatus === "verified",
    ).length;
    const issues = rows.filter((row) =>
      row.issues?.some((issue) => issue.severity === "error"),
    ).length;
    const extrTag = doc.createElement("span");
    extrTag.textContent = issues
      ? `${issues} extraction issue${issues === 1 ? "" : "s"}`
      : verified
        ? `${verified} verified`
        : `${proposed} awaiting review`;
    extrTag.style.cssText =
      "padding:2px 6px;border-radius:3px;font-size:9px;color:" +
      (issues ? "#b45309" : verified ? "#16a34a" : "#0369a1") +
      ";background:" +
      (issues ? "#fef3c7" : verified ? "#dcfce7" : "#e0f2fe") +
      ";";
    statusRow.appendChild(extrTag);
  }
  const sourceSummary =
    paper.analysis?.sourceSummary || paper.recommendation?.sourceSummary;
  if (sourceSummary) {
    const sourceTag = doc.createElement("span");
    sourceTag.textContent =
      sourceSummary.kind.replaceAll("_", " ") +
      (sourceSummary.truncated ? " · sampled" : "");
    sourceTag.title = `${sourceSummary.suppliedCharacters}/${sourceSummary.totalCharacters} source characters supplied`;
    sourceTag.style.cssText =
      "padding:2px 6px;border-radius:3px;font-size:9px;color:var(--text-secondary);background:var(--background-secondary);";
    statusRow.appendChild(sourceTag);
  }
  const sourceSelect = doc.createElement("select");
  [
    ["auto", "Source: Auto"],
    ["pdf", "Source: PDF"],
    ["same_title_note", "Source: OCR/full-text note"],
    ["notes", "Source: Notes"],
    ["abstract", "Source: Abstract"],
  ].forEach(([value, label]) => {
    const option = doc.createElement("option");
    option.value = value;
    option.textContent = label;
    option.selected = (paper.sourcePreference || "auto") === value;
    sourceSelect.appendChild(option);
  });
  sourceSelect.title =
    "Choose the source used by the next AI analysis or extraction";
  sourceSelect.style.cssText =
    "padding:2px 5px;border:1px solid var(--border-primary);border-radius:3px;background:var(--background-primary);color:var(--text-secondary);font-size:9px;";
  sourceSelect.addEventListener("change", async () => {
    if (!currentState) return;
    paper.sourcePreference = sourceSelect.value as
      | "auto"
      | "pdf"
      | "same_title_note"
      | "notes"
      | "abstract";
    await getSRService().save(currentState);
    toast(doc, "Source preference saved for the next AI run");
  });
  statusRow.appendChild(sourceSelect);

  body.appendChild(statusRow);

  // Meta
  const meta = doc.createElement("div");
  meta.style.cssText =
    "display:flex;flex-wrap:wrap;gap:8px 16px;margin-bottom:16px;font-size:11px;color:var(--text-secondary);";
  if (authors) meta.appendChild(metaRow(doc, "Authors", authors));
  if (year) meta.appendChild(metaRow(doc, "Year", year));
  if (journal) meta.appendChild(metaRow(doc, "Journal", journal));
  if (doi) meta.appendChild(metaRow(doc, "DOI", doi));
  const paperSources = getPaperSources(paper.id);
  if (paperSources.length > 0) {
    meta.appendChild(
      metaRow(
        doc,
        "Sources",
        paperSources
          .map((source) => `${source.srcLabel} (${source.type})`)
          .join(", "),
      ),
    );
  }
  body.appendChild(meta);

  // Abstract with keyword highlighting
  const abstractSection = buildAbstractSection(doc, m);
  if (abstractSection) {
    body.appendChild(abstractSection);
  }

  if (paper.analysis) {
    const analysisSection = doc.createElement("div");
    analysisSection.style.cssText =
      "padding:10px;margin-bottom:12px;border-radius:6px;background:var(--background-secondary);";
    const heading = doc.createElement("div");
    heading.textContent = `Grounded analysis (${paper.analysis.model})`;
    heading.style.cssText =
      "font-size:10px;font-weight:600;color:var(--text-primary);margin-bottom:6px;";
    analysisSection.appendChild(heading);
    const fields: Array<[string, string | number | string[] | undefined]> = [
      ["Study design", paper.analysis.studyDesign],
      ["Population", paper.analysis.population],
      ["Intervention", paper.analysis.intervention],
      ["Comparator", paper.analysis.comparator],
      ["Outcomes", paper.analysis.outcomes],
      ["Sample size", paper.analysis.sampleSize],
      ["Methods", paper.analysis.methods],
      ["Limitations", paper.analysis.limitations],
    ];
    fields.forEach(([label, value]) => {
      if (value === undefined) return;
      const row = doc.createElement("div");
      row.style.cssText =
        "font-size:10px;color:var(--text-secondary);margin-bottom:3px;line-height:1.4;";
      const strong = doc.createElement("strong");
      strong.textContent = label + ": ";
      row.appendChild(strong);
      row.appendChild(
        doc.createTextNode(
          Array.isArray(value) ? value.join(", ") : String(value),
        ),
      );
      analysisSection.appendChild(row);
    });
    paper.analysis.evidence.forEach((evidence) => {
      const quote = doc.createElement("blockquote");
      quote.textContent = `${evidence.field}: “${evidence.quote}”`;
      quote.style.cssText =
        "margin:5px 0;padding-left:8px;border-left:2px solid var(--border-primary);font-size:9px;color:var(--text-tertiary);";
      analysisSection.appendChild(quote);
    });
    if (paper.recommendation?.criteria?.length) {
      const criteriaHeading = doc.createElement("div");
      const met = paper.recommendation.criteria.filter(
        (criterion) => criterion.verdict === "met",
      ).length;
      const failed = paper.recommendation.criteria.filter(
        (criterion) => criterion.verdict === "not_met",
      ).length;
      const unclear = paper.recommendation.criteria.filter(
        (criterion) => criterion.verdict === "unclear",
      ).length;
      criteriaHeading.textContent = `Eligibility assessment: ${met} met · ${failed} not met · ${unclear} unclear`;
      criteriaHeading.style.cssText =
        "font-size:10px;font-weight:600;margin:8px 0 4px;";
      analysisSection.appendChild(criteriaHeading);
      paper.recommendation.criteria.forEach((criterion) => {
        const criterionRow = doc.createElement("details");
        const summary = doc.createElement("summary");
        summary.textContent = `${criterion.verdict.replace("_", " ")} · ${criterion.criterionId}`;
        summary.style.cssText =
          "font-size:9px;cursor:pointer;color:var(--text-secondary);";
        criterionRow.appendChild(summary);
        const detail = doc.createElement("div");
        detail.textContent =
          criterion.rationale +
          (criterion.quote ? ` Evidence: “${criterion.quote}”` : "");
        detail.style.cssText =
          "padding:3px 8px;font-size:9px;color:var(--text-tertiary);";
        criterionRow.appendChild(detail);
        analysisSection.appendChild(criterionRow);
      });
    }
    body.appendChild(analysisSection);
  }

  // Keyword diff bar
  const space = getActiveSpace();
  if (space) {
    const kwDiff = kwDiffBar(doc, paper);
    if (kwDiff.childNodes.length > 0) {
      body.appendChild(kwDiff);
    }
  }

  // Labels section
  const labelsSec = doc.createElement("div");
  labelsSec.style.cssText = "margin-bottom:12px;";
  const labelsLbl = doc.createElement("div");
  labelsLbl.textContent = "Labels";
  labelsLbl.style.cssText =
    "font-size:10px;font-weight:600;color:var(--text-tertiary);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;";
  labelsSec.appendChild(labelsLbl);
  const labelChips = renderLabelChips(doc, paper.id);
  labelsSec.appendChild(labelChips);
  body.appendChild(labelsSec);

  const criteriaToggle = doc.createElement("button");
  criteriaToggle.textContent = showPaperCriteria
    ? "Hide Criteria"
    : "Show Criteria";
  criteriaToggle.setAttribute("aria-expanded", String(showPaperCriteria));
  criteriaToggle.style.cssText =
    "width:100%;padding:6px 8px;margin-bottom:8px;border:1px solid var(--border-primary);border-radius:5px;background:var(--background-secondary);color:var(--text-secondary);font:inherit;font-size:10px;font-weight:700;text-align:left;cursor:pointer;";
  criteriaToggle.addEventListener("click", () => {
    showPaperCriteria = !showPaperCriteria;
    Zotero.Prefs.set(
      "extensions.zotero.seerai.srShowPaperCriteria",
      showPaperCriteria,
    );
    reRenderPanel(doc, "screening");
  });
  body.appendChild(criteriaToggle);
  if (showPaperCriteria) {
    const revision = getActiveProtocolRevision(
      getActiveSpace()?.protocol || currentState.protocol,
    );
    const criteria = doc.createElement("div");
    criteria.style.cssText =
      "margin-bottom:12px;padding:9px;border:1px solid var(--border-secondary);border-radius:7px;background:var(--background-secondary);";
    (["include", "exclude"] as const).forEach((type) => {
      const group = doc.createElement("div");
      group.style.cssText = "margin-bottom:7px;";
      const heading = doc.createElement("div");
      heading.textContent =
        type === "include" ? "Inclusion criteria" : "Exclusion criteria";
      heading.style.cssText = `font-size:9px;font-weight:700;color:${
        type === "include" ? "#15803d" : "#b91c1c"
      };margin-bottom:3px;`;
      group.appendChild(heading);
      const rules = revision.eligibilityRules.filter(
        (rule) => rule.type === type,
      );
      if (rules.length === 0) {
        const empty = doc.createElement("div");
        empty.textContent = "No criteria configured.";
        empty.style.cssText = "font-size:9px;color:var(--text-tertiary);";
        group.appendChild(empty);
      }
      rules.forEach((rule) => {
        const row = doc.createElement("div");
        row.textContent = `• ${rule.text}`;
        row.style.cssText =
          "padding:2px 0;font-size:9px;line-height:1.4;color:var(--text-secondary);";
        group.appendChild(row);
      });
      criteria.appendChild(group);
    });
    body.appendChild(criteria);
  }

  center.appendChild(body);

  // Decision footer
  const foot = buildDecisionFooter(doc, paper);
  center.appendChild(foot);

  return center;
}

function isShortcutInput(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  if (!element || typeof element.closest !== "function") return false;
  return Boolean(
    element.closest(
      "input, textarea, select, button, a, summary, [contenteditable='true']",
    ),
  );
}

function handleScreeningShortcut(doc: Document, event: KeyboardEvent): void {
  if (
    !currentState ||
    currentPanel !== "screening" ||
    isShortcutInput(event.target) ||
    mainWrapper?.querySelector("[data-review-sheet='true']")
  ) {
    return;
  }
  if (
    event.ctrlKey &&
    !event.altKey &&
    !event.metaKey &&
    event.key.toLowerCase() === "z"
  ) {
    event.preventDefault();
    undoDecision(doc);
    return;
  }
  if (event.ctrlKey || event.altKey || event.metaKey) return;
  const key = event.key.toLowerCase();
  if (key === "1") {
    event.preventDefault();
    if (scrActive !== null) applyDecision("included", doc);
  } else if (key === "2") {
    event.preventDefault();
    if (scrActive !== null) applyDecision("maybe", doc);
  } else if (key === "3") {
    event.preventDefault();
    if (scrActive !== null) applyDecision("excluded", doc);
  } else if (key === "4") {
    event.preventDefault();
    const paper = currentState.papers.find((paper) => paper.id === scrActive);
    if (paper?.recommendation) acceptCurrentSuggestion(doc, paper.id);
  } else if (key === "5") {
    event.preventDefault();
    showPaperCriteria = !showPaperCriteria;
    Zotero.Prefs.set(
      "extensions.zotero.seerai.srShowPaperCriteria",
      showPaperCriteria,
    );
    selectScreeningPaper(doc, scrActive, { resetDetailScroll: false });
  } else if (key === "w" || key === "a" || event.key === "ArrowUp") {
    event.preventDefault();
    navigateToPrev(doc);
  } else if (key === "s" || key === "d" || event.key === "ArrowDown") {
    event.preventDefault();
    navigateToNext(doc);
  } else if (event.key === "Escape" && scrActive !== null) {
    event.preventDefault();
    showNote = false;
    showReason = false;
    showSourceLabelRow = false;
    scrActive = null;
    selectScreeningPaper(doc, null, { resetDetailScroll: true });
  }
}

function metaRow(doc: Document, label: string, value: string): HTMLElement {
  const el = doc.createElement("span");
  el.style.cssText = "";
  const strong = doc.createElement("strong");
  strong.textContent = label + ": ";
  strong.style.cssText = "color:var(--text-primary);font-weight:600;";
  el.appendChild(strong);
  el.appendChild(doc.createTextNode(value));
  return el;
}

function buildDecisionFooter(
  doc: Document,
  paper: SystematicReviewPaper,
): HTMLElement {
  if (!currentState) return doc.createElement("div");
  const foot = doc.createElement("div");
  foot.style.cssText =
    "flex-shrink:0;border-top:1px solid var(--border-primary);padding:5px 6px;background:var(--background-secondary);display:flex;flex-direction:column;gap:3px;";

  const actRow = doc.createElement("div");
  actRow.style.cssText =
    "display:flex;align-items:center;gap:3px;flex-wrap:wrap;";
  actRow.appendChild(
    buildDecisionBtn(doc, "Include", "#16a34a", "included", paper, "1"),
  );
  actRow.appendChild(
    buildDecisionBtn(doc, "Maybe", "#d97706", "maybe", paper, "2"),
  );
  actRow.appendChild(
    buildDecisionBtn(doc, "Exclude", "#dc2626", "excluded", paper, "3"),
  );
  if (paper.recommendation) {
    const suggestionBtn = doc.createElement("button");
    suggestionBtn.textContent =
      paper.recommendation.source === "model"
        ? "Accept AI suggestion"
        : "Accept keyword suggestion";
    suggestionBtn.title = `Accept the current recommendation: ${paper.recommendation.rationale}`;
    suggestionBtn.style.cssText =
      "padding:2px 6px;font-size:9px;border:1px solid #0284c7;border-radius:3px;background:#e0f2fe;color:#0369a1;cursor:pointer;font-family:inherit;";
    suggestionBtn.addEventListener("click", () => {
      acceptCurrentSuggestion(doc, paper.id);
    });
    actRow.appendChild(suggestionBtn);
  }
  const spc = doc.createElement("span");
  spc.style.cssText = "flex:1;min-width:0;";
  actRow.appendChild(spc);

  const reaBtn = doc.createElement("button");
  reaBtn.textContent = "Reason";
  reaBtn.style.cssText =
    "padding:2px 6px;font-size:10px;border:1px solid var(--border-primary);border-radius:3px;background:transparent;color:var(--text-secondary);cursor:pointer;font-family:inherit;";
  reaBtn.addEventListener("click", () => {
    showNote = false;
    showReason = !showReason;
    reRenderPanel(doc, "screening");
  });
  actRow.appendChild(reaBtn);

  const noteBtn = doc.createElement("button");
  noteBtn.textContent = "Note";
  noteBtn.style.cssText =
    "padding:2px 6px;font-size:10px;border:1px solid var(--border-primary);border-radius:3px;background:transparent;color:var(--text-secondary);cursor:pointer;font-family:inherit;";
  noteBtn.addEventListener("click", () => {
    showReason = false;
    showSourceLabelRow = false;
    showNote = !showNote;
    reRenderPanel(doc, "screening");
  });
  actRow.appendChild(noteBtn);

  const sourceBtn = doc.createElement("button");
  sourceBtn.textContent = "Source";
  sourceBtn.style.cssText =
    "padding:2px 6px;font-size:10px;border:1px solid var(--border-primary);border-radius:3px;background:transparent;color:var(--text-secondary);cursor:pointer;font-family:inherit;";
  sourceBtn.addEventListener("click", () => {
    showNote = false;
    showReason = false;
    showSourceLabelRow = !showSourceLabelRow;
    reRenderPanel(doc, "screening");
  });
  actRow.appendChild(sourceBtn);

  const lblBtn = doc.createElement("button");
  lblBtn.textContent = "Label";
  lblBtn.style.cssText =
    "padding:2px 6px;font-size:10px;border:1px solid var(--border-primary);border-radius:3px;background:transparent;color:var(--text-secondary);cursor:pointer;font-family:inherit;";
  lblBtn.addEventListener("click", () => {
    toggleLabelRow(doc);
  });
  actRow.appendChild(lblBtn);

  const extractionRows = currentState.extractions[paper.id] || [];
  const proposedExtractions = extractionRows.filter(
    (row) => row.verificationStatus === "proposed",
  ).length;
  const verifiedExtractions = extractionRows.filter(
    (row) => row.verificationStatus === "verified",
  ).length;
  const extractionIssues = extractionRows.filter((row) =>
    row.issues?.some((issue) => issue.severity === "error"),
  ).length;
  const activeExtractionJob = currentState.reviewJobs
    .slice()
    .reverse()
    .find(
      (job) =>
        job.kind === "extraction" &&
        ["queued", "running", "paused"].includes(job.status) &&
        job.paperIds.includes(paper.id),
    );
  const activeExtractionTask = activeExtractionJob?.papers.find(
    (task) => task.paperId === paper.id,
  );
  const extBtn = doc.createElement("button");
  extBtn.textContent = activeExtractionTask
    ? `Cancel ${formatJobStage(activeExtractionTask.stage)}`
    : proposedExtractions || extractionIssues
      ? `Review ${proposedExtractions + extractionIssues}`
      : verifiedExtractions
        ? `Verified ${verifiedExtractions}`
        : "Extract";
  extBtn.title = activeExtractionTask
    ? "Cancel the active extraction job"
    : extractionRows.length
      ? "Open extraction proposals and verification"
      : getSRService().getExtractionTemplate(currentState)
        ? "Extract data using the active template"
        : "Create and approve an extraction template";
  extBtn.style.cssText =
    "padding:2px 8px;font-size:10px;font-weight:600;border:1px solid " +
    (activeExtractionJob
      ? "#dc2626"
      : extractionIssues
        ? "#d97706"
        : "#0369a1") +
    ";border-radius:4px;background:" +
    (activeExtractionJob ? "#dc2626" : "#0369a1") +
    ";color:#fff;cursor:pointer;font-family:inherit;";
  extBtn.addEventListener("click", async () => {
    if (!currentState) return;
    if (activeExtractionJob) {
      getSRService().cancelReviewJob(currentState, activeExtractionJob.id);
      await getSRService().save(currentState);
      reRenderPanel(doc, "screening");
      return;
    }
    if (
      extractionRows.length ||
      !getSRService().getExtractionTemplate(currentState)
    ) {
      openExtractionModal(doc, paper.id);
      return;
    }
    try {
      await getSRService().startReviewJob(currentState, "extraction", [
        paper.id,
      ]);
      reRenderPanel(doc, "screening");
    } catch (error) {
      toast(doc, error instanceof Error ? error.message : String(error));
    }
  });
  actRow.appendChild(extBtn);

  const activeAnalysisJob = currentState?.reviewJobs
    .slice()
    .reverse()
    .find(
      (job) =>
        job.kind === "analysis" &&
        ["queued", "running", "paused"].includes(job.status) &&
        job.paperIds.includes(paper.id),
    );
  const activeAnalysisTask = activeAnalysisJob?.papers.find(
    (task) => task.paperId === paper.id,
  );
  const anlBtn = doc.createElement("button");
  anlBtn.textContent = activeAnalysisTask
    ? `Cancel ${formatJobStage(activeAnalysisTask.stage)}`
    : "Analyze";
  anlBtn.title =
    activeAnalysisTask?.error ||
    (activeAnalysisJob
      ? "Cancel the active analysis job for this paper"
      : "Analyze this paper");
  anlBtn.style.cssText =
    "padding:2px 8px;font-size:10px;font-weight:600;border:1px solid " +
    (activeAnalysisJob ? "#dc2626" : "#7c3aed") +
    ";border-radius:4px;background:" +
    (activeAnalysisJob ? "#dc2626" : "#7c3aed") +
    ";color:#fff;cursor:pointer;font-family:inherit;";
  anlBtn.addEventListener("click", async () => {
    const pTitle = getItemMeta(paper.id).title || "paper #" + paper.id;
    if (activeAnalysisJob && currentState) {
      getSRService().cancelReviewJob(currentState, activeAnalysisJob.id);
      await getSRService().save(currentState);
      toast(doc, "Analysis cancelled: " + trunc(pTitle, 40));
      reRenderPanel(doc, "screening");
      return;
    }
    anlBtn.disabled = true;
    anlBtn.textContent = "Queued...";
    try {
      if (!currentState) return;
      const job = await getSRService().startReviewJob(
        currentState,
        "analysis",
        [paper.id],
      );
      toast(doc, "Analysis job started: " + trunc(pTitle, 40));
      const timer = setInterval(() => {
        const latest = currentState?.reviewJobs.find(
          (candidate) => candidate.id === job.id,
        );
        const task = latest?.papers[0];
        if (task) anlBtn.textContent = formatJobStage(task.stage);
        if (
          !latest ||
          ["completed", "failed", "cancelled"].includes(latest.status)
        ) {
          clearInterval(timer);
          reRenderPanel(doc, "screening");
        }
      }, 500);
    } catch (error) {
      anlBtn.disabled = false;
      anlBtn.textContent = "Analyze";
      toast(
        doc,
        "Analysis failed: " +
          (error instanceof Error ? error.message : String(error)),
      );
    }
  });
  actRow.appendChild(anlBtn);
  const latestAnalysisFailure = currentState?.reviewJobs
    .slice()
    .reverse()
    .find(
      (job) =>
        job.kind === "analysis" &&
        ["failed", "interrupted"].includes(job.status) &&
        job.paperIds.includes(paper.id),
    )
    ?.papers.find((task) => task.paperId === paper.id)?.error;
  if (latestAnalysisFailure) {
    const failure = doc.createElement("span");
    failure.textContent = trunc(latestAnalysisFailure, 90);
    failure.title = latestAnalysisFailure;
    failure.style.cssText =
      "flex-basis:100%;font-size:9px;color:#dc2626;line-height:1.3;";
    actRow.appendChild(failure);
  }

  foot.appendChild(actRow);

  // Reason row
  if (showReason && paper.status === "excluded") {
    const reasonRow = doc.createElement("div");
    reasonRow.style.cssText = "display:flex;align-items:center;gap:4px;";
    const reasonSel = doc.createElement("select") as HTMLSelectElement;
    reasonSel.style.cssText =
      "flex:1;font-size:10px;padding:2px 4px;border:1px solid var(--border-primary);border-radius:4px;background:var(--background-primary);color:var(--text-primary);font-family:inherit;";
    const emptyOpt = doc.createElement("option");
    emptyOpt.value = "";
    emptyOpt.textContent = "Select exclusion reason...";
    reasonSel.appendChild(emptyOpt);
    EXCL_REASONS.forEach((r: string) => {
      const opt = doc.createElement("option");
      opt.value = r;
      opt.textContent = r;
      if (paper.exclReason === r) opt.selected = true;
      reasonSel.appendChild(opt);
    });
    reasonRow.appendChild(reasonSel);
    const applyBtn = doc.createElement("button");
    applyBtn.textContent = "Apply";
    applyBtn.style.cssText =
      "padding:2px 6px;font-size:10px;border-radius:3px;background:var(--highlight-primary);color:#fff;border:none;cursor:pointer;font-family:inherit;";
    applyBtn.addEventListener("click", () => {
      getSRService().setDecision(
        currentState!,
        paper.id,
        "excluded",
        reasonSel.value || undefined,
      );
      showReason = false;
      saveSRState();
      reRenderPanel(doc, "screening");
    });
    reasonRow.appendChild(applyBtn);
    foot.appendChild(reasonRow);
  }

  // Label picker row
  if (showLabelRow) {
    const lblRow = doc.createElement("div");
    lblRow.style.cssText = "display:flex;align-items:center;gap:4px;";
    lblRow.appendChild(renderLabelPicker(doc, paper.id));
    const doneBtn = doc.createElement("button");
    doneBtn.textContent = "Done";
    doneBtn.style.cssText =
      "padding:2px 6px;font-size:10px;border:1px solid var(--border-primary);border-radius:3px;background:transparent;color:var(--text-secondary);cursor:pointer;font-family:inherit;flex-shrink:0;";
    doneBtn.addEventListener("click", () => {
      showLabelRow = false;
      reRenderPanel(doc, "screening");
    });
    lblRow.appendChild(doneBtn);
    foot.appendChild(lblRow);
  }

  // Note row
  if (showNote) {
    const noteRow = doc.createElement("div");
    noteRow.style.cssText = "display:flex;align-items:center;gap:4px;";
    const noteInput = doc.createElement("input") as HTMLInputElement;
    noteInput.type = "text";
    noteInput.placeholder = "Add screening note...";
    noteInput.value = paper.note || "";
    noteInput.style.cssText =
      "flex:1;border:1px solid var(--border-primary);border-radius:4px;padding:2px 6px;font-size:10px;background:var(--background-primary);color:var(--text-primary);outline:none;font-family:inherit;";
    noteRow.appendChild(noteInput);
    const saveBtn = doc.createElement("button");
    saveBtn.textContent = "Save";
    saveBtn.style.cssText =
      "padding:2px 6px;font-size:10px;border-radius:3px;background:var(--highlight-primary);color:#fff;border:none;cursor:pointer;font-family:inherit;";
    saveBtn.addEventListener("click", () => {
      paper.note = noteInput.value;
      showNote = false;
      saveSRState();
      reRenderPanel(doc, "screening");
    });
    noteRow.appendChild(saveBtn);
    const cancelBtn = doc.createElement("button");
    cancelBtn.textContent = "Cancel";
    cancelBtn.style.cssText =
      "padding:2px 6px;font-size:10px;border:1px solid var(--border-primary);border-radius:3px;background:transparent;color:var(--text-secondary);cursor:pointer;font-family:inherit;";
    cancelBtn.addEventListener("click", () => {
      showNote = false;
      reRenderPanel(doc, "screening");
    });
    noteRow.appendChild(cancelBtn);
    foot.appendChild(noteRow);
  }

  if (showSourceLabelRow) {
    const srcRow = doc.createElement("div");
    srcRow.style.cssText = "display:flex;align-items:center;gap:4px;";
    const srcInput = doc.createElement("input") as HTMLInputElement;
    srcInput.type = "text";
    srcInput.placeholder = "Set source label (optional)";
    srcInput.value = paper.sourceLabel || "";
    srcInput.style.cssText =
      "flex:1;border:1px solid var(--border-primary);border-radius:4px;padding:2px 6px;font-size:10px;background:var(--background-primary);color:var(--text-primary);outline:none;font-family:inherit;";
    srcRow.appendChild(srcInput);
    const saveSrcBtn = doc.createElement("button");
    saveSrcBtn.textContent = "Save";
    saveSrcBtn.style.cssText =
      "padding:2px 6px;font-size:10px;border-radius:3px;background:var(--highlight-primary);color:#fff;border:none;cursor:pointer;font-family:inherit;";
    saveSrcBtn.addEventListener("click", () => {
      const trimmed = srcInput.value.trim();
      if (trimmed) {
        paper.sourceLabel = trimmed;
      } else {
        delete paper.sourceLabel;
      }
      showSourceLabelRow = false;
      saveSRState();
      reRenderPanel(doc, "screening");
    });
    srcRow.appendChild(saveSrcBtn);
    const cancelSrcBtn = doc.createElement("button");
    cancelSrcBtn.textContent = "Cancel";
    cancelSrcBtn.style.cssText =
      "padding:2px 6px;font-size:10px;border:1px solid var(--border-primary);border-radius:3px;background:transparent;color:var(--text-secondary);cursor:pointer;font-family:inherit;";
    cancelSrcBtn.addEventListener("click", () => {
      showSourceLabelRow = false;
      reRenderPanel(doc, "screening");
    });
    srcRow.appendChild(cancelSrcBtn);
    foot.appendChild(srcRow);
  }

  return foot;
}

function buildDecisionBtn(
  doc: Document,
  label: string,
  color: string,
  status: ScreeningDecision,
  paper: SystematicReviewPaper,
  shortcut?: string,
): HTMLElement {
  const isActive = paper.status === status;
  const btn = doc.createElement("button");
  btn.style.cssText =
    "display:inline-flex;align-items:center;gap:2px;padding:2px 8px;border-radius:4px;border:1px solid " +
    color +
    ";background:" +
    (isActive ? color : "transparent") +
    ";color:" +
    (isActive ? "#fff" : color) +
    ";font-size:10px;font-weight:600;cursor:pointer;font-family:inherit;transition:all 0.1s;opacity:" +
    (isActive ? "1" : "0.82") +
    ";";
  btn.replaceChildren();
  if (isActive)
    btn.appendChild(
      createSvgIcon(btn.ownerDocument!, ICONS.check, "active", 12),
    );
  btn.appendChild(
    btn.ownerDocument!.createTextNode(isActive ? ` ${label}` : label),
  );
  if (shortcut) {
    btn.title = `Shortcut ${shortcut}`;
  }
  btn.addEventListener("click", () => {
    applyDecision(status, doc);
  });
  return btn;
}

// ============================================================
// FILTERS PANEL (RIGHT)
// ============================================================
function buildFiltersPanel(
  doc: Document,
  initialSizes?: ResponsiveSizes,
): HTMLElement {
  if (!currentState) return doc.createElement("div");
  const right = doc.createElement("div");
  right.className = "sr-filters-panel";
  const initialWidth = initialSizes?.filtersWidth ?? reviewFiltersWidth;
  const initialMin = initialSizes?.filtersMinWidth ?? 60;
  right.style.cssText = `width:${initialWidth}px;min-width:${initialMin}px;max-width:350px;flex-shrink:0;border-left:1px solid var(--border-primary);display:flex;flex-direction:column;overflow:hidden;`;
  const hdr = doc.createElement("div");
  hdr.setAttribute("data-sr-filters-hdr", "true");
  hdr.style.cssText =
    "display:flex;align-items:center;justify-content:space-between;padding:4px 8px;border-bottom:1px solid var(--border-primary);background:var(--background-secondary);font-size:10px;font-weight:600;color:var(--text-tertiary);text-transform:uppercase;letter-spacing:0.5px;flex-shrink:0;";
  const hdrLabel = doc.createElement("span");
  hdrLabel.setAttribute("data-sr-filters-hdr-label", "true");
  hdrLabel.textContent = "Filters";
  hdr.appendChild(hdrLabel);

  // Collapse toggle button
  const toggleBtn = doc.createElement("button");
  toggleBtn.title = "Toggle filter panel";
  toggleBtn.style.cssText =
    "display:flex;align-items:center;justify-content:center;width:20px;height:20px;border:none;background:transparent;color:var(--text-tertiary);cursor:pointer;border-radius:3px;padding:0;";
  const toggleSvg = doc.createElementNS(SVG_NS, "svg") as unknown as SVGElement;
  toggleSvg.setAttribute("width", "14");
  toggleSvg.setAttribute("height", "14");
  toggleSvg.setAttribute("viewBox", "0 0 16 16");
  toggleSvg.setAttribute("fill", "none");
  const togglePath = doc.createElementNS(SVG_NS, "path");
  togglePath.setAttribute("data-sr-filters-toggle-path", "true");
  togglePath.setAttribute("d", "M6 3l5 5-5 5");
  togglePath.setAttribute("stroke", "currentColor");
  togglePath.setAttribute("stroke-width", "1.8");
  togglePath.setAttribute("stroke-linecap", "round");
  togglePath.setAttribute("stroke-linejoin", "round");
  toggleSvg.appendChild(togglePath);
  toggleBtn.appendChild(toggleSvg);
  toggleBtn.addEventListener("click", () => {
    filtersCollapsed = !filtersCollapsed;
    filtersAutoCollapsed = false;
    filtersUserTouched = true;
    applyCollapsedState();
    Zotero.Prefs.set(
      "extensions.zotero.seerai.srFiltersCollapsed",
      filtersCollapsed,
    );
    refreshReviewLayout?.();
  });
  hdr.appendChild(toggleBtn);
  right.appendChild(hdr);
  const body = doc.createElement("div");
  body.style.cssText = "flex:1;overflow-y:auto;padding:4px;";
  body.id = "sr-filters-body";
  const applyCollapsedState = (): void => {
    const shell =
      (mainWrapper && mainWrapper.isConnected
        ? mainWrapper
        : (doc.querySelector(".sr-shell") as HTMLElement | null)) ||
      doc.documentElement;
    const shellWidth = shell?.getBoundingClientRect().width || 900;
    const sizes = computeResponsiveSizes(shellWidth);
    const expandedWidth = sizes.filtersWidth;
    const expandedMin = sizes.filtersMinWidth;
    const effective = filtersCollapsed || filtersAutoCollapsed;
    hdrLabel.style.display = effective ? "none" : "";
    hdr.style.padding = effective ? "5px" : "4px 8px";
    hdr.style.justifyContent = effective ? "center" : "space-between";
    body.style.display = effective ? "none" : "";
    togglePath.setAttribute("d", effective ? "M10 3L5 8l5 5" : "M6 3l5 5-5 5");
    if (effective) {
      right.style.setProperty("width", "30px");
      right.style.setProperty("min-width", "30px");
    } else {
      right.style.setProperty("width", `${expandedWidth}px`);
      right.style.setProperty("min-width", `${expandedMin}px`);
    }
  };
  const sections = buildFilterSections();
  sections.forEach((sec: any) => {
    const enabled = filterEnabled.has(sec.id);
    const isOpen = filterOpen.has(sec.id);
    const selSet = activeFilters[sec.id] || new Set();
    const secDiv = doc.createElement("div");
    secDiv.style.cssText =
      "margin-bottom:4px;border:1px solid " +
      (enabled ? "var(--highlight-primary)" : "var(--border-secondary)") +
      ";border-radius:6px;overflow:hidden;";
    const secHdr = doc.createElement("div");
    secHdr.style.cssText =
      "display:flex;align-items:center;gap:4px;padding:3px 5px;background:" +
      (enabled ? "var(--background-primary)" : "var(--background-secondary)") +
      ";cursor:pointer;user-select:none;border-bottom:" +
      (isOpen ? "1px solid var(--border-secondary)" : "none") +
      ";font-size:10px;font-weight:600;color:var(--text-primary);";
    secHdr.addEventListener("click", () => {
      if (filterOpen.has(sec.id)) filterOpen.delete(sec.id);
      else filterOpen.add(sec.id);
      saveSRState();
      reRenderPanel(doc, "screening");
    });
    const chevron = doc.createElementNS(SVG_NS, "svg") as unknown as SVGElement;
    chevron.setAttribute("width", "8");
    chevron.setAttribute("height", "8");
    chevron.setAttribute("viewBox", "0 0 16 16");
    chevron.setAttribute("fill", "none");
    chevron.style.cssText =
      "flex-shrink:0;transition:transform 0.15s;" +
      (isOpen ? "transform:rotate(90deg);" : "");
    const cp = doc.createElementNS(SVG_NS, "path");
    cp.setAttribute("d", "M6 3l5 5-5 5");
    cp.setAttribute("stroke", "currentColor");
    cp.setAttribute("stroke-width", "1.8");
    cp.setAttribute("stroke-linecap", "round");
    cp.setAttribute("stroke-linejoin", "round");
    chevron.appendChild(cp);
    secHdr.appendChild(chevron);
    const labelSpan = doc.createElement("span");
    labelSpan.textContent = sec.label;
    labelSpan.style.cssText =
      "flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
    secHdr.appendChild(labelSpan);
    if (sec.values) {
      const cntS = doc.createElement("span");
      cntS.textContent = String(sec.values.length);
      cntS.style.cssText =
        "font-size:8px;color:var(--text-tertiary);margin-left:auto;margin-right:2px;";
      secHdr.appendChild(cntS);
    }
    const tog = doc.createElement("span");
    tog.textContent = enabled ? "on" : "off";
    tog.style.cssText =
      "font-size:8px;padding:0 3px;border:1px solid var(--border-primary);border-radius:3px;cursor:pointer;" +
      (enabled
        ? "background:var(--highlight-primary);color:#fff;border-color:var(--highlight-primary);"
        : "");
    tog.addEventListener("click", (e: Event) => {
      e.stopPropagation();
      if (filterEnabled.has(sec.id)) {
        filterEnabled.delete(sec.id);
        activeFilters[sec.id] = new Set();
      } else {
        filterEnabled.add(sec.id);
        if (!filterOpen.has(sec.id)) filterOpen.add(sec.id);
        if (
          sec.type === "kw" &&
          (!activeFilters[sec.id] || activeFilters[sec.id].size === 0)
        ) {
          const space = getActiveSpace();
          const keywords =
            sec.keywordType === "include"
              ? space?.incKeywords || []
              : space?.excKeywords || [];
          activeFilters[sec.id] = new Set(keywords);
        }
      }
      saveSRState();
      reRenderPanel(doc, "screening");
    });
    secHdr.appendChild(tog);
    secDiv.appendChild(secHdr);
    if (isOpen) {
      const secBody = doc.createElement("div");
      secBody.style.cssText =
        "max-height:140px;overflow-y:auto;padding:2px 4px;";
      if (sec.type === "kw") {
        const space = getActiveSpace();
        const keywords =
          sec.keywordType === "include"
            ? space?.incKeywords || []
            : space?.excKeywords || [];
        keywords.forEach((kw: string) => {
          const rowLbl = doc.createElement("label");
          rowLbl.style.cssText =
            "display:flex;align-items:center;gap:4px;padding:1px 0;font-size:10px;color:var(--text-primary);cursor:pointer;";
          const cb2 = doc.createElement("input") as HTMLInputElement;
          cb2.type = "checkbox";
          cb2.style.cssText = "margin:0;accent-color:var(--highlight-primary);";
          cb2.checked = selSet.has(kw);
          cb2.addEventListener("change", () => {
            if (!activeFilters[sec.id]) activeFilters[sec.id] = new Set();
            if (cb2.checked) activeFilters[sec.id].add(kw);
            else activeFilters[sec.id].delete(kw);
            saveSRState();
            reRenderPanel(doc, "screening");
          });
          rowLbl.appendChild(cb2);
          rowLbl.appendChild(doc.createTextNode(kw));
          secBody.appendChild(rowLbl);
        });
      } else if (sec.values) {
        sec.values.forEach((v: any) => {
          const active = selSet.has(v.v);
          const valRow = doc.createElement("div");
          valRow.style.cssText =
            "display:flex;align-items:center;gap:4px;padding:1px 2px;font-size:10px;color:" +
            (active ? "var(--highlight-primary)" : "var(--text-primary)") +
            ";cursor:pointer;border-radius:3px;font-weight:" +
            (active ? "600" : "400") +
            ";";
          valRow.addEventListener("click", () => {
            if (!filterEnabled.has(sec.id)) {
              filterEnabled.add(sec.id);
              if (!filterOpen.has(sec.id)) filterOpen.add(sec.id);
            }
            if (!activeFilters[sec.id]) activeFilters[sec.id] = new Set();
            if (activeFilters[sec.id].has(v.v)) {
              activeFilters[sec.id].delete(v.v);
            } else {
              activeFilters[sec.id].add(v.v);
            }
            if (activeFilters[sec.id].size === 0) {
              filterEnabled.delete(sec.id);
              delete activeFilters[sec.id];
            }
            saveSRState();
            reRenderPanel(doc, "screening");
          });
          valRow.addEventListener("mouseenter", () => {
            valRow.style.background = "var(--background-secondary)";
          });
          valRow.addEventListener("mouseleave", () => {
            valRow.style.background = "transparent";
          });
          if (v.color) {
            const dot = doc.createElement("span");
            dot.style.cssText =
              "width:8px;height:8px;border-radius:3px;flex-shrink:0;background:" +
              v.color +
              ";";
            valRow.appendChild(dot);
          }
          const name = doc.createElement("span");
          name.textContent = v.label;
          name.style.cssText =
            "flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
          valRow.appendChild(name);
          const cnt2 = doc.createElement("span");
          cnt2.textContent = String(v.n);
          cnt2.style.cssText =
            "font-size:8px;padding:0 4px;border-radius:8px;min-width:14px;text-align:center;font-variant-numeric:tabular-nums;flex-shrink:0;color:var(--text-tertiary);";
          valRow.appendChild(cnt2);
          secBody.appendChild(valRow);
        });
      }
      secDiv.appendChild(secBody);
    }
    body.appendChild(secDiv);
  });
  right.appendChild(body);
  applyCollapsedState();
  return right;
}

function buildFilterSections(): any[] {
  if (!currentState) return [];
  const papers = currentState.papers;
  const sections: any[] = [];
  sections.push({
    id: "includeKeywords",
    label: "Inclusion Keywords",
    type: "kw",
    keywordType: "include",
  });
  sections.push({
    id: "excludeKeywords",
    label: "Exclusion Keywords",
    type: "kw",
    keywordType: "exclude",
  });
  const lblVals: any[] = [];
  currentState.labelDefs.forEach((ld: LabelDefinition) => {
    let cnt = 0;
    Object.keys(currentState!.paperLabels).forEach((k: string) => {
      if (currentState!.paperLabels[parseInt(k)]?.includes(ld.k)) cnt++;
    });
    if (cnt > 0)
      lblVals.push({
        v: ld.k,
        label: ld.name,
        n: cnt,
        color: ld.color,
        bg: ld.bg,
      });
  });
  if (lblVals.length > 0)
    sections.push({ id: "labels", label: "Labels", values: lblVals });
  const statusCounts: Record<string, number> = {};
  papers.forEach((p: SystematicReviewPaper) => {
    statusCounts[p.status] = (statusCounts[p.status] || 0) + 1;
  });
  const sc: Record<string, string> = {
    included: "#16a34a",
    maybe: "#d97706",
    excluded: "#dc2626",
    undecided: "#71717a",
  };
  const sVals = Object.entries(statusCounts).map(([k, n]) => ({
    v: k,
    label: k.charAt(0).toUpperCase() + k.slice(1),
    n,
    color: sc[k] || "#71717a",
  }));
  if (sVals.length > 1)
    sections.push({ id: "status", label: "Screening Status", values: sVals });
  const erMap: Record<string, number> = {};
  papers.forEach((p: SystematicReviewPaper) => {
    if (p.exclReason) erMap[p.exclReason] = (erMap[p.exclReason] || 0) + 1;
  });
  const erVals = Object.entries(erMap).map(([k, n]) => ({ v: k, label: k, n }));
  if (erVals.length > 0)
    sections.push({
      id: "exclReasons",
      label: "Exclusion Reasons",
      values: erVals,
    });
  const confMap: Record<string, number> = { high: 0, medium: 0, low: 0 };
  papers.forEach((p: SystematicReviewPaper) => {
    const confidence = getPaperConfidence(p)?.value;
    if (confidence === undefined) return;
    if (confidence >= 0.7) confMap.high++;
    else if (confidence >= 0.4) confMap.medium++;
    else confMap.low++;
  });
  const cc: Record<string, string> = {
    high: "#16a34a",
    medium: "#d97706",
    low: "#dc2626",
  };
  const cVals = Object.entries(confMap)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => ({
      v: k,
      label: k.charAt(0).toUpperCase() + k.slice(1),
      n,
      color: cc[k],
    }));
  if (cVals.length > 1)
    sections.push({
      id: "confidence",
      label: "Confidence",
      values: cVals,
    });

  // Publication Types (from paper.design)
  const ptMap: Record<string, number> = {};
  papers.forEach((p: SystematicReviewPaper) => {
    const d = p.design || "Unknown";
    ptMap[d] = (ptMap[d] || 0) + 1;
  });
  const ptVals = Object.entries(ptMap)
    .map(([k, n]) => ({ v: k, label: k, n }))
    .sort((a, b) => b.n - a.n);
  if (ptVals.length > 1)
    sections.push({
      id: "pubTypes",
      label: "Publication Types",
      values: ptVals,
    });

  // Evidence Level (from paper.ev)
  const evMap: Record<string, number> = {};
  papers.forEach((p: SystematicReviewPaper) => {
    const e = p.ev || "Unknown";
    evMap[e] = (evMap[e] || 0) + 1;
  });
  const evVals = Object.entries(evMap).map(([k, n]) => ({
    v: k,
    label: k,
    n,
  }));
  if (evVals.length > 1)
    sections.push({ id: "evidence", label: "Evidence Level", values: evVals });

  // Journals (from Zotero items)
  const jMap: Record<string, number> = {};
  papers.forEach((p: SystematicReviewPaper) => {
    const j = getItemMeta(p.id).journal || "Unknown";
    jMap[j] = (jMap[j] || 0) + 1;
  });
  const jVals = Object.entries(jMap)
    .map(([k, n]) => ({ v: k, label: k, n }))
    .sort((a, b) => b.n - a.n);
  if (jVals.length > 1)
    sections.push({ id: "journals", label: "Journals", values: jVals });

  // Authors (first author)
  const aMap: Record<string, number> = {};
  papers.forEach((p: SystematicReviewPaper) => {
    const a = getItemMeta(p.id).authors.split(",")[0]?.trim() || "Unknown";
    aMap[a] = (aMap[a] || 0) + 1;
  });
  const aVals = Object.entries(aMap)
    .map(([k, n]) => ({ v: k, label: k, n }))
    .sort((a, b) => b.n - a.n);
  if (aVals.length > 1)
    sections.push({ id: "authors", label: "Authors", values: aVals });

  // Risk of Bias (from paper.bias)
  const bMap: Record<string, number> = {};
  papers.forEach((p: SystematicReviewPaper) => {
    const b = p.bias || "Unknown";
    bMap[b] = (bMap[b] || 0) + 1;
  });
  const bVals = Object.entries(bMap).map(([k, n]) => ({
    v: k,
    label: k,
    n,
  }));
  if (bVals.length > 1)
    sections.push({ id: "bias", label: "Risk of Bias", values: bVals });

  // Years (5-year buckets)
  const yMap: Record<string, number> = {};
  papers.forEach((p: SystematicReviewPaper) => {
    const yr = parseInt(getItemMeta(p.id).year || "0");
    if (yr > 0) {
      const bucket = Math.floor(yr / 5) * 5;
      const key = bucket + "-" + (bucket + 4);
      yMap[key] = (yMap[key] || 0) + 1;
    }
  });
  const yVals = Object.entries(yMap)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, n]) => ({ v: k, label: k, n }));
  if (yVals.length > 1)
    sections.push({ id: "years", label: "Years", values: yVals });

  return sections;
}

// ============================================================
// BATCH BAR
// ============================================================
function buildBatchBar(_doc: Document): HTMLElement {
  const doc = _doc;
  const bar = doc.createElement("div");
  bar.className = "sr-batch";
  bar.style.cssText =
    "display:flex;align-items:center;gap:3px;padding:3px 4px;border-top:1px solid var(--border-primary);flex-shrink:0;flex-wrap:wrap;font-size:9px;";
  if (scrSelected.size === 0) {
    bar.style.display = "none";
    return bar;
  }
  const count = doc.createElement("span");
  count.textContent = scrSelected.size + " selected";
  count.style.cssText =
    "font-size:9px;color:var(--text-secondary);margin-right:auto;";
  bar.appendChild(count);
  bar.appendChild(
    batchBtn(doc, "Include", "#16a34a", () =>
      applyBatchDecision("included", doc),
    ),
  );
  bar.appendChild(
    batchBtn(doc, "Maybe", "#d97706", () => applyBatchDecision("maybe", doc)),
  );
  bar.appendChild(
    batchBtn(doc, "Exclude", "#dc2626", () =>
      applyBatchDecision("excluded", doc),
    ),
  );
  bar.appendChild(
    batchBtn(doc, "Undo", "var(--text-secondary)", () =>
      applyBatchDecision("undecided", doc),
    ),
  );
  bar.appendChild(
    batchBtn(doc, "Analyze", "#7c3aed", async () => {
      if (!currentState || scrSelected.size === 0) return;
      try {
        const job = await getSRService().startReviewJob(
          currentState,
          "analysis",
          Array.from(scrSelected),
        );
        toast(doc, `Analysis queued for ${job.paperIds.length} paper(s)`);
        scrSelected.clear();
        reRenderPanel(doc, "screening");
      } catch (error) {
        toast(doc, error instanceof Error ? error.message : String(error));
      }
    }),
  );
  bar.appendChild(
    batchBtn(doc, "Extract", "#0369a1", async () => {
      if (!currentState || scrSelected.size === 0) return;
      const ids = Array.from(scrSelected);
      let includedCount = 0;
      const includeUndo: Array<{
        id: number;
        prevStatus: ScreeningDecision;
        prevStage: string | undefined;
        prevReason: string | undefined;
      }> = [];
      ids.forEach((id) => {
        const paper = currentState!.papers.find(
          (candidate) => candidate.id === id,
        );
        if (!paper) return;
        if (paper.status !== "included") {
          includeUndo.push({
            id,
            prevStatus: paper.status,
            prevStage: paper.screeningStage,
            prevReason: paper.exclReason,
          });
          getSRService().setDecision(
            currentState!,
            id,
            "included",
            undefined,
            "final",
          );
          includedCount++;
        } else if (paper.screeningStage !== "final") {
          includeUndo.push({
            id,
            prevStatus: paper.status,
            prevStage: paper.screeningStage,
            prevReason: paper.exclReason,
          });
          paper.screeningStage = "final";
        }
      });
      const space = getActiveSpace();
      if (space) {
        ids.forEach((id) => {
          if (space.paperStatus[id] !== "included") {
            space.paperStatus[id] = "included";
          }
        });
      }
      try {
        const job = await getSRService().startReviewJob(
          currentState,
          "extraction",
          ids,
        );
        await getSRService().save(currentState);
        const includeNote = includedCount
          ? `Marked ${includedCount} paper(s) as included and `
          : "";
        toast(
          doc,
          `${includeNote}Extraction queued for ${job.paperIds.length} paper(s)`,
        );
        scrSelected.clear();
        reRenderPanel(doc, "screening");
        void includeUndo;
      } catch (error) {
        includeUndo.forEach((entry) => {
          const paper = currentState!.papers.find(
            (candidate) => candidate.id === entry.id,
          );
          if (!paper) return;
          paper.status = entry.prevStatus;
          paper.screeningStage = entry.prevStage as
            | "title_abstract"
            | "full_text"
            | "final"
            | undefined;
          paper.exclReason = entry.prevReason;
        });
        await getSRService().save(currentState);
        toast(doc, error instanceof Error ? error.message : String(error));
      }
    }),
  );
  bar.appendChild(
    batchBtn(doc, "+Table", "var(--text-secondary)", () => {
      if (!currentState || scrSelected.size === 0) return;
      const n = scrSelected.size;
      const items = Array.from(scrSelected)
        .map((id: number) => Zotero.Items.get(id) as Zotero.Item)
        .filter(Boolean);
      if (items.length > 0) {
        (addon.api as any).Assistant.addItemsToCurrentTable(items).then(() => {
          scrSelected.clear();
          toast(doc, n + " paper(s) added to table");
          reRenderPanel(doc, "screening");
        });
      } else {
        toast(doc, "No valid items to add to table");
      }
    }),
  );
  bar.appendChild(
    batchBtn(doc, "+Ctx", "var(--text-secondary)", () => {
      if (!currentState || scrSelected.size === 0) return;
      const n = scrSelected.size;
      const ctxMgr = ChatContextManager.getInstance();
      scrSelected.forEach((id: number) => {
        const item = Zotero.Items.get(id);
        if (item) {
          const title = (item.getField("title") as string) || `Item ${id}`;
          ctxMgr.addItem(id, "paper", title, "selection");
        }
      });
      scrSelected.clear();
      toast(doc, n + " paper(s) added to chat context");
      reRenderPanel(doc, "screening");
    }),
  );
  bar.appendChild(
    batchBtn(doc, "Del", "#dc2626", () => {
      if (!currentState || scrSelected.size === 0) return;
      const confirmed = doc.defaultView?.confirm(
        `Remove ${scrSelected.size} paper(s) from this review project? Zotero items will not be deleted.`,
      );
      if (!confirmed) return;
      const removed = getSRService().removePapers(
        currentState,
        Array.from(scrSelected),
      );
      removed.forEach((id) => {
        _srPaperIdSet.delete(id);
        invalidateItemCache(id);
      });
      scrSelected.clear();
      saveSRState();
      toast(doc, removed.length + " paper(s) removed from the review");
      reRenderPanel(doc, "screening");
    }),
  );
  const clearBtn = doc.createElement("button");
  clearBtn.textContent = "Clear";
  clearBtn.style.cssText =
    "padding:1px 5px;font-size:9px;border:1px solid var(--border-primary);border-radius:3px;background:transparent;color:var(--text-secondary);cursor:pointer;font-family:inherit;";
  clearBtn.addEventListener("click", () => {
    scrSelected.clear();
    reRenderPanel(doc, "screening");
  });
  bar.appendChild(clearBtn);
  return bar;
}

function formatJobStage(stage: string): string {
  return stage
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function batchBtn(
  doc: Document,
  label: string,
  color: string,
  onClick: () => void,
): HTMLElement {
  const btn = doc.createElement("button");
  btn.textContent = label;
  btn.style.cssText =
    "padding:1px 6px;font-size:9px;font-weight:600;border:1px solid " +
    color +
    ";border-radius:3px;background:" +
    color +
    ";color:#fff;cursor:pointer;font-family:inherit;";
  btn.addEventListener("click", onClick);
  return btn;
}

function updateBatchBar(doc: Document): void {
  const bar = doc.querySelector(".sr-batch") as HTMLElement;
  if (!bar) return;
  const parent = bar.parentElement;
  if (!parent) return;
  const newBar = buildBatchBar(doc);
  parent.replaceChild(newBar, bar);
}

function updateSelectAll(doc: Document): void {
  const cb = doc.getElementById("sr-select-all") as HTMLInputElement;
  if (!cb) return;
  const cards = doc.querySelectorAll(".sr-art-cb");
  const cardList: Element[] = Array.from(cards);
  if (cardList.length === 0) {
    cb.checked = false;
    (cb as any).indeterminate = false;
    return;
  }
  let allChecked = true;
  let someChecked = false;
  cardList.forEach((c: Element) => {
    const checked = (c as HTMLInputElement).checked;
    if (!checked) allChecked = false;
    if (checked) someChecked = true;
  });
  cb.checked = allChecked;
  (cb as any).indeterminate = someChecked && !allChecked;
}

function applyBatchDecision(status: ScreeningDecision, doc: Document): void {
  if (!currentState || scrSelected.size === 0) return;
  scrSelected.forEach((id: number) => {
    const paper = currentState!.papers.find(
      (p: SystematicReviewPaper) => p.id === id,
    );
    if (paper) {
      undoStack.push({
        id: paper.id,
        prevStatus: paper.status,
        prevReason: paper.exclReason,
        prevStage: paper.screeningStage,
      });
      if (undoStack.length > 50) undoStack.shift();
      getSRService().setDecision(currentState!, id, status, undefined, "final");
    }
  });
  getSRService().save(currentState);
  const n = scrSelected.size;
  scrSelected.clear();
  toast(doc, "Batch applied " + n + " paper(s) as " + status);
  reRenderPanel(doc, "screening");
}

// ============================================================
// EVIDENCE PANEL
// ============================================================
function buildEvidencePanel(doc: Document): HTMLElement {
  if (!currentState) return doc.createElement("div");
  const panel = doc.createElement("div");
  panel.style.cssText =
    "display:flex;flex-direction:column;flex:1;min-height:0;overflow:hidden;";
  const hdr = doc.createElement("div");
  hdr.style.cssText =
    "display:flex;align-items:center;justify-content:space-between;padding:4px 12px;border-bottom:1px solid var(--border-primary);flex-shrink:0;";
  const title = doc.createElement("div");
  title.textContent = "Evidence Synthesis";
  title.style.cssText =
    "font-size:13px;font-weight:600;color:var(--text-primary);";
  hdr.appendChild(title);
  const tabRow = doc.createElement("div");
  tabRow.style.cssText = "display:flex;gap:4px;align-items:center;";
  const overBtn = doc.createElement("button");
  overBtn.textContent = "Overview";
  overBtn.style.cssText =
    "padding:2px 10px;font-size:10px;border:none;border-bottom:2px solid " +
    (evTab === "overview" ? "var(--highlight-primary)" : "transparent") +
    ";background:transparent;color:" +
    (evTab === "overview"
      ? "var(--highlight-primary)"
      : "var(--text-secondary)") +
    ";cursor:pointer;font-family:inherit;font-weight:500;";
  overBtn.addEventListener("click", () => {
    evTab = "overview";
    reRenderPanel(doc, "evidence");
  });
  tabRow.appendChild(overBtn);
  const aiBtn2 = doc.createElement("button");
  aiBtn2.textContent = "Synthesis";
  aiBtn2.style.cssText =
    "padding:2px 10px;font-size:10px;border:none;border-bottom:2px solid " +
    (evTab === "ai" ? "var(--highlight-primary)" : "transparent") +
    ";background:transparent;color:" +
    (evTab === "ai" ? "var(--highlight-primary)" : "var(--text-secondary)") +
    ";cursor:pointer;font-family:inherit;font-weight:500;";
  aiBtn2.addEventListener("click", () => {
    evTab = "ai";
    reRenderPanel(doc, "evidence");
  });
  tabRow.appendChild(aiBtn2);
  const runBtn = doc.createElement("button");
  runBtn.textContent = "Generate Draft Synthesis";
  runBtn.style.cssText =
    "padding:2px 8px;font-size:10px;border:1px solid #7c3aed;border-radius:4px;background:#7c3aed;color:#fff;cursor:pointer;font-family:inherit;font-weight:600;margin-left:8px;";
  runBtn.addEventListener("click", async () => {
    if (!currentState) return;
    const readiness = getSRService().getSynthesisReadiness(currentState);
    if (readiness.verified === 0 && readiness.proposed === 0) {
      toast(doc, "No extraction results are available for synthesis");
      return;
    }
    let verifiedDelta = 0;
    if (readiness.verified === 0) {
      const auto = getSRService().autoVerifyValidProposals(currentState);
      verifiedDelta = auto.verifiedRows;
      if (auto.verifiedRows === 0) {
        toast(
          doc,
          "Extraction proposals are not yet valid. Open a paper to verify or correct its rows.",
        );
        return;
      }
    }
    const run = getSRService().runSynthesis(currentState, true);
    getSRService().generateGaps(currentState, run.id, true);
    await getSRService().save(currentState);
    const syn = getVerifiedSynthesis();
    evTab = "ai";
    const note = verifiedDelta
      ? `Auto-verified ${verifiedDelta} proposal(s) and drafted ${syn.kpi.domains} synthesis domain(s)`
      : `${syn.kpi.domains} synthesis domain(s) drafted`;
    toast(doc, note);
    reRenderPanel(doc, "evidence");
  });
  tabRow.appendChild(runBtn);
  const verifyAllBtn = doc.createElement("button");
  verifyAllBtn.textContent = "Verify All Valid";
  verifyAllBtn.title =
    "Verify every proposed extraction row that has no blocking issues, a source quote, and passes validation";
  verifyAllBtn.style.cssText =
    "padding:2px 8px;font-size:10px;border:1px solid #7c3aed;border-radius:4px;background:transparent;color:#7c3aed;cursor:pointer;font-family:inherit;margin-left:4px;";
  verifyAllBtn.addEventListener("click", async () => {
    if (!currentState) return;
    const result = getSRService().autoVerifyValidProposals(currentState);
    await getSRService().save(currentState);
    if (result.verifiedRows === 0) {
      toast(doc, "No valid proposals available to verify");
      return;
    }
    toast(
      doc,
      `Verified ${result.verifiedRows} proposal(s) across ${result.papers} paper(s)`,
    );
    reRenderPanel(doc, "evidence");
  });
  tabRow.appendChild(verifyAllBtn);
  const setupBtn = doc.createElement("button");
  setupBtn.textContent = "Extraction Template";
  setupBtn.style.cssText =
    "padding:2px 8px;font-size:10px;border:1px solid var(--border-primary);border-radius:4px;background:transparent;color:var(--text-secondary);cursor:pointer;font-family:inherit;margin-left:4px;";
  setupBtn.addEventListener("click", () => {
    openExtractionWorkspace(doc, included[0]?.id);
  });
  tabRow.appendChild(setupBtn);
  const extractAllBtn = doc.createElement("button");
  extractAllBtn.textContent = "Extract All Included";
  extractAllBtn.style.cssText =
    "padding:2px 8px;font-size:10px;border:1px solid #0369a1;border-radius:4px;background:#0369a1;color:#fff;cursor:pointer;font-family:inherit;margin-left:4px;";
  extractAllBtn.addEventListener("click", async () => {
    if (!currentState) return;
    const paperIds = currentState.papers
      .filter(
        (paper) =>
          paper.status === "included" &&
          (paper.screeningStage === "final" || !paper.screeningStage),
      )
      .map((paper) => paper.id);
    if (!paperIds.length) {
      toast(
        doc,
        "No included papers. Mark papers as included in Screening & Triage first.",
      );
      return;
    }
    try {
      const job = await getSRService().startReviewJob(
        currentState,
        "extraction",
        paperIds,
      );
      toast(doc, `Extraction queued for ${job.paperIds.length} paper(s)`);
      reRenderPanel(doc, "evidence");
    } catch (error) {
      toast(doc, error instanceof Error ? error.message : String(error));
    }
  });
  tabRow.appendChild(extractAllBtn);
  const analyzeAllBtn = doc.createElement("button");
  analyzeAllBtn.textContent = "Analyze All Included";
  analyzeAllBtn.title =
    "Extract included papers missing or with failed extraction, then run synthesis";
  analyzeAllBtn.style.cssText =
    "padding:2px 8px;font-size:10px;border:1px solid #7c3aed;border-radius:4px;background:#7c3aed;color:#fff;cursor:pointer;font-family:inherit;margin-left:4px;font-weight:600;";
  analyzeAllBtn.addEventListener("click", async () => {
    if (!currentState) return;
    const template = getSRService().getExtractionTemplate(currentState);
    if (!template) {
      toast(doc, "Approve an extraction template first");
      openExtractionWorkspace(doc);
      return;
    }
    const includedCount = currentState.papers.filter(
      (paper) =>
        paper.status === "included" &&
        (paper.screeningStage === "final" || !paper.screeningStage),
    ).length;
    if (!includedCount) {
      toast(
        doc,
        "No included papers. Mark papers as included in Screening & Triage first.",
      );
      return;
    }
    try {
      const job = await getSRService().startEvidenceAnalysisJob(currentState);
      toast(
        doc,
        `Evidence analysis queued for ${job.paperIds.length} paper(s) (extraction → synthesis)`,
      );
      reRenderPanel(doc, "evidence");
    } catch (error) {
      toast(doc, error instanceof Error ? error.message : String(error));
    }
  });
  tabRow.appendChild(analyzeAllBtn);
  const retryFailedBtn = doc.createElement("button");
  retryFailedBtn.textContent = "Retry Failed Fields";
  const failedCount = getPapersWithFailedExtractions(currentState).length;
  retryFailedBtn.title =
    "Re-extract papers that have any failed extraction metric";
  retryFailedBtn.style.cssText =
    "padding:2px 8px;font-size:10px;border:1px solid #b45309;border-radius:4px;background:transparent;color:#b45309;cursor:pointer;font-family:inherit;margin-left:4px;";
  if (!failedCount) {
    retryFailedBtn.disabled = true;
    retryFailedBtn.style.opacity = "0.5";
    retryFailedBtn.style.cursor = "not-allowed";
  }
  retryFailedBtn.addEventListener("click", async () => {
    if (!currentState) return;
    try {
      const job = await getSRService().startFailedExtractionRetry(currentState);
      if (!job) {
        toast(doc, "No papers with failed extractions to retry");
        return;
      }
      toast(
        doc,
        `Retry queued for ${job.paperIds.length} paper(s) with failed metrics`,
      );
      reRenderPanel(doc, "evidence");
    } catch (error) {
      toast(doc, error instanceof Error ? error.message : String(error));
    }
  });
  tabRow.appendChild(retryFailedBtn);
  const logsBtn = doc.createElement("button");
  logsBtn.textContent = "View Logs";
  logsBtn.title = "View why each paper's extraction succeeded or failed";
  logsBtn.style.cssText =
    "padding:2px 8px;font-size:10px;border:1px solid var(--border-primary);border-radius:4px;background:transparent;color:var(--text-secondary);cursor:pointer;font-family:inherit;margin-left:4px;";
  logsBtn.addEventListener("click", () => {
    openExtractionLogsModal(doc);
  });
  tabRow.appendChild(logsBtn);
  const tableBtn = doc.createElement("button");
  tableBtn.textContent = "Open in Table";
  tableBtn.style.cssText =
    "padding:2px 8px;font-size:10px;border:1px solid var(--border-primary);border-radius:4px;background:transparent;color:var(--text-secondary);cursor:pointer;font-family:inherit;margin-left:4px;";
  tableBtn.addEventListener("click", () => {
    const toAdd = included
      .map((p) => Zotero.Items.get(p.id) as Zotero.Item)
      .filter(Boolean);
    if (toAdd.length > 0) {
      (addon.api as any).Assistant.addItemsToCurrentTable(toAdd).then(() => {
        toast(doc, toAdd.length + " papers added to table");
      });
    } else {
      toast(doc, "No papers to add to table");
    }
  });
  tabRow.appendChild(tableBtn);
  hdr.appendChild(tabRow);
  panel.appendChild(hdr);
  const body = doc.createElement("div");
  body.style.cssText = "flex:1;overflow-y:auto;padding:12px;";
  const protocolRevision = getActiveProtocolRevision(currentState.protocol);
  const protocolCoverage = doc.createElement("div");
  protocolCoverage.style.cssText =
    "display:flex;align-items:flex-start;gap:8px;padding:7px 9px;margin-bottom:10px;border:1px solid var(--border-secondary);border-radius:6px;background:var(--background-secondary);font-size:9px;";
  const protocolTitle = doc.createElement("strong");
  protocolTitle.textContent = `${protocolRevision.framework} protocol`;
  protocolTitle.style.whiteSpace = "nowrap";
  protocolCoverage.appendChild(protocolTitle);
  const protocolText = doc.createElement("span");
  const mappedDimensions = protocolRevision.dimensions.filter(
    (dimension) => dimension.evidenceLabels.length > 0,
  );
  protocolText.textContent = `${protocolRevision.researchQuestion || "Question not set"} · ${mappedDimensions.length}/${protocolRevision.dimensions.length} dimensions mapped to evidence categories · revision ${protocolRevision.id}`;
  protocolText.style.cssText =
    "color:var(--text-secondary);line-height:1.4;min-width:0;";
  protocolCoverage.appendChild(protocolText);
  body.appendChild(protocolCoverage);
  const included = currentState.papers.filter(
    (p: SystematicReviewPaper) =>
      p.status === "included" &&
      (p.screeningStage === "final" || !p.screeningStage),
  );
  if (!included.length) {
    const empty = doc.createElement("div");
    empty.textContent =
      "No papers screened yet. Screen papers and apply labels in Screening to enable synthesis.";
    empty.style.cssText =
      "text-align:center;color:var(--text-tertiary);padding:32px;font-size:12px;";
    body.appendChild(empty);
  } else {
    const readiness = getSRService().getSynthesisReadiness(currentState);
    const readinessBox = doc.createElement("div");
    readinessBox.style.cssText =
      "display:grid;grid-template-columns:repeat(auto-fit,minmax(72px,1fr));gap:5px;margin-bottom:10px;";
    [
      ["Included", readiness.included],
      ["Analyzed", readiness.analyzed],
      ["Processed", readiness.processed],
      ["Proposals", readiness.proposed],
      ["Valid", readiness.valid],
      ["Verified", readiness.verified],
      ["Quarantined", readiness.quarantined],
      ["Complete", readiness.complete],
      ["Synthesis ready", readiness.synthesisReady],
    ].forEach(([label, value]) => {
      const card = doc.createElement("div");
      card.style.cssText =
        "padding:6px;text-align:center;border:1px solid var(--border-secondary);border-radius:5px;background:var(--background-primary);";
      const number = doc.createElement("strong");
      number.textContent = String(value);
      number.style.cssText = "display:block;font-size:15px;";
      card.appendChild(number);
      const caption = doc.createElement("span");
      caption.textContent = String(label);
      caption.style.cssText = "font-size:8px;color:var(--text-secondary);";
      card.appendChild(caption);
      readinessBox.appendChild(card);
    });
    body.appendChild(readinessBox);
    if (
      readiness.proposed > 0 ||
      readiness.quarantined > 0 ||
      readiness.complete < readiness.included
    ) {
      const readinessWarning = doc.createElement("div");
      readinessWarning.textContent = [
        readiness.proposed
          ? `${readiness.proposed} proposal(s) await verification`
          : "",
        readiness.quarantined
          ? `${readiness.quarantined} row(s) need correction`
          : "",
        readiness.complete < readiness.included
          ? `${readiness.included - readiness.complete} paper(s) have incomplete required outcomes`
          : "",
      ]
        .filter(Boolean)
        .join(" · ");
      readinessWarning.style.cssText =
        "padding:6px 8px;margin-bottom:10px;border-radius:5px;background:#fef3c7;color:#92400e;font-size:9px;";
      body.appendChild(readinessWarning);
    }
    renderReviewJobs(doc, body);
    let extCount = 0;
    included.forEach((p: SystematicReviewPaper) => {
      if ((currentState!.extractions[p.id] || []).length > 0) extCount++;
    });
    const extPct = included.length
      ? Math.round((extCount / included.length) * 100)
      : 0;
    const extBar = doc.createElement("div");
    extBar.style.cssText =
      "display:flex;align-items:center;gap:8px;padding:6px 8px;margin-bottom:12px;border-radius:6px;background:var(--background-primary);";
    const extLbl = doc.createElement("div");
    extLbl.textContent =
      "Extraction: " + extCount + "/" + included.length + " papers";
    extLbl.style.cssText =
      "font-size:10px;font-weight:600;color:var(--text-primary);white-space:nowrap;";
    extBar.appendChild(extLbl);
    const extTrk = doc.createElement("div");
    extTrk.style.cssText =
      "flex:1;height:6px;border-radius:3px;overflow:hidden;background:var(--background-secondary);";
    const extFl = doc.createElement("div");
    extFl.style.cssText =
      "height:100%;width:" +
      extPct +
      "%;background:" +
      (extPct >= 50
        ? "#16a34a"
        : extPct > 0
          ? "#d97706"
          : "var(--text-tertiary)") +
      ";border-radius:3px;transition:width 0.4s;";
    extTrk.appendChild(extFl);
    extBar.appendChild(extTrk);
    const extPctEl = doc.createElement("div");
    extPctEl.textContent = extPct + "%";
    extPctEl.style.cssText =
      "font-size:9px;color:var(--text-tertiary);white-space:nowrap;";
    extBar.appendChild(extPctEl);
    if (extCount < included.length) {
      const navBtn = doc.createElement("button");
      navBtn.textContent = "Needs extraction";
      navBtn.style.cssText =
        "padding:2px 8px;font-size:9px;border:1px solid var(--border-primary);border-radius:3px;background:transparent;color:var(--text-secondary);cursor:pointer;font-family:inherit;white-space:nowrap;flex-shrink:0;";
      navBtn.addEventListener("click", () => {
        // Find first included paper without extractions
        const unextracted = included.find(
          (p: SystematicReviewPaper) =>
            !(currentState!.extractions[p.id] || []).length,
        );
        if (unextracted) {
          scrActive = unextracted.id;
          currentPanel = "screening";
          reRenderPanel(doc, "screening");
          setTimeout(() => {
            openExtractionModal(doc, unextracted.id);
          }, 100);
        }
      });
      extBar.appendChild(navBtn);
    }
    body.appendChild(extBar);
    renderExtractionReviewQueue(doc, body, included);
    if (evTab === "overview") {
      buildEvOverview(doc, body, included);
    } else {
      buildEvAISynthesis(doc, body, included);
    }
  }
  panel.appendChild(body);
  return panel;
}

function renderExtractionReviewQueue(
  doc: Document,
  body: HTMLElement,
  included: SystematicReviewPaper[],
): void {
  if (!currentState) return;
  const section = doc.createElement("section");
  section.style.cssText =
    "margin-bottom:12px;border:1px solid var(--border-secondary);border-radius:7px;overflow:hidden;";
  const heading = doc.createElement("div");
  heading.textContent =
    "Extraction review queue · proposed results require reviewer verification before synthesis";
  heading.style.cssText =
    "padding:7px 9px;font-size:10px;font-weight:600;background:var(--background-secondary);";
  section.appendChild(heading);
  const table = doc.createElement("table");
  table.style.cssText =
    "width:100%;border-collapse:collapse;font-size:9px;table-layout:fixed;";
  const header = doc.createElement("tr");
  [
    "Paper",
    "Job",
    "Proposed",
    "Verified",
    "Issues",
    "Required",
    "Synthesis",
    "",
  ].forEach((label, index) => {
    const cell = doc.createElement("th");
    cell.textContent = label;
    cell.style.cssText =
      "padding:5px;text-align:" +
      (index === 0 ? "left" : "center") +
      ";border-bottom:1px solid var(--border-primary);";
    header.appendChild(cell);
  });
  table.appendChild(header);
  const template = getSRService().getExtractionTemplate(currentState);
  included.forEach((paper) => {
    const rows = currentState!.extractions[paper.id] || [];
    const proposed = rows.filter(
      (row) => row.verificationStatus === "proposed",
    ).length;
    const verified = rows.filter(
      (row) => row.verificationStatus === "verified",
    ).length;
    const issues = rows.filter((row) =>
      row.issues?.some((issue) => issue.severity === "error"),
    ).length;
    const requiredComplete =
      !!template &&
      template.outcomes
        .filter((outcome) => outcome.required)
        .every((outcome) =>
          rows.some(
            (row) =>
              row.outcomeId === outcome.id &&
              row.verificationStatus === "verified",
          ),
        );
    const synthesisReady = rows.some(
      (row) =>
        row.verificationStatus === "verified" &&
        validateExtractionRow(row).valid,
    );
    const task = currentState!.reviewJobs
      .filter((job) => job.kind === "extraction")
      .slice()
      .reverse()
      .flatMap((job) => job.papers)
      .find((candidate) => candidate.paperId === paper.id);
    const row = doc.createElement("tr");
    const title = doc.createElement("td");
    title.textContent = trunc(
      getItemMeta(paper.id).title || `Paper ${paper.id}`,
      54,
    );
    title.title = getItemMeta(paper.id).title;
    title.style.cssText =
      "padding:6px;border-bottom:1px solid var(--border-secondary);font-weight:500;";
    row.appendChild(title);
    [
      task ? formatJobStage(task.stage) : "Not processed",
      String(proposed),
      String(verified),
      String(issues),
      requiredComplete ? "Complete" : "Missing",
      synthesisReady ? "Ready" : "Not ready",
    ].forEach((value, index) => {
      const cell = doc.createElement("td");
      cell.textContent = value;
      cell.style.cssText =
        "padding:6px;text-align:center;border-bottom:1px solid var(--border-secondary);color:" +
        (index === 3 && issues
          ? "#dc2626"
          : index === 5 && synthesisReady
            ? "#16a34a"
            : "var(--text-secondary)") +
        ";";
      row.appendChild(cell);
    });
    const actionCell = doc.createElement("td");
    actionCell.style.cssText =
      "padding:4px;text-align:center;border-bottom:1px solid var(--border-secondary);";
    const action = doc.createElement("button");
    action.textContent = rows.length ? "Review" : "Extract";
    action.style.cssText =
      "padding:2px 7px;border:1px solid #0369a1;border-radius:4px;background:transparent;color:#0369a1;cursor:pointer;font-size:9px;";
    action.addEventListener("click", async () => {
      if (!currentState) return;
      if (rows.length || !template) {
        openExtractionWorkspace(doc, paper.id);
        return;
      }
      try {
        await getSRService().startReviewJob(currentState, "extraction", [
          paper.id,
        ]);
        reRenderPanel(doc, "evidence");
      } catch (error) {
        toast(doc, error instanceof Error ? error.message : String(error));
      }
    });
    actionCell.appendChild(action);
    row.appendChild(actionCell);
    table.appendChild(row);
  });
  section.appendChild(table);
  body.appendChild(section);
}

function renderReviewJobs(doc: Document, body: HTMLElement): void {
  if (!currentState || !currentState.reviewJobs.length) return;
  const jobs = [...currentState.reviewJobs].reverse().slice(0, 5);
  const section = doc.createElement("div");
  section.style.cssText =
    "margin-bottom:10px;border:1px solid var(--border-secondary);border-radius:6px;overflow:hidden;";
  jobs.forEach((job) => {
    const row = doc.createElement("div");
    row.style.cssText =
      "display:flex;align-items:center;gap:7px;padding:6px 8px;border-bottom:1px solid var(--border-secondary);font-size:9px;";
    const label = doc.createElement("strong");
    label.textContent =
      job.kind === "analysis" ? "Study analysis" : "Data extraction";
    row.appendChild(label);
    const completed = job.papers.filter(
      (paper) => paper.stage === "completed",
    ).length;
    const failed = job.papers.filter(
      (paper) => paper.stage === "failed",
    ).length;
    const issues = job.papers.reduce(
      (sum, paper) => sum + (paper.issueCount || 0),
      0,
    );
    const progress = doc.createElement("span");
    progress.textContent = `${completed}/${job.papers.length} · ${formatJobStage(job.status)}${failed ? ` · ${failed} failed` : ""}${issues ? ` · ${issues} issue(s)` : ""}`;
    progress.style.cssText = "color:var(--text-secondary);";
    row.appendChild(progress);
    const jobError =
      job.error || job.papers.find((paper) => paper.error)?.error;
    if (jobError) {
      progress.title = jobError;
      progress.textContent += ` · ${trunc(jobError, 70)}`;
      progress.style.color = "#dc2626";
    }
    const currentTask = job.papers.find((paper) =>
      ["reading_source", "extracting", "validating", "saving"].includes(
        paper.stage,
      ),
    );
    if (currentTask) {
      const stage = doc.createElement("span");
      stage.textContent = formatJobStage(currentTask.stage);
      stage.style.cssText = "color:#7c3aed;";
      row.appendChild(stage);
    }
    const spacer = doc.createElement("span");
    spacer.style.flex = "1";
    row.appendChild(spacer);
    if (job.status === "running" || job.status === "queued") {
      const pause = doc.createElement("button");
      pause.textContent = "Pause";
      pause.addEventListener("click", async () => {
        if (!currentState) return;
        getSRService().pauseReviewJob(currentState, job.id);
        await getSRService().save(currentState);
        reRenderPanel(doc, "evidence");
      });
      row.appendChild(pause);
      const cancel = doc.createElement("button");
      cancel.textContent = "Cancel";
      cancel.addEventListener("click", async () => {
        if (!currentState) return;
        getSRService().cancelReviewJob(currentState, job.id);
        await getSRService().save(currentState);
        reRenderPanel(doc, "evidence");
      });
      row.appendChild(cancel);
    } else if (
      ["paused", "failed", "cancelled", "interrupted"].includes(job.status)
    ) {
      const retry = doc.createElement("button");
      retry.textContent = job.status === "paused" ? "Resume" : "Retry";
      retry.addEventListener("click", async () => {
        if (!currentState) return;
        await getSRService().retryReviewJob(currentState, job.id);
        reRenderPanel(doc, "evidence");
      });
      row.appendChild(retry);
    }
    Array.from(row.querySelectorAll("button")).forEach((button) => {
      (button as HTMLElement).style.cssText =
        "padding:1px 6px;border:1px solid var(--border-primary);border-radius:3px;background:transparent;color:var(--text-secondary);cursor:pointer;font-size:9px;";
    });
    section.appendChild(row);
  });
  body.appendChild(section);
}

function buildEvOverview(
  doc: Document,
  body: HTMLElement,
  included: SystematicReviewPaper[],
): void {
  const labelCounts: Record<string, { def: LabelDefinition; count: number }> =
    {};
  currentState!.labelDefs.forEach((ld: LabelDefinition) => {
    labelCounts[ld.k] = { def: ld, count: 0 };
  });
  included.forEach((p: SystematicReviewPaper) => {
    const labels = getPaperLabels(p.id);
    labels.forEach((lk: string) => {
      if (labelCounts[lk]) labelCounts[lk].count++;
    });
  });
  const sorted = Object.values(labelCounts)
    .filter((lc) => lc.count > 0)
    .sort((a, b) => b.count - a.count);
  const topLabel = sorted.length ? sorted[0].def.name : "none";
  const totalLabeled = included.filter(
    (p: SystematicReviewPaper) => getPaperLabels(p.id).size > 0,
  ).length;
  const narr = doc.createElement("div");
  narr.style.cssText =
    "padding:8px 12px;margin-bottom:12px;border-radius:6px;background:var(--background-primary);border-left:3px solid var(--highlight-primary);font-size:11px;color:var(--text-primary);line-height:1.5;";
  narr.appendChild(
    doc.createTextNode(
      "Quick Overview: " +
        included.length +
        " screened papers mapped across " +
        sorted.length +
        " evidence categories. Most common: " +
        topLabel +
        " (" +
        (sorted.length ? sorted[0].count : 0) +
        " papers). " +
        totalLabeled +
        "/" +
        included.length +
        " papers labeled. ",
    ),
  );

  // Cross-label query controls
  if (xlMode && xlQuery.length) {
    const xlPapers = included.filter((p: SystematicReviewPaper) => {
      const pl = getPaperLabels(p.id);
      return xlQuery.every((lk: string) => pl.has(lk));
    });
    const xlSpan = doc.createElement("strong");
    xlSpan.textContent =
      "Cross-label query: " +
      xlQuery
        .map((lk: string) => {
          const ld = currentState!.labelDefs.find(
            (l: LabelDefinition) => l.k === lk,
          );
          return ld ? ld.name : lk;
        })
        .join(" + ") +
      " \u2192 " +
      xlPapers.length +
      " papers match.";
    xlSpan.style.cssText = "color:var(--highlight-primary);";
    narr.appendChild(xlSpan);
    narr.appendChild(doc.createTextNode(" "));
    const clearBtn = doc.createElement("button");
    clearBtn.textContent = "Clear";
    clearBtn.style.cssText =
      "padding:1px 6px;font-size:9px;border:1px solid var(--border-primary);border-radius:3px;background:transparent;color:var(--text-secondary);cursor:pointer;font-family:inherit;";
    clearBtn.addEventListener("click", () => {
      xlMode = false;
      xlQuery.length = 0;
      reRenderPanel(doc, "evidence");
    });
    narr.appendChild(clearBtn);
  } else {
    const comboBtn = doc.createElement("button");
    comboBtn.textContent = xlMode
      ? "Query mode ON \u2014 click labels to combine"
      : "Combine Labels";
    comboBtn.style.cssText =
      "padding:2px 8px;font-size:9px;border:1px solid var(--border-primary);border-radius:3px;background:" +
      (xlMode ? "var(--highlight-primary)" : "transparent") +
      ";color:" +
      (xlMode ? "#fff" : "var(--text-secondary)") +
      ";cursor:pointer;font-family:inherit;";
    comboBtn.addEventListener("click", () => {
      xlMode = !xlMode;
      if (!xlMode) xlQuery.length = 0;
      reRenderPanel(doc, "evidence");
    });
    narr.appendChild(comboBtn);
  }
  body.appendChild(narr);
  const catHdr = doc.createElement("div");
  catHdr.textContent = "Evidence by Category";
  catHdr.style.cssText =
    "font-size:11px;font-weight:600;color:var(--text-primary);margin-bottom:8px;";
  body.appendChild(catHdr);
  for (const cat in labelHierarchy) {
    const catLabels = labelHierarchy[cat].labels.filter(
      (lk: string) => labelCounts[lk] && labelCounts[lk].count > 0,
    );
    if (!catLabels.length) continue;
    const catDiv = doc.createElement("div");
    catDiv.style.cssText = "margin-bottom:8px;";
    const catName = doc.createElement("div");
    catName.textContent = cat;
    catName.style.cssText =
      "font-size:10px;font-weight:600;color:var(--text-tertiary);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;";
    catDiv.appendChild(catName);
    const catRow = doc.createElement("div");
    catRow.style.cssText = "display:flex;gap:4px;flex-wrap:wrap;";
    catLabels.forEach((lk: string) => {
      const lc = labelCounts[lk];
      const isXlActive = xlQuery.includes(lk);
      const seg = doc.createElement("div");
      seg.style.cssText =
        "min-width:55px;flex:1;padding:6px 4px;border-radius:6px;text-align:center;cursor:pointer;background:" +
        lc.def.bg +
        ";color:" +
        lc.def.color +
        ";font-size:8px;border:" +
        (isXlActive
          ? "2px solid var(--highlight-primary)"
          : "1px solid transparent") +
        ";" +
        (isXlActive ? "box-shadow:0 0 6px rgba(37,99,235,0.4);" : "");
      const segC = doc.createElement("div");
      segC.textContent = String(lc.count);
      segC.style.cssText = "font-size:16px;font-weight:700;";
      seg.appendChild(segC);
      const segN = doc.createElement("div");
      segN.textContent = lc.def.name;
      seg.appendChild(segN);
      seg.addEventListener("click", () => {
        if (xlMode) {
          const idx = xlQuery.indexOf(lk);
          if (idx >= 0) xlQuery.splice(idx, 1);
          else xlQuery.push(lk);
          reRenderPanel(doc, "evidence");
        } else {
          // Show papers with this label + co-occurring labels
          evSelectedLabel = lk;
          reRenderPanel(doc, "evidence");
        }
      });
      catRow.appendChild(seg);
    });
    catDiv.appendChild(catRow);
    body.appendChild(catDiv);
  }

  // Cross-label query results
  if (xlMode && xlQuery.length) {
    const xlPapers = included.filter((p: SystematicReviewPaper) => {
      const pl = getPaperLabels(p.id);
      return xlQuery.every((lk: string) => pl.has(lk));
    });
    const xlDiv = doc.createElement("div");
    xlDiv.style.cssText =
      "margin-top:12px;border-top:1px solid var(--border-secondary);padding-top:12px;";
    const xlHdr = doc.createElement("div");
    xlHdr.textContent =
      "Papers Matching " +
      xlQuery
        .map((lk: string) => {
          const ld = currentState!.labelDefs.find(
            (l: LabelDefinition) => l.k === lk,
          );
          return ld ? ld.name : lk;
        })
        .join(" + ") +
      " (" +
      xlPapers.length +
      ")";
    xlHdr.style.cssText =
      "font-size:11px;font-weight:600;color:var(--text-primary);margin-bottom:8px;";
    xlDiv.appendChild(xlHdr);
    if (!xlPapers.length) {
      const noMatch = doc.createElement("div");
      noMatch.textContent =
        "No papers match all selected labels \u2014 this may indicate a genuine evidence gap.";
      noMatch.style.cssText =
        "padding:12px;text-align:center;color:var(--text-tertiary);background:var(--background-secondary);border-radius:6px;font-size:10px;";
      xlDiv.appendChild(noMatch);
    } else {
      xlPapers.forEach((p: SystematicReviewPaper) => {
        const pItem = renderEvPaperChip(doc, p);
        xlDiv.appendChild(pItem);
      });
    }
    body.appendChild(xlDiv);
  }

  // Label drill-down (non-query mode)
  if (!xlMode && evSelectedLabel) {
    const selDef = currentState!.labelDefs.find(
      (l: LabelDefinition) => l.k === evSelectedLabel,
    );
    const matches = included.filter((p: SystematicReviewPaper) =>
      getPaperLabels(p.id).has(evSelectedLabel!),
    );
    // Co-occurring labels
    const coLabels: { def: LabelDefinition; count: number }[] = [];
    currentState!.labelDefs.forEach((ld: LabelDefinition) => {
      if (ld.k === evSelectedLabel) return;
      let coCount = 0;
      matches.forEach((p: SystematicReviewPaper) => {
        if (getPaperLabels(p.id).has(ld.k)) coCount++;
      });
      if (coCount > 0) coLabels.push({ def: ld, count: coCount });
    });
    coLabels.sort((a, b) => b.count - a.count);

    const drillDiv = doc.createElement("div");
    drillDiv.style.cssText =
      "margin-top:12px;border-top:1px solid var(--border-secondary);padding-top:12px;";
    const drillHdr = doc.createElement("div");
    drillHdr.style.cssText =
      "display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;";
    const drillTitle = doc.createElement("div");
    drillTitle.textContent =
      (selDef ? selDef.name : evSelectedLabel) +
      " \u2014 " +
      matches.length +
      " papers";
    drillTitle.style.cssText =
      "font-size:11px;font-weight:600;color:var(--text-primary);";
    drillHdr.appendChild(drillTitle);
    const drillClose = doc.createElement("button");
    drillClose.textContent = "\u00d7";
    drillClose.style.cssText =
      "width:20px;height:20px;border:none;background:transparent;color:var(--text-tertiary);cursor:pointer;font-size:14px;";
    drillClose.addEventListener("click", () => {
      evSelectedLabel = null;
      reRenderPanel(doc, "evidence");
    });
    drillHdr.appendChild(drillClose);
    drillDiv.appendChild(drillHdr);

    if (coLabels.length > 0) {
      const coHdr = doc.createElement("div");
      coHdr.textContent = "Also tagged with:";
      coHdr.style.cssText =
        "font-size:9px;color:var(--text-tertiary);margin-bottom:4px;";
      drillDiv.appendChild(coHdr);
      const coRow = doc.createElement("div");
      coRow.style.cssText =
        "display:flex;flex-wrap:wrap;gap:4px;margin-bottom:8px;";
      coLabels.forEach((cl) => {
        const chip = doc.createElement("button");
        chip.textContent =
          cl.def.name +
          " " +
          cl.count +
          " (" +
          Math.round((cl.count / matches.length) * 100) +
          "%)";
        chip.style.cssText =
          "padding:2px 6px;border-radius:10px;font-size:8px;cursor:pointer;border:1px solid " +
          cl.def.color +
          ";background:" +
          cl.def.bg +
          ";color:" +
          cl.def.color +
          ";font-family:inherit;";
        chip.addEventListener("click", () => {
          evSelectedLabel = cl.def.k;
          reRenderPanel(doc, "evidence");
        });
        coRow.appendChild(chip);
      });
      drillDiv.appendChild(coRow);
    }

    matches.forEach((p: SystematicReviewPaper) => {
      const pItem = renderEvPaperChip(doc, p);
      drillDiv.appendChild(pItem);
    });
    body.appendChild(drillDiv);
  }

  const unlabeled = included.filter(
    (p: SystematicReviewPaper) => getPaperLabels(p.id).size === 0,
  );
  if (unlabeled.length > 0) {
    const warn = doc.createElement("div");
    warn.textContent =
      unlabeled.length + " paper(s) unlabeled. Assign labels in Screening.";
    warn.style.cssText =
      "padding:6px 10px;border-radius:6px;font-size:10px;color:#854d0e;background:#fef3c7;margin-top:8px;";
    body.appendChild(warn);
  }
}

function renderEvPaperChip(
  doc: Document,
  p: SystematicReviewPaper,
): HTMLElement {
  const zItem = Zotero.Items.get(p.id);
  const title = zItem
    ? (zItem.getField("title") as string) || `Item ${p.id}`
    : `Item ${p.id}`;
  const creators = zItem ? zItem.getCreators() : [];
  const author =
    creators.length > 0
      ? (creators[0] as any).lastName || (creators[0] as any).name || ""
      : "";
  const year = zItem ? (zItem.getField("year") as string) || "" : "";
  const journal = zItem
    ? (zItem.getField("publicationTitle") as string) || ""
    : "";

  const item = doc.createElement("div");
  item.style.cssText =
    "padding:6px 8px;margin:4px 0;background:var(--background-secondary);border-radius:6px;cursor:pointer;";
  item.addEventListener("click", () => {
    // Navigate to screening and select this paper
    evSelectedLabel = null;
    scrActive = p.id;
    currentPanel = "screening";
    reRenderPanel(doc, "screening");
  });

  const titleEl = doc.createElement("div");
  titleEl.textContent = title;
  titleEl.style.cssText =
    "font-weight:600;font-size:10px;color:var(--text-primary);line-height:1.3;";
  item.appendChild(titleEl);

  const subEl = doc.createElement("div");
  subEl.style.cssText =
    "font-size:9px;color:var(--text-tertiary);margin-top:2px;";
  subEl.textContent =
    (author ? author.split(" ")[0] : "") +
    (year ? " et al. (" + year + ")" : "") +
    (journal ? " | " + journal : "");
  item.appendChild(subEl);

  // Labels
  const plabels = getPaperLabels(p.id);
  if (plabels.size > 0) {
    const lblRow = doc.createElement("div");
    lblRow.style.cssText =
      "display:flex;gap:3px;flex-wrap:wrap;margin-top:3px;";
    plabels.forEach((lk: string) => {
      const ld = currentState!.labelDefs.find(
        (l: LabelDefinition) => l.k === lk,
      );
      if (ld) {
        const chip = doc.createElement("span");
        chip.textContent = ld.name;
        chip.style.cssText =
          "padding:0 4px;border-radius:3px;font-size:7px;font-weight:600;background:" +
          ld.bg +
          ";color:" +
          ld.color +
          ";";
        lblRow.appendChild(chip);
      }
    });
    item.appendChild(lblRow);
  }

  return item;
}

function buildEvAISynthesis(
  doc: Document,
  body: HTMLElement,
  included: SystematicReviewPaper[],
): void {
  const syn = getVerifiedSynthesis();
  if (!syn.domains.length) {
    const empty = doc.createElement("div");
    empty.textContent =
      "No verified evidence synthesis is available. Complete validated extractions and assessments before creating evidence domains.";
    empty.style.cssText =
      "text-align:center;color:var(--text-tertiary);padding:32px;font-size:12px;";
    body.appendChild(empty);
    return;
  }
  const narrDiv = doc.createElement("div");
  narrDiv.style.cssText =
    "padding:8px 12px;margin-bottom:12px;border-radius:6px;background:var(--background-primary);border-left:3px solid #d97706;font-size:11px;color:var(--text-primary);line-height:1.5;";
  const strong = doc.createElement("strong");
  strong.textContent = "Heuristic Synthesis: ";
  narrDiv.appendChild(strong);
  narrDiv.appendChild(doc.createTextNode(syn.narrative));
  body.appendChild(narrDiv);
  const kpiRow = doc.createElement("div");
  kpiRow.style.cssText =
    "display:flex;gap:8px;margin-bottom:16px;flex-wrap:wrap;";
  [
    {
      val: syn.kpi.papers,
      label: "Papers Analyzed",
      color: "var(--text-primary)",
    },
    { val: syn.kpi.high, label: "High Certainty", color: "#16a34a" },
    { val: syn.kpi.moderate, label: "Moderate", color: "#d97706" },
    { val: syn.kpi.low, label: "Low/Very Low", color: "#dc2626" },
  ].forEach((kpi) => {
    const card = doc.createElement("div");
    card.style.cssText =
      "flex:1;min-width:80px;padding:10px;border-radius:8px;background:var(--background-primary);text-align:center;";
    const valEl = doc.createElement("div");
    valEl.textContent = String(kpi.val);
    valEl.style.cssText =
      "font-size:22px;font-weight:700;color:" + kpi.color + ";";
    card.appendChild(valEl);
    const lbl = doc.createElement("div");
    lbl.textContent = kpi.label;
    lbl.style.cssText =
      "font-size:9px;color:var(--text-tertiary);margin-top:2px;";
    card.appendChild(lbl);
    kpiRow.appendChild(card);
  });
  body.appendChild(kpiRow);
  const gradeHdr = doc.createElement("div");
  gradeHdr.textContent = "GRADE Evidence Profile";
  gradeHdr.style.cssText =
    "font-size:11px;font-weight:600;color:var(--text-primary);margin-bottom:8px;";
  body.appendChild(gradeHdr);
  const tableW = doc.createElement("div");
  tableW.style.cssText =
    "overflow-x:auto;margin-bottom:16px;border:1px solid var(--border-secondary);border-radius:6px;";
  const tbl = doc.createElement("table");
  tbl.style.cssText = "width:100%;border-collapse:collapse;font-size:10px;";
  const thead = doc.createElement("thead");
  const thr = doc.createElement("tr");
  ["Domain", "N", "Effect", "GRADE", "Consistency", "RoB"].forEach((h) => {
    const th = doc.createElement("th");
    th.textContent = h;
    th.style.cssText =
      "padding:4px 6px;text-align:left;font-weight:600;color:var(--text-secondary);border-bottom:1px solid var(--border-primary);font-size:9px;";
    thr.appendChild(th);
  });
  thead.appendChild(thr);
  tbl.appendChild(thead);
  const tbody = doc.createElement("tbody");
  syn.domains.forEach((d: any, domainIdx: number) => {
    const tr = doc.createElement("tr");
    tr.style.cssText =
      "border-bottom:1px solid var(--border-secondary);cursor:pointer;";
    tr.addEventListener("click", () => {
      // Toggle domain detail expansion
      const existing = doc.getElementById("evDomDetail" + domainIdx);
      if (existing) {
        const p = existing.parentElement;
        if (p) p.removeChild(existing);
        return;
      }
      const detailDiv = doc.createElement("div");
      detailDiv.id = "evDomDetail" + domainIdx;
      detailDiv.style.cssText =
        "padding:10px;margin:8px 0;background:var(--background-secondary);border-radius:6px;border-left:3px solid var(--highlight-primary);";
      const detailTitle = doc.createElement("div");
      detailTitle.textContent =
        d.domain + " \u2014 GRADE: " + d.grade + " | " + d.studies + " studies";
      detailTitle.style.cssText =
        "font-weight:600;font-size:10px;color:var(--text-primary);margin-bottom:6px;";
      detailDiv.appendChild(detailTitle);
      const detailNarr = doc.createElement("div");
      detailNarr.textContent = d.narrative;
      detailNarr.style.cssText =
        "font-size:10px;color:var(--text-secondary);line-height:1.5;margin-bottom:8px;";
      detailDiv.appendChild(detailNarr);
      if (d.keyFindings && d.keyFindings.length) {
        const kfRow = doc.createElement("div");
        kfRow.textContent = "Key findings: " + d.keyFindings.join(" | ");
        kfRow.style.cssText =
          "font-size:9px;color:var(--text-tertiary);margin-bottom:8px;";
        detailDiv.appendChild(kfRow);
      }
      const studHdr = doc.createElement("div");
      studHdr.textContent = "Included Studies:";
      studHdr.style.cssText =
        "font-size:9px;font-weight:600;color:var(--text-secondary);margin-bottom:4px;";
      detailDiv.appendChild(studHdr);
      d.paperIds.forEach((pid: number) => {
        const p = currentState!.papers.find(
          (pp: SystematicReviewPaper) => pp.id === pid,
        );
        if (!p) return;
        const m2 = getItemMeta(p.id);
        const title = m2.title;
        const author = m2.authors.split(",")[0]?.trim() || "";
        const year = m2.year;
        const studItem = doc.createElement("div");
        studItem.style.cssText =
          "padding:4px 6px;margin:2px 0;background:var(--background-primary);border-radius:4px;font-size:9px;color:var(--text-primary);cursor:pointer;";
        studItem.textContent = author + " (" + year + ") " + trunc(title, 50);
        studItem.addEventListener("click", (e: Event) => {
          e.stopPropagation();
          scrActive = p.id;
          currentPanel = "screening";
          reRenderPanel(doc, "screening");
        });
        detailDiv.appendChild(studItem);
      });
      // Insert after the current row
      if (tr.parentElement) {
        const nextRow = tr.nextSibling;
        if (nextRow) tr.parentElement.insertBefore(detailDiv, nextRow);
        else tr.parentElement.appendChild(detailDiv);
      }
    });
    const gradeColors: Record<string, string> = {
      High: "#16a34a",
      Moderate: "#d97706",
      Low: "#dc2626",
      "Very Low": "#991b1b",
    };
    [
      escHtml(d.domain),
      String(d.studies),
      d.effectDirection,
      d.grade,
      escHtml(d.consistency || ""),
      escHtml(d.riskOfBias || ""),
    ].forEach((v: string, i: number) => {
      const td = doc.createElement("td");
      td.style.cssText =
        "padding:4px 6px;font-size:10px;color:var(--text-primary);" +
        (i === 3
          ? "font-weight:600;color:" +
            (gradeColors[d.grade] || "var(--text-primary)") +
            ";"
          : "");
      if (i === 0) {
        // Domain name cell — add Edit GRADE button
        const domainSpan = doc.createElement("span");
        domainSpan.textContent = v;
        td.appendChild(domainSpan);
        const editGradeBtn = doc.createElement("button");
        editGradeBtn.textContent = "Edit";
        editGradeBtn.title = "Edit GRADE rating";
        editGradeBtn.style.cssText =
          "margin-left:4px;padding:1px 4px;font-size:8px;border:1px solid var(--border-primary);border-radius:3px;background:transparent;color:var(--text-tertiary);cursor:pointer;font-family:inherit;opacity:0.6;";
        editGradeBtn.addEventListener("click", (e: Event) => {
          e.stopPropagation();
          // Inline edit popover for GRADE
          const overlay = doc.createElement("div");
          overlay.style.cssText =
            "position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.3);z-index:9999;display:flex;align-items:center;justify-content:center;";
          const pop = doc.createElement("div");
          pop.style.cssText =
            "background:var(--background-primary);border:1px solid var(--border-primary);border-radius:8px;padding:12px;min-width:200px;box-shadow:0 4px 20px rgba(0,0,0,0.15);";
          const popTitle = doc.createElement("div");
          popTitle.textContent = "Edit GRADE for " + d.domain;
          popTitle.style.cssText =
            "font-size:11px;font-weight:600;color:var(--text-primary);margin-bottom:8px;";
          pop.appendChild(popTitle);
          const gradeSel = doc.createElement("select") as HTMLSelectElement;
          gradeSel.style.cssText =
            "width:100%;padding:4px;font-size:11px;border:1px solid var(--border-primary);border-radius:4px;font-family:inherit;";
          ["High", "Moderate", "Low", "Very Low"].forEach((g) => {
            const opt = doc.createElement("option");
            opt.value = g;
            opt.textContent = g;
            if (g === d.grade) opt.selected = true;
            gradeSel.appendChild(opt);
          });
          pop.appendChild(gradeSel);
          const popBtns = doc.createElement("div");
          popBtns.style.cssText =
            "display:flex;gap:6px;margin-top:8px;justify-content:flex-end;";
          const savePopBtn = doc.createElement("button");
          savePopBtn.textContent = "Save";
          savePopBtn.style.cssText =
            "padding:3px 10px;font-size:10px;border:1px solid var(--highlight-primary);border-radius:4px;background:var(--highlight-primary);color:#fff;cursor:pointer;font-family:inherit;";
          savePopBtn.addEventListener("click", () => {
            d.grade = gradeSel.value;
            if (currentState) {
              const run = getSRService().getSynthesis(currentState);
              const domain = run?.domains.find(
                (candidate) => candidate.id === d.id,
              );
              if (domain) {
                domain.grade.certainty =
                  gradeSel.value === "High"
                    ? "high"
                    : gradeSel.value === "Moderate"
                      ? "moderate"
                      : gradeSel.value === "Low"
                        ? "low"
                        : "verylow";
                domain.grade.confirmed = true;
              }
              const editKey = d.id || d.domain;
              if (!currentState.synthesisEdits[editKey]) {
                currentState.synthesisEdits[editKey] = {};
              }
              currentState.synthesisEdits[editKey].grade = gradeSel.value;
              saveSRState();
            }
            overlay.parentElement?.removeChild(overlay);
            reRenderPanel(doc, "evidence");
            toast(doc, "GRADE updated for " + d.domain);
          });
          popBtns.appendChild(savePopBtn);
          const cancelPopBtn = doc.createElement("button");
          cancelPopBtn.textContent = "Cancel";
          cancelPopBtn.style.cssText =
            "padding:3px 10px;font-size:10px;border:1px solid var(--border-primary);border-radius:4px;background:transparent;color:var(--text-secondary);cursor:pointer;font-family:inherit;";
          cancelPopBtn.addEventListener("click", () => {
            overlay.parentElement?.removeChild(overlay);
          });
          popBtns.appendChild(cancelPopBtn);
          pop.appendChild(popBtns);
          overlay.appendChild(pop);
          overlay.addEventListener("click", (ev: Event) => {
            if (ev.target === overlay)
              overlay.parentElement?.removeChild(overlay);
          });
          mountReviewSheet(doc, overlay);
        });
        td.appendChild(editGradeBtn);
        const confirmBtn = doc.createElement("button");
        confirmBtn.textContent = d.methodConfirmed ? "Confirmed" : "Confirm";
        confirmBtn.disabled = d.methodConfirmed;
        confirmBtn.title =
          "Confirm the synthesis method, certainty judgment, and narrative";
        confirmBtn.style.cssText =
          "margin-left:4px;padding:1px 4px;font-size:8px;border:1px solid #16a34a;border-radius:3px;background:transparent;color:#16a34a;cursor:pointer;font-family:inherit;";
        confirmBtn.addEventListener("click", (event: Event) => {
          event.stopPropagation();
          if (!currentState) return;
          getSRService().confirmSynthesisDomain(
            currentState,
            d.id,
            d.studies >= 2 ? "random_effects" : "narrative",
          );
          saveSRState();
          reRenderPanel(doc, "evidence");
        });
        td.appendChild(confirmBtn);
      } else {
        td.textContent = v;
      }
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
  tbl.appendChild(tbody);
  tableW.appendChild(tbl);
  body.appendChild(tableW);

  // Forest plots — one per domain
  syn.domains.forEach((d: any) => {
    const allExt: ForestPlotEntry[] = [];
    const seenPids = new Set<number>();
    d.paperIds.forEach((pid: number) => {
      if (seenPids.has(pid)) return;
      seenPids.add(pid);
      const ex = currentState!.extractions[pid] || [];
      const p = currentState!.papers.find(
        (pp: SystematicReviewPaper) => pp.id === pid,
      );
      ex.forEach((e: ExtractionRow) => {
        if (
          e.verificationStatus !== "verified" ||
          e.outcome !== d.domain ||
          !validateExtractionRow(e).valid
        ) {
          return;
        }
        allExt.push({
          study: p ? getItemMeta(p.id).authors.split(",")[0]?.trim() || "" : "",
          effectType: e.effectType,
          effectSize: e.effectSize!,
          ciLow: e.ciLow!,
          ciHigh: e.ciHigh!,
          n: e.n!,
          events: e.events || 0,
          outcome: e.outcome,
        });
      });
    });
    if (allExt.length >= 2) {
      const fpHdr = doc.createElement("div");
      fpHdr.textContent = "Forest Plot: " + d.domain;
      fpHdr.style.cssText =
        "font-size:11px;font-weight:600;color:var(--text-primary);margin-bottom:4px;margin-top:12px;";
      body.appendChild(fpHdr);
      const fpSvg = renderForestPlot(allExt);
      if (fpSvg) {
        const fpWrap = doc.createElement("div");
        fpWrap.innerHTML = fpSvg;
        body.appendChild(fpWrap);
      }
    }
  });

  // Check if no domain has >=2 extractions
  const hasForest = syn.domains.some((d: any) => {
    const seen = new Set<number>();
    let c = 0;
    d.paperIds.forEach((pid: number) => {
      if (!seen.has(pid)) {
        seen.add(pid);
        c += (currentState!.extractions[pid] || []).length;
      }
    });
    return c >= 2;
  });
  if (!hasForest) {
    const noFp = doc.createElement("div");
    noFp.style.cssText =
      "padding:16px;text-align:center;background:var(--background-secondary);border-radius:8px;border:1px dashed var(--border-primary);margin:12px 0;";
    const noFpTitle = doc.createElement("div");
    noFpTitle.textContent = "No forest plot available";
    noFpTitle.style.cssText =
      "font-size:10px;color:var(--text-secondary);margin-bottom:4px;";
    noFp.appendChild(noFpTitle);
    const noFpDesc = doc.createElement("div");
    noFpDesc.innerHTML =
      "Use the <strong>Extract</strong> button on papers in Screening to enter effect sizes and confidence intervals. Need \u22652 extractions per domain.";
    noFpDesc.style.cssText = "font-size:9px;color:var(--text-tertiary);";
    noFp.appendChild(noFpDesc);
    body.appendChild(noFp);
  }

  const synHdr = doc.createElement("div");
  synHdr.textContent = "Narrative Synthesis";
  synHdr.style.cssText =
    "font-size:11px;font-weight:600;color:var(--text-primary);margin-bottom:8px;border-top:1px solid var(--border-primary);padding-top:12px;";
  body.appendChild(synHdr);
  syn.domains.forEach((d: any) => {
    const domDiv = doc.createElement("div");
    domDiv.style.cssText =
      "margin-bottom:10px;padding:10px;border-radius:6px;background:var(--background-primary);border-left:3px solid var(--highlight-primary);";
    const domHdr = doc.createElement("div");
    domHdr.style.cssText =
      "display:flex;align-items:center;justify-content:space-between;margin-bottom:4px;";
    const domTitle = doc.createElement("span");
    domTitle.textContent = d.domain + " - GRADE " + d.grade;
    domTitle.style.cssText =
      "font-weight:600;font-size:10px;color:var(--text-primary);";
    domHdr.appendChild(domTitle);
    const editNarrBtn = doc.createElement("button");
    editNarrBtn.textContent = "Edit";
    editNarrBtn.title = "Edit narrative";
    editNarrBtn.style.cssText =
      "padding:1px 6px;font-size:8px;border:1px solid var(--border-primary);border-radius:3px;background:transparent;color:var(--text-tertiary);cursor:pointer;font-family:inherit;opacity:0.5;";
    editNarrBtn.addEventListener("click", () => {
      const overlay = doc.createElement("div");
      overlay.style.cssText =
        "position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.3);z-index:9999;display:flex;align-items:center;justify-content:center;";
      const pop = doc.createElement("div");
      pop.style.cssText =
        "background:var(--background-primary);border:1px solid var(--border-primary);border-radius:8px;padding:12px;min-width:300px;max-width:500px;box-shadow:0 4px 20px rgba(0,0,0,0.15);";
      const popTitle = doc.createElement("div");
      popTitle.textContent = "Edit Narrative: " + d.domain;
      popTitle.style.cssText =
        "font-size:11px;font-weight:600;color:var(--text-primary);margin-bottom:8px;";
      pop.appendChild(popTitle);
      const narrInput = doc.createElement("textarea") as HTMLTextAreaElement;
      narrInput.value = d.narrative;
      narrInput.style.cssText =
        "width:100%;height:120px;padding:6px;font-size:11px;border:1px solid var(--border-primary);border-radius:4px;font-family:inherit;resize:vertical;background:var(--background-primary);color:var(--text-primary);";
      pop.appendChild(narrInput);
      const popBtns = doc.createElement("div");
      popBtns.style.cssText =
        "display:flex;gap:6px;margin-top:8px;justify-content:flex-end;";
      const savePopBtn = doc.createElement("button");
      savePopBtn.textContent = "Save";
      savePopBtn.style.cssText =
        "padding:3px 10px;font-size:10px;border:1px solid var(--highlight-primary);border-radius:4px;background:var(--highlight-primary);color:#fff;cursor:pointer;font-family:inherit;";
      savePopBtn.addEventListener("click", () => {
        d.narrative = narrInput.value;
        if (currentState) {
          const run = getSRService().getSynthesis(currentState);
          const domain = run?.domains.find(
            (candidate) => candidate.id === d.id,
          );
          if (domain) {
            domain.summary = narrInput.value;
            domain.narrativeConfirmed = true;
          }
          const editKey = d.id || d.domain;
          if (!currentState.synthesisEdits[editKey]) {
            currentState.synthesisEdits[editKey] = {};
          }
          currentState.synthesisEdits[editKey].narrative = narrInput.value;
          saveSRState();
        }
        overlay.parentElement?.removeChild(overlay);
        reRenderPanel(doc, "evidence");
        toast(doc, "Narrative updated for " + d.domain);
      });
      popBtns.appendChild(savePopBtn);
      const cancelPopBtn = doc.createElement("button");
      cancelPopBtn.textContent = "Cancel";
      cancelPopBtn.style.cssText =
        "padding:3px 10px;font-size:10px;border:1px solid var(--border-primary);border-radius:4px;background:transparent;color:var(--text-secondary);cursor:pointer;font-family:inherit;";
      cancelPopBtn.addEventListener("click", () => {
        overlay.parentElement?.removeChild(overlay);
      });
      popBtns.appendChild(cancelPopBtn);
      pop.appendChild(popBtns);
      overlay.appendChild(pop);
      overlay.addEventListener("click", (ev: Event) => {
        if (ev.target === overlay) overlay.parentElement?.removeChild(overlay);
      });
      mountReviewSheet(doc, overlay);
    });
    domHdr.appendChild(editNarrBtn);
    domDiv.appendChild(domHdr);
    const domNarr = doc.createElement("div");
    domNarr.textContent = d.narrative;
    domNarr.style.cssText =
      "font-size:10px;color:var(--text-secondary);line-height:1.6;";
    domDiv.appendChild(domNarr);
    if (d.keyFindings && d.keyFindings.length) {
      const kfRow = doc.createElement("div");
      kfRow.textContent = "Key findings: " + d.keyFindings.join(" | ");
      kfRow.style.cssText =
        "margin-top:6px;font-size:9px;color:var(--text-tertiary);";
      domDiv.appendChild(kfRow);
    }
    body.appendChild(domDiv);
  });
}

function getVerifiedSynthesis() {
  const included = (currentState?.papers || []).filter(
    (p: SystematicReviewPaper) => p.status === "included",
  );
  const result = {
    domains: [] as any[],
    narrative: "",
    kpi: { papers: 0, domains: 0, high: 0, moderate: 0, low: 0, patients: 0 },
  };
  if (!included.length) return result;
  const gradeLabels: Record<string, string> = {
    high: "High",
    moderate: "Moderate",
    low: "Low",
    verylow: "Very Low",
  };
  const directionLabels: Record<string, string> = {
    positive: "Benefit",
    mixed: "Mixed",
    none: "No demonstrated effect",
  };
  const activeRun = currentState
    ? getSRService().getSynthesis(currentState)
    : undefined;
  const results = (activeRun?.domains || []).map((domain) => ({
    id: domain.id,
    domain: domain.outcome,
    studies: domain.paperIds.length,
    patients: 0,
    years: "",
    effectDirection: directionLabels[domain.direction] || "Unclear",
    consistency: "Not independently assessed",
    riskOfBias: "See study assessments",
    grade:
      domain.grade.certainty === "not_applicable"
        ? "Not applicable"
        : gradeLabels[domain.grade.certainty],
    narrative: domain.summary,
    studyList: domain.paperIds.map((id) => getItemMeta(id).title),
    paperIds: [...domain.paperIds],
    keyFindings: [],
    status: activeRun?.status,
    selectedModel: domain.selectedModel,
    methodConfirmed: domain.methodConfirmed,
  }));

  // Apply persisted synthesis edits (GRADE overrides, narrative edits)
  if (currentState?.synthesisEdits) {
    results.forEach((r: any) => {
      const edits =
        currentState!.synthesisEdits[r.id] ||
        currentState!.synthesisEdits[r.domain];
      if (edits) {
        if (edits.grade) r.grade = edits.grade;
        if (edits.narrative) r.narrative = edits.narrative;
      }
    });
  }

  const highCount = results.filter((r: any) => r.grade === "High").length;
  const modCount = results.filter((r: any) => r.grade === "Moderate").length;
  const lowCount = results.filter(
    (r: any) => r.grade === "Low" || r.grade === "Very Low",
  ).length;
  return {
    domains: results,
    narrative:
      "Verified synthesis contains " +
      results.length +
      " evidence domain(s) across " +
      included.length +
      " finally included papers. " +
      highCount +
      " confirmed High certainty, " +
      modCount +
      " Moderate, " +
      lowCount +
      " Low/Very Low.",
    kpi: {
      papers: included.length,
      domains: results.length,
      high: highCount,
      moderate: modCount,
      low: lowCount,
      patients: 0,
    },
  };
}

function extractKeyFindings(papers: SystematicReviewPaper[]): string[] {
  const findings: string[] = [];
  papers.forEach((p: SystematicReviewPaper) => {
    const t = getItemMeta(p.id).abstract.toLowerCase();
    if (t.includes("auc")) findings.push("AUC reported");
    if (t.includes("significant") && t.includes("p="))
      findings.push("Statistically significant");
    if (t.includes("multicenter") || t.includes("multi-center"))
      findings.push("Multi-center");
    if (t.includes("validation")) findings.push("Includes validation");
    if (t.includes("rct") || t.includes("randomized"))
      findings.push("RCT evidence");
  });
  return findings.filter((v, i, a) => a.indexOf(v) === i).slice(0, 4);
}

// ============================================================
// FOREST PLOT — inverse-variance meta-analysis SVG
// ============================================================
interface ForestPlotEntry {
  study: string;
  effectType: string;
  effectSize: number;
  ciLow: number;
  ciHigh: number;
  n: number;
  events: number;
  outcome: string;
  logES?: number;
  se?: number;
  w?: number;
  weightPct?: number;
}

function renderForestPlot(domainOutcomes: ForestPlotEntry[]): string {
  if (!domainOutcomes || domainOutcomes.length < 2) return "";

  const seen = new Map<string, ForestPlotEntry>();
  domainOutcomes.forEach((d) => {
    const key = d.study + "|" + d.outcome + "|" + d.effectType;
    const existing = seen.get(key);
    if (!existing) seen.set(key, d);
    else if (d.n && !existing.n) seen.set(key, d);
  });
  const groups = new Map<string, ForestPlotEntry[]>();
  for (const row of seen.values()) {
    const key = `${row.outcome}|${row.effectType}`;
    const group = groups.get(key) || [];
    group.push(row);
    groups.set(key, group);
  }
  const valid = Array.from(groups.values()).sort(
    (a, b) => b.length - a.length,
  )[0];
  if (!valid || valid.length < 2) return "";
  const rows = valid.map((entry) => ({
    outcome: entry.outcome,
    effectType: entry.effectType,
    effectSize: entry.effectSize,
    ciLow: entry.ciLow,
    ciHigh: entry.ciHigh,
    n: entry.n,
    events: entry.events,
  }));
  let analysis;
  try {
    analysis = fixedEffectMetaAnalysis(rows);
  } catch {
    return "";
  }
  const isRatio = analysis.measure !== "MD";
  const transformed = valid.map((entry, index) => ({
    ...entry,
    weightPct: Math.round(analysis.weights[index] * 100),
  }));
  const toScale = (value: number) => (isRatio ? Math.log(value) : value);
  const scaleValues = transformed.flatMap((entry) => [
    toScale(entry.effectSize),
    toScale(entry.ciLow),
    toScale(entry.ciHigh),
  ]);
  scaleValues.push(
    toScale(analysis.estimate),
    toScale(analysis.ciLow),
    toScale(analysis.ciHigh),
  );
  const w = 520;
  const h = 40 + transformed.length * 28 + 60;
  const plotLeft = 190;
  const plotRight = 465;
  const plotTop = 30;
  const rowH = 26;
  const finiteValues = scaleValues.filter(isFinite);
  const nullValue = isRatio ? 0 : 0;
  let minV = Math.min(...finiteValues, nullValue);
  let maxV = Math.max(...finiteValues, nullValue);
  const pad = (maxV - minV) * 0.15 || 0.2;
  minV -= pad;
  maxV += pad;

  function xPos(v: number): number {
    const scaled = toScale(v);
    if (!isFinite(scaled)) return plotLeft;
    return (
      plotLeft + ((scaled - minV) / (maxV - minV)) * (plotRight - plotLeft)
    );
  }

  let svg = `<svg viewBox="0 0 ${w} ${h}" width="100%" style="max-width:${w}px;margin-bottom:12px"><rect width="${w}" height="${h}" fill="transparent"/>`;
  svg += `<line x1="${plotLeft}" y1="${plotTop}" x2="${plotRight}" y2="${plotTop}" stroke="var(--border-secondary)" stroke-width="1"/>`;
  svg += `<line x1="${plotLeft}" y1="${plotTop}" x2="${plotLeft}" y2="${plotTop + transformed.length * rowH + 8}" stroke="var(--border-secondary)" stroke-width="1"/>`;
  const nullEstimate = isRatio ? 1 : 0;
  const nullX = xPos(nullEstimate);
  svg += `<line x1="${nullX}" y1="${plotTop}" x2="${nullX}" y2="${plotTop + transformed.length * rowH + 8}" stroke="var(--text-tertiary)" stroke-width="1" stroke-dasharray="4,3"/>`;
  svg += `<text x="${nullX}" y="${plotTop + transformed.length * rowH + 18}" text-anchor="middle" font-size="8" fill="var(--text-tertiary)">Null (${nullEstimate.toFixed(1)})</text>`;
  transformed.forEach((d, i) => {
    const y = plotTop + 18 + i * rowH;
    svg += `<text x="5" y="${y + 3}" font-size="9" fill="var(--text-primary)" font-family="monospace">${escHtml(d.study).substring(0, 18)}</text>`;
    svg += `<text x="${plotLeft - 45}" y="${y + 3}" font-size="8" fill="var(--text-tertiary)" text-anchor="end">${d.weightPct}%</text>`;
    const xLo = xPos(d.ciLow);
    const xHi = xPos(d.ciHigh);
    const xEs = xPos(d.effectSize);
    svg += `<line x1="${xLo}" y1="${y}" x2="${xHi}" y2="${y}" stroke="var(--text-secondary)" stroke-width="1.5"/>`;
    const sq = Math.max(5, Math.min(12, Math.sqrt(analysis.weights[i]) * 18));
    svg += `<rect x="${xEs - sq / 2}" y="${y - sq / 2}" width="${sq}" height="${sq}" fill="var(--highlight-primary)" rx="1"/>`;
    svg += `<text x="${plotRight + 5}" y="${y + 3}" font-size="8" fill="var(--text-primary)">${d.effectSize.toFixed(2)} [${d.ciLow.toFixed(2)}, ${d.ciHigh.toFixed(2)}]</text>`;
  });
  const py = plotTop + 18 + transformed.length * rowH + 8;
  const pxLo = xPos(analysis.ciLow);
  const pxHi = xPos(analysis.ciHigh);
  const pxC = xPos(analysis.estimate);
  svg += `<polygon points="${pxLo},${py} ${pxC},${py - 6} ${pxHi},${py} ${pxC},${py + 6}" fill="var(--highlight-primary)" stroke="var(--highlight-primary)" stroke-width="1"/>`;
  svg += `<text x="5" y="${py + 4}" font-size="9" fill="var(--text-primary)" font-weight="bold">Fixed effect (${Math.round(analysis.i2)}% I²)</text>`;
  svg += `<text x="${plotRight + 5}" y="${py + 4}" font-size="8" fill="var(--text-primary)" font-weight="bold">${analysis.estimate.toFixed(2)} [${analysis.ciLow.toFixed(2)}, ${analysis.ciHigh.toFixed(2)}]</text>`;
  svg += "</svg>";
  return svg;
}

// ============================================================
// GAP PANEL (PICO x Label matrix + AHRQ gaps)
// ============================================================
function buildGapPanel(doc: Document): HTMLElement {
  if (!currentState) return doc.createElement("div");
  const panel = doc.createElement("div");
  panel.style.cssText =
    "display:flex;flex-direction:column;flex:1;min-height:0;overflow:auto;padding:12px;";
  const included = currentState.papers.filter(
    (p: SystematicReviewPaper) =>
      p.status === "included" || p.status === "maybe",
  );
  if (!included.length) {
    const empty = doc.createElement("div");
    empty.textContent = "No papers screened yet.";
    empty.style.cssText =
      "text-align:center;color:var(--text-tertiary);padding:32px;font-size:13px;";
    panel.appendChild(empty);
    return panel;
  }

  const gapHdr = doc.createElement("div");
  gapHdr.style.cssText =
    "display:flex;align-items:center;gap:8px;margin-bottom:12px;flex-shrink:0;";
  const gapTitle = doc.createElement("div");
  gapTitle.textContent = "Evidence Gap Map";
  gapTitle.style.cssText =
    "font-size:13px;font-weight:600;color:var(--text-primary);";
  gapHdr.appendChild(gapTitle);
  const spc = doc.createElement("span");
  spc.style.cssText = "flex:1;";
  gapHdr.appendChild(spc);
  const sevSel = doc.createElement("select") as HTMLSelectElement;
  sevSel.style.cssText =
    "font-size:10px;padding:2px 4px;border:1px solid var(--border-primary);border-radius:3px;font-family:inherit;";
  ["all", "high", "medium", "low"].forEach((s: string) => {
    const o = doc.createElement("option");
    o.value = s;
    o.textContent =
      s === "all" ? "All severities" : s.charAt(0).toUpperCase() + s.slice(1);
    if (gapSeverityFilter === s) o.selected = true;
    sevSel.appendChild(o);
  });
  sevSel.addEventListener("change", () => {
    gapSeverityFilter = sevSel.value;
    saveSRState();
    reRenderPanel(doc, "gaps");
  });
  gapHdr.appendChild(sevSel);
  const refreshBtn = doc.createElement("button");
  refreshBtn.textContent = "Refresh";
  refreshBtn.style.cssText =
    "padding:2px 8px;font-size:10px;border:1px solid var(--border-primary);border-radius:4px;background:transparent;color:var(--text-secondary);cursor:pointer;font-family:inherit;";
  refreshBtn.addEventListener("click", async () => {
    if (!currentState) return;
    const readiness = getSRService().getSynthesisReadiness(currentState);
    if (readiness.verified === 0 && readiness.proposed === 0) {
      toast(
        doc,
        "No extraction results are available. Extract evidence in the Evidence tab first.",
      );
      return;
    }
    if (readiness.verified === 0) {
      const auto = getSRService().autoVerifyValidProposals(currentState);
      if (auto.verifiedRows === 0) {
        toast(
          doc,
          `${readiness.proposed} extraction proposal(s) require verification before gap analysis. Open the Evidence tab to verify or correct them.`,
        );
        return;
      }
      await getSRService().save(currentState);
      toast(
        doc,
        `Auto-verified ${auto.verifiedRows} valid proposal(s) before regenerating gaps`,
      );
    }
    const synthesis = getSRService().runSynthesis(currentState, true);
    if (!synthesis.domains.length) {
      toast(
        doc,
        "No synthesis domains could be created from verified evidence",
      );
      return;
    }
    getSRService().generateGaps(currentState, synthesis.id, true);
    await getSRService().save(currentState);
    reRenderPanel(doc, "gaps");
    toast(doc, "Gap analysis draft regenerated");
  });
  gapHdr.appendChild(refreshBtn);
  const analyzeAllBtn = doc.createElement("button");
  analyzeAllBtn.textContent = "Analyze All Included";
  analyzeAllBtn.title =
    "Extract papers missing or with failed extraction, run synthesis, then generate gap analysis";
  analyzeAllBtn.style.cssText =
    "padding:2px 8px;font-size:10px;border:1px solid #7c3aed;border-radius:4px;background:#7c3aed;color:#fff;cursor:pointer;font-family:inherit;font-weight:600;";
  analyzeAllBtn.addEventListener("click", async () => {
    if (!currentState) return;
    const template = getSRService().getExtractionTemplate(currentState);
    if (!template) {
      toast(doc, "Approve an extraction template first");
      openExtractionWorkspace(doc);
      return;
    }
    const includedCount = currentState.papers.filter(
      (paper) =>
        paper.status === "included" &&
        (paper.screeningStage === "final" || !paper.screeningStage),
    ).length;
    if (!includedCount) {
      toast(
        doc,
        "No included papers. Mark papers as included in Screening & Triage first.",
      );
      return;
    }
    try {
      const job = await getSRService().startGapAnalysisJob(currentState);
      toast(
        doc,
        `Full gap analysis queued for ${job.paperIds.length} paper(s) (extract → synthesis → gaps)`,
      );
      reRenderPanel(doc, "gaps");
    } catch (error) {
      toast(doc, error instanceof Error ? error.message : String(error));
    }
  });
  gapHdr.appendChild(analyzeAllBtn);
  const exportBtn = doc.createElement("button");
  exportBtn.textContent = "Export";
  exportBtn.style.cssText =
    "padding:2px 8px;font-size:10px;border:1px solid var(--border-primary);border-radius:4px;background:transparent;color:var(--text-secondary);cursor:pointer;font-family:inherit;";
  exportBtn.addEventListener("click", () => {
    if (getSRService().getGapAnalysis(currentState!)?.status === "stale") {
      toast(doc, "Refresh the stale gap analysis before exporting");
      return;
    }
    const gaps2 = getPersistedGaps();
    if (gaps2.length === 0) {
      toast(doc, "No gaps to export");
      return;
    }
    const header =
      "id,title,severity,reasonCode,ahrqLabel,description,implication,tags";
    const rows = gaps2.map(
      (g: any) =>
        `"${g.id}","${g.title}","${g.severity}","${g.reasonCode}","${g.ahrqLabel || ""}","${(g.description || "").replace(/"/g, '""')}","${(g.implication || "").replace(/"/g, '""')}","${(g.picos || []).join(";")}"`,
    );
    const csv = [header, ...rows].join("\n");
    try {
      const fp = Cc["@mozilla.org/filepicker;1"].createInstance(
        Ci.nsIFilePicker,
      );
      fp.init(
        (doc.defaultView || (doc as any).ownerGlobal) as any,
        "Export Gap Report",
        Ci.nsIFilePicker.modeSave,
      );
      fp.appendFilter("CSV Files", "*.csv");
      fp.defaultString = "gap_report.csv";
      fp.open((rv: number) => {
        if (rv !== Ci.nsIFilePicker.returnCancel && fp.file) {
          IOUtils.writeUTF8(fp.file.path, csv);
          toast(doc, "Gap report exported to " + fp.file.leafName);
        }
      });
    } catch (e) {
      toast(doc, "Export failed: " + String(e));
    }
  });
  gapHdr.appendChild(exportBtn);
  panel.appendChild(gapHdr);

  const protocolRevision = getActiveProtocolRevision(currentState.protocol);
  const protocolDimensions = protocolRevision.dimensions;
  const dimensionKeys = protocolDimensions.map((dimension) => dimension.key);
  const dimensionNames = Object.fromEntries(
    protocolDimensions.map((dimension) => [dimension.key, dimension.label]),
  );
  const dimensionMappings = Object.fromEntries(
    protocolDimensions.map((dimension) => [
      dimension.key,
      dimension.evidenceLabels,
    ]),
  );
  const activeGapRun = getSRService().getGapAnalysis(currentState);
  if (!activeGapRun) {
    const readiness = getSRService().getSynthesisReadiness(currentState);
    const empty = doc.createElement("div");
    empty.style.cssText =
      "padding:18px;border:1px dashed var(--border-primary);border-radius:8px;text-align:center;color:var(--text-secondary);";
    const reason =
      readiness.verified === 0
        ? readiness.proposed > 0
          ? `${readiness.proposed} proposed extraction row(s) are awaiting verification.`
          : "No verified extraction evidence is available."
        : `${readiness.verified} verified row(s) are ready. Select Refresh to generate the evidence gap map.`;
    empty.textContent = reason;
    const action = doc.createElement("button");
    action.textContent =
      readiness.verified === 0 ? "Open Evidence Review" : "Generate Gap Map";
    action.style.cssText =
      "display:block;margin:10px auto 0;padding:4px 10px;border:1px solid #7c3aed;border-radius:4px;background:#7c3aed;color:#fff;cursor:pointer;";
    action.addEventListener("click", () => {
      if (readiness.verified === 0) {
        currentPanel = "evidence";
        reRenderPanel(doc, "evidence");
      } else {
        refreshBtn.click();
      }
    });
    empty.appendChild(action);
    panel.appendChild(empty);
    return panel;
  }
  if (activeGapRun.status === "stale") {
    const stale = doc.createElement("div");
    stale.textContent =
      "This gap map is stale because review evidence changed. Refresh before accepting or exporting gaps.";
    stale.style.cssText =
      "padding:7px 9px;margin-bottom:9px;border-radius:5px;background:#fef3c7;color:#92400e;font-size:9px;";
    panel.appendChild(stale);
  }
  if (activeGapRun?.cells.length) {
    const rows = Array.from(
      new Map(
        activeGapRun.cells.map((cell) => [
          `${cell.rowKey}:${cell.rowValue}`,
          { key: cell.rowKey, value: cell.rowValue },
        ]),
      ).values(),
    );
    const columns = Array.from(
      new Map(
        activeGapRun.cells.map((cell) => [
          `${cell.columnKey}:${cell.columnValue}`,
          { key: cell.columnKey, value: cell.columnValue },
        ]),
      ).values(),
    );
    const runSummary = doc.createElement("div");
    runSummary.textContent = `${activeGapRun.cells.length} synthesis-derived evidence cells from run ${activeGapRun.id}`;
    runSummary.style.cssText =
      "font-size:10px;color:var(--text-secondary);margin-bottom:8px;";
    panel.appendChild(runSummary);
    const runTable = doc.createElement("table");
    runTable.style.cssText =
      "border-collapse:collapse;width:100%;font-size:9px;margin-bottom:16px;";
    const runHead = doc.createElement("tr");
    const corner = doc.createElement("th");
    corner.textContent = `${activeGapRun.rowDimensionKey} × ${activeGapRun.columnDimensionKey}`;
    runHead.appendChild(corner);
    columns.forEach((column) => {
      const th = doc.createElement("th");
      th.textContent = column.value;
      th.style.cssText =
        "padding:4px;border-bottom:1px solid var(--border-primary);";
      runHead.appendChild(th);
    });
    runTable.appendChild(runHead);
    const statusColors: Record<string, string> = {
      no_evidence: "#dc2626",
      sparse: "#d97706",
      low_certainty: "#ca8a04",
      conflicting: "#9333ea",
      indirect: "#0284c7",
      adequate: "#16a34a",
      not_applicable: "var(--text-tertiary)",
    };
    rows.forEach((rowValue) => {
      const tr = doc.createElement("tr");
      const label = doc.createElement("td");
      label.textContent = rowValue.value;
      label.style.cssText =
        "padding:5px;font-weight:600;border-bottom:1px solid var(--border-secondary);";
      tr.appendChild(label);
      columns.forEach((column) => {
        const cell = activeGapRun.cells.find(
          (candidate) =>
            candidate.rowKey === rowValue.key &&
            candidate.rowValue === rowValue.value &&
            candidate.columnKey === column.key &&
            candidate.columnValue === column.value,
        );
        const td = doc.createElement("td");
        td.style.cssText =
          "padding:5px;text-align:center;border-bottom:1px solid var(--border-secondary);";
        if (cell) {
          const button = doc.createElement("button");
          button.textContent = `${cell.studyCount} · ${formatJobStage(cell.status)}`;
          button.title = cell.rationale;
          button.style.cssText =
            "padding:3px 5px;border:1px solid " +
            (statusColors[cell.status] || "var(--border-primary)") +
            ";border-radius:4px;background:transparent;color:" +
            (statusColors[cell.status] || "var(--text-secondary)") +
            ";font-size:8px;cursor:pointer;";
          button.addEventListener("click", () => {
            const papers = cell.paperIds
              .map((paperId) =>
                currentState!.papers.find((paper) => paper.id === paperId),
              )
              .filter(Boolean) as SystematicReviewPaper[];
            showGapCellPapers(
              doc,
              rowValue.value,
              {
                k: column.key,
                name: column.value,
                color: statusColors[cell.status] || "#64748b",
                bg: "var(--background-secondary)",
              },
              papers,
            );
          });
          td.appendChild(button);
        }
        tr.appendChild(td);
      });
      runTable.appendChild(tr);
    });
    panel.appendChild(runTable);
  } else {
    const colLabels = currentState.labelDefs;
    const matrix: Record<
      string,
      Record<string, { count: number; pids: number[]; confSum: number }>
    > = {};
    dimensionKeys.forEach((pk: string) => {
      matrix[pk] = {};
      colLabels.forEach((ld: LabelDefinition) => {
        matrix[pk][ld.k] = { count: 0, pids: [], confSum: 0 };
      });
    });
    included.forEach((p: SystematicReviewPaper) => {
      const plabels = getPaperLabels(p.id);
      dimensionKeys.forEach((pk: string) => {
        const pmatch = (dimensionMappings[pk] || []).some((pl: string) =>
          plabels.has(pl),
        );
        if (pmatch) {
          colLabels.forEach((ld: LabelDefinition) => {
            if (plabels.has(ld.k)) {
              matrix[pk][ld.k].count++;
              matrix[pk][ld.k].pids.push(p.id);
              matrix[pk][ld.k].confSum += p.confidence || 0;
            }
          });
        }
      });
    });
    let maxCount = 0,
      filled = 0,
      gapped = 0,
      totalC = 0;
    dimensionKeys.forEach((pk: string) =>
      colLabels.forEach((ld: LabelDefinition) => {
        totalC++;
        maxCount = Math.max(maxCount, matrix[pk][ld.k].count);
        if (matrix[pk][ld.k].count > 0) filled++;
        else gapped++;
      }),
    );
    const sumEl = doc.createElement("div");
    sumEl.style.cssText =
      "font-size:10px;color:var(--text-secondary);margin-bottom:12px;line-height:1.5;";
    sumEl.appendChild(
      doc.createTextNode(
        included.length +
          " papers. " +
          filled +
          "/" +
          totalC +
          " cells populated, ",
      ),
    );
    const gs = doc.createElement("strong");
    gs.textContent = String(gapped);
    gs.style.cssText = "color:#dc2626;";
    sumEl.appendChild(gs);
    sumEl.appendChild(
      doc.createTextNode(
        " mapped cells have no verified included evidence. This is a coverage signal, not proof of a research gap.",
      ),
    );
    panel.appendChild(sumEl);
    const legend = doc.createElement("div");
    legend.style.cssText =
      "display:flex;gap:12px;margin-bottom:10px;font-size:9px;color:var(--text-tertiary);";
    [
      { color: "#16a34a", label: "Evidence (" + filled + ")" },
      { color: "#dc2626", label: "Gap (" + gapped + ")" },
    ].forEach((l) => {
      const item = doc.createElement("span");
      item.style.cssText = "display:flex;align-items:center;gap:3px;";
      const dot = doc.createElement("span");
      dot.style.cssText =
        "width:8px;height:8px;border-radius:2px;flex-shrink:0;background:" +
        l.color +
        ";";
      item.appendChild(dot);
      item.appendChild(doc.createTextNode(l.label));
      legend.appendChild(item);
    });
    panel.appendChild(legend);
    const mhdr = doc.createElement("div");
    mhdr.textContent = `${protocolRevision.framework} Dimensions x Evidence Categories`;
    mhdr.style.cssText =
      "font-size:10px;font-weight:600;color:var(--text-primary);margin-bottom:6px;";
    panel.appendChild(mhdr);
    const mtbl = doc.createElement("table");
    mtbl.style.cssText =
      "border-collapse:collapse;width:100%;font-size:9px;margin-bottom:16px;";
    const mthead = doc.createElement("thead");
    const mthr = doc.createElement("tr");
    const thf = doc.createElement("th");
    thf.textContent = protocolRevision.framework;
    thf.style.cssText =
      "padding:4px 6px;text-align:left;font-weight:600;color:var(--text-secondary);border-bottom:1px solid var(--border-primary);";
    mthr.appendChild(thf);
    colLabels.forEach((ld: LabelDefinition) => {
      const th = doc.createElement("th");
      th.textContent = ld.name;
      th.style.cssText =
        "padding:4px 2px;text-align:center;font-weight:500;color:var(--text-tertiary);border-bottom:1px solid var(--border-primary);font-size:8px;";
      mthr.appendChild(th);
    });
    mthead.appendChild(mthr);
    mtbl.appendChild(mthead);
    const mtbody = doc.createElement("tbody");
    dimensionKeys.forEach((pk: string) => {
      const tr = doc.createElement("tr");
      const tdR = doc.createElement("td");
      tdR.textContent = dimensionNames[pk] + " (" + pk + ")";
      tdR.style.cssText =
        "padding:6px;font-weight:600;font-size:9px;color:var(--text-primary);border-bottom:1px solid var(--border-secondary);";
      tr.appendChild(tdR);
      colLabels.forEach((ld: LabelDefinition) => {
        const cell = matrix[pk][ld.k];
        const td = doc.createElement("td");
        td.style.cssText =
          "text-align:center;padding:6px 2px;border-bottom:1px solid var(--border-secondary);";
        if (cell.count === 0) {
          const e = doc.createElement("span");
          e.textContent = "-";
          e.style.cssText =
            "width:24px;height:24px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;font-size:10px;color:var(--text-tertiary);background:var(--background-secondary);border:1px dashed var(--border-primary);";
          td.appendChild(e);
        } else {
          const sz = Math.max(
            18,
            Math.min(40, 16 + (cell.count / maxCount) * 24),
          );
          const avgC = cell.confSum / cell.count;
          const alpha = 0.3 + (avgC / 100) * 0.7;
          const b = doc.createElement("span");
          b.style.cssText =
            "width:" +
            sz +
            "px;height:" +
            sz +
            "px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;font-size:10px;font-weight:600;color:" +
            ld.color +
            ";background:rgba(22,163,74," +
            alpha.toFixed(1) +
            ");border:2px solid " +
            ld.color +
            ";";
          b.textContent = String(cell.count);
          b.style.cursor = "pointer";
          b.addEventListener("click", () => {
            // Show papers in this PICO×Label intersection
            const cellPapers = cell.pids
              .map((pid: number) =>
                currentState!.papers.find(
                  (p: SystematicReviewPaper) => p.id === pid,
                ),
              )
              .filter(Boolean) as SystematicReviewPaper[];
            showGapCellPapers(doc, pk, ld, cellPapers);
          });
          td.appendChild(b);
        }
        tr.appendChild(td);
      });
      mtbody.appendChild(tr);
    });
    mtbl.appendChild(mtbody);
    panel.appendChild(mtbl);
  }
  const gaps = getPersistedGaps();

  // Apply persisted gap statuses
  if (currentState?.gapEdits) {
    gaps.forEach((g: any) => {
      const edits = currentState!.gapEdits[g.id];
      if (edits?.status) g._status = edits.status;
    });
  }

  const filteredGaps =
    gapSeverityFilter === "all"
      ? gaps
      : gaps.filter((g: any) => g.severity.toLowerCase() === gapSeverityFilter);
  if (filteredGaps.length > 0) {
    const ghdr = doc.createElement("div");
    ghdr.textContent = "Detected Gaps (" + filteredGaps.length + ")";
    ghdr.style.cssText =
      "font-size:10px;font-weight:600;color:var(--text-primary);margin-bottom:8px;";
    panel.appendChild(ghdr);
    filteredGaps.forEach((g: any) => {
      const card = doc.createElement("div");
      card.style.cssText =
        "padding:10px;margin-bottom:8px;border-radius:8px;background:var(--background-primary);border-left:3px solid " +
        (g.severity === "High" ? "#dc2626" : "#d97706") +
        ";";
      const cardHdr = doc.createElement("div");
      cardHdr.style.cssText =
        "display:flex;align-items:center;gap:6px;margin-bottom:4px;";
      const sev = doc.createElement("span");
      sev.textContent = g.severity;
      sev.style.cssText =
        "padding:1px 6px;border-radius:10px;font-size:9px;font-weight:600;background:" +
        (g.severity === "High" ? "#fce4ec" : "#fef3c7") +
        ";color:" +
        (g.severity === "High" ? "#dc2626" : "#d97706") +
        ";";
      cardHdr.appendChild(sev);
      const reasonB = doc.createElement("span");
      reasonB.textContent = g.ahrqLabel;
      reasonB.style.cssText =
        "padding:1px 5px;border-radius:3px;font-size:8px;font-weight:600;background:var(--background-secondary);color:var(--text-secondary);";
      cardHdr.appendChild(reasonB);
      (g.picos || []).forEach((tag: string) => {
        const t = doc.createElement("span");
        t.textContent = tag;
        t.style.cssText =
          "padding:1px 4px;border-radius:3px;font-size:8px;font-weight:600;background:var(--background-tertiary);color:var(--text-tertiary);";
        cardHdr.appendChild(t);
      });
      card.appendChild(cardHdr);
      const cTitle = doc.createElement("div");
      cTitle.textContent = g.title;
      cTitle.style.cssText =
        "font-weight:600;font-size:11px;color:var(--text-primary);margin-bottom:4px;";
      card.appendChild(cTitle);
      const cDesc = doc.createElement("div");
      cDesc.textContent = g.description;
      cDesc.style.cssText =
        "font-size:10px;color:var(--text-secondary);line-height:1.5;margin-bottom:4px;";
      card.appendChild(cDesc);
      const cImpl = doc.createElement("div");
      cImpl.textContent = g.implication;
      cImpl.style.cssText =
        "font-size:9px;color:var(--text-tertiary);font-style:italic;line-height:1.4;";
      card.appendChild(cImpl);

      // Status badge
      if (g._status) {
        const statusBadge = doc.createElement("span");
        statusBadge.textContent =
          g._status.charAt(0).toUpperCase() + g._status.slice(1);
        statusBadge.style.cssText =
          "margin-left:8px;font-size:9px;font-weight:600;color:" +
          (g._status === "accepted" ? "#16a34a" : "#dc2626") +
          ";";
        cardHdr.appendChild(statusBadge);
      }

      // Accept/Reject buttons
      const btnRow = doc.createElement("div");
      btnRow.style.cssText = "display:flex;gap:4px;margin-top:6px;";
      const acceptBtn = doc.createElement("button");
      acceptBtn.textContent = "Accept";
      acceptBtn.style.cssText =
        "padding:1px 6px;font-size:9px;border:1px solid #16a34a;border-radius:3px;background:transparent;color:#16a34a;cursor:pointer;font-family:inherit;";
      acceptBtn.addEventListener("click", () => {
        if (getSRService().getGapAnalysis(currentState!)?.status === "stale") {
          toast(doc, "Refresh the stale gap analysis before reviewing gaps");
          return;
        }
        g._status = "accepted";
        if (currentState) {
          getSRService().updateGap(currentState, g.id, {
            status: "accepted",
          });
          if (!currentState.gapEdits[g.id]) {
            currentState.gapEdits[g.id] = {};
          }
          currentState.gapEdits[g.id].status = "accepted";
          saveSRState();
        }
        reRenderPanel(doc, "gaps");
      });
      btnRow.appendChild(acceptBtn);
      const rejectBtn = doc.createElement("button");
      rejectBtn.textContent = "Reject";
      rejectBtn.style.cssText =
        "padding:1px 6px;font-size:9px;border:1px solid #dc2626;border-radius:3px;background:transparent;color:#dc2626;cursor:pointer;font-family:inherit;";
      rejectBtn.addEventListener("click", () => {
        if (getSRService().getGapAnalysis(currentState!)?.status === "stale") {
          toast(doc, "Refresh the stale gap analysis before reviewing gaps");
          return;
        }
        g._status = "rejected";
        if (currentState) {
          getSRService().updateGap(currentState, g.id, {
            status: "rejected",
          });
          if (!currentState.gapEdits[g.id]) {
            currentState.gapEdits[g.id] = {};
          }
          currentState.gapEdits[g.id].status = "rejected";
          saveSRState();
        }
        reRenderPanel(doc, "gaps");
      });
      btnRow.appendChild(rejectBtn);
      const editBtn = doc.createElement("button");
      editBtn.textContent = "Edit";
      editBtn.style.cssText =
        "padding:1px 6px;font-size:9px;border:1px solid var(--border-primary);border-radius:3px;background:transparent;color:var(--text-secondary);cursor:pointer;font-family:inherit;";
      editBtn.addEventListener("click", () => {
        openGapEditor(doc, g);
      });
      btnRow.appendChild(editBtn);
      card.appendChild(btnRow);

      panel.appendChild(card);
    });
  }
  return panel;
}

function openGapEditor(doc: Document, gap: any): void {
  if (!currentState) return;
  const overlay = doc.createElement("div");
  overlay.style.cssText =
    "position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:1000;display:flex;align-items:center;justify-content:center;";
  const modal = doc.createElement("div");
  modal.style.cssText =
    "width:620px;max-width:94vw;max-height:88vh;overflow:auto;padding:16px;background:var(--background-primary);border:1px solid var(--border-primary);border-radius:9px;";
  const heading = doc.createElement("strong");
  heading.textContent = "Edit Evidence Gap";
  heading.style.cssText = "display:block;font-size:14px;margin-bottom:10px;";
  modal.appendChild(heading);
  const title = doc.createElement("input");
  title.value = gap.title;
  title.placeholder = "Gap title";
  modal.appendChild(title);
  const severity = doc.createElement("select");
  ["high", "medium", "low"].forEach((value) => {
    const option = doc.createElement("option");
    option.value = value;
    option.textContent = value.charAt(0).toUpperCase() + value.slice(1);
    option.selected = gap.severity.toLowerCase() === value;
    severity.appendChild(option);
  });
  modal.appendChild(severity);
  const description = doc.createElement("textarea");
  description.value = gap.description;
  description.placeholder = "Evidence and rationale";
  modal.appendChild(description);
  const implication = doc.createElement("textarea");
  implication.value = gap.implication;
  implication.placeholder = "Research implication";
  modal.appendChild(implication);
  const note = doc.createElement("textarea");
  const runGap = getSRService()
    .getGapAnalysis(currentState)
    ?.gaps.find((candidate) => candidate.id === gap.id);
  note.value = runGap?.reviewerNote || "";
  note.placeholder = "Reviewer note";
  modal.appendChild(note);
  Array.from(modal.querySelectorAll("input,select,textarea")).forEach(
    (element) => {
      (element as HTMLElement).style.cssText =
        "display:block;width:100%;box-sizing:border-box;padding:7px;margin-bottom:8px;border:1px solid var(--border-primary);border-radius:4px;background:var(--background-primary);color:var(--text-primary);font:inherit;";
      if ((element as Element).tagName.toLowerCase() === "textarea") {
        (element as HTMLElement).style.minHeight = "85px";
      }
    },
  );
  const actions = doc.createElement("div");
  actions.style.cssText =
    "display:flex;gap:7px;justify-content:flex-end;margin-top:10px;";
  const cancel = doc.createElement("button");
  cancel.textContent = "Cancel";
  cancel.addEventListener("click", () => overlay.remove());
  actions.appendChild(cancel);
  const save = doc.createElement("button");
  save.textContent = "Save Gap";
  save.addEventListener("click", async () => {
    if (!currentState) return;
    getSRService().updateGap(currentState, gap.id, {
      title: title.value.trim(),
      severity: severity.value as "high" | "medium" | "low",
      description: description.value.trim(),
      implication: implication.value.trim(),
      reviewerNote: note.value.trim() || undefined,
    });
    await getSRService().save(currentState);
    overlay.remove();
    reRenderPanel(doc, "gaps");
  });
  actions.appendChild(save);
  [cancel, save].forEach((button, index) => {
    button.style.cssText =
      "padding:5px 11px;border:1px solid " +
      (index ? "#7c3aed" : "var(--border-primary)") +
      ";border-radius:4px;background:" +
      (index ? "#7c3aed" : "transparent") +
      ";color:" +
      (index ? "#fff" : "var(--text-secondary)") +
      ";cursor:pointer;";
  });
  modal.appendChild(actions);
  overlay.appendChild(modal);
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) overlay.remove();
  });
  mountReviewSheet(doc, overlay);
}

function showGapCellPapers(
  doc: Document,
  picoKey: string,
  labelDef: LabelDefinition,
  papers: SystematicReviewPaper[],
): void {
  const overlay = doc.createElement("div");
  overlay.style.cssText =
    "position:fixed;inset:0;background:rgba(0,0,0,0.45);z-index:1000;display:flex;align-items:center;justify-content:center;";
  overlay.addEventListener("click", (e: Event) => {
    if (e.target === overlay) {
      const p = overlay.parentElement;
      if (p) p.removeChild(overlay);
    }
  });

  const modal = doc.createElement("div");
  modal.style.cssText =
    "background:var(--background-primary);border:1px solid var(--border-primary);border-radius:12px;width:500px;max-width:90vw;max-height:80vh;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 12px 48px rgba(0,0,0,0.25);";
  overlay.appendChild(modal);

  const hdr = doc.createElement("div");
  hdr.style.cssText =
    "display:flex;align-items:center;justify-content:space-between;padding:10px 16px;border-bottom:1px solid var(--border-primary);flex-shrink:0;";
  const title = doc.createElement("div");
  title.textContent =
    picoKey + " \u00d7 " + labelDef.name + " (" + papers.length + " papers)";
  title.style.cssText =
    "font-size:13px;font-weight:600;color:var(--text-primary);";
  hdr.appendChild(title);
  const closeBtn = doc.createElement("button");
  closeBtn.textContent = "\u00d7";
  closeBtn.style.cssText =
    "width:24px;height:24px;border:none;background:transparent;color:var(--text-secondary);cursor:pointer;font-size:16px;";
  closeBtn.addEventListener("click", () => {
    const p = overlay.parentElement;
    if (p) p.removeChild(overlay);
  });
  hdr.appendChild(closeBtn);
  modal.appendChild(hdr);

  const body = doc.createElement("div");
  body.style.cssText = "flex:1;overflow-y:auto;padding:8px;";
  papers.forEach((p: SystematicReviewPaper) => {
    const zItem = Zotero.Items.get(p.id);
    const title = zItem
      ? (zItem.getField("title") as string) || `Item ${p.id}`
      : `Item ${p.id}`;
    const creators = zItem ? zItem.getCreators() : [];
    const author =
      creators.length > 0
        ? (creators[0] as any).lastName || (creators[0] as any).name || ""
        : "";
    const year = zItem ? (zItem.getField("year") as string) || "" : "";

    const item = doc.createElement("div");
    item.style.cssText =
      "padding:6px 8px;margin:3px 0;background:var(--background-secondary);border-radius:6px;cursor:pointer;";
    item.addEventListener("click", () => {
      scrActive = p.id;
      currentPanel = "screening";
      const p2 = overlay.parentElement;
      if (p2) p2.removeChild(overlay);
      reRenderPanel(doc, "screening");
    });
    const t = doc.createElement("div");
    t.textContent = title;
    t.style.cssText =
      "font-size:10px;font-weight:500;color:var(--text-primary);";
    item.appendChild(t);
    const s = doc.createElement("div");
    s.textContent =
      (author ? author.split(" ")[0] : "") + (year ? " (" + year + ")" : "");
    s.style.cssText = "font-size:9px;color:var(--text-tertiary);";
    item.appendChild(s);
    body.appendChild(item);
  });
  modal.appendChild(body);
  mountReviewSheet(doc, overlay);
}

function getPersistedGaps(): any[] {
  const run = currentState
    ? getSRService().getGapAnalysis(currentState)
    : undefined;
  return (run?.gaps || []).map((gap) => ({
    id: gap.id,
    severity: gap.severity.charAt(0).toUpperCase() + gap.severity.slice(1),
    picos: [...gap.dimensionTags],
    ahrqLabel: gap.reasonCode,
    title: gap.title,
    description: gap.description,
    implication: gap.implication,
    _status: gap.status === "draft" ? undefined : gap.status,
  }));
}

// ============================================================
// PRISMA PANEL
// ============================================================
function buildPrismaPanel(doc: Document): HTMLElement {
  if (!currentState) return doc.createElement("div");
  const panel = doc.createElement("div");
  panel.style.cssText = "flex:1;overflow-y:auto;padding:12px;min-height:0;";
  const hdr = doc.createElement("div");
  hdr.style.cssText =
    "display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;";
  const hdrTitle = doc.createElement("div");
  hdrTitle.textContent = "PRISMA 2020 Flow Diagram";
  hdrTitle.style.cssText =
    "font-size:13px;font-weight:600;color:var(--text-primary);";
  hdr.appendChild(hdrTitle);
  const copyBtn = doc.createElement("button");
  copyBtn.textContent = "Copy PRISMA";
  copyBtn.style.cssText =
    "padding:3px 10px;font-size:10px;border:1px solid var(--border-primary);border-radius:4px;background:transparent;color:var(--text-secondary);cursor:pointer;font-family:inherit;";
  copyBtn.addEventListener("click", () => {
    const text = buildPrismaText(currentState!);
    if (text) {
      try {
        new ztoolkit.Clipboard().addText(text, "text/unicode").copy();
        toast(doc, "PRISMA text copied to clipboard");
      } catch {
        toast(doc, "Failed to copy to clipboard");
      }
    }
  });
  hdr.appendChild(copyBtn);
  const dlBtn = doc.createElement("button");
  dlBtn.textContent = "Save Text";
  dlBtn.style.cssText =
    "padding:3px 10px;font-size:10px;border:1px solid var(--border-primary);border-radius:4px;background:transparent;color:var(--text-secondary);cursor:pointer;font-family:inherit;";
  dlBtn.addEventListener("click", async () => {
    const text = buildPrismaText(currentState!);
    if (text) {
      try {
        const win = doc.defaultView;
        const Cc = (Components as any).classes;
        const Ci = (Components as any).interfaces;
        const fp = Cc["@mozilla.org/filepicker;1"].createInstance(
          Ci.nsIFilePicker,
        );
        fp.init(win, "Save PRISMA Diagram", Ci.nsIFilePicker.modeSave);
        fp.defaultString = "prisma-flow-diagram.txt";
        fp.appendFilter("Text Files", "*.txt");
        const rv = await new Promise<number>((resolve) => fp.open(resolve));
        if (rv !== Ci.nsIFilePicker.returnCancel && fp.file) {
          await IOUtils.writeUTF8(fp.file.path, text);
          toast(doc, "PRISMA diagram saved");
        }
      } catch {
        toast(doc, "Failed to save file");
      }
    }
  });
  hdr.appendChild(dlBtn);
  panel.appendChild(hdr);
  const prisma = getPrismaSnapshot(currentState);
  if (!prisma.complete) {
    const warning = doc.createElement("div");
    warning.textContent =
      "Incomplete PRISMA dataset. Not recorded: " +
      prisma.missing.join(", ") +
      ". Unknown counts are not estimated.";
    warning.style.cssText =
      "padding:8px 10px;margin-bottom:12px;border-radius:6px;background:#fef3c7;color:#854d0e;font-size:10px;line-height:1.5;";
    panel.appendChild(warning);
  }
  const dbFolders = currentState.folders.filter(
    (f: any) => f.type === "Database",
  );
  const regFolders = currentState.folders.filter(
    (f: any) => f.type === "Register",
  );
  const otherFolders = currentState.folders.filter(
    (f: any) => f.type === "Other source",
  );
  let dbTotal = 0;
  let dbLines = "";
  dbFolders.forEach((f: any) => {
    const count = getSourceOccurrenceCount(currentState!, f.id);
    dbLines += "\n  " + f.srcLabel + " (n = " + count + ")";
    dbTotal += count;
  });
  let regTotal = 0;
  let regLines = "";
  regFolders.forEach((f: any) => {
    const count = getSourceOccurrenceCount(currentState!, f.id);
    regLines += "\n  " + f.srcLabel + " (n = " + count + ")";
    regTotal += count;
  });
  let otherTotal = 0;
  let otherLines = "";
  otherFolders.forEach((f: any) => {
    const count = getSourceOccurrenceCount(currentState!, f.id);
    otherLines += "\n  " + f.srcLabel + " (n = " + count + ")";
    otherTotal += count;
  });
  const screened = prisma.screened;
  const excluded = prisma.excluded;
  const included = prisma.included;
  const wrap = doc.createElement("div");
  wrap.className = "sr-prisma";
  // Box 1: Identification via databases and registers
  const box1 = doc.createElement("div");
  box1.className = "sr-prisma-box sr-prisma-box-top";
  const b1Title = doc.createElement("h3");
  b1Title.textContent = "Identification of studies via databases and registers";
  box1.appendChild(b1Title);
  const twoCol = doc.createElement("div");
  twoCol.className = "sr-prisma-two-col";
  const colL = doc.createElement("div");
  colL.className = "col";
  const colLb = doc.createElement("b");
  colLb.textContent = "Records identified from:";
  colL.appendChild(colLb);
  if (dbLines) {
    const dbRow = doc.createElement("div");
    dbRow.className = "sr-row";
    dbRow.appendChild(
      doc.createTextNode(
        "Configured database collection size (not occurrence count): " +
          dbTotal,
      ),
    );
    dbLines.split("\n").forEach((line: string) => {
      if (line.trim()) {
        const r = doc.createElement("div");
        r.className = "sr-row indent";
        const d = doc.createElement("span");
        d.className = "dim";
        d.textContent = line.trim();
        r.appendChild(d);
        colL.appendChild(r);
      }
    });
  }
  if (regLines) {
    colL.appendChild(
      doc.createTextNode(
        "\nConfigured register collection size (not occurrence count): " +
          regTotal,
      ),
    );
    regLines.split("\n").forEach((line: string) => {
      if (line.trim()) {
        const r = doc.createElement("div");
        r.className = "sr-row indent";
        const d = doc.createElement("span");
        d.className = "dim";
        d.textContent = line.trim();
        r.appendChild(d);
        colL.appendChild(r);
      }
    });
  }
  twoCol.appendChild(colL);
  const colR = doc.createElement("div");
  colR.className = "col";
  const colRb = doc.createElement("b");
  colRb.textContent = "Records removed before screening:";
  colR.appendChild(colRb);
  const makeReasonRow = (label: string, val: number | null) => {
    const r = doc.createElement("div");
    r.className = "sr-row indent";
    const d = doc.createElement("span");
    d.className = "dim";
    d.textContent = label;
    r.appendChild(d);
    const v = doc.createElement("span");
    v.className = "val";
    v.textContent = val === null ? " (not recorded)" : " (n = " + val + ")";
    r.appendChild(v);
    return r;
  };
  colR.appendChild(makeReasonRow("Duplicate records", prisma.duplicates));
  colR.appendChild(makeReasonRow("Marked ineligible by automation", null));
  colR.appendChild(makeReasonRow("Removed for other reasons", null));
  twoCol.appendChild(colR);
  box1.appendChild(twoCol);
  wrap.appendChild(box1);
  // Other methods
  if (otherLines) {
    const box2 = doc.createElement("div");
    box2.className = "sr-prisma-box sr-prisma-box-mid";
    const b2Title = doc.createElement("h3");
    b2Title.textContent = "Identification of studies via other methods";
    box2.appendChild(b2Title);
    const otherRow = doc.createElement("div");
    otherRow.className = "sr-row";
    otherRow.appendChild(doc.createTextNode("Records identified from:"));
    otherLines.split("\n").forEach((line: string) => {
      if (line.trim()) {
        const r = doc.createElement("div");
        r.className = "sr-row indent";
        const d = doc.createElement("span");
        d.className = "dim";
        d.textContent = line.trim();
        r.appendChild(d);
        otherRow.appendChild(r);
      }
    });
    box2.appendChild(otherRow);
    wrap.appendChild(box2);
  }
  // Screening split
  wrap.appendChild(makeArrow(doc));
  const split1 = makePrismaSplit(
    doc,
    "Records screened\n(n = " + screened + ")",
    "Records excluded\n(n = " + excluded + ")",
    [],
  );
  wrap.appendChild(split1);
  // Retrieval split
  wrap.appendChild(makeArrow(doc));
  const split2 = makePrismaSplit(
    doc,
    "Reports sought for retrieval\n(not recorded)",
    "Reports not retrieved\n(not recorded)",
    [],
  );
  wrap.appendChild(split2);
  // Eligibility split
  wrap.appendChild(makeArrow(doc));
  const split3 = makePrismaSplit(
    doc,
    "Reports assessed for eligibility\n(not recorded)",
    "Full-text exclusions\n(not recorded)",
    [],
  );
  wrap.appendChild(split3);
  // Included box
  wrap.appendChild(makeArrow(doc));
  const boxBot = doc.createElement("div");
  boxBot.className = "sr-prisma-box sr-prisma-box-bot";
  const botTitle = doc.createElement("h3");
  botTitle.textContent = "Included";
  boxBot.appendChild(botTitle);
  const incRow = doc.createElement("div");
  incRow.className = "sr-row";
  const incVal = doc.createElement("span");
  incVal.className = "val";
  incVal.textContent = "Studies included in review (n = " + included + ")";
  incRow.appendChild(incVal);
  boxBot.appendChild(incRow);
  wrap.appendChild(boxBot);
  panel.appendChild(wrap);
  return panel;
}

function makeArrow(doc: Document): HTMLElement {
  const ac = doc.createElement("div");
  ac.className = "sr-prisma-arrow-down";
  const arr = doc.createElement("span");
  arr.replaceChildren(
    createSvgIcon(arr.ownerDocument!, ICONS.arrowDown, "sort descending", 14),
  );
  ac.appendChild(arr);
  return ac;
}

function buildPrismaText(state: SystematicReviewState): string {
  const snapshot = getPrismaSnapshot(state);
  const dbFolders = state.folders.filter((f: any) => f.type === "Database");
  const regFolders = state.folders.filter((f: any) => f.type === "Register");
  const otherFolders = state.folders.filter(
    (f: any) => f.type === "Other source",
  );
  let dbTotal = 0;
  dbFolders.forEach(
    (f: any) => (dbTotal += getSourceOccurrenceCount(state, f.id)),
  );
  let regTotal = 0;
  regFolders.forEach(
    (f: any) => (regTotal += getSourceOccurrenceCount(state, f.id)),
  );
  let otherTotal = 0;
  otherFolders.forEach(
    (f: any) => (otherTotal += getSourceOccurrenceCount(state, f.id)),
  );
  let t = "PRISMA 2020 Flow Diagram\n";
  t += "========================\n\n";
  t +=
    "STATUS: INCOMPLETE - unknown values are not estimated.\nMissing: " +
    snapshot.missing.join(", ") +
    "\n\n";
  t += "IDENTIFICATION\n";
  t += "  Unique records in active review (n = " + snapshot.identified + ")\n";
  if (dbFolders.length) {
    t += "  Configured database collection sizes (not occurrence counts):\n";
    dbFolders.forEach((f: any) => {
      t +=
        "    " +
        f.srcLabel +
        " (n = " +
        getSourceOccurrenceCount(state, f.id) +
        ")\n";
    });
  }
  if (regFolders.length) {
    t += "  Configured register collection sizes (not occurrence counts):\n";
    regFolders.forEach((f: any) => {
      t +=
        "    " +
        f.srcLabel +
        " (n = " +
        getSourceOccurrenceCount(state, f.id) +
        ")\n";
    });
  }
  if (otherFolders.length) {
    t += "  Configured other-source collection sizes:\n";
    otherFolders.forEach((f: any) => {
      t +=
        "    " +
        f.srcLabel +
        " (n = " +
        getSourceOccurrenceCount(state, f.id) +
        ")\n";
    });
  }
  t += "\nSCREENING\n";
  t += "  Records screened (n = " + snapshot.screened + ")\n";
  t += "  Records excluded (n = " + snapshot.excluded + ")\n\n";
  t += "RETRIEVAL AND ELIGIBILITY\n";
  t += "  Reports sought: not recorded\n";
  t += "  Reports not retrieved: not recorded\n";
  t += "  Full-text exclusions: not recorded\n\n";
  t += "INCLUDED\n";
  t += "  Included (n = " + snapshot.included + ")\n";
  t += "  Maybe/Unclear (n = " + snapshot.maybe + ")\n";
  return t;
}

function makePrismaSplit(
  doc: Document,
  leftLabel: string,
  rightLabel: string,
  _reasons: string[],
): HTMLElement {
  const grid = doc.createElement("div");
  grid.className = "sr-prisma-split";
  const boxL = doc.createElement("div");
  boxL.className = "box-l";
  boxL.style.whiteSpace = "pre-line";
  boxL.textContent = leftLabel;
  grid.appendChild(boxL);
  const ac = doc.createElement("div");
  ac.className = "arrow-cell";
  const arr = doc.createElement("span");
  arr.textContent = "\u2192";
  ac.appendChild(arr);
  grid.appendChild(ac);
  const boxR = doc.createElement("div");
  boxR.className = "box-r";
  boxR.style.whiteSpace = "pre-line";
  boxR.textContent = rightLabel;
  grid.appendChild(boxR);
  return grid;
}

// ============================================================
// HELPERS
// ============================================================
function buildEmptyState(
  doc: Document,
  icon: string,
  title: string,
  desc: string,
): HTMLElement {
  const div = doc.createElement("div");
  div.style.cssText =
    "display:flex;flex-direction:column;align-items:center;justify-content:center;padding:48px 24px;text-align:center;gap:12px;";
  const h = doc.createElement("div");
  h.textContent = title;
  h.style.cssText =
    "font-size:14px;font-weight:500;color:var(--text-secondary);";
  div.appendChild(h);
  const p = doc.createElement("div");
  p.textContent = desc;
  p.style.cssText =
    "font-size:11px;color:var(--text-tertiary);max-width:320px;line-height:1.5;";
  div.appendChild(p);
  return div;
}

function applyDecision(decision: ScreeningDecision, doc: Document): void {
  if (!currentState || scrActive === null) return;
  const next = getAdjacentFilteredPaper(1);
  const paper = currentState.papers.find(
    (p: SystematicReviewPaper) => p.id === scrActive,
  );
  if (!paper) return;
  undoStack.push({
    id: paper.id,
    prevStatus: paper.status,
    prevReason: paper.exclReason,
    prevStage: paper.screeningStage,
  });
  if (undoStack.length > 50) undoStack.shift();
  getSRService().setDecision(
    currentState,
    paper.id,
    decision,
    undefined,
    "final",
  );
  const space = getActiveSpace();
  if (space) space.paperStatus[paper.id] = decision;
  if (decision !== "excluded") {
    paper.exclReason = undefined;
    showReason = false;
  }
  getSRStore().saveState(currentState);
  const list = contentArea?.querySelector(".sr-art-list");
  const changedRow = list?.querySelector(
    `.sr-art[data-sid="${paper.id}"]`,
  ) as HTMLElement | null;
  if (changedRow) applyArticleRowStatusStyles(changedRow, paper);
  toast(doc, "Marked as " + decision);
  advanceToNextPaper(doc, next);
}

function undoDecision(doc: Document): void {
  const prev = undoStack.pop();
  if (!prev) {
    toast(doc, "Nothing to undo");
    return;
  }
  const paper = currentState?.papers.find(
    (p: SystematicReviewPaper) => p.id === prev.id,
  );
  if (!paper || !currentState) return;
  getSRService().setDecision(
    currentState,
    paper.id,
    prev.prevStatus,
    prev.prevReason,
    prev.prevStage || "final",
  );
  getSRStore().saveState(currentState);
  const title = Zotero.Items.get(paper.id)?.getField("title") || "";
  toast(
    doc,
    "Undo: " + trunc(title as string, 40) + " back to " + prev.prevStatus,
  );
  reRenderPanel(doc, "screening");
}

function findNextUndecided(): SystematicReviewPaper | null {
  const filtered = scrFiltered();
  let found = false;
  for (let i = 0; i < filtered.length; i++) {
    if (found && filtered[i].status === "undecided") return filtered[i];
    if (filtered[i].id === scrActive) found = true;
  }
  return null;
}

function getAdjacentFilteredPaper(
  direction: -1 | 1,
): SystematicReviewPaper | null {
  const filtered = scrFiltered();
  if (filtered.length === 0) return null;
  const idx = scrActive
    ? filtered.findIndex((paper) => paper.id === scrActive)
    : direction > 0
      ? -1
      : filtered.length;
  const nextIndex = idx + direction;
  if (nextIndex >= 0 && nextIndex < filtered.length) {
    return filtered[nextIndex];
  }
  return null;
}

function scrollActivePaperIntoView(doc: Document): void {
  doc.defaultView?.requestAnimationFrame(() => {
    const row = contentArea?.querySelector(
      `.sr-art[data-sid="${scrActive}"]`,
    ) as HTMLElement | null;
    if (row) {
      row.scrollIntoView({ block: "nearest" });
    }
  });
}

function focusScreeningDetail(doc: Document): void {
  doc.defaultView?.requestAnimationFrame(() => {
    const detail = contentArea?.querySelector(
      ".sr-screening-detail",
    ) as HTMLElement | null;
    detail?.focus({ preventScroll: true });
  });
}

function advanceToNextPaper(
  doc: Document,
  next: SystematicReviewPaper | null = null,
): void {
  const target = next || getAdjacentFilteredPaper(1);
  showNote = false;
  showReason = false;
  showLabelRow = false;
  showSourceLabelRow = false;
  if (target) {
    selectScreeningPaper(doc, target.id, {
      resetDetailScroll: true,
      scrollIntoView: true,
    });
    return;
  }
  selectScreeningPaper(doc, null, { resetDetailScroll: true });
}

function acceptCurrentSuggestion(doc: Document, paperId?: number): void {
  if (!currentState) return;
  const targetId = paperId ?? scrActive;
  if (targetId === null || targetId === undefined) return;
  const next = getAdjacentFilteredPaper(1);
  const source = currentState.papers.find((paper) => paper.id === targetId)
    ?.recommendation?.source;
  getSRService().acceptRecommendation(currentState, targetId);
  saveSRState();
  toast(
    doc,
    `${source === "model" ? "AI" : "Keyword"} suggestion accepted as a confirmed decision`,
  );
  const paper = currentState.papers.find((p) => p.id === targetId);
  if (paper) {
    const list = contentArea?.querySelector(".sr-art-list");
    const row = list?.querySelector(
      `.sr-art[data-sid="${paper.id}"]`,
    ) as HTMLElement | null;
    if (row) applyArticleRowStatusStyles(row, paper);
  }
  advanceToNextPaper(doc, next);
}

function navigateToNext(doc: Document): void {
  if (!currentState) return;
  const filtered = scrFiltered();
  if (filtered.length === 0) return;
  if (scrActive === null) {
    selectScreeningPaper(doc, filtered[0].id, {
      resetDetailScroll: true,
      scrollIntoView: true,
    });
    return;
  }
  const idx = filtered.findIndex(
    (p: SystematicReviewPaper) => p.id === scrActive,
  );
  if (idx >= 0 && idx < filtered.length - 1) {
    selectScreeningPaper(doc, filtered[idx + 1].id, {
      resetDetailScroll: true,
      scrollIntoView: true,
    });
  }
}

function navigateToPrev(doc: Document): void {
  if (!currentState) return;
  const filtered = scrFiltered();
  if (filtered.length === 0) return;
  if (scrActive === null) {
    selectScreeningPaper(doc, filtered[filtered.length - 1].id, {
      resetDetailScroll: true,
      scrollIntoView: true,
    });
    return;
  }
  const idx = filtered.findIndex(
    (p: SystematicReviewPaper) => p.id === scrActive,
  );
  if (idx > 0) {
    selectScreeningPaper(doc, filtered[idx - 1].id, {
      resetDetailScroll: true,
      scrollIntoView: true,
    });
  }
}

function loadSpace(doc: Document): void {
  if (!currentState) return;
  const space = currentState.spaces.find(
    (s: SystematicReviewSpace) => s.id === currentState!.activeSpaceId,
  );
  if (!space) return;
  Object.entries(space.paperStatus).forEach(([k, v]) => {
    const p = currentState!.papers.find(
      (x: SystematicReviewPaper) => x.id === parseInt(k),
    );
    if (p) {
      p.status = v;
      p.aiStatus = "manual";
    }
  });
}

function getActiveSpace(): SystematicReviewSpace | undefined {
  if (!currentState) return undefined;
  const cs = currentState;
  return cs.spaces.find(
    (s: SystematicReviewSpace) => s.id === cs.activeSpaceId,
  );
}

function reRender(doc: Document): void {
  if (!currentState || !mainWrapper) return;
  const parent = mainWrapper.parentElement;
  if (!parent) return;
  parent.removeChild(mainWrapper);
  invalidateItemCache();
  const anyId = currentState.papers[0]?.id;
  const item = anyId ? (Zotero.Items.get(anyId) as Zotero.Item) : undefined;
  createSystematicReviewTabContent(doc, item).then((newEl: HTMLElement) => {
    mainWrapper = newEl;
    parent.appendChild(newEl);
  });
}

// ============================================================
// EXTRACTION MODAL
// ============================================================
function openExtractionWorkspace(doc: Document, pid?: number): void {
  if (!currentState) return;
  const overlay = doc.createElement("div");
  overlay.style.cssText =
    "position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:1000;display:flex;align-items:center;justify-content:center;";
  const modal = doc.createElement("div");
  modal.style.cssText =
    "background:var(--background-primary);border:1px solid var(--border-primary);border-radius:10px;width:920px;max-width:96vw;height:86vh;display:flex;flex-direction:column;overflow:hidden;";
  overlay.appendChild(modal);
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) overlay.remove();
  });

  const header = doc.createElement("div");
  header.style.cssText =
    "display:flex;align-items:center;gap:8px;padding:10px 14px;border-bottom:1px solid var(--border-primary);";
  const title = doc.createElement("strong");
  title.textContent = "Extraction Workspace";
  title.style.cssText = "font-size:14px;";
  header.appendChild(title);
  const spacer = doc.createElement("span");
  spacer.style.flex = "1";
  header.appendChild(spacer);
  const close = doc.createElement("button");
  close.textContent = "Close";
  close.style.cssText =
    "padding:3px 9px;border:1px solid var(--border-primary);border-radius:4px;background:transparent;color:var(--text-secondary);cursor:pointer;";
  close.addEventListener("click", () => overlay.remove());
  header.appendChild(close);
  modal.appendChild(header);

  const body = doc.createElement("div");
  body.style.cssText = "flex:1;overflow:auto;padding:14px;";
  modal.appendChild(body);

  const render = (): void => {
    if (!currentState) return;
    body.replaceChildren();
    const active = getSRService().getExtractionTemplate(currentState);
    const draft = [...currentState.extractionTemplates]
      .reverse()
      .find((template) => template.status === "draft");
    const template = draft || active;
    if (!template) {
      const empty = doc.createElement("div");
      empty.style.cssText =
        "max-width:560px;margin:50px auto;text-align:center;padding:24px;border:1px dashed var(--border-primary);border-radius:8px;";
      const emptyTitle = doc.createElement("strong");
      emptyTitle.textContent = "Define what the review should extract";
      empty.appendChild(emptyTitle);
      const text = doc.createElement("p");
      text.textContent =
        "Generate an editable outcome template from the active review criteria, then approve it before running extraction.";
      text.style.cssText =
        "font-size:11px;line-height:1.5;color:var(--text-secondary);";
      empty.appendChild(text);
      const generate = doc.createElement("button");
      generate.textContent = "Generate Template from Criteria";
      generate.style.cssText =
        "padding:6px 12px;border:none;border-radius:5px;background:#7c3aed;color:#fff;font-weight:600;cursor:pointer;";
      generate.addEventListener("click", async () => {
        if (!currentState) return;
        generate.disabled = true;
        generate.textContent = "Generating template...";
        try {
          await getSRService().proposeTemplate(currentState);
          render();
        } catch (error) {
          generate.disabled = false;
          generate.textContent = "Generate Template from Criteria";
          toast(doc, error instanceof Error ? error.message : String(error));
        }
      });
      empty.appendChild(generate);
      body.appendChild(empty);
      return;
    }

    const templateBox = doc.createElement("section");
    templateBox.style.cssText =
      "border:1px solid var(--border-secondary);border-radius:8px;padding:10px;margin-bottom:14px;";
    const templateHeader = doc.createElement("div");
    templateHeader.style.cssText =
      "display:flex;align-items:center;gap:8px;margin-bottom:8px;";
    const templateTitle = doc.createElement("strong");
    templateTitle.textContent =
      template.status === "active"
        ? `Active template: ${template.name}`
        : `Draft template: ${template.name}`;
    templateHeader.appendChild(templateTitle);
    const templateStatus = doc.createElement("span");
    templateStatus.textContent = template.status;
    templateStatus.style.cssText =
      "font-size:9px;padding:2px 6px;border-radius:8px;background:var(--background-secondary);color:var(--text-secondary);";
    templateHeader.appendChild(templateStatus);
    const templateSpacer = doc.createElement("span");
    templateSpacer.style.flex = "1";
    templateHeader.appendChild(templateSpacer);
    const regenerate = doc.createElement("button");
    regenerate.textContent = "Regenerate";
    regenerate.style.cssText =
      "padding:3px 8px;border:1px solid var(--border-primary);border-radius:4px;background:transparent;color:var(--text-secondary);cursor:pointer;";
    regenerate.addEventListener("click", async () => {
      if (!currentState) return;
      regenerate.disabled = true;
      regenerate.textContent = "Generating...";
      try {
        await getSRService().proposeTemplate(
          currentState,
          template.instructions,
        );
        render();
      } catch (error) {
        regenerate.disabled = false;
        regenerate.textContent = "Regenerate";
        toast(doc, error instanceof Error ? error.message : String(error));
      }
    });
    templateHeader.appendChild(regenerate);
    templateBox.appendChild(templateHeader);

    const nameInput = doc.createElement("input");
    nameInput.value = template.name;
    nameInput.placeholder = "Template name";
    nameInput.style.cssText =
      "width:100%;padding:5px;margin-bottom:6px;border:1px solid var(--border-primary);border-radius:4px;background:var(--background-primary);color:var(--text-primary);";
    templateBox.appendChild(nameInput);
    const instructions = doc.createElement("textarea");
    instructions.value = template.instructions;
    instructions.placeholder =
      "Instructions for AI extraction and reviewer conventions";
    instructions.style.cssText =
      "width:100%;min-height:52px;padding:5px;margin-bottom:8px;border:1px solid var(--border-primary);border-radius:4px;background:var(--background-primary);color:var(--text-primary);font-family:inherit;";
    templateBox.appendChild(instructions);

    const outcomeRows = doc.createElement("div");
    const editableOutcomes = template.outcomes.map((outcome) => ({
      ...outcome,
      aliases: [...outcome.aliases],
      measures: [...outcome.measures],
      timepoints: [...outcome.timepoints],
    }));
    const drawOutcomes = (): void => {
      outcomeRows.replaceChildren();
      editableOutcomes.forEach((outcome, index) => {
        const row = doc.createElement("div");
        row.style.cssText =
          "display:grid;grid-template-columns:minmax(150px,1.4fr) minmax(110px,.8fr) minmax(120px,1fr) auto auto;gap:5px;align-items:center;margin-bottom:5px;";
        const outcomeName = doc.createElement("input");
        outcomeName.value = outcome.name;
        outcomeName.placeholder = "Outcome";
        outcomeName.addEventListener("input", () => {
          outcome.name = outcomeName.value;
        });
        row.appendChild(outcomeName);
        const measures = doc.createElement("input");
        measures.value = outcome.measures.join(", ");
        measures.placeholder = "OR, RR, MD";
        measures.title = "Allowed measures separated by commas";
        measures.addEventListener("input", () => {
          outcome.measures = measures.value
            .split(",")
            .map((value) => value.trim().toUpperCase())
            .filter((value) =>
              ["OR", "RR", "HR", "MD", "SMD"].includes(value),
            ) as typeof outcome.measures;
        });
        row.appendChild(measures);
        const timepoints = doc.createElement("input");
        timepoints.value = outcome.timepoints.join(", ");
        timepoints.placeholder = "Timepoints";
        timepoints.addEventListener("input", () => {
          outcome.timepoints = timepoints.value
            .split(",")
            .map((value) => value.trim())
            .filter(Boolean);
        });
        row.appendChild(timepoints);
        const required = doc.createElement("label");
        required.style.cssText =
          "display:flex;align-items:center;gap:3px;font-size:10px;";
        const requiredInput = doc.createElement("input");
        requiredInput.type = "checkbox";
        requiredInput.checked = outcome.required;
        requiredInput.addEventListener("change", () => {
          outcome.required = requiredInput.checked;
        });
        required.append(requiredInput, doc.createTextNode("Required"));
        row.appendChild(required);
        const remove = doc.createElement("button");
        remove.textContent = "Remove";
        remove.addEventListener("click", () => {
          editableOutcomes.splice(index, 1);
          drawOutcomes();
        });
        row.appendChild(remove);
        Array.from(row.querySelectorAll("input,button")).forEach((element) => {
          (element as HTMLElement).style.cssText +=
            "padding:4px;border:1px solid var(--border-primary);border-radius:4px;background:var(--background-primary);color:var(--text-primary);font-size:10px;";
        });
        outcomeRows.appendChild(row);
      });
    };
    drawOutcomes();
    templateBox.appendChild(outcomeRows);
    const templateActions = doc.createElement("div");
    templateActions.style.cssText =
      "display:flex;gap:6px;justify-content:flex-end;margin-top:8px;";
    const addOutcome = doc.createElement("button");
    addOutcome.textContent = "Add Outcome";
    addOutcome.addEventListener("click", () => {
      editableOutcomes.push({
        id: `outcome_custom_${Date.now()}`,
        name: "",
        aliases: [],
        description: "",
        measures: ["OR"],
        timepoints: [],
        required: true,
      });
      drawOutcomes();
    });
    templateActions.appendChild(addOutcome);
    const approve = doc.createElement("button");
    approve.textContent =
      template.status === "active" ? "Save New Revision" : "Save and Approve";
    approve.addEventListener("click", async () => {
      if (!currentState) return;
      const validOutcomes = editableOutcomes.filter(
        (outcome) => outcome.name.trim() && outcome.measures.length,
      );
      if (!validOutcomes.length) {
        toast(doc, "Add at least one named outcome and allowed measure");
        return;
      }
      const edited: ExtractionTemplate = {
        ...template,
        name: nameInput.value.trim() || "Extraction Template",
        instructions: instructions.value.trim(),
        outcomes: validOutcomes,
      };
      const updated = getSRService().updateTemplate(currentState, edited);
      getSRService().activateTemplate(currentState, updated.id);
      await getSRService().save(currentState);
      toast(doc, "Extraction template approved");
      render();
    });
    [addOutcome, approve].forEach((button, index) => {
      button.style.cssText =
        "padding:4px 9px;border:1px solid " +
        (index ? "#7c3aed" : "var(--border-primary)") +
        ";border-radius:4px;background:" +
        (index ? "#7c3aed" : "transparent") +
        ";color:" +
        (index ? "#fff" : "var(--text-secondary)") +
        ";cursor:pointer;";
    });
    templateActions.appendChild(approve);
    templateBox.appendChild(templateActions);
    body.appendChild(templateBox);

    if (!active) {
      const pending = doc.createElement("div");
      pending.textContent =
        "Approve this template to enable AI and manual extraction.";
      pending.style.cssText =
        "padding:12px;text-align:center;color:var(--text-secondary);";
      body.appendChild(pending);
      return;
    }

    const paper =
      pid === undefined
        ? undefined
        : currentState.papers.find((candidate) => candidate.id === pid);
    if (!paper || pid === undefined) {
      const templateOnly = doc.createElement("div");
      templateOnly.textContent =
        "The template is ready. Include a paper to enter or generate extraction data.";
      templateOnly.style.cssText =
        "padding:14px;text-align:center;color:var(--text-secondary);border:1px dashed var(--border-primary);border-radius:6px;";
      body.appendChild(templateOnly);
      return;
    }
    const meta = getItemMeta(pid);
    const paperHeader = doc.createElement("div");
    paperHeader.style.cssText =
      "display:flex;align-items:center;gap:8px;margin-bottom:8px;";
    const paperTitle = doc.createElement("strong");
    paperTitle.textContent = meta.title || `Paper ${pid}`;
    paperHeader.appendChild(paperTitle);
    const paperSpacer = doc.createElement("span");
    paperSpacer.style.flex = "1";
    paperHeader.appendChild(paperSpacer);
    const extract = doc.createElement("button");
    extract.textContent = "AI Extract This Paper";
    extract.style.cssText =
      "padding:5px 10px;border:none;border-radius:4px;background:#0369a1;color:#fff;font-weight:600;cursor:pointer;";
    extract.addEventListener("click", async () => {
      if (!currentState || !paper) return;
      try {
        const job = await getSRService().startReviewJob(
          currentState,
          "extraction",
          [pid],
        );
        toast(doc, `Extraction job ${job.id} started`);
        overlay.remove();
      } catch (error) {
        toast(doc, error instanceof Error ? error.message : String(error));
      }
    });
    paperHeader.appendChild(extract);
    const manual = doc.createElement("button");
    manual.textContent = "Add Manual Result";
    manual.style.cssText =
      "padding:5px 10px;border:1px solid var(--border-primary);border-radius:4px;background:transparent;color:var(--text-secondary);cursor:pointer;";
    manual.addEventListener("click", () => {
      const existingForm = body.querySelector(".sr-manual-extraction");
      if (existingForm) {
        existingForm.remove();
        return;
      }
      const form = doc.createElement("div");
      form.className = "sr-manual-extraction";
      form.style.cssText =
        "display:grid;grid-template-columns:repeat(5,minmax(90px,1fr));gap:6px;padding:10px;margin-bottom:10px;border:1px solid var(--border-primary);border-radius:6px;background:var(--background-secondary);";
      const outcomeSelect = doc.createElement("select");
      active.outcomes.forEach((outcome) => {
        const option = doc.createElement("option");
        option.value = outcome.id;
        option.textContent = outcome.name;
        outcomeSelect.appendChild(option);
      });
      form.appendChild(outcomeSelect);
      const measureSelect = doc.createElement("select");
      ["OR", "RR", "HR", "MD", "SMD"].forEach((measure) => {
        const option = doc.createElement("option");
        option.value = measure;
        option.textContent = measure;
        measureSelect.appendChild(option);
      });
      form.appendChild(measureSelect);
      const inputs = [
        ["Estimate", "number"],
        ["CI low", "number"],
        ["CI high", "number"],
        ["Sample N", "number"],
        ["Events", "number"],
        ["Timepoint", "text"],
        ["Page", "text"],
      ].map(([placeholder, type]) => {
        const input = doc.createElement("input");
        input.placeholder = placeholder;
        input.type = type;
        form.appendChild(input);
        return input;
      });
      const quoteInput = doc.createElement("textarea");
      quoteInput.placeholder = "Exact supporting source quote";
      quoteInput.style.gridColumn = "span 4";
      form.appendChild(quoteInput);
      const save = doc.createElement("button");
      save.textContent = "Save Proposal";
      save.addEventListener("click", async () => {
        if (!currentState) return;
        const selectedOutcome = active.outcomes.find(
          (outcome) => outcome.id === outcomeSelect.value,
        );
        if (!selectedOutcome) return;
        const row: ExtractionRow = {
          id: `ext_${pid}_${Date.now()}_manual`,
          outcomeId: selectedOutcome.id,
          outcome: selectedOutcome.name,
          effectType: measureSelect.value,
          effectSize: inputs[0].value ? Number(inputs[0].value) : undefined,
          ciLow: inputs[1].value ? Number(inputs[1].value) : undefined,
          ciHigh: inputs[2].value ? Number(inputs[2].value) : undefined,
          n: inputs[3].value ? Number(inputs[3].value) : undefined,
          events: inputs[4].value ? Number(inputs[4].value) : undefined,
          timepoint: inputs[5].value.trim() || undefined,
          sourcePage: inputs[6].value.trim() || undefined,
          sourceQuote: quoteInput.value.trim() || undefined,
          verificationStatus: "proposed",
          templateRevisionId: active.revisionId,
          revision: 1,
          updatedAt: new Date().toISOString(),
        };
        const validation = validateExtractionRow(row, false);
        if (!validation.valid) {
          toast(doc, validation.errors.join("; "));
          return;
        }
        currentState.extractions[pid] ||= [];
        currentState.extractions[pid].push(row);
        await getSRService().save(currentState);
        render();
      });
      form.appendChild(save);
      Array.from(form.querySelectorAll("input,select,textarea,button")).forEach(
        (element) => {
          (element as HTMLElement).style.cssText +=
            "padding:5px;border:1px solid var(--border-primary);border-radius:4px;background:var(--background-primary);color:var(--text-primary);font:inherit;font-size:10px;";
        },
      );
      paperHeader.insertAdjacentElement("afterend", form);
    });
    paperHeader.appendChild(manual);
    const verifyAll = doc.createElement("button");
    verifyAll.textContent = "Verify Valid Proposals";
    verifyAll.style.cssText =
      "padding:5px 10px;border:1px solid #16a34a;border-radius:4px;background:transparent;color:#16a34a;cursor:pointer;";
    verifyAll.addEventListener("click", async () => {
      if (!currentState) return;
      const proposals = (currentState.extractions[pid] || []).filter(
        (row) =>
          row.verificationStatus === "proposed" &&
          !!row.sourceQuote?.trim() &&
          validateExtractionRow(row).valid,
      );
      if (!proposals.length) {
        toast(doc, "No grounded valid proposals are ready for verification");
        return;
      }
      if (
        !doc.defaultView?.confirm(
          `Verify ${proposals.length} grounded proposal(s) for this paper?`,
        )
      ) {
        return;
      }
      proposals.forEach((row) => {
        if (row.id) {
          getSRService().reviewExtraction(
            currentState!,
            pid,
            row.id,
            "verified",
          );
        }
      });
      await getSRService().save(currentState);
      render();
    });
    paperHeader.appendChild(verifyAll);
    body.appendChild(paperHeader);

    const rows = currentState.extractions[pid] || [];
    if (!rows.length) {
      const noRows = doc.createElement("div");
      noRows.textContent =
        "No proposals yet. Run AI extraction or enter results after the template is approved.";
      noRows.style.cssText =
        "padding:18px;text-align:center;border:1px dashed var(--border-primary);border-radius:6px;color:var(--text-secondary);";
      body.appendChild(noRows);
    }
    rows.forEach((row) => {
      const card = doc.createElement("div");
      card.style.cssText =
        "padding:9px;margin-bottom:7px;border:1px solid var(--border-secondary);border-radius:6px;";
      const cardHeader = doc.createElement("div");
      cardHeader.style.cssText =
        "display:flex;align-items:center;gap:6px;margin-bottom:6px;";
      const outcome = doc.createElement("strong");
      outcome.textContent = row.outcome;
      cardHeader.appendChild(outcome);
      const status = doc.createElement("span");
      status.textContent = row.verificationStatus || "proposed";
      status.style.cssText =
        "font-size:9px;padding:1px 5px;border-radius:7px;background:var(--background-secondary);";
      cardHeader.appendChild(status);
      if (row.confidence !== undefined) {
        const confidence = doc.createElement("span");
        confidence.textContent = `${Math.round(row.confidence * 100)}% confidence`;
        confidence.style.cssText = "font-size:9px;color:var(--text-tertiary);";
        cardHeader.appendChild(confidence);
      }
      card.appendChild(cardHeader);
      const values = doc.createElement("div");
      const valueText = (value: number | undefined): string =>
        value === undefined ? "missing" : String(value);
      values.textContent = `${row.effectType} ${valueText(row.effectSize)} (${valueText(row.ciLow)} to ${valueText(row.ciHigh)}), N=${valueText(row.n)}, events=${valueText(row.events)}${row.timepoint ? `, ${row.timepoint}` : ""}`;
      values.style.cssText = "font-size:10px;margin-bottom:5px;";
      card.appendChild(values);
      const quote = doc.createElement("div");
      quote.textContent = row.sourceQuote
        ? `"${row.sourceQuote}"${row.sourcePage ? `, page ${row.sourcePage}` : ""}`
        : "No source quote";
      quote.style.cssText =
        "font-size:9px;color:var(--text-secondary);line-height:1.4;margin-bottom:6px;";
      card.appendChild(quote);
      if (row.missingReason) {
        const missing = doc.createElement("div");
        missing.textContent = `Missing fields: ${row.missingReason}`;
        missing.style.cssText =
          "font-size:9px;color:#b45309;margin-bottom:6px;";
        card.appendChild(missing);
      }
      if (row.issues?.length) {
        const issueBox = doc.createElement("div");
        issueBox.textContent = row.issues
          .map((issue) => `${issue.severity}: ${issue.message}`)
          .join(" · ");
        issueBox.style.cssText =
          "font-size:9px;color:#b45309;background:#fef3c7;padding:5px;border-radius:4px;margin-bottom:6px;";
        card.appendChild(issueBox);
      }
      const actions = doc.createElement("div");
      actions.style.cssText = "display:flex;gap:5px;";
      (["verified", "rejected"] as const).forEach((nextStatus) => {
        const button = doc.createElement("button");
        button.textContent = nextStatus === "verified" ? "Verify" : "Reject";
        button.addEventListener("click", async () => {
          if (!currentState || !row.id) return;
          try {
            getSRService().reviewExtraction(
              currentState,
              pid,
              row.id,
              nextStatus,
            );
            await getSRService().save(currentState);
            render();
          } catch (error) {
            toast(doc, error instanceof Error ? error.message : String(error));
          }
        });
        button.style.cssText =
          "padding:2px 7px;border:1px solid " +
          (nextStatus === "verified" ? "#16a34a" : "#dc2626") +
          ";border-radius:4px;background:transparent;color:" +
          (nextStatus === "verified" ? "#16a34a" : "#dc2626") +
          ";cursor:pointer;";
        actions.appendChild(button);
      });
      const edit = doc.createElement("button");
      edit.textContent = "Edit";
      edit.style.cssText =
        "padding:2px 7px;border:1px solid var(--border-primary);border-radius:4px;background:transparent;color:var(--text-secondary);cursor:pointer;";
      edit.addEventListener("click", () => {
        const existing = card.querySelector(".sr-edit-extraction");
        if (existing) {
          existing.remove();
          return;
        }
        const editor = doc.createElement("div");
        editor.className = "sr-edit-extraction";
        editor.style.cssText =
          "display:grid;grid-template-columns:repeat(5,minmax(80px,1fr));gap:5px;margin-top:7px;";
        const measure = doc.createElement("select");
        ["OR", "RR", "HR", "MD", "SMD"].forEach((value) => {
          const option = doc.createElement("option");
          option.value = value;
          option.textContent = value;
          option.selected = row.effectType === value;
          measure.appendChild(option);
        });
        editor.appendChild(measure);
        const editInputs = [
          ["Estimate", row.effectSize ?? ""],
          ["CI low", row.ciLow ?? ""],
          ["CI high", row.ciHigh ?? ""],
          ["Sample N", row.n ?? ""],
          ["Events", row.events ?? ""],
          ["Timepoint", row.timepoint || ""],
          ["Page", row.sourcePage || ""],
        ].map(([placeholder, value], index) => {
          const input = doc.createElement("input");
          input.placeholder = String(placeholder);
          input.value = String(value);
          input.type = index < 5 ? "number" : "text";
          editor.appendChild(input);
          return input;
        });
        const editQuote = doc.createElement("textarea");
        editQuote.value = row.sourceQuote || "";
        editQuote.placeholder = "Exact source quote";
        editQuote.style.gridColumn = "span 4";
        editor.appendChild(editQuote);
        const saveEdit = doc.createElement("button");
        saveEdit.textContent = "Save Changes";
        saveEdit.addEventListener("click", async () => {
          if (!currentState) return;
          const edited: ExtractionRow = {
            ...row,
            effectType: measure.value,
            effectSize: editInputs[0].value
              ? Number(editInputs[0].value)
              : undefined,
            ciLow: editInputs[1].value
              ? Number(editInputs[1].value)
              : undefined,
            ciHigh: editInputs[2].value
              ? Number(editInputs[2].value)
              : undefined,
            n: editInputs[3].value ? Number(editInputs[3].value) : undefined,
            events: editInputs[4].value
              ? Number(editInputs[4].value)
              : undefined,
            timepoint: editInputs[5].value.trim() || undefined,
            sourcePage: editInputs[6].value.trim() || undefined,
            sourceQuote: editQuote.value.trim() || undefined,
            verificationStatus: "proposed",
            revision: (row.revision || 1) + 1,
            updatedAt: new Date().toISOString(),
            issues: [],
          };
          const validation = validateExtractionRow(edited, false);
          if (!validation.valid) {
            toast(doc, validation.errors.join("; "));
            return;
          }
          Object.assign(row, edited);
          await getSRService().save(currentState);
          render();
        });
        editor.appendChild(saveEdit);
        Array.from(
          editor.querySelectorAll("input,select,textarea,button"),
        ).forEach((element) => {
          (element as HTMLElement).style.cssText +=
            "padding:4px;border:1px solid var(--border-primary);border-radius:4px;background:var(--background-primary);color:var(--text-primary);font-size:9px;";
        });
        card.appendChild(editor);
      });
      actions.appendChild(edit);
      card.appendChild(actions);
      body.appendChild(card);
    });
  };

  render();
  mountReviewSheet(doc, overlay);
}

function openExtractionLogsModal(doc: Document, paperId?: number): void {
  if (!currentState) return;
  const included = getIncludedPapers(currentState);
  const targets = paperId
    ? currentState.papers.filter((paper) => paper.id === paperId)
    : included;
  if (!targets.length) {
    toast(
      doc,
      paperId
        ? `No paper found with ID ${paperId}`
        : "No included papers to display logs for",
    );
    return;
  }
  const wrapper = doc.createElement("div");
  wrapper.style.cssText =
    "position:fixed;inset:0;background:rgba(15,23,42,.55);z-index:1000;display:flex;align-items:center;justify-content:center;padding:16px;";
  const modal = doc.createElement("div");
  modal.style.cssText =
    "background:var(--background-primary);border:1px solid var(--border-primary);border-radius:12px;width:840px;max-width:96vw;max-height:94vh;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 20px 60px rgba(0,0,0,.3);font-size:13px;";
  wrapper.appendChild(modal);

  const header = doc.createElement("div");
  header.style.cssText =
    "display:flex;align-items:center;justify-content:space-between;padding:12px 16px;border-bottom:1px solid var(--border-primary);background:var(--background-secondary);";
  const title = doc.createElement("div");
  title.textContent = paperId
    ? `Extraction log · Paper ${paperId}`
    : "Extraction logs · included papers";
  title.style.cssText = "font-size:16px;font-weight:700;";
  header.appendChild(title);
  const close = doc.createElement("button");
  close.textContent = "Close";
  close.style.cssText =
    "padding:4px 10px;border:1px solid var(--border-primary);border-radius:5px;background:transparent;color:var(--text-secondary);cursor:pointer;";
  close.addEventListener("click", () => wrapper.remove());
  header.appendChild(close);
  modal.appendChild(header);

  const toolbar = doc.createElement("div");
  toolbar.style.cssText =
    "display:flex;align-items:center;gap:6px;padding:8px 14px;border-bottom:1px solid var(--border-secondary);background:var(--background-primary);flex-wrap:wrap;";
  const filterAll = doc.createElement("button");
  filterAll.textContent = "All";
  filterAll.style.cssText =
    "padding:2px 8px;font-size:10px;border:1px solid var(--border-primary);border-radius:10px;background:var(--highlight-primary);color:#fff;cursor:pointer;";
  const filterFailed = doc.createElement("button");
  filterFailed.textContent = "Failed only";
  filterFailed.style.cssText =
    "padding:2px 8px;font-size:10px;border:1px solid var(--border-primary);border-radius:10px;background:transparent;color:var(--text-secondary);cursor:pointer;";
  const filterClean = doc.createElement("button");
  filterClean.textContent = "Clean only";
  filterClean.style.cssText =
    "padding:2px 8px;font-size:10px;border:1px solid var(--border-primary);border-radius:10px;background:transparent;color:var(--text-secondary);cursor:pointer;";
  let mode: "all" | "failed" | "clean" = "all";
  const setMode = (next: "all" | "failed" | "clean"): void => {
    mode = next;
    const active = (button: HTMLElement): string =>
      "padding:2px 8px;font-size:10px;border:1px solid var(--border-primary);border-radius:10px;cursor:pointer;";
    filterAll.style.cssText =
      active(filterAll) +
      `background:${mode === "all" ? "var(--highlight-primary)" : "transparent"};color:${mode === "all" ? "#fff" : "var(--text-secondary)"};`;
    filterFailed.style.cssText =
      active(filterFailed) +
      `background:${mode === "failed" ? "var(--highlight-primary)" : "transparent"};color:${mode === "failed" ? "#fff" : "var(--text-secondary)"};`;
    filterClean.style.cssText =
      active(filterClean) +
      `background:${mode === "clean" ? "var(--highlight-primary)" : "transparent"};color:${mode === "clean" ? "#fff" : "var(--text-secondary)"};`;
    draw();
  };
  filterAll.addEventListener("click", () => setMode("all"));
  filterFailed.addEventListener("click", () => setMode("failed"));
  filterClean.addEventListener("click", () => setMode("clean"));
  toolbar.append(filterAll, filterFailed, filterClean);
  const spacer = doc.createElement("span");
  spacer.style.flex = "1";
  toolbar.appendChild(spacer);
  const retryAllBtn = doc.createElement("button");
  retryAllBtn.textContent = "Retry all failed";
  const failedIds = targets
    .filter((paper) => hasFailedExtractionMetrics(currentState!, paper.id))
    .map((paper) => paper.id);
  if (!failedIds.length) {
    retryAllBtn.disabled = true;
    retryAllBtn.style.cssText =
      "padding:4px 10px;font-size:10px;border:1px solid var(--border-primary);border-radius:4px;background:transparent;color:var(--text-secondary);cursor:not-allowed;opacity:0.5;";
  } else {
    retryAllBtn.style.cssText =
      "padding:4px 10px;font-size:10px;border:1px solid #b45309;border-radius:4px;background:transparent;color:#b45309;cursor:pointer;";
  }
  retryAllBtn.addEventListener("click", async () => {
    try {
      const job = await getSRService().startFailedExtractionRetry(
        currentState!,
      );
      if (!job) {
        toast(doc, "No failed extractions to retry");
        return;
      }
      await getSRService().save(currentState!);
      toast(doc, `Retry queued for ${job.paperIds.length} paper(s)`);
      reRenderPanel(doc, currentPanel);
      draw();
    } catch (error) {
      toast(doc, error instanceof Error ? error.message : String(error));
    }
  });
  toolbar.appendChild(retryAllBtn);
  modal.appendChild(toolbar);

  const body = doc.createElement("div");
  body.style.cssText = "flex:1;overflow:auto;padding:12px 16px;";
  modal.appendChild(body);

  const draw = (): void => {
    body.replaceChildren();
    if (!targets.length) {
      const empty = doc.createElement("div");
      empty.textContent = "No included papers to inspect.";
      empty.style.cssText =
        "padding:24px;text-align:center;color:var(--text-tertiary);";
      body.appendChild(empty);
      return;
    }
    const enriched = targets.map((paper) => ({
      paper,
      log: collectPaperExtractionLog(currentState!, paper.id),
    }));
    const filtered = enriched.filter(({ log }) => {
      if (mode === "all") return true;
      const hasIssue =
        !!log.jobError ||
        log.sourceWarnings.length > 0 ||
        log.rowIssues.some((issue) => issue.severity === "error") ||
        log.missingOutcomes.length > 0;
      return mode === "failed" ? hasIssue : !hasIssue;
    });
    if (!filtered.length) {
      const empty = doc.createElement("div");
      empty.textContent =
        mode === "failed"
          ? "No extraction failures detected for included papers."
          : "No clean extractions to show.";
      empty.style.cssText =
        "padding:24px;text-align:center;color:var(--text-tertiary);";
      body.appendChild(empty);
      return;
    }
    filtered.forEach(({ paper, log }) => {
      const card = doc.createElement("div");
      card.style.cssText =
        "margin-bottom:10px;border:1px solid var(--border-secondary);border-radius:8px;overflow:hidden;";
      const cardHeader = doc.createElement("div");
      cardHeader.style.cssText =
        "display:flex;align-items:center;gap:8px;padding:7px 10px;background:var(--background-secondary);font-size:11px;";
      const paperTitle = doc.createElement("strong");
      const item = Zotero.Items.get(paper.id);
      paperTitle.textContent = item
        ? (item.getField("title") as string) || `Item ${paper.id}`
        : `Item ${paper.id}`;
      paperTitle.style.flex = "1";
      cardHeader.appendChild(paperTitle);
      const counts: string[] = [];
      if (log.jobError) counts.push("job error");
      if (log.sourceWarnings.length)
        counts.push(`${log.sourceWarnings.length} source warning(s)`);
      const errorRows = log.rowIssues.filter(
        (issue) => issue.severity === "error",
      ).length;
      const warningRows = log.rowIssues.filter(
        (issue) => issue.severity === "warning",
      ).length;
      if (errorRows) counts.push(`${errorRows} row error(s)`);
      if (warningRows) counts.push(`${warningRows} row warning(s)`);
      if (log.missingOutcomes.length)
        counts.push(`${log.missingOutcomes.length} missing required`);
      const statusSpan = doc.createElement("span");
      statusSpan.textContent = counts.length ? counts.join(" · ") : "clean";
      statusSpan.style.cssText = `color:${counts.length ? "#b45309" : "#15803d"};font-weight:600;`;
      cardHeader.appendChild(statusSpan);
      card.appendChild(cardHeader);

      const detail = doc.createElement("div");
      detail.style.cssText = "padding:8px 10px;font-size:11px;line-height:1.5;";
      let hasAny = false;
      if (log.sourceKind) {
        const src = doc.createElement("div");
        src.textContent = `Source: ${log.sourceKind}`;
        src.style.color = "var(--text-tertiary)";
        detail.appendChild(src);
      }
      if (log.jobError) {
        const err = doc.createElement("div");
        err.textContent = `Job error: ${log.jobError}`;
        err.style.cssText =
          "color:#b91c1c;background:#fee2e2;padding:5px 7px;border-radius:4px;margin-top:4px;";
        detail.appendChild(err);
        hasAny = true;
      }
      if (log.sourceWarnings.length) {
        const src = doc.createElement("div");
        src.textContent = `Source warnings: ${log.sourceWarnings.join("; ")}`;
        src.style.cssText =
          "color:#b45309;background:#fef3c7;padding:5px 7px;border-radius:4px;margin-top:4px;";
        detail.appendChild(src);
        hasAny = true;
      }
      if (log.missingOutcomes.length) {
        const miss = doc.createElement("div");
        miss.textContent = `Missing required outcomes: ${log.missingOutcomes
          .map((entry) => entry.name)
          .join(", ")}`;
        miss.style.cssText =
          "color:#b45309;background:#fef3c7;padding:5px 7px;border-radius:4px;margin-top:4px;";
        detail.appendChild(miss);
        hasAny = true;
      }
      if (log.rowIssues.length) {
        const list = doc.createElement("div");
        list.style.cssText =
          "margin-top:6px;border:1px solid var(--border-secondary);border-radius:5px;padding:5px 7px;background:var(--background-primary);";
        const headingEl = doc.createElement("strong");
        headingEl.textContent = `Row issues (${log.rowIssues.length})`;
        headingEl.style.cssText = "font-size:10px;color:var(--text-tertiary);";
        list.appendChild(headingEl);
        const ul = doc.createElement("ul");
        ul.style.cssText =
          "margin:4px 0 0;padding-left:18px;max-height:160px;overflow:auto;";
        log.rowIssues.forEach((issue) => {
          const li = doc.createElement("li");
          li.textContent = `[${issue.severity}] ${issue.outcome || ""} ${issue.effectType || ""} ${issue.code}: ${issue.message}${issue.rawValue ? ` (raw: ${issue.rawValue})` : ""}`;
          li.style.cssText = `font-size:10px;color:${issue.severity === "error" ? "#b91c1c" : "#b45309"};margin-bottom:2px;`;
          ul.appendChild(li);
        });
        list.appendChild(ul);
        detail.appendChild(list);
        hasAny = true;
      }
      if (!hasAny) {
        const ok = doc.createElement("div");
        ok.textContent =
          "All extraction rows are clean. No validation issues detected.";
        ok.style.cssText = "color:#15803d;margin-top:4px;";
        detail.appendChild(ok);
      }
      const actions = doc.createElement("div");
      actions.style.cssText =
        "display:flex;gap:5px;margin-top:8px;justify-content:flex-end;";
      const openWs = doc.createElement("button");
      openWs.textContent = "Open workspace";
      openWs.style.cssText =
        "padding:3px 9px;font-size:10px;border:1px solid var(--border-primary);border-radius:4px;background:transparent;color:var(--text-secondary);cursor:pointer;";
      openWs.addEventListener("click", () => {
        wrapper.remove();
        openExtractionWorkspace(doc, paper.id);
      });
      actions.appendChild(openWs);
      if (hasAny) {
        const retryBtn = doc.createElement("button");
        retryBtn.textContent = "Retry this paper";
        retryBtn.style.cssText =
          "padding:3px 9px;font-size:10px;border:1px solid #b45309;border-radius:4px;background:transparent;color:#b45309;cursor:pointer;";
        retryBtn.addEventListener("click", async () => {
          try {
            const job = await getSRService().startReviewJob(
              currentState!,
              "extraction",
              [paper.id],
            );
            await getSRService().save(currentState!);
            toast(doc, `Retry queued for paper ${paper.id}`);
            reRenderPanel(doc, currentPanel);
            draw();
            void job;
          } catch (error) {
            toast(doc, error instanceof Error ? error.message : String(error));
          }
        });
        actions.appendChild(retryBtn);
      }
      detail.appendChild(actions);
      card.appendChild(detail);
      body.appendChild(card);
    });
  };
  draw();
  wrapper.addEventListener("click", (event) => {
    if (event.target === wrapper) wrapper.remove();
  });
  mountReviewSheet(doc, wrapper);
}

function openExtractionModal(_doc: Document, pid: number): void {
  const doc = _doc;
  if (!currentState) return;
  const state = currentState;
  openExtractionWorkspace(doc, pid);
  return;
  const paper = state.papers.find((p: SystematicReviewPaper) => p.id === pid);
  if (!paper) return;
  const zItem = Zotero.Items.get(pid);
  const title =
    (zItem ? (zItem.getField("title") as string) || "" : "") || "Item " + pid;
  const authors = zItem
    ? zItem
        .getCreators()
        .map((c: any) => c.lastName || c.name || "")
        .filter(Boolean)
        .join(", ")
    : "";
  const year = zItem ? (zItem.getField("year") as string) || "" : "";

  // Get existing extractions
  const ex = state.extractions[pid] || [];
  const outcomes = [
    "Primary Outcome",
    "Secondary Outcome",
    "Biomarker",
    "Adverse Event",
    "Other",
  ];

  // Build modal HTML using DOM
  const wrapper = doc.createElement("div");
  wrapper.setAttribute("data-modal", "extract");
  wrapper.style.cssText =
    "position:fixed;inset:0;background:rgba(0,0,0,0.45);z-index:1000;display:flex;align-items:center;justify-content:center;";
  wrapper.addEventListener("click", (e: Event) => {
    if (e.target === wrapper) {
      const p3 = wrapper.parentElement;
      if (p3) p3.removeChild(wrapper);
    }
  });

  const modal = doc.createElement("div");
  modal.style.cssText =
    "background:var(--background-primary);border:1px solid var(--border-primary);border-radius:12px;width:680px;max-width:95vw;max-height:90vh;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 12px 48px rgba(0,0,0,0.25);";
  wrapper.appendChild(modal);

  const mhdr = doc.createElement("div");
  mhdr.style.cssText =
    "display:flex;align-items:center;justify-content:space-between;padding:12px 16px;border-bottom:1px solid var(--border-primary);background:var(--background-secondary);flex-shrink:0;";
  const mtitle = doc.createElement("div");
  mtitle.textContent = "Data Extraction";
  mtitle.style.cssText =
    "font-size:15px;font-weight:700;color:var(--text-primary);";
  mhdr.appendChild(mtitle);
  const closeBtn = doc.createElement("button");
  closeBtn.textContent = "\u00d7";
  closeBtn.style.cssText =
    "width:28px;height:28px;border:none;background:transparent;color:var(--text-secondary);cursor:pointer;font-size:18px;border-radius:4px;display:flex;align-items:center;justify-content:center;";
  closeBtn.addEventListener("click", () => {
    const p2 = wrapper.parentElement;
    if (p2) p2.removeChild(wrapper);
  });
  mhdr.appendChild(closeBtn);
  modal.appendChild(mhdr);

  const mbody = doc.createElement("div");
  mbody.style.cssText = "flex:1;overflow-y:auto;padding:12px 16px;";

  // Study header
  const studyHdr = doc.createElement("div");
  studyHdr.textContent =
    authors + " (" + year + ") - " + title.substring(0, 60);
  studyHdr.style.cssText =
    "font-size:11px;font-weight:600;color:var(--text-primary);margin-bottom:12px;";
  mbody.appendChild(studyHdr);

  // RoB 2 assessment
  const robDiv = doc.createElement("div");
  robDiv.style.cssText = "margin-bottom:12px;";
  const robLbl = doc.createElement("div");
  robLbl.textContent = "Cochrane RoB 2";
  robLbl.style.cssText =
    "font-size:10px;font-weight:600;color:var(--text-secondary);margin-bottom:4px;";
  robDiv.appendChild(robLbl);
  const rob = state.robData[pid] || {
    randomization: "not_assessed",
    deviations: "not_assessed",
    missing: "not_assessed",
    measurement: "not_assessed",
    selective: "not_assessed",
  };
  const domains = [
    { k: "randomization", n: "Randomization process" },
    { k: "deviations", n: "Deviations from intended interventions" },
    { k: "missing", n: "Missing outcome data" },
    { k: "measurement", n: "Measurement of the outcome" },
    { k: "selective", n: "Selection of the reported result" },
  ];
  domains.forEach((dk: { k: string; n: string }) => {
    const drow = doc.createElement("div");
    drow.style.cssText =
      "display:flex;align-items:center;gap:4px;margin:2px 0;font-size:10px;";
    const dot2 = doc.createElement("span");
    const v = rob[dk.k as keyof typeof rob] || "not_assessed";
    dot2.style.cssText =
      "width:8px;height:8px;border-radius:50%;flex-shrink:0;background:" +
      (v === "not_assessed"
        ? "var(--text-tertiary)"
        : v === "low"
          ? "#16a34a"
          : v === "some"
            ? "#d97706"
            : "#dc2626") +
      ";";
    drow.appendChild(dot2);
    const dlabel = doc.createElement("span");
    dlabel.textContent = dk.n;
    dlabel.style.cssText = "flex:1;color:var(--text-secondary);font-size:9px;";
    drow.appendChild(dlabel);
    const dsel = doc.createElement("select") as HTMLSelectElement;
    dsel.style.cssText =
      "font-size:9px;padding:1px 3px;border:1px solid var(--border-primary);border-radius:3px;font-family:inherit;";
    ["not_assessed", "low", "some", "high"].forEach((opt: string) => {
      const o = doc.createElement("option");
      o.value = opt;
      o.textContent =
        opt === "not_assessed"
          ? "Not assessed"
          : opt === "low"
            ? "Low"
            : opt === "some"
              ? "Some concerns"
              : "High";
      if (v === opt) o.selected = true;
      dsel.appendChild(o);
    });
    dsel.addEventListener("change", () => {
      if (!currentState) return;
      if (!currentState.robData[pid]) currentState.robData[pid] = { ...rob };
      (currentState.robData[pid] as any)[dk.k] = dsel.value;
      currentState.robData[pid].instrument =
        currentState.robData[pid].instrument || "rob2";
      currentState.robData[pid].verificationStatus = "verified";
      currentState.robData[pid].updatedAt = new Date().toISOString();
      saveSRState();
    });
    drow.appendChild(dsel);
    robDiv.appendChild(drow);
  });
  mbody.appendChild(robDiv);

  // Extraction table
  const tbl = doc.createElement("table");
  tbl.style.cssText =
    "width:100%;border-collapse:collapse;font-size:10px;margin-bottom:8px;";
  const thead = doc.createElement("thead");
  const thr = doc.createElement("tr");
  [
    "Outcome",
    "Effect Type",
    "Effect Size",
    "CI Low",
    "CI High",
    "N",
    "Events",
    "Page",
    "Source Quote",
    "",
  ].forEach((h: string) => {
    const th = doc.createElement("th");
    th.textContent = h;
    th.style.cssText =
      "padding:4px;text-align:left;font-weight:600;color:var(--text-secondary);border-bottom:1px solid var(--border-primary);font-size:9px;";
    thr.appendChild(th);
  });
  thead.appendChild(thr);
  tbl.appendChild(thead);
  const tbody2 = doc.createElement("tbody");

  const idSuffixes = [
    "Out",
    "Type",
    "ES",
    "Lo",
    "Hi",
    "N",
    "Ev",
    "Page",
    "Quote",
  ];
  outcomes.forEach((o: string, i: number) => {
    const row2 = ex.find((r: ExtractionRow) => r.outcome === o) || {};
    const tr2 = doc.createElement("tr");
    [
      { v: o, w: "" },
      {
        v: (row2 as any).effectType || "OR",
        w: "80px",
        type: "select",
        opts: ["OR", "RR", "MD", "SMD", "HR"],
      },
      { v: (row2 as any).effectSize || "", w: "70px", type: "num" },
      { v: (row2 as any).ciLow || "", w: "60px", type: "num" },
      { v: (row2 as any).ciHigh || "", w: "60px", type: "num" },
      { v: (row2 as any).n || "", w: "60px", type: "num" },
      { v: (row2 as any).events || "", w: "60px", type: "num" },
      { v: (row2 as any).sourcePage || "", w: "55px" },
      { v: (row2 as any).sourceQuote || "", w: "140px" },
    ].forEach((c: any, colIdx: number) => {
      const td = doc.createElement("td");
      td.style.cssText = "padding:2px;";
      if (c.type === "select") {
        const sel = doc.createElement("select") as HTMLSelectElement;
        sel.style.cssText =
          "width:100%;font-size:9px;padding:1px;font-family:inherit;border:1px solid var(--border-primary);border-radius:3px;";
        sel.id = "exType" + i;
        c.opts.forEach((ov: string) => {
          const o2 = doc.createElement("option");
          o2.value = ov;
          o2.textContent = ov;
          if (c.v === ov) o2.selected = true;
          sel.appendChild(o2);
        });
        td.appendChild(sel);
      } else {
        const inp = doc.createElement("input") as HTMLInputElement;
        inp.style.cssText =
          "width:100%;font-size:9px;padding:1px 3px;border:1px solid var(--border-primary);border-radius:3px;font-family:inherit;background:var(--background-primary);color:var(--text-primary);";
        inp.value = String(c.v);
        inp.id = "ex" + idSuffixes[colIdx] + i;
        td.appendChild(inp);
      }
      tr2.appendChild(td);
    });
    const tdClr = doc.createElement("td");
    const clrBtn2 = doc.createElement("button");
    clrBtn2.textContent = "\u00d7";
    clrBtn2.style.cssText =
      "border:none;background:transparent;color:var(--text-tertiary);cursor:pointer;font-size:12px;";
    clrBtn2.addEventListener("click", () => {
      [
        "exType",
        "exES",
        "exLo",
        "exHi",
        "exN",
        "exEv",
        "exPage",
        "exQuote",
      ].forEach((id2: string) => {
        const el2 = doc.getElementById(id2 + i) as
          | HTMLInputElement
          | HTMLSelectElement;
        if (el2) el2.value = "";
      });
    });
    tdClr.appendChild(clrBtn2);
    tr2.appendChild(tdClr);
    tbody2.appendChild(tr2);
  });
  tbl.appendChild(tbody2);
  mbody.appendChild(tbl);

  const exCount = (state.extractions[pid] || []).length;
  if (exCount === 0) {
    const hint = doc.createElement("div");
    hint.style.cssText =
      "font-size:9px;color:var(--text-tertiary);margin-top:8px;line-height:1.5;";
    hint.textContent =
      "No extraction data recorded. Enter only values verified against the source paper; unknown values must remain blank.";
    mbody.appendChild(hint);
  }

  // Footer
  const mfoot = doc.createElement("div");
  mfoot.style.cssText =
    "padding:10px 16px;border-top:1px solid var(--border-primary);display:flex;gap:8px;justify-content:flex-end;flex-shrink:0;";
  const saveXBtn = doc.createElement("button");
  saveXBtn.textContent = "Save Extractions";
  saveXBtn.style.cssText =
    "padding:3px 12px;font-size:11px;border:1px solid #7c3aed;border-radius:4px;background:#7c3aed;color:#fff;cursor:pointer;font-family:inherit;font-weight:600;";
  saveXBtn.addEventListener("click", () => {
    if (!currentState) return;
    const newEx: ExtractionRow[] = [];
    const errors: string[] = [];
    const readNumber = (id: string): number => {
      const value = (doc.getElementById(id) as HTMLInputElement)?.value.trim();
      return value ? Number(value) : Number.NaN;
    };
    outcomes.forEach((_o2: string, i2: number) => {
      const effectValue =
        (doc.getElementById("exES" + i2) as HTMLInputElement)?.value.trim() ||
        "";
      if (effectValue) {
        const sourcePage =
          (
            doc.getElementById("exPage" + i2) as HTMLInputElement
          )?.value.trim() || undefined;
        const sourceQuote =
          (
            doc.getElementById("exQuote" + i2) as HTMLInputElement
          )?.value.trim() || undefined;
        const row = {
          id: `ext_${pid}_${Date.now()}_${i2}`,
          outcome: _o2,
          effectType:
            (doc.getElementById("exType" + i2) as HTMLSelectElement)?.value ||
            "OR",
          effectSize: Number(effectValue),
          ciLow: readNumber("exLo" + i2),
          ciHigh: readNumber("exHi" + i2),
          n: readNumber("exN" + i2),
          events: readNumber("exEv" + i2),
          sourcePage,
          sourceQuote,
          verificationStatus: sourceQuote
            ? ("verified" as const)
            : ("proposed" as const),
          revision: 1,
          updatedAt: new Date().toISOString(),
        };
        const validation = validateExtractionRow(row);
        if (validation.valid) newEx.push(row);
        else {
          errors.push(`${_o2}: ${validation.errors.join(", ")}`);
        }
      }
    });
    if (errors.length > 0) {
      toast(doc, errors.join(" | "));
      return;
    }
    currentState.extractions[pid] = newEx;
    saveSRState();
    const verified = newEx.filter(
      (row) => row.verificationStatus === "verified",
    ).length;
    toast(
      doc,
      `Extractions saved: ${verified} verified, ${newEx.length - verified} proposed`,
    );
    reRenderPanel(doc, "screening");
    const p1 = wrapper.parentElement;
    if (p1) p1.removeChild(wrapper);
  });
  mfoot.appendChild(saveXBtn);
  const cancelXBtn = doc.createElement("button");
  cancelXBtn.textContent = "Cancel";
  cancelXBtn.style.cssText =
    "padding:3px 12px;font-size:11px;border:1px solid var(--border-primary);border-radius:4px;background:transparent;color:var(--text-secondary);cursor:pointer;font-family:inherit;";
  cancelXBtn.addEventListener("click", () => {
    const p0 = wrapper.parentElement;
    if (p0) p0.removeChild(wrapper);
  });
  mfoot.appendChild(cancelXBtn);
  modal.appendChild(mbody);
  modal.appendChild(mfoot);
  mountReviewSheet(doc, wrapper);
}

// ============================================================
// CRITERIA / KEYWORDS MODAL
// ============================================================

function buildProtocolTemplateTab(
  doc: Document,
  container: HTMLElement,
  draft: ProtocolRevision,
  rerender: () => void,
): void {
  if (!currentState) return;
  const section = doc.createElement("section");
  section.style.cssText =
    "border:1px solid var(--border-secondary);border-radius:8px;padding:12px;background:var(--background-primary);";
  const heading = doc.createElement("div");
  heading.textContent = "Extraction template";
  heading.style.cssText = "font-size:15px;font-weight:700;margin-bottom:4px;";
  section.appendChild(heading);
  const subtext = doc.createElement("div");
  subtext.textContent =
    "Define the outcomes, measures, and timepoints the LLM should extract from each included paper. Generate a draft from this protocol, then edit and approve.";
  subtext.style.cssText =
    "font-size:11px;color:var(--text-tertiary);margin-bottom:10px;line-height:1.5;";
  section.appendChild(subtext);

  const active = getSRService().getExtractionTemplate(currentState);
  const inProgressDraft = [...currentState.extractionTemplates]
    .reverse()
    .find((template) => template.status === "draft");
  const template = inProgressDraft || active;

  const statusBar = doc.createElement("div");
  statusBar.style.cssText =
    "display:flex;gap:8px;align-items:center;margin-bottom:10px;font-size:11px;flex-wrap:wrap;";
  const statusBadge = doc.createElement("span");
  statusBadge.textContent = template
    ? `Status: ${template.status}`
    : "Status: no template";
  statusBadge.style.cssText =
    "padding:2px 8px;border-radius:8px;background:var(--background-secondary);color:var(--text-secondary);font-weight:700;";
  statusBar.appendChild(statusBadge);
  if (template) {
    const link = doc.createElement("span");
    link.textContent = `${template.outcomes.length} outcome(s) · ${template.revisionId}`;
    link.style.color = "var(--text-tertiary)";
    statusBar.appendChild(link);
  }
  section.appendChild(statusBar);

  if (!template) {
    const empty = doc.createElement("div");
    empty.style.cssText =
      "padding:16px;border:1px dashed var(--border-primary);border-radius:8px;text-align:center;color:var(--text-secondary);margin-bottom:10px;";
    empty.textContent =
      "No extraction template is defined yet. Generate one from this protocol's criteria to begin.";
    section.appendChild(empty);
    const generate = doc.createElement("button");
    generate.textContent = "Generate from criteria";
    generate.style.cssText =
      "padding:6px 12px;border:none;border-radius:6px;background:#7c3aed;color:#fff;font-weight:600;cursor:pointer;";
    generate.addEventListener("click", async () => {
      generate.disabled = true;
      generate.textContent = "Generating...";
      try {
        await getSRService().proposeTemplate(currentState!);
        await getSRService().save(currentState!);
        toast(doc, "Template draft generated from criteria");
        rerender();
        reRenderPanel(doc, currentPanel);
      } catch (error) {
        generate.disabled = false;
        generate.textContent = "Generate from criteria";
        toast(doc, error instanceof Error ? error.message : String(error));
      }
    });
    section.appendChild(generate);
    container.appendChild(section);
    return;
  }

  const nameInput = doc.createElement("input");
  nameInput.value = template.name;
  nameInput.placeholder = "Template name";
  nameInput.style.cssText =
    "width:100%;padding:6px 8px;margin-bottom:6px;border:1px solid var(--border-primary);border-radius:6px;background:var(--background-primary);color:var(--text-primary);font:inherit;font-size:12px;";
  section.appendChild(nameInput);

  const instructionsInput = doc.createElement("textarea");
  instructionsInput.value = template.instructions;
  instructionsInput.placeholder =
    "Instructions for AI extraction and reviewer conventions";
  instructionsInput.style.cssText =
    "width:100%;min-height:52px;padding:6px 8px;margin-bottom:10px;border:1px solid var(--border-primary);border-radius:6px;background:var(--background-primary);color:var(--text-primary);font:inherit;font-size:12px;resize:vertical;";
  section.appendChild(instructionsInput);

  const outcomesHeading = doc.createElement("div");
  outcomesHeading.textContent = "Outcomes";
  outcomesHeading.style.cssText =
    "font-size:12px;font-weight:700;margin-bottom:5px;";
  section.appendChild(outcomesHeading);

  const outcomesContainer = doc.createElement("div");
  const editableOutcomes = template.outcomes.map((outcome) => ({
    ...outcome,
    aliases: [...outcome.aliases],
    measures: [...outcome.measures],
    timepoints: [...outcome.timepoints],
  }));
  const drawOutcomes = (): void => {
    outcomesContainer.replaceChildren();
    editableOutcomes.forEach((outcome, index) => {
      const card = doc.createElement("div");
      card.style.cssText =
        "padding:8px 10px;margin-bottom:6px;border:1px solid var(--border-secondary);border-radius:6px;background:var(--background-secondary);";
      const grid = doc.createElement("div");
      grid.style.cssText =
        "display:grid;grid-template-columns:minmax(160px,1.4fr) minmax(110px,.8fr) minmax(120px,1fr) auto auto;gap:5px;align-items:center;";
      const nameField = doc.createElement("input");
      nameField.value = outcome.name;
      nameField.placeholder = "Outcome name";
      nameField.style.cssText =
        "padding:4px;border:1px solid var(--border-primary);border-radius:4px;background:var(--background-primary);color:var(--text-primary);font-size:11px;";
      nameField.addEventListener("input", () => {
        outcome.name = nameField.value;
      });
      const measuresField = doc.createElement("input");
      measuresField.value = outcome.measures.join(", ");
      measuresField.placeholder = "OR, RR, MD";
      measuresField.title = "Allowed measures (OR, RR, HR, MD, SMD)";
      measuresField.style.cssText =
        "padding:4px;border:1px solid var(--border-primary);border-radius:4px;background:var(--background-primary);color:var(--text-primary);font-size:11px;";
      measuresField.addEventListener("input", () => {
        outcome.measures = measuresField.value
          .split(",")
          .map((value) => value.trim().toUpperCase())
          .filter((value) =>
            ["OR", "RR", "HR", "MD", "SMD"].includes(value),
          ) as typeof outcome.measures;
      });
      const timepointsField = doc.createElement("input");
      timepointsField.value = outcome.timepoints.join(", ");
      timepointsField.placeholder = "Timepoints";
      timepointsField.style.cssText =
        "padding:4px;border:1px solid var(--border-primary);border-radius:4px;background:var(--background-primary);color:var(--text-primary);font-size:11px;";
      timepointsField.addEventListener("input", () => {
        outcome.timepoints = timepointsField.value
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean);
      });
      const requiredLabel = doc.createElement("label");
      requiredLabel.style.cssText =
        "display:flex;align-items:center;gap:3px;font-size:10px;white-space:nowrap;";
      const requiredInput = doc.createElement("input");
      requiredInput.type = "checkbox";
      requiredInput.checked = outcome.required;
      requiredInput.addEventListener("change", () => {
        outcome.required = requiredInput.checked;
      });
      requiredLabel.append(requiredInput, doc.createTextNode("Required"));
      const removeBtn = doc.createElement("button");
      removeBtn.textContent = "Remove";
      removeBtn.style.cssText =
        "padding:3px 8px;border:1px solid #dc2626;border-radius:4px;background:transparent;color:#dc2626;cursor:pointer;font-size:10px;";
      removeBtn.addEventListener("click", () => {
        editableOutcomes.splice(index, 1);
        drawOutcomes();
      });
      grid.append(
        nameField,
        measuresField,
        timepointsField,
        requiredLabel,
        removeBtn,
      );
      card.appendChild(grid);
      const aliasesField = doc.createElement("input");
      aliasesField.value = outcome.aliases.join(", ");
      aliasesField.placeholder = "Aliases (comma-separated)";
      aliasesField.style.cssText =
        "width:100%;padding:4px 6px;margin-top:5px;border:1px solid var(--border-primary);border-radius:4px;background:var(--background-primary);color:var(--text-primary);font-size:10px;";
      aliasesField.addEventListener("input", () => {
        outcome.aliases = aliasesField.value
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean);
      });
      card.appendChild(aliasesField);
      const descField = doc.createElement("textarea");
      descField.value = outcome.description;
      descField.placeholder = "Description (optional)";
      descField.style.cssText =
        "width:100%;min-height:32px;padding:4px 6px;margin-top:4px;border:1px solid var(--border-primary);border-radius:4px;background:var(--background-primary);color:var(--text-primary);font-size:10px;resize:vertical;";
      descField.addEventListener("input", () => {
        outcome.description = descField.value;
      });
      card.appendChild(descField);
      outcomesContainer.appendChild(card);
    });
  };
  drawOutcomes();
  section.appendChild(outcomesContainer);

  const addOutcome = doc.createElement("button");
  addOutcome.textContent = "Add outcome";
  addOutcome.style.cssText =
    "padding:4px 10px;margin-top:4px;border:1px solid var(--border-primary);border-radius:5px;background:transparent;color:var(--text-secondary);cursor:pointer;font-size:11px;";
  addOutcome.addEventListener("click", () => {
    editableOutcomes.push({
      id: `outcome_custom_${Date.now()}_${editableOutcomes.length}`,
      name: "",
      aliases: [],
      description: "",
      measures: ["OR"],
      timepoints: [],
      required: true,
    });
    drawOutcomes();
  });
  section.appendChild(addOutcome);

  const actionsRow = doc.createElement("div");
  actionsRow.style.cssText =
    "display:flex;gap:6px;justify-content:flex-end;margin-top:14px;flex-wrap:wrap;";
  const regenerate = doc.createElement("button");
  regenerate.textContent = "Regenerate draft";
  regenerate.style.cssText =
    "padding:5px 10px;border:1px solid var(--border-primary);border-radius:5px;background:transparent;color:var(--text-secondary);cursor:pointer;font-size:11px;";
  regenerate.addEventListener("click", async () => {
    regenerate.disabled = true;
    regenerate.textContent = "Regenerating...";
    try {
      await getSRService().proposeTemplate(
        currentState!,
        instructionsInput.value,
      );
      await getSRService().save(currentState!);
      toast(doc, "Template draft regenerated");
      rerender();
      reRenderPanel(doc, currentPanel);
    } catch (error) {
      regenerate.disabled = false;
      regenerate.textContent = "Regenerate draft";
      toast(doc, error instanceof Error ? error.message : String(error));
    }
  });
  actionsRow.appendChild(regenerate);

  const openWorkspace = doc.createElement("button");
  openWorkspace.textContent = "Open full workspace";
  openWorkspace.style.cssText =
    "padding:5px 10px;border:1px solid var(--border-primary);border-radius:5px;background:transparent;color:var(--text-secondary);cursor:pointer;font-size:11px;";
  openWorkspace.addEventListener("click", () => {
    openExtractionWorkspace(doc);
  });
  actionsRow.appendChild(openWorkspace);

  const saveDraft = doc.createElement("button");
  saveDraft.textContent =
    template.status === "active" ? "Save new revision" : "Save & approve";
  saveDraft.style.cssText =
    "padding:5px 12px;border:none;border-radius:5px;background:#7c3aed;color:#fff;font-weight:700;cursor:pointer;font-size:11px;";
  saveDraft.addEventListener("click", async () => {
    const validOutcomes = editableOutcomes.filter(
      (outcome) => outcome.name.trim() && outcome.measures.length,
    );
    if (!validOutcomes.length) {
      toast(doc, "Add at least one named outcome with a measure");
      return;
    }
    const edited: ExtractionTemplate = {
      ...template,
      name: nameInput.value.trim() || "Extraction Template",
      instructions: instructionsInput.value.trim(),
      outcomes: validOutcomes,
    };
    const updated = getSRService().updateTemplate(currentState!, edited);
    getSRService().activateTemplate(currentState!, updated.id);
    await getSRService().save(currentState!);
    toast(doc, "Extraction template approved");
    rerender();
    reRenderPanel(doc, currentPanel);
  });
  actionsRow.appendChild(saveDraft);
  section.appendChild(actionsRow);

  container.appendChild(section);
}

function openCriteriaModal(doc: Document): void {
  if (!currentState) return;
  const service = getSRService();
  const active = getActiveProtocolRevision(currentState.protocol);
  let draft: ProtocolRevision = JSON.parse(JSON.stringify(active));
  const uploadedDocs: ExtractedDocument[] = [];
  let activeProtocolTab: "scope" | "eligibility" | "mapping" | "template" =
    "scope";
  let protocolPresets: ProtocolPreset[] = [];
  let selectedPresetId = "";
  type GenerationStatus = "idle" | "running" | "complete" | "error";
  let generationStatus: Record<
    "scope" | "eligibility" | "mapping" | "template",
    GenerationStatus
  > = {
    scope: "idle",
    eligibility: "idle",
    mapping: "idle",
    template: "idle",
  };
  let generationResult: ProtocolGenerationResult | null = null;
  const prefillSteps: Record<
    "scope" | "eligibility" | "mapping" | "template",
    boolean
  > = {
    scope: true,
    eligibility: true,
    mapping: true,
    template: true,
  };

  const wrapper = doc.createElement("div");
  wrapper.style.cssText =
    "position:fixed;inset:0;background:rgba(15,23,42,.55);z-index:1000;display:flex;align-items:center;justify-content:center;padding:16px;";
  const modal = doc.createElement("div");
  modal.style.cssText =
    "background:var(--background-primary);border:1px solid var(--border-primary);border-radius:14px;width:960px;max-width:96vw;max-height:94vh;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 20px 60px rgba(0,0,0,.3);font-size:13px;";
  wrapper.appendChild(modal);

  const header = doc.createElement("div");
  header.style.cssText =
    "display:flex;align-items:center;justify-content:space-between;padding:14px 18px;border-bottom:1px solid var(--border-primary);background:var(--background-secondary);";
  const heading = doc.createElement("div");
  const title = doc.createElement("div");
  title.textContent = "Review Protocol";
  title.style.cssText = "font-size:20px;font-weight:700;";
  heading.appendChild(title);
  const subtitle = doc.createElement("div");
  subtitle.textContent =
    "One authoritative scope for search assistance, screening, synthesis, and gap analysis";
  subtitle.style.cssText =
    "font-size:12px;color:var(--text-tertiary);margin-top:3px;";
  heading.appendChild(subtitle);
  header.appendChild(heading);
  const close = doc.createElement("button");
  close.textContent = "\u00d7";
  close.style.cssText =
    "border:none;background:transparent;font-size:20px;color:var(--text-secondary);cursor:pointer;";
  close.addEventListener("click", () => wrapper.remove());
  header.appendChild(close);
  modal.appendChild(header);

  const body = doc.createElement("div");
  body.style.cssText =
    "flex:1;overflow:auto;padding:20px 22px;display:flex;flex-direction:column;gap:18px;";
  modal.appendChild(body);

  const footer = doc.createElement("div");
  footer.style.cssText =
    "padding:10px 18px;border-top:1px solid var(--border-primary);display:flex;align-items:center;justify-content:space-between;background:var(--background-secondary);";
  modal.appendChild(footer);

  const section = (label: string, description: string): HTMLElement => {
    const box = doc.createElement("section");
    box.style.cssText =
      "border:1px solid var(--border-secondary);border-radius:8px;padding:12px;background:var(--background-primary);";
    const h = doc.createElement("div");
    h.textContent = label;
    h.style.cssText = "font-size:16px;font-weight:700;margin-bottom:4px;";
    box.appendChild(h);
    const p = doc.createElement("div");
    p.textContent = description;
    p.style.cssText =
      "font-size:12px;color:var(--text-tertiary);margin-bottom:14px;line-height:1.5;";
    box.appendChild(p);
    return box;
  };

  const inputStyle =
    "width:100%;box-sizing:border-box;min-height:38px;border:1px solid var(--border-primary);border-radius:7px;background:var(--background-primary);color:var(--text-primary);font:inherit;font-size:13px;padding:8px 10px;";
  const buttonStyle =
    "min-height:36px;padding:7px 12px;border:1px solid var(--border-primary);border-radius:7px;background:var(--background-primary);color:var(--text-secondary);font:inherit;font-size:12px;cursor:pointer;";

  const buildProtocolGeneration = (): HTMLElement => {
    const generation = section(
      "Protocol generation",
      "Generate the question, framework, criteria, eligibility rules, keyword aids, evidence mappings, and an extraction template from the current draft and optional source documents. Reassess re-runs all four steps using the whole current protocol and active template as context.",
    );
    const sourceRow = doc.createElement("div");
    sourceRow.style.cssText =
      "display:flex;align-items:center;gap:8px;flex-wrap:wrap;";
    const upload = doc.createElement("button");
    upload.textContent = "Add source document";
    upload.style.cssText = buttonStyle;
    upload.addEventListener("click", async () => {
      try {
        const win = Zotero.getMainWindow() as any;
        const picker = new win.FilePicker();
        picker.init(win, "Add Protocol Source", picker.modeOpen);
        picker.appendFilter("Documents", "*.pdf;*.docx;*.md;*.markdown;*.txt");
        const result = await picker.show();
        if (result !== picker.returnOK || !picker.file) return;
        uploadedDocs.push(await extractDocumentContent(picker.file));
        render();
      } catch (error) {
        Zotero.debug(`[seerai] Protocol source picker failed: ${error}`);
        toast(doc, "Could not read protocol source");
      }
    });
    sourceRow.appendChild(upload);
    const sourceCount = doc.createElement("span");
    sourceCount.textContent =
      uploadedDocs.length === 0
        ? "No uploaded sources; the current draft and active template will be used as context"
        : uploadedDocs
            .map((item) =>
              item.error ? `${item.fileName} (error)` : item.fileName,
            )
            .join(", ");
    sourceCount.style.cssText =
      "font-size:12px;color:var(--text-tertiary);flex:1;";
    sourceRow.appendChild(sourceCount);
    generation.appendChild(sourceRow);

    const buttonRow = doc.createElement("div");
    buttonRow.style.cssText =
      "display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:8px;";
    const generate = doc.createElement("button");
    generate.textContent = "Generate protocol";
    generate.style.cssText = `${buttonStyle}background:#0f766e;border-color:#0f766e;color:white;font-weight:700;`;
    const reassess = doc.createElement("button");
    reassess.textContent = "Reassess protocol";
    reassess.style.cssText = `${buttonStyle}background:#7c3aed;border-color:#7c3aed;color:white;font-weight:700;`;
    buttonRow.appendChild(generate);
    buttonRow.appendChild(reassess);
    generation.appendChild(buttonRow);

    const progressContainer = doc.createElement("div");
    progressContainer.style.cssText =
      "margin-top:10px;display:flex;flex-direction:column;gap:6px;";
    generation.appendChild(progressContainer);

    const resultBanner = doc.createElement("div");
    resultBanner.style.cssText =
      "margin-top:8px;display:none;flex-direction:column;gap:6px;padding:8px 10px;border:1px solid var(--border-secondary);border-radius:6px;background:var(--background-secondary);font-size:11px;";
    generation.appendChild(resultBanner);

    const stepMeta: Array<{
      key: ProtocolGenerationStep;
      label: string;
      summary: string;
    }> = [
      { key: "scope", label: "1. Scope", summary: "" },
      { key: "eligibility", label: "2. Eligibility", summary: "" },
      { key: "mapping", label: "3. Evidence mapping", summary: "" },
      {
        key: "template",
        label: "4. Extraction template",
        summary: "",
      },
    ];

    const stepRows = new Map<ProtocolGenerationStep, HTMLElement>();
    const stepCheckboxes = new Map<ProtocolGenerationStep, HTMLInputElement>();
    const stepSummaries = new Map<ProtocolGenerationStep, HTMLElement>();
    stepMeta.forEach((meta) => {
      const row = doc.createElement("div");
      row.style.cssText =
        "display:flex;align-items:center;gap:8px;padding:6px 8px;border:1px solid var(--border-secondary);border-radius:6px;background:var(--background-secondary);";
      const status = doc.createElement("span");
      status.textContent = "○";
      status.style.cssText = "font-size:14px;width:18px;text-align:center;";
      const label = doc.createElement("strong");
      label.textContent = meta.label;
      label.style.cssText = "min-width:140px;";
      const summary = doc.createElement("span");
      summary.style.cssText =
        "flex:1;font-size:11px;color:var(--text-tertiary);";
      summary.textContent = "idle";
      const checkbox = doc.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = prefillSteps[meta.key];
      checkbox.title = "Uncheck to skip prefilling this step into the draft";
      checkbox.addEventListener("change", () => {
        prefillSteps[meta.key] = checkbox.checked;
      });
      row.append(status, label, summary, checkbox);
      progressContainer.appendChild(row);
      stepRows.set(meta.key, status);
      stepSummaries.set(meta.key, summary);
      stepCheckboxes.set(meta.key, checkbox);
    });

    const applyProposalsToDraft = async (
      result: ProtocolGenerationResult,
    ): Promise<{
      applied: number;
      templateDrafted: boolean;
      failed: ProtocolGenerationStep[];
    }> => {
      let applied = 0;
      let templateDrafted = false;
      const failed: ProtocolGenerationStep[] = [];
      if (prefillSteps.scope && !result.errors.scope) {
        draft.researchQuestion = result.scope.researchQuestion;
        draft.framework = result.scope.framework;
        draft.frameworkReason = result.scope.frameworkReason;
        draft.dimensions = JSON.parse(
          JSON.stringify(result.scope.dimensions),
        ) as ProtocolRevision["dimensions"];
        applied++;
      } else if (prefillSteps.scope && result.errors.scope) {
        failed.push("scope");
      }
      if (prefillSteps.eligibility && !result.errors.eligibility) {
        const rules: ProtocolRevision["eligibilityRules"] = [
          ...result.eligibility.inclusionRules
            .filter((text) => text.trim())
            .map((text) => newEligibilityRule("include", text.trim())),
          ...result.eligibility.exclusionRules
            .filter((text) => text.trim())
            .map((text) => newEligibilityRule("exclude", text.trim())),
        ];
        draft.eligibilityRules = rules;
        draft.includeKeywordAids = [...result.eligibility.includeKeywordAids];
        draft.excludeKeywordAids = [...result.eligibility.excludeKeywordAids];
        if (result.eligibility.dimensionKeywordAids) {
          draft.dimensions.forEach((dimension) => {
            const aids = result.eligibility.dimensionKeywordAids[dimension.key];
            if (aids) dimension.keywordAids = [...aids];
          });
        }
        applied++;
      } else if (prefillSteps.eligibility && result.errors.eligibility) {
        failed.push("eligibility");
      }
      if (prefillSteps.mapping && !result.errors.mapping) {
        draft.dimensions.forEach((dimension) => {
          const labels = result.mapping.evidenceLabels[dimension.key];
          dimension.evidenceLabels = labels ? [...labels] : [];
        });
        applied++;
      } else if (prefillSteps.mapping && result.errors.mapping) {
        failed.push("mapping");
      }
      if (prefillSteps.template && !result.errors.template) {
        service.addExtractionTemplateProposal(currentState!, result.template);
        await service.save(currentState!);
        applied++;
        templateDrafted = true;
      } else if (prefillSteps.template && result.errors.template) {
        failed.push("template");
      }
      if (applied > 0) {
        toast(
          doc,
          `Applied ${applied} selected step${applied === 1 ? "" : "s"} to the draft`,
        );
        render();
        reRenderPanel(doc, currentPanel);
      } else {
        toast(doc, "No steps were selected to prefill");
      }
      return { applied, templateDrafted, failed };
    };

    const renderResultBanner = (params: {
      applied: number;
      templateDrafted: boolean;
      failed: ProtocolGenerationStep[];
    }): void => {
      const { applied, templateDrafted, failed } = params;
      resultBanner.replaceChildren();
      if (applied === 0 && failed.length === 0 && !templateDrafted) {
        resultBanner.style.display = "none";
        return;
      }
      resultBanner.style.display = "flex";
      const heading = doc.createElement("div");
      heading.style.cssText = "font-weight:700;font-size:12px;";
      heading.textContent =
        applied > 0
          ? `${applied} step${applied === 1 ? "" : "s"} prefilled into the draft.`
          : "Generation complete.";
      resultBanner.appendChild(heading);
      if (templateDrafted) {
        const templateLine = doc.createElement("div");
        templateLine.style.cssText =
          "display:flex;align-items:center;gap:8px;flex-wrap:wrap;";
        const templateNote = doc.createElement("span");
        templateNote.style.color = "#0f766e";
        templateNote.textContent =
          "Extraction template draft saved. Approve it to enable extraction.";
        templateLine.appendChild(templateNote);
        const openBtn = doc.createElement("button");
        openBtn.textContent = "Open Extraction Workspace";
        openBtn.style.cssText =
          "padding:3px 9px;font-size:11px;font-weight:600;border:1px solid #7c3aed;border-radius:4px;background:#7c3aed;color:#fff;cursor:pointer;font-family:inherit;";
        openBtn.addEventListener("click", () => {
          openExtractionWorkspace(doc);
        });
        templateLine.appendChild(openBtn);
        resultBanner.appendChild(templateLine);
      }
      if (failed.length > 0) {
        const failedLine = doc.createElement("div");
        failedLine.style.color = "#b91c1c";
        failedLine.textContent = `Failed: ${failed.join(", ")}. Errors are listed under each step.`;
        resultBanner.appendChild(failedLine);
      }
    };

    const runGeneration = async (
      mode: "generate" | "reassess",
    ): Promise<void> => {
      generate.disabled = true;
      reassess.disabled = true;
      generationStatus = {
        scope: "running",
        eligibility: "running",
        mapping: "running",
        template: "running",
      };
      generationResult = null;
      resultBanner.replaceChildren();
      resultBanner.style.display = "none";
      stepRows.forEach((status) => {
        status.textContent = "…";
        status.style.color = "#0f766e";
      });
      stepSummaries.forEach((summary) => {
        summary.textContent = "running";
      });
      const onStep = (
        step: ProtocolGenerationStep,
        partial: ProtocolGenerationResult,
      ): void => {
        generationStatus[step] = partial.errors[step] ? "error" : "complete";
        const row = stepRows.get(step);
        const summary = stepSummaries.get(step);
        const checkbox = stepCheckboxes.get(step);
        if (row) {
          if (partial.errors[step]) {
            row.replaceChildren(
              createSvgIcon(row.ownerDocument!, ICONS.close, "error", 14),
            );
            row.style.color = "#dc2626";
          } else {
            row.replaceChildren(
              createSvgIcon(row.ownerDocument!, ICONS.check, "done", 14),
            );
            row.style.color = "#15803d";
          }
        }
        if (summary) {
          const err = partial.errors[step];
          summary.textContent = err
            ? `error: ${err}`
            : partial.summary[step] || "complete";
          summary.style.color = err ? "#b91c1c" : "var(--text-tertiary)";
          summary.title = err || "";
        }
      };
      try {
        const baselineRevision =
          mode === "reassess"
            ? getActiveProtocolRevision(currentState!.protocol)
            : draft;
        const baselineTemplate =
          mode === "reassess"
            ? service.getExtractionTemplate(currentState!)
            : undefined;
        const result = await service.generateProtocolProposals(
          currentState!,
          uploadedDocs.filter((doc) => !doc.error),
          { baselineRevision, baselineTemplate },
          onStep,
        );
        generationResult = result;
        Object.entries(generationStatus).forEach(([step, status]) => {
          if (status === "running") {
            const err = result.errors[step as ProtocolGenerationStep];
            generationStatus[step as ProtocolGenerationStep] = err
              ? "error"
              : "complete";
            const row = stepRows.get(step as ProtocolGenerationStep);
            const summary = stepSummaries.get(step as ProtocolGenerationStep);
            const checkbox = stepCheckboxes.get(step as ProtocolGenerationStep);
            if (row) {
              row.replaceChildren(
                createSvgIcon(
                  row.ownerDocument!,
                  err ? ICONS.close : ICONS.check,
                  err ? "error" : "done",
                  14,
                ),
              );
              row.style.color = err ? "#dc2626" : "#15803d";
            }
            if (summary) {
              summary.textContent = err
                ? `error: ${err}`
                : result.summary[step as ProtocolGenerationStep] || "complete";
              summary.style.color = err ? "#b91c1c" : "var(--text-tertiary)";
              summary.title = err || "";
            }
          }
        });
        toast(
          doc,
          mode === "reassess"
            ? "Protocol reassessment complete"
            : "Protocol generation complete",
        );
        const applySummary = await applyProposalsToDraft(result);
        renderResultBanner(applySummary);
      } catch (error) {
        Zotero.debug(`[seerai] Protocol ${mode} failed: ${error}`);
        toast(doc, `Protocol ${mode} failed: ${(error as Error).message}`);
        stepRows.forEach((row) => {
          if (row.textContent === "…") {
            row.replaceChildren(
              createSvgIcon(row.ownerDocument!, ICONS.close, "error", 14),
            );
            row.style.color = "#dc2626";
          }
        });
      } finally {
        generate.disabled = false;
        reassess.disabled = false;
      }
    };

    generate.addEventListener("click", () => {
      void runGeneration("generate");
    });
    reassess.addEventListener("click", () => {
      void runGeneration("reassess");
    });

    return generation;
  };

  const render = (): void => {
    body.replaceChildren();
    footer.replaceChildren();
    const warnings = validateProtocolRevision(draft);

    const status = doc.createElement("div");
    status.style.cssText =
      "display:flex;gap:10px;align-items:center;flex-wrap:wrap;font-size:12px;";
    const badge = doc.createElement("span");
    badge.textContent = draft.framework;
    badge.style.cssText =
      "padding:3px 7px;border-radius:999px;background:var(--background-secondary);border:1px solid var(--border-primary);font-weight:700;";
    status.appendChild(badge);
    const revisionStatus = doc.createElement("span");
    revisionStatus.textContent = `${currentState!.protocol.revisions.length} revisions · active ${draft.actor} revision`;
    revisionStatus.style.color = "var(--text-tertiary)";
    status.appendChild(revisionStatus);
    const validation = doc.createElement("span");
    validation.textContent =
      warnings.length === 0
        ? "Protocol complete"
        : `${warnings.length} validation warning${warnings.length === 1 ? "" : "s"}`;
    validation.style.color = warnings.length === 0 ? "#15803d" : "#b45309";
    status.appendChild(validation);
    body.appendChild(status);

    const tabs = doc.createElement("div");
    tabs.style.cssText =
      "display:grid;grid-template-columns:repeat(4,1fr);gap:6px;padding:5px;border-radius:10px;background:var(--background-secondary);";
    (
      [
        ["scope", "1. Scope"],
        ["eligibility", "2. Eligibility"],
        ["mapping", "3. Evidence Mapping"],
        ["template", "4. Extraction Template"],
      ] as const
    ).forEach(([id, label]) => {
      const tab = doc.createElement("button");
      tab.textContent = label;
      tab.style.cssText = `${buttonStyle}border-color:${activeProtocolTab === id ? "var(--highlight-primary)" : "transparent"};background:${activeProtocolTab === id ? "var(--background-primary)" : "transparent"};color:${activeProtocolTab === id ? "var(--highlight-primary)" : "var(--text-secondary)"};font-weight:700;font-size:11px;`;
      tab.addEventListener("click", () => {
        activeProtocolTab = id;
        render();
      });
      tabs.appendChild(tab);
    });
    body.appendChild(tabs);

    const presetBar = doc.createElement("div");
    presetBar.style.cssText =
      "display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:10px 12px;border:1px solid var(--border-secondary);border-radius:9px;background:var(--background-secondary);";
    const presetLabel = doc.createElement("strong");
    presetLabel.textContent = "Preset";
    presetLabel.style.fontSize = "12px";
    presetBar.appendChild(presetLabel);
    const presetSelect = doc.createElement("select");
    presetSelect.style.cssText = `${inputStyle}width:auto;min-width:220px;flex:1;`;
    const noPreset = doc.createElement("option");
    noPreset.value = "";
    noPreset.textContent = "Choose a saved protocol preset";
    presetSelect.appendChild(noPreset);
    protocolPresets.forEach((preset) => {
      const option = doc.createElement("option");
      option.value = preset.id;
      option.textContent = `${preset.name} · ${preset.framework}`;
      option.selected = selectedPresetId === preset.id;
      presetSelect.appendChild(option);
    });
    presetSelect.addEventListener("change", () => {
      selectedPresetId = presetSelect.value;
      render();
    });
    presetBar.appendChild(presetSelect);
    const applyPresetButton = doc.createElement("button");
    applyPresetButton.textContent = "Apply";
    applyPresetButton.disabled = !selectedPresetId;
    applyPresetButton.style.cssText = buttonStyle;
    applyPresetButton.addEventListener("click", () => {
      const preset = protocolPresets.find(
        (candidate) => candidate.id === selectedPresetId,
      );
      if (!preset) return;
      draft = applyProtocolPreset(draft, preset);
      activeProtocolTab = "scope";
      toast(doc, `Applied preset "${preset.name}" to the draft`);
      render();
    });
    presetBar.appendChild(applyPresetButton);
    const presetNameInput = doc.createElement("input");
    presetNameInput.value =
      protocolPresets.find((preset) => preset.id === selectedPresetId)?.name ||
      "";
    presetNameInput.placeholder = "Preset name";
    presetNameInput.style.cssText = `${inputStyle}width:180px;`;
    presetBar.appendChild(presetNameInput);
    const savePresetButton = doc.createElement("button");
    savePresetButton.textContent = selectedPresetId
      ? "Update preset"
      : "Save as preset";
    savePresetButton.style.cssText = `${buttonStyle}border-color:var(--highlight-primary);color:var(--highlight-primary);font-weight:700;`;
    savePresetButton.addEventListener("click", async () => {
      const selected = protocolPresets.find(
        (candidate) => candidate.id === selectedPresetId,
      );
      const name = presetNameInput.value.trim();
      if (!name) {
        presetNameInput.focus();
        return;
      }
      try {
        const saved = await saveProtocolPreset(name, draft, selected?.id);
        protocolPresets = await loadProtocolPresets();
        selectedPresetId = saved.id;
        toast(doc, `Preset "${saved.name}" saved`);
        render();
      } catch (error) {
        toast(doc, `Could not save preset: ${(error as Error).message}`);
      }
    });
    presetBar.appendChild(savePresetButton);
    const exportButton = doc.createElement("button");
    exportButton.textContent = "Export";
    exportButton.style.cssText = buttonStyle;
    exportButton.addEventListener("click", () => {
      const selected = protocolPresets.find(
        (candidate) => candidate.id === selectedPresetId,
      );
      let preset: ProtocolPreset;
      let exportName: string;
      if (selected) {
        preset = selected;
        exportName = selected.name;
      } else {
        exportName = presetNameInput.value.trim() || "protocol";
        preset = revisionToProtocolPreset(draft, exportName);
      }
      const json = protocolPresetToJson(preset);
      const blob = new Blob([json], { type: "application/json" });
      const url = doc.defaultView?.URL.createObjectURL(blob);
      if (!url) return;
      const a = doc.createElement("a");
      a.href = url;
      a.download = `${exportName.replace(/[^a-z0-9_-]+/gi, "_") || "protocol"}.json`;
      a.style.display = "none";
      appendToBody(doc, a);
      a.click();
      a.remove();
      doc.defaultView?.URL.revokeObjectURL(url);
      toast(doc, "Protocol exported");
    });
    presetBar.appendChild(exportButton);
    const importButton = doc.createElement("button");
    importButton.textContent = "Import";
    importButton.style.cssText = buttonStyle;
    importButton.addEventListener("click", async () => {
      try {
        const win = Zotero.getMainWindow() as any;
        const fp = new win.FilePicker();
        fp.init(win, "Import Protocol Preset", fp.modeOpen);
        fp.appendFilter("JSON", "*.json");
        fp.appendFilters(fp.filterAll);
        const result = await fp.show();
        if (result !== fp.returnOK || !fp.file) return;
        const raw = (await Zotero.File.getContentsAsync(fp.file)) as string;
        const preset = parseProtocolPresetJson(raw);
        const imported = await importProtocolPreset(preset);
        protocolPresets = await loadProtocolPresets();
        selectedPresetId = imported.id;
        presetNameInput.value = imported.name;
        toast(doc, `Imported preset "${imported.name}"`);
        render();
      } catch (error) {
        toast(doc, `Could not import preset: ${(error as Error).message}`);
      }
    });
    presetBar.appendChild(importButton);
    if (selectedPresetId) {
      const deletePresetButton = doc.createElement("button");
      deletePresetButton.textContent = "Delete";
      deletePresetButton.style.cssText = `${buttonStyle}color:#b91c1c;border-color:#ef4444;`;
      deletePresetButton.addEventListener("click", async () => {
        const selected = protocolPresets.find(
          (candidate) => candidate.id === selectedPresetId,
        );
        if (!selected) return;
        const confirmed = doc.defaultView?.confirm(
          `Delete preset "${selected.name}"?`,
        );
        if (!confirmed) return;
        try {
          await deleteProtocolPreset(selected.id);
          protocolPresets = await loadProtocolPresets();
          selectedPresetId = "";
          render();
        } catch (error) {
          toast(doc, `Could not delete preset: ${(error as Error).message}`);
        }
      });
      presetBar.appendChild(deletePresetButton);
    }
    body.appendChild(presetBar);
    body.appendChild(buildProtocolGeneration());

    if (activeProtocolTab === "scope") {
      const scope = section(
        "Question and framework",
        "The framework defines the dimensions used throughout the review. It is not restricted to PICO.",
      );
      const question = doc.createElement("textarea");
      question.value = draft.researchQuestion;
      question.placeholder = "State the review question or objective";
      question.style.cssText = `${inputStyle}min-height:64px;resize:vertical;`;
      question.addEventListener("input", () => {
        draft.researchQuestion = question.value;
      });
      scope.appendChild(question);
      const framework = doc.createElement("select");
      framework.style.cssText = `${inputStyle}margin-top:8px;`;
      Object.entries(FRAMEWORK_DEFS).forEach(([key, definition]) => {
        const option = doc.createElement("option");
        option.value = key;
        option.textContent = `${definition.label}: ${definition.fields
          .map((field) => field.label)
          .join(", ")}`;
        option.selected = key === draft.framework;
        framework.appendChild(option);
      });
      framework.addEventListener("change", () => {
        draft.framework = framework.value;
        draft.dimensions = dimensionsForFramework(
          draft.framework,
          draft.dimensions,
        );
        render();
      });
      scope.appendChild(framework);
      body.appendChild(scope);

      const dimensions = section(
        `${draft.framework} dimensions`,
        "Criterion text drives screening. Keywords only assist discovery and triage. Evidence mappings connect dimensions to synthesis labels.",
      );
      draft.dimensions.forEach((dimension) => {
        const card = doc.createElement("div");
        card.style.cssText =
          "padding:10px 0;border-top:1px solid var(--border-secondary);";
        const label = doc.createElement("div");
        label.textContent = `${dimension.key} · ${dimension.label}`;
        label.style.cssText = "font-size:14px;font-weight:700;";
        card.appendChild(label);
        const hint = doc.createElement("div");
        hint.textContent = dimension.description;
        hint.style.cssText =
          "font-size:12px;color:var(--text-tertiary);margin:3px 0 7px;";
        card.appendChild(hint);
        const criterion = doc.createElement("textarea");
        criterion.value = dimension.value;
        criterion.style.cssText = `${inputStyle}min-height:52px;resize:vertical;`;
        criterion.addEventListener("input", () => {
          dimension.value = criterion.value;
        });
        card.appendChild(criterion);
        dimensions.appendChild(card);
      });
      body.appendChild(dimensions);
    }

    if (activeProtocolTab === "eligibility") {
      const rules = section(
        "Eligibility rules",
        "Explicit inclusion and exclusion rules are evaluated against source evidence during screening.",
      );
      const typeSwitch = doc.createElement("div");
      typeSwitch.style.cssText =
        "display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:12px;padding:4px;border-radius:8px;background:var(--background-secondary);";
      (["include", "exclude"] as const).forEach((type) => {
        const button = doc.createElement("button");
        button.textContent =
          type === "include" ? "Inclusion criteria" : "Exclusion criteria";
        button.style.cssText = `${buttonStyle}font-weight:700;background:${
          activeEligibilityType === type
            ? "var(--background-primary)"
            : "transparent"
        };border-color:${
          activeEligibilityType === type
            ? type === "include"
              ? "#16a34a"
              : "#dc2626"
            : "transparent"
        };color:${type === "include" ? "#15803d" : "#b91c1c"};`;
        button.addEventListener("click", () => {
          activeEligibilityType = type;
          render();
        });
        typeSwitch.appendChild(button);
      });
      rules.appendChild(typeSwitch);
      const ruleGrid = doc.createElement("div");
      ruleGrid.style.cssText = "display:block;";
      [activeEligibilityType].forEach((type) => {
        const rulePanel = doc.createElement("div");
        rulePanel.style.cssText = `padding:12px;border:1px solid ${
          type === "include" ? "#86efac" : "#fca5a5"
        };border-radius:10px;background:${
          type === "include"
            ? "color-mix(in srgb, #dcfce7 35%, var(--background-primary))"
            : "color-mix(in srgb, #fee2e2 35%, var(--background-primary))"
        };`;
        const ruleHeading = doc.createElement("div");
        ruleHeading.textContent =
          type === "include" ? "Inclusion criteria" : "Exclusion criteria";
        ruleHeading.style.cssText = `font-size:14px;font-weight:700;margin-bottom:7px;color:${
          type === "include" ? "#15803d" : "#b91c1c"
        };`;
        rulePanel.appendChild(ruleHeading);
        const entry = doc.createElement("div");
        entry.style.cssText = "display:flex;gap:6px;margin-bottom:10px;";
        const newRuleInput = doc.createElement("input");
        newRuleInput.placeholder =
          type === "include"
            ? "Add an inclusion criterion"
            : "Add an exclusion criterion";
        newRuleInput.style.cssText = inputStyle;
        entry.appendChild(newRuleInput);
        const add = doc.createElement("button");
        add.textContent = "Add";
        add.style.cssText = `${buttonStyle}font-weight:700;`;
        const addRule = () => {
          const value = newRuleInput.value.trim();
          if (!value) {
            newRuleInput.focus();
            return;
          }
          draft.eligibilityRules.push(newEligibilityRule(type, value));
          render();
        };
        add.addEventListener("click", addRule);
        newRuleInput.addEventListener("keydown", (event) => {
          if ((event as KeyboardEvent).key === "Enter") addRule();
        });
        entry.appendChild(add);
        rulePanel.appendChild(entry);
        const typeRules = draft.eligibilityRules.filter(
          (rule) => rule.type === type,
        );
        if (typeRules.length === 0) {
          const empty = doc.createElement("div");
          empty.textContent =
            type === "include"
              ? "No inclusion criteria defined."
              : "No exclusion criteria defined.";
          empty.style.cssText =
            "padding:8px 0;font-size:12px;color:var(--text-tertiary);";
          rulePanel.appendChild(empty);
        }
        typeRules.forEach((rule) => {
          const row = doc.createElement("div");
          row.style.cssText = "display:flex;gap:5px;margin-bottom:5px;";
          const ruleInput = doc.createElement("input");
          ruleInput.value = rule.text;
          ruleInput.style.cssText = inputStyle;
          ruleInput.addEventListener("input", () => {
            rule.text = ruleInput.value;
          });
          row.appendChild(ruleInput);
          const remove = doc.createElement("button");
          remove.textContent = "Remove";
          remove.style.cssText = buttonStyle;
          remove.addEventListener("click", () => {
            draft.eligibilityRules = draft.eligibilityRules.filter(
              (candidate) => candidate.id !== rule.id,
            );
            render();
          });
          row.appendChild(remove);
          rulePanel.appendChild(row);
        });
        ruleGrid.appendChild(rulePanel);
      });
      rules.appendChild(ruleGrid);
      body.appendChild(rules);

      const dimensionAids = section(
        "Dimension keyword aids",
        "Optional terms for highlighting and ranking records. They never make inclusion or exclusion decisions.",
      );
      draft.dimensions.forEach((dimension) => {
        const row = doc.createElement("div");
        row.style.cssText =
          "display:grid;grid-template-columns:minmax(140px,220px) 1fr;gap:10px;align-items:center;padding:8px 0;border-top:1px solid var(--border-secondary);";
        const aidLabel = doc.createElement("label");
        aidLabel.textContent = `${dimension.key} · ${dimension.label}`;
        aidLabel.style.fontWeight = "700";
        row.appendChild(aidLabel);
        const keyword = doc.createElement("input");
        keyword.value = dimension.keywordAids.join(", ");
        keyword.placeholder = "Comma-separated keyword aids";
        keyword.style.cssText = inputStyle;
        keyword.addEventListener("change", () => {
          dimension.keywordAids = keyword.value
            .split(",")
            .map((value) => value.trim().toLowerCase())
            .filter(Boolean);
        });
        row.appendChild(keyword);
        dimensionAids.appendChild(row);
      });
      body.appendChild(dimensionAids);

      const aids = section(
        "Global keyword aids",
        "These terms can highlight or rank records, but they never include or exclude a paper automatically.",
      );
      const aidGrid = doc.createElement("div");
      aidGrid.style.cssText =
        "display:grid;grid-template-columns:1fr 1fr;gap:8px;";
      const includeAidGroup = doc.createElement("label");
      includeAidGroup.style.cssText =
        "display:flex;flex-direction:column;gap:5px;font-size:12px;font-weight:700;color:#15803d;";
      includeAidGroup.append("Inclusion keyword aids");
      const includeAids = doc.createElement("input");
      includeAids.value = draft.includeKeywordAids.join(", ");
      includeAids.placeholder = "e.g. randomized, adult, intervention";
      includeAids.style.cssText = inputStyle;
      includeAids.addEventListener("change", () => {
        draft.includeKeywordAids = includeAids.value
          .split(",")
          .map((value) => value.trim().toLowerCase())
          .filter(Boolean);
      });
      includeAidGroup.appendChild(includeAids);
      aidGrid.appendChild(includeAidGroup);
      const excludeAidGroup = doc.createElement("label");
      excludeAidGroup.style.cssText =
        "display:flex;flex-direction:column;gap:5px;font-size:12px;font-weight:700;color:#b91c1c;";
      excludeAidGroup.append("Exclusion keyword aids");
      const excludeAids = doc.createElement("input");
      excludeAids.value = draft.excludeKeywordAids.join(", ");
      excludeAids.placeholder = "e.g. animal, protocol, editorial";
      excludeAids.style.cssText = inputStyle;
      excludeAids.addEventListener("change", () => {
        draft.excludeKeywordAids = excludeAids.value
          .split(",")
          .map((value) => value.trim().toLowerCase())
          .filter(Boolean);
      });
      excludeAidGroup.appendChild(excludeAids);
      aidGrid.appendChild(excludeAidGroup);
      aids.appendChild(aidGrid);
      body.appendChild(aids);
    }

    if (activeProtocolTab === "mapping") {
      const mappingSection = section(
        "Evidence mapping",
        "Connect each protocol dimension to evidence categories used by synthesis and gap analysis. These mappings do not affect screening decisions.",
      );
      draft.dimensions.forEach((dimension) => {
        const row = doc.createElement("div");
        row.style.cssText =
          "padding:14px 0;border-top:1px solid var(--border-secondary);";
        const rowTitle = doc.createElement("div");
        rowTitle.textContent = `${dimension.key} · ${dimension.label}`;
        rowTitle.style.cssText =
          "font-size:14px;font-weight:700;margin-bottom:8px;";
        row.appendChild(rowTitle);
        const mappings = doc.createElement("div");
        mappings.style.cssText =
          "display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px;";
        currentState!.labelDefs.forEach((definition) => {
          const mapLabel = doc.createElement("button");
          mapLabel.type = "button";
          mapLabel.style.cssText =
            "display:flex;align-items:center;justify-content:space-between;gap:7px;padding:8px;border:1px solid var(--border-secondary);border-radius:7px;font:inherit;font-size:12px;cursor:pointer;";
          const updateMappingButton = () => {
            const selected = dimension.evidenceLabels.includes(definition.k);
            mapLabel.replaceChildren();
            const name = doc.createElement("span");
            name.textContent = definition.name;
            mapLabel.appendChild(name);
            const state = doc.createElement("span");
            state.replaceChildren();
            if (selected)
              state.appendChild(
                createSvgIcon(state.ownerDocument!, ICONS.check, "added", 12),
              );
            state.appendChild(
              state.ownerDocument!.createTextNode(
                selected ? " Added" : "+ Add",
              ),
            );
            state.style.fontWeight = "700";
            mapLabel.appendChild(state);
            mapLabel.style.background = selected
              ? "var(--background-secondary)"
              : "var(--background-primary)";
            mapLabel.style.borderColor = selected
              ? "var(--highlight-primary)"
              : "var(--border-secondary)";
            mapLabel.style.color = selected
              ? "var(--highlight-primary)"
              : "var(--text-primary)";
            mapLabel.setAttribute("aria-pressed", String(selected));
          };
          mapLabel.addEventListener("click", () => {
            const selected = dimension.evidenceLabels.includes(definition.k);
            dimension.evidenceLabels = selected
              ? dimension.evidenceLabels.filter(
                  (value) => value !== definition.k,
                )
              : Array.from(
                  new Set([...dimension.evidenceLabels, definition.k]),
                );
            updateMappingButton();
          });
          updateMappingButton();
          mappings.appendChild(mapLabel);
        });
        row.appendChild(mappings);
        mappingSection.appendChild(row);
      });
      body.appendChild(mappingSection);
    }

    if (activeProtocolTab === "template") {
      buildProtocolTemplateTab(doc, body, draft, () => render());
    }

    const history = doc.createElement("details");
    history.style.cssText =
      "border:1px solid var(--border-secondary);border-radius:8px;padding:10px 12px;background:var(--background-primary);";
    const historySummary = doc.createElement("summary");
    historySummary.textContent = `Revision history (${currentState!.protocol.revisions.length})`;
    historySummary.style.cssText =
      "font-size:13px;font-weight:700;cursor:pointer;";
    history.appendChild(historySummary);
    [...currentState!.protocol.revisions].reverse().forEach((revision) => {
      const row = doc.createElement("div");
      row.style.cssText =
        "display:flex;align-items:center;gap:8px;padding:8px 0;border-top:1px solid var(--border-secondary);font-size:12px;";
      const info = doc.createElement("span");
      info.textContent = `${revision.framework} · ${revision.actor} · ${new Date(revision.createdAt).toLocaleString()}`;
      info.style.flex = "1";
      row.appendChild(info);
      if (revision.id === currentState!.protocol.activeRevisionId) {
        const activeLabel = doc.createElement("span");
        activeLabel.textContent = "Active";
        activeLabel.style.color = "#15803d";
        row.appendChild(activeLabel);
      } else {
        const rollback = doc.createElement("button");
        rollback.textContent = "Rollback";
        rollback.style.cssText = buttonStyle;
        rollback.addEventListener("click", async () => {
          const restored = service.rollbackProtocol(currentState!, revision.id);
          await service.save(currentState!);
          draft = JSON.parse(JSON.stringify(restored));
          syncModuleVarsFromState();
          render();
          reRenderPanel(doc, currentPanel);
        });
        row.appendChild(rollback);
      }
      history.appendChild(row);
    });
    body.appendChild(history);

    const warningText = doc.createElement("span");
    warningText.textContent =
      warnings.length === 0 ? "Ready to save" : warnings.join(" · ");
    warningText.style.cssText = `font-size:11px;color:${warnings.length === 0 ? "#15803d" : "#b45309"};`;
    footer.appendChild(warningText);
    const actions = doc.createElement("div");
    actions.style.cssText = "display:flex;gap:8px;";
    const cancel = doc.createElement("button");
    cancel.textContent = "Cancel";
    cancel.style.cssText = buttonStyle;
    cancel.addEventListener("click", () => wrapper.remove());
    actions.appendChild(cancel);
    const save = doc.createElement("button");
    save.textContent = "Save new revision";
    save.style.cssText = `${buttonStyle}background:var(--highlight-primary);border-color:var(--highlight-primary);color:white;font-weight:700;`;
    save.addEventListener("click", async () => {
      const revision = service.createProtocolRevision(currentState!, {
        actor: "user",
        model: undefined,
        researchQuestion: draft.researchQuestion,
        framework: draft.framework,
        frameworkReason: draft.frameworkReason,
        dimensions: draft.dimensions,
        eligibilityRules: draft.eligibilityRules.filter((rule) =>
          rule.text.trim(),
        ),
        includeKeywordAids: draft.includeKeywordAids,
        excludeKeywordAids: draft.excludeKeywordAids,
        provenance: draft.provenance,
      });
      await service.save(currentState!);
      draft = JSON.parse(JSON.stringify(revision));
      syncModuleVarsFromState();
      toast(doc, "Review protocol revision saved");
      wrapper.remove();
      reRenderPanel(doc, currentPanel);
    });
    actions.appendChild(save);
    footer.appendChild(actions);
  };

  wrapper.addEventListener("click", (event) => {
    if (event.target === wrapper) wrapper.remove();
  });
  render();
  mountReviewSheet(doc, wrapper);
  void loadProtocolPresets().then((loaded) => {
    protocolPresets = loaded;
    render();
  });
}

function openLegacyCriteriaModal(_doc: Document): void {
  const doc = _doc;
  if (!currentState) return;
  const space = getActiveSpace();
  if (!space) return;

  picoLabelMap = { ...(space.picoLabelMap || {}) };

  // Capture initial state for Cancel/close to restore
  const origFramework = space.framework;
  const origFrameworkValues = { ...space.frameworkValues };
  const origIncKeywords = [...space.incKeywords];
  const origExcKeywords = [...space.excKeywords];
  const origPicoLabelMap = { ...picoLabelMap };

  const restoreOrig = () => {
    space.framework = origFramework;
    space.frameworkValues = origFrameworkValues;
    space.incKeywords.length = 0;
    origIncKeywords.forEach((k) => space.incKeywords.push(k));
    space.excKeywords.length = 0;
    origExcKeywords.forEach((k) => space.excKeywords.push(k));
    picoLabelMap = origPicoLabelMap;
  };

  const doClose = () => {
    restoreOrig();
    const p = wrapper.parentElement;
    if (p) p.removeChild(wrapper);
  };

  const wrapper = doc.createElement("div");
  wrapper.style.cssText =
    "position:fixed;inset:0;background:rgba(0,0,0,0.45);z-index:1000;display:flex;align-items:center;justify-content:center;";
  wrapper.addEventListener("click", (e: Event) => {
    if (e.target === wrapper) {
      const p = wrapper.parentElement;
      if (p) p.removeChild(wrapper);
    }
  });

  const modal = doc.createElement("div");
  modal.style.cssText =
    "background:var(--background-primary);border:1px solid var(--border-primary);border-radius:12px;width:680px;max-width:95vw;max-height:90vh;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 12px 48px rgba(0,0,0,0.25);";
  wrapper.appendChild(modal);

  const styleEl = doc.createElement("style");
  styleEl.textContent = `
    @keyframes sr-pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.4; }
    }
    .sr-drop-active {
      border-color: var(--highlight-primary) !important;
      background: var(--background-primary) !important;
    }
  `;
  modal.appendChild(styleEl);

  const mhdr = doc.createElement("div");
  mhdr.style.cssText =
    "display:flex;align-items:center;justify-content:space-between;padding:12px 16px;border-bottom:1px solid var(--border-primary);background:var(--background-secondary);flex-shrink:0;";
  const mtitle = doc.createElement("div");
  mtitle.textContent = "Configure Screening Criteria";
  mtitle.style.cssText =
    "font-size:15px;font-weight:700;color:var(--text-primary);";
  mhdr.appendChild(mtitle);
  const closeBtn = doc.createElement("button");
  closeBtn.textContent = "\u00d7";
  closeBtn.style.cssText =
    "width:28px;height:28px;border:none;background:transparent;color:var(--text-secondary);cursor:pointer;font-size:18px;border-radius:4px;display:flex;align-items:center;justify-content:center;";
  closeBtn.addEventListener("click", () => {
    doClose();
  });
  mhdr.appendChild(closeBtn);
  modal.appendChild(mhdr);

  // Tab bar
  let activeTab = "framework";
  const tabBar = doc.createElement("div");
  tabBar.style.cssText =
    "display:flex;border-bottom:1px solid var(--border-primary);flex-shrink:0;";
  const tabBody = doc.createElement("div");
  tabBody.style.cssText = "flex:1;overflow-y:auto;padding:12px 16px;";

  const tabs: { id: string; label: string }[] = [
    { id: "framework", label: "Framework & Criteria" },
    { id: "keywords", label: "Keywords" },
    { id: "picomap", label: "PICO Mapping" },
    { id: "import", label: "Import Document" },
  ];

  const renderTabs = () => {
    while (tabBar.firstChild) tabBar.removeChild(tabBar.firstChild);
    while (tabBody.firstChild) tabBody.removeChild(tabBody.firstChild);

    tabs.forEach((tb: { id: string; label: string }) => {
      const tbtn = doc.createElement("button");
      tbtn.textContent = tb.label;
      tbtn.style.cssText =
        "flex:1;padding:6px 12px;border:none;border-bottom:2px solid " +
        (activeTab === tb.id ? "var(--highlight-primary)" : "transparent") +
        ";background:transparent;color:" +
        (activeTab === tb.id
          ? "var(--highlight-primary)"
          : "var(--text-secondary)") +
        ";cursor:pointer;font-size:11px;font-weight:500;font-family:inherit;transition:all 0.1s;";
      tbtn.addEventListener("click", () => {
        activeTab = tb.id;
        renderTabs();
      });
      tabBar.appendChild(tbtn);
    });

    if (activeTab === "framework") {
      // Framework selector
      const fgDiv = doc.createElement("div");
      fgDiv.style.cssText = "margin-bottom:12px;";
      const fgLbl = doc.createElement("div");
      fgLbl.textContent = "Framework";
      fgLbl.style.cssText =
        "font-size:12px;font-weight:600;color:var(--text-primary);margin-bottom:4px;";
      fgDiv.appendChild(fgLbl);
      const fgHelp = doc.createElement("div");
      fgHelp.textContent =
        "Select the question framework that matches your research type.";
      fgHelp.style.cssText =
        "font-size:10px;color:var(--text-tertiary);margin-bottom:6px;";
      fgDiv.appendChild(fgHelp);
      const fwSel = doc.createElement("select") as HTMLSelectElement;
      fwSel.style.cssText =
        "width:100%;padding:4px 6px;border:1px solid var(--border-primary);border-radius:4px;font-size:11px;font-family:inherit;background:var(--background-primary);color:var(--text-primary);";
      Object.keys(FRAMEWORK_DEFS).forEach((fk: string) => {
        const o = doc.createElement("option");
        o.value = fk;
        o.textContent =
          FRAMEWORK_DEFS[fk].label +
          " - " +
          FRAMEWORK_DEFS[fk].fields.map((f: any) => f.label).join(", ");
        if (space.framework === fk) o.selected = true;
        fwSel.appendChild(o);
      });
      fwSel.addEventListener("change", () => {
        space.framework = fwSel.value;
        space.frameworkValues = {};
        renderTabs();
      });
      fgDiv.appendChild(fwSel);
      tabBody.appendChild(fgDiv);

      // Dynamic fields
      const iconColors: Record<string, string> = {
        p: "#2563eb",
        i: "#16a34a",
        c: "#d97706",
        o: "#7c3aed",
        t: "#0891b2",
        s: "#059669",
        e: "#dc2626",
        pi: "#9333ea",
        co: "#0d9488",
        d: "#ea580c",
        ev: "#4f46e5",
        r: "#db2777",
        se: "#0284c7",
        pe: "#65a30d",
        ca: "#c026d3",
      };
      const def = FRAMEWORK_DEFS[space.framework] || FRAMEWORK_DEFS.PICOTS;
      def.fields.forEach((f: any) => {
        const row = doc.createElement("div");
        row.style.cssText = "margin-bottom:8px;";
        const lblRow = doc.createElement("div");
        lblRow.style.cssText =
          "display:flex;align-items:center;gap:6px;margin-bottom:2px;";
        // Icon circle
        const iconCircle = doc.createElement("span");
        iconCircle.textContent = f.k;
        iconCircle.style.cssText =
          "width:18px;height:18px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;font-size:9px;font-weight:700;color:#fff;background:" +
          (iconColors[f.icon] || "var(--highlight-primary)") +
          ";flex-shrink:0;";
        lblRow.appendChild(iconCircle);
        const lbl = doc.createElement("div");
        lbl.textContent = f.label;
        lbl.style.cssText =
          "font-size:11px;font-weight:600;color:var(--text-primary);";
        lblRow.appendChild(lbl);
        row.appendChild(lblRow);
        const hint = doc.createElement("div");
        hint.textContent = f.hint;
        hint.style.cssText =
          "font-size:9px;color:var(--text-tertiary);margin-bottom:3px;";
        row.appendChild(hint);
        const inp = doc.createElement("input") as HTMLInputElement;
        inp.type = "text";
        inp.value = space.frameworkValues[f.k] || "";
        inp.style.cssText =
          "width:100%;padding:4px 6px;border:1px solid var(--border-primary);border-radius:4px;font-size:11px;font-family:inherit;background:var(--background-primary);color:var(--text-primary);outline:none;box-sizing:border-box;";
        inp.addEventListener("change", () => {
          space.frameworkValues[f.k] = inp.value;
        });
        row.appendChild(inp);
        tabBody.appendChild(row);
      });
    } else if (activeTab === "keywords") {
      const help = doc.createElement("div");
      help.textContent =
        "Keywords determine inclusion/exclusion during AI screening. Papers matching more include keywords are more likely to be included.";
      help.style.cssText =
        "font-size:10px;color:var(--text-tertiary);margin-bottom:12px;line-height:1.5;";
      tabBody.appendChild(help);

      const cols = doc.createElement("div");
      cols.style.cssText =
        "display:grid;grid-template-columns:1fr 1fr;gap:12px;";

      // Include column
      const incCol = doc.createElement("div");
      const incHdr = doc.createElement("div");
      incHdr.textContent = "Include Keywords";
      incHdr.style.cssText =
        "font-size:11px;font-weight:600;color:#16a34a;margin-bottom:4px;";
      incCol.appendChild(incHdr);
      const incBody = doc.createElement("div");
      incBody.style.cssText = "margin-bottom:6px;";
      space.incKeywords.forEach((kw: string) => {
        const tag = doc.createElement("span");
        tag.style.cssText =
          "display:inline-block;padding:2px 6px;margin:1px 2px;border-radius:3px;font-size:9px;background:#dcfce7;color:#166534;cursor:pointer;";
        tag.textContent = kw + " \u00d7";
        tag.addEventListener("click", () => {
          const idx = space.incKeywords.indexOf(kw);
          if (idx >= 0) space.incKeywords.splice(idx, 1);
          renderTabs();
        });
        incBody.appendChild(tag);
      });
      incCol.appendChild(incBody);
      const incAdd = doc.createElement("div");
      incAdd.style.cssText = "display:flex;gap:4px;";
      const incInp = doc.createElement("input") as HTMLInputElement;
      incInp.type = "text";
      incInp.placeholder = "Add keyword...";
      incInp.style.cssText =
        "flex:1;padding:2px 6px;border:1px solid var(--border-primary);border-radius:4px;font-size:10px;font-family:inherit;";
      incInp.addEventListener("keydown", (e: KeyboardEvent) => {
        if (e.key === "Enter") {
          const v = incInp.value.trim().toLowerCase();
          if (v && !space.incKeywords.includes(v)) {
            space.incKeywords.push(v);
            incInp.value = "";
            renderTabs();
          }
        }
      });
      incAdd.appendChild(incInp);
      const incBtn2 = doc.createElement("button");
      incBtn2.textContent = "+";
      incBtn2.style.cssText =
        "padding:2px 8px;border:1px solid #16a34a;border-radius:4px;background:#16a34a;color:#fff;cursor:pointer;font-size:12px;font-family:inherit;";
      incBtn2.addEventListener("click", () => {
        const v = incInp.value.trim().toLowerCase();
        if (v && !space.incKeywords.includes(v)) {
          space.incKeywords.push(v);
          incInp.value = "";
          renderTabs();
        }
      });
      incAdd.appendChild(incBtn2);
      incCol.appendChild(incAdd);

      // Include suggestions
      const incSug = doc.createElement("div");
      incSug.style.cssText =
        "margin-top:6px;font-size:9px;color:var(--text-tertiary);";
      incSug.appendChild(doc.createTextNode("Suggest: "));
      ["randomized", "trial", "prospective", "biomarker"].forEach(
        (sug: string) => {
          const sugBtn = doc.createElement("button");
          sugBtn.textContent = sug;
          sugBtn.style.cssText =
            "padding:1px 5px;margin:1px;border:1px solid var(--border-secondary);border-radius:3px;background:transparent;color:var(--text-secondary);cursor:pointer;font-size:8px;font-family:inherit;";
          sugBtn.addEventListener("click", () => {
            if (!space.incKeywords.includes(sug)) {
              space.incKeywords.push(sug);
              renderTabs();
            }
          });
          incSug.appendChild(sugBtn);
        },
      );
      incCol.appendChild(incSug);
      cols.appendChild(incCol);

      // Exclude column
      const excCol = doc.createElement("div");
      const excHdr = doc.createElement("div");
      excHdr.textContent = "Exclude Keywords";
      excHdr.style.cssText =
        "font-size:11px;font-weight:600;color:#dc2626;margin-bottom:4px;";
      excCol.appendChild(excHdr);
      const excBody = doc.createElement("div");
      excBody.style.cssText = "margin-bottom:6px;";
      space.excKeywords.forEach((kw: string) => {
        const tag = doc.createElement("span");
        tag.style.cssText =
          "display:inline-block;padding:2px 6px;margin:1px 2px;border-radius:3px;font-size:9px;background:#fce4ec;color:#991b1b;cursor:pointer;";
        tag.textContent = kw + " \u00d7";
        tag.addEventListener("click", () => {
          const idx = space.excKeywords.indexOf(kw);
          if (idx >= 0) space.excKeywords.splice(idx, 1);
          renderTabs();
        });
        excBody.appendChild(tag);
      });
      excCol.appendChild(excBody);
      const excAdd = doc.createElement("div");
      excAdd.style.cssText = "display:flex;gap:4px;";
      const excInp = doc.createElement("input") as HTMLInputElement;
      excInp.type = "text";
      excInp.placeholder = "Add keyword...";
      excInp.style.cssText =
        "flex:1;padding:2px 6px;border:1px solid var(--border-primary);border-radius:4px;font-size:10px;font-family:inherit;";
      excInp.addEventListener("keydown", (e: KeyboardEvent) => {
        if (e.key === "Enter") {
          const v = excInp.value.trim().toLowerCase();
          if (v && !space.excKeywords.includes(v)) {
            space.excKeywords.push(v);
            excInp.value = "";
            renderTabs();
          }
        }
      });
      excAdd.appendChild(excInp);
      const excBtn2 = doc.createElement("button");
      excBtn2.textContent = "+";
      excBtn2.style.cssText =
        "padding:2px 8px;border:1px solid #dc2626;border-radius:4px;background:#dc2626;color:#fff;cursor:pointer;font-size:12px;font-family:inherit;";
      excBtn2.addEventListener("click", () => {
        const v = excInp.value.trim().toLowerCase();
        if (v && !space.excKeywords.includes(v)) {
          space.excKeywords.push(v);
          excInp.value = "";
          renderTabs();
        }
      });
      excAdd.appendChild(excBtn2);
      excCol.appendChild(excAdd);

      // Exclude suggestions
      const excSug = doc.createElement("div");
      excSug.style.cssText =
        "margin-top:6px;font-size:9px;color:var(--text-tertiary);";
      excSug.appendChild(doc.createTextNode("Suggest: "));
      ["observational", "cohort", "case report", "editorial"].forEach(
        (sug: string) => {
          const sugBtn = doc.createElement("button");
          sugBtn.textContent = sug;
          sugBtn.style.cssText =
            "padding:1px 5px;margin:1px;border:1px solid var(--border-secondary);border-radius:3px;background:transparent;color:var(--text-secondary);cursor:pointer;font-size:8px;font-family:inherit;";
          sugBtn.addEventListener("click", () => {
            if (!space.excKeywords.includes(sug)) {
              space.excKeywords.push(sug);
              renderTabs();
            }
          });
          excSug.appendChild(sugBtn);
        },
      );
      excCol.appendChild(excSug);
      cols.appendChild(excCol);
      tabBody.appendChild(cols);
    } else if (activeTab === "picomap") {
      const help = doc.createElement("div");
      help.textContent =
        "Map which labels correspond to each PICO dimension. This drives the gap analysis matrix and evidence synthesis. Labels can belong to multiple PICO dimensions.";
      help.style.cssText =
        "font-size:10px;color:var(--text-tertiary);margin-bottom:12px;line-height:1.5;";
      tabBody.appendChild(help);

      const picoKeys = Object.keys(picoLabelMap);
      const picoNames: Record<string, string> = {
        P: "Population",
        I: "Intervention",
        C: "Comparison",
        O: "Outcome",
        S: "Setting",
      };
      const labelDefs = currentState?.labelDefs || [];
      picoKeys.forEach((pk: string) => {
        const pDiv = doc.createElement("div");
        pDiv.style.cssText =
          "margin-bottom:10px;padding:8px;border:1px solid var(--border-secondary);border-radius:6px;";
        const pHdr = doc.createElement("div");
        pHdr.style.cssText =
          "display:flex;align-items:center;gap:6px;margin-bottom:6px;";
        const pBadge = doc.createElement("span");
        pBadge.textContent = pk;
        pBadge.style.cssText =
          "width:20px;height:20px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;font-size:10px;font-weight:700;background:var(--highlight-primary);color:#fff;flex-shrink:0;";
        pHdr.appendChild(pBadge);
        const pName = doc.createElement("span");
        pName.textContent = picoNames[pk] || pk;
        pName.style.cssText =
          "font-size:11px;font-weight:600;color:var(--text-primary);";
        pHdr.appendChild(pName);
        pDiv.appendChild(pHdr);

        const chipRow = doc.createElement("div");
        chipRow.style.cssText = "display:flex;flex-wrap:wrap;gap:4px;";
        labelDefs.forEach((ld: LabelDefinition) => {
          const mapped = (picoLabelMap[pk] || []).includes(ld.k);
          const chip = doc.createElement("button");
          chip.textContent = ld.name;
          chip.style.cssText =
            "padding:2px 8px;border-radius:12px;font-size:9px;cursor:pointer;border:2px solid " +
            (mapped ? ld.color : "var(--border-secondary)") +
            ";background:" +
            (mapped ? ld.bg : "transparent") +
            ";color:" +
            (mapped ? ld.color : "var(--text-tertiary)") +
            ";font-weight:" +
            (mapped ? "600" : "400") +
            ";font-family:inherit;";
          chip.addEventListener("click", () => {
            if (!picoLabelMap[pk]) picoLabelMap[pk] = [];
            const idx = picoLabelMap[pk].indexOf(ld.k);
            if (idx >= 0) picoLabelMap[pk].splice(idx, 1);
            else picoLabelMap[pk].push(ld.k);
            renderTabs();
          });
          chipRow.appendChild(chip);
        });
        pDiv.appendChild(chipRow);
        tabBody.appendChild(pDiv);
      });
    } else if (activeTab === "import") {
      buildImportTab(doc, tabBody, () => {
        activeTab = "framework";
        renderTabs();
      });
    }
  };

  function buildImportTab(
    doc: Document,
    container: HTMLElement,
    onApply: () => void,
  ): void {
    const space2 = getActiveSpace();
    if (!space2) return;

    const uploadedDocs: ExtractedDocument[] = [];
    const analysisProgress: AnalysisProgress[] = [
      { step: 1, status: "pending" },
      { step: 2, status: "pending" },
      { step: 3, status: "pending" },
    ];
    let analysisResults:
      | {
          framework: string;
          frameworkReason: string;
          fields: Record<string, string>;
          incKeywords: string[];
          excKeywords: string[];
          suggestedLabels: { name: string; reason: string }[];
        }
      | undefined;
    let isAnalyzing = false;

    const help = doc.createElement("div");
    help.textContent =
      "Import research protocol PDFs, methods documents (MD), or study descriptions (DOCX). The AI will analyze the content and automatically populate the framework, criteria fields, keywords, and label mappings.";
    help.style.cssText =
      "font-size:10px;color:var(--text-tertiary);margin-bottom:12px;line-height:1.5;";
    container.appendChild(help);

    const dropZoneWrapper = doc.createElement("div");
    dropZoneWrapper.style.cssText = "margin-bottom:10px;";
    container.appendChild(dropZoneWrapper);

    function buildDropZone(): HTMLElement {
      const zone = doc.createElement("div");
      zone.style.cssText =
        "border:2px dashed var(--border-primary);border-radius:8px;padding:20px;text-align:center;cursor:pointer;transition:all 0.2s;background:var(--background-secondary);";
      zone.addEventListener("mouseenter", () => {
        zone.style.borderColor = "var(--highlight-primary)";
        zone.style.background = "var(--background-primary)";
      });
      zone.addEventListener("mouseleave", () => {
        zone.style.borderColor = "var(--border-primary)";
        zone.style.background = "var(--background-secondary)";
      });
      zone.addEventListener("click", openFilePicker);

      const icon = doc.createElement("div");
      icon.textContent = "\u21E7";
      icon.style.cssText =
        "font-size:28px;color:var(--text-tertiary);margin-bottom:6px;";
      zone.appendChild(icon);

      const lbl = doc.createElement("div");
      lbl.textContent = "Click to upload or drag files here";
      lbl.style.cssText =
        "font-size:12px;font-weight:500;color:var(--text-secondary);margin-bottom:2px;";
      zone.appendChild(lbl);

      const hint = doc.createElement("div");
      hint.textContent = "PDF, MD, DOCX (max 80K chars each)";
      hint.style.cssText = "font-size:10px;color:var(--text-tertiary);";
      zone.appendChild(hint);

      return zone;
    }

    function refreshDropZone(): void {
      while (dropZoneWrapper.firstChild)
        dropZoneWrapper.removeChild(dropZoneWrapper.firstChild);
      dropZoneWrapper.appendChild(buildDropZone());
    }

    refreshDropZone();

    const fileList = doc.createElement("div");
    fileList.style.cssText = "margin-bottom:10px;";
    container.appendChild(fileList);

    function refreshFileList(): void {
      while (fileList.firstChild) fileList.removeChild(fileList.firstChild);
      if (uploadedDocs.length === 0) return;

      uploadedDocs.forEach((d, idx) => {
        const row = doc.createElement("div");
        row.style.cssText =
          "display:flex;align-items:center;gap:6px;padding:4px 8px;margin-bottom:3px;border:1px solid var(--border-secondary);border-radius:6px;background:var(--background-primary);font-size:11px;";

        const iconSpan = doc.createElement("span");
        iconSpan.replaceChildren(
          createSvgIcon(
            iconSpan.ownerDocument!,
            d.error ? ICONS.warning : ICONS.document,
            d.error ? "error" : "document",
            14,
          ),
        );
        iconSpan.style.cssText = "flex-shrink:0;";
        row.appendChild(iconSpan);

        const info = doc.createElement("div");
        info.style.cssText = "flex:1;min-width:0;";
        const nameEl = doc.createElement("div");
        nameEl.textContent = d.fileName;
        nameEl.style.cssText =
          "font-size:10px;font-weight:500;color:var(--text-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
        info.appendChild(nameEl);

        const sub = doc.createElement("div");
        sub.style.cssText =
          "font-size:9px;color:" +
          (d.error ? "#dc2626" : "var(--text-tertiary)") +
          ";";
        sub.textContent = d.error
          ? d.error.substring(0, 100)
          : `${d.charCount.toLocaleString()} chars extracted`;
        info.appendChild(sub);
        row.appendChild(info);

        const removeBtn = doc.createElement("button");
        removeBtn.textContent = "\u00d7";
        removeBtn.style.cssText =
          "width:20px;height:20px;border:none;background:transparent;color:var(--text-tertiary);cursor:pointer;font-size:14px;border-radius:3px;display:flex;align-items:center;justify-content:center;flex-shrink:0;";
        removeBtn.addEventListener("click", () => {
          uploadedDocs.splice(idx, 1);
          refreshFileList();
          if (uploadedDocs.length === 0) refreshDropZone();
        });
        row.appendChild(removeBtn);
        fileList.appendChild(row);
      });
    }

    // Analysis progress area
    const progressContainer = doc.createElement("div");
    progressContainer.style.cssText = "margin-bottom:10px;display:none;";
    container.appendChild(progressContainer);

    function buildStepRow(
      label: string,
      progress: AnalysisProgress,
    ): HTMLElement {
      const row = doc.createElement("div");
      row.style.cssText =
        "display:flex;align-items:flex-start;gap:8px;padding:6px 0;";

      const statusIcon = doc.createElement("span");
      statusIcon.style.cssText =
        "width:20px;height:20px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;font-size:10px;flex-shrink:0;margin-top:1px;";
      if (progress.status === "pending") {
        statusIcon.style.cssText +=
          "border:2px solid var(--border-secondary);color:var(--text-tertiary);";
        statusIcon.textContent = "\u25CB";
      } else if (progress.status === "running") {
        statusIcon.style.cssText +=
          "border:2px solid #7c3aed;color:#7c3aed;animation:sr-pulse 1.2s infinite;";
        statusIcon.textContent = "\u25CF";
      } else if (progress.status === "complete") {
        statusIcon.style.cssText +=
          "background:#16a34a;color:#fff;border:2px solid #16a34a;";
        statusIcon.replaceChildren(
          createSvgIcon(statusIcon.ownerDocument!, ICONS.check, "done", 14),
        );
      } else {
        statusIcon.style.cssText +=
          "background:#dc2626;color:#fff;border:2px solid #dc2626;";
        statusIcon.textContent = "!";
      }

      row.appendChild(statusIcon);

      const content = doc.createElement("div");
      content.style.cssText = "flex:1;min-width:0;";
      const titleEl = doc.createElement("div");
      titleEl.textContent = label;
      titleEl.style.cssText =
        "font-size:10px;font-weight:600;color:var(--text-primary);";
      content.appendChild(titleEl);

      if (progress.status === "complete" && progress.result) {
        const detail = doc.createElement("div");
        detail.style.cssText =
          "font-size:9px;color:var(--text-secondary);margin-top:1px;line-height:1.3;";
        if ((progress.result as any).framework) {
          detail.textContent =
            "Detected: " +
            (progress.result as any).framework +
            " — " +
            (progress.result as any).reason;
        } else if ((progress.result as any).fields) {
          const flds = (progress.result as any).fields as Record<
            string,
            string
          >;
          const kv = Object.entries(flds)
            .filter(([, v]) => v)
            .slice(0, 3)
            .map(([k, v]) => `${k}: ${v.substring(0, 60)}`)
            .join("; ");
          detail.textContent = kv || "No criteria found in document";
        } else if ((progress.result as any).incKeywords) {
          const kr = progress.result as any;
          detail.textContent =
            "Include: " +
            (kr.incKeywords as string[]).slice(0, 4).join(", ") +
            " | Exclude: " +
            (kr.excKeywords as string[]).slice(0, 3).join(", ");
        }
        content.appendChild(detail);
      } else if (progress.status === "error" && progress.error) {
        const errEl = doc.createElement("div");
        errEl.textContent = progress.error.substring(0, 120);
        errEl.style.cssText = "font-size:9px;color:#dc2626;margin-top:1px;";
        content.appendChild(errEl);
      } else if (progress.status === "running") {
        const loadingEl = doc.createElement("div");
        loadingEl.textContent = "Analyzing...";
        loadingEl.style.cssText = "font-size:9px;color:#7c3aed;margin-top:1px;";
        content.appendChild(loadingEl);
      }

      row.appendChild(content);
      return row;
    }

    function refreshProgress(): void {
      while (progressContainer.firstChild)
        progressContainer.removeChild(progressContainer.firstChild);
      const steps = [
        buildStepRow("Step 1: Framework Detection", analysisProgress[0]),
        buildStepRow("Step 2: Field Extraction", analysisProgress[1]),
        buildStepRow("Step 3: Keywords & Labels", analysisProgress[2]),
      ];
      steps.forEach((s) => progressContainer.appendChild(s));
    }

    // Action buttons
    const actionRow = doc.createElement("div");
    actionRow.style.cssText = "display:flex;gap:8px;margin-top:6px;";
    container.appendChild(actionRow);

    function refreshActions(): void {
      while (actionRow.firstChild) actionRow.removeChild(actionRow.firstChild);

      if (!analysisResults && !isAnalyzing) {
        const analyzeBtn = doc.createElement("button");
        analyzeBtn.textContent = "Analyze with AI";
        analyzeBtn.disabled = uploadedDocs.length === 0;
        analyzeBtn.style.cssText =
          "padding:4px 12px;font-size:11px;font-weight:600;border:none;border-radius:4px;cursor:pointer;font-family:inherit;" +
          (uploadedDocs.length === 0
            ? "background:var(--background-tertiary);color:var(--text-tertiary);cursor:not-allowed;"
            : "background:#7c3aed;color:#fff;");
        analyzeBtn.addEventListener("click", async () => {
          if (uploadedDocs.length === 0 || isAnalyzing) return;
          const validDocs = uploadedDocs.filter((d) => !d.error);
          if (validDocs.length === 0) {
            toast(doc, "No valid documents to analyze");
            return;
          }

          isAnalyzing = true;
          analysisProgress[0] = { step: 1, status: "pending" };
          analysisProgress[1] = { step: 2, status: "pending" };
          analysisProgress[2] = { step: 3, status: "pending" };
          analysisResults = undefined;
          progressContainer.style.display = "block";
          refreshProgress();
          refreshActions();

          try {
            const results = await analyzeDocuments(validDocs, (prog) => {
              analysisProgress[0] = prog[0];
              analysisProgress[1] = prog[1];
              analysisProgress[2] = prog[2];
              refreshProgress();
              refreshActions();
            });
            analysisResults = results;
          } catch (e) {
            Zotero.debug(`[seerai] SR import analysis error: ${e}`);
          } finally {
            isAnalyzing = false;
            refreshProgress();
            refreshActions();
          }
        });
        actionRow.appendChild(analyzeBtn);
      }

      if (isAnalyzing) {
        const spinner = doc.createElement("span");
        spinner.textContent = "Analyzing...";
        spinner.style.cssText =
          "font-size:10px;color:var(--text-tertiary);padding:4px 8px;";
        actionRow.appendChild(spinner);
        return;
      }

      if (analysisResults) {
        const applyBtn = doc.createElement("button");
        applyBtn.textContent = "Apply to Criteria";
        applyBtn.style.cssText =
          "padding:4px 12px;font-size:11px;font-weight:600;border:none;border-radius:4px;cursor:pointer;font-family:inherit;background:#16a34a;color:#fff;";
        applyBtn.addEventListener("click", () => {
          const sp = getActiveSpace();
          if (!sp || !analysisResults) return;

          sp.framework = analysisResults.framework;
          sp.frameworkValues = {};
          Object.entries(analysisResults.fields).forEach(([k, v]) => {
            sp.frameworkValues[k] = v;
          });
          sp.incKeywords.length = 0;
          analysisResults.incKeywords.forEach((k) => sp.incKeywords.push(k));
          sp.excKeywords.length = 0;
          analysisResults.excKeywords.forEach((k) => sp.excKeywords.push(k));
          saveSRState();
          toast(
            doc,
            `Applied ${analysisResults.framework} criteria with ${analysisResults.incKeywords.length} include and ${analysisResults.excKeywords.length} exclude keywords`,
          );
          onApply();
        });
        actionRow.appendChild(applyBtn);

        const redoBtn = doc.createElement("button");
        redoBtn.textContent = "Re-analyze";
        redoBtn.style.cssText =
          "padding:4px 12px;font-size:11px;border:1px solid var(--border-primary);border-radius:4px;cursor:pointer;font-family:inherit;background:transparent;color:var(--text-secondary);";
        redoBtn.addEventListener("click", () => {
          analysisResults = undefined;
          progressContainer.style.display = "none";
          refreshActions();
        });
        actionRow.appendChild(redoBtn);
      }
    }

    refreshActions();

    async function openFilePicker(): Promise<void> {
      try {
        const win = Zotero.getMainWindow() as any;
        const fp = new win.FilePicker();
        fp.init(win, "Import Research Document", fp.modeOpen);
        fp.appendFilter("Documents", "*.pdf;*.md;*.markdown;*.txt;*.docx");
        fp.appendFilters(fp.filterAll);

        const result = await fp.show();
        if (result !== fp.returnOK) return;
        const filePath = fp.file;
        if (!filePath) return;

        if (uploadedDocs.length > 0) dropZoneWrapper.style.display = "none";

        toast(doc, "Extracting text from " + filePath.split(/[/\\]/).pop());
        const doc2 = await extractDocumentContent(filePath);
        uploadedDocs.push(doc2);
        refreshFileList();
        refreshActions();
      } catch (e) {
        Zotero.debug(`[seerai] SR import file picker error: ${e}`);
        toast(doc, "Failed to open file");
      }
    }
  }

  renderTabs();
  modal.appendChild(tabBar);
  modal.appendChild(tabBody);

  // Footer
  const mfoot = doc.createElement("div");
  mfoot.style.cssText =
    "padding:10px 16px;border-top:1px solid var(--border-primary);display:flex;gap:8px;justify-content:space-between;flex-shrink:0;";
  const resetBtn = doc.createElement("button");
  resetBtn.textContent = "Reset defaults";
  resetBtn.style.cssText =
    "padding:3px 12px;font-size:11px;border:1px solid var(--border-primary);border-radius:4px;background:transparent;color:var(--text-secondary);cursor:pointer;font-family:inherit;";
  resetBtn.addEventListener("click", () => {
    if (!space || !currentState) return;
    space.framework = "PICOTS";
    space.frameworkValues = { P: "", I: "", C: "", O: "", T: "", S: "" };
    space.incKeywords = ["randomized", "trial", "controlled"];
    space.excKeywords = ["observational", "case report"];
    saveSRState();
    toast(doc, "Reset to defaults");
    const p = wrapper.parentElement;
    if (p) p.removeChild(wrapper);
  });
  mfoot.appendChild(resetBtn);
  const btnGroup = doc.createElement("div");
  btnGroup.style.cssText = "display:flex;gap:8px;";
  const cancelBtn2 = doc.createElement("button");
  cancelBtn2.textContent = "Cancel";
  cancelBtn2.style.cssText =
    "padding:3px 12px;font-size:11px;border:1px solid var(--border-primary);border-radius:4px;background:transparent;color:var(--text-secondary);cursor:pointer;font-family:inherit;";
  cancelBtn2.addEventListener("click", () => {
    doClose();
  });
  btnGroup.appendChild(cancelBtn2);
  const saveBtn = doc.createElement("button");
  saveBtn.textContent = "Save Criteria";
  saveBtn.style.cssText =
    "padding:3px 12px;font-size:11px;border:1px solid var(--highlight-primary);border-radius:4px;background:var(--highlight-primary);color:#fff;cursor:pointer;font-family:inherit;font-weight:600;";
  saveBtn.addEventListener("click", () => {
    const space2 = getActiveSpace();
    if (space2) {
      space2.picoLabelMap = { ...picoLabelMap };
    }
    saveSRState();
    toast(doc, "Criteria saved");
    reRenderPanel(doc, "screening");
    const p = wrapper.parentElement;
    if (p) p.removeChild(wrapper);
  });
  btnGroup.appendChild(saveBtn);
  mfoot.appendChild(btnGroup);
  modal.appendChild(mfoot);
  mountReviewSheet(doc, wrapper);
}

// ============================================================
// SOURCES / IMPORT FOLDERS MODAL
// ============================================================

interface ManualSourceLabelEntry {
  label: string;
  paperIds: number[];
  sourceType?: "Database" | "Register" | "Other source";
}

function collectManualSourceLabels(
  state: SystematicReviewState,
): ManualSourceLabelEntry[] {
  const grouped = new Map<
    string,
    {
      paperIds: number[];
      sourceType?: "Database" | "Register" | "Other source";
    }
  >();
  for (const paper of state.papers) {
    if (!paper.sourceLabel) continue;
    if (paper.folderId) continue;
    const entry = grouped.get(paper.sourceLabel) || {
      paperIds: [],
      sourceType: paper.sourceType,
    };
    entry.paperIds.push(paper.id);
    if (!entry.sourceType && paper.sourceType) {
      entry.sourceType = paper.sourceType;
    }
    grouped.set(paper.sourceLabel, entry);
  }
  return Array.from(grouped.entries())
    .map(([label, { paperIds, sourceType }]) => ({
      label,
      paperIds,
      sourceType,
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

function renameManualSourceLabel(
  state: SystematicReviewState,
  oldLabel: string,
  newLabel: string,
): void {
  for (const paper of state.papers) {
    if (paper.sourceLabel === oldLabel) {
      paper.sourceLabel = newLabel;
    }
  }
}
async function openSourcesModal(doc: Document): Promise<void> {
  if (!currentState) return;
  const persisted = new Map(
    currentState.folders
      .filter((folder) => folder.zoteroCollectionId)
      .map((folder) => [folder.zoteroCollectionId!, folder]),
  );
  const selected = new Map<string, SRFolderConfig>(
    currentState.folders.map((folder) => [
      folder.id,
      JSON.parse(JSON.stringify(folder)) as SRFolderConfig,
    ]),
  );
  let libraries: Awaited<ReturnType<typeof discoverZoteroCollectionTree>> = [];
  let discoveryError = "";
  try {
    const discoveryWarnings: string[] = [];
    libraries = await discoverZoteroCollectionTree((warning) => {
      discoveryWarnings.push(warning);
    });
    discoveryError = discoveryWarnings.join("\n");
  } catch (error) {
    discoveryError = error instanceof Error ? error.message : String(error);
  }
  const discoveredIds = new Set<number>();
  for (const library of libraries) {
    const visit = (nodes: ZoteroCollectionTreeNode[]) => {
      for (const node of nodes) {
        discoveredIds.add(node.id);
        const existing = persisted.get(node.id);
        if (existing && selected.has(existing.id)) {
          selected.set(
            existing.id,
            sourceConfigFromCollection(node, library.name, existing),
          );
        }
        visit(node.children);
      }
    };
    visit(library.collections);
  }
  for (const source of selected.values()) {
    if (
      source.zoteroCollectionId &&
      !discoveredIds.has(source.zoteroCollectionId)
    ) {
      source.available = false;
    }
  }

  const wrapper = doc.createElement("div");
  wrapper.style.cssText =
    "position:fixed;inset:0;background:rgba(15,23,42,.5);z-index:1000;display:flex;align-items:center;justify-content:center;padding:16px;overflow:auto;";
  const modal = doc.createElement("div");
  modal.style.cssText =
    "width:940px;max-width:96vw;height:min(760px,calc(100vh - 32px));min-height:360px;display:flex;flex-direction:column;overflow:hidden;border:1px solid var(--border-primary);border-radius:12px;background:var(--background-primary);box-shadow:0 18px 50px rgba(0,0,0,.28);";
  wrapper.appendChild(modal);
  const header = doc.createElement("div");
  header.style.cssText =
    "display:flex;align-items:center;justify-content:space-between;padding:14px 18px;border-bottom:1px solid var(--border-primary);background:var(--background-secondary);flex:0 0 auto;";
  const title = doc.createElement("div");
  title.textContent = "Add Zotero Folders";
  title.style.cssText = "font-size:17px;font-weight:700;";
  header.appendChild(title);
  const close = doc.createElement("button");
  close.textContent = "\u00d7";
  close.style.cssText =
    "border:none;background:transparent;font-size:20px;color:var(--text-secondary);cursor:pointer;";
  close.addEventListener("click", () => wrapper.remove());
  header.appendChild(close);
  modal.appendChild(header);

  const help = doc.createElement("div");
  help.textContent =
    "Select folders from personal or group libraries. Configure how each folder should be reported as a review source.";
  help.style.cssText =
    "padding:9px 18px;border-bottom:1px solid var(--border-secondary);font-size:12px;color:var(--text-secondary);flex:0 0 auto;";
  modal.appendChild(help);

  const content = doc.createElement("div");
  content.style.cssText =
    "display:grid;grid-template-columns:minmax(260px,38%) minmax(0,1fr);flex:1 1 auto;min-height:0;overflow:hidden;";
  modal.appendChild(content);
  const browser = doc.createElement("div");
  browser.style.cssText =
    "display:flex;flex-direction:column;min-width:0;min-height:0;overflow:hidden;border-right:1px solid var(--border-secondary);";
  const search = doc.createElement("input");
  search.placeholder = "Search folders";
  search.style.cssText =
    "margin:10px;padding:8px 10px;border:1px solid var(--border-primary);border-radius:6px;background:var(--background-primary);color:var(--text-primary);font:inherit;font-size:12px;";
  browser.appendChild(search);
  const tree = doc.createElement("div");
  tree.style.cssText =
    "flex:1 1 auto;min-height:0;overflow-x:hidden;overflow-y:auto;padding:0 8px 10px;scrollbar-gutter:stable;";
  browser.appendChild(tree);
  content.appendChild(browser);
  const configuration = doc.createElement("div");
  configuration.style.cssText =
    "min-width:0;min-height:0;overflow-x:hidden;overflow-y:auto;padding:12px 14px;scrollbar-gutter:stable;";
  content.appendChild(configuration);
  if ((doc.defaultView?.innerWidth || 0) < 700) {
    content.style.gridTemplateColumns = "1fr";
    content.style.gridTemplateRows = "minmax(160px,45%) minmax(0,1fr)";
    browser.style.borderRight = "none";
    browser.style.borderBottom = "1px solid var(--border-secondary)";
  }

  const flatten = (
    nodes: ZoteroCollectionTreeNode[],
    depth = 0,
  ): { node: ZoteroCollectionTreeNode; depth: number }[] =>
    nodes.flatMap((node) => [
      { node, depth },
      ...flatten(node.children, depth + 1),
    ]);
  let selectedCount: HTMLElement | null = null;
  const updateSelectedCount = () => {
    if (!selectedCount) return;
    selectedCount.textContent = `${selected.size} folder${selected.size === 1 ? "" : "s"} selected`;
  };

  const renderConfiguration = () => {
    configuration.replaceChildren();
    const manualLabels = collectManualSourceLabels(currentState!);
    if (manualLabels.length > 0) {
      const manualSection = doc.createElement("div");
      manualSection.style.cssText =
        "margin-bottom:14px;padding:10px 12px;border:1px solid var(--border-secondary);border-radius:8px;background:var(--background-secondary);";
      const manualHeading = doc.createElement("div");
      manualHeading.textContent = "Manual source labels";
      manualHeading.style.cssText =
        "font-size:13px;font-weight:700;margin-bottom:4px;";
      manualSection.appendChild(manualHeading);
      const manualHelp = doc.createElement("div");
      manualHelp.textContent =
        "These labels were created when you added papers without linking a Zotero folder. Rename a label to update every paper that uses it.";
      manualHelp.style.cssText =
        "font-size:11px;color:var(--text-tertiary);margin-bottom:8px;line-height:1.4;";
      manualSection.appendChild(manualHelp);
      manualLabels.forEach((entry) => {
        const card = doc.createElement("div");
        card.style.cssText =
          "padding:11px 12px;margin-bottom:9px;border:1px solid var(--border-secondary);border-radius:8px;background:var(--background-primary);";
        const cardTitle = doc.createElement("div");
        cardTitle.textContent = entry.label;
        cardTitle.style.cssText =
          "font-size:13px;font-weight:700;margin-bottom:8px;";
        card.appendChild(cardTitle);
        const fields = doc.createElement("div");
        fields.style.cssText =
          "display:grid;grid-template-columns:150px 1fr;gap:8px;";
        const typeSelect = doc.createElement("select");
        typeSelect.style.cssText =
          "padding:6px;border:1px solid var(--border-primary);border-radius:5px;font:inherit;font-size:12px;background:var(--background-primary);color:var(--text-primary);";
        const optionPlaceholder = doc.createElement("option");
        optionPlaceholder.value = "";
        optionPlaceholder.textContent = "Source type…";
        typeSelect.appendChild(optionPlaceholder);
        (["Database", "Register", "Other source"] as const).forEach((value) => {
          const option = doc.createElement("option");
          option.value = value;
          option.textContent = value;
          if (entry.sourceType === value) option.selected = true;
          typeSelect.appendChild(option);
        });
        typeSelect.addEventListener("change", async () => {
          const value = typeSelect.value as
            | ""
            | "Database"
            | "Register"
            | "Other source";
          getSRService().setManualSourceType(
            currentState!,
            entry.label,
            value || undefined,
          );
          await getSRService().save(currentState!);
        });
        fields.appendChild(typeSelect);
        const labelInput = doc.createElement("input");
        labelInput.value = entry.label;
        labelInput.placeholder = "Source label";
        labelInput.style.cssText =
          "padding:6px 8px;border:1px solid var(--border-primary);border-radius:5px;font:inherit;font-size:12px;background:var(--background-primary);color:var(--text-primary);";
        labelInput.addEventListener("change", async () => {
          const trimmed = labelInput.value.trim();
          if (!trimmed || trimmed === entry.label) {
            labelInput.value = entry.label;
            return;
          }
          renameManualSourceLabel(currentState!, entry.label, trimmed);
          await getSRService().save(currentState!);
          renderConfiguration();
        });
        fields.appendChild(labelInput);
        card.appendChild(fields);
        const count = doc.createElement("div");
        count.textContent = `${entry.paperIds.length} paper${entry.paperIds.length === 1 ? "" : "s"}`;
        count.style.cssText =
          "margin-top:8px;font-size:11px;color:var(--text-tertiary);";
        card.appendChild(count);
        manualSection.appendChild(card);
      });
      configuration.appendChild(manualSection);
    }
    const configs = Array.from(selected.values());
    if (configs.length === 0 && manualLabels.length === 0) {
      const empty = doc.createElement("div");
      empty.textContent =
        "Select one or more folders to configure their source attribution, or add papers with manual source labels.";
      empty.style.cssText =
        "padding:40px 20px;text-align:center;color:var(--text-tertiary);font-size:12px;";
      configuration.appendChild(empty);
      return;
    }
    configs
      .sort((a, b) =>
        (a.collectionPath || a.name).localeCompare(b.collectionPath || b.name),
      )
      .forEach((source) => {
        const card = doc.createElement("div");
        card.style.cssText =
          "padding:11px 12px;margin-bottom:9px;border:1px solid var(--border-secondary);border-radius:8px;";
        const cardTitle = doc.createElement("div");
        cardTitle.textContent = source.collectionPath || source.name;
        cardTitle.style.cssText =
          "font-size:13px;font-weight:700;margin-bottom:8px;";
        card.appendChild(cardTitle);
        if (!source.available) {
          const unavailable = doc.createElement("div");
          unavailable.textContent =
            "Folder is currently unavailable. Existing source records will be retained.";
          unavailable.style.cssText =
            "padding:6px 8px;margin-bottom:8px;border-radius:5px;background:#fef3c7;color:#854d0e;font-size:11px;";
          card.appendChild(unavailable);
        }
        const fields = doc.createElement("div");
        fields.style.cssText =
          "display:grid;grid-template-columns:150px 1fr;gap:8px;";
        const type = doc.createElement("select");
        type.style.cssText =
          "padding:6px;border:1px solid var(--border-primary);border-radius:5px;font:inherit;font-size:12px;";
        (["Database", "Register", "Other source"] as const).forEach((value) => {
          const option = doc.createElement("option");
          option.value = value;
          option.textContent = value;
          option.selected = source.type === value;
          type.appendChild(option);
        });
        type.addEventListener("change", () => {
          source.type = type.value as SRFolderConfig["type"];
        });
        fields.appendChild(type);
        const label = doc.createElement("input");
        label.value = source.srcLabel;
        label.placeholder = "Source label, e.g. PubMed";
        label.style.cssText =
          "padding:6px 8px;border:1px solid var(--border-primary);border-radius:5px;font:inherit;font-size:12px;";
        label.addEventListener("input", () => {
          source.srcLabel = label.value;
        });
        fields.appendChild(label);
        card.appendChild(fields);
        const recursiveLabel = doc.createElement("label");
        recursiveLabel.style.cssText =
          "display:flex;align-items:center;gap:7px;margin-top:9px;font-size:12px;";
        const recursive = doc.createElement("input");
        recursive.type = "checkbox";
        recursive.checked = source.includeSubfolders;
        recursive.disabled = !source.available;
        recursive.addEventListener("change", () => {
          source.includeSubfolders = recursive.checked;
        });
        recursiveLabel.appendChild(recursive);
        recursiveLabel.append("Include subfolders");
        card.appendChild(recursiveLabel);
        configuration.appendChild(card);
      });
  };

  const renderTree = () => {
    tree.replaceChildren();
    if (discoveryError) {
      const error = doc.createElement("div");
      error.textContent = `Could not read Zotero folders: ${discoveryError}`;
      error.style.cssText = "padding:16px;color:#b91c1c;font-size:12px;";
      tree.appendChild(error);
    }
    const query = search.value.trim().toLowerCase();
    let visibleCount = 0;
    for (const library of libraries) {
      const rows = flatten(library.collections).filter(({ node }) =>
        query
          ? `${node.name} ${node.path}`.toLowerCase().includes(query)
          : true,
      );
      if (rows.length === 0) continue;
      visibleCount += rows.length;
      const libraryHeading = doc.createElement("div");
      libraryHeading.textContent = `${library.type === "group" ? "Group" : "Library"} · ${library.name}`;
      libraryHeading.style.cssText =
        "padding:8px 6px 4px;font-size:10px;font-weight:700;text-transform:uppercase;color:var(--text-tertiary);";
      tree.appendChild(libraryHeading);
      rows.forEach(({ node, depth }) => {
        const existing = persisted.get(node.id);
        const id = existing?.id || `col_${node.id}`;
        const row = doc.createElement("label");
        row.style.cssText = `display:flex;align-items:center;gap:7px;padding:6px 7px 6px ${8 + depth * 16}px;border-radius:5px;font-size:12px;cursor:pointer;`;
        const checkbox = doc.createElement("input");
        checkbox.type = "checkbox";
        checkbox.checked = selected.has(id);
        checkbox.addEventListener("change", () => {
          if (checkbox.checked) {
            selected.set(
              id,
              sourceConfigFromCollection(node, library.name, existing),
            );
          } else {
            selected.delete(id);
          }
          updateSelectedCount();
          renderTree();
          renderConfiguration();
        });
        row.appendChild(checkbox);
        const name = doc.createElement("span");
        name.textContent = node.name;
        name.style.cssText =
          "flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
        row.appendChild(name);
        const count = doc.createElement("span");
        count.textContent = String(node.directItemCount);
        count.style.color = "var(--text-tertiary)";
        row.appendChild(count);
        tree.appendChild(row);
      });
    }
    const unavailable = Array.from(selected.values()).filter(
      (source) => !source.available,
    );
    if (unavailable.length > 0) {
      const heading = doc.createElement("div");
      heading.textContent = "Unavailable saved folders";
      heading.style.cssText =
        "padding:10px 6px 4px;font-size:10px;font-weight:700;text-transform:uppercase;color:#b45309;";
      tree.appendChild(heading);
      unavailable.forEach((source) => {
        const row = doc.createElement("label");
        row.style.cssText =
          "display:flex;align-items:center;gap:7px;padding:6px 7px;font-size:12px;color:#92400e;";
        const checkbox = doc.createElement("input");
        checkbox.type = "checkbox";
        checkbox.checked = true;
        checkbox.addEventListener("change", () => {
          if (!checkbox.checked) selected.delete(source.id);
          updateSelectedCount();
          renderTree();
          renderConfiguration();
        });
        row.appendChild(checkbox);
        row.append(source.collectionPath || source.name);
        tree.appendChild(row);
      });
    }
    if (visibleCount === 0 && unavailable.length === 0 && !discoveryError) {
      const empty = doc.createElement("div");
      empty.textContent = query
        ? "No folders match this search."
        : "No Zotero folders are available in personal or group libraries.";
      empty.style.cssText =
        "padding:24px;text-align:center;color:var(--text-tertiary);font-size:12px;";
      tree.appendChild(empty);
    }
  };
  search.addEventListener("input", renderTree);
  renderTree();
  renderConfiguration();

  const footer = doc.createElement("div");
  footer.style.cssText =
    "display:flex;align-items:center;justify-content:space-between;padding:10px 16px;border-top:1px solid var(--border-primary);background:var(--background-secondary);flex:0 0 auto;";
  selectedCount = doc.createElement("span");
  updateSelectedCount();
  selectedCount.style.cssText = "font-size:11px;color:var(--text-secondary);";
  footer.appendChild(selectedCount);
  const actions = doc.createElement("div");
  actions.style.cssText = "display:flex;gap:8px;";
  const cancel = doc.createElement("button");
  cancel.textContent = "Cancel";
  cancel.style.cssText =
    "padding:6px 12px;border:1px solid var(--border-primary);border-radius:5px;background:var(--background-primary);color:var(--text-secondary);font:inherit;font-size:12px;cursor:pointer;";
  cancel.addEventListener("click", () => wrapper.remove());
  actions.appendChild(cancel);
  const save = doc.createElement("button");
  save.textContent = "Save and Sync Folders";
  save.style.cssText =
    "padding:6px 12px;border:1px solid var(--highlight-primary);border-radius:5px;background:var(--highlight-primary);color:white;font:inherit;font-size:12px;font-weight:700;cursor:pointer;";
  save.addEventListener("click", async () => {
    if (!currentState) return;
    const missingLabels = Array.from(selected.values()).filter(
      (source) => !source.srcLabel.trim(),
    );
    if (missingLabels.length > 0) {
      toast(doc, "Every selected folder requires a source label");
      return;
    }
    save.disabled = true;
    save.textContent = "Synchronizing...";
    try {
      const inputs = await Promise.all(
        Array.from(selected.values()).map(async (source) => ({
          source,
          records: source.available ? await collectSourceRecords(source) : [],
        })),
      );
      const result = getSRService().syncSources(currentState, inputs);
      const activeSpace = getActiveSpace();
      if (
        activeSpace &&
        activeSpace.activeFolderId !== "all" &&
        !selected.has(activeSpace.activeFolderId)
      ) {
        activeSpace.activeFolderId = "all";
      }
      _srPaperIdSet.clear();
      currentState.papers.forEach((paper) => _srPaperIdSet.add(paper.id));
      await getSRService().save(currentState);
      wrapper.remove();
      toast(
        doc,
        `${result.addedPapers.length} added, ${result.removedPapers.length} removed, ${result.overlappingPapers.length} overlapping`,
      );
      reRender(doc);
    } catch (error) {
      save.disabled = false;
      save.textContent = "Save and Sync Folders";
      toast(doc, `Folder sync failed: ${(error as Error).message}`);
    }
  });
  actions.appendChild(save);
  footer.appendChild(actions);
  modal.appendChild(footer);
  wrapper.addEventListener("click", (event) => {
    if (event.target === wrapper) wrapper.remove();
  });
  mountReviewSheet(doc, wrapper);
}

function openLegacySourcesModal(_doc: Document): void {
  const doc = _doc;
  if (!currentState) return;

  // Deep-clone folders for editing
  const editFolders: any[] = currentState.folders.map((f: any) => ({
    ...f,
  }));

  // Populate from Zotero collections if state has no folders
  if (editFolders.length === 0) {
    try {
      const libId = Zotero.Libraries.userLibraryID;
      const zCollections: any[] = Zotero.Collections.getByLibrary(libId) || [];
      for (let ci = 0; ci < zCollections.length; ci++) {
        const col = zCollections[ci];
        const libName = col.library ? col.library.name : "My Library";
        const items = Zotero.Items.getByCollection(col.id) || [];
        editFolders.push({
          id: "col_" + col.id,
          name: col.name || "Untitled",
          parent: libName || "My Library",
          type: "Database" as const,
          srcLabel: "",
          itemCount: items.length,
          active: false,
          zoteroCollectionId: col.id,
        });
      }
    } catch (e) {
      Zotero.debug(
        `[seerai] SR sources modal: could not get collections: ${e}`,
      );
    }
  }
  const editSelected = new Set<string>(
    currentState.selectedFolderIds.length > 0
      ? currentState.selectedFolderIds
      : editFolders.map((f: any) => f.id),
  );
  let editActiveFolderId = getActiveSpace()?.activeFolderId || "all";

  const wrapper = doc.createElement("div");
  wrapper.style.cssText =
    "position:fixed;inset:0;background:rgba(0,0,0,0.45);z-index:1000;display:flex;align-items:center;justify-content:center;";
  wrapper.addEventListener("click", (e: Event) => {
    if (e.target === wrapper) {
      const p = wrapper.parentElement;
      if (p) p.removeChild(wrapper);
    }
  });

  const modal = doc.createElement("div");
  modal.style.cssText =
    "background:var(--background-primary);border:1px solid var(--border-primary);border-radius:12px;width:820px;max-width:95vw;max-height:90vh;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 12px 48px rgba(0,0,0,0.25);";
  wrapper.appendChild(modal);

  // Header
  const mhdr = doc.createElement("div");
  mhdr.style.cssText =
    "display:flex;align-items:center;justify-content:space-between;padding:12px 16px;border-bottom:1px solid var(--border-primary);background:var(--background-secondary);flex-shrink:0;";
  const mtitle = doc.createElement("div");
  mtitle.textContent = "Import Folders & Define Sources";
  mtitle.style.cssText =
    "font-size:15px;font-weight:700;color:var(--text-primary);";
  mhdr.appendChild(mtitle);
  const closeBtn = doc.createElement("button");
  closeBtn.textContent = "\u00d7";
  closeBtn.style.cssText =
    "width:28px;height:28px;border:none;background:transparent;color:var(--text-secondary);cursor:pointer;font-size:18px;border-radius:4px;display:flex;align-items:center;justify-content:center;";
  closeBtn.addEventListener("click", () => {
    const p = wrapper.parentElement;
    if (p) p.removeChild(wrapper);
  });
  mhdr.appendChild(closeBtn);
  modal.appendChild(mhdr);

  // Description
  const desc = doc.createElement("div");
  desc.textContent =
    "Select Zotero folders to include in your screening workflow. For each selected folder, specify its source type and database name (used to generate the PRISMA flow diagram).";
  desc.style.cssText =
    "padding:8px 16px;border-bottom:1px solid var(--border-secondary);font-size:10px;color:var(--text-tertiary);line-height:1.5;flex-shrink:0;";
  modal.appendChild(desc);

  // Body: two columns
  const bodyWrap = doc.createElement("div");
  bodyWrap.style.cssText = "display:flex;flex:1;min-height:0;overflow:hidden;";

  // Left: folder tree
  const leftPanel = doc.createElement("div");
  leftPanel.style.cssText =
    "width:280px;border-right:1px solid var(--border-secondary);display:flex;flex-direction:column;overflow:hidden;";
  const treeHdr = doc.createElement("div");
  treeHdr.style.cssText =
    "padding:8px 12px;border-bottom:1px solid var(--border-secondary);display:flex;align-items:center;justify-content:space-between;";
  const treeTitle = doc.createElement("div");
  treeTitle.textContent = "Zotero Library";
  treeTitle.style.cssText =
    "font-size:11px;font-weight:600;color:var(--text-primary);";
  treeHdr.appendChild(treeTitle);
  const treeCount = doc.createElement("span");
  treeCount.style.cssText = "font-size:9px;color:var(--text-tertiary);";
  treeCount.textContent = editSelected.size + " folders selected";
  treeHdr.appendChild(treeCount);
  leftPanel.appendChild(treeHdr);
  const treeBody = doc.createElement("div");
  treeBody.style.cssText = "flex:1;overflow-y:auto;padding:4px;";
  leftPanel.appendChild(treeBody);
  bodyWrap.appendChild(leftPanel);

  // Right: source config
  const rightPanel = doc.createElement("div");
  rightPanel.style.cssText =
    "flex:1;display:flex;flex-direction:column;overflow:hidden;";
  const cfgHdr = doc.createElement("div");
  cfgHdr.style.cssText =
    "padding:8px 12px;border-bottom:1px solid var(--border-secondary);";
  const cfgTitle = doc.createElement("div");
  cfgTitle.textContent = "Source Configuration";
  cfgTitle.style.cssText =
    "font-size:11px;font-weight:600;color:var(--text-primary);";
  cfgHdr.appendChild(cfgTitle);
  const cfgSub = doc.createElement("div");
  cfgSub.textContent = "Set source type & label for each selected folder";
  cfgSub.style.cssText = "font-size:9px;color:var(--text-tertiary);";
  cfgHdr.appendChild(cfgSub);
  rightPanel.appendChild(cfgHdr);
  const cfgList = doc.createElement("div");
  cfgList.style.cssText = "flex:1;overflow-y:auto;padding:8px;";
  rightPanel.appendChild(cfgList);
  bodyWrap.appendChild(rightPanel);
  modal.appendChild(bodyWrap);

  // Render folder tree
  function renderTree(): void {
    while (treeBody.firstChild) treeBody.removeChild(treeBody.firstChild);
    if (editFolders.length === 0) {
      const empty = doc.createElement("div");
      empty.textContent =
        "No folders found. Add papers to Zotero collections first.";
      empty.style.cssText =
        "padding:16px;text-align:center;color:var(--text-tertiary);font-size:10px;";
      treeBody.appendChild(empty);
      return;
    }
    // Group by parent
    const groups: Record<string, any[]> = {};
    editFolders.forEach((f: any) => {
      const parent = f.parent || "My Library";
      if (!groups[parent]) groups[parent] = [];
      groups[parent].push(f);
    });
    for (const parent in groups) {
      const gDiv = doc.createElement("div");
      gDiv.style.cssText = "margin-bottom:4px;";
      const gHdr = doc.createElement("div");
      gHdr.textContent = parent;
      gHdr.style.cssText =
        "font-size:9px;font-weight:600;color:var(--text-tertiary);text-transform:uppercase;letter-spacing:0.3px;padding:4px 6px;";
      gDiv.appendChild(gHdr);
      groups[parent].forEach((f: any) => {
        const sel = editSelected.has(f.id);
        const isActive = editActiveFolderId === f.id;
        const row = doc.createElement("div");
        row.style.cssText =
          "display:flex;align-items:center;gap:6px;padding:4px 6px;cursor:pointer;border-radius:4px;font-size:10px;" +
          (isActive
            ? "background:var(--highlight-primary);color:#fff;"
            : sel
              ? "background:var(--background-primary);"
              : "");
        const cb = doc.createElement("input") as HTMLInputElement;
        cb.type = "checkbox";
        cb.checked = sel;
        cb.style.cssText =
          "width:12px;height:12px;accent-color:var(--highlight-primary);cursor:pointer;flex-shrink:0;";
        cb.addEventListener("change", () => {
          if (cb.checked) editSelected.add(f.id);
          else editSelected.delete(f.id);
          treeCount.textContent = editSelected.size + " folders selected";
          renderTree();
          renderCfg();
        });
        row.appendChild(cb);
        const icon = doc.createElement("span");
        icon.replaceChildren();
        if (sel)
          icon.appendChild(
            createSvgIcon(icon.ownerDocument!, ICONS.check, "selected", 14),
          );
        icon.style.cssText = "width:12px;font-size:10px;flex-shrink:0;";
        row.appendChild(icon);
        const name = doc.createElement("span");
        name.textContent = f.name;
        name.style.cssText =
          "flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
        row.appendChild(name);
        const cnt = doc.createElement("span");
        cnt.textContent = String(f.itemCount);
        cnt.style.cssText =
          "font-size:8px;color:" +
          (isActive ? "rgba(255,255,255,0.7)" : "var(--text-tertiary)") +
          ";flex-shrink:0;";
        row.appendChild(cnt);
        row.addEventListener("click", (e: Event) => {
          const t = e.target as HTMLElement;
          if (t.tagName === "INPUT") return;
          editActiveFolderId = f.id;
          renderTree();
          renderCfg();
        });
        gDiv.appendChild(row);
      });
      treeBody.appendChild(gDiv);
    }
    treeCount.textContent = editSelected.size + " folders selected";
  }

  // Render source config
  function renderCfg(): void {
    while (cfgList.firstChild) cfgList.removeChild(cfgList.firstChild);
    const selected = editFolders.filter((f: any) => editSelected.has(f.id));
    if (!selected.length) {
      const empty = doc.createElement("div");
      empty.textContent =
        "No folders selected. Check folders in the tree to configure their source settings.";
      empty.style.cssText =
        "padding:24px;text-align:center;color:var(--text-tertiary);font-size:10px;";
      cfgList.appendChild(empty);
      return;
    }
    selected.forEach((f: any) => {
      const item = doc.createElement("div");
      item.style.cssText =
        "padding:8px 10px;margin-bottom:6px;border:1px solid var(--border-secondary);border-radius:6px;";
      const nameRow = doc.createElement("div");
      nameRow.style.cssText =
        "display:flex;align-items:center;gap:6px;margin-bottom:6px;";
      const name = doc.createElement("div");
      name.textContent = f.name;
      name.style.cssText =
        "font-size:11px;font-weight:600;color:var(--text-primary);flex:1;";
      nameRow.appendChild(name);
      const cnt = doc.createElement("span");
      cnt.textContent = f.itemCount + " items";
      cnt.style.cssText = "font-size:9px;color:var(--text-tertiary);";
      nameRow.appendChild(cnt);
      const activeRadio = doc.createElement("input") as HTMLInputElement;
      activeRadio.type = "radio";
      activeRadio.name = "srcActive";
      activeRadio.checked = editActiveFolderId === f.id;
      activeRadio.style.cssText = "cursor:pointer;";
      activeRadio.addEventListener("change", () => {
        editActiveFolderId = f.id;
        renderTree();
        renderCfg();
      });
      nameRow.appendChild(activeRadio);
      const activeLbl = doc.createElement("span");
      activeLbl.textContent = "Active";
      activeLbl.style.cssText =
        "font-size:9px;color:var(--text-secondary);cursor:pointer;";
      activeLbl.addEventListener("click", () => {
        editActiveFolderId = f.id;
        renderTree();
        renderCfg();
      });
      nameRow.appendChild(activeLbl);
      item.appendChild(nameRow);

      const cfgRow = doc.createElement("div");
      cfgRow.style.cssText = "display:flex;gap:8px;align-items:center;";
      const typeLbl = doc.createElement("label");
      typeLbl.textContent = "Type:";
      typeLbl.style.cssText = "font-size:9px;color:var(--text-secondary);";
      cfgRow.appendChild(typeLbl);
      const typeSel = doc.createElement("select") as HTMLSelectElement;
      typeSel.style.cssText =
        "font-size:9px;padding:2px 4px;border:1px solid var(--border-primary);border-radius:3px;font-family:inherit;";
      ["Database", "Register", "Other source"].forEach((t: string) => {
        const o = doc.createElement("option");
        o.value = t;
        o.textContent = t;
        if (f.type === t) o.selected = true;
        typeSel.appendChild(o);
      });
      typeSel.addEventListener("change", () => {
        f.type = typeSel.value;
      });
      cfgRow.appendChild(typeSel);

      const lblLbl = doc.createElement("label");
      lblLbl.textContent = "Label:";
      lblLbl.style.cssText = "font-size:9px;color:var(--text-secondary);";
      cfgRow.appendChild(lblLbl);
      const lblInp = doc.createElement("input") as HTMLInputElement;
      lblInp.type = "text";
      lblInp.value = f.srcLabel;
      lblInp.placeholder = "e.g., PubMed";
      lblInp.style.cssText =
        "flex:1;font-size:9px;padding:2px 6px;border:1px solid var(--border-primary);border-radius:3px;font-family:inherit;";
      lblInp.addEventListener("input", () => {
        f.srcLabel = lblInp.value;
      });
      cfgRow.appendChild(lblInp);
      item.appendChild(cfgRow);
      cfgList.appendChild(item);
    });
  }

  renderTree();
  renderCfg();

  // Footer
  const mfoot = doc.createElement("div");
  mfoot.style.cssText =
    "padding:10px 16px;border-top:1px solid var(--border-primary);display:flex;gap:8px;justify-content:space-between;flex-shrink:0;";
  const resetBtn = doc.createElement("button");
  resetBtn.textContent = "Reset";
  resetBtn.style.cssText =
    "padding:3px 12px;font-size:11px;border:1px solid var(--border-primary);border-radius:4px;background:transparent;color:var(--text-secondary);cursor:pointer;font-family:inherit;";
  resetBtn.addEventListener("click", () => {
    editFolders.length = 0;
    currentState!.folders.forEach((f: any) => editFolders.push({ ...f }));
    editSelected.clear();
    editFolders.forEach((f: any) => editSelected.add(f.id));
    editActiveFolderId = "all";
    renderTree();
    renderCfg();
    toast(doc, "Reset to defaults");
  });
  mfoot.appendChild(resetBtn);
  const btnGroup = doc.createElement("div");
  btnGroup.style.cssText = "display:flex;gap:8px;";
  const cancelBtn3 = doc.createElement("button");
  cancelBtn3.textContent = "Cancel";
  cancelBtn3.style.cssText =
    "padding:3px 12px;font-size:11px;border:1px solid var(--border-primary);border-radius:4px;background:transparent;color:var(--text-secondary);cursor:pointer;font-family:inherit;";
  cancelBtn3.addEventListener("click", () => {
    const p = wrapper.parentElement;
    if (p) p.removeChild(wrapper);
  });
  btnGroup.appendChild(cancelBtn3);
  const saveBtn3 = doc.createElement("button");
  saveBtn3.textContent = "Save & Apply";
  saveBtn3.style.cssText =
    "padding:3px 12px;font-size:11px;border:1px solid var(--highlight-primary);border-radius:4px;background:var(--highlight-primary);color:#fff;cursor:pointer;font-family:inherit;font-weight:600;";
  saveBtn3.addEventListener("click", () => {
    if (!currentState) return;
    currentState.folders = editFolders;
    currentState.selectedFolderIds = Array.from(editSelected);
    const space = getActiveSpace();
    if (space) space.activeFolderId = editActiveFolderId;

    // Import collection items into state.papers
    const existingIds = new Set(
      currentState.papers.map((p: SystematicReviewPaper) => p.id),
    );
    for (const f of editFolders) {
      if (!editSelected.has(f.id) || !f.zoteroCollectionId) continue;
      try {
        const items = Zotero.Items.getByCollection(f.zoteroCollectionId) || [];
        for (const item of items) {
          if (!item.isRegularItem || !item.isRegularItem()) continue;
          if (existingIds.has(item.id)) continue;
          existingIds.add(item.id);
          currentState.papers.push({
            id: item.id,
            status: "undecided" as ScreeningDecision,
            aiStatus: "manual" as const,
            confidence: 0,
            folderId: f.id,
            manualAdded: false,
          });
          _srPaperIdSet.add(item.id);
        }
      } catch (e) {
        Zotero.debug(
          `[seerai] SR sources: failed to import collection ${f.zoteroCollectionId}: ${e}`,
        );
      }
    }

    saveSRState();
    const p = wrapper.parentElement;
    if (p) p.removeChild(wrapper);
    const activeName =
      editFolders.find((f: any) => f.id === editActiveFolderId)?.name || "All";
    toast(doc, "Sources saved. Active folder: " + activeName);
    reRenderPanel(doc, "screening");
  });
  btnGroup.appendChild(saveBtn3);
  mfoot.appendChild(btnGroup);
  modal.appendChild(mfoot);
  mountReviewSheet(doc, wrapper);
}

function applyArticleRowStatusStyles(
  row: HTMLElement,
  paper: SystematicReviewPaper,
): void {
  const isExc = paper.status === "excluded";
  row.style.opacity = isExc ? "0.45" : "";
  const title = row.querySelector(".sr-art-title") as HTMLElement | null;
  if (title) {
    if (isExc) {
      title.style.textDecoration = "line-through";
      title.style.textDecorationColor = "#dc2626";
    } else {
      title.style.textDecoration = "";
      title.style.textDecorationColor = "";
    }
  }
}

function refreshScreeningActiveRow(doc: Document): void {
  if (!contentArea) return;
  const list = contentArea.querySelector(".sr-art-list");
  if (!list) return;
  const rows = Array.from(list.querySelectorAll(".sr-art"));
  rows.forEach((rEl) => {
    const rHtml = rEl as HTMLElement;
    rHtml.classList.remove("sr-art-active");
    rHtml.style.background = "";
    rHtml.style.borderLeft = "";
    rHtml.style.paddingLeft = "";
  });
  if (scrActive === null) return;
  const activeRow = list.querySelector(
    `.sr-art[data-sid="${scrActive}"]`,
  ) as HTMLElement | null;
  if (activeRow) {
    activeRow.classList.add("sr-art-active");
    activeRow.style.background = "var(--background-primary)";
    activeRow.style.borderLeft = "3px solid var(--highlight-primary)";
    activeRow.style.paddingLeft = "1px";
  }
}

function selectScreeningPaper(
  doc: Document,
  paperId: number | null,
  options: {
    resetDetailScroll?: boolean;
    scrollIntoView?: boolean;
    preserveTransientFlags?: boolean;
  } = {},
): void {
  if (!contentArea) return;
  const {
    resetDetailScroll = true,
    scrollIntoView = false,
    preserveTransientFlags = false,
  } = options;

  scrActive = paperId;
  if (!preserveTransientFlags) {
    showNote = false;
    showReason = false;
    showLabelRow = false;
    showSourceLabelRow = false;
  }

  refreshScreeningActiveRow(doc);

  const oldDetail = contentArea.querySelector(".sr-screening-detail");
  if (oldDetail?.parentElement) {
    const newDetail = buildDetailView(doc);
    oldDetail.parentElement.replaceChild(newDetail, oldDetail);
    if (resetDetailScroll) {
      const scrollBody = newDetail.querySelector(
        ".sr-article-detail-scroll",
      ) as HTMLElement | null;
      if (scrollBody) scrollBody.scrollTop = 0;
    }
  }

  if (scrollIntoView) {
    scrollActivePaperIntoView(doc);
  }

  focusScreeningDetail(doc);
}

function reRenderPanel(
  doc: Document,
  panel: SRSubTab,
  resetDetailScroll = false,
): void {
  if (!contentArea) return;
  let restoreDetailFocus = false;
  if (panel === "screening") {
    const list = contentArea.querySelector(
      ".sr-art-list",
    ) as HTMLElement | null;
    const detail = contentArea.querySelector(
      ".sr-article-detail-scroll",
    ) as HTMLElement | null;
    const screeningDetail = contentArea.querySelector(
      ".sr-screening-detail",
    ) as HTMLElement | null;
    restoreDetailFocus = Boolean(
      screeningDetail &&
      doc.activeElement &&
      screeningDetail.contains(doc.activeElement),
    );
    if (list) articleListScrollTop = list.scrollTop;
    if (resetDetailScroll) articleDetailScrollTop = 0;
    else if (detail) articleDetailScrollTop = detail.scrollTop;
  }
  renderPanel(doc, panel);
  if (panel === "screening") {
    const restoreScroll = () => {
      const list = contentArea?.querySelector(
        ".sr-art-list",
      ) as HTMLElement | null;
      const detail = contentArea?.querySelector(
        ".sr-article-detail-scroll",
      ) as HTMLElement | null;
      if (list) list.scrollTop = articleListScrollTop;
      if (detail) detail.scrollTop = articleDetailScrollTop;
      if (restoreDetailFocus) {
        const screeningDetail = contentArea?.querySelector(
          ".sr-screening-detail",
        ) as HTMLElement | null;
        screeningDetail?.focus({ preventScroll: true });
      }
    };
    doc.defaultView?.requestAnimationFrame(restoreScroll);
  }
}

function escHtml(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

let _toastTimer: ReturnType<typeof setTimeout> | null = null;
function toast(doc: Document, msg: string): void {
  if (_toastTimer) clearTimeout(_toastTimer);
  let el = doc.getElementById("sr-toast") as HTMLElement | null;
  if (!el) {
    el = doc.createElement("div");
    el.id = "sr-toast";
    el.style.cssText =
      "position:fixed;bottom:20px;left:50%;transform:translateX(-50%);padding:6px 16px;border-radius:8px;background:var(--text-primary);color:var(--background-primary);font-size:11px;font-weight:500;z-index:9999;opacity:0;transition:opacity 0.2s;pointer-events:none;max-width:360px;text-align:center;box-shadow:0 4px 12px rgba(0,0,0,0.3);";
    appendToBody(doc, el);
  }
  el.textContent = msg;
  el.style.opacity = "1";
  _toastTimer = setTimeout(() => {
    if (el) el.style.opacity = "0";
  }, 2200);
}

function trunc(s: string, n: number): string {
  return s.length > n ? s.substring(0, n) + "..." : s;
}

type PaperConfidence = {
  value: number;
  source: "ai" | "keyword";
};

function getPaperConfidence(
  paper: SystematicReviewPaper,
): PaperConfidence | undefined {
  if (paper.recommendation?.source === "model") {
    return { value: paper.recommendation.confidence, source: "ai" };
  }
  if (paper.modelConfidence !== undefined) {
    return { value: paper.modelConfidence, source: "ai" };
  }
  if (paper.analysis) {
    const confidence = paper.screeningEvents
      ?.slice()
      .reverse()
      .find((event) => event.confidence !== undefined)?.confidence;
    if (confidence !== undefined) return { value: confidence, source: "ai" };
  }
  if (paper.recommendation?.source === "keyword") {
    return { value: paper.recommendation.confidence, source: "keyword" };
  }
  if (paper.keywordConfidence !== undefined) {
    return { value: paper.keywordConfidence, source: "keyword" };
  }
  return undefined;
}

// ============================================================
// SCREENING FILTER + KEYWORD MATCHING + HIGHLIGHTING
// ============================================================
function scrFiltered(): SystematicReviewPaper[] {
  if (!currentState) return [];
  const ap = [...currentState.papers];
  const space = getActiveSpace();
  const activeFolderId = space?.activeFolderId || "all";
  const f = currentState.scrFilter;
  const q = currentState.scrSearch.trim().toLowerCase();
  if (currentState.scrSort === "confidence") {
    ap.sort((a, b) => {
      const aConfidence = getPaperConfidence(a);
      const bConfidence = getPaperConfidence(b);
      if (aConfidence === undefined && bConfidence === undefined) {
        return a.id - b.id;
      }
      if (aConfidence === undefined) return 1;
      if (bConfidence === undefined) return -1;
      return bConfidence.value - aConfidence.value || a.id - b.id;
    });
  } else if (currentState.scrSort === "year") {
    ap.sort((a, b) => {
      const ya = parseInt(getItemMeta(a.id).year || "0", 10);
      const yb = parseInt(getItemMeta(b.id).year || "0", 10);
      return yb - ya || a.id - b.id;
    });
  } else if (currentState.scrSort === "status") {
    const order: Record<string, number> = {
      included: 0,
      maybe: 1,
      undecided: 2,
      excluded: 3,
    };
    ap.sort(
      (a, b) => (order[a.status] ?? 0) - (order[b.status] ?? 0) || a.id - b.id,
    );
  }
  return ap.filter((p) => {
    if (
      activeFolderId !== "all" &&
      !currentState!.sourceOccurrences.some(
        (occurrence) =>
          occurrence.paperId === p.id && occurrence.sourceId === activeFolderId,
      )
    ) {
      return false;
    }
    if (f !== "all" && p.status !== f) return false;
    if (q) {
      const m = getItemMeta(p.id);
      const text = [
        m.title,
        m.abstract,
        m.authors,
        m.doi,
        m.journal,
        p.note || "",
      ]
        .join(" ")
        .toLowerCase();
      if (!text.includes(q)) return false;
    }
    if (kwFilterActive) {
      if (kwFilterKeyword) {
        if (!kwMatchesPaper(p, kwFilterKeyword)) return false;
      } else {
        const space = getActiveSpace();
        const incKws = space?.incKeywords || [];
        const excKws = space?.excKeywords || [];
        if (incKws.length > 0) {
          if (!incKws.some((kw: string) => kwMatchesPaper(p, kw))) return false;
        }
        if (excKws.some((kw: string) => kwMatchesPaper(p, kw))) return false;
      }
    }
    if (!applyMetaFilters(p)) return false;
    return true;
  });
}

function applyMetaFilters(p: SystematicReviewPaper): boolean {
  let keep = true;
  filterEnabled.forEach((secId: string) => {
    const selSet = activeFilters[secId];
    if (!selSet || selSet.size === 0) return;
    if (secId === "includeKeywords") {
      const includeTerms = Array.from(selSet);
      if (
        includeTerms.length > 0 &&
        !includeTerms.some((keyword) => kwMatchesPaper(p, keyword))
      ) {
        keep = false;
      }
    } else if (secId === "excludeKeywords") {
      const excludeTerms = Array.from(selSet);
      if (excludeTerms.some((keyword) => kwMatchesPaper(p, keyword))) {
        keep = false;
      }
    } else if (secId === "labels") {
      const pl = getPaperLabels(p.id);
      if (pl.size === 0) {
        keep = false;
        return;
      }
      let match = false;
      selSet.forEach((v: string) => {
        if (pl.has(v)) match = true;
      });
      if (!match) keep = false;
    } else if (secId === "status") {
      if (!selSet.has(p.status)) keep = false;
    } else if (secId === "exclReasons") {
      if (!selSet.has(p.exclReason || "")) keep = false;
    } else if (secId === "confidence") {
      const confidence = getPaperConfidence(p)?.value;
      if (confidence === undefined) {
        keep = false;
        return;
      }
      const confClass =
        confidence >= 0.7 ? "high" : confidence >= 0.4 ? "medium" : "low";
      if (!selSet.has(confClass)) keep = false;
    } else if (secId === "pubTypes") {
      if (!selSet.has(p.design || "Unknown")) keep = false;
    } else if (secId === "evidence") {
      if (!selSet.has(p.ev || "Unknown")) keep = false;
    } else if (secId === "journals") {
      const m = getItemMeta(p.id);
      if (!selSet.has(m.journal || "Unknown")) keep = false;
    } else if (secId === "authors") {
      const m = getItemMeta(p.id);
      const a =
        m.creators.length > 0
          ? (m.creators[0] as any).lastName ||
            (m.creators[0] as any).name ||
            "Unknown"
          : "Unknown";
      if (!selSet.has(a)) keep = false;
    } else if (secId === "bias") {
      if (!selSet.has(p.bias || "Unknown")) keep = false;
    } else if (secId === "years") {
      const yr = parseInt(getItemMeta(p.id).year || "0", 10);
      if (yr > 0) {
        const bucket = Math.floor(yr / 5) * 5;
        const key = bucket + "-" + (bucket + 4);
        if (!selSet.has(key)) keep = false;
      }
    }
  });
  return keep;
}

function kwMatchesPaper(paper: SystematicReviewPaper, kw: string): boolean {
  const m = getItemMeta(paper.id);
  return (m.title + " " + m.abstract).toLowerCase().includes(kw.toLowerCase());
}

function activeHighlightKeywords(): { inc: string[]; exc: string[] } {
  const space = getActiveSpace();
  const selected = (sectionId: string, configured: string[]) => {
    if (!filterEnabled.has(sectionId)) return [];
    const active = activeFilters[sectionId];
    if (!active) return configured;
    return configured.filter((keyword) => active.has(keyword));
  };
  return {
    inc: selected("includeKeywords", space?.incKeywords || []),
    exc: selected("excludeKeywords", space?.excKeywords || []),
  };
}

function kwHitsForPaper(paper: SystematicReviewPaper): {
  inc: string[];
  exc: string[];
} {
  const { inc: incKws, exc: excKws } = activeHighlightKeywords();
  const m = getItemMeta(paper.id);
  const txt = (m.title + " " + m.abstract).toLowerCase();
  const inc: string[] = [];
  const exc: string[] = [];
  incKws.forEach((k: string) => {
    if (txt.includes(k.toLowerCase())) inc.push(k);
  });
  excKws.forEach((k: string) => {
    if (txt.includes(k.toLowerCase())) exc.push(k);
  });
  return { inc, exc };
}

function hlText(doc: Document, text: string): HTMLElement[] {
  const { inc: incKws, exc: excKws } = activeHighlightKeywords();
  const nodes: HTMLElement[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    let bestMatch: { idx: number; len: number; type: "inc" | "exc" } | null =
      null;
    for (const kw of incKws) {
      const idx = remaining.toLowerCase().indexOf(kw.toLowerCase());
      if (idx !== -1 && (!bestMatch || idx < bestMatch.idx)) {
        bestMatch = { idx, len: kw.length, type: "inc" };
      }
    }
    for (const kw of excKws) {
      const idx = remaining.toLowerCase().indexOf(kw.toLowerCase());
      if (idx !== -1 && (!bestMatch || idx < bestMatch.idx)) {
        bestMatch = { idx, len: kw.length, type: "exc" };
      }
    }
    if (!bestMatch) {
      const span = doc.createElement("span");
      span.textContent = remaining;
      nodes.push(span);
      break;
    }
    if (bestMatch.idx > 0) {
      const span = doc.createElement("span");
      span.textContent = remaining.substring(0, bestMatch.idx);
      nodes.push(span);
    }
    const hl = doc.createElement("span");
    hl.textContent = remaining.substring(
      bestMatch.idx,
      bestMatch.idx + bestMatch.len,
    );
    hl.style.cssText =
      bestMatch.type === "inc"
        ? "background:#dcfce7;color:#166534;border-bottom:1px solid #bbf7d0;border-radius:2px;padding:0 2px;font-weight:500;"
        : "background:#fce4ec;color:#991b1b;border-bottom:1px solid #fecdd3;border-radius:2px;padding:0 2px;font-weight:500;";
    nodes.push(hl);
    remaining = remaining.substring(bestMatch.idx + bestMatch.len);
  }
  return nodes;
}

function kwDiffBar(doc: Document, paper: SystematicReviewPaper): HTMLElement {
  const hits = kwHitsForPaper(paper);
  const bar = doc.createElement("div");
  bar.style.cssText =
    "padding:4px 8px;border-top:1px solid var(--border-primary);flex-shrink:0;font-size:9px;";
  if (hits.inc.length > 0) {
    const incRow = doc.createElement("div");
    incRow.style.cssText = "margin-bottom:2px;line-height:1.6;";
    const lbl = doc.createElement("span");
    lbl.textContent =
      hits.inc.length +
      " include match" +
      (hits.inc.length !== 1 ? "es" : "") +
      ": ";
    lbl.style.cssText = "font-weight:600;color:#16a34a;";
    incRow.appendChild(lbl);
    hits.inc.forEach((k: string) => {
      const chip = doc.createElement("span");
      chip.textContent = k;
      chip.style.cssText =
        "display:inline-block;padding:0 3px;border-radius:3px;font-size:8px;margin-right:2px;background:#dcfce7;color:#166534;";
      incRow.appendChild(chip);
    });
    bar.appendChild(incRow);
  }
  if (hits.exc.length > 0) {
    const excRow = doc.createElement("div");
    excRow.style.cssText = "line-height:1.6;";
    const lbl = doc.createElement("span");
    lbl.textContent =
      hits.exc.length +
      " exclude match" +
      (hits.exc.length !== 1 ? "es" : "") +
      ": ";
    lbl.style.cssText = "font-weight:600;color:#dc2626;";
    excRow.appendChild(lbl);
    hits.exc.forEach((k: string) => {
      const chip = doc.createElement("span");
      chip.textContent = k;
      chip.style.cssText =
        "display:inline-block;padding:0 3px;border-radius:3px;font-size:8px;margin-right:2px;background:#fce4ec;color:#991b1b;";
      excRow.appendChild(chip);
    });
    bar.appendChild(excRow);
  }
  if (hits.inc.length === 0 && hits.exc.length === 0) {
    bar.textContent = "No keyword matches";
    bar.style.color = "var(--text-tertiary)";
  }
  return bar;
}

// ============================================================
// LABEL HELPERS
// ============================================================
function getPaperLabels(pid: number): Set<string> {
  if (!currentState) return new Set();
  return new Set(currentState.paperLabels[pid] || []);
}

function togglePaperLabel(doc: Document, pid: number, lbk: string): void {
  if (!currentState) return;
  if (!currentState.paperLabels[pid]) currentState.paperLabels[pid] = [];
  const idx = currentState.paperLabels[pid].indexOf(lbk);
  if (idx >= 0) currentState.paperLabels[pid].splice(idx, 1);
  else currentState.paperLabels[pid].push(lbk);
  getSRStore().saveState(currentState);
  reRenderPanel(doc, "screening");
}

function renderLabelChips(doc: Document, pid: number): HTMLElement {
  const wrap = doc.createElement("div");
  wrap.style.cssText = "display:flex;gap:2px;flex-wrap:wrap;";
  const pl = getPaperLabels(pid);
  if (!pl.size) {
    const empty = doc.createElement("span");
    empty.textContent = "No labels";
    empty.style.cssText = "font-size:10px;color:var(--text-tertiary);";
    wrap.appendChild(empty);
    return wrap;
  }
  pl.forEach((lk: string) => {
    const def = currentState!.labelDefs.find(
      (l: LabelDefinition) => l.k === lk,
    );
    const chip = doc.createElement("span");
    chip.textContent = def ? def.name : lk;
    chip.style.cssText =
      "padding:0 4px;border-radius:3px;font-size:8px;font-weight:600;cursor:default;display:inline-block;background:" +
      (def ? def.bg : "var(--background-tertiary)") +
      ";color:" +
      (def ? def.color : "var(--text-secondary)") +
      ";";
    wrap.appendChild(chip);
  });
  return wrap;
}

function renderLabelPicker(doc: Document, pid: number): HTMLElement {
  const pk = doc.createElement("div");
  pk.style.cssText = "display:flex;gap:4px;flex-wrap:wrap;align-items:center;";
  currentState!.labelDefs.forEach((ld: LabelDefinition) => {
    const has = getPaperLabels(pid).has(ld.k);
    const chip = doc.createElement("span");
    chip.textContent = ld.name;
    chip.style.cssText =
      "cursor:pointer;padding:2px 6px;border-radius:3px;font-size:9px;font-weight:600;display:inline-block;background:" +
      ld.bg +
      ";color:" +
      ld.color +
      ";" +
      (has
        ? "opacity:1;border:2px solid var(--highlight-primary);box-shadow:0 0 0 1px var(--highlight-primary);"
        : "opacity:0.5;");
    chip.addEventListener("click", () => {
      togglePaperLabel(doc, pid, ld.k);
    });
    pk.appendChild(chip);
  });
  return pk;
}

function toggleLabelRow(doc: Document): void {
  showLabelRow = !showLabelRow;
  showReason = false;
  showSourceLabelRow = false;
  selectScreeningPaper(doc, scrActive, { resetDetailScroll: false });
}

export function addPapersToSystematicReview(
  paperIds: number[],
  sourceLabel?: string,
): Promise<void> {
  const service = getSRService();
  return service.load().then(async (state) => {
    const newPapers = service.addPapers(state, paperIds, sourceLabel);
    currentState = state;
    newPapers.forEach((p) => _srPaperIdSet.add(p.id));
    warmItemCache(paperIds);
    await service.save(state);
  });
}

export function removePapersFromSystematicReview(
  paperIds: number[],
): Promise<void> {
  const service = getSRService();
  return service.load().then(async (state) => {
    const removed = service.removePapers(state, paperIds);
    if (removed.length === 0) return;
    currentState = state;
    for (const id of removed) {
      _srPaperIdSet.delete(id);
      invalidateItemCache(id);
    }
    await service.save(state);
  });
}

export function isItemInSystematicReview(paperId: number): boolean {
  return _srPaperIdSet.has(paperId);
}

export function getSystematicReviewPaperIds(): number[] {
  return Array.from(_srPaperIdSet);
}

export async function ensureSRStateLoaded(): Promise<void> {
  if (_stateLoaded) return;
  const store = getSRStore();
  currentState = await store.loadState();
  _stateLoaded = true;
  _srPaperIdSet.clear();
  currentState.papers.forEach((p) => _srPaperIdSet.add(p.id));
}

export function getSystematicReviewState(): SystematicReviewState | null {
  return currentState;
}
