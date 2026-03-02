import { ItemView, Modal, TFile, WorkspaceLeaf } from "obsidian";
import { MEMORY_STATUS_VIEW_TYPE, PLUGIN_DISPLAY_NAME, WOAKI_PROPERTY, WOAKI_MEMORIZED_VALUE } from "../constants";
import { getWoakiId } from "../utils/frontmatter";
import type WoakiPlugin from "../main";

export class WoakiMemoryStatusView extends ItemView {
	plugin: WoakiPlugin;
	private contentArea: HTMLElement;

	constructor(leaf: WorkspaceLeaf, plugin: WoakiPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return MEMORY_STATUS_VIEW_TYPE;
	}

	getDisplayText(): string {
		return `${PLUGIN_DISPLAY_NAME} Memory Status`;
	}

	getIcon(): string {
		return "brain-cog";
	}

	async onOpen(): Promise<void> {
		const container = this.contentEl;
		container.empty();
		container.addClass("woaki-memory-status-container");
		this.contentArea = container.createDiv("woaki-memory-status-content");
		await this.refresh();
	}

	async onClose(): Promise<void> {
		// nothing to clean up
	}

	async refresh(): Promise<void> {
		this.contentArea.empty();

		// Summary bar
		const summary = this.contentArea.createDiv("woaki-memory-summary");

		const memorizedFiles = this.getMemorizedFiles();
		const chunkCount = this.plugin.database.getDocumentCount();
		const dbSizeBytes = await this.plugin.database.getDbFileSize();
		const dbSize = this.formatBytes(dbSizeBytes);
		const noteStats = await this.plugin.database.getNoteStats();

		const statsRow = summary.createDiv("woaki-memory-stats-row");
		this.createStatBadge(statsRow, String(memorizedFiles.length), "Notes");
		this.createStatBadge(statsRow, String(chunkCount), "Chunks");
		this.createStatBadge(statsRow, dbSize, "DB Size");
		this.createStatBadge(statsRow, this.plugin.settings.embeddingModel.split("/").pop() ?? "", "Model");

		// Actions
		const actionsRow = summary.createDiv("woaki-memory-actions-row");

		const rebuildBtn = actionsRow.createEl("button", { text: "Rebuild database", cls: "woaki-memory-action-btn" });
		rebuildBtn.addEventListener("click", () => {
			void this.plugin.memoryManager.rebuildDatabase().then(() => this.refresh());
		});

		const clearBtn = actionsRow.createEl("button", { cls: "woaki-memory-action-btn mod-warning" });
		clearBtn.createSpan({ text: "Clear DB" });
		clearBtn.addEventListener("click", () => {
			const modal = new ClearDatabaseModal(this.app, () => {
				return this.plugin.memoryManager.clearDatabase().then(() => this.refresh());
			});
			modal.open();
		});

		const refreshBtn = actionsRow.createEl("button", { text: "Refresh", cls: "woaki-memory-action-btn" });
		refreshBtn.addEventListener("click", () => void this.refresh());

		// Note list
		const listHeader = this.contentArea.createDiv("woaki-memory-list-header");
		listHeader.createEl("span", { text: "Memorized notes" });

		const list = this.contentArea.createDiv("woaki-memory-note-list");

		if (memorizedFiles.length === 0) {
			list.createDiv({ text: "No memorized notes.", cls: "woaki-memory-empty" });
			return;
		}

		for (const file of memorizedFiles) {
			const woakiId = getWoakiId(this.plugin.app, file);
			const stats = woakiId ? noteStats.get(woakiId) : null;

			const row = list.createDiv("woaki-memory-note-row");

			const info = row.createDiv("woaki-memory-note-info");

			const titleLink = info.createEl("a", { text: file.basename, cls: "woaki-memory-note-title" });
			titleLink.addEventListener("click", (e) => {
				e.preventDefault();
				void this.app.workspace.openLinkText(file.path, "");
			});

			const meta = info.createDiv("woaki-memory-note-meta");
			if (stats) {
				meta.createEl("span", {
					text: `${stats.chunkCount} chunk${stats.chunkCount === 1 ? "" : "s"}`,
					cls: "woaki-memory-note-chunks",
				});
				if (stats.tags) {
					const tagsEl = meta.createEl("span", { cls: "woaki-memory-note-tags" });
					for (const tag of stats.tags.split(", ").filter(Boolean)) {
						tagsEl.createEl("span", { text: tag, cls: "woaki-tag-chip" });
					}
				}
				meta.createEl("span", {
					text: new Date(stats.updatedAt).toLocaleDateString(),
					cls: "woaki-memory-note-date",
				});
			}

			const unmemorizeBtn = row.createEl("button", {
				text: "Forget",
				cls: "woaki-memory-unmemorize-btn",
			});
			unmemorizeBtn.addEventListener("click", () => {
				void this.plugin.memoryManager.unmemorizeNote(file).then(() => this.refresh());
			});
		}
	}

	private getMemorizedFiles(): TFile[] {
		const files = this.app.vault.getMarkdownFiles();
		return files.filter(file => {
			const cache = this.app.metadataCache.getFileCache(file);
			return cache?.frontmatter?.[WOAKI_PROPERTY] === WOAKI_MEMORIZED_VALUE;
		});
	}

	private createStatBadge(container: HTMLElement, value: string, label: string): void {
		const badge = container.createDiv("woaki-memory-stat-badge");
		badge.createDiv({ text: value, cls: "woaki-memory-stat-value" });
		badge.createDiv({ text: label, cls: "woaki-memory-stat-label" });
	}

	private formatBytes(bytes: number): string {
		if (bytes === 0) return "0 B";
		const units = ["B", "KB", "MB", "GB"];
		const i = Math.floor(Math.log(bytes) / Math.log(1024));
		const size = bytes / Math.pow(1024, i);
		return `${size.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
	}
}

class ClearDatabaseModal extends Modal {
	private onConfirm: () => Promise<void>;

	constructor(app: import("obsidian").App, onConfirm: () => Promise<void>) {
		super(app);
		this.onConfirm = onConfirm;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("woaki-clear-db-modal");

		contentEl.createEl("h3", { text: "Clear memory database" });
		contentEl.createEl("p", {
			text: "Are you sure you want to clear the entire memory database? This will remove all memorized note embeddings. Your notes themselves will not be affected, but you will need to re-memorize them.",
		});

		const btnContainer = contentEl.createDiv("woaki-clear-db-modal-actions");

		const cancelBtn = btnContainer.createEl("button", { text: "Cancel", cls: "woaki-clear-db-cancel-btn" });
		cancelBtn.addEventListener("click", () => this.close());

		const confirmBtn = btnContainer.createEl("button", { text: "Clear database", cls: "woaki-clear-db-confirm-btn" });
		confirmBtn.addEventListener("click", () => {
			this.close();
			void this.onConfirm();
		});
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
