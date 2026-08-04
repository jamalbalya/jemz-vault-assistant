/**
 * The mock is the foundation every integration count rests on, so it is verified against
 * known facts about the on-disk fixture before anything else is trusted.
 */

import { describe, expect, it } from 'vitest';
import { getAllTags } from '../../mocks/obsidian';
import { parseFrontmatter, parseMetadata } from '../../mocks/parse-metadata';
import { loadVaultFromDisk, requireFile } from '../../helpers/vault-fixture';

describe('mock vault mirrors the on-disk fixture', () => {
	const app = loadVaultFromDisk();

	it('loads every file', () => {
		expect(app.vault.getFiles()).toHaveLength(73);
		expect(app.vault.getMarkdownFiles()).toHaveLength(64);
	});

	it('creates the folder tree', () => {
		expect(app.vault.getFolderByPath('00-Inbox')).not.toBeNull();
		expect(app.vault.getFolderByPath('99-Attachments/images')).not.toBeNull();
		expect(app.vault.getFolderByPath('Problem Notes')).not.toBeNull();
	});

	it('handles unicode and special characters in file names', () => {
		expect(app.vault.getFileByPath('Problem Notes/unicode-note-日本語.md')).not.toBeNull();
		expect(app.vault.getFileByPath('Problem Notes/special chars - @#$%.md')).not.toBeNull();
	});
});

describe('metadata parsing', () => {
	const app = loadVaultFromDisk();

	it('parses valid frontmatter', () => {
		const file = requireFile(app, '00-Inbox/2026-06-06 meeting - project kickoff.md');
		const cache = app.metadataCache.getFileCache(file);
		expect(cache?.frontmatter?.type).toBe('meeting');
		expect(cache?.frontmatter?.status).toBe('inbox');
		expect(cache?.frontmatter?.tags).toEqual(['inbox', 'meeting']);
	});

	it('discards corrupted frontmatter entirely, as Obsidian does', () => {
		const file = requireFile(app, 'Problem Notes/corrupted-frontmatter.md');
		const cache = app.metadataCache.getFileCache(file);
		expect(cache?.frontmatter).toBeUndefined();
	});

	it('reports no frontmatter for a note that has none', () => {
		const file = requireFile(app, 'Problem Notes/missing metadata note.md');
		const cache = app.metadataCache.getFileCache(file);
		expect(cache?.frontmatter).toBeUndefined();
	});

	it('does not treat a numeric hash run as a tag', () => {
		// "Review Pull Request #142" must not produce a #142 tag.
		const file = requireFile(app, '00-Inbox/2026-06-08 task - review PR.md');
		const cache = app.metadataCache.getFileCache(file);
		expect(cache?.tags ?? []).toHaveLength(0);
		expect(getAllTags(cache)).toEqual(['#inbox', '#task']);
	});

	it('ignores markdown headings when scanning for tags', () => {
		const cache = parseMetadata('# Heading\n\n## Another\n\ntext #real-tag here');
		expect((cache.tags ?? []).map((t) => t.tag)).toEqual(['#real-tag']);
		expect((cache.headings ?? []).map((h) => h.heading)).toEqual(['Heading', 'Another']);
	});

	it('masks code fences so links inside them are not indexed', () => {
		const cache = parseMetadata('```\n[[Not A Link]]\n```\n\n[[Real Link]]');
		expect((cache.links ?? []).map((l) => l.link)).toEqual(['Real Link']);
	});

	it('rejects malformed yaml', () => {
		expect(parseFrontmatter('created: 2026-05-28\ntype note')).toBeNull();
		expect(parseFrontmatter('tags [test, broken')).toBeNull();
		expect(parseFrontmatter('created: 2026-05-28\ntype: note')).toEqual({
			created: '2026-05-28',
			type: 'note',
		});
	});

	it('parses block and inline sequences', () => {
		expect(parseFrontmatter('tags:\n  - a\n  - b')).toEqual({ tags: ['a', 'b'] });
		expect(parseFrontmatter('tags: [a, b]')).toEqual({ tags: ['a', 'b'] });
		expect(parseFrontmatter('tags: []')).toEqual({ tags: [] });
	});
});

describe('link resolution', () => {
	const app = loadVaultFromDisk();

	it('prefers a file in the same folder', () => {
		const destination = app.metadataCache.getFirstLinkpathDest(
			'Project Alpha',
			'01-Projects/Project Alpha/Alpha - Meeting Notes.md',
		);
		expect(destination?.path).toBe('01-Projects/Project Alpha/Project Alpha.md');
	});

	it('falls back to the shortest path when no sibling matches', () => {
		const destination = app.metadataCache.getFirstLinkpathDest(
			'Project Alpha',
			'Daily Notes/2026-06-15.md',
		);
		expect(destination?.path).toBe('Unlinked Mentions/Project Alpha.md');
	});

	it('resolves full paths with extensions', () => {
		const destination = app.metadataCache.getFirstLinkpathDest(
			'99-Attachments/documents/used-document.pdf',
			'01-Projects/Project Alpha/Alpha - Requirements.md',
		);
		expect(destination?.path).toBe('99-Attachments/documents/used-document.pdf');
	});

	it('returns null for targets that do not exist', () => {
		expect(
			app.metadataCache.getFirstLinkpathDest('Ghost Note Alpha', 'Problem Notes/x.md'),
		).toBeNull();
	});

	it('builds the resolved and unresolved link tables', () => {
		const unresolvedTotal = Object.values(app.metadataCache.unresolvedLinks).reduce(
			(sum, targets) => sum + Object.keys(targets).length,
			0,
		);
		// 3 in broken-link-note, 5 in multiple-broken-links, 1 in the inbox article.
		expect(unresolvedTotal).toBe(9);

		expect(app.metadataCache.unresolvedLinks['Problem Notes/multiple-broken-links.md']).toEqual(
			{
				'Ghost Note Alpha': 1,
				'Phantom Document': 1,
				'Removed Reference': 1,
				'Lost Page': 1,
				'Forgotten Note': 1,
			},
		);
	});
});

describe('vault mutation', () => {
	it('creates, modifies, renames and trashes files with events', async () => {
		const app = loadVaultFromDisk();
		const events: string[] = [];
		app.vault.on('create', () => events.push('create'));
		app.vault.on('modify', () => events.push('modify'));
		app.vault.on('rename', () => events.push('rename'));
		app.vault.on('delete', () => events.push('delete'));

		const file = await app.vault.create(
			'00-Inbox/new note.md',
			'---\ntype: capture\n---\n\nhi',
		);
		expect(app.vault.getFileByPath('00-Inbox/new note.md')).not.toBeNull();

		await app.vault.modify(file, 'changed');
		expect(await app.vault.read(file)).toBe('changed');

		await app.vault.rename(file, '00-Inbox/renamed.md');
		expect(file.path).toBe('00-Inbox/renamed.md');
		expect(file.basename).toBe('renamed');

		await app.vault.trash(file, false);
		expect(app.vault.getFileByPath('00-Inbox/renamed.md')).toBeNull();

		expect(events).toEqual(['create', 'modify', 'rename', 'delete']);
	});

	it('refuses writes on a read-only vault', async () => {
		const app = loadVaultFromDisk();
		app.vault.readOnly = true;
		await expect(app.vault.create('x.md', 'y')).rejects.toThrow(/read-only/);
	});

	it('preserves the body and untouched keys through processFrontMatter', async () => {
		const app = loadVaultFromDisk();
		const file = requireFile(app, '00-Inbox/2026-06-07 capture - shower thought.md');

		await app.fileManager.processFrontMatter(file, (frontmatter) => {
			frontmatter.status = 'processed';
		});

		const content = await app.vault.read(file);
		expect(content).toContain('status: processed');
		expect(content).toContain('type: capture');
		expect(content).toContain('The best note-taking app is the one you actually use.');
	});
});
