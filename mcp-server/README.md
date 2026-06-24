# Seer-AI MCP Server

MCP Server for Seer-AI Zotero Plugin - exposes Zotero research, search, review, workspace, and execution tools to external AI agents like Claude Desktop.

## Quick Start (Recommended)

### 1. Download the Bundle

Download `seerai-mcp.cjs` from the mcp-server/dist folder or from the [latest release](https://github.com/dralkh/seerai/releases).

### 2. Configure Claude Desktop

Add to your config file:

- **Linux**: `~/.config/claude-desktop/claude_desktop_config.json`
- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows**: `%AppData%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "seerai-zotero": {
      "command": "node",
      "args": ["/path/to/seerai-mcp.cjs"]
    }
  }
}
```

### 3. Start Zotero

Make sure Zotero 8 or 9 is running with the Seer-AI plugin installed (.xpi file).

### 4. Restart Claude Desktop

Claude will now have access to all Zotero tools!

---

## Requirements

- **Node.js 18+** installed
- **Zotero 8/9** with Seer-AI plugin running

## Verify Connection

```bash
curl http://127.0.0.1:23119/seerai/health
```

Should return:

```json
{ "status": "ok", "version": "1.0.0", "tools": 46 }
```

---

## Available Tools (46)

| Category            | Tools                                                                                                                                                                                      |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Library and papers  | `search_library`, `get_item_metadata`, `read_item_content`, `generate_item_tags`                                                                                                           |
| Scholarly discovery | `search_external`, `import_paper`, `related_papers`                                                                                                                                        |
| RAG search          | `semantic_search`, `keyword_search`, `read_chunks`, `search_similar`                                                                                                                       |
| Zotero organization | `context`, `collection`, `note`, `table`                                                                                                                                                   |
| Systematic reviews  | `systematic_review`                                                                                                                                                                        |
| Web and workspace   | `web`, `workspace_read_file`, `workspace_write_file`, `workspace_edit_file`, `workspace_glob`, `workspace_grep`, `workspace_question`, `workspace_bash`, `workspace_diff`, `workspace_log` |
| Files and execution | `read_file`, `write_file`, `patch`, `search_files`, `terminal`, `process`, `execute_code`, `check_environment`                                                                             |
| Agent workflow      | `todowrite`, `todoread`, `task_complete`, `todo`, `clarify`, `delegate_task`, `mixture_of_agents`                                                                                          |
| Skills              | `skills_list`, `skill_view`, `skill_manage`, `skill_reference`, `skill_info`                                                                                                               |

`search_external` supports Semantic Scholar, arXiv, PubMed, bioRxiv, medRxiv, IACR, Europe PMC, CORE, BASE, Zenodo, and HAL. `import_paper` accepts federated paper IDs, DOI, PMID/PMCID, URLs, or batches via `paper_ids`.

---

## Alternative: Install via npm

```bash
npx @seerai/mcp-server
```

Config:

```json
{
  "mcpServers": {
    "seerai-zotero": {
      "command": "npx",
      "args": ["@seerai/mcp-server"]
    }
  }
}
```

---

## Development

```bash
cd mcp-server
npm install
npm run build     # Compile TypeScript
npm run bundle    # Create single-file bundle
npm start         # Run server
```

## License

MIT
