/**
 * Chat Tools Module
 * Exports all tool-related functionality
 */

// Types
export * from "./toolTypes";

// Schemas (Zod validation)
export {
  getSchemaForTool,
  validateToolArgs,
  safeValidateToolArgs,
  formatZodError,
  getToolSensitivity,
  requiresApproval,
} from "./schemas";

// Tool definitions
export { agentTools, getToolByName } from "./toolDefinitions";

// Tool executor
export {
  executeToolCall,
  executeToolCalls,
  parseToolCall,
  formatToolResult,
  getAgentConfigFromPrefs,
} from "./toolExecutor";

// Individual tools (for direct use if needed)
export {
  executeSearchLibrary,
  executeSearchExternal,
  executeImportPaper,
} from "./searchTool";
export { executeGetItemMetadata, executeReadItemContent } from "./readTool";
export { executeNote } from "./noteTool";
export { executeContext } from "./contextTool";
export { executeTable } from "./tableTool";
export { executeCollection } from "./collectionTool";
export { executeWeb } from "./webTool";
export { executeRelatedPapers } from "./citationTool";
export { executeGenerateItemTags } from "./tagTool";
