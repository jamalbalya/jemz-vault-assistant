/**
 * Levenshtein edit distance and the similarity ratio built on top of it.
 *
 * Used by duplicate-title detection and tag-inconsistency detection, both of which compare
 * every pair in a set, so the implementation keeps allocation to two rolling rows and bails
 * out early once the distance cannot beat the caller's cutoff.
 */

/**
 * Edit distance between two strings.
 *
 * @param a First string.
 * @param b Second string.
 * @param maxDistance Optional cutoff. When the distance provably exceeds it, the function
 *   returns `maxDistance + 1` instead of the true distance, which lets pairwise scans skip
 *   most of the work.
 * @returns The edit distance, or `maxDistance + 1` when the cutoff was exceeded.
 */
export function levenshtein(a: string, b: string, maxDistance?: number): number {
	if (a === b) return 0;
	if (a.length === 0) return b.length;
	if (b.length === 0) return a.length;

	const cutoff = maxDistance ?? Number.POSITIVE_INFINITY;
	// A length difference alone already exceeds the cutoff — no need to build the matrix.
	if (Math.abs(a.length - b.length) > cutoff) return cutoff + 1;

	// Keep the shorter string on the inner axis so the rows stay small.
	let source = a;
	let target = b;
	if (source.length > target.length) {
		const swap = source;
		source = target;
		target = swap;
	}

	const width = source.length + 1;
	let previous = new Array<number>(width);
	let current = new Array<number>(width);

	for (let i = 0; i < width; i++) previous[i] = i;

	for (let j = 1; j <= target.length; j++) {
		current[0] = j;
		let rowMinimum = j;
		const targetChar = target.charCodeAt(j - 1);

		for (let i = 1; i < width; i++) {
			const substitutionCost = source.charCodeAt(i - 1) === targetChar ? 0 : 1;
			const deletion = (previous[i] ?? 0) + 1;
			const insertion = (current[i - 1] ?? 0) + 1;
			const substitution = (previous[i - 1] ?? 0) + substitutionCost;
			const value = Math.min(deletion, insertion, substitution);
			current[i] = value;
			if (value < rowMinimum) rowMinimum = value;
		}

		// Every remaining row can only add to the minimum, so this bound is safe.
		if (rowMinimum > cutoff) return cutoff + 1;

		const swap = previous;
		previous = current;
		current = swap;
	}

	return previous[width - 1] ?? 0;
}

/**
 * Similarity of two strings expressed as `1 - distance / longestLength`.
 *
 * @returns A value in `[0, 1]`; `1` means identical, `0` means nothing in common.
 */
export function similarity(a: string, b: string): number {
	if (a === b) return 1;
	const longest = Math.max(a.length, b.length);
	if (longest === 0) return 1;
	return 1 - levenshtein(a, b) / longest;
}

/**
 * Whether two strings are close enough to be considered the same thing.
 *
 * @param threshold Minimum similarity, exclusive at the boundary described by the spec
 *   ("more than 90 percent similar") unless the strings are exactly equal.
 */
export function isSimilar(a: string, b: string, threshold: number): boolean {
	if (a === b) return true;
	return similarity(a, b) > threshold;
}
