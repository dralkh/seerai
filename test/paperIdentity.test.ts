import { assert } from "chai";
import {
  defaultAgentConfig,
  TOOL_NAMES,
} from "../src/modules/chat/tools/toolTypes";
import { safeValidateToolArgs } from "../src/modules/chat/tools/schemas";
import {
  identifierKeyString,
  keysFromExtra,
  keysForScholarlyPaper,
  normalizeArxivForIdentity,
  normalizeDoiForIdentity,
  parsePaperIdentifier,
} from "../src/modules/chat/tools/paperIdentity";
import { TOOL_DEFINITIONS } from "../mcp-server/src/tools";

describe("paper identity tools", function () {
  it("normalizes DOI and arXiv identifiers", function () {
    assert.equal(
      normalizeDoiForIdentity("https://doi.org/10.1101/2024.01.02.123456."),
      "10.1101/2024.01.02.123456",
    );
    assert.equal(
      normalizeArxivForIdentity("https://arxiv.org/pdf/2412.08905v1.pdf"),
      "2412.08905v1",
    );
  });

  it("parses provider-prefixed and bare arXiv identifiers", function () {
    const prefixed = parsePaperIdentifier("arxiv:2412.08905v1");
    assert.equal(prefixed.provider, "arxiv");
    assert.include(prefixed.keys.map(identifierKeyString), "arxiv:2412.08905");

    const bare = parsePaperIdentifier("2412.08905");
    assert.equal(bare.provider, "arxiv");
  });

  it("extracts identifiers from Zotero Extra text", function () {
    const keys = keysFromExtra(
      "PMID: 123456\nPMCID: PMC987654\narXiv: 2412.08905v1\nZenodo: 42",
    ).map(identifierKeyString);
    assert.includeMembers(keys, [
      "pmid:123456",
      "pmcid:PMC987654",
      "arxiv:2412.08905",
      "zenodo:42",
    ]);
  });

  it("indexes federated scholarly paper identifiers", function () {
    const keys = keysForScholarlyPaper({
      paperId: "arxiv:2412.08905v1",
      source: "arxiv",
      sources: ["arxiv"],
      title: "A Test Paper",
      authors: [],
      citationCount: 0,
      url: "https://arxiv.org/abs/2412.08905v1",
      providerIds: { arxiv: "2412.08905v1" },
      externalIds: { ArXiv: "2412.08905v1", DOI: "10.1000/test" },
    }).map(identifierKeyString);
    assert.includeMembers(keys, [
      "arxiv:2412.08905v1",
      "arxiv:2412.08905",
      "doi:10.1000/test",
    ]);
  });

  it("validates updated plugin tool schemas", function () {
    assert.isTrue(
      safeValidateToolArgs(TOOL_NAMES.READ_ITEM_CONTENT, {
        item_id: "2412.08905",
        max_length: 5000,
      }).success,
    );
    assert.isTrue(
      safeValidateToolArgs(TOOL_NAMES.IMPORT_PAPER, {
        paper_id: "arxiv:2412.08905v1",
        provider: "arxiv",
      }).success,
    );
    assert.isTrue(
      safeValidateToolArgs(TOOL_NAMES.IMPORT_PAPER, {
        paper_ids: ["arxiv:2412.08905v1", "pubmed:123456"],
        wait_for_pdf: true,
        trigger_ocr: false,
      }).success,
    );
    assert.isFalse(
      safeValidateToolArgs(TOOL_NAMES.IMPORT_PAPER, {
        provider: "arxiv",
      }).success,
    );
  });

  it("defaults agent import OCR configuration to enabled", function () {
    assert.isTrue(defaultAgentConfig.autoOcr);
  });

  it("validates updated MCP tool schemas", function () {
    const read = TOOL_DEFINITIONS.find(
      (tool) => tool.name === "read_item_content",
    )!;
    const importPaper = TOOL_DEFINITIONS.find(
      (tool) => tool.name === "import_paper",
    )!;
    assert.doesNotThrow(() =>
      read.inputSchema.parse({ item_id: "2412.08905" }),
    );
    assert.doesNotThrow(() =>
      importPaper.inputSchema.parse({
        paper_ids: ["arxiv:2412.08905v1"],
        provider: "arxiv",
        wait_for_pdf: true,
      }),
    );
    assert.throws(() => importPaper.inputSchema.parse({ provider: "arxiv" }));
  });
});
