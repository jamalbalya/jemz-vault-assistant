/** Plugin-wide constants: ids, icons, limits, and timings. */

/** Manifest id. Never change this — it is the plugin's stable identity. */
export const PLUGIN_ID = 'jemz-vault-assistant';

export const PLUGIN_NAME = 'Jemz Vault Assistant';

/** Registered view type for the unified dashboard. */
export const VIEW_TYPE_DASHBOARD = 'jemz-dashboard';

/** Command ids. Stable API — renaming breaks user hotkeys. */
export const COMMAND_IDS = {
	openDashboard: 'open-dashboard',
	quickCapture: 'quick-capture',
	startTriage: 'start-triage',
	runHealthScan: 'run-health-scan',
	viewInbox: 'view-inbox',
	viewHealth: 'view-health',
	viewFind: 'view-find',
	searchNotes: 'search-notes',
	toggleStatusBar: 'toggle-status-bar',
	restoreLastBackup: 'restore-last-fix-backup',
} as const;

/** Lucide icons from Obsidian's built-in set. */
export const ICONS = {
	plugin: 'compass',
	inbox: 'inbox',
	health: 'heart-pulse',
	find: 'search',
	capture: 'plus-circle',
	archive: 'archive',
	trash: 'trash-2',
	warning: 'alert-triangle',
	success: 'check-circle',
	unknownFile: 'file-question',
	unlink: 'unlink',
	tag: 'tag',
	calendar: 'calendar',
	open: 'file-text',
	move: 'folder-input',
	link: 'link',
	settings: 'settings',
	refresh: 'refresh-cw',
	chevronLeft: 'chevron-left',
	chevronRight: 'chevron-right',
	close: 'x',
	pin: 'pin',
	copy: 'copy',
	newPane: 'separator-vertical',
} as const;

/** Icon per note type, used by the inbox list and search results. */
export const TYPE_ICONS: Readonly<Record<string, string>> = {
	capture: 'plus-circle',
	idea: 'lightbulb',
	task: 'check-square',
	reference: 'book-open',
	meeting: 'users',
	project: 'folder-kanban',
	note: 'file-text',
	daily: 'calendar',
	template: 'layout-template',
};

/** Where fix backups and the serialized index live, relative to the plugin folder. */
export const BACKUP_DIR_NAME = 'backups';
export const INDEX_CACHE_FILE = 'index-cache.json';

/** Keep at most this many fix backups (addendum section 3.4). */
export const MAX_BACKUPS = 10;

/** Keep at most this many action log entries (main spec 6.4). */
export const MAX_ACTION_LOG_ENTRIES = 100;

/** Above this many notes the index is persisted between sessions (addendum section 3.4). */
export const INDEX_PERSIST_THRESHOLD = 5000;

/** Timings, all in milliseconds. */
export const TIMING = {
	/** File change events coalesce before an incremental scan runs. */
	incrementalScanDebounce: 500,
	/** Search input debounce. */
	searchDebounce: 300,
	/** Status bar refresh debounce. */
	statusBarDebounce: 250,
	/** How often the scheduled-scan timer checks whether it is due. */
	scheduleCheckInterval: 60 * 60 * 1000,
} as const;

/** Preview length for inbox items, in characters. */
export const INBOX_PREVIEW_LENGTH = 100;

/** Per-device local storage keys (never synced). */
export const LOCAL_STATE_KEYS = {
	firstRunCompleted: 'jemz-first-run-completed',
	lastTab: 'jemz-last-dashboard-tab',
} as const;

/** Documentation links shown in Settings and the welcome modal. */
export const LINKS = {
	repository: 'https://github.com/jamalbalya/jemz-vault-assistant',
	issues: 'https://github.com/jamalbalya/jemz-vault-assistant/issues',
	readme: 'https://github.com/jamalbalya/jemz-vault-assistant#readme',
	changelog: 'https://github.com/jamalbalya/jemz-vault-assistant/blob/main/CHANGELOG.md',
} as const;

/** Sibling plugin id used for optional, gracefully degrading integration (appendix E). */
export const JEMZSYNC_PLUGIN_ID = 'jemzsync';
