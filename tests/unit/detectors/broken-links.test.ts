/**
 * Broken link detector.
 *
 * The detector is pure, so every case here drives it through a hand-assembled
 * {@link DetectorContext} built from a real {@link VaultIndex} over the in-memory vault —
 * the same data the scan engine would hand it in production.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { App as ObsidianApp } from 'obsidian';
import type { DetectorContext } from '../../../src/types/health';
import type { NoteRecord } from '../../../src/types/note';
import { DEFAULT_SETTINGS } from '../../../src/types/settings';
import { Logger } from '../../../src/core/logger';
import { VaultIndex } from '../../../src/services/vault-index';
import brokenLinks from '../../../src/modules/health/detectors/broken-links';
import type { App } from '../../mocks/obsidian';
import { buildVault, FIXTURE_NOW, loadVaultFromDisk } from '../../helpers/vault-fixture';

interface ContextOptions {
	/** Records matching this predicate are dropped from `notes`/`attachments`. */
	readonly exclude?: (record: NoteRecord) => boolean;
}

/**
 * Build a detector context over a mock vault.
 *
 * The mock App is cast to Obsidian's type: vitest aliases the module at runtime, but the
 * compiler still resolves the real declarations for `src/`.
 */
function makeContext(app: App, options: ContextOptions = {}): DetectorContext {
	const index = new VaultIndex(app as unknown as ObsidianApp, new Logger('silent'));
	index.build();
	const all = index.all();
	const inScope = all.filter((record) => !(options.exclude?.(record) ?? false));

	return {
		notes: inScope.filter((record) => !record.isAttachment),
		attachments: inScope.filter((record) => record.isAttachment),
		allFiles: all,
		settings: { ...DEFAULT_SETTINGS.health },
		now: FIXTURE_NOW,
		getStats: () => null,
		backlinksOf: (path) => index.backlinksOf(path),
	};
}

describe('broken links detector', () => {
	it('exposes its type and label', () => {
		expect(brokenLinks.type).toBe('broken-link');
		expect(brokenLinks.label).toBe('Broken links');
		// Link data comes from the metadata cache, so no file bodies are needed.
		expect(brokenLinks.needsContent).toBeUndefined();
	});

	it('reports nothing for an empty vault', () => {
		expect(brokenLinks.run(makeContext(buildVault([])))).toEqual([]);
	});

	it('reports nothing for a single note without links', () => {
		const app = buildVault([{ path: 'Solo.md', content: '# Solo\n\nNo links here.' }]);
		expect(brokenLinks.run(makeContext(app))).toEqual([]);
	});

	it('ignores links that resolve', () => {
		const app = buildVault([
			{ path: 'A.md', content: 'See [[B]] and [[C]].' },
			{ path: 'B.md', content: 'b' },
			{ path: 'C.md', content: 'c' },
		]);
		expect(brokenLinks.run(makeContext(app))).toEqual([]);
	});

	it('describes one unresolved link in full', () => {
		const app = buildVault([{ path: 'Notes/A.md', content: 'See [[Ghost Note Alpha]] now.' }]);
		const issues = brokenLinks.run(makeContext(app));

		expect(issues).toHaveLength(1);
		const issue = issues[0];
		expect(issue?.type).toBe('broken-link');
		expect(issue?.severity).toBe('high');
		expect(issue?.path).toBe('Notes/A.md');
		expect(issue?.title).toBe('A');
		expect(issue?.detail).toBe('Links to "Ghost Note Alpha", which does not exist');
		expect(issue?.data).toEqual({
			kind: 'broken-link',
			target: 'Ghost Note Alpha',
			raw: '[[Ghost Note Alpha]]',
			line: 0,
			col: 4,
			isEmbed: false,
			isMarkdownLink: false,
		});
		expect(issue?.id.startsWith('broken-link:')).toBe(true);
	});

	it('reports embeds and markdown links, flagging each kind', () => {
		const app = buildVault([
			{
				path: 'A.md',
				content:
					'![[missing-image.png]]\n\n[label](missing-note.md)\n\n[web](https://x.test)',
			},
		]);
		const issues = brokenLinks.run(makeContext(app));

		expect(issues).toHaveLength(2);
		const embed = issues.find(
			(issue) => issue.data.kind === 'broken-link' && issue.data.isEmbed,
		);
		const markdown = issues.find(
			(issue) => issue.data.kind === 'broken-link' && issue.data.isMarkdownLink,
		);
		expect(embed?.detail).toBe('Links to "missing-image.png", which does not exist');
		expect(markdown?.detail).toBe('Links to "missing-note.md", which does not exist');
		// External URLs are never vault links, so they must not be reported.
		expect(issues.some((issue) => issue.detail.includes('x.test'))).toBe(false);
	});

	it('reports each occurrence of the same broken target separately with unique ids', () => {
		const app = buildVault([
			{ path: 'A.md', content: 'First [[Ghost]].\n\nSecond [[Ghost]].\n\nThird [[Ghost]].' },
		]);
		const issues = brokenLinks.run(makeContext(app));

		expect(issues).toHaveLength(3);
		expect(new Set(issues.map((issue) => issue.id)).size).toBe(3);
		expect(
			issues.map((issue) => (issue.data.kind === 'broken-link' ? issue.data.line : -1)),
		).toEqual([0, 2, 4]);
	});

	it('keeps ids stable across runs and across unrelated edits', () => {
		const first = brokenLinks.run(
			makeContext(buildVault([{ path: 'A.md', content: 'x [[Ghost]] y [[Ghost]]' }])),
		);
		const second = brokenLinks.run(
			makeContext(
				buildVault([
					{
						path: 'A.md',
						content: 'prefix line\n\nx [[Ghost]] y [[Ghost]] trailing words',
					},
				]),
			),
		);

		expect(first.map((issue) => issue.id)).toEqual(second.map((issue) => issue.id));
	});

	it('keeps an occurrence id stable when a different broken link is added ahead of it', () => {
		const before = brokenLinks.run(
			makeContext(buildVault([{ path: 'A.md', content: 'x [[Ghost]] y [[Ghost]]' }])),
		);
		const after = brokenLinks.run(
			makeContext(
				buildVault([{ path: 'A.md', content: '[[Other Ghost]] x [[Ghost]] y [[Ghost]]' }]),
			),
		);

		// Occurrences are counted per target, not per file: a per-file ordinal would shift
		// both Ghost ids here and silently drop them out of the user's ignore list.
		const ghostIds = (issues: readonly { id: string; detail: string }[]): string[] =>
			issues.filter((issue) => issue.detail.includes('"Ghost"')).map((issue) => issue.id);

		expect(before).toHaveLength(2);
		expect(after).toHaveLength(3);
		expect(ghostIds(after)).toEqual(ghostIds(before));
	});

	it('handles unicode filenames and unicode link targets', () => {
		const app = buildVault([
			{ path: 'ノート/日本語ノート.md', content: '参照: [[存在しないノート]] と [[Café Ω]]' },
		]);
		const issues = brokenLinks.run(makeContext(app));

		expect(issues).toHaveLength(2);
		expect(issues[0]?.path).toBe('ノート/日本語ノート.md');
		expect(issues[0]?.title).toBe('日本語ノート');
		expect(issues.map((issue) => issue.detail)).toEqual([
			'Links to "存在しないノート", which does not exist',
			'Links to "Café Ω", which does not exist',
		]);
	});

	it('handles special characters in filenames', () => {
		const app = buildVault([
			{ path: 'Problem Notes/special chars - @$%.md', content: 'x [[No Such Note]]' },
		]);
		const issues = brokenLinks.run(makeContext(app));

		expect(issues).toHaveLength(1);
		expect(issues[0]?.path).toBe('Problem Notes/special chars - @$%.md');
		expect(issues[0]?.title).toBe('special chars - @$%');
	});

	it('still scans notes whose frontmatter is missing or corrupt', () => {
		const app = buildVault([
			{ path: 'no-frontmatter.md', content: 'plain [[Ghost A]]' },
			{ path: 'corrupt.md', content: '---\ntags [broken\n---\n\n[[Ghost B]]' },
		]);
		const issues = brokenLinks.run(makeContext(app));

		expect(issues.map((issue) => issue.path).sort()).toEqual([
			'corrupt.md',
			'no-frontmatter.md',
		]);
	});

	it('scans a note larger than 100 KB', () => {
		const filler = 'lorem ipsum dolor sit amet. '.repeat(4000);
		const app = buildVault([{ path: 'long.md', content: `${filler}\n\n[[Ghost At The End]]` }]);
		expect(filler.length).toBeGreaterThan(100_000);

		const issues = brokenLinks.run(makeContext(app));
		expect(issues).toHaveLength(1);
		expect(issues[0]?.detail).toBe('Links to "Ghost At The End", which does not exist');
	});

	it('only reports notes that are in scope', () => {
		const app = buildVault([
			{ path: '00-Inbox/capture.md', content: '[[Ghost In Inbox]]' },
			{ path: 'Notes/kept.md', content: '[[Ghost In Notes]]' },
		]);
		const issues = brokenLinks.run(
			makeContext(app, { exclude: (record) => record.path.startsWith('00-Inbox/') }),
		);

		expect(issues).toHaveLength(1);
		expect(issues[0]?.path).toBe('Notes/kept.md');
	});

	it('picks up a link that breaks when its target moves out from under it', async () => {
		const app = buildVault([
			{ path: 'A.md', content: 'See [[B]].' },
			{ path: 'B.md', content: 'b' },
		]);
		expect(brokenLinks.run(makeContext(app))).toEqual([]);

		const target = app.vault.getFileByPath('B.md');
		if (!target) throw new Error('fixture is missing B.md');
		await app.vault.rename(target, 'B renamed.md');

		const issues = brokenLinks.run(makeContext(app));
		expect(issues).toHaveLength(1);
		expect(issues[0]?.detail).toBe('Links to "B", which does not exist');
	});
});

describe('broken links against the on-disk fixture', () => {
	let context: DetectorContext;

	beforeEach(() => {
		context = makeContext(loadVaultFromDisk(), {
			exclude: (record) => record.path.startsWith('00-Inbox/'),
		});
	});

	it('reports every broken link outside the inbox', () => {
		const issues = brokenLinks.run(context);

		expect(issues).toHaveLength(8);
		expect(
			issues.filter((issue) => issue.path === 'Problem Notes/broken-link-note.md'),
		).toHaveLength(3);
		expect(
			issues.filter((issue) => issue.path === 'Problem Notes/multiple-broken-links.md'),
		).toHaveLength(5);
		expect(issues.every((issue) => issue.severity === 'high')).toBe(true);
		expect(new Set(issues.map((issue) => issue.id)).size).toBe(8);
	});
});
