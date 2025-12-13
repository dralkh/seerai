/**
 * Semantic Scholar API Service
 * Provides methods for searching papers, getting details, and recommendations
 * 
 * API Documentation: https://api.semanticscholar.org/api-docs/
 * Rate Limit: 1 request per second with API key
 */

import { config } from "../../package.json";

// ==================== Types ====================

export interface SemanticScholarAuthor {
    authorId: string;
    name: string;
}

export interface SemanticScholarOpenAccessPdf {
    url: string;
    status?: string;
}

export interface SemanticScholarPaper {
    paperId: string;
    corpusId?: number;
    title: string;
    abstract?: string;
    year?: number;
    citationCount: number;
    authors: SemanticScholarAuthor[];
    openAccessPdf?: SemanticScholarOpenAccessPdf;
    url: string;
    venue?: string;
    publicationTypes?: string[];
    publicationDate?: string;
    externalIds?: {
        DOI?: string;
        PMID?: string;
        ArXiv?: string;
        MAG?: string;
        CorpusId?: number;
    };
    fieldsOfStudy?: string[];
    s2FieldsOfStudy?: { category: string; source: string }[];
    tldr?: {
        model: string;
        text: string;
    };
}

export interface SearchOptions {
    query: string;
    limit?: number;          // 1-100, default 20
    offset?: number;         // For pagination
    year?: string;           // "2020-2024" or "2023-" or "-2020"
    openAccessPdf?: boolean; // Filter for papers with PDFs
    fieldsOfStudy?: string[];
    publicationTypes?: string[];
    minCitationCount?: number;
    venue?: string;
    sort?: 'relevance' | 'citationCount:desc' | 'publicationDate:desc' | 'citationCount:asc' | 'publicationDate:asc';
}

export interface SearchResult {
    total: number;
    offset: number;
    next?: number;
    data: SemanticScholarPaper[];
}

export interface BulkSearchResult {
    total: number;
    token?: string;          // Continuation token for pagination
    data: SemanticScholarPaper[];
}

// Fields of study supported by Semantic Scholar
export const FIELDS_OF_STUDY = [
    "Computer Science",
    "Medicine",
    "Chemistry",
    "Biology",
    "Materials Science",
    "Physics",
    "Geology",
    "Psychology",
    "Art",
    "History",
    "Geography",
    "Sociology",
    "Business",
    "Political Science",
    "Economics",
    "Philosophy",
    "Mathematics",
    "Engineering",
    "Environmental Science",
    "Agricultural and Food Sciences",
    "Education",
    "Law",
    "Linguistics",
] as const;

// Publication types supported by Semantic Scholar
export const PUBLICATION_TYPES = [
    "Review",
    "JournalArticle",
    "CaseReport",
    "ClinicalTrial",
    "Conference",
    "Dataset",
    "Editorial",
    "LettersAndComments",
    "MetaAnalysis",
    "News",
    "Study",
    "Book",
    "BookSection",
] as const;

// ==================== Service Class ====================

class SemanticScholarService {
    private readonly baseUrl = "https://api.semanticscholar.org/graph/v1";
    private readonly recommendationsUrl = "https://api.semanticscholar.org/recommendations/v1";

    // Rate limiting: queue requests to stay under 1 req/sec
    private lastRequestTime = 0;
    private readonly minRequestInterval = 1100; // 1.1 seconds with API key
    private readonly unauthenticatedInterval = 3000; // 3 seconds without API key

    // Separate rate limiting for autocomplete (lighter, more responsive)
    private lastAutocompleteTime = 0;
    private readonly minAutocompleteInterval = 300; // 300ms for autocomplete

    /**
     * Get the API key from Zotero preferences
     */
    private getApiKey(): string {
        const prefPrefix = config.prefsPrefix;
        return Zotero.Prefs.get(`${prefPrefix}.semanticScholarApiKey`) as string || "";
    }

    /**
     * Rate-limited fetch wrapper
     */
    private async rateLimitedFetch(url: string, options: RequestInit = {}): Promise<Response> {
        const now = Date.now();
        const timeSinceLastRequest = now - this.lastRequestTime;

        const apiKey = this.getApiKey();
        const interval = apiKey ? this.minRequestInterval : this.unauthenticatedInterval;

        if (timeSinceLastRequest < interval) {
            const waitTime = interval - timeSinceLastRequest;
            await new Promise(resolve => setTimeout(resolve, waitTime));
        }

        this.lastRequestTime = Date.now();

        const headers: Record<string, string> = {
            "Content-Type": "application/json",
            ...(options.headers as Record<string, string> || {}),
        };

        if (apiKey) {
            headers["x-api-key"] = apiKey;
        }

        const response = await fetch(url, {
            ...options,
            headers,
        });

        return response;
    }

    /**
     * Lightweight fetch for autocomplete (faster rate limit)
     */
    private async autocompleteFetch(url: string): Promise<Response> {
        const now = Date.now();
        const timeSinceLastRequest = now - this.lastAutocompleteTime;

        if (timeSinceLastRequest < this.minAutocompleteInterval) {
            const waitTime = this.minAutocompleteInterval - timeSinceLastRequest;
            await new Promise(resolve => setTimeout(resolve, waitTime));
        }

        this.lastAutocompleteTime = Date.now();

        const apiKey = this.getApiKey();
        const headers: Record<string, string> = {};

        if (apiKey) {
            headers["x-api-key"] = apiKey;
        }

        return fetch(url, { headers });
    }

    /**
     * Build query string from options
     */
    private buildQueryParams(options: SearchOptions): URLSearchParams {
        const params = new URLSearchParams();

        params.set("query", options.query);

        // Fields to request
        const fields = [
            "paperId",
            "corpusId",
            "title",
            "abstract",
            "year",
            "citationCount",
            "authors",
            "openAccessPdf",
            "url",
            "venue",
            "publicationTypes",
            "publicationDate",
            "externalIds",
            "fieldsOfStudy",
            "tldr",
        ].join(",");
        params.set("fields", fields);

        if (options.limit) {
            params.set("limit", String(Math.min(100, Math.max(1, options.limit))));
        }

        if (options.offset !== undefined) {
            params.set("offset", String(options.offset));
        }

        if (options.year) {
            params.set("year", options.year);
        }

        if (options.openAccessPdf) {
            params.set("openAccessPdf", "");
        }

        if (options.fieldsOfStudy && options.fieldsOfStudy.length > 0) {
            params.set("fieldsOfStudy", options.fieldsOfStudy.join(","));
        }

        if (options.publicationTypes && options.publicationTypes.length > 0) {
            params.set("publicationTypes", options.publicationTypes.join(","));
        }

        if (options.minCitationCount !== undefined && options.minCitationCount > 0) {
            params.set("minCitationCount", String(options.minCitationCount));
        }

        if (options.venue) {
            params.set("venue", options.venue);
        }

        return params;
    }

    /**
     * Search papers using the relevance search endpoint
     * Limited to 1000 results max
     */
    async searchPapers(options: SearchOptions): Promise<SearchResult> {
        const params = this.buildQueryParams(options);
        const url = `${this.baseUrl}/paper/search?${params.toString()}`;

        Zotero.debug(`[Seer AI] Semantic Scholar search: ${url}`);

        try {
            const response = await this.rateLimitedFetch(url);

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`Semantic Scholar API error (${response.status}): ${errorText}`);
            }

            const data = await response.json() as unknown as SearchResult;
            return data;
        } catch (error) {
            Zotero.debug(`[Seer AI] Semantic Scholar search error: ${error}`);
            throw error;
        }
    }

    /**
     * Bulk search for larger result sets
     * Supports continuation token for pagination
     */
    async searchPapersBulk(options: SearchOptions, token?: string): Promise<BulkSearchResult> {
        const params = this.buildQueryParams(options);

        if (token) {
            params.set("token", token);
        }

        if (options.sort && options.sort !== 'relevance') {
            params.set("sort", options.sort);
        }

        const url = `${this.baseUrl}/paper/search/bulk?${params.toString()}`;

        Zotero.debug(`[Seer AI] Semantic Scholar bulk search: ${url}`);

        try {
            const response = await this.rateLimitedFetch(url);

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`Semantic Scholar API error (${response.status}): ${errorText}`);
            }

            const data = await response.json() as unknown as BulkSearchResult;
            return data;
        } catch (error) {
            Zotero.debug(`[Seer AI] Semantic Scholar bulk search error: ${error}`);
            throw error;
        }
    }

    /**
     * Get details for a single paper
     */
    async getPaper(paperId: string): Promise<SemanticScholarPaper> {
        const fields = [
            "paperId",
            "corpusId",
            "title",
            "abstract",
            "year",
            "citationCount",
            "authors",
            "openAccessPdf",
            "url",
            "venue",
            "publicationTypes",
            "publicationDate",
            "externalIds",
            "fieldsOfStudy",
            "tldr",
        ].join(",");

        const url = `${this.baseUrl}/paper/${paperId}?fields=${fields}`;

        Zotero.debug(`[Seer AI] Semantic Scholar get paper: ${paperId}`);

        try {
            const response = await this.rateLimitedFetch(url);

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`Semantic Scholar API error (${response.status}): ${errorText}`);
            }

            return await response.json() as unknown as SemanticScholarPaper;
        } catch (error) {
            Zotero.debug(`[Seer AI] Semantic Scholar get paper error: ${error}`);
            throw error;
        }
    }

    /**
     * Get paper recommendations based on positive and negative examples
     */
    async getRecommendations(
        positivePaperIds: string[],
        negativePaperIds: string[] = [],
        limit: number = 20
    ): Promise<SemanticScholarPaper[]> {
        const fields = [
            "paperId",
            "title",
            "abstract",
            "year",
            "citationCount",
            "authors",
            "openAccessPdf",
            "url",
        ].join(",");

        const url = `${this.recommendationsUrl}/papers?fields=${fields}&limit=${limit}`;

        Zotero.debug(`[Seer AI] Semantic Scholar recommendations for ${positivePaperIds.length} papers`);

        try {
            const response = await this.rateLimitedFetch(url, {
                method: "POST",
                body: JSON.stringify({
                    positivePaperIds,
                    negativePaperIds,
                }),
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`Semantic Scholar API error (${response.status}): ${errorText}`);
            }

            const data = await response.json() as unknown as { recommendedPapers: SemanticScholarPaper[] };
            return data.recommendedPapers;
        } catch (error) {
            Zotero.debug(`[Seer AI] Semantic Scholar recommendations error: ${error}`);
            throw error;
        }
    }

    /**
     * Check if API key is configured
     */
    hasApiKey(): boolean {
        return !!this.getApiKey();
    }

    /**
     * Get autocomplete suggestions for a query
     */
    async autocomplete(query: string): Promise<{ paperId: string; title: string }[]> {
        if (!query || query.length < 3) return [];

        const url = `${this.baseUrl}/paper/autocomplete?query=${encodeURIComponent(query)}`;

        Zotero.debug(`[Seer AI] Semantic Scholar autocomplete: ${query}`);

        try {
            const response = await this.autocompleteFetch(url);

            if (!response.ok) {
                Zotero.debug(`[Seer AI] Autocomplete failed: ${response.status}`);
                return [];
            }

            const data = await response.json() as unknown as { matches: { id: string; title: string }[] };
            return data.matches?.map(m => ({ paperId: m.id, title: m.title })) || [];
        } catch (error) {
            Zotero.debug(`[Seer AI] Autocomplete error: ${error}`);
            return [];
        }
    }

    /**
     * Get author details in batch
     */
    async getAuthorsBatch(authorIds: string[]): Promise<SemanticScholarAuthorDetails[]> {
        if (authorIds.length === 0) return [];

        const fields = [
            "authorId",
            "name",
            "url",
            "paperCount",
            "citationCount",
            "hIndex",
            "papers.paperId",
            "papers.title",
            "papers.year",
        ].join(",");

        const url = `${this.baseUrl}/author/batch?fields=${fields}`;

        Zotero.debug(`[Seer AI] Fetching ${authorIds.length} authors`);

        try {
            const response = await this.rateLimitedFetch(url, {
                method: "POST",
                body: JSON.stringify({ ids: authorIds }),
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`Author batch error (${response.status}): ${errorText}`);
            }

            return await response.json() as unknown as SemanticScholarAuthorDetails[];
        } catch (error) {
            Zotero.debug(`[Seer AI] Author batch error: ${error}`);
            throw error;
        }
    }
}

// Author details interface
export interface SemanticScholarAuthorDetails {
    authorId: string;
    name: string;
    url?: string;
    paperCount?: number;
    citationCount?: number;
    hIndex?: number;
    papers?: { paperId: string; title: string; year?: number }[];
}

// ==================== Unpaywall Service ====================

/**
 * Unpaywall API response interface
 */
export interface UnpaywallResponse {
    doi: string;
    is_oa: boolean;
    best_oa_location?: {
        url?: string;
        url_for_pdf?: string;
        license?: string;
        host_type?: string;
    };
    oa_locations?: Array<{
        url?: string;
        url_for_pdf?: string;
        host_type?: string;
    }>;
}

/**
 * Unpaywall service for finding open access PDFs
 * API: https://unpaywall.org/products/api
 * Free, requires email for identification
 */
class UnpaywallService {
    private readonly baseUrl = "https://api.unpaywall.org/v2";
    private readonly email = "seerai-plugin@seerai.space"; // Identification for Unpaywall

    // Cache to avoid repeated lookups
    private cache = new Map<string, string | null>();
    private pendingRequests = new Map<string, Promise<string | null>>();

    /**
     * Get PDF URL from Unpaywall using DOI
     * Returns cached result if available
     */
    async getPdfUrl(doi: string): Promise<string | null> {
        if (!doi) return null;

        // Normalize DOI
        const normalizedDoi = doi.toLowerCase().trim();

        // Check cache
        if (this.cache.has(normalizedDoi)) {
            return this.cache.get(normalizedDoi) ?? null;
        }

        // Check if request is already pending (avoid duplicate requests)
        if (this.pendingRequests.has(normalizedDoi)) {
            return this.pendingRequests.get(normalizedDoi)!;
        }

        // Create the request promise
        const requestPromise = this.fetchPdfUrl(normalizedDoi);
        this.pendingRequests.set(normalizedDoi, requestPromise);

        try {
            const result = await requestPromise;
            this.cache.set(normalizedDoi, result);
            return result;
        } finally {
            this.pendingRequests.delete(normalizedDoi);
        }
    }

    /**
     * Actual fetch from Unpaywall API
     */
    private async fetchPdfUrl(doi: string): Promise<string | null> {
        try {
            const url = `${this.baseUrl}/${encodeURIComponent(doi)}?email=${this.email}`;
            Zotero.debug(`[Seer AI] Checking Unpaywall for DOI: ${doi}`);

            const response = await fetch(url);

            if (!response.ok) {
                if (response.status === 404) {
                    // DOI not found - this is normal, cache as null
                    return null;
                }
                Zotero.debug(`[Seer AI] Unpaywall error: ${response.status}`);
                return null;
            }

            const data = await response.json() as unknown as UnpaywallResponse;

            // Try to get the best PDF URL
            const pdfUrl = data.best_oa_location?.url_for_pdf
                || data.best_oa_location?.url
                || data.oa_locations?.find(loc => loc.url_for_pdf)?.url_for_pdf
                || data.oa_locations?.find(loc => loc.url)?.url;

            if (pdfUrl) {
                Zotero.debug(`[Seer AI] Unpaywall found PDF for ${doi}: ${pdfUrl}`);
                return pdfUrl;
            }

            return null;
        } catch (error) {
            Zotero.debug(`[Seer AI] Unpaywall fetch error: ${error}`);
            return null;
        }
    }

    /**
     * Batch check PDFs for multiple DOIs (parallel with rate consideration)
     */
    async checkMultipleDois(dois: string[]): Promise<Map<string, string | null>> {
        const results = new Map<string, string | null>();

        // Process in small batches to avoid overwhelming the API
        const batchSize = 5;
        for (let i = 0; i < dois.length; i += batchSize) {
            const batch = dois.slice(i, i + batchSize);
            const promises = batch.map(async (doi) => {
                const pdfUrl = await this.getPdfUrl(doi);
                results.set(doi, pdfUrl);
            });
            await Promise.all(promises);

            // Small delay between batches
            if (i + batchSize < dois.length) {
                await new Promise(r => setTimeout(r, 100));
            }
        }

        return results;
    }

    /**
     * Clear the cache
     */
    clearCache(): void {
        this.cache.clear();
    }
}

// Export Unpaywall singleton
export const unpaywallService = new UnpaywallService();

// Export Semantic Scholar singleton instance
export const semanticScholarService = new SemanticScholarService();
