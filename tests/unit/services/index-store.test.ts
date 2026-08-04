/**
 * The serialized index is a startup optimisation that must never become a source of truth.
 * These tests pin the two rules that keep it safe: it is only written for vaults large enough
 * to benefit, and any payload that is corrupt, truncated, or written by another schema
 * version is thrown away rather than trusted.
 *
 * The privacy rule from addendum 3.4 is asserted structurally — the payload is checked field
 * by field so a future field carrying note content cannot slip in unnoticed.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { App as ObsidianApp } from 'obsidian';
import type { App } from '../../mocks/obsidian';
import { buildVault } from '../../helpers/vault-fixture';
import { INDEX_PERSIST_THRESHOLD, PLUGIN_ID } from '../../../src/core/constants';
import { Logger } from '../../../src/core/logger';
import {
	INDEX_CACHE_VERSION,
	IndexStore,
	IndexStoreError,
	metadataHash,
} from '../../../src/services/index-store';
import type { NoteRecord } from '../../../src/types/note';

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

/**
 * The services are typed against the real Obsidian declarations while the tests drive the
 * in-memory mock, which implements every member these code paths touch.
 */
function asApp(app: App): ObsidianApp {
	return app as unknown as ObsidianApp;
}

const CONFIG_DIR = '.obsidian';
const CACHE_PATH = `${CONFIG_DIR}/plugins/${PLUGIN_ID}/index-cache.json`;
const SAVED_AT = new Date(2026, 5, 15, 12, 0, 0).getTime();

interface Harness {
	app: App;
	logger: RecordingLogger;
	store: IndexStore;
}

function harness(configDir = CONFIG_DIR): Harness {
	const app = buildVault([{ path: 'notes/alpha.md', content: 'body' }]);
	const logger = new RecordingLogger();
	return {
		app,
		logger,
		store: new IndexStore(asApp(app), logger, () => SAVED_AT, configDir),
	};
}

/** A complete record, so the store is exercised against the real shape. */
function makeRecord(overrides: Partial<NoteRecord> & { path: string }): NoteRecord {
	return {
		basename: 'note',
		extension: 'md',
		folder: 'notes',
		created: 1_700_000_000_000,
		modified: 1_700_000_100_000,
		fileModified: 1_700_000_100_000,
		size: 512,
		frontmatter: { type: 'note' },
		hasFrontmatterBlock: true,
		frontmatterValid: true,
		type: 'note',
		status: 'inbox',
		source: null,
		tags: ['inbox'],
		links: [],
		resolvedLinks: [],
		unresolvedLinks: [],
		backlinks: [],
		headings: ['Heading'],
		isAttachment: false,
		...overrides,
	};
}

function manyRecords(count: number): NoteRecord[] {
	return Array.from({ length: count }, (_, index) =>
		makeRecord({ path: `notes/note-${index}.md` }),
	);
}

describe('IndexStore.shouldPersist', () => {
	const h = harness();

	it('refuses vaults below the threshold', () => {
		expect(h.store.shouldPersist(0)).toBe(false);
		expect(h.store.shouldPersist(100)).toBe(false);
		expect(h.store.shouldPersist(INDEX_PERSIST_THRESHOLD - 1)).toBe(false);
	});

	it('accepts vaults at or above the threshold', () => {
		expect(h.store.shouldPersist(INDEX_PERSIST_THRESHOLD)).toBe(true);
		expect(h.store.shouldPersist(INDEX_PERSIST_THRESHOLD + 1)).toBe(true);
	});

	it('refuses a non-finite count', () => {
		expect(h.store.shouldPersist(Number.NaN)).toBe(false);
	});
});

describe('IndexStore.save', () => {
	let h: Harness;

	beforeEach(() => {
		h = harness();
	});

	it('writes nothing for a small vault', async () => {
		expect(await h.store.save(manyRecords(10))).toBe(false);
		expect(await h.app.vault.adapter.exists(CACHE_PATH)).toBe(false);
	});

	it('writes nothing for an empty vault', async () => {
		expect(await h.store.save([])).toBe(false);
		expect(await h.app.vault.adapter.exists(CACHE_PATH)).toBe(false);
	});

	it('deletes a cache that the vault has since shrunk below', async () => {
		expect(await h.store.save(manyRecords(INDEX_PERSIST_THRESHOLD))).toBe(true);
		expect(await h.app.vault.adapter.exists(CACHE_PATH)).toBe(true);

		expect(await h.store.save(manyRecords(1))).toBe(false);
		expect(await h.app.vault.adapter.exists(CACHE_PATH)).toBe(false);
	});

	it('writes a versioned payload at the plugin path', async () => {
		expect(await h.store.save(manyRecords(INDEX_PERSIST_THRESHOLD))).toBe(true);

		const raw = JSON.parse(await h.app.vault.adapter.read(CACHE_PATH)) as {
			version: number;
			savedAt: number;
			count: number;
			entries: unknown[];
		};
		expect(raw.version).toBe(INDEX_CACHE_VERSION);
		expect(raw.savedAt).toBe(SAVED_AT);
		expect(raw.count).toBe(INDEX_PERSIST_THRESHOLD);
		expect(raw.entries).toHaveLength(INDEX_PERSIST_THRESHOLD);
	});

	it('stores metadata only, never note content', async () => {
		const records = manyRecords(INDEX_PERSIST_THRESHOLD);
		records[0] = makeRecord({
			path: 'notes/secret.md',
			headings: ['A very secret heading'],
			frontmatter: { secret: 'do not persist me' },
		});
		await h.store.save(records);

		const raw = await h.app.vault.adapter.read(CACHE_PATH);
		expect(raw).not.toContain('do not persist me');
		expect(raw).not.toContain('A very secret heading');

		const payload = await h.store.load();
		expect(Object.keys(payload?.entries[0] ?? {}).sort()).toEqual([
			'created',
			'extension',
			'folder',
			'hash',
			'isAttachment',
			'modified',
			'mtime',
			'path',
			'size',
			'status',
			'tags',
			'type',
		]);
	});

	it('preserves unicode and special characters in paths', async () => {
		const records = manyRecords(INDEX_PERSIST_THRESHOLD);
		records[0] = makeRecord({ path: 'Problem Notes/unicode-note-日本語.md' });
		records[1] = makeRecord({ path: 'Problem Notes/special chars - @#$%.md' });
		await h.store.save(records);

		const payload = await h.store.load();
		expect(payload?.entries[0]?.path).toBe('Problem Notes/unicode-note-日本語.md');
		expect(payload?.entries[1]?.path).toBe('Problem Notes/special chars - @#$%.md');
	});

	it('reports false and logs when the vault is read-only', async () => {
		h.app.vault.adapter.readOnly = true;

		expect(await h.store.save(manyRecords(INDEX_PERSIST_THRESHOLD))).toBe(false);
		expect(h.logger.errors.length).toBeGreaterThan(0);
	});

	it('honours a custom config directory', async () => {
		const custom = harness('.obsidian-beta');
		expect(custom.store.cachePath()).toBe(
			`.obsidian-beta/plugins/${PLUGIN_ID}/index-cache.json`,
		);
		await custom.store.save(manyRecords(INDEX_PERSIST_THRESHOLD));
		expect(await custom.app.vault.adapter.exists(custom.store.cachePath())).toBe(true);
	});
});

describe('IndexStore.load', () => {
	let h: Harness;

	beforeEach(() => {
		h = harness();
	});

	it('round-trips a saved index', async () => {
		const records = manyRecords(INDEX_PERSIST_THRESHOLD);
		await h.store.save(records);

		const payload = await h.store.load();
		expect(payload?.count).toBe(INDEX_PERSIST_THRESHOLD);
		expect(payload?.entries).toHaveLength(INDEX_PERSIST_THRESHOLD);

		const first = payload?.entries[0];
		const source = records[0];
		expect(first?.path).toBe(source?.path);
		expect(first?.mtime).toBe(source?.fileModified);
		expect(first?.size).toBe(source?.size);
		expect(first?.tags).toEqual(['inbox']);
		expect(first?.hash).toBe(source ? metadataHash(source) : '');
	});

	it('returns null when no cache exists', async () => {
		expect(await h.store.load()).toBeNull();
	});

	it('returns null for unparseable JSON', async () => {
		await h.app.vault.adapter.write(CACHE_PATH, '{ this is not json');
		expect(await h.store.load()).toBeNull();
		expect(h.logger.warnings.length).toBeGreaterThan(0);
	});

	it('rejects a payload written by another schema version', async () => {
		await h.app.vault.adapter.write(
			CACHE_PATH,
			JSON.stringify({
				version: INDEX_CACHE_VERSION + 1,
				savedAt: SAVED_AT,
				count: 1,
				entries: [
					{
						path: 'notes/a.md',
						mtime: 1,
						size: 2,
						hash: 'abc',
						folder: 'notes',
						extension: 'md',
						created: 1,
						modified: 1,
						type: null,
						status: null,
						tags: [],
						isAttachment: false,
					},
				],
			}),
		);

		expect(await h.store.load()).toBeNull();
		expect(h.logger.warnings.some((message) => message.includes('version'))).toBe(true);
	});

	it('rejects a payload that is not an object or has no entries array', async () => {
		await h.app.vault.adapter.write(CACHE_PATH, JSON.stringify(['not', 'a', 'payload']));
		expect(await h.store.load()).toBeNull();

		await h.app.vault.adapter.write(
			CACHE_PATH,
			JSON.stringify({ version: INDEX_CACHE_VERSION, entries: 'nope' }),
		);
		expect(await h.store.load()).toBeNull();
	});

	it('rejects the whole payload when a single entry is malformed', async () => {
		await h.app.vault.adapter.write(
			CACHE_PATH,
			JSON.stringify({
				version: INDEX_CACHE_VERSION,
				savedAt: SAVED_AT,
				count: 2,
				entries: [
					{
						path: 'notes/a.md',
						mtime: 1,
						size: 2,
						hash: 'abc',
						folder: 'notes',
						extension: 'md',
						created: 1,
						modified: 1,
						type: null,
						status: null,
						tags: [],
						isAttachment: false,
					},
					{ path: 'notes/b.md', mtime: 'yesterday' },
				],
			}),
		);

		expect(await h.store.load()).toBeNull();
		expect(h.logger.warnings.some((message) => message.includes('malformed'))).toBe(true);
	});

	it('rejects entries missing a path, a hash, or a tag list', async () => {
		const base = {
			path: 'notes/a.md',
			mtime: 1,
			size: 2,
			hash: 'abc',
			folder: 'notes',
			extension: 'md',
			created: 1,
			modified: 1,
			type: null,
			status: null,
			tags: [],
			isAttachment: false,
		};

		for (const broken of [
			{ ...base, path: '' },
			{ ...base, hash: 42 },
			{ ...base, tags: 'inbox' },
			{ ...base, size: null },
			'not an object',
		]) {
			await h.app.vault.adapter.write(
				CACHE_PATH,
				JSON.stringify({
					version: INDEX_CACHE_VERSION,
					savedAt: SAVED_AT,
					count: 1,
					entries: [broken],
				}),
			);
			expect(await h.store.load()).toBeNull();
		}
	});

	it('rejects a payload that declares more entries than it carries', async () => {
		// A write cut short by a crash or a sync conflict still parses, and every entry that
		// survived still validates. The declared count is the only thing left that disagrees,
		// and a short index silently hides notes from every view that reads it.
		await h.app.vault.adapter.write(
			CACHE_PATH,
			JSON.stringify({
				version: INDEX_CACHE_VERSION,
				savedAt: SAVED_AT,
				count: 4_000,
				entries: [
					{
						path: 'notes/a.md',
						mtime: 1,
						size: 2,
						hash: 'abc',
						folder: 'notes',
						extension: 'md',
						created: 1,
						modified: 1,
						type: null,
						status: null,
						tags: [],
						isAttachment: false,
					},
				],
			}),
		);

		expect(await h.store.load()).toBeNull();
		expect(h.logger.warnings.some((message) => message.includes('declares 4000'))).toBe(true);
	});

	it('rejects a payload that declares fewer entries than it carries', async () => {
		const entry = {
			path: 'notes/a.md',
			mtime: 1,
			size: 2,
			hash: 'abc',
			folder: 'notes',
			extension: 'md',
			created: 1,
			modified: 1,
			type: null,
			status: null,
			tags: [],
			isAttachment: false,
		};
		await h.app.vault.adapter.write(
			CACHE_PATH,
			JSON.stringify({
				version: INDEX_CACHE_VERSION,
				savedAt: SAVED_AT,
				count: 1,
				entries: [entry, { ...entry, path: 'notes/b.md' }],
			}),
		);

		expect(await h.store.load()).toBeNull();
	});

	it('accepts a payload whose declared count matches', async () => {
		const entry = {
			path: 'notes/a.md',
			mtime: 1,
			size: 2,
			hash: 'abc',
			folder: 'notes',
			extension: 'md',
			created: 1,
			modified: 1,
			type: null,
			status: null,
			tags: [],
			isAttachment: false,
		};
		await h.app.vault.adapter.write(
			CACHE_PATH,
			JSON.stringify({
				version: INDEX_CACHE_VERSION,
				savedAt: SAVED_AT,
				count: 2,
				entries: [entry, { ...entry, path: 'notes/b.md' }],
			}),
		);

		const payload = await h.store.load();
		expect(payload?.entries.map((note) => note.path)).toEqual(['notes/a.md', 'notes/b.md']);
	});

	it('fills in missing optional fields rather than rejecting', async () => {
		await h.app.vault.adapter.write(
			CACHE_PATH,
			JSON.stringify({
				version: INDEX_CACHE_VERSION,
				entries: [
					{
						path: 'notes/a.md',
						mtime: 1,
						size: 2,
						hash: 'abc',
						created: 3,
						modified: 4,
						tags: ['inbox', 7],
					},
				],
			}),
		);

		const payload = await h.store.load();
		expect(payload?.savedAt).toBe(0);
		expect(payload?.count).toBe(1);
		expect(payload?.entries[0]?.folder).toBe('');
		expect(payload?.entries[0]?.extension).toBe('');
		expect(payload?.entries[0]?.type).toBeNull();
		expect(payload?.entries[0]?.isAttachment).toBe(false);
		// A non-string tag is dropped rather than poisoning the tag list.
		expect(payload?.entries[0]?.tags).toEqual(['inbox']);
	});
});

describe('IndexStore.clear', () => {
	let h: Harness;

	beforeEach(() => {
		h = harness();
	});

	it('removes the cache file', async () => {
		await h.store.save(manyRecords(INDEX_PERSIST_THRESHOLD));
		await h.store.clear();

		expect(await h.app.vault.adapter.exists(CACHE_PATH)).toBe(false);
		expect(await h.store.load()).toBeNull();
	});

	it('is a no-op when there is nothing to remove', async () => {
		await expect(h.store.clear()).resolves.toBeUndefined();
	});

	it('logs and rethrows a typed error when the file cannot be removed', async () => {
		await h.store.save(manyRecords(INDEX_PERSIST_THRESHOLD));
		h.app.vault.adapter.readOnly = true;

		await expect(h.store.clear()).rejects.toBeInstanceOf(IndexStoreError);
		expect(h.logger.errors.length).toBeGreaterThan(0);
	});

	it('swallows a failed cleanup when a small vault cannot delete its stale cache', async () => {
		await h.store.save(manyRecords(INDEX_PERSIST_THRESHOLD));
		h.app.vault.adapter.readOnly = true;

		await expect(h.store.save(manyRecords(3))).resolves.toBe(false);
		// The cache is still there, but the caller was told nothing was written.
		expect(await h.app.vault.adapter.exists(CACHE_PATH)).toBe(true);
	});
});

describe('IndexStore defaults', () => {
	it('falls back to the wall clock and Obsidian’s standard config folder', async () => {
		const app = buildVault([{ path: 'notes/alpha.md', content: 'body' }]);
		const store = new IndexStore(asApp(app), new RecordingLogger());

		expect(store.cachePath()).toBe(CACHE_PATH);
		const before = Date.now();
		expect(await store.save(manyRecords(INDEX_PERSIST_THRESHOLD))).toBe(true);
		expect((await store.load())?.savedAt ?? 0).toBeGreaterThanOrEqual(before);
	});
});

describe('metadataHash', () => {
	it('is stable for identical metadata', () => {
		expect(metadataHash(makeRecord({ path: 'notes/a.md' }))).toBe(
			metadataHash(makeRecord({ path: 'notes/a.md' })),
		);
	});

	it('changes when any tracked field changes', () => {
		const base = makeRecord({ path: 'notes/a.md' });
		const variants = [
			makeRecord({ path: 'notes/b.md' }),
			makeRecord({ path: 'notes/a.md', fileModified: base.fileModified + 1 }),
			makeRecord({ path: 'notes/a.md', size: base.size + 1 }),
			makeRecord({ path: 'notes/a.md', tags: ['inbox', 'extra'] }),
			makeRecord({ path: 'notes/a.md', status: 'archived' }),
			makeRecord({ path: 'notes/a.md', isAttachment: true }),
		];

		for (const variant of variants) {
			expect(metadataHash(variant)).not.toBe(metadataHash(base));
		}
	});

	it('ignores fields the cache does not carry', () => {
		const base = makeRecord({ path: 'notes/a.md' });
		const withOtherBody = makeRecord({
			path: 'notes/a.md',
			headings: ['Completely different'],
			backlinks: ['notes/z.md'],
		});
		expect(metadataHash(withOtherBody)).toBe(metadataHash(base));
	});
});
