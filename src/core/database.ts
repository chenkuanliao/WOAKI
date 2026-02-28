import { create, insert, remove, search, count, save, load } from "@orama/orama";
import type { AnyOrama, Results, RawData } from "@orama/orama";
import { DB_FILENAME, EMBEDDING_DIMENSIONS } from "../constants";
import type WoakiPlugin from "../main";

export interface ChunkDocument {
	noteId: string;
	filePath: string;
	chunkIndex: number;
	chunkHash: string;
	title: string;
	content: string;
	tags: string;
	embedding: number[];
	memorizedAt: number;
	updatedAt: number;
}

export interface SearchResult {
	id: string;
	score: number;
	document: ChunkDocument;
}

const SCHEMA = {
	noteId: "string" as const,
	filePath: "string" as const,
	chunkIndex: "number" as const,
	chunkHash: "string" as const,
	title: "string" as const,
	content: "string" as const,
	tags: "string" as const,
	embedding: `vector[${EMBEDDING_DIMENSIONS}]` as const,
	memorizedAt: "number" as const,
	updatedAt: "number" as const,
};

export class WoakiDatabase {
	private db: AnyOrama | null = null;
	private plugin: WoakiPlugin;
	private dirty = false;

	constructor(plugin: WoakiPlugin) {
		this.plugin = plugin;
	}

	private get dbPath(): string {
		return `${this.plugin.manifest.dir}/${DB_FILENAME}`;
	}

	async initialize(): Promise<void> {
		try {
			const exists = await this.plugin.app.vault.adapter.exists(this.dbPath);
			if (exists) {
				const data = await this.plugin.app.vault.adapter.read(this.dbPath);
				const raw = JSON.parse(data) as RawData;
				this.db = create({ schema: SCHEMA });
				load(this.db, raw);
				return;
			}
		} catch (e) {
			console.warn("WOAKI: Failed to load database, creating fresh:", e);
		}

		this.db = create({ schema: SCHEMA });
	}

	async persist(): Promise<void> {
		if (!this.db || !this.dirty) return;
		const raw = save(this.db);
		const json = JSON.stringify(raw);
		await this.plugin.app.vault.adapter.write(this.dbPath, json);
		this.dirty = false;
	}

	async insertChunk(doc: ChunkDocument): Promise<void> {
		if (!this.db) return;
		await insert(this.db, doc);
		this.dirty = true;
	}

	async removeNote(noteId: string): Promise<void> {
		if (!this.db) return;
		const results = await this.searchByField("noteId", noteId);
		for (const hit of results) {
			await remove(this.db, hit.id);
		}
		if (results.length > 0) this.dirty = true;
	}

	async removeByFilePath(filePath: string): Promise<void> {
		if (!this.db) return;
		const results = await this.searchByField("filePath", filePath);
		for (const hit of results) {
			await remove(this.db, hit.id);
		}
		if (results.length > 0) this.dirty = true;
	}

	async updateFilePath(oldPath: string, newPath: string): Promise<void> {
		if (!this.db) return;
		const results = await this.searchByField("filePath", oldPath);
		if (results.length === 0) return;

		// Remove old and re-insert with new path
		for (const hit of results) {
			await remove(this.db, hit.id);
			const doc = hit.document as ChunkDocument;
			await insert(this.db, { ...doc, filePath: newPath });
		}
		this.dirty = true;
	}

	async removeChunksBeyond(noteId: string, maxIndex: number): Promise<void> {
		if (!this.db) return;
		const results = await this.searchByField("noteId", noteId);
		let removed = false;
		for (const hit of results) {
			const doc = hit.document as ChunkDocument;
			if (doc.chunkIndex >= maxIndex) {
				await remove(this.db, hit.id);
				removed = true;
			}
		}
		if (removed) this.dirty = true;
	}

	async getChunk(noteId: string, chunkIndex: number): Promise<ChunkDocument | null> {
		if (!this.db) return null;
		const results = await this.searchByField("noteId", noteId);
		for (const hit of results) {
			const doc = hit.document as ChunkDocument;
			if (doc.chunkIndex === chunkIndex) {
				return doc;
			}
		}
		return null;
	}

	async vectorSearch(queryEmbedding: number[], limit = 10, tagFilter?: string[]): Promise<SearchResult[]> {
		if (!this.db) return [];
		const fetchLimit = tagFilter && tagFilter.length > 0 ? limit * 3 : limit;
		const results = await search(this.db, {
			mode: "vector",
			vector: {
				value: queryEmbedding,
				property: "embedding",
			},
			limit: fetchLimit,
			similarity: 0.5,
		}) as Results<ChunkDocument>;

		let hits = results.hits.map(hit => ({
			id: hit.id,
			score: hit.score,
			document: hit.document,
		}));

		if (tagFilter && tagFilter.length > 0) {
			hits = hits.filter(r => tagFilter.every(t => r.document.tags.includes(t)));
			hits = hits.slice(0, limit);
		}

		return hits;
	}

	async hybridSearch(query: string, queryEmbedding: number[], limit = 10, tagFilter?: string[]): Promise<SearchResult[]> {
		if (!this.db) return [];
		const fetchLimit = tagFilter && tagFilter.length > 0 ? limit * 3 : limit;
		const results = await search(this.db, {
			mode: "hybrid",
			term: query,
			vector: {
				value: queryEmbedding,
				property: "embedding",
			},
			properties: ["content", "title"],
			limit: fetchLimit,
			similarity: 0.5,
		}) as Results<ChunkDocument>;

		let hits = results.hits.map(hit => ({
			id: hit.id,
			score: hit.score,
			document: hit.document,
		}));

		if (tagFilter && tagFilter.length > 0) {
			hits = hits.filter(r => tagFilter.every(t => r.document.tags.includes(t)));
			hits = hits.slice(0, limit);
		}

		return hits;
	}

	async getChunksByNoteId(noteId: string): Promise<SearchResult[]> {
		const hits = await this.searchByField("noteId", noteId);
		return hits.map(hit => ({
			id: hit.id,
			score: 1.0, // forced inclusion, max score
			document: hit.document,
		}));
	}

	getDocumentCount(): number {
		if (!this.db) return 0;
		return count(this.db) as number;
	}

	async getDbFileSize(): Promise<number> {
		try {
			const stat = await this.plugin.app.vault.adapter.stat(this.dbPath);
			return stat?.size ?? 0;
		} catch {
			return 0;
		}
	}

	async getNoteStats(): Promise<Map<string, { chunkCount: number; updatedAt: number; tags: string; filePath: string; title: string }>> {
		if (!this.db) return new Map();
		const results = await search(this.db, {
			term: "",
			limit: 100000,
		}) as Results<ChunkDocument>;

		const stats = new Map<string, { chunkCount: number; updatedAt: number; tags: string; filePath: string; title: string }>();
		for (const hit of results.hits) {
			const doc = hit.document;
			const existing = stats.get(doc.noteId);
			if (existing) {
				existing.chunkCount++;
				if (doc.updatedAt > existing.updatedAt) {
					existing.updatedAt = doc.updatedAt;
				}
			} else {
				stats.set(doc.noteId, {
					chunkCount: 1,
					updatedAt: doc.updatedAt,
					tags: doc.tags,
					filePath: doc.filePath,
					title: doc.title,
				});
			}
		}
		return stats;
	}

	async clear(): Promise<void> {
		this.db = create({ schema: SCHEMA });
		this.dirty = true;
	}

	async getNoteIds(): Promise<Set<string>> {
		if (!this.db) return new Set();
		const results = await search(this.db, {
			term: "",
			limit: 100000,
		}) as Results<ChunkDocument>;

		const ids = new Set<string>();
		for (const hit of results.hits) {
			ids.add(hit.document.noteId);
		}
		return ids;
	}

	private async searchByField(field: string, value: string): Promise<Array<{ id: string; document: ChunkDocument }>> {
		if (!this.db) return [];

		try {
			// Orama's `where` clause doesn't support `string`-type fields
			// (only `enum`/`number`). Fetch all docs and filter in JS.
			const results = await search(this.db, {
				term: "",
				limit: 100000,
			}) as Results<ChunkDocument>;

			return results.hits
				.filter(hit => (hit.document as unknown as Record<string, unknown>)[field] === value)
				.map(hit => ({
					id: hit.id,
					document: hit.document,
				}));
		} catch (e) {
			console.warn(`WOAKI: searchByField("${field}", "${value}") failed:`, e);
			return [];
		}
	}
}
