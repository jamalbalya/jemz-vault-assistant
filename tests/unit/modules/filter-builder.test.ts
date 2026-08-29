/**
 * The filter builder's row lifecycle.
 *
 * Rows are rebuilt wholesale on every structural edit — changing a field, changing an
 * operator, adding or removing a row, or loading a saved view. Each rebuild wires fresh
 * listeners, so each rebuild has to release the previous ones: `on()` exists precisely so
 * `destroy()` "leaks nothing", and a re-render that keeps registering without releasing
 * defeats that. The retained closures also hold every detached row element alive for as long
 * as the Find tab is open.
 *
 * The observable consequence is sharper than a leak: a row that has been rendered away still
 * carries live handlers bound to a stale index, so it can still edit the filter list.
 */

import { describe, expect, it, vi } from 'vitest';
import { FilterBuilder } from '../../../src/modules/retrieval/filter-builder';
import type { Filter } from '../../../src/types/search';

function build(initialFilters: Filter[] = []) {
	const parent = document.createElement('div');
	document.body.appendChild(parent);
	const onChange = vi.fn();
	const builder = new FilterBuilder(parent, { initialFilters, onChange });
	return { parent, builder, onChange };
}

/** The field `<select>` of every rendered row. */
function fieldSelects(parent: HTMLElement): HTMLSelectElement[] {
	return Array.from(parent.querySelectorAll<HTMLSelectElement>('.jva-filter-row__field'));
}

function filterOf(field: Filter['field'], value: string, id = 'f1'): Filter {
	return { id, field, operator: 'contains', value };
}

describe('rebuilding rows', () => {
	it('renders one row per filter', () => {
		const { parent } = build([filterOf('keyword', 'alpha'), filterOf('tag', 'x', 'f2')]);
		expect(fieldSelects(parent)).toHaveLength(2);
	});

	it('detaches the previous row elements', () => {
		const { parent, builder } = build([filterOf('keyword', 'alpha')]);
		const stale = fieldSelects(parent)[0] as HTMLSelectElement;

		builder.addFilter('tag');

		expect(stale.isConnected).toBe(false);
		expect(fieldSelects(parent)).toHaveLength(2);
	});

	it('leaves a rendered-away row unable to edit the filter list', () => {
		const { parent, builder, onChange } = build([filterOf('keyword', 'alpha')]);
		const stale = fieldSelects(parent)[0] as HTMLSelectElement;

		// A structural edit rebuilds every row; the old elements are gone from the document.
		builder.addFilter('tag');
		const before = builder.filters.map((filter) => filter.field);
		onChange.mockClear();

		// The detached element still exists in memory. If its listener survived the rebuild,
		// it edits `rows[0]` — and reports the edit as though the user had made it.
		stale.value = 'status';
		stale.dispatchEvent(new Event('change'));

		expect(builder.filters.map((filter) => filter.field)).toEqual(before);
		expect(onChange).not.toHaveBeenCalled();
	});

	it('keeps the live rows working after several rebuilds', () => {
		const { parent, builder, onChange } = build([filterOf('keyword', 'alpha')]);
		builder.addFilter('tag');
		builder.addFilter('folder');
		onChange.mockClear();

		const live = fieldSelects(parent)[2] as HTMLSelectElement;
		live.value = 'status';
		live.dispatchEvent(new Event('change'));

		expect(builder.filters[2]?.field).toBe('status');
		expect(onChange).toHaveBeenCalledTimes(1);
	});

	it('keeps the logic select working after rows are rebuilt', () => {
		const { parent, builder, onChange } = build([filterOf('keyword', 'alpha')]);
		builder.addFilter('tag');
		onChange.mockClear();

		const logic = parent.querySelector<HTMLSelectElement>('.jva-filters__logic-select');
		expect(logic).not.toBeNull();
		(logic as HTMLSelectElement).value = 'or';
		(logic as HTMLSelectElement).dispatchEvent(new Event('change'));

		expect(builder.logic).toBe('or');
		expect(onChange).toHaveBeenCalledTimes(1);
	});

	it('reports nothing while a saved view is being loaded', () => {
		const { builder, onChange } = build([filterOf('keyword', 'alpha')]);
		onChange.mockClear();

		builder.setState([filterOf('tag', 'work', 'f9')], 'or');

		expect(onChange).not.toHaveBeenCalled();
		expect(builder.filters).toHaveLength(1);
		expect(builder.logic).toBe('or');
	});

	it('stops listening once destroyed', () => {
		const { parent, builder, onChange } = build([filterOf('keyword', 'alpha')]);
		const live = fieldSelects(parent)[0] as HTMLSelectElement;

		builder.destroy();
		onChange.mockClear();
		live.value = 'status';
		live.dispatchEvent(new Event('change'));

		expect(onChange).not.toHaveBeenCalled();
	});
});
