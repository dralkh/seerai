# seerai — AI Research Assistant Plugin for Zotero

<p align="center">
  <img width="200" height="200" alt="logo" src="https://github.com/user-attachments/assets/26e6aa5b-4b70-464a-8198-6ec48544593d" />
  
</p>

<p align="center">
  <a href="https://www.zotero.org">
    <img src="https://img.shields.io/badge/Zotero-9.x-brightgreen" />
  </a>
  <a href="https://opensource.org/licenses/MIT">
    <img src="https://img.shields.io/badge/License-MIT-blue.svg" />
  </a>

</p>

<p align="center">
  <img src="https://github.com/user-attachments/assets/abeee9fa-bea0-4cf5-8e5c-a56cee745a74" width="600" />
</p>

<p align="center">
  <img src="https://github.com/user-attachments/assets/4ce55ee8-39c5-48ab-96e9-b1c818523b18" width="600" />
</p>

<p align="center">
  <img src="https://github.com/user-attachments/assets/d9525add-3501-4b50-9f8c-b0e482c9c1f6" width="600" />
</p>

<p align="center">
  <img src="https://github.com/user-attachments/assets/b9e71c6b-d903-4a69-8461-c7314e52dcf5" width="600" />
</p>

<p align="center">
  <img src="https://github.com/user-attachments/assets/fe543d48-eb68-47e4-b5f6-1d954e1597a2" width="600" />
</p>

<p align="center">
  <a href="https://github.com/dralkh/seerai/releases/latest/download/seerai.xpi">
    <img src="https://img.shields.io/badge/Install-Download%20.xpi-brightgreen?style=for-the-badge&logo=zotero" alt="Download seerai.xpi" />
  </a>
</p>

**seerai** is an intelligent research assistant plugin for Zotero 9 that integrates AI-powered chat, advanced search, structured data extraction, and systematic review workflows directly into your research workflow. Chat with your papers, extract structured data, run PRISMA-style reviews, and accelerate your literature review with a local-first, privacy-focused design.

---

## Installation

### From GitHub (Recommended)

1. Download the latest release (`.xpi` file) from [Releases](https://github.com/dralkh/seerai/releases).
2. In Zotero, go to **Tools → Add-ons**.
3. Click the gear icon ⚙️ and select **Install Add-on From File...**.
4. Select the downloaded `.xpi` file.
5. Restart Zotero.

### From Source

```bash
# Clone the repository
git clone https://github.com/dralkh/seerai.git
cd seerai

# Install dependencies
npm install

# Build the plugin
npm run build

# The .xpi file will be generated in the root directory
```

---

## Features

### AI-Powered Chat Interface

- **Contextual Conversations**: Chat with AI about your selected papers with full context awareness.
- **Smart Context Priority**: Automatically prioritizes content sources:
  1. **Zotero Notes** (OCR note, and other notes for highest priority)
  2. **Indexed PDF Text** (Fast, efficient, however consumes a lot of tokens and may cause limit issues)
  3. **OCR** (Fallback for scanned documents with no indexed text)
- **Multi-paper Support**: Add multiple papers to a single conversation for comparative analysis.
- **Streaming Responses**: Real-time, token-by-token response rendering.
- **Markdown & Math**: Responses are formatted with syntax highlighting and LaTeX math support.
- **Vision Support**: Paste images directly into chat for multimodal analysis.
- **Multimodal Generation**: Generate images, videos, speech-to-text, and text-to-speech directly from chat.
- **Attachments Upload**: Add files to conversations via the context menu.
- **Interactive Follow-ups**: Deepen the conversation with streaming follow-up questions.
- **Configurable Citations**: Choose your preferred citation style for AI insights and chat.
- **Smart Copy**: Select and copy text with preserved formatting (Markdown) directly from chat bubbles.
- **Enhanced Keybindings**:
  - `Enter`: Insert new line
  - `Shift+Enter`: Send message
  - `Ctrl+Shift+S`: Toggle/Focus detachable window
- **Detachable Window**: Pop out the SeerAI interface into a standalone resizable floating window to maintain chat access while navigating your library.
- **Themed UI**: Enhanced dialogs and components with full theme support for a consistent look across Zotero's Light and Dark modes.
- **Responsive Layout**: Chat, tables, and search tabs dynamically adapt to panel width changes.

### Semantic Search & Discovery

- **RAG (Retrieval-Augmented Generation)**: Per-context embeddings with chunking, vector store, and semantic retrieval for large documents.
- **Web Search**: Integrated Firecrawl, Tavily, and You.com support for finding high-quality full-text content.
- **Federated Scholarly Search**: Search across 11 providers at once — Semantic Scholar, arXiv, PubMed, bioRxiv, medRxiv, IACR, Europe PMC, CORE, BASE, Zenodo, and HAL — with cross-source deduplication and rank fusion.
  - **Smart Modes**: One-click presets (Broad, Biomedical, Preprints, Cryptography, Repositories) target the right provider sets, or pick sources manually.
  - **AI Query Refinement**: An AI step extracts your concepts and synonyms once, then compiles them into each provider's native query syntax — so you get precise results without learning 11 query dialects.
  - **Advanced Filters**: Fine-tune results by Year, Venue, and Citation Count.
  - **AI Insights Config**: Configure insight generation directly from the search panel.
  - **Export**: Export results to BibTeX or CSV.
- **Smart Import**:
  - **PDF Discovery**: Automatically finds and attaches PDFs during import.
  - **Source Link**: Fallback to source links if PDFs are unavailable.
  - **Status Indicators**: Clear feedback on import status (⬇️ Importing, ✅ Imported, ⚠️ Failed).
- **Global Search Scope**: Searching now extends across all libraries, including personal and group collections.
- **Advanced Boolean Search**: Robust support for nested logic (AND/OR/NOT), implicit phrasing, and markdown-aware matching.
- **Smart Regex matching**: Improved search precision with intelligent handling of word boundaries and special characters.

### Agentic Chat & Tool Use

- **Autonomous Agents**: AI can use tools to interact with your Zotero library, the web, and your workspace.
- **Research Mode**: You.com research mode for multi-source answer synthesis.
- **Rich Tool Suite**:
  - **Search Tool**: Search through your library with advanced filters.
  - **Collection Tool**: Manage collections and move items.
  - **Note Tools**: Read, create, and **edit existing** item notes for seamless research updates.
  - **Tag Tool**: Automatically generate and apply relevant tags to your research.
  - **Read Tool**: Extract text from PDFs and items for deep analysis.
  - **Citation Tool**: Generate citations and bibliographies.
  - **Table Tool**: Interact with and generate data for your Paper Tables.
  - **Web Tool**: Search the web and fetch content using Firecrawl, Tavily, or You.com.
  - **Workspace Tools**: Create, read, edit, and delete files directly in your workspace.
  - **Todo Tool**: Create and manage task lists for complex multi-step research workflows.
  - **Skills Tool**: Discover and load on-demand instructions from a bundled library of ~148 agent skills.
  - **Systematic Review Tool**: Create and update review protocols, sources, and screening decisions from chat.
- **Agent Skills Library**: A curated library of self-contained skill packages (scientific computing, bioinformatics, document generation, search, and more) that the agent loads only when relevant — sourced from [K-Dense-AI/scientific-agent-skills](https://github.com/K-Dense-AI/scientific-agent-skills). Add your own bundled, workspace, or custom skills.
- **Tool Activity Notices**: Inline status indicators show when the agent is invoking tools, running workspace commands, or waiting on external results.
- **Task Completion Signaling**: Agents signal completion explicitly for clean multi-step workflows.
- **Advanced Orchestration**: Improved tool calling logic with tool filtering, iteration tracking, and observability tracing.
- **Model-as-a-Tool**: Seamless integration with LLM tool-calling capabilities.

### Papers Tables

- **Structured Extraction**: Extract specific data points from multiple papers into a comparative table.
- **AI-Powered Columns**: Define custom columns with AI prompts (e.g., "Methodology", "Sample Size").
- **Inline Editing**: innovative inline editor for column titles and prompts.
- **One-Click Generation**: Generate data for individual cells or entire columns instantly.
- **Bulk Actions**: Regenerate content or add selected papers to collections in bulk.
- **Side Strip Actions**: Unified controls for adding, removing columns, generating triggers, and settings.

### Systematic Review

End-to-end systematic review workflow built directly into Zotero:

- **Protocol Builder**: Define your research question and choose a structured framework — PICO, PICOS, PICOT, PICOTS, PICOTT, PECO, PICo, PEO, SPIDER, SPICE, or PCC.
- **Eligibility Criteria**: AI-assisted inclusion/exclusion rules with keyword aids, rationale, and a full revision history.
- **Search Strategy**: Compile a review-wide strategy into native queries for each scholarly source, or refine it with AI and push it straight into the search input.
- **Sources**: Import papers from Zotero collections as review sources; track per-source counts, overlap, and deduplication.
- **PRISMA Flow Diagram**: Visualize title/abstract → full-text → final screening flow with live counts.
- **Screening**: Title/abstract and full-text screening with include/exclude/maybe decisions, reasons, confidence scores, and AI recommendations.
- **Data Extraction**: AI-powered structured extraction with customizable templates, outcomes, effect measures (OR, RR, HR, MD, SMD), confidence intervals, timepoints, and a proposed → verified → rejected workflow.
- **Evidence Synthesis**: Random-effects and common-effect meta-analysis, forest plots, I² heterogeneity, and pooled effect sizes.
- **Gap Analysis**: AI-generated research gap identification with severity scoring.
- **Extraction Health Checks**: Automatic warnings for missing effect sizes, missing CIs, missing timepoints, negative variances, extreme effect sizes, low sample sizes, and potential duplicate extractions.
- **Async Jobs**: Run extraction and analysis jobs in the background with progress tracking and cancellation.

### Workspace & File Management

- **Built-in File Workspace**: A persistent file system workspace accessible to you and your AI agent.
- **File Tree Navigation**: Sidebar with full file tree for browsing, creating, and organizing files and folders.
- **Code Editor**: Built-in Monaco-inspired editor with syntax highlighting, line numbers, and auto-save.
- **Git Integration**: Initialize repos, stage changes, commit, and view diffs directly within the workspace.
- **Diff Viewer**: Side-by-side or unified diff view for reviewing file changes.
- **File Viewer**: Render workspace files with syntax highlighting across multiple formats.
- **DOCX Converter**: Convert documents to/from DOCX format for interoperability with word processors.
- **Custom Workspace Paths**: Configure a custom directory for your workspace files.

### Cloud Storage Integration

- **Multi-Provider Support**: Connect to Google Drive, Dropbox, Box, OneDrive, or Nextcloud.
- **OAuth 2.0 + PKCE**: Secure authentication flow for all cloud providers.
- **Cloud Drive Tab**: Browse, search, and manage cloud files directly within Zotero.
- **Cloud Context**: Include cloud-stored files as context in your AI conversations.
- **File Sync**: Upload and download files between workspace and cloud storage seamlessly.

### OCR & Text Extraction

- **Flexible OCR Options**:
  - **Mistral OCR**: High-quality cloud OCR (Recommended).
  - **DataLab.to**: Reliable cloud-based extraction.
  - **Local Marker**: Run your own local OCR server for free, private processing.
- **Auto-Processing**: Automatically processes unindexed PDFs when needed.

### Customizable AI

- **Persistent API Keys**: API keys are saved and persisted across all configured providers.
- **Model Presets**: Pre-configured settings for popular providers:
  - OpenAI, Anthropic, Google, xAI
  - DeepSeek, Mistral, Groq, Together, Fireworks, Cohere, OpenRouter
  - Local Models (Openai compatible endpoint)
    - 4-8g Vram - Qwen3.5 2B / Qwen3.5 4B
    - 12-16g Vram - Qwen3.5 9B / Gemma 4 12B
    - 24-32g Vram - Qwen3.6 27B / Qwen3.6 35B A3B / Gemma 4 31B / Gemma 4 26B A4B
    - 48-96g Vram - Qwen3.5 122B A10B / Mistral Medium 3.5 / NVIDIA Nemotron 3 Super /
    - 128g Vram - MiniMax-M3 / MiMo-V2.5-Pro / GLM-5.2 / Kimi K2.6 / DeepSeek V4 Pro / Nemotron 3 Ultra / Qwen3.5 397B A17B / DeepSeek-V4-Flash

- **Local CLI Agents**: Route chat through a CLI you already have installed and logged in — **Codex**, **Claude Code**, **Antigravity**, or **GitHub Copilot**. seerai stores no credentials; it reuses the CLI's own session.
- **CLI MCP Harness**: Local CLI agents can optionally connect to the bundled seerai MCP server so they can read and act on your Zotero library while you chat.
- **Capability-Based Routing**: Assign separate models per capability — chat, embeddings, image, video, text-to-speech, and speech-to-text — and route each request to the right endpoint automatically.
- **Smart Rate Limiting**: Per-model configuration for concurrency, RPM, and TPM to prevent provider errors.
- **Per-Conversation Models**: Switch models dynamically based on the task complexity.

---

## Configuration

Go to **Zotero → Settings → seerai** to configure your AI providers and services.

### 1. AI Models

Use the **Add Configuration** button to set up your AI models.

- **Presets**: Select from built-in presets (OpenAI, Anthropic, Ollama, etc.) for quick setup.
- **Custom**: Manually configure API URL, Key, and Model ID for any OpenAI-compatible provider.
- **Default**: Set a preferred model as your default for new conversations.

### 2. OCR Services

Choose your preferred text extraction engine:

- **Mistral OCR**: Requires [Mistral API Key](https://console.mistral.ai/). Best for accuracy.
- **Cloud (DataLab.to)**: Requires DataLab API Key.
- **Local Marker Server**: Requires running a local Python server.
  - URL: `http://localhost:8001` (Default)
  - See [Marker Project](https://github.com/VikParuchuri/marker) for setup.

### 3. Search Integrations

- **Semantic Scholar**: Add your [API Key](https://www.semanticscholar.org/product/api) for higher rate limits and faster searches.
- **Firecrawl**: Add [API Key](https://firecrawl.dev) to enable deep web search capabilities - local instance with ([GitHub](https://github.com/firecrawl/firecrawl)).
- **Tavily**: Add [API Key](https://tavily.com/) for optimized search results tailored for AI agents.
- **You.com**: Add [API Key](https://api.you.com) for web search and research mode.

### 4. Workspace

- **Local Path**: Configure a custom directory path for your workspace files (Settings → seerai → Workspace).
- **Git Integration**: Enable Git version control for automatic versioning and collaboration.
- Files created in the workspace are accessible to your AI agent via workspace tools.

### 5. Cloud Storage

- **Supported Providers**: Google Drive, Dropbox, Box, OneDrive, Nextcloud.
- **Authentication**: Secure OAuth 2.0 with PKCE flow — no passwords stored.
- Connect via the **Cloud tab** in the workspace sidebar to browse, sync, and use cloud files as AI context.

### 6. MCP Server & API

Seer-AI now includes a Model Context Protocol (MCP) server and a local API for external integrations.

- **MCP Server**: Located in [`mcp-server/`](mcp-server/README.md). Allows external LLMs (like Claude Desktop) to interact with your Zotero library. See the [MCP Setup Guide](mcp-server/README.md) for configuration instructions.
- **Local API**: Provides endpoints for chat, tool execution, and library management.
  - **Settings → seerai → API**.
  - Default Port: `23119`

This mode requires sophisticated models with strong tool/function-calling capabilities to function properly.

---

## Usage Guide

### Chatting with Papers

1. Select a paper (or multiple) in your library.
2. Open the **SeerAI** sidebar tab.
3. (Optional) Customize context inclusions via the settings icon (Abstracts, Notes).
4. Type your question or use templates from the **Prompt Library** (Book icon).

### Detachable Window

- **Pop-out**: Click the `⇱` button in the SeerAI tab bar to open a floating window.
- **Hotkey**: Press `Ctrl+Shift+S` to instantly detach, toggle, or focus the window.
- **Auto-Sync**: The detached window automatically updates its context when you select different items in Zotero.
- **Attach**: Close the floating window or click the dock button (within the sidebar placeholder) to return to the sidebar.

### Creating Data Tables

1. Open the **Tables** tab in the main view.
2. Click `+` on the side strip to add a new column.
3. Define the column header and AI prompt (e.g., "What is the sample size?").
4. Drag and drop papers into the table.
5. Click **Generate** on cells to extract data.

### Prompt Library

- Access via the **Book Icon** 📖 in chat.
- Use built-in templates (Summarize, Critique, Compare).
- Create custom templates with placeholders:
  - `!`: Saved Prompts
  - `/`: Papers
  - `^`: Folders
  - `~`: Tags
  - `@`: Authors
  - `#`: Topics

### Using the Workspace

1. Open the workspace sidebar using the folder icon in the chat panel.
2. Create files and folders with the `+` button or via AI agent commands.
3. Edit files using the built-in code editor with syntax highlighting.
4. Enable Git integration in Settings → seerai → Workspace for version control.
5. Connect cloud storage (Google Drive, Dropbox, etc.) via the Cloud tab.
6. The AI agent can read, write, and modify workspace files as part of its tool suite.

---

## Future Implementations Ideas

- **Online Group Sync & Shared Workspaces**: Keep chat, tables, search, review, and cloud state in sync across detached windows and sidebar instances in real time, with team-wide syncing for specific Zotero groups or invited collaborators to create shared workspaces built on top of Zotero items.
- **PDF Text References & Highlights**: Reference specific passages from chat or extraction results and open the corresponding location directly in Zotero's built-in PDF viewer, with support for persistent highlights and annotations.
- **Autocomplete**: Intelligent suggestions for tags, creators, and collections as you type.
- **Complex Queries**: Support for boolean logic (AND/OR) and nested search conditions (e.g., "Title contains X AND Year > 2020").
- **Field-Specific Search**: Dedicated filters for titles, authors, years, and tags.
- **Citation References**: Inline citations within tables and chat during generation.
- **Internal MCP Presets**: Custom support for MCP JSON presets for streamlined integrations.

---

## Development

### Prerequisites

- Node.js 18+
- Zotero 9

### Project Structure

The codebase follows a modular architecture:

```
seerai/
├── addon/                 # Zotero integration files (XUL/XHTML)
├── src/
│   ├── modules/           # Core feature modules
│   │   ├── chat/          # Chat engine & state
│   │   │   ├── rag/       # RAG pipeline (chunker, embeddings, retrieval, vector store)
│   │   │   ├── tools/     # Agentic tool system (search, note, table, web, workspace, skills, etc.)
│   │   │   ├── cli/       # Local CLI providers (Codex, Claude, Antigravity, Copilot)
│   │   │   ├── skills/    # Agent skills registry
│   │   │   └── workspace/ # File workspace (editor, sidebar, git CLI, diff viewer, store)
│   │   ├── search/        # Federated scholarly search (11 providers, query IR + compilers)
│   │   ├── systematicReview/ # PRISMA systematic review workflow
│   │   ├── cloud/         # Cloud storage tab
│   │   ├── drive/         # Cloud providers (Google, Dropbox, Box, OneDrive, Nextcloud)
│   │   ├── assistant.ts   # Main assistant logic
│   │   ├── firecrawl.ts   # Firecrawl integration
│   │   ├── tavily.ts      # Tavily search integration
│   │   ├── youdotcom.ts   # You.com search & research integration
│   │   ├── ocr.ts         # OCR implementation
│   │   ├── openai.ts      # LLM & multimodal client
│   │   ├── semanticScholar.ts # Semantic Scholar integration
│   │   ├── fileViewer.ts  # File rendering & viewing
│   │   ├── docxConverter.ts # Document format conversion
│   │   ├── webSearchProvider.ts # Provider abstraction (Firecrawl/Tavily/You.com)
│   │   └── preferenceScript.ts # Preferences logic
│   ├── utils/             # Utility functions
│   └── hooks.ts           # Zotero event listeners
├── skills/                # ~148 bundled agent skill packages
└── package.json
```

### Commands

```bash
npm start       # Start dev server with hot reload
npm run build   # Build for production
npm run lint:fix # Fix code style issues
```

---

## Contributing

Contributions are welcome!

1. Fork the repo.
2. Create a feature branch (`git checkout -b feature/MyFeature`).
3. Commit changes (`git commit -m 'Add MyFeature'`).
4. Push to branch (`git push origin feature/MyFeature`).
5. Open a Pull Request.

---

## License

MIT License - see [LICENSE](LICENSE) for details.

## Acknowledgments

- [Zotero](https://www.zotero.org)
- [K-Dense-AI](https://github.com/K-Dense-AI/scientific-agent-skills)
- [Mistral AI](https://mistral.ai)
- [Semantic Scholar](https://www.semanticscholar.org)
- [Firecrawl](https://firecrawl.io)
- [Marker](https://github.com/VikParuchuri/marker)
