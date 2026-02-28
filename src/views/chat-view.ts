import { ItemView, MarkdownRenderer, WorkspaceLeaf } from "obsidian";
import { CHAT_VIEW_TYPE, PLUGIN_DISPLAY_NAME } from "../constants";
import type WoakiPlugin from "../main";
import type { ChatMessage } from "../core/llm-adapter";
import type { RAGSource } from "../core/rag";
import { ragQueryStream } from "../core/rag";

interface MessageInternal {
    id: string;
    role: "user" | "assistant";
    content: string;
    element: HTMLElement;
}

export class WoakiChatView extends ItemView {
    plugin: WoakiPlugin;
    private messagesEl: HTMLElement;
    private inputEl: HTMLTextAreaElement;
    private sendBtn: HTMLButtonElement;
    private conversationHistory: MessageInternal[] = [];
    private isGenerating = false;
    private abortController: AbortController | null = null;

    constructor(leaf: WorkspaceLeaf, plugin: WoakiPlugin) {
        super(leaf);
        this.plugin = plugin;
    }

    getViewType(): string {
        return CHAT_VIEW_TYPE;
    }

    getDisplayText(): string {
        return `${PLUGIN_DISPLAY_NAME} Chat`;
    }

    getIcon(): string {
        return "message-circle";
    }

    async onOpen(): Promise<void> {
        const container = this.contentEl;
        container.empty();
        container.addClass("woaki-chat-container");

        this.buildHeader(container);
        this.messagesEl = container.createDiv("woaki-chat-messages");
        this.buildInputArea(container);
        this.showEmptyState();
    }

    async onClose(): Promise<void> {
        this.abortController?.abort();
    }

    private buildHeader(container: HTMLElement): void {
        const header = container.createDiv("woaki-chat-header");

        const titleEl = header.createDiv("woaki-chat-title");
        titleEl.createEl("span", { text: PLUGIN_DISPLAY_NAME, cls: "woaki-chat-title-text" });

        const modelEl = titleEl.createEl("span", {
            text: this.plugin.settings.llmModel || "No model",
            cls: "woaki-chat-model-badge",
        });
        modelEl.setAttribute("title", `Provider: ${this.plugin.settings.llmProvider}`);

        const actions = header.createDiv("woaki-chat-actions");

        const clearBtn = actions.createEl("button", {
            cls: "woaki-chat-action-btn clickable-icon",
            attr: { "aria-label": "New conversation" },
        });
        clearBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/><path d="M16 16h5v5"/></svg>`;
        clearBtn.addEventListener("click", () => this.clearConversation());
    }

    private buildInputArea(container: HTMLElement): void {
        const inputArea = container.createDiv("woaki-chat-input-area");

        const inputWrapper = inputArea.createDiv("woaki-chat-input-wrapper");

        this.inputEl = inputWrapper.createEl("textarea", {
            cls: "woaki-chat-input",
            attr: {
                placeholder: "Ask about your memorized notes...",
                rows: "1",
            },
        });

        this.sendBtn = inputWrapper.createEl("button", {
            cls: "woaki-send-btn clickable-icon",
            attr: { "aria-label": "Send message" },
        });
        this.sendBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>`;

        // Auto-resize textarea
        this.inputEl.addEventListener("input", () => {
            this.inputEl.style.height = "auto";
            this.inputEl.style.height = Math.min(this.inputEl.scrollHeight, 150) + "px";
        });

        // Enter to send, Shift+Enter for newline
        this.inputEl.addEventListener("keydown", (e) => {
            if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                this.handleSend();
            }
        });

        this.sendBtn.addEventListener("click", () => this.handleSend());
    }

    private showEmptyState(): void {
        const emptyState = this.messagesEl.createDiv("woaki-empty-state");
        emptyState.createEl("div", { text: "🧠", cls: "woaki-empty-icon" });
        emptyState.createEl("h3", { text: "Ask about your notes" });
        emptyState.createEl("p", {
            text: "Ask questions about your memorized notes and get answers grounded in your knowledge.",
        });
    }

    private clearConversation(): void {
        this.abortController?.abort();
        this.isGenerating = false;
        this.conversationHistory = [];
        this.messagesEl.empty();
        this.showEmptyState();
        this.updateSendButton();
    }

    private async handleSend(): Promise<void> {
        const query = this.inputEl.value.trim();
        if (!query || this.isGenerating) return;

        this.inputEl.value = "";
        this.inputEl.style.height = "auto";

        await this.processMessage(query);
    }

    private async processMessage(query: string): Promise<void> {
        // Clear empty state
        const emptyState = this.messagesEl.querySelector(".woaki-empty-state");
        if (emptyState) emptyState.remove();

        // Add user message
        const userMsgId = Date.now().toString();
        const userEl = this.addUserMessage(query, userMsgId);
        this.conversationHistory.push({
            id: userMsgId,
            role: "user",
            content: query,
            element: userEl,
        });

        await this.generateResponse(query);
    }

    private async generateResponse(query: string): Promise<void> {
        // Start generating
        this.isGenerating = true;
        this.updateSendButton();

        // Create assistant message container
        const assistantMsgId = (Date.now() + 1).toString();
        const assistantEl = this.createAssistantMessage(assistantMsgId);
        const contentEl = assistantEl.querySelector(".woaki-message-content") as HTMLElement;
        const thinkingEl = contentEl.createDiv("woaki-thinking");
        thinkingEl.innerHTML = `<span></span><span></span><span></span>`;

        let fullResponse = "";
        let sources: RAGSource[] = [];

        this.abortController = new AbortController();

        try {
            // Convert internal history to API format (exclude current turn and assistant empty slots)
            const apiHistory: ChatMessage[] = this.conversationHistory
                .filter(m => m.id !== assistantMsgId && m.id !== (parseInt(assistantMsgId) - 1).toString())
                .map(m => ({ role: m.role, content: m.content }));

            await ragQueryStream(
                query,
                this.plugin.database,
                this.plugin.embeddingModel,
                this.plugin.llmAdapter,
                this.plugin.settings,
                apiHistory,
                (retrievedSources) => {
                    sources = retrievedSources;
                },
                (chunk) => {
                    if (thinkingEl.parentElement) {
                        thinkingEl.remove();
                    }
                    fullResponse += chunk;
                    contentEl.empty();
                    MarkdownRenderer.render(this.app, fullResponse, contentEl, "", this);
                    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
                },
                () => {
                    if (sources.length > 0) {
                        this.renderSources(assistantEl, sources);
                    }

                    this.conversationHistory.push({
                        id: assistantMsgId,
                        role: "assistant",
                        content: fullResponse,
                        element: assistantEl,
                    });

                    this.isGenerating = false;
                    this.updateSendButton();
                    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
                },
                this.abortController.signal,
            );
        } catch (e: unknown) {
            if (thinkingEl.parentElement) thinkingEl.remove();
            const errorMsg = e instanceof Error ? e.message : String(e);

            if (errorMsg.includes("abort") || this.abortController?.signal.aborted) {
                if (!fullResponse) {
                    contentEl.empty();
                    contentEl.createEl("em", { text: "Generation stopped.", cls: "woaki-message-cancelled" });
                }
            } else {
                contentEl.empty();
                const errorEl = contentEl.createDiv("woaki-message-error");
                errorEl.createEl("strong", { text: "Error: " });
                errorEl.createEl("span", { text: errorMsg });
            }

            this.isGenerating = false;
            this.updateSendButton();
        }
    }

    private addUserMessage(content: string, id: string): HTMLElement {
        const msgEl = this.messagesEl.createDiv("woaki-message woaki-message-user");
        msgEl.setAttribute("data-message-id", id);

        const bubbleEl = msgEl.createDiv("woaki-message-bubble");
        const contentEl = bubbleEl.createDiv({ text: content, cls: "woaki-message-content" });

        const editBtn = bubbleEl.createEl("button", {
            cls: "woaki-message-edit-btn clickable-icon",
            attr: { "aria-label": "Edit message" },
        });
        editBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg>`;
        editBtn.addEventListener("click", () => this.startEditing(id, contentEl, bubbleEl));

        this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
        return msgEl;
    }

    private startEditing(id: string, contentEl: HTMLElement, bubbleEl: HTMLElement): void {
        if (this.isGenerating) this.abortController?.abort();

        const message = this.conversationHistory.find(m => m.id === id);
        const originalText = message ? message.content : contentEl.innerText;

        contentEl.style.display = "none";
        bubbleEl.querySelector(".woaki-message-edit-btn")?.addClass("is-hidden");

        const editorWrapper = bubbleEl.createDiv("woaki-inline-editor");
        const textarea = editorWrapper.createEl("textarea", {
            cls: "woaki-inline-textarea",
        });
        textarea.value = originalText;
        textarea.focus();
        textarea.setSelectionRange(originalText.length, originalText.length);

        const actions = editorWrapper.createDiv("woaki-edit-actions");
        const saveBtn = actions.createEl("button", { text: "Save & Resend", cls: "mod-cta" });
        const cancelBtn = actions.createEl("button", { text: "Cancel" });

        const cleanup = () => {
            editorWrapper.remove();
            contentEl.style.display = "block";
            bubbleEl.querySelector(".woaki-message-edit-btn")?.removeClass("is-hidden");
        };

        saveBtn.addEventListener("click", () => {
            const newText = textarea.value.trim();
            if (newText && newText !== originalText) {
                this.resendFrom(id, newText);
            } else {
                cleanup();
            }
        });

        cancelBtn.addEventListener("click", cleanup);

        textarea.addEventListener("keydown", (e) => {
            if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                saveBtn.click();
            }
            if (e.key === "Escape") cleanup();
        });
    }

    private resendFrom(id: string, newText: string): void {
        // 1. Find the message in history
        const index = this.conversationHistory.findIndex(m => m.id === id);
        if (index === -1) return;

        // 2. Truncate history and remove subsequent DOM elements
        const itemsToRemove = this.conversationHistory.slice(index);
        for (const item of itemsToRemove) {
            item.element.remove();
        }
        this.conversationHistory = this.conversationHistory.slice(0, index);

        // 3. Process as a new message
        this.processMessage(newText);
    }

    private createAssistantMessage(id: string): HTMLElement {
        const msgEl = this.messagesEl.createDiv("woaki-message woaki-message-assistant");
        msgEl.setAttribute("data-message-id", id);
        const bubbleEl = msgEl.createDiv("woaki-message-bubble");
        bubbleEl.createDiv({ cls: "woaki-message-content" });
        return msgEl;
    }

    private renderSources(messageEl: HTMLElement, sources: RAGSource[]): void {
        const bubbleEl = messageEl.querySelector(".woaki-message-bubble");
        if (!bubbleEl) return;

        const sourcesEl = (bubbleEl as HTMLElement).createDiv("woaki-sources");
        sourcesEl.createEl("span", { text: "Sources", cls: "woaki-sources-label" });

        const sourceList = sourcesEl.createDiv("woaki-sources-list");
        for (const source of sources) {
            const sourceEl = sourceList.createDiv("woaki-source-item");

            const link = sourceEl.createEl("a", {
                text: source.title,
                cls: "woaki-source-link",
            });
            link.addEventListener("click", (e) => {
                e.preventDefault();
                this.app.workspace.openLinkText(source.filePath, "");
            });

            sourceEl.createEl("span", {
                text: ` ${Math.round(source.score * 100)}%`,
                cls: "woaki-source-score",
            });
        }
    }

    private updateSendButton(): void {
        if (this.isGenerating) {
            this.sendBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>`;
            this.sendBtn.setAttribute("aria-label", "Stop generating");
            this.sendBtn.onclick = () => {
                this.abortController?.abort();
            };
        } else {
            this.sendBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>`;
            this.sendBtn.setAttribute("aria-label", "Send message");
            this.sendBtn.onclick = () => this.handleSend();
        }
    }
}
