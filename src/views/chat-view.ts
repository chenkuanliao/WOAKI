import { ItemView, MarkdownRenderer, setIcon, WorkspaceLeaf } from "obsidian";
import { CHAT_VIEW_TYPE, PLUGIN_DISPLAY_NAME } from "../constants";
import type WoakiPlugin from "../main";
import type { ChatMessage } from "../core/llm-adapter";
import type { RAGSource, RAGOptions } from "../core/rag";
import { ragQueryStream } from "../core/rag";
import { WoakiError } from "../utils/errors";
import { getWoakiId, isNoteMemorized } from "../utils/frontmatter";
import type { Conversation, SerializedMessage } from "../core/conversation-store";
import type { StarredModel } from "../settings";

interface MessageInternal {
    id: string;
    role: "user" | "assistant";
    content: string;
    element: HTMLElement;
    sources?: RAGSource[];
    model?: string;
}

export class WoakiChatView extends ItemView {
    plugin: WoakiPlugin;
    private messagesEl: HTMLElement;
    private inputEl: HTMLTextAreaElement;
    private sendBtn: HTMLButtonElement;
    private conversationHistory: MessageInternal[] = [];
    private isGenerating = false;
    private abortController: AbortController | null = null;
    private autocompleteEl: HTMLElement | null = null;
    private autocompleteIndex = -1;
    private autocompleteItems: string[] = [];
    private currentConversationId: string | null = null;
    private conversationListEl: HTMLElement | null = null;
    private modelBadgeTextEl: HTMLElement | null = null;
    private modelDropdownEl: HTMLElement | null = null;

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

        // Try to load most recent conversation
        const recent = await this.plugin.conversationStore.list();
        if (recent.length > 0) {
            await this.loadConversation(recent[0]!.id);
        } else {
            this.showEmptyState();
        }
    }

    async onClose(): Promise<void> {
        this.abortController?.abort();
        await this.saveCurrentConversation();
    }

    private buildHeader(container: HTMLElement): void {
        const header = container.createDiv("woaki-chat-header");

        const titleEl = header.createDiv("woaki-chat-title");
        titleEl.createEl("span", { text: PLUGIN_DISPLAY_NAME, cls: "woaki-chat-title-text" });

        // Clickable model selector
        const modelSelector = titleEl.createDiv("woaki-model-selector");
        const modelBadge = modelSelector.createEl("button", {
            cls: "woaki-model-badge-btn",
        });
        const modelText = modelBadge.createSpan({
            text: this.plugin.llmAdapter.getActiveModel() || "No model",
            cls: "woaki-model-badge-text",
        });
        modelBadge.createSpan({ text: "▾", cls: "woaki-model-badge-chevron" });
        modelBadge.setAttribute("title", `Provider: ${this.plugin.llmAdapter.getProviderName()}`);

        this.modelBadgeTextEl = modelText;

        modelBadge.addEventListener("click", (e) => {
            e.stopPropagation();
            void this.toggleModelDropdown(modelSelector);
        });

        const actions = header.createDiv("woaki-chat-actions");

        // Conversation history button
        const historyBtn = actions.createEl("button", {
            cls: "woaki-chat-action-btn clickable-icon",
            attr: { "aria-label": "Conversation history" },
        });
        setIcon(historyBtn, "history");
        historyBtn.addEventListener("click", () => void this.toggleConversationList());

        const clearBtn = actions.createEl("button", {
            cls: "woaki-chat-action-btn clickable-icon",
            attr: { "aria-label": "New conversation" },
        });
        setIcon(clearBtn, "plus");
        clearBtn.addEventListener("click", () => void this.newConversation());
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
        setIcon(this.sendBtn, "send");

        // Auto-resize textarea and handle autocomplete
        this.inputEl.addEventListener("input", () => {
            // eslint-disable-next-line obsidianmd/no-static-styles-assignment -- dynamic height for auto-resize
            this.inputEl.style.height = "auto";
            this.inputEl.style.height = Math.min(this.inputEl.scrollHeight, 150) + "px";
            this.handleAutocomplete();
        });

        // Enter to send, Shift+Enter for newline, arrow keys for autocomplete
        this.inputEl.addEventListener("keydown", (e) => {
            if (this.autocompleteEl) {
                if (e.key === "ArrowDown") {
                    e.preventDefault();
                    this.navigateAutocomplete(1);
                    return;
                }
                if (e.key === "ArrowUp") {
                    e.preventDefault();
                    this.navigateAutocomplete(-1);
                    return;
                }
                if (e.key === "Enter") {
                    e.preventDefault();
                    this.selectAutocomplete();
                    return;
                }
                if (e.key === "Escape") {
                    this.dismissAutocomplete();
                    return;
                }
            }

            if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void this.handleSend();
            }
        });

        this.sendBtn.addEventListener("click", () => void this.handleSend());
    }

    private handleAutocomplete(): void {
        const val = this.inputEl.value;
        const cursor = this.inputEl.selectionStart ?? val.length;
        const beforeCursor = val.substring(0, cursor);

        // Check if we're right after @ with optional word chars (no space after @)
        const atMatch = beforeCursor.match(/@(\w*)$/);
        if (!atMatch) {
            this.dismissAutocomplete();
            return;
        }

        const partial = atMatch[1]!.toLowerCase();
        const allFiles = this.app.vault.getMarkdownFiles();
        const memorizedFiles = allFiles.filter(f => isNoteMemorized(this.app, f));
        const files = memorizedFiles
            .filter(f => f.basename.toLowerCase().includes(partial))
            .slice(0, 8);

        if (files.length === 0) {
            this.dismissAutocomplete();
            return;
        }

        this.autocompleteItems = files.map(f => f.basename);
        this.autocompleteIndex = 0;
        this.renderAutocomplete();
    }

    private renderAutocomplete(): void {
        this.dismissAutocomplete();

        this.autocompleteEl = document.createElement("div");
        this.autocompleteEl.addClass("woaki-autocomplete-dropdown");
        for (let i = 0; i < this.autocompleteItems.length; i++) {
            const item = this.autocompleteEl.createDiv({
                cls: "woaki-autocomplete-item" + (i === this.autocompleteIndex ? " is-selected" : ""),
            });
            item.createSpan({ text: "📄", cls: "woaki-autocomplete-icon" });
            item.createSpan({ text: this.autocompleteItems[i], cls: "woaki-autocomplete-name" });
            item.addEventListener("mousedown", (e) => {
                e.preventDefault();
                this.autocompleteIndex = i;
                this.selectAutocomplete();
            });
        }

        // Position above the input wrapper
        const wrapper = this.inputEl.closest(".woaki-chat-input-wrapper");
        if (wrapper) {
            (wrapper as HTMLElement).appendChild(this.autocompleteEl);
        }
    }

    private navigateAutocomplete(direction: number): void {
        if (!this.autocompleteEl) return;
        this.autocompleteIndex = Math.max(0, Math.min(this.autocompleteItems.length - 1, this.autocompleteIndex + direction));
        const items = this.autocompleteEl.querySelectorAll(".woaki-autocomplete-item");
        items.forEach((el, i) => {
            el.toggleClass("is-selected", i === this.autocompleteIndex);
        });
    }

    private selectAutocomplete(): void {
        if (!this.autocompleteEl || this.autocompleteIndex < 0) return;
        const name = this.autocompleteItems[this.autocompleteIndex];
        if (!name) return;

        const val = this.inputEl.value;
        const cursor = this.inputEl.selectionStart ?? val.length;
        const beforeCursor = val.substring(0, cursor);
        const afterCursor = val.substring(cursor);

        // Replace @partial with @[[Name]]
        const atMatch = beforeCursor.match(/@(\w*)$/);
        if (atMatch) {
            const start = atMatch.index!;
            this.inputEl.value = beforeCursor.substring(0, start) + `@[[${name}]] ` + afterCursor;
            const newCursor = start + name.length + 6; // @[[ + name + ]] + space
            this.inputEl.setSelectionRange(newCursor, newCursor);
        }

        this.dismissAutocomplete();
        this.inputEl.focus();
    }

    private dismissAutocomplete(): void {
        if (this.autocompleteEl) {
            this.autocompleteEl.remove();
            this.autocompleteEl = null;
        }
        this.autocompleteIndex = -1;
        this.autocompleteItems = [];
    }

    private showEmptyState(): void {
        const emptyState = this.messagesEl.createDiv("woaki-empty-state");
        emptyState.createEl("div", { text: "🧠", cls: "woaki-empty-icon" });
        emptyState.createEl("h3", { text: "Ask about your notes" });
        emptyState.createEl("p", {
            text: "Ask questions about your memorized notes and get answers grounded in your knowledge.",
        });
    }

    private async newConversation(): Promise<void> {
        this.abortController?.abort();
        await this.saveCurrentConversation();
        this.isGenerating = false;
        this.conversationHistory = [];
        this.currentConversationId = null;
        this.messagesEl.empty();
        this.showEmptyState();
        this.updateSendButton();
    }

    private async handleSend(): Promise<void> {
        const query = this.inputEl.value.trim();
        if (!query || this.isGenerating) return;

        this.inputEl.value = "";
        // eslint-disable-next-line obsidianmd/no-static-styles-assignment -- reset dynamic height
        this.inputEl.style.height = "auto";

        await this.processMessage(query);
    }

    /**
     * Extract #tag patterns from input. Returns cleaned query and tag list.
     */
    private extractTags(input: string): { cleanQuery: string; tags: string[] } {
        const tagRegex = /#([\w-]+)/g;
        const tags: string[] = [];
        let match;
        while ((match = tagRegex.exec(input)) !== null) {
            tags.push(`#${match[1]}`);
        }
        const cleanQuery = input.replace(/#[\w-]+/g, "").replace(/\s+/g, " ").trim();
        return { cleanQuery, tags };
    }

    /**
     * Extract @[[NoteName]] references from input. Returns cleaned query and note IDs.
     */
    private parseNoteReferences(input: string): { cleanQuery: string; noteIds: string[] } {
        // Support @[[Note Name]] and @[Note Name]
        const noteRefRegex = /@\[\[?([^\]]+?)\]?\]/g;
        const noteIds: string[] = [];
        let match;
        while ((match = noteRefRegex.exec(input)) !== null) {
            const name = match[1]!.trim();
            const file = this.app.metadataCache.getFirstLinkpathDest(name, "");
            if (file) {
                const id = getWoakiId(this.app, file);
                if (id) noteIds.push(id);
            }
        }
        const cleanQuery = input.replace(/@\[\[?[^\]]+?\]?\]/g, "").replace(/\s+/g, " ").trim();
        return { cleanQuery, noteIds };
    }

    private async processMessage(query: string): Promise<void> {
        // Clear empty state
        const emptyState = this.messagesEl.querySelector(".woaki-empty-state");
        if (emptyState) emptyState.remove();

        // Add user message (show original with tags/refs)
        const userMsgId = Date.now().toString();
        const userEl = this.addUserMessage(query, userMsgId);
        this.conversationHistory.push({
            id: userMsgId,
            role: "user",
            content: query,
            element: userEl,
        });

        // Parse tags and note references
        const { cleanQuery: queryAfterTags, tags } = this.extractTags(query);
        const { cleanQuery: cleanQuery, noteIds } = this.parseNoteReferences(queryAfterTags);

        const ragOptions: RAGOptions = {};
        if (tags.length > 0) ragOptions.tagFilter = tags;
        if (noteIds.length > 0) ragOptions.forcedNoteIds = noteIds;

        await this.generateResponse(cleanQuery || query, ragOptions);
    }

    private async generateResponse(query: string, ragOptions: RAGOptions = {}): Promise<void> {
        // Start generating
        this.isGenerating = true;
        this.updateSendButton();

        // Create assistant message container
        const assistantMsgId = (Date.now() + 1).toString();
        const assistantEl = this.createAssistantMessage(assistantMsgId);
        const contentEl = assistantEl.querySelector(".woaki-message-content") as HTMLElement;
        const thinkingEl = contentEl.createDiv("woaki-thinking");
        thinkingEl.createSpan();
        thinkingEl.createSpan();
        thinkingEl.createSpan();

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
                    void MarkdownRenderer.render(this.app, fullResponse, contentEl, "", this);
                    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
                },
                () => {
                    const activeModel = this.plugin.llmAdapter.getActiveModel();
                    if (sources.length > 0) {
                        this.renderSources(assistantEl, sources, activeModel);
                    }

                    this.conversationHistory.push({
                        id: assistantMsgId,
                        role: "assistant",
                        content: fullResponse,
                        element: assistantEl,
                        sources,
                        model: activeModel,
                    });

                    this.isGenerating = false;
                    this.updateSendButton();
                    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;

                    // Auto-save conversation
                    void this.saveCurrentConversation();
                },
                this.abortController.signal,
                ragOptions,
            );
        } catch (e: unknown) {
            if (thinkingEl.parentElement) thinkingEl.remove();

            const isAbort = this.abortController?.signal.aborted ||
                (e instanceof Error && e.message.includes("abort"));

            if (isAbort) {
                if (!fullResponse) {
                    contentEl.empty();
                    contentEl.createEl("em", { text: "Generation stopped.", cls: "woaki-message-cancelled" });
                }
            } else {
                contentEl.empty();
                const errorEl = contentEl.createDiv("woaki-message-error");

                const isWoakiError = e instanceof WoakiError;
                const errorMsg = isWoakiError ? e.userMessage : (e instanceof Error ? e.message : String(e));

                errorEl.createEl("strong", { text: "Error: " });
                errorEl.createEl("span", { text: errorMsg });

                const errorActions = errorEl.createDiv("woaki-error-actions");

                if (isWoakiError && e.retryable) {
                    const retryBtn = errorActions.createEl("button", {
                        text: "Retry",
                        cls: "woaki-error-btn mod-cta",
                    });
                    retryBtn.addEventListener("click", () => {
                        assistantEl.remove();
                        void this.generateResponse(query);
                    });
                }

                if (isWoakiError && !e.retryable && errorMsg.includes("API key")) {
                    const settingsBtn = errorActions.createEl("button", {
                        text: "Check settings",
                        cls: "woaki-error-btn",
                    });
                    settingsBtn.addEventListener("click", () => {
                        // Open settings tab
                        // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
                        (this.app as any).setting?.open?.();
                    });
                }
            }

            this.isGenerating = false;
            this.updateSendButton();
        }
    }

    private renderUserContent(content: string, contentEl: HTMLElement): void {
        // Render @[[Note]] as clickable pills, rest as text
        const parts = content.split(/(@\[\[[^\]]+\]\])/g);
        for (const part of parts) {
            const refMatch = part.match(/^@\[\[([^\]]+)\]\]$/);
            if (refMatch) {
                const name = refMatch[1]!;
                const pill = contentEl.createEl("span", { text: name, cls: "woaki-note-ref" });
                pill.addEventListener("click", () => {
                    void this.app.workspace.openLinkText(name, "");
                });
            } else if (part) {
                contentEl.appendText(part);
            }
        }
    }

    private addUserMessage(content: string, id: string): HTMLElement {
        const msgEl = this.messagesEl.createDiv("woaki-message woaki-message-user");
        msgEl.setAttribute("data-message-id", id);

        const bubbleEl = msgEl.createDiv("woaki-message-bubble");
        const contentEl = bubbleEl.createDiv({ cls: "woaki-message-content" });
        this.renderUserContent(content, contentEl);

        const editBtn = bubbleEl.createEl("button", {
            cls: "woaki-message-edit-btn clickable-icon",
            attr: { "aria-label": "Edit message" },
        });
        setIcon(editBtn, "pencil");
        editBtn.addEventListener("click", () => this.startEditing(id, contentEl, bubbleEl));

        this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
        return msgEl;
    }

    private startEditing(id: string, contentEl: HTMLElement, bubbleEl: HTMLElement): void {
        if (this.isGenerating) this.abortController?.abort();

        const message = this.conversationHistory.find(m => m.id === id);
        const originalText = message ? message.content : contentEl.innerText;

        // eslint-disable-next-line obsidianmd/no-static-styles-assignment -- toggle inline editor visibility
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
        const saveBtn = actions.createEl("button", { text: "Save & resend", cls: "mod-cta" });
        const cancelBtn = actions.createEl("button", { text: "Cancel" });

        const cleanup = () => {
            editorWrapper.remove();
            // eslint-disable-next-line obsidianmd/no-static-styles-assignment -- toggle inline editor visibility
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
        void this.processMessage(newText);
    }

    private createAssistantMessage(id: string): HTMLElement {
        const msgEl = this.messagesEl.createDiv("woaki-message woaki-message-assistant");
        msgEl.setAttribute("data-message-id", id);
        const bubbleEl = msgEl.createDiv("woaki-message-bubble");
        bubbleEl.createDiv({ cls: "woaki-message-content" });

        // Copy button (appears on hover)
        const copyBtn = bubbleEl.createEl("button", {
            cls: "woaki-copy-btn clickable-icon",
            attr: { "aria-label": "Copy response" },
        });
        setIcon(copyBtn, "copy");
        copyBtn.addEventListener("click", () => {
            const contentEl = bubbleEl.querySelector(".woaki-message-content") as HTMLElement;
            if (contentEl) {
                void navigator.clipboard.writeText(contentEl.innerText);
                setIcon(copyBtn, "check");
                setTimeout(() => {
                    setIcon(copyBtn, "copy");
                }, 1500);
            }
        });

        return msgEl;
    }

    private renderSources(messageEl: HTMLElement, sources: RAGSource[], model?: string): void {
        const bubbleEl = messageEl.querySelector(".woaki-message-bubble");
        if (!bubbleEl) return;

        const sourcesEl = (bubbleEl as HTMLElement).createDiv("woaki-sources");
        const labelText = model ? `References (${model})` : "References";
        sourcesEl.createDiv({ text: labelText, cls: "woaki-sources-label" });

        const sourceList = sourcesEl.createDiv("woaki-sources-list");
        for (const source of sources) {
            const sourceEl = sourceList.createDiv("woaki-source-item");

            const link = sourceEl.createEl("a", {
                text: source.title,
                cls: "woaki-source-link",
            });
            link.addEventListener("click", (e) => {
                e.preventDefault();
                void this.app.workspace.openLinkText(source.filePath, "");
            });

            if (source.score > 0) {
                sourceEl.createEl("span", {
                    text: `${Math.round(source.score * 100)}%`,
                    cls: "woaki-source-score",
                });
            }
        }
    }

    private async saveCurrentConversation(): Promise<void> {
        if (this.conversationHistory.length === 0) return;

        const store = this.plugin.conversationStore;
        const id = this.currentConversationId ?? store.generateId();
        const firstUserMsg = this.conversationHistory.find(m => m.role === "user");
        const title = firstUserMsg
            ? firstUserMsg.content.substring(0, 50) + (firstUserMsg.content.length > 50 ? "..." : "")
            : "Untitled";

        const messages: SerializedMessage[] = this.conversationHistory.map(m => ({
            id: m.id,
            role: m.role,
            content: m.content,
            timestamp: parseInt(m.id) || Date.now(),
            ...(m.sources && m.sources.length > 0 ? {
                sources: m.sources.map(s => ({
                    title: s.title, filePath: s.filePath, score: s.score, excerpt: s.excerpt,
                }))
            } : {}),
            model: m.model,
        }));

        const conversation: Conversation = {
            id,
            title,
            messages,
            createdAt: parseInt(this.conversationHistory[0]?.id ?? "0") || Date.now(),
            updatedAt: Date.now(),
        };

        await store.save(conversation);
        this.currentConversationId = id;
    }

    private async loadConversation(id: string): Promise<void> {
        const conversation = await this.plugin.conversationStore.load(id);
        if (!conversation || conversation.messages.length === 0) {
            this.showEmptyState();
            return;
        }

        this.conversationHistory = [];
        this.messagesEl.empty();
        this.currentConversationId = id;

        for (const msg of conversation.messages) {
            if (msg.role === "user") {
                const el = this.addUserMessage(msg.content, msg.id);
                this.conversationHistory.push({ id: msg.id, role: "user", content: msg.content, element: el });
            } else {
                const el = this.createAssistantMessage(msg.id);
                const contentEl = el.querySelector(".woaki-message-content") as HTMLElement;
                void MarkdownRenderer.render(this.app, msg.content, contentEl, "", this);

                // Restore sources if stored
                const restoredSources: RAGSource[] | undefined = msg.sources?.map(s => ({
                    title: s.title, filePath: s.filePath, score: s.score, excerpt: s.excerpt,
                }));
                if (restoredSources && restoredSources.length > 0) {
                    this.renderSources(el, restoredSources, msg.model);
                }

                this.conversationHistory.push({ id: msg.id, role: "assistant", content: msg.content, element: el, sources: restoredSources, model: msg.model });
            }
        }

        this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
    }

    private async toggleConversationList(): Promise<void> {
        if (this.conversationListEl) {
            this.conversationListEl.remove();
            this.conversationListEl = null;
            return;
        }

        const conversations = await this.plugin.conversationStore.list();
        if (conversations.length === 0) return;

        this.conversationListEl = this.contentEl.createDiv("woaki-conversation-list");
        const header = this.conversationListEl.createDiv("woaki-conversation-list-header");
        header.createEl("span", { text: "History" });

        for (const conv of conversations) {
            const item = this.conversationListEl.createDiv("woaki-conversation-item");
            if (conv.id === this.currentConversationId) {
                item.addClass("is-active");
            }

            const info = item.createDiv("woaki-conversation-info");
            info.createEl("span", { text: conv.title, cls: "woaki-conversation-title" });
            info.createEl("span", {
                text: new Date(conv.updatedAt).toLocaleDateString(),
                cls: "woaki-conversation-date",
            });

            info.addEventListener("click", () => {
                void this.saveCurrentConversation().then(() =>
                    this.loadConversation(conv.id)
                ).then(() => {
                    this.conversationListEl?.remove();
                    this.conversationListEl = null;
                });
            });

            const deleteBtn = item.createEl("button", {
                cls: "woaki-conversation-delete clickable-icon",
                attr: { "aria-label": "Delete conversation" },
            });
            setIcon(deleteBtn, "x");
            deleteBtn.addEventListener("click", (e) => {
                e.stopPropagation();
                void this.plugin.conversationStore.delete(conv.id).then(() => {
                    if (conv.id === this.currentConversationId) {
                        this.currentConversationId = null;
                        this.conversationHistory = [];
                        this.messagesEl.empty();
                        this.showEmptyState();
                    }
                    item.remove();
                    // Remove list if empty
                    if (this.conversationListEl && this.conversationListEl.querySelectorAll(".woaki-conversation-item").length === 0) {
                        this.conversationListEl.remove();
                        this.conversationListEl = null;
                    }
                });
            });
        }
    }

    private updateSendButton(): void {
        if (this.isGenerating) {
            setIcon(this.sendBtn, "square");
            this.sendBtn.setAttribute("aria-label", "Stop generating");
            this.sendBtn.onclick = () => {
                this.abortController?.abort();
            };
        } else {
            setIcon(this.sendBtn, "send");
            this.sendBtn.setAttribute("aria-label", "Send message");
            this.sendBtn.onclick = () => this.handleSend();
        }
    }

    private async toggleModelDropdown(container: HTMLElement): Promise<void> {
        // If already open, dismiss
        if (this.modelDropdownEl) {
            this.dismissModelDropdown();
            return;
        }

        const dropdown = container.createDiv("woaki-model-dropdown");
        this.modelDropdownEl = dropdown;

        // Dismiss on click outside
        const onClickOutside = (e: MouseEvent) => {
            if (!container.contains(e.target as Node)) {
                this.dismissModelDropdown();
                document.removeEventListener("click", onClickOutside);
            }
        };
        setTimeout(() => document.addEventListener("click", onClickOutside), 0);

        // Read starred models from settings
        const starred: StarredModel[] = this.plugin.settings.starredModels ?? [];

        if (starred.length === 0) {
            dropdown.createDiv({ text: "No starred models. Configure in Settings → LLM Providers.", cls: "woaki-model-dropdown-empty" });
            return;
        }

        // Group by provider
        const groups = new Map<string, StarredModel[]>();
        for (const s of starred) {
            const existing = groups.get(s.provider) ?? [];
            existing.push(s);
            groups.set(s.provider, existing);
        }

        const activeModel = this.plugin.llmAdapter.getActiveModel();
        const activeProvider = this.plugin.llmAdapter.getProviderName();

        const providerLabels: Record<string, string> = {
            openai: "OpenAI",
            anthropic: "Anthropic",
            ollama: "Ollama",
        };

        const listEl = dropdown.createDiv("woaki-model-dropdown-list");

        for (const [provider, models] of groups) {
            // Provider header
            listEl.createDiv({
                text: providerLabels[provider] ?? provider,
                cls: "woaki-model-dropdown-provider",
            });

            for (const starred of models) {
                const isActive = starred.model === activeModel && providerLabels[provider] === activeProvider;
                const item = listEl.createDiv({
                    cls: "woaki-model-dropdown-item" + (isActive ? " is-active" : ""),
                });
                item.createSpan({ text: starred.model });
                if (isActive) {
                    item.createSpan({ text: "✓", cls: "woaki-model-dropdown-check" });
                }
                item.addEventListener("click", (e) => {
                    e.stopPropagation();
                    const providerConfig = this.plugin.settings.providers[starred.provider];
                    const providerName = providerLabels[starred.provider] ?? starred.provider;
                    this.plugin.llmAdapter.setProviderOverride(
                        providerName,
                        starred.model,
                        providerConfig.apiKey,
                        providerConfig.baseUrl,
                    );
                    if (this.modelBadgeTextEl) {
                        this.modelBadgeTextEl.setText(starred.model);
                    }
                    this.dismissModelDropdown();
                });
            }
        }
    }

    private dismissModelDropdown(): void {
        if (this.modelDropdownEl) {
            this.modelDropdownEl.remove();
            this.modelDropdownEl = null;
        }
    }
}
