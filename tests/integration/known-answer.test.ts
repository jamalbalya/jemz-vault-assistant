/**
 * Known-answer fixture tests (addendum section 12.5).
 *
 * The fixture is built so every number below is hand-countable from
 * `tests/fixtures/known-answer-vault.ts`. Unlike the on-disk vault, every note here is
 * connected to the graph except the five designated orphans, which is what makes the
 * documented "score ≈ 92" reproducible.
 */

import { describe, expect, it } from 'vitest';
import { createHarness } from '../helpers/harness';
import {
	buildKnownAnswerVault,
	KNOWN_ANSWERS,
	KNOWN_ANSWER_NOW,
	KNOWN_REQUIRED_FIELDS,
} from '../fixtures/known-answer-vault';
import { findUnlinkedMentionsInNote } from '../../src/modules/retrieval/contextual/unlinked-mentions';
import { countOnThisDay } from '../../src/modules/retrieval/contextual/on-this-day';

/** The harness every case in this file uses. */
async function scanFixture(
	mutate?: (settings: import('../../src/types/settings').JemzSettings) => void,
) {
	const harness = await createHarness(buildKnownAnswerVault(), {
		now: KNOWN_ANSWER_NOW,
		settings: (settings) => {
			settings.health.requiredFrontmatterFields = [...KNOWN_REQUIRED_FIELDS];
			mutate?.(settings);
		},
	});
	const report = await harness.engine.scan('full');
	return { harness, report };
}

describe('known-answer fixture: detection counts', () => {
	it('finds exactly eight broken links', async () => {
		const { report } = await scanFixture();
		expect(report.countsByType['broken-link']).toBe(KNOWN_ANSWERS.brokenLinks);
	});

	it('finds exactly the five designated orphans', async () => {
		const { report } = await scanFixture();
		expect(report.countsByType['orphan-note']).toBe(KNOWN_ANSWERS.orphans);

		const paths = report.issues
			.filter((issue) => issue.type === 'orphan-note')
			.map((issue) => issue.path)
			.sort();
		expect(paths).toEqual([
			'Orphan Notes/orphan-idea-one.md',
			'Orphan Notes/orphan-idea-three.md',
			'Orphan Notes/orphan-idea-two.md',
			'Orphan Notes/orphan-stale.md',
			'Orphan Notes/orphan-untagged.md',
		]);
	});

	it('finds the two empty notes and the nearly empty one', async () => {
		const { report } = await scanFixture();
		expect(report.countsByType['empty-note']).toBe(KNOWN_ANSWERS.emptyNotes);
	});

	it('finds six unused attachments out of nine', async () => {
		const { harness, report } = await scanFixture();
		expect(report.countsByType['unused-attachment']).toBe(KNOWN_ANSWERS.unusedAttachments);
		expect(harness.index.attachments()).toHaveLength(
			KNOWN_ANSWERS.unusedAttachments + KNOWN_ANSWERS.usedAttachments,
		);
	});

	it('finds exactly one duplicate title pair', async () => {
		const { report } = await scanFixture();
		expect(report.countsByType['duplicate-title']).toBe(KNOWN_ANSWERS.duplicatePairs);

		const issue = report.issues.find((candidate) => candidate.type === 'duplicate-title');
		expect(issue?.data.kind).toBe('duplicate-title');
		if (issue?.data.kind === 'duplicate-title') {
			expect([...issue.data.paths].sort()).toEqual([
				'Problem Notes/duplicate - Project Ideas 2.md',
				'Problem Notes/duplicate - Project Ideas.md',
			]);
		}
	});

	it('finds the three misspelled tag groups and nothing else', async () => {
		const { report } = await scanFixture();
		expect(report.countsByType['tag-inconsistency']).toBe(KNOWN_ANSWERS.tagInconsistencies);

		const canonicals = report.issues
			.filter((issue) => issue.type === 'tag-inconsistency')
			.map((issue) => (issue.data.kind === 'tag-inconsistency' ? issue.data.canonical : ''))
			.sort();
		expect(canonicals).toEqual(['development', 'project', 'testing']);
	});

	it('finds one note missing required properties, and one with broken YAML', async () => {
		const { report } = await scanFixture();
		expect(report.countsByType['missing-metadata']).toBe(KNOWN_ANSWERS.missingMetadata);
		expect(report.countsByType['corrupted-frontmatter']).toBe(
			KNOWN_ANSWERS.corruptedFrontmatter,
		);

		expect(report.issues.find((issue) => issue.type === 'missing-metadata')?.path).toBe(
			'Problem Notes/no-frontmatter.md',
		);
		expect(report.issues.find((issue) => issue.type === 'corrupted-frontmatter')?.path).toBe(
			'Problem Notes/corrupted-frontmatter.md',
		);
	});

	it('reports no large files at the default 10MB threshold', async () => {
		const { report } = await scanFixture();
		expect(report.countsByType['large-file']).toBe(KNOWN_ANSWERS.largeFilesAtDefaultThreshold);
	});

	it('scores approximately 92', async () => {
		const { report } = await scanFixture();
		// 8*0.5 + 5*0.2 + 3*0.3 + 6*0.1 + 1*0.5 + 3*0.3 + 1*0.3 = 8.2
		expect(report.score.totalPenalty).toBeCloseTo(8.2, 5);
		expect(report.score.value).toBeCloseTo(91.8, 5);
		expect(Math.round(report.score.value)).toBe(KNOWN_ANSWERS.healthScore);
	});

	it('explains why `tags` is left out of the required list', async () => {
		// Adding `tags` back finds a second note: the orphan the fixture deliberately leaves
		// untagged. Both findings are correct, which is why the addendum's "missing metadata
		// = 1 with required created/type/status/tags" cannot hold alongside its own
		// "one orphan missing tags".
		const { report } = await scanFixture((settings) => {
			settings.health.requiredFrontmatterFields = ['created', 'type', 'status', 'tags'];
		});

		expect(report.countsByType['missing-metadata']).toBe(2);
		expect(
			report.issues
				.filter((issue) => issue.type === 'missing-metadata')
				.map((issue) => issue.path)
				.sort(),
		).toEqual(['Orphan Notes/orphan-untagged.md', 'Problem Notes/no-frontmatter.md']);
	});
});

describe('known-answer fixture: inbox and retrieval', () => {
	it('lists the ten inbox notes', async () => {
		const { harness } = await scanFixture();
		expect(harness.inbox.count()).toBe(KNOWN_ANSWERS.inboxNotes);
	});

	it('keeps the inbox out of the health scan by default', async () => {
		const { report } = await scanFixture();
		expect(report.issues.every((issue) => !issue.path.startsWith('00-Inbox/'))).toBe(true);
	});

	it('shows three On This Day notes, one per previous year', async () => {
		const { harness } = await scanFixture();
		const entries = harness.retrieval.onThisDay(KNOWN_ANSWER_NOW);

		expect(entries.map((entry) => entry.year)).toEqual([2025, 2024, 2023]);
		expect(countOnThisDay(entries)).toBe(3);
	});

	it('finds at least three stale notes, including the designated ones', async () => {
		const { harness } = await scanFixture();
		const stale = harness.retrieval.staleNotes(KNOWN_ANSWER_NOW);

		expect(stale.length).toBeGreaterThanOrEqual(KNOWN_ANSWERS.staleNotesAtLeast);
		const paths = stale.map((note) => note.path);
		expect(paths).toContain('Problem Notes/stale-one.md');
		expect(paths).toContain('Problem Notes/stale-two.md');
		expect(paths).toContain('Orphan Notes/orphan-stale.md');
		// Archived notes are already dealt with and must never be nagged about.
		expect(paths.every((path) => !path.startsWith('04-Archive/'))).toBe(true);
		// Oldest first.
		expect(stale[0]?.daysStale).toBeGreaterThanOrEqual(stale[stale.length - 1]?.daysStale ?? 0);
	});

	it('finds exactly two unlinked mention targets in the mention note', async () => {
		const { harness } = await scanFixture();
		const path = 'Unlinked Mentions/mention-source.md';
		const content = harness.app.vault.peek(path) ?? '';

		const mentions = findUnlinkedMentionsInNote(
			path,
			content,
			harness.retrieval.mentionTargets(),
			{
				minLength: 4,
			},
		);

		const targets = Array.from(new Set(mentions.map((mention) => mention.targetPath))).sort();
		expect(targets).toEqual([
			'01-Projects/Project Gamma.md',
			'03-Resources/Book Atomic Habits.md',
		]);
		expect(targets).toHaveLength(KNOWN_ANSWERS.unlinkedMentions);
	});

	it('converts an unlinked mention into a real link', async () => {
		const { harness } = await scanFixture();
		const path = 'Unlinked Mentions/mention-source.md';
		const mentions = await harness.retrieval.unlinkedMentionsIn(path);
		const first = mentions[0];
		expect(first).toBeDefined();
		if (!first) return;

		expect(await harness.retrieval.convertMentionToLink(first)).toBe(true);
		const after = harness.app.vault.peek(path) ?? '';
		expect(after).toContain(`[[${first.targetTitle}]]`);
	});

	it('finds project notes by keyword and survives a typo', async () => {
		const { harness } = await scanFixture();

		const exact = await harness.retrieval.search({
			keyword: 'project',
			filters: [],
			logic: 'and',
			sort: { field: 'relevance', direction: 'desc' },
		});
		expect(exact.total).toBeGreaterThan(0);

		const typo = await harness.retrieval.search({
			keyword: 'projct',
			filters: [],
			logic: 'and',
			sort: { field: 'relevance', direction: 'desc' },
		});
		expect(typo.results.some((result) => result.title.startsWith('Project'))).toBe(true);
	});

	it('filters by tag and by type', async () => {
		const { harness } = await scanFixture();

		const byTag = await harness.retrieval.search({
			keyword: '',
			filters: [{ id: 'f1', field: 'tag', operator: 'contains', value: 'alpha' }],
			logic: 'and',
			sort: { field: 'title', direction: 'asc' },
		});
		expect(byTag.results.map((result) => result.title).sort()).toEqual([
			'Alpha Meeting Notes',
			'Alpha Requirements',
			'Alpha Timeline',
			'Project Alpha',
		]);

		const byType = await harness.retrieval.search({
			keyword: '',
			filters: [{ id: 'f2', field: 'type', operator: 'is', value: 'project' }],
			logic: 'and',
			sort: { field: 'title', direction: 'asc' },
		});
		expect(byType.results.map((result) => result.title)).toEqual([
			'Project Alpha',
			'Project Beta',
			'Project Gamma',
		]);
	});

	it('runs the orphan saved view with the detector definition', async () => {
		const { harness } = await scanFixture();
		const view = harness.retrieval.views().find((candidate) => candidate.special === 'orphans');
		expect(view).toBeDefined();
		if (!view) return;

		const response = await harness.retrieval.runView(view);
		expect(response.total).toBe(KNOWN_ANSWERS.orphans);
	});
});
