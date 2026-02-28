import { CONVERSATIONS_DIR } from "../constants";
import type WoakiPlugin from "../main";

export interface SerializedMessage {
	id: string;
	role: "user" | "assistant";
	content: string;
	timestamp: number;
	sources?: Array<{ title: string; filePath: string; score: number; excerpt: string }>;
	model?: string;
}

export interface Conversation {
	id: string;
	title: string;
	messages: SerializedMessage[];
	createdAt: number;
	updatedAt: number;
}

interface ConversationIndex {
	conversations: Array<{ id: string; title: string; updatedAt: number }>;
}

export class ConversationStore {
	private plugin: WoakiPlugin;

	constructor(plugin: WoakiPlugin) {
		this.plugin = plugin;
	}

	private get baseDir(): string {
		return `${this.plugin.manifest.dir}/${CONVERSATIONS_DIR}`;
	}

	private get indexPath(): string {
		return `${this.baseDir}/index.json`;
	}

	private conversationPath(id: string): string {
		return `${this.baseDir}/${id}.json`;
	}

	async ensureDir(): Promise<void> {
		const adapter = this.plugin.app.vault.adapter;
		if (!(await adapter.exists(this.baseDir))) {
			await adapter.mkdir(this.baseDir);
		}
	}

	async save(conversation: Conversation): Promise<void> {
		await this.ensureDir();
		const adapter = this.plugin.app.vault.adapter;
		conversation.updatedAt = Date.now();
		await adapter.write(this.conversationPath(conversation.id), JSON.stringify(conversation));
		await this.updateIndex(conversation);
	}

	async load(id: string): Promise<Conversation | null> {
		const adapter = this.plugin.app.vault.adapter;
		const path = this.conversationPath(id);
		if (!(await adapter.exists(path))) return null;
		try {
			const data = await adapter.read(path);
			return JSON.parse(data) as Conversation;
		} catch {
			return null;
		}
	}

	async list(): Promise<Array<{ id: string; title: string; updatedAt: number }>> {
		const adapter = this.plugin.app.vault.adapter;
		if (!(await adapter.exists(this.indexPath))) return [];
		try {
			const data = await adapter.read(this.indexPath);
			const index = JSON.parse(data) as ConversationIndex;
			return index.conversations.sort((a, b) => b.updatedAt - a.updatedAt);
		} catch {
			return [];
		}
	}

	async delete(id: string): Promise<void> {
		const adapter = this.plugin.app.vault.adapter;
		const path = this.conversationPath(id);
		if (await adapter.exists(path)) {
			await adapter.remove(path);
		}
		await this.removeFromIndex(id);
	}

	private async updateIndex(conversation: Conversation): Promise<void> {
		const adapter = this.plugin.app.vault.adapter;
		let index: ConversationIndex = { conversations: [] };
		if (await adapter.exists(this.indexPath)) {
			try {
				const data = await adapter.read(this.indexPath);
				index = JSON.parse(data) as ConversationIndex;
			} catch { /* start fresh */ }
		}

		// Update or add entry
		const existing = index.conversations.findIndex(c => c.id === conversation.id);
		const entry = { id: conversation.id, title: conversation.title, updatedAt: conversation.updatedAt };
		if (existing >= 0) {
			index.conversations[existing] = entry;
		} else {
			index.conversations.push(entry);
		}

		await adapter.write(this.indexPath, JSON.stringify(index));
	}

	private async removeFromIndex(id: string): Promise<void> {
		const adapter = this.plugin.app.vault.adapter;
		if (!(await adapter.exists(this.indexPath))) return;
		try {
			const data = await adapter.read(this.indexPath);
			const index = JSON.parse(data) as ConversationIndex;
			index.conversations = index.conversations.filter(c => c.id !== id);
			await adapter.write(this.indexPath, JSON.stringify(index));
		} catch { /* ignore */ }
	}

	generateId(): string {
		return Date.now().toString(36) + Math.random().toString(36).substring(2, 8);
	}
}
