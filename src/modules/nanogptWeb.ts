/**
 * NanoGPT Web Search Service
 * Provides web search via NanoGPT's /api/web endpoint
 * which routes through Tavily (default), Linkup, Exa, Kagi, Perplexity, Valyu, or Brave.
 *
 * API Documentation: https://nano-gpt.com/docs
 *
 * Features:
 * - Web Search: Search the web via NanoGPT-routed providers
 * - Content Extraction: Get sourced answers from URLs
 * - Uses existing NanoGPT API key (same as chat/embeddings)
 */

import { config } from "../../package.json";
import { getActiveModelConfig } from "./chat/modelConfig";

// ==================== Types ====================

export interface NanogptWebSearchResult {
  type?: string; // e.g. "text"
  title: string;
  url: string;
  snippet: string;
  publishedAt?: string;
  content?: string;
}

export interface NanogptWebSearchResponse {
  data: NanogptWebSearchResult[];
  metadata?: {
    query: string;
    provider: string;
    depth: string;
    outputType: string;
    timestamp: string;
    cost: number;
  };
}

export interface NanogptSourcedAnswerResponse {
  data: {
    answer: string;
    sources: Array<{
      title: string;
      url: string;
      snippet: string;
    }>;
  };
  metadata?: {
    query: string;
    provider: string;
    depth: string;
    outputType: string;
    timestamp: string;
    cost: number;
  };
}

// Normalized result type compatible with WebSearchProvider interface
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
  source: "nanogpt";
  status: "pdf_found" | "page_found" | "not_found";
}

// ==================== Service Class ====================

class NanogptWebService {
  private lastRequestTime = 0;
  private readonly minRequestInterval = 1000; // 1s between requests (60 req/min rate limit)

  // Cache for search results to avoid duplicate API calls
  private searchCache = new Map<string, WebSearchResult[]>();

  // Cache for PDF discovery results
  private pdfDiscoveryCache = new Map<string, PdfDiscoveryResult | null>();

  /**
   * Get API key for NanoGPT.
   * First checks the dedicated nanogptWebApiKey pref,
   * then falls back to the active model config's API key if it's a NanoGPT provider.
   */
  private getApiKey(): string {
    const prefPrefix = config.prefsPrefix;

    // 1. Check dedicated NanoGPT web search API key
    const dedicatedKey =
      (Zotero.Prefs.get(`${prefPrefix}.nanogptWebApiKey`) as string) || "";
    if (dedicatedKey) return dedicatedKey;

    // 2. Fall back to active model config if it's a NanoGPT provider
    try {
      const activeConfig = getActiveModelConfig();
      if (
        activeConfig?.apiURL &&
        activeConfig.apiURL.includes("nano-gpt.com")
      ) {
        return activeConfig.apiKey || "";
      }
    } catch {
      // Ignore errors - model config may not be initialized
    }

    return "";
  }

  /**
   * Get configuration from preferences
   */
  private getConfig() {
    const prefPrefix = config.prefsPrefix;
    return {
      apiKey: this.getApiKey(),
      searchLimit:
        (Zotero.Prefs.get(`${prefPrefix}.nanogptWebSearchLimit`) as number) ||
        5,
      searchDepth:
        (Zotero.Prefs.get(`${prefPrefix}.nanogptWebSearchDepth`) as string) ||
        "standard",
    };
  }

  /**
   * Get current search limit setting
   */
  getSearchLimit(): number {
    return this.getConfig().searchLimit;
  }

  /**
   * Check if NanoGPT web search is configured (has API key)
   */
  isConfigured(): boolean {
    const apiKey = this.getApiKey();
    return !!apiKey;
  }

  /**
   * Rate-limited fetch wrapper
   */
  private async rateLimitedFetch(
    endpoint: string,
    body: Record<string, unknown>,
  ): Promise<Response> {
    const now = Date.now();
    const timeSinceLastRequest = now - this.lastRequestTime;

    if (timeSinceLastRequest < this.minRequestInterval) {
      const waitTime = this.minRequestInterval - timeSinceLastRequest;
      await new Promise((r) => setTimeout(r, waitTime));
    }

    this.lastRequestTime = Date.now();

    const apiKey = this.getApiKey();

    return fetch(`https://nano-gpt.com${endpoint}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        Authorization: `Bearer ${apiKey}`,
        "x-seer-ai": "1",
      },
      body: JSON.stringify(body),
    });
  }

  /**
   * Web Search - for chat context enrichment
   * Returns normalized search results for AI context
   */
  async webSearch(
    query: string,
    limit: number = 5,
  ): Promise<WebSearchResult[]> {
    if (!this.isConfigured()) {
      Zotero.debug(
        "[seerai] NanoGPT web search not configured, skipping search",
      );
      return [];
    }

    const { searchDepth } = this.getConfig();
    const cacheKey = `web:${query}:${limit}:${searchDepth}`;
    if (this.searchCache.has(cacheKey)) {
      Zotero.debug(`[seerai] NanoGPT web cache hit for: ${query}`);
      return this.searchCache.get(cacheKey)!;
    }

    try {
      Zotero.debug(`[seerai] NanoGPT web search: ${query}`);

      const response = await this.rateLimitedFetch("/api/web", {
        query,
        provider: "tavily",
        depth: searchDepth,
        outputType: "searchResults",
        maxResults: limit,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(
          `NanoGPT web search error (${response.status}): ${errorText}`,
        );
      }

      const data =
        (await response.json()) as unknown as NanogptWebSearchResponse;

      if (!data.data || !Array.isArray(data.data)) {
        Zotero.debug("[seerai] NanoGPT web search returned no data array");
        return [];
      }

      // Normalize NanoGPT results to WebSearchResult format
      const results: WebSearchResult[] = data.data.map((r) => ({
        url: r.url,
        title: r.title,
        description: r.snippet,
        markdown: r.content || r.snippet,
        metadata: {
          title: r.title,
          description: r.snippet,
          sourceURL: r.url,
        },
      }));

      if (data.metadata) {
        Zotero.debug(
          `[seerai] NanoGPT web search: ${results.length} results, cost: $${data.metadata.cost?.toFixed(4) || "?"}`,
        );
      } else {
        Zotero.debug(
          `[seerai] NanoGPT web search returned ${results.length} results`,
        );
      }

      this.searchCache.set(cacheKey, results);
      return results;
    } catch (error) {
      Zotero.debug(`[seerai] NanoGPT web search error: ${error}`);
      return [];
    }
  }

  /**
   * Scrape a single URL using NanoGPT sourcedAnswer output type
   * This asks NanoGPT to fetch and summarize a URL's content
   */
  async scrapeUrl(url: string): Promise<WebSearchResult | null> {
    if (!this.isConfigured()) {
      Zotero.debug(
        "[seerai] NanoGPT web search not configured, skipping scrape",
      );
      return null;
    }

    try {
      Zotero.debug(`[seerai] NanoGPT web scrape: ${url}`);

      // Use sourcedAnswer to get content from the URL
      const response = await this.rateLimitedFetch("/api/web", {
        query: `site:${url}`,
        provider: "tavily",
        depth: "standard",
        outputType: "sourcedAnswer",
        maxResults: 1,
        includeDomains: [new URL(url).hostname],
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(
          `NanoGPT scrape error (${response.status}): ${errorText}`,
        );
      }

      const data =
        (await response.json()) as unknown as NanogptSourcedAnswerResponse;

      if (data.data && data.data.answer) {
        return {
          url,
          title: "",
          markdown: data.data.answer,
          metadata: {
            sourceURL: url,
          },
        };
      }

      return null;
    } catch (error) {
      Zotero.debug(`[seerai] NanoGPT web scrape error: ${error}`);
      return null;
    }
  }

  /**
   * Research Search - for finding academic papers and PDFs
   */
  async researchSearch(
    title: string,
    authors?: string[],
    doi?: string,
  ): Promise<PdfDiscoveryResult | null> {
    if (!this.isConfigured()) {
      return null;
    }

    let query = title;
    if (doi) {
      query = `"${doi}" OR "${title}"`;
    } else if (authors && authors.length > 0) {
      query = `"${title}" ${authors[0]}`;
    }

    const cacheKey = `research:${query}`;
    if (this.pdfDiscoveryCache.has(cacheKey)) {
      Zotero.debug(`[seerai] NanoGPT PDF cache hit for: ${title}`);
      return this.pdfDiscoveryCache.get(cacheKey) ?? null;
    }

    try {
      Zotero.debug(`[seerai] NanoGPT research search: ${query}`);

      const response = await this.rateLimitedFetch("/api/web", {
        query: query + " PDF",
        provider: "tavily",
        depth: "deep",
        outputType: "searchResults",
        maxResults: this.getSearchLimit(),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(
          `NanoGPT research error (${response.status}): ${errorText}`,
        );
      }

      const data =
        (await response.json()) as unknown as NanogptWebSearchResponse;

      if (!data.data || data.data.length === 0) {
        this.pdfDiscoveryCache.set(cacheKey, null);
        return null;
      }

      const pdfResult = this.extractPdfFromResults(data.data);
      this.pdfDiscoveryCache.set(cacheKey, pdfResult);
      return pdfResult;
    } catch (error) {
      Zotero.debug(`[seerai] NanoGPT research search error: ${error}`);
      this.pdfDiscoveryCache.set(cacheKey, null);
      return null;
    }
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
      return { source: "nanogpt", status: "not_found" };
    }

    let query = title;
    if (doi) {
      query = `"${doi}" OR "${title}"`;
    } else if (authors && authors.length > 0) {
      query = `"${title}" ${authors[0]}`;
    }

    const cacheKey = `pdf_search:${query}`;
    if (this.pdfDiscoveryCache.has(cacheKey)) {
      Zotero.debug(`[seerai] NanoGPT PDF search cache hit for: ${title}`);
      return (
        this.pdfDiscoveryCache.get(cacheKey) ?? {
          source: "nanogpt",
          status: "not_found",
        }
      );
    }

    try {
      Zotero.debug(`[seerai] NanoGPT PDF search: ${query}`);
      const response = await this.rateLimitedFetch("/api/web", {
        query: query + " filetype:pdf OR PDF download",
        provider: "tavily",
        depth: "deep",
        outputType: "searchResults",
        maxResults: this.getSearchLimit(),
      });

      if (response.ok) {
        const data =
          (await response.json()) as unknown as NanogptWebSearchResponse;

        if (data.data && data.data.length > 0) {
          const pdfResult = this.extractPdfFromResults(data.data);
          if (pdfResult) {
            this.pdfDiscoveryCache.set(cacheKey, pdfResult);
            return pdfResult;
          }
        }
      }

      const notFoundResult: PdfDiscoveryResult = {
        source: "nanogpt",
        status: "not_found",
      };
      this.pdfDiscoveryCache.set(cacheKey, notFoundResult);
      return notFoundResult;
    } catch (error) {
      Zotero.debug(`[seerai] NanoGPT searchForPdf error: ${error}`);
      const errorResult: PdfDiscoveryResult = {
        source: "nanogpt",
        status: "not_found",
      };
      this.pdfDiscoveryCache.set(cacheKey, errorResult);
      return errorResult;
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
   * Extract PDF URL from NanoGPT search results
   */
  private extractPdfFromResults(
    results: NanogptWebSearchResult[],
  ): PdfDiscoveryResult | null {
    for (const result of results) {
      // 1. Check if the URL itself is a PDF
      if (this.isPdfUrl(result.url)) {
        Zotero.debug(`[seerai] Found PDF URL: ${result.url}`);
        return {
          pdfUrl: result.url,
          source: "nanogpt",
          status: "pdf_found",
        };
      }

      // 2. Check snippet/content for PDF links
      const content = result.content || result.snippet;
      if (content) {
        const pdfLinkRegex =
          /\[([^\]]*)\]\((https?:\/\/[^\s)]+\.pdf[^\s)]*)\)/gi;
        const match = pdfLinkRegex.exec(content);
        if (match) {
          Zotero.debug(`[seerai] Found PDF in content: ${match[2]}`);
          return {
            pdfUrl: match[2],
            pageUrl: result.url,
            source: "nanogpt",
            status: "pdf_found",
          };
        }

        const downloadRegex =
          /\[([^\]]*(?:download|pdf|full\s*text)[^\]]*)\]\((https?:\/\/[^\s)]+)\)/gi;
        const downloadMatch = downloadRegex.exec(content);
        if (downloadMatch) {
          Zotero.debug(`[seerai] Found download link: ${downloadMatch[2]}`);
          return {
            pdfUrl: downloadMatch[2],
            pageUrl: result.url,
            source: "nanogpt",
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
          source: "nanogpt",
          status: "pdf_found",
        };
      }
    }

    // No PDF found, return page URL of first result if available
    if (results.length > 0) {
      Zotero.debug(
        `[seerai] No PDF found, returning page URL: ${results[0].url}`,
      );
      return {
        pageUrl: results[0].url,
        source: "nanogpt",
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
    Zotero.debug("[seerai] NanoGPT web caches cleared");
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
      `[seerai] Cleared NanoGPT PDF cache for: ${title.slice(0, 50)}...`,
    );
  }
}

// Export singleton instance
export const nanogptWebService = new NanogptWebService();
