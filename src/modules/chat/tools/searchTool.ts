/**
 * Search Tool Implementation
 * Searches Zotero library for items matching query and filters
 */

import {
  AgentConfig,
  CreateCollectionParams,
  FindCollectionParams,
  ImportPaperParams,
  ImportPaperResult,
  ListCollectionParams,
  MoveItemParams,
  RemoveItemFromCollectionParams,
  SearchExternalParams,
  SearchExternalResult,
  SearchLibraryParams,
  SearchLibraryResult,
  ToolResult,
} from "./toolTypes";
import { semanticScholarService } from "../../semanticScholar";
import { Assistant } from "../../assistant";
import { getChatStateManager } from "../stateManager";
import {
  ScholarlyPaper,
  ScholarlyProviderId,
  searchScholarlyPapers,
  selectedProviders,
} from "../../search";
import { buildExternalSearchQuery } from "./searchExternalAdapter";
import {
  identifierKeyString,
  identifiersOverlap,
  keysForScholarlyPaper,
  keysForZoteroItemLike,
  parsePaperIdentifier,
} from "./paperIdentity";

const recentExternalPaperCache = new Map<string, ScholarlyPaper>();
const IMPORT_PAPER_CONCURRENCY = 2;

function rememberExternalPaper(paper: ScholarlyPaper): void {
  recentExternalPaperCache.set(paper.paperId, paper);
  for (const key of keysForScholarlyPaper(paper)) {
    recentExternalPaperCache.set(identifierKeyString(key), paper);
  }
}

function cachedExternalPaper(
  paperId: string,
  provider?: ScholarlyProviderId,
): ScholarlyPaper | undefined {
  const parsed = parsePaperIdentifier(paperId, provider);
  return (
    recentExternalPaperCache.get(paperId) ||
    parsed.keys
      .map((key) => recentExternalPaperCache.get(identifierKeyString(key)))
      .find(Boolean)
  );
}

function providersForIdentifier(
  paperId: string,
  provider?: ScholarlyProviderId,
): ScholarlyProviderId[] {
  const parsed = parsePaperIdentifier(paperId, provider);
  if (parsed.provider) return [parsed.provider];
  const kinds = new Set(parsed.keys.map((key) => key.kind));
  if (kinds.has("arxiv")) return ["arxiv"];
  if (kinds.has("pmid") || kinds.has("pmcid")) {
    return ["pubmed", "europe-pmc"];
  }
  if (kinds.has("doi")) {
    return [
      "europe-pmc",
      "arxiv",
      "pubmed",
      "biorxiv",
      "medrxiv",
      "core",
      "base",
      "zenodo",
      "hal",
      "semantic-scholar",
    ];
  }
  return [
    "arxiv",
    "pubmed",
    "europe-pmc",
    "biorxiv",
    "medrxiv",
    "iacr",
    "core",
    "base",
    "zenodo",
    "hal",
    "semantic-scholar",
  ];
}

async function findExistingImportedItem(
  paper: ScholarlyPaper,
): Promise<Zotero.Item | null> {
  const paperKeys = keysForScholarlyPaper(paper);
  for (const lib of Zotero.Libraries.getAll()) {
    try {
      const items = await Zotero.Items.getAll(lib.libraryID);
      const Items = Zotero.Items as any;
      if (items.length && typeof Items.loadDataTypes === "function") {
        await Items.loadDataTypes(items);
      }
      for (const item of items) {
        if (!item.isRegularItem()) continue;
        if (identifiersOverlap(paperKeys, keysForZoteroItemLike(item))) {
          return item;
        }
      }
    } catch (e) {
      Zotero.debug(`[seerai] import_paper duplicate scan failed: ${e}`);
    }
  }
  return null;
}

async function addExistingItemToCollection(
  item: Zotero.Item,
  collectionId: number | undefined,
): Promise<void> {
  if (!collectionId || item.getCollections().includes(collectionId)) return;
  item.addToCollection(collectionId);
  await item.saveTx();
}

function shouldRunImportOcr(
  params: Pick<ImportPaperParams, "trigger_ocr">,
  config: AgentConfig,
): boolean {
  if (!config.autoOcr) return false;
  return params.trigger_ocr !== false;
}

function importStatuses(
  pdfAttached: boolean,
  waitForPdf: boolean,
  config: AgentConfig,
  params: Pick<ImportPaperParams, "trigger_ocr">,
): {
  pdf_status: ImportPaperResult["pdf_status"];
  ocr_status: ImportPaperResult["ocr_status"];
} {
  const ocrAllowed = shouldRunImportOcr(params, config);
  return {
    pdf_status: pdfAttached ? "attached" : waitForPdf ? "failed" : "queued",
    ocr_status: !config.autoOcr
      ? "disabled"
      : ocrAllowed
        ? "queued"
        : "skipped",
  };
}

async function resolvePaperForImport(
  params: ImportPaperParams,
): Promise<{ paper?: ScholarlyPaper; error?: string }> {
  const paperId = params.paper_id;
  if (!paperId) {
    return { error: "paper_id is required to resolve a single paper import" };
  }
  const cached = cachedExternalPaper(paperId, params.provider);
  if (cached) return { paper: cached };

  const parsed = parsePaperIdentifier(paperId, params.provider);
  const providers = providersForIdentifier(paperId, params.provider);
  const result = await searchScholarlyPapers(
    {
      text: parsed.searchText,
      mode: "source",
      providers,
      limit: 10,
      sort: "relevance",
      filters: {},
      providerFilters: {},
    },
    undefined,
  );
  for (const paper of result.items) rememberExternalPaper(paper);

  const exact = result.items.find((paper) =>
    identifiersOverlap(parsed.keys, keysForScholarlyPaper(paper)),
  );
  if (exact) return { paper: exact };

  if (parsed.provider === "semantic-scholar") {
    const paper = await semanticScholarService.getPaper(
      parsed.nativeId || paperId,
    );
    if (paper) {
      const scholarlyPaper = {
        ...paper,
        source: "semantic-scholar" as const,
        sources: ["semantic-scholar" as const],
        providerIds: { "semantic-scholar": paper.paperId },
      };
      rememberExternalPaper(scholarlyPaper);
      return { paper: scholarlyPaper };
    }
  }

  const providerIssues = Object.entries(result.providers)
    .filter(([, state]) => state?.error || state?.skippedReason)
    .map(
      ([id, state]) =>
        `${id}: ${state?.error || state?.skippedReason || "unavailable"}`,
    );
  return {
    error: `Could not resolve "${params.paper_id}" to an exact scholarly record from ${providers.join(", ")}.${providerIssues.length ? ` Provider issues: ${providerIssues.join("; ")}` : ""} Run search_external first and pass the returned paperId/providerIds, or provide a provider hint.`,
  };
}

/**
 * Execute search_library tool
 */
export async function executeSearchLibrary(
  params: SearchLibraryParams,
  config: AgentConfig,
): Promise<ToolResult> {
  try {
    const { query, filters, limit = 10, library_id } = params;
    const effectiveLimit = Math.min(limit, 50); // Cap at 50

    Zotero.debug(
      `[seerai] Tool: search_library query="${query}" limit=${effectiveLimit}`,
    );
    Zotero.debug(
      `[seerai] Tool: search_library config scope=${JSON.stringify(config.libraryScope)}`,
    );

    // Determine library and collection scope
    // Explicit library_id param overrides config.libraryScope
    let searchLibraryID: number | undefined;
    let searchCollectionID: number | undefined;

    if (library_id !== undefined) {
      searchLibraryID = library_id;
    } else if (config.libraryScope.type === "user") {
      searchLibraryID = Zotero.Libraries.userLibraryID;
    } else if (config.libraryScope.type === "group") {
      const groupLibId = Zotero.Groups.getLibraryIDFromGroupID(
        config.libraryScope.groupId,
      );
      searchLibraryID =
        typeof groupLibId === "number"
          ? groupLibId
          : Zotero.Libraries.userLibraryID;
    } else if (config.libraryScope.type === "collection") {
      const colScope = config.libraryScope as any;
      searchCollectionID = colScope.collectionId;
      searchLibraryID =
        colScope.libraryID !== undefined
          ? colScope.libraryID
          : Zotero.Libraries.userLibraryID;
    } else {
      // "all" - search all libraries
      searchLibraryID = undefined;
    }

    let itemIDs: number[] = [];

    // Helper to create a search with optional library scope
    const createSearch = (libID?: number) => {
      if (libID !== undefined) {
        return new Zotero.Search({ libraryID: libID });
      }
      return new Zotero.Search();
    };

    // If we have a query, use multiple strategies
    if (query) {
      // Strategy 1: The standard "quicksearch" is actually very good for title/author combos
      const qsSearch = createSearch(searchLibraryID);
      qsSearch.addCondition("quicksearch-titleCreatorYear", "contains", query);
      qsSearch.addCondition("itemType", "isNot", "attachment");
      qsSearch.addCondition("itemType", "isNot", "note");
      const qsResults = await qsSearch.search();
      Zotero.debug(`[seerai] Quicksearch found: ${qsResults.length} items`);
      itemIDs = [...qsResults];

      // Strategy 2: If few results, try exact title matching (more specific)
      if (itemIDs.length < effectiveLimit) {
        const titleSearch = createSearch(searchLibraryID);
        titleSearch.addCondition("title", "contains", query);
        const titleResults = await titleSearch.search();
        Zotero.debug(
          `[seerai] Title search found: ${titleResults.length} items`,
        );
        for (const id of titleResults) {
          if (!itemIDs.includes(id)) itemIDs.push(id);
        }
      }

      // Strategy 3: Try splitting the query into words if it's long and no results
      if (itemIDs.length === 0 && query.includes(" ")) {
        const words = query.split(/\s+/).filter((w) => w.length > 3);
        if (words.length > 1) {
          Zotero.debug(
            `[seerai] No results for full query, trying keyword search: ${words.slice(0, 3).join(", ")}`,
          );
          const kwSearch = createSearch(searchLibraryID);
          // Join with AND
          for (const word of words.slice(0, 5)) {
            // Use up to 5 words
            kwSearch.addCondition("title", "contains", word);
          }
          const kwResults = await kwSearch.search();
          itemIDs = [...kwResults];
        }
      }
    } else {
      // No query - get all items in scope
      const allSearch = createSearch(searchLibraryID);
      allSearch.addCondition("itemType", "isNot", "attachment");
      allSearch.addCondition("itemType", "isNot", "note");
      itemIDs = await allSearch.search();
    }

    // Apply Collection Filter (if specified in config)
    if (searchCollectionID !== undefined) {
      const collection = Zotero.Collections.get(searchCollectionID);
      if (collection) {
        // Get ALL item IDs in this collection and its subcollections
        const collectionItemIDs = collection.getChildItems(true); // true = recursive
        const colSet = new Set(collectionItemIDs);
        itemIDs = itemIDs.filter((id) => colSet.has(id));
        Zotero.debug(
          `[seerai] Collection filter applied: ${itemIDs.length} items remain`,
        );
      }
    }

    // Apply Filters (if specified in tool call)
    const filteredItems: Zotero.Item[] = [];
    for (const id of itemIDs) {
      const item = Zotero.Items.get(id);
      if (!item || !item.isRegularItem()) continue;

      // Apply manual filters from params
      if (filters) {
        // Year
        if (filters.year_from || filters.year_to) {
          const dateStr = item.getField("date")?.toString() || "";
          const yearMatch = dateStr.match(/\d{4}/);
          const year = yearMatch ? parseInt(yearMatch[0], 10) : null;
          if (filters.year_from && (!year || year < filters.year_from))
            continue;
          if (filters.year_to && (!year || year > filters.year_to)) continue;
        }

        // Tags
        if (filters.tags && filters.tags.length > 0) {
          const itemTags = item.getTags().map((t: any) => t.tag.toLowerCase());
          const matchesTags = filters.tags.every((t) =>
            itemTags.some((it) => it.includes(t.toLowerCase())),
          );
          if (!matchesTags) continue;
        }

        // Internal Collection filter from tool params (not config)
        if (filters.collection) {
          const itemCollections = item.getCollections();
          // This is harder since we only have names in searchTool but Zotero uses IDs
          // We'll skip for now or rely on the config-based collection scope
        }
      }

      filteredItems.push(item);
    }

    // Sort results: prioritize items where query appears in title
    if (query) {
      const lowerQuery = query.toLowerCase();
      filteredItems.sort((a, b) => {
        const aTitle = ((a.getField("title") as string) || "").toLowerCase();
        const bTitle = ((b.getField("title") as string) || "").toLowerCase();
        const aMatches = aTitle.includes(lowerQuery);
        const bMatches = bTitle.includes(lowerQuery);
        if (aMatches && !bMatches) return -1;
        if (!aMatches && bMatches) return 1;
        return 0;
      });
    }

    // Limit and format results
    const limitedItems = filteredItems.slice(0, effectiveLimit);
    const resultItems: SearchLibraryResult["items"] = [];

    for (const item of limitedItems) {
      const title = item.getField("title") || "Untitled";
      const creators = item.getCreators();
      const authors = creators
        .map((c: any) =>
          c.lastName
            ? `${c.firstName || ""} ${c.lastName}`.trim()
            : c.name || "",
        )
        .filter(Boolean);

      const year =
        item.getField("year") ||
        item.getField("date")?.toString().substring(0, 4) ||
        "";

      const abstract = item.getField("abstractNote") || "";
      const abstractPreview =
        abstract.length > 200 ? abstract.substring(0, 200) + "..." : abstract;

      resultItems.push({
        id: item.id,
        title: title as string,
        authors,
        year: year as string,
        abstract_preview: abstractPreview as string,
        tags: item.getTags().map((t: any) => t.tag),
        item_type: item.itemType,
      });
    }

    return {
      success: true,
      data: {
        items: resultItems,
        total_count: filteredItems.length,
      },
      summary: `Found ${filteredItems.length} items, returning ${resultItems.length}`,
    };
  } catch (error) {
    Zotero.debug(`[seerai] Tool: search_library error: ${error}`);
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function executeSearchExternal(
  params: SearchExternalParams,
  config: AgentConfig,
): Promise<ToolResult> {
  try {
    const query = buildExternalSearchQuery(params);
    const effectiveLimit = Math.min(params.limit || 10, 100);

    Zotero.debug(
      `[seerai] Tool: search_external query="${params.query}" mode=${query.mode} providers=${query.providers.join(",")} limit=${effectiveLimit}`,
    );

    const results = await searchScholarlyPapers(
      { ...query, limit: effectiveLimit },
      undefined,
    );

    const papers = results.items.slice(0, effectiveLimit).map((p) => {
      rememberExternalPaper(p);
      return {
        paperId: p.paperId,
        title: p.title,
        authors: p.authors.map((a) => a.name),
        year: p.year,
        abstract: p.abstract,
        citationCount: p.citationCount,
        url: p.url,
        has_pdf: !!p.openAccessPdf,
        source: p.source,
        sources: p.sources,
        providerIds: p.providerIds,
        externalIds: p.externalIds,
        venue: p.venue,
        publicationTypes: p.publicationTypes,
        openAccessPdfUrl: p.openAccessPdf?.url,
      };
    });
    const providerErrors = Object.entries(results.providers)
      .filter(([, state]) => state?.error || state?.skippedReason)
      .map(
        ([id, state]) =>
          `${id}: ${state?.error || state?.skippedReason || "unavailable"}`,
      );
    const activeProviders = selectedProviders(query);
    const total =
      query.mode === "source" && activeProviders.length === 1
        ? results.providers[activeProviders[0]]?.total || results.items.length
        : results.items.length;

    const data: SearchExternalResult = {
      total,
      papers,
      providers: results.providers as SearchExternalResult["providers"],
      query: {
        mode: query.mode,
        providers: activeProviders,
        sort: query.sort,
      },
      degraded: providerErrors.length > 0,
    };

    return {
      success: true,
      data,
      summary: `Found ${total} external paper${total === 1 ? "" : "s"}, returning top ${papers.length}${providerErrors.length ? `; provider issues: ${providerErrors.join("; ")}` : ""}`,
    };
  } catch (error) {
    Zotero.debug(`[seerai] Tool: search_external error: ${error}`);
    const message = error instanceof Error ? error.message : String(error);
    if (
      message.includes("403") ||
      message.toLowerCase().includes("forbidden")
    ) {
      return {
        success: true,
        data: {
          total: 0,
          papers: [],
          degraded: true,
          provider:
            params.provider ||
            params.providers?.join(", ") ||
            "scholarly search",
          error: message,
          fallback:
            "The selected scholarly corpus is unavailable. Use another provider/mode or the web tool with action='search' for broader scholarly/web discovery.",
        },
        summary:
          "External scholarly search is unavailable (403 Forbidden); no papers returned. Use another provider or web search fallback.",
      };
    }
    return {
      success: false,
      error: message,
    };
  }
}

/**
 * Execute import_paper tool
 */
export async function executeImportPaper(
  params: ImportPaperParams,
  config: AgentConfig,
): Promise<ToolResult> {
  try {
    const requestedIds = params.paper_ids?.length
      ? params.paper_ids
      : params.paper_id
        ? [params.paper_id]
        : [];
    if (!requestedIds.length) {
      return {
        success: false,
        error: "Either paper_id or paper_ids is required",
      };
    }
    const { trigger_ocr, wait_for_pdf } = params;
    const waitForPdf = wait_for_pdf === true;
    const ocrAllowed = shouldRunImportOcr(params, config);
    let { target_collection_id } = params;

    Zotero.debug(
      `[seerai] Tool: import_paper ids=${requestedIds.length} target_col=${target_collection_id} trigger_ocr=${trigger_ocr} auto_ocr=${config.autoOcr} wait_for_pdf=${waitForPdf}`,
    );

    // If we have a collection scope and no target provided, use the scoped collection
    if (!target_collection_id && config.libraryScope.type === "collection") {
      target_collection_id = (config.libraryScope as any).collectionId;
      Zotero.debug(
        `[seerai] Tool: import_paper - Using scoped collection ${target_collection_id} as default target.`,
      );
    }

    // Verify scope compatibility if target is provided
    if (target_collection_id && config.libraryScope.type === "collection") {
      const scopedId = (config.libraryScope as any).collectionId;
      if (target_collection_id !== scopedId) {
        // Basic check if it's in the same library at least (checkItemInScope not available here, but we can check if it's a child)
        // For now, let's just warn or allow if it's in the same library.
        // Actually, better to enforce it strictly if we are "restricted".
      }
    }

    const importOne = async (
      paperId: string,
    ): Promise<ImportPaperResult & { error?: string }> => {
      const singleParams: ImportPaperParams = {
        ...params,
        paper_id: paperId,
        paper_ids: undefined,
      };
      const resolved = await resolvePaperForImport(singleParams);
      if (!resolved.paper) {
        return {
          item_id: -1,
          title: paperId,
          pdf_attached: false,
          success: false,
          error:
            resolved.error || `Paper with ID ${paperId} could not be resolved`,
        };
      }
      const paper = resolved.paper;

      const existing = await findExistingImportedItem(paper);
      if (existing) {
        await addExistingItemToCollection(existing, target_collection_id);
        const hasPdf = existing
          .getAttachments()
          .some(
            (id) =>
              Zotero.Items.get(id)?.attachmentContentType === "application/pdf",
          );
        const importResult: ImportPaperResult = {
          item_id: existing.id,
          title: (existing.getField("title") as string) || paper.title,
          pdf_attached: hasPdf,
          success: true,
          source: paper.source,
          provider_id: paper.providerIds?.[paper.source] || paper.paperId,
          already_exists: true,
          pdf_status: hasPdf ? "attached" : "skipped",
          ocr_status: !config.autoOcr
            ? "disabled"
            : ocrAllowed
              ? "skipped"
              : "skipped",
        };
        return importResult;
      }

      // 2. Import using Assistant's logic (passing target_collection_id and wait_for_pdf)
      const result = await Assistant.addPaperToZoteroWithPdfDiscovery(
        paper,
        undefined, // No status button
        target_collection_id,
        waitForPdf,
        ocrAllowed,
      );

      if (!result.item) {
        return {
          item_id: -1,
          title: paper.title,
          pdf_attached: false,
          success: false,
          error: "Failed to create item in Zotero",
        };
      }

      const statuses = importStatuses(
        result.pdfAttached,
        waitForPdf,
        config,
        params,
      );
      const importResult: ImportPaperResult = {
        item_id: result.item.id,
        title: paper.title,
        pdf_attached: result.pdfAttached,
        success: true,
        source: paper.source,
        provider_id: paper.providerIds?.[paper.source] || paper.paperId,
        already_exists: false,
        ...statuses,
      };

      return importResult;
    };

    const results: Array<ImportPaperResult & { error?: string }> = [];
    let cursor = 0;
    const worker = async () => {
      while (cursor < requestedIds.length) {
        const paperId = requestedIds[cursor++];
        results.push(await importOne(paperId));
      }
    };
    const poolSize = Math.min(IMPORT_PAPER_CONCURRENCY, requestedIds.length);
    await Promise.all(Array.from({ length: poolSize }, () => worker()));

    if (requestedIds.length > 1) {
      const imported = results.filter(
        (item) => item.success && !item.already_exists,
      ).length;
      const reused = results.filter(
        (item) => item.success && item.already_exists,
      ).length;
      const failed = results.filter((item) => !item.success).length;
      const queued = results.filter(
        (item) => item.pdf_status === "queued",
      ).length;
      return {
        success: failed < results.length,
        data: {
          results,
          imported,
          reused,
          failed,
          queued,
          ocr_enabled: ocrAllowed,
        },
        summary: `Imported ${imported}, reused ${reused}, queued ${queued} PDF task${queued === 1 ? "" : "s"}${failed ? `, failed ${failed}` : ""}. OCR ${ocrAllowed ? "enabled" : "disabled"}.`,
      };
    }

    const importResult = results[0];
    if (!importResult.success) {
      return {
        success: false,
        error: importResult.error || "Failed to import paper",
      };
    }

    return {
      success: true,
      data: importResult,
      summary: `Successfully imported "${importResult.title}" to Zotero (ID: ${importResult.item_id})${target_collection_id ? ` in collection ${target_collection_id}` : ""}.${waitForPdf ? ` PDF discovery: ${importResult.pdf_attached}` : " PDF discovery running in background."} OCR ${ocrAllowed ? "enabled" : "disabled"}.`,
    };
  } catch (error) {
    Zotero.debug(`[seerai] Tool: import_paper error: ${error}`);
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
