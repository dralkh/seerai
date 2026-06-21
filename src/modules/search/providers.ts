import { getPref } from "../../utils/prefs";
import { semanticScholarService } from "../semanticScholar";
import { scholarlyFetch, responseJson, ProviderRequestError } from "./http";
import { createDOMParser } from "./env";
import {
  ProviderCapabilities,
  ProviderConnectionResult,
  ProviderPage,
  ScholarlyPaper,
  ScholarlyProviderId,
  ScholarlySearchProvider,
  ScholarlySearchQuery,
} from "./types";

const capabilities: Record<ScholarlyProviderId, ProviderCapabilities> = {
  "semantic-scholar": {
    id: "semantic-scholar",
    label: "Semantic Scholar",
    description: "Broad relevance search with citation and field metadata.",
    queryKind: "keyword",
    supportsAutocomplete: true,
    supportsOpenAccess: true,
    supportsPdfFilter: true,
    supportsYearRange: true,
    supportsCitationSort: true,
    supportsBulk: true,
    maxBulkResults: 2000,
  },
  arxiv: {
    id: "arxiv",
    label: "arXiv",
    description: "Physics, mathematics, computing, and related preprints.",
    queryKind: "keyword",
    supportsPdfFilter: true,
    supportsYearRange: true,
    supportsBulk: true,
    maxBulkResults: 2000,
  },
  pubmed: {
    id: "pubmed",
    label: "PubMed",
    description: "Biomedical and life-science journal literature.",
    queryKind: "keyword",
    supportsYearRange: true,
    supportsBulk: true,
    maxBulkResults: 2000,
  },
  biorxiv: {
    id: "biorxiv",
    label: "bioRxiv",
    description: "Biology preprints with keyword and recent-feed modes.",
    queryKind: "keyword-or-browse",
    supportsOpenAccess: true,
    supportsPdfFilter: true,
    supportsYearRange: true,
    supportsBulk: true,
    maxBulkResults: 2000,
  },
  medrxiv: {
    id: "medrxiv",
    label: "medRxiv",
    description: "Health-science preprints with keyword and recent-feed modes.",
    queryKind: "keyword-or-browse",
    supportsOpenAccess: true,
    supportsPdfFilter: true,
    supportsYearRange: true,
    supportsBulk: true,
    maxBulkResults: 2000,
  },
  iacr: {
    id: "iacr",
    label: "IACR ePrint",
    description: "Cryptology ePrint Archive search.",
    queryKind: "keyword",
    supportsPdfFilter: true,
    supportsBulk: false,
    maxBulkResults: 100,
    experimental: true,
  },
  "europe-pmc": {
    id: "europe-pmc",
    label: "Europe PMC",
    description: "Biomedical publications, preprints, citations, and OA links.",
    queryKind: "keyword",
    supportsOpenAccess: true,
    supportsPdfFilter: true,
    supportsYearRange: true,
    supportsCitationSort: true,
    supportsBulk: true,
    maxBulkResults: 2000,
  },
  core: {
    id: "core",
    label: "CORE",
    description: "Open-access repository aggregation and full-text discovery.",
    queryKind: "keyword",
    supportsOpenAccess: true,
    supportsPdfFilter: true,
    supportsYearRange: true,
    supportsBulk: true,
    maxBulkResults: 2000,
    authentication: "optional",
  },
  base: {
    id: "base",
    label: "BASE",
    description: "Registered access to the Bielefeld Academic Search Engine.",
    queryKind: "keyword",
    supportsOpenAccess: true,
    supportsYearRange: true,
    supportsBulk: true,
    maxBulkResults: 2000,
    requiresConfiguration: true,
  },
  zenodo: {
    id: "zenodo",
    label: "Zenodo",
    description: "Open research publications and repository records.",
    queryKind: "keyword",
    supportsOpenAccess: true,
    supportsPdfFilter: true,
    supportsYearRange: true,
    supportsBulk: true,
    maxBulkResults: 2000,
  },
  hal: {
    id: "hal",
    label: "HAL",
    description: "France's multidisciplinary open research archive.",
    queryKind: "keyword",
    supportsOpenAccess: true,
    supportsPdfFilter: true,
    supportsYearRange: true,
    supportsBulk: true,
    maxBulkResults: 2000,
  },
};

function yearRange(query: ScholarlySearchQuery): string | undefined {
  const start = query.filters.yearStart || "";
  const end = query.filters.yearEnd || "";
  return start || end ? `${start}-${end}` : undefined;
}

function parseDate(value?: string): { date?: string; year?: number } {
  if (!value) return {};
  const match = value.match(/\d{4}/);
  return { date: value, year: match ? Number(match[0]) : undefined };
}

function paper(
  source: ScholarlyProviderId,
  nativeId: string,
  value: Partial<ScholarlyPaper> & Pick<ScholarlyPaper, "title" | "url">,
): ScholarlyPaper {
  return {
    paperId: `${source}:${nativeId}`,
    source,
    sources: [source],
    authors: value.authors || [],
    citationCount: value.citationCount || 0,
    providerIds: { [source]: nativeId },
    ...value,
    title: value.title.trim(),
    url: value.url,
  };
}

function text(element: Element | null): string {
  return element?.textContent?.replace(/\s+/g, " ").trim() || "";
}

function elements(parent: ParentNode, localName: string): Element[] {
  return Array.from((parent as Element).getElementsByTagNameNS("*", localName));
}

class SemanticScholarProvider implements ScholarlySearchProvider {
  readonly capabilities = capabilities["semantic-scholar"];
  isConfigured(): boolean {
    return true;
  }
  async search(
    query: ScholarlySearchQuery,
    cursor: string | undefined,
  ): Promise<ProviderPage> {
    const offset = Number(cursor || 0);
    const result = await semanticScholarService.searchPapers({
      query: query.text,
      limit: Math.min(query.limit, 100),
      offset,
      year: yearRange(query),
      openAccessPdf:
        query.filters.openAccess || query.filters.hasPdf || undefined,
      fieldsOfStudy: query.filters.fieldsOfStudy,
      publicationTypes: query.filters.publicationTypes,
      minCitationCount: query.filters.minCitationCount,
      venue: query.filters.venue,
    });
    const data = Array.isArray(result.data) ? result.data : [];
    const items = data.map((item) => ({
      ...item,
      source: "semantic-scholar" as const,
      sources: ["semantic-scholar" as const],
      providerIds: { "semantic-scholar": item.paperId },
    }));
    const total = result.total || 0;
    const next = offset + items.length;
    return {
      items,
      total,
      cursor: items.length ? String(next) : undefined,
      exhausted: items.length === 0 || next >= Math.min(total, 1000),
    };
  }

  async bulkSearch(
    query: ScholarlySearchQuery,
    cursor: string | undefined,
  ): Promise<ProviderPage> {
    const result = await semanticScholarService.searchPapersBulk(
      {
        query: query.text,
        limit: Math.min(query.limit, 1000),
        year: yearRange(query),
        openAccessPdf:
          query.filters.openAccess || query.filters.hasPdf || undefined,
        fieldsOfStudy: query.filters.fieldsOfStudy,
        publicationTypes: query.filters.publicationTypes,
        minCitationCount: query.filters.minCitationCount,
        venue: query.filters.venue,
        sort:
          query.sort === "newest"
            ? "publicationDate:desc"
            : query.sort === "oldest"
              ? "publicationDate:asc"
              : query.sort === "citations"
                ? "citationCount:desc"
                : undefined,
      },
      cursor,
    );
    const data = Array.isArray(result.data) ? result.data : [];
    return {
      items: data.map((item) => ({
        ...item,
        source: "semantic-scholar" as const,
        sources: ["semantic-scholar" as const],
        providerIds: { "semantic-scholar": item.paperId },
      })),
      total: result.total || 0,
      cursor: result.token,
      exhausted: !result.token || data.length === 0,
      warnings: ["Bulk export order may differ from relevance search."],
    };
  }
}

class ArxivProvider implements ScholarlySearchProvider {
  readonly capabilities = capabilities.arxiv;
  isConfigured(): boolean {
    return true;
  }
  async search(
    query: ScholarlySearchQuery,
    cursor: string | undefined,
    context: { signal?: AbortSignal },
  ): Promise<ProviderPage> {
    const start = Number(cursor || 0);
    const filters = query.providerFilters.arxiv || {};
    const field = String(filters.field || "all");
    const category = String(filters.category || "");
    let search = `${field}:${query.text}`;
    if (category) search += ` AND cat:${category}`;
    if (query.filters.yearStart || query.filters.yearEnd) {
      const from = `${query.filters.yearStart || "0000"}01010000`;
      const to = `${query.filters.yearEnd || "9999"}12312359`;
      search += ` AND submittedDate:[${from} TO ${to}]`;
    }
    const params = new URLSearchParams({
      search_query: search,
      start: String(start),
      max_results: String(Math.min(query.limit, 100)),
      sortBy:
        query.sort === "newest" || query.sort === "oldest"
          ? "submittedDate"
          : "relevance",
      sortOrder: query.sort === "oldest" ? "ascending" : "descending",
    });
    const response = await scholarlyFetch(
      "arxiv",
      `https://export.arxiv.org/api/query?${params}`,
      { signal: context.signal },
      { minIntervalMs: 3000 },
    );
    const doc = createDOMParser().parseFromString(
      await response.text(),
      "text/xml",
    );
    const total =
      Number(text(doc.getElementsByTagNameNS("*", "totalResults")[0])) || 0;
    const items = elements(doc, "entry").map((entry) => {
      const idUrl = text(entry.getElementsByTagNameNS("*", "id")[0]);
      const nativeId = idUrl.split("/abs/").pop() || idUrl;
      const published = text(entry.getElementsByTagNameNS("*", "published")[0]);
      const updated = text(entry.getElementsByTagNameNS("*", "updated")[0]);
      const links = elements(entry, "link");
      const pdf = links
        .find((link) => link.getAttribute("type") === "application/pdf")
        ?.getAttribute("href");
      const doi = text(entry.getElementsByTagNameNS("*", "doi")[0]);
      return paper("arxiv", nativeId, {
        title: text(entry.getElementsByTagNameNS("*", "title")[0]),
        abstract: text(entry.getElementsByTagNameNS("*", "summary")[0]),
        authors: elements(entry, "author").map((author) => ({
          name: text(author.getElementsByTagNameNS("*", "name")[0]),
        })),
        ...parseDate(published),
        updatedDate: updated,
        url: idUrl.replace("http://", "https://"),
        openAccessPdf: pdf
          ? { url: pdf.replace("http://", "https://") }
          : undefined,
        publicationTypes: ["Preprint"],
        fieldsOfStudy: elements(entry, "category")
          .map((category) => category.getAttribute("term") || "")
          .filter(Boolean),
        externalIds: { ArXiv: nativeId, DOI: doi || undefined },
      });
    });
    const next = start + items.length;
    return {
      items,
      total,
      cursor: items.length ? String(next) : undefined,
      exhausted: items.length === 0 || next >= total,
    };
  }
}

interface PubmedSearchResponse {
  esearchresult: {
    count: string;
    idlist: string[];
    querykey?: string;
    webenv?: string;
  };
}

interface PubmedCursor {
  retstart: number;
  total: number;
  queryKey: string;
  webEnv: string;
}

class PubmedProvider implements ScholarlySearchProvider {
  readonly capabilities = capabilities.pubmed;
  isConfigured(): boolean {
    return true;
  }
  async search(
    query: ScholarlySearchQuery,
    cursor: string | undefined,
    context: { signal?: AbortSignal },
  ): Promise<ProviderPage> {
    let history: PubmedCursor | undefined;
    if (cursor) {
      try {
        history = JSON.parse(cursor) as PubmedCursor;
      } catch {
        history = undefined;
      }
    }
    const retstart = history?.retstart || 0;
    const apiKey = String(getPref("ncbiApiKey" as never) || "");
    const email = String(getPref("scholarlySearchEmail" as never) || "");
    let term = query.text;
    if (query.filters.yearStart || query.filters.yearEnd) {
      term += ` AND (${query.filters.yearStart || "1000"}[PDAT] : ${query.filters.yearEnd || "3000"}[PDAT])`;
    }
    const articleType = String(query.providerFilters.pubmed?.articleType || "");
    if (articleType) term += ` AND ${articleType}[PT]`;
    const interval = apiKey ? 110 : 350;
    if (!history) {
      const params = new URLSearchParams({
        db: "pubmed",
        term,
        retmax: "0",
        retmode: "json",
        usehistory: "y",
        sort: query.sort === "newest" ? "pub_date" : "relevance",
        tool: "seerai",
      });
      if (apiKey) params.set("api_key", apiKey);
      if (email) params.set("email", email);
      const searchResponse = await scholarlyFetch(
        "pubmed",
        `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?${params}`,
        { signal: context.signal },
        { minIntervalMs: interval },
      );
      const search = await responseJson<PubmedSearchResponse>(searchResponse);
      history = {
        retstart: 0,
        total: Number(search.esearchresult?.count) || 0,
        queryKey: search.esearchresult?.querykey || "",
        webEnv: search.esearchresult?.webenv || "",
      };
      if (!history.total || !history.queryKey || !history.webEnv) {
        return { items: [], total: history.total, exhausted: true };
      }
    }
    const fetchParams = new URLSearchParams({
      db: "pubmed",
      query_key: history.queryKey,
      WebEnv: history.webEnv,
      retstart: String(retstart),
      retmax: String(Math.min(query.limit, 200)),
      retmode: "xml",
      tool: "seerai",
    });
    if (apiKey) fetchParams.set("api_key", apiKey);
    if (email) fetchParams.set("email", email);
    const fetchResponse = await scholarlyFetch(
      "pubmed",
      `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?${fetchParams}`,
      { signal: context.signal },
      { minIntervalMs: interval },
    );
    const doc = createDOMParser().parseFromString(
      await fetchResponse.text(),
      "text/xml",
    );
    const articles = Array.from(
      doc.getElementsByTagName("PubmedArticle"),
    ) as Element[];
    const items = articles.map((article) => {
      const pmid = text(article.querySelector("PMID"));
      const title = text(article.querySelector("ArticleTitle"));
      const abstract = (
        Array.from(article.querySelectorAll("AbstractText")) as Element[]
      )
        .map(text)
        .join(" ");
      const authors = (
        Array.from(article.querySelectorAll("Author")) as Element[]
      )
        .map((author) => {
          const collective = text(author.querySelector("CollectiveName"));
          const name =
            collective ||
            [
              text(author.querySelector("ForeName")),
              text(author.querySelector("LastName")),
            ]
              .filter(Boolean)
              .join(" ");
          return name ? { name } : null;
        })
        .filter((author): author is { name: string } => Boolean(author));
      const ids = Array.from(
        article.querySelectorAll("ArticleId"),
      ) as Element[];
      const doi = text(
        ids.find((id) => id.getAttribute("IdType") === "doi") || null,
      );
      const pmcid = text(
        ids.find((id) => id.getAttribute("IdType") === "pmc") || null,
      );
      const date =
        text(article.querySelector("ArticleDate")) ||
        text(article.querySelector("PubDate"));
      const year =
        Number(text(article.querySelector("PubDate > Year"))) ||
        Number(date.match(/\d{4}/)?.[0]);
      return paper("pubmed", pmid, {
        title,
        abstract,
        authors,
        year: year || undefined,
        publicationDate: date,
        url: `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`,
        venue: text(article.querySelector("Journal > Title")),
        volume: text(article.querySelector("JournalIssue > Volume")),
        issue: text(article.querySelector("JournalIssue > Issue")),
        pages: text(article.querySelector("Pagination > MedlinePgn")),
        publicationTypes: (
          Array.from(article.querySelectorAll("PublicationType")) as Element[]
        ).map(text),
        externalIds: {
          PMID: pmid,
          PMCID: pmcid || undefined,
          DOI: doi || undefined,
        },
      });
    });
    const total = history.total;
    const next = retstart + items.length;
    return {
      items,
      total,
      cursor: items.length
        ? JSON.stringify({ ...history, retstart: next })
        : undefined,
      exhausted: items.length === 0 || next >= Math.min(total, 10000),
    };
  }
}

interface EuropePmcResponse {
  hitCount?: number;
  nextCursorMark?: string;
  resultList?: { result?: Array<Record<string, any>> };
}

function parseEuropePmcItem(
  item: Record<string, any>,
  source: ScholarlyProviderId,
): ScholarlyPaper {
  const nativeId = String(item.id || item.pmid || item.pmcid || item.doi || "");
  const urls = item.fullTextUrlList?.fullTextUrl || [];
  const pdf = urls.find((url: any) => url.documentStyle === "pdf")?.url;
  const authors = (item.authorList?.author || []).map((author: any) => ({
    name:
      author.fullName ||
      [author.firstName, author.lastName].filter(Boolean).join(" "),
    orcid:
      author.authorId?.type === "ORCID" ? author.authorId.value : undefined,
  }));
  const origin = String(
    item.journalTitle || item.bookOrReportDetails?.publisher || "",
  );
  return paper(source, nativeId, {
    title: String(item.title || ""),
    abstract: item.abstractText,
    authors,
    year: Number(item.pubYear) || undefined,
    publicationDate: item.firstPublicationDate,
    citationCount: Number(item.citedByCount) || 0,
    citationCounts: { [source]: Number(item.citedByCount) || 0 },
    url: item.doi
      ? `https://doi.org/${item.doi}`
      : `https://europepmc.org/article/${item.source}/${item.id}`,
    openAccessPdf: pdf ? { url: pdf } : undefined,
    venue: origin,
    volume: item.journalInfo?.volume,
    issue: item.journalInfo?.issue,
    pages: item.pageInfo,
    publicationTypes:
      item.pubTypeList?.pubType || (item.source === "PPR" ? ["Preprint"] : []),
    keywords: item.keywordList?.keyword || [],
    externalIds: {
      DOI: item.doi,
      PMID: item.pmid,
      PMCID: item.pmcid,
    },
  });
}

class EuropePmcProvider implements ScholarlySearchProvider {
  readonly capabilities = capabilities["europe-pmc"];
  isConfigured(): boolean {
    return true;
  }
  async search(
    query: ScholarlySearchQuery,
    cursor: string | undefined,
    context: { signal?: AbortSignal },
  ): Promise<ProviderPage> {
    return searchEuropePmc("europe-pmc", query, cursor, context.signal);
  }
}

async function searchEuropePmc(
  source: ScholarlyProviderId,
  query: ScholarlySearchQuery,
  cursor: string | undefined,
  signal?: AbortSignal,
): Promise<ProviderPage> {
  const clauses = [query.text];
  if (source === "biorxiv") clauses.push("SRC:PPR", 'JOURNAL:"bioRxiv"');
  if (source === "medrxiv") clauses.push("SRC:PPR", 'JOURNAL:"medRxiv"');
  if (query.filters.yearStart || query.filters.yearEnd) {
    clauses.push(
      `FIRST_PDATE:[${query.filters.yearStart || "1000"}-01-01 TO ${query.filters.yearEnd || "3000"}-12-31]`,
    );
  }
  if (query.filters.openAccess) clauses.push("OPEN_ACCESS:y");
  if (query.filters.hasPdf) clauses.push("HAS_PDF:y");
  const providerFilters = query.providerFilters["europe-pmc"] || {};
  if (providerFilters.preprintsOnly) clauses.push("SRC:PPR");
  if (providerFilters.hasAbstract) clauses.push("HAS_ABSTRACT:y");
  const params = new URLSearchParams({
    query: clauses.filter(Boolean).join(" AND "),
    format: "json",
    resultType: "core",
    pageSize: String(Math.min(query.limit, 1000)),
    cursorMark: cursor || "*",
  });
  const response = await scholarlyFetch(
    "europe-pmc",
    `https://www.ebi.ac.uk/europepmc/webservices/rest/search?${params}`,
    { signal },
    { minIntervalMs: 100 },
  );
  const data = await responseJson<EuropePmcResponse>(response);
  const items = (data.resultList?.result || []).map((item) =>
    parseEuropePmcItem(item, source),
  );
  return {
    items,
    total: data.hitCount,
    cursor: data.nextCursorMark,
    exhausted:
      items.length === 0 ||
      !data.nextCursorMark ||
      data.nextCursorMark === cursor,
  };
}

interface BioRxivResponse {
  messages?: Array<{ total?: string; count?: string; cursor?: string }>;
  collection?: Array<Record<string, any>>;
}

class PreprintProvider implements ScholarlySearchProvider {
  readonly capabilities: ProviderCapabilities;
  constructor(private readonly id: "biorxiv" | "medrxiv") {
    this.capabilities = capabilities[id];
  }
  isConfigured(): boolean {
    return true;
  }
  async search(
    query: ScholarlySearchQuery,
    cursor: string | undefined,
    context: { signal?: AbortSignal },
  ): Promise<ProviderPage> {
    const filters = query.providerFilters[this.id] || {};
    if (filters.browseMode !== true) {
      return searchEuropePmc(this.id, query, cursor, context.signal);
    }
    const offset = Number(cursor || 0);
    const end = String(
      filters.endDate || new Date().toISOString().slice(0, 10),
    );
    const start = String(
      filters.startDate ||
        new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10),
    );
    const category = String(filters.category || "");
    const params = category
      ? `?category=${encodeURIComponent(category.replace(/ /g, "_"))}`
      : "";
    const response = await scholarlyFetch(
      this.id,
      `https://api.biorxiv.org/details/${this.id}/${start}/${end}/${offset}${params}`,
      { signal: context.signal },
      { minIntervalMs: 500 },
    );
    const data = await responseJson<BioRxivResponse>(response);
    const seen = new Map<string, ScholarlyPaper>();
    for (const item of data.collection || []) {
      const doi = String(item.doi || "");
      const version = String(item.version || "1");
      seen.set(
        doi,
        paper(this.id, doi, {
          title: String(item.title || ""),
          abstract: item.abstract,
          authors: String(item.authors || "")
            .split(";")
            .map((name) => ({ name: name.trim() }))
            .filter((author) => author.name),
          ...parseDate(item.date),
          url: `https://www.${this.id}.org/content/${doi}v${version}`,
          openAccessPdf: {
            url: `https://www.${this.id}.org/content/${doi}v${version}.full.pdf`,
          },
          venue: this.capabilities.label,
          publicationTypes: ["Preprint"],
          fieldsOfStudy: item.category ? [item.category] : [],
          license: item.license,
          externalIds: { DOI: doi },
        }),
      );
    }
    const total =
      Number(data.messages?.[0]?.total || data.messages?.[0]?.count) ||
      undefined;
    const items = Array.from(seen.values());
    const next = offset + (data.collection?.length || 0);
    return {
      items,
      total,
      cursor: items.length ? String(next) : undefined,
      exhausted: items.length === 0 || (total !== undefined && next >= total),
    };
  }
}

class IacrProvider implements ScholarlySearchProvider {
  readonly capabilities = capabilities.iacr;
  isConfigured(): boolean {
    return true;
  }
  async search(
    query: ScholarlySearchQuery,
    cursor: string | undefined,
    context: { signal?: AbortSignal },
  ): Promise<ProviderPage> {
    if (cursor) return { items: [], exhausted: true };
    const params = new URLSearchParams({ q: query.text });
    const response = await scholarlyFetch(
      "iacr",
      `https://eprint.iacr.org/search?${params}`,
      { signal: context.signal },
      { minIntervalMs: 1000 },
    );
    const doc = createDOMParser().parseFromString(
      await response.text(),
      "text/html",
    );
    const entries = Array.from(doc.querySelectorAll("div.mb-4")) as Element[];
    const items = entries.slice(0, query.limit).flatMap((entry) => {
      const link = entry.querySelector(
        "a.paperlink",
      ) as HTMLAnchorElement | null;
      const nativeId = text(link);
      const title = text(entry.querySelector("div.ms-md-4 strong"));
      if (!nativeId || !title) return [];
      const authors = text(entry.querySelector("span.fst-italic"))
        .split(/,| and /)
        .map((name) => ({ name: name.trim() }))
        .filter((author) => author.name);
      const href = link?.getAttribute("href") || `/${nativeId}`;
      return [
        paper("iacr", nativeId, {
          title,
          abstract: text(entry.querySelector("p.search-abstract")),
          authors,
          year: Number(nativeId.split("/")[0]) || undefined,
          url: new URL(href, "https://eprint.iacr.org").toString(),
          openAccessPdf: { url: `https://eprint.iacr.org/${nativeId}.pdf` },
          venue: "Cryptology ePrint Archive",
          publicationTypes: ["Preprint"],
          fieldsOfStudy: [text(entry.querySelector("small.badge"))].filter(
            Boolean,
          ),
          externalIds: { IACR: nativeId },
        }),
      ];
    });
    return {
      items,
      total: entries.length,
      exhausted: true,
      warnings: ["IACR search uses an experimental HTML connector."],
    };
  }
}

class CoreProvider implements ScholarlySearchProvider {
  readonly capabilities = capabilities.core;
  isConfigured(): boolean {
    return true;
  }
  async search(
    query: ScholarlySearchQuery,
    cursor: string | undefined,
    context: { signal?: AbortSignal },
  ): Promise<ProviderPage> {
    const offset = Number(cursor || 0);
    const key = String(getPref("coreApiKey" as never) || "");
    const filters = query.providerFilters.core || {};
    let q = query.text;
    if (query.filters.yearStart)
      q += ` AND yearPublished>=${query.filters.yearStart}`;
    if (query.filters.yearEnd)
      q += ` AND yearPublished<=${query.filters.yearEnd}`;
    if (query.filters.hasPdf || filters.hasFullText)
      q += " AND _exists_:downloadUrl";
    const params = new URLSearchParams({
      q,
      limit: String(Math.min(query.limit, 100)),
      offset: String(offset),
    });
    const url = `https://api.core.ac.uk/v3/search/works?${params}`;
    let response: Response;
    try {
      response = await scholarlyFetch(
        "core",
        url,
        {
          signal: context.signal,
          headers: key ? { Authorization: `Bearer ${key}` } : {},
        },
        { minIntervalMs: key ? 2500 : 6000 },
      );
    } catch (error) {
      // A bad/expired key (401/403) falls back to an anonymous request; any
      // other failure (or no key to begin with) propagates unchanged.
      const authFailed =
        error instanceof ProviderRequestError &&
        (error.status === 401 || error.status === 403);
      if (!key || !authFailed) throw error;
      response = await scholarlyFetch(
        "core",
        url,
        { signal: context.signal },
        { minIntervalMs: 6000 },
      );
    }
    const data = await responseJson<any>(response);
    const items = (data.results || []).map((item: any) =>
      paper("core", String(item.id), {
        title: item.title || "",
        abstract: item.abstract,
        authors: (item.authors || []).map((author: any) => ({
          name: typeof author === "string" ? author : author.name,
        })),
        year: Number(item.yearPublished) || undefined,
        publicationDate: item.publishedDate,
        citationCount: Number(item.citationCount) || 0,
        url: item.doi
          ? `https://doi.org/${item.doi}`
          : item.links?.[0]?.url || `https://core.ac.uk/works/${item.id}`,
        openAccessPdf: item.downloadUrl ? { url: item.downloadUrl } : undefined,
        publicationTypes: item.documentType ? [item.documentType] : [],
        externalIds: {
          DOI: item.doi,
          ArXiv: item.arxivId,
          CORE: String(item.id),
        },
      }),
    );
    const total = Number(data.totalHits) || 0;
    const next = offset + items.length;
    return {
      items,
      total,
      cursor: String(next),
      exhausted: !items.length || next >= total,
    };
  }
}

class BaseProvider implements ScholarlySearchProvider {
  readonly capabilities = capabilities.base;
  isConfigured(): boolean {
    return Boolean(getPref("baseApiKey" as never));
  }
  async search(
    query: ScholarlySearchQuery,
    cursor: string | undefined,
    context: { signal?: AbortSignal },
  ): Promise<ProviderPage> {
    const key = String(getPref("baseApiKey" as never) || "");
    if (!key) throw new Error("BASE requires registered API access.");
    const offset = Number(cursor || 0);
    const params = new URLSearchParams({
      func: "PerformSearch",
      query: query.text,
      hits: String(Math.min(query.limit, 100)),
      offset: String(offset),
      format: "json",
      apikey: key,
    });
    const filters = query.providerFilters.base || {};
    if (filters.documentType)
      params.set("dctype", String(filters.documentType));
    if (filters.language) params.set("dclang", String(filters.language));
    if (filters.domain) params.set("dcsource", String(filters.domain));
    const response = await scholarlyFetch(
      "base",
      `https://api.base-search.net/cgi-bin/BaseHttpSearchInterface.fcgi?${params}`,
      { signal: context.signal },
      { minIntervalMs: 1000 },
    );
    const data = await responseJson<any>(response);
    const docs = data.response?.docs || data.docs || [];
    const items = docs.map((item: any) => {
      const id = String(item.dcid || item.id || item.identifier || "");
      const links = Array.isArray(item.dclink)
        ? item.dclink
        : [item.dclink].filter(Boolean);
      const pdf = links.find((link: string) => /\.pdf(?:$|\?)/i.test(link));
      return paper("base", id, {
        title: Array.isArray(item.dctitle)
          ? item.dctitle[0]
          : item.dctitle || item.title || "",
        abstract: Array.isArray(item.dcdescription)
          ? item.dcdescription.join(" ")
          : item.dcdescription,
        authors: (Array.isArray(item.dccreator)
          ? item.dccreator
          : [item.dccreator].filter(Boolean)
        ).map((name: string) => ({ name })),
        year: Number(item.dcyear || item.year) || undefined,
        url:
          links[0] ||
          `https://www.base-search.net/Record/${encodeURIComponent(id)}`,
        openAccessPdf: pdf ? { url: pdf } : undefined,
        fieldsOfStudy: Array.isArray(item.dcsubject) ? item.dcsubject : [],
        publicationTypes: item.dctype ? [String(item.dctype)] : [],
        externalIds: { DOI: item.dcdoi },
      });
    });
    const total = Number(data.response?.numFound || data.numFound) || 0;
    const next = offset + items.length;
    return {
      items,
      total,
      cursor: String(next),
      exhausted: !items.length || next >= total,
    };
  }
}

class ZenodoProvider implements ScholarlySearchProvider {
  readonly capabilities = capabilities.zenodo;
  isConfigured(): boolean {
    return true;
  }
  async search(
    query: ScholarlySearchQuery,
    cursor: string | undefined,
    context: { signal?: AbortSignal },
  ): Promise<ProviderPage> {
    const pageNumber = cursor?.startsWith("http") ? 1 : Number(cursor || 1);
    const token = String(getPref("zenodoAccessToken" as never) || "");
    const filters = query.providerFilters.zenodo || {};
    let q = query.text;
    if (query.filters.yearStart || query.filters.yearEnd) {
      q += ` AND publication_date:[${query.filters.yearStart || "1000"}-01-01 TO ${query.filters.yearEnd || "3000"}-12-31]`;
    }
    const params = new URLSearchParams({
      q,
      page: String(pageNumber),
      size: String(Math.min(query.limit, token ? 100 : 25)),
      sort: query.sort === "newest" ? "mostrecent" : "bestmatch",
      type: String(filters.type || "publication"),
    });
    if (filters.subtype) params.set("subtype", String(filters.subtype));
    if (query.filters.openAccess) params.set("access_right", "open");
    const requestUrl = cursor?.startsWith("http")
      ? cursor
      : `https://zenodo.org/api/records?${params}`;
    const response = await scholarlyFetch(
      "zenodo",
      requestUrl,
      {
        signal: context.signal,
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      },
      { minIntervalMs: 2100 },
    );
    const data = await responseJson<any>(response);
    const hits = data.hits?.hits || [];
    const items = hits.map((item: any) => {
      const metadata = item.metadata || {};
      const file = (item.files || []).find((candidate: any) =>
        String(candidate.key || "")
          .toLowerCase()
          .endsWith(".pdf"),
      );
      const id = String(item.id);
      return paper("zenodo", id, {
        title: metadata.title || "",
        abstract: String(metadata.description || "").replace(/<[^>]+>/g, " "),
        authors: (metadata.creators || []).map((author: any) => ({
          name:
            author.name ||
            [author.given_name, author.family_name].filter(Boolean).join(" "),
          orcid: author.orcid,
        })),
        ...parseDate(metadata.publication_date),
        url: item.links?.html || `https://zenodo.org/records/${id}`,
        openAccessPdf: file
          ? { url: file.links?.self || file.links?.download }
          : undefined,
        publisher: metadata.publisher,
        publicationTypes: [
          metadata.resource_type?.subtype || metadata.resource_type?.type,
        ].filter(Boolean),
        keywords: metadata.keywords || [],
        license: metadata.license?.id || metadata.license,
        externalIds: { DOI: item.doi || metadata.doi, Zenodo: id },
      });
    });
    const total = Number(data.hits?.total?.value ?? data.hits?.total) || 0;
    const nextLink = data.links?.next;
    const next = nextLink || String(pageNumber + 1);
    return {
      items,
      total,
      cursor: String(next),
      exhausted:
        !items.length ||
        (!nextLink &&
          (Boolean(cursor?.startsWith("http")) ||
            pageNumber * Number(params.get("size")) >= total)),
    };
  }
}

class HalProvider implements ScholarlySearchProvider {
  readonly capabilities = capabilities.hal;
  isConfigured(): boolean {
    return true;
  }
  async search(
    query: ScholarlySearchQuery,
    cursor: string | undefined,
    context: { signal?: AbortSignal },
  ): Promise<ProviderPage> {
    const filters = query.providerFilters.hal || {};
    const fq: string[] = [];
    if (query.filters.yearStart || query.filters.yearEnd) {
      fq.push(
        `publicationDateY_i:[${query.filters.yearStart || "1000"} TO ${query.filters.yearEnd || "3000"}]`,
      );
    }
    if (query.filters.hasPdf || filters.fileOnly) fq.push("submitType_s:file");
    if (filters.documentType) fq.push(`docType_s:${filters.documentType}`);
    if (filters.domain) fq.push(`domain_s:${filters.domain}`);
    if (filters.language) fq.push(`language_s:${filters.language}`);
    const params = new URLSearchParams({
      q: query.text,
      fl: "halId_s,title_s,authFullName_s,abstract_s,doiId_s,publicationDateY_i,submittedDate_s,fileMain_s,uri_s,docType_s,journalTitle_s,volume_s,issue_s,page_s,keyword_s,license_s",
      rows: String(Math.min(query.limit, 1000)),
      wt: "json",
      sort:
        query.sort === "newest"
          ? "publicationDateY_i desc,docid asc"
          : "score desc,docid asc",
      cursorMark: cursor || "*",
    });
    fq.forEach((value) => params.append("fq", value));
    const response = await scholarlyFetch(
      "hal",
      `https://api.archives-ouvertes.fr/search/?${params}`,
      { signal: context.signal },
      { minIntervalMs: 250 },
    );
    const data = await responseJson<any>(response);
    const items = (data.response?.docs || []).map((item: any) => {
      const id = String(item.halId_s);
      const value = (input: any): string =>
        Array.isArray(input) ? String(input[0] || "") : String(input || "");
      return paper("hal", id, {
        title: value(item.title_s),
        abstract: Array.isArray(item.abstract_s)
          ? item.abstract_s.join(" ")
          : item.abstract_s,
        authors: (Array.isArray(item.authFullName_s)
          ? item.authFullName_s
          : [item.authFullName_s].filter(Boolean)
        ).map((name: string) => ({ name })),
        year: Number(item.publicationDateY_i) || undefined,
        publicationDate: item.submittedDate_s,
        url: item.uri_s || `https://hal.science/${id}`,
        openAccessPdf: item.fileMain_s ? { url: item.fileMain_s } : undefined,
        venue: value(item.journalTitle_s),
        volume: value(item.volume_s),
        issue: value(item.issue_s),
        pages: value(item.page_s),
        publicationTypes: item.docType_s ? [item.docType_s] : [],
        keywords: item.keyword_s || [],
        license: value(item.license_s),
        externalIds: { DOI: value(item.doiId_s), HAL: id },
      });
    });
    const next = data.nextCursorMark;
    return {
      items,
      total: Number(data.response?.numFound) || 0,
      cursor: next,
      exhausted: !items.length || !next || next === cursor,
    };
  }
}

export const scholarlyProviders: Record<
  ScholarlyProviderId,
  ScholarlySearchProvider
> = {
  "semantic-scholar": new SemanticScholarProvider(),
  arxiv: new ArxivProvider(),
  pubmed: new PubmedProvider(),
  biorxiv: new PreprintProvider("biorxiv"),
  medrxiv: new PreprintProvider("medrxiv"),
  iacr: new IacrProvider(),
  "europe-pmc": new EuropePmcProvider(),
  core: new CoreProvider(),
  base: new BaseProvider(),
  zenodo: new ZenodoProvider(),
  hal: new HalProvider(),
};

export function getProviderCapabilities(): ProviderCapabilities[] {
  return Object.values(scholarlyProviders).map((provider) => ({
    ...provider.capabilities,
    requiresConfiguration:
      provider.capabilities.requiresConfiguration && !provider.isConfigured(),
  }));
}

export function getProviderCapability(
  id: ScholarlyProviderId,
): ProviderCapabilities {
  const provider = scholarlyProviders[id];
  return {
    ...provider.capabilities,
    requiresConfiguration:
      provider.capabilities.requiresConfiguration && !provider.isConfigured(),
  };
}

export async function testScholarlyProviderConnection(
  id: ScholarlyProviderId,
  signal?: AbortSignal,
): Promise<ProviderConnectionResult> {
  const provider = scholarlyProviders[id];
  const started = Date.now();
  if (!provider.isConfigured()) {
    return {
      ok: false,
      readiness: {
        status: "locked",
        message: `${provider.capabilities.label} requires setup.`,
      },
      error: "Provider is not configured",
    };
  }
  try {
    await provider.search(
      {
        text: id === "iacr" ? "cryptography" : "research",
        mode: "source",
        providers: [id],
        limit: 1,
        sort: "relevance",
        filters: {},
        providerFilters: {},
      },
      undefined,
      { signal },
    );
    return {
      ok: true,
      readiness: {
        status: provider.capabilities.experimental ? "experimental" : "ready",
        message: "Connection successful",
      },
      latencyMs: Date.now() - started,
    };
  } catch (error) {
    return {
      ok: false,
      readiness: { status: "locked", message: "Connection failed" },
      latencyMs: Date.now() - started,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
