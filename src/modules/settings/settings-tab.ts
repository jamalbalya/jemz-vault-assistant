/**
 * The plugin's settings tab (main spec 8.4, addendum 3.4).
 *
 * Three rules shape this file:
 *
 *  1. Every control writes straight through {@link SettingsStore.update}. There is no "Apply"
 *     button and no local draft copy, because a settings screen that can be closed mid-edit
 *     must never leave the user wondering whether their change stuck.
 *  2. Nothing garbage-looking is ever persisted. Numbers are parsed, rejected when they are
 *     not finite, and clamped into a range the rest of the plugin can survive; comma
 *     separated fields drop blank entries; folder and type fields refuse to store an empty
 *     string. `data.json` is plain JSON a user can hand-edit, and this screen is the one place
 *     that decides what a legal value looks like.
 *  3. Copy comes from {@link STRINGS} only. The two exceptions are log levels and scan
 *     frequencies, whose labels are derived from the stored identifiers with
 *     {@link capitalize} rather than duplicated as a second set of literals — a translation
 *     changes the string table, and these labels would only ever restate the enum.
 *
 * Teardown: `PluginSettingTab` is not a `Component`, so it has no `registerDomEvent`. Every
 * listener this file adds is therefore either attached by Obsidian's own `Setting` components
 * (which live and die with the elements inside `containerEl`) or registered through
 * {@link JemzSettingTab.listen}, which {@link JemzSettingTab.hide} unwinds. Nothing is ever
 * attached to `document` or `window`, so closing the tab leaves nothing behind.
 */

import {
	Notice,
	Platform,
	PluginSettingTab,
	Setting,
	type App,
	type ButtonComponent,
	type Plugin,
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
 * Everything the plugin has recorded about this user, as plain text.
 *
 * The point of the button that opens this is trust: a user who is asked to share usage data
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

	/** Listeners this file attached itself, unwound by {@link hide}. */
	private readonly cleanups: (() => void)[] = [];

	/** Sub-regions redrawn in place so clearing a list does not scroll the whole tab away. */
	private ignoreListEl: HTMLElement | null = null;
	private actionLogEl: HTMLElement | null = null;

	constructor(app: App, plugin: Plugin, deps: SettingsTabDeps) {
		super(app, plugin);
		this.hostPlugin = plugin;
		this.deps = deps;
	}

	/**
	 * Build the whole tab.
	 *
	 * Obsidian calls this every time the tab is opened, so it starts by tearing down whatever
	 * the previous visit left behind. A render that throws replaces the half-built screen with
	 * an error state rather than a blank pane, because a settings tab that shows nothing gives
	 * the user no way back to their configuration.
	 */
	override display(): void {
		this.teardown();
		const { containerEl } = this;
		containerEl.empty();

		try {
			this.renderGeneral(containerEl);
			this.renderCaptureAndInbox(containerEl);
			this.renderVaultHealth(containerEl);
			this.renderSmartRetrieval(containerEl);
			this.renderAnalytics(containerEl);
			this.renderAbout(containerEl);
		} catch (error) {
			this.deps.logger.error('Could not render the settings tab', error);
			containerEl.empty();
			renderErrorState(containerEl, {
				title: STRINGS.errors.unexpected,
				retryLabel: STRINGS.common.retry,
				onRetry: (): void => this.display(),
			});
		}
	}

	/** Release listeners and drop references to the removed DOM. */
	override hide(): void {
		this.teardown();
		this.ignoreListEl = null;
		this.actionLogEl = null;
		super.hide();
	}

	/* ------------------------------------------------------------- 1. general -- */

	private renderGeneral(parent: HTMLElement): void {
		new Setting(parent).setName(STRINGS.settings.general).setHeading();
		const { general } = this.deps.settings.get();

		new Setting(parent).setName(STRINGS.settings.modulesHeading).setHeading();

		this.addToggle(parent, {
			name: STRINGS.settings.moduleCapture,
			desc: STRINGS.settings.moduleCaptureDesc,
			value: general.modules.capture,
			apply: (settings, value) => {
				settings.general.modules.capture = value;
			},
		});
		this.addToggle(parent, {
			name: STRINGS.settings.moduleHealth,
			desc: STRINGS.settings.moduleHealthDesc,
			value: general.modules.health,
			apply: (settings, value) => {
				settings.general.modules.health = value;
			},
		});
		this.addToggle(parent, {
			name: STRINGS.settings.moduleRetrieval,
			desc: STRINGS.settings.moduleRetrievalDesc,
			value: general.modules.retrieval,
			apply: (settings, value) => {
				settings.general.modules.retrieval = value;
			},
		});

		this.addToggle(parent, {
			name: STRINGS.settings.showRibbon,
			desc: STRINGS.settings.showRibbonDesc,
			value: general.showRibbonIcon,
			apply: (settings, value) => {
				settings.general.showRibbonIcon = value;
			},
		});
		this.addToggle(parent, {
			name: STRINGS.settings.showStatusBar,
			desc: STRINGS.settings.showStatusBarDesc,
			value: general.showStatusBar,
			apply: (settings, value) => {
				settings.general.showStatusBar = value;
			},
		});

		new Setting(parent)
			.setName(STRINGS.settings.logLevel)
			.setDesc(STRINGS.settings.logLevelDesc)
			.addDropdown((dropdown) => {
				dropdown.addOptions(optionsFor(LOG_LEVELS));
				dropdown.setValue(general.logLevel);
				dropdown.onChange((value) => {
					if (!isLogLevel(value)) return;
					void this.persist((settings) => {
						settings.general.logLevel = value;
					}, true);
				});
			});

		this.addNumber(parent, {
			name: STRINGS.settings.inboxPageSize,
			desc: STRINGS.settings.inboxPageSizeDesc,
			value: general.inboxPageSize,
			range: RANGES.inboxPageSize,
			apply: (settings, value) => {
				settings.general.inboxPageSize = value;
			},
		});

		// "Sort by" is shared with the Find module rather than duplicated: it is the same
		// control with the same meaning, and a translation should only have to write it once.
		new Setting(parent).setName(STRINGS.find.sortLabel).addDropdown((dropdown) => {
			dropdown.addOption(SORT_NEWEST, STRINGS.inbox.sortNewest);
			dropdown.addOption(SORT_OLDEST, STRINGS.inbox.sortOldest);
			dropdown.setValue(general.inboxNewestFirst ? SORT_NEWEST : SORT_OLDEST);
			dropdown.onChange((value) => {
				void this.persist((settings) => {
					settings.general.inboxNewestFirst = value === SORT_NEWEST;
				}, true);
			});
		});
	}

	/* --------------------------------------------------- 2. capture and inbox -- */

	private renderCaptureAndInbox(parent: HTMLElement): void {
		new Setting(parent).setName(STRINGS.settings.captureInbox).setHeading();
		const { capture } = this.deps.settings.get();

		this.addText(parent, {
			name: STRINGS.settings.inboxFolder,
			desc: STRINGS.settings.inboxFolderDesc,
			value: capture.inboxFolder,
			transform: normalizeVaultPath,
			apply: (settings, value) => {
				settings.capture.inboxFolder = value;
			},
		});
		this.addText(parent, {
			name: STRINGS.settings.archiveFolder,
			desc: STRINGS.settings.archiveFolderDesc,
			value: capture.archiveFolder,
			transform: normalizeVaultPath,
			apply: (settings, value) => {
				settings.capture.archiveFolder = value;
			},
		});
		this.addText(parent, {
			name: STRINGS.settings.attachmentArchiveFolder,
			desc: STRINGS.settings.attachmentArchiveFolderDesc,
			value: capture.attachmentArchiveFolder,
			transform: normalizeVaultPath,
			apply: (settings, value) => {
				settings.capture.attachmentArchiveFolder = value;
			},
		});

		this.addList(parent, {
			name: STRINGS.settings.defaultTags,
			desc: STRINGS.settings.defaultTagsDesc,
			value: capture.defaultTags,
			// Tags are stored without the leading hash, so a user who types one is not punished.
			transform: (entry) => entry.replace(/^#+/, ''),
			apply: (settings, value) => {
				settings.capture.defaultTags = value;
			},
		});

		this.addText(parent, {
			name: STRINGS.settings.defaultType,
			desc: STRINGS.settings.defaultTypeDesc,
			value: capture.defaultType,
			apply: (settings, value) => {
				settings.capture.defaultType = value;
			},
		});

		this.addToggle(parent, {
			name: STRINGS.settings.autoCreateFolders,
			desc: STRINGS.settings.autoCreateFoldersDesc,
			value: capture.autoCreateFolders,
			apply: (settings, value) => {
				settings.capture.autoCreateFolders = value;
			},
		});
	}

	/* -------------------------------------------------------- 3. vault health -- */

	private renderVaultHealth(parent: HTMLElement): void {
		new Setting(parent).setName(STRINGS.settings.vaultHealth).setHeading();
		const { health } = this.deps.settings.get();

		new Setting(parent)
			.setName(STRINGS.settings.scanFrequency)
			.setDesc(STRINGS.settings.scanFrequencyDesc)
			.addDropdown((dropdown) => {
				dropdown.addOptions(optionsFor(SCAN_FREQUENCIES));
				dropdown.setValue(health.scanFrequency);
				dropdown.onChange((value) => {
					if (!isScanFrequency(value)) return;
					void this.persist((settings) => {
						settings.health.scanFrequency = value;
					}, true);
				});
			});

		this.addToggle(parent, {
			name: STRINGS.settings.autoScanOnStartup,
			desc: STRINGS.settings.autoScanOnStartupDesc,
			value: health.autoScanOnStartup,
			apply: (settings, value) => {
				settings.health.autoScanOnStartup = value;
			},
		});

		this.addList(parent, {
			name: STRINGS.settings.excludedFolders,
			desc: STRINGS.settings.excludedFoldersDesc,
			value: health.excludedFolders,
			transform: normalizeVaultPath,
			apply: (settings, value) => {
				settings.health.excludedFolders = value;
			},
		});
		this.addList(parent, {
			name: STRINGS.settings.excludedTags,
			desc: STRINGS.settings.excludedTagsDesc,
			value: health.excludedTags,
			transform: (entry) => entry.replace(/^#+/, ''),
			apply: (settings, value) => {
				settings.health.excludedTags = value;
			},
		});
		this.addList(parent, {
			name: STRINGS.settings.excludedExtensions,
			desc: STRINGS.settings.excludedExtensionsDesc,
			value: health.excludedExtensions,
			// Stored lower-case and without the dot, which is how every comparison sees them.
			transform: (entry) => entry.replace(/^\.+/, '').toLowerCase(),
			apply: (settings, value) => {
				settings.health.excludedExtensions = value;
			},
		});

		this.addToggle(parent, {
			name: STRINGS.settings.excludeInbox,
			desc: STRINGS.settings.excludeInboxDesc,
			value: health.excludeInbox,
			apply: (settings, value) => {
				settings.health.excludeInbox = value;
			},
		});
		this.addToggle(parent, {
			name: STRINGS.settings.excludeArchived,
			desc: STRINGS.settings.excludeArchivedDesc,
			value: health.excludeArchived,
			apply: (settings, value) => {
				settings.health.excludeArchived = value;
			},
		});

		this.addList(parent, {
			name: STRINGS.settings.requiredFields,
			desc: STRINGS.settings.requiredFieldsDesc,
			value: health.requiredFrontmatterFields,
			apply: (settings, value) => {
				settings.health.requiredFrontmatterFields = value;
			},
		});

		this.addNumber(parent, {
			name: STRINGS.settings.largeFileThreshold,
			desc: STRINGS.settings.largeFileThresholdDesc,
			// Stored in bytes, shown in megabytes: nobody thinks about their vault in bytes.
			value: health.largeFileThresholdBytes / BYTES_PER_MB,
			range: RANGES.largeFileMb,
			step: '0.1',
			apply: (settings, value) => {
				settings.health.largeFileThresholdBytes = Math.round(value * BYTES_PER_MB);
			},
		});

		this.renderDetectorToggles(parent);
		this.renderScoreWeights(parent);
		this.renderIgnoreListsSection(parent);
	}

	private renderDetectorToggles(parent: HTMLElement): void {
		new Setting(parent)
			.setName(STRINGS.settings.detectorsHeading)
			.setDesc(STRINGS.settings.detectorsDesc)
			.setHeading();

		const { detectors } = this.deps.settings.get().health;
		for (const type of ISSUE_TYPES) {
			this.addToggle(parent, {
				name: STRINGS.health.types[type],
				desc: STRINGS.health.typeDescriptions[type],
				value: detectors[type],
				apply: (settings, value) => {
					settings.health.detectors[type] = value;
				},
			});
		}
	}

	/**
	 * Per-issue and per-category score weights.
	 *
	 * Rendered as a compact grid rather than eighteen `Setting` rows, which would bury every
	 * other health option under a wall of identical controls.
	 */
	private renderScoreWeights(parent: HTMLElement): void {
		new Setting(parent)
			.setName(STRINGS.settings.scoreWeights)
			.setDesc(STRINGS.settings.scoreWeightsDesc)
			.setHeading();

		const weights = this.deps.settings.get().health.weights;
		const grid = parent.createDiv({ cls: 'jva-settings__weights' });

		for (const type of ISSUE_TYPES) {
			const label = STRINGS.health.types[type];
			const row = grid.createDiv({ cls: 'jva-settings__weight-row' });
			row.createSpan({ text: label });

			this.addWeightInput(row, {
				label: STRINGS.settings.weightPer,
				name: `${label} — ${STRINGS.settings.weightPer}`,
				value: weights[type].per,
				apply: (settings, value) => {
					settings.health.weights[type] = {
						per: value,
						max: settings.health.weights[type].max,
					};
				},
			});
			this.addWeightInput(row, {
				label: STRINGS.settings.weightMax,
				name: `${label} — ${STRINGS.settings.weightMax}`,
				value: weights[type].max,
				apply: (settings, value) => {
					settings.health.weights[type] = {
						per: settings.health.weights[type].per,
						max: value,
					};
				},
			});
		}
	}

	private addWeightInput(
		row: HTMLElement,
		options: {
			label: string;
			name: string;
			value: number;
			apply: (settings: JemzSettings, value: number) => void;
		},
	): void {
		const wrapper = row.createEl('label');
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

		this.listen(input, 'change', () => {
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
		});
	}

	private renderIgnoreListsSection(parent: HTMLElement): void {
		new Setting(parent)
			.setName(STRINGS.settings.ignoreListsHeading)
			.setDesc(STRINGS.settings.ignoreListsDesc)
			.setHeading();

		this.ignoreListEl = parent.createDiv();
		this.renderIgnoreLists();
	}

	/** Redraw the ignore lists in place, so clearing one does not rebuild the whole tab. */
	private renderIgnoreLists(): void {
		const container = this.ignoreListEl;
		if (!container) return;
		container.empty();

		const counts = this.deps.health.ignoredCounts();
		const active = ISSUE_TYPES.filter((type) => counts[type] > 0);
		if (active.length === 0) {
			renderInlineEmpty(container, STRINGS.settings.ignoredItems(0));
			return;
		}

		for (const type of active) {
			new Setting(container)
				.setName(STRINGS.health.types[type])
				.setDesc(STRINGS.settings.ignoredItems(counts[type]))
				.addButton((button) => {
					button.setButtonText(STRINGS.settings.clearIgnored);
					button.onClick(() => void this.clearIgnored(type));
				});
		}
	}

	private async clearIgnored(type: IssueType): Promise<void> {
		try {
			await this.deps.health.clearIgnored(type);
			this.renderIgnoreLists();
		} catch (error) {
			this.deps.logger.error(`Could not clear the ignore list for "${type}"`, error);
			new Notice(STRINGS.errors.unexpected);
		}
	}

	/* ----------------------------------------------------- 4. smart retrieval -- */

	private renderSmartRetrieval(parent: HTMLElement): void {
		new Setting(parent).setName(STRINGS.settings.smartRetrieval).setHeading();
		const { retrieval } = this.deps.settings.get();

		this.addNumber(parent, {
			name: STRINGS.settings.staleThreshold,
			desc: STRINGS.settings.staleThresholdDesc,
			value: retrieval.staleThresholdDays,
			range: RANGES.staleDays,
			apply: (settings, value) => {
				settings.retrieval.staleThresholdDays = value;
			},
		});

		new Setting(parent)
			.setName(STRINGS.settings.fuzzySensitivity)
			.setDesc(STRINGS.settings.fuzzySensitivityDesc)
			.addSlider((slider) => {
				slider.setLimits(RANGES.fuzzy.min, RANGES.fuzzy.max, 0.05);
				slider.setValue(retrieval.fuzzySensitivity);
				slider.setDynamicTooltip();
				slider.onChange((value) => {
					const parsed = parseNumberInRange(String(value), RANGES.fuzzy);
					if (parsed === null) return;
					// Dragging fires per step, so this write is coalesced rather than immediate.
					void this.persist((settings) => {
						settings.retrieval.fuzzySensitivity = parsed;
					});
				});
			});

		this.addNumber(parent, {
			name: STRINGS.settings.resultsPerPage,
			desc: STRINGS.settings.resultsPerPageDesc,
			value: retrieval.resultsPerPage,
			range: RANGES.resultsPerPage,
			apply: (settings, value) => {
				settings.retrieval.resultsPerPage = value;
			},
		});

		this.addToggle(parent, {
			name: STRINGS.settings.excludeArchivedFromViews,
			desc: STRINGS.settings.excludeArchivedFromViewsDesc,
			value: retrieval.excludeArchivedFromViews,
			apply: (settings, value) => {
				settings.retrieval.excludeArchivedFromViews = value;
			},
		});
	}

	/* ----------------------------------------------------------- 5. analytics -- */

	private renderAnalytics(parent: HTMLElement): void {
		new Setting(parent).setName(STRINGS.settings.analytics).setHeading();

		// Read live rather than from a captured copy: this toggle is the promise the privacy
		// copy makes, and it must always show what is actually stored.
		this.addToggle(parent, {
			name: STRINGS.settings.analyticsEnabled,
			desc: STRINGS.settings.analyticsEnabledDesc,
			value: this.deps.settings.get().analytics.enabled,
			apply: (settings, value) => {
				settings.analytics.enabled = value;
			},
		});

		new Setting(parent).setName(STRINGS.settings.analyticsView).addButton((button) => {
			button.setButtonText(STRINGS.common.details);
			button.onClick(() => {
				new AnalyticsDataModal(this.app, this.deps.analytics.snapshot()).open();
			});
		});

		new Setting(parent).setName(STRINGS.settings.analyticsDelete).addButton((button) => {
			button.setButtonText(STRINGS.common.delete);
			button.setWarning();
			button.onClick(() => void this.deleteAnalytics());
		});
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

	private renderAbout(parent: HTMLElement): void {
		new Setting(parent).setName(STRINGS.settings.about).setHeading();

		new Setting(parent)
			.setName(STRINGS.settings.aboutVersion)
			.setDesc(this.hostPlugin.manifest.version);

		this.addLink(parent, STRINGS.settings.aboutRepository, LINKS.repository);
		this.addLink(parent, STRINGS.settings.aboutIssues, LINKS.issues);
		this.addLink(parent, STRINGS.settings.aboutChangelog, LINKS.changelog);

		this.renderActionLog(parent);

		new Setting(parent)
			.setName(STRINGS.commands.restoreLastBackup)
			.setDesc(STRINGS.preview.restoreHint)
			.addButton((button) => {
				button.setButtonText(STRINGS.commands.restoreLastBackup);
				button.onClick(() => void this.restoreLatestBackup(button));
			});

		new Setting(parent)
			.setName(STRINGS.settings.resetSettings)
			.setDesc(STRINGS.settings.resetSettingsDesc)
			.addButton((button) => {
				button.setButtonText(STRINGS.settings.resetSettings);
				button.setWarning();
				button.onClick(() => void this.resetSettings());
			});
	}

	/** A real anchor, so the URL can be copied, middle-clicked, or opened in a browser. */
	private addLink(parent: HTMLElement, name: string, url: string): void {
		const setting = new Setting(parent).setName(name);
		const anchor = setting.controlEl.createEl('a', { text: url, href: url });
		anchor.setAttrs({ target: '_blank', rel: 'noopener' });
	}

	private renderActionLog(parent: HTMLElement): void {
		new Setting(parent)
			.setName(STRINGS.settings.actionLogHeading)
			.setDesc(STRINGS.settings.actionLogDesc)
			.setHeading();

		new Setting(parent).setName(STRINGS.settings.actionLogClear).addButton((button) => {
			button.setButtonText(STRINGS.settings.actionLogClear);
			button.onClick(() => void this.clearActionLog());
		});

		this.actionLogEl = parent.createDiv({ cls: 'jva-action-log' });
		this.renderActionLogEntries();
	}

	/**
	 * Draw the newest entries.
	 *
	 * Wrapped in its own try/catch because `data.json` is hand-editable: one entry with a
	 * broken timestamp must not take the entire settings screen down with it.
	 */
	private renderActionLogEntries(): void {
		const container = this.actionLogEl;
		if (!container) return;
		container.empty();

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
				onRetry: (): void => this.renderActionLogEntries(),
			});
		}
	}

	private async clearActionLog(): Promise<void> {
		try {
			await this.deps.actionLog.clear();
			new Notice(STRINGS.settings.actionLogCleared);
			this.renderActionLogEntries();
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
			this.display();
		} catch (error) {
			this.deps.logger.error('Could not reset the settings', error);
			new Notice(STRINGS.errors.unexpected);
		}
	}

	/* ------------------------------------------------------ control factories -- */

	private addToggle(
		parent: HTMLElement,
		options: {
			name: string;
			desc: string;
			value: boolean;
			apply: (settings: JemzSettings, value: boolean) => void;
		},
	): void {
		new Setting(parent)
			.setName(options.name)
			.setDesc(options.desc)
			.addToggle((toggle) => {
				toggle.setValue(options.value);
				toggle.onChange((value) => {
					// A discrete choice writes through immediately: it is one disk write, and a
					// failed one has to be reported while the user still remembers the click.
					void this.persist((settings) => options.apply(settings, value), true);
				});
			});
	}

	/**
	 * A free-text field.
	 *
	 * Empty is refused rather than stored: every caller of these values is a folder or a note
	 * type, and an empty one silently means "the vault root" or "no type at all".
	 */
	private addText(
		parent: HTMLElement,
		options: {
			name: string;
			desc: string;
			value: string;
			transform?: (value: string) => string;
			apply: (settings: JemzSettings, value: string) => void;
		},
	): void {
		new Setting(parent)
			.setName(options.name)
			.setDesc(options.desc)
			.addText((text) => {
				text.setValue(options.value);
				text.onChange((raw) => {
					const transform = options.transform ?? ((value: string): string => value);
					const value = transform(raw.trim());
					if (value.length === 0) return;
					void this.persist((settings) => options.apply(settings, value));
				});
			});
	}

	private addList(
		parent: HTMLElement,
		options: {
			name: string;
			desc: string;
			value: readonly string[];
			transform?: (entry: string) => string;
			apply: (settings: JemzSettings, value: string[]) => void;
		},
	): void {
		new Setting(parent)
			.setName(options.name)
			.setDesc(options.desc)
			.addText((text) => {
				text.setValue(formatCommaList(options.value));
				text.onChange((raw) => {
					const entries = parseCommaList(raw, options.transform);
					void this.persist((settings) => options.apply(settings, entries));
				});
			});
	}

	private addNumber(
		parent: HTMLElement,
		options: {
			name: string;
			desc: string;
			value: number;
			range: NumericRange;
			step?: string;
			apply: (settings: JemzSettings, value: number) => void;
		},
	): void {
		new Setting(parent)
			.setName(options.name)
			.setDesc(options.desc)
			.addText((text) => {
				text.setValue(String(options.value));
				// A number input brings up the numeric keypad on mobile and gives the browser
				// its own guard rails before this code ever sees the value.
				text.inputEl.setAttrs({
					type: 'number',
					min: String(options.range.min),
					max: String(options.range.max),
					step: options.step ?? (options.range.integer === true ? '1' : 'any'),
				});
				text.onChange((raw) => {
					const parsed = parseNumberInRange(raw, options.range);
					// Nothing is stored for unparseable text: the previous value stays, and the
					// field corrects itself the next time the tab is opened.
					if (parsed === null) return;
					void this.persist((settings) => options.apply(settings, parsed));
				});
			});
	}

	/* -------------------------------------------------------------- internals -- */

	/**
	 * Apply a change and persist it.
	 *
	 * @param immediate Skip the store's write coalescing. Used for discrete controls, where
	 * one interaction is one write and a failure must surface as a Notice; text fields and
	 * sliders stay coalesced so a keystroke or a drag is not a disk write each.
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

	/** Add a DOM listener that {@link hide} will remove. */
	private listen<K extends keyof HTMLElementEventMap>(
		el: HTMLElement,
		type: K,
		handler: (event: HTMLElementEventMap[K]) => void,
	): void {
		el.addEventListener(type, handler as EventListener);
		this.cleanups.push(() => el.removeEventListener(type, handler as EventListener));
	}

	/** Run and forget every registered cleanup. */
	private teardown(): void {
		for (const cleanup of this.cleanups.splice(0)) cleanup();
	}
}
