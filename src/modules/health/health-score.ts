/**
 * Health score (main spec 6.2, extended by addendum E-06).
 *
 * Start at 100 and subtract a weighted penalty per issue category, each capped so that one
 * noisy category cannot sink the whole score. Every weight is user configurable, so the
 * calculation reads its numbers from settings rather than hard-coding them.
 */

import type { HealthIssue, HealthScore, IssueType, ScorePenalty } from '../../types/health';
import { ISSUE_TYPES } from '../../types/health';
import type { ScoreWeight } from '../../types/settings';

/** Count issues per category, including categories with no issues. */
export function countByType(issues: readonly HealthIssue[]): Record<IssueType, number> {
	const counts = {} as Record<IssueType, number>;
	for (const type of ISSUE_TYPES) counts[type] = 0;
	for (const issue of issues) counts[issue.type] = (counts[issue.type] ?? 0) + 1;
	return counts;
}

/**
 * Turn issue counts into a score.
 *
 * @param counts How many issues exist per category. Group issues (duplicate titles, tag
 *   variants) count once per group, not once per file, so a single tag typo spread across
 *   twenty notes is one penalty.
 * @param weights Per-category points and caps.
 * @returns The score plus the per-category breakdown shown in the UI.
 */
export function calculateHealthScore(
	counts: Readonly<Record<IssueType, number>>,
	weights: Readonly<Record<IssueType, ScoreWeight>>,
): HealthScore {
	const penalties: ScorePenalty[] = [];
	let totalPenalty = 0;

	for (const type of ISSUE_TYPES) {
		const count = counts[type] ?? 0;
		const weight = weights[type] ?? { per: 0, max: 0 };
		const uncapped = count * weight.per;
		const penalty = Math.min(uncapped, weight.max);
		totalPenalty += penalty;
		penalties.push({
			type,
			count,
			perUnit: weight.per,
			max: weight.max,
			penalty: round(penalty),
		});
	}

	const value = Math.max(0, Math.min(100, 100 - totalPenalty));
	return {
		value: round(value),
		penalties,
		totalPenalty: round(totalPenalty),
	};
}

/** One decimal place, avoiding floating point noise like 91.79999999999998. */
function round(value: number): number {
	return Math.round(value * 10) / 10;
}

/** Qualitative band for a score, used to pick the indicator colour and label. */
export function scoreBand(value: number): 'excellent' | 'good' | 'fair' | 'poor' {
	if (value >= 90) return 'excellent';
	if (value >= 75) return 'good';
	if (value >= 50) return 'fair';
	return 'poor';
}
