/**
 * Type definitions for Systematic Review tab
 *
 * Mirrors the HTML preview's data model for full compatibility
 *
 * ## Per-space vs Global state
 *
 * Per-space (stored in SystematicReviewSpace):
 *   - framework, frameworkValues (criteria)
 *   - incKeywords, excKeywords
 *   - picoLabelMap
 *   - activeFolderId
 *   - paperStatus (screening decisions)
 *
 * Global (shared across all spaces):
 *   - papers (paper pool with current status)
 *   - folders, selectedFolderIds (source configs)
 *   - extractions, robData (data extraction)
 *   - paperLabels, labelDefs (labeling)
 *   - evidenceDomains, gaps (analysis results)
 *   - synthesisEdits, gapEdits (user edits)
 */

import type { ReviewCancellationSignal } from "./cancellation";
import type { SearchQueryIR } from "../search/queryIR";
import type { ScholarlySearchMode } from "../search/types";

export type SRSubTab =
  | "screening"
  | "evidence"
  | "gaps"
  | "prisma"
  | "extraction"
  | "methodology";

export type ScreeningDecision = "undecided" | "included" | "maybe" | "excluded";
export type ScreeningStage = "title_abstract" | "full_text" | "final";

export interface ScreeningEvent {
  id: string;
  stage: ScreeningStage;
  decision: ScreeningDecision;
  actor: "user" | "model" | "automation";
  reason?: string;
  confidence?: number;
  modelRunId?: string;
  confirmed: boolean;
  createdAt: string;
}

export interface ScreeningReason {
  paperId: number;
  reason: string;
  note: string;
  decidedAt: string;
}

export interface SystematicReviewPaper {
  id: number; // Zotero item ID
  status: ScreeningDecision;
  screeningStage?: ScreeningStage;
  screeningEvents?: ScreeningEvent[];
  aiStatus: "auto" | "manual";
  confidence: number; // 0-1
  modelConfidence?: number;
  keywordConfidence?: number;
  sourcePreference?: "auto" | "pdf" | "same_title_note" | "notes" | "abstract";
  recommendation?: {
    decision: ScreeningDecision;
    confidence: number;
    rationale: string;
    source: "keyword" | "model";
    createdAt: string;
    protocolRevisionId?: string;
    sourceSummary?: ReviewSourceSummary;
    criteria?: {
      criterionId: string;
      verdict: "met" | "not_met" | "unclear";
      rationale: string;
      quote?: string;
      confidence?: number;
    }[];
  };
  analysis?: {
    studyDesign?: string;
    population?: string;
    intervention?: string;
    comparator?: string;
    outcomes?: string[];
    sampleSize?: number;
    methods?: string;
    limitations?: string;
    evidence: { field: string; quote: string }[];
    model: string;
    createdAt: string;
    protocolRevisionId?: string;
    sourceSummary?: ReviewSourceSummary;
  };
  exclReason?: string;
  note?: string;
  folderId?: string;
  manualAdded: boolean;
  sourceLabel?: string;
  sourceType?: "Database" | "Register" | "Other source";
  bias?: "Low" | "Some concerns" | "High" | "Unclear";
  design?: string; // Study design (RCT, Cohort, Review, etc.)
  ev?: string; // Evidence level (Strong, Moderate, Weak)
  sample?: number; // Sample size
  methods?: string; // Methods description
  pop?: string; // Population description
  lim?: string; // Limitations
}

export interface SystematicReviewSpace {
  id: string;
  name: string;
  protocol: ReviewProtocol;
  framework: string;
  frameworkValues: Record<string, string>;
  incKeywords: string[];
  excKeywords: string[];
  picoLabelMap: Record<string, string[]>;
  activeFolderId: string;
  paperStatus: Record<number, ScreeningDecision>;
  createdAt?: string;
  updatedAt?: string;
  data?: SystematicReviewProjectData;
}

export interface ProtocolProvenance {
  field: string;
  source: string;
  quote?: string;
  confidence?: number;
}

export interface ProtocolDimension {
  key: string;
  label: string;
  description: string;
  value: string;
  keywordAids: string[];
  evidenceLabels: string[];
}

export interface EligibilityRule {
  id: string;
  type: "include" | "exclude";
  text: string;
  dimensionKey?: string;
}

export interface ProtocolRevision {
  id: string;
  createdAt: string;
  actor: "user" | "model" | "migration";
  model?: string;
  researchQuestion: string;
  framework: string;
  frameworkReason?: string;
  dimensions: ProtocolDimension[];
  eligibilityRules: EligibilityRule[];
  includeKeywordAids: string[];
  excludeKeywordAids: string[];
  provenance: ProtocolProvenance[];
  warnings: string[];
  searchStrategy?: SearchStrategyProposal;
}

export interface ReviewProtocol {
  activeRevisionId: string;
  revisions: ProtocolRevision[];
}

export interface SRUIState {
  filterEnabled: string[];
  filterOpen: string[];
  activeFilters: Record<string, string[]>;
  gapSeverityFilter?: "all" | "high" | "medium" | "low";
}

export interface SRFolderConfig {
  id: string;
  name: string;
  parent: string;
  type: "Database" | "Register" | "Other source";
  srcLabel: string;
  itemCount: number;
  active: boolean;
  zoteroCollectionId?: number;
  zoteroLibraryId?: number;
  parentCollectionId?: number;
  collectionPath?: string;
  includeSubfolders: boolean;
  available: boolean;
  lastSyncedAt?: string;
}

export interface SourceOccurrence {
  id: string;
  paperId: number;
  sourceId: string;
  collectionId: number;
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface SourceSyncRecord {
  paperId: number;
  collectionId: number;
}

export interface SourceSyncInput {
  source: SRFolderConfig;
  records: SourceSyncRecord[];
}

export interface SourceSyncResult {
  addedPapers: number[];
  removedPapers: number[];
  addedOccurrences: number;
  removedOccurrences: number;
  retainedOccurrences: number;
  overlappingPapers: number[];
  warnings: string[];
}

export interface ZoteroCollectionTreeNode {
  id: number;
  libraryId: number;
  name: string;
  path: string;
  parentId?: number;
  directItemCount: number;
  children: ZoteroCollectionTreeNode[];
}

export interface ZoteroLibraryTree {
  id: number;
  name: string;
  type: "user" | "group";
  collections: ZoteroCollectionTreeNode[];
}

export const EXCL_REASONS = [
  "Wrong population",
  "Wrong intervention/exposure",
  "Wrong outcome",
  "Wrong study design",
  "Wrong publication type",
  "Duplicate",
  "Non-English language",
  "Insufficient data",
  "Full text unavailable",
  "Other",
];

export const FRAMEWORK_DEFS: Record<
  string,
  {
    label: string;
    fields: { k: string; label: string; hint: string; icon: string }[];
  }
> = {
  PICOTS: {
    label: "PICOTS",
    fields: [
      {
        k: "P",
        label: "Population",
        hint: "Target population: age, condition, demographics",
        icon: "p",
      },
      {
        k: "I",
        label: "Intervention",
        hint: "Intervention, exposure, or diagnostic test",
        icon: "i",
      },
      {
        k: "C",
        label: "Comparison",
        hint: "Comparator: standard care, placebo, alternative",
        icon: "c",
      },
      {
        k: "O",
        label: "Outcome",
        hint: "Outcomes measured. Be specific about endpoints",
        icon: "o",
      },
      {
        k: "T",
        label: "Timeframe",
        hint: "Time period or duration of interest",
        icon: "t",
      },
      {
        k: "S",
        label: "Study Design",
        hint: "Study designs to include (RCT, cohort, etc.)",
        icon: "s",
      },
    ],
  },
  PICO: {
    label: "PICO",
    fields: [
      { k: "P", label: "Population", hint: "Target population", icon: "p" },
      {
        k: "I",
        label: "Intervention",
        hint: "Intervention or exposure",
        icon: "i",
      },
      { k: "C", label: "Comparison", hint: "Comparator", icon: "c" },
      { k: "O", label: "Outcome", hint: "Outcomes measured", icon: "o" },
    ],
  },
  PICOS: {
    label: "PICOS",
    fields: [
      { k: "P", label: "Population", hint: "Target population", icon: "p" },
      { k: "I", label: "Intervention", hint: "Intervention", icon: "i" },
      { k: "C", label: "Comparison", hint: "Comparator", icon: "c" },
      { k: "O", label: "Outcome", hint: "Outcomes", icon: "o" },
      {
        k: "S",
        label: "Study Design",
        hint: "Study designs to include",
        icon: "s",
      },
    ],
  },
  PICOT: {
    label: "PICOT",
    fields: [
      { k: "P", label: "Population", hint: "Target population", icon: "p" },
      { k: "I", label: "Intervention", hint: "Intervention", icon: "i" },
      { k: "C", label: "Comparison", hint: "Comparator", icon: "c" },
      { k: "O", label: "Outcome", hint: "Outcomes", icon: "o" },
      {
        k: "T",
        label: "Timeframe",
        hint: "Time period of interest",
        icon: "t",
      },
    ],
  },
  PICOTT: {
    label: "PICOTT",
    fields: [
      { k: "P", label: "Population", hint: "Target population", icon: "p" },
      { k: "I", label: "Intervention", hint: "Intervention", icon: "i" },
      { k: "C", label: "Comparison", hint: "Comparator", icon: "c" },
      { k: "O", label: "Outcome", hint: "Outcomes", icon: "o" },
      {
        k: "T",
        label: "Type of Question",
        hint: "Therapy, diagnosis, prognosis, harm",
        icon: "t",
      },
      { k: "S", label: "Type of Study", hint: "Study design type", icon: "s" },
    ],
  },
  PECO: {
    label: "PECO",
    fields: [
      { k: "P", label: "Population", hint: "Target population", icon: "p" },
      { k: "E", label: "Exposure", hint: "Risk factor or exposure", icon: "e" },
      {
        k: "C",
        label: "Comparison",
        hint: "Unexposed or alternative",
        icon: "c",
      },
      { k: "O", label: "Outcome", hint: "Health outcomes", icon: "o" },
    ],
  },
  PICo: {
    label: "PICo",
    fields: [
      { k: "P", label: "Population", hint: "Target population", icon: "p" },
      {
        k: "PI",
        label: "Phenomenon of Interest",
        hint: "The experience or phenomenon",
        icon: "pi",
      },
      {
        k: "Co",
        label: "Context",
        hint: "Setting, cultural factors",
        icon: "co",
      },
    ],
  },
  PEO: {
    label: "PEO",
    fields: [
      { k: "P", label: "Population", hint: "Target population", icon: "p" },
      { k: "E", label: "Exposure", hint: "Exposure or experience", icon: "e" },
      { k: "O", label: "Outcome", hint: "Outcomes or themes", icon: "o" },
    ],
  },
  SPIDER: {
    label: "SPIDER",
    fields: [
      { k: "S", label: "Sample", hint: "Sample population", icon: "s" },
      {
        k: "PI",
        label: "Phenomenon of Interest",
        hint: "The phenomenon being studied",
        icon: "pi",
      },
      { k: "D", label: "Design", hint: "Study design", icon: "d" },
      { k: "Ev", label: "Evaluation", hint: "Evaluation methods", icon: "ev" },
      {
        k: "R",
        label: "Research Type",
        hint: "Qualitative, mixed-methods, etc.",
        icon: "r",
      },
    ],
  },
  SPICE: {
    label: "SPICE",
    fields: [
      {
        k: "Se",
        label: "Setting",
        hint: "Where the study takes place",
        icon: "se",
      },
      { k: "Pe", label: "Perspective", hint: "Whose perspective", icon: "pe" },
      {
        k: "I",
        label: "Intervention",
        hint: "Intervention or phenomenon",
        icon: "i",
      },
      { k: "C", label: "Comparison", hint: "Comparator", icon: "c" },
      {
        k: "Ev",
        label: "Evaluation",
        hint: "How outcomes are measured",
        icon: "ev",
      },
    ],
  },
  PCC: {
    label: "PCC",
    fields: [
      { k: "P", label: "Population", hint: "Target population", icon: "p" },
      {
        k: "Ca",
        label: "Concept",
        hint: "Core concept being examined",
        icon: "ca",
      },
      {
        k: "Co",
        label: "Context",
        hint: "Setting or circumstances",
        icon: "co",
      },
    ],
  },
};

export interface ExtractionRow {
  id?: string;
  outcomeId?: string;
  outcome: string;
  effectType: string;
  effectSize?: number;
  ciLow?: number;
  ciHigh?: number;
  n?: number;
  events?: number;
  timepoint?: string;
  unit?: string;
  interventionArm?: string;
  comparatorArm?: string;
  direction?: "higher_better" | "lower_better";
  sourceAttachmentId?: number;
  sourcePage?: string;
  sourceQuote?: string;
  verificationStatus?: "proposed" | "verified" | "rejected";
  confidence?: number;
  missingReason?: string;
  model?: string;
  jobId?: string;
  templateRevisionId?: string;
  revision?: number;
  updatedAt?: string;
  issues?: ExtractionIssue[];
  sourceFingerprint?: string;
}

export interface ExtractionIssue {
  code: string;
  severity: "warning" | "error";
  field?: string;
  message: string;
  rawValue?: string;
}

export interface ReviewSourceSummary {
  kind: "pdf" | "same_title_note" | "notes" | "abstract";
  attachmentId?: number;
  noteIds: number[];
  totalCharacters: number;
  suppliedCharacters: number;
  truncated: boolean;
  fingerprint: string;
  warnings: string[];
}

export interface ExtractionLogEntry {
  code: string;
  severity: "warning" | "error";
  source: "job" | "source" | "row" | "missing_outcome" | "validation";
  field?: string;
  message: string;
  rawValue?: string;
}

export interface PaperExtractionLog {
  paperId: number;
  jobError?: string;
  sourceKind?: ReviewSourceSummary["kind"];
  sourceWarnings: string[];
  rowIssues: Array<
    ExtractionLogEntry & {
      rowId?: string;
      outcome?: string;
      effectType?: string;
    }
  >;
  missingOutcomes: Array<{ outcomeId?: string; name: string }>;
  collectedAt: string;
}

export interface ExtractionOutcomeDefinition {
  id: string;
  name: string;
  aliases: string[];
  description: string;
  measures: ("OR" | "RR" | "HR" | "MD" | "SMD")[];
  timepoints: string[];
  unit?: string;
  direction?: "higher_better" | "lower_better";
  required: boolean;
}

export interface ExtractionTemplate {
  id: string;
  revisionId: string;
  protocolRevisionId: string;
  name: string;
  instructions: string;
  outcomes: ExtractionOutcomeDefinition[];
  status: "draft" | "active" | "archived";
  source: "user" | "model" | "migration";
  model?: string;
  createdAt: string;
  updatedAt: string;
}

export type ReviewJobKind =
  | "analysis"
  | "extraction"
  | "evidence_analysis"
  | "gap_analysis";
export type ReviewJobStatus =
  | "queued"
  | "running"
  | "paused"
  | "completed"
  | "completed_with_issues"
  | "failed"
  | "cancelled"
  | "interrupted";

export type ReviewJobPaperStage =
  | "queued"
  | "reading_source"
  | "extracting"
  | "validating"
  | "saving"
  | "synthesizing"
  | "analyzing_gaps"
  | "completed"
  | "failed"
  | "cancelled";

export interface ReviewJobPaper {
  paperId: number;
  stage: ReviewJobPaperStage;
  attempts: number;
  evidenceCount?: number;
  proposalCount?: number;
  issueCount?: number;
  sourceSummary?: ReviewSourceSummary;
  error?: string;
  startedAt?: string;
  completedAt?: string;
}

export interface ReviewJob {
  id: string;
  kind: ReviewJobKind;
  projectId: string;
  protocolRevisionId: string;
  templateRevisionId?: string;
  status: ReviewJobStatus;
  paperIds: number[];
  papers: ReviewJobPaper[];
  concurrency: number;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  error?: string;
  synthesisRunId?: string;
  gapAnalysisRunId?: string;
}

export interface RoBAssessment {
  randomization: "not_assessed" | "low" | "some" | "high";
  deviations: "not_assessed" | "low" | "some" | "high";
  missing: "not_assessed" | "low" | "some" | "high";
  measurement: "not_assessed" | "low" | "some" | "high";
  selective: "not_assessed" | "low" | "some" | "high";
  instrument?: "rob2" | "robins_i" | "quadas2" | "casP" | "amstar2";
  rationale?: string;
  sourceQuote?: string;
  verificationStatus?: "proposed" | "verified";
  updatedAt?: string;
}

export interface LabelDefinition {
  k: string;
  name: string;
  color: string;
  bg: string;
}

export const DEFAULT_LABELS: LabelDefinition[] = [
  { k: "rct", name: "RCT", color: "#16a34a", bg: "#dcfce7" },
  { k: "meta", name: "Meta-analysis", color: "#7c3aed", bg: "#ede9fe" },
  { k: "cohort", name: "Cohort", color: "#d97706", bg: "#fef3c7" },
  { k: "ml", name: "ML/AI", color: "#0891b2", bg: "#cffafe" },
  { k: "biomarker", name: "Biomarker", color: "#db2777", bg: "#fce7f3" },
  { k: "genetic", name: "Genetic", color: "#4f46e5", bg: "#e0e7ff" },
  { k: "guideline", name: "Guideline", color: "#059669", bg: "#d1fae5" },
  { k: "review", name: "Review", color: "#ea580c", bg: "#fff7ed" },
  { k: "core", name: "Core Paper", color: "#2563eb", bg: "#dbeafe" },
  { k: "follow", name: "Follow-up", color: "#9333ea", bg: "#fae8ff" },
];

export interface EvidenceDomain {
  id: string;
  outcome: string;
  strength: "high" | "moderate" | "low" | "verylow";
  direction: "positive" | "mixed" | "none";
  studyCount: number;
  summary: string;
  contributing: number[];
}

export interface GapMatrixCell {
  population: string;
  intervention: string;
  studyCount: number;
  severity: "empty" | "sparse" | "populated";
}

export interface GapDetail {
  id: string;
  title: string;
  severity: "high" | "medium" | "low";
  picosTags: string[];
  reasonCode: "A" | "B" | "C" | "D";
  description: string;
  implication: string;
}

export type AnalysisRunStatus =
  | "draft"
  | "confirmed"
  | "stale"
  | "failed"
  | "needs_ai";

export interface SynthesisStudyEstimate {
  extractionId: string;
  paperId: number;
  outcome: string;
  measure: string;
  estimate: number;
  ciLow: number;
  ciHigh: number;
  weight?: number;
  timepoint?: string;
  unit?: string;
  sourceQuote?: string;
  sourcePage?: string;
}

export interface GradeJudgment {
  certainty: "high" | "moderate" | "low" | "verylow" | "not_applicable";
  riskOfBias: 0 | -1 | -2;
  inconsistency: 0 | -1 | -2;
  indirectness: 0 | -1 | -2;
  imprecision: 0 | -1 | -2;
  publicationBias: 0 | -1 | -2;
  upgrade: 0 | 1 | 2;
  rationale: string[];
  confirmed: boolean;
}

export interface SynthesisDomainResult {
  id: string;
  key: string;
  outcome: string;
  population?: string;
  intervention?: string;
  comparator?: string;
  timepoint?: string;
  measure?: string;
  method: "common_effect" | "random_effects" | "narrative";
  status: "poolable" | "not_poolable" | "narrative";
  studies: SynthesisStudyEstimate[];
  paperIds: number[];
  direction: "positive" | "mixed" | "none" | "unclear";
  summary: string;
  nonPoolableReasons: string[];
  commonEffect?: MetaAnalysisSummary;
  randomEffects?: MetaAnalysisSummary;
  selectedModel?: "common_effect" | "random_effects" | "narrative";
  methodConfirmed: boolean;
  grade: GradeJudgment;
  narrativeConfirmed: boolean;
}

export interface MetaAnalysisSummary {
  estimate: number;
  ciLow: number;
  ciHigh: number;
  predictionLow?: number;
  predictionHigh?: number;
  q: number;
  i2: number;
  tau2: number;
  weights: number[];
}

export interface SynthesisRun {
  id: string;
  projectId: string;
  protocolRevisionId: string;
  inputFingerprint: string;
  includedPaperIds: number[];
  createdAt: string;
  updatedAt: string;
  status: AnalysisRunStatus;
  staleReasons: string[];
  warnings: string[];
  model?: string;
  domains: SynthesisDomainResult[];
}

export type GapCellStatus =
  | "no_evidence"
  | "sparse"
  | "low_certainty"
  | "conflicting"
  | "indirect"
  | "adequate"
  | "not_applicable";

export interface GapMapCell {
  id: string;
  rowKey: string;
  rowValue: string;
  columnKey: string;
  columnValue: string;
  status: GapCellStatus;
  domainIds: string[];
  paperIds: number[];
  studyCount: number;
  rationale: string;
}

export interface GapCandidate {
  id: string;
  canonicalKey: string;
  title: string;
  severity: "high" | "medium" | "low";
  reasonCode: "insufficient" | "biased" | "inconsistent" | "indirect";
  dimensionTags: string[];
  description: string;
  implication: string;
  domainIds: string[];
  paperIds: number[];
  status: "draft" | "accepted" | "rejected" | "ignored";
  reviewerNote?: string;
  updatedAt: string;
}

export interface GapAnalysisRun {
  id: string;
  projectId: string;
  synthesisRunId: string;
  inputFingerprint: string;
  createdAt: string;
  updatedAt: string;
  status: AnalysisRunStatus;
  rowDimensionKey: string;
  columnDimensionKey: string;
  cells: GapMapCell[];
  gaps: GapCandidate[];
  warnings: string[];
}

export interface ReviewAnalysisSettings {
  automation: "auto_draft" | "manual";
  sparseStudyThreshold: number;
}

export interface SystematicReviewProjectData {
  activeSubTab: SRSubTab;
  folders: SRFolderConfig[];
  selectedFolderIds: string[];
  sourceOccurrences: SourceOccurrence[];
  papers: SystematicReviewPaper[];
  extractionTemplates: ExtractionTemplate[];
  activeExtractionTemplateId?: string;
  reviewJobs: ReviewJob[];
  extractions: Record<number, ExtractionRow[]>;
  robData: Record<number, RoBAssessment>;
  paperLabels: Record<number, string[]>;
  labelDefs: LabelDefinition[];
  incKeywords: string[];
  excKeywords: string[];
  framework: string;
  frameworkValues: Record<string, string>;
  picoLabelMap: Record<string, string[]>;
  protocol: ReviewProtocol;
  activeFolderId: string;
  evidenceDomains: EvidenceDomain[];
  gaps: GapDetail[];
  synthesisRuns: SynthesisRun[];
  activeSynthesisRunId?: string;
  gapAnalysisRuns: GapAnalysisRun[];
  activeGapAnalysisRunId?: string;
  analysisSettings: ReviewAnalysisSettings;
  synthesisEdits: Record<string, { grade?: string; narrative?: string }>;
  gapEdits: Record<
    string,
    { status?: "accepted" | "rejected" | "ignored"; note?: string }
  >;
  srUIState: SRUIState;
  scrFilter: string;
  scrSort: string;
  scrSearch: string;
  scrSelected: number[];
  quickSkip: boolean;
  kwFilterActive: boolean;
  kwFilterKeyword: string | null;
}

export interface SystematicReviewState {
  activeSubTab: SRSubTab;
  activeSpaceId: string;
  spaces: SystematicReviewSpace[];
  folders: SRFolderConfig[];
  selectedFolderIds: string[];
  sourceOccurrences: SourceOccurrence[];
  papers: SystematicReviewPaper[];
  extractionTemplates: ExtractionTemplate[];
  activeExtractionTemplateId?: string;
  reviewJobs: ReviewJob[];
  extractions: Record<number, ExtractionRow[]>;
  robData: Record<number, RoBAssessment>;
  paperLabels: Record<number, string[]>;
  labelDefs: LabelDefinition[];
  protocol: ReviewProtocol;
  incKeywords: string[];
  excKeywords: string[];
  framework: string;
  frameworkValues: Record<string, string>;
  evidenceDomains: EvidenceDomain[];
  gaps: GapDetail[];
  synthesisRuns: SynthesisRun[];
  activeSynthesisRunId?: string;
  gapAnalysisRuns: GapAnalysisRun[];
  activeGapAnalysisRunId?: string;
  analysisSettings: ReviewAnalysisSettings;
  synthesisEdits: Record<string, { grade?: string; narrative?: string }>;
  gapEdits: Record<
    string,
    { status?: "accepted" | "rejected" | "ignored"; note?: string }
  >;
  srUIState: SRUIState;
  scrFilter: string;
  scrSort: string;
  scrSearch: string;
  scrSelected: number[];
  quickSkip: boolean;
  kwFilterActive: boolean;
  kwFilterKeyword: string | null;
}

export type ProtocolGenerationStep =
  | "scope"
  | "eligibility"
  | "mapping"
  | "template"
  | "search-strategy";

export type ProtocolGenerationStatus =
  | "idle"
  | "running"
  | "complete"
  | "error";

export interface ScopeProposal {
  researchQuestion: string;
  framework: string;
  frameworkReason: string;
  dimensions: ProtocolDimension[];
  warnings: string[];
  provenance: ProtocolProvenance[];
}

export interface EligibilityProposal {
  inclusionRules: string[];
  exclusionRules: string[];
  includeKeywordAids: string[];
  excludeKeywordAids: string[];
  dimensionKeywordAids: Record<string, string[]>;
}

export interface MappingProposal {
  evidenceLabels: Record<string, string[]>;
}

export interface SearchStrategyProposal {
  ir: SearchQueryIR;
  recommendedMode: ScholarlySearchMode;
  rationale?: string;
  warnings: string[];
  provenance: ProtocolProvenance[];
}

export interface ProtocolGenerationResult {
  scope: ScopeProposal;
  eligibility: EligibilityProposal;
  mapping: MappingProposal;
  template: ExtractionTemplate;
  searchStrategy?: SearchStrategyProposal;
  summary: {
    scope?: string;
    eligibility?: string;
    mapping?: string;
    template?: string;
    searchStrategy?: string;
  };
  errors: Partial<Record<ProtocolGenerationStep, string>>;
}

export type LlmChatCompletion = (
  messages: { role: "system" | "user" | "assistant"; content: string }[],
  options?: {
    signal?: ReviewCancellationSignal;
    timeoutMs?: number;
    isolated?: boolean;
  },
) => Promise<string>;

export interface ProtocolGenerationContext {
  baselineRevision?: ProtocolRevision;
  baselineTemplate?: ExtractionTemplate;
  /**
   * When set, only these steps are (re)generated by the LLM; every other step
   * keeps its baseline value so it still provides context. Omitted = all steps.
   */
  steps?: ProtocolGenerationStep[];
}
