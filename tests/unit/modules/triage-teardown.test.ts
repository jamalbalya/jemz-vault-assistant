/**
 * How a triage session ends.
 *
 * There are deliberately two ways out, and they are not interchangeable:
 *
 *  - `exit()` is the user finishing. It closes the overlay and shows the session summary,
 *    which offers to start another session over whatever is still in the inbox.
 *  - `unload()` is the plugin going away — disabled, updated, or Obsidian quitting. It has to
 *    take the overlay off `document.body` and show nothing at all: a summary raised by a
 *    plugin that no longer exists cannot do anything useful, and its "Continue triaging"
 *    button would start a session against services that are being torn down.
 *
 * The overlay lives on `document.body` rather than inside a view, so nothing else will clean
 * it up if this does not.
 */

import { afterEach, describe, expect, it } from 'vitest';
import type { App as ObsidianApp, TFile } from 'obsidian';
import { openModals } from '../../mocks/obsidian';
import { TriageMode } from '../../../src/modules/inbox/triage-mode';
import { Logger } from '../../../src/core/logger';
import type { NoteRecord } from '../../../src/types/note';
import type { App } from '../../mocks/obsidian';
import { buildVault } from '../../helpers/vault-fixture';

function recordsOf(app: App, paths: readonly string[]): NoteRecord[] {
	return paths.map((path) => {
		const file = app.vault.getFileByPath(path);
		if (!file) throw new Error(`No file at "${path}"`);
		return {
			path,
			basename: file.basename,
			extension: 'md',
			folder: '00-Inbox',
			created: file.stat.ctime,
			modified: file.stat.mtime,
			fileModified: file.stat.mtime,
			size: file.stat.size,
			frontmatter: null,
			hasFrontmatterBlock: false,
			frontmatterValid: false,
			type: 'capture',
			status: 'inbox',
			source: null,
			tags: [],
			links: [],
			resolvedLinks: [],
			unresolvedLinks: [],
			backlinks: [],
			headings: [],
			isAttachment: false,
		};
	});
}

function triageOver(paths: readonly string[]): { triage: TriageMode; app: App } {
	const app = buildVault(paths.map((path) => ({ path, content: '# Note\n\nbody' })));
	const items = recordsOf(app, paths);

	const triage = new TriageMode({
		app: app as unknown as ObsidianApp,
		inbox: { items: () => items, count: () => items.length },
		actions: {
			process: async () => undefined,
			convertToTask: async () => undefined,
			moveToFolder: async () => '',
			addTag: async () => undefined,
			linkToNote: async () => undefined,
			archive: async () => '',
			trash: async (_file: TFile) => undefined,
		},
		content: { body: async () => 'body text' },
		logger: new Logger('silent'),
	});
	return { triage, app };
}

/** Overlays currently attached to the document. */
function overlays(): number {
	return document.body.querySelectorAll('.jva-triage').length;
}

afterEach(() => {
	for (const modal of [...openModals]) modal.close();
	for (const overlay of Array.from(document.body.querySelectorAll('.jva-triage'))) {
		overlay.remove();
	}
});

describe('unloading while triage is open', () => {
	it('removes the overlay from the document', async () => {
		const { triage } = triageOver(['00-Inbox/a.md', '00-Inbox/b.md']);
		await triage.start();
		expect(overlays()).toBe(1);
		expect(triage.isOpen).toBe(true);

		triage.unload();

		expect(overlays()).toBe(0);
		expect(triage.isOpen).toBe(false);
	});

	it('shows no summary, so nothing offers to start another session', async () => {
		const { triage } = triageOver(['00-Inbox/a.md']);
		await triage.start();
		const before = openModals.length;

		triage.unload();

		expect(openModals.length).toBe(before);
	});

	it('is safe when triage was never started', () => {
		const { triage } = triageOver(['00-Inbox/a.md']);
		expect(() => triage.unload()).not.toThrow();
		expect(overlays()).toBe(0);
	});

	it('is safe to call twice', async () => {
		const { triage } = triageOver(['00-Inbox/a.md']);
		await triage.start();

		triage.unload();
		expect(() => triage.unload()).not.toThrow();
		expect(overlays()).toBe(0);
	});
});

describe('exiting a session normally', () => {
	it('closes the overlay and raises the summary', async () => {
		const { triage } = triageOver(['00-Inbox/a.md', '00-Inbox/b.md']);
		await triage.start();

		triage.exit();
		// The summary is opened from a promise continuation.
		await Promise.resolve();

		expect(overlays()).toBe(0);
		expect(openModals.length).toBe(1);
	});
});
