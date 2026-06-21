import { searchScholarlyPapers } from "./service";
import { createAbortController, createAbortError } from "./env";
import { FederatedSearchResult, ScholarlySearchQuery } from "./types";

export type SearchControllerStatus = "idle" | "searching" | "ready" | "error";

export interface SearchControllerSnapshot {
  status: SearchControllerStatus;
  session?: FederatedSearchResult;
  error?: string;
}

type SearchListener = (snapshot: SearchControllerSnapshot) => void;

export class ScholarlySearchController {
  private controller?: AbortController;
  private requestId = 0;
  private snapshot: SearchControllerSnapshot = { status: "idle" };
  private readonly listeners = new Set<SearchListener>();

  subscribe(listener: SearchListener): () => void {
    this.listeners.add(listener);
    listener(this.snapshot);
    return () => this.listeners.delete(listener);
  }

  getSnapshot(): SearchControllerSnapshot {
    return this.snapshot;
  }

  cancel(): void {
    this.controller?.abort();
    this.controller = undefined;
    this.setSnapshot({ ...this.snapshot, status: "idle" });
  }

  async search(
    query: ScholarlySearchQuery,
    paginate = false,
  ): Promise<FederatedSearchResult> {
    this.controller?.abort();
    const controller = createAbortController();
    this.controller = controller;
    const requestId = ++this.requestId;
    const previous = paginate ? this.snapshot.session : undefined;
    this.setSnapshot({ status: "searching", session: previous });
    try {
      const session = await searchScholarlyPapers(
        query,
        previous,
        controller.signal,
      );
      if (requestId !== this.requestId) throw createAbortError("Stale");
      session.requestId = String(requestId);
      this.setSnapshot({ status: "ready", session });
      return session;
    } catch (error) {
      if (requestId === this.requestId && !controller.signal.aborted) {
        this.setSnapshot({
          status: "error",
          session: previous,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      throw error;
    } finally {
      if (requestId === this.requestId) this.controller = undefined;
    }
  }

  restore(session: FederatedSearchResult | undefined): void {
    this.cancel();
    this.setSnapshot({ status: session ? "ready" : "idle", session });
  }

  private setSnapshot(snapshot: SearchControllerSnapshot): void {
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener(snapshot);
  }
}

export const scholarlySearchController = new ScholarlySearchController();
