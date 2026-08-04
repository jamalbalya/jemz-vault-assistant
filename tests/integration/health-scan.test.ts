/**
 * End-to-end health scan over the real `test-vault/` directory.
 *
 * These are the numbers a human sees when they open the plugin against the manual test
 * vault, so they are asserted exactly. `TEST_VAULT_GROUND_TRUTH.md` explains where each one
 * comes from and why three of them differ from the original TESTING_GUIDE draft.
 */

import { describe, expect, it } from 'vitest';
import type { HealthIssue, IssueType } from '../../src/types/health';
import { createHarness } from '../helpers/harness';
import { loadVaultFromDisk } from '../helpers/vault-fixture';

/** Counts the on-disk fixture is built to produce, with the inbox excluded from scans. */
const EXPECTED_COUNTS: Record<IssueType, number> = {
	'broken-link': 8,
	'orphan-note': 25,
	'empty-note': 3,
	'unused-attachment': 6,
	'duplicate-title': 2,
	'tag-inconsistency': 3,
	'missing-metadata': 1,
	'large-file': 0,
	'corrupted-frontmatter': 1,
};

/** Score derived from the counts above with the shipped default weights. */
const EXPECTED_SCORE = 87;

function pathsOf(issues: readonly HealthIssue[], type: IssueType): string[] {
	return issues
		.filter((issue) => issue.type === type)
		.map((issue) => issue.path)
		.sort();
}

describe('full health scan of the on-disk test vault', () => {
	it('reports exactly the documented issue counts', async () => {
		const harness = await createHarness(loadVaultFromDisk());
		const report = await harness.engine.scan('full');

		expect(report.countsByType).toEqual(EXPECTED_COUNTS);
	});

	it('computes the documented health score', async () => {
		const harness = await createHarness(loadVaultFromDisk());
		const report = await harness.engine.scan('full');

		expect(Math.round(report.score.value)).toBe(EXPECTED_SCORE);
		// 8*0.5 + 25*0.2 + 3*0.3 + 6*0.1 + 2*0.5 + 3*0.3 + 1*0.3 = 12.7
		expect(report.score.totalPenalty).toBeCloseTo(12.7, 5);
	});

	it('finds the eight intended broken links and nothing else', async () => {
		const harness = await createHarness(loadVaultFromDisk());
		const report = await harness.engine.scan('full');

		expect(pathsOf(report.issues, 'broken-link')).toEqual([
			'Problem Notes/broken-link-note.md',
			'Problem Notes/broken-link-note.md',
			'Problem Notes/broken-link-note.md',
			'Problem Notes/multiple-broken-links.md',
			'Problem Notes/multiple-broken-links.md',
			'Problem Notes/multiple-broken-links.md',
			'Problem Notes/multiple-broken-links.md',
			'Problem Notes/multiple-broken-links.md',
		]);
	});

	it('includes all five intentional orphans among the orphans it reports', async () => {
		const harness = await createHarness(loadVaultFromDisk());
		const report = await harness.engine.scan('full');
		const orphans = pathsOf(report.issues, 'orphan-note');

		for (const path of [
			'Orphan Notes/orphan-idea-1.md',
			'Orphan Notes/orphan-idea-2.md',
			'Orphan Notes/orphan-idea-3.md',
			'Orphan Notes/orphan-note-without-tags.md',
			'Orphan Notes/orphan-old-note.md',
		]) {
			expect(orphans).toContain(path);
		}
		// The other 20 are notes the fixture simply never linked; they are real orphans.
		expect(orphans).toHaveLength(25);
	});

	it('finds the three empty notes', async () => {
		const harness = await createHarness(loadVaultFromDisk());
		const report = await harness.engine.scan('full');

		expect(pathsOf(report.issues, 'empty-note')).toEqual([
			'Problem Notes/empty-note-1.md',
			'Problem Notes/empty-note-2.md',
			'Problem Notes/nearly-empty-note.md',
		]);
	});

	it('finds the six unused attachments and leaves the three used ones alone', async () => {
		const harness = await createHarness(loadVaultFromDisk());
		const report = await harness.engine.scan('full');
		const unused = pathsOf(report.issues, 'unused-attachment');

		expect(unused).toHaveLength(6);
		expect(unused).not.toContain('99-Attachments/images/used-image-1.png');
		expect(unused).not.toContain('99-Attachments/images/used-image-2.jpg');
		expect(unused).not.toContain('99-Attachments/documents/used-document.pdf');
	});

	it('finds both duplicate title groups', async () => {
		const harness = await createHarness(loadVaultFromDisk());
		const report = await harness.engine.scan('full');
		const duplicates = report.issues.filter((issue) => issue.type === 'duplicate-title');

		const groups = duplicates
			.map((issue) =>
				issue.data.kind === 'duplicate-title' ? [...issue.data.paths].sort() : [],
			)
			.sort((a, b) => (a[0] ?? '').localeCompare(b[0] ?? ''));

		expect(groups).toEqual([
			['01-Projects/Project Alpha/Project Alpha.md', 'Unlinked Mentions/Project Alpha.md'],
			[
				'Problem Notes/duplicate - Project Ideas 2.md',
				'Problem Notes/duplicate - Project Ideas.md',
			],
		]);
	});

	it('finds the three misspelled tag groups', async () => {
		const harness = await createHarness(loadVaultFromDisk());
		const report = await harness.engine.scan('full');

		const canonicals = report.issues
			.filter((issue) => issue.type === 'tag-inconsistency')
			.map((issue) => (issue.data.kind === 'tag-inconsistency' ? issue.data.canonical : ''))
			.sort();

		expect(canonicals).toEqual(['development', 'project', 'testing']);
	});

	it('separates a note with no frontmatter from one with broken frontmatter', async () => {
		const harness = await createHarness(loadVaultFromDisk());
		const report = await harness.engine.scan('full');

		// This is the pairing the scan engine used to get wrong: reading a file is what
		// reveals a `---` fence whose YAML failed, so a scope captured before the read
		// misfiled the corrupt note as merely missing properties.
		expect(pathsOf(report.issues, 'missing-metadata')).toEqual([
			'Problem Notes/missing metadata note.md',
		]);
		expect(pathsOf(report.issues, 'corrupted-frontmatter')).toEqual([
			'Problem Notes/corrupted-frontmatter.md',
		]);
	});

	it('handles unicode, special characters, and a 265KB note without failing', async () => {
		const harness = await createHarness(loadVaultFromDisk());
		const report = await harness.engine.scan('full');

		expect(report.filesScanned).toBeGreaterThan(60);
		// Every one of these was scanned and produced only the issues it should.
		const byPath = (path: string): HealthIssue[] =>
			report.issues.filter((issue) => issue.path === path);
		expect(byPath('Problem Notes/unicode-note-日本語.md').map((i) => i.type)).toEqual([
			'orphan-note',
		]);
		expect(byPath('Problem Notes/special chars - @#$%.md').map((i) => i.type)).toEqual([
			'orphan-note',
		]);
		expect(byPath('Problem Notes/very-long-note.md').map((i) => i.type)).toEqual([
			'orphan-note',
		]);
	});

	it('reports the long note as a large file once the threshold is lowered', async () => {
		const harness = await createHarness(loadVaultFromDisk(), {
			settings: (settings) => {
				settings.health.largeFileThresholdBytes = 100 * 1024;
			},
		});
		const report = await harness.engine.scan('full');

		expect(pathsOf(report.issues, 'large-file')).toEqual(['Problem Notes/very-long-note.md']);
	});
});

describe('scan scope and exclusions', () => {
	it('includes the inbox once the skip-inbox setting is off', async () => {
		const harness = await createHarness(loadVaultFromDisk(), {
			settings: (settings) => {
				settings.health.excludeInbox = false;
			},
		});
		const report = await harness.engine.scan('full');

		// The inbox adds one broken link ([[Product Design Principles]]) and nine orphans.
		expect(report.countsByType['broken-link']).toBe(9);
		expect(report.countsByType['orphan-note']).toBe(34);
	});

	it('honours excluded folders', async () => {
		const harness = await createHarness(loadVaultFromDisk(), {
			settings: (settings) => {
				settings.health.excludedFolders = ['Problem Notes'];
			},
		});
		const report = await harness.engine.scan('full');

		expect(report.countsByType['broken-link']).toBe(0);
		expect(report.countsByType['empty-note']).toBe(0);
		expect(report.issues.every((issue) => !issue.path.startsWith('Problem Notes/'))).toBe(true);
	});

	it('honours excluded tags', async () => {
		const harness = await createHarness(loadVaultFromDisk(), {
			settings: (settings) => {
				settings.health.excludedTags = ['test'];
			},
		});
		const report = await harness.engine.scan('full');

		expect(pathsOf(report.issues, 'broken-link')).toEqual([]);
	});

	it('suppresses ignored issues and counts them separately', async () => {
		const harness = await createHarness(loadVaultFromDisk());
		const first = await harness.engine.scan('full');
		const brokenLinks = first.issues.filter((issue) => issue.type === 'broken-link');

		await harness.health.ignore(brokenLinks);
		const second = await harness.engine.scan('full');

		expect(second.countsByType['broken-link']).toBe(0);
		expect(second.ignoredCount).toBe(8);
		// The score improves by exactly the broken-link penalty.
		expect(second.score.value).toBeCloseTo(first.score.value + 4, 5);
	});

	it('runs a detector when only its secondary category is enabled', async () => {
		const harness = await createHarness(loadVaultFromDisk(), {
			settings: (settings) => {
				settings.health.detectors['missing-metadata'] = false;
				settings.health.detectors['corrupted-frontmatter'] = true;
			},
		});
		const report = await harness.engine.scan('full');

		expect(report.countsByType['missing-metadata']).toBe(0);
		expect(report.countsByType['corrupted-frontmatter']).toBe(1);
	});

	it('emits progress and completion events', async () => {
		const harness = await createHarness(loadVaultFromDisk());
		const phases: string[] = [];
		let completed = 0;

		harness.bus.on('scan-progress', (payload) => phases.push(payload.phase));
		harness.bus.on('scan-completed', () => completed++);

		await harness.engine.scan('full');

		expect(phases).toContain('read');
		expect(phases).toContain('analyse');
		expect(completed).toBe(1);
	});

	it('shares an in-flight scan instead of scanning twice', async () => {
		const harness = await createHarness(loadVaultFromDisk());
		let started = 0;
		harness.bus.on('scan-started', () => started++);

		const [a, b] = await Promise.all([
			harness.engine.scan('full'),
			harness.engine.scan('full'),
		]);

		expect(started).toBe(1);
		expect(a).toBe(b);
	});
});

describe('incremental scanning', () => {
	it('picks up a newly introduced broken link', async () => {
		const app = loadVaultFromDisk();
		const harness = await createHarness(app);
		const before = await harness.engine.scan('full');
		expect(before.countsByType['broken-link']).toBe(8);

		const file = app.vault.getFileByPath('Problem Notes/stale-note-2024.md');
		expect(file).not.toBeNull();
		if (!file) throw new Error('fixture note missing');
		await app.vault.modify(
			file,
			`${app.vault.peek('Problem Notes/stale-note-2024.md') ?? ''}\n\nSee [[A Note That Does Not Exist]].`,
		);

		app.metadataCache.refresh();
		// The mock's TFile is structurally compatible with the subset the index reads.
		harness.index.updateFile(file as unknown as Parameters<typeof harness.index.updateFile>[0]);
		harness.content.invalidate('Problem Notes/stale-note-2024.md');

		const after = await harness.engine.scan('incremental');
		expect(after.countsByType['broken-link']).toBe(9);
		expect(after.kind).toBe('incremental');
	});

	it('completes an incremental rescan quickly', async () => {
		const harness = await createHarness(loadVaultFromDisk());
		await harness.engine.scan('full');

		const startedAt = Date.now();
		await harness.engine.scan('incremental');
		// The spec's budget is 2s; the cached content index makes this far faster.
		expect(Date.now() - startedAt).toBeLessThan(2000);
	});
});
