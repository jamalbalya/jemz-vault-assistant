/**
 * Frontmatter reads and writes (main spec 5.4, the frontmatter contract).
 *
 * Two rules shape the whole module:
 *  - reads come from `metadataCache`, never from re-parsing a file, so this service can never
 *    disagree with what Obsidian itself believes a note's properties are;
 *  - writes go through `FileManager.processFrontMatter`, which edits the YAML block in place
 *    and leaves the body, the key order, and the user's formatting alone. Rewriting a whole
 *    file just to change one property is the data loss the contract exists to prevent.
 *
 * The two rules collide on a note whose block exists but failed to parse. Obsidian reports no
 * frontmatter for such a file, so `processFrontMatter` would cheerfully replace the broken
 * YAML with a freshly serialized block and destroy whatever the user was halfway through
 * typing. Every write therefore refuses to touch that note and raises
 * {@link MetadataWriteError} instead — a YAML repair is a manual edit, not an automatic one.
 */

import type { App, TFile } from 'obsidian';
import type { NoteRecord, NoteStatus, NoteType } from '../types/note';
import type { Logger } from '../core/logger';
import { STRINGS } from '../core/strings';
import { normalizeTag, splitFrontmatter } from '../utils/string';

/** Frontmatter key holding the tag list. */
const TAGS_KEY = 'tags';

/** Frontmatter key holding the note status. */
const STATUS_KEY = 'status';

/** Frontmatter key holding the note type. */
const TYPE_KEY = 'type';

/**
 * The fence line of a YAML block.
 *
 * An empty block is written verbatim rather than through `processFrontMatter`, because
 * serializing an empty mapping produces a literal `{}` inside the fences in some Obsidian
 * builds and nothing at all in others — neither is the empty block the caller asked for.
 */
const FENCE = '---';

/**
 * The line ending a document already uses.
 *
 * A note written on Windows is CRLF throughout; prepending an LF-only block would leave it
 * with mixed endings, which shows up as stray characters in diffs and in editors that honour
 * the file's existing convention.
 */
function dominantNewline(content: string): string {
	const index = content.indexOf('\n');
	return index > 0 && content[index - 1] === '\r' ? '\r\n' : '\n';
}

/** Whether a value is a plain YAML mapping, as opposed to a class instance or a Date. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value) as unknown;
	return prototype === Object.prototype || prototype === null;
}

/**
 * Copy a frontmatter value away from the metadata cache.
 *
 * Only the containers YAML produces — sequences and mappings — are rebuilt; scalars are
 * immutable and anything exotic is handed back as-is rather than being mangled by a generic
 * clone. Without this, `readFrontmatter(file).tags.push(...)` would edit the array Obsidian
 * itself is holding, and every later reader would see the injected entry.
 */
function copyValue(value: unknown): unknown {
	if (Array.isArray(value)) return (value as readonly unknown[]).map(copyValue);
	if (isPlainObject(value)) {
		const copy: Record<string, unknown> = {};
		for (const [key, nested] of Object.entries(value)) copy[key] = copyValue(nested);
		return copy;
	}
	return value;
}

/**
 * Raised when frontmatter could not be read or written.
 *
 * Carries the vault path so a caller can name the offending file in a Notice without having
 * to thread the path through its own call stack alongside the error.
 */
export class MetadataWriteError extends Error {
	constructor(
		readonly path: string,
		message: string,
	) {
		super(message);
		this.name = 'MetadataWriteError';
	}
}

/**
 * Text of one tag list entry.
 *
 * Frontmatter is user-authored, so an entry may be a number (`tags: [2026]`) or a boolean
 * after YAML coercion. Anything without a sensible text form compares as empty and therefore
 * never matches a real tag.
 */
function tagText(value: unknown): string {
	if (typeof value === 'string') return value;
	if (typeof value === 'number' || typeof value === 'boolean') return String(value);
	return '';
}

/**
 * Read the `tags` value as a list.
 *
 * Obsidian accepts `tags: work`, `tags: work, ideas`, and a block sequence, so all three have
 * to round-trip. Entries are returned exactly as written — normalising them here would
 * silently rewrite tags the caller never asked to touch.
 */
function toTagList(value: unknown): unknown[] {
	if (Array.isArray(value)) return [...(value as readonly unknown[])];
	if (typeof value === 'string') {
		return value
			.split(/[,\s]+/)
			.map((part) => part.trim())
			.filter((part) => part.length > 0);
	}
	if (typeof value === 'number' || typeof value === 'boolean') return [String(value)];
	return [];
}

/**
 * Whether a frontmatter value counts as "not filled in".
 *
 * `false` and `0` are deliberately present values: a note with `draft: false` has answered
 * the question, so a required-field check must not nag about it.
 */
function isBlankValue(value: unknown): boolean {
	if (value === null || value === undefined) return true;
	if (typeof value === 'string') return value.trim().length === 0;
	if (Array.isArray(value)) return value.length === 0;
	return false;
}

export class MetadataService {
	/**
	 * @param app Obsidian app — the single source of truth for both the cache and the writer.
	 * @param logger Injected so every failure is diagnosable in the console while the user
	 *   only ever sees the short message carried by {@link MetadataWriteError}.
	 */
	constructor(
		private readonly app: App,
		private readonly logger: Logger,
	) {}

	/* ----------------------------------------------------------------- reads -- */

	/**
	 * Parsed frontmatter for a note.
	 *
	 * Comes straight from Obsidian's metadata cache: re-parsing the file here would be slower
	 * and could disagree with the cache, which is what every other part of the plugin reads.
	 *
	 * @returns A copy, so a caller cannot corrupt Obsidian's own cache entry — neither by
	 *   assigning to a key nor by pushing onto a list it holds. Returns null when the note has
	 *   no frontmatter or when its block failed to parse — the two are indistinguishable
	 *   through the cache alone.
	 */
	readFrontmatter(file: TFile): Record<string, unknown> | null {
		const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
		if (!frontmatter) return null;
		return copyValue(frontmatter) as Record<string, unknown>;
	}

	/**
	 * Which of `required` are not filled in on a note.
	 *
	 * A field is missing when it is absent, null, an empty (or whitespace-only) string, or an
	 * empty array — all four mean the same thing to a human looking at the properties panel.
	 * Duplicates in `required` are reported once so a mis-typed setting cannot inflate the
	 * health score penalty.
	 *
	 * @param record Indexed note. A null `frontmatter` means every required field is missing.
	 * @param required Frontmatter keys the vault expects. Blank entries are ignored.
	 * @returns The missing keys, in the order they were requested.
	 */
	missingRequiredFields(record: NoteRecord, required: readonly string[]): string[] {
		const missing: string[] = [];
		const seen = new Set<string>();
		for (const field of required) {
			const key = field.trim();
			if (key.length === 0 || seen.has(key)) continue;
			seen.add(key);
			if (record.frontmatter === null || isBlankValue(record.frontmatter[key])) {
				missing.push(key);
			}
		}
		return missing;
	}

	/* ---------------------------------------------------------------- writes -- */

	/**
	 * Edit a note's frontmatter in place.
	 *
	 * The mutator receives the current properties and mutates them; everything it leaves alone
	 * — including keys this plugin knows nothing about and the entire body — survives byte for
	 * byte, because `processFrontMatter` patches the YAML block rather than rewriting the file.
	 *
	 * @throws {MetadataWriteError} when the note's block exists but could not be parsed (the
	 *   write would destroy the broken YAML), when the file cannot be read, or when the vault
	 *   refuses the write.
	 */
	async updateFrontmatter(
		file: TFile,
		mutator: (frontmatter: Record<string, unknown>) => void,
	): Promise<void> {
		await this.assertFrontmatterWritable(file);
		await this.writeFrontmatter(file, mutator);
	}

	/**
	 * Set `status`, the open-set value the inbox and archive views filter on.
	 *
	 * An empty value removes the key rather than writing `status: ""`, which would read as
	 * "filled in" to every consumer while telling them nothing.
	 */
	async setStatus(file: TFile, status: NoteStatus): Promise<void> {
		await this.setScalar(file, STATUS_KEY, status);
	}

	/** Set `type`, the open-set value the type icons and filters read. See {@link setStatus}. */
	async setType(file: TFile, type: NoteType): Promise<void> {
		await this.setScalar(file, TYPE_KEY, type);
	}

	/**
	 * Merge properties into a note's frontmatter.
	 *
	 * Keys not mentioned are left alone; a key whose value is `undefined` is removed, which is
	 * the only way to express "delete this property" through a plain object literal. An empty
	 * `props` writes nothing at all — the note is never even read, so a no-op caller neither
	 * bumps the file's mtime nor raises corruption it did not ask about.
	 */
	async setProperties(file: TFile, props: Record<string, unknown>): Promise<void> {
		const entries = Object.entries(props);
		if (entries.length === 0) return;
		await this.updateFrontmatter(file, (frontmatter) => {
			for (const [key, value] of entries) {
				if (value === undefined) delete frontmatter[key];
				else frontmatter[key] = value;
			}
		});
	}

	/**
	 * Add a tag to the frontmatter `tags` list.
	 *
	 * The tag is normalised (`#Work` and ` work ` are the same tag), and a tag already present
	 * under any casing is left exactly as the user wrote it — re-casing someone's `Work` into
	 * `work` is an edit they did not ask for. Adding an existing tag writes nothing.
	 *
	 * A blank tag asks for nothing, so it returns without reading the note at all — including
	 * on a corrupted one, which has no bearing on a request that was never going to write.
	 *
	 * @throws {MetadataWriteError} on an unwritable note, exactly as {@link updateFrontmatter}.
	 */
	async addTag(file: TFile, tag: string): Promise<void> {
		const normalized = normalizeTag(tag);
		if (normalized.length === 0) return;
		await this.mutateTags(file, (existing) =>
			existing.some((entry) => normalizeTag(tagText(entry)) === normalized)
				? null
				: [...existing, normalized],
		);
	}

	/**
	 * Remove a tag from the frontmatter `tags` list.
	 *
	 * Matching is normalised, so `#Work` removes an entry written as `Work`. Removing the last
	 * tag leaves an empty list rather than deleting the key: the user declared the property,
	 * and dropping it is a bigger edit than the one that was requested.
	 *
	 * @throws {MetadataWriteError} on an unwritable note, exactly as {@link updateFrontmatter}.
	 */
	async removeTag(file: TFile, tag: string): Promise<void> {
		const normalized = normalizeTag(tag);
		if (normalized.length === 0) return;
		await this.mutateTags(file, (existing) => {
			const remaining = existing.filter(
				(entry) => normalizeTag(tagText(entry)) !== normalized,
			);
			return remaining.length === existing.length ? null : remaining;
		});
	}

	/**
	 * Give a note an empty frontmatter block when it has none.
	 *
	 * Used before bulk property edits so the properties panel has somewhere to put them. A
	 * note that already opens with a `---` fence is never touched, including one whose YAML is
	 * broken — repairing that is the user's call, not ours. The block is written with the line
	 * ending the note already uses, so a CRLF note does not come back mixed.
	 *
	 * @throws {MetadataWriteError} when the file cannot be read or written.
	 */
	async ensureFrontmatterBlock(file: TFile): Promise<void> {
		const content = await this.readContent(file);
		if (splitFrontmatter(content).hasBlock) return;
		const newline = dominantNewline(content);
		try {
			await this.app.vault.modify(file, `${FENCE}${newline}${FENCE}${newline}${content}`);
		} catch (error) {
			this.logger.error(`Could not add a frontmatter block to "${file.path}"`, error);
			throw new MetadataWriteError(file.path, STRINGS.errors.writeFailed(file.path));
		}
	}

	/* ------------------------------------------------------------- internals -- */

	/**
	 * Hand a mutator to `processFrontMatter`, translating any vault failure into a
	 * {@link MetadataWriteError}.
	 *
	 * Split out from {@link updateFrontmatter} so a caller that has already run the corruption
	 * guard does not run it — and re-read the file — a second time.
	 */
	private async writeFrontmatter(
		file: TFile,
		mutator: (frontmatter: Record<string, unknown>) => void,
	): Promise<void> {
		try {
			await this.app.fileManager.processFrontMatter(file, mutator);
		} catch (error) {
			this.logger.error(`Could not write frontmatter for "${file.path}"`, error);
			throw new MetadataWriteError(file.path, STRINGS.errors.writeFailed(file.path));
		}
	}

	/**
	 * Write one scalar property, deleting the key when the value is blank.
	 *
	 * Shared by {@link setStatus} and {@link setType} so both treat "clear this" identically.
	 */
	private async setScalar(file: TFile, key: string, value: string): Promise<void> {
		const trimmed = value.trim();
		await this.updateFrontmatter(file, (frontmatter) => {
			if (trimmed.length === 0) delete frontmatter[key];
			else frontmatter[key] = trimmed;
		});
	}

	/**
	 * Apply a pure transform to the tag list, writing only when it changes something.
	 *
	 * The transform runs twice: once against the cached list to decide whether a write is
	 * needed at all (so a no-op never bumps the mtime), and once inside the write against the
	 * values `processFrontMatter` actually hands over, which is what finally lands on disk.
	 *
	 * @param transform Returns the new list, or null when nothing needs to change.
	 */
	private async mutateTags(
		file: TFile,
		transform: (existing: unknown[]) => unknown[] | null,
	): Promise<void> {
		// Run the guard before the no-op check: asking to add a tag a corrupted note already
		// appears to carry must still report the corruption rather than quietly succeeding.
		await this.assertFrontmatterWritable(file);
		if (transform(toTagList(this.readFrontmatter(file)?.[TAGS_KEY])) === null) return;
		await this.writeFrontmatter(file, (frontmatter) => {
			const next = transform(toTagList(frontmatter[TAGS_KEY]));
			if (next !== null) frontmatter[TAGS_KEY] = next;
		});
	}

	/**
	 * Refuse to write to a note whose frontmatter block failed to parse.
	 *
	 * Obsidian reports no frontmatter both for a note that has none and for one whose YAML is
	 * broken. Only the raw text tells the two apart, so it is read — but only in the case that
	 * is actually ambiguous, keeping the common path cache-only.
	 *
	 * A block containing no YAML at all is the third case, and it is writable. It is the exact
	 * structure {@link ensureFrontmatterBlock} creates, and the cache reports nothing for it —
	 * both because an empty document has no mapping to report and because the cache is rebuilt
	 * asynchronously, so it still says "no frontmatter" immediately after the block was
	 * written. Treating that as corruption would make `ensureFrontmatterBlock` followed by a
	 * property write — the sequence bulk edits are built on — fail on a perfectly good note.
	 * There is nothing to destroy in an empty block, so `processFrontMatter` fills it in.
	 *
	 * @throws {MetadataWriteError} when the block exists and holds YAML that Obsidian could
	 *   not parse, when the opening fence is never closed, or when the file cannot be read.
	 */
	private async assertFrontmatterWritable(file: TFile): Promise<void> {
		if (this.app.metadataCache.getFileCache(file)?.frontmatter) return;
		const content = await this.readContent(file, true);
		const { hasBlock, raw } = splitFrontmatter(content);
		if (!hasBlock) return;
		// `raw` is null only when the opening fence is never closed; `processFrontMatter` would
		// insert a second block above the unterminated one and mangle the note.
		if (raw !== null && raw.trim().length === 0) return;

		const message = `${STRINGS.errors.writeFailed(file.path)}: ${
			STRINGS.health.typeDescriptions['corrupted-frontmatter']
		}`;
		this.logger.warn(`Refusing to rewrite corrupted frontmatter in "${file.path}"`);
		throw new MetadataWriteError(file.path, message);
	}

	/**
	 * Read a file's raw text.
	 *
	 * @param cached True for read-only inspection, where Obsidian's cached copy is both
	 *   correct and cheaper. False immediately before a write, which needs the current bytes.
	 * @throws {MetadataWriteError} when the file cannot be read — an unreadable file is never
	 *   treated as an empty one.
	 */
	private async readContent(file: TFile, cached = false): Promise<string> {
		try {
			return cached ? await this.app.vault.cachedRead(file) : await this.app.vault.read(file);
		} catch (error) {
			this.logger.error(`Could not read "${file.path}"`, error);
			throw new MetadataWriteError(file.path, STRINGS.errors.readFailed(file.path));
		}
	}
}
