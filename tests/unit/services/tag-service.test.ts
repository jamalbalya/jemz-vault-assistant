/**
 * Tag grouping, suggestion and rename.
 *
 * The grouping tests pin the length-scaled distance rule from the plan (D5): `task`/`test`
 * must stay apart while `developement`/`development` must merge. The rename tests exist
 * because an inline rewrite is the one place this plugin edits note bodies by hand, so every
 * way a `#` can appear without being a tag is covered explicitly.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { App as ObsidianApp, TFile as ObsidianTFile } from 'obsidian';
import { App as MockApp, type TFile as MockTFile } from '../../mocks/obsidian';
import { buildVault, loadVaultFromDisk, requireFile } from '../../helpers/vault-fixture';
import { Logger } from '../../../src/core/logger';
import { VaultIndex } from '../../../src/services/vault-index';
import {
	frontmatterHasTag,
	groupSimilarTags,
	renameTagInFrontmatter,
	rewriteInlineTags,
	TagRenameError,
	TagService,
	type TagGroup,
	type TagSimilarityOptions,
} from '../../../src/services/tag-service';
import { DEFAULT_SETTINGS } from '../../../src/types/settings';
import type { HealthSettings } from '../../../src/types/settings';
import { levenshtein } from '../../../src/utils/levenshtein';

/** The mock implements the slice of the API the service uses, but is not the real class. */
function asApp(app: MockApp): ObsidianApp {
	return app as unknown as ObsidianApp;
}

function asFile(file: MockTFile): ObsidianTFile {
	return file as unknown as ObsidianTFile;
}

/** Defaults from the shipped settings, which is what the detector will pass in. */
const DEFAULT_OPTIONS: TagSimilarityOptions = {
	shortLengthCutoff: DEFAULT_SETTINGS.health.tagShortLengthCutoff,
	shortMaxDistance: DEFAULT_SETTINGS.health.tagShortMaxDistance,
	longMaxDistance: DEFAULT_SETTINGS.health.tagLongMaxDistance,
	minSharedPrefix: DEFAULT_SETTINGS.health.tagMinSharedPrefix,
};

function counts(entries: readonly (readonly [string, number])[]): Map<string, number> {
	return new Map(entries.map(([tag, count]) => [tag, count]));
}

function tagsOf(group: TagGroup): string[] {
	return group.variants.map((variant) => variant.tag);
}

function makeService(app: MockApp, sensitivity?: () => number): TagService {
	const logger = new Logger('silent');
	const index = new VaultIndex(asApp(app), logger);
	index.build();
	return sensitivity
		? new TagService(asApp(app), index, logger, sensitivity)
		: new TagService(asApp(app), index, logger);
}

/* ------------------------------------------------------------ groupSimilarTags -- */

describe('groupSimilarTags', () => {
	it('returns nothing for an empty vault', () => {
		expect(groupSimilarTags(new Map(), DEFAULT_OPTIONS)).toEqual([]);
	});

	it('returns nothing for a single tag', () => {
		expect(groupSimilarTags(counts([['project', 4]]), DEFAULT_OPTIONS)).toEqual([]);
	});

	it('returns nothing when no tags are close enough', () => {
		expect(
			groupSimilarTags(
				counts([
					['project', 4],
					['meeting', 2],
					['book', 1],
				]),
				DEFAULT_OPTIONS,
			),
		).toEqual([]);
	});

	it('collapses a chain of variants into one group', () => {
		const groups = groupSimilarTags(
			counts([
				['project', 12],
				['projects', 3],
				['projek', 1],
			]),
			DEFAULT_OPTIONS,
		);
		expect(groups).toHaveLength(1);
		expect(groups[0]?.canonical).toBe('project');
		expect(tagsOf(groups[0] as TagGroup)).toEqual(['project', 'projects', 'projek']);
	});

	it('links variants transitively even when the ends are too far apart to pair directly', () => {
		// aaaaaa↔aaaaab and aaaaab↔aaaabb are each one edit; the ends are two apart.
		const groups = groupSimilarTags(
			counts([
				['aaaaaa', 3],
				['aaaaab', 2],
				['aaaabb', 1],
			]),
			{ shortLengthCutoff: 6, shortMaxDistance: 1, longMaxDistance: 1, minSharedPrefix: 3 },
		);
		expect(groups).toHaveLength(1);
		expect(tagsOf(groups[0] as TagGroup)).toEqual(['aaaaaa', 'aaaaab', 'aaaabb']);
	});

	it('does not pair short unrelated tags two edits apart', () => {
		// The whole reason the bound scales with length: task and test are different things.
		expect(
			groupSimilarTags(
				counts([
					['task', 5],
					['test', 9],
				]),
				DEFAULT_OPTIONS,
			),
		).toEqual([]);
	});

	it('still pairs short tags one edit apart', () => {
		const groups = groupSimilarTags(
			counts([
				['task', 5],
				['tasks', 1],
			]),
			DEFAULT_OPTIONS,
		);
		expect(groups).toHaveLength(1);
		expect(groups[0]?.canonical).toBe('task');
	});

	it('pairs long tags up to the long distance', () => {
		const groups = groupSimilarTags(
			counts([
				['development', 6],
				['developement', 1],
			]),
			DEFAULT_OPTIONS,
		);
		expect(groups).toHaveLength(1);
		expect(groups[0]?.canonical).toBe('development');
	});

	it('pins the long bound exactly: two edits pair, three do not', () => {
		// `developement` above is only one edit away, so it would pair under either bound.
		// These two pin the boundary itself at longMaxDistance (2).
		expect(levenshtein('aaaaaaaaaa', 'aaaaaaaabb')).toBe(2);
		expect(
			groupSimilarTags(
				counts([
					['aaaaaaaaaa', 2],
					['aaaaaaaabb', 1],
				]),
				DEFAULT_OPTIONS,
			),
		).toHaveLength(1);

		expect(levenshtein('aaaaaaaaaa', 'aaaaaaabbb')).toBe(3);
		expect(
			groupSimilarTags(
				counts([
					['aaaaaaaaaa', 2],
					['aaaaaaabbb', 1],
				]),
				DEFAULT_OPTIONS,
			),
		).toEqual([]);
	});

	it('skips pairs whose length difference already exceeds the bound', () => {
		expect(
			groupSimilarTags(
				counts([
					['project', 4],
					['pro', 2],
				]),
				DEFAULT_OPTIONS,
			),
		).toEqual([]);
	});

	it('picks the most used tag as canonical', () => {
		const groups = groupSimilarTags(
			counts([
				['projek', 9],
				['project', 2],
			]),
			DEFAULT_OPTIONS,
		);
		expect(groups[0]?.canonical).toBe('projek');
	});

	it('breaks a count tie toward the shorter tag', () => {
		const groups = groupSimilarTags(
			counts([
				['testting', 1],
				['testing', 1],
			]),
			DEFAULT_OPTIONS,
		);
		expect(groups[0]?.canonical).toBe('testing');
	});

	it('breaks a count and length tie alphabetically', () => {
		// Equal length, equal usage, and a shared prefix, so only the alphabet can decide.
		const groups = groupSimilarTags(
			counts([
				['testinh', 1],
				['testing', 1],
			]),
			DEFAULT_OPTIONS,
		);
		expect(groups[0]?.canonical).toBe('testing');
	});

	it('refuses to pair tags that differ at the very start', () => {
		// `zesting` is one edit from `testing`, but a tag misspelled in its first character
		// is indistinguishable from an unrelated tag, and merging on that basis would
		// rewrite notes wrongly. This is the documented cost of the shared-prefix rule.
		expect(
			groupSimilarTags(
				counts([
					['zesting', 1],
					['testing', 1],
				]),
				DEFAULT_OPTIONS,
			),
		).toEqual([]);
	});

	it('sorts variants by count then alphabetically, and groups by canonical', () => {
		const groups = groupSimilarTags(
			counts([
				['testting', 1],
				['testing', 4],
				['testng', 1],
				['project', 12],
				['projekt', 2],
			]),
			DEFAULT_OPTIONS,
		);
		expect(groups.map((group) => group.canonical)).toEqual(['project', 'testing']);
		expect(tagsOf(groups[1] as TagGroup)).toEqual(['testing', 'testng', 'testting']);
		expect(groups[1]?.variants.map((variant) => variant.count)).toEqual([4, 1, 1]);
	});

	it('is order independent', () => {
		const forwards = groupSimilarTags(
			counts([
				['project', 3],
				['projekt', 1],
				['testing', 2],
				['testting', 1],
			]),
			DEFAULT_OPTIONS,
		);
		const backwards = groupSimilarTags(
			counts([
				['testting', 1],
				['testing', 2],
				['projekt', 1],
				['project', 3],
			]),
			DEFAULT_OPTIONS,
		);
		expect(backwards).toEqual(forwards);
	});

	it('ignores empty tag names', () => {
		expect(
			groupSimilarTags(
				counts([
					['', 3],
					['project', 1],
				]),
				DEFAULT_OPTIONS,
			),
		).toEqual([]);
	});

	it('treats a missing count as zero', () => {
		// A map whose `keys()` reports a tag its `get()` does not know about — the exact shape
		// the `?? 0` fallback exists for. A plain Map cannot express this, so it is duck typed.
		const sparse = {
			keys: () => ['testing', 'testting'][Symbol.iterator](),
			get: (key: string) => (key === 'testing' ? 2 : undefined),
		} as unknown as ReadonlyMap<string, number>;

		const groups = groupSimilarTags(sparse, DEFAULT_OPTIONS);
		expect(groups).toHaveLength(1);
		expect(groups[0]?.canonical).toBe('testing');
		// The unknown count becomes 0 rather than undefined or NaN, so ordering stays total.
		expect(groups[0]?.variants).toEqual([
			{ tag: 'testing', count: 2 },
			{ tag: 'testting', count: 0 },
		]);
	});

	it('groups unicode tags', () => {
		const groups = groupSimilarTags(
			counts([
				['プロジェクト', 4],
				['プロジェクタ', 1],
			]),
			DEFAULT_OPTIONS,
		);
		expect(groups).toHaveLength(1);
		expect(groups[0]?.canonical).toBe('プロジェクト');
	});

	it('groups tags containing punctuation', () => {
		const groups = groupSimilarTags(
			counts([
				['note-taking', 5],
				['note_taking', 1],
			]),
			DEFAULT_OPTIONS,
		);
		expect(tagsOf(groups[0] as TagGroup)).toEqual(['note-taking', 'note_taking']);
	});

	it('keeps nested tags separate from their parent', () => {
		expect(
			groupSimilarTags(
				counts([
					['project', 5],
					['project/alpha', 2],
				]),
				DEFAULT_OPTIONS,
			),
		).toEqual([]);
	});

	it('produces no groups when both distances are zero', () => {
		const groups = groupSimilarTags(
			counts([
				['project', 2],
				['projekt', 1],
			]),
			{
				shortLengthCutoff: 6,
				shortMaxDistance: 0,
				longMaxDistance: 0,
				minSharedPrefix: 3,
			},
		);
		expect(groups).toEqual([]);
	});

	it('honours a cutoff that makes every tag short', () => {
		// A two-edit pair is the only thing that can tell the two bounds apart: it groups under
		// longMaxDistance (2) and must not group once the cutoff forces the short bound (1).
		const pair = counts([
			['aaaaaaaaaa', 2],
			['aaaaaaaabb', 1],
		]);
		expect(levenshtein('aaaaaaaaaa', 'aaaaaaaabb')).toBe(2);

		const allShort = groupSimilarTags(pair, {
			shortLengthCutoff: 100,
			shortMaxDistance: 1,
			longMaxDistance: 2,
			minSharedPrefix: 3,
		});
		expect(allShort).toEqual([]);

		const allLong = groupSimilarTags(pair, {
			shortLengthCutoff: 0,
			shortMaxDistance: 1,
			longMaxDistance: 2,
			minSharedPrefix: 3,
		});
		expect(allLong).toHaveLength(1);
	});

	it('stays fast on a large tag set', () => {
		const entries: [string, number][] = [];
		for (let i = 0; i < 2000; i++) entries.push([`tag-number-${i}`, 1]);
		const started = Date.now();
		const groups = groupSimilarTags(counts(entries), DEFAULT_OPTIONS);
		expect(Date.now() - started).toBeLessThan(3000);

		// Every neighbour is one edit from the next (`tag-number-1` → `tag-number-10` → …), so
		// union-find must collapse the whole set into a single component rather than leaving
		// overlapping pairs behind. Asserting the exact shape is what makes this a real test.
		expect(groups).toHaveLength(1);
		expect(groups[0]?.variants).toHaveLength(2000);
		expect(groups[0]?.canonical).toBe('tag-number-0');
	});
});

/* --------------------------------------------------------------- frontmatter -- */

describe('frontmatterHasTag', () => {
	it('finds a tag in an array', () => {
		expect(frontmatterHasTag({ tags: ['inbox', 'Project'] }, 'project')).toBe(true);
	});

	it('finds a tag in a comma separated string', () => {
		expect(frontmatterHasTag({ tags: 'inbox, project' }, '#project')).toBe(true);
	});

	it('finds a tag under the singular key', () => {
		expect(frontmatterHasTag({ tag: 'project' }, 'project')).toBe(true);
	});

	it('returns false for null frontmatter, an empty tag, or a miss', () => {
		expect(frontmatterHasTag(null, 'project')).toBe(false);
		expect(frontmatterHasTag({ tags: ['project'] }, '  ')).toBe(false);
		expect(frontmatterHasTag({ tags: ['project/alpha'] }, 'project')).toBe(false);
		expect(frontmatterHasTag({ tags: 42 }, 'project')).toBe(false);
		expect(frontmatterHasTag({ tags: [42, null] }, 'project')).toBe(false);
	});
});

describe('renameTagInFrontmatter', () => {
	it('renames inside an array', () => {
		const frontmatter: Record<string, unknown> = { tags: ['inbox', 'projek'] };
		expect(renameTagInFrontmatter(frontmatter, 'projek', 'project')).toBe(true);
		expect(frontmatter.tags).toEqual(['inbox', 'project']);
	});

	it('collapses a rename that collides with an existing tag', () => {
		const frontmatter: Record<string, unknown> = { tags: ['project', 'projek'] };
		expect(renameTagInFrontmatter(frontmatter, 'projek', 'project')).toBe(true);
		expect(frontmatter.tags).toEqual(['project']);
	});

	it('preserves non-string entries', () => {
		const frontmatter: Record<string, unknown> = { tags: ['projek', 42] };
		expect(renameTagInFrontmatter(frontmatter, 'projek', 'project')).toBe(true);
		expect(frontmatter.tags).toEqual(['project', 42]);
	});

	it('renames inside a comma separated string and keeps the separator', () => {
		const frontmatter: Record<string, unknown> = { tags: 'inbox, projek' };
		expect(renameTagInFrontmatter(frontmatter, 'projek', 'project')).toBe(true);
		expect(frontmatter.tags).toBe('inbox, project');
	});

	it('renames inside a space separated string', () => {
		const frontmatter: Record<string, unknown> = { tags: 'inbox projek' };
		expect(renameTagInFrontmatter(frontmatter, 'projek', 'project')).toBe(true);
		expect(frontmatter.tags).toBe('inbox project');
	});

	it('leaves everything else alone', () => {
		const frontmatter: Record<string, unknown> = { tags: ['inbox'], title: 'projek' };
		expect(renameTagInFrontmatter(frontmatter, 'projek', 'project')).toBe(false);
		expect(frontmatter).toEqual({ tags: ['inbox'], title: 'projek' });
	});

	it('rejects empty or identical arguments', () => {
		const frontmatter: Record<string, unknown> = { tags: ['project'] };
		expect(renameTagInFrontmatter(frontmatter, '', 'project')).toBe(false);
		expect(renameTagInFrontmatter(frontmatter, 'project', '#')).toBe(false);
		expect(renameTagInFrontmatter(frontmatter, 'project', 'Project')).toBe(false);
	});

	it('does not touch a nested child when the parent is renamed', () => {
		const frontmatter: Record<string, unknown> = { tags: ['project/alpha'] };
		expect(renameTagInFrontmatter(frontmatter, 'project', 'work')).toBe(false);
		expect(frontmatter.tags).toEqual(['project/alpha']);
	});
});

/* ----------------------------------------------------------- rewriteInlineTags -- */

describe('rewriteInlineTags', () => {
	it('rewrites a whole-word tag', () => {
		expect(rewriteInlineTags('a #projek b', 'projek', 'project')).toBe('a #project b');
	});

	it('rewrites every occurrence', () => {
		expect(rewriteInlineTags('#a x #a\n#a', 'a', 'b')).toBe('#b x #b\n#b');
	});

	it('is case-insensitive and writes the normalised form', () => {
		expect(rewriteInlineTags('#Projek and #PROJEK', 'projek', 'project')).toBe(
			'#project and #project',
		);
	});

	it('accepts arguments with a leading hash', () => {
		expect(rewriteInlineTags('#projek', '#projek', '#project')).toBe('#project');
	});

	it('leaves a longer tag with the same prefix alone', () => {
		expect(rewriteInlineTags('#project #projects', 'project', 'work')).toBe('#work #projects');
	});

	it('leaves nested children alone when the parent is renamed', () => {
		expect(rewriteInlineTags('#project and #project/subtag', 'project', 'work')).toBe(
			'#work and #project/subtag',
		);
	});

	it('renames a nested tag when it is named in full', () => {
		expect(
			rewriteInlineTags('#project/subtag and #project', 'project/subtag', 'work/subtag'),
		).toBe('#work/subtag and #project');
	});

	it('ignores a hash that is part of a word', () => {
		expect(rewriteInlineTags('issue#project', 'project', 'work')).toBe('issue#project');
	});

	it('leaves a markdown attribute block alone', () => {
		// `{#anchor}` is a heading attribute, not a tag: the metadata parser's prefix class
		// (`[\s(["'>]`) excludes `{`, so nothing here was ever indexed as a tag.
		expect(rewriteInlineTags('## Heading {#tag}\n\n#tag', 'tag', 'label')).toBe(
			'## Heading {#tag}\n\n#label',
		);
	});

	it('rewrites a tag after each prefix character the parser accepts', () => {
		expect(rewriteInlineTags('(#tag) [#tag] "#tag" \'#tag\' >#tag', 'tag', 'label')).toBe(
			'(#label) [#label] "#label" \'#label\' >#label',
		);
	});

	it('rewrites a body that uses CRLF line endings', () => {
		const content = '---\r\ntags:\r\n  - projek\r\n---\r\n\r\nbody #projek\r\nmore #projek\r\n';
		expect(rewriteInlineTags(content, 'projek', 'project')).toBe(
			'---\r\ntags:\r\n  - projek\r\n---\r\n\r\nbody #project\r\nmore #project\r\n',
		);
	});

	it('does not touch a longer sibling when renaming a nested tag', () => {
		expect(
			rewriteInlineTags(
				'#project/alpha and #project/alphabet',
				'project/alpha',
				'work/alpha',
			),
		).toBe('#work/alpha and #project/alphabet');
	});

	it('never touches a fenced code block', () => {
		const content = 'before #tag\n\n```bash\ngrep #tag file\n```\n\nafter #tag';
		expect(rewriteInlineTags(content, 'tag', 'label')).toBe(
			'before #label\n\n```bash\ngrep #tag file\n```\n\nafter #label',
		);
	});

	it('never touches a tilde fenced block', () => {
		const content = '~~~\n#tag\n~~~\n#tag';
		expect(rewriteInlineTags(content, 'tag', 'label')).toBe('~~~\n#tag\n~~~\n#label');
	});

	it('protects everything after an unterminated fence', () => {
		const content = '#tag\n```\n#tag never closed';
		expect(rewriteInlineTags(content, 'tag', 'label')).toBe('#label\n```\n#tag never closed');
	});

	it('never touches inline code', () => {
		expect(rewriteInlineTags('use `#tag` here #tag', 'tag', 'label')).toBe(
			'use `#tag` here #label',
		);
		// The case above is also blocked by the prefix rule (a backtick cannot precede a tag).
		// With a space in front, the inline-code span is the only thing standing in the way.
		expect(rewriteInlineTags('a `run #tag now` and #tag', 'tag', 'label')).toBe(
			'a `run #tag now` and #label',
		);
	});

	it('never touches a url fragment', () => {
		const content = 'see https://example.com/page#tag and #tag';
		expect(rewriteInlineTags(content, 'tag', 'label')).toBe(
			'see https://example.com/page#tag and #label',
		);
		// `(` is a legal tag prefix, so only the URL span keeps this fragment intact.
		expect(rewriteInlineTags('https://ex.com/a(#tag) #tag', 'tag', 'label')).toBe(
			'https://ex.com/a(#tag) #label',
		);
	});

	it('never touches a markdown link destination', () => {
		expect(rewriteInlineTags('[x](page.md#tag) #tag', 'tag', 'label')).toBe(
			'[x](page.md#tag) #label',
		);
		// A quoted link title puts a legal prefix character right before the `#`.
		expect(rewriteInlineTags('[x](page.md "#tag") #tag', 'tag', 'label')).toBe(
			'[x](page.md "#tag") #label',
		);
	});

	it('never touches a wikilink heading anchor', () => {
		expect(rewriteInlineTags('[[Note#tag]] #tag', 'tag', 'label')).toBe('[[Note#tag]] #label');
		// A space inside the alias would otherwise make this look exactly like a real tag.
		expect(rewriteInlineTags('[[Note|see #tag]] #tag', 'tag', 'label')).toBe(
			'[[Note|see #tag]] #label',
		);
	});

	it('skips the frontmatter block', () => {
		const content = '---\ntags:\n  - projek\n---\n\nbody #projek';
		expect(rewriteInlineTags(content, 'projek', 'project')).toBe(
			'---\ntags:\n  - projek\n---\n\nbody #project',
		);
	});

	it('never rewrites a hash tag written inside the frontmatter block', () => {
		// The frontmatter above carries no `#`, so it cannot show that the block is skipped.
		// Here a `#projek` sits in a YAML *value*: the block belongs to processFrontMatter, and
		// rewriting it by hand would corrupt a title the rename was never asked to touch.
		const content = '---\ntitle: "About #projek"\ntags:\n  - projek\n---\n\nbody #projek\n';
		expect(rewriteInlineTags(content, 'projek', 'project')).toBe(
			'---\ntitle: "About #projek"\ntags:\n  - projek\n---\n\nbody #project\n',
		);
	});

	it('scans the whole document when the frontmatter fence never closes', () => {
		const content = '---\nbroken\n\n#projek';
		expect(rewriteInlineTags(content, 'projek', 'project')).toBe('---\nbroken\n\n#project');
	});

	it('rewrites a tag at the very start and very end of a document', () => {
		expect(rewriteInlineTags('#tag middle #tag', 'tag', 'label')).toBe('#label middle #label');
	});

	it('rewrites unicode tags', () => {
		expect(rewriteInlineTags('メモ #プロジェクタ です', 'プロジェクタ', 'プロジェクト')).toBe(
			'メモ #プロジェクト です',
		);
	});

	it('does not treat a unicode suffix as a boundary', () => {
		expect(rewriteInlineTags('#プロジェクタ側', 'プロジェクタ', 'プロジェクト')).toBe(
			'#プロジェクタ側',
		);
	});

	it('escapes regex metacharacters in the tag name', () => {
		expect(rewriteInlineTags('#a.b #axb', 'a.b', 'c')).toBe('#c #axb');
	});

	it('returns the original string when nothing matches', () => {
		const content = 'nothing to see';
		expect(rewriteInlineTags(content, 'tag', 'label')).toBe(content);
	});

	it('returns the original string for empty, identical or blank arguments', () => {
		expect(rewriteInlineTags('#tag', 'tag', 'tag')).toBe('#tag');
		expect(rewriteInlineTags('#tag', '', 'label')).toBe('#tag');
		expect(rewriteInlineTags('#tag', 'tag', '#')).toBe('#tag');
		expect(rewriteInlineTags('', 'tag', 'label')).toBe('');
	});

	it('handles a very long note quickly', () => {
		const paragraph = `${'lorem ipsum dolor sit amet '.repeat(40)}#projek\n`;
		const content = paragraph.repeat(120);
		expect(content.length).toBeGreaterThan(100_000);

		const started = Date.now();
		const rewritten = rewriteInlineTags(content, 'projek', 'project');
		expect(Date.now() - started).toBeLessThan(3000);
		expect(rewritten.split('#project').length - 1).toBe(120);
		// The source never contains `#projek ` with a trailing space, so asserting on that
		// spelling would pass even if nothing had been rewritten.
		expect(rewritten).not.toContain('#projek');
	});
});

/* -------------------------------------------------------------------- reads -- */

describe('TagService reads', () => {
	let app: MockApp;
	let service: TagService;

	beforeEach(() => {
		app = buildVault([
			{ path: 'notes/a.md', frontmatter: { tags: ['project', 'inbox'] }, content: 'a' },
			{ path: 'notes/b.md', frontmatter: { tags: ['project'] }, content: 'b #projek' },
			{ path: 'notes/c.md', frontmatter: { tags: ['projek', 'testing'] }, content: 'c' },
			{ path: 'notes/d.md', frontmatter: { tags: ['testting'] }, content: 'd' },
			{ path: 'notes/e.md', frontmatter: { tags: ['project'] }, content: 'e' },
			{ path: 'assets/img.png', content: 'binary:10' },
		]);
		service = makeService(app);
	});

	it('counts every tag in the vault', () => {
		const tags = service.allTags();
		expect(tags.get('project')).toBe(3);
		expect(tags.get('projek')).toBe(2);
		expect(tags.get('inbox')).toBe(1);
		expect(tags.get('testing')).toBe(1);
	});

	it('groups variants using the health settings', () => {
		const groups = service.similarGroups(DEFAULT_SETTINGS.health);
		expect(groups.map((group) => group.canonical)).toEqual(['project', 'testing']);
	});

	it('respects custom distance settings', () => {
		const settings: HealthSettings = {
			...DEFAULT_SETTINGS.health,
			tagShortLengthCutoff: 0,
			tagShortMaxDistance: 0,
			tagLongMaxDistance: 0,
		};
		expect(service.similarGroups(settings)).toEqual([]);
	});

	it('lists the files carrying a tag, sorted', () => {
		expect(service.filesWithTag('project')).toEqual(['notes/a.md', 'notes/b.md', 'notes/e.md']);
		expect(service.filesWithTag('#PROJEK')).toEqual(['notes/b.md', 'notes/c.md']);
		expect(service.filesWithTag('missing')).toEqual([]);
		expect(service.filesWithTag('  ')).toEqual([]);
	});

	it('lists a parent tag without pulling in its descendants', () => {
		// The merge preview shows this list and then edits exactly these files, so a descendant
		// leaking in here would mean previewing a file the rename never touches.
		const nested = makeService(
			buildVault([
				{ path: 'parent.md', frontmatter: { tags: ['project'] }, content: 'p' },
				{ path: 'child.md', frontmatter: { tags: ['project/alpha'] }, content: 'c' },
			]),
		);
		expect(nested.filesWithTag('project')).toEqual(['parent.md']);
		expect(nested.filesWithTag('project/alpha')).toEqual(['child.md']);
	});

	it('suggests the most used tags for an empty query', () => {
		expect(service.suggest('')).toEqual(['project', 'projek', 'inbox', 'testing', 'testting']);
		expect(service.suggest('   ', 2)).toEqual(['project', 'projek']);
	});

	it('ranks fuzzy matches and honours the limit', () => {
		// `projek` is the shorter target and scores higher on fuzziness alone; usage is what
		// puts the tag the vault actually uses first.
		expect(service.suggest('proj')[0]).toBe('project');
		expect(service.suggest('proj')).toContain('projek');
		expect(service.suggest('proj', 2)).toHaveLength(2);
		expect(service.suggest('#PROJ')[0]).toBe('project');
	});

	it('still finds a tag through a typo', () => {
		expect(service.suggest('projct')).toContain('project');
		expect(service.suggest('testin')).toContain('testing');
	});

	it('returns nothing for a query that matches no tag', () => {
		expect(service.suggest('qqqqqqqq')).toEqual([]);
	});

	it('returns nothing when the limit is zero or negative', () => {
		expect(service.suggest('proj', 0)).toEqual([]);
		expect(service.suggest('proj', -5)).toEqual([]);
	});

	it('reads the fuzzy sensitivity through the injected getter', () => {
		const strict = makeService(app, () => 0);
		const loose = makeService(app, () => 1);
		// Two substitutions away from `testing`: too loose for a strict edit-distance pass.
		expect(strict.suggest('tastong')).toEqual([]);
		expect(loose.suggest('tastong')).toContain('testing');
	});
});

describe('TagService on an empty vault', () => {
	it('reports nothing without throwing', () => {
		const service = makeService(buildVault([]));
		expect(service.allTags().size).toBe(0);
		expect(service.similarGroups(DEFAULT_SETTINGS.health)).toEqual([]);
		expect(service.suggest('')).toEqual([]);
		expect(service.suggest('project')).toEqual([]);
		expect(service.filesWithTag('project')).toEqual([]);
	});
});

describe('TagService on a single-note vault', () => {
	it('has no variants to group', () => {
		const service = makeService(
			buildVault([{ path: 'only.md', frontmatter: { tags: ['project'] }, content: 'x' }]),
		);
		expect(service.allTags().size).toBe(1);
		expect(service.similarGroups(DEFAULT_SETTINGS.health)).toEqual([]);
		expect(service.suggest('pro')).toEqual(['project']);
	});
});

/* ------------------------------------------------------------------ renames -- */

describe('TagService.renameTagInFile', () => {
	it('rewrites frontmatter and body in one pass', async () => {
		const app = buildVault([
			{
				path: 'note.md',
				frontmatter: { type: 'note', tags: ['projek', 'inbox'] },
				content: 'Body mentions #projek twice: #projek.\n',
			},
		]);
		const service = makeService(app);
		const file = requireFile(app, 'note.md');

		expect(await service.renameTagInFile(asFile(file), 'projek', 'project')).toBe(true);

		const content = app.vault.peek('note.md') ?? '';
		expect(content).toContain('- project');
		expect(content).toContain('- inbox');
		expect(content).toContain('type: note');
		expect(content).toContain('Body mentions #project twice: #project.');
		expect(content).not.toContain('projek');
	});

	it('rewrites the body when only the body carries the tag', async () => {
		const app = buildVault([
			{ path: 'note.md', frontmatter: { type: 'note' }, content: 'inline #projek here' },
		]);
		const service = makeService(app);

		expect(
			await service.renameTagInFile(asFile(requireFile(app, 'note.md')), 'projek', 'project'),
		).toBe(true);
		expect(app.vault.peek('note.md')).toContain('inline #project here');
	});

	it('rewrites frontmatter when only the frontmatter carries the tag', async () => {
		const app = buildVault([
			{ path: 'note.md', frontmatter: { tags: ['projek'] }, content: 'no inline tags' },
		]);
		const service = makeService(app);

		expect(
			await service.renameTagInFile(asFile(requireFile(app, 'note.md')), 'projek', 'project'),
		).toBe(true);
		const content = app.vault.peek('note.md') ?? '';
		expect(content).toContain('- project');
		expect(content).toContain('no inline tags');
	});

	it('merges a variant into an existing canonical tag without duplicating it', async () => {
		const app = buildVault([
			{ path: 'note.md', frontmatter: { tags: ['project', 'projek'] }, content: 'x' },
		]);
		const service = makeService(app);

		expect(
			await service.renameTagInFile(asFile(requireFile(app, 'note.md')), 'projek', 'project'),
		).toBe(true);
		const content = app.vault.peek('note.md') ?? '';
		expect(content.match(/- project/g)).toHaveLength(1);
	});

	it('reports no change when the tag is absent', async () => {
		const app = buildVault([
			{ path: 'note.md', frontmatter: { tags: ['inbox'] }, content: 'plain body' },
		]);
		const before = app.vault.peek('note.md');
		const service = makeService(app);

		expect(
			await service.renameTagInFile(asFile(requireFile(app, 'note.md')), 'projek', 'project'),
		).toBe(false);
		expect(app.vault.peek('note.md')).toBe(before);
	});

	it('refuses empty and no-op renames', async () => {
		const app = buildVault([
			{ path: 'note.md', frontmatter: { tags: ['project'] }, content: '#project' },
		]);
		const before = app.vault.peek('note.md');
		const service = makeService(app);
		const file = asFile(requireFile(app, 'note.md'));

		expect(await service.renameTagInFile(file, '', 'project')).toBe(false);
		expect(await service.renameTagInFile(file, 'project', '  #  ')).toBe(false);
		expect(await service.renameTagInFile(file, 'project', 'PROJECT')).toBe(false);
		expect(app.vault.peek('note.md')).toBe(before);
	});

	it('ignores non-markdown files', async () => {
		const app = buildVault([{ path: 'assets/img.png', content: 'binary:10' }]);
		const service = makeService(app);
		const file = requireFile(app, 'assets/img.png');
		expect(await service.renameTagInFile(asFile(file), 'projek', 'project')).toBe(false);
	});

	it('leaves a corrupt frontmatter block untouched', async () => {
		const content = '---\ntags [projek, broken\n---\n\nbody #projek\n';
		const app = buildVault([{ path: 'broken.md', content }]);
		const service = makeService(app);

		expect(
			await service.renameTagInFile(
				asFile(requireFile(app, 'broken.md')),
				'projek',
				'project',
			),
		).toBe(true);
		const next = app.vault.peek('broken.md') ?? '';
		// The unparseable YAML survives verbatim; only the body was rewritten.
		expect(next).toContain('tags [projek, broken');
		expect(next).toContain('body #project');
	});

	it('leaves a note without frontmatter alone except for its body', async () => {
		const app = buildVault([{ path: 'plain.md', content: '# Title\n\n#projek\n' }]);
		const service = makeService(app);

		expect(
			await service.renameTagInFile(
				asFile(requireFile(app, 'plain.md')),
				'projek',
				'project',
			),
		).toBe(true);
		expect(app.vault.peek('plain.md')).toBe('# Title\n\n#project\n');
	});

	it('does not rename a nested child tag along with its parent', async () => {
		const app = buildVault([
			{
				path: 'note.md',
				frontmatter: { tags: ['project', 'project/alpha'] },
				content: '#project and #project/alpha\n',
			},
		]);
		const service = makeService(app);

		expect(
			await service.renameTagInFile(asFile(requireFile(app, 'note.md')), 'project', 'work'),
		).toBe(true);
		const content = app.vault.peek('note.md') ?? '';
		expect(content).toContain('- work');
		expect(content).toContain('- project/alpha');
		expect(content).toContain('#work and #project/alpha');
	});

	it('handles unicode and special characters in file names', async () => {
		const app = buildVault([
			{ path: 'ノート 日本語.md', frontmatter: { tags: ['projek'] }, content: '#projek' },
			{
				path: 'special chars - @$%.md',
				frontmatter: { tags: ['projek'] },
				content: '#projek',
			},
		]);
		const service = makeService(app);

		expect(
			await service.renameTagInFile(
				asFile(requireFile(app, 'ノート 日本語.md')),
				'projek',
				'project',
			),
		).toBe(true);
		expect(
			await service.renameTagInFile(
				asFile(requireFile(app, 'special chars - @$%.md')),
				'projek',
				'project',
			),
		).toBe(true);
		expect(app.vault.peek('ノート 日本語.md')).toContain('#project');
		expect(app.vault.peek('special chars - @$%.md')).toContain('#project');
	});

	it('rewrites a very long note', async () => {
		const body = `${'filler text '.repeat(20)}#projek\n`.repeat(450);
		const app = buildVault([
			{ path: 'long.md', frontmatter: { tags: ['projek'] }, content: body },
		]);
		expect(body.length).toBeGreaterThan(100_000);
		const service = makeService(app);

		expect(
			await service.renameTagInFile(asFile(requireFile(app, 'long.md')), 'projek', 'project'),
		).toBe(true);
		const content = app.vault.peek('long.md') ?? '';
		expect(content.split('#project').length - 1).toBe(450);
	});

	it('uses the current file content, not the state the index was built from', async () => {
		const app = buildVault([
			{ path: 'note.md', frontmatter: { tags: ['projek'] }, content: '#projek' },
		]);
		const service = makeService(app);
		const file = requireFile(app, 'note.md');

		// Another process rewrites the file after the index was built.
		await app.vault.modify(file, 'nothing tagged here');

		expect(await service.renameTagInFile(asFile(file), 'projek', 'project')).toBe(false);
		expect(app.vault.peek('note.md')).toBe('nothing tagged here');
	});

	it('renames across several files concurrently', async () => {
		const app = buildVault([
			{ path: 'a.md', frontmatter: { tags: ['projek'] }, content: '#projek' },
			{ path: 'b.md', frontmatter: { tags: ['projek'] }, content: '#projek' },
			{ path: 'c.md', content: 'body #projek' },
		]);
		const service = makeService(app);

		const results = await Promise.all(
			['a.md', 'b.md', 'c.md'].map((path) =>
				service.renameTagInFile(asFile(requireFile(app, path)), 'projek', 'project'),
			),
		);
		expect(results).toEqual([true, true, true]);
		for (const path of ['a.md', 'b.md', 'c.md']) {
			expect(app.vault.peek(path)).toContain('#project');
			// `#projek` is never followed by a space in these fixtures, so the trailing-space
			// spelling would pass vacuously.
			expect(app.vault.peek(path)).not.toContain('#projek');
		}
	});

	it('applies successive renames', async () => {
		const app = buildVault([
			{ path: 'note.md', frontmatter: { tags: ['projek'] }, content: '#projek' },
		]);
		const service = makeService(app);
		const file = asFile(requireFile(app, 'note.md'));

		expect(await service.renameTagInFile(file, 'projek', 'project')).toBe(true);
		expect(await service.renameTagInFile(file, 'project', 'work')).toBe(true);
		const content = app.vault.peek('note.md') ?? '';
		expect(content).toContain('- work');
		expect(content).toContain('#work');
	});

	it('throws a typed error when the file cannot be read', async () => {
		const app = buildVault([{ path: 'note.md', content: 'body #projek' }]);
		const service = makeService(app);
		const file = requireFile(app, 'note.md');
		await app.vault.delete(file);

		await expect(
			service.renameTagInFile(asFile(file), 'projek', 'project'),
		).rejects.toBeInstanceOf(TagRenameError);
	});

	it('throws a typed error when the body cannot be written', async () => {
		const app = buildVault([{ path: 'note.md', content: 'body #projek' }]);
		const service = makeService(app);
		const file = requireFile(app, 'note.md');
		app.vault.readOnly = true;

		await expect(service.renameTagInFile(asFile(file), 'projek', 'project')).rejects.toThrow(
			/note\.md/,
		);
	});

	it('throws a typed error when the frontmatter cannot be written', async () => {
		const app = buildVault([
			{ path: 'note.md', frontmatter: { tags: ['projek'] }, content: 'plain' },
		]);
		const service = makeService(app);
		const file = requireFile(app, 'note.md');
		app.vault.readOnly = true;

		const failure = await service
			.renameTagInFile(asFile(file), 'projek', 'project')
			.catch((error: unknown) => error);
		expect(failure).toBeInstanceOf(TagRenameError);
		expect((failure as TagRenameError).path).toBe('note.md');
	});
});

/* -------------------------------------------------------- on-disk fixture -- */

describe('TagService against the on-disk fixture', () => {
	it('finds exactly the three documented tag inconsistency groups', () => {
		const app = loadVaultFromDisk();
		const service = makeService(app);
		const groups = service.similarGroups(DEFAULT_SETTINGS.health);

		// Exactly the three misspelling groups the vault was built to contain, each pairing a
		// typo with its canonical spelling and nothing else.
		expect(groups.map((group) => group.canonical)).toEqual([
			'development',
			'project',
			'testing',
		]);
		expect(tagsOf(groups[0] as TagGroup)).toEqual(['developement', 'development']);
		expect(tagsOf(groups[1] as TagGroup)).toEqual(['project', 'projek']);
		expect(tagsOf(groups[2] as TagGroup)).toEqual(['testing', 'testting']);
	});

	it('keeps unrelated same-length tags apart despite a small edit distance', () => {
		// `meeting` and `testing` are two edits apart, as are `finance` and `fitness`. Only
		// the shared-prefix requirement separates a real typo from a coincidence; without it
		// the plugin would offer to rename every #meeting note to #testing.
		const app = loadVaultFromDisk();
		const service = makeService(app);
		const tags = service.allTags();
		expect(tags.get('meeting')).toBeGreaterThan(0);
		expect(tags.get('testing')).toBeGreaterThan(0);
		expect(tags.get('finance')).toBeGreaterThan(0);
		expect(tags.get('fitness')).toBeGreaterThan(0);

		const grouped = service
			.similarGroups(DEFAULT_SETTINGS.health)
			.flatMap((group) => group.variants.map((variant) => variant.tag));
		expect(grouped).not.toContain('meeting');
		expect(grouped).not.toContain('finance');
		expect(grouped).not.toContain('fitness');
	});

	it('does not confuse test with task', () => {
		const app = loadVaultFromDisk();
		const service = makeService(app);
		const tags = service.allTags();
		expect(tags.get('test')).toBeGreaterThan(0);
		expect(tags.get('task')).toBeGreaterThan(0);

		const grouped = service
			.similarGroups(DEFAULT_SETTINGS.health)
			.flatMap((group) => tagsOf(group));
		expect(grouped).not.toContain('task');
		expect(grouped).not.toContain('test');
	});

	it('lists the notes carrying the misspelled tag and merges them', async () => {
		const app = loadVaultFromDisk();
		const service = makeService(app);
		const paths = service.filesWithTag('projek');
		expect(paths).toEqual(['Problem Notes/tag inconsistency note.md']);

		const file = requireFile(app, paths[0] as string);
		expect(await service.renameTagInFile(asFile(file), 'projek', 'project')).toBe(true);

		const content = app.vault.peek(file.path) ?? '';
		expect(content).toContain('- project');
		expect(content).not.toContain('- projek\n');
		// Prose that merely names the tag without a `#` is left alone.
		expect(content).toContain('projek should be project');
	});

	it('suggests real vault tags', () => {
		const app = loadVaultFromDisk();
		const service = makeService(app);
		expect(service.suggest('proj')[0]).toBe('project');
		expect(service.suggest('', 3)).toEqual(['project', 'inbox', 'daily']);
	});
});
