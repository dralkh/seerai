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
  getAgentModelCapabilities,
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
  getToolSensitivity,
} from "./tools";
import { ChatMessage } from "./types";
import { parseMarkdown } from "./markdown";
import { resolveModel } from "./modelResolver";
import { createCliProvider, resolveCliContext } from "./cli/cliProvider";
import type { ModelRef } from "./providerTypes";
import { agentTracer } from "./tracer";
import { ChatStateManager } from "./stateManager";
import { getWorkspaceStore } from "./workspace/store";
import { createSvgIcon, type IconName } from "./ui/icons";

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
 * Read TODO progress and return a formatted status string for the model,
 * or null if no TODO file exists.
 */
async function getTodoProgress(): Promise<string | null> {
  try {
    const store = getWorkspaceStore();
    const file = await store.readFile(".agent/TODO.json");
    if (!file?.content) return null;
    const todos = JSON.parse(file.content);
    if (!Array.isArray(todos) || todos.length === 0) return null;

    const lines: string[] = [`[TODO Progress]`];
    for (const t of todos) {
      const icon =
        t.status === "completed"
          ? "[x]"
          : t.status === "in_progress"
            ? "[~]"
            : t.status === "cancelled"
              ? "[-]"
              : "[ ]";
      lines.push(`  ${icon} ${t.content}`);
    }
    return lines.join("\n");
  } catch {
    return null;
  }
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
  allowedTools?: string[];
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
  modelRef?: ModelRef;
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
  bannerText.style.cssText =
    "display: inline-flex; align-items: center; gap: 6px;";
  bannerText.appendChild(
    createSvgIcon(doc, "help", { size: 14, strokeWidth: 1.8 }),
  );
  const bannerTextLabel = doc.createElementNS(HTML_NS, "span") as HTMLElement;
  bannerTextLabel.textContent = "Questions from Assistant";
  bannerText.appendChild(bannerTextLabel);
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
      completeBtn.appendChild(createSvgIcon(doc, "check", { size: 13 }));
      completeBtn.appendChild(doc.createTextNode(" Complete"));
      completeBtn.style.cssText = `
        display: inline-flex;
        align-items: center;
        gap: 4px;
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

function safeJsonParse(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value || "{}");
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export function truncateMiddle(value: string, max = 140): string {
  if (value.length <= max) return value;
  const head = Math.floor((max - 3) * 0.62);
  const tail = max - 3 - head;
  return `${value.slice(0, head)}...${value.slice(value.length - tail)}`;
}

function stringifyPreview(value: unknown, max = 160): string {
  if (value === undefined || value === null) return "";
  const text =
    typeof value === "string" ? value : JSON.stringify(value, null, 2) || "";
  return truncateMiddle(text.replace(/\s+/g, " ").trim(), max);
}

export function getFriendlyToolAction(toolName: string): string {
  if (toolName.startsWith("cli_")) {
    const raw = toolName.slice(4).replace(/_/g, " ");
    return `CLI: ${raw}`;
  }
  const names: Record<string, string> = {
    search_library: "Searched Zotero library",
    search_external: "Searched external papers",
    get_item_metadata: "Read item metadata",
    read_item_content: "Read item content",
    import_paper: "Imported paper",
    generate_item_tags: "Generated tags",
    semantic_search: "Ran semantic search",
    keyword_search: "Ran keyword search",
    read_chunks: "Read evidence chunks",
    search_similar: "Searched similar papers",
    web: "Used web research",
    workspace_read_file: "Read file",
    workspace_write_file: "Wrote file",
    workspace_edit_file: "Edited file",
    workspace_glob: "Listed files",
    workspace_grep: "Searched files",
    workspace_bash: "Ran command",
    workspace_diff: "Reviewed workspace diff",
    workspace_log: "Reviewed workspace log",
    read_file: "Read file",
    write_file: "Wrote file",
    patch: "Applied patch",
    search_files: "Searched files",
    skills_list: "Searched skills",
    skill_view: "Opened skill",
    skill_info: "Inspected skill assets",
    skill_reference: "Read skill reference",
    terminal: "Ran terminal command",
    process: "Managed process",
    execute_code: "Executed code",
    check_environment: "Checked environment",
    todowrite: "Updated task list",
    todoread: "Read task list",
    task_complete: "Completed task",
    collection: "Updated collection",
    table: "Updated table",
    note: "Updated note",
    context: "Updated context",
    related_papers: "Found related papers",
    systematic_review: "Updated review",
  };
  return names[toolName] || toolName.replace(/_/g, " ");
}

export function summarizeToolTarget(toolCall: ToolCall): string {
  const args = safeJsonParse(toolCall.function.arguments);
  const pick = (...keys: string[]) => {
    for (const key of keys) {
      const value = args[key];
      if (value !== undefined && value !== null && value !== "") {
        return stringifyPreview(value, 120);
      }
    }
    return "";
  };

  switch (toolCall.function.name) {
    case "search_library":
    case "search_external":
    case "semantic_search":
    case "keyword_search":
    case "search_similar":
    case "skills_list":
    case "search_files":
      return pick("query", "pattern", "path");
    case "web":
      return [pick("action"), pick("query", "url")].filter(Boolean).join(": ");
    case "workspace_read_file":
    case "workspace_write_file":
    case "workspace_edit_file":
    case "read_file":
    case "write_file":
    case "patch":
      return pick("path", "file_path");
    case "workspace_bash":
    case "terminal":
    case "execute_code":
      return pick("command", "code");
    case "skill_view":
    case "skill_info":
    case "skill_reference":
      return pick("name", "path");
    case "get_item_metadata":
    case "read_item_content":
      return pick("item_id", "item_ids");
    default:
      return pick("detail", "action", "name", "title", "id", "path", "query");
  }
}

export function summarizeToolResult(
  toolCall: ToolCall,
  result?: ToolResult,
): string {
  if (!result) return "Running";
  if (!result.success) return result.error || "Failed";
  if (result.summary) return result.summary;

  const data = result.data as Record<string, unknown> | undefined;
  if (!data || typeof data !== "object") return "Completed";

  if (Array.isArray(data.items)) {
    return `${data.items.length} item${data.items.length === 1 ? "" : "s"}`;
  }
  if (Array.isArray(data.papers)) {
    return `${data.papers.length} paper${data.papers.length === 1 ? "" : "s"}`;
  }
  if (typeof data.path === "string") {
    return `${toolCall.function.name.includes("write") ? "Saved" : "Opened"} ${data.path}`;
  }
  if (typeof data.exitCode === "number" || typeof data.exit_code === "number") {
    const code = data.exitCode ?? data.exit_code;
    return `Exit ${code}`;
  }
  if (typeof data.total_count === "number") {
    return `${data.total_count} result${data.total_count === 1 ? "" : "s"}`;
  }
  if (typeof data.total === "number") {
    return `${data.total} result${data.total === 1 ? "" : "s"}`;
  }

  return "Completed";
}

export function createToolDisplay(
  toolCall: ToolCall,
  result?: ToolResult,
): {
  title: string;
  target: string;
  summary: string;
  status: "running" | "success" | "error";
} {
  return {
    title: getFriendlyToolAction(toolCall.function.name),
    target: summarizeToolTarget(toolCall),
    summary: summarizeToolResult(toolCall, result),
    status: !result ? "running" : result.success ? "success" : "error",
  };
}

function getStatusIconName(status: "running" | "success" | "error"): IconName {
  if (status === "success") return "check-circle";
  if (status === "error") return "x-circle";
  return "hourglass";
}

function getToolLogText(container: HTMLElement): string {
  const rows = Array.from(
    container.querySelectorAll(".tool-execution-card"),
  ) as HTMLElement[];
  return rows
    .map((row, index) => {
      const title =
        row.querySelector(".tool-row-title")?.textContent?.trim() || "Tool";
      const target =
        row.querySelector(".tool-row-target")?.textContent?.trim() || "";
      const result =
        row.querySelector(".tool-row-result")?.textContent?.trim() || "";
      const input =
        row.querySelector("[data-tool-section='input'] pre")?.textContent || "";
      const output =
        row.querySelector("[data-tool-section='output'] pre")?.textContent ||
        "";
      const error =
        row.querySelector("[data-tool-section='error'] pre")?.textContent || "";
      return [
        `#${index + 1} ${title}${target ? ` - ${target}` : ""}`,
        result ? `Result: ${result}` : "",
        input ? `Input:\n${input}` : "",
        output ? `Output:\n${output}` : "",
        error ? `Error:\n${error}` : "",
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n\n");
}

function toolIconButton(
  doc: Document,
  iconName: IconName,
  title: string,
): HTMLButtonElement {
  const button = doc.createElementNS(HTML_NS, "button") as HTMLButtonElement;
  button.type = "button";
  button.className = "tool-timeline-btn";
  button.title = title;
  button.appendChild(createSvgIcon(doc, iconName, { size: 13 }));
  return button;
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

  details.open = false;
  // Keep the process group bounded to the message width (see createToolExecutionUI).
  details.style.width = "100%";
  details.style.maxWidth = "100%";
  details.style.boxSizing = "border-box";
  details.style.overflow = "hidden";

  const summary = doc.createElementNS(HTML_NS, "summary") as HTMLElement;
  summary.className = "tool-process-summary";

  const icon = doc.createElementNS(HTML_NS, "span") as HTMLElement;
  icon.className = "process-icon tool-process-icon";
  icon.replaceChildren(
    createSvgIcon(doc, "brain", { size: 14, strokeWidth: 1.7 }),
  );
  summary.appendChild(icon);

  const labelWrap = doc.createElementNS(HTML_NS, "span") as HTMLElement;
  labelWrap.className = "tool-process-label-wrap";

  const label = doc.createElementNS(HTML_NS, "span") as HTMLElement;
  label.className = "process-label tool-process-label";
  label.textContent = "Agent activity";
  labelWrap.appendChild(label);

  const subLabel = doc.createElementNS(HTML_NS, "span") as HTMLElement;
  subLabel.className = "tool-process-subtitle";
  subLabel.textContent = "Planning";
  labelWrap.appendChild(subLabel);
  summary.appendChild(labelWrap);

  const controls = doc.createElementNS(HTML_NS, "span") as HTMLElement;
  controls.className = "tool-timeline-controls";

  const expandBtn = toolIconButton(doc, "chevron-down", "Expand all tools");
  expandBtn.onclick = (e) => {
    e.preventDefault();
    e.stopPropagation();
    details.open = true;
    const childDetails = details.querySelectorAll(
      "details.tool-execution-card",
    );
    childDetails.forEach((cd: Element) => {
      (cd as HTMLDetailsElement).open = true;
    });
  };

  const collapseBtn = toolIconButton(doc, "chevron-up", "Collapse all tools");
  collapseBtn.onclick = (e) => {
    e.preventDefault();
    e.stopPropagation();
    const childDetails = details.querySelectorAll(
      "details.tool-execution-card",
    );
    childDetails.forEach((cd: Element) => {
      (cd as HTMLDetailsElement).open = false;
    });
    details.open = false;
  };

  const copyBtn = toolIconButton(doc, "copy", "Copy tool log");
  copyBtn.onclick = async (e) => {
    e.preventDefault();
    e.stopPropagation();
    const text = getToolLogText(details);
    try {
      await doc.defaultView?.navigator.clipboard?.writeText(text);
      copyBtn.classList.add("copied");
      setTimeout(() => copyBtn.classList.remove("copied"), 900);
    } catch {
      Zotero.debug("[seerai] Failed to copy tool log");
    }
  };

  controls.appendChild(expandBtn);
  controls.appendChild(collapseBtn);
  controls.appendChild(copyBtn);
  summary.appendChild(controls);

  const chevron = doc.createElementNS(HTML_NS, "span") as HTMLElement;
  chevron.className = "tool-process-chevron";
  chevron.appendChild(createSvgIcon(doc, "chevron-down", { size: 13 }));
  summary.appendChild(chevron);

  details.addEventListener("toggle", () => {
    chevron.classList.toggle("open", details.open);
  });

  details.appendChild(summary);

  const statsBar = doc.createElementNS(HTML_NS, "div") as HTMLElement;
  statsBar.className = "agent-stats-bar";

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

  const listContainer = doc.createElementNS(HTML_NS, "div") as HTMLElement;
  listContainer.className = "tool-list-container";
  details.appendChild(listContainer);

  // State helpers
  const setProcessIcon = (
    name: IconName,
    options: {
      color?: string;
      animate?: boolean | string;
      filter?: string;
    } = {},
  ) => {
    icon.replaceChildren(
      createSvgIcon(doc, name, { size: 14, strokeWidth: 1.7 }),
    );
    icon.style.color = options.color ?? "var(--text-secondary)";
    icon.classList.toggle("is-running", !!options.animate);
    if (options.animate) {
      icon.style.animation =
        typeof options.animate === "string"
          ? `pulse ${options.animate} infinite`
          : "pulse 1.5s infinite";
    } else {
      icon.style.animation = "none";
    }
    icon.style.filter = options.filter ?? "none";
  };

  const setThinking = () => {
    label.textContent = "Agent activity";
    subLabel.textContent = "Planning next step";
    details.classList.remove("is-complete", "is-failed");
    details.classList.add("is-running");
    setProcessIcon("lightning", {
      animate: "1.5s",
      filter: "grayscale(100%) opacity(0.7)",
    });
  };

  const setExecutingTool = (toolName: string) => {
    label.textContent = "Agent activity";
    subLabel.textContent = getFriendlyToolAction(toolName);
    details.classList.remove("is-complete", "is-failed");
    details.classList.add("is-running");
    setProcessIcon("tool", { animate: "1s" });
  };

  const setCompleted = (count: number, toolCount?: number) => {
    if (toolCount !== undefined && toolCount !== count) {
      label.textContent = `Completed ${toolCount} action${toolCount !== 1 ? "s" : ""}`;
      subLabel.textContent = `${count} turn${count !== 1 ? "s" : ""}`;
    } else {
      label.textContent = `Completed ${count} analysis turn${count !== 1 ? "s" : ""}`;
      subLabel.textContent = "Finished";
    }
    details.classList.remove("is-running", "is-failed");
    details.classList.add("is-complete");
    setProcessIcon("check-circle", { color: "var(--accent-green, #34C759)" });
  };

  const updateProgress = (count: number, toolCount?: number) => {
    if (toolCount !== undefined && toolCount !== count) {
      label.textContent = `Running ${toolCount} action${toolCount !== 1 ? "s" : ""}`;
      subLabel.textContent = `${count} turn${count !== 1 ? "s" : ""}`;
    } else {
      label.textContent = `Running ${count} analysis turn${count !== 1 ? "s" : ""}`;
      subLabel.textContent = "Working";
    }
    details.classList.remove("is-complete", "is-failed");
    details.classList.add("is-running");
    setProcessIcon("lightning", {
      color: "var(--text-secondary)",
      animate: "2s",
    });
  };

  const setFailed = (error: string) => {
    label.textContent = "Agent stopped";
    subLabel.textContent = truncateMiddle(error, 180);
    details.classList.remove("is-running", "is-complete");
    details.classList.add("is-failed");
    setProcessIcon("x-circle", { color: "var(--accent-red, #FF3B30)" });
    icon.style.animation = "none";
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
      const summary = stats.lastToolSummary
        ? ` \u2192 ${stats.lastToolSummary}`
        : "";
      statsLast.textContent = `Last: ${getFriendlyToolAction(stats.lastToolName)}${summary}`;
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
  const display = createToolDisplay(toolCall, result);
  details.classList.add(`tool-status-${display.status}`);
  details.open = false;
  // Bound the card to its container so a long tool name/target can never widen
  // the message bubble (and the whole sidebar) — the inner rows already
  // truncate/wrap, they just need a definite-width ancestor.
  details.style.width = "100%";
  details.style.maxWidth = "100%";
  details.style.boxSizing = "border-box";
  details.style.overflow = "hidden";

  const summary = doc.createElementNS(HTML_NS, "summary") as HTMLElement;
  summary.className = "tool-row-summary";

  const statusSpan = doc.createElementNS(HTML_NS, "span") as HTMLElement;
  statusSpan.className = "tool-row-status";
  statusSpan.appendChild(
    createSvgIcon(doc, getStatusIconName(display.status), { size: 14 }),
  );
  summary.appendChild(statusSpan);

  const textWrap = doc.createElementNS(HTML_NS, "span") as HTMLElement;
  textWrap.className = "tool-row-text";

  const titleRow = doc.createElementNS(HTML_NS, "span") as HTMLElement;
  titleRow.className = "tool-row-title-line";

  const title = doc.createElementNS(HTML_NS, "span") as HTMLElement;
  title.className = "tool-row-title";
  title.textContent = display.title;
  titleRow.appendChild(title);

  const resultPill = doc.createElementNS(HTML_NS, "span") as HTMLElement;
  resultPill.className = "tool-row-result";
  resultPill.textContent = display.summary;
  titleRow.appendChild(resultPill);
  textWrap.appendChild(titleRow);

  if (display.target) {
    const target = doc.createElementNS(HTML_NS, "span") as HTMLElement;
    target.className = "tool-row-target";
    target.textContent = display.target;
    textWrap.appendChild(target);
  }
  summary.appendChild(textWrap);

  const chevron = doc.createElementNS(HTML_NS, "span") as HTMLElement;
  chevron.className = "tool-row-chevron";
  chevron.appendChild(createSvgIcon(doc, "chevron-down", { size: 12 }));
  chevron.classList.toggle("open", details.open);
  summary.appendChild(chevron);

  details.addEventListener("toggle", () => {
    chevron.classList.toggle("open", details.open);
  });

  details.appendChild(summary);

  const content = doc.createElementNS(HTML_NS, "div") as HTMLElement;
  content.className = "tool-details-content";

  const appendSection = (
    label: string,
    value: string,
    kind: "input" | "output" | "error",
  ) => {
    const section = doc.createElementNS(HTML_NS, "div") as HTMLElement;
    section.className = `tool-detail-section tool-detail-${kind}`;
    section.setAttribute("data-tool-section", kind);

    const sectionLabel = doc.createElementNS(HTML_NS, "div") as HTMLElement;
    sectionLabel.className = "tool-detail-label";
    sectionLabel.textContent = label;
    section.appendChild(sectionLabel);

    const pre = doc.createElementNS(HTML_NS, "pre") as HTMLElement;
    pre.className = "tool-detail-pre";
    const isLong = value.length > 2200;
    pre.textContent = isLong
      ? `${value.slice(0, 2200)}\n... (truncated)`
      : value;
    section.appendChild(pre);

    if (isLong) {
      const showBtn = doc.createElementNS(
        HTML_NS,
        "button",
      ) as HTMLButtonElement;
      showBtn.type = "button";
      showBtn.className = "tool-detail-show-full";
      showBtn.textContent = "Show full output";
      showBtn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        pre.textContent = value;
        showBtn.remove();
      });
      section.appendChild(showBtn);
    }

    content.appendChild(section);
  };

  const parsedArgs = safeJsonParse(toolCall.function.arguments);
  appendSection("Input", JSON.stringify(parsedArgs, null, 2), "input");

  if (result) {
    if (!result.success) {
      appendSection("Error", result.error || "Unknown error", "error");
    } else {
      const output =
        result.data !== undefined
          ? JSON.stringify(result.data, null, 2)
          : result.summary || "Success";
      appendSection("Output", output, "output");
    }
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

export interface ToolCallIntakeResult {
  ok: boolean;
  validToolCalls: ToolCall[];
  error?: string;
}

export function validateToolCallIntake(
  toolCalls: ToolCall[],
  availableToolNames: Iterable<string>,
): ToolCallIntakeResult {
  const available = new Set(availableToolNames);
  const validToolCalls: ToolCall[] = [];

  for (const toolCall of toolCalls) {
    const name = toolCall.function?.name || "";
    if (!name) {
      return {
        ok: false,
        validToolCalls: [],
        error:
          "A tool call was returned without a function name. Retry with a valid tool name from the provided tool list.",
      };
    }
    if (!available.has(name)) {
      return {
        ok: false,
        validToolCalls: [],
        error: `Unknown tool "${name}". Retry with one of the available tools only.`,
      };
    }

    const rawArguments = toolCall.function.arguments || "{}";
    try {
      JSON.parse(rawArguments.trim() ? rawArguments : "{}");
    } catch (e) {
      return {
        ok: false,
        validToolCalls: [],
        error:
          `Tool "${name}" returned invalid JSON arguments: ` +
          `${e instanceof Error ? e.message : String(e)}. ` +
          "Retry the tool call with exactly one valid JSON object as arguments. Do not include trailing text, markdown fences, or multiple JSON objects.",
      };
    }

    validToolCalls.push({
      ...toolCall,
      function: {
        ...toolCall.function,
        arguments: rawArguments.trim() ? rawArguments : "{}",
      },
    });
  }

  return { ok: true, validToolCalls };
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
  let allFilteredTools = getFilteredAgentTools();
  if (options.allowedTools) {
    allFilteredTools = allFilteredTools.filter((t) =>
      options.allowedTools!.includes(t.function.name),
    );
  }
  const tools: ToolDefinition[] | undefined = options.enableTools
    ? allFilteredTools
    : undefined;

  if (tools && tools.length > 0) {
    const activeConfig = resolveModel("chat", options.modelRef);
    const apiURL = activeConfig?.provider.apiURL || "";
    const model = activeConfig?.model.modelId || "";
    const capabilities = getAgentModelCapabilities(apiURL, model);
    if (!capabilities.supportsTools) {
      const message =
        capabilities.knownIncompatibleReason ||
        "The selected model does not support function/tool calling. Agent mode requires a tool-capable chat model.";
      observer.onError(new Error(message));
      throw new Error(message);
    }
  }

  // Clear stale TODOs from previous crashed session on fresh start
  if (!options.continuation) {
    try {
      const store = getWorkspaceStore();
      await store.writeFile(".agent/TODO.json", "[]", "Reset stale TODO state");
    } catch {
      // Workspace may not be ready yet — ignore
    }
  }

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
  const activeModel = resolveModel("chat", options.modelRef);
  const configOverride = activeModel
    ? {
        apiURL: activeModel.provider.apiURL,
        apiKey: activeModel.provider.apiKey,
        model: activeModel.model.modelId,
        modelRef: activeModel.ref,
        endpoint: activeModel.endpoint,
        headers: activeModel.headers,
        temperature: options.temperature,
        max_tokens: options.maxTokens,
      }
    : undefined;

  let fullResponse = "";
  let iteration = 0;
  let continuationToken = options.continuation || "";

  // Track recent tool calls for loop detection
  const recentToolCalls: { name: string; args: string }[] = [];
  const executedToolSummaries: Array<{
    name: string;
    success: boolean;
    summary?: string;
    error?: string;
  }> = [];
  const LOOP_DETECTION_WINDOW = 5;
  const MAX_ITERATIONS = agentConfig.maxAgentIterations;
  const MAX_TOOL_CALL_REPAIR_ATTEMPTS = 2;
  let toolCallRepairAttempts = 0;

  const compactionState: CompactionState = { count: 0, lastCompactAt: 0 };
  const modelContextLength = activeModel?.model.contextLength || 128000;
  const outputBudget = configOverride?.max_tokens || 16384;

  // Start tracing session
  const sessionId = `agent_${Date.now()}`;
  agentTracer.startSession(sessionId);

  // Agent loop — model naturally stops by returning text-only (no tool calls).
  // Explicit task_complete also signals termination.
  while (iteration < MAX_ITERATIONS) {
    // Check for abortion at the start of iteration
    if (openAIService.isAbortedState()) {
      Zotero.debug("[seerai] Agent loop aborted at start of iteration");
      throw new Error("Request was cancelled");
    }

    iteration++;
    Zotero.debug(`[seerai] Agent iteration ${iteration}`);
    agentTracer.startIteration(sessionId, iteration);

    // Notify observer that a new iteration (reasoning turn) has started
    observer.onIterationStarted?.(iteration);

    // Inject TODO progress so model can see what's left
    const todoStatus = await getTodoProgress();
    if (todoStatus) {
      messages.push({
        role: "system",
        content: todoStatus,
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

      // Local CLI providers (e.g. Codex) delegate to an installed agent CLI
      // that is its own agent — seerai's tool loop stays off, so the turn is a
      // single streamed text response. Auth is inherited from the CLI's login.
      const isCliProvider = activeModel?.provider.adapterId === "local-cli";
      const provider =
        isCliProvider && activeModel
          ? createCliProvider(activeModel, resolveCliContext(true))
          : createProvider();
      const query = provider.query({
        messages,
        tools: isCliProvider ? undefined : tools,
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
            case "tool_activity": {
              // A CLI harness ran one of its own tools. Render a display-only
              // tool card — seerai never executes it, so it is NOT added to
              // toolCallsReceived and never enters the executor.
              const toolId =
                event.id ||
                `${event.name}:${event.detail || ""}` ||
                `cli-tool-${Date.now()}`;
              const syntheticCall: ToolCall = {
                id: `cli-tool-${toolId}`,
                type: "function",
                function: {
                  name:
                    event.owner === "cli" ? `cli_${event.name}` : event.name,
                  arguments: JSON.stringify(
                    event.detail
                      ? { detail: event.detail, source: event.owner || "cli" }
                      : { source: event.owner || "cli" },
                  ),
                },
              };
              if (event.phase === "update") break;
              if (event.phase !== "complete") {
                observer.onToolCallStarted(syntheticCall);
              } else {
                observer.onToolCallCompleted(syntheticCall, {
                  success: event.success !== false,
                  summary: event.detail || `Ran ${event.name}`,
                  error: event.error,
                });
              }
              break;
            }
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

      // If model returned text-only with no tool calls, it's done naturally
      if (toolCallsReceived.length === 0) {
        Zotero.debug("[seerai] Model returned text-only — agent done");
        if (iterationContent) {
          messages.push({ role: "assistant", content: iterationContent });
        }
        break;
      }

      const intake = validateToolCallIntake(
        toolCallsReceived,
        tools?.map((tool) => tool.function.name) || [],
      );
      if (!intake.ok) {
        toolCallRepairAttempts++;
        Zotero.debug(
          `[seerai] Invalid tool-call payload: ${intake.error} (repair ${toolCallRepairAttempts}/${MAX_TOOL_CALL_REPAIR_ATTEMPTS})`,
        );
        if (toolCallRepairAttempts > MAX_TOOL_CALL_REPAIR_ATTEMPTS) {
          const stopMessage =
            "\n\nAgent stopped because the selected model repeatedly returned malformed tool calls. " +
            `${intake.error || "Malformed tool-call arguments."} ` +
            "Switch to a tool-capable model with reliable function calling and retry.";
          fullResponse += stopMessage;
          observer.onMessageUpdate(fullResponse);
          break;
        }

        if (iterationContent.trim()) {
          messages.push({ role: "assistant", content: iterationContent });
        }
        messages.push({
          role: "system",
          content:
            "Your previous response contained an invalid tool call, so no tool was executed. " +
            `${intake.error || "Retry with valid tool-call JSON."} ` +
            "Continue by retrying the intended tool call with valid JSON only, or provide a final text answer if tools are no longer needed.",
        });
        agentTracer.endIteration(sessionId);
        continue;
      }
      toolCallRepairAttempts = 0;

      const validToolCalls = intake.validToolCalls;

      // If task_complete was called explicitly, stop after this turn
      const hasTaskComplete = validToolCalls.some(
        (tc) => tc.function.name === "task_complete",
      );

      // Filter out task_complete from execution — it's a no-execute signal tool
      const executableToolCalls = hasTaskComplete
        ? validToolCalls.filter((tc) => tc.function.name !== "task_complete")
        : validToolCalls;

      // Add assistant message with tool calls to history
      const assistantToolMessage: ToolCallMessage = {
        role: "assistant",
        content: iterationContent || null,
        tool_calls: validToolCalls,
      };
      messages.push(assistantToolMessage);

      // Loop detection: check for 5+ same consecutive tool calls
      for (const tc of executableToolCalls) {
        recentToolCalls.push({
          name: tc.function.name,
          args: tc.function.arguments,
        });
      }
      if (recentToolCalls.length >= LOOP_DETECTION_WINDOW) {
        const recent = recentToolCalls.slice(-LOOP_DETECTION_WINDOW);
        const allSame = recent.every(
          (t) => t.name === recent[0].name && t.args === recent[0].args,
        );
        if (allSame) {
          Zotero.debug(
            `[seerai] Loop detected: ${recent[0].name} called ${LOOP_DETECTION_WINDOW}x with identical args`,
          );
          const stopMsg = `\n\n*[Agent stopped — detected repeating the same action. Please rephrase your request if you need to continue.]*`;
          fullResponse += stopMsg;
          observer.onMessageUpdate(fullResponse);
          break;
        }
      }

      // Execute each tool call
      const toolResults: { toolCall: ToolCall; result: ToolResult }[] = [];

      const executeOneToolCall = async (toolCall: ToolCall) => {
        observer.onToolCallStarted(toolCall);

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

        const result = await executeToolCall(toolCall, agentConfig);

        agentTracer.endToolSpan(sessionId, toolCall.id, {
          success: result.success,
          error: result.error,
          dataSummary: result.summary,
        });

        observer.onToolCallCompleted(toolCall, result);

        toolResults.push({ toolCall, result });
      };

      const readOnlyToolCalls = executableToolCalls.filter(
        (toolCall) => getToolSensitivity(toolCall.function.name) === "read",
      );
      const mutatingToolCalls = executableToolCalls.filter(
        (toolCall) => getToolSensitivity(toolCall.function.name) !== "read",
      );

      await Promise.all(readOnlyToolCalls.map(executeOneToolCall));
      for (const toolCall of mutatingToolCalls) {
        await executeOneToolCall(toolCall);
      }

      // Check for abortion after all tool executions
      if (openAIService.isAbortedState()) {
        Zotero.debug("[seerai] Agent loop aborted after tool execution");
        throw new Error("Request was cancelled");
      }

      // Add results to history with enhanced error feedback
      for (const { toolCall, result } of toolResults) {
        let resultContent: string;

        if (!result.success && result.error) {
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
        executedToolSummaries.push({
          name: toolCall.function.name,
          success: result.success,
          summary: result.summary,
          error: result.error,
        });
      }

      // End iteration for tracing
      agentTracer.endIteration(sessionId);

      // If task_complete was called, end here (don't loop again)
      if (hasTaskComplete) {
        Zotero.debug("[seerai] task_complete called — agent done");
        break;
      }
    } catch (error) {
      agentTracer.endSession(sessionId, false);
      if (
        executedToolSummaries.length > 0 &&
        error instanceof Error &&
        !error.message.includes("cancelled") &&
        !error.message.includes("abort")
      ) {
        const successes = executedToolSummaries.filter((tool) => tool.success);
        const failures = executedToolSummaries.filter((tool) => !tool.success);
        const lines = [
          "Agent stopped after a provider error while continuing from tool results.",
          "",
          `Provider error: ${error.message}`,
          "",
          `Tools completed before stop: ${successes.length}/${executedToolSummaries.length}.`,
        ];
        if (successes.length > 0) {
          lines.push("", "Successful actions:");
          for (const tool of successes.slice(0, 12)) {
            lines.push(`- ${tool.name}: ${tool.summary || "completed"}`);
          }
        }
        if (failures.length > 0) {
          lines.push("", "Failed actions:");
          for (const tool of failures.slice(0, 8)) {
            lines.push(`- ${tool.name}: ${tool.error || "failed"}`);
          }
        }
        lines.push(
          "",
          "Next step: switch to a tool-capable non-reasoning model and retry from this conversation.",
        );
        fullResponse = fullResponse.trim()
          ? `${fullResponse}\n\n${lines.join("\n")}`
          : lines.join("\n");
        observer.onMessageUpdate(fullResponse);
        observer.onComplete(fullResponse, iteration);
        return;
      }
      observer.onError(error as Error);
      throw error;
    }
  }

  // If we reached the max iterations, inform the user
  if (iteration >= agentConfig.maxAgentIterations) {
    Zotero.debug(
      `[seerai] Agent reached max iterations (${agentConfig.maxAgentIterations})`,
    );
    const stopMessage = `\n\n*[Agent stopped - reached maximum iterations (${agentConfig.maxAgentIterations})]*`;
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

  if (!fullResponse.trim() && executedToolSummaries.length > 0) {
    const successes = executedToolSummaries.filter((tool) => tool.success);
    const failures = executedToolSummaries.filter((tool) => !tool.success);
    const lines = [
      "Agent task completed. No final narrative was returned by the model, so this is an execution summary from the completed tool calls.",
      "",
      `Tools completed: ${successes.length}/${executedToolSummaries.length}.`,
    ];
    if (successes.length > 0) {
      lines.push("", "Successful actions:");
      for (const tool of successes.slice(0, 12)) {
        lines.push(`- ${tool.name}: ${tool.summary || "completed"}`);
      }
    }
    if (failures.length > 0) {
      lines.push("", "Failed actions:");
      for (const tool of failures.slice(0, 8)) {
        lines.push(`- ${tool.name}: ${tool.error || "failed"}`);
      }
    }
    fullResponse = lines.join("\n");
    observer.onMessageUpdate(fullResponse);
  }

  observer.onComplete(fullResponse, iteration);
}

/**
 * Check if agentic mode should be enabled based on preferences
 */
export function isAgenticModeEnabled(): boolean {
  try {
    const enabled = Zotero.Prefs.get("extensions.seerai.agenticMode");
    return enabled === true;
  } catch (e) {
    return false;
  }
}
