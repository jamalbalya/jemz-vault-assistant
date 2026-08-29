/**
 * The retrieval module's public face.
 *
 * Wraps the search engine, resolves saved views (including the three that cannot be
 * expressed as filters), and exposes the four contextual features. Views talk to this and
 * nothing below it.
 */

import type { App, TFile } from 'obsidian';
import type { NoteRecord } from '../types/note';
import type {
	OnThisDayEntry,
	SavedView,
	SearchQuery,
	SearchResponse,
	SearchResult,
	SimilarNote,
	StaleNote,
	UnlinkedMention,
} from '../types/search';
import type { JemzSettings } from '../types/settings';
import type { Logger } from '../core/logger';
import type { SettingsStore } from '../core/settings';
import { previewText } from '../utils/string';
import type { ContentIndex } from './content-index';
import type { VaultIndex } from './vault-index';
import { isInboxNote } from './inbox-service';
import { isOrphanNote } from '../modules/health/detectors/orphan-notes';
import { SearchEngine } from '../modules/retrieval/search-engine';
import { resolveViews, viewToQuery } from '../modules/retrieval/saved-views';
import { findOnThisDay } from '../modules/retrieval/contextual/on-this-day';
import { findStaleNotes } from '../modules/retrieval/contextual/stale-notes';
import { findSimilarNotes } from '../modules/retrieval/contextual/similar-notes';
import {
	findUnlinkedMentionsInNote,
	type MentionTarget,
} from '../modules/retrieval/contextual/unlinked-mentions';

export interface RetrievalServiceDeps {
	app: App;
	index: VaultIndex;
	content: ContentIndex;
	settings: SettingsStore;
	logger: Logger;
	now?: () => number;
}

export class RetrievalService {
	private readonly engine: SearchEngine;
	private readonly now: () => number;

	constructor(private readonly deps: RetrievalServiceDeps) {
		this.now = deps.now ?? Date.now;
		this.engine = new SearchEngine(
			deps.index,
			deps.content,
			() => deps.settings.get(),
			this.now,
		);
	}

	private get settings(): JemzSettings {
		return this.deps.settings.get();
	}

	/** Run a raw query. */
	async search(query: SearchQuery): Promise<SearchResponse> {
		return this.engine.search(query);
	}

	/** Views to render in the sidebar, ordered. */
	views(): SavedView[] {
		return resolveViews(this.settings.retrieval);
	}

	/**
	 * Run a saved view.
	 *
	 * Special views bypass the filter engine because "has no backlinks and no outgoing
	 * links" is a graph question, not a metadata question.
	 */
	async runView(view: SavedView, keyword = '', page = 1): Promise<SearchResponse> {
		const pageSize = this.settings.retrieval.resultsPerPage;
		const offset = Math.max(0, (page - 1) * pageSize);

		if (view.special) {
			return this.runSpecialView(view, keyword, offset, pageSize);
		}
		return this.engine.search(viewToQuery(view, keyword, this.now(), pageSize, offset));
	}

	private async runSpecialView(
		view: SavedView,
		keyword: string,
		offset: number,
		limit: number,
	): Promise<SearchResponse> {
		const startedAt = this.now();
		let records: NoteRecord[];

		switch (view.special) {
			case 'orphans': {
				// Identical to the orphan detector's definition (addendum E-05), and it also
				// honours the health module's inbox exclusion. Without that the Find tab would
				// report every unprocessed capture as an orphan while the Health tab reported
				// none of them, and the user would see two different counts for one idea.
				const settings = this.settings;
				const inboxFolder = settings.capture.inboxFolder.trim();
				const backlinksOf = (path: string): readonly string[] =>
					this.deps.index.backlinksOf(path);
				records = this.candidates().filter((record) => {
					// Shared with the detector rather than restated, so the two tabs cannot
					// answer differently — a note whose only link points at itself is the case
					// a length check gets wrong.
					if (!isOrphanNote(record, backlinksOf)) return false;
					if (settings.health.excludeInbox && isInboxNote(record, inboxFolder)) {
						return false;
					}
					return true;
				});
				break;
			}
			case 'no-tags':
				records = this.candidates().filter((record) => record.tags.length === 0);
				break;
			case 'unlinked-mentions': {
				const mentions = await this.allUnlinkedMentions();
				const paths = new Set(mentions.map((mention) => mention.sourcePath));
				records = this.candidates().filter((record) => paths.has(record.path));
				break;
			}
			default:
				records = this.candidates();
		}

		const lowerKeyword = keyword.trim().toLowerCase();
		const matching =
			lowerKeyword.length === 0
				? records
				: records.filter((record) => record.basename.toLowerCase().includes(lowerKeyword));

		const results = matching
			.map((record) => this.toResult(record))
			.sort((a, b) =>
				view.sort.field === 'title'
					? a.title.localeCompare(b.title) * (view.sort.direction === 'asc' ? 1 : -1)
					: (a.modified - b.modified) * (view.sort.direction === 'asc' ? 1 : -1),
			);

		return {
			results: results.slice(offset, offset + limit),
			total: results.length,
			durationMs: this.now() - startedAt,
		};
	}

	/** Notes eligible for retrieval, honouring the archived-notes preference. */
	private candidates(): NoteRecord[] {
		const notes = this.deps.index.notes();
		if (!this.settings.retrieval.excludeArchivedFromViews) return notes;
		return notes.filter((record) => record.status?.toLowerCase() !== 'archived');
	}

	private toResult(record: NoteRecord): SearchResult {
		const body = this.deps.content.peekBody(record.path);
		return {
			path: record.path,
			title: record.basename,
			folder: record.folder,
			tags: record.tags,
			created: record.created,
			modified: record.modified,
			score: 1,
			snippet: body ? previewText(body, 160) : '',
			matches: [],
		};
	}

	/* --------------------------------------------------------- contextual -- */

	/** Notes created on this month/day in previous years. */
	onThisDay(reference: number = this.now()): OnThisDayEntry[] {
		return findOnThisDay(this.candidates(), reference, {
			excludeArchived: this.settings.retrieval.excludeArchivedFromViews,
		});
	}

	/** Notes untouched beyond the configured threshold, oldest first. */
	staleNotes(reference: number = this.now(), limit?: number): StaleNote[] {
		return findStaleNotes(this.deps.index.notes(), reference, {
			thresholdDays: this.settings.retrieval.staleThresholdDays,
			excludeArchived: true,
			...(limit !== undefined ? { limit } : {}),
		});
	}

	/** Notes similar to `path`, by shared tags, shared links, and title likeness. */
	similarNotes(path: string): SimilarNote[] {
		const subject = this.deps.index.get(path);
		if (!subject) return [];
		return findSimilarNotes(subject, this.deps.index.notes(), {
			minScore: this.settings.retrieval.similarNotesMinScore,
			limit: this.settings.retrieval.similarNotesLimit,
			excludeArchived: this.settings.retrieval.excludeArchivedFromViews,
		});
	}

	/** Every note title that could be linked to. */
	mentionTargets(): MentionTarget[] {
		return this.deps.index
			.notes()
			.map((record) => ({ path: record.path, title: record.basename }));
	}

	/** Unlinked mentions inside one note. */
	async unlinkedMentionsIn(path: string): Promise<UnlinkedMention[]> {
		const file = this.deps.app.vault.getFileByPath(path);
		if (!file) return [];
		try {
			const content = await this.deps.app.vault.cachedRead(file);
			return findUnlinkedMentionsInNote(path, content, this.mentionTargets(), {
				minLength: this.settings.retrieval.unlinkedMentionMinLength,
			});
		} catch (error) {
			this.deps.logger.warn(`Could not scan "${path}" for unlinked mentions`, error);
			return [];
		}
	}

	/**
	 * Unlinked mentions across the whole vault.
	 *
	 * Reads every note, so it is only used by the dedicated saved view — never on render of
	 * the results list.
	 */
	async allUnlinkedMentions(limitPerNote = 5): Promise<UnlinkedMention[]> {
		const targets = this.mentionTargets();
		const records = this.candidates();
		await this.deps.content.ensureLoaded(records);

		const mentions: UnlinkedMention[] = [];
		for (const record of records) {
			const body = this.deps.content.peekBody(record.path);
			if (body === null) continue;
			mentions.push(
				...findUnlinkedMentionsInNote(record.path, body, targets, {
					minLength: this.settings.retrieval.unlinkedMentionMinLength,
					perTargetLimit: limitPerNote,
				}),
			);
		}
		return mentions;
	}

	/**
	 * Replace a plain-text mention with a wikilink.
	 *
	 * The stored offsets are verified against the current text before writing; if the note
	 * changed underneath, the edit is refused rather than applied at the wrong place.
	 */
	async convertMentionToLink(mention: UnlinkedMention): Promise<boolean> {
		const file = this.deps.app.vault.getFileByPath(mention.sourcePath);
		if (!file) return false;

		try {
			let applied = false;
			await this.deps.app.vault.process(file, (content) => {
				const offset = lineColToOffset(content, mention.line, mention.col);
				if (offset === null) return content;
				const actual = content.slice(offset, offset + mention.matchedText.length);
				if (actual !== mention.matchedText) return content;

				const target = this.deps.index.get(mention.targetPath);
				const linkText = target?.basename ?? mention.targetTitle;
				const replacement =
					linkText === mention.matchedText
						? `[[${linkText}]]`
						: `[[${linkText}|${mention.matchedText}]]`;

				applied = true;
				return (
					content.slice(0, offset) +
					replacement +
					content.slice(offset + mention.matchedText.length)
				);
			});
			return applied;
		} catch (error) {
			this.deps.logger.error(`Could not convert a mention in "${mention.sourcePath}"`, error);
			return false;
		}
	}

	/** Open a note, optionally in a new pane. */
	async open(path: string, newPane = false): Promise<void> {
		await this.deps.app.workspace.openLinkText(path, path, newPane);
	}

	/** Markdown link text for a result, for the Copy link action. */
	linkFor(path: string): string {
		const file: TFile | null = this.deps.app.vault.getFileByPath(path);
		if (!file) return `[[${path}]]`;
		return this.deps.app.fileManager.generateMarkdownLink(file, '');
	}
}

/** Convert a zero-based line/column pair into an absolute offset, or null when out of range. */
export function lineColToOffset(content: string, line: number, col: number): number | null {
	if (line < 0 || col < 0) return null;
	let offset = 0;
	let currentLine = 0;
	while (currentLine < line) {
		const next = content.indexOf('\n', offset);
		if (next === -1) return null;
		offset = next + 1;
		currentLine++;
	}
	const lineEnd = content.indexOf('\n', offset);
	const lineLength = (lineEnd === -1 ? content.length : lineEnd) - offset;
	if (col > lineLength) return null;
	return offset + col;
}
