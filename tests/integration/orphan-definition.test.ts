/**
 * The Health tab and the Find tab must mean the same thing by "orphan".
 *
 * They answer the question through completely different code — a detector running over a
 * scan scope, and a special saved view running over the retrieval candidates — and both
 * carry comments promising they agree, because the failure is a user reading two different
 * counts for one idea and having no way to tell which is right.
 *
 * The case that separates them is a note whose only link points at itself. That is not an
 * edge in either direction, so it is exactly as disconnected as a note with no links at all.
 */

import { describe, expect, it } from 'vitest';
import { createHarness } from '../helpers/harness';
import { buildVault, day } from '../helpers/vault-fixture';
import type { SavedView } from '../../src/types/search';

/** Paths the Health tab calls orphans. */
async function healthOrphans(
	harness: Awaited<ReturnType<typeof createHarness>>,
): Promise<string[]> {
	const report = await harness.engine.scan('full');
	return report.issues
		.filter((issue) => issue.type === 'orphan-note')
		.map((issue) => issue.path)
		.sort();
}

/** Paths the Find tab's Orphans view lists. */
async function findOrphans(harness: Awaited<ReturnType<typeof createHarness>>): Promise<string[]> {
	const view = harness.retrieval.views().find((entry: SavedView) => entry.special === 'orphans');
	expect(view, 'no built-in Orphans view').toBeDefined();
	const response = await harness.retrieval.runView(view as SavedView);
	return response.results.map((result) => result.path).sort();
}

describe('the two orphan lists', () => {
	it('agree about a note whose only link points at itself', async () => {
		const harness = await createHarness(
			buildVault([
				{ path: 'Self.md', content: '# Self\n\nSee [[Self]].' },
				{ path: 'Lonely.md', content: '# Lonely' },
				{ path: 'Linked.md', content: '# Linked\n\nSee [[Lonely]].' },
			]),
			{ now: day('2026-06-15') },
		);

		const health = await healthOrphans(harness);
		const find = await findOrphans(harness);

		// `Self.md` is disconnected in both directions; `Linked.md` points outward and
		// `Lonely.md` is pointed at, so neither is an orphan.
		expect(health).toEqual(['Self.md']);
		expect(find).toEqual(health);
	});

	it('agree about a note with a broken link, which still points outward', async () => {
		const harness = await createHarness(
			buildVault([
				{ path: 'Broken.md', content: '# Broken\n\nSee [[Nowhere]].' },
				{ path: 'Alone.md', content: '# Alone' },
			]),
			{ now: day('2026-06-15') },
		);

		expect(await healthOrphans(harness)).toEqual(['Alone.md']);
		expect(await findOrphans(harness)).toEqual(await healthOrphans(harness));
	});
});
