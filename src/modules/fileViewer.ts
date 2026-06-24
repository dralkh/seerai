/**
 * File Viewer utilities - renders SVG, HTML, markdown, images, and text
 * within the workspace editor's Preview mode.
 *
 * Used by the workspace editor to toggle between Edit (textarea) and
 * Preview (sandboxed render) views for previewable file types.
 */

import { parseMarkdown } from "./chat/markdown";
import { getPref, setPref } from "../utils/prefs";

const HTML_NS = "http://www.w3.org/1999/xhtml";

const PREVIEW_PREFS_KEY = "previewExtensions";

const RENDERABLE_EXTENSIONS: Record<string, boolean> = {
  svg: true,
  html: true,
  htm: true,
  png: true,
  jpg: true,
  jpeg: true,
  gif: true,
  webp: true,
  bmp: true,
  txt: true,
  css: true,
  xml: true,
  md: true,
  markdown: true,
  csv: true,
  tex: true,
  latex: true,
  bib: true,
};

const SVG_MIME = "image/svg+xml";
const HTML_MIME = "text/html";

/**
 * Check if a file extension is renderable in preview mode
 */
export function isRenderableExtension(ext: string): boolean {
  return RENDERABLE_EXTENSIONS[ext.toLowerCase()] === true;
}

/**
 * Determine the render type for a file based on extension
 */
export function getRenderType(
  ext: string,
): "image" | "html" | "text" | "svg" | "markdown" | "csv" | "latex" {
  const e = ext.toLowerCase();
  if (e === "svg") return "svg";
  if (e === "html" || e === "htm") return "html";
  if (e === "md" || e === "markdown") return "markdown";
  if (e === "csv") return "csv";
  if (e === "tex" || e === "latex") return "latex";
  if (
    e === "png" ||
    e === "jpg" ||
    e === "jpeg" ||
    e === "gif" ||
    e === "webp" ||
    e === "bmp"
  )
    return "image";
  return "text";
}

/**
 * Simple preprocessor to translate LaTeX commands into Markdown equivalents for rendering.
 */
export function preprocessLatex(tex: string): string {
  let content = tex;

  // 1. Remove preamble (from \documentclass to \begin{document})
  const beginDocIdx = content.indexOf("\\begin{document}");
  if (beginDocIdx !== -1) {
    content = content.substring(beginDocIdx + "\\begin{document}".length);
  }
  // Remove \end{document}
  content = content.replace(/\\end\{document\}/g, "");

  // 2. Convert headers
  content = content.replace(/\\section\*?\{([^}]+)\}/g, "\n### $1\n");
  content = content.replace(/\\subsection\*?\{([^}]+)\}/g, "\n#### $1\n");
  content = content.replace(/\\subsubsection\*?\{([^}]+)\}/g, "\n##### $1\n");

  // 3. Convert basic text formatting
  content = content.replace(/\\textbf\{([^}]+)\}/g, "**$1**");
  content = content.replace(/\\textit\{([^}]+)\}/g, "*$1*");
  content = content.replace(/\\texttt\{([^}]+)\}/g, "`$1`");

  // 4. Convert block math environments to $$ ... $$
  content = content.replace(
    /\\begin\{equation\*?\}([\s\S]+?)\\end\{equation\*?\}/g,
    "\n$$$$\n$1\n$$$$\n",
  );
  content = content.replace(
    /\\begin\{align\*?\}([\s\S]+?)\\end\{align\*?\}/g,
    "\n$$$$\n$1\n$$$$\n",
  );
  content = content.replace(
    /\\begin\{gather\*?\}([\s\S]+?)\\end\{gather\*?\}/g,
    "\n$$$$\n$1\n$$$$\n",
  );

  // 5. Ignore common preamble/metadata commands if they appear in document body
  content = content.replace(/\\maketitle/g, "");
  content = content.replace(/\\tableofcontents/g, "");
  content = content.replace(/\\bibliography\{[^}]+\}/g, "");
  content = content.replace(/\\bibliographystyle\{[^}]+\}/g, "");

  return content.trim();
}

/**
 * Create a sandboxed preview element for the given content and type.
 */
export function createPreviewElement(
  doc: Document,
  content: string,
  renderType: "svg" | "html" | "text" | "image" | "markdown" | "csv" | "latex",
): HTMLElement {
  if (renderType === "svg") {
    return createSandboxedIframe(doc, content, SVG_MIME);
  }
  if (renderType === "html") {
    return createSandboxedIframe(doc, content, HTML_MIME);
  }
  if (renderType === "csv") {
    return createCsvTable(doc, content);
  }
  if (renderType === "markdown" || renderType === "latex") {
    const preprocessed =
      renderType === "latex" ? preprocessLatex(content) : content;
    const html = parseMarkdown(preprocessed);
    const container = doc.createElementNS(HTML_NS, "div") as HTMLElement;
    container.innerHTML = html;
    Object.assign(container.style, {
      padding: "12px",
      fontSize: "14px",
      lineHeight: "1.6",
      color: "var(--text-primary)",
      maxWidth: "100%",
      overflow: "auto",
      boxSizing: "border-box",
    });
    // Inject theme-aware styles for markdown elements
    const style = doc.createElementNS(HTML_NS, "style") as HTMLElement;
    style.textContent = `
      h1, h2, h3, h4, h5, h6 { color: var(--text-primary); margin: 0.5em 0; }
      h1 { font-size: 1.5em; }
      h2 { font-size: 1.3em; }
      h3 { font-size: 1.15em; }
      p { margin: 0.5em 0; color: var(--text-primary); }
      a { color: var(--highlight-primary, #0066cc); }
      code { background: var(--fill-quaternary, rgba(0,0,0,0.06)); padding: 1px 4px; border-radius: 3px; font-size: 0.9em; color: var(--text-primary); }
      pre { background: var(--fill-quaternary, rgba(0,0,0,0.06)); padding: 8px; border-radius: 4px; overflow-x: auto; }
      pre code { background: none; padding: 0; color: inherit; }
      blockquote { border-left: 3px solid var(--border-secondary); margin: 0.5em 0; padding: 4px 12px; color: var(--text-secondary); }
      table { border-collapse: collapse; width: 100%; margin: 0.5em 0; }
      th, td { border: 1px solid var(--border-secondary); padding: 6px 10px; text-align: left; }
      th { background: var(--fill-quaternary, rgba(0,0,0,0.04)); font-weight: 600; }
      ul, ol { padding-left: 1.5em; margin: 0.5em 0; }
      li { margin: 0.25em 0; }
      hr { border: none; border-top: 1px solid var(--border-secondary); margin: 1em 0; }
      img { max-width: 100%; }
    `;
    container.insertBefore(style, container.firstChild);
    return container;
  }
  if (renderType === "image") {
    // For images, content should be a data: URL or blob: URL
    const img = doc.createElementNS(HTML_NS, "img") as HTMLImageElement;
    img.src = content;
    Object.assign(img.style, {
      maxWidth: "100%",
      height: "auto",
      objectFit: "contain",
      display: "block",
      borderRadius: "6px",
    });
    return img;
  }
  // text
  const pre = doc.createElementNS(HTML_NS, "pre") as HTMLElement;
  pre.textContent = content;
  Object.assign(pre.style, {
    fontFamily: "monospace",
    fontSize: "12px",
    padding: "12px",
    whiteSpace: "pre-wrap",
    wordWrap: "break-word",
    overflowX: "auto",
    color: "var(--text-primary)",
    background: "var(--background-primary)",
    border: "none",
    margin: "0",
  });
  return pre;
}

/**
 * Check if a Zotero attachment is of a previewable type.
 */
export function isAttachmentPreviewable(att: Zotero.Item): boolean {
  if (!att.isAttachment()) return false;
  const mime = att.attachmentContentType || "";
  if (mime === SVG_MIME || mime === HTML_MIME) return true;
  if (mime.startsWith("image/")) return true;
  if (mime === "text/plain" || mime === "text/css") return true;
  if (mime === "application/xml" || mime === "text/xml") return true;
  const path = att.attachmentPath || "";
  const ext = path.split(".").pop()?.toLowerCase() || "";
  return RENDERABLE_EXTENSIONS[ext] === true;
}

/**
 * Read file content from a Zotero attachment for preview rendering.
 */
export async function readAttachmentContent(
  att: Zotero.Item,
): Promise<{ content: string; blobUrl?: string; isBinary: boolean } | null> {
  try {
    const mime = att.attachmentContentType || "";
    const path = await att.getFilePathAsync();
    if (!path) return null;

    const ext =
      (att.attachmentPath || "").split(".").pop()?.toLowerCase() || "";
    const renderType = getRenderType(ext);

    if (renderType === "image" || renderType === "svg") {
      const data = await Zotero.File.getBinaryContentsAsync(path);
      if (!data) return null;
      const blob = new Blob([data], {
        type: mime || "application/octet-stream",
      });
      const blobUrl = URL.createObjectURL(blob);

      if (renderType === "svg") {
        const decoder = new TextDecoder();
        const text = decoder.decode(data);
        return { content: text, blobUrl, isBinary: false };
      }
      return { content: "", blobUrl, isBinary: true };
    }

    const raw = await Zotero.File.getContentsAsync(path);
    const content = typeof raw === "string" ? raw : String(raw || "");
    return { content, isBinary: false };
  } catch (e) {
    Zotero.debug(`[seerai] FileViewer: error reading attachment: ${e}`);
    return null;
  }
}

/**
 * Get a human-readable label for an attachment
 */
export function getAttachmentLabel(att: Zotero.Item): string {
  const path = att.attachmentPath || "";
  const filename = path.split(/[/\\]/).pop() || "attachment";
  const mime = att.attachmentContentType || "";
  const mimeLabel =
    mime === SVG_MIME
      ? "SVG"
      : mime === HTML_MIME
        ? "HTML"
        : mime === "text/plain"
          ? "Text"
          : mime === "text/css"
            ? "CSS"
            : mime === "application/xml" || mime === "text/xml"
              ? "XML"
              : mime.startsWith("image/")
                ? "Image"
                : "File";
  return `${filename} (${mimeLabel})`;
}

/**
 * Create a sandboxed iframe for SVG or HTML content
 */
function createSandboxedIframe(
  doc: Document,
  content: string,
  mimeType: string,
): HTMLElement {
  const wrapper = doc.createElementNS(HTML_NS, "div") as HTMLElement;
  wrapper.style.cssText = `
    display: flex;
    flex-direction: column;
    flex: 1 1 0;
    min-height: 200px;
    width: 100%;
    overflow: hidden;
    border-radius: 6px;
  `;

  const iframe = doc.createElementNS(HTML_NS, "iframe") as HTMLIFrameElement;

  iframe.setAttribute("sandbox", "allow-scripts");

  Object.assign(iframe.style, {
    width: "100%",
    height: "100%",
    border: "none",
    background: "transparent",
    flex: "1 1 0",
  });

  const baseCSS = `
    html, body { height: 100%; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color-scheme: light dark; }
    pre { margin: 0; overflow: auto; }
    img { max-width: 100%; height: auto; }
  `;

  if (mimeType === SVG_MIME || mimeType === HTML_MIME) {
    iframe.srcdoc =
      content.includes("<style>") || content.includes("<html")
        ? content
        : `<html><head><style>${baseCSS}</style></head><body>${content}</body></html>`;
  } else {
    const escaped = escapeHtml(content);
    iframe.srcdoc = `<!DOCTYPE html><html><head><style>${baseCSS}</style></head><body><pre style="
      font-family: monospace; font-size: 12px; padding: 12px;
      white-space: pre-wrap; word-wrap: break-word;
    ">${escaped}</pre></body></html>`;
  }

  wrapper.appendChild(iframe);
  return wrapper;
}

/**
 * Parse CSV text and return an HTML table element.
 * Handles quoted fields with embedded commas and newlines.
 */
function createCsvTable(doc: Document, csv: string): HTMLElement {
  const rows: string[][] = [];
  let currentRow: string[] = [];
  let currentField = "";
  let inQuotes = false;

  for (let i = 0; i < csv.length; i++) {
    const ch = csv[i];
    if (inQuotes) {
      if (ch === '"') {
        if (csv[i + 1] === '"') {
          currentField += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        currentField += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ",") {
        currentRow.push(currentField.trim());
        currentField = "";
      } else if (ch === "\r") {
        // ignore, let \n handle it
      } else if (ch === "\n") {
        currentRow.push(currentField.trim());
        currentField = "";
        if (currentRow.length > 0 || currentRow.some((c) => c)) {
          rows.push(currentRow);
        }
        currentRow = [];
      } else {
        currentField += ch;
      }
    }
  }
  // last field/row
  currentRow.push(currentField.trim());
  if (currentRow.length > 0 || currentRow.some((c) => c)) {
    rows.push(currentRow);
  }

  if (rows.length === 0) {
    const empty = doc.createElementNS(HTML_NS, "div") as HTMLElement;
    empty.textContent = "(empty CSV)";
    empty.style.cssText =
      "padding: 16px; color: var(--text-tertiary); font-style: italic;";
    return empty;
  }

  const table = doc.createElementNS(HTML_NS, "table") as HTMLElement;
  table.style.cssText = `
    border-collapse: collapse;
    width: 100%;
    table-layout: fixed;
    font-size: 12px;
    font-family: "SF Mono", "Menlo", "Consolas", monospace;
  `;

  const baseCellStyle =
    "border: 1px solid var(--border-secondary); padding: 4px 8px; " +
    "color: var(--text-primary); word-break: break-word; overflow-wrap: break-word;";
  const headerStyle =
    baseCellStyle +
    "background: var(--fill-quaternary, rgba(0,0,0,0.04)); font-weight: 600;";

  for (let ri = 0; ri < rows.length; ri++) {
    const tr = doc.createElementNS(HTML_NS, "tr") as HTMLElement;
    const maxCols = Math.max(...rows.map((r) => r.length));
    for (let ci = 0; ci < rows[ri].length; ci++) {
      const el = doc.createElementNS(
        HTML_NS,
        ri === 0 ? "th" : "td",
      ) as HTMLElement;
      el.textContent = rows[ri][ci];
      el.style.cssText = ri === 0 ? headerStyle : baseCellStyle;
      tr.appendChild(el);
    }
    // fill missing cells
    for (let ci = rows[ri].length; ci < maxCols; ci++) {
      const el = doc.createElementNS(
        HTML_NS,
        ri === 0 ? "th" : "td",
      ) as HTMLElement;
      el.style.cssText = ri === 0 ? headerStyle : baseCellStyle;
      tr.appendChild(el);
    }
    table.appendChild(tr);
  }

  const wrapper = doc.createElementNS(HTML_NS, "div") as HTMLElement;
  wrapper.style.cssText =
    "overflow: auto; padding: 8px; max-width: 100%; box-sizing: border-box;";
  wrapper.appendChild(table);
  return wrapper;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/**
 * Save a preview mode preference for a given file extension.
 */
export function setPreviewPreference(
  extension: string,
  preferPreview: boolean,
): void {
  const ext = extension.toLowerCase();
  const stored: Record<string, boolean> = JSON.parse(
    getPref(PREVIEW_PREFS_KEY) || "{}",
  );
  if (preferPreview) {
    stored[ext] = true;
  } else {
    delete stored[ext];
  }
  setPref(PREVIEW_PREFS_KEY, JSON.stringify(stored));
}

export function getPreviewPreference(extension: string): boolean {
  const ext = extension.toLowerCase();
  const stored: Record<string, boolean> = JSON.parse(
    getPref(PREVIEW_PREFS_KEY) || "{}",
  );
  return stored[ext] === true;
}

export function clearPreviewPreferences(): void {
  setPref(PREVIEW_PREFS_KEY, JSON.stringify({}));
}
