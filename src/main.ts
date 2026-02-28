import {MarkdownView, Plugin, TFile, Menu} from "obsidian";
import {DEFAULT_SETTINGS, WoakiSettings, WoakiSettingTab} from "./settings";
import {MemoryManager} from "./core/memory-manager";
import {WoakiStatusBar} from "./ui/status-bar";
import {showComingSoonNotice} from "./ui/notices";
import {isNoteMemorized} from "./utils/frontmatter";
import {
	CMD_MEMORIZE_NOTE,
	CMD_FORGET_NOTE,
	CMD_OPEN_CHAT,
	CMD_REBUILD_DATABASE,
	CMD_CLEAR_DATABASE,
	ICON_BRAIN,
	PLUGIN_DISPLAY_NAME,
} from "./constants";

export default class WoakiPlugin extends Plugin {
	settings: WoakiSettings;
	memoryManager: MemoryManager;
	statusBar: WoakiStatusBar;

	async onload() {
		await this.loadSettings();

		this.memoryManager = new MemoryManager(this);

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

		this.addSettingTab(new WoakiSettingTab(this.app, this));

		this.app.workspace.onLayoutReady(() => {
			this.statusBar.update();
		});
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
				showComingSoonNotice("WOAKI Chat");
			},
		});

		this.addCommand({
			id: CMD_REBUILD_DATABASE,
			name: "Rebuild memory database",
			callback: () => {
				showComingSoonNotice("Rebuild database");
			},
		});

		this.addCommand({
			id: CMD_CLEAR_DATABASE,
			name: "Clear memory database",
			callback: () => {
				showComingSoonNotice("Clear database");
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
			this.app.metadataCache.on("changed", () => {
				this.statusBar.update();
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
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}
