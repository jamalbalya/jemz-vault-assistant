/**
 * Multi-tag input with autocomplete over the vault's existing tags.
 *
 * Suggesting tags the vault already uses is the cheapest way to stop tag drift at the
 * source — which is the same problem the tag-inconsistency detector cleans up after.
 */

import { setIcon } from 'obsidian';
import { normalizeTag } from '../../utils/string';
import { fuzzyMatch } from '../../utils/fuzzy-match';

export interface TagInputOptions {
	placeholder?: string;
	/** Tags present when the control is created. */
	initial?: readonly string[];
	/** Known vault tags offered as suggestions. */
	suggestions: readonly string[];
	/** Maximum suggestions shown at once. */
	maxSuggestions?: number;
	onChange?: (tags: string[]) => void;
}

export class TagInput {
	private readonly containerEl: HTMLElement;
	private readonly chipsEl: HTMLElement;
	private readonly inputEl: HTMLInputElement;
	private readonly suggestionsEl: HTMLElement;
	private readonly tags: string[] = [];
	private activeSuggestion = -1;

	constructor(
		parent: HTMLElement,
		private readonly options: TagInputOptions,
	) {
		this.containerEl = parent.createDiv({ cls: 'jva-tag-input' });
		this.chipsEl = this.containerEl.createDiv({ cls: 'jva-tag-input__chips' });

		this.inputEl = this.containerEl.createEl('input', {
			cls: 'jva-tag-input__field',
			type: 'text',
			placeholder: options.placeholder ?? '',
		});

		this.suggestionsEl = this.containerEl.createDiv({ cls: 'jva-tag-input__suggestions' });
		this.suggestionsEl.hide();

		for (const tag of options.initial ?? []) this.add(tag, false);
		this.renderChips();

		this.inputEl.addEventListener('input', () => this.renderSuggestions());
		this.inputEl.addEventListener('blur', () => {
			// Delay so a click on a suggestion still registers.
			window.setTimeout(() => this.suggestionsEl.hide(), 150);
		});
		this.inputEl.addEventListener('keydown', (event) => this.onKeyDown(event));
	}

	/** Current tags, normalised and de-duplicated. */
	get value(): string[] {
		return [...this.tags];
	}

	/** Focus the text field. */
	focus(): void {
		this.inputEl.focus();
	}

	/** Add a tag. Returns false when it was empty or already present. */
	add(raw: string, notify = true): boolean {
		const tag = normalizeTag(raw);
		if (tag.length === 0 || this.tags.includes(tag)) return false;
		this.tags.push(tag);
		if (notify) {
			this.renderChips();
			this.options.onChange?.(this.value);
		}
		return true;
	}

	/** Remove a tag. */
	remove(tag: string): void {
		const index = this.tags.indexOf(normalizeTag(tag));
		if (index === -1) return;
		this.tags.splice(index, 1);
		this.renderChips();
		this.options.onChange?.(this.value);
	}

	private onKeyDown(event: KeyboardEvent): void {
		const suggestions = this.currentSuggestions();

		if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
			if (suggestions.length === 0) return;
			event.preventDefault();
			const delta = event.key === 'ArrowDown' ? 1 : -1;
			this.activeSuggestion =
				(this.activeSuggestion + delta + suggestions.length) % suggestions.length;
			this.renderSuggestions();
			return;
		}

		if (event.key === 'Enter' || event.key === ',') {
			event.preventDefault();
			const chosen =
				this.activeSuggestion >= 0
					? suggestions[this.activeSuggestion]
					: this.inputEl.value;
			if (chosen && this.add(chosen)) {
				this.inputEl.value = '';
				this.activeSuggestion = -1;
				this.suggestionsEl.hide();
			}
			return;
		}

		if (event.key === 'Backspace' && this.inputEl.value.length === 0) {
			const last = this.tags[this.tags.length - 1];
			if (last) this.remove(last);
			return;
		}

		if (event.key === 'Escape' && this.suggestionsEl.isShown()) {
			// Swallow Escape so it closes the suggestion list rather than the whole modal.
			event.preventDefault();
			event.stopPropagation();
			this.suggestionsEl.hide();
		}
	}

	private currentSuggestions(): string[] {
		const query = this.inputEl.value.trim();
		const pool = this.options.suggestions
			.map(normalizeTag)
			.filter((tag) => tag.length > 0 && !this.tags.includes(tag));
		if (query.length === 0) return pool.slice(0, this.options.maxSuggestions ?? 5);

		return pool
			.map((tag) => ({ tag, match: fuzzyMatch(query, tag) }))
			.filter((entry) => entry.match !== null)
			.sort((a, b) => (b.match?.score ?? 0) - (a.match?.score ?? 0))
			.slice(0, this.options.maxSuggestions ?? 5)
			.map((entry) => entry.tag);
	}

	private renderSuggestions(): void {
		const suggestions = this.currentSuggestions();
		this.suggestionsEl.empty();

		if (suggestions.length === 0) {
			this.suggestionsEl.hide();
			return;
		}
		this.suggestionsEl.show();

		suggestions.forEach((tag, index) => {
			const item = this.suggestionsEl.createDiv({
				cls: 'jva-tag-input__suggestion',
				text: `#${tag}`,
			});
			item.toggleClass('is-active', index === this.activeSuggestion);
			item.addEventListener('mousedown', (event) => {
				// mousedown fires before blur, so the click is not lost.
				event.preventDefault();
				this.add(tag);
				this.inputEl.value = '';
				this.suggestionsEl.hide();
				this.inputEl.focus();
			});
		});
	}

	private renderChips(): void {
		this.chipsEl.empty();
		for (const tag of this.tags) {
			const chip = this.chipsEl.createSpan({ cls: 'jva-tag-chip' });
			chip.createSpan({ cls: 'jva-tag-chip__label', text: `#${tag}` });
			const remove = chip.createSpan({ cls: 'jva-tag-chip__remove' });
			setIcon(remove, 'x');
			remove.setAttr('aria-label', `Remove #${tag}`);
			remove.setAttr('role', 'button');
			remove.setAttr('tabindex', '0');
			remove.addEventListener('click', () => this.remove(tag));
			remove.addEventListener('keydown', (event) => {
				if (event.key === 'Enter' || event.key === ' ') {
					event.preventDefault();
					this.remove(tag);
				}
			});
		}
	}
}
