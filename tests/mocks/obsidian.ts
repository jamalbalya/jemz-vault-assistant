/**
 * In-memory implementation of the Obsidian API surface the plugin uses.
 *
 * Vitest aliases `obsidian` to this module, so services and views run unmodified against a
 * real in-memory vault. Link resolution follows the same precedence Obsidian uses — exact
 * path, then same folder, then shortest path, then alphabetical — because the fixture
 * deliberately contains two notes named `Project Alpha`.
 */

import {
	collectAllTags,
	parseMetadata,
	type CachedMetadata as ParsedCache,
} from './parse-metadata';

export type CachedMetadata = ParsedCache;
export type { LinkCache, EmbedCache, TagCache, HeadingCache, Pos, Loc } from './parse-metadata';

/* ------------------------------------------------------------------ events -- */

export interface EventRef {
	readonly id: number;
	readonly emitter: Events;
	readonly name: string;
	readonly callback: (...args: never[]) => unknown;
}

let nextEventId = 1;

export class Events {
	private readonly listeners = new Map<string, Set<EventRef>>();

	on(name: string, callback: (...args: never[]) => unknown): EventRef {
		const ref: EventRef = { id: nextEventId++, emitter: this, name, callback };
		let set = this.listeners.get(name);
		if (!set) {
			set = new Set();
			this.listeners.set(name, set);
		}
		set.add(ref);
		return ref;
	}

	off(name: string, callback: (...args: never[]) => unknown): void {
		const set = this.listeners.get(name);
		if (!set) return;
		for (const ref of set) if (ref.callback === callback) set.delete(ref);
	}

	offref(ref: EventRef): void {
		this.listeners.get(ref.name)?.delete(ref);
	}

	trigger(name: string, ...args: unknown[]): void {
		const set = this.listeners.get(name);
		if (!set) return;
		for (const ref of Array.from(set)) {
			(ref.callback as (...a: unknown[]) => unknown)(...args);
		}
	}

	/** Test helper: how many listeners are registered for an event. */
	listenerCount(name: string): number {
		return this.listeners.get(name)?.size ?? 0;
	}
}

/* ------------------------------------------------------------- file system -- */

export interface FileStats {
	ctime: number;
	mtime: number;
	size: number;
}

export abstract class TAbstractFile {
	vault!: Vault;
	path = '';
	name = '';
	parent: TFolder | null = null;
}

export class TFile extends TAbstractFile {
	basename = '';
	extension = '';
	stat: FileStats = { ctime: 0, mtime: 0, size: 0 };
}

export class TFolder extends TAbstractFile {
	children: TAbstractFile[] = [];

	isRoot(): boolean {
		return this.path === '/' || this.path === '';
	}
}

export function normalizePath(path: string): string {
	const normalized = path
		.replace(/\\/g, '/')
		.replace(/\/+/g, '/')
		.replace(/^\/+/, '')
		.replace(/\/+$/, '')
		.trim();
	return normalized.length === 0 ? '/' : normalized;
}

function splitPath(path: string): { folder: string; name: string } {
	const index = path.lastIndexOf('/');
	return index === -1
		? { folder: '', name: path }
		: { folder: path.slice(0, index), name: path.slice(index + 1) };
}

function splitName(name: string): { basename: string; extension: string } {
	const index = name.lastIndexOf('.');
	return index <= 0
		? { basename: name, extension: '' }
		: { basename: name.slice(0, index), extension: name.slice(index + 1) };
}

/**
 * Minimal `DataAdapter`.
 *
 * In real Obsidian the adapter is the filesystem for the whole vault *including* the hidden
 * `.obsidian` folder, so `adapter.read('Notes/x.md')` returns the same bytes as
 * `vault.read(file)`. The mock therefore reads and writes through the vault for any path
 * that is a vault file, and keeps its own store only for paths outside it (backups, the
 * serialized index). Without that, code which legitimately reaches for the adapter would
 * appear broken here and pass in production — or worse, the reverse.
 */
export class DataAdapter {
	private readonly files = new Map<string, string>();
	private readonly folders = new Set<string>();
	/** Test hook: when true every write rejects, simulating a read-only vault. */
	readOnly = false;
	/** Set by the owning Vault so adapter reads can see vault files. */
	private vault: Vault | null = null;

	/** @internal Wires the adapter to its vault. */
	attach(vault: Vault): void {
		this.vault = vault;
	}

	getName(): string {
		return 'mock-adapter';
	}

	async exists(path: string): Promise<boolean> {
		const normalized = normalizePath(path);
		if (this.vault?.peek(normalized) !== undefined) return true;
		if (this.vault?.getFolderByPath(normalized)) return true;
		return this.files.has(normalized) || this.folders.has(normalized);
	}

	async read(path: string): Promise<string> {
		const normalized = normalizePath(path);
		const fromVault = this.vault?.peek(normalized);
		if (fromVault !== undefined) return fromVault;
		const content = this.files.get(normalized);
		if (content === undefined) throw new Error(`ENOENT: ${path}`);
		return content;
	}

	async write(path: string, data: string): Promise<void> {
		if (this.readOnly) throw new Error('EROFS: read-only vault');
		const normalized = normalizePath(path);
		const existing = this.vault?.getFileByPath(normalized);
		if (existing && this.vault) {
			await this.vault.modify(existing, data);
			return;
		}
		this.files.set(normalized, data);
		const { folder } = splitPath(normalized);
		if (folder.length > 0) await this.mkdir(folder);
	}

	async mkdir(path: string): Promise<void> {
		if (this.readOnly) throw new Error('EROFS: read-only vault');
		const normalized = normalizePath(path);
		const parts = normalized.split('/');
		let current = '';
		for (const part of parts) {
			current = current.length === 0 ? part : `${current}/${part}`;
			this.folders.add(current);
		}
	}

	async remove(path: string): Promise<void> {
		if (this.readOnly) throw new Error('EROFS: read-only vault');
		const normalized = normalizePath(path);
		this.files.delete(normalized);
		// Deleting through the adapter must also remove a vault file, exactly as it does in
		// Obsidian where the adapter is the filesystem for the whole vault.
		const vaultFile = this.vault?.getFileByPath(normalized);
		if (vaultFile && this.vault) await this.vault.delete(vaultFile);
	}

	async rmdir(path: string, recursive: boolean): Promise<void> {
		if (this.readOnly) throw new Error('EROFS: read-only vault');
		const normalized = normalizePath(path);
		this.folders.delete(normalized);
		if (!recursive) return;

		for (const file of Array.from(this.files.keys())) {
			if (file.startsWith(`${normalized}/`)) this.files.delete(file);
		}
		for (const folder of Array.from(this.folders)) {
			if (folder.startsWith(`${normalized}/`)) this.folders.delete(folder);
		}
		if (this.vault) {
			for (const file of this.vault.getFiles()) {
				if (file.path.startsWith(`${normalized}/`)) await this.vault.delete(file);
			}
		}
	}

	async list(path: string): Promise<{ files: string[]; folders: string[] }> {
		const normalized = normalizePath(path);
		const prefix = normalized === '/' ? '' : `${normalized}/`;
		const files: string[] = [];
		const folders: string[] = [];
		for (const file of this.files.keys()) {
			if (file.startsWith(prefix) && !file.slice(prefix.length).includes('/')) {
				files.push(file);
			}
		}
		for (const folder of this.folders) {
			if (folder.startsWith(prefix) && !folder.slice(prefix.length).includes('/')) {
				folders.push(folder);
			}
		}
		return { files, folders };
	}

	async stat(path: string): Promise<{ type: 'file' | 'folder'; size: number } | null> {
		const normalized = normalizePath(path);
		const content = this.files.get(normalized);
		if (content !== undefined) return { type: 'file', size: content.length };
		if (this.folders.has(normalized)) return { type: 'folder', size: 0 };
		return null;
	}
}

/* -------------------------------------------------------------------- vault -- */

export interface DataWriteOptions {
	ctime?: number;
	mtime?: number;
}

export class Vault extends Events {
	adapter = new DataAdapter();
	/**
	 * Obsidian's config folder. Users can rename it, which is exactly why the plugin reads
	 * it from here rather than assuming `.obsidian`.
	 */
	configDir = '.obsidian';
	/** Test hook: reject every mutation, simulating a read-only vault. */
	readOnly = false;

	private readonly fileMap = new Map<string, TFile>();
	private readonly folderMap = new Map<string, TFolder>();
	private readonly contents = new Map<string, string>();
	private readonly root: TFolder;
	private clock = 1_700_000_000_000;

	constructor(private readonly name = 'test-vault') {
		super();
		this.adapter.attach(this);
		this.root = new TFolder();
		this.root.vault = this;
		this.root.path = '/';
		this.root.name = '';
		this.folderMap.set('/', this.root);
	}

	getName(): string {
		return this.name;
	}

	getRoot(): TFolder {
		return this.root;
	}

	/** Test helper: advance the clock used for ctime/mtime on the next write. */
	tick(ms = 1000): number {
		this.clock += ms;
		return this.clock;
	}

	private assertWritable(): void {
		if (this.readOnly || this.adapter.readOnly) throw new Error('EROFS: read-only vault');
	}

	private ensureFolder(path: string): TFolder {
		const normalized = path.length === 0 ? '/' : normalizePath(path);
		const existing = this.folderMap.get(normalized);
		if (existing) return existing;

		const { folder: parentPath, name } = splitPath(normalized);
		const parent = this.ensureFolder(parentPath);
		const folder = new TFolder();
		folder.vault = this;
		folder.path = normalized;
		folder.name = name;
		folder.parent = parent;
		parent.children.push(folder);
		this.folderMap.set(normalized, folder);
		return folder;
	}

	getAbstractFileByPath(path: string): TAbstractFile | null {
		const normalized = normalizePath(path);
		return this.fileMap.get(normalized) ?? this.folderMap.get(normalized) ?? null;
	}

	getFileByPath(path: string): TFile | null {
		return this.fileMap.get(normalizePath(path)) ?? null;
	}

	getFolderByPath(path: string): TFolder | null {
		return this.folderMap.get(normalizePath(path)) ?? null;
	}

	getFiles(): TFile[] {
		return Array.from(this.fileMap.values());
	}

	getMarkdownFiles(): TFile[] {
		return this.getFiles().filter((file) => file.extension === 'md');
	}

	getAllLoadedFiles(): TAbstractFile[] {
		return [...this.folderMap.values(), ...this.fileMap.values()];
	}

	getAllFolders(includeRoot = false): TFolder[] {
		return Array.from(this.folderMap.values()).filter(
			(folder) => includeRoot || !folder.isRoot(),
		);
	}

	async read(file: TFile): Promise<string> {
		const content = this.contents.get(file.path);
		if (content === undefined) throw new Error(`ENOENT: ${file.path}`);
		return content;
	}

	async cachedRead(file: TFile): Promise<string> {
		return this.read(file);
	}

	async createFolder(path: string): Promise<TFolder> {
		this.assertWritable();
		const normalized = normalizePath(path);
		if (this.folderMap.has(normalized)) throw new Error(`Folder already exists: ${path}`);
		const folder = this.ensureFolder(normalized);
		this.trigger('create', folder);
		return folder;
	}

	async create(path: string, data: string, options?: DataWriteOptions): Promise<TFile> {
		this.assertWritable();
		const normalized = normalizePath(path);
		if (this.fileMap.has(normalized)) throw new Error(`File already exists: ${path}`);

		const { folder: folderPath, name } = splitPath(normalized);
		const parent = this.ensureFolder(folderPath);
		const { basename, extension } = splitName(name);

		const file = new TFile();
		file.vault = this;
		file.path = normalized;
		file.name = name;
		file.basename = basename;
		file.extension = extension;
		const now = options?.ctime ?? this.tick();
		file.stat = {
			ctime: now,
			mtime: options?.mtime ?? now,
			size: data.length,
		};
		file.parent = parent;
		parent.children.push(file);

		this.fileMap.set(normalized, file);
		this.contents.set(normalized, data);
		this.trigger('create', file);
		return file;
	}

	async createBinary(path: string, data: ArrayBuffer): Promise<TFile> {
		return this.create(path, `binary:${data.byteLength}`);
	}

	async modify(file: TFile, data: string, options?: DataWriteOptions): Promise<void> {
		this.assertWritable();
		if (!this.fileMap.has(file.path)) throw new Error(`ENOENT: ${file.path}`);
		this.contents.set(file.path, data);
		file.stat = {
			...file.stat,
			mtime: options?.mtime ?? this.tick(),
			size: data.length,
		};
		this.trigger('modify', file);
	}

	async process(file: TFile, fn: (data: string) => string): Promise<string> {
		const current = await this.read(file);
		const next = fn(current);
		await this.modify(file, next);
		return next;
	}

	async append(file: TFile, data: string): Promise<void> {
		const current = await this.read(file);
		await this.modify(file, current + data);
	}

	async rename(file: TAbstractFile, newPath: string): Promise<void> {
		this.assertWritable();
		const normalized = normalizePath(newPath);
		const oldPath = file.path;

		if (file instanceof TFile) {
			if (this.fileMap.has(normalized)) throw new Error(`File already exists: ${newPath}`);
			const content = this.contents.get(oldPath) ?? '';
			this.fileMap.delete(oldPath);
			this.contents.delete(oldPath);
			file.parent?.children.remove(file);

			const { folder: folderPath, name } = splitPath(normalized);
			const parent = this.ensureFolder(folderPath);
			const { basename, extension } = splitName(name);
			file.path = normalized;
			file.name = name;
			file.basename = basename;
			file.extension = extension;
			file.parent = parent;
			parent.children.push(file);
			this.fileMap.set(normalized, file);
			this.contents.set(normalized, content);
			this.trigger('rename', file, oldPath);
			return;
		}

		throw new Error('Renaming folders is not supported by the mock');
	}

	async delete(file: TAbstractFile, _force = false): Promise<void> {
		this.assertWritable();
		this.removeFile(file);
		this.trigger('delete', file);
	}

	async trash(file: TAbstractFile, _system: boolean): Promise<void> {
		this.assertWritable();
		this.removeFile(file);
		this.trigger('delete', file);
	}

	private removeFile(file: TAbstractFile): void {
		if (file instanceof TFile) {
			this.fileMap.delete(file.path);
			this.contents.delete(file.path);
		} else {
			this.folderMap.delete(file.path);
		}
		file.parent?.children.remove(file);
	}

	/** Test helper: write a file without firing events, for fixture setup. */
	seed(path: string, data: string, stat?: Partial<FileStats>): TFile {
		const normalized = normalizePath(path);
		const { folder: folderPath, name } = splitPath(normalized);
		const parent = this.ensureFolder(folderPath);
		const { basename, extension } = splitName(name);
		const file = new TFile();
		file.vault = this;
		file.path = normalized;
		file.name = name;
		file.basename = basename;
		file.extension = extension;
		const now = this.tick(1);
		file.stat = {
			ctime: stat?.ctime ?? now,
			mtime: stat?.mtime ?? now,
			size: stat?.size ?? data.length,
		};
		file.parent = parent;
		parent.children.push(file);
		this.fileMap.set(normalized, file);
		this.contents.set(normalized, data);
		return file;
	}

	/** Test helper: raw content without going through the async API. */
	peek(path: string): string | undefined {
		return this.contents.get(normalizePath(path));
	}
}

/* ----------------------------------------------------------- metadata cache -- */

export class MetadataCache extends Events {
	resolvedLinks: Record<string, Record<string, number>> = {};
	unresolvedLinks: Record<string, Record<string, number>> = {};

	private readonly caches = new Map<string, CachedMetadata>();
	private dirty = true;
	/**
	 * Lookup from a bare link target to the files that could satisfy it.
	 *
	 * Real Obsidian keeps an equivalent map. Without one, resolving a link would scan every
	 * file in the vault, making a 10 000 note index build quadratic — which would have made
	 * the performance benchmarks measure this mock rather than the plugin.
	 */
	private nameIndex: Map<string, TFile[]> | null = null;

	constructor(private readonly vault: Vault) {
		super();
		vault.on('create', () => this.invalidate());
		vault.on('modify', (file: TFile) => this.invalidate(file.path));
		vault.on('delete', () => this.invalidate());
		vault.on('rename', () => this.invalidate());
	}

	private invalidate(path?: string): void {
		if (path) this.caches.delete(normalizePath(path));
		this.dirty = true;
		this.nameIndex = null;
	}

	/** Build (or reuse) the target-to-files lookup. */
	private names(): Map<string, TFile[]> {
		if (this.nameIndex) return this.nameIndex;
		const index = new Map<string, TFile[]>();
		const add = (key: string, file: TFile): void => {
			const list = index.get(key);
			if (list) list.push(file);
			else index.set(key, [file]);
		};
		for (const file of this.vault.getFiles()) {
			add(file.name, file);
			if (file.basename !== file.name) add(file.basename, file);
			add(file.path, file);
			if (file.extension === 'md') add(file.path.replace(/\.md$/, ''), file);
		}
		this.nameIndex = index;
		return index;
	}

	/** Rebuild every cache entry and the link tables. */
	rebuild(): void {
		this.caches.clear();
		for (const file of this.vault.getMarkdownFiles()) {
			const content = this.vault.peek(file.path) ?? '';
			this.caches.set(file.path, parseMetadata(content));
		}
		this.recomputeLinks();
		this.dirty = false;
		this.trigger('resolved');
	}

	private ensureFresh(): void {
		if (this.dirty) this.rebuild();
	}

	getFileCache(file: TFile): CachedMetadata | null {
		this.ensureFresh();
		return this.caches.get(file.path) ?? null;
	}

	getCache(path: string): CachedMetadata | null {
		this.ensureFresh();
		return this.caches.get(normalizePath(path)) ?? null;
	}

	/**
	 * Resolve a link target the way Obsidian does.
	 *
	 * Precedence: exact path (with or without `.md`), then a file in the same folder as the
	 * source, then the shortest path, then alphabetical order.
	 */
	getFirstLinkpathDest(linkpath: string, sourcePath: string): TFile | null {
		const target = linkpath.split('#')[0]?.split('^')[0]?.trim() ?? '';
		if (target.length === 0) return null;
		const normalized = normalizePath(target.replace(/^\.\//, ''));

		const exact =
			this.vault.getFileByPath(normalized) ?? this.vault.getFileByPath(`${normalized}.md`);
		if (exact) return exact;

		const candidates = this.names().get(normalized) ?? [];
		if (candidates.length === 0) return null;
		if (candidates.length === 1) return candidates[0] ?? null;

		const sourceFolder = splitPath(normalizePath(sourcePath)).folder;
		const sameFolder = candidates.filter(
			(file) => splitPath(file.path).folder === sourceFolder,
		);
		const pool = sameFolder.length > 0 ? sameFolder : candidates;
		return (
			pool
				.slice()
				.sort(
					(a, b) =>
						a.path.split('/').length - b.path.split('/').length ||
						a.path.localeCompare(b.path),
				)[0] ?? null
		);
	}

	fileToLinktext(file: TFile, _sourcePath: string, omitMdExtension = true): string {
		return omitMdExtension && file.extension === 'md' ? file.basename : file.name;
	}

	private recomputeLinks(): void {
		this.resolvedLinks = {};
		this.unresolvedLinks = {};

		for (const file of this.vault.getMarkdownFiles()) {
			const cache = this.caches.get(file.path);
			const resolved: Record<string, number> = {};
			const unresolved: Record<string, number> = {};

			for (const link of [...(cache?.links ?? []), ...(cache?.embeds ?? [])]) {
				const destination = this.getFirstLinkpathDest(link.link, file.path);
				if (destination) {
					resolved[destination.path] = (resolved[destination.path] ?? 0) + 1;
				} else {
					const key = link.link.split('#')[0]?.split('^')[0]?.trim() ?? link.link;
					if (key.length > 0) unresolved[key] = (unresolved[key] ?? 0) + 1;
				}
			}

			this.resolvedLinks[file.path] = resolved;
			this.unresolvedLinks[file.path] = unresolved;
		}
	}

	/** Test helper: force a rebuild before assertions. */
	refresh(): void {
		this.rebuild();
	}
}

export function getAllTags(cache: CachedMetadata | null): string[] | null {
	if (!cache) return null;
	return collectAllTags(cache);
}

export function getLinkpath(linktext: string): string {
	return linktext.split('#')[0]?.split('^')[0]?.trim() ?? linktext;
}

export function parseLinktext(linktext: string): { path: string; subpath: string } {
	const hashIndex = linktext.search(/[#^]/);
	return hashIndex === -1
		? { path: linktext, subpath: '' }
		: { path: linktext.slice(0, hashIndex), subpath: linktext.slice(hashIndex) };
}

/* -------------------------------------------------------------- file manager -- */

export class FileManager {
	constructor(
		private readonly vault: Vault,
		private readonly metadataCache: MetadataCache,
	) {}

	/**
	 * Edit frontmatter in place, preserving the body and any keys the callback leaves alone.
	 * Mirrors Obsidian's behaviour of creating the block when it is missing.
	 */
	async processFrontMatter(
		file: TFile,
		fn: (frontmatter: Record<string, unknown>) => void,
		_options?: DataWriteOptions,
	): Promise<void> {
		const content = await this.vault.read(file);
		const cache = this.metadataCache.getFileCache(file);
		const existing = cache?.frontmatter ? { ...cache.frontmatter } : {};

		fn(existing);

		const yaml = serializeFrontmatter(existing);
		const body = stripFrontmatterBlock(content);
		const next =
			Object.keys(existing).length === 0 ? body : `---\n${yaml}---\n${body ? body : ''}`;
		await this.vault.modify(file, next);
	}

	async renameFile(file: TAbstractFile, newPath: string): Promise<void> {
		await this.vault.rename(file, newPath);
	}

	/**
	 * Delete honouring the user's "Deleted files" preference.
	 *
	 * The real implementation routes to the system trash, the vault's `.trash`, or a
	 * permanent delete depending on that setting; for the mock every route removes the file,
	 * which is all any caller can observe.
	 */
	async trashFile(file: TAbstractFile): Promise<void> {
		await this.vault.trash(file, false);
	}

	generateMarkdownLink(
		file: TFile,
		sourcePath: string,
		subpath?: string,
		alias?: string,
	): string {
		const linktext = this.metadataCache.fileToLinktext(file, sourcePath);
		const target = `${linktext}${subpath ?? ''}`;
		return alias ? `[[${target}|${alias}]]` : `[[${target}]]`;
	}

	getNewFileParent(sourcePath: string): TFolder {
		const folder = splitPath(normalizePath(sourcePath)).folder;
		return this.vault.getFolderByPath(folder) ?? this.vault.getRoot();
	}
}

/** Serialize a frontmatter object back to YAML in Obsidian's usual style. */
export function serializeFrontmatter(data: Record<string, unknown>): string {
	const lines: string[] = [];
	for (const [key, value] of Object.entries(data)) {
		if (value === undefined) continue;
		if (Array.isArray(value)) {
			if (value.length === 0) {
				lines.push(`${key}: []`);
			} else {
				lines.push(`${key}:`);
				for (const item of value) lines.push(`  - ${String(item)}`);
			}
		} else if (value === null) {
			lines.push(`${key}:`);
		} else if (typeof value === 'string' && /[:#]/.test(value)) {
			lines.push(`${key}: "${value.replace(/"/g, '\\"')}"`);
		} else {
			lines.push(`${key}: ${String(value)}`);
		}
	}
	return lines.length === 0 ? '' : `${lines.join('\n')}\n`;
}

function stripFrontmatterBlock(content: string): string {
	if (!/^---\r?\n/.test(content)) return content;
	const lines = content.split('\n');
	for (let i = 1; i < lines.length; i++) {
		if (/^---\s*\r?$/.test(lines[i] ?? '')) {
			return lines
				.slice(i + 1)
				.join('\n')
				.replace(/^\r?\n/, '');
		}
	}
	return content;
}

/* ----------------------------------------------------------------- workspace -- */

export class WorkspaceLeaf extends Events {
	view: View | null = null;
	private state: { type: string; active?: boolean; state?: unknown } = { type: 'empty' };

	constructor(readonly workspace: Workspace) {
		super();
	}

	async setViewState(state: { type: string; active?: boolean; state?: unknown }): Promise<void> {
		this.state = state;
		const factory = this.workspace.viewFactories.get(state.type);
		this.view = factory ? factory(this) : null;
		if (this.view) await this.view.onOpen();
	}

	getViewState(): { type: string; active?: boolean; state?: unknown } {
		return this.state;
	}

	detach(): void {
		void this.view?.onClose();
		this.view = null;
		this.workspace.removeLeaf(this);
	}

	setPinned(): void {
		/* no-op */
	}

	openFile(): Promise<void> {
		return Promise.resolve();
	}
}

export abstract class View {
	containerEl: HTMLElement;
	app: App;

	constructor(readonly leaf: WorkspaceLeaf) {
		this.containerEl = document.createElement('div');
		// Obsidian views render into the second child of containerEl.
		this.containerEl.appendChild(document.createElement('div'));
		this.containerEl.appendChild(document.createElement('div'));
		this.app = (leaf.workspace as Workspace).app;
	}

	abstract getViewType(): string;

	getDisplayText(): string {
		return '';
	}

	getIcon(): string {
		return 'document';
	}

	async onOpen(): Promise<void> {
		/* overridden */
	}

	async onClose(): Promise<void> {
		/* overridden */
	}

	registerEvent(_ref: EventRef): void {
		/* overridden by ItemView subclasses through Component */
	}
}

export abstract class ItemView extends View {
	private readonly registeredEvents: EventRef[] = [];
	private readonly cleanups: (() => void)[] = [];
	private readonly intervals: number[] = [];

	override registerEvent(ref: EventRef): void {
		this.registeredEvents.push(ref);
	}

	register(cleanup: () => void): void {
		this.cleanups.push(cleanup);
	}

	registerDomEvent<K extends keyof HTMLElementEventMap>(
		el: HTMLElement | Document | Window,
		type: K | string,
		handler: (event: never) => void,
	): void {
		el.addEventListener(type as string, handler as EventListener);
		this.cleanups.push(() => el.removeEventListener(type as string, handler as EventListener));
	}

	registerInterval(id: number): number {
		this.intervals.push(id);
		return id;
	}

	/** Test helper: run every registered teardown, as Obsidian does on unload. */
	unload(): void {
		for (const ref of this.registeredEvents) ref.emitter.offref(ref);
		for (const cleanup of this.cleanups) cleanup();
		for (const id of this.intervals) clearInterval(id);
		this.registeredEvents.length = 0;
		this.cleanups.length = 0;
		this.intervals.length = 0;
	}
}

export class MarkdownView extends ItemView {
	getViewType(): string {
		return 'markdown';
	}
}

export class Workspace extends Events {
	readonly viewFactories = new Map<string, (leaf: WorkspaceLeaf) => View>();
	private leaves: WorkspaceLeaf[] = [];
	/** Test helper: files opened through `openLinkText` / `getLeaf().openFile()`. */
	readonly openedPaths: string[] = [];

	constructor(readonly app: App) {
		super();
	}

	getLeavesOfType(type: string): WorkspaceLeaf[] {
		return this.leaves.filter((leaf) => leaf.getViewState().type === type);
	}

	getLeaf(_newLeaf?: boolean | string): WorkspaceLeaf {
		const leaf = new WorkspaceLeaf(this);
		this.leaves.push(leaf);
		return leaf;
	}

	getRightLeaf(_split: boolean): WorkspaceLeaf {
		return this.getLeaf();
	}

	getMostRecentLeaf(): WorkspaceLeaf | null {
		return this.leaves[this.leaves.length - 1] ?? null;
	}

	async revealLeaf(_leaf: WorkspaceLeaf): Promise<void> {
		/* no-op */
	}

	detachLeavesOfType(type: string): void {
		for (const leaf of this.getLeavesOfType(type)) leaf.detach();
	}

	removeLeaf(leaf: WorkspaceLeaf): void {
		this.leaves = this.leaves.filter((candidate) => candidate !== leaf);
	}

	async openLinkText(linktext: string, sourcePath: string, _newLeaf?: boolean): Promise<void> {
		const file = this.app.metadataCache.getFirstLinkpathDest(linktext, sourcePath);
		this.openedPaths.push(file?.path ?? linktext);
	}

	getActiveViewOfType<T extends View>(_type: new (...args: never[]) => T): T | null {
		return null;
	}

	getActiveFile(): TFile | null {
		return null;
	}

	onLayoutReady(callback: () => void): void {
		callback();
	}
}

/* ------------------------------------------------------------------- notices -- */

/** Every Notice raised during a test, newest last. Cleared by `tests/setup.ts`. */
export const noticeLog: string[] = [];

export class Notice {
	noticeEl: HTMLElement;

	constructor(
		readonly message: string | DocumentFragment,
		readonly duration?: number,
	) {
		noticeLog.push(typeof message === 'string' ? message : (message.textContent ?? ''));
		this.noticeEl = document.createElement('div');
	}

	setMessage(message: string | DocumentFragment): this {
		noticeLog.push(typeof message === 'string' ? message : (message.textContent ?? ''));
		return this;
	}

	hide(): void {
		/* no-op */
	}
}

/* -------------------------------------------------------------------- modals -- */

/** Every modal currently open, so tests can drive them. */
export const openModals: Modal[] = [];

export class Modal {
	containerEl: HTMLElement;
	modalEl: HTMLElement;
	titleEl: HTMLElement;
	contentEl: HTMLElement;
	scope = new Scope();
	shouldRestoreSelection = false;

	constructor(readonly app: App) {
		this.containerEl = document.createElement('div');
		this.modalEl = document.createElement('div');
		this.titleEl = document.createElement('div');
		this.contentEl = document.createElement('div');
		this.modalEl.appendChild(this.titleEl);
		this.modalEl.appendChild(this.contentEl);
		this.containerEl.appendChild(this.modalEl);
	}

	open(): void {
		openModals.push(this);
		document.body.appendChild(this.containerEl);
		this.onOpen();
	}

	close(): void {
		const index = openModals.indexOf(this);
		if (index !== -1) openModals.splice(index, 1);
		this.onClose();
		this.containerEl.remove();
	}

	setTitle(title: string): this {
		this.titleEl.textContent = title;
		return this;
	}

	setContent(content: string): this {
		this.contentEl.textContent = content;
		return this;
	}

	onOpen(): void {
		/* overridden */
	}

	onClose(): void {
		/* overridden */
	}
}

export class Scope {
	register(
		_modifiers: string[] | null,
		_key: string | null,
		_func: (event: KeyboardEvent) => unknown,
	): unknown {
		return {};
	}

	unregister(_handler: unknown): void {
		/* no-op */
	}
}

export abstract class SuggestModal<T> extends Modal {
	inputEl: HTMLInputElement;
	resultContainerEl: HTMLElement;
	limit = 100;
	emptyStateText = 'No results';

	constructor(app: App) {
		super(app);
		this.inputEl = document.createElement('input');
		this.resultContainerEl = document.createElement('div');
		this.contentEl.appendChild(this.inputEl);
		this.contentEl.appendChild(this.resultContainerEl);
	}

	setPlaceholder(placeholder: string): void {
		this.inputEl.placeholder = placeholder;
	}

	abstract getSuggestions(query: string): T[] | Promise<T[]>;
	abstract renderSuggestion(value: T, el: HTMLElement): void;
	abstract onChooseSuggestion(item: T, evt: MouseEvent | KeyboardEvent): void;

	/** Test helper: pick the nth suggestion for a query. */
	async chooseAt(query: string, index = 0): Promise<void> {
		const suggestions = await this.getSuggestions(query);
		const item = suggestions[index];
		if (item === undefined) throw new Error(`No suggestion at index ${index} for "${query}"`);
		this.onChooseSuggestion(item, new MouseEvent('click'));
		this.close();
	}
}

export abstract class FuzzySuggestModal<T> extends SuggestModal<FuzzyMatch<T>> {
	abstract getItems(): T[];
	abstract getItemText(item: T): string;
	abstract onChooseItem(item: T, evt: MouseEvent | KeyboardEvent): void;

	getSuggestions(query: string): FuzzyMatch<T>[] {
		const lower = query.toLowerCase();
		return this.getItems()
			.filter((item) => this.getItemText(item).toLowerCase().includes(lower))
			.map((item) => ({ item, match: { score: 1, matches: [] } }));
	}

	renderSuggestion(value: FuzzyMatch<T>, el: HTMLElement): void {
		el.textContent = this.getItemText(value.item);
	}

	onChooseSuggestion(item: FuzzyMatch<T>, evt: MouseEvent | KeyboardEvent): void {
		this.onChooseItem(item.item, evt);
	}
}

export interface FuzzyMatch<T> {
	item: T;
	match: { score: number; matches: number[][] };
}

/* ------------------------------------------------------------------ settings -- */

class BaseComponent {
	disabled = false;

	setDisabled(disabled: boolean): this {
		this.disabled = disabled;
		return this;
	}
}

export class ValueComponent<T> extends BaseComponent {
	protected value!: T;
	protected changeHandler: ((value: T) => unknown) | null = null;

	getValue(): T {
		return this.value;
	}

	setValue(value: T): this {
		this.value = value;
		return this;
	}

	onChange(callback: (value: T) => unknown): this {
		this.changeHandler = callback;
		return this;
	}

	/** Test helper: simulate the user changing this control. */
	async simulateChange(value: T): Promise<void> {
		this.value = value;
		await this.changeHandler?.(value);
	}
}

export class TextComponent extends ValueComponent<string> {
	inputEl: HTMLInputElement;

	constructor(containerEl: HTMLElement) {
		super();
		this.value = '';
		this.inputEl = document.createElement('input');
		this.inputEl.type = 'text';
		containerEl.appendChild(this.inputEl);
		this.inputEl.addEventListener('input', () => {
			this.value = this.inputEl.value;
			void this.changeHandler?.(this.value);
		});
	}

	override setValue(value: string): this {
		this.value = value;
		this.inputEl.value = value;
		return this;
	}

	setPlaceholder(placeholder: string): this {
		this.inputEl.placeholder = placeholder;
		return this;
	}
}

export class TextAreaComponent extends ValueComponent<string> {
	inputEl: HTMLTextAreaElement;

	constructor(containerEl: HTMLElement) {
		super();
		this.value = '';
		this.inputEl = document.createElement('textarea');
		containerEl.appendChild(this.inputEl);
		this.inputEl.addEventListener('input', () => {
			this.value = this.inputEl.value;
			void this.changeHandler?.(this.value);
		});
	}

	override setValue(value: string): this {
		this.value = value;
		this.inputEl.value = value;
		return this;
	}

	setPlaceholder(placeholder: string): this {
		this.inputEl.placeholder = placeholder;
		return this;
	}
}

export class SearchComponent extends TextComponent {}

export class ToggleComponent extends ValueComponent<boolean> {
	toggleEl: HTMLElement;

	constructor(containerEl: HTMLElement) {
		super();
		this.value = false;
		this.toggleEl = document.createElement('div');
		containerEl.appendChild(this.toggleEl);
		this.toggleEl.addEventListener('click', () => {
			void this.simulateChange(!this.value);
		});
	}

	override setValue(value: boolean): this {
		this.value = value;
		this.toggleEl.setAttribute('aria-checked', String(value));
		return this;
	}
}

export class DropdownComponent extends ValueComponent<string> {
	selectEl: HTMLSelectElement;

	constructor(containerEl: HTMLElement) {
		super();
		this.value = '';
		this.selectEl = document.createElement('select');
		containerEl.appendChild(this.selectEl);
		this.selectEl.addEventListener('change', () => {
			this.value = this.selectEl.value;
			void this.changeHandler?.(this.value);
		});
	}

	addOption(value: string, display: string): this {
		const option = document.createElement('option');
		option.value = value;
		option.text = display;
		this.selectEl.appendChild(option);
		return this;
	}

	addOptions(options: Record<string, string>): this {
		for (const [value, display] of Object.entries(options)) this.addOption(value, display);
		return this;
	}

	override setValue(value: string): this {
		this.value = value;
		this.selectEl.value = value;
		return this;
	}
}

export class SliderComponent extends ValueComponent<number> {
	sliderEl: HTMLInputElement;

	constructor(containerEl: HTMLElement) {
		super();
		this.value = 0;
		this.sliderEl = document.createElement('input');
		this.sliderEl.type = 'range';
		containerEl.appendChild(this.sliderEl);
	}

	setLimits(min: number, max: number, step: number): this {
		this.sliderEl.min = String(min);
		this.sliderEl.max = String(max);
		this.sliderEl.step = String(step);
		return this;
	}

	setDynamicTooltip(): this {
		return this;
	}

	override setValue(value: number): this {
		this.value = value;
		this.sliderEl.value = String(value);
		return this;
	}
}

export class ButtonComponent extends BaseComponent {
	buttonEl: HTMLButtonElement;

	constructor(containerEl: HTMLElement) {
		super();
		this.buttonEl = document.createElement('button');
		containerEl.appendChild(this.buttonEl);
	}

	setButtonText(text: string): this {
		this.buttonEl.textContent = text;
		return this;
	}

	setIcon(icon: string): this {
		this.buttonEl.setAttribute('data-icon', icon);
		return this;
	}

	setTooltip(tooltip: string): this {
		this.buttonEl.setAttribute('aria-label', tooltip);
		return this;
	}

	setCta(): this {
		this.buttonEl.classList.add('mod-cta');
		return this;
	}

	setWarning(): this {
		this.buttonEl.classList.add('mod-warning');
		return this;
	}

	/**
	 * The 1.13 replacement for {@link setWarning}, which is deprecated.
	 *
	 * Combines with {@link setCta} — `setDestructive().setCta()` is a destructive primary
	 * action — so the two classes are additive rather than exclusive.
	 */
	setDestructive(): this {
		this.buttonEl.classList.add('mod-destructive');
		return this;
	}

	setClass(cls: string): this {
		this.buttonEl.classList.add(cls);
		return this;
	}

	onClick(callback: (evt: MouseEvent) => unknown): this {
		this.buttonEl.addEventListener('click', (evt) => {
			void callback(evt as MouseEvent);
		});
		return this;
	}
}

export class ExtraButtonComponent extends BaseComponent {
	extraSettingsEl: HTMLElement;

	constructor(containerEl: HTMLElement) {
		super();
		this.extraSettingsEl = document.createElement('div');
		containerEl.appendChild(this.extraSettingsEl);
	}

	setIcon(icon: string): this {
		this.extraSettingsEl.setAttribute('data-icon', icon);
		return this;
	}

	setTooltip(tooltip: string): this {
		this.extraSettingsEl.setAttribute('aria-label', tooltip);
		return this;
	}

	onClick(callback: () => unknown): this {
		this.extraSettingsEl.addEventListener('click', () => {
			void callback();
		});
		return this;
	}
}

export class Setting {
	settingEl: HTMLElement;
	infoEl: HTMLElement;
	nameEl: HTMLElement;
	descEl: HTMLElement;
	controlEl: HTMLElement;
	components: BaseComponent[] = [];

	constructor(containerEl: HTMLElement) {
		this.settingEl = document.createElement('div');
		this.settingEl.classList.add('setting-item');
		this.infoEl = document.createElement('div');
		this.nameEl = document.createElement('div');
		this.descEl = document.createElement('div');
		this.controlEl = document.createElement('div');
		this.infoEl.appendChild(this.nameEl);
		this.infoEl.appendChild(this.descEl);
		this.settingEl.appendChild(this.infoEl);
		this.settingEl.appendChild(this.controlEl);
		containerEl.appendChild(this.settingEl);
	}

	setName(name: string | DocumentFragment): this {
		if (typeof name === 'string') this.nameEl.textContent = name;
		else this.nameEl.appendChild(name);
		return this;
	}

	setDesc(desc: string | DocumentFragment): this {
		if (typeof desc === 'string') this.descEl.textContent = desc;
		else this.descEl.appendChild(desc);
		return this;
	}

	setClass(cls: string): this {
		this.settingEl.classList.add(cls);
		return this;
	}

	setTooltip(tooltip: string): this {
		this.settingEl.setAttribute('aria-label', tooltip);
		return this;
	}

	setHeading(): this {
		this.settingEl.classList.add('setting-item-heading');
		return this;
	}

	setDisabled(disabled: boolean): this {
		this.settingEl.toggleAttribute('disabled', disabled);
		return this;
	}

	addText(cb: (component: TextComponent) => unknown): this {
		const component = new TextComponent(this.controlEl);
		this.components.push(component);
		cb(component);
		return this;
	}

	addTextArea(cb: (component: TextAreaComponent) => unknown): this {
		const component = new TextAreaComponent(this.controlEl);
		this.components.push(component);
		cb(component);
		return this;
	}

	addSearch(cb: (component: SearchComponent) => unknown): this {
		const component = new SearchComponent(this.controlEl);
		this.components.push(component);
		cb(component);
		return this;
	}

	addToggle(cb: (component: ToggleComponent) => unknown): this {
		const component = new ToggleComponent(this.controlEl);
		this.components.push(component);
		cb(component);
		return this;
	}

	addDropdown(cb: (component: DropdownComponent) => unknown): this {
		const component = new DropdownComponent(this.controlEl);
		this.components.push(component);
		cb(component);
		return this;
	}

	addSlider(cb: (component: SliderComponent) => unknown): this {
		const component = new SliderComponent(this.controlEl);
		this.components.push(component);
		cb(component);
		return this;
	}

	addButton(cb: (component: ButtonComponent) => unknown): this {
		const component = new ButtonComponent(this.controlEl);
		this.components.push(component);
		cb(component);
		return this;
	}

	addExtraButton(cb: (component: ExtraButtonComponent) => unknown): this {
		const component = new ExtraButtonComponent(this.controlEl);
		this.components.push(component);
		cb(component);
		return this;
	}
}

export abstract class PluginSettingTab {
	containerEl: HTMLElement;
	/** Test helper: how many times {@link update} was called. */
	updateCount = 0;

	constructor(
		readonly app: App,
		readonly plugin: Plugin,
	) {
		this.containerEl = document.createElement('div');
	}

	display(): void {
		/* overridden by tabs that still render imperatively */
	}

	/**
	 * Re-evaluate declarative settings (Obsidian 1.13+).
	 *
	 * The real implementation re-runs `getSettingDefinitions()` and reconciles the DOM. The
	 * mock records the call and re-renders, which is enough to assert that a tab refreshes
	 * itself through `update()` rather than by calling `display()` again.
	 */
	update(): void {
		this.updateCount++;
		const tab = this as unknown as { getSettingDefinitions?: () => unknown[] };
		if (typeof tab.getSettingDefinitions === 'function') tab.getSettingDefinitions();
		else this.display();
	}

	hide(): void {
		this.containerEl.empty();
	}
}

/* --------------------------------------------------------------------- menu -- */

export class MenuItem {
	title = '';
	icon = '';
	clickHandler: (() => unknown) | null = null;
	isChecked = false;

	setTitle(title: string): this {
		this.title = title;
		return this;
	}

	setIcon(icon: string): this {
		this.icon = icon;
		return this;
	}

	setChecked(checked: boolean): this {
		this.isChecked = checked;
		return this;
	}

	onClick(callback: () => unknown): this {
		this.clickHandler = callback;
		return this;
	}
}

export class Menu {
	readonly items: MenuItem[] = [];

	addItem(cb: (item: MenuItem) => unknown): this {
		const item = new MenuItem();
		this.items.push(item);
		cb(item);
		return this;
	}

	addSeparator(): this {
		return this;
	}

	showAtMouseEvent(_event: MouseEvent): this {
		return this;
	}

	showAtPosition(_position: { x: number; y: number }): this {
		return this;
	}

	hide(): this {
		return this;
	}

	/** Test helper: invoke a menu item by its title. */
	clickItem(title: string): void {
		const item = this.items.find((candidate) => candidate.title === title);
		if (!item) throw new Error(`No menu item titled "${title}"`);
		item.clickHandler?.();
	}
}

/* ------------------------------------------------------------------ plugin -- */

export class Component {
	private readonly children: Component[] = [];
	private readonly cleanups: (() => void)[] = [];
	private readonly eventRefs: EventRef[] = [];
	private loaded = false;

	load(): void {
		this.loaded = true;
		this.onload();
		for (const child of this.children) child.load();
	}

	onload(): void {
		/* overridden */
	}

	unload(): void {
		this.loaded = false;
		for (const child of this.children) child.unload();
		for (const ref of this.eventRefs) ref.emitter.offref(ref);
		for (const cleanup of this.cleanups) cleanup();
		this.eventRefs.length = 0;
		this.cleanups.length = 0;
		this.onunload();
	}

	onunload(): void {
		/* overridden */
	}

	addChild<T extends Component>(child: T): T {
		this.children.push(child);
		if (this.loaded) child.load();
		return child;
	}

	removeChild<T extends Component>(child: T): T {
		const index = this.children.indexOf(child);
		if (index !== -1) this.children.splice(index, 1);
		child.unload();
		return child;
	}

	register(cleanup: () => void): void {
		this.cleanups.push(cleanup);
	}

	registerEvent(ref: EventRef): void {
		this.eventRefs.push(ref);
	}

	registerDomEvent(
		el: HTMLElement | Document | Window,
		type: string,
		handler: (event: never) => void,
	): void {
		el.addEventListener(type, handler as EventListener);
		this.cleanups.push(() => el.removeEventListener(type, handler as EventListener));
	}

	registerInterval(id: number): number {
		this.cleanups.push(() => clearInterval(id));
		return id;
	}
}

export interface Command {
	id: string;
	name: string;
	icon?: string;
	callback?: () => unknown;
	checkCallback?: (checking: boolean) => boolean | void;
	editorCallback?: (editor: unknown, ctx: unknown) => unknown;
	hotkeys?: { modifiers: string[]; key: string }[];
}

export interface PluginManifest {
	id: string;
	name: string;
	version: string;
	minAppVersion: string;
	description: string;
	author: string;
	authorUrl?: string;
	isDesktopOnly?: boolean;
	dir?: string;
}

export class Plugin extends Component {
	/** Every command registered, keyed by full id. */
	readonly commands = new Map<string, Command>();
	readonly ribbonIcons: { icon: string; title: string; callback: (evt: MouseEvent) => void }[] =
		[];
	readonly statusBarItems: HTMLElement[] = [];
	settingTab: PluginSettingTab | null = null;
	private data: unknown = null;

	constructor(
		readonly app: App,
		readonly manifest: PluginManifest,
	) {
		super();
	}

	addCommand(command: Command): Command {
		this.commands.set(`${this.manifest.id}:${command.id}`, command);
		return command;
	}

	removeCommand(id: string): void {
		this.commands.delete(`${this.manifest.id}:${id}`);
	}

	addRibbonIcon(icon: string, title: string, callback: (evt: MouseEvent) => void): HTMLElement {
		this.ribbonIcons.push({ icon, title, callback });
		const el = document.createElement('div');
		el.setAttribute('data-icon', icon);
		el.setAttribute('aria-label', title);
		el.addEventListener('click', (evt) => callback(evt as MouseEvent));
		return el;
	}

	addStatusBarItem(): HTMLElement {
		const el = document.createElement('div');
		el.classList.add('status-bar-item');
		this.statusBarItems.push(el);
		return el;
	}

	addSettingTab(tab: PluginSettingTab): void {
		this.settingTab = tab;
	}

	registerView(type: string, factory: (leaf: WorkspaceLeaf) => View): void {
		this.app.workspace.viewFactories.set(type, factory);
		this.register(() => this.app.workspace.viewFactories.delete(type));
	}

	registerHoverLinkSource(): void {
		/* no-op */
	}

	async loadData(): Promise<unknown> {
		return this.data;
	}

	async saveData(data: unknown): Promise<void> {
		this.data = JSON.parse(JSON.stringify(data));
	}

	/** Test helper: run a command by its short id. */
	async runCommand(id: string): Promise<void> {
		const command = this.commands.get(`${this.manifest.id}:${id}`);
		if (!command) throw new Error(`No command "${id}"`);
		if (command.callback) await command.callback();
		else command.checkCallback?.(false);
	}
}

/* --------------------------------------------------------------------- app -- */

export class App {
	vault: Vault;
	metadataCache: MetadataCache;
	fileManager: FileManager;
	workspace: Workspace;
	keymap = { pushScope: (): void => undefined, popScope: (): void => undefined };
	lastEvent: MouseEvent | KeyboardEvent | null = null;

	private readonly localStorage = new Map<string, unknown>();

	constructor(vaultName = 'test-vault') {
		this.vault = new Vault(vaultName);
		this.metadataCache = new MetadataCache(this.vault);
		this.fileManager = new FileManager(this.vault, this.metadataCache);
		this.workspace = new Workspace(this);
	}

	loadLocalStorage(key: string): unknown {
		return this.localStorage.get(key) ?? null;
	}

	saveLocalStorage(key: string, data: unknown): void {
		if (data === null) this.localStorage.delete(key);
		else this.localStorage.set(key, data);
	}
}

/* ------------------------------------------------------------------- misc -- */

export const Platform = {
	isDesktop: true,
	isMobile: false,
	isDesktopApp: true,
	isMobileApp: false,
	isIosApp: false,
	isAndroidApp: false,
	isPhone: false,
	isTablet: false,
	isMacOS: true,
	isWin: false,
	isLinux: false,
	isSafari: false,
};

export function setIcon(el: HTMLElement, iconId: string): void {
	el.setAttribute('data-icon', iconId);
}

export function addIcon(_id: string, _svg: string): void {
	/* no-op */
}

export function debounce<A extends unknown[]>(
	fn: (...args: A) => unknown,
	timeout = 0,
	resetTimer = false,
): ((...args: A) => void) & { cancel(): void; run(): void } {
	let timer: ReturnType<typeof setTimeout> | null = null;
	let lastArgs: A | null = null;

	const debounced = (...args: A): void => {
		lastArgs = args;
		if (timer !== null && resetTimer) clearTimeout(timer);
		else if (timer !== null) return;
		timer = setTimeout(() => {
			timer = null;
			if (lastArgs) fn(...lastArgs);
		}, timeout);
	};
	debounced.cancel = (): void => {
		if (timer !== null) clearTimeout(timer);
		timer = null;
	};
	debounced.run = (): void => {
		if (timer !== null) clearTimeout(timer);
		timer = null;
		if (lastArgs) fn(...lastArgs);
	};
	return debounced;
}

export function prepareFuzzySearch(
	query: string,
): (text: string) => { score: number; matches: number[][] } | null {
	const lower = query.toLowerCase();
	return (text: string) =>
		text.toLowerCase().includes(lower) ? { score: 1, matches: [] } : null;
}

export function requireApiVersion(_version: string): boolean {
	return true;
}

export const apiVersion = '1.4.0';

/** Array.remove, which Obsidian adds to the Array prototype. */
declare global {
	interface Array<T> {
		remove(item: T): void;
	}
}

if (!Array.prototype.remove) {
	Object.defineProperty(Array.prototype, 'remove', {
		value: function remove<T>(this: T[], item: T): void {
			const index = this.indexOf(item);
			if (index !== -1) this.splice(index, 1);
		},
		writable: true,
		configurable: true,
		enumerable: false,
	});
}
