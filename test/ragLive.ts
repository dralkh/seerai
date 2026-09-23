/**
 * Live RAG evaluation against a real embedding provider (NanoGPT by default).
 *
 * Run with:  npx tsx test/ragLive.ts     (or: npm run test:rag-live)
 *
 * Reads `.env` from the repo root (falling back to process env):
 *   EMBEDDING_BASE_URL   default: https://nano-gpt.com/api/v1
 *   EMBEDDING_API_KEY    falls back to NANOGPT_API_KEY, then LLM_API_KEY
 *   EMBEDDING_MODEL      required, e.g. text-embedding-3-small
 *   EMBEDDING_DIMENSIONS optional dimension reduction (only sent when the
 *                        provider advertises support)
 *
 * No Zotero required: minimal Zotero/IOUtils/PathUtils stubs back a temp data
 * directory, then the REAL embedding client, chunker, vector store and
 * retrieval pipeline run against the provider. The API key is only written to
 * that temp provider config (never to the repo).
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── .env parsing (same convention as test/llmLive.ts) ───────────────────────

function loadEnv(): Record<string, string> {
  const vars: Record<string, string> = {};
  try {
    for (const line of fs
      .readFileSync(path.resolve(__dirname, "..", ".env"), "utf-8")
      .split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq < 0) continue;
      vars[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
    }
  } catch {
    // .env not found — rely on process.env
  }
  return { ...vars, ...(process.env as Record<string, string>) };
}

const ENV = loadEnv();
const BASE_URL = ENV.EMBEDDING_BASE_URL || "https://nano-gpt.com/api/v1";
const API_KEY =
  ENV.EMBEDDING_API_KEY || ENV.NANOGPT_API_KEY || ENV.LLM_API_KEY || "";
const MODEL = ENV.EMBEDDING_MODEL || ENV.LLM_EMBEDDING_MODEL || "";
const DIMENSIONS = ENV.EMBEDDING_DIMENSIONS
  ? parseInt(ENV.EMBEDDING_DIMENSIONS, 10)
  : undefined;
// Optional second model: re-runs retrieval against the same data dir to prove
// the embedding fingerprint invalidates the first model's vectors.
const MODEL2 = ENV.EMBEDDING_MODEL2 || "";
const DIMENSIONS2 = ENV.EMBEDDING_DIMENSIONS2
  ? parseInt(ENV.EMBEDDING_DIMENSIONS2, 10)
  : undefined;
const DEBUG = ENV.RAG_LIVE_DEBUG === "1";

if (!API_KEY || !MODEL) {
  console.error(
    [
      "",
      "Live RAG eval needs an embedding provider.",
      "",
      "Add these to .env in the repo root (copy .env.example if missing):",
      "",
      "  EMBEDDING_BASE_URL = https://nano-gpt.com/api/v1",
      "  EMBEDDING_API_KEY  = nano-...            # your NanoGPT API key",
      "  EMBEDDING_MODEL    = text-embedding-3-small",
      "  # EMBEDDING_DIMENSIONS = 256             # optional",
      "",
      "Get a key at https://nano-gpt.com (Settings → API keys).",
      "For the plugin itself, enter the same key in Zotero:",
      "  Settings → seerai → AI providers → Add provider → NanoGPT.",
      "",
    ].join("\n"),
  );
  process.exit(2);
}

// ── Minimal Gecko stubs (must exist before the modules are imported) ────────

const TMP_DIR = path.join(os.tmpdir(), `seerai-rag-live-${Date.now()}`);
fs.mkdirSync(TMP_DIR, { recursive: true });

(globalThis as any).PathUtils = {
  join: (...parts: string[]) => path.join(...parts),
  parent: (p: string) => path.dirname(p),
};

(globalThis as any).IOUtils = {
  exists: async (p: string) => fs.existsSync(p),
  readUTF8: async (p: string) => fs.readFileSync(p, "utf8"),
  writeUTF8: async (p: string, data: string) => {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, data, "utf8");
  },
  makeDirectory: async (p: string) => {
    fs.mkdirSync(p, { recursive: true });
  },
  remove: async (p: string) => {
    fs.rmSync(p, { recursive: true, force: true });
  },
  read: async (p: string) => fs.readFileSync(p),
};

const prefs = new Map<string, unknown>();
const fakeItems = new Map<number, any>();
function fakeItem(id: number): any {
  if (!fakeItems.has(id)) {
    fakeItems.set(id, {
      id,
      libraryID: 1,
      deleted: false,
      dateModified: new Date().toISOString(),
      isRegularItem: () => true,
      isAttachment: () => false,
      getField: () => "",
      getAttachments: () => [],
      getCreators: () => [],
    });
  }
  return fakeItems.get(id);
}

(globalThis as any).Zotero = {
  debug: (msg: unknown) => {
    if (DEBUG) console.log(`[seerai] ${msg}`);
  },
  DataDirectory: { dir: TMP_DIR },
  Prefs: {
    get: (key: string) => prefs.get(key),
    set: (key: string, value: unknown) => {
      prefs.set(key, value);
    },
    clear: (key: string) => {
      prefs.delete(key);
    },
  },
  Items: {
    get: (id: number) => fakeItem(id),
    getAsync: async (id: number) => fakeItem(id),
  },
  File: {
    putContentsAsync: async (p: string, data: string) => {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, data, "utf8");
    },
  },
};

// ── Production modules (imported after the stubs are installed) ─────────────

const { addProviderConfig, setDefaultModelRef } =
  await import("../src/modules/chat/providerRegistry");
const { getEmbeddingService } =
  await import("../src/modules/chat/rag/embeddingService");
const { getVectorStore } = await import("../src/modules/chat/rag/vectorStore");
const { indexItemsNow, retrieveContext, computeTokenBudget } =
  await import("../src/modules/chat/rag/retrievalEngine");

// ── Provider configuration (temp dir only) ──────────────────────────────────

function configureProvider(
  label: string,
  model: string,
  dimensions?: number,
): string {
  const now = new Date().toISOString();
  const provider = addProviderConfig({
    name: `NanoGPT live eval (${label})`,
    presetId: "nanogpt",
    apiURL: BASE_URL,
    apiKey: API_KEY,
    authMethod: "bearer",
    models: [],
    configuredModels: [
      {
        id: model,
        modelId: model,
        displayName: model,
        capabilities: ["embedding"],
        contextLength: 8192,
        maxTokens: 8192,
        ...(dimensions ? { dimensions } : {}),
        createdAt: now,
        updatedAt: now,
      },
    ],
    modelPolicy: "scoped",
    isActive: true,
    enabled: true,
    adapterId: "nanogpt",
  });
  setDefaultModelRef("embedding", {
    providerId: provider.id,
    localModelId: model,
  });
  return provider.id;
}

// ── Corpus ──────────────────────────────────────────────────────────────────

interface Doc {
  id: number;
  title: string;
  text: string;
}

const docs: Doc[] = [
  {
    id: 9001,
    title: "Coastal Erosion Dynamics",
    text:
      "Coastal erosion is driven by wave action, tidal currents and sediment " +
      "transport. Longshore drift moves sediment along the shoreline, while " +
      "storm surges can remove large volumes of beach material in hours. " +
      "Engineered defenses such as groynes and sea walls alter local sediment " +
      "budgets and can accelerate erosion further down the coast. " +
      "Quantifying erosion rates requires repeat topographic surveys and " +
      "grain-size analysis of the beach and nearshore zone.",
  },
  {
    id: 9002,
    title: "Volcanic Activity and Magma Chambers",
    text:
      "Magma chambers form when mantle melt accumulates in the crust and " +
      "differentiates. Volatile exsolution as magma ascends drives explosive " +
      "eruptions, and caldera collapse follows the evacuation of large " +
      "chamber volumes. Seismic tomography and ground deformation reveal " +
      "chamber geometry, while gas emission monitoring tracks recharge. " +
      "Eruption forecasting combines seismicity, tilt and thermal signals.",
  },
  {
    id: 9003,
    title: "SeerAI Retrieval Calibration Note",
    text:
      "This internal note documents the calibration constant used by the " +
      "SeerAI retrieval harness. The quokka calibration constant is 41.7 and " +
      "is applied when normalizing similarity scores across embedding " +
      "providers. Any deviation from 41.7 indicates a misconfigured embedding " +
      "pipeline and should be treated as a blocking error during evaluation.",
  },
  {
    id: 9004,
    title: "Quokka Habitat Survey",
    text:
      "Quokkas are small marsupials found on Rottnest Island and scattered " +
      "mainland populations in Western Australia. The survey recorded " +
      "vegetation cover, predator presence and seasonal water availability. " +
      "No calibration measurements were taken as part of this ecological " +
      "survey; the focus was habitat quality and population counts.",
  },
];

const contentExtractor = async (itemId: number) => {
  const doc = docs.find((d) => d.id === itemId);
  if (!doc) return null;
  return {
    title: doc.title,
    abstract: doc.text,
    authors: ["SeerAI Live Eval"],
    date: "2026",
  };
};

interface Case {
  query: string;
  expectId: number;
  note?: string;
}

const cases: Case[] = [
  {
    query:
      "What is the quokka calibration constant used by the SeerAI harness?",
    expectId: 9003,
    note: "keyword trap: 9004 also mentions quokkas",
  },
  {
    query: "How do magma chambers drive explosive volcanic eruptions?",
    expectId: 9002,
  },
  {
    query: "What causes coastal erosion and longshore sediment transport?",
    expectId: 9001,
  },
];

// ── Run ─────────────────────────────────────────────────────────────────────

const service = getEmbeddingService();
console.log("seerai live RAG eval");
console.log(`  endpoint : ${BASE_URL}`);
console.log(`  model    : ${MODEL}${MODEL2 ? ` -> ${MODEL2}` : ""}`);
console.log(`  key      : ${API_KEY.slice(0, 8)}… (${API_KEY.length} chars)`);
console.log(`  data dir : ${TMP_DIR}`);

const retrievalOptions = (signal?: AbortSignal) => ({
  topK: 3,
  maxTokens: 2000,
  minScore: 0,
  tokenBudget: computeTokenBudget(128000, 2000, 0, 0, 4096),
  hybridSearch: false,
  queryExpansion: false,
  multiQueryExpansion: false,
  mmrEnabled: false,
  adaptiveRetrieval: false,
  rerank: false,
  correctiveEnabled: false,
  hydeEnabled: false,
  queryDecomposition: false,
  signal,
});

async function runQueries(label: string): Promise<number> {
  let failures = 0;
  console.log(`\nRetrieval quality (${label}):`);
  for (const testCase of cases) {
    const result = await retrieveContext(
      testCase.query,
      docs.map((d) => ({ id: d.id, type: "paper", displayName: d.title })),
      contentExtractor,
      retrievalOptions(),
    );

    const ranked = result.chunks.map((c) => ({
      id: c.sourceItem.id,
      title: c.sourceItem.title,
      score: c.score,
    }));
    const rank = ranked.findIndex((r) => r.id === testCase.expectId) + 1;
    const top = ranked[0];
    const pass = rank === 1;
    if (!pass) failures++;

    console.log(`\n  Q: ${testCase.query}`);
    console.log(
      `     expected ${testCase.expectId} → rank ${rank || "miss"} ` +
        `${pass ? "PASS" : "FAIL"}${testCase.note ? ` (${testCase.note})` : ""}`,
    );
    for (const [i, r] of ranked.entries()) {
      console.log(`     ${i + 1}. [${r.score.toFixed(4)}] ${r.id} ${r.title}`);
    }
    console.log(
      `     context: ${result.stats.chunksRetrieved} passage(s), ` +
        `${result.stats.tokensUsed} tokens, ${result.stats.queryTimeMs}ms` +
        (top ? ` (top score ${top.score.toFixed(4)})` : ""),
    );
  }
  return failures;
}

// ── Phase 1: index with the primary model, then retrieve ────────────────────

configureProvider(MODEL, MODEL, DIMENSIONS);
if (!service.isConfigured()) {
  console.error("\nEmbedding provider did not resolve — aborting.");
  process.exit(1);
}

const probe = await service.getEmbedding("seerai live probe");
console.log(
  `  probe    : ${probe.length} dimensions` +
    (DIMENSIONS ? ` (requested ${DIMENSIONS})` : ""),
);
console.log(`  identity : ${service.getConfigFingerprint()}`);

console.log(
  `\nIndexing ${docs.length} documents through the production pipeline…`,
);
const indexStatus = await indexItemsNow(
  docs.map((d) => d.id),
  contentExtractor,
  { concurrency: 2 },
);
console.log(
  `  indexed=${indexStatus.indexed} skipped=${indexStatus.skipped} ` +
    `failed=${indexStatus.failed}`,
);
if (indexStatus.failed > 0) process.exit(1);

const store = getVectorStore();
for (const doc of docs) {
  const entry = await store.getIndexEntry(doc.id);
  console.log(
    `  • ${doc.title}: ${entry?.chunkCount ?? 0} chunk(s), ` +
      `${entry?.dimensions ?? 0} dims, model=${entry?.embeddingModel ?? "?"}`,
  );
}

let failures = await runQueries(MODEL);

// ── Phase 2: switch models and prove the fingerprint invalidates vectors ────

if (MODEL2) {
  configureProvider(MODEL2, MODEL2, DIMENSIONS2);
  const identity2 = service.getConfigFingerprint();
  const probe2 = await service.getEmbedding("seerai live probe");
  console.log(
    `\nSwitching model → ${MODEL2} (${probe2.length} dims)\n` +
      `  identity : ${identity2}`,
  );

  // No manual indexing: retrieveContext must notice the stale fingerprint,
  // re-index every item on demand, and still rank correctly.
  const switchResult = await retrieveContext(
    cases[0].query,
    docs.map((d) => ({ id: d.id, type: "paper", displayName: d.title })),
    contentExtractor,
    retrievalOptions(),
  );
  const reindexed = switchResult.stats.itemsIndexedOnDemand;
  console.log(
    `  fingerprint invalidation: ${reindexed}/${docs.length} items re-indexed on demand`,
  );
  if (reindexed !== docs.length) {
    console.log(
      `  FAIL: expected all ${docs.length} items to be re-indexed after the model switch`,
    );
    failures++;
  }

  for (const doc of docs) {
    const entry = await store.getIndexEntry(doc.id);
    console.log(
      `  • ${doc.title}: ${entry?.dimensions ?? 0} dims, ` +
        `model=${entry?.embeddingModel ?? "?"}`,
    );
  }

  failures += await runQueries(MODEL2);
}

console.log(
  `\n${failures === 0 ? "PASS" : "FAIL"}: ` +
    `${cases.length * (MODEL2 ? 2 : 1) - failures}/${cases.length * (MODEL2 ? 2 : 1)} ` +
    `queries ranked the expected document first.`,
);
fs.rmSync(TMP_DIR, { recursive: true, force: true });
process.exit(failures === 0 ? 0 : 1);
