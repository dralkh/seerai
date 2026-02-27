/**
 * Tavily API Service
 * Provides web search and page scraping for AI context
 *
 * API Documentation: https://docs.tavily.com/
 *
 * Features:
 * - Web Search: Search the web and get markdown content for AI context
 * - Content Extraction: Extract content from URLs
 */

import { config } from "../../package.json";

// ==================== Types ====================

export interface TavilySearchResult {
  url: string;
  title: string;
  content: string; // Summary or snippet
  raw_content?: string; // Full markdown if include_raw_content is set
  score?: number; // Relevance score
  published_date?: string;
}

export interface TavilySearchResponse {
  query: string;
  answer?: string; // AI-generated answer if include_answer is true
  results: TavilySearchResult[];
  images?: { url: string; description?: string }[];
  response_time: number;
}

export interface TavilyExtractResponse {
  results: {
    url: string;
    raw_content: string;
    failed_results?: { url: string; error: string }[];
  }[];
}

// Normalized result type for compatibility with Firecrawl
export interface WebSearchResult {
  url: string;
  title: string;
  description?: string;
  markdown?: string;
  links?: string[];
  metadata?: {
    title?: string;
    description?: string;
    sourceURL?: string;
    statusCode?: number;
  };
}

export interface PdfDiscoveryResult {
  pdfUrl?: string;
  pageUrl?: string;
  source: "tavily";
  status: "pdf_found" | "page_found" | "not_found";
}

// ==================== Service Class ====================

class TavilyService {
  private lastRequestTime = 0;
  private readonly minRequestInterval = 500; // 500ms between requests

  // Cache for search results to avoid duplicate API calls
  private searchCache = new Map<string, WebSearchResult[]>();

  // Cache for PDF discovery results (paperId -> result)
  private pdfDiscoveryCache = new Map<string, PdfDiscoveryResult | null>();

  /**
   * Get API configuration from preferences
   */
  private getConfig() {
    const prefPrefix = config.prefsPrefix;
    return {
      apiKey: (Zotero.Prefs.get(`${prefPrefix}.tavilyApiKey`) as string) || "",
      searchDepth:
        (Zotero.Prefs.get(`${prefPrefix}.tavilySearchDepth`) as string) ||
        "basic",
      searchLimit:
        (Zotero.Prefs.get(`${prefPrefix}.tavilySearchLimit`) as number) || 5,
    };
  }

  /**
   * Get current search limit setting
   */
  getSearchLimit(): number {
    return this.getConfig().searchLimit;
  }

  /**
   * Check if Tavily is configured (has API key)
   */
  isConfigured(): boolean {
    const { apiKey } = this.getConfig();
    return !!apiKey;
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

    const { apiKey } = this.getConfig();

    return fetch(`https://api.tavily.com${endpoint}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "x-seer-ai": "1",
        ...(options.headers || {}),
      },
    });
  }

  /**
   * Scrape a single URL to get its content as markdown
   * Uses Tavily Extract API
   */
  async scrapeUrl(url: string): Promise<WebSearchResult | null> {
    if (!this.isConfigured()) {
      Zotero.debug("[seerai] Tavily not configured, skipping scrape");
      return null;
    }

    try {
      Zotero.debug(`[seerai] Tavily extract: ${url}`);

      const response = await this.rateLimitedFetch("/extract", {
        method: "POST",
        body: JSON.stringify({
          urls: [url],
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Tavily error (${response.status}): ${errorText}`);
      }

      const data = (await response.json()) as unknown as TavilyExtractResponse;

      if (data.results && data.results.length > 0) {
        const result = data.results[0];
        return {
          url: result.url,
          title: "", // Extract doesn't return title
          markdown: result.raw_content,
          metadata: {
            sourceURL: result.url,
          },
        };
      }

      return null;
    } catch (error) {
      Zotero.debug(`[seerai] Tavily extract error: ${error}`);
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
  ): Promise<WebSearchResult[]> {
    if (!this.isConfigured()) {
      Zotero.debug("[seerai] Tavily not configured, skipping web search");
      return [];
    }

    const { searchDepth } = this.getConfig();
    const cacheKey = `web:${query}:${limit}:${searchDepth}`;
    if (this.searchCache.has(cacheKey)) {
      Zotero.debug(`[seerai] Tavily cache hit for: ${query}`);
      return this.searchCache.get(cacheKey)!;
    }

    try {
      Zotero.debug(`[seerai] Tavily web search: ${query}`);

      const response = await this.rateLimitedFetch("/search", {
        method: "POST",
        body: JSON.stringify({
          query,
          max_results: limit,
          search_depth: searchDepth,
          include_raw_content: "markdown",
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Tavily error (${response.status}): ${errorText}`);
      }

      const data = (await response.json()) as unknown as TavilySearchResponse;

      // Convert Tavily results to normalized format
      const results: WebSearchResult[] = data.results.map((r) => ({
        url: r.url,
        title: r.title,
        description: r.content,
        markdown: r.raw_content || r.content,
        metadata: {
          title: r.title,
          description: r.content,
          sourceURL: r.url,
        },
      }));

      Zotero.debug(`[seerai] Tavily returned ${results.length} results`);
      this.searchCache.set(cacheKey, results);
      return results;
    } catch (error) {
      Zotero.debug(`[seerai] Tavily web search error: ${error}`);
      return [];
    }
  }

  /**
   * Research Search - for finding academic papers and PDFs
   * Uses topic=research for academic sources
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
      query = `"${doi}" OR "${title}"`;
    } else if (authors && authors.length > 0) {
      query = `"${title}" ${authors[0]}`;
    }

    // Check cache
    const cacheKey = `research:${query}`;
    if (this.pdfDiscoveryCache.has(cacheKey)) {
      Zotero.debug(`[seerai] Tavily PDF cache hit for: ${title}`);
      return this.pdfDiscoveryCache.get(cacheKey) ?? null;
    }

    try {
      Zotero.debug(`[seerai] Tavily research search: ${query}`);

      const response = await this.rateLimitedFetch("/search", {
        method: "POST",
        body: JSON.stringify({
          query: query + " PDF",
          max_results: this.getSearchLimit(),
          search_depth: "advanced",
          include_raw_content: "markdown",
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Tavily error (${response.status}): ${errorText}`);
      }

      const data = (await response.json()) as unknown as TavilySearchResponse;

      Zotero.debug(
        `[seerai] Tavily research returned ${data.results.length} results`,
      );

      const pdfResult = this.extractPdfFromResults(data.results);
      this.pdfDiscoveryCache.set(cacheKey, pdfResult);

      return pdfResult;
    } catch (error) {
      Zotero.debug(`[seerai] Tavily research search error: ${error}`);
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
   * Enhanced PDF discovery using search approach
   */
  async searchForPdf(
    title: string,
    authors?: string[],
    doi?: string,
  ): Promise<PdfDiscoveryResult> {
    if (!this.isConfigured()) {
      return { source: "tavily", status: "not_found" };
    }

    // Build search query
    let query = title;
    if (doi) {
      query = `"${doi}" OR "${title}"`;
    } else if (authors && authors.length > 0) {
      query = `"${title}" ${authors[0]}`;
    }

    // Check cache first
    const cacheKey = `pdf_search:${query}`;
    if (this.pdfDiscoveryCache.has(cacheKey)) {
      Zotero.debug(`[seerai] Tavily PDF search cache hit for: ${title}`);
      return (
        this.pdfDiscoveryCache.get(cacheKey) ?? {
          source: "tavily",
          status: "not_found",
        }
      );
    }

    try {
      // Search specifically for PDFs
      Zotero.debug(`[seerai] Tavily PDF search: ${query}`);
      const response = await this.rateLimitedFetch("/search", {
        method: "POST",
        body: JSON.stringify({
          query: query + " filetype:pdf OR PDF download",
          max_results: this.getSearchLimit(),
          search_depth: "advanced",
          include_raw_content: "markdown",
        }),
      });

      if (response.ok) {
        const data = (await response.json()) as unknown as TavilySearchResponse;

        Zotero.debug(
          `[seerai] Tavily PDF search returned ${data.results.length} results`,
        );

        if (data.results.length > 0) {
          const pdfResult = this.extractPdfFromResults(data.results);
          if (pdfResult) {
            this.pdfDiscoveryCache.set(cacheKey, pdfResult);
            return pdfResult;
          }
        }
      }

      // No results found
      const notFoundResult: PdfDiscoveryResult = {
        source: "tavily",
        status: "not_found",
      };
      this.pdfDiscoveryCache.set(cacheKey, notFoundResult);
      return notFoundResult;
    } catch (error) {
      Zotero.debug(`[seerai] Tavily searchForPdf error: ${error}`);
      const errorResult: PdfDiscoveryResult = {
        source: "tavily",
        status: "not_found",
      };
      this.pdfDiscoveryCache.set(cacheKey, errorResult);
      return errorResult;
    }
  }

  /**
   * Extract PDF URL from search results
   */
  private extractPdfFromResults(
    results: TavilySearchResult[],
  ): PdfDiscoveryResult | null {
    for (const result of results) {
      // 1. Check if the URL itself is a PDF
      if (this.isPdfUrl(result.url)) {
        Zotero.debug(`[seerai] Found PDF URL: ${result.url}`);
        return {
          pdfUrl: result.url,
          source: "tavily",
          status: "pdf_found",
        };
      }

      // 2. Check raw_content for PDF links
      const content = result.raw_content || result.content;
      if (content) {
        // Match markdown links to PDFs: [text](url.pdf)
        const pdfLinkRegex =
          /\[([^\]]*)\]\((https?:\/\/[^\s\)]+\.pdf[^\s\)]*)\)/gi;
        const match = pdfLinkRegex.exec(content);
        if (match) {
          Zotero.debug(`[seerai] Found PDF in content: ${match[2]}`);
          return {
            pdfUrl: match[2],
            pageUrl: result.url,
            source: "tavily",
            status: "pdf_found",
          };
        }

        // Check for "Download PDF" type links
        const downloadRegex =
          /\[([^\]]*(?:download|pdf|full\s*text)[^\]]*)\]\((https?:\/\/[^\s\)]+)\)/gi;
        const downloadMatch = downloadRegex.exec(content);
        if (downloadMatch) {
          Zotero.debug(`[seerai] Found download link: ${downloadMatch[2]}`);
          return {
            pdfUrl: downloadMatch[2],
            pageUrl: result.url,
            source: "tavily",
            status: "pdf_found",
          };
        }
      }

      // 3. Check for arXiv abstract page - convert to PDF URL
      if (result.url.includes("arxiv.org/abs/")) {
        const pdfUrl = result.url.replace("/abs/", "/pdf/") + ".pdf";
        Zotero.debug(`[seerai] Converted arXiv abstract to PDF: ${pdfUrl}`);
        return {
          pdfUrl: pdfUrl,
          pageUrl: result.url,
          source: "tavily",
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
        source: "tavily",
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
    Zotero.debug("[seerai] Tavily caches cleared");
  }

  /**
   * Clear only PDF discovery cache
   */
  clearPdfCache(): void {
    this.pdfDiscoveryCache.clear();
  }

  /**
   * Clear PDF cache for a specific paper query
   */
  clearPdfCacheForPaper(title: string, authors?: string[], doi?: string): void {
    let query = title;
    if (doi) {
      query = `"${doi}" OR "${title}"`;
    } else if (authors && authors.length > 0) {
      query = `"${title}" ${authors[0]}`;
    }

    const cacheKey = `pdf_search:${query}`;
    this.pdfDiscoveryCache.delete(cacheKey);

    const researchKey = `research:${query}`;
    this.pdfDiscoveryCache.delete(researchKey);

    Zotero.debug(
      `[seerai] Cleared Tavily PDF cache for: ${title.slice(0, 50)}...`,
    );
  }
}

// Export singleton instance
export const tavilyService = new TavilyService();
