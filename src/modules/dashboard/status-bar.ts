/**
 * Status bar item: `📥 {inbox} | 🏥 {health}` (main spec 8.2).
 *
 * Updates are debounced because a bulk edit or a sync can fire hundreds of vault events in
 * a second, and the status bar is the one piece of UI that is always mounted.
 */

import { Platform } from 'obsidian';
import { STRINGS } from '../../core/strings';
import { TIMING } from '../../core/constants';
import { debounce, type DebouncedFunction } from '../../utils/debounce';

export interface StatusBarDeps {
	/** Creates the element; supplied by the plugin so it is registered for cleanup. */
	createEl: () => HTMLElement;
	getInboxCount: () => number;
	getHealthScore: () => number;
	onClick: () => void;
	isVisible: () => boolean;
}

export class StatusBarItem {
	private el: HTMLElement | null = null;
	private readonly scheduleUpdate: DebouncedFunction<[]>;

	constructor(private readonly deps: StatusBarDeps) {
		this.scheduleUpdate = debounce(() => this.update(), TIMING.statusBarDebounce);
	}

	/**
	 * Create the item, unless the platform has no status bar.
	 *
	 * Obsidian mobile does not render status bar items at all, so we skip creating one
	 * rather than leaving an invisible element listening for clicks.
	 */
	mount(): void {
		if (Platform.isMobile) return;
		if (this.el) return;
		this.el = this.deps.createEl();
		this.el.addClass('jva-status-bar');
		this.el.addClass('mod-clickable');
		this.el.setAttr('aria-label', STRINGS.statusBar.tooltip);
		this.el.setAttr('role', 'button');
		this.el.setAttr('tabindex', '0');
		this.el.addEventListener('click', () => this.deps.onClick());
		this.el.addEventListener('keydown', (event) => {
			if (event.key === 'Enter' || event.key === ' ') {
				event.preventDefault();
				this.deps.onClick();
			}
		});
		this.update();
	}

	/** Queue a refresh, collapsing bursts of vault events. */
	requestUpdate(): void {
		this.scheduleUpdate();
	}

	/** Refresh immediately. */
	update(): void {
		if (!this.el) return;
		const visible = this.deps.isVisible();
		this.el.toggle(visible);
		if (!visible) return;

		const inbox = this.deps.getInboxCount();
		const health = Math.round(this.deps.getHealthScore());
		this.el.setText(STRINGS.statusBar.text(inbox, health));
		this.el.setAttr(
			'aria-label',
			`${STRINGS.statusBar.tooltip} — ${STRINGS.dashboard.statsInbox(inbox)}, ${STRINGS.dashboard.statsHealth(health)}`,
		);
	}

	/** Whether an element exists (false on mobile). */
	get isMounted(): boolean {
		return this.el !== null;
	}

	/** Cancel pending updates. The element itself is removed by Obsidian on unload. */
	dispose(): void {
		this.scheduleUpdate.cancel();
		this.el = null;
	}
}
