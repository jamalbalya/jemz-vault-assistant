/**
 * The note row shared by the inbox, health, and search lists.
 *
 * One renderer keeps spacing, icon placement, and keyboard focus behaviour identical across
 * the three tabs, and gives every row a real `tabindex` so the whole plugin is navigable
 * without a mouse.
 */

import { setIcon } from 'obsidian';
import { createButton, type ButtonOptions } from './button';

export interface ListItemOptions {
	/** Primary line. */
	title: string;
	/** Lucide icon shown before the title. */
	icon?: string;
	/** Small items under the title, e.g. date, folder, source domain. */
	meta?: readonly string[];
	/** Secondary line of body text. */
	preview?: string;
	/** Pill labels, e.g. tags. */
	badges?: readonly string[];
	/** Action buttons rendered on the right (or below, on mobile). */
	actions?: readonly ButtonOptions[];
	/** Checkbox for multi-select lists. */
	selectable?: boolean;
	selected?: boolean;
	onSelectChange?: (selected: boolean) => void;
	/** Invoked when the row itself is activated by click, Enter, or Space. */
	onActivate?: () => void;
	cls?: string;
}

/** Render one row into `parent`. */
export function renderListItem(parent: HTMLElement, options: ListItemOptions): HTMLElement {
	const row = parent.createDiv({ cls: 'jva-list-item' });
	if (options.cls) row.addClass(options.cls);

	if (options.selectable) {
		const checkbox = row.createEl('input', {
			cls: 'jva-list-item__checkbox',
			type: 'checkbox',
		});
		checkbox.checked = options.selected ?? false;
		checkbox.setAttr('aria-label', `Select ${options.title}`);
		checkbox.addEventListener('change', () => options.onSelectChange?.(checkbox.checked));
		// Selecting must not also open the note.
		checkbox.addEventListener('click', (event) => event.stopPropagation());
	}

	const main = row.createDiv({ cls: 'jva-list-item__main' });

	const titleRow = main.createDiv({ cls: 'jva-list-item__title-row' });
	if (options.icon) {
		const iconEl = titleRow.createSpan({ cls: 'jva-list-item__icon' });
		setIcon(iconEl, options.icon);
	}
	titleRow.createSpan({ cls: 'jva-list-item__title', text: options.title });

	if (options.meta && options.meta.length > 0) {
		const metaRow = main.createDiv({ cls: 'jva-list-item__meta' });
		options.meta
			.filter((entry) => entry.trim().length > 0)
			.forEach((entry, index, list) => {
				metaRow.createSpan({ cls: 'jva-list-item__meta-item', text: entry });
				if (index < list.length - 1) {
					metaRow.createSpan({ cls: 'jva-list-item__meta-sep', text: '·' });
				}
			});
	}

	if (options.preview && options.preview.length > 0) {
		main.createDiv({ cls: 'jva-list-item__preview', text: options.preview });
	}

	if (options.badges && options.badges.length > 0) {
		const badgeRow = main.createDiv({ cls: 'jva-list-item__badges' });
		for (const badge of options.badges) {
			badgeRow.createSpan({ cls: 'jva-badge', text: badge });
		}
	}

	if (options.actions && options.actions.length > 0) {
		const actionRow = row.createDiv({ cls: 'jva-list-item__actions' });
		for (const action of options.actions) {
			const button = createButton(actionRow, action);
			// Row activation should not fire when an action button is pressed.
			button.addEventListener('click', (event) => event.stopPropagation());
		}
	}

	if (options.onActivate) {
		row.addClass('is-clickable');
		row.setAttr('tabindex', '0');
		row.setAttr('role', 'button');
		row.addEventListener('click', () => options.onActivate?.());
		row.addEventListener('keydown', (event) => {
			if (event.key === 'Enter' || event.key === ' ') {
				event.preventDefault();
				options.onActivate?.();
			}
		});
	}

	return row;
}

/** A section heading with an optional count badge, used above grouped lists. */
export function renderSectionHeading(
	parent: HTMLElement,
	title: string,
	count?: number,
): HTMLElement {
	const heading = parent.createDiv({ cls: 'jva-section-heading' });
	heading.createSpan({ cls: 'jva-section-heading__title', text: title });
	if (count !== undefined) {
		heading.createSpan({ cls: 'jva-section-heading__count', text: String(count) });
	}
	return heading;
}

/** Pagination controls. Returns nothing when there is only one page. */
export function renderPagination(
	parent: HTMLElement,
	options: {
		page: number;
		pageCount: number;
		label: string;
		onChange: (page: number) => void;
	},
): HTMLElement | null {
	if (options.pageCount <= 1) return null;

	const nav = parent.createDiv({ cls: 'jva-pagination' });
	createButton(nav, {
		icon: 'chevron-left',
		tooltip: 'Previous page',
		disabled: options.page <= 1,
		onClick: () => options.onChange(options.page - 1),
	});
	nav.createSpan({ cls: 'jva-pagination__label', text: options.label });
	createButton(nav, {
		icon: 'chevron-right',
		tooltip: 'Next page',
		disabled: options.page >= options.pageCount,
		onClick: () => options.onChange(options.page + 1),
	});
	return nav;
}
