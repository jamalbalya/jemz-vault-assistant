/**
 * The Find tab (main spec 7.1-7.4).
 *
 * Layout is a saved-view sidebar plus a search panel, and every query goes through
 * {@link RetrievalService}. The panel deliberately owns no reading of file contents: the
 * service keeps a warm content cache, so a keystroke costs an index scan and nothing more,
 * which is what keeps the 500 ms budget in 7.3 reachable on a large vault.
 *
 * The contextual panels (7.4) only appear when the search box is empty. They answer "what
 * should I look at" rather than "where is X", so showing them beside active search results
 * would just be noise competing with the answer the user asked for.
 */

import { Menu, Notice, Platform, setIcon, type App, type TFile } from 'obsidian';
import { ICONS, TIMING, TYPE_ICONS } from '../../core/constants';
import type { EventBus } from '../../core/event-bus';
import { errorMessage, type Logger } from '../../core/logger';
import type { SettingsStore } from '../../core/settings';
import { STRINGS } from '../../core/strings';
import type { RetrievalService } from '../../services/retrieval-service';
import type { VaultIndex } from '../../services/vault-index';
import type { DashboardTab } from '../../types/events';
import {
	SORT_FIELDS,
	type Filter,
	type SavedView,
	type SearchResponse,
	type SearchResult,
	type SortDirection,
	type SortField,
	type SortSpec,
	type UnlinkedMention,
} from '../../types/search';
import { createButton, createButtonRow } from '../../ui/components/button';
import { confirm } from '../../ui/components/confirm-dialog';
import {
	renderEmptyState,
	renderErrorState,
	renderInlineEmpty,
	renderLoading,
} from '../../ui/components/empty-state';
import {
	renderListItem,
	renderPagination,
	renderSectionHeading,
} from '../../ui/components/list-item';
import { JemzPromiseModal } from '../../ui/components/modal-base';
import { formatDate } from '../../utils/date';
import { debounce, type DebouncedFunction } from '../../utils/debounce';
import { getBasename } from '../../utils/file';
import type { TabPanel } from '../dashboard/tab-manager';
import { FilterBuilder, type FilterLogic } from './filter-builder';
import { createEmptyView, resolveFilters } from './saved-views';

/** How many stale notes the contextual panel shows before it stops being a nudge. */
const STALE_PANEL_LIMIT = 10;

/** Ids used to remember which contextual panels the user collapsed. */
const PANEL_IDS = {
	onThisDay: 'on-this-day',
	unlinkedMentions: 'unlinked-mentions',
	staleNotes: 'stale-notes',
	similarNotes: 'similar-notes',
} as const;

export interface RecallPanelDeps {
	readonly app: App;
	readonly retrieval: RetrievalService;
	readonly index: VaultIndex;
	readonly settings: SettingsStore;
	readonly bus: EventBus;
	readonly logger: Logger;
}

/** Every element the panel needs after mounting. Null until {@link RecallPanel.mount} runs. */
interface RecallUi {
	readonly root: HTMLElement;
	readonly viewListEl: HTMLElement;
	readonly searchInputEl: HTMLInputElement;
	readonly countEl: HTMLElement;
	readonly sortFieldEl: HTMLSelectElement;
	readonly sortDirectionEl: HTMLSelectElement;
	readonly resultsEl: HTMLElement;
	readonly builder: FilterBuilder;
}

export class RecallPanel implements TabPanel {
	readonly tab: DashboardTab = 'find';

	private containerEl: HTMLElement | null = null;
	private ui: RecallUi | null = null;
	/** Listeners on the panel chrome, which lives as long as the mount. */
	private readonly cleanups: (() => void)[] = [];
	/** Listeners inside the saved-view list, released whenever that list is rebuilt. */
	private readonly viewListCleanups: (() => void)[] = [];
	/** Listeners inside the results area, released whenever those results are rebuilt. */
	private readonly resultsCleanups: (() => void)[] = [];
	private readonly collapsedPanels = new Set<string>();
	private readonly scheduleSearch: DebouncedFunction<[]>;

	private query = '';
	private filters: readonly Filter[] = [];
	private logic: FilterLogic = 'and';
	private sort: SortSpec;
	/** Null means "no saved view" — the plain, unfiltered list of everything. */
	private activeViewId: string | null = null;
	private page = 1;
	/** Incremented per search so a slow query can never overwrite a newer one. */
	private searchToken = 0;
	private inFlight: Promise<void> = Promise.resolve();

	constructor(private readonly deps: RecallPanelDeps) {
		const retrieval = deps.settings.get().retrieval;
		this.sort = {
			field: retrieval.defaultSortField,
			direction: retrieval.defaultSortDirection,
		};
		// 300 ms per main spec 7.3: long enough to skip most intermediate keystrokes, short
		// enough that the list feels like it is tracking the typing.
		this.scheduleSearch = debounce(() => this.search(), TIMING.searchDebounce);
		if (Platform.isMobile) {
			// Vertical space is scarce on a phone, so the contextual panels start folded and
			// the results stay above the fold.
			for (const id of Object.values(PANEL_IDS)) this.collapsedPanels.add(id);
		}
	}

	/* -------------------------------------------------------------- lifecycle -- */

	/** Build the tab's DOM and run the first query. */
	async mount(container: HTMLElement): Promise<void> {
		this.containerEl = container;
		container.empty();
		this.ui = this.buildUi(container);
		this.subscribe();
		this.renderViewList();
		await this.runSearch();
	}

	/** Re-render the sidebar and re-run the current query. */
	async refresh(): Promise<void> {
		if (!this.ui) return;
		this.renderViewList();
		await this.runSearch();
	}

	/** Drop every listener, timer, and element this panel created. */
	unmount(): void {
		// Bump the token first so an in-flight search resolves into a no-op.
		this.searchToken += 1;
		this.scheduleSearch.cancel();
		this.ui?.builder.destroy();
		release(this.viewListCleanups);
		release(this.resultsCleanups);
		for (const cleanup of this.cleanups.splice(0)) cleanup();
		this.ui = null;
		this.containerEl?.empty();
		this.containerEl = null;
	}

	/**
	 * Resolve once any in-flight query has finished rendering.
	 *
	 * The debounce makes searching fire-and-forget, so callers that need to observe the
	 * finished list — the dashboard when it reveals the tab, and the tests — need a join point.
	 */
	async whenSettled(): Promise<void> {
		await this.inFlight;
	}

	/* ------------------------------------------------------------------ shell -- */

	private buildUi(container: HTMLElement): RecallUi {
		const root = container.createDiv({ cls: 'jva-find' });

		const sidebar = root.createDiv({ cls: 'jva-find__sidebar' });
		sidebar.createDiv({ cls: 'jva-find__sidebar-heading', text: STRINGS.find.savedViews });
		const viewListEl = sidebar.createDiv({ cls: 'jva-find__view-list' });
		createButton(sidebar, {
			label: STRINGS.find.newView,
			icon: ICONS.capture,
			onClick: () => void this.openViewEditor(null),
		});

		const main = root.createDiv({ cls: 'jva-find__main' });

		const searchRow = main.createDiv({ cls: 'jva-find__search' });
		const searchIcon = searchRow.createSpan();
		setIcon(searchIcon, ICONS.find);
		const searchInputEl = searchRow.createEl('input', { type: 'search' });
		searchInputEl.setAttr('placeholder', STRINGS.find.searchPlaceholder);
		searchInputEl.setAttr('aria-label', STRINGS.common.search);
		this.registerDomEvent(searchInputEl, 'input', () => {
			this.query = searchInputEl.value;
			this.page = 1;
			this.scheduleSearch();
		});

		const builder = new FilterBuilder(main, {
			initialFilters: this.filters,
			initialLogic: this.logic,
			folderSuggestions: this.deps.index.folders(),
			tagSuggestions: Array.from(this.deps.index.tagCounts().keys()).sort(),
			onChange: (filters, logic) => {
				this.filters = filters;
				this.logic = logic;
				this.page = 1;
				this.scheduleSearch();
			},
		});

		const toolbar = main.createDiv({ cls: 'jva-find__toolbar' });
		const countEl = toolbar.createSpan({ cls: 'jva-find__count' });
		toolbar.createSpan({ cls: 'jva-spacer' });
		const { fieldEl, directionEl } = this.buildSortControls(toolbar);

		const resultsEl = main.createDiv({ cls: 'jva-find__results' });

		return {
			root,
			viewListEl,
			searchInputEl,
			countEl,
			sortFieldEl: fieldEl,
			sortDirectionEl: directionEl,
			resultsEl,
			builder,
		};
	}

	private buildSortControls(toolbar: HTMLElement): {
		fieldEl: HTMLSelectElement;
		directionEl: HTMLSelectElement;
	} {
		const label = toolbar.createEl('label', { text: STRINGS.find.sortLabel });
		const fieldEl = toolbar.createEl('select', { cls: 'dropdown jva-find__sort-field' });
		label.setAttr('for', 'jva-find-sort-field');
		fieldEl.setAttr('id', 'jva-find-sort-field');
		fieldEl.setAttr('aria-label', STRINGS.find.sortLabel);
		for (const field of SORT_FIELDS) {
			fieldEl.createEl('option', { value: field, text: STRINGS.find.sortFields[field] });
		}
		fieldEl.value = this.sort.field;
		this.registerDomEvent(fieldEl, 'change', () => {
			this.sort = { ...this.sort, field: asSortField(fieldEl.value) ?? this.sort.field };
			this.page = 1;
			this.search();
		});

		const directionEl = toolbar.createEl('select', {
			cls: 'dropdown jva-find__sort-direction',
		});
		directionEl.setAttr('aria-label', STRINGS.find.sortLabel);
		// The only ordering copy the string table carries; it reads correctly for every field
		// whose sort is a magnitude, which is four of the five.
		directionEl.createEl('option', { value: 'desc', text: STRINGS.inbox.sortNewest });
		directionEl.createEl('option', { value: 'asc', text: STRINGS.inbox.sortOldest });
		directionEl.value = this.sort.direction;
		this.registerDomEvent(directionEl, 'change', () => {
			this.sort = {
				...this.sort,
				direction: directionEl.value === 'asc' ? 'asc' : 'desc',
			};
			this.page = 1;
			this.search();
		});

		return { fieldEl, directionEl };
	}

	private subscribe(): void {
		// A settings change can add, rename, pin, or delete a view, so the sidebar is rebuilt.
		// It deliberately does not re-run the query: saving a view must not disturb the list
		// the user is currently reading.
		this.register(this.deps.bus.on('settings-changed', () => this.renderViewList()));
		this.register(this.deps.bus.on('index-updated', () => this.scheduleSearch()));
	}

	/* ------------------------------------------------------------ saved views -- */

	private renderViewList(): void {
		const ui = this.ui;
		if (!ui) return;
		// The buttons below are rebuilt from scratch, so the handlers bound to the previous
		// set go with them. `renderViewList` runs on every `settings-changed` — which every
		// scan, ignore and preference edit raises — so leaving them registered grows the
		// cleanup list for as long as the tab is open and pins each detached button in memory.
		release(this.viewListCleanups);
		ui.viewListEl.empty();

		const views = this.deps.retrieval.views();
		if (views.length === 0) {
			renderInlineEmpty(ui.viewListEl, STRINGS.common.noResults);
			return;
		}

		for (const view of views) {
			const button = ui.viewListEl.createEl('button', { cls: 'jva-saved-view' });
			button.setAttr('data-view-id', view.id);
			const active = view.id === this.activeViewId;
			button.toggleClass('is-active', active);
			button.setAttr('aria-pressed', String(active));

			button.createSpan({ cls: 'jva-saved-view__icon', text: view.icon });
			button.createSpan({ cls: 'jva-saved-view__name', text: view.name });
			if (view.pinned) {
				const pin = button.createSpan({ cls: 'jva-saved-view__pin' });
				setIcon(pin, ICONS.pin);
				pin.setAttr('aria-label', STRINGS.common.pin);
			}

			this.registerScoped(this.viewListCleanups, button, 'click', () =>
				this.toggleView(view),
			);
			this.registerScoped(this.viewListCleanups, button, 'contextmenu', (event) => {
				event.preventDefault();
				this.showViewMenu(view, event);
			});
		}
	}

	/**
	 * Select a view, or clear the selection when it is already active.
	 *
	 * Clicking the active view again is the only way back to the unfiltered list, so the
	 * button behaves as a toggle rather than a radio.
	 */
	private toggleView(view: SavedView): void {
		if (this.activeViewId === view.id) {
			this.activeViewId = null;
			this.applyFilterState([], 'and');
		} else {
			this.activeViewId = view.id;
			this.applyFilterState(view.filters, view.logic);
			this.sort = view.sort;
			this.syncSortControls();
		}
		this.page = 1;
		this.renderViewList();
		this.search();
	}

	private applyFilterState(filters: readonly Filter[], logic: FilterLogic): void {
		this.filters = filters;
		this.logic = logic;
		this.ui?.builder.setState(filters, logic);
	}

	private syncSortControls(): void {
		if (!this.ui) return;
		this.ui.sortFieldEl.value = this.sort.field;
		this.ui.sortDirectionEl.value = this.sort.direction;
	}

	private showViewMenu(view: SavedView, event: MouseEvent): void {
		const menu = new Menu();
		menu.addItem((item) =>
			item
				.setTitle(view.pinned ? STRINGS.common.unpin : STRINGS.common.pin)
				.setIcon(ICONS.pin)
				.onClick(() => void this.toggleViewPin(view)),
		);
		// Built-ins live in code so an update can fix them; only custom views are editable.
		if (!view.builtIn) {
			menu.addItem((item) =>
				item
					.setTitle(STRINGS.find.editView)
					.setIcon(ICONS.settings)
					.onClick(() => void this.openViewEditor(view)),
			);
			menu.addItem((item) =>
				item
					.setTitle(STRINGS.find.deleteView)
					.setIcon(ICONS.trash)
					.onClick(() => void this.deleteView(view)),
			);
		}
		menu.showAtMouseEvent(event);
	}

	private async toggleViewPin(view: SavedView): Promise<void> {
		try {
			await this.deps.settings.update((settings) => {
				if (view.builtIn) {
					const state = settings.retrieval.builtInViewState[view.id];
					settings.retrieval.builtInViewState[view.id] = {
						pinned: !(state?.pinned ?? view.pinned),
						hidden: state?.hidden ?? view.hidden ?? false,
						order: state?.order ?? view.order,
					};
					return;
				}
				const views = settings.retrieval.customViews;
				const index = views.findIndex((candidate) => candidate.id === view.id);
				const current = views[index];
				if (current) views[index] = { ...current, pinned: !current.pinned };
			});
		} catch (error) {
			this.deps.logger.error(`Could not pin the view "${view.name}"`, error);
			new Notice(STRINGS.errors.unexpected);
			return;
		}
		this.renderViewList();
	}

	private async deleteView(view: SavedView): Promise<void> {
		const answer = await confirm(this.deps.app, {
			title: STRINGS.find.deleteView,
			body: STRINGS.find.deleteViewConfirm(view.name),
			confirmLabel: STRINGS.common.delete,
			destructive: true,
		});
		if (answer !== 'confirm') return;

		try {
			await this.deps.settings.update((settings) => {
				settings.retrieval.customViews = settings.retrieval.customViews.filter(
					(candidate) => candidate.id !== view.id,
				);
			});
		} catch (error) {
			this.deps.logger.error(`Could not delete the view "${view.name}"`, error);
			new Notice(STRINGS.errors.unexpected);
			return;
		}

		if (this.activeViewId === view.id) {
			this.activeViewId = null;
			this.applyFilterState([], 'and');
		}
		this.renderViewList();
		this.search();
	}

	/** Open the editor for `existing`, or for a brand new view when it is null. */
	private async openViewEditor(existing: SavedView | null): Promise<void> {
		const views = this.deps.retrieval.views();
		const draft = existing ?? createEmptyView(Date.now(), views);

		const saved = await new ViewEditorModal(this.deps.app, draft, {
			folders: this.deps.index.folders(),
			tags: Array.from(this.deps.index.tagCounts().keys()).sort(),
		}).openAndWait();
		if (!saved) return;

		try {
			await this.deps.settings.update((settings) => {
				const customs = settings.retrieval.customViews;
				const index = customs.findIndex((candidate) => candidate.id === saved.id);
				if (index === -1) customs.push(saved);
				else customs[index] = saved;
			});
		} catch (error) {
			this.deps.logger.error(`Could not save the view "${saved.name}"`, error);
			new Notice(STRINGS.errors.unexpected);
			return;
		}

		new Notice(STRINGS.find.viewSaved);
		this.activeViewId = saved.id;
		this.applyFilterState(saved.filters, saved.logic);
		this.sort = saved.sort;
		this.syncSortControls();
		this.page = 1;
		this.renderViewList();
		this.search();
	}

	/* --------------------------------------------------------------- querying -- */

	/** Run a query now, replacing whatever is in flight. */
	private search(): void {
		this.inFlight = this.runSearch();
	}

	private async runSearch(): Promise<void> {
		const ui = this.ui;
		if (!ui) return;

		const token = (this.searchToken += 1);
		release(this.resultsCleanups);
		ui.resultsEl.empty();
		renderLoading(ui.resultsEl, STRINGS.find.searching);

		let response: SearchResponse;
		try {
			response = await this.execute();
		} catch (error) {
			if (token !== this.searchToken || !this.ui) return;
			this.deps.logger.error('The search could not be completed', error);
			new Notice(STRINGS.errors.unexpected);
			ui.countEl.setText('');
			release(this.resultsCleanups);
			ui.resultsEl.empty();
			renderErrorState(ui.resultsEl, {
				title: STRINGS.errors.unexpected,
				body: errorMessage(error),
				retryLabel: STRINGS.common.retry,
				onRetry: () => this.search(),
			});
			return;
		}

		if (token !== this.searchToken || !this.ui) return;
		ui.countEl.setText(STRINGS.find.resultCount(response.total));
		release(this.resultsCleanups);
		ui.resultsEl.empty();

		if (response.results.length === 0) {
			renderEmptyState(ui.resultsEl, {
				icon: ICONS.find,
				title: STRINGS.find.emptyTitle,
				body: STRINGS.find.emptyBody,
			});
		} else {
			this.renderResultList(ui.resultsEl, response);
		}

		// Contextual discovery only makes sense when nothing specific was asked for.
		if (this.query.trim().length === 0) {
			await this.renderContextual(ui.resultsEl, token);
		}
	}

	private async execute(): Promise<SearchResponse> {
		const view = this.activeView();
		const pageSize = Math.max(1, this.deps.settings.get().retrieval.resultsPerPage);

		// Orphans, notes without tags, and unlinked mentions are graph questions the filter
		// engine cannot express, so those views go through the service's bespoke path.
		if (view?.special) return this.deps.retrieval.runView(view, this.query, this.page);

		return this.deps.retrieval.search({
			keyword: this.query,
			filters: resolveFilters(this.filters, Date.now()),
			logic: this.logic,
			sort: this.sort,
			limit: pageSize,
			offset: (this.page - 1) * pageSize,
		});
	}

	private activeView(): SavedView | null {
		if (this.activeViewId === null) return null;
		return this.deps.retrieval.views().find((view) => view.id === this.activeViewId) ?? null;
	}

	/* ---------------------------------------------------------------- results -- */

	private renderResultList(parent: HTMLElement, response: SearchResponse): void {
		const list = parent.createDiv({ cls: 'jva-list' });
		for (const result of response.results) this.renderResult(list, result);

		const pageSize = Math.max(1, this.deps.settings.get().retrieval.resultsPerPage);
		const pageCount = Math.max(1, Math.ceil(response.total / pageSize));
		renderPagination(parent, {
			page: this.page,
			pageCount,
			label: STRINGS.inbox.page(this.page, pageCount),
			onChange: (page) => {
				this.page = page;
				this.search();
			},
		});
	}

	private renderResult(list: HTMLElement, result: SearchResult): void {
		const row = renderListItem(list, {
			cls: 'jva-result',
			title: result.title,
			icon: this.iconFor(result.path),
			meta: [
				result.folder,
				`${STRINGS.find.sortFields.created} ${formatDate(result.created)}`,
				`${STRINGS.find.sortFields.modified} ${formatDate(result.modified)}`,
			],
			badges: result.tags.map((tag) => `#${tag}`),
			onActivate: () => void this.open(result.path, false),
			actions: [
				{
					label: STRINGS.common.open,
					icon: ICONS.open,
					onClick: () => void this.open(result.path, false),
				},
				{
					icon: ICONS.newPane,
					tooltip: STRINGS.common.openInNewPane,
					onClick: () => void this.open(result.path, true),
				},
				{
					icon: ICONS.copy,
					tooltip: STRINGS.common.copyLink,
					onClick: () => void this.copyLink(result.path),
				},
				{
					icon: ICONS.pin,
					tooltip: STRINGS.common.pin,
					onClick: () => void this.pinNote(result.path),
				},
			],
		});
		row.setAttr('data-path', result.path);

		if (result.snippet.length === 0) return;
		const main = row.querySelector('.jva-list-item__main') ?? row;
		const snippet = main.createDiv({ cls: 'jva-result__snippet' });
		renderHighlighted(snippet, result.snippet, result.matches);
	}

	/* ------------------------------------------------------------- contextual -- */

	private async renderContextual(parent: HTMLElement, token: number): Promise<void> {
		const container = parent.createDiv({ cls: 'jva-contextual' });
		this.renderOnThisDay(container);
		await this.renderUnlinkedMentions(container);
		// A slow file read may have outlived this render pass.
		if (token !== this.searchToken || !this.ui) return;
		this.renderStaleNotes(container);
		this.renderSimilarNotes(container);
	}

	/**
	 * A collapsible panel.
	 *
	 * @returns The body element to fill. Collapse state lives in memory only, because it is a
	 *   glance-level preference that should not travel with a synced vault.
	 */
	private buildPanel(parent: HTMLElement, id: string, title: string): HTMLElement {
		const panel = parent.createDiv({ cls: 'jva-contextual__panel' });
		panel.setAttr('data-panel', id);

		const header = panel.createDiv({ cls: 'jva-contextual__header' });
		header.setAttr('role', 'button');
		header.setAttr('tabindex', '0');
		const chevron = header.createSpan();
		setIcon(chevron, ICONS.chevronRight);
		header.createSpan({ text: title });

		const body = panel.createDiv({ cls: 'jva-contextual__body' });

		const apply = (open: boolean): void => {
			header.setAttr('aria-expanded', String(open));
			panel.toggleClass('is-collapsed', !open);
			body.toggle(open);
		};
		const toggle = (): void => {
			const open = this.collapsedPanels.has(id);
			if (open) this.collapsedPanels.delete(id);
			else this.collapsedPanels.add(id);
			apply(open);
		};

		apply(!this.collapsedPanels.has(id));
		// Contextual panels are rebuilt on every search, so their headers are results-scoped.
		this.registerScoped(this.resultsCleanups, header, 'click', toggle);
		this.registerScoped(this.resultsCleanups, header, 'keydown', (event) => {
			if (event.key !== 'Enter' && event.key !== ' ') return;
			event.preventDefault();
			toggle();
		});

		return body;
	}

	private renderOnThisDay(parent: HTMLElement): void {
		const body = this.buildPanel(parent, PANEL_IDS.onThisDay, STRINGS.contextual.onThisDay);
		const entries = this.deps.retrieval.onThisDay();
		if (entries.length === 0) {
			renderInlineEmpty(body, STRINGS.contextual.onThisDayEmpty);
			return;
		}

		const thisYear = new Date().getFullYear();
		for (const entry of entries) {
			body.createDiv({
				cls: 'jva-onthisday__year',
				text: STRINGS.contextual.yearsAgo(Math.max(1, thisYear - entry.year)),
			});
			const list = body.createDiv({ cls: 'jva-list' });
			for (const note of entry.notes) {
				renderListItem(list, {
					title: note.title,
					icon: this.iconFor(note.path),
					meta: [formatDate(note.created)],
					onActivate: () => void this.open(note.path, false),
					actions: [
						{
							label: STRINGS.common.open,
							icon: ICONS.open,
							onClick: () => void this.open(note.path, false),
						},
					],
				});
			}
		}
	}

	private async renderUnlinkedMentions(parent: HTMLElement): Promise<void> {
		const body = this.buildPanel(
			parent,
			PANEL_IDS.unlinkedMentions,
			STRINGS.contextual.unlinkedMentions,
		);

		// Scoped to the open note: scanning the whole vault reads every file, which the saved
		// view is allowed to do on demand but a passive panel is not.
		const file = this.activeFile();
		if (!file) {
			renderInlineEmpty(body, STRINGS.contextual.unlinkedMentionsEmpty);
			return;
		}

		let mentions: readonly UnlinkedMention[];
		try {
			mentions = await this.deps.retrieval.unlinkedMentionsIn(file.path);
		} catch (error) {
			this.deps.logger.error(`Could not scan "${file.path}" for unlinked mentions`, error);
			renderErrorState(body, {
				title: STRINGS.errors.readFailed(file.path),
				retryLabel: STRINGS.common.retry,
				onRetry: () => this.search(),
			});
			return;
		}

		if (mentions.length === 0) {
			renderInlineEmpty(body, STRINGS.contextual.unlinkedMentionsEmpty);
			return;
		}

		for (const group of groupByTarget(mentions)) {
			const first = group[0];
			if (!first) continue;
			renderSectionHeading(body, first.targetTitle, group.length);
			for (const mention of group) {
				const item = body.createDiv({ cls: 'jva-mention' });
				const context = item.createDiv({ cls: 'jva-mention__context' });
				renderHighlighted(context, mention.context, [mention.contextRange]);

				const actions = createButtonRow(item);
				createButton(actions, {
					label: STRINGS.contextual.convertToLink,
					icon: ICONS.link,
					cta: true,
					onClick: () => void this.convertMention(mention),
				});
				createButton(actions, {
					label: STRINGS.common.open,
					icon: ICONS.open,
					onClick: () => void this.open(mention.targetPath, false),
				});
			}
		}
	}

	private renderStaleNotes(parent: HTMLElement): void {
		const body = this.buildPanel(parent, PANEL_IDS.staleNotes, STRINGS.contextual.staleNotes);
		const stale = this.deps.retrieval.staleNotes().slice(0, STALE_PANEL_LIMIT);
		if (stale.length === 0) {
			renderInlineEmpty(body, STRINGS.contextual.staleNotesEmpty);
			return;
		}

		const list = body.createDiv({ cls: 'jva-list' });
		for (const note of stale) {
			renderListItem(list, {
				title: note.title,
				icon: this.iconFor(note.path),
				meta: [STRINGS.contextual.staleFor(note.daysStale), formatDate(note.modified)],
				onActivate: () => void this.open(note.path, false),
				actions: [
					{
						label: STRINGS.common.open,
						icon: ICONS.open,
						onClick: () => void this.open(note.path, false),
					},
				],
			});
		}
	}

	private renderSimilarNotes(parent: HTMLElement): void {
		const body = this.buildPanel(
			parent,
			PANEL_IDS.similarNotes,
			STRINGS.contextual.similarNotes,
		);

		const file = this.activeFile();
		if (!file) {
			renderInlineEmpty(body, STRINGS.contextual.similarNotesEmpty);
			return;
		}

		const similar = this.deps.retrieval.similarNotes(file.path);
		if (similar.length === 0) {
			renderInlineEmpty(body, STRINGS.contextual.similarNotesEmpty);
			return;
		}

		const list = body.createDiv({ cls: 'jva-list' });
		for (const note of similar) {
			const row = renderListItem(list, {
				title: note.title,
				icon: this.iconFor(note.path),
				meta: note.sharedLinks.map((path) => getBasename(path)),
				badges: note.sharedTags.map((tag) => `#${tag}`),
				onActivate: () => void this.open(note.path, false),
				actions: [
					{
						label: STRINGS.common.open,
						icon: ICONS.open,
						onClick: () => void this.open(note.path, false),
					},
					{
						icon: ICONS.newPane,
						tooltip: STRINGS.common.openInNewPane,
						onClick: () => void this.open(note.path, true),
					},
				],
			});
			const titleRow = row.querySelector('.jva-list-item__title-row') ?? row;
			titleRow.createSpan({
				cls: 'jva-similar__score',
				text: STRINGS.contextual.similarity(note.score),
			});
		}
	}

	/* ---------------------------------------------------------------- actions -- */

	private activeFile(): TFile | null {
		return this.deps.app.workspace.getActiveFile();
	}

	private iconFor(path: string): string {
		const type = this.deps.index.get(path)?.type?.toLowerCase() ?? '';
		return TYPE_ICONS[type] ?? ICONS.open;
	}

	private async open(path: string, newPane: boolean): Promise<void> {
		try {
			await this.deps.retrieval.open(path, newPane);
		} catch (error) {
			this.deps.logger.error(`Could not open "${path}"`, error);
			new Notice(STRINGS.errors.fileNotFound(path));
		}
	}

	private async copyLink(path: string): Promise<void> {
		try {
			await copyText(this.deps.retrieval.linkFor(path));
			new Notice(STRINGS.find.copiedLink);
		} catch (error) {
			this.deps.logger.error(`Could not copy a link to "${path}"`, error);
			new Notice(STRINGS.errors.unexpected);
		}
	}

	/** Open the note in its own pinned tab, so a reference stays put while browsing. */
	private async pinNote(path: string): Promise<void> {
		try {
			const file = this.deps.app.vault.getFileByPath(path);
			if (!file) {
				new Notice(STRINGS.errors.fileNotFound(path));
				return;
			}
			const leaf = this.deps.app.workspace.getLeaf('tab');
			await leaf.openFile(file);
			leaf.setPinned(true);
		} catch (error) {
			this.deps.logger.error(`Could not pin "${path}"`, error);
			new Notice(STRINGS.errors.unexpected);
		}
	}

	private async convertMention(mention: UnlinkedMention): Promise<void> {
		try {
			const applied = await this.deps.retrieval.convertMentionToLink(mention);
			if (!applied) {
				// The service refuses when the note moved under the recorded offsets.
				new Notice(STRINGS.errors.writeFailed(mention.sourcePath));
				return;
			}
			new Notice(STRINGS.contextual.converted);
		} catch (error) {
			this.deps.logger.error(`Could not convert a mention in "${mention.sourcePath}"`, error);
			new Notice(STRINGS.errors.writeFailed(mention.sourcePath));
			return;
		}
		this.search();
	}

	/* ---------------------------------------------------------------- wiring -- */

	private register(cleanup: () => void): void {
		this.cleanups.push(cleanup);
	}

	private registerDomEvent<K extends keyof HTMLElementEventMap>(
		el: HTMLElement,
		type: K,
		handler: (event: HTMLElementEventMap[K]) => void,
	): void {
		this.registerScoped(this.cleanups, el, type, handler);
	}

	/**
	 * Add a listener whose lifetime is the given scope rather than the whole mount.
	 *
	 * Anything inside a region that gets emptied and rebuilt belongs in that region's scope,
	 * so the rebuild releases it.
	 */
	private registerScoped<K extends keyof HTMLElementEventMap>(
		scope: (() => void)[],
		el: HTMLElement,
		type: K,
		handler: (event: HTMLElementEventMap[K]) => void,
	): void {
		el.addEventListener(type, handler as EventListener);
		scope.push(() => el.removeEventListener(type, handler as EventListener));
	}
}

/* ------------------------------------------------------------ view editor -- */

interface ViewEditorSuggestions {
	readonly folders: readonly string[];
	readonly tags: readonly string[];
}

/**
 * Create or edit one custom saved view.
 *
 * Resolves with the finished view, or null when the user backed out — so the caller never has
 * to guess whether a dismissed modal meant "save" or "forget it".
 */
class ViewEditorModal extends JemzPromiseModal<SavedView | null> {
	private draft: SavedView;
	private builder: FilterBuilder | null = null;

	constructor(
		app: App,
		view: SavedView,
		private readonly suggestions: ViewEditorSuggestions,
	) {
		super(
			app,
			view.name.trim().length === 0 ? STRINGS.find.newView : STRINGS.find.editView,
			null,
			'jva-view-editor',
		);
		this.draft = view;
	}

	protected renderBody(body: HTMLElement): void {
		const nameField = body.createDiv({ cls: 'jva-field' });
		nameField.createDiv({ cls: 'jva-field__label', text: STRINGS.find.viewNameLabel });
		const nameInput = nameField.createEl('input', { type: 'text' });
		nameInput.value = this.draft.name;
		nameInput.setAttr('aria-label', STRINGS.find.viewNameLabel);
		nameInput.addEventListener('input', () => {
			this.draft = { ...this.draft, name: nameInput.value };
		});

		const iconField = body.createDiv({ cls: 'jva-field' });
		iconField.createDiv({ cls: 'jva-field__label', text: STRINGS.find.viewIconLabel });
		const iconInput = iconField.createEl('input', { type: 'text' });
		iconInput.value = this.draft.icon;
		iconInput.setAttr('maxlength', '2');
		iconInput.setAttr('aria-label', STRINGS.find.viewIconLabel);
		iconInput.addEventListener('input', () => {
			this.draft = { ...this.draft, icon: iconInput.value };
		});

		this.builder = new FilterBuilder(body, {
			initialFilters: this.draft.filters,
			initialLogic: this.draft.logic,
			folderSuggestions: this.suggestions.folders,
			tagSuggestions: this.suggestions.tags,
			onChange: (filters, logic) => {
				this.draft = { ...this.draft, filters: [...filters], logic };
			},
		});

		const sortField = body.createDiv({ cls: 'jva-field' });
		sortField.createDiv({ cls: 'jva-field__label', text: STRINGS.find.sortLabel });
		const sortRow = sortField.createDiv({ cls: 'jva-row' });

		const fieldSelect = sortRow.createEl('select', { cls: 'dropdown jva-view-editor__sort' });
		fieldSelect.setAttr('aria-label', STRINGS.find.sortLabel);
		for (const field of SORT_FIELDS) {
			fieldSelect.createEl('option', { value: field, text: STRINGS.find.sortFields[field] });
		}
		fieldSelect.value = this.draft.sort.field;
		fieldSelect.addEventListener('change', () => {
			const field = asSortField(fieldSelect.value) ?? this.draft.sort.field;
			this.draft = { ...this.draft, sort: { ...this.draft.sort, field } };
		});

		const directionSelect = sortRow.createEl('select', {
			cls: 'dropdown jva-view-editor__direction',
		});
		directionSelect.setAttr('aria-label', STRINGS.find.sortLabel);
		directionSelect.createEl('option', { value: 'desc', text: STRINGS.inbox.sortNewest });
		directionSelect.createEl('option', { value: 'asc', text: STRINGS.inbox.sortOldest });
		directionSelect.value = this.draft.sort.direction;
		directionSelect.addEventListener('change', () => {
			const direction: SortDirection = directionSelect.value === 'asc' ? 'asc' : 'desc';
			this.draft = { ...this.draft, sort: { ...this.draft.sort, direction } };
		});
	}

	protected override renderFooter(footer: HTMLElement): void {
		this.renderActions(footer, [
			{ label: STRINGS.common.cancel, onClick: (): void => this.settle(null) },
			{ label: STRINGS.common.save, cta: true, onClick: (): void => this.commit() },
		]);
	}

	override onClose(): void {
		this.builder?.destroy();
		this.builder = null;
		super.onClose();
	}

	/** An unnamed view would be invisible in the sidebar, so it gets the untitled fallback. */
	private commit(): void {
		const name = this.draft.name.trim();
		const icon = this.draft.icon.trim();
		this.settle({
			...this.draft,
			name: name.length === 0 ? STRINGS.capture.untitledPrefix : name,
			icon: icon.length === 0 ? '⭐' : icon,
			builtIn: false,
		});
	}
}

/* ----------------------------------------------------------------- helpers -- */

/**
 * Write a snippet into `parent` with the matched ranges wrapped in `<mark>`.
 *
 * Built from text nodes and real elements rather than an HTML string, so note content that
 * happens to contain markup is displayed, never interpreted.
 */
export function renderHighlighted(
	parent: HTMLElement,
	text: string,
	matches: readonly (readonly [number, number])[],
): HTMLElement {
	const ranges = mergeRanges(matches, text.length);
	let cursor = 0;
	for (const [start, end] of ranges) {
		if (start > cursor) parent.createSpan({ text: text.slice(cursor, start) });
		parent.createEl('mark', { text: text.slice(start, end) });
		cursor = end;
	}
	if (cursor < text.length) parent.createSpan({ text: text.slice(cursor) });
	return parent;
}

/** Clamp, sort, and merge highlight ranges so overlapping matches cannot nest `<mark>`s. */
export function mergeRanges(
	matches: readonly (readonly [number, number])[],
	length: number,
): [number, number][] {
	const clamped: [number, number][] = [];
	for (const [rawStart, rawEnd] of matches) {
		const start = Math.max(0, Math.min(rawStart, length));
		const end = Math.max(0, Math.min(rawEnd, length));
		if (end > start) clamped.push([start, end]);
	}
	clamped.sort((a, b) => a[0] - b[0] || a[1] - b[1]);

	const merged: [number, number][] = [];
	for (const range of clamped) {
		const previous = merged[merged.length - 1];
		if (previous && range[0] <= previous[1]) {
			previous[1] = Math.max(previous[1], range[1]);
		} else {
			merged.push([range[0], range[1]]);
		}
	}
	return merged;
}

/** Group mentions by the note they point at, preserving document order inside each group. */
export function groupByTarget(mentions: readonly UnlinkedMention[]): UnlinkedMention[][] {
	const groups = new Map<string, UnlinkedMention[]>();
	for (const mention of mentions) {
		const group = groups.get(mention.targetPath);
		if (group) group.push(mention);
		else groups.set(mention.targetPath, [mention]);
	}
	return Array.from(groups.values());
}

/**
 * Copy text to the clipboard.
 *
 * The async clipboard API is available on every platform this plugin supports, so there is no
 * `execCommand` fallback: it is deprecated, and keeping it around only to serve webviews we no
 * longer target would be dead code that trips up review.
 */
async function copyText(text: string): Promise<void> {
	const clipboard: Clipboard | undefined = navigator.clipboard;
	if (!clipboard || typeof clipboard.writeText !== 'function') {
		throw new Error('The clipboard is unavailable on this platform');
	}
	await clipboard.writeText(text);
}

function asSortField(value: string): SortField | null {
	return SORT_FIELDS.find((field) => field === value) ?? null;
}

/** Run and drop every cleanup in a scope. */
function release(cleanups: (() => void)[]): void {
	for (const cleanup of cleanups.splice(0)) cleanup();
}
