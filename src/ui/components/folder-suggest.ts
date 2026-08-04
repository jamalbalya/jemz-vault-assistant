/**
 * Folder picker used by "Move to folder" in the inbox and triage.
 *
 * A fuzzy suggest modal rather than a text field, because typing a folder path by hand is
 * exactly the kind of friction this plugin exists to remove.
 */

import { FuzzySuggestModal, TFolder, type App } from 'obsidian';
import { STRINGS } from '../../core/strings';

export class FolderSuggestModal extends FuzzySuggestModal<TFolder> {
	constructor(
		app: App,
		private readonly onChoose: (folder: TFolder) => void,
		placeholder: string = STRINGS.inbox.selectFolder,
	) {
		super(app);
		this.setPlaceholder(placeholder);
	}

	getItems(): TFolder[] {
		const folders: TFolder[] = [];
		const walk = (folder: TFolder): void => {
			folders.push(folder);
			for (const child of folder.children) {
				if (child instanceof TFolder) walk(child);
			}
		};
		walk(this.app.vault.getRoot());
		return folders.sort((a, b) => a.path.localeCompare(b.path));
	}

	getItemText(folder: TFolder): string {
		return folder.isRoot() ? '/' : folder.path;
	}

	onChooseItem(folder: TFolder): void {
		this.onChoose(folder);
	}
}

/** Open the picker and resolve with the chosen folder, or null when dismissed. */
export function pickFolder(app: App, placeholder?: string): Promise<TFolder | null> {
	return new Promise((resolve) => {
		let chosen: TFolder | null = null;
		const modal = new FolderSuggestModal(
			app,
			(folder) => {
				chosen = folder;
			},
			placeholder,
		);
		const originalClose = modal.onClose.bind(modal);
		modal.onClose = (): void => {
			originalClose();
			resolve(chosen);
		};
		modal.open();
	});
}
