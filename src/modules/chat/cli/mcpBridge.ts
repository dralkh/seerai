import { config } from "../../../../package.json";
import { runCliCapture, getEnvVar } from "./cliRunner";

// `rootURI` is a global injected by the Zotero plugin bootstrap — the addon's
// resource base (the same one the skills loader fetches from). Declared
// ambiently for the plugin runtime.
declare const rootURI: string | undefined;

/** MCP server name the harness sees; tools appear as mcp__seerai-zotero__*. */
export const MCP_SERVER_NAME = "seerai-zotero";

/**
 * Toolsets to enable for a Hermes one-shot (`-t`). Hermes puts each MCP server's
 * tools in a per-server toolset (named by the server), and `-z` does NOT enable
 * MCP toolsets by default — so we must pass the base CLI toolset + the server.
 */
export const HERMES_TOOLSETS = `hermes-cli,${MCP_SERVER_NAME}`;

/** Asset name shipped inside the XPI and copied to disk for spawning. */
const MCP_SERVER_ASSET = "seerai-mcp.cjs";

/**
 * Env the spawned MCP server process needs: where to call back into the running
 * plugin, stdio-only (no extra HTTP listener), no terminal tools, and the
 * research-only tool profile (the harness already has its own file/bash tools).
 */
export function buildMcpEnv(): Record<string, string> {
  return {
    ZOTERO_API_URL: "http://127.0.0.1:23119",
    SEERAI_EXEC_PORT: "0",
    SEERAI_ENABLE_TERMINAL_TOOLS: "0",
    SEERAI_MCP_TOOL_PROFILE: "research",
  };
}

/**
 * Claude Code MCP config (for `--mcp-config <file>`): a single stdio server that
 * runs the bundled seerai-mcp.cjs under Node.
 */
export function buildClaudeMcpConfig(
  serverPath: string,
  env: Record<string, string>,
): { mcpServers: Record<string, unknown> } {
  return {
    mcpServers: {
      [MCP_SERVER_NAME]: {
        command: "node",
        args: [serverPath],
        env,
      },
    },
  };
}

/**
 * Codex `-c` config overrides registering the same stdio MCP server, plus
 * enabling localhost network access under the workspace-write sandbox so the
 * server can reach the plugin's HTTP API. Each entry is a separate `-c` arg.
 */
export function buildCodexMcpArgs(
  serverPath: string,
  env: Record<string, string>,
): string[] {
  const base = `mcp_servers.${MCP_SERVER_NAME}`;
  const envToml = Object.entries(env)
    .map(([k, v]) => `${k}="${v}"`)
    .join(", ");
  return [
    "-c",
    `${base}.command="node"`,
    "-c",
    `${base}.args=["${serverPath}"]`,
    "-c",
    `${base}.env={${envToml}}`,
    // Allow the MCP server subprocess to reach 127.0.0.1:23119.
    "-c",
    "sandbox_workspace_write.network_access=true",
  ];
}

let cachedServerPath: Promise<string | null> | null = null;

/**
 * Ensure the bundled seerai-mcp.cjs exists on disk and return its absolute path
 * so a harness can spawn `node <path>`. The file ships inside the XPI; we copy
 * it to a stable DataDir location, which works whether the addon is installed
 * packed or unpacked. Cached for the session (refreshed on plugin reload).
 */
export function ensureMcpServerOnDisk(): Promise<string | null> {
  if (!cachedServerPath) cachedServerPath = copyMcpServer();
  return cachedServerPath;
}

async function copyMcpServer(): Promise<string | null> {
  try {
    if (typeof rootURI !== "string") return null;
    const destDir = PathUtils.join(
      Zotero.DataDirectory.dir,
      config.addonRef,
      "bin",
    );
    const dest = PathUtils.join(destDir, MCP_SERVER_ASSET);
    const res = await fetch(`${rootURI}${MCP_SERVER_ASSET}`);
    if (!res.ok) {
      Zotero.debug(
        `[seerai] mcp server asset not found in addon (${res.status})`,
      );
      return null;
    }
    const text = await res.text();
    if (!text || text.length < 1000) return null; // sanity: not the real bundle
    await IOUtils.makeDirectory(destDir, { ignoreExisting: true });
    await IOUtils.writeUTF8(dest, text);
    return dest;
  } catch (e) {
    Zotero.debug(`[seerai] ensureMcpServerOnDisk failed: ${e}`);
    return null;
  }
}

let cachedNodePath: Promise<string | null> | null = null;

/**
 * Resolve the ABSOLUTE path to the user's `node` (e.g. an nvm install). Harness
 * configs must use the absolute path: when a harness later spawns the MCP server
 * in a non-login context, a bare `node` may not be on PATH. `process.execPath`
 * is node's own absolute path.
 */
export function resolveNodePath(): Promise<string | null> {
  if (!cachedNodePath) {
    cachedNodePath = runCliCapture(
      "node",
      ["-e", "process.stdout.write(process.execPath)"],
      6000,
    )
      .then((r) => {
        const p = r.stdout.trim();
        return p.length > 3 && /node/i.test(p) ? p : null;
      })
      .catch(() => null);
  }
  return cachedNodePath;
}

/** Whether `node` resolves (needed to run the server). */
export async function isNodeAvailable(): Promise<boolean> {
  return !!(await resolveNodePath());
}

// ── Connected-state pref ───────────────────────────────────────────────────
// Tracks which persistent-config harnesses the user has Connected. Claude/Codex
// attach MCP per-invocation, so they always count as connected (in agentic mode).

const AUTO_CONNECTED = new Set(["claude", "codex"]);
const CONNECTED_PREF = `${config.prefsPrefix}.mcpConnectedHarnesses`;

function connectedMap(): Record<string, boolean> {
  try {
    const raw = Zotero.Prefs.get(CONNECTED_PREF, true);
    return typeof raw === "string" && raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

export function isHarnessConnected(agentId: string): boolean {
  if (AUTO_CONNECTED.has(agentId)) return true;
  return connectedMap()[agentId] === true;
}

function setHarnessConnectedPref(agentId: string, connected: boolean): void {
  const map = connectedMap();
  if (connected) map[agentId] = true;
  else delete map[agentId];
  Zotero.Prefs.set(CONNECTED_PREF, JSON.stringify(map), true);
}

// ── Per-harness Connect / Disconnect (persistent HOME config) ──────────────

function homePath(...parts: string[]): string | null {
  const home = getEnvVar("HOME") || getEnvVar("USERPROFILE");
  return home ? PathUtils.join(home, ...parts) : null;
}

/** HOME config path for the harnesses that register MCP via a JSON file. */
function jsonConfigPath(agentId: string): string | null {
  if (agentId === "antigravity")
    return homePath(".gemini", "config", "mcp_config.json");
  if (agentId === "openclaw") return homePath(".openclaw", "openclaw.json");
  return null;
}

/**
 * Pure: add or remove the seerai-zotero entry in a parsed `{ mcpServers }`
 * config object, preserving every other server. Exported for testing.
 */
export function applyMcpServerEntry(
  cfg: Record<string, unknown>,
  entry: Record<string, unknown> | null,
  connect: boolean,
): Record<string, unknown> {
  const servers = (
    cfg.mcpServers && typeof cfg.mcpServers === "object" ? cfg.mcpServers : {}
  ) as Record<string, unknown>;
  if (connect && entry) {
    servers[MCP_SERVER_NAME] = entry;
  } else {
    delete servers[MCP_SERVER_NAME];
  }
  cfg.mcpServers = servers;
  return cfg;
}

/** The stdio server entry written into a harness config (absolute node + env). */
function serverEntry(
  nodePath: string,
  serverPath: string,
): Record<string, unknown> {
  return { command: nodePath, args: [serverPath], env: buildMcpEnv() };
}

/** Add or remove the seerai-zotero entry in a `{ mcpServers: {…} }` JSON file. */
async function mergeJsonMcpServer(
  path: string,
  entry: Record<string, unknown> | null,
  connect: boolean,
): Promise<void> {
  let cfg: Record<string, unknown> = {};
  try {
    if (await IOUtils.exists(path)) {
      const raw = await IOUtils.readUTF8(path);
      if (raw.trim()) {
        cfg = JSON.parse(raw);
        await IOUtils.writeUTF8(`${path}.seerai-bak`, raw); // backup
      }
    }
  } catch {
    cfg = {};
  }
  applyMcpServerEntry(cfg, entry, connect);
  const dir = PathUtils.parent(path);
  if (dir) await IOUtils.makeDirectory(dir, { ignoreExisting: true });
  await IOUtils.writeUTF8(path, `${JSON.stringify(cfg, null, 2)}\n`);
}

export interface ConnectResult {
  ok: boolean;
  message: string;
}

/** Register seerai's MCP server in a persistent-config harness (one-click). */
export async function connectHarness(agentId: string): Promise<ConnectResult> {
  try {
    if (AUTO_CONNECTED.has(agentId)) {
      return {
        ok: true,
        message: `${agentId} attaches seerai automatically each agentic session.`,
      };
    }
    const serverPath = await ensureMcpServerOnDisk();
    const nodePath = await resolveNodePath();
    if (!serverPath || !nodePath) {
      return {
        ok: false,
        message:
          "Node.js was not found, or the seerai MCP server bundle could not be prepared. Install Node ≥18 and launch Zotero from a terminal, then retry.",
      };
    }

    const jsonPath = jsonConfigPath(agentId);
    if (jsonPath) {
      await mergeJsonMcpServer(
        jsonPath,
        serverEntry(nodePath, serverPath),
        true,
      );
    } else if (agentId === "hermes") {
      // `hermes mcp add` connects to the server to discover tools, then prompts
      // "Enable all N tools? [Y/n]" — auto-confirm with "y" on stdin. Absolute
      // node + --env avoids PATH issues (the launcher approach failed under nvm).
      const envArgs = Object.entries(buildMcpEnv()).map(
        ([k, v]) => `${k}=${v}`,
      );
      const r = await runCliCapture(
        "hermes",
        [
          "mcp",
          "add",
          MCP_SERVER_NAME,
          "--command",
          nodePath,
          "--env",
          ...envArgs,
          "--args",
          serverPath,
        ],
        30000,
        "y\n",
      );
      const out = `${r.stdout}\n${r.stderr}`;
      if (!/saved|already|exists|enabled/i.test(out)) {
        return {
          ok: false,
          message: `hermes mcp add did not confirm: ${out.trim().slice(0, 300)}`,
        };
      }
    } else {
      return { ok: false, message: `Unknown harness "${agentId}".` };
    }

    setHarnessConnectedPref(agentId, true);
    return {
      ok: true,
      message:
        "Connected. New harness sessions will have seerai's research tools.",
    };
  } catch (e) {
    return {
      ok: false,
      message: `Connect failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

/** Remove seerai's MCP server from a persistent-config harness. */
export async function disconnectHarness(
  agentId: string,
): Promise<ConnectResult> {
  try {
    const jsonPath = jsonConfigPath(agentId);
    if (jsonPath) {
      await mergeJsonMcpServer(jsonPath, null, false);
    } else if (agentId === "hermes") {
      await runCliCapture("hermes", ["mcp", "remove", MCP_SERVER_NAME], 15000);
    }
    setHarnessConnectedPref(agentId, false);
    return { ok: true, message: "Disconnected." };
  } catch (e) {
    return {
      ok: false,
      message: `Disconnect failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}
