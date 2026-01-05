/**
 * Citation Network Tools Implementation
 * Uses Semantic Scholar for citation graph traversal
 */

import {
    AgentConfig,
    GetCitationsParams,
    GetReferencesParams,
    RelatedPapersParams,
    ToolResult
} from "./toolTypes";
import { semanticScholarService } from "../../semanticScholar";

/**
 * Unified related papers tool dispatcher
 * Routes to citations or references actions
 */
export async function executeRelatedPapers(
    params: RelatedPapersParams,
    config: AgentConfig
): Promise<ToolResult> {
    Zotero.debug(`[seerai] Tool: related_papers action=${params.action}`);

    switch (params.action) {
        case "citations":
            return executeGetCitations({ paper_id: params.paper_id, limit: params.limit }, config);
        case "references":
            return executeGetReferences({ paper_id: params.paper_id, limit: params.limit }, config);
        default:
            return { success: false, error: `Unknown related_papers action: ${(params as any).action}` };
    }
}

/**
 * Execute get_citations tool (Forward Citations)
 */
export async function executeGetCitations(
    params: GetCitationsParams,
    _config: AgentConfig
): Promise<ToolResult> {
    try {
        const { paper_id, limit = 10 } = params;

        Zotero.debug(`[seerai] Tool: get_citations paperId="${paper_id}" limit=${limit}`);

        const results = await semanticScholarService.getCitations(paper_id, limit);

        const papers = results.data.map(p => ({
            paperId: p.paperId,
            title: p.title,
            authors: (p.authors || []).map((a: any) => a.name),
            year: p.year,
            citationCount: p.citationCount,
            url: p.url,
            has_pdf: !!p.openAccessPdf,
            intent: p.intents ? p.intents[0] : undefined
        }));

        return {
            success: true,
            data: {
                total: results.total,
                papers
            },
            summary: `Found ${results.total} citations, returning ${papers.length}`
        };

    } catch (error) {
        Zotero.debug(`[seerai] Tool: get_citations error: ${error}`);
        return {
            success: false,
            error: error instanceof Error ? error.message : String(error)
        };
    }
}

/**
 * Execute get_references tool (Backward References)
 */
export async function executeGetReferences(
    params: GetReferencesParams,
    _config: AgentConfig
): Promise<ToolResult> {
    try {
        const { paper_id, limit = 10 } = params;

        Zotero.debug(`[seerai] Tool: get_references paperId="${paper_id}" limit=${limit}`);

        const results = await semanticScholarService.getReferences(paper_id, limit);

        const papers = results.data.map(p => ({
            paperId: p.paperId,
            title: p.title,
            authors: (p.authors || []).map((a: any) => a.name),
            year: p.year,
            citationCount: p.citationCount,
            url: p.url,
            has_pdf: !!p.openAccessPdf,
            isInfluential: p.isInfluential
        }));

        return {
            success: true,
            data: {
                total: results.total,
                papers
            },
            summary: `Found ${results.total} references, returning ${papers.length}`
        };

    } catch (error) {
        Zotero.debug(`[seerai] Tool: get_references error: ${error}`);
        return {
            success: false,
            error: error instanceof Error ? error.message : String(error)
        };
    }
}
