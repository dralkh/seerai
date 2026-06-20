import { isCliExecAvailable, runCliCapture } from "./cliRunner";
import { getCliAgent } from "./agents";
import { isAuthFailureText, type CliAgentDef } from "./cliTypes";

export interface CliDetectionResult {
  installed: boolean;
  authenticated: boolean;
  version?: string;
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

/**
 * Probe a locally installed agent CLI: is it on PATH, and (when it offers a
 * clean probe) is it logged in? Auth is entirely the CLI's — we only report its
 * state so the UI can point the user at the right login command when needed.
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

  let version: string | undefined;
  try {
    const ver = await runCliCapture(agent.bin, agent.versionArgs, 8000);
    const combined = `${ver.stdout}\n${ver.stderr}`;
    if (ver.exitCode !== 0 || looksLikeNotFound(combined)) {
      return notInstalled(agent);
    }
    version =
      (ver.stdout || ver.stderr || "").split("\n")[0]?.trim() || undefined;
  } catch {
    return notInstalled(agent);
  }

  // Installed. If the CLI has a clean auth probe, use it; otherwise report
  // installed and let runtime errors surface any auth failure.
  if (agent.authProbe) {
    try {
      const status = await runCliCapture(agent.bin, agent.authProbe.args, 8000);
      const combined = `${status.stdout}\n${status.stderr}`;
      const authed =
        status.exitCode === 0 && !isAuthFailureText(agent, combined);
      if (authed) return ready(agent, version);
      return {
        installed: true,
        authenticated: false,
        version,
        level: "warn",
        message: agent.loginGuidance,
      };
    } catch {
      return {
        installed: true,
        authenticated: false,
        version,
        level: "warn",
        message: agent.loginGuidance,
      };
    }
  }

  return {
    installed: true,
    authenticated: true,
    version,
    level: "ok",
    message: `${agent.name} detected${version ? ` (${version})` : ""}. seerai will use its existing login; if a request fails with an auth error, run \`${agent.loginCommand}\`.`,
  };
}

function ready(agent: CliAgentDef, version?: string): CliDetectionResult {
  return {
    installed: true,
    authenticated: true,
    version,
    level: "ok",
    message: `Signed in via ${agent.name}${version ? ` (${version})` : ""}.`,
  };
}

function notInstalled(agent: CliAgentDef): CliDetectionResult {
  return {
    installed: false,
    authenticated: false,
    level: "warn",
    message: agent.notFoundGuidance,
  };
}

/** Back-compat: detect Codex specifically. */
export function detectCodex(): Promise<CliDetectionResult> {
  return detectCliAgent("codex");
}
