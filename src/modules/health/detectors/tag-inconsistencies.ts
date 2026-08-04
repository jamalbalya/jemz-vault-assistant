/**
 * Tag inconsistency detection.
 *
 * `#projek` next to `#project` splits a topic in two without the user ever noticing, because
 * both look right in the tag pane. The detector counts how many notes carry each tag and hands
 * the counts to {@link groupSimilarTags}, which owns the edit-distance policy (short tags get a
 * tighter budget than long ones, so `#dev` and `#ops` are never merged).
 *
 * Counting notes rather than occurrences is deliberate: the count is used to pick the canonical
 * spelling, and "how many notes would be retagged" is the number that matters for the fix.
 */

import type {
	Detector,
	DetectorContext,
	HealthIssue,
	TagInconsistencyIssueData,
} from '../../../types/health';
import { STRINGS } from '../../../core/strings';
import { groupSimilarTags } from '../../../services/tag-service';
import { createIssue, stableGroupKey } from '../issue';

/**
 * Reports groups of tags that look like spellings of the same thing.
 *
 * Tags come straight from the index, so no file contents are needed.
 */
const tagInconsistenciesDetector: Detector = {
	type: 'tag-inconsistency',
	label: STRINGS.health.types['tag-inconsistency'],

	run(context: DetectorContext): HealthIssue[] {
		const counts = new Map<string, number>();
		const pathsByTag = new Map<string, string[]>();

		for (const record of context.notes) {
			if (record.isAttachment) continue;
			// A tag repeated inside one note must still count that note once.
			for (const tag of new Set(record.tags)) {
				if (tag.length === 0) continue;
				counts.set(tag, (counts.get(tag) ?? 0) + 1);
				const paths = pathsByTag.get(tag);
				if (paths) paths.push(record.path);
				else pathsByTag.set(tag, [record.path]);
			}
		}

		const groups = groupSimilarTags(counts, {
			shortLengthCutoff: context.settings.tagShortLengthCutoff,
			shortMaxDistance: context.settings.tagShortMaxDistance,
			longMaxDistance: context.settings.tagLongMaxDistance,
			minSharedPrefix: context.settings.tagMinSharedPrefix,
		});

		const issues: HealthIssue[] = [];
		for (const group of groups) {
			const affected = new Set<string>();
			for (const variant of group.variants) {
				for (const path of pathsByTag.get(variant.tag) ?? []) affected.add(path);
			}
			const paths = Array.from(affected).sort();
			const variants = group.variants.map((variant) => ({
				tag: variant.tag,
				count: variant.count,
			}));
			const data: TagInconsistencyIssueData = {
				kind: 'tag-inconsistency',
				variants,
				canonical: group.canonical,
				paths,
			};

			issues.push(
				createIssue({
					type: 'tag-inconsistency',
					// The alphabetically first carrier is a stable stand-in for "where to look".
					path: paths[0] ?? '',
					title: `#${group.canonical}`,
					detail: `${STRINGS.health.typeDescriptions['tag-inconsistency']} ${variants
						.map((variant) => `#${variant.tag} (${variant.count})`)
						.join(', ')}`,
					severity: 'low',
					data,
					// The id is the set of variants and nothing else. Paths and counts both
					// drift as notes are edited, and the canonical spelling flips as soon as a
					// variant overtakes it — none of which should resurrect an ignored group.
					idParts: [stableGroupKey(variants.map((variant) => variant.tag))],
				}),
			);
		}

		return issues;
	},
};

export default tagInconsistenciesDetector;
