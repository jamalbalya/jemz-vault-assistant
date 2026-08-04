/**
 * The Inbox tab (main spec 5.2).
 *
 * The panel owns no vault logic at all: {@link InboxService} decides what is in the inbox and
 * {@link InboxActions} owns every interaction, so this file is only ever answering "what does
 * the user see, and what did they just press".
 *
 * Two deliberate choices shape it:
 *  - the toolbar is built once and only its text is updated, so a refresh triggered by a
 *    vault event never destroys the button the user is mid-click on;
 *  - previews are read asynchronously and applied under a render token, so the burst of
 *    `index-updated` events a sync produces cannot paint a stale page over a fresh one.
 */

import { Notice, Platform, type App, type TFile } from 'obsidian';
import type { DashboardTab } from '../../types/events';
import type { NoteRecord } from '../../types/note';
import { ICONS, INBOX_PREVIEW_LENGTH, TYPE_ICONS } from '../../core/constants';
import { STRINGS } from '../../core/strings';
import type { EventBus } from '../../core/event-bus';
import type { Logger } from '../../core/logger';
import type { SettingsStore } from '../../core/settings';
import { formatDate } from '../../utils/date';
import { extractDomain, previewText } from '../../utils/string';
import { createButton, setButtonDisabled, type ButtonOptions } from '../../ui/components/button';
import { renderEmptyState, renderErrorState, renderLoading } from '../../ui/components/empty-state';
import { renderListItem, renderPagination } from '../../ui/components/list-item';
import type { ContentIndex } from '../../services/content-index';
import type { InboxService } from '../../services/inbox-service';
import type { TabPanel } from '../dashboard/tab-manager';
import type { InboxActionResult, InboxActions } from './inbox-actions';

export interface InboxPanelDeps {
	app: App;
	inbox: InboxService;
	actions: InboxActions;
	content: ContentIndex;
	settings: SettingsStore;
	bus: EventBus;
	logger: Logger;
	/** Hands control to triage mode, which the dashboard owns. */
	onStartTriage: () => void;
	/** Opens the quick capture modal, offered from the empty state. */
	onCapture: () => void;
}

export class InboxPanel implements TabPanel {
	readonly tab: DashboardTab = 'inbox';

	private containerEl: HTMLElement | null = null;
	private toolbarEl: HTMLElement | null = null;
	private bodyEl: HTMLElement | null = null;
	private countEl: HTMLElement | null = null;
	private sortButtonEl: HTMLButtonElement | null = null;
	private triageButtonEl: HTMLButtonElement | null = null;

	/** 1-based, and clamped by the service on every read so it survives a shrinking list. */
	private page = 1;
	/**
	 * Bumped on every render and on unmount. An async render that finds the token changed
	 * underneath it throws its result away instead of painting over a newer one.
	 */
	private renderToken = 0;
	/** One action at a time: a second click while a picker is open would act on stale state. */
	private busy = false;

	/**
	 * Teardown callbacks.
	 *
	 * A `TabPanel` is not an Obsidian `Component` — the dashboard view is, and it calls
	 * {@link unmount} from its own `onClose`. Everything registered here therefore has to be
	 * released by hand, which is exactly what `unmount` does.
	 */
	private readonly disposers: (() => void)[] = [];

	constructor(private readonly deps: InboxPanelDeps) {}

	/* ---------------------------------------------------------- lifecycle -- */

	/**
	 * Build the panel chrome and paint the first page.
	 *
	 * Called once by the tab manager, the first time the Inbox tab is opened, so nothing here
	 * runs for a user who never leaves the Health tab.
	 */
	async mount(container: HTMLElement): Promise<void> {
		this.containerEl = container;
		container.empty();

		const root = container.createDiv({ cls: 'jva-view jva-inbox' });
		this.toolbarEl = root.createDiv({ cls: 'jva-inbox__toolbar' });
		this.bodyEl = root.createDiv({ cls: 'jva-scroll' });

		this.buildToolbar(this.toolbarEl);
		this.subscribe();
		await this.refresh();
	}

	/**
	 * Repaint from current state, keeping the page the user was on.
	 *
	 * The page is only clamped, never reset: processing the last item on page 3 should land
	 * on page 2, not throw the user back to the top of the list.
	 */
	async refresh(): Promise<void> {
		const body = this.bodyEl;
		if (!body) return;

		const token = ++this.renderToken;
		try {
			const pageSize = this.deps.settings.get().general.inboxPageSize;
			const page = this.deps.inbox.page(this.page, pageSize);
			this.page = page.page;
			this.updateToolbar(page.total);

			body.empty();
			if (page.total === 0) {
				this.renderEmpty(body);
				return;
			}

			// Reading ten note bodies is fast but not free, and on a cold cache it is disk I/O.
			renderLoading(body, STRINGS.common.loading);
			const previews = await this.loadPreviews(page.items);
			if (token !== this.renderToken || this.bodyEl !== body) return;

			body.empty();
			const list = body.createDiv({ cls: 'jva-list' });
			for (const record of page.items) {
				this.renderItem(list, record, previews.get(record.path) ?? '');
			}
			renderPagination(body, {
				page: page.page,
				pageCount: page.pageCount,
				label: STRINGS.inbox.page(page.page, page.pageCount),
				onChange: (next) => {
					this.page = next;
					void this.refresh();
				},
			});
		} catch (error) {
			this.deps.logger.error('Could not render the inbox', error);
			if (token !== this.renderToken || this.bodyEl !== body) return;
			body.empty();
			renderErrorState(body, {
				title: STRINGS.errors.unexpected,
				retryLabel: STRINGS.common.retry,
				onRetry: () => void this.refresh(),
			});
		}
	}

	/** Drop every subscription and every element. Nothing may survive this call. */
	unmount(): void {
		// Invalidate any render still waiting on a preview read.
		this.renderToken++;

		for (const dispose of this.disposers) {
			try {
				dispose();
			} catch (error) {
				this.deps.logger.warn('An inbox subscription failed to unsubscribe', error);
			}
		}
		this.disposers.length = 0;

		this.containerEl?.empty();
		this.containerEl = null;
		this.toolbarEl = null;
		this.bodyEl = null;
		this.countEl = null;
		this.sortButtonEl = null;
		this.triageButtonEl = null;
	}

	/* ------------------------------------------------------------ toolbar -- */

	/**
	 * Subscribe to the two events that change what the inbox contains.
	 *
	 * `index-updated` covers edits made anywhere else in Obsidian, `inbox-changed` covers the
	 * plugin's own writes. Both unsubscribe functions go straight into {@link disposers}.
	 */
	private subscribe(): void {
		this.disposers.push(
			this.deps.bus.on('index-updated', () => void this.refresh()),
			this.deps.bus.on('inbox-changed', () => void this.refresh()),
		);
	}

	private buildToolbar(toolbar: HTMLElement): void {
		this.countEl = toolbar.createSpan({ cls: 'jva-inbox__count' });
		toolbar.createDiv({ cls: 'jva-spacer' });

		this.sortButtonEl = createButton(toolbar, {
			label: this.sortLabel(),
			icon: ICONS.calendar,
			onClick: () => void this.toggleSort(),
		});

		this.triageButtonEl = createButton(toolbar, {
			label: STRINGS.inbox.startTriage,
			icon: ICONS.inbox,
			cta: true,
			onClick: () => this.deps.onStartTriage(),
		});
	}

	/** Refresh the parts of the toolbar that depend on the list, leaving the buttons in place. */
	private updateToolbar(total: number): void {
		this.countEl?.setText(STRINGS.inbox.itemCount(total));

		const sortLabel = this.sortButtonEl?.querySelector('.jva-button__label');
		sortLabel?.setText(this.sortLabel());

		// Triage over an empty inbox has nothing to show, so the button says so by being off.
		if (this.triageButtonEl) setButtonDisabled(this.triageButtonEl, total === 0);
	}

	/** The button reports how the list is sorted right now; pressing it flips the order. */
	private sortLabel(): string {
		return this.deps.settings.get().general.inboxNewestFirst
			? STRINGS.inbox.sortNewest
			: STRINGS.inbox.sortOldest;
	}

	/**
	 * Flip the sort order and persist it.
	 *
	 * The settings object is mutated synchronously, so the repaint below always reflects the
	 * new order even when the write itself is still in flight or fails outright.
	 */
	private async toggleSort(): Promise<void> {
		const next = !this.deps.settings.get().general.inboxNewestFirst;
		try {
			await this.deps.settings.update((settings) => {
				settings.general.inboxNewestFirst = next;
			});
		} catch (error) {
			this.deps.logger.error('Could not save the inbox sort order', error);
			new Notice(STRINGS.errors.unexpected);
		}
		await this.refresh();
	}

	/* --------------------------------------------------------------- list -- */

	private renderEmpty(body: HTMLElement): void {
		renderEmptyState(body, {
			icon: ICONS.inbox,
			title: STRINGS.inbox.emptyTitle,
			body: STRINGS.inbox.emptyBody,
			actionLabel: STRINGS.inbox.emptyAction,
			actionIcon: ICONS.capture,
			onAction: () => this.deps.onCapture(),
		});
	}

	private renderItem(list: HTMLElement, record: NoteRecord, preview: string): void {
		const meta: string[] = [];
		const created = formatDate(record.created);
		if (created.length > 0) meta.push(created);

		const domain = record.source === null ? '' : extractDomain(record.source);
		const sourceIndex = domain.length > 0 ? meta.push(domain) - 1 : -1;

		const row = renderListItem(list, {
			cls: 'jva-inbox__item',
			title: record.basename,
			icon: this.typeIcon(record),
			meta,
			preview,
			actions: this.itemActions(record),
			onActivate: () => this.run(record, (file) => this.deps.actions.open(file)),
		});

		// The source domain is the one meta entry with its own colour, and `renderListItem`
		// has no per-entry class hook, so it is tagged after the fact.
		if (sourceIndex >= 0) {
			const entries = row.querySelectorAll<HTMLElement>('.jva-list-item__meta-item');
			entries[sourceIndex]?.addClass('jva-inbox__source');
		}
	}

	/** A note's type icon, falling back to the unknown-file glyph for a custom type. */
	private typeIcon(record: NoteRecord): string {
		const type = record.type?.toLowerCase() ?? '';
		return TYPE_ICONS[type] ?? ICONS.unknownFile;
	}

	/** The eight actions, in the order the wireframe specifies (addendum appendix B). */
	private itemActions(record: NoteRecord): ButtonOptions[] {
		const { actions } = this.deps;
		return [
			this.actionButton(record, STRINGS.inbox.actions.open, ICONS.open, (file) =>
				actions.open(file),
			),
			this.actionButton(record, STRINGS.inbox.actions.process, ICONS.success, (file) =>
				actions.process(file),
			),
			this.actionButton(
				record,
				STRINGS.inbox.actions.convertToTask,
				TYPE_ICONS.task ?? ICONS.success,
				(file) => actions.convertToTask(file),
			),
			this.actionButton(record, STRINGS.inbox.actions.move, ICONS.move, (file) =>
				actions.moveToFolder(file),
			),
			this.actionButton(record, STRINGS.inbox.actions.addTag, ICONS.tag, (file) =>
				actions.addTag(file),
			),
			this.actionButton(record, STRINGS.inbox.actions.link, ICONS.link, (file) =>
				actions.linkToNote(file),
			),
			this.actionButton(record, STRINGS.inbox.actions.archive, ICONS.archive, (file) =>
				actions.archive(file),
			),
			{
				...this.actionButton(record, STRINGS.inbox.actions.delete, ICONS.trash, (file) =>
					actions.remove(file),
				),
				warning: true,
			},
		];
	}

	/**
	 * One action button.
	 *
	 * Labels are dropped on mobile: eight labelled buttons per row would push the list off a
	 * phone screen, and the stylesheet already gives an icon-only button a 44x44 target. The
	 * tooltip carries the name either way, so the accessible name never disappears.
	 */
	private actionButton(
		record: NoteRecord,
		label: string,
		icon: string,
		action: (file: TFile) => Promise<InboxActionResult>,
	): ButtonOptions {
		return {
			...(Platform.isMobile ? {} : { label }),
			icon,
			tooltip: label,
			onClick: () => this.run(record, action),
		};
	}

	/**
	 * Resolve the record to a live file and run an action against it.
	 *
	 * The list is painted from the index, which can lag a file deleted in another window, so
	 * the file is looked up at press time rather than captured when the row was built.
	 * The repaint runs whether the action succeeded or not: a half-applied archive (status
	 * written, move refused) still changed the note.
	 */
	private run(record: NoteRecord, action: (file: TFile) => Promise<InboxActionResult>): void {
		if (this.busy) return;

		const file = this.deps.app.vault.getFileByPath(record.path);
		if (!file) {
			new Notice(STRINGS.errors.fileNotFound(record.path));
			void this.refresh();
			return;
		}

		this.busy = true;
		void (async () => {
			try {
				await action(file);
			} catch (error) {
				// InboxActions reports its own failures; reaching here means something above
				// it broke, and the user still deserves to be told.
				this.deps.logger.error(`Inbox action failed for "${record.path}"`, error);
				new Notice(STRINGS.inbox.actionFailed);
			} finally {
				this.busy = false;
				await this.refresh();
			}
		})();
	}

	/**
	 * Read the preview line for every item on the page.
	 *
	 * A note that cannot be read still has to be triageable, so a failed read yields an empty
	 * preview rather than failing the whole render.
	 */
	private async loadPreviews(items: readonly NoteRecord[]): Promise<Map<string, string>> {
		const previews = new Map<string, string>();
		await Promise.all(
			items.map(async (record) => {
				try {
					const body = await this.deps.content.body(record.path);
					previews.set(record.path, previewText(body, INBOX_PREVIEW_LENGTH));
				} catch (error) {
					this.deps.logger.warn(`Could not preview "${record.path}"`, error);
					previews.set(record.path, '');
				}
			}),
		);
		return previews;
	}
}
