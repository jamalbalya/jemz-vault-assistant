/**
 * Vault path helpers.
 *
 * These are deliberately plain string operations. Node's `path` module is unavailable on
 * Obsidian mobile, and vault paths are always `/`-separated regardless of platform.
 */

/** Extensions Obsidian treats as embeddable attachments. */
export const ATTACHMENT_EXTENSIONS = [
	'png',
	'jpg',
	'jpeg',
	'gif',
	'bmp',
	'svg',
	'webp',
	'avif',
	'pdf',
	'mp3',
	'wav',
	'm4a',
	'ogg',
	'flac',
	'3gp',
	'mp4',
	'webm',
	'ogv',
	'mov',
	'mkv',
	'canvas',
	'base',
] as const;

/** Collapse duplicate slashes and strip leading/trailing ones. */
export function normalizeVaultPath(path: string): string {
	return path.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
}

/** Join path segments into a normalised vault path. */
export function joinPath(...segments: string[]): string {
	return normalizeVaultPath(segments.filter((s) => s.length > 0).join('/'));
}

/** Parent folder of a path, or '' when the path sits in the vault root. */
export function getFolderPath(path: string): string {
	const normalized = normalizeVaultPath(path);
	const index = normalized.lastIndexOf('/');
	return index === -1 ? '' : normalized.slice(0, index);
}

/** File name including extension. */
export function getFileName(path: string): string {
	const normalized = normalizeVaultPath(path);
	const index = normalized.lastIndexOf('/');
	return index === -1 ? normalized : normalized.slice(index + 1);
}

/** File name without its extension. */
export function getBasename(path: string): string {
	const name = getFileName(path);
	const index = name.lastIndexOf('.');
	return index <= 0 ? name : name.slice(0, index);
}

/** Lower-cased extension without the dot, or '' when there is none. */
export function getExtension(path: string): string {
	const name = getFileName(path);
	const index = name.lastIndexOf('.');
	return index <= 0 ? '' : name.slice(index + 1).toLowerCase();
}

/** Whether a path points at a markdown note. */
export function isMarkdownPath(path: string): boolean {
	return getExtension(path) === 'md';
}

/** Whether a path points at a known attachment type. */
export function isAttachmentPath(path: string): boolean {
	const extension = getExtension(path);
	return extension.length > 0 && (ATTACHMENT_EXTENSIONS as readonly string[]).includes(extension);
}

/**
 * Whether `path` sits inside `folder` (or is the folder itself).
 * An empty `folder` means the vault root, which contains everything.
 */
export function isInFolder(path: string, folder: string): boolean {
	const normalizedFolder = normalizeVaultPath(folder);
	if (normalizedFolder.length === 0) return true;
	const normalizedPath = normalizeVaultPath(path);
	return normalizedPath === normalizedFolder || normalizedPath.startsWith(`${normalizedFolder}/`);
}

/**
 * Whether a path carries a `..` segment.
 *
 * Vault paths never do. `normalizeVaultPath` only tidies slashes, so a `..` survives it and
 * then defeats any "is this inside that folder?" test written with `startsWith` — the prefix
 * still matches while the resolved path is somewhere else entirely. Every path rebuilt from
 * persisted JSON is checked with this before it is used to write or delete.
 */
export function hasTraversalSegment(path: string): boolean {
	return normalizeVaultPath(path).split('/').includes('..');
}

/** Whether `path` sits inside any of `folders`. */
export function isInAnyFolder(path: string, folders: readonly string[]): boolean {
	return folders.some((folder) => folder.trim().length > 0 && isInFolder(path, folder));
}

/** Append `.md` unless the path already carries an extension. */
export function ensureMarkdownExtension(path: string): string {
	return getExtension(path).length === 0
		? `${normalizeVaultPath(path)}.md`
		: normalizeVaultPath(path);
}

/**
 * Produce a path that does not collide with an existing file by appending ` 2`, ` 3`, …
 * to the base name, which is the convention Obsidian itself uses.
 *
 * @param desiredPath The path we would like to use.
 * @param exists Predicate answering whether a path is taken.
 */
export function uniquePath(desiredPath: string, exists: (path: string) => boolean): string {
	if (!exists(desiredPath)) return desiredPath;
	const folder = getFolderPath(desiredPath);
	const base = getBasename(desiredPath);
	const extension = getExtension(desiredPath);
	const suffix = extension.length > 0 ? `.${extension}` : '';

	for (let counter = 2; counter < 10_000; counter++) {
		const candidate = joinPath(folder, `${base} ${counter}${suffix}`);
		if (!exists(candidate)) return candidate;
	}
	// Practically unreachable; keeps the function total rather than looping forever.
	return joinPath(folder, `${base} ${Date.now()}${suffix}`);
}

/** Every ancestor folder of a path, outermost first: `a/b/c.md` → `['a', 'a/b']`. */
export function ancestorFolders(path: string): string[] {
	const folder = getFolderPath(path);
	if (folder.length === 0) return [];
	const parts = folder.split('/');
	const result: string[] = [];
	let current = '';
	for (const part of parts) {
		current = current.length === 0 ? part : `${current}/${part}`;
		result.push(current);
	}
	return result;
}
