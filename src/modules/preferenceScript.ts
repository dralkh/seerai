import { config } from "../../package.json";
import { getString } from "../utils/locale";
import { CloudProviderManager, CloudProviderId } from "./drive";
import {
  renderModelDefaults,
  renderProviderSettings,
} from "./chat/ui/providerManager";
import {
  renderAdvancedRetrievalSettings,
  renderAiTableSettings,
  renderDataManagementSettings,
  renderEvaluationSettings,
  renderMcpSettings,
  renderOcrSettings,
  renderRagRerankerSettings,
  renderSemanticScholarSettings,
  renderWebSearchSettings,
} from "./chat/ui/integrationSettings";
import { subscribeProviderRegistry } from "./chat/providerRegistry";

let unsubscribeProviderSettings: (() => void) | undefined;

export async function registerPrefsScripts(_window: Window) {
  // This function is called when the prefs window is opened
  // See addon/content/preferences.xhtml onpaneload
  if (!addon.data.prefs) {
    addon.data.prefs = {
      window: _window,
      columns: [
        {
          dataKey: "title",
          label: getString("prefs-table-title"),
          fixedWidth: true,
          width: 100,
        },
        {
          dataKey: "detail",
          label: getString("prefs-table-detail"),
        },
      ],
      rows: [
        {
          title: "Orange",
          detail: "It's juicy",
        },
        {
          title: "Banana",
          detail: "It's sweet",
        },
        {
          title: "Apple",
          detail: "I mean the fruit APPLE",
        },
      ],
    };
  } else {
    addon.data.prefs.window = _window;
  }
  updatePrefsUI();
  initProviderSettingsUI();
  initIntegrationSettingsUI();
  initDrivePrefsUI();
}

function initProviderSettingsUI() {
  const doc = addon.data.prefs!.window.document;
  const providerContainer = doc.getElementById(
    `${config.addonRef}-provider-settings`,
  ) as HTMLElement | null;
  const defaultsContainer = doc.getElementById(
    `${config.addonRef}-model-defaults`,
  ) as HTMLElement | null;
  if (providerContainer) {
    renderProviderSettings(doc, providerContainer);
  }
  if (defaultsContainer) {
    renderModelDefaults(doc, defaultsContainer);
  }
  unsubscribeProviderSettings?.();
  unsubscribeProviderSettings = subscribeProviderRegistry(() => {
    if (defaultsContainer?.isConnected) {
      renderModelDefaults(doc, defaultsContainer);
    }
  });
}

// Renders the styled integration sections (MCP, data management, OCR, semantic
// scholar, web search, AI & table, RAG & reranker, advanced retrieval,
// evaluation) into their container divs. Cloud storage keeps its own wiring in
// initDrivePrefsUI.
function initIntegrationSettingsUI() {
  const doc = addon.data.prefs!.window.document;
  const sections: Array<
    [string, (doc: Document, container: HTMLElement) => void]
  > = [
    ["mcp-settings", renderMcpSettings],
    ["data-settings", renderDataManagementSettings],
    ["ocr-settings", renderOcrSettings],
    ["semanticscholar-settings", renderSemanticScholarSettings],
    ["websearch-settings", renderWebSearchSettings],
    ["aitable-settings", renderAiTableSettings],
    ["ragreranker-settings", renderRagRerankerSettings],
    ["advancedretrieval-settings", renderAdvancedRetrievalSettings],
    ["evaluation-settings", renderEvaluationSettings],
  ];
  for (const [suffix, render] of sections) {
    const container = doc.getElementById(
      `${config.addonRef}-${suffix}`,
    ) as HTMLElement | null;
    if (container) {
      try {
        render(doc, container);
      } catch (e) {
        Zotero.debug(`[seerai] Failed to render ${suffix}: ${e}`);
      }
    }
  }
}

async function updatePrefsUI() {
  // You can initialize some UI elements on prefs window
  // with addon.data.prefs.window.document
  // Or bind some events to the elements
  const renderLock = ztoolkit.getGlobal("Zotero").Promise.defer();
  if (addon.data.prefs?.window == undefined) return;
  const tableHelper = new ztoolkit.VirtualizedTable(addon.data.prefs?.window)
    .setContainerId(`${config.addonRef}-table-container`)
    .setProp({
      id: `${config.addonRef}-prefs-table`,
      // Do not use setLocale, as it modifies the Zotero.Intl.strings
      // Set locales directly to columns
      columns: addon.data.prefs?.columns,
      showHeader: true,
      multiSelect: true,
      staticColumns: true,
      disableFontSizeScaling: true,
    })
    .setProp("getRowCount", () => addon.data.prefs?.rows.length || 0)
    .setProp(
      "getRowData",
      (index) =>
        addon.data.prefs?.rows[index] || {
          title: "no data",
          detail: "no data",
        },
    )
    // Show a progress window when selection changes
    .setProp("onSelectionChange", (selection) => {
      new ztoolkit.ProgressWindow(config.addonName)
        .createLine({
          text: `Selected line: ${addon.data.prefs?.rows
            .filter((v, i) => selection.isSelected(i))
            .map((row) => row.title)
            .join(",")}`,
          progress: 100,
        })
        .show();
    })
    // When pressing delete, delete selected line and refresh table.
    // Returning false to prevent default event.
    .setProp("onKeyDown", (event: KeyboardEvent) => {
      if (event.key == "Delete" || (Zotero.isMac && event.key == "Backspace")) {
        addon.data.prefs!.rows =
          addon.data.prefs?.rows.filter(
            (v, i) => !tableHelper.treeInstance.selection.isSelected(i),
          ) || [];
        tableHelper.render();
        return false;
      }
      return true;
    })
    // For find-as-you-type
    .setProp(
      "getRowString",
      (index) => addon.data.prefs?.rows[index].title || "",
    )
    // Render the table.
    .render(-1, () => {
      renderLock.resolve();
    });
  await renderLock.promise;
  ztoolkit.log("Preference table rendered!");
}

interface ProviderUIElements {
  statusIcon: Element | null;
  statusText: Element | null;
  saveBtn: Element | null;
  signinBtn: Element | null;
  clearBtn: Element | null;
  fields: { input: HTMLInputElement; prefKey: string }[];
  pasteArea?: Element | null;
  pasteInput?: HTMLInputElement | null;
  pasteVerify?: Element | null;
  pasteStatus?: Element | null;
  customOAuthToggle?: Element | null;
  customOAuthSection?: Element | null;
  defaultClientId?: string;
  isNextcloud?: boolean;
}

function initProviderUI(
  doc: Document,
  manager: CloudProviderManager,
  providerId: CloudProviderId,
  elements: ProviderUIElements,
): void {
  const provider = manager.get(providerId);
  if (!provider) return;

  const isOAuth = !elements.isNextcloud && elements.customOAuthSection != null;
  const isNextcloud = !!elements.isNextcloud;

  function findClientIdField():
    | { input: HTMLInputElement; prefKey: string }
    | undefined {
    return elements.fields.find(
      (f) =>
        f.prefKey.includes("ClientId") ||
        f.prefKey.includes("clientId") ||
        f.prefKey.includes("appKey"),
    );
  }

  function updateStatus(): void {
    const loggedIn = provider!.isLoggedIn();
    if (elements.statusIcon)
      elements.statusIcon.innerHTML = `<span style="display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: ${loggedIn ? "#22c55e" : "#9ca3af"};"></span>`;
    if (elements.statusText)
      elements.statusText.textContent = loggedIn
        ? "Connected"
        : "Not connected";

    if (elements.signinBtn) {
      if (isOAuth) {
        (elements.signinBtn as HTMLElement).hidden = loggedIn;
      } else if (isNextcloud) {
        (elements.signinBtn as XUL.Button).disabled = loggedIn;
      } else {
        (elements.signinBtn as XUL.Button).disabled = loggedIn;
      }
    }
    if (elements.clearBtn) {
      if (isOAuth) {
        (elements.clearBtn as HTMLElement).hidden = !loggedIn;
      } else {
        (elements.clearBtn as XUL.Button).disabled = !loggedIn;
      }
    }
    if (isOAuth && elements.pasteArea) {
      (elements.pasteArea as HTMLElement).hidden = true;
    }
  }

  function loadPrefs(): void {
    for (const field of elements.fields) {
      field.input.value = (Zotero.Prefs.get(field.prefKey) as string) || "";
    }

    if (isOAuth && elements.customOAuthSection && elements.customOAuthToggle) {
      const clientIdField = findClientIdField();
      const hasCustom =
        clientIdField &&
        clientIdField.input.value.trim() &&
        (!elements.defaultClientId ||
          clientIdField.input.value.trim() !== elements.defaultClientId);

      (elements.customOAuthSection as HTMLElement).hidden = !hasCustom;
      (elements.customOAuthToggle as HTMLElement).textContent = hasCustom
        ? "Use default credentials"
        : elements.defaultClientId
          ? "Set Custom OAuth credentials..."
          : "Set Custom App Key...";
    }

    updateStatus();
  }

  function updateSaveBtn(): void {
    if (elements.saveBtn) {
      (elements.saveBtn as XUL.Button).disabled = !elements.fields.every((f) =>
        f.input.value.trim(),
      );
    }
  }

  for (const field of elements.fields) {
    field.input.addEventListener("input", updateSaveBtn);
  }

  if (elements.saveBtn) {
    elements.saveBtn.addEventListener("click", () => {
      for (const field of elements.fields) {
        Zotero.Prefs.set(field.prefKey, field.input.value.trim());
      }
      (elements.saveBtn as XUL.Button).disabled = true;
      if (isNextcloud) {
        elements.saveBtn?.setAttribute("label", "Connected!");
      } else {
        elements.saveBtn?.setAttribute("label", "Saved!");
      }
      setTimeout(() => {
        if (isNextcloud) {
          elements.saveBtn?.setAttribute("label", "Connect");
        } else {
          elements.saveBtn?.setAttribute("label", "Save");
        }
      }, 1500);
      updateStatus();
    });
  }

  if (elements.signinBtn && isOAuth) {
    elements.signinBtn.addEventListener("click", async () => {
      (elements.signinBtn as XUL.Button).disabled = true;
      elements.signinBtn?.setAttribute("label", "Opening browser...");

      if (elements.pasteArea) {
        (elements.pasteArea as HTMLElement).hidden = false;
      }

      const handlePasteVerify = async () => {
        const raw = elements.pasteInput?.value.trim();
        if (!raw) return;
        if (elements.pasteVerify)
          (elements.pasteVerify as HTMLButtonElement).disabled = true;
        if (elements.pasteVerify)
          (elements.pasteVerify as HTMLButtonElement).textContent = "...";
        try {
          let code: string | null = null;
          if (raw!.includes("?")) {
            const qs = raw!.split("?")[1] || "";
            code = new URLSearchParams(qs).get("code");
          }
          if (
            !code &&
            raw!.length >= 20 &&
            raw!.length <= 2000 &&
            !raw!.includes("\n") &&
            !raw!.includes(" ")
          ) {
            code = raw!;
          }
          if (!code) throw new Error("No auth code found");
          await provider.handleCallback(code);
          if (elements.pasteStatus) {
            elements.pasteStatus.textContent = "Connected!";
            const ps = elements.pasteStatus as HTMLElement;
            ps.style.color = "#188038";
            ps.style.display = "inline-block";
          }
          if (elements.pasteArea)
            (elements.pasteArea as HTMLElement).hidden = true;
          elements.signinBtn?.setAttribute("label", "Sign In");
          updateStatus();
        } catch (e: any) {
          if (elements.pasteVerify)
            (elements.pasteVerify as HTMLButtonElement).disabled = false;
          if (elements.pasteVerify)
            (elements.pasteVerify as HTMLButtonElement).textContent = "Verify";
          if (elements.pasteStatus) {
            elements.pasteStatus.textContent = e?.message || "Failed";
            const ps = elements.pasteStatus as HTMLElement;
            ps.style.color = "#d93025";
            ps.style.display = "inline-block";
          }
          Zotero.debug(`[seerai] Prefs manual verify error: ${e}`);
        }
      };

      const verifyHandler = (e: Event) => {
        e.preventDefault();
        handlePasteVerify();
      };
      if (elements.pasteVerify)
        elements.pasteVerify.addEventListener("click", verifyHandler);
      if (elements.pasteInput) {
        elements.pasteInput.addEventListener("keydown", (e: KeyboardEvent) => {
          if (e.key === "Enter") {
            e.preventDefault();
            handlePasteVerify();
          }
        });
      }

      await provider.login();
      if (elements.pasteArea) (elements.pasteArea as HTMLElement).hidden = true;
      elements.signinBtn?.setAttribute("label", "Sign In");
      updateStatus();
    });
  }

  if (elements.signinBtn && isNextcloud) {
    elements.signinBtn.addEventListener("click", async () => {
      const connectBtn = elements.signinBtn as XUL.Button;
      (connectBtn as XUL.Button).disabled = true;
      connectBtn.setAttribute("label", "Connecting...");

      for (const field of elements.fields) {
        Zotero.Prefs.set(field.prefKey, field.input.value.trim());
      }

      const success = await provider.login();
      if (success) {
        connectBtn.setAttribute("label", "Connected!");
        manager.setActive("nextcloud");
      } else {
        connectBtn.setAttribute("label", "Failed - Retry");
      }
      updateStatus();
      if (success) {
        setTimeout(() => {
          connectBtn.setAttribute("label", "Connect");
        }, 2000);
      }
    });
  }

  if (elements.customOAuthToggle && elements.customOAuthSection && isOAuth) {
    elements.customOAuthToggle.addEventListener("click", () => {
      const section = elements.customOAuthSection as HTMLElement;
      const toggle = elements.customOAuthToggle as HTMLElement;
      const isHidden = section.hidden;

      if (isHidden) {
        section.hidden = false;
        toggle.textContent = "Use default credentials";
      } else {
        for (const field of elements.fields) {
          field.input.value = "";
          Zotero.Prefs.set(field.prefKey, "");
        }
        section.hidden = true;
        toggle.textContent = elements.defaultClientId
          ? "Set Custom OAuth credentials..."
          : "Set Custom App Key...";
        if (elements.saveBtn) (elements.saveBtn as XUL.Button).disabled = true;
      }
    });
  }

  if (elements.clearBtn) {
    elements.clearBtn.addEventListener("click", () => {
      provider.logout();
      if (isOAuth && elements.customOAuthSection) {
        const clientIdField = findClientIdField();
        const hasCustomSaved =
          clientIdField && clientIdField.input.value.trim();
        if (!hasCustomSaved) {
          (elements.customOAuthSection as HTMLElement).hidden = true;
          if (elements.customOAuthToggle)
            elements.customOAuthToggle.textContent =
              "Set Custom OAuth credentials...";
        }
      }
      loadPrefs();
      if (elements.saveBtn) (elements.saveBtn as XUL.Button).disabled = true;
    });
  }

  loadPrefs();
  updateSaveBtn();
}

function initDrivePrefsUI(): void {
  const doc = addon.data.prefs!.window.document;
  const manager = CloudProviderManager.getInstance();
  const prefPrefix = config.prefsPrefix;

  const providerSelect = doc.querySelector(
    "#seerai-cloud-provider-select",
  ) as XUL.MenuList | null;
  if (!providerSelect) return;

  function switchProvider(providerId: string): void {
    const containers: Record<string, string> = {
      nextcloud: "seerai-cloud-settings-nextcloud",
      google: "seerai-cloud-settings-google",
      onedrive: "seerai-cloud-settings-onedrive",
      dropbox: "seerai-cloud-settings-dropbox",
      box: "seerai-cloud-settings-box",
    };

    for (const [id, containerId] of Object.entries(containers)) {
      const el = doc.getElementById(containerId) as HTMLElement | null;
      if (el) el.hidden = id !== providerId;
    }

    manager.setActive(providerId as CloudProviderId);
  }

  // Initial load: restore saved active provider
  const savedProvider =
    (Zotero.Prefs.get(`${prefPrefix}.cloud.activeProvider`) as string) ||
    "nextcloud";
  providerSelect.value = savedProvider;
  switchProvider(savedProvider);

  providerSelect.addEventListener("command", () => {
    switchProvider(providerSelect.value);
  });

  // Nextcloud
  initProviderUI(doc, manager, "nextcloud", {
    statusIcon: doc.getElementById("seerai-nextcloud-status-icon"),
    statusText: doc.getElementById("seerai-nextcloud-status-text"),
    saveBtn: doc.getElementById(
      "seerai-nextcloud-connect-btn",
    ) as XUL.Button | null,
    signinBtn: doc.getElementById(
      "seerai-nextcloud-connect-btn",
    ) as XUL.Button | null,
    clearBtn: doc.getElementById(
      "seerai-nextcloud-clear-btn",
    ) as XUL.Button | null,
    fields: [
      {
        input: doc.getElementById(
          "seerai-nextcloud-server-url",
        ) as HTMLInputElement,
        prefKey: `${prefPrefix}.cloud.nextcloud.serverUrl`,
      },
      {
        input: doc.getElementById(
          "seerai-nextcloud-username",
        ) as HTMLInputElement,
        prefKey: `${prefPrefix}.cloud.nextcloud.username`,
      },
      {
        input: doc.getElementById(
          "seerai-nextcloud-app-password",
        ) as HTMLInputElement,
        prefKey: `${prefPrefix}.cloud.nextcloud.appPassword`,
      },
    ],
    isNextcloud: true,
  });

  // Google Drive
  initProviderUI(doc, manager, "google", {
    statusIcon: doc.getElementById("seerai-drive-status-icon"),
    statusText: doc.getElementById("seerai-drive-status-text"),
    saveBtn: doc.getElementById("seerai-drive-save-btn") as XUL.Button | null,
    signinBtn: doc.getElementById(
      "seerai-drive-signin-btn",
    ) as XUL.Button | null,
    clearBtn: doc.getElementById("seerai-drive-clear-btn") as XUL.Button | null,
    pasteArea: doc.getElementById("seerai-drive-paste-area"),
    pasteInput: doc.getElementById(
      "seerai-drive-paste-input",
    ) as HTMLInputElement | null,
    pasteVerify: doc.getElementById("seerai-drive-paste-verify"),
    pasteStatus: doc.getElementById("seerai-drive-paste-status"),
    customOAuthToggle: doc.getElementById("seerai-drive-custom-oauth-toggle"),
    customOAuthSection: doc.getElementById("seerai-drive-custom-oauth"),
    defaultClientId:
      "22680022759-6e2lkrpjujrlhuqph1kon1b4q83noevt.apps.googleusercontent.com",
    fields: [
      {
        input: doc.getElementById("seerai-drive-client-id") as HTMLInputElement,
        prefKey: `${prefPrefix}.driveClientId`,
      },
      {
        input: doc.getElementById(
          "seerai-drive-client-secret",
        ) as HTMLInputElement,
        prefKey: `${prefPrefix}.driveClientSecret`,
      },
    ],
  });

  // Dropbox
  initProviderUI(doc, manager, "dropbox", {
    statusIcon: doc.getElementById("seerai-dropbox-status-icon"),
    statusText: doc.getElementById("seerai-dropbox-status-text"),
    saveBtn: doc.getElementById("seerai-dropbox-save-btn") as XUL.Button | null,
    signinBtn: doc.getElementById(
      "seerai-dropbox-signin-btn",
    ) as XUL.Button | null,
    clearBtn: doc.getElementById(
      "seerai-dropbox-clear-btn",
    ) as XUL.Button | null,
    pasteArea: doc.getElementById("seerai-dropbox-paste-area"),
    pasteInput: doc.getElementById(
      "seerai-dropbox-paste-input",
    ) as HTMLInputElement | null,
    pasteVerify: doc.getElementById("seerai-dropbox-paste-verify"),
    pasteStatus: doc.getElementById("seerai-dropbox-paste-status"),
    customOAuthToggle: doc.getElementById("seerai-dropbox-custom-oauth-toggle"),
    customOAuthSection: doc.getElementById("seerai-dropbox-custom-oauth"),
    defaultClientId: "i91subs0zer8bi1",
    fields: [
      {
        input: doc.getElementById(
          "seerai-dropbox-client-id",
        ) as HTMLInputElement,
        prefKey: `${prefPrefix}.cloud.dropbox.clientId`,
      },
    ],
  });

  // Box
  initProviderUI(doc, manager, "box", {
    statusIcon: doc.getElementById("seerai-box-status-icon"),
    statusText: doc.getElementById("seerai-box-status-text"),
    saveBtn: doc.getElementById("seerai-box-save-btn") as XUL.Button | null,
    signinBtn: doc.getElementById("seerai-box-signin-btn") as XUL.Button | null,
    clearBtn: doc.getElementById("seerai-box-clear-btn") as XUL.Button | null,
    pasteArea: doc.getElementById("seerai-box-paste-area"),
    pasteInput: doc.getElementById(
      "seerai-box-paste-input",
    ) as HTMLInputElement | null,
    pasteVerify: doc.getElementById("seerai-box-paste-verify"),
    pasteStatus: doc.getElementById("seerai-box-paste-status"),
    customOAuthToggle: doc.getElementById("seerai-box-custom-oauth-toggle"),
    customOAuthSection: doc.getElementById("seerai-box-custom-oauth"),
    defaultClientId: "ozyt20t94vkvr3eu3nag0se0zti4ftpb",
    fields: [
      {
        input: doc.getElementById("seerai-box-client-id") as HTMLInputElement,
        prefKey: `${prefPrefix}.cloud.box.clientId`,
      },
      {
        input: doc.getElementById(
          "seerai-box-client-secret",
        ) as HTMLInputElement,
        prefKey: `${prefPrefix}.cloud.box.clientSecret`,
      },
    ],
  });

  // OneDrive
  initProviderUI(doc, manager, "onedrive", {
    statusIcon: doc.getElementById("seerai-onedrive-status-icon"),
    statusText: doc.getElementById("seerai-onedrive-status-text"),
    saveBtn: doc.getElementById(
      "seerai-onedrive-save-btn",
    ) as XUL.Button | null,
    signinBtn: doc.getElementById(
      "seerai-onedrive-signin-btn",
    ) as XUL.Button | null,
    clearBtn: doc.getElementById(
      "seerai-onedrive-clear-btn",
    ) as XUL.Button | null,
    pasteArea: doc.getElementById("seerai-onedrive-paste-area"),
    pasteInput: doc.getElementById(
      "seerai-onedrive-paste-input",
    ) as HTMLInputElement | null,
    pasteVerify: doc.getElementById("seerai-onedrive-paste-verify"),
    pasteStatus: doc.getElementById("seerai-onedrive-paste-status"),
    customOAuthToggle: doc.getElementById(
      "seerai-onedrive-custom-oauth-toggle",
    ),
    customOAuthSection: doc.getElementById("seerai-onedrive-custom-oauth"),
    defaultClientId: "c1cf27ad-234e-4c44-b233-973eb32846fa",
    fields: [
      {
        input: doc.getElementById(
          "seerai-onedrive-client-id",
        ) as HTMLInputElement,
        prefKey: `${prefPrefix}.cloud.onedrive.clientId`,
      },
      {
        input: doc.getElementById(
          "seerai-onedrive-site-id",
        ) as HTMLInputElement,
        prefKey: `${prefPrefix}.cloud.onedrive.siteId`,
      },
    ],
  });
}
