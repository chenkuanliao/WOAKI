import { MarkdownView, Plugin, TFile, Menu } from "obsidian";
import { DEFAULT_SETTINGS, WoakiSettings, WoakiSettingTab } from "./settings";
import { MemoryManager } from "./core/memory-manager";
import { WoakiDatabase } from "./core/database";
import { EmbeddingModel } from "./core/embedding";
import { LLMAdapter } from "./core/llm-adapter";
import { WoakiStatusBar } from "./ui/status-bar";
import { showNotice } from "./ui/notices";
import { isNoteMemorized } from "./utils/frontmatter";
import { WoakiChatView } from "./views/chat-view";
import {
	CMD_MEMORIZE_NOTE,
	CMD_FORGET_NOTE,
	CMD_OPEN_CHAT,
	CMD_REBUILD_DATABASE,
	CMD_CLEAR_DATABASE,
	CHAT_VIEW_TYPE,
	ICON_BRAIN,
	PLUGIN_DISPLAY_NAME,
} from "./constants";

export default class WoakiPlugin extends Plugin {
	settings: WoakiSettings;
	database: WoakiDatabase;
	embeddingModel: EmbeddingModel;
	llmAdapter: LLMAdapter;
	memoryManager: MemoryManager;
	statusBar: WoakiStatusBar;

	async onload() {
		await this.loadSettings();

		this.database = new WoakiDatabase(this);
		await this.database.initialize();

		this.embeddingModel = new EmbeddingModel(this.settings.embeddingModel, this.app, this.manifest.dir!);
		this.llmAdapter = new LLMAdapter(this.settings);

		this.memoryManager = new MemoryManager(this);

		// Register Chat View
		this.registerView(CHAT_VIEW_TYPE, (leaf) => new WoakiChatView(leaf, this));

		const statusBarEl = this.addStatusBarItem();
		this.statusBar = new WoakiStatusBar(statusBarEl, this.app);

		this.registerCommands();
		this.registerContextMenu();
		this.registerFileEvents();
		this.registerMetadataCacheEvents();

		this.addRibbonIcon(ICON_BRAIN, `${PLUGIN_DISPLAY_NAME}: Memorize current note`, async () => {
			const file = this.app.workspace.getActiveFile();
			if (file) {
				await this.memoryManager.memorizeNote(file);
			}
		});

		this.addRibbonIcon("message-circle", `${PLUGIN_DISPLAY_NAME}: Open Chat`, () => {
			this.activateChatView();
		});

		this.addSettingTab(new WoakiSettingTab(this.app, this));

		this.app.workspace.onLayoutReady(() => {
			this.statusBar.update();
			this.memoryManager.syncOnStartup();
		});
	}

	async onunload() {
		await this.database.persist();
		this.embeddingModel.dispose();
		this.app.workspace.detachLeavesOfType(CHAT_VIEW_TYPE);
	}

	private registerCommands(): void {
		this.addCommand({
			id: CMD_MEMORIZE_NOTE,
			name: "Memorize current note",
			checkCallback: (checking: boolean) => {
				const file = this.app.workspace.getActiveViewOfType(MarkdownView)?.file;
				if (file) {
					if (!checking) {
						this.memoryManager.memorizeNote(file);
					}
					return true;
				}
				return false;
			},
		});

		this.addCommand({
			id: CMD_FORGET_NOTE,
			name: "Forget current note",
			checkCallback: (checking: boolean) => {
				const file = this.app.workspace.getActiveViewOfType(MarkdownView)?.file;
				if (file && isNoteMemorized(this.app, file)) {
					if (!checking) {
						this.memoryManager.unmemorizeNote(file);
					}
					return true;
				}
				return false;
			},
		});

		this.addCommand({
			id: CMD_OPEN_CHAT,
			name: "Open WOAKI Chat",
			callback: () => {
				this.activateChatView();
			},
		});

		this.addCommand({
			id: CMD_REBUILD_DATABASE,
			name: "Rebuild memory database",
			callback: async () => {
				await this.memoryManager.rebuildDatabase();
			},
		});

		this.addCommand({
			id: CMD_CLEAR_DATABASE,
			name: "Clear memory database",
			callback: async () => {
				showNotice("Clearing memory database...");
				await this.memoryManager.clearDatabase();
			},
		});
	}

	private registerContextMenu(): void {
		this.registerEvent(
			this.app.workspace.on("file-menu", (menu: Menu, file) => {
				if (!(file instanceof TFile) || file.extension !== "md") {
					return;
				}

				if (isNoteMemorized(this.app, file)) {
					menu.addItem((item) => {
						item.setTitle(`${PLUGIN_DISPLAY_NAME}: Forget this note`)
							.setIcon("trash")
							.onClick(async () => {
								await this.memoryManager.unmemorizeNote(file);
							});
					});
				} else {
					menu.addItem((item) => {
						item.setTitle(`${PLUGIN_DISPLAY_NAME}: Memorize this note`)
							.setIcon(ICON_BRAIN)
							.onClick(async () => {
								await this.memoryManager.memorizeNote(file);
							});
					});
				}
			})
		);
	}

	private registerMetadataCacheEvents(): void {
		this.registerEvent(
			this.app.metadataCache.on("changed", (file) => {
				this.statusBar.update();
				if (file instanceof TFile) {
					this.memoryManager.handleFileChange(file);
				}
			})
		);
	}

	private registerFileEvents(): void {
		this.registerEvent(
			this.app.vault.on("delete", (file) => {
				this.memoryManager.handleFileDelete(file);
			})
		);

		this.registerEvent(
			this.app.vault.on("rename", (file, oldPath) => {
				this.memoryManager.handleFileRename(file, oldPath);
			})
		);
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData() as Partial<WoakiSettings>);

		// Migrate Phase 1 embedding settings to local model
		if (this.settings.embeddingModel === "text-embedding-3-small") {
			this.settings.embeddingModel = DEFAULT_SETTINGS.embeddingModel;
			this.settings.embeddingDimensions = DEFAULT_SETTINGS.embeddingDimensions;
			await this.saveSettings();
		}
	}

	async saveSettings() {
		await this.saveData(this.settings);
		this.llmAdapter?.updateSettings(this.settings);
	}

	async activateChatView(): Promise<void> {
		const existing = this.app.workspace.getLeavesOfType(CHAT_VIEW_TYPE);
		if (existing.length > 0) {
			this.app.workspace.revealLeaf(existing[0]!);
			return;
		}

		const leaf = this.app.workspace.getRightLeaf(false);
		if (leaf) {
			await leaf.setViewState({ type: CHAT_VIEW_TYPE, active: true });
			this.app.workspace.revealLeaf(leaf);
		}
	}
}
