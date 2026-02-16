/**
 * Advanced Search Utilities for Tables Tab
 *
 * Provides accurate text search with:
 * - Multi-token AND matching (all terms must match)
 * - Boolean logic (AND, OR, NOT, parentheses)
 * - Case-insensitive comparison
 * - Simple substring matching for reliability
 */

/**
 * Normalize a string for comparison - lowercase and trim whitespace
 */
function normalize(str: string): string {
  return (str || "").toLowerCase().trim();
}

/**
 * Check if a query term matches a target string using simple substring matching.
 *
 * @param term - The search term (already normalized to lowercase)
 * @param target - The target string to search within
 * @returns true if the term is found in the target
 */
function simpleMatch(term: string, target: string): boolean {
  if (!target || !term) return false;
  return normalize(target).includes(term);
}

/**
 * Check if a single query term matches any of the target strings.
 */
function matchTermInAny(term: string, targets: string[]): boolean {
  for (const target of targets) {
    if (simpleMatch(term, target)) {
      return true;
    }
  }
  return false;
}

/**
 * Perform multi-token AND matching.
 * Each space-separated term in the query must match at least one target field.
 *
 * @param query - Search query (may contain multiple space-separated terms)
 * @param targets - Array of strings to search within
 * @returns true if ALL terms match at least one target
 */
export function multiTokenMatch(query: string, targets: string[]): boolean {
  const terms = normalize(query)
    .split(/\s+/)
    .filter((t) => t.length > 0);

  if (terms.length === 0) return true;

  for (const term of terms) {
    if (!matchTermInAny(term, targets)) {
      return false;
    }
  }
  return true;
}

/**
 * Advanced search function for table filtering.
 * All search terms must match at least one target field.
 * Uses simple case-insensitive substring matching for reliability.
 *
 * @param query - Search query string
 * @param searchTargets - Array of strings to search within
 * @returns Object with matches boolean and score (always 1 if matched)
 */
export function advancedSearch(
  query: string,
  searchTargets: string[],
): { matches: boolean; score: number } {
  const normalizedQuery = normalize(query);

  if (!normalizedQuery) {
    return { matches: true, score: 1 };
  }

  // Check if query contains Boolean operators
  const hasBooleanOperators = /\b(AND|OR|NOT)\b|[()]/i.test(normalizedQuery);
  if (hasBooleanOperators) {
    const matches = booleanSearch(query, searchTargets);
    return { matches, score: matches ? 1 : 0 };
  }

  const terms = normalizedQuery.split(/\s+/).filter((t) => t.length > 0);

  if (terms.length === 0) {
    return { matches: true, score: 1 };
  }

  // Filter out empty/null targets
  const validTargets = searchTargets.filter(
    (t) => t !== null && t !== undefined && String(t).trim() !== "",
  );

  // Helper to create smart regex for a term
  const createSmartRegex = (term: string): RegExp => {
    // Escape special regex characters
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

    // Smart Boundaries:
    // Only enforce word boundary if the edge character is alphanumeric (word character)
    // This allows "NO" -> "\bNO\b" (matches "no", not "technology")
    // But "**Verdict:**" -> "**Verdict:**" (matches substring with symbols)

    const startBoundary = /^\w/.test(term) ? "\\b" : "";
    const endBoundary = /\w$/.test(term) ? "\\b" : "";

    return new RegExp(`${startBoundary}${escaped}${endBoundary}`, "i");
  };

  // Check if a regex matches any of the targets
  const matchRegexInAny = (regex: RegExp, targets: string[]): boolean => {
    for (const target of targets) {
      if (regex.test(target)) return true;
    }
    return false;
  };

  // Each term must match at least one target (AND logic)
  for (const term of terms) {
    const regex = createSmartRegex(term);
    if (!matchRegexInAny(regex, validTargets)) {
      return { matches: false, score: 0 };
    }
  }

  return { matches: true, score: 1 };
}

/**
 * Boolean Search Logic
 * Supports AND, OR, NOT and parentheses.
 * Uses a recursive descent parser for expression evaluation.
 */
export function booleanSearch(query: string, targets: string[]): boolean {
  const rawTokens = tokenize(query);
  if (rawTokens.length === 0) return true;

  // Merge adjacent text tokens into implicit phrases
  // e.g. ["Verdict:", "no"] -> ["Verdict: no"]
  const tokens: string[] = [];
  if (rawTokens.length > 0) {
    let buffer = [rawTokens[0]];
    const isOperator = (t: string) =>
      ["AND", "OR", "NOT", "(", ")"].includes(t);

    for (let i = 1; i < rawTokens.length; i++) {
      const prev = rawTokens[i - 1];
      const curr = rawTokens[i];

      if (!isOperator(prev) && !isOperator(curr)) {
        // Both are text, merge
        buffer.push(curr);
      } else {
        // Operator boundary, flush buffer
        tokens.push(buffer.join(" "));
        buffer = [curr];
      }
    }
    tokens.push(buffer.join(" "));
  }

  let position = 0;

  function peek() {
    return tokens[position];
  }

  function consume() {
    return tokens[position++];
  }

  // Expression -> Term { OR Term }
  // depth parameter ensures we only stop at ')' if we are inside a group
  function parseExpression(depth: number = 0): boolean {
    let result = parseTerm(depth);
    while (peek() === "OR") {
      consume();
      const right = parseTerm(depth);
      result = result || right;
    }
    return result;
  }

  // Term -> Factor { [AND] Factor }
  function parseTerm(depth: number): boolean {
    let result = parseFactor(depth);
    // Continue if AND, or if implicit AND (next token is not OR and not closing parenthesis we're waiting for)
    // If depth > 0, ')' stops the term. If depth == 0, ')' is treated as a token (via parseFactor next loop or implicit AND?
    // Wait, if peek is ')', and depth==0, we should NOT stop. We should consume it as a factor (implicit AND).
    // If peek is ')', and depth>0, we stop.

    while (true) {
      const token = peek();
      if (!token) break; // End of input

      if (token === "OR") break; // OR binds looser, handled by parseExpression

      if (token === ")") {
        if (depth > 0) break; // Closing for this level
        // If depth == 0, treat ')' as a text token via parseFactor -> implicit AND
      }

      if (token === "AND") {
        consume();
        const right = parseFactor(depth);
        result = result && right;
      } else {
        // Implicit AND
        const right = parseFactor(depth);
        result = result && right;
      }
    }
    return result;
  }

  // Factor -> NOT Factor | ( Expression ) | Token
  function parseFactor(depth: number): boolean {
    const token = peek();

    if (token === "NOT") {
      consume();
      return !parseFactor(depth);
    }

    if (token === "(") {
      consume();
      // Start of a group
      const result = parseExpression(depth + 1);
      if (peek() === ")") {
        consume();
      }
      return result;
    }

    // Token match
    consume();
    // If token is undefined (EOF), matchTermInAny handles it gracefully or we shouldn't be here
    return matchTermInAny(normalize(token || ""), targets);
  }

  try {
    const result = parseExpression(0);
    // If we have unconsumed tokens, and we were at the top level, it implies the parser stopped correctly or incorrectly.
    // With the new logic, we consume everything unless stopped by OR.
    // But parseExpression handles OR. So we should consume everything.
    if (position < tokens.length) {
      throw new Error("Unconsumed tokens");
    }
    return result;
  } catch (e) {
    // Fallback: If strict parsing fails (e.g. "1) ..."), perform a relaxed "Implicit AND" search
    // Treat ALL tokens as required terms (ignoring operators as keywords)
    // This solves "1) **Verdict**: ..." where ')' might have broken the parser
    return tokens.every((token) => {
      // Treat boolean keywords as normal text in fallback
      return matchTermInAny(normalize(token), targets);
    });
  }
}

/**
 * Tokenize a Boolean search query.
 */
function tokenize(query: string): string[] {
  const regex = /\b(AND|OR|NOT)\b|[()]|"(?:\\"|[^"])*"|[^\s()]+/gi;
  const tokens: string[] = [];
  let match;

  while ((match = regex.exec(query)) !== null) {
    let token = match[0];
    if (token.startsWith('"') && token.endsWith('"')) {
      token = token.slice(1, -1).replace(/\\"/g, '"');
    }
    const upper = token.toUpperCase();
    tokens.push(
      upper === "AND" || upper === "OR" || upper === "NOT" ? upper : token,
    );
  }
  return tokens;
}

/**
 * Calculate a fuzzy match score between a query term and a target string.
 * @returns Score from 0 (no match) to 1 (match found)
 */
export function fuzzyScore(query: string, target: string): number {
  return simpleMatch(normalize(query), target) ? 1 : 0;
}
