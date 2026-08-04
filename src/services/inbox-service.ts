/**
 * Inbox listing and the eight per-item actions.
 *
 * Membership follows the frontmatter contract (addendum 5.4): a note is in the inbox when
 * its `status` is `inbox` OR it lives in the configured inbox folder. Notes marked
 * `archived` are excluded regardless of where they sit.
 *
 * Every action returns a result object rather than showing UI, so triage mode and the inbox
 * list share the same logic and both are testable headlessly.
 */

import { TFolder, type App, type TFile } from 'obsidian';
import type { NoteRecord } from '../types/note';
import type { JemzSettings } from '../types/settings';
import { errorMessage, type Logger } from '../core/logger';
import { STRINGS } from '../core/strings';
import { isInFolder, joinPath, uniquePath } from '../utils/file';
import { normalizeTag } from '../utils/string';
import type { VaultIndex } from './vault-index';
import type { MetadataService } from './metadata-service';

/**
 * Statuses that take a note out of the inbox no matter where it lives.
 *
 * The frontmatter contract says the inbox is "status `inbox` OR located in the inbox
 * folder". Taken literally that makes Process a no-op for the common case — a captured note
 * sits in the inbox folder, so marking it processed would not remove it and the user would
 * be stuck triaging the same note forever. An explicit status therefore wins over location:
 * folder membership only applies to notes that have not been given a status yet.
 */
const TERMINAL_STATUSES: ReadonlySet<string> = new Set(['processed', 'archived']);

/**
 * Whether a note belongs in the inbox.
 *
 * Shared with the health scan so that "skip the inbox" covers exactly the notes the inbox
 * tab shows, and not one note more.
 */
export function isInboxNote(record: NoteRecord, inboxFolder: string): boolean {
	const status = record.status?.trim().toLowerCase() ?? '';
	if (status === 'inbox') return true;
	if (TERMINAL_STATUSES.has(status)) return false;
	return inboxFolder.length > 0 && isInFolder(record.path, inboxFolder);
}

/** Raised when an inbox action cannot complete. */
export class InboxActionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'InboxActionError';
	}
}

/** One page of inbox items. */
export interface InboxPage {
	readonly items: readonly NoteRecord[];
	readonly page: number;
	readonly pageCount: number;
	readonly total: number;
}

export class InboxService {
	constructor(
		private readonly app: App,
		private readonly index: VaultIndex,
		private readonly metadata: MetadataService,
		private readonly getSettings: () => JemzSettings,
		private readonly logger: Logger,
	) {}

	/** Every note currently in the inbox, sorted by the configured direction. */
	items(): NoteRecord[] {
		const settings = this.getSettings();
		const inboxFolder = settings.capture.inboxFolder.trim();

		const items = this.index.notes().filter((record) => isInboxNote(record, inboxFolder));

		const direction = settings.general.inboxNewestFirst ? -1 : 1;
		return items.sort(
			(a, b) => direction * (a.created - b.created) || a.path.localeCompare(b.path),
		);
	}

	/** How many notes are waiting, for the status bar and dashboard header. */
	count(): number {
		return this.items().length;
	}

	/** A page of items. `page` is 1-based and clamped into range. */
	page(page = 1, pageSize = this.getSettings().general.inboxPageSize): InboxPage {
		const all = this.items();
		const size = Math.max(1, pageSize);
		const pageCount = Math.max(1, Math.ceil(all.length / size));
		const current = Math.min(Math.max(1, Math.floor(page)), pageCount);
		const start = (current - 1) * size;
		return {
			items: all.slice(start, start + size),
			page: current,
			pageCount,
			total: all.length,
		};
	}

	/* ------------------------------------------------------------- actions -- */

	/** Open a note in the workspace. No confirmation, per the spec. */
	async open(file: TFile, newPane = false): Promise<void> {
		await this.app.workspace.openLinkText(file.path, file.path, newPane);
	}

	/** Mark a note processed so it leaves the inbox. */
	async process(file: TFile): Promise<void> {
		await this.run(file, 'process', async () => {
			await this.metadata.setStatus(file, 'processed');
		});
	}

	/**
	 * Turn a note into a task.
	 *
	 * The title line becomes a checkbox item and `type` becomes `task`. A leading heading is
	 * rewritten into the task (rather than nesting a checkbox inside a heading, which
	 * markdown renders as literal text), an existing task line is left alone, and a note
	 * with no body gets a task built from its file name.
	 */
	async convertToTask(file: TFile): Promise<void> {
		await this.run(file, 'convert to task', async () => {
			await this.app.vault.process(file, (content) => addTaskPrefix(content, file.basename));
			await this.metadata.setType(file, 'task');
		});
	}

	/** Move a note into another folder, creating it when needed. */
	async moveToFolder(file: TFile, folderPath: string): Promise<string> {
		const target = folderPath.trim();
		return this.run(file, `move to ${target}`, async () => {
			if (target.length > 0) await this.ensureFolder(target);
			const desired = joinPath(target, file.name);
			if (desired === file.path) return file.path;
			const destination = uniquePath(
				desired,
				(candidate) => this.app.vault.getAbstractFileByPath(candidate) !== null,
			);
			await this.app.fileManager.renameFile(file, destination);
			return destination;
		});
	}

	/** Add a tag to a note's frontmatter. */
	async addTag(file: TFile, tag: string): Promise<void> {
		const normalized = normalizeTag(tag);
		if (normalized.length === 0) throw new InboxActionError('A tag cannot be empty.');
		await this.run(file, `add tag ${normalized}`, async () => {
			await this.metadata.addTag(file, normalized);
		});
	}

	/** Append a wikilink to another note at the end of the body. */
	async linkToNote(file: TFile, target: TFile): Promise<void> {
		await this.run(file, `link to ${target.path}`, async () => {
			const link = this.app.fileManager.generateMarkdownLink(target, file.path);
			await this.app.vault.process(file, (content) => appendLinkLine(content, link));
		});
	}

	/** Move a note to the archive folder and mark it archived. */
	async archive(file: TFile): Promise<string> {
		const archiveFolder = this.getSettings().capture.archiveFolder.trim();
		return this.run(file, 'archive', async () => {
			if (archiveFolder.length > 0) await this.ensureFolder(archiveFolder);
			// Set the status first: if the move fails the note is still marked, which is
			// recoverable, whereas a moved-but-unmarked note is invisible in both views.
			await this.metadata.setStatus(file, 'archived');
			const desired = joinPath(archiveFolder, file.name);
			if (desired === file.path) return file.path;
			const destination = uniquePath(
				desired,
				(candidate) => this.app.vault.getAbstractFileByPath(candidate) !== null,
			);
			await this.app.fileManager.renameFile(file, destination);
			return destination;
		});
	}

	/**
	 * Move a note to the trash.
	 *
	 * Deletion always goes through `vault.trash` (addendum 6.5) so the user can recover it;
	 * the UI must have confirmed before calling this.
	 */
	async trash(file: TFile): Promise<void> {
		await this.run(file, 'trash', async () => {
			// Routed through FileManager so Obsidian's "Deleted files" setting decides
			// between system trash, vault trash, or permanent deletion.
			await this.app.fileManager.trashFile(file);
		});
	}

	/* ----------------------------------------------------------- internals -- */

	private async ensureFolder(folderPath: string): Promise<void> {
		const existing = this.app.vault.getAbstractFileByPath(folderPath);
		if (existing instanceof TFolder) return;
		if (existing) {
			throw new InboxActionError(`"${folderPath}" exists but is a file, not a folder.`);
		}
		if (!this.getSettings().capture.autoCreateFolders) {
			throw new InboxActionError(STRINGS.errors.folderNotFound(folderPath));
		}
		try {
			await this.app.vault.createFolder(folderPath);
		} catch (error) {
			if (!(this.app.vault.getAbstractFileByPath(folderPath) instanceof TFolder)) {
				throw new InboxActionError(
					`${STRINGS.errors.folderNotFound(folderPath)} ${errorMessage(error)}`,
				);
			}
		}
	}

	/** Shared error handling so every action logs in detail and throws one error type. */
	private async run<T>(file: TFile, label: string, body: () => Promise<T>): Promise<T> {
		try {
			return await body();
		} catch (error) {
			this.logger.error(`Inbox action "${label}" failed for "${file.path}"`, error);
			throw new InboxActionError(`${STRINGS.inbox.actionFailed}: ${errorMessage(error)}`);
		}
	}
}

/**
 * Rewrite the title line of a note as a task item.
 *
 * Exported for direct unit testing — the interesting cases are all textual.
 */
export function addTaskPrefix(content: string, fallbackTitle: string): string {
	const match = /^(---\r?\n[\s\S]*?\r?\n---\r?\n)?([\s\S]*)$/.exec(content);
	const frontmatter = match?.[1] ?? '';
	const body = match?.[2] ?? '';

	const lines = body.split('\n');
	const firstContentIndex = lines.findIndex((line) => line.trim().length > 0);

	if (firstContentIndex === -1) {
		// Nothing but whitespace: build the task from the file name.
		const separator = body.length > 0 && !body.startsWith('\n') ? '\n' : '';
		return `${frontmatter}${separator}- [ ] ${fallbackTitle}\n`;
	}

	const line = lines[firstContentIndex] ?? '';
	if (/^\s*[-*+]\s+\[[ xX]\]/.test(line)) return content; // already a task

	const heading = /^(\s*)#{1,6}\s+(.*)$/.exec(line);
	lines[firstContentIndex] = heading
		? `${heading[1] ?? ''}- [ ] ${(heading[2] ?? '').trim()}`
		: line.replace(/^(\s*)/, '$1- [ ] ');

	return frontmatter + lines.join('\n');
}

/** Append a link on its own line, keeping exactly one trailing newline. */
export function appendLinkLine(content: string, link: string): string {
	const trimmed = content.replace(/\s+$/, '');
	return trimmed.length === 0 ? `${link}\n` : `${trimmed}\n\n${link}\n`;
}
