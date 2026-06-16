import { ReviewCancellationSignal } from "./cancellation";

export interface ReviewSourceSummary {
  kind: "pdf" | "same_title_note" | "notes" | "abstract";
  attachmentId?: number;
  noteIds: number[];
  totalCharacters: number;
  suppliedCharacters: number;
  truncated: boolean;
  fingerprint: string;
  warnings: string[];
}

export interface ReviewSourceDocument {
  text: string;
  summary: ReviewSourceSummary;
}

function withSourceTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  message: string,
  signal?: ReviewCancellationSignal,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = () =>
      finish(() => reject(new Error("Request was cancelled")));
    const timer = setTimeout(
      () => finish(() => reject(new Error(message))),
      timeoutMs,
    );
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort);
    operation.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
  });
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function plainText(value: string): string {
  return value
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function stableHash(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

export function selectReviewSourceText(
  text: string,
  maxLength = 120000,
): { text: string; truncated: boolean } {
  if (text.length <= maxLength) return { text, truncated: false };
  const segment = Math.floor(maxLength / 3);
  const middleStart = Math.max(0, Math.floor(text.length / 2 - segment / 2));
  return {
    text: [
      text.slice(0, segment),
      "[Middle of source]",
      text.slice(middleStart, middleStart + segment),
      text.slice(-segment),
    ].join("\n\n"),
    truncated: true,
  };
}

const ABSTRACT_HEADING_PATTERN =
  /^(?:#{1,6}\s+|.*<\s*h[1-6][^>]*>|\s*)(abstract|summary|overview|synopsis)(?:\s*[:\-—]?\s*|\s*<\s*\/\s*h[1-6]\s*>)/im;

const ABSTRACT_STOP_PATTERN =
  /^(?:#{1,6}\s+|\s*<\s*h[1-6][^>]*>)(?!abstract|summary|overview|synopsis)/im;

const ABSTRACT_HEADING_LOOSE_PATTERN =
  /\b(abstract|summary|overview|synopsis)\b\s*[:\-—.]?\s*/i;

const ABSTRACT_HEADING_LINE_PATTERN =
  /^[ \t]*(abstract|summary|overview|synopsis)\b\s*[:\-—.]?[ \t]*$/im;

const SECTION_STOP_WORDS = [
  "keywords",
  "key words",
  "key-word",
  "key-words",
  "index terms",
  "introduction",
  "background",
  "objective",
  "objectives",
  "aim",
  "aims",
  "purpose",
  "methods",
  "method",
  "methodology",
  "materials and methods",
  "method and materials",
  "experimental section",
  "experimental",
  "experiment",
  "study design",
  "results",
  "result",
  "findings",
  "discussion",
  "conclusion",
  "conclusions",
  "concluding remarks",
  "summary and conclusions",
  "highlights",
  "key highlights",
  "article highlights",
  "main findings",
  "graphical abstract",
  "references",
  "bibliography",
  "acknowledgments",
  "acknowledgements",
  "author contributions",
  "funding",
  "competing interests",
  "conflict of interest",
  "abbreviations",
  "supplementary",
  "supplementary material",
  "appendix",
  "author information",
  "author details",
  "table of contents",
  "contents",
];

const SECTION_STOP_LINE_PATTERN = new RegExp(
  `^[ \t]*(?:\\d+(?:\\.\\d+)?[.\\s]|${SECTION_STOP_WORDS.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\b`,
  "im",
);

const NUMBERED_SECTION_PATTERN = /^[ \t]*\d+(?:\.\d+)?[ \t]+[A-Z]/;

const ABSTRACT_MAX_LENGTH = 2000;

const PDF_SCAN_CHARS = 6000;

const MIN_ABSTRACT_WORDS = 60;
const MAX_ABSTRACT_WORDS = 800;

function trimToWordBoundary(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  const slice = text.slice(0, maxLen);
  const lastSpace = slice.lastIndexOf(" ");
  if (lastSpace > maxLen * 0.6) {
    return slice.slice(0, lastSpace).trim() + "…";
  }
  return slice.trim() + "…";
}

function isLikelyHeaderLine(line: string): boolean {
  if (!line) return true;
  if (line.length > 200) return false;
  if (/[.@]/.test(line) && !/@/.test(line.split(" ")[0] || "")) {
    return false;
  }
  if (
    /\b(University|Institute|Department|College|School|Laboratory)\b/i.test(
      line,
    )
  ) {
    return true;
  }
  if (/[a-z]/.test(line) && /[A-Z]/.test(line) && !line.endsWith(".")) {
    const capWords = line.split(/\s+/).filter((w) => /^[A-Z]/.test(w)).length;
    const totalWords = line.split(/\s+/).filter((w) => w.length > 0).length;
    if (totalWords > 0 && capWords / totalWords > 0.5 && line.length < 150) {
      return true;
    }
  }
  if (
    /(^|\s)([A-Z]\.\s*){2,}[A-Z]/.test(line) ||
    /\d{4}/.test(line) ||
    /[∗†‡§¶]/.test(line)
  ) {
    return true;
  }
  if (/@/.test(line) || /https?:\/\//.test(line) || /www\./.test(line)) {
    return true;
  }
  if (/^\d+[\s,]\d+/.test(line) || /[A-Z][a-z]+,\s*[A-Z]/.test(line)) {
    return true;
  }
  if (!line.includes(".") && line.length < 120) {
    return true;
  }
  return false;
}

function isSectionHeadingLine(line: string): boolean {
  if (!line) return false;
  const trimmed = line.trim();
  if (!trimmed) return false;
  if (trimmed.length > 120) return false;
  if (trimmed.endsWith(".")) return false;
  if (SECTION_STOP_LINE_PATTERN.test(trimmed)) return true;
  if (NUMBERED_SECTION_PATTERN.test(trimmed)) return true;
  if (/^[IVX]+\.\s+[A-Z]/.test(trimmed)) return true;
  return false;
}

function countWords(text: string): number {
  return text.split(/\s+/).filter((w) => w.length > 0).length;
}

function findAbstractByHeading(text: string): string {
  const re = new RegExp(ABSTRACT_HEADING_LINE_PATTERN.source, "gim");
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const start = m.index + m[0].length;
    const rest = text.slice(start);
    const lines = rest
      .split(/\n+/)
      .map((l) => l.trim())
      .filter(Boolean);
    const collected: string[] = [];
    for (const line of lines) {
      if (isSectionHeadingLine(line)) break;
      if (!line) break;
      collected.push(line);
      const combined = collected.join(" ").replace(/\s+/g, " ").trim();
      if (countWords(combined) >= MIN_ABSTRACT_WORDS && line.endsWith(".")) {
        break;
      }
      if (countWords(combined) >= MAX_ABSTRACT_WORDS) break;
    }
    const combined = collected.join(" ").replace(/\s+/g, " ").trim();
    if (countWords(combined) >= MIN_ABSTRACT_WORDS) {
      return trimToWordBoundary(combined, ABSTRACT_MAX_LENGTH);
    }
  }
  return "";
}

function findAbstractByFirstParagraph(text: string): string {
  const lines = text
    .split(/\n+/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length === 0) return "";

  let startIdx = 0;
  for (let i = 0; i < Math.min(lines.length, 12); i++) {
    const l = lines[i];
    if (isLikelyHeaderLine(l)) {
      startIdx = i + 1;
      continue;
    }
    if (
      /^\d+\./.test(l) ||
      /^[IVX]+\./.test(l) ||
      SECTION_STOP_LINE_PATTERN.test(l) ||
      NUMBERED_SECTION_PATTERN.test(l)
    ) {
      startIdx = i;
    }
    break;
  }
  startIdx = Math.min(startIdx, lines.length);

  const collected: string[] = [];
  for (let i = startIdx; i < lines.length; i++) {
    const line = lines[i];
    if (isSectionHeadingLine(line)) break;
    if (!line) {
      if (countWords(collected.join(" ")) >= MIN_ABSTRACT_WORDS) break;
      continue;
    }
    collected.push(line);
    const combined = collected.join(" ").replace(/\s+/g, " ").trim();
    const words = countWords(combined);
    if (words >= MAX_ABSTRACT_WORDS) break;
    if (words >= MIN_ABSTRACT_WORDS && line.endsWith(".")) break;
  }

  const combined = collected.join(" ").replace(/\s+/g, " ").trim();
  if (countWords(combined) < MIN_ABSTRACT_WORDS) return "";
  return trimToWordBoundary(combined, ABSTRACT_MAX_LENGTH);
}

export function extractAbstractFromPdfText(pdfText: string): {
  text: string;
  matched: boolean;
  fallback: boolean;
} {
  if (!pdfText || !pdfText.trim()) {
    return { text: "", matched: false, fallback: false };
  }
  const normalized = pdfText.replace(/\r\n?/g, "\n").replace(/[ \t]+/g, " ");
  const scanned = normalized.slice(0, PDF_SCAN_CHARS);

  const headingResult = findAbstractByHeading(scanned);
  if (headingResult) {
    return { text: headingResult, matched: true, fallback: false };
  }

  const paragraphResult = findAbstractByFirstParagraph(scanned);
  if (paragraphResult) {
    return { text: paragraphResult, matched: false, fallback: true };
  }

  return { text: "", matched: false, fallback: false };
}

export function extractAbstractSection(noteText: string): {
  text: string;
  matched: boolean;
} {
  if (!noteText) return { text: "", matched: false };

  const headingMatch = noteText.match(ABSTRACT_HEADING_PATTERN);
  if (headingMatch && headingMatch.index !== undefined) {
    const startIndex = headingMatch.index + headingMatch[0].length;
    const remainder = noteText.slice(startIndex);
    const stopMatch = remainder.match(ABSTRACT_STOP_PATTERN);
    const endIndex =
      stopMatch && stopMatch.index !== undefined
        ? stopMatch.index
        : remainder.length;
    const section = remainder.slice(0, endIndex).trim();
    if (section.length >= 20) {
      return {
        text: trimToWordBoundary(section, ABSTRACT_MAX_LENGTH),
        matched: true,
      };
    }
  }

  const lineMatchIdx = noteText.search(ABSTRACT_HEADING_LINE_PATTERN);
  if (lineMatchIdx !== -1) {
    const before = noteText.slice(0, lineMatchIdx);
    const after = noteText.slice(lineMatchIdx);
    const m = after.match(ABSTRACT_HEADING_LINE_PATTERN);
    if (m) {
      const startIndex = lineMatchIdx + m[0].length;
      const remainder = noteText.slice(startIndex);
      const stopMatch = remainder.match(ABSTRACT_STOP_PATTERN);
      const endIndex =
        stopMatch && stopMatch.index !== undefined
          ? stopMatch.index
          : remainder.length;
      const section = remainder.slice(0, endIndex).trim();
      if (section.length >= 40) {
        const cleaned = section.replace(/\s+/g, " ").trim();
        return {
          text: trimToWordBoundary(cleaned, ABSTRACT_MAX_LENGTH),
          matched: true,
        };
      }
    }
  }

  const loose = noteText.match(ABSTRACT_HEADING_LOOSE_PATTERN);
  if (loose && loose.index !== undefined) {
    const startIndex = loose.index + loose[0].length;
    const remainder = noteText.slice(startIndex);
    const stopMatch = remainder.match(ABSTRACT_STOP_PATTERN);
    const endIndex =
      stopMatch && stopMatch.index !== undefined
        ? stopMatch.index
        : remainder.length;
    let section = remainder.slice(0, endIndex).trim();
    if (section.length >= 60) {
      section = section.replace(/\s+/g, " ").trim();
      return {
        text: trimToWordBoundary(section, ABSTRACT_MAX_LENGTH),
        matched: true,
      };
    }
  }

  return { text: "", matched: false };
}

async function readPdfWithFallback(
  attachment: Zotero.Item,
  signal?: ReviewCancellationSignal,
): Promise<string> {
  const indexed = await withSourceTimeout(
    Promise.resolve((attachment as any).attachmentText),
    60000,
    "PDF text reading timed out",
    signal,
  );
  if (indexed?.trim()) return indexed;
  try {
    await withSourceTimeout(
      Promise.resolve((Zotero.FullText as any).indexItems([attachment.id])),
      90000,
      "PDF indexing timed out",
      signal,
    );
    const reindexed = await Promise.resolve((attachment as any).attachmentText);
    if (reindexed?.trim()) return reindexed;
  } catch {
    // ignore
  }
  try {
    const pdfWorker = (Zotero as any).PDFWorker as any;
    if (pdfWorker?._query && pdfWorker._enqueue) {
      const filePath =
        (attachment as any).getFilePath?.() ||
        (attachment as any).attachmentPath;
      if (filePath) {
        const buf = await IOUtils.read(filePath);
        const buffer = buf.buffer.slice(
          buf.byteOffset,
          buf.byteOffset + buf.byteLength,
        );
        const result = await pdfWorker._enqueue(() =>
          pdfWorker._query("getFulltext", { buf: buffer, maxPages: 0 }, [
            buffer,
          ]),
        );
        if (result?.text?.trim()) return result.text;
      }
    }
  } catch {
    // ignore
  }
  try {
    const ocrModule = (Zotero as any).SeerAI?.getOcrService?.();
    if (ocrModule?.getFirstPdfAttachment && ocrModule.convertToMarkdown) {
      const parent = (Zotero.Items.get((attachment as any).parentItemID) ||
        (attachment as any).parentItem) as Zotero.Item | undefined;
      if (parent) {
        const pdf = ocrModule.getFirstPdfAttachment(parent);
        if (pdf) {
          const ocrText = await ocrModule.convertToMarkdown(pdf, {
            showProgress: false,
          });
          if (ocrText?.trim()) return ocrText;
        }
      }
    }
  } catch {
    // ignore
  }
  return "";
}

export async function getReviewSourceDocument(
  item: Zotero.Item,
  signal?: ReviewCancellationSignal,
  preference:
    | "auto"
    | "pdf"
    | "same_title_note"
    | "notes"
    | "abstract" = "auto",
): Promise<ReviewSourceDocument> {
  const title = normalize((item.getField("title") as string) || "");
  const abstract = ((item.getField("abstractNote") as string) || "").trim();
  const notes = item
    .getNotes()
    .map((noteId) => Zotero.Items.get(noteId))
    .filter(Boolean)
    .map((note) => ({
      id: note!.id,
      title: normalize(note!.getNoteTitle() || ""),
      text: plainText(note!.getNote()),
    }))
    .filter((note) => note.text.length > 0);
  const sameTitleNotes = notes.filter(
    (note) =>
      note.text.length >= 2000 &&
      note.title &&
      title &&
      (note.title.includes(title.slice(0, 40)) ||
        title.includes(note.title.slice(0, 40))),
  );
  const warnings: string[] = [];
  let raw = "";
  let kind: ReviewSourceSummary["kind"] = "abstract";
  let attachmentId: number | undefined;
  let selectedNoteIds: number[] = [];

  if (preference === "abstract" && abstract) {
    kind = "abstract";
    raw = `[Abstract]\n${abstract}`;
  } else if (
    (preference === "auto" || preference === "same_title_note") &&
    sameTitleNotes.length
  ) {
    kind = "same_title_note";
    selectedNoteIds = sameTitleNotes.map((note) => note.id);
    raw = sameTitleNotes
      .map((note) => `[Full-text note: ${note.title}]\n${note.text}`)
      .join("\n\n");
  } else if (preference === "auto" || preference === "pdf") {
    for (const id of item.getAttachments()) {
      const attachment = Zotero.Items.get(id);
      if (
        !attachment ||
        attachment.attachmentContentType !== "application/pdf"
      ) {
        continue;
      }
      try {
        const text = await readPdfWithFallback(attachment, signal);
        if (text?.trim()) {
          kind = "pdf";
          attachmentId = id;
          raw = `[PDF text]\n${text.trim()}`;
          break;
        }
      } catch (error) {
        warnings.push(
          `Attachment ${id}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  if (
    !raw &&
    notes.length &&
    (preference === "auto" ||
      preference === "notes" ||
      preference === "same_title_note")
  ) {
    kind = "notes";
    selectedNoteIds = notes.map((note) => note.id);
    raw = notes
      .map((note) => `[Reviewer note: ${note.title || note.id}]\n${note.text}`)
      .join("\n\n");
    warnings.push("No usable PDF or full-text note was found; using notes");
  }
  if (!raw && notes.length) {
    for (const note of notes) {
      const section = extractAbstractSection(note.text);
      if (section.matched) {
        kind = "notes";
        selectedNoteIds = [note.id];
        raw = `[Abstract from note: ${note.title || note.id}]\n${section.text}`;
        warnings.push(
          "No abstract field was found; extracted abstract section from a reviewer note",
        );
        break;
      }
    }
  }
  if (!raw && abstract) {
    kind = "abstract";
    raw = `[Abstract]\n${abstract}`;
    warnings.push("No usable full text was found; using abstract only");
  }
  if (!raw) {
    throw new Error(
      "No abstract, note, indexed PDF, or OCR content is available",
    );
  }
  const combined =
    abstract && kind !== "abstract" ? `[Abstract]\n${abstract}\n\n${raw}` : raw;
  const selected = selectReviewSourceText(combined);
  return {
    text: selected.text,
    summary: {
      kind,
      attachmentId,
      noteIds: selectedNoteIds,
      totalCharacters: combined.length,
      suppliedCharacters: selected.text.length,
      truncated: selected.truncated,
      fingerprint: stableHash(
        `${item.id}|${kind}|${attachmentId || ""}|${selectedNoteIds.join(",")}|${combined}`,
      ),
      warnings,
    },
  };
}

export interface ItemAbstractResolution {
  text: string;
  kind: "field" | "same_title_note" | "notes" | "pdf" | "none";
  noteIds: number[];
  attachmentId?: number;
  fallback?: boolean;
}

export interface FindSameTitleNoteAbstractResult {
  text: string;
  noteIds: number[];
  matched: boolean;
  noteTextLength: number;
}

export function findSameTitleNoteAbstract(
  item: Zotero.Item,
): FindSameTitleNoteAbstractResult {
  const empty: FindSameTitleNoteAbstractResult = {
    text: "",
    noteIds: [],
    matched: false,
    noteTextLength: 0,
  };
  if (!item) return empty;
  const title = normalize((item.getField("title") as string) || "");
  if (!title) return empty;
  const noteIds = item.getNotes();
  if (!noteIds.length) return empty;
  for (const noteId of noteIds) {
    const note = Zotero.Items.get(noteId);
    if (!note) continue;
    const noteTitle = normalize(note.getNoteTitle() || "");
    const isSameTitle =
      noteTitle &&
      (noteTitle.includes(title.slice(0, 40)) ||
        title.includes(noteTitle.slice(0, 40)));
    if (!isSameTitle) continue;
    const plain = plainText(note.getNote() || "");
    if (!plain) continue;
    const section = extractAbstractSection(plain);
    if (section.matched) {
      return {
        text: section.text,
        noteIds: [note.id],
        matched: true,
        noteTextLength: plain.length,
      };
    }
    if (plain.length >= 2000) {
      const trimmed = plain.length > 1500 ? plain.slice(0, 1500) : plain;
      return {
        text: trimmed,
        noteIds: [note.id],
        matched: true,
        noteTextLength: plain.length,
      };
    }
  }
  return empty;
}

export async function resolveItemAbstract(
  item: Zotero.Item,
  signal?: ReviewCancellationSignal,
): Promise<ItemAbstractResolution> {
  if (!item) {
    return { text: "", kind: "none", noteIds: [] };
  }
  const abstract = ((item.getField("abstractNote") as string) || "").trim();
  if (abstract) {
    return { text: abstract, kind: "field", noteIds: [] };
  }
  const noteHit = findSameTitleNoteAbstract(item);
  if (noteHit.matched) {
    return {
      text: noteHit.text,
      kind: "same_title_note",
      noteIds: noteHit.noteIds,
    };
  }
  for (const id of item.getAttachments()) {
    const attachment = Zotero.Items.get(id);
    if (!attachment || attachment.attachmentContentType !== "application/pdf") {
      continue;
    }
    if (signal?.aborted) {
      return { text: "", kind: "none", noteIds: [] };
    }
    try {
      const text = await readPdfWithFallback(attachment, signal);
      if (signal?.aborted) {
        return { text: "", kind: "none", noteIds: [] };
      }
      if (text?.trim()) {
        const cleaned = text.trim();
        const section = extractAbstractFromPdfText(cleaned);
        if (section.text) {
          return {
            text: section.text,
            kind: "pdf",
            noteIds: [],
            attachmentId: id,
            fallback: section.fallback,
          };
        }
      }
    } catch {
      // ignore attachment error and continue
    }
  }
  return { text: "", kind: "none", noteIds: [] };
}
