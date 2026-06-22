import { deduplicateScholarlyPapers, reciprocalRankFusion } from "./merge";
import { scholarlyProviders } from "./providers";
import {
  FederatedSearchResult,
  ProviderSearchState,
  ScholarlyPaper,
  ScholarlyProviderId,
  ScholarlySearchQuery,
  SMART_MODE_PROVIDERS,
} from "./types";

export function selectedProviders(
  query: ScholarlySearchQuery,
): ScholarlyProviderId[] {
  const selected =
    query.mode === "source"
      ? query.providers
      : SMART_MODE_PROVIDERS[query.mode];
  return [...selected];
}

/** Overall ceiling for a federated (smart-mode) fetch across providers. */
export const FEDERATED_RESULT_CAP = 10000;

/** Max records retrievable from a single provider, by retrieval channel. */
export function providerResultCap(
  id: ScholarlyProviderId,
  channel: "live" | "bulk" = "bulk",
): number {
  const caps = scholarlyProviders[id].capabilities;
  return channel === "live"
    ? (caps.maxLiveResults ?? caps.maxBulkResults)
    : caps.maxBulkResults;
}

/**
 * Realistic maximum number of unique records a query can return, used to clamp
 * the "load max / fetch N" controls and the export dialog. In source mode this
 * is the single provider's cap; in smart mode it is the combined provider caps,
 * bounded by {@link FEDERATED_RESULT_CAP}.
 */
export function maxResultsForQuery(
  query: ScholarlySearchQuery,
  channel: "live" | "bulk" = "bulk",
): number {
  const ids = selectedProviders(query).filter((id) =>
    scholarlyProviders[id].isConfigured(),
  );
  if (ids.length === 0) return 0;
  if (query.mode === "source") return providerResultCap(ids[0], channel);
  const combined = ids.reduce(
    (sum, id) => sum + providerResultCap(id, channel),
    0,
  );
  return Math.min(combined, FEDERATED_RESULT_CAP);
}

export async function searchScholarlyPapers(
  query: ScholarlySearchQuery,
  previous: FederatedSearchResult | undefined,
  signal?: AbortSignal,
): Promise<FederatedSearchResult> {
  const selected = selectedProviders(query);
  const ids = selected.filter((id) => scholarlyProviders[id].isConfigured());
  if (query.mode === "source" && ids.length === 0) {
    throw new Error(
      `${scholarlyProviders[query.providers[0]].capabilities.label} requires configuration in Settings`,
    );
  }
  const pages = await Promise.all(
    ids.map(async (id) => {
      const prior = previous?.providers[id];
      if (prior?.exhausted) {
        return { id, page: undefined, error: undefined };
      }
      try {
        const page = await scholarlyProviders[id].search(query, prior?.cursor, {
          signal,
        });
        return { id, page, error: undefined };
      } catch (error) {
        if (signal?.aborted) throw error;
        return {
          id,
          page: undefined,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }),
  );
  const ranked: Partial<Record<ScholarlyProviderId, ScholarlyPaper[]>> = {};
  const states: Partial<Record<ScholarlyProviderId, ProviderSearchState>> = {
    ...(previous?.providers || {}),
  };
  for (const id of selected) {
    if (!ids.includes(id)) {
      states[id] = {
        exhausted: true,
        skippedReason: `${scholarlyProviders[id].capabilities.label} requires setup`,
      };
    }
  }
  for (const result of pages) {
    const existing = previous?.rankedByProvider?.[result.id] || [];
    ranked[result.id] = [...(existing || []), ...(result.page?.items || [])];
    states[result.id] = result.page
      ? {
          cursor: result.page.cursor,
          total: result.page.total,
          exhausted: result.page.exhausted,
          warnings: result.page.warnings,
        }
      : {
          ...(states[result.id] || { exhausted: false }),
          error: result.error,
        };
  }
  let items = reciprocalRankFusion(ranked);
  if (query.sort === "newest" || query.sort === "oldest") {
    const direction = query.sort === "newest" ? -1 : 1;
    items = items.sort(
      (a, b) =>
        direction *
        (a.publicationDate || String(a.year || "")).localeCompare(
          b.publicationDate || String(b.year || ""),
        ),
    );
  } else if (query.sort === "citations") {
    items = items.sort((a, b) => b.citationCount - a.citationCount);
  }
  return {
    requestId: previous?.requestId,
    query,
    items,
    rankedByProvider: ranked,
    providers: states,
  };
}

export async function retryScholarlyProvider(
  session: FederatedSearchResult,
  id: ScholarlyProviderId,
  signal?: AbortSignal,
): Promise<FederatedSearchResult> {
  if (!session.query) throw new Error("Search session has no query snapshot");
  const provider = scholarlyProviders[id];
  if (!provider.isConfigured()) {
    throw new Error(`${provider.capabilities.label} requires setup`);
  }
  const prior = session.providers[id];
  const page = await provider.search(session.query, prior?.cursor, { signal });
  const ranked = {
    ...(session.rankedByProvider || {}),
    [id]: [...(session.rankedByProvider?.[id] || []), ...page.items],
  };
  const providers = {
    ...session.providers,
    [id]: {
      cursor: page.cursor,
      total: page.total,
      exhausted: page.exhausted,
      warnings: page.warnings,
    },
  };
  return {
    ...session,
    items: reciprocalRankFusion(ranked),
    rankedByProvider: ranked,
    providers,
  };
}

export interface BulkExportProgress {
  requested: number;
  unique: number;
  duplicates: number;
  provider?: ScholarlyProviderId;
  providers: Partial<Record<ScholarlyProviderId, ProviderSearchState>>;
}

export async function fetchScholarlyPapersForExport(
  query: ScholarlySearchQuery,
  target: number,
  loaded: ScholarlyPaper[],
  signal?: AbortSignal,
  onProgress?: (progress: BulkExportProgress) => void,
  previous?: FederatedSearchResult,
): Promise<ScholarlyPaper[]> {
  const ids = selectedProviders(query)
    .filter((id) => scholarlyProviders[id].isConfigured())
    .filter((id) => scholarlyProviders[id].capabilities.supportsBulk);
  const papers = deduplicateScholarlyPapers(loaded);
  const states: Partial<Record<ScholarlyProviderId, ProviderSearchState>> = {};
  for (const id of ids) {
    if (!scholarlyProviders[id].bulkSearch && previous?.providers[id]) {
      states[id] = { ...previous.providers[id]! };
    }
  }
  const pages: Partial<Record<ScholarlyProviderId, ScholarlyPaper[]>> = {};
  let rawCount = loaded.length;
  exportLoop: while (papers.length < target) {
    let progressed = false;
    for (const id of ids) {
      if (papers.length >= target) break;
      if (signal?.aborted) break exportLoop;
      const state = states[id];
      if (state?.exhausted) continue;
      try {
        const provider = scholarlyProviders[id];
        const cap = provider.capabilities.maxBulkResults;
        const page = await (provider.bulkSearch || provider.search).call(
          provider,
          { ...query, limit: Math.min(2000, target - papers.length) },
          state?.cursor,
          { signal },
        );
        pages[id] = [...(pages[id] || []), ...page.items];
        rawCount += page.items.length;
        // Stop paging a provider once we've pulled its documented ceiling, so we
        // never request beyond what its API allows (e.g. arXiv 30k, Zenodo 10k).
        const reachedCap = pages[id].length >= cap;
        states[id] = {
          cursor: page.cursor,
          total: page.total,
          exhausted: page.exhausted || page.items.length === 0 || reachedCap,
          warnings: page.warnings,
        };
        progressed = progressed || page.items.length > 0;
        const merged = deduplicateScholarlyPapers([...papers, ...page.items]);
        papers.splice(0, papers.length, ...merged);
      } catch (error) {
        if (signal?.aborted) break exportLoop;
        states[id] = {
          ...(states[id] || { exhausted: true }),
          exhausted: true,
          error: error instanceof Error ? error.message : String(error),
        };
      }
      onProgress?.({
        requested: target,
        unique: Math.min(papers.length, target),
        duplicates: rawCount - papers.length,
        provider: id,
        providers: { ...states },
      });
    }
    if (!progressed || ids.every((id) => states[id]?.exhausted)) break;
  }
  return papers.slice(0, target);
}
