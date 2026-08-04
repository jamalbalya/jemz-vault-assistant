/**
 * The Inbox tab, driven through real DOM against the on-disk fixture vault.
 *
 * Every assertion here is about what a user would see or what landed in the vault: which rows
 * rendered, which Notice appeared, what the note's frontmatter says afterwards, where the file
 * ended up. The panel is wired to a real `VaultIndex` kept current by real vault events, so
 * "the item disappears after Process" is proven end to end rather than stubbed.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { App as ObsidianApp, TFile as ObsidianTFile } from 'obsidian';
import type { App, TFile } from '../../mocks/obsidian';
import { noticeLog, openModals, type FuzzySuggestModal, type Modal } from '../../mocks/obsidian';
import { loadVaultFromDisk } from '../../helpers/vault-fixture';
import { EventBus } from '../../../src/core/event-bus';
import { Logger } from '../../../src/core/logger';
import { SettingsStore } from '../../../src/core/settings';
import { STRINGS } from '../../../src/core/strings';
import { ContentIndex } from '../../../src/services/content-index';
import { InboxService, isInboxNote } from '../../../src/services/inbox-service';
import type { NoteRecord } from '../../../src/types/note';
import { MetadataService } from '../../../src/services/metadata-service';
import { VaultIndex } from '../../../src/services/vault-index';
import { InboxActions } from '../../../src/modules/inbox/inbox-actions';
import { InboxPanel } from '../../../src/modules/inbox/inbox-view';

/**
 * Hand the in-memory mock to code type-checked against the published Obsidian API.
 *
 * `tsconfig` resolves `obsidian` to the real declarations while vitest swaps in the mock, so
 * the two `App` types are structurally different by design.
 */
function asApp(app: App): ObsidianApp {
	return app as unknown as ObsidianApp;
}

/** Drain pending microtasks and timers so fire-and-forget refreshes have finished painting. */
async function flush(): Promise<void> {
	for (let i = 0; i < 8; i++) {
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
	}
}

interface Harness {
	app: App;
	bus: EventBus;
	settings: SettingsStore;
	inbox: InboxService;
	panel: InboxPanel;
	container: HTMLElement;
	captured: number;
	triaged: number;
}

/**
 * Build the panel over the fixture vault with the wiring the plugin itself installs.
 *
 * The vault event handlers are the important part: without them the index would never learn
 * that a note was processed, and the "it leaves the list" assertions would pass for the wrong
 * reason.
 */
async function mountPanel(
	overrides: { pageSize?: number; newestFirst?: boolean; stray?: boolean } = {},
): Promise<Harness> {
	const app = loadVaultFromDisk();
	if (overrides.stray) {
		// The other half of the membership rule: `status: inbox` on a note that does not live
		// in the inbox folder. The fixture has none, and it is the only shape for which
		// "Process" can actually remove a row.
		app.vault.seed(
			STRAY_PATH,
			'---\ncreated: 2026-06-16\ntype: capture\nstatus: inbox\n---\n\nA thought filed in the wrong place.\n',
		);
		app.metadataCache.refresh();
	}
	const logger = new Logger('silent');
	const bus = new EventBus();

	const settings = new SettingsStore(
		{
			loadData: async (): Promise<unknown> => null,
			saveData: async (): Promise<void> => undefined,
		},
		bus,
		logger,
		0,
	);
	await settings.load();
	if (overrides.pageSize !== undefined) settings.get().general.inboxPageSize = overrides.pageSize;
	if (overrides.newestFirst !== undefined) {
		settings.get().general.inboxNewestFirst = overrides.newestFirst;
	}

	const index = new VaultIndex(asApp(app), logger);
	index.build();

	const content = new ContentIndex(asApp(app), index, logger);
	const metadata = new MetadataService(asApp(app), logger);
	const inbox = new InboxService(asApp(app), index, metadata, () => settings.get(), logger);

	// Exactly what the plugin does on load: keep the index current, then tell the views.
	app.vault.on('modify', (file: TFile) => {
		index.updateFile(file as unknown as ObsidianTFile);
		content.invalidate(file.path);
		bus.emit('index-updated', { changed: [file.path] });
	});
	app.vault.on('rename', (file: TFile, oldPath: string) => {
		index.renameFile(file as unknown as ObsidianTFile, oldPath);
		content.invalidate(oldPath);
		bus.emit('index-updated', { changed: [file.path] });
	});
	app.vault.on('delete', (file: TFile) => {
		index.removeFile(file.path);
		content.invalidate(file.path);
		bus.emit('index-updated', { changed: [file.path] });
	});

	const actions = new InboxActions({
		app: asApp(app),
		inbox,
		logger,
		// Sourced from the index in production; the fixture's tags are enough here.
		tagSuggestions: () => Array.from(index.tagCounts().keys()).sort(),
	});

	const harness: Harness = {
		app,
		bus,
		settings,
		inbox,
		container: document.body.createDiv(),
		captured: 0,
		triaged: 0,
		panel: undefined as unknown as InboxPanel,
	};

	harness.panel = new InboxPanel({
		app: asApp(app),
		inbox,
		actions,
		content,
		settings,
		bus,
		logger,
		onStartTriage: () => {
			harness.triaged++;
		},
		onCapture: () => {
			harness.captured++;
		},
	});

	await harness.panel.mount(harness.container);
	return harness;
}

/** Every rendered row. */
function rows(container: HTMLElement): HTMLElement[] {
	return Array.from(container.querySelectorAll<HTMLElement>('.jva-inbox__item'));
}

/** Titles of the rendered rows, in display order. */
function titles(container: HTMLElement): string[] {
	return Array.from(container.querySelectorAll<HTMLElement>('.jva-list-item__title')).map(
		(el) => el.textContent ?? '',
	);
}

/** The row whose title starts with `prefix`, failing loudly when it is not on screen. */
function rowFor(container: HTMLElement, prefix: string): HTMLElement {
	const match = rows(container).find((row) =>
		(row.querySelector('.jva-list-item__title')?.textContent ?? '').startsWith(prefix),
	);
	if (!match) throw new Error(`No inbox row starting with "${prefix}"`);
	return match;
}

/** Press an action button on a row, identified by the tooltip the panel gives it. */
function press(row: HTMLElement, label: string): void {
	const button = row.querySelector<HTMLButtonElement>(
		`.jva-list-item__actions .jva-button[aria-label="${label}"]`,
	);
	if (!button) throw new Error(`No "${label}" button on this row`);
	button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

/** Press a toolbar button by its accessible name. */
function pressToolbar(container: HTMLElement, label: string): void {
	const button = container.querySelector<HTMLButtonElement>(
		`.jva-inbox__toolbar .jva-button[aria-label="${label}"]`,
	);
	if (!button) throw new Error(`No toolbar button labelled "${label}"`);
	button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

/** Press a button inside the currently open modal, by its visible label. */
function pressInModal(label: string): void {
	const modal = openModals[openModals.length - 1] as Modal | undefined;
	if (!modal) throw new Error('No modal is open');
	const button = Array.from(
		modal.contentEl.querySelectorAll<HTMLButtonElement>('.jva-button'),
	).find((el) => (el.querySelector('.jva-button__label')?.textContent ?? '') === label);
	if (!button) throw new Error(`No "${label}" button in the open modal`);
	button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

const NEWEST = '2026-06-15 idea - plugin improvement';
const OLDEST = '2026-06-06 meeting - project kickoff';
const SHOWER_THOUGHT = '2026-06-07 capture - shower thought';
const INBOX_FOLDER = '00-Inbox';
const STRAY = 'stray capture';
const STRAY_PATH = `Orphan Notes/${STRAY}.md`;

describe('the populated inbox', () => {
	let harness: Harness;

	beforeEach(async () => {
		harness = await mountPanel();
	});

	it('renders all ten fixture items', () => {
		expect(rows(harness.container)).toHaveLength(10);
	});

	it('reports the count in the toolbar', () => {
		expect(harness.container.querySelector('.jva-inbox__count')?.textContent).toBe(
			STRINGS.inbox.itemCount(10),
		);
	});

	it('sorts newest first by default', () => {
		expect(titles(harness.container)[0]).toBe(NEWEST);
		expect(titles(harness.container)[9]).toBe(OLDEST);
	});

	it('shows the created date and the source domain', () => {
		const row = rowFor(harness.container, '2026-06-09 reference');
		const meta = Array.from(row.querySelectorAll<HTMLElement>('.jva-list-item__meta-item')).map(
			(el) => el.textContent,
		);

		expect(meta).toContain('2026-06-09');
		expect(meta).toContain('refactoring.guru');
		expect(row.querySelector('.jva-inbox__source')?.textContent).toBe('refactoring.guru');
	});

	it('shows a 100-character preview of the body', () => {
		const preview =
			rowFor(harness.container, SHOWER_THOUGHT).querySelector('.jva-list-item__preview')
				?.textContent ?? '';

		expect(preview).toContain('The best note-taking app is the one you actually use');
		// 100 characters plus the ellipsis truncate() appends.
		expect(preview.length).toBeLessThanOrEqual(101);
		expect(preview.endsWith('…')).toBe(true);
	});

	it('gives each item a type icon', () => {
		const icon = rowFor(harness.container, '2026-06-10 idea').querySelector(
			'.jva-list-item__icon',
		);
		expect(icon?.getAttribute('data-icon')).toBe('lightbulb');
	});

	it('offers all eight actions on every row', () => {
		const labels = Array.from(
			rows(harness.container)[0]?.querySelectorAll<HTMLElement>(
				'.jva-list-item__actions .jva-button',
			) ?? [],
		).map((el) => el.getAttribute('aria-label'));

		expect(labels).toEqual(Object.values(STRINGS.inbox.actions));
	});

	it('opens a note when the row itself is activated', async () => {
		rowFor(harness.container, NEWEST).dispatchEvent(new MouseEvent('click', { bubbles: true }));
		await flush();

		expect(harness.app.workspace.openedPaths).toContain(`${INBOX_FOLDER}/${NEWEST}.md`);
	});

	it('hands control to triage mode from the toolbar', () => {
		pressToolbar(harness.container, STRINGS.inbox.startTriage);
		expect(harness.triaged).toBe(1);
	});
});

describe('processing an item', () => {
	it('sets the status to processed and drops the row from the list', async () => {
		const harness = await mountPanel({ stray: true });
		expect(rows(harness.container)).toHaveLength(11);

		press(rowFor(harness.container, STRAY), STRINGS.inbox.actions.process);
		await flush();

		expect(harness.app.vault.peek(STRAY_PATH)).toContain('status: processed');
		expect(titles(harness.container)).not.toContain(STRAY);
		expect(rows(harness.container)).toHaveLength(10);
		expect(harness.container.querySelector('.jva-inbox__count')?.textContent).toBe(
			STRINGS.inbox.itemCount(10),
		);
		expect(noticeLog).toContain(STRINGS.inbox.processed);
	});

	it('drops a processed note from the list even though it stays in the inbox folder', async () => {
		// Membership is "status: inbox OR in the inbox folder" (addendum 5.4), but an explicit
		// status has to win over location. Read literally, folder membership would make
		// Process a no-op for every captured note — they all live in the inbox folder — and
		// the user could never reach inbox zero without also moving files around.
		const harness = await mountPanel();

		press(rowFor(harness.container, NEWEST), STRINGS.inbox.actions.process);
		await flush();

		expect(harness.app.vault.peek(`${INBOX_FOLDER}/${NEWEST}.md`)).toContain(
			'status: processed',
		);
		expect(noticeLog).toContain(STRINGS.inbox.processed);
		expect(rows(harness.container)).toHaveLength(9);
		expect(harness.inbox.count()).toBe(9);
		expect(titles(harness.container)).not.toContain(NEWEST);
	});

	it('applies the membership rule: status wins, location is the fallback', () => {
		const record = (path: string, status: string | null): NoteRecord =>
			({ path, status }) as unknown as NoteRecord;

		// Location alone is enough until a status exists.
		expect(isInboxNote(record(`${INBOX_FOLDER}/fresh.md`, null), INBOX_FOLDER)).toBe(true);
		// An explicit inbox status counts from anywhere.
		expect(isInboxNote(record('Elsewhere/stray.md', 'inbox'), INBOX_FOLDER)).toBe(true);
		// A terminal status wins over location, which is what lets Process clear the list.
		expect(isInboxNote(record(`${INBOX_FOLDER}/done.md`, 'processed'), INBOX_FOLDER)).toBe(
			false,
		);
		expect(isInboxNote(record(`${INBOX_FOLDER}/old.md`, 'archived'), INBOX_FOLDER)).toBe(false);
		// An unrecognised status falls back to location rather than vanishing.
		expect(isInboxNote(record(`${INBOX_FOLDER}/odd.md`, 'someday'), INBOX_FOLDER)).toBe(true);
		expect(isInboxNote(record('Elsewhere/odd.md', 'someday'), INBOX_FOLDER)).toBe(false);
	});

	it('converts an item into a task', async () => {
		const harness = await mountPanel();

		press(rowFor(harness.container, SHOWER_THOUGHT), STRINGS.inbox.actions.convertToTask);
		await flush();

		const content = harness.app.vault.peek(`${INBOX_FOLDER}/${SHOWER_THOUGHT}.md`) ?? '';
		expect(content).toContain('type: task');
		expect(content).toContain('- [ ] The best note-taking app');
		expect(noticeLog).toContain(STRINGS.inbox.convertedToTask);
	});

	it('shows the empty state once every item has been processed', async () => {
		const harness = await mountPanel();

		for (const title of [...titles(harness.container)]) {
			press(rowFor(harness.container, title), STRINGS.inbox.actions.process);
			await flush();
		}

		expect(rows(harness.container)).toHaveLength(0);
		expect(harness.container.querySelector('.jva-empty-state__title')?.textContent).toBe(
			STRINGS.inbox.emptyTitle,
		);
		expect(harness.container.querySelector('.jva-empty-state__body')?.textContent).toBe(
			STRINGS.inbox.emptyBody,
		);

		// The empty state's only action is the one that makes sense next.
		harness.container
			.querySelector<HTMLButtonElement>('.jva-empty-state__action .jva-button')
			?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
		expect(harness.captured).toBe(1);

		// Nothing to triage, so the toolbar says so rather than opening an empty overlay.
		const triage = harness.container.querySelector<HTMLButtonElement>(
			`.jva-inbox__toolbar .jva-button[aria-label="${STRINGS.inbox.startTriage}"]`,
		);
		expect(triage?.hasAttribute('disabled')).toBe(true);
	});
});

describe('archiving an item', () => {
	it('moves the file into the archive folder and marks it archived', async () => {
		const harness = await mountPanel();

		press(rowFor(harness.container, NEWEST), STRINGS.inbox.actions.archive);
		await flush();

		expect(harness.app.vault.getFileByPath(`${INBOX_FOLDER}/${NEWEST}.md`)).toBeNull();
		const moved = harness.app.vault.peek(`04-Archive/${NEWEST}.md`);
		expect(moved).toBeDefined();
		expect(moved).toContain('status: archived');
		expect(titles(harness.container)).not.toContain(NEWEST);
		expect(noticeLog).toContain(STRINGS.inbox.archived);
	});
});

describe('deleting an item', () => {
	it('asks first and changes nothing when the confirmation is cancelled', async () => {
		const harness = await mountPanel();

		press(rowFor(harness.container, NEWEST), STRINGS.inbox.actions.delete);
		await flush();

		const dialog = openModals[openModals.length - 1];
		expect(dialog?.contentEl.querySelector('.jva-confirm__body')?.textContent).toBe(
			STRINGS.inbox.deleteConfirmBody(NEWEST),
		);

		pressInModal(STRINGS.common.cancel);
		await flush();

		expect(harness.app.vault.getFileByPath(`${INBOX_FOLDER}/${NEWEST}.md`)).not.toBeNull();
		expect(rows(harness.container)).toHaveLength(10);
		expect(noticeLog).not.toContain(STRINGS.inbox.deleted);
	});

	it('offers archiving as the alternative, and archives when it is chosen', async () => {
		const harness = await mountPanel();

		press(rowFor(harness.container, NEWEST), STRINGS.inbox.actions.delete);
		await flush();
		pressInModal(STRINGS.inbox.archiveInstead);
		await flush();

		expect(harness.app.vault.getFileByPath(`${INBOX_FOLDER}/${NEWEST}.md`)).toBeNull();
		expect(harness.app.vault.peek(`04-Archive/${NEWEST}.md`)).toContain('status: archived');
		expect(noticeLog).toContain(STRINGS.inbox.archived);
		expect(noticeLog).not.toContain(STRINGS.inbox.deleted);
	});

	it('moves the note to the trash when the deletion is confirmed', async () => {
		const harness = await mountPanel();

		press(rowFor(harness.container, NEWEST), STRINGS.inbox.actions.delete);
		await flush();
		pressInModal(STRINGS.inbox.deleteConfirmCta);
		await flush();

		expect(harness.app.vault.getFileByPath(`${INBOX_FOLDER}/${NEWEST}.md`)).toBeNull();
		expect(rows(harness.container)).toHaveLength(9);
		expect(noticeLog).toContain(STRINGS.inbox.deleted);
	});
});

describe('the pickers', () => {
	it('moves a note into the folder chosen in the picker', async () => {
		const harness = await mountPanel();

		press(rowFor(harness.container, NEWEST), STRINGS.inbox.actions.move);
		await flush();

		const picker = openModals[openModals.length - 1] as unknown as FuzzySuggestModal<unknown>;
		await picker.chooseAt('03-Resources/Articles');
		await flush();

		expect(harness.app.vault.peek(`03-Resources/Articles/${NEWEST}.md`)).toBeDefined();
		expect(noticeLog).toContain(STRINGS.inbox.moved('03-Resources/Articles'));
	});

	it('appends a wikilink to the note chosen in the picker', async () => {
		const harness = await mountPanel();

		press(rowFor(harness.container, SHOWER_THOUGHT), STRINGS.inbox.actions.link);
		await flush();

		const picker = openModals[openModals.length - 1] as unknown as FuzzySuggestModal<unknown>;
		await picker.chooseAt('Book - Deep Work');
		await flush();

		expect(harness.app.vault.peek(`${INBOX_FOLDER}/${SHOWER_THOUGHT}.md`)).toContain(
			'[[Book - Deep Work]]',
		);
		expect(noticeLog).toContain(STRINGS.inbox.linked('Book - Deep Work'));
	});

	it('changes nothing when a picker is dismissed', async () => {
		const harness = await mountPanel();
		const before = harness.app.vault.peek(`${INBOX_FOLDER}/${NEWEST}.md`);

		press(rowFor(harness.container, NEWEST), STRINGS.inbox.actions.move);
		await flush();
		openModals[openModals.length - 1]?.close();
		await flush();

		expect(harness.app.vault.peek(`${INBOX_FOLDER}/${NEWEST}.md`)).toBe(before);
		expect(rows(harness.container)).toHaveLength(10);
	});

	it('adds a tag typed into the tag prompt', async () => {
		const harness = await mountPanel();

		press(rowFor(harness.container, SHOWER_THOUGHT), STRINGS.inbox.actions.addTag);
		await flush();

		const field =
			openModals[openModals.length - 1]?.contentEl.querySelector<HTMLInputElement>(
				'.jva-tag-input__field',
			);
		expect(field).not.toBeNull();
		if (field) {
			field.value = '#Reading';
			field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
		}
		pressInModal(STRINGS.common.save);
		await flush();

		expect(harness.app.vault.peek(`${INBOX_FOLDER}/${SHOWER_THOUGHT}.md`)).toContain(
			'- reading',
		);
		expect(noticeLog).toContain(STRINGS.inbox.tagged('reading'));
	});
});

describe('sorting and pagination', () => {
	it('flips the order and persists the choice', async () => {
		const harness = await mountPanel();

		pressToolbar(harness.container, STRINGS.inbox.sortNewest);
		await flush();

		expect(titles(harness.container)[0]).toBe(OLDEST);
		expect(harness.settings.get().general.inboxNewestFirst).toBe(false);
		expect(
			harness.container.querySelector('.jva-inbox__toolbar .jva-button__label')?.textContent,
		).toBe(STRINGS.inbox.sortOldest);
	});

	it('paginates at the configured page size', async () => {
		const harness = await mountPanel({ pageSize: 4 });

		expect(rows(harness.container)).toHaveLength(4);
		expect(harness.container.querySelector('.jva-pagination__label')?.textContent).toBe(
			STRINGS.inbox.page(1, 3),
		);
	});

	it('keeps the current page across a refresh', async () => {
		const harness = await mountPanel({ pageSize: 4 });

		harness.container
			.querySelector<HTMLButtonElement>('.jva-pagination .jva-button[aria-label="Next page"]')
			?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
		await flush();

		expect(harness.container.querySelector('.jva-pagination__label')?.textContent).toBe(
			STRINGS.inbox.page(2, 3),
		);
		const onPageTwo = titles(harness.container);

		await harness.panel.refresh();

		expect(harness.container.querySelector('.jva-pagination__label')?.textContent).toBe(
			STRINGS.inbox.page(2, 3),
		);
		expect(titles(harness.container)).toEqual(onPageTwo);
	});

	it('falls back to the last page when the current one empties out', async () => {
		const harness = await mountPanel({ pageSize: 9 });

		harness.container
			.querySelector<HTMLButtonElement>('.jva-pagination .jva-button[aria-label="Next page"]')
			?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
		await flush();
		expect(rows(harness.container)).toHaveLength(1);

		// Processing the only item on page 2 must land on page 1, not on a blank page 2.
		press(rowFor(harness.container, OLDEST), STRINGS.inbox.actions.process);
		await flush();

		expect(rows(harness.container)).toHaveLength(9);
		expect(harness.container.querySelector('.jva-pagination')).toBeNull();
	});

	it('shows no pagination when everything fits on one page', async () => {
		const harness = await mountPanel();
		expect(harness.container.querySelector('.jva-pagination')).toBeNull();
	});
});

describe('failure paths', () => {
	it('reports a failed action and leaves the item in the list', async () => {
		const harness = await mountPanel();
		harness.app.vault.readOnly = true;

		press(rowFor(harness.container, NEWEST), STRINGS.inbox.actions.process);
		await flush();

		expect(noticeLog).toContain(STRINGS.inbox.actionFailed);
		expect(noticeLog).not.toContain(STRINGS.inbox.processed);
		expect(rows(harness.container)).toHaveLength(10);
		expect(harness.app.vault.peek(`${INBOX_FOLDER}/${NEWEST}.md`)).toContain('status: inbox');
	});

	it('says so when the note vanished before the button was pressed', async () => {
		const harness = await mountPanel();
		const path = `${INBOX_FOLDER}/${NEWEST}.md`;
		const row = rowFor(harness.container, NEWEST);

		// Deleted in another window: the row is still on screen but the file is gone.
		const file = harness.app.vault.getFileByPath(path);
		if (file) await harness.app.vault.trash(file, false);

		press(row, STRINGS.inbox.actions.process);
		await flush();

		expect(noticeLog).toContain(STRINGS.errors.fileNotFound(path));
		expect(rows(harness.container)).toHaveLength(9);
	});

	it('offers a retry when the list itself cannot be built', async () => {
		const harness = await mountPanel();
		let broken = true;
		const realItems = harness.inbox.items.bind(harness.inbox);
		harness.inbox.items = (): ReturnType<typeof realItems> => {
			if (broken) throw new Error('index unavailable');
			return realItems();
		};

		await harness.panel.refresh();
		expect(harness.container.querySelector('.jva-error-state__title')?.textContent).toBe(
			STRINGS.errors.unexpected,
		);

		broken = false;
		harness.container
			.querySelector<HTMLButtonElement>('.jva-error-state__actions .jva-button')
			?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
		await flush();

		expect(harness.container.querySelector('.jva-error-state')).toBeNull();
		expect(rows(harness.container)).toHaveLength(10);
	});
});

describe('lifecycle', () => {
	it('shows a loading state while the previews are being read', async () => {
		const harness = await mountPanel();
		const pending = harness.panel.refresh();

		expect(harness.container.querySelector('.jva-loading')).not.toBeNull();
		await pending;
		expect(harness.container.querySelector('.jva-loading')).toBeNull();
	});

	it('repaints when the bus reports the index changed', async () => {
		const harness = await mountPanel();
		const file = harness.app.vault.getFileByPath(`${INBOX_FOLDER}/${NEWEST}.md`);
		expect(file).not.toBeNull();

		// A change made anywhere else in Obsidian, announced the way the plugin announces it.
		if (file) await harness.app.vault.trash(file, false);
		await flush();

		expect(rows(harness.container)).toHaveLength(9);
	});

	it('unsubscribes from the bus and clears the DOM on unmount', async () => {
		const harness = await mountPanel();
		expect(harness.bus.listenerCount('index-updated')).toBe(1);
		expect(harness.bus.listenerCount('inbox-changed')).toBe(1);

		harness.panel.unmount();

		expect(harness.bus.listenerCount('index-updated')).toBe(0);
		expect(harness.bus.listenerCount('inbox-changed')).toBe(0);
		expect(harness.container.childElementCount).toBe(0);

		// A late event must not resurrect the panel.
		harness.bus.emit('inbox-changed', { count: 10 });
		harness.bus.emit('index-updated', { changed: [] });
		await flush();
		expect(harness.container.childElementCount).toBe(0);
	});

	it('survives an unmount that happens mid-render', async () => {
		const harness = await mountPanel();
		const pending = harness.panel.refresh();
		harness.panel.unmount();

		await expect(pending).resolves.toBeUndefined();
		expect(harness.container.childElementCount).toBe(0);
	});
});
