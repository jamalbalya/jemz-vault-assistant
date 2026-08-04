/**
 * Duplicate title detection.
 *
 * Two notes with the same name are almost always an accident — a second capture of the same
 * thought, or a file Obsidian auto-renamed to `Note 2`. The check runs in two passes because
 * the two failure modes are different problems:
 *
 *  1. An exact pass on the normalised title, which collapses copy counters (`Ideas 2`) but
 *     deliberately keeps years (`Old Project 2024` vs `Old Project 2025`) apart. Everything in
 *     one bucket is reported as a single group issue, not as N pairwise ones.
 *  2. A fuzzy pass over the titles that survived pass 1 alone. Similarity alone is a bad rule
 *     for short names — `orphan-idea-1`/`orphan-idea-2` and `stale-note-2023`/`stale-note-2024`
 *     are more than 90 % similar yet are siblings rather than duplicates — so a minimum length
 *     gate keeps the pass off names too short to carry that much meaning.
 *
 * The pairwise pass is O(n²) over the *unique* titles only, which is what keeps it affordable;
 * the scan engine may still hand it to a worker on very large vaults.
 */

import type {
	Detector,
	DetectorContext,
	DuplicateTitleIssueData,
	HealthIssue,
} from '../../../types/health';
import type { NoteRecord } from '../../../types/note';
import { STRINGS } from '../../../core/strings';
import { similarity } from '../../../utils/levenshtein';
import { normalizeTitle } from '../../../utils/string';
import { createIssue, stableGroupKey } from '../issue';

/**
 * Total order over vault paths.
 *
 * `localeCompare` on its own returns 0 for strings that differ only by collation-ignorable
 * characters — a soft hyphen or a zero-width space somewhere in a folder name is enough — which
 * would leave `sort` free to keep whatever order the scan happened to visit the notes in. The
 * code-unit fallback breaks exactly those ties, so the reported primary file is the same on
 * every scan.
 */
function comparePaths(a: string, b: string): number {
	const byLocale = a.localeCompare(b);
	if (byLocale !== 0) return byLocale;
	if (a < b) return -1;
	if (a > b) return 1;
	return 0;
}

/** Build the single issue that represents one set of duplicate notes. */
function buildIssue(members: readonly NoteRecord[], score: number, exact: boolean): HealthIssue {
	// Sorting first makes the reported primary file, the listed paths and the id all
	// independent of the order the scan happened to visit the notes in.
	const ordered = [...members].sort((a, b) => comparePaths(a.path, b.path));
	const paths = ordered.map((record) => record.path);
	const primary = ordered[0];
	// Derived from the primary rather than passed in: the fuzzy pass compares two *different*
	// normalised titles, and recording whichever one the scan reached first would make the
	// payload depend on visit order even though the id does not.
	const normalizedTitle = primary ? normalizeTitle(primary.basename) : '';
	const data: DuplicateTitleIssueData = {
		kind: 'duplicate-title',
		paths,
		normalizedTitle,
		similarity: score,
		exact,
	};

	return createIssue({
		type: 'duplicate-title',
		path: primary?.path ?? '',
		title: primary?.basename ?? normalizedTitle,
		detail: exact
			? `${STRINGS.health.typeDescriptions['duplicate-title']} ${paths.join(', ')}`
			: `${STRINGS.contextual.similarity(score)} — ${paths.join(', ')}`,
		severity: 'medium',
		data,
		idParts: [stableGroupKey(paths)],
	});
}

/** One note whose normalised title is unique so far, kept for the fuzzy pass. */
interface FuzzyCandidate {
	readonly record: NoteRecord;
	readonly title: string;
}

/**
 * Reports notes that share a title exactly, plus near-identical long titles.
 *
 * Works purely off `NoteRecord.basename`, so it needs no file contents and stays synchronous.
 */
const duplicateTitlesDetector: Detector = {
	type: 'duplicate-title',
	label: STRINGS.health.types['duplicate-title'],

	run(context: DetectorContext): HealthIssue[] {
		const { duplicateMinFuzzyLength, duplicateSimilarityThreshold } = context.settings;
		const groups = new Map<string, NoteRecord[]>();

		for (const record of context.notes) {
			if (record.isAttachment) continue;
			const key = normalizeTitle(record.basename);
			// A basename that normalises to nothing (all whitespace) carries no signal.
			if (key.length === 0) continue;
			const bucket = groups.get(key);
			if (bucket) bucket.push(record);
			else groups.set(key, [record]);
		}

		const issues: HealthIssue[] = [];
		const candidates: FuzzyCandidate[] = [];

		for (const [title, members] of groups) {
			if (members.length >= 2) {
				issues.push(buildIssue(members, 1, true));
				continue;
			}
			const only = members[0];
			// Already-grouped titles are skipped: they are reported once, as a group.
			if (only && only.basename.length >= duplicateMinFuzzyLength) {
				candidates.push({ record: only, title });
			}
		}

		for (let i = 0; i < candidates.length; i++) {
			const first = candidates[i];
			if (!first) continue;
			for (let j = i + 1; j < candidates.length; j++) {
				const second = candidates[j];
				if (!second) continue;
				const score = similarity(first.title, second.title);
				if (score > duplicateSimilarityThreshold) {
					issues.push(buildIssue([first.record, second.record], score, false));
				}
			}
		}

		return issues;
	},
};

export default duplicateTitlesDetector;
