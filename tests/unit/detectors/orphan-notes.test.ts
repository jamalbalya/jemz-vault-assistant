/**
 * Orphan note detector.
 *
 * The interesting axis is the link graph, so most cases build a tiny vault and check which
 * side of the in/out test each note lands on.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { App as ObsidianApp } from 'obsidian';
import type { DetectorContext } from '../../../src/types/health';
import type { NoteRecord } from '../../../src/types/note';
import { DEFAULT_SETTINGS } from '../../../src/types/settings';
import { Logger } from '../../../src/core/logger';
import { VaultIndex } from '../../../src/services/vault-index';
import orphanNotes from '../../../src/modules/health/detectors/orphan-notes';
import type { App } from '../../mocks/obsidian';
import { buildVault, FIXTURE_NOW, loadVaultFromDisk } from '../../helpers/vault-fixture';

interface ContextOptions {
	/** Records matching this predicate are dropped from `notes`/`attachments`. */
	readonly exclude?: (record: NoteRecord) => boolean;
	/**
	 * Put attachments into `notes` as well, to prove the detector filters them itself rather
	 * than relying on the scan engine having done it.
	 */
	readonly attachmentsAsNotes?: boolean;
	/** Replace the backlink lookup, to drive shapes the real index never produces. */
	readonly backlinksOf?: (path: string) => readonly string[];
}

/** Build a detector context over a mock vault, backed by a real index. */
function makeContext(app: App, options: ContextOptions = {}): DetectorContext {
	const index = new VaultIndex(app as unknown as ObsidianApp, new Logger('silent'));
	index.build();
	const all = index.all();
	const inScope = all.filter((record) => !(options.exclude?.(record) ?? false));

	return {
		notes: options.attachmentsAsNotes
			? inScope
			: inScope.filter((record) => !record.isAttachment),
		attachments: inScope.filter((record) => record.isAttachment),
		allFiles: all,
		settings: { ...DEFAULT_SETTINGS.health },
		now: FIXTURE_NOW,
		getStats: () => null,
		backlinksOf: options.backlinksOf ?? ((path) => index.backlinksOf(path)),
	};
}

/** Paths reported as orphans, sorted for stable comparison. */
function orphanPaths(context: DetectorContext): string[] {
	return orphanNotes
		.run(context)
		.map((issue) => issue.path)
		.sort();
}

describe('orphan notes detector', () => {
	it('exposes its type and label', () => {
		expect(orphanNotes.type).toBe('orphan-note');
		expect(orphanNotes.label).toBe('Orphan notes');
		expect(orphanNotes.needsContent).toBeUndefined();
	});

	it('reports nothing for an empty vault', () => {
		expect(orphanNotes.run(makeContext(buildVault([])))).toEqual([]);
	});

	it('reports a lone note in a single-note vault', () => {
		const app = buildVault([{ path: 'Solo.md', content: '# Solo' }]);
		const issues = orphanNotes.run(makeContext(app));

		expect(issues).toHaveLength(1);
		const issue = issues[0];
		expect(issue?.type).toBe('orphan-note');
		expect(issue?.severity).toBe('low');
		expect(issue?.path).toBe('Solo.md');
		expect(issue?.title).toBe('Solo');
		expect(issue?.detail).toBe('Notes with no links in and no links out.');
		expect(issue?.data).toEqual({ kind: 'generic' });
		expect(issue?.id.startsWith('orphan-note:')).toBe(true);
	});

	it('spares both ends of a link', () => {
		const app = buildVault([
			{ path: 'A.md', content: 'See [[B]].' },
			{ path: 'B.md', content: 'b' },
			{ path: 'C.md', content: 'lonely' },
		]);
		expect(orphanPaths(makeContext(app))).toEqual(['C.md']);
	});

	it('treats an unresolved link as an outgoing link', () => {
		const app = buildVault([{ path: 'A.md', content: 'See [[Ghost Note]].' }]);
		// A note pointing at a missing target is a broken-link problem, not an orphan.
		expect(orphanNotes.run(makeContext(app))).toEqual([]);
	});

	it('treats a broken embed as an outgoing link too', () => {
		const app = buildVault([{ path: 'A.md', content: '![[missing.png]]' }]);
		expect(orphanNotes.run(makeContext(app))).toEqual([]);
	});

	it('reports a note whose only link points at itself', () => {
		const app = buildVault([
			{ path: 'A.md', content: 'see [[A]] for details' },
			{ path: 'B.md', content: 'linked' },
			{ path: 'Hub.md', content: '[[B]]' },
		]);
		// A self-link is not an edge in either direction — the index refuses to record it as
		// a backlink — so a note that only links to itself is exactly as disconnected as one
		// with no links at all.
		expect(orphanPaths(makeContext(app))).toEqual(['A.md']);
	});

	it('still spares a self-linking note that something else links to', () => {
		const app = buildVault([
			{ path: 'A.md', content: 'see [[A]]' },
			{ path: 'Hub.md', content: 'go to [[A]]' },
		]);
		expect(orphanPaths(makeContext(app))).toEqual([]);
	});

	it('discounts a self-backlink from a backlink source that reports one', () => {
		const app = buildVault([{ path: 'A.md', content: 'no links at all' }]);
		// `backlinksOf` is injected precisely so the detector does not depend on one
		// implementation's conventions; a source that lists a note against itself must not
		// count as an inbound link.
		const context = makeContext(app, { backlinksOf: (path) => [path] });
		expect(orphanPaths(context)).toEqual(['A.md']);
	});

	it('spares a note that only has backlinks', () => {
		const app = buildVault([
			{ path: 'Hub.md', content: '[[Leaf]]' },
			{ path: 'Leaf.md', content: 'no outgoing links' },
		]);
		expect(orphanPaths(makeContext(app))).toEqual([]);
	});

	it('reports a note whose only backlink comes from an out-of-scope note only when that link is gone', () => {
		const app = buildVault([
			{ path: '00-Inbox/capture.md', content: '[[Leaf]]' },
			{ path: 'Leaf.md', content: 'no outgoing links' },
		]);
		// Backlinks are computed over the whole vault, so an excluded referrer still counts.
		expect(
			orphanPaths(
				makeContext(app, { exclude: (record) => record.path.startsWith('00-Inbox/') }),
			),
		).toEqual([]);
	});

	it('never reports attachments, even when they are handed to it as notes', () => {
		const app = buildVault([
			{ path: 'Solo.md', content: '# Solo' },
			{ path: 'assets/unused.png', content: 'binary:10' },
		]);
		expect(orphanPaths(makeContext(app, { attachmentsAsNotes: true }))).toEqual(['Solo.md']);
	});

	it('handles unicode and special characters in filenames', () => {
		const app = buildVault([
			{ path: 'ノート/日本語ノート.md', content: '孤立したノート' },
			{ path: 'Problem Notes/special chars - @$%.md', content: 'lonely' },
		]);
		const issues = orphanNotes.run(makeContext(app));

		expect(issues.map((issue) => issue.path).sort()).toEqual([
			'Problem Notes/special chars - @$%.md',
			'ノート/日本語ノート.md',
		]);
		expect(new Set(issues.map((issue) => issue.id)).size).toBe(2);
	});

	it('reports notes with missing or corrupt frontmatter', () => {
		const app = buildVault([
			{ path: 'no-frontmatter.md', content: 'plain text' },
			{ path: 'corrupt.md', content: '---\ntags [broken\n---\n\nbody' },
		]);
		expect(orphanPaths(makeContext(app))).toEqual(['corrupt.md', 'no-frontmatter.md']);
	});

	it('reports a note larger than 100 KB when nothing links to it', () => {
		const filler = 'lorem ipsum dolor sit amet. '.repeat(4000);
		const app = buildVault([{ path: 'long.md', content: filler }]);
		expect(filler.length).toBeGreaterThan(100_000);
		expect(orphanPaths(makeContext(app))).toEqual(['long.md']);
	});

	it('stops reporting a note once it gains a link', async () => {
		const app = buildVault([
			{ path: 'A.md', content: 'no links yet' },
			{ path: 'B.md', content: 'b' },
		]);
		expect(orphanPaths(makeContext(app))).toEqual(['A.md', 'B.md']);

		const file = app.vault.getFileByPath('A.md');
		if (!file) throw new Error('fixture is missing A.md');
		await app.vault.modify(file, 'now links to [[B]]');

		expect(orphanPaths(makeContext(app))).toEqual([]);
	});

	it('gives one issue per path with a stable id', () => {
		const app = buildVault([{ path: 'Solo.md', content: 'x' }]);
		const first = orphanNotes.run(makeContext(app));
		const second = orphanNotes.run(makeContext(app));
		expect(first.map((issue) => issue.id)).toEqual(second.map((issue) => issue.id));
	});
});

describe('orphan notes against the on-disk fixture', () => {
	let context: DetectorContext;

	beforeEach(() => {
		context = makeContext(loadVaultFromDisk(), {
			exclude: (record) => record.path.startsWith('00-Inbox/'),
		});
	});

	it('reports every disconnected note outside the inbox', () => {
		const issues = orphanNotes.run(context);

		expect(issues).toHaveLength(25);
		expect(issues.every((issue) => issue.severity === 'low')).toBe(true);
		expect(issues.every((issue) => issue.path.endsWith('.md'))).toBe(true);
		expect(issues.map((issue) => issue.path)).toContain('Orphan Notes/orphan-idea-1.md');
		// Linked into the Project Alpha cluster, so never an orphan.
		expect(issues.map((issue) => issue.path)).not.toContain(
			'01-Projects/Project Alpha/Project Alpha.md',
		);
	});
});
