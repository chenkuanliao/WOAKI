import {App} from "obsidian";
import {WOAKI_PROPERTY, WOAKI_MEMORIZED_VALUE} from "../constants";

export class WoakiStatusBar {
	private statusBarEl: HTMLElement;
	private app: App;

	constructor(statusBarEl: HTMLElement, app: App) {
		this.statusBarEl = statusBarEl;
		this.app = app;
		this.statusBarEl.addClass("woaki-status-bar");
	}

	update(): void {
		const count = this.getMemorizedCount();
		this.statusBarEl.setText(`🧠 ${count} memorized`);
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
