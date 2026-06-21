import { fetchScholarlyPapersForExport } from "./service";
import { BulkExportProgress } from "./service";
import { createAbortController } from "./env";
import {
  FederatedSearchResult,
  ScholarlyPaper,
  ScholarlySearchQuery,
} from "./types";

export type ExportJobStatus =
  | "idle"
  | "running"
  | "completed"
  | "cancelled"
  | "partial"
  | "failed";

export interface ScholarlyExportJob {
  status: ExportJobStatus;
  target: number;
  startedAt?: number;
  finishedAt?: number;
  papers: ScholarlyPaper[];
  progress?: BulkExportProgress;
  error?: string;
}

type ExportListener = (job: ScholarlyExportJob) => void;

export class ScholarlyExportManager {
  private controller?: AbortController;
  private job: ScholarlyExportJob = { status: "idle", target: 0, papers: [] };
  private readonly listeners = new Set<ExportListener>();

  subscribe(listener: ExportListener): () => void {
    this.listeners.add(listener);
    listener(this.job);
    return () => this.listeners.delete(listener);
  }

  getJob(): ScholarlyExportJob {
    return this.job;
  }

  cancel(): void {
    this.controller?.abort();
  }

  async start(
    query: ScholarlySearchQuery,
    target: number,
    loaded: ScholarlyPaper[],
    session?: FederatedSearchResult,
  ): Promise<ScholarlyExportJob> {
    this.controller?.abort();
    this.controller = createAbortController();
    this.update({
      status: "running",
      target,
      startedAt: Date.now(),
      papers: loaded,
    });
    try {
      const papers = await fetchScholarlyPapersForExport(
        query,
        target,
        loaded,
        this.controller.signal,
        (progress) => this.update({ ...this.job, progress }),
        session,
      );
      const cancelled = this.controller.signal.aborted;
      this.update({
        ...this.job,
        status: cancelled
          ? papers.length > 0
            ? "partial"
            : "cancelled"
          : papers.length >= target
            ? "completed"
            : "partial",
        papers,
        finishedAt: Date.now(),
      });
    } catch (error) {
      this.update({
        ...this.job,
        status: this.controller.signal.aborted ? "cancelled" : "failed",
        error: error instanceof Error ? error.message : String(error),
        finishedAt: Date.now(),
      });
    } finally {
      this.controller = undefined;
    }
    return this.job;
  }

  private update(job: ScholarlyExportJob): void {
    this.job = job;
    for (const listener of this.listeners) listener(job);
  }
}

export const scholarlyExportManager = new ScholarlyExportManager();
