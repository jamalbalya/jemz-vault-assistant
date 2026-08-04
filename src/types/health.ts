/** Vault health types: issues, scan reports, scoring, and the fix/preview pipeline. */

import type { ContentStats, NoteRecord } from './note';
import type { HealthSettings } from './settings';

/** Every kind of problem the scan engine can report. */
export const ISSUE_TYPES = [
	'broken-link',
	'orphan-note',
	'empty-note',
	'unused-attachment',
	'duplicate-title',
	'tag-inconsistency',
	'missing-metadata',
	'large-file',
	'corrupted-frontmatter',
] as const;

export type IssueType = (typeof ISSUE_TYPES)[number];

export type IssueSeverity = 'low' | 'medium' | 'high';

export interface BrokenLinkIssueData {
	readonly kind: 'broken-link';
	readonly target: string;
	readonly raw: string;
	readonly line: number;
	readonly col: number;
	readonly isEmbed: boolean;
	readonly isMarkdownLink: boolean;
}

export interface DuplicateTitleIssueData {
	readonly kind: 'duplicate-title';
	readonly paths: readonly string[];
	readonly normalizedTitle: string;
	readonly similarity: number;
	readonly exact: boolean;
}

export interface TagInconsistencyIssueData {
	readonly kind: 'tag-inconsistency';
	readonly variants: readonly { readonly tag: string; readonly count: number }[];
	readonly canonical: string;
	readonly paths: readonly string[];
}

export interface MissingMetadataIssueData {
	readonly kind: 'missing-metadata';
	readonly missing: readonly string[];
}

export interface LargeFileIssueData {
	readonly kind: 'large-file';
	readonly size: number;
	readonly threshold: number;
}

export interface EmptyNoteIssueData {
	readonly kind: 'empty-note';
	readonly contentLength: number;
	readonly size: number;
}

export interface GenericIssueData {
	readonly kind: 'generic';
}

export type IssueData =
	| BrokenLinkIssueData
	| DuplicateTitleIssueData
	| TagInconsistencyIssueData
	| MissingMetadataIssueData
	| LargeFileIssueData
	| EmptyNoteIssueData
	| GenericIssueData;

/** One detected problem. `id` is stable across scans so ignore lists keep working. */
export interface HealthIssue {
	readonly id: string;
	readonly type: IssueType;
	/** Primary file the issue belongs to. Group issues also list members in `data`. */
	readonly path: string;
	readonly title: string;
	readonly detail: string;
	readonly severity: IssueSeverity;
	readonly data: IssueData;
}

/**
 * Everything a detector is allowed to see.
 *
 * Deliberately structural rather than a reference to the index services, so detectors stay
 * pure functions that a unit test can drive with a hand-built object.
 */
export interface DetectorContext {
	/** Markdown notes in scope, after folder/tag/extension/inbox/archive exclusions. */
	readonly notes: readonly NoteRecord[];
	/** Non-markdown files in scope. */
	readonly attachments: readonly NoteRecord[];
	/**
	 * Every file in the vault regardless of exclusions. Detectors that need to know whether
	 * something is referenced (unused attachments) must consult this, otherwise an excluded
	 * note's links would look like they do not exist.
	 */
	readonly allFiles: readonly NoteRecord[];
	readonly settings: HealthSettings;
	/** Reference instant, injectable so date-sensitive checks are deterministic. */
	readonly now: number;
	/** Content counts for a note, or null when unreadable or not yet loaded. */
	getStats(path: string): ContentStats | null;
	/** Paths of notes linking to `path`. */
	backlinksOf(path: string): readonly string[];
}

/** One check that turns a {@link DetectorContext} into issues. */
export interface Detector {
	/** Primary category, used for grouping and as the default of {@link emits}. */
	readonly type: IssueType;
	/** Human readable name, used in progress messages. */
	readonly label: string;
	/**
	 * Every issue type this detector can produce.
	 *
	 * Most detectors emit only their own `type`, but the frontmatter detector reports both
	 * `missing-metadata` and `corrupted-frontmatter`. The scan engine runs a detector when
	 * *any* of these types is enabled, and the detector then checks each flag itself —
	 * otherwise turning off one category would silently disable the other.
	 */
	readonly emits?: readonly IssueType[];
	/**
	 * True when this detector needs content counts, so the scan engine knows to load file
	 * bodies before running it.
	 */
	readonly needsContent?: boolean;
	run(context: DetectorContext): HealthIssue[];
}

/** Progress emitted while a scan runs. */
export interface ScanProgress {
	readonly phase: string;
	readonly processed: number;
	readonly total: number;
}

export type ScanKind = 'full' | 'incremental' | 'scheduled';

/** Per-category contribution to the health score. */
export interface ScorePenalty {
	readonly type: IssueType;
	readonly count: number;
	readonly perUnit: number;
	readonly max: number;
	readonly penalty: number;
}

export interface HealthScore {
	/** 0-100, rounded to one decimal. */
	readonly value: number;
	readonly penalties: readonly ScorePenalty[];
	readonly totalPenalty: number;
}

/** Result of a completed scan. */
export interface HealthReport {
	readonly generatedAt: number;
	readonly durationMs: number;
	readonly filesScanned: number;
	readonly kind: ScanKind;
	readonly issues: readonly HealthIssue[];
	readonly countsByType: Readonly<Record<IssueType, number>>;
	readonly score: HealthScore;
	/** Ids of issues suppressed by the ignore lists during this scan. */
	readonly ignoredCount: number;
}

/** Identifies one fix operation offered for an issue type. */
export type FixActionId =
	| 'create-note'
	| 'replace-link'
	| 'remove-link'
	| 'add-tag'
	| 'move-to-archive'
	| 'trash'
	| 'delete-permanently'
	| 'merge-tags'
	| 'rename'
	| 'add-metadata'
	| 'ignore';

/** How a planned change touches the vault. */
export type ChangeKind = 'modify' | 'create' | 'move' | 'trash' | 'delete';

/** One concrete file operation, shown verbatim in the preview modal. */
export interface PlannedChange {
	readonly path: string;
	readonly kind: ChangeKind;
	readonly description: string;
	/** Excerpt of the current content for modify operations. */
	readonly before?: string;
	/** Excerpt of the resulting content for modify operations. */
	readonly after?: string;
	/** Destination for move operations. */
	readonly targetPath?: string;
	/**
	 * File mtime captured while building the plan. If the file changed since, the apply
	 * step skips it rather than overwriting newer content (addendum section 6.5).
	 */
	readonly expectedMtime: number;
}

/** A reviewed batch of changes awaiting confirmation. */
export interface FixPlan {
	readonly actionId: FixActionId;
	readonly label: string;
	readonly issues: readonly HealthIssue[];
	readonly changes: readonly PlannedChange[];
	/** Files that will be copied into the backup folder before anything is written. */
	readonly filesToBackup: readonly string[];
	/** True when the batch permanently destroys data and needs a second confirmation. */
	readonly destructive: boolean;
}

export interface SkippedChange {
	readonly change: PlannedChange;
	readonly reason: string;
}

/** Outcome of applying a {@link FixPlan}. */
export interface FixResult {
	readonly actionId: FixActionId;
	readonly applied: readonly PlannedChange[];
	readonly skipped: readonly SkippedChange[];
	readonly failed: readonly SkippedChange[];
	readonly backupDir: string | null;
	readonly durationMs: number;
}

/** One entry in the persisted backup manifest. */
export interface BackupManifest {
	readonly dir: string;
	readonly createdAt: number;
	readonly label: string;
	readonly files: readonly string[];
}
