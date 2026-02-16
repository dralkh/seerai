import {
  queryCollections,
  queryPapers,
  queryAuthors,
  queryTags,
  queryYears,
} from "../src/modules/chat/placeholders.ts";

(async () => {
  try {
    console.log("=== Testing Search Scope Fixes ===");

    // Mock Zotero.Libraries.getAll if strictly needed, but let's assume environment has it or at least User Lib.
    // We really want to check if the functions execute and return results.

    console.log("\n1. Testing queryCollections (Recursive + All Libs)...");
    const cols = await queryCollections("");
    console.log(`Collections found: ${cols.length}`);
    if (cols.length > 0)
      console.log("Sample Collection:", JSON.stringify(cols[0].title));

    console.log("\n2. Testing queryPapers (All Libs)...");
    const papers = await queryPapers("", 5);
    console.log(`Papers found: ${papers.length}`);
    if (papers.length > 0)
      console.log("Sample Paper:", JSON.stringify(papers[0].title));

    console.log("\n3. Testing queryAuthors (All Libs)...");
    const authors = await queryAuthors("", 5);
    console.log(`Authors found: ${authors.length}`);
    if (authors.length > 0)
      console.log("Sample Author:", JSON.stringify(authors[0].title));

    console.log("\n4. Testing queryTags (All Libs)...");
    const tags = await queryTags("", 5);
    console.log(`Tags found: ${tags.length}`);
    if (tags.length > 0)
      console.log("Sample Tag:", JSON.stringify(tags[0].title));

    console.log("\n5. Testing queryYears (All Libs)...");
    const years = await queryYears("", 5);
    console.log(`Years found: ${years.length}`);
    if (years.length > 0)
      console.log("Sample Year:", JSON.stringify(years[0].title));
  } catch (e) {
    console.error("Error running verification:", e);
  }
})();
