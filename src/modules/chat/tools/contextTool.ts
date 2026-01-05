/**
 * Context Tool Implementation
 * Manages chat context items
 */

import {
    AddToContextParams,
    RemoveFromContextParams,
    ContextParams,
    ContextOperationResult,
    ToolResult,
    AgentConfig,
} from "./toolTypes";
import { ChatContextManager } from "../context/contextManager";
import { ContextItemType } from "../context/contextTypes";

/**
 * Unified context tool dispatcher
 * Routes to add, remove, or list actions based on params.action
 */
export async function executeContext(
    params: ContextParams,
    config: AgentConfig
): Promise<ToolResult> {
    Zotero.debug(`[seerai] Tool: context action=${params.action}`);

    switch (params.action) {
        case "add":
            return executeAddToContext({ items: params.items! }, config);
        case "remove":
            return executeRemoveFromContext({ items: params.items! }, config);
        case "list":
            return executeListContext(config);
        default:
            return {
                success: false,
                error: `Unknown context action: ${(params as any).action}`,
            };
    }
}

/**
 * Execute add_to_context tool
 */
export async function executeAddToContext(
    params: AddToContextParams,
    _config: AgentConfig
): Promise<ToolResult> {
    try {
        const { items } = params;
        Zotero.debug(`[seerai] Tool: add_to_context items=${items.length}`);

        const contextManager = ChatContextManager.getInstance();
        let addedCount = 0;

        for (const item of items) {
            const contextType = item.type as ContextItemType;
            let id: string | number;
            let displayName: string;

            switch (item.type) {
                case "paper":
                    if (!item.id) {
                        Zotero.debug(`[seerai] add_to_context: paper requires id`);
                        continue;
                    }
                    id = item.id;
                    // Get title from Zotero
                    const zItem = Zotero.Items.get(item.id as number);
                    if (!zItem) {
                        Zotero.debug(`[seerai] add_to_context: item ${item.id} not found`);
                        continue;
                    }
                    displayName = (zItem.getField("title") || `Paper ${item.id}`) as string;
                    break;

                case "tag":
                case "author":
                case "topic":
                    if (!item.name) {
                        Zotero.debug(`[seerai] add_to_context: ${item.type} requires name`);
                        continue;
                    }
                    id = item.name;
                    displayName = item.name;
                    break;

                case "collection":
                    if (item.id) {
                        id = item.id;
                        const coll = Zotero.Collections.get(item.id as number);
                        displayName = coll ? coll.name : `Collection ${item.id}`;
                    } else if (item.name) {
                        // Find collection by name
                        const libraryID = Zotero.Libraries.userLibraryID;
                        const collections = Zotero.Collections.getByLibrary(libraryID);
                        const matched = collections.find(
                            (c: any) => c.name.toLowerCase() === item.name!.toLowerCase()
                        );
                        if (!matched) {
                            Zotero.debug(`[seerai] add_to_context: collection "${item.name}" not found`);
                            continue;
                        }
                        id = matched.id;
                        displayName = matched.name;
                    } else {
                        continue;
                    }
                    break;

                case "table":
                    if (!item.id) {
                        Zotero.debug(`[seerai] add_to_context: table requires id`);
                        continue;
                    }
                    id = item.id;
                    displayName = item.name || `Table ${item.id}`;
                    break;

                default:
                    continue;
            }

            // Add to context
            contextManager.addItem(id, contextType, displayName, "command");
            addedCount++;
        }

        // Get current context for response
        const currentItems = contextManager.getItems().map(item => ({
            type: item.type,
            name: item.displayName,
        }));

        const result: ContextOperationResult = {
            added: addedCount,
            current_items: currentItems,
        };

        return {
            success: true,
            data: result,
            summary: `Added ${addedCount} items to context (${currentItems.length} total)`,
        };

    } catch (error) {
        Zotero.debug(`[seerai] Tool: add_to_context error: ${error}`);
        return {
            success: false,
            error: error instanceof Error ? error.message : String(error),
        };
    }
}

/**
 * Execute remove_from_context tool
 */
export async function executeRemoveFromContext(
    params: RemoveFromContextParams,
    _config: AgentConfig
): Promise<ToolResult> {
    try {
        const { items } = params;
        Zotero.debug(`[seerai] Tool: remove_from_context items=${items.length}`);

        const contextManager = ChatContextManager.getInstance();
        let removedCount = 0;

        for (const item of items) {
            if (item.id !== undefined) {
                contextManager.removeItem(item.id, item.type as ContextItemType);
                removedCount++;
            }
        }

        // Get current context for response
        const currentItems = contextManager.getItems().map(item => ({
            type: item.type,
            name: item.displayName,
        }));

        const result: ContextOperationResult = {
            removed: removedCount,
            current_items: currentItems,
        };

        return {
            success: true,
            data: result,
            summary: `Removed ${removedCount} items from context (${currentItems.length} remaining)`,
        };

    } catch (error) {
        Zotero.debug(`[seerai] Tool: remove_from_context error: ${error}`);
        return {
            success: false,
            error: error instanceof Error ? error.message : String(error),
        };
    }
}

/**
 * Execute list_context tool
 */
export async function executeListContext(
    _config: AgentConfig
): Promise<ToolResult> {
    try {
        Zotero.debug(`[seerai] Tool: list_context`);

        const contextManager = ChatContextManager.getInstance();
        const items = contextManager.getItems();

        const currentItems = items.map(item => ({
            type: item.type,
            name: item.displayName,
            id: item.id,
        }));

        // Group by type for summary
        const byType: Record<string, number> = {};
        for (const item of items) {
            byType[item.type] = (byType[item.type] || 0) + 1;
        }

        const typeSummary = Object.entries(byType)
            .map(([type, count]) => `${count} ${type}(s)`)
            .join(", ");

        return {
            success: true,
            data: { items: currentItems, count: currentItems.length },
            summary: currentItems.length > 0
                ? `Context has ${currentItems.length} items: ${typeSummary}`
                : "Context is empty",
        };

    } catch (error) {
        Zotero.debug(`[seerai] Tool: list_context error: ${error}`);
        return {
            success: false,
            error: error instanceof Error ? error.message : String(error),
        };
    }
}
