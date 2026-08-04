/**
 * Tab strip and lazy panel lifecycle for the dashboard.
 *
 * Panels are only mounted the first time their tab is opened (main spec 8.1), so opening the
 * dashboard costs one panel render rather than three, and a vault-wide scan is never
 * triggered by a tab the user did not look at.
 */

import { setIcon } from 'obsidian';
import type { DashboardTab } from '../../types/events';

/** One tab's content. Implemented by the inbox, health, and find panels. */
export interface TabPanel {
	readonly tab: DashboardTab;
	/** Build the panel's DOM. Called once, the first time the tab is shown. */
	mount(container: HTMLElement): void | Promise<void>;
	/** Re-render from current state. Called when the tab is shown again or data changes. */
	refresh(): void | Promise<void>;
	/** Release listeners and timers. Called when the view closes. */
	unmount(): void;
}

export interface TabDefinition {
	readonly id: DashboardTab;
	readonly label: string;
	readonly icon: string;
	/** Live count badge, e.g. inbox items or open issues. */
	readonly count?: () => number | null;
}

export class TabManager {
	private readonly buttons = new Map<DashboardTab, HTMLElement>();
	private readonly panels = new Map<DashboardTab, HTMLElement>();
	private readonly mounted = new Set<DashboardTab>();
	private active: DashboardTab;

	constructor(
		private readonly tabStripEl: HTMLElement,
		private readonly bodyEl: HTMLElement,
		private readonly definitions: readonly TabDefinition[],
		private readonly getPanel: (tab: DashboardTab) => TabPanel | null,
		initial: DashboardTab,
		private readonly onTabChange?: (tab: DashboardTab) => void,
	) {
		this.active = initial;
		this.render();
	}

	/** Which tab is showing. */
	get activeTab(): DashboardTab {
		return this.active;
	}

	private render(): void {
		this.tabStripEl.empty();
		this.bodyEl.empty();
		this.buttons.clear();
		this.panels.clear();

		for (const definition of this.definitions) {
			const button = this.tabStripEl.createEl('button', { cls: 'jva-tab' });
			button.setAttr('role', 'tab');
			button.setAttr('id', `jva-tab-${definition.id}`);
			button.setAttr('aria-controls', `jva-panel-${definition.id}`);

			const iconEl = button.createSpan({ cls: 'jva-tab__icon' });
			setIcon(iconEl, definition.icon);
			button.createSpan({ cls: 'jva-tab__label', text: definition.label });

			button.addEventListener('click', () => void this.select(definition.id));
			button.addEventListener('keydown', (event) => this.onTabKeyDown(event, definition.id));

			this.buttons.set(definition.id, button);

			const panel = this.bodyEl.createDiv({ cls: 'jva-tab-panel' });
			panel.setAttr('role', 'tabpanel');
			panel.setAttr('id', `jva-panel-${definition.id}`);
			panel.setAttr('aria-labelledby', `jva-tab-${definition.id}`);
			this.panels.set(definition.id, panel);
		}

		this.tabStripEl.setAttr('role', 'tablist');
		void this.select(this.active, true);
	}

	/** Left/right arrows move between tabs, as expected of a tablist. */
	private onTabKeyDown(event: KeyboardEvent, current: DashboardTab): void {
		if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
		event.preventDefault();
		const order = this.definitions.map((definition) => definition.id);
		const index = order.indexOf(current);
		const delta = event.key === 'ArrowRight' ? 1 : -1;
		const next = order[(index + delta + order.length) % order.length];
		if (next) {
			void this.select(next);
			this.buttons.get(next)?.focus();
		}
	}

	/** Show a tab, mounting its panel the first time. */
	async select(tab: DashboardTab, force = false): Promise<void> {
		if (!force && this.active === tab) {
			// Re-selecting the current tab still refreshes it, which is what the
			// "View inbox" style commands should do when the dashboard is already open.
			await this.getPanel(tab)?.refresh();
			return;
		}
		this.active = tab;

		for (const [id, button] of this.buttons) {
			const isActive = id === tab;
			button.toggleClass('is-active', isActive);
			button.setAttr('aria-selected', String(isActive));
			button.setAttr('tabindex', isActive ? '0' : '-1');
		}
		for (const [id, panel] of this.panels) {
			panel.toggleClass('is-active', id === tab);
		}

		const container = this.panels.get(tab);
		const panel = this.getPanel(tab);
		if (container && panel) {
			if (!this.mounted.has(tab)) {
				this.mounted.add(tab);
				await panel.mount(container);
			} else {
				await panel.refresh();
			}
		}

		this.onTabChange?.(tab);
	}

	/** Refresh the visible panel, if it has been mounted. */
	async refreshActive(): Promise<void> {
		if (!this.mounted.has(this.active)) return;
		await this.getPanel(this.active)?.refresh();
	}

	/** Update the count badge on every tab. */
	updateCounts(): void {
		for (const definition of this.definitions) {
			const button = this.buttons.get(definition.id);
			if (!button) continue;
			button.querySelector('.jva-tab__count')?.remove();
			const count = definition.count?.() ?? null;
			if (count !== null && count > 0) {
				button.createSpan({ cls: 'jva-tab__count', text: String(count) });
			}
		}
	}

	/** Unmount every mounted panel. */
	dispose(): void {
		for (const tab of this.mounted) this.getPanel(tab)?.unmount();
		this.mounted.clear();
	}
}
