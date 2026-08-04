/**
 * The on-disk copy of the vault index (addendum 3.4).
 *
 * Rebuilding the index from `Vault` + `MetadataCache` is cheap for most vaults, so this only
 * pays for itself above {@link INDEX_PERSIST_THRESHOLD} notes — below that the cache costs
 * more to read and validate than it saves.
 *
 * What is written matters as much as when: paths, mtimes, sizes, a hash, and the derived
 * metadata the views filter on. Never a note body, never a link graph, never anything that
 * would let the cache file stand in for the vault's content if it leaked into a sync folder.
 *
 * The payload carries a version and a hash per entry. A payload written by an older build is
 * ignored rather than migrated, because a wrong index is worse than no index: it silently
 * hides notes from search results.
 */

import type { App } from 'obsidian';
import { INDEX_CACHE_FILE, INDEX_PERSIST_THRESHOLD, PLUGIN_ID } from '../core/constants';
import type { Logger } from '../core/logger';
import { hashString } from '../core/safety';
import { STRINGS } from '../core/strings';
import type { NoteRecord } from '../types/note';
import { getFolderPath, joinPath } from '../utils/file';

/** Bumped whenever {@link SerializedNote} changes shape. */
export const INDEX_CACHE_VERSION = 1;

/** One file's worth of cached metadata. Contains no note content. */
export interface SerializedNote {
	/** Vault-relative path including extension. */
	readonly path: string;
	/** File modification time in epoch milliseconds, straight from the file stat. */
	readonly mtime: number;
	/** File size in bytes. */
	readonly size: number;
	/** Hash of the metadata tuple, used to detect a changed file without reading it. */
	readonly hash: string;
	/** Parent folder path, or '' for vault root. */
	readonly folder: string;
	/** Lower-cased extension without the dot. */
	readonly extension: string;
	/** Creation time in epoch milliseconds. */
	readonly created: number;
	/** Modification time in epoch milliseconds. */
	readonly modified: number;
	/** Normalised `type` frontmatter value. */
	readonly type: string | null;
	/** Normalised `status` frontmatter value. */
	readonly status: string | null;
	/** Tags without the leading `#`, lower-cased. */
	readonly tags: readonly string[];
	/** True when the file is not markdown. */
	readonly isAttachment: boolean;
}

/** The whole cache file. */
export interface SerializedIndex {
	/** Schema version; a mismatch makes the payload unusable. */
	readonly version: number;
	/** Epoch milliseconds the cache was written. */
	readonly savedAt: number;
	/** Number of entries, so a truncated file is obvious. */
	readonly count: number;
	readonly entries: readonly SerializedNote[];
}

/** Raised when the cache file could not be deleted. */
export class IndexStoreError extends Error {
	constructor(
		message: string,
		/** Whatever the adapter threw, kept for the console. */
		readonly reason: unknown = null,
	) {
		super(message);
		this.name = 'IndexStoreError';
	}
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
	return typeof value === 'string' ? value : null;
}

function asNumber(value: unknown): number | null {
	return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Identity of a file's metadata.
 *
 * Built from the fields a stale cache would get wrong, so comparing hashes answers "is this
 * cached entry still true?" without reopening the file.
 */
export function metadataHash(record: NoteRecord): string {
	return hashString(
		[
			record.path,
			String(record.fileModified),
			String(record.size),
			String(record.created),
			String(record.modified),
			record.type ?? '',
			record.status ?? '',
			record.extension,
			[...record.tags].join(','),
			record.isAttachment ? '1' : '0',
		].join('\n'),
	);
}

function toSerializedNote(record: NoteRecord): SerializedNote {
	return {
		path: record.path,
		mtime: record.fileModified,
		size: record.size,
		hash: metadataHash(record),
		folder: record.folder,
		extension: record.extension,
		created: record.created,
		modified: record.modified,
		type: record.type,
		status: record.status,
		tags: [...record.tags],
		isAttachment: record.isAttachment,
	};
}

/**
 * Rebuild one entry from parsed JSON.
 *
 * Every field is checked rather than trusted: the file lives in a folder users sync, edit,
 * and occasionally restore from an old snapshot.
 *
 * @returns The entry, or null when anything is missing or the wrong type.
 */
function parseSerializedNote(value: unknown): SerializedNote | null {
	if (!isPlainObject(value)) return null;

	const path = asString(value.path);
	const hash = asString(value.hash);
	const mtime = asNumber(value.mtime);
	const size = asNumber(value.size);
	const created = asNumber(value.created);
	const modified = asNumber(value.modified);
	if (path === null || path.length === 0 || hash === null) return null;
	if (mtime === null || size === null || created === null || modified === null) return null;

	const tags = Array.isArray(value.tags)
		? value.tags.filter((tag): tag is string => typeof tag === 'string')
		: null;
	if (tags === null) return null;

	return {
		path,
		mtime,
		size,
		hash,
		folder: asString(value.folder) ?? '',
		extension: asString(value.extension) ?? '',
		created,
		modified,
		type: asString(value.type),
		status: asString(value.status),
		tags,
		isAttachment: value.isAttachment === true,
	};
}

export class IndexStore {
	constructor(
		private readonly app: App,
		private readonly logger: Logger,
		/** Injectable clock so `savedAt` is deterministic under test. */
		private readonly now: () => number = () => Date.now(),
		/**
		 * Obsidian's config folder. Taken as an argument because `Vault.configDir` is missing
		 * on older API versions and on the in-memory test double.
		 */
		private readonly configDir: string = app.vault.configDir,
	) {}

	/** Vault-relative path of the cache file. */
	cachePath(): string {
		return joinPath(this.configDir, 'plugins', PLUGIN_ID, INDEX_CACHE_FILE);
	}

	/**
	 * Whether a vault of `count` notes is worth caching.
	 *
	 * The threshold is inclusive: a vault sitting exactly on it is already large enough that
	 * reloading from the cache beats rebuilding from scratch.
	 */
	shouldPersist(count: number): boolean {
		return Number.isFinite(count) && count >= INDEX_PERSIST_THRESHOLD;
	}

	/**
	 * Write the index to disk, if the vault is big enough to warrant it.
	 *
	 * When it is not, any existing cache is deleted instead of left behind — a file written
	 * while the vault held 8,000 notes must not be reloaded after the user archived 5,000 of
	 * them elsewhere.
	 *
	 * @returns True when a cache was written. A failed write is logged and reported as false
	 * rather than thrown, because the cache is an optimisation and must never break startup.
	 */
	async save(records: readonly NoteRecord[]): Promise<boolean> {
		const path = this.cachePath();
		if (!this.shouldPersist(records.length)) {
			await this.discardStaleCache();
			this.logger.debug(`Not caching ${records.length} records; below the threshold.`);
			return false;
		}

		const payload: SerializedIndex = {
			version: INDEX_CACHE_VERSION,
			savedAt: this.now(),
			count: records.length,
			entries: records.map(toSerializedNote),
		};

		try {
			const adapter = this.app.vault.adapter;
			const folder = getFolderPath(path);
			if (folder.length > 0) await adapter.mkdir(folder);
			await adapter.write(path, JSON.stringify(payload));
			this.logger.debug(`Cached ${payload.count} index records to "${path}"`);
			return true;
		} catch (error) {
			this.logger.error(STRINGS.errors.writeFailed(path), error);
			return false;
		}
	}

	/**
	 * Read the cache back.
	 *
	 * @returns The payload, or null when it is absent, unreadable, corrupt, or was written by
	 * a different schema version.
	 */
	async load(): Promise<SerializedIndex | null> {
		const path = this.cachePath();
		try {
			const adapter = this.app.vault.adapter;
			if (!(await adapter.exists(path))) return null;
			const parsed: unknown = JSON.parse(await adapter.read(path));
			const payload = this.validate(parsed, path);
			return payload;
		} catch (error) {
			this.logger.warn(STRINGS.errors.readFailed(path), error);
			return null;
		}
	}

	/**
	 * Delete the cache file.
	 *
	 * @throws {IndexStoreError} when the file exists but cannot be removed.
	 */
	async clear(): Promise<void> {
		const path = this.cachePath();
		try {
			const adapter = this.app.vault.adapter;
			if (await adapter.exists(path)) await adapter.remove(path);
		} catch (error) {
			this.logger.error(STRINGS.errors.writeFailed(path), error);
			throw new IndexStoreError(STRINGS.errors.writeFailed(path), error);
		}
	}

	/* -------------------------------------------------------------- internals -- */

	/**
	 * Turn parsed JSON into a payload, or reject it.
	 *
	 * A single bad entry invalidates the whole file. Loading the survivors would leave the
	 * index quietly incomplete, and "some of your notes are missing from search" is a far
	 * worse outcome than one slower startup.
	 */
	private validate(value: unknown, path: string): SerializedIndex | null {
		if (!isPlainObject(value) || !Array.isArray(value.entries)) {
			this.logger.warn(`Ignoring the malformed index cache at "${path}"`);
			return null;
		}
		if (value.version !== INDEX_CACHE_VERSION) {
			this.logger.warn(
				`Ignoring the index cache at "${path}": version ${String(value.version)} is not ${INDEX_CACHE_VERSION}`,
			);
			return null;
		}

		const entries: SerializedNote[] = [];
		for (const raw of value.entries) {
			const entry = parseSerializedNote(raw);
			if (!entry) {
				this.logger.warn(`Ignoring the index cache at "${path}": an entry is malformed`);
				return null;
			}
			entries.push(entry);
		}

		// `count` exists so a truncated file is obvious: a JSON payload cut short by a failed
		// write or a sync conflict still parses, and its surviving entries still validate, so
		// the declared length is the only thing left that disagrees. A short index is exactly
		// the failure this module refuses to serve — it hides notes from search rather than
		// slowing startup down. A payload with no `count` at all predates nothing and is
		// accepted; only a stated count that does not match is treated as damage.
		const declared = asNumber(value.count);
		if (declared !== null && declared !== entries.length) {
			this.logger.warn(
				`Ignoring the index cache at "${path}": it declares ${declared} entries but carries ${entries.length}`,
			);
			return null;
		}

		return {
			version: INDEX_CACHE_VERSION,
			savedAt: asNumber(value.savedAt) ?? 0,
			count: declared ?? entries.length,
			entries,
		};
	}

	/**
	 * Best-effort removal of a cache that should no longer exist.
	 *
	 * Failure here is not worth propagating: {@link save} already told the caller it wrote
	 * nothing, and a leftover file is rejected on load anyway once it stops matching.
	 */
	private async discardStaleCache(): Promise<void> {
		try {
			await this.clear();
		} catch (error) {
			this.logger.debug('Could not remove the stale index cache', error);
		}
	}
}
