import { App, PluginSettingTab, Setting } from "obsidian";
import { EMBEDDING_MODELS } from "./constants";
import type WoakiPlugin from "./main";

export interface ProviderConfig {
	apiKey: string;
	baseUrl: string;
	enabled: boolean;
}

export interface StarredModel {
	provider: "openai" | "anthropic" | "ollama";
	model: string;
}

export interface WoakiSettings {
	// Multi-provider configs
	providers: {
		openai: ProviderConfig;
		anthropic: ProviderConfig;
		ollama: ProviderConfig;
	};
	starredModels: StarredModel[];

	// Legacy LLM settings (kept for migration)
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
	// Multi-provider configs
	providers: {
		openai: { apiKey: "", baseUrl: "https://api.openai.com", enabled: false },
		anthropic: { apiKey: "", baseUrl: "https://api.anthropic.com", enabled: false },
		ollama: { apiKey: "", baseUrl: "http://localhost:11434", enabled: false },
	},
	starredModels: [],

	// Legacy
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
		const { containerEl } = this;
		containerEl.empty();

		// --- LLM Providers ---
		containerEl.createEl("h2", { text: "LLM Providers" });
		containerEl.createEl("p", {
			text: "Configure one or more providers. Star (★) the models you want available in chat.",
			cls: "setting-item-description",
		});

		await this.renderProvider(containerEl, "openai", "OpenAI", {
			keyPlaceholder: "sk-...",
			baseUrlDefault: "https://api.openai.com",
		});

		await this.renderProvider(containerEl, "anthropic", "Anthropic", {
			keyPlaceholder: "sk-ant-...",
			baseUrlDefault: "https://api.anthropic.com",
		});

		await this.renderProvider(containerEl, "ollama", "Ollama (Local)", {
			keyPlaceholder: "",
			baseUrlDefault: "http://localhost:11434",
			noApiKey: true,
		});

		// --- Embedding ---
		containerEl.createEl("h2", { text: "Embedding" });

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
		containerEl.createEl("h2", { text: "RAG Settings" });

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
		containerEl.createEl("h2", { text: "About" });

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

	/** Render a provider section with API key, base URL, test connection, and model list */
	private async renderProvider(
		containerEl: HTMLElement,
		key: "openai" | "anthropic" | "ollama",
		label: string,
		opts: { keyPlaceholder: string; baseUrlDefault: string; noApiKey?: boolean },
	): Promise<void> {
		const config = this.plugin.settings.providers[key];

		// Provider section container
		const section = containerEl.createDiv("woaki-provider-section");
		const header = section.createDiv("woaki-provider-header");

		// Chevron indicator
		const chevron = header.createSpan("woaki-provider-chevron");
		chevron.textContent = "▾";

		// Status dot
		const statusDot = header.createSpan("woaki-provider-status");
		statusDot.addClass(config.enabled ? "is-connected" : "is-disconnected");

		header.createEl("h3", { text: label });

		// Collapsible body
		const body = section.createDiv("woaki-provider-body");

		// Toggle collapse on header click
		header.addEventListener("click", () => {
			const isCollapsed = body.hasClass("is-collapsed");
			if (isCollapsed) {
				body.removeClass("is-collapsed");
				chevron.textContent = "▾";
			} else {
				body.addClass("is-collapsed");
				chevron.textContent = "▸";
			}
		});

		// API Key (skip for Ollama)
		if (!opts.noApiKey) {
			new Setting(body)
				.setName("API Key")
				.addText(text => {
					text.inputEl.type = "password";
					text.setPlaceholder(opts.keyPlaceholder)
						.setValue(config.apiKey)
						.onChange(async (value) => {
							this.plugin.settings.providers[key].apiKey = value;
							await this.plugin.saveSettings();
						});
				});
		}

		// Base URL
		new Setting(body)
			.setName("Base URL")
			.addText(text => text
				.setPlaceholder(opts.baseUrlDefault)
				.setValue(config.baseUrl === opts.baseUrlDefault ? "" : config.baseUrl)
				.onChange(async (value) => {
					this.plugin.settings.providers[key].baseUrl = value || opts.baseUrlDefault;
					await this.plugin.saveSettings();
				}));

		// Test Connection + Model list container
		const modelListEl = body.createDiv("woaki-provider-models");

		const testSetting = new Setting(body)
			.setName("Connection");

		if (config.enabled) {
			testSetting.setDesc("✅ Connected");
		}

		testSetting.addButton(btn => btn
			.setButtonText(config.enabled ? "Refresh Models" : "Test Connection")
			.setCta()
			.onClick(async () => {
				btn.setButtonText("Testing...");
				btn.setDisabled(true);
				testSetting.setDesc("Testing connection...");

				const providerName = key === "openai" ? "OpenAI" : key === "anthropic" ? "Anthropic" : "Ollama";

				try {
					const result = await this.plugin.llmAdapter.testProviderConnection(
						providerName,
						config.apiKey,
						config.baseUrl,
					);

					if (result.ok) {
						testSetting.setDesc("✅ Connected");
						this.plugin.settings.providers[key].enabled = true;
						await this.plugin.saveSettings();

						// Fetch models
						btn.setButtonText("Loading models...");
						const models = await this.plugin.llmAdapter.listModelsForProvider(
							providerName,
							config.apiKey,
							config.baseUrl,
						);
						this.renderModelList(modelListEl, key, models);
						btn.setButtonText("Refresh Models");
					} else {
						testSetting.setDesc(`❌ ${result.error ?? "Connection failed"}`);
						this.plugin.settings.providers[key].enabled = false;
						await this.plugin.saveSettings();
						btn.setButtonText("Test Connection");
					}
				} catch (e: unknown) {
					const msg = e instanceof Error ? e.message : String(e);
					testSetting.setDesc(`❌ ${msg}`);
					btn.setButtonText("Test Connection");
				} finally {
					btn.setDisabled(false);
				}
			}));

		// If already connected, load models on render
		if (config.enabled) {
			const providerName = key === "openai" ? "OpenAI" : key === "anthropic" ? "Anthropic" : "Ollama";
			try {
				const models = await this.plugin.llmAdapter.listModelsForProvider(
					providerName,
					config.apiKey,
					config.baseUrl,
				);
				this.renderModelList(modelListEl, key, models);
			} catch {
				modelListEl.createEl("p", {
					text: "Could not load models.",
					cls: "woaki-models-error",
				});
			}
		}
	}

	/** Render a model list with star toggles */
	private renderModelList(
		container: HTMLElement,
		provider: "openai" | "anthropic" | "ollama",
		models: string[],
	): void {
		container.empty();

		if (models.length === 0) {
			container.createEl("p", {
				text: "No models found.",
				cls: "woaki-models-empty",
			});
			return;
		}

		const starred = this.plugin.settings.starredModels;

		for (const model of models) {
			const isStarred = starred.some(s => s.provider === provider && s.model === model);

			const row = container.createDiv("woaki-model-row");
			const starBtn = row.createEl("button", {
				cls: `woaki-star-btn ${isStarred ? "is-starred" : ""}`,
				attr: { "aria-label": isStarred ? "Unstar model" : "Star model" },
			});
			starBtn.textContent = isStarred ? "★" : "☆";

			row.createSpan({ text: model, cls: "woaki-model-name" });

			starBtn.addEventListener("click", async () => {
				const idx = this.plugin.settings.starredModels.findIndex(
					s => s.provider === provider && s.model === model,
				);
				if (idx >= 0) {
					this.plugin.settings.starredModels.splice(idx, 1);
					starBtn.textContent = "☆";
					starBtn.removeClass("is-starred");
				} else {
					this.plugin.settings.starredModels.push({ provider, model });
					starBtn.textContent = "★";
					starBtn.addClass("is-starred");
				}
				await this.plugin.saveSettings();
			});
		}
	}

	private formatBytes(bytes: number): string {
		if (bytes === 0) return "0 B";
		const units = ["B", "KB", "MB", "GB"];
		const i = Math.floor(Math.log(bytes) / Math.log(1024));
		const size = bytes / Math.pow(1024, i);
		return `${size.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
	}
}
