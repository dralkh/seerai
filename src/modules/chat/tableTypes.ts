/**
 * Type definitions for Papers Table feature
 */

// Column definition for the papers table
export interface TableColumn {
    id: string;
    name: string;
    width: number;        // Width in pixels
    minWidth: number;     // Minimum width in pixels
    visible: boolean;
    sortable: boolean;
    resizable: boolean;
    type: 'text' | 'date' | 'number' | 'computed';
    computeFrom?: string; // For AI-generated columns, describes the source
    aiPrompt?: string;    // Custom AI prompt for generating this column's content
}

// Default columns that every table has
export const defaultColumns: TableColumn[] = [
    {
        id: 'title',
        name: 'Title',
        width: 200,
        minWidth: 100,
        visible: true,
        sortable: true,
        resizable: true,
        type: 'text',
    },
    {
        id: 'author',
        name: 'Author',
        width: 150,
        minWidth: 80,
        visible: true,
        sortable: true,
        resizable: true,
        type: 'text',
    },
    {
        id: 'year',
        name: 'Year',
        width: 60,
        minWidth: 50,
        visible: true,
        sortable: true,
        resizable: true,
        type: 'text',
    },
    {
        id: 'sources',
        name: 'Sources',
        width: 100,
        minWidth: 60,
        visible: true,
        sortable: false,
        resizable: true,
        type: 'number',
    },
    {
        id: 'analysisMethodology',
        name: 'Analysis Methodology',
        width: 180,
        minWidth: 100,
        visible: true,
        sortable: false,
        resizable: true,
        type: 'computed',
        computeFrom: 'note_content',
        aiPrompt: 'Identify and briefly describe the analysis methodology or research method used in this paper.',
    },
];

// Persisted PDF discovery result for table persistence (per paper)
export interface PersistedPdfDiscovery {
    status: 'not_run' | 'found' | 'source_link' | 'not_found' | 'error';
    pdfUrl?: string;      // Direct PDF URL if found
    sourceUrl?: string;   // Source link URL (arXiv, PMC, DOI resolver, etc.)
    discoveredAt?: string; // ISO timestamp of discovery
}

// Table configuration that gets persisted
export interface TableConfig {
    id: string;
    name: string;
    columns: TableColumn[];
    sortBy?: string;
    sortOrder?: 'asc' | 'desc';
    filterQuery?: string;
    responseLength: number; // For AI-generated content length control
    // Filter settings
    filterLibraryId?: number | null;      // Filter to specific library
    filterCollectionId?: number | null;    // Filter to specific collection
    // Pagination settings
    pageSize: number;
    currentPage: number;
    // Manually added papers (table is empty until user adds)
    addedPaperIds: number[];
    // Persisted generated data: { paperId: { columnId: value } }
    generatedData?: { [paperId: number]: { [columnId: string]: string } };
    // Persisted PDF discovery results: { paperId: PersistedPdfDiscovery }
    pdfDiscoveryData?: { [paperId: number]: PersistedPdfDiscovery };
    createdAt: string;
    updatedAt: string;
}

// Column preset for saving/loading column configurations
export interface ColumnPreset {
    id: string;
    name: string;
    columns: TableColumn[];
    createdAt: string;
}

// Default table configuration
export const defaultTableConfig: Omit<TableConfig, 'id' | 'createdAt' | 'updatedAt'> = {
    name: 'Default Table',
    columns: defaultColumns,
    sortBy: 'title',
    sortOrder: 'asc',
    filterQuery: '',
    responseLength: 100, // characters
    filterLibraryId: null,
    filterCollectionId: null,
    pageSize: 25,
    currentPage: 1,
    addedPaperIds: [], // Initially empty
};

// A row in the papers table
export interface TableRow {
    paperId: number;
    paperTitle: string;
    noteIds: number[];
    noteTitle: string; // The matching note title
    data: Record<string, string>; // column id -> value
}

// Table data state (not persisted, computed at runtime)
export interface TableData {
    rows: TableRow[];
    selectedRowIds: Set<number>;
    isLoading: boolean;
    error?: string;
    // Pagination metadata
    totalRows: number;
    totalPages: number;
    currentPage: number;
    pageSize: number;
}

// History entry for table configurations
export interface TableHistoryEntry {
    config: TableConfig;
    usedAt: string;
}

// Complete table history storage
export interface TableHistory {
    entries: TableHistoryEntry[];
    maxEntries: number;
}

// Default empty table history
export const defaultTableHistory: TableHistory = {
    entries: [],
    maxEntries: 20,
};

// Active tab state
export type AssistantTab = 'chat' | 'table' | 'search';

// ==================== Search Tab Types ====================

// Search state persisted between sessions
export interface SearchState {
    query: string;
    limit: number;
    yearStart?: string;
    yearEnd?: string;
    openAccessPdf: boolean;
    hideLibraryDuplicates: boolean;
    fieldsOfStudy: string[];
    publicationTypes: string[];
    minCitationCount?: number;
    venue?: string;
    sortBy: 'relevance' | 'citationCount:desc' | 'publicationDate:desc';
    // Save location: 'user' for user library, 'lib_ID' for group library, 'col_ID' for collection
    saveLocation: string;
    // Cached AI insights for this search query
    cachedAiInsights?: string;
    // AI insights configuration
    searchAiInsightsPrompt?: string;
    searchAiInsightsResponseLength?: number;
}

export const defaultSearchState: SearchState = {
    query: '',
    limit: 20,
    openAccessPdf: false,
    hideLibraryDuplicates: true,
    fieldsOfStudy: [],
    publicationTypes: [],
    sortBy: 'relevance',
    saveLocation: 'user', // Default to user library
    searchAiInsightsPrompt: `You are an expert research analyst specializing in academic literature synthesis. Your role is to provide rigorous, insightful analysis of research papers.

For the given search results:
1. **Research Landscape**: Identify the key research themes, methodological approaches, and theoretical frameworks
2. **Critical Analysis**: Highlight significant findings, notable gaps, and areas of consensus or controversy
3. **Connections**: Draw connections between papers using citation format [N] to reference specific works
4. **Implications**: Discuss practical implications and future research directions

Format in clean Markdown with clear headings. Be analytical and substantive, not just descriptive. When referencing papers, use [N] format so readers can click to navigate.`,
    searchAiInsightsResponseLength: 800,
};

// ==================== Search Analysis Column Types ====================

// Search analysis column for in-place paper analysis (without Zotero import)
export interface SearchAnalysisColumn {
    id: string;
    name: string;
    aiPrompt: string;
    width: number;
}

// Search column configuration storage
export interface SearchColumnConfig {
    columns: SearchAnalysisColumn[];
    // Cache of generated values: { paperId: { columnId: value } }
    generatedData: { [paperId: string]: { [columnId: string]: string } };
    responseLength: number;
}

// Default empty search column configuration
export const defaultSearchColumnConfig: SearchColumnConfig = {
    columns: [],
    generatedData: {},
    responseLength: 100 // Default to short/concise
};
