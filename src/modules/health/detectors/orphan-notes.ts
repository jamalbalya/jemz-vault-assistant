/**
 * Orphan note detector.
 *
 * A note counts as an orphan only when it is disconnected in *both* directions: nothing
 * links to it and it links to nothing. A note that points outward is still part of the
 * graph even if its targets are broken, which is why unresolved links count as outgoing —
 * reporting it here would duplicate what the broken-link detector already says, and the
 * suggested remedy (link it up) would be wrong.
 *
 * A link a note makes to itself is not an edge in either direction. The index already
 * refuses to record a self-link as a backlink, so counting it as an outgoing link would
 * make a note whose only link is `[[itself]]` permanently invisible here despite being
 * exactly as disconnected as a note with no links at all.
 *
 * Attachments are never reported: an unreferenced image is an unused attachment, a
 * different issue with a different fix.
 */

import type { Detector, DetectorContext, HealthIssue } from '../../../types/health';
import { STRINGS } from '../../../core/strings';
import { createIssue } from '../issue';

/**
 * Finds notes with no links in and no links out.
 *
 * Pure and synchronous — backlinks come from {@link DetectorContext.backlinksOf} so tests
 * can drive the check without an index.
 */
const orphanNotesDetector: Detector = {
	type: 'orphan-note',
	label: STRINGS.health.types['orphan-note'],

	run(context: DetectorContext): HealthIssue[] {
		const issues: HealthIssue[] = [];

		for (const record of context.notes) {
			if (record.isAttachment) continue;
			// An unresolved link still points outward, so only a link that resolves back to
			// this very file is discounted.
			const linksOut = record.links.some((link) => link.resolvedPath !== record.path);
			if (linksOut) continue;
			const linksIn = context
				.backlinksOf(record.path)
				.some((source) => source !== record.path);
			if (linksIn) continue;

			issues.push(
				createIssue({
					type: 'orphan-note',
					path: record.path,
					title: record.basename,
					detail: STRINGS.health.typeDescriptions['orphan-note'],
					severity: 'low',
					data: { kind: 'generic' },
					idParts: [record.path],
				}),
			);
		}

		return issues;
	},
};

export default orphanNotesDetector;
