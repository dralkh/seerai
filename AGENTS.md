# AGENTS.md

## Project Overview

**seerai** is an intelligent research assistant plugin for Zotero 8/9 that integrates AI-powered chat, federated scholarly search, RAG, OCR, systematic review, cloud storage, an agent skills library, and structured data extraction into the research workflow. The repo is a monorepo containing:

- **Zotero Plugin** (`src/`, `addon/`) — runs inside Zotero's Firefox-based runtime (NOT Node.js)
- **MCP Server** (`mcp-server/`) — standalone Node.js server exposing Zotero tools via Model Context Protocol
- **Agent Skills Library** (`skills/`) — ~148 bundled, self-contained skill packages (SKILL.md + references/scripts) surfaced to agents via the skills tools

## Commands

```bash
npm start              # Dev server with hot reload (zotero-plugin serve)
npm run build          # Production build: MCP bundle → plugin .xpi + tsc --noEmit + copies artifacts to root
npm run lint:check     # Prettier check + ESLint
npm run lint:fix       # Prettier write + ESLint fix
npm run release        # Create GitHub release (zotero-plugin release)
npm run test           # Run test suite (zotero-plugin test → mocha-based)
npm run test:extraction-eval  # LLM extraction evaluation harness (tsx test/extractionModelEval.ts)
npm run test:pipeline-eval    # Systematic-review pipeline evaluation harness (tsx test/pipelineEval.ts)
npm run update-deps    # Update all dependencies to latest (npm update --save)

# MCP server (separate package)
cd mcp-server && npm run dev      # Run MCP server with tsx
cd mcp-server && npm run bundle   # Bundle MCP server to dist/seerai-mcp.cjs
cd mcp-server && npm run build    # TypeScript compile (tsc)
cd mcp-server && npm run start    # Run compiled MCP server
```

**Always run `npm run lint:check` and `npm run build` after making changes.**

**Tests (`npm test`):** Only run when the change touches testable logic (service helpers, state shapes, protocol/template flow, persistence schemas, bug fixes). Skip for pure formatting, comment, UI-style-only, or non-functional edits. When a test is warranted, run only the relevant file rather than the full suite when possible (e.g. `npx mocha test/<file>.test.ts`).

## Tech Stack

| Layer              | Technology                                                   |
| ------------------ | ------------------------------------------------------------ |
| Language           | TypeScript                                                   |
| Build              | esbuild (target: firefox128), zotero-plugin-scaffold v0.8    |
| Plugin Runtime     | Zotero 8/9 (Firefox 128-based SpiderMonkey engine)           |
| Validation         | Zod v4 (plugin), Zod v3 (MCP server)                         |
| Plugin Toolkit     | zotero-plugin-toolkit v5 (^5.1.0-beta.13)                    |
| Types              | zotero-types v4 (^4.1.0-beta.8)                              |
| Linting            | @zotero-plugin/eslint-config, Prettier                       |
| Testing            | Mocha + Chai + tsx (evaluation harnesses)                    |
| Tokenization       | gpt-tokenizer                                                |
| DOCX/Markdown/Math | mammoth, docx-preview, turndown, katex                       |
| MCP Server         | @modelcontextprotocol/sdk, zod, zod-to-json-schema, Node 18+ |

## Project Structure

```
seerai/
├── addon/                      # Zotero integration assets
│   ├── bootstrap.js            # Plugin bootstrap (startup/shutdown)
│   ├── content/
│   │   ├── preferences.xhtml   # Settings panel UI
│   │   ├── preferences.css
│   │   ├── detachedPanel.xhtml # Detached window panel
│   │   ├── zoteroPane.css      # Plugin pane styles
│   │   └── icons/
│   ├── locale/                 # Fluent l10n (en-US, zh-CN)
│   ├── manifest.json           # WebExtension manifest (Zotero 8–9)
│   └── prefs.js                # Default prefs for dev environment
├── src/
│   ├── index.ts                # Entry point: registers addon on Zotero global
│   ├── addon.ts                # Addon class with lifecycle state
│   ├── hooks.ts                # Zotero event handlers (startup, menus, shortcuts, cloud init)
│   ├── modules/
│   │   ├── assistant.ts        # ⚠️ 32K-line monolith: UI, chat, tables, search, workspaces
│   │   ├── openai.ts           # OpenAI-compatible API client (streaming, tools, vision)
│   │   ├── ocr.ts              # OCR service (Mistral, DataLab, local Marker)
│   │   ├── firecrawl.ts        # Firecrawl API client
│   │   ├── tavily.ts           # Tavily API client
│   │   ├── youdotcom.ts        # You.com API client (normal + research mode)
│   │   ├── nanogptWeb.ts       # NanoGPT web search client
│   │   ├── webSearchProvider.ts # Provider abstraction (Firecrawl/Tavily/NanoGPT/You.com)
│   │   ├── semanticScholar.ts  # Semantic Scholar API client
│   │   ├── searchUtils.ts      # Boolean search engine for tables
│   │   ├── preferenceScript.ts # Settings panel logic (model configs, API keys)
│   │   ├── examples.ts         # Basic example factories
│   │   ├── fileViewer.ts       # Workspace file preview (SVG/HTML/markdown/images)
│   │   ├── docxConverter.ts    # DOCX to Markdown conversion (mammoth)
│   │   ├── setImmediatePolyfill.ts # setImmediate polyfill for mammoth
│   │   ├── testBooleanSearch.ts # Boolean search test harness
│   │   ├── chat/
│   │   │   ├── agenticChat.ts  # Agentic chat loop with tool calling
│   │   │   ├── stateManager.ts # Chat state (selections, context)
│   │   │   ├── modelConfig.ts  # Model config CRUD (file-based: {DataDir}/seerai/modelConfigs.json)
│   │   │   ├── modelDiscovery.ts # /models endpoint discovery, auth headers, connection testing
│   │   │   ├── modelResolver.ts # Resolves a ModelRef → ResolvedModel (provider, endpoint, capability)
│   │   │   ├── providerTypes.ts # Provider/model config types, ModelCapability, inferCapabilities()
│   │   │   ├── providerRegistry.ts # Provider config CRUD (file-based: {DataDir}/seerai/providerConfigs.json)
│   │   │   ├── providerPresets.ts # Built-in provider presets (OpenAI, Anthropic, Gemini, xAI, CLI agents, etc.)
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
│   │   │   ├── tokenizer.ts    # Token counting via gpt-tokenizer
│   │   │   ├── placeholders.ts # Placeholder expansion (!, /, ^, ~, @, #)
│   │   │   ├── rag/            # RAG pipeline
│   │   │   │   ├── chunker.ts          # Document chunking (recursive split)
│   │   │   │   ├── embeddingService.ts # OpenAI-compatible embedding client
│   │   │   │   ├── vectorStore.ts      # File-based vector storage + cosine search
│   │   │   │   ├── retrievalEngine.ts  # Full RAG pipeline orchestration
│   │   │   │   ├── bm25.ts            # BM25 keyword search + hybrid RRF merging
│   │   │   │   ├── backgroundIndexer.ts # Background RAG indexing worker
│   │   │   │   ├── citationGraph.ts    # Citation-graph traversal for RAG
│   │   │   │   ├── evaluator.ts       # RAG evaluation / ground-truth scoring
│   │   │   │   ├── reranker.ts        # Cross-encoder reranker (Jina / Cohere)
│   │   │   │   └── types.ts           # RAG type definitions
│   │   │   ├── tools/          # Agentic tool system
│   │   │   │   ├── toolDefinitions.ts  # OpenAI function schemas
│   │   │   │   ├── toolTypes.ts        # Tool types, params, results, TOOL_NAMES, ToolSensitivity
│   │   │   │   ├── toolExecutor.ts     # Central dispatch: parse → validate → execute
│   │   │   │   ├── schemas.ts          # Zod validation schemas per tool
│   │   │   │   ├── searchTool.ts       # search_library, search_external, import_paper
│   │   │   │   ├── searchExternalAdapter.ts # Adapter: tool params → federated scholarly query
│   │   │   │   ├── readTool.ts         # get_item_metadata, read_item_content
│   │   │   │   ├── noteTool.ts         # Unified note create/edit
│   │   │   │   ├── contextTool.ts      # Unified context add/remove/list
│   │   │   │   ├── collectionTool.ts   # Unified collection find/create/list/add/remove
│   │   │   │   ├── tableTool.ts        # Unified table CRUD + generate
│   │   │   │   ├── webTool.ts          # Unified search_web, read_webpage
│   │   │   │   ├── citationTool.ts     # Unified citations, references
│   │   │   │   ├── tagTool.ts          # generate_item_tags
│   │   │   │   ├── ragTool.ts          # semantic_search, keyword_search, read_chunks, search_similar
│   │   │   │   ├── systematicReviewTool.ts # systematic_review
│   │   │   │   ├── todoTool.ts         # todowrite, todoread, task_complete
│   │   │   │   └── index.ts            # Barrel exports
│   │   │   ├── workspace/      # Per-chat file workspace
│   │   │   │   ├── index.ts    # Workspace entry
│   │   │   │   ├── store.ts    # Workspace file persistence
│   │   │   │   ├── types.ts    # Workspace type definitions
│   │   │   │   ├── sidebar.ts  # File tree sidebar UI
│   │   │   │   ├── editor.ts   # Monaco-inspired code editor
│   │   │   │   ├── diff.ts     # Diff viewer
│   │   │   │   ├── gitCli.ts   # Native git CLI integration
│   │   │   │   └── tools.ts    # workspace_* agent tools
│   │   │   ├── context/        # Chat context management
│   │   │   │   ├── contextManager.ts
│   │   │   │   ├── contextTypes.ts
│   │   │   │   └── contextUI.ts
│   │   │   ├── cli/            # Local CLI provider adapters (no stored creds)
│   │   │   │   ├── agents.ts            # CLI agent registry (getCliAgent/listCliAgents)
│   │   │   │   ├── cliTypes.ts          # CliAgentDef contract + auth-failure helpers
│   │   │   │   ├── cliDetection.ts      # PATH/version/auth-status probing
│   │   │   │   ├── cliRunner.ts         # Spawns CLI, streams stdout → ProviderEvents
│   │   │   │   ├── cliProvider.ts       # AgentProvider impl flattening chat → one prompt
│   │   │   │   ├── cliModels.ts         # CLI model listing helpers
│   │   │   │   ├── codexAgent.ts        # OpenAI Codex CLI
│   │   │   │   ├── claudeAgent.ts       # Claude Code CLI
│   │   │   │   ├── antigravityAgent.ts  # Antigravity CLI
│   │   │   │   ├── hermesAgent.ts       # Hermes (Nous) CLI
│   │   │   │   ├── openclawAgent.ts     # OpenClaw gateway CLI
│   │   │   │   ├── mcpBridge.ts         # Bundled MCP server bridge for CLI harnesses
│   │   │   │   ├── harnessPrompt.ts     # System prompt for CLI agentic turns
│   │   │   │   ├── toolActivityBridge.ts # Live tool-activity surfacing from harnesses
│   │   │   │   └── toolNotice.ts        # Formatting for harness tool-activity notices
│   │   │   ├── skills/         # Agent skills registry
│   │   │   │   └── registry.ts          # Bundled + user/workspace/custom skills; state in .agent/skills.json
│   │   │   ├── ui/             # Chat UI components
│   │   │   │   ├── chatSettings.ts
│   │   │   │   ├── messageRenderer.ts
│   │   │   │   ├── placeholderDropdown.ts
│   │   │   │   ├── promptPicker.ts
│   │   │   │   ├── providerManager.ts   # AI Models / provider config UI
│   │   │   │   ├── integrationSettings.ts # Search/OCR/cloud integration settings UI
│   │   │   │   ├── serviceSettings.ts   # Per-service quick settings
│   │   │   │   ├── harnessBridgeModal.ts # Connect seerai tools to CLI harnesses
│   │   │   │   └── icons.ts   # SVG icon registry + factory
│   │   ├── search/             # Federated scholarly search (11 providers)
│   │   │   ├── index.ts        # Barrel exports
│   │   │   ├── types.ts        # ScholarlyPaper, provider ids, search modes/queries
│   │   │   ├── queryIR.ts      # Provider-agnostic query IR (concept groups + synonyms)
│   │   │   ├── queryCompiler.ts # Per-provider compilers: IR → native query dialect
│   │   │   ├── providers.ts    # Provider adapters + capability descriptors
│   │   │   ├── service.ts      # Federated fetch orchestration, result caps
│   │   │   ├── merge.ts        # Dedup + reciprocal-rank-fusion across providers
│   │   │   ├── filterOptions.ts # Per-provider filter option catalogs
│   │   │   ├── http.ts         # Shared HTTP helpers for providers
│   │   │   ├── bibtex.ts       # BibTeX rendering of results
│   │   │   ├── exportManager.ts # Result export (BibTeX/CSV)
│   │   │   ├── controller.ts   # Search session controller
│   │   │   ├── persistence.ts  # Search session/history persistence
│   │   │   └── env.ts          # Provider env/key resolution
│   │   ├── systematicReview/   # Systematic review module
│   │   │   ├── systematicReviewTab.ts # Review tab UI (12K lines)
│   │   │   ├── service.ts      # Review pipeline orchestration
│   │   │   ├── store.ts        # Project state persistence
│   │   │   ├── types.ts        # SR type definitions
│   │   │   ├── protocol.ts     # Review protocol definition & validation
│   │   │   ├── protocolPresets.ts # Pre-built protocol templates
│   │   │   ├── paperAnalyzer.ts # AI-driven paper analysis
│   │   │   ├── documentAnalyzer.ts # Document-level analysis
│   │   │   ├── extractionWorkflow.ts # Data extraction pipeline
│   │   │   ├── analysisEngine.ts # Evidence synthesis engine
│   │   │   ├── extractionHealth.ts # Extraction quality monitoring
│   │   │   ├── compatibility.ts # Extraction compatibility / poolability grouping
│   │   │   ├── grounding.ts    # Quote-grounding validation (exact + fuzzy)
│   │   │   ├── measures.ts     # Effect/performance measure taxonomy
│   │   │   ├── sources.ts      # Review source management
│   │   │   ├── reviewSourceService.ts # Source sync/import
│   │   │   ├── scientific.ts   # Scientific notation & stats
│   │   │   ├── modelOutput.ts  # LLM output parsing & validation
│   │   │   ├── cancellation.ts # Job cancellation
│   │   │   └── utils.ts        # SR utilities
│   │   ├── api/                # HTTP API for MCP integration
│   │   │   ├── index.ts
│   │   │   ├── endpoints.ts    # Zotero.Server.Endpoints registration
│   │   │   └── handlers.ts    # Request handlers → tool executor
│   │   ├── cloud/              # Cloud storage UI
│   │   │   └── cloudTab.ts     # Cloud Drive tab (Google Drive, Dropbox, etc.)
│   │   ├── drive/              # Cloud provider integrations
│   │   │   ├── index.ts        # CloudProviderManager entry
│   │   │   ├── driveUI.ts      # Cloud storage UI utilities
│   │   │   ├── types.ts        # Cloud provider types
│   │   │   ├── providerManager.ts # Provider lifecycle management
│   │   │   ├── pkce.ts         # OAuth 2.0 PKCE flow
│   │   │   ├── oauthServer.ts  # Local OAuth callback server
│   │   │   ├── cloudContext.ts # Cloud file context in chat
│   │   │   ├── utils.ts        # Cloud utilities
│   │   │   └── providers/
│   │   │       ├── base.ts     # Base provider interface
│   │   │       ├── google.ts   # Google Drive
│   │   │       ├── dropbox.ts  # Dropbox
│   │   │       ├── box.ts      # Box
│   │   │       ├── onedrive.ts # OneDrive
│   │   │       └── nextcloud.ts # Nextcloud
│   │   ├── ui/
│   │   │   └── windowManager.ts # Detached floating window lifecycle
│   │   └── bridge/             # (empty - reserved)
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
│   │   ├── tools.ts            # Zod v3 tool definitions (mirrors plugin tools)
│   │   └── zoteroClient.ts     # HTTP client to plugin API (localhost:23119)
│   ├── package.json            # Separate package (@seerai/mcp-server)
│   └── tsconfig.json
├── skills/                     # ~148 bundled agent skill packages (SKILL.md + references/scripts)
├── typings/
│   ├── global.d.ts             # Global types (addon, ztoolkit, __env__)
│   ├── prefs.d.ts              # Auto-generated preference type map
│   └── i10n.d.ts               # Fluent message IDs
├── test/                       # Mocha/Chai test files
│   ├── startup.test.ts
│   ├── markdown.test.ts
│   ├── modelRouting.test.ts / modelResolver.test.ts / modelDiscovery.test.ts
│   ├── providerPresets.test.ts
│   ├── agentSkills.test.ts / agentStabilization.test.ts
│   ├── queryCompiler.test.ts / queryThreading.test.ts
│   ├── scholarly*.test.ts      # Federated search (http, fixtures, search, live)
│   └── systematicReview*.test.ts
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

All prefs are stored under `extensions.zotero.seerai.*`. See `addon/prefs.js` for defaults and `typings/prefs.d.ts` for the full typed map.

### File-Based Persistence

Some complex configuration is stored as files under `{Zotero.DataDirectory.dir}/seerai/` rather than in Zotero.Prefs:

- **Model configs**: `modelConfigs.json` — managed via `src/modules/chat/modelConfig.ts`
- **Provider configs**: `providerConfigs.json` — managed via `src/modules/chat/providerRegistry.ts`
- **Workspace files**: `workspaces/{chatId}/` — managed via `src/modules/chat/workspace/store.ts`
- **Systematic review state**: `systematicReview.json` — managed via `src/modules/systematicReview/store.ts`
- **RAG vectors**: `vectors/{itemId}.json` + `_index.json` manifest

### Singleton Pattern

Many services use `getInstance()`:

- `VectorStore.getInstance()` — RAG vector storage
- `EmbeddingService.getInstance()` — embedding API client
- `RateLimiter.getInstance()` — API rate limiting
- `CloudProviderManager.getInstance()` — cloud provider lifecycle
- `OcrService` — instantiated in hooks.ts as module-level constant

### CSS & Theming

- Use CSS custom properties with Zotero theme variables: `var(--border-secondary)`, `var(--background-primary)`
- Theme (light/dark) managed via `src/utils/theme.ts` MutationObserver on `<html theme="...">`

### HTMLElement Creation

- Use `ztoolkit.UI.createElement(doc, tagName, props)` for XUL/HTML elements
- Use `doc.createElementNS(HTML_NS, tagName)` or `doc.createXULElement(tagName)` when needed directly
- `HTML_NS = "http://www.w3.org/1999/xhtml"`

### SVG Icons

All icons use SVG via `src/modules/chat/ui/icons.ts` which exports `createSvgIcon(iconName)` and `setButtonIcon(button, iconName)`. The `IconName` union type (~95 names) covers all UI icons. No emoji or unicode icons.

## Architecture

### Plugin Lifecycle

1. `src/index.ts` — Creates `Addon` instance, registers it as `Zotero.SeerAI`, defines `ztoolkit` global
2. `src/addon.ts` — `Addon` class holds state (alive, config, env, ztoolkit, theme) + hooks + api
3. `src/hooks.ts` — Dispatcher for Zotero events:
   - `onStartup()` → init locale, register Assistant, init model configs, preload systematic review state, register API endpoints, register cloud OAuth callbacks, start background RAG indexer
   - `onMainWindowLoad()` → context menus (OCR, search PDF, tags, table add/remove, systematic review add/remove), toolbar buttons, theme observer
   - `onShutdown()` → cleanup (stop background indexer, etc.)
4. **Keep hooks as dispatchers only** — real work goes in module functions

### Tab System

The main UI has **5 tabs** rendered by `assistant.ts:createTabBar()`:

1. **Chat** — LLM conversation + workspace sidebar + context selection
2. **Table** — structured data extraction with AI-powered columns
3. **Review** — systematic review projects (PRISMA, extraction, synthesis)
4. **Search** — federated scholarly search across 11 providers + AI insights (see "Federated Scholarly Search")
5. **Cloud** — cloud storage integration (Google Drive, Dropbox, Box, OneDrive, Nextcloud)

### Tool System (Agentic Chat)

The tool system follows a layered architecture:

```
toolDefinitions.ts  →  schemas.ts  →  toolExecutor.ts  →  individual tool files
(OpenAI schemas)     (Zod validate)  (parse+dispatch)    (actual execution)
```

- **Definitions**: `toolDefinitions.ts` exports `agentTools: ToolDefinition[]` — the OpenAI function schemas sent to the LLM
- **Validation**: `schemas.ts` has Zod schemas per tool. `safeValidateToolArgs()` returns rich errors for LLM self-correction
- **Execution**: `toolExecutor.ts` → `parseToolCall()` → `safeValidateToolArgs()` → dispatch to tool file
- **Consolidated tools**: `context`, `collection`, `table`, `note`, `web`, `related_papers`, `systematic_review` each have a unified `action` field instead of separate endpoints
- **Core tools**: `search_library`, `search_external`, `get_item_metadata`, `read_item_content`, `import_paper`, `generate_item_tags`
  - `search_external` now supports smart corpus modes (`broad`, `biomedical`, `preprints`, `cryptography`, `repositories`), explicit provider(s), filters, concept groups, exclusions, and field scope — mapped to the federated search pipeline by `searchExternalAdapter.ts`
- **RAG tools**: `semantic_search`, `keyword_search`, `read_chunks`, `search_similar`
- **TODO tools**: `todowrite`, `todoread`, `task_complete` — agent task planning and completion signaling
- **Workspace tools**: `workspace_read_file`, `workspace_write_file`, `workspace_edit_file`, `workspace_glob`, `workspace_grep`, `workspace_bash`, `workspace_diff`, `workspace_log`
- **Skills tools**: `skills_list`, `skill_view`, `skill_manage`, `skill_reference`, `skill_info` — discover and load agent skills on demand (see "Agent Skills Library")
- **Tool names**: Constants in `TOOL_NAMES` (toolTypes.ts), not string literals

#### Tool Sensitivity

`toolTypes.ts` defines `ToolSensitivity` enum for human-in-the-loop gating:

- `READ` — safe read-only operations, auto-execute
- `WRITE` — modifications that can be undone, warn but allow
- `DESTRUCTIVE` — irreversible operations, require confirmation

### RAG Pipeline

```
chunker.ts → embeddingService.ts → vectorStore.ts → retrievalEngine.ts
(split text)  (embed chunks)       (store+search)    (orchestrate pipeline)
              bm25.ts (lexical) ───────┘
              reranker.ts (cross-encoder) ─┘
              citationGraph.ts ────────────┘
              evaluator.ts ────────────────┘
              backgroundIndexer.ts ────────┘
```

- Storage: `{Zotero.DataDirectory.dir}/{addonRef}/vectors/{itemId}.json` + `_index.json` manifest
- Triggered when context tokens exceed `ragTokenThreshold` pref (default 64K)
- Features: BM25+RRF hybrid retrieval, MMR diversity, query expansion, multi-query, HyDE, contextual retrieval, sentence-window retrieval, query decomposition, citation-graph traversal, cross-encoder reranking (Jina/Cohere), correction loops
- Configurable via many prefs under `rag*` namespace (see `addon/prefs.js`)

### Web Search Providers

`webSearchProvider.ts` abstracts four providers behind `WebSearchProvider` interface:

- **Firecrawl** (default) — `src/modules/firecrawl.ts`
- **Tavily** — `src/modules/tavily.ts`
- **NanoGPT** — `src/modules/nanogptWeb.ts` (routes through Tavily/other backends)
- **You.com** — `src/modules/youdotcom.ts` (supports `"normal"` and `"research"` modes)

Selection via `extensions.zotero.seerai.webSearchProvider` pref.

### Chat State

- `ChatStateManager` manages selections (items, creators, tags, collections, notes, attachments, images, tables)
- Observable pattern with `subscribe(listener)` for UI reactivity
- `getMessageStore()` handles conversation persistence per chat ID

### Model Routing & Providers

Models are addressed by a `ModelRef` (provider + local model id) and resolved at call time by `modelResolver.ts` into a `ResolvedModel` (base URL, endpoint, auth headers, capability). Configuration is file-based in `providerConfigs.json` (`providerRegistry.ts`).

- **Capabilities** (`ModelType` in `chat/types.ts`): `chat`, `embedding`, `image`, `video`, `tts`, `stt`. `MODEL_TYPE_ENDPOINTS` maps each to its API path; per-model `endpointOverrides` and adapter-specific routing (e.g. OpenRouter `/videos`, image via `/chat/completions`) are applied in `modelResolver.ts`.
- **Presets** (`providerPresets.ts`): OpenAI, Anthropic, Google, xAI, Mistral, DeepSeek, Together, Groq, Fireworks, Cohere, OpenRouter, plus the local CLI agents below. `inferCapabilities()` derives capabilities from model id strings.
- **Discovery**: `modelDiscovery.ts` hits `/models`, builds auth headers, and tests connections.

### Local CLI Providers

`src/modules/chat/cli/` lets seerai delegate a chat turn to a **locally installed agent CLI** instead of an HTTP API. Supported: **Codex** (OpenAI), **Claude Code**, **Antigravity**, **Hermes (Nous)**, **OpenClaw**. (GitHub Copilot's adapter file still exists but is not currently registered.)

- seerai stores **no credentials** — it inherits whatever login session the CLI already holds.
- Each CLI is described by a `CliAgentDef` (`cliTypes.ts`): binary name, one-shot args, stream format (`json-lines` | `raw-text`), line parser, auth-failure patterns, optional `prepare()` and live `listModels`.
- `cliRunner.ts` spawns the binary, feeds one flattened prompt over stdin, and streams stdout into `ProviderEvent`s; `cliProvider.ts` implements the `AgentProvider` interface; `cliDetection.ts` probes PATH/version/auth. Provider configs reference an agent via `cliAgentId`.
- Images are dropped (CLIs receive text only).
- **Agentic mode**: when seerai's agentic mode is ON, CLI harnesses run as full agents in the chat workspace and can receive seerai's research tools over a bundled MCP bridge (`mcpBridge.ts`). Claude and Codex attach the MCP server automatically per session; Hermes, Antigravity, and OpenClaw are connected via persistent config (and shown a one-click connect modal from `harnessBridgeModal.ts`). When agentic mode is OFF, the harness is forced into a plain-chat turn with no tools or file writes.
- **Tool-activity surfacing**: harnesses report their own tool calls (built-ins or configured MCP/skills). `toolActivityBridge.ts` relays seerai-MCP tool calls back to the chat UI, and `toolNotice.ts` formats harness tool activity so the user can see what ran — including when it was a harness-native tool rather than a seerai tool.

### Federated Scholarly Search

`src/modules/search/` powers the **Search** tab and the agent's external search. It queries up to **11 providers** — Semantic Scholar, arXiv, PubMed, bioRxiv, medRxiv, IACR, Europe PMC, CORE, BASE, Zenodo, HAL.

- **Query IR** (`queryIR.ts`): the AI "refine query" feature extracts a provider-agnostic intermediate representation **once** (AND-ed concept groups, each an OR of synonyms, plus MeSH descriptors, exclusions, field scope). Deterministic per-provider compilers (`queryCompiler.ts`) then render it into each source's native dialect — the LLM never has to memorize 11 query syntaxes.
- **Search modes** (`types.ts`): `broad`, `biomedical`, `preprints`, `cryptography`, `repositories` map to fixed provider sets (`SMART_MODE_PROVIDERS`); `source` mode targets explicitly chosen providers.
- **Merge** (`merge.ts`): cross-provider deduplication + reciprocal rank fusion; `service.ts` enforces per-provider and federated result caps (`FEDERATED_RESULT_CAP`).
- Results export to BibTeX/CSV (`bibtex.ts`, `exportManager.ts`); sessions persist via `persistence.ts`.

### Agent Skills Library

The `skills/` top-level directory holds ~148 self-contained skill packages (each a `SKILL.md` with YAML frontmatter plus optional `references/`, `scripts/`, `assets/`). `src/modules/chat/skills/registry.ts` exposes them to the agent.

- **Sources**: `bundled` (in-repo), `user`, `workspace` (`.agent/`-discovered), and `custom`. Enable/trust state persists to `.agent/skills.json` (`SkillRegistryState`).
- **Agent access**: the skills tools (`skills_list`, `skill_view`, `skill_reference`, `skill_info`, `skill_manage`) let the agent search the catalog, read a skill's body, pull reference files, and manage enable/trust — loading instructions on demand rather than front-loading them into the system prompt.
- Mirrored in the MCP server (`skills_list`, `skill_view`, etc.) so external LLMs get the same library.

### Systematic Review Module

Located in `src/modules/systematicReview/`. Provides an end-to-end systematic review workflow:

- **Protocol**: Structured review protocol with research question, framework (PICO/PICOS/PECO/SPICE), inclusion/exclusion criteria, keyword aids, and extraction templates. Supports revision history and rollback.
- **Sources**: Define review sources (databases, registers, other) from Zotero collections; automatic total/unique/deduplication tracking.
- **Screening**: PRISMA flow diagram with title/abstract → full-text → final stages. Screen papers as included/excluded/maybe with reasons.
- **Data Extraction**: AI-powered structured data extraction with customizable templates, outcomes, effect measures (OR/RR/HR/MD/SMD plus diagnostic, discrimination, calibration, reclassification, and proportion measures), CI ranges, and timepoints. Supports verification workflow (proposed → verified → rejected).
- **Evidence Synthesis**: Forest-plot generation, effect-size extraction, heterogeneity assessment, random-effects meta-analysis, I² statistics. Supports common-effect and random-effects models with narrative fallback.
- **Gap Analysis**: AI-generated research gap identification with severity scoring.
- **Analysis Jobs**: Async extraction/analysis with progress tracking, cancellation, retry for failures.
- **Extraction Health**: Quality monitoring — captures warnings like missing effect sizes, missing CIs, missing timepoints, negative variances, extreme effect sizes, low sample sizes, and potential duplicate extractions.
- **Quote Grounding**: Validates supporting quotes against source text with exact and fuzzy matching (`grounding.ts`).
- **Extraction Compatibility**: Groups verified extraction rows into poolable vs. narrative-ready domains and detects duplicate rows per paper (`compatibility.ts`).

State persisted to `{Zotero.DataDirectory.dir}/seerai/systematicReview.json`.

### Workspace Module

Located in `src/modules/chat/workspace/`. Provides per-chat file workspace accessible via the Chat tab sidebar:

- **File Tree**: Hierarchical file browser with create/delete/rename — rendered in a resizable sidebar
- **Code Editor**: Monaco-inspired editor with syntax highlighting, Edit/Preview toggle, and file viewer (SVG/HTML/markdown/images)
- **Git Integration**: Native git CLI (`gitCli.ts`) for version control — init, stage, commit, diff, log
- **Diff Viewer**: Side-by-side diff for workspace files
- **DOCX Support**: DOCX to Markdown conversion via mammoth (`src/modules/docxConverter.ts`)
- **Agent Tools**: `workspace_read_file`, `workspace_write_file`, `workspace_edit_file`, `workspace_glob`, `workspace_grep`, `workspace_bash`, `workspace_diff`, `workspace_log`
- **Custom Path**: Configurable via `workspaceCustomPath` pref; defaults to `{DataDirectory}/seerai/workspaces/{chatId}/`

### Cloud Storage Module

Located in `src/modules/drive/` and `src/modules/cloud/`. Provides cloud storage integration:

- **Providers**: Google Drive, Dropbox, Box, OneDrive, Nextcloud
- **OAuth 2.0**: PKCE flow (`pkce.ts`) with local callback server (`oauthServer.ts`)
- **Cloud Tab**: File browser/uploader in the Cloud tab (`cloudTab.ts`)
- **Chat Context**: Cloud file attachment in chat messages (`cloudContext.ts`)

### API / MCP Integration

- `src/modules/api/endpoints.ts` registers HTTP endpoints at `/seerai/*` via `Zotero.Server`
- `src/modules/api/handlers.ts` routes requests to `toolExecutor`
- MCP server (`mcp-server/`) is a separate stdio-based process that calls these HTTP endpoints
- Default port: 23119
- The MCP server exposes ~46 tools (mirroring the plugin's tool set including workspace, RAG, systematic review, and skills tools)
- **Tool profiles**: set `SEERAI_MCP_TOOL_PROFILE=research` to return only research/Zotero tools (suppressing file/bash/terminal/workspace/task/skill tools). Used when a CLI harness already provides its own coding environment so the two tool sets don't overlap.

## Navigating assistant.ts (32K Lines)

`src/modules/assistant.ts` is the monolithic hub containing all UI rendering, event handling, and orchestration. It is the single largest file and requires careful navigation.

### Section Map (Approximate Line Ranges)

| Lines       | Content                                                                                                                                                                             |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1–170       | Imports + module-level state variables                                                                                                                                              |
| 186–472     | Agent session state and tool prompt building                                                                                                                                        |
| 473–900     | PDF Search State Tracker + related helpers                                                                                                                                          |
| 901–1060    | PDF discovery helpers (`findAndAttachPdfForItem`, `getSourceLinkForPaper`)                                                                                                          |
| 997–1100    | Filter presets, search history persistence, search column config persistence                                                                                                        |
| 1101–1208   | Search history helpers                                                                                                                                                              |
| 1209        | **`Assistant` class start** — OCR, PDF text, RAG content extraction                                                                                                                 |
| 1916        | **`Assistant.register()`** — Primary entry point, registers with Zotero ItemPaneManager                                                                                             |
| 1952–2520   | Rendering infrastructure (smartRender, renderToContainer, renderDetachedPlaceholder, context estimation, item helpers)                                                              |
| 2549–2725   | Chat lifecycle (loadHistory, createNewChat, loadChat, deleteChat)                                                                                                                   |
| 2778–3040   | `renderInterface()` — main UI container                                                                                                                                             |
| 3048–3177   | `createTabBar()` — Chat / Table / Review / Search / Cloud tabs                                                                                                                      |
| 3179–3969   | `createHistorySidebar()` — conversation history sidebar                                                                                                                             |
| 3971–4547   | Folder sections, context menus, resize handles                                                                                                                                      |
| 4727–5497   | `createChatTabContent()` — selection area, messages, prompt banner                                                                                                                  |
| 5499–6160   | Prompt banner, prompt editor, prompt config modals                                                                                                                                  |
| 6162–6760   | `createTableTabContent()` — papers table container                                                                                                                                  |
| 6237–6720   | `createTableSideStrip()` — column controls                                                                                                                                          |
| 6761–7566   | `createSearchTabContent()` — search UI, results, insights                                                                                                                           |
| 7568–8495   | `createSearchFilters()` — advanced filter panel                                                                                                                                     |
| 8497–8717   | Search filter checkboxes, `performSearch()`                                                                                                                                         |
| 8719–8934   | Search results rendering, duplicate filtering, pagination                                                                                                                           |
| 8936–9110   | AI insights generation + caching                                                                                                                                                    |
| 9182–9257   | Follow-up questions UI                                                                                                                                                              |
| 9378–9704   | Citations, smart copy, AI insight settings popovers                                                                                                                                 |
| 10076–10138 | Unpaywall batch checking                                                                                                                                                            |
| 10140–11648 | Search result cards rendering (includes addPaperToZotero, exportResultsAsBibtex)                                                                                                    |
| 11650–12091 | `addPaperToZoteroWithPdfDiscovery()`, PDF attachment discovery, BibTeX export                                                                                                       |
| 12093–13190 | **Table Tab** — toolbar, filters, row pickers                                                                                                                                       |
| 13191–15165 | Table generation pipeline (generateAllEmptyColumns, regenerateSelectedColumns, extractPDFs, generateDataForTable)                                                                   |
| 15167       | **`generateDataForTable()`** — main entry for table cell content generation                                                                                                         |
| 15168–16736 | Cell generation, PDF extraction, tag generation, cell detail modals                                                                                                                 |
| 16789–17516 | Workspace management (saveWorkspaceToHistory, workspace picker, startFreshWorkspace)                                                                                                |
| 17589–17653 | Table empty states                                                                                                                                                                  |
| 17654–19072 | Table data display, inline editing, pagination, refresh debounce                                                                                                                    |
| 19073–19448 | Table refresh, pagination, data loading                                                                                                                                             |
| 19450–20093 | Column manager modal                                                                                                                                                                |
| 20095–20496 | Quick add column dropdown, immediate column add                                                                                                                                     |
| 20498–20918 | Table column edit popovers                                                                                                                                                          |
| 20920–21522 | Unified search result rows, search column rendering                                                                                                                                 |
| 21524–21771 | Search column editor, immediate search column add                                                                                                                                   |
| 21773–22858 | Search column generation, settings popovers                                                                                                                                         |
| 22860–23062 | Search column dropdown, tags bar                                                                                                                                                    |
| 23063–23156 | Search column content generation                                                                                                                                                    |
| 23157–23554 | CSV export, workspace export, Markdown/CSV generation, tables note persistence                                                                                                      |
| 23596–23675 | Save rows as notes                                                                                                                                                                  |
| 23676–23718 | Save all rows as notes                                                                                                                                                              |
| 23719–24548 | Selection area, tag picker, paper picker, add by tags                                                                                                                               |
| 24549–24844 | Library selection, collections, chip creation                                                                                                                                       |
| 24846–25136 | Model selector, chat settings popover, scope dropdown                                                                                                                               |
| 25137–25303 | Toggle rows, scope/selection helpers                                                                                                                                                |
| 25305–25473 | Scope dropdown                                                                                                                                                                      |
| 25475–28435 | `createInputArea()` — chat input with attachments, placeholders                                                                                                                     |
| 28436–28590 | Inline permission request handler                                                                                                                                                   |
| 28592–30770 | `handleSendWithStreamingAndImages()` — main chat send logic                                                                                                                         |
| 30771–30930 | RAG indicator, message rendering                                                                                                                                                    |
| 30932–31220 | `appendMessage()` — message rendering with tool results                                                                                                                             |
| 31222–31719 | Action buttons, edit, regenerate, save as note, rerender                                                                                                                            |
| 31720–31783 | **Table API methods** — isItemInCurrentTable, addItemsToCurrentTable, removeItemsFromCurrentTable                                                                                   |
| 31834–31933 | **Systematic Review API methods** — syncSystematicReviewCache, setSystematicReviewStoreCheck, isItemInSystematicReview, addItemsToSystematicReview, removeItemsFromSystematicReview |

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
| `Assistant.register()`               | 1916  | `hooks.ts`       | Registers the Assistant panel with Zotero's ItemPaneManager |
| `Assistant.renderToContainer()`      | 2052  | `hooks.ts`       | Renders the assistant UI in detached window                 |
| `resolveContextItemToIds()`          | 2474  | `chat/` modules  | Resolves context selections to item IDs                     |
| `refreshAllCitations()`              | 9457  | `chat/` modules  | Updates citation formatting                                 |
| `addPaperToZoteroWithPdfDiscovery()` | 11650 | Search results   | Adds external papers to library with PDF discovery          |
| `generateDataForTable()`             | 15167 | Table generation | Main entry for table cell content generation                |
| `isItemInCurrentTable()`             | 31720 | `hooks.ts`       | Context menu check: is item in current table?               |
| `addItemsToCurrentTable()`           | 31727 | `hooks.ts`       | Context menu action: add selected items to table            |
| `removeItemsFromCurrentTable()`      | 31785 | `hooks.ts`       | Context menu action: remove items from table                |
| `syncSystematicReviewCache()`        | 31834 | `hooks.ts`       | Sync systematic review paper ID cache                       |
| `setSystematicReviewStoreCheck()`    | 31838 | `hooks.ts`       | Set fallback SR check function                              |
| `isItemInSystematicReview()`         | 31842 | `hooks.ts`       | Context menu check: is item in any SR project?              |
| `addItemsToSystematicReview()`       | 31849 | `hooks.ts`       | Context menu action: add items to SR project                |
| `removeItemsFromSystematicReview()`  | 31896 | `hooks.ts`       | Context menu action: remove items from SR project           |

## MCP Server

The MCP server is a **separate package** in `mcp-server/` that allows external LLMs (Claude Desktop, etc.) to interact with Zotero via the plugin's HTTP API.

### Key Files

- `mcp-server/src/index.ts` — Server setup, stdio transport, tool call routing
- `mcp-server/src/tools.ts` — Zod v3 schemas mirroring plugin's tool definitions (~46 tools)
- `mcp-server/src/zoteroClient.ts` — HTTP client to `http://127.0.0.1:23119/seerai/*`

### Build

```bash
cd mcp-server && npm run bundle   # → dist/seerai-mcp.cjs (single CJS file, target: node18)
cd mcp-server && npm run build    # → TypeScript compile (tsc)
cd mcp-server && npm run start    # → Run compiled MCP server
cd mcp-server && npm run dev      # → Run MCP server with tsx (dev mode)
```

The main `npm run build` also runs the MCP bundle and copies the `.cjs` to the root and `.scaffold/build/`.

### Connection Flow

```
External LLM → MCP Server (stdio) → HTTP → Zotero Plugin API (/seerai/*) → toolExecutor → Zotero
```

### Differences from Plugin Tools

- MCP server uses **Zod v3** (plugin uses Zod v4) — different API surface
- MCP server validates with `toolDef.inputSchema.parse(args)` then calls HTTP
- Plugin validates with `safeValidateToolArgs()` from `schemas.ts` then executes directly
- **`workspace_bash` behavior differs**: In the plugin, it prompts the user to run the command manually. In the MCP server, it executes real shell commands via `node:child_process` in the workspace directory.

## Critical Warnings

1. **Runtime is NOT Node.js** — The plugin runs in Zotero's SpiderMonkey engine (Firefox 128). No Node.js APIs (`fs`, `path`, `http`, etc.). Use Zotero APIs and `Zotero.File`/`Zotero.HTTP` instead.
2. **assistant.ts is 32K lines** — Navigate with search, not scrolling. Prefer adding new modules over extending it.
3. **Preferences are JSON strings** — Complex data stored in `Zotero.Prefs` is `JSON.stringify`'d. Always parse/stringify when reading/writing. However, model and provider configs are now **file-based** (not prefs-based) — see "File-Based Persistence" above.
4. **Build target is firefox128** — ES features are limited to what Firefox 128 supports. No top-level await, no ES2022+ features beyond what SpiderMonkey 128 implements.
5. **The `.env` file is gitignored** — Contains API keys and secrets. Never commit it. The `.env.example` is tracked.
6. **Build artifacts are gitignored** — `doc/`, `seerai.xpi`, `seerai-mcp.cjs`, `.scaffold/`, `.agent/` are not tracked. However, `seerai.xpi` and `seerai-mcp.cjs` may exist in the working tree.
7. **Tool schemas must stay in sync** — Plugin tool definitions (`toolDefinitions.ts`, `schemas.ts`) and MCP server tool definitions (`mcp-server/src/tools.ts`) must match. If you change one, update the other.
8. **`__env__` is injected at build time** — It's defined in `zotero-plugin.config.ts` esbuild options, not a runtime variable.
9. **`isomorphic-git` alias is dead code** — `zotero-plugin.config.ts` aliases `isomorphic-git` but the workspace uses native git CLI via `gitCli.ts`. The alias should be removed when cleaning up.
10. **Legacy `modelConfigs` pref is cleared on startup** — `hooks.ts` clears the old pref and loads from file-based storage instead. Do not use `getPref("modelConfigs")` for model config data.
