import { Assistant } from "./modules/assistant";
import { BasicExampleFactory } from "./modules/examples";
import { getString, initLocale } from "./utils/locale";
import { registerPrefsScripts } from "./modules/preferenceScript";
import { createZToolkit } from "./utils/ztoolkit";
import { DataLabService } from "./modules/datalab";

const dataLabService = new DataLabService();

async function onStartup() {
  await Promise.all([
    Zotero.initializationPromise,
    Zotero.unlockPromise,
    Zotero.uiReadyPromise,
  ]);

  initLocale();

  Assistant.register();
  BasicExampleFactory.registerPrefs();

  await Promise.all(
    Zotero.getMainWindows().map((win) => onMainWindowLoad(win)),
  );

  // Mark initialized as true to confirm plugin loading status
  // outside of the plugin (e.g. scaffold testing process)
  addon.data.initialized = true;
}

async function onMainWindowLoad(win: _ZoteroTypes.MainWindow): Promise<void> {
  // Create ztoolkit for every window
  addon.data.ztoolkit = createZToolkit();

  win.MozXULElement.insertFTLIfNeeded(
    `${addon.data.config.addonRef}-mainWindow.ftl`,
  );

  // === Context Menu Item ===
  const menuId = "zotero-itemmenu";
  const menu = win.document.getElementById(menuId);
  if (menu) {
    const menuItemId = "seer-ai-datalab-ocr";
    let menuItem = win.document.getElementById(menuItemId) as XUL.MenuItem;
    if (!menuItem) {
      menuItem = win.document.createXULElement("menuitem") as XUL.MenuItem;
      menuItem.setAttribute("id", menuItemId);
      menuItem.setAttribute("label", "Extract with DataLab");
      menuItem.setAttribute("class", "menuitem-iconic");
      menuItem.addEventListener("command", async () => {
        await processSelectedItems();
      });
      menu.appendChild(menuItem);
    }

    // Handle visibility
    menu.addEventListener("popupshowing", () => {
      const items = Zotero.getActiveZoteroPane().getSelectedItems();
      const hasPdf = items.some(item => {
        if (item.isAttachment() && item.attachmentPath?.toLowerCase().endsWith(".pdf")) return true;
        if (item.isRegularItem()) {
          const pdf = dataLabService.getFirstPdfAttachment(item);
          return pdf !== null;
        }
        return false;
      });
      menuItem.hidden = !hasPdf;
    });
  }

  // === Toolbar Button ===
  const toolbarId = "zotero-items-toolbar";
  const toolbar = win.document.getElementById(toolbarId);
  if (toolbar) {
    const buttonId = "seer-ai-process-all-btn";
    let button = win.document.getElementById(buttonId) as XUL.ToolBarButton;
    if (!button) {
      button = win.document.createXULElement("toolbarbutton") as XUL.ToolBarButton;
      button.setAttribute("id", buttonId);
      button.setAttribute("label", "Process All PDFs");
      button.setAttribute("tooltiptext", "Extract text from all unprocessed PDFs in this library");
      button.addEventListener("command", async () => {
        await processAllLibraryItems();
      });
      toolbar.appendChild(button);
    }
  }
}

/**
 * Process selected items: collect unique parent items, skip those with existing notes.
 */
async function processSelectedItems() {
  const items = Zotero.getActiveZoteroPane().getSelectedItems();
  ztoolkit.log(`DataLab: Selected ${items.length} items`);

  // Collect unique parent items
  const parentIdSet = new Set<number>();
  const parentItems: Zotero.Item[] = [];

  for (const item of items) {
    let parentItem: Zotero.Item | null = null;
    let parentId: number | null = null;

    if (item.isAttachment() && item.attachmentPath?.toLowerCase().endsWith(".pdf")) {
      // Get parent of PDF
      if (item.parentID) {
        parentId = item.parentID;
        parentItem = Zotero.Items.get(parentId) as Zotero.Item;
        ztoolkit.log(`DataLab: PDF ${item.id} has parentID ${parentId}`);
      } else {
        // Top-level PDF - skip for now
        ztoolkit.log(`DataLab: PDF ${item.id} is top-level, skipping`);
        continue;
      }
    } else if (item.isRegularItem()) {
      parentId = item.id;
      parentItem = item;
      ztoolkit.log(`DataLab: Regular item ${item.id}`);
    }

    if (parentId && parentItem && !parentIdSet.has(parentId)) {
      ztoolkit.log(`DataLab: Checking parent ${parentId} (not yet in set)`);
      // Check if already has a note with matching title
      if (!dataLabService.hasExistingNote(parentItem)) {
        const pdf = dataLabService.getFirstPdfAttachment(parentItem);
        if (pdf) {
          parentIdSet.add(parentId);
          parentItems.push(parentItem);
          ztoolkit.log(`DataLab: Queued parent ${parentId} (${parentItem.getField("title")})`);
        }
      } else {
        // Still add to set to prevent re-checking
        parentIdSet.add(parentId);
        ztoolkit.log(`DataLab: Skipping ${parentId} - note already exists`);
      }
    } else if (parentId) {
      ztoolkit.log(`DataLab: Parent ${parentId} already in set, skipping`);
    }
  }

  ztoolkit.log(`DataLab: ${parentItems.length} unique parents to process`);
  if (parentItems.length === 0) {
    new ztoolkit.ProgressWindow("DataLab OCR").createLine({
      text: "No unprocessed items to extract.",
      progress: 100
    }).show();
    return;
  }

  await processParentItemsInBatches(parentItems);
}

/**
 * Process all items in the current library that have PDF attachments but no existing note.
 */
async function processAllLibraryItems() {
  const libraryID = Zotero.Libraries.userLibraryID;
  ztoolkit.log(`DataLab: Processing all PDFs in library ${libraryID}`);

  // Get all regular items in the library
  // @ts-ignore
  const allItems = await Zotero.Items.getAll(libraryID) as Zotero.Item[];
  const parentItems: Zotero.Item[] = [];

  for (const item of allItems) {
    if (!item.isRegularItem()) continue;

    // Check if has PDF and no existing note
    const pdf = dataLabService.getFirstPdfAttachment(item);
    if (pdf && !dataLabService.hasExistingNote(item)) {
      parentItems.push(item);
    }
  }

  ztoolkit.log(`DataLab: Found ${parentItems.length} items to process in library`);
  if (parentItems.length === 0) {
    new ztoolkit.ProgressWindow("DataLab OCR").createLine({
      text: "No unprocessed items found in library.",
      progress: 100
    }).show();
    return;
  }

  // Confirm with user
  const proceed = Zotero.getMainWindow().confirm(`Process ${parentItems.length} items? This may take a while.`);
  if (!proceed) return;

  await processParentItemsInBatches(parentItems);
}

/**
 * Process parent items in parallel batches.
 */
async function processParentItemsInBatches(parentItems: Zotero.Item[]) {
  const maxConcurrent = (Zotero.Prefs.get(`${addon.data.config.prefsPrefix}.datalabMaxConcurrent`) as number) || 5;
  ztoolkit.log(`DataLab: Processing ${parentItems.length} items with max concurrent ${maxConcurrent}`);

  for (let i = 0; i < parentItems.length; i += maxConcurrent) {
    const batch = parentItems.slice(i, i + maxConcurrent);
    ztoolkit.log(`DataLab: Processing batch ${Math.floor(i / maxConcurrent) + 1}`);
    await Promise.all(batch.map(parent => {
      const pdf = dataLabService.getFirstPdfAttachment(parent);
      if (pdf) {
        return dataLabService.convertToMarkdown(pdf);
      }
      return Promise.resolve();
    }));
  }
  ztoolkit.log(`DataLab: All batches complete`);
}


async function onMainWindowUnload(win: Window): Promise<void> {
  addon.data.ztoolkit.unregisterAll();
  addon.data.dialog?.window?.close();
}

function onShutdown(): void {
  addon.data.ztoolkit.unregisterAll();
  addon.data.dialog?.window?.close();
  // Remove addon object
  addon.data.alive = false;
  // @ts-expect-error - Plugin instance is not typed
  delete Zotero[addon.data.config.addonInstance];
}

// ... existing code ...

/**
 * This function is just an example of dispatcher for Notify events.
 * Any operations should be placed in a function to keep this funcion clear.
 */
async function onNotify(
  event: string,
  type: string,
  ids: Array<string | number>,
  extraData: { [key: string]: any },
) {
  // You can add your code to the corresponding notify type
  addon.data.ztoolkit.log("notify", event, type, ids, extraData);
}

/**
 * This function is just an example of dispatcher for Preference UI events.
 * Any operations should be placed in a function to keep this funcion clear.
 * @param type event type
 * @param data event data
 */
async function onPrefsEvent(type: string, data: { [key: string]: any }) {
  switch (type) {
    case "load":
      registerPrefsScripts(data.window);
      break;
    default:
      return;
  }
}

function onShortcuts(type: string) {
  // Handle shortcuts
}

function onDialogEvents(type: string) {
  // Handle dialog events
}

// Add your hooks here. For element click, etc.
// Keep in mind hooks only do dispatch. Don't add code that does real jobs in hooks.
// Otherwise the code would be hard to read and maintain.

export default {
  onStartup,
  onShutdown,
  onMainWindowLoad,
  onMainWindowUnload,
  onNotify,
  onPrefsEvent,
  onShortcuts,
  onDialogEvents,
};
