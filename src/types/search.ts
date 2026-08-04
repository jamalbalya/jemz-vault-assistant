/** Retrieval types: filters, saved views, queries, and results. */

export const FILTER_FIELDS = [
	'keyword',
	'tag',
	'folder',
	'frontmatter',
	'created',
	'modified',
	'status',
	'type',
	'has-backlinks',
	'has-attachments',
	'word-count',
] as const;

export type FilterField = (typeof FILTER_FIELDS)[number];

export const FILTER_OPERATORS = [
	'contains',
	'not-contains',
	'starts-with',
	'ends-with',
	'is',
	'is-not',
	'is-in',
	'is-not-in',
	'before',
	'after',
	'between',
	'yes',
	'no',
	'greater-than',
	'less-than',
] as const;

export type FilterOperator = (typeof FILTER_OPERATORS)[number];

/** Operators each field accepts, used to build the filter UI and to validate saved views. */
export const OPERATORS_BY_FIELD: Readonly<Record<FilterField, readonly FilterOperator[]>> = {
	keyword: ['contains', 'not-contains', 'starts-with', 'ends-with'],
	tag: ['contains', 'not-contains'],
	folder: ['is-in', 'is-not-in'],
	frontmatter: ['is', 'is-not', 'contains'],
	created: ['before', 'after', 'between'],
	modified: ['before', 'after', 'between'],
	status: ['is', 'is-not'],
	type: ['is', 'is-not'],
	'has-backlinks': ['yes', 'no'],
	'has-attachments': ['yes', 'no'],
	'word-count': ['greater-than', 'less-than'],
};

/** A single filter clause. */
export interface Filter {
	readonly id: string;
	readonly field: FilterField;
	readonly operator: FilterOperator;
	/** Primary operand. Dates use `YYYY-MM-DD`. */
	readonly value: string;
	/** Second operand, only used by `between`. */
	readonly value2?: string;
	/** Frontmatter property name, only used by the `frontmatter` field. */
	readonly key?: string;
}

export const SORT_FIELDS = ['relevance', 'created', 'modified', 'title', 'word-count'] as const;
export type SortField = (typeof SORT_FIELDS)[number];
export type SortDirection = 'asc' | 'desc';

export interface SortSpec {
	readonly field: SortField;
	readonly direction: SortDirection;
}

/** A named, persisted set of filters. */
export interface SavedView {
	readonly id: string;
	readonly name: string;
	/** Emoji shown next to the view name. */
	readonly icon: string;
	readonly filters: readonly Filter[];
	readonly logic: 'and' | 'or';
	readonly sort: SortSpec;
	/** Built-in views ship with the plugin and cannot be deleted, only hidden. */
	readonly builtIn: boolean;
	readonly pinned: boolean;
	readonly order: number;
	/** Built-in views that need bespoke logic (orphans, unlinked mentions) name it here. */
	readonly special?: 'orphans' | 'unlinked-mentions' | 'no-tags';
	readonly hidden?: boolean;
}

/** A full retrieval request. */
export interface SearchQuery {
	readonly keyword: string;
	readonly filters: readonly Filter[];
	readonly logic: 'and' | 'or';
	readonly sort: SortSpec;
	readonly limit?: number;
	readonly offset?: number;
}

/** One matched note. */
export interface SearchResult {
	readonly path: string;
	readonly title: string;
	readonly folder: string;
	readonly tags: readonly string[];
	readonly created: number;
	readonly modified: number;
	/** 0-1 relevance; 1 when no keyword was supplied. */
	readonly score: number;
	readonly snippet: string;
	/** Character ranges inside `snippet` that matched, for highlighting. */
	readonly matches: readonly (readonly [number, number])[];
}

export interface SearchResponse {
	readonly results: readonly SearchResult[];
	readonly total: number;
	readonly durationMs: number;
}

/** A note created on this month/day in an earlier year. */
export interface OnThisDayEntry {
	readonly year: number;
	readonly notes: readonly {
		readonly path: string;
		readonly title: string;
		readonly created: number;
	}[];
}

/** A plain-text occurrence of a note title that is not a link. */
export interface UnlinkedMention {
	readonly sourcePath: string;
	readonly targetPath: string;
	readonly targetTitle: string;
	readonly line: number;
	readonly col: number;
	readonly matchedText: string;
	readonly context: string;
	/** Offsets of the match inside `context`. */
	readonly contextRange: readonly [number, number];
}

/** A note that has not been touched for a while. */
export interface StaleNote {
	readonly path: string;
	readonly title: string;
	readonly modified: number;
	readonly daysStale: number;
}

/** A note similar to a reference note, with the reasons why. */
export interface SimilarNote {
	readonly path: string;
	readonly title: string;
	readonly score: number;
	readonly sharedTags: readonly string[];
	readonly sharedLinks: readonly string[];
	readonly titleSimilarity: number;
}
