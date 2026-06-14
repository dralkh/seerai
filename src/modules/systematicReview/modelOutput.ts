import { z } from "zod";

export function normalizeModelConfidence(value: unknown): unknown {
  let numeric = value;
  if (typeof numeric === "string") {
    const trimmed = numeric.trim();
    numeric = Number(trimmed.endsWith("%") ? trimmed.slice(0, -1) : trimmed);
  }
  if (typeof numeric !== "number" || !Number.isFinite(numeric)) return value;
  if (numeric > 1 && numeric <= 100) return numeric / 100;
  return numeric;
}

export const modelConfidenceSchema = z.preprocess(
  normalizeModelConfidence,
  z.number().min(0).max(1),
);

export function calculateKeywordConfidence(
  inclusionMatches: number,
  exclusionMatches: number,
  configuredKeywords: number,
  decision: "included" | "maybe" | "excluded",
): number {
  const matched = inclusionMatches + exclusionMatches;
  if (matched === 0) return 0.25;
  const strength = Math.min(1, matched / 3);
  const separation =
    Math.abs(inclusionMatches - exclusionMatches) / Math.max(1, matched);
  const coverage = Math.min(
    1,
    matched / Math.max(1, Math.min(configuredKeywords, 6)),
  );
  const score =
    decision === "maybe"
      ? 0.3 + 0.3 * strength + 0.25 * (1 - separation) + 0.1 * coverage
      : 0.35 + 0.3 * strength + 0.25 * separation + 0.1 * coverage;
  return Math.max(0.25, Math.min(0.92, score));
}
