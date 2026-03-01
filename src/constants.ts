// View types
export const CHAT_VIEW_TYPE = "woaki-chat-view";
export const MEMORY_STATUS_VIEW_TYPE = "woaki-memory-status-view";

// Frontmatter keys
export const WOAKI_PROPERTY = "woaki";
export const WOAKI_ID_PROPERTY = "woaki-id";
export const WOAKI_MEMORIZED_VALUE = "memorized";

// Command IDs
export const CMD_MEMORIZE_NOTE = "memorize-note";
export const CMD_FORGET_NOTE = "forget-note";
export const CMD_MEMORIZE_FOLDER = "memorize-folder";
export const CMD_OPEN_CHAT = "open-chat";
export const CMD_OPEN_MEMORY_STATUS = "open-memory-status";
export const CMD_REBUILD_DATABASE = "rebuild-database";
export const CMD_CLEAR_DATABASE = "clear-database";

// Conversation persistence
export const CONVERSATIONS_DIR = "conversations";

// Icons
export const ICON_BRAIN = "brain";
export const ICON_DASHBOARD = "gauge";

// Database
export const DB_FILENAME = "orama-db.json";
export const DEFAULT_EMBEDDING_MODEL = "TaylorAI/bge-micro-v2";
export const EMBEDDING_DIMENSIONS = 384;
export const DEFAULT_CHUNK_SIZE = 1000;
export const REINDEX_DEBOUNCE_MS = 5000;

// Available embedding models (label, HuggingFace ID, dimensions)
export const EMBEDDING_MODELS: Array<{ id: string; label: string; dimensions: number }> = [
	{ id: "TaylorAI/bge-micro-v2", label: "BGE Micro v2 (23 MB)", dimensions: 384 },
	{ id: "Xenova/all-MiniLM-L6-v2", label: "MiniLM L6 v2 (90 MB)", dimensions: 384 },
	{ id: "Xenova/bge-small-en-v1.5", label: "BGE Small EN v1.5 (130 MB)", dimensions: 384 },
	{ id: "Xenova/bge-base-en-v1.5", label: "BGE Base EN v1.5 (430 MB)", dimensions: 768 },
];

// Plugin
export const PLUGIN_DISPLAY_NAME = "WOAKI";

// LLM Provider defaults
export const PROVIDER_DEFAULTS: Record<string, { baseUrl: string; model: string }> = {
	openai: { baseUrl: "https://api.openai.com", model: "gpt-4o-mini" },
	anthropic: { baseUrl: "https://api.anthropic.com", model: "claude-sonnet-4-5-20250929" },
	ollama: { baseUrl: "http://localhost:11434", model: "llama3.2" },
};

// RAG
export const RAG_SYSTEM_PROMPT = `You are a helpful assistant. Answer the user's question using ONLY the provided context from their notes. If the context doesn't contain enough information to answer fully, say so honestly. When citing sources, reference them by note title and chunk number using the format【Source: Note Title, Chunk: N】or【Source: Note Title, Chunks: N, M】when combining multiple chunks from the same note. Place citations at the end of the relevant sentence or paragraph.`;
