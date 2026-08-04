/**
 * Missing metadata / corrupted frontmatter detector.
 *
 * The rule under test that matters most is the exclusion: a note whose YAML failed to parse
 * looks exactly like a note with no properties at all, and must never be told to "add
 * properties" — the fix is repairing the fence.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { App as ObsidianApp } from 'obsidian';
import detector from '../../../src/modules/health/detectors/missing-metadata';
import { Logger } from '../../../src/core/logger';
import { ContentIndex } from '../../../src/services/content-index';
import { VaultIndex } from '../../../src/services/vault-index';
import type {
	DetectorContext,
	HealthIssue,
	MissingMetadataIssueData,
} from '../../../src/types/health';
import type { HealthSettings } from '../../../src/types/settings';
import { DEFAULT_SETTINGS } from '../../../src/types/settings';
import type { App, TFile } from '../../mocks/obsidian';
import {
	buildVault,
	FIXTURE_NOW,
	loadVaultFromDisk,
	TEST_VAULT_PATH,
} from '../../helpers/vault-fixture';

/**
 * Build a detector context with file bodies loaded.
 *
 * The content pass is what tells the index a note opens with a `---` fence, which is the only
 * way to tell "no frontmatter" from "broken frontmatter".
 */
async function contextFor(
	app: App,
	settings: Partial<HealthSettings> = {},
): Promise<DetectorContext> {
	const logger = new Logger('silent');
	const index = new VaultIndex(app as unknown as ObsidianApp, logger);
	index.build();
	const content = new ContentIndex(app as unknown as ObsidianApp, index, logger);
	await content.ensureLoaded(index.notes());

	return {
		notes: index.notes(),
		attachments: index.attachments(),
		allFiles: index.all(),
		settings: { ...DEFAULT_SETTINGS.health, ...settings },
		now: FIXTURE_NOW,
		getStats: (path: string) => content.peekStats(path),
		backlinksOf: (path: string): readonly string[] => index.backlinksOf(path),
	};
}

/** Narrow an issue's payload without casting. */
function missingData(issue: HealthIssue): MissingMetadataIssueData {
	if (issue.data.kind !== 'missing-metadata') {
		throw new Error(`Expected missing-metadata data, got "${issue.data.kind}"`);
	}
	return issue.data;
}

function pathsOfType(issues: readonly HealthIssue[], type: string): string[] {
	return issues
		.filter((issue) => issue.type === type)
		.map((issue) => issue.path)
		.sort();
}

/** Toggle one detector without mutating the shared defaults object. */
function detectorsWith(
	overrides: Partial<HealthSettings['detectors']>,
): HealthSettings['detectors'] {
	return { ...DEFAULT_SETTINGS.health.detectors, ...overrides };
}

const CORRUPT = '---\ncreated: 2026-05-28\ntype note\ntags [test, broken\n---\n\n# Broken\n';

describe('missing-metadata detector shape', () => {
	it('declares itself as the missing-metadata detector and asks for content', () => {
		expect(detector.type).toBe('missing-metadata');
		expect(detector.label).toBe('Missing metadata');
		expect(detector.needsContent).toBe(true);
	});
});

describe('missing-metadata detector', () => {
	it('reports nothing for an empty vault', async () => {
		expect(detector.run(await contextFor(buildVault([])))).toEqual([]);
	});

	it('reports nothing for a single complete note', async () => {
		const app = buildVault([
			{
				path: 'a/Complete.md',
				frontmatter: { created: '2026-05-01', type: 'note' },
				content: 'x',
			},
		]);
		expect(detector.run(await contextFor(app))).toEqual([]);
	});

	it('reports a note with no frontmatter at all', async () => {
		const app = buildVault([
			{ path: 'a/missing metadata note.md', content: '# No properties' },
		]);
		const issues = detector.run(await contextFor(app));

		expect(issues).toHaveLength(1);
		const issue = issues[0];
		expect(issue?.type).toBe('missing-metadata');
		expect(issue?.severity).toBe('low');
		expect(issue?.path).toBe('a/missing metadata note.md');
		expect(issue?.title).toBe('missing metadata note');
		expect(missingData(issue as HealthIssue).missing).toEqual(['created', 'type']);
	});

	it('treats empty strings and empty lists as missing', async () => {
		const app = buildVault([
			{ path: 'a/Blank.md', frontmatter: { created: '', type: [] }, content: 'x' },
		]);
		const issues = detector.run(await contextFor(app));

		expect(issues).toHaveLength(1);
		expect(missingData(issues[0] as HealthIssue).missing).toEqual(['created', 'type']);
	});

	it('reports only the fields that are actually absent', async () => {
		const app = buildVault([
			{ path: 'a/Half.md', frontmatter: { created: '2026-05-01' }, content: 'x' },
		]);
		expect(missingData(detector.run(await contextFor(app))[0] as HealthIssue).missing).toEqual([
			'type',
		]);
	});

	it('accepts non-string property values', async () => {
		const app = buildVault([
			{
				path: 'a/Numeric.md',
				frontmatter: { created: 20260501, type: 'note' },
				content: 'x',
			},
		]);
		expect(detector.run(await contextFor(app))).toEqual([]);
	});

	it('honours a custom required-field list and blank entries in it', async () => {
		const app = buildVault([
			{
				path: 'a/Note.md',
				frontmatter: { created: '2026-05-01', type: 'note' },
				content: 'x',
			},
		]);
		const issues = detector.run(
			await contextFor(app, { requiredFrontmatterFields: ['status', '  ', 'type'] }),
		);

		expect(issues).toHaveLength(1);
		expect(missingData(issues[0] as HealthIssue).missing).toEqual(['status']);
	});

	it('collapses repeated entries in the required-field list', async () => {
		const app = buildVault([{ path: 'a/Note.md', content: '# none' }]);
		const context = await contextFor(app, {
			requiredFrontmatterFields: ['type', 'created', 'type', ' type '],
		});
		const issues = detector.run(context);

		expect(issues).toHaveLength(1);
		expect(missingData(issues[0] as HealthIssue).missing).toEqual(['type', 'created']);
		expect(issues[0]?.detail).toBe(
			'Notes missing required frontmatter properties. type, created',
		);

		// A duplicate in the settings list must not mint a different id either, or ignoring the
		// issue once would stop working the moment the user tidied the list up.
		const clean = await contextFor(buildVault([{ path: 'a/Note.md', content: '# none' }]), {
			requiredFrontmatterFields: ['created', 'type'],
		});
		expect(detector.run(clean)[0]?.id).toBe(issues[0]?.id);
	});

	it('reports nothing when no fields are required', async () => {
		const app = buildVault([{ path: 'a/Note.md', content: 'no frontmatter' }]);
		expect(detector.run(await contextFor(app, { requiredFrontmatterFields: [] }))).toEqual([]);
	});

	it('handles unicode and special characters in file names', async () => {
		const app = buildVault([
			{ path: 'a/unicode-note-日本語.md', content: '# 日本語' },
			{ path: 'a/special chars - @#$%.md', content: '# Special' },
		]);
		const issues = detector.run(await contextFor(app));

		expect(pathsOfType(issues, 'missing-metadata')).toEqual([
			'a/special chars - @#$%.md',
			'a/unicode-note-日本語.md',
		]);
	});

	it('handles a very long note', async () => {
		const app = buildVault([
			{ path: 'a/Huge.md', content: `# Huge\n\n${'x'.repeat(120_000)}` },
		]);
		const issues = detector.run(await contextFor(app));

		expect(issues).toHaveLength(1);
		expect(issues[0]?.type).toBe('missing-metadata');
		expect(issues[0]?.path).toBe('a/Huge.md');
		expect(missingData(issues[0] as HealthIssue).missing).toEqual(['created', 'type']);
	});

	it('ignores attachments even when they reach the notes list', async () => {
		const app = buildVault([{ path: 'a/image.png', content: 'binary:9', size: 9 }]);
		const base = await contextFor(app);
		const context: DetectorContext = { ...base, notes: [...base.notes, ...base.attachments] };
		expect(detector.run(context)).toEqual([]);
	});

	it('stops reporting once the properties are added', async () => {
		const app = buildVault([{ path: 'a/Note.md', content: '# Note' }]);
		expect(detector.run(await contextFor(app))).toHaveLength(1);

		// Concurrent modification: the user fixes the note between scans.
		const file = app.vault.getFileByPath('a/Note.md');
		if (!file) throw new Error('fixture is missing a/Note.md');
		await app.vault.modify(file, '---\ncreated: 2026-05-01\ntype: note\n---\n\n# Note');
		app.metadataCache.refresh();

		expect(detector.run(await contextFor(app))).toEqual([]);
	});
});

describe('corrupted frontmatter', () => {
	it('reports a broken block as corrupted and never as missing metadata', async () => {
		const app = buildVault([{ path: 'a/corrupted-frontmatter.md', content: CORRUPT }]);
		const issues = detector.run(await contextFor(app));

		expect(issues).toHaveLength(1);
		const issue = issues[0];
		expect(issue?.type).toBe('corrupted-frontmatter');
		expect(issue?.severity).toBe('medium');
		expect(issue?.path).toBe('a/corrupted-frontmatter.md');
		expect(issue?.data.kind).toBe('generic');
		expect(issue?.detail).toBe('Notes whose frontmatter could not be parsed.');
	});

	it('keeps the note out of the missing-metadata list when only that half is enabled', async () => {
		const app = buildVault([
			{ path: 'a/corrupted-frontmatter.md', content: CORRUPT },
			{ path: 'b/plain.md', content: '# Plain' },
		]);
		const issues = detector.run(
			await contextFor(app, { detectors: detectorsWith({ 'corrupted-frontmatter': false }) }),
		);

		expect(pathsOfType(issues, 'missing-metadata')).toEqual(['b/plain.md']);
		expect(pathsOfType(issues, 'corrupted-frontmatter')).toEqual([]);
	});

	it('reports only corruption when the missing-metadata half is disabled', async () => {
		const app = buildVault([
			{ path: 'a/corrupted-frontmatter.md', content: CORRUPT },
			{ path: 'b/plain.md', content: '# Plain' },
		]);
		const issues = detector.run(
			await contextFor(app, { detectors: detectorsWith({ 'missing-metadata': false }) }),
		);

		expect(pathsOfType(issues, 'corrupted-frontmatter')).toEqual([
			'a/corrupted-frontmatter.md',
		]);
		expect(pathsOfType(issues, 'missing-metadata')).toEqual([]);
	});

	it('reports nothing when both halves are disabled', async () => {
		const app = buildVault([
			{ path: 'a/corrupted-frontmatter.md', content: CORRUPT },
			{ path: 'b/plain.md', content: '# Plain' },
		]);
		const issues = detector.run(
			await contextFor(app, {
				detectors: detectorsWith({
					'missing-metadata': false,
					'corrupted-frontmatter': false,
				}),
			}),
		);
		expect(issues).toEqual([]);
	});

	it('falls back to missing metadata when the file could not be read', async () => {
		const app = buildVault([{ path: 'a/unreadable.md', content: CORRUPT }]);
		const read = app.vault.cachedRead.bind(app.vault);
		app.vault.cachedRead = async (file: TFile): Promise<string> => {
			if (file.path === 'a/unreadable.md') throw new Error('EIO: could not read');
			return read(file);
		};

		// Without the body there is no way to know a `---` fence exists, so the note degrades
		// to the safer of the two reports rather than being dropped.
		const issues = detector.run(await contextFor(app));
		expect(issues).toHaveLength(1);
		expect(issues[0]?.type).toBe('missing-metadata');
	});
});

describe('missing-metadata detector against the on-disk fixture', () => {
	let issues: HealthIssue[];

	beforeEach(async () => {
		const app = loadVaultFromDisk(TEST_VAULT_PATH, {
			exclude: (path) => path.startsWith('00-Inbox/'),
		});
		issues = detector.run(await contextFor(app));
	});

	it('finds one note missing the required properties', () => {
		const missing = issues.filter((issue) => issue.type === 'missing-metadata');
		expect(missing).toHaveLength(1);
		expect(missing[0]?.path).toBe('Problem Notes/missing metadata note.md');
		expect(missingData(missing[0] as HealthIssue).missing).toEqual(['created', 'type']);
	});

	it('finds one note with corrupted frontmatter', () => {
		expect(pathsOfType(issues, 'corrupted-frontmatter')).toEqual([
			'Problem Notes/corrupted-frontmatter.md',
		]);
	});
});
