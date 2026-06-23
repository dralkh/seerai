import { ExtractionRow, SystematicReviewState } from "./types";
import { classifyMeasure } from "./measures";

export type RatioMeasure = "OR" | "RR" | "HR";
export type SupportedMeasure = RatioMeasure | "MD" | "SMD";

export interface ExtractionValidation {
  valid: boolean;
  errors: string[];
}

export interface MetaAnalysisResult {
  measure: SupportedMeasure;
  estimate: number;
  ciLow: number;
  ciHigh: number;
  q: number;
  i2: number;
  studyCount: number;
  weights: number[];
}

export interface PrismaSnapshot {
  identified: number;
  screened: number;
  excluded: number;
  maybe: number;
  included: number;
  duplicates: number | null;
  sought: number | null;
  notRetrieved: number | null;
  fullTextExcluded: number | null;
  complete: boolean;
  missing: string[];
}

export function validateExtractionRow(
  row: ExtractionRow,
  requireComplete = true,
): ExtractionValidation {
  const errors: string[] = [];
  if (!row.outcome.trim()) errors.push("Outcome is required");
  const info = classifyMeasure(row.effectType);
  if (info.family === "other") {
    errors.push("A recognized effect or performance measure is required");
  }
  const hasEffect = Number.isFinite(row.effectSize);
  const hasLow = Number.isFinite(row.ciLow);
  const hasHigh = Number.isFinite(row.ciHigh);
  const hasAnyValue = [
    row.effectSize,
    row.ciLow,
    row.ciHigh,
    row.n,
    row.events,
  ].some((value) => value !== undefined);

  if (!info.poolable) {
    // Diagnostic / prognostic / proportion measures are recognised and retained
    // but never pooled, so they only need one quantitative value plus basic
    // sanity — not a full effect size with both confidence-interval bounds.
    if (info.family !== "other" && !hasAnyValue) {
      errors.push("Enter at least one quantitative value");
    }
    if (
      hasEffect &&
      hasLow &&
      hasHigh &&
      (row.ciLow! > row.effectSize! || row.effectSize! > row.ciHigh!)
    ) {
      errors.push("Confidence interval must contain the effect estimate");
    }
    if (row.n !== undefined && (!Number.isInteger(row.n) || row.n < 0)) {
      errors.push("Sample size must be a non-negative integer");
    }
    if (
      row.events !== undefined &&
      (!Number.isInteger(row.events) || row.events < 0)
    ) {
      errors.push("Events must be a non-negative integer");
    }
    if (row.events !== undefined && row.n !== undefined && row.events > row.n) {
      errors.push("Events cannot exceed sample size");
    }
    return { valid: errors.length === 0, errors };
  }

  if (!requireComplete && !hasAnyValue) {
    errors.push("Enter at least one quantitative value");
  }
  if (requireComplete && !hasEffect) errors.push("Effect size is required");
  if (requireComplete && (!hasLow || !hasHigh)) {
    errors.push("Both confidence interval bounds are required");
  } else if (hasEffect && hasLow && hasHigh && row.ciLow! > row.effectSize!) {
    errors.push("Confidence interval must contain the effect estimate");
  } else if (hasEffect && hasLow && hasHigh && row.effectSize! > row.ciHigh!) {
    errors.push("Confidence interval must contain the effect estimate");
  }
  if (
    info.family === "ratio" &&
    ((hasEffect && row.effectSize! <= 0) ||
      (hasLow && row.ciLow! <= 0) ||
      (hasHigh && row.ciHigh! <= 0))
  ) {
    errors.push("Ratio measures and intervals must be greater than zero");
  }
  if (requireComplete && !Number.isInteger(row.n)) {
    errors.push("Sample size is required");
  } else if (row.n !== undefined && (!Number.isInteger(row.n) || row.n < 0)) {
    errors.push("Sample size must be a non-negative integer");
  }
  const eventsRequired = info.canonical === "OR" || info.canonical === "RR";
  if (requireComplete && eventsRequired && !Number.isInteger(row.events)) {
    errors.push("Event count is required for OR and RR");
  } else if (
    row.events !== undefined &&
    (!Number.isInteger(row.events) || row.events < 0)
  ) {
    errors.push("Events must be a non-negative integer");
  }
  if (row.events !== undefined && row.n !== undefined && row.events > row.n) {
    errors.push("Events cannot exceed sample size");
  }
  return { valid: errors.length === 0, errors };
}

export function fixedEffectMetaAnalysis(
  rows: ExtractionRow[],
): MetaAnalysisResult {
  if (rows.length < 2) {
    throw new Error("At least two compatible extraction rows are required");
  }
  const measure = rows[0].effectType as SupportedMeasure;
  if (!["OR", "RR", "HR", "MD", "SMD"].includes(measure)) {
    throw new Error(`Unsupported effect measure: ${measure}`);
  }
  for (const row of rows) {
    const validation = validateExtractionRow(row);
    if (!validation.valid) throw new Error(validation.errors.join("; "));
    if (row.effectType !== measure) {
      throw new Error("Effect measures cannot be pooled together");
    }
  }
  const ratio = !["MD", "SMD"].includes(measure);
  const transformed = rows.map((row) => {
    const estimate = ratio ? Math.log(row.effectSize!) : row.effectSize!;
    const low = ratio ? Math.log(row.ciLow!) : row.ciLow!;
    const high = ratio ? Math.log(row.ciHigh!) : row.ciHigh!;
    const se = (high - low) / 3.92;
    if (!Number.isFinite(se) || se <= 0) {
      throw new Error("Confidence interval must have positive width");
    }
    return { estimate, weight: 1 / (se * se) };
  });
  const totalWeight = transformed.reduce((sum, row) => sum + row.weight, 0);
  const pooled =
    transformed.reduce((sum, row) => sum + row.estimate * row.weight, 0) /
    totalWeight;
  const se = Math.sqrt(1 / totalWeight);
  const q = transformed.reduce(
    (sum, row) => sum + row.weight * (row.estimate - pooled) ** 2,
    0,
  );
  const df = rows.length - 1;
  const i2 = q > 0 ? Math.max(0, ((q - df) / q) * 100) : 0;
  const convert = (value: number) => (ratio ? Math.exp(value) : value);
  return {
    measure,
    estimate: convert(pooled),
    ciLow: convert(pooled - 1.96 * se),
    ciHigh: convert(pooled + 1.96 * se),
    q,
    i2,
    studyCount: rows.length,
    weights: transformed.map((row) => row.weight / totalWeight),
  };
}

export function getPrismaSnapshot(
  state: SystematicReviewState,
): PrismaSnapshot {
  const screened = state.papers.filter(
    (paper) => paper.status !== "undecided",
  ).length;
  const excluded = state.papers.filter(
    (paper) => paper.status === "excluded",
  ).length;
  const maybe = state.papers.filter((paper) => paper.status === "maybe").length;
  const included = state.papers.filter(
    (paper) => paper.status === "included",
  ).length;
  const missing = [
    "confirmed duplicate occurrences",
    "retrieval events",
    "reports not retrieved",
    "full-text exclusion events",
  ];
  return {
    identified: state.papers.length,
    screened,
    excluded,
    maybe,
    included,
    duplicates: null,
    sought: null,
    notRetrieved: null,
    fullTextExcluded: null,
    complete: false,
    missing,
  };
}
