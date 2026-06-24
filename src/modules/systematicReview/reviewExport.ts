import { config } from "../../../package.json";
import { GapAnalysisRun, SynthesisRun, SystematicReviewState } from "./types";

export type ReviewContextKind = "evidence_synthesis" | "gap_analysis";

// Cap injected run content so a large review cannot dominate the chat prompt.
const DEFAULT_REVIEW_CONTEXT_CAP = 12000;

export function capReviewContext(
  text: string,
  cap = DEFAULT_REVIEW_CONTEXT_CAP,
): string {
  if (text.length <= cap) return text;
  return `${text.slice(0, cap)}\n\n…(truncated; open the review to see the full run)`;
}

/**
 * Resolve a scoped review context item (a specific synthesis or gap run pinned
 * to chat) to its full structured Markdown, size-capped. Returns null when the
 * referenced run no longer exists so the caller can fall back to the broad
 * review summary.
 */
export function buildScopedReviewContext(
  state: SystematicReviewState,
  kind: ReviewContextKind,
  ids: { synthesisRunId?: string; gapAnalysisRunId?: string },
  projectName: string,
  cap = DEFAULT_REVIEW_CONTEXT_CAP,
): string | null {
  if (kind === "evidence_synthesis") {
    const run = (state.synthesisRuns || []).find(
      (candidate) => candidate.id === ids.synthesisRunId,
    );
    if (!run) return null;
    return capReviewContext(buildSynthesisMarkdown(run, projectName), cap);
  }
  const run = (state.gapAnalysisRuns || []).find(
    (candidate) => candidate.id === ids.gapAnalysisRunId,
  );
  if (!run) return null;
  return capReviewContext(buildGapMarkdown(run, projectName), cap);
}

// Pure builders for systematic-review exports. These take a run object and
// return a string only — no DOM, no Zotero — so they can be unit tested and
// reused both for file export and for chat-context injection.

function csvEscape(value: unknown): string {
  return `"${String(value ?? "").replace(/"/g, '""')}"`;
}

function mdCell(value: unknown): string {
  return String(value ?? "")
    .replace(/\|/g, "\\|")
    .replace(/\r?\n/g, " ");
}

export function buildGapCsv(run: GapAnalysisRun): string {
  const header = [
    "id",
    "title",
    "severity",
    "reasonCode",
    "status",
    "tags",
    "studies",
    "description",
    "implication",
  ];
  const lines = run.gaps.map((gap) =>
    [
      gap.id,
      gap.title,
      gap.severity,
      gap.reasonCode,
      gap.status,
      (gap.dimensionTags || []).join("; "),
      (gap.paperIds || []).length,
      gap.description,
      gap.implication,
    ]
      .map(csvEscape)
      .join(","),
  );
  return [header.join(","), ...lines].join("\n");
}

export function buildGapMarkdown(
  run: GapAnalysisRun,
  projectName: string,
): string {
  const lines: string[] = [];
  lines.push(`# Evidence Gap Analysis — ${projectName}`);
  lines.push("");
  lines.push(`- Run: ${run.id}`);
  lines.push(`- Generated: ${run.updatedAt || run.createdAt}`);
  lines.push(`- Status: ${run.status}`);
  lines.push(`- Source synthesis: ${run.synthesisRunId}`);
  lines.push("");
  if (run.warnings?.length) {
    lines.push("## Warnings");
    run.warnings.forEach((warning) => lines.push(`- ${warning}`));
    lines.push("");
  }
  lines.push(`## Gaps (${run.gaps.length})`);
  lines.push("");
  if (!run.gaps.length) {
    lines.push("_No gaps detected._");
    lines.push("");
  }
  run.gaps.forEach((gap, index) => {
    lines.push(`### ${index + 1}. ${gap.title}`);
    lines.push("");
    lines.push(`- **Severity:** ${gap.severity}`);
    lines.push(`- **Reason:** ${gap.reasonCode}`);
    lines.push(`- **Status:** ${gap.status}`);
    if (gap.dimensionTags?.length) {
      lines.push(`- **Tags:** ${gap.dimensionTags.join(", ")}`);
    }
    lines.push(`- **Studies:** ${(gap.paperIds || []).length}`);
    lines.push("");
    if (gap.description) {
      lines.push(gap.description);
      lines.push("");
    }
    if (gap.implication) {
      lines.push(`_Implication:_ ${gap.implication}`);
      lines.push("");
    }
  });
  if (run.cells?.length) {
    lines.push("## Evidence Map");
    lines.push("");
    lines.push("| Dimension | Outcome | Status | Studies |");
    lines.push("| --- | --- | --- | --- |");
    run.cells.forEach((cell) => {
      lines.push(
        `| ${mdCell(cell.rowValue)} | ${mdCell(cell.columnValue)} | ${cell.status} | ${cell.studyCount} |`,
      );
    });
    lines.push("");
  }
  return lines.join("\n");
}

export function buildSynthesisMarkdown(
  run: SynthesisRun,
  projectName: string,
): string {
  const lines: string[] = [];
  lines.push(`# Evidence Synthesis — ${projectName}`);
  lines.push("");
  lines.push(`- Run: ${run.id}`);
  lines.push(`- Generated: ${run.updatedAt || run.createdAt}`);
  lines.push(`- Status: ${run.status}`);
  lines.push(`- Included papers: ${run.includedPaperIds.length}`);
  if (run.model) lines.push(`- Model: ${run.model}`);
  lines.push("");
  if (run.staleReasons?.length) {
    lines.push(`> Stale: ${run.staleReasons.join("; ")}`);
    lines.push("");
  }
  if (run.warnings?.length) {
    lines.push("## Warnings");
    run.warnings.forEach((warning) => lines.push(`- ${warning}`));
    lines.push("");
  }
  lines.push(`## Domains (${run.domains.length})`);
  lines.push("");
  if (!run.domains.length) {
    lines.push("_No synthesis domains._");
    lines.push("");
  }
  run.domains.forEach((domain, index) => {
    lines.push(`### ${index + 1}. ${domain.outcome}`);
    lines.push("");
    lines.push(`- **Method:** ${domain.method}`);
    lines.push(`- **Status:** ${domain.status}`);
    lines.push(`- **Direction:** ${domain.direction}`);
    lines.push(`- **Certainty (GRADE):** ${domain.grade?.certainty ?? "n/a"}`);
    lines.push(`- **Studies:** ${domain.paperIds.length}`);
    lines.push("");
    if (domain.summary) {
      lines.push(domain.summary);
      lines.push("");
    }
    if (domain.nonPoolableReasons?.length) {
      domain.nonPoolableReasons.forEach((reason) => lines.push(`- ${reason}`));
      lines.push("");
    }
  });
  return lines.join("\n");
}

export function safeFileSlug(name: string): string {
  return (
    (name || "review")
      .replace(/[^a-z0-9-_]+/gi, "_")
      .replace(/_+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 60) || "review"
  );
}

/**
 * Save export content directly under SeerAI's data directory and return the
 * absolute path. Avoids the Zotero file-picker parent-window issue
 * (NS_ERROR_XPC_BAD_CONVERT_JS) that broke the old nsIFilePicker export.
 */
export async function saveReviewExport(
  baseName: string,
  extension: "md" | "csv",
  content: string,
): Promise<string> {
  const dir = PathUtils.join(
    Zotero.DataDirectory.dir,
    config.addonRef,
    "exports",
    "systematic-review",
  );
  if (!(await IOUtils.exists(dir))) {
    await IOUtils.makeDirectory(dir, {
      ignoreExisting: true,
      createAncestors: true,
    });
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const path = PathUtils.join(
    dir,
    `${safeFileSlug(baseName)}_${stamp}.${extension}`,
  );
  await IOUtils.writeUTF8(path, content);
  return path;
}
