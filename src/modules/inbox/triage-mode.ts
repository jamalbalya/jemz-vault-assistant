/**
 * Triage mode — the full-screen overlay that walks the inbox one note at a time (main spec 5.3).
 *
 * Three decisions shape this module:
 *
 *  - **An overlay, not a modal.** Triage is a keyboard-first flow that owns the screen: a modal
 *    would put Obsidian's own Escape/Tab handling between the user and the shortcuts, and would
 *    fight the pickers this flow opens on top of itself.
 *  - **A frozen queue.** The items are snapshotted when the session starts and the cursor only
 *    moves; nothing is spliced out. That is what keeps "Item X of Y" stable while the user works
 *    (the denominator would otherwise shrink under them) and what makes "previous" able to go
 *    back to an item that has already been dealt with.
 *  - **Triage owns the interactions, the action layer owns the vault.** Every picker, prompt and
 *    confirmation lives here so the overlay always knows when one is open and can stop the
 *    shortcuts from firing while the user is typing a tag name into it.
 *
 * Session counters and the summary are per session: pressing "Continue triaging" starts a new
 * session over whatever is still in the inbox, with fresh counters.
 */

import { Component, Notice, Platform, setIcon, type App, type TFile } from 'obsidian';
import { ICONS, TYPE_ICONS } from '../../core/constants';
import type { Logger } from '../../core/logger';
import { STRINGS } from '../../core/strings';
import type { NoteRecord } from '../../types/note';
import { createButton, setButtonDisabled } from '../../ui/components/button';
import { confirm } from '../../ui/components/confirm-dialog';
import { renderErrorState, renderLoading } from '../../ui/components/empty-state';
import { pickFolder } from '../../ui/components/folder-suggest';
import { JemzPromiseModal } from '../../ui/components/modal-base';
import { pickNote } from '../../ui/components/note-suggest';
import { TagInput } from '../../ui/components/tag-input';
import { formatDate } from '../../utils/date';
import { capitalize, extractDomain } from '../../utils/string';

/** How much of the note body the card shows before it is cut off. */
export const TRIAGE_PREVIEW_LENGTH = 600;

/** The inbox queue triage walks. {@link InboxService} satisfies this. */
export interface TriageQueueSource {
	/** Every note currently in the inbox, in display order. */
	items(): NoteRecord[];
	/** How many notes are still waiting, for the summary's "Remaining in inbox" row. */
	count(): number;
}

/** Lazily read note bodies. {@link ContentIndex} satisfies this. */
export interface TriageContentSource {
	/** Body of a note with frontmatter stripped. */
	body(path: string): Promise<string>;
}

/**
 * The vault-touching half of the inbox item actions. {@link InboxService} satisfies this.
 *
 * Deliberately free of UI: every method either completes or throws, and triage decides what the
 * user sees. That keeps the same action code behind the inbox list and the triage overlay.
 */
export interface InboxActions {
	/** Mark a note processed so it leaves the inbox. */
	process(file: TFile): Promise<void>;
	/** Rewrite the title line as a task and set `type: task`. */
	convertToTask(file: TFile): Promise<void>;
	/** Move a note into `folderPath`. Resolves the new path. */
	moveToFolder(file: TFile, folderPath: string): Promise<string>;
	/** Add one tag to a note's frontmatter. */
	addTag(file: TFile, tag: string): Promise<void>;
	/** Append a wikilink to `target` at the end of the body. */
	linkToNote(file: TFile, target: TFile): Promise<void>;
	/** Move a note to the archive folder and mark it archived. Resolves the new path. */
	archive(file: TFile): Promise<string>;
	/** Move a note to the trash. The caller must have confirmed first. */
	trash(file: TFile, useSystemTrash?: boolean): Promise<void>;
}

/** Counts shown in the session summary (main spec 5.3). */
export interface TriageCounters {
	processed: number;
	convertedToTask: number;
	moved: number;
	archived: number;
	deleted: number;
	skipped: number;
}

export interface TriageModeOptions {
	readonly app: App;
	/** Supplies the queue and the remaining count. */
	readonly inbox: TriageQueueSource;
	/** Performs the vault work behind each shortcut. */
	readonly actions: InboxActions;
	/** Supplies the body preview shown on the card. */
	readonly content: TriageContentSource;
	readonly logger: Logger;
	/**
	 * Called once when a triage session ends for good — after the summary is dismissed with
	 * "Done" rather than "Continue triaging" — so the dashboard can refresh its inbox list.
	 */
	readonly onExit?: () => void;
	/** Known vault tags offered by the "add tag" prompt. */
	readonly tagSuggestions?: () => readonly string[];
}

/** A fresh set of counters. */
function emptyCounters(): TriageCounters {
	return { processed: 0, convertedToTask: 0, moved: 0, archived: 0, deleted: 0, skipped: 0 };
}

/**
 * Trim a note body down to a card-sized excerpt.
 *
 * Line breaks survive (the card renders with `pre-wrap`) because a bullet list flattened onto
 * one line is unreadable, which defeats the point of showing a preview at all.
 *
 * Exported for direct unit testing.
 */
export function triagePreview(body: string, maxChars = TRIAGE_PREVIEW_LENGTH): string {
	const normalized = body
		.replace(/\r\n/g, '\n')
		.replace(/\n{3,}/g, '\n\n')
		.trim();
	if (normalized.length <= maxChars) return normalized;
	return `${normalized.slice(0, maxChars).trimEnd()}…`;
}

/** Icon for a note type, falling back to the generic note icon for custom types. */
function typeIconFor(type: string | null): string {
	if (type === null) return ICONS.open;
	return TYPE_ICONS[type] ?? ICONS.open;
}

/** The small facts printed under the title: type, date, folder, source domain. */
function metaEntries(record: NoteRecord): string[] {
	const entries = [
		record.type === null ? '' : capitalize(record.type),
		formatDate(record.created),
		record.folder,
		record.source === null ? '' : extractDomain(record.source),
	];
	return entries.filter((entry) => entry.trim().length > 0);
}

/** Whether a node is something the user types into. */
function isEditableElement(node: EventTarget | Element | null): boolean {
	if (!(node instanceof HTMLElement)) return false;
	const tag = node.tagName;
	if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
	return node.isContentEditable === true;
}

/**
 * The "add a tag" prompt.
 *
 * Uses the shared {@link TagInput} so the suggestions come from tags the vault already uses —
 * the cheapest place to stop the tag drift the health module later has to clean up.
 */
class TriageTagModal extends JemzPromiseModal<string[]> {
	private input: TagInput | null = null;

	constructor(
		app: App,
		private readonly suggestions: readonly string[],
	) {
		super(app, STRINGS.inbox.addTagPrompt, []);
	}

	protected renderBody(body: HTMLElement): void {
		const field = body.createDiv({ cls: 'jva-field' });
		field.createDiv({ cls: 'jva-field__label', text: STRINGS.capture.tagsLabel });
		this.input = new TagInput(field, {
			placeholder: STRINGS.capture.tagsPlaceholder,
			suggestions: this.suggestions,
		});
	}

	protected override renderFooter(footer: HTMLElement): void {
		this.renderActions(footer, [
			{ label: STRINGS.common.cancel, onClick: (): void => this.settle([]) },
			{
				label: STRINGS.inbox.actions.addTag,
				icon: ICONS.tag,
				cta: true,
				onClick: (): void => this.commit(),
			},
		]);
	}

	override onOpen(): void {
		super.onOpen();
		this.input?.focus();
	}

	/**
	 * Settle with everything the user entered.
	 *
	 * `TagInput` only commits a chip on Enter, so half-typed text still sitting in the field is
	 * pulled in first — otherwise typing a tag and clicking the button would silently do nothing.
	 */
	private commit(): void {
		const field = this.contentEl.querySelector('.jva-tag-input__field');
		if (field instanceof HTMLInputElement && field.value.trim().length > 0) {
			this.input?.add(field.value);
			field.value = '';
		}
		this.settle(this.input?.value ?? []);
	}
}

/** The end-of-session summary, with the two ways out of it. */
class TriageSummaryModal extends JemzPromiseModal<'continue' | 'done'> {
	constructor(
		app: App,
		private readonly counters: Readonly<TriageCounters>,
		private readonly remaining: number,
	) {
		super(app, STRINGS.triage.summaryTitle, 'done');
	}

	protected renderBody(body: HTMLElement): void {
		const list = body.createDiv({ cls: 'jva-triage__summary' });
		const rows: readonly (readonly [string, number])[] = [
			[STRINGS.triage.summaryProcessed, this.counters.processed],
			[STRINGS.triage.summaryConverted, this.counters.convertedToTask],
			[STRINGS.triage.summaryMoved, this.counters.moved],
			[STRINGS.triage.summaryArchived, this.counters.archived],
			[STRINGS.triage.summaryDeleted, this.counters.deleted],
			[STRINGS.triage.summarySkipped, this.counters.skipped],
			[STRINGS.triage.summaryRemaining, this.remaining],
		];

		for (const [label, value] of rows) {
			const row = list.createDiv({ cls: 'jva-triage__summary-row' });
			row.createSpan({ text: label });
			row.createSpan({ cls: 'jva-triage__summary-value', text: String(value) });
		}
	}

	protected override renderFooter(footer: HTMLElement): void {
		this.renderActions(footer, [
			{
				label: STRINGS.triage.continueTriaging,
				icon: ICONS.inbox,
				cta: true,
				// Nothing left to triage: offering to continue would only raise "nothing to
				// triage" a moment later.
				disabled: this.remaining === 0,
				onClick: (): void => this.settle('continue'),
			},
			{ label: STRINGS.common.done, onClick: (): void => this.settle('done') },
		]);
	}
}

export class TriageMode extends Component {
	private readonly app: App;
	private readonly inbox: TriageQueueSource;
	private readonly actions: InboxActions;
	private readonly content: TriageContentSource;
	private readonly logger: Logger;
	private readonly onExit: (() => void) | null;
	private readonly tagSuggestions: (() => readonly string[]) | null;

	/** The session's frozen queue. Never spliced — see the module comment. */
	private queue: NoteRecord[] = [];
	private index = 0;
	private counters: TriageCounters = emptyCounters();
	private overlayEl: HTMLElement | null = null;
	private actionButtons: HTMLButtonElement[] = [];
	/** True while an action or a picker is in flight, which parks the shortcuts. */
	private busy = false;
	/** Bumped on every render so a slow body read cannot paint into a card that moved on. */
	private renderToken = 0;

	constructor(options: TriageModeOptions) {
		super();
		this.app = options.app;
		this.inbox = options.inbox;
		this.actions = options.actions;
		this.content = options.content;
		this.logger = options.logger;
		this.onExit = options.onExit ?? null;
		this.tagSuggestions = options.tagSuggestions ?? null;
	}

	/** Whether the overlay is on screen. */
	get isOpen(): boolean {
		return this.overlayEl !== null;
	}

	/**
	 * Open the overlay on the current inbox.
	 *
	 * Does nothing but raise a Notice when the inbox is empty: an overlay with no item in it is
	 * a dead end the user has to escape from.
	 */
	async start(): Promise<void> {
		if (this.overlayEl) {
			this.focusOverlay();
			return;
		}

		let items: readonly NoteRecord[];
		try {
			items = this.inbox.items();
		} catch (error) {
			this.logger.error('Could not read the inbox to start triage', error);
			new Notice(STRINGS.errors.unexpected);
			return;
		}

		if (items.length === 0) {
			new Notice(STRINGS.triage.nothingToTriage);
			return;
		}

		this.queue = [...items];
		this.index = 0;
		this.counters = emptyCounters();
		this.openOverlay();
		await this.renderCurrent();
	}

	/**
	 * Close the overlay and show the session summary.
	 *
	 * This is the single exit path: Escape, the mobile close button, and running out of items
	 * all land here, so the counts are always shown exactly once.
	 */
	exit(): void {
		if (!this.isOpen) return;
		const counters = { ...this.counters };
		this.close();
		void this.presentSummary(counters);
	}

	/** Tear the overlay down without a summary, e.g. when the plugin unloads. */
	override onunload(): void {
		this.overlayEl?.detach();
		this.overlayEl = null;
		this.actionButtons = [];
		this.busy = false;
	}

	/* ------------------------------------------------------------- lifecycle -- */

	private openOverlay(): void {
		// Triage is usually driven from a command rather than mounted as a child component, so
		// it loads itself: `unload()` is a no-op on a component that was never loaded, and that
		// would leave the key handler attached for good. Both calls are idempotent.
		this.load();

		const overlay = document.body.createDiv({ cls: 'jva-triage' });
		overlay.setAttr('role', 'dialog');
		overlay.setAttr('aria-modal', 'true');
		overlay.setAttr('aria-label', STRINGS.triage.title);
		// Focusable so the overlay itself receives the shortcuts.
		overlay.setAttr('tabindex', '-1');
		this.overlayEl = overlay;

		this.registerDomEvent(overlay, 'keydown', (event) => this.onKeyDown(event));
	}

	private close(): void {
		// Abandon any body read still in flight before the element it would paint into goes.
		this.renderToken += 1;
		this.unload();
	}

	private focusOverlay(): void {
		this.overlayEl?.focus();
	}

	/* ---------------------------------------------------------------- render -- */

	private currentRecord(): NoteRecord | null {
		return this.queue[this.index] ?? null;
	}

	private async renderCurrent(): Promise<void> {
		const overlay = this.overlayEl;
		if (!overlay) return;

		const record = this.currentRecord();
		if (!record) {
			// The queue ran out from under us; the summary is the only sensible destination.
			this.exit();
			return;
		}

		const token = ++this.renderToken;
		overlay.empty();
		this.actionButtons = [];

		const card = overlay.createDiv({ cls: 'jva-triage__card' });
		const title = card.createEl('h2', { cls: 'jva-triage__title' });
		const iconEl = title.createSpan({ cls: 'jva-list-item__icon' });
		setIcon(iconEl, typeIconFor(record.type));
		title.createSpan({ text: record.basename });

		const meta = card.createDiv({ cls: 'jva-triage__meta' });
		for (const entry of metaEntries(record)) meta.createSpan({ text: entry });

		const bodyEl = card.createDiv({ cls: 'jva-triage__body' });
		this.renderActionGrid(overlay);
		this.renderFooter(overlay);
		this.focusOverlay();

		if (!this.app.vault.getFileByPath(record.path)) {
			// Deleted here or by someone else. Skipping is the only recovery that makes sense.
			renderErrorState(bodyEl, {
				title: STRINGS.errors.fileNotFound(record.path),
				retryLabel: STRINGS.common.skip,
				onRetry: () => void this.skip(),
			});
			return;
		}

		await this.renderPreview(bodyEl, record, token);
	}

	private async renderPreview(
		bodyEl: HTMLElement,
		record: NoteRecord,
		token: number,
	): Promise<void> {
		bodyEl.empty();
		renderLoading(bodyEl, STRINGS.common.loading);

		try {
			const body = await this.content.body(record.path);
			if (token !== this.renderToken) return;
			bodyEl.empty();
			const preview = triagePreview(body);
			if (preview.length > 0) bodyEl.setText(preview);
		} catch (error) {
			if (token !== this.renderToken) return;
			this.logger.error(`Could not read "${record.path}" for the triage card`, error);
			bodyEl.empty();
			renderErrorState(bodyEl, {
				title: STRINGS.errors.readFailed(record.path),
				retryLabel: STRINGS.common.retry,
				onRetry: () => void this.renderPreview(bodyEl, record, this.renderToken),
			});
		}
	}

	/** Every action, labelled with the key that triggers it (main spec 5.3). */
	private renderActionGrid(overlay: HTMLElement): void {
		const grid = overlay.createDiv({ cls: 'jva-triage__actions' });
		const shortcuts = STRINGS.triage.shortcuts;

		const definitions: readonly {
			label: string;
			icon: string;
			shortcut: string;
			run: () => void;
		}[] = [
			{
				label: STRINGS.inbox.actions.process,
				icon: ICONS.success,
				shortcut: shortcuts.process,
				run: () => void this.processCurrent(),
			},
			{
				label: STRINGS.inbox.actions.convertToTask,
				icon: TYPE_ICONS['task'] ?? ICONS.success,
				shortcut: shortcuts.task,
				run: () => void this.convertCurrentToTask(),
			},
			{
				label: STRINGS.inbox.actions.move,
				icon: ICONS.move,
				shortcut: shortcuts.move,
				run: () => void this.moveCurrent(),
			},
			{
				label: STRINGS.inbox.actions.addTag,
				icon: ICONS.tag,
				shortcut: shortcuts.tag,
				run: () => void this.tagCurrent(),
			},
			{
				label: STRINGS.inbox.actions.link,
				icon: ICONS.link,
				shortcut: shortcuts.link,
				run: () => void this.linkCurrent(),
			},
			{
				label: STRINGS.inbox.actions.archive,
				icon: ICONS.archive,
				shortcut: shortcuts.archive,
				run: () => void this.archiveCurrent(),
			},
			{
				label: STRINGS.inbox.actions.delete,
				icon: ICONS.trash,
				shortcut: shortcuts.delete,
				run: () => void this.deleteCurrent(),
			},
			{
				label: STRINGS.common.previous,
				icon: ICONS.chevronLeft,
				shortcut: shortcuts.previous,
				run: () => void this.previous(),
			},
			{
				label: STRINGS.common.skip,
				icon: ICONS.chevronRight,
				shortcut: shortcuts.skip,
				run: () => void this.skip(),
			},
		];

		for (const definition of definitions) {
			const button = createButton(grid, {
				label: definition.label,
				icon: definition.icon,
				// A shortcut chip is noise on a device with no keyboard attached.
				...(Platform.isMobile ? {} : { shortcut: definition.shortcut }),
				onClick: () => definition.run(),
			});
			this.actionButtons.push(button);
		}

		this.setActionsDisabled(this.busy);
	}

	private renderFooter(overlay: HTMLElement): void {
		const footer = overlay.createDiv({ cls: 'jva-triage__footer' });
		footer.createSpan({
			cls: 'jva-triage__progress',
			text: STRINGS.triage.progress(this.index + 1, this.queue.length),
		});

		if (Platform.isMobile) {
			// There is no Escape key to hint at, so give the flow a real way out instead.
			createButton(footer, {
				label: STRINGS.common.close,
				icon: ICONS.close,
				onClick: () => this.exit(),
			});
		} else {
			footer.createSpan({ text: STRINGS.triage.hintExit });
		}
	}

	private setActionsDisabled(disabled: boolean): void {
		for (const button of this.actionButtons) setButtonDisabled(button, disabled);
	}

	/* ------------------------------------------------------------- keyboard -- */

	private onKeyDown(event: KeyboardEvent): void {
		if (!this.isOpen || this.busy) return;
		// A shortcut must never steal a keystroke from a text field or from a picker layered
		// over the overlay — otherwise typing a tag name fires half the action grid.
		if (this.isTypingContext(event)) return;
		if (this.isPickerOpen()) return;
		if (event.ctrlKey || event.metaKey || event.altKey) return;

		const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;

		switch (key) {
			case 'enter':
			case 'Enter':
				// Enter on a focused action button already fires its click handler.
				if (event.target instanceof HTMLButtonElement) return;
				this.consume(event);
				void this.processCurrent();
				return;
			case 'p':
				this.consume(event);
				void this.processCurrent();
				return;
			case 't':
				this.consume(event);
				void this.convertCurrentToTask();
				return;
			case 'm':
				this.consume(event);
				void this.moveCurrent();
				return;
			case 'g':
				this.consume(event);
				void this.tagCurrent();
				return;
			case 'l':
				this.consume(event);
				void this.linkCurrent();
				return;
			case 'a':
				this.consume(event);
				void this.archiveCurrent();
				return;
			case 'd':
				this.consume(event);
				void this.deleteCurrent();
				return;
			case 's':
			case 'ArrowRight':
				this.consume(event);
				void this.skip();
				return;
			case 'ArrowLeft':
				this.consume(event);
				void this.previous();
				return;
			case 'Escape':
				this.consume(event);
				this.exit();
				return;
			default:
				return;
		}
	}

	private consume(event: KeyboardEvent): void {
		event.preventDefault();
		event.stopPropagation();
	}

	private isTypingContext(event: KeyboardEvent): boolean {
		if (isEditableElement(event.target)) return true;
		const doc = this.overlayEl?.ownerDocument ?? document;
		return isEditableElement(doc.activeElement);
	}

	/** True while a picker, prompt or confirmation is layered over the overlay. */
	private isPickerOpen(): boolean {
		const doc = this.overlayEl?.ownerDocument ?? document;
		return doc.querySelector('.modal-container') !== null;
	}

	/* -------------------------------------------------------------- actions -- */

	/**
	 * Run one action against the current note.
	 *
	 * Everything shared lives here: the missing-file guard, the busy flag that parks the
	 * shortcuts while a picker is open, the failure Notice, and re-enabling the grid afterwards.
	 * A failing action leaves the item exactly where it was.
	 */
	private async withCurrentFile(body: (file: TFile) => Promise<void>): Promise<void> {
		if (this.busy || !this.isOpen) return;
		const record = this.currentRecord();
		if (!record) return;

		const file = this.app.vault.getFileByPath(record.path);
		if (!file) {
			this.logger.warn(`Triage lost track of "${record.path}"`);
			new Notice(STRINGS.errors.fileNotFound(record.path));
			await this.renderCurrent();
			return;
		}

		this.busy = true;
		this.setActionsDisabled(true);
		try {
			await body(file);
		} catch (error) {
			this.logger.error(`Triage action failed for "${record.path}"`, error);
			new Notice(STRINGS.inbox.actionFailed);
		} finally {
			this.busy = false;
			this.setActionsDisabled(false);
			this.focusOverlay();
		}
	}

	private async processCurrent(): Promise<void> {
		await this.withCurrentFile(async (file) => {
			await this.actions.process(file);
			this.counters.processed += 1;
			new Notice(STRINGS.inbox.processed);
			await this.advance();
		});
	}

	private async convertCurrentToTask(): Promise<void> {
		await this.withCurrentFile(async (file) => {
			await this.actions.convertToTask(file);
			this.counters.convertedToTask += 1;
			new Notice(STRINGS.inbox.convertedToTask);
			await this.advance();
		});
	}

	private async moveCurrent(): Promise<void> {
		await this.withCurrentFile(async (file) => {
			const folder = await pickFolder(this.app, STRINGS.inbox.selectFolder);
			if (!folder) return;
			await this.actions.moveToFolder(file, folder.isRoot() ? '' : folder.path);
			this.counters.moved += 1;
			new Notice(STRINGS.inbox.moved(folder.path));
			await this.advance();
		});
	}

	private async tagCurrent(): Promise<void> {
		await this.withCurrentFile(async (file) => {
			const suggestions = this.tagSuggestions?.() ?? [];
			const tags = await new TriageTagModal(this.app, suggestions).openAndWait();
			if (tags.length === 0) return;
			for (const tag of tags) await this.actions.addTag(file, tag);
			// Tagging annotates the note, it does not dispose of it, so the cursor stays put.
			new Notice(STRINGS.inbox.tagged(tags.join(' #')));
		});
	}

	private async linkCurrent(): Promise<void> {
		await this.withCurrentFile(async (file) => {
			const target = await pickNote(this.app, {
				placeholder: STRINGS.inbox.selectNote,
				exclude: new Set([file.path]),
			});
			if (!target) return;
			await this.actions.linkToNote(file, target);
			new Notice(STRINGS.inbox.linked(target.basename));
			// The body just gained a line, so the preview is out of date.
			await this.renderCurrent();
		});
	}

	private async archiveCurrent(): Promise<void> {
		await this.withCurrentFile(async (file) => {
			await this.actions.archive(file);
			this.counters.archived += 1;
			new Notice(STRINGS.inbox.archived);
			await this.advance();
		});
	}

	/**
	 * Delete the current note, always behind a confirmation that offers archiving instead
	 * (main spec 5.2: prefer archiving over deletion).
	 */
	private async deleteCurrent(): Promise<void> {
		await this.withCurrentFile(async (file) => {
			const record = this.currentRecord();
			const choice = await confirm(this.app, {
				title: STRINGS.inbox.deleteConfirmTitle,
				body: STRINGS.inbox.deleteConfirmBody(record?.basename ?? file.basename),
				confirmLabel: STRINGS.inbox.deleteConfirmCta,
				alternateLabel: STRINGS.inbox.archiveInstead,
				destructive: true,
			});

			if (choice === 'cancel') return;

			if (choice === 'alternate') {
				await this.actions.archive(file);
				this.counters.archived += 1;
				new Notice(STRINGS.inbox.archived);
				await this.advance();
				return;
			}

			await this.actions.trash(file);
			this.counters.deleted += 1;
			new Notice(STRINGS.inbox.deleted);
			await this.advance();
		});
	}

	/* ------------------------------------------------------------ navigation -- */

	private async skip(): Promise<void> {
		if (this.busy || !this.isOpen) return;
		this.counters.skipped += 1;
		await this.advance();
	}

	private async previous(): Promise<void> {
		// Already on the first item: there is nothing behind it.
		if (this.busy || !this.isOpen || this.index === 0) return;
		this.index -= 1;
		await this.renderCurrent();
	}

	private async advance(): Promise<void> {
		if (this.index + 1 >= this.queue.length) {
			// The last item is done; go straight to the summary.
			this.exit();
			return;
		}
		this.index += 1;
		await this.renderCurrent();
	}

	/* --------------------------------------------------------------- summary -- */

	private async presentSummary(counters: TriageCounters): Promise<void> {
		const remaining = this.remainingInInbox();
		try {
			const choice = await new TriageSummaryModal(
				this.app,
				counters,
				remaining,
			).openAndWait();
			if (choice === 'continue') {
				await this.start();
				return;
			}
		} catch (error) {
			this.logger.error('The triage summary could not be shown', error);
			new Notice(STRINGS.errors.unexpected);
		}
		this.onExit?.();
	}

	private remainingInInbox(): number {
		try {
			return this.inbox.count();
		} catch (error) {
			this.logger.warn('Could not count the inbox for the triage summary', error);
			return 0;
		}
	}
}
