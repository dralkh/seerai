/**
 * Workspace Types - Per-chat file system with git-like versioning
 */

export interface WorkspaceFile {
  /** Relative path within the workspace (e.g. "src/main.ts") */
  path: string;
  /** Current file content */
  content: string;
  /** Language for syntax highlighting (inferred from extension) */
  language: string;
  /** Version history (newest first) */
  versions: FileVersion[];
  /** File creation timestamp */
  createdAt: string;
  /** Last modification timestamp */
  updatedAt: string;
}

export interface FileVersion {
  /** Unique version identifier */
  id: string;
  /** Content at this version */
  content: string;
  /** ISO timestamp */
  timestamp: string;
  /** Author (default: "assistant") */
  author: string;
  /** Description of the change */
  message: string;
  /** Parent version ID (null for initial version) */
  parentVersionId: string | null;
}

export interface WorkspaceSnapshot {
  /** Conversation ID this workspace belongs to */
  conversationId: string;
  /** Root directory path on disk */
  rootPath: string;
  /** All files in the workspace */
  files: WorkspaceFile[];
  /** Patterns to ignore (like .gitignore) */
  ignored: string[];
  /** Snapshot timestamp */
  savedAt: string;
}

export interface DiffHunk {
  /** Starting line number in old version */
  oldStart: number;
  /** Number of lines in old version */
  oldLines: number;
  /** Starting line number in new version */
  newStart: number;
  /** Number of lines in new version */
  newLines: number;
  /** Lines in this hunk (prefixed with ' ', '+', or '-') */
  lines: DiffLine[];
}

export interface DiffLine {
  /** Type of change: ' ' (unchanged), '+' (added), '-' (removed) */
  type: " " | "+" | "-";
  /** Line content */
  content: string;
  /** Line number in old version (0 if not present) */
  oldLineNumber: number;
  /** Line number in new version (0 if not present) */
  newLineNumber: number;
}

export interface DiffResult {
  /** File path */
  path: string;
  /** The hunks of changes */
  hunks: DiffHunk[];
  /** Total lines added */
  additions: number;
  /** Total lines removed */
  deletions: number;
  /** Old content (for reference) */
  oldContent: string;
  /** New content */
  newContent: string;
  /** Version ID of old state */
  oldVersionId?: string;
  /** Version ID of new state */
  newVersionId?: string;
}

export interface WorkspaceFileEntry {
  /** File path */
  path: string;
  /** Display name (last segment) */
  name: string;
  /** Whether this is a directory */
  isDirectory: boolean;
  /** File extension */
  extension: string;
  /** Git-like status indicator */
  status: FileStatus;
  /** Child entries (for directories) */
  children?: WorkspaceFileEntry[];
  /** Current file content (for files) */
  content?: string;
  /** Language for syntax highlighting */
  language?: string;
  /** Whether the file is currently open in an editor */
  isOpen?: boolean;
  /** Git staging status */
  gitStatus?: FileGitStatus;
}

export type FileStatus =
  | "unmodified"
  | "modified"
  | "added"
  | "deleted"
  | "untracked";

/** Parameters for workspace_read_file tool */
export interface WorkspaceReadFileParams {
  path: string;
  /** Offset line (1-indexed, for partial reads) */
  offset?: number;
  /** Maximum lines to read */
  limit?: number;
}

/** Result from workspace_read_file */
export interface WorkspaceReadFileResult {
  path: string;
  content: string;
  totalLines: number;
  truncated: boolean;
  offset: number;
  language: string;
}

/** Parameters for workspace_write_file tool */
export interface WorkspaceWriteFileParams {
  path: string;
  content: string;
  /** Optional change description for version history */
  message?: string;
}

/** Result from workspace_write_file */
export interface WorkspaceWriteFileResult {
  path: string;
  versionId: string;
  linesWritten: number;
  created: boolean;
}

/** Parameters for workspace_edit_file tool */
export interface WorkspaceEditFileParams {
  path: string;
  oldString: string;
  newString: string;
  /** Replace all occurrences (default false) */
  replaceAll?: boolean;
  /** Change description */
  message?: string;
}

export interface WorkspacePatchParams {
  path: string;
  oldString: string;
  newString: string;
  message?: string;
  dryRun?: boolean;
}

export interface WorkspaceSearchFilesParams {
  query: string;
  mode?: "content" | "name" | "both";
  include?: string;
  path?: string;
  limit?: number;
}

/** Result from workspace_edit_file */
export interface WorkspaceEditFileResult {
  path: string;
  versionId: string;
  oldString: string;
  newString: string;
  replacements: number;
}

/** Parameters for workspace_glob tool */
export interface WorkspaceGlobParams {
  pattern: string;
  /** Directory to search within (relative to workspace root) */
  path?: string;
}

/** Result from workspace_glob */
export interface WorkspaceGlobResult {
  pattern: string;
  matches: string[];
  count: number;
}

/** Parameters for workspace_grep tool */
export interface WorkspaceGrepParams {
  pattern: string;
  /** Glob pattern to filter files */
  include?: string;
  /** Directory to search within */
  path?: string;
}

/** Result from workspace_grep */
export interface WorkspaceGrepMatch {
  file: string;
  line: number;
  content: string;
}

export interface WorkspaceGrepResult {
  pattern: string;
  matches: WorkspaceGrepMatch[];
  count: number;
}

/** Parameters for workspace_bash tool */
export interface WorkspaceBashParams {
  command: string;
  /** Working directory (relative to workspace root) */
  workdir?: string;
}

/** Result from workspace_bash */
export interface WorkspaceBashResult {
  command: string;
  /** For Zotero context: bash commands cannot be executed directly.
   *  The tool records the command and prompts the user to execute it. */
  note: string;
}

/** Parameters for workspace_question tool */
export interface WorkspaceQuestionParams {
  questions: WorkspaceQuestionPrompt[];
}

export interface WorkspaceQuestionPrompt {
  question: string;
  header: string;
  options: WorkspaceQuestionOption[];
  multiple?: boolean;
}

export interface WorkspaceQuestionOption {
  label: string;
  description: string;
}

/** Result from workspace_question */
export interface WorkspaceQuestionResult {
  responses: WorkspaceQuestionResponse[];
  answeredAt: string;
}

export interface WorkspaceQuestionResponse {
  question: string;
  selectedLabels: string[];
}

/** Parameters for workspace_diff tool */
export interface WorkspaceDiffParams {
  path: string;
  /** Version ID to compare (defaults to previous version) */
  versionId?: string;
  /** Compare this version with its parent */
  previous?: boolean;
}

/** Parameters for workspace_log tool */
export interface WorkspaceLogParams {
  path: string;
  /** Maximum number of entries to return */
  limit?: number;
}

/** Result from workspace_log */
export interface WorkspaceLogResult {
  path: string;
  versions: Array<{
    id: string;
    author: string;
    message: string;
    timestamp: string;
    additions?: number;
    deletions?: number;
  }>;
}

export function inferLanguage(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() || "";
  const langMap: Record<string, string> = {
    ts: "typescript",
    tsx: "tsx",
    js: "javascript",
    jsx: "jsx",
    json: "json",
    md: "markdown",
    css: "css",
    html: "html",
    xhtml: "html",
    xml: "xml",
    yaml: "yaml",
    yml: "yaml",
    toml: "toml",
    py: "python",
    rs: "rust",
    go: "go",
    java: "java",
    c: "c",
    cpp: "cpp",
    h: "c",
    hpp: "cpp",
    sh: "bash",
    bash: "bash",
    zsh: "bash",
    txt: "text",
    csv: "csv",
    bib: "bibtex",
    tex: "latex",
    sql: "sql",
    graphql: "graphql",
    gql: "graphql",
    env: "text",
    cfg: "text",
    ini: "text",
    lock: "text",
    log: "text",
  };
  return langMap[ext] || "text";
}

// ============================================================================
// Git-like staging and commit types
// ============================================================================

export type FileGitStatus =
  | "staged"
  | "modified"
  | "added"
  | "deleted"
  | "untracked"
  | "committed"
  | "unmodified";

export interface WorkspaceGitState {
  /** Paths of files currently staged */
  staged: string[];
  /** Commit history metadata */
  commits: CommitSummary[];
  /** HEAD commit ID, or null if no commits yet */
  head: string | null;
}

export interface CommitSummary {
  /** Unique commit ID (timestamp-based) */
  id: string;
  /** Commit message */
  message: string;
  /** Author name */
  author: string;
  /** ISO timestamp */
  timestamp: string;
  /** Parent commit ID, or null for initial commit */
  parent: string | null;
}

export interface Commit extends CommitSummary {
  /** Path → content map at commit time */
  files: Record<string, string>;
}

export interface GitStatusResult {
  /** Files currently staged */
  staged: Array<{ path: string; entry: WorkspaceFileEntry }>;
  /** Files with unstaged changes */
  changes: Array<{ path: string; entry: WorkspaceFileEntry }>;
  /** Path → staged content for diff display */
  stagedContent: Map<string, string>;
  /** Path → HEAD content for diff display */
  headContent: Map<string, string>;
}
