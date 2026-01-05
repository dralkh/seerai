/**
 * Collection Tool Implementation
 * Helpers for finding collections and moving items between them
 */

import {
    FindCollectionParams,
    FindCollectionResult,
    CreateCollectionParams,
    CreateCollectionResult,
    ListCollectionParams,
    ListCollectionResult,
    MoveItemParams,
    RemoveItemFromCollectionParams,
    CollectionParams,
    ToolResult,
    AgentConfig,
} from "./toolTypes";

/**
 * Unified collection tool dispatcher
 * Routes to find, create, list, add_item, or remove_item actions
 */
export async function executeCollection(
    params: CollectionParams,
    config: AgentConfig
): Promise<ToolResult> {
    Zotero.debug(`[seerai] Tool: collection action=${params.action}`);

    switch (params.action) {
        case "find":
            return executeFindCollection({ name: params.name!, library_id: params.library_id, parent_collection_id: params.parent_id }, config);
        case "create":
            return executeCreateCollection({ name: params.name!, parent_collection_id: params.parent_id, library_id: params.library_id }, config);
        case "list":
            return executeListCollection({ collection_id: params.collection_id! }, config);
        case "add_item":
            // For each item, call executeMoveItem
            if (!params.item_ids || params.item_ids.length === 0) {
                return { success: false, error: "item_ids required for add_item action" };
            }
            let added = 0;
            for (const item_id of params.item_ids) {
                const result = await executeMoveItem({ item_id, target_collection_id: params.collection_id!, remove_from_others: params.remove_from_others }, config);
                if (result.success) added++;
            }
            return { success: true, summary: `Added ${added} item(s) to collection`, data: { added_count: added } };
        case "remove_item":
            if (!params.item_ids || params.item_ids.length === 0) {
                return { success: false, error: "item_ids required for remove_item action" };
            }
            let removed = 0;
            for (const item_id of params.item_ids) {
                const result = await executeRemoveItemFromCollection({ item_id, collection_id: params.collection_id! }, config);
                if (result.success) removed++;
            }
            return { success: true, summary: `Removed ${removed} item(s) from collection`, data: { removed_count: removed } };
        default:
            return { success: false, error: `Unknown collection action: ${(params as any).action}` };
    }
}

/**
 * Helper to get a full path for a collection
 */
function getCollectionPath(collection: Zotero.Collection): string {
    const parts = [collection.name];
    let current = collection;
    while (current.parentID) {
        try {
            const parent = Zotero.Collections.get(current.parentID);
            if (parent) {
                parts.unshift(parent.name);
                current = parent;
            } else {
                break;
            }
        } catch (e) {
            break;
        }
    }
    return parts.join(" / ");
}

/**
 * Execute find_collection tool
 */
export async function executeFindCollection(
    params: FindCollectionParams,
    _config: AgentConfig
): Promise<ToolResult> {
    try {
        const { name, library_id, parent_collection_id } = params;
        const searchName = name.toLowerCase();

        Zotero.debug(`[seerai] Tool: find_collection name="${name}" lib=${library_id} parent=${parent_collection_id}`);

        let collections: Zotero.Collection[] = [];

        if (parent_collection_id) {
            const parent = Zotero.Collections.get(parent_collection_id);
            if (parent) {
                // Get sub-collections
                collections = parent.getChildCollections();
            }
        } else if (library_id) {
            collections = Zotero.Collections.getByLibrary(library_id);
        } else {
            // Search all accessible libraries
            const allLibraries = Zotero.Libraries.getAll();
            for (const lib of allLibraries) {
                if (lib) {
                    collections.push(...Zotero.Collections.getByLibrary(lib.id));
                }
            }
        }

        const results: FindCollectionResult["collections"] = [];
        for (const col of collections) {
            if (col.name.toLowerCase().includes(searchName)) {
                results.push({
                    id: col.id,
                    name: col.name,
                    library_id: col.libraryID,
                    path: getCollectionPath(col)
                });
            }
        }

        // Sort by relevance (exact match first)
        results.sort((a, b) => {
            const aName = a.name.toLowerCase();
            const bName = b.name.toLowerCase();
            if (aName === searchName && bName !== searchName) return -1;
            if (aName !== searchName && bName === searchName) return 1;
            return a.path.length - b.path.length;
        });

        return {
            success: true,
            data: { collections: results.slice(0, 10) },
            summary: `Found ${results.length} collections matching "${name}"`
        };

    } catch (error) {
        Zotero.debug(`[seerai] Tool: find_collection error: ${error}`);
        return {
            success: false,
            error: error instanceof Error ? error.message : String(error)
        };
    }
}

/**
 * Execute create_collection tool
 */
export async function executeCreateCollection(
    params: CreateCollectionParams,
    _config: AgentConfig
): Promise<ToolResult> {
    try {
        const { name, parent_collection_id, library_id } = params;
        const targetLibraryID = library_id || Zotero.Libraries.userLibraryID;
        const searchName = name.toLowerCase();

        let existingCollection: Zotero.Collection | undefined;
        let newCol: Zotero.Collection | undefined;

        if (parent_collection_id) {
            const parent = Zotero.Collections.get(parent_collection_id);
            if (!parent) {
                return { success: false, error: `Parent collection ${parent_collection_id} not found` };
            }
            // Check existing children
            const children = parent.getChildCollections();
            existingCollection = children.find(c => c.name.toLowerCase() === searchName);

            if (!existingCollection) {
                newCol = new Zotero.Collection({
                    name: name,
                    libraryID: parent.libraryID,
                    parentID: parent.id
                });
            }
        } else {
            // Check existing root collections in the library
            const allCollections = Zotero.Collections.getByLibrary(targetLibraryID);
            existingCollection = allCollections.find(c => !c.parentID && c.name.toLowerCase() === searchName);

            if (!existingCollection) {
                newCol = new Zotero.Collection({
                    name: name,
                    libraryID: targetLibraryID
                });
            }
        }

        if (existingCollection) {
            Zotero.debug(`[seerai] Tool: create_collection found existing "${existingCollection.name}" (ID: ${existingCollection.id})`);
            return {
                success: true,
                data: {
                    collection_id: existingCollection.id,
                    name: existingCollection.name
                },
                summary: `Found existing collection "${existingCollection.name}" (ID: ${existingCollection.id})`
            };
        }

        if (newCol) {
            await newCol.saveTx();

            const result: CreateCollectionResult = {
                collection_id: newCol.id,
                name: newCol.name
            };

            return {
                success: true,
                data: result,
                summary: `Created collection "${name}" (ID: ${newCol.id})`
            };
        }

        return { success: false, error: "Failed to create or find collection" };
    } catch (error) {
        Zotero.debug(`[seerai] Tool: create_collection error: ${error}`);
        return {
            success: false,
            error: error instanceof Error ? error.message : String(error)
        };
    }
}

/**
 * Execute list_collection tool
 */
export async function executeListCollection(
    params: ListCollectionParams,
    _config: AgentConfig
): Promise<ToolResult> {
    try {
        const { collection_id } = params;
        const collection = Zotero.Collections.get(collection_id);
        if (!collection) {
            return { success: false, error: `Collection ${collection_id} not found` };
        }

        const items: ListCollectionResult["items"] = [];

        // Add sub-collections
        const subCols = collection.getChildCollections();
        for (const col of subCols) {
            items.push({
                id: col.id,
                title: col.name,
                type: "collection"
            });
        }

        // Add regular items
        const itemIds = collection.getChildItems();
        for (const item of itemIds) {
            if (item) {
                const year = item.getField("year") || item.getField("date")?.toString().substring(0, 4) || "";
                items.push({
                    id: item.id,
                    title: (item.getField("title") || "Untitled") as string,
                    type: item.itemType,
                    details: year
                });
            }
        }

        return {
            success: true,
            data: { items },
            summary: `Listed ${items.length} entries in collection "${collection.name}"`
        };
    } catch (error) {
        Zotero.debug(`[seerai] Tool: list_collection error: ${error}`);
        return {
            success: false,
            error: error instanceof Error ? error.message : String(error)
        };
    }
}

/**
 * Execute move_item tool
 */
export async function executeMoveItem(
    params: MoveItemParams,
    _config: AgentConfig
): Promise<ToolResult> {
    try {
        const { item_id, target_collection_id, remove_from_others } = params;

        Zotero.debug(`[seerai] Tool: move_item item=${item_id} target=${target_collection_id}`);

        const item = Zotero.Items.get(item_id);
        if (!item) {
            return {
                success: false,
                error: `Item with ID ${item_id} not found`
            };
        }

        const targetCollection = Zotero.Collections.get(target_collection_id);
        if (!targetCollection) {
            return {
                success: false,
                error: `Target collection with ID ${target_collection_id} not found`
            };
        }

        // Verify library compatibility
        if (item.libraryID !== targetCollection.libraryID) {
            return {
                success: false,
                error: `Cannot move item across libraries (Item: ${item.libraryID}, Collection: ${targetCollection.libraryID})`
            };
        }

        // Check current collection membership before modifying
        const currentCollections = item.getCollections();
        const wasAlreadyInTarget = currentCollections.includes(target_collection_id);

        // Get collection names for better logging
        const currentCollectionNames = currentCollections.map(colId => {
            const col = Zotero.Collections.get(colId);
            return col ? col.name : `#${colId}`;
        });

        Zotero.debug(`[seerai] Tool: move_item - Item "${item.getField('title')}" is currently in collections: [${currentCollectionNames.join(', ')}]`);

        if (remove_from_others) {
            for (const colId of currentCollections) {
                if (colId !== target_collection_id) {
                    item.removeFromCollection(colId);
                }
            }
        }

        // Always add to target (idempotent - won't duplicate)
        if (!wasAlreadyInTarget) {
            item.addToCollection(target_collection_id);
        }
        await item.saveTx();

        // Build informative summary
        let summary = `Successfully ${wasAlreadyInTarget ? 'confirmed' : 'added'} "${item.getField('title')}" to collection "${targetCollection.name}"`;
        if (wasAlreadyInTarget) {
            summary += ` (item was already a member)`;
        }
        if (remove_from_others && currentCollections.length > 1) {
            const removedCount = wasAlreadyInTarget ? currentCollections.length - 1 : currentCollections.length;
            if (removedCount > 0) {
                summary += `. Removed from ${removedCount} other collection(s)`;
            }
        }
        summary += ".";

        return {
            success: true,
            data: {
                was_already_in_target: wasAlreadyInTarget,
                previous_collections: currentCollectionNames,
            },
            summary
        };

    } catch (error) {
        Zotero.debug(`[seerai] Tool: move_item error: ${error}`);
        return {
            success: false,
            error: error instanceof Error ? error.message : String(error)
        };
    }
}

/**
 * Execute remove_item_from_collection tool
 */
export async function executeRemoveItemFromCollection(
    params: RemoveItemFromCollectionParams,
    _config: AgentConfig
): Promise<ToolResult> {
    try {
        const { item_id, collection_id } = params;

        Zotero.debug(`[seerai] Tool: remove_item_from_collection item=${item_id} col=${collection_id}`);

        const item = Zotero.Items.get(item_id);
        if (!item) {
            return {
                success: false,
                error: `Item with ID ${item_id} not found`
            };
        }

        const collection = Zotero.Collections.get(collection_id);
        if (!collection) {
            return {
                success: false,
                error: `Collection with ID ${collection_id} not found`
            };
        }

        item.removeFromCollection(collection_id);
        await item.saveTx();

        return {
            success: true,
            summary: `Successfully removed "${item.getField('title')}" from collection "${collection.name}".`
        };

    } catch (error) {
        Zotero.debug(`[seerai] Tool: remove_item_from_collection error: ${error}`);
        return {
            success: false,
            error: error instanceof Error ? error.message : String(error)
        };
    }
}
