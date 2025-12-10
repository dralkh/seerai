/**
 * Message rendering utilities for chat UI
 * Extracted from assistant.ts for better modularity
 */

import { ChatMessage } from "../types";
import { parseMarkdown } from "../markdown";

/**
 * Message colors configuration
 */
export const messageColors = {
    user: { bg: "#e3f2fd", text: "#1976d2" },
    assistant: { bg: "#f5f5f5", text: "#424242" },
    error: { bg: "#ffebee", text: "#c62828" }
};

/**
 * Create action button for message actions (copy, edit, retry)
 */
export function createActionButton(
    doc: Document,
    icon: string,
    tooltip: string,
    onClick: () => void
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
        opacity: "0.7"
    });
    btn.addEventListener("mouseover", () => { btn.style.opacity = "1"; });
    btn.addEventListener("mouseout", () => { btn.style.opacity = "0.7"; });
    btn.addEventListener("click", onClick);
    return btn;
}

/**
 * Copy text to clipboard and show feedback
 */
export function copyToClipboard(text: string, button: HTMLElement): void {
    const originalText = button.innerText;

    if (navigator.clipboard) {
        navigator.clipboard.writeText(text).then(() => {
            button.innerText = "✓";
            setTimeout(() => { button.innerText = originalText; }, 2000);
        }).catch(() => {
            button.innerText = "❌";
            setTimeout(() => { button.innerText = originalText; }, 2000);
        });
    } else {
        // Fallback for environments without clipboard API
        button.innerText = "❌";
        setTimeout(() => { button.innerText = originalText; }, 2000);
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
    }
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
        maxWidth: "90%",
        alignSelf: isUser ? "flex-end" : "flex-start",
        color: textColor,
        boxShadow: "0 1px 2px rgba(0,0,0,0.1)",
        position: "relative"
    });

    // Header with sender and actions
    const headerDiv = doc.createElement("div");
    Object.assign(headerDiv.style, {
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        marginBottom: "4px"
    });

    const senderDiv = doc.createElement("span");
    Object.assign(senderDiv.style, { fontWeight: "600", fontSize: "11px", opacity: "0.8" });
    senderDiv.innerText = sender;

    // Action buttons container
    const actionsDiv = doc.createElement("div");
    Object.assign(actionsDiv.style, {
        display: "flex",
        gap: "4px",
        opacity: "0.6"
    });

    // Copy button (for all messages)
    const copyBtn = createActionButton(doc, "📋", "Copy", () => {
        copyToClipboard(text, copyBtn);
    });
    actionsDiv.appendChild(copyBtn);

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
    Object.assign(contentDiv.style, { lineHeight: "1.5" });
    contentDiv.innerHTML = parseMarkdown(text);

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
    }
): HTMLElement {
    const doc = container.ownerDocument!;
    const isUser = msg.role === 'user';
    const colors = isUser ? messageColors.user :
        (msg.role === 'error' ? messageColors.error : messageColors.assistant);
    const sender = isUser ? "You" : (msg.role === 'error' ? "Error" : "Assistant");

    const msgDiv = createMessageBubble(
        doc,
        sender,
        msg.content,
        colors.bg,
        colors.text,
        msg.id,
        { isLastUserMsg, ...options }
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
    }
): HTMLElement {
    const doc = container.ownerDocument!;
    const msgDiv = createMessageBubble(doc, sender, text, bgColor, textColor, msgId, options);
    container.appendChild(msgDiv);
    container.scrollTop = container.scrollHeight;
    return msgDiv;
}
