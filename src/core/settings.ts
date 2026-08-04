/**
 * Settings persistence.
 *
 * Loaded data is deep-merged onto {@link DEFAULT_SETTINGS} so a user who upgrades never
 * loses values and never misses newly added keys. Writes are coalesced, because settings
 * change on every keystroke in a text field.
 */

import type { JemzSettings } from '../types/settings';
import { DEFAULT_SETTINGS, SETTINGS_VERSION } from '../types/settings';
import { MAX_ACTION_LOG_ENTRIES, MAX_BACKUPS } from './constants';
import type { EventBus } from './event-bus';
import type { Logger } from './logger';
import { errorMessage } from './logger';

/** The subset of the Obsidian Plugin API this store needs, so it can be tested standalone. */
export interface SettingsHost {
	loadData(): Promise<unknown>;
	saveData(data: unknown): Promise<void>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Recursively merge `source` onto `defaults`.
 *
 * Arrays and primitives from `source` replace the default outright; nested plain objects
 * merge key by key. Keys absent from `defaults` are still kept, so custom frontmatter
 * templates and per-view state survive.
 */
export function mergeDefaults<T>(defaults: T, source: unknown): T {
	if (!isPlainObject(source) || !isPlainObject(defaults)) {
		return source === undefined ? defaults : (source as T);
	}

	const result: Record<string, unknown> = { ...defaults };
	for (const [key, value] of Object.entries(source)) {
		if (value === undefined) continue;
		const defaultValue = (defaults as Record<string, unknown>)[key];
		if (isPlainObject(defaultValue) && isPlainObject(value)) {
			result[key] = mergeDefaults(defaultValue, value);
		} else {
			result[key] = value;
		}
	}
	return result as T;
}

/** Bring persisted data forward to the current schema version. */
export function migrateSettings(raw: unknown, logger?: Logger): unknown {
	if (!isPlainObject(raw)) return {};
	const version = typeof raw.version === 'number' ? raw.version : 0;
	if (version === SETTINGS_VERSION) return raw;
	if (version > SETTINGS_VERSION) {
		logger?.warn(
			`Settings were written by a newer version (${version} > ${SETTINGS_VERSION}). Unknown keys are preserved.`,
		);
		return raw;
	}
	// v0 (pre-release data with no version marker) needs no field changes yet; the deep
	// merge fills in everything added since. Future migrations chain from here.
	return { ...raw, version: SETTINGS_VERSION };
}

export class SettingsStore {
	private settings: JemzSettings = structuredCloneSafe(DEFAULT_SETTINGS);
	private saveTimer: number | null = null;
	private savePromise: Promise<void> | null = null;

	constructor(
		private readonly host: SettingsHost,
		private readonly bus: EventBus,
		private readonly logger: Logger,
		/** Milliseconds to coalesce rapid writes. Zero writes synchronously. */
		private readonly saveDelayMs = 250,
	) {}

	/** Read persisted settings, merge onto defaults, and cache the result. */
	async load(): Promise<JemzSettings> {
		try {
			const raw = await this.host.loadData();
			const migrated = migrateSettings(raw, this.logger);
			this.settings = mergeDefaults(structuredCloneSafe(DEFAULT_SETTINGS), migrated);
			this.clampCollections();
		} catch (error) {
			this.logger.error('Could not load settings, falling back to defaults', error);
			this.settings = structuredCloneSafe(DEFAULT_SETTINGS);
		}
		this.logger.setLevel(this.settings.general.logLevel);
		return this.settings;
	}

	/** The live settings object. Mutate only through {@link update}. */
	get(): JemzSettings {
		return this.settings;
	}

	/**
	 * Apply a mutation and persist it.
	 *
	 * @param mutator Receives the live settings object.
	 * @param immediate Skip write coalescing, for changes that must survive a crash.
	 */
	async update(mutator: (settings: JemzSettings) => void, immediate = false): Promise<void> {
		mutator(this.settings);
		this.clampCollections();
		this.logger.setLevel(this.settings.general.logLevel);
		this.bus.emit('settings-changed', { settings: this.settings });
		await (immediate ? this.saveNow() : this.scheduleSave());
	}

	/** Persist immediately, cancelling any pending coalesced write. */
	async saveNow(): Promise<void> {
		if (this.saveTimer !== null) {
			window.clearTimeout(this.saveTimer);
			this.saveTimer = null;
		}
		try {
			this.savePromise = this.host.saveData(this.settings);
			await this.savePromise;
		} catch (error) {
			this.logger.error('Could not save settings', error);
			throw new Error(`Could not save settings: ${errorMessage(error)}`);
		} finally {
			this.savePromise = null;
		}
	}

	/** Queue a write, collapsing repeated calls inside the delay window. */
	private scheduleSave(): Promise<void> {
		if (this.saveDelayMs <= 0) return this.saveNow();
		if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
		return new Promise<void>((resolve) => {
			this.saveTimer = window.setTimeout(() => {
				this.saveTimer = null;
				void this.saveNow()
					.catch(() => undefined)
					.then(() => resolve());
			}, this.saveDelayMs);
		});
	}

	/** Restore every value to its default and persist. */
	async reset(): Promise<void> {
		this.settings = structuredCloneSafe(DEFAULT_SETTINGS);
		this.bus.emit('settings-changed', { settings: this.settings });
		await this.saveNow();
	}

	/** Flush any pending write. Called on plugin unload. */
	async flush(): Promise<void> {
		if (this.saveTimer !== null) await this.saveNow();
		else if (this.savePromise) await this.savePromise;
	}

	/** Enforce the retention limits so data.json cannot grow without bound. */
	private clampCollections(): void {
		if (this.settings.actionLog.length > MAX_ACTION_LOG_ENTRIES) {
			this.settings.actionLog = this.settings.actionLog.slice(0, MAX_ACTION_LOG_ENTRIES);
		}
		if (this.settings.backups.length > MAX_BACKUPS) {
			this.settings.backups = this.settings.backups.slice(0, MAX_BACKUPS);
		}
	}
}

/**
 * Deep clone that works on every platform Obsidian runs on.
 * `structuredClone` is missing on some older mobile webviews.
 */
export function structuredCloneSafe<T>(value: T): T {
	if (typeof structuredClone === 'function') {
		try {
			return structuredClone(value);
		} catch {
			// Fall through to the JSON path for values structuredClone rejects.
		}
	}
	return JSON.parse(JSON.stringify(value)) as T;
}
