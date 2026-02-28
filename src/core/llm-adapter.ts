import { requestUrl } from "obsidian";
import type { WoakiSettings } from "../settings";

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

    constructor(settings: WoakiSettings) {
        this.provider = LLMAdapter.buildProvider(settings);
    }

    /** Rebuild provider config when settings change. */
    updateSettings(settings: WoakiSettings): void {
        this.provider = LLMAdapter.buildProvider(settings);
    }

    private static buildProvider(settings: WoakiSettings): LLMProvider {
        switch (settings.llmProvider) {
            case "ollama":
                return {
                    name: "Ollama",
                    baseUrl: settings.llmBaseUrl || "http://localhost:11434",
                    model: settings.llmModel || "llama3.2",
                };
            case "anthropic":
                return {
                    name: "Anthropic",
                    baseUrl: settings.llmBaseUrl || "https://api.anthropic.com",
                    apiKey: settings.llmApiKey,
                    model: settings.llmModel || "claude-sonnet-4-5-20250929",
                };
            case "openai":
            default:
                return {
                    name: "OpenAI",
                    baseUrl: settings.llmBaseUrl || "https://api.openai.com",
                    apiKey: settings.llmApiKey,
                    model: settings.llmModel || "gpt-4o-mini",
                };
        }
    }

    /** Non-streaming chat completion using Obsidian's requestUrl (avoids CORS). */
    async chat(messages: ChatMessage[]): Promise<{ content: string }> {
        if (this.provider.name === "Anthropic") {
            return this.chatAnthropic(messages);
        }

        const headers: Record<string, string> = {
            "Content-Type": "application/json",
        };
        if (this.provider.apiKey) {
            headers["Authorization"] = `Bearer ${this.provider.apiKey}`;
        }

        const url = this.provider.name === "Ollama"
            ? `${this.provider.baseUrl}/api/chat`
            : `${this.provider.baseUrl}/v1/chat/completions`;

        const body = this.provider.name === "Ollama"
            ? { model: this.provider.model, messages, stream: false }
            : { model: this.provider.model, messages, stream: false };

        const response = await requestUrl({
            url,
            method: "POST",
            headers,
            body: JSON.stringify(body),
        });

        if (this.provider.name === "Ollama") {
            return { content: response.json.message?.content ?? "" };
        }
        return { content: response.json.choices[0].message.content };
    }

    /** Streaming chat completion via fetch + SSE. */
    async chatStream(
        messages: ChatMessage[],
        onChunk: (text: string) => void,
        onDone: () => void,
        signal?: AbortSignal,
    ): Promise<void> {
        if (this.provider.name === "Anthropic") {
            return this.chatStreamAnthropic(messages, onChunk, onDone, signal);
        }

        const headers: Record<string, string> = {
            "Content-Type": "application/json",
        };
        if (this.provider.apiKey) {
            headers["Authorization"] = `Bearer ${this.provider.apiKey}`;
        }

        const url = this.provider.name === "Ollama"
            ? `${this.provider.baseUrl}/api/chat`
            : `${this.provider.baseUrl}/v1/chat/completions`;

        const body = { model: this.provider.model, messages, stream: true };

        const response = await fetch(url, {
            method: "POST",
            headers,
            body: JSON.stringify(body),
            signal,
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`LLM request failed (${response.status}): ${errorText}`);
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
                    if (this.provider.name === "Ollama") {
                        // Ollama streams JSON objects, one per line
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
                        // OpenAI SSE format
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
        try {
            let url: string;
            if (this.provider.name === "Ollama") {
                url = `${this.provider.baseUrl}/api/tags`;
            } else if (this.provider.name === "Anthropic") {
                // Anthropic doesn't have a model-list endpoint; do a minimal completion
                const res = await this.chat([
                    { role: "user", content: "Say 'ok'" },
                ]);
                return { ok: !!res.content };
            } else {
                url = `${this.provider.baseUrl}/v1/models`;
            }

            const headers: Record<string, string> = {};
            if (this.provider.apiKey) {
                headers["Authorization"] = `Bearer ${this.provider.apiKey}`;
            }

            const response = await requestUrl({ url, method: "GET", headers });
            return { ok: response.status === 200 };
        } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            return { ok: false, error: msg };
        }
    }

    /** List available models from the provider. */
    async listModels(): Promise<string[]> {
        try {
            let url: string;
            const headers: Record<string, string> = {};

            if (this.provider.name === "Ollama") {
                url = `${this.provider.baseUrl}/api/tags`;
                const response = await requestUrl({ url, method: "GET", headers });
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                return response.json.models?.map((m: any) => m.name) ?? [];
            } else if (this.provider.name === "Anthropic") {
                // Anthropic doesn't expose a model list endpoint
                return ["claude-sonnet-4-5-20250929", "claude-3-5-haiku-20241022", "claude-3-opus-20240229"];
            } else {
                url = `${this.provider.baseUrl}/v1/models`;
                if (this.provider.apiKey) {
                    headers["Authorization"] = `Bearer ${this.provider.apiKey}`;
                }
                const response = await requestUrl({ url, method: "GET", headers });
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                return response.json.data?.map((m: any) => m.id) ?? [];
            }
        } catch {
            return [];
        }
    }

    // --- Anthropic-specific methods ---

    private async chatAnthropic(messages: ChatMessage[]): Promise<{ content: string }> {
        const systemMsg = messages.find((m) => m.role === "system");
        const nonSystemMsgs = messages
            .filter((m) => m.role !== "system")
            .map((m) => ({ role: m.role, content: m.content }));

        const url = `${this.provider.baseUrl}/v1/messages`;
        const headers: Record<string, string> = {
            "Content-Type": "application/json",
            "x-api-key": this.provider.apiKey ?? "",
            "anthropic-version": "2023-06-01",
        };

        const body: Record<string, unknown> = {
            model: this.provider.model,
            max_tokens: 4096,
            messages: nonSystemMsgs,
        };
        if (systemMsg) {
            body.system = systemMsg.content;
        }

        const response = await requestUrl({
            url,
            method: "POST",
            headers,
            body: JSON.stringify(body),
        });

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const textBlock = response.json.content?.find((b: any) => b.type === "text");
        return { content: textBlock?.text ?? "" };
    }

    private async chatStreamAnthropic(
        messages: ChatMessage[],
        onChunk: (text: string) => void,
        onDone: () => void,
        signal?: AbortSignal,
    ): Promise<void> {
        const systemMsg = messages.find((m) => m.role === "system");
        const nonSystemMsgs = messages
            .filter((m) => m.role !== "system")
            .map((m) => ({ role: m.role, content: m.content }));

        const url = `${this.provider.baseUrl}/v1/messages`;
        const headers: Record<string, string> = {
            "Content-Type": "application/json",
            "x-api-key": this.provider.apiKey ?? "",
            "anthropic-version": "2023-06-01",
        };

        const body: Record<string, unknown> = {
            model: this.provider.model,
            max_tokens: 4096,
            messages: nonSystemMsgs,
            stream: true,
        };
        if (systemMsg) {
            body.system = systemMsg.content;
        }

        const response = await fetch(url, {
            method: "POST",
            headers,
            body: JSON.stringify(body),
            signal,
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Anthropic request failed (${response.status}): ${errorText}`);
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
