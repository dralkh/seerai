pref("enable", true);
pref("input", "This is input");
pref("apiURL", "https://api.openai.com/v1/");
pref("apiKey", "");
pref("model", "gpt-5-mini");
pref("datalabUseLocal", false);
pref("datalabMode", "cloud");
pref("datalabUrl", "http://localhost:8001");
pref("datalabApiKey", "");
pref("mistralApiKey", "");
pref("datalabMaxConcurrent", 5);
pref("aiMaxConcurrent", 5);
pref("localForceOcr", true);
pref("cloudForceOcr", false);
pref("cloudUseLlm", false);
pref("modelConfigs", "[]");
pref("activeModelId", "");
pref("semanticScholarApiKey", "");
pref("scholarlySearchMode", "source");
pref("scholarlySearchProvider", "semantic-scholar");
pref("scholarlySearchEmail", "");
pref("ncbiApiKey", "");
pref("coreApiKey", "");
pref("baseApiKey", "");
pref("zenodoAccessToken", "");
pref("firecrawlApiKey", "");
pref(
  "firecrawlApiUrl",
  "https://api.firecrawl.dev/v2 or http://localhost:3002/v2",
);
pref("firecrawlSearchLimit", 3);
pref("firecrawlMaxConcurrent", 3);
// Web search provider selection
pref("webSearchProvider", "firecrawl"); // "firecrawl", or "tavily"
// NanoGPT web search preferences
pref("nanogptWebApiKey", ""); // Dedicated key, or falls back to active model config's NanoGPT key
pref("nanogptWebSearchLimit", 5);
pref("nanogptWebSearchDepth", "standard"); // "standard" or "deep"
// Tavily direct preferences
pref("tavilyApiKey", "");
pref("tavilySearchLimit", 5);
pref("tavilySearchDepth", "basic");
// You.com preferences
pref("youdotcomApiKey", "");
pref("youdotcomSearchMode", "normal"); // "normal" or "research"
pref("youdotcomSearchLimit", 5);
// Agentic mode preferences
pref("agenticMode", false);
pref("libraryScope", "all"); // "user", "all", "group:ID", or "collection:libID:colID"
pref("agentMaxResults", 20);
pref("agentMaxContentLength", 50000);
pref("agentMaxIterations", 50);
pref("agentAutoOcr", false);
pref("enableExperimentalAgentTools", false);
pref("selectionMode", "default"); // "lock", "default", or "explore"
pref("searchAutoAiInsights", true); // Automatically generate AI insights after search
pref(
  "searchAiInsightsPrompt",
  "You are a professional research synthesist. Your goal is to provide a concise, high-level overview of the provided search results. Identify major research themes, common methodologies, and key findings. Highlight any significant trends or contradictions across the papers. Format your response in clean Markdown. Use headings for organization. Keep it informative but concise.",
);
pref("searchAiInsightsResponseLength", 500);
pref("searchAiInsightsCitationStyle", "numbered");
// RAG / Semantic Search preferences
pref("ragEnabled", true);
pref("ragTokenThreshold", 64000);
pref("ragTopK", 20);
pref("ragMinScore", 30);
pref("ragChunkSize", 512);
pref("ragChunkOverlap", 64);
pref("ragRrfAlpha", 55); // 0-100, RRF weight for dense vs sparse. 55 = 0.55 dense bias.
// RAG MMR (Maximal Marginal Relevance) preferences
pref("ragMmrEnabled", true);
pref("ragMmrLambda", 70); // 0-100, MMR relevance-diversity trade-off. 70 = 0.7 relevance bias.
// RAG Query Expansion
pref("ragQueryExpansion", true);
pref("ragMultiQueryExpansion", true);
// RAG HyDE (Hypothetical Document Embeddings)
pref("ragHydeEnabled", false);
// RAG Contextual Retrieval
pref("ragContextualRetrieval", false);
// RAG Sentence-Window Retrieval
pref("ragSentenceWindow", false);
pref("ragSentenceWindowSize", 3);
// RAG Query Decomposition
pref("ragQueryDecomposition", false);
// RAG Citation Graph Traversal
pref("ragCitationGraphHops", 0);
// RAG Corrective Retrieval
pref("ragCorrectiveEnabled", false);
// RAG Evaluation
pref("ragEvalEnabled", false);
pref("ragEvalGroundTruth", "");
pref("ragEvalEmbeddingModel", "");
// RAG Cross-Encoder Reranker preferences
pref("ragRerankerProvider", "none"); // "none", "jina", or "cohere"
pref("ragRerankerApiKey", "");
pref("ragRerankerModel", ""); // Empty = use provider default (jina-reranker-v3 / rerank-v4)
pref("ragRerankerTopN", 10);
pref("tableGenerationSound", true);
pref("historySidebarWidth", 120);
pref("historySidebarVisible", true);
pref("workspaceSectionCollapsed", "[]");
pref("workspaceSidebarWidth", 120);
pref("workspaceSidebarCollapsed", true);
pref("workspaceEditorHeight", 300);
pref("workspaceCustomPath", "");
pref("workspaceFolderPaths", "{}");
pref("fileViewerEnabled", true);
pref("previewExtensions", "{}");
// Google Drive integration
pref("driveClientId", "");
pref("driveClientSecret", "");
pref("driveRefreshToken", "");
pref("driveAccessToken", "");
pref("driveTokenExpiry", "0");

// Dropbox integration
pref("cloud.dropbox.clientId", "");
pref("cloud.dropbox.refreshToken", "");
pref("cloud.dropbox.accessToken", "");
pref("cloud.dropbox.tokenExpiry", "0");

// Nextcloud integration
pref("cloud.nextcloud.serverUrl", "");
pref("cloud.nextcloud.username", "");
pref("cloud.nextcloud.appPassword", "");

// Box integration
pref("cloud.box.clientId", "");
pref("cloud.box.clientSecret", "");
pref("cloud.box.refreshToken", "");
pref("cloud.box.accessToken", "");
pref("cloud.box.tokenExpiry", "0");

// OneDrive integration
pref("cloud.onedrive.clientId", "");
pref("cloud.onedrive.siteId", "");
pref("cloud.onedrive.refreshToken", "");
pref("cloud.onedrive.accessToken", "");
pref("cloud.onedrive.tokenExpiry", "0");

// Cloud provider selection
pref("cloud.activeProvider", "google");
pref("enableTerminalExecution", false);
pref("execServerUrl", "http://127.0.0.1:23120");
