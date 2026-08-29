/**
 * The link service performs the only edits in the plugin that rewrite a note in place, so
 * the tests lean hard on two things: that a stale offset never corrupts a file, and that
 * every syntactic variant (alias, subpath, embed, markdown link, CRLF, unicode) survives the
 * round trip untouched.
 *
 * Real `LinkRef` values come from `VaultIndex`, so the offsets under test are the ones
 * Obsidian's metadata cache actually produces rather than ones the test invented.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { App as ObsidianApp, TFile as ObsidianTFile } from 'obsidian';
import type { App, TFile as MockTFile } from '../../mocks/obsidian';
import { Logger } from '../../../src/core/logger';
import type { LinkRef } from '../../../src/types/note';
import { VaultIndex } from '../../../src/services/vault-index';
import {
	insertWikilinkAtEnd,
	lineColToOffset,
	LinkEditError,
	LinkFileError,
	LinkService,
	removeLinkKeepText,
	replaceLinkTarget,
	wrapAsWikilink,
} from '../../../src/services/link-service';
import { formatDate } from '../../../src/utils/date';
import { findWholeWordOccurrences, offsetToPosition } from '../../../src/utils/string';
import { buildVault, loadVaultFromDisk, requireFile } from '../../helpers/vault-fixture';

const logger = new Logger('silent');

/** A hand-built {@link LinkRef} whose position is derived from where `raw` sits in `content`. */
function makeLink(
	content: string,
	raw: string,
	target: string,
	displayText: string | null = null,
	occurrence = 0,
): LinkRef {
	let offset = -1;
	for (let found = 0; found <= occurrence; found++) {
		offset = content.indexOf(raw, offset + 1);
		if (offset === -1) throw new Error(`"${raw}" occurrence ${occurrence} not found`);
	}
	const { line, col } = offsetToPosition(content, offset);
	return {
		target,
		displayText,
		resolvedPath: null,
		isEmbed: raw.startsWith('!'),
		isMarkdownLink: raw.includes(']('),
		line,
		col,
		raw,
	};
}

/**
 * The mock implements the slice of the Obsidian API the plugin uses, not the whole class, so
 * the structural cast happens once here instead of at every call site.
 */
function asApp(app: App): ObsidianApp {
	return app as unknown as ObsidianApp;
}

/** The link with the given raw text, as the index recorded it. */
function indexedLink(app: App, path: string, raw: string): LinkRef {
	const index = new VaultIndex(asApp(app), logger);
	index.build();
	const link = index.get(path)?.links.find((candidate) => candidate.raw === raw);
	if (!link) throw new Error(`No link "${raw}" indexed in "${path}"`);
	return link;
}

function serviceFor(app: App, now = 1_770_000_000_000): LinkService {
	return new LinkService(asApp(app), logger, () => now);
}

/** Same cast as {@link asApp}, for files handed to the service. */
function asFile(file: MockTFile): ObsidianTFile {
	return file as unknown as ObsidianTFile;
}

function fileIn(app: App, path: string): ObsidianTFile {
	return asFile(requireFile(app, path));
}

describe('lineColToOffset', () => {
	it('converts positions on a plain file', () => {
		const content = 'alpha\nbeta\ngamma';
		expect(lineColToOffset(content, 0, 0)).toBe(0);
		expect(lineColToOffset(content, 1, 0)).toBe(6);
		expect(lineColToOffset(content, 1, 4)).toBe(10);
		expect(lineColToOffset(content, 2, 5)).toBe(16);
	});

	it('counts the carriage return of a CRLF line', () => {
		const content = 'alpha\r\nbeta';
		// "alpha\r" is six characters, then the newline.
		expect(lineColToOffset(content, 1, 0)).toBe(7);
		expect(content.slice(7)).toBe('beta');
	});

	it('rejects positions outside the file', () => {
		const content = 'alpha\nbeta';
		expect(lineColToOffset(content, -1, 0)).toBeNull();
		expect(lineColToOffset(content, 0, -1)).toBeNull();
		expect(lineColToOffset(content, 2, 0)).toBeNull();
		expect(lineColToOffset(content, 0, 6)).toBeNull();
		expect(lineColToOffset(content, 1.5, 0)).toBeNull();
		expect(lineColToOffset(content, 0, 0.5)).toBeNull();
	});

	it('handles an empty file', () => {
		expect(lineColToOffset('', 0, 0)).toBe(0);
		expect(lineColToOffset('', 0, 1)).toBeNull();
	});
});

describe('removeLinkKeepText', () => {
	it('keeps the target when the wikilink has no alias', () => {
		const content = 'See [[Project Alpha]] for details.';
		const link = makeLink(content, '[[Project Alpha]]', 'Project Alpha');
		expect(removeLinkKeepText(content, link)).toBe('See Project Alpha for details.');
	});

	it('keeps the alias when the wikilink has one', () => {
		const content = 'See [[Project Alpha|the project]] now.';
		const link = makeLink(
			content,
			'[[Project Alpha|the project]]',
			'Project Alpha',
			'the project',
		);
		expect(removeLinkKeepText(content, link)).toBe('See the project now.');
	});

	it('collapses an embed to its target', () => {
		const content = 'Diagram:\n![[diagram.png]]\nEnd.';
		const link = makeLink(content, '![[diagram.png]]', 'diagram.png');
		expect(removeLinkKeepText(content, link)).toBe('Diagram:\ndiagram.png\nEnd.');
	});

	it('keeps the text of a markdown link', () => {
		const content = 'Read [the notes](Notes/Meeting.md) today.';
		const link = makeLink(
			content,
			'[the notes](Notes/Meeting.md)',
			'Notes/Meeting.md',
			'the notes',
		);
		expect(removeLinkKeepText(content, link)).toBe('Read the notes today.');
	});

	it('falls back to the target when the markdown text is blank', () => {
		const content = 'Read [ ](Notes/Meeting.md) today.';
		const link = makeLink(content, '[ ](Notes/Meeting.md)', 'Notes/Meeting.md', ' ');
		expect(removeLinkKeepText(content, link)).toBe('Read Notes/Meeting.md today.');
	});

	it('handles unicode targets and aliases', () => {
		const content = '参照: [[日本語ノート|メモ]] です。';
		const link = makeLink(content, '[[日本語ノート|メモ]]', '日本語ノート', 'メモ');
		expect(removeLinkKeepText(content, link)).toBe('参照: メモ です。');
	});

	it('targets the right link when a line holds several', () => {
		const content = 'A [[One]] then [[One]] again.';
		const second = makeLink(content, '[[One]]', 'One', null, 1);
		expect(removeLinkKeepText(content, second)).toBe('A [[One]] then One again.');
	});

	it('works inside a CRLF file', () => {
		const content = 'intro\r\nSee [[Target]] here\r\nend';
		const link = makeLink(content, '[[Target]]', 'Target');
		expect(removeLinkKeepText(content, link)).toBe('intro\r\nSee Target here\r\nend');
	});

	it('refuses a link whose recorded raw text is empty', () => {
		// Every offset "contains" the empty string, so without a guard this splices the display
		// text into the middle of a word.
		const link: LinkRef = {
			target: 'Target',
			displayText: null,
			resolvedPath: null,
			isEmbed: false,
			isMarkdownLink: false,
			line: 0,
			col: 2,
			raw: '',
		};
		expect(() => removeLinkKeepText('hello', link)).toThrow(LinkEditError);
	});

	it('throws when the text at the recorded position changed', () => {
		const content = 'See [[Target]] here.';
		const link = makeLink(content, '[[Target]]', 'Target');
		expect(() => removeLinkKeepText('Padded! See [[Target]] here.', link)).toThrow(
			LinkEditError,
		);
	});

	it('throws when the recorded line no longer exists', () => {
		const content = 'one\ntwo\n[[Target]]';
		const link = makeLink(content, '[[Target]]', 'Target');
		expect(() => removeLinkKeepText('one', link)).toThrow(LinkEditError);
	});

	it('edits a very long note without touching the rest of it', () => {
		const filler = 'lorem ipsum dolor sit amet. '.repeat(4000);
		const content = `${filler}\n\nSee [[Target]] here.\n${filler}`;
		expect(content.length).toBeGreaterThan(100_000);
		const link = makeLink(content, '[[Target]]', 'Target');
		const result = removeLinkKeepText(content, link);
		expect(result).toBe(`${filler}\n\nSee Target here.\n${filler}`);
	});
});

describe('replaceLinkTarget', () => {
	it('swaps a plain wikilink target', () => {
		const content = 'See [[Old Note]].';
		const link = makeLink(content, '[[Old Note]]', 'Old Note');
		expect(replaceLinkTarget(content, link, 'New Note')).toBe('See [[New Note]].');
	});

	it('preserves the alias', () => {
		const content = 'See [[Old Note|the old one]].';
		const link = makeLink(content, '[[Old Note|the old one]]', 'Old Note', 'the old one');
		expect(replaceLinkTarget(content, link, 'New Note')).toBe('See [[New Note|the old one]].');
	});

	it('preserves a heading subpath', () => {
		const content = 'See [[Old Note#Summary]].';
		const link = makeLink(content, '[[Old Note#Summary]]', 'Old Note');
		expect(replaceLinkTarget(content, link, 'New Note')).toBe('See [[New Note#Summary]].');
	});

	it('preserves a block subpath together with an alias', () => {
		const content = 'See [[Old^abc123|quote]].';
		const link = makeLink(content, '[[Old^abc123|quote]]', 'Old', 'quote');
		expect(replaceLinkTarget(content, link, 'New')).toBe('See [[New^abc123|quote]].');
	});

	it('preserves the embed marker', () => {
		const content = '![[old-diagram.png]]';
		const link = makeLink(content, '![[old-diagram.png]]', 'old-diagram.png');
		expect(replaceLinkTarget(content, link, 'new-diagram.png')).toBe('![[new-diagram.png]]');
	});

	it('rewrites a markdown link and encodes unsafe characters', () => {
		const content = 'Read [the notes](Old.md) today.';
		const link = makeLink(content, '[the notes](Old.md)', 'Old.md', 'the notes');
		expect(replaceLinkTarget(content, link, 'New Notes (2026).md')).toBe(
			'Read [the notes](New%20Notes%20%282026%29.md) today.',
		);
	});

	it('preserves a markdown subpath and drops angle bracket delimiters', () => {
		const content = 'Read [notes](<Old Note.md#Summary>) today.';
		const link = makeLink(content, '[notes](<Old Note.md#Summary>)', 'Old Note.md', 'notes');
		expect(replaceLinkTarget(content, link, 'New.md')).toBe(
			'Read [notes](New.md#Summary) today.',
		);
	});

	it('encodes a space in a carried over subpath once the delimiters are gone', () => {
		// The `<...>` made the space legal; without them it has to be escaped or the
		// destination ends at "New.md#My".
		const content = 'Read [notes](<Old.md#My Summary>) today.';
		const link = makeLink(content, '[notes](<Old.md#My Summary>)', 'Old.md', 'notes');
		expect(replaceLinkTarget(content, link, 'New.md')).toBe(
			'Read [notes](New.md#My%20Summary) today.',
		);
	});

	it('leaves escapes the note already had in the subpath alone', () => {
		const content = 'Read [notes](Old.md#My%20Summary) today.';
		const link = makeLink(content, '[notes](Old.md#My%20Summary)', 'Old.md', 'notes');
		expect(replaceLinkTarget(content, link, 'New.md')).toBe(
			'Read [notes](New.md#My%20Summary) today.',
		);
	});

	it('encodes a literal percent so the destination stays decodable', () => {
		const content = 'Read [notes](Old.md) today.';
		const link = makeLink(content, '[notes](Old.md)', 'Old.md', 'notes');
		const result = replaceLinkTarget(content, link, '100% Done.md');

		expect(result).toBe('Read [notes](100%25%20Done.md) today.');
		const destination = /\]\(([^)]*)\)/.exec(result)?.[1] ?? '';
		expect(decodeURIComponent(destination)).toBe('100% Done.md');
	});

	it('does not read an escape a path never had', () => {
		const content = 'Read [notes](Old.md) today.';
		const link = makeLink(content, '[notes](Old.md)', 'Old.md', 'notes');
		const result = replaceLinkTarget(content, link, 'a%20b.md');

		expect(result).toBe('Read [notes](a%2520b.md) today.');
		const destination = /\]\(([^)]*)\)/.exec(result)?.[1] ?? '';
		expect(decodeURIComponent(destination)).toBe('a%20b.md');
	});

	it('keeps a markdown title', () => {
		const content = 'Read [notes](Old.md "The Title") today.';
		const link = makeLink(content, '[notes](Old.md "The Title")', 'Old.md', 'notes');
		expect(replaceLinkTarget(content, link, 'New.md')).toBe(
			'Read [notes](New.md "The Title") today.',
		);
	});

	it('keeps markdown link text that is empty', () => {
		const content = 'Read [](old.md) today.';
		const link = makeLink(content, '[](old.md)', 'old.md', '');
		expect(replaceLinkTarget(content, link, 'new.md')).toBe('Read [](new.md) today.');
	});

	it('lets a subpath on the replacement win instead of doubling it', () => {
		const wiki = 'See [[Old#A]].';
		const wikiLink = makeLink(wiki, '[[Old#A]]', 'Old');
		expect(replaceLinkTarget(wiki, wikiLink, 'New#B')).toBe('See [[New#B]].');

		const md = 'Read [notes](Old.md#A) today.';
		const mdLink = makeLink(md, '[notes](Old.md#A)', 'Old.md', 'notes');
		expect(replaceLinkTarget(md, mdLink, 'New.md#B')).toBe('Read [notes](New.md#B) today.');
	});

	it('refuses a target that would end the wikilink early', () => {
		const content = 'See [[Old Note]].';
		const link = makeLink(content, '[[Old Note]]', 'Old Note');
		for (const target of ['a]]b', 'a[[b', 'a|b', 'a\nb']) {
			expect(() => replaceLinkTarget(content, link, target)).toThrow(LinkEditError);
		}
		expect(content).toBe('See [[Old Note]].');
	});

	it('refuses a markdown target that spans a line break', () => {
		const content = 'Read [notes](Old.md) today.';
		const link = makeLink(content, '[notes](Old.md)', 'Old.md', 'notes');
		expect(() => replaceLinkTarget(content, link, 'New\nNote.md')).toThrow(LinkEditError);
	});

	it('keeps a markdown embed an embed', () => {
		const content = '![alt text](old.png)';
		const link = makeLink(content, '![alt text](old.png)', 'old.png', 'alt text');
		expect(replaceLinkTarget(content, link, 'new.png')).toBe('![alt text](new.png)');
	});

	it('refuses a blank target rather than writing [[]]', () => {
		const content = 'See [[Old Note]].';
		const link = makeLink(content, '[[Old Note]]', 'Old Note');
		expect(() => replaceLinkTarget(content, link, '   ')).toThrow(LinkEditError);
	});

	it('refuses raw text that is not a link', () => {
		const content = 'See Old Note.';
		const link = makeLink(content, 'Old Note', 'Old Note');
		expect(() => replaceLinkTarget(content, link, 'New Note')).toThrow(LinkEditError);
	});

	it('refuses a stale position', () => {
		const content = 'See [[Old Note]].';
		const link = makeLink(content, '[[Old Note]]', 'Old Note');
		expect(() => replaceLinkTarget('x See [[Old Note]].', link, 'New')).toThrow(LinkEditError);
	});
});

describe('wrapAsWikilink', () => {
	it('wraps a span that matches the target exactly', () => {
		const content = 'I like Project Alpha a lot.';
		const start = content.indexOf('Project Alpha');
		const result = wrapAsWikilink(
			content,
			start,
			start + 'Project Alpha'.length,
			'Project Alpha',
		);
		expect(result).toBe('I like [[Project Alpha]] a lot.');
	});

	it('aliases the original words when they differ from the target', () => {
		const content = 'I like project alpha a lot.';
		const start = content.indexOf('project alpha');
		const result = wrapAsWikilink(
			content,
			start,
			start + 'project alpha'.length,
			'Project Alpha',
		);
		expect(result).toBe('I like [[Project Alpha|project alpha]] a lot.');
	});

	it('handles unicode spans', () => {
		const content = '今日は日本語ノートを読んだ。';
		const start = content.indexOf('日本語ノート');
		const result = wrapAsWikilink(
			content,
			start,
			start + '日本語ノート'.length,
			'日本語ノート',
		);
		expect(result).toBe('今日は[[日本語ノート]]を読んだ。');
	});

	it('keeps a target containing special characters intact', () => {
		const content = 'see special chars here';
		const result = wrapAsWikilink(content, 4, 17, 'special chars - @$%');
		expect(result).toBe('see [[special chars - @$%|special chars]] here');
	});

	it('refuses ranges outside the content', () => {
		const content = 'short';
		expect(() => wrapAsWikilink(content, -1, 3, 'T')).toThrow(LinkEditError);
		expect(() => wrapAsWikilink(content, 0, 99, 'T')).toThrow(LinkEditError);
		expect(() => wrapAsWikilink(content, 3, 1, 'T')).toThrow(LinkEditError);
		expect(() => wrapAsWikilink(content, 2, 2, 'T')).toThrow(LinkEditError);
		expect(() => wrapAsWikilink(content, 0.5, 3, 'T')).toThrow(LinkEditError);
		expect(() => wrapAsWikilink(content, 0, 3.5, 'T')).toThrow(LinkEditError);
	});

	it('refuses a blank target', () => {
		expect(() => wrapAsWikilink('some text', 0, 4, '  ')).toThrow(LinkEditError);
	});

	it('refuses a target holding a bracket or a pipe', () => {
		for (const target of ['a]]b', 'a[[b', 'a|b']) {
			expect(() => wrapAsWikilink('some text', 0, 4, target)).toThrow(LinkEditError);
		}
	});

	it('refuses a span that would close the link inside its own alias', () => {
		// `[[Target|a]]b]]` would leave a stray `b]]` sitting in the sentence.
		expect(() => wrapAsWikilink('text a]]b more', 5, 9, 'Target')).toThrow(LinkEditError);
		expect(() => wrapAsWikilink('a [x] b', 2, 5, 'Target')).toThrow(LinkEditError);
	});

	it('refuses a span that crosses a line break', () => {
		expect(() => wrapAsWikilink('ab\ncd', 0, 5, 'Target')).toThrow(LinkEditError);
	});
});

describe('insertWikilinkAtEnd', () => {
	it('appends on a new line with exactly one trailing newline', () => {
		expect(insertWikilinkAtEnd('Body text.', '[[Note]]')).toBe('Body text.\n[[Note]]\n');
	});

	it('collapses existing trailing blank lines', () => {
		expect(insertWikilinkAtEnd('Body text.\n\n\n', '[[Note]]')).toBe('Body text.\n[[Note]]\n');
	});

	it('handles an empty note', () => {
		expect(insertWikilinkAtEnd('', '[[Note]]')).toBe('[[Note]]\n');
		expect(insertWikilinkAtEnd('\n\n', '[[Note]]')).toBe('[[Note]]\n');
	});

	it('keeps a CRLF note using CRLF', () => {
		expect(insertWikilinkAtEnd('Body.\r\n\r\n', '[[Note]]')).toBe('Body.\r\n[[Note]]\r\n');
		// Even when the only CRLF is above the last line, which has none of its own.
		expect(insertWikilinkAtEnd('Body.\r\nMore.', '[[Note]]')).toBe(
			'Body.\r\nMore.\r\n[[Note]]\r\n',
		);
	});

	it('follows the last line ending of a mixed file rather than the first', () => {
		expect(insertWikilinkAtEnd('a\r\nb\n', '[[Note]]')).toBe('a\r\nb\n[[Note]]\n');
		expect(insertWikilinkAtEnd('a\nb\r\n', '[[Note]]')).toBe('a\nb\r\n[[Note]]\r\n');
	});

	it('trims the link text and refuses a blank one', () => {
		expect(insertWikilinkAtEnd('Body.', '  [[Note]]  ')).toBe('Body.\n[[Note]]\n');
		expect(() => insertWikilinkAtEnd('Body.', '   ')).toThrow(LinkEditError);
	});

	it('refuses link text that spans a line break', () => {
		expect(() => insertWikilinkAtEnd('Body.', '[[A]]\n[[B]]')).toThrow(LinkEditError);
	});
});

describe('LinkService editing methods', () => {
	let app: App;
	let service: LinkService;

	beforeEach(() => {
		app = buildVault([
			{
				path: 'Notes/Source.md',
				content: 'Intro.\n\nSee [[Ghost Note]] and [[Real Note|it]].\n',
			},
			{ path: 'Notes/Real Note.md', content: '# Real Note\n' },
			{ path: 'Notes/Replacement.md', content: '# Replacement\n' },
		]);
		service = serviceFor(app);
	});

	it('removes a link and writes the file', async () => {
		const link = indexedLink(app, 'Notes/Source.md', '[[Ghost Note]]');
		const result = await service.removeLink(fileIn(app, 'Notes/Source.md'), link);

		expect(result).toBe('Intro.\n\nSee Ghost Note and [[Real Note|it]].\n');
		expect(app.vault.peek('Notes/Source.md')).toBe(result);
	});

	it('retargets a link, keeping its alias', async () => {
		const link = indexedLink(app, 'Notes/Source.md', '[[Real Note|it]]');
		const source = requireFile(app, 'Notes/Source.md');
		const mtimeBefore = source.stat.mtime;
		const result = await service.retargetLink(asFile(source), link, 'Replacement');

		expect(result).toBe('Intro.\n\nSee [[Ghost Note]] and [[Replacement|it]].\n');
		expect(app.vault.peek('Notes/Source.md')).toBe(result);
		// The counterpart of the no-op case below: a real edit does move the mtime, so the
		// assertion there is about the skipped write and not about a clock that never ticks.
		expect(source.stat.mtime).not.toBe(mtimeBefore);
	});

	it('skips the write when retargeting changes nothing', async () => {
		const link = indexedLink(app, 'Notes/Source.md', '[[Ghost Note]]');
		const source = requireFile(app, 'Notes/Source.md');
		const mtimeBefore = source.stat.mtime;
		let modifications = 0;
		app.vault.on('modify', () => {
			modifications += 1;
		});

		const result = await service.retargetLink(asFile(source), link, 'Ghost Note');

		expect(result).toBe('Intro.\n\nSee [[Ghost Note]] and [[Real Note|it]].\n');
		expect(modifications).toBe(0);
		expect(source.stat.mtime).toBe(mtimeBefore);
	});

	it('appends a generated link to the end of a note', async () => {
		const result = await service.appendLink(
			fileIn(app, 'Notes/Source.md'),
			fileIn(app, 'Notes/Replacement.md'),
		);

		expect(result).toBe(
			'Intro.\n\nSee [[Ghost Note]] and [[Real Note|it]].\n[[Replacement]]\n',
		);
		expect(app.vault.peek('Notes/Source.md')).toBe(result);
	});

	it('refuses to edit when the file changed after the link was recorded', async () => {
		const link = indexedLink(app, 'Notes/Source.md', '[[Ghost Note]]');
		const file = requireFile(app, 'Notes/Source.md');
		const edited = 'Intro.\n\nA human typed here. See [[Ghost Note]] and [[Real Note|it]].\n';
		await app.vault.modify(file, edited);

		await expect(service.removeLink(asFile(file), link)).rejects.toBeInstanceOf(LinkEditError);
		expect(app.vault.peek('Notes/Source.md')).toBe(edited);
	});

	it('reports an unreadable file as a LinkFileError', async () => {
		const link = indexedLink(app, 'Notes/Source.md', '[[Ghost Note]]');
		const file = requireFile(app, 'Notes/Source.md');
		await app.vault.delete(file);

		await expect(service.removeLink(asFile(file), link)).rejects.toBeInstanceOf(LinkFileError);
	});

	it('reports a read-only vault as a LinkFileError', async () => {
		const link = indexedLink(app, 'Notes/Source.md', '[[Ghost Note]]');
		const file = fileIn(app, 'Notes/Source.md');
		app.vault.readOnly = true;

		await expect(service.removeLink(file, link)).rejects.toBeInstanceOf(LinkFileError);
		expect(app.vault.peek('Notes/Source.md')).toBe(
			'Intro.\n\nSee [[Ghost Note]] and [[Real Note|it]].\n',
		);
	});

	it('edits a note larger than 100 KB', async () => {
		const filler = 'padding text that goes on and on. '.repeat(4000);
		const big = buildVault([{ path: 'big.md', content: `${filler}\n\nSee [[Ghost]].\n` }]);
		expect((big.vault.peek('big.md') ?? '').length).toBeGreaterThan(100_000);

		const link = indexedLink(big, 'big.md', '[[Ghost]]');
		const result = await serviceFor(big).removeLink(fileIn(big, 'big.md'), link);

		expect(result.endsWith('\n\nSee Ghost.\n')).toBe(true);
		expect(result.startsWith(filler)).toBe(true);
	});
});

describe('LinkService.createMissingNote', () => {
	const now = new Date(2026, 7, 3, 9, 30).getTime();

	it('creates the note with default properties and a heading', async () => {
		const app = buildVault([{ path: 'Notes/Source.md', content: 'See [[Missing Note]].' }]);
		const file = await serviceFor(app, now).createMissingNote('Missing Note', 'Notes');

		expect(file.path).toBe('Notes/Missing Note.md');
		expect(app.vault.peek('Notes/Missing Note.md')).toBe(
			'---\ncreated: 2026-08-03\ntype: note\n---\n\n# Missing Note\n',
		);
	});

	it('makes the broken link resolve afterwards', async () => {
		const app = buildVault([{ path: 'Notes/Source.md', content: 'See [[Missing Note]].' }]);
		const service = serviceFor(app, now);
		expect(service.resolve('Missing Note', 'Notes/Source.md')).toBeNull();

		await service.createMissingNote('Missing Note', 'Notes');
		app.metadataCache.refresh();

		expect(service.resolve('Missing Note', 'Notes/Source.md')?.path).toBe(
			'Notes/Missing Note.md',
		);
	});

	it('stamps the current date when no clock is injected', async () => {
		const app = buildVault([{ path: 'a.md', content: 'x' }]);
		const service = new LinkService(asApp(app), logger);

		await service.createMissingNote('Missing Note', 'Notes');

		expect(app.vault.peek('Notes/Missing Note.md')).toContain(
			`created: ${formatDate(Date.now(), 'YYYY-MM-DD')}`,
		);
	});

	it('drops a subpath from the target', async () => {
		const app = buildVault([{ path: 'a.md', content: 'x' }]);
		const file = await serviceFor(app, now).createMissingNote('Missing Note#Summary', 'Notes');
		expect(file.path).toBe('Notes/Missing Note.md');
	});

	it('sanitises characters a file name cannot contain', async () => {
		const app = buildVault([{ path: 'a.md', content: 'x' }]);
		const file = await serviceFor(app, now).createMissingNote('Bad:Name*Here?', 'Notes');
		expect(file.path).toBe('Notes/Bad Name Here.md');
	});

	it('refuses to let a target climb out of the vault', async () => {
		// A link target is note text and may say anything. `normalizeVaultPath` only tidies
		// slashes, so `..` survives it; without a check the note would be created outside the
		// vault. The name is kept and the note lands in the configured folder instead.
		const app = buildVault([{ path: 'a.md', content: 'x' }]);
		const file = await serviceFor(app, now).createMissingNote(
			'../../outside/Roadmap',
			'00-Inbox',
		);

		expect(file.path).toBe('00-Inbox/Roadmap.md');
	});

	it('treats a target that names its own folder as vault relative', async () => {
		const app = buildVault([{ path: 'a.md', content: 'x' }]);
		const file = await serviceFor(app, now).createMissingNote(
			'Projects/2026/Roadmap',
			'00-Inbox',
		);

		expect(file.path).toBe('Projects/2026/Roadmap.md');
		expect(app.vault.getFolderByPath('Projects')).not.toBeNull();
		expect(app.vault.getFolderByPath('Projects/2026')).not.toBeNull();
	});

	it('creates unicode file names', async () => {
		const app = buildVault([{ path: 'a.md', content: 'x' }]);
		const file = await serviceFor(app, now).createMissingNote('日本語ノート', 'メモ');
		expect(file.path).toBe('メモ/日本語ノート.md');
	});

	it('falls back to Untitled for an empty target', async () => {
		const app = buildVault([{ path: 'a.md', content: 'x' }]);
		const file = await serviceFor(app, now).createMissingNote('   ', 'Notes');
		expect(file.path).toBe('Notes/Untitled.md');
	});

	it('does not double the markdown extension', async () => {
		const app = buildVault([{ path: 'a.md', content: 'x' }]);
		const file = await serviceFor(app, now).createMissingNote('Missing Note.MD', 'Notes');
		expect(file.path).toBe('Notes/Missing Note.md');
	});

	it('keeps a non-markdown extension in the note name so the link resolves', async () => {
		const app = buildVault([{ path: 'a.md', content: '![[diagram.png]]' }]);
		const service = serviceFor(app, now);
		const file = await service.createMissingNote('diagram.png', 'Attachments');

		expect(file.path).toBe('Attachments/diagram.png.md');
		app.metadataCache.refresh();
		expect(service.resolve('diagram.png', 'a.md')?.path).toBe('Attachments/diagram.png.md');
	});

	it('never overwrites an existing file', async () => {
		const app = buildVault([{ path: 'Notes/Taken.md', content: 'original content' }]);
		const file = await serviceFor(app, now).createMissingNote('Taken', 'Notes');

		expect(file.path).toBe('Notes/Taken 2.md');
		expect(app.vault.peek('Notes/Taken.md')).toBe('original content');
	});

	it('works on an empty vault', async () => {
		const app = buildVault([]);
		const file = await serviceFor(app, now).createMissingNote('First Note', '');
		expect(file.path).toBe('First Note.md');
	});

	it('tolerates a folder that appears while it is being created', async () => {
		const app = buildVault([{ path: 'a.md', content: 'x' }]);
		const realCreateFolder = app.vault.createFolder.bind(app.vault);
		app.vault.createFolder = async (path: string) => {
			const folder = await realCreateFolder(path);
			// Another client created it a moment earlier; Obsidian then rejects our attempt.
			throw Object.assign(new Error('Folder already exists'), { folder });
		};

		const file = await serviceFor(app, now).createMissingNote('Team/Notes/Kickoff', 'Notes');
		expect(file.path).toBe('Team/Notes/Kickoff.md');
	});

	it('reports a folder that cannot be created as a LinkFileError', async () => {
		const app = buildVault([{ path: 'a.md', content: 'x' }]);
		app.vault.createFolder = async (): Promise<never> => {
			throw new Error('EACCES');
		};

		await expect(
			serviceFor(app, now).createMissingNote('Team/Kickoff', 'Notes'),
		).rejects.toBeInstanceOf(LinkFileError);
	});

	it('reports a read-only vault as a LinkFileError', async () => {
		const app = buildVault([{ path: 'a.md', content: 'x' }]);
		app.vault.readOnly = true;

		await expect(
			serviceFor(app, now).createMissingNote('Missing Note', 'Notes'),
		).rejects.toBeInstanceOf(LinkFileError);
	});
});

describe('LinkService.resolve and generateLink', () => {
	const app = loadVaultFromDisk();
	const service = serviceFor(app);

	it('prefers a note in the source folder', () => {
		expect(
			service.resolve('Project Alpha', '01-Projects/Project Alpha/Alpha - Meeting Notes.md')
				?.path,
		).toBe('01-Projects/Project Alpha/Project Alpha.md');
	});

	it('ignores a subpath when resolving', () => {
		expect(service.resolve('Atomic Habits#Systems', 'Daily Notes/2026-06-15.md')?.path).toBe(
			'Unlinked Mentions/Atomic Habits.md',
		);
	});

	it('returns null for a target that does not exist', () => {
		expect(service.resolve('Ghost Note Alpha', 'Problem Notes/broken-link-note.md')).toBeNull();
	});

	it('returns null for a target with no path part', () => {
		expect(service.resolve('#Summary', 'Problem Notes/broken-link-note.md')).toBeNull();
		expect(service.resolve('   ', 'Problem Notes/broken-link-note.md')).toBeNull();
	});

	it('generates plain and aliased links', () => {
		const target = fileIn(app, 'Unlinked Mentions/Atomic Habits.md');
		expect(service.generateLink(target, 'Daily Notes/2026-06-15.md')).toBe('[[Atomic Habits]]');
		expect(service.generateLink(target, 'Daily Notes/2026-06-15.md', 'the book')).toBe(
			'[[Atomic Habits|the book]]',
		);
	});
});

describe('LinkService against the on-disk vault', () => {
	it('removes every broken link in a note, one after another', async () => {
		const app = loadVaultFromDisk();
		const service = serviceFor(app);
		const path = 'Problem Notes/broken-link-note.md';
		const file = fileIn(app, path);
		const before = app.vault.peek(path) ?? '';

		// Recorded up front, before a single byte moves: each link keeps its own line, so the
		// offsets captured now must still be valid after the earlier edits have landed. Re-
		// indexing between edits would hide exactly the staleness this is checking for.
		const links = ['[[Non Existent Note 1]]', '[[Missing Document]]', '[[Deleted Page]]'].map(
			(raw) => indexedLink(app, path, raw),
		);
		expect(new Set(links.map((link) => link.line)).size).toBe(3);

		for (const link of links) await service.removeLink(file, link);

		const content = app.vault.peek(path) ?? '';
		expect(content).toContain('- See Non Existent Note 1 for details');
		expect(content).toContain('- Also check Missing Document');
		expect(content).toContain('- Reference: Deleted Page');
		expect(content).not.toContain('[[');
		// Only the six bracket pairs went; the rest of the note is byte-identical.
		expect(content).toBe(before.replace(/\[\[|\]\]/g, ''));
	});

	it('retargets a broken link at an existing note', async () => {
		const app = loadVaultFromDisk();
		const service = serviceFor(app);
		const path = 'Problem Notes/multiple-broken-links.md';
		const link = indexedLink(app, path, '[[Ghost Note Alpha]]');

		await service.retargetLink(fileIn(app, path), link, 'Project Alpha');

		expect(app.vault.peek(path)).toContain('1. [[Project Alpha]]');
		app.metadataCache.refresh();
		expect(service.resolve('Project Alpha', path)?.path).toBe(
			'Unlinked Mentions/Project Alpha.md',
		);
	});

	it('converts an unlinked mention into a link', async () => {
		const app = loadVaultFromDisk();
		const path = 'Unlinked Mentions/note-with-unlinked-mentions.md';
		const file = requireFile(app, path);
		const content = await app.vault.read(file);

		const [first] = findWholeWordOccurrences(content, 'Project Alpha');
		if (!first) throw new Error('The fixture should mention Project Alpha');
		const next = wrapAsWikilink(content, first[0], first[1], 'Project Alpha');
		await app.vault.modify(file, next);

		expect(app.vault.peek(path)).toContain(
			'Today I was thinking about [[Project Alpha]] and how it is going well.',
		);
	});

	it('appends a link to a note whose name contains unicode', async () => {
		const app = loadVaultFromDisk();
		const service = serviceFor(app);
		const source = fileIn(app, 'Problem Notes/unicode-note-日本語.md');
		const target = fileIn(app, 'Unlinked Mentions/Atomic Habits.md');

		const before = app.vault.peek('Problem Notes/unicode-note-日本語.md') ?? '';
		const result = await service.appendLink(source, target);

		expect(result).toBe(`${before.replace(/\n+$/, '')}\n[[Atomic Habits]]\n`);
		expect(result).not.toMatch(/\n\n\[\[Atomic Habits\]\]\n$/);
		expect(app.vault.peek('Problem Notes/unicode-note-日本語.md')).toBe(result);
	});

	it('appends to a note with special characters in its name', async () => {
		const app = loadVaultFromDisk();
		const service = serviceFor(app);
		const source = fileIn(app, 'Problem Notes/special chars - @#$%.md');
		const target = fileIn(app, 'Unlinked Mentions/Project Alpha.md');

		const result = await service.appendLink(source, target);
		expect(result.endsWith('\n[[Project Alpha]]\n')).toBe(true);
	});

	it('leaves a note with corrupt frontmatter otherwise untouched', async () => {
		const app = loadVaultFromDisk();
		const service = serviceFor(app);
		const path = 'Problem Notes/corrupted-frontmatter.md';
		const before = app.vault.peek(path) ?? '';
		const target = fileIn(app, 'Unlinked Mentions/Project Alpha.md');

		const after = await service.appendLink(fileIn(app, path), target);

		expect(after.startsWith(before.replace(/\n+$/, ''))).toBe(true);
		expect(after.endsWith('[[Project Alpha]]\n')).toBe(true);
	});
});
