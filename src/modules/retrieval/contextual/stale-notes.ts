/**
 * Stale notes: things untouched long enough to be worth a second look.
 *
 * "Modified" prefers the frontmatter `modified` value over the file's mtime, because a
 * vault that has been synced, restored, or re-cloned has file timestamps that say nothing
 * about when the user last thought about the note. The index already applies that
 * precedence when it builds `NoteRecord.modified`.
 *
 * Archived notes are excluded by default: they have already been dealt with, so surfacing
 * them as "needs attention" is noise.
 */

import type { NoteRecord } from '../../../types/note';
import type { StaleNote } from '../../../types/search';
import { daysBetween } from '../../../utils/date';

export interface StaleNotesOptions {
	/** Notes untouched for at least this many days are stale. */
	thresholdDays: number;
	/** Skip notes with `status: archived`. Defaults to true. */
	excludeArchived?: boolean;
	/** Cap the result length. */
	limit?: number;
}

/**
 * Find stale notes, oldest first.
 *
 * @param reference Instant treated as "now".
 */
export function findStaleNotes(
	records: readonly NoteRecord[],
	reference: number,
	options: StaleNotesOptions,
): StaleNote[] {
	const excludeArchived = options.excludeArchived ?? true;
	const results: StaleNote[] = [];

	for (const record of records) {
		if (record.isAttachment) continue;
		if (excludeArchived && record.status?.toLowerCase() === 'archived') continue;

		const daysStale = daysBetween(record.modified, reference);
		// A note modified in the future (clock skew, or a frontmatter typo) is not stale.
		if (daysStale < options.thresholdDays) continue;

		results.push({
			path: record.path,
			title: record.basename,
			modified: record.modified,
			daysStale,
		});
	}

	results.sort((a, b) => b.daysStale - a.daysStale || a.path.localeCompare(b.path));
	return options.limit === undefined ? results : results.slice(0, options.limit);
}
