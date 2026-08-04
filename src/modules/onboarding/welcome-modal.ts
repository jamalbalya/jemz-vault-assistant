/**
 * First-run experience (addendum section 8.5).
 *
 * A single, dismissible tour that points at the three things the plugin does and offers —
 * never assumes — to create the default folders. Dismissal is stored per device rather than
 * in settings, so a synced vault does not suppress the tour on a second machine.
 *
 * Nothing here writes to the vault unless the user presses the create button.
 */

import { Notice, TFolder, setIcon, type App } from 'obsidian';
import { ICONS, LINKS, LOCAL_STATE_KEYS } from '../../core/constants';
import { STRINGS } from '../../core/strings';
import type { LocalStateStore } from '../../core/local-state';
import { errorMessage, type Logger } from '../../core/logger';
import type { SettingsStore } from '../../core/settings';
import { createButton } from '../../ui/components/button';
import { JemzModal } from '../../ui/components/modal-base';

export interface WelcomeDeps {
	app: App;
	settings: SettingsStore;
	localState: LocalStateStore;
	logger: Logger;
	/** Invoked by the final button so the user lands somewhere useful. */
	onOpenDashboard: () => void;
}

export class WelcomeModal extends JemzModal {
	private foldersCreated = false;

	constructor(private readonly deps: WelcomeDeps) {
		super(deps.app, STRINGS.onboarding.title, 'jva-welcome');
	}

	protected renderBody(body: HTMLElement): void {
		body.createEl('p', { cls: 'jva-welcome__intro', text: STRINGS.onboarding.intro });

		const steps = body.createDiv({ cls: 'jva-welcome__steps' });
		this.renderStep(
			steps,
			ICONS.capture,
			STRINGS.onboarding.step1Title,
			STRINGS.onboarding.step1Body,
		);
		this.renderStep(
			steps,
			ICONS.health,
			STRINGS.onboarding.step2Title,
			STRINGS.onboarding.step2Body,
		);
		this.renderStep(
			steps,
			ICONS.find,
			STRINGS.onboarding.step3Title,
			STRINGS.onboarding.step3Body,
		);

		this.renderFolderOffer(body);
	}

	private renderStep(parent: HTMLElement, icon: string, title: string, text: string): void {
		const step = parent.createDiv({ cls: 'jva-welcome__step' });
		const iconEl = step.createSpan({ cls: 'jva-welcome__step-icon' });
		setIcon(iconEl, icon);

		const copy = step.createDiv();
		copy.createEl('p', { cls: 'jva-welcome__step-title', text: title });
		copy.createEl('p', { cls: 'jva-welcome__step-body', text: text });
	}

	/**
	 * Offer to create the default folders.
	 *
	 * Skipped entirely when both already exist, so a returning user is not asked about
	 * something that is already done.
	 */
	private renderFolderOffer(parent: HTMLElement): void {
		const { inboxFolder, archiveFolder } = this.deps.settings.get().capture;
		if (this.folderExists(inboxFolder) && this.folderExists(archiveFolder)) return;

		const box = parent.createDiv({ cls: 'jva-welcome__folders' });
		box.createEl('p', {
			cls: 'jva-welcome__step-title',
			text: STRINGS.onboarding.createFoldersTitle,
		});
		box.createEl('p', {
			cls: 'jva-welcome__step-body',
			text: STRINGS.onboarding.createFoldersBody(inboxFolder, archiveFolder),
		});

		const actions = box.createDiv({ cls: 'jva-button-row' });
		const createEl = createButton(actions, {
			label: STRINGS.onboarding.createFolders,
			icon: ICONS.inbox,
			cta: true,
			onClick: () => {
				void this.createFolders(box, createEl);
			},
		});
		createButton(actions, {
			label: STRINGS.onboarding.skipFolders,
			onClick: () => box.detach(),
		});
	}

	private folderExists(path: string): boolean {
		const trimmed = path.trim();
		if (trimmed.length === 0) return true;
		return this.deps.app.vault.getAbstractFileByPath(trimmed) instanceof TFolder;
	}

	/** Create the configured folders, tolerating ones that already exist. */
	private async createFolders(box: HTMLElement, button: HTMLButtonElement): Promise<void> {
		if (this.foldersCreated) return;
		this.foldersCreated = true;
		button.toggleAttribute('disabled', true);

		const { inboxFolder, archiveFolder } = this.deps.settings.get().capture;
		try {
			for (const folder of [inboxFolder, archiveFolder]) {
				const trimmed = folder.trim();
				if (trimmed.length === 0 || this.folderExists(trimmed)) continue;
				await this.deps.app.vault.createFolder(trimmed);
			}
			new Notice(STRINGS.onboarding.foldersCreated);
			box.empty();
			box.createEl('p', {
				cls: 'jva-welcome__step-body',
				text: STRINGS.onboarding.foldersCreated,
			});
		} catch (error) {
			this.deps.logger.error('Could not create the default folders', error);
			new Notice(errorMessage(error));
			// Let the user try again rather than stranding them.
			this.foldersCreated = false;
			button.toggleAttribute('disabled', false);
		}
	}

	protected override renderFooter(footer: HTMLElement): void {
		const docs = footer.createEl('a', {
			cls: 'jva-welcome__docs',
			text: STRINGS.onboarding.openDocs,
			href: LINKS.readme,
		});
		docs.setAttr('target', '_blank');
		docs.setAttr('rel', 'noopener');

		this.renderActions(footer, [
			{
				label: STRINGS.onboarding.finish,
				cta: true,
				onClick: () => {
					this.close();
					this.deps.onOpenDashboard();
				},
			},
		]);
	}

	override onClose(): void {
		super.onClose();
		// Marking on close, not on open, so a modal dismissed by a crash still reappears.
		this.deps.localState.set(LOCAL_STATE_KEYS.firstRunCompleted, true);
	}
}

/**
 * Show the welcome modal the first time this device runs the plugin.
 *
 * Safe to call on every load: it returns immediately once the tour has been dismissed.
 */
export function maybeShowWelcome(deps: WelcomeDeps): boolean {
	try {
		const seen = deps.localState.get<boolean>(LOCAL_STATE_KEYS.firstRunCompleted, false);
		if (seen === true) return false;
		new WelcomeModal(deps).open();
		return true;
	} catch (error) {
		// Onboarding is never worth breaking a load over.
		deps.logger.warn('Could not show the welcome modal', error);
		return false;
	}
}
