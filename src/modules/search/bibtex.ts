import { ScholarlyPaper } from "./types";

function escapeBibtex(value: string): string {
  return value
    .replace(/\\/g, "\\textbackslash{}")
    .replace(/([&%$#_{}])/g, "\\$1")
    .replace(/~/g, "\\textasciitilde{}")
    .replace(/\^/g, "\\textasciicircum{}")
    .replace(/\s+/g, " ")
    .trim();
}

function citeKeyBase(paper: ScholarlyPaper): string {
  const author = paper.authors[0]?.name || "unknown";
  const surname =
    author
      .split(/[,\s]+/)
      .filter(Boolean)
      .pop() || "unknown";
  const word = paper.title
    .split(/\s+/)
    .find((item) => item.replace(/[^\p{L}\p{N}]/gu, "").length > 2);
  return `${surname}${paper.year || "nd"}${word || "work"}`
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}]/gu, "")
    .toLowerCase();
}

function entryType(paper: ScholarlyPaper): string {
  const types = (paper.publicationTypes || []).map((value) =>
    value.toLowerCase(),
  );
  if (types.some((value) => value.includes("conference"))) {
    return "inproceedings";
  }
  if (types.some((value) => value === "book")) return "book";
  if (types.some((value) => value.includes("chapter"))) return "incollection";
  if (
    types.some((value) => value.includes("preprint")) ||
    ["arxiv", "biorxiv", "medrxiv", "iacr"].includes(paper.source)
  ) {
    return "misc";
  }
  return "article";
}

function collisionSuffix(index: number): string {
  let value = index;
  let suffix = "";
  while (value > 0) {
    value--;
    suffix = String.fromCharCode(97 + (value % 26)) + suffix;
    value = Math.floor(value / 26);
  }
  return suffix;
}

export function papersToBibtex(papers: ScholarlyPaper[]): string {
  const keys = new Map<string, number>();
  return papers
    .map((paper) => {
      const base = citeKeyBase(paper) || "unknown";
      const count = keys.get(base) || 0;
      keys.set(base, count + 1);
      const key = count === 0 ? base : `${base}${collisionSuffix(count)}`;
      const type = entryType(paper);
      const fields: Array<[string, string | undefined]> = [
        ["title", paper.title],
        ["author", paper.authors.map((author) => author.name).join(" and ")],
        ["year", paper.year ? String(paper.year) : undefined],
        ["date", paper.publicationDate],
        [type === "inproceedings" ? "booktitle" : "journal", paper.venue],
        ["publisher", paper.publisher],
        ["volume", paper.volume],
        ["number", paper.issue],
        ["pages", paper.pages],
        ["doi", paper.externalIds?.DOI],
        ["pmid", paper.externalIds?.PMID],
        ["pmcid", paper.externalIds?.PMCID],
        ["eprint", paper.externalIds?.ArXiv],
        ["url", paper.url],
        ["file", paper.openAccessPdf?.url],
        ["abstract", paper.abstract],
        ["keywords", paper.keywords?.join(", ")],
        ["license", paper.license],
        ["note", `Source: ${paper.sources.join(", ")}`],
      ];
      const presentFields = fields.filter((field): field is [string, string] =>
        Boolean(field[1]),
      );
      return `@${type}{${key},\n${presentFields
        .map(([name, value]) => `  ${name} = {${escapeBibtex(value)}},`)
        .join("\n")
        .replace(/,$/, "")}\n}`;
    })
    .join("\n\n");
}
