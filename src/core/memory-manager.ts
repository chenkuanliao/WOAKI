import {TAbstractFile, TFile, TFolder} from "obsidian";
import {isNoteMemorized, addWoakiFrontmatter, removeWoakiFrontmatter, getWoakiId} from "../utils/frontmatter";
import {computeHash} from "../utils/hash";
import {chunkMarkdown} from "./chunk";
import {
	showMemorizedNotice,
	showForgottenNotice,
	showNotice,
	showIndexingCompleteNotice,
} from "../ui/notices";
import {ProgressIndicator} from "../ui/progress-indicator";
import {REINDEX_DEBOUNCE_MS, WOAKI_PROPERTY, WOAKI_MEMORIZED_VALUE} from "../constants";
import type WoakiPlugin from "../main";

export class MemoryManager {
	private plugin: WoakiPlugin;
	private debounceTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
	private progress = new ProgressIndicator();

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

			const hashes = await Promise.all(chunks.map(c => computeHash(c)));
			const embeddings = await this.plugin.embeddingModel.embedBatch(chunks);

			for (let i = 0; i < chunks.length; i++) {
				await this.plugin.database.insertChunk({
					noteId: woakiId,
					filePath: file.path,
					chunkIndex: i,
					chunkHash: hashes[i]!,
					title: file.basename,
					content: chunks[i]!,
					tags,
					embedding: embeddings[i]!,
					memorizedAt: now,
					updatedAt: now,
				});
			}

			await this.plugin.database.persist();
			showIndexingCompleteNotice(file.basename, chunks.length);
		} catch (e) {
			console.error("WOAKI: Failed to index note:", e);
			// Clean up partial DB entries on failure
			await this.plugin.database.removeNote(woakiId);
			await this.plugin.database.persist();
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

	handleFileChange(file: TFile): void {
		if (!isNoteMemorized(this.plugin.app, file)) return;

		// Clear existing timer for this file
		const existing = this.debounceTimers.get(file.path);
		if (existing) clearTimeout(existing);

		// Set debounced re-index
		const timer = setTimeout(() => {
			this.debounceTimers.delete(file.path);
			void this.reindexNote(file);
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
			this.progress.show("Syncing notes...");
			for (let i = 0; i < needsIndexing.length; i++) {
				const file = needsIndexing[i]!;
				this.progress.update(i + 1, needsIndexing.length, `Syncing: ${file.basename}`);
				this.plugin.statusBar.showProgress(i + 1, needsIndexing.length, "Syncing");
				try {
					await this.indexNote(file);
				} catch (e) {
					console.error(`WOAKI: Failed to sync "${file.basename}":`, e);
					showNotice(`Failed to sync "${file.basename}". Check console for details.`);
				}
			}
			this.progress.hide();
			this.plugin.statusBar.hideProgress();
		}

		await this.plugin.database.persist();
	}

	async rebuildDatabase(): Promise<void> {
		showNotice("Rebuilding memory database...");
		this.plugin.database.clear();

		const files = this.plugin.app.vault.getMarkdownFiles();
		const memorizedFiles: TFile[] = [];

		for (const file of files) {
			const cache = this.plugin.app.metadataCache.getFileCache(file);
			if (cache?.frontmatter?.[WOAKI_PROPERTY] === WOAKI_MEMORIZED_VALUE) {
				memorizedFiles.push(file);
			}
		}

		this.plugin.statusBar.setIndexing(true);
		this.progress.show("Rebuilding database...", () => { /* cancel handled via flag */ });
		const failures: string[] = [];
		try {
			for (let i = 0; i < memorizedFiles.length; i++) {
				if (this.progress.cancelled) {
					showNotice("Rebuild cancelled.");
					break;
				}
				const file = memorizedFiles[i]!;
				this.progress.update(i + 1, memorizedFiles.length, `Rebuilding: ${file.basename}`);
				this.plugin.statusBar.showProgress(i + 1, memorizedFiles.length, "Rebuilding");
				try {
					await this.indexNote(file);
				} catch (e) {
					console.error(`WOAKI: Failed to index "${file.basename}" during rebuild:`, e);
					failures.push(file.basename);
				}
			}

			await this.plugin.database.persist();
			if (failures.length > 0) {
				showNotice(`Rebuilt database. ${failures.length} note${failures.length === 1 ? "" : "s"} failed: ${failures.join(", ")}`);
			} else {
				showNotice(`Rebuilt database with ${memorizedFiles.length} note${memorizedFiles.length === 1 ? "" : "s"}.`);
			}
		} catch (e) {
			console.error("WOAKI: Failed to rebuild database:", e);
			showNotice("Failed to rebuild database. Check console for details.");
		} finally {
			this.progress.hide();
			this.plugin.statusBar.hideProgress();
			this.plugin.statusBar.setIndexing(false);
		}
	}

	async clearDatabase(): Promise<void> {
		this.plugin.database.clear();
		await this.plugin.database.persist();
		showNotice("Memory database cleared.");
	}

	async memorizeFolder(folderPath: string): Promise<{ succeeded: number; failed: string[] }> {
		const folder = this.plugin.app.vault.getAbstractFileByPath(folderPath);
		if (!(folder instanceof TFolder)) {
			showNotice(`"${folderPath}" is not a folder.`);
			return { succeeded: 0, failed: [] };
		}

		// Collect all markdown files in folder (recursively)
		const files: TFile[] = [];
		const collectFiles = (f: TFolder) => {
			for (const child of f.children) {
				if (child instanceof TFile && child.extension === "md") {
					files.push(child);
				} else if (child instanceof TFolder) {
					collectFiles(child);
				}
			}
		};
		collectFiles(folder);

		// Filter out already-memorized
		const toMemorize = files.filter(f => !isNoteMemorized(this.plugin.app, f));

		if (toMemorize.length === 0) {
			showNotice(`All notes in "${folder.name}" are already memorized.`);
			return { succeeded: 0, failed: [] };
		}

		showNotice(`Memorizing ${toMemorize.length} note${toMemorize.length === 1 ? "" : "s"} in "${folder.name}"...`);
		this.progress.show(`Memorizing folder "${folder.name}"...`, () => { /* cancel handled via flag */ });
		const failed: string[] = [];
		let succeeded = 0;

		for (let i = 0; i < toMemorize.length; i++) {
			if (this.progress.cancelled) {
				showNotice("Batch memorize cancelled.");
				break;
			}
			const file = toMemorize[i]!;
			this.progress.update(i + 1, toMemorize.length, `Memorizing: ${file.basename}`);
			this.plugin.statusBar.showProgress(i + 1, toMemorize.length, "Memorizing");
			try {
				await this.memorizeNote(file);
				succeeded++;
			} catch (e) {
				console.error(`WOAKI: Failed to memorize "${file.basename}":`, e);
				failed.push(file.basename);
			}
		}

		this.progress.hide();
		this.plugin.statusBar.hideProgress();

		if (failed.length > 0) {
			showNotice(`Memorized ${succeeded} note${succeeded === 1 ? "" : "s"}. ${failed.length} failed: ${failed.join(", ")}`);
		} else {
			showNotice(`Memorized ${succeeded} note${succeeded === 1 ? "" : "s"} in "${folder.name}".`);
		}

		return { succeeded, failed };
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

		const hashes = await Promise.all(chunks.map(c => computeHash(c)));
		const embeddings = await this.plugin.embeddingModel.embedBatch(chunks);

		for (let i = 0; i < chunks.length; i++) {
			await this.plugin.database.insertChunk({
				noteId: woakiId,
				filePath: file.path,
				chunkIndex: i,
				chunkHash: hashes[i]!,
				title: file.basename,
				content: chunks[i]!,
				tags,
				embedding: embeddings[i]!,
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

			const hashes = await Promise.all(chunks.map(c => computeHash(c)));

			let needsFullReindex = false;
			const newChunkIndices: number[] = [];

			for (let i = 0; i < chunks.length; i++) {
				const existing = await this.plugin.database.getChunk(woakiId, i);
				if (existing && existing.chunkHash === hashes[i]) {
					continue; // Chunk unchanged
				}
				if (existing) {
					needsFullReindex = true;
					break;
				}
				newChunkIndices.push(i);
			}

			if (needsFullReindex) {
				await this.plugin.database.removeNote(woakiId);
				await this.indexNote(file);
			} else if (newChunkIndices.length > 0) {
				const newTexts = newChunkIndices.map(i => chunks[i]!);
				const embeddings = await this.plugin.embeddingModel.embedBatch(newTexts);

				for (let j = 0; j < newChunkIndices.length; j++) {
					const i = newChunkIndices[j]!;
					await this.plugin.database.insertChunk({
						noteId: woakiId,
						filePath: file.path,
						chunkIndex: i,
						chunkHash: hashes[i]!,
						title: file.basename,
						content: chunks[i]!,
						tags,
						embedding: embeddings[j]!,
						memorizedAt: now,
						updatedAt: now,
					});
				}
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
