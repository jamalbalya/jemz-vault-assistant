/**
 * Confirmation dialogs.
 *
 * Nothing in the plugin destroys or overwrites user data without one of these. The
 * permanent-delete variant deliberately requires a second, separately worded confirmation
 * (addendum 6.5) and never presents deletion as the default button.
 */

import type { App } from 'obsidian';
import { STRINGS } from '../../core/strings';
import { JemzPromiseModal } from './modal-base';

export interface ConfirmOptions {
	title: string;
	body: string;
	/** Label of the confirming button. */
	confirmLabel?: string;
	cancelLabel?: string;
	/** Styles the confirm button as destructive. */
	destructive?: boolean;
	/** Optional third choice, e.g. "Archive instead". Resolves as `'alternate'`. */
	alternateLabel?: string;
}

export type ConfirmResult = 'confirm' | 'cancel' | 'alternate';

class ConfirmDialog extends JemzPromiseModal<ConfirmResult> {
	constructor(
		app: App,
		private readonly options: ConfirmOptions,
	) {
		super(app, options.title, 'cancel', 'jva-confirm');
	}

	protected renderBody(body: HTMLElement): void {
		body.createEl('p', { cls: 'jva-confirm__body', text: this.options.body });
	}

	protected override renderFooter(footer: HTMLElement): void {
		const actions = [
			{
				label: this.options.cancelLabel ?? STRINGS.common.cancel,
				onClick: (): void => this.settle('cancel'),
			},
		];

		if (this.options.alternateLabel) {
			actions.push({
				label: this.options.alternateLabel,
				onClick: (): void => this.settle('alternate'),
			});
		}

		this.renderActions(footer, [
			...actions,
			{
				label: this.options.confirmLabel ?? STRINGS.common.confirm,
				// A destructive action is never the visually primary choice.
				cta: !this.options.destructive,
				warning: this.options.destructive === true,
				onClick: (): void => this.settle('confirm'),
			},
		]);
	}
}

/**
 * Ask the user to confirm something.
 *
 * @returns `'confirm'`, `'cancel'`, or `'alternate'` when an alternate label was offered.
 *   Dismissing the modal resolves as `'cancel'`.
 */
export function confirm(app: App, options: ConfirmOptions): Promise<ConfirmResult> {
	return new ConfirmDialog(app, options).openAndWait();
}

/**
 * Ask twice before permanently destroying data.
 *
 * The first prompt offers the safe alternative; only after the user rejects it does the
 * second, explicitly worded prompt appear.
 */
export async function confirmPermanentDeletion(
	app: App,
	options: { title: string; body: string; safeLabel: string },
): Promise<'delete' | 'safe' | 'cancel'> {
	const first = await confirm(app, {
		title: options.title,
		body: options.body,
		confirmLabel: STRINGS.preview.confirmDestructiveCta,
		alternateLabel: options.safeLabel,
		destructive: true,
	});

	if (first === 'cancel') return 'cancel';
	if (first === 'alternate') return 'safe';

	const second = await confirm(app, {
		title: STRINGS.preview.confirmDestructiveTitle,
		body: STRINGS.preview.confirmDestructiveBody,
		confirmLabel: STRINGS.preview.confirmDestructiveCta,
		destructive: true,
	});
	return second === 'confirm' ? 'delete' : 'cancel';
}
