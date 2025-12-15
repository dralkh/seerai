
import { getModelConfigs, getActiveModelConfig, setActiveModelId } from '../modelConfig';
import { getChatStateManager } from '../stateManager';
import { firecrawlService } from '../../firecrawl';

export interface ChatSettingsOptions {
    onModeChange?: (mode: 'lock' | 'default' | 'explore') => void;
    onClose?: () => void;
}

export function showChatSettings(doc: Document, anchor: HTMLElement, options: ChatSettingsOptions = {}): void {
    const parentContainer = anchor.parentElement;
    if (!parentContainer) return;

    // Remove existing if open
    const existing = parentContainer.querySelector('#chat-settings-popover');
    if (existing) {
        existing.remove();
        return;
    }

    const container = doc.createElement('div');
    container.id = 'chat-settings-popover';
    Object.assign(container.style, {
        position: 'absolute',
        bottom: '100%',
        left: '0',
        marginBottom: '6px', // Gap between button and menu
        width: '240px',
        backgroundColor: 'var(--background-primary, #fff)',
        border: '1px solid var(--border-primary, #d1d1d1)',
        borderRadius: '8px',
        boxShadow: '0 4px 16px rgba(0,0,0,0.15)',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        fontSize: '13px',
        color: 'var(--text-primary, #000)',
        zIndex: '10003'
    });

    // Header
    const header = doc.createElement('div');
    Object.assign(header.style, {
        padding: '8px 10px',
        borderBottom: '1px solid var(--border-primary)',
        backgroundColor: 'var(--background-secondary, #f5f5f5)',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        fontWeight: '600',
        fontSize: '12px'
    });
    header.innerHTML = '<span>Configuration</span>';
    container.appendChild(header);

    const body = doc.createElement('div');
    Object.assign(body.style, {
        padding: '10px',
        display: 'flex',
        flexDirection: 'column',
        gap: '12px', // Reduce gap for compactness
        maxHeight: '350px',
        overflowY: 'auto'
    });

    // --- 1. Model Selection ---
    const modelSection = doc.createElement('div');
    const modelLabel = doc.createElement('div');
    modelLabel.innerText = 'AI Model';
    modelLabel.style.marginBottom = '4px';
    modelLabel.style.fontSize = '11px';
    modelLabel.style.color = 'var(--text-secondary, #666)';
    modelSection.appendChild(modelLabel);

    const modelSelect = doc.createElement('select');
    Object.assign(modelSelect.style, {
        width: '100%',
        padding: '4px',
        borderRadius: '4px',
        fontSize: '12px',
        border: '1px solid var(--border-primary)'
    });

    const configs = getModelConfigs();
    const activeConfig = getActiveModelConfig();

    if (configs.length === 0) {
        const opt = doc.createElement('option');
        opt.value = 'default';
        opt.innerText = 'Default';
        modelSelect.appendChild(opt);
    } else {
        configs.forEach(cfg => {
            const opt = doc.createElement('option');
            opt.value = cfg.id;
            opt.innerText = cfg.name;
            if (activeConfig && cfg.id === activeConfig.id) opt.selected = true;
            modelSelect.appendChild(opt);
        });
    }

    modelSelect.addEventListener('change', () => {
        setActiveModelId(modelSelect.value);
        Zotero.debug(`[seerai] Model changed to ${modelSelect.value}`);
    });
    modelSection.appendChild(modelSelect);
    body.appendChild(modelSection);

    // --- 2. Context Mode ---
    const stateManager = getChatStateManager();
    const currentMode = stateManager.getOptions().selectionMode;

    const modeSection = doc.createElement('div');
    const modeLabel = doc.createElement('div');
    modeLabel.innerText = 'Context Mode';
    modeLabel.style.marginBottom = '4px';
    modeLabel.style.fontSize = '11px';
    modeLabel.style.color = 'var(--text-secondary, #666)';
    modeSection.appendChild(modeLabel);

    const modeContainer = doc.createElement('div');
    Object.assign(modeContainer.style, {
        display: 'flex',
        backgroundColor: 'var(--background-secondary)',
        borderRadius: '4px',
        padding: '2px',
        border: '1px solid var(--border-primary)'
    });

    const modes = [
        { value: 'lock', label: '🔒', title: 'Lock: Manual only' },
        { value: 'default', label: '📌', title: 'Focus: Single item' },
        { value: 'explore', label: '📚', title: 'Explore: Additive' }
    ];

    modes.forEach(m => {
        const btn = doc.createElement('div');
        Object.assign(btn.style, {
            flex: '1',
            textAlign: 'center',
            padding: '4px 2px',
            fontSize: '12px',
            cursor: 'pointer',
            borderRadius: '3px',
            transition: 'background 0.2s'
        });
        btn.innerText = m.label;
        btn.title = m.title;

        if (m.value === currentMode) {
            btn.style.backgroundColor = 'var(--background-primary)';
            btn.style.boxShadow = '0 1px 2px rgba(0,0,0,0.1)';
            btn.style.fontWeight = '600';
        } else {
            btn.style.color = 'var(--text-secondary)';
        }

        btn.addEventListener('click', () => {
            // Update UI visually
            Array.from(modeContainer.children).forEach((child: any) => {
                child.style.backgroundColor = 'transparent';
                child.style.boxShadow = 'none';
                child.style.fontWeight = 'normal';
                child.style.color = 'var(--text-secondary)';
            });
            btn.style.backgroundColor = 'var(--background-primary)';
            btn.style.boxShadow = '0 1px 2px rgba(0,0,0,0.1)';
            btn.style.fontWeight = '600';
            btn.style.color = 'var(--text-primary)';

            stateManager.setOptions({ selectionMode: m.value as any });
            options.onModeChange?.(m.value as any);
        });

        modeContainer.appendChild(btn);
    });
    modeSection.appendChild(modeContainer);
    body.appendChild(modeSection);

    // --- 3. Web Search ---
    if (firecrawlService.isConfigured()) {
        const webSection = doc.createElement('div');
        const webHeader = doc.createElement('div');
        Object.assign(webHeader.style, {
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: '4px'
        });

        const webLabel = doc.createElement('div');
        webLabel.innerText = 'Web Search';
        webLabel.style.fontSize = '11px';
        webLabel.style.color = 'var(--text-secondary, #666)';

        // Toggle Switch
        const toggleWrapper = doc.createElement('div');
        Object.assign(toggleWrapper.style, {
            position: 'relative',
            width: '28px',
            height: '16px',
            backgroundColor: stateManager.getOptions().webSearchEnabled ? '#4cd964' : '#e5e5ea',
            borderRadius: '8px',
            cursor: 'pointer',
            transition: 'background 0.2s'
        });

        const toggleKnob = doc.createElement('div');
        Object.assign(toggleKnob.style, {
            position: 'absolute',
            top: '2px',
            left: stateManager.getOptions().webSearchEnabled ? '14px' : '2px',
            width: '12px',
            height: '12px',
            backgroundColor: '#fff',
            borderRadius: '50%',
            boxShadow: '0 1px 2px rgba(0,0,0,0.2)',
            transition: 'left 0.2s'
        });

        const helperContainer = doc.createElement('div');
        helperContainer.style.width = '28px';
        helperContainer.style.height = '16px';
        helperContainer.appendChild(toggleWrapper);
        toggleWrapper.appendChild(toggleKnob);

        // Limit container forward decl
        const limitContainer = doc.createElement('div');

        helperContainer.addEventListener('click', (e) => {
            e.stopPropagation(); // Prevent closing
            const current = stateManager.getOptions().webSearchEnabled;
            const newState = !current;
            stateManager.setOptions({ webSearchEnabled: newState });

            // Update UI
            toggleWrapper.style.backgroundColor = newState ? '#4cd964' : '#e5e5ea';
            toggleKnob.style.left = newState ? '14px' : '2px';
            limitContainer.style.display = newState ? 'flex' : 'none';
        });

        webHeader.appendChild(webLabel);
        webHeader.appendChild(helperContainer);
        webSection.appendChild(webHeader);

        // Limit & Concurrent Inputs
        Object.assign(limitContainer.style, {
            display: stateManager.getOptions().webSearchEnabled ? 'flex' : 'none',
            justifyContent: 'flex-start', // Left align
            gap: '12px',
            alignItems: 'center',
            fontSize: '11px',
            marginTop: '2px',
            paddingLeft: '4px'
        });

        limitContainer.innerHTML = '';
        const prefPrefix = 'extensions.seerai';

        // --- Limit Input ---
        const limitGroup = doc.createElement('div');
        limitGroup.style.display = 'flex';
        limitGroup.style.alignItems = 'center';
        limitGroup.style.gap = '4px';

        const limitLabel = doc.createElement('span');
        limitLabel.innerText = 'Limit:';

        const limitInput = doc.createElement('input');
        limitInput.type = 'number';
        limitInput.min = '1';
        limitInput.max = '10';
        const currentLimit = Zotero.Prefs.get(`${prefPrefix}.firecrawlSearchLimit`) || 3;
        limitInput.value = String(currentLimit);

        Object.assign(limitInput.style, {
            width: '32px',
            padding: '2px',
            fontSize: '11px',
            border: '1px solid var(--border-primary)',
            borderRadius: '4px',
            textAlign: 'center'
        });

        limitInput.addEventListener('change', () => {
            const val = parseInt(limitInput.value);
            if (val >= 1 && val <= 10) {
                Zotero.Prefs.set(`${prefPrefix}.firecrawlSearchLimit`, val);
            }
        });
        limitInput.addEventListener('click', (e) => e.stopPropagation());

        limitGroup.appendChild(limitLabel);
        limitGroup.appendChild(limitInput);
        limitContainer.appendChild(limitGroup);

        // --- Concurrent Input ---
        const concurrentGroup = doc.createElement('div');
        concurrentGroup.style.display = 'flex';
        concurrentGroup.style.alignItems = 'center';
        concurrentGroup.style.gap = '4px';

        const concurrentLabel = doc.createElement('span');
        concurrentLabel.innerText = 'Max:';

        const concurrentInput = doc.createElement('input');
        concurrentInput.type = 'number';
        concurrentInput.min = '1';
        concurrentInput.max = '5';
        const currentConcurrent = Zotero.Prefs.get(`${prefPrefix}.firecrawlMaxConcurrent`) || 3;
        concurrentInput.value = String(currentConcurrent);

        Object.assign(concurrentInput.style, {
            width: '32px',
            padding: '2px',
            fontSize: '11px',
            border: '1px solid var(--border-primary)',
            borderRadius: '4px',
            textAlign: 'center'
        });

        concurrentInput.addEventListener('change', () => {
            const val = parseInt(concurrentInput.value);
            if (val >= 1 && val <= 5) {
                Zotero.Prefs.set(`${prefPrefix}.firecrawlMaxConcurrent`, val);
            }
        });
        concurrentInput.addEventListener('click', (e) => e.stopPropagation());

        concurrentGroup.appendChild(concurrentLabel);
        concurrentGroup.appendChild(concurrentInput);
        limitContainer.appendChild(concurrentGroup);

        webSection.appendChild(limitContainer);
        body.appendChild(webSection);
    }

    container.appendChild(body);
    parentContainer.appendChild(container);

    // Close on click outside
    const closeHandler = (e: MouseEvent) => {
        // If click is not inside the container AND not on the anchor button
        if (!container.contains(e.target as Node) && !anchor.contains(e.target as Node)) {
            container.remove();
            doc.removeEventListener('click', closeHandler);
        }
    };

    // Defer to avoid immediate close
    setTimeout(() => doc.addEventListener('click', closeHandler), 0);
}
