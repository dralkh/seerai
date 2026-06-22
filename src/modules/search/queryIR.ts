/**
 * Provider-agnostic intermediate representation (IR) of a search query.
 *
 * The AI "refine query" feature asks the model to extract this structure once
 * (concept groups + synonyms + exclusions), and deterministic per-provider
 * compilers ({@link ./queryCompiler}) render it into each source's native query
 * dialect. This keeps the LLM's job to semantic concept extraction rather than
 * memorising 11 different query syntaxes.
 */

/** A single concept: a set of synonyms OR-ed together. */
export interface ConceptGroup {
  /** Synonyms / alternates for the concept. `terms[0]` is the canonical term. */
  terms: string[];
  /**
   * Controlled-vocabulary (MeSH) descriptors for this concept. Only consumed by
   * the PubMed compiler, where they are OR-ed with the keyword side.
   */
  mesh?: string[];
  /**
   * When true, multi-word terms are rendered as quoted phrases where the target
   * dialect supports it.
   */
  phrase?: boolean;
}

/** Field scope hint for the whole query, applied where the provider supports it. */
export type QueryFieldScope = "all" | "title" | "abstract" | "title-abstract";

export interface SearchQueryIR {
  /** AND-ed concept groups; each group is an OR of its synonyms. */
  groups: ConceptGroup[];
  /** Terms to exclude (NOT) from results. */
  exclude?: string[];
  /** Where the query should apply when the provider supports field scoping. */
  field?: QueryFieldScope;
}

function cleanStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((v): v is string => typeof v === "string")
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
}

function normalizeGroup(value: unknown): ConceptGroup | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const terms = cleanStringArray(raw.terms);
  if (terms.length === 0) return null;
  const group: ConceptGroup = { terms };
  const mesh = cleanStringArray(raw.mesh);
  if (mesh.length > 0) group.mesh = mesh;
  if (raw.phrase === true) group.phrase = true;
  return group;
}

const FIELD_SCOPES: QueryFieldScope[] = [
  "all",
  "title",
  "abstract",
  "title-abstract",
];

/**
 * Defensively parse model output into a {@link SearchQueryIR}. Tolerates JSON
 * wrapped in markdown code fences or surrounded by prose. Returns `null` when no
 * usable structure can be recovered so callers can fall back to raw text.
 */
export function parseSearchQueryIR(raw: string): SearchQueryIR | null {
  if (typeof raw !== "string") return null;
  let text = raw.trim();
  if (!text) return null;

  // Strip markdown code fences if present.
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) text = fenced[1].trim();

  // Fall back to the first {...} block if the model added prose around it.
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start === -1 || end <= start) return null;
    try {
      parsed = JSON.parse(text.slice(start, end + 1));
    } catch {
      return null;
    }
  }

  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  const groups = Array.isArray(obj.groups)
    ? obj.groups
        .map(normalizeGroup)
        .filter((g): g is ConceptGroup => g !== null)
    : [];
  if (groups.length === 0) return null;

  const ir: SearchQueryIR = { groups };
  const exclude = cleanStringArray(obj.exclude);
  if (exclude.length > 0) ir.exclude = exclude;
  if (
    typeof obj.field === "string" &&
    FIELD_SCOPES.includes(obj.field as QueryFieldScope)
  ) {
    ir.field = obj.field as QueryFieldScope;
  }
  return ir;
}
