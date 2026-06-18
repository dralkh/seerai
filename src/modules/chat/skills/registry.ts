import { config } from "../../../../package.json";
import { getBundledSkillTemplates } from "../promptLibrary";
import { getWorkspaceStore } from "../workspace/store";

export interface AgentSkill {
  id: string;
  name: string;
  description: string;
  source: "bundled" | "user" | "workspace" | "custom";
  tags: string[];
  content: string;
  enabled: boolean;
  trusted: boolean;
  path?: string;
  diagnostics?: string[];
}

export interface SkillRegistryState {
  disabled: string[];
  trustedSources: string[];
  customSources: string[];
}

const SKILLS_STATE_FILE = ".agent/skills.json";
const SKILL_ASSET_DIRS = ["references", "scripts", "assets"] as const;
const SKILL_CATALOG_LIMIT = 40;

const bundledSkills: AgentSkill[] = [
  {
    id: "paper-lookup",
    name: "paper-lookup",
    description:
      "Find, inspect, import, and read academic papers using Zotero, Semantic Scholar, web search, related-paper discovery, and OCR-backed content reading.",
    source: "bundled",
    tags: ["papers", "search", "zotero", "semantic-scholar"],
    enabled: true,
    trusted: true,
    content: [
      "# paper-lookup",
      "",
      "Use `search_library` first for papers already in Zotero, then `search_external` and `web` for external discovery.",
      "Use `get_item_metadata` for bibliographic details and `read_item_content` for full-text analysis.",
      "Use `related_papers` and `search_similar` for snowballing. Import only when the user asks or when the workflow requires Zotero persistence.",
    ].join("\n"),
  },
  {
    id: "literature-review",
    name: "literature-review",
    description:
      "Plan, screen, synthesize, and write literature reviews with Zotero collections, RAG, tables, and systematic review workflows.",
    source: "bundled",
    tags: ["literature-review", "synthesis", "systematic-review"],
    enabled: true,
    trusted: true,
    content: [
      "# literature-review",
      "",
      "Use `collection`, `search_library`, `semantic_search`, and `keyword_search` to gather evidence.",
      "Use `systematic_review` for PRISMA-style review projects, protocols, screening, extraction, synthesis, and gaps.",
      "Use `table` to create extraction matrices before writing narrative synthesis.",
    ].join("\n"),
  },
  {
    id: "citation-management",
    name: "citation-management",
    description:
      "Validate citations, organize references, manage Zotero collections, and create citation-backed notes.",
    source: "bundled",
    tags: ["citations", "references", "zotero"],
    enabled: true,
    trusted: true,
    content: [
      "# citation-management",
      "",
      "Use `get_item_metadata` to verify DOI, authors, dates, journal, and identifiers.",
      "Use `collection` to organize references and `note` to create citation-backed research notes.",
      "When writing, cite Zotero item IDs or stable identifiers available in tool results.",
    ].join("\n"),
  },
  {
    id: "scientific-writing",
    name: "scientific-writing",
    description:
      "Draft, revise, and structure scientific prose grounded in Zotero evidence and verified citations.",
    source: "bundled",
    tags: ["writing", "manuscript", "evidence"],
    enabled: true,
    trusted: true,
    content: [
      "# scientific-writing",
      "",
      "Ground claims in `read_item_content`, RAG results, tables, or review synthesis.",
      "Prefer concise IMRaD-style organization for manuscripts and state uncertainty when evidence is incomplete.",
      "Use `workspace_write_file` or `write_file` for draft artifacts.",
    ].join("\n"),
  },
  {
    id: "peer-review",
    name: "peer-review",
    description:
      "Review papers or manuscripts for novelty, validity, reporting quality, methods, limitations, and actionable revisions.",
    source: "bundled",
    tags: ["peer-review", "critique", "methods"],
    enabled: true,
    trusted: true,
    content: [
      "# peer-review",
      "",
      "Assess research question, design, sample, statistical approach, claims, limitations, and reproducibility.",
      "Separate major concerns from minor comments and tie every concern to evidence from the paper content.",
      "Do not invent missing manuscript details; ask with `clarify` if the required document is unavailable.",
    ].join("\n"),
  },
  {
    id: "document-processing",
    name: "document-processing",
    description:
      "Process PDFs, DOCX, markdown, images, and workspace files using SeerAI OCR, document conversion, and file tools.",
    source: "bundled",
    tags: ["pdf", "ocr", "docx", "files"],
    enabled: true,
    trusted: true,
    content: [
      "# document-processing",
      "",
      "Use `read_item_content` with `trigger_ocr: true` for Zotero PDFs that lack text.",
      "Use `read_file`, `search_files`, and `patch` for workspace documents.",
      "For DOCX and other workspace files, rely on SeerAI file preview/conversion support where available.",
    ].join("\n"),
  },
  {
    id: "experimental-design-and-power",
    name: "experimental-design-and-power",
    description:
      "Support study design, protocol criteria, outcome selection, effect measures, and power-analysis planning.",
    source: "bundled",
    tags: ["study-design", "power", "protocol"],
    enabled: true,
    trusted: true,
    content: [
      "# experimental-design-and-power",
      "",
      "Use `systematic_review` protocol tools to define research question, framework, inclusion/exclusion criteria, outcomes, and effect measures.",
      "Flag missing sample-size assumptions, baseline risk, variance, allocation ratio, and target effect before claiming power adequacy.",
      "Treat power calculations as planning support unless validated by a specialist tool or user-supplied formula.",
    ].join("\n"),
  },
  {
    id: "statistical-analysis",
    name: "statistical-analysis",
    description:
      "Guide extraction and interpretation of effect sizes, confidence intervals, heterogeneity, and evidence synthesis.",
    source: "bundled",
    tags: ["statistics", "meta-analysis", "effect-size"],
    enabled: true,
    trusted: true,
    content: [
      "# statistical-analysis",
      "",
      "Use `systematic_review` extraction and synthesis tools for effect measures, confidence intervals, heterogeneity, and gap analysis.",
      "Use extraction-health warnings for missing CIs, extreme effects, negative variances, and duplicate extractions.",
      "Explain assumptions and prefer narrative fallback when quantitative synthesis is not defensible.",
    ].join("\n"),
  },
];

async function promptLibraryAgentSkills(): Promise<AgentSkill[]> {
  return (await getBundledSkillTemplates())
    .filter((prompt) => prompt.tags.includes("agent-skill"))
    .map((prompt) => ({
      id: prompt.id.replace(/^builtin-agent-skill-/, ""),
      name: prompt.name.replace(/^Agent Skill:\s*/i, ""),
      description: prompt.description || prompt.name,
      source: "bundled" as const,
      tags: prompt.tags,
      content: prompt.template,
      enabled: true,
      trusted: true,
      path: prompt.sourcePath,
    }));
}

function normalizeSkillId(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function queryTokens(query: string): string[] {
  const stopWords = new Set([
    "and",
    "or",
    "the",
    "for",
    "with",
    "from",
    "into",
    "using",
    "methods",
  ]);
  return Array.from(
    new Set(
      query
        .toLowerCase()
        .split(/[^a-z0-9+-]+/)
        .map((token) => token.trim())
        .filter((token) => token.length > 2 && !stopWords.has(token)),
    ),
  );
}

function scoreSkillMatch(skill: AgentSkill, tokens: string[]): number {
  const titleText =
    `${skill.id} ${skill.name} ${skill.tags.join(" ")}`.toLowerCase();
  const bodyText =
    `${skill.description} ${skill.content.slice(0, 4000)}`.toLowerCase();
  return tokens.reduce((score, token) => {
    let nextScore = score;
    if (titleText.includes(token)) nextScore += 3;
    if (bodyText.includes(token)) nextScore += 1;
    return nextScore;
  }, 0);
}

function dirname(path: string): string {
  return path.replace(/[\\/][^\\/]*$/, "");
}

function isSkillMarkdownPath(path: string): boolean {
  return /(^|[\\/])SKILL\.md$/i.test(path) || /\.md$/i.test(path);
}

function isPackagedUrlPath(path?: string): boolean {
  return (
    !!path &&
    !path.startsWith("file://") &&
    /^[a-z][a-z0-9+.-]*:/i.test(path)
  );
}

function decodeFileUrl(path: string): string {
  return path.startsWith("file://") ? decodeURIComponent(path.slice(7)) : path;
}

function joinPackagedUrl(base: string, relativePath: string): string {
  const cleanBase = base.replace(/\/+$/, "");
  const cleanPath = relativePath
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
  return `${cleanBase}/${cleanPath}`;
}

function normalizeRelativePath(path?: string): string {
  if (!path) return "SKILL.md";
  const normalized = path.replace(/\\/g, "/").replace(/^\/+/, "");
  const parts = normalized.split("/").filter(Boolean);
  if (
    normalized.includes("\0") ||
    /^[a-z]+:/i.test(path) ||
    parts.some((part) => part === "." || part === "..")
  ) {
    throw new Error(`Invalid skill reference path: ${path}`);
  }
  return parts.join("/");
}

function isInsideDir(base: string, candidate: string): boolean {
  const normalizedBase = base.replace(/\\/g, "/").replace(/\/+$/, "");
  const normalizedCandidate = candidate.replace(/\\/g, "/");
  return (
    normalizedCandidate === normalizedBase ||
    normalizedCandidate.startsWith(normalizedBase + "/")
  );
}

async function getSkillBaseDir(skill: AgentSkill): Promise<string> {
  if (skill.path) {
    if (isPackagedUrlPath(skill.path)) return dirname(skill.path);
    const localPath = decodeFileUrl(skill.path);
    const stat = await IOUtils.stat(localPath).catch(() => null);
    if (stat?.type === "directory") return localPath;
    return dirname(localPath);
  }
  return PathUtils.join(getSkillsFilesystemDir(), skill.id);
}

async function addFilesRecursively(
  baseDir: string,
  dir: string,
  output: string[],
): Promise<void> {
  const children = await IOUtils.getChildren(dir);
  for (const child of children) {
    const stat = await IOUtils.stat(child).catch(() => null);
    if (!stat) continue;
    if (stat.type === "directory") {
      await addFilesRecursively(baseDir, child, output);
      continue;
    }
    const rel = child
      .replace(/\\/g, "/")
      .slice(baseDir.replace(/\\/g, "/").replace(/\/+$/, "").length + 1);
    output.push(rel);
  }
}

async function readState(): Promise<SkillRegistryState> {
  const store = getWorkspaceStore();
  try {
    const file = await store.readFile(SKILLS_STATE_FILE);
    if (!file?.content) throw new Error("empty");
    const parsed = JSON.parse(file.content) as Partial<SkillRegistryState>;
    return {
      disabled: Array.isArray(parsed.disabled) ? parsed.disabled : [],
      trustedSources: Array.isArray(parsed.trustedSources)
        ? parsed.trustedSources
        : [],
      customSources: Array.isArray(parsed.customSources)
        ? parsed.customSources
        : [],
    };
  } catch {
    return { disabled: [], trustedSources: [], customSources: [] };
  }
}

async function writeState(state: SkillRegistryState): Promise<void> {
  await getWorkspaceStore().writeFile(
    SKILLS_STATE_FILE,
    JSON.stringify(state, null, 2),
    "Update Agent Skills registry",
    "system",
  );
}

export function parseSkillMarkdown(
  text: string,
  source: AgentSkill["source"],
  path?: string,
): AgentSkill | null {
  const diagnostics: string[] = [];
  let frontmatter = "";
  let body = text;
  if (text.startsWith("---")) {
    const end = text.indexOf("\n---", 3);
    if (end >= 0) {
      frontmatter = text.slice(3, end).trim();
      body = text.slice(end + 4).trimStart();
    }
  }

  const fields: Record<string, string> = {};
  for (const rawLine of frontmatter.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (!match) {
      diagnostics.push(`Ignored metadata line: ${line}`);
      continue;
    }
    fields[match[1].toLowerCase()] = match[2].replace(/^["']|["']$/g, "");
  }

  const heading = /^#\s+(.+)$/m.exec(body)?.[1]?.trim();
  const name =
    fields.name ||
    fields.id ||
    heading ||
    (path ? path.split("/").pop()?.replace(/\.md$/i, "") : "");
  const description = fields.description || fields.summary || "";
  if (!name || !description) return null;

  return {
    id: normalizeSkillId(name),
    name,
    description,
    source,
    tags: (fields.tags || "")
      .replace(/^\[|\]$/g, "")
      .split(",")
      .map((tag) => tag.trim().replace(/^["']|["']$/g, ""))
      .filter(Boolean),
    content: body || text,
    enabled: true,
    trusted: source === "bundled",
    path,
    diagnostics,
  };
}

async function loadSkillFilesFromDir(
  dir: string,
  source: AgentSkill["source"],
  trusted: boolean,
): Promise<AgentSkill[]> {
  const skills: AgentSkill[] = [];
  try {
    if (!(await IOUtils.exists(dir))) return skills;
    const children = await IOUtils.getChildren(dir);
    for (const child of children) {
      const name = child.split(/[\\/]/).pop() || "";
      const stat = await IOUtils.stat(child).catch(() => null);
      let skillPath = child;
      if (stat?.type === "directory") {
        skillPath = PathUtils.join(child, "SKILL.md");
        if (!(await IOUtils.exists(skillPath).catch(() => false))) continue;
      } else if (
        !name.toLowerCase().endsWith(".md") &&
        name.toUpperCase() !== "SKILL.MD"
      ) {
        continue;
      }
      const text = await IOUtils.readUTF8(skillPath);
      const parsed = parseSkillMarkdown(text, source, skillPath);
      if (parsed) {
        parsed.trusted = trusted;
        skills.push(parsed);
      }
    }
  } catch (e) {
    Zotero.debug(`[seerai] loadSkillFilesFromDir failed for ${dir}: ${e}`);
  }
  return skills;
}

export async function listAgentSkills(query?: string): Promise<AgentSkill[]> {
  const state = await readState();
  const dataDir = PathUtils.join(
    Zotero.DataDirectory.dir,
    config.addonRef,
    "skills",
  );
  const legacyDataDir = PathUtils.join(
    Zotero.DataDirectory.dir,
    config.addonRef,
    "prompts",
  );
  const workspaceDir = PathUtils.join(
    getWorkspaceStore().workspaceDir,
    ".agents",
    "skills",
  );
  const loaded = [
    ...bundledSkills,
    ...(await promptLibraryAgentSkills()),
    ...(await loadSkillFilesFromDir(dataDir, "user", true)),
    ...(await loadSkillFilesFromDir(legacyDataDir, "user", true)),
    ...(await loadSkillFilesFromDir(
      workspaceDir,
      "workspace",
      state.trustedSources.includes(workspaceDir),
    )),
  ];

  for (const source of state.customSources) {
    loaded.push(
      ...(await loadSkillFilesFromDir(
        source,
        "custom",
        state.trustedSources.includes(source),
      )),
    );
  }

  const byId = new Map<string, AgentSkill>();
  for (const skill of loaded) {
    byId.set(skill.id, {
      ...skill,
      enabled: !state.disabled.includes(skill.id),
    });
  }

  const needle = query?.trim().toLowerCase();
  const result = Array.from(byId.values());
  if (!needle) return result.sort((a, b) => a.name.localeCompare(b.name));

  const tokens = queryTokens(needle);
  if (tokens.length > 0) {
    return result
      .map((skill) => ({ skill, score: scoreSkillMatch(skill, tokens) }))
      .filter((entry) => entry.score > 0)
      .sort(
        (a, b) => b.score - a.score || a.skill.name.localeCompare(b.skill.name),
      )
      .map((entry) => entry.skill);
  }

  return result
    .filter((skill) =>
      [skill.id, skill.name, skill.description, skill.tags.join(" ")]
        .join(" ")
        .toLowerCase()
        .includes(needle),
    )
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function viewAgentSkill(name: string): Promise<AgentSkill | null> {
  const id = normalizeSkillId(name);
  const skills = await listAgentSkills();
  return skills.find((skill) => skill.id === id || skill.name === name) || null;
}

export async function manageAgentSkills(args: {
  action:
    | "refresh"
    | "enable"
    | "disable"
    | "trust_source"
    | "untrust_source"
    | "add_source"
    | "remove_source";
  skill?: string;
  source_path?: string;
}): Promise<{ state: SkillRegistryState; skills: AgentSkill[] }> {
  const state = await readState();
  const skillId = args.skill ? normalizeSkillId(args.skill) : "";

  if (args.action === "enable" && skillId) {
    state.disabled = state.disabled.filter((id) => id !== skillId);
  } else if (args.action === "disable" && skillId) {
    if (!state.disabled.includes(skillId)) state.disabled.push(skillId);
  } else if (args.source_path && args.action === "add_source") {
    if (!state.customSources.includes(args.source_path)) {
      state.customSources.push(args.source_path);
    }
  } else if (args.source_path && args.action === "remove_source") {
    state.customSources = state.customSources.filter(
      (p) => p !== args.source_path,
    );
    state.trustedSources = state.trustedSources.filter(
      (p) => p !== args.source_path,
    );
  } else if (args.source_path && args.action === "trust_source") {
    if (!state.trustedSources.includes(args.source_path)) {
      state.trustedSources.push(args.source_path);
    }
  } else if (args.source_path && args.action === "untrust_source") {
    state.trustedSources = state.trustedSources.filter(
      (p) => p !== args.source_path,
    );
  }

  await writeState(state);
  return { state, skills: await listAgentSkills() };
}

export async function buildAgentSkillsCatalog(): Promise<string> {
  const skills = (await listAgentSkills()).filter((skill) => skill.enabled);
  if (skills.length === 0) return "";
  const shown = skills.slice(0, SKILL_CATALOG_LIMIT);
  const lines = shown.map(
    (skill) =>
      `- ${skill.name}: ${skill.description} [source=${skill.source}, trusted=${skill.trusted}]`,
  );
  if (skills.length > shown.length) {
    lines.push(
      `- ${skills.length - shown.length} more skills available. Use \`skills_list\` with a query to search the full catalog.`,
    );
  }
  return [
    "Agent Skills available. Use `skill_view` before applying a skill's detailed procedure.",
    ...lines,
  ].join("\n");
}

export interface SkillAssetList {
  skillDir: string;
  references: string[];
  scripts: string[];
  assets: string[];
}

export async function getSkillAssetList(
  name: string,
): Promise<SkillAssetList | null> {
  const skill = await viewAgentSkill(name);
  if (!skill) return null;

  const skillDir = await getSkillBaseDir(skill);

  const result: SkillAssetList = {
    skillDir,
    references: [],
    scripts: [],
    assets: [],
  };

  try {
    if (isPackagedUrlPath(skillDir)) return result;
    if (!(await IOUtils.exists(skillDir))) return result;
    for (const assetDir of SKILL_ASSET_DIRS) {
      const dir = PathUtils.join(skillDir, assetDir);
      if (!(await IOUtils.exists(dir).catch(() => false))) continue;
      await addFilesRecursively(skillDir, dir, result[assetDir]);
    }
  } catch (e) {
    Zotero.debug(`[seerai] getSkillAssetList failed: ${e}`);
  }

  return result;
}

export function getSkillsFilesystemDir(): string {
  if (typeof rootURI !== "string") return "";
  let path = rootURI;
  if (path.startsWith("file://")) path = decodeURIComponent(path.slice(7));
  if (path.startsWith("jar:file://")) {
    path = decodeURIComponent(path.slice(11));
    const excl = path.indexOf("!");
    if (excl >= 0) path = path.slice(0, excl);
  }
  return PathUtils.join(path, "skills");
}

export async function readSkillReference(
  name: string,
  refPath?: string,
): Promise<string | null> {
  const skill = await viewAgentSkill(name);
  if (!skill) return null;

  let safeRefPath: string;
  try {
    safeRefPath = normalizeRelativePath(refPath);
  } catch (e) {
    Zotero.debug(`[seerai] readSkillReference rejected path: ${e}`);
    return null;
  }

  const skillDir = await getSkillBaseDir(skill);
  const localSkillPath = skill.path ? decodeFileUrl(skill.path) : "";
  const filePath =
    isSkillMarkdownPath(localSkillPath) && !refPath
      ? localSkillPath
      : isPackagedUrlPath(skillDir)
        ? joinPackagedUrl(skillDir, safeRefPath)
        : PathUtils.join(skillDir, safeRefPath);

  if (isPackagedUrlPath(filePath)) {
    try {
      const resp = await fetch(filePath);
      if (!resp.ok) return null;
      return await resp.text();
    } catch {
      return null;
    }
  }

  try {
    if (!isInsideDir(skillDir, filePath)) return null;
    if (!(await IOUtils.exists(filePath))) {
      return null;
    }
    return await IOUtils.readUTF8(filePath);
  } catch {
    try {
      if (skill.source !== "bundled" || typeof rootURI !== "string") {
        return null;
      }
      const fetchPath = safeRefPath
        .split("/")
        .map((part) => encodeURIComponent(part))
        .join("/");
      const fetchUrl = `${rootURI}skills/${skill.id}/${fetchPath}`;
      const resp = await fetch(fetchUrl);
      if (!resp.ok) return null;
      return await resp.text();
    } catch {
      return null;
    }
  }
}
