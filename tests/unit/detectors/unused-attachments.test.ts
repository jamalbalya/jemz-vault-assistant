/**
 * Unused attachment detector.
 *
 * The cases that matter most are the ones where scope and reference disagree: an attachment
 * referenced only from a note the scan excluded must never be reported.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { App as ObsidianApp } from 'obsidian';
import type { DetectorContext } from '../../../src/types/health';
import type { NoteRecord } from '../../../src/types/note';
import { DEFAULT_SETTINGS } from '../../../src/types/settings';
import { Logger } from '../../../src/core/logger';
import { VaultIndex } from '../../../src/services/vault-index';
import unusedAttachments from '../../../src/modules/health/detectors/unused-attachments';
import type { App } from '../../mocks/obsidian';
import { buildVault, FIXTURE_NOW, loadVaultFromDisk } from '../../helpers/vault-fixture';

interface ContextOptions {
	/** Records matching this predicate are dropped from `notes`/`attachments`. */
	readonly exclude?: (record: NoteRecord) => boolean;
	/**
	 * Put markdown notes into `attachments` as well, to prove the detector filters them
	 * itself rather than relying on the scan engine having split the scope correctly.
	 */
	readonly notesAsAttachments?: boolean;
}

/** Build a detector context over a mock vault, backed by a real index. */
function makeContext(app: App, options: ContextOptions = {}): DetectorContext {
	const index = new VaultIndex(app as unknown as ObsidianApp, new Logger('silent'));
	index.build();
	const all = index.all();
	const inScope = all.filter((record) => !(options.exclude?.(record) ?? false));

	return {
		notes: inScope.filter((record) => !record.isAttachment),
		attachments: options.notesAsAttachments
			? inScope
			: inScope.filter((record) => record.isAttachment),
		allFiles: all,
		settings: { ...DEFAULT_SETTINGS.health },
		now: FIXTURE_NOW,
		getStats: () => null,
		backlinksOf: (path) => index.backlinksOf(path),
	};
}

/** Paths reported as unused, sorted for stable comparison. */
function unusedPaths(context: DetectorContext): string[] {
	return unusedAttachments
		.run(context)
		.map((issue) => issue.path)
		.sort();
}

describe('unused attachments detector', () => {
	it('exposes its type and label', () => {
		expect(unusedAttachments.type).toBe('unused-attachment');
		expect(unusedAttachments.label).toBe('Unused attachments');
		expect(unusedAttachments.needsContent).toBeUndefined();
	});

	it('reports nothing for an empty vault', () => {
		expect(unusedAttachments.run(makeContext(buildVault([])))).toEqual([]);
	});

	it('reports nothing for a vault of one note and no attachments', () => {
		const app = buildVault([{ path: 'Solo.md', content: '# Solo' }]);
		expect(unusedAttachments.run(makeContext(app))).toEqual([]);
	});

	it('describes a single unreferenced attachment in full', () => {
		const app = buildVault([
			{ path: 'assets/lonely.png', content: 'binary', size: 1_500_000 },
			{ path: 'Solo.md', content: 'nothing embedded here' },
		]);
		const issues = unusedAttachments.run(makeContext(app));

		expect(issues).toHaveLength(1);
		const issue = issues[0];
		expect(issue?.type).toBe('unused-attachment');
		expect(issue?.severity).toBe('low');
		expect(issue?.path).toBe('assets/lonely.png');
		// The extension stays in the title: it is how a user tells attachments apart.
		expect(issue?.title).toBe('lonely.png');
		expect(issue?.detail).toBe('Attachments no note references. 1.4 MB');
		expect(issue?.data).toEqual({ kind: 'generic' });
		expect(issue?.id.startsWith('unused-attachment:')).toBe(true);
	});

	it('spares an embedded attachment', () => {
		const app = buildVault([
			{ path: 'assets/used.png', content: 'binary' },
			{ path: 'assets/unused.png', content: 'binary' },
			{ path: 'Note.md', content: '![[used.png]]' },
		]);
		expect(unusedPaths(makeContext(app))).toEqual(['assets/unused.png']);
	});

	it('spares an attachment referenced by a markdown link or a full path', () => {
		const app = buildVault([
			{ path: 'assets/doc.pdf', content: 'binary' },
			{ path: 'assets/image.png', content: 'binary' },
			{
				path: 'Note.md',
				content: '[the doc](assets/doc.pdf)\n\n[[assets/image.png]]',
			},
		]);
		expect(unusedAttachments.run(makeContext(app))).toEqual([]);
	});

	it('spares an attachment referenced only by an out-of-scope note', () => {
		const app = buildVault([
			{ path: 'assets/used.png', content: 'binary' },
			{ path: '00-Inbox/capture.md', content: '![[used.png]]' },
			{ path: 'Note.md', content: 'no embeds' },
		]);
		// References are counted over the whole vault, so excluding the inbox must not turn a
		// referenced image into a deletion candidate.
		const context = makeContext(app, {
			exclude: (record) => record.path.startsWith('00-Inbox/'),
		});
		expect(unusedAttachments.run(context)).toEqual([]);
	});

	it('ignores an unresolved embed when deciding what is referenced', () => {
		const app = buildVault([
			{ path: 'assets/unused.png', content: 'binary' },
			{ path: 'Note.md', content: '![[missing-image.png]]' },
		]);
		expect(unusedPaths(makeContext(app))).toEqual(['assets/unused.png']);
	});

	it('never reports markdown notes, even when they are handed to it as attachments', () => {
		const app = buildVault([
			{ path: 'Orphan.md', content: 'nothing links here' },
			{ path: 'assets/unused.png', content: 'binary' },
		]);
		// Deletion is the offered fix, so an unfiltered scope must not put a note at risk.
		expect(unusedPaths(makeContext(app, { notesAsAttachments: true }))).toEqual([
			'assets/unused.png',
		]);
	});

	it('tells two attachments apart when they differ only by extension', () => {
		const app = buildVault([
			{ path: 'assets/diagram.png', content: 'binary', size: 10 },
			{ path: 'assets/diagram.pdf', content: 'binary', size: 20 },
			{ path: 'Note.md', content: 'no embeds' },
		]);
		const issues = unusedAttachments.run(makeContext(app));

		expect(issues.map((issue) => issue.title).sort()).toEqual(['diagram.pdf', 'diagram.png']);
		expect(new Set(issues.map((issue) => issue.id)).size).toBe(2);
	});

	it('handles unicode and special characters in attachment names', () => {
		const app = buildVault([
			{ path: '添付/画像-日本語.png', content: 'binary', size: 2048 },
			{ path: 'assets/special chars - @$%.pdf', content: 'binary', size: 512 },
			{ path: 'Note.md', content: 'no embeds' },
		]);
		const issues = unusedAttachments.run(makeContext(app));

		expect(issues.map((issue) => issue.path).sort()).toEqual([
			'assets/special chars - @$%.pdf',
			'添付/画像-日本語.png',
		]);
		expect(issues.map((issue) => issue.title).sort()).toEqual([
			'special chars - @$%.pdf',
			'画像-日本語.png',
		]);
		expect(issues.map((issue) => issue.detail).sort()).toEqual([
			'Attachments no note references. 2.0 KB',
			'Attachments no note references. 512 B',
		]);
		expect(new Set(issues.map((issue) => issue.id)).size).toBe(2);
	});

	it('counts references from notes with corrupt frontmatter', () => {
		const app = buildVault([
			{ path: 'assets/used.png', content: 'binary' },
			{ path: 'corrupt.md', content: '---\ntags [broken\n---\n\n![[used.png]]' },
		]);
		expect(unusedAttachments.run(makeContext(app))).toEqual([]);
	});

	it('counts references from a note larger than 100 KB', () => {
		const filler = 'lorem ipsum dolor sit amet. '.repeat(4000);
		const app = buildVault([
			{ path: 'assets/used.png', content: 'binary' },
			{ path: 'long.md', content: `${filler}\n\n![[used.png]]` },
		]);
		expect(filler.length).toBeGreaterThan(100_000);
		expect(unusedAttachments.run(makeContext(app))).toEqual([]);
	});

	it('reports an attachment once its last reference is edited away', async () => {
		const app = buildVault([
			{ path: 'assets/used.png', content: 'binary' },
			{ path: 'Note.md', content: '![[used.png]]' },
		]);
		expect(unusedAttachments.run(makeContext(app))).toEqual([]);

		const file = app.vault.getFileByPath('Note.md');
		if (!file) throw new Error('fixture is missing Note.md');
		await app.vault.modify(file, 'the embed is gone now');

		expect(unusedPaths(makeContext(app))).toEqual(['assets/used.png']);
	});

	it('keeps ids stable across runs', () => {
		const app = buildVault([{ path: 'assets/unused.png', content: 'binary' }]);
		const first = unusedAttachments.run(makeContext(app));
		const second = unusedAttachments.run(makeContext(app));
		expect(first.map((issue) => issue.id)).toEqual(second.map((issue) => issue.id));
	});
});

describe('unused attachments against the on-disk fixture', () => {
	let context: DetectorContext;

	beforeEach(() => {
		context = makeContext(loadVaultFromDisk(), {
			exclude: (record) => record.path.startsWith('00-Inbox/'),
		});
	});

	it('reports every attachment nothing references', () => {
		const issues = unusedAttachments.run(context);

		expect(issues).toHaveLength(6);
		expect(issues.map((issue) => issue.path).sort()).toEqual([
			'99-Attachments/audio/unused-recording.mp3',
			'99-Attachments/documents/unused-document.pdf',
			'99-Attachments/images/unused-image-1.png',
			'99-Attachments/images/unused-image-2.jpg',
			'99-Attachments/images/unused-image-3.png',
			'99-Attachments/images/unused-screenshot.png',
		]);
		expect(issues.every((issue) => issue.severity === 'low')).toBe(true);
	});
});
