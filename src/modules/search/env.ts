// Several Web/DOM globals are not present in the Zotero plugin module scope,
// even though `fetch`, `URL`, and `URLSearchParams` are. Most notably
// `AbortController` is undefined here (see the same guard in modules/openai.ts),
// and constructing `DOMException` / `DOMParser` is not guaranteed either.
//
// Resolve them from the module scope when available, otherwise from the Zotero
// main window, which is a full DOM window. `fetch` is intentionally sourced from
// the SAME scope as `AbortController` so the produced AbortSignal stays
// compatible with the fetch implementation that receives it (a signal from a
// different global is rejected by Gecko's fetch).

interface DomScope {
  AbortController: typeof AbortController;
  DOMException?: typeof DOMException;
  DOMParser: typeof DOMParser;
  fetch: typeof fetch;
}

function getDomScope(): DomScope {
  const scope = globalThis as any;
  if (typeof scope.AbortController !== "undefined") {
    return scope as DomScope;
  }
  try {
    const win = (globalThis as any).Zotero?.getMainWindow?.();
    if (win && typeof win.AbortController !== "undefined") {
      return win as DomScope;
    }
  } catch {
    // fall through to the module scope below
  }
  return scope as DomScope;
}

export function createAbortController(): AbortController {
  return new (getDomScope().AbortController)();
}

export function scopedFetch(
  input: string,
  init?: RequestInit,
): Promise<Response> {
  return getDomScope().fetch(input, init);
}

export function createDOMParser(): DOMParser {
  return new (getDomScope().DOMParser)();
}

/**
 * Construct a DOMException when the global is available, otherwise a plain Error
 * carrying the same `name` (e.g. "AbortError") so downstream `.name` checks and
 * `signal.aborted` handling still behave correctly.
 */
export function createAbortError(message = "Aborted"): Error {
  const Ctor = getDomScope().DOMException;
  if (typeof Ctor !== "undefined") return new Ctor(message, "AbortError");
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}
