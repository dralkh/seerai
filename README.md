# seerai

<p align="center">
  <img src="https://github.com/user-attachments/assets/70e618aa-5c92-45fc-bec0-bf253de09ad4" 
       alt="seerai logo"
       width="300"
       height="300">
</p>

<p align="center">
  <a href="https://www.zotero.org">
    <img src="https://img.shields.io/badge/Zotero-7.x-brightgreen" />
  </a>
  <a href="https://opensource.org/licenses/MIT">
    <img src="https://img.shields.io/badge/License-MIT-blue.svg" />
  </a>
  <a href="https://github.com/dralkh/seerai/releases">
    <img src="https://img.shields.io/badge/Version-1.4.0-blue" />
  </a>
</p>


<p align="center">
  <img src="https://github.com/user-attachments/assets/90f68a0d-fec0-41e7-a988-f557c18bd150" width="600" />
</p>

<p align="center">
  <img src="https://github.com/user-attachments/assets/b9e71c6b-d903-4a69-8461-c7314e52dcf5" width="600" />
</p>

<p align="center">
  <img src="https://github.com/user-attachments/assets/fe543d48-eb68-47e4-b5f6-1d954e1597a2" width="600" />
</p>


**seerai** is an intelligent research assistant plugin for Zotero 7 that integrates AI-powered chat, advanced search, and data extraction capabilities directly into your research workflow. Chat with your papers, extract structured data, and accelerate your literature review with a local-first, privacy-focused design.

---


## Features

### AI-Powered Chat Interface
- **Contextual Conversations**: Chat with AI about your selected papers with full context awareness.
- **Smart Context Priority**: Automatically prioritizes content sources:
  1. **Zotero Notes** (OCR note, and other notes for highest priority)
  2. **Indexed PDF Text** (Fast, efficient, howver consumes alot of tokens, and would cause limit issues)
  3. **OCR** (Fallback for scanned documents with no indexed text)
- **Multi-paper Support**: Add multiple papers to a single conversation for comparative analysis.
- **Streaming Responses**: Real-time, token-by-token response rendering.
- **Markdown & Math**: Responses are formatted with syntax highlighting and LaTeX math support.
- **Vision Support**: Paste images directly into chat for multimodal analysis.
- **Interactive Follow-ups**: Deepen the conversation with streaming follow-up questions.
- **Configurable Citations**: Choose your preferred citation style for AI insights and chat.
- **Enhanced Keybindings**: 
  - `Enter`: Insert new line
  - `Shift+Enter`: Send message

### Semantic Search & Discovery
- **Web Search**: Integrated Firecrawl support for finding full-text content.
- **Semantic Scholar Agent**: Advanced paper search with:
  - **Advanced Filters**: Fine-tune results by Year, Venue, and Citation Count.
  - **AI Insights Config**: Configure insight generation directly from the search panel.
- **Smart Import**:
  - **PDF Discovery**: Automatically finds and attaches PDFs during import.
  - **Source Link**: Fallback to source links if PDFs are unavailable.
  - **Status Indicators**: Clear feedback on import status (⬇️ Importing, ✅ Imported, ⚠️ Failed).

### Agentic Chat & Tool Use
- **Autonomous Agents**: AI can now use tools to interact with your Zotero library and the web.
- **Rich Tool Suite**:
  - **Search Tool**: Search through your library with advanced filters.
  - **Collection Tool**: Manage collections and move items.
  - **Note Tool**: Read, create, and modify item notes.
  - **Read Tool**: Extract text from PDFs and items for deep analysis.
  - **Citation Tool**: Generate citations and bibliographies.
  - **Table Tool**: Interact with and generate data for your Paper Tables.
  - **Web Tool**: Search the web and fetch content using Firecrawl.
- **Model-as-a-Tool**: Seamless integration with LLM tool-calling capabilities.

### Papers Tables
- **Structured Extraction**: Extract specific data points from multiple papers into a comparative table.
- **AI-Powered Columns**: Define custom columns with AI prompts (e.g., "Methodology", "Sample Size").
- **Inline Editing**: innovative inline editor for column titles and prompts.
- **One-Click Generation**: Generate data for individual cells or entire columns instantly.
- **Side Strip Actions**: Unified controls for adding, removing columns, generating triggers, and settings.

### OCR & Text Extraction
- **Flexible OCR Options**:
  - **Mistral OCR**: High-quality cloud OCR (Recommended).
  - **DataLab.to**: Reliable cloud-based extraction.
  - **Local Marker**: Run your own local OCR server for free, private processing.
- **Auto-Processing**: Automatically processes unindexed PDFs when needed.

### Customizable AI
- **Model Presets**: Pre-configured settings for popular providers:
  - OpenAI (GPT-5, o3)
  - Anthropic (Claude Sonnet 4.5)
  - Google (Gemini 3 Pro)
  - DeepSeek, Mistral, Groq, OpenRouter
  - Local Models (Openai compatible endpoint, [Ollama](https://ollama.com), LM Studio)
    - 12-16g Vram - Qwen3-4B-Thinking-2507
    - 24-32g Vram - gpt-oss-20b
    - 48-64g Vram - QwQ-32B
    - 96-128g Vram - Qwen3-Next-80B-A3B-Instruct
- **Per-Conversation Models**: Switch models dynamically based on the task complexity.

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

### 4. MCP Server & API
Seer-AI now includes a Model Context Protocol (MCP) server and a local API for external integrations.
- **MCP Server**: Located in [`mcp-server/`](mcp-server/README.md). Allows external LLMs (like Claude Desktop) to interact with your Zotero library. See the [MCP Setup Guide](mcp-server/README.md) for configuration instructions.
- **Local API**: Provides endpoints for chat, tool execution, and library management.
  - **Settings → seerai → API**.
  - Default Port: `23119`

This mode requires highly sophistecated models with good tool function capabilities to function properly.

---

## Usage Guide

### Chatting with Papers
1. Select a paper (or multiple) in your library.
2. Open the **SeerAI** sidebar tab.
3. (Optional) Customize context inclusions via the settings icon (Abstracts, Notes).
4. Type your question or use templates from the **Prompt Library** (Book icon).

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

---


## Future Implementations Ideas

Propose several advanced features to enhance seerai's capabilities. These are currently in the just idea board.

### 1. Advanced Search Capabilities
Enhanced search functionality to help users find relevant literature more effectively.
- **Autocomplete**: Intelligent suggestions for tags, creators, and collections as you type.
- **Complex Queries**: Support for boolean logic (AND/OR) and nested search conditions (e.g., "Title contains X AND Year > 2020").
- **Field-Specific Search**: Dedicated filters for titles, authors, years, and tags.

### 2. Semantic Vector Search
- **Voice, Transcription, Embedding Integration**: Support for OpenAI-compatible embedding, voice, transcription models (e.g., `text-embedding-3-small`, local Ollama embeddings).
- **Contextual Retrieval**: Find papers based on conceptual similarity rather than just exact text matches.
- **In-Memory Vector Store** — Fast, local indexing of session-relevant papers for semantic analysis.
- **RAG** - used when 80% limit reached to context size

### 3. Data Verification & Quality Control
- **Verifier Button** — One-click verification to check all extracted data against source text.
- **Confidence Scores** — AI-generated confidence ratings for each extracted data point.
- **Source Highlighting** — Click a cell to see the exact passage in the paper where the data came from.

### 4. Firecrawl API Integration
- **URL Discovery** — Usage Firecrawl API for pdf discovery

### Others
Citations referencing within tables and chat on generation 
Internal custom support mcp json presets
Connectors
UI revamp

---


## Development

### Prerequisites
- Node.js 18+
- Zotero 7

### Project Structure
The codebase follows a modular architecture:

```
seerai/
├── addon/                 # Zotero integration files (XUL/XHTML)
├── src/
│   ├── modules/           # Core feature modules
│   │   ├── chat/          # Chat engine & state
│   │   ├── assistant.ts   # Main assistant logic
│   │   ├── firecrawl.ts   # Firecrawl integration
│   │   ├── ocr.ts         # OCR implementation
│   │   ├── openai.ts      # LLM client implementation
│   │   ├── semanticScholar.ts # Semantic Scholar integration
│   │   └── preferenceScript.ts # Preferences logic
│   ├── utils/             # Utility functions
│   └── hooks.ts           # Zotero event listeners
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
- [Mistral AI](https://mistral.ai)
- [Semantic Scholar](https://www.semanticscholar.org)
- [Firecrawl](https://firecrawl.io)
- [Marker](https://github.com/VikParuchuri/marker)
