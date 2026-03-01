/**
 * Message rendering utilities for chat UI
 * Extracted from assistant.ts for better modularity
 */

import { ChatMessage } from "../types";
import { parseMarkdown } from "../markdown";
import { openAIService } from "../../openai";
import { getActiveModelConfig } from "../modelConfig";

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
