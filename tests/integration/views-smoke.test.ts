/**
 * Smoke tests for the views that have no dedicated unit suite yet.
 *
 * These do not attempt to cover behaviour — they prove each panel constructs, renders against
 * the real fixture vault, survives a refresh, and unmounts without leaking bus subscriptions.
 * That is the class of failure most likely to make the plugin unusable (a view that throws on
 * mount takes the whole tab with it), and it is cheap to guard.
 */

import { describe, expect, it } from 'vitest';
import type { App as ObsidianApp, Setting as ObsidianSetting } from 'obsidian';
import { HealthPanel } from '../../src/modules/health/health-view';
import { RecallPanel } from '../../src/modules/retrieval/recall-view';
import { JemzSettingTab } from '../../src/modules/settings/settings-tab';
import { TriageMode } from '../../src/modules/inbox/triage-mode';
import { WelcomeModal, maybeShowWelcome } from '../../src/modules/onboarding/welcome-modal';
import { detectJemzsync, renderSyncStatus } from '../../src/integrations/jemzsync';
import { LocalStateStore } from '../../src/core/local-state';
import { LOCAL_STATE_KEYS } from '../../src/core/constants';
import { createHarness, type Harness } from '../helpers/harness';
import { buildVault, loadVaultFromDisk } from '../helpers/vault-fixture';
import { Setting, openModals } from '../mocks/obsidian';
import { STRINGS } from '../../src/core/strings';

function container(): HTMLElement {
	const el = document.createElement('div');
	document.body.appendChild(el);
	return el;
}

async function harnessed(): Promise<Harness> {
	return createHarness(loadVaultFromDisk());
}

describe('HealthPanel', () => {
	it('mounts, refreshes and unmounts cleanly', async () => {
		const harness = await harnessed();
		const host = container();
		const before = harness.bus.listenerCount('scan-completed');

		const panel = new HealthPanel({
			app: harness.obsidianApp,
			health: harness.health,
			fixes: harness.fixes,
			safety: harness.safety,
			backup: harness.backup,
			actionLog: harness.actionLog,
			index: harness.index,
			settings: harness.settings,
			bus: harness.bus,
			logger: harness.logger,
			onOpenSettings: () => undefined,
		});

		await Promise.resolve(panel.mount(host));
		expect(host.children.length).toBeGreaterThan(0);

		await Promise.resolve(panel.refresh());
		panel.unmount();
		// Every subscription taken during mount is released again.
		expect(harness.bus.listenerCount('scan-completed')).toBe(before);
	});

	it('renders the score and category cards after a scan', async () => {
		const harness = await harnessed();
		await harness.health.runFullScan();
		const host = container();

		const panel = new HealthPanel({
			app: harness.obsidianApp,
			health: harness.health,
			fixes: harness.fixes,
			safety: harness.safety,
			backup: harness.backup,
			actionLog: harness.actionLog,
			index: harness.index,
			settings: harness.settings,
			bus: harness.bus,
			logger: harness.logger,
			onOpenSettings: () => undefined,
		});
		await Promise.resolve(panel.mount(host));

		expect(host.querySelector('.jva-score__value')?.textContent).toContain('87');
		expect(host.querySelectorAll('.jva-health-card').length).toBeGreaterThan(0);
		panel.unmount();
	});
});

describe('RecallPanel', () => {
	it('mounts, refreshes and unmounts cleanly', async () => {
		const harness = await harnessed();
		const host = container();
		const before = harness.bus.listenerCount('index-updated');

		const panel = new RecallPanel({
			app: harness.obsidianApp,
			retrieval: harness.retrieval,
			index: harness.index,
			settings: harness.settings,
			bus: harness.bus,
			logger: harness.logger,
		});

		await Promise.resolve(panel.mount(host));
		expect(host.querySelectorAll('.jva-saved-view').length).toBeGreaterThan(0);

		await Promise.resolve(panel.refresh());
		panel.unmount();
		expect(harness.bus.listenerCount('index-updated')).toBe(before);
	});
});

describe('JemzSettingTab', () => {
	it('renders every section without throwing', async () => {
		const harness = await harnessed();
		const tab = new JemzSettingTab(
			harness.obsidianApp,
			{ manifest: { version: '1.0.0', id: 'jemz-vault-assistant' } } as never,
			{
				settings: harness.settings,
				health: harness.health,
				actionLog: harness.actionLog,
				analytics: harness.analytics,
				backup: harness.backup,
				logger: harness.logger,
			},
		);

		// Since 1.13 the tab is data, so "renders without throwing" means the definitions build
		// against the real services and every custom row draws itself. Both are exercised here:
		// a section that threw would surface as the single error row the tab falls back to.
		const items = tab.getSettingDefinitions();
		const leaves = items.flatMap((item) =>
			'type' in item ? (item.type === 'page' ? [] : (item.items ?? [])) : [item],
		);
		expect(leaves.length).toBeGreaterThan(20);
		expect(leaves.some((def) => def.name === STRINGS.errors.unexpected)).toBe(false);

		const disposers: (() => void)[] = [];
		for (const def of leaves) {
			if (!('render' in def) || def.render === undefined) continue;
			const setting = new Setting(document.createElement('div'));
			const dispose = def.render(setting as unknown as ObsidianSetting, undefined as never);
			if (dispose) disposers.push(dispose);
		}
		// Every control answers with a stored value rather than undefined.
		for (const def of leaves) {
			if (!('control' in def) || def.control === undefined) continue;
			expect(tab.getControlValue(def.control.key), def.control.key).toBeDefined();
		}

		for (const dispose of disposers) dispose();
		tab.hide();
		expect(tab.containerEl.children.length).toBe(0);
	});
});

describe('TriageMode', () => {
	it('refuses to open on an empty inbox', async () => {
		// A vault whose only note is already processed: membership is status-first, so
		// repointing the inbox folder would not be enough to empty it.
		const harness = await createHarness(
			buildVault([
				{
					path: 'Notes/done.md',
					frontmatter: { created: '2026-06-01', type: 'note', status: 'processed' },
					content: '# Done\n',
				},
			]),
		);
		expect(harness.inbox.count()).toBe(0);

		const triage = new TriageMode({
			app: harness.obsidianApp,
			inbox: harness.inbox,
			actions: harness.inbox,
			content: harness.content,
			logger: harness.logger,
		});

		await triage.start();
		expect(triage.isOpen).toBe(false);
	});

	it('opens on the first item and closes on exit', async () => {
		const harness = await harnessed();
		const triage = new TriageMode({
			app: harness.obsidianApp,
			inbox: harness.inbox,
			actions: harness.inbox,
			content: harness.content,
			logger: harness.logger,
		});

		await triage.start();
		expect(triage.isOpen).toBe(true);
		expect(document.querySelector('.jva-triage__progress')?.textContent).toContain('1');

		triage.exit();
		expect(triage.isOpen).toBe(false);
		expect(document.querySelector('.jva-triage')).toBeNull();
	});
});

describe('welcome modal', () => {
	it('shows once and never again on the same device', async () => {
		const harness = await harnessed();
		const localState = new LocalStateStore(harness.obsidianApp, harness.logger);
		const deps = {
			app: harness.obsidianApp,
			settings: harness.settings,
			localState,
			logger: harness.logger,
			onOpenDashboard: () => undefined,
		};

		expect(maybeShowWelcome(deps)).toBe(true);
		expect(openModals).toHaveLength(1);

		openModals[0]?.close();
		expect(localState.get(LOCAL_STATE_KEYS.firstRunCompleted, false)).toBe(true);
		expect(maybeShowWelcome(deps)).toBe(false);
	});

	it('creates the default folders only when asked', async () => {
		const harness = await createHarness(loadVaultFromDisk(), {
			settings: (settings) => {
				settings.capture.inboxFolder = 'Fresh Inbox';
				settings.capture.archiveFolder = 'Fresh Archive';
			},
		});
		const localState = new LocalStateStore(harness.obsidianApp, harness.logger);

		const modal = new WelcomeModal({
			app: harness.obsidianApp,
			settings: harness.settings,
			localState,
			logger: harness.logger,
			onOpenDashboard: () => undefined,
		});
		modal.open();

		// Opening alone must never touch the vault.
		expect(harness.app.vault.getFolderByPath('Fresh Inbox')).toBeNull();

		const createButton = Array.from(
			modal.contentEl.querySelectorAll<HTMLButtonElement>('button'),
		).find((button) => button.textContent?.includes('Create folders'));
		expect(createButton).toBeDefined();

		createButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(harness.app.vault.getFolderByPath('Fresh Inbox')).not.toBeNull();
		expect(harness.app.vault.getFolderByPath('Fresh Archive')).not.toBeNull();
		modal.close();
	});
});

describe('jemzsync integration', () => {
	it('returns null when the sibling plugin is absent', async () => {
		const harness = await harnessed();
		expect(detectJemzsync(harness.obsidianApp)).toBeNull();
	});

	it('returns null when the plugin registry is malformed or throws', () => {
		expect(detectJemzsync({} as ObsidianApp)).toBeNull();
		expect(detectJemzsync({ plugins: 'nonsense' } as unknown as ObsidianApp)).toBeNull();
		expect(
			detectJemzsync({ plugins: { plugins: { jemzsync: null } } } as unknown as ObsidianApp),
		).toBeNull();

		const hostile = {} as Record<string, unknown>;
		Object.defineProperty(hostile, 'plugins', {
			get() {
				throw new Error('boom');
			},
		});
		expect(detectJemzsync(hostile as unknown as ObsidianApp)).toBeNull();
	});

	it('reads the version and enabled state when present', () => {
		const app = {
			plugins: {
				plugins: { jemzsync: { manifest: { id: 'jemzsync', version: '2.1.0' } } },
				enabledPlugins: new Set(['jemzsync']),
			},
		} as unknown as ObsidianApp;

		expect(detectJemzsync(app)).toEqual({
			id: 'jemzsync',
			version: '2.1.0',
			enabled: true,
		});
	});

	it('renders nothing at all when the plugin is absent', () => {
		const host = container();
		renderSyncStatus(host, null);
		expect(host.children.length).toBe(0);

		renderSyncStatus(host, { id: 'jemzsync', version: '2.1.0', enabled: true });
		expect(host.querySelector('.jva-sync-chip')).not.toBeNull();
	});
});
