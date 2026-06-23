import {
  ExtractionRow,
  PaperExtractionLog,
  SystematicReviewState,
} from "./types";
import { getSRService } from "./service";

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
  const template = getSRService().getExtractionTemplate(state);
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
        (job.kind === "extraction" ||
          job.kind === "evidence_analysis" ||
          job.kind === "gap_analysis") &&
        job.papers.some((p) => p.paperId === paperId),
    )
    .sort(
      (a, b) =>
        Date.parse(b.updatedAt || b.createdAt) -
        Date.parse(a.updatedAt || a.createdAt),
    );
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
