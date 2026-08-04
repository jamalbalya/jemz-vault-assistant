/**
 * Button helpers.
 *
 * Centralised so every action button in the plugin gets the same class names, the same
 * icon handling, and a touch target that satisfies the 44x44 minimum on mobile without each
 * view remembering to ask for it.
 */

import { setIcon } from 'obsidian';

export interface ButtonOptions {
	/** Visible label. Omit for an icon-only button, in which case `tooltip` is required. */
	label?: string;
	/** Lucide icon id from Obsidian's built-in set. */
	icon?: string;
	/** Accessible name and hover text. Falls back to `label`. */
	tooltip?: string;
	/** Renders as the primary action. */
	cta?: boolean;
	/** Renders as a destructive action. */
	warning?: boolean;
	/** Extra classes. */
	cls?: string | string[];
	/** Keyboard shortcut hint rendered next to the label. */
	shortcut?: string;
	disabled?: boolean;
	onClick?: (event: MouseEvent) => void;
}

/**
 * Create a button inside `parent`.
 *
 * @returns The button element, so callers can toggle disabled state later.
 */
export function createButton(parent: HTMLElement, options: ButtonOptions): HTMLButtonElement {
	const button = parent.createEl('button', { cls: 'jva-button' });

	if (options.cta) button.addClass('mod-cta');
	if (options.warning) button.addClass('mod-warning');
	if (options.cls) {
		const classes = Array.isArray(options.cls) ? options.cls : [options.cls];
		button.addClasses(classes);
	}

	if (options.icon) {
		const iconEl = button.createSpan({ cls: 'jva-button__icon' });
		setIcon(iconEl, options.icon);
	}
	if (options.label) {
		button.createSpan({ cls: 'jva-button__label', text: options.label });
	} else {
		button.addClass('jva-button--icon-only');
	}
	if (options.shortcut) {
		button.createSpan({ cls: 'jva-button__shortcut', text: options.shortcut });
	}

	const accessibleName = options.tooltip ?? options.label;
	if (accessibleName) {
		button.setAttr('aria-label', accessibleName);
		button.setAttr('title', accessibleName);
	}
	if (options.disabled) setButtonDisabled(button, true);

	if (options.onClick) {
		button.addEventListener('click', (event) => {
			if (button.hasAttribute('disabled')) return;
			options.onClick?.(event);
		});
	}

	return button;
}

/** Enable or disable a button, keeping the DOM attribute and the class in step. */
export function setButtonDisabled(button: HTMLButtonElement, disabled: boolean): void {
	button.toggleAttribute('disabled', disabled);
	button.toggleClass('is-disabled', disabled);
	button.setAttr('aria-disabled', String(disabled));
}

/** A horizontal row of buttons that wraps on narrow screens. */
export function createButtonRow(parent: HTMLElement, cls?: string): HTMLElement {
	const row = parent.createDiv({ cls: 'jva-button-row' });
	if (cls) row.addClass(cls);
	return row;
}
