import { ScholarlyPaper, ScholarlyProviderId } from "./types";

function normalizeDoi(value?: string): string {
  return (value || "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//, "")
    .replace(/^doi:\s*/, "");
}

function normalizeArxiv(value?: string): string {
  return (value || "")
    .trim()
    .toLowerCase()
    .replace(/^arxiv:/, "")
    .replace(/v\d+$/, "");
}

function normalizeText(value?: string): string {
  return (value || "")
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/**
 * Canonical title normalization shared by the in-memory dedup key and the
 * library-item index, so "Add to Zotero" reuse matching agrees with search-time
 * deduplication (collapses diacritics, case, and punctuation/whitespace).
 */
export function normalizeTitleForMatch(value?: string): string {
  return normalizeText(value);
}

/**
 * Canonical DOI normalization shared by the dedup key and the library-item
 * index (strips the doi.org/doi: prefixes and lower-cases), so a result whose
 * DOI is a full URL still matches a library item that stores the bare DOI.
 */
export function normalizeDoiForMatch(value?: string): string {
  return normalizeDoi(value);
}

export function getScholarlyPaperKey(paper: ScholarlyPaper): string {
  const doi = normalizeDoi(paper.externalIds?.DOI);
  if (doi) return `doi:${doi}`;
  if (paper.externalIds?.PMID) return `pmid:${paper.externalIds.PMID}`;
  const arxiv = normalizeArxiv(paper.externalIds?.ArXiv);
  if (arxiv) return `arxiv:${arxiv}`;
  const firstAuthor = normalizeText(paper.authors[0]?.name).split(" ").pop();
  if (!paper.year || !firstAuthor) return `provider:${paper.paperId}`;
  return `work:${normalizeText(paper.title)}:${paper.year || ""}:${firstAuthor || ""}`;
}

function richerString(a?: string, b?: string): string | undefined {
  if (!a) return b;
  if (!b) return a;
  return b.length > a.length ? b : a;
}

export function mergeScholarlyPapers(
  existing: ScholarlyPaper,
  incoming: ScholarlyPaper,
): ScholarlyPaper {
  const sources = Array.from(
    new Set([...existing.sources, ...incoming.sources]),
  );
  const citationCounts = {
    ...(existing.citationCounts || {}),
    ...(incoming.citationCounts || {}),
  };
  if (existing.citationCount) {
    citationCounts[existing.source] = existing.citationCount;
  }
  if (incoming.citationCount) {
    citationCounts[incoming.source] = incoming.citationCount;
  }
  return {
    ...existing,
    abstract: richerString(existing.abstract, incoming.abstract),
    authors:
      incoming.authors.length > existing.authors.length
        ? incoming.authors
        : existing.authors,
    year: existing.year || incoming.year,
    publicationDate: existing.publicationDate || incoming.publicationDate,
    updatedDate: incoming.updatedDate || existing.updatedDate,
    citationCount: Math.max(existing.citationCount, incoming.citationCount),
    citationCounts,
    openAccessPdf: existing.openAccessPdf || incoming.openAccessPdf,
    url: existing.url || incoming.url,
    venue: richerString(existing.venue, incoming.venue),
    publisher: richerString(existing.publisher, incoming.publisher),
    volume: existing.volume || incoming.volume,
    issue: existing.issue || incoming.issue,
    pages: existing.pages || incoming.pages,
    publicationTypes: Array.from(
      new Set([
        ...(existing.publicationTypes || []),
        ...(incoming.publicationTypes || []),
      ]),
    ),
    fieldsOfStudy: Array.from(
      new Set([
        ...(existing.fieldsOfStudy || []),
        ...(incoming.fieldsOfStudy || []),
      ]),
    ),
    keywords: Array.from(
      new Set([...(existing.keywords || []), ...(incoming.keywords || [])]),
    ),
    license: existing.license || incoming.license,
    externalIds: { ...incoming.externalIds, ...existing.externalIds },
    providerIds: { ...existing.providerIds, ...incoming.providerIds },
    sources,
  };
}

export function reciprocalRankFusion(
  ranked: Partial<Record<ScholarlyProviderId, ScholarlyPaper[]>>,
): ScholarlyPaper[] {
  const byKey = new Map<
    string,
    { paper: ScholarlyPaper; score: number; bestRank: number }
  >();
  for (const papers of Object.values(ranked)) {
    if (!papers) continue;
    papers.forEach((paper, index) => {
      const key = getScholarlyPaperKey(paper);
      const current = byKey.get(key);
      const score = 1 / (60 + index + 1);
      if (current) {
        current.paper = mergeScholarlyPapers(current.paper, paper);
        current.score += score;
        current.bestRank = Math.min(current.bestRank, index);
      } else {
        byKey.set(key, { paper, score, bestRank: index });
      }
    });
  }
  return Array.from(byKey.values())
    .sort((a, b) => b.score - a.score || a.bestRank - b.bestRank)
    .map((entry) => entry.paper);
}

export function deduplicateScholarlyPapers(
  papers: ScholarlyPaper[],
): ScholarlyPaper[] {
  const result = new Map<string, ScholarlyPaper>();
  for (const paper of papers) {
    const key = getScholarlyPaperKey(paper);
    const existing = result.get(key);
    result.set(key, existing ? mergeScholarlyPapers(existing, paper) : paper);
  }
  return Array.from(result.values());
}
