import type { ToolCall, ToolResult } from "../tools/toolTypes";

// A process-wide bridge so the plugin's HTTP API (which the seerai MCP server
// calls to execute a tool) can surface live tool cards in the open chat. The
// chat layer registers an emitter for the duration of a CLI agentic turn; the
// API layer fires start/complete around each tool execution. No-op when no turn
// is active (e.g. an external MCP client like Claude Desktop hitting the API),
// so it never spuriously renders or breaks tool execution.

export interface ToolActivityEmitter {
  onStart: (toolCall: ToolCall) => void;
  onComplete: (toolCall: ToolCall, result: ToolResult) => void;
}

let active: ToolActivityEmitter | null = null;

/** Register (or clear with null) the emitter for the current agentic turn. */
export function setActiveToolActivityEmitter(
  emitter: ToolActivityEmitter | null,
): void {
  active = emitter;
}

export function emitToolActivityStart(toolCall: ToolCall): void {
  try {
    active?.onStart(toolCall);
  } catch {
    // Visibility must never break tool execution.
  }
}

export function emitToolActivityComplete(
  toolCall: ToolCall,
  result: ToolResult,
): void {
  try {
    active?.onComplete(toolCall, result);
  } catch {
    // Visibility must never break tool execution.
  }
}
