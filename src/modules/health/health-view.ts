/**
 * The Health tab (main spec 6.2 and 6.3).
 *
 * Three regions stacked in one scroll container: a score summary, a grid of category cards
 * that doubles as the filter control, and the issue list with its selection toolbar.
 *
 * Everything the panel does to the vault funnels through one method, {@link HealthPanel.runFix},
 * which walks the fixed pipeline `prepare -> preview -> confirm -> execute -> log -> rescan`.
 * Keeping it in a single place is deliberate: a second, shorter path to `vault.modify` is
 * exactly how a plugin ends up writing a file the user never approved.
 *
 * The panel owns no timers and subscribes to the bus only through {@link Component.register},
 * so a closed dashboard leaves nothing behind.
 */

import { Component, Notice, Platform, setIcon, type App } from 'obsidian';
import type {
	FixPlan,
	FixResult,
	HealthIssue,
	IssueSeverity,
	IssueType,
	ScanProgress,
} from '../../types/health';
import { ISSUE_TYPES } from '../../types/health';
import type { DashboardTab } from '../../types/events';
import { ICONS } from '../../core/constants';
import type { EventBus } from '../../core/event-bus';
import type { Logger } from '../../core/logger';
import type { SettingsStore } from '../../core/settings';
import { STRINGS } from '../../core/strings';
import type { SafetyGate } from '../../core/safety';
import {
	BackupFailedError,
	grantConfirmation,
	planIdOf,
	ReadOnlyVaultError,
	UnconfirmedChangeError,
} from '../../core/safety';
import { formatRelative } from '../../utils/date';
import { getBasename } from '../../utils/file';
import type { ActionLogService } from '../../services/action-log-service';
import type { BackupService } from '../../services/backup-service';
import type { HealthService } from '../../services/health-service';
import type { VaultIndex } from '../../services/vault-index';
import { createButton, createButtonRow, setButtonDisabled } from '../../ui/components/button';
import {
	renderEmptyState,
	renderErrorState,
	renderInlineEmpty,
} from '../../ui/components/empty-state';
import { renderListItem } from '../../ui/components/list-item';
import { JemzPromiseModal } from '../../ui/components/modal-base';
import { pickNote } from '../../ui/components/note-suggest';
import { ProgressBar } from '../../ui/components/progress-bar';
import { TagInput } from '../../ui/components/tag-input';
import type { TabPanel } from '../dashboard/tab-manager';
import type { FixActionDescriptor, FixActions, FixParams, PreparedFix } from './fix-actions';
import { scoreBand } from './health-score';
import { FixPreviewModal, FixResultModal } from './preview-modal';

/** Everything the panel needs. Injected so the whole tab is drivable from a test. */
export interface HealthPanelDeps {
	app: App;
	health: HealthService;
	fixes: FixActions;
	safety: SafetyGate;
	backup: BackupService;
	actionLog: ActionLogService;
	index: VaultIndex;
	settings: SettingsStore;
	bus: EventBus;
	logger: Logger;
	/** Opens the plugin's settings tab, used by the summary row and the disabled-module state. */
	onOpenSettings: () => void;
}

/** What the panel is currently doing, which decides what the status region shows. */
type PanelPhase = 'idle' | 'scanning' | 'applying' | 'error';

/** Label for each score band. */
const BAND_LABELS: Readonly<Record<'excellent' | 'good' | 'fair' | 'poor', string>> = {
	excellent: STRINGS.health.scoreExcellent,
	good: STRINGS.health.scoreGood,
	fair: STRINGS.health.scoreFair,
	poor: STRINGS.health.scorePoor,
};

/** Icon per issue category, drawn only from the plugin's icon table. */
/**
 * One distinct icon per category.
 *
 * Reusing a single generic file-with-a-question-mark for four categories made the cards read
 * as broken placeholders rather than as different problems, so each now gets a glyph that
 * says something about the problem it represents.
 */
const ISSUE_ICONS: Readonly<Record<IssueType, string>> = {
	'broken-link': ICONS.unlink,
	'orphan-note': ICONS.orphan,
	'empty-note': ICONS.emptyFile,
	'unused-attachment': ICONS.attachment,
	'duplicate-title': ICONS.copy,
	'tag-inconsistency': ICONS.tag,
	'missing-metadata': ICONS.properties,
	'large-file': ICONS.diskSpace,
	'corrupted-frontmatter': ICONS.warning,
};

/** Most urgent first, so the list opens on what matters. */
const SEVERITY_ORDER: Readonly<Record<IssueSeverity, number>> = { high: 0, medium: 1, low: 2 };

/** Map a thrown error onto the one sentence the user should see. */
function noticeFor(error: unknown): string {
	if (error instanceof ReadOnlyVaultError) return STRINGS.errors.vaultReadOnly;
	if (error instanceof BackupFailedError) return STRINGS.backup.failed;
	if (error instanceof UnconfirmedChangeError) return STRINGS.errors.notConfirmed;
	return STRINGS.errors.unexpected;
}

export class HealthPanel extends Component implements TabPanel {
	readonly tab: DashboardTab = 'health';

	private rootEl: HTMLElement | null = null;
	private summaryEl: HTMLElement | null = null;
	private statusEl: HTMLElement | null = null;
	private cardsEl: HTMLElement | null = null;
	private issuesEl: HTMLElement | null = null;

	private progress: ProgressBar | null = null;
	private phase: PanelPhase = 'idle';
	private progressValue = 0;
	private progressTotal = 0;
	/** Raw failure text from the scan engine. Logged, never rendered verbatim. */
	private failureDetail: string | null = null;

	/** Selected issue ids. Ids are stable across scans, so a rescan keeps the selection. */
	private readonly selected = new Set<string>();
	private filter: IssueType | null = null;

	/** Toolbar buttons kept so a checkbox toggle updates them without rebuilding the list. */
	private toolbarButtons: {
		clear: HTMLButtonElement;
		fix: HTMLButtonElement;
		ignore: HTMLButtonElement;
	} | null = null;

	constructor(private readonly deps: HealthPanelDeps) {
		super();
	}

	/**
	 * Build the panel's DOM and subscribe to scan events.
	 *
	 * Deliberately does not start a scan: opening a tab must never cost a vault-wide read, so
	 * the first scan is always something the user asked for.
	 */
	mount(container: HTMLElement): void {
		this.rootEl = container.createDiv({ cls: 'jva-view' });
		this.summaryEl = this.rootEl.createDiv({ cls: 'jva-health__summary' });
		this.statusEl = this.rootEl.createDiv({ cls: 'jva-stack' });
		this.cardsEl = this.rootEl.createDiv({ cls: 'jva-health__cards' });
		this.issuesEl = this.rootEl.createDiv({ cls: 'jva-health__issues' });

		this.register(this.deps.bus.on('scan-started', (payload) => this.onScanStarted(payload)));
		this.register(this.deps.bus.on('scan-progress', (payload) => this.onScanProgress(payload)));
		this.register(this.deps.bus.on('scan-completed', () => this.onScanCompleted()));
		this.register(this.deps.bus.on('scan-failed', (payload) => this.onScanFailed(payload)));

		this.renderAll();
	}

	/** Redraw from the current report. Cheap enough to call on every tab activation. */
	refresh(): void {
		this.renderAll();
	}

	/**
	 * Release every subscription and drop the DOM.
	 *
	 * `unload()` runs the cleanups collected by `register`, which is where the bus
	 * unsubscribes live, so nothing keeps a reference to a closed view.
	 */
	unmount(): void {
		this.unload();
		this.progress?.destroy();
		this.progress = null;
		this.toolbarButtons = null;
		this.rootEl?.detach();
		this.rootEl = null;
		this.summaryEl = null;
		this.statusEl = null;
		this.cardsEl = null;
		this.issuesEl = null;
		this.selected.clear();
	}

	/* --------------------------------------------------------------- rendering -- */

	private renderAll(): void {
		if (!this.rootEl) return;
		this.renderSummary();
		this.renderStatus();
		this.renderCards();
		this.renderIssues();
	}

	/** Score, band, last-scan time, and the two always-available actions. */
	private renderSummary(): void {
		const el = this.summaryEl;
		if (!el) return;
		el.empty();

		const health = this.deps.health;
		if (health.hasScanned) {
			const value = health.score;
			const band = scoreBand(value);
			const scoreEl = el.createDiv({ cls: ['jva-score', `jva-score--${band}`] });
			scoreEl.setAttr('aria-label', `${STRINGS.health.score} ${Math.round(value)}`);
			scoreEl.createDiv({ cls: 'jva-score__value', text: String(Math.round(value)) });

			const meter = scoreEl.createDiv({ cls: 'jva-score__meter' });
			meter.setAttr('role', 'progressbar');
			meter.setAttr('aria-valuemin', '0');
			meter.setAttr('aria-valuemax', '100');
			meter.setAttr('aria-valuenow', String(Math.round(value)));
			// A width percentage is geometry, not colour; the fill's colour comes from the
			// band class on the wrapper.
			meter.createDiv({ cls: 'jva-score__meter-fill' }).style.width =
				`${Math.max(0, Math.min(100, value))}%`;

			scoreEl.createDiv({ cls: 'jva-score__label', text: BAND_LABELS[band] });

			const meta = el.createDiv({ cls: 'jva-health__meta' });
			const lastScanAt = this.lastScanAt();
			if (lastScanAt !== null) {
				meta.createDiv({
					cls: 'jva-muted',
					text: STRINGS.health.lastScan(formatRelative(lastScanAt)),
				});
			}
			meta.createDiv({
				cls: 'jva-muted',
				text: STRINGS.health.issueCount(health.report.issues.length),
			});
		}

		const actions = createButtonRow(el);
		// On a phone the labels push the buttons off the row, and the icons carry the meaning
		// on their own; the 44px touch target comes from the shared button styles either way.
		const compact = Platform.isMobile;
		createButton(actions, {
			...(compact ? {} : { label: STRINGS.health.rescan }),
			icon: ICONS.refresh,
			tooltip: STRINGS.health.rescan,
			cta: true,
			disabled: this.phase === 'scanning' || this.phase === 'applying',
			onClick: (): void => void this.rescan(),
		});
		createButton(actions, {
			...(compact ? {} : { label: STRINGS.health.settings }),
			icon: ICONS.settings,
			tooltip: STRINGS.health.settings,
			onClick: (): void => this.deps.onOpenSettings(),
		});
	}

	/** Progress bar while scanning or applying, error state when a scan failed. */
	private renderStatus(): void {
		const el = this.statusEl;
		if (!el) return;
		el.empty();
		this.progress = null;

		if (this.phase === 'scanning' || this.phase === 'applying') {
			this.progress = new ProgressBar(el);
			this.progress.setProgress(
				this.progressValue,
				this.progressTotal,
				this.phase === 'scanning'
					? STRINGS.health.scanning(this.progressValue, this.progressTotal)
					: STRINGS.preview.applying(this.progressValue, this.progressTotal),
			);
			return;
		}

		if (this.phase === 'error') {
			renderErrorState(el, {
				title: STRINGS.health.scanFailed,
				body: STRINGS.errors.unexpected,
				retryLabel: STRINGS.common.retry,
				onRetry: (): void => void this.rescan(),
			});
		}
	}

	/** One card per category. Categories with nothing wrong stay visible but dimmed. */
	private renderCards(): void {
		const el = this.cardsEl;
		if (!el) return;
		el.empty();
		if (!this.deps.health.hasScanned) return;

		const counts = this.deps.health.report.countsByType;
		const ordered = [...ISSUE_TYPES].sort(
			(a, b) => counts[b] - counts[a] || ISSUE_TYPES.indexOf(a) - ISSUE_TYPES.indexOf(b),
		);

		for (const type of ordered) {
			const count = counts[type];
			const card = el.createEl('button', { cls: 'jva-health-card' });
			card.setAttr('data-type', type);
			card.toggleClass('is-clear', count === 0);
			card.toggleClass('is-active', this.filter === type);
			card.setAttr('aria-pressed', String(this.filter === type));

			const top = card.createDiv({ cls: 'jva-health-card__top' });
			const icon = top.createSpan({ cls: 'jva-list-item__icon' });
			setIcon(icon, ISSUE_ICONS[type]);
			top.createSpan({ text: STRINGS.health.types[type] });
			top.createSpan({ cls: 'jva-health-card__count', text: String(count) });
			card.createDiv({
				cls: 'jva-health-card__label',
				text: STRINGS.health.typeDescriptions[type],
			});

			if (count === 0) {
				// Filtering to a category with nothing in it would just empty the list.
				card.setAttr('disabled', 'true');
				card.setAttr('aria-disabled', 'true');
				continue;
			}
			this.registerDomEvent(card, 'click', () => {
				this.filter = this.filter === type ? null : type;
				this.renderCards();
				this.renderIssues();
			});
		}
	}

	/** Toolbar plus the (optionally filtered) issue rows, with an empty state for every case. */
	private renderIssues(): void {
		const el = this.issuesEl;
		if (!el) return;
		el.empty();
		this.toolbarButtons = null;

		const health = this.deps.health;
		if (!health.hasScanned) {
			renderEmptyState(el, {
				icon: ICONS.health,
				title: STRINGS.health.neverScanned,
				actionLabel: STRINGS.health.scanCta,
				actionIcon: ICONS.refresh,
				onAction: (): void => void this.rescan(),
			});
			return;
		}

		const issues = health.report.issues;
		if (issues.length === 0) {
			renderEmptyState(el, {
				icon: ICONS.success,
				title: STRINGS.health.healthyTitle,
				body: STRINGS.health.healthyBody,
				actionLabel: STRINGS.health.rescan,
				actionIcon: ICONS.refresh,
				onAction: (): void => void this.rescan(),
			});
			return;
		}

		const visible = this.filter
			? issues.filter((issue) => issue.type === this.filter)
			: [...issues];
		visible.sort(
			(a, b) =>
				SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
				a.type.localeCompare(b.type) ||
				a.path.localeCompare(b.path),
		);

		this.renderToolbar(el, visible.length);

		const list = el.createDiv({ cls: 'jva-list' });
		if (visible.length === 0) {
			renderInlineEmpty(list, STRINGS.common.noResults);
			return;
		}
		for (const issue of visible) this.renderIssue(list, issue);
		this.updateToolbarState();
	}

	private renderToolbar(parent: HTMLElement, visibleCount: number): void {
		const bar = parent.createDiv({ cls: 'jva-health__issue-toolbar' });
		bar.createSpan({ cls: 'jva-muted', text: STRINGS.health.issueCount(visibleCount) });
		bar.createDiv({ cls: 'jva-spacer' });

		createButton(bar, {
			label: STRINGS.health.selectAll,
			disabled: visibleCount === 0,
			onClick: (): void => {
				for (const issue of this.visibleIssues()) this.selected.add(issue.id);
				this.renderIssues();
			},
		});
		const clear = createButton(bar, {
			label: STRINGS.health.clearSelection,
			onClick: (): void => {
				this.selected.clear();
				this.renderIssues();
			},
		});
		const fix = createButton(bar, {
			label: STRINGS.health.fixSelected,
			cta: true,
			onClick: (): void => void this.fixSelection(),
		});
		const ignore = createButton(bar, {
			label: STRINGS.health.ignoreSelected,
			onClick: (): void => void this.ignoreIssues(this.selectedIssues()),
		});

		this.toolbarButtons = { clear, fix, ignore };
		this.updateToolbarState();
	}

	private renderIssue(parent: HTMLElement, issue: HealthIssue): void {
		const descriptors = this.deps.fixes.actionsFor(issue.type);
		renderListItem(parent, {
			title: issue.title,
			icon: ISSUE_ICONS[issue.type],
			meta: [issue.path, STRINGS.health.types[issue.type]],
			preview: issue.detail,
			cls: `jva-issue--${issue.severity}`,
			selectable: true,
			selected: this.selected.has(issue.id),
			onSelectChange: (selected): void => {
				if (selected) this.selected.add(issue.id);
				else this.selected.delete(issue.id);
				// Only the toolbar depends on the selection, so the list keeps its scroll
				// position and the checkbox keeps focus.
				this.updateToolbarState();
			},
			onActivate: (): void => void this.openIssue(issue),
			actions: descriptors.map((descriptor) => ({
				label: descriptor.label,
				tooltip: descriptor.label,
				warning: descriptor.destructive === true,
				onClick: (): void => void this.runFix(descriptor, this.targetsFor(issue)),
			})),
		});
	}

	/** Reflect the current selection on the toolbar without rebuilding anything. */
	private updateToolbarState(): void {
		const buttons = this.toolbarButtons;
		if (!buttons) return;
		const selection = this.selectedIssues();
		setButtonDisabled(buttons.clear, selection.length === 0);
		setButtonDisabled(buttons.ignore, selection.length === 0);
		setButtonDisabled(buttons.fix, this.batchAction(selection) === null);
	}

	/* ------------------------------------------------------------- selection -- */

	private visibleIssues(): HealthIssue[] {
		const issues = this.deps.health.report.issues;
		return this.filter ? issues.filter((issue) => issue.type === this.filter) : [...issues];
	}

	private selectedIssues(): HealthIssue[] {
		return this.deps.health.report.issues.filter((issue) => this.selected.has(issue.id));
	}

	/**
	 * The fix "Fix selected" would run.
	 *
	 * A batch has to be one category — a plan mixes file operations that only make sense for
	 * one kind of problem — so a mixed selection disables the button instead of silently
	 * fixing part of it.
	 *
	 * @returns The first non-ignore action for the selection's category, or null when the
	 *   selection is empty, spans categories, or offers nothing but "ignore".
	 */
	private batchAction(selection: readonly HealthIssue[]): FixActionDescriptor | null {
		if (selection.length === 0) return null;
		const types = new Set(selection.map((issue) => issue.type));
		if (types.size !== 1) return null;
		const type = selection[0]?.type;
		if (!type) return null;
		return this.deps.fixes.actionsFor(type).find((action) => action.id !== 'ignore') ?? null;
	}

	/** A row action applies to the whole selection when that row is part of it. */
	private targetsFor(issue: HealthIssue): HealthIssue[] {
		if (!this.selected.has(issue.id)) return [issue];
		return this.selectedIssues().filter((candidate) => candidate.type === issue.type);
	}

	private async fixSelection(): Promise<void> {
		const selection = this.selectedIssues();
		const action = this.batchAction(selection);
		if (!action) return;
		await this.runFix(action, selection);
	}

	/* ------------------------------------------------------------------ scans -- */

	private lastScanAt(): number | null {
		const generatedAt = this.deps.health.report.generatedAt;
		if (generatedAt > 0) return generatedAt;
		return this.deps.settings.get().health.lastScanAt;
	}

	/**
	 * Run a full scan.
	 *
	 * The service swallows its own failures and announces them on the bus, so the catch here
	 * only covers something unexpected escaping it.
	 */
	private async rescan(): Promise<void> {
		if (this.deps.health.isScanning) return;
		try {
			await this.deps.health.runFullScan();
		} catch (error) {
			this.deps.logger.error('Health scan failed', error);
			new Notice(STRINGS.health.scanFailed);
			this.phase = 'error';
		} finally {
			// A cancelled scan resolves without a completion event; do not leave the panel
			// stuck behind a progress bar that will never move again.
			if (this.phase === 'scanning') this.phase = 'idle';
			this.renderAll();
		}
	}

	private onScanStarted(payload: { total: number; kind: string }): void {
		this.phase = 'scanning';
		this.progressValue = 0;
		this.progressTotal = payload.total;
		this.failureDetail = null;
		this.renderSummary();
		this.renderStatus();
	}

	private onScanProgress(payload: ScanProgress): void {
		if (this.phase !== 'scanning') return;
		this.progressValue = payload.processed;
		this.progressTotal = payload.total;
		this.progress?.setProgress(
			payload.processed,
			payload.total,
			STRINGS.health.scanning(payload.processed, payload.total),
		);
	}

	private onScanCompleted(): void {
		this.phase = 'idle';
		this.failureDetail = null;
		this.pruneSelection();
		this.renderAll();
	}

	private onScanFailed(payload: { error: string }): void {
		this.phase = 'error';
		this.failureDetail = payload.error;
		// The reason is diagnostic detail, so it goes to the console rather than the panel.
		this.deps.logger.error(`Health scan failed: ${payload.error}`);
		this.renderAll();
	}

	/** Forget selected ids that the newest report no longer contains. */
	private pruneSelection(): void {
		const live = new Set(this.deps.health.report.issues.map((issue) => issue.id));
		for (const id of [...this.selected]) {
			if (!live.has(id)) this.selected.delete(id);
		}
	}

	/* ------------------------------------------------------------------ fixes -- */

	/**
	 * The one path from "the user pressed a fix button" to "the vault changed".
	 *
	 * Every step is mandatory and ordered: collect any extra input, build a plan, show it,
	 * stop dead unless the preview was approved, mint a token for *that* plan, hand the plan
	 * and the token to the safety gate, record what happened, then rescan so the list reflects
	 * reality rather than the pre-fix report.
	 */
	private async runFix(
		descriptor: FixActionDescriptor,
		issues: readonly HealthIssue[],
	): Promise<void> {
		if (issues.length === 0) return;
		if (descriptor.id === 'ignore') {
			await this.ignoreIssues(issues);
			return;
		}

		let params: FixParams = {};
		if (descriptor.needsInput) {
			const collected = await this.collectInput(descriptor.needsInput, issues);
			// Backing out of the input backs out of the whole action: nothing is prepared,
			// nothing is previewed, nothing is written.
			if (collected === null) return;
			params = collected;
		}

		let prepared: PreparedFix;
		try {
			prepared = await this.deps.fixes.prepare(descriptor.id, issues, params);
		} catch (error) {
			this.reportFailure('prepare the fix', error);
			return;
		}

		const approved = await new FixPreviewModal(
			this.deps.app,
			prepared.plan,
			this.backupTarget(prepared.plan),
		).openAndWait();
		// A rejected preview must leave every byte exactly where it was.
		if (!approved) return;

		const token = grantConfirmation(planIdOf(prepared.plan));
		this.phase = 'applying';
		this.progressValue = 0;
		this.progressTotal = prepared.plan.changes.length;
		this.renderStatus();

		let result: FixResult;
		try {
			result = await this.deps.safety.execute(prepared.plan, token, prepared.execute, {
				onProgress: (done, total): void => {
					this.progressValue = done;
					this.progressTotal = total;
					this.progress?.setProgress(done, total, STRINGS.preview.applying(done, total));
				},
			});
		} catch (error) {
			this.phase = 'idle';
			this.renderStatus();
			this.reportFailure('apply the fix', error);
			return;
		}

		this.phase = 'idle';
		this.renderStatus();

		await this.recordResult(prepared.plan, result);
		new FixResultModal(this.deps.app, result).open();
		this.selected.clear();
		await this.rescan();
	}

	/** Where the backup for this plan will land, or null when it protects nothing. */
	private backupTarget(plan: FixPlan): string | null {
		return plan.filesToBackup.length > 0 ? this.deps.backup.rootDir() : null;
	}

	/**
	 * Write the batch into the audit trail.
	 *
	 * A failure here is reported but never rethrown: the vault has already changed, and losing
	 * the log entry is a smaller problem than leaving the user believing the fix failed.
	 */
	private async recordResult(plan: FixPlan, result: FixResult): Promise<void> {
		const outcome: 'success' | 'failure' | 'partial' =
			result.failed.length === 0 && result.skipped.length === 0
				? 'success'
				: result.applied.length > 0
					? 'partial'
					: 'failure';

		try {
			await this.deps.actionLog.log({
				action: plan.actionId,
				details: [
					STRINGS.preview.resultApplied(result.applied.length),
					STRINGS.preview.resultSkipped(result.skipped.length),
					STRINGS.preview.resultFailed(result.failed.length),
				].join(' · '),
				files: result.applied.map((change) => change.path),
				result: outcome,
				...(result.backupDir ? { backupDir: result.backupDir } : {}),
			});
		} catch (error) {
			this.deps.logger.error('Could not record the fix in the action log', error);
			new Notice(STRINGS.errors.unexpected);
		}
	}

	/** Suppress issues from every future scan, then rescan so they disappear from the list. */
	private async ignoreIssues(issues: readonly HealthIssue[]): Promise<void> {
		if (issues.length === 0) return;
		try {
			await this.deps.health.ignore(issues);
		} catch (error) {
			this.reportFailure('ignore the selected issues', error);
			return;
		}
		this.selected.clear();
		await this.rescan();
	}

	private async openIssue(issue: HealthIssue): Promise<void> {
		try {
			await this.deps.app.workspace.openLinkText(issue.path, issue.path, false);
		} catch (error) {
			this.deps.logger.error(`Could not open "${issue.path}"`, error);
			new Notice(STRINGS.errors.fileNotFound(issue.path));
		}
	}

	private reportFailure(stage: string, error: unknown): void {
		this.deps.logger.error(`Could not ${stage}`, error);
		new Notice(noticeFor(error));
	}

	/* ------------------------------------------------------------------ input -- */

	/**
	 * Collect whatever a fix needs before a plan can exist.
	 *
	 * @returns The parameters, or null when the user backed out — which cancels everything.
	 */
	private async collectInput(
		kind: NonNullable<FixActionDescriptor['needsInput']>,
		issues: readonly HealthIssue[],
	): Promise<FixParams | null> {
		switch (kind) {
			case 'note': {
				const first = issues[0];
				const seed = first && first.data.kind === 'broken-link' ? first.data.target : '';
				const file = await pickNote(this.deps.app, {
					placeholder: STRINGS.inbox.selectNote,
					exclude: new Set(issues.map((issue) => issue.path)),
					...(seed.length > 0 ? { initialQuery: seed } : {}),
				});
				return file ? { targetPath: file.path } : null;
			}
			case 'tag': {
				const tag = await new TagPromptModal(
					this.deps.app,
					Array.from(this.deps.index.tagCounts().keys()),
				).openAndWait();
				return tag ? { tag } : null;
			}
			case 'name': {
				const current = issues[0] ? getBasename(issues[0].path) : '';
				const name = await new TextPromptModal(this.deps.app, {
					title: STRINGS.common.rename,
					label: STRINGS.capture.titleLabel,
					initial: current,
					cta: STRINGS.common.rename,
				}).openAndWait();
				return name ? { newName: name } : null;
			}
			case 'properties': {
				const properties = await new PropertiesPromptModal(
					this.deps.app,
					this.missingKeys(issues),
				).openAndWait();
				return properties ? { properties } : null;
			}
			default:
				return null;
		}
	}

	/** Property names the selected notes are missing, falling back to the configured list. */
	private missingKeys(issues: readonly HealthIssue[]): string[] {
		const keys = new Set<string>();
		for (const issue of issues) {
			if (issue.data.kind !== 'missing-metadata') continue;
			for (const key of issue.data.missing) keys.add(key);
		}
		if (keys.size === 0) {
			for (const key of this.deps.settings.get().health.requiredFrontmatterFields) {
				keys.add(key);
			}
		}
		return Array.from(keys);
	}
}

/* ------------------------------------------------------------------ prompts -- */

/**
 * One-line text prompt.
 *
 * Used by "Rename"; an empty value settles as null so pressing the confirm button on a blank
 * field cancels rather than asking the fix layer to rename a note to nothing.
 */
class TextPromptModal extends JemzPromiseModal<string | null> {
	private inputEl: HTMLInputElement | null = null;

	constructor(
		app: App,
		private readonly options: {
			title: string;
			label: string;
			initial: string;
			cta: string;
		},
	) {
		super(app, options.title, null, 'jva-confirm');
	}

	protected renderBody(body: HTMLElement): void {
		const field = body.createDiv({ cls: 'jva-field' });
		field.createDiv({ cls: 'jva-field__label', text: this.options.label });
		const input = field.createEl('input', {
			type: 'text',
			value: this.options.initial,
		});
		input.setAttr('aria-label', this.options.label);
		input.addEventListener('keydown', (event) => {
			if (event.key !== 'Enter') return;
			event.preventDefault();
			this.submit();
		});
		this.inputEl = input;
	}

	override onOpen(): void {
		super.onOpen();
		this.inputEl?.focus();
	}

	protected override renderFooter(footer: HTMLElement): void {
		this.renderActions(footer, [
			{ label: STRINGS.common.cancel, onClick: (): void => this.settle(null) },
			{ label: this.options.cta, cta: true, onClick: (): void => this.submit() },
		]);
	}

	private submit(): void {
		const value = this.inputEl?.value.trim() ?? '';
		this.settle(value.length > 0 ? value : null);
	}
}

/** Tag prompt backed by the shared tag input, so suggestions come from the vault's own tags. */
class TagPromptModal extends JemzPromiseModal<string | null> {
	private input: TagInput | null = null;

	constructor(
		app: App,
		private readonly suggestions: readonly string[],
	) {
		super(app, STRINGS.inbox.addTagPrompt, null, 'jva-confirm');
	}

	protected renderBody(body: HTMLElement): void {
		const field = body.createDiv({ cls: 'jva-field' });
		field.createDiv({ cls: 'jva-field__label', text: STRINGS.capture.tagsLabel });
		this.input = new TagInput(field, {
			placeholder: STRINGS.capture.tagsPlaceholder,
			suggestions: this.suggestions,
		});
	}

	override onOpen(): void {
		super.onOpen();
		this.input?.focus();
	}

	protected override renderFooter(footer: HTMLElement): void {
		this.renderActions(footer, [
			{ label: STRINGS.common.cancel, onClick: (): void => this.settle(null) },
			{
				label: STRINGS.health.fixes.addTag,
				cta: true,
				// The fix layer takes one tag; extra chips are ignored rather than rejected.
				onClick: (): void => this.settle(this.input?.value[0] ?? null),
			},
		]);
	}
}

/**
 * Key/value prompt for "Add properties".
 *
 * The keys are fixed to the ones the selected notes are actually missing, so the user fills in
 * values instead of retyping property names the detector already knows.
 */
class PropertiesPromptModal extends JemzPromiseModal<Record<string, unknown> | null> {
	private readonly inputs = new Map<string, HTMLInputElement>();

	constructor(
		app: App,
		private readonly keys: readonly string[],
	) {
		super(app, STRINGS.health.fixes.addMetadata, null, 'jva-confirm');
	}

	protected renderBody(body: HTMLElement): void {
		if (this.keys.length === 0) {
			renderInlineEmpty(body, STRINGS.common.noResults);
			return;
		}
		for (const key of this.keys) {
			const field = body.createDiv({ cls: 'jva-field' });
			// The label is the property name from the vault, not UI copy.
			field.createDiv({ cls: 'jva-field__label', text: key });
			const input = field.createEl('input', { type: 'text' });
			input.setAttr('aria-label', key);
			this.inputs.set(key, input);
		}
	}

	protected override renderFooter(footer: HTMLElement): void {
		this.renderActions(footer, [
			{ label: STRINGS.common.cancel, onClick: (): void => this.settle(null) },
			{ label: STRINGS.common.save, cta: true, onClick: (): void => this.submit() },
		]);
	}

	private submit(): void {
		const properties: Record<string, unknown> = {};
		for (const [key, input] of this.inputs) {
			const value = input.value.trim();
			if (value.length > 0) properties[key] = value;
		}
		// Nothing filled in means nothing to write, which is the same outcome as cancelling.
		this.settle(Object.keys(properties).length > 0 ? properties : null);
	}
}
