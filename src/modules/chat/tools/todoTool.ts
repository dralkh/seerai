/**
 * TODO Tool — structured task tracking for agentic sessions.
 *
 * Persists to workspace .agent/TODO.json so tasks survive context compaction
 * and chat reload. The model creates a task list at the start of a
 * multi-step request, then works through items, updating status as it
 * progresses. Only calls 'task_complete' when all todos are completed.
 */

import {
  ToolResult,
  TodoItem,
  TodoWriteResult,
  TodoReadResult,
} from "./toolTypes";
import { getWorkspaceStore } from "../workspace/store";

const TODO_FILENAME = ".agent/TODO.json";

function buildSummary(todos: TodoItem[]): string {
  const pending = todos.filter((t) => t.status === "pending").length;
  const inProgress = todos.filter((t) => t.status === "in_progress").length;
  const completed = todos.filter((t) => t.status === "completed").length;
  const cancelled = todos.filter((t) => t.status === "cancelled").length;

  const parts: string[] = [];
  if (completed > 0) parts.push(`${completed} completed`);
  if (inProgress > 0) parts.push(`${inProgress} in progress`);
  if (pending > 0) parts.push(`${pending} pending`);
  if (cancelled > 0) parts.push(`${cancelled} cancelled`);

  return parts.length > 0 ? `TODO: ${parts.join(", ")}` : "TODO: empty";
}

export function detectPlanNeed(text: string): boolean {
  const combined = text.toLowerCase();

  const triggerPhrases = [
    "step by step",
    "do all of the following",
    "do the following",
    "complete the following",
    "multiple steps",
    "several steps",
  ];

  if (triggerPhrases.some((p) => combined.includes(p))) return true;

  const compoundPatterns = [
    /\bfind\b.*\band\b.*\bcreate\b/,
    /\bsearch\b.*\band\b.*\badd\b/,
    /\bcompare\b.*\band\b.*\bsummariz/,
    /\borganiz\b.*\bcollect/,
  ];

  if (compoundPatterns.some((r) => r.test(combined))) return true;

  if (
    combined.includes("table") &&
    (combined.includes("column") || combined.includes("generate"))
  )
    return true;

  return false;
}

export async function executeTodoWrite(args: {
  todos: TodoItem[];
}): Promise<ToolResult> {
  if (!args.todos || !Array.isArray(args.todos)) {
    return {
      success: false,
      error: 'Missing required parameter: "todos" (must be a non-empty array)',
    };
  }

  const store = getWorkspaceStore();
  const content = JSON.stringify(args.todos, null, 2);

  await store.writeFile(TODO_FILENAME, content, "Update TODO list");

  const pending = args.todos.filter((t) => t.status === "pending").length;
  const inProgress = args.todos.filter(
    (t) => t.status === "in_progress",
  ).length;
  const completed = args.todos.filter((t) => t.status === "completed").length;

  const result: TodoWriteResult = {
    todos: args.todos,
    pending,
    in_progress: inProgress,
    completed,
  };

  return {
    success: true,
    data: result,
    summary: buildSummary(args.todos),
  };
}

export async function executeTodoRead(): Promise<ToolResult> {
  const store = getWorkspaceStore();

  let todos: TodoItem[] = [];
  try {
    const file = await store.readFile(TODO_FILENAME);
    if (file && file.content) {
      const parsed = JSON.parse(file.content);
      if (Array.isArray(parsed)) {
        todos = parsed;
      }
    }
  } catch {
    // File doesn't exist yet — return empty
  }

  const pending = todos.filter((t) => t.status === "pending").length;
  const inProgress = todos.filter((t) => t.status === "in_progress").length;
  const completed = todos.filter((t) => t.status === "completed").length;

  const result: TodoReadResult = {
    todos,
    pending,
    in_progress: inProgress,
    completed,
    total: todos.length,
  };

  return {
    success: true,
    data: result,
    summary: buildSummary(todos),
  };
}

export async function checkTodosBeforeComplete(): Promise<{
  canComplete: boolean;
  message: string;
}> {
  const store = getWorkspaceStore();

  let todos: TodoItem[] = [];
  try {
    const file = await store.readFile(TODO_FILENAME);
    if (file && file.content) {
      const parsed = JSON.parse(file.content);
      if (Array.isArray(parsed)) {
        todos = parsed;
      }
    }
  } catch {
    return { canComplete: true, message: "" };
  }

  if (todos.length === 0) return { canComplete: true, message: "" };

  const pending = todos.filter(
    (t) => t.status === "pending" || t.status === "in_progress",
  );

  if (pending.length > 0) {
    const pendingList = pending
      .map((t) => `  - [${t.status}] ${t.content}`)
      .join("\n");
    return {
      canComplete: false,
      message:
        `Cannot complete task yet — ${pending.length} TODO item(s) still not completed:\n${pendingList}\n` +
        `Continue working on these items before calling 'task_complete'.`,
    };
  }

  return { canComplete: true, message: "" };
}
