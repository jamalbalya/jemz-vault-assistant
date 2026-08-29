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
import type { NoteRecord } from '../../../types/note';
import { STRINGS } from '../../../core/strings';
import { createIssue } from '../issue';

/**
 * Whether a note is disconnected in both directions.
 *
 * Exported because the Find tab's Orphans view has to answer exactly the same question over
 * a different set of records, and two copies of this rule drift: the first thing they stop
 * agreeing on is the self-link, which reads as "has a link" to a naive length check and as
 * "no edge" to this one. A user seeing one count in Health and another in Find has no way to
 * tell which tab is lying.
 *
 * @param backlinksOf Sources linking to a path. Injected so a detector context and the vault
 *   index can both supply it.
 */
export function isOrphanNote(
	record: NoteRecord,
	backlinksOf: (path: string) => readonly string[],
): boolean {
	if (record.isAttachment) return false;
	// An unresolved link still points outward, so only a link that resolves back to this very
	// file is discounted.
	if (record.links.some((link) => link.resolvedPath !== record.path)) return false;
	return !backlinksOf(record.path).some((source) => source !== record.path);
}

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
			// Wrapped rather than passed by reference: `backlinksOf` is a method on the
			// context, and handing it over bare would detach it from its receiver.
			if (!isOrphanNote(record, (path) => context.backlinksOf(path))) continue;

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
