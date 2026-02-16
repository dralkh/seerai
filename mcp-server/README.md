# Seer-AI MCP Server

MCP Server for Seer-AI Zotero Plugin - exposes all 20 Zotero tools to external AI agents like Claude Desktop.

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

Make sure Zotero 7 is running with the Seer-AI plugin installed (.xpi file).

### 4. Restart Claude Desktop

Claude will now have access to all Zotero tools!

---

## Requirements

- **Node.js 18+** installed
- **Zotero 7** with Seer-AI plugin running

## Verify Connection

```bash
curl http://127.0.0.1:23119/seerai/health
```

Should return:

```json
{ "status": "ok", "version": "1.0.0", "tools": 20 }
```

---

## Available Tools (20)

| Tool                          | Description             |
| ----------------------------- | ----------------------- |
| `search_library`              | Search Zotero library   |
| `get_item_metadata`           | Get item metadata       |
| `read_item_content`           | Read paper content      |
| `create_note`                 | Create a note           |
| `add_to_context`              | Add to context          |
| `remove_from_context`         | Remove from context     |
| `list_context`                | List context            |
| `list_tables`                 | List tables             |
| `create_table`                | Create table            |
| `add_to_table`                | Add to table            |
| `create_table_column`         | Add AI column           |
| `generate_table_data`         | Generate AI data        |
| `read_table`                  | Read table              |
| `search_external`             | Search Semantic Scholar |
| `import_paper`                | Import paper            |
| `move_item`                   | Move to collection      |
| `remove_item_from_collection` | Remove from collection  |
| `find_collection`             | Find collection         |
| `create_collection`           | Create collection       |
| `list_collection`             | List collection         |

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
