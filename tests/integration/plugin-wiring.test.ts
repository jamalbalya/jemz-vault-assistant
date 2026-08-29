/**
 * What `main.ts` wires together.
 *
 * The entry point is deliberately thin, and everything it constructs is covered elsewhere —
 * which left the wiring itself as the one untested surface in the plugin. That is exactly
 * where a certain kind of defect hides: every part works, the object graph type-checks, and
 * an optional dependency is quietly never passed. Nothing fails; a feature is simply absent.
 *
 * So these tests drive the real `Plugin` subclass against the in-memory vault and assert the
 * connections rather than the behaviour behind them.
 */

import { describe, expect, it } from 'vitest';
import type { App as ObsidianApp } from 'obsidian';
import JemzVaultAssistantPlugin from '../../src/main';
import { COMMAND_IDS, VIEW_TYPE_DASHBOARD } from '../../src/core/constants';
import { App, Plugin as MockPlugin, openModals, type PluginManifest } from '../mocks/obsidian';
import { buildVault } from '../helpers/vault-fixture';

const MANIFEST: PluginManifest = {
	id: 'jemz-vault-assistant',
	name: 'Jemz Vault Assistant',
	version: '1.1.0',
	minAppVersion: '1.13.0',
	author: 'Jamal Balya',
	description: 'test',
};

/** A vault with a couple of inbox notes and a spread of tags. */
function vault(): App {
	return buildVault([
		{
			path: '00-Inbox/first.md',
			frontmatter: { status: 'inbox', type: 'capture', tags: ['alpha', 'alpha-common'] },
			content: 'First capture.',
		},
		{
			path: '00-Inbox/second.md',
			frontmatter: { status: 'inbox', type: 'capture', tags: ['alpha-common'] },
			content: 'Second capture.',
		},
		{
			path: 'notes/third.md',
			frontmatter: { type: 'note', tags: ['alpha-common', 'beta'] },
			content: 'A note.',
		},
	]);
}

async function loadPlugin(app: App = vault()): Promise<{
	plugin: JemzVaultAssistantPlugin;
	app: App;
}> {
	const plugin = new JemzVaultAssistantPlugin(app as unknown as ObsidianApp, MANIFEST);
	await plugin.onload();
	// The index is built on layout-ready, which the mock runs synchronously.
	await Promise.resolve();
	return { plugin, app };
}

/**
 * The plugin as the mock host sees it.
 *
 * `tsc` types the plugin against the real Obsidian declarations, which carry no record of
 * what was registered; the mock's do. The cast bridges the two declaration files, exactly as
 * the `App` casts elsewhere in the suite.
 */
function host(plugin: JemzVaultAssistantPlugin): MockPlugin {
	return plugin as unknown as MockPlugin;
}

/** Reach a private field without loosening the plugin's own types. */
function inside<T>(plugin: JemzVaultAssistantPlugin, key: string): T {
	return (plugin as unknown as Record<string, T>)[key] as T;
}

describe('what onload registers', () => {
	it('registers every command the plugin advertises', async () => {
		const { plugin } = await loadPlugin();
		const ids = Array.from(host(plugin).commands.keys()).map((id) => id.split(':')[1]);

		for (const id of Object.values(COMMAND_IDS)) {
			expect(ids, `command "${id}" is not registered`).toContain(id);
		}
		plugin.unload();
	});

	it('registers the dashboard view and a ribbon icon', async () => {
		const { plugin, app } = await loadPlugin();

		expect(app.workspace.viewFactories.has(VIEW_TYPE_DASHBOARD)).toBe(true);
		expect(host(plugin).ribbonIcons.length).toBe(1);
		expect(host(plugin).settingTab).not.toBeNull();
		plugin.unload();
	});
});

describe('the tag prompt suggestions', () => {
	it('reach triage as well as the inbox list', async () => {
		// The identical prompt appears in both places; triage is where the tags are actually
		// typed, so an unwired suggestion source there is the one that matters.
		const { plugin } = await loadPlugin();
		const triage = inside<{ tagSuggestions?: (() => readonly string[]) | null }>(
			plugin,
			'triage',
		);

		const suggestions = triage.tagSuggestions?.() ?? [];
		expect(suggestions.length).toBeGreaterThan(0);
		expect(suggestions).toContain('alpha-common');
		plugin.unload();
	});

	it('arrive most-used first, so a busy tag cannot fall off the end', async () => {
		const { plugin } = await loadPlugin();
		const triage = inside<{ tagSuggestions?: (() => readonly string[]) | null }>(
			plugin,
			'triage',
		);

		const suggestions = triage.tagSuggestions?.() ?? [];
		// `alpha-common` is on three notes; the others are on one each.
		expect(suggestions[0]).toBe('alpha-common');
		plugin.unload();
	});
});

describe('unloading', () => {
	it('takes an open triage overlay off the document without a summary', async () => {
		const { plugin } = await loadPlugin();
		await plugin.startTriage();
		expect(document.body.querySelectorAll('.jva-triage').length).toBe(1);
		const modalsBefore = openModals.length;

		plugin.unload();

		expect(document.body.querySelectorAll('.jva-triage').length).toBe(0);
		expect(openModals.length).toBe(modalsBefore);
	});

	it('is safe when triage was never opened', async () => {
		const { plugin } = await loadPlugin();
		expect(() => plugin.unload()).not.toThrow();
	});
});
