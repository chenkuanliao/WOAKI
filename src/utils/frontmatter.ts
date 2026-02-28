import {App, TFile} from "obsidian";
import {WOAKI_PROPERTY, WOAKI_ID_PROPERTY, WOAKI_MEMORIZED_VALUE} from "../constants";

export function generateWoakiId(): string {
	try {
		return crypto.randomUUID().replace(/-/g, "").slice(0, 8);
	} catch {
		// Fallback for environments without crypto.randomUUID
		const array = new Uint8Array(4);
		crypto.getRandomValues(array);
		return Array.from(array, b => b.toString(16).padStart(2, "0")).join("");
	}
}

export function isNoteMemorized(app: App, file: TFile): boolean {
	const cache = app.metadataCache.getFileCache(file);
	const value = cache?.frontmatter?.[WOAKI_PROPERTY];
	return value === WOAKI_MEMORIZED_VALUE;
}

export function getWoakiId(app: App, file: TFile): string | undefined {
	const cache = app.metadataCache.getFileCache(file);
	return cache?.frontmatter?.[WOAKI_ID_PROPERTY] as string | undefined;
}

export async function addWoakiFrontmatter(app: App, file: TFile): Promise<string> {
	const id = generateWoakiId();
	await app.fileManager.processFrontMatter(file, (frontmatter) => {
		frontmatter[WOAKI_PROPERTY] = WOAKI_MEMORIZED_VALUE;
		frontmatter[WOAKI_ID_PROPERTY] = id;
	});
	return id;
}

export async function removeWoakiFrontmatter(app: App, file: TFile): Promise<void> {
	await app.fileManager.processFrontMatter(file, (frontmatter) => {
		delete frontmatter[WOAKI_PROPERTY];
		delete frontmatter[WOAKI_ID_PROPERTY];
	});
}
