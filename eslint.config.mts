import obsidianmd from 'eslint-plugin-obsidianmd';
import globals from 'globals';
import { globalIgnores, defineConfig } from 'eslint/config';

export default defineConfig(
	globalIgnores([
		'node_modules',
		'dist',
		'coverage',
		'esbuild.config.mjs',
		'version-bump.mjs',
		'versions.json',
		'main.js',
		'styles.css',
		'package.json',
		'package-lock.json',
		'tsconfig.json',
		'test-vault',
	]),
	{
		languageOptions: {
			globals: {
				...globals.browser,
			},
			parserOptions: {
				projectService: {
					allowDefaultProject: ['eslint.config.mts', 'manifest.json'],
				},
				tsconfigRootDir: import.meta.dirname,
				extraFileExtensions: ['.json'],
			},
		},
	},
	...obsidianmd.configs.recommended,
	{
		// Mobile compatibility is a hard requirement: no Node.js-only modules may be
		// imported anywhere in the plugin source.
		files: ['src/**/*.ts'],
		rules: {
			'no-restricted-imports': [
				'error',
				{
					paths: [
						'fs',
						'node:fs',
						'path',
						'node:path',
						'os',
						'node:os',
						'child_process',
						'node:child_process',
						'crypto',
						'node:crypto',
						'electron',
					],
					patterns: ['node:*'],
				},
			],
			'@typescript-eslint/explicit-function-return-type': [
				'error',
				{ allowExpressions: true, allowTypedFunctionExpressions: true },
			],
			'@typescript-eslint/no-explicit-any': 'error',
			'no-console': ['error', { allow: ['debug', 'info', 'warn', 'error'] }],
		},
	},
	{
		// The logger is the one sanctioned place the plugin writes to the console; every
		// other module reports through it rather than calling console directly, which is
		// what keeps the "avoid unnecessary logging" guideline enforceable everywhere else.
		files: ['src/core/logger.ts'],
		rules: {
			'no-console': 'off',
			'obsidianmd/rule-custom-message': 'off',
		},
	},
	{
		// Tests run in Node, not in Obsidian: they legitimately read fixtures from disk,
		// reimplement Obsidian's DOM helpers, and drive raw timers. The Obsidian-specific
		// rules describe the plugin runtime and do not apply to them. `no-tfile-tfolder-cast`
		// is off for the same reason the `App` casts exist: `tsc` types the tests against the
		// real declarations while vitest aliases `obsidian` to the mock, so handing a mock
		// file to a service under test is a cast by construction, not a missed `instanceof`.
		files: ['tests/**/*.ts', 'vitest.config.ts', 'vitest.perf.config.ts'],
		languageOptions: {
			globals: { ...globals.node },
		},
		rules: {
			'obsidianmd/rule-custom-message': 'off',
			'@typescript-eslint/no-base-to-string': 'off',
			'@typescript-eslint/no-explicit-any': 'off',
			'@typescript-eslint/explicit-function-return-type': 'off',
			'@typescript-eslint/no-unnecessary-type-assertion': 'off',
			'no-restricted-imports': 'off',
			'no-console': 'off',
			'obsidianmd/no-nodejs-modules': 'off',
			'obsidianmd/prefer-create-el': 'off',
			'obsidianmd/prefer-window-timers': 'off',
			'obsidianmd/no-global-this': 'off',
			'obsidianmd/prefer-file-manager-trash-file': 'off',
			'obsidianmd/hardcoded-config-path': 'off',
			'obsidianmd/no-static-styles-assignment': 'off',
			'obsidianmd/settings-tab/prefer-setting-definitions': 'off',
			'obsidianmd/prefer-instanceof': 'off',
			'obsidianmd/no-unsupported-api': 'off',
			'obsidianmd/no-tfile-tfolder-cast': 'off',
		},
	},
);
