import { assert } from "chai";
import { getEmbeddingService } from "../src/modules/chat/rag/embeddingService";
import { getVectorStore } from "../src/modules/chat/rag/vectorStore";
import {
  computeTokenBudget,
  retrieveContext,
} from "../src/modules/chat/rag/retrievalEngine";
import { indexItemsForRAG } from "../src/modules/chat/rag/bulkIndexer";
import {
  addProviderConfig,
  getProviderRegistryState,
  replaceProviderRegistryState,
  setDefaultModelRef,
} from "../src/modules/chat/providerRegistry";
import { Assistant } from "../src/modules/assistant";

const EMBED_DIM = 32;
const ENDPOINT_PATH = "/test/seerai-local-embed/embeddings";

/**
 * Deterministic bag-of-words embedding so passages and queries that share
 * terms are genuinely similar (L2-normalized, like real providers).
 */
function embedText(text: string): number[] {
  const vector = new Array<number>(EMBED_DIM).fill(0);
  const tokens = String(text || "")
    .toLowerCase()
    .match(/[a-z0-9]+/g);
  for (const token of tokens || []) {
    let hash = 2166136261;
    for (let i = 0; i < token.length; i++) {
      hash ^= token.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    vector[Math.abs(hash) % EMBED_DIM] += 1;
  }
  const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0)) || 1;
  return vector.map((v) => v / norm);
}

/**
 * Runs inside Zotero (via `zotero-plugin test`): registers an in-process,
 * OpenAI-compatible embedding endpoint on Zotero's own HTTP server and drives
 * the real embedding client → vector store → retrieval pipeline against it.
 */
describe("Local embedding server end-to-end (Zotero integration)", function () {
  this.timeout(60000);

  let book: Zotero.Item;
  let registrySnapshot: any;
  let baseURL = "";

  before(async function () {
    try {
      Zotero.Server.Endpoints[ENDPOINT_PATH] = function () {
        return {
          supportedMethods: ["POST"],
          supportedDataTypes: ["application/json"],
          init: async (request: any) => {
            const raw = request?.data;
            const body = typeof raw === "string" ? JSON.parse(raw) : raw || {};
            const inputs: string[] = Array.isArray(body.input)
              ? body.input
              : [body.input ?? ""];
            return [
              200,
              "application/json",
              JSON.stringify({
                object: "list",
                model: body.model || "local-test-embed",
                data: inputs.map((text, index) => ({
                  object: "embedding",
                  index,
                  embedding: embedText(text),
                })),
                usage: { prompt_tokens: 0, total_tokens: 0 },
              }),
            ];
          },
        };
      };

      // The HTTP server may not be running (e.g. another Zotero instance
      // already holds the default port), so start it on an ephemeral port.
      const server = Zotero.Server as any;
      let port: number;
      try {
        port = server.port;
      } catch {
        await server.init(0);
        port = server.port;
      }
      baseURL = `http://127.0.0.1:${port}/test/seerai-local-embed`;

      registrySnapshot = JSON.parse(JSON.stringify(getProviderRegistryState()));
      const now = new Date().toISOString();
      const provider = addProviderConfig({
        name: "SeerAI Local Embedding Test",
        apiURL: baseURL,
        apiKey: "",
        authMethod: "none",
        models: [],
        configuredModels: [
          {
            id: "local-test-embed",
            modelId: "local-test-embed",
            displayName: "Local Test Embed",
            capabilities: ["embedding"],
            createdAt: now,
            updatedAt: now,
          },
        ],
        modelPolicy: "scoped",
        isActive: true,
        enabled: true,
        adapterId: "openai-compatible",
      });
      setDefaultModelRef("embedding", {
        providerId: provider.id,
        localModelId: "local-test-embed",
      });

      book = new Zotero.Item("book");
      book.libraryID = Zotero.Libraries.userLibraryID;
      book.setField("title", "SeerAI Local Embedding Book");
      book.setField(
        "abstractNote",
        "Retrieval augmented generation combines dense vector search with " +
          "large language models. The local embedding server turns each " +
          "passage into a vector so the retriever can rank relevant chunks.",
      );
      await book.saveTx();
    } catch (e: any) {
      throw new Error(
        `local embedding test setup failed: ${e?.message || String(e)}`,
      );
    }
  });

  after(function () {
    try {
      if (registrySnapshot) {
        replaceProviderRegistryState(registrySnapshot);
      }
    } catch (e) {
      Zotero.debug(`[seerai] local embedding test restore failed: ${e}`);
    }
    try {
      delete Zotero.Server.Endpoints[ENDPOINT_PATH];
    } catch (e) {
      Zotero.debug(`[seerai] local embedding endpoint cleanup failed: ${e}`);
    }
  });

  it("serves embeddings over local HTTP and the plugin consumes them", async function () {
    const service = getEmbeddingService();
    assert.isTrue(service.isConfigured(), "embedding provider should resolve");
    assert.equal(service.getConfiguredModel(), "local-test-embed");

    let vector: number[];
    try {
      vector = await service.getEmbedding("retrieval augmented generation");
    } catch (e: any) {
      throw new Error(
        `embedding request failed (baseURL=${baseURL}): ${e?.message || String(e)}`,
      );
    }
    assert.lengthOf(vector, EMBED_DIM);
    const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
    assert.isAbove(norm, 0.99, "embedding should be L2-normalized");
  });

  it("bulk-indexes an item through the local embedding server", async function () {
    const status = await indexItemsForRAG([book.id]);
    assert.equal(status.indexed, 1, "the book should be indexed");
    assert.equal(status.failed, 0);
    assert.isTrue(await getVectorStore().isIndexed(book.id));
  });

  it("retrieves the indexed passage through the full pipeline", async function () {
    const result = await retrieveContext(
      "dense vector search with local embeddings",
      [
        {
          id: book.id,
          type: "paper",
          displayName: "SeerAI Local Embedding Book",
        },
      ],
      Assistant.extractContentForRAG,
      {
        topK: 3,
        maxTokens: 4000,
        minScore: 0.05,
        tokenBudget: computeTokenBudget(128000, 2000, 0, 0, 4096),
        hybridSearch: false,
        queryExpansion: false,
        multiQueryExpansion: false,
        mmrEnabled: false,
        adaptiveRetrieval: false,
        rerank: false,
        correctiveEnabled: false,
      },
    );

    assert.isAbove(result.chunks.length, 0);
    assert.include(result.context, "local embedding server");
    assert.isAbove(result.stats.chunksRetrieved, 0);
  });
});
