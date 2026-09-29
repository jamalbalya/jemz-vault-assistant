import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const r = (p: string): string => fileURLToPath(new URL(p, import.meta.url));

/**
 * Performance benchmarks run on their own because generating a 10 000 note vault takes
 * seconds and would slow every ordinary test run.
 */
export default defineConfig({
	resolve: {
		alias: {
			obsidian: r('./tests/mocks/obsidian.ts'),
			'@': r('./src'),
		},
	},
	test: {
		environment: 'happy-dom',
		globals: false,
		setupFiles: [r('./tests/setup.ts')],
		include: ['tests/perf/**/*.test.ts'],
		testTimeout: 300_000,
		hookTimeout: 300_000,
		// Benchmarks must not contend with each other for CPU.
		fileParallelism: false,
		pool: 'threads',
		poolOptions: { threads: { singleThread: true } },
	},
});
