import { assert } from "chai";
import { SystematicReviewService } from "../src/modules/systematicReview/service";
import { SystematicReviewStore } from "../src/modules/systematicReview/store";
import {
  SourceSyncInput,
  SystematicReviewProjectData,
  SystematicReviewState,
} from "../src/modules/systematicReview/types";
import { createProtocolFromLegacy } from "../src/modules/systematicReview/protocol";
import { discoverZoteroCollectionTree } from "../src/modules/systematicReview/sources";

function state(): SystematicReviewState {
  return {
    papers: [],
    folders: [],
    selectedFolderIds: [],
    sourceOccurrences: [],
    scrSelected: [],
    extractions: {},
    robData: {},
    paperLabels: {},
    evidenceDomains: [],
  } as unknown as SystematicReviewState;
}

function source(
  id: string,
  collectionId: number,
  paperIds: number[],
): SourceSyncInput {
  return {
    source: {
      id,
      name: id,
      parent: "Library",
      type: "Database",
      srcLabel: id,
      itemCount: 0,
      active: true,
      zoteroCollectionId: collectionId,
      zoteroLibraryId: 1,
      collectionPath: id,
      includeSubfolders: true,
      available: true,
    },
    records: paperIds.map((paperId) => ({
      paperId,
      collectionId,
    })),
  };
}

describe("Systematic review source synchronization", function () {
  const service = new SystematicReviewService({} as SystematicReviewStore);

  it("discovers Zotero folders without bulk-loading item libraries", async function () {
    const libraries = await discoverZoteroCollectionTree();
    assert.isArray(libraries);
  });

  it("deduplicates papers while retaining overlapping sources", function () {
    const review = state();
    const result = service.syncSources(review, [
      source("pubmed", 10, [1, 2]),
      source("embase", 20, [2, 3]),
    ]);
    assert.deepEqual(review.papers.map((paper) => paper.id).sort(), [1, 2, 3]);
    assert.lengthOf(review.sourceOccurrences, 4);
    assert.deepEqual(result.overlappingPapers, [2]);
    assert.isFalse(review.papers[0].manualAdded);
  });

  it("is idempotent across repeated synchronization", function () {
    const review = state();
    const inputs = [source("pubmed", 10, [1, 2])];
    service.syncSources(review, inputs);
    const result = service.syncSources(review, inputs);
    assert.equal(result.addedOccurrences, 0);
    assert.equal(result.removedOccurrences, 0);
    assert.equal(result.retainedOccurrences, 2);
    assert.lengthOf(review.papers, 2);
  });

  it("removes source-only papers and preserves manual membership", function () {
    const review = state();
    service.syncSources(review, [source("pubmed", 10, [1, 2])]);
    service.addPapers(review, [2]);
    const result = service.syncSources(review, []);
    assert.deepEqual(result.removedPapers, [1]);
    assert.deepEqual(
      review.papers.map((paper) => paper.id),
      [2],
    );
    assert.isTrue(review.papers[0].manualAdded);
  });

  it("retains occurrences for temporarily unavailable folders", function () {
    const review = state();
    service.syncSources(review, [source("pubmed", 10, [1])]);
    const unavailable = source("pubmed", 10, []);
    unavailable.source.available = false;
    const result = service.syncSources(review, [unavailable]);
    assert.lengthOf(review.sourceOccurrences, 1);
    assert.lengthOf(review.papers, 1);
    assert.lengthOf(result.warnings, 1);
  });

  it("migrates legacy folder membership into a source occurrence", function () {
    const store = new SystematicReviewStore();
    const data = {
      folders: [
        {
          id: "legacy",
          name: "Legacy",
          parent: "Library",
          type: "Database",
          srcLabel: "Legacy",
          itemCount: 1,
          active: true,
          zoteroCollectionId: 10,
        },
      ],
      sourceOccurrences: [],
      reviewJobs: [
        {
          id: "job-running",
          kind: "analysis",
          projectId: "default",
          protocolRevisionId: "legacy",
          status: "running",
          paperIds: [1],
          papers: [{ paperId: 1, stage: "extracting", attempts: 1 }],
          concurrency: 2,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      papers: [
        {
          id: 1,
          status: "undecided",
          aiStatus: "manual",
          confidence: 0,
          folderId: "legacy",
        },
      ],
      protocol: createProtocolFromLegacy("PICO", {}, [], [], {}),
      extractions: {
        1: [
          {
            outcome: "Mortality",
            effectType: "RR",
            effectSize: 0.8,
            ciLow: 0.6,
            ciHigh: 1,
            n: 100,
            events: 10,
          },
        ],
      },
    } as unknown as SystematicReviewProjectData;
    const normalized = (
      store as unknown as {
        normalizeProjectData(
          value: SystematicReviewProjectData,
        ): SystematicReviewProjectData;
      }
    ).normalizeProjectData(data);
    assert.lengthOf(normalized.sourceOccurrences, 1);
    assert.equal(normalized.sourceOccurrences[0].sourceId, "legacy");
    assert.isFalse(normalized.papers[0].manualAdded);
    assert.notProperty(normalized.papers[0], "folderId");
    assert.equal(normalized.extractions[1][0].verificationStatus, "proposed");
    assert.match(normalized.extractions[1][0].id || "", /^ext_/);
    assert.deepEqual(normalized.synthesisRuns, []);
    assert.equal(normalized.analysisSettings.automation, "manual");
    assert.equal(normalized.activeExtractionTemplateId, "template_legacy");
    assert.equal(
      normalized.extractionTemplates[0].outcomes[0].name,
      "Mortality",
    );
    assert.equal(normalized.reviewJobs[0].status, "interrupted");
  });
});
