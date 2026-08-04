/**
 * Timestamped copies of every file a fix batch is about to touch (addendum 3.4 and 6.5).
 *
 * This is the plugin's undo. Nothing is modified until a backup exists, so
 * {@link BackupService.create} returns `null` rather than throwing when it cannot do its job:
 * the safety gate reads that null as "refuse to apply", and a thrown error there would be
 * indistinguishable from a bug in the fix itself.
 *
 * Everything goes through `vault.adapter` rather than the `Vault` API because a restore has
 * to be able to recreate a file the fix deleted — at that point Obsidian's file registry no
 * longer knows the path exists, while the adapter happily writes it back. The adapter is also
 * the only file API that behaves identically on desktop and mobile; no Node `fs` anywhere.
 */

import type { App, DataAdapter } from 'obsidian';
import { BACKUP_DIR_NAME, MAX_BACKUPS, PLUGIN_ID } from '../core/constants';
import type { Logger } from '../core/logger';
import type { SettingsStore } from '../core/settings';
import { STRINGS } from '../core/strings';
import { backupStamp } from '../utils/date';
import { getFolderPath, isAttachmentPath, joinPath, normalizeVaultPath } from '../utils/file';

/** Upper bound on same-second folder name collisions before giving up. */
export const MAX_STAMP_ATTEMPTS = 1000;

/** One backup, as recorded in `settings.backups`. */
export interface BackupManifest {
	/** Vault-relative path of the backup folder. */
	dir: string;
	/** Epoch milliseconds the backup was taken. */
	createdAt: number;
	/** Human readable description of the batch, shown in the restore prompt. */
	label: string;
	/** Vault-relative paths that were actually copied, never the ones that were skipped. */
	files: string[];
}

/** Result of restoring a backup. */
export interface RestoreResult {
	/** Paths written back to the vault. */
	restored: string[];
	/** Paths that could not be written back. */
	failed: string[];
}

/** The optional binary half of the adapter API. */
interface BinaryFileApi {
	readBinary(path: string): Promise<ArrayBuffer>;
	writeBinary(path: string, data: ArrayBuffer): Promise<void>;
}

/**
 * The adapter's binary API, when it has one.
 *
 * Attachments must round-trip byte for byte; copying a PNG through the text API would decode
 * and re-encode it into garbage. Every shipping Obsidian adapter implements this, but the
 * capability is probed rather than assumed so a host that only provides the text API degrades
 * to something that still works for notes instead of throwing.
 */
function binaryApiOf(adapter: DataAdapter): BinaryFileApi | null {
	const candidate = adapter as Partial<BinaryFileApi>;
	return typeof candidate.readBinary === 'function' && typeof candidate.writeBinary === 'function'
		? (candidate as BinaryFileApi)
		: null;
}

export class BackupService {
	constructor(
		private readonly app: App,
		private readonly settings: SettingsStore,
		private readonly logger: Logger,
		/** Injectable clock, so folder names are deterministic under test. */
		private readonly now: () => number = () => Date.now(),
		/**
		 * Obsidian's config folder. Taken as an argument because `Vault.configDir` is missing
		 * on older API versions and on the in-memory test double.
		 */
		private readonly configDir: string = app.vault.configDir,
	) {}

	/** Folder every backup lives under. */
	rootDir(): string {
		return joinPath(this.configDir, 'plugins', PLUGIN_ID, BACKUP_DIR_NAME);
	}

	/**
	 * Copy `files` into a fresh timestamped folder.
	 *
	 * The vault-relative path is preserved underneath the folder, so `notes/a.md` lands at
	 * `<backups>/2026-06-15-12-00-00/notes/a.md` and two same-named files from different
	 * folders cannot overwrite each other.
	 *
	 * A file that cannot be read is skipped and reported, never recorded as backed up — the
	 * whole point of the manifest is that everything in it can be restored.
	 *
	 * @param files Vault-relative paths to copy.
	 * @param label Description of the batch, shown when restoring.
	 * @returns The backup folder, or null when no usable backup could be made.
	 */
	async create(files: readonly string[], label: string): Promise<string | null> {
		// Trimmed before normalising, because `normalizeVaultPath` only touches slashes: a
		// whitespace-only entry would otherwise survive as a "path", reserve a folder, fail to
		// copy, and be reported as a failed backup instead of as the empty request it is.
		const sources = Array.from(
			new Set(
				files
					.map((path) => normalizeVaultPath(path.trim()))
					.filter((path) => path.length > 0),
			),
		);
		if (sources.length === 0) {
			// Nothing to protect means nothing to restore, so there is no backup to point at.
			this.logger.warn('Refusing to create an empty backup.');
			return null;
		}

		let dir: string;
		try {
			dir = await this.reserveDir();
		} catch (error) {
			this.logger.error(STRINGS.backup.failed, error);
			return null;
		}

		const copied: string[] = [];
		const skipped: string[] = [];
		for (const source of sources) {
			try {
				await this.copy(source, joinPath(dir, source));
				copied.push(source);
			} catch (error) {
				skipped.push(source);
				this.logger.warn(STRINGS.errors.readFailed(source), error);
			}
		}

		if (skipped.length > 0) {
			this.logger.warn(
				`${STRINGS.preview.skippedUnreadable}: ${skipped.length} of ${sources.length} files`,
			);
		}
		if (copied.length === 0) {
			await this.removeDir(dir);
			this.logger.error(STRINGS.backup.failed);
			return null;
		}

		const manifest: BackupManifest = {
			dir,
			createdAt: this.now(),
			label,
			files: copied,
		};

		// The eviction list has to be computed before the write, because the settings store
		// clamps `backups` to MAX_BACKUPS itself and would otherwise drop the entries whose
		// folders still need deleting.
		const next = [manifest, ...this.settings.get().backups];
		const evicted = next.slice(MAX_BACKUPS);
		try {
			await this.settings.update((settings) => {
				settings.backups = next.slice(0, MAX_BACKUPS);
			}, true);
		} catch (error) {
			// The copies exist but nothing can find them, so the caller must not treat this as
			// a usable backup. The folder is left alone rather than deleted: destroying a copy
			// of the user's data because `data.json` was unwritable would be the worse bug.
			this.logger.error('Could not record the backup manifest', error);
			return null;
		}

		for (const old of evicted) await this.removeDir(old.dir);
		this.logger.info(STRINGS.backup.created(dir));
		return dir;
	}

	/**
	 * Write every file in the newest backup back to its original path.
	 *
	 * One unwritable file never aborts the rest — a partial restore of nine files out of ten
	 * is far more useful than none — so failures are collected and reported instead of thrown.
	 */
	async restoreLatest(): Promise<RestoreResult> {
		const restored: string[] = [];
		const failed: string[] = [];

		const manifest = this.settings.get().backups[0];
		if (!manifest) {
			this.logger.warn(STRINGS.backup.none);
			return { restored, failed };
		}

		for (const path of manifest.files) {
			try {
				await this.restoreOne(manifest.dir, path);
				restored.push(path);
			} catch (error) {
				this.logger.error(STRINGS.errors.writeFailed(path), error);
				failed.push(path);
			}
		}

		this.logger.info(STRINGS.backup.restored(restored.length));
		return { restored, failed };
	}

	/**
	 * Every recorded backup, newest first.
	 *
	 * Deep enough copies that a caller sorting or splicing the result cannot corrupt the
	 * persisted manifest list.
	 */
	list(): BackupManifest[] {
		return this.settings.get().backups.map((manifest) => ({
			dir: manifest.dir,
			createdAt: manifest.createdAt,
			label: manifest.label,
			files: [...manifest.files],
		}));
	}

	/**
	 * Enforce the retention limit on disk.
	 *
	 * Folders belonging to evicted manifests go first. Then any folder older than the oldest
	 * backup still tracked is swept up, which reclaims the leftovers of a run that crashed
	 * between `mkdir` and the manifest write. Newer untracked folders are deliberately left
	 * alone: one of them may belong to a backup being written right now.
	 */
	async prune(): Promise<void> {
		const current = [...this.settings.get().backups];
		const kept = current.slice(0, MAX_BACKUPS);
		const evicted = current.slice(MAX_BACKUPS);

		if (evicted.length > 0) {
			try {
				await this.settings.update((settings) => {
					settings.backups = settings.backups.slice(0, MAX_BACKUPS);
				}, true);
			} catch (error) {
				// The manifest list on disk still references these folders, so deleting them
				// now would leave a restore pointing at nothing.
				this.logger.error('Could not shorten the backup list', error);
				return;
			}
		}

		for (const manifest of evicted) await this.removeDir(manifest.dir);
		await this.sweepOrphanFolders(kept);
	}

	/* -------------------------------------------------------------- internals -- */

	/**
	 * Create and return an unused backup folder.
	 *
	 * Two fix batches inside the same second would otherwise share a folder name and mix
	 * their files together, so a numeric suffix is appended until the name is free.
	 */
	private async reserveDir(): Promise<string> {
		const adapter = this.app.vault.adapter;
		const root = this.rootDir();
		const stamp = backupStamp(this.now());

		let candidate = joinPath(root, stamp);
		for (let attempt = 2; await adapter.exists(candidate); attempt++) {
			// Running out of names must fail loudly. Falling through to `mkdir` on a folder that
			// already exists would merge this batch into someone else's backup, and evicting
			// either manifest would then delete the other's files.
			if (attempt > MAX_STAMP_ATTEMPTS) {
				throw new Error(`No unused backup folder name is available under "${root}"`);
			}
			candidate = joinPath(root, `${stamp}-${attempt}`);
		}

		await adapter.mkdir(candidate);
		return candidate;
	}

	/** Copy one file, creating the destination folder first. */
	private async copy(source: string, destination: string): Promise<void> {
		const adapter = this.app.vault.adapter;
		const folder = getFolderPath(destination);
		if (folder.length > 0) await adapter.mkdir(folder);

		const binary = isAttachmentPath(source) ? binaryApiOf(adapter) : null;
		if (binary) {
			await binary.writeBinary(destination, await binary.readBinary(source));
			return;
		}
		await adapter.write(destination, await adapter.read(source));
	}

	/** Write one backed-up file back over its original path, recreating parent folders. */
	private async restoreOne(dir: string, path: string): Promise<void> {
		const adapter = this.app.vault.adapter;
		const source = joinPath(dir, path);
		const folder = getFolderPath(path);
		if (folder.length > 0) await adapter.mkdir(folder);

		const binary = isAttachmentPath(path) ? binaryApiOf(adapter) : null;
		if (binary) {
			await binary.writeBinary(path, await binary.readBinary(source));
			return;
		}
		await adapter.write(path, await adapter.read(source));
	}

	/**
	 * Delete backup folders no manifest points at any more.
	 *
	 * Folder names are timestamps, so comparing them as strings compares them chronologically
	 * — which is what keeps an in-flight backup (a name newer than everything tracked) safe.
	 */
	private async sweepOrphanFolders(kept: readonly BackupManifest[]): Promise<void> {
		const oldest = kept[kept.length - 1];
		// With nothing tracked there is no way to tell garbage from a backup mid-write.
		if (!oldest) return;

		const adapter = this.app.vault.adapter;
		const root = this.rootDir();
		try {
			if (!(await adapter.exists(root))) return;
			const listed = await adapter.list(root);
			const tracked = new Set(kept.map((manifest) => normalizeVaultPath(manifest.dir)));
			const boundary = normalizeVaultPath(oldest.dir);

			for (const folder of listed.folders) {
				const normalized = normalizeVaultPath(folder);
				if (tracked.has(normalized) || normalized >= boundary) continue;
				await this.removeDir(normalized);
			}
		} catch (error) {
			this.logger.warn(`Could not list the backup folder "${root}"`, error);
		}
	}

	/**
	 * Remove a backup folder and everything under it.
	 *
	 * The path is confined to {@link rootDir} first. `dir` reaches here from `data.json`, which
	 * is plain JSON a user can edit and a half-finished write can truncate; an empty or hand
	 * edited value would otherwise turn routine housekeeping into `rmdir('', recursive)` — a
	 * recursive delete of the vault root. The backup folder itself is refused too, so one bad
	 * manifest cannot take every other backup with it.
	 *
	 * Failures are logged and swallowed on purpose: housekeeping that cannot delete an old
	 * folder must never fail the fix batch that triggered it.
	 */
	private async removeDir(dir: string): Promise<void> {
		const normalized = normalizeVaultPath(dir);
		const root = this.rootDir();
		if (!normalized.startsWith(`${root}/`)) {
			this.logger.error(
				`Refusing to remove "${dir}": it is not inside the backup folder "${root}".`,
			);
			return;
		}

		const adapter = this.app.vault.adapter;
		try {
			if (await adapter.exists(normalized)) await adapter.rmdir(normalized, true);
		} catch (error) {
			this.logger.warn(`Could not remove the backup folder "${dir}"`, error);
		}
	}
}
