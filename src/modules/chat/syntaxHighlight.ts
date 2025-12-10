/**
 * Lightweight syntax highlighting for code blocks
 * Supports common programming languages without external dependencies
 */

// Token types for highlighting
type TokenType = 'keyword' | 'string' | 'comment' | 'number' | 'function' | 'operator' | 'punctuation' | 'property' | 'type';

// Color scheme
const tokenColors: Record<TokenType, string> = {
    keyword: '#c586c0',    // Purple for keywords
    string: '#ce9178',     // Orange for strings
    comment: '#6a9955',    // Green for comments
    number: '#b5cea8',     // Light green for numbers
    function: '#dcdcaa',   // Yellow for functions
    operator: '#d4d4d4',   // Light gray for operators
    punctuation: '#808080', // Gray for punctuation
    property: '#9cdcfe',   // Light blue for properties
    type: '#4ec9b0'        // Teal for types
};

// Language keywords
const keywords: Record<string, string[]> = {
    javascript: ['const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'break', 'continue', 'new', 'this', 'class', 'extends', 'import', 'export', 'from', 'default', 'async', 'await', 'try', 'catch', 'finally', 'throw', 'typeof', 'instanceof', 'in', 'of', 'true', 'false', 'null', 'undefined', 'void', 'yield', 'static', 'get', 'set'],
    typescript: ['const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'break', 'continue', 'new', 'this', 'class', 'extends', 'import', 'export', 'from', 'default', 'async', 'await', 'try', 'catch', 'finally', 'throw', 'typeof', 'instanceof', 'in', 'of', 'true', 'false', 'null', 'undefined', 'void', 'yield', 'static', 'get', 'set', 'interface', 'type', 'enum', 'namespace', 'module', 'declare', 'readonly', 'private', 'public', 'protected', 'abstract', 'as', 'is', 'keyof', 'never', 'unknown', 'any'],
    python: ['def', 'return', 'if', 'elif', 'else', 'for', 'while', 'break', 'continue', 'pass', 'class', 'import', 'from', 'as', 'try', 'except', 'finally', 'raise', 'with', 'lambda', 'yield', 'global', 'nonlocal', 'True', 'False', 'None', 'and', 'or', 'not', 'in', 'is', 'async', 'await', 'assert', 'del', 'print'],
    java: ['public', 'private', 'protected', 'static', 'final', 'abstract', 'class', 'interface', 'extends', 'implements', 'new', 'return', 'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'break', 'continue', 'try', 'catch', 'finally', 'throw', 'throws', 'import', 'package', 'void', 'int', 'long', 'double', 'float', 'boolean', 'char', 'String', 'true', 'false', 'null', 'this', 'super', 'instanceof'],
    rust: ['fn', 'let', 'mut', 'const', 'static', 'if', 'else', 'match', 'for', 'while', 'loop', 'break', 'continue', 'return', 'struct', 'enum', 'impl', 'trait', 'pub', 'use', 'mod', 'crate', 'self', 'super', 'where', 'async', 'await', 'move', 'unsafe', 'extern', 'type', 'dyn', 'ref', 'true', 'false', 'None', 'Some', 'Ok', 'Err'],
    go: ['func', 'return', 'if', 'else', 'for', 'range', 'switch', 'case', 'break', 'continue', 'var', 'const', 'type', 'struct', 'interface', 'map', 'chan', 'package', 'import', 'defer', 'go', 'select', 'default', 'true', 'false', 'nil', 'make', 'new', 'len', 'cap', 'append', 'copy', 'delete', 'panic', 'recover'],
    sql: ['SELECT', 'FROM', 'WHERE', 'AND', 'OR', 'NOT', 'IN', 'LIKE', 'BETWEEN', 'IS', 'NULL', 'ORDER', 'BY', 'ASC', 'DESC', 'GROUP', 'HAVING', 'JOIN', 'LEFT', 'RIGHT', 'INNER', 'OUTER', 'ON', 'AS', 'INSERT', 'INTO', 'VALUES', 'UPDATE', 'SET', 'DELETE', 'CREATE', 'TABLE', 'DROP', 'ALTER', 'INDEX', 'PRIMARY', 'KEY', 'FOREIGN', 'REFERENCES', 'DISTINCT', 'COUNT', 'SUM', 'AVG', 'MAX', 'MIN', 'UNION', 'LIMIT', 'OFFSET'],
    json: []  // JSON doesn't have keywords, just structure
};

// Map language aliases
const languageAliases: Record<string, string> = {
    'js': 'javascript',
    'ts': 'typescript',
    'py': 'python',
    'rs': 'rust',
    'golang': 'go'
};

/**
 * Escape HTML entities
 */
function escapeHtml(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/**
 * Wrap text in a colored span
 */
function colorize(text: string, type: TokenType): string {
    return `<span style="color:${tokenColors[type]}">${escapeHtml(text)}</span>`;
}

/**
 * Highlight JavaScript/TypeScript code
 */
function highlightJSLike(code: string, lang: string): string {
    const kws = keywords[lang] || keywords.javascript;
    let result = escapeHtml(code);

    // Comments (simple approach - line comments)
    result = result.replace(/(\/\/[^\n]*)/g, `<span style="color:${tokenColors.comment}">$1</span>`);

    // Multi-line comments
    result = result.replace(/(\/\*[\s\S]*?\*\/)/g, `<span style="color:${tokenColors.comment}">$1</span>`);

    // Strings (double and single quotes, template literals)
    result = result.replace(/("(?:[^"\\]|\\.)*")/g, `<span style="color:${tokenColors.string}">$1</span>`);
    result = result.replace(/('(?:[^'\\]|\\.)*')/g, `<span style="color:${tokenColors.string}">$1</span>`);
    result = result.replace(/(`(?:[^`\\]|\\.)*`)/g, `<span style="color:${tokenColors.string}">$1</span>`);

    // Numbers
    result = result.replace(/\b(\d+\.?\d*)\b/g, `<span style="color:${tokenColors.number}">$1</span>`);

    // Keywords (word boundaries)
    for (const kw of kws) {
        const regex = new RegExp(`\\b(${kw})\\b`, 'g');
        result = result.replace(regex, `<span style="color:${tokenColors.keyword}">$1</span>`);
    }

    // Function calls
    result = result.replace(/\b([a-zA-Z_]\w*)\s*(?=\()/g, `<span style="color:${tokenColors.function}">$1</span>`);

    return result;
}

/**
 * Highlight Python code
 */
function highlightPython(code: string): string {
    const kws = keywords.python;
    let result = escapeHtml(code);

    // Comments
    result = result.replace(/(#[^\n]*)/g, `<span style="color:${tokenColors.comment}">$1</span>`);

    // Triple-quoted strings
    result = result.replace(/("""[\s\S]*?""")/g, `<span style="color:${tokenColors.string}">$1</span>`);
    result = result.replace(/('''[\s\S]*?''')/g, `<span style="color:${tokenColors.string}">$1</span>`);

    // Regular strings
    result = result.replace(/("(?:[^"\\]|\\.)*")/g, `<span style="color:${tokenColors.string}">$1</span>`);
    result = result.replace(/('(?:[^'\\]|\\.)*')/g, `<span style="color:${tokenColors.string}">$1</span>`);

    // Numbers
    result = result.replace(/\b(\d+\.?\d*)\b/g, `<span style="color:${tokenColors.number}">$1</span>`);

    // Keywords
    for (const kw of kws) {
        const regex = new RegExp(`\\b(${kw})\\b`, 'g');
        result = result.replace(regex, `<span style="color:${tokenColors.keyword}">$1</span>`);
    }

    // Function definitions
    result = result.replace(/\b(def|class)\s+([a-zA-Z_]\w*)/g,
        `<span style="color:${tokenColors.keyword}">$1</span> <span style="color:${tokenColors.function}">$2</span>`);

    return result;
}

/**
 * Highlight SQL code
 */
function highlightSQL(code: string): string {
    let result = escapeHtml(code);

    // Comments
    result = result.replace(/(--[^\n]*)/g, `<span style="color:${tokenColors.comment}">$1</span>`);

    // Strings
    result = result.replace(/('(?:[^'\\]|\\.)*')/g, `<span style="color:${tokenColors.string}">$1</span>`);

    // Keywords (case insensitive)
    for (const kw of keywords.sql) {
        const regex = new RegExp(`\\b(${kw})\\b`, 'gi');
        result = result.replace(regex, `<span style="color:${tokenColors.keyword}">$1</span>`);
    }

    // Numbers
    result = result.replace(/\b(\d+\.?\d*)\b/g, `<span style="color:${tokenColors.number}">$1</span>`);

    return result;
}

/**
 * Highlight JSON code
 */
function highlightJSON(code: string): string {
    let result = escapeHtml(code);

    // Property keys
    result = result.replace(/"([^"]+)"(\s*:)/g,
        `<span style="color:${tokenColors.property}">"$1"</span>$2`);

    // String values
    result = result.replace(/:(\s*)"([^"]*)"/g,
        `:$1<span style="color:${tokenColors.string}">"$2"</span>`);

    // Numbers
    result = result.replace(/:(\s*)(\d+\.?\d*)/g,
        `:$1<span style="color:${tokenColors.number}">$2</span>`);

    // Boolean/null
    result = result.replace(/:\s*(true|false|null)\b/g,
        `: <span style="color:${tokenColors.keyword}">$1</span>`);

    return result;
}

/**
 * Main syntax highlighting function
 */
export function highlightCode(code: string, language: string): string {
    // Normalize language name
    const lang = (languageAliases[language.toLowerCase()] || language.toLowerCase()).trim();

    switch (lang) {
        case 'javascript':
        case 'typescript':
        case 'java':
        case 'rust':
        case 'go':
            return highlightJSLike(code, lang);
        case 'python':
            return highlightPython(code);
        case 'sql':
            return highlightSQL(code);
        case 'json':
            return highlightJSON(code);
        default:
            // For unsupported languages, just escape HTML
            return escapeHtml(code);
    }
}
