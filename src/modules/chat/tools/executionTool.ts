import { ToolResult } from "./toolTypes";
import {
  execShell,
  execCode as nativeExecCode,
  startBackgroundProcess,
  pollProcess,
  killProcess,
  getMetrics,
  checkEnvironment as nativeCheckEnvironment,
} from "./nativeExecution";

function isEnabled(): boolean {
  try {
    const enabled = Zotero.Prefs.get(
      "extensions.seerai.enableTerminalExecution",
    );
    return enabled === true;
  } catch {
    return false;
  }
}

export async function executeTerminal(args: {
  command: string;
  workdir?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  background?: boolean;
}): Promise<ToolResult> {
  if (!isEnabled()) {
    return {
      success: false,
      error:
        "Terminal execution is not enabled. Enable 'Terminal Execution' in SeerAI preferences.",
    };
  }

  if (!getMetrics().isExecAvailable) {
    return {
      success: false,
      error:
        "Native shell execution is not available in this Zotero version. Zotero.Utilities.Internal.exec is required.",
    };
  }

  if (args.background) {
    try {
      const { processId, pid } = await startBackgroundProcess({
        command: args.command,
        workdir: args.workdir,
      });
      return {
        success: true,
        data: {
          processId,
          pid,
          command: args.command,
          startedAt: new Date().toISOString(),
        },
        summary: `Started background process ${processId} (PID: ${pid})`,
      };
    } catch (e: any) {
      return {
        success: false,
        error: `Failed to start background process: ${e?.message || e}`,
      };
    }
  }

  try {
    const result = await execShell({
      command: args.command,
      workdir: args.workdir,
      timeoutMs: args.timeoutMs,
      maxOutputBytes: args.maxOutputBytes,
    });

    const escaped = args.command.slice(0, 80);
    return {
      success: true,
      data: {
        command: args.command,
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
      },
      summary: `Executed: ${escaped}${args.command.length > 80 ? "..." : ""} (exit ${result.exitCode})`,
    };
  } catch (e: any) {
    return {
      success: false,
      error: `Execution failed: ${e?.message || e}`,
    };
  }
}

export async function executeProcess(args: {
  action: "list" | "poll" | "log" | "wait" | "kill" | "write";
  processId?: string;
  input?: string;
  timeoutMs?: number;
}): Promise<ToolResult> {
  if (!isEnabled()) {
    return { success: false, error: "Process management is not enabled." };
  }

  if (args.action === "list") {
    const { getMetrics } = await import("./nativeExecution");
    const metrics = getMetrics();
    return {
      success: true,
      data: {
        backgroundProcessCount: metrics.backgroundProcessCount,
      },
      summary: `${metrics.backgroundProcessCount} background process(es)`,
    };
  }

  if (!args.processId) {
    return {
      success: false,
      error: "processId is required for this action",
    };
  }

  if (args.action === "kill") {
    const result = await killProcess(args.processId);
    return {
      success: result.success,
      data: { processId: args.processId },
      summary: result.success
        ? `Killed process ${args.processId}`
        : `Process ${args.processId} not found`,
    };
  }

  try {
    const status = await pollProcess(args.processId);
    return {
      success: true,
      data: {
        processId: args.processId,
        running: status.running,
        stdout: status.stdout,
        stderr: status.stderr,
        exitCode: status.exitCode,
      },
      summary: status.running
        ? `Process ${args.processId} is still running`
        : `Process ${args.processId} exited with code ${status.exitCode}`,
    };
  } catch (e: any) {
    return {
      success: false,
      error: `Failed to poll process: ${e?.message || e}`,
    };
  }
}

export async function executeCode(args: {
  language: "python" | "javascript" | "bash";
  code: string;
  workdir?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
}): Promise<ToolResult> {
  if (!isEnabled()) {
    return { success: false, error: "Code execution is not enabled." };
  }

  if (!getMetrics().isExecAvailable) {
    return {
      success: false,
      error: "Native execution is not available.",
    };
  }

  try {
    const result = await nativeExecCode({
      language: args.language,
      code: args.code,
      workdir: args.workdir,
      timeoutMs: args.timeoutMs,
      maxOutputBytes: args.maxOutputBytes,
    });

    return {
      success: true,
      data: {
        language: args.language,
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
        codeLength: args.code.length,
      },
      summary: `${args.language} snippet executed (exit ${result.exitCode})`,
    };
  } catch (e: any) {
    return {
      success: false,
      error: `Code execution failed: ${e?.message || e}`,
    };
  }
}

export async function checkEnvironment(
  _args?: Record<string, unknown>,
): Promise<ToolResult> {
  try {
    const info = await nativeCheckEnvironment();
    return {
      success: true,
      data: info,
      summary: [
        info.pythonVersion
          ? `Python: ${info.pythonVersion}`
          : "Python: not found",
        info.nodeVersion ? `Node: ${info.nodeVersion}` : "Node: not found",
        info.gitVersion ? `Git: ${info.gitVersion}` : "Git: not found",
        info.bashAvailable ? "Shell: available" : "Shell: unavailable",
        info.errors.length > 0 ? `Warnings: ${info.errors.join("; ")}` : "",
      ]
        .filter(Boolean)
        .join(" | "),
    };
  } catch (e: any) {
    return {
      success: false,
      error: `Environment check failed: ${e?.message || e}`,
    };
  }
}
