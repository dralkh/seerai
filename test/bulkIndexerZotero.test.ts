import { assert } from "chai";
import {
  countLibraryRegularItems,
  enumerateScopeItems,
  filterItemsNeedingIndex,
} from "../src/modules/chat/rag/bulkIndexer";
import {
  getVectorStore,
  VectorStore,
} from "../src/modules/chat/rag/vectorStore";

/**
 * Runs inside Zotero (via `zotero-plugin test`): exercises the real Zotero
 * item/collection APIs used by bulk pre-indexing.
 */
describe("Bulk RAG indexing (Zotero integration)", function () {
  this.timeout(30000);

  let libraryID: number;
  let collection: Zotero.Collection;
  let bookA: Zotero.Item;
  let bookB: Zotero.Item;
  let note: Zotero.Item;

  before(async function () {
    try {
      libraryID = Zotero.Libraries.userLibraryID;

      collection = new Zotero.Collection({
        name: `seerai-bulk-test-${Date.now()}`,
        libraryID,
      });
      await collection.saveTx();

      bookA = new Zotero.Item("book");
      bookA.libraryID = libraryID;
      bookA.setField("title", "SeerAI Bulk Test Book A");
      await bookA.saveTx();

      bookB = new Zotero.Item("book");
      bookB.libraryID = libraryID;
      bookB.setField("title", "SeerAI Bulk Test Book B");
      await bookB.saveTx();

      note = new Zotero.Item("note");
      note.libraryID = libraryID;
      note.setNote("SeerAI bulk test note");
      await note.saveTx();

      // Collection membership writes require a transaction.
      await Zotero.DB.executeTransaction(async () => {
        await collection.addItems([bookA.id, bookB.id, note.id]);
      });
    } catch (e: any) {
      throw new Error(
        `bulkIndexer test setup failed: ${e?.message || String(e)}\n${e?.stack || ""}`,
      );
    }
  });

  // No cleanup hook: `zotero-plugin test` empties the tester data directory
  // before each run, and erasing items here races Zotero's delete notifiers.

  it("enumerates only regular items in a collection", async function () {
    const ids = await enumerateScopeItems({
      kind: "collection",
      id: collection.id,
      label: "test collection",
    });
    assert.includeMembers(ids, [bookA.id, bookB.id]);
    assert.notInclude(ids, note.id);
  });

  it("enumerates only regular items in a library", async function () {
    const ids = await enumerateScopeItems({
      kind: "library",
      id: libraryID,
      label: "test library",
    });
    assert.includeMembers(ids, [bookA.id, bookB.id]);
    assert.notInclude(ids, note.id);
  });

  it("counts library regular items consistently with enumeration", async function () {
    const count = await countLibraryRegularItems(libraryID);
    const ids = await enumerateScopeItems({
      kind: "library",
      id: libraryID,
      label: "test library",
    });
    assert.equal(count, ids.length);
    assert.isAtLeast(count, 2);
  });

  it("treats unindexed items as needing indexing", async function () {
    const pending = await filterItemsNeedingIndex([bookA.id], "test-embed");
    assert.deepEqual(pending, [bookA.id]);
  });

  it("skips fresh vectors and re-queues on embedding-model change", async function () {
    const store = getVectorStore();
    await store.indexItem(
      bookA.id,
      [
        {
          id: `${bookA.id}_abstract_0`,
          itemId: bookA.id,
          text: "Bulk test abstract",
          source: "abstract",
          chunkIndex: 0,
          metadata: {
            title: "SeerAI Bulk Test Book A",
            startOffset: 0,
            endOffset: 18,
          },
        },
      ],
      [[0.1, 0.2, 0.3]],
      "test-embed",
      VectorStore.contentHash("Bulk test abstract"),
      undefined,
      undefined,
      "SeerAI Bulk Test Book A",
      "A",
    );

    assert.deepEqual(
      await filterItemsNeedingIndex([bookA.id], "test-embed"),
      [],
      "fresh vector with the same embedding model should be skipped",
    );
    assert.deepEqual(
      await filterItemsNeedingIndex([bookA.id], "other-embed"),
      [bookA.id],
      "switching embedding models should re-queue the item",
    );
  });
});
