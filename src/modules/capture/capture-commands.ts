/**
 * Entry points for Quick Capture (main spec 5.1).
 *
 * The command, the ribbon icon and the status bar all have to open exactly the same modal with
 * exactly the same dependencies, so they share {@link openQuickCapture} rather than each
 * constructing the modal themselves — one place to change when the modal's shape changes, and
 * no chance of one entry point drifting out of step with another.
 */

import { QuickCaptureModal, type QuickCaptureDeps } from './quick-capture-modal';

/** Dependencies every capture entry point needs. Identical to the modal's. */
export type CaptureCommandDeps = QuickCaptureDeps;

/**
 * Open the Quick Capture modal.
 *
 * Shared by the command, the ribbon icon and the status bar. Module gating happens at the
 * entry points themselves — the command checks the live setting when it runs, the ribbon icon
 * when it is created — so this helper always does what its name says.
 *
 * @returns The opened modal, so a caller can await its side effects in a test.
 */
export function openQuickCapture(deps: CaptureCommandDeps): QuickCaptureModal {
	const modal = new QuickCaptureModal(deps);
	modal.open();
	return modal;
}
