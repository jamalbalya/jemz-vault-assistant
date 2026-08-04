/**
 * Helpers that populate the mock vault.
 *
 * `loadVaultFromDisk` mirrors the real `test-vault/` directory into memory so integration
 * tests exercise exactly the files a human would open in Obsidian, while `buildVault` takes
 * an inline description for focused unit tests.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { App, type TFile } from '../mocks/obsidian';

/**
 * Absolute path of the repository root.
 *
 * `import.meta.url` is not a file URL under the happy-dom environment, so the root is found
 * by walking up from the working directory until `manifest.json` appears.
 */
export const REPO_ROOT = (() => {
	let current = process.cwd();
	for (let depth = 0; depth < 10; depth++) {
		if (existsSync(join(current, 'manifest.json'))) return current;
		const parent = dirname(current);
		if (parent === current) break;
		current = parent;
	}
	return process.cwd();
})();

/** Absolute path of the on-disk manual test vault. */
export const TEST_VAULT_PATH = join(REPO_ROOT, 'test-vault');

/**
 * The date the on-disk fixture was authored around. Every date-dependent assertion pins
 * "now" to this instant so On This Day, stale notes, and recency stay deterministic.
 */
export const FIXTURE_NOW = new Date(2026, 5, 15, 12, 0, 0).getTime();

function walk(dir: string, out: string[] = []): string[] {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) walk(full, out);
		else out.push(full);
	}
	return out;
}

export interface LoadVaultOptions {
	/** Skip files whose vault-relative path matches. */
	exclude?: (path: string) => boolean;
}

/**
 * Build an {@link App} whose vault mirrors a directory on disk.
 *
 * Binary attachments are stored as short placeholder text — nothing in the plugin reads
 * attachment bytes, but their size and path matter, so the real size is preserved on the
 * file stat.
 */
export function loadVaultFromDisk(
	directory: string = TEST_VAULT_PATH,
	options: LoadVaultOptions = {},
): App {
	const app = new App('test-vault');
	const files = walk(directory).sort();

	for (const absolute of files) {
		const vaultPath = relative(directory, absolute).split(sep).join('/');
		if (vaultPath.startsWith('.')) continue;
		if (options.exclude?.(vaultPath)) continue;

		const stat = statSync(absolute);
		const isMarkdown = vaultPath.toLowerCase().endsWith('.md');
		const content = isMarkdown ? readFileSync(absolute, 'utf8') : `binary:${stat.size}`;

		app.vault.seed(vaultPath, content, {
			ctime: stat.birthtimeMs || stat.ctimeMs,
			mtime: stat.mtimeMs,
			size: stat.size,
		});
	}

	app.metadataCache.refresh();
	return app;
}

/** One file in an inline fixture. */
export interface FixtureFile {
	path: string;
	content?: string;
	/** Frontmatter written above `content`, in insertion order. */
	frontmatter?: Record<string, unknown>;
	ctime?: number;
	mtime?: number;
	size?: number;
}

function renderFrontmatter(frontmatter: Record<string, unknown>): string {
	const lines: string[] = ['---'];
	for (const [key, value] of Object.entries(frontmatter)) {
		if (Array.isArray(value)) {
			if (value.length === 0) {
				lines.push(`${key}: []`);
			} else {
				lines.push(`${key}:`);
				for (const item of value) lines.push(`  - ${String(item)}`);
			}
		} else {
			lines.push(`${key}: ${String(value)}`);
		}
	}
	lines.push('---', '');
	return lines.join('\n');
}

/** Build an {@link App} from an inline list of files. */
export function buildVault(files: readonly FixtureFile[], vaultName = 'inline-vault'): App {
	const app = new App(vaultName);
	for (const file of files) {
		const body = file.content ?? '';
		const content = file.frontmatter ? renderFrontmatter(file.frontmatter) + body : body;
		app.vault.seed(file.path, content, {
			...(file.ctime !== undefined ? { ctime: file.ctime } : {}),
			...(file.mtime !== undefined ? { mtime: file.mtime } : {}),
			...(file.size !== undefined ? { size: file.size } : {}),
		});
	}
	app.metadataCache.refresh();
	return app;
}

/** Convenience: fetch a file that must exist, failing loudly when it does not. */
export function requireFile(app: App, path: string): TFile {
	const file = app.vault.getFileByPath(path);
	if (!file) throw new Error(`Fixture is missing "${path}"`);
	return file;
}

/** Epoch ms for a `YYYY-MM-DD` string at local midnight. */
export function day(iso: string): number {
	const [year, month, date] = iso.split('-').map(Number);
	return new Date(year ?? 1970, (month ?? 1) - 1, date ?? 1).getTime();
}
