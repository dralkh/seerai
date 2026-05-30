/**
 * You.com API Service
 * Provides web search and research context
 */

import { config } from "../../package.json";
import { WebSearchResult, PdfDiscoveryResult } from "./webSearchProvider";

// Response Types
interface YouSearchResponse {
  results?: {
    web?: {
      url?: string;
      title?: string;
      description?: string;
      snippets?: string[];
    }[];
  };
}

interface YouResearchResponse {
  output?: {
    content?: string;
    sources?: {
      url?: string;
      title?: string;
      snippets?: string[];
    }[];
  };
}

interface YouContentsResponse {
  contents?: {
    urls?: string[];
    [key: string]: any;
  }[];
}

class YoudotcomService {
  private lastRequestTime = 0;
  private readonly minRequestInterval = 500;

  private searchCache = new Map<string, WebSearchResult[]>();
  private pdfDiscoveryCache = new Map<string, PdfDiscoveryResult | null>();

  private getConfig() {
    const prefPrefix = config.prefsPrefix;
    return {
      apiKey:
        (Zotero.Prefs.get(`${prefPrefix}.youdotcomApiKey`) as string) || "",
      searchMode:
        (Zotero.Prefs.get(`${prefPrefix}.youdotcomSearchMode`) as string) ||
        "normal",
      searchLimit:
        (Zotero.Prefs.get(`${prefPrefix}.youdotcomSearchLimit`) as number) || 5,
    };
  }

  getSearchLimit(): number {
    return this.getConfig().searchLimit;
  }

  isConfigured(): boolean {
    const { apiKey } = this.getConfig();
    return !!apiKey;
  }

  private async rateLimit(): Promise<void> {
    const now = Date.now();
    const timeSinceLastRequest = now - this.lastRequestTime;

    if (timeSinceLastRequest < this.minRequestInterval) {
      const waitTime = this.minRequestInterval - timeSinceLastRequest;
      await new Promise((r) => setTimeout(r, waitTime));
    }

    this.lastRequestTime = Date.now();
  }

  async scrapeUrl(url: string): Promise<WebSearchResult | null> {
    if (!this.isConfigured()) {
      return null;
    }

    try {
      await this.rateLimit();
      Zotero.debug(`[seerai] You.com scrapeUrl: ${url}`);
      const { apiKey } = this.getConfig();

      const response = await fetch("https://ydc-index.io/v1/contents", {
        method: "POST",
        headers: {
          "X-API-Key": apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          urls: [url],
        }),
      });

      if (!response.ok) {
        throw new Error(
          `You.com contents error: ${response.status} ${response.statusText}`,
        );
      }

      // The you.com /v1/contents endpoint returns an array of content objects or a dictionary
      // Let's parse it and extract the raw text/markdown.
      // Typically it returns an array of objects for each URL or a single object.
      const data = (await response.json()) as any;

      // Look for any string-like content fields (like 'content', 'text', 'markdown', 'html')
      let markdown = "";
      if (Array.isArray(data)) {
        const item =
          data.find((i) => i.url === url || i.source === url) || data[0];
        if (item) {
          markdown =
            item.content || item.text || item.markdown || JSON.stringify(item);
        }
      } else if (data.contents && Array.isArray(data.contents)) {
        const item = data.contents[0];
        if (item) {
          markdown =
            item.content || item.text || item.markdown || JSON.stringify(item);
        }
      } else {
        markdown = data.content || data.text || JSON.stringify(data);
      }

      if (!markdown) {
        return null;
      }

      return {
        url: url,
        title: "", // The API might not return a reliable title
        markdown:
          typeof markdown === "string" ? markdown : JSON.stringify(markdown),
        metadata: {
          sourceURL: url,
        },
      };
    } catch (error) {
      Zotero.debug(`[seerai] You.com scrapeUrl error: ${error}`);
      return null;
    }
  }

  async webSearch(query: string, limit?: number): Promise<WebSearchResult[]> {
    if (!this.isConfigured()) {
      Zotero.debug("[seerai] You.com not configured, skipping web search");
      return [];
    }

    const { apiKey, searchMode, searchLimit } = this.getConfig();
    const actualLimit = limit || searchLimit;

    const cacheKey = `web:${query}:${actualLimit}:${searchMode}`;
    if (this.searchCache.has(cacheKey)) {
      return this.searchCache.get(cacheKey)!;
    }

    await this.rateLimit();

    try {
      Zotero.debug(
        `[seerai] You.com web search (${searchMode} mode): ${query}`,
      );
      let results: WebSearchResult[] = [];

      if (searchMode === "research") {
        const payload = {
          input: query,
          research_effort: "lite", // Using lite for faster responses, can be configurable
        };

        const response = await fetch("https://api.you.com/v1/research", {
          method: "POST",
          headers: {
            "X-API-Key": apiKey,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(payload),
        });

        if (!response.ok) {
          throw new Error(
            `You.com research error: ${response.status} ${response.statusText}`,
          );
        }

        const data = (await response.json()) as YouResearchResponse;

        const content = data.output?.content || "";
        const sources = data.output?.sources || [];

        if (content) {
          results.push({
            url: "you://research-answer",
            title: "You.com Research Answer",
            markdown: content,
            description: content.substring(0, 200),
            metadata: {
              title: "You.com Research Answer",
            },
          });
        }

        const sourceResults = sources
          .slice(0, actualLimit)
          .map((s) => ({
            url: s.url || "",
            title: s.title || "Untitled",
            description: s.title,
            markdown: `${s.title}: ${s.url}`,
            metadata: {
              title: s.title || "Untitled",
              sourceURL: s.url,
            },
          }))
          .filter((r) => !!r.url);

        results = [...results, ...sourceResults];
      } else {
        const searchUrl = `https://ydc-index.io/v1/search?query=${encodeURIComponent(query)}`;
        const response = await fetch(searchUrl, {
          method: "GET",
          headers: {
            "X-API-Key": apiKey,
          },
        });

        if (!response.ok) {
          throw new Error(
            `You.com search error: ${response.status} ${response.statusText}`,
          );
        }

        const data = (await response.json()) as YouSearchResponse;
        const webResults = data.results?.web || [];

        results = webResults
          .slice(0, actualLimit)
          .map((r) => {
            const snippet =
              r.snippets && r.snippets.length > 0
                ? r.snippets[0]
                : r.description || "";
            return {
              url: r.url || "",
              title: r.title || "Untitled",
              description: snippet,
              markdown: snippet,
              metadata: {
                title: r.title || "Untitled",
                description: snippet,
                sourceURL: r.url,
              },
            };
          })
          .filter((r) => !!r.url);
      }

      Zotero.debug(`[seerai] You.com returned ${results.length} results`);
      this.searchCache.set(cacheKey, results);
      return results;
    } catch (error) {
      Zotero.debug(`[seerai] You.com web search error: ${error}`);
      return [];
    }
  }

  async researchSearch(
    title: string,
    authors?: string[],
    doi?: string,
  ): Promise<PdfDiscoveryResult | null> {
    if (!this.isConfigured()) return null;

    let query = title;
    if (doi) {
      query = `"${doi}" OR "${title}"`;
    } else if (authors && authors.length > 0) {
      query = `"${title}" ${authors[0]}`;
    }

    const cacheKey = `research:${query}`;
    if (this.pdfDiscoveryCache.has(cacheKey)) {
      return this.pdfDiscoveryCache.get(cacheKey) ?? null;
    }

    try {
      await this.rateLimit();
      Zotero.debug(`[seerai] You.com research search: ${query}`);
      const { apiKey } = this.getConfig();

      const searchUrl = `https://ydc-index.io/v1/search?query=${encodeURIComponent(query + " PDF")}`;
      const response = await fetch(searchUrl, {
        method: "GET",
        headers: {
          "X-API-Key": apiKey,
        },
      });

      if (!response.ok) {
        throw new Error(
          `You.com search error: ${response.status} ${response.statusText}`,
        );
      }

      const data = (await response.json()) as YouSearchResponse;
      const webResults = data.results?.web || [];
      const pdfResult = this.extractPdfFromResults(
        webResults.map((r) => ({
          url: r.url || "",
          content: r.snippets?.[0] || r.description || "",
        })),
      );

      this.pdfDiscoveryCache.set(cacheKey, pdfResult);
      return pdfResult;
    } catch (error) {
      Zotero.debug(`[seerai] You.com research search error: ${error}`);
      this.pdfDiscoveryCache.set(cacheKey, null);
      return null;
    }
  }

  async searchForPdf(
    title: string,
    authors?: string[],
    doi?: string,
  ): Promise<PdfDiscoveryResult> {
    if (!this.isConfigured()) {
      return { source: "youdotcom" as any, status: "not_found" };
    }

    let query = title;
    if (doi) {
      query = `"${doi}" OR "${title}"`;
    } else if (authors && authors.length > 0) {
      query = `"${title}" ${authors[0]}`;
    }

    const cacheKey = `pdf_search:${query}`;
    if (this.pdfDiscoveryCache.has(cacheKey)) {
      return (
        this.pdfDiscoveryCache.get(cacheKey) ?? {
          source: "youdotcom" as any,
          status: "not_found",
        }
      );
    }

    try {
      await this.rateLimit();
      Zotero.debug(`[seerai] You.com PDF search: ${query}`);
      const { apiKey } = this.getConfig();

      const searchUrl = `https://ydc-index.io/v1/search?query=${encodeURIComponent(query + " filetype:pdf OR PDF download")}`;
      const response = await fetch(searchUrl, {
        method: "GET",
        headers: {
          "X-API-Key": apiKey,
        },
      });

      if (!response.ok) {
        throw new Error(
          `You.com search error: ${response.status} ${response.statusText}`,
        );
      }

      const data = (await response.json()) as YouSearchResponse;
      const webResults = data.results?.web || [];

      if (webResults.length > 0) {
        const pdfResult = this.extractPdfFromResults(
          webResults.map((r) => ({
            url: r.url || "",
            content: r.snippets?.[0] || r.description || "",
          })),
        );
        if (pdfResult) {
          this.pdfDiscoveryCache.set(cacheKey, pdfResult);
          return pdfResult;
        }
      }

      const notFoundResult: PdfDiscoveryResult = {
        source: "youdotcom" as any,
        status: "not_found",
      };
      this.pdfDiscoveryCache.set(cacheKey, notFoundResult);
      return notFoundResult;
    } catch (error) {
      Zotero.debug(`[seerai] You.com searchForPdf error: ${error}`);
      const errorResult: PdfDiscoveryResult = {
        source: "youdotcom" as any,
        status: "not_found",
      };
      this.pdfDiscoveryCache.set(cacheKey, errorResult);
      return errorResult;
    }
  }

  private extractPdfFromResults(
    results: { url: string; content: string }[],
  ): PdfDiscoveryResult | null {
    for (const result of results) {
      if (this.isPdfUrl(result.url)) {
        return {
          pdfUrl: result.url,
          source: "youdotcom" as any,
          status: "pdf_found",
        };
      }
      const content = result.content;
      if (content) {
        const pdfLinkRegex =
          /\[([^\]]*)\]\((https?:\/\/[^\s)]+\.pdf[^\s)]*)\)/gi;
        const match = pdfLinkRegex.exec(content);
        if (match) {
          return {
            pdfUrl: match[2],
            pageUrl: result.url,
            source: "youdotcom" as any,
            status: "pdf_found",
          };
        }
        const downloadRegex =
          /\[([^\]]*(?:download|pdf|full\s*text)[^\]]*)\]\((https?:\/\/[^\s)]+)\)/gi;
        const downloadMatch = downloadRegex.exec(content);
        if (downloadMatch) {
          return {
            pdfUrl: downloadMatch[2],
            pageUrl: result.url,
            source: "youdotcom" as any,
            status: "pdf_found",
          };
        }
      }
      if (result.url.includes("arxiv.org/abs/")) {
        const pdfUrl = result.url.replace("/abs/", "/pdf/") + ".pdf";
        return {
          pdfUrl: pdfUrl,
          pageUrl: result.url,
          source: "youdotcom" as any,
          status: "pdf_found",
        };
      }
    }
    if (results.length > 0) {
      return {
        pageUrl: results[0].url,
        source: "youdotcom" as any,
        status: "page_found",
      };
    }
    return null;
  }

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

  getCachedPdfResult(paperId: string): PdfDiscoveryResult | null | undefined {
    return this.pdfDiscoveryCache.get(`paper:${paperId}`);
  }

  setCachedPdfResult(paperId: string, result: PdfDiscoveryResult | null): void {
    this.pdfDiscoveryCache.set(`paper:${paperId}`, result);
  }

  clearCache(): void {
    this.searchCache.clear();
    this.pdfDiscoveryCache.clear();
  }

  clearPdfCache(): void {
    this.pdfDiscoveryCache.clear();
  }

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
  }
}

export const youdotcomService = new YoudotcomService();
