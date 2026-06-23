// Single source of truth for the effect/performance measures the systematic
// review pipeline understands. The original pipeline only modelled pairwise
// intervention meta-analysis (OR/RR/HR/MD/SMD). Diagnostic and prognostic ML
// reviews report AUROC, sensitivity, Brier scores, NRI, percentages, etc.
// Those are legitimate measures — they are simply not poolable with the
// inverse-variance machinery — so we recognise and normalise them rather than
// flagging every row as "unsupported".

export type MeasureFamily =
  | "ratio" // OR, RR, HR — poolable (log inverse-variance)
  | "continuous" // MD, SMD — poolable
  | "diagnostic" // sensitivity, specificity, PPV, NPV, accuracy, F1, LR+, LR-
  | "discrimination" // AUROC/AUC, C-index, AUPRC
  | "calibration" // Brier score, calibration slope/intercept
  | "reclassification" // NRI, IDI
  | "proportion" // percentage, proportion, rate, incidence, prevalence
  | "other"; // unrecognised

export interface MeasureInfo {
  canonical: string;
  family: MeasureFamily;
  poolable: boolean;
}

export const POOLABLE_FAMILIES: readonly MeasureFamily[] = [
  "ratio",
  "continuous",
];

// Canonical labels for poolable measures intentionally match the legacy codes
// ("OR"/"RR"/"HR"/"MD"/"SMD") so downstream checks in scientific.ts and
// analysisEngine.ts keep working unchanged.
const FAMILY_BY_CANONICAL: Record<string, MeasureFamily> = {
  OR: "ratio",
  RR: "ratio",
  HR: "ratio",
  MD: "continuous",
  SMD: "continuous",
  Sensitivity: "diagnostic",
  Specificity: "diagnostic",
  PPV: "diagnostic",
  NPV: "diagnostic",
  Accuracy: "diagnostic",
  F1: "diagnostic",
  "LR+": "diagnostic",
  "LR-": "diagnostic",
  "Youden index": "diagnostic",
  DOR: "diagnostic",
  AUROC: "discrimination",
  AUPRC: "discrimination",
  "C-index": "discrimination",
  "Brier score": "calibration",
  "Calibration slope": "calibration",
  "Calibration intercept": "calibration",
  ECE: "calibration",
  NRI: "reclassification",
  IDI: "reclassification",
  PERCENTAGE: "proportion",
  PROPORTION: "proportion",
  RATE: "proportion",
  INCIDENCE: "proportion",
  PREVALENCE: "proportion",
};

// Exact alias lookup keyed by the normalised measure token.
const ALIASES: Record<string, string> = {
  or: "OR",
  "odds ratio": "OR",
  "adjusted odds ratio": "OR",
  aor: "OR",
  rr: "RR",
  "risk ratio": "RR",
  "relative risk": "RR",
  "rate ratio": "RR",
  hr: "HR",
  "hazard ratio": "HR",
  "adjusted hazard ratio": "HR",
  ahr: "HR",
  md: "MD",
  "mean difference": "MD",
  wmd: "MD",
  "weighted mean difference": "MD",
  smd: "SMD",
  "standardized mean difference": "SMD",
  "standardised mean difference": "SMD",
  "cohen s d": "SMD",
  "cohen d": "SMD",
  "hedges g": "SMD",
  sensitivity: "Sensitivity",
  recall: "Sensitivity",
  tpr: "Sensitivity",
  "true positive rate": "Sensitivity",
  specificity: "Specificity",
  tnr: "Specificity",
  "true negative rate": "Specificity",
  ppv: "PPV",
  "positive predictive value": "PPV",
  precision: "PPV",
  npv: "NPV",
  "negative predictive value": "NPV",
  accuracy: "Accuracy",
  "classification accuracy": "Accuracy",
  "diagnostic accuracy": "Accuracy",
  f1: "F1",
  "f1 score": "F1",
  "f score": "F1",
  "f measure": "F1",
  youden: "Youden index",
  "youden index": "Youden index",
  "youden j": "Youden index",
  dor: "DOR",
  "diagnostic odds ratio": "DOR",
  auroc: "AUROC",
  auc: "AUROC",
  "auc roc": "AUROC",
  "roc auc": "AUROC",
  "area under the curve": "AUROC",
  "area under the roc curve": "AUROC",
  "area under the receiver operating characteristic": "AUROC",
  "area under the receiver operating characteristic curve": "AUROC",
  "c index": "C-index",
  "c statistic": "C-index",
  "concordance index": "C-index",
  "concordance statistic": "C-index",
  "harrell c": "C-index",
  "harrell s c": "C-index",
  auprc: "AUPRC",
  "auc pr": "AUPRC",
  "pr auc": "AUPRC",
  "area under the precision recall curve": "AUPRC",
  "average precision": "AUPRC",
  brier: "Brier score",
  "brier score": "Brier score",
  "scaled brier score": "Brier score",
  "calibration slope": "Calibration slope",
  "calibration intercept": "Calibration intercept",
  "calibration in the large": "Calibration intercept",
  ece: "ECE",
  "expected calibration error": "ECE",
  nri: "NRI",
  "net reclassification": "NRI",
  "net reclassification index": "NRI",
  "net reclassification improvement": "NRI",
  idi: "IDI",
  "integrated discrimination": "IDI",
  "integrated discrimination improvement": "IDI",
  "integrated discrimination index": "IDI",
  percentage: "PERCENTAGE",
  percent: "PERCENTAGE",
  proportion: "PROPORTION",
  prevalence: "PREVALENCE",
  incidence: "INCIDENCE",
  "cumulative incidence": "INCIDENCE",
  rate: "RATE",
};

// Ordered substring fallbacks for inputs that carry extra words (e.g.
// "AUROC (validation)"). The first match wins, so more specific entries appear
// before broader ones.
const FALLBACKS: Array<[RegExp, string]> = [
  [/auprc|auc[ -]?pr|pr[ -]?auc|precision[ -]?recall/, "AUPRC"],
  [/auroc|auc[ -]?roc|roc[ -]?auc/, "AUROC"],
  [/c[ -]?index|c[ -]?statistic|concordance/, "C-index"],
  [/\bauc\b|area under (the )?curve|area under the receiver/, "AUROC"],
  [/diagnostic odds ratio/, "DOR"],
  [/sensitivity|\brecall\b|true positive rate/, "Sensitivity"],
  [/specificity|true negative rate/, "Specificity"],
  [/positive predictive value|\bppv\b|\bprecision\b/, "PPV"],
  [/negative predictive value|\bnpv\b/, "NPV"],
  [/brier/, "Brier score"],
  [/calibration slope/, "Calibration slope"],
  [/calibration (intercept|in the large)/, "Calibration intercept"],
  [/net reclassification|\bnri\b/, "NRI"],
  [/integrated discrimination|\bidi\b/, "IDI"],
  [/hazard ratio|\bhr\b/, "HR"],
  [/odds ratio|\bor\b/, "OR"],
  [/risk ratio|relative risk/, "RR"],
  [/standardi[sz]ed mean difference/, "SMD"],
  [/mean difference/, "MD"],
  [/accuracy/, "Accuracy"],
  [/\bf1\b|f[ -]?score|f[ -]?measure/, "F1"],
  [/prevalence/, "PREVALENCE"],
  [/incidence/, "INCIDENCE"],
  [/percent|%/, "PERCENTAGE"],
  [/proportion/, "PROPORTION"],
  [/\brate\b/, "RATE"],
];

function measureKey(raw: string): string {
  return raw
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z0-9%]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function build(canonical: string): MeasureInfo {
  const family = FAMILY_BY_CANONICAL[canonical] || "other";
  return {
    canonical,
    family,
    poolable: family === "ratio" || family === "continuous",
  };
}

export function classifyMeasure(raw: string | undefined | null): MeasureInfo {
  const original = (raw || "").trim();
  if (!original)
    return { canonical: "Unspecified", family: "other", poolable: false };

  const lower = original.normalize("NFKC").toLowerCase();
  // Likelihood ratios — the +/- sign is meaningful but stripped by measureKey,
  // so resolve them before normalising.
  if (/likelihood ratio|\blr[ +-]?\b|\bplr\b|\bnlr\b/.test(lower)) {
    if (/\+|positive|\bplr\b/.test(lower)) return build("LR+");
    if (/-|−|negative|\bnlr\b/.test(lower)) return build("LR-");
  }

  const k = measureKey(original);
  const exact = ALIASES[k];
  if (exact) return build(exact);

  for (const [pattern, canonical] of FALLBACKS) {
    if (pattern.test(k)) return build(canonical);
  }
  return { canonical: original, family: "other", poolable: false };
}

export function isPoolableMeasure(raw: string | undefined | null): boolean {
  return classifyMeasure(raw).poolable;
}
