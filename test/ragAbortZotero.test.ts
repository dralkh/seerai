import { assert } from "chai";
import { getEmbeddingService } from "../src/modules/chat/rag/embeddingService";
import {
  computeTokenBudget,
  retrieveContext,
} from "../src/modules/chat/rag/retrievalEngine";
import {
  cancelBulkIndex,
  indexItemsForRAG,
} from "../src/modules/chat/rag/bulkIndexer";
import {
  addProviderConfig,
  getProviderRegistryState,
  replaceProviderRegistryState,
  setDefaultModelRef,
} from "../src/modules/chat/providerRegistry";
import { isAbortError, createAbortController } from "../src/modules/search/env";
import { Assistant } from "../src/modules/assistant";

const ENDPOINT_PATH = "/test/seerai-abort-embed/embeddings";
const EMBED_DIM = 8;

/**
 * Runs inside Zotero: an embedding endpoint that responds slowly so the client
 * has time to abort mid-request. Verifies cancellation semantics end-to-end:
 * in-flight embedding requests, chat retrieval, and bulk indexing.
 */
describe("RAG abort/cancellation (Zotero integration)", function () {
  this.timeout(60000);

  let book: Zotero.Item;
  let registrySnapshot: any;

  before(async function () {
    Zotero.Server.Endpoints[ENDPOINT_PATH] = function () {
      return {
        supportedMethods: ["POST"],
        supportedDataTypes: ["application/json"],
        init: async (request: any) => {
          // Deliberately slow: the client aborts before this resolves.
          await new Promise((resolve) => setTimeout(resolve, 4000));
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
              model: body.model || "slow-test-embed",
              data: inputs.map((_text, index) => ({
                object: "embedding",
                index,
                embedding: new Array(EMBED_DIM).fill(1 / Math.sqrt(EMBED_DIM)),
              })),
              usage: { prompt_tokens: 0, total_tokens: 0 },
            }),
          ];
        },
      };
    };

    const server = Zotero.Server as any;
    let port: number;
    try {
      port = server.port;
    } catch {
      await server.init(0);
      port = server.port;
    }
    const baseURL = `http://127.0.0.1:${port}/test/seerai-abort-embed`;

    registrySnapshot = JSON.parse(JSON.stringify(getProviderRegistryState()));
    const now = new Date().toISOString();
    const provider = addProviderConfig({
      name: "SeerAI Abort Test Embedding",
      apiURL: baseURL,
      apiKey: "",
      authMethod: "none",
      models: [],
      configuredModels: [
        {
          id: "slow-test-embed",
          modelId: "slow-test-embed",
          displayName: "Slow Test Embed",
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
      localModelId: "slow-test-embed",
    });

    book = new Zotero.Item("book");
    book.libraryID = Zotero.Libraries.userLibraryID;
    book.setField("title", "SeerAI Abort Test Book");
    book.setField(
      "abstractNote",
      "Cancellation semantics for embedding requests: an aborted turn must " +
        "stop in-flight work without counting it as a failure.",
    );
    await book.saveTx();
  });

  after(function () {
    try {
      if (registrySnapshot) {
        replaceProviderRegistryState(registrySnapshot);
      }
    } catch (e) {
      Zotero.debug(`[seerai] abort test restore failed: ${e}`);
    }
    try {
      delete Zotero.Server.Endpoints[ENDPOINT_PATH];
    } catch (e) {
      Zotero.debug(`[seerai] abort endpoint cleanup failed: ${e}`);
    }
  });

  it("rejects immediately when the signal is already aborted", async function () {
    const service = getEmbeddingService();
    const controller = createAbortController();
    controller.abort();

    const started = Date.now();
    let error: any = null;
    try {
      await service.getEmbedding("pre-aborted", {
        signal: controller.signal,
      });
    } catch (e) {
      error = e;
    }
    assert.isNotNull(error, "expected the pre-aborted request to reject");
    assert.isTrue(isAbortError(error), `expected AbortError, got ${error}`);
    assert.isBelow(
      Date.now() - started,
      2000,
      "pre-aborted requests must not wait for the network",
    );
  });

  it("aborts an in-flight embedding batch with an AbortError", async function () {
    const service = getEmbeddingService();
    const controller = createAbortController();
    const promise = service.getEmbeddings(["alpha", "beta", "gamma"], {
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 150);

    let error: any = null;
    try {
      await promise;
    } catch (e) {
      error = e;
    }
    assert.isNotNull(error, "expected the aborted batch to reject");
    assert.isTrue(
      isAbortError(error),
      `expected AbortError, got ${error?.name || error}`,
    );
  });

  it("retrieveContext returns an empty result for an aborted turn", async function () {
    const controller = createAbortController();
    controller.abort();

    const result = await retrieveContext(
      "cancellation semantics",
      [
        {
          id: book.id,
          type: "paper",
          displayName: "SeerAI Abort Test Book",
        },
      ],
      Assistant.extractContentForRAG,
      {
        topK: 3,
        maxTokens: 4000,
        minScore: 0,
        tokenBudget: computeTokenBudget(128000, 2000, 0, 0, 4096),
        hybridSearch: false,
        queryExpansion: false,
        multiQueryExpansion: false,
        mmrEnabled: false,
        adaptiveRetrieval: false,
        rerank: false,
        correctiveEnabled: false,
        signal: controller.signal,
      },
    );

    assert.equal(result.context, "");
    assert.lengthOf(result.chunks, 0);
  });

  it("cancelBulkIndex aborts in-flight indexing without counting failures", async function () {
    const promise = indexItemsForRAG([book.id]);
    setTimeout(() => cancelBulkIndex(), 250);

    const status = await promise;
    assert.equal(
      status.phase,
      "cancelled",
      `expected a cancelled job, got ${status.phase}`,
    );
    assert.equal(status.failed, 0, "aborts must not be counted as failures");
    assert.equal(status.indexed, 0, "nothing should be indexed after abort");
  });
});
