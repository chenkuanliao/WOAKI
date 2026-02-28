import {TAbstractFile, TFile} from "obsidian";
import {isNoteMemorized, addWoakiFrontmatter, removeWoakiFrontmatter, getWoakiId} from "../utils/frontmatter";
import {computeHash} from "../utils/hash";
import {chunkMarkdown} from "./chunk";
import {
	showMemorizedNotice,
	showForgottenNotice,
	showNotice,
	showIndexingCompleteNotice,
	showRebuildProgressNotice,
} from "../ui/notices";
import {REINDEX_DEBOUNCE_MS, WOAKI_PROPERTY, WOAKI_MEMORIZED_VALUE} from "../constants";
import type WoakiPlugin from "../main";

export class MemoryManager {
	private plugin: WoakiPlugin;
	private debounceTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();

	constructor(plugin: WoakiPlugin) {
		this.plugin = plugin;
	}

	async memorizeNote(file: TFile): Promise<void> {
		if (isNoteMemorized(this.plugin.app, file)) {
			showNotice(`"${file.basename}" is already memorized.`);
			return;
		}

		const woakiId = await addWoakiFrontmatter(this.plugin.app, file);
		showMemorizedNotice(file.basename);

		// Index the note
		this.plugin.statusBar.setIndexing(true);
		try {
			const content = await this.plugin.app.vault.read(file);
			const chunks = chunkMarkdown(content, this.plugin.settings.chunkSize);
			const tags = this.getNoteTags(file).join(", ");
			const now = Date.now();

			for (let i = 0; i < chunks.length; i++) {
				const chunk = chunks[i]!;
				const chunkHash = await computeHash(chunk);
				const embedding = await this.plugin.embeddingModel.embed(chunk);

				await this.plugin.database.insertChunk({
					noteId: woakiId,
					filePath: file.path,
					chunkIndex: i,
					chunkHash,
					title: file.basename,
					content: chunk,
					tags,
					embedding,
					memorizedAt: now,
					updatedAt: now,
				});
			}

			await this.plugin.database.persist();
			showIndexingCompleteNotice(file.basename, chunks.length);
		} catch (e) {
			console.error("WOAKI: Failed to index note:", e);
			showNotice(`Failed to index "${file.basename}". Check console for details.`);
		} finally {
			this.plugin.statusBar.setIndexing(false);
		}
	}

	async unmemorizeNote(file: TFile): Promise<void> {
		if (!isNoteMemorized(this.plugin.app, file)) {
			showNotice(`"${file.basename}" is not memorized.`);
			return;
		}

		const woakiId = getWoakiId(this.plugin.app, file);
		await removeWoakiFrontmatter(this.plugin.app, file);

		if (woakiId) {
			await this.plugin.database.removeNote(woakiId);
			await this.plugin.database.persist();
		}

		showForgottenNotice(file.basename);
	}

	isMemorized(file: TFile): boolean {
		return isNoteMemorized(this.plugin.app, file);
	}

	async handleFileChange(file: TFile): Promise<void> {
		if (!isNoteMemorized(this.plugin.app, file)) return;

		// Clear existing timer for this file
		const existing = this.debounceTimers.get(file.path);
		if (existing) clearTimeout(existing);

		// Set debounced re-index
		const timer = setTimeout(async () => {
			this.debounceTimers.delete(file.path);
			await this.reindexNote(file);
		}, REINDEX_DEBOUNCE_MS);

		this.debounceTimers.set(file.path, timer);
	}

	async handleFileDelete(file: TAbstractFile): Promise<void> {
		if (!(file instanceof TFile)) return;
		await this.plugin.database.removeByFilePath(file.path);
		await this.plugin.database.persist();
	}

	async handleFileRename(file: TAbstractFile, oldPath: string): Promise<void> {
		if (!(file instanceof TFile)) return;
		await this.plugin.database.updateFilePath(oldPath, file.path);
		await this.plugin.database.persist();
	}

	async syncOnStartup(): Promise<void> {
		const files = this.plugin.app.vault.getMarkdownFiles();
		const memorizedFiles: TFile[] = [];

		for (const file of files) {
			const cache = this.plugin.app.metadataCache.getFileCache(file);
			if (cache?.frontmatter?.[WOAKI_PROPERTY] === WOAKI_MEMORIZED_VALUE) {
				memorizedFiles.push(file);
			}
		}

		if (memorizedFiles.length === 0) return;

		// Get note IDs currently in database
		const dbNoteIds = await this.plugin.database.getNoteIds();

		// Find notes that are memorized but not in DB
		const needsIndexing: TFile[] = [];
		const vaultNoteIds = new Set<string>();

		for (const file of memorizedFiles) {
			const woakiId = getWoakiId(this.plugin.app, file);
			if (woakiId) {
				vaultNoteIds.add(woakiId);
				if (!dbNoteIds.has(woakiId)) {
					needsIndexing.push(file);
				}
			}
		}

		// Remove DB entries for notes no longer in vault
		for (const dbId of dbNoteIds) {
			if (!vaultNoteIds.has(dbId)) {
				await this.plugin.database.removeNote(dbId);
			}
		}

		// Index missing notes
		if (needsIndexing.length > 0) {
			showNotice(`Syncing ${needsIndexing.length} memorized note${needsIndexing.length === 1 ? "" : "s"}...`);
			for (let i = 0; i < needsIndexing.length; i++) {
				const file = needsIndexing[i]!;
				showRebuildProgressNotice(i + 1, needsIndexing.length);
				try {
					await this.indexNote(file);
				} catch (e) {
					console.error(`WOAKI: Failed to sync "${file.basename}":`, e);
					showNotice(`Failed to sync "${file.basename}". Check console for details.`);
				}
			}
		}

		await this.plugin.database.persist();
	}

	async rebuildDatabase(): Promise<void> {
		showNotice("Rebuilding memory database...");
		await this.plugin.database.clear();

		const files = this.plugin.app.vault.getMarkdownFiles();
		const memorizedFiles: TFile[] = [];

		for (const file of files) {
			const cache = this.plugin.app.metadataCache.getFileCache(file);
			if (cache?.frontmatter?.[WOAKI_PROPERTY] === WOAKI_MEMORIZED_VALUE) {
				memorizedFiles.push(file);
			}
		}

		this.plugin.statusBar.setIndexing(true);
		try {
			for (let i = 0; i < memorizedFiles.length; i++) {
				const file = memorizedFiles[i]!;
				showRebuildProgressNotice(i + 1, memorizedFiles.length);
				await this.indexNote(file);
			}

			await this.plugin.database.persist();
			showNotice(`Rebuilt database with ${memorizedFiles.length} note${memorizedFiles.length === 1 ? "" : "s"}.`);
		} catch (e) {
			console.error("WOAKI: Failed to rebuild database:", e);
			showNotice("Failed to rebuild database. Check console for details.");
		} finally {
			this.plugin.statusBar.setIndexing(false);
		}
	}

	async clearDatabase(): Promise<void> {
		await this.plugin.database.clear();
		await this.plugin.database.persist();
		showNotice("Memory database cleared.");
	}

	getNoteTags(file: TFile): string[] {
		const cache = this.plugin.app.metadataCache.getFileCache(file);
		if (!cache) return [];
		const tags: string[] = [];
		if (cache.tags) {
			for (const tagCache of cache.tags) {
				tags.push(tagCache.tag);
			}
		}
		if (cache.frontmatter?.tags) {
			const fmTags = cache.frontmatter.tags;
			if (Array.isArray(fmTags)) {
				for (const t of fmTags) {
					const tag = String(t);
					tags.push(tag.startsWith("#") ? tag : `#${tag}`);
				}
			}
		}
		return tags;
	}

	private async indexNote(file: TFile): Promise<void> {
		const woakiId = getWoakiId(this.plugin.app, file);
		if (!woakiId) return;

		const content = await this.plugin.app.vault.read(file);
		const chunks = chunkMarkdown(content, this.plugin.settings.chunkSize);
		const tags = this.getNoteTags(file).join(", ");
		const now = Date.now();

		for (let i = 0; i < chunks.length; i++) {
			const chunk = chunks[i]!;
			const chunkHash = await computeHash(chunk);
			const embedding = await this.plugin.embeddingModel.embed(chunk);

			await this.plugin.database.insertChunk({
				noteId: woakiId,
				filePath: file.path,
				chunkIndex: i,
				chunkHash,
				title: file.basename,
				content: chunk,
				tags,
				embedding,
				memorizedAt: now,
				updatedAt: now,
			});
		}
	}

	private async reindexNote(file: TFile): Promise<void> {
		const woakiId = getWoakiId(this.plugin.app, file);
		if (!woakiId) return;

		try {
			const content = await this.plugin.app.vault.read(file);
			const chunks = chunkMarkdown(content, this.plugin.settings.chunkSize);
			const tags = this.getNoteTags(file).join(", ");
			const now = Date.now();

			let changed = false;

			for (let i = 0; i < chunks.length; i++) {
				const chunk = chunks[i]!;
				const chunkHash = await computeHash(chunk);

				// Check if this chunk exists and is unchanged
				const existing = await this.plugin.database.getChunk(woakiId, i);
				if (existing && existing.chunkHash === chunkHash) {
					continue; // Chunk unchanged, skip
				}

				// Chunk is new or changed — embed and insert/replace
				if (existing) {
					// Remove old chunk by removing and re-inserting note chunks
					// For simplicity, we'll remove all and re-insert if anything changed
					changed = true;
					break;
				}

				// New chunk (note grew)
				const embedding = await this.plugin.embeddingModel.embed(chunk);
				await this.plugin.database.insertChunk({
					noteId: woakiId,
					filePath: file.path,
					chunkIndex: i,
					chunkHash,
					title: file.basename,
					content: chunk,
					tags,
					embedding,
					memorizedAt: now,
					updatedAt: now,
				});
				changed = true;
			}

			if (changed) {
				// If any existing chunk changed, do a full re-index of this note
				await this.plugin.database.removeNote(woakiId);
				await this.indexNote(file);
			} else {
				// Just clean up stale chunks if note got shorter
				await this.plugin.database.removeChunksBeyond(woakiId, chunks.length);
			}

			await this.plugin.database.persist();
		} catch (e) {
			console.error("WOAKI: Failed to reindex note:", e);
		}
	}
}
