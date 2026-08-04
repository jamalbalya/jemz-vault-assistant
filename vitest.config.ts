import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const r = (p: string): string => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
	resolve: {
		alias: {
			// Every `import { ... } from 'obsidian'` in src/ resolves to the hand written
			// mock during tests. The real module only exists inside Obsidian at runtime.
			obsidian: r('./tests/mocks/obsidian.ts'),
			'@': r('./src'),
		},
	},
	test: {
		environment: 'happy-dom',
		globals: false,
		setupFiles: [r('./tests/setup.ts')],
		include: ['tests/**/*.test.ts'],
		exclude: ['tests/perf/**'],
		testTimeout: 20000,
		coverage: {
			provider: 'v8',
			reporter: ['text', 'json-summary', 'html'],
			reportsDirectory: './coverage',
			include: ['src/**/*.ts'],
			exclude: ['src/**/*.d.ts', 'src/ui/styles/**'],
			thresholds: {
				'src/utils/**': { statements: 95, branches: 85, functions: 95, lines: 95 },
				'src/services/**': { statements: 90, branches: 75, functions: 90, lines: 90 },
				'src/core/**': { statements: 90, branches: 75, functions: 90, lines: 90 },
			},
		},
	},
});
