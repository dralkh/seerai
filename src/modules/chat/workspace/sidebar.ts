/**
 * Workspace Sidebar UI - Git-like source control panel.
 * Renders staged/unstaged/changes split view with commit bar.
 */

import { config } from "../../../../package.json";
import { getPref, setPref } from "../../../utils/prefs";
import { getWorkspaceStore } from "./store";
import {
  WorkspaceFileEntry,
  FileStatus,
  GitStatusResult,
  FileGitStatus,
} from "./types";

const HTML_NS = "http://www.w3.org/1999/xhtml";

const statusIcons: Record<FileStatus, string> = {
  unmodified: "",
  modified: "M",
  added: "A",
  deleted: "D",
  untracked: "U",
};

const statusColors: Record<FileStatus, string> = {
  unmodified: "var(--text-tertiary)",
  modified: "#e5b73b",
  added: "#4caf50",
  deleted: "#ef5350",
  untracked: "#40c4ff",
};

const gitStatusLabels: Record<string, string> = {
  staged: "\u25CF",
  modified: "M",
  added: "+",
  deleted: "\u00D7",
  untracked: "?",
  committed: "\u2713",
  unmodified: "",
};

const gitStatusTitles: Record<string, string> = {
  staged: "Staged for commit",
  modified: "Modified (unstaged)",
  added: "New file",
  deleted: "Deleted",
  untracked: "Untracked",
  committed: "Committed (no changes)",
  unmodified: "No changes",
};

export interface WorkspaceSidebarCallbacks {
  onFileClick: (
    entry: WorkspaceFileEntry,
    diffMode?: "edit" | "staged" | "changes",
    oldContent?: string,
    newContent?: string,
  ) => void;
  onFileCreate: () => void;
  onFileDelete: (entry: WorkspaceFileEntry) => void;
  onFileRename: (entry: WorkspaceFileEntry) => void;
}

export function createWorkspaceSidebar(
  doc: Document,
  callbacks: WorkspaceSidebarCallbacks,
): HTMLElement {
  const sidebar = doc.createElement("div");
  sidebar.className = "workspace-sidebar";
  sidebar.style.cssText = `
    display: flex;
    flex-direction: column;
    flex-shrink: 0;
    border-left: 1px solid var(--border-primary);
    background-color: var(--background-secondary);
    height: 100%;
    width: 120px;
    min-width: 120px;
    overflow: hidden;
    transition: width 0.2s ease, min-width 0.2s ease;
    box-sizing: border-box;
  `;

  // Header
  const header = doc.createElement("div");
  header.style.cssText = `
    padding: 8px 12px;
    border-bottom: 1px solid var(--border-primary);
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-shrink: 0;
  `;

  const titleSpan = doc.createElement("span");
  titleSpan.className = "workspace-title-label";
  titleSpan.textContent = "ARTIFACTS";
  titleSpan.style.cssText = `
    font-size: 11px;
    font-weight: 700;
    color: var(--text-primary);
    text-transform: uppercase;
    letter-spacing: 0.8px;
  `;
  header.appendChild(titleSpan);

  const actions = doc.createElement("div");
  actions.style.cssText = "display: flex; gap: 4px;";

  const newFileBtn = createIconButton(doc, "+", "New file", () => {
    showNewFileInline(doc, sidebar, callbacks);
  });
  actions.appendChild(newFileBtn);

  // Commit button - shows commit dropdown
  const commitActionBtn = createIconButton(
    doc,
    "\u2713",
    "Commit staged changes",
    () => {
      showCommitDropdown(doc, commitActionBtn, sidebar, callbacks);
    },
  );
  actions.appendChild(commitActionBtn);

  const historyBtn = createIconButton(doc, "\u23F0", "Commit history", () => {
    const el = sidebar as any;
    el._showCommitHistoryPanel = true;
    refreshWorkspaceSidebar(sidebar, callbacks);
  });
  actions.appendChild(historyBtn);

  const openFolderBtn = createIconButton(
    doc,
    "\uD83D\uDCC2",
    "Open folder",
    () => {
      const store = getWorkspaceStore();
      const dir = store.workspaceDir;
      const file = (Components.classes as any)[
        "@mozilla.org/file/local;1"
      ].createInstance((Components.interfaces as any).nsIFile);
      file.initWithPath(dir);
      file.reveal();
    },
  );
  actions.appendChild(openFolderBtn);

  const collapseBtn = createIconButton(
    doc,
    "\u25B6",
    "Collapse sidebar",
    () => {
      const sd = sidebar as any;
      const scrollContainer = sd._scrollContainer as HTMLElement;
      const footer = sidebar.querySelector(
        ".workspace-footer",
      ) as HTMLElement | null;
      const isCollapsed = sidebar.style.width === "20px";
      if (isCollapsed) {
        sidebar.style.width = (sd._originalWidth as string) || "260px";
        sidebar.style.minWidth = "120px";
        sd._isCollapsed = false;
        sidebar.style.borderLeft = "1px solid var(--border-primary)";
        collapseBtn.textContent = "\u25B6";
        collapseBtn.title = "Collapse sidebar";
        setPref("workspaceSidebarCollapsed", false);
        // Show content
        if (scrollContainer) scrollContainer.style.display = "";
        if (footer) footer.style.display = "";
        (header as HTMLElement).style.display = "";
        // Show resize handle
        const wsHandle = sidebar.previousElementSibling as HTMLElement | null;
        if (wsHandle && wsHandle.classList.contains("seerai-resize-handle")) {
          wsHandle.style.display = "";
        }
        // Remove narrow strip
        const strip = sidebar.querySelector(
          ".narrow-toggle",
        ) as HTMLElement | null;
        if (strip) strip.remove();
      } else {
        sd._originalWidth = sidebar.style.width;
        sidebar.style.width = "20px";
        sidebar.style.minWidth = "20px";
        sd._isCollapsed = true;
        sidebar.style.borderLeft = "1px solid var(--border-primary)";
        collapseBtn.textContent = "\u25C0";
        collapseBtn.title = "Show sidebar";
        setPref("workspaceSidebarCollapsed", true);
        // Hide content
        if (scrollContainer) scrollContainer.style.display = "none";
        if (footer) footer.style.display = "none";
        (header as HTMLElement).style.display = "none";
        // Hide resize handle
        const wsHandle = sidebar.previousElementSibling as HTMLElement | null;
        if (wsHandle && wsHandle.classList.contains("seerai-resize-handle")) {
          wsHandle.style.display = "none";
        }
        // Show narrow toggle strip
        const narrowStrip = doc.createElement("div");
        narrowStrip.className = "narrow-toggle";
        narrowStrip.style.cssText =
          "display: flex; flex-direction: column; align-items: center; padding: 8px 0; gap: 8px;";
        const expandBtn = collapseBtn.cloneNode(true) as HTMLElement;
        expandBtn.textContent = "\u25C0";
        expandBtn.title = "Show sidebar";
        expandBtn.addEventListener("click", () => {
          collapseBtn.click();
        });
        expandBtn.addEventListener("mouseenter", () => {
          expandBtn.style.backgroundColor = "var(--background-primary)";
          expandBtn.style.color = "var(--highlight-primary)";
        });
        expandBtn.addEventListener("mouseleave", () => {
          expandBtn.style.backgroundColor = "transparent";
          expandBtn.style.color = "var(--text-secondary)";
        });
        narrowStrip.appendChild(expandBtn);
        const label = doc.createElement("span");
        label.textContent = "A";
        label.style.cssText =
          "writing-mode: vertical-lr; font-size: 9px; font-weight: 700; color: var(--text-tertiary); letter-spacing: 2px;";
        narrowStrip.appendChild(label);
        sidebar.appendChild(narrowStrip);
      }
    },
  );
  actions.appendChild(collapseBtn);

  header.appendChild(actions);
  sidebar.appendChild(header);

  // Scrollable content
  const scrollContainer = doc.createElement("div");
  scrollContainer.style.cssText = `
    flex: 1 1 0;
    overflow-y: auto;
    overflow-x: hidden;
    min-height: 0;
  `;
  sidebar.appendChild(scrollContainer);

  // Sections will be rendered into scrollContainer by refreshWorkspaceSidebar

  // Footer
  const footer = doc.createElement("div");
  footer.className = "workspace-footer";
  footer.style.cssText = `
    padding: 6px 12px;
    border-top: 1px solid var(--border-primary);
    font-size: 10px;
    color: var(--text-tertiary);
    flex-shrink: 0;
    display: flex;
    align-items: center;
    gap: 8px;
  `;

  const footerSummary = doc.createElement("span");
  footerSummary.textContent = "";
  footer.appendChild(footerSummary);
  sidebar.appendChild(footer);

  // Store references for refresh
  (sidebar as any)._scrollContainer = scrollContainer;
  (sidebar as any)._commitActionBtn = commitActionBtn;
  (sidebar as any)._footerSummary = footerSummary;
  (sidebar as any)._showCommitHistoryPanel = false;

  // Apply persisted collapsed state (default: collapsed for new chats)
  if (getPref("workspaceSidebarCollapsed")) {
    (sidebar as any)._isCollapsed = true;
    (sidebar as any)._originalWidth = sidebar.style.width;
    sidebar.style.width = "20px";
    sidebar.style.minWidth = "20px";
    collapseBtn.textContent = "\u25C0";
    collapseBtn.title = "Show sidebar";
    scrollContainer.style.display = "none";
    footer.style.display = "none";
    header.style.display = "none";
    const narrowStrip = doc.createElement("div");
    narrowStrip.className = "narrow-toggle";
    narrowStrip.style.cssText =
      "display: flex; flex-direction: column; align-items: center; padding: 8px 0; gap: 8px;";
    const expandBtn = collapseBtn.cloneNode(true) as HTMLElement;
    expandBtn.textContent = "\u25C0";
    expandBtn.title = "Show sidebar";
    expandBtn.addEventListener("click", () => {
      collapseBtn.click();
    });
    expandBtn.addEventListener("mouseenter", () => {
      expandBtn.style.backgroundColor = "var(--background-primary)";
      expandBtn.style.color = "var(--highlight-primary)";
    });
    expandBtn.addEventListener("mouseleave", () => {
      expandBtn.style.backgroundColor = "transparent";
      expandBtn.style.color = "var(--text-secondary)";
    });
    narrowStrip.appendChild(expandBtn);
    const label = doc.createElement("span");
    label.textContent = "A";
    label.style.cssText =
      "writing-mode: vertical-lr; font-size: 9px; font-weight: 700; color: var(--text-tertiary); letter-spacing: 2px;";
    narrowStrip.appendChild(label);
    sidebar.appendChild(narrowStrip);
  }

  return sidebar;
}

let _refreshInProgress = false;
let _refreshDirty = false;

const _sectionCollapsed = new Map<string, boolean>();

export async function refreshWorkspaceSidebar(
  sidebar: HTMLElement,
  callbacks: WorkspaceSidebarCallbacks,
): Promise<void> {
  if (_refreshInProgress) {
    _refreshDirty = true;
    return;
  }

  _refreshInProgress = true;
  try {
    do {
      _refreshDirty = false;
      await _doRefreshWorkspaceSidebar(sidebar, callbacks);
    } while (_refreshDirty);
  } finally {
    _refreshInProgress = false;
  }
}

async function _doRefreshWorkspaceSidebar(
  sidebar: HTMLElement,
  callbacks: WorkspaceSidebarCallbacks,
): Promise<void> {
  const sd = sidebar as any;
  const scrollContainer = sd._scrollContainer as HTMLElement;
  const commitActionBtn = sd._commitActionBtn as HTMLElement;
  const footerSummary = sd._footerSummary as HTMLElement;

  if (!scrollContainer) return;

  let tree: WorkspaceFileEntry[];
  let gitStatus: GitStatusResult;
  try {
    const doc = sidebar.ownerDocument!;
    const store = getWorkspaceStore();
    gitStatus = await store.getGitStatus();
    try {
      tree = await store.listFileTree();
    } catch (e) {
      Zotero.debug(
        `[seerai] listFileTree failed, falling back to listFiles: ${e}`,
      );
      tree = (await store.listFiles()).filter((f) => !f.path.includes("\0"));
    }

    const titleSpan = sidebar.querySelector(
      ".workspace-title-label",
    ) as HTMLElement | null;
    if (titleSpan) {
      const label = store.isSharedWorkspace
        ? store.workspaceLabel.toUpperCase()
        : "ARTIFACTS";
      titleSpan.textContent = label;
      titleSpan.title = store.isSharedWorkspace
        ? `Shared workspace: ${store.workspaceLabel}`
        : "Personal workspace";
    }

    while (scrollContainer.firstChild) {
      scrollContainer.removeChild(scrollContainer.firstChild);
    }

    const stagedMap = new Map<string, string>(
      gitStatus.staged.map((s) => [s.path, s.entry.gitStatus || "staged"]),
    );
    const changesMap = new Map<string, string>(
      gitStatus.changes.map((c) => [c.path, c.entry.gitStatus || "modified"]),
    );

    const enrichGitStatus = (entries: WorkspaceFileEntry[]) => {
      for (const entry of entries) {
        if (!entry.isDirectory) {
          const gs =
            stagedMap.get(entry.path) ||
            changesMap.get(entry.path) ||
            entry.gitStatus;
          entry.gitStatus = gs as FileGitStatus;
        }
        if (entry.children) enrichGitStatus(entry.children);
      }
    };
    enrichGitStatus(tree);

    const countFiles = (entries: WorkspaceFileEntry[]): number =>
      entries.reduce(
        (sum, e) => sum + (e.isDirectory ? countFiles(e.children || []) : 1),
        0,
      );
    const totalFiles = countFiles(tree);

    // Auto-expand sidebar when files exist
    if (
      sd._isCollapsed &&
      (totalFiles > 0 ||
        gitStatus.staged.length > 0 ||
        gitStatus.changes.length > 0)
    ) {
      const collapseBtn = sidebar.querySelector(
        'button[title*="Collapse sidebar"], button[title*="Show sidebar"]',
      ) as HTMLButtonElement | null;
      if (collapseBtn) collapseBtn.click();
    }

    // Show empty state when no files exist
    if (totalFiles === 0) {
      sidebar.style.display = "flex";
      const wsHandle = sidebar.previousElementSibling as HTMLElement | null;
      if (wsHandle && wsHandle.classList.contains("seerai-resize-handle")) {
        wsHandle.style.display = "";
      }
      const emptyState = doc.createElement("div");
      emptyState.style.cssText =
        "padding: 24px 12px; text-align: center; color: var(--text-tertiary); font-style: italic; font-size: 11px; line-height: 1.6;";
      const line1 = doc.createElement("div");
      line1.textContent = "No files yet.";
      const line2 = doc.createElement("div");
      line2.textContent = "Click + above to create one.";
      emptyState.appendChild(line1);
      emptyState.appendChild(line2);
      scrollContainer.appendChild(emptyState);
      if (footerSummary) footerSummary.textContent = "Working tree clean";
      return;
    }
    sidebar.style.display = "flex";
    const wsHandle = sidebar.previousElementSibling as HTMLElement | null;
    if (wsHandle && wsHandle.classList.contains("seerai-resize-handle")) {
      wsHandle.style.display = "";
    }

    // Commit history panel
    if (sd._showCommitHistoryPanel) {
      await renderCommitHistoryPanel(doc, scrollContainer, sidebar, callbacks);
      return;
    }

    // Enable/disable commit button based on staged count
    const stagedCount = gitStatus.staged.length;
    if (stagedCount > 0) {
      commitActionBtn.style.opacity = "1";
      commitActionBtn.title = `Commit ${stagedCount} staged change(s)`;
    } else {
      commitActionBtn.style.opacity = "0.4";
      commitActionBtn.title = "No staged changes to commit";
    }

    // Files section (always visible, first)
    const filesSection = createCollapsibleSection(
      doc,
      "Files",
      totalFiles,
      true,
    );

    const filesList = filesSection.querySelector(
      ".section-items",
    ) as HTMLElement;

    const renderTree = (
      entries: WorkspaceFileEntry[],
      container: HTMLElement,
      depth: number,
    ) => {
      for (const entry of entries) {
        if (entry.isDirectory) {
          const dirRow = createFolderRow(doc, entry, depth);
          const dirChildren = doc.createElement("div");
          dirChildren.className = "folder-children";
          dirChildren.style.cssText = "display: none;";
          if (entry.children) {
            renderTree(entry.children, dirChildren, depth + 1);
          }
          const arrowEl = dirRow.querySelector(".folder-arrow") as HTMLElement;
          dirRow.addEventListener("click", (e) => {
            e.stopPropagation();
            const isCollapsed = dirChildren.style.display === "none";
            dirChildren.style.display = isCollapsed ? "" : "none";
            arrowEl.textContent = isCollapsed ? "\u25BE" : "\u25B8";
          });

          dirRow.addEventListener("contextmenu", (e) => {
            e.preventDefault();
            e.stopPropagation();
            showFolderInlineMenu(doc, dirRow, entry, sidebar, callbacks);
          });

          const menuBtn = createSmallActionBtn(
            doc,
            "\u22EE",
            "More actions",
            () => {
              showFolderDropdown(
                doc,
                dirRow,
                menuBtn,
                entry,
                sidebar,
                callbacks,
              );
            },
          );
          menuBtn.style.opacity = "0";
          menuBtn.style.transition = "opacity 0.1s";
          dirRow.addEventListener("mouseenter", () => {
            menuBtn.style.opacity = "1";
          });
          dirRow.addEventListener("mouseleave", () => {
            menuBtn.style.opacity = "0";
          });
          dirRow.appendChild(menuBtn);

          container.appendChild(dirRow);
          container.appendChild(dirChildren);
        } else {
          const gs = entry.gitStatus || "";
          const statusLabel =
            gitStatusLabels[gs] ||
            statusIcons[entry.status as FileStatus] ||
            "";
          const statusTooltip = gitStatusTitles[gs] || "";
          const row = createFileRowWithIndent(
            doc,
            entry,
            statusLabel,
            statusTooltip,
            depth,
          );
          row.addEventListener("click", () => {
            callbacks.onFileClick(entry);
          });

          row.addEventListener("contextmenu", (e) => {
            e.preventDefault();
            e.stopPropagation();
            showEntryContextMenu(doc, row, entry, callbacks, sidebar);
          });

          const menuBtn = createSmallActionBtn(
            doc,
            "\u22EE",
            "More actions",
            () => {
              showEntryDropdown(doc, row, menuBtn, entry, sidebar, callbacks);
            },
          );
          menuBtn.style.opacity = "0";
          menuBtn.style.transition = "opacity 0.1s";
          row.addEventListener("mouseenter", () => {
            menuBtn.style.opacity = "1";
          });
          row.addEventListener("mouseleave", () => {
            menuBtn.style.opacity = "0";
          });
          row.appendChild(menuBtn);

          container.appendChild(row);
        }
      }
    };

    renderTree(tree, filesList, 0);
    scrollContainer.appendChild(filesSection);

    // Staged Changes section
    if (gitStatus.staged.length > 0) {
      const stagedSection = createCollapsibleSection(
        doc,
        "Staged Changes",
        gitStatus.staged.length,
        true,
        [
          {
            text: "\u2212",
            title: "Unstage All",
            action: async () => {
              await store.unstageAll();
              await refreshWorkspaceSidebar(sidebar, callbacks);
            },
          },
        ],
      );
      const stagedList = stagedSection.querySelector(
        ".section-items",
      ) as HTMLElement;

      for (const { path, entry } of gitStatus.staged) {
        const row = createGitFileRow(doc, entry, "\u25CF", "Staged for commit");
        row.addEventListener("click", () => {
          const stagedText = gitStatus.stagedContent.get(path);
          const headText = gitStatus.headContent.get(path);
          callbacks.onFileClick(
            entry,
            "staged",
            headText ?? "",
            stagedText ?? entry.content ?? "",
          );
        });
        const unstageBtn = createSmallActionBtn(
          doc,
          "\u2212",
          "Unstage",
          async () => {
            await store.unstageFile(path);
            await refreshWorkspaceSidebar(sidebar, callbacks);
          },
        );
        row.appendChild(unstageBtn);
        stagedList.appendChild(row);
      }
      scrollContainer.appendChild(stagedSection);
    }

    // Changes section
    if (gitStatus.changes.length > 0) {
      const changesSection = createCollapsibleSection(
        doc,
        "Changes",
        gitStatus.changes.length,
        true,
        [
          {
            text: "+",
            title: "Stage All",
            action: async () => {
              await store.stageAll();
              await refreshWorkspaceSidebar(sidebar, callbacks);
            },
          },
        ],
      );
      const changesList = changesSection.querySelector(
        ".section-items",
      ) as HTMLElement;

      for (const { path, entry } of gitStatus.changes) {
        const gs = entry.gitStatus || entry.status || "";
        const label =
          gitStatusLabels[gs] || gitStatusLabels[entry.status] || "";
        const tooltip =
          gitStatusTitles[gs] || gitStatusTitles[entry.status] || "";
        const row = createGitFileRow(doc, entry, label, tooltip);
        row.addEventListener("click", () => {
          const stagedText = gitStatus.stagedContent.get(path);
          const headText = gitStatus.headContent.get(path);
          const currentContent = entry.content || "";
          // For unstaged changes, diff against staged content (if staged) or HEAD content
          const baseContent = stagedText ?? headText ?? "";
          callbacks.onFileClick(
            entry,
            "changes",
            baseContent || undefined,
            currentContent,
          );
        });

        const discardBtn = createSmallActionBtn(
          doc,
          "\u21A9",
          "Discard",
          async () => {
            if (
              !doc.defaultView?.confirm(
                `Discard changes to "${path}"? This cannot be undone.`,
              )
            )
              return;
            await store.revertFile(path);
            await refreshWorkspaceSidebar(sidebar, callbacks);
          },
        );
        row.appendChild(discardBtn);

        const stageBtn = createSmallActionBtn(doc, "+", "Stage", async () => {
          await store.stageFile(path);
          await refreshWorkspaceSidebar(sidebar, callbacks);
        });
        row.appendChild(stageBtn);

        // Context menu for revert
        row.addEventListener("contextmenu", (e) => {
          e.preventDefault();
          e.stopPropagation();

          const existing = doc.querySelector("[data-workspace-inline-menu]");
          if (existing) existing.remove();

          const menu = doc.createElement("div");
          menu.setAttribute("data-workspace-inline-menu", "true");
          menu.style.cssText = `
            display: flex;
            gap: 4px;
            padding: 4px 8px 4px 28px;
            border-bottom: 1px solid var(--border-primary);
            background: var(--background-secondary);
          `;

          const discardBtn = doc.createElementNS(
            HTML_NS,
            "button",
          ) as HTMLButtonElement;
          discardBtn.textContent = "\u21A9 Discard Changes";
          discardBtn.style.cssText = `
            padding: 2px 10px;
            border: 1px solid var(--border-primary);
            border-radius: 4px;
            background: var(--background-primary);
            color: var(--text-primary);
            cursor: pointer;
            font-size: 11px;
            line-height: 18px;
          `;
          discardBtn.addEventListener("click", async () => {
            menu.remove();
            if (
              !doc.defaultView?.confirm(
                `Discard all changes to "${path}"? This cannot be undone.`,
              )
            )
              return;
            await store.revertFile(path);
            await refreshWorkspaceSidebar(sidebar, callbacks);
          });
          menu.appendChild(discardBtn);

          const deleteBtn = doc.createElementNS(
            HTML_NS,
            "button",
          ) as HTMLButtonElement;
          deleteBtn.textContent = "Delete";
          deleteBtn.style.cssText = `
            padding: 2px 10px;
            border: 1px solid var(--border-primary);
            border-radius: 4px;
            background: var(--background-primary);
            color: #ef5350;
            cursor: pointer;
            font-size: 11px;
            line-height: 18px;
          `;
          deleteBtn.addEventListener("click", async () => {
            menu.remove();
            if (
              !doc.defaultView?.confirm(
                `Delete "${path}"? This cannot be undone.`,
              )
            )
              return;
            await store.deleteFile(path);
            await refreshWorkspaceSidebar(sidebar, callbacks);
          });
          menu.appendChild(deleteBtn);

          menu.addEventListener("contextmenu", (e) => e.preventDefault());

          if (row.parentElement) {
            row.parentElement.insertBefore(menu, row.nextSibling);
          }

          const close = (ev: Event) => {
            if (!menu.contains(ev.target as Node)) {
              menu.remove();
              doc.removeEventListener("click", close);
            }
          };
          setTimeout(() => doc.addEventListener("click", close), 0);
        });

        changesList.appendChild(row);
      }
      scrollContainer.appendChild(changesSection);
    }

    // Footer
    if (footerSummary) {
      const parts: string[] = [];
      if (stagedCount > 0) parts.push(`${stagedCount} staged`);
      if (gitStatus.changes.length > 0)
        parts.push(`${gitStatus.changes.length} changed`);
      if (parts.length === 0) parts.push("Working tree clean");
      footerSummary.textContent = parts.join(", ");
    }
  } catch (e) {
    Zotero.debug(
      `[seerai] Error refreshing workspace sidebar: ${e}\n${e instanceof Error ? e.stack : ""}`,
    );
  }
}

// ============================================================================
// Commit History Panel
// ============================================================================

async function renderCommitHistoryPanel(
  doc: Document,
  container: HTMLElement,
  sidebar: HTMLElement,
  callbacks: WorkspaceSidebarCallbacks,
): Promise<void> {
  const store = getWorkspaceStore();
  const commits = await store.getCommitHistory();

  const backBtn = doc.createElementNS(HTML_NS, "button") as HTMLButtonElement;
  backBtn.textContent = "\u2190 Back to Files";
  backBtn.style.cssText = `
    display: block;
    width: 100%;
    padding: 8px 12px;
    border: none;
    border-bottom: 1px solid var(--border-primary);
    background: var(--background-secondary);
    color: var(--highlight-primary);
    cursor: pointer;
    font-size: 12px;
    text-align: left;
  `;
  backBtn.addEventListener("click", () => {
    (sidebar as any)._showCommitHistoryPanel = false;
    refreshWorkspaceSidebar(sidebar, callbacks);
  });
  container.appendChild(backBtn);

  if (commits.length === 0) {
    const empty = doc.createElement("div");
    empty.textContent = "No commits yet";
    empty.style.cssText =
      "padding: 24px 12px; text-align: center; color: var(--text-tertiary); font-style: italic; font-size: 11px;";
    container.appendChild(empty);
    return;
  }

  for (const commit of commits) {
    const card = doc.createElement("div");
    card.style.cssText = `
      padding: 8px 12px;
      border-bottom: 1px solid var(--border-primary);
      cursor: pointer;
      transition: background 0.1s;
    `;
    card.addEventListener("mouseenter", () => {
      card.style.background = "var(--background-hover, rgba(0,0,0,0.05))";
    });
    card.addEventListener("mouseleave", () => {
      card.style.background = "transparent";
    });

    const msg = doc.createElement("div");
    msg.textContent = commit.message;
    msg.style.cssText =
      "font-size: 12px; font-weight: 500; color: var(--text-primary);";

    const meta = doc.createElement("div");
    meta.style.cssText =
      "font-size: 10px; color: var(--text-tertiary); margin-top: 2px; display: flex; gap: 8px;";
    const time = doc.createElement("span");
    time.textContent = formatTimeAgo(commit.timestamp);
    const id = doc.createElement("span");
    id.textContent = commit.id.slice(0, 7);
    id.style.cssText = "font-family: monospace;";
    meta.appendChild(time);
    meta.appendChild(id);

    card.appendChild(msg);
    card.appendChild(meta);

    // Expand on click to show files
    card.addEventListener("click", async () => {
      const full = await store.getCommit(commit.id);
      if (!full) return;

      const existing = card.nextElementSibling as HTMLElement | null;
      if (existing && existing.classList.contains("commit-detail")) {
        existing.remove();
        return;
      }

      const detail = doc.createElement("div");
      detail.className = "commit-detail";
      detail.style.cssText = `
        padding: 4px 12px 8px 20px;
        border-bottom: 1px solid var(--border-primary);
        font-size: 11px;
      `;

      const fileList = Object.keys(full.files).sort();
      for (const f of fileList) {
        const line = doc.createElement("div");
        line.style.cssText =
          "padding: 2px 0; color: var(--text-secondary); display: flex; gap: 4px; cursor: pointer;";
        line.textContent = f;
        line.addEventListener("click", (e) => {
          e.stopPropagation();
        });
        detail.appendChild(line);
      }

      if (fileList.length === 0) {
        detail.textContent = "(empty commit)";
        detail.style.color = "var(--text-tertiary)";
      }

      card.after(detail);
    });

    container.appendChild(card);

    // Revert to this commit button
    const revertBtn = doc.createElementNS(
      HTML_NS,
      "button",
    ) as HTMLButtonElement;
    revertBtn.textContent = "Revert to this";
    revertBtn.title = `Restore all files to commit ${commit.id.slice(0, 7)}`;
    revertBtn.style.cssText = `
      padding: 2px 8px;
      font-size: 10px;
      background: var(--background-primary);
      border: 1px solid var(--border-primary);
      border-radius: 3px;
      color: var(--text-secondary);
      cursor: pointer;
      margin-left: 24px;
      margin-bottom: 4px;
      display: none;
    `;
    card.addEventListener("mouseenter", () => {
      revertBtn.style.display = "inline-block";
    });
    card.addEventListener("mouseleave", () => {
      revertBtn.style.display = "none";
    });
    revertBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (
        !doc.defaultView?.confirm(
          `Revert workspace to commit "${commit.message}"? Current changes will be lost.`,
        )
      )
        return;
      await store.revertToCommit(commit.id);
      (sidebar as any)._showCommitHistoryPanel = false;
      await refreshWorkspaceSidebar(sidebar, callbacks);
    });
    card.appendChild(revertBtn);
  }
}

// ============================================================================
// UI Helpers
// ============================================================================

function createCollapsibleSection(
  doc: Document,
  title: string,
  count: number,
  expanded: boolean = true,
  actions?: Array<{ text: string; title: string; action: () => void }>,
): HTMLElement {
  const remembered = _sectionCollapsed.get(title);
  const isExpanded = remembered !== undefined ? !remembered : expanded;

  const section = doc.createElement("div");

  const header = doc.createElement("div");
  header.style.cssText = `
    display: flex;
    align-items: center;
    padding: 6px 8px;
    cursor: pointer;
    font-size: 11px;
    font-weight: 600;
    color: var(--text-secondary);
    text-transform: uppercase;
    letter-spacing: 0.3px;
    gap: 6px;
    user-select: none;
  `;

  const arrow = doc.createElement("span");
  arrow.textContent = isExpanded ? "\u25BE" : "\u25B8";
  arrow.style.cssText = "font-size: 10px; width: 12px;";

  const label = doc.createElement("span");
  label.textContent = `${title} (${count})`;
  label.style.cssText =
    "flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;";

  header.appendChild(arrow);
  header.appendChild(label);

  if (actions) {
    for (const a of actions) {
      const btn = createTinyActionBtn(doc, a.text, a.title, a.action);
      header.appendChild(btn);
    }
  }

  const items = doc.createElement("div");
  items.className = "section-items";
  items.style.cssText = isExpanded ? "" : "display: none;";

  header.addEventListener("click", () => {
    const isCollapsed = items.style.display === "none";
    items.style.display = isCollapsed ? "" : "none";
    arrow.textContent = isCollapsed ? "\u25BE" : "\u25B8";
    _sectionCollapsed.set(title, !isCollapsed);
  });

  section.appendChild(header);
  section.appendChild(items);
  return section;
}

function createFolderRow(
  doc: Document,
  entry: WorkspaceFileEntry,
  depth: number,
): HTMLElement {
  const row = doc.createElement("div");
  row.style.cssText = `
    display: flex;
    align-items: center;
    padding: 3px 8px 3px ${8 + depth * 16}px;
    cursor: pointer;
    font-size: 12px;
    color: var(--text-primary);
    transition: background-color 0.1s;
    gap: 4px;
    min-height: 24px;
    white-space: nowrap;
    user-select: none;
  `;
  row.addEventListener("mouseenter", () => {
    row.style.backgroundColor = "var(--background-hover, rgba(0,0,0,0.05))";
  });
  row.addEventListener("mouseleave", () => {
    row.style.backgroundColor = "transparent";
  });

  const arrow = doc.createElement("span");
  arrow.className = "folder-arrow";
  arrow.textContent = "\u25B8";
  arrow.style.cssText = "font-size: 10px; width: 12px; flex-shrink: 0;";
  row.appendChild(arrow);

  const icon = doc.createElement("span");
  icon.textContent = "\uD83D\uDCC1";
  icon.style.cssText = "font-size: 12px; flex-shrink: 0;";
  row.appendChild(icon);

  const nameEl = doc.createElement("span");
  nameEl.textContent = entry.name;
  nameEl.style.cssText =
    "flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; min-width: 0;";
  row.appendChild(nameEl);

  return row;
}

function createFileRowWithIndent(
  doc: Document,
  entry: WorkspaceFileEntry,
  statusLabel: string,
  statusTooltip: string | undefined,
  depth: number,
): HTMLElement {
  const row = doc.createElement("div");
  row.style.cssText = `
    display: flex;
    align-items: center;
    padding: 3px 8px 3px ${8 + depth * 16}px;
    cursor: pointer;
    font-size: 12px;
    color: var(--text-primary);
    transition: background-color 0.1s;
    gap: 6px;
    min-height: 24px;
    white-space: nowrap;
  `;
  row.addEventListener("mouseenter", () => {
    row.style.backgroundColor = "var(--background-hover, rgba(0,0,0,0.05))";
  });
  row.addEventListener("mouseleave", () => {
    row.style.backgroundColor = "transparent";
  });

  if (statusLabel) {
    const badge = doc.createElement("span");
    badge.textContent = statusLabel;
    if (statusTooltip) badge.title = statusTooltip;
    badge.style.cssText = `
      font-size: 10px;
      font-weight: 700;
      width: 14px;
      text-align: center;
      flex-shrink: 0;
      color: ${
        statusLabel === "\u25CF"
          ? "#4caf50"
          : statusLabel === "M"
            ? "#e5b73b"
            : statusLabel === "+"
              ? "#4caf50"
              : statusLabel === "\u00D7"
                ? "#ef5350"
                : statusLabel === "?"
                  ? "#40c4ff"
                  : statusLabel === "\u2713"
                    ? "var(--text-tertiary)"
                    : "var(--text-tertiary)"
      };
    `;
    row.appendChild(badge);
  }

  const nameEl = doc.createElement("span");
  nameEl.textContent = entry.name;
  nameEl.style.cssText =
    "flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; min-width: 0;";
  row.appendChild(nameEl);

  return row;
}

function createGitFileRow(
  doc: Document,
  entry: WorkspaceFileEntry,
  statusLabel: string,
  statusTooltip?: string,
): HTMLElement {
  const row = doc.createElement("div");
  row.style.cssText = `
    display: flex;
    align-items: center;
    padding: 3px 8px 3px ${entry.isDirectory ? "8px" : "20px"};
    cursor: pointer;
    font-size: 12px;
    color: var(--text-primary);
    transition: background-color 0.1s;
    gap: 6px;
    min-height: 24px;
    white-space: nowrap;
  `;

  row.addEventListener("mouseenter", () => {
    row.style.backgroundColor = "var(--background-hover, rgba(0,0,0,0.05))";
  });
  row.addEventListener("mouseleave", () => {
    row.style.backgroundColor = "transparent";
  });

  // Status badge
  if (statusLabel) {
    const badge = doc.createElement("span");
    badge.textContent = statusLabel;
    if (statusTooltip) badge.title = statusTooltip;
    badge.style.cssText = `
      font-size: 10px;
      font-weight: 700;
      width: 14px;
      text-align: center;
      flex-shrink: 0;
      color: ${
        statusLabel === "\u25CF"
          ? "#4caf50"
          : statusLabel === "M"
            ? "#e5b73b"
            : statusLabel === "+"
              ? "#4caf50"
              : statusLabel === "\u00D7"
                ? "#ef5350"
                : statusLabel === "?"
                  ? "#40c4ff"
                  : statusLabel === "\u2713"
                    ? "var(--text-tertiary)"
                    : "var(--text-tertiary)"
      };
    `;
    row.appendChild(badge);
  }

  // Name
  const nameEl = doc.createElement("span");
  nameEl.textContent = entry.name;
  nameEl.style.cssText = `
    flex: 1 1 auto;
    overflow: hidden;
    text-overflow: ellipsis;
    min-width: 0;
  `;
  row.appendChild(nameEl);

  return row;
}

function createSmallActionBtn(
  doc: Document,
  text: string,
  title: string,
  action: () => void,
): HTMLElement {
  const btn = doc.createElementNS(HTML_NS, "button") as HTMLButtonElement;
  btn.textContent = text;
  btn.title = title;
  btn.style.cssText = `
    width: 20px;
    height: 20px;
    display: flex;
    align-items: center;
    justify-content: center;
    border: none;
    border-radius: 3px;
    background: transparent;
    color: var(--text-secondary);
    cursor: pointer;
    font-size: 12px;
    padding: 0;
    flex-shrink: 0;
    transition: all 0.1s;
  `;
  btn.addEventListener("mouseenter", () => {
    btn.style.backgroundColor = "var(--background-primary)";
    btn.style.color = "var(--highlight-primary)";
  });
  btn.addEventListener("mouseleave", () => {
    btn.style.backgroundColor = "transparent";
    btn.style.color = "var(--text-secondary)";
  });
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    action();
  });
  return btn;
}

function createTinyActionBtn(
  doc: Document,
  text: string,
  title: string,
  action: () => void,
): HTMLElement {
  const btn = doc.createElementNS(HTML_NS, "button") as HTMLButtonElement;
  btn.textContent = text;
  btn.title = title;
  btn.style.cssText = `
    width: 16px;
    height: 16px;
    display: flex;
    align-items: center;
    justify-content: center;
    border: none;
    border-radius: 2px;
    background: transparent;
    color: var(--text-secondary);
    cursor: pointer;
    font-size: 10px;
    padding: 0;
    flex-shrink: 0;
  `;
  btn.addEventListener("mouseenter", () => {
    btn.style.backgroundColor = "var(--background-primary)";
  });
  btn.addEventListener("mouseleave", () => {
    btn.style.backgroundColor = "transparent";
  });
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    action();
  });
  return btn;
}

export function createIconButton(
  doc: Document,
  icon: string,
  title: string,
  onClick: () => void,
): HTMLElement {
  const btn = doc.createElementNS(HTML_NS, "button") as HTMLButtonElement;
  btn.textContent = icon;
  btn.title = title;
  btn.style.cssText = `
    width: 22px;
    height: 22px;
    display: flex;
    align-items: center;
    justify-content: center;
    border: none;
    border-radius: 4px;
    background: transparent;
    color: var(--text-secondary);
    cursor: pointer;
    font-size: 14px;
    padding: 0;
    transition: all 0.15s ease;
  `;
  btn.addEventListener("mouseenter", () => {
    btn.style.backgroundColor = "var(--background-primary)";
    btn.style.color = "var(--text-primary)";
  });
  btn.addEventListener("mouseleave", () => {
    btn.style.backgroundColor = "transparent";
    btn.style.color = "var(--text-secondary)";
  });
  btn.addEventListener("click", onClick);
  return btn;
}

function showInlineActionRow(
  doc: Document,
  row: HTMLElement,
  items: { text: string; action: () => void; danger?: boolean }[],
): void {
  const existing = doc.querySelector("[data-workspace-inline-menu]");
  if (existing) existing.remove();

  const menu = doc.createElement("div");
  menu.setAttribute("data-workspace-inline-menu", "true");
  menu.style.cssText = `
    display: flex;
    gap: 4px;
    padding: 4px 8px 4px 28px;
    border-bottom: 1px solid var(--border-primary);
    background: var(--background-secondary);
  `;

  for (const item of items) {
    const btn = doc.createElementNS(HTML_NS, "button") as HTMLButtonElement;
    btn.textContent = item.text;
    btn.style.cssText = `
      padding: 2px 10px;
      border: 1px solid var(--border-primary);
      border-radius: 4px;
      background: var(--background-primary);
      color: ${item.danger ? "#ef5350" : "var(--text-primary)"};
      cursor: pointer;
      font-size: 11px;
      line-height: 18px;
    `;
    btn.addEventListener("click", () => {
      menu.remove();
      item.action();
    });
    menu.appendChild(btn);
  }

  menu.addEventListener("contextmenu", (e) => e.preventDefault());

  if (row.parentElement) {
    row.parentElement.insertBefore(menu, row.nextSibling);
  }

  const closeListener = (e: Event) => {
    if (!menu.contains(e.target as Node)) {
      menu.remove();
      doc.removeEventListener("click", closeListener);
    }
  };
  setTimeout(() => doc.addEventListener("click", closeListener), 0);
}

function showEntryContextMenu(
  doc: Document,
  row: HTMLElement,
  entry: WorkspaceFileEntry,
  callbacks: WorkspaceSidebarCallbacks,
  _sidebar?: HTMLElement,
): void {
  showInlineActionRow(doc, row, [
    { text: "Rename...", action: () => callbacks.onFileRename(entry) },
    {
      text: "Delete",
      action: () => callbacks.onFileDelete(entry),
      danger: true,
    },
  ]);
}

function showEntryDropdown(
  doc: Document,
  row: HTMLElement,
  _anchor: HTMLElement,
  entry: WorkspaceFileEntry,
  sidebar: HTMLElement,
  callbacks: WorkspaceSidebarCallbacks,
): void {
  const existing = doc.getElementById("workspace-file-dropdown");
  if (existing) {
    existing.remove();
    return;
  }

  const menu = doc.createElement("div");
  menu.id = "workspace-file-dropdown";
  menu.style.cssText = `
    display: flex;
    gap: 4px;
    padding: 4px 8px 4px 28px;
    border-bottom: 1px solid var(--border-primary);
    background: var(--background-secondary);
  `;

  const renameBtn = doc.createElementNS(HTML_NS, "button") as HTMLButtonElement;
  renameBtn.textContent = "Rename...";
  renameBtn.style.cssText = `
    padding: 2px 10px;
    border: 1px solid var(--border-primary);
    border-radius: 4px;
    background: var(--background-primary);
    color: var(--text-primary);
    cursor: pointer;
    font-size: 11px;
    line-height: 18px;
  `;
  renameBtn.addEventListener("click", () => {
    menu.remove();
    callbacks.onFileRename(entry);
  });
  menu.appendChild(renameBtn);

  const deleteBtn = doc.createElementNS(HTML_NS, "button") as HTMLButtonElement;
  deleteBtn.textContent = "Delete";
  deleteBtn.style.cssText = `
    padding: 2px 10px;
    border: 1px solid var(--border-primary);
    border-radius: 4px;
    background: var(--background-primary);
    color: #ef5350;
    cursor: pointer;
    font-size: 11px;
    line-height: 18px;
  `;
  deleteBtn.addEventListener("click", async () => {
    if (
      !doc.defaultView?.confirm(
        `Delete "${entry.path}"? This cannot be undone.`,
      )
    )
      return;
    menu.remove();
    await getWorkspaceStore().deleteFile(entry.path);
    await refreshWorkspaceSidebar(sidebar, callbacks);
  });
  menu.appendChild(deleteBtn);

  menu.addEventListener("contextmenu", (e) => e.preventDefault());

  if (row.parentElement) {
    row.parentElement.insertBefore(menu, row.nextSibling);
  }

  const docListener = (e: Event) => {
    if (!menu.contains(e.target as Node)) {
      menu.remove();
      doc.removeEventListener("click", docListener);
    }
  };
  setTimeout(() => doc.addEventListener("click", docListener), 0);
}

function showFolderInlineMenu(
  doc: Document,
  row: HTMLElement,
  entry: WorkspaceFileEntry,
  sidebar: HTMLElement,
  callbacks: WorkspaceSidebarCallbacks,
): void {
  showInlineActionRow(doc, row, [
    {
      text: "Delete",
      action: async () => {
        if (
          !doc.defaultView?.confirm(
            `Delete folder "${entry.path}" and all its contents? This cannot be undone.`,
          )
        )
          return;
        await getWorkspaceStore().deleteFolder(entry.path);
        await refreshWorkspaceSidebar(sidebar, callbacks);
      },
      danger: true,
    },
  ]);
}

function showFolderDropdown(
  doc: Document,
  row: HTMLElement,
  _anchor: HTMLElement,
  entry: WorkspaceFileEntry,
  sidebar: HTMLElement,
  callbacks: WorkspaceSidebarCallbacks,
): void {
  const existing = doc.getElementById("workspace-folder-dropdown");
  if (existing) {
    existing.remove();
    return;
  }

  const menu = doc.createElement("div");
  menu.id = "workspace-folder-dropdown";
  menu.style.cssText = `
    display: flex;
    gap: 4px;
    padding: 4px 8px 4px 28px;
    border-bottom: 1px solid var(--border-primary);
    background: var(--background-secondary);
  `;

  const deleteBtn = doc.createElementNS(HTML_NS, "button") as HTMLButtonElement;
  deleteBtn.textContent = "Delete Folder";
  deleteBtn.style.cssText = `
    padding: 2px 10px;
    border: 1px solid var(--border-primary);
    border-radius: 4px;
    background: var(--background-primary);
    color: #ef5350;
    cursor: pointer;
    font-size: 11px;
    line-height: 18px;
  `;
  deleteBtn.addEventListener("click", async () => {
    if (
      !doc.defaultView?.confirm(
        `Delete folder "${entry.path}" and all its contents? This cannot be undone.`,
      )
    )
      return;
    menu.remove();
    await getWorkspaceStore().deleteFolder(entry.path);
    await refreshWorkspaceSidebar(sidebar, callbacks);
  });
  menu.appendChild(deleteBtn);

  menu.addEventListener("contextmenu", (e) => e.preventDefault());

  if (row.parentElement) {
    row.parentElement.insertBefore(menu, row.nextSibling);
  }

  const docListener = (e: Event) => {
    if (!menu.contains(e.target as Node)) {
      menu.remove();
      doc.removeEventListener("click", docListener);
    }
  };
  setTimeout(() => doc.addEventListener("click", docListener), 0);
}

function showCommitDropdown(
  doc: Document,
  anchor: HTMLElement,
  sidebar: HTMLElement,
  callbacks: WorkspaceSidebarCallbacks,
): void {
  const existing = doc.getElementById("commit-dropdown");
  if (existing) {
    const textarea = existing.querySelector(
      "textarea",
    ) as HTMLTextAreaElement | null;
    const msg = textarea?.value.trim();
    if (msg) {
      existing.remove();
      getWorkspaceStore()
        .commit(msg)
        .then(() => refreshWorkspaceSidebar(sidebar, callbacks))
        .catch((e: any) => Zotero.debug(`[seerai] Commit failed: ${e}`));
    } else {
      existing.remove();
    }
    return;
  }

  const newFileForm = doc.getElementById("new-file-inline");
  if (newFileForm) newFileForm.remove();

  const form = doc.createElement("div");
  form.id = "commit-dropdown";
  form.style.cssText = `
    padding: 8px;
    border-bottom: 1px solid var(--border-primary);
    background: var(--background-secondary);
    display: flex;
    flex-direction: column;
    gap: 6px;
    flex-shrink: 0;
  `;

  const commitMsg = doc.createElement("textarea");
  commitMsg.placeholder = "Commit message...";
  commitMsg.style.cssText = `
    width: 100%;
    padding: 6px 8px;
    font-size: 12px;
    font-family: system-ui, -apple-system, sans-serif;
    border: 1px solid var(--border-primary);
    border-radius: 4px;
    background: var(--background-primary);
    color: var(--text-primary);
    resize: none;
    box-sizing: border-box;
    min-height: 28px;
    outline: none;
  `;
  commitMsg.rows = 2;

  const commitAction = async () => {
    const msg = commitMsg.value.trim();
    if (!msg) return;
    try {
      form.remove();
      const store = getWorkspaceStore();
      await store.commit(msg);
      await refreshWorkspaceSidebar(sidebar, callbacks);
    } catch (e: any) {
      Zotero.debug(`[seerai] Commit failed: ${e}`);
    }
  };

  commitMsg.addEventListener("keydown", async (e: KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      await commitAction();
    }
  });

  form.appendChild(commitMsg);

  const btnsRow = doc.createElement("div");
  btnsRow.style.cssText = `
    display: flex;
    gap: 6px;
    align-items: center;
    justify-content: flex-end;
  `;

  const hint = doc.createElement("span");
  hint.textContent = "Ctrl+Enter or press \u2713 to commit";
  hint.style.cssText =
    "font-size: 10px; color: var(--text-tertiary); flex: 1 1 auto;";

  const cancelBtn = doc.createElementNS(HTML_NS, "button") as HTMLButtonElement;
  cancelBtn.textContent = "Cancel";
  cancelBtn.style.cssText = `
    padding: 2px 10px;
    border: 1px solid var(--border-primary);
    border-radius: 4px;
    background: var(--background-primary);
    color: var(--text-secondary);
    cursor: pointer;
    font-size: 11px;
    line-height: 18px;
  `;
  cancelBtn.addEventListener("click", () => {
    form.remove();
  });

  const commitBtn = doc.createElementNS(HTML_NS, "button") as HTMLButtonElement;
  commitBtn.textContent = "Commit";
  commitBtn.style.cssText = `
    padding: 2px 10px;
    border: 1px solid var(--border-primary);
    border-radius: 4px;
    background: var(--highlight-primary, #4a90d9);
    color: white;
    cursor: pointer;
    font-size: 11px;
    line-height: 18px;
  `;
  commitBtn.addEventListener("click", async () => {
    await commitAction();
  });

  btnsRow.appendChild(hint);
  btnsRow.appendChild(cancelBtn);
  btnsRow.appendChild(commitBtn);
  form.appendChild(btnsRow);

  form.addEventListener("contextmenu", (e) => e.preventDefault());

  const header = sidebar.firstElementChild as HTMLElement | null;
  if (header && header.nextSibling) {
    sidebar.insertBefore(form, header.nextSibling);
  } else {
    sidebar.appendChild(form);
  }

  const docListener = (e: Event) => {
    if (!form.contains(e.target as Node) && e.target !== anchor) {
      form.remove();
      doc.removeEventListener("click", docListener);
    }
  };
  setTimeout(() => {
    doc.addEventListener("click", docListener);
    commitMsg.focus();
  }, 0);
}

function showNewFileInline(
  doc: Document,
  sidebar: HTMLElement,
  callbacks: WorkspaceSidebarCallbacks,
): void {
  const existing = doc.getElementById("new-file-inline");
  if (existing) {
    existing.remove();
    return;
  }

  const commitDropdown = doc.getElementById("commit-dropdown");
  if (commitDropdown) commitDropdown.remove();

  const form = doc.createElement("div");
  form.id = "new-file-inline";
  form.style.cssText = `
    padding: 8px;
    border-bottom: 1px solid var(--border-primary);
    background: var(--background-secondary);
    display: flex;
    flex-direction: column;
    gap: 6px;
    flex-shrink: 0;
  `;

  const input = doc.createElement("input");
  input.type = "text";
  input.placeholder = "path/to/file.ts";
  input.style.cssText = `
    width: 100%;
    padding: 6px 8px;
    font-size: 12px;
    font-family: system-ui, -apple-system, sans-serif;
    border: 1px solid var(--border-primary);
    border-radius: 4px;
    background: var(--background-primary);
    color: var(--text-primary);
    box-sizing: border-box;
    outline: none;
  `;

  const submitAction = async () => {
    const name = input.value.trim();
    if (!name) return;
    try {
      form.remove();
      const store = getWorkspaceStore();
      await store.writeFile(name, "", `Created ${name}`, "user");
      await refreshWorkspaceSidebar(sidebar, callbacks);
    } catch (e: any) {
      Zotero.debug(`[seerai] Create file failed: ${e}`);
    }
  };

  input.addEventListener("keydown", (e: KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      submitAction();
    } else if (e.key === "Escape") {
      form.remove();
    }
  });

  form.appendChild(input);

  const btnsRow = doc.createElement("div");
  btnsRow.style.cssText = `
    display: flex;
    gap: 6px;
    align-items: center;
    justify-content: flex-end;
  `;

  const hint = doc.createElement("span");
  hint.textContent = "Enter to create, Esc to cancel";
  hint.style.cssText =
    "font-size: 10px; color: var(--text-tertiary); flex: 1 1 auto;";

  const cancelBtn = doc.createElementNS(HTML_NS, "button") as HTMLButtonElement;
  cancelBtn.textContent = "Cancel";
  cancelBtn.style.cssText = `
    padding: 2px 10px;
    border: 1px solid var(--border-primary);
    border-radius: 4px;
    background: var(--background-primary);
    color: var(--text-secondary);
    cursor: pointer;
    font-size: 11px;
    line-height: 18px;
  `;
  cancelBtn.addEventListener("click", () => {
    form.remove();
  });

  const createBtn = doc.createElementNS(HTML_NS, "button") as HTMLButtonElement;
  createBtn.textContent = "Create";
  createBtn.style.cssText = `
    padding: 2px 10px;
    border: 1px solid var(--border-primary);
    border-radius: 4px;
    background: var(--highlight-primary, #4a90d9);
    color: white;
    cursor: pointer;
    font-size: 11px;
    line-height: 18px;
  `;
  createBtn.addEventListener("click", async () => {
    await submitAction();
  });

  btnsRow.appendChild(hint);
  btnsRow.appendChild(cancelBtn);
  btnsRow.appendChild(createBtn);
  form.appendChild(btnsRow);

  form.addEventListener("contextmenu", (e) => e.preventDefault());

  const header = sidebar.firstElementChild as HTMLElement | null;
  if (header && header.nextSibling) {
    sidebar.insertBefore(form, header.nextSibling);
  } else {
    sidebar.appendChild(form);
  }

  const docListener = (e: Event) => {
    if (!form.contains(e.target as Node)) {
      form.remove();
      doc.removeEventListener("click", docListener);
    }
  };
  setTimeout(() => {
    doc.addEventListener("click", docListener);
    input.focus();
  }, 0);
}

function formatTimeAgo(isoString: string): string {
  const date = new Date(isoString);
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  const secs = Math.floor(diff / 1000);
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return date.toLocaleDateString();
}
