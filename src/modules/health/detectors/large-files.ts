/**
 * Large file detection.
 *
 * Oversized files are what make a vault slow to sync and slow to open, and they are usually
 * accidents — a pasted screenshot at full resolution, an exported PDF, a note that grew a huge
 * embedded table. Notes *and* attachments are checked, since the offender is far more often an
 * attachment than a note.
 *
 * Nothing here is a defect on its own, so the issue is informational: severity is low and the
 * reported size comes straight from the file stat, never from reading the file.
 */

import type {
	Detector,
	DetectorContext,
	HealthIssue,
	LargeFileIssueData,
} from '../../../types/health';
import { STRINGS } from '../../../core/strings';
import { getFileName } from '../../../utils/file';
import { formatBytes } from '../../../utils/string';
import { createIssue } from '../issue';

/**
 * Reports every file above `settings.largeFileThresholdBytes`.
 *
 * Sizes come from the index, so the detector stays synchronous and needs no content.
 */
const largeFilesDetector: Detector = {
	type: 'large-file',
	label: STRINGS.health.types['large-file'],

	run(context: DetectorContext): HealthIssue[] {
		const threshold = context.settings.largeFileThresholdBytes;
		const issues: HealthIssue[] = [];
		const reported = new Set<string>();

		for (const record of [...context.notes, ...context.attachments]) {
			if (!(record.size > threshold)) continue;
			// This is the one detector that walks two of the context's lists, and nothing in the
			// contract promises they are disjoint — `allFiles` deliberately overlaps both. A file
			// reached twice would mint two issues carrying the *same* id, which double counts it
			// in the health score and makes one ignore click look like it did nothing.
			if (reported.has(record.path)) continue;
			reported.add(record.path);
			const data: LargeFileIssueData = {
				kind: 'large-file',
				size: record.size,
				threshold,
			};
			issues.push(
				createIssue({
					type: 'large-file',
					path: record.path,
					// Attachments are recognised by their extension, so show the full file name.
					title: getFileName(record.path),
					detail: `${STRINGS.health.typeDescriptions['large-file']} ${formatBytes(record.size)}`,
					severity: 'low',
					data,
					// The size is left out of the id so a file that keeps growing stays the same
					// issue, and stays ignored if the user ignored it.
					idParts: [record.path],
				}),
			);
		}

		return issues;
	},
};

export default largeFilesDetector;
