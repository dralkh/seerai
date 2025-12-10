/**
 * Simple markdown parser for chat message rendering.
 * Converts markdown text to HTML.
 */

import { highlightCode } from "./syntaxHighlight";

/**
 * Escape HTML entities to prevent XSS
 */
function escapeHtml(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

/**
 * Parse inline markdown elements
 */
function parseInline(text: string): string {
    let result = escapeHtml(text);

    // Bold: **text** or __text__
    result = result.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    result = result.replace(/__(.+?)__/g, '<strong>$1</strong>');

    // Italic: *text* or _text_
    result = result.replace(/\*([^*]+?)\*/g, '<em>$1</em>');
    result = result.replace(/(?<![\\w])_([^_]+?)_(?![\\w])/g, '<em>$1</em>');

    // Strikethrough: ~~text~~
    result = result.replace(/~~(.+?)~~/g, '<del>$1</del>');

    // Inline code: `code`
    result = result.replace(/`([^`]+?)`/g, '<code style="background: rgba(0,0,0,0.08); padding: 2px 4px; border-radius: 3px; font-family: monospace; font-size: 0.9em;">$1</code>');

    // Standard Links: [text](url) - only http/https links work in Zotero
    result = result.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '<a href="$2" style="color: #1976d2; text-decoration: underline;">$1</a>');

    // Style quoted paper titles (but not as links since Zotero blocks custom URIs)
    result = result.replace(/&quot;([^&]+)&quot;/g, '<em style="color: #2e7d32;">"$1"</em>');

    return result;
}

/**
 * Parse markdown text to HTML
 */
export function parseMarkdown(markdown: string): string {
    if (!markdown) return '';

    const lines = markdown.split('\n');
    const htmlParts: string[] = [];
    let inCodeBlock = false;
    let codeBlockContent: string[] = [];
    let codeLanguage = '';
    let inList = false;
    let listItems: string[] = [];
    let listType: 'ul' | 'ol' = 'ul';
    let inTable = false;
    let tableRows: string[][] = [];
    let tableHeader: string[] = [];

    const flushList = () => {
        if (inList && listItems.length > 0) {
            const tag = listType;
            htmlParts.push(`<${tag} style="margin: 8px 0; padding-left: 20px;">${listItems.map(item => `<li style="margin: 4px 0;">${parseInline(item)}</li>`).join('')}</${tag}>`);
            listItems = [];
            inList = false;
        }
    };

    const flushTable = () => {
        if (inTable && (tableHeader.length > 0 || tableRows.length > 0)) {
            let tableHtml = '<table style="border-collapse: collapse; width: 100%; margin: 8px 0; font-size: 0.95em;">';
            if (tableHeader.length > 0) {
                tableHtml += '<thead><tr>';
                tableHeader.forEach(cell => {
                    tableHtml += `<th style="border: 1px solid #ddd; padding: 8px; background: rgba(0,0,0,0.05); text-align: left;">${parseInline(cell.trim())}</th>`;
                });
                tableHtml += '</tr></thead>';
            }
            if (tableRows.length > 0) {
                tableHtml += '<tbody>';
                tableRows.forEach(row => {
                    tableHtml += '<tr>';
                    row.forEach(cell => {
                        tableHtml += `<td style="border: 1px solid #ddd; padding: 8px;">${parseInline(cell.trim())}</td>`;
                    });
                    tableHtml += '</tr>';
                });
                tableHtml += '</tbody>';
            }
            tableHtml += '</table>';
            htmlParts.push(tableHtml);
            tableHeader = [];
            tableRows = [];
            inTable = false;
        }
    };

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        // Code blocks: ```language
        if (line.trim().startsWith('```')) {
            if (inCodeBlock) {
                // End code block - create enhanced code block with copy button and syntax highlighting
                const highlightedCode = codeLanguage
                    ? highlightCode(codeBlockContent.join('\n'), codeLanguage)
                    : escapeHtml(codeBlockContent.join('\n'));
                const uniqueId = `code-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

                htmlParts.push(`
                    <div style="position: relative; margin: 8px 0;">
                        ${codeLanguage ? `<div style="position: absolute; top: 0; left: 12px; font-size: 10px; color: #aaa; background: #2d2d2d; padding: 2px 6px; border-radius: 0 0 4px 4px; text-transform: uppercase;">${codeLanguage}</div>` : ''}
                        <pre style="background: #1e1e1e; color: #d4d4d4; padding: ${codeLanguage ? '28px' : '12px'} 12px 12px; border-radius: 6px; overflow-x: auto; font-family: 'SF Mono', Consolas, monospace; font-size: 0.9em; margin: 0;"><code>${highlightedCode}</code></pre>
                    </div>
                `);
                codeBlockContent = [];
                codeLanguage = '';
                inCodeBlock = false;
            } else {
                // Start code block - extract language
                flushList();
                flushTable();
                const langMatch = line.trim().match(/^```(\w+)?/);
                codeLanguage = langMatch && langMatch[1] ? langMatch[1] : '';
                inCodeBlock = true;
            }
            continue;
        }

        if (inCodeBlock) {
            codeBlockContent.push(line);
            continue;
        }

        // Horizontal rule: --- or *** or ___
        if (/^[-*_]{3,}$/.test(line.trim())) {
            flushList();
            flushTable();
            htmlParts.push('<hr style="border: none; border-top: 1px solid #ddd; margin: 16px 0;" />');
            continue;
        }

        // Table row: | cell | cell |
        if (line.trim().startsWith('|') && line.trim().endsWith('|')) {
            flushList();
            const cells = line.trim().slice(1, -1).split('|');

            // Check if this is a separator row (|---|---|)
            if (cells.every(cell => /^[-:]+$/.test(cell.trim()))) {
                // This is the separator after header
                continue;
            }

            if (!inTable) {
                inTable = true;
                tableHeader = cells;
            } else {
                tableRows.push(cells);
            }
            continue;
        } else if (inTable) {
            flushTable();
        }

        // Headers: # ## ### etc.
        const headerMatch = line.match(/^(#{1,6})\s+(.+)$/);
        if (headerMatch) {
            flushList();
            flushTable();
            const level = headerMatch[1].length;
            const text = headerMatch[2];
            const sizes: Record<number, string> = { 1: '1.5em', 2: '1.3em', 3: '1.15em', 4: '1.05em', 5: '1em', 6: '0.95em' };
            const weights: Record<number, string> = { 1: '700', 2: '700', 3: '600', 4: '600', 5: '600', 6: '600' };
            htmlParts.push(`<div style="font-size: ${sizes[level]}; font-weight: ${weights[level]}; margin: 12px 0 8px 0;">${parseInline(text)}</div>`);
            continue;
        }

        // Unordered list: - item or * item or + item
        const ulMatch = line.match(/^[-*+]\s+(.+)$/);
        if (ulMatch) {
            flushTable();
            if (!inList || listType !== 'ul') {
                flushList();
                inList = true;
                listType = 'ul';
            }
            listItems.push(ulMatch[1]);
            continue;
        }

        // Ordered list: 1. item (any number followed by period)
        const olMatch = line.match(/^\d+\.\s+(.+)$/);
        if (olMatch) {
            flushTable();
            if (!inList || listType !== 'ol') {
                flushList();
                inList = true;
                listType = 'ol';
            }
            listItems.push(olMatch[1]);
            continue;
        }

        // Continuation of list item (indented text following a list)
        // Lines that start with whitespace while in a list should be appended to last item
        if (inList && line.match(/^\s+\S/) && listItems.length > 0) {
            listItems[listItems.length - 1] += ' ' + line.trim();
            continue;
        }

        // Blockquote: > text
        const blockquoteMatch = line.match(/^>\s*(.*)$/);
        if (blockquoteMatch) {
            flushList();
            flushTable();
            htmlParts.push(`<blockquote style="border-left: 3px solid #ddd; padding-left: 12px; margin: 8px 0; color: #666; font-style: italic;">${parseInline(blockquoteMatch[1])}</blockquote>`);
            continue;
        }

        // Empty line
        if (line.trim() === '') {
            flushList();
            flushTable();
            // Add spacing for paragraph breaks
            if (htmlParts.length > 0 && !htmlParts[htmlParts.length - 1].includes('margin')) {
                htmlParts.push('<div style="height: 8px;"></div>');
            }
            continue;
        }

        // Regular paragraph
        flushList();
        flushTable();
        htmlParts.push(`<div style="margin: 4px 0;">${parseInline(line)}</div>`);
    }

    // Flush remaining items
    flushList();
    flushTable();

    // Handle unclosed code block
    if (inCodeBlock && codeBlockContent.length > 0) {
        htmlParts.push(`<pre style="background: rgba(0,0,0,0.08); padding: 12px; border-radius: 6px; overflow-x: auto; font-family: monospace; font-size: 0.9em; margin: 8px 0;"><code>${escapeHtml(codeBlockContent.join('\n'))}</code></pre>`);
    }

    return htmlParts.join('');
}
