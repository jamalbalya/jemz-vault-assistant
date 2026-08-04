/**
 * The action log is the plugin's audit trail: if it drifts, a user cannot tell what happened
 * to their vault. These tests pin the two properties everything else relies on — newest
 * first, and never more than 100 entries — plus the failure path, because an entry that
 * silently fails to persist would be worse than no log at all.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { MAX_ACTION_LOG_ENTRIES } from '../../../src/core/constants';
import { EventBus } from '../../../src/core/event-bus';
import { Logger } from '../../../src/core/logger';
import type { SettingsHost } from '../../../src/core/settings';
import { SettingsStore } from '../../../src/core/settings';
import {
	ActionLogError,
	ActionLogService,
	type ActionLogInput,
} from '../../../src/services/action-log-service';
import type { ActionLogEntry, JemzSettings } from '../../../src/types/settings';

/** Records what the service logged without printing anything during the run. */
class RecordingLogger extends Logger {
	readonly errors: string[] = [];

	constructor() {
		super('silent', 'test');
	}

	override error(message: string, ...details: unknown[]): void {
		this.errors.push(message);
		super.error(message, ...details);
	}
}

/** Stands in for the Obsidian plugin's own `loadData`/`saveData`. */
class MemoryHost implements SettingsHost {
	data: unknown = null;
	/** Flip to simulate an unwritable `data.json`. */
	failSaves = false;
	saveCount = 0;

	async loadData(): Promise<unknown> {
		return this.data;
	}

	async saveData(data: unknown): Promise<void> {
		this.saveCount += 1;
		if (this.failSaves) throw new Error('EROFS: read-only vault');
		this.data = JSON.parse(JSON.stringify(data));
	}
}

interface Harness {
	host: MemoryHost;
	store: SettingsStore;
	bus: EventBus;
	logger: RecordingLogger;
	service: ActionLogService;
	/** Mutable clock the service reads through its injected `now`. */
	clock: { value: number };
}

const START = new Date(2026, 5, 15, 12, 0, 0).getTime();

async function harness(): Promise<Harness> {
	const host = new MemoryHost();
	const bus = new EventBus();
	const logger = new RecordingLogger();
	// Zero delay makes every write synchronous, so a failed save surfaces as a rejection.
	const store = new SettingsStore(host, bus, logger, 0);
	await store.load();
	// The store drives the logger level from settings; silence it so the failure cases do not
	// spray stack traces over the test output.
	await store.update((settings) => {
		settings.general.logLevel = 'silent';
	}, true);
	const clock = { value: START };
	const service = new ActionLogService(store, bus, logger, () => clock.value);
	return { host, store, bus, logger, service, clock };
}

function input(overrides: Partial<ActionLogInput> = {}): ActionLogInput {
	return {
		action: 'fix-broken-links',
		details: 'Replaced 2 links',
		files: ['notes/a.md'],
		result: 'success',
		...overrides,
	};
}

function persistedLog(host: MemoryHost): ActionLogEntry[] {
	const data = host.data as JemzSettings | null;
	return data?.actionLog ?? [];
}

describe('ActionLogService.log', () => {
	let h: Harness;

	beforeEach(async () => {
		h = await harness();
	});

	it('starts empty', () => {
		expect(h.service.entries()).toEqual([]);
		expect(h.service.recent(10)).toEqual([]);
	});

	it('generates an id and stamps the injected clock', async () => {
		const entry = await h.service.log(input());
		expect(entry.timestamp).toBe(START);
		expect(entry.id.length).toBeGreaterThan(0);
		expect(entry.action).toBe('fix-broken-links');
		expect(entry.result).toBe('success');
	});

	it('stores entries newest first', async () => {
		await h.service.log(input({ action: 'first' }));
		h.clock.value += 1000;
		await h.service.log(input({ action: 'second' }));

		expect(h.service.entries().map((entry) => entry.action)).toEqual(['second', 'first']);
	});

	it('persists through the settings host', async () => {
		await h.service.log(input({ action: 'archive' }));
		expect(persistedLog(h.host).map((entry) => entry.action)).toEqual(['archive']);
	});

	it('emits action-logged only after the write succeeded', async () => {
		const seen: ActionLogEntry[] = [];
		h.bus.on('action-logged', (payload) => seen.push(payload.entry));

		const entry = await h.service.log(input());
		expect(seen).toHaveLength(1);
		expect(seen[0]?.id).toBe(entry.id);
	});

	it('keeps the optional error and backup fields', async () => {
		const entry = await h.service.log(
			input({ result: 'partial', error: 'one file was locked', backupDir: 'backups/x' }),
		);
		expect(entry.error).toBe('one file was locked');
		expect(entry.backupDir).toBe('backups/x');
		expect(persistedLog(h.host)[0]?.backupDir).toBe('backups/x');
	});

	it('mints unique ids inside the same millisecond', async () => {
		const ids = new Set<string>();
		for (let i = 0; i < 20; i++) {
			const entry = await h.service.log(input());
			ids.add(entry.id);
		}
		expect(ids.size).toBe(20);
	});

	it('copies the caller-supplied file list', async () => {
		const files = ['notes/a.md'];
		const entry = await h.service.log(input({ files }));
		files.push('notes/b.md');

		expect(entry.files).toEqual(['notes/a.md']);
		expect(h.service.entries()[0]?.files).toEqual(['notes/a.md']);
	});

	it('preserves unicode and special characters through persistence', async () => {
		await h.service.log(
			input({
				action: 'move',
				details: 'Moved 日本語のノート → 04-Archive (100 % done)',
				files: [
					'Problem Notes/unicode-note-日本語.md',
					'Problem Notes/special chars - @#$%.md',
				],
			}),
		);

		const stored = persistedLog(h.host)[0];
		expect(stored?.details).toBe('Moved 日本語のノート → 04-Archive (100 % done)');
		expect(stored?.files).toEqual([
			'Problem Notes/unicode-note-日本語.md',
			'Problem Notes/special chars - @#$%.md',
		]);
	});

	it('round-trips a very long details string', async () => {
		const details = 'x'.repeat(120_000);
		await h.service.log(input({ details }));
		expect(persistedLog(h.host)[0]?.details).toHaveLength(120_000);
	});

	it('logs and rethrows a typed error when the write fails', async () => {
		h.host.failSaves = true;
		await expect(h.service.log(input())).rejects.toBeInstanceOf(ActionLogError);
		expect(h.logger.errors.some((message) => message.includes('action log entry'))).toBe(true);
	});

	it('does not emit when the write fails', async () => {
		const seen: ActionLogEntry[] = [];
		h.bus.on('action-logged', (payload) => seen.push(payload.entry));
		h.host.failSaves = true;

		await expect(h.service.log(input())).rejects.toBeInstanceOf(ActionLogError);
		expect(seen).toEqual([]);
	});

	it('does not keep an entry the write rejected', async () => {
		await h.service.log(input({ action: 'kept' }));
		h.host.failSaves = true;

		await expect(h.service.log(input({ action: 'lost' }))).rejects.toBeInstanceOf(
			ActionLogError,
		);

		// The store mutates in place and persists afterwards, so the rejected entry has to be
		// taken back out: `throw` means "not recorded", and the Settings viewer reads exactly
		// this list.
		expect(h.service.entries().map((entry) => entry.action)).toEqual(['kept']);

		// It must not ride along on the next unrelated write either — that would persist an
		// entry the caller was already told had failed.
		h.host.failSaves = false;
		await h.store.saveNow();
		expect(persistedLog(h.host).map((entry) => entry.action)).toEqual(['kept']);
	});

	it('re-announces the settings after taking a rejected entry back out', async () => {
		const seen: string[][] = [];
		h.bus.on('settings-changed', (payload) =>
			seen.push(payload.settings.actionLog.map((entry) => entry.action)),
		);
		h.host.failSaves = true;

		await expect(h.service.log(input({ action: 'lost' }))).rejects.toBeInstanceOf(
			ActionLogError,
		);

		// The store already announced the version that included the entry; a view that redrew
		// from it would stay wrong unless the rollback is announced too.
		expect(seen[seen.length - 1]).toEqual([]);
	});
});

describe('ActionLogService trimming', () => {
	it('keeps exactly the cap when it is reached', async () => {
		const h = await harness();
		for (let i = 0; i < MAX_ACTION_LOG_ENTRIES; i++) {
			await h.service.log(input({ action: `action-${i}` }));
		}

		expect(h.service.entries()).toHaveLength(MAX_ACTION_LOG_ENTRIES);
		expect(h.service.entries()[0]?.action).toBe(`action-${MAX_ACTION_LOG_ENTRIES - 1}`);
		expect(h.service.entries()[MAX_ACTION_LOG_ENTRIES - 1]?.action).toBe('action-0');
	});

	it('drops the oldest entries past the cap', async () => {
		const h = await harness();
		for (let i = 0; i < MAX_ACTION_LOG_ENTRIES + 5; i++) {
			await h.service.log(input({ action: `action-${i}` }));
		}

		const entries = h.service.entries();
		expect(entries).toHaveLength(MAX_ACTION_LOG_ENTRIES);
		expect(entries[0]?.action).toBe(`action-${MAX_ACTION_LOG_ENTRIES + 4}`);
		expect(entries[entries.length - 1]?.action).toBe('action-5');
		expect(entries.some((entry) => entry.action === 'action-0')).toBe(false);
		expect(persistedLog(h.host)).toHaveLength(MAX_ACTION_LOG_ENTRIES);
	});
});

describe('ActionLogService reads', () => {
	let h: Harness;

	beforeEach(async () => {
		h = await harness();
		for (let i = 0; i < 5; i++) await h.service.log(input({ action: `action-${i}` }));
	});

	it('returns a copy from entries()', () => {
		const first = h.service.entries() as ActionLogEntry[];
		first.length = 0;
		expect(h.service.entries()).toHaveLength(5);
	});

	it('returns the newest n from recent()', () => {
		expect(h.service.recent(2).map((entry) => entry.action)).toEqual(['action-4', 'action-3']);
	});

	it('clamps a limit larger than the log', () => {
		expect(h.service.recent(500)).toHaveLength(5);
	});

	it('returns nothing for a non-positive or non-finite limit', () => {
		expect(h.service.recent(0)).toEqual([]);
		expect(h.service.recent(-3)).toEqual([]);
		expect(h.service.recent(Number.NaN)).toEqual([]);
	});

	it('floors a fractional limit', () => {
		expect(h.service.recent(2.9)).toHaveLength(2);
	});
});

describe('ActionLogService defaults', () => {
	it('falls back to the wall clock when no clock is injected', async () => {
		const h = await harness();
		const service = new ActionLogService(h.store, h.bus, h.logger);

		const before = Date.now();
		const entry = await service.log(input());
		expect(entry.timestamp).toBeGreaterThanOrEqual(before);
		expect(entry.timestamp).toBeLessThanOrEqual(Date.now());
	});
});

describe('ActionLogService.clear', () => {
	it('empties the log and persists it', async () => {
		const h = await harness();
		await h.service.log(input());
		await h.service.clear();

		expect(h.service.entries()).toEqual([]);
		expect(persistedLog(h.host)).toEqual([]);
	});

	it('logs and rethrows a typed error when the write fails', async () => {
		const h = await harness();
		await h.service.log(input());
		h.host.failSaves = true;

		await expect(h.service.clear()).rejects.toBeInstanceOf(ActionLogError);
		expect(h.logger.errors.some((message) => message.includes('clear the action log'))).toBe(
			true,
		);
	});

	it('keeps the log when the emptied version cannot be persisted', async () => {
		const h = await harness();
		await h.service.log(input({ action: 'kept' }));
		h.host.failSaves = true;

		await expect(h.service.clear()).rejects.toBeInstanceOf(ActionLogError);

		// Otherwise the log looks empty until a restart brings every entry back, which reads
		// as data loss followed by data resurrection.
		expect(h.service.entries().map((entry) => entry.action)).toEqual(['kept']);

		h.host.failSaves = false;
		await h.store.saveNow();
		expect(persistedLog(h.host).map((entry) => entry.action)).toEqual(['kept']);
	});
});
