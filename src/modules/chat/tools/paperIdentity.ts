import type { ScholarlyPaper, ScholarlyProviderId } from "../../search";

export type IdentifierKind =
  | "zotero"
  | "doi"
  | "arxiv"
  | "pmid"
  | "pmcid"
  | "url"
  | "title"
  | ScholarlyProviderId;

export interface IdentifierKey {
  kind: IdentifierKind;
  value: string;
}

export interface ParsedPaperIdentifier {
  provider?: ScholarlyProviderId;
  nativeId?: string;
  keys: IdentifierKey[];
  searchText: string;
}

const PROVIDERS: ScholarlyProviderId[] = [
  "semantic-scholar",
  "arxiv",
  "pubmed",
  "biorxiv",
  "medrxiv",
  "iacr",
  "europe-pmc",
  "core",
  "base",
  "zenodo",
  "hal",
];

const PROVIDER_ALIASES: Record<string, ScholarlyProviderId> = {
  s2: "semantic-scholar",
  semanticscholar: "semantic-scholar",
  "semantic-scholar": "semantic-scholar",
  arxiv: "arxiv",
  pubmed: "pubmed",
  pmid: "pubmed",
  biorxiv: "biorxiv",
  medrxiv: "medrxiv",
  iacr: "iacr",
  epmc: "europe-pmc",
  europepmc: "europe-pmc",
  "europe-pmc": "europe-pmc",
  core: "core",
  base: "base",
  zenodo: "zenodo",
  hal: "hal",
};

function clean(value: unknown): string {
  return String(value || "").trim();
}

function pushUnique(
  keys: IdentifierKey[],
  kind: IdentifierKind,
  value: string,
) {
  const trimmed = clean(value);
  if (!trimmed) return;
  const key = { kind, value: trimmed };
  if (
    !keys.some((item) => item.kind === key.kind && item.value === key.value)
  ) {
    keys.push(key);
  }
}

export function identifierKeyString(key: IdentifierKey): string {
  return `${key.kind}:${key.value}`;
}

export function normalizeTitleForIdentity(value: unknown): string {
  return clean(value)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeDoiForIdentity(value: unknown): string {
  let doi = clean(value)
    .replace(/^doi:\s*/i, "")
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "")
    .trim();
  const match = doi.match(/10\.\d{4,9}\/\S+/i);
  doi = match ? match[0] : doi;
  return doi.replace(/[.;,\s]+$/g, "").toLowerCase();
}

export function normalizeArxivForIdentity(value: unknown): string {
  let id = clean(value)
    .replace(/^arxiv:\s*/i, "")
    .replace(/^https?:\/\/arxiv\.org\/(?:abs|pdf)\//i, "")
    .replace(/\.pdf$/i, "")
    .trim();
  const match =
    id.match(/\d{4}\.\d{4,5}(?:v\d+)?/i) ||
    id.match(/[a-z.-]+\/\d{7}(?:v\d+)?/i);
  id = match ? match[0] : id;
  return id.toLowerCase();
}

function normalizePmcid(value: unknown): string {
  const pmcid = clean(value).replace(/^pmcid:\s*/i, "");
  const match = pmcid.match(/PMC\d+/i);
  return (match ? match[0] : pmcid).toUpperCase();
}

function normalizePmid(value: unknown): string {
  const pmid = clean(value).replace(/^pmid:\s*/i, "");
  const match = pmid.match(/\d+/);
  return match ? match[0] : pmid;
}

function providerFromPrefix(prefix: string): ScholarlyProviderId | undefined {
  return PROVIDER_ALIASES[prefix.trim().toLowerCase()];
}

export function parsePaperIdentifier(
  value: unknown,
  preferredProvider?: ScholarlyProviderId,
): ParsedPaperIdentifier {
  const raw = clean(value);
  const keys: IdentifierKey[] = [];
  let body = raw;
  let provider = preferredProvider;

  const prefixed = raw.match(/^([a-z][a-z0-9_-]*):(.+)$/i);
  if (prefixed) {
    const detected = providerFromPrefix(prefixed[1]);
    if (detected) {
      provider = detected;
      body = prefixed[2].trim();
    }
  }

  const doi = normalizeDoiForIdentity(raw);
  if (/^10\.\d{4,9}\//i.test(doi)) {
    pushUnique(keys, "doi", doi);
  }

  const arxiv = normalizeArxivForIdentity(body);
  if (/^(?:\d{4}\.\d{4,5}|[a-z.-]+\/\d{7})(?:v\d+)?$/i.test(arxiv)) {
    pushUnique(keys, "arxiv", arxiv);
    pushUnique(keys, "arxiv", arxiv.replace(/v\d+$/i, ""));
    if (!provider) provider = "arxiv";
  }

  if (/pmcid[:\s]?/i.test(raw) || /^PMC\d+$/i.test(body)) {
    pushUnique(keys, "pmcid", normalizePmcid(body));
  }

  if (/pmid[:\s]?/i.test(raw)) {
    pushUnique(keys, "pmid", normalizePmid(body));
    if (!provider) provider = "pubmed";
  }

  if (/^https?:\/\//i.test(raw)) {
    pushUnique(keys, "url", raw.replace(/\/+$/g, ""));
  }

  if (provider) {
    pushUnique(keys, provider, body);
  }

  if (/^\d+$/.test(raw)) {
    pushUnique(keys, "zotero", raw);
    pushUnique(keys, "pmid", raw);
  }

  const title = normalizeTitleForIdentity(raw);
  if (title && title.length > 12 && !raw.includes(":")) {
    pushUnique(keys, "title", title);
  }

  if (!keys.length && raw) {
    pushUnique(keys, "title", title || raw.toLowerCase());
  }

  return {
    provider,
    nativeId: body,
    keys,
    searchText: body || raw,
  };
}

export function keysForScholarlyPaper(paper: ScholarlyPaper): IdentifierKey[] {
  const keys: IdentifierKey[] = [];
  pushUnique(keys, paper.source, paper.paperId.replace(`${paper.source}:`, ""));
  pushUnique(keys, paper.source, paper.providerIds?.[paper.source] || "");
  for (const provider of PROVIDERS) {
    pushUnique(keys, provider, paper.providerIds?.[provider] || "");
  }
  pushUnique(keys, "doi", normalizeDoiForIdentity(paper.externalIds?.DOI));
  pushUnique(
    keys,
    "arxiv",
    normalizeArxivForIdentity(paper.externalIds?.ArXiv),
  );
  pushUnique(
    keys,
    "arxiv",
    normalizeArxivForIdentity(paper.externalIds?.ArXiv).replace(/v\d+$/i, ""),
  );
  pushUnique(keys, "pmid", normalizePmid(paper.externalIds?.PMID));
  pushUnique(keys, "pmcid", normalizePmcid(paper.externalIds?.PMCID));
  pushUnique(keys, "url", paper.url?.replace(/\/+$/g, ""));
  pushUnique(keys, "title", normalizeTitleForIdentity(paper.title));
  return keys;
}

export function keysFromExtra(extra: unknown): IdentifierKey[] {
  const text = clean(extra);
  const keys: IdentifierKey[] = [];
  for (const match of text.matchAll(/(?:DOI|doi):\s*(10\.\d{4,9}\/\S+)/g)) {
    pushUnique(keys, "doi", normalizeDoiForIdentity(match[1]));
  }
  for (const match of text.matchAll(/PMID:\s*(\d+)/gi)) {
    pushUnique(keys, "pmid", normalizePmid(match[1]));
  }
  for (const match of text.matchAll(/PMCID:\s*(PMC\d+)/gi)) {
    pushUnique(keys, "pmcid", normalizePmcid(match[1]));
  }
  for (const match of text.matchAll(/arXiv:\s*([^\n]+)/gi)) {
    const arxiv = normalizeArxivForIdentity(match[1]);
    pushUnique(keys, "arxiv", arxiv);
    pushUnique(keys, "arxiv", arxiv.replace(/v\d+$/i, ""));
  }
  for (const match of text.matchAll(/IACR:\s*([^\n]+)/gi)) {
    pushUnique(keys, "iacr", clean(match[1]));
  }
  for (const match of text.matchAll(/HAL:\s*([^\n]+)/gi)) {
    pushUnique(keys, "hal", clean(match[1]));
  }
  for (const match of text.matchAll(/CORE:\s*([^\n]+)/gi)) {
    pushUnique(keys, "core", clean(match[1]));
  }
  for (const match of text.matchAll(/Zenodo:\s*([^\n]+)/gi)) {
    pushUnique(keys, "zenodo", clean(match[1]));
  }
  return keys;
}

export function keysForZoteroItemLike(item: {
  id?: number;
  getField: (field: string) => unknown;
}): IdentifierKey[] {
  const keys: IdentifierKey[] = [];
  if (typeof item.id === "number") pushUnique(keys, "zotero", String(item.id));
  pushUnique(keys, "doi", normalizeDoiForIdentity(item.getField("DOI")));
  pushUnique(keys, "url", clean(item.getField("url")).replace(/\/+$/g, ""));
  pushUnique(keys, "title", normalizeTitleForIdentity(item.getField("title")));
  for (const key of keysFromExtra(item.getField("extra"))) {
    pushUnique(keys, key.kind, key.value);
  }
  return keys;
}

export function identifiersOverlap(
  left: IdentifierKey[],
  right: IdentifierKey[],
): boolean {
  const values = new Set(left.map(identifierKeyString));
  return right.some((key) => values.has(identifierKeyString(key)));
}
