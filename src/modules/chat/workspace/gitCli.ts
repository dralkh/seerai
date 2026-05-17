/**
 * Git CLI — Real git commands via Zotero process APIs.
 *
 * Detection: Try Zotero.Utilities.Internal.subprocess() first (captures
 * stdout directly), then fall back to exec() + file redirect.
 * Execution: exec() + file redirect (captures stdout, stderr, exit code).
 * Uses nsIProcess under the hood (stable, waits for completion).
 */

import { config } from "../../../../package.json";

interface GitResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

let _gitAvailable: boolean | null = null;
let _gitPath: string | null = null;
let _method: "subprocess" | "exec" | null = null;
let _idCounter = 0;

function nextId(): number {
  return ++_idCounter;
}

function getTmpDir(): string {
  return PathUtils.join(Zotero.DataDirectory.dir, config.addonRef, "tmp");
}

async function ensureTmpDir(): Promise<string> {
  const dir = getTmpDir();
  try {
    await IOUtils.makeDirectory(dir, { ignoreExisting: true });
  } catch (e) {
    Zotero.debug(`[seerai] gitCli: ensureTmpDir failed for ${dir}: ${e}`);
    throw e;
  }
  return dir;
}

function shellEscape(s: string): string {
  if (Zotero.isWin) return `"${s.replace(/"/g, '\\"')}"`;
  return `'${s.replace(/'/g, "'\\''")}'`;
}

const GIT_CANDIDATES_UNIX = [
  "/usr/bin/git",
  "/usr/local/bin/git",
  "/opt/homebrew/bin/git",
  "git",
];

const GIT_CANDIDATES_WIN = [
  "C:\\Program Files\\Git\\cmd\\git.exe",
  "C:\\Program Files (x86)\\Git\\cmd\\git.exe",
  "git.exe",
  "git.cmd",
];

async function trySubprocess(
  command: string,
  args: string[],
): Promise<string | null> {
  try {
    if (typeof (Zotero.Utilities.Internal as any).subprocess !== "function") {
      Zotero.debug("[seerai] gitCli: subprocess not available");
      return null;
    }
    const result = await (Zotero.Utilities.Internal as any).subprocess(
      command,
      args,
    );
    if (typeof result === "string") {
      return result;
    }
    Zotero.debug(
      `[seerai] gitCli: subprocess returned non-string: ${typeof result}`,
    );
    return null;
  } catch (e) {
    Zotero.debug(`[seerai] gitCli: subprocess threw: ${e}`);
    return null;
  }
}

async function tryExecRedirect(
  workspaceDir: string | null,
  args: string[],
  gitBin: string,
): Promise<GitResult | null> {
  let tmpDir: string;
  try {
    tmpDir = await ensureTmpDir();
  } catch (e) {
    Zotero.debug(`[seerai] gitCli: tryExecRedirect cannot create tmpDir: ${e}`);
    return null;
  }

  const id = nextId();
  const outPath = PathUtils.join(tmpDir, `git_out_${id}.txt`);
  const errPath = PathUtils.join(tmpDir, `git_err_${id}.txt`);
  const exitPath = PathUtils.join(tmpDir, `git_exit_${id}.txt`);

  const gitArgs = args.map(shellEscape).join(" ");
  const cdPart = workspaceDir ? `cd ${shellEscape(workspaceDir)} && ` : "";
  const fullCmd = `${cdPart}${shellEscape(gitBin)} ${gitArgs} > ${shellEscape(outPath)} 2> ${shellEscape(errPath)}; echo $? > ${shellEscape(exitPath)}`;

  const shell = Zotero.isWin ? "cmd.exe" : "/bin/sh";
  const shellFlag = Zotero.isWin ? "/c" : "-c";

  Zotero.debug(
    `[seerai] gitCli: exec redirect: ${shell} ${shellFlag} ${fullCmd}`,
  );

  try {
    const result = await (Zotero.Utilities.Internal as any).exec(shell, [
      shellFlag,
      fullCmd,
    ]);
    Zotero.debug(
      `[seerai] gitCli: exec result type: ${typeof result}, value: ${result}`,
    );
  } catch (e) {
    Zotero.debug(`[seerai] gitCli: exec threw: ${e}`);
  }

  let stdout = "";
  let stderr = "";
  let exitCode = 1;

  try {
    stdout = new TextDecoder().decode(await IOUtils.read(outPath));
    void IOUtils.remove(outPath).catch(() => {});
  } catch (e) {
    Zotero.debug(`[seerai] gitCli: could not read stdout file: ${e}`);
  }
  try {
    stderr = new TextDecoder().decode(await IOUtils.read(errPath));
    void IOUtils.remove(errPath).catch(() => {});
  } catch (e) {
    Zotero.debug(`[seerai] gitCli: could not read stderr file: ${e}`);
  }
  try {
    const exitStr = new TextDecoder()
      .decode(await IOUtils.read(exitPath))
      .trim();
    exitCode = parseInt(exitStr, 10);
    if (isNaN(exitCode) || exitCode < 0) {
      Zotero.debug(
        `[seerai] gitCli: unparseable exit code: "${exitStr}", assuming 0 for git ${args.join(" ")}`,
      );
      exitCode = 0;
    }
    void IOUtils.remove(exitPath).catch(() => {});
  } catch (e) {
    Zotero.debug(`[seerai] gitCli: could not read exit code file: ${e}`);
  }

  Zotero.debug(
    `[seerai] gitCli: exec redirect result: exit=${exitCode} stdout=${stdout.length}B stderr=${stderr.length}B`,
  );

  if (!stdout && !stderr && exitCode === 1) {
    Zotero.debug("[seerai] gitCli: exec redirect produced no output at all");
    return null;
  }

  return { stdout, stderr, exitCode };
}

async function resolveGitPath(): Promise<string | null> {
  if (_gitPath !== null) return _gitPath;

  Zotero.debug("[seerai] gitCli: resolving git path...");

  const candidates = Zotero.isWin ? GIT_CANDIDATES_WIN : GIT_CANDIDATES_UNIX;

  for (const candidate of candidates) {
    Zotero.debug(`[seerai] gitCli: trying candidate: ${candidate}`);

    const subResult = await trySubprocess(candidate, ["--version"]);
    if (subResult && subResult.includes("git version")) {
      _gitPath = candidate;
      _method = "subprocess";
      Zotero.debug(
        `[seerai] gitCli: found git via subprocess at ${candidate}: ${subResult.trim()}`,
      );
      return _gitPath;
    }

    Zotero.debug(
      `[seerai] gitCli: subprocess failed for ${candidate}, trying exec redirect`,
    );
    const execResult = await tryExecRedirect(null, ["--version"], candidate);
    if (
      execResult &&
      execResult.exitCode === 0 &&
      execResult.stdout.includes("git version")
    ) {
      _gitPath = candidate;
      _method = "exec";
      Zotero.debug(
        `[seerai] gitCli: found git via exec at ${candidate}: ${execResult.stdout.trim()}`,
      );
      return _gitPath;
    }
  }

  _gitPath = null;
  Zotero.debug(
    `[seerai] gitCli: git not found at any candidate path (tried: ${candidates.join(", ")})`,
  );
  return null;
}

export async function isGitAvailable(): Promise<boolean> {
  if (_gitAvailable !== null) return _gitAvailable;

  Zotero.debug("[seerai] gitCli: isGitAvailable() called, checking...");

  try {
    const gitBin = await resolveGitPath();
    if (!gitBin) {
      _gitAvailable = false;
      Zotero.debug(
        "[seerai] gitCli: git CLI not available; version control disabled",
      );
      return false;
    }

    Zotero.debug(
      `[seerai] gitCli: git found at ${gitBin}, method=${_method}, verifying...`,
    );

    let verified = false;

    if (_method === "subprocess") {
      const subResult = await trySubprocess(gitBin, ["--version"]);
      if (subResult && subResult.includes("git version")) {
        verified = true;
      } else {
        Zotero.debug(
          `[seerai] gitCli: subprocess verification failed, trying exec`,
        );
        const execResult = await tryExecRedirect(null, ["--version"], gitBin);
        if (
          execResult &&
          execResult.exitCode === 0 &&
          execResult.stdout.includes("git version")
        ) {
          _method = "exec";
          verified = true;
        }
      }
    } else {
      const execResult = await tryExecRedirect(null, ["--version"], gitBin);
      if (
        execResult &&
        execResult.exitCode === 0 &&
        execResult.stdout.includes("git version")
      ) {
        verified = true;
      }
    }

    _gitAvailable = verified;

    if (_gitAvailable) {
      Zotero.debug("[seerai] gitCli: git CLI available and verified");
    } else {
      Zotero.debug("[seerai] gitCli: git CLI verification failed");
    }
  } catch (e) {
    Zotero.debug(`[seerai] gitCli: isGitAvailable threw: ${e}`);
    _gitAvailable = false;
  }

  return _gitAvailable;
}

export async function execGit(
  workspaceDir: string,
  args: string[],
): Promise<GitResult> {
  if (_gitAvailable === false) {
    return { stdout: "", stderr: "git is not available", exitCode: 1 };
  }

  const gitBin = _gitPath || (await resolveGitPath());
  if (!gitBin) {
    _gitAvailable = false;
    return { stdout: "", stderr: "git is not available", exitCode: 1 };
  }

  // Always use exec+file redirect for reliable exit code capture.
  // subprocess() doesn't capture stderr or exit codes.
  const result = await tryExecRedirect(workspaceDir, args, gitBin);
  if (result) {
    if (result.exitCode === 127) {
      _gitAvailable = false;
      _gitPath = null;
    }
    return result;
  }

  return { stdout: "", stderr: "git execution failed", exitCode: 1 };
}

export function resetGitAvailability(): void {
  _gitAvailable = null;
  _gitPath = null;
  _method = null;
  Zotero.debug("[seerai] gitCli: availability reset");
}

export async function debugGitCli(): Promise<string> {
  const lines: string[] = [];
  lines.push("=== Git CLI Debug ===");
  lines.push(`_gitAvailable: ${_gitAvailable}`);
  lines.push(`_gitPath: ${_gitPath}`);
  lines.push(`_method: ${_method}`);
  lines.push(`isWin: ${Zotero.isWin}`);
  lines.push(`dataDir: ${Zotero.DataDirectory.dir}`);
  lines.push(`tmpDir: ${getTmpDir()}`);

  lines.push("\n--- API availability ---");
  lines.push(
    `typeof Zotero.Utilities.Internal.exec: ${typeof (Zotero.Utilities.Internal as any).exec}`,
  );
  lines.push(
    `typeof Zotero.Utilities.Internal.subprocess: ${typeof (Zotero.Utilities.Internal as any).subprocess}`,
  );

  lines.push("\n--- Testing tmpDir ---");
  try {
    const tmpDir = await ensureTmpDir();
    lines.push(`tmpDir created: ${tmpDir}`);
    lines.push(`tmpDir exists: ${await IOUtils.exists(tmpDir)}`);
  } catch (e) {
    lines.push(`tmpDir FAILED: ${e}`);
  }

  lines.push("\n--- Testing exec with simple cmd ---");
  try {
    const result = await (Zotero.Utilities.Internal as any).exec("/bin/sh", [
      "-c",
      "echo hello",
    ]);
    lines.push(
      `exec("/bin/sh", ["-c", "echo hello"]) => type=${typeof result}, value=${JSON.stringify(result)}`,
    );
  } catch (e) {
    lines.push(`exec threw: ${e}`);
  }

  lines.push("\n--- Testing exec with git --version redirect ---");
  try {
    const tmpDir = await ensureTmpDir();
    const testOut = PathUtils.join(tmpDir, "debug_git_version.txt");
    const cmd = `/usr/bin/git --version > '${testOut}' 2>&1; echo $? >> '${testOut}'`;
    lines.push(`Running: /bin/sh -c "${cmd}"`);
    const result = await (Zotero.Utilities.Internal as any).exec("/bin/sh", [
      "-c",
      cmd,
    ]);
    lines.push(
      `exec result: type=${typeof result}, value=${JSON.stringify(result)}`,
    );
    try {
      const content = new TextDecoder().decode(await IOUtils.read(testOut));
      lines.push(`file content: ${content}`);
    } catch (e) {
      lines.push(`reading output file FAILED: ${e}`);
    }
    void IOUtils.remove(testOut).catch(() => {});
  } catch (e) {
    lines.push(`exec redirect threw: ${e}`);
  }

  lines.push("\n--- Testing subprocess ---");
  try {
    if (typeof (Zotero.Utilities.Internal as any).subprocess === "function") {
      const result = await (Zotero.Utilities.Internal as any).subprocess(
        "/usr/bin/git",
        ["--version"],
      );
      lines.push(
        `subprocess("/usr/bin/git", ["--version"]) => type=${typeof result}, value=${JSON.stringify(result)}`,
      );
    } else {
      lines.push("subprocess not available");
    }
  } catch (e) {
    lines.push(`subprocess threw: ${e}`);
  }

  lines.push("\n--- Full resolveGitPath ---");
  resetGitAvailability();
  const gitPath = await resolveGitPath();
  lines.push(`resolveGitPath result: ${gitPath}`);
  lines.push(`_method: ${_method}`);

  lines.push("\n--- Full isGitAvailable ---");
  resetGitAvailability();
  const available = await isGitAvailable();
  lines.push(`isGitAvailable result: ${available}`);

  lines.push("\n=== Debug Complete ===");
  const output = lines.join("\n");
  Zotero.debug(`[seerai] ${output}`);
  return output;
}

export function parseGitStatus(
  porcelain: string,
): Array<{ path: string; x: string; y: string; origPath?: string }> {
  const entries: Array<{
    path: string;
    x: string;
    y: string;
    origPath?: string;
  }> = [];

  for (const line of porcelain.split("\n")) {
    if (!line) continue;
    if (line.startsWith("1 ")) {
      // Format: 1 <xy> <sub> <mH> <mI> <mW> <hH> <hI> <path>
      // Fields:  0  1    2    3    4    5    6    7    8+
      // path may contain spaces, so take everything from field 8 onward
      const x = line[2];
      const y = line[3];
      const parts = line.split(" ");
      const pathPart = parts.slice(8).join(" ");
      if (!pathPart) continue;
      entries.push({ path: pathPart, x, y });
    } else if (line.startsWith("2 ")) {
      // Format: 2 <xy> <sub> <mH> <mI> <mW> <hH> <hI> <origPath> <path>
      // Renamed entries have two paths separated by tab in the last field
      const x = line[2];
      const y = line[3];
      const parts = line.split(" ");
      const lastField = parts.slice(8).join(" ");
      const tabIdx = lastField.indexOf("\t");
      let origPath: string | undefined;
      let pathPart: string;
      if (tabIdx !== -1) {
        origPath = lastField.slice(0, tabIdx);
        pathPart = lastField.slice(tabIdx + 1);
      } else {
        pathPart = lastField;
      }
      if (!pathPart) continue;
      entries.push({ path: pathPart, x, y, origPath });
    } else if (line.startsWith("? ")) {
      entries.push({ path: line.slice(2), x: "?", y: "?" });
    }
  }
  return entries;
}

export function parseGitLog(log: string): Array<{
  oid: string;
  message: string;
  authorName: string;
  authorEmail: string;
  timestamp: number;
}> {
  const commits: Array<{
    oid: string;
    message: string;
    authorName: string;
    authorEmail: string;
    timestamp: number;
  }> = [];

  for (const line of log.split("\n")) {
    if (!line || !line.includes("|")) continue;
    const parts = line.split("|");
    if (parts.length >= 5) {
      commits.push({
        oid: parts[0],
        message: parts.slice(1, -4).join("|"),
        authorName: parts[parts.length - 3],
        authorEmail: parts[parts.length - 2],
        timestamp: parseInt(parts[parts.length - 1]) || 0,
      });
    }
  }
  return commits;
}
