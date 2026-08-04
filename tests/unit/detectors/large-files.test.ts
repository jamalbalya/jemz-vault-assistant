/**
 * Large file detector.
 *
 * Sizes come from the file stat, so the detector must cover attachments as well as notes —
 * the file slowing a vault down is nearly always an image, not a note.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { App as ObsidianApp } from 'obsidian';
import detector from '../../../src/modules/health/detectors/large-files';
import { Logger } from '../../../src/core/logger';
import { VaultIndex } from '../../../src/services/vault-index';
import type { DetectorContext, HealthIssue, LargeFileIssueData } from '../../../src/types/health';
import type { HealthSettings } from '../../../src/types/settings';
import { DEFAULT_SETTINGS } from '../../../src/types/settings';
import type { App } from '../../mocks/obsidian';
import {
	buildVault,
	FIXTURE_NOW,
	loadVaultFromDisk,
	TEST_VAULT_PATH,
} from '../../helpers/vault-fixture';

const ONE_HUNDRED_KB = 100 * 1024;

/** Build a detector context from a mock vault. */
function contextFor(app: App, settings: Partial<HealthSettings> = {}): DetectorContext {
	const logger = new Logger('silent');
	const index = new VaultIndex(app as unknown as ObsidianApp, logger);
	index.build();
	return {
		notes: index.notes(),
		attachments: index.attachments(),
		allFiles: index.all(),
		settings: { ...DEFAULT_SETTINGS.health, ...settings },
		now: FIXTURE_NOW,
		getStats: (): null => null,
		backlinksOf: (path: string): readonly string[] => index.backlinksOf(path),
	};
}

/** Narrow an issue's payload without casting. */
function largeFileData(issue: HealthIssue): LargeFileIssueData {
	if (issue.data.kind !== 'large-file') {
		throw new Error(`Expected large-file data, got "${issue.data.kind}"`);
	}
	return issue.data;
}

function paths(issues: readonly HealthIssue[]): string[] {
	return issues.map((issue) => issue.path).sort();
}

describe('large-file detector shape', () => {
	it('declares its type, label and that it needs no content', () => {
		expect(detector.type).toBe('large-file');
		expect(detector.label).toBe('Large files');
		expect(detector.needsContent).toBeUndefined();
	});
});

describe('large-file detector', () => {
	it('reports nothing for an empty vault', () => {
		expect(detector.run(contextFor(buildVault([])))).toEqual([]);
	});

	it('reports nothing for a single small note', () => {
		const app = buildVault([{ path: 'a/Small.md', content: 'tiny' }]);
		expect(detector.run(contextFor(app))).toEqual([]);
	});

	it('reports a note above the threshold', () => {
		const app = buildVault([{ path: 'a/Huge Note.md', content: 'x'.repeat(120_000) }]);
		const issues = detector.run(contextFor(app, { largeFileThresholdBytes: ONE_HUNDRED_KB }));

		expect(issues).toHaveLength(1);
		const issue = issues[0];
		expect(issue?.type).toBe('large-file');
		expect(issue?.severity).toBe('low');
		expect(issue?.path).toBe('a/Huge Note.md');
		expect(issue?.title).toBe('Huge Note.md');
		expect(issue?.detail).toBe('Files above the size threshold. 117.2 KB');

		const data = largeFileData(issue as HealthIssue);
		expect(data.size).toBe(120_000);
		expect(data.threshold).toBe(ONE_HUNDRED_KB);
	});

	it('reports attachments as well as notes, with their extension in the title', () => {
		const app = buildVault([
			{ path: 'a/Note.md', content: 'x', size: 1 },
			{ path: '99-Attachments/images/screenshot.png', content: 'binary', size: 4_000_000 },
			{ path: '99-Attachments/audio/recording.mp3', content: 'binary', size: 200 },
		]);
		const issues = detector.run(contextFor(app, { largeFileThresholdBytes: 1_000_000 }));

		expect(paths(issues)).toEqual(['99-Attachments/images/screenshot.png']);
		expect(issues[0]?.title).toBe('screenshot.png');
		expect(largeFileData(issues[0] as HealthIssue).size).toBe(4_000_000);
	});

	it('reports a file once even when the context lists it as both a note and an attachment', () => {
		const app = buildVault([
			{ path: 'a/Big.md', content: 'x', size: 999 },
			{ path: 'a/big.png', content: 'binary', size: 999 },
		]);
		const base = contextFor(app, { largeFileThresholdBytes: 10 });
		// `allFiles` overlaps both lists by contract, so a caller handing it over must not get
		// two issues carrying the same id for one file.
		const overlapping: DetectorContext = {
			...base,
			notes: base.allFiles,
			attachments: base.allFiles,
		};
		const issues = detector.run(overlapping);

		expect(paths(issues)).toEqual(['a/Big.md', 'a/big.png']);
		expect(new Set(issues.map((issue) => issue.id)).size).toBe(2);
	});

	it('uses a strict comparison, so a file exactly at the threshold passes', () => {
		const app = buildVault([
			{ path: 'a/Exact.md', content: 'x', size: ONE_HUNDRED_KB },
			{ path: 'a/Over.md', content: 'x', size: ONE_HUNDRED_KB + 1 },
		]);
		const issues = detector.run(contextFor(app, { largeFileThresholdBytes: ONE_HUNDRED_KB }));
		expect(paths(issues)).toEqual(['a/Over.md']);
	});

	it('reports nothing at the 10 MB default', () => {
		const app = buildVault([
			{ path: 'a/Huge.md', content: 'x'.repeat(120_000) },
			{ path: 'b/image.png', content: 'binary', size: 5_000_000 },
		]);
		expect(detector.run(contextFor(app))).toEqual([]);
	});

	it('handles unicode and special characters in file names', () => {
		const app = buildVault([
			{ path: 'a/unicode-note-日本語.md', content: 'x', size: 300_000 },
			{ path: 'a/special chars - @#$%.png', content: 'binary', size: 300_000 },
		]);
		const issues = detector.run(contextFor(app, { largeFileThresholdBytes: ONE_HUNDRED_KB }));

		expect(paths(issues)).toEqual(['a/special chars - @#$%.png', 'a/unicode-note-日本語.md']);
		expect(issues.map((issue) => issue.title).sort()).toEqual([
			'special chars - @#$%.png',
			'unicode-note-日本語.md',
		]);
	});

	it('is unaffected by missing or corrupt frontmatter', () => {
		const app = buildVault([
			{
				path: 'a/corrupt.md',
				content: `---\ntype note\nbroken [\n---\n${'x'.repeat(200_000)}`,
			},
			{ path: 'b/plain.md', content: 'x'.repeat(200_000) },
		]);
		expect(
			paths(detector.run(contextFor(app, { largeFileThresholdBytes: ONE_HUNDRED_KB }))),
		).toEqual(['a/corrupt.md', 'b/plain.md']);
	});

	it('keeps the same id while the file keeps growing', async () => {
		const app = buildVault([{ path: 'a/Growing.md', content: 'x'.repeat(120_000) }]);
		const before = detector.run(contextFor(app, { largeFileThresholdBytes: ONE_HUNDRED_KB }));

		// Concurrent modification: the note grows between two scans.
		const file = app.vault.getFileByPath('a/Growing.md');
		if (!file) throw new Error('fixture is missing a/Growing.md');
		await app.vault.modify(file, 'y'.repeat(240_000));
		app.metadataCache.refresh();

		const after = detector.run(contextFor(app, { largeFileThresholdBytes: ONE_HUNDRED_KB }));
		expect(after[0]?.id).toBe(before[0]?.id);
		expect(largeFileData(after[0] as HealthIssue).size).toBe(240_000);
	});
});

describe('large-file detector against the on-disk fixture', () => {
	let app: App;

	beforeEach(() => {
		app = loadVaultFromDisk(TEST_VAULT_PATH, {
			exclude: (path) => path.startsWith('00-Inbox/'),
		});
	});

	it('reports nothing at the 10 MB default', () => {
		expect(detector.run(contextFor(app))).toEqual([]);
	});

	it('reports the one oversized note once the threshold drops to 100 KB', () => {
		const issues = detector.run(contextFor(app, { largeFileThresholdBytes: ONE_HUNDRED_KB }));

		expect(issues).toHaveLength(1);
		expect(issues[0]?.path).toBe('Problem Notes/very-long-note.md');
		expect(largeFileData(issues[0] as HealthIssue).size).toBeGreaterThan(ONE_HUNDRED_KB);
	});
});
