/**
 * Entry points for Quick Capture (main spec 5.1).
 *
 * The command, the ribbon icon and the status bar all have to open exactly the same modal with
 * exactly the same dependencies, so they share {@link openQuickCapture} rather than each
 * constructing the modal themselves — one place to change when the modal's shape changes, and
 * no chance of one entry point drifting out of step with another.
 */

import type { Plugin } from 'obsidian';
import { COMMAND_IDS, ICONS } from '../../core/constants';
import { STRINGS } from '../../core/strings';
import { QuickCaptureModal, type QuickCaptureDeps } from './quick-capture-modal';

/** Dependencies every capture entry point needs. Identical to the modal's. */
export type CaptureCommandDeps = QuickCaptureDeps;

/**
 * Open the Quick Capture modal.
 *
 * Shared by the command, the ribbon icon and the status bar. Module gating happens where the
 * entry point is created ({@link registerCaptureCommands} for the command, the plugin's ribbon
 * setup for the icon), so this helper always does what its name says.
 *
 * @returns The opened modal, so a caller can await its side effects in a test.
 */
export function openQuickCapture(deps: CaptureCommandDeps): QuickCaptureModal {
	const modal = new QuickCaptureModal(deps);
	modal.open();
	return modal;
}

/**
 * Register the capture module's commands on the plugin.
 *
 * Nothing is registered while the module is off, so a disabled module leaves no trace in the
 * command palette or the hotkeys list — a hidden command that silently does nothing would be
 * worse than an absent one. The plugin re-runs registration after a settings change, which is
 * why the check reads live settings instead of a captured boolean.
 *
 * @returns Whether the commands were registered.
 */
export function registerCaptureCommands(plugin: Plugin, deps: CaptureCommandDeps): boolean {
	if (!deps.getSettings().general.modules.capture) {
		deps.logger.debug('Capture module is off; quick capture command not registered.');
		return false;
	}

	plugin.addCommand({
		id: COMMAND_IDS.quickCapture,
		name: STRINGS.commands.quickCapture,
		icon: ICONS.capture,
		callback: (): void => {
			openQuickCapture(deps);
		},
	});
	return true;
}
