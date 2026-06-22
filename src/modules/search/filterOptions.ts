import { ScholarlyProviderId } from "./types";

/**
 * Controlled-vocabulary registry for per-corpus ("source" mode) filters.
 *
 * Every provider-specific filter is rendered from these specs as a constrained
 * dropdown / checkbox / date input so the user can only pick values the
 * provider's API actually understands (no free-typing of invalid values).
 *
 * Option values must match exactly what `providers.ts` sends to each API:
 *  - arXiv     `category` -> `cat:<value>`
 *  - PubMed    `articleType` -> `<value>[PT]`
 *  - bioRxiv/medRxiv `category` -> `?category=<value with _ for spaces>` (browse)
 *  - Zenodo    `type`/`subtype` -> `type=`/`subtype=`
 *  - HAL       `documentType`/`domain`/`language` -> `docType_s:`/`domain_s:`/`language_s:`
 *  - BASE      `documentType`/`language` -> `dctype=`/`dclang=`
 */

export type FilterControlType = "select" | "checkbox" | "date";

export interface FilterOption {
  value: string;
  label: string;
  /** Optional <optgroup> label (used for long lists like the arXiv taxonomy). */
  group?: string;
}

export interface FilterSpec {
  key: string;
  label: string;
  type: FilterControlType;
  placeholder?: string;
  /** Static option list (for `select`). */
  options?: FilterOption[];
  /** Dynamic option list derived from current filter values (e.g. Zenodo subtype). */
  optionsFor?: (values: Record<string, unknown>) => FilterOption[];
  /** Only render this control when the predicate over current values is true. */
  visibleWhen?: (values: Record<string, unknown>) => boolean;
}

export interface ProviderFilterConfig {
  specs: FilterSpec[];
  /** Derived/normalized values to set before rendering (e.g. browseMode flag). */
  normalize?: (values: Record<string, unknown>) => void;
}

const BLANK: FilterOption = { value: "", label: "Any" };

// --- Shared vocabularies ---------------------------------------------------

// ISO 639-1 codes accepted by HAL (`language_s`) and BASE (`dclang`).
const LANGUAGES: FilterOption[] = [
  { value: "en", label: "English" },
  { value: "fr", label: "French" },
  { value: "de", label: "German" },
  { value: "es", label: "Spanish" },
  { value: "it", label: "Italian" },
  { value: "pt", label: "Portuguese" },
  { value: "nl", label: "Dutch" },
  { value: "ru", label: "Russian" },
  { value: "zh", label: "Chinese" },
  { value: "ja", label: "Japanese" },
  { value: "ar", label: "Arabic" },
];

function withAny(options: FilterOption[]): FilterOption[] {
  return [BLANK, ...options];
}

// --- arXiv -----------------------------------------------------------------
// Subset of the arXiv taxonomy (https://arxiv.org/category_taxonomy): the
// archive groups plus the most-used categories. Archive-level codes (e.g. `cs`)
// match every category in that archive.
const ARXIV_CATEGORIES: FilterOption[] = [
  { value: "cs", label: "Computer Science (all)", group: "Computer Science" },
  {
    value: "cs.AI",
    label: "Artificial Intelligence",
    group: "Computer Science",
  },
  {
    value: "cs.CL",
    label: "Computation and Language",
    group: "Computer Science",
  },
  { value: "cs.CV", label: "Computer Vision", group: "Computer Science" },
  { value: "cs.LG", label: "Machine Learning", group: "Computer Science" },
  {
    value: "cs.CR",
    label: "Cryptography and Security",
    group: "Computer Science",
  },
  {
    value: "cs.DS",
    label: "Data Structures and Algorithms",
    group: "Computer Science",
  },
  {
    value: "cs.DC",
    label: "Distributed/Parallel Computing",
    group: "Computer Science",
  },
  {
    value: "cs.NE",
    label: "Neural and Evolutionary Computing",
    group: "Computer Science",
  },
  { value: "cs.RO", label: "Robotics", group: "Computer Science" },
  { value: "cs.SE", label: "Software Engineering", group: "Computer Science" },
  { value: "math", label: "Mathematics (all)", group: "Mathematics" },
  { value: "math.AG", label: "Algebraic Geometry", group: "Mathematics" },
  { value: "math.CO", label: "Combinatorics", group: "Mathematics" },
  { value: "math.NA", label: "Numerical Analysis", group: "Mathematics" },
  { value: "math.OC", label: "Optimization and Control", group: "Mathematics" },
  { value: "math.PR", label: "Probability", group: "Mathematics" },
  { value: "math.ST", label: "Statistics Theory", group: "Mathematics" },
  { value: "stat", label: "Statistics (all)", group: "Statistics" },
  { value: "stat.ML", label: "Machine Learning (stat)", group: "Statistics" },
  { value: "stat.ME", label: "Methodology", group: "Statistics" },
  { value: "stat.AP", label: "Applications", group: "Statistics" },
  { value: "eess", label: "Electrical Eng. & Systems (all)", group: "EESS" },
  { value: "eess.SP", label: "Signal Processing", group: "EESS" },
  { value: "eess.IV", label: "Image and Video Processing", group: "EESS" },
  { value: "eess.SY", label: "Systems and Control", group: "EESS" },
  { value: "econ", label: "Economics (all)", group: "Economics" },
  { value: "econ.EM", label: "Econometrics", group: "Economics" },
  {
    value: "q-bio",
    label: "Quantitative Biology (all)",
    group: "Quantitative Biology",
  },
  { value: "q-bio.BM", label: "Biomolecules", group: "Quantitative Biology" },
  {
    value: "q-bio.NC",
    label: "Neurons and Cognition",
    group: "Quantitative Biology",
  },
  {
    value: "q-fin",
    label: "Quantitative Finance (all)",
    group: "Quantitative Finance",
  },
  {
    value: "q-fin.ST",
    label: "Statistical Finance",
    group: "Quantitative Finance",
  },
  { value: "astro-ph", label: "Astrophysics (all)", group: "Physics" },
  { value: "cond-mat", label: "Condensed Matter (all)", group: "Physics" },
  {
    value: "gr-qc",
    label: "General Relativity & Quantum Cosmology",
    group: "Physics",
  },
  {
    value: "hep-ph",
    label: "High Energy Physics – Phenomenology",
    group: "Physics",
  },
  { value: "hep-th", label: "High Energy Physics – Theory", group: "Physics" },
  { value: "math-ph", label: "Mathematical Physics", group: "Physics" },
  { value: "nlin", label: "Nonlinear Sciences (all)", group: "Physics" },
  { value: "physics", label: "Physics (general, all)", group: "Physics" },
  { value: "quant-ph", label: "Quantum Physics", group: "Physics" },
];

// --- PubMed ----------------------------------------------------------------
// Publication Type ([PT]) terms (PubMed User Guide). Sent verbatim as `<v>[PT]`.
const PUBMED_PUBLICATION_TYPES: FilterOption[] = [
  { value: "Journal Article", label: "Journal Article" },
  { value: "Review", label: "Review" },
  { value: "Systematic Review", label: "Systematic Review" },
  { value: "Meta-Analysis", label: "Meta-Analysis" },
  {
    value: "Randomized Controlled Trial",
    label: "Randomized Controlled Trial",
  },
  { value: "Clinical Trial", label: "Clinical Trial" },
  { value: "Clinical Trial, Phase III", label: "Clinical Trial, Phase III" },
  { value: "Controlled Clinical Trial", label: "Controlled Clinical Trial" },
  { value: "Observational Study", label: "Observational Study" },
  { value: "Comparative Study", label: "Comparative Study" },
  { value: "Multicenter Study", label: "Multicenter Study" },
  { value: "Case Reports", label: "Case Reports" },
  { value: "Practice Guideline", label: "Practice Guideline" },
  { value: "Guideline", label: "Guideline" },
  { value: "Editorial", label: "Editorial" },
  { value: "Letter", label: "Letter" },
  { value: "Comment", label: "Comment" },
];

// --- bioRxiv / medRxiv categories ------------------------------------------
const BIORXIV_CATEGORIES: FilterOption[] = [
  "Animal Behavior and Cognition",
  "Biochemistry",
  "Bioengineering",
  "Bioinformatics",
  "Biophysics",
  "Cancer Biology",
  "Cell Biology",
  "Developmental Biology",
  "Ecology",
  "Evolutionary Biology",
  "Genetics",
  "Genomics",
  "Immunology",
  "Microbiology",
  "Molecular Biology",
  "Neuroscience",
  "Paleontology",
  "Pathology",
  "Pharmacology and Toxicology",
  "Physiology",
  "Plant Biology",
  "Scientific Communication and Education",
  "Synthetic Biology",
  "Systems Biology",
  "Zoology",
].map((c) => ({ value: c, label: c }));

const MEDRXIV_CATEGORIES: FilterOption[] = [
  "Addiction Medicine",
  "Allergy and Immunology",
  "Anesthesia",
  "Cardiovascular Medicine",
  "Dentistry and Oral Medicine",
  "Dermatology",
  "Emergency Medicine",
  "Endocrinology",
  "Epidemiology",
  "Gastroenterology",
  "Genetic and Genomic Medicine",
  "Geriatric Medicine",
  "Health Economics",
  "Health Informatics",
  "Health Policy",
  "Hematology",
  "HIV/AIDS",
  "Infectious Diseases",
  "Intensive Care and Critical Care Medicine",
  "Nephrology",
  "Neurology",
  "Nursing",
  "Nutrition",
  "Obstetrics and Gynecology",
  "Occupational and Environmental Health",
  "Oncology",
  "Ophthalmology",
  "Orthopedics",
  "Otolaryngology",
  "Pain Medicine",
  "Palliative Medicine",
  "Pathology",
  "Pediatrics",
  "Pharmacology and Therapeutics",
  "Primary Care Research",
  "Psychiatry and Clinical Psychology",
  "Public and Global Health",
  "Radiology and Imaging",
  "Rehabilitation Medicine and Physical Therapy",
  "Respiratory Medicine",
  "Rheumatology",
  "Sexual and Reproductive Health",
  "Sports Medicine",
  "Surgery",
  "Toxicology",
  "Transplantation",
  "Urology",
].map((c) => ({ value: c, label: c }));

// --- Zenodo ----------------------------------------------------------------
const ZENODO_TYPES: FilterOption[] = [
  { value: "publication", label: "Publication" },
  { value: "poster", label: "Poster" },
  { value: "presentation", label: "Presentation" },
  { value: "dataset", label: "Dataset" },
  { value: "image", label: "Image" },
  { value: "video", label: "Video/Audio" },
  { value: "software", label: "Software" },
  { value: "lesson", label: "Lesson" },
  { value: "other", label: "Other" },
];

const ZENODO_PUBLICATION_SUBTYPES: FilterOption[] = [
  "article",
  "preprint",
  "book",
  "section",
  "conferencepaper",
  "report",
  "thesis",
  "workingpaper",
  "datamanagementplan",
  "patent",
  "deliverable",
  "milestone",
  "proposal",
  "technicalnote",
  "softwaredocumentation",
  "taxonomictreatment",
  "annotationcollection",
  "other",
].map((v) => ({ value: v, label: v }));

const ZENODO_IMAGE_SUBTYPES: FilterOption[] = [
  "figure",
  "plot",
  "drawing",
  "diagram",
  "photo",
  "other",
].map((v) => ({ value: v, label: v }));

// --- HAL -------------------------------------------------------------------
// docType codes from api.archives-ouvertes.fr/ref/doctype.
const HAL_DOCTYPES: FilterOption[] = [
  { value: "ART", label: "Journal article" },
  { value: "COMM", label: "Conference paper" },
  { value: "POSTER", label: "Conference poster" },
  { value: "PROCEEDINGS", label: "Conference proceedings" },
  { value: "OUV", label: "Book" },
  { value: "COUV", label: "Book chapter" },
  { value: "DOUV", label: "Book / special issue (editor)" },
  { value: "THESE", label: "Thesis" },
  { value: "HDR", label: "Habilitation (HDR)" },
  { value: "REPORT", label: "Report" },
  { value: "UNDEFINED", label: "Preprint / working paper" },
  { value: "PATENT", label: "Patent" },
  { value: "SOFTWARE", label: "Software" },
  { value: "OTHER", label: "Other publication" },
];

// Top-level HAL domain codes as stored in the Solr `domain_s` field.
const HAL_DOMAINS: FilterOption[] = [
  { value: "shs", label: "Humanities and Social Sciences" },
  { value: "info", label: "Computer Science" },
  { value: "math", label: "Mathematics" },
  { value: "phys", label: "Physics" },
  { value: "spi", label: "Engineering Sciences" },
  { value: "sdv", label: "Life Sciences" },
  { value: "chim", label: "Chemistry" },
  { value: "sde", label: "Environmental Sciences" },
  { value: "sdu", label: "Earth and Planetary Sciences" },
  { value: "scco", label: "Cognitive Sciences" },
  { value: "stat", label: "Statistics" },
  { value: "qfin", label: "Quantitative Finance" },
];

// --- BASE ------------------------------------------------------------------
// DRIVER/OpenAIRE semantic document types BASE indexes in `dctype`.
const BASE_DOCTYPES: FilterOption[] = [
  { value: "article", label: "Article" },
  { value: "book", label: "Book" },
  { value: "bookPart", label: "Book part" },
  { value: "conferenceObject", label: "Conference object" },
  { value: "doctoralThesis", label: "Doctoral thesis" },
  { value: "masterThesis", label: "Master thesis" },
  { value: "bachelorThesis", label: "Bachelor thesis" },
  { value: "report", label: "Report" },
  { value: "review", label: "Review" },
  { value: "lecture", label: "Lecture" },
  { value: "preprint", label: "Preprint" },
  { value: "workingPaper", label: "Working paper" },
  { value: "patent", label: "Patent" },
  { value: "other", label: "Other" },
];

export const PROVIDER_FILTERS: Partial<
  Record<ScholarlyProviderId, ProviderFilterConfig>
> = {
  arxiv: {
    specs: [
      {
        key: "field",
        label: "Search field",
        type: "select",
        options: [
          { value: "all", label: "All fields" },
          { value: "ti", label: "Title" },
          { value: "au", label: "Author" },
          { value: "abs", label: "Abstract" },
        ],
      },
      {
        key: "category",
        label: "Category",
        type: "select",
        options: withAny(ARXIV_CATEGORIES),
      },
    ],
  },
  pubmed: {
    specs: [
      {
        key: "articleType",
        label: "Article type",
        type: "select",
        options: withAny(PUBMED_PUBLICATION_TYPES),
      },
    ],
  },
  biorxiv: {
    normalize: (v) => {
      v.browseMode = v.searchStyle === "browse";
    },
    specs: [
      {
        key: "searchStyle",
        label: "Search style",
        type: "select",
        options: [
          { value: "keyword", label: "Keyword" },
          { value: "browse", label: "Browse recent/category" },
        ],
      },
      {
        key: "startDate",
        label: "Start date",
        type: "date",
        visibleWhen: (v) => v.searchStyle === "browse",
      },
      {
        key: "endDate",
        label: "End date",
        type: "date",
        visibleWhen: (v) => v.searchStyle === "browse",
      },
      {
        key: "category",
        label: "Category",
        type: "select",
        options: withAny(BIORXIV_CATEGORIES),
        visibleWhen: (v) => v.searchStyle === "browse",
      },
    ],
  },
  medrxiv: {
    normalize: (v) => {
      v.browseMode = v.searchStyle === "browse";
    },
    specs: [
      {
        key: "searchStyle",
        label: "Search style",
        type: "select",
        options: [
          { value: "keyword", label: "Keyword" },
          { value: "browse", label: "Browse recent/category" },
        ],
      },
      {
        key: "startDate",
        label: "Start date",
        type: "date",
        visibleWhen: (v) => v.searchStyle === "browse",
      },
      {
        key: "endDate",
        label: "End date",
        type: "date",
        visibleWhen: (v) => v.searchStyle === "browse",
      },
      {
        key: "category",
        label: "Category",
        type: "select",
        options: withAny(MEDRXIV_CATEGORIES),
        visibleWhen: (v) => v.searchStyle === "browse",
      },
    ],
  },
  "europe-pmc": {
    specs: [
      { key: "preprintsOnly", label: "Preprints only", type: "checkbox" },
      { key: "hasAbstract", label: "Has abstract", type: "checkbox" },
    ],
  },
  core: {
    specs: [
      { key: "hasFullText", label: "Full text available", type: "checkbox" },
    ],
  },
  base: {
    specs: [
      {
        key: "documentType",
        label: "Document type",
        type: "select",
        options: withAny(BASE_DOCTYPES),
      },
      {
        key: "language",
        label: "Language",
        type: "select",
        options: withAny(LANGUAGES),
      },
    ],
  },
  zenodo: {
    normalize: (v) => {
      if (!v.type) v.type = "publication";
    },
    specs: [
      {
        key: "type",
        label: "Record type",
        type: "select",
        options: ZENODO_TYPES,
      },
      {
        key: "subtype",
        label: "Subtype",
        type: "select",
        optionsFor: (v) => {
          if (v.type === "publication")
            return withAny(ZENODO_PUBLICATION_SUBTYPES);
          if (v.type === "image") return withAny(ZENODO_IMAGE_SUBTYPES);
          return withAny([]);
        },
        visibleWhen: (v) => v.type === "publication" || v.type === "image",
      },
    ],
  },
  hal: {
    specs: [
      {
        key: "documentType",
        label: "Document type",
        type: "select",
        options: withAny(HAL_DOCTYPES),
      },
      {
        key: "domain",
        label: "Domain",
        type: "select",
        options: withAny(HAL_DOMAINS),
      },
      {
        key: "language",
        label: "Language",
        type: "select",
        options: withAny(LANGUAGES),
      },
      { key: "fileOnly", label: "File available", type: "checkbox" },
    ],
  },
};
