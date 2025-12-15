/**
 * Smart Placeholder System
 * Handles placeholder detection, autocomplete queries, and resolution
 */

import { PLACEHOLDER_TRIGGERS, PlaceholderType, extractPlaceholders } from './promptLibrary';

// Re-export PlaceholderType for convenience
export { PlaceholderType } from './promptLibrary';
import { getTableStore } from './tableStore';

// ==================== Types ====================

export interface AutocompleteResult {
    id: string | number;
    title: string;
    subtitle?: string;
    icon?: string;
    type: PlaceholderType;
    data?: Record<string, unknown>;  // Additional data for resolution
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
    topics: Map<string, string>;  // Topics are just strings
}

// Placeholder display info
export const PLACEHOLDER_INFO: Record<PlaceholderType, { icon: string; label: string; color: string }> = {
    topic: { icon: '🎯', label: 'Topic', color: '#9c27b0' },
    paper: { icon: '📄', label: 'Paper', color: '#2196f3' },
    author: { icon: '👤', label: 'Author', color: '#4caf50' },
    collection: { icon: '📁', label: 'Collection', color: '#ff9800' },
    tag: { icon: '🏷️', label: 'Tag', color: '#e91e63' },
    year: { icon: '📅', label: 'Year', color: '#607d8b' },
    table: { icon: '📊', label: 'Table', color: '#009688' },
};

// ==================== Trigger Detection ====================

/**
 * Detect if the cursor is in a placeholder trigger position
 * Returns trigger info if found, null otherwise
 * Supports multi-word queries (e.g., ~my tag, @John Doe)
 * Skips triggers inside brackets [~tag] (confirmed selections)
 */
export function detectTrigger(text: string, cursorPos: number): TriggerInfo | null {
    if (!text || cursorPos <= 0) return null;

    // Check if cursor is inside a bracketed selection [~...] - if so, skip
    let bracketDepth = 0;
    for (let i = cursorPos - 1; i >= 0; i--) {
        if (text[i] === ']') bracketDepth++;
        if (text[i] === '[') {
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
        if (char === ']') {
            break;
        }

        // Check if this position has a trigger character
        if (PLACEHOLDER_TRIGGERS[char]) {
            // Trigger must be at start of text or preceded by whitespace (not inside brackets)
            const prevChar = pos > 0 ? text[pos - 1] : '';
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
    itemId?: number | string
): string {
    const before = text.substring(0, trigger.startPos);
    const after = text.substring(trigger.endPos);

    const maxDisplayLength = 30;
    let displayValue = value;

    // Truncate long values
    if (value.length > maxDisplayLength) {
        displayValue = value.substring(0, maxDisplayLength - 3) + '...';
    }

    // Format: [trigger + displayValue::id] for ID-based lookups
    // Or [trigger + displayValue] for simple values
    const idPart = itemId ? `::${itemId}` : '';
    return before + '[' + trigger.trigger + displayValue + idPart + '] ' + after;
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
    return text.replace(/\[([#/@^~])([^\]]+?)(?:::\d+)?\]/g, '[$1$2]');
}

// ==================== Autocomplete Queries ====================

/**
 * Query papers (Zotero items) matching the search term
 */
export async function queryPapers(query: string, limit: number = 20): Promise<AutocompleteResult[]> {
    const results: AutocompleteResult[] = [];
    const lowerQuery = query.toLowerCase();

    try {
        Zotero.debug(`[seerai] queryPapers: searching for "${query}"`);

        // Get all items from the user's library
        const libraryID = Zotero.Libraries.userLibraryID;
        const s = new Zotero.Search({ libraryID });
        s.addCondition('itemType', 'isNot', 'attachment');
        s.addCondition('itemType', 'isNot', 'note');

        if (query) {
            s.addCondition('quicksearch-titleCreatorYear', 'contains', query);
        }

        const itemIDs = await s.search();
        Zotero.debug(`[seerai] queryPapers: found ${itemIDs.length} item IDs`);

        const items = await Zotero.Items.getAsync(itemIDs.slice(0, limit * 2));

        for (const item of items) {
            const title = item.getField('title') as string;
            const creators = item.getCreators();
            const year = item.getField('year') || item.getField('date')?.substring(0, 4);

            // Additional filtering if query provided
            if (query && !title.toLowerCase().includes(lowerQuery)) {
                const creatorStr = creators.map(c => `${c.firstName} ${c.lastName}`).join(' ').toLowerCase();
                if (!creatorStr.includes(lowerQuery) && !String(year).includes(query)) {
                    continue;
                }
            }

            const firstAuthor = creators[0]
                ? `${creators[0].lastName}${creators.length > 1 ? ' et al.' : ''}`
                : 'Unknown';

            results.push({
                id: item.id,
                title: title || 'Untitled',
                subtitle: `${firstAuthor} (${year || 'n.d.'})`,
                icon: '📄',
                type: 'paper',
                data: {
                    key: item.key,
                    itemType: item.itemType,
                    abstract: item.getField('abstractNote'),
                },
            });

            if (results.length >= limit) break;
        }

        Zotero.debug(`[seerai] queryPapers: returning ${results.length} results`);
    } catch (error) {
        Zotero.debug(`[seerai] Error querying papers: ${error}`);
    }

    return results;
}

/**
 * Query authors (creators) from the library
 */
export async function queryAuthors(query: string, limit: number = 20): Promise<AutocompleteResult[]> {
    const results: AutocompleteResult[] = [];
    const lowerQuery = query.toLowerCase();

    try {
        // Use SQL for efficient author aggregation
        const libraryID = Zotero.Libraries.userLibraryID;
        const sql = `
            SELECT DISTINCT 
                c.lastName, 
                c.firstName,
                COUNT(DISTINCT ic.itemID) as itemCount
            FROM creators c
            JOIN itemCreators ic ON c.creatorID = ic.creatorID
            JOIN items i ON ic.itemID = i.itemID
            WHERE i.libraryID = ?
            GROUP BY c.lastName, c.firstName
            ORDER BY itemCount DESC
            LIMIT 200
        `;

        const rows = await Zotero.DB.queryAsync(sql, [libraryID]);

        for (const row of rows || []) {
            const fullName = `${row.firstName || ''} ${row.lastName || ''}`.trim();

            if (query && !fullName.toLowerCase().includes(lowerQuery)) {
                continue;
            }

            results.push({
                id: `${row.lastName}-${row.firstName}`,
                title: fullName || 'Unknown Author',
                subtitle: `${row.itemCount} paper${row.itemCount > 1 ? 's' : ''}`,
                icon: '👤',
                type: 'author',
                data: {
                    firstName: row.firstName,
                    lastName: row.lastName,
                },
            });

            if (results.length >= limit) break;
        }
    } catch (error) {
        console.error('Error querying authors:', error);
    }

    return results;
}

/**
 * Query collections from the library
 */
export async function queryCollections(query: string, limit: number = 20): Promise<AutocompleteResult[]> {
    const results: AutocompleteResult[] = [];
    const lowerQuery = query.toLowerCase();

    try {
        const libraryID = Zotero.Libraries.userLibraryID;
        const collections = Zotero.Collections.getByLibrary(libraryID);

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
                    path = buildPath(parent) + ' / ' + path;
                }
            }

            collectionPaths.set(collection.id, path);
            return path;
        }

        for (const collection of collections) {
            const path = buildPath(collection);

            if (query && !path.toLowerCase().includes(lowerQuery)) {
                continue;
            }

            const childItems = collection.getChildItems(false);

            results.push({
                id: collection.id,
                title: collection.name,
                subtitle: path !== collection.name ? path : `${childItems.length} items`,
                icon: '📁',
                type: 'collection',
                data: {
                    key: collection.key,
                    itemCount: childItems.length,
                    path,
                },
            });

            if (results.length >= limit) break;
        }

        // Sort by relevance (exact match first, then by item count)
        results.sort((a, b) => {
            const aExact = a.title.toLowerCase() === lowerQuery;
            const bExact = b.title.toLowerCase() === lowerQuery;
            if (aExact !== bExact) return aExact ? -1 : 1;
            return ((b.data?.itemCount as number) || 0) - ((a.data?.itemCount as number) || 0);
        });
    } catch (error) {
        console.error('Error querying collections:', error);
    }

    return results;
}

/**
 * Query tags from the library
 */
export async function queryTags(query: string, limit: number = 20): Promise<AutocompleteResult[]> {
    const results: AutocompleteResult[] = [];
    const lowerQuery = query.toLowerCase();

    try {
        const libraryID = Zotero.Libraries.userLibraryID;
        const tags = await Zotero.Tags.getAll(libraryID);
        const colors = Zotero.Tags.getColors(libraryID);

        // Get tag usage counts
        const tagCounts: Map<string, number> = new Map();
        const sql = `
            SELECT t.name, COUNT(*) as count
            FROM tags t
            JOIN itemTags it ON t.tagID = it.tagID
            JOIN items i ON it.itemID = i.itemID
            WHERE i.libraryID = ?
            GROUP BY t.name
            ORDER BY count DESC
        `;
        const rows = await Zotero.DB.queryAsync(sql, [libraryID]);
        if (rows) {
            for (const row of rows) {
                tagCounts.set((row as { name: string; count: number }).name, (row as { name: string; count: number }).count);
            }
        }

        for (const tag of tags) {
            const tagName = typeof tag === 'string' ? tag : tag.tag;

            if (query && !tagName.toLowerCase().includes(lowerQuery)) {
                continue;
            }

            const color = (colors as Map<string, { color: string; position: number }>).get(tagName);
            const count = tagCounts.get(tagName) || 0;

            results.push({
                id: tagName,
                title: tagName,
                subtitle: `${count} item${count !== 1 ? 's' : ''}`,
                icon: color ? '🔖' : '🏷️',
                type: 'tag',
                data: {
                    color: color?.color,
                    position: color?.position,
                },
            });

            if (results.length >= limit) break;
        }

        // Sort: colored tags first, then by count
        results.sort((a, b) => {
            const aColored = !!(a.data?.color);
            const bColored = !!(b.data?.color);
            if (aColored !== bColored) return aColored ? -1 : 1;

            const aCount = tagCounts.get(a.title) || 0;
            const bCount = tagCounts.get(b.title) || 0;
            return bCount - aCount;
        });
    } catch (error) {
        console.error('Error querying tags:', error);
    }

    return results;
}

/**
 * Query topics (from recent usage or suggestions)
 */
export async function queryTopics(query: string, limit: number = 10): Promise<AutocompleteResult[]> {
    const results: AutocompleteResult[] = [];

    // For topics, we'll provide recent/suggested topics from preferences
    try {
        const recentTopics: string[] = JSON.parse(
            Zotero.Prefs.get('extensions.seer-ai.recentTopics') as string || '[]'
        );

        const lowerQuery = query.toLowerCase();

        for (const topic of recentTopics) {
            if (query && !topic.toLowerCase().includes(lowerQuery)) {
                continue;
            }

            results.push({
                id: topic,
                title: topic,
                subtitle: 'Recent topic',
                icon: '🎯',
                type: 'topic',
            });

            if (results.length >= limit) break;
        }

        // If query is provided and not in results, add it as a suggestion
        if (query && !results.find(r => r.title.toLowerCase() === lowerQuery)) {
            results.unshift({
                id: query,
                title: query,
                subtitle: 'Use this topic',
                icon: '✨',
                type: 'topic',
            });
        }
    } catch (error) {
        console.error('Error querying topics:', error);
        // If no recent topics, just use the query
        if (query) {
            results.push({
                id: query,
                title: query,
                subtitle: 'New topic',
                icon: '🎯',
                type: 'topic',
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
            Zotero.Prefs.get('extensions.seer-ai.recentTopics') as string || '[]'
        );

        // Remove if exists, add to front
        const filtered = recentTopics.filter(t => t.toLowerCase() !== topic.toLowerCase());
        filtered.unshift(topic);

        // Keep max 20
        const trimmed = filtered.slice(0, 20);

        Zotero.Prefs.set('extensions.seer-ai.recentTopics', JSON.stringify(trimmed));
    } catch (error) {
        console.error('Error saving recent topic:', error);
    }
}

/**
 * Get autocomplete results for a placeholder type
 */
export async function getAutocompleteResults(
    type: PlaceholderType,
    query: string,
    limit: number = 20
): Promise<AutocompleteResult[]> {
    switch (type) {
        case 'paper':
            return queryPapers(query, limit);
        case 'author':
            return queryAuthors(query, limit);
        case 'collection':
            return queryCollections(query, limit);
        case 'tag':
            return queryTags(query, limit);
        case 'topic':
            return queryTopics(query, limit);
        case 'year':
            return queryYears(query, limit);
        case 'table':
            return queryTables(query, limit);
        default:
            return [];
    }
}

/**
 * Query tables from table store
 */
export async function queryTables(query: string, limit: number = 20): Promise<AutocompleteResult[]> {
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
                icon: '📊',
                type: 'table',
                data: {
                    rowCount: rowCount,
                    columns: table.columns.map(c => c.name)
                }
            });

            if (results.length >= limit) break;
        }
    } catch (error) {
        console.error('Error querying tables:', error);
    }

    return results;
}

/**
 * Query years from library items
 */
export async function queryYears(query: string, limit: number = 20): Promise<AutocompleteResult[]> {
    const results: AutocompleteResult[] = [];

    try {
        const libraryID = Zotero.Libraries.userLibraryID;
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

        const rows = await Zotero.DB.queryAsync(sql, [libraryID]);

        for (const row of rows || []) {
            if (query && !row.year.includes(query)) {
                continue;
            }

            results.push({
                id: row.year,
                title: row.year,
                subtitle: `${row.count} paper${row.count > 1 ? 's' : ''}`,
                icon: '📅',
                type: 'year',
            });

            if (results.length >= limit) break;
        }
    } catch (error) {
        console.error('Error querying years:', error);
    }

    return results;
}

// ==================== Template Resolution ====================

/**
 * Resolve placeholders in a template with selected values
 */
export async function resolveTemplate(
    template: string,
    selections: PlaceholderSelections
): Promise<{ resolved: string; context: string[] }> {
    let resolved = template;
    const contextParts: string[] = [];

    // Replace paper placeholders
    for (const [key, paper] of selections.papers) {
        const pattern = new RegExp(`/\\s*${escapeRegex(key)}\\b`, 'gi');
        resolved = resolved.replace(pattern, `"${paper.title}"`);

        // Add to context
        const abstract = paper.data?.abstract as string;
        contextParts.push(
            `[Paper: ${paper.title}]` +
            (paper.subtitle ? `\nAuthors: ${paper.subtitle}` : '') +
            (abstract ? `\nAbstract: ${abstract.substring(0, 500)}...` : '')
        );
    }

    // Replace author placeholders
    for (const [key, author] of selections.authors) {
        const pattern = new RegExp(`@\\s*${escapeRegex(key)}\\b`, 'gi');
        resolved = resolved.replace(pattern, author.title);
        contextParts.push(`[Author: ${author.title} - ${author.subtitle}]`);
    }

    // Replace collection placeholders
    for (const [key, collection] of selections.collections) {
        const pattern = new RegExp(`\\^\\s*${escapeRegex(key)}\\b`, 'gi');
        resolved = resolved.replace(pattern, `collection "${collection.title}"`);
        contextParts.push(`[Collection: ${collection.title} - ${collection.subtitle}]`);
    }

    // Replace tag placeholders
    for (const [key, tag] of selections.tags) {
        const pattern = new RegExp(`~\\s*${escapeRegex(key)}\\b`, 'gi');
        resolved = resolved.replace(pattern, `tag "${tag.title}"`);
        contextParts.push(`[Tag: ${tag.title}]`);
    }

    // Replace topic placeholders
    for (const [key, topic] of selections.topics) {
        const pattern = new RegExp(`#\\s*${escapeRegex(key)}\\b`, 'gi');
        resolved = resolved.replace(pattern, topic);
    }

    return { resolved, context: contextParts };
}

/**
 * Escape special regex characters
 */
function escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
