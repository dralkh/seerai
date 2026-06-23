// Shared quote-grounding utilities. The original grounding check only collapsed
// whitespace and lowercased before an exact substring match, so it produced
// false "ungrounded_quote" failures whenever the PDF text and the model's quote
// differed by an en-dash vs hyphen, a non-breaking space, a CI comma, a smart
// quote, a ligature, or a "..." the model inserted. This module normalises those
// differences and adds an ellipsis-aware, fuzzy fallback so genuine quotes are
// recognised while fabricated quotes are still rejected.

export interface GroundingResult {
  grounded: boolean;
  mode: "exact" | "fuzzy" | "none";
}

// Trailing figure/table/equation references the model often appends to a quote
// but that are not part of the running text (e.g. "... (Fig. 2a)").
const TRAILING_REF =
  /\s*\((?:see\s+)?(?:fig(?:ure)?|figs?|table|tbl|panel|suppl[a-z]*|appendix|appx|eq(?:uation)?|ref)\.?\s*[^)]*\)\s*$/i;

// Dash / minus variants → "-": hyphen range U+2010–U+2015, minus U+2212,
// small/full-width forms U+FE58, U+FE63, U+FF0D.
const DASHES = /[‐-―−﹘﹣－]/g;
// Whitespace variants → " ": NBSP, en/em spaces, thin/hair/zero-width, narrow
// no-break, medium math, ideographic.
const SPACES = /[  -​  　]/g;
const SINGLE_QUOTES = /[‘’‚‛′]/g;
const DOUBLE_QUOTES = /[“”„‟″]/g;

export function normalizeText(value: string): string {
  return value
    .normalize("NFKC")
    .replace(DASHES, "-")
    .replace(SPACES, " ")
    .replace(SINGLE_QUOTES, "'")
    .replace(DOUBLE_QUOTES, '"')
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function stripTrailingRefs(quote: string): string {
  let cleaned = quote.trim();
  let previous = "";
  while (cleaned !== previous) {
    previous = cleaned;
    cleaned = cleaned.replace(TRAILING_REF, "").trim();
  }
  return cleaned;
}

// Word/number tokens, ignoring surrounding punctuation so "ci," and "ci" or
// "0.87-0.96)" and "0.87-0.96" compare equal. Keeps internal '.', '-', '%' so
// numbers and ranges survive intact.
function tokenize(text: string): string[] {
  return text.match(/[a-z0-9][a-z0-9.%-]*/g) || [];
}

// Order-agnostic token coverage within a sliding window the size of the quote.
// Tolerates a small fraction of differing tokens (dropped commas, reworded
// connective words, number-formatting differences) while still requiring the
// bulk of the quote's tokens to appear contiguously in the source.
function fuzzyContains(
  normalizedQuote: string,
  normalizedContent: string,
  threshold = 0.9,
): boolean {
  const quoteTokens = tokenize(normalizedQuote);
  // Short quotes must match exactly (handled by the caller); fuzzy matching a
  // handful of common tokens is too permissive.
  if (quoteTokens.length < 5) return false;
  const contentTokens = tokenize(normalizedContent);
  if (contentTokens.length < quoteTokens.length) return false;

  const need = Math.ceil(quoteTokens.length * threshold);
  const windowSize = quoteTokens.length;
  const quoteFreq = new Map<string, number>();
  for (const token of quoteTokens) {
    quoteFreq.set(token, (quoteFreq.get(token) || 0) + 1);
  }
  const windowFreq = new Map<string, number>();
  let matches = 0;
  for (let i = 0; i < contentTokens.length; i++) {
    const token = contentTokens[i];
    const cap = quoteFreq.get(token);
    if (cap !== undefined) {
      const used = windowFreq.get(token) || 0;
      if (used < cap) matches++;
      windowFreq.set(token, used + 1);
    }
    if (i >= windowSize) {
      const leaving = contentTokens[i - windowSize];
      const used = windowFreq.get(leaving) || 0;
      if (used > 0) {
        if (used <= (quoteFreq.get(leaving) || 0)) matches--;
        windowFreq.set(leaving, used - 1);
      }
    }
    if (i >= windowSize - 1 && matches >= need) return true;
  }
  return false;
}

/**
 * Determine whether a supporting quote is grounded in the supplied source.
 * @param quote The model-supplied supporting quote (raw, un-normalised).
 * @param normalizedContent The source text, already passed through {@link normalizeText}.
 */
export function groundQuote(
  quote: string | undefined,
  normalizedContent: string,
): GroundingResult {
  if (!quote || !quote.trim()) return { grounded: false, mode: "none" };

  const cleaned = stripTrailingRefs(quote);
  // A model may stitch fragments with an ellipsis; require every meaningful
  // segment to be grounded independently.
  const segments = cleaned
    .split(/\s*(?:\.{3,}|…)\s*/)
    .map((segment) => segment.trim())
    .filter(Boolean);
  const targets = segments.length ? segments : [cleaned];

  let usedFuzzy = false;
  let checkedAny = false;
  for (const segment of targets) {
    const normalized = normalizeText(segment);
    if (normalized.length < 3) continue; // ignore trivial fragments
    checkedAny = true;
    if (normalizedContent.includes(normalized)) continue;
    if (fuzzyContains(normalized, normalizedContent)) {
      usedFuzzy = true;
      continue;
    }
    return { grounded: false, mode: "none" };
  }
  if (!checkedAny) return { grounded: false, mode: "none" };
  return { grounded: true, mode: usedFuzzy ? "fuzzy" : "exact" };
}

export function isGrounded(
  quote: string | undefined,
  normalizedContent: string,
): boolean {
  return groundQuote(quote, normalizedContent).grounded;
}
