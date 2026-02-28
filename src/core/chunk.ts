import {DEFAULT_CHUNK_SIZE} from "../constants";

export function removeFrontmatter(content: string): string {
	const match = content.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
	if (match) {
		return content.slice(match[0].length);
	}
	return content;
}

export function chunkMarkdown(content: string, maxChunkSize: number = DEFAULT_CHUNK_SIZE): string[] {
	const body = removeFrontmatter(content);
	if (!body.trim()) {
		return [];
	}

	// Split by H1/H2 headings, keeping the heading with its section
	const sections = body.split(/(?=^#{1,2}\s)/m);

	const chunks: string[] = [];

	for (const section of sections) {
		const trimmed = section.trim();
		if (!trimmed) continue;

		if (trimmed.length <= maxChunkSize) {
			chunks.push(trimmed);
		} else {
			// Sub-split by paragraphs
			const paragraphs = trimmed.split(/\n\n+/);
			let current = "";

			for (const para of paragraphs) {
				const paraText = para.trim();
				if (!paraText) continue;

				if (current && (current.length + paraText.length + 2) > maxChunkSize) {
					chunks.push(current.trim());
					current = paraText;
				} else {
					current = current ? current + "\n\n" + paraText : paraText;
				}
			}

			if (current.trim()) {
				chunks.push(current.trim());
			}
		}
	}

	return chunks;
}
