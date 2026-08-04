/**
 * Optional, entirely one-way integration with the sibling "jemzsync" plugin (addendum
 * appendix E).
 *
 * The two plugins are independent products: there is no import from jemzsync, no shared
 * storage, no hard dependency, and nothing here changes behaviour when it is absent. All
 * this does is notice whether it is installed so the dashboard can show a sync chip.
 *
 * Detection reads Obsidian's plugin registry, which is not part of the public API. Every
 * property access is therefore guarded and the whole thing is wrapped in a try/catch: if the
 * shape ever changes, this returns null and the plugin carries on exactly as if jemzsync
 * were not installed.
 */

import { setIcon } from 'obsidian';
import type { App } from 'obsidian';
import { JEMZSYNC_PLUGIN_ID } from '../core/constants';

/** What we are willing to learn about the sibling plugin. */
export interface JemzsyncInfo {
	readonly id: string;
	readonly version: string;
	readonly enabled: boolean;
}

/** The private shape we probe for, expressed so every hop can be checked. */
interface PluginRegistryLike {
	plugins?: {
		plugins?: Record<string, { manifest?: { id?: unknown; version?: unknown } } | undefined>;
		enabledPlugins?: Set<string>;
	};
}

function readString(value: unknown, fallback: string): string {
	return typeof value === 'string' && value.length > 0 ? value : fallback;
}

/**
 * Detect the sibling plugin.
 *
 * @returns Its id, version, and enabled state, or null when it is not installed, not
 *   enabled, or the registry is not in the shape we expect.
 */
export function detectJemzsync(app: App): JemzsyncInfo | null {
	try {
		// Deliberate cast to a non-public surface — the only one in the codebase. It is
		// confined to this function, and every field it touches is validated below.
		const registry = app as unknown as PluginRegistryLike;
		const plugins = registry.plugins?.plugins;
		if (!plugins || typeof plugins !== 'object') return null;

		const entry = plugins[JEMZSYNC_PLUGIN_ID];
		if (!entry || typeof entry !== 'object') return null;

		const enabledSet = registry.plugins?.enabledPlugins;
		const enabled = enabledSet instanceof Set ? enabledSet.has(JEMZSYNC_PLUGIN_ID) : true;

		return {
			id: readString(entry.manifest?.id, JEMZSYNC_PLUGIN_ID),
			version: readString(entry.manifest?.version, 'unknown'),
			enabled,
		};
	} catch {
		// Any surprise at all means "not available", never an error the user has to see.
		return null;
	}
}

/**
 * Render a small status chip for the sibling plugin.
 *
 * Renders nothing at all when `info` is null, which is the normal case for anyone who does
 * not use jemzsync.
 */
export function renderSyncStatus(parent: HTMLElement, info: JemzsyncInfo | null): void {
	if (!info) return;

	const chip = parent.createSpan({ cls: 'jva-sync-chip' });
	chip.toggleClass('is-enabled', info.enabled);
	const iconEl = chip.createSpan({ cls: 'jva-sync-chip__icon' });
	setIcon(iconEl, info.enabled ? 'refresh-cw' : 'pause');
	chip.createSpan({
		cls: 'jva-sync-chip__label',
		text: info.enabled ? 'jemzsync active' : 'jemzsync paused',
	});
	chip.setAttr('aria-label', `jemzsync ${info.version}`);
	chip.setAttr('title', `jemzsync ${info.version}`);
}
