/**
 * Placeholder Dropdown UI
 * Inline autocomplete dropdown triggered by placeholder characters
 */

import {
    detectTrigger,
    getAutocompleteResults,
    insertPlaceholderValue,
    AutocompleteResult,
    TriggerInfo,
    PLACEHOLDER_INFO,
    PlaceholderType,
    saveRecentTopic,
} from '../placeholders';
import { PLACEHOLDER_TRIGGERS } from '../promptLibrary';

// ==================== Types ====================

interface DropdownState {
    dropdown: HTMLElement | null;
    trigger: TriggerInfo | null;
    results: AutocompleteResult[];
    selectedIndex: number;
    inputElement: HTMLInputElement | null;
    debounceTimer: ReturnType<typeof setTimeout> | null;
}

// Global state for managing the active dropdown
let state: DropdownState = {
    dropdown: null,
    trigger: null,
    results: [],
    selectedIndex: 0,
    inputElement: null,
    debounceTimer: null,
};

// ==================== Main Functions ====================

/**
 * Initialize placeholder autocomplete on an input element
 */
export function initPlaceholderAutocomplete(
    doc: Document,
    input: HTMLInputElement,
    onInsert?: (value: string, type: PlaceholderType, itemId?: string | number, trigger?: string) => void
): () => void {
    Zotero.debug(`[seerai] initPlaceholderAutocomplete: Initializing on input element`);

    const handleInput = (e?: Event) => {
        Zotero.debug(`[seerai] handleInput: fired, value="${input.value}", cursorPos=${input.selectionStart}`);

        const cursorPos = input.selectionStart || 0;
        const trigger = detectTrigger(input.value, cursorPos);

        if (trigger) {
            Zotero.debug(`[seerai] handleInput: Trigger found: ${trigger.trigger} type=${trigger.type} query="${trigger.query}"`);

            // Debounce the autocomplete query
            if (state.debounceTimer) {
                clearTimeout(state.debounceTimer);
            }

            state.debounceTimer = setTimeout(async () => {
                await showPlaceholderDropdown(doc, input, trigger, onInsert);
            }, 150);
        } else {
            Zotero.debug(`[seerai] handleInput: No trigger found`);
            hideDropdown();
        }
    };

    const handleKeyDown = (e: KeyboardEvent) => {
        if (!state.dropdown || state.dropdown.style.display === 'none') return;

        switch (e.key) {
            case 'ArrowDown':
                e.preventDefault();
                e.stopPropagation();
                navigateDropdown(1);
                break;
            case 'ArrowUp':
                e.preventDefault();
                e.stopPropagation();
                navigateDropdown(-1);
                break;
            case 'Enter':
                if (state.results.length > 0 && state.dropdown.style.display !== 'none') {
                    e.preventDefault();
                    e.stopPropagation();
                    selectCurrentItem(onInsert);
                }
                break;
            case 'Escape':
                e.preventDefault();
                hideDropdown();
                break;
            case 'Tab':
                if (state.results.length > 0 && state.dropdown.style.display !== 'none') {
                    e.preventDefault();
                    e.stopPropagation();
                    selectCurrentItem(onInsert);
                }
                break;
        }
    };

    const handleBlur = () => {
        // Delay hiding to allow click events on dropdown items
        setTimeout(() => {
            if (!state.dropdown?.contains(doc.activeElement)) {
                hideDropdown();
            }
        }, 200);
    };

    // Attach listeners using both methods for compatibility
    input.addEventListener('input', handleInput);
    input.addEventListener('keydown', handleKeyDown, true); // Use capture
    input.addEventListener('blur', handleBlur);

    // Also listen for keyup as backup for input detection
    input.addEventListener('keyup', (e: KeyboardEvent) => {
        // Ignore navigation keys to prevent resetting selection
        if (['ArrowUp', 'ArrowDown', 'Enter', 'Escape', 'Tab'].includes(e.key)) {
            return;
        }
        // Re-check on keyup in case input event didn't fire
        handleInput(e);
    });

    state.inputElement = input;

    Zotero.debug(`[seerai] initPlaceholderAutocomplete: Listeners attached`);

    // Return cleanup function
    return () => {
        input.removeEventListener('input', handleInput);
        input.removeEventListener('keydown', handleKeyDown, true);
        input.removeEventListener('blur', handleBlur);
        hideDropdown();
        if (state.debounceTimer) {
            clearTimeout(state.debounceTimer);
        }
    };
}

/**
 * Show the placeholder dropdown
 */
async function showPlaceholderDropdown(
    doc: Document,
    input: HTMLInputElement,
    trigger: TriggerInfo,
    onInsert?: (value: string, type: PlaceholderType) => void
): Promise<void> {
    state.trigger = trigger;
    state.inputElement = input;

    Zotero.debug(`[seerai] Placeholder triggered: ${trigger.trigger} with query "${trigger.query}"`);

    // Fetch results
    try {
        state.results = await getAutocompleteResults(trigger.type, trigger.query);
        Zotero.debug(`[seerai] Got ${state.results.length} results for ${trigger.type}`);
    } catch (error) {
        Zotero.debug(`[seerai] Error fetching autocomplete results: ${error}`);
        state.results = [];
    }

    state.selectedIndex = 0;

    // Create dropdown if needed
    if (!state.dropdown) {
        Zotero.debug(`[seerai] Creating new dropdown element`);
        state.dropdown = createDropdown(doc);
    }

    // Position dropdown (this also appends to input parent)
    positionDropdown(input);
    Zotero.debug(`[seerai] Dropdown parent: ${state.dropdown.parentElement?.tagName || 'none'}`);

    // Render results (or empty state)
    renderDropdownResults(doc, onInsert);

    state.dropdown.style.display = 'block';
    Zotero.debug(`[seerai] Dropdown display set to block`);
}

/**
 * Hide the dropdown
 */
export function hideDropdown(): void {
    if (state.dropdown) {
        state.dropdown.style.display = 'none';
    }
    state.trigger = null;
    state.results = [];
    state.selectedIndex = 0;
}

/**
 * Navigate within the dropdown
 */
function navigateDropdown(direction: number): void {
    if (state.results.length === 0) return;

    state.selectedIndex = (state.selectedIndex + direction + state.results.length) % state.results.length;

    // Update visual selection
    if (state.dropdown) {
        const items = state.dropdown.querySelectorAll('.placeholder-item');
        items.forEach((item: Element, i: number) => {
            (item as HTMLElement).style.background =
                i === state.selectedIndex ? 'var(--paper-checked-background)' : 'transparent';
        });

        // Scroll selected item into view
        const selectedItem = items[state.selectedIndex] as HTMLElement;
        if (selectedItem) {
            selectedItem.scrollIntoView({ block: 'nearest' });
        }
    }
}

/**
 * Select the currently highlighted item
 */
function selectCurrentItem(onInsert?: (value: string, type: PlaceholderType, itemId?: string | number, trigger?: string) => void): void {
    const selectedResult = state.results[state.selectedIndex];
    if (!selectedResult || !state.trigger || !state.inputElement) return;

    const input = state.inputElement;
    const valueToInsert = String(selectedResult.title);
    const itemId = selectedResult.id;

    // Special handling for prompts: replace trigger with template text
    if (selectedResult.type === 'prompt' && selectedResult.data?.template) {
        const template = selectedResult.data.template as string;

        // Calculate where to insert
        const before = input.value.substring(0, state.trigger.startPos);
        const after = input.value.substring(state.trigger.endPos);

        input.value = before + template + after;

        // Set cursor to end of inserted template
        const newRunningPos = state.trigger.startPos + template.length;
        input.setSelectionRange(newRunningPos, newRunningPos);

        // Trigger input event to re-scan for placeholders within the template
        const doc = input.ownerDocument;
        if (doc) {
            const inputEvent = doc.createEvent('Event');
            inputEvent.initEvent('input', true, true);
            input.dispatchEvent(inputEvent);
        }
    } else {
        // Normal placeholder insertion
        // Insert the value with bracket notation and itemId
        input.value = insertPlaceholderValue(input.value, state.trigger, valueToInsert, itemId);

        // Calculate cursor position based on what was actually inserted
        // Format: [trigger + displayValue::id] 
        const maxDisplayLength = 30;
        const displayLength = Math.min(valueToInsert.length, maxDisplayLength - 3) + (valueToInsert.length > maxDisplayLength ? 3 : 0);
        const idLength = itemId ? String(itemId).length + 2 : 0; // +2 for ::
        const newCursorPos = state.trigger.startPos + 1 + 1 + displayLength + idLength + 1 + 1; // [ + trigger + display + ::id + ] + space
        input.setSelectionRange(newCursorPos, newCursorPos);

        // Save topic if it's a topic type
        if (selectedResult.type === 'topic') {
            saveRecentTopic(valueToInsert);
        }
    }

    // Callback with full context info
    onInsert?.(valueToInsert, selectedResult.type, itemId, state.trigger.trigger);

    // Hide and refocus
    hideDropdown();
    input.focus();
}

// ==================== UI Creation ====================

/**
 * Create the dropdown element with absolute positioning
 */
function createDropdown(doc: Document): HTMLElement {
    const dropdown = doc.createElement('div');
    dropdown.id = 'placeholder-dropdown';
    dropdown.style.cssText = `
        position: absolute;
        width: 100%;
        max-height: 250px;
        overflow-y: auto;
        background: var(--background-primary, #ffffff);
        border: 1px solid var(--border-primary, #ddd);
        border-radius: 8px;
        box-shadow: 0 -4px 20px rgba(0,0,0,0.2);
        z-index: 99999;
        display: none;
        bottom: 100%;
        left: 0;
        margin-bottom: 4px;
    `;
    return dropdown;
}

/**
 * Position the dropdown (absolute, positioned by CSS relative to parent)
 */
function positionDropdown(input: HTMLInputElement): void {
    if (!state.dropdown) return;

    // Get input parent and ensure it has relative positioning
    const parent = input.parentElement as HTMLElement | null;
    if (parent) {
        const currentPosition = parent.style.position;
        if (!currentPosition || currentPosition === 'static') {
            parent.style.position = 'relative';
        }

        // Append dropdown to parent if not already there
        if (state.dropdown.parentElement !== parent) {
            parent.appendChild(state.dropdown);
            Zotero.debug(`[seerai] Dropdown moved to input parent`);
        }
    }

    Zotero.debug(`[seerai] positionDropdown: dropdown parent=${state.dropdown.parentElement?.tagName || 'none'}`);
}

/**
 * Render the dropdown results
 */
function renderDropdownResults(
    doc: Document,
    onInsert?: (value: string, type: PlaceholderType) => void
): void {
    if (!state.dropdown) return;

    state.dropdown.innerHTML = '';

    // Header with type info
    if (state.trigger) {
        const info = PLACEHOLDER_INFO[state.trigger.type];
        const header = doc.createElement('div');
        header.style.cssText = `
            padding: 10px 14px;
            border-bottom: 1px solid var(--border-primary);
            font-size: 12px;
            font-weight: 500;
            color: var(--text-primary);
            display: flex;
            align-items: center;
            gap: 8px;
            background: var(--background-secondary);
        `;
        header.innerHTML = `<span style="font-size: 16px;">${info.icon}</span> <span>Select ${info.label}</span>`;

        // Show trigger character badge
        const triggerBadge = doc.createElement('span');
        triggerBadge.style.cssText = `
            margin-left: auto;
            padding: 2px 8px;
            background: var(--background-tertiary);
            border-radius: 4px;
            font-family: monospace;
            font-size: 11px;
            color: var(--text-secondary);
        `;
        triggerBadge.textContent = state.trigger.trigger;
        header.appendChild(triggerBadge);

        state.dropdown.appendChild(header);
    }

    // Results list with scrolling
    const list = doc.createElement('div');
    list.style.cssText = `
        padding: 6px;
        max-height: 220px;
        overflow-y: auto;
    `;

    if (state.results.length === 0) {
        // Empty state
        const emptyState = doc.createElement('div');
        emptyState.style.cssText = `
            padding: 24px;
            text-align: center;
            color: var(--text-tertiary);
            font-size: 12px;
        `;
        emptyState.innerHTML = `
            <div style="font-size: 24px; margin-bottom: 8px;">🔍</div>
            <div>No ${state.trigger ? PLACEHOLDER_INFO[state.trigger.type].label.toLowerCase() + 's' : 'items'} found</div>
            <div style="font-size: 11px; margin-top: 4px;">Keep typing to search...</div>
        `;
        list.appendChild(emptyState);
    } else {
        state.results.forEach((result, index) => {
            const item = createDropdownItem(doc, result, index === state.selectedIndex, () => {
                state.selectedIndex = index;
                selectCurrentItem(onInsert);
            });
            list.appendChild(item);
        });
    }

    state.dropdown.appendChild(list);
}

/**
 * Create a dropdown item element
 */
function createDropdownItem(
    doc: Document,
    result: AutocompleteResult,
    isSelected: boolean,
    onClick: () => void
): HTMLElement {
    const item = doc.createElement('div');
    item.className = 'placeholder-item';
    item.style.cssText = `
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 8px 10px;
        border-radius: 6px;
        cursor: pointer;
        transition: background 0.1s ease;
        background: ${isSelected ? 'var(--paper-checked-background)' : 'transparent'};
    `;

    // Icon
    const icon = doc.createElement('span');
    icon.style.cssText = 'font-size: 14px; width: 20px; text-align: center;';
    icon.textContent = result.icon || PLACEHOLDER_INFO[result.type].icon;

    // Text content
    const textContent = doc.createElement('div');
    textContent.style.cssText = 'flex: 1; min-width: 0;';

    const title = doc.createElement('div');
    title.style.cssText = `
        font-size: 12px;
        color: var(--text-primary);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
    `;
    title.textContent = result.title;

    textContent.appendChild(title);

    if (result.subtitle) {
        const subtitle = doc.createElement('div');
        subtitle.style.cssText = `
            font-size: 10px;
            color: var(--text-tertiary);
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        `;
        subtitle.textContent = result.subtitle;
        textContent.appendChild(subtitle);
    }

    // Color indicator for tags
    if (result.type === 'tag' && result.data?.color) {
        const colorDot = doc.createElement('span');
        colorDot.style.cssText = `
            width: 8px;
            height: 8px;
            border-radius: 50%;
            background: ${result.data.color};
            flex-shrink: 0;
        `;
        item.appendChild(colorDot);
    }

    item.appendChild(icon);
    item.appendChild(textContent);

    // Interactions
    item.addEventListener('click', onClick);
    item.addEventListener('mouseenter', () => {
        item.style.background = 'var(--paper-checked-background)';
    });
    item.addEventListener('mouseleave', () => {
        if (state.results[state.selectedIndex] !== result) {
            item.style.background = 'transparent';
        }
    });

    return item;
}

// ==================== Placeholder Menu Button ====================

/**
 * Create a dropdown menu button for manually inserting placeholders
 */
export function createPlaceholderMenuButton(
    doc: Document,
    input: HTMLInputElement
): HTMLElement {
    const container = doc.createElement('div');
    container.style.cssText = 'position: relative;';

    const button = doc.createElement('button');
    button.type = 'button';
    button.title = 'Insert placeholder';
    button.style.cssText = `
        width: 32px;
        height: 32px;
        border: 1px solid var(--border-primary);
        border-radius: 6px;
        background: var(--background-primary);
        color: var(--text-secondary);
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 14px;
        transition: all 0.15s ease;
    `;
    button.textContent = '+';

    let menuVisible = false;
    let menu: HTMLElement | null = null;

    const showMenu = () => {
        if (menu) {
            menu.remove();
            menu = null;
            menuVisible = false;
            return;
        }

        menu = doc.createElement('div');
        menu.style.cssText = `
            position: absolute;
            bottom: 100%;
            left: 0;
            margin-bottom: 4px;
            background: var(--background-primary);
            border: 1px solid var(--border-primary);
            border-radius: 8px;
            box-shadow: 0 4px 16px rgba(0,0,0,0.15);
            padding: 4px;
            z-index: 10003;
            min-width: 160px;
        `;

        const placeholderTypes: [string, PlaceholderType][] = [
            ['!', 'prompt'],
            ['#', 'topic'],
            ['/', 'paper'],
            ['@', 'author'],
            ['^', 'collection'],
            ['~', 'tag'],
            ['$', 'table'],
        ];

        for (const [trigger, type] of placeholderTypes) {
            const info = PLACEHOLDER_INFO[type];
            const item = doc.createElement('button');
            item.type = 'button';
            item.style.cssText = `
                display: flex;
                align-items: center;
                gap: 8px;
                width: 100%;
                padding: 8px 10px;
                border: none;
                border-radius: 6px;
                background: transparent;
                cursor: pointer;
                text-align: left;
                font-size: 12px;
                color: var(--text-primary);
            `;
            item.innerHTML = `
                <span style="width: 20px; text-align: center;">${info.icon}</span>
                <span style="flex: 1;">${info.label}</span>
                <span style="font-family: monospace; color: var(--text-tertiary);">${trigger}</span>
            `;

            item.addEventListener('mouseenter', () => {
                item.style.background = 'var(--background-secondary)';
            });
            item.addEventListener('mouseleave', () => {
                item.style.background = 'transparent';
            });
            item.addEventListener('click', () => {
                // Insert trigger character at cursor
                const cursorPos = input.selectionStart || input.value.length;
                const before = input.value.substring(0, cursorPos);
                const after = input.value.substring(cursorPos);
                input.value = before + trigger + after;
                input.setSelectionRange(cursorPos + 1, cursorPos + 1);
                input.focus();

                // Trigger input event to show autocomplete (Zotero-compatible)
                const inputEvent = doc.createEvent('Event');
                inputEvent.initEvent('input', true, true);
                input.dispatchEvent(inputEvent);

                // Close menu
                if (menu) {
                    menu.remove();
                    menu = null;
                    menuVisible = false;
                }
            });

            menu.appendChild(item);
        }

        container.appendChild(menu);
        menuVisible = true;

        // Close on click outside
        const closeHandler = (e: MouseEvent) => {
            if (!container.contains(e.target as Node)) {
                if (menu) {
                    menu.remove();
                    menu = null;
                    menuVisible = false;
                }
                doc.removeEventListener('click', closeHandler);
            }
        };
        setTimeout(() => doc.addEventListener('click', closeHandler), 0);
    };

    button.addEventListener('click', (e) => {
        e.stopPropagation();
        showMenu();
    });

    button.addEventListener('mouseenter', () => {
        button.style.background = 'var(--background-secondary)';
        button.style.borderColor = 'var(--border-secondary)';
    });
    button.addEventListener('mouseleave', () => {
        button.style.background = 'var(--background-primary)';
        button.style.borderColor = 'var(--border-primary)';
    });

    container.appendChild(button);
    return container;
}

/**
 * Trigger the next available placeholder in the input
 */
export function triggerNextPlaceholder(doc: Document, input: HTMLInputElement): void {
    const text = input.value;
    // Regex to find placeholders: trigger char + word chars
    // We look for triggers that are preceded by start-of-string or whitespace
    // and NOT immediately followed by a word char (to ensure we match full words)
    // Matches: /paper, #topic, /
    // Does NOT match: [/paper], [~tag] (because of preceding [)
    const regex = /(?:^|[\s])([#/@^~$][\w\d-]*)(?=$|[\s.,;:?!])/g;

    let match;
    let foundMatch = null;

    while ((match = regex.exec(text)) !== null) {
        const index = match.index;
        // If matched via space, the capturing group index needs to be adjusted? 
        // match[1] is the trigger+word.
        // match.index is start of full match (including header space).
        // Let's find exactly where the capturing group starts.
        const fullMatchStr = match[0]; // e.g. " #topic"
        const capturedStr = match[1];  // "#topic"
        const offset = fullMatchStr.indexOf(capturedStr);
        const placeholderStart = index + offset;

        // Check if character before is '['
        const charBefore = text[placeholderStart - 1];
        if (charBefore === '[') {
            continue;
        }

        // Found a candidate
        foundMatch = {
            start: placeholderStart,
            end: placeholderStart + capturedStr.length,
            text: capturedStr
        };
        break;
    }

    if (foundMatch) {
        Zotero.debug(`[seerai] triggerNextPlaceholder: Found ${foundMatch.text} at ${foundMatch.end}`);
        input.setSelectionRange(foundMatch.end, foundMatch.end);
        input.focus();

        // Trigger input event after a small delay to allow UI updates
        setTimeout(() => {
            const inputEvent = doc.createEvent('Event');
            inputEvent.initEvent('input', true, true);
            input.dispatchEvent(inputEvent);
        }, 50);
    }
}
