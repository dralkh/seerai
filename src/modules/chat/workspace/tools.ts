/**
 * Workspace Tools - Agent tool definitions and execution for the per-chat workspace.
 * Provides: workspace_read_file, workspace_write_file, workspace_edit_file,
 *           workspace_glob, workspace_grep, workspace_diff, workspace_log.
 */

import {
  ToolDefinition,
  ToolParameterSchema,
  ToolResult,
} from "../tools/toolTypes";
import { getWorkspaceStore } from "./store";
import {
  WorkspaceReadFileParams,
  WorkspaceWriteFileParams,
  WorkspaceEditFileParams,
  WorkspaceGlobParams,
  WorkspaceGrepParams,
  WorkspaceQuestionParams,
  WorkspaceQuestionOption,
  WorkspaceBashParams,
  WorkspaceDiffParams,
  WorkspaceLogParams,
} from "./types";

export const WORKSPACE_TOOL_NAMES = {
  WORKSPACE_READ_FILE: "workspace_read_file",
  WORKSPACE_WRITE_FILE: "workspace_write_file",
  WORKSPACE_EDIT_FILE: "workspace_edit_file",
  WORKSPACE_GLOB: "workspace_glob",
  WORKSPACE_GREP: "workspace_grep",
  WORKSPACE_QUESTION: "workspace_question",
  WORKSPACE_BASH: "workspace_bash",
  WORKSPACE_DIFF: "workspace_diff",
  WORKSPACE_LOG: "workspace_log",
} as const;

const commonFileProps: Record<string, ToolParameterSchema> = {
  path: {
    type: "string",
    description:
      "The file path relative to workspace root. Use forward slashes for directories (e.g., 'src/main.ts').",
  },
};

export const workspaceToolDefinitions: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: WORKSPACE_TOOL_NAMES.WORKSPACE_READ_FILE,
      description:
        "Read a file from the current chat workspace. Returns the file content with line numbers. " +
        "Supports partial reads via offset and limit parameters.",
      parameters: {
        type: "object",
        properties: {
          path: commonFileProps.path,
          offset: {
            type: "integer",
            description:
              "1-indexed line number to start reading from (default: 1)",
          },
          limit: {
            type: "integer",
            description: "Maximum number of lines to read (default: all lines)",
          },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: WORKSPACE_TOOL_NAMES.WORKSPACE_WRITE_FILE,
      description:
        "Write or create a file in the current chat workspace. If the file exists, " +
        "its content will be replaced. A new version snapshot is created automatically.",
      parameters: {
        type: "object",
        properties: {
          path: commonFileProps.path,
          content: {
            type: "string",
            description: "The full content to write to the file",
          },
          message: {
            type: "string",
            description:
              "Optional description of the change (for version history)",
          },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: WORKSPACE_TOOL_NAMES.WORKSPACE_EDIT_FILE,
      description:
        "Perform exact string replacements in a workspace file. " +
        "IMPORTANT: You MUST use workspace_read_file first to see the file's actual content, " +
        "then copy the oldString exactly from the file content (preserving all whitespace, indentation, " +
        "blank lines, and surrounding code exactly as shown). " +
        "The edit will FAIL if oldString is not found in the file. " +
        "Either provide a larger string with more surrounding context to make it unique, " +
        "or use replaceAll to change every instance.",
      parameters: {
        type: "object",
        properties: {
          path: commonFileProps.path,
          oldString: {
            type: "string",
            description:
              "The exact text to replace. Copy this directly from a prior workspace_read_file result. " +
              "Include surrounding lines for uniqueness.",
          },
          newString: {
            type: "string",
            description:
              "The text to replace it with (must be different from oldString)",
          },
          replaceAll: {
            type: "boolean",
            description:
              "Replace all occurrences of oldString (default: false)",
          },
          message: {
            type: "string",
            description:
              "Optional description of the change (for version history)",
          },
        },
        required: ["path", "oldString", "newString"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: WORKSPACE_TOOL_NAMES.WORKSPACE_GLOB,
      description:
        "Find files in the workspace matching a glob pattern. " +
        "Supports standard glob patterns: * matches anything except /, ** matches any depth, ? matches single char.",
      parameters: {
        type: "object",
        properties: {
          pattern: {
            type: "string",
            description:
              "Glob pattern (e.g., '**/*.ts', 'src/**/*.md', '*.json')",
          },
          path: {
            type: "string",
            description:
              "Directory to search within (relative to workspace root). Defaults to root if omitted.",
          },
        },
        required: ["pattern"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: WORKSPACE_TOOL_NAMES.WORKSPACE_GREP,
      description:
        "Search for a regex pattern across files in the workspace. " +
        "Returns file paths, line numbers, and matching line content.",
      parameters: {
        type: "object",
        properties: {
          pattern: {
            type: "string",
            description: "Regular expression pattern to search for",
          },
          include: {
            type: "string",
            description:
              "File pattern to filter results (e.g., '*.ts', 'src/**/*.md'). If omitted, searches all files.",
          },
          path: {
            type: "string",
            description:
              "Directory to search within (relative to workspace root). Defaults to root if omitted.",
          },
        },
        required: ["pattern"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: WORKSPACE_TOOL_NAMES.WORKSPACE_QUESTION,
      description:
        "Ask the user one or more questions during execution. The questions are displayed interactively " +
        "in the chat UI for the user to answer. CRITICAL: When the user explicitly asks you to ask them " +
        "questions or to use this tool, call it IMMEDIATELY as the FIRST and ONLY tool — do NOT call any " +
        "other tools (search, read, web, table, etc.) before calling workspace_question. Use this tool " +
        "when you need clarification, decisions, or preferences from the user before proceeding with the task.",
      parameters: {
        type: "object",
        properties: {
          questions: {
            type: "array",
            description:
              "Questions to ask the user. Each question has a header (short label), the question text, and available options. The first listed option is shown as recommended.",
            items: {
              type: "object",
              properties: {
                question: {
                  type: "string",
                  description: "The complete question text",
                },
                header: {
                  type: "string",
                  description:
                    "Very short label for this question (max 30 chars)",
                },
                options: {
                  type: "array",
                  description: "Available choices for the user",
                  items: {
                    type: "object",
                    properties: {
                      label: {
                        type: "string",
                        description: "Display text for this option (1-5 words)",
                      },
                      description: {
                        type: "string",
                        description: "Explanation of what this choice means",
                      },
                    },
                    required: ["label", "description"],
                  },
                },
                multiple: {
                  type: "boolean",
                  description:
                    "Allow selecting multiple choices (default: false)",
                },
              },
              required: ["question", "header", "options"],
            },
          },
        },
        required: ["questions"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: WORKSPACE_TOOL_NAMES.WORKSPACE_BASH,
      description:
        "Request execution of a bash command. IMPORTANT: In the Zotero plugin context, " +
        "bash commands cannot be executed directly. This tool records the command and prompts the user to " +
        "run it in their terminal. Use this sparingly and prefer workspace tools (read, write, edit, glob, grep) " +
        "for file operations within the workspace.",
      parameters: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description:
              "The bash command to execute (e.g., 'npm install', 'git status')",
          },
          workdir: {
            type: "string",
            description:
              "Working directory relative to workspace root (default: workspace root)",
          },
          description: {
            type: "string",
            description:
              "Clear, concise description of what this command does (5-10 words)",
          },
        },
        required: ["command", "description"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: WORKSPACE_TOOL_NAMES.WORKSPACE_DIFF,
      description:
        "Show the diff (changes) for a workspace file. " +
        "By default shows the difference between the current version and the previous version.",
      parameters: {
        type: "object",
        properties: {
          path: commonFileProps.path,
          previous: {
            type: "boolean",
            description:
              "Compare with previous version (default: true). Set false to compare with a specific versionId.",
          },
          versionId: {
            type: "string",
            description:
              "Specific version ID to compare with. Only used when previous=false.",
          },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: WORKSPACE_TOOL_NAMES.WORKSPACE_LOG,
      description:
        "Show version history for a workspace file. Returns a list of versions with IDs, messages, and timestamps.",
      parameters: {
        type: "object",
        properties: {
          path: commonFileProps.path,
          limit: {
            type: "integer",
            description: "Maximum number of history entries (default: 20)",
          },
        },
        required: ["path"],
      },
    },
  },
];

// ==================== Tool Prompt Injection ====================

export const WORKSPACE_SYSTEM_PROMPT = `
## Workspace Tools

You have access to a per-chat workspace file system. Use these tools to work with files:

- \`workspace_read_file(path, offset?, limit?)\` - Read a file from the workspace
- \`workspace_write_file(path, content, message?)\` - Write/create a file in the workspace
- \`workspace_edit_file(path, oldString, newString, replaceAll?, message?)\` - Edit a file with exact string replacement
- \`workspace_glob(pattern, path?)\` - Find files by glob pattern
- \`workspace_grep(pattern, include?, path?)\` - Search file contents with regex
- \`workspace_diff(path, previous?, versionId?)\` - Show diff/changes for a file
- \`workspace_log(path, limit?)\` - Show version history for a file
- \`workspace_question(questions)\` - Ask the user interactive questions in chat. CRITICAL: When the user explicitly asks you to ask them questions or to use this tool, call it IMMEDIATELY as your FIRST action — do NOT search, read files, or call any other tools first. Use this when you need clarification, decisions, or preferences from the user.
- \`workspace_bash(command, workdir?, description)\` — Suggest a bash command for the user to run manually. ADVISORY ONLY: commands cannot execute directly from Zotero. Prefer workspace_read/write/edit/glob/grep for file operations.

All file paths are relative to the workspace root. The workspace is automatically versioned -
every write creates a snapshot you can diff against.

IMPORTANT: \`workspace_question\` is for interactive user communication. When the user asks to be questioned, use \`workspace_question\` directly — do not call search, read, or other tools first.
`;

// ==================== Tool Execution ====================

export async function executeWorkspaceTool(
  toolName: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const store = getWorkspaceStore();

  try {
    switch (toolName) {
      case WORKSPACE_TOOL_NAMES.WORKSPACE_READ_FILE: {
        const params = args as unknown as WorkspaceReadFileParams;
        if (!params.path) {
          return {
            success: false,
            error: 'Missing required parameter: "path"',
          };
        }

        const result = await store.readFilePartial(
          params.path,
          params.offset || 1,
          params.limit,
        );

        if (!result) {
          return {
            success: false,
            error: `File not found: "${params.path}"`,
          };
        }

        const file = await store.readFile(params.path);
        const summary = result.truncated
          ? `Read lines ${result.offset}-${result.offset + result.content.split("\n").length - 1} of ${result.totalLines} from ${params.path}`
          : `Read ${result.totalLines} lines from ${params.path} (${file?.language || "text"})`;

        return {
          success: true,
          data: {
            path: params.path,
            content: result.content,
            totalLines: result.totalLines,
            startLine: result.offset,
            truncated: result.truncated,
            language: file?.language || "text",
          },
          summary,
        };
      }

      case WORKSPACE_TOOL_NAMES.WORKSPACE_WRITE_FILE: {
        const params = args as unknown as WorkspaceWriteFileParams;
        if (!params.path || params.content === undefined) {
          return {
            success: false,
            error: 'Missing required parameters: "path" and "content"',
          };
        }

        const { versionId, created } = await store.writeFile(
          params.path,
          params.content,
          params.message,
        );

        const linesWritten = params.content.split("\n").length;
        const summary = created
          ? `Created ${params.path} (${linesWritten} lines, v${versionId})`
          : `Updated ${params.path} (${linesWritten} lines, v${versionId})`;

        return {
          success: true,
          data: { path: params.path, versionId, linesWritten, created },
          summary,
        };
      }

      case WORKSPACE_TOOL_NAMES.WORKSPACE_EDIT_FILE: {
        const params = args as unknown as WorkspaceEditFileParams;
        if (
          !params.path ||
          params.oldString === undefined ||
          params.newString === undefined
        ) {
          return {
            success: false,
            error:
              'Missing required parameters: "path", "oldString", and "newString"',
          };
        }

        const result = await store.editFile(
          params.path,
          params.oldString,
          params.newString,
          params.replaceAll || false,
          params.message,
        );

        if (!result.success) {
          return { success: false, error: result.error };
        }

        const summary = `Edited ${params.path}: ${result.replacements} replacement(s) (v${result.versionId})`;
        return {
          success: true,
          data: {
            path: params.path,
            versionId: result.versionId,
            oldString: params.oldString,
            newString: params.newString,
            replacements: result.replacements,
          },
          summary,
        };
      }

      case WORKSPACE_TOOL_NAMES.WORKSPACE_GLOB: {
        const params = args as unknown as WorkspaceGlobParams;
        if (!params.pattern) {
          return {
            success: false,
            error: 'Missing required parameter: "pattern"',
          };
        }

        const matches = await store.glob(params.pattern, params.path || "");
        const summary = `Found ${matches.length} file(s) matching "${params.pattern}"${params.path ? ` in ${params.path}` : ""}`;

        return {
          success: true,
          data: { pattern: params.pattern, matches, count: matches.length },
          summary,
        };
      }

      case WORKSPACE_TOOL_NAMES.WORKSPACE_GREP: {
        const params = args as unknown as WorkspaceGrepParams;
        if (!params.pattern) {
          return {
            success: false,
            error: 'Missing required parameter: "pattern"',
          };
        }

        const matches = await store.grep(
          params.pattern,
          params.include,
          params.path,
        );
        const summary = `Found ${matches.length} match(es) for "${params.pattern}"${params.include ? ` in ${params.include}` : ""}`;

        return {
          success: true,
          data: { pattern: params.pattern, matches, count: matches.length },
          summary,
        };
      }

      case WORKSPACE_TOOL_NAMES.WORKSPACE_QUESTION: {
        const params = args as unknown as WorkspaceQuestionParams;
        if (
          !params.questions ||
          !Array.isArray(params.questions) ||
          params.questions.length === 0
        ) {
          return {
            success: false,
            error:
              'Missing required parameter: "questions" (must be a non-empty array)',
          };
        }

        // Build a text prompt from the questions for the user
        const lines: string[] = ["The assistant has questions for you:\n"];
        for (let i = 0; i < params.questions.length; i++) {
          const q = params.questions[i];
          lines.push(`**${i + 1}. ${q.header}**`);
          lines.push(`${q.question}\n`);
          if (q.options && q.options.length > 0) {
            lines.push(`Options${q.multiple ? " (select one or more)" : ""}:`);
            q.options.forEach((opt: WorkspaceQuestionOption, j: number) => {
              lines.push(`  ${j + 1}. ${opt.label} - ${opt.description}`);
            });
          }
          lines.push("");
        }
        lines.push("Please respond with your answers to each question.");

        return {
          success: true,
          data: {
            questions: params.questions,
            prompt: lines.join("\n"),
            answeredAt: new Date().toISOString(),
            note: "User response required - questions displayed in chat",
          },
          summary: `Asked ${params.questions.length} question(s)`,
        };
      }

      case WORKSPACE_TOOL_NAMES.WORKSPACE_BASH: {
        const params = args as unknown as WorkspaceBashParams;
        if (!params.command) {
          return {
            success: false,
            error: 'Missing required parameter: "command"',
          };
        }

        return {
          success: true,
          data: {
            command: params.command,
            workdir: params.workdir || ".",
            description: (params as any).description || "",
            note:
              "Bash commands cannot be executed directly from the Zotero plugin. Please run this command in your terminal.\n\nTo run this command:\n```bash\n" +
              params.command +
              "\n```",
          },
          summary: `Bash: ${params.command.slice(0, 60)}${params.command.length > 60 ? "..." : ""}`,
        };
      }

      case WORKSPACE_TOOL_NAMES.WORKSPACE_DIFF: {
        const params = args as unknown as WorkspaceDiffParams;
        if (!params.path) {
          return {
            success: false,
            error: 'Missing required parameter: "path"',
          };
        }

        const diff = await store.getDiff(
          params.path,
          params.previous !== false,
          params.versionId,
        );

        if (!diff) {
          return {
            success: true,
            data: { path: params.path, hunks: [], additions: 0, deletions: 0 },
            summary: `No diff available for ${params.path} (no previous version or file unchanged)`,
          };
        }

        const summary = `${params.path}: +${diff.additions} -${diff.deletions}`;
        return {
          success: true,
          data: diff,
          summary,
        };
      }

      case WORKSPACE_TOOL_NAMES.WORKSPACE_LOG: {
        const params = args as unknown as WorkspaceLogParams;
        if (!params.path) {
          return {
            success: false,
            error: 'Missing required parameter: "path"',
          };
        }

        const versions = await store.getVersionHistory(
          params.path,
          params.limit || 20,
        );
        const summary = `${versions.length} version(s) for ${params.path}`;

        return {
          success: true,
          data: {
            path: params.path,
            versions: versions.map((v) => ({
              id: v.id,
              author: v.author,
              message: v.message,
              timestamp: v.timestamp,
            })),
          },
          summary,
        };
      }

      default:
        return {
          success: false,
          error: `Unknown workspace tool: ${toolName}`,
        };
    }
  } catch (e: any) {
    Zotero.debug(`[seerai] Workspace tool error: ${e}`);
    return {
      success: false,
      error: `Workspace tool error: ${e?.message || e}`,
    };
  }
}
