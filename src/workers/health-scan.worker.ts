/**
 * Off-thread similarity computation for the health scan.
 *
 * Two detectors compare every pair in a set — duplicate titles and tag inconsistencies —
 * which is the only genuinely CPU-bound part of a scan. On a 10 000 note vault that work is
 * worth moving off the main thread so the UI keeps painting.
 *
 * Design notes:
 *  - The main-thread implementation is ordinary TypeScript. Nothing here calls `eval` or
 *    `new Function`, both of which read as remote-code execution to Obsidian's plugin
 *    review even when the input is a bundled constant.
 *  - The worker body is a separate ES5 transcription of the same algorithm, embedded as a
 *    string constant so the Blob worker is self-contained. `similarity-kernel-parity.test`
 *    fuzzes both implementations against each other, so the transcription cannot drift.
 *  - A missing or failing worker is a normal outcome, never an error: the runner falls back
 *    to the main thread and the scan completes either way.
 */

/** A pair of items considered near-identical. */
export interface SimilarPair {
	readonly a: string;
	readonly b: string;
	readonly similarity: number;
}

/** Request sent to the kernel. */
export interface SimilarityRequest {
	/** Candidate strings, already normalised by the caller. */
	readonly items: readonly string[];
	/** Report a pair when similarity is strictly greater than this. */
	readonly threshold: number;
	/** Ignore items shorter than this. Zero disables the floor. */
	readonly minLength: number;
}

/** Result returned by the kernel. */
export interface SimilarityResponse {
	readonly pairs: readonly SimilarPair[];
}

/**
 * Bounded edit distance.
 *
 * Returns `cutoff + 1` as soon as the distance provably exceeds the cutoff, which is what
 * makes the pairwise scan affordable on large vaults.
 */
function boundedDistance(a: string, b: string, cutoff: number): number {
	if (a === b) return 0;
	if (a.length === 0) return b.length;
	if (b.length === 0) return a.length;
	if (Math.abs(a.length - b.length) > cutoff) return cutoff + 1;

	let source = a;
	let target = b;
	if (source.length > target.length) {
		const swap = source;
		source = target;
		target = swap;
	}

	const width = source.length + 1;
	let previous = new Array<number>(width);
	let current = new Array<number>(width);
	for (let i = 0; i < width; i++) previous[i] = i;

	for (let j = 1; j <= target.length; j++) {
		current[0] = j;
		let rowMinimum = j;
		const targetChar = target.charCodeAt(j - 1);
		for (let k = 1; k < width; k++) {
			const cost = source.charCodeAt(k - 1) === targetChar ? 0 : 1;
			const value = Math.min(
				(previous[k] ?? 0) + 1,
				(current[k - 1] ?? 0) + 1,
				(previous[k - 1] ?? 0) + cost,
			);
			current[k] = value;
			if (value < rowMinimum) rowMinimum = value;
		}
		if (rowMinimum > cutoff) return cutoff + 1;
		const swap = previous;
		previous = current;
		current = swap;
	}
	return previous[width - 1] ?? 0;
}

/**
 * Find every pair of items whose similarity exceeds the threshold.
 *
 * Candidates are sorted by length so the inner loop can stop as soon as the length gap
 * alone exceeds the allowed edit distance — without that window the scan is quadratic in
 * the number of notes.
 */
export function findSimilarPairs(request: SimilarityRequest): SimilarityResponse {
	const seen = new Set<string>();
	const candidates: string[] = [];
	for (const item of request.items) {
		if (item.length < request.minLength) continue;
		if (seen.has(item)) continue;
		seen.add(item);
		candidates.push(item);
	}
	candidates.sort((x, y) => x.length - y.length || (x < y ? -1 : x > y ? 1 : 0));

	const pairs: SimilarPair[] = [];
	for (let a = 0; a < candidates.length; a++) {
		const first = candidates[a] as string;
		for (let b = a + 1; b < candidates.length; b++) {
			const second = candidates[b] as string;
			const maxLength = Math.max(first.length, second.length);
			// similarity = 1 - distance/maxLength > threshold  =>  distance < (1-threshold)*maxLength
			const allowed = Math.floor((1 - request.threshold) * maxLength);
			if (second.length - first.length > allowed) break;
			const distance = boundedDistance(first, second, allowed);
			if (distance > allowed) continue;
			const similarity = 1 - distance / maxLength;
			if (similarity > request.threshold) {
				pairs.push({ a: first, b: second, similarity });
			}
		}
	}
	return { pairs };
}

/**
 * ES5 transcription of {@link findSimilarPairs} for the Blob worker.
 *
 * Kept byte-for-byte behaviourally identical to the function above; the parity test proves
 * it on randomised input, so a change to one without the other fails the suite.
 */
const WORKER_SOURCE = `
function boundedDistance(a, b, cutoff) {
	if (a === b) return 0;
	if (a.length === 0) return b.length;
	if (b.length === 0) return a.length;
	if (Math.abs(a.length - b.length) > cutoff) return cutoff + 1;
	var source = a, target = b, swap;
	if (source.length > target.length) { swap = source; source = target; target = swap; }
	var width = source.length + 1;
	var previous = new Array(width);
	var current = new Array(width);
	for (var i = 0; i < width; i++) previous[i] = i;
	for (var j = 1; j <= target.length; j++) {
		current[0] = j;
		var rowMinimum = j;
		var targetChar = target.charCodeAt(j - 1);
		for (var k = 1; k < width; k++) {
			var cost = source.charCodeAt(k - 1) === targetChar ? 0 : 1;
			var value = Math.min(previous[k] + 1, current[k - 1] + 1, previous[k - 1] + cost);
			current[k] = value;
			if (value < rowMinimum) rowMinimum = value;
		}
		if (rowMinimum > cutoff) return cutoff + 1;
		swap = previous; previous = current; current = swap;
	}
	return previous[width - 1];
}

function findSimilarPairs(request) {
	var seen = Object.create(null);
	var candidates = [];
	for (var i = 0; i < request.items.length; i++) {
		var item = request.items[i];
		if (item.length < request.minLength) continue;
		if (seen[item]) continue;
		seen[item] = true;
		candidates.push(item);
	}
	candidates.sort(function (x, y) { return x.length - y.length || (x < y ? -1 : x > y ? 1 : 0); });

	var pairs = [];
	for (var a = 0; a < candidates.length; a++) {
		var first = candidates[a];
		for (var b = a + 1; b < candidates.length; b++) {
			var second = candidates[b];
			var maxLength = Math.max(first.length, second.length);
			var allowed = Math.floor((1 - request.threshold) * maxLength);
			if (second.length - first.length > allowed) break;
			var distance = boundedDistance(first, second, allowed);
			if (distance > allowed) continue;
			var similarity = 1 - distance / maxLength;
			if (similarity > request.threshold) {
				pairs.push({ a: first, b: second, similarity: similarity });
			}
		}
	}
	return { pairs: pairs };
}

self.onmessage = function (event) {
	try {
		self.postMessage({ ok: true, result: findSimilarPairs(event.data) });
	} catch (error) {
		self.postMessage({
			ok: false,
			error: String(error && error.message ? error.message : error),
		});
	}
};
`;

/** Exposed so the parity test can execute the worker source in isolation. */
export function getWorkerSource(): string {
	return WORKER_SOURCE;
}

/** Handle for an off-thread similarity runner. */
export interface SimilarityWorker {
	run(request: SimilarityRequest): Promise<SimilarityResponse>;
	terminate(): void;
}

/**
 * Create a Blob-backed worker, or null when the platform cannot provide one.
 *
 * Returning null is expected on webviews without `Worker`; the caller falls back to
 * {@link findSimilarPairs}.
 */
export function createSimilarityWorker(): SimilarityWorker | null {
	if (
		typeof Worker === 'undefined' ||
		typeof Blob === 'undefined' ||
		typeof URL === 'undefined' ||
		typeof URL.createObjectURL !== 'function'
	) {
		return null;
	}

	let url: string;
	let worker: Worker;
	try {
		const blob = new Blob([WORKER_SOURCE], { type: 'application/javascript' });
		url = URL.createObjectURL(blob);
		worker = new Worker(url);
	} catch {
		return null;
	}

	let terminated = false;

	return {
		run(request: SimilarityRequest): Promise<SimilarityResponse> {
			if (terminated) return Promise.resolve(findSimilarPairs(request));
			return new Promise<SimilarityResponse>((resolve, reject) => {
				const cleanup = (): void => {
					worker.removeEventListener('message', onMessage);
					worker.removeEventListener('error', onError);
				};
				const onMessage = (event: MessageEvent): void => {
					cleanup();
					const data = event.data as
						{ ok: true; result: SimilarityResponse } | { ok: false; error: string };
					if (data.ok) resolve(data.result);
					else reject(new Error(data.error));
				};
				const onError = (event: ErrorEvent): void => {
					cleanup();
					reject(new Error(event.message || 'Similarity worker failed'));
				};
				worker.addEventListener('message', onMessage);
				worker.addEventListener('error', onError);
				worker.postMessage(request);
			});
		},
		terminate(): void {
			if (terminated) return;
			terminated = true;
			worker.terminate();
			URL.revokeObjectURL(url);
		},
	};
}

/**
 * Runs similarity work off-thread when possible and on the main thread otherwise,
 * including after a worker fails at runtime.
 */
export class SimilarityRunner {
	private worker: SimilarityWorker | null = null;
	private workerAttempted = false;

	constructor(private readonly useWorker: boolean) {}

	async run(request: SimilarityRequest): Promise<SimilarityResponse> {
		if (!this.useWorker) return findSimilarPairs(request);

		if (!this.workerAttempted) {
			this.workerAttempted = true;
			this.worker = createSimilarityWorker();
		}
		if (!this.worker) return findSimilarPairs(request);

		try {
			return await this.worker.run(request);
		} catch {
			// A worker failure must never fail a scan.
			this.worker.terminate();
			this.worker = null;
			return findSimilarPairs(request);
		}
	}

	/** True when work is actually going off-thread. */
	get isOffThread(): boolean {
		return this.worker !== null;
	}

	dispose(): void {
		this.worker?.terminate();
		this.worker = null;
	}
}
