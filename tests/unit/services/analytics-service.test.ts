/**
 * Analytics is the one part of the plugin where a bug is a privacy incident rather than an
 * inconvenience, so the tests are written as promises to the user: nothing is recorded while
 * the feature is off, no caller-supplied text ever becomes a stored key, the vault size is
 * only ever a bucket, and this module contains no way to send anything anywhere.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../../helpers/vault-fixture';
import { EventBus } from '../../../src/core/event-bus';
import { Logger } from '../../../src/core/logger';
import type { SettingsHost } from '../../../src/core/settings';
import { SettingsStore } from '../../../src/core/settings';
import {
	ANALYTICS_EVENTS,
	AnalyticsError,
	AnalyticsService,
	bucketForVaultSize,
	isAnalyticsEvent,
	VAULT_SIZE_BUCKETS,
} from '../../../src/services/analytics-service';
import { DEFAULT_SETTINGS } from '../../../src/types/settings';

/** Records what the service logged without printing anything during the run. */
class RecordingLogger extends Logger {
	readonly errors: string[] = [];
	readonly warnings: string[] = [];

	constructor() {
		super('silent', 'test');
	}

	override error(message: string, ...details: unknown[]): void {
		this.errors.push(message);
		super.error(message, ...details);
	}

	override warn(message: string, ...details: unknown[]): void {
		this.warnings.push(message);
		super.warn(message, ...details);
	}
}

/** Stands in for the Obsidian plugin's own `loadData`/`saveData`. */
class MemoryHost implements SettingsHost {
	data: unknown = null;
	failSaves = false;

	async loadData(): Promise<unknown> {
		return this.data;
	}

	async saveData(data: unknown): Promise<void> {
		if (this.failSaves) throw new Error('EROFS: read-only vault');
		this.data = JSON.parse(JSON.stringify(data));
	}
}

interface Harness {
	host: MemoryHost;
	store: SettingsStore;
	logger: RecordingLogger;
	service: AnalyticsService;
	clock: { value: number };
	enable(): Promise<void>;
}

const START = new Date(2026, 5, 15, 12, 0, 0).getTime();

async function harness(platform = 'desktop'): Promise<Harness> {
	const host = new MemoryHost();
	const logger = new RecordingLogger();
	const store = new SettingsStore(host, new EventBus(), logger, 0);
	await store.load();
	await store.update((settings) => {
		settings.general.logLevel = 'silent';
	}, true);

	const clock = { value: START };
	const service = new AnalyticsService(
		store,
		logger,
		() => clock.value,
		() => platform,
	);
	return {
		host,
		store,
		logger,
		service,
		clock,
		enable: async () => {
			await store.update((settings) => {
				settings.analytics.enabled = true;
			}, true);
		},
	};
}

describe('analytics defaults', () => {
	it('ships off', () => {
		expect(DEFAULT_SETTINGS.analytics.enabled).toBe(false);
	});

	it('starts with an empty data set', async () => {
		const h = await harness();
		expect(h.service.isEnabled()).toBe(false);
		expect(h.service.snapshot()).toEqual({
			counts: {},
			durations: {},
			platform: 'unknown',
			vaultSizeBucket: 'unknown',
			firstRecordedAt: null,
			lastRecordedAt: null,
		});
	});
});

describe('analytics while disabled', () => {
	let h: Harness;

	beforeEach(async () => {
		h = await harness();
	});

	it('records absolutely nothing', async () => {
		expect(await h.service.track('health-scan')).toBe(false);
		expect(await h.service.trackDuration('health-scan', 1234)).toBe(false);
		expect(await h.service.setVaultSize(7_500)).toBe(false);

		expect(h.service.snapshot()).toEqual({
			counts: {},
			durations: {},
			platform: 'unknown',
			vaultSizeBucket: 'unknown',
			firstRecordedAt: null,
			lastRecordedAt: null,
		});
		expect(h.store.get().analytics.data.firstRecordedAt).toBeNull();
	});

	it('does not even stamp a platform or a timestamp', async () => {
		await h.service.track('capture-created');
		const data = h.store.get().analytics.data;
		expect(data.platform).toBe('unknown');
		expect(data.lastRecordedAt).toBeNull();
	});
});

describe('analytics event allow-list', () => {
	let h: Harness;

	beforeEach(async () => {
		h = await harness();
		await h.enable();
	});

	it('accepts every allow-listed id', async () => {
		for (const event of ANALYTICS_EVENTS) {
			expect(await h.service.track(event)).toBe(true);
		}
		expect(Object.keys(h.service.snapshot().counts).sort()).toEqual(
			[...ANALYTICS_EVENTS].sort(),
		);
	});

	it('rejects a vault path posing as an event name', async () => {
		expect(await h.service.track('01-Projects/Project Alpha/Project Alpha.md')).toBe(false);
		expect(h.service.snapshot().counts).toEqual({});
	});

	it('rejects note titles, tag names, and near-miss ids', async () => {
		for (const event of [
			'My Secret Note',
			'#personal-finance',
			'health-scan/notes/x.md',
			'health-scan ',
			'HEALTH-SCAN',
			'',
		]) {
			expect(await h.service.track(event)).toBe(false);
		}
		expect(h.service.snapshot().counts).toEqual({});
		expect(h.service.snapshot().firstRecordedAt).toBeNull();
	});

	it('never echoes the rejected value into the log', async () => {
		await h.service.track('Notes/Very Private Thing.md');
		expect(h.logger.warnings.length).toBeGreaterThan(0);
		expect(h.logger.warnings.some((message) => message.includes('Very Private Thing'))).toBe(
			false,
		);
	});

	it('exposes the allow-list as a type guard', () => {
		expect(isAnalyticsEvent('health-scan')).toBe(true);
		expect(isAnalyticsEvent('notes/a.md')).toBe(false);
	});

	it('rejects a non-allow-listed id for durations too', async () => {
		expect(await h.service.trackDuration('notes/a.md', 10)).toBe(false);
		expect(h.service.snapshot().durations).toEqual({});
	});
});

describe('analytics counters', () => {
	let h: Harness;

	beforeEach(async () => {
		h = await harness('mobile');
		await h.enable();
	});

	it('counts repeated events and stamps first and last', async () => {
		await h.service.track('capture-created');
		h.clock.value += 5_000;
		await h.service.track('capture-created');

		const snapshot = h.service.snapshot();
		expect(snapshot.counts['capture-created']).toBe(2);
		expect(snapshot.firstRecordedAt).toBe(START);
		expect(snapshot.lastRecordedAt).toBe(START + 5_000);
		expect(snapshot.platform).toBe('mobile');
	});

	it('accumulates durations and rounds them', async () => {
		await h.service.trackDuration('health-scan', 1_200.4);
		await h.service.trackDuration('health-scan', 800);

		expect(h.service.snapshot().durations['health-scan']).toBe(2_000);
	});

	it('rejects negative and non-finite durations', async () => {
		expect(await h.service.trackDuration('health-scan', -1)).toBe(false);
		expect(await h.service.trackDuration('health-scan', Number.NaN)).toBe(false);
		expect(await h.service.trackDuration('health-scan', Number.POSITIVE_INFINITY)).toBe(false);
		expect(h.service.snapshot().durations).toEqual({});
	});

	it('persists through the settings host', async () => {
		await h.service.track('fix-applied');
		const stored = h.host.data as { analytics: { data: { counts: Record<string, number> } } };
		expect(stored.analytics.data.counts['fix-applied']).toBe(1);
	});

	it('reports false and logs when the write fails', async () => {
		h.host.failSaves = true;
		expect(await h.service.track('search-run')).toBe(false);
		expect(h.logger.errors.length).toBeGreaterThan(0);
	});

	it('returns a snapshot that cannot be written back through', async () => {
		await h.service.track('view-opened');
		const snapshot = h.service.snapshot();
		snapshot.counts['view-opened'] = 999;
		snapshot.platform = 'tampered';

		expect(h.service.snapshot().counts['view-opened']).toBe(1);
		expect(h.service.snapshot().platform).toBe('mobile');
	});
});

describe('analytics defaults for the injected dependencies', () => {
	it('falls back to the wall clock and the host platform', async () => {
		const h = await harness();
		await h.enable();
		const service = new AnalyticsService(h.store, h.logger);

		const before = Date.now();
		expect(await service.track('health-scan')).toBe(true);

		const snapshot = service.snapshot();
		// The Obsidian test double reports a desktop platform.
		expect(snapshot.platform).toBe('desktop');
		expect(snapshot.lastRecordedAt ?? 0).toBeGreaterThanOrEqual(before);
	});
});

describe('analytics vault size buckets', () => {
	it('maps counts to the documented buckets', () => {
		expect(bucketForVaultSize(0)).toBe('0-100');
		expect(bucketForVaultSize(99)).toBe('0-100');
		expect(bucketForVaultSize(100)).toBe('100-1k');
		expect(bucketForVaultSize(999)).toBe('100-1k');
		expect(bucketForVaultSize(1_000)).toBe('1k-5k');
		expect(bucketForVaultSize(4_999)).toBe('1k-5k');
		expect(bucketForVaultSize(5_000)).toBe('5k-10k');
		expect(bucketForVaultSize(9_999)).toBe('5k-10k');
		expect(bucketForVaultSize(10_000)).toBe('10k+');
		expect(bucketForVaultSize(1_000_000)).toBe('10k+');
	});

	it('only ever stores a bucket, never the exact count', async () => {
		const h = await harness();
		await h.enable();
		await h.service.setVaultSize(7_432);

		const stored = h.store.get().analytics.data;
		expect(stored.vaultSizeBucket).toBe('5k-10k');
		expect((VAULT_SIZE_BUCKETS as readonly string[]).includes(stored.vaultSizeBucket)).toBe(
			true,
		);
		expect(JSON.stringify(stored)).not.toContain('7432');
	});

	it('rejects a negative or non-finite count', async () => {
		const h = await harness();
		await h.enable();

		expect(await h.service.setVaultSize(-1)).toBe(false);
		expect(await h.service.setVaultSize(Number.NaN)).toBe(false);
		expect(h.store.get().analytics.data.vaultSizeBucket).toBe('unknown');
	});
});

describe('analytics deletion', () => {
	it('wipes everything and persists immediately', async () => {
		const h = await harness();
		await h.enable();
		await h.service.track('dashboard-opened');
		await h.service.setVaultSize(200);

		await h.service.clear();

		expect(h.service.snapshot()).toEqual({
			counts: {},
			durations: {},
			platform: 'unknown',
			vaultSizeBucket: 'unknown',
			firstRecordedAt: null,
			lastRecordedAt: null,
		});
		// The opt-in itself survives; only the collected data goes.
		expect(h.service.isEnabled()).toBe(true);
	});

	it('resets to a private copy of the defaults, not to the shared module-level object', async () => {
		const h = await harness();
		await h.enable();
		await h.service.track('search-run');
		await h.service.clear();
		// Recording again writes through whatever object `clear` installed. If that were
		// `DEFAULT_SETTINGS.analytics.data` itself, this vault's counters would leak into every
		// store built afterwards in the same process.
		await h.service.track('search-run');

		expect(h.service.snapshot().counts['search-run']).toBe(1);
		expect(DEFAULT_SETTINGS.analytics.data.counts).toEqual({});
		expect(DEFAULT_SETTINGS.analytics.data.durations).toEqual({});
		expect(DEFAULT_SETTINGS.analytics.data.platform).toBe('unknown');
		expect(DEFAULT_SETTINGS.analytics.data.lastRecordedAt).toBeNull();
	});

	it('works while analytics are off, so a user can always delete leftovers', async () => {
		const h = await harness();
		await h.enable();
		await h.service.track('triage-session');
		await h.store.update((settings) => {
			settings.analytics.enabled = false;
		}, true);

		await h.service.clear();
		expect(h.service.snapshot().counts).toEqual({});
	});

	it('logs and rethrows a typed error when the deletion cannot be written', async () => {
		const h = await harness();
		h.host.failSaves = true;

		await expect(h.service.clear()).rejects.toBeInstanceOf(AnalyticsError);
		expect(h.logger.errors.length).toBeGreaterThan(0);
	});
});

describe('analytics never leaves the device', () => {
	it('makes no network call while recording and clearing', async () => {
		const attempts: string[] = [];
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (input: unknown): Promise<Response> => {
			attempts.push(String(input));
			return Promise.reject(new Error('network access is not allowed'));
		};

		try {
			const h = await harness();
			await h.enable();
			await h.service.track('health-scan');
			await h.service.trackDuration('health-scan', 10);
			await h.service.setVaultSize(12_000);
			h.service.snapshot();
			await h.service.clear();
		} finally {
			globalThis.fetch = originalFetch;
		}

		expect(attempts).toEqual([]);
	});

	it('contains no networking API at all', () => {
		const source = readFileSync(join(REPO_ROOT, 'src/services/analytics-service.ts'), 'utf8');
		for (const forbidden of [
			'fetch(',
			'XMLHttpRequest',
			'sendBeacon',
			'WebSocket',
			'requestUrl',
			'http://',
			'https://',
		]) {
			expect(source).not.toContain(forbidden);
		}
	});
});
