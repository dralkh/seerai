/**
 * Prompt Library Manager
 * Core module for managing prompt templates with file-based persistence
 */

// ==================== Types ====================

export type PlaceholderType = 'topic' | 'paper' | 'author' | 'collection' | 'tag' | 'year' | 'table';
export type PromptCategory = 'analysis' | 'comparative' | 'writing' | 'summary' | 'custom';

export interface PlaceholderInfo {
    key: string;           // e.g., "topic", "paper1"
    type: PlaceholderType;
    required: boolean;
    position: number;      // Position in template string
}

export interface PromptTemplate {
    id: string;
    name: string;
    description?: string;
    template: string;           // Contains placeholder syntax
    category: PromptCategory;
    tags: string[];
    placeholders: PlaceholderInfo[];  // Extracted from template
    createdAt: string;
    updatedAt: string;
    isBuiltIn?: boolean;        // Cannot be deleted if true
}

// Placeholder trigger characters and their types
export const PLACEHOLDER_TRIGGERS: Record<string, PlaceholderType> = {
    '#': 'topic',
    '/': 'paper',
    '@': 'author',
    '^': 'collection',
    '~': 'tag',
    '$': 'table',
};

// Placeholder patterns for parsing
// Format: trigger + word characters (alphanumeric, underscore, space until delimiter)
const PLACEHOLDER_PATTERN = /([#/@^~$])(\w[\w\s]*?)(?=\s*[#/@^~.,!?;:\]]|$)/g;

// ==================== Storage ====================

let promptsFilePath: string | null = null;
let cachedPrompts: PromptTemplate[] | null = null;

/**
 * Get the path to prompts.json in Zotero data directory
 */
function getPromptsFilePath(): string {
    if (!promptsFilePath) {
        const dataDir = Zotero.DataDirectory.dir;
        promptsFilePath = PathUtils.join(dataDir, 'seer-ai', 'prompts.json');
    }
    return promptsFilePath;
}

/**
 * Ensure the seer-ai directory exists
 */
async function ensurePromptsDir(): Promise<void> {
    const dataDir = Zotero.DataDirectory.dir;
    const seerDir = PathUtils.join(dataDir, 'seer-ai');

    if (!await IOUtils.exists(seerDir)) {
        await IOUtils.makeDirectory(seerDir, { createAncestors: true });
    }
}

/**
 * Load prompts from file storage
 */
export async function loadPrompts(): Promise<PromptTemplate[]> {
    if (cachedPrompts) {
        return cachedPrompts;
    }

    await ensurePromptsDir();
    const filePath = getPromptsFilePath();

    try {
        if (await IOUtils.exists(filePath)) {
            const content = await IOUtils.readUTF8(filePath);
            const data = JSON.parse(content) as { prompts: PromptTemplate[] };
            cachedPrompts = [...getDefaultTemplates(), ...(data.prompts || [])];
        } else {
            // Initialize with default templates
            cachedPrompts = getDefaultTemplates();
            await savePrompts(cachedPrompts);
        }
    } catch (error) {
        console.error('Failed to load prompts:', error);
        cachedPrompts = getDefaultTemplates();
    }

    return cachedPrompts;
}

/**
 * Save prompts to file storage
 */
export async function savePrompts(prompts: PromptTemplate[]): Promise<void> {
    await ensurePromptsDir();
    const filePath = getPromptsFilePath();

    // Only save custom prompts, built-in ones are added at load time
    const customPrompts = prompts.filter(p => !p.isBuiltIn);

    try {
        const content = JSON.stringify({ prompts: customPrompts }, null, 2);
        await IOUtils.writeUTF8(filePath, content);
        cachedPrompts = prompts;
    } catch (error) {
        console.error('Failed to save prompts:', error);
        throw error;
    }
}

/**
 * Clear the cached prompts (for testing or refresh)
 */
export function clearPromptsCache(): void {
    cachedPrompts = null;
}

// ==================== Default Templates ====================

/**
 * Get built-in default prompt templates
 */
export function getDefaultTemplates(): PromptTemplate[] {
    const now = new Date().toISOString();

    return [
        {
            id: 'builtin-summarize-paper',
            name: 'Summarize Paper',
            description: 'Generate a concise summary of a research paper covering key findings, methodology, and contributions.',
            template: 'Summarize the key findings, methodology, and contributions of /paper. Focus on the main arguments, research methods used, and the significance of the results.',
            category: 'summary',
            tags: ['summary', 'quick-review'],
            placeholders: extractPlaceholders('Summarize the key findings, methodology, and contributions of /paper.'),
            createdAt: now,
            updatedAt: now,
            isBuiltIn: true,
        },
        {
            id: 'builtin-compare-methods',
            name: 'Compare Methodologies',
            description: 'Compare research methodologies between two papers on a specific topic.',
            template: 'Compare the research methodologies used in /paper1 and /paper2 regarding #topic. Highlight key differences in approach, data collection, and analysis methods.',
            category: 'comparative',
            tags: ['methodology', 'comparison'],
            placeholders: extractPlaceholders('Compare the research methodologies used in /paper1 and /paper2 regarding #topic.'),
            createdAt: now,
            updatedAt: now,
            isBuiltIn: true,
        },
        {
            id: 'builtin-research-gaps',
            name: 'Identify Research Gaps',
            description: 'Identify unexplored areas and research gaps based on papers in a collection.',
            template: 'Based on papers in ^collection on #topic, identify key research gaps and unexplored areas. Consider methodological limitations, understudied populations, and emerging questions.',
            category: 'analysis',
            tags: ['gap-analysis', 'research-design'],
            placeholders: extractPlaceholders('Based on papers in ^collection on #topic, identify key research gaps.'),
            createdAt: now,
            updatedAt: now,
            isBuiltIn: true,
        },
        {
            id: 'builtin-literature-review',
            name: 'Literature Review',
            description: 'Generate a literature review section covering papers by a specific author or with a specific tag.',
            template: 'Write a concise literature review on #topic covering papers by @author in ^collection. Synthesize the main themes, methodological approaches, and key findings.',
            category: 'writing',
            tags: ['literature-review', 'writing'],
            placeholders: extractPlaceholders('Write a concise literature review on #topic covering papers by @author in ^collection.'),
            createdAt: now,
            updatedAt: now,
            isBuiltIn: true,
        },
        {
            id: 'builtin-methodology-analysis',
            name: 'Methodology Analysis',
            description: 'Detailed analysis of methodological strengths and weaknesses of a paper.',
            template: 'Analyze the methodological strengths and weaknesses of /paper including: research design, sample size and selection, statistical methods, validity threats, and replicability.',
            category: 'analysis',
            tags: ['methodology', 'critical-analysis'],
            placeholders: extractPlaceholders('Analyze the methodological strengths and weaknesses of /paper.'),
            createdAt: now,
            updatedAt: now,
            isBuiltIn: true,
        },
        {
            id: 'builtin-explain-concept',
            name: 'Explain Concept',
            description: 'Explain a concept or term in the context of selected papers.',
            template: 'Explain the concept of #topic as it appears in the selected papers. Provide definitions, examples, and how different authors approach this concept.',
            category: 'summary',
            tags: ['explanation', 'concepts'],
            placeholders: extractPlaceholders('Explain the concept of #topic as it appears in the selected papers.'),
            createdAt: now,
            updatedAt: now,
            isBuiltIn: true,
        },
        {
            id: 'builtin-critique-paper',
            name: 'Critical Review',
            description: 'Generate a critical review of a paper highlighting strengths and limitations.',
            template: 'Provide a critical review of /paper. Discuss its strengths (novelty, rigor, significance) and limitations (methodology gaps, generalizability, missing perspectives). Suggest improvements.',
            category: 'analysis',
            tags: ['critique', 'review'],
            placeholders: extractPlaceholders('Provide a critical review of /paper.'),
            createdAt: now,
            updatedAt: now,
            isBuiltIn: true,
        },
        {
            id: 'builtin-extract-findings',
            name: 'Extract Key Findings',
            description: 'Extract and list the key findings from selected papers.',
            template: 'Extract and list the key findings from the selected papers on #topic. Organize findings by theme and note any contradicting results.',
            category: 'summary',
            tags: ['findings', 'extraction'],
            placeholders: extractPlaceholders('Extract and list the key findings on #topic.'),
            createdAt: now,
            updatedAt: now,
            isBuiltIn: true,
        },
    ];
}

// ==================== CRUD Operations ====================

/**
 * Generate a unique ID for new prompts
 */
function generateId(): string {
    return 'prompt-' + Date.now().toString(36) + '-' + Math.random().toString(36).substring(2, 9);
}

/**
 * Add a new prompt template
 */
export async function addPrompt(
    promptData: Omit<PromptTemplate, 'id' | 'createdAt' | 'updatedAt' | 'placeholders'>
): Promise<PromptTemplate> {
    const prompts = await loadPrompts();
    const now = new Date().toISOString();

    const newPrompt: PromptTemplate = {
        ...promptData,
        id: generateId(),
        placeholders: extractPlaceholders(promptData.template),
        createdAt: now,
        updatedAt: now,
        isBuiltIn: false,
    };

    prompts.push(newPrompt);
    await savePrompts(prompts);

    return newPrompt;
}

/**
 * Update an existing prompt template
 */
export async function updatePrompt(
    id: string,
    updates: Partial<Omit<PromptTemplate, 'id' | 'createdAt' | 'isBuiltIn'>>
): Promise<PromptTemplate> {
    const prompts = await loadPrompts();
    const index = prompts.findIndex(p => p.id === id);

    if (index === -1) {
        throw new Error(`Prompt with id ${id} not found`);
    }

    const existing = prompts[index];
    if (existing.isBuiltIn) {
        throw new Error('Cannot modify built-in prompts');
    }

    const updatedPrompt: PromptTemplate = {
        ...existing,
        ...updates,
        updatedAt: new Date().toISOString(),
        placeholders: updates.template
            ? extractPlaceholders(updates.template)
            : existing.placeholders,
    };

    prompts[index] = updatedPrompt;
    await savePrompts(prompts);

    return updatedPrompt;
}

/**
 * Delete a prompt template
 */
export async function deletePrompt(id: string): Promise<void> {
    const prompts = await loadPrompts();
    const index = prompts.findIndex(p => p.id === id);

    if (index === -1) {
        throw new Error(`Prompt with id ${id} not found`);
    }

    if (prompts[index].isBuiltIn) {
        throw new Error('Cannot delete built-in prompts');
    }

    prompts.splice(index, 1);
    await savePrompts(prompts);
}

/**
 * Get a prompt by ID
 */
export async function getPrompt(id: string): Promise<PromptTemplate | null> {
    const prompts = await loadPrompts();
    return prompts.find(p => p.id === id) || null;
}

// ==================== Search & Filter ====================

/**
 * Search prompts by query and optional filters
 */
export async function searchPrompts(
    query: string = '',
    filters?: { category?: PromptCategory; tags?: string[] }
): Promise<PromptTemplate[]> {
    const prompts = await loadPrompts();
    const lowerQuery = query.toLowerCase().trim();

    return prompts.filter(prompt => {
        // Category filter
        if (filters?.category && prompt.category !== filters.category) {
            return false;
        }

        // Tags filter (match any)
        if (filters?.tags?.length) {
            const hasTag = filters.tags.some(tag =>
                prompt.tags.map(t => t.toLowerCase()).includes(tag.toLowerCase())
            );
            if (!hasTag) return false;
        }

        // Query filter (search name, description, template)
        if (lowerQuery) {
            const searchFields = [
                prompt.name,
                prompt.description || '',
                prompt.template,
                ...prompt.tags,
            ].map(f => f.toLowerCase());

            return searchFields.some(field => field.includes(lowerQuery));
        }

        return true;
    });
}

/**
 * Get prompts by category
 */
export async function getPromptsByCategory(category: PromptCategory): Promise<PromptTemplate[]> {
    return searchPrompts('', { category });
}

/**
 * Get all unique tags from prompts
 */
export async function getAllPromptTags(): Promise<string[]> {
    const prompts = await loadPrompts();
    const tagSet = new Set<string>();

    prompts.forEach(p => p.tags.forEach(t => tagSet.add(t)));

    return Array.from(tagSet).sort();
}

// ==================== Placeholder Extraction ====================

/**
 * Extract placeholder info from a template string
 */
export function extractPlaceholders(template: string): PlaceholderInfo[] {
    const placeholders: PlaceholderInfo[] = [];
    let match: RegExpExecArray | null;

    // Reset regex state
    PLACEHOLDER_PATTERN.lastIndex = 0;

    while ((match = PLACEHOLDER_PATTERN.exec(template)) !== null) {
        const trigger = match[1];
        const key = match[2].trim();
        const type = PLACEHOLDER_TRIGGERS[trigger];

        if (type) {
            placeholders.push({
                key,
                type,
                required: true,
                position: match.index,
            });
        }
    }

    return placeholders;
}

/**
 * Get placeholder types used in a template
 */
export function getPlaceholderTypes(template: string): PlaceholderType[] {
    const placeholders = extractPlaceholders(template);
    return [...new Set(placeholders.map(p => p.type))];
}

/**
 * Check if a template has placeholders
 */
export function hasPlaceholders(template: string): boolean {
    return extractPlaceholders(template).length > 0;
}

// ==================== Category Helpers ====================

export const CATEGORY_LABELS: Record<PromptCategory, { label: string; icon: string }> = {
    analysis: { label: 'Analysis', icon: '🔍' },
    comparative: { label: 'Comparative', icon: '⚖️' },
    writing: { label: 'Writing', icon: '✍️' },
    summary: { label: 'Summary', icon: '📄' },
    custom: { label: 'Custom', icon: '⚙️' },
};

export function getCategoryLabel(category: PromptCategory): string {
    return CATEGORY_LABELS[category]?.label || category;
}

export function getCategoryIcon(category: PromptCategory): string {
    return CATEGORY_LABELS[category]?.icon || '📝';
}
