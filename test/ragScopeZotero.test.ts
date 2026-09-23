import { assert } from "chai";
import {
  countScopeItems,
  enumerateScopeItems,
  indexItemsForRAG,
} from "../src/modules/chat/rag/bulkIndexer";
import {
  computeTokenBudget,
  retrieveContext,
} from "../src/modules/chat/rag/retrievalEngine";
import { getEmbeddingService } from "../src/modules/chat/rag/embeddingService";
import { getVectorStore } from "../src/modules/chat/rag/vectorStore";
import { Assistant } from "../src/modules/assistant";

const EMBED_DIM = 32;

/** Deterministic bag-of-words embedding (L2-normalized), like a real provider. */
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
 * Runs inside Zotero (via `zotero-plugin test`): verifies that the RAG scope
 * universe is consistent — subcollections, every PDF/text attachment of a
 * multi-attachment item, and standalone attachments — and that retrieval can
 * reach the *second* attachment's content (not just the first PDF).
 */
describe("RAG scope coverage (Zotero integration)", function () {
  this.timeout(60000);

  let libraryID: number;
  let rootCollection: Zotero.Collection;
  let childCollection: Zotero.Collection;
  let book: Zotero.Item;
  let bookAttA: Zotero.Item;
  let bookAttB: Zotero.Item;
  let standalone: Zotero.Item;

  let embeddingService: any;
  let originalMethods: Record<string, any> = {};

  const writeTextFile = async (name: string, text: string): Promise<string> => {
    const path = PathUtils.join(Zotero.DataDirectory.dir, name);
    await IOUtils.writeUTF8(path, text);
    return path;
  };

  before(async function () {
    libraryID = Zotero.Libraries.userLibraryID;
    const stamp = Date.now();

    rootCollection = new Zotero.Collection({
      name: `seerai-scope-root-${stamp}`,
      libraryID,
    });
    await rootCollection.saveTx();

    childCollection = new Zotero.Collection({
      name: `seerai-scope-child-${stamp}`,
      libraryID,
      parentID: rootCollection.id,
    });
    // skipNotifier: the test environment can hang in Zotero's collection
    // notifier dispatch (reproducible with plain Zotero collection saves and
    // no plugin code involved). The DB relationship is all this test needs.
    await childCollection.saveTx({ skipNotifier: true });

    book = new Zotero.Item("book");
    book.libraryID = libraryID;
    book.setField("title", "SeerAI Scope Book");
    book.setField(
      "abstractNote",
      "Parent metadata abstract for the scope coverage test.",
    );
    await book.saveTx();

    bookAttA = await Zotero.Attachments.importFromFile({
      file: await writeTextFile(
        `seerai-scope-a-${stamp}.txt`,
        "ALPHA-ONLY passage about coastal erosion and sediment transport.",
      ),
      parentItemID: book.id,
      contentType: "text/plain",
      charset: "utf-8",
    });
    bookAttB = await Zotero.Attachments.importFromFile({
      file: await writeTextFile(
        `seerai-scope-b-${stamp}.txt`,
        "BETA-ONLY passage about volcanic activity and magma chambers.",
      ),
      parentItemID: book.id,
      contentType: "text/plain",
      charset: "utf-8",
    });
    standalone = await Zotero.Attachments.importFromFile({
      file: await writeTextFile(
        `seerai-scope-c-${stamp}.txt`,
        "STANDALONE passage about migratory bird navigation.",
      ),
      contentType: "text/plain",
      charset: "utf-8",
    });

    // The book lives in the child collection; the standalone attachment is a
    // direct member of the root collection.
    await Zotero.DB.executeTransaction(async () => {
      await rootCollection.addItems([standalone.id]);
      await childCollection.addItems([book.id]);
    });

    // Stub the embedding pipeline so indexing/retrieval can run without a
    // configured provider (same approach as ragPipelineZotero.test.ts).
    embeddingService = getEmbeddingService() as any;
    originalMethods = {
      isConfigured: embeddingService.isConfigured,
      getEmbeddings: embeddingService.getEmbeddings,
      getQueryEmbedding: embeddingService.getQueryEmbedding,
      getConfiguredModel: embeddingService.getConfiguredModel,
      getConfigFingerprint: embeddingService.getConfigFingerprint,
    };
    embeddingService.isConfigured = () => true;
    embeddingService.getConfiguredModel = () => "scope-test-embed";
    embeddingService.getConfigFingerprint = () => "scope-test-fingerprint";
    embeddingService.getEmbeddings = async (texts: string[]) =>
      texts.map((text) => embedText(text));
    embeddingService.getQueryEmbedding = async (query: string) =>
      embedText(query);
  });

  after(function () {
    if (!embeddingService) return;
    for (const [key, value] of Object.entries(originalMethods)) {
      embeddingService[key] = value;
    }
  });

  // No cleanup hook: `zotero-plugin test` empties the tester data directory
  // before each run (see bulkIndexerZotero.test.ts).

  it("enumerates subcollection items and every attachment", async function () {
    const ids = await enumerateScopeItems({
      kind: "collection",
      id: rootCollection.id,
      label: "root",
    });
    assert.includeMembers(ids, [
      book.id,
      bookAttA.id,
      bookAttB.id,
      standalone.id,
    ]);
  });

  it("counts exactly what it enumerates", async function () {
    const ids = await enumerateScopeItems({
      kind: "collection",
      id: rootCollection.id,
      label: "root",
    });
    const count = await countScopeItems({
      kind: "collection",
      id: rootCollection.id,
      label: "root",
    });
    assert.equal(count, ids.length);
  });

  it("includes standalone attachments in library scope", async function () {
    const ids = await enumerateScopeItems({
      kind: "library",
      id: libraryID,
      label: "library",
    });
    assert.includeMembers(ids, [
      book.id,
      bookAttA.id,
      bookAttB.id,
      standalone.id,
    ]);
  });

  it("expands a selected parent book into its attachments", async function () {
    const { expandedItems } = await Assistant.expandContextItemsForRAG([
      { id: book.id, type: "paper", displayName: "SeerAI Scope Book" },
    ]);
    const ids = expandedItems.map((item) => item.id);
    assert.includeMembers(ids, [book.id, bookAttA.id, bookAttB.id]);
  });

  it("indexes every attachment of a multi-attachment book", async function () {
    const status = await indexItemsForRAG([book.id]);
    assert.equal(status.failed, 0, "no indexing failures");
    assert.isAtLeast(status.indexed, 3, "parent + both attachments");
    const store = getVectorStore();
    assert.isTrue(await store.isIndexed(book.id));
    assert.isTrue(await store.isIndexed(bookAttA.id));
    assert.isTrue(await store.isIndexed(bookAttB.id));
  });

  it("retrieves the second attachment's content through the pipeline", async function () {
    const { expandedItems } = await Assistant.expandContextItemsForRAG([
      { id: book.id, type: "paper", displayName: "SeerAI Scope Book" },
    ]);
    const result = await retrieveContext(
      "volcanic activity and magma",
      expandedItems,
      Assistant.extractContentForRAG,
      {
        topK: 5,
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
      },
    );
    assert.isAbove(result.chunks.length, 0);
    assert.include(
      result.context,
      "BETA-ONLY",
      "the second attachment must be searchable, not just the first PDF",
    );
  });

  it("skips unchanged content on a re-run (content hash check)", async function () {
    const store = getVectorStore();
    // Simulate a metadata-only edit: dateModified changed but text identical.
    const entry = await store.getIndexEntry(bookAttA.id);
    assert.isNotNull(entry);
    entry!.lastModified = "1970-01-01 00:00:00";
    await store.saveIndex();

    const status = await indexItemsForRAG([book.id]);
    assert.equal(
      status.indexed,
      0,
      "unchanged text must not be re-embedded after a metadata-only change",
    );
    assert.isAtLeast(status.skipped, 1);
  });

  it("rejects a second concurrent bulk run", async function () {
    const first = indexItemsForRAG([book.id], () => {});
    let secondError: Error | null = null;
    try {
      await indexItemsForRAG([standalone.id]);
    } catch (e: any) {
      secondError = e as Error;
    }
    assert.match(secondError?.message || "", /already running/);
    await first;
  });
});
