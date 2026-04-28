/**
 * You.com Search API Service
 * Provides web search and page scraping for AI context
 */

import { config } from "../../package.json";

export interface YouWebSearchResult {
  url: string;
  title: string;
  description?: string;
  snippets?: string[];
  contents?: { markdown?: string; html?: string };
}

export interface YouSearchResponse {
  results?: { web?: YouWebSearchResult[]; news?: YouWebSearchResult[] };
}

export interface WebSearchResult {
  url: string;
  title: string;
  description?: string;
  markdown?: string;
  metadata?: {
    title?: string;
    description?: string;
    sourceURL?: string;
  };
}

class YouSearchService {
  private lastRequestTime = 0;
  private readonly minRequestInterval = 500;

  private getConfig() {
    const prefPrefix = config.prefsPrefix;
    return {
      apiKey: (Zotero.Prefs.get(`${prefPrefix}.youApiKey`) as string) || "",
      searchLimit:
        (Zotero.Prefs.get(`${prefPrefix}.youSearchLimit`) as number) || 5,
    };
  }

  getSearchLimit(): number {
    return this.getConfig().searchLimit;
  }

  isConfigured(): boolean {
    return !!this.getConfig().apiKey;
  }

  private async rateLimitedFetch(url: string, options: RequestInit = {}) {
    const now = Date.now();
    const delta = now - this.lastRequestTime;
    if (delta < this.minRequestInterval) {
      await new Promise((r) => setTimeout(r, this.minRequestInterval - delta));
    }
    this.lastRequestTime = Date.now();
    return fetch(url, options);
  }

  async webSearch(query: string, limit: number = 5): Promise<WebSearchResult[]> {
    const { apiKey } = this.getConfig();
    const url = new URL("https://api.you.com/v1/agents/search");
    url.searchParams.set("query", query);
    url.searchParams.set("count", String(limit));

    const headers: Record<string, string> = {};
    if (apiKey) headers["X-API-Key"] = apiKey;

    const response = await this.rateLimitedFetch(url.toString(), { headers });
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`you.com search error (${response.status}): ${errorText}`);
    }

    const data = (await response.json()) as YouSearchResponse;
    const web = data.results?.web || [];

    return web.map((r) => ({
      url: r.url,
      title: r.title,
      description: r.snippets?.[0] || r.description || "",
      markdown: r.contents?.markdown,
      metadata: {
        title: r.title,
        description: r.description,
        sourceURL: r.url,
      },
    }));
  }

  async scrapeUrl(url: string): Promise<WebSearchResult | null> {
    const { apiKey } = this.getConfig();
    if (!apiKey) {
      return null;
    }

    const response = await this.rateLimitedFetch("https://ydc-index.io/v1/contents", {
      method: "POST",
      headers: {
        "X-API-Key": apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ urls: [url], formats: ["markdown", "metadata"] }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`you.com contents error (${response.status}): ${errorText}`);
    }

    const items = (await response.json()) as Array<{
      url: string;
      title?: string;
      markdown?: string;
      metadata?: { description?: string };
    }>;

    if (!items.length) return null;
    const item = items[0];
    return {
      url: item.url,
      title: item.title || url,
      description: item.metadata?.description,
      markdown: item.markdown,
      metadata: {
        title: item.title,
        description: item.metadata?.description,
        sourceURL: item.url,
      },
    };
  }
}

export const youSearchService = new YouSearchService();
