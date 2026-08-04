/**
 * The plugin's settings tab (main spec 8.4, addendum 3.4).
 *
 * The screen is declared, not drawn. {@link JemzSettingTab.getSettingDefinitions} returns the
 * whole surface as data; Obsidian 1.13 renders it, indexes it for settings search, and
 * reconciles it whenever {@link JemzSettingTab.update} is called. Four rules shape this file:
 *
 *  1. Every control writes straight through {@link SettingsStore.update}. There is no "Apply"
 *     button and no local draft copy, because a settings screen that can be closed mid-edit
 *     must never leave the user wondering whether their change stuck.
 *  2. Nothing garbage-looking is ever persisted. The declarative API addresses controls by a
 *     flat key, so every key is registered with a {@link ControlBinding} that parses first:
 *     numbers that are not finite are dropped and the rest clamped into a range the plugin
 *     can survive, comma separated fields drop blank entries, and folder and type fields
 *     refuse to store an empty string. `data.json` is plain JSON a user can hand-edit, and
 *     this screen is the one place that decides what a legal value looks like.
 *  3. Copy comes from {@link STRINGS} only. The two exceptions are log levels and scan
 *     frequencies, whose labels are derived from the stored identifiers with
 *     {@link capitalize} rather than duplicated as a second set of literals — a translation
 *     changes the string table, and these labels would only ever restate the enum.
 *  4. Anything the definitions cannot express as a control — the score weight inputs, the
 *     ignore lists, the action log — is a `render` row inside the same definitions, never a
 *     parallel imperative screen. One description of the settings surface, not two.
 *
 * Teardown: `PluginSettingTab` is not a `Component`, so it has no `registerDomEvent`. Nothing
 * here needs one. Obsidian owns every element it renders from these definitions, the listener
 * the score weight inputs add is handed back as the cleanup a `render` row may return, and
 * nothing is ever attached to `document` or `window` — so closing the tab leaves nothing
 * behind and there is no imperative `display()` left to unwind.
 */

import {
	Notice,
	Platform,
	PluginSettingTab,
	type App,
	type ButtonComponent,
	type Plugin,
	type Setting,
	type SettingDefinitionControl,
	type SettingDefinitionGroup,
	type SettingDefinitionItem,
	type SettingDefinitionList,
	type SettingDefinitionRender,
} from 'obsidian';
import { LINKS, MAX_ACTION_LOG_ENTRIES } from '../../core/constants';
import type { Logger } from '../../core/logger';
import type { SettingsStore } from '../../core/settings';
import { STRINGS } from '../../core/strings';
import type { ActionLogService } from '../../services/action-log-service';
import type { AnalyticsService } from '../../services/analytics-service';
import type { BackupService } from '../../services/backup-service';
import type { HealthService } from '../../services/health-service';
import { ISSUE_TYPES, type IssueType } from '../../types/health';
import type { AnalyticsData, JemzSettings, LogLevel, ScanFrequency } from '../../types/settings';
import { confirm } from '../../ui/components/confirm-dialog';
import { renderErrorState, renderInlineEmpty } from '../../ui/components/empty-state';
import { JemzModal } from '../../ui/components/modal-base';
import { formatDate, formatRelative } from '../../utils/date';
import { normalizeVaultPath } from '../../utils/file';
import { capitalize } from '../../utils/string';

/** Services the settings screen reads from and writes through. */
export interface SettingsTabDeps {
	settings: SettingsStore;
	health: HealthService;
	actionLog: ActionLogService;
	analytics: AnalyticsService;
	backup: BackupService;
	logger: Logger;
}

/** Bounds a numeric field is allowed to store. */
export interface NumericRange {
	readonly min: number;
	readonly max: number;
	/** Round to a whole number before clamping. */
	readonly integer?: boolean;
}

const LOG_LEVELS: readonly LogLevel[] = ['silent', 'error', 'warn', 'info', 'debug'];
const SCAN_FREQUENCIES: readonly ScanFrequency[] = ['manual', 'daily', 'weekly'];

const BYTES_PER_MB = 1024 * 1024;

/** Dropdown values for the inbox sort direction, which is stored as a boolean. */
const SORT_NEWEST = 'newest';
const SORT_OLDEST = 'oldest';

/**
 * Bounds for every numeric field.
 *
 * They exist to stop a typo turning into a plugin that cannot run: a page size of zero
 * renders an inbox with no items and no way back, and a stale threshold of zero marks the
 * entire vault stale on the next scan.
 */
const RANGES = {
	inboxPageSize: { min: 5, max: 500, integer: true },
	largeFileMb: { min: 0.1, max: 10_240 },
	staleDays: { min: 1, max: 3650, integer: true },
	resultsPerPage: { min: 5, max: 500, integer: true },
	weight: { min: 0, max: 100 },
	fuzzy: { min: 0, max: 1 },
} as const satisfies Record<string, NumericRange>;

/**
 * Parse a user-typed number, or reject it.
 *
 * Anything that is not a finite number returns null so the caller can leave the stored value
 * alone — writing `NaN` into `data.json` produces `null` after a JSON round trip, which every
 * consumer downstream would then have to defend against.
 *
 * @returns The value clamped into `range`, or null when the text is not a number.
 */
export function parseNumberInRange(raw: string, range: NumericRange): number | null {
	const trimmed = raw.trim();
	// `Number('')` is 0, which would silently turn a cleared field into a stored zero.
	if (trimmed.length === 0) return null;

	const parsed = Number(trimmed);
	if (!Number.isFinite(parsed)) return null;

	const rounded = range.integer === true ? Math.round(parsed) : parsed;
	return Math.min(range.max, Math.max(range.min, rounded));
}

/**
 * Split a comma separated field into stored entries.
 *
 * Entries are trimmed, run through `transform`, emptied entries dropped, and duplicates
 * collapsed — so `"work, , work ,"` stores `['work']` rather than four entries, three of
 * which would silently never match anything.
 */
export function parseCommaList(
	raw: string,
	transform: (entry: string) => string = (entry) => entry,
): string[] {
	const entries = raw
		.split(',')
		.map((entry) => transform(entry.trim()))
		.filter((entry) => entry.length > 0);
	return Array.from(new Set(entries));
}

/** Render a stored list back into a comma separated field. */
function formatCommaList(values: readonly string[]): string {
	return values.join(', ');
}

function isLogLevel(value: string): value is LogLevel {
	return (LOG_LEVELS as readonly string[]).includes(value);
}

function isScanFrequency(value: string): value is ScanFrequency {
	return (SCAN_FREQUENCIES as readonly string[]).includes(value);
}

/** Labels for an enum whose members are identifiers rather than translated copy. */
function optionsFor(values: readonly string[]): Record<string, string> {
	const options: Record<string, string> = {};
	for (const value of values) options[value] = capitalize(value);
	return options;
}

/**
 * A candidate from a control, as text.
 *
 * The declarative API hands `setControlValue` an `unknown`: a text control sends a string, a
 * number control sends a number (already `defaultValue` when the typed text did not parse).
 * Both are normalised to text here so one parser decides what is storable.
 */
function asText(raw: unknown): string | null {
	if (typeof raw === 'string') return raw;
	if (typeof raw === 'number') return String(raw);
	return null;
}

/**
 * The read/write pair behind one declarative control key.
 *
 * Obsidian addresses declarative controls by a flat string key, routed through
 * {@link JemzSettingTab.getControlValue} and {@link JemzSettingTab.setControlValue}. The
 * plugin's settings are a nested object whose fields each have their own parsing rules, so
 * every key is registered with the accessors that know how to read it and — more importantly
 * — how to refuse a value that would leave something unusable in `data.json`.
 */
interface ControlBinding {
	/** The value the control should show, read live from the store. */
	readonly read: (settings: JemzSettings) => unknown;
	/**
	 * Turn a candidate from the control into a mutation.
	 *
	 * @returns A mutator, or null to reject the candidate and leave the stored value alone.
	 */
	readonly coerce: (raw: unknown) => ((settings: JemzSettings) => void) | null;
	/**
	 * Skip the store's write coalescing.
	 *
	 * Used for discrete controls, where one interaction is one write and a failure has to
	 * surface while the user still remembers the click; text and slider edits stay coalesced
	 * so a keystroke or a drag is not a disk write each.
	 */
	readonly immediate: boolean;
}

/**
 * A sub-heading inside a section.
 *
 * `SettingDefinitionGroup` carries a heading but no description, and groups cannot nest
 * (`SettingGroupItem` admits only settings and pages), so the sub-headings this screen has
 * always had are rendered as heading rows instead. That also keeps their descriptions, which
 * a group heading has nowhere to put.
 */
function headingRow(name: string, desc?: string): SettingDefinitionRender {
	return {
		name,
		desc,
		render: (setting: Setting): void => {
			setting.setHeading();
		},
	};
}

/**
 * Everything the plugin has recorded about this user, as plain text.
 *
 * The point of the row that opens this is trust: a user who is asked to share usage data
 * has to be able to see exactly what that means, in a form they can read without a JSON
 * viewer. Timestamps are formatted for the same reason — an epoch number proves nothing.
 */
class AnalyticsDataModal extends JemzModal {
	constructor(
		app: App,
		private readonly snapshot: AnalyticsData,
	) {
		super(app, STRINGS.settings.analyticsView);
	}

	protected renderBody(body: HTMLElement): void {
		const { counts, durations } = this.snapshot;
		const eventNames = Object.keys(counts);
		const durationNames = Object.keys(durations);

		if (eventNames.length === 0 && durationNames.length === 0) {
			renderInlineEmpty(body, STRINGS.settings.analyticsEmpty);
			return;
		}

		const lines = [
			`platform: ${this.snapshot.platform}`,
			`vault size: ${this.snapshot.vaultSizeBucket}`,
			`first recorded: ${AnalyticsDataModal.stamp(this.snapshot.firstRecordedAt)}`,
			`last recorded: ${AnalyticsDataModal.stamp(this.snapshot.lastRecordedAt)}`,
		];
		for (const name of eventNames) lines.push(`${name}: ${counts[name] ?? 0}`);
		for (const name of durationNames) lines.push(`${name} (ms): ${durations[name] ?? 0}`);

		body.createEl('pre', { text: lines.join('\n') });
	}

	protected override renderFooter(footer: HTMLElement): void {
		this.renderActions(footer, [
			{ label: STRINGS.common.close, cta: true, onClick: (): void => this.close() },
		]);
	}

	/** A readable instant, or an em dash when nothing has been recorded yet. */
	private static stamp(value: number | null): string {
		return value === null ? '—' : formatDate(value, 'YYYY-MM-DD HH:mm');
	}
}

export class JemzSettingTab extends PluginSettingTab {
	/** Held separately: `PluginSettingTab` does not expose the plugin as a typed property. */
	private readonly hostPlugin: Plugin;
	private readonly deps: SettingsTabDeps;

	/** Accessors for every control key, rebuilt with the definitions that declare them. */
	private readonly bindings = new Map<string, ControlBinding>();

	constructor(app: App, plugin: Plugin, deps: SettingsTabDeps) {
		super(app, plugin);
		this.hostPlugin = plugin;
		this.deps = deps;
	}

	/**
	 * The whole settings surface, as data.
	 *
	 * Obsidian calls this on every render and once when the tab is registered, so it doubles
	 * as the point where the control key registry is rebuilt: the definitions and the
	 * accessors behind them are produced together and can never disagree about which keys
	 * exist.
	 */
	override getSettingDefinitions(): SettingDefinitionItem[] {
		this.bindings.clear();
		try {
			return [
				this.generalSection(),
				this.captureSection(),
				this.healthSection(),
				this.ignoreListSection(),
				this.retrievalSection(),
				this.analyticsSection(),
				this.aboutSection(),
			];
		} catch (error) {
			// A half-built tree would render a screen with some sections silently missing, which
			// is worse than saying so: the user cannot tell a dropped section from a setting they
			// never had. Everything is replaced by one row that explains itself and offers a retry.
			this.deps.logger.error('Could not build the settings tab', error);
			this.bindings.clear();
			return [this.errorRow()];
		}
	}

	/**
	 * The whole tab, replaced by one recoverable error row.
	 *
	 * Excluded from settings search because it is a failure state rather than a setting, and it
	 * would otherwise answer to a query the moment anything upstream threw.
	 */
	private errorRow(): SettingDefinitionRender {
		return {
			name: STRINGS.errors.unexpected,
			searchable: false,
			render: (setting: Setting): void => {
				setting.settingEl.empty();
				renderErrorState(setting.settingEl, {
					title: STRINGS.errors.unexpected,
					retryLabel: STRINGS.common.retry,
					onRetry: (): void => this.update(),
				});
			},
		};
	}

	/**
	 * Read the value behind a control key.
	 *
	 * Overridden because the base implementation reads `plugin.settings`, and this plugin
	 * keeps its settings in a {@link SettingsStore} that owns migration, coalescing and the
	 * change event.
	 */
	override getControlValue(key: string): unknown {
		const binding = this.ensureBindings().get(key);
		return binding?.read(this.deps.settings.get());
	}

	/**
	 * Persist a value for a control key.
	 *
	 * A candidate the binding rejects is dropped rather than stored, which leaves the field
	 * disagreeing with the store until the next render — the same bargain the imperative
	 * version struck, and far better than persisting a value nothing downstream can use.
	 */
	override async setControlValue(key: string, value: unknown): Promise<void> {
		const binding = this.ensureBindings().get(key);
		if (!binding) return;

		const mutate = binding.coerce(value);
		if (!mutate) return;
		await this.persist(mutate, binding.immediate);
	}

	/* ------------------------------------------------------------- 1. general -- */

	private generalSection(): SettingDefinitionGroup {
		return {
			type: 'group',
			heading: STRINGS.settings.general,
			items: [
				headingRow(STRINGS.settings.modulesHeading),
				this.toggle({
					key: 'general.modules.capture',
					name: STRINGS.settings.moduleCapture,
					desc: STRINGS.settings.moduleCaptureDesc,
					read: (settings) => settings.general.modules.capture,
					write: (settings, value) => {
						settings.general.modules.capture = value;
					},
				}),
				this.toggle({
					key: 'general.modules.health',
					name: STRINGS.settings.moduleHealth,
					desc: STRINGS.settings.moduleHealthDesc,
					read: (settings) => settings.general.modules.health,
					write: (settings, value) => {
						settings.general.modules.health = value;
					},
				}),
				this.toggle({
					key: 'general.modules.retrieval',
					name: STRINGS.settings.moduleRetrieval,
					desc: STRINGS.settings.moduleRetrievalDesc,
					read: (settings) => settings.general.modules.retrieval,
					write: (settings, value) => {
						settings.general.modules.retrieval = value;
					},
				}),
				this.toggle({
					key: 'general.showRibbonIcon',
					name: STRINGS.settings.showRibbon,
					desc: STRINGS.settings.showRibbonDesc,
					read: (settings) => settings.general.showRibbonIcon,
					write: (settings, value) => {
						settings.general.showRibbonIcon = value;
					},
				}),
				this.toggle({
					key: 'general.showStatusBar',
					name: STRINGS.settings.showStatusBar,
					desc: STRINGS.settings.showStatusBarDesc,
					read: (settings) => settings.general.showStatusBar,
					write: (settings, value) => {
						settings.general.showStatusBar = value;
					},
				}),
				this.dropdown({
					key: 'general.logLevel',
					name: STRINGS.settings.logLevel,
					desc: STRINGS.settings.logLevelDesc,
					options: optionsFor(LOG_LEVELS),
					read: (settings) => settings.general.logLevel,
					parse: (raw) => (isLogLevel(raw) ? raw : null),
					write: (settings, value) => {
						settings.general.logLevel = value;
					},
				}),
				this.number({
					key: 'general.inboxPageSize',
					name: STRINGS.settings.inboxPageSize,
					desc: STRINGS.settings.inboxPageSizeDesc,
					range: RANGES.inboxPageSize,
					read: (settings) => settings.general.inboxPageSize,
					write: (settings, value) => {
						settings.general.inboxPageSize = value;
					},
				}),
				// "Sort by" is shared with the Find module rather than duplicated: it is the same
				// control with the same meaning, and a translation should only have to write it once.
				this.dropdown({
					key: 'general.inboxNewestFirst',
					name: STRINGS.find.sortLabel,
					options: {
						[SORT_NEWEST]: STRINGS.inbox.sortNewest,
						[SORT_OLDEST]: STRINGS.inbox.sortOldest,
					},
					read: (settings) =>
						settings.general.inboxNewestFirst ? SORT_NEWEST : SORT_OLDEST,
					parse: (raw) => (raw === SORT_NEWEST || raw === SORT_OLDEST ? raw : null),
					write: (settings, value) => {
						settings.general.inboxNewestFirst = value === SORT_NEWEST;
					},
				}),
			],
		};
	}

	/* --------------------------------------------------- 2. capture and inbox -- */

	private captureSection(): SettingDefinitionGroup {
		return {
			type: 'group',
			heading: STRINGS.settings.captureInbox,
			items: [
				this.text({
					key: 'capture.inboxFolder',
					name: STRINGS.settings.inboxFolder,
					desc: STRINGS.settings.inboxFolderDesc,
					transform: normalizeVaultPath,
					read: (settings) => settings.capture.inboxFolder,
					write: (settings, value) => {
						settings.capture.inboxFolder = value;
					},
				}),
				this.text({
					key: 'capture.archiveFolder',
					name: STRINGS.settings.archiveFolder,
					desc: STRINGS.settings.archiveFolderDesc,
					transform: normalizeVaultPath,
					read: (settings) => settings.capture.archiveFolder,
					write: (settings, value) => {
						settings.capture.archiveFolder = value;
					},
				}),
				this.text({
					key: 'capture.attachmentArchiveFolder',
					name: STRINGS.settings.attachmentArchiveFolder,
					desc: STRINGS.settings.attachmentArchiveFolderDesc,
					transform: normalizeVaultPath,
					read: (settings) => settings.capture.attachmentArchiveFolder,
					write: (settings, value) => {
						settings.capture.attachmentArchiveFolder = value;
					},
				}),
				this.list({
					key: 'capture.defaultTags',
					name: STRINGS.settings.defaultTags,
					desc: STRINGS.settings.defaultTagsDesc,
					// Tags are stored without the leading hash, so a user who types one is not punished.
					transform: (entry) => entry.replace(/^#+/, ''),
					read: (settings) => settings.capture.defaultTags,
					write: (settings, value) => {
						settings.capture.defaultTags = value;
					},
				}),
				this.text({
					key: 'capture.defaultType',
					name: STRINGS.settings.defaultType,
					desc: STRINGS.settings.defaultTypeDesc,
					read: (settings) => settings.capture.defaultType,
					write: (settings, value) => {
						settings.capture.defaultType = value;
					},
				}),
				this.toggle({
					key: 'capture.autoCreateFolders',
					name: STRINGS.settings.autoCreateFolders,
					desc: STRINGS.settings.autoCreateFoldersDesc,
					read: (settings) => settings.capture.autoCreateFolders,
					write: (settings, value) => {
						settings.capture.autoCreateFolders = value;
					},
				}),
			],
		};
	}

	/* -------------------------------------------------------- 3. vault health -- */

	private healthSection(): SettingDefinitionGroup {
		return {
			type: 'group',
			heading: STRINGS.settings.vaultHealth,
			items: [
				this.dropdown({
					key: 'health.scanFrequency',
					name: STRINGS.settings.scanFrequency,
					desc: STRINGS.settings.scanFrequencyDesc,
					options: optionsFor(SCAN_FREQUENCIES),
					read: (settings) => settings.health.scanFrequency,
					parse: (raw) => (isScanFrequency(raw) ? raw : null),
					write: (settings, value) => {
						settings.health.scanFrequency = value;
					},
				}),
				this.toggle({
					key: 'health.autoScanOnStartup',
					name: STRINGS.settings.autoScanOnStartup,
					desc: STRINGS.settings.autoScanOnStartupDesc,
					read: (settings) => settings.health.autoScanOnStartup,
					write: (settings, value) => {
						settings.health.autoScanOnStartup = value;
					},
				}),
				this.list({
					key: 'health.excludedFolders',
					name: STRINGS.settings.excludedFolders,
					desc: STRINGS.settings.excludedFoldersDesc,
					transform: normalizeVaultPath,
					read: (settings) => settings.health.excludedFolders,
					write: (settings, value) => {
						settings.health.excludedFolders = value;
					},
				}),
				this.list({
					key: 'health.excludedTags',
					name: STRINGS.settings.excludedTags,
					desc: STRINGS.settings.excludedTagsDesc,
					transform: (entry) => entry.replace(/^#+/, ''),
					read: (settings) => settings.health.excludedTags,
					write: (settings, value) => {
						settings.health.excludedTags = value;
					},
				}),
				this.list({
					key: 'health.excludedExtensions',
					name: STRINGS.settings.excludedExtensions,
					desc: STRINGS.settings.excludedExtensionsDesc,
					// Stored lower-case and without the dot, which is how every comparison sees them.
					transform: (entry) => entry.replace(/^\.+/, '').toLowerCase(),
					read: (settings) => settings.health.excludedExtensions,
					write: (settings, value) => {
						settings.health.excludedExtensions = value;
					},
				}),
				this.toggle({
					key: 'health.excludeInbox',
					name: STRINGS.settings.excludeInbox,
					desc: STRINGS.settings.excludeInboxDesc,
					read: (settings) => settings.health.excludeInbox,
					write: (settings, value) => {
						settings.health.excludeInbox = value;
					},
				}),
				this.toggle({
					key: 'health.excludeArchived',
					name: STRINGS.settings.excludeArchived,
					desc: STRINGS.settings.excludeArchivedDesc,
					read: (settings) => settings.health.excludeArchived,
					write: (settings, value) => {
						settings.health.excludeArchived = value;
					},
				}),
				this.list({
					key: 'health.requiredFrontmatterFields',
					name: STRINGS.settings.requiredFields,
					desc: STRINGS.settings.requiredFieldsDesc,
					read: (settings) => settings.health.requiredFrontmatterFields,
					write: (settings, value) => {
						settings.health.requiredFrontmatterFields = value;
					},
				}),
				this.number({
					key: 'health.largeFileThresholdBytes',
					name: STRINGS.settings.largeFileThreshold,
					desc: STRINGS.settings.largeFileThresholdDesc,
					range: RANGES.largeFileMb,
					step: 0.1,
					// Stored in bytes, shown in megabytes: nobody thinks about their vault in bytes.
					read: (settings) => settings.health.largeFileThresholdBytes / BYTES_PER_MB,
					write: (settings, value) => {
						settings.health.largeFileThresholdBytes = Math.round(value * BYTES_PER_MB);
					},
				}),

				headingRow(STRINGS.settings.detectorsHeading, STRINGS.settings.detectorsDesc),
				...ISSUE_TYPES.map((type) => this.detectorToggle(type)),

				headingRow(STRINGS.settings.scoreWeights, STRINGS.settings.scoreWeightsDesc),
				...ISSUE_TYPES.map((type) => this.weightRow(type)),

				headingRow(STRINGS.settings.ignoreListsHeading, STRINGS.settings.ignoreListsDesc),
			],
		};
	}

	/** One detector on/off switch. Aliased so a search for "detectors" surfaces all nine. */
	private detectorToggle(type: IssueType): SettingDefinitionControl {
		return this.toggle({
			key: `health.detectors.${type}`,
			name: STRINGS.health.types[type],
			desc: STRINGS.health.typeDescriptions[type],
			aliases: [STRINGS.settings.detectorsHeading],
			read: (settings) => settings.health.detectors[type],
			write: (settings, value) => {
				settings.health.detectors[type] = value;
			},
		});
	}

	/**
	 * Per-issue and per-category score weights, one row per issue type.
	 *
	 * Two numbers on one row rather than two `number` controls, which would turn nine
	 * categories into eighteen near-identical rows and bury every other health option under
	 * them. The row keeps its own inputs, so it is a `render` definition; the aliases put it
	 * back into settings search under the heading it sits below.
	 */
	private weightRow(type: IssueType): SettingDefinitionRender {
		const label = STRINGS.health.types[type];
		return {
			name: label,
			aliases: [
				STRINGS.settings.scoreWeights,
				STRINGS.settings.weightPer,
				STRINGS.settings.weightMax,
			],
			render: (setting: Setting): (() => void) => {
				const weights = this.deps.settings.get().health.weights;
				const disposers = [
					this.weightInput(setting.controlEl, {
						label: STRINGS.settings.weightPer,
						name: `${label} — ${STRINGS.settings.weightPer}`,
						value: weights[type].per,
						apply: (settings, value) => {
							settings.health.weights[type] = {
								per: value,
								max: settings.health.weights[type].max,
							};
						},
					}),
					this.weightInput(setting.controlEl, {
						label: STRINGS.settings.weightMax,
						name: `${label} — ${STRINGS.settings.weightMax}`,
						value: weights[type].max,
						apply: (settings, value) => {
							settings.health.weights[type] = {
								per: settings.health.weights[type].per,
								max: value,
							};
						},
					}),
				];
				return (): void => {
					for (const dispose of disposers) dispose();
				};
			},
		};
	}

	/**
	 * One labelled number input for a score weight.
	 *
	 * @returns A disposer that detaches the listener, returned up to the `render` row so
	 * Obsidian can unwind it when the row is torn down.
	 */
	private weightInput(
		parent: HTMLElement,
		options: {
			label: string;
			name: string;
			value: number;
			apply: (settings: JemzSettings, value: number) => void;
		},
	): () => void {
		const wrapper = parent.createEl('label');
		wrapper.createSpan({ text: options.label });

		const input = wrapper.createEl('input', {
			cls: 'jva-settings__weight-input',
			type: 'number',
			value: String(options.value),
		});
		input.setAttrs({
			min: String(RANGES.weight.min),
			max: String(RANGES.weight.max),
			step: '0.1',
			'aria-label': options.name,
		});

		// The last value that made it into settings, so a rejected edit can be undone on screen
		// without reading back through the store.
		let accepted = options.value;

		const onChange = (): void => {
			const parsed = parseNumberInRange(input.value, RANGES.weight);
			// Garbage leaves the stored weight alone and puts the last good value back, so the
			// field never disagrees with what a scan will actually use.
			if (parsed === null) {
				input.value = String(accepted);
				return;
			}
			accepted = parsed;
			input.value = String(parsed);
			void this.persist((settings) => options.apply(settings, parsed), true);
		};

		input.addEventListener('change', onChange);
		return (): void => input.removeEventListener('change', onChange);
	}

	/**
	 * Issues the user chose to ignore, one row per issue type that has any.
	 *
	 * A `list` rather than more group items: this is a collection of entries the user removes,
	 * which is exactly what {@link SettingDefinitionList} is for, and it brings its own empty
	 * state. Lists cannot nest inside a group (`SettingGroupItem` admits only settings and
	 * pages), so it sits at the top level directly after the Vault health section, under the
	 * heading row that section ends with. `onDelete` is deliberately unused — it removes one
	 * entry, whereas the affordance here empties a whole category, so each row keeps its
	 * explicit Clear button.
	 */
	private ignoreListSection(): SettingDefinitionList {
		const counts = this.deps.health.ignoredCounts();
		const active = ISSUE_TYPES.filter((type) => counts[type] > 0);

		return {
			type: 'list',
			emptyState: STRINGS.settings.ignoredItems(0),
			items: active.map((type) => ({
				name: STRINGS.health.types[type],
				desc: STRINGS.settings.ignoredItems(counts[type]),
				aliases: [STRINGS.settings.ignoreListsHeading],
				render: (setting: Setting): void => {
					setting.addButton((button) => {
						button.setButtonText(STRINGS.settings.clearIgnored);
						button.onClick(() => void this.clearIgnored(type));
					});
				},
			})),
		};
	}

	private async clearIgnored(type: IssueType): Promise<void> {
		try {
			await this.deps.health.clearIgnored(type);
			// The list has one row fewer, which is a change of shape rather than of value.
			this.update();
		} catch (error) {
			this.deps.logger.error(`Could not clear the ignore list for "${type}"`, error);
			new Notice(STRINGS.errors.unexpected);
		}
	}

	/* ----------------------------------------------------- 4. smart retrieval -- */

	private retrievalSection(): SettingDefinitionGroup {
		return {
			type: 'group',
			heading: STRINGS.settings.smartRetrieval,
			items: [
				this.number({
					key: 'retrieval.staleThresholdDays',
					name: STRINGS.settings.staleThreshold,
					desc: STRINGS.settings.staleThresholdDesc,
					range: RANGES.staleDays,
					read: (settings) => settings.retrieval.staleThresholdDays,
					write: (settings, value) => {
						settings.retrieval.staleThresholdDays = value;
					},
				}),
				this.slider({
					key: 'retrieval.fuzzySensitivity',
					name: STRINGS.settings.fuzzySensitivity,
					desc: STRINGS.settings.fuzzySensitivityDesc,
					range: RANGES.fuzzy,
					step: 0.05,
					read: (settings) => settings.retrieval.fuzzySensitivity,
					write: (settings, value) => {
						settings.retrieval.fuzzySensitivity = value;
					},
				}),
				this.number({
					key: 'retrieval.resultsPerPage',
					name: STRINGS.settings.resultsPerPage,
					desc: STRINGS.settings.resultsPerPageDesc,
					range: RANGES.resultsPerPage,
					read: (settings) => settings.retrieval.resultsPerPage,
					write: (settings, value) => {
						settings.retrieval.resultsPerPage = value;
					},
				}),
				this.toggle({
					key: 'retrieval.excludeArchivedFromViews',
					name: STRINGS.settings.excludeArchivedFromViews,
					desc: STRINGS.settings.excludeArchivedFromViewsDesc,
					read: (settings) => settings.retrieval.excludeArchivedFromViews,
					write: (settings, value) => {
						settings.retrieval.excludeArchivedFromViews = value;
					},
				}),
			],
		};
	}

	/* ----------------------------------------------------------- 5. analytics -- */

	private analyticsSection(): SettingDefinitionGroup {
		return {
			type: 'group',
			heading: STRINGS.settings.analytics,
			items: [
				// Read live rather than from a captured copy: this toggle is the promise the privacy
				// copy makes, and it must always show what is actually stored.
				this.toggle({
					key: 'analytics.enabled',
					name: STRINGS.settings.analyticsEnabled,
					desc: STRINGS.settings.analyticsEnabledDesc,
					read: (settings) => settings.analytics.enabled,
					write: (settings, value) => {
						settings.analytics.enabled = value;
					},
				}),
				// Opening a read-only report is the whole row's purpose, so the row is the control.
				{
					name: STRINGS.settings.analyticsView,
					action: (): void => {
						new AnalyticsDataModal(this.app, this.deps.analytics.snapshot()).open();
					},
				},
				{
					name: STRINGS.settings.analyticsDelete,
					render: (setting: Setting): void => {
						setting.addButton((button) => {
							button.setButtonText(STRINGS.common.delete);
							button.setDestructive();
							button.onClick(() => void this.deleteAnalytics());
						});
					},
				},
			],
		};
	}

	private async deleteAnalytics(): Promise<void> {
		try {
			await this.deps.analytics.clear();
			new Notice(STRINGS.settings.analyticsDeleted);
		} catch (error) {
			this.deps.logger.error('Could not delete the analytics data', error);
			new Notice(STRINGS.errors.unexpected);
		}
	}

	/* --------------------------------------------------------------- 6. about -- */

	private aboutSection(): SettingDefinitionGroup {
		return {
			type: 'group',
			heading: STRINGS.settings.about,
			items: [
				{ name: STRINGS.settings.aboutVersion, desc: this.hostPlugin.manifest.version },
				linkRow(STRINGS.settings.aboutRepository, LINKS.repository),
				linkRow(STRINGS.settings.aboutIssues, LINKS.issues),
				linkRow(STRINGS.settings.aboutChangelog, LINKS.changelog),

				headingRow(STRINGS.settings.actionLogHeading, STRINGS.settings.actionLogDesc),
				{
					name: STRINGS.settings.actionLogClear,
					render: (setting: Setting): void => {
						setting.addButton((button) => {
							button.setButtonText(STRINGS.settings.actionLogClear);
							button.onClick(() => void this.clearActionLog());
						});
					},
				},
				this.actionLogRow(),

				{
					name: STRINGS.commands.restoreLastBackup,
					desc: STRINGS.preview.restoreHint,
					render: (setting: Setting): void => {
						setting.addButton((button) => {
							button.setButtonText(STRINGS.commands.restoreLastBackup);
							button.onClick(() => void this.restoreLatestBackup(button));
						});
					},
				},
				{
					name: STRINGS.settings.resetSettings,
					desc: STRINGS.settings.resetSettingsDesc,
					render: (setting: Setting): void => {
						setting.addButton((button) => {
							button.setButtonText(STRINGS.settings.resetSettings);
							// Destructive and the row's primary action: it is the only button here.
							button.setDestructive().setCta();
							button.onClick(() => void this.resetSettings());
						});
					},
				},
			],
		};
	}

	/**
	 * The rolling action log.
	 *
	 * The log is a block, not a control: it is a scrolling list a hundred entries deep. The
	 * row's own info column is cleared and used as its host, because the heading row directly
	 * above already names it and the entries need the width more than a repeated title. It is
	 * excluded from settings search for the same reason — the heading above carries the terms.
	 */
	private actionLogRow(): SettingDefinitionRender {
		return {
			name: STRINGS.settings.actionLogHeading,
			searchable: false,
			render: (setting: Setting): void => {
				setting.infoEl.empty();
				this.renderActionLogEntries(setting.infoEl.createDiv({ cls: 'jva-action-log' }));
			},
		};
	}

	/**
	 * Draw the newest entries.
	 *
	 * Wrapped in its own try/catch because `data.json` is hand-editable: one entry with a
	 * broken timestamp must not take the entire settings screen down with it.
	 */
	private renderActionLogEntries(container: HTMLElement): void {
		try {
			const entries = this.deps.actionLog.recent(MAX_ACTION_LOG_ENTRIES);
			if (entries.length === 0) {
				renderInlineEmpty(container, STRINGS.settings.actionLogEmpty);
				return;
			}

			for (const entry of entries) {
				const row = container.createDiv({ cls: 'jva-action-log__entry' });
				// The time column does not wrap, so a phone gets the clock only — the date is
				// recoverable from the ordering, a squashed row is not.
				row.createSpan({
					cls: 'jva-action-log__time',
					text: formatDate(
						entry.timestamp,
						Platform.isMobile ? 'HH:mm' : 'YYYY-MM-DD HH:mm',
					),
				});
				row.createSpan({ cls: 'jva-action-log__action', text: entry.action });
				row.createSpan({
					cls: 'jva-action-log__details',
					text: entry.details,
					title: entry.details,
				});
				row.createSpan({
					cls: `jva-action-log__result--${entry.result}`,
					text: capitalize(entry.result),
				});
			}
		} catch (error) {
			this.deps.logger.error('Could not render the action log', error);
			container.empty();
			renderErrorState(container, {
				title: STRINGS.errors.unexpected,
				retryLabel: STRINGS.common.retry,
				onRetry: (): void => this.update(),
			});
		}
	}

	private async clearActionLog(): Promise<void> {
		try {
			await this.deps.actionLog.clear();
			new Notice(STRINGS.settings.actionLogCleared);
			// The log row's contents come from the definitions, so the tab redraws itself.
			this.update();
		} catch (error) {
			this.deps.logger.error('Could not clear the action log', error);
			new Notice(STRINGS.errors.unexpected);
		}
	}

	/**
	 * Put the files from the newest fix backup back.
	 *
	 * Confirmed first because it overwrites whatever is in the vault right now, and reported
	 * per outcome: a partial restore has to say both how much came back and that something
	 * did not, otherwise the user assumes the whole batch was undone.
	 */
	private async restoreLatestBackup(button: ButtonComponent): Promise<void> {
		const latest = this.deps.backup.list()[0];
		if (!latest) {
			new Notice(STRINGS.backup.none);
			return;
		}

		const choice = await confirm(this.app, {
			title: STRINGS.backup.restoreConfirmTitle,
			body: STRINGS.backup.restoreConfirmBody(
				formatRelative(latest.createdAt),
				latest.files.length,
			),
			confirmLabel: STRINGS.commands.restoreLastBackup,
			destructive: true,
		});
		if (choice !== 'confirm') return;

		// Restoring reads and writes every file in the manifest, which is slow enough on a
		// phone to look like nothing happened.
		button.setDisabled(true).setButtonText(STRINGS.common.loading);
		try {
			const result = await this.deps.backup.restoreLatest();
			if (result.restored.length > 0) {
				new Notice(STRINGS.backup.restored(result.restored.length));
			}
			if (result.failed.length > 0) {
				this.deps.logger.error(
					`Could not restore ${result.failed.length} file(s)`,
					result.failed,
				);
				new Notice(STRINGS.backup.restoreFailed);
			}
		} catch (error) {
			this.deps.logger.error('Could not restore the last fix backup', error);
			new Notice(STRINGS.backup.restoreFailed);
		} finally {
			button.setDisabled(false).setButtonText(STRINGS.commands.restoreLastBackup);
		}
	}

	private async resetSettings(): Promise<void> {
		const choice = await confirm(this.app, {
			title: STRINGS.settings.resetConfirmTitle,
			body: STRINGS.settings.resetConfirmBody,
			confirmLabel: STRINGS.settings.resetSettings,
			destructive: true,
		});
		if (choice !== 'confirm') return;

		try {
			await this.deps.settings.reset();
			new Notice(STRINGS.settings.saved);
			// Every control on screen now shows a stale value, so the tab is rebuilt outright.
			this.update();
		} catch (error) {
			this.deps.logger.error('Could not reset the settings', error);
			new Notice(STRINGS.errors.unexpected);
		}
	}

	/* --------------------------------------------------- definition factories -- */

	private toggle(options: {
		key: string;
		name: string;
		desc: string;
		aliases?: string[];
		read: (settings: JemzSettings) => boolean;
		write: (settings: JemzSettings, value: boolean) => void;
	}): SettingDefinitionControl {
		this.bindings.set(options.key, {
			read: options.read,
			coerce: (raw) =>
				typeof raw === 'boolean'
					? (settings: JemzSettings): void => options.write(settings, raw)
					: null,
			immediate: true,
		});

		return {
			name: options.name,
			desc: options.desc,
			aliases: options.aliases,
			control: { type: 'toggle', key: options.key },
		};
	}

	/**
	 * A dropdown over a closed set of identifiers.
	 *
	 * `parse` narrows a candidate back to a stored identifier and returns null for anything
	 * outside the set, which can happen if the data was hand-edited or a future version removed
	 * an option — either way the old value stands rather than an unknown one being persisted.
	 * The check is a real predicate rather than a lookup in `options`, because `'toString' in
	 * options` is true for every plain object and would wave a prototype key straight through.
	 */
	private dropdown<T extends string>(options: {
		key: string;
		name: string;
		desc?: string;
		options: Record<string, string>;
		read: (settings: JemzSettings) => T;
		parse: (raw: string) => T | null;
		write: (settings: JemzSettings, value: T) => void;
	}): SettingDefinitionControl {
		this.bindings.set(options.key, {
			read: options.read,
			coerce: (raw) => {
				const text = asText(raw);
				if (text === null) return null;
				const value = options.parse(text);
				if (value === null) return null;
				return (settings: JemzSettings): void => options.write(settings, value);
			},
			immediate: true,
		});

		return {
			name: options.name,
			desc: options.desc,
			control: { type: 'dropdown', key: options.key, options: options.options },
		};
	}

	/**
	 * A free-text field.
	 *
	 * Empty is refused rather than stored: every caller of these values is a folder or a note
	 * type, and an empty one silently means "the vault root" or "no type at all".
	 */
	private text(options: {
		key: string;
		name: string;
		desc: string;
		transform?: (value: string) => string;
		read: (settings: JemzSettings) => string;
		write: (settings: JemzSettings, value: string) => void;
	}): SettingDefinitionControl {
		this.bindings.set(options.key, {
			read: options.read,
			coerce: (raw) => {
				const text = asText(raw);
				if (text === null) return null;
				const transform = options.transform ?? ((value: string): string => value);
				const value = transform(text.trim());
				if (value.length === 0) return null;
				return (settings: JemzSettings): void => options.write(settings, value);
			},
			immediate: false,
		});

		return {
			name: options.name,
			desc: options.desc,
			control: {
				type: 'text',
				key: options.key,
				defaultValue: options.read(this.deps.settings.get()),
			},
		};
	}

	/** A comma separated field over a stored array. */
	private list(options: {
		key: string;
		name: string;
		desc: string;
		transform?: (entry: string) => string;
		read: (settings: JemzSettings) => readonly string[];
		write: (settings: JemzSettings, value: string[]) => void;
	}): SettingDefinitionControl {
		const read = (settings: JemzSettings): string => formatCommaList(options.read(settings));

		this.bindings.set(options.key, {
			read,
			coerce: (raw) => {
				const text = asText(raw);
				if (text === null) return null;
				const entries = parseCommaList(text, options.transform);
				return (settings: JemzSettings): void => options.write(settings, entries);
			},
			immediate: false,
		});

		return {
			name: options.name,
			desc: options.desc,
			control: {
				type: 'text',
				key: options.key,
				defaultValue: read(this.deps.settings.get()),
			},
		};
	}

	/**
	 * A numeric field.
	 *
	 * `defaultValue` is the value currently in the store rather than a constant, because the
	 * number control falls back to it when the typed text cannot be parsed — which makes
	 * "abc" leave the setting exactly as it was, the behaviour this screen has always had.
	 */
	private number(options: {
		key: string;
		name: string;
		desc: string;
		range: NumericRange;
		step?: number;
		read: (settings: JemzSettings) => number;
		write: (settings: JemzSettings, value: number) => void;
	}): SettingDefinitionControl {
		this.bindings.set(options.key, {
			read: options.read,
			coerce: (raw) => {
				const text = asText(raw);
				if (text === null) return null;
				const parsed = parseNumberInRange(text, options.range);
				// Nothing is stored for unparseable text: the previous value stays, and the
				// field corrects itself the next time the tab is rendered.
				if (parsed === null) return null;
				return (settings: JemzSettings): void => options.write(settings, parsed);
			},
			immediate: false,
		});

		return {
			name: options.name,
			desc: options.desc,
			control: {
				type: 'number',
				key: options.key,
				defaultValue: options.read(this.deps.settings.get()),
				min: options.range.min,
				max: options.range.max,
				step: options.step ?? (options.range.integer === true ? 1 : 'any'),
			},
		};
	}

	/** A slider. Dragging fires per step, so the write stays coalesced. */
	private slider(options: {
		key: string;
		name: string;
		desc: string;
		range: NumericRange;
		step: number;
		read: (settings: JemzSettings) => number;
		write: (settings: JemzSettings, value: number) => void;
	}): SettingDefinitionControl {
		this.bindings.set(options.key, {
			read: options.read,
			coerce: (raw) => {
				const text = asText(raw);
				if (text === null) return null;
				const parsed = parseNumberInRange(text, options.range);
				if (parsed === null) return null;
				return (settings: JemzSettings): void => options.write(settings, parsed);
			},
			immediate: false,
		});

		return {
			name: options.name,
			desc: options.desc,
			control: {
				type: 'slider',
				key: options.key,
				min: options.range.min,
				max: options.range.max,
				step: options.step,
			},
		};
	}

	/* -------------------------------------------------------------- internals -- */

	/**
	 * The control key registry, built if nothing has asked for the definitions yet.
	 *
	 * Obsidian always calls {@link getSettingDefinitions} before it reads a control, but a
	 * caller that reaches straight for a value should get one rather than `undefined`.
	 */
	private ensureBindings(): Map<string, ControlBinding> {
		if (this.bindings.size === 0) this.getSettingDefinitions();
		return this.bindings;
	}

	/**
	 * Apply a change and persist it.
	 *
	 * @param immediate Skip the store's write coalescing.
	 */
	private async persist(
		mutate: (settings: JemzSettings) => void,
		immediate = false,
	): Promise<void> {
		try {
			await this.deps.settings.update(mutate, immediate);
		} catch (error) {
			this.deps.logger.error('Could not save a settings change', error);
			new Notice(STRINGS.errors.unexpected);
		}
	}
}

/** A real anchor, so the URL can be copied, middle-clicked, or opened in a browser. */
function linkRow(name: string, url: string): SettingDefinitionRender {
	return {
		name,
		render: (setting: Setting): void => {
			const anchor = setting.controlEl.createEl('a', { text: url, href: url });
			anchor.setAttrs({ target: '_blank', rel: 'noopener' });
		},
	};
}
