/**
 * Attachment inventory and archiving.
 *
 * Obsidian tracks backlinks for notes but offers nothing that answers "is this binary still
 * referenced?", which is exactly what the unused-attachment detector and the attachment
 * cleanup UI need. This service derives that answer from the vault index instead of reading
 * files, so a full inventory of a 10k-file vault costs one pass over already-parsed metadata
 * and no disk I/O.
 *
 * Reference counting deliberately walks *every* indexed file rather than the notes currently
 * in health-scan scope: a note the user excluded from scans is still a real reference, and
 * archiving or deleting the attachment it embeds would break that note.
 */

import { TFile, TFolder, type App } from 'obsidian';
import type { Logger } from '../core/logger';
import { STRINGS } from '../core/strings';
import type { NoteRecord } from '../types/note';
import { getFileName, joinPath, normalizeVaultPath, uniquePath } from '../utils/file';
import type { VaultIndex } from './vault-index';

/**
 * Raised when an attachment could not be moved into the archive folder.
 *
 * Typed so callers can distinguish "the move failed" from a programming error and show the
 * carried message verbatim, while the original cause stays available for the console.
 */
export class AttachmentArchiveError extends Error {
	constructor(
		message: string,
		/** Vault path of the attachment the operation was about. */
		readonly path: string,
		/** Whatever the vault threw, or null when the service refused before calling it. */
		readonly reason: unknown = null,
	) {
		super(message);
		this.name = 'AttachmentArchiveError';
	}
}

export class AttachmentService {
	constructor(
		private readonly app: App,
		private readonly index: VaultIndex,
		private readonly logger: Logger,
	) {}

	/**
	 * Every non-markdown file in the vault, in index order.
	 *
	 * Extension is not filtered against a known-attachment list: a `.zip` or `.docx` a user
	 * dropped into the vault is still a file that should be inventoried and archivable.
	 */
	all(): NoteRecord[] {
		return this.index.attachments();
	}

	/**
	 * Attachment path → sorted paths of the files referencing it.
	 *
	 * Every attachment gets an entry, including the ones nobody references (an empty array),
	 * so the result doubles as the complete inventory table the UI renders. Sources are
	 * de-duplicated, because a note that embeds the same image three times is still one note
	 * standing in the way of deleting it.
	 */
	usage(): Map<string, string[]> {
		const usage = new Map<string, string[]>();
		for (const attachment of this.all()) usage.set(attachment.path, []);

		for (const record of this.index.all()) {
			for (const target of record.resolvedLinks) {
				// A file never counts as using itself, and a link to a note is not usage.
				if (target === record.path) continue;
				const sources = usage.get(target);
				if (!sources || sources.includes(record.path)) continue;
				sources.push(record.path);
			}
		}

		for (const sources of usage.values()) sources.sort((a, b) => a.localeCompare(b));
		return usage;
	}

	/**
	 * Attachments no file references, sorted by path.
	 *
	 * Sorting here rather than at the call site keeps the health report, the preview modal,
	 * and the ignore-list ids stable across scans.
	 */
	unused(): NoteRecord[] {
		const usage = this.usage();
		return this.all()
			.filter((attachment) => (usage.get(attachment.path)?.length ?? 0) === 0)
			.sort((a, b) => a.path.localeCompare(b.path));
	}

	/**
	 * Whether any file links to or embeds `path`.
	 *
	 * Answers from the index directly instead of building the whole usage map, because the
	 * inbox and health UIs ask this one path at a time while rendering.
	 */
	isUsed(path: string): boolean {
		const target = normalizeVaultPath(path);
		if (target.length === 0) return false;
		for (const record of this.index.all()) {
			if (record.path === target) continue;
			if (record.resolvedLinks.includes(target)) return true;
		}
		return false;
	}

	/**
	 * Total bytes of the given records.
	 *
	 * Non-finite sizes are treated as zero: a file stat that failed must not turn the
	 * "reclaim 12 MB" figure shown to the user into `NaN`.
	 */
	totalSize(records: readonly NoteRecord[]): number {
		let total = 0;
		for (const record of records) {
			if (Number.isFinite(record.size)) total += record.size;
		}
		return total;
	}

	/**
	 * Move an attachment into the archive folder, creating that folder when it is missing.
	 *
	 * `fileManager.renameFile` is used rather than `vault.rename` so Obsidian rewrites every
	 * link pointing at the file; archiving must never break a note. The destination is passed
	 * through {@link uniquePath}, so archiving two same-named attachments from different
	 * folders keeps both.
	 *
	 * @param file The attachment to move.
	 * @param archiveFolder Destination folder, usually `settings.capture.attachmentArchiveFolder`.
	 * @returns The path the file now lives at.
	 * @throws {AttachmentArchiveError} when the folder cannot be created or the move fails.
	 */
	async archive(file: TFile, archiveFolder: string): Promise<string> {
		// The declared type says `string`, but the usual argument is
		// `settings.capture.attachmentArchiveFolder`, and settings are merged from persisted
		// JSON where any non-`undefined` value overrides the default. A hand-edited or
		// half-migrated `data.json` can therefore hand us `null`, and calling `.trim()` on it
		// would throw a bare TypeError past every caller's `catch (AttachmentArchiveError)`.
		const requested = typeof archiveFolder === 'string' ? archiveFolder : '';

		// A blank or whitespace-only folder would silently archive into the vault root, which
		// is never what the caller meant.
		const folder = normalizeVaultPath(requested.trim());
		if (folder.length === 0) {
			this.logger.error(`Refusing to archive "${file.path}" without a destination folder`);
			throw new AttachmentArchiveError(STRINGS.errors.folderNotFound(requested), file.path);
		}

		// The file may have been deleted or renamed between the preview and this call.
		if (!(this.app.vault.getAbstractFileByPath(file.path) instanceof TFile)) {
			this.logger.error(`Cannot archive "${file.path}" because it no longer exists`);
			throw new AttachmentArchiveError(STRINGS.errors.fileNotFound(file.path), file.path);
		}

		const desired = joinPath(folder, getFileName(file.path));
		if (desired === normalizeVaultPath(file.path)) {
			// Already archived. Renaming would resolve the collision with itself and leave a
			// pointless "image 2.png" behind.
			this.logger.debug(`"${file.path}" is already in "${folder}"`);
			return desired;
		}

		await this.ensureFolder(folder, file.path);

		const target = uniquePath(
			desired,
			(candidate) => this.app.vault.getAbstractFileByPath(candidate) !== null,
		);

		try {
			await this.app.fileManager.renameFile(file, target);
		} catch (error) {
			this.logger.error(`Could not move "${file.path}" to "${target}"`, error);
			throw new AttachmentArchiveError(STRINGS.errors.writeFailed(target), file.path, error);
		}

		this.logger.info(`Archived "${file.path}" to "${target}"`);
		return target;
	}

	/**
	 * Create `folder` unless it already exists.
	 *
	 * Obsidian throws when the folder was created between the check and the call — by another
	 * plugin, by sync, or by a second archive running concurrently — so that specific race is
	 * re-checked and treated as success rather than surfaced as a failure.
	 */
	private async ensureFolder(folder: string, sourcePath: string): Promise<void> {
		if (this.folderExists(folder)) return;
		try {
			await this.app.vault.createFolder(folder);
		} catch (error) {
			if (this.folderExists(folder)) {
				this.logger.debug(`Folder "${folder}" appeared while it was being created`);
				return;
			}
			this.logger.error(`Could not create the folder "${folder}"`, error);
			throw new AttachmentArchiveError(
				STRINGS.errors.folderNotFound(folder),
				sourcePath,
				error,
			);
		}
	}

	/**
	 * Whether a folder — not a file that happens to share the path — lives at `folder`.
	 *
	 * Checked through `getAbstractFileByPath` so the plugin keeps working on the Obsidian
	 * versions that predate `getFolderByPath`.
	 */
	private folderExists(folder: string): boolean {
		return this.app.vault.getAbstractFileByPath(folder) instanceof TFolder;
	}
}
