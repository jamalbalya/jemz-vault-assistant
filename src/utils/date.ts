/**
 * Date helpers.
 *
 * Every function works in the user's local timezone, and date-only strings (`2026-06-15`)
 * parse to local midnight. Services that compare dates accept an injectable "now" so the
 * behaviour is deterministic under test.
 */

/** Milliseconds in a day. */
export const MS_PER_DAY = 86_400_000;

/**
 * Format a timestamp using the token subset the plugin needs.
 *
 * Supported tokens: `YYYY`, `MM`, `DD`, `HH`, `mm`, `ss`.
 */
export function formatDate(input: number | Date, pattern = 'YYYY-MM-DD'): string {
	const date = input instanceof Date ? input : new Date(input);
	if (Number.isNaN(date.getTime())) return '';
	const pad = (value: number, width = 2): string => String(value).padStart(width, '0');
	const replacements: Record<string, string> = {
		YYYY: pad(date.getFullYear(), 4),
		MM: pad(date.getMonth() + 1),
		DD: pad(date.getDate()),
		HH: pad(date.getHours()),
		mm: pad(date.getMinutes()),
		ss: pad(date.getSeconds()),
	};
	return pattern.replace(/YYYY|MM|DD|HH|mm|ss/g, (token) => replacements[token] ?? token);
}

/**
 * Parse a frontmatter date value into epoch milliseconds.
 *
 * Accepts `Date` objects, epoch numbers, `YYYY-MM-DD`, `YYYY-MM-DD HH:mm`, and anything
 * `Date.parse` understands. Date-only strings resolve to local midnight so that "created on
 * 2026-06-15" means that calendar day in the user's timezone.
 *
 * @returns Epoch milliseconds, or null when the value is absent or unparseable.
 */
export function parseDateValue(value: unknown): number | null {
	if (value === null || value === undefined) return null;

	if (value instanceof Date) {
		return Number.isNaN(value.getTime()) ? null : value.getTime();
	}
	if (typeof value === 'number') {
		return Number.isFinite(value) ? value : null;
	}
	if (typeof value !== 'string') return null;

	const text = value.trim();
	if (text.length === 0) return null;

	const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
	if (dateOnly) {
		const year = Number(dateOnly[1]);
		const month = Number(dateOnly[2]);
		const day = Number(dateOnly[3]);
		if (month < 1 || month > 12 || day < 1 || day > 31) return null;
		const parsed = new Date(year, month - 1, day);
		// Reject impossible days such as 2026-02-31, which JS would roll forward.
		if (parsed.getMonth() !== month - 1 || parsed.getDate() !== day) return null;
		return parsed.getTime();
	}

	const dateTime = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(text);
	if (dateTime) {
		return new Date(
			Number(dateTime[1]),
			Number(dateTime[2]) - 1,
			Number(dateTime[3]),
			Number(dateTime[4]),
			Number(dateTime[5]),
			Number(dateTime[6] ?? 0),
		).getTime();
	}

	const parsed = Date.parse(text);
	return Number.isNaN(parsed) ? null : parsed;
}

/** Local midnight of the day containing `input`. */
export function startOfDay(input: number | Date): number {
	const date = input instanceof Date ? new Date(input.getTime()) : new Date(input);
	date.setHours(0, 0, 0, 0);
	return date.getTime();
}

/** Whole days between two instants, measured from local midnight to local midnight. */
export function daysBetween(from: number | Date, to: number | Date): number {
	return Math.round((startOfDay(to) - startOfDay(from)) / MS_PER_DAY);
}

/** How many whole days have elapsed since `timestamp`, relative to `now`. */
export function daysSince(timestamp: number, now: number = Date.now()): number {
	return daysBetween(timestamp, now);
}

/** Whether two instants fall on the same local calendar day. */
export function isSameDay(a: number | Date, b: number | Date): boolean {
	return startOfDay(a) === startOfDay(b);
}

/** Whether two instants share a month and day, ignoring the year. */
export function isSameMonthDay(a: number | Date, b: number | Date): boolean {
	const dateA = a instanceof Date ? a : new Date(a);
	const dateB = b instanceof Date ? b : new Date(b);
	return dateA.getMonth() === dateB.getMonth() && dateA.getDate() === dateB.getDate();
}

/** Whether `timestamp` falls within the last `days` days, counting today as day zero. */
export function isWithinDays(timestamp: number, days: number, now: number = Date.now()): boolean {
	const elapsed = daysBetween(timestamp, now);
	return elapsed >= 0 && elapsed <= days;
}

/** Short relative description such as `today`, `3 days ago`, `in 2 days`. */
export function formatRelative(timestamp: number, now: number = Date.now()): string {
	const days = daysBetween(timestamp, now);
	if (days === 0) return 'today';
	if (days === 1) return 'yesterday';
	if (days === -1) return 'tomorrow';
	if (days > 1) {
		if (days < 30) return `${days} days ago`;
		if (days < 365) return `${Math.floor(days / 30)} months ago`;
		return `${Math.floor(days / 365)} years ago`;
	}
	const ahead = Math.abs(days);
	if (ahead < 30) return `in ${ahead} days`;
	if (ahead < 365) return `in ${Math.floor(ahead / 30)} months`;
	return `in ${Math.floor(ahead / 365)} years`;
}

/** Timestamp formatted for a backup folder name: `YYYY-MM-DD-HH-mm-ss`. */
export function backupStamp(input: number | Date = Date.now()): string {
	return formatDate(input, 'YYYY-MM-DD-HH-mm-ss');
}
