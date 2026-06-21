import { getPref, setPref } from "../../../utils/prefs";
import {
  ScholarlyProviderId,
  getProviderCapability,
  testScholarlyProviderConnection,
} from "../../search";

type WebProvider = "firecrawl" | "tavily" | "nanogpt" | "youdotcom";
type OcrMode = "local" | "cloud" | "mistral";

const POPOVER_CLASS = "seerai-service-settings-popover";

function section(doc: Document, title: string): HTMLDivElement {
  const element = doc.createElement("div");
  Object.assign(element.style, {
    display: "flex",
    flexDirection: "column",
    gap: "8px",
    paddingTop: "8px",
    borderTop: "1px solid var(--border-primary)",
  });
  const heading = doc.createElement("div");
  heading.textContent = title;
  Object.assign(heading.style, {
    fontSize: "11px",
    fontWeight: "600",
    color: "var(--text-secondary)",
  });
  element.appendChild(heading);
  return element;
}

function field(
  doc: Document,
  labelText: string,
  input: HTMLElement,
): HTMLLabelElement {
  const label = doc.createElement("label");
  Object.assign(label.style, {
    display: "flex",
    flexDirection: "column",
    gap: "3px",
    fontSize: "10px",
    color: "var(--text-secondary)",
  });
  const text = doc.createElement("span");
  text.textContent = labelText;
  label.append(text, input);
  return label;
}

function input(
  doc: Document,
  type: "text" | "password" | "number",
  value: string,
  onChange: (value: string) => void,
): HTMLInputElement {
  const element = doc.createElement("input");
  element.type = type;
  element.value = value;
  Object.assign(element.style, {
    width: "100%",
    boxSizing: "border-box",
    padding: "6px 8px",
    border: "1px solid var(--border-primary)",
    borderRadius: "4px",
    backgroundColor: "var(--background-secondary)",
    color: "var(--text-primary)",
    fontSize: "11px",
  });
  element.addEventListener("change", () => onChange(element.value.trim()));
  return element;
}

function select(
  doc: Document,
  value: string,
  options: Array<{ value: string; label: string }>,
  onChange: (value: string) => void,
): HTMLSelectElement {
  const element = doc.createElement("select");
  for (const optionValue of options) {
    const option = doc.createElement("option");
    option.value = optionValue.value;
    option.textContent = optionValue.label;
    element.appendChild(option);
  }
  element.value = value;
  Object.assign(element.style, {
    width: "100%",
    padding: "6px 8px",
    border: "1px solid var(--border-primary)",
    borderRadius: "4px",
    backgroundColor: "var(--background-secondary)",
    color: "var(--text-primary)",
    fontSize: "11px",
  });
  element.addEventListener("change", () => onChange(element.value));
  return element;
}

function checkbox(
  doc: Document,
  labelText: string,
  checked: boolean,
  onChange: (checked: boolean) => void,
): HTMLLabelElement {
  const label = doc.createElement("label");
  Object.assign(label.style, {
    display: "flex",
    alignItems: "center",
    gap: "6px",
    fontSize: "11px",
    color: "var(--text-primary)",
  });
  const element = doc.createElement("input");
  element.type = "checkbox";
  element.checked = checked;
  element.addEventListener("change", () => onChange(element.checked));
  label.append(element, doc.createTextNode(labelText));
  return label;
}

function showPopover(
  doc: Document,
  anchor: HTMLElement,
  id: string,
  title: string,
  content: HTMLElement,
): void {
  const open = doc.getElementById(id);
  if (open) {
    open.remove();
    return;
  }
  const existingPopovers = Array.from(
    doc.querySelectorAll(`.${POPOVER_CLASS}`),
  ) as Element[];
  existingPopovers.forEach((item) => item.remove());
  const popover = doc.createElement("div");
  popover.id = id;
  popover.className = POPOVER_CLASS;
  const rect = anchor.getBoundingClientRect();
  const width = 300;
  const left = Math.min(
    Math.max(8, rect.left),
    Math.max(8, (doc.defaultView?.innerWidth || 800) - width - 8),
  );
  const availableBelow = (doc.defaultView?.innerHeight || 600) - rect.bottom;
  Object.assign(popover.style, {
    position: "fixed",
    left: `${left}px`,
    top: availableBelow > 360 ? `${rect.bottom + 6}px` : "auto",
    bottom:
      availableBelow > 360
        ? "auto"
        : `${(doc.defaultView?.innerHeight || 600) - rect.top + 6}px`,
    width: `${width}px`,
    maxHeight: "420px",
    overflowY: "auto",
    padding: "12px",
    boxSizing: "border-box",
    border: "1px solid var(--border-primary)",
    borderRadius: "8px",
    backgroundColor: "var(--background-primary)",
    color: "var(--text-primary)",
    boxShadow: "0 6px 20px rgba(0,0,0,0.2)",
    zIndex: "200001",
  });
  const header = doc.createElement("div");
  header.textContent = title;
  Object.assign(header.style, {
    fontSize: "13px",
    fontWeight: "600",
    marginBottom: "10px",
  });
  popover.append(header, content);
  const mountPoint = doc.body || doc.documentElement;
  if (!mountPoint) return;
  mountPoint.appendChild(popover);
  const close = (event: MouseEvent) => {
    if (
      !popover.contains(event.target as Node) &&
      !anchor.contains(event.target as Node)
    ) {
      popover.remove();
      doc.removeEventListener("mousedown", close);
    }
  };
  setTimeout(() => doc.addEventListener("mousedown", close), 0);
}

function webProviderFields(doc: Document, provider: WebProvider): HTMLElement {
  const container = doc.createElement("div");
  Object.assign(container.style, {
    display: "flex",
    flexDirection: "column",
    gap: "8px",
  });
  if (provider === "firecrawl") {
    container.append(
      field(
        doc,
        "API key",
        input(doc, "password", getPref("firecrawlApiKey") || "", (value) =>
          setPref("firecrawlApiKey", value),
        ),
      ),
      field(
        doc,
        "API URL",
        input(doc, "text", getPref("firecrawlApiUrl") || "", (value) =>
          setPref("firecrawlApiUrl", value),
        ),
      ),
      field(
        doc,
        "Results per query",
        input(
          doc,
          "number",
          String(getPref("firecrawlSearchLimit") || 3),
          (value) =>
            setPref("firecrawlSearchLimit", Math.max(1, Number(value) || 3)),
        ),
      ),
      field(
        doc,
        "Maximum concurrent requests",
        input(
          doc,
          "number",
          String(getPref("firecrawlMaxConcurrent") || 3),
          (value) =>
            setPref("firecrawlMaxConcurrent", Math.max(1, Number(value) || 3)),
        ),
      ),
    );
  } else if (provider === "tavily") {
    container.append(
      field(
        doc,
        "API key",
        input(doc, "password", getPref("tavilyApiKey") || "", (value) =>
          setPref("tavilyApiKey", value),
        ),
      ),
      field(
        doc,
        "Results per query",
        input(
          doc,
          "number",
          String(getPref("tavilySearchLimit") || 5),
          (value) =>
            setPref("tavilySearchLimit", Math.max(1, Number(value) || 5)),
        ),
      ),
      field(
        doc,
        "Search depth",
        select(
          doc,
          getPref("tavilySearchDepth") || "basic",
          [
            { value: "basic", label: "Basic" },
            { value: "advanced", label: "Advanced" },
          ],
          (value) => setPref("tavilySearchDepth", value),
        ),
      ),
    );
  } else if (provider === "nanogpt") {
    container.append(
      field(
        doc,
        "API key",
        input(doc, "password", getPref("nanogptWebApiKey") || "", (value) =>
          setPref("nanogptWebApiKey", value),
        ),
      ),
      field(
        doc,
        "Results per query",
        input(
          doc,
          "number",
          String(getPref("nanogptWebSearchLimit") || 5),
          (value) =>
            setPref("nanogptWebSearchLimit", Math.max(1, Number(value) || 5)),
        ),
      ),
      field(
        doc,
        "Search depth",
        select(
          doc,
          getPref("nanogptWebSearchDepth") || "standard",
          [
            { value: "standard", label: "Standard" },
            { value: "deep", label: "Deep" },
          ],
          (value) => setPref("nanogptWebSearchDepth", value),
        ),
      ),
    );
  } else {
    container.append(
      field(
        doc,
        "API key",
        input(doc, "password", getPref("youdotcomApiKey") || "", (value) =>
          setPref("youdotcomApiKey", value),
        ),
      ),
      field(
        doc,
        "Results per query",
        input(
          doc,
          "number",
          String(getPref("youdotcomSearchLimit") || 5),
          (value) =>
            setPref("youdotcomSearchLimit", Math.max(1, Number(value) || 5)),
        ),
      ),
      field(
        doc,
        "Search mode",
        select(
          doc,
          getPref("youdotcomSearchMode") || "normal",
          [
            { value: "normal", label: "Normal" },
            { value: "research", label: "Research" },
          ],
          (value) => setPref("youdotcomSearchMode", value),
        ),
      ),
    );
  }
  return container;
}

export function showWebSearchQuickSettings(
  doc: Document,
  anchor: HTMLElement,
  enabled: boolean,
  onEnabledChange: (enabled: boolean) => void,
): void {
  const content = doc.createElement("div");
  Object.assign(content.style, {
    display: "flex",
    flexDirection: "column",
    gap: "10px",
  });
  content.appendChild(
    checkbox(doc, "Enable web search for this chat", enabled, onEnabledChange),
  );
  let provider = (getPref("webSearchProvider") || "firecrawl") as WebProvider;
  const fields = doc.createElement("div");
  const renderFields = () =>
    fields.replaceChildren(webProviderFields(doc, provider));
  content.append(
    field(
      doc,
      "Search provider",
      select(
        doc,
        provider,
        [
          { value: "firecrawl", label: "Firecrawl" },
          { value: "tavily", label: "Tavily" },
          { value: "nanogpt", label: "NanoGPT" },
          { value: "youdotcom", label: "You.com" },
        ],
        (value) => {
          provider = value as WebProvider;
          setPref("webSearchProvider", value);
          renderFields();
        },
      ),
    ),
    fields,
  );
  renderFields();
  showPopover(doc, anchor, "web-search-quick-settings", "Web Search", content);
}

export function showSemanticScholarQuickSettings(
  doc: Document,
  anchor: HTMLElement,
): void {
  const content = doc.createElement("div");
  let selected = (getPref("scholarlySearchProvider") ||
    "semantic-scholar") as ScholarlyProviderId;
  const providerOptions: ScholarlyProviderId[] = [
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
  const status = doc.createElement("div");
  content.append(
    field(
      doc,
      "Source to test",
      select(
        doc,
        selected,
        providerOptions.map((id) => ({
          value: id,
          label: getProviderCapability(id).label,
        })),
        (value) => {
          selected = value as ScholarlyProviderId;
          setPref("scholarlySearchProvider", value);
        },
      ),
    ),
    field(
      doc,
      "Semantic Scholar API key (optional)",
      input(doc, "password", getPref("semanticScholarApiKey") || "", (value) =>
        setPref("semanticScholarApiKey", value),
      ),
    ),
    field(
      doc,
      "NCBI API key (optional)",
      input(doc, "password", getPref("ncbiApiKey") || "", (value) =>
        setPref("ncbiApiKey", value),
      ),
    ),
    field(
      doc,
      "CORE API key (optional)",
      input(doc, "password", getPref("coreApiKey") || "", (value) =>
        setPref("coreApiKey", value),
      ),
    ),
    field(
      doc,
      "BASE API key / registered access",
      input(doc, "password", getPref("baseApiKey") || "", (value) =>
        setPref("baseApiKey", value),
      ),
    ),
  );
  const testButton = doc.createElement("button");
  testButton.textContent = "Test selected source";
  testButton.addEventListener("click", async () => {
    testButton.disabled = true;
    status.textContent = "Testing…";
    const result = await testScholarlyProviderConnection(selected);
    status.textContent = result.ok
      ? `Connected in ${result.latencyMs} ms`
      : result.error || result.readiness.message;
    testButton.disabled = false;
  });
  content.append(testButton, status);
  const help = doc.createElement("div");
  help.textContent =
    "Public sources work anonymously where supported. BASE requires registered access; IACR is experimental.";
  Object.assign(help.style, {
    marginTop: "8px",
    fontSize: "10px",
    color: "var(--text-tertiary)",
  });
  content.appendChild(help);
  showPopover(
    doc,
    anchor,
    "scholarly-search-quick-settings",
    "Scholarly Search",
    content,
  );
}

export function createOcrSettingsSection(doc: Document): HTMLElement {
  const container = section(doc, "OCR Service");
  let mode = (getPref("datalabMode") || "cloud") as OcrMode;
  const fields = doc.createElement("div");
  Object.assign(fields.style, {
    display: "flex",
    flexDirection: "column",
    gap: "8px",
  });
  const render = () => {
    const controls: HTMLElement[] = [];
    if (mode === "local") {
      controls.push(
        field(
          doc,
          "Marker server URL",
          input(doc, "text", getPref("datalabUrl") || "", (value) =>
            setPref("datalabUrl", value),
          ),
        ),
        checkbox(doc, "Force OCR", !!getPref("localForceOcr"), (value) =>
          setPref("localForceOcr", value),
        ),
      );
    } else if (mode === "cloud") {
      controls.push(
        field(
          doc,
          "DataLab API key",
          input(doc, "password", getPref("datalabApiKey") || "", (value) =>
            setPref("datalabApiKey", value),
          ),
        ),
        checkbox(doc, "Force OCR", !!getPref("cloudForceOcr"), (value) =>
          setPref("cloudForceOcr", value),
        ),
        checkbox(
          doc,
          "Use LLM-enhanced extraction",
          !!getPref("cloudUseLlm"),
          (value) => setPref("cloudUseLlm", value),
        ),
      );
    } else {
      controls.push(
        field(
          doc,
          "Mistral API key",
          input(doc, "password", getPref("mistralApiKey") || "", (value) =>
            setPref("mistralApiKey", value),
          ),
        ),
      );
    }
    controls.push(
      field(
        doc,
        "Maximum concurrent OCR jobs",
        input(
          doc,
          "number",
          String(getPref("datalabMaxConcurrent") || 5),
          (value) =>
            setPref("datalabMaxConcurrent", Math.max(1, Number(value) || 5)),
        ),
      ),
    );
    fields.replaceChildren(...controls);
  };
  container.append(
    field(
      doc,
      "Provider",
      select(
        doc,
        mode,
        [
          { value: "local", label: "Local Marker Server" },
          { value: "cloud", label: "Cloud (DataLab.to)" },
          { value: "mistral", label: "Mistral OCR" },
        ],
        (value) => {
          mode = value as OcrMode;
          setPref("datalabMode", value);
          setPref("datalabUseLocal", value === "local");
          render();
        },
      ),
    ),
    fields,
  );
  render();
  return container;
}

export function showOcrQuickSettings(doc: Document, anchor: HTMLElement): void {
  showPopover(
    doc,
    anchor,
    "ocr-quick-settings",
    "OCR Configuration",
    createOcrSettingsSection(doc),
  );
}
