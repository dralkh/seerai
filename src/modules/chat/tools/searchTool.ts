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

/**
 * Execute search_library tool
 */
export async function executeSearchLibrary(
  params: SearchLibraryParams,
  config: AgentConfig,
): Promise<ToolResult> {
  try {
    const { query, filters, limit = 10 } = params;
    const effectiveLimit = Math.min(limit, 50); // Cap at 50

    Zotero.debug(
      `[seerai] Tool: search_library query="${query}" limit=${effectiveLimit}`,
    );
    Zotero.debug(
      `[seerai] Tool: search_library config scope=${JSON.stringify(config.libraryScope)}`,
    );

    // Determine library and collection scope
    let searchLibraryID: number | undefined;
    let searchCollectionID: number | undefined;

    if (config.libraryScope.type === "user") {
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

/**
 * Execute search_external tool (Semantic Scholar)
 */
export async function executeSearchExternal(
  params: SearchExternalParams,
  config: AgentConfig,
): Promise<ToolResult> {
  try {
    const { query, year, limit = 10, openAccessPdf } = params;
    const effectiveLimit = Math.min(limit, 50);

    Zotero.debug(
      `[seerai] Tool: search_external query="${query}" limit=${effectiveLimit}`,
    );

    const results = await semanticScholarService.searchPapers({
      query,
      year,
      limit: effectiveLimit,
      openAccessPdf,
    });

    const papers = results.data.map((p) => ({
      paperId: p.paperId,
      title: p.title,
      authors: p.authors.map((a) => a.name),
      year: p.year,
      abstract: p.abstract,
      citationCount: p.citationCount,
      url: p.url,
      has_pdf: !!p.openAccessPdf,
    }));

    const data: SearchExternalResult = {
      total: results.total,
      papers,
    };

    return {
      success: true,
      data,
      summary: `Found ${results.total} papers on Semantic Scholar, returning top ${papers.length}`,
    };
  } catch (error) {
    Zotero.debug(`[seerai] Tool: search_external error: ${error}`);
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
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
    let { paper_id, target_collection_id, trigger_ocr, wait_for_pdf } = params;

    Zotero.debug(
      `[seerai] Tool: import_paper id=${paper_id} target_col=${target_collection_id} trigger_ocr=${trigger_ocr}`,
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

    // 1. Get paper details
    const paper = await semanticScholarService.getPaper(paper_id);
    if (!paper) {
      return {
        success: false,
        error: `Paper with ID ${paper_id} not found on Semantic Scholar`,
      };
    }

    // 2. Import using Assistant's logic (passing target_collection_id and wait_for_pdf)
    const result = await Assistant.addPaperToZoteroWithPdfDiscovery(
      paper,
      undefined, // No status button
      target_collection_id,
      wait_for_pdf,
      trigger_ocr || config.autoOcr,
    );

    if (!result.item) {
      return {
        success: false,
        error: "Failed to create item in Zotero",
      };
    }

    const importResult: ImportPaperResult = {
      item_id: result.item.id,
      title: paper.title,
      pdf_attached: result.pdfAttached,
      success: true,
    };

    return {
      success: true,
      data: importResult,
      summary: `Successfully started import for "${paper.title}" to Zotero (ID: ${result.item.id})${target_collection_id ? ` in collection ${target_collection_id}` : ""}.${wait_for_pdf ? ` PDF discovery: ${result.pdfAttached}` : " PDF discovery running in background."}`,
    };
  } catch (error) {
    Zotero.debug(`[seerai] Tool: import_paper error: ${error}`);
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
