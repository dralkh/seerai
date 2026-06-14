/**
 * Document Analyzer for Systematic Review Criteria
 *
 * Multi-step AI pipeline that extracts text from uploaded documents
 * (PDF, MD, DOCX) and progressively fills in the research framework
 * criteria: framework detection → field extraction → keywords & labels.
 */

import { convertDocxToMarkdown } from "../docxConverter";
import { FRAMEWORK_DEFS } from "./types";
import { ProtocolRevision, ReviewProtocol } from "./types";
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

const GeneratedProtocolSchema = z.object({
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
  inclusionRules: z.array(z.string()).max(30),
  exclusionRules: z.array(z.string()).max(30),
  includeKeywordAids: z.array(z.string()).max(30),
  excludeKeywordAids: z.array(z.string()).max(30),
});

async function callLLMForJSON(
  systemPrompt: string,
  userPrompt: string,
): Promise<Record<string, unknown> | null> {
  try {
    const content = await openAIService.chatCompletion([
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ]);
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
    Zotero.debug(`[seerai] DocumentAnalyzer: LLM call error: ${e}`);
    throw new Error(`AI analysis failed: ${(e as Error).message || String(e)}`);
  }
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

export async function generateProtocolRevision(
  documents: ExtractedDocument[],
  protocol: ReviewProtocol,
  evidenceLabels: { k: string; name: string }[],
): Promise<ProtocolRevision> {
  const current = getActiveProtocolRevision(protocol);
  const sourceText = combineDocuments(documents);
  const frameworkList = Object.entries(FRAMEWORK_DEFS)
    .map(
      ([key, def]) =>
        `${key}: ${def.fields
          .map((field) => `${field.k}=${field.label}`)
          .join(", ")}`,
    )
    .join("\n");
  const currentCriteria = current.dimensions
    .map((dimension) => `${dimension.label}: ${dimension.value}`)
    .join("\n");
  const response = await callLLMForJSON(
    "You design auditable systematic review protocols. Return valid JSON only. Select the framework that best matches the question rather than defaulting to PICO. Keywords are discovery and triage aids only and must never be described as screening decisions. Do not invent criteria. Ground document-derived fields with short verbatim quotes.",
    `Create one coherent review protocol from all available sources.

Current research question:
${current.researchQuestion || "(not set)"}

Current protocol:
Framework: ${current.framework}
${currentCriteria || "(no criteria set)"}

Supported frameworks:
${frameworkList}

Available evidence labels for synthesis and gap-analysis mappings:
${evidenceLabels.map((label) => `${label.k}=${label.name}`).join(", ")}

Uploaded source documents:
${sourceText || "(none)"}

Return:
{"researchQuestion":string,"framework":string,"frameworkReason":string,"dimensions":[{"key":string,"value":string,"keywordAids":string[],"evidenceLabels":string[],"source"?:string,"quote"?:string,"confidence"?:number}],"inclusionRules":string[],"exclusionRules":string[],"includeKeywordAids":string[],"excludeKeywordAids":string[]}

Use only framework keys listed above. Preserve useful current criteria when sources do not contradict them. Return exactly one dimensions entry for every dimension in the selected framework. For every dimension, select all scientifically relevant evidence labels from the supplied keys. Use an empty evidenceLabels array only when none of the available categories is appropriate; never force an unrelated mapping.`,
  );
  if (!response) throw new Error("AI returned no protocol");
  const generated = GeneratedProtocolSchema.parse(response);
  const framework = FRAMEWORK_DEFS[generated.framework]
    ? generated.framework
    : current.framework;
  const generatedByKey = new Map(
    generated.dimensions.map((dimension) => [dimension.key, dimension]),
  );
  const allowedLabels = new Set(evidenceLabels.map((label) => label.k));
  const dimensions = dimensionsForFramework(framework, current.dimensions).map(
    (dimension) => {
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
          new Set(
            (proposed?.evidenceLabels || dimension.evidenceLabels).filter(
              (label) => allowedLabels.has(label),
            ),
          ),
        ),
      };
    },
  );
  const normalizedSource = normalizeEvidenceText(sourceText);
  const provenance = generated.dimensions
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
  const revision = createProtocolRevision({
    actor: "model",
    model: getActiveModelConfig()?.model || "configured model",
    researchQuestion:
      generated.researchQuestion.trim() || current.researchQuestion,
    framework,
    frameworkReason: generated.frameworkReason,
    dimensions,
    eligibilityRules: [
      ...generated.inclusionRules
        .map((text) => text.trim())
        .filter(Boolean)
        .map((text) => newEligibilityRule("include", text)),
      ...generated.exclusionRules
        .map((text) => text.trim())
        .filter(Boolean)
        .map((text) => newEligibilityRule("exclude", text)),
    ],
    includeKeywordAids: generated.includeKeywordAids,
    excludeKeywordAids: generated.excludeKeywordAids,
    provenance,
    warnings: [],
  });
  revision.warnings = validateProtocolRevision(revision);
  const unverifiedQuotes = generated.dimensions.filter(
    (dimension) =>
      dimension.quote &&
      !normalizedSource.includes(normalizeEvidenceText(dimension.quote)),
  ).length;
  if (unverifiedQuotes > 0) {
    revision.warnings.push(
      `${unverifiedQuotes} model source quote${unverifiedQuotes === 1 ? " was" : "s were"} not found in uploaded documents`,
    );
  }
  const unmappedDimensions = revision.dimensions.filter(
    (dimension) => dimension.evidenceLabels.length === 0,
  );
  if (evidenceLabels.length > 0 && unmappedDimensions.length > 0) {
    revision.warnings.push(
      `No relevant evidence mapping was selected for: ${unmappedDimensions
        .map((dimension) => dimension.label)
        .join(", ")}`,
    );
  }
  return revision;
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
