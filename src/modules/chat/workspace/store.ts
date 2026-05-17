/**
 * Workspace Store — files on disk + real .git via git CLI.
 *
 * Uses native git via Subprocess for 100% compatibility with
 * external tools (lazygit, git CLI, etc.). No isomorphic-git.
 */
import { config } from "../../../../package.json";
import { getMessageStore } from "../messageStore";
import {
  WorkspaceFile,
  WorkspaceSnapshot,
  WorkspaceFileEntry,
  FileStatus,
  FileVersion,
  DiffResult,
  inferLanguage,
  WorkspaceGitState,
  Commit,
  CommitSummary,
  GitStatusResult,
  FileGitStatus,
} from "./types";
import { createDiffResult } from "./diff";
import {
  execGit,
  isGitAvailable,
  parseGitStatus,
  resetGitAvailability,
} from "./gitCli";

const METADATA_DIRS = new Set([".git", ".agent", "workspace_snapshot.json"]);

function slugifyFolder(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function findBestMatch(fileContent: string, target: string): string | null {
  const fileLines = fileContent.split("\n");
  const targetLines = target.split("\n");
  const firstMeaningful = targetLines.find((l) => l.trim().length > 0);
  if (!firstMeaningful) return null;

  for (let i = 0; i < fileLines.length; i++) {
    if (fileLines[i].includes(firstMeaningful.trim())) {
      const start = Math.max(0, i - 2);
      const end = Math.min(fileLines.length, i + targetLines.length + 2);
      return fileLines.slice(start, end).join("\n");
    }
  }

  const words = firstMeaningful
    .trim()
    .split(/\s+/)
    .filter((w) => w.length >= 3)
    .sort((a, b) => b.length - a.length);
  for (const word of words) {
    for (let i = 0; i < fileLines.length; i++) {
      if (fileLines[i].includes(word)) {
        const start = Math.max(0, i - 2);
        const end = Math.min(fileLines.length, i + 3);
        return fileLines.slice(start, end).join("\n");
      }
    }
  }

  const chunk = target.replace(/\s+/g, " ").trim().substring(0, 60);
  for (let i = 0; i < fileLines.length; i++) {
    const dist = levenshtein(
      fileLines[i].replace(/\s+/g, " ").trim().substring(0, 60),
      chunk,
    );
    if (dist <= Math.max(5, Math.floor(chunk.length * 0.4))) {
      const start = Math.max(0, i - 2);
      const end = Math.min(fileLines.length, i + 3);
      return fileLines.slice(start, end).join("\n");
    }
  }

  return null;
}

function levenshtein(a: string, b: string): number {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const curr = [i];
    for (let j = 1; j <= b.length; j++) {
      curr[j] = Math.min(
        curr[j - 1] + 1,
        prev[j] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev.splice(0, prev.length, ...curr);
  }
  return prev[b.length];
}

export class WorkspaceStore {
  private _lastConversationId: string | null = null;
  private _lastFolder: string | null | undefined = undefined;
  private _gitAvailable: boolean | null = null;

  public onWorkspaceChanged: (() => void) | null = null;

  private _stagedContentCache: Map<string, string> = new Map();

  private get dataDir(): string {
    return PathUtils.join(Zotero.DataDirectory.dir, config.addonRef);
  }

  private get conversationsDir(): string {
    return PathUtils.join(this.dataDir, "conversations");
  }

  private get workspacesDir(): string {
    return PathUtils.join(this.dataDir, "workspaces");
  }

  private get currentConversationId(): string {
    return getMessageStore().getConversationId();
  }

  private async getFolderForCurrentChat(): Promise<string | null> {
    const history = await getMessageStore().getHistory();
    const conv = history.find((h) => h.id === this.currentConversationId);
    return conv?.folder || null;
  }

  private get perChatWorkspaceDir(): string {
    return PathUtils.join(
      this.conversationsDir,
      this.currentConversationId,
      "workspace",
    );
  }

  private folderWorkspaceDir(folder: string): string {
    return PathUtils.join(
      this.workspacesDir,
      slugifyFolder(folder),
      "workspace",
    );
  }

  get workspaceDir(): string {
    const folder = this._currentFolder;
    if (folder) {
      return this.folderWorkspaceDir(folder);
    }
    return this.perChatWorkspaceDir;
  }

  private _currentFolder: string | null | undefined = undefined;

  switchChatContext(chatId: string, folder: string | null): void {
    const folderChanged = this._currentFolder !== folder;
    const idChanged =
      this._lastConversationId !== null && this._lastConversationId !== chatId;
    this._lastConversationId = chatId;
    this._currentFolder = folder;
    this._lastFolder = folder ?? undefined;
    if (folderChanged || idChanged) {
      this._initPromise = null;
    }
  }

  async resolveWorkspaceDir(): Promise<string> {
    if (this._currentFolder === undefined) {
      const folder = await this.getFolderForCurrentChat();
      this._currentFolder = folder;
    }
    return this.workspaceDir;
  }

  get isSharedWorkspace(): boolean {
    return this._currentFolder !== undefined && this._currentFolder !== null;
  }

  get workspaceLabel(): string {
    if (this._currentFolder === undefined) return "Artifacts";
    return this._currentFolder || "Personal";
  }

  private writeLock: Promise<void> = Promise.resolve();

  private _initPromise: Promise<void> | null = null;

  private checkConversationChange(): void {
    const currentId = this.currentConversationId;
    const idChanged =
      this._lastConversationId !== null &&
      this._lastConversationId !== currentId;
    if (idChanged) {
      this._initPromise = null;
    }
    this._lastConversationId = currentId;
  }

  private async ensureGitAvailable(): Promise<boolean> {
    if (this._gitAvailable !== null) return this._gitAvailable;
    this._gitAvailable = await isGitAvailable();
    return this._gitAvailable;
  }

  private async ensureInit(): Promise<void> {
    this.checkConversationChange();
    if (this._initPromise) return this._initPromise;
    this._initPromise = (async () => {
      await this.resolveWorkspaceDir();
      const dir = this.workspaceDir;
      await this.ensureDir(dir);
      const gitOk = await this.ensureGitAvailable();
      if (!gitOk) {
        Zotero.debug(
          "[seerai] WorkspaceStore: git not available, version control disabled",
        );
        return;
      }
      const gitDir = PathUtils.join(this.workspaceDir, ".git");
      if (!(await IOUtils.exists(gitDir).catch(() => false))) {
        Zotero.debug(
          "[seerai] WorkspaceStore: no .git found, initializing fresh repo",
        );
        await execGit(this.workspaceDir, ["init"]);
        const gitConfigUser = PathUtils.join(
          this.workspaceDir,
          ".git",
          "config",
        );
        const configExists = await IOUtils.exists(gitConfigUser).catch(
          () => false,
        );
        if (!configExists) {
          await execGit(this.workspaceDir, ["config", "user.name", "seerai"]);
          await execGit(this.workspaceDir, [
            "config",
            "user.email",
            "seerai@local",
          ]);
        }
      }
    })();
    return this._initPromise;
  }

  async migrateChatToFolder(chatId: string, folder: string): Promise<void> {
    const srcDir = PathUtils.join(this.conversationsDir, chatId, "workspace");
    const destBase = this.folderWorkspaceDir(folder);
    const srcExists = await IOUtils.exists(srcDir).catch(() => false);
    await this.ensureDir(destBase);
    if (!srcExists) {
      return;
    }
    const hasContent = await this.dirHasUserFiles(srcDir);
    if (hasContent) {
      const history = await getMessageStore().getHistory();
      const conv = history.find((h) => h.id === chatId);
      const chatTitle = conv?.title || chatId;
      const subName = chatTitle.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 40);
      const subDir = PathUtils.join(destBase, subName);
      await this.moveDirContents(srcDir, subDir);
    }
  }

  private async dirHasUserFiles(dir: string): Promise<boolean> {
    let children: string[];
    try {
      const raw = await IOUtils.getChildren(dir);
      children = raw.map((p: string) => {
        const idx = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
        return idx >= 0 ? p.slice(idx + 1) : p;
      });
    } catch {
      return false;
    }
    for (const name of children) {
      if (METADATA_DIRS.has(name)) continue;
      return true;
    }
    return false;
  }

  async removeChatFromFolder(
    chatId: string,
    prevFolder?: string,
  ): Promise<void> {
    const perChatDir = PathUtils.join(
      this.conversationsDir,
      chatId,
      "workspace",
    );

    if (prevFolder) {
      const sharedDir = this.folderWorkspaceDir(prevFolder);
      const history = await getMessageStore().getHistory();
      const conv = history.find((h) => h.id === chatId);
      const chatTitle = conv?.title || chatId;
      const subName = chatTitle.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 40);
      const subDir = PathUtils.join(sharedDir, subName);
      const subExists = await IOUtils.exists(subDir).catch(() => false);
      if (subExists) {
        const hasContent = await this.dirHasUserFiles(subDir);
        if (hasContent) {
          await this.moveDirContents(subDir, perChatDir);
          try {
            await (IOUtils as any).remove(subDir, { recursive: true });
          } catch {
            // Ignore cleanup failure
          }
        }
      }
    }

    await this.ensureDir(perChatDir);
  }

  async renameWorkspaceFolder(oldName: string, newName: string): Promise<void> {
    const oldDir = PathUtils.join(this.workspacesDir, slugifyFolder(oldName));
    const newDir = PathUtils.join(this.workspacesDir, slugifyFolder(newName));
    if (!(await IOUtils.exists(oldDir).catch(() => false))) return;
    if (oldDir === newDir) return;
    try {
      await IOUtils.makeDirectory(PathUtils.join(this.workspacesDir), {
        ignoreExisting: true,
      });
      await (IOUtils as any).move(oldDir, newDir);
      Zotero.debug(
        `[seerai] WorkspaceStore: Renamed workspace ${oldDir} → ${newDir}`,
      );
    } catch (e) {
      Zotero.debug(
        `[seerai] WorkspaceStore: Error renaming workspace folder: ${e}`,
      );
    }
    if (this._currentFolder === oldName) {
      this._currentFolder = newName;
      this._lastFolder = newName;
      this._initPromise = null;
    }
  }

  async deleteWorkspaceFolder(folderName: string): Promise<void> {
    const dir = PathUtils.join(this.workspacesDir, slugifyFolder(folderName));
    if (!(await IOUtils.exists(dir).catch(() => false))) return;
    try {
      await (IOUtils as any).remove(dir, { recursive: true });
      Zotero.debug(`[seerai] WorkspaceStore: Deleted workspace ${dir}`);
    } catch (e) {
      Zotero.debug(
        `[seerai] WorkspaceStore: Error deleting workspace folder: ${e}`,
      );
    }
  }

  private async moveDirContents(
    srcDir: string,
    destDir: string,
  ): Promise<void> {
    await this.ensureDir(destDir);
    let children: string[];
    try {
      const raw = await IOUtils.getChildren(srcDir);
      children = raw.map((fullPath: string) => {
        const idx = Math.max(
          fullPath.lastIndexOf("/"),
          fullPath.lastIndexOf("\\"),
        );
        return idx >= 0 ? fullPath.slice(idx + 1) : fullPath;
      });
    } catch {
      return;
    }
    for (const name of children) {
      if (METADATA_DIRS.has(name)) continue;
      const srcPath = PathUtils.join(srcDir, name);
      const destPath = PathUtils.join(destDir, name);
      let isDir = false;
      try {
        isDir = (await IOUtils.stat(srcPath)).type === "directory";
      } catch {
        continue;
      }
      if (isDir) {
        await this.moveDirContents(srcPath, destPath);
      } else {
        try {
          const bytes = await IOUtils.read(srcPath);
          await IOUtils.write(destPath, bytes);
        } catch (e) {
          Zotero.debug(
            `[seerai] WorkspaceStore: Error copying ${srcPath} → ${destPath}: ${e}`,
          );
        }
      }
    }
  }

  private async withWriteLock<T>(operation: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const next = this.writeLock.then(async () => {
        try {
          const result = await operation();
          resolve(result);
        } catch (e) {
          reject(e);
        }
      });
      this.writeLock = next.catch(() => {});
    });
  }

  private async ensureDir(dir: string): Promise<void> {
    try {
      if (!(await IOUtils.exists(dir))) {
        await IOUtils.makeDirectory(dir, { ignoreExisting: true });
      }
    } catch (e) {
      Zotero.debug(`[seerai] WorkspaceStore: Error creating dir ${dir}: ${e}`);
    }
  }

  private generateId(): string {
    return `v_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  normalizePath(filePath: string): string {
    let normalized = filePath.replace(/\\/g, "/");
    if (normalized.startsWith("/")) {
      normalized = normalized.slice(1);
    }
    return normalized || ".";
  }

  private absPath(normalized: string): string {
    const parts = normalized.split("/").filter((p) => p.length > 0);
    return PathUtils.join(this.workspaceDir, ...parts);
  }

  // ======== loadSnapshot (legacy compat) ========

  async loadSnapshot(): Promise<WorkspaceSnapshot> {
    return {
      conversationId: this.currentConversationId,
      rootPath: this.workspaceDir,
      files: [],
      ignored: [".git", "workspace_snapshot.json"],
      savedAt: new Date().toISOString(),
    };
  }

  // ======== File I/O ========

  async readFile(filePath: string): Promise<WorkspaceFile | null> {
    const normalized = this.normalizePath(filePath);
    const fileAbsPath = this.absPath(normalized);
    try {
      if (!(await IOUtils.exists(fileAbsPath))) return null;
      const bytes = await IOUtils.read(fileAbsPath);
      const content = new TextDecoder().decode(bytes);
      return {
        path: normalized,
        content,
        language: inferLanguage(normalized),
        versions: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    } catch {
      return null;
    }
  }

  async readFilePartial(
    filePath: string,
    offset: number = 1,
    limit?: number,
  ): Promise<{
    content: string;
    totalLines: number;
    offset: number;
    truncated: boolean;
  } | null> {
    const file = await this.readFile(filePath);
    if (!file) return null;
    const lines = file.content.split("\n");
    const totalLines = lines.length;
    const startIdx = Math.max(0, Math.min(offset - 1, totalLines));
    const endIdx = limit ? Math.min(startIdx + limit, totalLines) : totalLines;
    return {
      content: lines.slice(startIdx, endIdx).join("\n"),
      totalLines,
      offset: startIdx + 1,
      truncated: endIdx < totalLines,
    };
  }

  async writeFile(
    filePath: string,
    content: string,
    _message?: string,
    _author: string = "assistant",
  ): Promise<{ versionId: string; created: boolean }> {
    const normalized = this.normalizePath(filePath);
    const fileAbsPath = this.absPath(normalized);

    const lastSlash = fileAbsPath.lastIndexOf("/");
    if (lastSlash > 0) {
      await this.ensureDir(fileAbsPath.substring(0, lastSlash));
    }
    await this.ensureDir(this.workspaceDir);

    const existed = await IOUtils.exists(fileAbsPath).catch(() => false);
    const encoder = new TextEncoder();
    await IOUtils.write(fileAbsPath, encoder.encode(content));
    this.onWorkspaceChanged?.();
    return { versionId: this.generateId(), created: !existed };
  }

  async deleteFile(filePath: string): Promise<boolean> {
    const normalized = this.normalizePath(filePath);
    const fileAbsPath = this.absPath(normalized);
    try {
      if (!(await IOUtils.exists(fileAbsPath))) return false;
    } catch {
      return false;
    }
    await IOUtils.remove(fileAbsPath);

    const gitOk = await this.ensureGitAvailable();
    if (gitOk) {
      await execGit(this.workspaceDir, [
        "rm",
        "--cached",
        "-f",
        "--",
        normalized,
      ]).catch(() => {});
    }
    this.onWorkspaceChanged?.();
    return true;
  }

  async deleteFolder(folderPath: string): Promise<boolean> {
    const normalized = this.normalizePath(folderPath);
    const folderAbsPath = this.absPath(normalized);
    try {
      if (!(await IOUtils.exists(folderAbsPath))) return false;
    } catch {
      return false;
    }
    await (IOUtils as any).remove(folderAbsPath, { recursive: true });

    const gitOk = await this.ensureGitAvailable();
    if (gitOk) {
      await execGit(this.workspaceDir, [
        "rm",
        "-r",
        "--cached",
        "-f",
        "--",
        normalized,
      ]).catch(() => {});
    }
    this.onWorkspaceChanged?.();
    return true;
  }

  async renameFile(
    oldPath: string,
    newPath: string,
    _message?: string,
  ): Promise<boolean> {
    const oldNormalized = this.normalizePath(oldPath);
    const newNormalized = this.normalizePath(newPath);
    const oldAbsPath = this.absPath(oldNormalized);
    const newAbsPath = this.absPath(newNormalized);
    try {
      if (!(await IOUtils.exists(oldAbsPath))) return false;
    } catch {
      return false;
    }
    const lastSlash = newAbsPath.lastIndexOf("/");
    if (lastSlash > 0) {
      await this.ensureDir(newAbsPath.substring(0, lastSlash));
    }
    await IOUtils.move(oldAbsPath, newAbsPath);

    const gitOk = await this.ensureGitAvailable();
    if (gitOk) {
      await execGit(this.workspaceDir, [
        "mv",
        "--",
        oldNormalized,
        newNormalized,
      ]).catch(() => {});
    }
    this.onWorkspaceChanged?.();
    return true;
  }

  async editFile(
    filePath: string,
    oldString: string,
    newString: string,
    replaceAll: boolean = false,
    message?: string,
    author: string = "assistant",
  ): Promise<{
    versionId: string;
    replacements: number;
    success: boolean;
    error?: string;
  }> {
    const normalized = this.normalizePath(filePath);
    const file = await this.readFile(normalized);
    if (!file) {
      return {
        versionId: "",
        replacements: 0,
        success: false,
        error: `File not found: ${normalized}`,
      };
    }
    if (!file.content.includes(oldString)) {
      const bestMatch = findBestMatch(file.content, oldString);
      return {
        versionId: "",
        replacements: 0,
        success: false,
        error:
          `String not found in ${normalized}.` +
          (bestMatch ? ` Did you mean:\n\`\`\`\n${bestMatch}\n\`\`\`` : ""),
      };
    }
    let newContent: string;
    let replacements: number;
    if (replaceAll) {
      const parts = file.content.split(oldString);
      replacements = parts.length - 1;
      newContent = parts.join(newString);
    } else {
      replacements = 1;
      newContent = file.content.replace(oldString, newString);
    }
    const result = await this.writeFile(
      normalized,
      newContent,
      message,
      author,
    );
    return { versionId: result.versionId, replacements, success: true };
  }

  async listFiles(): Promise<WorkspaceFileEntry[]> {
    const entries: WorkspaceFileEntry[] = [];
    try {
      await this.ensureDir(this.workspaceDir);
      await this.collectFiles(this.workspaceDir, "", entries);
    } catch (e) {
      Zotero.debug(`[seerai] WorkspaceStore: Error listing files: ${e}`);
    }
    return entries;
  }

  async listFileTree(): Promise<WorkspaceFileEntry[]> {
    try {
      await this.ensureDir(this.workspaceDir);
      Zotero.debug(`[seerai] listFileTree: scanning ${this.workspaceDir}`);
      const result = await this.collectTree(this.workspaceDir, "");
      Zotero.debug(
        `[seerai] listFileTree: found ${result.length} top-level entries`,
      );
      return result;
    } catch (e) {
      Zotero.debug(
        `[seerai] WorkspaceStore: Error listing file tree: ${e}\n${e instanceof Error ? e.stack : ""}`,
      );
      return [];
    }
  }

  private async collectTree(
    dir: string,
    relativePath: string,
  ): Promise<WorkspaceFileEntry[]> {
    const entries: WorkspaceFileEntry[] = [];
    let children: string[];
    try {
      const raw = await IOUtils.getChildren(dir);
      children = raw.map((fullPath: string) => {
        const idx = Math.max(
          fullPath.lastIndexOf("/"),
          fullPath.lastIndexOf("\\"),
        );
        return idx >= 0 ? fullPath.slice(idx + 1) : fullPath;
      });
    } catch {
      return entries;
    }

    const dirs: WorkspaceFileEntry[] = [];
    const files: WorkspaceFileEntry[] = [];

    for (const name of children) {
      if (METADATA_DIRS.has(name)) continue;
      if (name.includes("\0") || name.includes("\x00")) continue;
      const childRelative = relativePath ? `${relativePath}/${name}` : name;
      let childAbs: string;
      try {
        childAbs = PathUtils.join(dir, name);
      } catch (e) {
        Zotero.debug(
          `[seerai] collectTree: PathUtils.join failed for dir=${dir} name=${name}: ${e}`,
        );
        continue;
      }
      let isDir = false;
      try {
        isDir = (await IOUtils.stat(childAbs)).type === "directory";
      } catch {
        continue;
      }
      if (isDir) {
        const childEntries = await this.collectTree(childAbs, childRelative);
        if (childEntries.length > 0) {
          dirs.push({
            path: childRelative,
            name,
            isDirectory: true,
            extension: "",
            status: "unmodified",
            gitStatus: "unmodified" as FileGitStatus,
            content: undefined,
            language: undefined,
            children: childEntries,
          });
        }
      } else {
        files.push({
          path: childRelative,
          name,
          isDirectory: false,
          extension: name.includes(".") ? name.split(".").pop() || "" : "",
          status: "unmodified",
          gitStatus: "unmodified" as FileGitStatus,
          content: undefined,
          language: inferLanguage(childRelative),
        });
      }
    }

    entries.push(...dirs, ...files);
    return entries;
  }

  private async collectFiles(
    dir: string,
    relativePath: string,
    entries: WorkspaceFileEntry[],
  ): Promise<void> {
    let children: string[];
    try {
      const raw = await IOUtils.getChildren(dir);
      children = raw.map((fullPath: string) => {
        const idx = Math.max(
          fullPath.lastIndexOf("/"),
          fullPath.lastIndexOf("\\"),
        );
        return idx >= 0 ? fullPath.slice(idx + 1) : fullPath;
      });
    } catch {
      return;
    }
    for (const name of children) {
      if (METADATA_DIRS.has(name)) continue;
      if (name.includes("\0") || name.includes("\x00")) continue;
      const childRelative = relativePath ? `${relativePath}/${name}` : name;
      let childAbs: string;
      try {
        childAbs = PathUtils.join(dir, name);
      } catch (e) {
        Zotero.debug(
          `[seerai] collectFiles: PathUtils.join failed for dir=${dir} name=${name}: ${e}`,
        );
        continue;
      }
      let isDir = false;
      try {
        isDir = (await IOUtils.stat(childAbs)).type === "directory";
      } catch {
        continue;
      }
      if (isDir) {
        await this.collectFiles(childAbs, childRelative, entries);
      } else {
        entries.push({
          path: childRelative,
          name,
          isDirectory: false,
          extension: name.includes(".") ? name.split(".").pop() || "" : "",
          status: "unmodified",
          gitStatus: "unmodified" as FileGitStatus,
          content: undefined,
          language: inferLanguage(childRelative),
        });
      }
    }
  }

  async searchFiles(
    pattern: string,
    excludeDirs: string[] = [],
  ): Promise<Array<{ file: string; line: number; content: string }>> {
    const files = await this.listFiles();
    const matches: Array<{ file: string; line: number; content: string }> = [];
    const filtered = files.filter((f) => {
      for (const ed of excludeDirs) {
        if (f.path.startsWith(ed + "/") || f.path === ed) return false;
      }
      return true;
    });
    let regex: RegExp;
    try {
      regex = new RegExp(pattern, "g");
    } catch {
      return [];
    }
    for (const entry of filtered) {
      const wsFile = await this.readFile(entry.path);
      if (!wsFile) continue;
      const lines = wsFile.content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (regex.test(lines[i])) {
          regex.lastIndex = 0;
          matches.push({
            file: entry.path,
            line: i + 1,
            content: lines[i],
          });
        }
        regex.lastIndex = 0;
      }
    }
    return matches;
  }

  // ======== Git Operations ========

  async stageFile(path: string): Promise<void> {
    const normalized = this.normalizePath(path);
    await this.ensureInit();
    const result = await execGit(this.workspaceDir, ["add", "--", normalized]);
    if (result.exitCode !== 0) {
      Zotero.debug(
        `[seerai] stageFile: git add failed for "${normalized}": ${result.stderr}`,
      );
    }
    const file = await this.readFile(normalized);
    this._stagedContentCache.set(normalized, file?.content ?? "");
    this._trackedSetPromise = null;
    this.onWorkspaceChanged?.();
  }

  async unstageFile(path: string): Promise<void> {
    const normalized = this.normalizePath(path);
    await this.ensureInit();
    await execGit(this.workspaceDir, ["reset", "HEAD", "--", normalized]).catch(
      () => {},
    );
    this._stagedContentCache.delete(normalized);
    this.onWorkspaceChanged?.();
  }

  async stageAll(): Promise<void> {
    await this.ensureInit();
    await execGit(this.workspaceDir, ["add", "-A"]);
    this._trackedSetPromise = null;
    this.onWorkspaceChanged?.();
  }

  async unstageAll(): Promise<void> {
    await this.ensureInit();
    await execGit(this.workspaceDir, ["reset"]);
    this._stagedContentCache.clear();
    this.onWorkspaceChanged?.();
  }

  async getStagedContent(path: string): Promise<string | null> {
    const normalized = this.normalizePath(path);
    await this.ensureInit();
    const result = await execGit(this.workspaceDir, ["show", `:${normalized}`]);
    if (result.exitCode !== 0) return null;
    return result.stdout;
  }

  async getHeadContent(path: string): Promise<string | null> {
    const normalized = this.normalizePath(path);
    await this.ensureInit();
    const result = await execGit(this.workspaceDir, [
      "show",
      `HEAD:${normalized}`,
    ]);
    if (result.exitCode !== 0) return null;
    return result.stdout;
  }

  async commit(message: string, author?: string): Promise<string | null> {
    await this.ensureInit();
    const authorFlag = author
      ? `--author=${author} <${author}@seerai.local>`
      : "--author=seerai <seerai@local>";
    const result = await execGit(this.workspaceDir, [
      "commit",
      "-m",
      message,
      authorFlag,
      "--no-gpg-sign",
    ]);
    if (result.exitCode !== 0) {
      Zotero.debug(`[seerai] commit failed: ${result.stderr}`);
      return null;
    }
    const hashResult = await execGit(this.workspaceDir, ["rev-parse", "HEAD"]);
    this._stagedContentCache.clear();
    this._trackedSetPromise = null;
    this.onWorkspaceChanged?.();
    return hashResult.exitCode === 0 ? hashResult.stdout.trim() : null;
  }

  private _trackedSetPromise: Promise<Set<string>> | null = null;

  private async getTrackedFileSet(): Promise<Set<string>> {
    if (this._trackedSetPromise) return this._trackedSetPromise;
    this._trackedSetPromise = (async () => {
      const result = await execGit(this.workspaceDir, [
        "ls-files",
        "--cached",
        "--",
      ]);
      const set = new Set<string>();
      if (result.exitCode === 0 && result.stdout) {
        for (const line of result.stdout.split("\n")) {
          const trimmed = line.trim();
          if (trimmed) set.add(trimmed);
        }
      }
      return set;
    })();
    return this._trackedSetPromise;
  }

  async getGitStatus(): Promise<GitStatusResult> {
    await this.ensureInit();
    const staged: GitStatusResult["staged"] = [];
    const changes: GitStatusResult["changes"] = [];
    const stagedContent = new Map<string, string>();
    const headContent = new Map<string, string>();

    const diskFiles = await this.listFiles();
    const seen = new Set<string>();

    const statusResult = await execGit(this.workspaceDir, [
      "status",
      "--porcelain=v2",
      "--",
    ]);

    if (statusResult.exitCode !== 0) {
      Zotero.debug(
        `[seerai] getGitStatus: git status failed (exit=${statusResult.exitCode}): stdout=${statusResult.stdout.slice(0, 200)} stderr=${statusResult.stderr.slice(0, 200)}`,
      );
      for (const f of diskFiles) {
        const file = await this.readFile(f.path);
        changes.push({
          path: f.path,
          entry: {
            ...f,
            status: "untracked",
            gitStatus: "untracked" as FileGitStatus,
            content: file?.content,
          },
        });
      }
      return { staged, changes, stagedContent, headContent };
    }

    const entries = parseGitStatus(statusResult.stdout);

    for (const entry of entries) {
      if (entry.path.startsWith(".git/") || entry.path === ".git") continue;
      seen.add(entry.path);

      const { x, y } = entry;
      let currentContent = "";
      try {
        currentContent = (await this.readFile(entry.path))?.content ?? "";
      } catch {
        // file may not exist on disk
      }

      let gitStatus: FileGitStatus;
      const isStaged = x !== "." && x !== " " && x !== "?";
      const isModified = y !== "." && y !== " " && y !== "?";
      const isUntracked = x === "?" && y === "?";
      const isDeleted = x === "D" || y === "D";

      if (isUntracked) {
        gitStatus = "untracked";
      } else if (isDeleted && isStaged) {
        gitStatus = "deleted";
      } else if (isStaged && !isModified) {
        gitStatus = "added";
      } else if (isStaged) {
        gitStatus = "staged";
      } else if (isDeleted) {
        gitStatus = "deleted";
      } else if (isModified) {
        gitStatus = "modified";
      } else {
        gitStatus = "committed";
      }

      const fileEntry: WorkspaceFileEntry = {
        path: entry.path,
        name: entry.path.split("/").pop() || entry.path,
        isDirectory: false,
        extension: entry.path.includes(".")
          ? entry.path.split(".").pop() || ""
          : "",
        status:
          gitStatus === "added"
            ? "added"
            : gitStatus === "modified" || gitStatus === "staged"
              ? "modified"
              : gitStatus === "deleted"
                ? "deleted"
                : gitStatus === "untracked"
                  ? "untracked"
                  : "unmodified",
        gitStatus,
        content: currentContent || undefined,
        language: inferLanguage(entry.path),
      };

      if (isStaged) {
        staged.push({ path: entry.path, entry: fileEntry });
        const cached = this._stagedContentCache.get(entry.path);
        if (cached !== undefined) {
          stagedContent.set(entry.path, cached);
        } else {
          const stagedText = await this.getStagedContent(entry.path);
          if (stagedText !== null) stagedContent.set(entry.path, stagedText);
        }
        const headText = await this.getHeadContent(entry.path);
        if (headText !== null) headContent.set(entry.path, headText);
      }
      if (isModified || isUntracked || (isDeleted && !isStaged)) {
        changes.push({ path: entry.path, entry: fileEntry });
        if (!stagedContent.has(entry.path)) {
          const cached = this._stagedContentCache.get(entry.path);
          if (cached !== undefined) {
            stagedContent.set(entry.path, cached);
          } else {
            const stagedText = await this.getStagedContent(entry.path);
            if (stagedText !== null) stagedContent.set(entry.path, stagedText);
          }
        }
        if (!headContent.has(entry.path)) {
          const headText = await this.getHeadContent(entry.path);
          if (headText !== null) headContent.set(entry.path, headText);
        }
      }
    }

    for (const f of diskFiles) {
      if (seen.has(f.path)) continue;
      const trackedSet = await this.getTrackedFileSet();
      if (trackedSet.has(f.path)) continue;
      const file = await this.readFile(f.path);
      const entry: WorkspaceFileEntry = {
        ...f,
        status: "untracked",
        gitStatus: "untracked" as FileGitStatus,
        content: file?.content,
      };
      changes.push({ path: f.path, entry });
    }

    Zotero.debug(
      `[seerai] getGitStatus: seen=${seen.size} disk=${diskFiles.length} staged=${staged.length} changes=${changes.length}`,
    );

    return { staged, changes, stagedContent, headContent };
  }

  async getFileGitStatus(path: string): Promise<FileGitStatus> {
    const normalized = this.normalizePath(path);
    const status = await this.getGitStatus();
    const stagedEntry = status.staged.find((s) => s.path === normalized);
    if (stagedEntry) return stagedEntry.entry.gitStatus || "staged";
    const changesEntry = status.changes.find((c) => c.path === normalized);
    if (changesEntry) return changesEntry.entry.gitStatus || "modified";
    return "committed";
  }

  async revertFile(path: string): Promise<void> {
    const normalized = this.normalizePath(path);
    const fileAbsPath = this.absPath(normalized);
    await this.ensureInit();

    // Try git checkout first (works for tracked/committed files)
    const result = await execGit(this.workspaceDir, [
      "checkout",
      "HEAD",
      "--",
      normalized,
    ]);

    // If checkout failed (exit != 0), the file is likely untracked/new —
    // just delete it from disk
    if (result.exitCode !== 0) {
      try {
        if (await IOUtils.exists(fileAbsPath)) {
          await IOUtils.remove(fileAbsPath);
          Zotero.debug(
            `[seerai] revertFile: removed untracked file "${normalized}"`,
          );
        }
      } catch (e) {
        Zotero.debug(
          `[seerai] revertFile: error removing "${normalized}": ${e}`,
        );
      }
    }

    this.onWorkspaceChanged?.();
  }

  async getGitState(): Promise<WorkspaceGitState> {
    await this.ensureInit();
    try {
      const logResult = await execGit(this.workspaceDir, [
        "log",
        `--format=%H|%s|%an|%ae|%at`,
        "-n",
        "50",
      ]);
      if (logResult.exitCode !== 0) {
        return { staged: [], commits: [], head: null };
      }
      const headResult = await execGit(this.workspaceDir, [
        "rev-parse",
        "HEAD",
      ]);
      const head = headResult.exitCode === 0 ? headResult.stdout.trim() : null;

      const commits = logResult.stdout
        .trim()
        .split("\n")
        .filter((l) => l.includes("|"))
        .map((line) => {
          const [oid, message, authorName, authorEmail, ts] = line.split("|");
          return {
            id: oid,
            message: message || "",
            author: authorName || "unknown",
            timestamp: new Date((parseInt(ts) || 0) * 1000).toISOString(),
            parent: oid,
          };
        });

      const stagedResult = await execGit(this.workspaceDir, [
        "diff",
        "--cached",
        "--name-only",
      ]);
      const staged =
        stagedResult.exitCode === 0
          ? stagedResult.stdout
              .trim()
              .split("\n")
              .filter((l) => l)
          : [];

      return { staged, commits, head };
    } catch {
      return { staged: [], commits: [], head: null };
    }
  }

  async getCommit(commitId: string): Promise<Commit | null> {
    await this.ensureInit();
    const result = await execGit(this.workspaceDir, [
      "show",
      commitId,
      "--format=%H%n%s%n%an%n%ae%n%at",
      "--no-patch",
    ]);
    if (result.exitCode !== 0) return null;

    const lines = result.stdout.trim().split("\n");
    const oid = lines[0] || commitId;
    const message = lines.slice(1, -3).join("\n") || "";
    const authorName = lines[lines.length - 3] || "unknown";
    const authorEmail = lines[lines.length - 2] || "";
    const timestamp = parseInt(lines[lines.length - 1]) || 0;

    const files: Record<string, string> = {};
    const listResult = await execGit(this.workspaceDir, [
      "ls-tree",
      "-r",
      "--name-only",
      commitId,
    ]);
    if (listResult.exitCode === 0) {
      for (const filePath of listResult.stdout.trim().split("\n")) {
        if (!filePath) continue;
        const showResult = await execGit(this.workspaceDir, [
          "show",
          `${commitId}:${filePath}`,
        ]);
        files[filePath] = showResult.exitCode === 0 ? showResult.stdout : "";
      }
    }

    return {
      id: oid,
      message,
      author: authorName,
      timestamp: new Date(timestamp * 1000).toISOString(),
      parent: oid,
      files,
    };
  }

  async getCommits(): Promise<CommitSummary[]> {
    return (await this.getGitState()).commits;
  }

  async getDiff(
    filePath: string,
    previous: boolean = true,
    _versionId?: string,
  ): Promise<DiffResult | null> {
    const normalized = this.normalizePath(filePath);
    await this.ensureInit();
    const currentFile = await this.readFile(normalized);
    if (!currentFile) return null;
    const headContent = await this.getHeadContent(normalized);
    const baseContent = headContent ?? "";
    if (baseContent === currentFile.content) return null;
    return createDiffResult(normalized, baseContent, currentFile.content);
  }

  async getVersionHistory(
    filePath: string,
    limit: number = 20,
  ): Promise<FileVersion[]> {
    const normalized = this.normalizePath(filePath);
    await this.ensureInit();
    const result = await execGit(this.workspaceDir, [
      "log",
      `--format=%H|%s|%an|%at`,
      "-n",
      String(limit),
      "--",
      normalized,
    ]);
    if (result.exitCode !== 0) return [];
    return result.stdout
      .trim()
      .split("\n")
      .filter((l) => l.includes("|"))
      .map((line) => {
        const [oid, message, author, ts] = line.split("|");
        return {
          id: oid,
          content: "",
          timestamp: new Date((parseInt(ts) || 0) * 1000).toISOString(),
          author: author || "unknown",
          message: message || "",
          parentVersionId: null,
        };
      });
  }

  async glob(pattern: string, basePath: string = ""): Promise<string[]> {
    const files = await this.listFiles();
    const regex = globToRegex(pattern);
    const filtered = basePath
      ? files.filter((f) => {
          const nb = this.normalizePath(basePath);
          if (!f.path.startsWith(nb + "/")) return false;
          return regex.test(f.path.slice(nb.length + 1));
        })
      : files.filter((f) => regex.test(f.path));
    return filtered.map((f) => f.path);
  }

  async grep(
    pattern: string,
    include?: string,
    basePath: string = "",
  ): Promise<Array<{ file: string; line: number; content: string }>> {
    const matches: Array<{ file: string; line: number; content: string }> = [];
    let files = await this.listFiles();
    if (include) {
      const incRegex = globToRegex(include);
      const nb = basePath ? this.normalizePath(basePath) : "";
      files = files.filter((f) => {
        const rel = nb
          ? f.path.startsWith(nb + "/")
            ? f.path.slice(nb.length + 1)
            : f.path
          : f.path;
        return incRegex.test(rel);
      });
    }
    if (basePath) {
      const base = this.normalizePath(basePath);
      files = files.filter((f) => f.path.startsWith(base + "/"));
    }
    try {
      new RegExp(pattern, "g");
    } catch {
      return [];
    }
    const searchRegex = new RegExp(pattern, "g");
    for (const file of files) {
      if (file.isDirectory) continue;
      const wsFile = await this.readFile(file.path);
      if (!wsFile) continue;
      const lines = wsFile.content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (searchRegex.test(lines[i])) {
          searchRegex.lastIndex = 0;
          matches.push({
            file: file.path,
            line: i + 1,
            content: lines[i],
          });
        }
        searchRegex.lastIndex = 0;
      }
    }
    return matches;
  }

  async revertToCommit(commitId: string): Promise<void> {
    await this.ensureInit();
    await execGit(this.workspaceDir, ["checkout", commitId, "--", "."]);
    this._stagedContentCache.clear();
    this.onWorkspaceChanged?.();
  }

  async getCommitHistory(): Promise<CommitSummary[]> {
    return this.getCommits();
  }

  async diffStagedAgainstHead(path: string): Promise<DiffResult | null> {
    const normalized = this.normalizePath(path);
    const stagedText = await this.getStagedContent(normalized);
    if (stagedText === null) return null;
    const headText = (await this.getHeadContent(normalized)) ?? "";
    return createDiffResult(normalized, headText, stagedText);
  }

  async diffWorkingAgainstStaged(path: string): Promise<DiffResult | null> {
    const normalized = this.normalizePath(path);
    const stagedText = await this.getStagedContent(normalized);
    const file = await this.readFile(normalized);
    const workText = file?.content ?? "";
    if (stagedText === null) {
      const headText = (await this.getHeadContent(normalized)) ?? "";
      return createDiffResult(normalized, headText, workText);
    }
    return createDiffResult(normalized, stagedText, workText);
  }

  async hasUncommittedChanges(): Promise<boolean> {
    const status = await this.getGitStatus();
    return status.staged.length > 0 || status.changes.length > 0;
  }

  async hasContent(): Promise<boolean> {
    const files = await this.listFiles();
    if (files.length > 0) return true;
    const state = await this.getGitState();
    return state.commits.length > 0;
  }
}

function globToRegex(pattern: string): RegExp {
  let regexStr = "^";
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        regexStr += ".*";
        i += 2;
        if (pattern[i] === "/") i++;
      } else {
        regexStr += "[^/]*";
        i++;
      }
    } else if (ch === "?") {
      regexStr += "[^/]";
      i++;
    } else if (ch === ".") {
      regexStr += "\\.";
      i++;
    } else if ("^$+{}[]()|\\".includes(ch)) {
      regexStr += "\\" + ch;
      i++;
    } else {
      regexStr += ch;
      i++;
    }
  }
  regexStr += "$";
  return new RegExp(regexStr);
}

let workspaceStoreInstance: WorkspaceStore | null = null;

export function getWorkspaceStore(): WorkspaceStore {
  if (!workspaceStoreInstance) {
    workspaceStoreInstance = new WorkspaceStore();
  }
  return workspaceStoreInstance;
}

export function resetWorkspaceStore(): void {
  workspaceStoreInstance = null;
}
