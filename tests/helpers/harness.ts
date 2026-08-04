/**
 * Builds the plugin's real service graph over a mock vault.
 *
 * Integration tests drive the same objects the plugin constructs in `main.ts`, so a test
 * that passes here is exercising production wiring rather than a parallel arrangement that
 * happens to agree with it.
 */

import type { App } from '../mocks/obsidian';
import type { App as ObsidianApp } from 'obsidian';
import type { JemzSettings } from '../../src/types/settings';
import { DEFAULT_SETTINGS } from '../../src/types/settings';
import { EventBus } from '../../src/core/event-bus';
import { Logger } from '../../src/core/logger';
import { SettingsStore, structuredCloneSafe } from '../../src/core/settings';
import { SafetyGate } from '../../src/core/safety';
import { VaultIndex } from '../../src/services/vault-index';
import { ContentIndex } from '../../src/services/content-index';
import { MetadataService } from '../../src/services/metadata-service';
import { LinkService } from '../../src/services/link-service';
import { TagService } from '../../src/services/tag-service';
import { AttachmentService } from '../../src/services/attachment-service';
import { CaptureService } from '../../src/services/capture-service';
import { InboxService } from '../../src/services/inbox-service';
import { HealthService } from '../../src/services/health-service';
import { RetrievalService } from '../../src/services/retrieval-service';
import { ActionLogService } from '../../src/services/action-log-service';
import { BackupService } from '../../src/services/backup-service';
import { AnalyticsService } from '../../src/services/analytics-service';
import { ScanEngine } from '../../src/modules/health/scan-engine';
import { FixActions } from '../../src/modules/health/fix-actions';
import { FIXTURE_NOW } from './vault-fixture';

/** In-memory stand-in for the plugin's `loadData`/`saveData`. */
export class MemorySettingsHost {
	constructor(private data: unknown = null) {}

	async loadData(): Promise<unknown> {
		return this.data;
	}

	async saveData(data: unknown): Promise<void> {
		this.data = JSON.parse(JSON.stringify(data));
	}

	/** Test helper: what is currently persisted. */
	peek(): unknown {
		return this.data;
	}
}

export interface Harness {
	app: App;
	obsidianApp: ObsidianApp;
	bus: EventBus;
	logger: Logger;
	settings: SettingsStore;
	host: MemorySettingsHost;
	index: VaultIndex;
	content: ContentIndex;
	metadata: MetadataService;
	links: LinkService;
	tags: TagService;
	attachments: AttachmentService;
	capture: CaptureService;
	inbox: InboxService;
	health: HealthService;
	retrieval: RetrievalService;
	actionLog: ActionLogService;
	backup: BackupService;
	analytics: AnalyticsService;
	engine: ScanEngine;
	fixes: FixActions;
	safety: SafetyGate;
	now: () => number;
}

export interface HarnessOptions {
	/** Applied on top of the defaults before anything is constructed. */
	settings?: (settings: JemzSettings) => void;
	/** Reference instant. Defaults to the fixture's implicit "today". */
	now?: number;
}

/** Construct the full service graph for a vault. */
export async function createHarness(app: App, options: HarnessOptions = {}): Promise<Harness> {
	const obsidianApp = app as unknown as ObsidianApp;
	const bus = new EventBus();
	const logger = new Logger('silent');
	const host = new MemorySettingsHost();

	// Seed persisted settings so the store loads them exactly as it would on disk.
	if (options.settings) {
		const seeded = structuredCloneSafe(DEFAULT_SETTINGS);
		options.settings(seeded);
		await host.saveData(seeded);
	}

	const settings = new SettingsStore(host, bus, logger, 0);
	await settings.load();

	const nowValue = options.now ?? FIXTURE_NOW;
	const now = (): number => nowValue;
	const getSettings = (): JemzSettings => settings.get();

	const index = new VaultIndex(obsidianApp, logger);
	index.build();
	const content = new ContentIndex(obsidianApp, index, logger);

	const metadata = new MetadataService(obsidianApp, logger);
	const links = new LinkService(obsidianApp, logger);
	const tags = new TagService(obsidianApp, index, logger);
	const attachments = new AttachmentService(obsidianApp, index, logger);
	const capture = new CaptureService(obsidianApp, getSettings, logger, now);
	const inbox = new InboxService(obsidianApp, index, metadata, getSettings, logger);

	const actionLog = new ActionLogService(settings, bus, logger, now);
	const backup = new BackupService(obsidianApp, settings, logger);
	const analytics = new AnalyticsService(settings, logger);

	const engine = new ScanEngine({
		app: obsidianApp,
		index,
		content,
		getSettings,
		logger,
		bus,
		now,
	});
	const health = new HealthService({ engine, settings, bus, logger, now });
	const retrieval = new RetrievalService({
		app: obsidianApp,
		index,
		content,
		settings,
		logger,
		now,
	});

	const safety = new SafetyGate({
		getMtime: (path) => app.vault.getFileByPath(path)?.stat.mtime ?? null,
		isWritable: () => !app.vault.readOnly,
		createBackup: (files, label) => backup.create(files, label),
		logger,
	});
	const fixes = new FixActions({
		app: obsidianApp,
		index,
		link: links,
		metadata,
		tag: tags,
		getSettings,
		logger,
	});

	return {
		app,
		obsidianApp,
		bus,
		logger,
		settings,
		host,
		index,
		content,
		metadata,
		links,
		tags,
		attachments,
		capture,
		inbox,
		health,
		retrieval,
		actionLog,
		backup,
		analytics,
		engine,
		fixes,
		safety,
		now,
	};
}

/**
 * Re-derive the index the way the plugin does after a batch of vault mutations.
 *
 * The real plugin reacts to Obsidian's `resolved` event; tests call this instead of
 * simulating the whole event storm.
 */
export function reindex(harness: Harness): void {
	harness.app.metadataCache.refresh();
	harness.index.build();
	harness.content.clear();
}

/**
 * Register the vault listeners `main.ts` installs.
 *
 * Without these the index never learns about a write, so a view that correctly re-renders
 * after an action still reads stale records. Any test that mutates the vault through the UI
 * needs this, otherwise it is testing a plugin that is missing half its wiring.
 *
 * @returns A teardown function that removes the listeners again.
 */
export function wireVaultEvents(harness: Harness): () => void {
	const { app, index, content, bus, inbox } = harness;

	const announce = (): void => {
		bus.emit('index-updated', { changed: [] });
		bus.emit('inbox-changed', { count: inbox.count() });
	};

	const onCreate = (file: unknown): void => {
		const typed = file as { path: string; stat?: unknown };
		const resolved = app.vault.getFileByPath(typed.path);
		if (!resolved) return;
		index.updateFile(resolved as unknown as Parameters<typeof index.updateFile>[0]);
		content.invalidate(typed.path);
		announce();
	};

	const onModify = onCreate;

	const onDelete = (file: unknown): void => {
		const typed = file as { path: string };
		index.removeFile(typed.path);
		content.invalidate(typed.path);
		announce();
	};

	const onRename = (file: unknown, oldPath: string): void => {
		const typed = file as { path: string };
		const resolved = app.vault.getFileByPath(typed.path);
		if (resolved) {
			index.renameFile(
				resolved as unknown as Parameters<typeof index.renameFile>[0],
				oldPath,
			);
		}
		content.invalidate(oldPath);
		content.invalidate(typed.path);
		announce();
	};

	const refs = [
		app.vault.on('create', onCreate as never),
		app.vault.on('modify', onModify as never),
		app.vault.on('delete', onDelete as never),
		app.vault.on('rename', onRename as never),
	];

	return () => {
		for (const ref of refs) app.vault.offref(ref);
	};
}
