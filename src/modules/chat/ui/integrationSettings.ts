import { getPref, setPref } from "../../../utils/prefs";
import { createSvgIcon, type IconName } from "./icons";
import { ensureMcpServerOnDisk } from "../cli/mcpBridge";

// Renders the Seer-AI preference sections (MCP, data management, OCR, web
// search, RAG, etc.) as styled HTML that matches the AI providers / default
// models surface, instead of the legacy XUL markup. Each `render*` helper fills
// a container that carries the `seerai-provider-surface` card class in
// preferences.xhtml.

const HTML_NS = "http://www.w3.org/1999/xhtml";

function el<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  className?: string,
): HTMLElementTagNameMap[K] {
  const node = doc.createElementNS(HTML_NS, tag) as HTMLElementTagNameMap[K];
  if (className) node.className = className;
  return node;
}

// Builds the card header and a padded body, appends both to the (overflow:
// hidden) surface card, and returns the body so callers can fill it with
// breathing room instead of letting controls touch the card border.
function sectionShell(
  doc: Document,
  container: HTMLElement,
  title: string,
  subtitle?: string,
): HTMLElement {
  container.replaceChildren();
  const header = el(doc, "div", "seerai-settings-section-header");
  const heading = el(doc, "div");
  const h3 = el(doc, "h3");
  h3.textContent = title;
  heading.appendChild(h3);
  if (subtitle) {
    const p = el(doc, "p");
    p.textContent = subtitle;
    heading.appendChild(p);
  }
  header.appendChild(heading);
  container.appendChild(header);
  const body = el(doc, "div", "seerai-settings-body");
  container.appendChild(body);
  return body;
}

function subHeading(doc: Document, text: string): HTMLElement {
  const node = el(doc, "h4", "seerai-settings-subheading");
  node.textContent = text;
  return node;
}

function fieldRows(doc: Document): HTMLElement {
  return el(doc, "div", "seerai-settings-fields");
}

function textField(
  doc: Document,
  labelText: string,
  get: () => string,
  set: (value: string) => void,
  opts: { password?: boolean; placeholder?: string } = {},
): HTMLElement {
  const label = el(doc, "label", "seerai-field");
  const span = el(doc, "span");
  span.textContent = labelText;
  const input = el(doc, "input");
  input.type = opts.password ? "password" : "text";
  input.value = get();
  if (opts.placeholder) input.placeholder = opts.placeholder;
  input.addEventListener("change", () => set(input.value.trim()));
  label.append(span, input);
  return label;
}

function numberField(
  doc: Document,
  labelText: string,
  get: () => number,
  set: (value: number) => void,
  opts: { min?: number; max?: number; placeholder?: string } = {},
): HTMLElement {
  const label = el(doc, "label", "seerai-field");
  const span = el(doc, "span");
  span.textContent = labelText;
  const input = el(doc, "input");
  input.type = "number";
  if (opts.min !== undefined) input.min = String(opts.min);
  if (opts.max !== undefined) input.max = String(opts.max);
  if (opts.placeholder) input.placeholder = opts.placeholder;
  const value = get();
  input.value = Number.isFinite(value) ? String(value) : "";
  input.addEventListener("change", () => {
    let parsed = parseInt(input.value, 10);
    if (Number.isNaN(parsed)) return;
    if (opts.min !== undefined) parsed = Math.max(opts.min, parsed);
    if (opts.max !== undefined) parsed = Math.min(opts.max, parsed);
    input.value = String(parsed);
    set(parsed);
  });
  label.append(span, input);
  return label;
}

function selectField(
  doc: Document,
  labelText: string,
  get: () => string,
  set: (value: string) => void,
  options: Array<{ value: string; label: string }>,
): HTMLElement {
  const label = el(doc, "label", "seerai-field");
  const span = el(doc, "span");
  span.textContent = labelText;
  const select = el(doc, "select");
  for (const option of options) {
    const node = el(doc, "option");
    node.value = option.value;
    node.textContent = option.label;
    select.appendChild(node);
  }
  select.value = get();
  select.addEventListener("change", () => set(select.value));
  label.append(span, select);
  return label;
}

function checkboxField(
  doc: Document,
  labelText: string,
  get: () => boolean,
  set: (value: boolean) => void,
  title?: string,
): HTMLElement {
  const label = el(doc, "label", "seerai-check-field");
  const input = el(doc, "input");
  input.type = "checkbox";
  input.checked = get();
  input.addEventListener("change", () => set(input.checked));
  const span = el(doc, "span");
  span.textContent = labelText;
  if (title) label.title = title;
  label.append(input, span);
  return label;
}

function helpText(doc: Document, text: string): HTMLElement {
  const node = el(doc, "p", "seerai-settings-help");
  node.textContent = text;
  return node;
}

function link(doc: Document, label: string, href: string): HTMLElement {
  const anchor = el(doc, "a", "seerai-settings-link");
  anchor.textContent = label;
  anchor.href = href;
  anchor.addEventListener("click", (event) => {
    event.preventDefault();
    Zotero.launchURL(href);
  });
  return anchor;
}

function button(
  doc: Document,
  label: string,
  variant: "primary" | "secondary" | "danger",
  onClick: () => void,
  icon?: IconName,
): HTMLButtonElement {
  const node = el(doc, "button", `seerai-${variant}-button`);
  node.type = "button";
  if (icon) node.appendChild(createSvgIcon(doc, icon, { size: 14 }));
  node.append(icon ? ` ${label}` : label);
  node.addEventListener("click", onClick);
  return node;
}

// ---------------------------------------------------------------------------
// MCP Server Integration
// ---------------------------------------------------------------------------

export function renderMcpSettings(doc: Document, container: HTMLElement): void {
  const body = sectionShell(
    doc,
    container,
    "MCP Server Integration",
    "Connect Seer-AI to Claude Desktop and other Model Context Protocol clients.",
  );

  const actions = el(doc, "div", "seerai-inline-actions");
  actions.append(
    button(
      doc,
      "GitHub Repo",
      "secondary",
      () => Zotero.launchURL("https://github.com/dralkh/seerai"),
      "open-link",
    ),
    button(
      doc,
      "Download Release",
      "secondary",
      () => Zotero.launchURL("https://github.com/dralkh/seerai/releases"),
      "download",
    ),
  );
  body.appendChild(actions);

  const fieldLabel = el(doc, "label", "seerai-field");
  const span = el(doc, "span");
  span.textContent = "Configuration (mcp_config.json)";
  const textarea = el(doc, "textarea", "seerai-settings-code");
  textarea.readOnly = true;
  textarea.rows = 7;
  const mcpConfigJson = (serverPath: string): string =>
    JSON.stringify(
      {
        mcpServers: {
          "seerai-zotero": { command: "node", args: [serverPath] },
        },
      },
      null,
      2,
    );
  textarea.value = mcpConfigJson("/absolute/path/to/seerai-mcp.cjs");
  // Replace the placeholder with the real on-disk path once resolved.
  void ensureMcpServerOnDisk()
    .then((serverPath) => {
      if (serverPath) textarea.value = mcpConfigJson(serverPath);
    })
    .catch(() => {});
  fieldLabel.append(span, textarea);
  body.appendChild(fieldLabel);

  const copyRow = el(doc, "div", "seerai-inline-actions");
  const copyBtn = button(
    doc,
    "Copy Config to Clipboard",
    "primary",
    () => {
      try {
        const clipboard = (Components.classes as any)[
          "@mozilla.org/widget/clipboardhelper;1"
        ].getService((Components.interfaces as any).nsIClipboardHelper);
        clipboard.copyString(textarea.value);
        const original = copyBtn.textContent;
        copyBtn.textContent = "Copied!";
        setTimeout(() => {
          copyBtn.textContent = original;
        }, 2000);
      } catch (e) {
        doc.defaultView?.alert("Failed to copy to clipboard");
        Zotero.debug(`[seerai] MCP copy failed: ${e}`);
      }
    },
    "copy",
  );
  copyRow.appendChild(copyBtn);
  body.appendChild(copyRow);
}

// ---------------------------------------------------------------------------
// Advanced Data Management
// ---------------------------------------------------------------------------

export function renderDataManagementSettings(
  doc: Document,
  container: HTMLElement,
): void {
  const body = sectionShell(
    doc,
    container,
    "Advanced Data Management",
    "Export or import your entire Seer-AI configuration, including models, prompts, tables, and API keys.",
  );

  const win = doc.defaultView as Window;
  const Cc = (Components as any).classes;
  const Ci = (Components as any).interfaces;
  const api = () =>
    // @ts-expect-error - Zotero.SeerAI.api not in types
    Zotero.SeerAI.api.ConfigManager as {
      exportAllData: () => Promise<unknown>;
      importAllData: (
        data: unknown,
      ) => Promise<{ success: boolean; stats?: string; error?: string }>;
    };

  const actions = el(doc, "div", "seerai-inline-actions");
  actions.append(
    button(
      doc,
      "Export Configuration",
      "secondary",
      async () => {
        try {
          const data = await api().exportAllData();
          const json = JSON.stringify(data, null, 2);
          const fp = Cc["@mozilla.org/filepicker;1"].createInstance(
            Ci.nsIFilePicker,
          );
          fp.init(
            win,
            "Export Seer-AI Configuration",
            Ci.nsIFilePicker.modeSave,
          );
          fp.appendFilter("JSON Files", "*.json");
          fp.defaultString = `seerai-config-${new Date().toISOString().slice(0, 10)}.json`;
          const res = await new Promise((resolve) => fp.open(resolve));
          if (res !== Ci.nsIFilePicker.returnCancel && fp.file) {
            await IOUtils.writeUTF8(fp.file.path, json);
            Zotero.debug(`[seerai] Exported config to ${fp.file.path}`);
          }
        } catch (e) {
          Zotero.debug(`[seerai] Export failed: ${e}`);
          win.alert(`Export failed: ${e}`);
        }
      },
      "download",
    ),
    button(
      doc,
      "Import Configuration",
      "secondary",
      async () => {
        try {
          const fp = Cc["@mozilla.org/filepicker;1"].createInstance(
            Ci.nsIFilePicker,
          );
          fp.init(
            win,
            "Import Seer-AI Configuration",
            Ci.nsIFilePicker.modeOpen,
          );
          fp.appendFilter("JSON Files", "*.json");
          const res = await new Promise((resolve) => fp.open(resolve));
          if (res !== Ci.nsIFilePicker.returnCancel && fp.file) {
            const json = await IOUtils.readUTF8(fp.file.path);
            const data = JSON.parse(json);
            if (
              win.confirm(
                "This will overwrite your current Seer-AI configuration (preferences, tables, prompts). Are you sure?",
              )
            ) {
              const result = await api().importAllData(data);
              if (result.success) {
                win.alert(
                  `Import Successful!\n${result.stats}\nPlease restart Zotero/Seer-AI for all changes to take full effect.`,
                );
              } else {
                win.alert(`Import Failed: ${result.error}`);
              }
            }
          }
        } catch (e) {
          Zotero.debug(`[seerai] Import failed: ${e}`);
          win.alert(`Import failed: ${e}`);
        }
      },
      "cloud",
    ),
  );
  body.appendChild(actions);
}

// ---------------------------------------------------------------------------
// OCR Configuration
// ---------------------------------------------------------------------------

export function renderOcrSettings(doc: Document, container: HTMLElement): void {
  const body = sectionShell(
    doc,
    container,
    "OCR Configuration",
    "Choose how PDFs are converted to text for AI processing.",
  );

  const fields = fieldRows(doc);
  const modeFields = el(doc, "div", "seerai-settings-fields");

  const renderMode = () => {
    const mode = (getPref("datalabMode") as string) || "cloud";
    modeFields.replaceChildren();
    if (mode === "local") {
      modeFields.append(
        textField(
          doc,
          "Marker server URL",
          () => (getPref("datalabUrl") as string) || "",
          (v) => setPref("datalabUrl", v),
          { placeholder: "http://localhost:8001" },
        ),
        checkboxField(
          doc,
          "Force OCR",
          () => !!getPref("localForceOcr"),
          (v) => setPref("localForceOcr", v),
        ),
      );
    } else if (mode === "cloud") {
      modeFields.append(
        textField(
          doc,
          "DataLab API key",
          () => (getPref("datalabApiKey") as string) || "",
          (v) => setPref("datalabApiKey", v),
          { password: true, placeholder: "Token from datalab.to" },
        ),
        checkboxField(
          doc,
          "Force OCR",
          () => !!getPref("cloudForceOcr"),
          (v) => setPref("cloudForceOcr", v),
        ),
        checkboxField(
          doc,
          "Use LLM-enhanced extraction",
          () => !!getPref("cloudUseLlm"),
          (v) => setPref("cloudUseLlm", v),
        ),
      );
    } else {
      modeFields.append(
        textField(
          doc,
          "Mistral API key",
          () => (getPref("mistralApiKey") as string) || "",
          (v) => setPref("mistralApiKey", v),
          { password: true, placeholder: "Mistral API Key" },
        ),
      );
    }
    modeFields.append(
      numberField(
        doc,
        "Maximum concurrent OCR jobs",
        () => (getPref("datalabMaxConcurrent") as number) || 5,
        (v) => setPref("datalabMaxConcurrent", v),
        { min: 1, max: 20 },
      ),
    );
  };

  fields.append(
    selectField(
      doc,
      "Provider",
      () => (getPref("datalabMode") as string) || "cloud",
      (v) => {
        setPref("datalabMode", v);
        setPref("datalabUseLocal", v === "local");
        renderMode();
      },
      [
        { value: "local", label: "Local Marker Server" },
        { value: "cloud", label: "Cloud (DataLab.to)" },
        { value: "mistral", label: "Mistral OCR" },
      ],
    ),
  );
  body.append(fields, modeFields);
  renderMode();
}

// ---------------------------------------------------------------------------
// Semantic Scholar
// ---------------------------------------------------------------------------

export function renderSemanticScholarSettings(
  doc: Document,
  container: HTMLElement,
): void {
  const body = sectionShell(
    doc,
    container,
    "Scholarly Search",
    "Configure native academic search sources used by the Search tab.",
  );
  const fields = fieldRows(doc);
  fields.appendChild(
    selectField(
      doc,
      "Default search mode",
      () => (getPref("scholarlySearchMode") as string) || "source",
      (v) => setPref("scholarlySearchMode", v),
      [
        { value: "broad", label: "Broad discovery" },
        { value: "biomedical", label: "Biomedical" },
        { value: "preprints", label: "Preprints" },
        { value: "cryptography", label: "Cryptography" },
        { value: "repositories", label: "Open repositories" },
        { value: "source", label: "Single source" },
      ],
    ),
  );
  fields.appendChild(
    textField(
      doc,
      "Contact email for scholarly APIs",
      () => (getPref("scholarlySearchEmail") as string) || "",
      (v) => setPref("scholarlySearchEmail", v),
      { placeholder: "researcher@example.org" },
    ),
  );
  fields.appendChild(
    textField(
      doc,
      "Semantic Scholar API key (optional)",
      () => (getPref("semanticScholarApiKey") as string) || "",
      (v) => setPref("semanticScholarApiKey", v),
      { password: true, placeholder: "S2 API Key" },
    ),
  );
  fields.appendChild(
    textField(
      doc,
      "NCBI API key (optional)",
      () => (getPref("ncbiApiKey") as string) || "",
      (v) => setPref("ncbiApiKey", v),
      { password: true, placeholder: "PubMed / NCBI key" },
    ),
  );
  fields.appendChild(
    textField(
      doc,
      "CORE API key",
      () => (getPref("coreApiKey") as string) || "",
      (v) => setPref("coreApiKey", v),
      { password: true, placeholder: "CORE key" },
    ),
  );
  fields.appendChild(
    textField(
      doc,
      "BASE API key",
      () => (getPref("baseApiKey") as string) || "",
      (v) => setPref("baseApiKey", v),
      { password: true, placeholder: "Registered BASE key" },
    ),
  );
  fields.appendChild(
    textField(
      doc,
      "Zenodo access token (optional)",
      () => (getPref("zenodoAccessToken") as string) || "",
      (v) => setPref("zenodoAccessToken", v),
      { password: true, placeholder: "Zenodo token" },
    ),
  );
  body.appendChild(fields);
  body.appendChild(
    helpText(
      doc,
      "arXiv, PubMed, Europe PMC, bioRxiv, medRxiv, IACR, Zenodo, and HAL work without keys. CORE and BASE remain visible but require credentials.",
    ),
  );
  const linkRow = el(doc, "div", "seerai-inline-actions");
  linkRow.appendChild(
    link(
      doc,
      "Get API Key",
      "https://www.semanticscholar.org/product/api#api-key",
    ),
  );
  body.appendChild(linkRow);
}

// ---------------------------------------------------------------------------
// Web Search
// ---------------------------------------------------------------------------

export function renderWebSearchSettings(
  doc: Document,
  container: HTMLElement,
): void {
  const body = sectionShell(
    doc,
    container,
    "Web Search Integration",
    "Used for PDF discovery and to add live web context to chats.",
  );

  const fields = fieldRows(doc);
  const providerFields = el(doc, "div", "seerai-settings-fields");

  const renderProvider = () => {
    const provider = (getPref("webSearchProvider") as string) || "firecrawl";
    providerFields.replaceChildren();
    if (provider === "firecrawl") {
      providerFields.append(
        textField(
          doc,
          "API key",
          () => (getPref("firecrawlApiKey") as string) || "",
          (v) => setPref("firecrawlApiKey", v),
          { password: true, placeholder: "fc-YOUR-API-KEY" },
        ),
        textField(
          doc,
          "API URL",
          () => (getPref("firecrawlApiUrl") as string) || "",
          (v) => setPref("firecrawlApiUrl", v),
          { placeholder: "https://api.firecrawl.dev/v2" },
        ),
        numberField(
          doc,
          "Results per query",
          () => (getPref("firecrawlSearchLimit") as number) || 3,
          (v) => setPref("firecrawlSearchLimit", v),
          { min: 1, max: 10 },
        ),
        numberField(
          doc,
          "Maximum concurrent requests",
          () => (getPref("firecrawlMaxConcurrent") as number) || 3,
          (v) => setPref("firecrawlMaxConcurrent", v),
          { min: 1, max: 10 },
        ),
      );
    } else if (provider === "tavily") {
      providerFields.append(
        textField(
          doc,
          "API key",
          () => (getPref("tavilyApiKey") as string) || "",
          (v) => setPref("tavilyApiKey", v),
          { password: true, placeholder: "tvly-YOUR-API-KEY" },
        ),
        selectField(
          doc,
          "Search depth",
          () => (getPref("tavilySearchDepth") as string) || "basic",
          (v) => setPref("tavilySearchDepth", v),
          [
            { value: "basic", label: "Basic (faster)" },
            { value: "advanced", label: "Advanced (deeper)" },
          ],
        ),
        numberField(
          doc,
          "Results per query",
          () => (getPref("tavilySearchLimit") as number) || 5,
          (v) => setPref("tavilySearchLimit", v),
          { min: 1, max: 20 },
        ),
      );
    } else if (provider === "nanogpt") {
      providerFields.append(
        textField(
          doc,
          "API key",
          () => (getPref("nanogptWebApiKey") as string) || "",
          (v) => setPref("nanogptWebApiKey", v),
          { password: true },
        ),
        selectField(
          doc,
          "Search depth",
          () => (getPref("nanogptWebSearchDepth") as string) || "standard",
          (v) => setPref("nanogptWebSearchDepth", v),
          [
            { value: "standard", label: "Standard" },
            { value: "deep", label: "Deep" },
          ],
        ),
        numberField(
          doc,
          "Results per query",
          () => (getPref("nanogptWebSearchLimit") as number) || 5,
          (v) => setPref("nanogptWebSearchLimit", v),
          { min: 1, max: 20 },
        ),
      );
    } else {
      providerFields.append(
        textField(
          doc,
          "API key",
          () => (getPref("youdotcomApiKey") as string) || "",
          (v) => setPref("youdotcomApiKey", v),
          { password: true, placeholder: "YOUR-YOU-API-KEY" },
        ),
        selectField(
          doc,
          "Search mode",
          () => (getPref("youdotcomSearchMode") as string) || "normal",
          (v) => setPref("youdotcomSearchMode", v),
          [
            { value: "normal", label: "Normal" },
            { value: "research", label: "Research" },
          ],
        ),
        numberField(
          doc,
          "Results per query",
          () => (getPref("youdotcomSearchLimit") as number) || 5,
          (v) => setPref("youdotcomSearchLimit", v),
          { min: 1, max: 20 },
        ),
      );
    }
  };

  fields.append(
    selectField(
      doc,
      "Search provider",
      () => (getPref("webSearchProvider") as string) || "firecrawl",
      (v) => {
        setPref("webSearchProvider", v);
        renderProvider();
      },
      [
        { value: "firecrawl", label: "Firecrawl" },
        { value: "tavily", label: "Tavily" },
        { value: "nanogpt", label: "NanoGPT" },
        { value: "youdotcom", label: "You.com" },
      ],
    ),
  );
  body.append(fields, providerFields);
  renderProvider();
}

// ---------------------------------------------------------------------------
// AI & Table Settings
// ---------------------------------------------------------------------------

export function renderAiTableSettings(
  doc: Document,
  container: HTMLElement,
): void {
  const body = sectionShell(
    doc,
    container,
    "AI & Table Settings",
    "Throughput and notifications for AI-powered analysis tables.",
  );
  const fields = fieldRows(doc);
  fields.append(
    numberField(
      doc,
      "Maximum concurrent AI requests",
      () => (getPref("aiMaxConcurrent") as number) || 5,
      (v) => setPref("aiMaxConcurrent", v),
      { min: 1, max: 20 },
    ),
    checkboxField(
      doc,
      "Sound notification on table generation complete",
      () => getPref("tableGenerationSound") !== false,
      (v) => setPref("tableGenerationSound", v),
    ),
  );
  body.appendChild(fields);
}

// ---------------------------------------------------------------------------
// RAG & Reranker Settings
// ---------------------------------------------------------------------------

export function renderRagRerankerSettings(
  doc: Document,
  container: HTMLElement,
): void {
  const body = sectionShell(
    doc,
    container,
    "RAG & Reranker Settings",
    "Tune how retrieved passages are scored, fused, and diversified.",
  );

  body.appendChild(subHeading(doc, "Cross-encoder Reranker"));
  const reranker = fieldRows(doc);
  reranker.append(
    selectField(
      doc,
      "Provider",
      () => (getPref("ragRerankerProvider") as string) || "none",
      (v) => setPref("ragRerankerProvider", v),
      [
        { value: "none", label: "None (local only)" },
        { value: "jina", label: "Jina Reranker v3" },
        { value: "cohere", label: "Cohere Rerank 4" },
      ],
    ),
    textField(
      doc,
      "API key",
      () => (getPref("ragRerankerApiKey") as string) || "",
      (v) => setPref("ragRerankerApiKey", v),
      { password: true, placeholder: "Required for Jina or Cohere" },
    ),
    textField(
      doc,
      "Model",
      () => (getPref("ragRerankerModel") as string) || "",
      (v) => setPref("ragRerankerModel", v),
      { placeholder: "jina-reranker-v3 (auto)" },
    ),
    numberField(
      doc,
      "Top N (candidates sent to reranker)",
      () => (getPref("ragRerankerTopN") as number) || 10,
      (v) => setPref("ragRerankerTopN", v),
      { min: 1, max: 100 },
    ),
  );
  body.appendChild(reranker);

  body.appendChild(subHeading(doc, "Hybrid Rank Fusion (RRF)"));
  const rrf = fieldRows(doc);
  rrf.appendChild(
    numberField(
      doc,
      "RRF Alpha — dense weight 0–100 (higher favors semantic)",
      () => (getPref("ragRrfAlpha") as number) || 55,
      (v) => setPref("ragRrfAlpha", v),
      { min: 1, max: 99 },
    ),
  );
  body.appendChild(rrf);

  body.appendChild(subHeading(doc, "Diversity Selection (MMR)"));
  const mmr = fieldRows(doc);
  mmr.append(
    checkboxField(
      doc,
      "Enable MMR diversity",
      () => getPref("ragMmrEnabled") !== false,
      (v) => setPref("ragMmrEnabled", v),
    ),
    numberField(
      doc,
      "MMR Lambda — relevance vs diversity 0–100 (higher = relevance)",
      () => (getPref("ragMmrLambda") as number) || 70,
      (v) => setPref("ragMmrLambda", v),
      { min: 1, max: 99 },
    ),
  );
  body.appendChild(mmr);
}

// ---------------------------------------------------------------------------
// Advanced Retrieval
// ---------------------------------------------------------------------------

export function renderAdvancedRetrievalSettings(
  doc: Document,
  container: HTMLElement,
): void {
  const body = sectionShell(
    doc,
    container,
    "Advanced Retrieval",
    "Optional retrieval strategies applied at index and query time.",
  );
  const fields = fieldRows(doc);
  fields.append(
    checkboxField(
      doc,
      "Contextual Retrieval — generate chunk context via LLM at index time",
      () => !!getPref("ragContextualRetrieval"),
      (v) => setPref("ragContextualRetrieval", v),
    ),
    checkboxField(
      doc,
      "Sentence-Window Retrieval — embed child chunks, retrieve parent windows",
      () => !!getPref("ragSentenceWindow"),
      (v) => setPref("ragSentenceWindow", v),
    ),
    numberField(
      doc,
      "Window size — sentences before/after",
      () => (getPref("ragSentenceWindowSize") as number) || 3,
      (v) => setPref("ragSentenceWindowSize", v),
      { min: 1, max: 10 },
    ),
    checkboxField(
      doc,
      "Multi-Query — generate variant queries for broader retrieval",
      () => !!getPref("ragMultiQueryExpansion"),
      (v) => setPref("ragMultiQueryExpansion", v),
    ),
    checkboxField(
      doc,
      "Query Decomposition — split complex queries into sub-queries",
      () => !!getPref("ragQueryDecomposition"),
      (v) => setPref("ragQueryDecomposition", v),
    ),
    numberField(
      doc,
      "Citation graph hops — follow citation links (0 = disabled)",
      () => (getPref("ragCitationGraphHops") as number) || 0,
      (v) => setPref("ragCitationGraphHops", v),
      { min: 0, max: 3 },
    ),
    checkboxField(
      doc,
      "Corrective RAG — evaluate + rewrite + re-retrieve on insufficient context",
      () => !!getPref("ragCorrectiveEnabled"),
      (v) => setPref("ragCorrectiveEnabled", v),
    ),
  );
  body.appendChild(fields);
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

export function renderEvaluationSettings(
  doc: Document,
  container: HTMLElement,
): void {
  const body = sectionShell(
    doc,
    container,
    "Evaluation",
    "Measure retrieval quality against a ground-truth dataset.",
  );
  const fields = fieldRows(doc);
  fields.append(
    checkboxField(
      doc,
      "Enable RAG evaluation (requires ground truth data)",
      () => !!getPref("ragEvalEnabled"),
      (v) => setPref("ragEvalEnabled", v),
    ),
    textField(
      doc,
      "Ground truth path",
      () => (getPref("ragEvalGroundTruth") as string) || "",
      (v) => setPref("ragEvalGroundTruth", v),
      { placeholder: "evaluation/ground_truth.json" },
    ),
    textField(
      doc,
      "Embedding model",
      () => (getPref("ragEvalEmbeddingModel") as string) || "",
      (v) => setPref("ragEvalEmbeddingModel", v),
      { placeholder: "text-embedding-3-small" },
    ),
  );
  body.appendChild(fields);

  const actions = el(doc, "div", "seerai-inline-actions");
  actions.appendChild(
    button(
      doc,
      "Clear RAG Vector Cache",
      "danger",
      async () => {
        try {
          const { getVectorStore } = await import("../rag/vectorStore");
          await getVectorStore().clearAll();
          Zotero.debug("[seerai] RAG: vector cache cleared");
          doc.defaultView?.alert("RAG vector cache cleared.");
        } catch (e) {
          Zotero.debug(`[seerai] RAG: cache clear failed: ${e}`);
        }
      },
      "trash",
    ),
  );
  body.appendChild(actions);
}
