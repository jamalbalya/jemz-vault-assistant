/**
 * Frontmatter health: missing required properties, and blocks that failed to parse.
 *
 * One detector emits two issue types because they are decided by the same look at a note's
 * frontmatter, and because they are mutually exclusive: a note whose YAML is broken reports as
 * `corrupted-frontmatter` only. Obsidian discards a malformed block entirely, so such a note
 * *looks* like it is missing every required property — telling the user to "add properties"
 * would be wrong advice, and applying that fix would append keys below the broken fence.
 *
 * `hasFrontmatterBlock` is only known once a file has been read (the metadata cache cannot
 * report a block it failed to parse), which is why this detector asks for content.
 */

import type {
	Detector,
	DetectorContext,
	HealthIssue,
	MissingMetadataIssueData,
} from '../../../types/health';
import type { NoteRecord } from '../../../types/note';
import { STRINGS } from '../../../core/strings';
import { createIssue } from '../issue';

/**
 * Whether a required property is effectively absent.
 *
 * An empty string or an empty list counts as missing: `type:` with nothing after it is a
 * placeholder the user still has to fill in, not a value.
 */
function isMissing(frontmatter: Record<string, unknown> | null, field: string): boolean {
	if (frontmatter === null) return true;
	const value = frontmatter[field];
	if (value === undefined || value === null) return true;
	if (typeof value === 'string') return value.trim().length === 0;
	if (Array.isArray(value)) return value.length === 0;
	return false;
}

/** The `corrupted-frontmatter` issue for a note whose YAML did not parse. */
function corruptedIssue(record: NoteRecord): HealthIssue {
	return createIssue({
		type: 'corrupted-frontmatter',
		path: record.path,
		title: record.basename,
		detail: STRINGS.health.typeDescriptions['corrupted-frontmatter'],
		severity: 'medium',
		data: { kind: 'generic' },
		idParts: [record.path],
	});
}

/** The `missing-metadata` issue listing the properties a note lacks. */
function missingIssue(record: NoteRecord, missing: readonly string[]): HealthIssue {
	const data: MissingMetadataIssueData = { kind: 'missing-metadata', missing };
	return createIssue({
		type: 'missing-metadata',
		path: record.path,
		title: record.basename,
		detail: `${STRINGS.health.typeDescriptions['missing-metadata']} ${missing.join(', ')}`,
		severity: 'low',
		data,
		// Sorted so reordering the required-fields setting does not mint a new id.
		idParts: [record.path, ...[...missing].sort()],
	});
}

/**
 * Reports notes missing required frontmatter properties, and notes whose frontmatter block
 * could not be parsed.
 *
 * The two halves are switched independently through `settings.detectors`, since a user who
 * does not use required properties may still want to hear about broken YAML.
 */
const missingMetadataDetector: Detector = {
	type: 'missing-metadata',
	label: STRINGS.health.types['missing-metadata'],
	// Declaring both categories is what lets the scan engine run this detector when only
	// `corrupted-frontmatter` is enabled; filtering on `type` alone would skip it entirely.
	emits: ['missing-metadata', 'corrupted-frontmatter'],
	needsContent: true,

	run(context: DetectorContext): HealthIssue[] {
		const reportCorrupted = context.settings.detectors['corrupted-frontmatter'];
		const reportMissing = context.settings.detectors['missing-metadata'];
		// Blank entries are dropped and repeats collapse: a key the user listed twice (or as
		// `type` and ` type `) must not be reported twice, and must not change the issue id —
		// both would follow straight from a stray duplicate in a hand-edited settings list.
		const required: string[] = [];
		const seenFields = new Set<string>();
		for (const field of context.settings.requiredFrontmatterFields) {
			const trimmed = field.trim();
			if (trimmed.length === 0 || seenFields.has(trimmed)) continue;
			seenFields.add(trimmed);
			required.push(trimmed);
		}

		const issues: HealthIssue[] = [];
		for (const record of context.notes) {
			if (record.isAttachment) continue;

			if (record.hasFrontmatterBlock && !record.frontmatterValid) {
				if (reportCorrupted) issues.push(corruptedIssue(record));
				// Never also reported as missing metadata: the fix is repairing the YAML.
				continue;
			}

			if (!reportMissing || required.length === 0) continue;
			const missing = required.filter((field) => isMissing(record.frontmatter, field));
			if (missing.length > 0) issues.push(missingIssue(record, missing));
		}

		return issues;
	},
};

export default missingMetadataDetector;
