/**
 * The mandatory "review before we touch anything" step (main spec 6.3, appendix B).
 *
 * A {@link FixPlan} is inert data: it describes what *would* happen and carries an mtime for
 * every file it means to touch. This modal is the only thing that turns that description into
 * consent — it resolves `true` exclusively when the user presses the apply button, and `false`
 * for every other exit (cancel, Escape, clicking outside). The caller mints a confirmation
 * token from that `true` and hands it to the safety gate, which is what makes "never modify a
 * user file without preview and confirmation" a structural property rather than a convention.
 *
 * Changes are grouped by {@link ChangeKind} because "3 files modified, 1 moved, 2 trashed" is
 * the question a user actually has to answer; a flat list of paths hides the one destructive
 * row among nineteen harmless ones.
 */

import { setIcon, type App } from 'obsidian';
import type {
	ChangeKind,
	FixPlan,
	FixResult,
	PlannedChange,
	SkippedChange,
} from '../../types/health';
import { ICONS } from '../../core/constants';
import { STRINGS } from '../../core/strings';
import { JemzModal, JemzPromiseModal } from '../../ui/components/modal-base';

/**
 * Order the groups appear in: least to most destructive.
 *
 * The reader's eye lands on the bottom of the list last, which is where anything irreversible
 * should be.
 */
const CHANGE_KIND_ORDER: readonly ChangeKind[] = ['modify', 'create', 'move', 'trash', 'delete'];

/** Icon per change kind, so a group is identifiable before its text is read. */
const CHANGE_KIND_ICONS: Readonly<Record<ChangeKind, string>> = {
	modify: ICONS.open,
	create: ICONS.capture,
	move: ICONS.move,
	trash: ICONS.trash,
	delete: ICONS.trash,
};

/** How many distinct files a set of changes touches. */
function fileCountOf(changes: readonly PlannedChange[]): number {
	return new Set(changes.map((change) => change.path)).size;
}

export class FixPreviewModal extends JemzPromiseModal<boolean> {
	/**
	 * @param app Obsidian app, required by `Modal`.
	 * @param plan The batch awaiting approval. Never mutated here.
	 * @param backupDir Where the backup will be written, or null when this batch creates no
	 *   backup. Passed in rather than read from a service so the modal stays a pure renderer
	 *   and can be shown for a plan the backup layer has not seen yet.
	 */
	constructor(
		app: App,
		private readonly plan: FixPlan,
		private readonly backupDir: string | null = null,
	) {
		// The default result is `false`: dismissing the modal must never be read as consent.
		super(app, STRINGS.preview.title, false, 'jva-preview');
	}

	protected renderBody(body: HTMLElement): void {
		body.createDiv({
			cls: 'jva-preview__summary',
			text: STRINGS.preview.summary(fileCountOf(this.plan.changes), this.plan.changes.length),
		});

		const warning = body.createDiv({ cls: 'jva-preview__warning' });
		const warningIcon = warning.createSpan({ cls: 'jva-list-item__icon' });
		setIcon(warningIcon, ICONS.warning);
		warning.createSpan({
			text: this.plan.destructive
				? STRINGS.preview.destructiveWarning
				: STRINGS.preview.warning,
		});

		// A plan that only creates files has nothing to preserve, so "no backup" is the honest
		// line there too — there is no earlier state to restore.
		const backed = this.backupDir !== null && this.plan.filesToBackup.length > 0;
		body.createDiv({
			cls: 'jva-preview__backup',
			text: backed
				? STRINGS.preview.backupLocation(this.backupDir ?? '')
				: STRINGS.preview.noBackup,
		});

		for (const kind of CHANGE_KIND_ORDER) {
			const changes = this.plan.changes.filter((change) => change.kind === kind);
			if (changes.length === 0) continue;
			this.renderGroup(body, kind, changes);
		}
	}

	/** One `.jva-preview__group`: a counted header plus every change of that kind. */
	private renderGroup(
		parent: HTMLElement,
		kind: ChangeKind,
		changes: readonly PlannedChange[],
	): void {
		const group = parent.createDiv({ cls: 'jva-preview__group' });
		// A machine-readable hook for styling and tests; the visible label stays in STRINGS.
		group.setAttr('data-kind', kind);

		const header = group.createDiv({ cls: 'jva-preview__group-header' });
		const icon = header.createSpan({ cls: 'jva-list-item__icon' });
		setIcon(icon, CHANGE_KIND_ICONS[kind]);
		header.createSpan({
			text: STRINGS.preview.summary(fileCountOf(changes), changes.length),
		});

		const list = group.createDiv({ cls: 'jva-preview__changes' });
		for (const change of changes) this.renderChange(list, change);
	}

	/** One row: the path, the destination for a move, the description, and the diff. */
	private renderChange(parent: HTMLElement, change: PlannedChange): void {
		const row = parent.createDiv({ cls: 'jva-preview__change' });
		row.createDiv({ cls: 'jva-preview__change-path', text: change.path });
		if (change.targetPath) {
			row.createDiv({ cls: 'jva-preview__change-path', text: change.targetPath });
		}
		row.createDiv({ cls: 'jva-muted', text: change.description });

		if (change.before === undefined && change.after === undefined) return;
		const diff = row.createDiv({ cls: 'jva-preview__diff' });
		if (change.before !== undefined) {
			diff.createDiv({ cls: 'jva-preview__diff-before', text: change.before });
		}
		if (change.after !== undefined) {
			diff.createDiv({ cls: 'jva-preview__diff-after', text: change.after });
		}
	}

	protected override renderFooter(footer: HTMLElement): void {
		this.renderActions(footer, [
			{ label: STRINGS.common.cancel, onClick: (): void => this.settle(false) },
			{
				label: STRINGS.common.apply,
				// A destructive batch is never the visually primary choice.
				cta: !this.plan.destructive,
				warning: this.plan.destructive,
				onClick: (): void => this.settle(true),
			},
		]);
	}
}

export class FixResultModal extends JemzModal {
	/**
	 * @param app Obsidian app, required by `Modal`.
	 * @param result What the safety gate actually did. Skipped and failed entries carry their
	 *   own reason, which is the only place a user learns that a file changed underneath the
	 *   preview and was therefore left alone.
	 */
	constructor(
		app: App,
		private readonly result: FixResult,
	) {
		super(app, STRINGS.preview.resultTitle, 'jva-result');
	}

	protected renderBody(body: HTMLElement): void {
		const counts = body.createDiv({ cls: 'jva-stack' });
		this.renderCount(counts, STRINGS.preview.resultApplied(this.result.applied.length));
		// Zero skipped and zero failed are the normal case; printing them adds noise to the
		// outcome the user came here to read.
		if (this.result.skipped.length > 0) {
			this.renderCount(counts, STRINGS.preview.resultSkipped(this.result.skipped.length));
		}
		if (this.result.failed.length > 0) {
			this.renderCount(counts, STRINGS.preview.resultFailed(this.result.failed.length));
		}

		const problems: readonly SkippedChange[] = [...this.result.skipped, ...this.result.failed];
		if (problems.length > 0) {
			const list = body.createDiv({ cls: 'jva-stack' });
			for (const problem of problems) this.renderProblem(list, problem);
		}

		// Only true when something was copied first; otherwise the hint points at a backup that
		// does not contain this batch.
		if (this.result.backupDir !== null) {
			body.createDiv({ cls: 'jva-preview__backup', text: STRINGS.preview.restoreHint });
		}
	}

	private renderCount(parent: HTMLElement, text: string): void {
		parent.createDiv({ cls: 'jva-result__row' }).createSpan({ text });
	}

	private renderProblem(parent: HTMLElement, problem: SkippedChange): void {
		const row = parent.createDiv({ cls: 'jva-result__row' });
		row.createSpan({ cls: 'jva-preview__change-path', text: problem.change.path });
		row.createSpan({ cls: 'jva-result__reason', text: problem.reason });
	}

	protected override renderFooter(footer: HTMLElement): void {
		this.renderActions(footer, [
			{ label: STRINGS.common.done, cta: true, onClick: (): void => this.close() },
		]);
	}
}
