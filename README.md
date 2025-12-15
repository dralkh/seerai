# seerai

<p align="center">
  <img src="https://github.com/user-attachments/assets/70e618aa-5c92-45fc-bec0-bf253de09ad4" 
       alt="seerai logo"
       width="300"
       height="300">
</p>

https://github.com/user-attachments/assets/b0847022-d1ab-4e98-8e3a-607d1073db8f

<img width="2787" height="1564" alt="image" src="https://github.com/user-attachments/assets/8d99a2a2-a5f0-43d4-9f20-2b7ab49548f7" />


<img width="1949" height="1514" alt="image" src="https://github.com/user-attachments/assets/b384fd8a-9e11-4c56-979a-533ca99900c0" />

[![Zotero 7 Compatible](https://img.shields.io/badge/Zotero-7.x-brightgreen)](https://www.zotero.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Version](https://img.shields.io/badge/Version-3.0.0-blue)](https://github.com/dralkh/seerai/releases)

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
- **Enhanced Keybindings**: 
  - `Enter`: Insert new line
  - `Shift+Enter`: Send message

### Semantic Search & Discovery
- **Deep Web Search**: Integrated Firecrawl support for finding full-text content.
- **Semantic Scholar Agent**: Advanced paper search with filtering (Year, Venue, Citation Count).
- **Smart Import**:
  - **PDF Discovery**: Automatically finds and attaches PDFs during import.
  - **Source Link**: Fallback to source links if PDFs are unavailable.
  - **Status Indicators**: Clear feedback on import status (⬇️ Importing, ✅ Imported, ⚠️ Failed).

### Papers Tables
- **Structured Extraction**: Extract specific data points from multiple papers into a comparative table.
- **AI-Powered Columns**: Define custom columns with AI prompts (e.g., "Methodology", "Sample Size").
- **Inline Editing**: innovative inline editor for column titles and prompts.
- **One-Click Generation**: Generate data for individual cells or entire columns instantly.
- **Side Strip Actions**: Unified controls for adding columns, generating triggers, and settings.

### OCR & Text Extraction
- **Flexible OCR Options**:
  - **Mistral OCR**: High-quality cloud OCR (Recommended).
  - **DataLab.to**: Reliable cloud-based extraction.
  - **Local Marker**: Run your own local OCR server for free, private processing.
- **Auto-Processing**: Automatically processes unindexed PDFs when needed.

### Customizable AI
- **Model Presets**: Pre-configured settings for popular providers:
  - OpenAI (GPT-4o, o1)
  - Anthropic (Claude Sonnet 3.5)
  - Google (Gemini Pro)
  - DeepSeek, Mistral, Groq, OpenRouter
  - Local Models (Openai compatible endpoint, [Ollama](https://ollama.com), LM Studio)
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
Citations referencing within tables and chat on generation -
MCP
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
