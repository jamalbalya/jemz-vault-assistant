/**
 * Quick capture: turning a small form into a well-formed note in the inbox.
 *
 * The service owns filename generation, the frontmatter contract, folder creation and
 * collision handling, so the modal stays a thin shell around it and every rule here is
 * unit testable without any UI.
 */

import { Notice, TFolder, type App, type TFile } from 'obsidian';
import type { CaptureInput, CaptureResult, NoteRecord } from '../types/note';
import type { JemzSettings } from '../types/settings';
import { STRINGS } from '../core/strings';
import { errorMessage, type Logger } from '../core/logger';
import { formatDate } from '../utils/date';
import { joinPath, uniquePath } from '../utils/file';
import { normalizeTag, sanitizeFilename } from '../utils/string';

/**
 * Characters that give a plain YAML scalar a second meaning when they open it: flow
 * collectors, anchors, tags, block scalars, quotes, directives and comments.
 */
const YAML_INDICATOR_START = /^[-?:,[\]{}#&*!|>'"%@`]/;

/** Words YAML reads back as a boolean or a null rather than as the text that was typed. */
const YAML_RESERVED_WORD = /^(?:y|n|yes|no|true|false|on|off|null|~)$/i;

/**
 * Render a value as a YAML scalar, quoting it whenever plain style would change its meaning.
 *
 * This module assembles frontmatter as text rather than through a YAML library, so every
 * value that came from the user has to be checked before it is written. A source typed as
 * `[1] Deep Work` opens a flow sequence and takes the whole block down with it; a project
 * note called `#Roadmap` is read as a comment and silently becomes null. Either one produces
 * a brand new capture whose properties Obsidian cannot parse — which this plugin then
 * reports as corrupted frontmatter and, correctly, refuses to repair automatically.
 *
 * Quoting is deliberately eager: a value that did not need quotes reads identically either
 * way, while one that did is unrecoverable.
 */
function yamlScalar(value: string): string {
	const needsQuotes =
		value.length === 0 ||
		value !== value.trim() ||
		value.includes(':') ||
		YAML_INDICATOR_START.test(value) ||
		YAML_RESERVED_WORD.test(value) ||
		/\s#/.test(value) ||
		/[\r\n\t]/.test(value);
	if (!needsQuotes) return value;
	// Backslashes first: escaping the quotes would otherwise be undone by escaping theirs.
	return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** Raised when a capture cannot be written. */
export class CaptureError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'CaptureError';
	}
}

export class CaptureService {
	constructor(
		private readonly app: App,
		private readonly getSettings: () => JemzSettings,
		private readonly logger: Logger,
		private readonly now: () => number = Date.now,
	) {}

	/**
	 * Build the file name for a capture, without the folder.
	 *
	 * Format is `YYYY-MM-DD [type] - [title].md`, matching the convention the inbox fixture
	 * uses. An empty title becomes `Untitled YYYY-MM-DD HH-mm` so a capture is never lost to
	 * a blank field.
	 */
	buildFilename(input: Pick<CaptureInput, 'title' | 'type'>, at: number = this.now()): string {
		const datePart = formatDate(at, 'YYYY-MM-DD');
		const rawTitle =
			input.title.trim().length > 0
				? input.title.trim()
				: `${STRINGS.capture.untitledPrefix} ${formatDate(at, 'YYYY-MM-DD HH-mm')}`;
		const type = (input.type || this.getSettings().capture.defaultType).trim();
		// Sanitise the assembled name so a title containing " - " or a slash cannot break
		// out of the pattern or the folder.
		const safeTitle = sanitizeFilename(rawTitle);
		return `${sanitizeFilename(`${datePart} ${type} - ${safeTitle}`)}.md`;
	}

	/**
	 * Frontmatter for a new capture.
	 *
	 * Keys follow the frontmatter contract: `created`, `type`, `status: inbox`, `source`,
	 * and the merged tag list. The configured template is applied first so a user key never
	 * silently overrides a contract key.
	 */
	buildFrontmatter(input: CaptureInput, at: number = this.now()): Record<string, unknown> {
		const settings = this.getSettings();
		const template: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(settings.capture.frontmatterTemplate)) {
			template[key] = this.expandTokens(value, at);
		}

		const tags = Array.from(
			new Set(
				[...settings.capture.defaultTags, ...input.tags]
					.map(normalizeTag)
					.filter((tag) => tag.length > 0),
			),
		);

		const frontmatter: Record<string, unknown> = {
			...template,
			created: formatDate(at, 'YYYY-MM-DD'),
			type: input.type || settings.capture.defaultType,
			status: 'inbox',
			source: input.source.trim(),
			tags,
		};

		if (input.project && input.project.trim().length > 0) {
			frontmatter.project = input.project.trim();
		}
		return frontmatter;
	}

	/** Replace `{{date}}` / `{{time}}` / `{{datetime}}` tokens in a template value. */
	private expandTokens(value: string, at: number): string {
		return value
			.replace(/\{\{date\}\}/g, formatDate(at, 'YYYY-MM-DD'))
			.replace(/\{\{time\}\}/g, formatDate(at, 'HH:mm'))
			.replace(/\{\{datetime\}\}/g, formatDate(at, 'YYYY-MM-DD HH:mm'));
	}

	/** Serialise frontmatter plus body into the final file content. */
	buildContent(input: CaptureInput, at: number = this.now()): string {
		const frontmatter = this.buildFrontmatter(input, at);
		const lines: string[] = ['---'];
		for (const [key, value] of Object.entries(frontmatter)) {
			// Template keys are user-typed too, so they get the same treatment as values.
			const name = yamlScalar(key);
			if (Array.isArray(value)) {
				if (value.length === 0) {
					lines.push(`${name}: []`);
				} else {
					lines.push(`${name}:`);
					for (const item of value) lines.push(`  - ${yamlScalar(String(item))}`);
				}
			} else if (typeof value === 'string') {
				lines.push(`${name}: ${yamlScalar(value)}`);
			} else {
				lines.push(`${name}: ${String(value)}`);
			}
		}
		lines.push('---', '');

		const body = input.body.trim();
		if (body.length > 0) lines.push(body, '');
		return lines.join('\n');
	}

	/**
	 * Ensure a folder exists, creating it when the setting allows.
	 *
	 * @throws {CaptureError} when the folder is missing and auto-creation is off.
	 */
	async ensureFolder(folderPath: string): Promise<TFolder> {
		const settings = this.getSettings();
		const existing = this.app.vault.getAbstractFileByPath(folderPath);
		if (existing instanceof TFolder) return existing;
		if (existing) {
			throw new CaptureError(`"${folderPath}" exists but is a file, not a folder.`);
		}
		if (!settings.capture.autoCreateFolders) {
			throw new CaptureError(STRINGS.errors.folderNotFound(folderPath));
		}

		try {
			const folder = await this.app.vault.createFolder(folderPath);
			this.logger.info(`Created folder "${folderPath}"`);
			return folder;
		} catch (error) {
			// A concurrent create is fine — re-read before giving up.
			const raced = this.app.vault.getAbstractFileByPath(folderPath);
			if (raced instanceof TFolder) return raced;
			this.logger.error(`Could not create folder "${folderPath}"`, error);
			throw new CaptureError(
				`${STRINGS.errors.folderNotFound(folderPath)} ${errorMessage(error)}`,
			);
		}
	}

	/**
	 * Write a capture into the inbox.
	 *
	 * @throws {CaptureError} on a read-only vault or an unwritable folder. The caller shows
	 *   the message as a Notice; nothing is partially written.
	 */
	async capture(input: CaptureInput): Promise<CaptureResult> {
		const at = this.now();
		const settings = this.getSettings();
		const folderPath = settings.capture.inboxFolder.trim();

		if (folderPath.length > 0) await this.ensureFolder(folderPath);

		const filename = this.buildFilename(input, at);
		const desired = joinPath(folderPath, filename);
		const path = uniquePath(
			desired,
			(candidate) => this.app.vault.getAbstractFileByPath(candidate) !== null,
		);

		try {
			const file = await this.app.vault.create(path, this.buildContent(input, at));
			this.logger.info(`Captured "${file.path}"`);
			return {
				path: file.path,
				folder: folderPath,
				filename: file.name,
				created: at,
			};
		} catch (error) {
			this.logger.error(`Capture failed for "${path}"`, error);
			const message = /read-only|EROFS|EACCES/i.test(errorMessage(error))
				? STRINGS.capture.readOnly
				: `${STRINGS.capture.failed}: ${errorMessage(error)}`;
			throw new CaptureError(message);
		}
	}

	/** Capture and surface the outcome as a Notice, for command and hotkey entry points. */
	async captureWithNotice(input: CaptureInput): Promise<CaptureResult | null> {
		try {
			const result = await this.capture(input);
			new Notice(STRINGS.capture.success);
			return result;
		} catch (error) {
			new Notice(errorMessage(error));
			return null;
		}
	}

	/** Notes usable as the Project dropdown's options. */
	projectOptions(records: readonly NoteRecord[]): { path: string; title: string }[] {
		return records
			.filter((record) => record.type?.toLowerCase() === 'project')
			.map((record) => ({ path: record.path, title: record.basename }))
			.sort((a, b) => a.title.localeCompare(b.title));
	}

	/** Whether the configured inbox folder exists right now. */
	inboxFolderExists(): boolean {
		const folder = this.getSettings().capture.inboxFolder.trim();
		if (folder.length === 0) return true;
		return this.app.vault.getAbstractFileByPath(folder) instanceof TFolder;
	}

	/** The file a capture would be written to, without creating anything. */
	previewPath(input: Pick<CaptureInput, 'title' | 'type'>, at: number = this.now()): string {
		const folder = this.getSettings().capture.inboxFolder.trim();
		const desired = joinPath(folder, this.buildFilename(input, at));
		return uniquePath(
			desired,
			(candidate) => this.app.vault.getAbstractFileByPath(candidate) !== null,
		);
	}

	/** Resolve a captured path back to its file. */
	fileFor(result: CaptureResult): TFile | null {
		return this.app.vault.getFileByPath(result.path);
	}
}
