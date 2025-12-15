
import { ChatContextManager } from './contextManager';
import { CONTEXT_COLORS, CONTEXT_ICONS, ContextItem } from './contextTypes';

/**
 * Creates the unified context chips area element.
 * Subscribes to ChatContextManager updates.
 */
export function createContextChipsArea(doc: Document): HTMLElement {
    const contextManager = ChatContextManager.getInstance();

    const container = doc.createElement('div');
    container.id = 'unified-context-chips';
    Object.assign(container.style, {
        display: 'none',
        flexWrap: 'wrap',
        gap: '6px',
        padding: '8px',
        backgroundColor: 'var(--background-secondary, #f5f5f5)',
        borderRadius: '6px',
        border: '1px solid var(--border-primary, #ddd)',
        marginBottom: '6px'
    });

    // Label
    const label = doc.createElement('div');
    Object.assign(label.style, {
        width: '100%',
        fontSize: '11px',
        color: 'var(--text-secondary, #666)',
        marginBottom: '4px'
    });
    container.appendChild(label);

    // Initial listener
    contextManager.addListener((items) => {
        updateChips(doc, container, label, items);
    });

    return container;
}

function updateChips(
    doc: Document,
    container: HTMLElement,
    label: HTMLElement,
    items: ContextItem[]
) {
    // Clear existing chips (keep label)
    while (container.childNodes.length > 1) {
        container.removeChild(container.lastChild as Node);
    }

    if (items.length === 0) {
        container.style.display = 'none';
        return;
    }

    container.style.display = 'flex';
    label.innerText = `📎 Context (${items.length}):`;

    items.forEach((item, index) => {
        const chip = doc.createElement('div');
        const color = CONTEXT_COLORS[item.type] || '#007AFF';

        Object.assign(chip.style, {
            display: 'inline-flex',
            alignItems: 'center',
            gap: '4px',
            padding: '4px 8px',
            backgroundColor: color,
            color: '#fff',
            borderRadius: '12px',
            fontSize: '11px',
            fontWeight: '500',
            cursor: 'default',
            maxWidth: '200px',
            overflow: 'hidden',
            boxShadow: '0 1px 2px rgba(0,0,0,0.1)'
        });

        // Icon + Name
        const icon = CONTEXT_ICONS[item.type] || '';
        const nameText = item.displayName.length > 25
            ? item.displayName.substring(0, 22) + '...'
            : item.displayName;

        chip.title = `${icon} ${item.fullName || item.displayName} (${item.type})`;
        chip.innerText = `${icon} ${nameText}`;

        // Remove Button
        const removeBtn = doc.createElement('span');
        removeBtn.innerText = '✕';
        Object.assign(removeBtn.style, {
            marginLeft: '6px',
            cursor: 'pointer',
            opacity: '0.8',
            fontSize: '10px',
            fontWeight: 'bold'
        });

        removeBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            ChatContextManager.getInstance().removeAtIndex(index);
        });

        removeBtn.addEventListener('mouseenter', () => {
            removeBtn.style.opacity = '1';
        });
        removeBtn.addEventListener('mouseleave', () => {
            removeBtn.style.opacity = '0.8';
        });

        chip.appendChild(removeBtn);
        container.appendChild(chip);
    });
}
