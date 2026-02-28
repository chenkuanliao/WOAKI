import {Notice} from "obsidian";
import {PLUGIN_DISPLAY_NAME} from "../constants";

export function showNotice(message: string, duration?: number): void {
	new Notice(`${PLUGIN_DISPLAY_NAME}: ${message}`, duration);
}

export function showMemorizedNotice(basename: string): void {
	showNotice(`Memorized "${basename}"`);
}

export function showForgottenNotice(basename: string): void {
	showNotice(`Forgot "${basename}"`);
}

export function showComingSoonNotice(featureName: string): void {
	showNotice(`${featureName} is coming in a future update.`);
}

export function showIndexingNotice(basename: string): void {
	showNotice(`Indexing "${basename}"...`);
}

export function showIndexingCompleteNotice(basename: string, chunkCount: number): void {
	showNotice(`Indexed "${basename}" (${chunkCount} chunk${chunkCount === 1 ? "" : "s"})`);
}

export function showRebuildProgressNotice(current: number, total: number): void {
	showNotice(`Rebuilding memory database... (${current}/${total})`, 3000);
}

export function showModelLoadingNotice(): void {
	showNotice("Loading embedding model...", 5000);
}

export function showModelReadyNotice(): void {
	showNotice("Embedding model ready.");
}
