/**
 * The fix pipeline: plan, preview, confirm, back up, apply, log.
 *
 * This is the flow the spec calls mandatory (main spec 6.3, addendum 6.5), so the tests here
 * are deliberately adversarial: they check that refusing consent changes nothing on disk,
 * that a forged confirmation is rejected, that a file edited after the preview is skipped
 * rather than overwritten, and that an unreadable file is never deleted.
 */

import { describe, expect, it } from 'vitest';
import type { HealthIssue } from '../../src/types/health';
import {
	BackupFailedError,
	grantConfirmation,
	planIdOf,
	ReadOnlyVaultError,
	UnconfirmedChangeError,
} from '../../src/core/safety';
import { createHarness, type Harness } from '../helpers/harness';
import { buildVault, loadVaultFromDisk } from '../helpers/vault-fixture';

async function scanned(): Promise<{ harness: Harness; issues: readonly HealthIssue[] }> {
	const harness = await createHarness(loadVaultFromDisk());
	const report = await harness.engine.scan('full');
	return { harness, issues: report.issues };
}

function issuesOf(issues: readonly HealthIssue[], type: HealthIssue['type']): HealthIssue[] {
	return issues.filter((issue) => issue.type === type);
}

/** Snapshot every markdown file so a test can prove nothing changed. */
function snapshot(harness: Harness): Map<string, string> {
	const result = new Map<string, string>();
	for (const file of harness.app.vault.getMarkdownFiles()) {
		result.set(file.path, harness.app.vault.peek(file.path) ?? '');
	}
	return result;
}

describe('planning a fix', () => {
	it('describes the exact changes without touching the vault', async () => {
		const { harness, issues } = await scanned();
		const before = snapshot(harness);

		const prepared = await harness.fixes.prepare(
			'remove-link',
			issuesOf(issues, 'broken-link'),
		);

		expect(prepared.plan.changes).toHaveLength(2); // grouped per file, not per link
		expect(prepared.plan.changes.every((change) => change.kind === 'modify')).toBe(true);
		expect(prepared.plan.filesToBackup).toHaveLength(2);
		expect(prepared.plan.destructive).toBe(false);

		// Building a plan must be side-effect free.
		expect(snapshot(harness)).toEqual(before);
	});

	it('groups every broken link in one file into a single change', async () => {
		const { harness, issues } = await scanned();
		const prepared = await harness.fixes.prepare(
			'remove-link',
			issuesOf(issues, 'broken-link'),
		);

		const paths = prepared.plan.changes.map((change) => change.path).sort();
		expect(paths).toEqual([
			'Problem Notes/broken-link-note.md',
			'Problem Notes/multiple-broken-links.md',
		]);
	});

	it('refuses to plan when required input is missing', async () => {
		const { harness, issues } = await scanned();
		await expect(
			harness.fixes.prepare('replace-link', issuesOf(issues, 'broken-link')),
		).rejects.toThrow(/Choose a note/);
		await expect(harness.fixes.prepare('remove-link', [])).rejects.toThrow(/Nothing/);
	});
});

describe('the confirmation gate', () => {
	it('refuses to apply without a token', async () => {
		const { harness, issues } = await scanned();
		const before = snapshot(harness);
		const prepared = await harness.fixes.prepare(
			'remove-link',
			issuesOf(issues, 'broken-link'),
		);

		await expect(
			harness.safety.execute(prepared.plan, null, prepared.execute),
		).rejects.toBeInstanceOf(UnconfirmedChangeError);
		expect(snapshot(harness)).toEqual(before);
	});

	it('refuses a token minted for a different plan', async () => {
		const { harness, issues } = await scanned();
		const before = snapshot(harness);
		const prepared = await harness.fixes.prepare(
			'remove-link',
			issuesOf(issues, 'broken-link'),
		);

		const forged = grantConfirmation('some-other-plan');
		await expect(
			harness.safety.execute(prepared.plan, forged, prepared.execute),
		).rejects.toBeInstanceOf(UnconfirmedChangeError);
		expect(snapshot(harness)).toEqual(before);
	});

	it('refuses to write to a read-only vault', async () => {
		const { harness, issues } = await scanned();
		const prepared = await harness.fixes.prepare(
			'remove-link',
			issuesOf(issues, 'broken-link'),
		);
		harness.app.vault.readOnly = true;

		await expect(
			harness.safety.execute(
				prepared.plan,
				grantConfirmation(planIdOf(prepared.plan)),
				prepared.execute,
			),
		).rejects.toBeInstanceOf(ReadOnlyVaultError);
	});

	it('aborts the whole batch when the backup cannot be made', async () => {
		const { harness, issues } = await scanned();
		const before = snapshot(harness);
		const prepared = await harness.fixes.prepare(
			'remove-link',
			issuesOf(issues, 'broken-link'),
		);
		// The vault itself stays writable; only the plugin's own storage fails.
		harness.app.vault.adapter.readOnly = true;

		await expect(
			harness.safety.execute(
				prepared.plan,
				grantConfirmation(planIdOf(prepared.plan)),
				prepared.execute,
			),
		).rejects.toBeInstanceOf(BackupFailedError);
		expect(snapshot(harness)).toEqual(before);
	});
});

describe('applying a fix', () => {
	it('removes broken links, keeps the text, and resolves the issues', async () => {
		const { harness, issues } = await scanned();
		const brokenLinks = issuesOf(issues, 'broken-link');
		const prepared = await harness.fixes.prepare('remove-link', brokenLinks);

		const result = await harness.safety.execute(
			prepared.plan,
			grantConfirmation(planIdOf(prepared.plan)),
			prepared.execute,
		);

		expect(result.applied).toHaveLength(2);
		expect(result.failed).toHaveLength(0);
		expect(result.skipped).toHaveLength(0);
		expect(result.backupDir).not.toBeNull();

		const content = harness.app.vault.peek('Problem Notes/multiple-broken-links.md') ?? '';
		expect(content).not.toContain('[[Ghost Note Alpha]]');
		// The link text survives; only the brackets go.
		expect(content).toContain('Ghost Note Alpha');

		harness.app.metadataCache.refresh();
		harness.index.build();
		harness.content.clear();
		const after = await harness.engine.scan('full');
		expect(after.countsByType['broken-link']).toBe(0);
	});

	it('creates the missing notes a broken link points at', async () => {
		const { harness, issues } = await scanned();
		const target = issuesOf(issues, 'broken-link').filter(
			(issue) => issue.data.kind === 'broken-link' && issue.data.target === 'Lost Page',
		);
		const prepared = await harness.fixes.prepare('create-note', target);

		await harness.safety.execute(
			prepared.plan,
			grantConfirmation(planIdOf(prepared.plan)),
			prepared.execute,
			{ skipBackup: true },
		);

		expect(harness.app.vault.getFileByPath('00-Inbox/Lost Page.md')).not.toBeNull();
	});

	it('creates a folder-carrying target where the link actually points', async () => {
		// `[[Projects/Roadmap]]` addresses a path, not a name: a note created anywhere else
		// leaves the link exactly as broken as it was, which is the one thing this fix exists
		// to stop. `LinkService` resolves the folder itself; the plan has to let it.
		const harness = await createHarness(
			buildVault([{ path: 'notes/source.md', content: 'See [[Projects/Roadmap]].' }]),
		);
		const report = await harness.engine.scan('full');
		const broken = issuesOf(report.issues, 'broken-link');
		expect(broken).toHaveLength(1);

		const prepared = await harness.fixes.prepare('create-note', broken);
		expect(prepared.plan.changes[0]?.path).toBe('Projects/Roadmap.md');

		await harness.safety.execute(
			prepared.plan,
			grantConfirmation(planIdOf(prepared.plan)),
			prepared.execute,
			{ skipBackup: true },
		);

		expect(harness.app.vault.getFileByPath('Projects/Roadmap.md')).not.toBeNull();
		// And the link it was created for now resolves.
		harness.app.metadataCache.refresh();
		expect(harness.links.resolve('Projects/Roadmap', 'notes/source.md')?.path).toBe(
			'Projects/Roadmap.md',
		);
	});

	it('merges misspelled tags into the canonical spelling', async () => {
		const { harness, issues } = await scanned();
		const tagIssues = issuesOf(issues, 'tag-inconsistency');
		const prepared = await harness.fixes.prepare('merge-tags', tagIssues);

		await harness.safety.execute(
			prepared.plan,
			grantConfirmation(planIdOf(prepared.plan)),
			prepared.execute,
		);

		const content = harness.app.vault.peek('Problem Notes/tag inconsistency note.md') ?? '';
		const frontmatter = content.split('---')[1] ?? '';

		// All three typos are gone from the tag list...
		expect(frontmatter).toContain('- project');
		expect(frontmatter).toContain('- development');
		expect(frontmatter).toContain('- testing');
		expect(frontmatter).not.toContain('projek\n');
		expect(frontmatter).not.toContain('developement');
		expect(frontmatter).not.toContain('testting');

		// ...but the body, which discusses the misspellings in prose, is untouched. Renaming
		// a tag must never rewrite ordinary words that happen to match it.
		expect(content).toContain('projek should be project');
		expect(content).toContain('testting should be testing');
	});

	it('moves an unused attachment into the attachment archive', async () => {
		const { harness, issues } = await scanned();
		const attachment = issuesOf(issues, 'unused-attachment').slice(0, 1);
		const originalPath = attachment[0]?.path ?? '';
		const prepared = await harness.fixes.prepare('move-to-archive', attachment);

		await harness.safety.execute(
			prepared.plan,
			grantConfirmation(planIdOf(prepared.plan)),
			prepared.execute,
		);

		expect(harness.app.vault.getFileByPath(originalPath)).toBeNull();
		const moved = prepared.plan.changes[0]?.targetPath ?? '';
		expect(moved.startsWith('04-Archive/attachments/')).toBe(true);
		expect(harness.app.vault.getFileByPath(moved)).not.toBeNull();
	});

	it('gives each archived file its own destination when two share a name', async () => {
		// Two unused attachments called `diagram.png` in different folders. Nothing has moved
		// yet, so the vault cannot tell the planner that the first one has already claimed
		// `04-Archive/attachments/diagram.png`; without tracking that, both changes name the
		// same destination and the second rename fails against a preview that promised it.
		const harness = await createHarness(
			buildVault([
				{ path: 'notes/keep.md', content: '# Keep' },
				{ path: 'one/diagram.png', content: 'binary:10', size: 10 },
				{ path: 'two/diagram.png', content: 'binary:20', size: 20 },
			]),
		);
		const report = await harness.engine.scan('full');
		const attachments = issuesOf(report.issues, 'unused-attachment');
		expect(attachments).toHaveLength(2);

		const prepared = await harness.fixes.prepare('move-to-archive', attachments);
		const destinations = prepared.plan.changes.map((change) => change.targetPath);
		expect(new Set(destinations).size).toBe(2);

		const result = await harness.safety.execute(
			prepared.plan,
			grantConfirmation(planIdOf(prepared.plan)),
			prepared.execute,
		);

		expect(result.failed).toEqual([]);
		expect(result.applied).toHaveLength(2);
		// Both files survive the move, each at the path the preview named.
		for (const destination of destinations) {
			expect(harness.app.vault.getFileByPath(destination ?? '')).not.toBeNull();
		}
		expect(harness.app.vault.getFileByPath('one/diagram.png')).toBeNull();
		expect(harness.app.vault.getFileByPath('two/diagram.png')).toBeNull();
	});

	it('sends an empty note to the trash rather than deleting it outright', async () => {
		const { harness, issues } = await scanned();
		const empty = issuesOf(issues, 'empty-note').slice(0, 1);
		const prepared = await harness.fixes.prepare('trash', empty);

		expect(prepared.plan.changes[0]?.kind).toBe('trash');
		expect(prepared.plan.destructive).toBe(false);

		await harness.safety.execute(
			prepared.plan,
			grantConfirmation(planIdOf(prepared.plan)),
			prepared.execute,
		);
		expect(harness.app.vault.getFileByPath(empty[0]?.path ?? '')).toBeNull();
	});
});

describe('conflict safety', () => {
	it('skips a file that changed after the preview was built', async () => {
		const { harness, issues } = await scanned();
		const prepared = await harness.fixes.prepare(
			'remove-link',
			issuesOf(issues, 'broken-link'),
		);

		// Simulate the user editing one of the files while the preview was on screen.
		const edited = harness.app.vault.getFileByPath('Problem Notes/broken-link-note.md');
		expect(edited).not.toBeNull();
		if (!edited) return;
		const editedContent = `${harness.app.vault.peek(edited.path) ?? ''}\n\nEdited while previewing.`;
		await harness.app.vault.modify(edited, editedContent);

		const result = await harness.safety.execute(
			prepared.plan,
			grantConfirmation(planIdOf(prepared.plan)),
			prepared.execute,
		);

		expect(result.skipped).toHaveLength(1);
		expect(result.skipped[0]?.change.path).toBe('Problem Notes/broken-link-note.md');
		expect(result.applied).toHaveLength(1);
		// The user's newer edit survives untouched.
		expect(harness.app.vault.peek(edited.path)).toBe(editedContent);
	});

	it('skips a file that vanished after the preview was built', async () => {
		const { harness, issues } = await scanned();
		const prepared = await harness.fixes.prepare(
			'remove-link',
			issuesOf(issues, 'broken-link'),
		);

		const removed = harness.app.vault.getFileByPath('Problem Notes/broken-link-note.md');
		if (removed) await harness.app.vault.trash(removed, false);

		const result = await harness.safety.execute(
			prepared.plan,
			grantConfirmation(planIdOf(prepared.plan)),
			prepared.execute,
		);

		expect(result.skipped).toHaveLength(1);
		expect(result.applied).toHaveLength(1);
	});
});

describe('backup and restore', () => {
	it('backs up every affected file and restores it on demand', async () => {
		const { harness, issues } = await scanned();
		const path = 'Problem Notes/multiple-broken-links.md';
		const original = harness.app.vault.peek(path) ?? '';

		const prepared = await harness.fixes.prepare(
			'remove-link',
			issuesOf(issues, 'broken-link'),
		);
		const result = await harness.safety.execute(
			prepared.plan,
			grantConfirmation(planIdOf(prepared.plan)),
			prepared.execute,
		);

		expect(result.backupDir).not.toBeNull();
		expect(harness.app.vault.peek(path)).not.toBe(original);

		const restored = await harness.backup.restoreLatest();
		expect(restored.failed).toHaveLength(0);
		expect(harness.app.vault.peek(path)).toBe(original);
	});

	it('keeps only the ten most recent backups', async () => {
		const { harness } = await scanned();
		for (let i = 0; i < 12; i++) {
			harness.app.vault.tick(1000);
			const dir = await harness.backup.create(
				['Problem Notes/stale-note-2023.md'],
				`batch ${i}`,
			);
			// Each one must genuinely succeed, otherwise the cap below proves nothing.
			expect(dir).not.toBeNull();
		}
		expect(harness.backup.list()).toHaveLength(10);
		expect(harness.backup.list()[0]?.label).toBe('batch 11');
	});
});

describe('the action log', () => {
	it('records a fix with its files and result', async () => {
		const { harness, issues } = await scanned();
		const prepared = await harness.fixes.prepare(
			'remove-link',
			issuesOf(issues, 'broken-link'),
		);
		const result = await harness.safety.execute(
			prepared.plan,
			grantConfirmation(planIdOf(prepared.plan)),
			prepared.execute,
		);

		await harness.actionLog.log({
			action: prepared.plan.label,
			details: `${result.applied.length} applied`,
			files: result.applied.map((change) => change.path),
			result: 'success',
			...(result.backupDir ? { backupDir: result.backupDir } : {}),
		});

		const entries = harness.actionLog.entries();
		expect(entries).toHaveLength(1);
		expect(entries[0]?.files).toHaveLength(2);
		expect(entries[0]?.result).toBe('success');
		// Persisted, not just held in memory.
		expect(JSON.stringify(harness.host.peek())).toContain('actionLog');
	});
});

describe('ignore lists', () => {
	it('persists across scans and can be cleared', async () => {
		const { harness, issues } = await scanned();
		const orphans = issuesOf(issues, 'orphan-note').slice(0, 3);

		await harness.health.ignore(orphans);
		expect(harness.health.ignoredCounts()['orphan-note']).toBe(3);

		const second = await harness.engine.scan('full');
		expect(second.countsByType['orphan-note']).toBe(22);

		await harness.health.clearIgnored('orphan-note');
		const third = await harness.engine.scan('full');
		expect(third.countsByType['orphan-note']).toBe(25);
	});

	it('keeps an ignored issue ignored after the file is edited elsewhere', async () => {
		const { harness, issues } = await scanned();
		const orphan = issuesOf(issues, 'orphan-note').slice(0, 1);
		await harness.health.ignore(orphan);

		// The id is built from stable parts, so unrelated edits must not resurrect it.
		const file = harness.app.vault.getFileByPath(orphan[0]?.path ?? '');
		if (file) {
			await harness.app.vault.modify(
				file,
				`${harness.app.vault.peek(file.path) ?? ''}\nmore`,
			);
			harness.app.metadataCache.refresh();
			harness.index.build();
			harness.content.clear();
		}

		const after = await harness.engine.scan('full');
		expect(after.issues.some((issue) => issue.id === orphan[0]?.id)).toBe(false);
	});
});
