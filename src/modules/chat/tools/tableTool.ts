/**
 * Table Tool Implementation
 * Manages paper analysis tables
 */

import {
    ListTablesParams,
    ListTablesResult,
    CreateTableParams,
    CreateTableResult,
    AddToTableParams,
    AddToTableResult,
    CreateTableColumnParams,
    CreateTableColumnResult,
    GenerateTableDataParams,
    GenerateTableDataResult,
    ReadTableParams,
    ReadTableResult,
    TableParams,
    ToolResult,
    AgentConfig,
} from "./toolTypes";
import { getTableStore } from "../tableStore";
import { TableConfig } from "../tableTypes";

/**
 * Unified table tool dispatcher
 * Routes to list, create, add_papers, add_column, generate, or read actions
 */
export async function executeTable(
    params: TableParams,
    config: AgentConfig
): Promise<ToolResult> {
    Zotero.debug(`[seerai] Tool: table action=${params.action}`);

    switch (params.action) {
        case "list":
            return executeListTables({}, config);
        case "create":
            return executeCreateTable({ name: params.name!, item_ids: params.paper_ids }, config);
        case "add_papers":
            return executeAddToTable({ table_id: params.table_id!, item_ids: params.paper_ids! }, config);
        case "add_column":
            return executeCreateTableColumn({ table_id: params.table_id!, column_name: params.column_name!, ai_prompt: params.ai_prompt! }, config);
        case "generate":
            return executeGenerateTableData({ table_id: params.table_id!, column_id: params.column_id, item_ids: params.item_ids }, config);
        case "read":
            return executeReadTable({ table_id: params.table_id, include_data: params.include_data }, config);
        default:
            return { success: false, error: `Unknown table action: ${(params as any).action}` };
    }
}

// Track the most recently created table ID to handle "active" table lookups correctly
// This solves race conditions when create_table_column is called immediately after create_table
let lastCreatedTableId: string | null = null;
let lastCreatedTableTimestamp: number = 0;

/**
 * Helper to find a table by ID with fallbacks
 */
async function findTable(tableId: string | undefined): Promise<any | null> {
    const tableStore = getTableStore();
    const allTables = await tableStore.getAllTables();

    if (allTables.length === 0) return null;

    // Sort by recency
    allTables.sort((a: any, b: any) =>
        new Date(b.updatedAt || 0).getTime() - new Date(a.updatedAt || 0).getTime()
    );

    if (!tableId || tableId === "undefined" || tableId === "null" || tableId === "active") {
        // CRITICAL FIX: If we have a recently created table (within last 30 seconds),
        // prioritize it over the "most recently updated" which could be a different table
        const timeSinceCreation = Date.now() - lastCreatedTableTimestamp;
        if (lastCreatedTableId && timeSinceCreation < 30000) {
            const recentlyCreated = allTables.find((t: any) => t.id === lastCreatedTableId);
            if (recentlyCreated) {
                Zotero.debug(`[seerai] findTable: Using recently created table ${lastCreatedTableId} (created ${timeSinceCreation}ms ago)`);
                return recentlyCreated;
            }
        }
        return allTables[0];
    }

    // Direct match
    let table = allTables.find((t: any) => t.id === tableId);
    if (table) return table;

    // Try fuzzy match (e.g. if AI uses t_ instead of table_)
    table = allTables.find((t: any) => {
        const id = t.id.toLowerCase();
        const searchId = tableId.toLowerCase();
        return id.includes(searchId) || searchId.includes(id) ||
            id.replace("table_", "") === searchId.replace("t_", "");
    });

    if (table) return table;

    // Fallback to most recent if only one table exists
    if (allTables.length === 1) return allTables[0];

    return null;
}

/**
 * Execute list_tables tool
 */
export async function executeListTables(
    _params: ListTablesParams,
    _config: AgentConfig
): Promise<ToolResult> {
    try {
        Zotero.debug(`[seerai] Tool: list_tables`);

        const tableStore = getTableStore();
        const allTables = await tableStore.getAllTables();

        // Sort by updatedAt descending so the AI sees the most recent first
        allTables.sort((a: any, b: any) =>
            new Date(b.updatedAt || 0).getTime() - new Date(a.updatedAt || 0).getTime()
        );

        const tables: ListTablesResult["tables"] = allTables.map((table: any) => ({
            id: table.id,
            name: table.name || "Unnamed Table",
            columns: table.columns?.map((c: any) => c.name || c.title || c.id) || [],
            item_count: table.addedPaperIds?.length || 0,
        }));

        const result: ListTablesResult = { tables };

        return {
            success: true,
            data: result,
            summary: `Found ${tables.length} table(s)${tables.length > 0 ? `, most recent: "${tables[0].name}"` : ""}`,
        };

    } catch (error) {
        Zotero.debug(`[seerai] Tool: list_tables error: ${error}`);
        return {
            success: false,
            error: error instanceof Error ? error.message : String(error),
        };
    }
}

/**
 * Execute create_table tool
 */
export async function executeCreateTable(
    params: CreateTableParams,
    _config: AgentConfig
): Promise<ToolResult> {
    try {
        const { name, item_ids } = params;
        Zotero.debug(`[seerai] Tool: create_table name="${name}" items=${item_ids?.length || 0}`);

        const tableStore = getTableStore();

        // We want a FRESH table
        const now = new Date().toISOString();
        const newTable: any = {
            id: `table_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
            name: name,
            columns: [
                { id: 'title', name: 'Title', width: 200, minWidth: 100, visible: true, sortable: true, resizable: true, type: 'text' },
                { id: 'author', name: 'Author', width: 150, minWidth: 80, visible: true, sortable: true, resizable: true, type: 'text' },
                { id: 'year', name: 'Year', width: 60, minWidth: 50, visible: true, sortable: true, resizable: true, type: 'text' }
            ],
            addedPaperIds: item_ids || [],
            createdAt: now,
            updatedAt: now,
            pageSize: 25,
            currentPage: 1,
            responseLength: 100
        };

        await tableStore.saveConfig(newTable);

        // Track this as the most recently created table for "active" lookups
        lastCreatedTableId = newTable.id;
        lastCreatedTableTimestamp = Date.now();
        Zotero.debug(`[seerai] create_table: Tracked new table ${newTable.id} as lastCreatedTableId`);

        const result: CreateTableResult = {
            table_id: newTable.id,
            name: newTable.name,
        };

        return {
            success: true,
            data: result,
            summary: `Created new table "${name}" with ${newTable.addedPaperIds.length} papers.`,
        };

    } catch (error) {
        Zotero.debug(`[seerai] Tool: create_table error: ${error}`);
        return {
            success: false,
            error: error instanceof Error ? error.message : String(error),
        };
    }
}

/**
 * Execute add_to_table tool
 */
export async function executeAddToTable(
    params: AddToTableParams,
    _config: AgentConfig
): Promise<ToolResult> {
    try {
        const { table_id, item_ids } = params;
        Zotero.debug(`[seerai] Tool: add_to_table table=${table_id} items=${item_ids.length}`);

        const table = await findTable(table_id);
        if (!table) {
            return {
                success: false,
                error: `Table with ID "${table_id}" not found. Try list_tables to see available tables.`,
            };
        }

        const tableStore = getTableStore();
        let addedCount = 0;
        let totalCount = 0;

        // Use atomic update to prevent race conditions
        const updatedTable = await tableStore.updateTable(table.id, (t) => {
            if (!t.addedPaperIds) t.addedPaperIds = [];

            // Add only unique IDs
            const existingIds = new Set(t.addedPaperIds);
            for (const id of item_ids) {
                if (!existingIds.has(id)) {
                    t.addedPaperIds.push(id);
                    addedCount++;
                }
            }
            totalCount = t.addedPaperIds.length;
        });

        if (!updatedTable) {
            return {
                success: false,
                error: `Failed to update table "${table.id}"`,
            };
        }

        const result: AddToTableResult = {
            table_id: table.id,
            added_count: addedCount,
        };

        return {
            success: true,
            data: result,
            summary: `Added ${addedCount} new papers to table "${updatedTable.name || table.id}" (Total: ${totalCount})`,
        };

    } catch (error) {
        Zotero.debug(`[seerai] Tool: add_to_table error: ${error}`);
        return {
            success: false,
            error: error instanceof Error ? error.message : String(error),
        };
    }
}

/**
 * Execute create_table_column tool
 */
export async function executeCreateTableColumn(
    params: CreateTableColumnParams,
    _config: AgentConfig
): Promise<ToolResult> {
    try {
        const { table_id, column_name, ai_prompt } = params;
        Zotero.debug(`[seerai] Tool: create_table_column table=${table_id} name="${column_name}"`);

        // First, find the table to get its ID (handles aliases like "active")
        const table = await findTable(table_id);
        if (!table) {
            return {
                success: false,
                error: `Table with ID "${table_id}" not found. Use create_table first if you want to start a new analysis.`,
            };
        }

        const tableStore = getTableStore();

        // Generate unique column ID with random suffix to prevent collisions in parallel execution
        const columnId = `col_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;

        // Create new column matching TableColumn interface
        const newColumn = {
            id: columnId,
            name: column_name,
            width: 150,
            minWidth: 80,
            visible: true,
            sortable: false,
            resizable: true,
            type: 'computed' as const,
            computeFrom: 'note_content',
            aiPrompt: ai_prompt,
        };

        // Use atomic update to prevent race conditions when multiple columns are created concurrently
        const updatedTable = await tableStore.updateTable(table.id, (t) => {
            if (!t.columns) {
                t.columns = [];
            }
            t.columns.push(newColumn);
        });

        if (!updatedTable) {
            return {
                success: false,
                error: `Failed to update table "${table.id}"`,
            };
        }

        const result: CreateTableColumnResult = {
            column_id: columnId,
            table_id: table.id,
            column_name: column_name,
        };

        return {
            success: true,
            data: result,
            summary: `Created column "${column_name}" in table "${updatedTable.name || table.id}"`,
        };

    } catch (error) {
        Zotero.debug(`[seerai] Tool: create_table_column error: ${error}`);
        return {
            success: false,
            error: error instanceof Error ? error.message : String(error),
        };
    }
}

/**
 * Execute generate_table_data tool
 * Note: This is a simplified version - full generation would require 
 * more complex async handling and progress tracking
 */
export async function executeGenerateTableData(
    params: GenerateTableDataParams,
    _config: AgentConfig
): Promise<ToolResult> {
    try {
        const { table_id, column_id, item_ids } = params;
        Zotero.debug(`[seerai] Tool: generate_table_data table=${table_id} column=${column_id || 'all'}`);

        // Wait for table persistence to complete
        // The 200ms delay helps ensure create_table has finished saving
        await new Promise(resolve => setTimeout(resolve, 200));

        // Force a fresh read from disk to get the most up-to-date table state
        const table = await findTable(table_id);
        if (!table) {
            return {
                success: false,
                error: `Table with ID "${table_id}" not found`,
            };
        }

        const tableStore = getTableStore();

        // Debug: Log available columns for troubleshooting
        Zotero.debug(`[seerai] Tool: generate_table_data - table has ${table.columns?.length || 0} columns`);
        table.columns?.forEach((c: any) => {
            Zotero.debug(`[seerai]   Column: id=${c.id}, name=${c.name}, type=${c.type}, aiPrompt=${!!c.aiPrompt}`);
        });

        // Determine which columns to generate
        const columnsToGenerate = column_id
            ? table.columns?.filter((c: any) => c.id === column_id)
            : table.columns?.filter((c: any) => c.type === "ai-generated" || c.aiPrompt || c.type === "computed");

        if (!columnsToGenerate || columnsToGenerate.length === 0) {
            return {
                success: false,
                error: "No AI-generated columns found to generate data for",
            };
        }

        // Determine which items to process
        const itemsToProcess = item_ids || table.addedPaperIds || [];

        if (itemsToProcess.length === 0) {
            return {
                success: false,
                error: "No items in table to generate data for",
            };
        }

        // Actually generate the data using AI
        Zotero.debug(`[seerai] Tool: generate_table_data - Starting AI generation for ${columnsToGenerate.length} columns × ${itemsToProcess.length} items`);

        // Import and call the generation method
        const { Assistant } = await import("../../assistant");
        const result = await Assistant.generateDataForTable(
            table.id,
            itemsToProcess.length > 0 ? itemsToProcess : undefined,
            columnsToGenerate.map((c: any) => c.id)
        );

        const columnNames = columnsToGenerate.map((c: any) => c.name).join(', ');

        if (result.errors.length > 0) {
            Zotero.debug(`[seerai] Tool: generate_table_data completed with ${result.errors.length} errors`);
        }

        const toolResult: GenerateTableDataResult = {
            generated_count: result.generatedCount,
            table_id: table.id,
        };

        return {
            success: true,
            data: toolResult,
            summary: `Generated ${result.generatedCount} cells for columns "${columnNames}". ${result.errors.length > 0 ? `${result.errors.length} errors occurred.` : 'View results in the Table tab.'}`
        };

    } catch (error) {
        Zotero.debug(`[seerai] Tool: generate_table_data error: ${error}`);
        return {
            success: false,
            error: error instanceof Error ? error.message : String(error),
        };
    }
}

/**
 * Execute read_table tool - reads complete table structure and data
 */
export async function executeReadTable(
    params: ReadTableParams,
    _config: AgentConfig
): Promise<ToolResult> {
    try {
        const { table_id, include_data = true } = params;

        Zotero.debug(`[seerai] Tool: read_table - table_id=${table_id || 'active'} include_data=${include_data}`);

        // Find the table
        const table = await findTable(table_id);

        if (!table) {
            return {
                success: false,
                error: table_id
                    ? `Table with ID ${table_id} not found`
                    : "No tables exist. Create a table first with create_table.",
            };
        }

        // Get default columns if none defined
        const defaultColumns = [
            { id: "title", name: "Title" },
            { id: "author", name: "Authors" },
            { id: "year", name: "Year" },
        ];

        const columns = table.columns && table.columns.length > 0
            ? table.columns.map((col: any) => ({
                id: col.id,
                name: col.name,
                ai_prompt: col.aiPrompt || undefined,
            }))
            : defaultColumns;

        // Build rows with data
        const rows: ReadTableResult['rows'] = [];
        const paperIds = table.addedPaperIds || [];
        const generatedData = table.generatedData || {};

        for (const paperId of paperIds) {
            const item = Zotero.Items.get(paperId);
            if (!item) continue;

            const title = (item.getField("title") as string) || "Untitled";
            const rowData: Record<string, string> = {};

            if (include_data) {
                // Add standard columns
                const creators = item.getCreators();
                rowData["title"] = title;
                rowData["author"] = creators
                    .map((c: any) => `${c.firstName || ""} ${c.lastName || ""}`.trim())
                    .join(", ") || "Unknown";
                rowData["year"] = (item.getField("year") as string) || "";

                // Add generated data for AI columns
                const paperData = generatedData[paperId] || {};
                for (const [colId, value] of Object.entries(paperData)) {
                    rowData[colId] = String(value || "");
                }
            }

            rows.push({
                item_id: paperId,
                title,
                data: rowData,
            });
        }

        const result: ReadTableResult = {
            table_id: table.id,
            name: table.name,
            columns,
            rows,
            total_rows: rows.length,
        };

        // Build summary for AI
        const columnSummary = columns.map((c: any) => c.name).join(", ");
        const dataCells = include_data ? Object.keys(rows[0]?.data || {}).length * rows.length : 0;

        return {
            success: true,
            data: result,
            summary: `Table "${table.name}" contains ${rows.length} papers with ${columns.length} columns (${columnSummary}). ${include_data ? `${dataCells} data cells included.` : "Structure only."}`
        };

    } catch (error) {
        Zotero.debug(`[seerai] Tool: read_table error: ${error}`);
        return {
            success: false,
            error: error instanceof Error ? error.message : String(error),
        };
    }
}
