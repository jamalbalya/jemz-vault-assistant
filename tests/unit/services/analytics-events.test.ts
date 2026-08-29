/**
 * Every analytics call site names an event that actually exists.
 *
 * `ANALYTICS_EVENTS` is the privacy boundary: anything not on it is dropped rather than
 * sanitised, which is the right default but makes a mistyped id fail silently. An opted-in
 * user's capture and triage counters simply stay at zero, and the only signal is a warning in
 * their console — on a routine action, from a plugin whose changelog promises it does not
 * write to the console during ordinary use.
 *
 * Nothing about that shows up in a normal test: `track` returns a boolean nobody checks, and
 * with analytics off (the default) the id is never even looked at. So the ids are checked
 * against the source text instead, the same way the mobile-compatibility guard is.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ANALYTICS_EVENTS, isAnalyticsEvent } from '../../../src/services/analytics-service';
import { REPO_ROOT } from '../../helpers/vault-fixture';

function sourceFiles(dir: string, out: string[] = []): string[] {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) sourceFiles(full, out);
		else if (entry.name.endsWith('.ts')) out.push(full);
	}
	return out;
}

/** Every `track('…')` / `trackDuration('…', …)` literal outside the service itself. */
function trackedEventIds(): { file: string; event: string }[] {
	const found: { file: string; event: string }[] = [];
	for (const file of sourceFiles(join(REPO_ROOT, 'src'))) {
		if (file.endsWith(join('services', 'analytics-service.ts'))) continue;
		const content = readFileSync(file, 'utf8');
		const pattern = /\.track(?:Duration)?\(\s*'([^']*)'/g;
		for (const match of content.matchAll(pattern)) {
			found.push({ file, event: match[1] as string });
		}
	}
	return found;
}

describe('analytics call sites', () => {
	it('finds the call sites at all, so the guard cannot pass vacuously', () => {
		expect(trackedEventIds().length).toBeGreaterThan(0);
	});

	it('only ever names an allow-listed event', () => {
		const offenders = trackedEventIds()
			.filter(({ event }) => !isAnalyticsEvent(event))
			.map(({ file, event }) => `${file} tracks "${event}"`);

		expect(offenders).toEqual([]);
	});

	it('keeps the allow-list free of duplicates', () => {
		expect(new Set(ANALYTICS_EVENTS).size).toBe(ANALYTICS_EVENTS.length);
	});
});
