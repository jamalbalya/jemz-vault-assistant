/**
 * Determinate progress bar with a count label.
 *
 * Used by scans ("Scanning… 340/1200 files") and by fix batches ("Applying… 3/12"), both of
 * which know their totals, so an indeterminate spinner would hide useful information.
 */

export class ProgressBar {
	private readonly containerEl: HTMLElement;
	private readonly fillEl: HTMLElement;
	private readonly labelEl: HTMLElement;
	private total = 0;
	private value = 0;

	constructor(parent: HTMLElement, cls?: string) {
		this.containerEl = parent.createDiv({ cls: 'jva-progress' });
		if (cls) this.containerEl.addClass(cls);

		this.labelEl = this.containerEl.createDiv({ cls: 'jva-progress__label' });
		const track = this.containerEl.createDiv({ cls: 'jva-progress__track' });
		this.fillEl = track.createDiv({ cls: 'jva-progress__fill' });

		track.setAttr('role', 'progressbar');
		track.setAttr('aria-valuemin', '0');
		this.trackEl = track;
	}

	private readonly trackEl: HTMLElement;

	/** Update the bar. A zero total renders an indeterminate stripe. */
	setProgress(value: number, total: number, label?: string): void {
		this.value = Math.max(0, value);
		this.total = Math.max(0, total);

		const indeterminate = this.total === 0;
		this.containerEl.toggleClass('is-indeterminate', indeterminate);

		const percent = indeterminate ? 0 : Math.min(100, (this.value / this.total) * 100);
		this.fillEl.style.width = `${percent}%`;

		this.trackEl.setAttr('aria-valuemax', String(this.total));
		this.trackEl.setAttr('aria-valuenow', String(this.value));

		if (label !== undefined) this.labelEl.setText(label);
	}

	/** Replace the label without touching the bar. */
	setLabel(label: string): void {
		this.labelEl.setText(label);
	}

	/** Current completion as a fraction in `[0, 1]`. */
	get fraction(): number {
		return this.total === 0 ? 0 : Math.min(1, this.value / this.total);
	}

	/** Show or hide the whole widget. */
	setVisible(visible: boolean): void {
		this.containerEl.toggle(visible);
	}

	/** Remove the widget from the DOM. */
	destroy(): void {
		this.containerEl.detach();
	}
}
