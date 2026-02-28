import {App, PluginSettingTab, Setting} from "obsidian";
import {EMBEDDING_MODELS} from "./constants";
import type WoakiPlugin from "./main";

export interface WoakiSettings {
	// LLM settings
	llmProvider: "openai" | "anthropic" | "ollama";
	llmModel: string;
	llmApiKey: string;
	llmBaseUrl: string;

	// Embedding settings
	embeddingModel: string;
	embeddingDimensions: number;

	// RAG settings
	chunkSize: number;
	chunkOverlap: number;
	topK: number;

	// UI settings
	showStatusBar: boolean;
}

export const DEFAULT_SETTINGS: WoakiSettings = {
	// LLM settings
	llmProvider: "openai",
	llmModel: "gpt-4o-mini",
	llmApiKey: "",
	llmBaseUrl: "",

	// Embedding settings
	embeddingModel: "TaylorAI/bge-micro-v2",
	embeddingDimensions: 384,

	// RAG settings
	chunkSize: 1000,
	chunkOverlap: 200,
	topK: 5,

	// UI settings
	showStatusBar: true,
};

export class WoakiSettingTab extends PluginSettingTab {
	plugin: WoakiPlugin;

	constructor(app: App, plugin: WoakiPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	async display(): Promise<void> {
		const {containerEl} = this;
		containerEl.empty();

		// --- LLM Provider ---
		containerEl.createEl("h2", {text: "LLM Provider"});

		new Setting(containerEl)
			.setName("Provider")
			.setDesc("Select the LLM provider to use for chat.")
			.addDropdown(dropdown => dropdown
				.addOption("openai", "OpenAI")
				.addOption("anthropic", "Anthropic")
				.addOption("ollama", "Ollama (local)")
				.setValue(this.plugin.settings.llmProvider)
				.onChange(async (value) => {
					this.plugin.settings.llmProvider = value as WoakiSettings["llmProvider"];
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName("Model")
			.setDesc("The model name to use (e.g. gpt-4o-mini, claude-sonnet-4-5-20250929).")
			.addText(text => text
				.setPlaceholder("gpt-4o-mini")
				.setValue(this.plugin.settings.llmModel)
				.onChange(async (value) => {
					this.plugin.settings.llmModel = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName("API Key")
			.setDesc("Your API key for the selected provider.")
			.addText(text => {
				text.inputEl.type = "password";
				text.setPlaceholder("sk-...")
					.setValue(this.plugin.settings.llmApiKey)
					.onChange(async (value) => {
						this.plugin.settings.llmApiKey = value;
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("Base URL (optional)")
			.setDesc("Custom base URL for the API (e.g. for Ollama or proxies).")
			.addText(text => text
				.setPlaceholder("http://localhost:11434")
				.setValue(this.plugin.settings.llmBaseUrl)
				.onChange(async (value) => {
					this.plugin.settings.llmBaseUrl = value;
					await this.plugin.saveSettings();
				}));

		// --- Embedding ---
		containerEl.createEl("h2", {text: "Embedding"});

		new Setting(containerEl)
			.setName("Embedding model")
			.setDesc("Model used to generate embeddings for memorized notes. Larger models are more accurate but slower to download and run.")
			.addDropdown(dropdown => {
				for (const model of EMBEDDING_MODELS) {
					dropdown.addOption(model.id, model.label);
				}
				dropdown.setValue(this.plugin.settings.embeddingModel);
				dropdown.onChange(async (value) => {
					this.plugin.settings.embeddingModel = value;
					const model = EMBEDDING_MODELS.find(m => m.id === value);
					if (model) {
						this.plugin.settings.embeddingDimensions = model.dimensions;
					}
					await this.plugin.saveSettings();
				});
			});

		// --- RAG ---
		containerEl.createEl("h2", {text: "RAG Settings"});

		new Setting(containerEl)
			.setName("Chunk size")
			.setDesc("Number of characters per chunk when splitting notes.")
			.addText(text => text
				.setPlaceholder("1000")
				.setValue(String(this.plugin.settings.chunkSize))
				.onChange(async (value) => {
					const num = parseInt(value, 10);
					if (!isNaN(num) && num > 0) {
						this.plugin.settings.chunkSize = num;
						await this.plugin.saveSettings();
					}
				}));

		new Setting(containerEl)
			.setName("Chunk overlap")
			.setDesc("Number of overlapping characters between chunks.")
			.addText(text => text
				.setPlaceholder("200")
				.setValue(String(this.plugin.settings.chunkOverlap))
				.onChange(async (value) => {
					const num = parseInt(value, 10);
					if (!isNaN(num) && num >= 0) {
						this.plugin.settings.chunkOverlap = num;
						await this.plugin.saveSettings();
					}
				}));

		new Setting(containerEl)
			.setName("Top K results")
			.setDesc("Number of top matching chunks to retrieve for context.")
			.addText(text => text
				.setPlaceholder("5")
				.setValue(String(this.plugin.settings.topK))
				.onChange(async (value) => {
					const num = parseInt(value, 10);
					if (!isNaN(num) && num > 0) {
						this.plugin.settings.topK = num;
						await this.plugin.saveSettings();
					}
				}));

		// --- Status ---
		containerEl.createEl("h2", {text: "About"});

		const memorizedCount = this.plugin.statusBar.getMemorizedCount();
		const chunkCount = this.plugin.database.getDocumentCount();
		const dbSizeBytes = await this.plugin.database.getDbFileSize();
		const dbSize = this.formatBytes(dbSizeBytes);

		new Setting(containerEl)
			.setName("Memorized notes")
			.setDesc(`${memorizedCount} note${memorizedCount === 1 ? "" : "s"} currently memorized (${chunkCount} chunk${chunkCount === 1 ? "" : "s"} in database).`);

		new Setting(containerEl)
			.setName("Database size")
			.setDesc(`${dbSize} on disk (${this.plugin.manifest.dir}/orama-db.json).`);
	}

	private formatBytes(bytes: number): string {
		if (bytes === 0) return "0 B";
		const units = ["B", "KB", "MB", "GB"];
		const i = Math.floor(Math.log(bytes) / Math.log(1024));
		const size = bytes / Math.pow(1024, i);
		return `${size.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
	}
}
