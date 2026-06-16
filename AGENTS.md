# AGENTS.md

## Project Overview

**seerai** is an intelligent research assistant plugin for Zotero 8 that integrates AI-powered chat, semantic search, RAG, OCR, and structured data extraction into the research workflow. The repo is a monorepo containing:

- **Zotero Plugin** (`src/`, `addon/`) — runs inside Zotero's Firefox-based runtime (NOT Node.js)
- **MCP Server** (`mcp-server/`) — standalone Node.js server exposing Zotero tools via Model Context Protocol

## Commands

```bash
npm start              # Dev server with hot reload (zotero-plugin serve)
npm run build          # Production build: plugin .xpi + MCP bundle + tsc --noEmit
npm run lint:check     # Prettier check + ESLint
npm run lint:fix       # Prettier write + ESLint fix
npm run release        # Create GitHub release (zotero-plugin release)

# MCP server (separate package)
cd mcp-server && npm run bundle   # Bundle MCP server to dist/seerai-mcp.cjs
cd mcp-server && npm run dev      # Run MCP server with tsx
```

**Always run `npm run lint:check` and `npm run build` after making changes.**

**Tests (`npm test`):** Only run when the change touches testable logic (service helpers, state shapes, protocol/template flow, persistence schemas, bug fixes). Skip for pure formatting, comment, UI-style-only, or non-functional edits. When a test is warranted, run only the relevant file rather than the full suite when possible (e.g. `npx mocha test/<file>.test.ts`).

## Tech Stack

| Layer          | Technology                                           |
| -------------- | ---------------------------------------------------- |
| Language       | TypeScript                                           |
| Build          | esbuild (target: firefox128), zotero-plugin-scaffold |
| Plugin Runtime | Zotero 8 (Firefox 128-based SpiderMonkey engine)     |
| Validation     | Zod v4 (plugin), Zod v3 (MCP server)                 |
| Plugin Toolkit | zotero-plugin-toolkit v5                             |
| Types          | zotero-types v4                                      |
| Linting        | @zotero-plugin/eslint-config, Prettier               |
| MCP Server     | @modelcontextprotocol/sdk, Node.js 18+               |

## Project Structure

```
seerai/
├── addon/                      # Zotero integration assets
│   ├── bootstrap.js            # Plugin bootstrap (startup/shutdown)
│   ├── content/
│   │   ├── preferences.xhtml   # Settings panel UI
│   │   ├── preferences.css
│   │   ├── detachedPanel.xhtml # Detached window panel
│   │   └── icons/
│   ├── locale/                 # Fluent l10n (en-US, zh-CN)
│   ├── manifest.json           # WebExtension manifest (Zotero 8)
│   └── prefs.js                # Default prefs for dev environment
├── src/
│   ├── index.ts                # Entry point: registers addon on Zotero global
│   ├── addon.ts                # Addon class with lifecycle state
│   ├── hooks.ts                # Zotero event handlers (startup, menu items, shortcuts)
│   ├── modules/
│   │   ├── assistant.ts        # ⚠️ 27K-line monolith: UI, chat, tables, search
│   │   ├── openai.ts           # OpenAI-compatible API client (streaming, tools, vision)
│   │   ├── ocr.ts              # OCR service (Mistral, DataLab, local Marker)
│   │   ├── firecrawl.ts        # Firecrawl API client
│   │   ├── tavily.ts           # Tavily API client
│   │   ├── nanogptWeb.ts       # NanoGPT web search client
│   │   ├── webSearchProvider.ts # Provider abstraction (Firecrawl/Tavily/NanoGPT)
│   │   ├── semanticScholar.ts  # Semantic Scholar API client
│   │   ├── searchUtils.ts      # Boolean search engine for tables
│   │   ├── preferenceScript.ts # Settings panel logic (model configs, API keys)
│   │   ├── examples.ts         # Basic example factories
│   │   ├── chat/
│   │   │   ├── agenticChat.ts  # Agentic chat loop with tool calling
│   │   │   ├── stateManager.ts # Chat state (selections, context)
│   │   │   ├── modelConfig.ts  # Model configuration CRUD (stored in Zotero.Prefs)
│   │   │   ├── types.ts        # Chat/selection type definitions
│   │   │   ├── tableTypes.ts   # Table/search type definitions
│   │   │   ├── markdown.ts     # Markdown parsing & rendering
│   │   │   ├── messageStore.ts # Conversation persistence
│   │   │   ├── tableStore.ts   # Table data persistence
│   │   │   ├── configManager.ts # Import/export config data
│   │   │   ├── promptLibrary.ts # Prompt template system
│   │   │   ├── imageUtils.ts   # Image handling for vision
│   │   │   ├── syntaxHighlight.ts
│   │   │   ├── tracer.ts       # Agent execution tracing/observability
│   │   │   ├── placeholders.ts # Placeholder expansion (!, /, ^, ~, @, #)
│   │   │   ├── rag/            # RAG pipeline
│   │   │   │   ├── chunker.ts          # Document chunking (recursive split)
│   │   │   │   ├── embeddingService.ts # OpenAI-compatible embedding client
│   │   │   │   ├── vectorStore.ts      # File-based vector storage + cosine search
│   │   │   │   ├── retrievalEngine.ts  # Full RAG pipeline orchestration
│   │   │   │   └── types.ts            # RAG type definitions
│   │   │   ├── tools/          # Agentic tool system
│   │   │   │   ├── toolDefinitions.ts  # OpenAI function schemas
│   │   │   │   ├── toolTypes.ts        # Tool types, params, results, TOOL_NAMES
│   │   │   │   ├── toolExecutor.ts     # Central dispatch: parse → validate → execute
│   │   │   │   ├── schemas.ts          # Zod validation schemas per tool
│   │   │   │   ├── searchTool.ts       # search_library, search_external, import_paper
│   │   │   │   ├── readTool.ts         # get_item_metadata, read_item_content
│   │   │   │   ├── noteTool.ts         # create/edit note (unified)
│   │   │   │   ├── contextTool.ts      # add/remove/list context (unified)
│   │   │   │   ├── collectionTool.ts   # find/create/list/move collection (unified)
│   │   │   │   ├── tableTool.ts        # table CRUD + generate (unified)
│   │   │   │   ├── webTool.ts          # search_web, read_webpage (unified)
│   │   │   │   ├── citationTool.ts     # citations, references (unified)
│   │   │   │   ├── tagTool.ts          # generate_item_tags
│   │   │   │   └── index.ts            # Barrel exports
│   │   │   ├── context/        # Chat context management
│   │   │   │   ├── contextManager.ts
│   │   │   │   ├── contextTypes.ts
│   │   │   │   └── contextUI.ts
│   │   │   └── ui/             # Chat UI components
│   │   │       ├── chatSettings.ts
│   │   │       ├── messageRenderer.ts
│   │   │       ├── placeholderDropdown.ts
│   │   │       └── promptPicker.ts
│   │   ├── api/                # HTTP API for MCP integration
│   │   │   ├── index.ts
│   │   │   ├── endpoints.ts    # Zotero.Server.Endpoints registration
│   │   │   └── handlers.ts    # Request handlers → tool executor
│   │   ├── ui/
│   │   │   └── windowManager.ts # Detached floating window lifecycle
│   │   ├── bridge/             # (empty - reserved)
│   │   ├── search/             # (empty - reserved)
│   │   ├── services/           # (empty - reserved)
│   │   └── tables/             # (empty - reserved)
│   └── utils/
│       ├── prefs.ts            # getPref/setPref/clearPref wrappers
│       ├── locale.ts           # Fluent l10n helpers
│       ├── theme.ts            # Light/dark theme observer
│       ├── ztoolkit.ts         # ZoteroToolkit initialization
│       ├── rateLimiter.ts      # TPM/RPM/concurrency rate limiter (singleton)
│       ├── concurrentRunner.ts  # Concurrent task runner with retry + progress
│       └── window.ts           # Window utilities
├── mcp-server/                 # Standalone MCP server package
│   ├── src/
│   │   ├── index.ts            # MCP server entry (stdio transport)
│   │   ├── tools.ts            # Zod tool definitions (mirrors plugin tools)
│   │   └── zoteroClient.ts     # HTTP client to plugin API (localhost:23119)
│   ├── package.json            # Separate package (@seerai/mcp-server)
│   └── tsconfig.json
├── typings/
│   ├── global.d.ts             # Global types (addon, ztoolkit, __env__)
│   ├── prefs.d.ts              # Auto-generated preference type map
│   └── i10n.d.ts               # Fluent message IDs
├── .github/workflows/
│   ├── ci.yml                  # Lint → Build
│   └── release.yml             # Build + release on tag push
├── package.json                # Plugin package (config contains addon metadata)
├── zotero-plugin.config.ts     # Build config for zotero-plugin-scaffold
├── tsconfig.json               # Extends zotero-types/entries/sandbox/
└── eslint.config.mjs           # Extends @zotero-plugin/eslint-config
```

## Code Style & Conventions

### Formatting (Prettier)

- `printWidth: 80`, `tabWidth: 2`, `endOfLine: "lf"`
- XHTML files: `htmlWhitespaceSensitivity: "css"`

### Linting (ESLint)

- Extends `@zotero-plugin/eslint-config`
- `@typescript-eslint/no-unused-vars` is **off**
- **No comments** unless explicitly requested

### Global Variables

These are available everywhere without import (declared in `typings/global.d.ts`):

- `addon` — the Addon instance (from `src/addon.ts`)
- `ztoolkit` — ZoteroToolkit instance (from `src/utils/ztoolkit.ts`)
- `Zotero` — the Zotero global API
- `__env__` — `"development" | "production"` (injected at build time)
- `_globalThis` — global scope with addon/ztoolkit defined

### Config Access

```typescript
import { config } from "../../package.json";
// config.addonName, config.addonID, config.addonRef, config.addonInstance, config.prefsPrefix
```

Adjust relative path depth based on file location.

### Preferences

```typescript
import { getPref, setPref } from "../utils/prefs";
const value = getPref("apiURL"); // typed via PluginPrefsMap
setPref("enable", true);
```

All prefs are stored under `extensions.zotero.seerai.*`. See `typings/prefs.d.ts` for the full map.

### Singleton Pattern

Many services use `getInstance()`:

- `VectorStore.getInstance()` — RAG vector storage
- `EmbeddingService.getInstance()` — embedding API client
- `RateLimiter.getInstance()` — API rate limiting
- `OcrService` — instantiated in hooks.ts as module-level constant

### CSS & Theming

- Use CSS custom properties with Zotero theme variables: `var(--border-secondary)`, `var(--background-primary)`
- Theme (light/dark) managed via `src/utils/theme.ts` MutationObserver on `<html theme="...">`

### HTMLElement Creation

- Use `ztoolkit.UI.createElement(doc, tagName, props)` for XUL/HTML elements
- Use `doc.createElementNS(HTML_NS, tagName)` or `doc.createXULElement(tagName)` when needed directly
- `HTML_NS = "http://www.w3.org/1999/xhtml"`

## Architecture

### Plugin Lifecycle

1. `src/index.ts` — Creates `Addon` instance, registers it as `Zotero.SeerAI`, defines `ztoolkit` global
2. `src/addon.ts` — `Addon` class holds state (alive, config, env, ztoolkit, theme) + hooks + api
3. `src/hooks.ts` — Dispatcher for Zotero events:
   - `onStartup()` → init locale, register Assistant, API endpoints, detached window
   - `onMainWindowLoad()` → context menus (OCR, search PDF, tags, table), toolbar buttons, theme observer
   - `onShutdown()` → cleanup
4. **Keep hooks as dispatchers only** — real work goes in module functions

### Tool System (Agentic Chat)

The tool system follows a layered architecture:

```
toolDefinitions.ts  →  schemas.ts  →  toolExecutor.ts  →  individual tool files
(OpenAI schemas)     (Zod validate)  (parse+dispatch)    (actual execution)
```

- **Definitions**: `toolDefinitions.ts` exports `agentTools: ToolDefinition[]` — the OpenAI function schemas sent to the LLM
- **Validation**: `schemas.ts` has Zod schemas per tool. `safeValidateToolArgs()` returns rich errors for LLM self-correction
- **Execution**: `toolExecutor.ts` → `parseToolCall()` → `safeValidateToolArgs()` → dispatch to tool file
- **Consolidated tools**: `context`, `collection`, `table`, `note`, `web`, `related_papers` each have a unified `action` field instead of separate endpoints
- **Core tools**: `search_library`, `search_external`, `get_item_metadata`, `read_item_content`, `import_paper`, `generate_item_tags`
- **Tool names**: Constants in `TOOL_NAMES` (toolTypes.ts), not string literals

### RAG Pipeline

```
chunker.ts → embeddingService.ts → vectorStore.ts → retrievalEngine.ts
(split text)  (embed chunks)       (store+search)    (orchestrate pipeline)
```

- Storage: `{Zotero.DataDirectory.dir}/seerai/vectors/{itemId}.json`
- Triggered when context tokens exceed `ragTokenThreshold` pref (default 64K)
- Configurable via prefs: `ragEnabled`, `ragTopK`, `ragMinScore`, `ragChunkSize`, `ragChunkOverlap`

### Web Search Providers

`webSearchProvider.ts` abstracts three providers behind `WebSearchProvider` interface:

- Firecrawl (default)
- Tavily
- NanoGPT (routes through Tavily/other backends)

Selection via `extensions.zotero.seerai.webSearchProvider` pref.

### Chat State

- `ChatStateManager` manages selections (items, creators, tags, collections, notes, attachments, images, tables)
- Observable pattern with `subscribe(listener)` for UI reactivity
- `getMessageStore()` handles conversation persistence per chat ID

### API / MCP Integration

- `src/modules/api/endpoints.ts` registers HTTP endpoints at `/seerai/*` via `Zotero.Server`
- `src/modules/api/handlers.ts` routes requests to `toolExecutor`
- MCP server (`mcp-server/`) is a separate stdio-based process that calls these HTTP endpoints
- Default port: 23119

## Navigating assistant.ts (27K Lines)

`src/modules/assistant.ts` is the monolithic hub containing all UI rendering, event handling, and orchestration. It is the single largest file and requires careful navigation.

### Section Map (Approximate Line Ranges)

| Lines       | Content                                                                                                                  |
| ----------- | ------------------------------------------------------------------------------------------------------------------------ |
| 1–185       | Imports                                                                                                                  |
| 186–475     | PDF Search State Tracker                                                                                                 |
| 476–739     | PDF discovery helpers (`findAndAttachPdfForItem`, `getSourceLinkForPaper`)                                               |
| 740–809     | Filter presets                                                                                                           |
| 810–927     | Search History (file-based persistence)                                                                                  |
| 928–983     | Search Column Config persistence                                                                                         |
| 984–1516    | **`Assistant` class start** — OCR, PDF text, RAG content extraction                                                      |
| 1517        | **`Assistant.register()`** — Primary entry point, registers with Zotero ItemPaneManager                                  |
| 1465–1840   | Rendering infrastructure (smartRender, selection area, context estimation)                                               |
| 1841–2215   | Chat lifecycle (loadHistory, createNewChat, loadChat, deleteChat)                                                        |
| 2216–2437   | `renderInterface()` — main UI container                                                                                  |
| 2438–2553   | `createTabBar()` — Chat / Tables / Search tabs                                                                           |
| 2554–2693   | `createHistorySidebar()`                                                                                                 |
| 2694–3087   | `createChatTabContent()` — selection area, messages, input                                                               |
| 3088–3162   | `createTableTabContent()` — papers table                                                                                 |
| 3163–3504   | `createTableSideStrip()` — column controls                                                                               |
| 3505–4293   | `createSearchTabContent()` — search UI, results, insights                                                                |
| 4294–5212   | `createSearchFilters()` — advanced filter panel                                                                          |
| 5213–5434   | Search filter checkboxes, `performSearch()`                                                                              |
| 5435–5650   | Search results rendering, duplicate filtering                                                                            |
| 5651–5896   | AI insights generation + caching                                                                                         |
| 5897–6091   | Follow-up questions UI                                                                                                   |
| 6092–6787   | Citations, smart copy, AI insight settings popovers                                                                      |
| 6788–6851   | Unpaywall batch checking                                                                                                 |
| 6852–8791   | Search result cards rendering (includes addPaperToZotero, exportResultsAsBibtex)                                         |
| 8792–13197  | **Table Tab** — toolbar, filters, cell generation, PDF extraction                                                        |
| 13198–13203 | (transition gap)                                                                                                         |
| 13204–13997 | **Workspace Management** — saveWorkspaceToHistory, showWorkspacePicker, startFreshWorkspace                              |
| 13998–14061 | Table empty states, createPapersTable                                                                                    |
| 14062–15449 | Table data display, inline editing, cell generation                                                                      |
| 15450–15828 | Table refresh, debounce, pagination                                                                                      |
| 15829–16467 | Column manager modal                                                                                                     |
| 16468–16817 | Quick add column dropdown                                                                                                |
| 16818–17289 | Column edit popovers                                                                                                     |
| 17290–17886 | Unified search result rows, search column rendering                                                                      |
| 17887–18157 | Search column editor, settings popover                                                                                   |
| 18158–19202 | Search column generation, settings                                                                                       |
| 19203–19498 | Search column dropdown, tags bar, analysis                                                                               |
| 19499–19655 | CSV export, tables note persistence                                                                                      |
| 19656–19778 | Save rows as notes                                                                                                       |
| 19779–20146 | Selection area, tag picker                                                                                               |
| 20147–20657 | Paper picker, add by tags                                                                                                |
| 20658–20874 | Collections, chip creation                                                                                               |
| 20875–21143 | Model selector, Firecrawl settings, chat settings popover                                                                |
| 21144–21466 | Toggle rows, scope/selection helpers                                                                                     |
| 21467–23967 | `createInputArea()` — chat input with attachments, placeholders                                                          |
| 23968–24091 | History popover                                                                                                          |
| 24092–24239 | Inline permission request handler                                                                                        |
| 24240–25967 | `handleSendWithStreamingAndImages()` — main chat send logic                                                              |
| 25968–26177 | `appendMessage()` — message rendering                                                                                    |
| 26178–26650 | Action buttons, edit, regenerate, save as note                                                                           |
| 26651–26749 | **Table API methods** — isItemInCurrentTable, addItemsToCurrentTable, removeItemsFromCurrentTable (called from hooks.ts) |

### Safe Editing Tips

- **Search by function name** — most functionality is in `private static` methods on the `Assistant` class
- **Use grep/rg to find functions** rather than scrolling: `rg "private static createChatTabContent" src/`
- **UI sections** follow a pattern: `create*TabContent()` builds the tab, event handlers follow inline
- **When adding new UI**, follow the existing pattern: create elements with `ztoolkit.UI.createElement`, attach event listeners inline, append to container
- **When adding new features**, prefer creating a new module file under `src/modules/` or `src/modules/chat/` over growing assistant.ts further
- **The `Assistant` class methods are all `static`** — there is no instance state; state lives in module-level variables and `ChatStateManager`

### Key Entry Points (Public Static Methods)

These methods are called from outside `assistant.ts` and should be treated as stable APIs:

| Method                               | Line  | Called From      | Purpose                                                     |
| ------------------------------------ | ----- | ---------------- | ----------------------------------------------------------- |
| `Assistant.register()`               | 1517  | `hooks.ts`       | Registers the Assistant panel with Zotero's ItemPaneManager |
| `Assistant.renderToContainer()`      | 1653  | `hooks.ts`       | Renders the assistant UI in detached window                 |
| `isItemInCurrentTable()`             | 26651 | `hooks.ts`       | Context menu check: is item in current table?               |
| `addItemsToCurrentTable()`           | 26658 | `hooks.ts`       | Context menu action: add selected items to table            |
| `removeItemsFromCurrentTable()`      | 26705 | `hooks.ts`       | Context menu action: remove items from table                |
| `resolveContextItemToIds()`          | 2034  | `chat/` modules  | Resolves context selections to item IDs                     |
| `refreshAllCitations()`              | 6171  | `chat/` modules  | Updates citation formatting                                 |
| `addPaperToZoteroWithPdfDiscovery()` | 8349  | Search results   | Adds external papers to library with PDF discovery          |
| `generateDataForTable()`             | 11721 | Table generation | Main entry for table cell content generation                |

## MCP Server

The MCP server is a **separate package** in `mcp-server/` that allows external LLMs (Claude Desktop, etc.) to interact with Zotero via the plugin's HTTP API.

### Key Files

- `mcp-server/src/index.ts` — Server setup, stdio transport, tool call routing
- `mcp-server/src/tools.ts` — Zod v3 schemas mirroring plugin's tool definitions
- `mcp-server/src/zoteroClient.ts` — HTTP client to `http://127.0.0.1:23119/seerai/*`

### Build

```bash
cd mcp-server && npm run bundle   # → dist/seerai-mcp.cjs (single CJS file)
```

The main `npm run build` also runs the MCP bundle and copies the `.cjs` to the root.

### Connection Flow

```
External LLM → MCP Server (stdio) → HTTP → Zotero Plugin API (/seerai/*) → toolExecutor → Zotero
```

### Differences from Plugin Tools

- MCP server uses **Zod v3** (plugin uses Zod v4) — different API surface
- MCP server validates with `toolDef.inputSchema.parse(args)` then calls HTTP
- Plugin validates with `safeValidateToolArgs()` from `schemas.ts` then executes directly

## Critical Warnings

1. **Runtime is NOT Node.js** — The plugin runs in Zotero's SpiderMonkey engine (Firefox 128). No Node.js APIs (`fs`, `path`, `http`, etc.). Use Zotero APIs and `Zotero.File`/`Zotero.HTTP` instead.
2. **assistant.ts is 27K lines** — Navigate with search, not scrolling. Prefer adding new modules over extending it.
3. **Preferences are JSON strings** — Complex data (model configs, etc.) is `JSON.stringify`'d into `Zotero.Prefs`. Always parse/stringify when reading/writing.
4. **Build target is firefox128** — ES features are limited to what Firefox 128 supports. No top-level await, no ES2022+ features beyond what SpiderMonkey 128 implements.
5. **The `.env` file is gitignored** — Contains API keys and secrets. Never commit it. The `.env.example` is tracked.
6. **`doc/`, `seerai.xpi`, `seerai-mcp.cjs`, `.scaffold/`, `.agent/` are gitignored** — Build artifacts and agent config are not tracked.
7. **Tool schemas must stay in sync** — Plugin tool definitions (`toolDefinitions.ts`, `schemas.ts`) and MCP server tool definitions (`mcp-server/src/tools.ts`) must match. If you change one, update the other.
8. **`__env__` is injected at build time** — It's defined in `zotero-plugin.config.ts` esbuild options, not a runtime variable.
