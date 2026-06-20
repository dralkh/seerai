import { config } from "../../../../package.json";

// Low-level helper for delegating a chat turn to a locally installed agent
// CLI (e.g. Codex). We never reimplement the CLI's OAuth: we spawn the binary
// and inherit whatever login the user already completed (`codex login`).
//
// Streaming model: Zotero exposes a blocking `Zotero.Utilities.Internal.exec`.
// We launch a shell pipeline that runs the CLI in the *background* (`&`),
// captures its pid, then `wait`s on it — so the exec promise resolves only
// when the CLI exits, while we concurrently tail the stdout temp file and
// yield new bytes as they are written. This gives live token streaming on top
// of a blocking primitive, and a real pid we can kill on abort.

const POLL_INTERVAL_MS = 120;

export interface CliStreamChunk {
  type: "stdout";
  text: string;
}

export interface CliStreamResult {
  type: "exit";
  exitCode: number | null;
  stderr: string;
}

export type CliStreamEvent = CliStreamChunk | CliStreamResult;

export interface CliRunOptions {
  /** Binary to run, resolved on the login-shell PATH (e.g. "codex"). */
  bin: string;
  /** Arguments passed verbatim (each is shell-escaped for us). */
  args: string[];
  /** Text piped to the process stdin (the flattened prompt). */
  stdinText: string;
  /** Optional extra environment variables. */
  env?: Record<string, string>;
}

export function isCliExecAvailable(): boolean {
  return typeof (Zotero.Utilities.Internal as any).exec === "function";
}

export function getEnvVar(name: string): string | undefined {
  try {
    const svc = (Components as any).classes[
      "@mozilla.org/process/environment;1"
    ].getService((Components as any).interfaces.nsIEnvironment);
    return svc.exists(name) ? svc.get(name) : undefined;
  } catch {
    return undefined;
  }
}

function shellEscape(value: string): string {
  if (Zotero.isWin) return `"${value.replace(/"/g, '\\"')}"`;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

// Use a login shell on Unix (tty-safe) so login files (~/.zprofile, brew
// shellenv) load. We do NOT use an interactive shell (`-i`): many ~/.zshrc
// files run tty-dependent setup (stty, tmux auto-attach) that aborts without a
// terminal. Instead we explicitly prepend the common per-user bin dirs that an
// interactive rc would normally add — that's where GUI-launched Zotero
// otherwise loses tools like codex/claude (installed under ~/.local/bin) while
// still finding ones on the base/brew PATH (gemini).
function resolveShell(): { shell: string; flag: string; login: boolean } {
  if (Zotero.isWin) return { shell: "cmd.exe", flag: "/c", login: false };
  const shell = getEnvVar("SHELL") || "/bin/sh";
  return { shell, flag: "-lc", login: true };
}

// Prepended to PATH inside every command (the shell expands $HOME). Covers the
// usual places agent CLIs land that aren't on the minimal GUI/launchd PATH.
const UNIX_PATH_DIRS = [
  "$HOME/.local/bin",
  "$HOME/bin",
  "$HOME/.npm-global/bin",
  "$HOME/.yarn/bin",
  "$HOME/.bun/bin",
  "$HOME/.deno/bin",
  "$HOME/.volta/bin",
  "$HOME/.cargo/bin",
  "$HOME/go/bin",
  "$HOME/.asdf/shims",
  "$HOME/.local/share/mise/shims",
  "$HOME/n/bin",
  "/opt/homebrew/bin",
  "/opt/homebrew/sbin",
  "/usr/local/bin",
];

function pathPrefixStatement(): string {
  if (Zotero.isWin) return "";
  return `export PATH="${UNIX_PATH_DIRS.join(":")}:$PATH"; `;
}

function cliDir(sub: string): string {
  return PathUtils.join(Zotero.DataDirectory.dir, config.addonRef, sub);
}

async function ensureDir(dir: string): Promise<void> {
  await IOUtils.makeDirectory(dir, { ignoreExisting: true });
}

let _idCounter = 0;
function nextId(): number {
  return ++_idCounter;
}

async function readTextIfExists(path: string): Promise<string | null> {
  try {
    const bytes = await IOUtils.read(path);
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

function envPrefix(env?: Record<string, string>): string {
  if (!env) return "";
  if (Zotero.isWin) {
    return (
      Object.entries(env)
        .map(([k, v]) => `set ${k}=${v.replace(/"/g, '\\"')} && `)
        .join("") || ""
    );
  }
  return (
    Object.entries(env)
      .map(([k, v]) => `${k}=${shellEscape(v)} `)
      .join("") || ""
  );
}

export interface CliCaptureResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

/**
 * Run a CLI command to completion and capture its output. Used for fast probes
 * (version / login status). No stdin. Uses a login shell so the binary resolves
 * on the user's PATH.
 */
export async function runCliCapture(
  bin: string,
  args: string[],
  timeoutMs = 8000,
): Promise<CliCaptureResult> {
  const execFn = (Zotero.Utilities.Internal as any).exec;
  if (typeof execFn !== "function") {
    throw new Error(
      "Local CLI execution requires Zotero.Utilities.Internal.exec, which is not available in this environment.",
    );
  }
  const id = nextId();
  const tmp = cliDir("tmp");
  await ensureDir(tmp);
  const outPath = PathUtils.join(tmp, `seerai_probe_out_${id}.txt`);
  const errPath = PathUtils.join(tmp, `seerai_probe_err_${id}.txt`);
  const exitPath = PathUtils.join(tmp, `seerai_probe_exit_${id}.txt`);
  const invocation = `${shellEscape(bin)} ${args.map(shellEscape).join(" ")}`;
  const { shell, flag } = resolveShell();
  const eo = shellEscape(outPath);
  const ee = shellEscape(errPath);
  const eexit = shellEscape(exitPath);
  const command = Zotero.isWin
    ? `${invocation} > ${eo} 2> ${ee} & echo !errorlevel! > ${eexit}`
    : `${pathPrefixStatement()}{ ${invocation} ; } > ${eo} 2> ${ee} ; echo $? > ${eexit}`;

  // Race the exec against the timeout so a slow/hanging interactive shell
  // (e.g. a heavy ~/.zshrc) can't block detection forever — we return whatever
  // the probe wrote so far.
  let timedOut = false;
  await Promise.race([
    Promise.resolve(execFn(shell, [flag, command])).catch(() => {}),
    new Promise<void>((resolve) =>
      setTimeout(() => {
        timedOut = true;
        resolve();
      }, timeoutMs),
    ),
  ]);

  const stdout = (await readTextIfExists(outPath)) || "";
  const stderr = (await readTextIfExists(errPath)) || "";
  const exitRaw = (await readTextIfExists(exitPath)) || "";
  for (const p of [outPath, errPath, exitPath]) {
    void IOUtils.remove(p).catch(() => {});
  }
  const parsed = exitRaw.trim() ? parseInt(exitRaw.trim(), 10) : null;
  return {
    stdout: stdout.trim(),
    stderr: stderr.trim(),
    exitCode: timedOut ? null : isNaN(parsed as number) ? null : parsed,
  };
}

/**
 * Run a CLI agent and stream its stdout. Returns an async iterator of stdout
 * chunks followed by a final exit event, plus an `abort()` to kill the process.
 */
export function runCli(options: CliRunOptions): {
  events: AsyncIterable<CliStreamEvent>;
  abort: () => void;
} {
  const execFn = (Zotero.Utilities.Internal as any).exec;
  if (typeof execFn !== "function") {
    throw new Error(
      "Local CLI execution requires Zotero.Utilities.Internal.exec, which is not available in this environment.",
    );
  }

  let aborted = false;
  let pid: number | null = null;
  let cleanedUp = false;

  const id = nextId();
  const tmp = cliDir("tmp");
  const cwd = cliDir("cli-cwd");
  const promptPath = PathUtils.join(tmp, `seerai_cli_prompt_${id}.txt`);
  const outPath = PathUtils.join(tmp, `seerai_cli_out_${id}.txt`);
  const errPath = PathUtils.join(tmp, `seerai_cli_err_${id}.txt`);
  const pidPath = PathUtils.join(tmp, `seerai_cli_pid_${id}.txt`);
  const exitPath = PathUtils.join(tmp, `seerai_cli_exit_${id}.txt`);

  const cliInvocation = `${envPrefix(options.env)}${shellEscape(options.bin)} ${options.args
    .map(shellEscape)
    .join(" ")}`;

  const { shell, flag } = resolveShell();

  function buildCommand(): string {
    const ep = shellEscape(promptPath);
    const eo = shellEscape(outPath);
    const ee = shellEscape(errPath);
    const epid = shellEscape(pidPath);
    const eexit = shellEscape(exitPath);
    const ecwd = shellEscape(cwd);
    if (Zotero.isWin) {
      // No reliable pid capture on Windows; abort falls back to stopping
      // consumption of the stream.
      return `cd /d ${ecwd} && ${cliInvocation} < ${ep} > ${eo} 2> ${ee} & echo !errorlevel! > ${eexit}`;
    }
    return `${pathPrefixStatement()}cd ${ecwd} && { ${cliInvocation} < ${ep} > ${eo} 2> ${ee} & } ; p=$! ; echo $p > ${epid} ; wait $p ; echo $? > ${eexit}`;
  }

  async function cleanup(): Promise<void> {
    if (cleanedUp) return;
    cleanedUp = true;
    for (const p of [promptPath, outPath, errPath, pidPath, exitPath]) {
      void IOUtils.remove(p).catch(() => {});
    }
  }

  async function readPid(): Promise<void> {
    const raw = await readTextIfExists(pidPath);
    if (raw) {
      const parsed = parseInt(raw.trim(), 10);
      if (!isNaN(parsed)) pid = parsed;
    }
  }

  async function killProcess(): Promise<void> {
    await readPid();
    if (pid === null) return;
    try {
      if (Zotero.isWin) {
        await execFn("cmd.exe", ["/c", `taskkill /PID ${pid} /T /F`]);
      } else {
        await execFn("/bin/sh", [
          "-c",
          `kill -TERM ${pid} 2>/dev/null; sleep 0.2; kill -KILL ${pid} 2>/dev/null`,
        ]);
      }
    } catch {
      // process may already be gone
    }
  }

  async function* generate(): AsyncGenerator<CliStreamEvent> {
    await ensureDir(tmp);
    await ensureDir(cwd);
    await IOUtils.writeUTF8(promptPath, options.stdinText);

    const command = buildCommand();
    Zotero.debug(
      `[seerai] runCli: ${shell} ${flag} "${command.slice(0, 200)}"`,
    );

    // Kick off the process WITHOUT awaiting so we can tail stdout while it runs.
    const execPromise: Promise<unknown> = Promise.resolve(
      execFn(shell, [flag, command]),
    ).catch((e) => {
      Zotero.debug(`[seerai] runCli: exec threw: ${e}`);
    });
    let finished = false;
    void execPromise.then(() => {
      finished = true;
    });

    let offset = 0;
    const decoder = new TextDecoder();

    const readNewStdout = async (): Promise<string> => {
      try {
        const bytes = await IOUtils.read(outPath);
        if (bytes.length <= offset) return "";
        const slice = bytes.subarray(offset);
        offset = bytes.length;
        return decoder.decode(slice, { stream: true });
      } catch {
        return "";
      }
    };

    try {
      // Stream until the process exits, then drain any remaining output.
      while (!finished && !aborted) {
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
        if (pid === null) await readPid();
        const chunk = await readNewStdout();
        if (chunk) yield { type: "stdout", text: chunk };
      }

      if (aborted) {
        await killProcess();
      }

      // Final drain — the process may have written its last bytes between polls.
      await execPromise;
      const tail = await readNewStdout();
      if (tail) yield { type: "stdout", text: tail };

      const stderr = (await readTextIfExists(errPath)) || "";
      const exitRaw = (await readTextIfExists(exitPath)) || "";
      const exitCode = exitRaw.trim() ? parseInt(exitRaw.trim(), 10) : null;
      yield {
        type: "exit",
        exitCode: aborted ? null : isNaN(exitCode as number) ? null : exitCode,
        stderr,
      };
    } finally {
      await cleanup();
    }
  }

  return {
    events: generate(),
    abort: () => {
      aborted = true;
      void killProcess();
    },
  };
}
