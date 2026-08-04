/**
 * Debounce and throttle.
 *
 * Obsidian exports a `debounce` helper, but the plugin needs `cancel`/`flush` and a
 * throttle as well, and keeping our own copy makes these paths unit testable without a
 * running app.
 */

export interface DebouncedFunction<A extends unknown[]> {
	(...args: A): void;
	/** Drop any pending invocation. */
	cancel(): void;
	/** Run any pending invocation immediately. */
	flush(): void;
	/** Whether an invocation is currently scheduled. */
	pending(): boolean;
}

/**
 * Delay `fn` until `wait` milliseconds have passed without another call.
 *
 * @param leading Run on the first call instead of the last.
 */
export function debounce<A extends unknown[]>(
	fn: (...args: A) => void,
	wait: number,
	leading = false,
): DebouncedFunction<A> {
	let timer: number | null = null;
	let lastArgs: A | null = null;

	const invoke = (): void => {
		const args = lastArgs;
		lastArgs = null;
		timer = null;
		if (args) fn(...args);
	};

	const debounced = (...args: A): void => {
		lastArgs = args;
		const isFirstCall = timer === null;
		if (timer !== null) window.clearTimeout(timer);
		if (leading && isFirstCall) {
			lastArgs = null;
			fn(...args);
			// Still start the timer so trailing calls within the window collapse.
			timer = window.setTimeout(() => {
				timer = null;
			}, wait);
			return;
		}
		timer = window.setTimeout(invoke, wait);
	};

	debounced.cancel = (): void => {
		if (timer !== null) window.clearTimeout(timer);
		timer = null;
		lastArgs = null;
	};

	debounced.flush = (): void => {
		if (timer !== null) {
			window.clearTimeout(timer);
			invoke();
		}
	};

	debounced.pending = (): boolean => timer !== null;

	return debounced;
}

/** Run `fn` at most once per `wait` milliseconds, always firing on the leading edge. */
export function throttle<A extends unknown[]>(
	fn: (...args: A) => void,
	wait: number,
): DebouncedFunction<A> {
	let lastRun = 0;
	let timer: number | null = null;
	let lastArgs: A | null = null;

	const run = (args: A): void => {
		lastRun = Date.now();
		lastArgs = null;
		fn(...args);
	};

	const throttled = (...args: A): void => {
		const elapsed = Date.now() - lastRun;
		lastArgs = args;
		if (elapsed >= wait) {
			if (timer !== null) {
				window.clearTimeout(timer);
				timer = null;
			}
			run(args);
			return;
		}
		if (timer === null) {
			timer = window.setTimeout(() => {
				timer = null;
				if (lastArgs) run(lastArgs);
			}, wait - elapsed);
		}
	};

	throttled.cancel = (): void => {
		if (timer !== null) window.clearTimeout(timer);
		timer = null;
		lastArgs = null;
	};

	throttled.flush = (): void => {
		if (timer !== null) {
			window.clearTimeout(timer);
			timer = null;
			if (lastArgs) run(lastArgs);
		}
	};

	throttled.pending = (): boolean => timer !== null;

	return throttled;
}

/**
 * Yield to the event loop so long running work never blocks painting.
 * Uses `requestAnimationFrame` when available and falls back to a macrotask.
 */
export function yieldToUi(): Promise<void> {
	return new Promise((resolve) => {
		if (typeof requestAnimationFrame === 'function') {
			window.requestAnimationFrame(() => resolve());
			return;
		}
		window.setTimeout(resolve, 0);
	});
}
