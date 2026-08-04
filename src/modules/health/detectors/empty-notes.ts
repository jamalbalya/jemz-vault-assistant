/**
 * Empty note detector.
 *
 * The fix offered for an empty note is deletion, so this detector is deliberately the most
 * conservative one in the module: a file whose content could not be read reports `null`
 * stats and is skipped entirely. Treating "unreadable" as "empty" would let a transient I/O
 * failure queue a real note for the trash.
 *
 * Two independent thresholds catch two different shapes of the same problem: a note that is
 * all frontmatter and no prose (`contentLength`) and a file that is genuinely tiny on disk
 * (`size`).
 */

import type {
	Detector,
	DetectorContext,
	EmptyNoteIssueData,
	HealthIssue,
} from '../../../types/health';
import { STRINGS } from '../../../core/strings';
import { formatBytes } from '../../../utils/string';
import { createIssue } from '../issue';

/**
 * Finds notes with little or no body text.
 *
 * Needs content, so the scan engine loads bodies through the content index before running
 * it; `context.getStats` then answers from cache without any I/O of its own.
 */
const emptyNotesDetector: Detector = {
	type: 'empty-note',
	label: STRINGS.health.types['empty-note'],
	needsContent: true,

	run(context: DetectorContext): HealthIssue[] {
		const issues: HealthIssue[] = [];
		const { emptyNoteCharThreshold, emptyNoteByteThreshold } = context.settings;

		for (const record of context.notes) {
			if (record.isAttachment) continue;

			const stats = context.getStats(record.path);
			// Unreadable or not loaded: never offer to delete a file we could not inspect.
			if (stats === null) continue;

			// Both comparisons are strict: the spec reads "content under 20 characters or file
			// size under 50 bytes", so a note sitting exactly on either threshold is content.
			const tooFewCharacters = stats.contentLength < emptyNoteCharThreshold;
			const tooFewBytes = stats.size < emptyNoteByteThreshold;
			if (!tooFewCharacters && !tooFewBytes) continue;

			const data: EmptyNoteIssueData = {
				kind: 'empty-note',
				contentLength: stats.contentLength,
				size: stats.size,
			};

			issues.push(
				createIssue({
					type: 'empty-note',
					path: record.path,
					title: record.basename,
					detail: `${STRINGS.health.typeDescriptions['empty-note']} ${formatBytes(stats.size)}`,
					severity: 'medium',
					data,
					idParts: [record.path],
				}),
			);
		}

		return issues;
	},
};

export default emptyNotesDetector;
