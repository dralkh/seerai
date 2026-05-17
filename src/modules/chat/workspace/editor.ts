/**
 * Workspace Editor UI - Inline file editor that appears above the chat input.
 * Supports opening multiple files in tabs, editing, and saving with versioning.
 */

import { getWorkspaceStore } from "./store";
import { WorkspaceFileEntry, inferLanguage, DiffLine } from "./types";
import { createDiffResult } from "./diff";

const HTML_NS = "http://www.w3.org/1999/xhtml";

function escapeHTML(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

interface WordPart {
  text: string;
  changed: boolean;
}

interface WordDiffResult {
  oldParts: WordPart[];
  newParts: WordPart[];
}

function computeWordDiff(oldStr: string, newStr: string): WordDiffResult {
  const oldTokens = oldStr.split(/(\s+)/);
  const newTokens = newStr.split(/(\s+)/);

  const oldWords = oldTokens.filter((t) => t.trim().length > 0);
  const newWords = newTokens.filter((t) => t.trim().length > 0);

  const m = oldWords.length;
  const n = newWords.length;

  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    new Array(n + 1).fill(0),
  );
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (oldWords[i - 1] === newWords[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  const lcsOldSet = new Set<number>();
  const lcsNewSet = new Set<number>();
  let i = m;
  let j = n;
  while (i > 0 && j > 0) {
    if (oldWords[i - 1] === newWords[j - 1]) {
      lcsOldSet.add(i - 1);
      lcsNewSet.add(j - 1);
      i--;
      j--;
    } else if (dp[i - 1][j] > dp[i][j - 1]) {
      i--;
    } else {
      j--;
    }
  }

  const oldParts: WordPart[] = [];
  let wi = 0;
  for (const tok of oldTokens) {
    if (tok.trim().length > 0) {
      oldParts.push({
        text: tok,
        changed: !lcsOldSet.has(wi),
      });
      wi++;
    } else {
      oldParts.push({ text: tok, changed: false });
    }
  }

  const newParts: WordPart[] = [];
  let wj = 0;
  for (const tok of newTokens) {
    if (tok.trim().length > 0) {
      newParts.push({
        text: tok,
        changed: !lcsNewSet.has(wj),
      });
      wj++;
    } else {
      newParts.push({ text: tok, changed: false });
    }
  }

  return { oldParts, newParts };
}

function createDiffLine(
  doc: Document,
  line: DiffLine,
  bgColor: string,
  fgColor: string,
  wordParts: WordPart[] | null,
): HTMLElement {
  const lineNum =
    line.type === "+"
      ? String(line.newLineNumber).padStart(4, "\u00A0")
      : line.type === "-"
        ? String(line.oldLineNumber).padStart(4, "\u00A0")
        : `${String(line.oldLineNumber).padStart(4, "\u00A0")}\u00A0`;

  let contentHTML: string;
  if (wordParts) {
    const parts = wordParts
      .map((p) => {
        const escaped = escapeHTML(p.text);
        if (p.changed && line.type === "-") {
          return `<span style="background: rgba(239, 83, 80, 0.45); text-decoration: line-through; border-radius: 2px;">${escaped}</span>`;
        }
        if (p.changed && line.type === "+") {
          return `<span style="background: rgba(76, 175, 80, 0.45); border-radius: 2px;">${escaped}</span>`;
        }
        return escaped;
      })
      .join("");
    contentHTML = `${line.type} ${parts}`;
  } else {
    const escaped = escapeHTML(line.content);
    contentHTML = `${line.type} ${escaped}`;
  }

  const isChange = line.type === "+" || line.type === "-";

  const row = doc.createElement("div");
  row.style.cssText = `display: flex; background: ${bgColor}; padding: 0 4px; min-height: 1.5em;${
    isChange ? " cursor: pointer;" : ""
  }`;

  const numSpan = doc.createElementNS(HTML_NS, "span") as HTMLElement;
  numSpan.style.cssText =
    "color: var(--text-tertiary); min-width: 50px; text-align: right; margin-right: 8px; user-select: none; flex-shrink: 0;";
  numSpan.textContent = lineNum;

  const contentSpan = doc.createElementNS(HTML_NS, "span") as HTMLElement;
  contentSpan.style.cssText = `color: ${fgColor}; white-space: pre-wrap; word-break: break-word; user-select: text;`;
  if (wordParts) {
    const prefix = doc.createTextNode(`${line.type} `);
    contentSpan.appendChild(prefix);
    for (const p of wordParts) {
      if (p.changed && line.type === "-") {
        const s = doc.createElementNS(HTML_NS, "span") as HTMLElement;
        s.style.cssText =
          "background: rgba(239, 83, 80, 0.45); text-decoration: line-through; border-radius: 2px;";
        s.textContent = p.text;
        contentSpan.appendChild(s);
      } else if (p.changed && line.type === "+") {
        const s = doc.createElementNS(HTML_NS, "span") as HTMLElement;
        s.style.cssText =
          "background: rgba(76, 175, 80, 0.45); border-radius: 2px;";
        s.textContent = p.text;
        contentSpan.appendChild(s);
      } else {
        contentSpan.appendChild(doc.createTextNode(p.text));
      }
    }
  } else {
    contentSpan.textContent = `${line.type} ${line.content}`;
  }

  row.appendChild(numSpan);
  row.appendChild(contentSpan);

  if (isChange) {
    row.dataset.copyText = line.content;
    row.addEventListener("mouseenter", () => {
      row.style.filter = "brightness(1.1)";
    });
    row.addEventListener("mouseleave", () => {
      row.style.filter = "";
    });
  }

  return row;
}

export interface WorkspaceEditorCallbacks {
  onClose: () => void;
}

interface EditorTab {
  path: string;
  entry: WorkspaceFileEntry;
  editor: HTMLTextAreaElement;
  preview: HTMLElement;
  saveBtn: HTMLElement;
  nameLabel: HTMLElement;
  isModified: boolean;
  originalContent: string;
}

export class WorkspaceEditorManager {
  private static instance: WorkspaceEditorManager;
  private openTabs: Map<string, EditorTab> = new Map();
  private activePath: string | null = null;
  private container: HTMLElement | null = null;
  private tabBar: HTMLElement | null = null;
  private contentArea: HTMLElement | null = null;
  private diffOverlay: HTMLElement | null = null;
  private doc: Document | null = null;

  static getInstance(): WorkspaceEditorManager {
    if (!WorkspaceEditorManager.instance) {
      WorkspaceEditorManager.instance = new WorkspaceEditorManager();
    }
    return WorkspaceEditorManager.instance;
  }

  closeAll(): void {
    this.openTabs.clear();
    this.activePath = null;
    this.tabBar = null;
    this.contentArea = null;
    this.diffOverlay = null;
    if (this.container) {
      this.container.textContent = "";
      this.container.style.display = "none";
    }
  }

  createEditorContainer(doc: Document, container: HTMLElement): void {
    // Reset state when container is recreated (e.g., after re-render)
    this.openTabs.clear();
    this.activePath = null;
    this.tabBar = null;
    this.contentArea = null;
    this.diffOverlay = null;

    this.doc = doc;
    this.container = container;

    container.style.cssText = `
      display: none;
      flex-direction: column;
      border-bottom: 1px solid var(--border-primary);
      min-height: 120px;
      height: 300px;
      flex-shrink: 0;
      background-color: var(--background-primary);
      overflow: hidden;
    `;
  }

  async openFile(entry: WorkspaceFileEntry): Promise<void> {
    const doc = this.doc;
    if (!doc || !this.container) {
      Zotero.debug(
        "[seerai] WorkspaceEditor: openFile aborted - no doc or container",
      );
      return;
    }

    // Clear any active diff overlay when switching files
    if (this.diffOverlay) {
      this.diffOverlay.remove();
      this.diffOverlay = null;
    }

    // If already open, just switch to it
    if (this.openTabs.has(entry.path)) {
      this.switchTab(entry.path);
      return;
    }

    const store = getWorkspaceStore();
    const file = await store.readFile(entry.path);
    if (!file) {
      Zotero.debug(
        `[seerai] WorkspaceEditor: openFile aborted - file not found: ${entry.path}`,
      );
      return;
    }

    const content = file.content;

    // Show container
    this.container.style.display = "flex";

    // Create tab bar if not exists
    if (!this.tabBar) {
      this.tabBar = doc.createElement("div");
      this.tabBar.style.cssText = `
        display: flex;
        align-items: center;
        background: var(--background-secondary);
        border-bottom: 1px solid var(--border-primary);
        gap: 0;
        min-height: 32px;
        flex-shrink: 0;
        overflow-x: auto;
        overflow-y: hidden;
      `;
      this.container.appendChild(this.tabBar);
    }

    // Create content area if not exists
    if (!this.contentArea) {
      this.contentArea = doc.createElement("div");
      this.contentArea.style.cssText = `
        flex: 1 1 0;
        display: flex;
        flex-direction: column;
        min-height: 0;
        overflow: hidden;
      `;
      this.container.appendChild(this.contentArea);
    }

    // Create tab
    const tab = doc.createElement("div");
    tab.className = "workspace-editor-tab";
    tab.style.cssText = `
      display: flex;
      align-items: center;
      padding: 4px 10px;
      cursor: pointer;
      font-size: 11px;
      color: var(--text-secondary);
      border-right: 1px solid var(--border-primary);
      gap: 6px;
      white-space: nowrap;
      user-select: none;
      transition: background-color 0.15s;
    `;

    const tabName = doc.createElement("span");
    tabName.textContent = entry.name;
    tab.appendChild(tabName);

    const closeBtn = doc.createElement("span");
    closeBtn.textContent = "\u00D7";
    closeBtn.style.cssText = `
      font-size: 16px;
      cursor: pointer;
      padding: 0 2px;
      border-radius: 3px;
    `;
    closeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.closeTab(entry.path);
    });
    closeBtn.addEventListener("mouseenter", () => {
      closeBtn.style.backgroundColor = "var(--background-primary)";
    });
    tab.appendChild(closeBtn);

    tab.addEventListener("click", () => this.switchTab(entry.path));
    this.tabBar.appendChild(tab);

    // Create editor content (textarea + toolbar)
    const editorWrapper = doc.createElement("div");
    editorWrapper.style.cssText = `
      display: flex;
      flex-direction: column;
      height: 100%;
      min-height: 0;
      overflow: hidden;
    `;
    editorWrapper.dataset.path = entry.path;

    // Toolbar
    const toolbar = doc.createElement("div");
    toolbar.style.cssText = `
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 4px 12px;
      border-bottom: 1px solid var(--border-primary);
      font-size: 11px;
      flex-shrink: 0;
      background: var(--background-primary);
    `;

    const langLabel = doc.createElement("span");
    langLabel.textContent = inferLanguage(entry.path);
    langLabel.style.cssText =
      "color: var(--text-secondary); font-style: italic;";
    toolbar.appendChild(langLabel);

    const toolbarActions = doc.createElement("div");
    toolbarActions.style.cssText = "display: flex; gap: 4px;";

    const stageBtn = doc.createElementNS(
      HTML_NS,
      "button",
    ) as HTMLButtonElement;
    stageBtn.textContent = "\u2B07 Stage";
    stageBtn.title = "Stage changes for commit";
    stageBtn.style.cssText = createSmallBtnStyle();
    stageBtn.style.color = "#4caf50";

    const revertBtn = doc.createElementNS(
      HTML_NS,
      "button",
    ) as HTMLButtonElement;
    revertBtn.textContent = "\u21A9 Revert";
    revertBtn.title = "Discard changes and revert to HEAD";
    revertBtn.style.cssText = createSmallBtnStyle();
    revertBtn.style.color = "#ef5350";

    const saveBtn = doc.createElementNS(HTML_NS, "button") as HTMLButtonElement;
    saveBtn.textContent = "Save";
    saveBtn.title = "Save changes (Ctrl+S)";
    saveBtn.style.cssText = createSmallBtnStyle();
    saveBtn.style.backgroundColor = "var(--highlight-primary)";
    saveBtn.style.color = "#fff";

    toolbarActions.appendChild(stageBtn);
    toolbarActions.appendChild(revertBtn);
    toolbarActions.appendChild(saveBtn);
    toolbar.appendChild(toolbarActions);
    editorWrapper.appendChild(toolbar);

    // Textarea editor
    const textarea = doc.createElement("textarea") as HTMLTextAreaElement;
    textarea.value = content;
    textarea.spellcheck = false;
    textarea.style.cssText = `
      flex: 1 1 0;
      min-height: 0;
      padding: 12px;
      border: none;
      outline: none;
      resize: none;
      font-family: "Menlo", "Monaco", "Consolas", "Courier New", monospace;
      font-size: 12px;
      line-height: 1.6;
      tab-size: 2;
      color: var(--text-primary);
      background-color: var(--background-primary);
      overflow: auto;
    `;

    // Track modifications
    let isModified = false;
    textarea.addEventListener("input", () => {
      if (!isModified) {
        isModified = true;
        tabName.style.fontWeight = "600";
        tabName.style.color = "var(--highlight-primary)";
        saveBtn.style.opacity = "1";
      }
    });

    // Ctrl+S to save
    textarea.addEventListener("keydown", async (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "s") {
        e.preventDefault();
        await this.saveFile(entry.path, textarea);
        isModified = false;
        tabName.style.fontWeight = "normal";
        tabName.style.color = "var(--text-primary)";
        saveBtn.style.opacity = "0.5";
        const tab = this.openTabs.get(entry.path);
        if (tab) {
          tab.isModified = false;
          tab.originalContent = textarea.value;
        }
      }
    });

    // Save button handler
    saveBtn.addEventListener("click", async () => {
      await this.saveFile(entry.path, textarea);
      isModified = false;
      tabName.style.fontWeight = "normal";
      tabName.style.color = "var(--text-primary)";
      saveBtn.style.opacity = "0.5";
      const tab = this.openTabs.get(entry.path);
      if (tab) {
        tab.isModified = false;
        tab.originalContent = textarea.value;
      }
    });

    // Stage button handler
    stageBtn.addEventListener("click", async () => {
      try {
        const store = getWorkspaceStore();
        await store.stageFile(entry.path);
        // Brief feedback
        stageBtn.textContent = "\u2713 Staged";
        setTimeout(() => {
          stageBtn.textContent = "\u2B07 Stage";
        }, 1500);
      } catch (e) {
        Zotero.debug(`[seerai] Stage failed: ${e}`);
      }
    });

    // Revert button handler
    revertBtn.addEventListener("click", async () => {
      if (
        !doc.defaultView?.confirm(
          `Discard all changes to "${entry.path}"? This cannot be undone.`,
        )
      )
        return;
      try {
        const store = getWorkspaceStore();
        await store.revertFile(entry.path);
        // Reload file content
        const file = await store.readFile(entry.path);
        if (file) {
          textarea.value = file.content;
          isModified = false;
          tabName.style.fontWeight = "normal";
          tabName.style.color = "var(--text-primary)";
          const tab = this.openTabs.get(entry.path);
          if (tab) {
            tab.isModified = false;
            tab.originalContent = file.content;
          }
        }
      } catch (e) {
        Zotero.debug(`[seerai] Revert failed: ${e}`);
      }
    });

    editorWrapper.appendChild(textarea);
    this.contentArea.appendChild(editorWrapper);

    const tabData: EditorTab = {
      path: entry.path,
      entry,
      editor: textarea,
      preview: editorWrapper,
      saveBtn,
      nameLabel: tabName,
      isModified: false,
      originalContent: content,
    };

    this.openTabs.set(entry.path, tabData);
    this.switchTab(entry.path);
  }

  async openFileWithDiff(
    entry: WorkspaceFileEntry,
    oldContent: string,
    newContent: string,
  ): Promise<void> {
    await this.openFile(entry);
    await this.showDiffPreview(entry.path, oldContent, newContent);
  }

  private switchTab(path: string): void {
    if (!this.tabBar || !this.contentArea) return;

    this.activePath = path;

    // Update tab styles
    const tabs = this.tabBar.querySelectorAll(".workspace-editor-tab");
    tabs.forEach((tab: Element, _idx: number) => {
      const isActive =
        (tab.querySelector("span")?.textContent || "") ===
        this.openTabs.get(path)?.entry.name;
      (tab as HTMLElement).style.backgroundColor = isActive
        ? "var(--background-primary)"
        : "transparent";
      (tab as HTMLElement).style.color = isActive
        ? "var(--text-primary)"
        : "var(--text-secondary)";
    });

    // Show active editor, hide others
    const wrappers = this.contentArea.querySelectorAll("[data-path]");
    wrappers.forEach((wrapper: Element) => {
      (wrapper as HTMLElement).style.display =
        (wrapper as HTMLElement).dataset.path === path ? "flex" : "none";
    });
  }

  private closeTab(path: string): void {
    if (!this.tabBar || !this.contentArea) return;

    const tab = this.openTabs.get(path);
    if (tab) {
      this.openTabs.delete(path);
      tab.preview.remove();

      // Remove tab from tab bar
      const tabs = this.tabBar.querySelectorAll(".workspace-editor-tab");
      tabs.forEach((t: Element) => {
        if (t.querySelector("span")?.textContent === tab.entry.name) {
          t.remove();
        }
      });
    }

    // Switch to next available tab
    if (this.activePath === path) {
      const remaining = Array.from(this.openTabs.keys());
      if (remaining.length > 0) {
        this.switchTab(remaining[remaining.length - 1]);
      } else {
        this.activePath = null;
        if (this.container) {
          this.container.style.display = "none";
        }
      }
    }
  }

  private async saveFile(
    path: string,
    textarea: HTMLTextAreaElement,
  ): Promise<void> {
    try {
      const store = getWorkspaceStore();
      await store.writeFile(
        path,
        textarea.value,
        `Edited via workspace editor`,
        "user",
      );

      // Brief save indicator
      const original = textarea.style.backgroundColor;
      textarea.style.backgroundColor = "rgba(76, 175, 80, 0.1)";
      setTimeout(() => {
        textarea.style.backgroundColor = original;
      }, 600);
    } catch (e) {
      Zotero.debug(`[seerai] Error saving workspace file: ${e}`);
    }
  }

  private async showDiffPreview(
    path: string,
    oldContent: string,
    newContent: string,
  ): Promise<void> {
    const doc = this.doc;
    if (!doc) return;

    // Remove existing overlay
    if (this.diffOverlay) {
      this.diffOverlay.remove();
    }

    const diff = createDiffResult(path, oldContent, newContent);
    const name = path.split("/").pop() || path;

    const overlay = doc.createElement("div");
    overlay.className = "workspace-diff-overlay";
    overlay.style.cssText = `
      position: absolute;
      top: 0; left: 0; right: 0; bottom: 0;
      background: var(--background-primary);
      z-index: 1000;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    `;

    // Header
    const header = doc.createElement("div");
    header.style.cssText = `
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 8px 12px;
      border-bottom: 1px solid var(--border-primary);
      background: var(--background-secondary);
      flex-shrink: 0;
    `;

    const isNewFile = !oldContent && newContent;
    const titleText = isNewFile
      ? `New file: ${name}`
      : `Changes: ${name} (+${diff.additions} \u2212${diff.deletions})`;
    const title = doc.createElement("span");
    title.textContent = titleText;
    title.style.cssText =
      "font-size: 12px; font-weight: 600; color: var(--text-primary);";
    header.appendChild(title);

    const closeBtn = doc.createElementNS(
      HTML_NS,
      "button",
    ) as HTMLButtonElement;
    closeBtn.textContent = "\u2715";
    closeBtn.style.cssText = `
      background: none;
      border: none;
      cursor: pointer;
      font-size: 14px;
      color: var(--text-secondary);
      padding: 2px 6px;
    `;
    closeBtn.addEventListener("click", () => overlay.remove());
    header.appendChild(closeBtn);

    overlay.appendChild(header);

    // Diff content
    const diffContent = doc.createElement("div");
    diffContent.style.cssText = `
      flex: 1 1 0;
      overflow: auto;
      font-family: "Menlo", "Monaco", "Consolas", "Courier New", monospace;
      font-size: 11px;
      line-height: 1.5;
      padding: 8px;
      overflow-x: auto;
      white-space: pre-wrap;
      word-break: break-word;
      user-select: text;
      cursor: text;
      background: var(--background-primary);
    `;

    if (diff.hunks.length === 0) {
      diffContent.textContent = "No changes between these versions.";
      diffContent.style.color = "var(--text-tertiary)";
      diffContent.style.fontStyle = "italic";
      diffContent.style.padding = "24px";
    } else {
      const toast = doc.createElement("div");
      toast.style.cssText = `
        position: absolute;
        bottom: 48px;
        left: 50%;
        transform: translateX(-50%);
        background: var(--background-secondary);
        color: var(--text-primary);
        padding: 4px 12px;
        border-radius: 4px;
        font-size: 11px;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        border: 1px solid var(--border-primary);
        opacity: 0;
        transition: opacity 0.15s ease;
        pointer-events: none;
        z-index: 10;
      `;
      toast.textContent = "Copied";
      overlay.appendChild(toast);

      const showToast = () => {
        toast.style.opacity = "1";
        setTimeout(() => {
          toast.style.opacity = "0";
        }, 1200);
      };

      const copyLines = (text: string) => {
        try {
          const clipboard = doc.defaultView?.navigator?.clipboard;
          if (clipboard) {
            void clipboard.writeText(text);
          }
        } catch {
          Zotero.debug("[seerai] clipboard write failed");
        }
        try {
          const sel = doc.defaultView?.getSelection();
          if (sel) sel.removeAllRanges();
        } catch {
          Zotero.debug("[seerai] selection clear failed");
        }
        showToast();
      };

      for (let hi = 0; hi < diff.hunks.length; hi++) {
        const hunk = diff.hunks[hi];
        const hunkHeader = doc.createElement("div");
        hunkHeader.style.cssText =
          "color: var(--text-tertiary); font-size: 10px; padding: 2px 0; margin-top: 4px;";
        hunkHeader.textContent = `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`;
        diffContent.appendChild(hunkHeader);

        let li = 0;
        while (li < hunk.lines.length) {
          const line = hunk.lines[li];

          if (line.type === "-") {
            const delLines: DiffLine[] = [];
            while (li < hunk.lines.length && hunk.lines[li].type === "-") {
              delLines.push(hunk.lines[li]);
              li++;
            }
            const addLines: DiffLine[] = [];
            while (li < hunk.lines.length && hunk.lines[li].type === "+") {
              addLines.push(hunk.lines[li]);
              li++;
            }

            if (addLines.length > 0 && delLines.length === addLines.length) {
              for (let pi = 0; pi < delLines.length; pi++) {
                const delRow = createDiffLine(
                  doc,
                  delLines[pi],
                  "rgba(239, 83, 80, 0.2)",
                  "#ef5350",
                  computeWordDiff(delLines[pi].content, addLines[pi].content)
                    .oldParts,
                );
                delRow.addEventListener("click", () =>
                  copyLines(delLines[pi].content),
                );
                diffContent.appendChild(delRow);

                const addRow = createDiffLine(
                  doc,
                  addLines[pi],
                  "rgba(76, 175, 80, 0.2)",
                  "#4caf50",
                  computeWordDiff(delLines[pi].content, addLines[pi].content)
                    .newParts,
                );
                addRow.addEventListener("click", () =>
                  copyLines(addLines[pi].content),
                );
                diffContent.appendChild(addRow);
              }
            } else if (addLines.length > 0) {
              const groupEl = doc.createElement("div");
              groupEl.style.cursor = "pointer";
              for (const delLine of delLines) {
                const row = createDiffLine(
                  doc,
                  delLine,
                  "rgba(239, 83, 80, 0.2)",
                  "#ef5350",
                  null,
                );
                groupEl.appendChild(row);
              }
              for (let ai = 0; ai < addLines.length; ai++) {
                const row = createDiffLine(
                  doc,
                  addLines[ai],
                  "rgba(76, 175, 80, 0.2)",
                  "#4caf50",
                  null,
                );
                groupEl.appendChild(row);
              }
              const groupText = [...delLines, ...addLines]
                .map((l) => l.content)
                .join("\n");
              groupEl.addEventListener("click", () => copyLines(groupText));
              diffContent.appendChild(groupEl);
            } else {
              const groupEl = doc.createElement("div");
              groupEl.style.cursor = "pointer";
              for (const delLine of delLines) {
                groupEl.appendChild(
                  createDiffLine(
                    doc,
                    delLine,
                    "rgba(239, 83, 80, 0.2)",
                    "#ef5350",
                    null,
                  ),
                );
              }
              const groupText = delLines.map((l) => l.content).join("\n");
              groupEl.addEventListener("click", () => copyLines(groupText));
              diffContent.appendChild(groupEl);
            }
          } else if (line.type === "+") {
            const row = createDiffLine(
              doc,
              line,
              "rgba(76, 175, 80, 0.2)",
              "#4caf50",
              null,
            );
            row.addEventListener("click", () => copyLines(line.content));
            diffContent.appendChild(row);
            li++;
          } else {
            const row = createDiffLine(
              doc,
              line,
              "transparent",
              "var(--text-secondary)",
              null,
            );
            diffContent.appendChild(row);
            li++;
          }
        }
      }
    }

    overlay.appendChild(diffContent);

    // Action buttons
    const actions = doc.createElement("div");
    actions.style.cssText = `
      display: flex;
      gap: 8px;
      justify-content: flex-end;
      padding: 8px 12px;
      border-top: 1px solid var(--border-primary);
      flex-shrink: 0;
    `;

    const doneBtn = doc.createElementNS(HTML_NS, "button") as HTMLButtonElement;
    doneBtn.textContent = "Close";
    doneBtn.style.cssText = createSmallBtnStyle();
    doneBtn.addEventListener("click", () => overlay.remove());
    actions.appendChild(doneBtn);

    overlay.appendChild(actions);

    // Append to container
    if (this.container) {
      this.container.style.position = "relative";
      this.container.appendChild(overlay);
    }

    this.diffOverlay = overlay;
  }

  getActivePath(): string | null {
    return this.activePath;
  }

  getOpenTabsCount(): number {
    return this.openTabs.size;
  }
}

function createSmallBtnStyle(): string {
  return `
    padding: 3px 10px;
    border-radius: 4px;
    border: 1px solid var(--border-primary);
    background: var(--background-secondary);
    color: var(--text-secondary);
    cursor: pointer;
    font-size: 10px;
    transition: opacity 0.2s;
    opacity: 0.5;
  `;
}
