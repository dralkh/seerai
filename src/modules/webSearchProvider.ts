/**
 * Web Search Provider Abstraction
 * Unified interface for web search providers (NanoGPT, Firecrawl, Tavily)
 *
 * Allows switching between providers via preferences without
 * changing tool/consumer code.
 */

import { config } from "../../package.json";
import {
  firecrawlService,
  FirecrawlSearchResult as FirecrawlResult,
} from "./firecrawl";
import { tavilyService, WebSearchResult as TavilyResult } from "./tavily";
import { nanogptWebService } from "./nanogptWeb";

// ==================== Types ====================

export type WebSearchProviderType = "firecrawl" | "tavily" | "nanogpt";

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
  source: WebSearchProviderType;
  status: "pdf_found" | "page_found" | "not_found";
}

export interface WebSearchProvider {
  isConfigured(): boolean;
  webSearch(query: string, limit?: number): Promise<WebSearchResult[]>;
  scrapeUrl(url: string): Promise<WebSearchResult | null>;
  researchSearch(
    title: string,
    authors?: string[],
    doi?: string,
  ): Promise<PdfDiscoveryResult | null>;
  searchForPdf(
    title: string,
    authors?: string[],
    doi?: string,
  ): Promise<PdfDiscoveryResult>;
  getCachedPdfResult(paperId: string): PdfDiscoveryResult | null | undefined;
  setCachedPdfResult(paperId: string, result: PdfDiscoveryResult | null): void;
  clearCache(): void;
  clearPdfCache(): void;
  clearPdfCacheForPaper(title: string, authors?: string[], doi?: string): void;
  getSearchLimit(): number;
}

// ==================== Provider Wrapper ====================

/**
 * Wraps Firecrawl service to conform to WebSearchProvider interface
 */
class FirecrawlProviderWrapper implements WebSearchProvider {
  isConfigured(): boolean {
    return firecrawlService.isConfigured();
  }

  async webSearch(query: string, limit?: number): Promise<WebSearchResult[]> {
    const results = await firecrawlService.webSearch(query, limit);
    return results.map(this.normalizeResult);
  }

  async scrapeUrl(url: string): Promise<WebSearchResult | null> {
    const result = await firecrawlService.scrapeUrl(url);
    return result ? this.normalizeResult(result) : null;
  }

  async researchSearch(
    title: string,
    authors?: string[],
    doi?: string,
  ): Promise<PdfDiscoveryResult | null> {
    const result = await firecrawlService.researchSearch(title, authors, doi);
    return result ? { ...result, source: "firecrawl" as const } : null;
  }

  async searchForPdf(
    title: string,
    authors?: string[],
    doi?: string,
  ): Promise<PdfDiscoveryResult> {
    const result = await firecrawlService.searchForPdf(title, authors, doi);
    return { ...result, source: "firecrawl" as const };
  }

  getCachedPdfResult(paperId: string): PdfDiscoveryResult | null | undefined {
    const result = firecrawlService.getCachedPdfResult(paperId);
    return result ? { ...result, source: "firecrawl" as const } : result;
  }

  setCachedPdfResult(paperId: string, result: PdfDiscoveryResult | null): void {
    firecrawlService.setCachedPdfResult(
      paperId,
      result ? { ...result, source: "firecrawl" } : null,
    );
  }

  clearCache(): void {
    firecrawlService.clearCache();
  }

  clearPdfCache(): void {
    firecrawlService.clearPdfCache();
  }

  clearPdfCacheForPaper(title: string, authors?: string[], doi?: string): void {
    firecrawlService.clearPdfCacheForPaper(title, authors, doi);
  }

  getSearchLimit(): number {
    return firecrawlService.getSearchLimit();
  }

  private normalizeResult(result: FirecrawlResult): WebSearchResult {
    return {
      url: result.url,
      title: result.title,
      description: result.description,
      markdown: result.markdown,
      links: result.links,
      metadata: result.metadata,
    };
  }
}

/**
 * Wraps Tavily service to conform to WebSearchProvider interface
 */
class TavilyProviderWrapper implements WebSearchProvider {
  isConfigured(): boolean {
    return tavilyService.isConfigured();
  }

  async webSearch(query: string, limit?: number): Promise<WebSearchResult[]> {
    return await tavilyService.webSearch(query, limit);
  }

  async scrapeUrl(url: string): Promise<WebSearchResult | null> {
    return await tavilyService.scrapeUrl(url);
  }

  async researchSearch(
    title: string,
    authors?: string[],
    doi?: string,
  ): Promise<PdfDiscoveryResult | null> {
    const result = await tavilyService.researchSearch(title, authors, doi);
    return result ? { ...result, source: "tavily" as const } : null;
  }

  async searchForPdf(
    title: string,
    authors?: string[],
    doi?: string,
  ): Promise<PdfDiscoveryResult> {
    const result = await tavilyService.searchForPdf(title, authors, doi);
    return { ...result, source: "tavily" as const };
  }

  getCachedPdfResult(paperId: string): PdfDiscoveryResult | null | undefined {
    const result = tavilyService.getCachedPdfResult(paperId);
    return result ? { ...result, source: "tavily" as const } : result;
  }

  setCachedPdfResult(paperId: string, result: PdfDiscoveryResult | null): void {
    tavilyService.setCachedPdfResult(
      paperId,
      result ? { ...result, source: "tavily" } : null,
    );
  }

  clearCache(): void {
    tavilyService.clearCache();
  }

  clearPdfCache(): void {
    tavilyService.clearPdfCache();
  }

  clearPdfCacheForPaper(title: string, authors?: string[], doi?: string): void {
    tavilyService.clearPdfCacheForPaper(title, authors, doi);
  }

  getSearchLimit(): number {
    return tavilyService.getSearchLimit();
  }
}

/**
 * Wraps NanoGPT web search service to conform to WebSearchProvider interface
 */
class NanogptProviderWrapper implements WebSearchProvider {
  isConfigured(): boolean {
    return nanogptWebService.isConfigured();
  }

  async webSearch(query: string, limit?: number): Promise<WebSearchResult[]> {
    return await nanogptWebService.webSearch(query, limit);
  }

  async scrapeUrl(url: string): Promise<WebSearchResult | null> {
    return await nanogptWebService.scrapeUrl(url);
  }

  async researchSearch(
    title: string,
    authors?: string[],
    doi?: string,
  ): Promise<PdfDiscoveryResult | null> {
    const result = await nanogptWebService.researchSearch(title, authors, doi);
    return result ? { ...result, source: "nanogpt" as const } : null;
  }

  async searchForPdf(
    title: string,
    authors?: string[],
    doi?: string,
  ): Promise<PdfDiscoveryResult> {
    const result = await nanogptWebService.searchForPdf(title, authors, doi);
    return { ...result, source: "nanogpt" as const };
  }

  getCachedPdfResult(paperId: string): PdfDiscoveryResult | null | undefined {
    const result = nanogptWebService.getCachedPdfResult(paperId);
    return result ? { ...result, source: "nanogpt" as const } : result;
  }

  setCachedPdfResult(paperId: string, result: PdfDiscoveryResult | null): void {
    nanogptWebService.setCachedPdfResult(
      paperId,
      result ? { ...result, source: "nanogpt" } : null,
    );
  }

  clearCache(): void {
    nanogptWebService.clearCache();
  }

  clearPdfCache(): void {
    nanogptWebService.clearPdfCache();
  }

  clearPdfCacheForPaper(title: string, authors?: string[], doi?: string): void {
    nanogptWebService.clearPdfCacheForPaper(title, authors, doi);
  }

  getSearchLimit(): number {
    return nanogptWebService.getSearchLimit();
  }
}

// ==================== Singleton Instances ====================

const firecrawlProvider = new FirecrawlProviderWrapper();
const tavilyProvider = new TavilyProviderWrapper();
const nanogptProvider = new NanogptProviderWrapper();

// ==================== Provider Selection ====================

/**
 * Get the currently selected web search provider from preferences
 */
export function getActiveProviderType(): WebSearchProviderType {
  const prefPrefix = config.prefsPrefix;
  const provider = Zotero.Prefs.get(
    `${prefPrefix}.webSearchProvider`,
  ) as string;
  if (provider === "nanogpt") return "nanogpt";
  if (provider === "tavily") return "tavily";
  return "firecrawl";
}

/**
 * Get the active web search provider instance
 */
export function getActiveProvider(): WebSearchProvider {
  const providerType = getActiveProviderType();
  if (providerType === "nanogpt") return nanogptProvider;
  if (providerType === "tavily") return tavilyProvider;
  return firecrawlProvider;
}

/**
 * Get a specific provider by type
 */
export function getProvider(type: WebSearchProviderType): WebSearchProvider {
  if (type === "nanogpt") return nanogptProvider;
  if (type === "tavily") return tavilyProvider;
  return firecrawlProvider;
}

/**
 * Check if any web search provider is configured
 */
export function isAnyProviderConfigured(): boolean {
  return (
    nanogptProvider.isConfigured() ||
    firecrawlProvider.isConfigured() ||
    tavilyProvider.isConfigured()
  );
}

/**
 * Check if the active provider is configured
 */
export function isActiveProviderConfigured(): boolean {
  return getActiveProvider().isConfigured();
}

/**
 * Get list of configured providers
 */
export function getConfiguredProviders(): WebSearchProviderType[] {
  const providers: WebSearchProviderType[] = [];
  if (nanogptProvider.isConfigured()) providers.push("nanogpt");
  if (firecrawlProvider.isConfigured()) providers.push("firecrawl");
  if (tavilyProvider.isConfigured()) providers.push("tavily");
  return providers;
}

/**
 * Get human-readable name for provider
 */
export function getProviderDisplayName(type: WebSearchProviderType): string {
  switch (type) {
    case "nanogpt":
      return "NanoGPT (Tavily)";
    case "firecrawl":
      return "Firecrawl";
    case "tavily":
      return "Tavily";
    default:
      return type;
  }
}
