/**
 * Search and filtering.
 *
 * Two layers: filters narrow the candidate set using only indexed metadata (cheap, no file
 * reads), then the keyword pass scores what survives. Bodies are only read when a keyword
 * is actually present, so a pure filter query never touches the disk.
 *
 * Relevance weights a title hit far above a body hit, because "I half-remember the name" is
 * the query this feature exists to answer.
 */

import type { NoteRecord } from '../../types/note';
import type {
	Filter,
	SearchQuery,
	SearchResponse,
	SearchResult,
	SortSpec,
} from '../../types/search';
import type { JemzSettings } from '../../types/settings';
import { fuzzyMatch, positionsToRanges } from '../../utils/fuzzy-match';
import { parseDateValue, startOfDay } from '../../utils/date';
import { isInAnyFolder } from '../../utils/file';
import { contextSnippet, normalizeTag, previewText, truncate } from '../../utils/string';
import type { ContentIndex } from '../../services/content-index';
import type { VaultIndex } from '../../services/vault-index';

/**
 * Render a frontmatter value as comparable text.
 *
 * Frontmatter is user data and can hold anything YAML allows. A blind `String(value)` turns
 * a list into `[object Object]`, so a filter on a list-valued property would silently match
 * nothing; joining the members instead makes `is`/`contains` behave the way a user expects.
 */
function frontmatterText(value: unknown): string {
	if (value === undefined || value === null) return '';
	if (Array.isArray(value)) return value.map((item) => frontmatterText(item)).join(', ');
	if (typeof value === 'object') {
		try {
			return JSON.stringify(value) ?? '';
		} catch {
			return '';
		}
	}
	// eslint-disable-next-line @typescript-eslint/no-base-to-string -- primitives only by here.
	return String(value);
}

/** How much a title hit outweighs a body hit. */
const TITLE_WEIGHT = 0.75;
const BODY_WEIGHT = 0.25;

/** Characters of context either side of a body match. */
const SNIPPET_RADIUS = 48;

export class SearchEngine {
	constructor(
		private readonly index: VaultIndex,
		private readonly content: ContentIndex,
		private readonly getSettings: () => JemzSettings,
		private readonly now: () => number = Date.now,
	) {}

	/**
	 * Run a query.
	 *
	 * @returns Results plus the pre-pagination total, so the UI can show "50 of 214".
	 */
	async search(query: SearchQuery): Promise<SearchResponse> {
		const startedAt = this.now();
		const settings = this.getSettings();
		const keyword = query.keyword.trim();

		let candidates = this.index.notes();
		if (settings.retrieval.excludeArchivedFromViews) {
			candidates = candidates.filter((record) => record.status?.toLowerCase() !== 'archived');
		}

		const filtered = candidates.filter((record) =>
			this.matchesFilters(record, query.filters, query.logic),
		);

		// Only pay for file reads when the query actually needs body text.
		const needsBody = keyword.length > 0 || query.filters.some((f) => f.field === 'word-count');
		if (needsBody) await this.content.ensureLoaded(filtered);

		const wordCountFiltered = needsBody
			? filtered.filter((record) =>
					this.matchesFilters(record, query.filters, query.logic, true),
				)
			: filtered;

		const scored: SearchResult[] = [];
		for (const record of wordCountFiltered) {
			const result = this.score(record, keyword, settings.retrieval.fuzzySensitivity);
			if (result) scored.push(result);
		}

		const sorted = this.sort(scored, query.sort);
		const offset = Math.max(0, query.offset ?? 0);
		const limit = query.limit ?? settings.retrieval.resultsPerPage;

		return {
			results: sorted.slice(offset, offset + limit),
			total: sorted.length,
			durationMs: this.now() - startedAt,
		};
	}

	/**
	 * Whether a record satisfies the filter set.
	 *
	 * @param withContent Pass true only after bodies are loaded; content-dependent filters
	 *   are skipped (treated as passing) otherwise so the cheap pass never wrongly excludes.
	 */
	matchesFilters(
		record: NoteRecord,
		filters: readonly Filter[],
		logic: 'and' | 'or',
		withContent = false,
	): boolean {
		if (filters.length === 0) return true;
		const results = filters.map((filter) => this.matchesFilter(record, filter, withContent));
		return logic === 'or' ? results.some(Boolean) : results.every(Boolean);
	}

	private matchesFilter(record: NoteRecord, filter: Filter, withContent: boolean): boolean {
		const value = filter.value.trim();

		switch (filter.field) {
			case 'keyword': {
				const haystack = `${record.basename}\n${withContent ? (this.content.peekBody(record.path) ?? '') : ''}`;
				return this.textOperator(haystack, filter.operator, value);
			}
			case 'tag': {
				const wanted = normalizeTag(value);
				const has =
					wanted.length > 0 &&
					record.tags.some((tag) => tag === wanted || tag.startsWith(`${wanted}/`));
				return filter.operator === 'not-contains' ? !has : has;
			}
			case 'folder': {
				const folders = value
					.split(',')
					.map((folder) => folder.trim())
					.filter((folder) => folder.length > 0);
				const inside = folders.length === 0 || isInAnyFolder(record.path, folders);
				return filter.operator === 'is-not-in' ? !inside : inside;
			}
			case 'frontmatter': {
				const key = filter.key?.trim();
				if (!key) return true;
				const text = frontmatterText(record.frontmatter?.[key]);
				if (filter.operator === 'contains') {
					return text.toLowerCase().includes(value.toLowerCase());
				}
				const equal = text.toLowerCase() === value.toLowerCase();
				return filter.operator === 'is-not' ? !equal : equal;
			}
			case 'created':
				return this.dateOperator(record.created, filter);
			case 'modified':
				return this.dateOperator(record.modified, filter);
			case 'status': {
				const equal = (record.status ?? '').toLowerCase() === value.toLowerCase();
				return filter.operator === 'is-not' ? !equal : equal;
			}
			case 'type': {
				const equal = (record.type ?? '').toLowerCase() === value.toLowerCase();
				return filter.operator === 'is-not' ? !equal : equal;
			}
			case 'has-backlinks': {
				const has = record.backlinks.length > 0;
				return filter.operator === 'no' ? !has : has;
			}
			case 'has-attachments': {
				const has = record.links.some((link) => {
					if (!link.resolvedPath) return false;
					const target = this.index.get(link.resolvedPath);
					return target?.isAttachment === true;
				});
				return filter.operator === 'no' ? !has : has;
			}
			case 'word-count': {
				if (!withContent) return true;
				const stats = this.content.peekStats(record.path);
				if (!stats) return false;
				const threshold = Number(value);
				if (!Number.isFinite(threshold)) return true;
				return filter.operator === 'less-than'
					? stats.wordCount < threshold
					: stats.wordCount > threshold;
			}
			default:
				return true;
		}
	}

	private textOperator(haystack: string, operator: string, needle: string): boolean {
		if (needle.length === 0) return true;
		const text = haystack.toLowerCase();
		const value = needle.toLowerCase();
		switch (operator) {
			case 'not-contains':
				return !text.includes(value);
			case 'starts-with':
				return text.trimStart().startsWith(value);
			case 'ends-with':
				return text.trimEnd().endsWith(value);
			case 'contains':
			default:
				return text.includes(value);
		}
	}

	private dateOperator(timestamp: number, filter: Filter): boolean {
		const first = parseDateValue(filter.value);
		if (first === null) return true;
		const day = startOfDay(timestamp);

		switch (filter.operator) {
			case 'before':
				return day < startOfDay(first);
			case 'after':
				return day > startOfDay(first);
			case 'between': {
				const second = parseDateValue(filter.value2 ?? '');
				if (second === null) return day >= startOfDay(first);
				const low = Math.min(startOfDay(first), startOfDay(second));
				const high = Math.max(startOfDay(first), startOfDay(second));
				return day >= low && day <= high;
			}
			default:
				return true;
		}
	}

	/** Score one record against the keyword, or accept it unscored when there is none. */
	private score(record: NoteRecord, keyword: string, sensitivity: number): SearchResult | null {
		if (keyword.length === 0) {
			return this.buildResult(
				record,
				1,
				previewText(this.content.peekBody(record.path) ?? '', 160),
				[],
			);
		}

		const titleMatch = fuzzyMatch(keyword, record.basename, sensitivity);
		const body = this.content.peekBody(record.path) ?? '';
		const bodyIndex = body.toLowerCase().indexOf(keyword.toLowerCase());

		if (!titleMatch && bodyIndex === -1) return null;

		const titleScore = titleMatch?.score ?? 0;
		const bodyScore =
			bodyIndex === -1 ? 0 : 1 - Math.min(bodyIndex / Math.max(body.length, 1), 0.5);
		const score = Math.min(1, titleScore * TITLE_WEIGHT + bodyScore * BODY_WEIGHT);

		if (bodyIndex !== -1) {
			const { snippet, range } = contextSnippet(
				body,
				bodyIndex,
				bodyIndex + keyword.length,
				SNIPPET_RADIUS,
			);
			return this.buildResult(record, score, snippet, [range]);
		}

		// Title-only match: highlight inside the title itself.
		const ranges = positionsToRanges(titleMatch?.positions ?? []);
		return this.buildResult(record, score, truncate(record.basename, 160), ranges);
	}

	private buildResult(
		record: NoteRecord,
		score: number,
		snippet: string,
		matches: readonly (readonly [number, number])[],
	): SearchResult {
		return {
			path: record.path,
			title: record.basename,
			folder: record.folder,
			tags: record.tags,
			created: record.created,
			modified: record.modified,
			score,
			snippet,
			matches,
		};
	}

	private sort(results: SearchResult[], sort: SortSpec): SearchResult[] {
		const direction = sort.direction === 'asc' ? 1 : -1;
		return results.slice().sort((a, b) => {
			let comparison = 0;
			switch (sort.field) {
				case 'relevance':
					comparison = a.score - b.score;
					break;
				case 'created':
					comparison = a.created - b.created;
					break;
				case 'modified':
					comparison = a.modified - b.modified;
					break;
				case 'title':
					comparison = a.title.localeCompare(b.title);
					break;
				case 'word-count': {
					const aCount = this.content.peekStats(a.path)?.wordCount ?? 0;
					const bCount = this.content.peekStats(b.path)?.wordCount ?? 0;
					comparison = aCount - bCount;
					break;
				}
			}
			// Ties resolve by path so results never reshuffle between identical queries.
			return comparison === 0 ? a.path.localeCompare(b.path) : comparison * direction;
		});
	}
}
