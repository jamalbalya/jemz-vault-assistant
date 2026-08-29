/**
 * Duplicate title detector.
 *
 * The interesting behaviour is not "two files have the same name" — it is everything the
 * detector must *not* flag: years, sibling notes numbered 1/2/3, and short names that a naive
 * similarity rule would happily merge.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { App as ObsidianApp } from 'obsidian';
import detector from '../../../src/modules/health/detectors/duplicate-titles';
import { Logger } from '../../../src/core/logger';
import { VaultIndex } from '../../../src/services/vault-index';
import type {
	DetectorContext,
	DuplicateTitleIssueData,
	HealthIssue,
} from '../../../src/types/health';
import type { HealthSettings } from '../../../src/types/settings';
import { DEFAULT_SETTINGS } from '../../../src/types/settings';
import type { App } from '../../mocks/obsidian';
import {
	buildVault,
	FIXTURE_NOW,
	loadVaultFromDisk,
	TEST_VAULT_PATH,
	type FixtureFile,
} from '../../helpers/vault-fixture';

/**
 * Build a detector context from a mock vault.
 *
 * The mock `App` is structurally the same object the plugin sees at runtime; the cast only
 * bridges the two declaration files (`obsidian` resolves to the mock under vitest).
 */
function contextFor(app: App, settings: Partial<HealthSettings> = {}): DetectorContext {
	const logger = new Logger('silent');
	const index = new VaultIndex(app as unknown as ObsidianApp, logger);
	index.build();
	return {
		notes: index.notes(),
		attachments: index.attachments(),
		allFiles: index.all(),
		settings: { ...DEFAULT_SETTINGS.health, ...settings },
		now: FIXTURE_NOW,
		getStats: (): null => null,
		backlinksOf: (path: string): readonly string[] => index.backlinksOf(path),
	};
}

/** Narrow an issue's payload without casting. */
function duplicateData(issue: HealthIssue): DuplicateTitleIssueData {
	if (issue.data.kind !== 'duplicate-title') {
		throw new Error(`Expected duplicate-title data, got "${issue.data.kind}"`);
	}
	return issue.data;
}

/** Every reported group as a sorted `a.md+b.md` string, itself sorted. */
function groupKeys(issues: readonly HealthIssue[]): string[] {
	return issues.map((issue) => duplicateData(issue).paths.join('+')).sort();
}

const NOTE = (path: string): FixtureFile => ({ path, content: '# Note\n\nbody' });

describe('duplicate-title detector shape', () => {
	it('declares its type, label and that it needs no content', () => {
		expect(detector.type).toBe('duplicate-title');
		expect(detector.label).toBe('Duplicate titles');
		expect(detector.needsContent).toBeUndefined();
	});
});

describe('duplicate-title detector, exact pass', () => {
	it('reports nothing for an empty vault', () => {
		expect(detector.run(contextFor(buildVault([])))).toEqual([]);
	});

	it('reports nothing for a single note', () => {
		expect(detector.run(contextFor(buildVault([NOTE('Notes/Only One.md')])))).toEqual([]);
	});

	it('groups identical basenames across folders into one issue', () => {
		const app = buildVault([
			NOTE('01-Projects/Project Alpha.md'),
			NOTE('Unlinked Mentions/Project Alpha.md'),
		]);
		const issues = detector.run(contextFor(app));

		expect(issues).toHaveLength(1);
		const issue = issues[0];
		expect(issue?.type).toBe('duplicate-title');
		expect(issue?.severity).toBe('medium');
		expect(issue?.title).toBe('Project Alpha');
		expect(issue?.path).toBe('01-Projects/Project Alpha.md');

		const data = duplicateData(issue as HealthIssue);
		expect(data.exact).toBe(true);
		expect(data.similarity).toBe(1);
		expect(data.normalizedTitle).toBe('project alpha');
		expect(data.paths).toEqual([
			'01-Projects/Project Alpha.md',
			'Unlinked Mentions/Project Alpha.md',
		]);
	});

	it('emits one issue for a group of three, not three pairs', () => {
		const app = buildVault([NOTE('a/Ideas.md'), NOTE('b/Ideas.md'), NOTE('c/Ideas.md')]);
		const issues = detector.run(contextFor(app));

		expect(issues).toHaveLength(1);
		expect(duplicateData(issues[0] as HealthIssue).paths).toEqual([
			'a/Ideas.md',
			'b/Ideas.md',
			'c/Ideas.md',
		]);
	});

	it('collapses a trailing copy counter but keeps a year', () => {
		const app = buildVault([
			NOTE('Problem Notes/duplicate - Project Ideas.md'),
			NOTE('Problem Notes/duplicate - Project Ideas 2.md'),
			NOTE('04-Archive/Old Project 2024.md'),
			NOTE('04-Archive/Old Project 2025.md'),
		]);
		const issues = detector.run(contextFor(app));

		expect(groupKeys(issues)).toEqual([
			'Problem Notes/duplicate - Project Ideas 2.md+Problem Notes/duplicate - Project Ideas.md',
		]);
	});

	it('ignores case and collapses repeated whitespace', () => {
		const app = buildVault([NOTE('a/Meeting Notes.md'), NOTE('b/meeting   NOTES.md')]);
		const issues = detector.run(contextFor(app));

		expect(issues).toHaveLength(1);
		expect(duplicateData(issues[0] as HealthIssue).normalizedTitle).toBe('meeting notes');
	});

	it('groups unicode basenames', () => {
		const app = buildVault([
			NOTE('a/ユニコード ノート.md'),
			NOTE('b/ユニコード ノート.md'),
			NOTE('c/ユニコード メモ.md'),
		]);
		const issues = detector.run(contextFor(app));

		expect(groupKeys(issues)).toEqual(['a/ユニコード ノート.md+b/ユニコード ノート.md']);
	});

	it('groups basenames containing special characters', () => {
		const app = buildVault([
			NOTE('a/special chars - @#$%.md'),
			NOTE('b/special chars - @#$%.md'),
		]);
		expect(groupKeys(detector.run(contextFor(app)))).toEqual([
			'a/special chars - @#$%.md+b/special chars - @#$%.md',
		]);
	});

	it('skips a basename that normalises to nothing', () => {
		const app = buildVault([
			{ path: 'a/   .md', content: 'x' },
			{ path: 'b/   .md', content: 'y' },
		]);
		expect(detector.run(contextFor(app))).toEqual([]);
	});

	it('still groups notes whose frontmatter is missing or corrupt', () => {
		const app = buildVault([
			{ path: 'a/Report.md', content: '---\ntype note\nbroken [\n---\n\nbody' },
			{ path: 'b/Report.md', content: 'no frontmatter at all' },
		]);
		expect(groupKeys(detector.run(contextFor(app)))).toEqual(['a/Report.md+b/Report.md']);
	});

	it('groups a very long note like any other', () => {
		const app = buildVault([
			{ path: 'a/Huge Note.md', content: 'x'.repeat(120_000) },
			NOTE('b/Huge Note.md'),
		]);
		expect(groupKeys(detector.run(contextFor(app)))).toEqual(['a/Huge Note.md+b/Huge Note.md']);
	});

	it('ignores attachments even when they reach the notes list', () => {
		const app = buildVault([
			NOTE('a/diagram.md'),
			{ path: 'b/diagram.png', content: 'binary:10', size: 10 },
		]);
		const base = contextFor(app);
		// Force the attachment into `notes` to prove the detector filters it out itself.
		const context: DetectorContext = { ...base, notes: [...base.notes, ...base.attachments] };
		expect(detector.run(context)).toEqual([]);
	});
});

describe('duplicate-title detector, fuzzy pass', () => {
	it('reports long near-identical titles', () => {
		const app = buildVault([
			NOTE('a/Quarterly Planning Document Draft.md'),
			NOTE('b/Quarterly Planning Document Drafts.md'),
		]);
		const issues = detector.run(contextFor(app));

		expect(issues).toHaveLength(1);
		const data = duplicateData(issues[0] as HealthIssue);
		expect(data.exact).toBe(false);
		expect(data.similarity).toBeGreaterThan(0.9);
		expect(data.similarity).toBeLessThan(1);
		expect(data.paths).toEqual([
			'a/Quarterly Planning Document Draft.md',
			'b/Quarterly Planning Document Drafts.md',
		]);
		expect(issues[0]?.detail).toContain('% similar');
	});

	it('leaves short numbered siblings alone', () => {
		const app = buildVault([
			NOTE('Orphan Notes/orphan-idea-1.md'),
			NOTE('Orphan Notes/orphan-idea-2.md'),
			NOTE('Problem Notes/stale-note-2023.md'),
			NOTE('Problem Notes/stale-note-2024.md'),
		]);
		expect(detector.run(contextFor(app))).toEqual([]);
	});

	it('flags those same siblings once the length gate is lowered', () => {
		const app = buildVault([
			NOTE('Problem Notes/stale-note-2023.md'),
			NOTE('Problem Notes/stale-note-2024.md'),
		]);
		const issues = detector.run(contextFor(app, { duplicateMinFuzzyLength: 14 }));

		expect(issues).toHaveLength(1);
		expect(duplicateData(issues[0] as HealthIssue).exact).toBe(false);
	});

	it('respects the similarity threshold', () => {
		const files = [
			NOTE('a/Quarterly Planning Document Draft.md'),
			NOTE('b/Quarterly Planning Document Drafts.md'),
		];
		expect(
			detector.run(contextFor(buildVault(files), { duplicateSimilarityThreshold: 0.99 })),
		).toEqual([]);
	});

	it('reports every near-identical pair in a cluster, not just one', () => {
		const app = buildVault([
			NOTE('a/Quarterly Planning Document Draft.md'),
			NOTE('b/Quarterly Planning Document Drafts.md'),
			NOTE('c/Quarterly Planning Document Drafted.md'),
		]);

		expect(groupKeys(detector.run(contextFor(app)))).toEqual([
			'a/Quarterly Planning Document Draft.md+b/Quarterly Planning Document Drafts.md',
			'a/Quarterly Planning Document Draft.md+c/Quarterly Planning Document Drafted.md',
			'b/Quarterly Planning Document Drafts.md+c/Quarterly Planning Document Drafted.md',
		]);
	});

	it('still pairs titles whose lengths differ by the whole allowance', () => {
		// Against the 29-character title, two characters missing is 0.93 similar and reported,
		// five is 0.83 and is not. The pass orders candidates by length and stops as soon as
		// the length gap alone rules the rest out, so this is where a window that closed one
		// character too early would show up: as a duplicate that quietly stops being reported.
		const app = buildVault([
			NOTE('a/Engineering Handbook Revision.md'),
			NOTE('b/Engineering Handbook Revisi.md'),
			NOTE('c/Engineering Handbook Rev.md'),
		]);

		expect(groupKeys(detector.run(contextFor(app)))).toEqual([
			'a/Engineering Handbook Revision.md+b/Engineering Handbook Revisi.md',
		]);
	});

	it('never fuzzy-matches a title that is already in an exact group', () => {
		const app = buildVault([
			NOTE('a/Quarterly Planning Document Draft.md'),
			NOTE('b/Quarterly Planning Document Draft.md'),
			NOTE('c/Quarterly Planning Document Drafts.md'),
		]);
		const issues = detector.run(contextFor(app));

		// Only the exact pair is reported; the near-miss third file is not paired with either.
		expect(groupKeys(issues)).toEqual([
			'a/Quarterly Planning Document Draft.md+b/Quarterly Planning Document Draft.md',
		]);
	});
});

describe('duplicate-title issue identity', () => {
	const paths = ['b/Shared Title.md', 'a/Shared Title.md', 'c/Shared Title.md'];

	it('does not depend on the order the notes were visited', () => {
		const forward = detector.run(contextFor(buildVault(paths.map(NOTE))));
		const backward = detector.run(contextFor(buildVault([...paths].reverse().map(NOTE))));

		expect(forward[0]?.id).toBe(backward[0]?.id);
		expect(forward[0]?.path).toBe('a/Shared Title.md');
	});

	it('picks the same primary when two paths collate as equal', () => {
		// U+200B is completely ignorable to the ICU collator, so these two folder names compare
		// equal under `localeCompare` alone and the sort would otherwise keep input order.
		const pair = ['a​/Twin.md', 'a/Twin.md'];
		const forward = detector.run(contextFor(buildVault(pair.map(NOTE))));
		const backward = detector.run(contextFor(buildVault([...pair].reverse().map(NOTE))));

		expect(forward).toHaveLength(1);
		expect(backward).toHaveLength(1);
		expect(forward[0]?.path).toBe(backward[0]?.path);
		expect(duplicateData(forward[0] as HealthIssue).paths).toEqual(
			duplicateData(backward[0] as HealthIssue).paths,
		);
		expect(forward[0]?.id).toBe(backward[0]?.id);
	});

	it('records the same normalised title for a fuzzy pair whichever note is seen first', () => {
		const pair = [
			'a/Quarterly Planning Document Draft.md',
			'z/Quarterly Planning Document Drafts.md',
		];
		const forward = detector.run(contextFor(buildVault(pair.map(NOTE))));
		const backward = detector.run(contextFor(buildVault([...pair].reverse().map(NOTE))));

		expect(forward).toHaveLength(1);
		// The primary is the path-sorted first member, so the title travels with it rather than
		// with whichever half of the pair the scan reached first.
		expect(duplicateData(forward[0] as HealthIssue).normalizedTitle).toBe(
			'quarterly planning document draft',
		);
		expect(duplicateData(backward[0] as HealthIssue).normalizedTitle).toBe(
			duplicateData(forward[0] as HealthIssue).normalizedTitle,
		);
		expect(forward[0]?.id).toBe(backward[0]?.id);
	});

	it('changes when a note joins the group', () => {
		const app = buildVault(paths.map(NOTE));
		const before = detector.run(contextFor(app));

		// Concurrent modification: a fourth copy lands between scans.
		app.vault.seed('d/Shared Title.md', '# Note');
		app.metadataCache.refresh();
		const after = detector.run(contextFor(app));

		expect(duplicateData(after[0] as HealthIssue).paths).toHaveLength(4);
		expect(after[0]?.id).not.toBe(before[0]?.id);
	});
});

describe('duplicate-title detector against the on-disk fixture', () => {
	let issues: HealthIssue[];

	beforeEach(() => {
		const app = loadVaultFromDisk(TEST_VAULT_PATH, {
			exclude: (path) => path.startsWith('00-Inbox/'),
		});
		issues = detector.run(contextFor(app));
	});

	it('finds exactly the two intended duplicate groups', () => {
		expect(issues).toHaveLength(2);
		expect(groupKeys(issues)).toEqual([
			'01-Projects/Project Alpha/Project Alpha.md+Unlinked Mentions/Project Alpha.md',
			'Problem Notes/duplicate - Project Ideas 2.md+Problem Notes/duplicate - Project Ideas.md',
		]);
	});

	it('reports both as exact matches', () => {
		expect(issues.map((issue) => duplicateData(issue).exact)).toEqual([true, true]);
	});
});
