# Seer AI

[![Zotero 7 Compatible](https://img.shields.io/badge/Zotero-7.x-brightgreen)](https://www.zotero.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)

**Seer AI** is an intelligent research assistant plugin for Zotero 7 that integrates AI-powered chat capabilities directly into your research workflow. Chat with your papers, get insights, and accelerate your review process.

---

## Features

### AI-Powered Chat Interface
- **Contextual conversations** — Chat with AI about your selected papers with full context awareness
- **Multi-paper support** — Add multiple papers to a single conversation for comparative analysis
- **Streaming responses** — Real-time, token-by-token response rendering
- **Markdown support** — Responses are beautifully formatted with syntax highlighting for code blocks
- **Vision support** — Paste images directly into chat for multimodal AI analysis

### Smart Paper Selection
- **Add by Tags** — Quickly add papers by selecting tags with collection filtering
- **Add from Library** — Browse and select papers from any library or collection
- **Add from Selection** — Add currently selected papers from Zotero's main view
- **Include Notes** — Optionally include paper notes in the conversation context
- **Include Abstracts** — Automatically include paper abstracts for richer context

### Flexible AI Configuration
- **Multiple AI Models** — Configure and switch between different AI providers (OpenAI, Anthropic, local models, etc.)
- **Custom API Endpoints** — Use any OpenAI-compatible API endpoint
- **Per-conversation model selection** — Choose the best model for each task

### DataLab OCR Integration
- **PDF Text Extraction** — Convert PDFs to searchable markdown notes using DataLab's OCR API
- **Batch Processing** — Process multiple PDFs concurrently
- **Automatic Note Creation** — Extracted text is saved as Zotero notes linked to your papers

### Conversation Management
- **Persistent History** — Conversations are preserved across sessions
- **Edit Messages** — Modify previous messages and regenerate responses
- **Retry Responses** — Regenerate AI responses with a single click
- **Copy to Clipboard** — Easily copy AI responses for use elsewhere
- **Save as Note** — Export conversations as Zotero notes

---

## Installation

### From GitHub (Recommended)

1. Download the [`seer-ai.xpi`](https://github.com/dralkh/Seer-AI/raw/main/seer-ai.xpi) file or from [Releases](https://github.com/dralkh/Seer-AI/releases)
2. In Zotero, go to **Tools → Add-ons**
3. Click the gear icon and select **Install Add-on From File...**
4. Select the downloaded `.xpi` file
5. Restart Zotero

### From Source

```bash
# Clone the repository
git clone https://github.com/dralkh/Seer-AI.git
cd Seer-AI

# Install dependencies
npm install

# Build the plugin
npm run build

# The .xpi file will be in the project root
```

---

## Configuration

### Setting Up AI Models

1. Go to **Zotero → Settings → Seer AI**
2. Click **Add Configuration** to add your first AI model
3. Enter:
   - **Name**: A friendly name for this configuration
   - **API URL**: The endpoint URL (e.g., `https://api.openai.com/v1/`)
   - **API Key**: Your API key
   - **Model**: The model identifier (e.g., `gpt-5`, `claude-4-sonnet`)
4. Click **Set as Default** to make it your primary model

#### Supported Providers

| Provider | API URL | Example Models |
|----------|---------|----------------|
| OpenAI | `https://api.openai.com/v1/` | `gpt-5`, `gpt-5-mini`, `o1` |
| Anthropic (via proxy) | `https://api.anthropic.com/v1/` | `claude-4-sonnet`, `claude-4-opus` |
| OpenRouter | `https://openrouter.ai/api/v1/` | Various models |
| Local (Ollama) | `http://localhost:11434/v1/` | `qwen3`, `mistral`, etc. |

### DataLab OCR Setup (Recommended)

1. Get an API key from [datalab.to](https://datalab.to)
2. Go to **Zotero → Settings → Seer AI**
3. Enter your DataLab API Key
4. Set the max concurrent processes (default: 5)

---

## Usage

### Opening the Assistant

1. Select a paper in your Zotero library
2. The **Smart Assistant** panel will appear in the item details sidebar
3. Start chatting!

### Adding Papers to Context

- **Add by Tag**: Click the tag button to filter and select papers by tags
- **Add Papers**: Browse and search your entire library
- **Add from Selection**: Add whatever is currently selected in Zotero

### Chat Settings

Click the settings icon in the chat controls to access:
- **Include Notes**: Add paper notes to AI context
- **Include Abstracts**: Add paper abstracts to AI context

### Using DataLab OCR

1. Right-click on a PDF attachment in Zotero
2. Select **Extract Text with DataLab OCR**
3. The extracted text will be saved as a note and used by the ai chat

---

## Development

### Prerequisites

- Node.js 18+
- npm 9+
- Zotero 7

### Development Workflow

```bash
# Start development server with hot reload
npm start

# Build for production
npm run build

# Run linting
npm run lint:check

# Fix linting issues
npm run lint:fix
```

### Project Structure

```
seer-ai/
├── addon/                 # Zotero addon files
│   ├── content/          # XUL/XHTML files
│   ├── locale/           # Localization files
│   └── manifest.json     # Addon manifest
├── src/
│   ├── modules/
│   │   ├── assistant.ts  # Main chat interface
│   │   ├── openai.ts     # OpenAI API service
│   │   ├── datalab.ts    # DataLab OCR service
│   │   └── chat/         # Chat state management
│   └── hooks.ts          # Zotero event hooks
└── package.json
```

---

## Future Implementations Ideas

We are actively exploring several advanced features to enhance Seer AI's capabilities. These are currently in the planning or proof-of-concept phase:

### 1. Prompt Library
A built-in library of research-focused prompt templates to streamline common tasks.
- **Templates**: Pre-defined prompts for summarizing papers, comparing methodologies, identifying research gaps, and writing literature reviews from settings.
- **Smart Placeholders**: Dynamic inputs for topics (#), specific papers (/), authors (@), and collections (^) to contextualize prompts automatically.
- **Custom Prompts**: Ability for users to create, save, and manage their own reusable prompt templates.

### 2. Advanced Search Capabilities
Enhanced search functionality to help users find relevant literature more effectively.
- **Autocomplete**: Intelligent suggestions for tags, creators, and collections as you type.
- **Complex Queries**: Support for boolean logic (AND/OR) and nested search conditions (e.g., "Title contains X AND Year > 2020").
- **Field-Specific Search**: Dedicated filters for titles, authors, years, and tags.

### 3. Semantic Vector Search
Moving beyond keyword matching to understanding the meaning of your queries.
- **Voice, Transcription, Embedding Integration**: Support for OpenAI-compatible embedding, voice, transcription models (e.g., `text-embedding-3-small`, local Ollama embeddings).
- **Contextual Retrieval**: Find papers based on conceptual similarity rather than just exact text matches.
- **In-Memory Vector Store**: Fast, local indexing of session-relevant papers for semantic analysis.

---

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/AmazingFeature`)
3. Commit your changes (`git commit -m 'Add some AmazingFeature'`)
4. Push to the branch (`git push origin feature/AmazingFeature`)
5. Open a Pull Request

---

## License

This project is licensed under the MIT License - [LICENSE](LICENSE).

---

## Acknowledgments

- [Zotero](https://www.zotero.org) for the amazing reference manager
- [Zotero Plugin Template](https://github.com/windingwind/zotero-plugin-template) for the plugin scaffolding
- [DataLab](https://datalab.to) for OCR services

---

## Support

- **Issues**: [GitHub Issues](https://github.com/dralkh/Seer-AI/issues)
- **Discussions**: [GitHub Discussions](https://github.com/dralkh/Seer-AI/discussions)
