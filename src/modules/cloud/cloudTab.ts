import { CloudProviderManager } from "../drive/providerManager";
import { CloudProvider } from "../drive/providers/base";
import { FileNode, getRedirectUri } from "../drive/types";
import { ChatContextManager } from "../chat/context/contextManager";
import { ContextItemType } from "../chat/context/contextTypes";
import { driveFileMetadata, persistDriveContext } from "../drive/cloudContext";
import { stripBase64Data } from "../chat/imageUtils";
import { highlightCode } from "../chat/syntaxHighlight";
import { inferLanguage } from "../chat/workspace/types";
import { getWorkspaceStore } from "../chat/workspace/store";
import { getMessageStore } from "../chat/messageStore";
import {
  createPreviewElement,
  getRenderType,
  isRenderableExtension,
} from "../fileViewer";
import { extractCodeFromUrl } from "../drive/pkce";
import { config } from "../../../package.json";
import { createSvgIcon, type IconName } from "../chat/ui/icons";
import {
  isDocxFile,
  isDocFile,
  convertDocxToMarkdown,
  renderDocxPreview,
} from "../docxConverter";

const HTML_NS = "http://www.w3.org/1999/xhtml";
const MANAGER = CloudProviderManager.getInstance();
const MIN_LEFT_WIDTH = 200;
const MIN_RIGHT_WIDTH = 300;
const MAX_EDITOR_TABS = 5;

function getFileIcon(mimeType: string, isFolder: boolean): IconName {
  if (isFolder) return "folder";
  if (mimeType.includes("pdf")) return "paper";
  if (mimeType.includes("image") || mimeType.includes("svg")) return "image";
  if (mimeType.includes("video")) return "video";
  if (mimeType.includes("audio")) return "play";
  if (
    mimeType.includes("zip") ||
    mimeType.includes("rar") ||
    mimeType.includes("tar") ||
    mimeType.includes("gzip") ||
    mimeType.includes("7z")
  )
    return "folder";
  if (
    mimeType.includes("spreadsheet") ||
    mimeType.includes("excel") ||
    mimeType.includes("csv")
  )
    return "list";
  if (mimeType.includes("presentation") || mimeType.includes("powerpoint"))
    return "idea";
  if (
    mimeType.includes("document") ||
    mimeType.includes("word") ||
    mimeType.includes("msword")
  )
    return "paper";
  return "paper";
}

function getFileExtension(mimeType: string, name: string): string {
  const parts = name.split(".");
  if (parts.length > 1) return parts[parts.length - 1].toLowerCase();
  const map: Record<string, string> = {
    "text/plain": "txt",
    "text/markdown": "md",
    "text/csv": "csv",
    "text/html": "html",
    "application/json": "json",
    "application/pdf": "pdf",
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/svg+xml": "svg",
    "application/xml": "xml",
    "text/xml": "xml",
    "application/javascript": "js",
    "text/javascript": "js",
    "application/typescript": "ts",
  };
  return map[mimeType] || "bin";
}

function formatDate(dateStr: string): string {
  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return dateStr;
    return d.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  } catch {
    return dateStr;
  }
}

function formatSize(sizeStr: any): string {
  if (!sizeStr) return "";
  const bytes =
    typeof sizeStr === "number" ? sizeStr : parseInt(String(sizeStr), 10);
  if (isNaN(bytes) || bytes === 0) return "";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  const val = parseFloat((bytes / Math.pow(k, i)).toFixed(1));
  return val + " " + sizes[i];
}

function el(
  doc: Document,
  tag: string,
  cssText?: string,
  text?: string,
): HTMLElement {
  const e = doc.createElementNS(HTML_NS, tag) as HTMLElement;
  if (cssText) e.style.cssText = cssText.replace(/\n\s*/g, " ");
  if (text) e.textContent = text;
  return e;
}

function div(doc: Document, cssText?: string, text?: string): HTMLElement {
  return el(doc, "div", cssText, text);
}

function span(doc: Document, cssText?: string, text?: string): HTMLElement {
  return el(doc, "span", cssText, text);
}

function btn(
  doc: Document,
  text: string,
  cssText: string,
  handler: (e: Event) => void,
): HTMLButtonElement {
  const b = el(doc, "button", cssText, text) as HTMLButtonElement;
  b.addEventListener("click", handler);
  return b;
}

interface EditorFileTab {
  node: FileNode;
  content: string;
  isModified: boolean;
  mode: "preview" | "edit";
}

interface CloudTabState {
  currentProvider: CloudProvider | null;
  currentFolderId: string;
  folderHistory: Array<{ name: string; id: string }>;
  nodes: FileNode[];
  isLoading: boolean;
  isSearching: boolean;
}

const state: CloudTabState = {
  currentProvider: null,
  currentFolderId: "root",
  folderHistory: [],
  nodes: [],
  isLoading: false,
  isSearching: false,
};

let editorTabs: EditorFileTab[] = [];
let activeEditorTabIndex: number = -1;

let currentPaneRefs: {
  providerBar: HTMLElement | null;
  searchInput: HTMLInputElement | null;
  breadcrumb: HTMLElement | null;
  fileList: HTMLElement | null;
  leftPanel: HTMLElement | null;
  rightPanel: HTMLElement | null;
  splitContainer: HTMLElement | null;
  editorCaption: HTMLElement | null;
  editorContent: HTMLElement | null;
  editorToolbar: HTMLElement | null;
  statusBar: HTMLElement | null;
} = {
  providerBar: null,
  searchInput: null,
  breadcrumb: null,
  fileList: null,
  leftPanel: null,
  rightPanel: null,
  splitContainer: null,
  editorCaption: null,
  editorContent: null,
  editorToolbar: null,
  statusBar: null,
};

function resetStateForSwitch(): void {
  state.nodes = [];
  state.currentFolderId = "root";
  state.folderHistory = [];
  state.isLoading = false;
  state.isSearching = false;
  editorTabs = [];
  activeEditorTabIndex = -1;
}

export async function createCloudTabContent(
  doc: Document,
  _item: Zotero.Item,
): Promise<HTMLElement> {
  const loggedIn = MANAGER.getLoggedIn();

  if (
    state.currentProvider &&
    !loggedIn.some((p) => p.id === state.currentProvider!.id)
  ) {
    state.currentProvider = null;
  }

  if (!state.currentProvider && !state.isLoading && !state.isSearching) {
    if (loggedIn.length > 0) {
      state.currentProvider = loggedIn[0];
      MANAGER.setActive(state.currentProvider.id);
    }
  }

  if (!state.currentProvider) {
    return renderEmptyState(doc);
  }

  return renderFullUI(doc);
}

function renderEmptyState(doc: Document): HTMLElement {
  const container = div(
    doc,
    "display: flex; flex-direction: column; height: 100%; width: 100%; min-width: 0; max-width: 100%; overflow: hidden; box-sizing: border-box; font-family: system-ui, -apple-system, sans-serif; background: var(--background-primary);",
  );
  container.setAttribute("data-cloud-root", "true");

  const header = div(doc, "padding: 24px 24px 0 24px; flex-shrink: 0;");
  const title = div(
    doc,
    "font-size: 16px; font-weight: 700; margin-bottom: 8px; color: var(--text-primary); display: inline-flex; align-items: center; gap: 6px;",
  );
  title.appendChild(
    createSvgIcon(doc, "cloud", { size: 18, strokeWidth: 1.7 }),
  );
  const titleText = doc.createElement("span");
  titleText.textContent = "Cloud Storage";
  title.appendChild(titleText);
  header.appendChild(title);
  const subtitle = div(
    doc,
    "font-size: 12px; color: var(--text-secondary); margin-bottom: 20px;",
    "Connect a provider to browse, view, and edit your cloud files.",
  );
  header.appendChild(subtitle);
  container.appendChild(header);

  const cards = div(
    doc,
    "flex: 1; overflow-y: auto; padding: 0 24px 24px 24px; display: flex; flex-wrap: wrap; gap: 12px; align-content: flex-start;",
  );

  for (const provider of MANAGER.getAll()) {
    const card = div(
      doc,
      `background: var(--background-secondary); border: 1px solid var(--border-primary); border-radius: 12px; padding: 16px; cursor: pointer; transition: all 0.2s ease; display: flex; align-items: center; gap: 14px; min-width: 200px; flex: 1;`,
    );
    card.addEventListener("mouseenter", () => {
      card.style.borderColor = provider.brandColor;
      card.style.boxShadow = `0 2px 8px ${provider.brandColor}20`;
      card.style.transform = "translateY(-1px)";
    });
    card.addEventListener("mouseleave", () => {
      card.style.borderColor = "var(--border-primary)";
      card.style.boxShadow = "none";
      card.style.transform = "";
    });

    const icon = span(
      doc,
      "width: 40px; display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0;",
    );
    icon.appendChild(
      createSvgIcon(doc, provider.icon || "cloud", {
        size: 28,
        strokeWidth: 1.7,
      }),
    );
    card.appendChild(icon);

    const info = div(doc, "flex: 1; min-width: 0;");
    const name = div(
      doc,
      "font-weight: 700; font-size: 14px; color: var(--text-primary);",
      provider.name,
    );
    info.appendChild(name);
    const desc = div(
      doc,
      "font-size: 11px; color: var(--text-secondary); margin-top: 2px;",
      provider.id === "nextcloud"
        ? "Self-hosted cloud storage"
        : "Connect with OAuth",
    );
    info.appendChild(desc);
    card.appendChild(info);

    const arrow = span(
      doc,
      "color: var(--text-secondary); flex-shrink: 0; display: inline-flex; align-items: center;",
    );
    arrow.appendChild(
      createSvgIcon(doc, "chevron-right", { size: 14, strokeWidth: 1.8 }),
    );
    card.appendChild(arrow);

    card.addEventListener("click", () =>
      showInlineConnect(doc, card, provider),
    );
    cards.appendChild(card);
  }

  container.appendChild(cards);
  return container;
}

function showInlineConnect(
  doc: Document,
  anchorCard: HTMLElement,
  provider: CloudProvider,
): void {
  const container = anchorCard.closest("[data-cloud-root]") as HTMLElement;
  if (!container) return;

  if (provider.id === "nextcloud") {
    renderNextcloudForm(doc, container);
    return;
  }

  container.innerHTML = "";

  const wrapper = div(
    doc,
    "display: flex; flex-direction: column; height: 100%; width: 100%; min-width: 0; overflow: auto; padding: 24px; box-sizing: border-box;",
  );

  const backRow = div(
    doc,
    "display: flex; align-items: center; gap: 8px; margin-bottom: 20px;",
  );
  const backBtn = btn(
    doc,
    "Back",
    "background: none; border: none; color: var(--text-secondary); cursor: pointer; font-size: 13px; padding: 4px 8px; border-radius: 4px;",
    async () => {
      const root = wrapper.closest("[data-cloud-root]") as HTMLElement;
      if (!root) return;
      root.innerHTML = "";
      if (MANAGER.getLoggedIn().length > 0) {
        root.appendChild(await renderFullUI(doc));
      } else {
        root.appendChild(renderEmptyState(doc));
      }
    },
  );
  backBtn.addEventListener("mouseenter", () => {
    backBtn.style.background = "var(--background-secondary)";
  });
  backBtn.addEventListener("mouseleave", () => {
    backBtn.style.background = "none";
  });
  backRow.appendChild(backBtn);
  wrapper.appendChild(backRow);

  const iconBig = div(
    doc,
    "margin-bottom: 16px; display: flex; align-items: center; justify-content: center;",
  );
  iconBig.appendChild(
    createSvgIcon(doc, provider.icon || "cloud", {
      size: 40,
      strokeWidth: 1.6,
    }),
  );
  wrapper.appendChild(iconBig);

  const title = div(
    doc,
    "font-weight: 700; font-size: 18px; margin-bottom: 8px; text-align: center; color: var(--text-primary);",
    `Connect to ${provider.name}`,
  );
  wrapper.appendChild(title);

  const desc = div(
    doc,
    "font-size: 12px; color: var(--text-secondary); margin-bottom: 24px; text-align: center;",
    "A login page will open in your browser. Sign in, then paste the authorization code below.",
  );
  wrapper.appendChild(desc);

  const signInBtn = btn(
    doc,
    "Sign In with " + provider.name,
    `padding: 12px 24px; border-radius: 8px; border: none; font-weight: 600; cursor: pointer; font-size: 14px; transition: filter 0.2s; background: ${provider.brandColor}; color: #fff; width: 100%;`,
    async () => {
      signInBtn.disabled = true;
      signInBtn.textContent = "Opening browser...";
      try {
        await provider.login();
        signInBtn.textContent = "Browser opened";
        signInBtn.style.background = "#188038";
      } catch (e: any) {
        signInBtn.textContent = "Try Again";
        signInBtn.disabled = false;
        Zotero.debug(`[seerai] Cloud tab login error: ${e}`);
      }
    },
  );
  signInBtn.addEventListener("mouseenter", () => {
    signInBtn.style.filter = "brightness(0.9)";
  });
  signInBtn.addEventListener("mouseleave", () => {
    signInBtn.style.filter = "none";
  });
  wrapper.appendChild(signInBtn);

  const pasteArea = div(doc, "margin-top: 20px;");
  wrapper.appendChild(pasteArea);

  const pasteLabel = div(
    doc,
    "font-size: 11px; color: var(--text-secondary); margin-bottom: 8px; font-weight: 600;",
    "Paste the authorization code (or the full redirect URL):",
  );
  pasteArea.appendChild(pasteLabel);

  const pasteInput = el(
    doc,
    "textarea",
    "width: 100%; padding: 10px 12px; border: 1px solid var(--border-primary); border-radius: 6px; background: var(--background-secondary); color: var(--text-primary); font-size: 12px; font-family: monospace; box-sizing: border-box; min-height: 60px; outline: none; resize: vertical; margin-bottom: 12px;",
  ) as HTMLTextAreaElement;
  const placeholder = getRedirectUri(provider.id);
  pasteInput.placeholder = `Paste code or URL like: ${placeholder}?code=...`;
  pasteArea.appendChild(pasteInput);

  const pasteStatus = div(
    doc,
    "font-size: 11px; margin-bottom: 12px; display: none; text-align: center; font-weight: 600;",
  );
  pasteArea.appendChild(pasteStatus);

  const verifyBtn = btn(
    doc,
    "Verify Code",
    `padding: 10px 16px; border-radius: 6px; border: none; font-weight: 600; cursor: pointer; font-size: 13px; transition: filter 0.2s; background: ${provider.brandColor}; color: #fff; width: 100%;`,
    async () => {
      const raw = pasteInput.value.trim();
      if (!raw) return;
      verifyBtn.disabled = true;
      verifyBtn.textContent = "Verifying...";
      pasteStatus.style.display = "none";
      try {
        let code = raw;
        if (raw.includes("?") || raw.includes("&")) {
          const extracted = extractCodeFromUrl(raw);
          if (extracted) code = extracted;
        }
        await provider.handleCallback(code);
        pasteStatus.textContent = "Connected!";
        pasteStatus.style.color = "#188038";
        pasteStatus.style.display = "block";
        setTimeout(async () => {
          state.currentProvider = provider;
          MANAGER.setActive(provider.id);
          resetStateForSwitch();
          const root = wrapper.closest("[data-cloud-root]") as HTMLElement;
          if (root) {
            root.innerHTML = "";
            root.appendChild(await renderFullUI(doc));
          }
        }, 800);
      } catch (e: any) {
        verifyBtn.disabled = false;
        verifyBtn.textContent = "Verify Code";
        pasteStatus.textContent = e?.message || "Connection failed";
        pasteStatus.style.color = "#d93025";
        pasteStatus.style.display = "block";
      }
    },
  );
  verifyBtn.addEventListener("mouseenter", () => {
    verifyBtn.style.filter = "brightness(0.9)";
  });
  verifyBtn.addEventListener("mouseleave", () => {
    verifyBtn.style.filter = "none";
  });
  pasteArea.appendChild(verifyBtn);

  container.appendChild(wrapper);
}

function renderNextcloudForm(doc: Document, container: HTMLElement): void {
  container.innerHTML = "";

  const wrapper = div(
    doc,
    "display: flex; flex-direction: column; height: 100%; width: 100%; min-width: 0; overflow: auto; padding: 24px; box-sizing: border-box;",
  );

  const backRow = div(
    doc,
    "display: flex; align-items: center; gap: 8px; margin-bottom: 20px;",
  );
  const backBtn = btn(
    doc,
    "Back",
    "background: none; border: none; color: var(--text-secondary); cursor: pointer; font-size: 13px; padding: 4px 8px; border-radius: 4px;",
    async () => {
      const root = wrapper.closest("[data-cloud-root]") as HTMLElement;
      if (!root) return;
      root.innerHTML = "";
      if (MANAGER.getLoggedIn().length > 0) {
        root.appendChild(await renderFullUI(doc));
      } else {
        root.appendChild(renderEmptyState(doc));
      }
    },
  );
  backBtn.addEventListener("mouseenter", () => {
    backBtn.style.background = "var(--background-secondary)";
  });
  backBtn.addEventListener("mouseleave", () => {
    backBtn.style.background = "none";
  });
  backRow.appendChild(backBtn);
  wrapper.appendChild(backRow);

  const iconBig = div(
    doc,
    "font-size: 48px; margin-bottom: 16px; text-align: center;",
    "\uD83D\uDCBB",
  );
  wrapper.appendChild(iconBig);

  const title = div(
    doc,
    "font-weight: 700; font-size: 18px; margin-bottom: 16px; text-align: center; color: var(--text-primary);",
    "Connect to Nextcloud",
  );
  wrapper.appendChild(title);

  const fieldStyle =
    "width: 100%; padding: 10px 12px; border: 1px solid var(--border-primary); border-radius: 6px; background: var(--background-secondary); color: var(--text-primary); font-size: 13px; box-sizing: border-box; margin-bottom: 12px; outline: none;";

  const serverInput = el(doc, "input", fieldStyle) as HTMLInputElement;
  serverInput.placeholder = "Server URL (https://cloud.example.com)";
  serverInput.value =
    (Zotero.Prefs.get(
      `${config.prefsPrefix}.cloud.nextcloud.serverUrl`,
    ) as string) || "";
  wrapper.appendChild(serverInput);

  const userInput = el(doc, "input", fieldStyle) as HTMLInputElement;
  userInput.placeholder = "Username";
  userInput.value =
    (Zotero.Prefs.get(
      `${config.prefsPrefix}.cloud.nextcloud.username`,
    ) as string) || "";
  wrapper.appendChild(userInput);

  const passInput = el(doc, "input", fieldStyle) as HTMLInputElement;
  passInput.type = "password";
  passInput.placeholder = "App Password";
  wrapper.appendChild(passInput);

  const errorMsg = div(
    doc,
    "font-size: 11px; margin-bottom: 12px; display: none; text-align: center; font-weight: 600; color: #d93025;",
  );
  wrapper.appendChild(errorMsg);

  const provider = MANAGER.get("nextcloud");
  const connectBtn = btn(
    doc,
    "Connect",
    `padding: 12px 24px; border-radius: 8px; border: none; font-weight: 600; cursor: pointer; font-size: 14px; transition: filter 0.2s; background: ${provider?.brandColor || "#0082C9"}; color: #fff; width: 100%;`,
    async () => {
      const url = serverInput.value.trim();
      const user = userInput.value.trim();
      const pass = passInput.value.trim();
      if (!url || !user || !pass) {
        errorMsg.textContent = "All fields are required.";
        errorMsg.style.display = "block";
        return;
      }
      connectBtn.disabled = true;
      connectBtn.textContent = "Connecting...";
      Zotero.Prefs.set(`${config.prefsPrefix}.cloud.nextcloud.serverUrl`, url);
      Zotero.Prefs.set(`${config.prefsPrefix}.cloud.nextcloud.username`, user);
      Zotero.Prefs.set(
        `${config.prefsPrefix}.cloud.nextcloud.appPassword`,
        pass,
      );
      try {
        const success = provider ? await provider.login() : false;
        if (success) {
          state.currentProvider = provider!;
          MANAGER.setActive("nextcloud");
          resetStateForSwitch();
          const root = wrapper.closest("[data-cloud-root]") as HTMLElement;
          if (root) {
            root.innerHTML = "";
            root.appendChild(await renderFullUI(doc));
          }
        } else {
          connectBtn.disabled = false;
          connectBtn.textContent = "Connect";
          errorMsg.textContent = "Connection failed. Check your credentials.";
          errorMsg.style.display = "block";
        }
      } catch (e: any) {
        connectBtn.disabled = false;
        connectBtn.textContent = "Connect";
        errorMsg.textContent = e?.message || "Connection failed.";
        errorMsg.style.display = "block";
      }
    },
  );
  connectBtn.addEventListener("mouseenter", () => {
    connectBtn.style.filter = "brightness(0.9)";
  });
  connectBtn.addEventListener("mouseleave", () => {
    connectBtn.style.filter = "none";
  });
  wrapper.appendChild(connectBtn);

  container.appendChild(wrapper);
}

async function renderFullUI(doc: Document): Promise<HTMLElement> {
  const container = div(
    doc,
    "display: flex; flex-direction: column; height: 100%; width: 100%; min-width: 0; max-width: 100%; overflow: hidden; box-sizing: border-box; font-family: system-ui, -apple-system, sans-serif; background: var(--background-primary);",
  );
  container.setAttribute("data-cloud-root", "true");

  if (!state.currentProvider) {
    state.currentProvider = MANAGER.getLoggedIn()[0] || null;
    if (!state.currentProvider) {
      return renderEmptyState(doc);
    }
  }

  const providerBar = renderProviderBar(doc);
  container.appendChild(providerBar);

  const searchBar = renderSearchBar(doc);
  container.appendChild(searchBar);

  const breadcrumb = renderBreadcrumb(doc);
  container.appendChild(breadcrumb);

  const splitContainer = div(
    doc,
    "position: relative; flex: 1 1 0; display: flex; min-width: 0; min-height: 0; overflow: hidden;",
  );
  splitContainer.className = "cloud-split-layout";

  const leftPanel = div(
    doc,
    "display: flex; flex-direction: column; min-height: 0; overflow: hidden; border-right: 1px solid var(--border-primary);",
  );
  leftPanel.className = "cloud-files-panel";
  leftPanel.style.flex = "0.4 0.4 0";
  leftPanel.style.minWidth = MIN_LEFT_WIDTH + "px";

  const fileList = div(doc, "flex: 1 1 0; overflow-y: auto; padding: 4px 0;");
  leftPanel.appendChild(fileList);

  const handle = createResizeHandle(doc, leftPanel, splitContainer);
  splitContainer.appendChild(leftPanel);
  splitContainer.appendChild(handle);

  const rightPanel = div(
    doc,
    "flex: 1 1 0; display: flex; flex-direction: column; min-height: 0; overflow: hidden; background: var(--background-primary);",
  );
  rightPanel.className = "cloud-editor-panel";
  rightPanel.style.minWidth = MIN_RIGHT_WIDTH + "px";
  splitContainer.appendChild(rightPanel);

  const editorCaption = div(
    doc,
    "display: flex; align-items: center; padding: 6px 12px; border-bottom: 1px solid var(--border-primary); background: var(--background-secondary); gap: 4px; min-height: 32px; overflow-x: auto; flex-shrink: 0;",
  );
  rightPanel.appendChild(editorCaption);

  const editorContent = div(
    doc,
    "flex: 1 1 0; min-height: 0; display: flex; flex-direction: column; overflow: auto;",
  );
  rightPanel.appendChild(editorContent);

  const editorToolbar = div(
    doc,
    "display: flex; align-items: center; gap: 6px; padding: 6px 12px; border-top: 1px solid var(--border-primary); background: var(--background-secondary); min-height: 32px; flex-shrink: 0;",
  );
  rightPanel.appendChild(editorToolbar);

  container.appendChild(splitContainer);

  const statusBar = div(
    doc,
    "padding: 4px 12px; border-top: 1px solid var(--border-primary); background: var(--background-secondary); font-size: 10px; color: var(--text-tertiary); min-height: 20px; display: flex; align-items: center; flex-shrink: 0;",
  );
  container.appendChild(statusBar);

  currentPaneRefs = {
    providerBar,
    searchInput: searchBar.querySelector("input") as HTMLInputElement | null,
    breadcrumb,
    fileList,
    leftPanel,
    rightPanel,
    splitContainer,
    editorCaption,
    editorContent,
    editorToolbar,
    statusBar,
  };

  const applyResponsiveLayout = () => {
    const availableWidth = splitContainer.getBoundingClientRect().width;
    if (!availableWidth) return;
    if (availableWidth < 640) {
      splitContainer.style.flexDirection = "column";
      leftPanel.style.flex = "0 0 36%";
      leftPanel.style.width = "100%";
      leftPanel.style.minWidth = "0";
      leftPanel.style.minHeight = "120px";
      leftPanel.style.borderRight = "none";
      leftPanel.style.borderBottom = "1px solid var(--border-primary)";
      handle.style.display = "none";
      rightPanel.style.width = "100%";
      rightPanel.style.minWidth = "0";
      rightPanel.style.minHeight = "160px";
    } else {
      splitContainer.style.flexDirection = "row";
      leftPanel.style.flex = "0.4 0.4 0";
      leftPanel.style.width = "";
      leftPanel.style.minWidth = MIN_LEFT_WIDTH + "px";
      leftPanel.style.minHeight = "0";
      leftPanel.style.borderRight = "1px solid var(--border-primary)";
      leftPanel.style.borderBottom = "none";
      handle.style.display = "";
      rightPanel.style.width = "";
      rightPanel.style.minWidth = MIN_RIGHT_WIDTH + "px";
      rightPanel.style.minHeight = "0";
    }
  };
  const ResizeObserverCtor = doc.defaultView?.ResizeObserver;
  if (ResizeObserverCtor) {
    const layoutObserver = new ResizeObserverCtor(applyResponsiveLayout);
    layoutObserver.observe(splitContainer);
    (container as any)._layoutObserver = layoutObserver;
  }
  setTimeout(applyResponsiveLayout, 0);

  await navigateToFolder(doc, state.currentFolderId);

  return container;
}

function showAddProviderDropdown(doc: Document, anchorBtn: HTMLElement): void {
  const existing = doc.querySelector("[data-add-provider-dropdown]");
  if (existing) {
    existing.remove();
    return;
  }

  const loggedInIds = new Set(MANAGER.getLoggedIn().map((p) => p.id));
  const allProviders = MANAGER.getAll().filter((p) => !loggedInIds.has(p.id));
  if (allProviders.length === 0) return;

  const rect = anchorBtn.getBoundingClientRect();

  const backdrop = div(doc, "position: fixed; inset: 0; z-index: 99998;");
  backdrop.setAttribute("data-add-provider-dropdown-backdrop", "");

  const dropdown = div(
    doc,
    "position: fixed; z-index: 99999; background: var(--background-primary); border: 1px solid var(--border-primary); border-radius: 8px; box-shadow: 0 4px 16px rgba(0,0,0,0.12); min-width: 200px; overflow: hidden;",
  );
  dropdown.setAttribute("data-add-provider-dropdown", "");
  dropdown.style.top = rect.bottom + 4 + "px";
  dropdown.style.left = rect.left + "px";

  for (const provider of allProviders) {
    const item = div(
      doc,
      "display: flex; align-items: center; gap: 10px; padding: 10px 14px; cursor: pointer; transition: background 0.15s; font-size: 13px;",
    );
    const provIcon = span(
      doc,
      "width: 18px; height: 18px; flex-shrink: 0; display: inline-flex; align-items: center; justify-content: center;",
    );
    provIcon.appendChild(
      createSvgIcon(doc, provider.icon || "cloud", {
        size: 16,
        strokeWidth: 1.7,
      }),
    );
    item.appendChild(provIcon);
    item.appendChild(
      span(doc, "color: var(--text-primary); font-weight: 500;", provider.name),
    );
    item.addEventListener("mouseenter", () => {
      item.style.background = "var(--background-secondary)";
    });
    item.addEventListener("mouseleave", () => {
      item.style.background = "transparent";
    });
    item.addEventListener("click", () => {
      removeDropdown();
      showInlineConnect(doc, anchorBtn, provider);
    });
    dropdown.appendChild(item);
  }

  const removeDropdown = () => {
    doc.querySelector("[data-add-provider-dropdown]")?.remove();
    doc.querySelector("[data-add-provider-dropdown-backdrop]")?.remove();
  };

  const appendTarget = doc.body || doc.documentElement;
  if (!appendTarget) return;
  backdrop.addEventListener("click", removeDropdown);
  appendTarget.appendChild(backdrop);
  appendTarget.appendChild(dropdown);
}

function renderProviderBar(doc: Document): HTMLElement {
  const bar = div(
    doc,
    "display: flex; align-items: center; gap: 4px; padding: 8px 12px; border-bottom: 1px solid var(--border-primary); background: var(--background-secondary); overflow-x: auto; flex-shrink: 0;",
  );

  const loggedIn = MANAGER.getLoggedIn();

  for (const provider of loggedIn) {
    const pill = div(
      doc,
      "padding: 6px 14px; border-radius: 20px; cursor: pointer; font-size: 12px; font-weight: 500; white-space: nowrap; transition: all 0.2s ease; user-select: none; display: inline-flex; align-items: center; gap: 6px;",
    );
    const pillIcon = span(
      doc,
      "width: 14px; height: 14px; display: inline-flex; align-items: center; justify-content: center;",
    );
    pillIcon.appendChild(
      createSvgIcon(doc, provider.icon || "cloud", {
        size: 13,
        strokeWidth: 1.7,
      }),
    );
    pill.appendChild(pillIcon);
    pill.appendChild(span(doc, "", provider.name));

    const isActive = state.currentProvider?.id === provider.id;
    if (isActive) {
      pill.style.background = provider.brandColor;
      pill.style.color = "#fff";
      pill.style.boxShadow = `0 2px 6px ${provider.brandColor}40`;
      pill.style.fontWeight = "700";
    } else {
      pill.style.background = "transparent";
      pill.style.color = "var(--text-secondary)";
    }

    pill.addEventListener("click", async () => {
      if (state.currentProvider?.id === provider.id) return;
      state.currentProvider = provider;
      MANAGER.setActive(provider.id);
      resetStateForSwitch();
      editorTabs = [];
      activeEditorTabIndex = -1;
      refreshEditorPanel(doc);
      await navigateToFolder(doc, "root");
      refreshProviderBar(doc);
    });

    pill.addEventListener("mouseenter", () => {
      if (!isActive) {
        pill.style.background = "var(--background-primary)";
      }
    });
    pill.addEventListener("mouseleave", () => {
      if (!isActive) {
        pill.style.background = "transparent";
      }
    });

    bar.appendChild(pill);
  }

  const addBtn = div(
    doc,
    "padding: 6px 10px; cursor: pointer; font-size: 16px; color: var(--text-secondary); border-radius: 50%; transition: all 0.2s; display: flex; align-items: center; justify-content: center; width: 28px; height: 28px; flex-shrink: 0;",
    "+",
  );
  addBtn.title = "Connect another provider";
  addBtn.addEventListener("click", () => {
    showAddProviderDropdown(doc, addBtn);
  });
  addBtn.addEventListener("mouseenter", () => {
    addBtn.style.background = "var(--background-primary)";
    addBtn.style.color = "var(--text-primary)";
  });
  addBtn.addEventListener("mouseleave", () => {
    addBtn.style.background = "transparent";
    addBtn.style.color = "var(--text-secondary)";
  });
  bar.appendChild(addBtn);

  if (loggedIn.length > 0) {
    const logoutBtn = div(
      doc,
      "margin-left: auto; padding: 6px 10px; cursor: pointer; font-size: 14px; color: var(--text-secondary); border-radius: 50%; transition: all 0.2s; opacity: 0.6; flex-shrink: 0;",
      "\uD83D\uDEAA",
    );
    logoutBtn.title = `Disconnect ${state.currentProvider?.name || ""}`;
    logoutBtn.addEventListener("click", () => {
      if (!state.currentProvider) return;
      state.currentProvider.logout();
      refreshAfterLogout(doc);
    });
    logoutBtn.addEventListener("mouseenter", () => {
      logoutBtn.style.opacity = "1";
      logoutBtn.style.background = "var(--background-primary)";
    });
    logoutBtn.addEventListener("mouseleave", () => {
      logoutBtn.style.opacity = "0.6";
      logoutBtn.style.background = "transparent";
    });
    bar.appendChild(logoutBtn);
  }

  currentPaneRefs.providerBar = bar;
  return bar;
}

function refreshProviderBar(doc: Document): void {
  const bar = currentPaneRefs.providerBar;
  if (!bar) return;
  bar.innerHTML = "";
  const newBar = renderProviderBar(doc);
  while (newBar.firstChild) {
    bar.appendChild(newBar.firstChild);
  }
  currentPaneRefs.providerBar = bar;
}

function refreshAfterLogout(doc: Document): void {
  const loggedIn = MANAGER.getLoggedIn();
  if (loggedIn.length > 0) {
    state.currentProvider = loggedIn[0];
    MANAGER.setActive(state.currentProvider.id);
    resetStateForSwitch();
    editorTabs = [];
    activeEditorTabIndex = -1;
    refreshEditorPanel(doc);
    refreshProviderBar(doc);
    navigateToFolder(doc, "root");
  } else {
    state.currentProvider = null;
    resetStateForSwitch();
    const root = currentPaneRefs.splitContainer?.closest(
      "[data-cloud-root]",
    ) as HTMLElement;
    if (root) {
      root.innerHTML = "";
      root.appendChild(renderEmptyState(doc));
    }
  }
}

function renderSearchBar(doc: Document): HTMLElement {
  const searchBox = div(
    doc,
    "padding: 8px 12px; border-bottom: 1px solid var(--border-primary); background: var(--background-primary); flex-shrink: 0; display: flex; align-items: center; gap: 8px;",
  );

  const searchIcon = span(
    doc,
    "font-size: 14px; color: var(--text-tertiary); flex-shrink: 0;",
    "\uD83D\uDD0D",
  );
  searchBox.appendChild(searchIcon);

  const input = el(
    doc,
    "input",
    "flex: 1; padding: 6px 8px; border: none; background: transparent; color: var(--text-primary); font-size: 12px; outline: none; min-width: 0;",
  ) as HTMLInputElement;
  input.placeholder = "Search files...";
  searchBox.appendChild(input);

  let timer: any;
  input.addEventListener("input", () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 2) {
      if (state.isSearching) {
        state.isSearching = false;
        navigateToFolder(doc, state.currentFolderId);
      }
      return;
    }
    timer = setTimeout(async () => {
      state.isSearching = true;
      await performSearch(doc, q);
    }, 400);
  });

  input.addEventListener("keydown", (ev) => {
    const e = ev as KeyboardEvent;
    if (e.key === "Escape") {
      input.value = "";
      state.isSearching = false;
      navigateToFolder(doc, state.currentFolderId);
    }
  });

  currentPaneRefs.searchInput = input;
  return searchBox;
}

async function performSearch(doc: Document, query: string): Promise<void> {
  if (!state.currentProvider) return;
  const fileList = currentPaneRefs.fileList;
  const breadcrumb = currentPaneRefs.breadcrumb;
  const statusBar = currentPaneRefs.statusBar;
  if (!fileList) return;

  fileList.innerHTML = "";
  const loading = div(
    doc,
    "padding: 32px; text-align: center; color: var(--text-tertiary); font-size: 12px; font-style: italic;",
    "Searching...",
  );
  fileList.appendChild(loading);

  if (breadcrumb) {
    breadcrumb.innerHTML = "";
    const searchLabel = div(
      doc,
      "padding: 6px 12px; font-size: 11px; color: var(--text-secondary); display: flex; align-items: center; gap: 6px;",
    );
    const backLink = span(
      doc,
      "cursor: pointer; color: var(--highlight-primary); font-weight: 600;",
      "Back to browse",
    );
    backLink.addEventListener("click", () => {
      const input = currentPaneRefs.searchInput;
      if (input) input.value = "";
      state.isSearching = false;
      navigateToFolder(doc, state.currentFolderId);
    });
    searchLabel.appendChild(backLink);
    searchLabel.appendChild(
      doc.createTextNode(` \u2014 Results for "${query}"`),
    );
    breadcrumb.appendChild(searchLabel);
  }

  try {
    const { nodes } = await state.currentProvider.searchFiles(query);
    if (!state.isSearching) return;
    fileList.innerHTML = "";
    if (nodes.length === 0) {
      const empty = div(
        doc,
        "padding: 32px; text-align: center; color: var(--text-tertiary); font-size: 12px;",
        "No results found",
      );
      fileList.appendChild(empty);
    } else {
      for (const node of nodes) {
        fileList.appendChild(createFileRow(doc, node, state.currentProvider!));
      }
    }
    if (statusBar) {
      statusBar.textContent = `${nodes.length} result${nodes.length === 1 ? "" : "s"} for "${query}"`;
    }
  } catch (e: any) {
    fileList.innerHTML = "";
    const fail = div(
      doc,
      "padding: 32px; text-align: center; color: #d93025; font-size: 12px;",
      "Search failed. Try again.",
    );
    const retryBtn = btn(
      doc,
      "Retry",
      "margin-top: 8px; padding: 6px 16px; border-radius: 6px; border: 1px solid var(--border-primary); background: transparent; color: var(--text-secondary); cursor: pointer; font-size: 12px;",
      () => performSearch(doc, query),
    );
    fail.appendChild(retryBtn);
    fileList.appendChild(fail);
  }
}

function renderBreadcrumb(doc: Document): HTMLElement {
  const bc = div(
    doc,
    "padding: 6px 12px; border-bottom: 1px solid var(--border-primary); background: var(--background-secondary); font-size: 11px; color: var(--text-secondary); display: flex; align-items: center; gap: 4px; overflow-x: auto; flex-shrink: 0; white-space: nowrap; min-height: 20px;",
  );
  currentPaneRefs.breadcrumb = bc;
  return bc;
}

function updateBreadcrumb(doc: Document): void {
  const bc = currentPaneRefs.breadcrumb;
  if (!bc) return;
  bc.innerHTML = "";

  const rootSpan = span(
    doc,
    "cursor: pointer; color: var(--highlight-primary); font-weight: 600;",
    "\uD83D\uDCC1 / root",
  );
  rootSpan.addEventListener("click", () => navigateToFolder(doc, "root"));
  bc.appendChild(rootSpan);

  for (let i = 0; i < state.folderHistory.length; i++) {
    bc.appendChild(
      span(doc, "color: var(--text-tertiary); margin: 0 2px;", "\u203A"),
    );
    const seg = span(
      doc,
      "cursor: pointer; color: var(--highlight-primary);",
      state.folderHistory[i].name,
    );
    seg.addEventListener("click", () => {
      state.folderHistory = state.folderHistory.slice(0, i + 1);
      navigateToFolder(doc, state.folderHistory[i].id);
    });
    bc.appendChild(seg);
  }
}

async function navigateToFolder(
  doc: Document,
  folderId: string,
): Promise<void> {
  if (!state.currentProvider) return;
  const fileList = currentPaneRefs.fileList;
  const statusBar = currentPaneRefs.statusBar;
  if (!fileList) return;

  state.currentFolderId = folderId;
  state.isSearching = false;
  state.isLoading = true;

  fileList.innerHTML = "";
  const loading = div(
    doc,
    "padding: 40px; text-align: center; color: var(--text-tertiary); font-size: 12px; font-style: italic;",
    "Loading files...",
  );
  fileList.appendChild(loading);

  updateBreadcrumb(doc);

  try {
    const result = await state.currentProvider.listFolder(
      folderId === "root" ? "" : folderId,
    );
    state.nodes = result.nodes;
    state.isLoading = false;

    renderFileList(doc);
    if (statusBar) {
      statusBar.textContent = `${state.nodes.length} item${state.nodes.length === 1 ? "" : "s"}`;
    }
  } catch (e: any) {
    state.isLoading = false;
    fileList.innerHTML = "";
    const fail = div(
      doc,
      "padding: 32px; text-align: center; color: #d93025; font-size: 12px;",
    );

    if (
      e?.message?.includes("401") ||
      e?.message?.includes("403") ||
      e?.message?.includes("unauthorized")
    ) {
      fail.textContent = "Session expired. Please re-authenticate.";
      const reauthBtn = btn(
        doc,
        "Re-authenticate",
        "margin-top: 8px; padding: 6px 16px; border-radius: 6px; border: none; background: var(--highlight-primary); color: #fff; cursor: pointer; font-size: 12px;",
        () => {
          if (!state.currentProvider) return;
          state.currentProvider.logout();
          refreshAfterLogout(doc);
        },
      );
      fail.appendChild(reauthBtn);
    } else {
      fail.textContent = "Failed to load files.";
      const retryBtn = btn(
        doc,
        "Retry",
        "margin-top: 8px; padding: 6px 16px; border-radius: 6px; border: 1px solid var(--border-primary); background: transparent; color: var(--text-secondary); cursor: pointer; font-size: 12px;",
        () => navigateToFolder(doc, folderId),
      );
      fail.appendChild(retryBtn);
    }
    fileList.appendChild(fail);
  }
}

function renderFileList(doc: Document): void {
  const fileList = currentPaneRefs.fileList;
  if (!fileList) return;

  fileList.innerHTML = "";

  if (state.folderHistory.length > 0) {
    const backRow = div(
      doc,
      "display: flex; align-items: center; gap: 10px; padding: 8px 12px; cursor: pointer; transition: background 0.15s; border-radius: 6px; margin: 2px 4px;",
    );
    backRow.appendChild(span(doc, "font-size: 14px;", "\u21A9\uFE0F"));
    backRow.appendChild(
      span(
        doc,
        "font-weight: 600; font-size: 12px; color: var(--text-primary);",
        "..",
      ),
    );
    backRow.addEventListener("click", () => {
      state.folderHistory.pop();
      const targetId =
        state.folderHistory.length > 0
          ? state.folderHistory[state.folderHistory.length - 1].id
          : "root";
      state.currentFolderId = targetId;
      navigateToFolder(doc, targetId);
    });
    backRow.addEventListener("mouseenter", () => {
      backRow.style.background = "var(--background-secondary)";
    });
    backRow.addEventListener("mouseleave", () => {
      backRow.style.background = "transparent";
    });
    fileList.appendChild(backRow);
  }

  if (state.nodes.length === 0) {
    const empty = div(
      doc,
      "padding: 48px 24px; text-align: center; color: var(--text-tertiary); font-size: 12px;",
      "This folder is empty",
    );
    fileList.appendChild(empty);
    return;
  }

  for (const node of state.nodes) {
    fileList.appendChild(createFileRow(doc, node, state.currentProvider!));
  }
}

function createFileRow(
  doc: Document,
  node: FileNode,
  provider: CloudProvider,
): HTMLElement {
  const row = div(
    doc,
    "display: flex; align-items: center; gap: 12px; padding: 10px 12px; cursor: pointer; transition: background 0.15s; border-radius: 6px; margin: 1px 4px;",
  );

  row.addEventListener("mouseenter", () => {
    row.style.background = "var(--background-secondary)";
  });
  row.addEventListener("mouseleave", () => {
    row.style.background = "transparent";
  });

  const icon = span(
    doc,
    "font-size: 18px; width: 22px; display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0;",
  );
  icon.appendChild(
    createSvgIcon(doc, getFileIcon(node.mimeType, node.isFolder), {
      size: 16,
      strokeWidth: 1.7,
    }),
  );
  row.appendChild(icon);

  const info = div(doc, "flex: 1; min-width: 0;");
  const name = div(
    doc,
    "font-weight: 600; font-size: 12px; color: var(--text-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;",
    node.name,
  );
  info.appendChild(name);

  const metaParts: string[] = [];
  if (node.modifiedTime) {
    metaParts.push(formatDate(node.modifiedTime));
  }
  const meta = div(
    doc,
    "font-size: 10px; color: var(--text-tertiary); margin-top: 1px;",
    metaParts.join(" \u00B7 "),
  );
  info.appendChild(meta);
  row.appendChild(info);

  if (node.isFolder) {
    const chevron = span(
      doc,
      "font-size: 14px; color: var(--text-tertiary); flex-shrink: 0; font-weight: bold;",
      "\u203A",
    );
    row.appendChild(chevron);
    row.addEventListener("click", (e) => {
      e.stopPropagation();
      const folderName =
        node.name.length > 30 ? node.name.slice(0, 28) + "..." : node.name;
      state.folderHistory.push({ name: folderName, id: node.id });
      state.currentFolderId = node.id;
      navigateToFolder(doc, node.id);
    });
  } else {
    row.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).closest("[data-dot-btn]")) return;
      openFilePreview(doc, node, provider);
    });

    const dotBtn = btn(
      doc,
      "\u22EE",
      "padding: 2px 6px; border-radius: 4px; border: none; background: transparent; color: var(--text-secondary); cursor: pointer; font-size: 16px; line-height: 1; flex-shrink: 0; opacity: 0; transition: opacity 0.2s;",
      (e) => {
        e.stopPropagation();
        showRowDropdown(doc, e.target as HTMLElement, node, provider);
      },
    );
    dotBtn.setAttribute("data-dot-btn", "");
    dotBtn.title = "More actions";
    row.appendChild(dotBtn);

    row.addEventListener("mouseenter", () => {
      dotBtn.style.opacity = "1";
    });
    row.addEventListener("mouseleave", () => {
      if (!dotBtn.hasAttribute("data-menu-open")) dotBtn.style.opacity = "0";
    });
  }

  return row;
}

function addFileToContext(
  doc: Document,
  node: FileNode,
  provider: CloudProvider,
): void {
  const chatId = getMessageStore().getConversationId();
  const contextData = {
    provider: provider.id,
    icon: provider.icon,
    driveFileId: node.id,
    mimeType: node.mimeType,
    name: node.name,
    lastKnownModifiedTime: node.modifiedTime,
    extractedContent: "",
  };
  const contextManager = ChatContextManager.getInstance();
  contextManager.addItem(
    contextData.driveFileId,
    "file" as ContextItemType,
    contextData.name,
    "toolbar",
    driveFileMetadata(contextData),
  );
  persistDriveContext(chatId, contextData);
}

async function importFileToWorkspace(
  doc: Document,
  node: FileNode,
  provider: CloudProvider,
): Promise<void> {
  try {
    if (isDocFile(node.name, node.mimeType)) {
      const statusBar = currentPaneRefs.statusBar;
      if (statusBar) {
        statusBar.textContent =
          "Legacy .doc format is not supported. Please convert to .docx using Word or LibreOffice first.";
        statusBar.style.color = "#ef5350";
        setTimeout(() => {
          if (statusBar) statusBar.style.color = "";
        }, 4000);
      }
      Zotero.debug("[seerai] Cannot import .doc — legacy format not supported");
      return;
    }
    const buffer = await provider.downloadFile(node.id);
    const bytes = new Uint8Array(buffer);
    let binary = "";
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    const base64 = btoa(binary);
    const store = getWorkspaceStore();
    await store.writeFile(
      node.name,
      base64,
      `Imported from ${provider.name}`,
      "user",
    );
    Zotero.debug(`[seerai] Imported ${node.name} to workspace`);
  } catch (e) {
    Zotero.debug(`[seerai] Import to workspace failed: ${e}`);
  }
}

async function convertAndImportDocx(
  doc: Document,
  node: FileNode,
  provider: CloudProvider,
): Promise<void> {
  const statusBar = currentPaneRefs.statusBar;
  try {
    const buffer = await provider.downloadFile(node.id);
    const { markdown, images, warnings } = await convertDocxToMarkdown(buffer);
    const baseName = node.name.replace(/\.docx$/i, "");
    const mdFileName = baseName + ".md";

    const store = getWorkspaceStore();
    await store.writeFile(
      mdFileName,
      markdown,
      `Converted from ${node.name} (${provider.name})`,
      "user",
    );

    for (const img of images) {
      const absPath = PathUtils.join(store.workspaceDir, img.path);
      const lastSlash = absPath.lastIndexOf("/");
      if (lastSlash > 0) {
        try {
          await IOUtils.makeDirectory(absPath.substring(0, lastSlash), {
            createAncestors: true,
          });
        } catch {
          // directory may already exist
        }
      }
      await IOUtils.write(absPath, img.bytes);
    }

    if (warnings.length > 0) {
      Zotero.debug(`[seerai] DOCX conversion warnings: ${warnings.join(", ")}`);
    }
    if (statusBar) {
      statusBar.textContent = `Converted "${node.name}" to "${mdFileName}" (+ ${images.length} images)`;
    }
    Zotero.debug(
      `[seerai] Converted ${node.name} to ${mdFileName} with ${images.length} images`,
    );
  } catch (e) {
    Zotero.debug(`[seerai] DOCX conversion failed: ${e}`);
    if (statusBar) {
      statusBar.textContent = `Failed to convert "${node.name}"`;
    }
  }
}

function showRowDropdown(
  doc: Document,
  anchor: HTMLElement,
  node: FileNode,
  provider: CloudProvider,
): void {
  anchor.setAttribute("data-menu-open", "");
  const backdrop = div(
    doc,
    "position: fixed; top: 0; left: 0; right: 0; bottom: 0; z-index: 9999;",
  );
  const menu = div(
    doc,
    "position: fixed; background: var(--background-primary); border: 1px solid var(--border-primary); border-radius: 6px; box-shadow: 0 4px 16px rgba(0,0,0,0.15); padding: 4px 0; z-index: 10000; min-width: 150px;",
  );

  const rect = anchor.getBoundingClientRect();
  menu.style.top = `${rect.bottom + 4}px`;
  menu.style.left = `${Math.max(4, rect.left)}px`;

  const isWord = isDocxFile(node.name, node.mimeType);
  const isEditable = provider.isTextExportable(node.mimeType) || isWord;

  const items: {
    label: string;
    icon: IconName;
    handler: () => void | Promise<void>;
    disabled?: boolean;
  }[] = [
    {
      label: "Preview",
      icon: "eye",
      handler: () => openFilePreview(doc, node, provider),
      disabled: !isEditable,
    },
    {
      label: "Edit",
      icon: "edit",
      handler: () => openFileEditor(doc, node, provider),
      disabled: !isEditable,
    },
    {
      label: "Download",
      icon: "download",
      handler: () => handleFileDownload(doc, node, provider),
    },
    {
      label: "Add to Context",
      icon: "pin",
      handler: () => addFileToContext(doc, node, provider),
    },
    ...(isDocxFile(node.name, node.mimeType)
      ? [
          {
            label: "Add to workspace as markdown",
            icon: "info" as IconName,
            handler: () => convertAndImportDocx(doc, node, provider),
          },
        ]
      : isDocFile(node.name, node.mimeType)
        ? [
            {
              label: "Legacy .doc — Not supported",
              icon: "warning" as IconName,
              handler: () => {},
              disabled: true,
            },
          ]
        : []),
    {
      label: "Add to workspace",
      icon: "folder" as IconName,
      handler: () => importFileToWorkspace(doc, node, provider),
    },
  ];

  for (const item of items) {
    const itemRow = div(
      doc,
      `display: flex; align-items: center; gap: 8px; padding: 6px 12px; cursor: ${item.disabled ? "not-allowed" : "pointer"}; font-size: 12px; color: ${item.disabled ? "var(--text-tertiary)" : "var(--text-primary)"}; transition: background 0.1s;`,
    );
    const iconSpan = span(
      doc,
      "font-size: 14px; flex-shrink: 0; display: inline-flex; align-items: center;",
    );
    iconSpan.appendChild(
      createSvgIcon(doc, item.icon, { size: 14, strokeWidth: 1.7 }),
    );
    itemRow.appendChild(iconSpan);
    const labelSpan = span(doc, "", item.label);
    itemRow.appendChild(labelSpan);
    if (item.disabled) {
      itemRow.style.opacity = "0.5";
    } else {
      itemRow.addEventListener("mouseenter", () => {
        itemRow.style.background = "var(--background-secondary)";
      });
      itemRow.addEventListener("mouseleave", () => {
        itemRow.style.background = "transparent";
      });
      itemRow.addEventListener("click", () => {
        cleanup();
        item.handler();
      });
    }
    menu.appendChild(itemRow);
  }

  function cleanup() {
    backdrop.remove();
    menu.remove();
    anchor.removeAttribute("data-menu-open");
  }

  backdrop.addEventListener("click", () => cleanup());
  const root = doc.body || doc.documentElement;
  if (!root) return;
  root.appendChild(backdrop);
  root.appendChild(menu);
}

async function openFilePreview(
  doc: Document,
  node: FileNode,
  provider: CloudProvider,
): Promise<void> {
  const existingIdx = editorTabs.findIndex(
    (t) => t.node.id === node.id && t.mode === "preview",
  );
  if (existingIdx >= 0) {
    activeEditorTabIndex = existingIdx;
    refreshEditorPanel(doc);
    return;
  }

  const tab = createEditorTab(doc, node, "preview");
  await loadTabContent(doc, tab, node, provider);
}

async function openFileEditor(
  doc: Document,
  node: FileNode,
  provider: CloudProvider,
): Promise<void> {
  const existingIdx = editorTabs.findIndex(
    (t) => t.node.id === node.id && t.mode === "edit",
  );
  if (existingIdx >= 0) {
    activeEditorTabIndex = existingIdx;
    refreshEditorPanel(doc);
    return;
  }

  const tab = createEditorTab(doc, node, "edit");
  await loadTabContent(doc, tab, node, provider);
}

function createEditorTab(
  doc: Document,
  node: FileNode,
  mode: "preview" | "edit",
): EditorFileTab {
  if (editorTabs.length >= MAX_EDITOR_TABS) {
    editorTabs.shift();
    if (activeEditorTabIndex >= editorTabs.length) {
      activeEditorTabIndex = Math.max(0, editorTabs.length - 1);
    }
  }

  const newTab: EditorFileTab = {
    node,
    content: "",
    isModified: false,
    mode,
  };
  editorTabs.push(newTab);
  activeEditorTabIndex = editorTabs.length - 1;
  refreshEditorPanel(doc);
  return newTab;
}

async function loadTabContent(
  doc: Document,
  tab: EditorFileTab,
  node: FileNode,
  provider: CloudProvider,
): Promise<void> {
  if (isDocFile(node.name, node.mimeType)) {
    showEditorLoading(doc);
    tab.content =
      "[Legacy .doc format is not supported. Please convert to .docx using Word or LibreOffice first.]";
    refreshEditorPanel(doc);
    return;
  }
  if (isDocxFile(node.name, node.mimeType)) {
    showEditorLoading(doc);
    try {
      const buffer = await provider.downloadFile(node.id);
      if (tab.mode === "preview") {
        await renderDocxPreviewInPanel(doc, buffer, node, provider);
      } else {
        const { markdown } = await convertDocxToMarkdown(buffer);
        tab.content = markdown;
        refreshEditorPanel(doc);
      }
    } catch (e: any) {
      tab.content = `[Error converting DOCX: ${e?.message || "Unknown error"}]`;
      refreshEditorPanel(doc);
    }
    return;
  }

  if (provider.isTextExportable(node.mimeType)) {
    showEditorLoading(doc);
    try {
      const result = await provider.getFileTextContent(node);
      if (result) {
        tab.content = stripBase64Data(result.content);
      } else {
        tab.content = "";
      }
      refreshEditorPanel(doc);
    } catch (e: any) {
      tab.content = `[Error loading file: ${e?.message || "Unknown error"}]`;
      refreshEditorPanel(doc);
    }
  } else {
    renderPreviewableBinary(doc, node, provider);
  }
}

async function handleFileDownload(
  doc: Document,
  node: FileNode,
  provider: CloudProvider,
): Promise<void> {
  try {
    const win = Zotero.getMainWindow() as any;
    const fp = new win.FilePicker();
    fp.init(win, `Download ${node.name}`, fp.modeSave);
    fp.defaultString = node.name;

    const ext = node.name.split(".").pop()?.toLowerCase() || "";
    if (ext) {
      fp.appendFilter(`*.${ext}`, `*.${ext}`);
    }
    fp.appendFilter("All Files", "*.*");

    const res = await fp.show();
    if (res !== fp.returnOK && res !== fp.returnReplace) return;

    const buffer = await provider.downloadFile(node.id);
    await IOUtils.write(fp.file, new Uint8Array(buffer));
    Zotero.debug(`[seerai] Cloud: downloaded ${node.name}`);
  } catch (err) {
    Zotero.debug(`[seerai] Cloud: download error: ${err}`);
  }
}

function showEditorLoading(doc: Document): void {
  const contentArea = currentPaneRefs.editorContent;
  if (contentArea) {
    contentArea.innerHTML = "";
    contentArea.appendChild(
      div(
        doc,
        "padding: 40px; text-align: center; color: var(--text-tertiary); font-size: 12px; font-style: italic;",
        "Loading file content...",
      ),
    );
  }
}

async function renderPreviewableBinary(
  doc: Document,
  node: FileNode,
  provider: CloudProvider,
): Promise<void> {
  const mime = node.mimeType;
  if (mime.startsWith("image/")) {
    await renderImagePreview(doc, node, provider);
    return;
  }
  renderUnsupportedFile(doc, node, provider);
}

async function renderImagePreview(
  doc: Document,
  node: FileNode,
  provider: CloudProvider,
): Promise<void> {
  const contentArea = currentPaneRefs.editorContent;
  const toolbar = currentPaneRefs.editorToolbar;
  if (!contentArea || !toolbar) return;

  contentArea.innerHTML = "";
  toolbar.innerHTML = "";

  const loading = div(
    doc,
    "display: flex; align-items: center; justify-content: center; height: 100%; color: var(--text-tertiary); font-size: 12px; font-style: italic;",
    "Loading preview...",
  );
  contentArea.appendChild(loading);

  try {
    const buffer = await provider.downloadFile(node.id);
    const bytes = new Uint8Array(buffer);
    let binary = "";
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    const base64 = btoa(binary);
    const dataUrl = `data:${node.mimeType};base64,${base64}`;

    contentArea.innerHTML = "";
    const wrapper = div(
      doc,
      "display: flex; align-items: center; justify-content: center; height: 100%; overflow: auto; padding: 12px;",
    );
    const img = doc.createElementNS(HTML_NS, "img") as HTMLImageElement;
    img.src = dataUrl;
    Object.assign(img.style, {
      maxWidth: "100%",
      maxHeight: "100%",
      objectFit: "contain",
      borderRadius: "6px",
    });
    img.alt = node.name;
    wrapper.appendChild(img);
    contentArea.appendChild(wrapper);

    const addCtxBtn = btn(
      doc,
      "+Ctx",
      "padding: 2px 6px; margin-left: auto; border-radius: 4px; border: 1px solid var(--border-primary); background: transparent; color: var(--text-secondary); cursor: pointer; font-size: 10px; line-height: 1.3;",
      async (e) => {
        const btnEl = e.target as HTMLButtonElement;
        btnEl.disabled = true;
        try {
          const chatId = getMessageStore().getConversationId();
          const contextManager = ChatContextManager.getInstance();
          contextManager.addItem(
            node.id,
            "file" as ContextItemType,
            node.name,
            "toolbar",
            driveFileMetadata({
              provider: provider.id,
              icon: provider.icon,
              driveFileId: node.id,
              mimeType: node.mimeType,
              name: node.name,
              lastKnownModifiedTime: node.modifiedTime,
              extractedContent: `[Image: ${node.name}]`,
            }),
          );
          persistDriveContext(chatId, {
            provider: provider.id,
            icon: provider.icon,
            driveFileId: node.id,
            mimeType: node.mimeType,
            name: node.name,
            lastKnownModifiedTime: node.modifiedTime,
            extractedContent: `[Image: ${node.name}]`,
          });
          btnEl.textContent = "Done";
          btnEl.style.color = "#188038";
          btnEl.style.borderColor = "#188038";
        } catch (err) {
          btnEl.textContent = "!";
          btnEl.style.color = "#d93025";
        }
        setTimeout(() => {
          btnEl.disabled = false;
          btnEl.textContent = "+Ctx";
          btnEl.style.color = "var(--text-secondary)";
          btnEl.style.borderColor = "var(--border-primary)";
        }, 2000);
      },
    );
    toolbar.appendChild(addCtxBtn);

    if (currentPaneRefs.statusBar) {
      currentPaneRefs.statusBar.textContent = `${node.name} \u00B7 Image preview`;
    }
  } catch (err) {
    contentArea.innerHTML = "";
    renderUnsupportedFile(doc, node, provider);
  }
}

async function renderDocxPreviewInPanel(
  doc: Document,
  buffer: ArrayBuffer,
  node: FileNode,
  provider: CloudProvider,
): Promise<void> {
  const contentArea = currentPaneRefs.editorContent;
  const toolbar = currentPaneRefs.editorToolbar;
  const statusBar = currentPaneRefs.statusBar;
  if (!contentArea || !toolbar) return;

  contentArea.innerHTML = "";
  toolbar.innerHTML = "";
  contentArea.style.overflow = "auto";

  try {
    await renderDocxPreview(buffer, contentArea);
    if (statusBar) {
      statusBar.textContent = `${node.name} \u00B7 DOCX preview`;
    }
  } catch {
    contentArea.innerHTML =
      '<div style="padding: 20px; color: var(--text-tertiary);">Failed to render DOCX preview</div>';
  }

  const addCtxBtn = btn(
    doc,
    "+Ctx",
    "padding: 2px 6px; margin-left: auto; border-radius: 4px; border: 1px solid var(--border-primary); background: transparent; color: var(--text-secondary); cursor: pointer; font-size: 10px; line-height: 1.3;",
    async (e) => {
      const btnEl = e.target as HTMLButtonElement;
      btnEl.disabled = true;
      try {
        const chatId = getMessageStore().getConversationId();
        const contextManager = ChatContextManager.getInstance();
        contextManager.addItem(
          node.id,
          "file" as ContextItemType,
          node.name,
          "toolbar",
          driveFileMetadata({
            provider: provider.id,
            icon: provider.icon,
            driveFileId: node.id,
            mimeType: node.mimeType,
            name: node.name,
            lastKnownModifiedTime: node.modifiedTime,
            extractedContent: `[DOCX: ${node.name}]`,
          }),
        );
        persistDriveContext(chatId, {
          provider: provider.id,
          icon: provider.icon,
          driveFileId: node.id,
          mimeType: node.mimeType,
          name: node.name,
          lastKnownModifiedTime: node.modifiedTime,
          extractedContent: `[DOCX: ${node.name}]`,
        });
        btnEl.textContent = "Done";
        btnEl.style.color = "#188038";
      } finally {
        setTimeout(() => {
          btnEl.disabled = false;
          btnEl.textContent = "+Ctx";
          btnEl.style.color = "var(--text-secondary)";
        }, 2000);
      }
    },
  );
  toolbar.appendChild(addCtxBtn);
}

function renderUnsupportedFile(
  doc: Document,
  node: FileNode,
  provider: CloudProvider,
): void {
  const contentArea = currentPaneRefs.editorContent;
  const toolbar = currentPaneRefs.editorToolbar;
  const statusBar = currentPaneRefs.statusBar;
  if (!contentArea || !toolbar) return;

  contentArea.innerHTML = "";
  toolbar.innerHTML = "";

  const card = div(
    doc,
    "display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100%; padding: 32px; text-align: center;",
  );

  const icon = div(
    doc,
    "font-size: 48px; margin-bottom: 16px; display: flex; align-items: center; justify-content: center;",
  );
  icon.appendChild(
    createSvgIcon(doc, getFileIcon(node.mimeType, false), {
      size: 40,
      strokeWidth: 1.6,
    }),
  );
  card.appendChild(icon);

  const nameEl = div(
    doc,
    "font-weight: 700; font-size: 14px; color: var(--text-primary); margin-bottom: 8px;",
    node.name,
  );
  card.appendChild(nameEl);

  const meta = div(
    doc,
    "font-size: 11px; color: var(--text-tertiary); margin-bottom: 20px; line-height: 1.5;",
  );
  meta.innerHTML = `
    Type: ${node.mimeType || "Unknown"}<br/>
    Modified: ${formatDate(node.modifiedTime)}<br/>
    This file type cannot be previewed in-editor.
  `;
  card.appendChild(meta);

  const btnRow = div(doc, "display: flex; gap: 8px;");

  const importBtn = btn(
    doc,
    "Import to workspace",
    "padding: 10px 20px; border-radius: 8px; border: none; font-weight: 600; cursor: pointer; font-size: 13px; transition: filter 0.2s; background: var(--highlight-primary); color: #fff;",
    async (e) => {
      const btn = e.target as HTMLButtonElement;
      btn.disabled = true;
      const origText = btn.textContent;
      btn.textContent = "Downloading...";
      try {
        const buffer = await provider.downloadFile(node.id);
        const bytes = new Uint8Array(buffer);
        let binary = "";
        for (let i = 0; i < bytes.length; i++) {
          binary += String.fromCharCode(bytes[i]);
        }
        const base64 = btoa(binary);
        const store = getWorkspaceStore();
        await store.writeFile(
          node.name,
          base64,
          `Imported from ${provider.name}`,
          "user",
        );
        btn.textContent = "Imported to workspace";
        btn.style.background = "#188038";
        if (statusBar) {
          statusBar.textContent = `Imported "${node.name}" to workspace`;
        }
      } catch (err: any) {
        btn.textContent = "Failed";
        btn.style.background = "#d93025";
        Zotero.debug(`[seerai] Cloud: download & import error: ${err}`);
      }
      setTimeout(() => {
        btn.disabled = false;
        btn.textContent = origText;
        btn.style.background = "var(--highlight-primary)";
      }, 3000);
    },
  );
  importBtn.addEventListener("mouseenter", () => {
    importBtn.style.filter = "brightness(0.9)";
  });
  importBtn.addEventListener("mouseleave", () => {
    importBtn.style.filter = "none";
  });
  btnRow.appendChild(importBtn);

  const dlBtn = btn(
    doc,
    "Download to Disk",
    "padding: 10px 20px; border-radius: 8px; border: 1px solid var(--border-primary); background: transparent; color: var(--text-secondary); font-weight: 600; cursor: pointer; font-size: 13px; transition: all 0.2s;",
    async (e) => {
      const btn = e.target as HTMLButtonElement;
      btn.disabled = true;
      btn.textContent = "Downloading...";
      try {
        const buffer = await provider.downloadFile(node.id);

        const win = Zotero.getMainWindow() as any;
        const fp = new win.FilePicker();
        fp.init(win, `Download ${node.name}`, fp.modeSave);
        fp.defaultString = node.name;
        const ext = node.name.split(".").pop()?.toLowerCase() || "";
        if (ext) {
          fp.appendFilter(`*.${ext}`, `*.${ext}`);
        }
        fp.appendFilter("All Files", "*.*");
        const res = await fp.show();
        if (res !== fp.returnOK && res !== fp.returnReplace) {
          btn.disabled = false;
          btn.textContent = "Download to Disk";
          return;
        }

        await IOUtils.write(fp.file, new Uint8Array(buffer));
        btn.textContent = "Downloaded";
        btn.style.borderColor = "#188038";
        btn.style.color = "#188038";
      } catch (err: any) {
        btn.textContent = "Failed";
        btn.style.color = "#d93025";
        btn.style.borderColor = "#d93025";
        Zotero.debug(`[seerai] Cloud: download error: ${err}`);
      }
      setTimeout(() => {
        btn.disabled = false;
        btn.textContent = "Download to Disk";
        btn.style.color = "var(--text-secondary)";
        btn.style.borderColor = "var(--border-primary)";
      }, 3000);
    },
  );
  dlBtn.addEventListener("mouseenter", () => {
    dlBtn.style.background = "var(--background-secondary)";
  });
  dlBtn.addEventListener("mouseleave", () => {
    dlBtn.style.background = "transparent";
  });
  btnRow.appendChild(dlBtn);

  card.appendChild(btnRow);
  contentArea.appendChild(card);
}

function refreshEditorPanel(doc: Document): void {
  const caption = currentPaneRefs.editorCaption;
  const contentArea = currentPaneRefs.editorContent;
  const toolbar = currentPaneRefs.editorToolbar;
  if (!caption || !contentArea || !toolbar) return;

  caption.innerHTML = "";
  contentArea.innerHTML = "";
  toolbar.innerHTML = "";

  if (editorTabs.length === 0 || activeEditorTabIndex < 0) {
    const empty = div(
      doc,
      "display: flex; align-items: center; justify-content: center; height: 100%; color: var(--text-tertiary); font-size: 13px; font-style: italic;",
      "Select a file to view",
    );
    contentArea.appendChild(empty);
    return;
  }

  for (let i = 0; i < editorTabs.length; i++) {
    const tab = editorTabs[i];
    const tabEl = div(
      doc,
      "display: flex; align-items: center; gap: 4px; padding: 4px 10px; border-radius: 4px; cursor: pointer; font-size: 11px; white-space: nowrap; user-select: none; transition: all 0.15s;",
    );
    const isActive = i === activeEditorTabIndex;
    if (isActive) {
      tabEl.style.background = "var(--background-primary)";
      tabEl.style.color = "var(--text-primary)";
      tabEl.style.fontWeight = "600";
    } else {
      tabEl.style.color = "var(--text-secondary)";
      tabEl.style.background = "transparent";
    }

    const tabIcon = span(
      doc,
      "font-size: 12px;",
      tab.mode === "preview" ? "\uD83D\uDC41\uFE0F" : "\u270F\uFE0F",
    );
    tabEl.appendChild(tabIcon);

    const tabName = span(
      doc,
      "max-width: 96px; overflow: hidden; text-overflow: ellipsis;",
      tab.node.name,
    );
    tabEl.appendChild(tabName);

    if (tab.isModified) {
      const modDot = span(
        doc,
        "font-size: 8px; color: var(--highlight-primary); flex-shrink: 0;",
        "\u25CF",
      );
      tabEl.appendChild(modDot);
    }

    const closeBtn = span(
      doc,
      "font-size: 14px; cursor: pointer; padding: 0 2px; border-radius: 2px; opacity: 0.5;",
      "\u00D7",
    );
    closeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      editorTabs.splice(i, 1);
      if (activeEditorTabIndex >= editorTabs.length) {
        activeEditorTabIndex = Math.max(0, editorTabs.length - 1);
      }
      refreshEditorPanel(doc);
    });
    closeBtn.addEventListener("mouseenter", () => {
      closeBtn.style.opacity = "1";
      closeBtn.style.background = "var(--background-primary)";
    });
    closeBtn.addEventListener("mouseleave", () => {
      closeBtn.style.opacity = "0.5";
      closeBtn.style.background = "transparent";
    });
    tabEl.appendChild(closeBtn);

    tabEl.addEventListener("click", () => {
      activeEditorTabIndex = i;
      refreshEditorPanel(doc);
    });
    caption.appendChild(tabEl);
  }

  const activeTab = editorTabs[activeEditorTabIndex];
  if (!activeTab) return;

  renderEditorContent(doc, activeTab);
}

function renderEditorContent(doc: Document, tab: EditorFileTab): void {
  const contentArea = currentPaneRefs.editorContent;
  const toolbar = currentPaneRefs.editorToolbar;
  if (!contentArea || !toolbar) return;

  contentArea.innerHTML = "";
  toolbar.innerHTML = "";

  const ext = getFileExtension(tab.node.mimeType, tab.node.name);
  const canPreview = isRenderableExtension(ext);
  const lang = inferLanguage(tab.node.name);

  if (tab.mode === "preview") {
    if (canPreview) {
      const renderType = getRenderType(ext);
      if (renderType === "image") {
        contentArea.appendChild(
          div(
            doc,
            "display: flex; align-items: center; justify-content: center; height: 100%; color: var(--text-tertiary); font-style: italic; font-size: 13px; padding: 20px;",
            "Binary image preview not available for cloud files.",
          ),
        );
      } else {
        contentArea.appendChild(
          createPreviewElement(doc, tab.content, renderType),
        );
      }
    } else {
      const pre = doc.createElementNS(HTML_NS, "pre") as HTMLPreElement;
      pre.style.cssText = `
        margin: 0;
        padding: 12px;
        font-family: "Menlo", "Monaco", "Consolas", monospace;
        font-size: 12px;
        line-height: 1.6;
        tab-size: 2;
        color: var(--text-primary);
        white-space: pre-wrap;
        word-break: break-word;
        overflow: auto;
        min-height: 100%;
        box-sizing: border-box;
      `;
      if (lang !== "text") {
        pre.innerHTML = highlightCode(tab.content, lang);
      } else {
        pre.textContent = tab.content;
      }
      contentArea.appendChild(pre);
    }
    renderEditorToolbar(doc, tab);
    return;
  }

  const textarea = doc.createElementNS(
    HTML_NS,
    "textarea",
  ) as HTMLTextAreaElement;
  textarea.value = tab.content;
  textarea.spellcheck = false;
  textarea.style.cssText = `
    width: 100%;
    height: 100%;
    padding: 12px;
    border: none;
    outline: none;
    resize: none;
    font-family: "Menlo", "Monaco", "Consolas", monospace;
    font-size: 12px;
    line-height: 1.6;
    tab-size: 2;
    color: var(--text-primary);
    background: var(--background-primary);
    box-sizing: border-box;
    overflow: auto;
  `;
  textarea.addEventListener("input", () => {
    tab.content = textarea.value;
    tab.isModified = true;
    refreshEditorToolbar(doc, tab, true);
  });
  contentArea.appendChild(textarea);
  textarea.focus();

  renderEditorToolbar(doc, tab);
}

function renderEditorToolbar(doc: Document, tab: EditorFileTab): void {
  const toolbar = currentPaneRefs.editorToolbar;
  if (!toolbar) return;

  const lang = inferLanguage(tab.node.name);

  if (tab.mode === "edit") {
    const saveBtn = btn(
      doc,
      "Save",
      "padding: 4px 12px; border-radius: 4px; border: none; background: var(--highlight-primary); color: #fff; cursor: pointer; font-size: 11px; transition: filter 0.2s;",
      async () => {
        saveBtn.disabled = true;
        saveBtn.textContent = "Uploading...";
        try {
          if (state.currentProvider) {
            await state.currentProvider.uploadFile(
              tab.node.id,
              tab.content,
              tab.node.mimeType,
            );
          }
          tab.isModified = false;
          saveBtn.textContent = "Saved to cloud";
          saveBtn.style.background = "#188038";
          refreshEditorToolbar(doc, tab, false);
        } catch (err: any) {
          saveBtn.textContent = "Failed";
          saveBtn.style.background = "#d93025";
          Zotero.debug(`[seerai] Cloud: save error: ${err}`);
        }
        setTimeout(() => {
          saveBtn.disabled = false;
          saveBtn.textContent = "Save";
          saveBtn.style.background = "var(--highlight-primary)";
        }, 2000);
      },
    );
    saveBtn.addEventListener("mouseenter", () => {
      saveBtn.style.filter = "brightness(0.9)";
    });
    saveBtn.addEventListener("mouseleave", () => {
      saveBtn.style.filter = "none";
    });
    toolbar.appendChild(saveBtn);

    const langLabel = span(
      doc,
      "padding: 4px 8px; font-size: 10px; color: var(--text-tertiary);",
    );
    langLabel.setAttribute("data-lang-label", "");
    if (lang !== "text") {
      langLabel.textContent = lang;
    }
    toolbar.appendChild(langLabel);
  } else {
    const switchBtn = btn(
      doc,
      "\u270F\uFE0F Edit",
      "padding: 2px 8px; border-radius: 4px; border: 1px solid var(--border-primary); background: transparent; color: var(--text-secondary); cursor: pointer; font-size: 10px; line-height: 1.3;",
      () => {
        tab.mode = "edit";
        refreshEditorPanel(doc);
      },
    );
    switchBtn.title = "Switch to edit mode";
    toolbar.appendChild(switchBtn);

    const langLabel = span(
      doc,
      "padding: 4px 8px; font-size: 10px; color: var(--text-tertiary); flex: 1;",
    );
    langLabel.setAttribute("data-lang-label", "");
    if (lang !== "text") {
      langLabel.textContent = lang;
    }
    toolbar.appendChild(langLabel);
  }

  const addContextBtn = btn(
    doc,
    "+Ctx",
    "padding: 2px 6px; margin-left: auto; border-radius: 4px; border: 1px solid var(--border-primary); background: transparent; color: var(--text-secondary); cursor: pointer; font-size: 10px; line-height: 1.3; transition: all 0.15s;",
    async (e) => {
      const btnEl = e.target as HTMLButtonElement;
      btnEl.disabled = true;
      try {
        const chatId = getMessageStore().getConversationId();
        const contextData = {
          provider: state.currentProvider!.id,
          icon: state.currentProvider!.icon,
          driveFileId: tab.node.id,
          mimeType: tab.node.mimeType,
          name: tab.node.name,
          lastKnownModifiedTime: tab.node.modifiedTime,
          extractedContent: stripBase64Data(tab.content),
        };
        const contextManager = ChatContextManager.getInstance();
        contextManager.addItem(
          contextData.driveFileId,
          "file" as ContextItemType,
          contextData.name,
          "toolbar",
          driveFileMetadata(contextData),
        );
        persistDriveContext(chatId, contextData);
        btnEl.textContent = "Done";
        btnEl.style.color = "#188038";
        btnEl.style.borderColor = "#188038";
      } catch (err) {
        Zotero.debug(`[seerai] Cloud: add context error: ${err}`);
        btnEl.textContent = "!";
        btnEl.style.color = "#d93025";
      }
      setTimeout(() => {
        btnEl.disabled = false;
        btnEl.textContent = "+Ctx";
        btnEl.style.color = "var(--text-secondary)";
        btnEl.style.borderColor = "var(--border-primary)";
      }, 2000);
    },
  );
  addContextBtn.addEventListener("mouseenter", () => {
    addContextBtn.style.background = "var(--background-secondary)";
  });
  addContextBtn.addEventListener("mouseleave", () => {
    addContextBtn.style.background = "transparent";
  });
  toolbar.appendChild(addContextBtn);
}

function refreshEditorToolbar(
  _doc: Document,
  tab: EditorFileTab,
  _isEditMode: boolean,
): void {
  const toolbar = currentPaneRefs.editorToolbar;
  if (!toolbar) return;

  const langLabel = toolbar.querySelector("[data-lang-label]");
  if (langLabel) {
    const lang = inferLanguage(tab.node.name);
    langLabel.textContent = lang !== "text" ? lang : "";
  }
}

function createResizeHandle(
  doc: Document,
  leftPanel: HTMLElement,
  splitContainer: HTMLElement,
): HTMLElement {
  const handle = doc.createElementNS(HTML_NS, "div") as HTMLElement;
  handle.style.cssText = `
    width: 4px;
    cursor: col-resize;
    background: var(--border-primary);
    flex-shrink: 0;
    transition: background 0.2s;
  `;

  handle.addEventListener("mouseenter", () => {
    handle.style.background = "var(--highlight-primary)";
  });
  handle.addEventListener("mouseleave", () => {
    handle.style.background = "var(--border-primary)";
  });

  handle.addEventListener("mousedown", (ev) => {
    const e = ev as MouseEvent;
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = leftPanel.getBoundingClientRect().width;
    const containerWidth = splitContainer.getBoundingClientRect().width - 4;

    const onMouseMove = (ev: MouseEvent) => {
      const delta = ev.clientX - startX;
      const newWidth = startWidth + delta;
      const clamped = Math.max(
        MIN_LEFT_WIDTH,
        Math.min(newWidth, containerWidth - MIN_RIGHT_WIDTH),
      );
      leftPanel.style.width = clamped + "px";
      leftPanel.style.flex = "none";
    };

    const onMouseUp = () => {
      doc.removeEventListener("mousemove", onMouseMove);
      doc.removeEventListener("mouseup", onMouseUp);
      if (doc.body) {
        doc.body.style.cursor = "";
        doc.body.style.userSelect = "";
      }
    };

    if (doc.body) {
      doc.body.style.cursor = "col-resize";
      doc.body.style.userSelect = "none";
    }
    doc.addEventListener("mousemove", onMouseMove);
    doc.addEventListener("mouseup", onMouseUp);
  });

  return handle;
}
