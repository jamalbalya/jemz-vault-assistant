/**
 * Fuzzy string matching for the search box.
 *
 * Two strategies, tried in order:
 *  1. Subsequence matching with positional bonuses — fast, and handles dropped characters
 *     (`projct` still matches `project`).
 *  2. Edit-distance fallback per word — catches substitutions and transpositions that a
 *     subsequence scan cannot (`projekt`, `porject`).
 */

import { levenshtein, similarity } from './levenshtein';

export interface FuzzyMatchResult {
	/** Relevance in `[0, 1]`. */
	readonly score: number;
	/** Indices in the target that matched, ascending. Empty for edit-distance matches. */
	readonly positions: readonly number[];
}

/** Characters that begin a new "word" for bonus purposes. */
function isBoundary(previous: string | undefined): boolean {
	return previous === undefined || /[\s\-_/.,:;([{]/.test(previous);
}

/**
 * Score `query` against `target` using an in-order character scan.
 *
 * @returns null when the query is not a subsequence of the target.
 */
export function subsequenceMatch(query: string, target: string): FuzzyMatchResult | null {
	if (query.length === 0) return { score: 1, positions: [] };
	if (target.length === 0) return null;

	const lowerQuery = query.toLowerCase();
	const lowerTarget = target.toLowerCase();
	const positions: number[] = [];

	let targetIndex = 0;
	let raw = 0;
	let previousMatchIndex = -2;

	for (let q = 0; q < lowerQuery.length; q++) {
		const wanted = lowerQuery[q];
		let found = -1;
		for (let t = targetIndex; t < lowerTarget.length; t++) {
			if (lowerTarget[t] === wanted) {
				found = t;
				break;
			}
		}
		if (found === -1) return null;

		positions.push(found);
		raw += 1;
		if (found === previousMatchIndex + 1) raw += 2; // consecutive run
		if (found === 0)
			raw += 4; // matches the very start
		else if (isBoundary(target[found - 1])) raw += 3; // start of a word
		if (target[found] === query[q]) raw += 0.5; // exact case

		const gap = found - previousMatchIndex - 1;
		if (previousMatchIndex >= 0 && gap > 0) raw -= Math.min(gap * 0.25, 2);

		previousMatchIndex = found;
		targetIndex = found + 1;
	}

	// Shorter targets are better matches for the same query.
	const lengthRatio = query.length / target.length;
	const maxRaw = query.length * 6.5;
	const score = Math.max(0, Math.min(1, (raw / maxRaw) * 0.85 + lengthRatio * 0.15));
	return { score, positions };
}

/**
 * Best edit-distance similarity between `query` and any single word of `target`,
 * plus the whole target as one candidate.
 */
export function wordSimilarity(query: string, target: string): number {
	const lowerQuery = query.toLowerCase();
	const words = target
		.toLowerCase()
		.split(/[\s\-_/.,:;([{]+/)
		.filter((w) => w.length > 0);
	let best = similarity(lowerQuery, target.toLowerCase());
	for (const word of words) {
		// Skip words whose length alone rules out a close match.
		if (Math.abs(word.length - lowerQuery.length) > 3) continue;
		const value = similarity(lowerQuery, word);
		if (value > best) best = value;
	}
	return best;
}

/**
 * Match `query` against `target`.
 *
 * @param sensitivity 0-1 from settings. Higher accepts looser edit-distance matches.
 * @returns null when the target does not match at all.
 */
export function fuzzyMatch(
	query: string,
	target: string,
	sensitivity = 0.4,
): FuzzyMatchResult | null {
	const trimmed = query.trim();
	if (trimmed.length === 0) return { score: 1, positions: [] };

	const lowerQuery = trimmed.toLowerCase();
	const lowerTarget = target.toLowerCase();

	// An exact substring is always the strongest signal.
	const exactIndex = lowerTarget.indexOf(lowerQuery);
	if (exactIndex !== -1) {
		const positions: number[] = [];
		for (let i = 0; i < trimmed.length; i++) positions.push(exactIndex + i);
		const boundaryBonus = exactIndex === 0 || isBoundary(target[exactIndex - 1]) ? 0.1 : 0;
		const lengthRatio = trimmed.length / Math.max(target.length, 1);
		return { score: Math.min(1, 0.8 + boundaryBonus + lengthRatio * 0.1), positions };
	}

	const subsequence = subsequenceMatch(trimmed, target);
	if (subsequence) return subsequence;

	// Fall back to edit distance so substitutions and transpositions still match.
	// sensitivity 0 demands near-identical words, 1 accepts anything above 0.5.
	const minimumSimilarity = 0.85 - sensitivity * 0.35;
	const best = wordSimilarity(trimmed, target);
	if (best >= minimumSimilarity) {
		return { score: Math.min(0.75, best * 0.7), positions: [] };
	}

	return null;
}

/**
 * Rank `items` against `query`, dropping non-matches.
 *
 * @param toText Extracts the searchable text from an item.
 */
export function fuzzyFilter<T>(
	items: readonly T[],
	query: string,
	toText: (item: T) => string,
	sensitivity = 0.4,
): { item: T; score: number; positions: readonly number[] }[] {
	const results: { item: T; score: number; positions: readonly number[] }[] = [];
	for (const item of items) {
		const match = fuzzyMatch(query, toText(item), sensitivity);
		if (match) results.push({ item, score: match.score, positions: match.positions });
	}
	results.sort((a, b) => b.score - a.score);
	return results;
}

/** Merge sorted match indices into contiguous `[start, end)` ranges for highlighting. */
export function positionsToRanges(positions: readonly number[]): [number, number][] {
	if (positions.length === 0) return [];
	const ranges: [number, number][] = [];
	let start = positions[0] as number;
	let end = start + 1;
	for (let i = 1; i < positions.length; i++) {
		const position = positions[i] as number;
		if (position === end) {
			end = position + 1;
		} else {
			ranges.push([start, end]);
			start = position;
			end = position + 1;
		}
	}
	ranges.push([start, end]);
	return ranges;
}

/** Re-export so callers can reach the distance primitive through one module. */
export { levenshtein, similarity };
