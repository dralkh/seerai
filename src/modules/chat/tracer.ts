/**
 * Agent Tracer Module
 * Lightweight observability for agentic tool execution
 *
 * @see agentic.md Section 7.1 - Distributed Tracing and Telemetry
 */

/**
 * Represents a single tool execution span
 */
export interface ToolSpan {
  toolName: string;
  toolCallId: string;
  startTime: number;
  endTime?: number;
  durationMs?: number;
  inputArgs: Record<string, unknown>;
  result?: {
    success: boolean;
    error?: string;
    dataSummary?: string;
  };
}

/**
 * Represents an iteration within the agent loop
 */
export interface AgentIteration {
  index: number;
  startTime: number;
  endTime?: number;
  toolSpans: ToolSpan[];
  tokenCount?: number;
}

/**
 * Complete trace of an agent session
 */
export interface AgentTrace {
  sessionId: string;
  startTime: number;
  endTime?: number;
  totalDurationMs?: number;
  iterations: AgentIteration[];
  totalToolCalls: number;
  failedToolCalls: number;
  finalSuccess: boolean;
}

/**
 * Lightweight Agent Tracer
 * Tracks tool executions and provides structured logging
 */
class AgentTracer {
  private activeTraces: Map<string, AgentTrace> = new Map();
  private activeIterations: Map<string, AgentIteration> = new Map();
  private activeSpans: Map<string, ToolSpan> = new Map();

  /**
   * Start a new trace session
   */
  startSession(sessionId: string): void {
    const trace: AgentTrace = {
      sessionId,
      startTime: Date.now(),
      iterations: [],
      totalToolCalls: 0,
      failedToolCalls: 0,
      finalSuccess: false,
    };
    this.activeTraces.set(sessionId, trace);
    Zotero.debug(`[seerai][trace] Session started: ${sessionId}`);
  }

  /**
   * Start a new iteration within a session
   */
  startIteration(sessionId: string, index: number): void {
    const iteration: AgentIteration = {
      index,
      startTime: Date.now(),
      toolSpans: [],
    };
    this.activeIterations.set(sessionId, iteration);
  }

  /**
   * End the current iteration
   */
  endIteration(sessionId: string): void {
    const iteration = this.activeIterations.get(sessionId);
    const trace = this.activeTraces.get(sessionId);

    if (iteration && trace) {
      iteration.endTime = Date.now();
      trace.iterations.push(iteration);
      this.activeIterations.delete(sessionId);
    }
  }

  /**
   * Start tracking a tool execution
   */
  startToolSpan(
    sessionId: string,
    toolCallId: string,
    toolName: string,
    inputArgs: Record<string, unknown>,
  ): void {
    const span: ToolSpan = {
      toolName,
      toolCallId,
      startTime: Date.now(),
      inputArgs,
    };
    this.activeSpans.set(toolCallId, span);

    const trace = this.activeTraces.get(sessionId);
    if (trace) {
      trace.totalToolCalls++;
    }
  }

  /**
   * End a tool execution span
   */
  endToolSpan(
    sessionId: string,
    toolCallId: string,
    result: ToolSpan["result"],
  ): void {
    const span = this.activeSpans.get(toolCallId);
    const iteration = this.activeIterations.get(sessionId);
    const trace = this.activeTraces.get(sessionId);

    if (span) {
      span.endTime = Date.now();
      span.durationMs = span.endTime - span.startTime;
      span.result = result;

      if (iteration) {
        iteration.toolSpans.push(span);
      }

      if (trace && result && !result.success) {
        trace.failedToolCalls++;
      }

      this.activeSpans.delete(toolCallId);

      // Log individual span
      const status = result?.success ? "✓" : "✗";
      Zotero.debug(
        `[seerai][trace] ${status} ${span.toolName} (${span.durationMs.toFixed(0)}ms)`,
      );
    }
  }

  /**
   * End a trace session and return the complete trace
   */
  endSession(sessionId: string, success: boolean): AgentTrace | undefined {
    const trace = this.activeTraces.get(sessionId);

    if (trace) {
      // End any active iteration
      this.endIteration(sessionId);

      trace.endTime = Date.now();
      trace.totalDurationMs = trace.endTime - trace.startTime;
      trace.finalSuccess = success;

      // Clean up
      this.activeTraces.delete(sessionId);

      // Log summary
      Zotero.debug(`[seerai][trace] Session complete: ${sessionId}`);
      Zotero.debug(
        `[seerai][trace] Duration: ${trace.totalDurationMs.toFixed(0)}ms`,
      );
      Zotero.debug(`[seerai][trace] Iterations: ${trace.iterations.length}`);
      Zotero.debug(
        `[seerai][trace] Tool calls: ${trace.totalToolCalls} (${trace.failedToolCalls} failed)`,
      );

      return trace;
    }

    return undefined;
  }

  /**
   * Export trace as structured JSON (for debugging)
   */
  exportTrace(trace: AgentTrace): string {
    return JSON.stringify(trace, null, 2);
  }

  /**
   * Get a summary of tool execution times for the session
   */
  getExecutionSummary(trace: AgentTrace): string {
    const toolTimes = new Map<string, { count: number; totalMs: number }>();

    for (const iteration of trace.iterations) {
      for (const span of iteration.toolSpans) {
        const existing = toolTimes.get(span.toolName) || {
          count: 0,
          totalMs: 0,
        };
        existing.count++;
        existing.totalMs += span.durationMs || 0;
        toolTimes.set(span.toolName, existing);
      }
    }

    const lines: string[] = [`Agent Session Summary (${trace.sessionId}):`];
    lines.push(`  Total Duration: ${trace.totalDurationMs?.toFixed(0) || 0}ms`);
    lines.push(`  Iterations: ${trace.iterations.length}`);
    lines.push(`  Tool Breakdown:`);

    for (const [tool, stats] of toolTimes) {
      const avgMs = stats.totalMs / stats.count;
      lines.push(`    - ${tool}: ${stats.count}x (avg ${avgMs.toFixed(0)}ms)`);
    }

    return lines.join("\n");
  }
}

/**
 * Singleton tracer instance
 */
export const agentTracer = new AgentTracer();
