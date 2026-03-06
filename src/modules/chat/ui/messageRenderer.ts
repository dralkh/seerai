/**
 * Message rendering utilities for chat UI
 * Extracted from assistant.ts for better modularity
 */

import { ChatMessage } from "../types";
import { parseMarkdown } from "../markdown";
import { openAIService } from "../../openai";
import { getActiveModelConfig } from "../modelConfig";
import type { RAGProgressEvent } from "../rag/types";

// Global TTS audio state — only one message plays at a time
let currentTtsAudio: HTMLAudioElement | null = null;
let currentTtsButton: HTMLElement | null = null;
let currentTtsBlobUrl: string | null = null;

/**
 * Strip markdown formatting from text so TTS reads naturally.
 * Removes: headers, bold/italic markers, code blocks, links, images, etc.
 */
function stripMarkdownForTts(text: string): string {
  return (
    text
      // Remove code blocks (``` ... ```) — drop the content entirely
      .replace(/```[\s\S]*?```/g, "")
      // Remove inline code (`...`)
      .replace(/`([^`]+)`/g, "$1")
      // Remove images ![alt](url)
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
      // Remove links [text](url) → keep text
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      // Remove headers (# ## ### etc.)
      .replace(/^#{1,6}\s+/gm, "")
      // Remove bold/italic markers (*** ** * ___ __ _)
      .replace(/(\*{1,3}|_{1,3})(.*?)\1/g, "$2")
      // Remove horizontal rules
      .replace(/^[-*_]{3,}\s*$/gm, "")
      // Remove blockquote markers
      .replace(/^>\s+/gm, "")
      // Remove list markers (- * + 1.)
      .replace(/^[\s]*[-*+]\s+/gm, "")
      .replace(/^[\s]*\d+\.\s+/gm, "")
      // Collapse multiple newlines
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}

/**
 * Stop any currently playing TTS audio and reset button state
 */
export function stopTtsPlayback(): void {
  if (currentTtsBlobUrl) {
    URL.revokeObjectURL(currentTtsBlobUrl);
    currentTtsBlobUrl = null;
  }
  if (currentTtsAudio) {
    currentTtsAudio.pause();
    currentTtsAudio.src = "";
    currentTtsAudio = null;
  }
  if (currentTtsButton) {
    currentTtsButton.innerText = "\u{1F50A}"; // 🔊
    currentTtsButton.title = "Play TTS";
    currentTtsButton = null;
  }
}

/**
 * Play TTS for the given text, updating the button state.
 * Stops any currently playing TTS first.
 */
export async function playTts(
  text: string,
  button: HTMLElement,
): Promise<void> {
  // If this button is already playing, stop it
  if (currentTtsButton === button && currentTtsAudio) {
    stopTtsPlayback();
    return;
  }

  // Stop any other playing TTS
  stopTtsPlayback();

  const originalText = button.innerText;
  button.innerText = "\u23F3"; // ⏳
  button.title = "Loading...";
  currentTtsButton = button;

  try {
    const cleanText = stripMarkdownForTts(text);
    const audioBuffer = await openAIService.textToSpeech(cleanText);
    const blob = new Blob([audioBuffer], { type: "audio/mpeg" });
    const url = URL.createObjectURL(blob);
    currentTtsBlobUrl = url;
    const audio = button.ownerDocument!.createElement(
      "audio",
    ) as HTMLAudioElement;
    audio.src = url;
    currentTtsAudio = audio;

    button.innerText = "\u23F9"; // ⏹
    button.title = "Stop";

    audio.addEventListener("ended", () => {
      URL.revokeObjectURL(url);
      currentTtsBlobUrl = null;
      if (currentTtsButton === button) {
        button.innerText = "\u{1F50A}"; // 🔊
        button.title = "Play TTS";
        currentTtsAudio = null;
        currentTtsButton = null;
      }
    });

    audio.addEventListener("error", () => {
      URL.revokeObjectURL(url);
      button.innerText = "\u274C"; // ❌
      button.title = "TTS playback failed";
      setTimeout(() => {
        button.innerText = "\u{1F50A}"; // 🔊
        button.title = "Play TTS";
      }, 2000);
      if (currentTtsButton === button) {
        currentTtsAudio = null;
        currentTtsButton = null;
      }
    });

    await audio.play();
  } catch (e) {
    Zotero.debug(`[seerai] TTS error: ${e}`);
    button.innerText = "\u274C"; // ❌
    button.title = `TTS failed: ${e}`;
    setTimeout(() => {
      button.innerText = originalText;
      button.title = "Play TTS";
    }, 2000);
    currentTtsButton = null;
    currentTtsAudio = null;
  }
}

/**
 * Check if TTS is configured for the active model
 */
export function isTtsConfigured(): boolean {
  const config = getActiveModelConfig();
  return !!config?.ttsConfig?.model;
}

/**
 * Auto-play TTS for an assistant response (no button needed).
 * Uses the same global audio state so manual play/stop still works.
 */
export async function autoPlayTtsResponse(text: string): Promise<void> {
  if (!isTtsConfigured() || !text.trim()) return;

  // Stop any currently playing TTS
  stopTtsPlayback();

  try {
    const cleanText = stripMarkdownForTts(text);
    const audioBuffer = await openAIService.textToSpeech(cleanText);
    const blob = new Blob([audioBuffer], { type: "audio/mpeg" });
    const url = URL.createObjectURL(blob);
    currentTtsBlobUrl = url;
    const doc = Zotero.getMainWindow().document;
    const audio = doc.createElement("audio") as HTMLAudioElement;
    audio.src = url;
    currentTtsAudio = audio;
    currentTtsButton = null; // No button for auto-play

    audio.addEventListener("ended", () => {
      URL.revokeObjectURL(url);
      currentTtsBlobUrl = null;
      currentTtsAudio = null;
    });

    audio.addEventListener("error", () => {
      URL.revokeObjectURL(url);
      currentTtsAudio = null;
      Zotero.debug("[seerai] Auto-play TTS playback failed");
    });

    await audio.play();
  } catch (e) {
    Zotero.debug(`[seerai] Auto-play TTS error: ${e}`);
    currentTtsAudio = null;
  }
}

/**
 * Message colors configuration
 * Uses CSS variables to support both light and dark modes
 */
export const messageColors = {
  user: {
    bg: "var(--message-user-background)",
    text: "var(--message-user-text)",
  },
  assistant: {
    bg: "var(--message-assistant-background)",
    text: "var(--message-assistant-text)",
  },
  error: {
    bg: "var(--button-clear-background)",
    text: "var(--button-clear-text)",
  },
};

/**
 * Create action button for message actions (copy, edit, retry)
 */
export function createActionButton(
  doc: Document,
  icon: string,
  tooltip: string,
  onClick: () => void,
): HTMLElement {
  const btn = doc.createElement("button");
  btn.innerText = icon;
  btn.title = tooltip;
  Object.assign(btn.style, {
    background: "none",
    border: "none",
    cursor: "pointer",
    padding: "2px",
    fontSize: "11px",
    opacity: "0.7",
  });
  btn.addEventListener("mouseover", () => {
    btn.style.opacity = "1";
  });
  btn.addEventListener("mouseout", () => {
    btn.style.opacity = "0.7";
  });
  btn.addEventListener("click", onClick);
  return btn;
}

/**
 * Copy text to clipboard and show feedback
 */
export function copyToClipboard(text: string, button: HTMLElement): void {
  const originalText = button.innerText;

  if (navigator.clipboard) {
    navigator.clipboard
      .writeText(text)
      .then(() => {
        button.innerText = "✓";
        setTimeout(() => {
          button.innerText = originalText;
        }, 2000);
      })
      .catch(() => {
        button.innerText = "❌";
        setTimeout(() => {
          button.innerText = originalText;
        }, 2000);
      });
  } else {
    // Fallback for environments without clipboard API
    button.innerText = "❌";
    setTimeout(() => {
      button.innerText = originalText;
    }, 2000);
  }
}

/**
 * Create a message bubble element
 */
export function createMessageBubble(
  doc: Document,
  sender: string,
  text: string,
  bgColor: string,
  textColor: string,
  msgId?: string,
  options?: {
    isLastUserMsg?: boolean;
    isStreaming?: boolean;
    onEdit?: (msgDiv: HTMLElement, msgId: string) => void;
    onRetry?: () => void;
  },
): HTMLElement {
  const isUser = sender === "You";
  const isAssistant = sender === "Assistant";

  const msgDiv = doc.createElement("div");
  if (msgId) msgDiv.setAttribute("data-msg-id", msgId);
  Object.assign(msgDiv.style, {
    backgroundColor: bgColor,
    padding: "10px 14px",
    borderRadius: isUser ? "12px 12px 4px 12px" : "12px 12px 12px 4px",
    fontSize: "13px",
    maxWidth: isUser ? "90%" : "100%",
    minWidth: "0",
    flexShrink: "0",
    alignSelf: isUser ? "flex-end" : "flex-start",
    color: textColor,
    boxShadow: "0 1px 2px rgba(0,0,0,0.1)",
    position: "relative",
    boxSizing: "border-box",
  });

  // Header with sender and actions
  const headerDiv = doc.createElement("div");
  Object.assign(headerDiv.style, {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: "4px",
  });

  const senderDiv = doc.createElement("span");
  Object.assign(senderDiv.style, {
    fontWeight: "600",
    fontSize: "11px",
    opacity: "0.8",
  });
  senderDiv.innerText = sender;

  // Action buttons container
  const actionsDiv = doc.createElement("div");
  Object.assign(actionsDiv.style, {
    display: "flex",
    gap: "4px",
    opacity: "0.6",
  });

  // Copy button (for all messages)
  const copyBtn = createActionButton(doc, "📋", "Copy", () => {
    copyToClipboard(text, copyBtn);
  });
  actionsDiv.appendChild(copyBtn);

  // TTS play button (when TTS is configured)
  if (isTtsConfigured()) {
    Zotero.debug("[seerai] TTS configured, adding play button to message");
    const ttsBtn = createActionButton(doc, "\u{1F50A}", "Play TTS", () => {
      // Read the latest text from the content div's data-raw attribute
      const currentText =
        msgDiv.querySelector("[data-content]")?.getAttribute("data-raw") ||
        text;
      playTts(currentText, ttsBtn);
    });
    actionsDiv.appendChild(ttsBtn);
  }

  // Edit button (only for last user message)
  if (isUser && options?.isLastUserMsg && options?.onEdit) {
    const editBtn = createActionButton(doc, "✏️", "Edit", () => {
      options.onEdit!(msgDiv, msgId || "");
    });
    actionsDiv.appendChild(editBtn);
  }

  // Retry button (for assistant messages)
  if (isAssistant && !options?.isStreaming && options?.onRetry) {
    const retryBtn = createActionButton(doc, "🔄", "Retry", options.onRetry);
    actionsDiv.appendChild(retryBtn);
  }

  headerDiv.appendChild(senderDiv);
  headerDiv.appendChild(actionsDiv);

  const contentDiv = doc.createElement("div");
  contentDiv.setAttribute("data-content", "true");
  contentDiv.setAttribute("data-raw", text);
  Object.assign(contentDiv.style, {
    lineHeight: "1.5",
    overflowX: "auto",
    overflowWrap: "break-word",
    wordBreak: "break-word",
    maxWidth: "100%",
  });
  try {
    contentDiv.innerHTML = parseMarkdown(text);
  } catch (e) {
    Zotero.debug(`[seerai] Error rendering markdown: ${e}`);
    contentDiv.textContent = text; // Fallback to plain text
  }

  msgDiv.appendChild(headerDiv);
  msgDiv.appendChild(contentDiv);

  return msgDiv;
}

/**
 * Render a stored message from ChatMessage
 */
export function renderStoredMessage(
  container: HTMLElement,
  msg: ChatMessage,
  isLastUserMsg: boolean = false,
  options?: {
    isStreaming?: boolean;
    onEdit?: (msgDiv: HTMLElement, msgId: string) => void;
    onRetry?: () => void;
  },
): HTMLElement {
  const doc = container.ownerDocument!;
  const isUser = msg.role === "user";
  const colors = isUser
    ? messageColors.user
    : msg.role === "error"
      ? messageColors.error
      : messageColors.assistant;
  const sender = isUser ? "You" : msg.role === "error" ? "Error" : "Assistant";

  const msgDiv = createMessageBubble(
    doc,
    sender,
    msg.content,
    colors.bg,
    colors.text,
    msg.id,
    { isLastUserMsg, ...options },
  );

  container.appendChild(msgDiv);
  container.scrollTop = container.scrollHeight;

  return msgDiv;
}

/**
 * Append a new message bubble to the chat area
 */
export function appendMessage(
  container: HTMLElement,
  sender: string,
  text: string,
  bgColor: string,
  textColor: string = "#000",
  msgId?: string,
  options?: {
    isLastUserMsg?: boolean;
    isStreaming?: boolean;
    onEdit?: (msgDiv: HTMLElement, msgId: string) => void;
    onRetry?: () => void;
  },
): HTMLElement {
  const doc = container.ownerDocument!;
  const msgDiv = createMessageBubble(
    doc,
    sender,
    text,
    bgColor,
    textColor,
    msgId,
    options,
  );
  container.appendChild(msgDiv);
  container.scrollTop = container.scrollHeight;
  return msgDiv;
}

// ─── HTML namespace for XUL-compatible element creation ──────────────────────
const RAG_HTML_NS = "http://www.w3.org/1999/xhtml";

/**
 * Create a live RAG progress UI component.
 *
 * Shows a collapsible panel that replaces the generic "Thinking..." indicator
 * with real-time RAG pipeline status and visual relevance rankings.
 *
 * The component is a `<details>` element (collapsed by default) with:
 * - A summary bar showing the current step + spinner
 * - A live-updating list of ranked results with score bars
 *
 * Returns an `update(event)` function that the caller feeds with
 * `RAGProgressEvent` objects from `retrieveContext()`.
 */
export function createRAGProgressUI(doc: Document): {
  container: HTMLElement;
  update: (event: RAGProgressEvent) => void;
} {
  const details = doc.createElementNS(
    RAG_HTML_NS,
    "details",
  ) as HTMLDetailsElement;
  details.open = true; // start expanded so user sees progress
  details.style.cssText = `
    margin: 4px 0 8px 0;
    border: 1px solid var(--border-secondary, #e0e0e0);
    border-radius: 8px;
    background: var(--background-primary, #fff);
    overflow: hidden;
    box-shadow: 0 1px 3px rgba(0,0,0,0.06);
    font-size: 12.5px;
    line-height: 1.4;
  `;

  // ── Summary bar ────────────────────────────────────────────────────────
  const summary = doc.createElementNS(RAG_HTML_NS, "summary") as HTMLElement;
  summary.style.cssText = `
    padding: 6px 10px;
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: 6px;
    font-weight: 500;
    color: var(--text-secondary, #555);
    list-style: none;
    user-select: none;
  `;

  const spinner = doc.createElementNS(RAG_HTML_NS, "span") as HTMLElement;
  spinner.textContent = "\u25CE"; // ◎
  spinner.style.cssText = `
    display: inline-block;
    animation: rag-spin 1.2s linear infinite;
    font-size: 14px;
  `;

  const statusLabel = doc.createElementNS(RAG_HTML_NS, "span") as HTMLElement;
  statusLabel.textContent = "Smart Context: initializing...";
  statusLabel.style.flex = "1";

  const chevron = doc.createElementNS(RAG_HTML_NS, "span") as HTMLElement;
  chevron.innerHTML = `<svg width="10" height="6" viewBox="0 0 10 6" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M1 1L5 5L9 1" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  chevron.style.cssText = `
    color: var(--text-tertiary, #999);
    transition: transform 0.2s ease;
    transform: rotate(0deg);
  `;

  summary.appendChild(spinner);
  summary.appendChild(statusLabel);
  summary.appendChild(chevron);
  details.appendChild(summary);

  details.addEventListener("toggle", () => {
    chevron.style.transform = details.open ? "rotate(0deg)" : "rotate(-90deg)";
  });

  // ── Ranking list container ─────────────────────────────────────────────
  const listContainer = doc.createElementNS(RAG_HTML_NS, "div") as HTMLElement;
  listContainer.style.cssText = `
    padding: 6px 10px 8px;
    border-top: 1px solid var(--border-secondary, #e0e0e0);
    background: var(--fill-quinary, rgba(0,0,0,0.015));
    max-height: 400px;
    overflow-y: auto;
  `;
  details.appendChild(listContainer);

  // ── CSS animation (injected once) ──────────────────────────────────────
  const styleId = "seerai-rag-progress-styles";
  if (!doc.getElementById(styleId)) {
    const style = doc.createElementNS(RAG_HTML_NS, "style") as HTMLElement;
    style.id = styleId;
    style.textContent = `
      @keyframes rag-spin {
        0% { transform: rotate(0deg); }
        100% { transform: rotate(360deg); }
      }
      @keyframes rag-bar-fill {
        from { width: 0; }
      }
      .rag-rank-row {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 4px 0;
        font-size: 11.5px;
        color: var(--text-primary, #333);
        border-bottom: 1px solid var(--fill-quaternary, rgba(0,0,0,0.04));
      }
      .rag-rank-row:last-child {
        border-bottom: none;
      }
      .rag-rank-pos {
        flex-shrink: 0;
        width: 18px;
        text-align: right;
        font-weight: 600;
        color: var(--text-tertiary, #888);
        font-size: 10.5px;
      }
      .rag-rank-bar-bg {
        flex-shrink: 0;
        width: 60px;
        height: 6px;
        background: var(--fill-quaternary, #e8e8e8);
        border-radius: 3px;
        overflow: hidden;
      }
      .rag-rank-bar {
        height: 100%;
        border-radius: 3px;
        animation: rag-bar-fill 0.4s ease-out;
        transition: width 0.3s ease;
      }
      .rag-rank-title {
        flex: 1;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        min-width: 0;
      }
      .rag-rank-score {
        flex-shrink: 0;
        font-size: 10px;
        font-weight: 500;
        color: var(--text-tertiary, #888);
        font-variant-numeric: tabular-nums;
      }
      .rag-rank-source {
        flex-shrink: 0;
        font-size: 9px;
        padding: 1px 4px;
        border-radius: 3px;
        background: var(--fill-quaternary, #eee);
        color: var(--text-tertiary, #888);
        text-transform: uppercase;
        letter-spacing: 0.3px;
      }
    `;
    const styleTarget = doc.head || doc.documentElement;
    if (styleTarget) styleTarget.appendChild(style);
  }

  // ── Step label (below summary, inside list area) ───────────────────────
  const stepLabel = doc.createElementNS(RAG_HTML_NS, "div") as HTMLElement;
  stepLabel.style.cssText = `
    font-size: 11px;
    color: var(--text-tertiary, #888);
    margin-bottom: 4px;
    font-style: italic;
  `;
  stepLabel.textContent = "Initializing retrieval pipeline...";
  listContainer.appendChild(stepLabel);

  const rankList = doc.createElementNS(RAG_HTML_NS, "div") as HTMLElement;
  listContainer.appendChild(rankList);

  // ── Score-to-color helper ──────────────────────────────────────────────
  function scoreColor(score: number): string {
    // Green (high) → Yellow (mid) → Red (low)
    if (score >= 0.7) return "#34C759";
    if (score >= 0.5) return "#FF9500";
    if (score >= 0.3) return "#FFCC02";
    return "#FF3B30";
  }

  // ── Update function ────────────────────────────────────────────────────
  function update(event: RAGProgressEvent): void {
    // Update status label
    const stepIcons: Record<string, string> = {
      indexing: "\uD83D\uDCDA", // 📚
      "embedding-query": "\uD83D\uDD0D", // 🔍
      searching: "\uD83D\uDD0E", // 🔎
      reranking: "\u2696\uFE0F", // ⚖️
      assembling: "\uD83D\uDCE6", // 📦
      "embedding-passthrough": "\uD83D\uDCCA", // 📊
      complete: "\u2713", // ✓
    };

    const icon = stepIcons[event.step] || "\u25CE";

    if (event.step === "complete") {
      spinner.textContent = "\u2713"; // ✓
      spinner.style.animation = "none";
      spinner.style.color = "var(--accent-green, #34C759)";
      statusLabel.textContent = `Smart Context: ${event.message}`;
      // Auto-collapse after a short delay
      setTimeout(() => {
        details.open = false;
      }, 2000);
    } else {
      spinner.textContent = icon;
      statusLabel.textContent = `Smart Context: ${event.message}`;
    }

    // Update step label
    stepLabel.textContent = event.message;

    // Render ranked results if available
    if (event.rankedResults && event.rankedResults.length > 0) {
      rankList.innerHTML = "";
      // maxScore only from scored items (exclude verbatim passthrough with score -1)
      const scoredItems = event.rankedResults.filter((r) => r.score >= 0);
      const maxScore = scoredItems.length > 0 ? scoredItems[0].score : 1;

      event.rankedResults.forEach((item, idx) => {
        const isVerbatim = item.score < 0;
        const row = doc.createElementNS(RAG_HTML_NS, "div") as HTMLElement;
        row.className = "rag-rank-row";

        // Position number
        const pos = doc.createElementNS(RAG_HTML_NS, "span") as HTMLElement;
        pos.className = "rag-rank-pos";
        pos.textContent = isVerbatim ? "\u2022" : `${idx + 1}`;

        // Score bar
        const barBg = doc.createElementNS(RAG_HTML_NS, "div") as HTMLElement;
        barBg.className = "rag-rank-bar-bg";
        const bar = doc.createElementNS(RAG_HTML_NS, "div") as HTMLElement;
        bar.className = "rag-rank-bar";
        if (isVerbatim) {
          // Verbatim passthrough items get a full-width bar in a distinct color
          bar.style.width = "100%";
          bar.style.background = "#42A5F5"; // blue for "included verbatim"
        } else {
          const pct = maxScore > 0 ? (item.score / maxScore) * 100 : 0;
          bar.style.width = `${pct}%`;
          bar.style.background = scoreColor(item.score);
        }
        barBg.appendChild(bar);

        // Title + description container
        const titleBlock = doc.createElementNS(
          RAG_HTML_NS,
          "div",
        ) as HTMLElement;
        titleBlock.style.cssText = `
          flex: 1;
          overflow: hidden;
          min-width: 0;
        `;

        const title = doc.createElementNS(RAG_HTML_NS, "div") as HTMLElement;
        title.className = "rag-rank-title";
        title.textContent = item.title;
        title.title = item.title; // full title on hover
        titleBlock.appendChild(title);

        // Description (content preview) — shown if available
        if (item.description) {
          const desc = doc.createElementNS(RAG_HTML_NS, "div") as HTMLElement;
          desc.style.cssText = `
            font-size: 10px;
            color: var(--text-tertiary, #999);
            overflow: hidden;
            display: -webkit-box;
            -webkit-line-clamp: 3;
            -webkit-box-orient: vertical;
            line-height: 1.3;
            margin-top: 2px;
            word-break: break-word;
          `;
          desc.textContent = item.description;
          desc.title = item.description;
          titleBlock.appendChild(desc);
        }

        // Score number (or "verbatim" label for passthrough items)
        const scoreEl = doc.createElementNS(RAG_HTML_NS, "span") as HTMLElement;
        scoreEl.className = "rag-rank-score";
        if (isVerbatim) {
          scoreEl.textContent = "verbatim";
          scoreEl.style.fontSize = "9px";
          scoreEl.style.color = "#42A5F5";
        } else {
          scoreEl.textContent = item.score.toFixed(3);
        }

        // Source badge with type-specific coloring
        const source = doc.createElementNS(RAG_HTML_NS, "span") as HTMLElement;
        source.className = "rag-rank-source";
        source.textContent = item.source;

        // Color-code by source type
        const sourceColors: Record<string, { bg: string; color: string }> = {
          table: { bg: "#E3F2FD", color: "#1565C0" },
          file: { bg: "#FFF3E0", color: "#E65100" },
          pdf: { bg: "#E8F5E9", color: "#2E7D32" },
          note: { bg: "#F3E5F5", color: "#6A1B9A" },
          abstract: { bg: "#FFFDE7", color: "#F57F17" },
          metadata: { bg: "#ECEFF1", color: "#455A64" },
        };
        const sc = sourceColors[item.source] || sourceColors.note;
        source.style.background = sc.bg;
        source.style.color = sc.color;

        row.appendChild(pos);
        row.appendChild(barBg);
        row.appendChild(titleBlock);
        row.appendChild(scoreEl);
        row.appendChild(source);
        rankList.appendChild(row);
      });
    }
  }

  return { container: details, update };
}
