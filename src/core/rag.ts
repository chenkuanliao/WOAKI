import type { ChatMessage, LLMAdapter } from "./llm-adapter";
import type { WoakiDatabase, SearchResult } from "./database";
import type { EmbeddingModel } from "./embedding";
import type { WoakiSettings } from "../settings";
import { RAG_SYSTEM_PROMPT } from "../constants";

export interface RAGSource {
    title: string;
    filePath: string;
    score: number;
    excerpt: string;
}

export interface RAGResponse {
    answer: string;
    sources: RAGSource[];
}

/**
 * Deduplicate search results: keep only the highest-scoring chunk per note.
 */
function deduplicateByNote(results: SearchResult[]): SearchResult[] {
    const best = new Map<string, SearchResult>();
    for (const r of results) {
        const existing = best.get(r.document.noteId);
        if (!existing || r.score > existing.score) {
            best.set(r.document.noteId, r);
        }
    }
    return Array.from(best.values());
}

/**
 * Build the context string and source list from search results.
 */
function buildContext(results: SearchResult[]): { context: string; sources: RAGSource[] } {
    const sources: RAGSource[] = [];
    const contextParts: string[] = [];

    for (let i = 0; i < results.length; i++) {
        const r = results[i]!;
        contextParts.push(`[Source ${i + 1}: ${r.document.title}]\n${r.document.content}`);
        sources.push({
            title: r.document.title,
            filePath: r.document.filePath,
            score: r.score,
            excerpt: r.document.content.substring(0, 200) + (r.document.content.length > 200 ? "..." : ""),
        });
    }

    return {
        context: contextParts.join("\n\n---\n\n"),
        sources,
    };
}

/**
 * Build the message array for the LLM, including conversation history.
 */
function buildMessages(
    context: string,
    query: string,
    conversationHistory: ChatMessage[],
): ChatMessage[] {
    const messages: ChatMessage[] = [
        { role: "system", content: RAG_SYSTEM_PROMPT },
    ];

    // Add prior conversation turns (limit to last 10 messages to avoid token overflow)
    const recentHistory = conversationHistory.slice(-10);
    messages.push(...recentHistory);

    // Add current user query with context
    const userPrompt = context
        ? `Context from my notes:\n\n${context}\n\n---\n\nQuestion: ${query}`
        : query;

    messages.push({ role: "user", content: userPrompt });

    return messages;
}

export interface RAGOptions {
    tagFilter?: string[];
    forcedNoteIds?: string[];
}

/**
 * Merge forced-note chunks (at top) with search results, deduplicating by chunk id.
 */
async function mergeForced(
    database: WoakiDatabase,
    forcedNoteIds: string[],
    searchResults: SearchResult[],
): Promise<SearchResult[]> {
    const forced: SearchResult[] = [];
    for (const noteId of forcedNoteIds) {
        const chunks = await database.getChunksByNoteId(noteId);
        forced.push(...chunks);
    }

    // Dedup: if a search result has the same noteId as a forced chunk, skip it
    const forcedNotes = new Set(forcedNoteIds);
    const filtered = searchResults.filter(r => !forcedNotes.has(r.document.noteId));
    return [...forced, ...filtered];
}

/**
 * Non-streaming RAG query. Returns the full response at once.
 */
export async function ragQuery(
    query: string,
    database: WoakiDatabase,
    embeddingModel: EmbeddingModel,
    llmAdapter: LLMAdapter,
    settings: WoakiSettings,
    conversationHistory: ChatMessage[] = [],
    options: RAGOptions = {},
): Promise<RAGResponse> {
    // 1. Embed query
    const queryEmbedding = await embeddingModel.embed(query);

    // 2. Hybrid search with optional tag filter
    let results = await database.hybridSearch(query, queryEmbedding, settings.topK, options.tagFilter);

    // 2b. Merge forced notes
    if (options.forcedNoteIds && options.forcedNoteIds.length > 0) {
        results = await mergeForced(database, options.forcedNoteIds, results);
    }

    // 3. Deduplicate
    const unique = deduplicateByNote(results);

    // 4. Build context
    const { context, sources } = buildContext(unique);

    // 5. Build messages
    const messages = buildMessages(context, query, conversationHistory);

    // 6. Call LLM
    const response = await llmAdapter.chat(messages);

    return { answer: response.content, sources };
}

/**
 * Streaming RAG query. Calls onChunk as tokens arrive.
 * Returns the sources immediately after retrieval.
 */
export async function ragQueryStream(
    query: string,
    database: WoakiDatabase,
    embeddingModel: EmbeddingModel,
    llmAdapter: LLMAdapter,
    settings: WoakiSettings,
    conversationHistory: ChatMessage[],
    onSources: (sources: RAGSource[]) => void,
    onChunk: (text: string) => void,
    onDone: () => void,
    signal?: AbortSignal,
    options: RAGOptions = {},
): Promise<void> {
    // 1. Embed query
    const queryEmbedding = await embeddingModel.embed(query);

    // 2. Hybrid search with optional tag filter
    let results = await database.hybridSearch(query, queryEmbedding, settings.topK, options.tagFilter);

    // 2b. Merge forced notes
    if (options.forcedNoteIds && options.forcedNoteIds.length > 0) {
        results = await mergeForced(database, options.forcedNoteIds, results);
    }

    // 3. Deduplicate
    const unique = deduplicateByNote(results);

    // 4. Build context and notify sources
    const { context, sources } = buildContext(unique);
    onSources(sources);

    // 5. Build messages
    const messages = buildMessages(context, query, conversationHistory);

    // 6. Stream LLM response
    await llmAdapter.chatStream(messages, onChunk, onDone, signal);
}
