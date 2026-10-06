import {
  clearCliPathCache,
  findCliBinary,
  isCliExecAvailable,
  runCliCapture,
  type CliCaptureResult,
} from "./cliRunner";
import { getCliAgent } from "./agents";
import { isAuthFailureText, type CliAgentDef } from "./cliTypes";

export interface CliDetectionResult {
  installed: boolean;
  authenticated: boolean;
  version?: string;
  /** Absolute path of the resolved binary, when found. */
  resolvedPath?: string;
  /** Human-readable status / next-step guidance for the settings UI. */
  message: string;
  /** "ok" when ready to use, "warn" when action needed, "error" when broken. */
  level: "ok" | "warn" | "error";
}

function looksLikeNotFound(text: string): boolean {
  return /command not found|not found|no such file|is not recognized|ENOENT/i.test(
    text,
  );
}

function firstLine(text: string): string | undefined {
  return text.split("\n")[0]?.trim() || undefined;
}

function notInstalled(agent: CliAgentDef, detail?: string): CliDetectionResult {
  const suffix = detail ? ` (${detail})` : "";
  return {
    installed: false,
    authenticated: false,
    level: "warn",
    message:
      agent.notFoundGuidance +
      ` Searched the usual install locations (homebrew, ~/.local/bin, npm/yarn/bun, nvm/fnm/mise/asdf, …)${suffix}. ` +
      `If it lives somewhere else, set the "Local CLI extra PATH" setting to that directory.`,
  };
}

/**
 * Probe a locally installed agent CLI: is it on disk, and (when it offers a
 * clean probe) is it logged in? The binary is resolved to an absolute path
 * without shelling out first, so detection keeps working when Zotero was
 * launched from the GUI with a minimal PATH (macOS) or the CLI was installed
 * through a version manager (nvm/fnm/mise/asdf) that only an interactive shell
 * rc would expose.
 */
export async function detectCliAgent(
  agentId: string | undefined,
): Promise<CliDetectionResult> {
  const agent = getCliAgent(agentId);
  if (!agent) {
    return {
      installed: false,
      authenticated: false,
      level: "error",
      message: `Unknown local CLI agent: ${agentId}`,
    };
  }
  if (!isCliExecAvailable()) {
    return {
      installed: false,
      authenticated: false,
      level: "error",
      message:
        "This Zotero build cannot launch local processes (Zotero.Utilities.Internal.exec is unavailable), so local CLI integrations can't run here.",
    };
  }

  // 1. Resolve the binary on disk. Only fall back to a shell probe when the
  //    filesystem search finds nothing (covers exotic setups). Refresh the
  //    cached search dirs so a just-installed CLI is picked up immediately.
  clearCliPathCache();
  let resolvedPath = await findCliBinary(agent.bin);
  let versionProbe: CliCaptureResult | null = null;
  if (!resolvedPath) {
    try {
      versionProbe = await runCliCapture(agent.bin, agent.versionArgs, 12000);
      resolvedPath = versionProbe.resolvedPath || null;
    } catch (e) {
      return notInstalled(agent, e instanceof Error ? e.message : String(e));
    }
    if (!resolvedPath && !versionProbe.stdout && !versionProbe.stderr) {
      return notInstalled(agent);
    }
    if (
      !resolvedPath &&
      (looksLikeNotFound(`${versionProbe.stdout}\n${versionProbe.stderr}`) ||
        versionProbe.exitCode !== 0)
    ) {
      const detail =
        firstLine(versionProbe.stderr) || firstLine(versionProbe.stdout);
      return notInstalled(agent, detail);
    }
  }

  // 2. Version probe (best effort — a slow shell must not mask a found binary).
  let version: string | undefined;
  if (resolvedPath) {
    try {
      versionProbe = await runCliCapture(
        resolvedPath,
        agent.versionArgs,
        12000,
      );
      if (versionProbe.exitCode === 0) {
        version = firstLine(versionProbe.stdout || versionProbe.stderr || "");
      }
    } catch {
      // Ignore — installed is already established by the filesystem search.
    }
  } else if (versionProbe) {
    version = firstLine(versionProbe.stdout || versionProbe.stderr || "");
  }

  // 3. Auth probe, when the CLI has a clean one.
  if (agent.authProbe && resolvedPath) {
    try {
      const status = await runCliCapture(
        resolvedPath,
        agent.authProbe.args,
        10000,
      );
      const combined = `${status.stdout}\n${status.stderr}`;
      const authed =
        status.exitCode === 0 && !isAuthFailureText(agent, combined);
      if (authed) return ready(agent, version, resolvedPath);
      return {
        installed: true,
        authenticated: false,
        version,
        resolvedPath,
        level: "warn",
        message: `${agent.loginGuidance} (found at ${resolvedPath})`,
      };
    } catch {
      return {
        installed: true,
        authenticated: false,
        version,
        resolvedPath,
        level: "warn",
        message: agent.loginGuidance,
      };
    }
  }

  return ready(agent, version, resolvedPath);
}

function ready(
  agent: CliAgentDef,
  version?: string,
  resolvedPath?: string | null,
): CliDetectionResult {
  const location = resolvedPath
    ? resolvedPath
    : `\`${agent.bin}\` on your PATH`;
  return {
    installed: true,
    authenticated: true,
    version,
    resolvedPath: resolvedPath || undefined,
    level: "ok",
    message: `${agent.name} detected at ${location}${
      version ? ` (${version})` : ""
    }. seerai will use its existing login; if a request fails with an auth error, run \`${agent.loginCommand}\`.`,
  };
}

/** Back-compat: detect Codex specifically. */
export function detectCodex(): Promise<CliDetectionResult> {
  return detectCliAgent("codex");
}
