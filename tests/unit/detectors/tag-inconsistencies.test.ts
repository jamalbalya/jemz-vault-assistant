/**
 * Tag inconsistency detector.
 *
 * The grouping policy itself lives in `tag-service`; what is verified here is the detector's
 * half of the contract — one issue per group, counts measured in notes rather than
 * occurrences, and every note carrying any variant listed on the issue.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { App as ObsidianApp } from 'obsidian';
import detector from '../../../src/modules/health/detectors/tag-inconsistencies';
import { Logger } from '../../../src/core/logger';
import { VaultIndex } from '../../../src/services/vault-index';
import type {
	DetectorContext,
	HealthIssue,
	TagInconsistencyIssueData,
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

/** Build a detector context from a mock vault. */
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
function tagData(issue: HealthIssue): TagInconsistencyIssueData {
	if (issue.data.kind !== 'tag-inconsistency') {
		throw new Error(`Expected tag-inconsistency data, got "${issue.data.kind}"`);
	}
	return issue.data;
}

/** Every group as a sorted `a+b` string of its variant tags, itself sorted. */
function variantSets(issues: readonly HealthIssue[]): string[] {
	return issues
		.map((issue) =>
			tagData(issue)
				.variants.map((variant) => variant.tag)
				.sort()
				.join('+'),
		)
		.sort();
}

/** A note carrying `tags`, with a body so it is not otherwise remarkable. */
function tagged(path: string, tags: readonly string[]): FixtureFile {
	return {
		path,
		frontmatter: { created: '2026-05-01', type: 'note', tags: [...tags] },
		content: 'body',
	};
}

describe('tag-inconsistency detector shape', () => {
	it('declares its type, label and that it needs no content', () => {
		expect(detector.type).toBe('tag-inconsistency');
		expect(detector.label).toBe('Tag inconsistencies');
		expect(detector.needsContent).toBeUndefined();
	});
});

describe('tag-inconsistency detector', () => {
	it('reports nothing for an empty vault', () => {
		expect(detector.run(contextFor(buildVault([])))).toEqual([]);
	});

	it('reports nothing for a single note with unrelated tags', () => {
		const app = buildVault([tagged('a/Note.md', ['project', 'health', 'reading'])]);
		expect(detector.run(contextFor(app))).toEqual([]);
	});

	it('reports a misspelled long tag', () => {
		const app = buildVault([
			tagged('a/One.md', ['project']),
			tagged('b/Two.md', ['project']),
			tagged('c/Three.md', ['projek']),
		]);
		const issues = detector.run(contextFor(app));

		expect(issues).toHaveLength(1);
		const issue = issues[0];
		expect(issue?.type).toBe('tag-inconsistency');
		expect(issue?.severity).toBe('low');
		expect(issue?.title).toBe('#project');
		expect(issue?.detail).toContain('#projek (1)');
		expect(issue?.path).toBe('a/One.md');

		const data = tagData(issue as HealthIssue);
		expect(data.canonical).toBe('project');
		expect(data.variants).toEqual([
			{ tag: 'project', count: 2 },
			{ tag: 'projek', count: 1 },
		]);
		expect(data.paths).toEqual(['a/One.md', 'b/Two.md', 'c/Three.md']);
	});

	it('leaves two unrelated short tags alone', () => {
		const app = buildVault([tagged('a/One.md', ['task']), tagged('b/Two.md', ['test'])]);
		expect(detector.run(contextFor(app))).toEqual([]);
	});

	it('still keeps them apart when only the short distance budget is raised', () => {
		// A wider distance budget is not enough on its own: `task` and `test` share a single
		// leading character, and the shared-prefix requirement is what stops the plugin
		// offering to merge two unrelated four-letter tags.
		const app = buildVault([
			tagged('a/One.md', ['task']),
			tagged('b/Two.md', ['task']),
			tagged('c/Three.md', ['test']),
		]);
		expect(detector.run(contextFor(app, { tagShortMaxDistance: 2 }))).toEqual([]);
	});

	it('flags short tags once both the distance budget and the prefix rule allow it', () => {
		// `task`/`tasl` share three characters and are one edit apart, so they are a genuine
		// typo pair even at short-tag length.
		const app = buildVault([
			tagged('a/One.md', ['task']),
			tagged('b/Two.md', ['task']),
			tagged('c/Three.md', ['tasl']),
		]);
		const issues = detector.run(contextFor(app, { tagShortMaxDistance: 1 }));

		expect(issues).toHaveLength(1);
		expect(tagData(issues[0] as HealthIssue).canonical).toBe('task');
		expect(variantSets(issues)).toEqual(['task+tasl']);
	});

	it('groups unicode tags', () => {
		const app = buildVault([
			tagged('a/One.md', ['プロジェクト']),
			tagged('b/Two.md', ['プロジェクト']),
			tagged('c/Three.md', ['プロジエクト']),
			tagged('d/Four.md', ['café']),
			tagged('e/Five.md', ['cafe']),
			tagged('f/Six.md', ['cafe']),
		]);
		const issues = detector.run(contextFor(app));

		expect(variantSets(issues)).toEqual(['cafe+café', 'プロジェクト+プロジエクト']);
		expect(issues.map((issue) => tagData(issue).canonical).sort()).toEqual([
			'cafe',
			'プロジェクト',
		]);
	});

	it('counts a tag once per note even when it appears twice in one', () => {
		const app = buildVault([
			{
				path: 'a/One.md',
				frontmatter: { created: '2026-05-01', type: 'note', tags: ['project'] },
				content: 'body with an inline #project tag as well',
			},
			tagged('b/Two.md', ['projek']),
		]);
		const issues = detector.run(contextFor(app));

		expect(tagData(issues[0] as HealthIssue).variants).toEqual([
			{ tag: 'project', count: 1 },
			{ tag: 'projek', count: 1 },
		]);
	});

	it('reports a group even when one note carries every variant', () => {
		const app = buildVault([tagged('a/Only.md', ['development', 'developement'])]);
		const issues = detector.run(contextFor(app));

		expect(issues).toHaveLength(1);
		expect(tagData(issues[0] as HealthIssue).paths).toEqual(['a/Only.md']);
	});

	it('ignores tags inside a frontmatter block that failed to parse', () => {
		// The broken block is the *only* place `testting` appears, so an empty result is proof
		// the detector never saw it — rather than a group that happened not to form.
		const app = buildVault([
			{ path: 'a/corrupt.md', content: '---\ntags [testting, broken\n---\n\nbody' },
			{ path: 'b/plain.md', content: '# No frontmatter' },
			tagged('c/One.md', ['testing']),
		]);
		expect(detector.run(contextFor(app))).toEqual([]);

		// Positive control: the same misspelling in a well-formed block does group.
		const repaired = buildVault([
			tagged('a/corrupt.md', ['testting']),
			{ path: 'b/plain.md', content: '# No frontmatter' },
			tagged('c/One.md', ['testing']),
		]);
		expect(variantSets(detector.run(contextFor(repaired)))).toEqual(['testing+testting']);
	});

	it('counts tags on a very long note', () => {
		const app = buildVault([
			{
				path: 'a/Huge.md',
				frontmatter: { created: '2026-05-01', type: 'note', tags: ['testting'] },
				content: 'x'.repeat(120_000),
			},
			tagged('b/Two.md', ['testing']),
		]);
		expect(variantSets(detector.run(contextFor(app)))).toEqual(['testing+testting']);
	});

	it('ignores attachments even when they reach the notes list', () => {
		const app = buildVault([
			tagged('a/One.md', ['testing']),
			tagged('b/Two.md', ['testting']),
			{ path: 'c/image.png', content: 'binary', size: 8 },
		]);
		const base = contextFor(app);
		const context: DetectorContext = { ...base, notes: [...base.notes, ...base.attachments] };
		expect(variantSets(detector.run(context))).toEqual(['testing+testting']);
	});

	it('keeps the id stable when counts shift the canonical spelling', () => {
		const app = buildVault([tagged('a/One.md', ['testing']), tagged('b/Two.md', ['testting'])]);
		const before = detector.run(contextFor(app));
		expect(tagData(before[0] as HealthIssue).canonical).toBe('testing');

		// Concurrent modification: another note picks up the misspelling between scans, which
		// makes it the most used spelling. The recommendation flips; the issue is the same one.
		app.vault.seed(
			'c/Three.md',
			'---\ncreated: 2026-05-01\ntype: note\ntags:\n  - testting\n---\n\nbody',
		);
		app.metadataCache.refresh();
		const after = detector.run(contextFor(app));

		expect(tagData(after[0] as HealthIssue).canonical).toBe('testting');
		expect(after[0]?.id).toBe(before[0]?.id);
		expect(tagData(after[0] as HealthIssue).paths).toEqual([
			'a/One.md',
			'b/Two.md',
			'c/Three.md',
		]);
	});
});

describe('tag-inconsistency detector against the on-disk fixture', () => {
	let issues: HealthIssue[];

	beforeEach(() => {
		const app = loadVaultFromDisk(TEST_VAULT_PATH, {
			exclude: (path) => path.startsWith('00-Inbox/'),
		});
		issues = detector.run(contextFor(app));
	});

	/** The reported group containing `tag`, if any. */
	function groupWith(tag: string): TagInconsistencyIssueData | undefined {
		return issues
			.map(tagData)
			.find((data) => data.variants.some((variant) => variant.tag === tag));
	}

	it('finds exactly the three intended misspelling groups', () => {
		expect(issues).toHaveLength(3);
	});

	it('groups each misspelling with the word it misspells', () => {
		expect(
			groupWith('projek')
				?.variants.map((variant) => variant.tag)
				.sort(),
		).toEqual(['project', 'projek']);
		expect(
			groupWith('developement')
				?.variants.map((variant) => variant.tag)
				.sort(),
		).toEqual(['developement', 'development']);
		// Membership is transitive and owned by tag-service: `meeting` is within the long-tag
		// distance budget of `testing`, so it joins that component rather than forming a
		// fourth group. The misspelling still travels with the word it misspells.
		expect(groupWith('testting')?.variants.map((variant) => variant.tag)).toContain('testing');
	});

	it('picks the most used spelling as canonical', () => {
		expect(groupWith('projek')?.canonical).toBe('project');
		expect(groupWith('developement')?.canonical).toBe('development');
	});

	it('lists every note carrying a variant', () => {
		const project = issues.find((issue) => tagData(issue).canonical === 'project');
		const data = tagData(project as HealthIssue);
		expect(data.variants[0]?.count).toBeGreaterThan(1);
		expect(data.paths).toContain('Problem Notes/tag inconsistency note.md');
		expect(data.paths.length).toBe(new Set(data.paths).size);
	});
});
