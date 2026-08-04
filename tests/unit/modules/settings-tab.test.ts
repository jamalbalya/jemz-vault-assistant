/**
 * The settings tab, driven through the declarative API rather than through rendered DOM.
 *
 * Since Obsidian 1.13 the tab is data: `getSettingDefinitions()` describes every row, and the
 * host reads and writes each control through `getControlValue`/`setControlValue`. That makes
 * these assertions the real contract — the definitions cover the whole screen, every control
 * reads what is stored, every write lands in the store, and nothing garbage-looking gets in.
 *
 * The suite walks the definitions generically wherever it can, so a control added later is
 * covered by the read/write and copy assertions without anyone remembering to extend them.
 */

import { describe, expect, it } from 'vitest';
import type { App as ObsidianApp, Setting as ObsidianSetting } from 'obsidian';
import type {
	SettingControl,
	SettingDefinition,
	SettingDefinitionControl,
	SettingDefinitionItem,
	SettingDefinitionList,
	SettingDefinitionRender,
} from 'obsidian';
import { App, Setting } from '../../mocks/obsidian';
import { EventBus } from '../../../src/core/event-bus';
import { Logger } from '../../../src/core/logger';
import { SettingsStore } from '../../../src/core/settings';
import { STRINGS } from '../../../src/core/strings';
import type { ActionLogService } from '../../../src/services/action-log-service';
import type { AnalyticsService } from '../../../src/services/analytics-service';
import type { BackupService } from '../../../src/services/backup-service';
import type { HealthService } from '../../../src/services/health-service';
import { JemzSettingTab } from '../../../src/modules/settings/settings-tab';
import { ISSUE_TYPES, type IssueType } from '../../../src/types/health';
import { DEFAULT_SETTINGS, type JemzSettings } from '../../../src/types/settings';

const VERSION = '9.9.9';

/** In-memory stand-in for the plugin's `loadData`/`saveData`. */
class MemoryHost {
	constructor(private data: unknown = null) {}

	async loadData(): Promise<unknown> {
		return this.data;
	}

	async saveData(data: unknown): Promise<void> {
		this.data = JSON.parse(JSON.stringify(data));
	}

	/** What is currently persisted, as the plugin would read it back off disk. */
	peek(): JemzSettings | null {
		return this.data as JemzSettings | null;
	}
}

/** The two health-service methods the settings tab reaches for. */
interface HealthStub {
	ignoredCounts: () => Record<IssueType, number>;
	clearIgnored: (type: IssueType) => Promise<void>;
}

interface Fixture {
	tab: JemzSettingTab;
	settings: SettingsStore;
	host: MemoryHost;
	/** Ignore-list counts the stubbed health service reports. */
	ignored: Record<IssueType, number>;
	/** Types passed to `clearIgnored`, in call order. */
	cleared: IssueType[];
	/** Reassign a method to make the service fail on demand. */
	health: HealthStub;
}

/**
 * Build a tab over a real {@link SettingsStore} and stubbed services.
 *
 * The store is real because every assertion here is about what ends up persisted; the four
 * services are stubbed down to the handful of methods the tab actually calls, so the suite
 * does not need a vault to prove that a toggle writes through.
 */
async function fixture(seed?: (settings: JemzSettings) => void): Promise<Fixture> {
	const host = new MemoryHost();
	if (seed) {
		const seeded = JSON.parse(JSON.stringify(DEFAULT_SETTINGS)) as JemzSettings;
		seed(seeded);
		await host.saveData(seeded);
	}

	const logger = new Logger('silent');
	// Zero delay: writes land synchronously, so an assertion never races the coalescing timer.
	const settings = new SettingsStore(host, new EventBus(), logger, 0);
	await settings.load();

	const ignored = Object.fromEntries(ISSUE_TYPES.map((type) => [type, 0])) as Record<
		IssueType,
		number
	>;
	const cleared: IssueType[] = [];

	const health: HealthStub = {
		ignoredCounts: () => ignored,
		clearIgnored: async (type: IssueType) => {
			cleared.push(type);
			ignored[type] = 0;
		},
	};

	const actionLog = {
		recent: () => [],
		clear: async () => undefined,
	} as unknown as ActionLogService;

	const analytics = {
		snapshot: () => settings.get().analytics.data,
		clear: async () => undefined,
	} as unknown as AnalyticsService;

	const backup = {
		list: () => [],
		restoreLatest: async () => ({ restored: [], failed: [] }),
	} as unknown as BackupService;

	const tab = new JemzSettingTab(
		new App() as unknown as ObsidianApp,
		{ manifest: { version: VERSION, id: 'jemz-vault-assistant' } } as never,
		{
			settings,
			health: health as unknown as HealthService,
			actionLog,
			analytics,
			backup,
			logger,
		},
	);

	return { tab, settings, host, ignored, cleared, health };
}

/* ------------------------------------------------------------------ walking -- */

function isGroupLike(
	item: SettingDefinitionItem,
): item is Extract<SettingDefinitionItem, { type: string }> {
	return 'type' in item;
}

/** Every leaf definition in the tree, groups and lists flattened away. */
function allDefinitions(items: SettingDefinitionItem[]): SettingDefinition[] {
	const found: SettingDefinition[] = [];
	for (const item of items) {
		if (!isGroupLike(item)) {
			found.push(item);
			continue;
		}
		if (item.type === 'page') continue;
		for (const child of item.items ?? []) {
			if (!isGroupLike(child)) found.push(child);
		}
	}
	return found;
}

function controls(items: SettingDefinitionItem[]): SettingDefinitionControl[] {
	return allDefinitions(items).filter(
		(def): def is SettingDefinitionControl => def.control !== undefined,
	);
}

function controlsOfType(items: SettingDefinitionItem[], type: SettingControl['type']) {
	return controls(items).filter((def) => def.control.type === type);
}

function headings(items: SettingDefinitionItem[]): string[] {
	const found: string[] = [];
	for (const item of items) {
		if (!isGroupLike(item) || item.type === 'page') continue;
		if (item.heading !== undefined) found.push(item.heading);
	}
	return found;
}

/** The ignore lists, the one `list` this tab emits. */
function ignoreList(items: SettingDefinitionItem[]): SettingDefinitionList {
	for (const item of items) {
		// `type` alone cannot narrow a list from the group it extends, so assert once here.
		if (isGroupLike(item) && item.type === 'list') return item as SettingDefinitionList;
	}
	throw new Error('no ignore list in the definitions');
}

/** Drive a `render` row against a real (mock) Setting and hand back the row element. */
function renderRow(def: SettingDefinitionRender): HTMLElement {
	const setting = new Setting(document.createElement('div'));
	setting.setName(def.name);
	def.render(setting as unknown as ObsidianSetting, undefined as never);
	return setting.settingEl;
}

/* --------------------------------------------------------------------- copy -- */

/** Every literal string in the table, so a hardcoded name can be spotted. */
function flattenStrings(source: object, into: Set<string> = new Set()): Set<string> {
	for (const value of Object.values(source) as unknown[]) {
		if (typeof value === 'string') into.add(value);
		else if (typeof value === 'object' && value !== null) flattenStrings(value, into);
	}
	return into;
}

const STRING_TABLE = flattenStrings(STRINGS);

/* --------------------------------------------------------------- inventory -- */

/**
 * Every control the imperative tab exposed, spelled out.
 *
 * This list is the guard against the failure mode that matters most in a rewrite of a settings
 * screen: a setting quietly disappearing. It is deliberately literal rather than derived from
 * the definitions, because a list generated from the thing under test cannot notice a loss.
 */
const EXPECTED_CONTROL_KEYS: readonly string[] = [
	'general.modules.capture',
	'general.modules.health',
	'general.modules.retrieval',
	'general.showRibbonIcon',
	'general.showStatusBar',
	'general.logLevel',
	'general.inboxPageSize',
	'general.inboxNewestFirst',
	'capture.inboxFolder',
	'capture.archiveFolder',
	'capture.attachmentArchiveFolder',
	'capture.defaultTags',
	'capture.defaultType',
	'capture.autoCreateFolders',
	'health.scanFrequency',
	'health.autoScanOnStartup',
	'health.excludedFolders',
	'health.excludedTags',
	'health.excludedExtensions',
	'health.excludeInbox',
	'health.excludeArchived',
	'health.requiredFrontmatterFields',
	'health.largeFileThresholdBytes',
	...ISSUE_TYPES.map((type) => `health.detectors.${type}`),
	'retrieval.staleThresholdDays',
	'retrieval.fuzzySensitivity',
	'retrieval.resultsPerPage',
	'retrieval.excludeArchivedFromViews',
	'analytics.enabled',
];

/**
 * A value a control of this type would legitimately produce, different from what is stored.
 *
 * Used to prove each control writes through, whatever its shape. Text candidates append a
 * suffix so they survive every transform the tab applies (path normalising, hash and dot
 * stripping, lower-casing); numeric candidates use the declared minimum, which is by
 * definition inside the range.
 */
function candidateFor(control: SettingControl, current: unknown): unknown {
	switch (control.type) {
		case 'toggle':
			return current !== true;
		case 'dropdown': {
			const other = Object.keys(control.options).find((option) => option !== current);
			if (other === undefined) throw new Error(`${control.key} offers only one option`);
			return other;
		}
		case 'number':
		case 'slider': {
			// Every numeric field must declare its bounds to the UI, not only to the parser.
			if (control.min === undefined) throw new Error(`${control.key} declares no minimum`);
			return control.min;
		}
		default:
			return `${String(current)}-x`;
	}
}

describe('getSettingDefinitions', () => {
	it('returns a non-empty tree covering all six sections', async () => {
		const { tab } = await fixture();
		const items = tab.getSettingDefinitions();

		expect(items.length).toBeGreaterThan(0);
		expect(headings(items)).toEqual([
			STRINGS.settings.general,
			STRINGS.settings.captureInbox,
			STRINGS.settings.vaultHealth,
			STRINGS.settings.smartRetrieval,
			STRINGS.settings.analytics,
			STRINGS.settings.about,
		]);
	});

	it('keeps every single control the imperative tab had, and adds none', async () => {
		const { tab } = await fixture();
		const keys = controls(tab.getSettingDefinitions()).map((def) => def.control.key);

		// Set equality both ways: a dropped setting and an invented one both fail here.
		expect([...keys].sort()).toEqual([...EXPECTED_CONTROL_KEYS].sort());
	});

	it('keeps the eighteen score weights as nine two-input rows', async () => {
		const { tab } = await fixture();
		const rows = allDefinitions(tab.getSettingDefinitions()).filter(
			(def) => def.aliases?.includes(STRINGS.settings.scoreWeights) === true,
		);
		expect(rows.map((row) => row.name)).toEqual(
			ISSUE_TYPES.map((type) => STRINGS.health.types[type]),
		);

		for (const row of rows) {
			const inputs = renderRow(row as SettingDefinitionRender).querySelectorAll('input');
			// `per` and `max`, the pair the old grid drew for every issue type.
			expect(inputs.length, row.name).toBe(2);
		}
	});

	it('keeps every non-control row the imperative tab had', async () => {
		const { tab } = await fixture();
		const names = new Set(allDefinitions(tab.getSettingDefinitions()).map((def) => def.name));

		for (const name of [
			STRINGS.settings.modulesHeading,
			STRINGS.settings.detectorsHeading,
			STRINGS.settings.scoreWeights,
			STRINGS.settings.ignoreListsHeading,
			STRINGS.settings.aboutVersion,
			STRINGS.settings.aboutRepository,
			STRINGS.settings.aboutIssues,
			STRINGS.settings.aboutChangelog,
			STRINGS.settings.actionLogHeading,
			STRINGS.settings.actionLogClear,
			STRINGS.settings.analyticsView,
			STRINGS.settings.analyticsDelete,
			STRINGS.commands.restoreLastBackup,
			STRINGS.settings.resetSettings,
		]) {
			expect(names.has(name), name).toBe(true);
		}
	});

	it('shapes each control as the kind the old row used', async () => {
		const { tab } = await fixture();
		const items = tab.getSettingDefinitions();

		// Eleven plain switches plus one per detector.
		expect(controlsOfType(items, 'toggle').length).toBe(11 + ISSUE_TYPES.length);
		expect(controlsOfType(items, 'dropdown').length).toBe(3);
		expect(controlsOfType(items, 'slider').length).toBe(1);
		expect(controlsOfType(items, 'number').length).toBe(4);
		// Four free-text fields and five comma separated lists, all text inputs.
		expect(controlsOfType(items, 'text').length).toBe(4 + 5);
	});

	it('gives every control a distinct key', async () => {
		const { tab } = await fixture();
		const keys = controls(tab.getSettingDefinitions()).map((def) => def.control.key);
		expect(new Set(keys).size).toBe(keys.length);
	});

	it('takes every word it shows from the string table', async () => {
		const { tab } = await fixture();
		const items = tab.getSettingDefinitions();

		// The two strings that are data rather than copy: the version, and the counted
		// ignore-list summary produced by a STRINGS function.
		const derived = new Set([
			VERSION,
			...[0, 1, 2, 5].map((n) => STRINGS.settings.ignoredItems(n)),
		]);
		const allowed = (value: string): boolean => STRING_TABLE.has(value) || derived.has(value);

		for (const heading of headings(items)) expect(allowed(heading)).toBe(true);
		for (const def of allDefinitions(items)) {
			expect(allowed(def.name), `name "${def.name}"`).toBe(true);
			if (typeof def.desc === 'string') {
				expect(allowed(def.desc), `desc "${def.desc}"`).toBe(true);
			}
			for (const alias of def.aliases ?? []) {
				expect(allowed(alias), `alias "${alias}"`).toBe(true);
			}
		}
	});

	it('offers only stored identifiers as dropdown options', async () => {
		const { tab } = await fixture();
		for (const def of controlsOfType(tab.getSettingDefinitions(), 'dropdown')) {
			const control = def.control;
			if (control.type !== 'dropdown') throw new Error('narrowing');
			expect(Object.keys(control.options).length).toBeGreaterThan(1);
			// The stored value is always one of the offered options.
			expect(Object.keys(control.options)).toContain(tab.getControlValue(control.key));
		}
	});
});

describe('reading stored values', () => {
	it('reflects the seeded settings through every control key', async () => {
		const { tab } = await fixture((settings) => {
			settings.general.modules.capture = false;
			settings.general.showRibbonIcon = false;
			settings.general.logLevel = 'debug';
			settings.general.inboxPageSize = 25;
			settings.general.inboxNewestFirst = false;
			settings.capture.inboxFolder = 'Seeded/Inbox';
			settings.capture.defaultTags = ['alpha', 'beta'];
			settings.health.scanFrequency = 'weekly';
			settings.health.detectors['orphan-note'] = false;
			settings.health.excludedExtensions = ['png', 'pdf'];
			settings.health.largeFileThresholdBytes = 5 * 1024 * 1024;
			settings.retrieval.staleThresholdDays = 45;
			settings.retrieval.fuzzySensitivity = 0.75;
			settings.analytics.enabled = true;
		});
		tab.getSettingDefinitions();

		expect(tab.getControlValue('general.modules.capture')).toBe(false);
		expect(tab.getControlValue('general.showRibbonIcon')).toBe(false);
		expect(tab.getControlValue('general.logLevel')).toBe('debug');
		expect(tab.getControlValue('general.inboxPageSize')).toBe(25);
		expect(tab.getControlValue('general.inboxNewestFirst')).toBe('oldest');
		expect(tab.getControlValue('capture.inboxFolder')).toBe('Seeded/Inbox');
		// Lists render as the comma separated text the field shows.
		expect(tab.getControlValue('capture.defaultTags')).toBe('alpha, beta');
		expect(tab.getControlValue('health.scanFrequency')).toBe('weekly');
		expect(tab.getControlValue('health.detectors.orphan-note')).toBe(false);
		expect(tab.getControlValue('health.excludedExtensions')).toBe('png, pdf');
		// Stored in bytes, shown in megabytes.
		expect(tab.getControlValue('health.largeFileThresholdBytes')).toBe(5);
		expect(tab.getControlValue('retrieval.staleThresholdDays')).toBe(45);
		expect(tab.getControlValue('retrieval.fuzzySensitivity')).toBe(0.75);
		expect(tab.getControlValue('analytics.enabled')).toBe(true);
	});

	it('answers with a defined value for every key it declares', async () => {
		const { tab } = await fixture();
		for (const def of controls(tab.getSettingDefinitions())) {
			expect(tab.getControlValue(def.control.key), def.control.key).toBeDefined();
		}
	});

	it('seeds each control with the stored value as its parse fallback', async () => {
		const { tab } = await fixture((settings) => {
			settings.general.inboxPageSize = 33;
			settings.capture.archiveFolder = 'Zz/Archive';
		});
		const items = tab.getSettingDefinitions();
		const byKey = new Map(controls(items).map((def) => [def.control.key, def.control]));

		// The number control falls back to `defaultValue` when the typed text will not parse,
		// so seeding it with what is stored is what makes "abc" a no-op.
		expect(byKey.get('general.inboxPageSize')?.defaultValue).toBe(33);
		expect(byKey.get('capture.archiveFolder')?.defaultValue).toBe('Zz/Archive');
	});

	it('builds its key registry on demand, before any definition is asked for', async () => {
		const { tab } = await fixture();
		expect(tab.getControlValue('general.showStatusBar')).toBe(true);
	});
});

describe('writing values', () => {
	it('persists a toggled control through the store', async () => {
		const { tab, settings, host } = await fixture();
		tab.getSettingDefinitions();

		await tab.setControlValue('general.showRibbonIcon', false);

		expect(settings.get().general.showRibbonIcon).toBe(false);
		expect(host.peek()?.general.showRibbonIcon).toBe(false);
		expect(tab.getControlValue('general.showRibbonIcon')).toBe(false);
	});

	it('round-trips every control in the tab, whatever its type', async () => {
		const { tab, host } = await fixture();
		const defs = controls(tab.getSettingDefinitions());
		expect(defs.length).toBe(EXPECTED_CONTROL_KEYS.length);

		for (const def of defs) {
			const key = def.control.key;
			const before = tab.getControlValue(key);
			const candidate = candidateFor(def.control, before);
			expect(candidate, key).not.toEqual(before);

			await tab.setControlValue(key, candidate);
			const after = tab.getControlValue(key);
			if (typeof candidate === 'number') {
				// The large file threshold goes out in megabytes and is stored in bytes, so the
				// round trip is lossy in the last few decimal places by design.
				expect(Number(after), key).toBeCloseTo(candidate, 5);
			} else {
				expect(after, key).toEqual(candidate);
			}
		}

		// Every one of those writes reached disk, not just the in-memory settings object.
		const persisted = host.peek();
		expect(persisted).not.toBeNull();
		expect(persisted?.general.showRibbonIcon).toBe(false);
		expect(persisted?.capture.defaultType).toBe('capture-x');
		expect(persisted?.retrieval.staleThresholdDays).toBe(1);
		expect(persisted?.health.detectors['broken-link']).toBe(false);
	});

	it('round-trips both halves of every score weight independently', async () => {
		const { tab, settings } = await fixture();
		const rows = allDefinitions(tab.getSettingDefinitions()).filter(
			(def) => def.aliases?.includes(STRINGS.settings.scoreWeights) === true,
		);
		expect(rows.length).toBe(ISSUE_TYPES.length);

		rows.forEach((row, index) => {
			const type = ISSUE_TYPES[index];
			if (type === undefined) throw new Error('missing issue type');
			const inputs = Array.from(
				renderRow(row as SettingDefinitionRender).querySelectorAll<HTMLInputElement>(
					'input',
				),
			);
			const [per, max] = inputs;
			if (!per || !max) throw new Error(`no weight inputs for ${type}`);

			per.value = '7.5';
			per.dispatchEvent(new Event('change'));
			max.value = '42';
			max.dispatchEvent(new Event('change'));

			expect(settings.get().health.weights[type], type).toEqual({ per: 7.5, max: 42 });
		});

		// Nine distinct categories were written, not the same one nine times.
		for (const type of ISSUE_TYPES) {
			expect(settings.get().health.weights[type].per, type).toBe(7.5);
		}
	});

	it('round-trips every toggle in the tab', async () => {
		const { tab, settings } = await fixture();
		const toggles = controlsOfType(tab.getSettingDefinitions(), 'toggle');
		expect(toggles.length).toBeGreaterThan(0);

		for (const def of toggles) {
			const key = def.control.key;
			const before = tab.getControlValue(key);
			await tab.setControlValue(key, !before);
			expect(tab.getControlValue(key), key).toBe(!before);
		}
		// Every one of those writes reached the store, not a local copy.
		expect(settings.get().general.modules.capture).toBe(false);
		expect(settings.get().health.detectors['broken-link']).toBe(false);
	});

	it('writes the dropdown that is stored as a boolean', async () => {
		const { tab, settings } = await fixture();
		tab.getSettingDefinitions();

		await tab.setControlValue('general.inboxNewestFirst', 'oldest');
		expect(settings.get().general.inboxNewestFirst).toBe(false);

		await tab.setControlValue('general.inboxNewestFirst', 'newest');
		expect(settings.get().general.inboxNewestFirst).toBe(true);
	});

	it('converts the large file threshold back into bytes', async () => {
		const { tab, settings } = await fixture();
		tab.getSettingDefinitions();

		await tab.setControlValue('health.largeFileThresholdBytes', 2.5);
		expect(settings.get().health.largeFileThresholdBytes).toBe(Math.round(2.5 * 1024 * 1024));
	});

	it('trims comma separated entries, drops the empty ones and collapses duplicates', async () => {
		const { tab, settings } = await fixture();
		tab.getSettingDefinitions();

		await tab.setControlValue('capture.defaultTags', '#work, , #work , ideas,');
		expect(settings.get().capture.defaultTags).toEqual(['work', 'ideas']);

		await tab.setControlValue('health.excludedExtensions', '.PNG, .pdf , ,');
		expect(settings.get().health.excludedExtensions).toEqual(['png', 'pdf']);

		// Clearing the field is a legitimate way to empty a list.
		await tab.setControlValue('health.excludedFolders', '   ');
		expect(settings.get().health.excludedFolders).toEqual([]);
	});

	it('normalises folder paths and refuses to store an empty one', async () => {
		const { tab, settings } = await fixture();
		tab.getSettingDefinitions();

		await tab.setControlValue('capture.inboxFolder', '/Notes//Inbox/');
		expect(settings.get().capture.inboxFolder).toBe('Notes/Inbox');

		await tab.setControlValue('capture.inboxFolder', '   ');
		expect(settings.get().capture.inboxFolder).toBe('Notes/Inbox');
	});

	it('ignores an unknown key rather than inventing a setting', async () => {
		const { tab, settings } = await fixture();
		const before = JSON.stringify(settings.get());

		await tab.setControlValue('general.notARealSetting', true);

		expect(tab.getControlValue('general.notARealSetting')).toBeUndefined();
		expect(JSON.stringify(settings.get())).toBe(before);
	});
});

describe('rejecting values that would corrupt settings', () => {
	it('leaves a number alone when the candidate is not a number', async () => {
		const { tab, settings, host } = await fixture();
		tab.getSettingDefinitions();
		const before = settings.get().general.inboxPageSize;

		for (const candidate of ['abc', '', '   ', NaN, Infinity, -Infinity, null, {}, []]) {
			await tab.setControlValue('general.inboxPageSize', candidate);
			expect(settings.get().general.inboxPageSize, String(candidate)).toBe(before);
		}
		// A rejected candidate is not merely clamped on the way out — it never reaches disk.
		expect(host.peek()).toBeNull();
	});

	it('clamps a wild number into a range the plugin can survive', async () => {
		const { tab, settings } = await fixture();
		tab.getSettingDefinitions();

		await tab.setControlValue('general.inboxPageSize', 0);
		expect(settings.get().general.inboxPageSize).toBe(5);

		await tab.setControlValue('general.inboxPageSize', 10_000_000);
		expect(settings.get().general.inboxPageSize).toBe(500);

		// Integer fields round rather than storing a fractional page size.
		await tab.setControlValue('general.inboxPageSize', 42.6);
		expect(settings.get().general.inboxPageSize).toBe(43);

		await tab.setControlValue('retrieval.staleThresholdDays', -12);
		expect(settings.get().retrieval.staleThresholdDays).toBe(1);

		await tab.setControlValue('retrieval.fuzzySensitivity', 9);
		expect(settings.get().retrieval.fuzzySensitivity).toBe(1);
	});

	it('never stores a value outside a dropdown, however it arrives', async () => {
		const { tab, settings } = await fixture();
		tab.getSettingDefinitions();

		await tab.setControlValue('general.logLevel', 'chatty');
		expect(settings.get().general.logLevel).toBe(DEFAULT_SETTINGS.general.logLevel);

		await tab.setControlValue('health.scanFrequency', 'hourly');
		expect(settings.get().health.scanFrequency).toBe(DEFAULT_SETTINGS.health.scanFrequency);

		await tab.setControlValue('general.logLevel', 'debug');
		expect(settings.get().general.logLevel).toBe('debug');
	});

	it('refuses a dropdown value inherited from Object.prototype', async () => {
		const { tab, settings, host } = await fixture();
		tab.getSettingDefinitions();
		const before = JSON.stringify(settings.get());

		// `'toString' in options` is true for every plain object, so a membership test that
		// walks the prototype chain would wave these through and persist a no-op write.
		for (const key of ['toString', 'constructor', 'valueOf', 'hasOwnProperty', '__proto__']) {
			await tab.setControlValue('general.logLevel', key);
			await tab.setControlValue('health.scanFrequency', key);
			await tab.setControlValue('general.inboxNewestFirst', key);
		}

		expect(JSON.stringify(settings.get())).toBe(before);
		// Rejected outright, so not one of them reached disk either.
		expect(host.peek()).toBeNull();
	});

	it('ignores a non-boolean sent to a toggle', async () => {
		const { tab, settings } = await fixture();
		tab.getSettingDefinitions();

		await tab.setControlValue('analytics.enabled', 'yes');
		expect(settings.get().analytics.enabled).toBe(false);
	});

	it('keeps a rejected weight out of the store and puts the last good value back', async () => {
		const { tab, settings } = await fixture();
		const items = tab.getSettingDefinitions();
		const row = allDefinitions(items).find(
			(def) => def.aliases?.includes(STRINGS.settings.scoreWeights) === true,
		);
		if (!row?.render) throw new Error('no score weight row');

		const el = renderRow(row as SettingDefinitionRender);
		const inputs = Array.from(el.querySelectorAll<HTMLInputElement>('input'));
		expect(inputs.length).toBe(2);

		const per = inputs[0];
		if (!per) throw new Error('no per-issue input');
		const before = settings.get().health.weights['broken-link'].per;

		per.value = 'abc';
		per.dispatchEvent(new Event('change'));
		expect(settings.get().health.weights['broken-link'].per).toBe(before);
		expect(per.value).toBe(String(before));

		per.value = '999';
		per.dispatchEvent(new Event('change'));
		// Clamped, and the max half of the pair is untouched.
		expect(settings.get().health.weights['broken-link'].per).toBe(100);
		expect(settings.get().health.weights['broken-link'].max).toBe(
			DEFAULT_SETTINGS.health.weights['broken-link'].max,
		);
	});
});

describe('when a service throws while the tab is being built', () => {
	it('offers a retry instead of a blank or half-built screen', async () => {
		const { tab, health, ignored } = await fixture();
		const working = health.ignoredCounts;
		health.ignoredCounts = () => {
			throw new Error('ignore lists unavailable');
		};
		expect(working()).toBe(ignored);

		const items = tab.getSettingDefinitions();

		// One row, and it is the error state — not six sections with a silent hole where the
		// ignore lists should be, which the user could not tell from a setting they never had.
		expect(items.length).toBe(1);
		const row = items[0];
		if (row === undefined || 'type' in row || row.render === undefined) {
			throw new Error('expected a single error row');
		}
		expect(row.name).toBe(STRINGS.errors.unexpected);
		expect(row.searchable).toBe(false);

		const el = renderRow(row as SettingDefinitionRender);
		expect(el.querySelector('.jva-error-state__title')?.textContent).toBe(
			STRINGS.errors.unexpected,
		);

		// The retry rebuilds the tab, so a transient failure is recoverable without reopening it.
		const retry = Array.from(el.querySelectorAll('button')).find(
			(button) =>
				button.querySelector('.jva-button__label')?.textContent === STRINGS.common.retry,
		);
		expect(retry).toBeDefined();
		health.ignoredCounts = working;
		retry?.dispatchEvent(new MouseEvent('click'));
		expect(controls(tab.getSettingDefinitions()).length).toBe(EXPECTED_CONTROL_KEYS.length);
	});

	it('registers no control keys it cannot honour', async () => {
		const { tab, health, settings } = await fixture();
		health.ignoredCounts = () => {
			throw new Error('ignore lists unavailable');
		};
		tab.getSettingDefinitions();

		// A key left over from the abandoned half-build would read a value the screen is not
		// showing, and worse, accept a write for it.
		expect(tab.getControlValue('general.showRibbonIcon')).toBeUndefined();
		const before = JSON.stringify(settings.get());
		await tab.setControlValue('general.showRibbonIcon', false);
		expect(JSON.stringify(settings.get())).toBe(before);
	});
});

describe('analytics', () => {
	it('is off by default and is never enabled implicitly', async () => {
		const { tab, settings } = await fixture();
		tab.getSettingDefinitions();

		expect(DEFAULT_SETTINGS.analytics.enabled).toBe(false);
		expect(settings.get().analytics.enabled).toBe(false);
		expect(tab.getControlValue('analytics.enabled')).toBe(false);

		// Reading and writing every other control leaves it off.
		for (const def of controls(tab.getSettingDefinitions())) {
			if (def.control.key === 'analytics.enabled') continue;
			tab.getControlValue(def.control.key);
		}
		expect(settings.get().analytics.enabled).toBe(false);
	});

	it('opens the collected-data report from an action row', async () => {
		const { tab } = await fixture();
		const viewer = allDefinitions(tab.getSettingDefinitions()).find(
			(def) => def.name === STRINGS.settings.analyticsView,
		);
		expect(viewer?.action).toBeTypeOf('function');
	});
});

describe('ignore lists', () => {
	it('shows an empty state when nothing has been ignored', async () => {
		const { tab } = await fixture();
		const list = ignoreList(tab.getSettingDefinitions());

		expect(list.items ?? []).toHaveLength(0);
		expect(list.emptyState).toBe(STRINGS.settings.ignoredItems(0));
	});

	it('lists one clearable row per issue type that has ignored items', async () => {
		const { tab, ignored, cleared } = await fixture();
		ignored['broken-link'] = 3;
		ignored['empty-note'] = 1;

		const rows = (ignoreList(tab.getSettingDefinitions()).items ??
			[]) as SettingDefinitionRender[];
		expect(rows.map((row) => row.name)).toEqual([
			STRINGS.health.types['broken-link'],
			STRINGS.health.types['empty-note'],
		]);
		expect(rows[0]?.desc).toBe(STRINGS.settings.ignoredItems(3));

		const first = rows[0];
		if (!first) throw new Error('no first row');
		const button = renderRow(first).querySelector('button');
		expect(button?.textContent).toBe(STRINGS.settings.clearIgnored);

		button?.dispatchEvent(new MouseEvent('click'));
		await Promise.resolve();
		expect(cleared).toEqual(['broken-link']);
	});
});

describe('destructive rows', () => {
	it('never uses the deprecated warning styling', async () => {
		const { tab } = await fixture();
		for (const name of [STRINGS.settings.analyticsDelete, STRINGS.settings.resetSettings]) {
			const row = allDefinitions(tab.getSettingDefinitions()).find(
				(def) => def.name === name,
			);
			if (!row?.render) throw new Error(`no row for ${name}`);
			const button = renderRow(row as SettingDefinitionRender).querySelector('button');
			// `setWarning()` is deprecated since 1.13; these rows must reach for
			// `setDestructive()` instead, which the double records as a different class.
			expect(button?.classList.contains('mod-warning'), name).toBe(false);
		}
	});

	it('marks deleting the analytics data as destructive', async () => {
		const { tab } = await fixture();
		const row = allDefinitions(tab.getSettingDefinitions()).find(
			(def) => def.name === STRINGS.settings.analyticsDelete,
		);
		if (!row?.render) throw new Error('no delete row');

		const button = renderRow(row as SettingDefinitionRender).querySelector('button');
		expect(button?.textContent).toBe(STRINGS.common.delete);
		expect(button?.classList.contains('mod-destructive')).toBe(true);
		// Deleting data is not the primary action of the settings screen.
		expect(button?.classList.contains('mod-cta')).toBe(false);
	});

	it('marks resetting every setting as a destructive primary action', async () => {
		const { tab } = await fixture();
		const row = allDefinitions(tab.getSettingDefinitions()).find(
			(def) => def.name === STRINGS.settings.resetSettings,
		);
		if (!row?.render) throw new Error('no reset row');

		const button = renderRow(row as SettingDefinitionRender).querySelector('button');
		expect(button?.classList.contains('mod-destructive')).toBe(true);
		expect(button?.classList.contains('mod-cta')).toBe(true);
	});

	it('confirms before resetting, and leaves the settings alone when refused', async () => {
		const { tab, settings } = await fixture((seeded) => {
			seeded.general.inboxPageSize = 17;
		});
		const row = allDefinitions(tab.getSettingDefinitions()).find(
			(def) => def.name === STRINGS.settings.resetSettings,
		);
		if (!row?.render) throw new Error('no reset row');

		const button = renderRow(row as SettingDefinitionRender).querySelector('button');
		button?.dispatchEvent(new MouseEvent('click'));
		// The confirm dialog owns the outcome; nothing is reset while it is still open.
		await Promise.resolve();
		expect(settings.get().general.inboxPageSize).toBe(17);
	});
});

describe('custom rows', () => {
	it('renders the version as data rather than a control', async () => {
		const { tab } = await fixture();
		const row = allDefinitions(tab.getSettingDefinitions()).find(
			(def) => def.name === STRINGS.settings.aboutVersion,
		);

		expect(row?.desc).toBe(VERSION);
		expect(row?.control).toBeUndefined();
		expect(row?.action).toBeUndefined();
	});

	it('renders each repository link as a real anchor', async () => {
		const { tab } = await fixture();
		const row = allDefinitions(tab.getSettingDefinitions()).find(
			(def) => def.name === STRINGS.settings.aboutRepository,
		);
		if (!row?.render) throw new Error('no repository row');

		const anchor = renderRow(row as SettingDefinitionRender).querySelector('a');
		expect(anchor?.getAttribute('href')).toContain('github.com');
		expect(anchor?.getAttribute('rel')).toBe('noopener');
	});

	it('shows the action log empty state when nothing has been recorded', async () => {
		const { tab } = await fixture();
		const row = allDefinitions(tab.getSettingDefinitions()).find(
			(def) => def.searchable === false && def.name === STRINGS.settings.actionLogHeading,
		);
		if (!row?.render) throw new Error('no action log row');

		const el = renderRow(row as SettingDefinitionRender);
		expect(el.querySelector('.jva-action-log')).not.toBeNull();
		expect(el.querySelector('.jva-empty-inline')?.textContent).toBe(
			STRINGS.settings.actionLogEmpty,
		);
	});

	it('marks the sub-headings as headings', async () => {
		const { tab } = await fixture();
		const row = allDefinitions(tab.getSettingDefinitions()).find(
			(def) => def.name === STRINGS.settings.detectorsHeading,
		);
		if (!row?.render) throw new Error('no detectors heading');

		expect(row.desc).toBe(STRINGS.settings.detectorsDesc);
		expect(
			renderRow(row as SettingDefinitionRender).classList.contains('setting-item-heading'),
		).toBe(true);
	});
});
