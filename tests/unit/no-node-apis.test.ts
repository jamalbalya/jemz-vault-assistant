/**
 * Mobile compatibility guard.
 *
 * Obsidian mobile has no Node runtime, so a single stray `require('fs')` anywhere in the
 * bundle turns the plugin into a crash on load for every phone user. Linting catches the
 * import in source; this checks the artefact that actually ships, which is the only thing
 * that can prove a transitive dependency did not drag one in.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../helpers/vault-fixture';

/** Node built-ins that do not exist on mobile. */
const FORBIDDEN_MODULES = [
	'fs',
	'path',
	'os',
	'child_process',
	'crypto',
	'net',
	'http',
	'https',
	'worker_threads',
	'electron',
];

function sourceFiles(dir: string, out: string[] = []): string[] {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) sourceFiles(full, out);
		else if (entry.name.endsWith('.ts')) out.push(full);
	}
	return out;
}

describe('plugin source', () => {
	const files = sourceFiles(join(REPO_ROOT, 'src'));

	it('never imports a Node built-in', () => {
		const offenders: string[] = [];
		for (const file of files) {
			const content = readFileSync(file, 'utf8');
			for (const moduleName of FORBIDDEN_MODULES) {
				const pattern = new RegExp(
					`(?:from\\s+|require\\()['"](?:node:)?${moduleName}['"]`,
				);
				if (pattern.test(content)) offenders.push(`${file} imports ${moduleName}`);
			}
		}
		expect(offenders).toEqual([]);
	});

	it('never calls eval or builds a function from a string', () => {
		// Obsidian's plugin review treats both as remote code execution, and the worker is
		// deliberately written to avoid them.
		const offenders: string[] = [];
		for (const file of files) {
			const content = readFileSync(file, 'utf8');
			if (/\beval\s*\(/.test(content)) offenders.push(`${file} calls eval`);
			if (/new\s+Function\s*\(/.test(content)) offenders.push(`${file} uses new Function`);
		}
		expect(offenders).toEqual([]);
	});

	it('never sets innerHTML or outerHTML', () => {
		// Obsidian's guidelines require DOM construction over HTML strings.
		const offenders: string[] = [];
		for (const file of files) {
			const content = readFileSync(file, 'utf8');
			if (/\.(inner|outer)HTML\s*=/.test(content)) offenders.push(file);
		}
		expect(offenders).toEqual([]);
	});
});

describe('manifest', () => {
	it('declares mobile support', () => {
		const manifest = JSON.parse(
			readFileSync(join(REPO_ROOT, 'manifest.json'), 'utf8'),
		) as Record<string, unknown>;

		expect(manifest.isDesktopOnly).toBe(false);
		expect(manifest.id).toBe('jemz-vault-assistant');
		expect(typeof manifest.minAppVersion).toBe('string');
		expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
	});

	it('lists its version in versions.json', () => {
		const manifest = JSON.parse(
			readFileSync(join(REPO_ROOT, 'manifest.json'), 'utf8'),
		) as Record<string, string>;
		const versions = JSON.parse(
			readFileSync(join(REPO_ROOT, 'versions.json'), 'utf8'),
		) as Record<string, string>;

		expect(versions[manifest.version as string]).toBe(manifest.minAppVersion);
	});
});

describe('built bundle', () => {
	const bundlePath = join(REPO_ROOT, 'main.js');

	it.runIf(existsSync(bundlePath))('contains no Node built-in requires', () => {
		const bundle = readFileSync(bundlePath, 'utf8');
		const offenders = FORBIDDEN_MODULES.filter((moduleName) =>
			new RegExp(`require\\(["'](?:node:)?${moduleName}["']\\)`).test(bundle),
		);
		expect(offenders).toEqual([]);
	});

	it.runIf(existsSync(bundlePath))('stays small enough to load quickly', () => {
		// A bundle that balloons is the usual cause of a slow load; this is a tripwire, not
		// a hard architectural limit.
		expect(statSync(bundlePath).size).toBeLessThan(1_500_000);
	});
});
