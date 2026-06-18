/**
 * Prompt Library Manager
 * Core module for managing prompt templates with file-based persistence
 */

import { config } from "../../../package.json";

// ==================== Types ====================

export type PlaceholderType =
  | "topic"
  | "paper"
  | "author"
  | "collection"
  | "tag"
  | "year"
  | "table"
  | "prompt"
  | "workspace"
  | "review";
export type PromptCategory =
  | "analysis"
  | "comparative"
  | "writing"
  | "summary"
  | "skills"
  | "custom";

export interface PlaceholderInfo {
  key: string; // e.g., "topic", "paper1"
  type: PlaceholderType;
  required: boolean;
  position: number; // Position in template string
}

export interface PromptTemplate {
  id: string;
  name: string;
  description?: string;
  template: string; // Contains placeholder syntax
  category: PromptCategory;
  tags: string[];
  icon?: import("./ui/icons").IconName;
  placeholders: PlaceholderInfo[]; // Extracted from template
  createdAt: string;
  updatedAt: string;
  isBuiltIn?: boolean; // Cannot be deleted if true
  sourcePath?: string; // Skill-file-backed prompts are stored as editable markdown files
}

// Placeholder trigger characters and their types
export const PLACEHOLDER_TRIGGERS: Record<string, PlaceholderType> = {
  "#": "topic",
  "/": "paper",
  "@": "author",
  "^": "collection",
  "~": "tag",
  $: "table",
  "!": "prompt",
  "%": "workspace",
  "&": "review",
};

// Placeholder patterns for parsing
// Format: trigger + word characters (alphanumeric, underscore, space until delimiter)
const PLACEHOLDER_PATTERN =
  /([#/@^~$%&])([\w\s]*?)(?=\s*[#/@^~$%&.,!?;:\]]|$)/g;

// ==================== Storage ====================

let promptsFilePath: string | null = null;
let cachedPrompts: PromptTemplate[] | null = null;
let promptsDirPath: string | null = null;
let promptItemsDirPath: string | null = null;
let bundledSkillTemplatesCache: PromptTemplate[] | null = null;

/**
 * Get the path to prompts.json in Zotero data directory
 */
function getPromptsFilePath(): string {
  if (!promptsFilePath) {
    promptsFilePath = PathUtils.join(getPromptLibraryDirPath(), "prompts.json");
  }
  return promptsFilePath;
}

export function getPromptLibraryDirPath(): string {
  if (!promptsDirPath) {
    promptsDirPath = PathUtils.join(Zotero.DataDirectory.dir, config.addonRef);
  }
  return promptsDirPath;
}

export function getPromptLibraryItemsDirPath(): string {
  if (!promptItemsDirPath) {
    promptItemsDirPath = PathUtils.join(getPromptLibraryDirPath(), "skills");
  }
  return promptItemsDirPath;
}

export function getPromptLibrarySkillsDirPath(): string {
  return getPromptLibraryItemsDirPath();
}

/**
 * Ensure the seer-ai directory exists
 */
async function ensurePromptsDir(): Promise<void> {
  const seerDir = getPromptLibraryDirPath();

  if (!(await IOUtils.exists(seerDir))) {
    await IOUtils.makeDirectory(seerDir, { createAncestors: true });
  }
  const promptsDir = getPromptLibraryItemsDirPath();
  if (!(await IOUtils.exists(promptsDir))) {
    await IOUtils.makeDirectory(promptsDir, { createAncestors: true });
  }
}

function slugifyPromptName(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "skill"
  );
}

function canonicalSkillName(name: string): string {
  return slugifyPromptName(name.replace(/^Agent Skill:\s*/i, ""));
}

function titleFromSlug(slug: string): string {
  return slug
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function parsePromptSkillFrontmatter(text: string): {
  fields: Record<string, string>;
  body: string;
} {
  const fields: Record<string, string> = {};
  let body = text;
  if (text.startsWith("---")) {
    const end = text.indexOf("\n---", 3);
    if (end >= 0) {
      const frontmatter = text.slice(3, end).trim();
      body = text.slice(end + 4).trimStart();
      for (const rawLine of frontmatter.split("\n")) {
        const line = rawLine.trim();
        if (!line || line.startsWith("#")) continue;
        const match = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
        if (!match) continue;
        fields[match[1].toLowerCase()] = match[2].replace(/^["']|["']$/g, "");
      }
    }
  }
  return { fields, body };
}

function parsePromptSkillFile(
  text: string,
  path: string,
): PromptTemplate | null {
  const { fields, body } = parsePromptSkillFrontmatter(text);
  const parts = path.split(/[\\/]/);
  const filename = parts.pop() || "";
  const folderName = parts.pop() || "";
  const fallbackName =
    /^#\s+(.+)$/m.exec(body)?.[1]?.trim() ||
    (filename.toUpperCase() === "SKILL.MD"
      ? folderName
      : filename.replace(/\.(md|markdown)$/i, "")) ||
    "";
  const name = fields.name || fields.id || fallbackName;
  if (!name) return null;
  const now = new Date().toISOString();
  const tags = (fields.tags || "")
    .replace(/^\[|\]$/g, "")
    .split(",")
    .map((tag) => tag.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean);
  const template = body.trim();
  return {
    id: fields.id || `skill-file-${slugifyPromptName(name)}`,
    name,
    description: fields.description || fields.summary || "User skill file",
    template,
    category: "skills",
    tags: tags.length > 0 ? tags : ["skill"],
    icon: (fields.icon as import("./ui/icons").IconName | undefined) || "tool",
    placeholders: extractPlaceholders(template),
    createdAt: fields.createdat || now,
    updatedAt: fields.updatedat || now,
    isBuiltIn: false,
    sourcePath: path,
  };
}

async function loadSkillFilePrompts(): Promise<PromptTemplate[]> {
  const skillsDir = getPromptLibraryItemsDirPath();
  const legacyPromptsDir = PathUtils.join(getPromptLibraryDirPath(), "prompts");
  const prompts: PromptTemplate[] = [];
  const seen = new Set<string>();
  const readSkillFile = async (path: string) => {
    const parsed = parsePromptSkillFile(await IOUtils.readUTF8(path), path);
    if (!parsed) return;
    if (seen.has(parsed.id)) return;
    seen.add(parsed.id);
    prompts.push(parsed);
  };
  try {
    const readDir = async (dir: string) => {
      if (!(await IOUtils.exists(dir))) return;
      const children = await IOUtils.getChildren(dir);
      for (const child of children) {
        const stat = await IOUtils.stat(child).catch(() => null);
        if (stat?.type === "directory") {
          const skillPath = PathUtils.join(child, "SKILL.md");
          if (await IOUtils.exists(skillPath)) {
            await readSkillFile(skillPath);
          }
        } else if (/\.(md|markdown)$/i.test(child)) {
          await readSkillFile(child);
        }
      }
    };
    await readDir(skillsDir);
    await readDir(legacyPromptsDir);
  } catch (error) {
    console.error("Failed to load skill files:", error);
  }
  return prompts;
}

function getDefaultsWithSkillOverrides(
  fileSkills: PromptTemplate[],
): PromptTemplate[] {
  const overriddenSkillNames = new Set(
    fileSkills.map((skill) => canonicalSkillName(skill.name)),
  );
  const overriddenSkillBuiltinIds = new Set(
    fileSkills.map(
      (skill) => `builtin-agent-skill-${slugifyPromptName(skill.name)}`,
    ),
  );
  return getDefaultTemplates().filter(
    (prompt) =>
      prompt.category !== "skills" ||
      (!overriddenSkillNames.has(canonicalSkillName(prompt.name)) &&
        !overriddenSkillBuiltinIds.has(prompt.id)),
  );
}

function serializeSkillPrompt(prompt: PromptTemplate): string {
  const tags = prompt.tags.join(", ");
  return [
    "---",
    `id: ${prompt.id}`,
    `name: ${prompt.name}`,
    `description: ${prompt.description || ""}`,
    `icon: ${prompt.icon || ""}`,
    `tags: ${tags}`,
    `createdAt: ${prompt.createdAt}`,
    `updatedAt: ${prompt.updatedAt}`,
    "---",
    "",
    prompt.template,
    "",
  ].join("\n");
}

async function writeSkillPrompt(prompt: PromptTemplate): Promise<string> {
  const promptsDir = getPromptLibraryItemsDirPath();
  const folder = PathUtils.join(promptsDir, slugifyPromptName(prompt.name));
  if (!(await IOUtils.exists(folder))) {
    await IOUtils.makeDirectory(folder, { createAncestors: true });
  }
  const path = prompt.sourcePath || PathUtils.join(folder, "SKILL.md");
  await IOUtils.writeUTF8(path, serializeSkillPrompt(prompt));
  return path;
}

async function seedDefaultSkillFiles(): Promise<void> {
  const promptsDir = getPromptLibraryItemsDirPath();
  const defaultSkills = await getBundledSkillTemplates();
  for (const skill of defaultSkills) {
    const folder = PathUtils.join(promptsDir, slugifyPromptName(skill.name));
    const skillPath = PathUtils.join(folder, "SKILL.md");
    if (await IOUtils.exists(skillPath).catch(() => false)) continue;
    if (!(await IOUtils.exists(folder).catch(() => false))) {
      await IOUtils.makeDirectory(folder, { createAncestors: true });
    }
    const editableSkill: PromptTemplate = {
      ...skill,
      id: `skill-file-${slugifyPromptName(skill.name)}`,
      isBuiltIn: false,
      sourcePath: skillPath,
    };
    await IOUtils.writeUTF8(skillPath, serializeSkillPrompt(editableSkill));
  }
}

async function removeSkillPromptFile(prompt: PromptTemplate): Promise<void> {
  if (!prompt.sourcePath) return;
  try {
    if (await IOUtils.exists(prompt.sourcePath)) {
      await IOUtils.remove(prompt.sourcePath);
    }
  } catch (error) {
    console.error("Failed to remove skill file:", error);
  }
}

/**
 * Load prompts from file storage
 */
export async function loadPrompts(): Promise<PromptTemplate[]> {
  if (cachedPrompts) {
    return cachedPrompts;
  }

  await ensurePromptsDir();
  const filePath = getPromptsFilePath();

  try {
    await seedDefaultSkillFiles();
    const fileSkills = await loadSkillFilePrompts();
    if (await IOUtils.exists(filePath)) {
      const content = await IOUtils.readUTF8(filePath);
      const data = JSON.parse(content) as { prompts: PromptTemplate[] };
      const jsonPrompts = (data.prompts || []).filter(
        (prompt) => prompt.category !== "skills",
      );
      const fileSkillIds = new Set(fileSkills.map((skill) => skill.id));
      const migratedSkills = (data.prompts || []).filter(
        (prompt) =>
          prompt.category === "skills" &&
          !fileSkillIds.has(`skill-file-${slugifyPromptName(prompt.name)}`),
      );
      cachedPrompts = [
        ...getDefaultsWithSkillOverrides(fileSkills),
        ...jsonPrompts,
        ...fileSkills,
        ...migratedSkills,
      ];
      if (migratedSkills.length > 0) {
        await savePrompts(cachedPrompts);
      }
    } else {
      cachedPrompts = [
        ...getDefaultsWithSkillOverrides(fileSkills),
        ...fileSkills,
      ];
      await savePrompts(cachedPrompts);
    }
  } catch (error) {
    console.error("Failed to load prompts:", error);
    cachedPrompts = getDefaultTemplates();
  }

  return cachedPrompts;
}

/**
 * Save prompts to file storage
 */
export async function savePrompts(prompts: PromptTemplate[]): Promise<void> {
  await ensurePromptsDir();
  const filePath = getPromptsFilePath();

  const customPrompts = prompts.filter(
    (p) => !p.isBuiltIn && p.category !== "skills",
  );
  const customSkills = prompts.filter(
    (p) => !p.isBuiltIn && p.category === "skills",
  );

  try {
    for (const skill of customSkills) {
      skill.sourcePath = await writeSkillPrompt(skill);
    }
    const content = JSON.stringify({ prompts: customPrompts }, null, 2);
    await IOUtils.writeUTF8(filePath, content);
    cachedPrompts = prompts;
  } catch (error) {
    console.error("Failed to save prompts:", error);
    throw error;
  }
}

/**
 * Clear the cached prompts (for testing or refresh)
 */
export function clearPromptsCache(): void {
  cachedPrompts = null;
  bundledSkillTemplatesCache = null;
}

// ==================== Default Templates ====================

/**
 * Get built-in default prompt templates
 */
export function getDefaultTemplates(): PromptTemplate[] {
  const now = new Date().toISOString();

  return [
    {
      id: "builtin-summarize-paper",
      name: "Summarize Paper",
      description:
        "Generate a concise summary of a research paper covering key findings, methodology, and contributions.",
      template:
        "Summarize the key findings, methodology, and contributions of /. Focus on the main arguments, research methods used, and the significance of the results.",
      category: "summary",
      tags: ["summary", "quick-review"],
      placeholders: extractPlaceholders(
        "Summarize the key findings, methodology, and contributions of /.",
      ),
      createdAt: now,
      updatedAt: now,
      isBuiltIn: true,
    },
    {
      id: "builtin-compare-methods",
      name: "Compare Methodologies",
      description:
        "Compare research methodologies between two papers on a specific topic.",
      template:
        "Compare the research methodologies used in / and / regarding #. Highlight key differences in approach, data collection, and analysis methods.",
      category: "comparative",
      tags: ["methodology", "comparison"],
      placeholders: extractPlaceholders(
        "Compare the research methodologies used in / and / regarding #.",
      ),
      createdAt: now,
      updatedAt: now,
      isBuiltIn: true,
    },
    {
      id: "builtin-research-gaps",
      name: "Identify Research Gaps",
      description:
        "Identify unexplored areas and research gaps based on papers in a collection.",
      template:
        "Based on papers in ^ on #, identify key research gaps and unexplored areas. Consider methodological limitations, understudied populations, and emerging questions.",
      category: "analysis",
      tags: ["gap-analysis", "research-design"],
      placeholders: extractPlaceholders(
        "Based on papers in ^ on #, identify key research gaps.",
      ),
      createdAt: now,
      updatedAt: now,
      isBuiltIn: true,
    },
    {
      id: "builtin-literature-review",
      name: "Literature Review",
      description:
        "Generate a literature review section covering papers by a specific author or with a specific tag.",
      template:
        "Write a concise literature review on # covering papers by @ in ^. Synthesize the main themes, methodological approaches, and key findings.",
      category: "writing",
      tags: ["literature-review", "writing"],
      placeholders: extractPlaceholders(
        "Write a concise literature review on # covering papers by @ in ^.",
      ),
      createdAt: now,
      updatedAt: now,
      isBuiltIn: true,
    },
    {
      id: "builtin-methodology-analysis",
      name: "Methodology Analysis",
      description:
        "Detailed analysis of methodological strengths and weaknesses of a paper.",
      template:
        "Analyze the methodological strengths and weaknesses of / including: research design, sample size and selection, statistical methods, validity threats, and replicability.",
      category: "analysis",
      tags: ["methodology", "critical-analysis"],
      placeholders: extractPlaceholders(
        "Analyze the methodological strengths and weaknesses of /.",
      ),
      createdAt: now,
      updatedAt: now,
      isBuiltIn: true,
    },
    {
      id: "builtin-explain-concept",
      name: "Explain Concept",
      description:
        "Explain a concept or term in the context of selected papers.",
      template:
        "Explain the concept of # as it appears in the selected papers. Provide definitions, examples, and how different authors approach this concept.",
      category: "summary",
      tags: ["explanation", "concepts"],
      placeholders: extractPlaceholders(
        "Explain the concept of # as it appears in the selected papers.",
      ),
      createdAt: now,
      updatedAt: now,
      isBuiltIn: true,
    },
    {
      id: "builtin-critique-paper",
      name: "Critical Review",
      description:
        "Generate a critical review of a paper highlighting strengths and limitations.",
      template:
        "Provide a critical review of /. Discuss its strengths (novelty, rigor, significance) and limitations (methodology gaps, generalizability, missing perspectives). Suggest improvements.",
      category: "analysis",
      tags: ["critique", "review"],
      placeholders: extractPlaceholders("Provide a critical review of /."),
      createdAt: now,
      updatedAt: now,
      isBuiltIn: true,
    },
    {
      id: "builtin-extract-findings",
      name: "Extract Key Findings",
      description: "Extract and list the key findings from selected papers.",
      template:
        "Extract and list the key findings from the selected papers on #. Organize findings by theme and note any contradicting results.",
      category: "summary",
      tags: ["findings", "extraction"],
      placeholders: extractPlaceholders(
        "Extract and list the key findings on #.",
      ),
      createdAt: now,
      updatedAt: now,
      isBuiltIn: true,
    },
  ];
}

export async function getBundledSkillTemplates(): Promise<PromptTemplate[]> {
  if (bundledSkillTemplatesCache) return bundledSkillTemplatesCache;
  const fromPackage = await loadPackagedSkillTemplates();
  bundledSkillTemplatesCache =
    fromPackage.length > 0
      ? fromPackage
      : getFallbackAgentSkillTemplates(new Date().toISOString());
  return bundledSkillTemplatesCache;
}

async function loadPackagedSkillTemplates(): Promise<PromptTemplate[]> {
  try {
    if (typeof rootURI !== "string") return [];
    const indexResponse = await fetch(`${rootURI}skills/index.json`);
    if (!indexResponse.ok) return [];
    const index = (await indexResponse.json()) as { skills?: string[] };
    const slugs = Array.isArray(index.skills) ? index.skills : [];
    const now = new Date().toISOString();
    const templates: PromptTemplate[] = [];
    for (const slug of slugs) {
      const response = await fetch(`${rootURI}skills/${slug}/SKILL.md`);
      if (!response.ok) continue;
      const text = await response.text();
      const parsed = parsePackagedSkillTemplate(slug, text, now);
      if (parsed) templates.push(parsed);
    }
    return templates.sort((a, b) => a.name.localeCompare(b.name));
  } catch (error) {
    console.error("Failed to load packaged skills:", error);
    return [];
  }
}

function parsePackagedSkillTemplate(
  slug: string,
  text: string,
  now: string,
): PromptTemplate | null {
  const { fields, body } = parsePromptSkillFrontmatter(text);
  const name = titleFromSlug(fields.name || slug);
  const description = fields.description || "Packaged scientific agent skill";
  const tags = [
    "agent-skill",
    slug,
    ...slug.split("-").filter((part) => part.length > 2),
  ];
  const template = body.trim() || text.trim();
  if (!template) return null;
  return {
    id: `builtin-agent-skill-${slugifyPromptName(slug)}`,
    name,
    description,
    template,
    category: "skills",
    tags: Array.from(new Set(tags)),
    icon: inferSkillIcon(slug, description, template),
    placeholders: extractPlaceholders(template),
    createdAt: now,
    updatedAt: now,
    isBuiltIn: true,
    sourcePath:
      typeof rootURI === "string" ? `${rootURI}skills/${slug}/SKILL.md` : "",
  };
}

function inferSkillIcon(
  slug: string,
  description: string,
  template: string,
): import("./ui/icons").IconName {
  const text = `${slug} ${description} ${template.slice(0, 500)}`.toLowerCase();
  if (text.includes("paper") || text.includes("pdf")) return "paper";
  if (text.includes("database") || text.includes("data")) return "database";
  if (text.includes("search") || text.includes("lookup")) return "search";
  if (text.includes("review")) return "review";
  if (text.includes("writing") || text.includes("markdown")) return "edit";
  if (text.includes("image") || text.includes("visual")) return "image";
  if (text.includes("slide") || text.includes("poster")) return "prompts";
  if (text.includes("statistics") || text.includes("analysis")) return "scale";
  if (text.includes("lab") || text.includes("robot")) return "robot";
  if (text.includes("code") || text.includes("python")) return "terminal";
  return "tool";
}

function makeAgentSkillTemplate(
  now: string,
  id: string,
  name: string,
  description: string,
  template: string,
  tags: string[],
  icon: import("./ui/icons").IconName = "tool",
): PromptTemplate {
  return {
    id: `builtin-agent-skill-${id}`,
    name,
    description,
    template,
    category: "skills",
    tags: ["agent-skill", ...tags],
    icon,
    placeholders: extractPlaceholders(template),
    createdAt: now,
    updatedAt: now,
    isBuiltIn: true,
  };
}

function getFallbackAgentSkillTemplates(now: string): PromptTemplate[] {
  return [
    makeAgentSkillTemplate(
      now,
      "paper-lookup",
      "Paper Lookup",
      "Find, inspect, import, and read academic papers using SeerAI research tools.",
      [
        "Use this skill for paper lookup and research discovery.",
        "Search Zotero first with `search_library`, then use `search_external`, `web`, `related_papers`, and `search_similar` for external discovery.",
        "Use `get_item_metadata` for bibliographic details and `read_item_content` for full-text analysis.",
        "Import papers only when the user asks or when Zotero persistence is required.",
      ].join("\n"),
      ["papers", "search", "zotero"],
      "search",
    ),
    makeAgentSkillTemplate(
      now,
      "literature-review",
      "Literature Review",
      "Plan, screen, synthesize, and write literature reviews with SeerAI.",
      [
        "Use this skill for narrative, scoping, and systematic literature review workflows.",
        "Use `collection`, `search_library`, `semantic_search`, and `keyword_search` to gather evidence.",
        "Use `systematic_review` for PRISMA-style projects, protocols, screening, extraction, synthesis, and gaps.",
        "Use `table` to build extraction matrices before writing synthesis.",
      ].join("\n"),
      ["literature-review", "synthesis", "systematic-review"],
      "review",
    ),
    makeAgentSkillTemplate(
      now,
      "citation-management",
      "Citation Management",
      "Validate citations, organize references, and create citation-backed notes.",
      [
        "Use this skill for citation and reference workflows.",
        "Use `get_item_metadata` to verify DOI, authors, dates, journal, and identifiers.",
        "Use `collection` to organize references and `note` to create citation-backed research notes.",
        "When writing, cite Zotero item IDs or stable identifiers available in tool results.",
      ].join("\n"),
      ["citations", "references", "zotero"],
      "bookmark",
    ),
    makeAgentSkillTemplate(
      now,
      "scientific-writing",
      "Scientific Writing",
      "Draft and revise scientific prose grounded in Zotero evidence.",
      [
        "Use this skill for scientific drafting and revision.",
        "Ground claims in `read_item_content`, RAG results, tables, or review synthesis.",
        "Prefer concise IMRaD-style organization for manuscripts.",
        "Use `workspace_write_file` or `write_file` for draft artifacts.",
      ].join("\n"),
      ["writing", "manuscript", "evidence"],
      "edit",
    ),
    makeAgentSkillTemplate(
      now,
      "peer-review",
      "Peer Review",
      "Review papers for novelty, validity, reporting quality, methods, and limitations.",
      [
        "Use this skill for peer review and critical appraisal.",
        "Assess research question, design, sample, statistical approach, claims, limitations, and reproducibility.",
        "Separate major concerns from minor comments and tie concerns to evidence from the paper content.",
        "Ask for clarification if the required document is unavailable.",
      ].join("\n"),
      ["peer-review", "critique", "methods"],
      "check-circle",
    ),
    makeAgentSkillTemplate(
      now,
      "document-processing",
      "Document Processing",
      "Process PDFs, DOCX, markdown, images, and workspace files.",
      [
        "Use this skill for document processing.",
        "Use `read_item_content` with `trigger_ocr: true` for Zotero PDFs that lack text.",
        "Use `read_file`, `search_files`, and `patch` for workspace documents.",
        "Use SeerAI file preview/conversion support for DOCX and other supported workspace files.",
      ].join("\n"),
      ["pdf", "ocr", "docx", "files"],
      "paper",
    ),
    makeAgentSkillTemplate(
      now,
      "experimental-design-and-power",
      "Experimental Design and Power",
      "Support study design, protocols, outcomes, effect measures, and power planning.",
      [
        "Use this skill for study design and protocol planning.",
        "Use `systematic_review` protocol tools to define research question, framework, criteria, outcomes, and effect measures.",
        "Flag missing sample-size assumptions, baseline risk, variance, allocation ratio, and target effect before claiming power adequacy.",
        "Treat power calculations as planning support unless validated by a specialist tool or user-supplied formula.",
      ].join("\n"),
      ["study-design", "power", "protocol"],
      "target",
    ),
    makeAgentSkillTemplate(
      now,
      "statistical-analysis",
      "Statistical Analysis",
      "Guide effect-size extraction, confidence intervals, heterogeneity, and synthesis.",
      [
        "Use this skill for statistical interpretation and evidence synthesis.",
        "Use `systematic_review` extraction and synthesis tools for effect measures, confidence intervals, heterogeneity, and gap analysis.",
        "Use extraction-health warnings for missing CIs, extreme effects, negative variances, and duplicate extractions.",
        "Explain assumptions and prefer narrative fallback when quantitative synthesis is not defensible.",
      ].join("\n"),
      ["statistics", "meta-analysis", "effect-size"],
      "scale",
    ),
    ...[
      [
        "database-lookup",
        "Database Lookup",
        "Plan deterministic database/resource lookups with provenance-aware search.",
        "Use this skill for structured database lookup. Prefer deterministic queries, record source URLs or database names, capture query strings, and distinguish Zotero/library evidence from external web/database evidence. Use `web`, `search_external`, and `note` to preserve provenance.",
        ["database", "lookup", "provenance"],
      ],
      [
        "research-lookup",
        "Research Lookup",
        "Find research entities, resources, datasets, and background context.",
        "Use this skill for broad research lookup. Start from Zotero context, then use external search only as needed. Return source-grounded findings with identifiers, links, and uncertainty.",
        ["research", "lookup", "resources"],
      ],
      [
        "bgpt-paper-search",
        "Biomedical Paper Search",
        "Search biomedical literature while preserving query provenance.",
        "Use this skill for biomedical paper search. Use `search_library`, `search_external`, and `web`; record exact queries, filters, dates, and whether results are in Zotero or external sources.",
        ["biomedical", "papers", "search"],
      ],
      [
        "exa-search",
        "Exa-Style Web Search",
        "Perform targeted web research with citation-ready source capture.",
        "Use this skill for targeted web discovery. Use `web` search/read, capture URLs, avoid unsupported claims, and prefer primary sources.",
        ["web", "search", "sources"],
      ],
      [
        "paperzilla",
        "Paper Acquisition",
        "Find paper landing pages, PDFs, and import candidates.",
        "Use this skill to locate full text. Prefer Zotero attachments first, then open-access links, DOI landing pages, PubMed Central/arXiv where applicable, and import only when requested.",
        ["papers", "pdf", "open-access"],
      ],
      [
        "pdf",
        "PDF Processing",
        "Read, OCR, summarize, and extract evidence from PDFs.",
        "Use this skill for PDF work. Use `read_item_content` with OCR when needed, extract source-grounded quotes, pages when available, and avoid claims not present in the document.",
        ["pdf", "ocr", "extraction"],
      ],
      [
        "docx",
        "DOCX Processing",
        "Process DOCX manuscripts and research documents.",
        "Use this skill for DOCX work. Use workspace/document conversion support, preserve headings and citations, and write extracted drafts or summaries to workspace files.",
        ["docx", "manuscript", "documents"],
      ],
      [
        "pptx",
        "Presentation Processing",
        "Plan and review presentation or slide content.",
        "Use this skill for slide decks. Convert evidence into concise slide outlines, speaker notes, and citation-backed claims. Use workspace files for generated slide text.",
        ["slides", "presentation", "pptx"],
      ],
      [
        "xlsx",
        "Spreadsheet Processing",
        "Use spreadsheet-like extraction, cleanup, and tabular synthesis workflows.",
        "Use this skill for spreadsheet workflows. Prefer SeerAI `table` tools for paper extraction matrices, preserve column definitions, and export tabular artifacts through workspace files when useful.",
        ["spreadsheet", "table", "xlsx"],
      ],
      [
        "markitdown",
        "Document-to-Markdown",
        "Convert document content into clean markdown for review workflows.",
        "Use this skill to normalize documents into markdown. Preserve headings, tables, citation cues, and source boundaries. Store converted artifacts in the workspace.",
        ["markdown", "conversion", "documents"],
      ],
      [
        "markdown-mermaid-writing",
        "Markdown and Mermaid Writing",
        "Write structured markdown, diagrams, and review artifacts.",
        "Use this skill for markdown reports and Mermaid diagrams. Keep diagrams text-native, label evidence flows clearly, and store artifacts in workspace files.",
        ["markdown", "mermaid", "writing"],
      ],
      [
        "scientific-visualization",
        "Scientific Visualization",
        "Design evidence-backed charts and visual summaries.",
        "Use this skill for visual summaries. Choose chart types from the data shape, explain assumptions, and use tables/review synthesis as the source of truth.",
        ["visualization", "charts", "science"],
      ],
      [
        "scientific-schematics",
        "Scientific Schematics",
        "Plan schematic figures and conceptual diagrams.",
        "Use this skill for conceptual scientific diagrams. Define entities, relationships, labels, and caption text; use workspace markdown/SVG where appropriate.",
        ["schematics", "figures", "diagrams"],
      ],
      [
        "infographics",
        "Infographics",
        "Turn research findings into concise visual communication plans.",
        "Use this skill for infographics. Prioritize one message, evidence-backed numbers, plain labels, and citation/provenance notes.",
        ["infographics", "communication", "visual"],
      ],
      [
        "scientific-slides",
        "Scientific Slides",
        "Create slide outlines, talk tracks, and evidence-backed presentation structure.",
        "Use this skill for scientific presentations. Structure slides around claims, evidence, limitations, and implications. Keep each slide focused and cite source items.",
        ["slides", "presentation", "scientific-writing"],
      ],
      [
        "latex-posters",
        "LaTeX Posters",
        "Plan academic poster content and LaTeX poster structure.",
        "Use this skill for poster drafting. Build sections, concise bullets, figure/table placeholders, and citation-backed captions.",
        ["poster", "latex", "conference"],
      ],
      [
        "pptx-posters",
        "PPTX Posters",
        "Plan PowerPoint-style academic poster content.",
        "Use this skill for poster layouts. Define title, authors, sections, figure slots, key takeaways, and QR/link placeholders.",
        ["poster", "pptx", "conference"],
      ],
      [
        "hypothesis-generation",
        "Hypothesis Generation",
        "Generate testable, evidence-grounded research hypotheses.",
        "Use this skill to propose hypotheses from literature. Separate observation, mechanism, prediction, test, confounders, and required evidence.",
        ["hypothesis", "research-design", "ideation"],
      ],
      [
        "scientific-brainstorming",
        "Scientific Brainstorming",
        "Brainstorm research directions while preserving feasibility and evidence constraints.",
        "Use this skill for idea generation. Produce options, assumptions, likely evidence, feasibility, novelty, and next validation steps.",
        ["brainstorming", "ideas", "research"],
      ],
      [
        "scientific-critical-thinking",
        "Scientific Critical Thinking",
        "Stress-test claims, methods, causal reasoning, and evidence quality.",
        "Use this skill to critique scientific arguments. Check alternative explanations, confounding, measurement validity, statistical support, and overclaiming.",
        ["critical-thinking", "validity", "critique"],
      ],
      [
        "scholar-evaluation",
        "Scholar Evaluation",
        "Evaluate author, venue, paper, and evidence credibility.",
        "Use this skill for scholarly evaluation. Consider publication venue, methods, citation context, conflicts, replication, and source quality without using prestige alone.",
        ["evaluation", "scholarship", "credibility"],
      ],
      [
        "research-grants",
        "Research Grants",
        "Draft grant aims, significance, innovation, and approach sections.",
        "Use this skill for grant writing. Tie aims to literature gaps, define feasibility, risks, alternatives, outcomes, and evidence-backed significance.",
        ["grants", "writing", "research-design"],
      ],
      [
        "venue-templates",
        "Venue Templates",
        "Adapt manuscripts and abstracts to venue requirements.",
        "Use this skill for venue preparation. Capture target venue constraints, word limits, structure, citation style, and required sections before rewriting.",
        ["venue", "templates", "submission"],
      ],
      [
        "get-available-resources",
        "Available Resources",
        "Inventory available Zotero, workspace, table, review, and cloud resources.",
        "Use this skill at task start when scope is unclear. List relevant Zotero collections/items, workspace files, review projects, tables, and configured tools before choosing a workflow.",
        ["resources", "inventory", "workflow"],
      ],
      [
        "open-notebook",
        "Open Notebook",
        "Keep a transparent research notebook with decisions and provenance.",
        "Use this skill for reproducible notes. Record questions, queries, sources, decisions, assumptions, and outputs in Zotero notes or workspace markdown.",
        ["notebook", "provenance", "reproducibility"],
      ],
      [
        "exploratory-data-analysis",
        "Exploratory Data Analysis",
        "Plan and summarize exploratory analysis for extracted or tabular research data.",
        "Use this skill for EDA. Inspect variable definitions, missingness, distributions, outliers, and relationships. Do not infer causality from exploratory patterns.",
        ["eda", "data-analysis", "tables"],
      ],
      [
        "statistical-power",
        "Statistical Power",
        "Plan and critique sample size and power assumptions.",
        "Use this skill for power reasoning. Require effect size, alpha, power target, variance/baseline rate, allocation, design, and attrition assumptions before conclusions.",
        ["power", "sample-size", "statistics"],
      ],
      [
        "statsmodels",
        "Statistical Modeling",
        "Plan regression/modeling analysis and interpret model outputs cautiously.",
        "Use this skill for model planning. Define outcome, predictors, covariates, assumptions, diagnostics, and interpretation limits.",
        ["statistics", "modeling", "regression"],
      ],
      [
        "scikit-learn",
        "Machine Learning Evaluation",
        "Plan ML evaluation, feature handling, validation, and reporting.",
        "Use this skill for ML-related papers or datasets. Emphasize splits, leakage prevention, metrics, calibration, baselines, uncertainty, and reproducibility.",
        ["machine-learning", "evaluation", "methods"],
      ],
      [
        "matplotlib",
        "Plot Planning",
        "Plan clear scientific plots and captions.",
        "Use this skill to design plots. Specify data columns, chart type, axes, units, uncertainty, caption, and source table.",
        ["plotting", "figures", "charts"],
      ],
      [
        "seaborn",
        "Statistical Plot Planning",
        "Plan statistical graphics for distributions and relationships.",
        "Use this skill for statistical visualization. Choose plots for distributions, categories, relationships, and uncertainty; avoid misleading encodings.",
        ["statistics", "plots", "visualization"],
      ],
      [
        "networkx",
        "Network and Citation Graphs",
        "Analyze relationship, citation, coauthor, or concept graphs.",
        "Use this skill for graph reasoning. Define nodes, edges, direction, weights, centrality/communities if needed, and interpretation limits.",
        ["graphs", "citations", "networks"],
      ],
      [
        "sympy",
        "Symbolic Reasoning",
        "Support equation explanation, derivation checking, and formula manipulation.",
        "Use this skill for formulas. State variables, assumptions, units, transformations, and check dimensional or algebraic consistency.",
        ["math", "equations", "symbolic"],
      ],
      [
        "parallel-web",
        "Parallel Web Research",
        "Plan parallelized web research with deduplication and source grading.",
        "Use this skill for broad web evidence gathering. Break queries into facets, deduplicate sources, grade source quality, and synthesize with citations.",
        ["web", "research", "synthesis"],
      ],
    ].map(([id, name, description, template, tags]) =>
      makeAgentSkillTemplate(
        now,
        id as string,
        name as string,
        description as string,
        template as string,
        tags as string[],
      ),
    ),
  ];
}

// ==================== CRUD Operations ====================

/**
 * Generate a unique ID for new prompts
 */
function generateId(): string {
  return (
    "prompt-" +
    Date.now().toString(36) +
    "-" +
    Math.random().toString(36).substring(2, 9)
  );
}

/**
 * Add a new prompt template
 */
export async function addPrompt(
  promptData: Omit<
    PromptTemplate,
    "id" | "createdAt" | "updatedAt" | "placeholders"
  >,
): Promise<PromptTemplate> {
  const prompts = await loadPrompts();
  const now = new Date().toISOString();

  const newPrompt: PromptTemplate = {
    ...promptData,
    id: generateId(),
    placeholders: extractPlaceholders(promptData.template),
    createdAt: now,
    updatedAt: now,
    isBuiltIn: false,
  };

  prompts.push(newPrompt);
  await savePrompts(prompts);

  return newPrompt;
}

/**
 * Update an existing prompt template
 */
export async function updatePrompt(
  id: string,
  updates: Partial<Omit<PromptTemplate, "id" | "createdAt" | "isBuiltIn">>,
): Promise<PromptTemplate> {
  const prompts = await loadPrompts();
  const index = prompts.findIndex((p) => p.id === id);

  if (index === -1) {
    throw new Error(`Prompt with id ${id} not found`);
  }

  const existing = prompts[index];
  if (existing.isBuiltIn) {
    throw new Error("Cannot modify built-in prompts");
  }

  const updatedPrompt: PromptTemplate = {
    ...existing,
    ...updates,
    updatedAt: new Date().toISOString(),
    placeholders: updates.template
      ? extractPlaceholders(updates.template)
      : existing.placeholders,
  };

  prompts[index] = updatedPrompt;
  await savePrompts(prompts);

  return updatedPrompt;
}

/**
 * Delete a prompt template
 */
export async function deletePrompt(id: string): Promise<void> {
  const prompts = await loadPrompts();
  const index = prompts.findIndex((p) => p.id === id);

  if (index === -1) {
    throw new Error(`Prompt with id ${id} not found`);
  }

  if (prompts[index].isBuiltIn) {
    throw new Error("Cannot delete built-in prompts");
  }

  await removeSkillPromptFile(prompts[index]);
  prompts.splice(index, 1);
  await savePrompts(prompts);
}

/**
 * Get a prompt by ID
 */
export async function getPrompt(id: string): Promise<PromptTemplate | null> {
  const prompts = await loadPrompts();
  return prompts.find((p) => p.id === id) || null;
}

// ==================== Search & Filter ====================

/**
 * Search prompts by query and optional filters
 */
export async function searchPrompts(
  query: string = "",
  filters?: { category?: PromptCategory; tags?: string[] },
): Promise<PromptTemplate[]> {
  const prompts = await loadPrompts();
  const lowerQuery = query.toLowerCase().trim();

  return prompts.filter((prompt) => {
    // Category filter
    if (filters?.category && prompt.category !== filters.category) {
      return false;
    }

    // Tags filter (match any)
    if (filters?.tags?.length) {
      const hasTag = filters.tags.some((tag) =>
        prompt.tags.map((t) => t.toLowerCase()).includes(tag.toLowerCase()),
      );
      if (!hasTag) return false;
    }

    // Query filter (search name, description, template)
    if (lowerQuery) {
      const searchFields = [
        prompt.name,
        prompt.description || "",
        prompt.template,
        ...prompt.tags,
      ].map((f) => f.toLowerCase());

      return searchFields.some((field) => field.includes(lowerQuery));
    }

    return true;
  });
}

/**
 * Get prompts by category
 */
export async function getPromptsByCategory(
  category: PromptCategory,
): Promise<PromptTemplate[]> {
  return searchPrompts("", { category });
}

/**
 * Get all unique tags from prompts
 */
export async function getAllPromptTags(): Promise<string[]> {
  const prompts = await loadPrompts();
  const tagSet = new Set<string>();

  prompts.forEach((p) => p.tags.forEach((t) => tagSet.add(t)));

  return Array.from(tagSet).sort();
}

// ==================== Placeholder Extraction ====================

/**
 * Extract placeholder info from a template string
 */
export function extractPlaceholders(template: string): PlaceholderInfo[] {
  const placeholders: PlaceholderInfo[] = [];
  let match: RegExpExecArray | null;

  // Reset regex state
  PLACEHOLDER_PATTERN.lastIndex = 0;

  while ((match = PLACEHOLDER_PATTERN.exec(template)) !== null) {
    const trigger = match[1];
    const key = match[2].trim();
    const type = PLACEHOLDER_TRIGGERS[trigger];

    if (type) {
      placeholders.push({
        key,
        type,
        required: true,
        position: match.index,
      });
    }
  }

  return placeholders;
}

/**
 * Get placeholder types used in a template
 */
export function getPlaceholderTypes(template: string): PlaceholderType[] {
  const placeholders = extractPlaceholders(template);
  return [...new Set(placeholders.map((p) => p.type))];
}

/**
 * Check if a template has placeholders
 */
export function hasPlaceholders(template: string): boolean {
  return extractPlaceholders(template).length > 0;
}

// ==================== Category Helpers ====================

export const CATEGORY_LABELS: Record<
  PromptCategory,
  { label: string; icon: import("./ui/icons").IconName }
> = {
  analysis: { label: "Analysis", icon: "search" },
  comparative: { label: "Comparative", icon: "scale" },
  writing: { label: "Writing", icon: "edit" },
  summary: { label: "Summary", icon: "paper" },
  skills: { label: "Skills", icon: "thumbs-up" },
  custom: { label: "Custom", icon: "settings" },
};

export function getCategoryLabel(category: PromptCategory): string {
  return CATEGORY_LABELS[category]?.label || category;
}

export function getCategoryIcon(
  category: PromptCategory,
): import("./ui/icons").IconName {
  return CATEGORY_LABELS[category]?.icon || "settings";
}
