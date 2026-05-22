import { CloudProviderManager } from "./providerManager";
import {
  FileNode,
  CloudProviderId,
  DriveContextData,
  getRedirectUri,
} from "./types";
import { ChatContextManager } from "../chat/context/contextManager";
import { ContextItemType } from "../chat/context/contextTypes";
import { getWorkspaceStore } from "../chat/workspace/store";
import { stripBase64Data } from "../chat/imageUtils";
import { persistDriveContext, driveFileMetadata } from "./cloudContext";
import { extractCodeFromUrl } from "./pkce";
import { CloudProvider } from "./providers/base";
import { config } from "../../../package.json";

const HTML_NS = "http://www.w3.org/1999/xhtml";
const DRIVE_POPOVER_ID = "seerai-drive-popover";
const MANAGER = CloudProviderManager.getInstance();
const P = config.prefsPrefix;

const COLORS = {
  primary: "var(--color-primary, #4285F4)",
  text: "var(--text-primary, #1a1a1a)",
  textSecondary: "var(--text-secondary, #5f6368)",
  border: "var(--border-primary, #dadce0)",
  bg: "var(--background-primary, #ffffff)",
  bgSecondary: "var(--background-secondary, #f8f9fa)",
  error: "#d93025",
  success: "#188038",
};

const STYLES = {
  container: `
    position: fixed;
    width: 380px;
    max-height: 520px;
    min-height: 240px;
    background: ${COLORS.bg};
    border: 1px solid ${COLORS.border};
    border-radius: 12px;
    box-shadow: 0 8px 24px rgba(0,0,0,0.12);
    display: flex;
    flex-direction: column;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    font-size: 13px;
    color: ${COLORS.text};
    z-index: 200000;
    overflow: hidden;
  `,
  header: `
    padding: 12px 16px;
    display: flex;
    align-items: center;
    border-bottom: 1px solid ${COLORS.border};
    background: ${COLORS.bgSecondary};
    height: 48px;
    box-sizing: border-box;
  `,
  content: `
    flex: 1;
    overflow-y: auto;
    padding: 16px;
    background: ${COLORS.bg};
  `,
  row: `
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 12px;
    border-radius: 8px;
    cursor: pointer;
    transition: background 0.2s;
    margin-bottom: 4px;
    border: 1px solid transparent;
  `,
  button: `
    padding: 8px 16px;
    border-radius: 6px;
    border: none;
    font-weight: 600;
    cursor: pointer;
    font-size: 13px;
    transition: filter 0.2s, background 0.2s;
    display: inline-flex;
    align-items: center;
    justify-content: center;
  `,
  input: `
    width: 100%;
    padding: 10px 12px;
    border: 1px solid ${COLORS.border};
    border-radius: 6px;
    background: ${COLORS.bgSecondary};
    color: ${COLORS.text};
    font-size: 13px;
    box-sizing: border-box;
    margin-bottom: 12px;
    outline: none;
  `,
};

const OAUTH_SETUP_CONFIGS: Record<
  string,
  {
    consoleUrl: string;
    consoleLabel: string;
    redirectUri: string;
    fields: { id: string; label: string; type: string; prefKey: string }[];
  }
> = {
  google: {
    consoleUrl: "https://console.cloud.google.com/apis/credentials",
    consoleLabel: "Google Cloud Console",
    redirectUri: getRedirectUri("google"),
    fields: [
      {
        id: "clientId",
        label: "Client ID",
        type: "text",
        prefKey: `${P}.driveClientId`,
      },
      {
        id: "clientSecret",
        label: "Client Secret",
        type: "password",
        prefKey: `${P}.driveClientSecret`,
      },
    ],
  },
  dropbox: {
    consoleUrl: "https://www.dropbox.com/developers/apps",
    consoleLabel: "Dropbox App Console",
    redirectUri: getRedirectUri("dropbox"),
    fields: [
      {
        id: "clientId",
        label: "App Key (Client ID)",
        type: "text",
        prefKey: `${P}.cloud.dropbox.clientId`,
      },
    ],
  },
  box: {
    consoleUrl: "https://app.box.com/developers/console",
    consoleLabel: "Box Developer Console",
    redirectUri: getRedirectUri("box"),
    fields: [
      {
        id: "clientId",
        label: "Client ID",
        type: "text",
        prefKey: `${P}.cloud.box.clientId`,
      },
      {
        id: "clientSecret",
        label: "Client Secret",
        type: "password",
        prefKey: `${P}.cloud.box.clientSecret`,
      },
    ],
  },
  onedrive: {
    consoleUrl:
      "https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade",
    consoleLabel: "Azure App Registrations",
    redirectUri: getRedirectUri("onedrive"),
    fields: [
      {
        id: "clientId",
        label: "Application (client) ID",
        type: "text",
        prefKey: `${P}.cloud.onedrive.clientId`,
      },
    ],
  },
};

const CRED_PREFS: Record<string, string[]> = {};
for (const [id, cfg] of Object.entries(OAUTH_SETUP_CONFIGS)) {
  CRED_PREFS[id] = cfg.fields.map((f) => f.prefKey);
}

function hasOAuthCreds(providerId: string): boolean {
  const keys = CRED_PREFS[providerId];
  if (!keys) return true;
  return keys.every((k) => !!Zotero.Prefs.get(k));
}

// UI Helpers
function el(
  doc: Document,
  tag: string,
  style?: string,
  text?: string,
): HTMLElement {
  const e = doc.createElementNS(HTML_NS, tag) as HTMLElement;
  if (style) e.style.cssText = style.replace(/\n\s*/g, " ");
  if (text) e.textContent = text;
  return e;
}

function div(doc: Document, style?: string, text?: string): HTMLElement {
  return el(doc, "div", style, text);
}

function span(doc: Document, style?: string, text?: string): HTMLElement {
  return el(doc, "span", style, text);
}

function btn(
  doc: Document,
  text: string,
  color: string,
  handler: (e: Event) => void,
  secondary = false,
): HTMLButtonElement {
  const style = `${STYLES.button} background: ${secondary ? "transparent" : color}; color: ${secondary ? COLORS.textSecondary : "#fff"}; border: ${secondary ? `1px solid ${COLORS.border}` : "none"};`;
  const b = el(doc, "button", style, text) as HTMLButtonElement;
  b.addEventListener("click", handler);
  b.addEventListener("mouseenter", () => (b.style.filter = "brightness(0.9)"));
  b.addEventListener("mouseleave", () => (b.style.filter = "none"));
  return b;
}

function backBtn(doc: Document, handler: () => void): HTMLElement {
  const b = div(
    doc,
    "cursor: pointer; display: flex; align-items: center; justify-content: center; width: 32px; height: 32px; border-radius: 50%; margin-right: 8px; transition: background 0.2s;",
  );
  b.textContent = "←";
  b.style.fontSize = "18px";
  b.style.fontWeight = "bold";
  b.addEventListener("click", (e) => {
    e.stopPropagation();
    handler();
  });
  b.addEventListener(
    "mouseenter",
    () => (b.style.background = COLORS.bgSecondary),
  );
  b.addEventListener("mouseleave", () => (b.style.background = "transparent"));
  return b;
}

export async function showDriveModal(
  doc: Document,
  anchorEl: HTMLElement,
  chatId: string,
): Promise<void> {
  const existing = doc.getElementById(DRIVE_POPOVER_ID);
  if (existing) {
    existing.remove();
    return;
  }

  const container = el(doc, "div", STYLES.container);
  container.id = DRIVE_POPOVER_ID;

  const rect = anchorEl.getBoundingClientRect();
  const win = doc.defaultView;
  if (!win) return;

  Object.assign(container.style, {
    bottom: `${win.innerHeight - rect.top + 8}px`,
    left: `${rect.left}px`,
  });

  const mountPoint = doc.body || doc.documentElement;
  if (!mountPoint) return;
  mountPoint.appendChild(container);

  const safeRender = async (fn: () => Promise<void> | void) => {
    try {
      await fn();
    } catch (e: any) {
      renderError(container, doc, e);
    }
  };

  const render = () =>
    safeRender(async () => {
      const loggedIn = MANAGER.getLoggedIn();
      if (loggedIn.length === 0) {
        renderConnectView(container, doc, chatId);
      } else {
        await renderMainView(container, doc, chatId, loggedIn, loggedIn[0].id);
      }
    });

  await render();

  const closeHandler = (e: MouseEvent) => {
    if (
      !container.contains(e.target as Node) &&
      !anchorEl.contains(e.target as Node)
    ) {
      container.remove();
      doc.removeEventListener("mousedown", closeHandler);
    }
  };
  setTimeout(() => doc.addEventListener("mousedown", closeHandler), 0);
}

function renderError(container: HTMLElement, doc: Document, error: any): void {
  Zotero.debug(`[seerai] Drive UI Error: ${error} ${error?.stack}`);
  container.innerHTML = "";
  const inner = div(
    doc,
    "padding: 24px; text-align: center; display: flex; flex-direction: column; align-items: center;",
  );
  inner.appendChild(div(doc, "font-size: 40px; margin-bottom: 16px;", "⚠️"));
  inner.appendChild(
    div(
      doc,
      "font-weight: 700; font-size: 16px; margin-bottom: 8px;",
      "UI Error Occurred",
    ),
  );

  const msg = div(
    doc,
    `color: ${COLORS.error}; font-size: 12px; margin-bottom: 20px; background: #fff1f0; padding: 12px; border-radius: 8px; border: 1px solid #ffa39e; width: 100%; box-sizing: border-box; white-space: pre-wrap; word-break: break-all; text-align: left;`,
  );
  msg.textContent = `${error?.message || String(error)}\n\n${error?.stack || ""}`;
  inner.appendChild(msg);

  inner.appendChild(
    btn(doc, "Back to List", COLORS.primary, () =>
      renderConnectView(container, doc, chatId_global || ""),
    ),
  );
  container.appendChild(inner);
}

// Global for error recovery navigation
let chatId_global: string | null = null;

function renderConnectView(
  container: HTMLElement,
  doc: Document,
  chatId: string,
): void {
  chatId_global = chatId;
  container.innerHTML = "";

  const loggedIn = MANAGER.getLoggedIn();
  const header = div(doc, STYLES.header);

  if (loggedIn.length > 0) {
    header.appendChild(
      backBtn(doc, () =>
        renderMainView(container, doc, chatId, loggedIn, loggedIn[0].id),
      ),
    );
  }

  header.appendChild(
    div(doc, "font-weight: 700; font-size: 15px; flex: 1;", "Cloud Storage"),
  );
  container.appendChild(header);

  const content = div(doc, STYLES.content);
  content.appendChild(
    div(
      doc,
      `color: ${COLORS.textSecondary}; font-size: 12px; margin-bottom: 20px;`,
      "Select a provider to connect:",
    ),
  );

  for (const provider of MANAGER.getAll()) {
    const isConnected = loggedIn.some((p) => p.id === provider.id);
    const row = div(doc, STYLES.row);
    row.addEventListener(
      "mouseenter",
      () => (row.style.background = COLORS.bgSecondary),
    );
    row.addEventListener(
      "mouseleave",
      () => (row.style.background = "transparent"),
    );
    row.addEventListener("click", () =>
      startConnection(container, doc, chatId, provider),
    );

    const icon = span(
      doc,
      "font-size: 24px; width: 36px; text-align: center;",
      provider.icon,
    );
    const info = div(doc, "flex: 1;");
    info.appendChild(div(doc, "font-weight: 600;", provider.name));

    const subText = isConnected
      ? "Already connected"
      : `Connect to ${provider.name}`;
    info.appendChild(
      div(
        doc,
        `font-size: 11px; color: ${isConnected ? COLORS.success : COLORS.textSecondary};`,
        subText,
      ),
    );

    const arrow = span(
      doc,
      `color: ${COLORS.textSecondary}; font-size: 16px;`,
      isConnected ? "✓" : "→",
    );

    row.appendChild(icon);
    row.appendChild(info);
    row.appendChild(arrow);
    content.appendChild(row);
  }
  container.appendChild(content);
}

async function startConnection(
  container: HTMLElement,
  doc: Document,
  chatId: string,
  provider: CloudProvider,
): Promise<void> {
  if (provider.id === "nextcloud") {
    if (!provider.isLoggedIn()) {
      renderNextcloudSetup(container, doc, chatId, provider);
      return;
    }
  } else if (!provider.isConfigured()) {
    renderOAuthSetup(container, doc, chatId, provider);
    return;
  }

  renderConnecting(container, doc, chatId, provider);
}

function renderOAuthSetup(
  container: HTMLElement,
  doc: Document,
  chatId: string,
  provider: CloudProvider,
): void {
  try {
    const config = OAUTH_SETUP_CONFIGS[provider.id];
    if (!config) {
      renderConnectView(container, doc, chatId);
      return;
    }

    container.innerHTML = "";
    const header = div(doc, STYLES.header);
    header.appendChild(
      backBtn(doc, () => renderConnectView(container, doc, chatId)),
    );
    header.appendChild(
      div(
        doc,
        "font-weight: 700; font-size: 15px; flex: 1;",
        `${provider.icon} ${provider.name} Setup`,
      ),
    );
    container.appendChild(header);

    const content = div(doc, STYLES.content);
    const steps = div(
      doc,
      `margin-bottom: 24px; font-size: 12px; line-height: 1.6; color: ${COLORS.text};`,
    );

    const s1 = div(doc, "margin-bottom: 12px;");
    s1.textContent = "1. Register an app at ";
    const link = el(
      doc,
      "a",
      `color:${provider.brandColor};font-weight:700;cursor:pointer;text-decoration:underline;`,
      config.consoleLabel,
    );
    link.addEventListener("click", (e) => {
      e.preventDefault();
      Zotero.launchURL(config.consoleUrl);
    });
    s1.appendChild(link);
    steps.appendChild(s1);

    if (provider.id === "dropbox") {
      const permNote = div(
        doc,
        `margin-bottom: 12px; font-size: 11px; background: ${COLORS.bgSecondary}; border: 1px solid ${COLORS.border}; padding: 8px; border-radius: 6px; line-height: 1.5; color: ${COLORS.text};`,
      );
      permNote.textContent =
        "2. In the 'Permissions' tab, enable ALL checkboxes under 'Files and folders' (you may need all read/write access). Also set 'Access type' to 'Full Dropbox' or 'App folder' as needed.";
      steps.appendChild(permNote);
    }

    if (provider.id === "google") {
      const permNote = div(
        doc,
        `margin-bottom: 12px; font-size: 11px; background: ${COLORS.bgSecondary}; border: 1px solid ${COLORS.border}; padding: 8px; border-radius: 6px; line-height: 1.5; color: ${COLORS.text};`,
      );
      permNote.textContent =
        "2. Enable the 'Google Drive API'. Under 'OAuth consent screen', set to 'External' and add the scope .../auth/drive.readonly. Publish the app when ready.";
      steps.appendChild(permNote);
    }

    const uriStepNum =
      provider.id === "dropbox" || provider.id === "google" ? "3" : "2";
    const credStepNum =
      provider.id === "dropbox" || provider.id === "google" ? "4" : "3";

    const s2 = div(doc, "margin-bottom: 12px;");
    s2.textContent = `${uriStepNum}. Add this EXACT Redirect URI in the app console:`;
    const codeRow = div(
      doc,
      "display: flex; gap: 4px; margin-top: 6px; align-items: stretch;",
    );
    const code = el(
      doc,
      "code",
      `background:${COLORS.bgSecondary}; color:${COLORS.text}; padding:6px 10px; border-radius:6px; border:1px solid ${COLORS.border}; word-break:break-all; font-family:monospace; font-size:11px; font-weight:600; flex:1; display:flex; align-items:center;`,
      config.redirectUri,
    );
    codeRow.appendChild(code);
    const copyBtn = btn(doc, "Copy", provider.brandColor, () => {
      const textArea = doc.createElementNS(
        HTML_NS,
        "textarea",
      ) as HTMLTextAreaElement;
      textArea.value = config.redirectUri;
      textArea.style.cssText =
        "position:fixed;top:-100px;left:-100px;opacity:0;";
      const body = doc.body;
      if (body) {
        body.appendChild(textArea);
        textArea.select();
        try {
          doc.execCommand("copy");
        } catch {
          // ignore
        }
        body.removeChild(textArea);
      }
      copyBtn.textContent = "Copied!";
      copyBtn.style.background = COLORS.success;
      setTimeout(() => {
        copyBtn.textContent = "Copy";
        copyBtn.style.background = provider.brandColor;
      }, 2000);
    });
    copyBtn.style.padding = "4px 10px";
    copyBtn.style.fontSize = "11px";
    copyBtn.style.height = "auto";
    codeRow.appendChild(copyBtn);
    s2.appendChild(codeRow);

    const warn = div(
      doc,
      `font-size: 10px; background: ${COLORS.bgSecondary}; padding: 6px; border-radius: 4px; margin-top: 6px; border: 1px solid ${COLORS.border}; color: ${COLORS.text};`,
    );
    warn.textContent =
      "Important: You must click 'Add' and then 'Save' in the app console after pasting this URI. Without this, sign-in will fail.";
    s2.appendChild(warn);
    steps.appendChild(s2);

    const s3 = div(
      doc,
      "",
      `${credStepNum}. Paste your Application Credentials below:`,
    );
    steps.appendChild(s3);
    content.appendChild(steps);

    const inputs: Record<string, HTMLInputElement> = {};
    for (const field of config.fields) {
      content.appendChild(
        div(
          doc,
          "font-weight: 600; font-size: 11px; margin-bottom: 4px; margin-left: 2px;",
          field.label,
        ),
      );
      const input = el(doc, "input", STYLES.input) as HTMLInputElement;
      input.type = field.type;
      input.placeholder = `e.g. ${field.label}`;
      inputs[field.id] = input;
      content.appendChild(input);
    }

    const errorMsg = div(
      doc,
      `color: ${COLORS.error}; font-size: 11px; margin-bottom: 12px; display: none; text-align: center; font-weight:600;`,
    );
    content.appendChild(errorMsg);

    const saveBtn = btn(doc, "Save & Connect", provider.brandColor, () => {
      const missing = config.fields.some((f) => !inputs[f.id].value.trim());
      if (missing) {
        errorMsg.textContent = "Please fill in all fields.";
        errorMsg.style.display = "block";
        return;
      }
      for (const field of config.fields) {
        Zotero.Prefs.set(field.prefKey, inputs[field.id].value.trim());
      }
      renderConnecting(container, doc, chatId, provider);
    });
    saveBtn.style.width = "100%";
    content.appendChild(saveBtn);
    container.appendChild(content);
  } catch (e: any) {
    renderError(container, doc, e);
  }
}

function renderNextcloudSetup(
  container: HTMLElement,
  doc: Document,
  chatId: string,
  provider: CloudProvider,
): void {
  try {
    container.innerHTML = "";
    const header = div(doc, STYLES.header);
    header.appendChild(
      backBtn(doc, () => renderConnectView(container, doc, chatId)),
    );
    header.appendChild(
      div(
        doc,
        "font-weight: 700; font-size: 15px; flex: 1;",
        `${provider.icon} Nextcloud Setup`,
      ),
    );
    container.appendChild(header);

    const content = div(doc, STYLES.content);

    const helpBox = div(
      doc,
      "margin-bottom: 20px; font-size: 12px; line-height: 1.5; background: #e6f7ff; border: 1px solid #91d5ff; padding: 12px; border-radius: 8px;",
    );
    helpBox.textContent =
      "Enter your Nextcloud server details and an App Password. ";
    const helpLink = el(
      doc,
      "a",
      `color:${provider.brandColor};font-weight:600;cursor:pointer;text-decoration:underline;`,
      "How to get an App Password?",
    );
    helpLink.addEventListener("click", (e) => {
      e.preventDefault();
      Zotero.launchURL(
        "https://docs.nextcloud.com/server/latest/user_manual/en/session_management.html",
      );
    });
    helpBox.appendChild(helpLink);
    content.appendChild(helpBox);

    const urlInput = el(doc, "input", STYLES.input) as HTMLInputElement;
    urlInput.placeholder = "Server URL (https://cloud.example.com)";
    content.appendChild(urlInput);

    const userInput = el(doc, "input", STYLES.input) as HTMLInputElement;
    userInput.placeholder = "Username";
    content.appendChild(userInput);

    const passInput = el(doc, "input", STYLES.input) as HTMLInputElement;
    passInput.type = "password";
    passInput.placeholder = "App Password";
    content.appendChild(passInput);

    const errorMsg = div(
      doc,
      `color: ${COLORS.error}; font-size: 11px; margin-bottom: 12px; display: none; text-align: center; font-weight:600;`,
    );
    content.appendChild(errorMsg);

    const saveBtn = btn(
      doc,
      "Save & Connect",
      provider.brandColor,
      async () => {
        const url = urlInput.value.trim();
        const user = userInput.value.trim();
        const pass = passInput.value.trim();
        if (!url || !user || !pass) {
          errorMsg.textContent = "All fields are required.";
          errorMsg.style.display = "block";
          return;
        }
        saveBtn.disabled = true;
        saveBtn.textContent = "Connecting...";

        Zotero.Prefs.set(
          "extensions.zotero.seerai.cloud.nextcloud.serverUrl",
          url,
        );
        Zotero.Prefs.set(
          "extensions.zotero.seerai.cloud.nextcloud.username",
          user,
        );
        Zotero.Prefs.set(
          "extensions.zotero.seerai.cloud.nextcloud.appPassword",
          pass,
        );

        const success = await provider.login();
        if (success) {
          MANAGER.setActive("nextcloud");
          const loggedIn = MANAGER.getLoggedIn();
          await renderMainView(container, doc, chatId, loggedIn, "nextcloud");
        } else {
          errorMsg.textContent =
            "Connection failed. Please check your credentials.";
          errorMsg.style.display = "block";
          saveBtn.disabled = false;
          saveBtn.textContent = "Save & Connect";
        }
      },
    );
    saveBtn.style.width = "100%";
    content.appendChild(saveBtn);
    container.appendChild(content);
  } catch (e: any) {
    renderError(container, doc, e);
  }
}

function renderConnecting(
  container: HTMLElement,
  doc: Document,
  chatId: string,
  provider: CloudProvider,
): void {
  try {
    container.innerHTML = "";
    const header = div(doc, STYLES.header);
    header.appendChild(
      backBtn(doc, () => {
        provider.cancelLogin?.();
        renderConnectView(container, doc, chatId);
      }),
    );
    header.appendChild(
      div(
        doc,
        "font-weight: 700; font-size: 15px; flex: 1;",
        `Connecting ${provider.name}`,
      ),
    );
    container.appendChild(header);

    const content = div(
      doc,
      "padding: 40px 24px; display: flex; flex-direction: column; align-items: center; text-align: center;",
    );

    const icon = div(
      doc,
      "font-size: 48px; margin-bottom: 20px;",
      provider.icon,
    );
    const title = div(
      doc,
      "font-weight: 700; font-size: 18px; margin-bottom: 8px;",
      `Connecting to ${provider.name}`,
    );
    const desc = div(
      doc,
      `color: ${COLORS.textSecondary}; font-size: 13px; line-height: 1.5; margin-bottom: 16px;`,
      "A login page has been opened in your browser. Sign in, then copy the authorization code shown below it.",
    );

    const cancelBtn = btn(
      doc,
      "Cancel Authorization",
      "",
      () => {
        provider.cancelLogin?.();
        renderConnectView(container, doc, chatId);
      },
      true,
    );
    cancelBtn.style.width = "100%";

    const manualSection = div(
      doc,
      `margin-top: 20px; width: 100%; border-top: 1px solid ${COLORS.border}; padding-top: 20px; display: flex; flex-direction: column;`,
    );
    const pasteLabel = div(
      doc,
      `color: ${COLORS.textSecondary}; font-size: 12px; margin-bottom: 8px; font-weight: 600;`,
      "Paste the authorization code (or the full redirect URL):",
    );
    manualSection.appendChild(pasteLabel);

    const textarea = el(
      doc,
      "textarea",
      `${STYLES.input} height: 70px; font-family: monospace; font-size: 11px; margin-bottom: 12px;`,
    ) as HTMLTextAreaElement;
    const placeholder = provider.getRedirectUri();
    textarea.placeholder = `Paste code or URL like: ${placeholder}?code=...`;
    manualSection.appendChild(textarea);

    const errorHint = div(
      doc,
      `color: ${COLORS.error}; font-size: 11px; margin-bottom: 12px; display: none; text-align: center; font-weight: 600;`,
    );
    manualSection.appendChild(errorHint);

    const submitBtn = btn(doc, "Verify Code", provider.brandColor, async () => {
      const raw = textarea.value.trim();
      if (!raw) return;
      submitBtn.disabled = true;
      submitBtn.textContent = "Verifying...";
      errorHint.style.display = "none";
      try {
        const code = resolveAuthCode(raw);
        if (!code) {
          throw new Error(
            "No authorization code found. Paste the full redirect URL from your browser's address bar, or just the code shown on the Dropbox page.",
          );
        }
        await provider.handleCallback(code);
        const loggedIn = MANAGER.getLoggedIn();
        await renderMainView(container, doc, chatId, loggedIn, provider.id);
      } catch (e: any) {
        submitBtn.disabled = false;
        submitBtn.textContent = "Verify Code";
        textarea.style.borderColor = COLORS.error;
        errorHint.textContent = e?.message || String(e);
        errorHint.style.display = "block";
        Zotero.debug(`[seerai] Manual verify error: ${e}`);
      }
    });
    submitBtn.style.width = "100%";
    manualSection.appendChild(submitBtn);

    content.appendChild(icon);
    content.appendChild(title);
    content.appendChild(desc);
    content.appendChild(cancelBtn);
    content.appendChild(manualSection);
    container.appendChild(content);

    provider
      .login()
      .then((success) => {
        if (!container.contains(content)) return;
        if (success) {
          const loggedIn = MANAGER.getLoggedIn();
          renderMainView(container, doc, chatId, loggedIn, provider.id);
        }
      })
      .catch((err) => {
        if (!container.contains(content)) return;
        Zotero.debug(`[seerai] Provider login catch: ${err}`);
      });
  } catch (e: any) {
    renderError(container, doc, e);
  }
}

function resolveAuthCode(raw: string): string | null {
  if (raw.includes("?")) {
    const code = extractCodeFromUrl(raw);
    if (code) return code;
  }
  if (
    raw.length >= 20 &&
    raw.length <= 2000 &&
    !raw.includes("\n") &&
    !raw.includes(" ")
  ) {
    return raw;
  }
  return extractCodeFromUrl(raw);
}

async function renderMainView(
  container: HTMLElement,
  doc: Document,
  chatId: string,
  providers: CloudProvider[],
  selectedId: CloudProviderId,
): Promise<void> {
  try {
    container.innerHTML = "";

    let currentProvider =
      providers.find((p) => p.id === selectedId) || providers[0];
    let currentTab: "browse" | "search" = "browse";

    const providerBar = div(
      doc,
      `display: flex; align-items: center; gap: 4px; padding: 8px 12px; background: ${COLORS.bgSecondary}; border-bottom: 1px solid ${COLORS.border}; overflow-x: auto;`,
    );

    const providerTabs: { el: HTMLElement; provider: CloudProvider }[] = [];
    for (const p of providers) {
      const tab = div(
        doc,
        `padding: 6px 12px; border-radius: 8px; cursor: pointer; font-size: 12px; white-space: nowrap; transition: all 0.2s;`,
        `${p.icon} ${p.name}`,
      );
      tab.addEventListener("click", () => {
        currentProvider = p;
        updateUI();
      });
      providerTabs.push({ el: tab, provider: p });
      providerBar.appendChild(tab);
    }

    const addBtn = div(
      doc,
      `padding: 6px 10px; cursor: pointer; font-size: 20px; color: ${COLORS.textSecondary}; display: flex; align-items: center; justify-content: center;`,
      "+",
    );
    addBtn.title = "Connect more providers";
    addBtn.addEventListener("click", () =>
      renderConnectView(container, doc, chatId),
    );
    providerBar.appendChild(addBtn);

    const logoutBtn = div(
      doc,
      `margin-left: auto; padding: 8px; cursor: pointer; font-size: 14px; color: ${COLORS.textSecondary}; opacity: 0.7;`,
      "🚪",
    );
    logoutBtn.title = `Logout from ${currentProvider.name}`;
    logoutBtn.addEventListener("click", () => {
      currentProvider.logout();
      const remaining = MANAGER.getLoggedIn();
      if (remaining.length > 0) {
        renderMainView(container, doc, chatId, remaining, remaining[0].id);
      } else {
        renderConnectView(container, doc, chatId);
      }
    });
    logoutBtn.addEventListener(
      "mouseenter",
      () => (logoutBtn.style.opacity = "1"),
    );
    logoutBtn.addEventListener(
      "mouseleave",
      () => (logoutBtn.style.opacity = "0.7"),
    );

    providerBar.appendChild(logoutBtn);
    container.appendChild(providerBar);

    const tabRow = div(
      doc,
      `display: flex; border-bottom: 1px solid ${COLORS.border}; padding: 0 12px; background: ${COLORS.bg};`,
    );
    const browseTab = div(
      doc,
      "padding: 12px 16px; cursor: pointer; font-weight: 700; border-bottom: 2px solid transparent; transition: all 0.2s; font-size: 13px;",
      "Browse",
    );
    const searchTab = div(
      doc,
      "padding: 12px 16px; cursor: pointer; font-weight: 700; border-bottom: 2px solid transparent; transition: all 0.2s; font-size: 13px;",
      "Search",
    );
    tabRow.appendChild(browseTab);
    tabRow.appendChild(searchTab);
    container.appendChild(tabRow);

    const contentArea = div(doc, "flex: 1; overflow-y: auto;");
    container.appendChild(contentArea);

    const updateUI = () => {
      providerTabs.forEach((t) => {
        const active = t.provider.id === currentProvider.id;
        t.el.style.background = active ? COLORS.bg : "transparent";
        t.el.style.boxShadow = active ? "0 1px 4px rgba(0,0,0,0.1)" : "none";
        t.el.style.fontWeight = active ? "700" : "500";
        t.el.style.color = active ? COLORS.primary : COLORS.textSecondary;
      });

      browseTab.style.borderBottomColor =
        currentTab === "browse" ? currentProvider.brandColor : "transparent";
      browseTab.style.color =
        currentTab === "browse"
          ? currentProvider.brandColor
          : COLORS.textSecondary;
      searchTab.style.borderBottomColor =
        currentTab === "search" ? currentProvider.brandColor : "transparent";
      searchTab.style.color =
        currentTab === "search"
          ? currentProvider.brandColor
          : COLORS.textSecondary;

      contentArea.innerHTML = "";
      if (currentTab === "browse") {
        renderBrowse(contentArea, doc, chatId, currentProvider);
      } else {
        renderSearch(contentArea, doc, chatId, currentProvider);
      }
    };

    browseTab.addEventListener("click", () => {
      currentTab = "browse";
      updateUI();
    });
    searchTab.addEventListener("click", () => {
      currentTab = "search";
      updateUI();
    });

    updateUI();
  } catch (e: any) {
    renderError(container, doc, e);
  }
}

async function renderBrowse(
  container: HTMLElement,
  doc: Document,
  chatId: string,
  provider: CloudProvider,
  folderId = "root",
  history: string[] = [],
): Promise<void> {
  try {
    container.innerHTML = "";
    const loading = div(
      doc,
      `padding: 40px; text-align: center; color: ${COLORS.textSecondary};`,
    );
    loading.textContent = "Loading files...";
    container.appendChild(loading);

    const { nodes } = await provider.listFolder(
      folderId === "root" ? "" : folderId,
    );
    container.innerHTML = "";

    const list = div(doc, "padding: 8px;");

    if (history.length > 0) {
      const backRow = div(doc, STYLES.row);
      backRow.style.padding = "8px 12px";
      backRow.appendChild(
        span(doc, "margin-right: 12px; font-size: 16px;", "↩️"),
      );
      backRow.appendChild(span(doc, "font-weight: 700;", "..."));
      backRow.addEventListener("click", () => {
        const prevId = history.pop();
        renderBrowse(
          container,
          doc,
          chatId,
          provider,
          prevId || "root",
          history,
        );
      });
      list.appendChild(backRow);
    }

    if (nodes.length === 0) {
      const empty = div(
        doc,
        `padding: 48px 24px; text-align: center; color: ${COLORS.textSecondary};`,
      );
      empty.textContent = "This folder is empty";
      list.appendChild(empty);
    } else {
      for (const node of nodes) {
        list.appendChild(
          createFileRow(doc, node, chatId, provider, () => {
            renderBrowse(container, doc, chatId, provider, node.id, [
              ...history,
              folderId,
            ]);
          }),
        );
      }
    }
    container.appendChild(list);
  } catch (e: any) {
    renderError(container, doc, e);
  }
}

function renderSearch(
  container: HTMLElement,
  doc: Document,
  chatId: string,
  provider: CloudProvider,
): void {
  try {
    const searchBox = div(
      doc,
      `padding: 12px; border-bottom: 1px solid ${COLORS.border}; background: ${COLORS.bgSecondary};`,
    );
    const input = el(
      doc,
      "input",
      `${STYLES.input} margin-bottom: 0; background: ${COLORS.bg};`,
    ) as HTMLInputElement;
    input.placeholder = "Search files...";
    searchBox.appendChild(input);
    container.appendChild(searchBox);

    const resultsArea = div(doc, "padding: 8px;");
    container.appendChild(resultsArea);

    let timer: any;
    input.addEventListener("input", () => {
      clearTimeout(timer);
      if (input.value.trim().length < 2) {
        resultsArea.innerHTML = "";
        return;
      }
      timer = setTimeout(async () => {
        resultsArea.innerHTML = "";
        const searching = div(
          doc,
          `padding: 32px; text-align: center; color: ${COLORS.textSecondary};`,
        );
        searching.textContent = "Searching...";
        resultsArea.appendChild(searching);

        try {
          const { nodes } = await provider.searchFiles(input.value.trim());
          resultsArea.innerHTML = "";
          if (nodes.length === 0) {
            const noResults = div(
              doc,
              `padding: 32px; text-align: center; color: ${COLORS.textSecondary};`,
            );
            noResults.textContent = "No results found";
            resultsArea.appendChild(noResults);
          } else {
            for (const node of nodes) {
              resultsArea.appendChild(
                createFileRow(doc, node, chatId, provider, () => {
                  // Switch to browse tab logic
                  const browseTab = container.previousSibling
                    ?.firstChild as HTMLElement;
                  if (browseTab) browseTab.click();
                  renderBrowse(container, doc, chatId, provider, node.id, [
                    "root",
                  ]);
                }),
              );
            }
          }
        } catch (e: any) {
          resultsArea.innerHTML = "";
          const fail = div(
            doc,
            `padding: 32px; text-align: center; color: ${COLORS.error};`,
          );
          fail.textContent = "Search failed";
          resultsArea.appendChild(fail);
        }
      }, 400);
    });
  } catch (e: any) {
    renderError(container, doc, e);
  }
}

function createFileRow(
  doc: Document,
  node: FileNode,
  chatId: string,
  provider: CloudProvider,
  onFolderClick?: () => void,
): HTMLElement {
  const row = div(doc, STYLES.row);
  row.style.padding = "10px 12px";
  row.style.gap = "12px";

  row.addEventListener(
    "mouseenter",
    () => (row.style.background = COLORS.bgSecondary),
  );
  row.addEventListener(
    "mouseleave",
    () => (row.style.background = "transparent"),
  );

  const icon = span(
    doc,
    "font-size: 20px; width: 24px; text-align: center;",
    node.isFolder ? "📁" : "📄",
  );
  const name = span(
    doc,
    "flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 500;",
    node.name,
  );

  row.appendChild(icon);
  row.appendChild(name);

  if (node.isFolder) {
    row.appendChild(
      span(
        doc,
        `color: ${COLORS.textSecondary}; font-size: 14px; font-weight: bold;`,
        "›",
      ),
    );
    if (onFolderClick) {
      row.addEventListener("click", (e) => {
        e.stopPropagation();
        onFolderClick();
      });
    }
  } else {
    const actionArea = div(doc, "display: flex; gap: 6px;");

    const loadBtn = btn(doc, "Load", COLORS.primary, async (e) => {
      e.stopPropagation();
      loadBtn.disabled = true;
      const originalText = loadBtn.textContent;
      loadBtn.textContent = "...";
      try {
        await loadFileToContext(node, chatId, loadBtn, provider);
        loadBtn.textContent = "✓";
        loadBtn.style.background = COLORS.success;
      } catch (err) {
        Zotero.debug(`[seerai] Load file error: ${err}`);
        loadBtn.textContent = "!";
        loadBtn.style.background = COLORS.error;
      }
      setTimeout(() => {
        loadBtn.disabled = false;
        loadBtn.textContent = originalText;
        loadBtn.style.background = COLORS.primary;
      }, 2000);
    });
    loadBtn.style.padding = "4px 12px";
    loadBtn.style.fontSize = "11px";
    loadBtn.style.height = "26px";

    const importBtn = btn(doc, "Import", COLORS.success, async (e) => {
      e.stopPropagation();
      importBtn.disabled = true;
      const originalText = importBtn.textContent;
      importBtn.textContent = "...";
      try {
        await importFileToWorkspace(node, importBtn, provider);
        importBtn.textContent = "✓";
      } catch (err) {
        Zotero.debug(`[seerai] Import file error: ${err}`);
        importBtn.textContent = "!";
        importBtn.style.background = COLORS.error;
      }
      setTimeout(() => {
        importBtn.disabled = false;
        importBtn.textContent = originalText;
        importBtn.style.background = COLORS.success;
      }, 2000);
    });
    importBtn.style.padding = "4px 12px";
    importBtn.style.fontSize = "11px";
    importBtn.style.height = "26px";

    actionArea.appendChild(loadBtn);
    actionArea.appendChild(importBtn);
    row.appendChild(actionArea);
  }

  return row;
}

async function loadFileToContext(
  node: FileNode,
  chatId: string,
  btn: HTMLButtonElement,
  provider: CloudProvider,
): Promise<void> {
  if (!provider.isTextExportable(node.mimeType))
    throw new Error("This file type is not supported for reading yet.");
  const result = await provider.getFileTextContent(node);
  if (!result) throw new Error("The file has no text content to extract.");

  const contextData: DriveContextData = {
    provider: provider.id,
    icon: provider.icon,
    driveFileId: node.id,
    mimeType: node.mimeType,
    name: node.name,
    lastKnownModifiedTime: node.modifiedTime,
    extractedContent: stripBase64Data(result.content),
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
  node: FileNode,
  btn: HTMLButtonElement,
  provider: CloudProvider,
): Promise<void> {
  if (!provider.isTextExportable(node.mimeType))
    throw new Error("This file type is not supported for importing yet.");
  const store = getWorkspaceStore();
  const result = await provider.getFileTextContent(node);
  if (!result) throw new Error("The file has no text content to import.");
  await store.writeFile(node.name || "untitled", result.content);
}
