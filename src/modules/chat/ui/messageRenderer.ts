/**
 * Message rendering utilities for chat UI
 * Extracted from assistant.ts for better modularity
 */

import { ChatMessage } from "../types";
import { parseMarkdown } from "../markdown";
import { openAIService } from "../../openai";
import { getActiveModelConfig } from "../modelConfig";
import type { RAGProgressEvent } from "../rag/types";
import { ChatContextManager } from "../context/contextManager";

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
  const btn = doc.createElementNS(
    "http://www.w3.org/1999/xhtml",
    "button",
  ) as HTMLButtonElement;
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
    wireCodePreviewButtons(contentDiv);
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

export function wireCodePreviewButtons(contentDiv: HTMLElement): void {
  const doc = contentDiv.ownerDocument!;

  // Use event delegation on the stable parent (survives innerHTML replacements)
  if (contentDiv.getAttribute("data-preview-wired")) return;
  contentDiv.setAttribute("data-preview-wired", "true");

  contentDiv.addEventListener("click", (e: Event) => {
    const btn = (e.target as HTMLElement).closest(
      ".code-preview-btn",
    ) as HTMLElement | null;
    if (!btn || !contentDiv.contains(btn)) return;

    const wrapper = btn.closest("[data-codeblock-lang]") as HTMLElement | null;
    if (!wrapper) return;
    const lang = wrapper.getAttribute("data-codeblock-lang") || "";
    const pre = wrapper.querySelector("pre") as HTMLElement | null;
    const code = pre?.querySelector("code") as HTMLElement | null;
    if (!code) return;
    const sourceContent = code.textContent || "";

    // If already expanded inline, toggle off
    const existingSplit = wrapper.querySelector(
      ".code-preview-split",
    ) as HTMLElement | null;
    if (existingSplit) {
      wrapper.style.flexDirection = "";
      wrapper.style.height = "";
      if (pre) pre.style.flex = "";
      existingSplit.remove();
      wrapper.querySelector(".code-preview-handle")?.remove();
      btn.textContent = "\u25B6 Preview";
      return;
    }

    btn.textContent = "\u2715";
    btn.title = "Close preview";

    // ── Build the split pane ────────────────────────────────────
    const split = doc.createElementNS(RAG_HTML_NS, "div") as HTMLElement;
    split.className = "code-preview-split";
    split.style.cssText =
      "flex: 1 1 0; min-height: 0; display: flex; flex-direction: column; overflow: hidden; border-top: 1px solid var(--border-primary);";

    // Toolbar row
    const tbar = doc.createElementNS(RAG_HTML_NS, "div") as HTMLElement;
    tbar.style.cssText =
      "display: flex; align-items: center; gap: 4px; padding: 4px 8px; border-bottom: 1px solid var(--border-primary); flex-shrink: 0; background: var(--background-primary);";

    function makeBtn(
      text: string,
      title: string,
      onClick: () => void,
    ): HTMLButtonElement {
      const b = doc.createElementNS(RAG_HTML_NS, "button") as HTMLButtonElement;
      b.textContent = text;
      b.title = title;
      Object.assign(b.style, {
        padding: "2px 6px",
        borderRadius: "4px",
        border: "1px solid var(--border-primary)",
        background: "transparent",
        color: "var(--text-secondary)",
        cursor: "pointer",
        fontSize: "10px",
        lineHeight: "1.3",
        transition: "background 0.1s",
      });
      b.addEventListener("mouseenter", () => {
        b.style.background = "var(--background-secondary)";
      });
      b.addEventListener("mouseleave", () => {
        b.style.background = "transparent";
      });
      b.addEventListener("click", (ce: Event) => {
        ce.stopPropagation();
        onClick();
      });
      return b;
    }

    // Copy
    const copyBtn = makeBtn("\uD83D\uDCCC Copy", "Copy code content", () => {
      try {
        new ztoolkit.Clipboard().addText(sourceContent, "text/unicode").copy();
        copyBtn.textContent = "\u2713 Copied";
        setTimeout(() => {
          copyBtn.textContent = "\uD83D\uDCCC Copy";
        }, 1500);
      } catch {
        copyBtn.textContent = "\u274C Failed";
        setTimeout(() => {
          copyBtn.textContent = "\uD83D\uDCCC Copy";
        }, 1500);
      }
    });

    // Add to Context
    const ctxBtn = makeBtn("\uD83D\uDCCB Ctx", "Add to chat context", () => {
      try {
        ChatContextManager.getInstance().addItem(
          `code-preview-${Date.now()}`,
          "file",
          `${lang.toUpperCase()} code block`,
          "toolbar",
          { text: sourceContent, mimeType: `text/${lang}` },
        );
        ctxBtn.textContent = "\u2713 Added";
        setTimeout(() => {
          ctxBtn.textContent = "\uD83D\uDCCB Ctx";
        }, 1500);
      } catch (e) {
        Zotero.debug(`[seerai] Error adding code to context: ${e}`);
        ctxBtn.textContent = "\u274C";
        setTimeout(() => {
          ctxBtn.textContent = "\uD83D\uDCCB Ctx";
        }, 1500);
      }
    });

    // Enlarge
    const enlargeBtn = makeBtn(
      "\u26F6 Enlarge",
      "Open in full preview window",
      () => {
        showCodePreviewModal(doc, lang, sourceContent);
      },
    );
    enlargeBtn.style.marginLeft = "auto";
    enlargeBtn.style.color = "var(--highlight-primary)";

    tbar.appendChild(copyBtn);
    tbar.appendChild(ctxBtn);
    tbar.appendChild(enlargeBtn);

    // Preview content area
    const previewArea = doc.createElementNS(RAG_HTML_NS, "div") as HTMLElement;
    previewArea.style.cssText = "flex: 1; overflow: auto; min-height: 100px;";

    if (lang === "html" || lang === "svg" || lang === "xml") {
      const iframe = doc.createElementNS(
        RAG_HTML_NS,
        "iframe",
      ) as HTMLIFrameElement;
      iframe.style.cssText = "width: 100%; height: 100%; border: none;";
      iframe.srcdoc = sourceContent;
      previewArea.appendChild(iframe);
    } else if (lang === "markdown") {
      const inner = doc.createElementNS(RAG_HTML_NS, "div") as HTMLElement;
      inner.innerHTML = parseMarkdown(sourceContent);
      Object.assign(inner.style, {
        padding: "8px",
        fontSize: "13px",
        lineHeight: "1.5",
        color: "var(--text-primary)",
      });
      const style = doc.createElementNS(RAG_HTML_NS, "style") as HTMLElement;
      style.textContent = `
        h1,h2,h3,h4,h5,h6{color:var(--text-primary);margin:0.4em 0}
        h1{font-size:1.4em} h2{font-size:1.2em} h3{font-size:1.1em}
        p{margin:0.4em 0;color:var(--text-primary)}
        a{color:var(--highlight-primary,#0066cc)}
        code{background:var(--fill-quaternary,rgba(0,0,0,0.06));padding:1px 4px;border-radius:3px;font-size:0.9em}
        pre{background:var(--fill-quaternary,rgba(0,0,0,0.06));padding:6px;border-radius:4px;overflow-x:auto}
        pre code{color:inherit}
        blockquote{border-left:3px solid var(--border-secondary);margin:0.4em 0;padding:4px 12px}
        table{border-collapse:collapse;width:100%;margin:0.4em 0}
        th,td{border:1px solid var(--border-secondary);padding:4px 8px;text-align:left}
        ul,ol{padding-left:1.5em;margin:0.4em 0}
        img{max-width:100%}
      `;
      inner.insertBefore(style, inner.firstChild);
      previewArea.appendChild(inner);
    } else {
      previewArea.textContent = "Preview not available for this language";
      Object.assign(previewArea.style, {
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        color: "var(--text-tertiary)",
        fontSize: "13px",
      });
    }

    split.appendChild(tbar);
    split.appendChild(previewArea);

    // ── Resize handle ───────────────────────────────────────────
    const handle = doc.createElementNS(RAG_HTML_NS, "div") as HTMLElement;
    handle.className = "code-preview-handle";
    handle.style.cssText =
      "height: 5px; cursor: ns-resize; flex-shrink: 0; background: transparent; position: relative; z-index: 1;";
    const line = doc.createElementNS(RAG_HTML_NS, "div") as HTMLElement;
    line.style.cssText =
      "height: 1px; background: var(--border-primary); margin: 2px 4px; border-radius: 1px; pointer-events: none;";
    handle.appendChild(line);

    handle.addEventListener("mousedown", (md: MouseEvent) => {
      md.preventDefault();
      const startY = md.clientY;
      const startPre = pre ? pre.offsetHeight : 0;
      const total = wrapper.offsetHeight;

      const onMove = (mm: MouseEvent) => {
        const dy = mm.clientY - startY;
        const newPreHeight = Math.max(60, Math.min(total - 60, startPre + dy));
        if (pre) {
          pre.style.flex = "none";
          pre.style.height = `${newPreHeight}px`;
        }
        split.style.flex = "1";
      };
      const onUp = () => {
        doc.removeEventListener("mousemove", onMove);
        doc.removeEventListener("mouseup", onUp);
      };
      doc.addEventListener("mousemove", onMove);
      doc.addEventListener("mouseup", onUp);
    });

    // ── Convert wrapper to horizontal (top/bottom) split ────────
    const wrapperHeight = wrapper.offsetHeight;
    wrapper.style.display = "flex";
    wrapper.style.flexDirection = "column";
    wrapper.style.gap = "0";
    wrapper.style.height = `${wrapperHeight}px`;
    if (pre) {
      pre.style.flex = "1 1 0";
      pre.style.minHeight = "0";
    }
    // Order: split (preview) → handle (resize) → pre (code)
    wrapper.insertBefore(split, pre || null);
    wrapper.insertBefore(handle, pre || null);
    wrapper.scrollIntoView({ block: "nearest" });
  });
}

function showCodePreviewModal(
  doc: Document,
  lang: string,
  content: string,
): void {
  let isExpanded = false;

  const backdrop = doc.createElementNS(RAG_HTML_NS, "div") as HTMLElement;
  Object.assign(backdrop.style, {
    position: "fixed",
    inset: "0",
    zIndex: "99999",
    background: "rgba(0,0,0,0.5)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  });

  const container = doc.createElementNS(RAG_HTML_NS, "div") as HTMLElement;
  const containerDefaults = () => ({
    position: "relative" as const,
    background: "var(--background-primary)",
    borderRadius: "8px",
    boxShadow: "0 8px 32px rgba(0,0,0,0.2)",
    width: isExpanded ? "98vw" : "90vw",
    height: isExpanded ? "95vh" : "85vh",
    display: "flex",
    flexDirection: "column" as const,
    overflow: "hidden",
    transition: "width 0.2s, height 0.2s",
  });
  Object.assign(container.style, containerDefaults());

  // ── Header row ──────────────────────────────────────────────
  const header = doc.createElementNS(RAG_HTML_NS, "div") as HTMLElement;
  Object.assign(header.style, {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "6px 12px",
    borderBottom: "1px solid var(--border-primary)",
    flexShrink: "0",
  });

  const title = doc.createElementNS(RAG_HTML_NS, "span") as HTMLElement;
  title.textContent = lang.toUpperCase();
  Object.assign(title.style, {
    fontWeight: "600",
    fontSize: "12px",
    textTransform: "uppercase",
    color: "var(--text-primary)",
  });

  const closeBtn = doc.createElementNS(
    RAG_HTML_NS,
    "button",
  ) as HTMLButtonElement;
  closeBtn.textContent = "\u2715";
  closeBtn.title = "Close preview";
  Object.assign(closeBtn.style, {
    background: "none",
    border: "none",
    fontSize: "16px",
    cursor: "pointer",
    color: "var(--text-secondary)",
    padding: "2px 6px",
    borderRadius: "4px",
  });

  header.appendChild(title);
  header.appendChild(closeBtn);

  // ── Toolbar ─────────────────────────────────────────────────
  const toolbar = doc.createElementNS(RAG_HTML_NS, "div") as HTMLElement;
  Object.assign(toolbar.style, {
    display: "flex",
    alignItems: "center",
    gap: "4px",
    padding: "4px 12px",
    borderBottom: "1px solid var(--border-primary)",
    flexShrink: "0",
  });

  function toolBtn(
    text: string,
    title: string,
    handler: () => void,
  ): HTMLButtonElement {
    const b = doc.createElementNS(RAG_HTML_NS, "button") as HTMLButtonElement;
    b.textContent = text;
    b.title = title;
    Object.assign(b.style, {
      padding: "3px 8px",
      borderRadius: "4px",
      border: "1px solid var(--border-primary)",
      background: "transparent",
      color: "var(--text-secondary)",
      cursor: "pointer",
      fontSize: "11px",
      lineHeight: "1.3",
      transition: "background 0.1s",
    });
    b.addEventListener("mouseenter", () => {
      b.style.background = "var(--background-secondary)";
    });
    b.addEventListener("mouseleave", () => {
      b.style.background = "transparent";
    });
    b.addEventListener("click", (e: Event) => {
      e.stopPropagation();
      handler();
    });
    return b;
  }

  // Copy button
  const copyBtn = toolBtn("\uD83D\uDCCC Copy", "Copy code content", () => {
    try {
      new ztoolkit.Clipboard().addText(content, "text/unicode").copy();
      copyBtn.textContent = "\u2713 Copied";
      setTimeout(() => {
        copyBtn.textContent = "\uD83D\uDCCC Copy";
      }, 1500);
    } catch (e) {
      copyBtn.textContent = "\u274C Failed";
      setTimeout(() => {
        copyBtn.textContent = "\uD83D\uDCCC Copy";
      }, 1500);
    }
  });

  // Add to Context button
  const ctxBtn = toolBtn(
    "\uD83D\uDCCB Add to Context",
    "Add to chat context",
    () => {
      try {
        const cm = ChatContextManager.getInstance();
        cm.addItem(
          `code-preview-${Date.now()}`,
          "file",
          `${lang.toUpperCase()} code block`,
          "toolbar",
          { text: content, mimeType: `text/${lang}` },
        );
        ctxBtn.textContent = "\u2713 Added";
        setTimeout(() => {
          ctxBtn.textContent = "\uD83D\uDCCB Add to Context";
        }, 1500);
      } catch (e) {
        Zotero.debug(`[seerai] Error adding code to context: ${e}`);
        ctxBtn.textContent = "\u274C Error";
        setTimeout(() => {
          ctxBtn.textContent = "\uD83D\uDCCB Add to Context";
        }, 1500);
      }
    },
  );

  // Expand button
  const expandBtn = toolBtn("\u26F6 Expand", "Expand to full window", () => {
    isExpanded = !isExpanded;
    Object.assign(container.style, containerDefaults());
    expandBtn.textContent = isExpanded ? "\u26F6 Collapse" : "\u26F6 Expand";
    expandBtn.title = isExpanded
      ? "Collapse to normal size"
      : "Expand to full window";
  });
  expandBtn.style.marginLeft = "auto";

  toolbar.appendChild(copyBtn);
  toolbar.appendChild(ctxBtn);
  toolbar.appendChild(expandBtn);

  // ── Content area ────────────────────────────────────────────
  const contentArea = doc.createElementNS(RAG_HTML_NS, "div") as HTMLElement;
  Object.assign(contentArea.style, {
    flex: "1",
    overflow: "auto",
    minHeight: "0",
    display: "flex",
    flexDirection: "column",
  });

  if (lang === "html" || lang === "svg" || lang === "xml") {
    const iframe = doc.createElementNS(
      RAG_HTML_NS,
      "iframe",
    ) as HTMLIFrameElement;
    Object.assign(iframe.style, {
      width: "100%",
      flex: "1 1 0",
      minHeight: "0",
      border: "none",
    });
    iframe.srcdoc = content;
    contentArea.appendChild(iframe);
  } else if (lang === "markdown") {
    const inner = doc.createElementNS(RAG_HTML_NS, "div") as HTMLElement;
    inner.innerHTML = parseMarkdown(content);
    Object.assign(inner.style, {
      padding: "16px",
      fontSize: "14px",
      lineHeight: "1.6",
      color: "var(--text-primary)",
    });
    const style = doc.createElementNS(RAG_HTML_NS, "style") as HTMLElement;
    style.textContent = `
      h1,h2,h3,h4,h5,h6{color:var(--text-primary);margin:0.5em 0}
      h1{font-size:1.5em} h2{font-size:1.3em} h3{font-size:1.15em}
      p{margin:0.5em 0;color:var(--text-primary)}
      a{color:var(--highlight-primary,#0066cc)}
      code{background:var(--fill-quaternary,rgba(0,0,0,0.06));padding:1px 4px;border-radius:3px;font-size:0.9em}
      pre{background:var(--fill-quaternary,rgba(0,0,0,0.06));padding:8px;border-radius:4px;overflow-x:auto}
      pre code{background:none;padding:0;color:inherit}
      blockquote{border-left:3px solid var(--border-secondary);margin:0.5em 0;padding:4px 12px;color:var(--text-secondary)}
      table{border-collapse:collapse;width:100%;margin:0.5em 0}
      th,td{border:1px solid var(--border-secondary);padding:6px 10px;text-align:left}
      th{background:var(--fill-quaternary,rgba(0,0,0,0.04));font-weight:600}
      ul,ol{padding-left:1.5em;margin:0.5em 0}
      li{margin:0.25em 0}
      hr{border:none;border-top:1px solid var(--border-secondary);margin:1em 0}
      img{max-width:100%}
    `;
    inner.insertBefore(style, inner.firstChild);
    contentArea.appendChild(inner);
  } else {
    contentArea.textContent = "Preview not available for this language";
    Object.assign(contentArea.style, {
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      color: "var(--text-tertiary)",
      fontSize: "14px",
    });
  }

  // ── Assemble ────────────────────────────────────────────────
  container.appendChild(header);
  container.appendChild(toolbar);
  container.appendChild(contentArea);
  backdrop.appendChild(container);

  const cleanup = () => backdrop.remove();
  backdrop.addEventListener("click", (e: Event) => {
    if (e.target === backdrop) cleanup();
  });
  closeBtn.addEventListener("click", cleanup);

  const root = doc.body || doc.documentElement;
  if (root) root.appendChild(backdrop);
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
