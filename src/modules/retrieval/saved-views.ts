/**
 * Saved views: the built-in set plus whatever the user creates.
 *
 * Built-ins live in code rather than in settings so a plugin update can add or fix one
 * without migrating anybody's data; settings only store the per-view overrides (pinned,
 * hidden, order). Three of them — orphans, notes without tags, unlinked mentions — cannot
 * be expressed as filters and are marked `special` for the service to handle.
 *
 * Date filters accept relative tokens (`today`, `today-7`) that resolve at query time, so
 * "Recent notes" keeps meaning the last seven days instead of freezing on the day it was
 * created.
 */

import type { Filter, SavedView, SearchQuery, SortSpec } from '../../types/search';
import type { RetrievalSettings } from '../../types/settings';
import { STRINGS } from '../../core/strings';
import { formatDate, MS_PER_DAY, startOfDay } from '../../utils/date';

const DEFAULT_SORT: SortSpec = { field: 'modified', direction: 'desc' };

/** Views that ship with the plugin. */
export const BUILT_IN_VIEWS: readonly SavedView[] = [
	{
		id: 'built-in:recent',
		name: STRINGS.find.builtInViews.recent,
		icon: '🕒',
		filters: [
			{ id: 'recent-modified', field: 'modified', operator: 'after', value: 'today-7' },
		],
		logic: 'and',
		sort: DEFAULT_SORT,
		builtIn: true,
		pinned: true,
		order: 0,
	},
	{
		id: 'built-in:edited-today',
		name: STRINGS.find.builtInViews.editedToday,
		icon: '📅',
		filters: [{ id: 'today-modified', field: 'modified', operator: 'after', value: 'today-0' }],
		logic: 'and',
		sort: DEFAULT_SORT,
		builtIn: true,
		pinned: false,
		order: 1,
	},
	{
		id: 'built-in:inbox',
		name: STRINGS.find.builtInViews.inbox,
		icon: '📥',
		filters: [{ id: 'inbox-status', field: 'status', operator: 'is', value: 'inbox' }],
		logic: 'and',
		sort: { field: 'created', direction: 'desc' },
		builtIn: true,
		pinned: false,
		order: 2,
	},
	{
		id: 'built-in:orphans',
		name: STRINGS.find.builtInViews.orphans,
		icon: '🔗',
		filters: [],
		logic: 'and',
		sort: DEFAULT_SORT,
		builtIn: true,
		pinned: false,
		order: 3,
		special: 'orphans',
	},
	{
		id: 'built-in:no-tags',
		name: STRINGS.find.builtInViews.noTags,
		icon: '🏷️',
		filters: [],
		logic: 'and',
		sort: DEFAULT_SORT,
		builtIn: true,
		pinned: false,
		order: 4,
		special: 'no-tags',
	},
	{
		id: 'built-in:unlinked-mentions',
		name: STRINGS.find.builtInViews.unlinkedMentions,
		icon: '💡',
		filters: [],
		logic: 'and',
		sort: DEFAULT_SORT,
		builtIn: true,
		pinned: false,
		order: 5,
		special: 'unlinked-mentions',
	},
];

/**
 * Every view the user should see, built-ins merged with their overrides and custom views
 * appended, ordered for display.
 */
export function resolveViews(settings: RetrievalSettings): SavedView[] {
	const builtIns = BUILT_IN_VIEWS.map((view) => {
		const state = settings.builtInViewState[view.id];
		return state
			? { ...view, pinned: state.pinned, hidden: state.hidden, order: state.order }
			: view;
	}).filter((view) => view.hidden !== true);

	const customs = settings.customViews.map((view) => ({ ...view, builtIn: false }));

	return [...builtIns, ...customs].sort(
		(a, b) =>
			Number(b.pinned) - Number(a.pinned) ||
			a.order - b.order ||
			a.name.localeCompare(b.name),
	);
}

/** Look up one view by id across built-ins and custom views. */
export function findView(settings: RetrievalSettings, id: string): SavedView | null {
	return resolveViews(settings).find((view) => view.id === id) ?? null;
}

/**
 * Expand a relative date token into an absolute `YYYY-MM-DD` value.
 *
 * Accepts `today`, `today-N` and `today+N`; anything else passes through untouched.
 */
export function resolveDateToken(value: string, now: number): string {
	const trimmed = value.trim();
	const match = /^today\s*(?:([+-])\s*(\d+))?$/i.exec(trimmed);
	if (!match) return trimmed;

	const sign = match[1] === '-' ? -1 : 1;
	const days = Number(match[2] ?? 0);
	return formatDate(startOfDay(now) + sign * days * MS_PER_DAY, 'YYYY-MM-DD');
}

/** Resolve every relative token inside a filter set. */
export function resolveFilters(filters: readonly Filter[], now: number): Filter[] {
	return filters.map((filter) => {
		if (filter.field !== 'created' && filter.field !== 'modified') return filter;
		const resolved: Filter = {
			...filter,
			value: resolveDateToken(filter.value, now),
		};
		return filter.value2 === undefined
			? resolved
			: { ...resolved, value2: resolveDateToken(filter.value2, now) };
	});
}

/** Turn a view plus a keyword into an executable query. */
export function viewToQuery(
	view: SavedView,
	keyword: string,
	now: number,
	limit?: number,
	offset?: number,
): SearchQuery {
	return {
		keyword,
		filters: resolveFilters(view.filters, now),
		logic: view.logic,
		sort: view.sort,
		...(limit !== undefined ? { limit } : {}),
		...(offset !== undefined ? { offset } : {}),
	};
}

/** Generate an id for a new custom view. */
export function newViewId(now: number, existing: readonly SavedView[]): string {
	const base = `view:${now.toString(36)}`;
	if (!existing.some((view) => view.id === base)) return base;
	for (let suffix = 2; suffix < 1000; suffix++) {
		const candidate = `${base}-${suffix}`;
		if (!existing.some((view) => view.id === candidate)) return candidate;
	}
	return `${base}-${existing.length}`;
}

/** A blank custom view, ready for the editor. */
export function createEmptyView(now: number, existing: readonly SavedView[]): SavedView {
	return {
		id: newViewId(now, existing),
		name: '',
		icon: '⭐',
		filters: [],
		logic: 'and',
		sort: DEFAULT_SORT,
		builtIn: false,
		pinned: false,
		order: existing.length + BUILT_IN_VIEWS.length,
	};
}
