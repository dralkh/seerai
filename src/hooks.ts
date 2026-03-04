import { Assistant } from "./modules/assistant";
import { BasicExampleFactory } from "./modules/examples";
import { getString, initLocale } from "./utils/locale";
import { registerPrefsScripts } from "./modules/preferenceScript";
import { createZToolkit } from "./utils/ztoolkit";
import { OcrService } from "./modules/ocr";
import { initThemeObserver } from "./utils/theme";
import { registerApiEndpoints } from "./modules/api";
import { executeGenerateItemTags } from "./modules/chat/tools/tagTool";
import { defaultAgentConfig } from "./modules/chat/tools/toolTypes";
import { getActiveModelConfig } from "./modules/chat/modelConfig";
import { DetachedWindowManager } from "./modules/ui/windowManager";

const ocrService = new OcrService();

async function onStartup() {
  await Promise.all([
    Zotero.initializationPromise,
    Zotero.unlockPromise,
    Zotero.uiReadyPromise,
  ]);

  initLocale();

  Assistant.register();
  BasicExampleFactory.registerPrefs();

  // Register MCP API endpoints
  registerApiEndpoints();

  // Register global keyboard shortcut for detached window (Ctrl+Shift+S)
  DetachedWindowManager.registerShortcut();

  await Promise.all(
    Zotero.getMainWindows().map((win) => onMainWindowLoad(win)),
  );

  // Initialize detached window manager (restore previous state if any)
  DetachedWindowManager.initialize();

  // Mark initialized as true to confirm plugin loading status
  // outside of the plugin (e.g. scaffold testing process)
  addon.data.initialized = true;
}

async function onMainWindowLoad(win: _ZoteroTypes.MainWindow): Promise<void> {
  // Create ztoolkit for every window
  addon.data.ztoolkit = createZToolkit();

  addon.data.disconnectThemeObserver = initThemeObserver(win);

  win.MozXULElement.insertFTLIfNeeded(
    `${addon.data.config.addonRef}-mainWindow.ftl`,
  );

  // === Context Menu Item ===
  const menuId = "zotero-itemmenu";
  const menu = win.document.getElementById(menuId);
  if (menu) {
    const menuItemId = "seerai-datalab-ocr";

    // Generate Tags menu item
    const generateTagsMenuItemId = "seerai-generate-tags";
    let generateTagsMenuItem = win.document.getElementById(
      generateTagsMenuItemId,
    ) as XUL.MenuItem;
    if (!generateTagsMenuItem) {
      generateTagsMenuItem = win.document.createXULElement(
        "menuitem",
      ) as XUL.MenuItem;
      generateTagsMenuItem.setAttribute("id", generateTagsMenuItemId);
      generateTagsMenuItem.setAttribute("label", "✨ Generate Tags");
      generateTagsMenuItem.setAttribute("class", "menuitem-iconic");
      generateTagsMenuItem.addEventListener("command", async () => {
        await processGenerateTagsForSelectedItems();
      });
      menu.appendChild(generateTagsMenuItem);
    }

    // Extract with OCR menu item
    let menuItem = win.document.getElementById(menuItemId) as XUL.MenuItem;
    if (!menuItem) {
      menuItem = win.document.createXULElement("menuitem") as XUL.MenuItem;
      menuItem.setAttribute("id", menuItemId);
      menuItem.setAttribute("label", "🔍 Extract with ocr");
      menuItem.setAttribute("class", "menuitem-iconic");
      menuItem.addEventListener("command", async () => {
        await processSelectedItems();
      });
      menu.appendChild(menuItem);
    }

    // Search all PDF menu item
    const searchPdfMenuId = "seerai-search-pdf";
    let searchPdfMenu = win.document.getElementById(
      searchPdfMenuId,
    ) as XUL.MenuItem;
    if (!searchPdfMenu) {
      searchPdfMenu = win.document.createXULElement("menuitem") as XUL.MenuItem;
      searchPdfMenu.setAttribute("id", searchPdfMenuId);
      searchPdfMenu.setAttribute("label", "🔍 Search all PDF");
      searchPdfMenu.setAttribute("class", "menuitem-iconic");
      searchPdfMenu.addEventListener("command", async () => {
        await searchPdfsForSelectedItems();
      });
      menu.appendChild(searchPdfMenu);
    }

    // Add to Table menu item
    const addToTableMenuId = "seerai-add-to-table";
    let addToTableMenu = win.document.getElementById(
      addToTableMenuId,
    ) as XUL.MenuItem;
    if (!addToTableMenu) {
      addToTableMenu = win.document.createXULElement(
        "menuitem",
      ) as XUL.MenuItem;
      addToTableMenu.setAttribute("id", addToTableMenuId);
      addToTableMenu.setAttribute("label", "📅 Add to Table");
      addToTableMenu.setAttribute("class", "menuitem-iconic");
      addToTableMenu.addEventListener("command", async () => {
        const items = Zotero.getActiveZoteroPane().getSelectedItems();
        await Assistant.addItemsToCurrentTable(items);
      });
      menu.appendChild(addToTableMenu);
    }

    // Remove from Table menu item
    const removeFromTableMenuId = "seerai-remove-from-table";
    let removeFromTableMenu = win.document.getElementById(
      removeFromTableMenuId,
    ) as XUL.MenuItem;
    if (!removeFromTableMenu) {
      removeFromTableMenu = win.document.createXULElement(
        "menuitem",
      ) as XUL.MenuItem;
      removeFromTableMenu.setAttribute("id", removeFromTableMenuId);
      removeFromTableMenu.setAttribute("label", "🔴 Remove from Tables");
      removeFromTableMenu.setAttribute("class", "menuitem-iconic");
      removeFromTableMenu.addEventListener("command", async () => {
        const items = Zotero.getActiveZoteroPane().getSelectedItems();
        await Assistant.removeItemsFromCurrentTable(items);
      });
      menu.appendChild(removeFromTableMenu);
    }

    // Handle visibility
    menu.addEventListener("popupshowing", () => {
      const items = Zotero.getActiveZoteroPane().getSelectedItems();
      const hasPdf = items.some((item) => {
        if (
          item.isAttachment() &&
          item.attachmentPath?.toLowerCase().endsWith(".pdf")
        )
          return true;
        if (item.isRegularItem()) {
          const pdf = ocrService.getFirstPdfAttachment(item);
          return pdf !== null;
        }
        return false;
      });
      menuItem.hidden = !hasPdf;

      // Show search PDF menu for items without PDF but with identifiers or title
      const hasItemsWithoutPdf = items.some((item) => {
        if (!item.isRegularItem()) return false;
        const attachments = item.getAttachments() || [];
        const hasPdfAttachment = attachments.some((attId: number) => {
          const att = Zotero.Items.get(attId);
          return (
            att &&
            (att.attachmentContentType === "application/pdf" ||
              att.attachmentPath?.toLowerCase().endsWith(".pdf"))
          );
        });
        if (hasPdfAttachment) return false;
        // Check for title (for SS title search + Firecrawl) OR identifiers
        const title = item.getField("title");
        const doi = item.getField("DOI");
        const extra = (item.getField("extra") as string) || "";
        const hasArxiv = /arxiv:/i.test(extra);
        const hasPmid = /pmid:/i.test(extra);
        return !!(title || doi || hasArxiv || hasPmid);
      });
      searchPdfMenu.hidden = !hasItemsWithoutPdf;

      // Table Actions Visibility
      const isRegularSelection = items.some((item) => item.isRegularItem());
      addToTableMenu.hidden = !isRegularSelection;

      const anyInTable = items.some((item) =>
        Assistant.isItemInCurrentTable(item.id),
      );
      removeFromTableMenu.hidden = !isRegularSelection || !anyInTable;

      // Generate Tags Visibility
      // Show for regular items (same as "Extract with OCR" roughly, but broader)
      generateTagsMenuItem.hidden = !isRegularSelection;
    });
  }

  // === Toolbar Button ===
  const toolbarId = "zotero-items-toolbar";
  const toolbar = win.document.getElementById(toolbarId);
  if (toolbar) {
    const buttonId = "seerai-process-all-btn";
    let button = win.document.getElementById(buttonId) as XUL.ToolBarButton;
    if (!button) {
      button = win.document.createXULElement(
        "toolbarbutton",
      ) as XUL.ToolBarButton;
      button.setAttribute("id", buttonId);
      button.setAttribute("label", "Process All PDFs");
      button.setAttribute(
        "tooltiptext",
        "Extract text from all unprocessed PDFs in this library",
      );
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

    if (
      item.isAttachment() &&
      item.attachmentPath?.toLowerCase().endsWith(".pdf")
    ) {
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
      if (!ocrService.hasExistingNote(parentItem)) {
        const pdf = ocrService.getFirstPdfAttachment(parentItem);
        if (pdf) {
          parentIdSet.add(parentId);
          parentItems.push(parentItem);
          ztoolkit.log(
            `DataLab: Queued parent ${parentId} (${parentItem.getField("title")})`,
          );
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
    new ztoolkit.ProgressWindow("DataLab OCR")
      .createLine({
        text: "No unprocessed items to extract.",
        progress: 100,
      })
      .show();
    return;
  }

  await processParentItemsInBatches(parentItems);
}

/**
 * Search for PDFs for selected items that don't have PDF attachments
 * Uses concurrent processing with timeout, retry, and Semantic Scholar title search
 */
async function searchPdfsForSelectedItems() {
  const items = Zotero.getActiveZoteroPane().getSelectedItems();
  ztoolkit.log(`Search PDF: Selected ${items.length} items`);

  // Filter items without PDF but with identifiers OR title (for SS title search)
  const itemsToSearch: Zotero.Item[] = [];

  for (const item of items) {
    if (!item.isRegularItem()) continue;

    // Check if has PDF already
    const attachments = item.getAttachments() || [];
    const hasPdf = attachments.some((attId: number) => {
      const att = Zotero.Items.get(attId);
      return (
        att &&
        (att.attachmentContentType === "application/pdf" ||
          att.attachmentPath?.toLowerCase().endsWith(".pdf"))
      );
    });

    if (!hasPdf) {
      // Check for identifiers OR title (title enables SS search to discover DOI)
      const title = item.getField("title") as string;
      const doi = item.getField("DOI");
      const extra = (item.getField("extra") as string) || "";
      const hasArxiv = /arxiv:/i.test(extra);
      const hasPmid = /pmid:/i.test(extra);

      // Accept if has any identifier OR just a title (for SS discovery)
      if (doi || hasArxiv || hasPmid || title) {
        itemsToSearch.push(item);
      }
    }
  }

  ztoolkit.log(`Search PDF: ${itemsToSearch.length} items to search`);
  if (itemsToSearch.length === 0) {
    new ztoolkit.ProgressWindow("Search PDF")
      .createLine({
        text: "No items without PDF to search.",
        progress: 100,
      })
      .show();
    return;
  }

  // Import concurrent runner and PDF finder
  const { findAndAttachPdfForItem } = await import("./modules/assistant");
  const { runConcurrentTasks, formatTaskStats } =
    await import("./utils/concurrentRunner");

  // Create progress window using native Zotero.ProgressWindow for proper close behavior
  const pw = new Zotero.ProgressWindow({ closeOnClick: true });
  pw.changeHeadline("Search PDF");
  pw.addDescription(`Searching ${itemsToSearch.length} items...`);
  pw.show();

  // Get settings
  const activeConfig = getActiveModelConfig();
  let concurrency = 5;
  if (activeConfig?.rateLimit?.type === "concurrency") {
    concurrency = activeConfig.rateLimit.value;
  } else if (activeConfig?.rateLimit?.type === "rpm") {
    // For RPM, we limit concurrency to the RPM value (capped at 10)
    // This prevents a huge queue buildup that causes timeouts.
    // e.g. if RPM is 2, running 10 parallel tasks ensures the 10th waits ~5 minutes!
    // By matching concurrency to RPM, we ensure a smooth flow with minimal waiting.
    concurrency = Math.max(1, Math.min(10, activeConfig.rateLimit.value));
  } else if (activeConfig?.rateLimit?.type === "tpm") {
    concurrency = 10;
  }

  // Run concurrent search
  const results = await runConcurrentTasks({
    tasks: itemsToSearch.map((item, index) => ({ item, index })),
    concurrency,
    maxRetries: 3,
    retryDelayMs: 2000,

    onProgress: (stats) => {
      pw.changeHeadline(`🔍 ${formatTaskStats(stats)}`);
    },

    executor: async (task) => {
      const success = await findAndAttachPdfForItem(task.item);
      return success;
    },

    onTaskError: (task, error, _index, willRetry) => {
      if (willRetry) {
        ztoolkit.log(`Search PDF: Retrying ${task.item.id}: ${error.message}`);
      } else {
        ztoolkit.log(`Search PDF: Failed ${task.item.id}: ${error.message}`);
      }
    },
  });

  // Calculate stats
  const succeeded = results.filter(
    (r) => r.status === "success" && r.result === true,
  ).length;
  const notFound = results.filter(
    (r) => r.status === "success" && r.result === false,
  ).length;
  const failed = results.filter((r) => r.status === "failed").length;

  ztoolkit.log(
    `Search PDF: Done! ${succeeded} found, ${notFound} not found, ${failed} failed`,
  );

  // Show final result
  pw.changeHeadline("Search Complete");
  pw.addDescription(`✓ ${succeeded}📄 found, ${notFound + failed} not found`);
  pw.startCloseTimer(3000);
}

/**
 * Process all items in the current library that have PDF attachments but no existing note.
 */
async function processAllLibraryItems() {
  const libraryID = Zotero.Libraries.userLibraryID;
  ztoolkit.log(`DataLab: Processing all PDFs in library ${libraryID}`);

  // Get all regular items in the library
  // @ts-ignore
  const allItems = (await Zotero.Items.getAll(libraryID)) as Zotero.Item[];
  const parentItems: Zotero.Item[] = [];

  for (const item of allItems) {
    if (!item.isRegularItem()) continue;

    // Check if has PDF and no existing note
    const pdf = ocrService.getFirstPdfAttachment(item);
    if (pdf && !ocrService.hasExistingNote(item)) {
      parentItems.push(item);
    }
  }

  ztoolkit.log(
    `DataLab: Found ${parentItems.length} items to process in library`,
  );
  if (parentItems.length === 0) {
    new ztoolkit.ProgressWindow("DataLab OCR")
      .createLine({
        text: "No unprocessed items found in library.",
        progress: 100,
      })
      .show();
    return;
  }

  // Confirm with user
  const proceed = Zotero.getMainWindow().confirm(
    `Process ${parentItems.length} items? This may take a while.`,
  );
  if (!proceed) return;

  await processParentItemsInBatches(parentItems);
}

/**
 * Process parent items in parallel batches.
 */
async function processParentItemsInBatches(parentItems: Zotero.Item[]) {
  const activeConfig = getActiveModelConfig();
  let maxConcurrent = 5;
  if (activeConfig?.rateLimit?.type === "concurrency") {
    maxConcurrent = activeConfig.rateLimit.value;
  } else if (activeConfig?.rateLimit?.type === "rpm") {
    maxConcurrent = Math.max(1, Math.min(10, activeConfig.rateLimit.value));
  } else if (activeConfig?.rateLimit?.type === "tpm") {
    maxConcurrent = 10;
  }
  ztoolkit.log(
    `DataLab: Processing ${parentItems.length} items with max concurrent ${maxConcurrent}`,
  );

  for (let i = 0; i < parentItems.length; i += maxConcurrent) {
    const batch = parentItems.slice(i, i + maxConcurrent);
    ztoolkit.log(
      `DataLab: Processing batch ${Math.floor(i / maxConcurrent) + 1}`,
    );
    await Promise.all(
      batch.map((parent) => {
        const pdf = ocrService.getFirstPdfAttachment(parent);
        if (pdf) {
          return ocrService.convertToMarkdown(pdf);
        }
        return Promise.resolve();
      }),
    );
  }
  ztoolkit.log(`DataLab: All batches complete`);
  ztoolkit.log(`DataLab: All batches complete`);
}

/**
 * Process selected items to generate tags
 */
async function processGenerateTagsForSelectedItems() {
  const items = Zotero.getActiveZoteroPane().getSelectedItems();
  const regularItems = items.filter((i) => i.isRegularItem());

  if (regularItems.length === 0) {
    return;
  }

  const activeModel = getActiveModelConfig();
  if (!activeModel) {
    Zotero.getMainWindow().alert(
      "Please configure an AI model in settings first.",
    );
    return;
  }

  const pw = new ztoolkit.ProgressWindow("Generate Tags");
  pw.show();

  let successCount = 0;
  let errorCount = 0;
  let skippedCount = 0;

  for (const item of regularItems) {
    const title = item.getField("title");
    const line = pw.createLine({
      text: `Generating tags for "${title}"...`,
      progress: -1,
      icon: "default",
    });

    // Skip if already tagged by Seer AI
    if (item.hasTag("Seerai-Tagged")) {
      line.changeLine({
        text: `Skipped "${title}" (Already tagged)`,
        progress: 100,
        icon: "default",
      });
      skippedCount++;
      continue;
    }

    try {
      const result = await executeGenerateItemTags(
        { item_id: item.id },
        defaultAgentConfig,
      );

      if (result.success) {
        line.changeLine({
          text: `Tags generated for "${title}"`,
          progress: 100,
          icon: "default",
        });
        successCount++;
      } else {
        line.changeLine({
          text: `Error for "${title}": ${result.error}`,
          progress: 100,
          icon: "warning",
        });
        errorCount++;
      }
    } catch (e: any) {
      line.changeLine({
        text: `Error for "${title}": ${e.message || e}`,
        progress: 100,
        icon: "warning",
      });
      errorCount++;
    }
  }

  pw.createLine({
    text: `Complete: ${successCount} processed, ${skippedCount} skipped, ${errorCount} errors.`,
    progress: 100,
  });
}

async function onMainWindowUnload(win: Window): Promise<void> {
  addon.data.disconnectThemeObserver?.();
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
