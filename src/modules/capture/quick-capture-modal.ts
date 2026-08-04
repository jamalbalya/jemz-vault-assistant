/**
 * Quick Capture modal (main spec 5.1, wireframe in addendum appendix B).
 *
 * The modal is deliberately a thin shell: filename generation, the frontmatter contract,
 * folder creation and collision handling all live in {@link CaptureService}, so everything
 * this file owns is presentation, validation, and the one guarantee the service cannot make
 * — that a failed write never loses what the user typed. On failure the modal stays open with
 * every field intact, because losing a capture is the worst outcome this plugin can produce.
 *
 * Element class names are the shared ones from `src/ui/styles/main.css` (`jva-field`,
 * `jva-button`, `jva-row`, …). The `jva-capture__*` names carry no styling at all; they exist
 * only as stable hooks for tests and future theming, mirroring how `jva-confirm` is used by
 * the confirm dialog.
 */

import { Notice, Platform, type App } from 'obsidian';
import { ICONS } from '../../core/constants';
import { errorMessage, type Logger } from '../../core/logger';
import { STRINGS } from '../../core/strings';
import { CaptureError, type CaptureService } from '../../services/capture-service';
import type { TagService } from '../../services/tag-service';
import type { VaultIndex } from '../../services/vault-index';
import { CAPTURE_NOTE_TYPES, type CaptureInput, type CaptureResult } from '../../types/note';
import type { JemzSettings } from '../../types/settings';
import { createButton, createButtonRow, setButtonDisabled } from '../../ui/components/button';
import { confirm } from '../../ui/components/confirm-dialog';
import { JemzModal } from '../../ui/components/modal-base';
import { TagInput } from '../../ui/components/tag-input';
import { capitalize, isValidUrl, MAX_FILENAME_LENGTH } from '../../utils/string';

/**
 * Longest title the input accepts (main spec 5.1).
 *
 * Tied to {@link MAX_FILENAME_LENGTH} on purpose: the title is the only part of the generated
 * file name the user controls, so capping both at the same number means what they type is what
 * they get instead of being silently truncated by the sanitiser afterwards.
 */
export const MAX_TITLE_LENGTH = MAX_FILENAME_LENGTH;

/** Everything the modal needs from the plugin, so it can be built in a test with no plugin. */
export interface QuickCaptureDeps {
	readonly app: App;
	readonly capture: CaptureService;
	/** Source of the project dropdown's options. */
	readonly index: VaultIndex;
	/** Source of the tag autocomplete suggestions. */
	readonly tags: TagService;
	readonly logger: Logger;
	/**
	 * Live settings, read when the modal opens rather than captured at construction, so a
	 * default type changed in the settings tab takes effect on the very next capture.
	 */
	readonly getSettings: () => JemzSettings;
	/** Called after a capture is written, e.g. to refresh the inbox tab. */
	readonly onCaptured?: (result: CaptureResult) => void;
}

/** Unique-per-page ids, so a `<label for>` always points at its own control. */
let nextControlId = 1;

interface Field {
	readonly fieldEl: HTMLElement;
	readonly controlId: string;
}

/** Create a labelled field wrapper. The caller adds the control and gives it `controlId`. */
function createField(parent: HTMLElement, label: string, extraCls?: string): Field {
	const fieldEl = parent.createDiv({ cls: 'jva-field' });
	if (extraCls) fieldEl.addClass(extraCls);
	const controlId = `jva-capture-control-${nextControlId++}`;
	fieldEl.createEl('label', {
		cls: 'jva-field__label',
		text: label,
		attr: { for: controlId },
	});
	return { fieldEl, controlId };
}

export class QuickCaptureModal extends JemzModal {
	private titleInputEl: HTMLInputElement | null = null;
	private bodyInputEl: HTMLTextAreaElement | null = null;
	private sourceFieldEl: HTMLElement | null = null;
	private sourceInputEl: HTMLInputElement | null = null;
	private typeSelectEl: HTMLSelectElement | null = null;
	private projectSelectEl: HTMLSelectElement | null = null;
	private submitButtonEl: HTMLButtonElement | null = null;
	private tagInput: TagInput | null = null;

	/** Option value (vault path) to the human readable project title written to frontmatter. */
	private readonly projectTitles = new Map<string, string>();
	/** Listener removers, run on close so nothing survives the modal. */
	private readonly cleanups: (() => void)[] = [];
	private submitting = false;

	constructor(private readonly deps: QuickCaptureDeps) {
		super(deps.app, STRINGS.capture.modalTitle, 'jva-capture');
	}

	/* ------------------------------------------------------------- lifecycle -- */

	override onOpen(): void {
		super.onOpen();
		this.updateSubmitState();
		// Autofocus is what makes this a *quick* capture: the user types straight away, and on
		// mobile it raises the on-screen keyboard without an extra tap.
		this.titleInputEl?.focus();
	}

	override onClose(): void {
		for (const cleanup of this.cleanups.splice(0)) cleanup();
		super.onClose();
		this.titleInputEl = null;
		this.bodyInputEl = null;
		this.sourceFieldEl = null;
		this.sourceInputEl = null;
		this.typeSelectEl = null;
		this.projectSelectEl = null;
		this.submitButtonEl = null;
		this.tagInput = null;
		this.projectTitles.clear();
		this.submitting = false;
	}

	/* ----------------------------------------------------------------- render -- */

	protected renderBody(body: HTMLElement): void {
		const settings = this.deps.getSettings();

		this.renderTitleField(body);
		this.renderBodyField(body);
		this.renderCompactRow(body, settings);
		this.renderProjectField(body);

		// Cmd/Ctrl+Enter submits from anywhere in the form. A DOM listener rather than
		// `Modal.scope` because the soft keyboards Obsidian mobile uses deliver the chord as a
		// plain keydown, and this way one code path covers both platforms.
		this.listen(this.contentEl, 'keydown', (event) => {
			if (event.key !== 'Enter') return;
			if (!event.metaKey && !event.ctrlKey) return;
			event.preventDefault();
			void this.submit();
		});
	}

	private renderTitleField(body: HTMLElement): void {
		const field = createField(body, STRINGS.capture.titleLabel);
		this.titleInputEl = field.fieldEl.createEl('input', {
			cls: 'jva-capture__title',
			type: 'text',
			placeholder: STRINGS.capture.titlePlaceholder,
			attr: { id: field.controlId, maxlength: String(MAX_TITLE_LENGTH) },
		});
	}

	private renderBodyField(body: HTMLElement): void {
		const field = createField(body, STRINGS.capture.bodyLabel);
		this.bodyInputEl = field.fieldEl.createEl('textarea', {
			cls: 'jva-capture__body',
			placeholder: STRINGS.capture.bodyPlaceholder,
			attr: { id: field.controlId, rows: '6' },
		});
	}

	/**
	 * Tags, type and source.
	 *
	 * Side by side on desktop, as the wireframe shows. Stacked on mobile, where three controls
	 * sharing one row would each be too narrow to tap accurately.
	 */
	private renderCompactRow(body: HTMLElement, settings: JemzSettings): void {
		const stacked = Platform.isMobile;
		const row = body.createDiv({ cls: stacked ? 'jva-stack' : 'jva-row' });
		// `jva-spacer` (flex: 1 1 auto) is what makes the three fields share the row evenly.
		const fieldCls = stacked ? undefined : 'jva-spacer';

		this.renderTagsField(row, fieldCls);
		this.renderTypeField(row, settings, fieldCls);
		this.renderSourceField(row, fieldCls);
	}

	private renderTagsField(row: HTMLElement, fieldCls?: string): void {
		const field = createField(row, STRINGS.capture.tagsLabel, fieldCls);
		// Default tags are deliberately not pre-filled: the service merges them in on write, so
		// showing them as removable chips would promise a removal that never happens.
		this.tagInput = new TagInput(field.fieldEl, {
			placeholder: STRINGS.capture.tagsPlaceholder,
			suggestions: Array.from(this.deps.tags.allTags().keys()),
		});
		field.fieldEl
			.querySelector<HTMLInputElement>('.jva-tag-input__field')
			?.setAttr('id', field.controlId);
	}

	private renderTypeField(row: HTMLElement, settings: JemzSettings, fieldCls?: string): void {
		const field = createField(row, STRINGS.capture.typeLabel, fieldCls);
		const select = field.fieldEl.createEl('select', {
			cls: 'jva-capture__type',
			attr: { id: field.controlId },
		});

		const defaultType = settings.capture.defaultType.trim();
		const types: string[] = [...CAPTURE_NOTE_TYPES];
		// `type` is an open set, so a configured default outside the standard five is legal.
		// Offering it keeps the setting honest instead of capturing as something else.
		if (defaultType.length > 0 && !types.includes(defaultType)) types.push(defaultType);
		for (const type of types) {
			select.createEl('option', { text: capitalize(type), value: type });
		}

		select.value = defaultType.length > 0 ? defaultType : (types[0] ?? '');
		this.typeSelectEl = select;
	}

	private renderSourceField(row: HTMLElement, fieldCls?: string): void {
		const field = createField(row, STRINGS.capture.sourceLabel, fieldCls);
		this.sourceFieldEl = field.fieldEl;
		const input = field.fieldEl.createEl('input', {
			cls: 'jva-capture__source',
			type: 'url',
			placeholder: STRINGS.capture.sourcePlaceholder,
			attr: {
				id: field.controlId,
				// A URL keyboard on mobile, and no autocorrect mangling the address.
				inputmode: 'url',
				autocapitalize: 'off',
				autocorrect: 'off',
				spellcheck: 'false',
			},
		});
		this.sourceInputEl = input;
		this.listen(input, 'input', () => this.updateSubmitState());
		this.listen(input, 'blur', () => this.updateSubmitState());
	}

	/**
	 * Project dropdown, built from notes with `type: project`.
	 *
	 * Options are keyed by path so two projects sharing a basename stay distinguishable, while
	 * the value written to frontmatter is the readable title — `project: Client Redesign` reads
	 * like the rest of the contract and survives the note being moved to another folder.
	 * A vault with no project notes simply gets the "No project" option, which is this control's
	 * empty state.
	 */
	private renderProjectField(body: HTMLElement): void {
		const field = createField(body, STRINGS.capture.projectLabel);
		const select = field.fieldEl.createEl('select', {
			cls: 'jva-capture__project',
			attr: { id: field.controlId },
		});
		select.createEl('option', { text: STRINGS.capture.projectNone, value: '' });

		this.projectTitles.clear();
		for (const option of this.deps.capture.projectOptions(this.deps.index.notes())) {
			this.projectTitles.set(option.path, option.title);
			select.createEl('option', { text: option.title, value: option.path });
		}
		select.value = '';
		this.projectSelectEl = select;
	}

	protected override renderFooter(footer: HTMLElement): void {
		const row = createButtonRow(footer, 'jva-modal__actions');
		createButton(row, {
			label: STRINGS.common.cancel,
			cls: 'jva-capture__cancel',
			onClick: () => this.close(),
		});
		this.submitButtonEl = createButton(row, {
			label: STRINGS.capture.submit,
			icon: ICONS.capture,
			cta: true,
			cls: 'jva-capture__submit',
			onClick: () => void this.submit(),
		});
	}

	/* ------------------------------------------------------------- validation -- */

	/** Trimmed contents of the source field. */
	private sourceValue(): string {
		return this.sourceInputEl?.value.trim() ?? '';
	}

	/** An empty source is fine; anything else has to parse as an http(s) URL. */
	private isSourceValid(): boolean {
		const source = this.sourceValue();
		return source.length === 0 || isValidUrl(source);
	}

	/** Re-derive the inline error and the Capture button's enabled state. */
	private updateSubmitState(): void {
		const valid = this.isSourceValid();
		this.renderSourceError(!valid);
		if (this.submitButtonEl) {
			setButtonDisabled(this.submitButtonEl, this.submitting || !valid);
		}
	}

	/** Show or clear the inline URL error, creating the element only while it is needed. */
	private renderSourceError(show: boolean): void {
		const field = this.sourceFieldEl;
		if (!field) return;
		const existing = field.querySelector('.jva-field__error');
		if (!show) {
			existing?.remove();
			this.sourceInputEl?.setAttr('aria-invalid', 'false');
			return;
		}
		if (!existing) {
			field.createDiv({ cls: 'jva-field__error', text: STRINGS.capture.invalidUrl });
		}
		this.sourceInputEl?.setAttr('aria-invalid', 'true');
	}

	/**
	 * Persistent failure banner above the actions.
	 *
	 * A Notice disappears after a few seconds; the banner keeps the reason on screen next to
	 * the Capture button the user is meant to press again, which is the recovery action.
	 */
	private showFailure(message: string | null): void {
		const footer = this.footerEl;
		footer.querySelector('.jva-field__error')?.remove();
		if (message === null) return;
		const el = footer.createDiv({
			cls: 'jva-field__error',
			text: message,
			prepend: true,
		});
		el.setAttr('role', 'alert');
	}

	/* ----------------------------------------------------------------- submit -- */

	/** Everything the form currently holds, in the shape the service expects. */
	private collect(): CaptureInput {
		const projectPath = this.projectSelectEl?.value ?? '';
		const project =
			projectPath.length === 0 ? null : (this.projectTitles.get(projectPath) ?? null);
		return {
			// `maxlength` is the browser's job, but a paste on some mobile webviews can exceed
			// it, so the cap is enforced here too rather than trusted.
			title: (this.titleInputEl?.value ?? '').slice(0, MAX_TITLE_LENGTH).trim(),
			body: this.bodyInputEl?.value ?? '',
			tags: this.tagInput?.value ?? [],
			type: this.typeSelectEl?.value ?? this.deps.getSettings().capture.defaultType,
			source: this.sourceValue(),
			project,
		};
	}

	/** Disable the button and put a spinner on it while the write is in flight. */
	private setSubmitting(active: boolean): void {
		this.submitting = active;
		const button = this.submitButtonEl;
		if (button) {
			button.querySelector('.jva-loading__spinner')?.remove();
			if (active) button.createDiv({ cls: 'jva-loading__spinner', prepend: true });
		}
		this.updateSubmitState();
	}

	/**
	 * Ask before the inbox folder is created for the first time (main spec 5.1, edge cases).
	 *
	 * The question can only appear while the folder is still missing, so it is asked once per
	 * vault without persisting an "already asked" flag anywhere.
	 *
	 * @returns Whether the capture may proceed.
	 */
	private async confirmFolderCreation(): Promise<boolean> {
		const settings = this.deps.getSettings();
		// With auto-creation off the service reports the missing folder itself, and asking to
		// create something we are not allowed to create would be a lie.
		if (!settings.capture.confirmFolderCreation || !settings.capture.autoCreateFolders) {
			return true;
		}

		let exists: boolean;
		try {
			exists = this.deps.capture.inboxFolderExists();
		} catch (error) {
			// A vault lookup should never throw, but guessing "it exists" simply hands the
			// decision back to the service, which reports the real problem.
			this.deps.logger.warn(
				`Could not check the inbox folder: ${errorMessage(error)}`,
				error,
			);
			return true;
		}
		if (exists) return true;

		const answer = await confirm(this.deps.app, {
			title: STRINGS.capture.folderMissingTitle,
			body: STRINGS.capture.folderMissingBody(settings.capture.inboxFolder),
			confirmLabel: STRINGS.common.create,
		});
		return answer === 'confirm';
	}

	/**
	 * Write the capture.
	 *
	 * Success closes the modal; failure keeps it open with every field untouched so the user can
	 * fix the problem and press Capture again without retyping anything.
	 */
	private async submit(): Promise<void> {
		if (this.submitting) return;
		if (!this.isSourceValid()) {
			this.updateSubmitState();
			this.sourceInputEl?.focus();
			return;
		}

		const input = this.collect();
		this.showFailure(null);
		this.setSubmitting(true);

		try {
			if (!(await this.confirmFolderCreation())) {
				this.setSubmitting(false);
				return;
			}
			const result = await this.deps.capture.capture(input);
			new Notice(STRINGS.capture.success);
			this.deps.onCaptured?.(result);
			this.close();
		} catch (error) {
			this.deps.logger.error(`Quick capture failed: ${errorMessage(error)}`, error);
			// CaptureError messages are already built from STRINGS; anything else is a bug and
			// gets the generic copy rather than a raw stack trace.
			const message = error instanceof CaptureError ? error.message : STRINGS.capture.failed;
			new Notice(message);
			this.showFailure(message);
			this.setSubmitting(false);
		}
	}

	/* -------------------------------------------------------------- internals -- */

	/** Add a listener and remember how to remove it, so `onClose` leaves nothing behind. */
	private listen<K extends keyof HTMLElementEventMap>(
		el: HTMLElement,
		type: K,
		handler: (event: HTMLElementEventMap[K]) => void,
	): void {
		el.addEventListener(type, handler as EventListener);
		this.cleanups.push(() => el.removeEventListener(type, handler as EventListener));
	}
}
