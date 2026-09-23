import { assert } from "chai";
import {
  computeTokenBudget,
  retrieveContext,
} from "../src/modules/chat/rag/retrievalEngine";
import { getEmbeddingService } from "../src/modules/chat/rag/embeddingService";
import { getVectorStore } from "../src/modules/chat/rag/vectorStore";
import { Assistant } from "../src/modules/assistant";

/**
 * Runs inside Zotero (via `zotero-plugin test`): drives the real retrieval
 * pipeline (extraction → chunking → vector store → search → assembly) with a
 * stubbed embedding provider.
 */
describe("RAG retrieval pipeline (Zotero integration)", function () {
  this.timeout(30000);

  let book: Zotero.Item;
  let embeddingService: any;
  let originalMethods: Record<string, any> = {};

  before(async function () {
    try {
      embeddingService = getEmbeddingService() as any;
      book = new Zotero.Item("book");
      book.libraryID = Zotero.Libraries.userLibraryID;
      book.setField("title", "SeerAI Pipeline Test Book");
      book.setField(
        "abstractNote",
        "Retrieval augmented generation combines dense vector search with " +
          "large language models. This paragraph exists so the chunker has " +
          "real text to embed and the pipeline can return a passage.",
      );
      await book.saveTx();
    } catch (e: any) {
      throw new Error(
        `RAG pipeline test setup failed: ${e?.message || String(e)}`,
      );
    }

    originalMethods = {
      isConfigured: embeddingService.isConfigured,
      getEmbeddings: embeddingService.getEmbeddings,
      getQueryEmbedding: embeddingService.getQueryEmbedding,
      getConfiguredModel: embeddingService.getConfiguredModel,
    };

    embeddingService.isConfigured = () => true;
    embeddingService.getConfiguredModel = () => "test-pipeline-embed";
    // Deliberately opposite direction to the query: cosine = -1.
    embeddingService.getEmbeddings = async (texts: string[]) =>
      texts.map(() => [-1, 0, 0]);
    embeddingService.getQueryEmbedding = async () => [1, 0, 0];
  });

  after(function () {
    if (!embeddingService) return;
    for (const [key, value] of Object.entries(originalMethods)) {
      embeddingService[key] = value;
    }
  });

  const runRetrieval = (minScore: number) =>
    retrieveContext(
      "what does the book say about retrieval?",
      [
        {
          id: book.id,
          type: "paper",
          displayName: "SeerAI Pipeline Test Book",
        },
      ],
      Assistant.extractContentForRAG,
      {
        topK: 3,
        maxTokens: 4000,
        minScore,
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

  it("indexes an item and returns passages with negative cosine scores when minScore is 0", async function () {
    const result = await runRetrieval(0);

    assert.isAbove(
      result.chunks.length,
      0,
      "negative-score passages must not be filtered out when minScore = 0",
    );
    assert.include(result.context, "Retrieval augmented generation");
    assert.isAbove(result.stats.chunksRetrieved, 0);
    assert.isTrue(await getVectorStore().isIndexed(book.id));
  });

  it("still applies a positive minScore threshold", async function () {
    const result = await runRetrieval(0.5);
    assert.equal(
      result.chunks.length,
      0,
      "a -1 cosine passage must not pass a 0.5 threshold",
    );
  });
});
