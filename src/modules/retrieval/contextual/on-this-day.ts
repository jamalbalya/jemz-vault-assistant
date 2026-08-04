/**
 * On This Day: notes created on the same month and day in earlier years.
 *
 * The reference date is injected rather than read from the clock so the feature is testable
 * and so a user browsing "what was I doing last June" could be supported later without
 * reworking the logic.
 */

import type { NoteRecord } from '../../../types/note';
import type { OnThisDayEntry } from '../../../types/search';
import { isSameMonthDay } from '../../../utils/date';

export interface OnThisDayOptions {
	/** Include notes created in the reference year itself. Off by default. */
	includeCurrentYear?: boolean;
	/** Leave archived notes out. */
	excludeArchived?: boolean;
}

/**
 * Group notes created on this month/day in previous years.
 *
 * @param records Candidate notes.
 * @param reference Instant treated as "today".
 * @returns Entries grouped by year, most recent year first, notes newest first inside each.
 */
export function findOnThisDay(
	records: readonly NoteRecord[],
	reference: number,
	options: OnThisDayOptions = {},
): OnThisDayEntry[] {
	const referenceYear = new Date(reference).getFullYear();
	const byYear = new Map<number, { path: string; title: string; created: number }[]>();

	for (const record of records) {
		if (record.isAttachment) continue;
		if (options.excludeArchived && record.status?.toLowerCase() === 'archived') continue;

		const created = new Date(record.created);
		const year = created.getFullYear();
		if (!options.includeCurrentYear && year >= referenceYear) continue;
		if (!isSameMonthDay(created, reference)) continue;

		const entries = byYear.get(year) ?? [];
		entries.push({ path: record.path, title: record.basename, created: record.created });
		byYear.set(year, entries);
	}

	return Array.from(byYear.entries())
		.map(([year, notes]) => ({
			year,
			notes: notes.sort((a, b) => b.created - a.created || a.path.localeCompare(b.path)),
		}))
		.sort((a, b) => b.year - a.year);
}

/** Total notes across every year group. */
export function countOnThisDay(entries: readonly OnThisDayEntry[]): number {
	return entries.reduce((sum, entry) => sum + entry.notes.length, 0);
}
