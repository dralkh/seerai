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
pref("firecrawlApiKey", "");
pref("firecrawlApiUrl", "https://api.firecrawl.dev/v2 or http://localhost:3002/v2");
pref("firecrawlSearchLimit", 3);
pref("firecrawlMaxConcurrent", 3);
// Agentic mode preferences
pref("agenticMode", true);
pref("libraryScope", "all");  // "user", "all", "group:ID", or "collection:libID:colID"
pref("agentMaxResults", 20);
pref("agentMaxContentLength", 50000);
pref("agentMaxIterations", 1000);
pref("agentAutoOcr", false);
pref("selectionMode", "default");  // "lock", "default", or "explore"
pref("searchAutoAiInsights", true);  // Automatically generate AI insights after search
pref("searchAiInsightsPrompt", "You are a professional research synthesist. Your goal is to provide a concise, high-level overview of the provided search results. Identify major research themes, common methodologies, and key findings. Highlight any significant trends or contradictions across the papers. Format your response in clean Markdown. Use headings for organization. Keep it informative but concise.");
pref("searchAiInsightsResponseLength", 500);
pref("searchAiInsightsCitationStyle", "numbered");

