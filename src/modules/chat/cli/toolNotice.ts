import { TOOL_NAMES } from "../tools/toolTypes";

// Tools seerai itself defines. A harness tool call whose name isn't in here is
// the CLI's own tool (its built-ins or its configured MCP/skills) — we flag
// those distinctly so the user knows it's not one of our tools.
export const SEERAI_TOOL_NAMES: ReadonlySet<string> = new Set<string>(
  Object.values(TOOL_NAMES),
);

/** True when `name` is one of seerai's own defined tools. */
export function isSeeraiTool(name: string): boolean {
  return SEERAI_TOOL_NAMES.has(name);
}

/**
 * Format a one-line, clearly-marked notice for a tool the harness ran on its
 * own. seerai never executes these — we surface them for transparency, calling
 * out when the tool isn't one we defined.
 */
export function formatToolNotice(
  agentName: string,
  name: string,
  detail?: string,
): string {
  const trimmedDetail = detail
    ? detail.replace(/\s+/g, " ").trim().slice(0, 160)
    : "";
  const tail = trimmedDetail ? ` — \`${trimmedDetail}\`` : "";
  if (isSeeraiTool(name)) {
    return `\n\n> 🔧 **${name}**${tail}\n\n`;
  }
  return `\n\n> 🔧 ${agentName} ran its own tool **${name}** _(not a seerai tool)_${tail}\n\n`;
}
