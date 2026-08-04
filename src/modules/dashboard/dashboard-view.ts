/**
 * The unified dashboard: one view, three tabs (main spec 8.1).
 *
 * The view owns nothing but layout and lifecycle. Each tab's content is a {@link TabPanel}
 * that the tab manager mounts lazily, so opening the dashboard never costs a health scan or
 * a vault-wide read for tabs the user did not look at.
 */

import { ItemView, setIcon, type WorkspaceLeaf } from 'obsidian';
import type { DashboardTab } from '../../types/events';
import { ICONS, LOCAL_STATE_KEYS, VIEW_TYPE_DASHBOARD } from '../../core/constants';
import { STRINGS } from '../../core/strings';
import type { EventBus } from '../../core/event-bus';
import type { LocalStateStore } from '../../core/local-state';
import type { Logger } from '../../core/logger';
import type { SettingsStore } from '../../core/settings';
import { createButton } from '../../ui/components/button';
import { renderEmptyState } from '../../ui/components/empty-state';
import { TabManager, type TabDefinition, type TabPanel } from './tab-manager';

export interface DashboardDeps {
	settings: SettingsStore;
	bus: EventBus;
	localState: LocalStateStore;
	logger: Logger;
	/** Built lazily so a disabled module never constructs its services. */
	createInboxPanel: () => TabPanel | null;
	createHealthPanel: () => TabPanel | null;
	createRecallPanel: () => TabPanel | null;
	getInboxCount: () => number;
	getHealthScore: () => number;
	openSettings: () => void;
}

export class DashboardView extends ItemView {
	private tabs: TabManager | null = null;
	private headerStatsEl: HTMLElement | null = null;
	private readonly panels = new Map<DashboardTab, TabPanel | null>();
	private unsubscribers: (() => void)[] = [];

	constructor(
		leaf: WorkspaceLeaf,
		private readonly deps: DashboardDeps,
	) {
		super(leaf);
	}

	getViewType(): string {
		return VIEW_TYPE_DASHBOARD;
	}

	override getDisplayText(): string {
		return STRINGS.dashboard.title;
	}

	override getIcon(): string {
		return ICONS.plugin;
	}

	override async onOpen(): Promise<void> {
		const container = this.containerEl.children[1] as HTMLElement | undefined;
		if (!container) return;

		container.empty();
		container.addClass('jva-view');
		container.addClass('jva-dashboard');

		this.renderHeader(container);

		const tabStrip = container.createDiv({ cls: 'jva-dashboard__tabs' });
		const body = container.createDiv({ cls: 'jva-dashboard__body' });

		const settings = this.deps.settings.get();
		const definitions: TabDefinition[] = [
			{
				id: 'inbox',
				label: STRINGS.dashboard.tabInbox,
				icon: ICONS.inbox,
				count: () => (settings.general.modules.capture ? this.deps.getInboxCount() : null),
			},
			{ id: 'health', label: STRINGS.dashboard.tabHealth, icon: ICONS.health },
			{ id: 'find', label: STRINGS.dashboard.tabFind, icon: ICONS.find },
		];

		const remembered = this.deps.localState.get<DashboardTab>(
			LOCAL_STATE_KEYS.lastTab,
			'inbox',
		);
		const initial: DashboardTab = definitions.some((d) => d.id === remembered)
			? remembered
			: 'inbox';

		this.tabs = new TabManager(
			tabStrip,
			body,
			definitions,
			(tab) => this.panelFor(tab),
			initial,
			(tab) => {
				this.deps.localState.set(LOCAL_STATE_KEYS.lastTab, tab);
				this.deps.bus.emit('tab-changed', { tab });
			},
		);
		this.tabs.updateCounts();

		// Header stats and tab badges follow the same events the status bar listens to.
		const refreshChrome = (): void => {
			this.updateHeaderStats();
			this.tabs?.updateCounts();
		};
		this.unsubscribers.push(
			this.deps.bus.on('inbox-changed', refreshChrome),
			this.deps.bus.on('scan-completed', refreshChrome),
			this.deps.bus.on('index-updated', refreshChrome),
			this.deps.bus.on('settings-changed', () => {
				// A module toggle can add or remove a tab's content entirely.
				this.panels.clear();
				refreshChrome();
				void this.tabs?.refreshActive();
			}),
		);
	}

	override async onClose(): Promise<void> {
		for (const unsubscribe of this.unsubscribers) unsubscribe();
		this.unsubscribers = [];
		this.tabs?.dispose();
		this.tabs = null;
		this.panels.clear();
		this.containerEl.children[1]?.empty();
	}

	/** Switch to a tab from a command. */
	async showTab(tab: DashboardTab): Promise<void> {
		await this.tabs?.select(tab);
	}

	/** Re-render whichever tab is visible. */
	async refresh(): Promise<void> {
		this.updateHeaderStats();
		this.tabs?.updateCounts();
		await this.tabs?.refreshActive();
	}

	private renderHeader(container: HTMLElement): void {
		const header = container.createDiv({ cls: 'jva-dashboard__header' });

		const iconEl = header.createSpan({ cls: 'jva-dashboard__icon' });
		setIcon(iconEl, ICONS.plugin);
		header.createEl('h2', { cls: 'jva-dashboard__title', text: STRINGS.dashboard.title });

		this.headerStatsEl = header.createDiv({ cls: 'jva-dashboard__stats' });
		this.updateHeaderStats();

		header.createDiv({ cls: 'jva-spacer' });
		createButton(header, {
			icon: ICONS.settings,
			tooltip: STRINGS.health.settings,
			onClick: () => this.deps.openSettings(),
		});
	}

	private updateHeaderStats(): void {
		const stats = this.headerStatsEl;
		if (!stats) return;
		stats.empty();

		const settings = this.deps.settings.get();
		if (settings.general.modules.capture) {
			stats
				.createSpan({ cls: 'jva-dashboard__stat' })
				.setText(STRINGS.dashboard.statsInbox(this.deps.getInboxCount()));
		}
		if (settings.general.modules.capture && settings.general.modules.health) {
			stats.createSpan({ cls: 'jva-dashboard__stat-sep', text: '|' });
		}
		if (settings.general.modules.health) {
			stats
				.createSpan({ cls: 'jva-dashboard__stat' })
				.setText(STRINGS.dashboard.statsHealth(Math.round(this.deps.getHealthScore())));
		}
	}

	/**
	 * Build a panel on first use.
	 *
	 * A disabled module returns a placeholder panel explaining how to turn it back on,
	 * rather than an empty tab that looks broken.
	 */
	private panelFor(tab: DashboardTab): TabPanel | null {
		const existing = this.panels.get(tab);
		if (existing !== undefined) return existing;

		const settings = this.deps.settings.get();
		const enabled =
			tab === 'inbox'
				? settings.general.modules.capture
				: tab === 'health'
					? settings.general.modules.health
					: settings.general.modules.retrieval;

		const moduleName =
			tab === 'inbox'
				? STRINGS.settings.moduleCapture
				: tab === 'health'
					? STRINGS.settings.moduleHealth
					: STRINGS.settings.moduleRetrieval;

		let panel: TabPanel | null = null;
		if (!enabled) {
			panel = this.disabledPanel(tab, moduleName);
		} else {
			try {
				panel =
					tab === 'inbox'
						? this.deps.createInboxPanel()
						: tab === 'health'
							? this.deps.createHealthPanel()
							: this.deps.createRecallPanel();
			} catch (error) {
				this.deps.logger.error(`Could not build the "${tab}" panel`, error);
				panel = null;
			}
		}

		this.panels.set(tab, panel);
		return panel;
	}

	/** A stand-in panel shown when a module is switched off. */
	private disabledPanel(tab: DashboardTab, moduleName: string): TabPanel {
		const openSettings = (): void => this.deps.openSettings();
		return {
			tab,
			mount(container: HTMLElement): void {
				container.empty();
				renderEmptyState(container, {
					icon: ICONS.settings,
					title: STRINGS.dashboard.moduleDisabled(moduleName),
					actionLabel: STRINGS.dashboard.enableInSettings,
					onAction: openSettings,
				});
			},
			refresh(): void {
				/* nothing changes while the module is off */
			},
			unmount(): void {
				/* nothing to clean up */
			},
		};
	}
}
