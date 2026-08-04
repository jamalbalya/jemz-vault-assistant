/**
 * Runs health scans without ever blocking the UI.
 *
 * A scan is three phases: decide what is in scope, read the file bodies the enabled
 * detectors actually need, then run the detectors. File reading happens in chunks with a
 * yield between them, and the detector pass is chunked the same way, so a 10 000 note vault
 * stays responsive throughout.
 *
 * Scans are cancellable and non-reentrant: starting one while another runs returns the
 * running promise rather than doubling the work.
 */

import type { App } from 'obsidian';
import type {
	Detector,
	DetectorContext,
	HealthIssue,
	HealthReport,
	IssueType,
	ScanKind,
} from '../../types/health';
import { ISSUE_TYPES } from '../../types/health';
import type { ContentStats, NoteRecord } from '../../types/note';
import type { HealthSettings, JemzSettings } from '../../types/settings';
import type { EventBus } from '../../core/event-bus';
import { errorMessage, type Logger } from '../../core/logger';
import { isInAnyFolder } from '../../utils/file';
import { yieldToUi } from '../../utils/debounce';
import { isInboxNote } from '../../services/inbox-service';
import type { ContentIndex } from '../../services/content-index';
import type { VaultIndex } from '../../services/vault-index';
import { calculateHealthScore, countByType } from './health-score';
import brokenLinksDetector from './detectors/broken-links';
import orphanNotesDetector from './detectors/orphan-notes';
import emptyNotesDetector from './detectors/empty-notes';
import unusedAttachmentsDetector from './detectors/unused-attachments';
import duplicateTitlesDetector from './detectors/duplicate-titles';
import tagInconsistenciesDetector from './detectors/tag-inconsistencies';
import missingMetadataDetector from './detectors/missing-metadata';
import largeFilesDetector from './detectors/large-files';

/** The detectors that ship with the plugin, in the order they run. */
export const DEFAULT_DETECTORS: readonly Detector[] = [
	brokenLinksDetector,
	orphanNotesDetector,
	emptyNotesDetector,
	unusedAttachmentsDetector,
	duplicateTitlesDetector,
	tagInconsistenciesDetector,
	missingMetadataDetector,
	largeFilesDetector,
];

export interface ScanEngineDeps {
	app: App;
	index: VaultIndex;
	content: ContentIndex;
	getSettings: () => JemzSettings;
	logger: Logger;
	bus: EventBus;
	now?: () => number;
	detectors?: readonly Detector[];
}

export interface ScanOptions {
	onProgress?: (phase: string, processed: number, total: number) => void;
	/** Restrict an incremental scan to files that changed. */
	changedPaths?: readonly string[];
}

/** Raised when a scan is cancelled. Callers treat it as a normal outcome. */
export class ScanCancelledError extends Error {
	constructor() {
		super('Scan cancelled');
		this.name = 'ScanCancelledError';
	}
}

export class ScanEngine {
	private readonly detectors: readonly Detector[];
	private readonly now: () => number;
	private running: Promise<HealthReport> | null = null;
	private abortFlag = { aborted: false };
	private lastReport: HealthReport | null = null;

	constructor(private readonly deps: ScanEngineDeps) {
		this.detectors = deps.detectors ?? DEFAULT_DETECTORS;
		this.now = deps.now ?? Date.now;
	}

	/** The most recent report, or null before the first scan. */
	get report(): HealthReport | null {
		return this.lastReport;
	}

	/** Whether a scan is in flight. */
	get isScanning(): boolean {
		return this.running !== null;
	}

	/** Ask the running scan to stop at the next chunk boundary. */
	cancel(): void {
		this.abortFlag.aborted = true;
	}

	/**
	 * Run a scan.
	 *
	 * Concurrent calls share the in-flight run instead of scanning twice.
	 */
	async scan(kind: ScanKind = 'full', options: ScanOptions = {}): Promise<HealthReport> {
		if (this.running) return this.running;
		this.abortFlag = { aborted: false };
		this.running = this.execute(kind, options).finally(() => {
			this.running = null;
		});
		return this.running;
	}

	private async execute(kind: ScanKind, options: ScanOptions): Promise<HealthReport> {
		const startedAt = this.now();
		const settings = this.deps.getSettings();
		let scope = this.buildScope(settings.health);

		this.deps.bus.emit('scan-started', { total: scope.notes.length, kind });

		try {
			// A detector runs when any category it emits is enabled; it then checks the
			// individual flags itself.
			const enabled = this.detectors.filter((detector) =>
				(detector.emits ?? [detector.type]).some(
					(type) => settings.health.detectors[type] !== false,
				),
			);

			// Only read file bodies when a detector that needs them is actually enabled.
			let context = this.buildContext(scope, settings.health);
			if (enabled.some((detector) => detector.needsContent)) {
				await this.deps.content.ensureLoaded(scope.notes, {
					chunkSize: settings.health.scanChunkSize,
					signal: this.abortFlag,
					onProgress: (processed, total) => {
						options.onProgress?.('read', processed, total);
						this.deps.bus.emit('scan-progress', {
							phase: 'read',
							processed,
							total,
						});
					},
				});
				// Reading a file teaches the index whether that file opens with a `---`
				// fence, which Obsidian's cache cannot report once the YAML fails to parse.
				// The index replaces its records rather than mutating them, so the scope
				// captured above still holds the pre-read snapshots — rebuild it, or a note
				// with corrupt frontmatter is reported as merely missing properties.
				scope = this.buildScope(settings.health);
				context = this.buildContext(scope, settings.health);
			}
			this.assertNotCancelled();
			const issues: HealthIssue[] = [];
			let ignoredCount = 0;

			for (let i = 0; i < enabled.length; i++) {
				this.assertNotCancelled();
				const detector = enabled[i];
				if (!detector) continue;
				try {
					const produced = detector.run(context);
					for (const issue of produced) {
						if (this.isIgnored(issue, settings.health)) ignoredCount++;
						else issues.push(issue);
					}
				} catch (error) {
					// One broken detector must not lose the whole report.
					this.deps.logger.error(`Detector "${detector.type}" failed`, error);
				}
				options.onProgress?.('analyse', i + 1, enabled.length);
				this.deps.bus.emit('scan-progress', {
					phase: 'analyse',
					processed: i + 1,
					total: enabled.length,
				});
				if (i + 1 < enabled.length) await yieldToUi();
			}

			const countsByType = countByType(issues);
			const report: HealthReport = {
				generatedAt: this.now(),
				durationMs: this.now() - startedAt,
				filesScanned: scope.notes.length + scope.attachments.length,
				kind,
				issues,
				countsByType,
				score: calculateHealthScore(countsByType, settings.health.weights),
				ignoredCount,
			};

			this.lastReport = report;
			this.deps.bus.emit('scan-completed', { report });
			this.deps.logger.info(
				`Scan (${kind}) found ${issues.length} issues in ${report.durationMs}ms`,
			);
			return report;
		} catch (error) {
			if (error instanceof ScanCancelledError) {
				this.deps.logger.info('Scan cancelled');
				throw error;
			}
			this.deps.logger.error('Scan failed', error);
			this.deps.bus.emit('scan-failed', { error: errorMessage(error) });
			throw error;
		}
	}

	private assertNotCancelled(): void {
		if (this.abortFlag.aborted) throw new ScanCancelledError();
	}

	/** Split the vault into in-scope notes, in-scope attachments, and everything. */
	private buildScope(health: HealthSettings): {
		notes: NoteRecord[];
		attachments: NoteRecord[];
		allFiles: NoteRecord[];
	} {
		const settings = this.deps.getSettings();
		const inboxFolder = settings.capture.inboxFolder.trim();
		const allFiles = this.deps.index.all();
		const excludedTags = health.excludedTags
			.map((tag) => tag.trim().replace(/^#/, '').toLowerCase())
			.filter((tag) => tag.length > 0);
		const excludedExtensions = health.excludedExtensions
			.map((extension) => extension.trim().replace(/^\./, '').toLowerCase())
			.filter((extension) => extension.length > 0);

		const inScope = (record: NoteRecord): boolean => {
			if (isInAnyFolder(record.path, health.excludedFolders)) return false;
			if (excludedExtensions.includes(record.extension)) return false;
			if (excludedTags.length > 0 && record.tags.some((tag) => excludedTags.includes(tag))) {
				return false;
			}
			if (health.excludeArchived && record.status?.toLowerCase() === 'archived') return false;
			if (health.excludeInbox && this.isInbox(record, inboxFolder)) return false;
			return true;
		};

		const notes: NoteRecord[] = [];
		const attachments: NoteRecord[] = [];
		for (const record of allFiles) {
			if (!inScope(record)) continue;
			if (record.isAttachment) attachments.push(record);
			else notes.push(record);
		}
		return { notes, attachments, allFiles };
	}

	/**
	 * Whether a record counts as an unprocessed capture.
	 *
	 * Delegates to the inbox service's own rule so "skip the inbox" covers exactly what the
	 * inbox tab shows — a note that has been processed is an ordinary note again and should
	 * be scanned like one, even if it still sits in the inbox folder.
	 */
	private isInbox(record: NoteRecord, inboxFolder: string): boolean {
		return isInboxNote(record, inboxFolder);
	}

	private buildContext(
		scope: { notes: NoteRecord[]; attachments: NoteRecord[]; allFiles: NoteRecord[] },
		health: HealthSettings,
	): DetectorContext {
		const content = this.deps.content;
		const index = this.deps.index;
		return {
			notes: scope.notes,
			attachments: scope.attachments,
			allFiles: scope.allFiles,
			settings: health,
			now: this.now(),
			getStats: (path: string): ContentStats | null => content.peekStats(path),
			backlinksOf: (path: string): readonly string[] => index.backlinksOf(path),
		};
	}

	private isIgnored(issue: HealthIssue, health: HealthSettings): boolean {
		const ignored = health.ignore.byType[issue.type];
		return Array.isArray(ignored) && ignored.includes(issue.id);
	}

	/** An empty report, used before the first scan so views have something to render. */
	static emptyReport(weights: JemzSettings['health']['weights']): HealthReport {
		const countsByType = {} as Record<IssueType, number>;
		for (const type of ISSUE_TYPES) countsByType[type] = 0;
		return {
			generatedAt: 0,
			durationMs: 0,
			filesScanned: 0,
			kind: 'full',
			issues: [],
			countsByType,
			score: calculateHealthScore(countsByType, weights),
			ignoredCount: 0,
		};
	}
}
