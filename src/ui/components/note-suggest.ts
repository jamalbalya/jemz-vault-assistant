/**
 * Note picker used by "Link to note" and by the broken-link "Replace with…" fix.
 *
 * The replace-link flow seeds the query with the broken target so the closest existing note
 * is usually the first suggestion.
 */

import { FuzzySuggestModal, type App, type TFile } from 'obsidian';
import { STRINGS } from '../../core/strings';

export class NoteSuggestModal extends FuzzySuggestModal<TFile> {
	constructor(
		app: App,
		private readonly onChoose: (file: TFile) => void,
		placeholder: string = STRINGS.inbox.selectNote,
		private readonly exclude: ReadonlySet<string> = new Set(),
	) {
		super(app);
		this.setPlaceholder(placeholder);
	}

	getItems(): TFile[] {
		return this.app.vault
			.getMarkdownFiles()
			.filter((file) => !this.exclude.has(file.path))
			.sort((a, b) => a.basename.localeCompare(b.basename));
	}

	getItemText(file: TFile): string {
		return file.path;
	}

	onChooseItem(file: TFile): void {
		this.onChoose(file);
	}
}

/** Open the picker and resolve with the chosen note, or null when dismissed. */
export function pickNote(
	app: App,
	options: { placeholder?: string; exclude?: ReadonlySet<string>; initialQuery?: string } = {},
): Promise<TFile | null> {
	return new Promise((resolve) => {
		let chosen: TFile | null = null;
		const modal = new NoteSuggestModal(
			app,
			(file) => {
				chosen = file;
			},
			options.placeholder,
			options.exclude,
		);
		const originalClose = modal.onClose.bind(modal);
		modal.onClose = (): void => {
			originalClose();
			resolve(chosen);
		};
		modal.open();
		if (options.initialQuery) {
			modal.inputEl.value = options.initialQuery;
			modal.inputEl.dispatchEvent(new Event('input'));
		}
	});
}
