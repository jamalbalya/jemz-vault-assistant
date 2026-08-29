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

/**
 * Characters that separate whole words, matching the boundary rule
 * {@link findWholeWordOccurrences} applies.
 */
const WORD_SEPARATOR = /[^\p{L}\p{N}_]+/u;

/** Lower-cased whole words of a text. */
function wordsOf(text: string): Set<string> {
	const words = new Set<string>();
	for (const part of text.toLowerCase().split(WORD_SEPARATOR)) {
		if (part.length > 0) words.add(part);
	}
	return words;
}

/** The first whole word of a title, lower-cased, or null when it has none. */
function firstWordOf(title: string): string | null {
	for (const part of title.toLowerCase().split(WORD_SEPARATOR)) {
		if (part.length > 0) return part;
	}
	return null;
}

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

/** One target, with the word its title requires the note to contain. */
interface PreparedTarget {
	readonly target: MentionTarget;
	/** Lower-cased first whole word of the title, or null when it has none. */
	readonly firstWord: string | null;
}

/**
 * Targets ordered and annotated once, ready to scan any number of notes.
 *
 * The ordering depends only on the target list, so the whole-vault pass must not rebuild it
 * per note: that alone is an n log n sort repeated n times, and on a 2 000 note vault it
 * costs more than all the text scanning put together.
 */
export interface PreparedMentionTargets {
	readonly minLength: number;
	readonly entries: readonly PreparedTarget[];
}

/**
 * Order targets longest-title-first and record the word each one needs.
 *
 * Longest first is what lets a longer title claim its span before a shorter one can, so the
 * order is part of the result, not an optimisation.
 */
export function prepareMentionTargets(
	targets: readonly MentionTarget[],
	minLength: number,
): PreparedMentionTargets {
	const entries = targets
		.filter((target) => target.title.length >= minLength)
		.slice()
		.sort((a, b) => b.title.length - a.title.length || a.title.localeCompare(b.title))
		.map((target) => ({ target, firstWord: firstWordOf(target.title) }));
	return { minLength, entries };
}

function isPrepared(
	value: readonly MentionTarget[] | PreparedMentionTargets,
): value is PreparedMentionTargets {
	return !Array.isArray(value);
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
	targets: readonly MentionTarget[] | PreparedMentionTargets,
	options: UnlinkedMentionOptions,
): UnlinkedMention[] {
	const masked = maskUnlinkableRegions(content);
	// Every whole word in this note, collected once. Scanning the body once per title is
	// quadratic in the number of notes, and the whole-vault view runs that for every note —
	// the difference between a click and a minute of frozen UI on a large vault.
	const wordsInNote = wordsOf(masked);
	const prepared = isPrepared(targets)
		? targets
		: prepareMentionTargets(targets, options.minLength);

	const claimed: [number, number][] = [];
	const overlaps = (start: number, end: number): boolean =>
		claimed.some(([from, to]) => start < to && end > from);

	const mentions: UnlinkedMention[] = [];
	const perTarget = new Map<string, number>();

	for (const { target, firstWord } of prepared.entries) {
		// A note never mentions itself.
		if (target.path === sourcePath) continue;
		// A title can only occur here if its first word does, and that word is whole in the
		// body exactly when it is whole in the title: an occurrence is bounded by non-word
		// characters, so the title's interior structure carries over unchanged. The lookup is
		// therefore exact — it rules a target out only when a full scan would have found
		// nothing — and it rules out almost all of them.
		if (firstWord !== null && !wordsInNote.has(firstWord)) continue;

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
