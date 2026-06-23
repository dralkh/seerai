import { isPoolableMeasure } from "./measures";
import { validateExtractionRow } from "./scientific";
import {
  ExtractionCompatibilityIssue,
  ExtractionCompatibilityReport,
  ExtractionRow,
  ExtractionTemplate,
  SystematicReviewPaper,
} from "./types";

export interface CompatibleExtractionGroup {
  key: string;
  rows: ExtractionRow[];
  paperIds: number[];
  rowIndexes: number[];
  excludedRows: ExtractionCompatibilityIssue[];
}

export interface ExtractionCompatibilityResult {
  groups: Map<string, CompatibleExtractionGroup>;
  report: ExtractionCompatibilityReport;
}

function normalizeKey(value?: string): string {
  return (value || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function rowGroupKey(
  row: ExtractionRow,
  template?: ExtractionTemplate,
): string {
  const outcome = row.outcomeId
    ? template?.outcomes.find((candidate) => candidate.id === row.outcomeId)
    : undefined;
  const keepTimepoint = !!outcome?.timepoints.length;
  const keepUnit = !!outcome?.unit?.trim();
  return [
    row.outcomeId || normalizeKey(row.outcome),
    row.effectType,
    keepTimepoint ? normalizeKey(row.timepoint) : "",
    keepUnit ? normalizeKey(row.unit) : "",
  ].join("|");
}

function rowScore(row: ExtractionRow): number {
  return [
    row.sourceQuote?.trim() ? 8 : 0,
    Number.isFinite(row.effectSize) ? 4 : 0,
    Number.isFinite(row.ciLow) && Number.isFinite(row.ciHigh) ? 4 : 0,
    Number.isInteger(row.n) ? 2 : 0,
    Number.isInteger(row.events) ? 1 : 0,
    row.confidence ?? 0,
  ].reduce((sum, value) => sum + value, 0);
}

function issue(
  paperId: number,
  row: ExtractionRow,
  severity: "warning" | "blocker",
  reason: string,
): ExtractionCompatibilityIssue {
  return {
    paperId,
    rowId: row.id,
    outcome: row.outcome,
    measure: row.effectType,
    severity,
    reason,
  };
}

export function buildExtractionCompatibility(
  papers: SystematicReviewPaper[],
  extractions: Record<number, ExtractionRow[]>,
  template?: ExtractionTemplate,
): ExtractionCompatibilityResult {
  const included = papers.filter(
    (paper) =>
      paper.status === "included" &&
      (paper.screeningStage === "final" || !paper.screeningStage),
  );
  const buckets = new Map<
    string,
    Array<{ row: ExtractionRow; paperId: number; rowIndex: number }>
  >();
  const issues: ExtractionCompatibilityIssue[] = [];
  let incompletePoolableRows = 0;

  for (const paper of included) {
    (extractions[paper.id] || []).forEach((row, rowIndex) => {
      if (row.verificationStatus !== "verified") return;
      if (row.issues?.some((candidate) => candidate.severity === "error")) {
        issues.push(
          issue(paper.id, row, "blocker", "Row has blocking validation issues"),
        );
        return;
      }
      if (!row.sourceQuote?.trim()) {
        issues.push(
          issue(paper.id, row, "blocker", "Verified row has no source quote"),
        );
        return;
      }
      const validation = validateExtractionRow(row);
      if (!validation.valid) {
        if (isPoolableMeasure(row.effectType)) incompletePoolableRows++;
        issues.push(
          issue(paper.id, row, "blocker", validation.errors.join("; ")),
        );
        return;
      }
      const key = rowGroupKey(row, template);
      const bucket = buckets.get(key) || [];
      bucket.push({ row, paperId: paper.id, rowIndex });
      buckets.set(key, bucket);
    });
  }

  const groups = new Map<string, CompatibleExtractionGroup>();
  let duplicateRows = 0;
  for (const [key, bucket] of buckets) {
    const byPaper = new Map<
      number,
      Array<{ row: ExtractionRow; paperId: number; rowIndex: number }>
    >();
    for (const entry of bucket) {
      const entries = byPaper.get(entry.paperId) || [];
      entries.push(entry);
      byPaper.set(entry.paperId, entries);
    }

    const group: CompatibleExtractionGroup = {
      key,
      rows: [],
      paperIds: [],
      rowIndexes: [],
      excludedRows: [],
    };
    for (const [paperId, entries] of byPaper) {
      const sorted = [...entries].sort(
        (a, b) => rowScore(b.row) - rowScore(a.row),
      );
      const [best, ...duplicates] = sorted;
      group.rows.push(best.row);
      group.paperIds.push(paperId);
      group.rowIndexes.push(best.rowIndex);
      for (const duplicate of duplicates) {
        duplicateRows++;
        const duplicateIssue = issue(
          paperId,
          duplicate.row,
          "warning",
          "Duplicate row for the same paper/domain was excluded from synthesis",
        );
        group.excludedRows.push(duplicateIssue);
        issues.push(duplicateIssue);
      }
    }
    groups.set(key, group);
  }

  let compatibleDomains = 0;
  let blockedDomains = 0;
  let narrativeReadyDomains = 0;
  for (const group of groups.values()) {
    if (isPoolableMeasure(group.rows[0]?.effectType)) {
      if (group.rows.length >= 2) compatibleDomains++;
      else blockedDomains++;
    } else {
      narrativeReadyDomains++;
    }
  }

  return {
    groups,
    report: {
      includedRows: Array.from(groups.values()).reduce(
        (sum, group) => sum + group.rows.length,
        0,
      ),
      excludedRows: issues.length,
      compatibleDomains,
      blockedDomains,
      incompletePoolableRows,
      duplicateRows,
      narrativeReadyDomains,
      issues,
    },
  };
}
