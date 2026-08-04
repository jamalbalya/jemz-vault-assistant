/** Payloads carried by the internal event bus. */

import type { FixResult, HealthReport, ScanProgress } from './health';
import type { ActionLogEntry, JemzSettings } from './settings';

/** Which dashboard tab is active. */
export type DashboardTab = 'inbox' | 'health' | 'find';

export interface JemzEventMap {
	'settings-changed': { settings: JemzSettings };
	/** Emitted after the vault index absorbs a batch of file changes. */
	'index-updated': { changed: readonly string[] };
	'inbox-changed': { count: number };
	'scan-started': { total: number; kind: string };
	'scan-progress': ScanProgress;
	'scan-completed': { report: HealthReport };
	'scan-failed': { error: string };
	'fix-applied': { result: FixResult };
	'action-logged': { entry: ActionLogEntry };
	'tab-changed': { tab: DashboardTab };
}

export type JemzEventName = keyof JemzEventMap;

export type JemzEventHandler<K extends JemzEventName> = (payload: JemzEventMap[K]) => void;
