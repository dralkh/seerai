import { config } from "../../../../package.json";
import { getWorkspaceStore } from "../workspace/store";

const EXEC_TIMEOUT = 30000;
const MAX_EXEC_TIMEOUT = 300000;
const DEFAULT_MAX_OUTPUT = 64 * 1024;

export interface NativeExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  killed?: boolean;
}

interface BackgroundProcess {
  pid: number | null;
  command: string;
  workdir: string;
  startedAt: string;
  outPath: string;
  errPath: string;
  exitPath: string;
}

const backgroundProcesses = new Map<string, BackgroundProcess>();
let _idCounter = 0;

function nextId(): number {
  return ++_idCounter;
}

function getTmpDir(): string {
  return PathUtils.join(Zotero.DataDirectory.dir, config.addonRef, "tmp");
}

async function ensureTmpDir(): Promise<string> {
  const dir = getTmpDir();
  await IOUtils.makeDirectory(dir, { ignoreExisting: true });
  return dir;
}

function shellEscape(s: string): string {
  if (Zotero.isWin) return `"${s.replace(/"/g, '\\"')}"`;
  return `'${s.replace(/'/g, "'\\''")}'`;
}

function isExecAvailable(): boolean {
  return typeof (Zotero.Utilities.Internal as any).exec === "function";
}

function isSubprocessAvailable(): boolean {
  return typeof (Zotero.Utilities.Internal as any).subprocess === "function";
}

async function resolveWorkspaceDir(workdir?: string): Promise<string> {
  const store = getWorkspaceStore();
  const base = await store.resolveWorkspaceDir();
  if (!workdir) return base;
  const resolved = PathUtils.join(base, workdir);
  const normalized = resolved.replace(/\/+/g, "/").replace(/\/$/, "");
  if (normalized !== base && !normalized.startsWith(base + "/")) {
    throw new Error(`Working directory escapes workspace: "${workdir}"`);
  }
  return normalized;
}

function capOutput(output: string, maxBytes: number): string {
  const bytes = new TextEncoder().encode(output);
  if (bytes.length <= maxBytes) return output;
  return (
    new TextDecoder().decode(bytes.subarray(0, maxBytes)) +
    `\n[output truncated at ${maxBytes} bytes]`
  );
}

export async function execShell(options: {
  command: string;
  workdir?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  env?: Record<string, string>;
}): Promise<NativeExecResult> {
  const timeout = Math.min(options.timeoutMs || EXEC_TIMEOUT, MAX_EXEC_TIMEOUT);
  const maxOutput = Math.min(
    options.maxOutputBytes || DEFAULT_MAX_OUTPUT,
    256 * 1024,
  );

  const cwd = await resolveWorkspaceDir(options.workdir);
  const tmpDir = await ensureTmpDir();
  const id = nextId();

  const outPath = PathUtils.join(tmpDir, `seerai_out_${id}.txt`);
  const errPath = PathUtils.join(tmpDir, `seerai_err_${id}.txt`);
  const exitPath = PathUtils.join(tmpDir, `seerai_exit_${id}.txt`);

  let fullCmd: string;
  const shell = Zotero.isWin ? "cmd.exe" : "/bin/sh";
  const shellFlag = Zotero.isWin ? "/c" : "-c";

  if (Zotero.isWin) {
    const cdPart = `cd /d ${shellEscape(cwd)}`;
    fullCmd = `${cdPart} && ${options.command} > ${shellEscape(outPath)} 2> ${shellEscape(errPath)} & echo !errorlevel! > ${shellEscape(exitPath)}`;
  } else {
    const cdPart = `cd ${shellEscape(cwd)}`;
    fullCmd = `${cdPart} && { ${options.command}; } > ${shellEscape(outPath)} 2> ${shellEscape(errPath)}; echo $? > ${shellEscape(exitPath)}`;
  }

  Zotero.debug(`[seerai] nativeExec: ${shell} ${shellFlag} "${fullCmd}"`);

  try {
    await (Zotero.Utilities.Internal as any).exec(shell, [shellFlag, fullCmd]);
  } catch (e) {
    Zotero.debug(`[seerai] nativeExec: exec threw: ${e}`);
  }

  let stdout = "";
  let stderr = "";
  let exitCode = 1;
  const killed = false;

  try {
    const bytes = await IOUtils.read(outPath);
    stdout = new TextDecoder().decode(bytes);
    void IOUtils.remove(outPath).catch(() => {});
  } catch (e) {
    Zotero.debug(`[seerai] nativeExec: could not read stdout: ${e}`);
  }
  try {
    const bytes = await IOUtils.read(errPath);
    stderr = new TextDecoder().decode(bytes);
    void IOUtils.remove(errPath).catch(() => {});
  } catch (e) {
    Zotero.debug(`[seerai] nativeExec: could not read stderr: ${e}`);
  }
  try {
    const bytes = await IOUtils.read(exitPath);
    const exitStr = new TextDecoder().decode(bytes).trim();
    exitCode = parseInt(exitStr, 10);
    if (isNaN(exitCode)) exitCode = 1;
    void IOUtils.remove(exitPath).catch(() => {});
  } catch (e) {
    Zotero.debug(`[seerai] nativeExec: could not read exit code: ${e}`);
  }

  Zotero.debug(
    `[seerai] nativeExec: exit=${exitCode} stdout=${stdout.length}B stderr=${stderr.length}B`,
  );

  return {
    stdout: capOutput(stdout.trimEnd(), maxOutput),
    stderr: capOutput(stderr.trimEnd(), maxOutput),
    exitCode,
    killed,
  };
}

export async function execCode(options: {
  language: "python" | "javascript" | "bash";
  code: string;
  workdir?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
}): Promise<NativeExecResult> {
  const cwd = await resolveWorkspaceDir(options.workdir);
  const ext =
    options.language === "python"
      ? "py"
      : options.language === "javascript"
        ? "js"
        : "sh";
  const tmpDir = await ensureTmpDir();
  const id = nextId();
  const codePath = PathUtils.join(tmpDir, `seerai_code_${id}.${ext}`);

  await IOUtils.writeUTF8(codePath, options.code);

  const runner =
    options.language === "python"
      ? `python3 ${shellEscape(codePath)}`
      : options.language === "javascript"
        ? `node ${shellEscape(codePath)}`
        : `bash ${shellEscape(codePath)}`;

  const result = await execShell({
    command: runner,
    timeoutMs: options.timeoutMs,
    maxOutputBytes: options.maxOutputBytes,
  });

  void IOUtils.remove(codePath).catch(() => {});

  const workdirPath = cwd.slice(
    (await getWorkspaceStore().resolveWorkspaceDir()).length,
  );
  return {
    ...result,
    workdir: workdirPath || ".",
  } as NativeExecResult & { workdir: string };
}

export async function startBackgroundProcess(options: {
  command: string;
  workdir?: string;
}): Promise<{ processId: string; pid: number | null }> {
  if (!isSubprocessAvailable()) {
    throw new Error(
      "Background processes require Zotero.Utilities.Internal.subprocess() which is not available in this environment.",
    );
  }

  const cwd = await resolveWorkspaceDir(options.workdir);
  const tmpDir = await ensureTmpDir();
  const id = nextId();
  const processId = `bg_${id}`;

  const outPath = PathUtils.join(tmpDir, `seerai_bgout_${id}.txt`);
  const errPath = PathUtils.join(tmpDir, `seerai_bgerr_${id}.txt`);
  const exitPath = PathUtils.join(tmpDir, `seerai_bgexit_${id}.txt`);

  const shell = Zotero.isWin ? "cmd.exe" : "/bin/sh";
  const shellFlag = Zotero.isWin ? "/c" : "-c";
  let fullCmd: string;
  if (Zotero.isWin) {
    fullCmd = `cd /d ${shellEscape(cwd)} && start /b cmd.exe /c "${options.command} > ${shellEscape(outPath)} 2> ${shellEscape(errPath)} & echo %errorlevel% > ${shellEscape(exitPath)}"`;
  } else {
    fullCmd = `cd ${shellEscape(cwd)} && ( { ${options.command}; } > ${shellEscape(outPath)} 2> ${shellEscape(errPath)}; echo $? > ${shellEscape(exitPath)} ) &`;
  }

  let pid: number | null = null;
  try {
    const subprocess = (Zotero.Utilities.Internal as any).subprocess;
    const procHandle = await subprocess(shell, [shellFlag, fullCmd]);
    if (procHandle && typeof procHandle.pid === "number") {
      pid = procHandle.pid;
    }
  } catch (e) {
    Zotero.debug(`[seerai] bgProcess: subprocess threw: ${e}`);
  }

  backgroundProcesses.set(processId, {
    pid,
    command: options.command,
    workdir: cwd,
    startedAt: new Date().toISOString(),
    outPath,
    errPath,
    exitPath,
  });

  return { processId, pid };
}

export async function pollProcess(processId: string): Promise<{
  running: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
}> {
  const proc = backgroundProcesses.get(processId);
  if (!proc) {
    throw new Error(`Unknown processId: ${processId}`);
  }

  let stdout = "";
  let stderr = "";
  let exitCode: number | null = null;

  try {
    const bytes = await IOUtils.read(proc.outPath);
    stdout = new TextDecoder().decode(bytes);
  } catch {
    // file may not exist yet
  }

  try {
    const bytes = await IOUtils.read(proc.errPath);
    stderr = new TextDecoder().decode(bytes);
  } catch {
    // file may not exist yet
  }

  try {
    const bytes = await IOUtils.read(proc.exitPath);
    const exitStr = new TextDecoder().decode(bytes).trim();
    const parsed = parseInt(exitStr, 10);
    if (!isNaN(parsed)) exitCode = parsed;
  } catch {
    // file may not exist yet
  }

  const running = exitCode === null;

  return { running, stdout, stderr, exitCode };
}

export async function killProcess(
  processId: string,
): Promise<{ success: boolean }> {
  const proc = backgroundProcesses.get(processId);
  if (!proc) return { success: false };

  if (proc.pid !== null && typeof Zotero.isWin === "boolean") {
    try {
      if (Zotero.isWin) {
        await execShell({
          command: `taskkill /PID ${proc.pid} /F`,
        });
      } else {
        await execShell({
          command: `kill -9 ${proc.pid}`,
        });
      }
    } catch {
      // kill failed, process may have already exited
    }
  }

  void IOUtils.remove(proc.outPath).catch(() => {});
  void IOUtils.remove(proc.errPath).catch(() => {});
  void IOUtils.remove(proc.exitPath).catch(() => {});

  backgroundProcesses.delete(processId);
  return { success: true };
}

export function getMetrics(): {
  isExecAvailable: boolean;
  isSubprocessAvailable: boolean;
  backgroundProcessCount: number;
} {
  return {
    isExecAvailable: isExecAvailable(),
    isSubprocessAvailable: isSubprocessAvailable(),
    backgroundProcessCount: backgroundProcesses.size,
  };
}

export async function checkEnvironment(): Promise<{
  pythonVersion: string | null;
  pipVersion: string | null;
  nodeVersion: string | null;
  npmVersion: string | null;
  gitVersion: string | null;
  bashAvailable: boolean;
  cwd: string;
  errors: string[];
}> {
  const result = {
    pythonVersion: null as string | null,
    pipVersion: null as string | null,
    nodeVersion: null as string | null,
    npmVersion: null as string | null,
    gitVersion: null as string | null,
    bashAvailable: false,
    cwd: "",
    errors: [] as string[],
  };

  try {
    result.cwd = await getWorkspaceStore().resolveWorkspaceDir();
  } catch (e: any) {
    result.errors.push(`workspace: ${e?.message || e}`);
  }

  if (!isExecAvailable()) {
    result.errors.push("Zotero.Utilities.Internal.exec not available");
    return result;
  }

  const checks: Array<{
    key: keyof typeof result;
    command: string;
    extract: (output: string) => string | null;
  }> = [
    {
      key: "pythonVersion",
      command: "python3 --version 2>&1 || python --version 2>&1",
      extract: (o) => o.trim().split("\n")[0] || null,
    },
    {
      key: "pipVersion",
      command: "pip3 --version 2>&1 || pip --version 2>&1",
      extract: (o) => o.trim().split("\n")[0] || null,
    },
    {
      key: "nodeVersion",
      command: "node --version 2>&1",
      extract: (o) => o.trim().split("\n")[0] || null,
    },
    {
      key: "npmVersion",
      command: "npm --version 2>&1",
      extract: (o) => o.trim().split("\n")[0] || null,
    },
    {
      key: "gitVersion",
      command: "git --version 2>&1",
      extract: (o) => o.trim().split("\n")[0] || null,
    },
  ];

  for (const check of checks) {
    try {
      const execResult = await execShell({ command: check.command });
      const value =
        check.extract(execResult.stdout) ||
        check.extract(execResult.stderr) ||
        null;
      (result as any)[check.key] = value;
    } catch (e: any) {
      result.errors.push(`${check.key}: ${e?.message || e}`);
    }
  }

  try {
    const bashTest = await execShell({ command: "echo ok 2>&1" });
    result.bashAvailable =
      bashTest.exitCode === 0 && bashTest.stdout.includes("ok");
  } catch (e: any) {
    result.errors.push(`bash: ${e?.message || e}`);
  }

  return result;
}
