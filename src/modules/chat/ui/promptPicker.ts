/**
 * Prompt Picker UI
 * Modal/popover for browsing and selecting prompt templates
 */

const HTML_NS = "http://www.w3.org/1999/xhtml";

import {
  PromptTemplate,
  PromptCategory,
  loadPrompts,
  searchPrompts,
  addPrompt,
  updatePrompt,
  deletePrompt,
  getCategoryIcon,
  getCategoryLabel,
  CATEGORY_LABELS,
} from "../promptLibrary";

// ==================== Types ====================

interface PromptPickerOptions {
  onSelect: (template: PromptTemplate) => void;
  onClose?: () => void;
  initialCategory?: PromptCategory;
}

// ==================== Main Picker ====================

// Track active anchor for toggle logic
let activePickerAnchor: HTMLElement | null = null;

/**
 * Show the prompt picker popover
 */
export async function showPromptPicker(
  doc: Document,
  anchorEl: HTMLElement,
  options: PromptPickerOptions,
): Promise<void> {
  // Check if we are toggling the same button
  const existing = doc.querySelector(".prompt-picker-container");
  if (existing) {
    existing.remove();
    const wasActive = activePickerAnchor === anchorEl;
    activePickerAnchor = null;

    if (wasActive) {
      return;
    }
  }

  activePickerAnchor = anchorEl;

  // Create container — use fixed positioning like chatSettings
  const container = doc.createElement("div");
  container.className = "prompt-picker-container";
  container.style.cssText = `
        position: fixed;
        width: 380px;
        max-height: 480px;
        background: var(--background-primary);
        border: 1px solid var(--border-primary);
        border-radius: 10px;
        box-shadow: 0 8px 32px rgba(0,0,0,0.2);
        display: flex;
        flex-direction: column;
        overflow: hidden;
        z-index: 10003;
    `;

  const rect = anchorEl.getBoundingClientRect();
  const win = doc.defaultView || ({} as Window);
  const winHeight = (win as any).innerHeight || 800;

  container.style.bottom = `${winHeight - rect.top + 8}px`;
  container.style.left = `${Math.max(4, rect.left)}px`;

  // State
  let currentCategory: PromptCategory | null = options.initialCategory || null;
  let searchQuery = "";
  let prompts: PromptTemplate[] = [];
  let selectedPrompt: PromptTemplate | null = null;

  // === Header ===
  const header = doc.createElement("div");
  header.style.cssText = `
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 12px 16px;
        border-bottom: 1px solid var(--border-primary);
        background: var(--background-secondary);
    `;

  const title = doc.createElement("div");
  title.style.cssText =
    "font-weight: 600; font-size: 14px; color: var(--text-primary);";
  title.textContent = "📚 Prompt Library";

  header.appendChild(title);
  container.appendChild(header);

  // === Search Bar ===
  const searchBar = doc.createElement("div");
  searchBar.style.cssText =
    "padding: 10px 12px; border-bottom: 1px solid var(--border-primary);";

  const searchInput = doc.createElement("input");
  searchInput.type = "text";
  searchInput.placeholder = "🔍 Search prompts...";
  searchInput.style.cssText = `
        width: 100%;
        padding: 8px 12px;
        border: 1px solid var(--border-primary);
        border-radius: 6px;
        font-size: 13px;
        background: var(--background-primary);
        color: var(--text-primary);
        box-sizing: border-box;
    `;
  searchInput.addEventListener("input", () => {
    searchQuery = searchInput.value;
    renderPromptList();
  });

  searchBar.appendChild(searchInput);
  container.appendChild(searchBar);

  // === Category Tabs ===
  const categoryBar = doc.createElement("div");
  categoryBar.style.cssText = `
        display: flex;
        gap: 4px;
        padding: 8px 12px;
        border-bottom: 1px solid var(--border-primary);
        overflow-x: auto;
        flex-shrink: 0;
    `;

  // "All" tab
  const allTab = createCategoryTab(
    doc,
    "All",
    "📋",
    currentCategory === null,
    () => {
      currentCategory = null;
      updateCategoryTabs();
      renderPromptList();
    },
  );
  categoryBar.appendChild(allTab);

  // Category tabs
  const categoryTabs: Map<PromptCategory | null, HTMLElement> = new Map();
  categoryTabs.set(null, allTab);

  for (const [cat, info] of Object.entries(CATEGORY_LABELS) as [
    PromptCategory,
    { label: string; icon: string },
  ][]) {
    const tab = createCategoryTab(
      doc,
      info.label,
      info.icon,
      currentCategory === cat,
      () => {
        currentCategory = cat;
        updateCategoryTabs();
        renderPromptList();
      },
    );
    categoryTabs.set(cat, tab);
    categoryBar.appendChild(tab);
  }

  container.appendChild(categoryBar);

  function updateCategoryTabs() {
    for (const [cat, tab] of categoryTabs) {
      const isActive = cat === currentCategory;
      tab.style.background = isActive
        ? "var(--highlight-primary)"
        : "var(--background-secondary)";
      tab.style.color = isActive
        ? "var(--highlight-text)"
        : "var(--text-secondary)";
    }
  }

  // === Prompt List ===
  const listContainer = doc.createElement("div");
  listContainer.style.cssText = `
        flex: 1;
        overflow-y: auto;
        padding: 8px;
        display: flex;
        flex-direction: column;
        gap: 6px;
        min-height: 200px;
    `;
  container.appendChild(listContainer);

  let renderPromptList = async () => {
    listContainer.innerHTML = "";

    try {
      prompts = await searchPrompts(
        searchQuery,
        currentCategory ? { category: currentCategory } : undefined,
      );

      if (prompts.length === 0) {
        const empty = doc.createElement("div");
        empty.style.cssText = `
                    text-align: center;
                    padding: 32px;
                    color: var(--text-tertiary);
                    font-size: 13px;
                `;
        empty.innerHTML = searchQuery
          ? "🔍 No prompts match your search"
          : "📭 No prompts available";
        listContainer.appendChild(empty);
        return;
      }

      for (const prompt of prompts) {
        const card = createPromptCard(
          doc,
          prompt,
          selectedPrompt?.id === prompt.id,
          () => {
            selectedPrompt = prompt;
            renderPromptList();
          },
          () => {
            options.onSelect(prompt);
            close();
          },
          prompt.isBuiltIn
            ? undefined
            : () => {
                showPromptEditor(doc, container, prompt, async () => {
                  await renderPromptList();
                });
              },
          prompt.isBuiltIn
            ? undefined
            : () => {
                deletePrompt(prompt.id).then(() => {
                  if (selectedPrompt?.id === prompt.id) {
                    selectedPrompt = null;
                  }
                  renderPromptList();
                });
              },
        );
        listContainer.appendChild(card);
      }
    } catch (error) {
      console.error("Error loading prompts:", error);
      const errorDiv = doc.createElement("div");
      errorDiv.style.cssText = "text-align: center; padding: 20px; color: red;";
      errorDiv.textContent = "Failed to load prompts";
      listContainer.appendChild(errorDiv);
    }
  };

  // === Footer ===
  const footer = doc.createElement("div");
  footer.style.cssText = `
        display: flex;
        justify-content: space-between;
        padding: 10px 12px;
        border-top: 1px solid var(--border-primary);
        background: var(--background-secondary);
        gap: 8px;
    `;

  const newBtn = doc.createElementNS(HTML_NS, "button") as HTMLButtonElement;
  newBtn.textContent = "+ New Prompt";
  newBtn.style.cssText = `
        padding: 8px 14px;
        border: 1px dashed var(--button-dashed-border-blue);
        border-radius: 6px;
        background: transparent;
        color: var(--button-dashed-text-blue);
        font-size: 12px;
        cursor: pointer;
    `;
  newBtn.addEventListener("click", () => {
    showPromptEditor(doc, container, undefined, async (newPrompt) => {
      await renderPromptList();
    });
  });

  const insertBtn = doc.createElementNS(HTML_NS, "button") as HTMLButtonElement;
  insertBtn.textContent = "Insert ▸";
  insertBtn.style.cssText = `
        padding: 8px 16px;
        border: none;
        border-radius: 6px;
        background: var(--highlight-primary);
        color: var(--highlight-text);
        font-size: 12px;
        font-weight: 500;
        cursor: pointer;
        opacity: 0.5;
    `;
  insertBtn.disabled = true;
  insertBtn.addEventListener("click", () => {
    if (selectedPrompt) {
      options.onSelect(selectedPrompt);
      close();
    }
  });

  // Update insert button state when selection changes
  const origRenderPromptList = renderPromptList;
  renderPromptList = async () => {
    await origRenderPromptList();
    insertBtn.disabled = !selectedPrompt;
    insertBtn.style.opacity = selectedPrompt ? "1" : "0.5";
  };

  footer.appendChild(newBtn);
  footer.appendChild(insertBtn);
  container.appendChild(footer);

  // === Assemble and show ===
  const mountPoint = doc.body || doc.documentElement;
  if (!mountPoint) return;
  mountPoint.appendChild(container);

  // === Close handling ===
  function close() {
    container.remove();
    activePickerAnchor = null;
    options.onClose?.();
    doc.removeEventListener("mousedown", closeHandler);
    doc.removeEventListener("keydown", escHandler);
  }

  const closeHandler = (e: MouseEvent) => {
    const target = e.target as Node;
    // Don't close if click is inside container or anchor
    if (container.contains(target) || anchorEl.contains(target)) {
      return;
    }
    // Don't close if focus is inside container (e.g. native select dropdown
    // renders options outside the DOM, but activeElement stays on the <select>)
    const activeEl = doc.activeElement;
    if (activeEl && container.contains(activeEl)) {
      return;
    }
    close();
  };

  const escHandler = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      close();
      e.stopPropagation();
    }
  };

  setTimeout(() => {
    doc.addEventListener("mousedown", closeHandler);
    doc.addEventListener("keydown", escHandler);
  }, 0);

  // Initial render
  await renderPromptList();
  searchInput.focus();
}

// ==================== Helper Components ====================

function createCategoryTab(
  doc: Document,
  label: string,
  icon: string,
  isActive: boolean,
  onClick: () => void,
): HTMLElement {
  const tab = doc.createElementNS(HTML_NS, "button") as HTMLButtonElement;
  tab.style.cssText = `
        display: flex;
        align-items: center;
        gap: 4px;
        padding: 6px 10px;
        border: none;
        border-radius: 14px;
        font-size: 11px;
        cursor: pointer;
        white-space: nowrap;
        transition: all 0.15s ease;
        background: ${isActive ? "var(--highlight-primary)" : "var(--background-secondary)"};
        color: ${isActive ? "var(--highlight-text)" : "var(--text-secondary)"};
    `;
  tab.innerHTML = `<span>${icon}</span> <span>${label}</span>`;
  tab.addEventListener("click", onClick);
  return tab;
}

function createPromptCard(
  doc: Document,
  prompt: PromptTemplate,
  isSelected: boolean,
  onSelect: () => void,
  onDoubleClick: () => void,
  onEdit?: () => void,
  onDelete?: () => void,
): HTMLElement {
  const card = doc.createElement("div");
  card.className = "prompt-card";
  card.style.cssText = `
        padding: 10px 12px;
        border: 1px solid ${isSelected ? "var(--highlight-primary)" : "var(--border-primary)"};
        border-radius: 8px;
        cursor: pointer;
        transition: all 0.15s ease;
        background: ${isSelected ? "var(--paper-checked-background)" : "var(--background-primary)"};
    `;

  // Header row
  const header = doc.createElement("div");
  header.style.cssText =
    "display: flex; align-items: center; gap: 8px; margin-bottom: 4px;";

  const icon = doc.createElement("span");
  icon.textContent = getCategoryIcon(prompt.category);
  icon.style.fontSize = "14px";

  const name = doc.createElement("span");
  name.style.cssText =
    "font-weight: 500; font-size: 13px; color: var(--text-primary); flex: 1;";
  name.textContent = prompt.name;

  const badges = doc.createElement("div");
  badges.style.cssText = "display: flex; gap: 4px;";

  if (prompt.isBuiltIn) {
    const builtInBadge = doc.createElement("span");
    builtInBadge.style.cssText = `
            font-size: 9px;
            padding: 2px 6px;
            background: var(--background-tertiary);
            color: var(--text-secondary);
            border-radius: 4px;
        `;
    builtInBadge.textContent = "Built-in";
    badges.appendChild(builtInBadge);
  }

  header.appendChild(icon);
  header.appendChild(name);
  header.appendChild(badges);

  if (!prompt.isBuiltIn && (onEdit || onDelete)) {
    const actions = doc.createElement("div");
    actions.style.cssText =
      "display: flex; gap: 2px; margin-left: auto; opacity: 0; transition: opacity 0.15s ease;";

    if (onEdit) {
      const editBtn = doc.createElementNS(
        HTML_NS,
        "button",
      ) as HTMLButtonElement;
      editBtn.textContent = "✏️";
      editBtn.title = "Edit";
      editBtn.style.cssText = `
            background: none;
            border: none;
            cursor: pointer;
            font-size: 12px;
            padding: 2px 4px;
            border-radius: 4px;
            opacity: 0.6;
        `;
      editBtn.addEventListener("click", (e: Event) => {
        e.stopPropagation();
        onEdit();
      });
      editBtn.addEventListener("mouseenter", () => {
        editBtn.style.opacity = "1";
      });
      editBtn.addEventListener("mouseleave", () => {
        editBtn.style.opacity = "0.6";
      });
      actions.appendChild(editBtn);
    }

    if (onDelete) {
      const deleteBtn = doc.createElementNS(
        HTML_NS,
        "button",
      ) as HTMLButtonElement;
      deleteBtn.textContent = "🗑️";
      deleteBtn.title = "Delete";
      deleteBtn.style.cssText = `
            background: none;
            border: none;
            cursor: pointer;
            font-size: 12px;
            padding: 2px 4px;
            border-radius: 4px;
            opacity: 0.6;
        `;
      deleteBtn.addEventListener("click", (e: Event) => {
        e.stopPropagation();
        onDelete();
      });
      deleteBtn.addEventListener("mouseenter", () => {
        deleteBtn.style.opacity = "1";
        deleteBtn.style.color = "#e53935";
      });
      deleteBtn.addEventListener("mouseleave", () => {
        deleteBtn.style.opacity = "0.6";
        deleteBtn.style.color = "";
      });
      actions.appendChild(deleteBtn);
    }

    header.appendChild(actions);
    card.addEventListener("mouseenter", () => {
      actions.style.opacity = "1";
    });
    card.addEventListener("mouseleave", () => {
      actions.style.opacity = "0";
    });
  }
  card.appendChild(header);

  // Description
  if (prompt.description) {
    const desc = doc.createElement("div");
    desc.style.cssText = `
            font-size: 11px;
            color: var(--text-secondary);
            margin-bottom: 6px;
            display: -webkit-box;
            -webkit-line-clamp: 2;
            -webkit-box-orient: vertical;
            overflow: hidden;
        `;
    desc.textContent = prompt.description;
    card.appendChild(desc);
  }

  // Tags
  if (prompt.tags.length > 0) {
    const tagsRow = doc.createElement("div");
    tagsRow.style.cssText = "display: flex; gap: 4px; flex-wrap: wrap;";

    for (const tag of prompt.tags.slice(0, 4)) {
      const tagEl = doc.createElement("span");
      tagEl.style.cssText = `
                font-size: 10px;
                padding: 2px 6px;
                background: var(--tag-checked-background);
                color: var(--text-primary);
                border-radius: 4px;
            `;
      tagEl.textContent = `#${tag}`;
      tagsRow.appendChild(tagEl);
    }

    if (prompt.tags.length > 4) {
      const more = doc.createElement("span");
      more.style.cssText = "font-size: 10px; color: var(--text-tertiary);";
      more.textContent = `+${prompt.tags.length - 4}`;
      tagsRow.appendChild(more);
    }

    card.appendChild(tagsRow);
  }

  // Interactions
  card.addEventListener("click", onSelect);
  card.addEventListener("dblclick", onDoubleClick);
  card.addEventListener("mouseenter", () => {
    if (!isSelected) card.style.borderColor = "var(--border-secondary)";
  });
  card.addEventListener("mouseleave", () => {
    if (!isSelected) card.style.borderColor = "var(--border-primary)";
  });

  return card;
}

// ==================== Prompt Editor ====================

async function showPromptEditor(
  doc: Document,
  parent: HTMLElement,
  existingPrompt?: PromptTemplate,
  onSave?: (prompt: PromptTemplate) => void,
): Promise<void> {
  // Create editor overlay
  const editorOverlay = doc.createElement("div");
  editorOverlay.style.cssText = `
        position: absolute;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        background: var(--background-primary);
        display: flex;
        flex-direction: column;
        z-index: 10;
    `;

  // Header
  const header = doc.createElement("div");
  header.style.cssText = `
        display: flex;
        align-items: center;
        padding: 12px 16px;
        border-bottom: 1px solid var(--border-primary);
        background: var(--background-secondary);
    `;

  const backBtn = doc.createElementNS(HTML_NS, "button") as HTMLButtonElement;
  backBtn.textContent = "← Back";
  backBtn.style.cssText = `
        background: none;
        border: none;
        color: var(--highlight-primary);
        cursor: pointer;
        font-size: 12px;
        padding: 4px 8px;
    `;
  backBtn.addEventListener("click", () => editorOverlay.remove());

  const editorTitle = doc.createElement("span");
  editorTitle.style.cssText =
    "flex: 1; text-align: center; font-weight: 600; font-size: 14px;";
  editorTitle.textContent = existingPrompt ? "Edit Prompt" : "New Prompt";

  header.appendChild(backBtn);
  header.appendChild(editorTitle);
  header.appendChild(doc.createElement("div")); // Spacer
  editorOverlay.appendChild(header);

  // Form
  const form = doc.createElement("div");
  form.style.cssText =
    "flex: 1; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 12px;";

  // Name input
  const nameGroup = createFormGroup(
    doc,
    "Name",
    "text",
    existingPrompt?.name || "",
    'e.g., "Summarize Paper"',
  );
  form.appendChild(nameGroup.container);

  // Category select
  const categoryGroup = doc.createElement("div");
  categoryGroup.innerHTML = `<label style="font-size: 12px; color: var(--text-secondary); margin-bottom: 4px; display: block;">Category</label>`;
  const categorySelect = doc.createElement("select");
  categorySelect.style.cssText = `
        width: 100%;
        padding: 8px 10px;
        border: 1px solid var(--border-primary);
        border-radius: 6px;
        font-size: 13px;
        background: var(--background-primary);
        color: var(--text-primary);
    `;
  for (const [cat, info] of Object.entries(CATEGORY_LABELS) as [
    PromptCategory,
    { label: string; icon: string },
  ][]) {
    const option = doc.createElement("option");
    option.value = cat;
    option.textContent = `${info.icon} ${info.label}`;
    if (existingPrompt?.category === cat) option.selected = true;
    categorySelect.appendChild(option);
  }
  categoryGroup.appendChild(categorySelect);
  form.appendChild(categoryGroup);

  // Description
  const descGroup = createFormGroup(
    doc,
    "Description",
    "text",
    existingPrompt?.description || "",
    "Brief description of what this prompt does",
  );
  form.appendChild(descGroup.container);

  // Template textarea
  const templateGroup = doc.createElement("div");
  templateGroup.innerHTML = `
        <label style="font-size: 12px; color: var(--text-secondary); margin-bottom: 4px; display: block;">
            Template <span style="color: var(--text-tertiary);">(Use # @ / ^ ~ for placeholders)</span>
        </label>
    `;
  const templateInput = doc.createElement("textarea");
  templateInput.value = existingPrompt?.template || "";
  templateInput.placeholder =
    "e.g., Summarize the key findings of /paper regarding #topic";
  templateInput.style.cssText = `
        width: 100%;
        height: 100px;
        padding: 10px;
        border: 1px solid var(--border-primary);
        border-radius: 6px;
        font-size: 13px;
        background: var(--background-primary);
        color: var(--text-primary);
        resize: vertical;
        font-family: inherit;
        box-sizing: border-box;
    `;
  templateGroup.appendChild(templateInput);
  form.appendChild(templateGroup);

  // Tags
  const tagsGroup = createFormGroup(
    doc,
    "Tags",
    "text",
    existingPrompt?.tags.join(", ") || "",
    "Comma-separated tags",
  );
  form.appendChild(tagsGroup.container);

  editorOverlay.appendChild(form);

  // Footer
  const footer = doc.createElement("div");
  footer.style.cssText = `
        display: flex;
        justify-content: flex-end;
        gap: 8px;
        padding: 12px 16px;
        border-top: 1px solid var(--border-primary);
    `;

  const cancelBtn = doc.createElementNS(HTML_NS, "button") as HTMLButtonElement;
  cancelBtn.textContent = "Cancel";
  cancelBtn.style.cssText = `
        padding: 8px 16px;
        border: 1px solid var(--border-primary);
        border-radius: 6px;
        background: var(--background-primary);
        color: var(--text-primary);
        cursor: pointer;
        font-size: 12px;
    `;
  cancelBtn.addEventListener("click", () => editorOverlay.remove());

  const saveBtn = doc.createElementNS(HTML_NS, "button") as HTMLButtonElement;
  saveBtn.textContent = existingPrompt ? "Save Changes" : "Create Prompt";
  saveBtn.style.cssText = `
        padding: 8px 16px;
        border: none;
        border-radius: 6px;
        background: var(--highlight-primary);
        color: var(--highlight-text);
        cursor: pointer;
        font-size: 12px;
        font-weight: 500;
    `;
  saveBtn.addEventListener("click", async () => {
    const name = nameGroup.input.value.trim();
    const template = templateInput.value.trim();

    if (!name || !template) {
      // Show validation message
      Zotero.debug(
        "[seerai] Prompt validation failed: Name and template are required",
      );
      nameGroup.input.style.borderColor = !name ? "#e53935" : "";
      templateInput.style.borderColor = !template ? "#e53935" : "";
      return;
    }

    const tags = tagsGroup.input.value
      .split(",")
      .map((t) => t.trim())
      .filter((t) => t);

    try {
      let saved: PromptTemplate;
      if (existingPrompt) {
        saved = await updatePrompt(existingPrompt.id, {
          name,
          description: descGroup.input.value.trim() || undefined,
          template,
          category: categorySelect.value as PromptCategory,
          tags,
        });
      } else {
        saved = await addPrompt({
          name,
          description: descGroup.input.value.trim() || undefined,
          template,
          category: categorySelect.value as PromptCategory,
          tags,
        });
      }

      editorOverlay.remove();
      onSave?.(saved);
    } catch (error) {
      Zotero.debug(`[seerai] Error saving prompt: ${error}`);
      // Visual feedback for error
      saveBtn.textContent = "❌ Failed";
      saveBtn.style.background = "#e53935";
      setTimeout(() => {
        saveBtn.textContent = existingPrompt ? "Save Changes" : "Create Prompt";
        saveBtn.style.background = "var(--highlight-primary)";
      }, 2000);
    }
  });

  footer.appendChild(cancelBtn);
  footer.appendChild(saveBtn);
  editorOverlay.appendChild(footer);

  parent.appendChild(editorOverlay);
  nameGroup.input.focus();
}

function createFormGroup(
  doc: Document,
  label: string,
  type: string,
  value: string,
  placeholder: string,
): { container: HTMLElement; input: HTMLInputElement } {
  const container = doc.createElement("div");
  container.innerHTML = `<label style="font-size: 12px; color: var(--text-secondary); margin-bottom: 4px; display: block;">${label}</label>`;

  const input = doc.createElement("input");
  input.type = type;
  input.value = value;
  input.placeholder = placeholder;
  input.style.cssText = `
        width: 100%;
        padding: 8px 10px;
        border: 1px solid var(--border-primary);
        border-radius: 6px;
        font-size: 13px;
        background: var(--background-primary);
        color: var(--text-primary);
        box-sizing: border-box;
    `;
  container.appendChild(input);

  return { container, input };
}
