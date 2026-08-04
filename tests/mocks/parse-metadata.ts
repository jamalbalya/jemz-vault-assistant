/**
 * Builds Obsidian-compatible `CachedMetadata` from raw file content.
 *
 * This mirrors Obsidian's own parsing closely enough that detector counts computed against
 * the mock match what the real app reports:
 *  - frontmatter must open on line 1 and close with a `---` line; malformed YAML yields
 *    `frontmatter: undefined`, exactly as Obsidian does,
 *  - code fences and inline code are masked before links/tags are extracted,
 *  - a `#` run that is entirely numeric (`#142`) is not a tag.
 */

export interface Pos {
	line: number;
	col: number;
	offset: number;
}

export interface Loc {
	start: Pos;
	end: Pos;
}

export interface LinkCache {
	link: string;
	original: string;
	displayText?: string;
	position: Loc;
}

export type EmbedCache = LinkCache;

export interface TagCache {
	tag: string;
	position: Loc;
}

export interface HeadingCache {
	heading: string;
	level: number;
	position: Loc;
}

export interface CachedMetadata {
	frontmatter?: Record<string, unknown>;
	frontmatterPosition?: Loc;
	links?: LinkCache[];
	embeds?: EmbedCache[];
	tags?: TagCache[];
	headings?: HeadingCache[];
}

/** Result of locating a frontmatter block. */
interface FrontmatterBlock {
	raw: string;
	endLine: number;
	endOffset: number;
}

function findFrontmatterBlock(content: string): FrontmatterBlock | null {
	if (!/^---\r?\n/.test(content)) return null;
	const lines = content.split('\n');
	let offset = (lines[0]?.length ?? 0) + 1;
	for (let i = 1; i < lines.length; i++) {
		const line = lines[i] ?? '';
		if (/^---\s*\r?$/.test(line)) {
			return {
				raw: lines.slice(1, i).join('\n'),
				endLine: i,
				endOffset: offset + line.length,
			};
		}
		offset += line.length + 1;
	}
	return null;
}

/** Strip surrounding quotes and unescape the little that YAML scalars need. */
function parseScalar(raw: string): unknown {
	const text = raw.trim();
	if (text.length === 0) return '';
	if (
		(text.startsWith('"') && text.endsWith('"') && text.length >= 2) ||
		(text.startsWith("'") && text.endsWith("'") && text.length >= 2)
	) {
		return text.slice(1, -1).replace(/\\"/g, '"');
	}
	if (text === 'true') return true;
	if (text === 'false') return false;
	if (text === 'null' || text === '~') return null;
	if (/^-?\d+$/.test(text)) return Number(text);
	if (/^-?\d*\.\d+$/.test(text)) return Number(text);
	return text;
}

/**
 * Minimal YAML reader covering the shapes Obsidian frontmatter actually uses:
 * scalars, block sequences, and inline sequences.
 *
 * @returns The parsed mapping, or null when the block is malformed.
 */
export function parseFrontmatter(raw: string): Record<string, unknown> | null {
	const result: Record<string, unknown> = {};
	const lines = raw.split('\n');
	let currentKey: string | null = null;
	let currentList: unknown[] | null = null;

	for (const rawLine of lines) {
		const line = rawLine.replace(/\r$/, '');
		if (line.trim().length === 0) continue;
		if (/^\s*#/.test(line)) continue;

		const listItem = /^\s*-\s*(.*)$/.exec(line);
		if (listItem) {
			// A sequence entry that never followed a key is invalid YAML in this context.
			if (currentKey === null) return null;
			if (currentList === null) {
				currentList = [];
				result[currentKey] = currentList;
			}
			currentList.push(parseScalar(listItem[1] ?? ''));
			continue;
		}

		const mapping = /^([A-Za-z0-9_ .-]+):(?:\s+(.*))?$/.exec(line);
		if (!mapping) {
			// Anything else — `type note`, `tags [a, b` — is a YAML error, and Obsidian
			// discards the whole block rather than salvaging part of it.
			return null;
		}

		const key = (mapping[1] ?? '').trim();
		const value = (mapping[2] ?? '').trim();
		currentKey = key;
		currentList = null;

		if (value.length === 0) {
			// Either an empty value or the header of a block sequence; decided by the
			// following lines. Start as empty string and upgrade to a list if items follow.
			result[key] = '';
			continue;
		}

		const inlineList = /^\[(.*)\]$/.exec(value);
		if (inlineList) {
			const inner = (inlineList[1] ?? '').trim();
			result[key] =
				inner.length === 0 ? [] : inner.split(',').map((part) => parseScalar(part));
			continue;
		}

		result[key] = parseScalar(value);
	}

	return result;
}

/**
 * Replace fenced blocks and inline code with spaces so that link and tag scanning ignores
 * them while every remaining character keeps its original offset.
 */
export function maskCode(content: string): string {
	let masked = content.replace(/```[\s\S]*?```/g, (match) => match.replace(/[^\n]/g, ' '));
	masked = masked.replace(/`[^`\n]*`/g, (match) => ' '.repeat(match.length));
	return masked;
}

function positionAt(content: string, offset: number): Pos {
	let line = 0;
	let lineStart = 0;
	for (let i = 0; i < offset && i < content.length; i++) {
		if (content[i] === '\n') {
			line++;
			lineStart = i + 1;
		}
	}
	return { line, col: offset - lineStart, offset };
}

function makeLoc(content: string, start: number, end: number): Loc {
	return { start: positionAt(content, start), end: positionAt(content, end) };
}

const WIKILINK_PATTERN = /(!?)\[\[([^\]]+?)\]\]/g;
const MARKDOWN_LINK_PATTERN = /(!?)\[([^\]]*)\]\(([^)]*)\)/g;
const TAG_PATTERN = /(^|[\s(["'>])#([A-Za-z0-9_\-/]+)/g;
const HEADING_PATTERN = /^(#{1,6})\s+(.*?)\s*$/;

/** Split a wikilink body into its target, subpath and display text. */
function splitWikilink(body: string): { link: string; displayText?: string } {
	const pipeIndex = body.indexOf('|');
	const target = pipeIndex === -1 ? body : body.slice(0, pipeIndex);
	const alias = pipeIndex === -1 ? undefined : body.slice(pipeIndex + 1);
	return alias === undefined
		? { link: target.trim() }
		: { link: target.trim(), displayText: alias.trim() };
}

/** Whether a URL-ish string points outside the vault. */
function isExternal(target: string): boolean {
	return /^[a-z][a-z0-9+.-]*:\/\//i.test(target) || target.startsWith('mailto:');
}

/** Build the metadata cache entry for one file's content. */
export function parseMetadata(content: string): CachedMetadata {
	const cache: CachedMetadata = {};

	const block = findFrontmatterBlock(content);
	let scanFrom = 0;
	if (block) {
		const parsed = parseFrontmatter(block.raw);
		if (parsed !== null) {
			cache.frontmatter = parsed;
			cache.frontmatterPosition = makeLoc(content, 0, block.endOffset);
		}
		scanFrom = block.endOffset;
	}

	// Everything below the frontmatter, with code masked and offsets preserved.
	const masked = ' '.repeat(scanFrom) + maskCode(content.slice(scanFrom));

	const links: LinkCache[] = [];
	const embeds: EmbedCache[] = [];

	WIKILINK_PATTERN.lastIndex = 0;
	for (let match = WIKILINK_PATTERN.exec(masked); match; match = WIKILINK_PATTERN.exec(masked)) {
		const [full, bang, body = ''] = match;
		const { link, displayText } = splitWikilink(body);
		if (link.length === 0) continue;
		const entry: LinkCache = {
			link,
			original: full,
			position: makeLoc(content, match.index, match.index + full.length),
		};
		if (displayText !== undefined) entry.displayText = displayText;
		if (bang === '!') embeds.push(entry);
		else links.push(entry);
	}

	MARKDOWN_LINK_PATTERN.lastIndex = 0;
	for (
		let match = MARKDOWN_LINK_PATTERN.exec(masked);
		match;
		match = MARKDOWN_LINK_PATTERN.exec(masked)
	) {
		const [full, bang, text = '', rawTarget = ''] = match;
		const target = decodeURIComponent(rawTarget.trim().replace(/^<|>$/g, ''));
		if (target.length === 0 || isExternal(target) || target.startsWith('#')) continue;
		const entry: LinkCache = {
			link: target,
			original: full,
			displayText: text,
			position: makeLoc(content, match.index, match.index + full.length),
		};
		if (bang === '!') embeds.push(entry);
		else links.push(entry);
	}

	if (links.length > 0) cache.links = links;
	if (embeds.length > 0) cache.embeds = embeds;

	// Inline tags. A run of digits alone is not a tag ("PR #142").
	const tags: TagCache[] = [];
	TAG_PATTERN.lastIndex = 0;
	for (let match = TAG_PATTERN.exec(masked); match; match = TAG_PATTERN.exec(masked)) {
		const prefix = match[1] ?? '';
		const body = match[2] ?? '';
		if (!/[A-Za-z_/-]/.test(body)) continue;
		const start = match.index + prefix.length;
		tags.push({
			tag: `#${body}`,
			position: makeLoc(content, start, start + body.length + 1),
		});
	}
	if (tags.length > 0) cache.tags = tags;

	// Headings, skipping any inside the frontmatter block or a code fence.
	const headings: HeadingCache[] = [];
	let offset = 0;
	const lines = content.split('\n');
	for (const line of lines) {
		if (offset >= scanFrom) {
			const maskedLine = masked.slice(offset, offset + line.length);
			const match = HEADING_PATTERN.exec(maskedLine);
			if (match) {
				headings.push({
					heading: (match[2] ?? '').trim(),
					level: (match[1] ?? '#').length,
					position: makeLoc(content, offset, offset + line.length),
				});
			}
		}
		offset += line.length + 1;
	}
	if (headings.length > 0) cache.headings = headings;

	return cache;
}

/** Mirrors Obsidian's `getAllTags`: frontmatter plus inline tags, each with a leading `#`. */
export function collectAllTags(cache: CachedMetadata): string[] {
	const result: string[] = [];
	const push = (value: unknown): void => {
		if (typeof value !== 'string') return;
		const trimmed = value.trim();
		if (trimmed.length === 0) return;
		result.push(trimmed.startsWith('#') ? trimmed : `#${trimmed}`);
	};

	const frontmatterTags = cache.frontmatter?.tags ?? cache.frontmatter?.tag;
	if (Array.isArray(frontmatterTags)) frontmatterTags.forEach(push);
	else if (typeof frontmatterTags === 'string') {
		frontmatterTags.split(/[,\s]+/).forEach(push);
	}

	for (const tag of cache.tags ?? []) push(tag.tag);

	return Array.from(new Set(result));
}
