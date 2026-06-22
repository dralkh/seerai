/**
 * Deterministic per-provider query compilers.
 *
 * Each scholarly source speaks a different query dialect. A single refined
 * string therefore cannot be correct for every provider a smart mode fans out
 * to. These compilers render a provider-agnostic {@link SearchQueryIR} into the
 * native syntax of each provider, so the LLM only has to extract concepts once.
 *
 * Compilers emit ONLY the textual query part. Year ranges, open-access flags,
 * categories and article types stay on `query.filters` / `query.providerFilters`
 * and continue to be appended by the provider code in {@link ./providers}.
 */
import { ScholarlyProviderId } from "./types";
import { ConceptGroup, QueryFieldScope, SearchQueryIR } from "./queryIR";
import { PROVIDER_FILTERS } from "./filterOptions";

/** Valid arXiv field-prefix values, sourced from the filter registry so they cannot drift. */
const ARXIV_FIELDS = new Set(
  (PROVIDER_FILTERS.arxiv?.specs.find((s) => s.key === "field")?.options || [])
    .map((o) => o.value)
    .filter((v): v is string => typeof v === "string"),
);

function isPhrase(term: string): boolean {
  return /\s/.test(term.trim());
}

function quote(term: string): string {
  return `"${term.replace(/"/g, "")}"`;
}

/** Render a term, quoting multi-word phrases when the group requests it. */
function renderTerm(term: string, group: ConceptGroup): string {
  const t = term.trim();
  if (group.phrase !== false && isPhrase(t)) return quote(t);
  return t;
}

// === Semantic Scholar (live relevance): NO operators, quoted phrases only ===
function compileSemanticScholar(ir: SearchQueryIR): string {
  // SS relevance search does not support boolean operators or wildcards, so we
  // emit the canonical term of each concept (quoted when it is a phrase). Synonym
  // alternation and exclusions cannot be expressed and are intentionally dropped.
  return ir.groups
    .map((g) => renderTerm(g.terms[0], g))
    .filter(Boolean)
    .join(" ")
    .trim();
}

// === arXiv: uppercase AND / OR / ANDNOT, field prefixes, parentheses ===
function arxivPrefix(field?: QueryFieldScope): string {
  const map: Record<QueryFieldScope, string> = {
    all: "all",
    title: "ti",
    abstract: "abs",
    "title-abstract": "all", // arXiv has no combined tiab field
  };
  const prefix = map[field || "all"];
  return ARXIV_FIELDS.has(prefix) ? prefix : "all";
}

function compileArxiv(ir: SearchQueryIR): string {
  const prefix = arxivPrefix(ir.field);
  const groups = ir.groups
    .map((g) => {
      const parts = g.terms.map((t) => `${prefix}:${renderTerm(t, g)}`);
      return parts.length > 1 ? `(${parts.join(" OR ")})` : parts[0];
    })
    .filter(Boolean);
  let out = groups.join(" AND ");
  for (const term of ir.exclude || []) {
    out += `${out ? " " : ""}ANDNOT ${prefix}:${isPhrase(term) ? quote(term) : term.trim()}`;
  }
  return out.trim();
}

// === PubMed: AND / OR / NOT, [tiab]/[ti]/[ab] field tags, [mesh] descriptors ===
function pubmedTag(field?: QueryFieldScope): string {
  switch (field) {
    case "title":
      return "[ti]";
    case "abstract":
      return "[ab]";
    case "title-abstract":
      return "[tiab]";
    default:
      return ""; // "all" => no tag (automatic term mapping across all fields)
  }
}

function compilePubmed(ir: SearchQueryIR): string {
  const tag = pubmedTag(ir.field);
  const groups = ir.groups
    .map((g) => {
      const parts = g.terms.map((t) => `${renderTerm(t, g)}${tag}`);
      // MeSH side is OR-ed with the keyword side so recall never drops below
      // keyword-only even if a descriptor does not exist.
      for (const m of g.mesh || []) parts.push(`${quote(m)}[mesh]`);
      return parts.length > 1 ? `(${parts.join(" OR ")})` : parts[0];
    })
    .filter(Boolean);
  let out = groups.join(" AND ");
  for (const term of ir.exclude || []) {
    out += `${out ? " " : ""}NOT ${isPhrase(term) ? quote(term) : term.trim()}${tag}`;
  }
  return out.trim();
}

// === Europe PMC (also bioRxiv/medRxiv keyword mode): AND/OR/NOT, TITLE:/ABSTRACT: ===
function europePmcField(field?: QueryFieldScope): string {
  switch (field) {
    case "title":
      return "TITLE:";
    case "abstract":
      return "ABSTRACT:";
    default:
      return ""; // default searches across multiple fields
  }
}

function compileEuropePmc(ir: SearchQueryIR): string {
  const field = europePmcField(ir.field);
  const groups = ir.groups
    .map((g) => {
      const parts = g.terms.map((t) => `${field}${renderTerm(t, g)}`);
      return parts.length > 1 ? `(${parts.join(" OR ")})` : parts[0];
    })
    .filter(Boolean);
  let out = groups.join(" AND ");
  for (const term of ir.exclude || []) {
    out += `${out ? " " : ""}NOT ${field}${isPhrase(term) ? quote(term) : term.trim()}`;
  }
  return out.trim();
}

// === Lucene / Solr / Elasticsearch query_string (CORE, Zenodo, HAL) ===
// Field names differ per provider, so we target the default text field and only
// use portable query_string structure (grouping, AND/OR/NOT, quotes).
function compileLucene(ir: SearchQueryIR): string {
  const groups = ir.groups
    .map((g) => {
      const parts = g.terms.map((t) => renderTerm(t, g));
      return parts.length > 1 ? `(${parts.join(" OR ")})` : parts[0];
    })
    .filter(Boolean);
  let out = groups.join(" AND ");
  for (const term of ir.exclude || []) {
    out += `${out ? " " : ""}NOT ${isPhrase(term) ? quote(term) : term.trim()}`;
  }
  return out.trim();
}

// === Plain keyword (BASE, IACR): no operator support ===
function compilePlain(ir: SearchQueryIR): string {
  return ir.groups
    .map((g) => renderTerm(g.terms[0], g))
    .filter(Boolean)
    .join(" ")
    .trim();
}

/** Render the IR into a single provider's native query string. */
export function compileQuery(
  ir: SearchQueryIR,
  provider: ScholarlyProviderId,
): string {
  switch (provider) {
    case "semantic-scholar":
      return compileSemanticScholar(ir);
    case "arxiv":
      return compileArxiv(ir);
    case "pubmed":
      return compilePubmed(ir);
    case "europe-pmc":
    case "biorxiv":
    case "medrxiv":
      return compileEuropePmc(ir);
    case "core":
    case "zenodo":
    case "hal":
      return compileLucene(ir);
    case "base":
    case "iacr":
      return compilePlain(ir);
    default:
      return compilePlain(ir);
  }
}

/** Compile the IR for every provider a mode fans out to. */
export function compileQueriesForProviders(
  ir: SearchQueryIR,
  providers: ScholarlyProviderId[],
): Partial<Record<ScholarlyProviderId, string>> {
  const result: Partial<Record<ScholarlyProviderId, string>> = {};
  for (const provider of providers) {
    result[provider] = compileQuery(ir, provider);
  }
  return result;
}
