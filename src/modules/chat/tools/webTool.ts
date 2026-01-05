/**
 * Web Research Tools Implementation
 * Uses unified web search provider (Firecrawl or Tavily) for searching the web and reading pages
 */

import {
    AgentConfig,
    ReadWebPageParams,
    SearchWebParams,
    WebParams,
    ToolResult
} from "./toolTypes";
import { getActiveProvider, getActiveProviderType, getProviderDisplayName } from "../../webSearchProvider";

/**
 * Unified web tool dispatcher
 * Routes to search or read actions
 */
export async function executeWeb(
    params: WebParams,
    config: AgentConfig
): Promise<ToolResult> {
    Zotero.debug(`[seerai] Tool: web action=${params.action}`);

    switch (params.action) {
        case "search":
            return executeSearchWeb({ query: params.query!, limit: params.limit }, config);
        case "read":
            return executeReadWebPage({ url: params.url! }, config);
        default:
            return { success: false, error: `Unknown web action: ${(params as any).action}` };
    }
}

/**
 * Execute search_web tool
 */
export async function executeSearchWeb(
    params: SearchWebParams,
    _config: AgentConfig
): Promise<ToolResult> {
    try {
        const { query, limit = 5 } = params;

        const provider = getActiveProvider();
        const providerType = getActiveProviderType();

        if (!provider.isConfigured()) {
            return {
                success: false,
                error: `${getProviderDisplayName(providerType)} API is not configured. Please set the API key in settings.`
            };
        }

        Zotero.debug(`[seerai] Tool: search_web query="${query}" limit=${limit} provider=${providerType}`);

        const results = await provider.webSearch(query, limit);

        return {
            success: true,
            data: {
                results: results.map(r => ({
                    title: r.title,
                    url: r.url,
                    description: r.description || ""
                })),
                total: results.length
            },
            summary: `Found ${results.length} web results for "${query}"`
        };

    } catch (error) {
        Zotero.debug(`[seerai] Tool: search_web error: ${error}`);
        return {
            success: false,
            error: error instanceof Error ? error.message : String(error)
        };
    }
}

/**
 * Execute read_webpage tool
 */
export async function executeReadWebPage(
    params: ReadWebPageParams,
    _config: AgentConfig
): Promise<ToolResult> {
    try {
        const { url } = params;

        const provider = getActiveProvider();
        const providerType = getActiveProviderType();

        if (!provider.isConfigured()) {
            return {
                success: false,
                error: `${getProviderDisplayName(providerType)} API is not configured. Please set the API key in settings.`
            };
        }

        Zotero.debug(`[seerai] Tool: read_webpage url="${url}" provider=${providerType}`);

        const result = await provider.scrapeUrl(url);

        if (!result) {
            return {
                success: false,
                error: "Failed to scrape URL or no content returned."
            };
        }

        return {
            success: true,
            data: {
                markdown: result.markdown || "",
                title: result.metadata?.title || result.title || "",
                url: result.metadata?.sourceURL || result.url
            },
            summary: `Successfully read content from ${result.metadata?.title || url}`
        };

    } catch (error) {
        Zotero.debug(`[seerai] Tool: read_webpage error: ${error}`);
        return {
            success: false,
            error: error instanceof Error ? error.message : String(error)
        };
    }
}
