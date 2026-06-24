// System-prompt guidance for a CLI harness agentic turn. A harness is its own
// agent with its own file/bash tools; seerai's research tools reach it ONLY via
// the seerai-zotero MCP server. So we never describe seerai's tools by bare name
// (the harness sees them MCP-prefixed, or not at all) — generic guidance only.

/**
 * @param connected whether seerai's MCP bridge is active for this harness
 *   (Claude/Codex in agentic mode, or a harness the user clicked "Connect").
 */
export function buildCliAgentInstructions(connected: boolean): string {
  if (connected) {
    return `You are a research assistant working in the user's Zotero environment via seerai. Your access to the user's Zotero library and research tools is provided by the connected "seerai-zotero" MCP server. Use those MCP tools to: search the library, read paper content (PDFs/notes), manage collections, notes and synthesis tables, discover and import papers, run semantic/keyword (RAG) search, and conduct systematic reviews. They appear in your own tool registry — possibly prefixed (e.g. mcp__seerai-zotero__search_library). Prefer them over reading the Zotero database or files directly. If these MCP tools are NOT in your registry, the bridge is not connected: tell the user to open seerai settings and click "Connect" for this harness — do not fabricate or guess library data.`;
  }
  return `Note: seerai's Zotero research tools are NOT connected to this harness, so you cannot query the user's library directly. Do not claim to call Zotero tools, and do not invent library contents. Answer from the conversation, or tell the user to connect the seerai MCP bridge for this harness in seerai's settings.`;
}
