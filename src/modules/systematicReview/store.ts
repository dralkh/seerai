import { z } from "zod";
import { config } from "../../../package.json";
import {
  DEFAULT_LABELS,
  SystematicReviewProjectData,
  SystematicReviewSpace,
  SystematicReviewState,
} from "./types";
import {
  applyProtocolCompatibility,
  createProtocolFromLegacy,
} from "./protocol";

const SR_SCHEMA_VERSION = 8;

const ReviewSourceSummarySchema = z.object({
  kind: z.enum(["pdf", "same_title_note", "notes", "abstract"]),
  attachmentId: z.number().int().positive().optional(),
  noteIds: z.array(z.number().int().positive()),
  totalCharacters: z.number().int().nonnegative(),
  suppliedCharacters: z.number().int().nonnegative(),
  truncated: z.boolean(),
  fingerprint: z.string(),
  warnings: z.array(z.string()),
});

const ExtractionIssueSchema = z.object({
  code: z.string(),
  severity: z.enum(["warning", "error"]),
  field: z.string().optional(),
  message: z.string(),
  rawValue: z.string().optional(),
});

const ScreeningDecisionSchema = z.enum([
  "undecided",
  "included",
  "maybe",
  "excluded",
]);

const PaperSchema = z.object({
  id: z.number().int().positive(),
  status: ScreeningDecisionSchema,
  screeningStage: z.enum(["title_abstract", "full_text", "final"]).optional(),
  screeningEvents: z
    .array(
      z.object({
        id: z.string(),
        stage: z.enum(["title_abstract", "full_text", "final"]),
        decision: ScreeningDecisionSchema,
        actor: z.enum(["user", "model", "automation"]),
        reason: z.string().optional(),
        confidence: z.number().min(0).max(1).optional(),
        modelRunId: z.string().optional(),
        confirmed: z.boolean(),
        createdAt: z.string(),
      }),
    )
    .optional(),
  aiStatus: z.enum(["auto", "manual"]),
  confidence: z.number().min(0).max(1),
  modelConfidence: z.number().min(0).max(1).optional(),
  keywordConfidence: z.number().min(0).max(1).optional(),
  sourcePreference: z
    .enum(["auto", "pdf", "same_title_note", "notes", "abstract"])
    .optional(),
  recommendation: z
    .object({
      decision: ScreeningDecisionSchema,
      confidence: z.number().min(0).max(1),
      rationale: z.string(),
      source: z.enum(["keyword", "model"]),
      createdAt: z.string(),
      protocolRevisionId: z.string().optional(),
      sourceSummary: ReviewSourceSummarySchema.optional(),
      criteria: z
        .array(
          z.object({
            criterionId: z.string(),
            verdict: z.enum(["met", "not_met", "unclear"]),
            rationale: z.string(),
            quote: z.string().optional(),
            confidence: z.number().min(0).max(1).optional(),
          }),
        )
        .optional(),
    })
    .optional(),
  analysis: z
    .object({
      studyDesign: z.string().optional(),
      population: z.string().optional(),
      intervention: z.string().optional(),
      comparator: z.string().optional(),
      outcomes: z.array(z.string()).optional(),
      sampleSize: z.number().int().nonnegative().optional(),
      methods: z.string().optional(),
      limitations: z.string().optional(),
      evidence: z.array(
        z.object({
          field: z.string(),
          quote: z.string(),
        }),
      ),
      model: z.string(),
      createdAt: z.string(),
      protocolRevisionId: z.string().optional(),
      sourceSummary: ReviewSourceSummarySchema.optional(),
    })
    .optional(),
  exclReason: z.string().optional(),
  note: z.string().optional(),
  folderId: z.string().optional(),
  manualAdded: z.boolean().optional(),
  sourceLabel: z.string().optional(),
  sourceType: z.enum(["Database", "Register", "Other source"]).optional(),
  bias: z.enum(["Low", "Some concerns", "High", "Unclear"]).optional(),
  design: z.string().optional(),
  ev: z.string().optional(),
  sample: z.number().optional(),
  methods: z.string().optional(),
  pop: z.string().optional(),
  lim: z.string().optional(),
});

const FolderSchema = z.object({
  id: z.string(),
  name: z.string(),
  parent: z.string(),
  type: z.enum(["Database", "Register", "Other source"]),
  srcLabel: z.string(),
  itemCount: z.number(),
  active: z.boolean(),
  zoteroCollectionId: z.number().int().optional(),
  zoteroLibraryId: z.number().int().optional(),
  parentCollectionId: z.number().int().optional(),
  collectionPath: z.string().optional(),
  includeSubfolders: z.boolean().optional(),
  available: z.boolean().optional(),
  lastSyncedAt: z.string().optional(),
});

const SourceOccurrenceSchema = z.object({
  id: z.string(),
  paperId: z.number().int().positive(),
  sourceId: z.string(),
  collectionId: z.number().int().positive(),
  firstSeenAt: z.string(),
  lastSeenAt: z.string(),
});

const ExtractionSchema = z.object({
  id: z.string().optional(),
  outcomeId: z.string().optional(),
  outcome: z.string(),
  effectType: z.string(),
  effectSize: z.number().optional(),
  ciLow: z.number().optional(),
  ciHigh: z.number().optional(),
  n: z.number().optional(),
  events: z.number().optional(),
  timepoint: z.string().optional(),
  unit: z.string().optional(),
  interventionArm: z.string().optional(),
  comparatorArm: z.string().optional(),
  direction: z.enum(["higher_better", "lower_better"]).optional(),
  sourceAttachmentId: z.number().int().positive().optional(),
  sourcePage: z.string().optional(),
  sourceQuote: z.string().optional(),
  verificationStatus: z.enum(["proposed", "verified", "rejected"]).optional(),
  confidence: z.number().min(0).max(1).optional(),
  missingReason: z.string().optional(),
  model: z.string().optional(),
  jobId: z.string().optional(),
  templateRevisionId: z.string().optional(),
  revision: z.number().int().positive().optional(),
  updatedAt: z.string().optional(),
  issues: z.array(ExtractionIssueSchema).optional(),
  sourceFingerprint: z.string().optional(),
});

const ExtractionOutcomeDefinitionSchema = z.object({
  id: z.string(),
  name: z.string().min(1),
  aliases: z.array(z.string()),
  description: z.string(),
  // Canonical measure labels — poolable codes (OR/RR/HR/MD/SMD) plus
  // diagnostic/prognostic labels (AUROC, Sensitivity, Brier score, …).
  measures: z.array(z.string().min(1)).min(1),
  timepoints: z.array(z.string()),
  unit: z.string().optional(),
  direction: z.enum(["higher_better", "lower_better"]).optional(),
  required: z.boolean(),
});

const ExtractionTemplateSchema = z.object({
  id: z.string(),
  revisionId: z.string(),
  protocolRevisionId: z.string(),
  name: z.string().min(1),
  instructions: z.string(),
  outcomes: z.array(ExtractionOutcomeDefinitionSchema),
  status: z.enum(["draft", "active", "archived"]),
  source: z.enum(["user", "model", "migration"]),
  model: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const ReviewJobPaperSchema = z.object({
  paperId: z.number().int().positive(),
  stage: z.enum([
    "queued",
    "reading_source",
    "extracting",
    "validating",
    "saving",
    "synthesizing",
    "analyzing_gaps",
    "completed",
    "failed",
    "cancelled",
  ]),
  attempts: z.number().int().nonnegative(),
  evidenceCount: z.number().int().nonnegative().optional(),
  proposalCount: z.number().int().nonnegative().optional(),
  issueCount: z.number().int().nonnegative().optional(),
  sourceSummary: ReviewSourceSummarySchema.optional(),
  error: z.string().optional(),
  startedAt: z.string().optional(),
  completedAt: z.string().optional(),
});

const ReviewJobSchema = z.object({
  id: z.string(),
  kind: z.enum(["analysis", "extraction", "evidence_analysis", "gap_analysis"]),
  projectId: z.string(),
  protocolRevisionId: z.string(),
  templateRevisionId: z.string().optional(),
  status: z.enum([
    "queued",
    "running",
    "paused",
    "completed",
    "completed_with_issues",
    "failed",
    "cancelled",
    "interrupted",
  ]),
  paperIds: z.array(z.number().int().positive()),
  papers: z.array(ReviewJobPaperSchema),
  concurrency: z.number().int().min(1).max(10),
  createdAt: z.string(),
  updatedAt: z.string(),
  startedAt: z.string().optional(),
  completedAt: z.string().optional(),
  error: z.string().optional(),
  synthesisRunId: z.string().optional(),
  gapAnalysisRunId: z.string().optional(),
});

const RoBSchema = z.object({
  randomization: z.enum(["not_assessed", "low", "some", "high"]),
  deviations: z.enum(["not_assessed", "low", "some", "high"]),
  missing: z.enum(["not_assessed", "low", "some", "high"]),
  measurement: z.enum(["not_assessed", "low", "some", "high"]),
  selective: z.enum(["not_assessed", "low", "some", "high"]),
  instrument: z
    .enum(["rob2", "robins_i", "quadas2", "casP", "amstar2"])
    .optional(),
  rationale: z.string().optional(),
  sourceQuote: z.string().optional(),
  verificationStatus: z.enum(["proposed", "verified"]).optional(),
  updatedAt: z.string().optional(),
});

const LabelSchema = z.object({
  k: z.string(),
  name: z.string(),
  color: z.string(),
  bg: z.string(),
});

const EvidenceDomainSchema = z.object({
  id: z.string(),
  outcome: z.string(),
  strength: z.enum(["high", "moderate", "low", "verylow"]),
  direction: z.enum(["positive", "mixed", "none"]),
  studyCount: z.number(),
  summary: z.string(),
  contributing: z.array(z.number().int()),
});

const GapSchema = z.object({
  id: z.string(),
  title: z.string(),
  severity: z.enum(["high", "medium", "low"]),
  picosTags: z.array(z.string()),
  reasonCode: z.enum(["A", "B", "C", "D"]),
  description: z.string(),
  implication: z.string(),
});

const MetaAnalysisSummarySchema = z.object({
  estimate: z.number(),
  ciLow: z.number(),
  ciHigh: z.number(),
  predictionLow: z.number().optional(),
  predictionHigh: z.number().optional(),
  q: z.number(),
  i2: z.number(),
  tau2: z.number(),
  weights: z.array(z.number()),
});

const StudyEstimateSchema = z.object({
  extractionId: z.string(),
  paperId: z.number().int().positive(),
  outcome: z.string(),
  measure: z.string(),
  estimate: z.number(),
  ciLow: z.number(),
  ciHigh: z.number(),
  weight: z.number().optional(),
  timepoint: z.string().optional(),
  unit: z.string().optional(),
  sourceQuote: z.string().optional(),
  sourcePage: z.string().optional(),
});

const GradeJudgmentSchema = z.object({
  certainty: z.enum(["high", "moderate", "low", "verylow", "not_applicable"]),
  riskOfBias: z.union([z.literal(0), z.literal(-1), z.literal(-2)]),
  inconsistency: z.union([z.literal(0), z.literal(-1), z.literal(-2)]),
  indirectness: z.union([z.literal(0), z.literal(-1), z.literal(-2)]),
  imprecision: z.union([z.literal(0), z.literal(-1), z.literal(-2)]),
  publicationBias: z.union([z.literal(0), z.literal(-1), z.literal(-2)]),
  upgrade: z.union([z.literal(0), z.literal(1), z.literal(2)]),
  rationale: z.array(z.string()),
  confirmed: z.boolean(),
});

const SynthesisDomainSchema = z.object({
  id: z.string(),
  key: z.string(),
  outcome: z.string(),
  population: z.string().optional(),
  intervention: z.string().optional(),
  comparator: z.string().optional(),
  timepoint: z.string().optional(),
  measure: z.string().optional(),
  method: z.enum(["common_effect", "random_effects", "narrative"]),
  status: z.enum(["poolable", "not_poolable", "narrative"]),
  studies: z.array(StudyEstimateSchema),
  paperIds: z.array(z.number().int().positive()),
  direction: z.enum(["positive", "mixed", "none", "unclear"]),
  summary: z.string(),
  nonPoolableReasons: z.array(z.string()),
  commonEffect: MetaAnalysisSummarySchema.optional(),
  randomEffects: MetaAnalysisSummarySchema.optional(),
  selectedModel: z
    .enum(["common_effect", "random_effects", "narrative"])
    .optional(),
  methodConfirmed: z.boolean(),
  grade: GradeJudgmentSchema,
  narrativeConfirmed: z.boolean(),
});

const SynthesisRunSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  protocolRevisionId: z.string(),
  inputFingerprint: z.string(),
  includedPaperIds: z.array(z.number().int().positive()),
  createdAt: z.string(),
  updatedAt: z.string(),
  status: z.enum(["draft", "confirmed", "stale", "failed", "needs_ai"]),
  staleReasons: z.array(z.string()),
  warnings: z.array(z.string()),
  model: z.string().optional(),
  domains: z.array(SynthesisDomainSchema),
});

const GapCellSchema = z.object({
  id: z.string(),
  rowKey: z.string(),
  rowValue: z.string(),
  columnKey: z.string(),
  columnValue: z.string(),
  status: z.enum([
    "no_evidence",
    "sparse",
    "low_certainty",
    "conflicting",
    "indirect",
    "adequate",
    "not_applicable",
  ]),
  domainIds: z.array(z.string()),
  paperIds: z.array(z.number().int().positive()),
  studyCount: z.number().int().nonnegative(),
  rationale: z.string(),
});

const GapCandidateSchema = z.object({
  id: z.string(),
  canonicalKey: z.string(),
  title: z.string(),
  severity: z.enum(["high", "medium", "low"]),
  reasonCode: z.enum(["insufficient", "biased", "inconsistent", "indirect"]),
  dimensionTags: z.array(z.string()),
  description: z.string(),
  implication: z.string(),
  domainIds: z.array(z.string()),
  paperIds: z.array(z.number().int().positive()),
  status: z.enum(["draft", "accepted", "rejected", "ignored"]),
  reviewerNote: z.string().optional(),
  updatedAt: z.string(),
});

const GapAnalysisRunSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  synthesisRunId: z.string(),
  inputFingerprint: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  status: z.enum(["draft", "confirmed", "stale", "failed", "needs_ai"]),
  rowDimensionKey: z.string(),
  columnDimensionKey: z.string(),
  cells: z.array(GapCellSchema),
  gaps: z.array(GapCandidateSchema),
  warnings: z.array(z.string()),
});

const UIStateSchema = z.object({
  filterEnabled: z.array(z.string()),
  filterOpen: z.array(z.string()),
  activeFilters: z.record(z.string(), z.array(z.string())),
  gapSeverityFilter: z.enum(["all", "high", "medium", "low"]).optional(),
});

const ProtocolProvenanceSchema = z.object({
  field: z.string(),
  source: z.string(),
  quote: z.string().optional(),
  confidence: z.number().min(0).max(1).optional(),
});

const ProtocolDimensionSchema = z.object({
  key: z.string(),
  label: z.string(),
  description: z.string(),
  value: z.string(),
  keywordAids: z.array(z.string()),
  evidenceLabels: z.array(z.string()),
});

const EligibilityRuleSchema = z.object({
  id: z.string(),
  type: z.enum(["include", "exclude"]),
  text: z.string(),
  dimensionKey: z.string().optional(),
});

const ProtocolRevisionSchema = z.object({
  id: z.string(),
  createdAt: z.string(),
  actor: z.enum(["user", "model", "migration"]),
  model: z.string().optional(),
  researchQuestion: z.string(),
  framework: z.string(),
  frameworkReason: z.string().optional(),
  dimensions: z.array(ProtocolDimensionSchema),
  eligibilityRules: z.array(EligibilityRuleSchema),
  includeKeywordAids: z.array(z.string()),
  excludeKeywordAids: z.array(z.string()),
  provenance: z.array(ProtocolProvenanceSchema),
  warnings: z.array(z.string()),
});

const ReviewProtocolSchema = z.object({
  activeRevisionId: z.string(),
  revisions: z.array(ProtocolRevisionSchema).min(1),
});

const ProjectDataSchema = z.object({
  activeSubTab: z.enum([
    "screening",
    "evidence",
    "gaps",
    "prisma",
    "extraction",
    "methodology",
  ]),
  folders: z.array(FolderSchema),
  selectedFolderIds: z.array(z.string()),
  sourceOccurrences: z.array(SourceOccurrenceSchema).optional(),
  papers: z.array(PaperSchema),
  extractionTemplates: z.array(ExtractionTemplateSchema).optional(),
  activeExtractionTemplateId: z.string().optional(),
  reviewJobs: z.array(ReviewJobSchema).optional(),
  extractions: z.record(z.string(), z.array(ExtractionSchema)),
  robData: z.record(z.string(), RoBSchema),
  paperLabels: z.record(z.string(), z.array(z.string())),
  labelDefs: z.array(LabelSchema),
  incKeywords: z.array(z.string()),
  excKeywords: z.array(z.string()),
  framework: z.string(),
  frameworkValues: z.record(z.string(), z.string()),
  picoLabelMap: z.record(z.string(), z.array(z.string())),
  protocol: ReviewProtocolSchema.optional(),
  activeFolderId: z.string(),
  evidenceDomains: z.array(EvidenceDomainSchema),
  gaps: z.array(GapSchema),
  synthesisRuns: z.array(SynthesisRunSchema).optional(),
  activeSynthesisRunId: z.string().optional(),
  gapAnalysisRuns: z.array(GapAnalysisRunSchema).optional(),
  activeGapAnalysisRunId: z.string().optional(),
  analysisSettings: z
    .object({
      automation: z.enum(["auto_draft", "manual"]),
      sparseStudyThreshold: z.number().int().min(1),
    })
    .optional(),
  synthesisEdits: z.record(
    z.string(),
    z.object({
      grade: z.string().optional(),
      narrative: z.string().optional(),
    }),
  ),
  gapEdits: z.record(
    z.string(),
    z.object({
      status: z.enum(["accepted", "rejected", "ignored"]).optional(),
      note: z.string().optional(),
    }),
  ),
  srUIState: UIStateSchema,
  scrFilter: z.string(),
  scrSort: z.string(),
  scrSearch: z.string(),
  scrSelected: z.array(z.number().int()),
  quickSkip: z.boolean(),
  kwFilterActive: z.boolean(),
  kwFilterKeyword: z.string().nullable(),
});

const PersistedProjectSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  createdAt: z.string(),
  updatedAt: z.string(),
  data: ProjectDataSchema,
});

const PersistedStateSchema = z.object({
  v: z.union([
    z.literal(3),
    z.literal(4),
    z.literal(5),
    z.literal(6),
    z.literal(7),
    z.literal(SR_SCHEMA_VERSION),
  ]),
  activeProjectId: z.string().min(1),
  projects: z.array(PersistedProjectSchema).min(1),
});

type PersistedState = z.infer<typeof PersistedStateSchema>;
type PersistedProject = z.infer<typeof PersistedProjectSchema>;

function deepCopy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export class SystematicReviewStore {
  private dataDir: string;
  private configFile: string;
  private backupFile: string;
  private writeLock: Promise<void> = Promise.resolve();

  constructor() {
    this.dataDir = PathUtils.join(Zotero.DataDirectory.dir, config.addonRef);
    this.configFile = PathUtils.join(this.dataDir, "sr_data.json");
    this.backupFile = PathUtils.join(
      this.dataDir,
      "sr_data.pre_v6.backup.json",
    );
  }

  private async withWriteLock<T>(operation: () => Promise<T>): Promise<T> {
    const prev = this.writeLock;
    let release: () => void;
    this.writeLock = new Promise((resolve) => {
      release = resolve;
    });
    try {
      await prev;
      return await operation();
    } finally {
      release!();
    }
  }

  private async ensureDir(): Promise<void> {
    if (!(await IOUtils.exists(this.dataDir))) {
      await IOUtils.makeDirectory(this.dataDir, { ignoreExisting: true });
    }
  }

  async loadState(): Promise<SystematicReviewState> {
    await this.ensureDir();
    try {
      if (await IOUtils.exists(this.configFile)) {
        const raw = await Zotero.File.getContentsAsync(this.configFile);
        const text = raw as string;
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch (error) {
          await this.backupLegacyState(text);
          throw error;
        }
        const persistedVersion =
          parsed && typeof parsed === "object"
            ? (parsed as { v?: unknown }).v
            : undefined;
        if (
          !PersistedStateSchema.safeParse(parsed).success ||
          persistedVersion !== SR_SCHEMA_VERSION
        ) {
          await this.backupLegacyState(text);
        }
        return this.deserialize(parsed);
      }
    } catch (error) {
      Zotero.debug(`[seerai] Error loading SR state: ${error}`);
    }
    return this.defaultState();
  }

  private async backupLegacyState(raw: string): Promise<void> {
    if (await IOUtils.exists(this.backupFile)) return;
    await Zotero.File.putContentsAsync(this.backupFile, raw);
  }

  async saveState(state: SystematicReviewState): Promise<void> {
    await this.withWriteLock(async () => {
      await this.ensureDir();
      this.syncActiveProject(state);
      const persisted = this.serialize(state);
      PersistedStateSchema.parse(persisted);
      await Zotero.File.putContentsAsync(
        this.configFile,
        JSON.stringify(persisted, null, 2),
      );
    });
  }

  switchProject(
    state: SystematicReviewState,
    projectId: string,
  ): SystematicReviewState {
    const target = state.spaces.find((space) => space.id === projectId);
    if (!target) {
      throw new Error(`Systematic review project not found: ${projectId}`);
    }
    this.syncActiveProject(state);
    state.activeSpaceId = projectId;
    this.applyProjectData(state, target);
    return state;
  }

  createProject(
    state: SystematicReviewState,
    name: string,
  ): SystematicReviewSpace {
    this.syncActiveProject(state);
    const now = new Date().toISOString();
    const id = `sp_${Date.now()}`;
    const data = this.defaultProjectData();
    const project = this.spaceFromData(id, name.trim() || "Untitled Review", {
      ...data,
      frameworkValues: deepCopy(data.frameworkValues),
    });
    project.createdAt = now;
    project.updatedAt = now;
    state.spaces.push(project);
    state.activeSpaceId = id;
    this.applyProjectData(state, project);
    return project;
  }

  syncActiveProject(state: SystematicReviewState): void {
    const project = state.spaces.find(
      (space) => space.id === state.activeSpaceId,
    );
    if (!project) return;
    const data = this.snapshotProjectData(state, project);
    project.framework = data.framework;
    project.protocol = deepCopy(data.protocol);
    project.frameworkValues = deepCopy(data.frameworkValues);
    project.incKeywords = [...data.incKeywords];
    project.excKeywords = [...data.excKeywords];
    project.picoLabelMap = deepCopy(data.picoLabelMap);
    project.activeFolderId = data.activeFolderId;
    project.paperStatus = Object.fromEntries(
      data.papers.map((paper) => [paper.id, paper.status]),
    );
    project.updatedAt = new Date().toISOString();
    project.data = data;
  }

  private defaultProjectData(): SystematicReviewProjectData {
    const protocol = createProtocolFromLegacy(
      "PICOTS",
      { P: "", I: "", C: "", O: "", T: "", S: "" },
      [],
      [],
      {
        P: ["genetic", "cohort", "ml"],
        I: ["rct", "ml", "meta"],
        C: ["rct", "meta"],
        O: ["biomarker", "follow", "genetic"],
        S: ["guideline", "review", "core"],
      },
    );
    const data: SystematicReviewProjectData = {
      activeSubTab: "screening",
      folders: [],
      selectedFolderIds: [],
      sourceOccurrences: [],
      papers: [],
      extractionTemplates: [],
      reviewJobs: [],
      extractions: {},
      robData: {},
      paperLabels: {},
      labelDefs: deepCopy(DEFAULT_LABELS),
      incKeywords: [],
      excKeywords: [],
      framework: "PICOTS",
      frameworkValues: { P: "", I: "", C: "", O: "", T: "", S: "" },
      picoLabelMap: {
        P: ["genetic", "cohort", "ml"],
        I: ["rct", "ml", "meta"],
        C: ["rct", "meta"],
        O: ["biomarker", "follow", "genetic"],
        S: ["guideline", "review", "core"],
      },
      protocol,
      activeFolderId: "all",
      evidenceDomains: [],
      gaps: [],
      synthesisRuns: [],
      gapAnalysisRuns: [],
      analysisSettings: {
        automation: "manual",
        sparseStudyThreshold: 2,
      },
      synthesisEdits: {},
      gapEdits: {},
      srUIState: {
        filterEnabled: [],
        filterOpen: ["keywords", "labels"],
        activeFilters: {},
      },
      scrFilter: "undecided",
      scrSort: "default",
      scrSearch: "",
      scrSelected: [],
      quickSkip: false,
      kwFilterActive: false,
      kwFilterKeyword: null,
    };
    applyProtocolCompatibility(data);
    return data;
  }

  private defaultState(): SystematicReviewState {
    const data = this.defaultProjectData();
    const project = this.spaceFromData("default", "Default Project", data);
    return this.stateFromProjects("default", [project]);
  }

  private spaceFromData(
    id: string,
    name: string,
    data: SystematicReviewProjectData,
  ): SystematicReviewSpace {
    const now = new Date().toISOString();
    return {
      id,
      name,
      protocol: deepCopy(data.protocol),
      framework: data.framework,
      frameworkValues: deepCopy(data.frameworkValues),
      incKeywords: [...data.incKeywords],
      excKeywords: [...data.excKeywords],
      picoLabelMap: deepCopy(data.picoLabelMap),
      activeFolderId: data.activeFolderId,
      paperStatus: Object.fromEntries(
        data.papers.map((paper) => [paper.id, paper.status]),
      ),
      createdAt: now,
      updatedAt: now,
      data: deepCopy(data),
    };
  }

  private stateFromProjects(
    activeProjectId: string,
    projects: SystematicReviewSpace[],
  ): SystematicReviewState {
    const active =
      projects.find((project) => project.id === activeProjectId) || projects[0];
    const state = {
      activeSpaceId: active.id,
      spaces: projects,
    } as SystematicReviewState;
    this.applyProjectData(state, active);
    return state;
  }

  private applyProjectData(
    state: SystematicReviewState,
    project: SystematicReviewSpace,
  ): void {
    const data = this.normalizeProjectData(
      deepCopy(project.data || this.defaultProjectData()),
    );
    state.activeSubTab = data.activeSubTab;
    state.folders = data.folders;
    state.selectedFolderIds = data.selectedFolderIds;
    state.sourceOccurrences = data.sourceOccurrences;
    state.papers = data.papers;
    state.extractionTemplates = data.extractionTemplates;
    state.activeExtractionTemplateId = data.activeExtractionTemplateId;
    state.reviewJobs = data.reviewJobs;
    state.extractions = data.extractions;
    state.robData = data.robData;
    state.paperLabels = data.paperLabels;
    state.labelDefs = data.labelDefs;
    state.protocol = data.protocol;
    state.incKeywords = data.incKeywords;
    state.excKeywords = data.excKeywords;
    state.framework = data.framework;
    state.frameworkValues = data.frameworkValues;
    state.evidenceDomains = data.evidenceDomains;
    state.gaps = data.gaps;
    state.synthesisRuns = data.synthesisRuns;
    state.activeSynthesisRunId = data.activeSynthesisRunId;
    state.gapAnalysisRuns = data.gapAnalysisRuns;
    state.activeGapAnalysisRunId = data.activeGapAnalysisRunId;
    state.analysisSettings = data.analysisSettings;
    state.synthesisEdits = data.synthesisEdits;
    state.gapEdits = data.gapEdits;
    state.srUIState = data.srUIState;
    state.scrFilter = data.scrFilter;
    state.scrSort = data.scrSort;
    state.scrSearch = data.scrSearch;
    state.scrSelected = data.scrSelected;
    state.quickSkip = data.quickSkip;
    state.kwFilterActive = data.kwFilterActive;
    state.kwFilterKeyword = data.kwFilterKeyword;
    project.framework = data.framework;
    project.protocol = deepCopy(data.protocol);
    project.frameworkValues = deepCopy(data.frameworkValues);
    project.incKeywords = [...data.incKeywords];
    project.excKeywords = [...data.excKeywords];
    project.picoLabelMap = deepCopy(data.picoLabelMap);
    project.activeFolderId = data.activeFolderId;
  }

  private snapshotProjectData(
    state: SystematicReviewState,
    project: SystematicReviewSpace,
  ): SystematicReviewProjectData {
    const data = deepCopy({
      activeSubTab: state.activeSubTab,
      folders: state.folders,
      selectedFolderIds: state.selectedFolderIds,
      sourceOccurrences: state.sourceOccurrences,
      papers: state.papers,
      extractionTemplates: state.extractionTemplates,
      activeExtractionTemplateId: state.activeExtractionTemplateId,
      reviewJobs: state.reviewJobs,
      extractions: state.extractions,
      robData: state.robData,
      paperLabels: state.paperLabels,
      labelDefs: state.labelDefs,
      protocol: state.protocol,
      incKeywords: state.incKeywords,
      excKeywords: state.excKeywords,
      framework: state.framework,
      frameworkValues: state.frameworkValues,
      picoLabelMap: project.picoLabelMap,
      activeFolderId: project.activeFolderId,
      evidenceDomains: state.evidenceDomains,
      gaps: state.gaps,
      synthesisRuns: state.synthesisRuns,
      activeSynthesisRunId: state.activeSynthesisRunId,
      gapAnalysisRuns: state.gapAnalysisRuns,
      activeGapAnalysisRunId: state.activeGapAnalysisRunId,
      analysisSettings: state.analysisSettings,
      synthesisEdits: state.synthesisEdits,
      gapEdits: state.gapEdits,
      srUIState: state.srUIState,
      scrFilter: state.scrFilter,
      scrSort: state.scrSort,
      scrSearch: state.scrSearch,
      scrSelected: state.scrSelected,
      quickSkip: state.quickSkip,
      kwFilterActive: state.kwFilterActive,
      kwFilterKeyword: state.kwFilterKeyword,
    });
    applyProtocolCompatibility(data);
    return data;
  }

  private serialize(state: SystematicReviewState): PersistedState {
    return {
      v: SR_SCHEMA_VERSION,
      activeProjectId: state.activeSpaceId,
      projects: state.spaces.map((space) => {
        const now = new Date().toISOString();
        return {
          id: space.id,
          name: space.name,
          createdAt: space.createdAt || now,
          updatedAt: space.updatedAt || now,
          data: deepCopy(space.data || this.defaultProjectData()),
        };
      }),
    };
  }

  private deserialize(value: unknown): SystematicReviewState {
    const parsed = PersistedStateSchema.safeParse(value);
    if (parsed.success) {
      return this.deserializePersisted(parsed.data);
    }
    return this.migrateLegacy(value);
  }

  private deserializePersisted(
    persisted: PersistedState,
  ): SystematicReviewState {
    const projects = persisted.projects.map((project) =>
      this.spaceFromPersistedProject(project),
    );
    return this.stateFromProjects(persisted.activeProjectId, projects);
  }

  private spaceFromPersistedProject(
    project: PersistedProject,
  ): SystematicReviewSpace {
    const space = this.spaceFromData(
      project.id,
      project.name,
      this.normalizeProjectData(project.data as SystematicReviewProjectData),
    );
    space.createdAt = project.createdAt;
    space.updatedAt = project.updatedAt;
    return space;
  }

  private migrateLegacy(value: unknown): SystematicReviewState {
    const legacy =
      value && typeof value === "object"
        ? (value as Record<string, unknown>)
        : {};
    const fallback = this.defaultProjectData();
    const shared = this.legacyProjectData(legacy, fallback);
    const legacySpaces = Array.isArray(legacy.spaces) ? legacy.spaces : [];
    const projects = legacySpaces
      .filter(
        (space): space is Record<string, unknown> =>
          !!space && typeof space === "object",
      )
      .map((space, index) => {
        const data = deepCopy(shared);
        data.framework =
          typeof space.framework === "string"
            ? space.framework
            : data.framework;
        data.frameworkValues = this.stringRecord(
          space.frameworkValues,
          data.frameworkValues,
        );
        data.incKeywords = this.stringArray(
          space.incKeywords,
          data.incKeywords,
        );
        data.excKeywords = this.stringArray(
          space.excKeywords,
          data.excKeywords,
        );
        data.picoLabelMap = this.stringArrayRecord(
          space.picoLabelMap,
          data.picoLabelMap,
        );
        data.protocol = createProtocolFromLegacy(
          data.framework,
          data.frameworkValues,
          data.incKeywords,
          data.excKeywords,
          data.picoLabelMap,
        );
        applyProtocolCompatibility(data);
        data.activeFolderId =
          typeof space.activeFolderId === "string"
            ? space.activeFolderId
            : "all";
        const statuses =
          space.paperStatus && typeof space.paperStatus === "object"
            ? (space.paperStatus as Record<string, unknown>)
            : {};
        data.papers = data.papers.map((paper) => ({
          ...paper,
          status: ScreeningDecisionSchema.safeParse(statuses[paper.id]).success
            ? (statuses[paper.id] as typeof paper.status)
            : paper.status,
        }));
        return this.spaceFromData(
          typeof space.id === "string" ? space.id : `project_${index + 1}`,
          typeof space.name === "string" ? space.name : `Project ${index + 1}`,
          data,
        );
      });
    if (projects.length === 0) {
      projects.push(this.spaceFromData("default", "Default Project", shared));
    }
    const requested =
      typeof legacy.activeSpaceId === "string"
        ? legacy.activeSpaceId
        : projects[0].id;
    const active = projects.some((project) => project.id === requested)
      ? requested
      : projects[0].id;
    return this.stateFromProjects(active, projects);
  }

  private legacyProjectData(
    legacy: Record<string, unknown>,
    fallback: SystematicReviewProjectData,
  ): SystematicReviewProjectData {
    const candidate = {
      ...fallback,
      activeSubTab: legacy.activeSubTab ?? fallback.activeSubTab,
      folders: legacy.folders ?? fallback.folders,
      selectedFolderIds: legacy.selectedFolderIds ?? fallback.selectedFolderIds,
      sourceOccurrences: legacy.sourceOccurrences ?? fallback.sourceOccurrences,
      papers: legacy.papers ?? fallback.papers,
      extractionTemplates:
        legacy.extractionTemplates ?? fallback.extractionTemplates,
      activeExtractionTemplateId:
        legacy.activeExtractionTemplateId ??
        fallback.activeExtractionTemplateId,
      reviewJobs: legacy.reviewJobs ?? fallback.reviewJobs,
      extractions: legacy.extractions ?? fallback.extractions,
      robData: legacy.robData ?? fallback.robData,
      paperLabels: legacy.paperLabels ?? fallback.paperLabels,
      labelDefs: legacy.labelDefs ?? fallback.labelDefs,
      incKeywords: legacy.incKeywords ?? fallback.incKeywords,
      excKeywords: legacy.excKeywords ?? fallback.excKeywords,
      framework: legacy.framework ?? fallback.framework,
      frameworkValues: legacy.frameworkValues ?? fallback.frameworkValues,
      picoLabelMap: fallback.picoLabelMap,
      protocol: legacy.protocol ?? fallback.protocol,
      activeFolderId: fallback.activeFolderId,
      evidenceDomains: legacy.evidenceDomains ?? fallback.evidenceDomains,
      gaps: legacy.gaps ?? fallback.gaps,
      synthesisRuns: legacy.synthesisRuns ?? fallback.synthesisRuns,
      activeSynthesisRunId:
        legacy.activeSynthesisRunId ?? fallback.activeSynthesisRunId,
      gapAnalysisRuns: legacy.gapAnalysisRuns ?? fallback.gapAnalysisRuns,
      activeGapAnalysisRunId:
        legacy.activeGapAnalysisRunId ?? fallback.activeGapAnalysisRunId,
      analysisSettings: legacy.analysisSettings ?? fallback.analysisSettings,
      synthesisEdits: legacy.synthesisEdits ?? fallback.synthesisEdits,
      gapEdits: legacy.gapEdits ?? fallback.gapEdits,
      srUIState: legacy.srUIState ?? fallback.srUIState,
      scrFilter: legacy.scrFilter ?? fallback.scrFilter,
      scrSort: legacy.scrSort ?? fallback.scrSort,
      scrSearch: legacy.scrSearch ?? fallback.scrSearch,
      scrSelected: legacy.scrSelected ?? fallback.scrSelected,
      quickSkip: legacy.quickSkip ?? fallback.quickSkip,
      kwFilterActive: legacy.kwFilterActive ?? fallback.kwFilterActive,
      kwFilterKeyword: legacy.kwFilterKeyword ?? fallback.kwFilterKeyword,
    };
    const parsed = ProjectDataSchema.safeParse(candidate);
    if (!parsed.success) {
      Zotero.debug(
        `[seerai] Invalid legacy SR data; using defaults: ${parsed.error.message}`,
      );
      return deepCopy(fallback);
    }
    return this.normalizeProjectData(
      parsed.data as SystematicReviewProjectData,
    );
  }

  private normalizeProjectData(
    data: SystematicReviewProjectData,
  ): SystematicReviewProjectData {
    data.synthesisRuns = data.synthesisRuns || [];
    data.gapAnalysisRuns = data.gapAnalysisRuns || [];
    data.extractionTemplates = data.extractionTemplates || [];
    data.reviewJobs = (data.reviewJobs || []).map((job) =>
      job.status === "running" || job.status === "queued"
        ? {
            ...job,
            status: "interrupted" as const,
            updatedAt: new Date().toISOString(),
          }
        : job,
    );
    data.analysisSettings = data.analysisSettings || {
      automation: "manual",
      sparseStudyThreshold: 2,
    };
    data.analysisSettings.automation = "manual";
    const legacyOutcomes = new Map<
      string,
      {
        id: string;
        name: string;
        aliases: string[];
        description: string;
        measures: string[];
        timepoints: string[];
        unit?: string;
        direction?: "higher_better" | "lower_better";
        required: boolean;
      }
    >();
    for (const rows of Object.values(data.extractions || {})) {
      for (const row of rows) {
        const key = row.outcome.trim().toLowerCase();
        if (!key || legacyOutcomes.has(key)) continue;
        const measure = row.effectType?.trim() || "OR";
        legacyOutcomes.set(key, {
          id: `outcome_legacy_${legacyOutcomes.size + 1}`,
          name: row.outcome,
          aliases: [],
          description: "",
          measures: [measure],
          timepoints: row.timepoint ? [row.timepoint] : [],
          unit: row.unit,
          direction: row.direction,
          required: false,
        });
      }
    }
    if (!data.extractionTemplates.length && legacyOutcomes.size > 0) {
      const now = new Date().toISOString();
      const protocolRevisionId = data.protocol.activeRevisionId;
      data.extractionTemplates.push({
        id: "template_legacy",
        revisionId: `template_legacy_${protocolRevisionId}`,
        protocolRevisionId,
        name: "Legacy extraction template",
        instructions: "",
        outcomes: Array.from(legacyOutcomes.values()),
        status: "active",
        source: "migration",
        createdAt: now,
        updatedAt: now,
      });
      data.activeExtractionTemplateId = "template_legacy";
    }
    const activeTemplate = data.extractionTemplates.find(
      (template) => template.id === data.activeExtractionTemplateId,
    );
    for (const [paperId, rows] of Object.entries(data.extractions || {})) {
      data.extractions[Number(paperId)] = rows.map((row, index) => ({
        ...row,
        outcomeId:
          row.outcomeId ||
          activeTemplate?.outcomes.find(
            (outcome) =>
              outcome.name.trim().toLowerCase() ===
              row.outcome.trim().toLowerCase(),
          )?.id,
        templateRevisionId:
          row.templateRevisionId || activeTemplate?.revisionId,
        id: row.id || `ext_${paperId}_${index}_${Date.now()}`,
        verificationStatus: row.verificationStatus || "proposed",
        revision: row.revision || 1,
        updatedAt: row.updatedAt || new Date().toISOString(),
      }));
    }
    data.folders = (data.folders || []).map((folder) => ({
      ...folder,
      includeSubfolders: folder.includeSubfolders ?? true,
      available: folder.available ?? true,
      collectionPath: folder.collectionPath || folder.name,
    }));
    const now = new Date().toISOString();
    data.sourceOccurrences = data.sourceOccurrences || [];
    const occurrenceKeys = new Set(
      data.sourceOccurrences.map(
        (occurrence) =>
          `${occurrence.paperId}:${occurrence.sourceId}:${occurrence.collectionId}`,
      ),
    );
    data.papers = data.papers.map((paper) => {
      if (paper.folderId) {
        const source = data.folders.find(
          (folder) => folder.id === paper.folderId,
        );
        if (source?.zoteroCollectionId) {
          const key = `${paper.id}:${source.id}:${source.zoteroCollectionId}`;
          if (!occurrenceKeys.has(key)) {
            data.sourceOccurrences.push({
              id: `source_${source.id}_${paper.id}_${source.zoteroCollectionId}`,
              paperId: paper.id,
              sourceId: source.id,
              collectionId: source.zoteroCollectionId,
              firstSeenAt: now,
              lastSeenAt: now,
            });
            occurrenceKeys.add(key);
          }
        }
      }
      const { folderId: _legacyFolderId, ...normalizedPaper } = paper;
      return {
        ...normalizedPaper,
        manualAdded: paper.manualAdded ?? !paper.folderId,
      };
    });
    if (!data.protocol) {
      data.protocol = createProtocolFromLegacy(
        data.framework,
        data.frameworkValues,
        data.incKeywords,
        data.excKeywords,
        data.picoLabelMap,
      );
    }
    applyProtocolCompatibility(data);
    return data;
  }

  private stringArray(value: unknown, fallback: string[]): string[] {
    return Array.isArray(value) &&
      value.every((item) => typeof item === "string")
      ? [...value]
      : [...fallback];
  }

  private stringRecord(
    value: unknown,
    fallback: Record<string, string>,
  ): Record<string, string> {
    if (!value || typeof value !== "object") return deepCopy(fallback);
    const entries = Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    );
    return entries.length > 0
      ? Object.fromEntries(entries)
      : deepCopy(fallback);
  }

  private stringArrayRecord(
    value: unknown,
    fallback: Record<string, string[]>,
  ): Record<string, string[]> {
    if (!value || typeof value !== "object") return deepCopy(fallback);
    const entries = Object.entries(value).filter(
      (entry): entry is [string, string[]] =>
        Array.isArray(entry[1]) &&
        entry[1].every((item) => typeof item === "string"),
    );
    return entries.length > 0
      ? Object.fromEntries(entries)
      : deepCopy(fallback);
  }
}

let store: SystematicReviewStore | null = null;

export function getSRStore(): SystematicReviewStore {
  if (!store) store = new SystematicReviewStore();
  return store;
}
