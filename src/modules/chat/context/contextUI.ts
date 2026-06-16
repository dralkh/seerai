import { ChatContextManager } from "./contextManager";
import {
  CONTEXT_COLORS,
  CONTEXT_ICONS,
  ContextItem,
  ContextItemType,
} from "./contextTypes";
import { Assistant } from "../../assistant";
import { getTableStore } from "../tableStore";
import { getMessageStore } from "../messageStore";
import { removeDriveContextFileItem } from "../../drive/cloudContext";
import { getWorkspaceStore } from "../workspace/store";
import { convertDocxToMarkdown } from "../../docxConverter";
import { stripBase64Data } from "../imageUtils";
import { createSvgIcon, type IconName } from "../ui/icons";

let _lastContextChipsListener: ((items: ContextItem[]) => void) | null = null;

function truncateWords(text: string, maxWords: number): string {
  const words = text.trim().split(/\s+/);
  if (words.length <= maxWords) return text;
  return words.slice(0, maxWords).join(" ") + "...";
}

/**
 * Creates the unified context chips area element.
 * Subscribes to ChatContextManager updates.
 */
export function createContextChipsArea(doc: Document): HTMLElement {
  const contextManager = ChatContextManager.getInstance();

  if (_lastContextChipsListener) {
    contextManager.removeListener(_lastContextChipsListener);
    _lastContextChipsListener = null;
  }

  const container = doc.createElement("div");
  container.id = "unified-context-chips";
  container.style.display = "none";
  container.style.flexWrap = "wrap";
  container.style.gap = "6px";
  container.style.padding = "8px";
  container.style.backgroundColor = "var(--background-secondary, #f5f5f5)";
  container.style.borderRadius = "6px";
  container.style.border = "1px solid var(--border-primary, #ddd)";
  container.style.marginBottom = "6px";
  container.style.minWidth = "0";
  container.style.maxWidth = "100%";
  container.style.boxSizing = "border-box";

  // Label Container (Header)
  const header = doc.createElement("div");
  header.style.width = "100%";
  header.style.display = "flex";
  header.style.justifyContent = "space-between";
  header.style.alignItems = "center";
  header.style.marginBottom = "6px";

  // Label Text
  const label = doc.createElement("span");
  label.style.cssText =
    "font-size: 11px; color: var(--text-secondary, #666); font-weight: 600; display: inline-flex; align-items: center; gap: 4px;";
  const labelIcon = createSvgIcon(doc, "attachment", {
    size: 12,
    strokeWidth: 1.8,
  });
  const labelText = doc.createElement("span");
  labelText.textContent = "Context:";
  label.appendChild(labelIcon);
  label.appendChild(labelText);
  header.appendChild(label);

  // Token Usage Container (placed in middle)
  const tokenContainer = doc.createElement("div");
  tokenContainer.style.display = "flex";
  tokenContainer.style.gap = "12px";
  tokenContainer.style.marginLeft = "12px";
  tokenContainer.style.marginRight = "auto"; // Push Clear All to the right

  const contextTokens = doc.createElement("span");
  contextTokens.id = "context-tokens-display";
  contextTokens.style.fontSize = "10px";
  contextTokens.style.color = "var(--text-tertiary, #888)";
  contextTokens.innerText = "Context: ...";

  const cumulativeTokens = doc.createElement("span");
  cumulativeTokens.id = "cumulative-tokens-display";
  cumulativeTokens.style.fontSize = "10px";
  cumulativeTokens.style.color = "var(--text-tertiary, #888)";
  cumulativeTokens.innerText = "Total: ...";

  tokenContainer.appendChild(contextTokens);
  tokenContainer.appendChild(cumulativeTokens);
  header.appendChild(tokenContainer);

  // Button container for Clear All and Copy
  const btnContainer = doc.createElement("div");
  btnContainer.style.display = "flex";
  btnContainer.style.gap = "12px";

  // Copy Button
  const copyBtn = doc.createElement("span");
  copyBtn.id = "context-copy-btn";
  copyBtn.style.cssText =
    "font-size: 10px; color: var(--text-tertiary, #888); cursor: pointer; text-decoration: underline; opacity: 0.8; display: inline-flex; align-items: center; gap: 3px;";
  const copyIcon = createSvgIcon(doc, "copy", { size: 10, strokeWidth: 1.8 });
  const copyLabel = doc.createElement("span");
  copyLabel.textContent = "Copy";
  copyBtn.appendChild(copyIcon);
  copyBtn.appendChild(copyLabel);
  copyBtn.title = "Copy all context items content to clipboard";
  copyBtn.addEventListener("mouseenter", () => (copyBtn.style.opacity = "1"));
  copyBtn.addEventListener("mouseleave", () => (copyBtn.style.opacity = "0.8"));
  copyBtn.addEventListener("click", async () => {
    await copyContextItemsContent(copyBtn, copyIcon, copyLabel);
  });
  btnContainer.appendChild(copyBtn);

  // Clear All Button
  const clearBtn = doc.createElement("span");
  clearBtn.innerText = "Clear All";
  clearBtn.style.fontSize = "10px";
  clearBtn.style.color = "var(--text-tertiary, #888)";
  clearBtn.style.cursor = "pointer";
  clearBtn.style.textDecoration = "underline";
  clearBtn.style.opacity = "0.8";
  clearBtn.addEventListener("mouseenter", () => (clearBtn.style.opacity = "1"));
  clearBtn.addEventListener(
    "mouseleave",
    () => (clearBtn.style.opacity = "0.8"),
  );
  clearBtn.addEventListener("click", () => {
    ChatContextManager.getInstance().clearAll();
  });
  btnContainer.appendChild(clearBtn);

  header.appendChild(btnContainer);

  container.appendChild(header);

  // Initial listener — store ref for cleanup to avoid stale listeners
  _lastContextChipsListener = (items) => {
    updateChips(doc, container, label, items);
  };
  contextManager.addListener(_lastContextChipsListener);

  return container;
}

function updateChips(
  doc: Document,
  container: HTMLElement,
  label: HTMLElement,
  items: ContextItem[],
) {
  // Clear existing chips (keep header which is firstChild)
  while (container.childNodes.length > 1) {
    container.removeChild(container.lastChild as Node);
  }

  if (items.length === 0) {
    container.style.display = "none";
    return;
  }

  container.style.display = "flex";
  const labelText = label.querySelector("span") as HTMLElement | null;
  if (labelText) {
    labelText.textContent = `Context (${items.length}):`;
  }

  items.forEach((item, index) => {
    const chip = doc.createElement("div");
    const color = CONTEXT_COLORS[item.type] || "#007AFF";

    chip.style.display = "flex";
    chip.style.flexWrap = "wrap";
    chip.style.alignItems = "center";
    chip.style.gap = "4px";
    chip.style.padding = "4px 8px";
    chip.style.backgroundColor = color;
    chip.style.color = "#fff";
    chip.style.borderRadius = "12px";
    chip.style.fontSize = "11px";
    chip.style.fontWeight = "500";
    chip.style.cursor = "pointer";
    chip.style.maxWidth = "100%";
    chip.style.boxShadow = "0 1px 2px rgba(0,0,0,0.1)";

    // Icon + Name in a wrapping span for multi-line text
    const iconName: IconName = CONTEXT_ICONS[item.type] || "tag";
    const providerIcon = item.metadata?.providerIcon as string | undefined;
    const useProviderIcon =
      item.type === "file" &&
      item.metadata?.driveFileId &&
      providerIcon &&
      (providerIcon.startsWith("http") || providerIcon.startsWith("/"));

    const chipText = doc.createElement("span");
    chipText.style.cssText =
      "min-width: 0; flex: 1 1 auto; white-space: normal; word-break: break-word; overflow-wrap: break-word; display: inline-flex; align-items: center; gap: 4px;";
    if (useProviderIcon) {
      const providerImg = doc.createElement("img") as HTMLImageElement;
      providerImg.src = providerIcon as string;
      providerImg.style.cssText =
        "width: 12px; height: 12px; flex-shrink: 0; object-fit: contain;";
      chipText.appendChild(providerImg);
    } else {
      chipText.appendChild(
        createSvgIcon(doc, iconName, { size: 12, strokeWidth: 1.8 }),
      );
    }
    const truncatedName = truncateWords(item.displayName, 4);
    const nameSpan = doc.createElement("span");
    nameSpan.textContent = truncatedName;
    chipText.appendChild(nameSpan);
    chipText.title = `${item.fullName || item.displayName} (${item.type})`;

    // Click to navigate in Zotero
    chipText.addEventListener("click", (e) => {
      e.stopPropagation();
      if (item.type === "paper" || item.type === "collection") {
        const id = Number(item.id);
        if (!isNaN(id)) {
          const zp = Zotero.getActiveZoteroPane();
          if (zp) {
            if (item.type === "collection") {
              try {
                (zp as any).loadCollection(id);
              } catch {
                zp.selectItem(id);
              }
            } else {
              zp.selectItem(id);
            }
          }
        }
      }
    });

    // For file items, build a richer tooltip with size/token details
    if (item.type === "file" && item.metadata) {
      const fileSize = item.metadata.fileSize as number | undefined;
      const estimatedTokens = item.metadata.estimatedTokens as
        | number
        | undefined;
      const fileCategory = item.metadata.fileCategory as string | undefined;
      const extractionError = item.metadata.extractionError as
        | string
        | undefined;
      const parts: string[] = [item.fullName || item.displayName];
      if (fileSize) {
        const sizeStr =
          fileSize >= 1_000_000
            ? `${(fileSize / 1_000_000).toFixed(1)}MB`
            : fileSize >= 1_000
              ? `${(fileSize / 1_000).toFixed(1)}KB`
              : `${fileSize}B`;
        parts.push(`Size: ${sizeStr}`);
      }
      if (estimatedTokens && estimatedTokens > 0) {
        const tokStr =
          estimatedTokens >= 1000
            ? `~${(estimatedTokens / 1000).toFixed(1)}k`
            : `~${estimatedTokens}`;
        parts.push(`Tokens: ${tokStr}`);
      }
      if (fileCategory === "audio") parts.push("(transcribed)");
      if (extractionError) parts.push(`Error: ${extractionError}`);
      chipText.title = parts.join(" | ");
    }
    chip.appendChild(chipText);

    // Remove Button
    const removeBtn = doc.createElement("span");
    removeBtn.title = "Remove from context";
    removeBtn.setAttribute("aria-label", "Remove from context");
    removeBtn.style.cssText =
      "margin-left: 6px; cursor: pointer; opacity: 0.8; font-size: 10px; display: inline-flex; align-items: center;";
    removeBtn.appendChild(
      createSvgIcon(doc, "close", { size: 10, strokeWidth: 1.8 }),
    );

    removeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const driveFileId = item.metadata?.driveFileId as string | undefined;
      const driveProvider = item.metadata?.provider as string | undefined;
      ChatContextManager.getInstance().removeAtIndex(index);
      if (driveFileId && driveProvider) {
        const chatId = getMessageStore().getConversationId();
        if (chatId) {
          removeDriveContextFileItem(chatId, driveFileId, driveProvider);
        }
      }
    });

    removeBtn.addEventListener("mouseenter", () => {
      removeBtn.style.opacity = "1";
    });
    removeBtn.addEventListener("mouseleave", () => {
      removeBtn.style.opacity = "0.8";
    });

    chip.appendChild(removeBtn);
    container.appendChild(chip);
  });
}

/**
 * Copy all context items content to clipboard.
 * Resolves collections, tags, authors, and tables into their full content
 * (mirroring what the chat actually sends to the model).
 */
async function copyContextItemsContent(
  copyBtn: HTMLElement,
  copyIcon: SVGElement,
  copyLabel: HTMLElement,
): Promise<void> {
  const contextManager = ChatContextManager.getInstance();
  const items = contextManager.getItems();

  if (items.length === 0) {
    Zotero.debug("[seerai] No context items to copy");
    return;
  }

  const parts: string[] = [];
  parts.push(`# Context Items (${items.length} items)\n`);

  /**
   * Helper: format a single Zotero paper item into markdown with full content.
   */
  const formatPaperItem = async (zoteroItem: Zotero.Item): Promise<string> => {
    const lines: string[] = [];

    const title = zoteroItem.getField("title") as string;
    const authors = zoteroItem
      .getCreators()
      .map((c) => `${c.firstName || ""} ${c.lastName || ""}`.trim())
      .join(", ");
    const year = zoteroItem.getField("year") as string;
    const doi = zoteroItem.getField("DOI") as string;

    if (title) lines.push(`**Title:** ${title}`);
    if (authors) lines.push(`**Authors:** ${authors}`);
    if (year) lines.push(`**Year:** ${year}`);
    if (doi) lines.push(`**DOI:** ${doi}`);

    const abstract = zoteroItem.getField("abstractNote") as string;
    if (abstract) lines.push(`**Abstract:** ${abstract}`);

    // Get content (notes + PDF text)
    try {
      const content = await Assistant.getPdfTextForItem(
        zoteroItem,
        0,
        false,
        true,
      );
      if (content) {
        lines.push(`\n### Content:\n${content}`);
      }
    } catch (e) {
      lines.push(`\n*Error retrieving content: ${e}*`);
    }

    return lines.join("\n");
  };

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    parts.push(`\n## ${i + 1}. ${item.displayName} (${item.type})\n`);

    try {
      if (item.type === "paper") {
        const zoteroItem = Zotero.Items.get(item.id as number);
        if (zoteroItem) {
          parts.push(await formatPaperItem(zoteroItem));
        }
      } else if (item.type === "table") {
        // Resolve full table data — same as what chat sends
        const storedTables = await getTableStore().getAllTables();
        const tableConfig = storedTables.find((t) => t.id === item.id);
        if (tableConfig) {
          const columnNames = tableConfig.columns
            .map((c: any) => c.name || c.title || c.id)
            .join(", ");
          parts.push(`**Table:** ${tableConfig.name}`);
          parts.push(`**Columns:** ${columnNames}`);
          parts.push(`**Total papers:** ${tableConfig.addedPaperIds.length}\n`);

          const generatedData = tableConfig.generatedData || {};

          for (const paperId of tableConfig.addedPaperIds) {
            const zoteroItem = Zotero.Items.get(paperId);
            if (!zoteroItem) continue;

            const title =
              (zoteroItem.getField("title") as string) || "Untitled";
            const creators = zoteroItem.getCreators();
            const authorStr =
              creators.length > 0
                ? creators
                    .map((c: any) => c.lastName || c.name)
                    .slice(0, 3)
                    .join(", ") + (creators.length > 3 ? " et al." : "")
                : "";
            const year =
              (zoteroItem.getField("year") as string) ||
              (zoteroItem.getField("date") as string)?.substring(0, 4) ||
              "";

            parts.push(`\n### ${title}`);
            if (authorStr) parts.push(`**Authors:** ${authorStr}`);
            if (year) parts.push(`**Year:** ${year}`);

            // Generated column values
            const paperData = generatedData[paperId];
            if (paperData && Object.keys(paperData).length > 0) {
              for (const column of tableConfig.columns) {
                if (["title", "author", "year", "sources"].includes(column.id))
                  continue;
                const value = paperData[column.id];
                if (value) {
                  parts.push(`**${column.name || column.id}:** ${value}`);
                }
              }
            }
          }
        } else {
          parts.push(`*Table not found*`);
        }
      } else if (item.type === "file") {
        // For files, include the content (lazy-resolve workspace files from disk)
        const filename =
          (item.metadata?.filename as string) || item.displayName;
        const workspacePath = item.metadata?.workspacePath as
          | string
          | undefined;

        let resolvedContent: string | undefined;
        if (workspacePath) {
          try {
            const store = getWorkspaceStore();
            const absPath = PathUtils.join(store.workspaceDir, workspacePath);
            if (absPath.toLowerCase().endsWith(".docx")) {
              const raw = await Zotero.File.getBinaryContentsAsync(absPath);
              const ab = raw as unknown as ArrayBuffer;
              const result = await convertDocxToMarkdown(ab);
              resolvedContent = stripBase64Data(result.markdown);
            } else {
              const raw = await IOUtils.read(absPath);
              resolvedContent = stripBase64Data(new TextDecoder().decode(raw));
            }
          } catch (e) {
            Zotero.debug(
              `[seerai] Failed to resolve workspace file for copy: ${e}`,
            );
          }
        }

        const charCount = item.metadata?.charCount as number | undefined;
        const extractedContent = item.metadata?.extractedContent as
          | string
          | undefined;
        const extractionError = item.metadata?.extractionError as
          | string
          | undefined;
        const category = item.metadata?.fileCategory as string | undefined;

        const content =
          resolvedContent ??
          (extractedContent ? stripBase64Data(extractedContent) : undefined);

        if (content && content.length > 0) {
          const typeLabel =
            category === "audio" ? "Audio transcription" : "File";
          parts.push(
            `*${typeLabel}: ${filename} (${charCount ?? content.length} chars)*\n`,
          );
          parts.push(`### Content:\n${content}`);
        } else {
          parts.push(
            `*File: ${filename} — ${extractionError || "no content extracted"}*`,
          );
        }
      } else if (
        item.type === "collection" ||
        item.type === "tag" ||
        item.type === "author"
      ) {
        // Resolve to actual papers and include their full content
        const resolvedIds = await Assistant.resolveContextItemToIds(item);

        const typeLabel =
          item.type === "collection"
            ? "Collection"
            : item.type === "tag"
              ? "Tag"
              : "Author";
        parts.push(
          `*${typeLabel}: ${item.displayName} (${resolvedIds.length} papers)*\n`,
        );

        if (resolvedIds.length === 0) {
          parts.push(`*(No papers found)*`);
        } else {
          for (const itemID of resolvedIds) {
            const zoteroItem = Zotero.Items.get(itemID);
            if (!zoteroItem || !zoteroItem.isRegularItem()) continue;
            parts.push(`\n---\n`);
            parts.push(await formatPaperItem(zoteroItem));
          }
        }
      } else if (item.type === "topic") {
        parts.push(
          `*Topic: ${item.displayName}*\n\n(Focus area — no paper content)`,
        );
      } else {
        parts.push(`*${item.type}: ${item.displayName}*`);
        if (item.metadata) {
          parts.push(`Metadata: ${JSON.stringify(item.metadata, null, 2)}`);
        }
      }
    } catch (e) {
      parts.push(`*Error retrieving content: ${e}*\n`);
    }
  }

  const fullContent = parts.join("\n");

  // Copy to clipboard
  try {
    // Check if we're in a browser environment with clipboard API
    if (typeof navigator !== "undefined" && navigator.clipboard) {
      await navigator.clipboard.writeText(fullContent);
      Zotero.debug(
        `[seerai] Copied ${items.length} context items to clipboard (${fullContent.length} chars)`,
      );

      // Show success feedback
      showCopyFeedback(copyBtn, copyIcon, copyLabel, true);
    } else {
      // Fallback for older environments (Zotero/Firefox)
      // @ts-expect-error - Firefox XPCOM API
      const clipboard = Components.classes[
        "@mozilla.org/widget/clipboardhelper;1"
      ].getService(Components.interfaces.nsIClipboardHelper);
      clipboard.copyString(fullContent);
      Zotero.debug(
        `[seerai] Copied ${items.length} context items to clipboard (legacy, ${fullContent.length} chars)`,
      );

      // Show success feedback
      showCopyFeedback(copyBtn, copyIcon, copyLabel, true);
    }
  } catch (e) {
    Zotero.debug(`[seerai] Error copying to clipboard: ${e}`);

    // Show error feedback
    showCopyFeedback(copyBtn, copyIcon, copyLabel, false);
  }
}

function showCopyFeedback(
  copyBtn: HTMLElement,
  copyIcon: SVGElement,
  copyLabel: HTMLElement,
  success: boolean,
) {
  const doc = copyBtn.ownerDocument!;
  copyIcon.replaceChildren();
  if (success) {
    copyIcon.appendChild(
      createSvgIcon(doc, "check", {
        size: 10,
        strokeWidth: 1.8,
      }),
    );
  } else {
    copyIcon.appendChild(
      createSvgIcon(doc, "x", {
        size: 10,
        strokeWidth: 1.8,
      }),
    );
  }
  copyBtn.style.color = success
    ? "var(--accent-green, #34C759)"
    : "var(--accent-red, #FF3B30)";
  const originalLabel = copyLabel.textContent || "";
  copyLabel.textContent = success ? "Copied!" : "Failed";
  setTimeout(() => {
    copyIcon.replaceChildren(
      createSvgIcon(doc, "copy", {
        size: 10,
        strokeWidth: 1.8,
      }),
    );
    copyLabel.textContent = originalLabel;
    copyBtn.style.color = "var(--text-tertiary, #888)";
  }, 2000);
}
