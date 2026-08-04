/**
 * Everything the plugin knows about tags: grouping near-duplicates, autocomplete, and the
 * rename that merges a variant into its canonical form.
 *
 * The grouping half is deliberately a pure function rather than a method, because two very
 * different callers need identical results: the tag-inconsistency detector (which sees a
 * filtered subset of notes through a {@link DetectorContext} and never touches this service)
 * and the dashboard/settings UI (which reads the whole vault through {@link TagService}).
 * Keeping the algorithm in one exported function is the only way those two can never
 * disagree about what counts as a variant.
 */

import type { App, TFile } from 'obsidian';
import type { Logger } from '../core/logger';
import { errorMessage } from '../core/logger';
import { STRINGS } from '../core/strings';
import type { HealthSettings } from '../types/settings';
import { DEFAULT_SETTINGS } from '../types/settings';
import { isMarkdownPath } from '../utils/file';
import { fuzzyMatch } from '../utils/fuzzy-match';
import { levenshtein } from '../utils/levenshtein';
import { escapeRegExp, normalizeTag, splitFrontmatter } from '../utils/string';
import type { VaultIndex } from './vault-index';

/** One tag inside a group, with how many notes carry it. */
export interface TagVariant {
	/** Tag name without the leading `#`, lower-cased. */
	tag: string;
	/** Number of notes carrying it. */
	count: number;
}

/** A set of tags that look like spellings of the same thing. */
export interface TagGroup {
	/** The variant the others should be merged into. */
	canonical: string;
	/** Every member of the group, canonical included, most used first. */
	variants: TagVariant[];
}

/** Thresholds that decide when two tags are variants of each other. */
export interface TagSimilarityOptions {
	/** Tags shorter than this compare with {@link shortMaxDistance}. */
	shortLengthCutoff: number;
	/** Edit distance allowed between short tags. */
	shortMaxDistance: number;
	/** Edit distance allowed once both tags are long enough. */
	longMaxDistance: number;
	/**
	 * Characters two tags must share at the start before edit distance is even consulted.
	 *
	 * Edit distance alone is not enough at this scale: `meeting` and `testing` are two edits
	 * apart and completely unrelated, as are `finance` and `fitness`. A misspelling, on the
	 * other hand, almost always keeps the opening of the word — `projek`/`project` share
	 * five, `testting`/`testing` four, `developement`/`development` seven.
	 *
	 * The tradeoff is that a typo in the first character or two (`broject`) is not caught.
	 * That is far rarer than the false pairs this rule removes, and a false "merge these
	 * tags" suggestion is much more costly than a missed one, because acting on it rewrites
	 * tags across the vault.
	 */
	minSharedPrefix: number;
}

/** Number of leading characters two strings have in common. */
export function sharedPrefixLength(a: string, b: string): number {
	const limit = Math.min(a.length, b.length);
	let shared = 0;
	while (shared < limit && a[shared] === b[shared]) shared++;
	return shared;
}

/** Frontmatter keys Obsidian reads tags from, in the order `getAllTags` uses. */
const FRONTMATTER_TAG_KEYS = ['tags', 'tag'] as const;

/** Default number of autocomplete suggestions. */
const DEFAULT_SUGGESTION_LIMIT = 10;

/**
 * How much usage may lift a suggestion's rank.
 *
 * Fuzzy scores favour short targets, so `projek` (used once, a typo) outranks `project`
 * (used a hundred times) on score alone — which would make the capture modal recommend the
 * misspelling it is supposed to help eliminate. A tenth of a point is small enough that it
 * only ever reorders near-ties, and large enough to settle exactly that case.
 */
const USAGE_RANK_WEIGHT = 0.1;

/**
 * Raised when a tag rename could not be written.
 *
 * Typed rather than a bare `Error` so the fix pipeline can tell a failed rename apart from a
 * programming mistake and report the offending path in the action log.
 */
export class TagRenameError extends Error {
	constructor(
		readonly path: string,
		message: string,
	) {
		super(message);
		this.name = 'TagRenameError';
	}
}

/**
 * Total order over strings.
 *
 * `localeCompare` alone can return 0 for strings that are not identical, which would make
 * sort results depend on insertion order; the code-unit fallback keeps the order stable.
 */
function compareStrings(a: string, b: string): number {
	const byLocale = a.localeCompare(b);
	if (byLocale !== 0) return byLocale;
	if (a < b) return -1;
	if (a > b) return 1;
	return 0;
}

/**
 * Group tags that are probably misspellings of one another.
 *
 * The distance bound scales with length because a flat "distance <= 2" is wrong at both ends:
 * it pairs `task` with `test` (two unrelated four letter tags) while still being too tight to
 * catch `developement` for `development`. Short tags therefore get a stricter bound.
 *
 * Membership is transitive by design — components are built with union-find, so
 * `project`/`projects`/`projek` land in one group with a single canonical form instead of
 * three overlapping pairs the user would have to merge one at a time.
 *
 * @param counts Tag name (no leading `#`) to the number of notes carrying it.
 * @param options Distance thresholds, normally taken from {@link HealthSettings}.
 * @returns Groups of 2+ tags, sorted by canonical name. Singletons are dropped.
 */
export function groupSimilarTags(
	counts: ReadonlyMap<string, number>,
	options: TagSimilarityOptions,
): TagGroup[] {
	const tags = Array.from(counts.keys()).filter((tag) => tag.length > 0);
	if (tags.length < 2) return [];

	// Sorting by length lets the inner loop stop as soon as the length difference alone rules
	// out every remaining candidate, which is what keeps this O(n log n)-ish on real vaults
	// instead of a full n² of edit-distance matrices.
	tags.sort((a, b) => a.length - b.length || compareStrings(a, b));

	const widestBound = Math.max(options.shortMaxDistance, options.longMaxDistance);
	const parent = tags.map((_tag, index) => index);

	const find = (index: number): number => {
		let root = index;
		while ((parent[root] ?? root) !== root) root = parent[root] ?? root;
		// Path compression, so repeated lookups during the scan stay near constant time.
		let cursor = index;
		while ((parent[cursor] ?? cursor) !== cursor) {
			const next = parent[cursor] ?? cursor;
			parent[cursor] = root;
			cursor = next;
		}
		return root;
	};

	for (let i = 0; i < tags.length; i++) {
		const a = tags[i];
		if (a === undefined) continue;
		for (let j = i + 1; j < tags.length; j++) {
			const b = tags[j];
			if (b === undefined) continue;
			const lengthGap = b.length - a.length;
			if (lengthGap > widestBound) break;

			const bound =
				a.length < options.shortLengthCutoff
					? options.shortMaxDistance
					: options.longMaxDistance;
			if (bound < 1 || lengthGap > bound) continue;

			// A shared opening separates a misspelling from a coincidental near-match. The
			// requirement is capped at the shorter tag's length so two-character tags are
			// not held to an impossible standard.
			const requiredPrefix = Math.min(options.minSharedPrefix, a.length, b.length);
			if (sharedPrefixLength(a, b) < requiredPrefix) continue;

			const rootA = find(i);
			const rootB = find(j);
			if (rootA === rootB) continue;
			if (levenshtein(a, b, bound) <= bound) parent[rootB] = rootA;
		}
	}

	const components = new Map<number, string[]>();
	for (let i = 0; i < tags.length; i++) {
		const tag = tags[i];
		if (tag === undefined) continue;
		const root = find(i);
		const members = components.get(root);
		if (members) members.push(tag);
		else components.set(root, [tag]);
	}

	const groups: TagGroup[] = [];
	for (const members of components.values()) {
		if (members.length < 2) continue;
		const variants: TagVariant[] = members.map((tag) => ({
			tag,
			count: counts.get(tag) ?? 0,
		}));
		variants.sort((a, b) => b.count - a.count || compareStrings(a.tag, b.tag));
		groups.push({ canonical: pickCanonical(variants), variants });
	}
	groups.sort((a, b) => compareStrings(a.canonical, b.canonical));
	return groups;
}

/**
 * The tag the rest of a group should be merged into.
 *
 * Most used wins because that is almost always the spelling the user meant. Ties break toward
 * the shorter tag (`testing` over `testting`) and then alphabetically, so the answer never
 * depends on iteration order.
 */
function pickCanonical(variants: readonly TagVariant[]): string {
	let best = variants[0];
	if (best === undefined) return '';
	for (let i = 1; i < variants.length; i++) {
		const candidate = variants[i];
		if (candidate === undefined) continue;
		if (candidate.count > best.count) {
			best = candidate;
			continue;
		}
		if (candidate.count < best.count) continue;
		if (candidate.tag.length < best.tag.length) {
			best = candidate;
			continue;
		}
		if (
			candidate.tag.length === best.tag.length &&
			compareStrings(candidate.tag, best.tag) < 0
		) {
			best = candidate;
		}
	}
	return best.tag;
}

/* ------------------------------------------------------------- frontmatter -- */

/** Split a `tags: a, b` style scalar into its individual tag names. */
function splitTagString(value: string): string[] {
	return value
		.split(/[,\s]+/)
		.map((part) => part.trim())
		.filter((part) => part.length > 0);
}

/** Drop repeated tags, comparing normalised forms and keeping the first spelling seen. */
function dedupeTags(items: readonly unknown[]): unknown[] {
	const result: unknown[] = [];
	const seen = new Set<string>();
	for (const item of items) {
		if (typeof item !== 'string') {
			result.push(item);
			continue;
		}
		const normalized = normalizeTag(item);
		if (seen.has(normalized)) continue;
		seen.add(normalized);
		result.push(item);
	}
	return result;
}

/**
 * Whether a parsed frontmatter block carries `tag`.
 *
 * Checked before touching `processFrontMatter` at all: that call rewrites the YAML block even
 * when the callback changes nothing, so asking first is what keeps an untouched note's
 * formatting (and its mtime) intact.
 */
export function frontmatterHasTag(
	frontmatter: Record<string, unknown> | null,
	tag: string,
): boolean {
	const wanted = normalizeTag(tag);
	if (frontmatter === null || wanted.length === 0) return false;
	for (const key of FRONTMATTER_TAG_KEYS) {
		const value = frontmatter[key];
		if (Array.isArray(value)) {
			const hit = value.some(
				(item) => typeof item === 'string' && normalizeTag(item) === wanted,
			);
			if (hit) return true;
		} else if (typeof value === 'string') {
			const hit = splitTagString(value).some((item) => normalizeTag(item) === wanted);
			if (hit) return true;
		}
	}
	return false;
}

/**
 * Rename a tag inside a frontmatter object, in place.
 *
 * Written as a mutating helper because that is the shape `FileManager.processFrontMatter`
 * hands out — it gives the caller the live object and serialises whatever is left behind.
 * Values that are not strings (numbers, nested maps a user put under `tags`) are preserved
 * untouched rather than coerced, and a rename that collides with an existing tag collapses
 * into one entry instead of leaving a duplicate.
 *
 * @returns Whether anything actually changed.
 */
export function renameTagInFrontmatter(
	frontmatter: Record<string, unknown>,
	from: string,
	to: string,
): boolean {
	const fromTag = normalizeTag(from);
	const toTag = normalizeTag(to);
	if (fromTag.length === 0 || toTag.length === 0 || fromTag === toTag) return false;

	let changed = false;
	for (const key of FRONTMATTER_TAG_KEYS) {
		const value = frontmatter[key];

		if (Array.isArray(value)) {
			// `Array.isArray` on an `unknown` widens to `any[]`; keep the element type honest.
			const items: readonly unknown[] = value;
			let touched = false;
			const renamed = items.map((item: unknown): unknown => {
				if (typeof item === 'string' && normalizeTag(item) === fromTag) {
					touched = true;
					return toTag;
				}
				return item;
			});
			if (!touched) continue;
			frontmatter[key] = dedupeTags(renamed);
			changed = true;
			continue;
		}

		if (typeof value === 'string') {
			const parts = splitTagString(value);
			if (!parts.some((part) => normalizeTag(part) === fromTag)) continue;
			const renamed = parts.map((part) => (normalizeTag(part) === fromTag ? toTag : part));
			// Preserve the separator the user wrote so a comma list stays a comma list.
			const separator = value.includes(',') ? ', ' : ' ';
			frontmatter[key] = dedupeTags(renamed).join(separator);
			changed = true;
		}
	}
	return changed;
}

/* ----------------------------------------------------------- inline rewrite -- */

/** Characters that may appear inside a tag body, including the `/` of a nested tag. */
const TAG_BODY_CHAR = /[\p{L}\p{N}_/-]/u;

/**
 * Characters allowed immediately before the `#` of an inline tag.
 *
 * Exactly the prefix class the metadata parser uses (`(^|[\s(["'>])#…`), so the rewriter only
 * ever touches text Obsidian itself indexed as a tag. `{` is deliberately absent: `{#anchor}`
 * is a markdown attribute block, never a tag, and rewriting it would corrupt prose the index
 * never counted — the one thing a body rewrite must never do.
 */
const TAG_PREFIX_CHAR = /[\s(["'>]/;

const INLINE_CODE_PATTERN = /`[^`\n]*`/g;
/** Any `scheme://…` run, so a `#fragment` in a URL is never mistaken for a tag. */
const URL_PATTERN = /\b[a-z][a-z0-9+.-]*:\/\/[^\s<>"'`)\]]+/gi;
/** Markdown link and image destinations, which may carry a `#heading` anchor. */
const MARKDOWN_DESTINATION_PATTERN = /\]\([^)\n]*\)/g;
/** Wikilinks, whose `#` introduces a heading anchor rather than a tag. */
const WIKILINK_PATTERN = /\[\[[^\]\n]*\]\]/g;

/** Half-open `[start, end)` character range. */
type Span = [number, number];

/**
 * Ranges covered by fenced code blocks.
 *
 * Scanned line by line rather than with a lazy `/```[\s\S]*?```/` so an unterminated fence
 * protects everything after it — a note that ends mid-fence must not have its sample code
 * rewritten.
 */
function fencedCodeSpans(content: string): Span[] {
	const spans: Span[] = [];
	const lines = content.split('\n');
	let offset = 0;
	let openStart: number | null = null;
	let openMarker = '';

	for (const line of lines) {
		const match = /^[ \t]*(`{3,}|~{3,})/.exec(line);
		if (match) {
			const marker = (match[1] ?? '').charAt(0);
			if (openStart === null) {
				openStart = offset;
				openMarker = marker;
			} else if (marker === openMarker) {
				spans.push([openStart, offset + line.length]);
				openStart = null;
			}
		}
		offset += line.length + 1;
	}
	if (openStart !== null) spans.push([openStart, content.length]);
	return spans;
}

/** Every range an inline tag must never be rewritten inside, sorted by start offset. */
function protectedSpans(content: string): Span[] {
	const spans: Span[] = fencedCodeSpans(content);
	const patterns = [
		INLINE_CODE_PATTERN,
		URL_PATTERN,
		MARKDOWN_DESTINATION_PATTERN,
		WIKILINK_PATTERN,
	];
	for (const pattern of patterns) {
		pattern.lastIndex = 0;
		for (let match = pattern.exec(content); match !== null; match = pattern.exec(content)) {
			spans.push([match.index, match.index + match[0].length]);
		}
	}
	spans.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
	return spans;
}

/** Whether `index` falls inside any span. Relies on `spans` being sorted by start. */
function isProtected(spans: readonly Span[], index: number): boolean {
	for (const [start, end] of spans) {
		if (index < start) return false;
		if (index < end) return true;
	}
	return false;
}

/**
 * Whether the match at `[start, end)` is a whole tag rather than part of a longer one.
 *
 * The trailing check is what stops a `#project` rename from mangling `#project/subtag`: `/`
 * is a tag character, so the nested tag is simply not a match.
 */
function hasTagBoundaries(content: string, start: number, end: number): boolean {
	const before = start === 0 ? undefined : content[start - 1];
	if (before !== undefined && !TAG_PREFIX_CHAR.test(before)) return false;
	const after = content[end];
	if (after !== undefined && TAG_BODY_CHAR.test(after)) return false;
	return true;
}

/** Offset where the body starts, i.e. just past a closed frontmatter block. */
function bodyOffset(content: string): number {
	const split = splitFrontmatter(content);
	if (!split.hasBlock || split.blockLines === 0) return 0;
	const lines = content.split('\n');
	let offset = 0;
	for (let i = 0; i < split.blockLines && i < lines.length; i++) {
		offset += (lines[i]?.length ?? 0) + 1;
	}
	return Math.min(offset, content.length);
}

/**
 * Rewrite inline `#tag` occurrences in a note's body.
 *
 * Deliberately conservative about what counts as a tag:
 *  - the frontmatter block is skipped entirely, because it is rewritten through
 *    `processFrontMatter` instead (and a block whose YAML is broken must be left for the user
 *    to repair, never silently reformatted),
 *  - code fences, inline code, URLs, markdown destinations and wikilinks are masked, so a
 *    `https://example.com/#project` link and a `#project` heading anchor survive untouched,
 *  - matching is whole-tag, so `#project` never rewrites `#project/subtag`. Renaming a nested
 *    tag requires naming it in full (`project/subtag` → `work/subtag`), which is the only
 *    behaviour that cannot silently destroy a hierarchy the user built on purpose.
 *
 * Matching is case-insensitive (Obsidian treats `#Project` and `#project` as one tag) and the
 * replacement is always written in the normalised lower-case form.
 *
 * @returns The rewritten content, or the original string when nothing matched.
 */
export function rewriteInlineTags(content: string, from: string, to: string): string {
	const fromTag = normalizeTag(from);
	const toTag = normalizeTag(to);
	if (fromTag.length === 0 || toTag.length === 0 || fromTag === toTag) return content;
	if (content.length === 0) return content;

	const scanFrom = bodyOffset(content);
	const spans = protectedSpans(content);
	const pattern = new RegExp(`#${escapeRegExp(fromTag)}`, 'gi');
	pattern.lastIndex = scanFrom;

	let result = '';
	let cursor = 0;
	let replacements = 0;

	for (let match = pattern.exec(content); match !== null; match = pattern.exec(content)) {
		const start = match.index;
		const end = start + match[0].length;
		if (isProtected(spans, start)) continue;
		if (!hasTagBoundaries(content, start, end)) continue;
		result += content.slice(cursor, start) + `#${toTag}`;
		cursor = end;
		replacements++;
	}

	return replacements === 0 ? content : result + content.slice(cursor);
}

/* -------------------------------------------------------------------- service -- */

/**
 * Tag reads and writes for the rest of the plugin.
 *
 * Dependencies arrive through the constructor so a unit test can drive the whole surface with
 * an in-memory vault and a silent logger, with no plugin instance anywhere in sight.
 */
export class TagService {
	/**
	 * @param app Vault, metadata cache and file manager.
	 * @param index Source of tag counts; already maintained incrementally.
	 * @param logger Everything that fails is logged here before it is rethrown.
	 * @param getFuzzySensitivity Reads the current retrieval sensitivity, so a settings change
	 *   takes effect without rebuilding the service.
	 */
	constructor(
		private readonly app: App,
		private readonly index: VaultIndex,
		private readonly logger: Logger,
		private readonly getFuzzySensitivity: () => number = () =>
			DEFAULT_SETTINGS.retrieval.fuzzySensitivity,
	) {}

	/** Every tag in the vault with the number of notes carrying it. */
	allTags(): Map<string, number> {
		return this.index.tagCounts();
	}

	/**
	 * Tags that look like variants of each other, across the whole vault.
	 *
	 * Health scan exclusions are not applied here: the detector runs the same algorithm over
	 * its already-filtered note set, while the UI wants the complete picture.
	 */
	similarGroups(settings: HealthSettings): TagGroup[] {
		return groupSimilarTags(this.allTags(), {
			shortLengthCutoff: settings.tagShortLengthCutoff,
			shortMaxDistance: settings.tagShortMaxDistance,
			longMaxDistance: settings.tagLongMaxDistance,
			minSharedPrefix: settings.tagMinSharedPrefix,
		});
	}

	/**
	 * Autocomplete for the capture modal's tag input.
	 *
	 * An empty query lists the most used tags, which is what makes the dropdown useful before
	 * the user has typed anything. Otherwise results are ranked by fuzzy score nudged by usage
	 * ({@link USAGE_RANK_WEIGHT}), so a typo still finds the tag the vault actually uses
	 * instead of the near-identical variant nobody wants to spread further.
	 *
	 * @param limit Maximum suggestions to return.
	 */
	suggest(query: string, limit: number = DEFAULT_SUGGESTION_LIMIT): string[] {
		const max = Math.max(0, Math.floor(limit));
		if (max === 0) return [];

		const entries = Array.from(this.allTags().entries());
		const normalized = normalizeTag(query);

		if (normalized.length === 0) {
			return entries
				.sort((a, b) => b[1] - a[1] || compareStrings(a[0], b[0]))
				.slice(0, max)
				.map(([tag]) => tag);
		}

		let maxCount = 1;
		for (const [, count] of entries) {
			if (count > maxCount) maxCount = count;
		}

		const sensitivity = this.getFuzzySensitivity();
		const scored: { tag: string; count: number; rank: number }[] = [];
		for (const [tag, count] of entries) {
			const match = fuzzyMatch(normalized, tag, sensitivity);
			if (match === null) continue;
			scored.push({
				tag,
				count,
				rank: match.score + USAGE_RANK_WEIGHT * (count / maxCount),
			});
		}
		scored.sort((a, b) => b.rank - a.rank || b.count - a.count || compareStrings(a.tag, b.tag));
		return scored.slice(0, max).map((entry) => entry.tag);
	}

	/**
	 * Paths of the notes carrying a tag, sorted for a stable preview list.
	 *
	 * Matching is exact: `project` does not report notes tagged `project/subtag`, mirroring
	 * both the index and {@link rewriteInlineTags}, so the count shown in a merge preview is
	 * exactly the set of files that will be edited.
	 */
	filesWithTag(tag: string): string[] {
		const normalized = normalizeTag(tag);
		if (normalized.length === 0) return [];
		return this.index
			.withTag(normalized)
			.map((record) => record.path)
			.sort(compareStrings);
	}

	/**
	 * Rename one tag everywhere it appears in a single file.
	 *
	 * Frontmatter goes through `processFrontMatter` so Obsidian owns the YAML serialisation,
	 * and only when the tag is actually present — a note whose frontmatter failed to parse has
	 * no parsed tags, so the block is never rewritten and the user's broken YAML survives for
	 * them to fix.
	 *
	 * @returns Whether the file changed.
	 * @throws {TagRenameError} when the file could not be read or written.
	 */
	async renameTagInFile(file: TFile, from: string, to: string): Promise<boolean> {
		const fromTag = normalizeTag(from);
		const toTag = normalizeTag(to);
		if (fromTag.length === 0 || toTag.length === 0 || fromTag === toTag) return false;
		if (!isMarkdownPath(file.path)) return false;

		let changed = false;

		const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter ?? null;
		if (frontmatterHasTag(frontmatter, fromTag)) {
			try {
				await this.app.fileManager.processFrontMatter(
					file,
					(data: Record<string, unknown>) => {
						renameTagInFrontmatter(data, fromTag, toTag);
					},
				);
				changed = true;
			} catch (error) {
				this.logger.error(
					`Could not rewrite frontmatter tags in "${file.path}": ${errorMessage(error)}`,
					error,
				);
				throw new TagRenameError(file.path, STRINGS.errors.writeFailed(file.path));
			}
		}

		let content: string;
		try {
			content = await this.app.vault.read(file);
		} catch (error) {
			this.logger.error(
				`Could not read "${file.path}" while renaming #${fromTag}: ${errorMessage(error)}`,
				error,
			);
			throw new TagRenameError(file.path, STRINGS.errors.readFailed(file.path));
		}

		const next = rewriteInlineTags(content, fromTag, toTag);
		if (next !== content) {
			try {
				await this.app.vault.modify(file, next);
				changed = true;
			} catch (error) {
				this.logger.error(
					`Could not write "${file.path}" while renaming #${fromTag}: ${errorMessage(error)}`,
					error,
				);
				throw new TagRenameError(file.path, STRINGS.errors.writeFailed(file.path));
			}
		}

		if (!changed) {
			this.logger.debug(`No #${fromTag} occurrences in "${file.path}"`);
		}
		return changed;
	}
}
