/**
 * The rolling record of everything this plugin changed (main spec 6.4).
 *
 * The log exists so a user can answer "what did the plugin just do to my vault?" days later,
 * which means it has to survive a crash and a restart: entries are written straight through
 * the settings store with `immediate`, never coalesced. It is capped at
 * {@link MAX_ACTION_LOG_ENTRIES} because `data.json` is loaded on every startup and an
 * unbounded log would slowly turn into a startup cost.
 *
 * Entries are stored newest first so the Settings viewer, the result summary, and
 * {@link ActionLogService.recent} all read the interesting end of the list without sorting.
 */

import { MAX_ACTION_LOG_ENTRIES } from '../core/constants';
import type { EventBus } from '../core/event-bus';
import type { Logger } from '../core/logger';
import { hashString } from '../core/safety';
import type { SettingsStore } from '../core/settings';
import { STRINGS } from '../core/strings';
import type { ActionLogEntry } from '../types/settings';

/**
 * Everything a caller supplies when logging an action.
 *
 * `id` and `timestamp` are deliberately generated here rather than accepted, so two call
 * sites can never disagree about the clock or mint colliding ids.
 */
export type ActionLogInput = Omit<ActionLogEntry, 'id' | 'timestamp'>;

/**
 * Raised when an entry could not be persisted.
 *
 * Typed so a fix batch can tell "the vault change failed" apart from "the audit trail could
 * not be written", which are very different things to show the user.
 */
export class ActionLogError extends Error {
	constructor(
		message: string,
		/** Whatever the settings store threw, kept for the console. */
		readonly reason: unknown = null,
	) {
		super(message);
		this.name = 'ActionLogError';
	}
}

export class ActionLogService {
	/**
	 * Distinguishes entries logged inside the same millisecond.
	 *
	 * A fix batch writes several entries in a tight loop, and `Date.now()` alone is not fine
	 * grained enough to keep their ids unique — which the Settings list relies on for keys.
	 */
	private sequence = 0;

	constructor(
		private readonly settings: SettingsStore,
		private readonly bus: EventBus,
		private readonly logger: Logger,
		/** Injectable clock so tests get deterministic timestamps. */
		private readonly now: () => number = () => Date.now(),
	) {}

	/**
	 * Record one action, trimming the oldest entries past the cap.
	 *
	 * @param input The action, without its id and timestamp.
	 * @returns The stored entry, including the generated id and timestamp.
	 * @throws {ActionLogError} when the entry could not be persisted.
	 */
	async log(input: ActionLogInput): Promise<ActionLogEntry> {
		const timestamp = this.now();
		const entry: ActionLogEntry = {
			...input,
			// Copy the file list so a caller mutating its own array cannot rewrite history.
			files: [...input.files],
			id: this.nextId(timestamp, input),
			timestamp,
		};

		// The store mutates in place and persists afterwards, so a failed write leaves the new
		// entry sitting in memory. Keeping the old list lets it be put back.
		const previous = this.settings.get().actionLog;
		try {
			await this.settings.update((settings) => {
				const next = [entry, ...settings.actionLog];
				settings.actionLog =
					next.length > MAX_ACTION_LOG_ENTRIES
						? next.slice(0, MAX_ACTION_LOG_ENTRIES)
						: next;
			}, true);
		} catch (error) {
			this.rollback(previous);
			this.logger.error(`Could not persist the action log entry "${entry.action}"`, error);
			throw new ActionLogError(STRINGS.errors.unexpected, error);
		}

		// Emitted only after the write succeeded, so a listener never renders an entry that
		// will be gone after a restart.
		this.bus.emit('action-logged', { entry });
		return entry;
	}

	/**
	 * Every stored entry, newest first.
	 *
	 * Returns a copy: the Settings viewer iterates this list while the user clears the log,
	 * and it must not observe the array being emptied underneath it.
	 */
	entries(): readonly ActionLogEntry[] {
		return [...this.settings.get().actionLog];
	}

	/**
	 * The newest `limit` entries.
	 *
	 * A non-positive or non-finite limit yields an empty list rather than throwing, because
	 * the value usually comes from a settings field the user can type into.
	 */
	recent(limit: number): ActionLogEntry[] {
		if (!Number.isFinite(limit) || limit <= 0) return [];
		return this.settings.get().actionLog.slice(0, Math.floor(limit));
	}

	/**
	 * Drop every entry.
	 *
	 * @throws {ActionLogError} when the empty log could not be persisted.
	 */
	async clear(): Promise<void> {
		const previous = this.settings.get().actionLog;
		try {
			await this.settings.update((settings) => {
				settings.actionLog = [];
			}, true);
		} catch (error) {
			// Otherwise the log looks empty until the next restart brings every entry back,
			// which reads as data loss followed by data resurrection.
			this.rollback(previous);
			this.logger.error('Could not clear the action log', error);
			throw new ActionLogError(STRINGS.errors.unexpected, error);
		}
		this.logger.info(STRINGS.settings.actionLogCleared);
	}

	/**
	 * Put a previous log back after a failed write.
	 *
	 * Both callers throw straight after this, and the contract of that throw is "nothing was
	 * recorded". Without the restore the in-memory log disagrees with `data.json`: the Settings
	 * viewer would show an entry that vanishes on restart, and the next unrelated settings
	 * write would quietly persist it after the caller was told it failed.
	 *
	 * `settings-changed` is re-emitted because {@link SettingsStore.update} already announced
	 * the version that is being undone, and a view that redrew from it would stay wrong.
	 */
	private rollback(previous: ActionLogEntry[]): void {
		const settings = this.settings.get();
		settings.actionLog = previous;
		this.bus.emit('settings-changed', { settings });
	}

	/**
	 * A stable, collision-resistant id.
	 *
	 * Built from the content of the entry plus a monotonic counter rather than from a random
	 * source, because `crypto` is a Node API and is not available on Obsidian mobile.
	 */
	private nextId(timestamp: number, input: ActionLogInput): string {
		this.sequence += 1;
		const parts = [
			String(timestamp),
			String(this.sequence),
			input.action,
			input.result,
			input.files.join(' '),
		];
		return `${timestamp.toString(36)}-${hashString(parts.join('|'))}`;
	}
}
