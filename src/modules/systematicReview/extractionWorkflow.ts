import { z } from "zod";
import { getActiveModelConfig } from "../chat/modelConfig";
import { openAIService } from "../openai";
import { getActiveProtocolRevision } from "./protocol";
import { ReviewCancellationSignal } from "./cancellation";
import { modelConfidenceSchema } from "./modelOutput";
import { classifyMeasure } from "./measures";
import { groundQuote, normalizeText } from "./grounding";
import {
  ExtractionIssue,
  ExtractionOutcomeDefinition,
  ExtractionRow,
  ExtractionTemplate,
  LlmChatCompletion,
  ProtocolRevision,
  ScopeProposal,
  EligibilityProposal,
  MappingProposal,
  SystematicReviewPaper,
  SystematicReviewSpace,
} from "./types";
import {
  getReviewSourceDocument,
  ReviewSourceSummary,
} from "./reviewSourceService";
import type { ExtractedDocument } from "./documentAnalyzer";

const TemplateProposalSchema = z.object({
  name: z.string().min(1),
  instructions: z.string().default(""),
  outcomes: z
    .array(
      z.object({
        name: z.string().min(1),
        aliases: z.array(z.string()).default([]),
        description: z.string().default(""),
        measures: z.array(z.string().min(1)).min(1).default(["OR"]),
        timepoints: z.array(z.string()).default([]),
        unit: z.string().optional(),
        direction: z.enum(["higher_better", "lower_better"]).optional(),
        required: z.boolean().default(false),
      }),
    )
    .min(1),
});

export const ExtractionProposalSchema = z.object({
  extractions: z.array(z.unknown()).default([]),
});

function parseJSON(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1] || text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("Model returned no JSON");
  return JSON.parse(candidate.slice(start, end + 1));
}

function normalize(text: string): string {
  return normalizeText(text);
}

export function normalizeExtractionMeasure(value: string): string {
  const info = classifyMeasure(value);
  // Recognised measures collapse to their canonical label; unrecognised values
  // are preserved (upper-cased) so reviewers still see what the model reported.
  return info.family === "other" ? value.trim().toUpperCase() : info.canonical;
}

// Collapse a template's declared measures to canonical labels and de-duplicate,
// so "AUROC"/"AUC"/"area under the curve" become a single entry.
function canonicalizeMeasures(measures: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of measures) {
    const canonical = normalizeExtractionMeasure(raw);
    if (canonical && !seen.has(canonical)) {
      seen.add(canonical);
      result.push(canonical);
    }
  }
  return result.length ? result : ["OR"];
}

function stablePart(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48);
}

export async function proposeExtractionTemplate(
  project: SystematicReviewSpace,
  instructions = "",
  signal?: ReviewCancellationSignal,
): Promise<ExtractionTemplate> {
  const revision = getActiveProtocolRevision(project.protocol);
  const criteria = [
    ...revision.dimensions.map(
      (dimension) =>
        `${dimension.label}: ${dimension.value || "not specified"}`,
    ),
    ...revision.eligibilityRules.map((rule) => `${rule.type}: ${rule.text}`),
  ].join("\n");
  const response = await openAIService.chatCompletion(
    [
      {
        role: "system",
        content:
          "Design a practical systematic-review quantitative extraction template. Return one JSON object only. Define outcomes that can be applied consistently across included studies. Do not invent outcome values or study results.",
      },
      {
        role: "user",
        content: `Research question: ${revision.researchQuestion || "Not specified"}
Framework: ${revision.framework}
Criteria:
${criteria}

Reviewer instructions:
${instructions || "None"}

Measures: use ratio codes (OR, RR, HR), continuous codes (MD, SMD), or — for
diagnostic/prognostic studies — performance labels such as AUROC, AUC,
Sensitivity, Specificity, PPV, NPV, Accuracy, C-index, AUPRC, "Brier score",
NRI, or percentage. Choose the measures the studies actually report.

Return:
{"name":string,"instructions":string,"outcomes":[{"name":string,"aliases":string[],"description":string,"measures":string[],"timepoints":string[],"unit"?:string,"direction"?:"higher_better"|"lower_better","required":boolean}]}`,
      },
    ],
    { signal, timeoutMs: 180000, isolated: true },
  );
  if (signal?.aborted) {
    throw new Error("Request was cancelled");
  }
  const parsed = TemplateProposalSchema.parse(parseJSON(response));
  const now = new Date().toISOString();
  const id = `template_${Date.now()}`;
  const outcomes: ExtractionOutcomeDefinition[] = parsed.outcomes.map(
    (outcome, index) => ({
      ...outcome,
      measures: canonicalizeMeasures(outcome.measures),
      id: `outcome_${stablePart(outcome.name) || index + 1}_${index + 1}`,
    }),
  );
  return {
    id,
    revisionId: `${id}_r1`,
    protocolRevisionId: revision.id,
    name: parsed.name,
    instructions: parsed.instructions,
    outcomes,
    status: "draft",
    source: "model",
    model: getActiveModelConfig()?.model || "configured model",
    createdAt: now,
    updatedAt: now,
  };
}

export async function proposeExtractionTemplateFromContext(
  scope: ScopeProposal,
  eligibility: EligibilityProposal,
  mapping: MappingProposal,
  documents: ExtractedDocument[],
  baselineTemplate: ExtractionTemplate | undefined,
  protocolRevisionId: string,
  options?: {
    llm?: LlmChatCompletion;
    signal?: ReviewCancellationSignal;
    instructions?: string;
  },
): Promise<ExtractionTemplate> {
  const sourceText = documents
    .filter((doc) => !doc.error)
    .map((doc) => `=== ${doc.fileName} ===\n${doc.text}`)
    .join("\n\n");
  const dimensions = scope.dimensions
    .map(
      (dimension) =>
        `${dimension.key} · ${dimension.label}: ${dimension.value || "not specified"}`,
    )
    .join("\n");
  const rules = [
    ...eligibility.inclusionRules.map((text) => `include: ${text}`),
    ...eligibility.exclusionRules.map((text) => `exclude: ${text}`),
  ].join("\n");
  const mappings = Object.entries(mapping.evidenceLabels)
    .map(
      ([key, values]) =>
        `${key}: ${values.length ? values.join(", ") : "(no mapping)"}`,
    )
    .join("\n");
  const baselineSummary = baselineTemplate
    ? `Existing template has ${baselineTemplate.outcomes.length} outcome(s): ${baselineTemplate.outcomes
        .map((outcome) => outcome.name)
        .join(", ")}`
    : "No existing template.";
  const chat = options?.llm ?? openAIService.chatCompletion.bind(openAIService);
  const systemContent =
    "You design practical systematic-review extraction templates. Return one JSON object only. Define outcomes that can be applied consistently across included studies. Use the full protocol context to produce rich outcome definitions (name, aliases, description, measures, timepoints, unit, direction, required). Preserve existing outcomes that remain well supported; add new outcomes, measures, or timepoints when the context warrants it. Do not invent outcome values or study results.";
  const userContent = `Step 4 of 5 — Extraction template.

Research question: ${scope.researchQuestion}
Framework: ${scope.framework}

Scope criteria:
${dimensions}

Eligibility rules:
${rules || "(none)"}

Evidence mappings:
${mappings || "(none)"}

${baselineSummary}

Reviewer instructions:
${options?.instructions || "None"}

Uploaded source documents (excerpts):
${sourceText ? sourceText.substring(0, 60000) : "(none)"}

Measures may be ratio codes (OR, RR, HR), continuous codes (MD, SMD), or
diagnostic/prognostic performance labels (e.g. AUROC, AUC, Sensitivity,
Specificity, PPV, NPV, Accuracy, C-index, AUPRC, "Brier score", NRI,
percentage) — pick what the studies report.

Return JSON with this exact shape:
{"name":string,"instructions":string,"outcomes":[{"name":string,"aliases":string[],"description":string,"measures":string[],"timepoints":string[],"unit"?:string,"direction"?:("higher_better"|"lower_better"),"required":boolean}]}`;

  // Validate the model output, retrying with the exact issues fed back so a
  // single malformed field doesn't abort the whole step.
  const maxRetries = 2;
  let parsed: z.infer<typeof TemplateProposalSchema> | null = null;
  let lastError = "";
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const userMessage =
      attempt === 0
        ? userContent
        : `${userContent}\n\nYour previous response failed validation:\n${lastError}\nReturn corrected JSON that fixes exactly these problems. Output only the JSON object.`;
    const response = await chat(
      [
        { role: "system", content: systemContent },
        { role: "user", content: userMessage },
      ],
      { signal: options?.signal, timeoutMs: 180000, isolated: true },
    );
    if (options?.signal?.aborted) {
      throw new Error("Request was cancelled");
    }
    let payload: unknown;
    try {
      payload = parseJSON(response);
    } catch (e) {
      lastError = (e as Error)?.message || String(e);
      continue;
    }
    const result = TemplateProposalSchema.safeParse(payload);
    if (result.success) {
      parsed = result.data;
      break;
    }
    lastError = result.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
  }
  if (!parsed) {
    throw new Error(
      `Extraction template failed validation after ${maxRetries + 1} attempts — ${lastError}`,
    );
  }
  const now = new Date().toISOString();
  const baseId = baselineTemplate?.id || `template_${Date.now()}`;
  const baseRevision = baselineTemplate
    ? `${baseId}_r${
        (Number(baselineTemplate.revisionId.match(/_r(\d+)$/)?.[1]) || 0) + 1
      }`
    : `${baseId}_r1`;
  const outcomes: ExtractionOutcomeDefinition[] = parsed.outcomes.map(
    (outcome, index) => ({
      ...outcome,
      measures: canonicalizeMeasures(outcome.measures),
      id: `outcome_${stablePart(outcome.name) || index + 1}_${index + 1}`,
    }),
  );
  return {
    id: baseRevision,
    revisionId: baseRevision,
    protocolRevisionId,
    name: parsed.name,
    instructions: parsed.instructions,
    outcomes,
    status: "draft",
    source: "model",
    model: getActiveModelConfig()?.model || "configured model",
    createdAt: now,
    updatedAt: now,
  };
}

export function buildExtractionMessages(
  template: ExtractionTemplate,
  content: string,
  title: string,
): { role: "system" | "user"; content: string }[] {
  const outcomeSpec = template.outcomes.map((outcome) => ({
    id: outcome.id,
    name: outcome.name,
    aliases: outcome.aliases,
    description: outcome.description,
    measures: outcome.measures,
    timepoints: outcome.timepoints,
    unit: outcome.unit,
    direction: outcome.direction,
  }));
  return [
    {
      role: "system",
      content:
        "Extract study results from the supplied source text. Return one JSON object only. " +
        "Record the paper's reported result type in effectType — ratio measures (OR/RR/HR), " +
        "continuous (MD/SMD), or diagnostic/prognostic metrics (AUROC, AUC, Sensitivity, " +
        "Specificity, PPV, NPV, Accuracy, C-index, AUPRC, Brier score, NRI, percentage). " +
        "Every returned row MUST include sourceQuote: a single verbatim, contiguous span copied " +
        "character-for-character from the source — no ellipses, no edits, no stitching across " +
        "sentences. Do not emit a row for an outcome the paper does not report. Omit fields that " +
        "are absent rather than guessing. Never calculate, infer, or invent values.",
    },
    {
      role: "user",
      content: `Paper title: ${title}
Template instructions: ${template.instructions || "None"}
Outcomes:
${JSON.stringify(outcomeSpec)}

Source text:
${content}

Use a decimal from 0 to 1 for confidence.

Return:
{"extractions":[{"outcomeId":string,"effectType":string,"effectSize"?:number,"ciLow"?:number,"ciHigh"?:number,"n"?:number,"events"?:number,"timepoint"?:string,"unit"?:string,"interventionArm"?:string,"comparatorArm"?:string,"direction"?:"higher_better"|"lower_better","sourcePage"?:string,"sourceQuote":string,"confidence":number,"missingReason"?:string}]}`,
    },
  ];
}

export interface BuildExtractionRowsParams {
  proposals: unknown[];
  template: ExtractionTemplate;
  content: string;
  itemId: number;
  model?: string;
  jobId?: string;
  sourceAttachmentId?: number;
  sourceFingerprint?: string;
}

export interface BuildExtractionRowsResult {
  rows: ExtractionRow[];
  issues: ExtractionIssue[];
}

/**
 * Pure validation core shared by live extraction, the test suite, and the model
 * evaluation harness. Classifies the reported measure, grounds the supporting
 * quote with the robust matcher, drops absence-placeholder rows, and collects
 * per-row issues — without touching Zotero or the network.
 */
export function buildExtractionRows(
  params: BuildExtractionRowsParams,
): BuildExtractionRowsResult {
  const { proposals, template, content, itemId } = params;
  const model =
    params.model ?? (getActiveModelConfig()?.model || "configured model");
  const jobId = params.jobId ?? "";
  const normalizedContent = normalizeText(content);
  const now = new Date().toISOString();
  const issues: ExtractionIssue[] = [];
  const rows = proposals.flatMap((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      issues.push({
        code: "invalid_row",
        severity: "error",
        message: `Extraction row ${index + 1} is not an object`,
      });
      return [];
    }
    const proposal = raw as Record<string, unknown>;
    const text = (field: string): string | undefined =>
      typeof proposal[field] === "string"
        ? (proposal[field] as string).trim() || undefined
        : undefined;
    const number = (field: string): number | undefined => {
      const value = proposal[field];
      if (typeof value === "number" && Number.isFinite(value)) return value;
      if (typeof value === "string" && value.trim()) {
        const parsedValue = Number(value);
        if (Number.isFinite(parsedValue)) return parsedValue;
      }
      return undefined;
    };

    const requestedOutcome = text("outcomeId") || text("outcome") || "";
    const normalizedOutcome = normalize(requestedOutcome);
    const outcome = template.outcomes.find(
      (candidate) =>
        candidate.id === requestedOutcome ||
        normalize(candidate.name) === normalizedOutcome ||
        candidate.aliases.some(
          (alias) => normalize(alias) === normalizedOutcome,
        ),
    );

    const rawMeasure = text("effectType") || text("measure") || "";
    const measureInfo = classifyMeasure(rawMeasure);
    const effectType = measureInfo.canonical || "Unspecified";
    const sourceQuote = text("sourceQuote") || text("quote");
    const grounding = groundQuote(sourceQuote, normalizedContent);
    const values = {
      effectSize: number("effectSize"),
      ciLow: number("ciLow"),
      ciHigh: number("ciHigh"),
      n: number("n"),
      events: number("events"),
    };
    const hasAnyValue = Object.values(values).some(
      (value) => value !== undefined,
    );
    const missingReason = text("missingReason");

    // Absence placeholder: the model explicitly reports the outcome is absent
    // (no value, no grounded quote, an explanation). Drop it silently rather
    // than emitting the ungrounded_quote + no_value + invalid_confidence cascade
    // — a genuinely unreported outcome is surfaced via missing-required instead.
    if (!hasAnyValue && !grounding.grounded && missingReason) {
      return [];
    }

    const rowIssues: ExtractionIssue[] = [];
    if (!outcome) {
      rowIssues.push({
        code: "unknown_outcome",
        severity: "error",
        field: "outcomeId",
        message: "The returned outcome does not match the active template",
        rawValue: requestedOutcome,
      });
    }
    // Recognised non-poolable measures (AUROC, sensitivity, etc.) are valid and
    // intentionally produce no issue — only a truly unrecognised label warns.
    if (measureInfo.family === "other" && rawMeasure.trim()) {
      rowIssues.push({
        code: "unrecognized_measure",
        severity: "warning",
        field: "effectType",
        message: "The reported measure could not be recognised",
        rawValue: rawMeasure,
      });
    }
    if (!grounding.grounded) {
      rowIssues.push({
        code: "ungrounded_quote",
        severity: "error",
        field: "sourceQuote",
        message: "The supporting quote was not found in the supplied source",
        rawValue: sourceQuote,
      });
    } else if (sourceQuote && sourceQuote.length < 8) {
      rowIssues.push({
        code: "short_quote",
        severity: "warning",
        field: "sourceQuote",
        message: "The quote is grounded but too short for reliable review",
        rawValue: sourceQuote,
      });
    }
    if (!hasAnyValue) {
      rowIssues.push({
        code: "no_quantitative_value",
        severity: "warning",
        message: "No quantitative value was returned",
      });
    }
    const confidence = modelConfidenceSchema.safeParse(proposal.confidence);
    if (
      !confidence.success &&
      proposal.confidence !== undefined &&
      proposal.confidence !== null
    ) {
      rowIssues.push({
        code: "invalid_confidence",
        severity: "warning",
        field: "confidence",
        message: "Confidence could not be normalized",
        rawValue: String(proposal.confidence),
      });
    }
    const row: ExtractionRow = {
      id: `ext_${itemId}_${Date.now()}_${index}`,
      outcomeId: outcome?.id,
      outcome: outcome?.name || requestedOutcome || "Unmapped outcome",
      effectType,
      measureFamily: measureInfo.family,
      poolable: measureInfo.poolable,
      ...values,
      timepoint: text("timepoint"),
      unit: text("unit"),
      interventionArm: text("interventionArm"),
      comparatorArm: text("comparatorArm"),
      direction:
        proposal.direction === "higher_better" ||
        proposal.direction === "lower_better"
          ? proposal.direction
          : outcome?.direction,
      sourceAttachmentId: params.sourceAttachmentId,
      sourcePage: text("sourcePage"),
      sourceQuote,
      verificationStatus: "proposed",
      confidence: confidence.success ? confidence.data : undefined,
      missingReason,
      model,
      jobId,
      templateRevisionId: template.revisionId,
      revision: 1,
      updatedAt: now,
      issues: rowIssues,
      sourceFingerprint: params.sourceFingerprint,
    };
    issues.push(...rowIssues);
    return [row];
  });
  return { rows, issues };
}

export async function extractReviewPaper(
  item: Zotero.Item,
  template: ExtractionTemplate,
  jobId: string,
  signal?: ReviewCancellationSignal,
  sourcePreference?: SystematicReviewPaper["sourcePreference"],
  llm?: LlmChatCompletion,
): Promise<{
  rows: ExtractionRow[];
  issues: ExtractionIssue[];
  sourceSummary: ReviewSourceSummary;
}> {
  const title = (item.getField("title") as string) || `Item ${item.id}`;
  const source = await getReviewSourceDocument(item, signal, sourcePreference);
  const content = source.text;
  const chat = llm ?? openAIService.chatCompletion.bind(openAIService);
  const messages = buildExtractionMessages(template, content, title);
  let response = await chat(messages, {
    signal,
    timeoutMs: 180000,
    isolated: true,
  });
  let parsed: z.infer<typeof ExtractionProposalSchema>;
  try {
    parsed = ExtractionProposalSchema.parse(parseJSON(response));
  } catch (error) {
    response = await chat(
      [
        ...messages,
        {
          role: "user",
          content:
            "Your previous response could not be parsed as the required JSON object. " +
            `Validation error: ${error instanceof Error ? error.message : String(error)}\n\n` +
            'Return only corrected JSON with the exact shape {"extractions":[...]} and no prose.',
        },
      ],
      {
        signal,
        timeoutMs: 180000,
        isolated: true,
      },
    );
    parsed = ExtractionProposalSchema.parse(parseJSON(response));
  }
  const { rows, issues } = buildExtractionRows({
    proposals: parsed.extractions,
    template,
    content,
    itemId: item.id,
    jobId,
    sourceAttachmentId: source.summary.attachmentId,
    sourceFingerprint: source.summary.fingerprint,
  });
  if (!rows.length) {
    issues.push({
      code: "no_results",
      severity: "warning",
      message: "The model returned no extraction rows for this paper",
    });
  }
  return { rows, issues, sourceSummary: source.summary };
}
