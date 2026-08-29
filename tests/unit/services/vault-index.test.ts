/**
 * The vault index's link graph.
 *
 * The index is maintained two ways — a full rebuild on load, and a per-file update on every
 * vault event — and the interesting failures are the ones where those two disagree. A note's
 * backlinks decide whether it is an orphan, so a rule applied on one path and not the other
 * makes the health report depend on whether the file happens to have been touched since the
 * plugin started.
 */

import { describe, expect, it } from 'vitest';
import type { App as ObsidianApp, TFile } from 'obsidian';
import { Logger } from '../../../src/core/logger';
import { VaultIndex } from '../../../src/services/vault-index';
import orphanNotes from '../../../src/modules/health/detectors/orphan-notes';
import { DEFAULT_SETTINGS } from '../../../src/types/settings';
import type { DetectorContext } from '../../../src/types/health';
import type { App } from '../../mocks/obsidian';
import { buildVault, FIXTURE_NOW } from '../../helpers/vault-fixture';

function indexFor(app: App): VaultIndex {
	const index = new VaultIndex(app as unknown as ObsidianApp, new Logger('silent'));
	index.build();
	return index;
}

/** Rewrite a file and hand back the `TFile` a vault `modify` event would carry. */
function rewrite(app: App, path: string, content: string): TFile {
	app.vault.seed(path, content);
	app.metadataCache.refresh();
	const file = app.vault.getFileByPath(path);
	if (!file) throw new Error(`No file at "${path}"`);
	return file as unknown as TFile;
}

function contextFor(index: VaultIndex): DetectorContext {
	return {
		notes: index.notes(),
		attachments: index.attachments(),
		allFiles: index.all(),
		settings: { ...DEFAULT_SETTINGS.health },
		now: FIXTURE_NOW,
		getStats: () => null,
		backlinksOf: (path) => index.backlinksOf(path),
	};
}

describe('backlinks after an incremental update', () => {
	it('never records a note as its own backlink', () => {
		const app = buildVault([
			{ path: 'Self.md', content: '# Self\n\nSee [[Self]].' },
			{ path: 'Other.md', content: '# Other' },
		]);
		const index = indexFor(app);

		// The full rebuild discounts the self-link...
		expect(index.backlinksOf('Self.md')).toEqual([]);

		// ...and so must the per-file update the modify event triggers.
		index.updateFile(rewrite(app, 'Self.md', '# Self\n\nStill see [[Self]].'));

		expect(index.backlinksOf('Self.md')).toEqual([]);
		expect(index.get('Self.md')?.backlinks).toEqual([]);
	});

	it('leaves a self-linked note reported as an orphan after it is edited', () => {
		const app = buildVault([
			{ path: 'Self.md', content: '# Self\n\nSee [[Self]].' },
			{ path: 'Other.md', content: '# Other' },
		]);
		const index = indexFor(app);
		const before = orphanNotes.run(contextFor(index)).map((issue) => issue.path);

		index.updateFile(rewrite(app, 'Self.md', '# Self\n\nSee [[Self]] again.'));
		const after = orphanNotes.run(contextFor(index)).map((issue) => issue.path);

		expect(before.sort()).toEqual(['Other.md', 'Self.md']);
		expect(after.sort()).toEqual(before.sort());
	});

	it('still records a genuine backlink the update introduces', () => {
		const app = buildVault([
			{ path: 'Source.md', content: '# Source' },
			{ path: 'Target.md', content: '# Target' },
		]);
		const index = indexFor(app);
		expect(index.backlinksOf('Target.md')).toEqual([]);

		index.updateFile(rewrite(app, 'Source.md', '# Source\n\nSee [[Target]].'));

		expect(index.backlinksOf('Target.md')).toEqual(['Source.md']);
		expect(index.get('Target.md')?.backlinks).toEqual(['Source.md']);
	});

	it('drops a backlink once the link that made it is removed', () => {
		const app = buildVault([
			{ path: 'Source.md', content: '# Source\n\nSee [[Target]].' },
			{ path: 'Target.md', content: '# Target' },
		]);
		const index = indexFor(app);
		expect(index.backlinksOf('Target.md')).toEqual(['Source.md']);

		index.updateFile(rewrite(app, 'Source.md', '# Source\n\nNothing here now.'));

		expect(index.backlinksOf('Target.md')).toEqual([]);
		expect(index.get('Target.md')?.backlinks).toEqual([]);
	});
});
