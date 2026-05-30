/**
 * Document text chunker for the RAG system.
 * Splits documents into semantically meaningful chunks for embedding.
 *
 * Uses a recursive splitting strategy:
 *   paragraph breaks → sentence boundaries → word boundaries
 *
 * Each chunk carries metadata for source attribution and deduplication.
 */

import { ChatStateManager } from "../stateManager";
import type { DocumentChunk, ChunkSource } from "./types";

/** Options for the chunking process */
export interface ChunkOptions {
  /** Target chunk size in tokens (default: 512) */
  chunkSize?: number;
  /** Overlap between consecutive chunks in tokens (default: 64) */
  chunkOverlap?: number;
  /** Enable sentence-window mode: small child chunks for search, parent windows for context (default: false) */
  sentenceWindow?: boolean;
  /** Number of sentences on each side of a child chunk to include in its parent window (default: 3) */
  windowSize?: number;
}

const DEFAULT_CHUNK_SIZE = 512;
const DEFAULT_CHUNK_OVERLAP = 64;

/**
 * Split a document's text content into chunks suitable for embedding.
 *
 * @param itemId    Zotero item ID
 * @param text      Full text content to chunk
 * @param source    Source type (pdf, note, abstract, metadata)
 * @param metadata  Optional metadata to attach to each chunk
 * @param options   Chunking parameters
 * @returns Array of DocumentChunk objects
 */
export function chunkDocument(
  itemId: number,
  text: string,
  source: ChunkSource,
  metadata?: { title?: string; authors?: string[]; section?: string },
  options?: ChunkOptions,
): DocumentChunk[] {
  if (!text || text.trim().length === 0) return [];

  const chunkSize = options?.chunkSize ?? DEFAULT_CHUNK_SIZE;
  const chunkOverlap = options?.chunkOverlap ?? DEFAULT_CHUNK_OVERLAP;

  // For very short texts (abstracts, metadata), return as a single chunk
  const tokenCount = ChatStateManager.countTokens(text);
  if (tokenCount <= chunkSize) {
    return [
      {
        id: `${itemId}_${source}_0`,
        itemId,
        text: text.trim(),
        source,
        chunkIndex: 0,
        metadata: {
          ...metadata,
          startOffset: 0,
          endOffset: text.length,
        },
      },
    ];
  }

  // Recursive split into segments
  const segments = recursiveSplit(text, chunkSize, chunkOverlap);

  return segments.map((segment, index) => ({
    id: `${itemId}_${source}_${index}`,
    itemId,
    text: segment.text,
    source,
    chunkIndex: index,
    metadata: {
      ...metadata,
      startOffset: segment.startOffset,
      endOffset: segment.endOffset,
    },
  }));
}

function splitSentences(text: string): string[] {
  try {
    const segmenter = new Intl.Segmenter("en", { granularity: "sentence" });
    const segments = segmenter.segment(text);
    return Array.from(segments, (s) => s.segment.trim()).filter(
      (s) => s.length > 0,
    );
  } catch {
    return text
      .split(/(?<=[.!?])\s+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }
}

function chunkWithSentenceWindows(
  itemId: number,
  fullText: string,
  meta: { title?: string; authors?: string[] },
  windowSize: number,
  citationTag: string | null,
): { chunks: DocumentChunk[]; parentWindows: Record<string, string> } {
  const sentences = splitSentences(fullText);
  if (sentences.length === 0) return { chunks: [], parentWindows: {} };

  const chunks: DocumentChunk[] = [];
  const parentWindows: Record<string, string> = {};

  let childIndex = 0;
  let i = 0;

  while (i < sentences.length) {
    const childText =
      sentences[i] + (sentences[i + 1] ? " " + sentences[i + 1] : "");

    const start = Math.max(0, i - windowSize);
    const end = Math.min(sentences.length, i + 2 + windowSize);
    const parentText = sentences.slice(start, end).join(" ");

    const chunkId = `${itemId}_pdf_${childIndex}`;
    const parentId = `${chunkId}_parent`;

    const chunk: DocumentChunk = {
      id: chunkId,
      itemId,
      text: citationTag ? `${citationTag} ${childText}` : childText,
      source: "pdf",
      chunkIndex: childIndex,
      metadata: {
        ...meta,
        startOffset: 0,
        endOffset: childText.length,
        parentChunkId: parentId,
        windowRange: [start, end],
      },
    };
    chunks.push(chunk);
    parentWindows[parentId] = parentText;

    childIndex++;
    i += 2;
  }

  return { chunks, parentWindows };
}

/**
 * Chunk an entire paper's content from multiple sources.
 * Produces chunks from abstract, notes, and PDF text separately,
 * preserving source information for retrieval priority.
 *
 * For PDF text, section headers are detected and attached to each
 * chunk's metadata so the LLM sees hierarchical context at retrieval time.
 *
 * @param itemId   Zotero item ID
 * @param content  Object with optional abstract, notes, pdfText, and metadata fields
 * @param options  Chunking parameters
 * @returns Chunks and optional parent windows (when sentenceWindow is enabled) */
export function chunkPaperContent(
  itemId: number,
  content: {
    abstract?: string;
    notes?: string[];
    pdfText?: string;
    title?: string;
    authors?: string[];
    date?: string;
  },
  options?: ChunkOptions,
): { chunks: DocumentChunk[]; parentWindows?: Record<string, string> } {
  const allChunks: DocumentChunk[] = [];
  let parentWindows: Record<string, string> | undefined;
  const meta = { title: content.title, authors: content.authors };

  const citationTag = buildCitationTag(content.authors, content.date);

  // Source-specific chunk sizes: abstracts shorter, notes smaller, PDF full size
  const baseSize = options?.chunkSize ?? DEFAULT_CHUNK_SIZE;
  const baseOverlap = options?.chunkOverlap ?? DEFAULT_CHUNK_OVERLAP;

  const abstractOpts: ChunkOptions = {
    chunkSize: Math.floor(baseSize * 0.75),
    chunkOverlap: Math.floor(baseOverlap * 0.5),
  };
  const noteOpts: ChunkOptions = {
    chunkSize: Math.floor(baseSize * 0.5),
    chunkOverlap: Math.floor(baseOverlap * 0.25),
  };

  // Abstract: always a standalone chunk (high retrieval priority)
  if (content.abstract && content.abstract.trim()) {
    const absChunks = chunkDocument(
      itemId,
      content.abstract,
      "abstract",
      meta,
      abstractOpts,
    );
    if (citationTag) {
      for (const chunk of absChunks) {
        chunk.text = `${citationTag} ${chunk.text}`;
      }
    }
    allChunks.push(...absChunks);
  }

  // Notes: chunk each note separately
  if (content.notes) {
    for (const note of content.notes) {
      if (note && note.trim()) {
        const noteChunks = chunkDocument(itemId, note, "note", meta, noteOpts);
        if (citationTag) {
          for (const chunk of noteChunks) {
            chunk.text = `${citationTag} ${chunk.text}`;
          }
        }
        allChunks.push(...noteChunks);
      }
    }
  }

  // PDF text: detect sections and chunk with hierarchical context
  if (content.pdfText && content.pdfText.trim()) {
    if (options?.sentenceWindow) {
      const result = chunkWithSentenceWindows(
        itemId,
        content.pdfText,
        meta,
        options.windowSize ?? 3,
        citationTag,
      );
      allChunks.push(...result.chunks);
      parentWindows = result.parentWindows;
    } else {
      allChunks.push(
        ...chunkPdfWithSections(
          itemId,
          content.pdfText,
          meta,
          options,
          citationTag,
        ),
      );
    }
  }

  // Re-index chunk IDs to be globally unique within the item
  let globalIndex = 0;
  for (const chunk of allChunks) {
    chunk.id = `${itemId}_${chunk.source}_${globalIndex}`;
    chunk.chunkIndex = globalIndex;
    globalIndex++;
  }

  return { chunks: allChunks, parentWindows };
}

/**
 * Chunk PDF text with section-aware context markers.
 * Detects section headers (Introduction, Methods, Results, numbered sections)
 * and attaches the containing section title to each chunk's metadata.
 * The section is prepended to the chunk text so embedding captures structural context.
 */
function chunkPdfWithSections(
  itemId: number,
  pdfText: string,
  meta: { title?: string; authors?: string[] },
  options?: ChunkOptions,
  citationTag?: string | null,
): DocumentChunk[] {
  const sections = detectPdfSections(pdfText);
  const allChunks: DocumentChunk[] = [];

  if (sections.length === 0) {
    // No sections detected — chunk entire PDF as one block
    const pdfChunks = chunkDocument(itemId, pdfText, "pdf", meta, options);
    if (citationTag) {
      for (const chunk of pdfChunks) {
        chunk.text = `${citationTag} ${chunk.text}`;
      }
    }
    return pdfChunks;
  }

  // Chunk each section separately, attaching section header to metadata
  for (const [sectionHeader, sectionText] of sections) {
    if (!sectionText.trim()) continue;

    const sectionMeta = {
      ...meta,
      section: sectionHeader,
    };

    const sectionChunks = chunkDocument(
      itemId,
      sectionText,
      "pdf",
      sectionMeta,
      options,
    );

    // Prepend section context and citation to each chunk's text so the embedding
    // captures both structural relationship and document attribution
    const prefix = citationTag
      ? `[${sectionHeader}] ${citationTag}\n`
      : `[${sectionHeader}]\n`;
    for (const chunk of sectionChunks) {
      chunk.text = `${prefix}${chunk.text}`;
    }

    allChunks.push(...sectionChunks);
  }

  // If no sections produced chunks (unlikely), fall back
  if (allChunks.length === 0) {
    const pdfChunks = chunkDocument(itemId, pdfText, "pdf", meta, options);
    if (citationTag) {
      for (const chunk of pdfChunks) {
        chunk.text = `${citationTag} ${chunk.text}`;
      }
    }
    return pdfChunks;
  }

  return allChunks;
}

/** Section header detected in PDF text */
interface DetectedSection {
  header: string;
  offset: number;
}

/**
 * Detect section boundaries in academic paper PDF text.
 *
 * Recognizes:
 * - Numbered sections: "1.", "2.1", "3.2.1", "1. Introduction", etc.
 * - Roman numeral sections: "I.", "II.", "IV."
 * - Named sections: "Introduction", "Abstract", "Methods", "Results",
 *   "Discussion", "Conclusion", "References", "Related Work", etc.
 * - ALL CAPS short lines (likely section titles)
 */
function detectPdfSections(text: string): Array<[string, string]> {
  const lines = text.split("\n");
  const sectionStarters: DetectedSection[] = [];

  const NUM = String.raw`(?:\d+\.)+\s*`;
  const ROMAN = String.raw`M{0,3}(?:CM|CD|D?C{0,3})(?:XC|XL|L?X{0,3})(?:IX|IV|V?I{0,3})\.\s+`;
  const NAMED = String.raw`(?:Introduction|Abstract|Methods?|Results?|Discussion|Conclusion|References?|Bibliography|Appendix|Acknowledgments?|Related\s+Work|Background|Overview|Summary|Future\s+Work|Limitations?|Experiments?|Evaluation|Findings)\b`;
  const RULE = String.raw`(?:---+|===+|___+)`;

  const patterns = [
    new RegExp(`^(${NUM}.+)$`, "i"),
    new RegExp(`^(${ROMAN}.+)$`, "i"),
    new RegExp(`^(${NAMED})$`, "i"),
    new RegExp(`^${RULE}\\s*(${NAMED})\\s*${RULE}$`, "i"),
  ];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.length < 2) continue;

    // Skip lines that look like body text (too long to be a header)
    if (line.length > 120) continue;

    for (const re of patterns) {
      const m = line.match(re);
      if (m) {
        sectionStarters.push({
          header: m[1].trim(),
          offset: text.indexOf(m[1], accumulatedOffset(lines, i)),
        });
        break;
      }
    }

    // ALL CAPS short lines are likely section titles
    if (
      sectionStarters.length === 0 ||
      sectionStarters[sectionStarters.length - 1].offset <
        accumulatedOffset(lines, i)
    ) {
      const alpha = line.replace(/[^A-Za-z ]/g, "");
      if (
        alpha.length > 3 &&
        alpha.length < 80 &&
        alpha === alpha.toUpperCase() &&
        alpha.split(" ").length >= 2
      ) {
        sectionStarters.push({
          header: line,
          offset: text.indexOf(line, accumulatedOffset(lines, i)),
        });
        continue;
      }
    }
  }

  // Sort by occurrence and deduplicate headers at same position
  sectionStarters.sort((a, b) => a.offset - b.offset);

  const deduped: DetectedSection[] = [];
  for (const s of sectionStarters) {
    const prev = deduped[deduped.length - 1];
    if (!prev || s.offset - prev.offset > 10) {
      deduped.push(s);
    }
  }

  // Deduplicate by header text (same header appearing multiple times, keep first)
  const seen = new Set<string>();
  const unique: DetectedSection[] = [];
  for (const s of deduped) {
    const key = s.header.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(s);
    }
  }

  if (unique.length < 2) return []; // Need at least 2 sections to be useful

  // Build section-to-text mapping
  const result: Array<[string, string]> = [];
  for (let i = 0; i < unique.length; i++) {
    const start = unique[i].offset;
    const end = i + 1 < unique.length ? unique[i + 1].offset : text.length;
    const sectionText = text.substring(start, end).trim();
    if (sectionText.length > 20) {
      result.push([unique[i].header, sectionText]);
    }
  }

  return result;
}

function accumulatedOffset(lines: string[], lineIdx: number): number {
  let offset = 0;
  for (let i = 0; i < lineIdx; i++) {
    offset += lines[i].length + 1; // +1 for \n
  }
  return offset;
}

// ─── Internal splitting logic ───────────────────────────────────────────────

interface TextSegment {
  text: string;
  startOffset: number;
  endOffset: number;
}

/**
 * Recursively split text into chunks that fit within the token budget.
 * Splitting hierarchy: paragraph breaks → sentence boundaries → word boundaries.
 */
function recursiveSplit(
  text: string,
  chunkSize: number,
  chunkOverlap: number,
): TextSegment[] {
  // Separators ordered by preference (try to split at the most semantic boundary first)
  const separators = [
    "\n\n", // Paragraph breaks
    "\n", // Line breaks
    ". ", // Sentence endings (period + space)
    "? ", // Question marks
    "! ", // Exclamation marks
    "; ", // Semicolons
    ", ", // Commas
    " ", // Word boundaries (last resort)
  ];

  return splitWithSeparators(text, 0, separators, chunkSize, chunkOverlap);
}

/**
 * Split text using the first separator that produces sub-chunk-size pieces.
 * Falls back to the next separator if pieces are still too large.
 */
function splitWithSeparators(
  text: string,
  baseOffset: number,
  separators: string[],
  chunkSize: number,
  chunkOverlap: number,
): TextSegment[] {
  if (!text.trim()) return [];

  const tokenCount = ChatStateManager.countTokens(text);
  if (tokenCount <= chunkSize) {
    return [
      {
        text: text.trim(),
        startOffset: baseOffset,
        endOffset: baseOffset + text.length,
      },
    ];
  }

  // Try each separator in order of preference
  for (const separator of separators) {
    const parts = text.split(separator);
    if (parts.length <= 1) continue; // Separator not found

    // Merge parts into chunks that respect the token budget
    const segments = mergePartsIntoChunks(
      parts,
      separator,
      baseOffset,
      chunkSize,
      chunkOverlap,
    );

    // Check if any segment is still too large — if so, try sub-splitting
    const result: TextSegment[] = [];
    for (const seg of segments) {
      const segTokens = ChatStateManager.countTokens(seg.text);
      if (segTokens > chunkSize * 1.5) {
        // This segment is still too large; recursively split with remaining separators
        const remainingSeparators = separators.slice(
          separators.indexOf(separator) + 1,
        );
        if (remainingSeparators.length > 0) {
          result.push(
            ...splitWithSeparators(
              seg.text,
              seg.startOffset,
              remainingSeparators,
              chunkSize,
              chunkOverlap,
            ),
          );
        } else {
          // No more separators — force split by character count
          result.push(
            ...forceSplit(seg.text, seg.startOffset, chunkSize, chunkOverlap),
          );
        }
      } else {
        result.push(seg);
      }
    }

    if (result.length > 0) return result;
  }

  // Fallback: force split by estimated character count
  return forceSplit(text, baseOffset, chunkSize, chunkOverlap);
}

/**
 * Merge an array of text parts (from splitting) into chunks
 * that fit within the token budget, with overlap.
 */
function mergePartsIntoChunks(
  parts: string[],
  separator: string,
  baseOffset: number,
  chunkSize: number,
  chunkOverlap: number,
): TextSegment[] {
  const segments: TextSegment[] = [];
  let currentText = "";
  let currentStart = baseOffset;
  let currentOffset = baseOffset;

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const candidate = currentText ? currentText + separator + part : part;
    const candidateTokens = ChatStateManager.countTokens(candidate);

    if (candidateTokens > chunkSize && currentText) {
      // Emit current chunk
      segments.push({
        text: currentText.trim(),
        startOffset: currentStart,
        endOffset: currentOffset,
      });

      // Start new chunk with overlap
      if (chunkOverlap > 0) {
        const currentTokens = ChatStateManager.countTokens(currentText);
        const charsPerToken =
          currentTokens > 0 ? currentText.length / currentTokens : 4;
        const overlapChars = Math.ceil(chunkOverlap * charsPerToken);
        const overlapStart = Math.max(0, currentText.length - overlapChars);
        const overlapText = currentText.substring(overlapStart);
        currentText = overlapText + separator + part;
        currentStart =
          currentOffset - (currentText.length - part.length - separator.length);
      } else {
        currentText = part;
        currentStart = currentOffset;
      }
    } else {
      currentText = candidate;
    }

    currentOffset +=
      part.length + (i < parts.length - 1 ? separator.length : 0);
  }

  // Emit remaining text
  if (currentText.trim()) {
    segments.push({
      text: currentText.trim(),
      startOffset: currentStart,
      endOffset: currentOffset,
    });
  }

  return segments;
}

/**
 * Force-split text by character count when no semantic boundary works.
 * Splits at approximately chunkSize * 4 characters (since ~4 chars/token).
 */
function forceSplit(
  text: string,
  baseOffset: number,
  chunkSize: number,
  chunkOverlap: number,
): TextSegment[] {
  const totalTokens = ChatStateManager.countTokens(text);
  const charsPerToken = totalTokens > 0 ? text.length / totalTokens : 4;
  const charsPerChunk = Math.ceil(chunkSize * charsPerToken);
  const overlapChars = Math.ceil(chunkOverlap * charsPerToken);
  const segments: TextSegment[] = [];

  let pos = 0;
  const minStep = Math.max(1, charsPerChunk - overlapChars);
  while (pos < text.length) {
    const end = Math.min(pos + charsPerChunk, text.length);
    const segmentText = text.substring(pos, end).trim();

    if (segmentText) {
      segments.push({
        text: segmentText,
        startOffset: baseOffset + pos,
        endOffset: baseOffset + end,
      });
    }

    pos = end - overlapChars;
    if (pos + minStep > text.length) break;
    if (pos <= 0) pos = minStep;
  }

  // If we exited early but still have remaining text
  if (pos < text.length) {
    const remaining = text.substring(pos).trim();
    if (remaining) {
      segments.push({
        text: remaining,
        startOffset: baseOffset + pos,
        endOffset: baseOffset + text.length,
      });
    }
  }

  return segments;
}

function buildCitationTag(authors?: string[], year?: string): string | null {
  if (!year && (!authors || authors.length === 0)) return null;

  const firstAuthor = authors?.[0]?.trim().split(/\s+/).pop() || "";
  const etAl = authors && authors.length > 1 ? " et al." : "";
  const authorPart = firstAuthor ? `${firstAuthor}${etAl}` : "";

  if (authorPart && year) return `(${authorPart}, ${year})`;
  if (year) return `(${year})`;
  if (authorPart) return `(${authorPart})`;
  return null;
}
