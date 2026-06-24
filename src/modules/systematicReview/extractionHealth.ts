import {
  ExtractionRow,
  PaperExtractionLog,
  ReviewJob,
  ReviewJobKind,
  ReviewJobPaper,
  SystematicReviewState,
} from "./types";

// Extraction, evidence synthesis, and gap analysis are stages of one pipeline:
// they all extract/refine the same per-paper evidence. Treat them as a single
// family wherever the UI tracks "is this paper being processed" or "what is the
// latest task" — filtering on "extraction" alone hides synthesis/gap progress.
export const EXTRACTION_PIPELINE_KINDS: ReviewJobKind[] = [
  "extraction",
  "evidence_analysis",
  "gap_analysis",
];

const ACTIVE_JOB_STATUSES = ["queued", "running", "paused"] as const;

export function isExtractionPipelineJob(job: ReviewJob): boolean {
  return EXTRACTION_PIPELINE_KINDS.includes(job.kind);
}

function sortByRecency(a: ReviewJob, b: ReviewJob): number {
  return (
    Date.parse(b.updatedAt || b.createdAt) -
    Date.parse(a.updatedAt || a.createdAt)
  );
}

/** Pipeline jobs that are still queued, running, or paused. */
export function getActivePipelineJobs(
  state: SystematicReviewState,
): ReviewJob[] {
  return state.reviewJobs.filter(
    (job) =>
      isExtractionPipelineJob(job) &&
      (ACTIVE_JOB_STATUSES as readonly string[]).includes(job.status),
  );
}

/**
 * The job a job-status strip should track: the most recently updated active
 * pipeline job, or — when none are active — the most recent pipeline job so the
 * strip can show the last completed/failed result.
 */
export function getLatestPipelineJob(
  state: SystematicReviewState,
): ReviewJob | undefined {
  const active = getActivePipelineJobs(state);
  if (active.length) return active.slice().sort(sortByRecency)[0];
  const all = state.reviewJobs.filter(isExtractionPipelineJob);
  if (!all.length) return undefined;
  return all.slice().sort(sortByRecency)[0];
}

/** The most recent per-paper task across every pipeline kind. */
export function getLatestPipelineTask(
  state: SystematicReviewState,
  paperId: number,
): ReviewJobPaper | undefined {
  return getLastExtractionJobForPaper(state, paperId);
}

export function getIncludedPapers(state: SystematicReviewState) {
  return state.papers.filter(
    (paper) =>
      paper.status === "included" &&
      (paper.screeningStage === "final" || !paper.screeningStage),
  );
}

export function getActiveExtractionTemplateOutcomes(
  state: SystematicReviewState,
): Array<{ id: string; name: string; required: boolean }> {
  const template = state.extractionTemplates.find(
    (candidate) => candidate.id === state.activeExtractionTemplateId,
  );
  if (!template) return [];
  return template.outcomes.map((outcome) => ({
    id: outcome.id,
    name: outcome.name,
    required: outcome.required,
  }));
}

export function getRowHasErrorIssue(row: ExtractionRow): boolean {
  return !!row.issues?.some((issue) => issue.severity === "error");
}

export function getRowErrorCount(row: ExtractionRow): number {
  return row.issues?.filter((issue) => issue.severity === "error").length || 0;
}

export function getMissingRequiredOutcomes(
  state: SystematicReviewState,
  paperId: number,
): Array<{ outcomeId?: string; name: string }> {
  const outcomes = getActiveExtractionTemplateOutcomes(state);
  if (!outcomes.length) return [];
  const rows = state.extractions[paperId] || [];
  const presentByOutcome = new Set<string>();
  rows.forEach((row) => {
    if (!row.outcomeId) return;
    if (row.verificationStatus === "rejected") return;
    if (!row.sourceQuote?.trim()) return;
    presentByOutcome.add(row.outcomeId);
  });
  return outcomes
    .filter((outcome) => outcome.required && !presentByOutcome.has(outcome.id))
    .map((outcome) => ({ outcomeId: outcome.id, name: outcome.name }));
}

export function hasFailedExtractionMetrics(
  state: SystematicReviewState,
  paperId: number,
): boolean {
  // A paper only counts as a genuine extraction failure (eligible for retry)
  // when its last job actually failed. Row-level quality flags (ungrounded
  // quotes, unrecognised measures) and missing-required outcomes are surfaced
  // in the extraction log for review but must NOT re-queue the paper — that is
  // what produced the endless retry loop on diagnostic/prognostic reviews.
  const lastJob = getLastExtractionJobForPaper(state, paperId);
  return lastJob?.stage === "failed";
}

export function getPapersNeedingExtraction(
  state: SystematicReviewState,
): number[] {
  return getIncludedPapers(state)
    .filter((paper) => {
      const rows = state.extractions[paper.id] || [];
      if (!rows.length) return true;
      if (hasFailedExtractionMetrics(state, paper.id)) return true;
      return false;
    })
    .map((paper) => paper.id);
}

export function getPapersWithFailedExtractions(
  state: SystematicReviewState,
): number[] {
  return getIncludedPapers(state)
    .filter((paper) => hasFailedExtractionMetrics(state, paper.id))
    .map((paper) => paper.id);
}

export function getLastExtractionJobForPaper(
  state: SystematicReviewState,
  paperId: number,
) {
  const candidates = state.reviewJobs
    .filter(
      (job) =>
        isExtractionPipelineJob(job) &&
        job.papers.some((p) => p.paperId === paperId),
    )
    .sort(sortByRecency);
  if (!candidates.length) return undefined;
  const job = candidates[0];
  return job.papers.find((p) => p.paperId === paperId);
}

export function collectPaperExtractionLog(
  state: SystematicReviewState,
  paperId: number,
): PaperExtractionLog {
  const rows = state.extractions[paperId] || [];
  const missing = getMissingRequiredOutcomes(state, paperId);
  const jobPaper = getLastExtractionJobForPaper(state, paperId);
  const rowIssues = rows.flatMap((row) =>
    (row.issues || []).map((issue) => ({
      ...issue,
      source: "row" as const,
      rowId: row.id,
      outcome: row.outcome,
      effectType: row.effectType,
    })),
  );
  const sourceWarnings = jobPaper?.sourceSummary?.warnings || [];
  return {
    paperId,
    jobError: jobPaper?.error,
    sourceKind: jobPaper?.sourceSummary?.kind,
    sourceWarnings,
    rowIssues,
    missingOutcomes: missing,
    collectedAt: new Date().toISOString(),
  };
}
