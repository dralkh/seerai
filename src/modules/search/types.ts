export type ScholarlyProviderId =
  | "semantic-scholar"
  | "arxiv"
  | "pubmed"
  | "biorxiv"
  | "medrxiv"
  | "iacr"
  | "europe-pmc"
  | "core"
  | "base"
  | "zenodo"
  | "hal";

export type ScholarlySearchMode =
  | "broad"
  | "biomedical"
  | "preprints"
  | "cryptography"
  | "repositories"
  | "source";

export type ScholarlyQueryKind = "keyword" | "keyword-or-browse";

export interface ScholarlyAuthor {
  name: string;
  authorId?: string;
  orcid?: string;
}

export interface ScholarlyPaper {
  paperId: string;
  source: ScholarlyProviderId;
  sources: ScholarlyProviderId[];
  title: string;
  abstract?: string;
  year?: number;
  publicationDate?: string;
  updatedDate?: string;
  citationCount: number;
  citationCounts?: Partial<Record<ScholarlyProviderId, number>>;
  authors: ScholarlyAuthor[];
  openAccessPdf?: { url: string; status?: string };
  url: string;
  venue?: string;
  publisher?: string;
  volume?: string;
  issue?: string;
  pages?: string;
  publicationTypes?: string[];
  fieldsOfStudy?: string[];
  keywords?: string[];
  license?: string;
  tldr?: { model: string; text: string };
  externalIds?: {
    DOI?: string;
    PMID?: string;
    PMCID?: string;
    ArXiv?: string;
    IACR?: string;
    HAL?: string;
    CORE?: string;
    Zenodo?: string;
    CorpusId?: number;
    [key: string]: string | number | undefined;
  };
  providerIds?: Partial<Record<ScholarlyProviderId, string>>;
}

export interface ScholarlyCommonFilters {
  yearStart?: string;
  yearEnd?: string;
  openAccess?: boolean;
  hasPdf?: boolean;
  publicationTypes?: string[];
  fieldsOfStudy?: string[];
  minCitationCount?: number;
  venue?: string;
}

export interface ScholarlySearchQuery {
  text: string;
  mode: ScholarlySearchMode;
  providers: ScholarlyProviderId[];
  limit: number;
  sort: "relevance" | "newest" | "oldest" | "citations";
  filters: ScholarlyCommonFilters;
  providerFilters: Partial<
    Record<ScholarlyProviderId, Record<string, unknown>>
  >;
}

export interface ProviderPage {
  items: ScholarlyPaper[];
  total?: number;
  cursor?: string;
  exhausted: boolean;
  warnings?: string[];
}

export interface ProviderCapabilities {
  id: ScholarlyProviderId;
  label: string;
  description: string;
  queryKind: ScholarlyQueryKind;
  supportsAutocomplete?: boolean;
  supportsOpenAccess?: boolean;
  supportsPdfFilter?: boolean;
  supportsYearRange?: boolean;
  supportsCitationSort?: boolean;
  supportsBulk: boolean;
  maxBulkResults: number;
  requiresConfiguration?: boolean;
  experimental?: boolean;
  stability?: "stable" | "experimental";
  authentication?: "none" | "optional" | "required-or-whitelisted";
  filters?: string[];
  sorts?: ScholarlySearchQuery["sort"][];
}

export type ProviderReadinessStatus =
  | "ready"
  | "anonymous"
  | "configured"
  | "locked"
  | "experimental";

export interface ProviderReadiness {
  status: ProviderReadinessStatus;
  message: string;
}

export interface ProviderConnectionResult {
  ok: boolean;
  readiness: ProviderReadiness;
  latencyMs?: number;
  error?: string;
}

export interface ProviderContext {
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
}

export interface ScholarlySearchProvider {
  readonly capabilities: ProviderCapabilities;
  isConfigured(): boolean;
  getReadiness?(): ProviderReadiness;
  testConnection?(signal?: AbortSignal): Promise<ProviderConnectionResult>;
  autocomplete?(query: string, signal?: AbortSignal): Promise<string[]>;
  search(
    query: ScholarlySearchQuery,
    cursor: string | undefined,
    context: ProviderContext,
  ): Promise<ProviderPage>;
  bulkSearch?(
    query: ScholarlySearchQuery,
    cursor: string | undefined,
    context: ProviderContext,
  ): Promise<ProviderPage>;
}

export interface ProviderSearchState {
  cursor?: string;
  total?: number;
  exhausted: boolean;
  error?: string;
  warnings?: string[];
  skippedReason?: string;
}

export interface FederatedSearchResult {
  requestId?: string;
  query?: ScholarlySearchQuery;
  items: ScholarlyPaper[];
  rankedByProvider?: Partial<Record<ScholarlyProviderId, ScholarlyPaper[]>>;
  providers: Partial<Record<ScholarlyProviderId, ProviderSearchState>>;
}

export const SMART_MODE_PROVIDERS: Record<
  Exclude<ScholarlySearchMode, "source">,
  ScholarlyProviderId[]
> = {
  broad: ["semantic-scholar", "core", "hal", "zenodo", "base"],
  biomedical: ["pubmed", "europe-pmc"],
  preprints: ["arxiv", "biorxiv", "medrxiv", "iacr"],
  cryptography: ["iacr", "arxiv", "semantic-scholar"],
  repositories: ["core", "hal", "zenodo", "base"],
};
