/**
 * Backups are the plugin's only undo, so these tests care most about the failure modes: a
 * backup that quietly loses a file, or one that reports success on a read-only vault, would
 * let the safety gate apply changes it can never take back.
 *
 * The fixture mirrors every vault file into the adapter, because that is what a real vault
 * looks like — the in-memory double keeps its `Vault` registry and its `DataAdapter` in
 * separate maps, while Obsidian serves both from the same files on disk.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { App as ObsidianApp } from 'obsidian';
import type { App } from '../../mocks/obsidian';
import { buildVault, loadVaultFromDisk, type FixtureFile } from '../../helpers/vault-fixture';
import { MAX_BACKUPS, PLUGIN_ID } from '../../../src/core/constants';
import { EventBus } from '../../../src/core/event-bus';
import { Logger } from '../../../src/core/logger';
import type { SettingsHost } from '../../../src/core/settings';
import { SettingsStore } from '../../../src/core/settings';
import { BackupService, MAX_STAMP_ATTEMPTS } from '../../../src/services/backup-service';
import { backupStamp } from '../../../src/utils/date';

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

/**
 * The services are typed against the real Obsidian declarations while the tests drive the
 * in-memory mock, which implements every member these code paths touch.
 */
function asApp(app: App): ObsidianApp {
	return app as unknown as ObsidianApp;
}

const CONFIG_DIR = '.obsidian';
const BACKUP_ROOT = `${CONFIG_DIR}/plugins/${PLUGIN_ID}/backups`;
const START = new Date(2026, 5, 15, 12, 0, 0).getTime();

interface Harness {
	app: App;
	host: MemoryHost;
	store: SettingsStore;
	logger: RecordingLogger;
	service: BackupService;
	clock: { value: number };
}

/** Copy every vault file into the adapter, the way a real vault already has them. */
async function mirrorToAdapter(app: App): Promise<void> {
	for (const file of app.vault.getFiles()) {
		await app.vault.adapter.write(file.path, app.vault.peek(file.path) ?? '');
	}
}

async function harnessFor(app: App, configDir = CONFIG_DIR): Promise<Harness> {
	await mirrorToAdapter(app);
	const host = new MemoryHost();
	const logger = new RecordingLogger();
	const store = new SettingsStore(host, new EventBus(), logger, 0);
	await store.load();
	// The store drives the logger level from settings; silence it so the failure cases do not
	// spray stack traces over the test output.
	await store.update((settings) => {
		settings.general.logLevel = 'silent';
	}, true);

	const clock = { value: START };
	const service = new BackupService(asApp(app), store, logger, () => clock.value, configDir);
	return { app, host, store, logger, service, clock };
}

const SIMPLE_FILES: FixtureFile[] = [
	{ path: 'notes/alpha.md', content: 'alpha body\n' },
	{ path: 'notes/nested/beta.md', content: 'beta body\n' },
	{ path: 'root.md', content: 'root body\n' },
];

function simpleHarness(): Promise<Harness> {
	return harnessFor(buildVault(SIMPLE_FILES));
}

/**
 * Manifests newest first, with their folders present on disk.
 *
 * Assigned straight onto the settings object so the list can exceed the cap the settings
 * store itself enforces, which is exactly the state {@link BackupService.prune} exists to
 * clean up after a downgrade or a hand-edited `data.json`.
 */
async function seedManifests(
	h: Harness,
	count: number,
): Promise<{ dir: string; createdAt: number; label: string; files: string[] }[]> {
	const manifests: { dir: string; createdAt: number; label: string; files: string[] }[] = [];
	for (let i = 0; i < count; i++) {
		const dir = `${BACKUP_ROOT}/2030-01-01-00-00-${String(count - 1 - i).padStart(2, '0')}`;
		await h.app.vault.adapter.write(`${dir}/notes/alpha.md`, 'alpha body\n');
		manifests.push({
			dir,
			createdAt: START - i,
			label: `batch ${i}`,
			files: ['notes/alpha.md'],
		});
	}
	return manifests;
}

function storedBackups(h: Harness): { dir: string; files: string[] }[] {
	return h.store.get().backups.map((manifest) => ({
		dir: manifest.dir,
		files: manifest.files,
	}));
}

describe('BackupService.create', () => {
	let h: Harness;

	beforeEach(async () => {
		h = await simpleHarness();
	});

	it('copies each file under the timestamped folder, preserving its vault path', async () => {
		const dir = await h.service.create(['notes/alpha.md', 'notes/nested/beta.md'], 'fix links');

		expect(dir).toBe(`${BACKUP_ROOT}/${backupStamp(START)}`);
		expect(await h.app.vault.adapter.read(`${dir ?? ''}/notes/alpha.md`)).toBe('alpha body\n');
		expect(await h.app.vault.adapter.read(`${dir ?? ''}/notes/nested/beta.md`)).toBe(
			'beta body\n',
		);
	});

	it('records a manifest newest first', async () => {
		await h.service.create(['notes/alpha.md'], 'first batch');
		h.clock.value += 60_000;
		await h.service.create(['root.md'], 'second batch');

		const manifests = h.store.get().backups;
		expect(manifests).toHaveLength(2);
		expect(manifests[0]?.label).toBe('second batch');
		expect(manifests[0]?.files).toEqual(['root.md']);
		expect(manifests[0]?.createdAt).toBe(START + 60_000);
		expect(manifests[1]?.label).toBe('first batch');
	});

	it('de-duplicates and normalises the requested paths', async () => {
		const dir = await h.service.create(['/notes/alpha.md', 'notes/alpha.md', '   '], 'dupes');
		expect(storedBackups(h)[0]?.files).toEqual(['notes/alpha.md']);
		expect(await h.app.vault.adapter.exists(`${dir ?? ''}/notes/alpha.md`)).toBe(true);
	});

	it('handles unicode and special characters in file names', async () => {
		const unicode = await harnessFor(
			buildVault([
				{ path: 'Problem Notes/unicode-note-日本語.md', content: '日本語の本文\n' },
				{ path: 'Problem Notes/special chars - @#$%.md', content: 'special\n' },
			]),
		);

		const dir = await unicode.service.create(
			['Problem Notes/unicode-note-日本語.md', 'Problem Notes/special chars - @#$%.md'],
			'unicode',
		);

		expect(dir).not.toBeNull();
		expect(
			await unicode.app.vault.adapter.read(
				`${dir ?? ''}/Problem Notes/unicode-note-日本語.md`,
			),
		).toBe('日本語の本文\n');
		expect(
			await unicode.app.vault.adapter.read(
				`${dir ?? ''}/Problem Notes/special chars - @#$%.md`,
			),
		).toBe('special\n');
	});

	it('skips and reports an unreadable file instead of recording it as backed up', async () => {
		const dir = await h.service.create(['notes/alpha.md', 'notes/ghost.md'], 'partial');

		expect(dir).not.toBeNull();
		expect(storedBackups(h)[0]?.files).toEqual(['notes/alpha.md']);
		expect(await h.app.vault.adapter.exists(`${dir ?? ''}/notes/ghost.md`)).toBe(false);
		expect(h.logger.warnings.some((message) => message.includes('notes/ghost.md'))).toBe(true);
	});

	it('returns null when nothing could be copied', async () => {
		const dir = await h.service.create(['notes/ghost-1.md', 'notes/ghost-2.md'], 'all missing');

		expect(dir).toBeNull();
		expect(h.store.get().backups).toEqual([]);
		expect(await h.app.vault.adapter.exists(`${BACKUP_ROOT}/${backupStamp(START)}`)).toBe(
			false,
		);
	});

	it('returns null for an empty file list', async () => {
		expect(await h.service.create([], 'nothing')).toBeNull();
		expect(await h.service.create(['', '  '], 'blank')).toBeNull();
		expect(h.store.get().backups).toEqual([]);
		// A request with no usable path is refused before anything is reserved, rather than
		// after a copy fails: no folder is left behind and nothing is reported as a failure.
		expect(await h.app.vault.adapter.exists(BACKUP_ROOT)).toBe(false);
		expect(
			h.logger.warnings.filter((message) => message.includes('empty backup')),
		).toHaveLength(2);
		expect(h.logger.errors).toEqual([]);
	});

	it('returns null without throwing on a read-only vault', async () => {
		h.app.vault.adapter.readOnly = true;

		await expect(h.service.create(['notes/alpha.md'], 'read only')).resolves.toBeNull();
		expect(h.store.get().backups).toEqual([]);
	});

	it('returns null when the manifest cannot be persisted', async () => {
		h.host.failSaves = true;

		const dir = await h.service.create(['notes/alpha.md'], 'unwritable settings');
		expect(dir).toBeNull();
		// The copies stay on disk: losing a copy of the user's data is worse than an orphan.
		expect(
			await h.app.vault.adapter.exists(`${BACKUP_ROOT}/${backupStamp(START)}/notes/alpha.md`),
		).toBe(true);
	});

	it('gives two backups in the same second distinct folders', async () => {
		const first = await h.service.create(['notes/alpha.md'], 'a');
		const second = await h.service.create(['root.md'], 'b');

		expect(first).toBe(`${BACKUP_ROOT}/${backupStamp(START)}`);
		expect(second).toBe(`${BACKUP_ROOT}/${backupStamp(START)}-2`);
		expect(await h.app.vault.adapter.read(`${second ?? ''}/root.md`)).toBe('root body\n');
	});

	it('gives up rather than merging into an occupied folder when every name is taken', async () => {
		const stamp = backupStamp(START);
		await h.app.vault.adapter.write(`${BACKUP_ROOT}/${stamp}/notes/alpha.md`, 'someone else');
		for (let attempt = 2; attempt <= MAX_STAMP_ATTEMPTS; attempt++) {
			await h.app.vault.adapter.mkdir(`${BACKUP_ROOT}/${stamp}-${attempt}`);
		}

		expect(await h.service.create(['notes/alpha.md'], 'exhausted')).toBeNull();

		// Falling through to `mkdir` on a folder that already exists would merge this batch
		// into someone else's backup, and evicting either manifest would delete the other's
		// files.
		expect(await h.app.vault.adapter.read(`${BACKUP_ROOT}/${stamp}/notes/alpha.md`)).toBe(
			'someone else',
		);
		expect(h.store.get().backups).toEqual([]);
		expect(h.logger.errors.length).toBeGreaterThan(0);
	});

	it('honours a custom config directory', async () => {
		const custom = await harnessFor(buildVault(SIMPLE_FILES), '.obsidian-beta');
		const dir = await custom.service.create(['root.md'], 'custom');

		expect(dir).toBe(`.obsidian-beta/plugins/${PLUGIN_ID}/backups/${backupStamp(START)}`);
	});

	it('backs up a note well over 100KB byte for byte', async () => {
		const disk = await harnessFor(loadVaultFromDisk());
		const path = 'Problem Notes/very-long-note.md';
		const original = disk.app.vault.peek(path) ?? '';
		expect(original.length).toBeGreaterThan(100_000);

		const dir = await disk.service.create([path], 'large');
		expect(await disk.app.vault.adapter.read(`${dir ?? ''}/${path}`)).toBe(original);
	});
});

describe('BackupService binary handling', () => {
	it('copies and restores attachments through the binary API when the adapter has one', async () => {
		const h = await harnessFor(
			buildVault([
				{ path: 'notes/alpha.md', content: 'alpha body\n' },
				{ path: 'assets/picture.png', content: 'placeholder' },
			]),
		);

		// The in-memory double only implements the text API, so the binary half is supplied
		// here exactly as a real adapter would provide it.
		const blobs = new Map<string, ArrayBuffer>();
		blobs.set('assets/picture.png', new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer);
		const adapter = h.app.vault.adapter as unknown as Record<string, unknown>;
		adapter.readBinary = async (path: string): Promise<ArrayBuffer> => {
			const data = blobs.get(path);
			if (!data) throw new Error(`ENOENT: ${path}`);
			return data;
		};
		adapter.writeBinary = async (path: string, data: ArrayBuffer): Promise<void> => {
			blobs.set(path, data);
		};

		const dir = await h.service.create(['assets/picture.png', 'notes/alpha.md'], 'mixed');
		expect(dir).not.toBeNull();

		const copied = blobs.get(`${dir ?? ''}/assets/picture.png`);
		expect(copied).toBeDefined();
		expect(Array.from(new Uint8Array(copied ?? new ArrayBuffer(0)))).toEqual([
			0x89, 0x50, 0x4e, 0x47,
		]);
		// The text half of the adapter must not have been used for the image.
		expect(await h.app.vault.adapter.exists(`${dir ?? ''}/assets/picture.png`)).toBe(false);
		// Markdown still goes through the text API.
		expect(await h.app.vault.adapter.read(`${dir ?? ''}/notes/alpha.md`)).toBe('alpha body\n');

		blobs.set('assets/picture.png', new Uint8Array([0]).buffer);
		const result = await h.service.restoreLatest();
		expect(result.restored).toContain('assets/picture.png');
		expect(
			Array.from(new Uint8Array(blobs.get('assets/picture.png') ?? new ArrayBuffer(0))),
		).toEqual([0x89, 0x50, 0x4e, 0x47]);
	});
});

describe('BackupService.restoreLatest', () => {
	let h: Harness;

	beforeEach(async () => {
		h = await simpleHarness();
	});

	it('writes every file in the newest backup back over the edited version', async () => {
		await h.service.create(['notes/alpha.md', 'notes/nested/beta.md'], 'batch');
		await h.app.vault.adapter.write('notes/alpha.md', 'ruined');
		await h.app.vault.adapter.write('notes/nested/beta.md', 'ruined');

		const result = await h.service.restoreLatest();

		expect(result.restored).toEqual(['notes/alpha.md', 'notes/nested/beta.md']);
		expect(result.failed).toEqual([]);
		expect(await h.app.vault.adapter.read('notes/alpha.md')).toBe('alpha body\n');
		expect(await h.app.vault.adapter.read('notes/nested/beta.md')).toBe('beta body\n');
	});

	it('recreates a deleted file and its missing parent folders', async () => {
		await h.service.create(['notes/nested/beta.md'], 'delete batch');
		await h.app.vault.adapter.remove('notes/nested/beta.md');
		await h.app.vault.adapter.rmdir('notes/nested', true);
		expect(await h.app.vault.adapter.exists('notes/nested/beta.md')).toBe(false);

		const result = await h.service.restoreLatest();

		expect(result.restored).toEqual(['notes/nested/beta.md']);
		expect(await h.app.vault.adapter.read('notes/nested/beta.md')).toBe('beta body\n');
	});

	it('restores only the newest backup', async () => {
		await h.service.create(['notes/alpha.md'], 'older');
		h.clock.value += 60_000;
		await h.service.create(['root.md'], 'newer');

		const result = await h.service.restoreLatest();
		expect(result.restored).toEqual(['root.md']);
	});

	it('reports nothing to restore when no backup was ever taken', async () => {
		const result = await h.service.restoreLatest();

		expect(result).toEqual({ restored: [], failed: [] });
		expect(h.logger.warnings.length).toBeGreaterThan(0);
	});

	it('collects failures instead of aborting the rest of the batch', async () => {
		const dir = await h.service.create(['notes/alpha.md', 'root.md'], 'batch');
		// Simulate a backup folder someone partially deleted.
		await h.app.vault.adapter.remove(`${dir ?? ''}/notes/alpha.md`);

		const result = await h.service.restoreLatest();

		expect(result.failed).toEqual(['notes/alpha.md']);
		expect(result.restored).toEqual(['root.md']);
		expect(h.logger.errors.some((message) => message.includes('notes/alpha.md'))).toBe(true);
	});

	it('refuses a recorded path that climbs out of the vault', async () => {
		const dir = (await h.service.create(['notes/alpha.md'], 'batch')) ?? '';
		// A hand-edited manifest, with a readable source behind it so the only thing that can
		// stop the write is the traversal check itself. `..` survives normalisation, so
		// without that check the restore hands the adapter a path outside the vault.
		await h.app.vault.adapter.write(`${dir}/../../outside.md`, 'payload');
		const manifest = h.store.get().backups[0];
		if (manifest) manifest.files = ['../../outside.md', 'notes/alpha.md'];
		await h.app.vault.adapter.write('notes/alpha.md', 'ruined');

		const result = await h.service.restoreLatest();

		expect(result.failed).toEqual(['../../outside.md']);
		expect(result.restored).toEqual(['notes/alpha.md']);
		expect(await h.app.vault.adapter.exists('../../outside.md')).toBe(false);
		// The file that was legitimately in the backup still comes back.
		expect(await h.app.vault.adapter.read('notes/alpha.md')).toBe('alpha body\n');
	});

	it('reports every file as failed when the vault turned read-only', async () => {
		await h.service.create(['notes/alpha.md'], 'batch');
		h.app.vault.adapter.readOnly = true;

		const result = await h.service.restoreLatest();
		expect(result.restored).toEqual([]);
		expect(result.failed).toEqual(['notes/alpha.md']);
	});
});

describe('BackupService.list', () => {
	it('returns copies that cannot corrupt the stored manifests', async () => {
		const h = await simpleHarness();
		await h.service.create(['notes/alpha.md'], 'batch');

		const listed = h.service.list();
		listed.length = 0;
		expect(h.service.list()).toHaveLength(1);

		const again = h.service.list();
		again[0]?.files.push('injected.md');
		expect(h.store.get().backups[0]?.files).toEqual(['notes/alpha.md']);
	});
});

describe('BackupService pruning', () => {
	it('keeps only the newest MAX_BACKUPS and deletes the older folders', async () => {
		const h = await simpleHarness();
		const dirs: string[] = [];
		for (let i = 0; i < MAX_BACKUPS + 3; i++) {
			h.clock.value = START + i * 60_000;
			const dir = await h.service.create(['notes/alpha.md'], `batch ${i}`);
			expect(dir).not.toBeNull();
			dirs.push(dir ?? '');
		}

		expect(h.store.get().backups).toHaveLength(MAX_BACKUPS);
		expect(h.store.get().backups[0]?.label).toBe(`batch ${MAX_BACKUPS + 2}`);

		// The three oldest folders are gone from disk, the rest survive.
		for (const dir of dirs.slice(0, 3)) {
			expect(await h.app.vault.adapter.exists(`${dir}/notes/alpha.md`)).toBe(false);
		}
		for (const dir of dirs.slice(3)) {
			expect(await h.app.vault.adapter.exists(`${dir}/notes/alpha.md`)).toBe(true);
		}
	});

	it('sweeps an untracked folder older than the oldest backup it still knows about', async () => {
		const h = await simpleHarness();
		// A run that crashed between mkdir and the manifest write, long ago.
		await h.app.vault.adapter.write(`${BACKUP_ROOT}/2020-01-01-00-00-00/notes/x.md`, 'stale');
		await h.service.create(['notes/alpha.md'], 'current');

		await h.service.prune();

		expect(await h.app.vault.adapter.exists(`${BACKUP_ROOT}/2020-01-01-00-00-00`)).toBe(false);
		expect(await h.app.vault.adapter.exists(`${BACKUP_ROOT}/${backupStamp(START)}`)).toBe(true);
	});

	it('leaves an untracked folder newer than everything it tracks alone', async () => {
		const h = await simpleHarness();
		await h.service.create(['notes/alpha.md'], 'current');
		// A concurrent backup, mid-write.
		await h.app.vault.adapter.mkdir(`${BACKUP_ROOT}/2099-01-01-00-00-00`);

		await h.service.prune();

		expect(await h.app.vault.adapter.exists(`${BACKUP_ROOT}/2099-01-01-00-00-00`)).toBe(true);
	});

	it('does nothing when no backup has ever been taken', async () => {
		const h = await simpleHarness();
		await expect(h.service.prune()).resolves.toBeUndefined();
		expect(h.store.get().backups).toEqual([]);
	});

	it('leaves the folders alone when the shortened list cannot be persisted', async () => {
		const h = await simpleHarness();
		const extra = {
			dir: `${BACKUP_ROOT}/2019-01-01-00-00-00`,
			createdAt: 1,
			label: 'x',
			files: [],
		};
		await h.app.vault.adapter.mkdir(extra.dir);

		// Push the list past the cap behind the store's own clamping, then block writes.
		const settings = h.store.get();
		settings.backups = [
			...Array.from({ length: MAX_BACKUPS }, (_, i) => ({
				dir: `${BACKUP_ROOT}/2030-01-01-00-00-0${i}`,
				createdAt: 100 + i,
				label: `kept ${i}`,
				files: [],
			})),
			extra,
		];
		h.host.failSaves = true;

		await h.service.prune();

		expect(await h.app.vault.adapter.exists(extra.dir)).toBe(true);
		expect(h.logger.errors.length).toBeGreaterThan(0);
	});

	it('survives a missing backups folder', async () => {
		const h = await simpleHarness();
		h.store.get().backups = [
			{ dir: `${BACKUP_ROOT}/2030-01-01-00-00-00`, createdAt: 1, label: 'ghost', files: [] },
		];

		await expect(h.service.prune()).resolves.toBeUndefined();

		// The manifest stays tracked. Prune only enforces the retention cap; silently dropping
		// a backup whose folder has gone missing would hide that it went missing.
		expect(h.store.get().backups).toHaveLength(1);
		expect(h.logger.errors).toEqual([]);
	});

	it('refuses to delete a folder outside the backup root', async () => {
		const h = await simpleHarness();
		// `data.json` is plain JSON a user can edit and a half-finished write can truncate. An
		// evicted manifest pointing at a real vault folder — or at the vault root — must not
		// turn routine housekeeping into a recursive delete of the user's notes.
		h.store.get().backups = [
			...Array.from({ length: MAX_BACKUPS }, (_, i) => ({
				dir: `${BACKUP_ROOT}/2030-01-01-00-00-0${i}`,
				createdAt: 100 + i,
				label: `kept ${i}`,
				files: [],
			})),
			{ dir: 'notes', createdAt: 2, label: 'poisoned', files: [] },
			{ dir: '', createdAt: 1, label: 'vault root', files: [] },
		];

		await h.service.prune();

		expect(await h.app.vault.adapter.exists('notes/alpha.md')).toBe(true);
		expect(await h.app.vault.adapter.exists('notes/nested/beta.md')).toBe(true);
		expect(await h.app.vault.adapter.exists('root.md')).toBe(true);
		expect(
			h.logger.errors.filter((message) => message.includes('Refusing to remove')),
		).toHaveLength(2);
	});

	it('refuses to delete a folder that climbs out of the backup root', async () => {
		const h = await simpleHarness();
		// `..` survives normalisation — it only tidies slashes — so this path passes a plain
		// `startsWith(root)` test while resolving to the vault's own `notes` folder. The mock
		// adapter treats paths literally and would not actually delete anything, so what is
		// asserted is the refusal itself: on a real adapter the OS resolves the segments.
		h.store.get().backups = [
			...Array.from({ length: MAX_BACKUPS }, (_, i) => ({
				dir: `${BACKUP_ROOT}/2030-01-01-00-00-0${i}`,
				createdAt: 100 + i,
				label: `kept ${i}`,
				files: [],
			})),
			{
				dir: `${BACKUP_ROOT}/../../../../notes`,
				createdAt: 2,
				label: 'traversal',
				files: [],
			},
		];

		await h.service.prune();

		expect(
			h.logger.errors.filter((message) => message.includes('Refusing to remove')),
		).toHaveLength(1);
		expect(await h.app.vault.adapter.exists('notes/alpha.md')).toBe(true);
	});

	it('refuses to delete the backup root itself', async () => {
		const h = await simpleHarness();
		await h.service.create(['notes/alpha.md'], 'current');
		// Stamps older than the real folder, so the orphan sweep leaves it alone and the only
		// thing that could delete it is the poisoned manifest.
		h.store.get().backups = [
			...Array.from({ length: MAX_BACKUPS }, (_, i) => ({
				dir: `${BACKUP_ROOT}/2020-01-01-00-00-0${i}`,
				createdAt: 100 + i,
				label: `kept ${i}`,
				files: [],
			})),
			{ dir: BACKUP_ROOT, createdAt: 1, label: 'the whole folder', files: [] },
		];

		await h.service.prune();

		// One bad manifest must not take every other backup with it.
		expect(await h.app.vault.adapter.exists(`${BACKUP_ROOT}/${backupStamp(START)}`)).toBe(true);
		expect(h.logger.errors.some((message) => message.includes('Refusing to remove'))).toBe(
			true,
		);
	});

	it('shortens an over-long list and deletes the evicted folders', async () => {
		const h = await simpleHarness();
		const manifests = await seedManifests(h, MAX_BACKUPS + 2);
		h.store.get().backups = manifests;

		await h.service.prune();

		expect(h.store.get().backups).toHaveLength(MAX_BACKUPS);
		for (const manifest of manifests.slice(MAX_BACKUPS)) {
			expect(await h.app.vault.adapter.exists(manifest.dir)).toBe(false);
		}
		expect(await h.app.vault.adapter.exists(manifests[0]?.dir ?? '')).toBe(true);
	});

	it('warns but keeps going when an evicted folder cannot be deleted', async () => {
		const h = await simpleHarness();
		h.store.get().backups = await seedManifests(h, MAX_BACKUPS + 1);
		h.app.vault.adapter.readOnly = true;

		await h.service.prune();

		expect(h.store.get().backups).toHaveLength(MAX_BACKUPS);
		expect(h.logger.warnings.some((message) => message.includes('Could not remove'))).toBe(
			true,
		);
	});

	it('warns when the backups folder cannot be listed', async () => {
		const h = await simpleHarness();
		await h.service.create(['notes/alpha.md'], 'current');
		const adapter = h.app.vault.adapter as unknown as Record<string, unknown>;
		adapter.list = async (): Promise<never> => {
			throw new Error('EIO: cannot list');
		};

		await h.service.prune();

		expect(h.logger.warnings.some((message) => message.includes('Could not list'))).toBe(true);
	});
});

describe('BackupService defaults', () => {
	it('falls back to the wall clock and Obsidian’s standard config folder', async () => {
		const h = await simpleHarness();
		const service = new BackupService(asApp(h.app), h.store, h.logger);

		const dir = await service.create(['notes/alpha.md'], 'defaults');
		expect(dir?.startsWith(`${BACKUP_ROOT}/`)).toBe(true);
		expect(h.store.get().backups[0]?.createdAt).toBeGreaterThan(0);
	});
});
