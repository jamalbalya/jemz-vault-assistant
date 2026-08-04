/**
 * Turning selected issues into a reviewable, reversible batch of file changes.
 *
 * Nothing here writes. `prepare()` returns a {@link FixPlan} describing exactly what would
 * happen — the list the preview modal renders — together with an executor the safety gate
 * runs only after the user confirms. That split is what makes "never modify a user file
 * without preview and confirmation" structural rather than a convention.
 *
 * Edits to the same file are always collapsed into a single change and applied in one pass
 * from the end of the document backwards, so earlier edits cannot invalidate later offsets.
 */

import { TFolder, type App, type TFile } from 'obsidian';
import type {
	BrokenLinkIssueData,
	ChangeKind,
	FixActionId,
	FixPlan,
	HealthIssue,
	IssueType,
	PlannedChange,
	TagInconsistencyIssueData,
} from '../../types/health';
import type { LinkRef } from '../../types/note';
import type { JemzSettings } from '../../types/settings';
import type { ChangeExecutor } from '../../core/safety';
import { STRINGS } from '../../core/strings';
import { errorMessage, type Logger } from '../../core/logger';
import { getBasename, joinPath, uniquePath } from '../../utils/file';
import { sanitizeFilename, truncate } from '../../utils/string';
import type { VaultIndex } from '../../services/vault-index';
import type { LinkService } from '../../services/link-service';
import type { MetadataService } from '../../services/metadata-service';
import type { TagService } from '../../services/tag-service';
import { removeLinkKeepText, replaceLinkTarget } from '../../services/link-service';

/** A fix the user can pick for an issue type. */
export interface FixActionDescriptor {
	readonly id: FixActionId;
	readonly label: string;
	/** Needs extra input (a folder, a note, a tag) before a plan can be built. */
	readonly needsInput?: 'note' | 'tag' | 'name' | 'properties';
	/** Permanently destroys data, so it needs the second confirmation. */
	readonly destructive?: boolean;
	/** Handled entirely by the UI (opening a file) rather than by a plan. */
	readonly uiOnly?: boolean;
}

/** Fixes offered per issue type (main spec 6.3). */
export const FIX_ACTIONS: Readonly<Record<IssueType, readonly FixActionDescriptor[]>> = {
	'broken-link': [
		{ id: 'create-note', label: STRINGS.health.fixes.createNote },
		{ id: 'replace-link', label: STRINGS.health.fixes.replaceLink, needsInput: 'note' },
		{ id: 'remove-link', label: STRINGS.health.fixes.removeLink },
		{ id: 'ignore', label: STRINGS.common.ignore },
	],
	'orphan-note': [
		{ id: 'add-tag', label: STRINGS.health.fixes.addTag, needsInput: 'tag' },
		{ id: 'move-to-archive', label: STRINGS.health.fixes.moveToArchive },
		{ id: 'trash', label: STRINGS.health.fixes.trash },
		{ id: 'ignore', label: STRINGS.common.ignore },
	],
	'empty-note': [
		{ id: 'trash', label: STRINGS.health.fixes.trash },
		{ id: 'ignore', label: STRINGS.common.ignore },
	],
	'unused-attachment': [
		{ id: 'move-to-archive', label: STRINGS.health.fixes.moveToArchive },
		{ id: 'trash', label: STRINGS.health.fixes.trash },
		{ id: 'ignore', label: STRINGS.common.ignore },
	],
	'duplicate-title': [
		{ id: 'rename', label: STRINGS.health.fixes.rename, needsInput: 'name' },
		{ id: 'ignore', label: STRINGS.common.ignore },
	],
	'tag-inconsistency': [
		{ id: 'merge-tags', label: STRINGS.health.fixes.mergeTags },
		{ id: 'ignore', label: STRINGS.common.ignore },
	],
	'missing-metadata': [
		{ id: 'add-metadata', label: STRINGS.health.fixes.addMetadata, needsInput: 'properties' },
		{ id: 'ignore', label: STRINGS.common.ignore },
	],
	'large-file': [
		{ id: 'move-to-archive', label: STRINGS.health.fixes.moveToArchive },
		{ id: 'ignore', label: STRINGS.common.ignore },
	],
	'corrupted-frontmatter': [{ id: 'ignore', label: STRINGS.common.ignore }],
};

/** Extra input a fix may need. */
export interface FixParams {
	/** Destination note for `replace-link`. */
	targetPath?: string;
	/** Tag for `add-tag`. */
	tag?: string;
	/** New base name for `rename`. */
	newName?: string;
	/** Properties for `add-metadata`. */
	properties?: Record<string, unknown>;
	/** Canonical tag for `merge-tags`; defaults to each group's own canonical. */
	canonicalTag?: string;
}

/** A plan plus the executor that applies it. */
export interface PreparedFix {
	readonly plan: FixPlan;
	readonly execute: ChangeExecutor;
}

export interface FixActionsDeps {
	app: App;
	index: VaultIndex;
	link: LinkService;
	metadata: MetadataService;
	tag: TagService;
	getSettings: () => JemzSettings;
	logger: Logger;
}

/** Raised when a plan cannot be built from the given issues and params. */
export class FixPlanError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'FixPlanError';
	}
}

export class FixActions {
	constructor(private readonly deps: FixActionsDeps) {}

	/** Fixes available for an issue type. */
	actionsFor(type: IssueType): readonly FixActionDescriptor[] {
		return FIX_ACTIONS[type] ?? [];
	}

	/** Whether an action destroys data beyond what the backup can restore. */
	isDestructive(actionId: FixActionId): boolean {
		return actionId === 'delete-permanently';
	}

	/**
	 * Build the plan for an action.
	 *
	 * @throws {FixPlanError} when required input is missing or nothing is actionable.
	 */
	async prepare(
		actionId: FixActionId,
		issues: readonly HealthIssue[],
		params: FixParams = {},
	): Promise<PreparedFix> {
		if (issues.length === 0) throw new FixPlanError('Nothing was selected.');

		switch (actionId) {
			case 'remove-link':
				return this.prepareLinkEdit(issues, null);
			case 'replace-link': {
				const targetPath = params.targetPath;
				if (!targetPath) throw new FixPlanError('Choose a note to link to first.');
				return this.prepareLinkEdit(issues, targetPath);
			}
			case 'create-note':
				return this.prepareCreateNotes(issues);
			case 'add-tag': {
				const tag = params.tag?.trim();
				if (!tag) throw new FixPlanError('Enter a tag first.');
				return this.prepareAddTag(issues, tag);
			}
			case 'move-to-archive':
				return this.prepareArchive(issues);
			case 'trash':
				return this.prepareTrash(issues);
			case 'merge-tags':
				return this.prepareMergeTags(issues, params.canonicalTag);
			case 'add-metadata': {
				const properties = params.properties;
				if (!properties || Object.keys(properties).length === 0) {
					throw new FixPlanError('Enter at least one property first.');
				}
				return this.prepareAddMetadata(issues, properties);
			}
			case 'rename': {
				const newName = params.newName?.trim();
				if (!newName) throw new FixPlanError('Enter a new name first.');
				return this.prepareRename(issues, newName);
			}
			default:
				throw new FixPlanError(`"${actionId}" cannot be applied as a batch.`);
		}
	}

	/* ------------------------------------------------------------- builders -- */

	/**
	 * Remove or retarget broken links.
	 *
	 * Issues are grouped by file so each file is rewritten once; within a file the edits run
	 * back-to-front so the recorded offsets stay valid.
	 */
	private async prepareLinkEdit(
		issues: readonly HealthIssue[],
		newTarget: string | null,
	): Promise<PreparedFix> {
		const byFile = new Map<string, HealthIssue[]>();
		for (const issue of issues) {
			if (issue.data.kind !== 'broken-link') continue;
			const list = byFile.get(issue.path) ?? [];
			list.push(issue);
			byFile.set(issue.path, list);
		}
		if (byFile.size === 0) throw new FixPlanError('No broken links were selected.');

		const targetName = newTarget === null ? null : getBasename(newTarget);
		const changes: PlannedChange[] = [];

		for (const [path, fileIssues] of byFile) {
			const file = this.requireFile(path);
			const content = await this.deps.app.vault.read(file);
			const next = this.applyLinkEdits(content, fileIssues, targetName);
			changes.push({
				path,
				kind: 'modify',
				description:
					newTarget === null
						? `Remove ${fileIssues.length} broken link${fileIssues.length === 1 ? '' : 's'}, keeping the text`
						: `Point ${fileIssues.length} broken link${fileIssues.length === 1 ? '' : 's'} at "${targetName}"`,
				before: this.excerptOf(fileIssues),
				after: targetName === null ? '(link text kept)' : `[[${targetName}]]`,
				expectedMtime: file.stat.mtime,
			});
		}

		return {
			plan: this.buildPlan(
				newTarget === null ? 'remove-link' : 'replace-link',
				newTarget === null
					? STRINGS.health.fixes.removeLink
					: STRINGS.health.fixes.replaceLink,
				issues,
				changes,
			),
			execute: async (change) => {
				const file = this.requireFile(change.path);
				const fileIssues = byFile.get(change.path) ?? [];
				await this.deps.app.vault.process(file, (content) =>
					this.applyLinkEdits(content, fileIssues, targetName),
				);
			},
		};
	}

	/** Apply every link edit for one file, latest offset first. */
	private applyLinkEdits(
		content: string,
		issues: readonly HealthIssue[],
		newTarget: string | null,
	): string {
		const ordered = issues
			.filter((issue) => issue.data.kind === 'broken-link')
			.map((issue) => issue.data as BrokenLinkIssueData)
			.sort((a, b) => b.line - a.line || b.col - a.col);

		let result = content;
		for (const data of ordered) {
			const link: LinkRef = {
				target: data.target,
				displayText: null,
				resolvedPath: null,
				isEmbed: data.isEmbed,
				isMarkdownLink: data.isMarkdownLink,
				line: data.line,
				col: data.col,
				raw: data.raw,
			};
			try {
				result =
					newTarget === null
						? removeLinkKeepText(result, link)
						: replaceLinkTarget(result, link, newTarget);
			} catch (error) {
				// A stale offset means the file changed; skip this one link rather than
				// corrupting the document, and let the result summary report it.
				this.deps.logger.warn(
					`Skipped a link edit in a changed file: ${errorMessage(error)}`,
				);
			}
		}
		return result;
	}

	/** Create the notes that broken links point at. */
	private async prepareCreateNotes(issues: readonly HealthIssue[]): Promise<PreparedFix> {
		const settings = this.deps.getSettings();
		const folder = settings.capture.inboxFolder.trim();
		const targets = new Map<string, string>();

		for (const issue of issues) {
			if (issue.data.kind !== 'broken-link') continue;
			const name = sanitizeFilename(getBasename(issue.data.target));
			if (name.length === 0 || targets.has(name)) continue;
			targets.set(
				name,
				uniquePath(
					joinPath(folder, `${name}.md`),
					(candidate) => this.deps.app.vault.getAbstractFileByPath(candidate) !== null,
				),
			);
		}
		if (targets.size === 0) throw new FixPlanError('No note names could be derived.');

		const changes: PlannedChange[] = Array.from(targets.entries()).map(([name, path]) => ({
			path,
			kind: 'create',
			description: `Create "${name}"`,
			expectedMtime: 0,
		}));

		return {
			plan: this.buildPlan('create-note', STRINGS.health.fixes.createNote, issues, changes),
			execute: async (change) => {
				await this.deps.link.createMissingNote(getBasename(change.path), folder);
			},
		};
	}

	private async prepareAddTag(issues: readonly HealthIssue[], tag: string): Promise<PreparedFix> {
		const changes: PlannedChange[] = this.uniqueFiles(issues).map((file) => ({
			path: file.path,
			kind: 'modify',
			description: `Add #${tag}`,
			before: '(tags unchanged)',
			after: `#${tag}`,
			expectedMtime: file.stat.mtime,
		}));

		return {
			plan: this.buildPlan('add-tag', STRINGS.health.fixes.addTag, issues, changes),
			execute: async (change) => {
				await this.deps.metadata.addTag(this.requireFile(change.path), tag);
			},
		};
	}

	private async prepareAddMetadata(
		issues: readonly HealthIssue[],
		properties: Record<string, unknown>,
	): Promise<PreparedFix> {
		const summary = Object.entries(properties)
			.map(([key, value]) => `${key}: ${String(value)}`)
			.join(', ');

		const changes: PlannedChange[] = this.uniqueFiles(issues).map((file) => ({
			path: file.path,
			kind: 'modify',
			description: 'Add missing properties',
			before: '(properties missing)',
			after: summary,
			expectedMtime: file.stat.mtime,
		}));

		return {
			plan: this.buildPlan('add-metadata', STRINGS.health.fixes.addMetadata, issues, changes),
			execute: async (change) => {
				await this.deps.metadata.setProperties(this.requireFile(change.path), properties);
			},
		};
	}

	/** Move notes or attachments into the archive, picking the right folder for each. */
	private async prepareArchive(issues: readonly HealthIssue[]): Promise<PreparedFix> {
		const settings = this.deps.getSettings();
		const destinations = new Map<string, string>();

		for (const file of this.uniqueFiles(issues)) {
			const folder =
				file.extension === 'md'
					? settings.capture.archiveFolder.trim()
					: settings.capture.attachmentArchiveFolder.trim();
			const desired = joinPath(folder, file.name);
			destinations.set(
				file.path,
				uniquePath(
					desired,
					(candidate) => this.deps.app.vault.getAbstractFileByPath(candidate) !== null,
				),
			);
		}

		const changes: PlannedChange[] = Array.from(destinations.entries()).map(
			([path, targetPath]) => ({
				path,
				kind: 'move',
				description: `Move to "${targetPath}"`,
				targetPath,
				expectedMtime: this.requireFile(path).stat.mtime,
			}),
		);

		return {
			plan: this.buildPlan(
				'move-to-archive',
				STRINGS.health.fixes.moveToArchive,
				issues,
				changes,
			),
			execute: async (change) => {
				const file = this.requireFile(change.path);
				const destination = change.targetPath;
				if (!destination) throw new Error(`No destination for "${change.path}"`);
				await this.ensureFolderFor(destination);
				if (file.extension === 'md') {
					// Keep the note's own status honest about where it now lives.
					await this.deps.metadata.setStatus(file, 'archived');
				}
				await this.deps.app.fileManager.renameFile(file, destination);
			},
		};
	}

	/** Move files to the trash. Recoverable, and the default for every delete affordance. */
	private async prepareTrash(issues: readonly HealthIssue[]): Promise<PreparedFix> {
		const changes: PlannedChange[] = this.uniqueFiles(issues).map((file) => ({
			path: file.path,
			kind: 'trash',
			description: `Move "${file.name}" to the trash`,
			expectedMtime: file.stat.mtime,
		}));

		return {
			plan: this.buildPlan('trash', STRINGS.health.fixes.trash, issues, changes),
			execute: async (change) => {
				await this.deps.app.vault.trash(this.requireFile(change.path), false);
			},
		};
	}

	private async prepareRename(
		issues: readonly HealthIssue[],
		newName: string,
	): Promise<PreparedFix> {
		if (issues.length !== 1) {
			throw new FixPlanError('Rename applies to one note at a time.');
		}
		const issue = issues[0] as HealthIssue;
		const file = this.requireFile(issue.path);
		const safeName = sanitizeFilename(newName);
		const targetPath = uniquePath(
			joinPath(file.parent?.path === '/' ? '' : (file.parent?.path ?? ''), `${safeName}.md`),
			(candidate) => this.deps.app.vault.getAbstractFileByPath(candidate) !== null,
		);

		const changes: PlannedChange[] = [
			{
				path: file.path,
				kind: 'move',
				description: `Rename to "${safeName}"`,
				targetPath,
				expectedMtime: file.stat.mtime,
			},
		];

		return {
			plan: this.buildPlan('rename', STRINGS.health.fixes.rename, issues, changes),
			execute: async (change) => {
				const destination = change.targetPath;
				if (!destination) throw new Error('No destination for the rename.');
				await this.deps.app.fileManager.renameFile(
					this.requireFile(change.path),
					destination,
				);
			},
		};
	}

	/** Rewrite every variant of a tag group to its canonical spelling. */
	private async prepareMergeTags(
		issues: readonly HealthIssue[],
		canonicalOverride?: string,
	): Promise<PreparedFix> {
		/** path -> list of [from, to] rewrites to apply to that file. */
		const perFile = new Map<string, { from: string; to: string }[]>();

		for (const issue of issues) {
			if (issue.data.kind !== 'tag-inconsistency') continue;
			const data = issue.data;
			const canonical = canonicalOverride?.trim() || data.canonical;

			for (const path of data.paths) {
				const record = this.deps.index.get(path);
				if (!record) continue;
				const rewrites = perFile.get(path) ?? [];
				for (const variant of data.variants) {
					if (variant.tag === canonical) continue;
					if (!record.tags.includes(variant.tag)) continue;
					rewrites.push({ from: variant.tag, to: canonical });
				}
				if (rewrites.length > 0) perFile.set(path, rewrites);
			}
		}
		if (perFile.size === 0) throw new FixPlanError('No tag variants needed changing.');

		const changes: PlannedChange[] = Array.from(perFile.entries()).map(([path, rewrites]) => {
			const file = this.requireFile(path);
			return {
				path,
				kind: 'modify',
				description: `Rename ${rewrites.map((r) => `#${r.from}`).join(', ')}`,
				before: rewrites.map((r) => `#${r.from}`).join(', '),
				after: rewrites.map((r) => `#${r.to}`).join(', '),
				expectedMtime: file.stat.mtime,
			};
		});

		return {
			plan: this.buildPlan('merge-tags', STRINGS.health.fixes.mergeTags, issues, changes),
			execute: async (change) => {
				const file = this.requireFile(change.path);
				for (const rewrite of perFile.get(change.path) ?? []) {
					await this.deps.tag.renameTagInFile(file, rewrite.from, rewrite.to);
				}
			},
		};
	}

	/* ------------------------------------------------------------ internals -- */

	private buildPlan(
		actionId: FixActionId,
		label: string,
		issues: readonly HealthIssue[],
		changes: readonly PlannedChange[],
	): FixPlan {
		// Only existing files can be backed up; a `create` has nothing to preserve.
		const filesToBackup = Array.from(
			new Set(
				changes.filter((change) => change.kind !== 'create').map((change) => change.path),
			),
		);
		return {
			actionId,
			label,
			issues,
			changes,
			filesToBackup,
			destructive: this.isDestructive(actionId),
		};
	}

	private uniqueFiles(issues: readonly HealthIssue[]): TFile[] {
		const seen = new Set<string>();
		const files: TFile[] = [];
		for (const issue of issues) {
			if (seen.has(issue.path)) continue;
			seen.add(issue.path);
			const file = this.deps.app.vault.getFileByPath(issue.path);
			// A file that vanished between the scan and the fix is simply dropped here; the
			// safety gate would skip it anyway.
			if (file) files.push(file);
		}
		return files;
	}

	private requireFile(path: string): TFile {
		const file = this.deps.app.vault.getFileByPath(path);
		if (!file) throw new Error(STRINGS.errors.fileNotFound(path));
		return file;
	}

	private async ensureFolderFor(filePath: string): Promise<void> {
		const folder = filePath.slice(0, Math.max(0, filePath.lastIndexOf('/')));
		if (folder.length === 0) return;
		if (this.deps.app.vault.getAbstractFileByPath(folder) instanceof TFolder) return;
		try {
			await this.deps.app.vault.createFolder(folder);
		} catch (error) {
			if (!(this.deps.app.vault.getAbstractFileByPath(folder) instanceof TFolder)) {
				throw new Error(`Could not create "${folder}": ${errorMessage(error)}`);
			}
		}
	}

	private excerptOf(issues: readonly HealthIssue[]): string {
		return truncate(
			issues
				.map((issue) => (issue.data.kind === 'broken-link' ? issue.data.raw : issue.title))
				.join(', '),
			120,
		);
	}
}
