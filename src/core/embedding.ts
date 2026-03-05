import { showNotice } from "../ui/notices";
import type { App } from "obsidian";

interface ExtractorOutput {
	data: Float32Array;
}
type ExtractorFn = (input: string | string[], options: { pooling: string; normalize: boolean }) => Promise<ExtractorOutput>;

export class EmbeddingModel {
	private extractor: ExtractorFn | null = null;
	private loading: Promise<void> | null = null;
	private modelName: string;
	private app: App;
	private pluginDir: string;

	constructor(modelName: string, app: App, pluginDir: string) {
		this.modelName = modelName;
		this.app = app;
		this.pluginDir = pluginDir;
	}

	async ensureLoaded(): Promise<void> {
		if (this.extractor) return;
		if (this.loading) {
			await this.loading;
			return;
		}

		this.loading = (async () => {
			showNotice(`Downloading embedding model "${this.modelName}"... (one-time)`, 10000);
			try {
				// CRITICAL: onnxruntime-web's Node.js build (ort.node.min.js) registers
				// itself at globalThis[Symbol.for('onnxruntime')]. If this symbol exists
				// when @huggingface/transformers' onnx.js loads, it takes a code path
				// that never populates supportedDevices[], causing:
				//   "Unsupported device: 'wasm'. Should be one of: ."
				// We delete it before import so the web code path runs instead.
				const ortSymbol = Symbol.for("onnxruntime");
				if (ortSymbol in globalThis) {
					delete (globalThis as Record<symbol, unknown>)[ortSymbol];
				}

				const { pipeline, env } = await import("@huggingface/transformers");

				// Configure Transformers.js for Obsidian's Electron environment:
				// - Disable local model loading (we download from HuggingFace)
				// - Disable FS and browser caching (Electron doesn't support
				//   Cache API and FS caching targets wrong paths)
				env.allowLocalModels = false;
				env.useFSCache = false;
				env.useBrowserCache = false;

				// Provide the WASM binary directly by reading from disk.
				// Electron blocks file:// fetch() and import(), so we use
				// Node.js fs.readFileSync to load the .wasm binary and pass
				// it via wasmBinary. This bypasses Emscripten's fetch() entirely.
				if (env.backends.onnx?.wasm) {
					const adapter = this.app.vault.adapter as { basePath?: string };
					if (adapter.basePath) {
						// eslint-disable-next-line @typescript-eslint/no-require-imports -- dynamic require needed for Node.js fs in Electron's renderer process
					const fs = require("fs") as typeof import("fs");
						const wasmPath = `${adapter.basePath}/${this.pluginDir}/ort-wasm-simd-threaded.wasm`;
						try {
							const wasmBuffer = fs.readFileSync(wasmPath);
							env.backends.onnx.wasm.wasmBinary = wasmBuffer.buffer;
						} catch (fsErr) {
							console.warn("WOAKI: Could not read WASM binary from disk, falling back to CDN:", fsErr);
						}
					}
					// Don't proxy WASM to a Worker (not needed in Electron,
					// and can cause issues with file:// paths)
					env.backends.onnx.wasm.proxy = false;
					// Single-threaded execution in Electron renderer
					env.backends.onnx.wasm.numThreads = 1;
				}

			const createPipeline = pipeline as unknown as (
				task: string, model: string, options: { device: string; dtype: string },
			) => Promise<ExtractorFn>;
			this.extractor = await createPipeline("feature-extraction", this.modelName, {
					device: "wasm",
					dtype: "fp32",
				});
				showNotice("Embedding model ready.");
			} catch (e) {
				this.loading = null;
				throw e;
			}
		})();

		await this.loading;
	}

	async embed(text: string): Promise<number[]> {
		await this.ensureLoaded();
		const output = await this.extractor!(text, { pooling: "mean", normalize: true });
		return Array.from(output.data);
	}

	async embedBatch(texts: string[]): Promise<number[][]> {
		if (texts.length === 0) return [];
		if (texts.length === 1) return [await this.embed(texts[0]!)];

		await this.ensureLoaded();
		const output = await this.extractor!(texts, { pooling: "mean", normalize: true });
		const flat = output.data;
		const dim = 384; // embedding dimensions
		const results: number[][] = [];
		for (let i = 0; i < texts.length; i++) {
			results.push(Array.from(flat.slice(i * dim, (i + 1) * dim)));
		}
		return results;
	}

	dispose(): void {
		this.extractor = null;
		this.loading = null;
	}
}
