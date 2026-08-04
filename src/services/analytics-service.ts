/**
 * Opt-in, aggregate-only usage counters (addendum 3.4).
 *
 * Three guarantees shape this file:
 *
 *  1. It is off by default and records nothing at all while off. Every public recorder checks
 *     {@link AnalyticsService.isEnabled} before touching a single field, so a user who never
 *     opts in ends up with the exact same empty `AnalyticsData` they started with.
 *  2. Nothing vault-derived can be stored. Event names are matched against
 *     {@link ANALYTICS_EVENTS}, a fixed allow-list of literals defined in this file, so a
 *     caller that accidentally passes a note title, a tag, or a path is rejected rather than
 *     sanitised — there is no code path that turns caller-supplied text into a stored key.
 *     Vault size is reduced to a coarse bucket for the same reason: an exact note count is a
 *     surprisingly good fingerprint.
 *  3. There are no network calls in this module, and nothing here ever sends data anywhere.
 *     The counters live in `data.json` on the user's own device and are viewable and
 *     deletable from Settings.
 */

import { Platform } from 'obsidian';
import type { Logger } from '../core/logger';
import type { SettingsStore } from '../core/settings';
import { structuredCloneSafe } from '../core/settings';
import { STRINGS } from '../core/strings';
import type { AnalyticsData } from '../types/settings';
import { DEFAULT_SETTINGS } from '../types/settings';

/**
 * Every event id the plugin may record.
 *
 * This list is the privacy boundary. Adding an id is a deliberate act; passing anything else
 * is dropped, which is what keeps note titles, tag names, and vault paths out of `data.json`
 * even if a call site is written carelessly.
 */
export const ANALYTICS_EVENTS = [
	'capture-created',
	'inbox-action',
	'triage-session',
	'health-scan',
	'fix-applied',
	'backup-restored',
	'search-run',
	'view-opened',
	'dashboard-opened',
	'settings-opened',
] as const;

/** One of the allow-listed event ids. */
export type AnalyticsEventId = (typeof ANALYTICS_EVENTS)[number];

/** Coarse vault size buckets. The exact note count is never stored. */
export const VAULT_SIZE_BUCKETS = ['0-100', '100-1k', '1k-5k', '5k-10k', '10k+'] as const;

/** One of the coarse vault size buckets. */
export type VaultSizeBucket = (typeof VAULT_SIZE_BUCKETS)[number];

/** Whether `event` is on the allow-list. */
export function isAnalyticsEvent(event: string): event is AnalyticsEventId {
	return (ANALYTICS_EVENTS as readonly string[]).includes(event);
}

/**
 * Reduce a note count to a bucket.
 *
 * Bounds are inclusive at the bottom: a vault of exactly 1,000 notes reports `1k-5k`, so the
 * label always reads as "at least this many".
 */
export function bucketForVaultSize(count: number): VaultSizeBucket {
	if (count < 100) return '0-100';
	if (count < 1_000) return '100-1k';
	if (count < 5_000) return '1k-5k';
	if (count < 10_000) return '5k-10k';
	return '10k+';
}

/** Raised when analytics data could not be deleted. */
export class AnalyticsError extends Error {
	constructor(
		message: string,
		/** Whatever the settings store threw, kept for the console. */
		readonly reason: unknown = null,
	) {
		super(message);
		this.name = 'AnalyticsError';
	}
}

export class AnalyticsService {
	constructor(
		private readonly settings: SettingsStore,
		private readonly logger: Logger,
		/** Injectable clock so tests get deterministic timestamps. */
		private readonly now: () => number = () => Date.now(),
		/**
		 * Injectable platform label. Only ever `desktop` or `mobile` — never a version, a
		 * device name, or anything else that could narrow the user down.
		 */
		private readonly platform: () => string = () => (Platform.isMobile ? 'mobile' : 'desktop'),
	) {}

	/** Whether the user has opted in. False unless they explicitly turned it on. */
	isEnabled(): boolean {
		return this.settings.get().analytics.enabled;
	}

	/**
	 * Count one occurrence of an allow-listed event.
	 *
	 * @returns True when the event was recorded, false when analytics are off or the id is
	 * not on the allow-list.
	 */
	async track(event: string): Promise<boolean> {
		if (!this.isEnabled()) return false;
		const id = this.eventId(event);
		if (id === null) return false;
		return this.record((data) => {
			data.counts[id] = (data.counts[id] ?? 0) + 1;
		});
	}

	/**
	 * Add to the total time spent on an allow-listed event.
	 *
	 * @param ms Elapsed milliseconds. Negative and non-finite values are rejected rather than
	 * clamped, because they mean the caller's timer was wrong and the total would be too.
	 * @returns True when the duration was recorded.
	 */
	async trackDuration(event: string, ms: number): Promise<boolean> {
		if (!this.isEnabled()) return false;
		const id = this.eventId(event);
		if (id === null) return false;
		if (!Number.isFinite(ms) || ms < 0) {
			this.logger.warn('Ignored an analytics duration that was not a positive number.');
			return false;
		}
		return this.record((data) => {
			data.durations[id] = (data.durations[id] ?? 0) + Math.round(ms);
		});
	}

	/**
	 * Store how big the vault is, as a bucket.
	 *
	 * @param count Number of notes. Only the bucket it falls into is kept.
	 * @returns True when the bucket was recorded.
	 */
	async setVaultSize(count: number): Promise<boolean> {
		if (!this.isEnabled()) return false;
		if (!Number.isFinite(count) || count < 0) {
			this.logger.warn('Ignored an analytics vault size that was not a positive number.');
			return false;
		}
		const bucket = bucketForVaultSize(count);
		return this.record((data) => {
			data.vaultSizeBucket = bucket;
		});
	}

	/**
	 * Everything currently stored, as a copy.
	 *
	 * Backs the "view collected data" button, so it is readable whether or not analytics are
	 * enabled — the user is always allowed to inspect what is held about them.
	 */
	snapshot(): AnalyticsData {
		const data = this.settings.get().analytics.data;
		return {
			counts: { ...data.counts },
			durations: { ...data.durations },
			platform: data.platform,
			vaultSizeBucket: data.vaultSizeBucket,
			firstRecordedAt: data.firstRecordedAt,
			lastRecordedAt: data.lastRecordedAt,
		};
	}

	/**
	 * Delete every collected counter.
	 *
	 * Written immediately rather than coalesced: the user pressed "delete my data" and the
	 * deletion has to survive Obsidian being closed a second later.
	 *
	 * @throws {AnalyticsError} when the reset could not be persisted.
	 */
	async clear(): Promise<void> {
		try {
			await this.settings.update((settings) => {
				settings.analytics.data = structuredCloneSafe(DEFAULT_SETTINGS.analytics.data);
			}, true);
		} catch (error) {
			this.logger.error('Could not delete the analytics data', error);
			throw new AnalyticsError(STRINGS.errors.unexpected, error);
		}
		this.logger.info(STRINGS.settings.analyticsDeleted);
	}

	/* -------------------------------------------------------------- internals -- */

	/**
	 * Resolve an event name to an allow-listed id.
	 *
	 * The rejected value is deliberately not echoed into the log: it may be exactly the note
	 * title or vault path this module exists to keep out of the record.
	 */
	private eventId(event: string): AnalyticsEventId | null {
		if (isAnalyticsEvent(event)) return event;
		this.logger.warn('Ignored an analytics event that is not on the allow-list.');
		return null;
	}

	/**
	 * Apply a mutation to the stored counters and persist it.
	 *
	 * Callers gate on {@link isEnabled} before reaching here. The write is coalesced by the
	 * settings store because analytics is the lowest-value data in the plugin and must never
	 * cost a synchronous disk write in the middle of a scan.
	 */
	private async record(mutate: (data: AnalyticsData) => void): Promise<boolean> {
		const timestamp = this.now();
		const platform = this.platform();
		try {
			await this.settings.update((settings) => {
				const data = settings.analytics.data;
				mutate(data);
				data.platform = platform;
				if (data.firstRecordedAt === null) data.firstRecordedAt = timestamp;
				data.lastRecordedAt = timestamp;
			});
			return true;
		} catch (error) {
			this.logger.error('Could not persist the analytics data', error);
			return false;
		}
	}
}
