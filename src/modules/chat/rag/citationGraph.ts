/**
 * Citation Graph Traversal for RAG.
 *
 * Expands retrieval scope by following Zotero's native item relations
 * (dc:relation prediates) to discover cited and citing papers.
 */

function parseZoteroURI(uri: string): {
  libraryType: "users" | "groups";
  libraryID: number;
  itemKey: string;
} | null {
  const match = uri.match(
    /^https?:\/\/zotero\.org\/(users|groups)\/(\d+)\/items\/([A-Z0-9]+)$/i,
  );
  if (!match) return null;
  return {
    libraryType: match[1] as "users" | "groups",
    libraryID: parseInt(match[2], 10),
    itemKey: match[3],
  };
}

function resolveZoteroURI(uri: string): number | null {
  const parsed = parseZoteroURI(uri);
  if (!parsed) return null;
  try {
    const item = Zotero.Items.getByLibraryAndKey(
      parsed.libraryID,
      parsed.itemKey,
    );
    return item ? item.id : null;
  } catch {
    return null;
  }
}

function getItemCitations(itemId: number): number[] {
  const item = Zotero.Items.get(itemId);
  if (!item) return [];

  const citedIds: number[] = [];

  try {
    const uris = item.getRelationsByPredicate("dc:relation");
    for (const uri of uris) {
      const resolved = resolveZoteroURI(uri);
      if (resolved && resolved !== itemId && !citedIds.includes(resolved)) {
        citedIds.push(resolved);
      }
    }
  } catch {
    // getRelationsByPredicate may not exist on all item types
  }

  if ("relatedItems" in item && Array.isArray((item as any).relatedItems)) {
    const relatedKeys = (item as any).relatedItems as string[];
    try {
      for (const key of relatedKeys) {
        const relatedItem = Zotero.Items.getByLibraryAndKey(
          item.libraryID,
          key,
        );
        if (
          relatedItem &&
          relatedItem.id !== itemId &&
          !citedIds.includes(relatedItem.id)
        ) {
          citedIds.push(relatedItem.id);
        }
      }
    } catch {
      // libraryID may not exist on all item types
    }
  }

  return citedIds;
}

export function traverseCitationGraph(
  startIds: number[],
  hops: number,
): number[] {
  if (hops <= 0) return [];

  const visited = new Set(startIds);
  let frontier = [...startIds];
  const discovered: number[] = [];

  for (let hop = 0; hop < hops; hop++) {
    const nextFrontier: number[] = [];

    for (const itemId of frontier) {
      const citations = getItemCitations(itemId);
      for (const citedId of citations) {
        if (!visited.has(citedId)) {
          visited.add(citedId);
          discovered.push(citedId);
          nextFrontier.push(citedId);
        }
      }
    }

    frontier = nextFrontier;
    if (frontier.length === 0) break;
  }

  return discovered;
}
