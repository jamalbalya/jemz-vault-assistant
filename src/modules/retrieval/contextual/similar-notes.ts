/**
 * Similar notes, computed locally.
 *
 * No AI and no network: similarity is the blend of three signals a vault already contains —
 * shared tags, shared links, and title likeness. That keeps the feature instant, private,
 * and explainable, since the UI can show exactly which tags or links produced the score.
 */

import type { NoteRecord } from '../../../types/note';
import type { SimilarNote } from '../../../types/search';
import { similarity } from '../../../utils/levenshtein';

/** Signal weights. Tags and links carry more signal than a similar-looking title. */
const TAG_WEIGHT = 0.45;
const LINK_WEIGHT = 0.35;
const TITLE_WEIGHT = 0.2;

export interface SimilarNotesOptions {
	/** Drop results below this score. */
	minScore: number;
	/** Cap the result length. */
	limit: number;
	/** Skip archived notes. */
	excludeArchived?: boolean;
}

/** Jaccard overlap of two sets, plus the members they share. */
function overlap(a: readonly string[], b: readonly string[]): { score: number; shared: string[] } {
	if (a.length === 0 || b.length === 0) return { score: 0, shared: [] };
	const setB = new Set(b);
	const shared = a.filter((item) => setB.has(item));
	if (shared.length === 0) return { score: 0, shared: [] };
	const union = new Set([...a, ...b]).size;
	return { score: union === 0 ? 0 : shared.length / union, shared };
}

/**
 * Rank notes similar to `subject`.
 *
 * The subject itself, and anything it already links to or that links to it, are excluded —
 * the point is to surface connections the user has *not* made yet.
 */
export function findSimilarNotes(
	subject: NoteRecord,
	records: readonly NoteRecord[],
	options: SimilarNotesOptions,
): SimilarNote[] {
	const alreadyConnected = new Set<string>([
		subject.path,
		...subject.resolvedLinks,
		...subject.backlinks,
	]);

	const results: SimilarNote[] = [];

	for (const candidate of records) {
		if (candidate.isAttachment) continue;
		if (alreadyConnected.has(candidate.path)) continue;
		if (options.excludeArchived && candidate.status?.toLowerCase() === 'archived') continue;

		const tags = overlap(subject.tags, candidate.tags);
		const links = overlap(subject.resolvedLinks, candidate.resolvedLinks);
		const titleSimilarity = similarity(
			subject.basename.toLowerCase(),
			candidate.basename.toLowerCase(),
		);

		const score =
			tags.score * TAG_WEIGHT + links.score * LINK_WEIGHT + titleSimilarity * TITLE_WEIGHT;
		if (score < options.minScore) continue;

		results.push({
			path: candidate.path,
			title: candidate.basename,
			score: Math.round(score * 1000) / 1000,
			sharedTags: tags.shared,
			sharedLinks: links.shared,
			titleSimilarity: Math.round(titleSimilarity * 1000) / 1000,
		});
	}

	results.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
	return results.slice(0, options.limit);
}
