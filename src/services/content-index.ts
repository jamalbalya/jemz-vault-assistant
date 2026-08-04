/**
 * Lazily-read file bodies and the counts derived from them.
 *
 * Reading every note would break the sub-500 ms load budget, so nothing here runs during
 * `onload`. Scans and content-dependent filters call {@link ContentIndex.ensureLoaded},
 * which reads in chunks and yields to the UI between them.
 *
 * Bodies are cached against the file's mtime and evicted least-recently-used once the cache
 * exceeds its character budget, keeping memory well under the 100 MB target on large vaults.
 */

import type { App, TFile } from 'obsidian';
import type { ContentStats, NoteRecord } from '../types/note';
import { countWords, splitFrontmatter } from '../utils/string';
import { yieldToUi } from '../utils/debounce';
import type { Logger } from '../core/logger';
import type { VaultIndex } from './vault-index';

interface CachedContent {
	mtime: number;
	body: string;
	stats: ContentStats;
}

/** Roughly 40 MB of UTF-16 text before eviction kicks in. */
const DEFAULT_CHARACTER_BUDGET = 20_000_000;

export class ContentIndex {
	private readonly entries = new Map<string, CachedContent>();
	private cachedCharacters = 0;

	constructor(
		private readonly app: App,
		private readonly index: VaultIndex,
		private readonly logger: Logger,
		private readonly characterBudget = DEFAULT_CHARACTER_BUDGET,
	) {}

	/**
	 * Read one note, using the cache when the file has not changed.
	 *
	 * @returns The body with frontmatter stripped, or an empty string when unreadable.
	 */
	async body(path: string): Promise<string> {
		const entry = await this.load(path);
		return entry?.body ?? '';
	}

	/** Counts for one note, or null when the file is missing or unreadable. */
	async stats(path: string): Promise<ContentStats | null> {
		const entry = await this.load(path);
		return entry?.stats ?? null;
	}

	/** Cached counts without touching the disk, or null when not loaded yet. */
	peekStats(path: string): ContentStats | null {
		const entry = this.entries.get(path);
		const file = this.app.vault.getFileByPath(path);
		if (!entry || !file || entry.mtime !== file.stat.mtime) return null;
		return entry.stats;
	}

	/** Cached body without touching the disk, or null when not loaded yet. */
	peekBody(path: string): string | null {
		const entry = this.entries.get(path);
		const file = this.app.vault.getFileByPath(path);
		if (!entry || !file || entry.mtime !== file.stat.mtime) return null;
		return entry.body;
	}

	/**
	 * Read a set of notes in chunks, yielding to the UI between them.
	 *
	 * @param records Notes to load. Attachments are skipped.
	 * @param options.chunkSize How many files to read before yielding.
	 * @param options.onProgress Called after each chunk.
	 * @param options.signal Aborts the load when it flips to true.
	 */
	async ensureLoaded(
		records: readonly NoteRecord[],
		options: {
			chunkSize?: number;
			onProgress?: (processed: number, total: number) => void;
			signal?: { aborted: boolean };
		} = {},
	): Promise<void> {
		const targets = records.filter((record) => !record.isAttachment);
		const chunkSize = Math.max(1, options.chunkSize ?? 200);
		const total = targets.length;

		for (let start = 0; start < total; start += chunkSize) {
			if (options.signal?.aborted) return;
			const chunk = targets.slice(start, start + chunkSize);
			await Promise.all(chunk.map((record) => this.load(record.path)));
			options.onProgress?.(Math.min(start + chunkSize, total), total);
			if (start + chunkSize < total) await yieldToUi();
		}
	}

	/** Forget one file, forcing the next read to hit the vault. */
	invalidate(path: string): void {
		const entry = this.entries.get(path);
		if (!entry) return;
		this.cachedCharacters -= entry.body.length;
		this.entries.delete(path);
	}

	/** Forget everything. */
	clear(): void {
		this.entries.clear();
		this.cachedCharacters = 0;
	}

	/** Number of cached files, for diagnostics and tests. */
	get size(): number {
		return this.entries.size;
	}

	private async load(path: string): Promise<CachedContent | null> {
		const file = this.app.vault.getFileByPath(path);
		if (!file) {
			this.invalidate(path);
			return null;
		}

		const cached = this.entries.get(path);
		if (cached && cached.mtime === file.stat.mtime) {
			// Refresh LRU position.
			this.entries.delete(path);
			this.entries.set(path, cached);
			return cached;
		}

		const entry = await this.read(file);
		if (!entry) return null;

		this.invalidate(path);
		this.entries.set(path, entry);
		this.cachedCharacters += entry.body.length;
		this.evictIfNeeded(path);
		return entry;
	}

	private async read(file: TFile): Promise<CachedContent | null> {
		try {
			const raw = await this.app.vault.cachedRead(file);
			const split = splitFrontmatter(raw);
			const body = split.body;
			const trimmed = body.trim();

			// Tell the index whether a `---` fence exists, which Obsidian's cache cannot
			// report once the YAML fails to parse.
			this.index.noteFrontmatterBlock(file.path, split.hasBlock);

			return {
				mtime: file.stat.mtime,
				body,
				stats: {
					contentLength: trimmed.length,
					wordCount: countWords(trimmed),
					size: file.stat.size,
					mtime: file.stat.mtime,
				},
			};
		} catch (error) {
			// An unreadable file is never treated as empty or deletable; callers see null.
			this.logger.warn(`Could not read "${file.path}"`, error);
			return null;
		}
	}

	private evictIfNeeded(keepPath: string): void {
		if (this.cachedCharacters <= this.characterBudget) return;
		for (const [path, entry] of this.entries) {
			if (this.cachedCharacters <= this.characterBudget) break;
			if (path === keepPath) continue;
			this.cachedCharacters -= entry.body.length;
			this.entries.delete(path);
		}
	}
}
