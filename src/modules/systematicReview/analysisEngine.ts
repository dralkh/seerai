import {
  ExtractionRow,
  GapAnalysisRun,
  GapCandidate,
  GapCellStatus,
  GradeJudgment,
  MetaAnalysisSummary,
  ReviewProtocol,
  RoBAssessment,
  SynthesisDomainResult,
  SynthesisRun,
  SystematicReviewState,
} from "./types";
import { fixedEffectMetaAnalysis } from "./scientific";
import { isPoolableMeasure } from "./measures";
import { getActiveProtocolRevision } from "./protocol";
import { buildExtractionCompatibility } from "./compatibility";

function stableHash(value: unknown): string {
  const text = JSON.stringify(value);
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function stableId(prefix: string, value: unknown): string {
  return `${prefix}_${stableHash(value)}`;
}

function normalizeKey(value?: string): string {
  return (value || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function extractionId(
  paperId: number,
  row: ExtractionRow,
  index: number,
): string {
  return (
    row.id ||
    stableId("ext", [
      paperId,
      row.outcome,
      row.effectType,
      row.timepoint,
      index,
    ])
  );
}

function standardError(row: ExtractionRow): number {
  const ratio = ["OR", "RR", "HR"].includes(row.effectType);
  const low = ratio ? Math.log(row.ciLow!) : row.ciLow!;
  const high = ratio ? Math.log(row.ciHigh!) : row.ciHigh!;
  return (high - low) / 3.92;
}

function randomEffectsMetaAnalysis(rows: ExtractionRow[]): MetaAnalysisSummary {
  const common = fixedEffectMetaAnalysis(rows);
  const ratio = !["MD", "SMD"].includes(common.measure);
  const estimates = rows.map((row) =>
    ratio ? Math.log(row.effectSize!) : row.effectSize!,
  );
  const variances = rows.map((row) => standardError(row) ** 2);
  let tau2 = Math.max(
    0,
    (common.q - (rows.length - 1)) /
      Math.max(
        0.0000001,
        variances.reduce((sum, variance) => sum + 1 / variance, 0) -
          variances.reduce(
            (sum, variance) => sum + 1 / (variance * variance),
            0,
          ) /
            variances.reduce((sum, variance) => sum + 1 / variance, 0),
      ),
  );
  for (let iteration = 0; iteration < 50; iteration++) {
    const weights = variances.map((variance) => 1 / (variance + tau2));
    const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
    const mean =
      estimates.reduce(
        (sum, estimate, index) => sum + estimate * weights[index],
        0,
      ) / totalWeight;
    const residual = estimates.reduce(
      (sum, estimate, index) =>
        sum +
        weights[index] *
          weights[index] *
          ((estimate - mean) ** 2 - variances[index]),
      0,
    );
    const information = weights.reduce(
      (sum, weight) => sum + weight * weight,
      0,
    );
    const next = Math.max(
      0,
      tau2 + residual / Math.max(information, 0.0000001),
    );
    if (Math.abs(next - tau2) < 0.0000001) {
      tau2 = next;
      break;
    }
    tau2 = next;
  }
  const weights = variances.map((variance) => 1 / (variance + tau2));
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  const pooled =
    estimates.reduce(
      (sum, estimate, index) => sum + estimate * weights[index],
      0,
    ) / totalWeight;
  const residualVariance =
    estimates.reduce(
      (sum, estimate, index) => sum + weights[index] * (estimate - pooled) ** 2,
      0,
    ) / Math.max(1, rows.length - 1);
  const hksjSe = Math.sqrt(
    Math.max(1 / totalWeight, residualVariance / totalWeight),
  );
  const critical = rows.length > 2 ? 2.262 : 4.303;
  const predictionSe = Math.sqrt(tau2 + hksjSe ** 2);
  const convert = (value: number) => (ratio ? Math.exp(value) : value);
  return {
    estimate: convert(pooled),
    ciLow: convert(pooled - critical * hksjSe),
    ciHigh: convert(pooled + critical * hksjSe),
    predictionLow: convert(pooled - critical * predictionSe),
    predictionHigh: convert(pooled + critical * predictionSe),
    q: common.q,
    i2: common.i2,
    tau2,
    weights: weights.map((weight) => weight / totalWeight),
  };
}

function commonEffectSummary(rows: ExtractionRow[]): MetaAnalysisSummary {
  const result = fixedEffectMetaAnalysis(rows);
  return {
    estimate: result.estimate,
    ciLow: result.ciLow,
    ciHigh: result.ciHigh,
    q: result.q,
    i2: result.i2,
    tau2: 0,
    weights: result.weights,
  };
}

function overallRiskOfBias(assessment?: RoBAssessment): number {
  if (!assessment || assessment.verificationStatus !== "verified") return -1;
  const values = [
    assessment.randomization,
    assessment.deviations,
    assessment.missing,
    assessment.measurement,
    assessment.selective,
  ];
  if (values.includes("high")) return -2;
  if (values.includes("some") || values.includes("not_assessed")) return -1;
  return 0;
}

function gradeDraft(
  paperIds: number[],
  state: SystematicReviewState,
  i2?: number,
  ciLow?: number,
  ciHigh?: number,
  nullValue = 1,
): GradeJudgment {
  const robScores = paperIds.map((id) => overallRiskOfBias(state.robData[id]));
  const riskOfBias = robScores.length ? Math.min(...robScores) : -1;
  const inconsistency =
    i2 === undefined ? -1 : i2 >= 75 ? -2 : i2 >= 40 ? -1 : 0;
  const imprecision =
    ciLow === undefined || ciHigh === undefined
      ? -1
      : ciLow <= nullValue && ciHigh >= nullValue
        ? -1
        : 0;
  const totalDowngrades =
    Math.abs(riskOfBias) + Math.abs(inconsistency) + Math.abs(imprecision);
  const certainty =
    totalDowngrades === 0
      ? "high"
      : totalDowngrades === 1
        ? "moderate"
        : totalDowngrades === 2
          ? "low"
          : "verylow";
  return {
    certainty,
    riskOfBias: riskOfBias as 0 | -1 | -2,
    inconsistency: inconsistency as 0 | -1 | -2,
    indirectness: 0,
    imprecision: imprecision as 0 | -1 | -2,
    publicationBias: 0,
    upgrade: 0,
    rationale: [
      "Draft certainty requires reviewer confirmation.",
      ...(riskOfBias < 0
        ? [
            "One or more study-level risk-of-bias assessments are incomplete or concerning.",
          ]
        : []),
      ...(inconsistency < 0
        ? ["Observed heterogeneity may reduce certainty."]
        : []),
      ...(imprecision < 0
        ? ["The confidence interval is imprecise or crosses the null."]
        : []),
    ],
    confirmed: false,
  };
}

function protocolFingerprint(protocol: ReviewProtocol): unknown {
  const revision = getActiveProtocolRevision(protocol);
  return {
    id: revision.id,
    framework: revision.framework,
    dimensions: revision.dimensions,
    rules: revision.eligibilityRules,
  };
}

export function computeSynthesisFingerprint(
  state: SystematicReviewState,
): string {
  const included = state.papers
    .filter(
      (paper) =>
        paper.status === "included" &&
        (paper.screeningStage === "final" || !paper.screeningStage),
    )
    .map((paper) => paper.id)
    .sort((a, b) => a - b);
  return stableHash({
    protocol: protocolFingerprint(state.protocol),
    included,
    extractions: included.map((id) => state.extractions[id] || []),
    analyses: included.map((id) => {
      const paper = state.papers.find((candidate) => candidate.id === id);
      return paper?.analysis;
    }),
    rob: included.map((id) => state.robData[id]),
  });
}

export function buildSynthesisRun(state: SystematicReviewState): SynthesisRun {
  const now = new Date().toISOString();
  const revision = getActiveProtocolRevision(state.protocol);
  const included = state.papers.filter(
    (paper) =>
      paper.status === "included" &&
      (paper.screeningStage === "final" || !paper.screeningStage),
  );
  const template = state.extractionTemplates.find(
    (candidate) => candidate.id === state.activeExtractionTemplateId,
  );
  const compatibility = buildExtractionCompatibility(
    included,
    state.extractions,
    template,
  );
  const groups = compatibility.groups;
  const domains: SynthesisDomainResult[] = [];
  for (const [key, group] of groups) {
    const first = group.rows[0];
    const domainId = stableId("domain", [revision.id, key]);
    // Only ratio/continuous measures are pooled. Diagnostic/prognostic measures
    // (AUROC, sensitivity, Brier, NRI, …) are recognised and summarised
    // narratively instead of fed to the inverse-variance machinery.
    const poolable = isPoolableMeasure(first.effectType);
    const canPool = poolable && group.rows.length >= 2;
    const commonEffect = canPool ? commonEffectSummary(group.rows) : undefined;
    const randomEffects = canPool
      ? randomEffectsMetaAnalysis(group.rows)
      : undefined;
    const nullValue = ["MD", "SMD"].includes(first.effectType) ? 0 : 1;
    const observedSides = new Set(
      (poolable ? group.rows : [])
        .map((row) =>
          row.ciLow! <= nullValue && row.ciHigh! >= nullValue
            ? 0
            : row.effectSize! < nullValue
              ? -1
              : 1,
        )
        .filter((side) => side !== 0),
    );
    const direction = !poolable
      ? "unclear"
      : observedSides.size > 1
        ? "mixed"
        : commonEffect === undefined
          ? "unclear"
          : commonEffect.ciLow <= nullValue && commonEffect.ciHigh >= nullValue
            ? "none"
            : commonEffect.estimate < nullValue
              ? first.direction === "higher_better"
                ? "none"
                : "positive"
              : first.direction === "lower_better"
                ? "none"
                : "positive";
    domains.push({
      id: domainId,
      key,
      outcome: first.outcome,
      timepoint: first.timepoint,
      measure: first.effectType,
      method: canPool ? "random_effects" : "narrative",
      status: canPool ? "poolable" : "not_poolable",
      studies: group.rows.map((row, index) => ({
        extractionId: extractionId(
          group.paperIds[index],
          row,
          group.rowIndexes[index],
        ),
        paperId: group.paperIds[index],
        outcome: row.outcome,
        measure: row.effectType,
        estimate: row.effectSize!,
        ciLow: row.ciLow!,
        ciHigh: row.ciHigh!,
        weight: randomEffects?.weights[index],
        timepoint: row.timepoint,
        unit: row.unit,
        sourceQuote: row.sourceQuote,
        sourcePage: row.sourcePage,
      })),
      paperIds: Array.from(new Set(group.paperIds)),
      direction,
      summary:
        canPool && randomEffects
          ? `${group.rows.length} verified estimates; random-effects estimate ${randomEffects.estimate.toFixed(2)} (${randomEffects.ciLow.toFixed(2)} to ${randomEffects.ciHigh.toFixed(2)}), I2 ${randomEffects.i2.toFixed(0)}%.`
          : poolable
            ? "One verified estimate is available; quantitative pooling is not appropriate."
            : `${group.rows.length} verified ${first.effectType} estimate(s) reported; this measure is summarised narratively, not pooled.`,
      nonPoolableReasons: canPool
        ? []
        : poolable
          ? ["At least two compatible verified estimates are required."]
          : [
              `${first.effectType} is a non-poolable measure; results are summarised narratively.`,
            ],
      commonEffect,
      randomEffects,
      methodConfirmed: false,
      grade: gradeDraft(
        Array.from(new Set(group.paperIds)),
        state,
        randomEffects?.i2,
        randomEffects?.ciLow,
        randomEffects?.ciHigh,
        nullValue,
      ),
      narrativeConfirmed: false,
      excludedRows: group.excludedRows.length ? group.excludedRows : undefined,
    });
  }
  const existingOutcomes = new Set(
    domains.map((domain) => normalizeKey(domain.outcome)),
  );
  for (const paper of included) {
    for (const outcome of paper.analysis?.outcomes || []) {
      const normalized = normalizeKey(outcome);
      if (!normalized || existingOutcomes.has(normalized)) continue;
      existingOutcomes.add(normalized);
      domains.push({
        id: stableId("domain", [revision.id, normalized, "narrative"]),
        key: `${normalized}|narrative`,
        outcome,
        method: "narrative",
        status: "narrative",
        studies: [],
        paperIds: [paper.id],
        direction: "unclear",
        summary:
          "A grounded narrative finding is available, but no verified compatible effect estimate has been recorded.",
        nonPoolableReasons: [
          "No verified quantitative extraction is available.",
        ],
        selectedModel: "narrative",
        methodConfirmed: false,
        grade: {
          certainty: "not_applicable",
          riskOfBias: 0,
          inconsistency: 0,
          indirectness: 0,
          imprecision: 0,
          publicationBias: 0,
          upgrade: 0,
          rationale: [
            "GRADE was not automatically applied to this narrative-only domain.",
          ],
          confirmed: false,
        },
        narrativeConfirmed: false,
      });
    }
  }
  const fingerprint = computeSynthesisFingerprint(state);
  return {
    id: stableId("syn", [state.activeSpaceId, fingerprint, now]),
    projectId: state.activeSpaceId,
    protocolRevisionId: revision.id,
    inputFingerprint: fingerprint,
    includedPaperIds: included.map((paper) => paper.id),
    createdAt: now,
    updatedAt: now,
    status: "draft",
    staleReasons: [],
    warnings: [
      ...(domains.length
        ? []
        : ["No verified extraction or grounded outcome is available."]),
      ...compatibility.report.issues
        .filter((issue) => issue.severity === "blocker")
        .slice(0, 5)
        .map(
          (issue) =>
            `Paper ${issue.paperId}: ${issue.outcome} ${issue.measure} excluded - ${issue.reason}`,
        ),
    ],
    domains,
    compatibilityReport: compatibility.report,
  };
}

function gapStatus(
  domain?: SynthesisDomainResult,
  sparseThreshold = 2,
): GapCellStatus {
  if (!domain) return "no_evidence";
  if (domain.paperIds.length < sparseThreshold) return "sparse";
  if (domain.direction === "mixed") return "conflicting";
  if (["low", "verylow"].includes(domain.grade.certainty)) {
    return "low_certainty";
  }
  if (domain.grade.indirectness < 0) return "indirect";
  return "adequate";
}

function gapReason(status: GapCellStatus): GapCandidate["reasonCode"] {
  if (status === "conflicting") return "inconsistent";
  if (status === "indirect") return "indirect";
  if (status === "low_certainty") return "biased";
  return "insufficient";
}

export function buildGapAnalysisRun(
  state: SystematicReviewState,
  synthesis: SynthesisRun,
): GapAnalysisRun {
  const revision = getActiveProtocolRevision(state.protocol);
  const now = new Date().toISOString();
  const previous = state.gapAnalysisRuns
    .flatMap((run) => run.gaps)
    .reduce<Record<string, GapCandidate>>((map, gap) => {
      map[gap.canonicalKey] = gap;
      return map;
    }, {});
  const dimensions = revision.dimensions.length
    ? revision.dimensions
    : [
        {
          key: "review",
          label: "Review",
          value: revision.researchQuestion || "Review question",
        },
      ];
  const cells = dimensions.flatMap((dimension) =>
    synthesis.domains.map((domain) => {
      const status = gapStatus(
        domain,
        state.analysisSettings.sparseStudyThreshold,
      );
      return {
        id: stableId("cell", [dimension.key, dimension.value, domain.id]),
        rowKey: dimension.key,
        rowValue: `${dimension.label}: ${dimension.value || "Not specified"}`,
        columnKey: "outcome",
        columnValue: domain.outcome,
        status,
        domainIds: [domain.id],
        paperIds: domain.paperIds,
        studyCount: domain.paperIds.length,
        rationale:
          status === "adequate"
            ? "Verified evidence is available without an automatic gap signal."
            : domain.nonPoolableReasons[0] ||
              `Evidence classified as ${status.replace("_", " ")}.`,
      };
    }),
  );
  if (!cells.length) {
    dimensions.forEach((dimension) => {
      cells.push({
        id: stableId("cell", [dimension.key, dimension.value, "no_evidence"]),
        rowKey: dimension.key,
        rowValue: `${dimension.label}: ${dimension.value || "Not specified"}`,
        columnKey: "outcome",
        columnValue: "No verified outcome evidence",
        status: "no_evidence",
        domainIds: [],
        paperIds: [],
        studyCount: 0,
        rationale:
          "No verified synthesis domain covers this configured review area.",
      });
    });
  }
  const gaps = cells
    .filter((cell) => !["adequate", "not_applicable"].includes(cell.status))
    .map<GapCandidate>((cell) => {
      const canonicalKey = [
        cell.rowKey,
        cell.rowValue,
        cell.columnKey,
        cell.columnValue,
        gapReason(cell.status),
      ]
        .map(normalizeKey)
        .join("|");
      const prior = previous[canonicalKey];
      return {
        id: prior?.id || stableId("gap", canonicalKey),
        canonicalKey,
        title:
          prior?.title ||
          `${cell.status.replace("_", " ")}: ${cell.columnValue}`,
        severity:
          prior?.severity ||
          (cell.status === "no_evidence" || cell.status === "conflicting"
            ? "high"
            : "medium"),
        reasonCode: gapReason(cell.status),
        dimensionTags: [cell.rowValue, cell.columnValue],
        description:
          prior?.description ||
          `${cell.rationale} This is a review coverage signal and requires reviewer interpretation before it is presented as a research gap.`,
        implication:
          prior?.implication ||
          "Consider whether additional studies, improved methods, or a narrower review question are needed.",
        domainIds: cell.domainIds,
        paperIds: cell.paperIds,
        status: prior?.status || "draft",
        reviewerNote: prior?.reviewerNote,
        updatedAt: now,
      };
    });
  const fingerprint = stableHash({
    synthesis: synthesis.inputFingerprint,
    dimensions: dimensions.map((dimension) => [dimension.key, dimension.value]),
    cells: cells.map((cell) => [cell.id, cell.status]),
  });
  return {
    id: stableId("gaprun", [state.activeSpaceId, fingerprint, now]),
    projectId: state.activeSpaceId,
    synthesisRunId: synthesis.id,
    inputFingerprint: fingerprint,
    createdAt: now,
    updatedAt: now,
    status: "draft",
    rowDimensionKey: "protocol_dimensions",
    columnDimensionKey: "outcome",
    cells,
    gaps,
    warnings: [],
  };
}
