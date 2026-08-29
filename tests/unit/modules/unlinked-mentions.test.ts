/**
 * Unlinked mentions.
 *
 * The scan skips a target whose first word is absent from the note rather than searching the
 * body for it, which is what keeps the whole-vault view from being a text scan per title per
 * note. That shortcut is only safe because a match is bounded by non-word characters, so the
 * title's interior words are whole words in the body too — these tests are mostly about the
 * titles where that reasoning is least obvious: ones opening with punctuation, ones with no
 * word characters at all, and ones sitting against a word character in the text.
 *
 * The ordering is also prepared once for a whole-vault pass, so a prepared target list and a
 * raw one have to produce byte-identical results.
 */

import { describe, expect, it } from 'vitest';
import {
	findUnlinkedMentionsInNote,
	maskUnlinkableRegions,
	prepareMentionTargets,
	type MentionTarget,
} from '../../../src/modules/retrieval/contextual/unlinked-mentions';

const OPTIONS = { minLength: 3 };

function targets(...titles: string[]): MentionTarget[] {
	return titles.map((title, index) => ({ path: `notes/t${index}.md`, title }));
}

/** Mentions as `target@line:col`, for compact comparison. */
function summarize(
	mentions: readonly { targetTitle: string; line: number; col: number }[],
): string[] {
	return mentions.map((mention) => `${mention.targetTitle}@${mention.line}:${mention.col}`);
}

function scan(content: string, list: MentionTarget[], options = OPTIONS): string[] {
	return summarize(findUnlinkedMentionsInNote('notes/source.md', content, list, options));
}

describe('what the scan finds', () => {
	it('finds a plain mention', () => {
		expect(scan('See Project Alpha today.', targets('Project Alpha'))).toEqual([
			'Project Alpha@0:4',
		]);
	});

	it('lets the longer title claim the span', () => {
		const found = scan('See Project Alpha today.', targets('Project Alpha', 'Alpha'));
		expect(found).toEqual(['Project Alpha@0:4']);
	});

	it('never reports the note itself', () => {
		const list: MentionTarget[] = [{ path: 'notes/source.md', title: 'Project Alpha' }];
		expect(scan('See Project Alpha today.', list)).toEqual([]);
	});

	it('ignores a mention already inside a link or code', () => {
		const content = 'A [[Project Alpha]] and `Project Alpha` and [x](Project Alpha).';
		expect(scan(content, targets('Project Alpha'))).toEqual([]);
	});
});

describe('titles the first-word shortcut has to get right', () => {
	it('finds a title that opens with punctuation', () => {
		// The first *word* is `Draft`, not the bracket, and the bracket means the match does
		// not need a clean boundary on its left.
		expect(scan('See [Draft] Roadmap here.', targets('[Draft] Roadmap'))).toEqual([
			'[Draft] Roadmap@0:4',
		]);
	});

	it('finds a title that opens with punctuation even against a word character', () => {
		expect(scan('x[Draft] Roadmap here.', targets('[Draft] Roadmap'))).toEqual([
			'[Draft] Roadmap@0:1',
		]);
	});

	it('finds a title made only of punctuation, which has no first word to check', () => {
		expect(scan('A --- b', targets('---'))).toEqual(['---@0:2']);
	});

	it('does not match a title whose first word only appears glued to another word', () => {
		// `XAlpha` is not the word `Alpha`, so neither the shortcut nor a full scan matches.
		expect(scan('See XAlpha Beta today.', targets('Alpha Beta'))).toEqual([]);
	});

	it('matches a title whose words are separated by punctuation', () => {
		expect(scan('Read Book - Deep Work now.', targets('Book - Deep Work'))).toEqual([
			'Book - Deep Work@0:5',
		]);
	});

	it('matches case-insensitively', () => {
		expect(scan('see project alpha today', targets('Project Alpha'))).toEqual([
			'Project Alpha@0:4',
		]);
	});

	it('matches a unicode title', () => {
		expect(scan('メモ ユニコード ノート です', targets('ユニコード ノート'))).toEqual([
			'ユニコード ノート@0:3',
		]);
	});
});

describe('prepared targets', () => {
	const list = targets(
		'Project Alpha',
		'Alpha',
		'[Draft] Roadmap',
		'Deep Work',
		'Quarterly Planning Document',
	);
	const content = [
		'# Notes',
		'',
		'See Project Alpha and [Draft] Roadmap and Deep Work.',
		'Alpha alone, and Quarterly Planning Document at the end.',
	].join('\n');

	it('produces exactly what an unprepared list does', () => {
		const raw = scan(content, list);
		const prepared = summarize(
			findUnlinkedMentionsInNote(
				'notes/source.md',
				content,
				prepareMentionTargets(list, OPTIONS.minLength),
				OPTIONS,
			),
		);

		expect(prepared).toEqual(raw);
		expect(raw.length).toBeGreaterThan(0);
	});

	it('applies the length floor when preparing', () => {
		const prepared = prepareMentionTargets(targets('Alpha', 'ab'), 3);
		expect(prepared.entries.map((entry) => entry.target.title)).toEqual(['Alpha']);
	});

	it('orders longest title first, so a longer title still wins its span', () => {
		const prepared = prepareMentionTargets(targets('Alpha', 'Project Alpha'), 3);
		expect(prepared.entries.map((entry) => entry.target.title)).toEqual([
			'Project Alpha',
			'Alpha',
		]);
	});

	it('still excludes the source note when the list was prepared without it', () => {
		const list2: MentionTarget[] = [{ path: 'notes/source.md', title: 'Project Alpha' }];
		const prepared = prepareMentionTargets(list2, 3);
		expect(
			findUnlinkedMentionsInNote('notes/source.md', 'See Project Alpha.', prepared, OPTIONS),
		).toEqual([]);
	});
});

describe('masking', () => {
	it('preserves every offset so reported positions stay true', () => {
		const content = 'a `code` b [[link]] c';
		const masked = maskUnlinkableRegions(content);

		expect(masked).toHaveLength(content.length);
		expect(masked).toBe('a        b          c');
	});
});
