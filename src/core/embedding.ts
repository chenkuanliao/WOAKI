import { showNotice } from "../ui/notices";
import type { App } from "obsidian";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Extractor = any;

export class EmbeddingModel {
	private extractor: Extractor = null;
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

				this.extractor = await (pipeline as Function)("feature-extraction", this.modelName, {
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
		const output = await this.extractor(text, { pooling: "mean", normalize: true });
		return Array.from(output.data as Float32Array);
	}

	async embedBatch(texts: string[]): Promise<number[][]> {
		const results: number[][] = [];
		for (const text of texts) {
			results.push(await this.embed(text));
		}
		return results;
	}

	dispose(): void {
		this.extractor = null;
		this.loading = null;
	}
}
