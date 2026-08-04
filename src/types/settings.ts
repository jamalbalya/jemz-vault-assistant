/**
 * Settings shape and defaults.
 *
 * Everything here is persisted through `saveData`/`loadData` into
 * `.obsidian/plugins/jemz-vault-assistant/data.json` (addendum section 3.4). Per-device UI
 * state lives in {@link ../core/local-state} instead, so it never travels with a synced vault.
 */

import type { IssueType } from './health';
import type { SavedView, SortDirection, SortField } from './search';

export type LogLevel = 'silent' | 'error' | 'warn' | 'info' | 'debug';

export type ScanFrequency = 'manual' | 'daily' | 'weekly';

/** Score contribution for one issue category (main spec 6.2, addendum E-06). */
export interface ScoreWeight {
	/** Points subtracted per occurrence. */
	readonly per: number;
	/** Maximum total points this category may subtract. */
	readonly max: number;
}

export interface GeneralSettings {
	/** Independently toggleable modules. */
	modules: {
		capture: boolean;
		health: boolean;
		retrieval: boolean;
	};
	showRibbonIcon: boolean;
	showStatusBar: boolean;
	logLevel: LogLevel;
	/** Items per page in the Inbox list. */
	inboxPageSize: number;
	/** Newest first when true. */
	inboxNewestFirst: boolean;
}

export interface CaptureSettings {
	inboxFolder: string;
	archiveFolder: string;
	/** Where archived attachments go (addendum E-04). */
	attachmentArchiveFolder: string;
	/** Tags added to every capture. */
	defaultTags: string[];
	defaultType: string;
	/** Create the inbox/archive folders when missing instead of failing. */
	autoCreateFolders: boolean;
	/** Extra frontmatter keys written on capture, values may use date tokens. */
	frontmatterTemplate: Record<string, string>;
	/** Confirm before creating the inbox folder the first time. */
	confirmFolderCreation: boolean;
}

export interface IgnoreLists {
	/** Ignored issue ids, keyed by issue type (main spec 6.3). */
	byType: Record<IssueType, string[]>;
}

export interface HealthSettings {
	autoScanOnStartup: boolean;
	scanFrequency: ScanFrequency;
	/** Epoch ms of the last scheduled scan, null when never run. */
	lastScheduledScan: number | null;
	/** Epoch ms of the last completed scan of any kind. */
	lastScanAt: number | null;
	excludedFolders: string[];
	excludedTags: string[];
	/** Lower-case extensions without the dot. */
	excludedExtensions: string[];
	/** Skip unprocessed captures — they are not vault decay yet. */
	excludeInbox: boolean;
	/** Skip notes with `status: archived`. */
	excludeArchived: boolean;
	/** Bodies shorter than this (frontmatter stripped) count as empty. */
	emptyNoteCharThreshold: number;
	/** Files smaller than this count as empty. */
	emptyNoteByteThreshold: number;
	largeFileThresholdBytes: number;
	/** Titles at or above this similarity are duplicates. */
	duplicateSimilarityThreshold: number;
	/**
	 * Fuzzy title comparison only applies from this length up. Short names differing by one
	 * character (`orphan-idea-1` vs `orphan-idea-2`) are siblings, not duplicates.
	 */
	duplicateMinFuzzyLength: number;
	/** Tags shorter than this use {@link tagShortMaxDistance}. */
	tagShortLengthCutoff: number;
	tagShortMaxDistance: number;
	tagLongMaxDistance: number;
	/**
	 * Leading characters two tags must share before they can be called variants.
	 * Stops `meeting`/`testing` and `finance`/`fitness` being offered as merges.
	 */
	tagMinSharedPrefix: number;
	/** Frontmatter keys every note should carry. */
	requiredFrontmatterFields: string[];
	weights: Record<IssueType, ScoreWeight>;
	/** Per-detector on/off switches. */
	detectors: Record<IssueType, boolean>;
	ignore: IgnoreLists;
	/** Use a Web Worker for the similarity passes when the platform provides one. */
	useWorker: boolean;
	/** Files processed per chunk when scanning on the main thread. */
	scanChunkSize: number;
}

export interface RetrievalSettings {
	staleThresholdDays: number;
	/** 0-1. Higher tolerates looser fuzzy matches. */
	fuzzySensitivity: number;
	defaultSortField: SortField;
	defaultSortDirection: SortDirection;
	resultsPerPage: number;
	/** User-created views only; built-ins are defined in code. */
	customViews: SavedView[];
	/** Pin/hide/order overrides for built-in views, keyed by view id. */
	builtInViewState: Record<string, { pinned: boolean; hidden: boolean; order: number }>;
	/** Keep `status: archived` notes out of the built-in views. */
	excludeArchivedFromViews: boolean;
	/** Minimum score for a note to appear in Similar Notes. */
	similarNotesMinScore: number;
	/** Maximum Similar Notes results. */
	similarNotesLimit: number;
	/** Ignore very short titles when hunting unlinked mentions. */
	unlinkedMentionMinLength: number;
}

/** Aggregate, anonymous counters. Never contains vault-derived text (addendum section 3.4). */
export interface AnalyticsData {
	/** Feature usage counts keyed by event name. */
	counts: Record<string, number>;
	/** Total milliseconds spent, keyed by event name. */
	durations: Record<string, number>;
	/** 'desktop' | 'mobile'. */
	platform: string;
	/** Bucketed vault size, e.g. '1k-5k'. Never the exact count. */
	vaultSizeBucket: string;
	firstRecordedAt: number | null;
	lastRecordedAt: number | null;
}

export interface AnalyticsSettings {
	/** Off by default and never enabled implicitly. */
	enabled: boolean;
	data: AnalyticsData;
}

/** One entry in the rolling action log (main spec 6.4). */
export interface ActionLogEntry {
	readonly id: string;
	readonly timestamp: number;
	readonly action: string;
	readonly details: string;
	readonly files: readonly string[];
	readonly result: 'success' | 'failure' | 'partial';
	readonly error?: string;
	readonly backupDir?: string;
}

export interface JemzSettings {
	/** Bumped whenever a migration is needed. */
	version: number;
	general: GeneralSettings;
	capture: CaptureSettings;
	health: HealthSettings;
	retrieval: RetrievalSettings;
	analytics: AnalyticsSettings;
	/** Most recent 100 actions, newest first. */
	actionLog: ActionLogEntry[];
	/** Most recent 10 fix backups, newest first. */
	backups: {
		dir: string;
		createdAt: number;
		label: string;
		files: string[];
	}[];
}

/** Current settings schema version. */
export const SETTINGS_VERSION = 1;

/** Default score weights (main spec 6.2 extended by addendum E-06). */
export const DEFAULT_WEIGHTS: Record<IssueType, ScoreWeight> = {
	'broken-link': { per: 0.5, max: 20 },
	'orphan-note': { per: 0.2, max: 15 },
	'empty-note': { per: 0.3, max: 10 },
	'unused-attachment': { per: 0.1, max: 10 },
	'duplicate-title': { per: 0.5, max: 10 },
	'tag-inconsistency': { per: 0.3, max: 10 },
	'missing-metadata': { per: 0.3, max: 5 },
	'large-file': { per: 0.2, max: 5 },
	// Reported for awareness; repairing YAML is a manual edit, so it carries no penalty.
	'corrupted-frontmatter': { per: 0, max: 0 },
};

export const DEFAULT_SETTINGS: JemzSettings = {
	version: SETTINGS_VERSION,
	general: {
		modules: { capture: true, health: true, retrieval: true },
		showRibbonIcon: true,
		showStatusBar: true,
		logLevel: 'warn',
		inboxPageSize: 50,
		inboxNewestFirst: true,
	},
	capture: {
		inboxFolder: '00-Inbox',
		archiveFolder: '04-Archive',
		attachmentArchiveFolder: '04-Archive/attachments',
		defaultTags: ['inbox'],
		defaultType: 'capture',
		autoCreateFolders: true,
		frontmatterTemplate: {},
		confirmFolderCreation: true,
	},
	health: {
		autoScanOnStartup: false,
		scanFrequency: 'manual',
		lastScheduledScan: null,
		lastScanAt: null,
		excludedFolders: [],
		excludedTags: [],
		excludedExtensions: [],
		excludeInbox: true,
		excludeArchived: false,
		emptyNoteCharThreshold: 20,
		emptyNoteByteThreshold: 50,
		largeFileThresholdBytes: 10 * 1024 * 1024,
		duplicateSimilarityThreshold: 0.9,
		duplicateMinFuzzyLength: 20,
		tagShortLengthCutoff: 6,
		tagMinSharedPrefix: 3,
		tagShortMaxDistance: 1,
		tagLongMaxDistance: 2,
		requiredFrontmatterFields: ['created', 'type'],
		weights: DEFAULT_WEIGHTS,
		detectors: {
			'broken-link': true,
			'orphan-note': true,
			'empty-note': true,
			'unused-attachment': true,
			'duplicate-title': true,
			'tag-inconsistency': true,
			'missing-metadata': true,
			'large-file': true,
			'corrupted-frontmatter': true,
		},
		ignore: {
			byType: {
				'broken-link': [],
				'orphan-note': [],
				'empty-note': [],
				'unused-attachment': [],
				'duplicate-title': [],
				'tag-inconsistency': [],
				'missing-metadata': [],
				'large-file': [],
				'corrupted-frontmatter': [],
			},
		},
		useWorker: true,
		scanChunkSize: 200,
	},
	retrieval: {
		staleThresholdDays: 180,
		fuzzySensitivity: 0.4,
		defaultSortField: 'modified',
		defaultSortDirection: 'desc',
		resultsPerPage: 50,
		customViews: [],
		builtInViewState: {},
		excludeArchivedFromViews: true,
		similarNotesMinScore: 0.15,
		similarNotesLimit: 10,
		unlinkedMentionMinLength: 4,
	},
	analytics: {
		enabled: false,
		data: {
			counts: {},
			durations: {},
			platform: 'unknown',
			vaultSizeBucket: 'unknown',
			firstRecordedAt: null,
			lastRecordedAt: null,
		},
	},
	actionLog: [],
	backups: [],
};
