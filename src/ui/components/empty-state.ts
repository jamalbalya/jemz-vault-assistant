/**
 * Empty states.
 *
 * Every list in the plugin has one (main spec section 9): inbox zero, healthy vault, not
 * scanned yet, no search results, nothing on this day. Each is an icon, a headline, a line
 * of explanation, and optionally the one action that makes sense next.
 */

import { setIcon } from 'obsidian';
import { createButton } from './button';

export interface EmptyStateOptions {
	icon: string;
	title: string;
	body?: string;
	actionLabel?: string;
	actionIcon?: string;
	onAction?: () => void;
}

/** Render an empty state into `parent`, replacing nothing — the caller clears first. */
export function renderEmptyState(parent: HTMLElement, options: EmptyStateOptions): HTMLElement {
	const container = parent.createDiv({ cls: 'jva-empty-state' });

	const iconEl = container.createDiv({ cls: 'jva-empty-state__icon' });
	setIcon(iconEl, options.icon);

	container.createEl('h3', { cls: 'jva-empty-state__title', text: options.title });
	if (options.body) {
		container.createEl('p', { cls: 'jva-empty-state__body', text: options.body });
	}
	if (options.actionLabel && options.onAction) {
		createButton(container.createDiv({ cls: 'jva-empty-state__action' }), {
			label: options.actionLabel,
			...(options.actionIcon ? { icon: options.actionIcon } : {}),
			cta: true,
			onClick: options.onAction,
		});
	}

	return container;
}

/** A short inline message for places too small for a full empty state. */
export function renderInlineEmpty(parent: HTMLElement, text: string): HTMLElement {
	return parent.createDiv({ cls: 'jva-empty-inline', text });
}

/** A spinner with a label, for work that has no measurable progress. */
export function renderLoading(parent: HTMLElement, label: string): HTMLElement {
	const container = parent.createDiv({ cls: 'jva-loading' });
	container.createDiv({ cls: 'jva-loading__spinner' });
	container.createSpan({ cls: 'jva-loading__label', text: label });
	return container;
}

/** An error state with a retry affordance. */
export function renderErrorState(
	parent: HTMLElement,
	options: {
		title: string;
		body?: string;
		retryLabel?: string;
		onRetry?: () => void;
		detailsLabel?: string;
		onDetails?: () => void;
	},
): HTMLElement {
	const container = parent.createDiv({ cls: 'jva-error-state' });
	const iconEl = container.createDiv({ cls: 'jva-error-state__icon' });
	setIcon(iconEl, 'alert-triangle');
	container.createEl('h3', { cls: 'jva-error-state__title', text: options.title });
	if (options.body) {
		container.createEl('p', { cls: 'jva-error-state__body', text: options.body });
	}

	const actions = container.createDiv({ cls: 'jva-error-state__actions' });
	if (options.retryLabel && options.onRetry) {
		createButton(actions, {
			label: options.retryLabel,
			icon: 'refresh-cw',
			cta: true,
			onClick: options.onRetry,
		});
	}
	if (options.detailsLabel && options.onDetails) {
		createButton(actions, { label: options.detailsLabel, onClick: options.onDetails });
	}
	return container;
}
