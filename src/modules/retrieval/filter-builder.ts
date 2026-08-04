/**
 * The editable filter list shared by the Find tab and the saved-view editor.
 *
 * One component instead of two, because a saved view is nothing more than a frozen copy of
 * what the Find tab's rows currently say (main spec 7.2). A single renderer guarantees that a
 * view built in the modal produces exactly the query the tab would have produced, and that
 * adding a field to {@link OPERATORS_BY_FIELD} lights it up in both places.
 *
 * The operator list is never hard coded: it is read from `OPERATORS_BY_FIELD` every time the
 * field changes, so an operator a field does not accept can never reach a saved view.
 */

import { ICONS } from '../../core/constants';
import { STRINGS } from '../../core/strings';
import {
	FILTER_FIELDS,
	OPERATORS_BY_FIELD,
	type Filter,
	type FilterField,
	type FilterOperator,
} from '../../types/search';
import { createButton } from '../../ui/components/button';
import { resolveDateToken } from './saved-views';

/** How the rows combine. */
export type FilterLogic = 'and' | 'or';

/**
 * What kind of operand a field needs.
 *
 * `none` exists because "has backlinks: yes" already carries its own value — an empty text box
 * beside it would invite the user to type something that is then silently ignored.
 */
export type FilterValueKind = 'none' | 'date' | 'number' | 'text';

/** Operand widget a field expects. */
export function valueKindFor(field: FilterField): FilterValueKind {
	switch (field) {
		case 'created':
		case 'modified':
			return 'date';
		case 'has-backlinks':
		case 'has-attachments':
			return 'none';
		case 'word-count':
			return 'number';
		default:
			return 'text';
	}
}

/** Whether a field/operator pair needs a second operand. */
export function needsSecondValue(field: FilterField, operator: FilterOperator): boolean {
	return valueKindFor(field) === 'date' && operator === 'between';
}

/** The operator to fall back to when a field cannot keep the one currently selected. */
export function defaultOperatorFor(field: FilterField): FilterOperator {
	return OPERATORS_BY_FIELD[field][0] ?? 'contains';
}

/** Refill an operator select from {@link OPERATORS_BY_FIELD}, keeping `current` when valid. */
export function fillOperators(
	select: HTMLSelectElement,
	field: FilterField,
	current: FilterOperator,
): void {
	select.empty();
	const operators = OPERATORS_BY_FIELD[field];
	for (const operator of operators) {
		select.createEl('option', { value: operator, text: STRINGS.find.operators[operator] });
	}
	select.value = operators.includes(current) ? current : defaultOperatorFor(field);
}

/** Session-unique suffix for generated ids and datalist references. */
let idSequence = 0;

/** A blank row for a field, using that field's first operator. */
export function blankFilter(field: FilterField = 'keyword'): Filter {
	return {
		id: `jva-filter-${Date.now().toString(36)}-${(idSequence += 1)}`,
		field,
		operator: defaultOperatorFor(field),
		value: '',
	};
}

export interface FilterBuilderOptions {
	/** Rows present when the control is created. */
	initialFilters?: readonly Filter[];
	initialLogic?: FilterLogic;
	/** Folder paths offered as datalist suggestions for the folder field. */
	folderSuggestions?: readonly string[];
	/** Tags offered as datalist suggestions for the tag field. */
	tagSuggestions?: readonly string[];
	/** Clock used to expand relative date tokens (`today-7`) for display. */
	now?: () => number;
	/** Fired after any edit, with the complete current state. */
	onChange: (filters: readonly Filter[], logic: FilterLogic) => void;
}

export class FilterBuilder {
	private readonly rootEl: HTMLElement;
	private readonly rowsEl: HTMLElement;
	private readonly logicSelectEl: HTMLSelectElement;
	private readonly listId: string;
	private readonly cleanups: (() => void)[] = [];
	private readonly now: () => number;
	private rows: Filter[];
	private logicValue: FilterLogic;
	/** Suppressed while {@link setState} rebuilds, so loading a view is not reported as an edit. */
	private silent = false;

	constructor(
		parent: HTMLElement,
		private readonly options: FilterBuilderOptions,
	) {
		this.now = options.now ?? Date.now;
		this.rows = [...(options.initialFilters ?? [])];
		this.logicValue = options.initialLogic ?? 'and';
		this.listId = `jva-filters-${(idSequence += 1)}`;

		this.rootEl = parent.createDiv({ cls: 'jva-filters' });
		this.logicSelectEl = this.renderLogic();
		this.rowsEl = this.rootEl.createDiv({ cls: 'jva-filters__rows' });
		this.renderSuggestionLists();
		this.renderActions();
		this.renderRows();
	}

	/** Current rows, in display order. */
	get filters(): readonly Filter[] {
		return this.rows;
	}

	/** Current AND/OR selection. */
	get logic(): FilterLogic {
		return this.logicValue;
	}

	/** The element this builder owns, so a caller can move or hide it. */
	get element(): HTMLElement {
		return this.rootEl;
	}

	/** Replace the rows and logic without reporting a change back to the owner. */
	setState(filters: readonly Filter[], logic: FilterLogic): void {
		this.silent = true;
		try {
			this.rows = [...filters];
			this.logicValue = logic;
			this.logicSelectEl.value = logic;
			this.renderRows();
		} finally {
			this.silent = false;
		}
	}

	/** Append a blank row and report it. */
	addFilter(field: FilterField = 'keyword'): void {
		this.rows.push(blankFilter(field));
		this.renderRows();
		this.emit();
	}

	/** Release every listener this builder registered and detach its DOM. */
	destroy(): void {
		for (const cleanup of this.cleanups.splice(0)) cleanup();
		this.rootEl.detach();
	}

	/* ----------------------------------------------------------------- render -- */

	private renderLogic(): HTMLSelectElement {
		const row = this.rootEl.createDiv({ cls: 'jva-filters__logic' });
		const selectId = `${this.listId}-logic`;

		const label = row.createEl('label', { text: STRINGS.find.viewLogicLabel });
		label.setAttr('for', selectId);

		const select = row.createEl('select', { cls: 'dropdown jva-filters__logic-select' });
		select.setAttr('id', selectId);
		select.setAttr('aria-label', STRINGS.find.viewLogicLabel);
		select.createEl('option', { value: 'and', text: STRINGS.find.viewLogicAnd });
		select.createEl('option', { value: 'or', text: STRINGS.find.viewLogicOr });
		select.value = this.logicValue;

		this.on(select, 'change', () => {
			this.logicValue = select.value === 'or' ? 'or' : 'and';
			this.emit();
		});
		return select;
	}

	/**
	 * Datalists for folders and tags.
	 *
	 * A datalist suggests without constraining, which matters because a filter may legitimately
	 * name a folder or tag that does not exist yet.
	 */
	private renderSuggestionLists(): void {
		const folders = this.rootEl.createEl('datalist');
		folders.setAttr('id', `${this.listId}-folders`);
		for (const folder of this.options.folderSuggestions ?? []) {
			folders.createEl('option', { value: folder });
		}

		const tags = this.rootEl.createEl('datalist');
		tags.setAttr('id', `${this.listId}-tags`);
		for (const tag of this.options.tagSuggestions ?? []) {
			tags.createEl('option', { value: tag });
		}
	}

	private renderActions(): void {
		const actions = this.rootEl.createDiv({ cls: 'jva-filters__actions' });
		createButton(actions, {
			label: STRINGS.find.addFilter,
			icon: ICONS.capture,
			onClick: () => this.addFilter(),
		});
	}

	private renderRows(): void {
		this.rowsEl.empty();
		this.rows.forEach((filter, index) => this.renderRow(filter, index));
	}

	private renderRow(filter: Filter, index: number): void {
		const row = this.rowsEl.createDiv({ cls: 'jva-filter-row' });
		row.setAttr('data-filter-id', filter.id);

		const fieldSelect = row.createEl('select', { cls: 'dropdown jva-filter-row__field' });
		fieldSelect.setAttr('aria-label', STRINGS.find.addFilter);
		for (const field of FILTER_FIELDS) {
			fieldSelect.createEl('option', { value: field, text: STRINGS.find.fields[field] });
		}
		fieldSelect.value = filter.field;
		this.on(fieldSelect, 'change', () => this.onFieldChanged(index, fieldSelect.value));

		const operatorSelect = row.createEl('select', { cls: 'dropdown jva-filter-row__operator' });
		operatorSelect.setAttr('aria-label', STRINGS.find.fields[filter.field]);
		fillOperators(operatorSelect, filter.field, filter.operator);
		this.on(operatorSelect, 'change', () =>
			this.onOperatorChanged(index, operatorSelect.value),
		);

		// The property name reads before the comparison: "Property — status — is — inbox".
		if (filter.field === 'frontmatter') {
			const keyInput = row.createEl('input', {
				cls: 'jva-filter-row__value jva-filter-row__key',
				type: 'text',
			});
			keyInput.value = filter.key ?? '';
			keyInput.setAttr('aria-label', STRINGS.find.fields.frontmatter);
			this.on(keyInput, 'input', () => this.updateFilter(index, { key: keyInput.value }));
		}

		this.renderValueInputs(row, filter, index);

		createButton(row, {
			icon: ICONS.close,
			tooltip: STRINGS.find.removeFilter,
			cls: 'jva-filter-row__remove',
			onClick: () => this.removeFilter(index),
		});
	}

	private renderValueInputs(row: HTMLElement, filter: Filter, index: number): void {
		const kind = valueKindFor(filter.field);
		if (kind === 'none') return;

		const primary = row.createEl('input', {
			cls: 'jva-filter-row__value',
			type: inputTypeFor(kind),
		});
		// Assigned after the element exists so the browser parses it against the final type.
		primary.value = this.displayValue(filter.field, filter.value);
		primary.setAttr('aria-label', STRINGS.find.fields[filter.field]);
		this.applySuggestionList(primary, filter.field);
		this.on(primary, 'input', () => this.updateFilter(index, { value: primary.value }));

		if (!needsSecondValue(filter.field, filter.operator)) return;

		const secondary = row.createEl('input', {
			cls: 'jva-filter-row__value jva-filter-row__value2',
			type: 'date',
		});
		secondary.value = this.displayValue(filter.field, filter.value2 ?? '');
		secondary.setAttr('aria-label', STRINGS.find.fields[filter.field]);
		this.on(secondary, 'input', () => this.updateFilter(index, { value2: secondary.value }));
	}

	private applySuggestionList(input: HTMLInputElement, field: FilterField): void {
		if (field === 'folder') input.setAttr('list', `${this.listId}-folders`);
		else if (field === 'tag') input.setAttr('list', `${this.listId}-tags`);
	}

	/**
	 * What to show in a date box.
	 *
	 * Built-in views store relative tokens (`today-7`) that a native date input cannot render,
	 * so the token is expanded for display while the stored value stays relative until the user
	 * actually picks a date. That is what keeps "Recent notes" meaning the last seven days
	 * instead of freezing on the day the view was first opened.
	 */
	private displayValue(field: FilterField, value: string): string {
		if (valueKindFor(field) !== 'date') return value;
		const trimmed = value.trim();
		if (trimmed.length === 0) return '';
		if (isIsoDate(trimmed)) return trimmed;
		const resolved = resolveDateToken(trimmed, this.now());
		return isIsoDate(resolved) ? resolved : '';
	}

	/* ------------------------------------------------------------------ edits -- */

	private onFieldChanged(index: number, rawField: string): void {
		const current = this.rows[index];
		if (!current) return;
		const field = asField(rawField) ?? current.field;
		const operators = OPERATORS_BY_FIELD[field];
		const operator = operators.includes(current.operator)
			? current.operator
			: defaultOperatorFor(field);

		// The old operand rarely means anything under a new field, and a date left behind in a
		// word-count row would silently filter everything away.
		this.rows[index] = { id: current.id, field, operator, value: '' };
		this.renderRows();
		this.emit();
	}

	private onOperatorChanged(index: number, rawOperator: string): void {
		const current = this.rows[index];
		if (!current) return;
		const operator = OPERATORS_BY_FIELD[current.field].find(
			(candidate) => candidate === rawOperator,
		);
		if (!operator) return;

		this.rows[index] = needsSecondValue(current.field, operator)
			? { ...current, operator }
			: dropSecondValue(current, operator);
		// The second date box appears and disappears with the operator, so the row is rebuilt.
		this.renderRows();
		this.emit();
	}

	private updateFilter(index: number, patch: Partial<Filter>): void {
		const current = this.rows[index];
		if (!current) return;
		this.rows[index] = { ...current, ...patch };
		this.emit();
	}

	private removeFilter(index: number): void {
		if (index < 0 || index >= this.rows.length) return;
		this.rows.splice(index, 1);
		this.renderRows();
		this.emit();
	}

	private emit(): void {
		if (this.silent) return;
		this.options.onChange(this.filters, this.logicValue);
	}

	/** Add a listener and remember how to remove it, so {@link destroy} leaks nothing. */
	private on(el: HTMLElement, type: string, handler: (event: Event) => void): void {
		el.addEventListener(type, handler);
		this.cleanups.push(() => el.removeEventListener(type, handler));
	}
}

function inputTypeFor(kind: FilterValueKind): string {
	if (kind === 'date') return 'date';
	if (kind === 'number') return 'number';
	return 'text';
}

function isIsoDate(value: string): boolean {
	return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

/** Copy a filter with a new operator and no second operand. */
function dropSecondValue(filter: Filter, operator: FilterOperator): Filter {
	const next: Filter = {
		id: filter.id,
		field: filter.field,
		operator,
		value: filter.value,
	};
	return filter.key === undefined ? next : { ...next, key: filter.key };
}

function asField(value: string): FilterField | null {
	return FILTER_FIELDS.find((field) => field === value) ?? null;
}
