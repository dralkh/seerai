/**
 * Shared type definitions for the RAG (Retrieval-Augmented Generation) system.
 * Covers embedding API types, document chunks, vector storage, and retrieval.
 */

// ─── Embedding API Types (OpenAI-compatible) ───────────────────────────────

/** Request body for POST /v1/embeddings */
export interface EmbeddingRequest {
  input: string | string[];
  model: string;
  encoding_format?: "float" | "base64";
  dimensions?: number;
  user?: string;
}

/** Single embedding object in the response */
export interface EmbeddingData {
  object: "embedding";
  index: number;
  embedding: number[];
}

/** Response from POST /v1/embeddings */
export interface EmbeddingResponse {
  object: "list";
  data: EmbeddingData[];
  model: string;
  usage: {
    prompt_tokens: number;
    total_tokens: number;
  };
}

/** OpenAI-compatible error response */
export interface EmbeddingError {
  error: {
    message: string;
    type: string;
    param: string | null;
    code: string | null;
  };
}

/** Embedding model metadata from GET /api/v1/embedding-models */
export interface EmbeddingModelInfo {
  id: string;
  object: "model";
  created: number;
  owned_by: string;
  name?: string;
  description?: string;
  dimensions: number;
  supports_dimensions: boolean;
  max_tokens: number;
  pricing: {
    per_million_tokens: number;
    currency: string;
  };
}

/** Response from GET /api/v1/embedding-models */
export interface EmbeddingModelsListResponse {
  object: "list";
  data: EmbeddingModelInfo[];
}

// ─── Document Chunking Types ────────────────────────────────────────────────

/** Source type for a document chunk */
export type ChunkSource =
  | "pdf"
  | "note"
  | "abstract"
  | "metadata"
  | "table"
  | "file";

/** A single chunk of text from a document, ready for embedding */
export interface DocumentChunk {
  /** Unique ID: `${itemId}_${source}_${chunkIndex}` */
  id: string;
  /** Zotero item ID */
  itemId: number;
  /** The chunk text content */
  text: string;
  /** Where this chunk came from */
  source: ChunkSource;
  /** Position in the sequence of chunks for this source */
  chunkIndex: number;
  /** Additional metadata */
  metadata: {
    title?: string;
    authors?: string[];
    section?: string;
    startOffset: number;
    endOffset: number;
  };
}

/** A chunk with its computed embedding vector */
export interface EmbeddedChunk extends DocumentChunk {
  embedding: number[];
  embeddingModel: string;
}

// ─── Vector Store Types ─────────────────────────────────────────────────────

/** Stored data for a single Zotero item's embeddings */
export interface VectorStoreEntry {
  itemId: number;
  chunks: EmbeddedChunk[];
  embeddingModel: string;
  dimensions: number;
  contentHash: string;
  indexedAt: string; // ISO date
}

/** Per-item metadata in the global index (no embedding vectors) */
export interface VectorIndexEntry {
  itemId: number;
  chunkCount: number;
  embeddingModel: string;
  dimensions: number;
  contentHash: string;
  lastIndexedAt: string; // ISO date
}

/** Global index manifest file */
export interface VectorStoreIndex {
  version: number;
  entries: Record<number, VectorIndexEntry>; // keyed by itemId
  updatedAt: string; // ISO date
}

/** Statistics about the vector store */
export interface VectorStoreStats {
  totalItems: number;
  totalChunks: number;
  embeddingModel: string | null;
  dimensions: number | null;
}

/** Result from a vector similarity search, including mismatch diagnostics */
export interface VectorSearchResult {
  chunks: RetrievedChunk[];
  /**
   * True if stored vectors had different dimensions than the query vector.
   * When true, `chunks` will be empty — the caller should clear stale items
   * and re-index before retrying.
   */
  dimensionMismatch: boolean;
  /** Item IDs whose stored vectors had mismatched dimensions */
  mismatchedItemIds: number[];
}

// ─── Retrieval Types ────────────────────────────────────────────────────────

/** RAG pipeline step identifiers for progress reporting */
export type RAGProgressStep =
  | "indexing"
  | "embedding-query"
  | "searching"
  | "reranking"
  | "assembling"
  | "embedding-passthrough"
  | "complete";

/** Progress event emitted during RAG retrieval */
export interface RAGProgressEvent {
  /** Current pipeline step */
  step: RAGProgressStep;
  /** Human-readable status message */
  message: string;
  /** Optional: ranked results available so far */
  rankedResults?: Array<{
    title: string;
    score: number;
    source: string;
    /** Preview of the chunk content (first ~300 chars) */
    description?: string;
  }>;
  /** Optional: stats snapshot */
  stats?: {
    itemsToIndex?: number;
    itemsIndexed?: number;
    candidateCount?: number;
    selectedCount?: number;
    tokensUsed?: number;
    tier?: 1 | 2 | 3;
  };
}

/** Callback for receiving RAG progress updates */
export type RAGProgressCallback = (event: RAGProgressEvent) => void;

/** Options for retrieval queries */
export interface RetrievalOptions {
  /** Maximum chunks to retrieve (default: 20) */
  topK?: number;
  /** Token budget for retrieved context */
  maxTokens?: number;
  /** Minimum cosine similarity threshold (default: 0.3) */
  minScore?: number;
  /** Enable re-ranking by source priority and recency (default: true) */
  rerank?: boolean;
  /**
   * Verbatim context for non-indexable items (tables, files, topics).
   * Appended to the assembled RAG context without vector search.
   */
  passthroughContext?: string;
  /** Computed token budget from the model's context window */
  tokenBudget?: TokenBudget;
  /** Enable adaptive retrieval (CAR-style relevance cliff detection) */
  adaptiveRetrieval?: boolean;
  /** Callback for live progress updates during retrieval */
  onProgress?: RAGProgressCallback;
}

/** A retrieved chunk with its relevance score */
export interface RetrievedChunk {
  chunk: EmbeddedChunk;
  /** Combined relevance score (0-1) */
  score: number;
  /** Source item info for attribution */
  sourceItem: {
    title: string;
    id: number;
  };
}

/** Result of a retrieval operation */
export interface RetrievalResult {
  /** Formatted context string ready for system prompt injection */
  context: string;
  /** Individual retrieved chunks with scores */
  chunks: RetrievedChunk[];
  /** Statistics about the retrieval */
  stats: {
    totalChunksSearched: number;
    chunksRetrieved: number;
    tokensUsed: number;
    itemsIndexedOnDemand: number;
    queryTimeMs: number;
  };
}

// ─── RAG Configuration ──────────────────────────────────────────────────────

/** Runtime RAG configuration derived from preferences */
export interface RAGConfig {
  enabled: boolean;
  tokenThreshold: number;
  topK: number;
  minScore: number;
  chunkSize: number;
  chunkOverlap: number;
  adaptiveRetrieval?: boolean; // Enable CAR-style adaptive chunk selection (default: true)
  minScoreThreshold?: number; // Floor threshold for any result (default: 0.3)
}

/** Default RAG configuration values */
export const DEFAULT_RAG_CONFIG: RAGConfig = {
  enabled: true,
  tokenThreshold: 64000,
  topK: 20,
  minScore: 0.3,
  chunkSize: 512,
  chunkOverlap: 64,
  adaptiveRetrieval: true,
  minScoreThreshold: 0.3,
};

// ─── Token Budget Types ─────────────────────────────────────────────────────

/** Token budget computed from the model's context window */
export interface TokenBudget {
  /** Total model context window (tokens) */
  contextLength: number;
  /** Estimated system prompt size (tokens) */
  systemPromptTokens: number;
  /** All conversation history (tokens) */
  conversationTokens: number;
  /** Web search results (tokens) */
  webResultTokens: number;
  /** Reserved for model response (tokens) */
  reservedOutputTokens: number;
  /** Safety buffer — 5% of contextLength */
  safetyMargin: number;
  /** What's left for RAG chunks + passthrough content */
  availableForContent: number;
}
