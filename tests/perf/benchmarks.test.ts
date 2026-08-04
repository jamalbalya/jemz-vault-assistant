/**
 * Performance benchmarks against the targets in main spec section 10.
 *
 * Run with `npm run test:perf`; excluded from the default suite because generating a 10 000
 * note vault takes seconds and would slow every ordinary run.
 *
 * These numbers are measured against the in-memory vault, so they isolate the plugin's own
 * cost from disk I/O. That makes them a floor rather than a promise: real Obsidian adds file
 * reads on top. The budgets below are therefore checked with headroom, and the manual
 * checklist re-measures the same operations in the real app.
 */

import { describe, expect, it } from 'vitest';
import { createHarness } from '../helpers/harness';
import { buildVault, day, type FixtureFile } from '../helpers/vault-fixture';
import type { App } from '../mocks/obsidian';

/** Budgets from main spec section 10, in milliseconds. */
const BUDGET = {
	indexBuild: 500,
	fullScan10k: 30_000,
	incrementalScan: 2_000,
	search: 500,
	capture: 200,
} as const;

/** Note count per benchmark tier. */
const TIERS = [1_000, 5_000, 10_000] as const;

const LOREM =
	'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor ' +
	'incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud. ';

/**
 * Generate a vault of `count` notes with a realistic mix: most notes link to a neighbour,
 * roughly one in fifty has a broken link, one in a hundred is empty, and tags repeat across
 * a small vocabulary so the tag pass has real work to do.
 */
function generateVault(count: number): App {
	const files: FixtureFile[] = [];
	const tags = ['project', 'area', 'resource', 'archive', 'idea', 'note', 'meeting'];

	for (let i = 0; i < count; i++) {
		const neighbour = (i + 1) % count;
		const broken = i % 50 === 0 ? `\n\nSee [[Missing Note ${i}]].` : '';
		const body =
			i % 100 === 0
				? ''
				: `# Note ${i}\n\n${LOREM.repeat(3)}\n\nRelated: [[note-${neighbour}]].${broken}`;

		files.push({
			path: `notes/folder-${i % 50}/note-${i}.md`,
			frontmatter: {
				created: '2026-01-01',
				modified: '2026-06-01',
				type: 'note',
				status: 'active',
				tags: [tags[i % tags.length] as string],
			},
			content: body,
		});
	}

	// A handful of attachments so that pass is not trivially empty.
	for (let i = 0; i < 50; i++) {
		files.push({ path: `attachments/file-${i}.png`, content: 'binary:1024', size: 1024 });
	}

	return buildVault(files, `perf-${count}`);
}

describe('performance', () => {
	for (const count of TIERS) {
		describe(`${count.toLocaleString()} notes`, () => {
			it('builds the index within the load budget', async () => {
				const app = generateVault(count);
				const startedAt = performance.now();
				const harness = await createHarness(app, { now: day('2026-06-15') });
				const elapsed = performance.now() - startedAt;

				// The harness builds the index as part of construction, which is exactly
				// what the plugin does on layout-ready.
				expect(harness.index.size).toBeGreaterThanOrEqual(count);

				console.info(`  index build (${count}): ${elapsed.toFixed(0)}ms`);
				expect(elapsed).toBeLessThan(BUDGET.indexBuild * (count / 1000));
			}, 120_000);

			it('completes a full scan within budget', async () => {
				const harness = await createHarness(generateVault(count), {
					now: day('2026-06-15'),
				});

				const startedAt = performance.now();
				const report = await harness.engine.scan('full');
				const elapsed = performance.now() - startedAt;

				console.info(
					`  full scan (${count}): ${elapsed.toFixed(0)}ms, ${report.issues.length} issues`,
				);
				expect(report.filesScanned).toBeGreaterThanOrEqual(count);
				expect(elapsed).toBeLessThan(BUDGET.fullScan10k);
			}, 180_000);

			it('searches within budget', async () => {
				const harness = await createHarness(generateVault(count), {
					now: day('2026-06-15'),
				});
				// Warm the content index the way opening the Find tab would.
				await harness.retrieval.search({
					keyword: 'lorem',
					filters: [],
					logic: 'and',
					sort: { field: 'relevance', direction: 'desc' },
				});

				const startedAt = performance.now();
				const response = await harness.retrieval.search({
					keyword: 'consectetur',
					filters: [],
					logic: 'and',
					sort: { field: 'relevance', direction: 'desc' },
				});
				const elapsed = performance.now() - startedAt;

				console.info(
					`  search (${count}): ${elapsed.toFixed(0)}ms, ${response.total} hits`,
				);
				expect(response.total).toBeGreaterThan(0);
				expect(elapsed).toBeLessThan(BUDGET.search);
			}, 180_000);
		});
	}

	it('runs an incremental scan quickly once the content index is warm', async () => {
		const harness = await createHarness(generateVault(10_000), {
			now: day('2026-06-15'),
		});
		await harness.engine.scan('full');

		const file = harness.app.vault.getFileByPath('notes/folder-0/note-0.md');
		expect(file).not.toBeNull();
		if (!file) return;
		await harness.app.vault.modify(file, '# Changed\n\nNew content.');
		harness.app.metadataCache.refresh();
		harness.content.invalidate(file.path);

		const startedAt = performance.now();
		await harness.engine.scan('incremental');
		const elapsed = performance.now() - startedAt;

		console.info(`  incremental scan (10000): ${elapsed.toFixed(0)}ms`);
		expect(elapsed).toBeLessThan(BUDGET.incrementalScan);
	}, 240_000);

	it('captures a note quickly in a large vault', async () => {
		const harness = await createHarness(generateVault(10_000), {
			now: day('2026-06-15'),
		});

		const startedAt = performance.now();
		await harness.capture.capture({
			title: 'A quick thought',
			body: 'Something worth keeping.',
			tags: ['idea'],
			type: 'capture',
			source: '',
			project: null,
		});
		const elapsed = performance.now() - startedAt;

		console.info(`  capture (10000): ${elapsed.toFixed(0)}ms`);
		expect(elapsed).toBeLessThan(BUDGET.capture);
	}, 240_000);

	it('keeps the content cache within its memory budget', async () => {
		const harness = await createHarness(generateVault(10_000), {
			now: day('2026-06-15'),
		});
		await harness.engine.scan('full');

		let characters = 0;
		for (const record of harness.index.notes()) {
			characters += harness.content.peekBody(record.path)?.length ?? 0;
		}
		const megabytes = (characters * 2) / (1024 * 1024);

		console.info(`  cached body text (10000): ${megabytes.toFixed(1)}MB`);
		// Well inside the 100MB overall target, leaving room for the rest of the plugin.
		expect(megabytes).toBeLessThan(60);
	}, 240_000);
});
