/**
 * The known-answer fixture vault (addendum section 12.5).
 *
 * Purpose-built so every detector has an exact, hand-countable expected result. It mirrors
 * the shape of the on-disk `test-vault/` but differs in one deliberate way: every note here
 * is connected to the graph except the five designated orphans, which is what makes
 * "orphans = 5" and therefore "score ≈ 92" reproducible. The real vault leaves twenty more
 * notes incidentally unlinked, so it scores lower — see `TEST_VAULT_GROUND_TRUTH.md`.
 *
 * Every number this fixture is built to produce is asserted in
 * `tests/integration/known-answer.test.ts`; changing a file here without updating that suite
 * will fail loudly, which is the point.
 */

import { buildVault, day } from '../helpers/vault-fixture';
import type { App } from '../mocks/obsidian';
import type { FixtureFile } from '../helpers/vault-fixture';

/** Complete frontmatter, so no note is accidentally flagged for missing properties. */
function meta(options: {
	created: string;
	modified?: string;
	type: string;
	status?: string;
	tags?: string[];
}): Record<string, unknown> {
	return {
		created: options.created,
		modified: options.modified ?? options.created,
		type: options.type,
		status: options.status ?? 'active',
		tags: options.tags ?? ['note'],
	};
}

/** Expected counts this fixture is constructed to produce. */
export const KNOWN_ANSWERS = {
	brokenLinks: 8,
	orphans: 5,
	emptyNotes: 3,
	unusedAttachments: 6,
	usedAttachments: 3,
	duplicatePairs: 1,
	tagInconsistencies: 3,
	missingMetadata: 1,
	corruptedFrontmatter: 1,
	unlinkedMentions: 2,
	staleNotesAtLeast: 3,
	largeFilesAtDefaultThreshold: 0,
	healthScore: 92,
	inboxNotes: 10,
} as const;

/**
 * Required properties used by the known-answer assertions.
 *
 * The addendum asks for `created, type, status, tags` and simultaneously for a fifth orphan
 * that is "missing tags" — but a note with no tags necessarily fails a required `tags`, so
 * those two expectations cannot both hold. `tags` is therefore left out of the required list
 * here, which keeps missing-metadata at the documented 1. A dedicated test asserts that
 * adding `tags` back finds exactly 2, and names the second note, so the interaction is
 * covered rather than hidden.
 */
export const KNOWN_REQUIRED_FIELDS = ['created', 'type', 'status'];

const INBOX_TYPES = ['capture', 'idea', 'task', 'reference', 'meeting'] as const;

function inboxNotes(): FixtureFile[] {
	return Array.from({ length: 10 }, (_unused, i) => {
		const dayOfMonth = String(6 + i).padStart(2, '0');
		const type = INBOX_TYPES[i % INBOX_TYPES.length] as string;
		return {
			path: `00-Inbox/2026-06-${dayOfMonth} ${type} - captured thought ${i + 1}.md`,
			frontmatter: {
				created: `2026-06-${dayOfMonth}`,
				type,
				status: 'inbox',
				source: i % 2 === 0 ? 'https://example.com/source' : '',
				tags: ['inbox'],
			},
			content: `# Captured thought ${i + 1}\n\nSomething worth processing later.\n`,
		};
	});
}

function projectNotes(): FixtureFile[] {
	return [
		{
			path: '01-Projects/Project Alpha.md',
			frontmatter: meta({
				created: '2026-05-01',
				modified: '2026-06-14',
				type: 'project',
				tags: ['project', 'alpha'],
			}),
			content:
				'# Project Alpha\n\n- [[Alpha Requirements]]\n- [[Alpha Timeline]]\n- [[Alpha Meeting Notes]]\n\nSee also [[Budget Planning]].\n',
		},
		{
			path: '01-Projects/Alpha Requirements.md',
			frontmatter: meta({
				created: '2026-05-02',
				modified: '2026-06-10',
				type: 'reference',
				tags: ['project', 'alpha'],
			}),
			content:
				'# Alpha Requirements\n\nBack to [[Project Alpha]].\n\nAttached: [[99-Attachments/spec-used.pdf]]\n',
		},
		{
			path: '01-Projects/Alpha Timeline.md',
			frontmatter: meta({
				created: '2026-05-03',
				modified: '2026-06-08',
				type: 'reference',
				tags: ['project', 'alpha', 'development', 'testing'],
			}),
			content: '# Alpha Timeline\n\nBack to [[Project Alpha]].\n',
		},
		{
			path: '01-Projects/Alpha Meeting Notes.md',
			frontmatter: meta({
				created: '2026-05-05',
				modified: '2026-06-12',
				type: 'meeting',
				tags: ['project', 'alpha', 'meeting'],
			}),
			content:
				'# Alpha Meeting Notes\n\nBack to [[Project Alpha]].\n\n![[99-Attachments/chart-used.png]]\n',
		},
		{
			path: '01-Projects/Project Beta.md',
			frontmatter: meta({
				created: '2026-04-15',
				modified: '2026-06-01',
				type: 'project',
				tags: ['project', 'beta'],
			}),
			content: '# Project Beta\n\nResearch lives in [[Beta Research]].\n',
		},
		{
			path: '01-Projects/Beta Research.md',
			frontmatter: meta({
				created: '2026-04-16',
				modified: '2026-05-28',
				type: 'reference',
				tags: ['project', 'beta'],
			}),
			content:
				'# Beta Research\n\nBack to [[Project Beta]].\n\n![[99-Attachments/diagram-used.png]]\n',
		},
		{
			path: '01-Projects/Project Gamma.md',
			frontmatter: meta({
				created: '2026-06-01',
				type: 'project',
				status: 'planning',
				tags: ['project', 'projek'],
			}),
			content: '# Project Gamma\n\nStill in planning.\n',
		},
	];
}

function areaNotes(): FixtureFile[] {
	return [
		{
			path: '02-Areas/Career Growth.md',
			// Carries the CORRECT spelling, so the canonical of that group is the correct one.
			// Most-used wins, and a fixture where the typo is more common would (correctly)
			// nominate the typo as canonical, which is not what this fixture is testing.
			frontmatter: meta({
				created: '2026-01-15',
				modified: '2026-06-11',
				type: 'note',
				tags: ['area', 'development'],
			}),
			content: '# Career Growth\n\nRelated: [[Networking Notes]].\n',
		},
		{
			path: '02-Areas/Networking Notes.md',
			frontmatter: meta({
				created: '2026-03-01',
				modified: '2026-04-15',
				type: 'note',
				tags: ['area'],
			}),
			content: '# Networking Notes\n\nRelated: [[Career Growth]].\n',
		},
		{
			path: '02-Areas/Budget Planning.md',
			frontmatter: meta({
				created: '2026-01-01',
				modified: '2026-06-13',
				type: 'note',
				tags: ['area'],
			}),
			content: '# Budget Planning\n\nSee [[Investment Strategy]].\n',
		},
		{
			path: '02-Areas/Investment Strategy.md',
			frontmatter: meta({
				created: '2026-02-01',
				modified: '2026-05-20',
				type: 'note',
				tags: ['area'],
			}),
			content: '# Investment Strategy\n\nSee [[Budget Planning]].\n',
		},
		{
			path: '02-Areas/Meal Prep.md',
			frontmatter: meta({
				created: '2026-01-05',
				modified: '2026-06-10',
				type: 'note',
				tags: ['area'],
			}),
			content: '# Meal Prep\n\nSee [[Workout Routine]].\n',
		},
		{
			path: '02-Areas/Workout Routine.md',
			frontmatter: meta({
				created: '2026-01-01',
				modified: '2026-06-14',
				type: 'note',
				tags: ['area'],
			}),
			content: '# Workout Routine\n\nSee [[Meal Prep]].\n',
		},
	];
}

/**
 * Resource notes, including the map that links everything which would otherwise be an
 * orphan. Without it the fixture would report dozens of orphans and the score would not be
 * reproducible.
 */
function resourceNotes(): FixtureFile[] {
	const mapLinks = [
		'Book Atomic Habits',
		'Book Deep Work',
		'Article PKM Basics',
		'Article Note Taking',
		'Meeting Template',
		'Completed Goals',
		'Old Project One',
		'Old Project Two',
		'Problem Notes/empty-one',
		'Problem Notes/empty-two',
		'Problem Notes/nearly-empty',
		'Problem Notes/duplicate - Project Ideas',
		'Problem Notes/duplicate - Project Ideas 2',
		'Problem Notes/misspelled-tags',
		'Problem Notes/no-frontmatter',
		'Problem Notes/corrupted-frontmatter',
		'Problem Notes/special chars - @$%',
		'Problem Notes/unicode-日本語',
		'Problem Notes/very-long',
		'Problem Notes/stale-one',
		'Problem Notes/stale-two',
		'Unlinked Mentions/mention-source',
	];

	return [
		{
			path: '03-Resources/Vault Map.md',
			frontmatter: meta({
				created: '2026-01-02',
				modified: '2026-06-14',
				type: 'reference',
				tags: ['resource'],
			}),
			content: `# Vault Map\n\nAn index of everything worth finding.\n\n${mapLinks
				.map((link) => `- [[${link}]]`)
				.join('\n')}\n`,
		},
		{
			path: '03-Resources/Book Atomic Habits.md',
			frontmatter: meta({
				created: '2026-01-10',
				modified: '2026-03-15',
				type: 'reference',
				tags: ['resource'],
			}),
			content: '# Book Atomic Habits\n\nSmall changes compound.\n',
		},
		{
			path: '03-Resources/Book Deep Work.md',
			frontmatter: meta({
				created: '2026-02-20',
				modified: '2026-04-10',
				type: 'reference',
				tags: ['resource'],
			}),
			content: '# Book Deep Work\n\nFocus without distraction.\n',
		},
		{
			path: '03-Resources/Article PKM Basics.md',
			frontmatter: meta({ created: '2026-03-05', type: 'reference', tags: ['resource'] }),
			content: '# Article PKM Basics\n\nCapture, organise, review.\n',
		},
		{
			path: '03-Resources/Article Note Taking.md',
			frontmatter: meta({ created: '2026-03-10', type: 'reference', tags: ['resource'] }),
			content: '# Article Note Taking\n\nCompared methods.\n',
		},
		{
			path: '03-Resources/Meeting Template.md',
			frontmatter: meta({
				created: '2026-01-01',
				modified: '2026-06-01',
				type: 'template',
				tags: ['resource'],
			}),
			content: '# Meeting Template\n\n## Agenda\n\n## Actions\n',
		},
	];
}

function archiveNotes(): FixtureFile[] {
	return [
		{
			path: '04-Archive/Completed Goals.md',
			frontmatter: meta({
				created: '2025-01-01',
				modified: '2025-12-31',
				type: 'note',
				status: 'archived',
				tags: ['archive'],
			}),
			content: '# Completed Goals\n\nDone and dusted.\n',
		},
		{
			path: '04-Archive/Old Project One.md',
			frontmatter: meta({
				created: '2024-03-01',
				modified: '2024-12-15',
				type: 'project',
				status: 'archived',
				tags: ['archive'],
			}),
			content: '# Old Project One\n\nDelivered.\n',
		},
		{
			path: '04-Archive/Old Project Two.md',
			frontmatter: meta({
				created: '2025-02-01',
				modified: '2025-11-20',
				type: 'project',
				status: 'archived',
				tags: ['archive'],
			}),
			content: '# Old Project Two\n\nDelivered late.\n',
		},
	];
}

/** Nine daily notes, three of them sharing 15 June with earlier years for On This Day. */
function dailyNotes(): FixtureFile[] {
	const entries: { date: string; link: string }[] = [
		{ date: '2023-06-15', link: 'Book Deep Work' },
		{ date: '2024-06-15', link: 'Old Project One' },
		{ date: '2025-06-15', link: 'Old Project Two' },
		{ date: '2026-06-01', link: 'Project Gamma' },
		{ date: '2026-06-10', link: 'Project Alpha' },
		{ date: '2026-06-11', link: 'Project Beta' },
		{ date: '2026-06-12', link: 'Career Growth' },
		{ date: '2026-06-13', link: 'Budget Planning' },
		{ date: '2026-06-14', link: 'Meal Prep' },
	];

	return entries.map(({ date, link }) => ({
		path: `Daily Notes/${date}.md`,
		frontmatter: meta({ created: date, type: 'daily', tags: ['daily'] }),
		content: `# ${date}\n\nWorked on [[${link}]].\n`,
	}));
}

/**
 * The five orphans: no links in, no links out. One carries no tags and one is stale, as the
 * addendum's fixture description requires.
 */
function orphanNotes(): FixtureFile[] {
	return [
		{
			path: 'Orphan Notes/orphan-idea-one.md',
			frontmatter: meta({ created: '2026-04-01', type: 'idea', tags: ['idea'] }),
			content: '# Orphan idea one\n\nDisconnected from everything else.\n',
		},
		{
			path: 'Orphan Notes/orphan-idea-two.md',
			frontmatter: meta({ created: '2026-03-15', type: 'idea', tags: ['idea'] }),
			content: '# Orphan idea two\n\nAlso disconnected.\n',
		},
		{
			path: 'Orphan Notes/orphan-idea-three.md',
			frontmatter: meta({ created: '2026-02-20', type: 'idea', tags: ['idea'] }),
			content: '# Orphan idea three\n\nStill disconnected.\n',
		},
		{
			// The "missing tags" orphan: the property is absent entirely.
			path: 'Orphan Notes/orphan-untagged.md',
			frontmatter: {
				created: '2026-01-10',
				modified: '2026-01-10',
				type: 'note',
				status: 'active',
			},
			content: '# Orphan untagged\n\nNo tags, no links.\n',
		},
		{
			// The "stale" orphan: untouched well beyond the 180 day threshold.
			path: 'Orphan Notes/orphan-stale.md',
			frontmatter: meta({
				created: '2024-08-15',
				modified: '2024-08-15',
				type: 'note',
				tags: ['idea'],
			}),
			content: '# Orphan stale\n\nOld and disconnected.\n',
		},
	];
}

function problemNotes(): FixtureFile[] {
	const longBody = `# Very long\n\n${'Lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(2000)}`;

	return [
		{
			path: 'Problem Notes/empty-one.md',
			frontmatter: meta({ created: '2026-05-01', type: 'note', tags: ['problem'] }),
			content: '',
		},
		{
			path: 'Problem Notes/empty-two.md',
			frontmatter: meta({ created: '2026-04-15', type: 'note', tags: ['problem'] }),
			content: '\n\n',
		},
		{
			path: 'Problem Notes/nearly-empty.md',
			frontmatter: meta({ created: '2026-03-20', type: 'note', tags: ['problem'] }),
			content: 'TODO',
		},
		{
			path: 'Problem Notes/broken-three.md',
			frontmatter: meta({
				created: '2026-05-10',
				modified: '2026-06-01',
				type: 'note',
				tags: ['problem'],
			}),
			content:
				'# Broken three\n\n- [[Non Existent Note One]]\n- [[Missing Document]]\n- [[Deleted Page]]\n',
		},
		{
			path: 'Problem Notes/broken-five.md',
			frontmatter: meta({
				created: '2026-05-15',
				modified: '2026-05-20',
				type: 'note',
				tags: ['problem'],
			}),
			content:
				'# Broken five\n\n1. [[Ghost Note Alpha]]\n2. [[Phantom Document]]\n3. [[Removed Reference]]\n4. [[Lost Page]]\n5. [[Forgotten Note]]\n',
		},
		{
			path: 'Problem Notes/duplicate - Project Ideas.md',
			frontmatter: meta({
				created: '2026-04-01',
				modified: '2026-04-10',
				type: 'idea',
				tags: ['problem'],
			}),
			content: '# Project Ideas\n\n1. Habit tracker\n2. Recipe manager\n',
		},
		{
			path: 'Problem Notes/duplicate - Project Ideas 2.md',
			frontmatter: meta({
				created: '2026-04-05',
				modified: '2026-04-12',
				type: 'idea',
				tags: ['problem'],
			}),
			content: '# Project Ideas\n\n1. Habit tracker\n2. Recipe manager\n3. Budget app\n',
		},
		{
			// Three misspellings, each paired with a correct spelling used elsewhere.
			path: 'Problem Notes/misspelled-tags.md',
			frontmatter: meta({
				created: '2026-05-01',
				modified: '2026-05-15',
				type: 'note',
				tags: ['projek', 'developement', 'testting'],
			}),
			content: '# Misspelled tags\n\nThree tags here are typos of tags used elsewhere.\n',
		},
		{
			// No frontmatter at all: the single missing-metadata note.
			path: 'Problem Notes/no-frontmatter.md',
			content: '# No frontmatter\n\nThis note has no properties whatsoever.\n',
		},
		{
			// A fence that opens but whose YAML cannot parse.
			path: 'Problem Notes/corrupted-frontmatter.md',
			content:
				'---\ncreated: 2026-05-28\ntype note\nstatus: active\ntags [problem, broken\n---\n\n# Corrupted frontmatter\n\nThe block above is not valid YAML.\n',
		},
		{
			path: 'Problem Notes/special chars - @$%.md',
			frontmatter: meta({ created: '2026-05-20', type: 'note', tags: ['problem'] }),
			content: '# Special characters\n\nSymbols in the file name.\n',
		},
		{
			path: 'Problem Notes/unicode-日本語.md',
			frontmatter: meta({
				created: '2026-05-22',
				type: 'note',
				tags: ['problem', 'unicode'],
			}),
			content: '# Unicode\n\nこんにちは 안녕하세요 مرحبا 🎉\n',
		},
		{
			path: 'Problem Notes/very-long.md',
			frontmatter: meta({ created: '2026-05-25', type: 'note', tags: ['problem'] }),
			content: longBody,
		},
		{
			path: 'Problem Notes/stale-one.md',
			frontmatter: meta({
				created: '2023-03-10',
				modified: '2023-08-15',
				type: 'note',
				tags: ['problem'],
			}),
			content: '# Stale one\n\nUntouched since 2023.\n',
		},
		{
			path: 'Problem Notes/stale-two.md',
			frontmatter: meta({
				created: '2024-01-15',
				modified: '2024-06-20',
				type: 'note',
				tags: ['problem'],
			}),
			content: '# Stale two\n\nUntouched since 2024.\n',
		},
	];
}

/**
 * One note mentioning two existing titles as plain text.
 *
 * The prose deliberately avoids every other note title in the fixture, so the expected
 * count of two distinct targets is unambiguous.
 */
function mentionNotes(): FixtureFile[] {
	return [
		{
			path: 'Unlinked Mentions/mention-source.md',
			frontmatter: meta({
				created: '2026-06-10',
				modified: '2026-06-12',
				type: 'note',
				tags: ['problem'],
			}),
			content:
				'# Mentions without links\n\n' +
				'Today I reviewed Project Gamma and it is moving along nicely. ' +
				'The approach reminded me of Book Atomic Habits and its emphasis on small consistent steps.\n\n' +
				'I should wire Project Gamma into the graph properly at some point.\n',
		},
	];
}

/** Nine attachments: three referenced by notes above, six referenced by nothing. */
function attachments(): FixtureFile[] {
	const used = ['chart-used.png', 'diagram-used.png', 'spec-used.pdf'];
	const unused = [
		'photo-unused-one.png',
		'photo-unused-two.png',
		'photo-unused-three.jpg',
		'screenshot-unused.png',
		'recording-unused.mp3',
		'report-unused.pdf',
	];
	return [...used, ...unused].map((name) => ({
		path: `99-Attachments/${name}`,
		content: `binary:${name.length * 128}`,
		size: name.length * 128,
	}));
}

/** Build the known-answer vault. */
export function buildKnownAnswerVault(): App {
	return buildVault(
		[
			...inboxNotes(),
			...projectNotes(),
			...areaNotes(),
			...resourceNotes(),
			...archiveNotes(),
			...dailyNotes(),
			...orphanNotes(),
			...problemNotes(),
			...mentionNotes(),
			...attachments(),
		],
		'known-answer-vault',
	);
}

/** The instant the fixture treats as "today", matching the on-disk vault. */
export const KNOWN_ANSWER_NOW = day('2026-06-15');
