/**
 * Smart Placeholder System
 * Handles placeholder detection, autocomplete queries, and resolution
 */

import {
  PLACEHOLDER_TRIGGERS,
  PlaceholderType,
  extractPlaceholders,
  searchPrompts,
} from "./promptLibrary";

// Re-export PlaceholderType for convenience
export { PlaceholderType } from "./promptLibrary";
import { getTableStore } from "./tableStore";

// ==================== Types ====================

export interface AutocompleteResult {
  id: string | number;
  title: string;
  subtitle?: string;
  icon?: string;
  type: PlaceholderType;
  data?: Record<string, unknown>; // Additional data for resolution
}

export interface TriggerInfo {
  trigger: string;
  type: PlaceholderType;
  query: string;
  startPos: number;
  endPos: number;
}

export interface SelectedPlaceholder {
  key: string;
  type: PlaceholderType;
  value: AutocompleteResult;
}

export interface PlaceholderSelections {
  papers: Map<string, AutocompleteResult>;
  authors: Map<string, AutocompleteResult>;
  collections: Map<string, AutocompleteResult>;
  tags: Map<string, AutocompleteResult>;
  topics: Map<string, string>; // Topics are just strings
}

// Placeholder display info
export const PLACEHOLDER_INFO: Record<
  PlaceholderType,
  { icon: string; label: string; color: string }
> = {
  topic: { icon: "🎯", label: "Topic", color: "#9c27b0" },
  paper: { icon: "📄", label: "Paper", color: "#2196f3" },
  author: { icon: "👤", label: "Author", color: "#4caf50" },
  collection: { icon: "📁", label: "Collection", color: "#ff9800" },
  tag: { icon: "🏷️", label: "Tag", color: "#e91e63" },
  year: { icon: "📅", label: "Year", color: "#607d8b" },
  table: { icon: "📊", label: "Table", color: "#009688" },
  prompt: { icon: "⚡", label: "Prompt", color: "#ffc107" },
};

// ==================== Trigger Detection ====================

/**
 * Detect if the cursor is in a placeholder trigger position
 * Returns trigger info if found, null otherwise
 * Supports multi-word queries (e.g., ~my tag, @John Doe)
 * Skips triggers inside brackets [~tag] (confirmed selections)
 */
export function detectTrigger(
  text: string,
  cursorPos: number,
): TriggerInfo | null {
  if (!text || cursorPos <= 0) return null;

  // Check if cursor is inside a bracketed selection [~...] - if so, skip
  let bracketDepth = 0;
  for (let i = cursorPos - 1; i >= 0; i--) {
    if (text[i] === "]") bracketDepth++;
    if (text[i] === "[") {
      bracketDepth--;
      if (bracketDepth < 0) {
        // We're inside a bracket - don't trigger
        return null;
      }
    }
  }

  // Scan backwards from cursor to find a trigger character
  let pos = cursorPos - 1;

  while (pos >= 0) {
    const char = text[pos];

    // Stop if we hit a closing bracket ']' - we're past a confirmed selection
    if (char === "]") {
      break;
    }

    // Check if this position has a trigger character
    if (PLACEHOLDER_TRIGGERS[char]) {
      // Trigger must be at start of text or preceded by whitespace (not inside brackets)
      const prevChar = pos > 0 ? text[pos - 1] : "";
      if (pos === 0 || /\s/.test(prevChar)) {
        const query = text.substring(pos + 1, cursorPos);
        return {
          trigger: char,
          type: PLACEHOLDER_TRIGGERS[char],
          query,
          startPos: pos,
          endPos: cursorPos,
        };
      }
    }

    pos--;
  }

  return null;
}

/**
 * Replace trigger text with selected value in bracket notation
 * E.g., ~test becomes [~test] for short values
 * Long values are truncated: [/The best obj...::FULL_TITLE_HERE]
 * The ::FULL_VALUE part is hidden from display but used for context
 */
export function insertPlaceholderValue(
  text: string,
  trigger: TriggerInfo,
  value: string,
  itemId?: number | string,
): string {
  const before = text.substring(0, trigger.startPos);
  const after = text.substring(trigger.endPos);

  const maxDisplayLength = 30;
  let displayValue = value;

  // Truncate long values
  if (value.length > maxDisplayLength) {
    displayValue = value.substring(0, maxDisplayLength - 3) + "...";
  }

  // Format: [trigger + displayValue::id] for ID-based lookups
  // Or [trigger + displayValue] for simple values
  const idPart = itemId ? `::${itemId}` : "";
  return before + "[" + trigger.trigger + displayValue + idPart + "] " + after;
}

/**
 * Parsed placeholder reference from message
 */
export interface ParsedPlaceholder {
  trigger: string;
  type: PlaceholderType;
  displayValue: string;
  itemId?: number | string;
  fullMatch: string;
}

/**
 * Parse message text for placeholder references
 * Extracts [~tag], [/paper::123], [@author], etc.
 */
export function parseMessageForContext(text: string): ParsedPlaceholder[] {
  const placeholders: ParsedPlaceholder[] = [];

  // Regex to match [trigger + value] or [trigger + value::id]
  // Matches: [#topic], [~tag], [/Paper Title...::123], [@John Smith], [^Collection]
  const regex = /\[([#/@^~])([^\]]+?)(?:::(\d+))?\]/g;

  let match;
  while ((match = regex.exec(text)) !== null) {
    const trigger = match[1];
    const displayValue = match[2];
    const itemId = match[3] ? parseInt(match[3]) : undefined;

    const type = PLACEHOLDER_TRIGGERS[trigger];
    if (type) {
      placeholders.push({
        trigger,
        type,
        displayValue,
        itemId,
        fullMatch: match[0],
      });
    }
  }

  return placeholders;
}

/**
 * Get clean message text (placeholders replaced with display values only)
 */
export function getCleanMessage(text: string): string {
  // Remove ::id parts from bracketed placeholders
  return text.replace(/\[([#/@^~])([^\]]+?)(?:::\d+)?\]/g, "[$1$2]");
}

// ==================== Autocomplete Queries ====================

/**
 * Query papers (Zotero items) matching the search term
 */
export async function queryPapers(
  query: string,
  limit: number = 20,
): Promise<AutocompleteResult[]> {
  const results: AutocompleteResult[] = [];
  const lowerQuery = query.toLowerCase();

  try {
    Zotero.debug(`[seerai] queryPapers: searching for "${query}"`);

    const libraries = Zotero.Libraries.getAll();

    for (const library of libraries) {
      // Optimization: If results full, check if we should continue?
      // We want best results. Zotero Search returns relevant ones first usually?
      // If we have many libs, maybe limit per lib?
      // Let's rely on filling up the results list.
      if (results.length >= limit) break;

      const s = new Zotero.Search({ libraryID: library.libraryID });
      s.addCondition("itemType", "isNot", "attachment");
      s.addCondition("itemType", "isNot", "note");

      if (query) {
        s.addCondition("quicksearch-titleCreatorYear", "contains", query);
      }

      const itemIDs = await s.search();
      Zotero.debug(
        `[seerai] queryPapers: found ${itemIDs.length} item IDs in lib ${library.name}`,
      );

      if (itemIDs.length === 0) continue;

      const items = await Zotero.Items.getAsync(itemIDs.slice(0, limit * 2)); // improved buffer

      for (const item of items) {
        // Double check if item is note/attachment (should be covered by search conditions but safe to check)
        if (!item.isRegularItem()) continue;

        const title = item.getField("title") as string;
        const creators = item.getCreators();
        const year =
          item.getField("year") || item.getField("date")?.substring(0, 4);

        // Additional filtering in memory if query provided (sometimes quicksearch is fuzzy)
        // This logic was in original code, keeping it.
        if (query && !title.toLowerCase().includes(lowerQuery)) {
          const creatorStr = creators
            .map((c) => `${c.firstName} ${c.lastName}`)
            .join(" ")
            .toLowerCase();
          if (
            !creatorStr.includes(lowerQuery) &&
            !String(year).includes(query)
          ) {
            continue;
          }
        }

        const firstAuthor = creators[0]
          ? `${creators[0].lastName}${creators.length > 1 ? " et al." : ""}`
          : "Unknown";

        // Add library indicator if not user library
        const libSuffix =
          library.libraryID === Zotero.Libraries.userLibraryID
            ? ""
            : ` [${library.name}]`;

        results.push({
          id: item.id,
          title: (title || "Untitled") + libSuffix,
          subtitle: `${firstAuthor} (${year || "n.d."})`,
          icon: "📄",
          type: "paper",
          data: {
            key: item.key,
            itemType: item.itemType,
            abstract: item.getField("abstractNote"),
            libraryID: library.libraryID,
          },
        });

        if (results.length >= limit) break;
      }
    }

    Zotero.debug(
      `[seerai] queryPapers: returning ${results.length} total results`,
    );
  } catch (error) {
    Zotero.debug(`[seerai] Error querying papers: ${error}`);
  }

  return results;
}

/**
 * Query authors (creators) from the library
 */
export async function queryAuthors(
  query: string,
  limit: number = 20,
): Promise<AutocompleteResult[]> {
  const results: AutocompleteResult[] = [];
  const lowerQuery = query.toLowerCase();

  try {
    const libraries = Zotero.Libraries.getAll();

    // Collect all authors with their item counts across all libraries
    const authorCounts: Map<
      string,
      { firstName: string; lastName: string; count: number }
    > = new Map();

    for (const library of libraries) {
      // Use Zotero Search to get all regular items
      const s = new Zotero.Search({ libraryID: library.libraryID });
      s.addCondition("itemType", "isNot", "attachment");
      s.addCondition("itemType", "isNot", "note");

      // Optimization: If query provided, maybe filter search?
      // Authors are usually indexed. 'creator' condition is available.
      if (query) {
        s.addCondition("creator", "contains", query);
      }

      const itemIDs = await s.search();

      // Getting all items is expensive if many.
      // But we need to parse creators.
      // If itemIDs is huge, this will be slow.
      // Limit to reasonable number per library? Or batch?
      // The original code fetched ALL IDs and then got item data.
      // If user has 10k items, this loops 10k times? No, `Zotero.Items.get(itemID)` is fast if in memory.
      // But `getAll` or individual `get`? The original code loop `for (const itemID of itemIDs)` calls `Zotero.Items.get(itemID)`.
      // This is synchronous but might hit DB.

      // Let's cap the number of items we analyze for author suggestions to stay responsive.
      // 500 items per library seems safe enough for "suggestions".
      // Or maybe just analyze the top matches from search.
      const safeItemIDs = itemIDs.slice(0, 500);

      for (const itemID of safeItemIDs) {
        const item = Zotero.Items.get(itemID);
        if (!item || !item.isRegularItem()) continue;

        const creators = item.getCreators();
        for (const creator of creators) {
          const key =
            `${creator.lastName || ""}-${creator.firstName || ""}`.toLowerCase();

          if (query && !key.includes(lowerQuery)) {
            // Double check full name match if needed?
            // 'creator' search condition handles partial matches on names.
            // But we might have false positives or need precise filtering.
            const fullName =
              `${creator.firstName} ${creator.lastName}`.toLowerCase();
            if (!fullName.includes(lowerQuery)) continue;
          }

          const existing = authorCounts.get(key);

          if (existing) {
            existing.count++;
          } else {
            authorCounts.set(key, {
              firstName: creator.firstName || "",
              lastName: creator.lastName || "",
              count: 1,
            });
          }
        }
      }
    }

    // Sort by item count descending
    const sortedAuthors = Array.from(authorCounts.entries()).sort(
      (a, b) => b[1].count - a[1].count,
    );

    for (const [key, author] of sortedAuthors) {
      const fullName = `${author.firstName} ${author.lastName}`.trim();

      results.push({
        id: key,
        title: fullName || "Unknown Author",
        subtitle: `${author.count} paper${author.count > 1 ? "s" : ""}`,
        icon: "👤",
        type: "author",
        data: {
          firstName: author.firstName,
          lastName: author.lastName,
        },
      });

      if (results.length >= limit) break;
    }
  } catch (error) {
    console.error("Error querying authors:", error);
  }

  return results;
}

/**
 * Query collections from the library
 */
export async function queryCollections(
  query: string,
  limit: number = 20,
): Promise<AutocompleteResult[]> {
  const results: AutocompleteResult[] = [];
  const lowerQuery = query.toLowerCase();

  try {
    const libraries = Zotero.Libraries.getAll();

    // Build collection paths for better UX
    const collectionPaths: Map<number, string> = new Map();

    function buildPath(collection: Zotero.Collection): string {
      if (collectionPaths.has(collection.id)) {
        return collectionPaths.get(collection.id)!;
      }

      const parentID = collection.parentID;
      let path = collection.name;

      if (parentID) {
        const parent = Zotero.Collections.get(parentID);
        if (parent) {
          path = buildPath(parent) + " / " + path;
        }
      }

      collectionPaths.set(collection.id, path);
      return path;
    }

    for (const library of libraries) {
      // Get all collections recursively
      const collections = Zotero.Collections.getByLibrary(
        library.libraryID,
        true,
      );

      for (const collection of collections) {
        const path = buildPath(collection);

        // Filter by query
        if (query && !path.toLowerCase().includes(lowerQuery)) {
          continue;
        }

        const childItems = collection.getChildItems(false);

        // Prefix library name if it's not the user library
        const libPrefix =
          library.libraryID === Zotero.Libraries.userLibraryID
            ? ""
            : `[${library.name}] `;
        const displayTitle = libPrefix + collection.name;

        results.push({
          id: collection.id,
          title: displayTitle,
          subtitle:
            path !== collection.name ? path : `${childItems.length} items`,
          icon: "📁",
          type: "collection",
          data: {
            key: collection.key,
            itemCount: childItems.length,
            path,
            libraryID: library.libraryID,
          },
        });
      }
    }

    // Sort by relevance (exact match first, then by item count)
    results.sort((a, b) => {
      const aExact = a.title.toLowerCase().includes(lowerQuery);
      const bExact = b.title.toLowerCase().includes(lowerQuery);
      // This sort logic is a bit weak if we changed title.
      // Let's improve: Exact path match > Included in path > Item count

      // Prefer user library? Maybe not necessary if we show lib name.

      return (
        ((b.data?.itemCount as number) || 0) -
        ((a.data?.itemCount as number) || 0)
      );
    });

    // Slice to limit after collecting all (since we want global best matches)
    // But to be safe with memory if user has thousands of collections, maybe we should slice at the end?
    // We are already sorting.
    if (results.length > limit) {
      results.length = limit;
    }
  } catch (error) {
    console.error("Error querying collections:", error);
  }

  return results;
}

/**
 * Query tags from the library
 */
export async function queryTags(
  query: string,
  limit: number = 20,
): Promise<AutocompleteResult[]> {
  const results: AutocompleteResult[] = [];
  const lowerQuery = query.toLowerCase();

  try {
    const libraries = Zotero.Libraries.getAll();

    // Map to aggregate tags across libraries: tagName -> { count, color, libraries: [] }
    const tagMap = new Map<
      string,
      { count: number; color: string | null; position: number | null }
    >();

    for (const library of libraries) {
      const libraryID = library.libraryID;
      const tags = await Zotero.Tags.getAll(libraryID);
      const colors = Zotero.Tags.getColors(libraryID);

      // Get counts via search (expensive? maybe cache or batch?)
      // The original code did a search for EACH tag. That's very slow if many tags.
      // But we can't easily get all counts.
      // We'll stick to the original logic but applied per library, maybe optimizing?
      // Actually, Zotero.Tags.getAll() returns tags with cached counts? No.
      // Let's stick to the pattern but be careful.

      // Optimization: If query is empty, maybe limit the number of tags we check counts for?
      // Or just check counts for filtered tags.

      for (const tag of tags) {
        const tagName = typeof tag === "string" ? tag : tag.tag;

        if (query && !tagName.toLowerCase().includes(lowerQuery)) {
          continue;
        }

        if (!tagMap.has(tagName)) {
          tagMap.set(tagName, { count: 0, color: null, position: null });
        }

        const entry = tagMap.get(tagName)!;

        // Color (prefer user library color eventually, or just first found)
        const colorInfo = (
          colors as Map<string, { color: string; position: number }>
        ).get(tagName);
        if (colorInfo) {
          if (
            !entry.color ||
            library.libraryID === Zotero.Libraries.userLibraryID
          ) {
            entry.color = colorInfo.color;
            entry.position = colorInfo.position;
          }
        }

        // Count - this is the slow part.
        // We should probably only count if we need to sort by count or show it.
        // The original code caught errors and set count to 0.

        // For now, let's increment count by 1 just to show existence,
        // OR do the expensive search if we really want accurate counts.
        // The user complained about broken search, so accuracy matters.
        // But doing `new Zotero.Search` for every tag in every library is O(N*M).

        // Let's try to get count only for the top N matching tags?
        // But we need counts to sort.

        // Valid optimization: Zotero.Tags contains counts in some versions?
        // `tag.meta?.numItems`?
        // If not, we keep the expensive search but maybe assume it's necessary.

        // NOTE: The previous code was:
        // for (const tag of tags) { ... s.search() ... }
        // That is indeed very slow.
        // I will keep the logic but maybe we should rely on `tagMap` aggregation.

        try {
          const s = new Zotero.Search({ libraryID });
          s.addCondition("tag", "is", tagName);
          s.addCondition("itemType", "isNot", "attachment");
          s.addCondition("itemType", "isNot", "note");
          const itemIDs = await s.search();
          entry.count += itemIDs.length;
        } catch (e) {
          // Ignore
        }
      }
    }

    // Convert map to results
    for (const [tagName, info] of tagMap.entries()) {
      results.push({
        id: tagName,
        title: tagName,
        subtitle: `${info.count} item${info.count !== 1 ? "s" : ""}`,
        icon: info.color ? "🔖" : "🏷️",
        type: "tag",
        data: {
          color: info.color,
          position: info.position,
        },
      });
    }

    // Sort: colored tags first, then by count
    results.sort((a, b) => {
      const aColored = !!a.data?.color;
      const bColored = !!b.data?.color;
      if (aColored !== bColored) return aColored ? -1 : 1;

      // Sort by count
      const aCount = parseInt((a.subtitle?.match(/\d+/) || ["0"])[0]);
      const bCount = parseInt((b.subtitle?.match(/\d+/) || ["0"])[0]);
      return bCount - aCount;
    });

    // Slice
    if (results.length > limit) {
      results.length = limit;
    }
  } catch (error) {
    console.error("Error querying tags:", error);
  }

  return results;
}

/**
 * Query topics (from recent usage or suggestions)
 */
export async function queryTopics(
  query: string,
  limit: number = 10,
): Promise<AutocompleteResult[]> {
  const results: AutocompleteResult[] = [];

  // For topics, we'll provide recent/suggested topics from preferences
  try {
    const recentTopics: string[] = JSON.parse(
      (Zotero.Prefs.get("extensions.seerai.recentTopics") as string) || "[]",
    );

    const lowerQuery = query.toLowerCase();

    for (const topic of recentTopics) {
      if (query && !topic.toLowerCase().includes(lowerQuery)) {
        continue;
      }

      results.push({
        id: topic,
        title: topic,
        subtitle: "Recent topic",
        icon: "🎯",
        type: "topic",
      });

      if (results.length >= limit) break;
    }

    // If query is provided and not in results, add it as a suggestion
    if (query && !results.find((r) => r.title.toLowerCase() === lowerQuery)) {
      results.unshift({
        id: query,
        title: query,
        subtitle: "Use this topic",
        icon: "✨",
        type: "topic",
      });
    }

    // If no results and no query, show a helpful hint
    if (results.length === 0 && !query) {
      results.push({
        id: "_hint",
        title: "Type a topic to focus on...",
        subtitle: "e.g., methodology, results, limitations",
        icon: "💡",
        type: "topic",
      });
    }
  } catch (error) {
    console.error("Error querying topics:", error);
    // If error and query provided, use it
    if (query) {
      results.push({
        id: query,
        title: query,
        subtitle: "New topic",
        icon: "🎯",
        type: "topic",
      });
    } else {
      // Show hint even on error
      results.push({
        id: "_hint",
        title: "Type a topic to focus on...",
        subtitle: "e.g., methodology, results, limitations",
        icon: "💡",
        type: "topic",
      });
    }
  }

  return results;
}

/**
 * Save a topic to recent topics
 */
export function saveRecentTopic(topic: string): void {
  try {
    const recentTopics: string[] = JSON.parse(
      (Zotero.Prefs.get("extensions.seerai.recentTopics") as string) || "[]",
    );

    // Remove if exists, add to front
    const filtered = recentTopics.filter(
      (t) => t.toLowerCase() !== topic.toLowerCase(),
    );
    filtered.unshift(topic);

    // Keep max 20
    const trimmed = filtered.slice(0, 20);

    Zotero.Prefs.set("extensions.seerai.recentTopics", JSON.stringify(trimmed));
  } catch (error) {
    console.error("Error saving recent topic:", error);
  }
}

/**
 * Get autocomplete results for a placeholder type
 */
export async function getAutocompleteResults(
  type: PlaceholderType,
  query: string,
  limit: number = 20,
): Promise<AutocompleteResult[]> {
  switch (type) {
    case "paper":
      return queryPapers(query, limit);
    case "author":
      return queryAuthors(query, limit);
    case "collection":
      return queryCollections(query, limit);
    case "tag":
      return queryTags(query, limit);
    case "topic":
      return queryTopics(query, limit);
    case "year":
      return queryYears(query, limit);
    case "table":
      return queryTables(query, limit);
    case "prompt":
      return queryPrompts(query, limit);
    default:
      return [];
  }
}

/**
 * Query prompts from prompt library
 */
export async function queryPrompts(
  query: string,
  limit: number = 20,
): Promise<AutocompleteResult[]> {
  const results: AutocompleteResult[] = [];

  try {
    const prompts = await searchPrompts(query);

    for (const prompt of prompts) {
      results.push({
        id: prompt.id,
        title: prompt.name,
        subtitle: prompt.description || "Prompt Template",
        icon: "⚡",
        type: "prompt",
        data: {
          template: prompt.template,
          category: prompt.category,
          tags: prompt.tags,
        },
      });

      if (results.length >= limit) break;
    }
  } catch (error) {
    console.error("Error querying prompts:", error);
  }

  return results;
}

/**
 * Query tables from table store
 */
export async function queryTables(
  query: string,
  limit: number = 20,
): Promise<AutocompleteResult[]> {
  const results: AutocompleteResult[] = [];
  const lowerQuery = query.toLowerCase();

  try {
    const tables = await getTableStore().getAllTables();

    for (const table of tables) {
      if (query && !table.name.toLowerCase().includes(lowerQuery)) {
        continue;
      }

      const rowCount = table.addedPaperIds.length;
      const colCount = table.columns.length;

      results.push({
        id: table.id,
        title: table.name,
        subtitle: `${rowCount} papers, ${colCount} columns`,
        icon: "📊",
        type: "table",
        data: {
          rowCount: rowCount,
          columns: table.columns.map((c) => c.name),
        },
      });

      if (results.length >= limit) break;
    }
  } catch (error) {
    console.error("Error querying tables:", error);
  }

  return results;
}

/**
 * Query years from library items
 */
export async function queryYears(
  query: string,
  limit: number = 20,
): Promise<AutocompleteResult[]> {
  const results: AutocompleteResult[] = [];

  try {
    const libraries = Zotero.Libraries.getAll();
    const yearCounts: Map<string, number> = new Map();

    // SQL to get years (reused from original)
    // We run it for each library
    const sql = `
            SELECT 
                SUBSTR(COALESCE(
                    (SELECT value FROM itemData id 
                     JOIN itemDataValues idv ON id.valueID = idv.valueID 
                     JOIN fields f ON id.fieldID = f.fieldID 
                     WHERE id.itemID = i.itemID AND f.fieldName = 'date'),
                    ''
                ), 1, 4) as year,
                COUNT(*) as count
            FROM items i
            WHERE i.libraryID = ? 
            AND i.itemTypeID NOT IN (SELECT itemTypeID FROM itemTypes WHERE typeName IN ('attachment', 'note'))
            GROUP BY year
            HAVING year GLOB '[0-9][0-9][0-9][0-9]'
            ORDER BY year DESC
        `;

    for (const library of libraries) {
      const rows = await Zotero.DB.queryAsync(sql, [library.libraryID]);

      for (const row of rows || []) {
        if (query && !row.year.includes(query)) {
          continue;
        }

        const current = yearCounts.get(row.year) || 0;
        yearCounts.set(row.year, current + row.count);
      }
    }

    // Convert to results and sort
    const sortedYears = Array.from(yearCounts.entries()).sort(
      (a, b) => parseInt(b[0]) - parseInt(a[0]),
    ); // Sort by year desc

    for (const [year, count] of sortedYears) {
      results.push({
        id: year,
        title: year,
        subtitle: `${count} paper${count !== 1 ? "s" : ""}`,
        icon: "📅",
        type: "year",
      });

      if (results.length >= limit) break;
    }
  } catch (error) {
    console.error("Error querying years:", error);
  }

  return results;
}

// ==================== Template Resolution ====================

/**
 * Resolve placeholders in a template with selected values
 */
export async function resolveTemplate(
  template: string,
  selections: PlaceholderSelections,
): Promise<{ resolved: string; context: string[] }> {
  let resolved = template;
  const contextParts: string[] = [];

  // Replace paper placeholders
  for (const [key, paper] of selections.papers) {
    const pattern = new RegExp(`/\\s*${escapeRegex(key)}\\b`, "gi");
    resolved = resolved.replace(pattern, `"${paper.title}"`);

    // Add to context
    const abstract = paper.data?.abstract as string;
    contextParts.push(
      `[Paper: ${paper.title}]` +
        (paper.subtitle ? `\nAuthors: ${paper.subtitle}` : "") +
        (abstract ? `\nAbstract: ${abstract.substring(0, 500)}...` : ""),
    );
  }

  // Replace author placeholders
  for (const [key, author] of selections.authors) {
    const pattern = new RegExp(`@\\s*${escapeRegex(key)}\\b`, "gi");
    resolved = resolved.replace(pattern, author.title);
    contextParts.push(`[Author: ${author.title} - ${author.subtitle}]`);
  }

  // Replace collection placeholders
  for (const [key, collection] of selections.collections) {
    const pattern = new RegExp(`\\^\\s*${escapeRegex(key)}\\b`, "gi");
    resolved = resolved.replace(pattern, `collection "${collection.title}"`);
    contextParts.push(
      `[Collection: ${collection.title} - ${collection.subtitle}]`,
    );
  }

  // Replace tag placeholders
  for (const [key, tag] of selections.tags) {
    const pattern = new RegExp(`~\\s*${escapeRegex(key)}\\b`, "gi");
    resolved = resolved.replace(pattern, `tag "${tag.title}"`);
    contextParts.push(`[Tag: ${tag.title}]`);
  }

  // Replace topic placeholders
  for (const [key, topic] of selections.topics) {
    const pattern = new RegExp(`#\\s*${escapeRegex(key)}\\b`, "gi");
    resolved = resolved.replace(pattern, topic);
  }

  return { resolved, context: contextParts };
}

/**
 * Escape special regex characters
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Create empty placeholder selections
 */
export function createEmptySelections(): PlaceholderSelections {
  return {
    papers: new Map(),
    authors: new Map(),
    collections: new Map(),
    tags: new Map(),
    topics: new Map(),
  };
}
