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

/**
 * Chunk an entire paper's content from multiple sources.
 * Produces chunks from abstract, notes, and PDF text separately,
 * preserving source information for retrieval priority.
 *
 * @param itemId   Zotero item ID
 * @param content  Object with optional abstract, notes, pdfText, and metadata fields
 * @param options  Chunking parameters
 * @returns Array of all chunks from all sources
 */
export function chunkPaperContent(
  itemId: number,
  content: {
    abstract?: string;
    notes?: string[];
    pdfText?: string;
    title?: string;
    authors?: string[];
  },
  options?: ChunkOptions,
): DocumentChunk[] {
  const allChunks: DocumentChunk[] = [];
  const meta = { title: content.title, authors: content.authors };

  // Abstract: always a standalone chunk (high retrieval priority)
  if (content.abstract && content.abstract.trim()) {
    allChunks.push(
      ...chunkDocument(itemId, content.abstract, "abstract", meta, options),
    );
  }

  // Notes: chunk each note separately
  if (content.notes) {
    for (const note of content.notes) {
      if (note && note.trim()) {
        allChunks.push(...chunkDocument(itemId, note, "note", meta, options));
      }
    }
  }

  // PDF text: the bulk of the content
  if (content.pdfText && content.pdfText.trim()) {
    allChunks.push(
      ...chunkDocument(itemId, content.pdfText, "pdf", meta, options),
    );
  }

  // Re-index chunk IDs to be globally unique within the item
  let globalIndex = 0;
  for (const chunk of allChunks) {
    chunk.id = `${itemId}_${chunk.source}_${globalIndex}`;
    chunk.chunkIndex = globalIndex;
    globalIndex++;
  }

  return allChunks;
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
        const overlapChars = chunkOverlap * 4; // Approximate chars for overlap tokens
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
  const charsPerChunk = chunkSize * 4;
  const overlapChars = chunkOverlap * 4;
  const segments: TextSegment[] = [];

  let pos = 0;
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
    if (pos >= text.length - overlapChars) break; // Avoid tiny trailing chunks
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
