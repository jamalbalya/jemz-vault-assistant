/**
 * Link text surgery.
 *
 * Broken-link fixes and unlinked-mention conversion both rewrite the *exact* characters a
 * link occupies, so the risky part is not the edit but locating it. Obsidian reports a link
 * as a line/column pair captured when the file was last parsed; if the file changed since,
 * that pair points somewhere else entirely. Every function here therefore re-verifies that
 * the text at the recorded position still equals `LinkRef.raw` and refuses to write when it
 * does not — a skipped fix is recoverable, a corrupted note is not.
 *
 * The transformations are exported as pure string functions so the tricky offset and syntax
 * rules can be tested without a vault, and the async class methods are thin wrappers that
 * add reading, writing, and error typing on top.
 */

import type { App, TFile } from 'obsidian';
import type { LinkRef } from '../types/note';
import { STRINGS } from '../core/strings';
import type { Logger } from '../core/logger';
import { errorMessage } from '../core/logger';
import { formatDate } from '../utils/date';
import {
	ancestorFolders,
	getBasename,
	getFileName,
	getFolderPath,
	hasTraversalSegment,
	joinPath,
	normalizeVaultPath,
	uniquePath,
} from '../utils/file';
import { sanitizeFilename } from '../utils/string';

/** `type` written into notes created for a broken link. See {@link LinkService.createMissingNote}. */
const NEW_NOTE_TYPE = 'note';

/**
 * Characters that would terminate or confuse a `[text](target)` destination, for text taken
 * verbatim out of a note. `%` is deliberately absent: whatever escapes the file already
 * contains are the ones Obsidian read it with, so re-encoding them would change the target.
 */
const MARKDOWN_FRAGMENT_UNSAFE = /[ ()<>]/g;

/**
 * The same characters plus `%`, for a caller supplied vault path.
 *
 * A path is unencoded by definition, so a literal `%` has to become `%25` — otherwise
 * `100% Done.md` is written as `100%%20Done.md`, which is not decodable at all, and
 * `a%20b.md` silently resolves to a different file called `a b.md`.
 */
const MARKDOWN_PATH_UNSAFE = /[ ()<>%]/g;

/** Characters that cannot appear in a `[[...]]` target without ending or re-reading it. */
const WIKILINK_UNSAFE = /[[\]|]/;

/** Characters that cannot appear in a wikilink alias without ending the link. */
const WIKILINK_ALIAS_UNSAFE = /[[\]]/;

/** No link of any flavour survives a line break inside it. */
const LINE_BREAK = /[\r\n]/;

/**
 * A markdown link may carry a title after its destination: `[t](path "Title")`.
 * Matched only at the very end, so an unencoded space inside a path does not trigger it.
 */
const MARKDOWN_TITLE = /\s+("[^"]*"|'[^']*'|\([^()]*\))$/;

/** Matches a whole wikilink, embed marker included: `!`, `[[`, body, `]]`. */
const WIKILINK_RAW = /^(!?)\[\[([\s\S]*)\]\]$/;

/** Matches a whole markdown link or embed: `!`, `[text]`, `(target)`. */
const MARKDOWN_LINK_RAW = /^(!?)\[([\s\S]*?)\]\(([\s\S]*)\)$/;

/**
 * Raised when an edit cannot be applied safely: the recorded offset no longer holds the
 * link, the recorded text is not a link at all, or the caller asked for a replacement that
 * would produce invalid syntax.
 *
 * Callers are expected to skip the change and rescan rather than retry blindly.
 */
export class LinkEditError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'LinkEditError';
	}
}

/** Raised when the vault itself refused a read, write, or create. */
export class LinkFileError extends Error {
	/** The underlying failure, kept for the developer console. */
	readonly cause: unknown;

	constructor(message: string, cause: unknown) {
		super(message);
		this.name = 'LinkFileError';
		this.cause = cause;
	}
}

/** The link is no longer where it was recorded, so the file changed under us. */
function staleLinkError(link: LinkRef): LinkEditError {
	return new LinkEditError(
		`${STRINGS.preview.skippedConflict} (${link.raw} at line ${link.line + 1})`,
	);
}

/** The requested edit could not produce valid link syntax. */
function malformedEditError(detail: string): LinkEditError {
	return new LinkEditError(`${STRINGS.errors.unexpected} (${detail})`);
}

/**
 * Convert a zero-based line/column pair into an absolute offset.
 *
 * Splitting on `\n` alone keeps any `\r` as the last character of its line, which is exactly
 * how Obsidian counts columns, so CRLF files need no special casing here.
 *
 * @returns The offset, or null when the position lies outside `content`.
 */
export function lineColToOffset(content: string, line: number, col: number): number | null {
	if (!Number.isInteger(line) || !Number.isInteger(col) || line < 0 || col < 0) return null;
	const lines = content.split('\n');
	const targetLine = lines[line];
	if (targetLine === undefined || col > targetLine.length) return null;

	let offset = 0;
	for (let index = 0; index < line; index++) {
		// +1 for the `\n` that `split` consumed.
		offset += (lines[index]?.length ?? 0) + 1;
	}
	return offset + col;
}

/**
 * Absolute offset of a link, proven to still hold its recorded text.
 *
 * An empty `raw` is rejected up front: every offset trivially "matches" the empty string, so
 * a malformed {@link LinkRef} would otherwise splice text into the middle of a word.
 *
 * @throws {LinkEditError} when the position is out of range or the text no longer matches.
 */
function verifiedOffset(content: string, link: LinkRef): number {
	if (link.raw.length === 0) throw staleLinkError(link);
	const offset = lineColToOffset(content, link.line, link.col);
	if (offset === null) throw staleLinkError(link);
	if (content.slice(offset, offset + link.raw.length) !== link.raw) throw staleLinkError(link);
	return offset;
}

/** Replace the recorded link span with `replacement`, leaving the rest of the file byte-identical. */
function spliceLink(content: string, link: LinkRef, replacement: string): string {
	const offset = verifiedOffset(content, link);
	return content.slice(0, offset) + replacement + content.slice(offset + link.raw.length);
}

/** The structural pieces of a link, recovered from its raw text. */
interface ParsedLinkSyntax {
	/** `!` for an embed, otherwise empty. */
	readonly bang: string;
	/** Target path without any subpath. */
	readonly path: string;
	/** `#heading` or `^block`, including the leading marker, or empty. */
	readonly subpath: string;
	/** Wikilink alias or markdown link text; null when the link has none. */
	readonly alias: string | null;
	/** Quoted markdown title including its delimiters, or empty. */
	readonly title: string;
	readonly isMarkdown: boolean;
}

/** Split `target` into its path and its `#`/`^` subpath. */
function splitSubpath(target: string): { path: string; subpath: string } {
	const marker = /[#^]/.exec(target);
	return marker === null
		? { path: target, subpath: '' }
		: { path: target.slice(0, marker.index), subpath: target.slice(marker.index) };
}

/** Target path of a link target expression, with any `#heading` / `^block` removed. */
function stripSubpath(target: string): string {
	return splitSubpath(target).path.trim();
}

/**
 * Recover a link's structure from its raw text rather than from {@link LinkRef}, because the
 * raw text is the only place the alias, the subpath, and the embed marker all survive.
 *
 * @returns The parsed pieces, or null when `raw` is not a link.
 */
function parseLinkSyntax(raw: string): ParsedLinkSyntax | null {
	const wikilink = WIKILINK_RAW.exec(raw);
	if (wikilink) {
		const bang = wikilink[1] ?? '';
		const body = wikilink[2] ?? '';
		const pipe = body.indexOf('|');
		const targetPart = pipe === -1 ? body : body.slice(0, pipe);
		const alias = pipe === -1 ? null : body.slice(pipe + 1);
		const { path, subpath } = splitSubpath(targetPart);
		return { bang, path, subpath, alias, title: '', isMarkdown: false };
	}

	const markdown = MARKDOWN_LINK_RAW.exec(raw);
	if (markdown) {
		const bang = markdown[1] ?? '';
		const text = markdown[2] ?? '';
		const inner = (markdown[3] ?? '').trim();
		// A trailing `"Title"` belongs to the link, not to the destination, and the user did
		// not ask for it to be thrown away.
		const titleMatch = MARKDOWN_TITLE.exec(inner);
		const title = titleMatch?.[1] ?? '';
		const withoutTitle = titleMatch ? inner.slice(0, titleMatch.index) : inner;
		// `[text](<a path>)` is valid markdown; the angle brackets are delimiters, not part
		// of the destination.
		const destination = withoutTitle.trim().replace(/^<([\s\S]*)>$/, '$1');
		const { path, subpath } = splitSubpath(destination);
		return { bang, path, subpath, alias: text, title, isMarkdown: true };
	}

	return null;
}

/**
 * Percent-encode every character `unsafe` matches.
 *
 * Obsidian writes markdown link targets this way, so an edited link keeps looking like one
 * the app itself produced.
 */
function percentEncode(value: string, unsafe: RegExp): string {
	return value.replace(
		unsafe,
		(char) => `%${char.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`,
	);
}

/** Encode a caller supplied vault path for a `(...)` destination. */
function encodeMarkdownPath(path: string): string {
	return percentEncode(path, MARKDOWN_PATH_UNSAFE);
}

/**
 * Encode a fragment lifted verbatim out of the note, such as the `#heading` subpath being
 * carried across a retarget. Existing escapes are left exactly as the file had them.
 */
function encodeMarkdownFragment(fragment: string): string {
	return percentEncode(fragment, MARKDOWN_FRAGMENT_UNSAFE);
}

/** The text a reader sees for a link: the alias when there is one, otherwise the target. */
function displayTextOf(link: LinkRef): string {
	const alias = link.displayText;
	if (alias !== null && alias.trim().length > 0) return alias;
	return link.target;
}

/**
 * Replace a link with the words it displayed.
 *
 * This is the "remove link, keep text" fix: the sentence has to keep reading naturally, so
 * the alias wins when present and the bare target is used otherwise. Embeds and markdown
 * links collapse the same way.
 *
 * @throws {LinkEditError} when the recorded position no longer holds `link.raw`.
 */
export function removeLinkKeepText(content: string, link: LinkRef): string {
	return spliceLink(content, link, displayTextOf(link));
}

/**
 * Point a link at a different note, changing nothing else.
 *
 * The alias, the `#heading` / `^block` subpath, the markdown title and the embed marker are
 * all preserved: the user asked to repair a destination, not to rewrite how the link reads.
 * A `newTarget` that carries its own subpath replaces the recorded one rather than being
 * concatenated with it, since `[[New#B#A]]` addresses nothing.
 *
 * @throws {LinkEditError} when the position is stale, the raw text is not a link, or
 * `newTarget` is blank or holds characters that would end the link early.
 */
export function replaceLinkTarget(content: string, link: LinkRef, newTarget: string): string {
	const trimmedTarget = newTarget.trim();
	if (trimmedTarget.length === 0 || LINE_BREAK.test(trimmedTarget)) {
		throw malformedEditError(STRINGS.errors.fileNotFound(newTarget));
	}

	const parsed = parseLinkSyntax(link.raw);
	if (parsed === null) throw malformedEditError(link.raw);

	if (!parsed.isMarkdown && WIKILINK_UNSAFE.test(trimmedTarget)) {
		throw malformedEditError(STRINGS.errors.fileNotFound(newTarget));
	}

	// An explicit subpath on the replacement wins; otherwise the recorded one is carried over.
	const replacementSubpath = splitSubpath(trimmedTarget).subpath;

	if (!parsed.isMarkdown) {
		const subpath = replacementSubpath.length > 0 ? '' : parsed.subpath;
		const alias = parsed.alias === null ? '' : `|${parsed.alias}`;
		return spliceLink(content, link, `${parsed.bang}[[${trimmedTarget}${subpath}${alias}]]`);
	}

	const destination =
		encodeMarkdownPath(trimmedTarget) +
		(replacementSubpath.length > 0 ? '' : encodeMarkdownFragment(parsed.subpath));
	const title = parsed.title.length > 0 ? ` ${parsed.title}` : '';
	return spliceLink(
		content,
		link,
		`${parsed.bang}[${parsed.alias ?? ''}](${destination}${title})`,
	);
}

/**
 * Turn a plain-text span into a wikilink.
 *
 * Used by unlinked-mention conversion, where the matched words rarely match the note name
 * exactly (case, plural, punctuation). Whenever they differ the original words are kept as
 * an alias so the prose is untouched.
 *
 * @param start Inclusive start offset of the matched text.
 * @param end Exclusive end offset of the matched text.
 * @throws {LinkEditError} when the span is outside `content`, empty, spans a line break, or
 * either the span or `target` holds a bracket that would end the link early.
 */
export function wrapAsWikilink(
	content: string,
	start: number,
	end: number,
	target: string,
): string {
	const trimmedTarget = target.trim();
	if (trimmedTarget.length === 0 || WIKILINK_UNSAFE.test(trimmedTarget)) {
		throw malformedEditError(STRINGS.errors.fileNotFound(target));
	}
	if (
		!Number.isInteger(start) ||
		!Number.isInteger(end) ||
		start < 0 ||
		end <= start ||
		end > content.length
	) {
		throw malformedEditError(`${start}-${end}`);
	}

	const matched = content.slice(start, end);
	// The matched words become the alias verbatim, so a bracket in them would close the link
	// halfway through the sentence. A mention that looks like this is not one worth linking.
	if (WIKILINK_ALIAS_UNSAFE.test(matched) || LINE_BREAK.test(matched)) {
		throw malformedEditError(matched);
	}

	const replacement =
		matched === trimmedTarget ? `[[${trimmedTarget}]]` : `[[${trimmedTarget}|${matched}]]`;
	return content.slice(0, start) + replacement + content.slice(end);
}

/**
 * Append a link on its own final line.
 *
 * Trailing blank lines are collapsed first so repeated appends do not push the note apart,
 * and the file keeps exactly one trailing newline — the shape every markdown formatter and
 * git diff expects. The note's own last line ending is reused, so a CRLF note stays CRLF and
 * a mixed one is not converted wholesale to the ending that happens to appear first.
 *
 * @throws {LinkEditError} when `linkText` is blank or spans a line break.
 */
export function insertWikilinkAtEnd(content: string, linkText: string): string {
	const trimmedLink = linkText.trim();
	if (trimmedLink.length === 0 || LINE_BREAK.test(trimmedLink)) {
		throw malformedEditError(linkText);
	}

	const lastNewline = content.lastIndexOf('\n');
	const eol = lastNewline > 0 && content[lastNewline - 1] === '\r' ? '\r\n' : '\n';
	const body = content.replace(/(?:\r?\n)+$/, '');
	return body.length === 0 ? `${trimmedLink}${eol}` : `${body}${eol}${trimmedLink}${eol}`;
}

/**
 * Reads, edits, and writes links.
 *
 * Dependencies are injected so tests can drive the service against the in-memory vault, and
 * `now` is injectable because created notes stamp a `created` date.
 */
export class LinkService {
	constructor(
		private readonly app: App,
		private readonly logger: Logger,
		private readonly now: () => number = () => Date.now(),
	) {}

	/**
	 * Replace a link with its display text.
	 *
	 * @returns The file's new content.
	 * @throws {LinkEditError} when the file changed since the link was recorded.
	 * @throws {LinkFileError} when the file could not be read or written.
	 */
	async removeLink(file: TFile, link: LinkRef): Promise<string> {
		return this.rewrite(file, (content) => removeLinkKeepText(content, link));
	}

	/**
	 * Point a link at `newTarget`, keeping its alias and embed marker.
	 *
	 * @returns The file's new content.
	 * @throws {LinkEditError} when the file changed since the link was recorded.
	 * @throws {LinkFileError} when the file could not be read or written.
	 */
	async retargetLink(file: TFile, link: LinkRef, newTarget: string): Promise<string> {
		return this.rewrite(file, (content) => replaceLinkTarget(content, link, newTarget));
	}

	/**
	 * Append a link to `targetFile` at the end of `file`.
	 *
	 * @returns The file's new content.
	 * @throws {LinkFileError} when the file could not be read or written.
	 */
	async appendLink(file: TFile, targetFile: TFile): Promise<string> {
		const linkText = this.generateLink(targetFile, file.path);
		return this.rewrite(file, (content) => insertWikilinkAtEnd(content, linkText));
	}

	/**
	 * Create the note a broken link points at.
	 *
	 * The link target decides the name, so the fix actually repairs the link: a target that
	 * carries its own folder (`Projects/Roadmap`) is vault-root relative, because that is how
	 * Obsidian resolves it, and only a bare name lands in `folder`. Any subpath is dropped
	 * and the name is sanitised, since a link may legally contain characters a file may not.
	 *
	 * An existing file is never overwritten; the path is made unique instead.
	 *
	 * @param target Raw link target, e.g. `Missing Note#Section`.
	 * @param folder Folder for targets that do not name one themselves.
	 * @throws {LinkFileError} when the note or its folders could not be created.
	 */
	async createMissingNote(target: string, folder: string): Promise<TFile> {
		const path = this.plannedNotePath(target, folder);
		try {
			await this.ensureFolders(path);
			const file = await this.app.vault.create(path, this.newNoteContent(getBasename(path)));
			this.logger.info(`Created "${path}" for broken link "${target}"`);
			return file;
		} catch (error) {
			this.logger.error(`Could not create "${path}"`, error);
			throw new LinkFileError(
				`${STRINGS.errors.writeFailed(path)} — ${errorMessage(error)}`,
				error,
			);
		}
	}

	/**
	 * Resolve a link target the way Obsidian's own link resolution does.
	 *
	 * @returns The destination file, or null when nothing matches.
	 */
	resolve(target: string, sourcePath: string): TFile | null {
		const linkpath = stripSubpath(target);
		if (linkpath.length === 0) return null;
		return this.app.metadataCache.getFirstLinkpathDest(linkpath, sourcePath);
	}

	/**
	 * Build link text for `file` as written from `sourcePath`.
	 *
	 * Delegated to Obsidian so the result honours the user's wikilink/markdown and
	 * relative/absolute preferences instead of hardcoding one style.
	 */
	generateLink(file: TFile, sourcePath: string, alias?: string): string {
		return this.app.fileManager.generateMarkdownLink(file, sourcePath, undefined, alias);
	}

	/* -------------------------------------------------------------- internals -- */

	/**
	 * Read, transform, write.
	 *
	 * A transform that returns the content unchanged skips the write entirely: touching the
	 * file would bump its mtime and make every conflict check downstream think a human edited
	 * it.
	 */
	private async rewrite(file: TFile, transform: (content: string) => string): Promise<string> {
		let content: string;
		try {
			content = await this.app.vault.read(file);
		} catch (error) {
			this.logger.error(`Could not read "${file.path}"`, error);
			throw new LinkFileError(
				`${STRINGS.errors.readFailed(file.path)} — ${errorMessage(error)}`,
				error,
			);
		}

		let next: string;
		try {
			next = transform(content);
		} catch (error) {
			this.logger.warn(`Refused to edit "${file.path}"`, error);
			throw error;
		}
		if (next === content) return content;

		try {
			await this.app.vault.modify(file, next);
		} catch (error) {
			this.logger.error(`Could not write "${file.path}"`, error);
			throw new LinkFileError(
				`${STRINGS.errors.writeFailed(file.path)} — ${errorMessage(error)}`,
				error,
			);
		}
		return next;
	}

	/**
	 * Where a note for `target` should live, guaranteed not to collide with an existing file.
	 *
	 * Public because the fix planner has to name the same path in its preview that
	 * {@link createMissingNote} will go on to use. Deriving it twice from the same target is
	 * what keeps "will create X" and "created X" the same file.
	 */
	plannedNotePath(target: string, folder: string): string {
		const linkpath = stripSubpath(target);
		const ownFolder = getFolderPath(linkpath);
		// A link target is note text and may say anything, `../../elsewhere` included. Vault
		// paths never climb, and `normalizeVaultPath` only tidies slashes, so an unchecked
		// `..` would put the new note outside the vault. Such a target keeps its name and
		// falls back to `folder`, which is where a bare name goes anyway.
		const parent =
			ownFolder.length > 0 && !hasTraversalSegment(ownFolder)
				? ownFolder
				: normalizeVaultPath(folder);

		const name = getFileName(linkpath);
		// `[[Note.md]]` and `[[Note]]` mean the same file, so only a markdown extension is
		// dropped; `[[diagram.png]]` becomes `diagram.png.md`, which is what that link
		// resolves to once the note exists.
		const base = /\.md$/i.test(name) ? name.slice(0, -3) : name;
		const safeName = sanitizeFilename(base, STRINGS.capture.untitledPrefix);
		const desired = joinPath(parent, `${safeName}.md`);

		return uniquePath(
			desired,
			(candidate) => this.app.vault.getAbstractFileByPath(candidate) !== null,
		);
	}

	/**
	 * Create every missing ancestor folder of `filePath`, outermost first.
	 *
	 * A folder appearing between the check and the create (another plugin, a sync client) is
	 * treated as success — the goal is that the folder exists, not that we made it.
	 */
	private async ensureFolders(filePath: string): Promise<void> {
		for (const folder of ancestorFolders(filePath)) {
			if (this.app.vault.getAbstractFileByPath(folder) !== null) continue;
			try {
				await this.app.vault.createFolder(folder);
			} catch (error) {
				if (this.app.vault.getAbstractFileByPath(folder) === null) throw error;
				this.logger.debug(`Folder "${folder}" appeared while creating it`, error);
			}
		}
	}

	/**
	 * Body for a note created from a broken link.
	 *
	 * The `created` and `type` properties are the plugin's default required fields, so a note
	 * born from a health fix does not immediately register as a new missing-metadata issue.
	 */
	private newNoteContent(title: string): string {
		const created = formatDate(this.now(), 'YYYY-MM-DD');
		return `---\ncreated: ${created}\ntype: ${NEW_NOTE_TYPE}\n---\n\n# ${title}\n`;
	}
}
