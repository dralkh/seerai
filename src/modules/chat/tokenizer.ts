import { encode, encodeChat } from "gpt-tokenizer";

let _initialized = false;
let _initError: string | null = null;

function ensureInitialized(): void {
  if (_initialized) return;
  _initialized = true;
  try {
    if (typeof encode !== "function") {
      throw new Error("gpt-tokenizer encode is not a function");
    }
    void encode("test");
  } catch (e) {
    _initError = `gpt-tokenizer init failed: ${e}`;
  }
}

function bpeSafeEncode(text: string): number {
  try {
    return encode(text).length;
  } catch {
    return -1;
  }
}

function bpeSafeEncodeChat(
  messages: Array<{ role: string; content: string }>,
): number {
  try {
    const formatted = messages
      .filter((m) => m.content)
      .map((m) => ({
        role: m.role as "system" | "user" | "assistant",
        content: m.content,
      }));
    return encodeChat(formatted, "gpt-4o").length;
  } catch {
    return -1;
  }
}

function heuristicTokenCount(text: string): number {
  let cjkChars = 0;
  let otherChars = 0;

  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0x3040 && code <= 0x309f) ||
      (code >= 0x30a0 && code <= 0x30ff) ||
      (code >= 0xac00 && code <= 0xd7af)
    ) {
      cjkChars++;
    } else {
      otherChars++;
    }
  }

  if (cjkChars === 0 && otherChars === 0) return 0;

  const otherTokens = otherChars / 3.2;

  return Math.ceil(cjkChars + otherTokens);
}

export function countTokens(
  text: string,
  options?: { allowFallback?: boolean },
): number {
  if (!text) return 0;
  ensureInitialized();
  if (!_initError) {
    const result = bpeSafeEncode(text);
    if (result >= 0) return result;
    if (!options?.allowFallback) {
      Zotero.debug("[seerai] Tokenizer BPE failed, falling back to heuristic");
    }
  }
  return heuristicTokenCount(text);
}

export function countTokensBatch(
  texts: string[],
  options?: { allowFallback?: boolean },
): number[] {
  return texts.map((t) => countTokens(t, options));
}

export function countChatTokens(
  messages: Array<{ role: string; content: string }>,
  options?: { allowFallback?: boolean },
): number {
  ensureInitialized();
  if (!_initError && messages.length > 0) {
    const result = bpeSafeEncodeChat(messages);
    if (result >= 0) return result;
    if (!options?.allowFallback) {
      Zotero.debug(
        "[seerai] Tokenizer chat encode failed, falling back to sum",
      );
    }
  }
  let total = 0;
  for (const msg of messages) {
    total += countTokens(msg.content || "", { allowFallback: true });
  }
  return total;
}

export function isTokenizerAvailable(): boolean {
  ensureInitialized();
  return _initError === null;
}
