/**
 * Document Analyzer for Systematic Review Criteria
 *
 * Multi-step AI pipeline that extracts text from uploaded documents
 * (PDF, MD, DOCX) and progressively fills in the research framework
 * criteria: framework detection → field extraction → keywords & labels.
 */

import { convertDocxToMarkdown } from "../docxConverter";
import {
  FRAMEWORK_DEFS,
  ProtocolDimension,
  ProtocolRevision,
  ReviewProtocol,
  ExtractionTemplate,
  LabelDefinition,
  LlmChatCompletion,
  ProtocolGenerationContext,
  ProtocolGenerationResult,
  ProtocolGenerationStep,
  ScopeProposal,
  EligibilityProposal,
  MappingProposal,
  ProtocolProvenance,
  SearchStrategyProposal,
} from "./types";
import { openAIService } from "../openai";
import { z } from "zod";
import { modelConfidenceSchema } from "./modelOutput";
import { getActiveModelConfig } from "../chat/modelConfig";
import {
  createProtocolRevision,
  dimensionsForFramework,
  getActiveProtocolRevision,
  newEligibilityRule,
  validateProtocolRevision,
} from "./protocol";
import {
  proposeExtractionTemplate,
  proposeExtractionTemplateFromContext,
} from "./extractionWorkflow";
import type { ReviewCancellationSignal } from "./cancellation";
import type { SearchQueryIR, ConceptGroup } from "../search/queryIR";

export interface ExtractedDocument {
  fileName: string;
  text: string;
  charCount: number;
  error?: string;
}

export interface FrameworkResult {
  framework: string;
  reason: string;
}

export interface FieldExtractionResult {
  fields: Record<string, string>;
}

export interface KeywordsResult {
  incKeywords: string[];
  excKeywords: string[];
  suggestedLabels: { name: string; reason: string }[];
}

export interface AnalysisProgress {
  step: number;
  status: "pending" | "running" | "complete" | "error";
  result?: FrameworkResult | FieldExtractionResult | KeywordsResult;
  error?: string;
}

const MAX_DOC_CHARS = 80000;
const FrameworkSchema = z.object({
  framework: z.string(),
  reason: z.string(),
});
const FieldsSchema = z.object({
  fields: z.record(z.string(), z.string()),
});
const KeywordsSchema = z.object({
  incKeywords: z.array(z.string()).max(20),
  excKeywords: z.array(z.string()).max(20),
  suggestedLabels: z
    .array(z.object({ name: z.string(), reason: z.string() }))
    .max(20),
});

const ScopeStepSchema = z.object({
  researchQuestion: z.string(),
  framework: z.string(),
  frameworkReason: z.string(),
  dimensions: z.array(
    z.object({
      key: z.string(),
      value: z.string(),
      keywordAids: z.array(z.string()).max(20),
      evidenceLabels: z.array(z.string()).max(20),
      source: z.string().optional(),
      quote: z.string().optional(),
      confidence: modelConfidenceSchema.optional(),
    }),
  ),
});

const EligibilityStepSchema = z.object({
  inclusionRules: z.array(z.string()).max(30),
  exclusionRules: z.array(z.string()).max(30),
  includeKeywordAids: z.array(z.string()).max(30),
  excludeKeywordAids: z.array(z.string()).max(30),
  dimensionKeywordAids: z
    .record(z.string(), z.array(z.string()).max(20))
    .optional()
    .default({}),
});

const MappingStepSchema = z.object({
  evidenceLabels: z.record(z.string(), z.array(z.string()).max(20)),
});

async function callLLMForJSON(
  systemPrompt: string,
  userPrompt: string,
  llm?: LlmChatCompletion,
): Promise<Record<string, unknown> | null> {
  const chat = llm ?? openAIService.chatCompletion.bind(openAIService);
  try {
    const content = await chat(
      [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      { timeoutMs: 180000, isolated: true },
    );
    if (!content) {
      throw new Error("AI returned empty response");
    }
    const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const candidate = fenced?.[1] || content;
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start < 0 || end <= start) {
      throw new Error("AI returned no JSON object");
    }
    return JSON.parse(candidate.slice(start, end + 1));
  } catch (e) {
    if (typeof Zotero !== "undefined") {
      Zotero.debug(`[seerai] DocumentAnalyzer: LLM call error: ${e}`);
    }
    throw new Error(`AI analysis failed: ${(e as Error).message || String(e)}`);
  }
}

/** Turn a ZodError into a compact "field path: message" list for the user. */
export function formatZodIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
}

/**
 * Call the LLM for JSON and validate it against a schema, retrying on
 * validation failure by feeding the exact issues back to the model. On the
 * final failure it throws an Error whose message names the offending fields,
 * so the caller (and UI) can show *where* the response was malformed.
 */
export async function generateValidatedJSON<T>(
  systemPrompt: string,
  userPrompt: string,
  schema: z.ZodType<T>,
  options?: {
    llm?: LlmChatCompletion;
    signal?: ReviewCancellationSignal;
  },
  maxRetries = 2,
): Promise<T> {
  let lastError = "";
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const prompt =
      attempt === 0
        ? userPrompt
        : `${userPrompt}\n\nYour previous response failed validation:\n${lastError}\nReturn corrected JSON that fixes exactly these problems. Output only the JSON object.`;
    let response: Record<string, unknown> | null = null;
    try {
      response = await callLLMForJSON(systemPrompt, prompt, options?.llm);
    } catch (e) {
      lastError = (e as Error)?.message || String(e);
      if (typeof Zotero !== "undefined") {
        Zotero.debug(
          `[seerai] DocumentAnalyzer: generation error (attempt ${attempt + 1}/${maxRetries + 1}): ${lastError}`,
        );
      }
      if (attempt === maxRetries) {
        throw new Error(
          `AI generation failed after ${maxRetries + 1} attempts — ${lastError}`,
        );
      }
      continue;
    }
    if (!response) {
      lastError = "AI returned an empty response";
      if (attempt === maxRetries) throw new Error(lastError);
      continue;
    }
    const parsed = schema.safeParse(response);
    if (parsed.success) return parsed.data;
    lastError = formatZodIssues(parsed.error);
    if (typeof Zotero !== "undefined") {
      Zotero.debug(
        `[seerai] DocumentAnalyzer: validation failed (attempt ${attempt + 1}/${maxRetries + 1}): ${lastError}`,
      );
    }
  }
  throw new Error(
    `AI response failed validation after ${maxRetries + 1} attempts — ${lastError}`,
  );
}

export async function extractDocumentContent(
  filePath: string,
): Promise<ExtractedDocument> {
  const fileName = filePath.split(/[/\\]/).pop() || "unknown";
  const ext = fileName.split(".").pop()?.toLowerCase() || "";
  let text = "";

  try {
    const rawBytes = await IOUtils.read(filePath);
    const contentBytes = new Uint8Array(rawBytes);

    if (ext === "pdf") {
      try {
        const pdfWorker = (Zotero as any).PDFWorker as any;
        if (pdfWorker && pdfWorker._query && pdfWorker._enqueue) {
          const buf = contentBytes.buffer.slice(0);
          const pdfResult = await pdfWorker._enqueue(async () => {
            return await pdfWorker._query("getFulltext", { buf, maxPages: 0 }, [
              buf,
            ]);
          }, false);
          if (pdfResult && pdfResult.text && pdfResult.text.length > 0) {
            text = pdfResult.text;
          } else {
            return {
              fileName,
              text: "",
              charCount: 0,
              error:
                "PDF text extraction returned no content. The PDF may be image-based — try OCR in Zotero first.",
            };
          }
        } else {
          return {
            fileName,
            text: "",
            charCount: 0,
            error:
              "Zotero PDFWorker not available. Unable to extract PDF text.",
          };
        }
      } catch (pdfErr: any) {
        return {
          fileName,
          text: "",
          charCount: 0,
          error: `PDF extraction failed: ${pdfErr.message || pdfErr}`,
        };
      }
    } else if (ext === "docx") {
      const result = await convertDocxToMarkdown(contentBytes.buffer);
      text = result.markdown;
    } else if (ext === "md" || ext === "markdown" || ext === "txt") {
      try {
        text = await IOUtils.readUTF8(filePath);
      } catch {
        text = new TextDecoder("utf-8", { fatal: false }).decode(contentBytes);
      }
    } else {
      return {
        fileName,
        text: "",
        charCount: 0,
        error: `Unsupported file type: .${ext}. Supported: PDF, MD, DOCX`,
      };
    }

    if (!text || text.trim().length === 0) {
      return {
        fileName,
        text: "",
        charCount: 0,
        error: `No text content extracted from ${fileName}. File may be empty or unreadable.`,
      };
    }

    const charCount = text.length;
    if (text.length > MAX_DOC_CHARS) {
      text =
        text.substring(0, MAX_DOC_CHARS) +
        `\n\n[... truncated, ${text.length - MAX_DOC_CHARS} chars omitted ...]`;
    }

    return { fileName, text, charCount };
  } catch (e) {
    return {
      fileName,
      text: "",
      charCount: 0,
      error: `Failed to read file: ${(e as Error).message || String(e)}`,
    };
  }
}

function combineDocuments(docs: ExtractedDocument[]): string {
  return docs
    .map(
      (d) =>
        `=== DOCUMENT: ${d.fileName} ===\n${d.text}\n=== END: ${d.fileName} ===`,
    )
    .join("\n\n");
}

function normalizeEvidenceText(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

export async function proposeScope(
  documents: ExtractedDocument[],
  currentRevision: ProtocolRevision,
  options?: {
    llm?: LlmChatCompletion;
    signal?: ReviewCancellationSignal;
  },
): Promise<ScopeProposal> {
  const sourceText = combineDocuments(documents);
  const frameworkList = Object.entries(FRAMEWORK_DEFS)
    .map(
      ([key, def]) =>
        `${key}: ${def.fields
          .map((field) => `${field.k}=${field.label}`)
          .join(", ")}`,
    )
    .join("\n");
  const currentCriteria = currentRevision.dimensions
    .map((dimension) => `${dimension.label}: ${dimension.value}`)
    .join("\n");
  const generated = await generateValidatedJSON(
    "You design auditable systematic review protocols. Return valid JSON only. Select the framework that best matches the question rather than defaulting to PICO. Do not invent criteria. Ground document-derived fields with short verbatim quotes. Preserve useful current criteria when sources do not contradict them; you may replace or add values when sources suggest something better.",
    `Step 1 of 5 — Scope (research question, framework, dimensions).

Current research question:
${currentRevision.researchQuestion || "(not set)"}

Current framework: ${currentRevision.framework}
Current criteria:
${currentCriteria || "(no criteria set)"}

Supported frameworks:
${frameworkList}

Uploaded source documents:
${sourceText || "(none)"}

Return JSON with this exact shape:
{"researchQuestion":string,"framework":string,"frameworkReason":string,"dimensions":[{"key":string,"value":string,"keywordAids":string[],"evidenceLabels":string[],"source"?:string,"quote"?:string,"confidence"?:number}]}

Use only framework keys listed above. Return exactly one dimensions entry for every dimension in the selected framework.`,
    ScopeStepSchema,
    options,
  );
  const framework = FRAMEWORK_DEFS[generated.framework]
    ? generated.framework
    : currentRevision.framework;
  const generatedByKey = new Map(
    generated.dimensions.map((dimension) => [dimension.key, dimension]),
  );
  const dimensions: ProtocolDimension[] = dimensionsForFramework(
    framework,
    currentRevision.dimensions,
  ).map((dimension) => {
    const proposed = generatedByKey.get(dimension.key);
    return {
      ...dimension,
      value: proposed?.value.trim() || dimension.value,
      keywordAids: Array.from(
        new Set(
          (proposed?.keywordAids || dimension.keywordAids)
            .map((keyword) => keyword.trim().toLowerCase())
            .filter(Boolean),
        ),
      ),
      evidenceLabels: Array.from(
        new Set(proposed?.evidenceLabels || dimension.evidenceLabels),
      ),
    };
  });
  const normalizedSource = normalizeEvidenceText(sourceText);
  const provenance: ProtocolProvenance[] = generated.dimensions
    .filter(
      (dimension) =>
        dimension.quote &&
        normalizedSource.includes(normalizeEvidenceText(dimension.quote)),
    )
    .map((dimension) => ({
      field: `dimension.${dimension.key}`,
      source: dimension.source || "uploaded source",
      quote: dimension.quote,
      confidence: dimension.confidence,
    }));
  const warnings: string[] = [];
  const unverifiedQuotes = generated.dimensions.filter(
    (dimension) =>
      dimension.quote &&
      !normalizedSource.includes(normalizeEvidenceText(dimension.quote)),
  ).length;
  if (unverifiedQuotes > 0) {
    warnings.push(
      `${unverifiedQuotes} model source quote${unverifiedQuotes === 1 ? " was" : "s were"} not found in uploaded documents`,
    );
  }
  return {
    researchQuestion: generated.researchQuestion.trim(),
    framework,
    frameworkReason: generated.frameworkReason,
    dimensions,
    warnings,
    provenance,
  };
}

export async function proposeEligibility(
  scope: ScopeProposal,
  documents: ExtractedDocument[],
  currentRevision: ProtocolRevision,
  options?: {
    llm?: LlmChatCompletion;
    signal?: ReviewCancellationSignal;
  },
): Promise<EligibilityProposal> {
  const sourceText = combineDocuments(documents);
  const criteriaList = scope.dimensions
    .map(
      (dimension) =>
        `${dimension.key} · ${dimension.label}: ${dimension.value}`,
    )
    .join("\n");
  const existingInclude = currentRevision.eligibilityRules
    .filter((rule) => rule.type === "include")
    .map((rule) => rule.text);
  const existingExclude = currentRevision.eligibilityRules
    .filter((rule) => rule.type === "exclude")
    .map((rule) => rule.text);
  const generated = await generateValidatedJSON(
    "You design auditable systematic review eligibility criteria. Return valid JSON only. Use the supplied scope and source documents. Keep existing rules that are still well supported; you may add, remove, or rewrite rules when documents warrant it.",
    `Step 2 of 5 — Eligibility (inclusion/exclusion rules and keyword aids).

Research question: ${scope.researchQuestion}
Framework: ${scope.framework}

Scope criteria:
${criteriaList}

Existing inclusion rules:
${existingInclude.length ? existingInclude.map((text) => `- ${text}`).join("\n") : "(none)"}

Existing exclusion rules:
${existingExclude.length ? existingExclude.map((text) => `- ${text}`).join("\n") : "(none)"}

Existing include keyword aids: ${currentRevision.includeKeywordAids.join(", ") || "(none)"}
Existing exclude keyword aids: ${currentRevision.excludeKeywordAids.join(", ") || "(none)"}

Uploaded source documents:
${sourceText || "(none)"}

Return JSON:
{"inclusionRules":string[],"exclusionRules":string[],"includeKeywordAids":string[],"excludeKeywordAids":string[],"dimensionKeywordAids":{"<dimensionKey>":string[]}}`,
    EligibilityStepSchema,
    options,
  );
  return {
    inclusionRules: generated.inclusionRules
      .map((text) => text.trim())
      .filter(Boolean),
    exclusionRules: generated.exclusionRules
      .map((text) => text.trim())
      .filter(Boolean),
    includeKeywordAids: generated.includeKeywordAids
      .map((keyword) => keyword.trim().toLowerCase())
      .filter(Boolean),
    excludeKeywordAids: generated.excludeKeywordAids
      .map((keyword) => keyword.trim().toLowerCase())
      .filter(Boolean),
    dimensionKeywordAids: Object.fromEntries(
      Object.entries(generated.dimensionKeywordAids).map(([key, values]) => [
        key,
        values.map((value) => value.trim().toLowerCase()).filter(Boolean),
      ]),
    ),
  };
}

export async function proposeEvidenceMapping(
  scope: ScopeProposal,
  eligibility: EligibilityProposal,
  documents: ExtractedDocument[],
  labelDefs: LabelDefinition[],
  currentRevision: ProtocolRevision,
  options?: {
    llm?: LlmChatCompletion;
    signal?: ReviewCancellationSignal;
  },
): Promise<MappingProposal> {
  const sourceText = combineDocuments(documents);
  const allowedLabels = labelDefs
    .map((definition) => `${definition.k}=${definition.name}`)
    .join(", ");
  const existing = Object.fromEntries(
    currentRevision.dimensions.map((dimension) => [
      dimension.key,
      dimension.evidenceLabels,
    ]),
  );
  const generated = await generateValidatedJSON(
    "You connect each protocol dimension to evidence categories used by synthesis and gap analysis. Return valid JSON only. Pick only from the supplied label keys. Keep existing mappings that are still well supported; you may add or remove mappings when documents warrant it.",
    `Step 3 of 5 — Evidence mapping.

Research question: ${scope.researchQuestion}
Framework: ${scope.framework}

Scope criteria:
${scope.dimensions
  .map(
    (dimension) => `${dimension.key} · ${dimension.label}: ${dimension.value}`,
  )
  .join("\n")}

Eligibility rules:
${
  [...eligibility.inclusionRules, ...eligibility.exclusionRules]
    .map((rule) => `- ${rule}`)
    .join("\n") || "(none)"
}

Available evidence labels (use these keys only):
${allowedLabels || "(none configured)"}

Existing per-dimension mappings:
${Object.entries(existing)
  .map(([key, values]) => `${key}: ${values.join(", ") || "(none)"}`)
  .join("\n")}

Uploaded source documents:
${sourceText || "(none)"}

Return JSON:
{"evidenceLabels":{"<dimensionKey>":["labelKey1","labelKey2"]}}`,
    MappingStepSchema,
    options,
  );
  const allowed = new Set(labelDefs.map((definition) => definition.k));
  const filtered: Record<string, string[]> = {};
  for (const [key, values] of Object.entries(generated.evidenceLabels)) {
    filtered[key] = Array.from(
      new Set(values.filter((value) => allowed.has(value))),
    );
  }
  return { evidenceLabels: filtered };
}

const SEARCH_MODES = [
  "broad",
  "biomedical",
  "preprints",
  "cryptography",
  "repositories",
  "source",
] as const;

const VALID_FIELDS = ["all", "title", "abstract", "title-abstract"] as const;

/** Lenient schema: coerce/ default unknown enum values instead of throwing. */
export const SearchStrategyStepSchema = z.object({
  groups: z
    .array(
      z.object({
        terms: z.array(z.string()),
        mesh: z.array(z.string()).optional(),
        phrase: z.boolean().optional(),
      }),
    )
    .min(1),
  exclude: z.array(z.string()).optional(),
  field: z.enum(VALID_FIELDS).catch("all").optional(),
  recommendedMode: z.enum(SEARCH_MODES).catch("broad"),
  rationale: z.string().optional(),
});

export function normalizeStrategyIR(
  groups: {
    terms: string[];
    mesh?: string[];
    phrase?: boolean;
  }[],
): ConceptGroup[] {
  return groups
    .map((g) => {
      const terms = g.terms.map((t) => t.trim()).filter((t) => t.length > 0);
      if (terms.length === 0) return null;
      const group: ConceptGroup = { terms };
      const mesh = (g.mesh || [])
        .map((m) => m.trim())
        .filter((m) => m.length > 0);
      if (mesh.length > 0) group.mesh = mesh;
      if (g.phrase === true) group.phrase = true;
      return group;
    })
    .filter((g): g is ConceptGroup => g !== null);
}

export async function proposeSearchStrategy(
  scope: ScopeProposal,
  eligibility: EligibilityProposal,
  mapping: MappingProposal,
  currentRevision: ProtocolRevision,
  options?: {
    llm?: LlmChatCompletion;
    signal?: ReviewCancellationSignal;
  },
): Promise<SearchStrategyProposal> {
  const criteriaList = scope.dimensions
    .map(
      (dimension) =>
        `${dimension.key} · ${dimension.label}: ${dimension.value}`,
    )
    .join("\n");
  const includeKeywords = Array.from(
    new Set([
      ...scope.dimensions.flatMap((d) => d.keywordAids),
      ...eligibility.includeKeywordAids,
    ]),
  );
  const excludeKeywords = eligibility.excludeKeywordAids;
  const mappingLines = Object.entries(mapping.evidenceLabels)
    .map(([key, labels]) => `${key}: ${labels.join(", ") || "(none)"}`)
    .join("\n");
  const generated = await generateValidatedJSON(
    "You are a systematic review search strategist. Convert the review protocol into a structured, source-agnostic search specification that will be compiled into each database's native query dialect. Return valid JSON only.",
    `Step 5 of 5 — Search strategy.

Research question: ${scope.researchQuestion}
Framework: ${scope.framework}

Scope criteria:
${criteriaList}

Inclusion rules:
${eligibility.inclusionRules.map((r) => `- ${r}`).join("\n") || "(none)"}

Exclusion rules:
${eligibility.exclusionRules.map((r) => `- ${r}`).join("\n") || "(none)"}

Include keyword aids: ${includeKeywords.join(", ") || "(none)"}
Exclude keyword aids: ${excludeKeywords.join(", ") || "(none)"}

Evidence mappings:
${mappingLines || "(none)"}

Return JSON with this exact shape:
{"groups":[{"terms":["canonical","synonym","abbreviation"],"mesh":["MeSH Term"],"phrase":false}],"exclude":["term"],"field":"all","recommendedMode":"biomedical","rationale":"1-2 sentences"}

Rules:
- Each object in "groups" is ONE concept; its "terms" are synonyms that will be OR-ed together. Distinct concepts go in SEPARATE groups (groups are AND-ed).
- Put the most representative term first in each group's "terms".
- "mesh": include MeSH / controlled-vocabulary descriptors ONLY for biomedical concepts; omit otherwise.
- "exclude": concepts to remove from results, derived from exclusion criteria.
- "field": use "all" unless the protocol clearly implies title-only or abstract scope.
- "recommendedMode": choose from broad, biomedical, preprints, cryptography, repositories, source. Use "biomedical" for clinical/health questions, "preprints" for fast-moving research, "broad" for general/interdisciplinary, "repositories" for grey literature, "cryptography" for crypto/security, "source" only when a single source is clearly indicated.
- "rationale": explain the mode choice and key search decisions.`,
    SearchStrategyStepSchema,
    options,
  );
  const groups = normalizeStrategyIR(generated.groups);
  if (groups.length === 0) throw new Error("AI returned no concept groups");
  const ir: SearchQueryIR = { groups };
  const exclude = (generated.exclude || [])
    .map((e) => e.trim())
    .filter((e) => e.length > 0);
  if (exclude.length > 0) ir.exclude = exclude;
  if (generated.field) ir.field = generated.field;
  const warnings: string[] = [];
  if (groups.length < 2) {
    warnings.push(
      "Search strategy has only one concept group — consider adding more to improve specificity.",
    );
  }
  return {
    ir,
    recommendedMode: generated.recommendedMode,
    rationale: generated.rationale?.trim(),
    warnings,
    provenance: [],
  };
}

export interface RunProtocolGenerationInput {
  documents: ExtractedDocument[];
  baselineRevision?: ProtocolRevision;
  baselineTemplate?: ExtractionTemplate;
  labelDefs: LabelDefinition[];
  space: { protocol: ReviewProtocol };
  onStep?: (
    step: ProtocolGenerationStep,
    result: ProtocolGenerationResult,
  ) => void;
  /** When set, only these steps run; the rest keep their baseline values. */
  steps?: ProtocolGenerationStep[];
  options?: { llm?: LlmChatCompletion; signal?: ReviewCancellationSignal };
}

export async function runProtocolGeneration(
  input: RunProtocolGenerationInput,
): Promise<ProtocolGenerationResult> {
  const { documents, baselineTemplate, labelDefs, space, onStep, options } =
    input;
  const baselineRevision =
    input.baselineRevision ?? getActiveProtocolRevision(space.protocol);
  const result: ProtocolGenerationResult = {
    scope: {
      researchQuestion: baselineRevision.researchQuestion,
      framework: baselineRevision.framework,
      frameworkReason: baselineRevision.frameworkReason || "",
      dimensions: baselineRevision.dimensions,
      warnings: [],
      provenance: [],
    },
    eligibility: {
      inclusionRules: baselineRevision.eligibilityRules
        .filter((rule) => rule.type === "include")
        .map((rule) => rule.text),
      exclusionRules: baselineRevision.eligibilityRules
        .filter((rule) => rule.type === "exclude")
        .map((rule) => rule.text),
      includeKeywordAids: [...baselineRevision.includeKeywordAids],
      excludeKeywordAids: [...baselineRevision.excludeKeywordAids],
      dimensionKeywordAids: Object.fromEntries(
        baselineRevision.dimensions.map((dimension) => [
          dimension.key,
          [...dimension.keywordAids],
        ]),
      ),
    },
    mapping: {
      evidenceLabels: Object.fromEntries(
        baselineRevision.dimensions.map((dimension) => [
          dimension.key,
          [...dimension.evidenceLabels],
        ]),
      ),
    },
    template: baselineTemplate || emptyExtractionTemplate(baselineRevision),
    summary: {},
    errors: {},
  };
  // A step only runs when selected (or when no selection was given). Skipped
  // steps keep their baseline-seeded value, so a regenerated step still sees
  // every other step as context.
  const shouldRun = (step: ProtocolGenerationStep): boolean =>
    !input.steps || input.steps.includes(step);

  if (shouldRun("scope")) {
    try {
      result.scope = await proposeScope(documents, baselineRevision, options);
      result.summary.scope = `${result.scope.framework} · ${result.scope.dimensions.length} dimensions`;
      onStep?.("scope", result);
    } catch (error) {
      result.errors.scope =
        error instanceof Error ? error.message : String(error);
      onStep?.("scope", result);
    }
  }
  if (shouldRun("eligibility")) {
    try {
      result.eligibility = await proposeEligibility(
        result.scope,
        documents,
        baselineRevision,
        options,
      );
      result.summary.eligibility = `${result.eligibility.inclusionRules.length} include · ${result.eligibility.exclusionRules.length} exclude`;
      onStep?.("eligibility", result);
    } catch (error) {
      result.errors.eligibility =
        error instanceof Error ? error.message : String(error);
      onStep?.("eligibility", result);
    }
  }
  if (shouldRun("mapping")) {
    try {
      result.mapping = await proposeEvidenceMapping(
        result.scope,
        result.eligibility,
        documents,
        labelDefs,
        baselineRevision,
        options,
      );
      const labelCount = Object.values(result.mapping.evidenceLabels).reduce(
        (sum, values) => sum + values.length,
        0,
      );
      result.summary.mapping = `${labelCount} label mapping${labelCount === 1 ? "" : "s"}`;
      onStep?.("mapping", result);
    } catch (error) {
      result.errors.mapping =
        error instanceof Error ? error.message : String(error);
      onStep?.("mapping", result);
    }
  }
  if (shouldRun("template")) {
    try {
      result.template = await proposeExtractionTemplateFromContext(
        result.scope,
        result.eligibility,
        result.mapping,
        documents,
        baselineTemplate,
        baselineRevision.id,
        options,
      );
      result.summary.template = `${result.template.outcomes.length} outcome${result.template.outcomes.length === 1 ? "" : "s"}`;
      onStep?.("template", result);
    } catch (error) {
      result.errors.template =
        error instanceof Error ? error.message : String(error);
      onStep?.("template", result);
    }
  }
  if (shouldRun("search-strategy")) {
    try {
      result.searchStrategy = await proposeSearchStrategy(
        result.scope,
        result.eligibility,
        result.mapping,
        baselineRevision,
        options,
      );
      result.summary.searchStrategy = `${result.searchStrategy.ir.groups.length} concepts · ${result.searchStrategy.recommendedMode}`;
      onStep?.("search-strategy", result);
    } catch (error) {
      result.errors["search-strategy"] =
        error instanceof Error ? error.message : String(error);
      onStep?.("search-strategy", result);
    }
  }
  return result;
}

function emptyExtractionTemplate(
  baselineRevision: ProtocolRevision,
): ExtractionTemplate {
  const now = new Date().toISOString();
  return {
    id: `template_${Date.now()}`,
    revisionId: `template_${Date.now()}_r1`,
    protocolRevisionId: baselineRevision.id,
    name: "Extraction template",
    instructions: "",
    outcomes: [],
    status: "draft",
    source: "user",
    createdAt: now,
    updatedAt: now,
  };
}

export async function analyzeDocuments(
  documents: ExtractedDocument[],
  onProgress: (progress: AnalysisProgress[]) => void,
): Promise<{
  framework: string;
  frameworkReason: string;
  fields: Record<string, string>;
  incKeywords: string[];
  excKeywords: string[];
  suggestedLabels: { name: string; reason: string }[];
}> {
  const progress: AnalysisProgress[] = [
    { step: 1, status: "pending" },
    { step: 2, status: "pending" },
    { step: 3, status: "pending" },
  ];

  const combinedText = combineDocuments(documents);

  const frameworkList = Object.entries(FRAMEWORK_DEFS)
    .map(
      ([key, def]) =>
        `- ${def.label} (${key}): ${def.fields
          .map((f) => `${f.k}=${f.label}`)
          .join(", ")}`,
    )
    .join("\n");

  onProgress(progress);

  // ── Step 1: Framework Detection ──
  progress[0].status = "running";
  onProgress([...progress]);

  let detectedFramework = "PICOTS";
  let frameworkReason = "";

  try {
    const step1Result = await callLLMForJSON(
      `You are a systematic review methodology expert. You analyze research documents to determine the most appropriate evidence framework. Always respond with valid JSON only — no markdown, no explanations outside the JSON.`,
      `Analyze the following research document(s) and determine the MOST APPROPRIATE evidence framework from this list:\n\n${frameworkList}\n\nReturn JSON with:\n- "framework": the chosen framework key (e.g. "PICOTS", "PICO", "PECO", "SPICE", "PCC")\n- "reason": 1-2 sentence explanation why this framework fits the research question (cite specific text evidence from the document)\n\nIf the document does not describe a systematic review or clinical research question, use "PICOTS" as the default and explain why.\n\n${combinedText}`,
    );

    if (step1Result) {
      const parsed = FrameworkSchema.parse(step1Result);
      detectedFramework = parsed.framework || "PICOTS";
      frameworkReason = parsed.reason;

      if (!FRAMEWORK_DEFS[detectedFramework]) {
        detectedFramework = "PICOTS";
      }
    }

    progress[0].status = "complete";
    progress[0].result = {
      framework: detectedFramework,
      reason: frameworkReason,
    };
  } catch (e) {
    progress[0].status = "error";
    progress[0].error = (e as Error).message;
    onProgress([...progress]);
    throw e;
  }
  onProgress([...progress]);

  // ── Step 2: Field Extraction ──
  progress[1].status = "running";
  onProgress([...progress]);

  const frameworkDef = FRAMEWORK_DEFS[detectedFramework];
  const fieldDescriptions = frameworkDef.fields
    .map((f) => `- "${f.k}" (${f.label}): ${f.hint}`)
    .join("\n");

  const fields: Record<string, string> = {};

  try {
    const step2Result = await callLLMForJSON(
      `You extract structured research criteria from academic documents. Always respond with valid JSON only — no markdown, no explanations outside the JSON. Be specific and use direct quotes or concrete descriptions from the document. If a criterion is NOT mentioned in the document, set its value to an empty string "".`,
      `Using the "${frameworkDef.label}" framework, extract each criterion from the document(s) below.\n\nFields to populate:\n${fieldDescriptions}\n\nReturn JSON:\n{\n  "fields": { "${frameworkDef.fields.map((f) => f.k).join('": "...", "')}": "..." }\n}\n\nIMPORTANT:\n- Each value should be 1-3 sentences, specific and evidence-based\n- Use direct phrasing from the document where possible\n- Leave empty ("") if the document does not mention that criterion\n- Do NOT fabricate or assume missing criteria\n\n${combinedText}`,
    );

    if (step2Result) {
      const extractedFields = FieldsSchema.parse(step2Result).fields;
      frameworkDef.fields.forEach((f) => {
        fields[f.k] =
          typeof extractedFields[f.k] === "string"
            ? (extractedFields[f.k] as string)
            : "";
      });
    } else {
      frameworkDef.fields.forEach((f) => {
        fields[f.k] = "";
      });
    }

    progress[1].status = "complete";
    progress[1].result = { fields };
  } catch (e) {
    progress[1].status = "error";
    progress[1].error = (e as Error).message;
    onProgress([...progress]);
    frameworkDef.fields.forEach((f) => {
      fields[f.k] = "";
    });
  }
  onProgress([...progress]);

  // ── Step 3: Keywords & Labels ──
  progress[2].status = "running";
  onProgress([...progress]);

  let incKeywords: string[] = [];
  let excKeywords: string[] = [];
  let suggestedLabels: { name: string; reason: string }[] = [];

  try {
    const fieldsContext = Object.entries(fields)
      .filter(([, v]) => v)
      .map(([k, v]) => `${k}: ${v}`)
      .join("\n");

    const step3Result = await callLLMForJSON(
      `You are a systematic review keyword extraction expert. You generate inclusion/exclusion keywords for screening academic papers. Always respond with valid JSON only — no markdown, no explanations outside the JSON.`,
      `Based on the research document(s) and the extracted criteria below, generate screening keywords.\n\nExtracted Criteria:\n${fieldsContext || "(No criteria extracted yet)"}\n\nReturn JSON:\n{\n  "incKeywords": ["keyword1", "keyword2", ...],\n  "excKeywords": ["keyword1", "keyword2", ...],\n  "suggestedLabels": [\n    { "name": "RCT", "reason": "brief reason" },\n    { "name": "Meta-analysis", "reason": "brief reason" }\n  ]\n}\n\nGuidelines:\n- incKeywords: single words or short phrases (2-3 words max) that papers SHOULD contain. Lowercase. Be specific to the research question.\n- excKeywords: terms that indicate a paper should be EXCLUDED. Lowercase.\n- suggestedLabels: 3-5 study design/methodology labels relevant to this research. Each label should have a short name and a reason for suggesting it.\n- Generate 5-8 incKeywords, 4-6 excKeywords, and 3-5 suggestedLabels.\n\n${combinedText}`,
    );

    if (step3Result) {
      const parsed = KeywordsSchema.parse(step3Result);
      incKeywords = parsed.incKeywords.map((keyword) =>
        keyword.toLowerCase().trim(),
      );
      excKeywords = parsed.excKeywords.map((keyword) =>
        keyword.toLowerCase().trim(),
      );
      suggestedLabels = parsed.suggestedLabels;
    }

    progress[2].status = "complete";
    progress[2].result = {
      incKeywords,
      excKeywords,
      suggestedLabels,
    };
  } catch (e) {
    progress[2].status = "error";
    progress[2].error = (e as Error).message;
    onProgress([...progress]);
  }
  onProgress([...progress]);

  return {
    framework: detectedFramework,
    frameworkReason,
    fields,
    incKeywords,
    excKeywords,
    suggestedLabels,
  };
}
