/**
 * The in-memory index every other service reads from.
 *
 * Built entirely from `Vault` + `MetadataCache`, so a full build never touches the disk and
 * stays well inside the sub-500 ms load budget. File contents are handled separately by the
 * content index, which reads lazily.
 *
 * The index is maintained incrementally: `create`, `modify`, `delete` and `rename` each
 * update only the affected record plus the backlink entries that point at it.
 */

import { getAllTags, type App, type CachedMetadata, type TFile } from 'obsidian';
import type { LinkRef, NoteRecord } from '../types/note';
import { parseDateValue } from '../utils/date';
import {
	getBasename,
	getExtension,
	getFolderPath,
	isInAnyFolder,
	isMarkdownPath,
} from '../utils/file';
import { normalizeTag } from '../utils/string';
import type { Logger } from '../core/logger';

/** Frontmatter keys the index reads dates from. */
const CREATED_KEYS = ['created', 'created_at', 'date'] as const;
const MODIFIED_KEYS = ['modified', 'updated', 'last_modified'] as const;

function firstString(frontmatter: Record<string, unknown> | null, key: string): string | null {
	if (!frontmatter) return null;
	const value = frontmatter[key];
	if (typeof value === 'string') {
		const trimmed = value.trim();
		return trimmed.length === 0 ? null : trimmed;
	}
	if (typeof value === 'number' || typeof value === 'boolean') return String(value);
	return null;
}

function firstDate(
	frontmatter: Record<string, unknown> | null,
	keys: readonly string[],
): number | null {
	if (!frontmatter) return null;
	for (const key of keys) {
		const parsed = parseDateValue(frontmatter[key]);
		if (parsed !== null) return parsed;
	}
	return null;
}

export class VaultIndex {
	private readonly records = new Map<string, NoteRecord>();
	/** target path → set of note paths linking to it. */
	private readonly backlinks = new Map<string, Set<string>>();
	private built = false;

	constructor(
		private readonly app: App,
		private readonly logger: Logger,
	) {}

	/** Rebuild every record from scratch. */
	build(): void {
		this.records.clear();
		this.backlinks.clear();

		for (const file of this.app.vault.getFiles()) {
			const record = this.createRecord(file);
			this.records.set(record.path, record);
		}
		this.rebuildBacklinks();
		this.applyBacklinks();
		this.built = true;
		this.logger.debug(`Indexed ${this.records.size} files`);
	}

	/** Whether {@link build} has run. */
	get isBuilt(): boolean {
		return this.built;
	}

	/** Number of indexed files. */
	get size(): number {
		return this.records.size;
	}

	/* ----------------------------------------------------------- incremental -- */

	/** Add or refresh one file, then repair the backlinks it affects. */
	updateFile(file: TFile): void {
		const previous = this.records.get(file.path);
		const record = this.createRecord(file);
		this.records.set(record.path, record);

		const touched = new Set<string>();
		for (const target of previous?.resolvedLinks ?? []) touched.add(target);
		for (const target of record.resolvedLinks) touched.add(target);

		this.removeFromBacklinks(file.path);
		for (const target of record.resolvedLinks) {
			// A note linking to itself is not an edge, exactly as in the full rebuild. Letting
			// one through here would make a self-linked note count as linked-to until the next
			// full pass, which is the difference between the orphan detector reporting it and
			// silently skipping it depending on whether the file has been touched since load.
			if (target === file.path) continue;
			this.addBacklink(target, file.path);
		}
		this.refreshBacklinksFor([file.path, ...touched]);
	}

	/** Drop a file from the index. */
	removeFile(path: string): void {
		const record = this.records.get(path);
		this.records.delete(path);
		this.backlinks.delete(path);
		this.removeFromBacklinks(path);

		const touched = new Set<string>(record?.resolvedLinks ?? []);
		// Anything that linked to the removed file now has an unresolved link, so those
		// records need rebuilding from the (already updated) metadata cache.
		for (const source of this.sourcesLinkingTo(path)) touched.add(source);
		this.refreshBacklinksFor(Array.from(touched));
	}

	/** Handle a rename by dropping the old path and indexing the new one. */
	renameFile(file: TFile, oldPath: string): void {
		this.records.delete(oldPath);
		this.backlinks.delete(oldPath);
		this.removeFromBacklinks(oldPath);
		this.updateFile(file);
		// Notes that pointed at the old path now resolve elsewhere; refresh them all.
		this.refreshAllLinkSources();
	}

	/**
	 * Re-derive link and backlink data for every record.
	 *
	 * Obsidian resolves links lazily, so after a batch of changes the cheapest correct move
	 * is a link-only pass; it costs no disk I/O.
	 */
	refreshAllLinkSources(): void {
		for (const file of this.app.vault.getFiles()) {
			if (!this.records.has(file.path)) {
				this.records.set(file.path, this.createRecord(file));
			}
		}
		for (const path of Array.from(this.records.keys())) {
			if (!this.app.vault.getFileByPath(path)) this.records.delete(path);
		}
		for (const [path, record] of this.records) {
			const file = this.app.vault.getFileByPath(path);
			if (file) this.records.set(path, this.createRecord(file, record));
		}
		this.rebuildBacklinks();
		this.applyBacklinks();
	}

	/* ---------------------------------------------------------------- reads -- */

	/** One record, or undefined when the path is not indexed. */
	get(path: string): NoteRecord | undefined {
		return this.records.get(path);
	}

	/** Every record. */
	all(): NoteRecord[] {
		return Array.from(this.records.values());
	}

	/** Markdown notes only. */
	notes(): NoteRecord[] {
		return this.all().filter((record) => !record.isAttachment);
	}

	/** Non-markdown files only. */
	attachments(): NoteRecord[] {
		return this.all().filter((record) => record.isAttachment);
	}

	/** Notes inside a folder, including nested folders. */
	inFolder(folder: string): NoteRecord[] {
		return this.all().filter((record) => isInAnyFolder(record.path, [folder]));
	}

	/** Notes carrying a tag (comparison is case-insensitive, `#` optional). */
	withTag(tag: string): NoteRecord[] {
		const normalized = normalizeTag(tag);
		return this.notes().filter((record) => record.tags.includes(normalized));
	}

	/** Every tag in the vault with the number of notes carrying it. */
	tagCounts(): Map<string, number> {
		const counts = new Map<string, number>();
		for (const record of this.notes()) {
			for (const tag of record.tags) {
				counts.set(tag, (counts.get(tag) ?? 0) + 1);
			}
		}
		return counts;
	}

	/** Notes that link to a path. */
	backlinksOf(path: string): string[] {
		return Array.from(this.backlinks.get(path) ?? []);
	}

	/** Notes whose `type` frontmatter matches. */
	ofType(type: string): NoteRecord[] {
		const wanted = type.toLowerCase();
		return this.notes().filter((record) => record.type?.toLowerCase() === wanted);
	}

	/** Notes whose `status` frontmatter matches. */
	ofStatus(status: string): NoteRecord[] {
		const wanted = status.toLowerCase();
		return this.notes().filter((record) => record.status?.toLowerCase() === wanted);
	}

	/** Distinct folder paths that contain at least one file. */
	folders(): string[] {
		const set = new Set<string>();
		for (const record of this.all()) {
			if (record.folder.length > 0) set.add(record.folder);
		}
		return Array.from(set).sort();
	}

	/* -------------------------------------------------------------- internals -- */

	private createRecord(file: TFile, previous?: NoteRecord): NoteRecord {
		const isAttachment = !isMarkdownPath(file.path);
		const cache: CachedMetadata | null = isAttachment
			? null
			: this.app.metadataCache.getFileCache(file);
		const frontmatter = cache?.frontmatter ?? null;

		const links = isAttachment ? [] : this.extractLinks(file, cache);
		const resolvedLinks: string[] = [];
		const unresolvedLinks: string[] = [];
		for (const link of links) {
			if (link.resolvedPath !== null) {
				if (!resolvedLinks.includes(link.resolvedPath))
					resolvedLinks.push(link.resolvedPath);
			} else if (!unresolvedLinks.includes(link.target)) {
				unresolvedLinks.push(link.target);
			}
		}

		const tags =
			isAttachment || !cache
				? []
				: Array.from(new Set((getAllTags(cache) ?? []).map(normalizeTag))).filter(
						(tag) => tag.length > 0,
					);

		const createdFrontmatter = firstDate(frontmatter, CREATED_KEYS);
		const modifiedFrontmatter = firstDate(frontmatter, MODIFIED_KEYS);

		return {
			path: file.path,
			basename: getBasename(file.path),
			extension: getExtension(file.path),
			folder: getFolderPath(file.path),
			created: createdFrontmatter ?? file.stat.ctime,
			modified: modifiedFrontmatter ?? file.stat.mtime,
			fileModified: file.stat.mtime,
			size: file.stat.size,
			frontmatter,
			hasFrontmatterBlock: isAttachment ? false : this.hasFrontmatterBlock(file),
			frontmatterValid: frontmatter !== null,
			type: firstString(frontmatter, 'type'),
			status: firstString(frontmatter, 'status'),
			source: firstString(frontmatter, 'source'),
			tags,
			links,
			resolvedLinks,
			unresolvedLinks,
			// Backlinks are filled in by the backlink pass; keep any previous value so a
			// single-file refresh does not momentarily report zero.
			backlinks: previous?.backlinks ?? [],
			headings: (cache?.headings ?? []).map((heading) => heading.heading),
			isAttachment,
		};
	}

	/**
	 * Whether the file opens with a `---` fence.
	 *
	 * Obsidian only exposes `frontmatterPosition` when the YAML parsed, so a note with a
	 * malformed block reports no frontmatter at all. Distinguishing "no block" from "broken
	 * block" is what lets the missing-metadata detector skip files that need a YAML repair
	 * rather than added properties.
	 */
	private hasFrontmatterBlock(file: TFile): boolean {
		const cache = this.app.metadataCache.getFileCache(file);
		if (cache?.frontmatterPosition) return true;
		// No position means either no block, or a block that failed to parse. The sections
		// list is not available in every Obsidian build, so fall back to the raw check the
		// content index performs when it reads the file.
		return this.rawFrontmatterFlags.get(file.path) ?? false;
	}

	/**
	 * Paths known to start with a `---` fence, populated by the content index as it reads
	 * files. Absent entries simply mean "not read yet".
	 */
	private readonly rawFrontmatterFlags = new Map<string, boolean>();

	/** Called by the content index once it has seen a file's raw text. */
	noteFrontmatterBlock(path: string, hasBlock: boolean): void {
		const previous = this.rawFrontmatterFlags.get(path);
		this.rawFrontmatterFlags.set(path, hasBlock);
		if (previous === hasBlock) return;
		const record = this.records.get(path);
		if (record) {
			this.records.set(path, { ...record, hasFrontmatterBlock: hasBlock });
		}
	}

	private extractLinks(file: TFile, cache: CachedMetadata | null): LinkRef[] {
		if (!cache) return [];
		const result: LinkRef[] = [];
		const entries = [
			...(cache.links ?? []).map((link) => ({ link, isEmbed: false })),
			...(cache.embeds ?? []).map((link) => ({ link, isEmbed: true })),
		];

		for (const { link, isEmbed } of entries) {
			const target = link.link.split('#')[0]?.split('^')[0]?.trim() ?? link.link;
			if (target.length === 0) continue;
			const destination = this.app.metadataCache.getFirstLinkpathDest(target, file.path);
			result.push({
				target,
				displayText: link.displayText ?? null,
				resolvedPath: destination?.path ?? null,
				isEmbed,
				isMarkdownLink: link.original.includes(']('),
				line: link.position.start.line,
				col: link.position.start.col,
				raw: link.original,
			});
		}
		return result;
	}

	private rebuildBacklinks(): void {
		this.backlinks.clear();
		for (const record of this.records.values()) {
			for (const target of record.resolvedLinks) {
				if (target === record.path) continue;
				this.addBacklink(target, record.path);
			}
		}
	}

	private applyBacklinks(): void {
		for (const [path, record] of this.records) {
			this.records.set(path, {
				...record,
				backlinks: Array.from(this.backlinks.get(path) ?? []),
			});
		}
	}

	private addBacklink(target: string, source: string): void {
		let set = this.backlinks.get(target);
		if (!set) {
			set = new Set();
			this.backlinks.set(target, set);
		}
		set.add(source);
	}

	private removeFromBacklinks(source: string): void {
		for (const [target, sources] of this.backlinks) {
			if (sources.delete(source) && sources.size === 0) this.backlinks.delete(target);
		}
	}

	private sourcesLinkingTo(path: string): string[] {
		const result: string[] = [];
		for (const record of this.records.values()) {
			if (record.resolvedLinks.includes(path)) result.push(record.path);
		}
		return result;
	}

	/** Copy the current backlink sets onto the given records. */
	private refreshBacklinksFor(paths: readonly string[]): void {
		for (const path of new Set(paths)) {
			const record = this.records.get(path);
			if (!record) continue;
			this.records.set(path, {
				...record,
				backlinks: Array.from(this.backlinks.get(path) ?? []),
			});
		}
	}
}
