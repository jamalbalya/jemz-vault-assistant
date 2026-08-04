/**
 * Per-device UI state (addendum section 3.4).
 *
 * Values here must never travel with a synced vault — a first-run dialog dismissed on the
 * desktop should still appear on a phone. Obsidian's `saveLocalStorage` keys are scoped per
 * vault and per device; when it is unavailable the store degrades to memory for the session.
 */

import type { Logger } from './logger';

/** The slice of the Obsidian `App` this store touches. */
export interface LocalStateHost {
	loadLocalStorage?(key: string): unknown;
	saveLocalStorage?(key: string, data: unknown): void;
}

export class LocalStateStore {
	private readonly memory = new Map<string, unknown>();
	private readonly usesFallback: boolean;

	constructor(
		private readonly host: LocalStateHost,
		private readonly logger?: Logger,
	) {
		this.usesFallback =
			typeof host.loadLocalStorage !== 'function' ||
			typeof host.saveLocalStorage !== 'function';
		if (this.usesFallback) {
			this.logger?.info('Local storage unavailable; per-device state is in-memory only.');
		}
	}

	/** Read a value, falling back to `fallback` when absent or of the wrong type. */
	get<T>(key: string, fallback: T): T {
		if (this.usesFallback) {
			const value = this.memory.get(key);
			return value === undefined ? fallback : (value as T);
		}
		try {
			const value = this.host.loadLocalStorage?.(key);
			return value === null || value === undefined ? fallback : (value as T);
		} catch (error) {
			this.logger?.warn(`Could not read local state "${key}"`, error);
			return fallback;
		}
	}

	/** Write a value. */
	set(key: string, value: unknown): void {
		if (this.usesFallback) {
			this.memory.set(key, value);
			return;
		}
		try {
			this.host.saveLocalStorage?.(key, value);
		} catch (error) {
			this.logger?.warn(`Could not write local state "${key}"`, error);
			this.memory.set(key, value);
		}
	}

	/** Remove a value. */
	remove(key: string): void {
		if (this.usesFallback) {
			this.memory.delete(key);
			return;
		}
		try {
			this.host.saveLocalStorage?.(key, null);
		} catch (error) {
			this.logger?.warn(`Could not clear local state "${key}"`, error);
		}
	}

	/** True when this store is not backed by real local storage. */
	get isMemoryOnly(): boolean {
		return this.usesFallback;
	}
}
