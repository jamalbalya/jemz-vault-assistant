/**
 * User interaction for the eight inbox actions (main spec 5.2).
 *
 * {@link InboxService} performs the vault work and deliberately shows no UI, so it stays
 * headless and testable. This layer owns the half that needs a human: the folder picker, the
 * note picker, the tag prompt, the delete confirmation, and the Notice that reports what
 * happened. Keeping it separate means the inbox list and triage mode drive the *same*
 * interaction — a folder picked in triage behaves exactly as one picked in the list.
 *
 * Every method answers with a discriminated result rather than throwing, because triage mode
 * tallies outcomes for its session summary and a thrown error would abort the session.
 */

import { Notice, getAllTags, type App, type TFile } from 'obsidian';
import { STRINGS } from '../../core/strings';
import { errorMessage, type Logger } from '../../core/logger';
import { normalizeTag } from '../../utils/string';
import { confirm } from '../../ui/components/confirm-dialog';
import { pickFolder } from '../../ui/components/folder-suggest';
import { pickNote } from '../../ui/components/note-suggest';
import { JemzPromiseModal } from '../../ui/components/modal-base';
import { TagInput } from '../../ui/components/tag-input';
import type { InboxService } from '../../services/inbox-service';

/**
 * Outcome of one action.
 *
 * `ok: false` covers both "the user changed their mind" and "the vault refused", which are
 * different to a human but identical to a counter: neither one processed an item.
 * {@link INBOX_ACTION_CANCELLED} tells them apart when a caller cares.
 */
export type InboxActionResult = { ok: true } | { ok: false; reason: string };

/** Reason reported when the user dismissed a picker, a prompt, or the delete confirmation. */
export const INBOX_ACTION_CANCELLED = 'cancelled';

/** Most tag suggestions offered at once — beyond this the list stops being a shortcut. */
const MAX_TAG_SUGGESTIONS = 200;

export interface InboxActionsDeps {
	app: App;
	inbox: InboxService;
	logger: Logger;
	/**
	 * Existing vault tags offered by the tag prompt's autocomplete.
	 *
	 * Injectable so a caller that already maintains a tag index (the health module does) can
	 * hand its counts over instead of paying for a second walk of the metadata cache.
	 */
	tagSuggestions?: () => readonly string[];
}

/** A short prompt collecting one or more tags, with autocomplete over the vault's tags. */
class TagPromptModal extends JemzPromiseModal<string[] | null> {
	private input: TagInput | null = null;

	constructor(
		app: App,
		private readonly suggestions: readonly string[],
	) {
		// Dismissing resolves as null, which reads as "cancelled" rather than "no tags".
		super(app, STRINGS.inbox.addTagPrompt, null);
	}

	protected renderBody(body: HTMLElement): void {
		const field = body.createDiv({ cls: 'jva-field' });
		field.createDiv({ cls: 'jva-field__label', text: STRINGS.capture.tagsLabel });
		this.input = new TagInput(field, {
			placeholder: STRINGS.capture.tagsPlaceholder,
			suggestions: this.suggestions,
		});
	}

	protected override renderFooter(footer: HTMLElement): void {
		this.renderActions(footer, [
			{ label: STRINGS.common.cancel, onClick: (): void => this.settle(null) },
			{
				label: STRINGS.common.save,
				cta: true,
				onClick: (): void => this.settle(this.input?.value ?? []),
			},
		]);
	}

	override onOpen(): void {
		super.onOpen();
		this.input?.focus();
	}
}

export class InboxActions {
	constructor(private readonly deps: InboxActionsDeps) {}

	/**
	 * Open a note in the workspace.
	 *
	 * No confirmation and no success Notice: the editor appearing *is* the feedback.
	 */
	async open(file: TFile, newPane = false): Promise<InboxActionResult> {
		return this.perform('open', file, async () => {
			await this.deps.inbox.open(file, newPane);
			return null;
		});
	}

	/** Mark a note processed, which is what removes it from the inbox. */
	async process(file: TFile): Promise<InboxActionResult> {
		return this.perform('process', file, async () => {
			await this.deps.inbox.process(file);
			return STRINGS.inbox.processed;
		});
	}

	/** Rewrite the note's title line as a task and set `type: task`. */
	async convertToTask(file: TFile): Promise<InboxActionResult> {
		return this.perform('convert to task', file, async () => {
			await this.deps.inbox.convertToTask(file);
			return STRINGS.inbox.convertedToTask;
		});
	}

	/** Ask for a destination folder, then move the note there. */
	async moveToFolder(file: TFile): Promise<InboxActionResult> {
		const folder = await pickFolder(this.deps.app, STRINGS.inbox.selectFolder);
		if (!folder) return cancelled();

		// The root folder is `/` as a path but '' as a parent, which is what the service wants.
		const isRoot = folder.isRoot();
		const target = isRoot ? '' : folder.path;
		return this.perform('move to folder', file, async () => {
			await this.deps.inbox.moveToFolder(file, target);
			return STRINGS.inbox.moved(isRoot ? '/' : folder.path);
		});
	}

	/**
	 * Ask for tags, then add them to the note's frontmatter.
	 *
	 * The prompt accepts several tags because typing two and pressing Enter twice is cheaper
	 * than reopening the prompt; each one is reported so the user sees exactly what landed.
	 */
	async addTag(file: TFile): Promise<InboxActionResult> {
		const chosen = await new TagPromptModal(this.deps.app, this.tagSuggestions()).openAndWait();
		if (chosen === null) return cancelled();

		const tags = Array.from(new Set(chosen.map(normalizeTag).filter((tag) => tag.length > 0)));
		if (tags.length === 0) return cancelled();

		return this.perform('add tag', file, async () => {
			for (const tag of tags) await this.deps.inbox.addTag(file, tag);
			return tags.map((tag) => STRINGS.inbox.tagged(tag)).join('\n');
		});
	}

	/** Ask for a note, then append a wikilink to it at the end of the body. */
	async linkToNote(file: TFile): Promise<InboxActionResult> {
		const target = await pickNote(this.deps.app, {
			placeholder: STRINGS.inbox.selectNote,
			// Linking a note to itself is never what was meant.
			exclude: new Set([file.path]),
		});
		if (!target) return cancelled();

		return this.perform('link to note', file, async () => {
			await this.deps.inbox.linkToNote(file, target);
			return STRINGS.inbox.linked(target.basename);
		});
	}

	/** Move the note to the archive folder and mark it archived. */
	async archive(file: TFile): Promise<InboxActionResult> {
		return this.perform('archive', file, async () => {
			await this.deps.inbox.archive(file);
			return STRINGS.inbox.archived;
		});
	}

	/**
	 * Delete a note, after confirming — and after offering not to.
	 *
	 * The confirmation offers "Archive instead" as a third choice (main spec 5.2: prefer
	 * archiving over deletion), and confirming routes to `vault.trash`, never to a permanent
	 * delete, so the note is always recoverable from the vault's trash folder.
	 */
	async remove(file: TFile): Promise<InboxActionResult> {
		const choice = await confirm(this.deps.app, {
			title: STRINGS.inbox.deleteConfirmTitle,
			body: STRINGS.inbox.deleteConfirmBody(file.basename),
			confirmLabel: STRINGS.inbox.deleteConfirmCta,
			alternateLabel: STRINGS.inbox.archiveInstead,
			destructive: true,
		});

		if (choice === 'cancel') return cancelled();
		if (choice === 'alternate') return this.archive(file);

		return this.perform('trash', file, async () => {
			await this.deps.inbox.trash(file);
			return STRINGS.inbox.deleted;
		});
	}

	/* ------------------------------------------------------------- internals -- */

	/**
	 * Run one vault operation, reporting it exactly once.
	 *
	 * Centralising the try/catch means no action can fail silently and no action can invent
	 * its own error copy: the user always sees {@link STRINGS.inbox.actionFailed} while the
	 * detail — which is often a path or a YAML complaint — goes to the console.
	 *
	 * @param body Performs the work and returns the success Notice text, or null for none.
	 */
	private async perform(
		label: string,
		file: TFile,
		body: () => Promise<string | null>,
	): Promise<InboxActionResult> {
		try {
			const message = await body();
			if (message !== null) new Notice(message);
			return { ok: true };
		} catch (error) {
			this.deps.logger.error(`Inbox action "${label}" failed for "${file.path}"`, error);
			new Notice(STRINGS.inbox.actionFailed);
			return { ok: false, reason: errorMessage(error) };
		}
	}

	/**
	 * Tags to offer in the prompt, most used first.
	 *
	 * Falls back to walking the metadata cache, which touches no disk and is therefore cheap
	 * enough to run when the prompt opens rather than being kept warm.
	 */
	private tagSuggestions(): readonly string[] {
		if (this.deps.tagSuggestions) return this.deps.tagSuggestions();

		const counts = new Map<string, number>();
		for (const file of this.deps.app.vault.getMarkdownFiles()) {
			const cache = this.deps.app.metadataCache.getFileCache(file);
			if (!cache) continue;
			for (const raw of getAllTags(cache) ?? []) {
				const tag = normalizeTag(raw);
				if (tag.length === 0) continue;
				counts.set(tag, (counts.get(tag) ?? 0) + 1);
			}
		}
		return Array.from(counts.entries())
			.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
			.slice(0, MAX_TAG_SUGGESTIONS)
			.map((entry) => entry[0]);
	}
}

/** The result every dismissed picker, prompt, and confirmation shares. */
function cancelled(): InboxActionResult {
	return { ok: false, reason: INBOX_ACTION_CANCELLED };
}
