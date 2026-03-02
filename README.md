# WOAKI - Write Once And Know It

A semantic memory layer for [Obsidian](https://obsidian.md) that lets you selectively memorize notes into a local vector database for AI-powered retrieval and chat.

## What is WOAKI?

WOAKI adds a **selective memory layer** to your Obsidian vault. Instead of indexing everything, you choose which notes matter. Memorized notes are chunked, embedded locally, and stored in a vector database — all without leaving Obsidian. Then ask questions in a chat sidebar and get answers grounded in your own notes, with source citations.

**Core principles:**

- **Vault is the source of truth** — All content lives as standard markdown files. The vector database is a rebuildable cache.
- **Explicit memory** — You decide what gets indexed. No automatic indexing of everything.
- **Transparent AI** — The chat interface shows which notes were used as context.
- **Local-first** — Embeddings run locally via Transformers.js. No external servers required for indexing.
- **Lightweight** — No native dependencies. Everything bundles into the plugin.

## Features

### Memorize & Forget

Select which notes WOAKI should remember. Memorized notes get a `woaki: memorized` frontmatter property, are chunked by headings, embedded locally, and stored in an in-memory vector database (Orama) that persists to disk as JSON.

- Memorize/forget via command palette, right-click context menu, or keyboard shortcuts
- Automatic re-indexing when memorized notes are edited (with debounce)
- Change detection via content hashing — only re-embeds chunks that actually changed
- Handles file renames and deletions gracefully

### RAG Chat

Ask questions about your memorized notes in a sidebar chat view. WOAKI embeds your question, searches the vector database for relevant chunks, and sends them as context to an LLM.

- Streaming responses rendered as markdown
- Clickable source citations that open the referenced note
- Hybrid search (vector similarity + BM25 full-text) for better retrieval
- Tag-filtered queries — restrict search to notes with specific tags
- `@[[Note]]` references to force-include a note in context
- Conversation history within the session

### LLM Providers

Connect to any OpenAI-compatible LLM provider:

| Provider | Type | API Key Required |
|----------|------|-----------------|
| [Ollama](https://ollama.com) | Local | No |
| [LM Studio](https://lmstudio.ai) | Local | No |
| OpenAI | Cloud | Yes |
| Anthropic | Cloud | Yes |
| Custom endpoint | Any | Configurable |

Embeddings are always generated locally — the LLM provider is only used for chat responses.

### Local Embedding

Embeddings are generated entirely on-device using [Transformers.js](https://huggingface.co/docs/transformers.js) (ONNX Runtime / WASM). The default model is `TaylorAI/bge-micro-v2` (384 dimensions, ~23MB, downloaded once on first use).

No API key needed for embeddings. No data leaves your machine during indexing.

## Installation

### From Obsidian Community Plugins (coming soon)

1. Open **Settings > Community Plugins > Browse**
2. Search for **WOAKI**
3. Click **Install**, then **Enable**

### Manual Installation

1. Download `main.js`, `styles.css`, and `manifest.json` from the [latest release](https://github.com/chenkuanliao/WOAKI/releases)
2. Create a folder at `<your-vault>/.obsidian/plugins/woaki/`
3. Copy the three files into that folder (WASM files are downloaded automatically on first use via CDN fallback)
4. Open **Settings > Community Plugins** and enable **WOAKI**

## Usage

### Memorizing a Note

1. Open a note you want WOAKI to remember
2. Run the command **WOAKI: Memorize current note** (`Ctrl/Cmd+Shift+M`)
3. The note's frontmatter will be updated with `woaki: memorized` and a unique ID
4. The note is chunked, embedded, and stored in the vector database

You can also right-click a note in the file explorer and select **WOAKI: Memorize this note**.

### Forgetting a Note

1. Open a memorized note
2. Run the command **WOAKI: Forget current note** (`Ctrl/Cmd+Shift+U`)
3. The `woaki` properties are removed from frontmatter and all chunks are deleted from the database

The note content itself is never modified.

### Chatting with Your Notes

1. Click the brain icon in the left ribbon, or run **WOAKI: Open Chat** (`Ctrl/Cmd+Shift+K`)
2. Type a question in the input area
3. WOAKI will search your memorized notes, retrieve relevant chunks, and send them to your configured LLM
4. The response appears with source citations — click any source to open that note

### Configuring an LLM Provider

1. Open **Settings > WOAKI**
2. Select your LLM provider (Ollama, LM Studio, OpenAI, Anthropic, or Custom)
3. Enter the server URL and/or API key as needed
4. Click **Test Connection** to verify
5. Select a model from the dropdown

**Quickest setup:** Install [Ollama](https://ollama.com), pull a model (`ollama pull llama3.2`), and WOAKI will connect to it at `http://localhost:11434` with no API key needed.

## Commands

| Command | Default Shortcut | Description |
|---------|-----------------|-------------|
| Memorize current note | `Ctrl/Cmd+Shift+M` | Add the active note to WOAKI's memory |
| Forget current note | `Ctrl/Cmd+Shift+U` | Remove the active note from memory |
| Open WOAKI Chat | `Ctrl/Cmd+Shift+K` | Toggle the chat sidebar |
| Open Memory Status | — | View all memorized notes and their stats |
| Rebuild Database | — | Re-chunk and re-embed all memorized notes |
| Clear Database | — | Delete all embeddings (notes are untouched) |

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| LLM Provider | Ollama | Which LLM service to use for chat |
| Embedding Model | `TaylorAI/bge-micro-v2` | Local model for generating embeddings |
| Chunk Size | 2000 chars | Maximum size of each text chunk |
| Auto Re-index | On | Re-index memorized notes when they're edited |
| Re-index Debounce | 5 seconds | Wait time after editing before re-indexing |
| Top-K Results | 5 | Number of chunks retrieved per query |
| Max Context Tokens | 4000 | Maximum context size sent to the LLM |

## How It Works

```
Write a note in Obsidian
        |
        v
Run "Memorize this note"
        |
        v
Plugin adds `woaki: memorized` to frontmatter
        |
        v
Note is chunked by headings / paragraph size
        |
        v
Transformers.js generates 384-dim embeddings per chunk (local, on-device)
        |
        v
Chunks + embeddings stored in Orama (in-memory vector DB, persisted to JSON)
        |
        v
Ask a question in the Chat sidebar
        |
        v
Question is embedded -> vector search -> top-k relevant chunks retrieved
        |
        v
Chunks + question sent to your LLM (Ollama / OpenAI / etc.)
        |
        v
Response displayed with clickable source citations
```

### Data Storage

| Data | Location | Rebuildable? |
|------|----------|-------------|
| Your notes | Vault (standard `.md` files) | Source of truth |
| Memory state | Note frontmatter (`woaki: memorized`) | Source of truth |
| Plugin settings | `.obsidian/plugins/woaki/data.json` | User re-enters |
| Vector database | `.obsidian/plugins/woaki/orama-db.json` | Yes, from vault files |
| Embedding model | OS cache directory | Re-downloaded automatically |

If the vector database is ever lost or corrupted, WOAKI can fully rebuild it by scanning your vault for notes marked as memorized.

### Tech Stack

- **Vector DB:** [Orama](https://github.com/oramasearch/orama) — pure JS, in-memory, supports hybrid search (vector + BM25), ~20KB gzipped
- **Embeddings:** [Transformers.js](https://huggingface.co/docs/transformers.js) v3 — runs ONNX models via WASM, fully local
- **LLM:** OpenAI-compatible API adapter — works with Ollama, LM Studio, OpenAI, Anthropic, and any compatible endpoint
- **Build:** esbuild — bundles everything into a single `main.js`

## Development

```bash
# Clone into your vault's plugin directory
cd /path/to/vault/.obsidian/plugins/
git clone <repo-url> woaki
cd woaki

# Install dependencies
npm install

# Build in watch mode
npm run dev

# Production build
npm run build
```

Enable the plugin in **Settings > Community Plugins**, then reload Obsidian (`Ctrl/Cmd+R`) after making changes.

## Security Note

API keys (for OpenAI, Anthropic, etc.) are stored in `.obsidian/plugins/woaki/data.json`. This file is local to your vault. If you use Obsidian Sync, consider excluding the plugin data folder from syncing to avoid exposing API keys.

## License

[MIT](LICENSE)
