/**
 * Note-level types.
 *
 * The frontmatter contract (addendum section 5.4) treats `type` and `status` as open sets:
 * the values below are the ones the plugin understands, but user defined values are valid
 * everywhere and must never be discarded.
 */

/** Note types the plugin recognises. Custom values are allowed. */
export const KNOWN_NOTE_TYPES = [
	'capture',
	'idea',
	'task',
	'reference',
	'meeting',
	'project',
	'note',
	'daily',
	'template',
] as const;

/** The subset of {@link KNOWN_NOTE_TYPES} offered by the Quick Capture type dropdown. */
export const CAPTURE_NOTE_TYPES = ['capture', 'idea', 'task', 'reference', 'meeting'] as const;

/** Note statuses the plugin recognises. Custom values are allowed. */
export const KNOWN_NOTE_STATUSES = ['inbox', 'processed', 'archived'] as const;

/** A note type. Open set — any string is valid. */
export type NoteType = string;

/** A note status. Open set — any string is valid. */
export type NoteStatus = string;

/** A single outgoing link parsed out of a note. */
export interface LinkRef {
	/** Raw link target exactly as written, without the surrounding brackets. */
	readonly target: string;
	/** Display text when the link used an alias, otherwise null. */
	readonly displayText: string | null;
	/** Vault-relative path of the file this link resolves to, or null when unresolved. */
	readonly resolvedPath: string | null;
	/** True for embeds (`![[...]]` or `![](...)`). */
	readonly isEmbed: boolean;
	/** True when written as a markdown link rather than a wikilink. */
	readonly isMarkdownLink: boolean;
	/** Zero-based line the link starts on. */
	readonly line: number;
	/** Zero-based column the link starts at. */
	readonly col: number;
	/** Full matched text, used to perform precise replacements. */
	readonly raw: string;
}

/**
 * Everything the plugin knows about one file in the vault.
 *
 * Records are rebuilt incrementally as files change, and never hold note content — only
 * metadata and derived counts, so a serialized index stays small and privacy safe.
 */
export interface NoteRecord {
	/** Vault-relative path including extension. */
	readonly path: string;
	/** File name without the extension. */
	readonly basename: string;
	/** Lower-cased extension without the dot. */
	readonly extension: string;
	/** Parent folder path, or '' for vault root. */
	readonly folder: string;
	/** Creation time in epoch milliseconds (frontmatter `created` wins over file ctime). */
	readonly created: number;
	/** Modification time in epoch milliseconds (frontmatter `modified` wins over file mtime). */
	readonly modified: number;
	/** File modification time in epoch milliseconds, straight from the file stat. */
	readonly fileModified: number;
	/** File size in bytes. */
	readonly size: number;
	/** Parsed frontmatter, or null when absent or unparseable. */
	readonly frontmatter: Record<string, unknown> | null;
	/** True when the file opens with a `---` block. */
	readonly hasFrontmatterBlock: boolean;
	/** False when a frontmatter block exists but could not be parsed. */
	readonly frontmatterValid: boolean;
	/** Normalised `type` frontmatter value. */
	readonly type: NoteType | null;
	/** Normalised `status` frontmatter value. */
	readonly status: NoteStatus | null;
	/** Normalised `source` frontmatter value. */
	readonly source: string | null;
	/** All tags, frontmatter and inline, without the leading `#`, lower-cased. */
	readonly tags: readonly string[];
	/** Every outgoing link, resolved or not. */
	readonly links: readonly LinkRef[];
	/** Paths this note links to that exist. */
	readonly resolvedLinks: readonly string[];
	/** Link targets that do not resolve to any file. */
	readonly unresolvedLinks: readonly string[];
	/** Paths of notes that link to this note. */
	readonly backlinks: readonly string[];
	/** Heading texts in document order. */
	readonly headings: readonly string[];
	/** True when the file is not markdown. */
	readonly isAttachment: boolean;
}

/**
 * Content-derived counts.
 *
 * Kept out of {@link NoteRecord} because computing them requires reading every file, which
 * would blow the sub-500 ms load budget. The content index fills them in lazily and caches
 * the result against the file's mtime.
 */
export interface ContentStats {
	/** Character count of the trimmed body, frontmatter excluded. */
	readonly contentLength: number;
	/** Word count of the body, frontmatter excluded. */
	readonly wordCount: number;
	/** File size in bytes. */
	readonly size: number;
	/** mtime the stats were computed against, used for cache invalidation. */
	readonly mtime: number;
}

/** Fields available when generating a capture filename. */
export interface CaptureInput {
	title: string;
	body: string;
	tags: string[];
	type: NoteType;
	source: string;
	project: string | null;
}

/** Result of a successful capture. */
export interface CaptureResult {
	readonly path: string;
	readonly folder: string;
	readonly filename: string;
	readonly created: number;
}
