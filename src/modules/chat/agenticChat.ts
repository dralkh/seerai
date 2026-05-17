/**
 * Agentic Chat Handler
 * Manages the agentic chat loop with tool calling support
 *
 * @see agentic.md Section 2.1 - ARTIST Framework (Reasoning-Action loops)
 * @see agentic.md Section 7.1 - Observability and Tracing
 */

import {
  OpenAIMessage,
  AnyOpenAIMessage,
  VisionMessage,
  VisionMessageContentPart,
  ToolCall,
  ToolCallMessage,
  ToolResultMessage,
  ToolDefinition,
  openAIService,
  createProvider,
  type AgentQuery,
  type ProviderEvent,
} from "../openai";
import {
  getFilteredAgentTools,
  executeToolCall,
  formatToolResult,
  getAgentConfigFromPrefs,
  AgentConfig,
  ToolResult,
  TOOL_NAMES,
} from "./tools";
import { ChatMessage } from "./types";
import { parseMarkdown } from "./markdown";
import { getActiveModelConfig } from "./modelConfig";
import { agentTracer } from "./tracer";
import { ChatStateManager } from "./stateManager";
import { getWorkspaceStore } from "./workspace/store";

const HTML_NS = "http://www.w3.org/1999/xhtml";

interface CompactionState {
  count: number;
  lastCompactAt: number;
}

async function archiveTranscript(
  messages: AnyOpenAIMessage[],
): Promise<string | null> {
  try {
    const store = getWorkspaceStore();
    const timestamp = new Date()
      .toISOString()
      .replace(/[:.]/g, "-")
      .slice(0, 19);
    const slug = `compact-${timestamp}`;
    const archivePath = `.conversations/${slug}.md`;

    const lines = messages
      .map((m) => {
        const role = m.role || "unknown";
        const content =
          typeof m.content === "string" ? m.content : JSON.stringify(m.content);
        return `## [${role}]\n\n${content}`;
      })
      .join("\n\n---\n\n");

    const header = [
      `# Archived Transcript`,
      ``,
      `**Archived at:** ${new Date().toISOString()}`,
      `**Messages:** ${messages.length}`,
      ``,
      `---`,
      ``,
    ].join("\n");

    await store.writeFile(
      archivePath,
      header + lines,
      `Archive transcript ${slug}`,
      "system",
    );
    Zotero.debug(`[seerai] Archived transcript to ${archivePath}`);
    return archivePath;
  } catch (e) {
    Zotero.debug(`[seerai] Failed to archive transcript: ${e}`);
    return null;
  }
}

async function hasIncompleteTodos(): Promise<boolean> {
  try {
    const store = getWorkspaceStore();
    const file = await store.readFile(".agent/TODO.json");
    if (file?.content) {
      const todos = JSON.parse(file.content);
      if (Array.isArray(todos)) {
        return todos.some(
          (t: { status: string }) =>
            t.status === "pending" || t.status === "in_progress",
        );
      }
    }
  } catch {
    // No TODOs
  }
  return false;
}

/**
 * Summarize conversation for context compaction.
 * Uses a non-streaming call to avoid interfering with the main stream.
 */
async function summarizeConversation(
  messagesToSummarize: AnyOpenAIMessage[],
): Promise<string> {
  const prompt = [
    {
      role: "system" as const,
      content:
        "You are a summarization assistant. Your task is to condense a conversation into a detailed but concise summary. " +
        "Focus on: 1) what the user originally asked for, 2) what has been completed so far (with specific results), " +
        "3) the current state of any TODO list, 4) what remains to be done next. " +
        "Preserve key facts: paper titles, DOIs, item IDs, collection names, table names, and other identifiers.",
    },
    {
      role: "user" as const,
      content:
        "Please summarize the following conversation. Include all important details and identifiers:\n\n" +
        messagesToSummarize
          .map((m) => {
            const role = m.role || "unknown";
            const content =
              typeof m.content === "string"
                ? m.content
                : JSON.stringify(m.content);
            return `[${role}]: ${content}`;
          })
          .join("\n\n"),
    },
  ];

  try {
    const result = await openAIService.chatCompletion(prompt);
    return result || "(summary unavailable)";
  } catch (e) {
    Zotero.debug(`[seerai] Compaction summarization failed: ${e}`);
    return "(summary generation failed)";
  }
}

/**
 * Read current TODO state from workspace.
 */
async function readToDoState(): Promise<string> {
  try {
    const store = getWorkspaceStore();
    const file = await store.readFile(".agent/TODO.json");
    if (file?.content) {
      const todos = JSON.parse(file.content);
      if (Array.isArray(todos) && todos.length > 0) {
        const lines = todos.map(
          (t: { content: string; status: string }) =>
            `  - [${t.status}] ${t.content}`,
        );
        return `Current TODOs:\n${lines.join("\n")}`;
      }
    }
  } catch {
    // No TODOs
  }
  return "";
}

/**
 * Check if context needs compaction and perform it if needed.
 * Returns true if compaction was performed.
 */
async function maybeCompactContext(
  messages: AnyOpenAIMessage[],
  contextLength: number,
  outputBudget: number,
  compactionState: CompactionState,
  sessionId: string,
): Promise<boolean> {
  if (compactionState.count >= 3) return false;

  const totalTokens = messages.reduce((sum, m) => {
    const content =
      typeof m.content === "string" ? m.content : JSON.stringify(m.content);
    return sum + ChatStateManager.countTokens(content);
  }, 0);

  const safeLimit = contextLength - outputBudget;
  if (totalTokens < safeLimit * 0.85) return false;

  Zotero.debug(
    `[seerai] Context compaction triggered: ${totalTokens} tokens > ${safeLimit * 0.85} (85% of ${safeLimit})`,
  );

  const systemMsg = messages[0];
  const userMsg = messages.find((m) => m.role === "user") as
    | OpenAIMessage
    | undefined;

  const toSummarize = messages.slice(1);

  const archivePath = await archiveTranscript(toSummarize);

  const summary = await summarizeConversation(toSummarize);
  const todoState = await readToDoState();

  messages.length = 0;
  messages.push(systemMsg);

  const compactParts: string[] = [
    `[CONTEXT COMPACTED #${compactionState.count + 1}]`,
  ];
  if (archivePath) {
    compactParts.push(`[ARCHIVED: ${archivePath}]`);
  }
  compactParts.push(
    `Conversation summary:\n${summary}`,
    todoState,
    "Continue from where you left off. Use the summary above to understand what has been done and what remains.",
  );

  const compactBlock = compactParts.filter(Boolean).join("\n\n");

  messages.push({
    role: "system",
    content: compactBlock,
  } as OpenAIMessage);

  if (userMsg) {
    messages.push(userMsg);
  }

  compactionState.count++;
  compactionState.lastCompactAt = Date.now();
  agentTracer.logCompaction(sessionId, compactionState.count);

  Zotero.debug(
    `[seerai] Context compaction #${compactionState.count} complete`,
  );
  return true;
}

/**
 * Options for the agentic chat
 */
export interface AgenticChatOptions {
  enableTools: boolean;
  includeImages: boolean;
  pastedImages?: { id: string; image: string; mimeType: string }[];
  permissionHandler?: (
    toolCallId: string,
    toolName: string,
  ) => Promise<boolean>;
  temperature?: number;
  maxTokens?: number;
  libraryScope?: import("./tools").LibraryScope;
  continuation?: string;
}

/**
 * Create a container for tool execution process
 */
/**
 * Create a standalone interactive question panel for workspace_question.
 * Renders as a prominent card in the chat — NOT inside collapsible tool cards.
 */
export function createQuestionPanel(
  doc: Document,
  questions: any[],
): HTMLElement {
  const selections: Map<number, string[]> = new Map();

  const panel = doc.createElementNS(HTML_NS, "div") as HTMLElement;
  panel.className = "seerai-question-panel";
  panel.style.cssText = `
    margin: 12px 0;
    border: 2px solid var(--highlight-primary, #007AFF);
    border-radius: 10px;
    background: var(--background-primary, #fff);
    overflow: hidden;
    box-shadow: 0 2px 8px rgba(0,0,0,0.08);
  `;

  const banner = doc.createElementNS(HTML_NS, "div") as HTMLElement;
  banner.style.cssText = `
    padding: 10px 14px;
    background: var(--highlight-primary, #007AFF);
    color: #fff;
    font-size: 13px;
    font-weight: 600;
    display: flex;
    align-items: center;
    justify-content: space-between;
  `;
  const bannerText = doc.createElementNS(HTML_NS, "span") as HTMLElement;
  bannerText.textContent = "\u2753 Questions from Assistant";
  const stepLabel = doc.createElementNS(HTML_NS, "span") as HTMLElement;
  stepLabel.style.cssText = "font-size: 12px; font-weight: 400; opacity: 0.9;";
  banner.appendChild(bannerText);
  banner.appendChild(stepLabel);
  panel.appendChild(banner);

  // Tab indicator dots
  const tabRow = doc.createElementNS(HTML_NS, "div") as HTMLElement;
  tabRow.style.cssText = `
    display: flex;
    justify-content: center;
    gap: 8px;
    padding: 10px 14px 0;
  `;
  const tabDots: HTMLElement[] = [];
  for (let i = 0; i < questions.length; i++) {
    const dot = doc.createElementNS(HTML_NS, "button") as HTMLElement;
    dot.textContent = `${i + 1}`;
    dot.style.cssText = `
      width: 28px;
      height: 28px;
      border-radius: 50%;
      border: 1.5px solid var(--border-primary);
      background: var(--background-primary);
      color: var(--text-secondary);
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.15s;
      display: flex;
      align-items: center;
      justify-content: center;
    `;
    dot.addEventListener("click", () => {
      currentTab = i;
      renderTab();
    });
    tabRow.appendChild(dot);
    tabDots.push(dot);
  }
  panel.appendChild(tabRow);

  const body = doc.createElementNS(HTML_NS, "div") as HTMLElement;
  body.style.cssText = "padding: 12px 14px; min-height: 80px;";
  panel.appendChild(body);

  const navRow = doc.createElementNS(HTML_NS, "div") as HTMLElement;
  navRow.style.cssText = `
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 8px 14px 12px;
    gap: 8px;
    border-top: 1px solid var(--border-secondary, #e0e0e0);
  `;
  panel.appendChild(navRow);

  let currentTab = 0;

  function triggerSend() {
    const input = doc.querySelector(
      ".seerai-chat-input",
    ) as HTMLTextAreaElement | null;
    if (!input) return;

    const lines: string[] = [];
    for (let i = 0; i < questions.length; i++) {
      const q = questions[i];
      const sel = selections.get(i);
      const answer = sel && sel.length > 0 ? sel.join(", ") : "(no answer)";
      lines.push(`**${q.header}**: ${answer}`);
      lines.push(`(${q.question})`);
      lines.push("");
    }

    input.value = lines.join("\n").trim();
    input.focus();
    input.dispatchEvent(
      new (doc.defaultView as any).Event("input", { bubbles: true }),
    );

    // Trigger send via Enter keydown
    const enterEvent = new (doc.defaultView as any).KeyboardEvent("keydown", {
      key: "Enter",
      code: "Enter",
      keyCode: 13,
      which: 13,
      bubbles: true,
      cancelable: true,
    });
    input.dispatchEvent(enterEvent);
  }

  function renderTab() {
    body.innerHTML = "";
    navRow.innerHTML = "";

    // Update step label
    stepLabel.textContent = `${currentTab + 1} of ${questions.length}`;

    // Update tab dots
    tabDots.forEach((dot, i) => {
      if (i === currentTab) {
        dot.style.background = "var(--highlight-primary)";
        dot.style.color = "#fff";
        dot.style.borderColor = "var(--highlight-primary)";
      } else if (selections.has(i) && selections.get(i)!.length > 0) {
        dot.style.background = "var(--accent-green, #34C759)";
        dot.style.color = "#fff";
        dot.style.borderColor = "var(--accent-green, #34C759)";
      } else {
        dot.style.background = "var(--background-primary)";
        dot.style.color = "var(--text-secondary)";
        dot.style.borderColor = "var(--border-primary)";
      }
    });

    const q = questions[currentTab];

    const qHeader = doc.createElementNS(HTML_NS, "div") as HTMLElement;
    qHeader.style.cssText =
      "font-size: 13px; font-weight: 600; color: var(--text-primary); margin-bottom: 4px;";
    qHeader.textContent = q.header || "";
    body.appendChild(qHeader);

    const qText = doc.createElementNS(HTML_NS, "div") as HTMLElement;
    qText.style.cssText =
      "font-size: 12px; color: var(--text-secondary); margin-bottom: 10px; line-height: 1.4;";
    qText.textContent = q.question || "";
    body.appendChild(qText);

    if (q.options && Array.isArray(q.options) && q.options.length > 0) {
      const optsContainer = doc.createElementNS(HTML_NS, "div") as HTMLElement;
      optsContainer.style.cssText =
        "display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 4px;";

      const prevSelection = selections.get(currentTab) || [];

      for (const opt of q.options) {
        const optBtn = doc.createElementNS(HTML_NS, "button") as HTMLElement;
        optBtn.textContent = opt.label;
        optBtn.style.cssText = `
          padding: 5px 12px;
          font-size: 12px;
          border: 1.5px solid var(--border-primary);
          border-radius: 16px;
          background: var(--background-primary);
          color: var(--text-primary);
          cursor: pointer;
          transition: all 0.15s;
        `;
        if (opt.description) {
          optBtn.title = opt.description;
        }
        if (prevSelection.includes(opt.label)) {
          optBtn.style.background = "var(--highlight-primary)";
          optBtn.style.color = "#fff";
          optBtn.style.borderColor = "var(--highlight-primary)";
        }
        optBtn.addEventListener("click", () => {
          const cur = selections.get(currentTab) || [];
          if (q.multiple) {
            const idx = cur.indexOf(opt.label);
            if (idx >= 0) {
              cur.splice(idx, 1);
              optBtn.style.background = "var(--background-primary)";
              optBtn.style.color = "var(--text-primary)";
              optBtn.style.borderColor = "var(--border-primary)";
            } else {
              cur.push(opt.label);
              optBtn.style.background = "var(--highlight-primary)";
              optBtn.style.color = "#fff";
              optBtn.style.borderColor = "var(--highlight-primary)";
            }
          } else {
            cur.length = 0;
            cur.push(opt.label);
            optsContainer.querySelectorAll("button").forEach((s: Element) => {
              const btn = s as HTMLElement;
              btn.style.background = "var(--background-primary)";
              btn.style.color = "var(--text-primary)";
              btn.style.borderColor = "var(--border-primary)";
            });
            optBtn.style.background = "var(--highlight-primary)";
            optBtn.style.color = "#fff";
            optBtn.style.borderColor = "var(--highlight-primary)";
          }
          selections.set(currentTab, cur.length > 0 ? cur : []);
          renderTab();
        });
        optsContainer.appendChild(optBtn);
      }
      body.appendChild(optsContainer);
    }

    // Navigation buttons
    if (currentTab > 0) {
      const backBtn = doc.createElementNS(HTML_NS, "button") as HTMLElement;
      backBtn.textContent = "\u2190 Back";
      backBtn.style.cssText = `
        padding: 6px 14px;
        font-size: 12px;
        border: 1px solid var(--border-primary);
        border-radius: 6px;
        background: var(--background-primary);
        color: var(--text-primary);
        cursor: pointer;
      `;
      backBtn.addEventListener("click", () => {
        currentTab--;
        renderTab();
      });
      navRow.appendChild(backBtn);
    } else {
      navRow.appendChild(doc.createElementNS(HTML_NS, "span") as HTMLElement);
    }

    if (currentTab < questions.length - 1) {
      const continueBtn = doc.createElementNS(HTML_NS, "button") as HTMLElement;
      continueBtn.textContent = "Continue \u2192";
      continueBtn.style.cssText = `
        padding: 6px 16px;
        font-size: 12px;
        font-weight: 600;
        border: none;
        border-radius: 6px;
        background: var(--highlight-primary);
        color: #fff;
        cursor: pointer;
      `;
      continueBtn.addEventListener("click", () => {
        currentTab++;
        renderTab();
      });
      // Allow Enter to advance
      continueBtn.addEventListener("keydown", (e: KeyboardEvent) => {
        if (e.key === "Enter") {
          currentTab++;
          renderTab();
        }
      });
      navRow.appendChild(continueBtn);
    } else {
      const completeBtn = doc.createElementNS(HTML_NS, "button") as HTMLElement;
      completeBtn.textContent = "\u2713 Complete";
      completeBtn.style.cssText = `
        padding: 6px 16px;
        font-size: 12px;
        font-weight: 600;
        border: none;
        border-radius: 6px;
        background: var(--accent-green, #34C759);
        color: #fff;
        cursor: pointer;
      `;
      completeBtn.addEventListener("click", () => {
        triggerSend();
      });
      navRow.appendChild(completeBtn);
    }
  }

  renderTab();
  return panel;
}

export function createToolProcessUI(doc: Document): {
  container: HTMLElement;
  setThinking: () => void;
  setExecutingTool: (toolName: string) => void;
  setCompleted: (count: number, toolCount?: number) => void;
  updateProgress: (count: number, toolCount?: number) => void;
  setFailed: (error: string) => void;
  updateStats: (stats: {
    turns: number;
    totalTools: number;
    estimatedTokens: number;
    completedTodos: number;
    totalTodos: number;
    lastToolName: string;
    lastToolSummary: string;
    isThinking: boolean;
  }) => void;
} {
  const details = doc.createElementNS(HTML_NS, "details") as HTMLDetailsElement;
  details.className = "tool-process-container";

  // Initially hidden (collapsed)
  details.open = false;

  details.style.cssText = `
        margin: 8px 0;
        border: 1px solid var(--border-secondary, #e0e0e0);
        border-radius: 8px;
        background: var(--background-primary, #fff);
        overflow: hidden;
        box-shadow: 0 1px 2px rgba(0,0,0,0.05);
        min-width: 0;
        max-width: 100%;
        box-sizing: border-box;
    `;

  const summary = doc.createElementNS(HTML_NS, "summary") as HTMLElement;
  summary.style.cssText = `
        padding: 8px 12px;
        cursor: pointer;
        display: flex;
        align-items: center;
        gap: 8px;
        font-size: 13px;
        font-weight: 500;
        color: var(--text-secondary, #666);
        list-style: none;
        user-select: none;
        transition: background 0.2s;
    `;

  // Hover effect
  summary.onmouseover = () => {
    summary.style.background = "var(--fill-quinary, rgba(0,0,0,0.02))";
  };
  summary.onmouseout = () => {
    summary.style.background = "transparent";
  };

  // Icon
  const icon = doc.createElementNS(HTML_NS, "span") as HTMLElement;
  icon.textContent = "🧠"; // Brain icon for process
  icon.style.filter = "grayscale(100%) opacity(0.7)";
  summary.appendChild(icon);

  // Text Label
  const label = doc.createElementNS(HTML_NS, "span") as HTMLElement;
  label.textContent = "Thinking...";
  label.style.flex = "1";
  summary.appendChild(label);

  // Expand All Button
  const expandBtn = doc.createElementNS(HTML_NS, "span") as HTMLElement;
  expandBtn.textContent = "⤢"; // Open symbol
  expandBtn.title = "Expand All Steps";
  expandBtn.style.cssText = `
        padding: 2px 6px;
        margin-right: 8px;
        border-radius: 4px;
        font-size: 14px;
        color: var(--text-tertiary, #999);
        cursor: pointer;
        opacity: 0.7;
    `;
  expandBtn.onmouseover = () => {
    expandBtn.style.backgroundColor = "var(--fill-quaternary, rgba(0,0,0,0.1))";
  };
  expandBtn.onmouseout = () => {
    expandBtn.style.backgroundColor = "transparent";
  };

  expandBtn.onclick = (e) => {
    e.preventDefault();
    e.stopPropagation();

    // Open parent
    details.open = true;

    // Open all children
    const childDetails = details.querySelectorAll(
      "details.tool-execution-card",
    );
    childDetails.forEach((cd: Element) => {
      (cd as HTMLDetailsElement).open = true;
    });
  };
  summary.appendChild(expandBtn);

  // Chevron
  const chevron = doc.createElementNS(HTML_NS, "span") as HTMLElement;
  chevron.innerHTML = `<svg width="10" height="6" viewBox="0 0 10 6" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M1 1L5 5L9 1" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  chevron.style.color = "var(--text-tertiary, #999)";
  chevron.style.transition = "transform 0.2s ease";
  chevron.style.transform = "rotate(-90deg)"; // Initial closed state
  summary.appendChild(chevron);

  details.addEventListener("toggle", () => {
    chevron.style.transform = details.open ? "rotate(0deg)" : "rotate(-90deg)";
  });

  details.appendChild(summary);

  const statsBar = doc.createElementNS(HTML_NS, "div") as HTMLElement;
  statsBar.className = "agent-stats-bar";
  statsBar.style.cssText = `
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px 12px;
    padding: 4px 12px;
    font-size: 11px;
    color: var(--text-tertiary, #999);
    border-bottom: 1px solid var(--border-secondary, #e0e0e0);
    line-height: 1.4;
  `;

  const statsTurns = doc.createElementNS(HTML_NS, "span") as HTMLElement;
  const statsTools = doc.createElementNS(HTML_NS, "span") as HTMLElement;
  const statsTokens = doc.createElementNS(HTML_NS, "span") as HTMLElement;
  const statsTodos = doc.createElementNS(HTML_NS, "span") as HTMLElement;
  const statsLast = doc.createElementNS(HTML_NS, "span") as HTMLElement;

  statsBar.appendChild(statsTurns);
  statsBar.appendChild(statsTools);
  statsBar.appendChild(statsTokens);
  statsBar.appendChild(statsTodos);
  statsBar.appendChild(statsLast);
  details.appendChild(statsBar);

  // Container for card list
  const listContainer = doc.createElementNS(HTML_NS, "div") as HTMLElement;
  listContainer.className = "tool-list-container";
  listContainer.style.cssText = `
        display: flex;
        flex-direction: column;
        gap: 6px;
        padding: 8px;
        background: var(--fill-quinary, rgba(0,0,0,0.02));
        border-top: 1px solid var(--border-secondary, #e0e0e0);
    `;
  details.appendChild(listContainer);

  // State helpers
  const setThinking = () => {
    label.textContent = "Processing task...";
    icon.textContent = "⚡";
    icon.style.animation = "pulse 1.5s infinite";
    // Only close if we haven't started any tools yet
    if (!listContainer.firstChild) {
      details.open = false;
    }
    // Force open if user explicitly keeps it open should be handled by caller persistence
  };

  const setExecutingTool = (toolName: string) => {
    const displayName = toolName.replace(/_/g, " ");
    label.textContent = `Calling ${displayName}...`;
    icon.textContent = "🔧";
    icon.style.filter = "none";
    icon.style.animation = "pulse 1s infinite";
    // Do NOT force open here
    // BUT user often wants to see new tools.
    // Letting persistence handle this in assistant.ts is better.
    // details.open = true;
  };

  const setCompleted = (count: number, toolCount?: number) => {
    if (toolCount !== undefined && toolCount !== count) {
      label.textContent = `Completed ${toolCount} action${toolCount !== 1 ? "s" : ""} in ${count} turn${count !== 1 ? "s" : ""}`;
    } else {
      label.textContent = `Completed ${count} analysis turn${count !== 1 ? "s" : ""}`;
    }
    icon.textContent = "✓";
    icon.style.filter = "none";
    icon.style.color = "var(--accent-green, #34C759)";
    icon.style.animation = "none";
    // Keep current open state
  };

  const updateProgress = (count: number, toolCount?: number) => {
    if (toolCount !== undefined && toolCount !== count) {
      label.textContent = `Processing ${toolCount} action${toolCount !== 1 ? "s" : ""} in ${count} turn${count !== 1 ? "s" : ""}`;
    } else {
      label.textContent = `Processing ${count} analysis turn${count !== 1 ? "s" : ""}`;
    }
    // Keep executing icon or completed icon?
    // If updating progress, it means we are running but maybe not currently executing a tool (e.g. between turns)
    icon.textContent = "⚡";
    icon.style.filter = "none";
    icon.style.color = "var(--text-secondary)"; // Neutral color
    icon.style.animation = "pulse 2s infinite";
  };

  const setFailed = (error: string) => {
    label.textContent = `Failed: ${error}`;
    label.style.color = "var(--accent-red, #FF3B30)";
    icon.textContent = "✗";
    icon.style.filter = "none";
    icon.style.color = "var(--accent-red, #FF3B30)";
    icon.style.animation = "none";
    details.open = true; // Auto-expand on failure
  };

  const updateStats = (stats: {
    turns: number;
    totalTools: number;
    estimatedTokens: number;
    completedTodos: number;
    totalTodos: number;
    lastToolName: string;
    lastToolSummary: string;
    isThinking: boolean;
  }) => {
    const maxIterations =
      getAgentConfigFromPrefs().maxAgentIterations || Infinity;
    const maxLabel =
      maxIterations === Infinity ? "\u221E" : String(maxIterations);

    statsTurns.textContent = `Turns: ${stats.turns}/${maxLabel}`;

    statsTools.textContent = `Tools: ${stats.totalTools}`;

    if (stats.estimatedTokens >= 1000) {
      statsTokens.textContent = `Tokens: ~${(stats.estimatedTokens / 1000).toFixed(1)}K`;
    } else {
      statsTokens.textContent = `Tokens: ~${stats.estimatedTokens}`;
    }

    if (stats.totalTodos > 0) {
      statsTodos.textContent = `TODOs: ${stats.completedTodos}/${stats.totalTodos}`;
      statsTodos.style.display = "";
    } else {
      statsTodos.style.display = "none";
    }

    if (stats.lastToolName) {
      const displayName = stats.lastToolName.replace(/_/g, " ");
      const summary = stats.lastToolSummary
        ? ` \u2192 ${stats.lastToolSummary}`
        : "";
      statsLast.textContent = `Last: ${displayName}${summary}`;
      statsLast.style.display = "";
    } else {
      statsLast.style.display = "none";
    }

    if (stats.isThinking) {
      statsLast.textContent = "Status: thinking";
      statsLast.style.display = "";
    }
  };

  return {
    container: details,
    setThinking,
    setExecutingTool,
    setCompleted,
    updateProgress,
    setFailed,
    updateStats,
  };
}

/**
 * Create a tool execution UI element
 */
export function createToolExecutionUI(
  doc: Document,
  toolCall: ToolCall,
  result?: ToolResult,
): HTMLElement {
  const details = doc.createElementNS(HTML_NS, "details") as HTMLDetailsElement;
  details.className = "tool-execution-card";
  details.setAttribute("data-tool-id", toolCall.id);

  // Auto-expand if it failed, or if it's an interactive workspace_question
  if (result && !result.success) {
    details.open = true;
  }
  if (
    result &&
    result.success &&
    toolCall.function.name === "workspace_question"
  ) {
    details.open = true;
  }

  details.style.cssText = `
        border: 1px solid var(--border-secondary, #e0e0e0);
        border-radius: 6px;
        background: var(--background-primary, #fff);
        overflow: hidden;
        min-width: 0;
        max-width: 100%;
        box-sizing: border-box;
    `;

  // Summary (Header)
  const summary = doc.createElementNS(HTML_NS, "summary") as HTMLElement;
  summary.style.cssText = `
        padding: 6px 10px;
        cursor: pointer;
        display: flex;
        align-items: center;
        gap: 8px;
        font-size: 12px;
        font-weight: 500;
        color: var(--text-primary);
        list-style: none; /* Hide default triangle */
        user-select: none;
        background: var(--fill-quinary, rgba(0, 0, 0, 0.02));
        transition: background 0.15s;
    `;

  summary.onmouseover = () => {
    summary.style.background = "var(--fill-quaternary, rgba(0,0,0,0.05))";
  };
  summary.onmouseout = () => {
    summary.style.background = "var(--fill-quinary, rgba(0,0,0,0.02))";
  };

  // Status Icon
  const statusSpan = doc.createElementNS(HTML_NS, "span") as HTMLElement;
  statusSpan.style.display = "flex";
  statusSpan.style.alignItems = "center";
  statusSpan.style.justifyContent = "center";
  statusSpan.style.width = "14px";

  if (!result) {
    statusSpan.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" class="spin" xmlns="http://www.w3.org/2000/svg"><path d="M12 22C17.5228 22 22 17.5228 22 12C22 6.47715 17.5228 2 12 2C6.47715 2 2 6.47715 2 12C2 17.5228 6.47715 22 12 22Z" stroke="var(--accent-blue, #007AFF)" stroke-width="3" stroke-linecap="round" stroke-dasharray="60" stroke-dashoffset="20"></path></svg>`;
    // Add rotation animation style is expected to be global or inline
  } else if (result.success) {
    statusSpan.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M20 6L9 17L4 12" stroke="var(--accent-green, #34C759)" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  } else {
    statusSpan.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M18 6L6 18M6 6L18 18" stroke="var(--accent-red, #FF3B30)" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  }
  summary.appendChild(statusSpan);

  // Tool Name
  const nameSpan = doc.createElementNS(HTML_NS, "span") as HTMLElement;
  nameSpan.textContent = toolCall.function.name.replace(/_/g, " ");
  nameSpan.style.textTransform = "capitalize";
  nameSpan.style.flex = "1";
  summary.appendChild(nameSpan);

  // Chevron (Visual indicator for open/closed)
  const chevron = doc.createElementNS(HTML_NS, "span") as HTMLElement;
  chevron.innerHTML = `<svg width="8" height="5" viewBox="0 0 10 6" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M1 1L5 5L9 1" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  chevron.style.opacity = "0.4";
  chevron.style.transform = details.open ? "rotate(0deg)" : "rotate(-90deg)"; // Initial state
  chevron.style.transition = "transform 0.2s";
  summary.appendChild(chevron);

  // Update chevron on toggle
  details.addEventListener("toggle", () => {
    chevron.style.transform = details.open ? "rotate(0deg)" : "rotate(-90deg)";
  });

  details.appendChild(summary);

  // Content (Arguments & Results)
  const content = doc.createElementNS(HTML_NS, "div") as HTMLElement;
  content.className = "tool-details-content";
  content.style.cssText = `
        padding: 10px;
        border-top: 1px solid var(--border-secondary, #e0e0e0);
        font-size: 11px;
        font-family: 'SF Mono', 'Menlo', 'Monaco', 'Courier New', monospace;
        line-height: 1.4;
        background: var(--background-primary, #fff);
        color: var(--text-primary, #333);
        overflow-x: auto;
        overflow-wrap: break-word;
        word-break: break-word;
        max-width: 100%;
        box-sizing: border-box;
    `;

  // Arguments
  try {
    const argsLabel = doc.createElementNS(HTML_NS, "div") as HTMLElement;
    argsLabel.textContent = "INPUT";
    argsLabel.style.cssText =
      "font-size: 10px; font-weight: 700; color: var(--text-tertiary, #8e8e93); margin-bottom: 4px; letter-spacing: 0.5px;";
    content.appendChild(argsLabel);

    const args = JSON.parse(toolCall.function.arguments);
    const argsPre = doc.createElementNS(HTML_NS, "div") as HTMLElement;
    argsPre.textContent = JSON.stringify(args, null, 2);
    argsPre.style.whiteSpace = "pre-wrap";
    argsPre.style.color = "var(--text-primary)";
    content.appendChild(argsPre);
  } catch (e) {
    content.textContent = "Error parsing arguments";
  }

  // Result
  if (result) {
    const resLabel = doc.createElementNS(HTML_NS, "div") as HTMLElement;
    resLabel.textContent = "OUTPUT";
    resLabel.style.cssText =
      "font-size: 10px; font-weight: 700; color: var(--text-tertiary, #8e8e93); margin: 12px 0 4px 0; letter-spacing: 0.5px;";
    content.appendChild(resLabel);

    const resDiv = doc.createElementNS(HTML_NS, "div") as HTMLElement;
    resDiv.style.whiteSpace = "pre-wrap";

    if (result.success) {
      // Check if data is complex object or simple text
      if (result.data) {
        // Interactive question form for workspace_question tool
        // The interactive panel is rendered as a standalone element in the chat -
        // here we just show a compact note
        if (toolCall.function.name === "workspace_question") {
          const data = result.data as Record<string, unknown>;
          if (data.questions && Array.isArray(data.questions)) {
            const questions = data.questions as any[];
            const noteDiv = doc.createElementNS(HTML_NS, "div") as HTMLElement;
            noteDiv.style.cssText =
              "font-size: 11px; font-style: italic; color: var(--text-secondary);";
            noteDiv.textContent = `${questions.length} question(s) asked — see interactive panel above`;
            resDiv.style.whiteSpace = "normal";
            resDiv.style.color = "var(--text-primary)";
            resDiv.appendChild(noteDiv);
          }
        } else {
          resDiv.textContent = JSON.stringify(result.data, null, 2);
          resDiv.style.color = "var(--text-primary)";
          // Truncate if extremely long
          if (resDiv.textContent.length > 2000) {
            resDiv.textContent =
              resDiv.textContent.slice(0, 2000) + "... (truncated)";
          }
        }
      } else {
        resDiv.textContent = result.summary || "Success";
        resDiv.style.color = "var(--text-secondary, #666)";
      }
    } else {
      resDiv.textContent = result.error || "Unknown Error";
      resDiv.style.color = "var(--accent-red, #FF3B30)";
      resDiv.style.background = "var(--bg-error-light, rgba(255, 59, 48, 0.1))";
      resDiv.style.padding = "4px";
      resDiv.style.borderRadius = "4px";
    }
    content.appendChild(resDiv);
  }

  details.appendChild(content);

  return details;
}

/**
 * Observer for agent UI updates
 */
export interface AgentUIObserver {
  onToken: (token: string, fullResponse: string) => void;
  onToolCallStarted: (toolCall: ToolCall) => void;
  onToolCallCompleted: (toolCall: ToolCall, result: ToolResult) => void;
  onMessageUpdate: (content: string) => void;
  onComplete: (content: string, iterationCount?: number) => void;
  onError: (error: Error) => void;
  onIterationStarted?: (iteration: number) => void;
  onPreApiCall?: (estimatedInputTokens: number) => void;
}

/**
 * Agentic chat handler with tool calling loop
 */
export async function handleAgenticChat(
  text: string,
  systemPrompt: string,
  conversationHistory: ChatMessage[],
  options: AgenticChatOptions,
  observer: AgentUIObserver,
): Promise<void> {
  const agentConfig = {
    ...getAgentConfigFromPrefs(),
    permissionHandler: options.permissionHandler,
    libraryScope:
      options.libraryScope || getAgentConfigFromPrefs().libraryScope,
  };

  // Get tools if enabled, filtered by permission settings
  const allFilteredTools = getFilteredAgentTools();
  const tools: ToolDefinition[] | undefined = options.enableTools
    ? allFilteredTools
    : undefined;

  // Build initial messages
  const messages: (
    | OpenAIMessage
    | VisionMessage
    | ToolCallMessage
    | ToolResultMessage
  )[] = [
    { role: "system", content: systemPrompt },
    ...conversationHistory
      .filter((m) => m.role !== "system" && m.role !== "error")
      .map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      })),
  ];

  // Add current user message with images if applicable
  if (options.pastedImages && options.pastedImages.length > 0) {
    const imageParts: VisionMessageContentPart[] = options.pastedImages.map(
      (img) => ({
        type: "image_url",
        image_url: {
          url: img.image,
          detail: "auto" as const,
        },
      }),
    );

    messages.push({
      role: "user",
      content: [{ type: "text", text }, ...imageParts],
    });
  } else {
    messages.push({ role: "user", content: text });
  }

  // Get model config
  const activeModel = getActiveModelConfig();
  const configOverride = activeModel
    ? {
        apiURL: activeModel.apiURL,
        apiKey: activeModel.apiKey,
        model: activeModel.model,
        temperature: options.temperature,
        max_tokens: options.maxTokens,
      }
    : undefined;

  let fullResponse = "";
  let iteration = 0;
  let noToolRetryCount = 0;
  let continuationToken = options.continuation || "";
  const MAX_NO_TOOL_RETRIES = 2;

  const compactionState: CompactionState = { count: 0, lastCompactAt: 0 };
  const modelContextLength = activeModel?.contextLength || 128000;
  const outputBudget = configOverride?.max_tokens || 16384;

  // Start tracing session (agentic.md Section 7.1)
  const sessionId = `agent_${Date.now()}`;
  agentTracer.startSession(sessionId);

  // Agent loop
  while (iteration < agentConfig.maxAgentIterations) {
    // Check for abortion at the start of iteration
    if (openAIService.isAbortedState()) {
      Zotero.debug("[seerai] Agent loop aborted at start of iteration");
      throw new Error("Request was cancelled");
    }

    iteration++;
    Zotero.debug(`[seerai] Agent iteration ${iteration}`);
    agentTracer.startIteration(sessionId, iteration);

    // Notify observer that a new iteration (reasoning turn) has started
    // This allows resetting the UI status from "Calling Tool" back to "Thinking"
    observer.onIterationStarted?.(iteration);

    // Inject a hidden internal system hint to help the model maintain context
    // This ensures the model knows the current turn number and task expectations
    if (iteration > 1) {
      messages.push({
        role: "system",
        content: `[Reasoning turn ${iteration}. When your work is complete and the user's request is fully answered, provide a text response with no tool calls to end the conversation.]`,
      });
    }

    let toolCallsReceived: ToolCall[] = [];
    let iterationContent = "";

    try {
      await maybeCompactContext(
        messages,
        modelContextLength,
        outputBudget,
        compactionState,
        sessionId,
      );

      const estimatedInputTokens = messages.reduce((sum, m) => {
        const content =
          typeof m.content === "string" ? m.content : JSON.stringify(m.content);
        return sum + ChatStateManager.countTokens(content);
      }, 0);

      agentTracer.setIterationTokens(sessionId, estimatedInputTokens);
      observer.onPreApiCall?.(estimatedInputTokens);

      const provider = createProvider();
      const query = provider.query({
        messages,
        tools,
        configOverride,
        continuation: continuationToken || undefined,
      });

      try {
        for await (const event of query.events) {
          switch (event.type) {
            case "init":
              if (event.continuation) {
                continuationToken = event.continuation;
              }
              break;
            case "token":
              iterationContent += event.text;
              fullResponse += event.text;
              observer.onToken(event.text, fullResponse);
              break;
            case "tool_calls":
              Zotero.debug(
                `[seerai] Received ${event.toolCalls.length} tool call(s)`,
              );
              toolCallsReceived = event.toolCalls;
              break;
            case "done":
              Zotero.debug(
                `[seerai] Iteration ${iteration} complete, content length: ${event.content.length}`,
              );
              break;
            case "error":
              throw new Error(event.message);
          }

          if (openAIService.isAbortedState()) {
            query.abort();
            throw new Error("Request was cancelled");
          }
        }
      } catch (err) {
        if (
          err instanceof Error &&
          (err.message.includes("cancelled") || err.message.includes("abort"))
        ) {
          throw err;
        }
        const msg = err instanceof Error ? err.message : String(err);
        Zotero.debug(`[seerai] Provider stream error: ${msg}`);
        throw err;
      }

      // If no tool calls, check if task is complete or we should retry
      if (toolCallsReceived.length === 0) {
        if (taskExplicitlyCompleted) {
          Zotero.debug(
            `[seerai] Task was completed via task_complete tool, agent loop done`,
          );
          break;
        }

        const hasActiveTodos = await hasIncompleteTodos();

        if (!hasActiveTodos && productiveToolCalls === 0) {
          Zotero.debug(
            `[seerai] No tool calls, no active todos, no prior work — treating as conversational response`,
          );
          break;
        }

        if (!hasActiveTodos) {
          Zotero.debug(
            `[seerai] No tool calls and no active todos — task appears complete`,
          );
          break;
        }

        noToolRetryCount++;
        Zotero.debug(
          `[seerai] No tool calls but has active todos (retry ${noToolRetryCount}/${MAX_NO_TOOL_RETRIES})`,
        );

        if (noToolRetryCount > MAX_NO_TOOL_RETRIES) {
          Zotero.debug(`[seerai] Max no-tool retries reached, stopping`);
          const stopHint = `\n\n*[Agent paused after ${iteration} turns — task may be incomplete. You can ask it to continue.]*`;
          fullResponse += stopHint;
          observer.onMessageUpdate(fullResponse);
          break;
        }

        if (iterationContent) {
          messages.push({
            role: "assistant",
            content: iterationContent,
          });
        }
        messages.push({
          role: "system",
          content:
            `You have active TODO items that are not yet completed. ` +
            `Call 'todoread' to check status, then execute the next pending tool call. ` +
            `Do NOT produce more text — take ACTION with a tool call.`,
        });
        continue;
      }

      // Reset no-tool retry counter on successful tool calls
      noToolRetryCount = 0;

      let batchHasProductive = false;
      let batchHasTaskComplete = false;

      for (const tc of toolCallsReceived) {
        if (tc.function.name === "task_complete") {
          batchHasTaskComplete = true;
        } else if (PRODUCTIVE_TOOLS.has(tc.function.name)) {
          batchHasProductive = true;
        }
      }

      // Reject premature task_complete: must have done productive work first
      if (
        batchHasTaskComplete &&
        productiveToolCalls === 0 &&
        !batchHasProductive
      ) {
        Zotero.debug(
          "[seerai] Rejecting premature task_complete — no productive tool calls made",
        );
        const rejectionMessage = JSON.stringify({
          success: false,
          error:
            "ERROR: You called task_complete without having DONE any actual work. " +
            "You must EXECUTE tools (search, read, write files, generate output, etc.) before calling task_complete. " +
            "If this is a multi-step task, call todowrite first to plan, then work through each step. " +
            "Calling task_complete as your first action is NOT allowed.",
        });
        messages.push({
          role: "assistant",
          content: iterationContent || null,
          tool_calls: toolCallsReceived,
        });
        messages.push({
          role: "tool",
          tool_call_id:
            toolCallsReceived.find((tc) => tc.function.name === "task_complete")
              ?.id || "unknown",
          content: rejectionMessage,
        });
        continue;
      }

      if (batchHasTaskComplete) {
        taskExplicitlyCompleted = true;
        Zotero.debug(
          "[seerai] task_complete tool called, will finish after this iteration",
        );
      }

      // Filter out invalid tool calls (empty name, etc.) that would crash the API
      const validToolCalls = toolCallsReceived.filter(
        (tc) => tc.function.name && tc.function.name.length > 0,
      );
      const invalidCount = toolCallsReceived.length - validToolCalls.length;
      if (invalidCount > 0) {
        Zotero.debug(
          `[seerai] Filtered ${invalidCount} invalid tool call(s) with empty name`,
        );
      }

      // Add assistant message with tool calls to history
      const assistantToolMessage: ToolCallMessage = {
        role: "assistant",
        content: iterationContent || null,
        tool_calls: validToolCalls,
      };
      messages.push(assistantToolMessage);

      // Execute each tool call
      // Parallel execution for speed - permission dialogs will queue naturally in Zotero
      const toolResults: { toolCall: ToolCall; result: ToolResult }[] = [];

      await Promise.all(
        validToolCalls.map(async (toolCall) => {
          // Inform observer tool call started
          observer.onToolCallStarted(toolCall);

          // Start tool span for tracing (parse gracefully — malformed JSON
          // is handled by executeToolCall's self-correction below)
          let parsedArgs: Record<string, unknown> = {};
          try {
            parsedArgs = JSON.parse(toolCall.function.arguments || "{}");
          } catch {
            // Malformed JSON — executeToolCall will return a proper error
          }
          agentTracer.startToolSpan(
            sessionId,
            toolCall.id,
            toolCall.function.name,
            parsedArgs,
          );

          // Execute the tool
          const result = await executeToolCall(toolCall, agentConfig);

          // End tool span with result
          agentTracer.endToolSpan(sessionId, toolCall.id, {
            success: result.success,
            error: result.error,
            dataSummary: result.summary,
          });

          // Inform observer tool call completed
          observer.onToolCallCompleted(toolCall, result);

          toolResults.push({ toolCall, result });
        }),
      );

      // Check for abortion after all tool executions
      if (openAIService.isAbortedState()) {
        Zotero.debug("[seerai] Agent loop aborted after tool execution");
        throw new Error("Request was cancelled");
      }

      // Add results to history with enhanced error feedback (Reflexion pattern - agentic.md Section 2.1)
      for (const { toolCall, result } of toolResults) {
        if (result.success && PRODUCTIVE_TOOLS.has(toolCall.function.name)) {
          productiveToolCalls++;
        }

        let resultContent: string;

        if (!result.success && result.error) {
          // Enhanced error feedback for self-correction
          resultContent = JSON.stringify({
            success: false,
            error: result.error,
            guidance:
              `The tool "${toolCall.function.name}" failed. ` +
              `Please analyze the error message above and either: ` +
              `(1) retry with corrected arguments, ` +
              `(2) try a different approach, or ` +
              `(3) inform the user if the operation is not possible.`,
          });
          Zotero.debug(
            `[seerai] Tool ${toolCall.function.name} failed, providing self-correction guidance`,
          );
        } else {
          resultContent = formatToolResult(toolCall.id, result);
        }

        const toolResultMessage: ToolResultMessage = {
          role: "tool",
          tool_call_id: toolCall.id,
          content: resultContent,
        };
        messages.push(toolResultMessage);
      }

      // End iteration for tracing
      agentTracer.endIteration(sessionId);
    } catch (error) {
      agentTracer.endSession(sessionId, false);
      observer.onError(error as Error);
      throw error; // Re-throw to allow caller (Assistant) to handle it
    }
  }

  // If we reached the max iterations, inform the user
  if (iteration >= agentConfig.maxAgentIterations) {
    Zotero.debug(
      `[seerai] Agent reached max iterations (${agentConfig.maxAgentIterations})`,
    );
    const stopMessage = `\n\n*[Agent stopped - reached maximum tool call iterations (${agentConfig.maxAgentIterations})]*`;
    fullResponse += stopMessage;
    observer.onMessageUpdate(fullResponse);
  }

  // End tracing session
  const trace = agentTracer.endSession(sessionId, true);
  if (trace) {
    Zotero.debug(
      `[seerai][trace] Summary: ${agentTracer.getExecutionSummary(trace)}`,
    );
  }

  try {
    const { getMessageStore } = await import("./messageStore");
    await getMessageStore().setContinuation(continuationToken || undefined);
  } catch (e) {
    Zotero.debug(`[seerai] Error saving continuation: ${e}`);
  }

  observer.onComplete(fullResponse, iteration);
}

/**
 * Check if agentic mode should be enabled based on preferences
 */
export function isAgenticModeEnabled(): boolean {
  try {
    const enabled = Zotero.Prefs.get("extensions.seerai.agenticMode");
    return enabled !== false; // Default to true if not set
  } catch (e) {
    return true;
  }
}
