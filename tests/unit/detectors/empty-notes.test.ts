/**
 * Empty note detector.
 *
 * Content counts come from a real {@link ContentIndex} so the "unreadable" and "stale
 * stats" paths are exercised through the same `peekStats` contract the scan engine uses.
 */

import { describe, expect, it } from 'vitest';
import type { App as ObsidianApp } from 'obsidian';
import type { DetectorContext } from '../../../src/types/health';
import type { ContentStats, NoteRecord } from '../../../src/types/note';
import type { HealthSettings } from '../../../src/types/settings';
import { DEFAULT_SETTINGS } from '../../../src/types/settings';
import { Logger } from '../../../src/core/logger';
import { ContentIndex } from '../../../src/services/content-index';
import { VaultIndex } from '../../../src/services/vault-index';
import emptyNotes from '../../../src/modules/health/detectors/empty-notes';
import type { App } from '../../mocks/obsidian';
import { buildVault, FIXTURE_NOW, loadVaultFromDisk } from '../../helpers/vault-fixture';

interface ContextOptions {
	/** Records matching this predicate are dropped from `notes`/`attachments`. */
	readonly exclude?: (record: NoteRecord) => boolean;
	readonly settings?: Partial<HealthSettings>;
	/** Paths whose content could not be read, so `getStats` answers null. */
	readonly unreadable?: readonly string[];
	/** Stats injected ahead of the content index, for cases it cannot produce. */
	readonly statsFor?: Readonly<Record<string, ContentStats>>;
	/** Put attachments into `notes`, to prove the detector filters them itself. */
	readonly attachmentsAsNotes?: boolean;
}

/** Build a detector context whose content stats are already loaded. */
async function makeContext(app: App, options: ContextOptions = {}): Promise<DetectorContext> {
	const logger = new Logger('silent');
	const index = new VaultIndex(app as unknown as ObsidianApp, logger);
	index.build();
	const content = new ContentIndex(app as unknown as ObsidianApp, index, logger);

	const all = index.all();
	const inScope = all.filter((record) => !(options.exclude?.(record) ?? false));
	await content.ensureLoaded(inScope);

	const unreadable = new Set(options.unreadable ?? []);
	const injected = options.statsFor ?? {};

	return {
		notes: options.attachmentsAsNotes
			? inScope
			: inScope.filter((record) => !record.isAttachment),
		attachments: inScope.filter((record) => record.isAttachment),
		allFiles: all,
		settings: { ...DEFAULT_SETTINGS.health, ...options.settings },
		now: FIXTURE_NOW,
		getStats: (path) => {
			if (unreadable.has(path)) return null;
			return injected[path] ?? content.peekStats(path);
		},
		backlinksOf: (path) => index.backlinksOf(path),
	};
}

/** Paths reported as empty, sorted for stable comparison. */
function emptyPaths(context: DetectorContext): string[] {
	return emptyNotes
		.run(context)
		.map((issue) => issue.path)
		.sort();
}

describe('empty notes detector', () => {
	it('exposes its type, label, and content requirement', () => {
		expect(emptyNotes.type).toBe('empty-note');
		expect(emptyNotes.label).toBe('Empty notes');
		// The scan engine reads this to know it must load bodies first.
		expect(emptyNotes.needsContent).toBe(true);
	});

	it('reports nothing for an empty vault', async () => {
		expect(emptyNotes.run(await makeContext(buildVault([])))).toEqual([]);
	});

	it('describes a single empty note in full', async () => {
		const app = buildVault([{ path: 'Notes/blank.md', content: '' }]);
		const issues = emptyNotes.run(await makeContext(app));

		expect(issues).toHaveLength(1);
		const issue = issues[0];
		expect(issue?.type).toBe('empty-note');
		expect(issue?.severity).toBe('medium');
		expect(issue?.path).toBe('Notes/blank.md');
		expect(issue?.title).toBe('blank');
		expect(issue?.detail).toBe('Notes with little or no content. 0 B');
		expect(issue?.data).toEqual({ kind: 'empty-note', contentLength: 0, size: 0 });
		expect(issue?.id.startsWith('empty-note:')).toBe(true);
	});

	it('leaves a note with real content alone', async () => {
		const app = buildVault([
			{
				path: 'full.md',
				content: 'A properly written note with more than enough words in it.',
			},
		]);
		expect(emptyNotes.run(await makeContext(app))).toEqual([]);
	});

	it('reports a note that is all frontmatter and almost no body', async () => {
		const app = buildVault([
			{
				path: 'meta-only.md',
				frontmatter: {
					created: '2026-01-01',
					modified: '2026-01-02',
					type: 'note',
					status: 'active',
				},
				content: 'short',
			},
		]);
		const issues = emptyNotes.run(await makeContext(app));

		expect(issues).toHaveLength(1);
		const data = issues[0]?.data;
		expect(data?.kind === 'empty-note' ? data.contentLength : -1).toBe(5);
		// The byte threshold did not fire; the character count is what caught this one.
		expect(data?.kind === 'empty-note' ? data.size : 0).toBeGreaterThanOrEqual(
			DEFAULT_SETTINGS.health.emptyNoteByteThreshold,
		);
	});

	it('reports a tiny file even when its body clears the character threshold', async () => {
		const app = buildVault([{ path: 'tiny.md', content: 'x'.repeat(30) }]);
		const issues = emptyNotes.run(await makeContext(app));

		expect(issues).toHaveLength(1);
		const data = issues[0]?.data;
		expect(data?.kind === 'empty-note' ? data.contentLength : -1).toBe(30);
		expect(data?.kind === 'empty-note' ? data.size : -1).toBe(30);
	});

	it('treats a note sitting exactly on either threshold as content', async () => {
		// "Under 20 characters or under 50 bytes" — both comparisons are strict, so this
		// pins the boundary that a `<=` slip would quietly move.
		const app = buildVault([
			{ path: 'at-char-limit.md', content: 'x' },
			{ path: 'at-byte-limit.md', content: 'y' },
			{ path: 'one-under-char.md', content: 'z' },
			{ path: 'one-under-byte.md', content: 'w' },
		]);
		const context = await makeContext(app, {
			statsFor: {
				// Exactly at both thresholds: reported by neither rule.
				'at-char-limit.md': { contentLength: 20, wordCount: 4, size: 50, mtime: 0 },
				'at-byte-limit.md': { contentLength: 400, wordCount: 80, size: 50, mtime: 0 },
				// One unit below each threshold: reported by exactly one rule.
				'one-under-char.md': { contentLength: 19, wordCount: 4, size: 400, mtime: 0 },
				'one-under-byte.md': { contentLength: 400, wordCount: 80, size: 49, mtime: 0 },
			},
		});

		expect(emptyPaths(context)).toEqual(['one-under-byte.md', 'one-under-char.md']);
	});

	it('honours custom thresholds', async () => {
		const app = buildVault([{ path: 'tiny.md', content: 'x'.repeat(30) }]);
		const context = await makeContext(app, {
			settings: { emptyNoteCharThreshold: 5, emptyNoteByteThreshold: 5 },
		});
		expect(emptyNotes.run(context)).toEqual([]);
	});

	it('never reports a file it could not read', async () => {
		const app = buildVault([{ path: 'unreadable.md', content: '' }]);
		// Deletion is the offered fix, so a read failure must never look like emptiness.
		const context = await makeContext(app, { unreadable: ['unreadable.md'] });
		expect(emptyNotes.run(context)).toEqual([]);
	});

	it('never reports attachments, even when they are handed to it as notes', async () => {
		const app = buildVault([
			{ path: 'assets/tiny.png', content: 'binary:4' },
			{ path: 'blank.md', content: '' },
		]);
		const context = await makeContext(app, {
			attachmentsAsNotes: true,
			statsFor: {
				'assets/tiny.png': { contentLength: 0, wordCount: 0, size: 4, mtime: 0 },
			},
		});
		expect(emptyPaths(context)).toEqual(['blank.md']);
	});

	it('counts unicode bodies in characters, not bytes', async () => {
		const app = buildVault([
			// Thirty CJK characters is real content even though it is far fewer bytes.
			{ path: 'ノート/日本語ノート.md', content: '日'.repeat(30), size: 200 },
			{ path: 'ノート/短い.md', content: '日本', size: 200 },
		]);
		expect(emptyPaths(await makeContext(app))).toEqual(['ノート/短い.md']);
	});

	it('handles special characters in filenames', async () => {
		const app = buildVault([{ path: 'Problem Notes/special chars - @$%.md', content: '' }]);
		const issues = emptyNotes.run(await makeContext(app));

		expect(issues).toHaveLength(1);
		expect(issues[0]?.path).toBe('Problem Notes/special chars - @$%.md');
		expect(issues[0]?.title).toBe('special chars - @$%');
	});

	it('reports a note whose frontmatter is corrupt but whose body is empty', async () => {
		// The block never parses, so its text stays in the body — which is why the raw
		// character count, not the metadata cache, decides emptiness.
		const app = buildVault([{ path: 'corrupt.md', content: '---\ntags [broken\n' }]);
		expect(emptyPaths(await makeContext(app))).toEqual(['corrupt.md']);
	});

	it('leaves a note larger than 100 KB alone', async () => {
		const filler = 'lorem ipsum dolor sit amet. '.repeat(4000);
		const app = buildVault([{ path: 'long.md', content: filler }]);
		expect(filler.length).toBeGreaterThan(100_000);
		expect(emptyNotes.run(await makeContext(app))).toEqual([]);
	});

	it('skips a note that changed after the stats were loaded', async () => {
		const app = buildVault([{ path: 'blank.md', content: '' }]);
		const context = await makeContext(app);
		expect(emptyNotes.run(context)).toHaveLength(1);

		const file = app.vault.getFileByPath('blank.md');
		if (!file) throw new Error('fixture is missing blank.md');
		await app.vault.modify(file, 'The user just typed a real note here, concurrently.');

		// Stale cache entries report null rather than yesterday's counts.
		expect(emptyNotes.run(context)).toEqual([]);
	});

	it('keeps ids stable across runs', async () => {
		const app = buildVault([{ path: 'blank.md', content: '' }]);
		const first = emptyNotes.run(await makeContext(app));
		const second = emptyNotes.run(await makeContext(app));
		expect(first.map((issue) => issue.id)).toEqual(second.map((issue) => issue.id));
	});
});

describe('empty notes against the on-disk fixture', () => {
	it('reports every thin note outside the inbox', async () => {
		const context = await makeContext(loadVaultFromDisk(), {
			exclude: (record) => record.path.startsWith('00-Inbox/'),
		});
		const issues = emptyNotes.run(context);

		expect(issues).toHaveLength(3);
		expect(issues.map((issue) => issue.path).sort()).toEqual([
			'Problem Notes/empty-note-1.md',
			'Problem Notes/empty-note-2.md',
			'Problem Notes/nearly-empty-note.md',
		]);
		expect(issues.every((issue) => issue.severity === 'medium')).toBe(true);
	});
});
