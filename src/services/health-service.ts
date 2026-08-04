/**
 * The health module's public face.
 *
 * Owns scan scheduling (manual, incremental on file change, and the daily/weekly timer),
 * the ignore lists, and the cached report every view reads from. Views never talk to the
 * scan engine directly, so there is a single place where "what does the vault look like
 * right now" is decided.
 */

import type { HealthIssue, HealthReport, IssueType, ScanKind } from '../types/health';
import type { JemzSettings } from '../types/settings';
import type { EventBus } from '../core/event-bus';
import type { Logger } from '../core/logger';
import type { SettingsStore } from '../core/settings';
import { TIMING } from '../core/constants';
import { MS_PER_DAY } from '../utils/date';
import { debounce, type DebouncedFunction } from '../utils/debounce';
import { ScanCancelledError, ScanEngine } from '../modules/health/scan-engine';
import { scoreBand } from '../modules/health/health-score';

export interface HealthServiceDeps {
	engine: ScanEngine;
	settings: SettingsStore;
	bus: EventBus;
	logger: Logger;
	now?: () => number;
}

export class HealthService {
	private readonly now: () => number;
	private readonly incrementalScan: DebouncedFunction<[]>;
	private pendingPaths = new Set<string>();

	constructor(private readonly deps: HealthServiceDeps) {
		this.now = deps.now ?? Date.now;
		this.incrementalScan = debounce(() => {
			const changed = Array.from(this.pendingPaths);
			this.pendingPaths.clear();
			void this.run('incremental', changed);
		}, TIMING.incrementalScanDebounce);
	}

	/** The latest report, or an empty one before the first scan. */
	get report(): HealthReport {
		return (
			this.deps.engine.report ??
			ScanEngine.emptyReport(this.deps.settings.get().health.weights)
		);
	}

	/** Current health score, 0-100. */
	get score(): number {
		return this.report.score.value;
	}

	/** Qualitative band for the current score. */
	get band(): 'excellent' | 'good' | 'fair' | 'poor' {
		return scoreBand(this.score);
	}

	/** Whether a scan has ever completed. */
	get hasScanned(): boolean {
		return this.deps.engine.report !== null;
	}

	/** Whether a scan is in flight. */
	get isScanning(): boolean {
		return this.deps.engine.isScanning;
	}

	/** Run a full scan now. */
	async runFullScan(
		onProgress?: (phase: string, processed: number, total: number) => void,
	): Promise<HealthReport | null> {
		return this.run('full', undefined, onProgress);
	}

	/** Queue an incremental scan for a changed file, coalescing rapid edits. */
	queueIncremental(path: string): void {
		this.pendingPaths.add(path);
		this.incrementalScan();
	}

	/** Run any pending incremental scan immediately. */
	flushIncremental(): void {
		this.incrementalScan.flush();
	}

	/** Stop a running scan and drop anything queued. */
	cancel(): void {
		this.deps.engine.cancel();
		this.incrementalScan.cancel();
		this.pendingPaths.clear();
	}

	private async run(
		kind: ScanKind,
		changedPaths?: readonly string[],
		onProgress?: (phase: string, processed: number, total: number) => void,
	): Promise<HealthReport | null> {
		try {
			const report = await this.deps.engine.scan(kind, {
				...(changedPaths ? { changedPaths } : {}),
				...(onProgress ? { onProgress } : {}),
			});
			await this.deps.settings.update((settings) => {
				settings.health.lastScanAt = report.generatedAt;
				if (kind === 'scheduled') settings.health.lastScheduledScan = report.generatedAt;
			});
			return report;
		} catch (error) {
			if (error instanceof ScanCancelledError) return null;
			// The engine already logged and emitted scan-failed; views react to that event.
			return null;
		}
	}

	/* --------------------------------------------------------------- issues -- */

	/** Issues of one type from the current report. */
	issuesOfType(type: IssueType): HealthIssue[] {
		return this.report.issues.filter((issue) => issue.type === type);
	}

	/** Types that currently have at least one issue, most numerous first. */
	activeTypes(): { type: IssueType; count: number }[] {
		return Object.entries(this.report.countsByType)
			.map(([type, count]) => ({ type: type as IssueType, count }))
			.filter((entry) => entry.count > 0)
			.sort((a, b) => b.count - a.count);
	}

	/* ---------------------------------------------------------- ignore lists -- */

	/** Suppress an issue from every future scan. */
	async ignore(issues: readonly HealthIssue[]): Promise<void> {
		if (issues.length === 0) return;
		await this.deps.settings.update((settings) => {
			for (const issue of issues) {
				const list = settings.health.ignore.byType[issue.type];
				if (!list.includes(issue.id)) list.push(issue.id);
			}
		}, true);
		this.deps.logger.info(`Ignored ${issues.length} issue(s)`);
	}

	/** Stop suppressing one issue. */
	async unignore(type: IssueType, id: string): Promise<void> {
		await this.deps.settings.update((settings) => {
			settings.health.ignore.byType[type] = settings.health.ignore.byType[type].filter(
				(candidate) => candidate !== id,
			);
		}, true);
	}

	/** Clear one ignore list, or every list when no type is given. */
	async clearIgnored(type?: IssueType): Promise<void> {
		await this.deps.settings.update((settings) => {
			if (type) {
				settings.health.ignore.byType[type] = [];
				return;
			}
			for (const key of Object.keys(settings.health.ignore.byType) as IssueType[]) {
				settings.health.ignore.byType[key] = [];
			}
		}, true);
	}

	/** How many issues are currently ignored, per type. */
	ignoredCounts(): Record<IssueType, number> {
		const ignore = this.deps.settings.get().health.ignore.byType;
		const result = {} as Record<IssueType, number>;
		for (const key of Object.keys(ignore) as IssueType[]) {
			result[key] = ignore[key].length;
		}
		return result;
	}

	/* ------------------------------------------------------------ scheduling -- */

	/**
	 * Whether a scheduled scan is overdue.
	 *
	 * Exposed separately from {@link runScheduledIfDue} so the caller can decide when to
	 * check without the service owning a timer it cannot clean up.
	 */
	isScheduledScanDue(settings: JemzSettings = this.deps.settings.get()): boolean {
		const { scanFrequency, lastScheduledScan } = settings.health;
		if (scanFrequency === 'manual') return false;
		if (lastScheduledScan === null) return true;
		const interval = scanFrequency === 'daily' ? MS_PER_DAY : MS_PER_DAY * 7;
		return this.now() - lastScheduledScan >= interval;
	}

	/** Run a scheduled scan when one is due. Safe to call often. */
	async runScheduledIfDue(): Promise<HealthReport | null> {
		if (!this.isScheduledScanDue()) return null;
		if (this.isScanning) return null;
		this.deps.logger.info('Running scheduled health scan');
		return this.run('scheduled');
	}

	/** Release timers. Called on plugin unload. */
	dispose(): void {
		this.incrementalScan.cancel();
		this.pendingPaths.clear();
	}
}
