/**
 * Unused attachment detector.
 *
 * The set of referenced files is built from `context.allFiles`, not from `context.notes`,
 * on purpose: exclusions (inbox, archive, excluded folders) shrink what gets *reported*,
 * never what counts as a reference. An image embedded only by an archived note is still in
 * use, and offering to delete it because the referrer was filtered out of scope would
 * destroy data the user can still see in their vault.
 *
 * Markdown notes are skipped even when one is handed in `context.attachments`: the fix
 * offered here is deletion, and a caller that forgot to split the scope must not be able
 * to queue a note for the trash.
 */

import type { Detector, DetectorContext, HealthIssue } from '../../../types/health';
import { STRINGS } from '../../../core/strings';
import { getFileName } from '../../../utils/file';
import { formatBytes } from '../../../utils/string';
import { createIssue } from '../issue';

/**
 * Finds attachments no file in the vault links to or embeds.
 *
 * Pure and synchronous; the reference set is rebuilt per run so an incremental rescan never
 * reports against stale link data.
 */
const unusedAttachmentsDetector: Detector = {
	type: 'unused-attachment',
	label: STRINGS.health.types['unused-attachment'],

	run(context: DetectorContext): HealthIssue[] {
		const referenced = new Set<string>();
		for (const record of context.allFiles) {
			for (const link of record.links) {
				if (link.resolvedPath !== null) referenced.add(link.resolvedPath);
			}
		}

		const issues: HealthIssue[] = [];
		for (const attachment of context.attachments) {
			if (!attachment.isAttachment) continue;
			if (referenced.has(attachment.path)) continue;

			issues.push(
				createIssue({
					type: 'unused-attachment',
					path: attachment.path,
					// Attachments are told apart by their extension — `diagram.png` and
					// `diagram.pdf` would otherwise be two identical rows in the issue list.
					title: getFileName(attachment.path),
					detail: `${STRINGS.health.typeDescriptions['unused-attachment']} ${formatBytes(attachment.size)}`,
					severity: 'low',
					data: { kind: 'generic' },
					idParts: [attachment.path],
				}),
			);
		}

		return issues;
	},
};

export default unusedAttachmentsDetector;
