const { queryCollections } = require("../src/modules/chat/placeholders");

(async () => {
  try {
    console.log("Testing queryCollections with empty query...");
    const results = await queryCollections("");
    console.log(`Results found: ${results.length}`);
    if (results.length > 0) {
      console.log("First result:", JSON.stringify(results[0], null, 2));
    } else {
      console.log("No collections returned.");
      // Debug Zotero.Collections.getByLibrary directly
      const libID = Zotero.Libraries.userLibraryID;
      console.log(`User Library ID: ${libID}`);
      const cols = Zotero.Collections.getByLibrary(libID);
      console.log(`Direct getByLibrary returned type: ${typeof cols}`);
      if (Array.isArray(cols)) {
        console.log(`Array length: ${cols.length}`);
      } else {
        console.log(`Value: ${cols}`);
      }
    }

    console.log("\nTesting queryCollections with 'test' query...");
    const searchResults = await queryCollections("test");
    console.log(`Search Results: ${searchResults.length}`);
  } catch (e) {
    console.error("Error running reproduction:", e);
  }
})();
