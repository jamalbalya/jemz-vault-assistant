/**
 * Broken link detector.
 *
 * Reports one issue per unresolved link *occurrence* rather than per file or per distinct
 * target, because every fix action (create the note, repoint the link, remove the link)
 * rewrites one specific span of text. Collapsing duplicates would leave the second copy of
 * `[[Ghost Note]]` silently untouched after a fix runs.
 *
 * Wikilinks and embeds are covered by the same pass: the index folds both into
 * `record.links`, flagging embeds with `isEmbed`, so a missing image is reported exactly
 * like a missing note.
 */

import type {
	BrokenLinkIssueData,
	Detector,
	DetectorContext,
	HealthIssue,
} from '../../../types/health';
import { STRINGS } from '../../../core/strings';
import { createIssue } from '../issue';

/**
 * Human readable description of one broken link.
 *
 * Kept as a local formatter because the string table only carries the category-level copy
 * (`STRINGS.health.typeDescriptions['broken-link']`), which cannot name the target.
 */
function describeBrokenLink(target: string): string {
	return `Links to "${target}", which does not exist`;
}

/**
 * Finds links whose target resolves to nothing.
 *
 * Pure and synchronous: everything needed already lives on {@link DetectorContext}, so the
 * scan engine can run this over a chunk of records without touching the vault.
 */
const brokenLinksDetector: Detector = {
	type: 'broken-link',
	label: STRINGS.health.types['broken-link'],

	run(context: DetectorContext): HealthIssue[] {
		const issues: HealthIssue[] = [];

		for (const record of context.notes) {
			// Occurrence counter per target. The ordinal — not the line number — is what keeps
			// an id stable while the user edits the surrounding text, and unique when the same
			// dead target appears twice in one file.
			const seenTargets = new Map<string, number>();

			for (const link of record.links) {
				if (link.resolvedPath !== null) continue;

				const ordinal = seenTargets.get(link.target) ?? 0;
				seenTargets.set(link.target, ordinal + 1);

				const data: BrokenLinkIssueData = {
					kind: 'broken-link',
					target: link.target,
					raw: link.raw,
					line: link.line,
					col: link.col,
					isEmbed: link.isEmbed,
					isMarkdownLink: link.isMarkdownLink,
				};

				issues.push(
					createIssue({
						type: 'broken-link',
						path: record.path,
						title: record.basename,
						detail: describeBrokenLink(link.target),
						severity: 'high',
						data,
						idParts: [record.path, link.target, String(ordinal)],
					}),
				);
			}
		}

		return issues;
	},
};

export default brokenLinksDetector;
