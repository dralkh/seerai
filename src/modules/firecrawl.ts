/**
 * Firecrawl API Service
 * Provides web search and page scraping for AI context and PDF discovery
 *
 * API Documentation: https://docs.firecrawl.dev/
 *
 * Features:
 * - Web Search: Search the web and get markdown content for AI context
 * - Research Search: Find academic papers with PDF discovery
 */

import { config } from "../../package.json";

// ==================== Types ====================

export interface FirecrawlSearchResult {
  url: string;
  title: string;
  description?: string;
  markdown?: string; // If scrapeOptions enabled
  category?: string; // 'research' | 'github' | 'web'
  links?: string[];
  metadata?: {
    title?: string;
    description?: string;
    sourceURL?: string;
    statusCode?: number;
  };
}

export interface FirecrawlSearchResponse {
  success: boolean;
  data:
    | {
        web?: FirecrawlSearchResult[];
      }
    | FirecrawlSearchResult[]; // Different format when scrapeOptions used
}

export interface FirecrawlSearchOptions {
  query: string;
  limit?: number; // Default 10
  categories?: ("research" | "github" | "pdf")[];
  scrapeOptions?: {
    formats: ("markdown" | "links" | "html")[];
  };
  timeout?: number;
}

export interface PdfDiscoveryResult {
  pdfUrl?: string;
  pageUrl?: string;
  source: "firecrawl";
  status: "pdf_found" | "page_found" | "not_found";
}

// ==================== Service Class ====================

class FirecrawlService {
  private lastRequestTime = 0;
  private readonly minRequestInterval = 500; // 500ms between requests

  // Cache for search results to avoid duplicate API calls
  private searchCache = new Map<string, FirecrawlSearchResult[]>();

  // Cache for PDF discovery results (paperId -> result)
  private pdfDiscoveryCache = new Map<string, PdfDiscoveryResult | null>();

  /**
   * Get API configuration from preferences
   */
  private getConfig() {
    const prefPrefix = config.prefsPrefix;
    return {
      apiKey:
        (Zotero.Prefs.get(`${prefPrefix}.firecrawlApiKey`) as string) || "",
      apiUrl:
        (Zotero.Prefs.get(`${prefPrefix}.firecrawlApiUrl`) as string) ||
        "https://api.firecrawl.dev/v2 or http://localhost:3002/v2",
      searchLimit:
        (Zotero.Prefs.get(`${prefPrefix}.firecrawlSearchLimit`) as number) || 3,
    };
  }

  /**
   * Get current search limit setting
   */
  getSearchLimit(): number {
    return this.getConfig().searchLimit;
  }

  /**
   * Check if Firecrawl is configured (has API key and URL)
   */
  isConfigured(): boolean {
    const { apiKey, apiUrl } = this.getConfig();
    return !!apiKey && !!apiUrl;
  }

  /**
   * Rate-limited fetch wrapper
   */
  private async rateLimitedFetch(
    endpoint: string,
    options: RequestInit = {},
  ): Promise<Response> {
    const now = Date.now();
    const timeSinceLastRequest = now - this.lastRequestTime;

    if (timeSinceLastRequest < this.minRequestInterval) {
      const waitTime = this.minRequestInterval - timeSinceLastRequest;
      await new Promise((r) => setTimeout(r, waitTime));
    }

    this.lastRequestTime = Date.now();

    const { apiKey, apiUrl } = this.getConfig();

    return fetch(`${apiUrl}${endpoint}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        ...(options.headers || {}),
      },
    });
  }

  /**
   * Scrape a single URL to get its content as markdown
   */
  async scrapeUrl(url: string): Promise<FirecrawlSearchResult | null> {
    if (!this.isConfigured()) {
      Zotero.debug("[seerai] Firecrawl not configured, skipping scrape");
      return null;
    }

    try {
      Zotero.debug(`[seerai] Firecrawl scrape: ${url}`);

      const response = await this.rateLimitedFetch("/scrape", {
        method: "POST",
        body: JSON.stringify({
          url,
          formats: ["markdown", "metadata"],
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Firecrawl error (${response.status}): ${errorText}`);
      }

      const data = (await response.json()) as unknown as {
        success: boolean;
        data: FirecrawlSearchResult;
      };

      if (data.success && data.data) {
        return data.data;
      }

      return null;
    } catch (error) {
      Zotero.debug(`[seerai] Firecrawl scrape error: ${error}`);
      throw error;
    }
  }

  /**
   * Web Search - for chat context enrichment
   * Returns markdown content from search results for AI context
   */
  async webSearch(
    query: string,
    limit: number = 5,
  ): Promise<FirecrawlSearchResult[]> {
    if (!this.isConfigured()) {
      Zotero.debug("[seerai] Firecrawl not configured, skipping web search");
      return [];
    }

    const cacheKey = `web:${query}:${limit}`;
    if (this.searchCache.has(cacheKey)) {
      Zotero.debug(`[seerai] Firecrawl cache hit for: ${query}`);
      return this.searchCache.get(cacheKey)!;
    }

    try {
      Zotero.debug(`[seerai] Firecrawl web search: ${query}`);

      const response = await this.rateLimitedFetch("/search", {
        method: "POST",
        body: JSON.stringify({
          query,
          limit,
          scrapeOptions: {
            formats: ["markdown"],
          },
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Firecrawl error (${response.status}): ${errorText}`);
      }

      const data =
        (await response.json()) as unknown as FirecrawlSearchResponse;

      // Handle different response formats
      // When scrapeOptions is used, data is an array directly
      // Without scrapeOptions, data is { web: [...] }
      let results: FirecrawlSearchResult[];
      if (Array.isArray(data.data)) {
        results = data.data;
      } else {
        results = data.data?.web || [];
      }

      Zotero.debug(`[seerai] Firecrawl returned ${results.length} results`);
      this.searchCache.set(cacheKey, results);
      return results;
    } catch (error) {
      Zotero.debug(`[seerai] Firecrawl web search error: ${error}`);
      return [];
    }
  }

  /**
   * Research Search - for finding academic papers and PDFs
   * Uses 'research' and 'pdf' categories to focus on academic sources
   * (arXiv, Nature, IEEE, PubMed, etc.)
   */
  async researchSearch(
    title: string,
    authors?: string[],
    doi?: string,
  ): Promise<PdfDiscoveryResult | null> {
    if (!this.isConfigured()) {
      return null;
    }

    // Build search query focusing on research content
    let query = title;
    if (doi) {
      // DOI is most specific - search for it directly
      query = `"${doi}" OR "${title}"`;
    } else if (authors && authors.length > 0) {
      // Add first author to narrow down search
      query = `"${title}" ${authors[0]}`;
    }

    // Check cache
    const cacheKey = `research:${query}`;
    if (this.pdfDiscoveryCache.has(cacheKey)) {
      Zotero.debug(`[seerai] Firecrawl PDF cache hit for: ${title}`);
      return this.pdfDiscoveryCache.get(cacheKey) ?? null;
    }

    try {
      Zotero.debug(`[seerai] Firecrawl research search: ${query}`);

      const response = await this.rateLimitedFetch("/search", {
        method: "POST",
        body: JSON.stringify({
          query,
          limit: this.getSearchLimit(),
          categories: ["research", "pdf"],
          scrapeOptions: {
            formats: ["markdown", "links"],
          },
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Firecrawl error (${response.status}): ${errorText}`);
      }

      const data =
        (await response.json()) as unknown as FirecrawlSearchResponse;

      // Handle different response formats
      let results: FirecrawlSearchResult[];
      if (Array.isArray(data.data)) {
        results = data.data;
      } else {
        results = data.data?.web || [];
      }

      Zotero.debug(
        `[seerai] Firecrawl research returned ${results.length} results`,
      );

      const pdfResult = this.extractPdfFromResults(results);
      this.pdfDiscoveryCache.set(cacheKey, pdfResult);

      return pdfResult;
    } catch (error) {
      Zotero.debug(`[seerai] Firecrawl research search error: ${error}`);
      this.pdfDiscoveryCache.set(cacheKey, null);
      return null;
    }
  }

  /**
   * Get cached PDF discovery result for a paper
   */
  getCachedPdfResult(paperId: string): PdfDiscoveryResult | null | undefined {
    return this.pdfDiscoveryCache.get(`paper:${paperId}`);
  }

  /**
   * Set cached PDF discovery result for a paper
   */
  setCachedPdfResult(paperId: string, result: PdfDiscoveryResult | null): void {
    this.pdfDiscoveryCache.set(`paper:${paperId}`, result);
  }

  /**
   * Enhanced PDF discovery using two-phase search approach
   * Phase 1: Search with categories=["pdf"] for direct PDF links
   * Phase 2: If no PDF found, search with categories=["research"] for paper pages
   *
   * Returns a result with status indicating: pdf_found, page_found, or not_found
   */
  async searchForPdf(
    title: string,
    authors?: string[],
    doi?: string,
  ): Promise<PdfDiscoveryResult> {
    if (!this.isConfigured()) {
      return { source: "firecrawl", status: "not_found" };
    }

    // Build search query
    let query = title;
    if (doi) {
      // DOI is most specific - prioritize it
      query = `"${doi}" OR "${title}"`;
    } else if (authors && authors.length > 0) {
      // Add first author to narrow down search
      query = `"${title}" ${authors[0]}`;
    }

    // Check cache first
    const cacheKey = `pdf_search:${query}`;
    if (this.pdfDiscoveryCache.has(cacheKey)) {
      Zotero.debug(`[seerai] Firecrawl PDF search cache hit for: ${title}`);
      return (
        this.pdfDiscoveryCache.get(cacheKey) ?? {
          source: "firecrawl",
          status: "not_found",
        }
      );
    }

    try {
      // Phase 1: Search specifically for PDFs
      Zotero.debug(`[seerai] Firecrawl Phase 1 - PDF search: ${query}`);
      const pdfResponse = await this.rateLimitedFetch("/search", {
        method: "POST",
        body: JSON.stringify({
          query,
          limit: this.getSearchLimit(),
          categories: ["pdf"],
          scrapeOptions: {
            formats: ["links"],
          },
        }),
      });

      if (pdfResponse.ok) {
        const pdfData =
          (await pdfResponse.json()) as unknown as FirecrawlSearchResponse;
        const pdfResults: FirecrawlSearchResult[] = Array.isArray(pdfData.data)
          ? pdfData.data
          : pdfData.data?.web || [];

        Zotero.debug(
          `[seerai] Firecrawl PDF search returned ${pdfResults.length} results`,
        );

        if (pdfResults.length > 0) {
          const pdfResult = this.extractPdfFromResults(pdfResults);
          if (pdfResult && pdfResult.status === "pdf_found") {
            this.pdfDiscoveryCache.set(cacheKey, pdfResult);
            return pdfResult;
          }
        }
      }

      // Phase 2: Search for research/academic pages
      Zotero.debug(`[seerai] Firecrawl Phase 2 - Research search: ${query}`);
      const researchResponse = await this.rateLimitedFetch("/search", {
        method: "POST",
        body: JSON.stringify({
          query,
          limit: this.getSearchLimit(),
          categories: ["research"],
          scrapeOptions: {
            formats: ["markdown", "links"],
          },
        }),
      });

      if (researchResponse.ok) {
        const researchData =
          (await researchResponse.json()) as unknown as FirecrawlSearchResponse;
        const researchResults: FirecrawlSearchResult[] = Array.isArray(
          researchData.data,
        )
          ? researchData.data
          : researchData.data?.web || [];

        Zotero.debug(
          `[seerai] Firecrawl research search returned ${researchResults.length} results`,
        );

        if (researchResults.length > 0) {
          const result = this.extractPdfFromResults(researchResults);
          if (result) {
            this.pdfDiscoveryCache.set(cacheKey, result);
            return result;
          }
        }
      }

      // No results found
      const notFoundResult: PdfDiscoveryResult = {
        source: "firecrawl",
        status: "not_found",
      };
      this.pdfDiscoveryCache.set(cacheKey, notFoundResult);
      return notFoundResult;
    } catch (error) {
      Zotero.debug(`[seerai] Firecrawl searchForPdf error: ${error}`);
      const errorResult: PdfDiscoveryResult = {
        source: "firecrawl",
        status: "not_found",
      };
      this.pdfDiscoveryCache.set(cacheKey, errorResult);
      return errorResult;
    }
  }

  /**
   * Extract PDF URL from search results
   * Looks for direct PDF links, download links, and PDF URLs in markdown
   */
  private extractPdfFromResults(
    results: FirecrawlSearchResult[],
  ): PdfDiscoveryResult | null {
    for (const result of results) {
      // 1. Check if the URL itself is a PDF
      if (this.isPdfUrl(result.url)) {
        Zotero.debug(`[seerai] Found PDF URL: ${result.url}`);
        return {
          pdfUrl: result.url,
          source: "firecrawl",
          status: "pdf_found",
        };
      }

      // 2. Check links array for PDFs
      if (result.links) {
        for (const link of result.links) {
          if (this.isPdfUrl(link)) {
            Zotero.debug(`[seerai] Found PDF in links: ${link}`);
            return {
              pdfUrl: link,
              pageUrl: result.url,
              source: "firecrawl",
              status: "pdf_found",
            };
          }
        }
      }

      // 3. Check markdown content for PDF links
      if (result.markdown) {
        // Match markdown links to PDFs: [text](url.pdf)
        const pdfLinkRegex =
          /\[([^\]]*)\]\((https?:\/\/[^\s\)]+\.pdf[^\s\)]*)\)/gi;
        const match = pdfLinkRegex.exec(result.markdown);
        if (match) {
          Zotero.debug(`[seerai] Found PDF in markdown: ${match[2]}`);
          return {
            pdfUrl: match[2],
            pageUrl: result.url,
            source: "firecrawl",
            status: "pdf_found",
          };
        }

        // Also check for "Download PDF" type links
        const downloadRegex =
          /\[([^\]]*(?:download|pdf|full\s*text)[^\]]*)\]\((https?:\/\/[^\s\)]+)\)/gi;
        const downloadMatch = downloadRegex.exec(result.markdown);
        if (downloadMatch) {
          Zotero.debug(
            `[seerai] Found download link in markdown: ${downloadMatch[2]}`,
          );
          return {
            pdfUrl: downloadMatch[2],
            pageUrl: result.url,
            source: "firecrawl",
            status: "pdf_found",
          };
        }
      }

      // 4. Check for arXiv abstract page - convert to PDF URL
      if (result.url.includes("arxiv.org/abs/")) {
        const pdfUrl = result.url.replace("/abs/", "/pdf/") + ".pdf";
        Zotero.debug(`[seerai] Converted arXiv abstract to PDF: ${pdfUrl}`);
        return {
          pdfUrl: pdfUrl,
          pageUrl: result.url,
          source: "firecrawl",
          status: "pdf_found",
        };
      }
    }

    // No PDF found, but return most relevant page URL if available
    if (results.length > 0) {
      Zotero.debug(
        `[seerai] No PDF found, returning page URL: ${results[0].url}`,
      );
      return {
        pageUrl: results[0].url,
        source: "firecrawl",
        status: "page_found",
      };
    }

    return null;
  }

  /**
   * Check if a URL looks like a PDF
   */
  private isPdfUrl(url: string): boolean {
    const lowerUrl = url.toLowerCase();
    return (
      lowerUrl.endsWith(".pdf") ||
      lowerUrl.includes("/pdf/") ||
      lowerUrl.includes("download=pdf") ||
      lowerUrl.includes("format=pdf") ||
      lowerUrl.includes("type=pdf")
    );
  }

  /**
   * Clear all caches
   */
  clearCache(): void {
    this.searchCache.clear();
    this.pdfDiscoveryCache.clear();
    Zotero.debug("[seerai] Firecrawl caches cleared");
  }

  /**
   * Clear only PDF discovery cache
   */
  clearPdfCache(): void {
    this.pdfDiscoveryCache.clear();
  }

  /**
   * Clear PDF cache for a specific paper query (used when retrying PDF discovery)
   */
  clearPdfCacheForPaper(title: string, authors?: string[], doi?: string): void {
    // Build the same query key used in searchForPdf
    let query = title;
    if (doi) {
      query = `"${doi}" OR "${title}"`;
    } else if (authors && authors.length > 0) {
      query = `"${title}" ${authors[0]}`;
    }

    const cacheKey = `pdf_search:${query}`;
    this.pdfDiscoveryCache.delete(cacheKey);

    // Also clear research search cache
    const researchKey = `research:${query}`;
    this.pdfDiscoveryCache.delete(researchKey);

    Zotero.debug(
      `[seerai] Cleared Firecrawl PDF cache for: ${title.slice(0, 50)}...`,
    );
  }
}

// Export singleton instance
export const firecrawlService = new FirecrawlService();
