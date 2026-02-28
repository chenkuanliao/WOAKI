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
