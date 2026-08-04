/**
 * Shared modal chrome.
 *
 * Obsidian's `Modal` gives a container and nothing else. Every modal in this plugin wants
 * the same three regions plus mobile behaviour (full screen, so the on-screen keyboard
 * cannot cover the fields), so that lives here instead of in each subclass.
 */

import { Modal, Platform, type App } from 'obsidian';
import { createButton, createButtonRow, type ButtonOptions } from './button';

export abstract class JemzModal extends Modal {
	/** Region for the modal's own content. */
	protected bodyEl!: HTMLElement;
	/** Region for action buttons, pinned to the bottom on mobile. */
	protected footerEl!: HTMLElement;

	constructor(
		app: App,
		private readonly modalTitle: string,
		private readonly extraClass?: string,
	) {
		super(app);
	}

	override onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('jva-modal');
		if (this.extraClass) contentEl.addClass(this.extraClass);
		// A full-screen sheet keeps inputs visible above the on-screen keyboard.
		if (Platform.isMobile) {
			contentEl.addClass('jva-modal--mobile');
			this.modalEl.addClass('jva-modal-el--mobile');
		}

		contentEl.createEl('h2', { cls: 'jva-modal__title', text: this.modalTitle });
		this.bodyEl = contentEl.createDiv({ cls: 'jva-modal__body' });
		this.footerEl = contentEl.createDiv({ cls: 'jva-modal__footer' });

		this.renderBody(this.bodyEl);
		this.renderFooter(this.footerEl);
	}

	override onClose(): void {
		this.contentEl.empty();
	}

	/** Fill the body region. */
	protected abstract renderBody(body: HTMLElement): void;

	/** Fill the footer region. Defaults to nothing. */
	protected renderFooter(_footer: HTMLElement): void {
		/* subclasses opt in */
	}

	/** Convenience for the common Cancel + primary action pair. */
	protected renderActions(footer: HTMLElement, actions: readonly ButtonOptions[]): HTMLElement {
		const row = createButtonRow(footer, 'jva-modal__actions');
		for (const action of actions) createButton(row, action);
		return row;
	}
}

/**
 * A modal that resolves a promise when it closes.
 *
 * Callers `await` a decision instead of threading callbacks through the UI, which keeps the
 * confirm-before-write flow readable at the call site.
 */
export abstract class JemzPromiseModal<T> extends JemzModal {
	private resolver: ((value: T) => void) | null = null;
	private settled = false;
	private result!: T;

	constructor(
		app: App,
		title: string,
		private readonly defaultResult: T,
		extraClass?: string,
	) {
		super(app, title, extraClass);
		this.result = defaultResult;
	}

	/** Open the modal and wait for it to settle. */
	openAndWait(): Promise<T> {
		return new Promise<T>((resolve) => {
			this.resolver = resolve;
			this.open();
		});
	}

	/** Settle with a value and close. */
	protected settle(value: T): void {
		this.result = value;
		this.settled = true;
		this.close();
	}

	override onClose(): void {
		super.onClose();
		// Dismissing without choosing resolves with the default, never leaves a hanging await.
		const value = this.settled ? this.result : this.defaultResult;
		this.resolver?.(value);
		this.resolver = null;
	}
}
