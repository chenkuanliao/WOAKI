export class WoakiError extends Error {
	userMessage: string;
	retryable: boolean;

	constructor(message: string, userMessage: string, retryable = false) {
		super(message);
		this.name = "WoakiError";
		this.userMessage = userMessage;
		this.retryable = retryable;
	}
}

export class LLMConnectionError extends WoakiError {
	constructor(message: string, userMessage: string, retryable = false) {
		super(message, userMessage, retryable);
		this.name = "LLMConnectionError";
	}
}

export class EmbeddingError extends WoakiError {
	constructor(message: string, userMessage: string, retryable = false) {
		super(message, userMessage, retryable);
		this.name = "EmbeddingError";
	}
}

export class DatabaseError extends WoakiError {
	constructor(message: string, userMessage: string, retryable = false) {
		super(message, userMessage, retryable);
		this.name = "DatabaseError";
	}
}

/**
 * Classify an HTTP status code into a user-friendly WoakiError.
 */
export function classifyHttpError(status: number, body: string, provider: string): LLMConnectionError {
	if (status === 401 || status === 403) {
		return new LLMConnectionError(
			`${provider} auth error (${status}): ${body}`,
			`Invalid API key for ${provider}. Check your settings.`,
			false,
		);
	}
	if (status === 429) {
		return new LLMConnectionError(
			`${provider} rate limited (429): ${body}`,
			`Rate limited by ${provider}. Please wait a moment.`,
			true,
		);
	}
	if (status >= 500) {
		return new LLMConnectionError(
			`${provider} server error (${status}): ${body}`,
			`${provider} server error. Try again later.`,
			true,
		);
	}
	return new LLMConnectionError(
		`${provider} error (${status}): ${body}`,
		`${provider} request failed (${status}).`,
		false,
	);
}

/**
 * Classify a network/fetch error into a user-friendly WoakiError.
 */
export function classifyNetworkError(err: unknown, provider: string): LLMConnectionError {
	const msg = err instanceof Error ? err.message : String(err);
	if (msg.includes("abort")) {
		return new LLMConnectionError(msg, "Request was cancelled.", false);
	}
	return new LLMConnectionError(
		`${provider} network error: ${msg}`,
		`Cannot reach ${provider}. Check your connection and settings.`,
		true,
	);
}
