/**
 * Plugin entry point.
 *
 * Deliberately thin: it constructs services, registers everything Obsidian needs to know
 * about, and wires vault events to the index. All behaviour lives in the modules.
 *
 * Load stays under the 500 ms budget by doing almost nothing here — the vault index is
 * built on `onLayoutReady`, which is also the first moment Obsidian's own metadata cache is
 * fully populated, and file bodies are never read until a scan or a search asks for them.
 */

import { Notice, Plugin, TFile, type TAbstractFile, type WorkspaceLeaf } from 'obsidian';
import type { DashboardTab } from './types/events';
import { COMMAND_IDS, ICONS, TIMING, VIEW_TYPE_DASHBOARD } from './core/constants';
import { EventBus } from './core/event-bus';
import { LocalStateStore } from './core/local-state';
import { Logger, errorMessage } from './core/logger';
import { SettingsStore } from './core/settings';
import { SafetyGate } from './core/safety';
import { STRINGS } from './core/strings';
import { debounce } from './utils/debounce';
import { isMarkdownPath } from './utils/file';

import { VaultIndex } from './services/vault-index';
import { ContentIndex } from './services/content-index';
import { MetadataService } from './services/metadata-service';
import { LinkService } from './services/link-service';
import { TagService } from './services/tag-service';
import { AttachmentService } from './services/attachment-service';
import { CaptureService } from './services/capture-service';
import { InboxService } from './services/inbox-service';
import { HealthService } from './services/health-service';
import { RetrievalService } from './services/retrieval-service';
import { ActionLogService } from './services/action-log-service';
import { BackupService } from './services/backup-service';
import { AnalyticsService } from './services/analytics-service';
import { IndexStore } from './services/index-store';

import { ScanEngine } from './modules/health/scan-engine';
import { FixActions } from './modules/health/fix-actions';
import { DashboardView } from './modules/dashboard/dashboard-view';
import type { TabPanel } from './modules/dashboard/tab-manager';
import { StatusBarItem } from './modules/dashboard/status-bar';
import { QuickCaptureModal } from './modules/capture/quick-capture-modal';
import { InboxPanel } from './modules/inbox/inbox-view';
import { InboxActions } from './modules/inbox/inbox-actions';
import { TriageMode } from './modules/inbox/triage-mode';
import { HealthPanel } from './modules/health/health-view';
import { RecallPanel } from './modules/retrieval/recall-view';
import { JemzSettingTab } from './modules/settings/settings-tab';
import { maybeShowWelcome } from './modules/onboarding/welcome-modal';

export default class JemzVaultAssistantPlugin extends Plugin {
	private logger!: Logger;
	private bus!: EventBus;
	private settingsStore!: SettingsStore;
	private localState!: LocalStateStore;

	private index!: VaultIndex;
	private contentIndex!: ContentIndex;
	private metadata!: MetadataService;
	private links!: LinkService;
	private tags!: TagService;
	private attachments!: AttachmentService;
	private capture!: CaptureService;
	private inbox!: InboxService;
	private health!: HealthService;
	private retrieval!: RetrievalService;
	private actionLog!: ActionLogService;
	private backup!: BackupService;
	private analytics!: AnalyticsService;
	private indexStore!: IndexStore;

	private scanEngine!: ScanEngine;
	private fixActions!: FixActions;
	private safety!: SafetyGate;
	private inboxActions!: InboxActions;
	private triage!: TriageMode;
	private statusBar!: StatusBarItem;
	private ribbonEl: HTMLElement | null = null;

	override async onload(): Promise<void> {
		try {
			this.bus = new EventBus();
			this.logger = new Logger('warn');
			this.settingsStore = new SettingsStore(this, this.bus, this.logger);
			await this.settingsStore.load();
			this.localState = new LocalStateStore(this.app, this.logger);

			this.buildServices();
			this.registerViewAndChrome();
			this.registerCommands();
			this.registerVaultEvents();
			this.addSettingTab(new JemzSettingTab(this.app, this, this.settingTabDeps()));

			// Everything above is cheap. The index needs Obsidian's metadata cache to be
			// populated, which only happens once the layout is ready.
			this.app.workspace.onLayoutReady(() => void this.initialiseIndex());
		} catch (error) {
			this.logger?.error('Plugin failed to load', error);
			new Notice(STRINGS.plugin.loadFailed);
			throw error;
		}
	}

	override onunload(): void {
		// `unload()`, not `exit()`: the plugin is going away, so the overlay has to come off
		// `document.body` with no summary behind it. A summary raised here would outlive the
		// plugin that owns it, and its "Continue triaging" button would start a session
		// against services that are already being torn down.
		this.triage?.unload();
		this.health?.dispose();
		this.scanEngine?.cancel();
		this.statusBar?.dispose();
		this.contentIndex?.clear();
		this.bus?.clear();
		void this.settingsStore?.flush();
	}

	/* ------------------------------------------------------------- services -- */

	private buildServices(): void {
		const getSettings = (): ReturnType<SettingsStore['get']> => this.settingsStore.get();

		this.index = new VaultIndex(this.app, this.logger.child('index'));
		this.contentIndex = new ContentIndex(this.app, this.index, this.logger.child('content'));

		this.metadata = new MetadataService(this.app, this.logger.child('metadata'));
		this.links = new LinkService(this.app, this.logger.child('links'));
		this.tags = new TagService(this.app, this.index, this.logger.child('tags'));
		this.attachments = new AttachmentService(
			this.app,
			this.index,
			this.logger.child('attachments'),
		);
		this.capture = new CaptureService(this.app, getSettings, this.logger.child('capture'));
		this.inbox = new InboxService(
			this.app,
			this.index,
			this.metadata,
			getSettings,
			this.logger.child('inbox'),
		);

		this.actionLog = new ActionLogService(
			this.settingsStore,
			this.bus,
			this.logger.child('log'),
		);
		this.backup = new BackupService(this.app, this.settingsStore, this.logger.child('backup'));
		this.analytics = new AnalyticsService(this.settingsStore, this.logger.child('analytics'));
		this.indexStore = new IndexStore(this.app, this.logger.child('index-store'));

		this.scanEngine = new ScanEngine({
			app: this.app,
			index: this.index,
			content: this.contentIndex,
			getSettings,
			logger: this.logger.child('scan'),
			bus: this.bus,
		});
		this.health = new HealthService({
			engine: this.scanEngine,
			settings: this.settingsStore,
			bus: this.bus,
			logger: this.logger.child('health'),
		});
		this.retrieval = new RetrievalService({
			app: this.app,
			index: this.index,
			content: this.contentIndex,
			settings: this.settingsStore,
			logger: this.logger.child('retrieval'),
		});

		this.safety = new SafetyGate({
			getMtime: (path) => this.app.vault.getFileByPath(path)?.stat.mtime ?? null,
			isWritable: () => true,
			createBackup: (files, label) => this.backup.create(files, label),
			logger: this.logger.child('safety'),
		});
		this.fixActions = new FixActions({
			app: this.app,
			index: this.index,
			link: this.links,
			metadata: this.metadata,
			tag: this.tags,
			getSettings,
			logger: this.logger.child('fixes'),
		});

		this.inboxActions = new InboxActions({
			app: this.app,
			inbox: this.inbox,
			logger: this.logger.child('inbox-actions'),
			tagSuggestions: () => Array.from(this.tags.allTags().keys()),
		});
		// Triage drives the vault-touching half directly and owns its own pickers and
		// confirmations, so it takes the service rather than the UI wrapper — otherwise a
		// keyboard shortcut would open a picker inside a picker.
		this.triage = new TriageMode({
			app: this.app,
			inbox: this.inbox,
			actions: this.inbox,
			content: this.contentIndex,
			logger: this.logger.child('triage'),
		});
	}

	/** Build the index, then run whatever startup work the settings ask for. */
	private async initialiseIndex(): Promise<void> {
		try {
			const startedAt = Date.now();
			this.index.build();
			this.logger.info(`Index built in ${Date.now() - startedAt}ms`);

			this.bus.emit('index-updated', { changed: [] });
			this.bus.emit('inbox-changed', { count: this.inbox.count() });
			this.statusBar.requestUpdate();

			void this.analytics.setVaultSize(this.index.size);
			maybeShowWelcome({
				app: this.app,
				settings: this.settingsStore,
				localState: this.localState,
				logger: this.logger.child('onboarding'),
				onOpenDashboard: () => void this.openDashboard(),
			});

			const settings = this.settingsStore.get();
			if (settings.general.modules.health) {
				if (settings.health.autoScanOnStartup) void this.health.runFullScan();
				else void this.health.runScheduledIfDue();
			}
		} catch (error) {
			this.logger.error('Could not build the vault index', error);
			new Notice(STRINGS.errors.unexpected);
		}
	}

	/* ---------------------------------------------------------------- chrome -- */

	private registerViewAndChrome(): void {
		this.registerView(
			VIEW_TYPE_DASHBOARD,
			(leaf: WorkspaceLeaf) =>
				new DashboardView(leaf, {
					settings: this.settingsStore,
					bus: this.bus,
					localState: this.localState,
					logger: this.logger.child('dashboard'),
					createInboxPanel: () => this.createInboxPanel(),
					createHealthPanel: () => this.createHealthPanel(),
					createRecallPanel: () => this.createRecallPanel(),
					getInboxCount: () => this.inbox.count(),
					getHealthScore: () => this.health.score,
					openSettings: () => this.openPluginSettings(),
				}),
		);

		if (this.settingsStore.get().general.showRibbonIcon) {
			this.ribbonEl = this.addRibbonIcon(ICONS.plugin, STRINGS.plugin.ribbonTooltip, () => {
				void this.openDashboard();
			});
		}

		this.statusBar = new StatusBarItem({
			createEl: () => this.addStatusBarItem(),
			getInboxCount: () => (this.index.isBuilt ? this.inbox.count() : 0),
			getHealthScore: () => this.health.score,
			onClick: () => void this.openDashboard(),
			isVisible: () => this.settingsStore.get().general.showStatusBar,
		});
		this.statusBar.mount();

		this.register(
			this.bus.on('settings-changed', () => {
				this.statusBar.requestUpdate();
				this.logger.setLevel(this.settingsStore.get().general.logLevel);
			}),
		);
		this.register(this.bus.on('scan-completed', () => this.statusBar.requestUpdate()));
		this.register(this.bus.on('inbox-changed', () => this.statusBar.requestUpdate()));

		// Scheduled scans check in hourly rather than on a precise timer, which survives
		// the app being closed for days without firing a burst on wake.
		this.registerInterval(
			window.setInterval(() => {
				if (this.settingsStore.get().general.modules.health) {
					void this.health.runScheduledIfDue();
				}
			}, TIMING.scheduleCheckInterval),
		);
	}

	private createInboxPanel(): TabPanel {
		return new InboxPanel({
			app: this.app,
			inbox: this.inbox,
			actions: this.inboxActions,
			content: this.contentIndex,
			settings: this.settingsStore,
			bus: this.bus,
			logger: this.logger.child('inbox-view'),
			onStartTriage: () => void this.startTriage(),
			onCapture: () => this.openQuickCapture(),
		});
	}

	private createHealthPanel(): TabPanel {
		return new HealthPanel({
			app: this.app,
			health: this.health,
			fixes: this.fixActions,
			safety: this.safety,
			backup: this.backup,
			actionLog: this.actionLog,
			index: this.index,
			settings: this.settingsStore,
			bus: this.bus,
			logger: this.logger.child('health-view'),
			onOpenSettings: () => this.openPluginSettings(),
		});
	}

	private createRecallPanel(): TabPanel {
		return new RecallPanel({
			app: this.app,
			retrieval: this.retrieval,
			index: this.index,
			settings: this.settingsStore,
			bus: this.bus,
			logger: this.logger.child('recall-view'),
		});
	}

	private settingTabDeps(): {
		settings: SettingsStore;
		health: HealthService;
		actionLog: ActionLogService;
		analytics: AnalyticsService;
		backup: BackupService;
		logger: Logger;
	} {
		return {
			settings: this.settingsStore,
			health: this.health,
			actionLog: this.actionLog,
			analytics: this.analytics,
			backup: this.backup,
			logger: this.logger.child('settings'),
		};
	}

	/* -------------------------------------------------------------- commands -- */

	private registerCommands(): void {
		this.addCommand({
			id: COMMAND_IDS.openDashboard,
			name: STRINGS.commands.openDashboard,
			callback: () => void this.openDashboard(),
		});
		this.addCommand({
			id: COMMAND_IDS.quickCapture,
			name: STRINGS.commands.quickCapture,
			callback: () => this.withModule('capture', () => this.openQuickCapture()),
		});
		this.addCommand({
			id: COMMAND_IDS.startTriage,
			name: STRINGS.commands.startTriage,
			callback: () => this.withModule('capture', () => void this.startTriage()),
		});
		this.addCommand({
			id: COMMAND_IDS.runHealthScan,
			name: STRINGS.commands.runHealthScan,
			callback: () =>
				this.withModule('health', () => {
					void this.health.runFullScan();
				}),
		});
		this.addCommand({
			id: COMMAND_IDS.viewInbox,
			name: STRINGS.commands.viewInbox,
			callback: () => void this.openDashboard('inbox'),
		});
		this.addCommand({
			id: COMMAND_IDS.viewHealth,
			name: STRINGS.commands.viewHealth,
			callback: () => void this.openDashboard('health'),
		});
		this.addCommand({
			id: COMMAND_IDS.viewFind,
			name: STRINGS.commands.viewFind,
			callback: () => void this.openDashboard('find'),
		});
		this.addCommand({
			id: COMMAND_IDS.searchNotes,
			name: STRINGS.commands.searchNotes,
			callback: () => this.withModule('retrieval', () => void this.openDashboard('find')),
		});
		this.addCommand({
			id: COMMAND_IDS.toggleStatusBar,
			name: STRINGS.commands.toggleStatusBar,
			callback: () => void this.toggleStatusBar(),
		});
		this.addCommand({
			id: COMMAND_IDS.restoreLastBackup,
			name: STRINGS.commands.restoreLastBackup,
			callback: () => void this.restoreLastBackup(),
		});
	}

	/** Run an action only when its module is enabled, explaining why when it is not. */
	private withModule(module: 'capture' | 'health' | 'retrieval', action: () => void): void {
		const modules = this.settingsStore.get().general.modules;
		if (!modules[module]) {
			const name =
				module === 'capture'
					? STRINGS.settings.moduleCapture
					: module === 'health'
						? STRINGS.settings.moduleHealth
						: STRINGS.settings.moduleRetrieval;
			new Notice(STRINGS.dashboard.moduleDisabled(name));
			return;
		}
		action();
	}

	/* ---------------------------------------------------------------- actions -- */

	/** Reveal the dashboard, reusing an open leaf when there is one. */
	async openDashboard(tab?: DashboardTab): Promise<void> {
		const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_DASHBOARD);
		let leaf: WorkspaceLeaf | null = existing[0] ?? null;

		if (!leaf) {
			leaf = this.app.workspace.getRightLeaf(false);
			if (!leaf) leaf = this.app.workspace.getLeaf(true);
			await leaf.setViewState({ type: VIEW_TYPE_DASHBOARD, active: true });
		}
		await this.app.workspace.revealLeaf(leaf);

		const view = leaf.view;
		if (view instanceof DashboardView && tab) await view.showTab(tab);
		void this.analytics.track('dashboard-opened');
	}

	/** Open the Quick Capture modal. */
	openQuickCapture(): void {
		new QuickCaptureModal({
			app: this.app,
			capture: this.capture,
			index: this.index,
			tags: this.tags,
			getSettings: () => this.settingsStore.get(),
			logger: this.logger.child('capture-modal'),
			onCaptured: () => {
				this.bus.emit('inbox-changed', { count: this.inbox.count() });
				void this.analytics.track('capture-created');
			},
		}).open();
	}

	/** Start a triage session over the current inbox. */
	async startTriage(): Promise<void> {
		void this.analytics.track('triage-session');
		await this.triage.start();
	}

	private async toggleStatusBar(): Promise<void> {
		await this.settingsStore.update((settings) => {
			settings.general.showStatusBar = !settings.general.showStatusBar;
		});
		this.statusBar.update();
		new Notice(
			this.settingsStore.get().general.showStatusBar
				? STRINGS.statusBar.shown
				: STRINGS.statusBar.hidden,
		);
	}

	/** Restore the most recent fix backup (addendum E-07). */
	private async restoreLastBackup(): Promise<void> {
		const backups = this.backup.list();
		const latest = backups[0];
		if (!latest) {
			new Notice(STRINGS.backup.none);
			return;
		}

		const { confirm } = await import('./ui/components/confirm-dialog');
		const answer = await confirm(this.app, {
			title: STRINGS.backup.restoreConfirmTitle,
			body: STRINGS.backup.restoreConfirmBody(
				new Date(latest.createdAt).toLocaleString(),
				latest.files.length,
			),
			confirmLabel: STRINGS.commands.restoreLastBackup,
		});
		if (answer !== 'confirm') return;

		try {
			const result = await this.backup.restoreLatest();
			new Notice(STRINGS.backup.restored(result.restored.length));
			await this.actionLog.log({
				action: STRINGS.commands.restoreLastBackup,
				details: `Restored from ${latest.dir}`,
				files: result.restored,
				result: result.failed.length === 0 ? 'success' : 'partial',
			});
			this.index.refreshAllLinkSources();
			await this.health.runFullScan();
		} catch (error) {
			this.logger.error('Restore failed', error);
			new Notice(`${STRINGS.backup.restoreFailed}: ${errorMessage(error)}`);
		}
	}

	private openPluginSettings(): void {
		// `setting` is not part of the public API surface, so every hop is guarded and a
		// failure simply leaves the user to open settings themselves.
		try {
			const settingApi = (
				this.app as unknown as {
					setting?: { open?: () => void; openTabById?: (id: string) => void };
				}
			).setting;
			settingApi?.open?.();
			settingApi?.openTabById?.(this.manifest.id);
		} catch (error) {
			this.logger.warn('Could not open the settings tab programmatically', error);
		}
	}

	/* ------------------------------------------------------------ vault events -- */

	private registerVaultEvents(): void {
		// File events arrive in bursts during sync or a bulk rename; coalesce them into one
		// index refresh plus one UI notification.
		const pending = new Set<string>();
		const flush = debounce(() => {
			const changed = Array.from(pending);
			pending.clear();
			if (changed.length === 0) return;
			this.bus.emit('index-updated', { changed });
			this.bus.emit('inbox-changed', { count: this.inbox.count() });
			this.statusBar.requestUpdate();
		}, TIMING.incrementalScanDebounce);
		this.register(() => flush.cancel());

		const queueScan = (path: string): void => {
			if (!this.settingsStore.get().general.modules.health) return;
			if (!isMarkdownPath(path)) return;
			this.health.queueIncremental(path);
		};

		this.registerEvent(
			this.app.vault.on('create', (file: TAbstractFile) => {
				if (!this.index.isBuilt) return;
				if (file instanceof TFile) {
					this.index.updateFile(file);
					this.contentIndex.invalidate(file.path);
					pending.add(file.path);
					flush();
					queueScan(file.path);
				}
			}),
		);

		this.registerEvent(
			this.app.vault.on('modify', (file: TAbstractFile) => {
				if (!this.index.isBuilt) return;
				if (file instanceof TFile) {
					this.index.updateFile(file);
					this.contentIndex.invalidate(file.path);
					pending.add(file.path);
					flush();
					queueScan(file.path);
				}
			}),
		);

		this.registerEvent(
			this.app.vault.on('delete', (file: TAbstractFile) => {
				if (!this.index.isBuilt) return;
				this.index.removeFile(file.path);
				this.contentIndex.invalidate(file.path);
				pending.add(file.path);
				flush();
				queueScan(file.path);
			}),
		);

		this.registerEvent(
			this.app.vault.on('rename', (file: TAbstractFile, oldPath: string) => {
				if (!this.index.isBuilt) return;
				if (file instanceof TFile) {
					this.index.renameFile(file, oldPath);
					this.contentIndex.invalidate(oldPath);
					this.contentIndex.invalidate(file.path);
					pending.add(file.path);
					pending.add(oldPath);
					flush();
					queueScan(file.path);
				}
			}),
		);

		// Obsidian resolves links asynchronously after a change; once it settles, the
		// backlink tables need re-deriving or orphan counts drift.
		this.registerEvent(
			this.app.metadataCache.on('resolved', () => {
				if (!this.index.isBuilt) return;
				this.index.refreshAllLinkSources();
			}),
		);
	}
}
