/**
 * Diff computation for workspace file versioning
 * Implements Myers diff algorithm for line-by-line comparison
 */

import { DiffHunk, DiffLine, DiffResult } from "./types";

interface LCSItem {
  oldIndex: number;
  newIndex: number;
}

/**
 * Compute the Longest Common Subsequence (LCS) of two arrays of strings
 * at the element level (lines), using the standard DP algorithm.
 */
function computeLCS(oldLines: string[], newLines: string[]): LCSItem[] {
  const m = oldLines.length;
  const n = newLines.length;

  // DP table
  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    new Array(n + 1).fill(0),
  );

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  // Backtrack to find the LCS
  const lcs: LCSItem[] = [];
  let i = m;
  let j = n;

  while (i > 0 && j > 0) {
    if (oldLines[i - 1] === newLines[j - 1]) {
      lcs.unshift({ oldIndex: i - 1, newIndex: j - 1 });
      i--;
      j--;
    } else if (dp[i - 1][j] > dp[i][j - 1]) {
      i--;
    } else {
      j--;
    }
  }

  return lcs;
}

/**
 * Generate unified diff hunks from two versions of a file.
 * Uses context lines around changes (default 3).
 */
export function computeDiff(
  oldContent: string,
  newContent: string,
  contextLines: number = 3,
): DiffHunk[] {
  const oldLines = oldContent.split("\n");
  const newLines = newContent.split("\n");
  const lcs = computeLCS(oldLines, newLines);

  // Build change operations
  interface Op {
    type: " " | "+" | "-";
    content: string;
    oldLine?: number;
    newLine?: number;
  }

  const ops: Op[] = [];
  let oldPtr = 0;
  let newPtr = 0;

  for (const item of lcs) {
    // Deletions (lines in old but not in LCS match)
    while (oldPtr < item.oldIndex) {
      ops.push({
        type: "-",
        content: oldLines[oldPtr],
        oldLine: oldPtr + 1,
      });
      oldPtr++;
    }
    // Additions (lines in new but not in LCS match)
    while (newPtr < item.newIndex) {
      ops.push({
        type: "+",
        content: newLines[newPtr],
        newLine: newPtr + 1,
      });
      newPtr++;
    }
    // Common line
    ops.push({
      type: " ",
      content: oldLines[oldPtr],
      oldLine: oldPtr + 1,
      newLine: newPtr + 1,
    });
    oldPtr++;
    newPtr++;
  }

  // Remaining deletions
  while (oldPtr < oldLines.length) {
    ops.push({
      type: "-",
      content: oldLines[oldPtr],
      oldLine: oldPtr + 1,
    });
    oldPtr++;
  }
  // Remaining additions
  while (newPtr < newLines.length) {
    ops.push({
      type: "+",
      content: newLines[newPtr],
      newLine: newPtr + 1,
    });
    newPtr++;
  }

  // Group operations into hunks with context
  const hunks: DiffHunk[] = [];
  const changeIndices: number[] = [];

  for (let i = 0; i < ops.length; i++) {
    if (ops[i].type !== " ") {
      changeIndices.push(i);
    }
  }

  if (changeIndices.length === 0) return [];

  // Find contiguous ranges of changes
  const ranges: { start: number; end: number }[] = [];
  let rangeStart = changeIndices[0];

  for (let i = 1; i <= changeIndices.length; i++) {
    if (
      i < changeIndices.length &&
      changeIndices[i] <= changeIndices[i - 1] + 2 * contextLines + 1
    ) {
      continue;
    }
    const endIdx =
      i < changeIndices.length
        ? changeIndices[i - 1]
        : changeIndices[changeIndices.length - 1];
    const start = Math.max(0, rangeStart - contextLines);
    const end = Math.min(ops.length - 1, endIdx + contextLines);
    ranges.push({ start, end });
    if (i < changeIndices.length) {
      rangeStart = changeIndices[i];
    }
  }

  // Build hunks
  for (const range of ranges) {
    const hunkLines: DiffLine[] = [];
    let oldStart = 0;
    let oldCount = 0;
    let newStart = 0;
    let newCount = 0;

    for (let i = range.start; i <= range.end; i++) {
      const op = ops[i];
      const oldLineNum = op.oldLine || 0;
      const newLineNum = op.newLine || 0;

      if (op.type !== "+") {
        if (oldStart === 0) oldStart = oldLineNum;
        oldCount++;
      }
      if (op.type !== "-") {
        if (newStart === 0) newStart = newLineNum;
        newCount++;
      }

      hunkLines.push({
        type: op.type,
        content: op.content || "",
        oldLineNumber: op.type !== "+" ? oldLineNum : 0,
        newLineNumber: op.type !== "-" ? newLineNum : 0,
      });
    }

    hunks.push({
      oldStart,
      oldLines: oldCount,
      newStart,
      newLines: newCount,
      lines: hunkLines,
    });
  }

  return hunks;
}

/**
 * Produce a full diff result for a file.
 */
export function createDiffResult(
  path: string,
  oldContent: string,
  newContent: string,
  oldVersionId?: string,
  newVersionId?: string,
): DiffResult {
  const hunks = computeDiff(oldContent, newContent);
  let additions = 0;
  let deletions = 0;

  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.type === "+") additions++;
      if (line.type === "-") deletions++;
    }
  }

  return {
    path,
    hunks,
    additions,
    deletions,
    oldContent,
    newContent,
    oldVersionId,
    newVersionId,
  };
}

/**
 * Format diffs for display (unified diff style).
 */
export function formatDiff(diff: DiffResult): string {
  const lines: string[] = [];
  lines.push(`--- a/${diff.path}\t${diff.oldVersionId || "original"}`);
  lines.push(`+++ b/${diff.path}\t${diff.newVersionId || "current"}`);

  for (const hunk of diff.hunks) {
    lines.push(
      `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
    );
    for (const line of hunk.lines) {
      lines.push(`${line.type}${line.content}`);
    }
  }

  lines.push("");
  lines.push(`${diff.additions} additions, ${diff.deletions} deletions`);

  return lines.join("\n");
}

/**
 * Format a single diff hunk for HTML display (with inline styling).
 */
export function formatHunkHTML(hunk: DiffHunk): string {
  const lines: string[] = [];
  lines.push(
    `<div class="diff-hunk-header">@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@</div>`,
  );

  for (const line of hunk.lines) {
    const cls =
      line.type === "+"
        ? "diff-addition"
        : line.type === "-"
          ? "diff-deletion"
          : "diff-context";
    const num =
      line.type === "+"
        ? `<span class="diff-line-num">${line.newLineNumber}</span>`
        : line.type === "-"
          ? `<span class="diff-line-num">${line.oldLineNumber}</span>`
          : `<span class="diff-line-num">${line.oldLineNumber}</span><span class="diff-line-num">${line.newLineNumber}</span>`;

    const escaped = escapeHTML(line.content);
    lines.push(
      `<div class="diff-line ${cls}">${num}<span class="diff-content">${line.type} ${escaped}</span></div>`,
    );
  }

  return lines.join("");
}

function escapeHTML(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
