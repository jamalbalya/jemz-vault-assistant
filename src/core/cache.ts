/**
 * Small in-memory caches.
 *
 * Scan results and derived link/tag tables are expensive to rebuild, so they are cached and
 * invalidated by path rather than recomputed on every render.
 */

interface CacheEntry<V> {
	value: V;
	/** Epoch ms after which the entry is stale, or null when it never expires by time. */
	expiresAt: number | null;
	/** Paths whose change should evict this entry. */
	dependencies: readonly string[];
}

export interface CacheOptions {
	/** Time to live in milliseconds. Omit for entries that only expire on invalidation. */
	ttlMs?: number;
	/** Evict this entry when any of these vault paths changes. */
	dependencies?: readonly string[];
}

/** A keyed cache with optional TTL and dependency-based invalidation. */
export class Cache<V> {
	private readonly entries = new Map<string, CacheEntry<V>>();
	private readonly maxEntries: number;
	private readonly now: () => number;

	constructor(maxEntries = 200, now: () => number = Date.now) {
		this.maxEntries = maxEntries;
		this.now = now;
	}

	/** Read a value, or undefined when missing or expired. */
	get(key: string): V | undefined {
		const entry = this.entries.get(key);
		if (!entry) return undefined;
		if (entry.expiresAt !== null && entry.expiresAt <= this.now()) {
			this.entries.delete(key);
			return undefined;
		}
		// Refresh insertion order so eviction stays roughly least-recently-used.
		this.entries.delete(key);
		this.entries.set(key, entry);
		return entry.value;
	}

	/** Whether a live entry exists. */
	has(key: string): boolean {
		return this.get(key) !== undefined;
	}

	/** Store a value. */
	set(key: string, value: V, options: CacheOptions = {}): void {
		if (this.entries.size >= this.maxEntries && !this.entries.has(key)) {
			const oldest = this.entries.keys().next();
			if (!oldest.done) this.entries.delete(oldest.value);
		}
		this.entries.set(key, {
			value,
			expiresAt: options.ttlMs === undefined ? null : this.now() + options.ttlMs,
			dependencies: options.dependencies ?? [],
		});
	}

	/** Read a value, computing and storing it when absent. */
	getOrCompute(key: string, compute: () => V, options: CacheOptions = {}): V {
		const existing = this.get(key);
		if (existing !== undefined) return existing;
		const value = compute();
		this.set(key, value, options);
		return value;
	}

	/** Drop one entry. */
	delete(key: string): void {
		this.entries.delete(key);
	}

	/** Drop every entry that depends on any of `paths`. */
	invalidateDependents(paths: readonly string[]): number {
		if (paths.length === 0) return 0;
		const targets = new Set(paths);
		let removed = 0;
		for (const [key, entry] of this.entries) {
			if (entry.dependencies.some((dependency) => targets.has(dependency))) {
				this.entries.delete(key);
				removed++;
			}
		}
		return removed;
	}

	/** Drop every entry whose key starts with `prefix`. */
	invalidatePrefix(prefix: string): number {
		let removed = 0;
		for (const key of Array.from(this.entries.keys())) {
			if (key.startsWith(prefix)) {
				this.entries.delete(key);
				removed++;
			}
		}
		return removed;
	}

	/** Drop everything. */
	clear(): void {
		this.entries.clear();
	}

	/** Live entry count, including entries that have expired but not yet been read. */
	get size(): number {
		return this.entries.size;
	}
}
