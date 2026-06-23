import { SearchState, defaultSearchState } from "../chat/tableTypes";
import { FederatedSearchResult, ScholarlyPaper } from "./types";

export interface PersistedSearchHistoryEntry {
  schemaVersion: 2;
  id: string;
  query: string;
  state: SearchState;
  results: ScholarlyPaper[];
  totalResults: number;
  searchToken: string | null;
  savedAt: string;
  session?: FederatedSearchResult;
}

export function migrateSearchHistoryData(input: unknown): {
  entries: PersistedSearchHistoryEntry[];
  migrated: boolean;
} {
  if (!Array.isArray(input)) return { entries: [], migrated: false };
  let migrated = false;
  const entries = input.flatMap((value: any): PersistedSearchHistoryEntry[] => {
    if (!value || typeof value.query !== "string" || !value.state) return [];
    // Entries written before the multi-provider schema (v2) came from the
    // Semantic Scholar-only era; pin their mode/provider to that source so they
    // migrate sensibly rather than inheriting the current default provider.
    const isLegacy = value.schemaVersion !== 2;
    const state: SearchState = {
      ...defaultSearchState,
      ...(isLegacy
        ? { mode: "source" as const, provider: "semantic-scholar" as const }
        : {}),
      ...value.state,
      providerFilters: value.state.providerFilters || {},
    };
    const results = (Array.isArray(value.results) ? value.results : [])
      .filter((paper: any) => paper && typeof paper.title === "string")
      .map((paper: any): ScholarlyPaper => {
        if (paper.source && Array.isArray(paper.sources)) return paper;
        migrated = true;
        return {
          ...paper,
          source: "semantic-scholar",
          sources: ["semantic-scholar"],
          providerIds: { "semantic-scholar": paper.paperId },
        };
      });
    if (value.schemaVersion !== 2) migrated = true;
    return [
      {
        schemaVersion: 2,
        id: String(value.id || `search_${Date.now()}`),
        query: value.query,
        state,
        results,
        totalResults: Number(value.totalResults) || results.length,
        searchToken: value.searchToken || null,
        savedAt: value.savedAt || new Date().toISOString(),
        session: value.session,
      },
    ];
  });
  return { entries, migrated };
}
