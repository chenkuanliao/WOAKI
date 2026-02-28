import { requestUrl } from "obsidian";
import type { WoakiSettings } from "../settings";
import { classifyHttpError, classifyNetworkError, LLMConnectionError } from "../utils/errors";

export interface ChatMessage {
    role: "system" | "user" | "assistant";
    content: string;
}

interface LLMProvider {
    name: string;
    baseUrl: string;
    apiKey?: string;
    model: string;
}

export class LLMAdapter {
    private provider: LLMProvider;
    private providerOverride: LLMProvider | null = null;

    constructor(settings: WoakiSettings) {
        this.provider = LLMAdapter.buildProvider(settings);
    }

    /** Rebuild provider config when settings change. */
    updateSettings(settings: WoakiSettings): void {
        this.provider = LLMAdapter.buildProvider(settings);
        this.providerOverride = null;
    }

    /** Override both provider and model for the current chat session. */
    setProviderOverride(name: string, model: string, apiKey?: string, baseUrl?: string): void {
        this.providerOverride = { name, model, apiKey, baseUrl: baseUrl ?? "" };
    }

    /** Clear the provider override, reverting to settings defaults. */
    clearOverride(): void {
        this.providerOverride = null;
    }

    /** Returns the active model: override if set, else provider default. */
    getActiveModel(): string {
        return (this.providerOverride ?? this.provider).model;
    }

    /** Returns the current provider name (e.g. "OpenAI", "Ollama", "Anthropic"). */
    getProviderName(): string {
        return (this.providerOverride ?? this.provider).name;
    }

    /** Get the active provider (override or default). */
    private getActiveProvider(): LLMProvider {
        return this.providerOverride ?? this.provider;
    }

    private static buildProvider(settings: WoakiSettings): LLMProvider {
        const provider = settings.llmProvider;
        const config = settings.providers[provider];

        switch (provider) {
            case "ollama":
                return {
                    name: "Ollama",
                    baseUrl: config.baseUrl || "http://localhost:11434",
                    model: settings.llmModel || "llama3.2",
                };
            case "anthropic":
                return {
                    name: "Anthropic",
                    baseUrl: config.baseUrl || "https://api.anthropic.com",
                    apiKey: config.apiKey,
                    model: settings.llmModel || "claude-sonnet-4-5-20250929",
                };
            case "openai":
            default:
                return {
                    name: "OpenAI",
                    baseUrl: config.baseUrl || "https://api.openai.com",
                    apiKey: config.apiKey,
                    model: settings.llmModel || "gpt-4o-mini",
                };
        }
    }

    /** Non-streaming chat completion using Obsidian's requestUrl (avoids CORS). */
    async chat(messages: ChatMessage[]): Promise<{ content: string }> {
        return this.withRetry(async () => {
            const p = this.getActiveProvider();
            if (p.name === "Anthropic") {
                return this.chatAnthropic(messages);
            }

            const headers: Record<string, string> = {
                "Content-Type": "application/json",
            };
            if (p.apiKey) {
                headers["Authorization"] = `Bearer ${p.apiKey}`;
            }

            const url = p.name === "Ollama"
                ? `${p.baseUrl}/api/chat`
                : `${p.baseUrl}/v1/chat/completions`;

            const body = { model: this.getActiveModel(), messages, stream: false };

            try {
                const response = await requestUrl({
                    url,
                    method: "POST",
                    headers,
                    body: JSON.stringify(body),
                });

                if (p.name === "Ollama") {
                    return { content: response.json.message?.content ?? "" };
                }
                return { content: response.json.choices[0].message.content };
            } catch (e: unknown) {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const status = (e as any)?.status;
                if (typeof status === "number") {
                    throw classifyHttpError(status, String(e), p.name);
                }
                throw classifyNetworkError(e, p.name);
            }
        });
    }

    /** Streaming chat completion via fetch + SSE. */
    async chatStream(
        messages: ChatMessage[],
        onChunk: (text: string) => void,
        onDone: () => void,
        signal?: AbortSignal,
    ): Promise<void> {
        const p = this.getActiveProvider();
        if (p.name === "Anthropic") {
            return this.chatStreamAnthropic(messages, onChunk, onDone, signal);
        }

        const headers: Record<string, string> = {
            "Content-Type": "application/json",
        };
        if (p.apiKey) {
            headers["Authorization"] = `Bearer ${p.apiKey}`;
        }

        const url = p.name === "Ollama"
            ? `${p.baseUrl}/api/chat`
            : `${p.baseUrl}/v1/chat/completions`;

        const body = { model: this.getActiveModel(), messages, stream: true };

        let response: Response;
        try {
            response = await fetch(url, {
                method: "POST",
                headers,
                body: JSON.stringify(body),
                signal,
            });
        } catch (e) {
            throw classifyNetworkError(e, p.name);
        }

        if (!response.ok) {
            const errorText = await response.text();
            throw classifyHttpError(response.status, errorText, p.name);
        }

        const reader = response.body!.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split("\n");
                buffer = lines.pop() ?? "";

                for (const line of lines) {
                    if (p.name === "Ollama") {
                        const trimmed = line.trim();
                        if (!trimmed) continue;
                        try {
                            const parsed = JSON.parse(trimmed);
                            if (parsed.message?.content) {
                                onChunk(parsed.message.content);
                            }
                            if (parsed.done) {
                                onDone();
                                return;
                            }
                        } catch { /* skip malformed lines */ }
                    } else {
                        if (line.startsWith("data: ")) {
                            const data = line.slice(6);
                            if (data === "[DONE]") {
                                onDone();
                                return;
                            }
                            try {
                                const parsed = JSON.parse(data);
                                const content = parsed.choices?.[0]?.delta?.content;
                                if (content) onChunk(content);
                            } catch { /* skip malformed lines */ }
                        }
                    }
                }
            }
        } finally {
            reader.releaseLock();
        }
        onDone();
    }

    /** Test if the LLM provider is reachable. */
    async testConnection(): Promise<{ ok: boolean; error?: string }> {
        const p = this.getActiveProvider();
        try {
            let url: string;
            if (p.name === "Ollama") {
                url = `${p.baseUrl}/api/tags`;
            } else if (p.name === "Anthropic") {
                const res = await this.chat([
                    { role: "user", content: "Say 'ok'" },
                ]);
                return { ok: !!res.content };
            } else {
                url = `${p.baseUrl}/v1/models`;
            }

            const headers: Record<string, string> = {};
            if (p.apiKey) {
                headers["Authorization"] = `Bearer ${p.apiKey}`;
            }

            const response = await requestUrl({ url, method: "GET", headers });
            return { ok: response.status === 200 };
        } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            return { ok: false, error: msg };
        }
    }

    /** Test connection for a specific provider config. */
    async testProviderConnection(name: string, apiKey: string, baseUrl: string): Promise<{ ok: boolean; error?: string }> {
        const saved = this.providerOverride;
        this.providerOverride = { name, model: "", apiKey, baseUrl };
        try {
            return await this.testConnection();
        } finally {
            this.providerOverride = saved;
        }
    }

    /** List models for a specific provider config (does not affect current override). */
    async listModelsForProvider(name: string, apiKey: string, baseUrl: string): Promise<string[]> {
        const saved = this.providerOverride;
        this.providerOverride = { name, model: "", apiKey, baseUrl };
        try {
            return await this.listModels();
        } finally {
            this.providerOverride = saved;
        }
    }

    /** List available models from the provider. */
    async listModels(): Promise<string[]> {
        const p = this.getActiveProvider();
        try {
            let url: string;
            const headers: Record<string, string> = {};

            if (p.name === "Ollama") {
                url = `${p.baseUrl}/api/tags`;
                const response = await requestUrl({ url, method: "GET", headers });
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                return response.json.models?.map((m: any) => m.name) ?? [];
            } else if (p.name === "Anthropic") {
                return [
                    "claude-opus-4-6",
                    "claude-sonnet-4-5-20250929",
                    "claude-haiku-4-5-20251001",
                    "claude-3-5-haiku-20241022",
                    "claude-3-opus-20240229",
                ];
            } else {
                url = `${p.baseUrl}/v1/models`;
                if (p.apiKey) {
                    headers["Authorization"] = `Bearer ${p.apiKey}`;
                }
                const response = await requestUrl({ url, method: "GET", headers });
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const allModels: string[] = response.json.data?.map((m: any) => m.id) ?? [];
                const chatPrefixes = ["gpt-", "o1-", "o3-", "o4-", "chatgpt-"];
                return allModels
                    .filter(id => chatPrefixes.some(pfx => id.startsWith(pfx)))
                    .sort();
            }
        } catch {
            return [];
        }
    }

    // --- Retry helper ---

    private async withRetry<T>(fn: () => Promise<T>, maxAttempts = 3): Promise<T> {
        const delays = [1000, 2000, 4000];
        let lastError: unknown;
        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            try {
                return await fn();
            } catch (e) {
                lastError = e;
                if (e instanceof LLMConnectionError && e.retryable && attempt < maxAttempts - 1) {
                    await new Promise(resolve => setTimeout(resolve, delays[attempt]));
                    continue;
                }
                throw e;
            }
        }
        throw lastError;
    }

    // --- Anthropic-specific methods ---

    private async chatAnthropic(messages: ChatMessage[]): Promise<{ content: string }> {
        const p = this.getActiveProvider();
        const systemMsg = messages.find((m) => m.role === "system");
        const nonSystemMsgs = messages
            .filter((m) => m.role !== "system")
            .map((m) => ({ role: m.role, content: m.content }));

        const url = `${p.baseUrl}/v1/messages`;
        const headers: Record<string, string> = {
            "Content-Type": "application/json",
            "x-api-key": p.apiKey ?? "",
            "anthropic-version": "2023-06-01",
        };

        const body: Record<string, unknown> = {
            model: this.getActiveModel(),
            max_tokens: 4096,
            messages: nonSystemMsgs,
        };
        if (systemMsg) {
            body.system = systemMsg.content;
        }

        try {
            const response = await requestUrl({
                url,
                method: "POST",
                headers,
                body: JSON.stringify(body),
            });

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const textBlock = response.json.content?.find((b: any) => b.type === "text");
            return { content: textBlock?.text ?? "" };
        } catch (e: unknown) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const status = (e as any)?.status;
            if (typeof status === "number") {
                throw classifyHttpError(status, String(e), "Anthropic");
            }
            throw classifyNetworkError(e, "Anthropic");
        }
    }

    private async chatStreamAnthropic(
        messages: ChatMessage[],
        onChunk: (text: string) => void,
        onDone: () => void,
        signal?: AbortSignal,
    ): Promise<void> {
        const p = this.getActiveProvider();
        const systemMsg = messages.find((m) => m.role === "system");
        const nonSystemMsgs = messages
            .filter((m) => m.role !== "system")
            .map((m) => ({ role: m.role, content: m.content }));

        const url = `${p.baseUrl}/v1/messages`;
        const headers: Record<string, string> = {
            "Content-Type": "application/json",
            "x-api-key": p.apiKey ?? "",
            "anthropic-version": "2023-06-01",
        };

        const body: Record<string, unknown> = {
            model: this.getActiveModel(),
            max_tokens: 4096,
            messages: nonSystemMsgs,
            stream: true,
        };
        if (systemMsg) {
            body.system = systemMsg.content;
        }

        let response: Response;
        try {
            response = await fetch(url, {
                method: "POST",
                headers,
                body: JSON.stringify(body),
                signal,
            });
        } catch (e) {
            throw classifyNetworkError(e, "Anthropic");
        }

        if (!response.ok) {
            const errorText = await response.text();
            throw classifyHttpError(response.status, errorText, "Anthropic");
        }

        const reader = response.body!.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split("\n");
                buffer = lines.pop() ?? "";

                for (const line of lines) {
                    if (line.startsWith("data: ")) {
                        const data = line.slice(6);
                        try {
                            const parsed = JSON.parse(data);
                            if (parsed.type === "content_block_delta" && parsed.delta?.text) {
                                onChunk(parsed.delta.text);
                            }
                            if (parsed.type === "message_stop") {
                                onDone();
                                return;
                            }
                        } catch { /* skip */ }
                    }
                }
            }
        } finally {
            reader.releaseLock();
        }
        onDone();
    }
}
