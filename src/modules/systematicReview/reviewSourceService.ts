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
      "[End of source]",
      text.slice(-segment),
    ].join("\n\n"),
    truncated: true,
  };
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
        let text = await withSourceTimeout(
          Promise.resolve((attachment as any).attachmentText),
          60000,
          "PDF text reading timed out",
          signal,
        );
        if (!text) {
          await withSourceTimeout(
            Promise.resolve((Zotero.FullText as any).indexItems([id])),
            90000,
            "PDF indexing timed out",
            signal,
          );
          text = await Promise.resolve((attachment as any).attachmentText);
        }
        if (text?.trim()) {
          kind = "pdf";
          attachmentId = id;
          raw = `[Indexed PDF]\n${text.trim()}`;
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
