/**
 * The safety layer every file modification must pass through (main spec 6.3, addendum 6.5).
 *
 * Guarantees enforced here rather than in each call site:
 *  - nothing is written without an explicit confirmation token,
 *  - a backup exists before the first write of a batch,
 *  - a file that changed since the preview was built is skipped, never overwritten,
 *  - a file that cannot be read is never treated as deletable,
 *  - one failing change does not abort the rest of the batch.
 */

import type { FixPlan, FixResult, PlannedChange, SkippedChange } from '../types/health';
import { STRINGS } from './strings';
import type { Logger } from './logger';
import { errorMessage } from './logger';

/**
 * Proof that a human confirmed a specific plan.
 *
 * Only {@link grantConfirmation} can mint one, so an accidental call path cannot fabricate
 * consent by passing an object literal.
 */
export interface ConfirmationToken {
	readonly planId: string;
	readonly grantedAt: number;
	/** @internal Brand that keeps the type nominal. */
	readonly __brand: unique symbol;
}

/** Mint a confirmation token. Call this only from a user-driven confirm handler. */
export function grantConfirmation(planId: string): ConfirmationToken {
	return {
		planId,
		grantedAt: Date.now(),
		// The brand only exists in the type system.
	} as unknown as ConfirmationToken;
}

/** Applies one change to the vault. Supplied by the fix-actions module. */
export type ChangeExecutor = (change: PlannedChange) => Promise<void>;

/** Everything the gate needs from the outside world. */
export interface SafetyDeps {
	/** Current mtime of a vault path, or null when the file no longer exists. */
	getMtime(path: string): number | null;
	/** False when the vault cannot be written to. */
	isWritable(): boolean;
	/**
	 * Copy `files` somewhere safe and return the backup folder path.
	 * Return null when no backup could be made.
	 */
	createBackup(files: readonly string[], label: string): Promise<string | null>;
	logger: Logger;
}

export interface ExecuteOptions {
	/** Called after each change with the number completed so far. */
	onProgress?: (done: number, total: number) => void;
	/**
	 * Skip backup creation. Only valid when the plan creates files and touches nothing
	 * that already exists.
	 */
	skipBackup?: boolean;
}

/** Raised when a plan reaches the vault without a matching confirmation token. */
export class UnconfirmedChangeError extends Error {
	constructor(planId: string) {
		super(`${STRINGS.errors.notConfirmed} (plan ${planId})`);
		this.name = 'UnconfirmedChangeError';
	}
}

/** Raised when the vault is read-only. */
export class ReadOnlyVaultError extends Error {
	constructor() {
		super(STRINGS.errors.vaultReadOnly);
		this.name = 'ReadOnlyVaultError';
	}
}

/** Raised when a backup was required but could not be created. */
export class BackupFailedError extends Error {
	constructor() {
		super(STRINGS.backup.failed);
		this.name = 'BackupFailedError';
	}
}

/** Change kinds that operate on a file that must already exist. */
const KINDS_REQUIRING_EXISTING_FILE: ReadonlySet<PlannedChange['kind']> = new Set([
	'modify',
	'move',
	'trash',
	'delete',
]);

export class SafetyGate {
	constructor(private readonly deps: SafetyDeps) {}

	/**
	 * Apply a confirmed plan.
	 *
	 * @throws {UnconfirmedChangeError} when `token` does not match `plan`.
	 * @throws {ReadOnlyVaultError} when the vault cannot be written.
	 * @throws {BackupFailedError} when a backup was required but failed.
	 */
	async execute(
		plan: FixPlan,
		token: ConfirmationToken | null,
		executor: ChangeExecutor,
		options: ExecuteOptions = {},
	): Promise<FixResult> {
		const planId = planIdOf(plan);
		if (!token || token.planId !== planId) {
			throw new UnconfirmedChangeError(planId);
		}
		if (!this.deps.isWritable()) {
			throw new ReadOnlyVaultError();
		}

		const startedAt = Date.now();
		let backupDir: string | null = null;

		const needsBackup = !options.skipBackup && plan.filesToBackup.length > 0;
		if (needsBackup) {
			backupDir = await this.deps.createBackup(plan.filesToBackup, plan.label);
			if (backupDir === null) {
				this.deps.logger.error('Backup failed; refusing to apply the fix batch.');
				throw new BackupFailedError();
			}
		}

		const applied: PlannedChange[] = [];
		const skipped: SkippedChange[] = [];
		const failed: SkippedChange[] = [];
		const total = plan.changes.length;

		for (let index = 0; index < total; index++) {
			const change = plan.changes[index];
			if (!change) continue;

			const conflict = this.detectConflict(change);
			if (conflict) {
				skipped.push({ change, reason: conflict });
				options.onProgress?.(index + 1, total);
				continue;
			}

			try {
				await executor(change);
				applied.push(change);
			} catch (error) {
				this.deps.logger.error(`Change failed for "${change.path}"`, error);
				failed.push({ change, reason: errorMessage(error) });
			}
			options.onProgress?.(index + 1, total);
		}

		return {
			actionId: plan.actionId,
			applied,
			skipped,
			failed,
			backupDir,
			durationMs: Date.now() - startedAt,
		};
	}

	/**
	 * Whether a change is still safe to apply.
	 *
	 * @returns A human readable reason to skip, or null when the change is safe.
	 */
	private detectConflict(change: PlannedChange): string | null {
		if (!KINDS_REQUIRING_EXISTING_FILE.has(change.kind)) return null;

		const currentMtime = this.deps.getMtime(change.path);
		if (currentMtime === null) {
			// The file vanished between preview and apply. Nothing to do, and definitely
			// nothing to delete.
			return STRINGS.errors.fileNotFound(change.path);
		}
		if (change.expectedMtime > 0 && currentMtime !== change.expectedMtime) {
			return STRINGS.preview.skippedConflict;
		}
		return null;
	}
}

/**
 * Stable identity for a plan, derived from its content.
 *
 * Rebuilding the same plan yields the same id, so a token minted for a preview stays valid
 * for the plan the user actually saw — and stops matching if the plan changes underneath.
 */
export function planIdOf(plan: FixPlan): string {
	const parts = [
		plan.actionId,
		String(plan.changes.length),
		...plan.changes.map(
			(change) =>
				`${change.kind}:${change.path}:${change.targetPath ?? ''}:${change.expectedMtime}`,
		),
	];
	return hashString(parts.join('|'));
}

/** FNV-1a, adequate for identity and short enough to log. */
export function hashString(input: string): string {
	let hash = 0x811c9dc5;
	for (let i = 0; i < input.length; i++) {
		hash ^= input.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash.toString(16).padStart(8, '0');
}
