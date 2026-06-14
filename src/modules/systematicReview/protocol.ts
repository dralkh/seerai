import {
  EligibilityRule,
  FRAMEWORK_DEFS,
  ProtocolDimension,
  ProtocolRevision,
  ReviewProtocol,
  SystematicReviewProjectData,
} from "./types";

function id(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

export function getActiveProtocolRevision(
  protocol: ReviewProtocol,
): ProtocolRevision {
  return (
    protocol.revisions.find(
      (revision) => revision.id === protocol.activeRevisionId,
    ) || protocol.revisions[protocol.revisions.length - 1]
  );
}

export function createProtocolRevision(
  input: Omit<ProtocolRevision, "id" | "createdAt">,
): ProtocolRevision {
  return {
    ...input,
    id: id("protocol"),
    createdAt: new Date().toISOString(),
  };
}

export function createProtocolFromLegacy(
  framework: string,
  frameworkValues: Record<string, string>,
  incKeywords: string[],
  excKeywords: string[],
  mappings: Record<string, string[]>,
  researchQuestion: string = "",
): ReviewProtocol {
  const def = FRAMEWORK_DEFS[framework] || FRAMEWORK_DEFS.PICOTS;
  const revision = createProtocolRevision({
    actor: "migration",
    researchQuestion,
    framework: FRAMEWORK_DEFS[framework] ? framework : "PICOTS",
    dimensions: def.fields.map((field) => ({
      key: field.k,
      label: field.label,
      description: field.hint,
      value: frameworkValues[field.k] || "",
      keywordAids: [],
      evidenceLabels: [...(mappings[field.k] || [])],
    })),
    eligibilityRules: [],
    includeKeywordAids: [...incKeywords],
    excludeKeywordAids: [...excKeywords],
    provenance: [],
    warnings: [],
  });
  return { activeRevisionId: revision.id, revisions: [revision] };
}

export function dimensionsForFramework(
  framework: string,
  previous: ProtocolDimension[] = [],
): ProtocolDimension[] {
  const def = FRAMEWORK_DEFS[framework] || FRAMEWORK_DEFS.PICOTS;
  const byLabel = new Map(
    previous.map((dimension) => [dimension.label.toLowerCase(), dimension]),
  );
  const byKey = new Map(
    previous.map((dimension) => [dimension.key, dimension]),
  );
  return def.fields.map((field) => {
    const existing =
      byKey.get(field.k) || byLabel.get(field.label.toLowerCase());
    return {
      key: field.k,
      label: field.label,
      description: field.hint,
      value: existing?.value || "",
      keywordAids: [...(existing?.keywordAids || [])],
      evidenceLabels: [...(existing?.evidenceLabels || [])],
    };
  });
}

export function validateProtocolRevision(revision: ProtocolRevision): string[] {
  const warnings: string[] = [];
  if (!FRAMEWORK_DEFS[revision.framework]) {
    warnings.push("The selected framework is not supported");
  }
  if (!revision.researchQuestion.trim()) {
    warnings.push("Research question is empty");
  }
  const keys = new Set<string>();
  for (const dimension of revision.dimensions) {
    if (keys.has(dimension.key)) {
      warnings.push(`Duplicate dimension key: ${dimension.key}`);
    }
    keys.add(dimension.key);
    if (!dimension.value.trim()) {
      warnings.push(`${dimension.label} criterion is empty`);
    }
  }
  if (!revision.eligibilityRules.some((rule) => rule.type === "include")) {
    warnings.push("No explicit inclusion rules are defined");
  }
  if (!revision.eligibilityRules.some((rule) => rule.type === "exclude")) {
    warnings.push("No explicit exclusion rules are defined");
  }
  return warnings;
}

export function applyProtocolCompatibility(
  data: SystematicReviewProjectData,
): void {
  const active = getActiveProtocolRevision(data.protocol);
  data.framework = active.framework;
  data.frameworkValues = Object.fromEntries(
    active.dimensions.map((dimension) => [dimension.key, dimension.value]),
  );
  data.incKeywords = [...active.includeKeywordAids];
  data.excKeywords = [...active.excludeKeywordAids];
  data.picoLabelMap = Object.fromEntries(
    active.dimensions.map((dimension) => [
      dimension.key,
      [...dimension.evidenceLabels],
    ]),
  );
}

export function newEligibilityRule(
  type: EligibilityRule["type"],
  text: string,
  dimensionKey?: string,
): EligibilityRule {
  return { id: id("rule"), type, text, dimensionKey };
}
