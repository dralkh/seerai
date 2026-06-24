import {
  compileQueriesForProviders,
  ScholarlyProviderId,
  ScholarlySearchMode,
  ScholarlySearchQuery,
  SMART_MODE_PROVIDERS,
} from "../../search";
import type { SearchExternalParams } from "./toolTypes";

export const SCHOLARLY_PROVIDER_IDS: ScholarlyProviderId[] = [
  "semantic-scholar",
  "arxiv",
  "pubmed",
  "biorxiv",
  "medrxiv",
  "iacr",
  "europe-pmc",
  "core",
  "base",
  "zenodo",
  "hal",
];

export const SCHOLARLY_SEARCH_MODES: ScholarlySearchMode[] = [
  "broad",
  "biomedical",
  "preprints",
  "cryptography",
  "repositories",
  "source",
];

function parseYearRange(year: string | undefined): {
  yearStart?: string;
  yearEnd?: string;
} {
  const trimmed = year?.trim();
  if (!trimmed) return {};
  const single = trimmed.match(/^(\d{4})$/);
  if (single) return { yearStart: single[1], yearEnd: single[1] };
  const range = trimmed.match(/^(\d{4})?\s*-\s*(\d{4})?$/);
  if (!range) return {};
  return {
    yearStart: range[1],
    yearEnd: range[2],
  };
}

function selectedToolProviders(params: SearchExternalParams): {
  mode: ScholarlySearchMode;
  providers: ScholarlyProviderId[];
  activeProviders: ScholarlyProviderId[];
} {
  const explicitProviders =
    params.providers && params.providers.length > 0
      ? params.providers
      : params.provider
        ? [params.provider]
        : undefined;
  if (explicitProviders) {
    return {
      mode: "source",
      providers: explicitProviders,
      activeProviders: explicitProviders,
    };
  }
  const mode = params.mode || "source";
  if (mode === "source") {
    return {
      mode,
      providers: ["semantic-scholar"],
      activeProviders: ["semantic-scholar"],
    };
  }
  return {
    mode,
    providers: [],
    activeProviders: SMART_MODE_PROVIDERS[mode],
  };
}

export function buildExternalSearchQuery(
  params: SearchExternalParams,
): ScholarlySearchQuery {
  const selection = selectedToolProviders(params);
  const year = parseYearRange(params.year);
  const inputFilters = params.filters || {};
  const yearStart =
    inputFilters.yearStart ||
    inputFilters.year_from?.toString() ||
    year.yearStart;
  const yearEnd =
    inputFilters.yearEnd || inputFilters.year_to?.toString() || year.yearEnd;
  const openAccess =
    inputFilters.openAccess ?? (params.openAccessPdf ? true : undefined);
  const hasPdf =
    inputFilters.hasPdf ?? (params.openAccessPdf ? true : undefined);
  const providerQueries =
    params.concepts && params.concepts.length > 0
      ? compileQueriesForProviders(
          {
            groups: params.concepts,
            exclude: params.exclude,
            field: params.field,
          },
          selection.activeProviders,
        )
      : undefined;

  return {
    text: params.query,
    providerQueries,
    mode: selection.mode,
    providers: selection.providers,
    limit: Math.min(params.limit || 10, 100),
    sort: params.sort || "relevance",
    filters: {
      yearStart,
      yearEnd,
      openAccess,
      hasPdf,
      fieldsOfStudy: inputFilters.fieldsOfStudy,
      publicationTypes: inputFilters.publicationTypes,
      minCitationCount: inputFilters.minCitationCount,
      venue: inputFilters.venue,
    },
    providerFilters: params.providerFilters || {},
  };
}
