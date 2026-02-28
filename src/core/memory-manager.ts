import {TAbstractFile, TFile} from "obsidian";
import {isNoteMemorized, addWoakiFrontmatter, removeWoakiFrontmatter} from "../utils/frontmatter";
import {showMemorizedNotice, showForgottenNotice, showNotice} from "../ui/notices";
import type WoakiPlugin from "../main";

export class MemoryManager {
	private plugin: WoakiPlugin;

	constructor(plugin: WoakiPlugin) {
		this.plugin = plugin;
	}

	async memorizeNote(file: TFile): Promise<void> {
		if (isNoteMemorized(this.plugin.app, file)) {
			showNotice(`"${file.basename}" is already memorized.`);
			return;
		}
		await addWoakiFrontmatter(this.plugin.app, file);
		showMemorizedNotice(file.basename);
	}

	async unmemorizeNote(file: TFile): Promise<void> {
		if (!isNoteMemorized(this.plugin.app, file)) {
			showNotice(`"${file.basename}" is not memorized.`);
			return;
		}
		await removeWoakiFrontmatter(this.plugin.app, file);
		showForgottenNotice(file.basename);
	}

	isMemorized(file: TFile): boolean {
		return isNoteMemorized(this.plugin.app, file);
	}

	handleFileDelete(_file: TAbstractFile): void {
		// Status bar updates reactively via metadataCache "changed" event
	}

	handleFileRename(file: TAbstractFile, _oldPath: string): void {
		// Stub for Phase 2: will update database references
		if (file instanceof TFile) {
			// No-op for now
		}
	}
}
