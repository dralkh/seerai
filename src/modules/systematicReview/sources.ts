import {
  SourceSyncRecord,
  SRFolderConfig,
  ZoteroCollectionTreeNode,
  ZoteroLibraryTree,
} from "./types";

interface CollectionRow {
  id: number;
  libraryId: number;
  name: string;
  parentId?: number;
  directItemCount: number;
}

async function getCollectionRows(libraryId: number): Promise<CollectionRow[]> {
  const rows =
    (await Zotero.DB.queryAsync(
      `SELECT C.collectionID AS id,
              C.libraryID AS libraryId,
              C.collectionName AS name,
              C.parentCollectionID AS parentId,
              (
                SELECT COUNT(*)
                FROM collectionItems CI
                JOIN items I ON I.itemID = CI.itemID
                LEFT JOIN deletedItems DI ON DI.itemID = I.itemID
                WHERE CI.collectionID = C.collectionID
                  AND DI.itemID IS NULL
                  AND I.itemTypeID NOT IN (
                    SELECT itemTypeID
                    FROM itemTypes
                    WHERE typeName IN ('attachment', 'note', 'annotation')
                  )
              ) AS directItemCount
       FROM collections C
       LEFT JOIN deletedCollections DC
         ON DC.collectionID = C.collectionID
       WHERE C.libraryID = ?
         AND DC.collectionID IS NULL`,
      [libraryId],
    )) || [];
  return rows.map((row) => ({
    id: Number(row.id),
    libraryId: Number(row.libraryId),
    name: String(row.name),
    parentId: row.parentId ? Number(row.parentId) : undefined,
    directItemCount: Number(row.directItemCount) || 0,
  }));
}

async function getCollectionLibraryId(
  collectionId: number,
): Promise<number | undefined> {
  const value = await Zotero.DB.valueQueryAsync<number>(
    `SELECT C.libraryID
     FROM collections C
     LEFT JOIN deletedCollections DC
       ON DC.collectionID = C.collectionID
     WHERE C.collectionID = ?
       AND DC.collectionID IS NULL`,
    [collectionId],
  );
  return value === false ? undefined : Number(value);
}

function collectionPath(
  row: CollectionRow,
  rows: Map<number, CollectionRow>,
): string {
  const names = [row.name];
  const visited = new Set([row.id]);
  let parentId = row.parentId;
  while (parentId && !visited.has(parentId)) {
    visited.add(parentId);
    const parent = rows.get(parentId);
    if (!parent) break;
    names.unshift(parent.name);
    parentId = parent.parentId;
  }
  return names.join(" / ");
}

function buildCollectionTree(
  rows: CollectionRow[],
): ZoteroCollectionTreeNode[] {
  const sourceRows = new Map(rows.map((row) => [row.id, row]));
  const nodes = new Map<number, ZoteroCollectionTreeNode>();
  for (const row of rows) {
    nodes.set(row.id, {
      id: row.id,
      libraryId: row.libraryId,
      name: row.name,
      path: collectionPath(row, sourceRows),
      parentId: row.parentId,
      directItemCount: row.directItemCount,
      children: [],
    });
  }
  const roots: ZoteroCollectionTreeNode[] = [];
  for (const node of nodes.values()) {
    const parent = node.parentId ? nodes.get(node.parentId) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  const sortNodes = (items: ZoteroCollectionTreeNode[]) => {
    items.sort((a, b) => a.name.localeCompare(b.name));
    items.forEach((item) => sortNodes(item.children));
  };
  sortNodes(roots);
  return roots;
}

async function directRegularItemIds(collectionId: number): Promise<number[]> {
  return Zotero.DB.columnQueryAsync<number>(
    `SELECT CI.itemID
     FROM collectionItems CI
     JOIN items I ON I.itemID = CI.itemID
     LEFT JOIN deletedItems DI ON DI.itemID = I.itemID
     WHERE CI.collectionID = ?
       AND DI.itemID IS NULL
       AND I.itemTypeID NOT IN (
         SELECT itemTypeID
         FROM itemTypes
         WHERE typeName IN ('attachment', 'note', 'annotation')
       )
     ORDER BY CI.itemID`,
    [collectionId],
  );
}

export async function discoverZoteroCollectionTree(
  onWarning?: (message: string) => void,
): Promise<ZoteroLibraryTree[]> {
  if (typeof Zotero === "undefined") return [];
  const libraries = Zotero.Libraries.getAll()
    .filter(
      (library) =>
        library.libraryType === "user" || library.libraryType === "group",
    )
    .sort((a, b) => a.name.localeCompare(b.name));
  const trees: ZoteroLibraryTree[] = [];
  for (const library of libraries) {
    try {
      const rows = await getCollectionRows(library.libraryID);
      trees.push({
        id: library.libraryID,
        name: library.name,
        type: library.libraryType as "user" | "group",
        collections: buildCollectionTree(rows),
      });
    } catch (error) {
      const message = `Could not load ${library.name}: ${
        error instanceof Error ? error.message : String(error)
      }`;
      if (typeof Zotero !== "undefined") {
        Zotero.debug(`[seerai] ${message}`);
      }
      onWarning?.(message);
    }
  }
  return trees;
}

export function sourceConfigFromCollection(
  node: ZoteroCollectionTreeNode,
  libraryName: string,
  existing?: SRFolderConfig,
): SRFolderConfig {
  return {
    id: existing?.id || `col_${node.id}`,
    name: node.name,
    parent: libraryName,
    type: existing?.type || "Database",
    srcLabel: existing?.srcLabel || node.name,
    itemCount: existing?.itemCount || node.directItemCount,
    active: existing?.active ?? true,
    zoteroCollectionId: node.id,
    zoteroLibraryId: node.libraryId,
    parentCollectionId: node.parentId,
    collectionPath: node.path,
    includeSubfolders: existing?.includeSubfolders ?? true,
    available: true,
    lastSyncedAt: existing?.lastSyncedAt,
  };
}

export async function sourceConfigFromCollectionId(
  collectionId: number,
  settings: {
    type: SRFolderConfig["type"];
    srcLabel: string;
    includeSubfolders: boolean;
  },
  existing?: SRFolderConfig,
): Promise<SRFolderConfig> {
  const libraryId = await getCollectionLibraryId(collectionId);
  if (!libraryId) {
    throw new Error(`Zotero folder not found: ${collectionId}`);
  }
  const rows = await getCollectionRows(libraryId);
  const rowsById = new Map(rows.map((row) => [row.id, row]));
  const row = rowsById.get(collectionId);
  if (!row) {
    throw new Error(`Zotero folder not found: ${collectionId}`);
  }
  const library = Zotero.Libraries.get(libraryId);
  const node: ZoteroCollectionTreeNode = {
    id: row.id,
    libraryId: row.libraryId,
    name: row.name,
    path: collectionPath(row, rowsById),
    parentId: row.parentId,
    directItemCount: row.directItemCount,
    children: [],
  };
  return {
    ...sourceConfigFromCollection(
      node,
      (library && library.name) || `Library ${libraryId}`,
      existing,
    ),
    type: settings.type,
    srcLabel: settings.srcLabel.trim() || row.name,
    includeSubfolders: settings.includeSubfolders,
  };
}

export async function collectSourceRecords(
  source: SRFolderConfig,
): Promise<SourceSyncRecord[]> {
  if (!source.zoteroCollectionId) return [];
  const libraryId =
    source.zoteroLibraryId ||
    (await getCollectionLibraryId(source.zoteroCollectionId));
  if (!libraryId) return [];
  const rows = await getCollectionRows(libraryId);
  const root = rows.find((row) => row.id === source.zoteroCollectionId);
  if (!root) return [];
  const children = new Map<number, CollectionRow[]>();
  for (const row of rows) {
    if (!row.parentId) continue;
    const entries = children.get(row.parentId) || [];
    entries.push(row);
    children.set(row.parentId, entries);
  }
  const selected = [root];
  if (source.includeSubfolders) {
    for (let index = 0; index < selected.length; index++) {
      selected.push(...(children.get(selected[index].id) || []));
    }
  }
  const records: SourceSyncRecord[] = [];
  for (const row of selected) {
    for (const paperId of await directRegularItemIds(row.id)) {
      records.push({ paperId, collectionId: row.id });
    }
  }
  return records;
}
