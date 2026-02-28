import {App} from "obsidian";
import {WOAKI_PROPERTY, WOAKI_MEMORIZED_VALUE} from "../constants";

export class WoakiStatusBar {
	private statusBarEl: HTMLElement;
	private app: App;
	private indexing = false;

	constructor(statusBarEl: HTMLElement, app: App) {
		this.statusBarEl = statusBarEl;
		this.app = app;
		this.statusBarEl.addClass("woaki-status-bar");
	}

	update(): void {
		if (this.indexing) return;
		const count = this.getMemorizedCount();
		this.statusBarEl.setText(`🧠 ${count} memorized`);
	}

	setIndexing(active: boolean): void {
		this.indexing = active;
		if (active) {
			this.statusBarEl.setText("🧠 Indexing...");
		} else {
			this.update();
		}
	}

	showProgress(current: number, total: number, label: string): void {
		this.statusBarEl.setText(`🧠 ${label} (${current}/${total})`);
	}

	hideProgress(): void {
		this.update();
	}

	getMemorizedCount(): number {
		let count = 0;
		const files = this.app.vault.getMarkdownFiles();
		for (const file of files) {
			const cache = this.app.metadataCache.getFileCache(file);
			if (cache?.frontmatter?.[WOAKI_PROPERTY] === WOAKI_MEMORIZED_VALUE) {
				count++;
			}
		}
		return count;
	}
}
