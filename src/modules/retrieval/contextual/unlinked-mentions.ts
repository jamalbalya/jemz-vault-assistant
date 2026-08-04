/**
 * Unlinked mentions: note titles written as plain text where a link belongs.
 *
 * Correctness here is mostly about what NOT to match. The scan masks frontmatter, code
 * fences, inline code, existing wikilinks and existing markdown links with spaces — keeping
 * every remaining character at its original offset — so a mention inside a link or a code
 * sample is invisible while the reported positions still point at the real file.
 *
 * Longer titles win: in "Project Alpha timeline", `Project Alpha` claims the span so a note
 * merely called `Alpha` cannot also match inside it.
 */

import type { UnlinkedMention } from '../../../types/search';
import { contextSnippet, findWholeWordOccurrences, offsetToPosition } from '../../../utils/string';

/** A note that could be linked to. */
export interface MentionTarget {
	readonly path: string;
	readonly title: string;
}

export interface UnlinkedMentionOptions {
	/** Ignore titles shorter than this, which would match constantly. */
	minLength: number;
	/** Cap the number of mentions returned. */
	limit?: number;
	/** Cap the mentions reported per target note. */
	perTargetLimit?: number;
}

/**
 * Blank out regions where a mention must not count, preserving every offset.
 *
 * @returns Text of identical length with masked regions replaced by spaces.
 */
export function maskUnlinkableRegions(content: string): string {
	const blank = (match: string): string => match.replace(/[^\n]/g, ' ');

	let masked = content;
	// Frontmatter block, only when it opens the document.
	masked = masked.replace(/^---\r?\n[\s\S]*?\r?\n---(\r?\n|$)/, blank);
	// Fenced code, then inline code.
	masked = masked.replace(/```[\s\S]*?```/g, blank);
	masked = masked.replace(/`[^`\n]*`/g, blank);
	// Existing links of both flavours, including embeds.
	masked = masked.replace(/!?\[\[[^\]]*\]\]/g, blank);
	masked = masked.replace(/!?\[[^\]]*\]\([^)]*\)/g, blank);
	// Bare URLs, so a title appearing inside a path is not "mentioned".
	masked = masked.replace(/\bhttps?:\/\/\S+/gi, blank);
	return masked;
}

/**
 * Find unlinked mentions of `targets` inside one note.
 *
 * @param sourcePath Path of the note being scanned; it never mentions itself.
 * @param content Raw file content.
 */
export function findUnlinkedMentionsInNote(
	sourcePath: string,
	content: string,
	targets: readonly MentionTarget[],
	options: UnlinkedMentionOptions,
): UnlinkedMention[] {
	const masked = maskUnlinkableRegions(content);
	// Longest titles first so a longer title claims its span before a shorter one can.
	const ordered = targets
		.filter((target) => target.path !== sourcePath && target.title.length >= options.minLength)
		.slice()
		.sort((a, b) => b.title.length - a.title.length || a.title.localeCompare(b.title));

	const claimed: [number, number][] = [];
	const overlaps = (start: number, end: number): boolean =>
		claimed.some(([from, to]) => start < to && end > from);

	const mentions: UnlinkedMention[] = [];
	const perTarget = new Map<string, number>();

	for (const target of ordered) {
		for (const [start, end] of findWholeWordOccurrences(masked, target.title)) {
			if (overlaps(start, end)) continue;

			const seen = perTarget.get(target.path) ?? 0;
			if (options.perTargetLimit !== undefined && seen >= options.perTargetLimit) break;

			claimed.push([start, end]);
			perTarget.set(target.path, seen + 1);

			const position = offsetToPosition(content, start);
			const { snippet, range } = contextSnippet(content, start, end);
			mentions.push({
				sourcePath,
				targetPath: target.path,
				targetTitle: target.title,
				line: position.line,
				col: position.col,
				matchedText: content.slice(start, end),
				context: snippet,
				contextRange: range,
			});
		}
	}

	mentions.sort((a, b) => a.line - b.line || a.col - b.col);
	return options.limit === undefined ? mentions : mentions.slice(0, options.limit);
}

/** Distinct target notes among a set of mentions. */
export function distinctTargets(mentions: readonly UnlinkedMention[]): string[] {
	return Array.from(new Set(mentions.map((mention) => mention.targetPath)));
}
