/**
 * MetadataService: every read comes from the metadata cache, every write goes through
 * `processFrontMatter`, and a note with a broken YAML block is never rewritten.
 *
 * The assertions below check file bytes rather than just the parsed result, because the whole
 * point of the contract is what survives on disk: the body, untouched keys, and — for a
 * corrupted note — the user's broken YAML exactly as they left it.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { App as ObsidianApp, TFile as ObsidianTFile } from 'obsidian';
import type { App, CachedMetadata, TFile } from '../../mocks/obsidian';
import { buildVault, loadVaultFromDisk, requireFile } from '../../helpers/vault-fixture';
import { Logger } from '../../../src/core/logger';
import { MetadataService, MetadataWriteError } from '../../../src/services/metadata-service';
import type { NoteRecord } from '../../../src/types/note';

/**
 * Hand the in-memory mock to code that is type-checked against the published Obsidian API.
 *
 * `tsconfig` resolves `obsidian` to the real declarations while vitest swaps in the mock, so
 * the two `App`/`TFile` types are structurally different by design. Confining the bridge to
 * these helpers keeps every assertion below honestly typed.
 */
function asApp(app: App): ObsidianApp {
	return app as unknown as ObsidianApp;
}

/** The mock counterpart of {@link asApp}, for a file the test obtained itself. */
function asFile(file: TFile): ObsidianTFile {
	return file as unknown as ObsidianTFile;
}

/** Fetch a fixture file, typed the way the service under test expects it. */
function fileAt(app: App, path: string): ObsidianTFile {
	return asFile(requireFile(app, path));
}

/**
 * Make the metadata cache report nothing for one note, as the real one does.
 *
 * Obsidian rebuilds the cache asynchronously, so for a window after any write the cache still
 * says a note has no frontmatter while the file on disk already has a block. An empty block
 * also has no mapping for the cache to report in the first place. The mock rebuilds
 * synchronously and reads an empty block as `{}`, so both cases have to be staged by hand —
 * without this, every guard test would silently exercise the easy path.
 */
function blindCacheFor(app: App, path: string): void {
	const cache = app.metadataCache;
	const original = cache.getFileCache.bind(cache);
	cache.getFileCache = (file: TFile): CachedMetadata | null =>
		file.path === path ? null : original(file);
}

/** Captures log output so error paths can assert that failures were reported, not swallowed. */
class RecordingLogger extends Logger {
	readonly errors: string[] = [];
	readonly warnings: string[] = [];

	constructor() {
		super('silent');
	}

	override error(message: string, ..._details: unknown[]): void {
		this.errors.push(message);
	}

	override warn(message: string, ..._details: unknown[]): void {
		this.warnings.push(message);
	}
}

const VALID_NOTE = 'Notes/valid.md';
const NO_FRONTMATTER_NOTE = 'Notes/plain.md';
const CORRUPT_NOTE = 'Notes/corrupt.md';
const UNTERMINATED_NOTE = 'Notes/unterminated.md';

const CORRUPT_CONTENT =
	'---\ncreated: 2026-05-28\ntype note\ntags [test, broken\n---\n\n# Broken\n';
const UNTERMINATED_CONTENT = '---\ntype: note\n\n# No closing fence\n';

/** A small vault covering the four frontmatter shapes every write path has to handle. */
function makeVault(): App {
	return buildVault([
		{
			path: VALID_NOTE,
			frontmatter: { created: '2026-05-01', type: 'note', status: 'inbox', tags: ['work'] },
			content: '# Valid\n\nBody text that must survive every write.\n',
		},
		{ path: NO_FRONTMATTER_NOTE, content: '# Plain\n\nNo properties here.\n' },
		{ path: CORRUPT_NOTE, content: CORRUPT_CONTENT },
		{ path: UNTERMINATED_NOTE, content: UNTERMINATED_CONTENT },
	]);
}

/** Build a NoteRecord stub carrying only what {@link MetadataService.missingRequiredFields} reads. */
function recordWith(frontmatter: Record<string, unknown> | null): NoteRecord {
	return {
		path: 'Notes/record.md',
		basename: 'record',
		extension: 'md',
		folder: 'Notes',
		created: 0,
		modified: 0,
		fileModified: 0,
		size: 0,
		frontmatter,
		hasFrontmatterBlock: frontmatter !== null,
		frontmatterValid: frontmatter !== null,
		type: null,
		status: null,
		source: null,
		tags: [],
		links: [],
		resolvedLinks: [],
		unresolvedLinks: [],
		backlinks: [],
		headings: [],
		isAttachment: false,
	};
}

describe('readFrontmatter', () => {
	let app: App;
	let service: MetadataService;

	beforeEach(() => {
		app = makeVault();
		service = new MetadataService(asApp(app), new Logger('silent'));
	});

	it('returns the parsed properties of a valid note', () => {
		const frontmatter = service.readFrontmatter(fileAt(app, VALID_NOTE));
		expect(frontmatter).toEqual({
			created: '2026-05-01',
			type: 'note',
			status: 'inbox',
			tags: ['work'],
		});
	});

	it('returns null for a note without frontmatter', () => {
		expect(service.readFrontmatter(fileAt(app, NO_FRONTMATTER_NOTE))).toBeNull();
	});

	it('returns null for a note whose frontmatter could not be parsed', () => {
		expect(service.readFrontmatter(fileAt(app, CORRUPT_NOTE))).toBeNull();
	});

	it('returns a copy so callers cannot corrupt the metadata cache', () => {
		const file = fileAt(app, VALID_NOTE);
		const first = service.readFrontmatter(file);
		expect(first).not.toBeNull();
		if (first) first.status = 'tampered';
		expect(service.readFrontmatter(file)?.status).toBe('inbox');
	});

	it('protects the cache from a list mutated in place, not just a reassigned key', () => {
		// A shallow copy hands back the very array Obsidian is holding, so `tags.push(...)`
		// would reach into the cache and every later reader would see the injected entry.
		const file = fileAt(app, VALID_NOTE);
		(service.readFrontmatter(file)?.tags as string[]).push('injected');

		expect(service.readFrontmatter(file)?.tags).toEqual(['work']);
		expect(
			app.metadataCache.getFileCache(requireFile(app, VALID_NOTE))?.frontmatter?.tags,
		).toEqual(['work']);
	});

	it('protects the cache from a nested mapping mutated in place', () => {
		// Obsidian parses nested mappings, but the mock's minimal YAML reader flattens them,
		// so the cache entry is staged directly rather than written as text.
		const app2 = buildVault([{ path: 'n.md', content: '---\ntype: note\n---\n\nbody\n' }]);
		const cached: Record<string, unknown> = { meta: { owner: 'jem' } };
		app2.metadataCache.getFileCache = (): CachedMetadata => ({ frontmatter: cached });

		const service2 = new MetadataService(asApp(app2), new Logger('silent'));
		const file = fileAt(app2, 'n.md');

		const nested = service2.readFrontmatter(file)?.meta;
		expect(nested).toEqual({ owner: 'jem' });
		(nested as Record<string, unknown>).owner = 'tampered';

		expect(service2.readFrontmatter(file)?.meta).toEqual({ owner: 'jem' });
		expect(cached.meta).toEqual({ owner: 'jem' });
	});

	it('reads unicode values from a unicode filename', () => {
		const unicodeApp = buildVault([
			{
				path: 'Notes/ノート-日本語.md',
				frontmatter: { title: 'こんにちは', type: 'note' },
				content: '# 日本語\n',
			},
		]);
		const unicodeService = new MetadataService(asApp(unicodeApp), new Logger('silent'));
		const frontmatter = unicodeService.readFrontmatter(
			fileAt(unicodeApp, 'Notes/ノート-日本語.md'),
		);
		expect(frontmatter?.title).toBe('こんにちは');
	});

	it('reads properties from a file whose name contains special characters', () => {
		const specialApp = loadVaultFromDisk();
		const specialService = new MetadataService(asApp(specialApp), new Logger('silent'));
		const file = fileAt(specialApp, 'Problem Notes/special chars - @#$%.md');
		expect(specialService.readFrontmatter(file)?.type).toBe('note');
	});
});

describe('updateFrontmatter', () => {
	let app: App;
	let logger: RecordingLogger;
	let service: MetadataService;

	beforeEach(() => {
		app = makeVault();
		logger = new RecordingLogger();
		service = new MetadataService(asApp(app), logger);
	});

	it('changes one key and leaves the other keys and the body alone', async () => {
		const file = fileAt(app, VALID_NOTE);
		await service.updateFrontmatter(file, (frontmatter) => {
			frontmatter.status = 'processed';
		});

		const content = app.vault.peek(VALID_NOTE) ?? '';
		expect(content).toContain('status: processed');
		expect(content).toContain('created: 2026-05-01');
		expect(content).toContain('type: note');
		expect(content).toContain('Body text that must survive every write.');
	});

	it('creates a block on a note that has none, keeping the body', async () => {
		const file = fileAt(app, NO_FRONTMATTER_NOTE);
		await service.updateFrontmatter(file, (frontmatter) => {
			frontmatter.type = 'capture';
		});

		const content = app.vault.peek(NO_FRONTMATTER_NOTE) ?? '';
		expect(content.startsWith('---\ntype: capture\n---\n')).toBe(true);
		expect(content).toContain('# Plain');
	});

	it('refuses to rewrite corrupted frontmatter and leaves the file byte-identical', async () => {
		const file = fileAt(app, CORRUPT_NOTE);
		await expect(service.updateFrontmatter(file, () => undefined)).rejects.toBeInstanceOf(
			MetadataWriteError,
		);
		expect(app.vault.peek(CORRUPT_NOTE)).toBe(CORRUPT_CONTENT);
		expect(logger.warnings.join(' ')).toContain('corrupted frontmatter');
	});

	it('carries the path and an explanatory message on the refusal', async () => {
		const file = fileAt(app, CORRUPT_NOTE);
		const error = await service
			.updateFrontmatter(file, () => undefined)
			.then(
				() => null,
				(caught: unknown) => caught,
			);
		expect(error).toBeInstanceOf(MetadataWriteError);
		expect((error as MetadataWriteError).path).toBe(CORRUPT_NOTE);
		expect((error as MetadataWriteError).name).toBe('MetadataWriteError');
		expect((error as MetadataWriteError).message).toContain('could not be parsed');
	});

	it('refuses a block that was opened but never closed', async () => {
		const file = fileAt(app, UNTERMINATED_NOTE);
		await expect(service.updateFrontmatter(file, () => undefined)).rejects.toBeInstanceOf(
			MetadataWriteError,
		);
		expect(app.vault.peek(UNTERMINATED_NOTE)).toBe(UNTERMINATED_CONTENT);
	});

	it('fills in an empty block the cache has not caught up with', async () => {
		const app2 = buildVault([{ path: 'empty-block.md', content: '---\n---\n# Body\n' }]);
		const service2 = new MetadataService(asApp(app2), new Logger('silent'));
		const file = fileAt(app2, 'empty-block.md');
		// What Obsidian actually reports for this note: an empty block carries no mapping, and
		// the cache lags behind the write that created it. Neither means "broken YAML".
		blindCacheFor(app2, 'empty-block.md');

		await service2.updateFrontmatter(file, (frontmatter) => {
			frontmatter.status = 'inbox';
		});

		const content = app2.vault.peek('empty-block.md') ?? '';
		expect(content).toContain('status: inbox');
		expect(content).toContain('# Body');
		// One block, not two stacked on top of each other.
		expect(content.match(/^---$/gm)).toHaveLength(2);
	});

	it('treats a block holding only blank lines as empty rather than broken', async () => {
		const app2 = buildVault([{ path: 'blank-block.md', content: '---\n\n   \n---\n# Body\n' }]);
		const service2 = new MetadataService(asApp(app2), new Logger('silent'));
		blindCacheFor(app2, 'blank-block.md');

		await service2.setStatus(fileAt(app2, 'blank-block.md'), 'inbox');
		expect(app2.vault.peek('blank-block.md')).toContain('status: inbox');
	});

	it('still refuses a block whose YAML is broken when the cache reports nothing', async () => {
		// The same staging as the empty-block cases, to prove the guard keys on the block's
		// contents and not merely on whether the cache happened to be populated.
		blindCacheFor(app, CORRUPT_NOTE);

		await expect(
			service.updateFrontmatter(fileAt(app, CORRUPT_NOTE), () => undefined),
		).rejects.toBeInstanceOf(MetadataWriteError);
		expect(app.vault.peek(CORRUPT_NOTE)).toBe(CORRUPT_CONTENT);
	});

	it('reports a write failure on a read-only vault instead of failing silently', async () => {
		const file = fileAt(app, VALID_NOTE);
		app.vault.readOnly = true;

		await expect(
			service.updateFrontmatter(file, (frontmatter) => {
				frontmatter.status = 'processed';
			}),
		).rejects.toThrow(/Could not write/);
		expect(logger.errors.join(' ')).toContain('Could not write frontmatter');
	});

	it('reports a read failure when the guard cannot read the file', async () => {
		const file = fileAt(app, NO_FRONTMATTER_NOTE);
		app.vault.cachedRead = async (): Promise<string> => {
			throw new Error('EIO: unreadable');
		};

		await expect(service.updateFrontmatter(file, () => undefined)).rejects.toThrow(
			/Could not read/,
		);
		expect(logger.errors.join(' ')).toContain('Could not read');
	});

	it('reports a write failure when the file becomes unreadable mid-write', async () => {
		const file = fileAt(app, VALID_NOTE);
		app.vault.read = async (): Promise<string> => {
			throw new Error('EIO: unreadable');
		};

		await expect(
			service.updateFrontmatter(file, (frontmatter) => {
				frontmatter.status = 'processed';
			}),
		).rejects.toThrow(/Could not write/);
	});

	it('fails cleanly when the note was deleted before the write', async () => {
		const file = requireFile(app, VALID_NOTE);
		await app.vault.trash(file, false);

		// A vanished file is a read failure, not a corrupted-frontmatter refusal — the two
		// carry different messages and only one of them tells the user to repair their YAML.
		await expect(
			service.updateFrontmatter(asFile(file), (frontmatter) => {
				frontmatter.status = 'processed';
			}),
		).rejects.toThrow(/Could not read/);
		expect(logger.errors.join(' ')).toContain('Could not read');
	});

	it('reads and writes a note that uses CRLF line endings', async () => {
		const app2 = buildVault([
			{
				path: 'crlf.md',
				content: '---\r\ntype: note\r\ntags:\r\n  - work\r\n---\r\n\r\n# Body\r\n',
			},
		]);
		const service2 = new MetadataService(asApp(app2), new Logger('silent'));
		const file = fileAt(app2, 'crlf.md');

		// The fences and values must survive the \r that terminates every line.
		expect(service2.readFrontmatter(file)).toEqual({ type: 'note', tags: ['work'] });

		await service2.setStatus(file, 'processed');

		expect(service2.readFrontmatter(file)?.status).toBe('processed');
		expect(service2.readFrontmatter(file)?.tags).toEqual(['work']);
		expect(app2.vault.peek('crlf.md')).toContain('# Body');
	});

	it('keeps concurrent property writes from losing each other', async () => {
		const file = fileAt(app, VALID_NOTE);
		await Promise.all([
			service.updateFrontmatter(file, (frontmatter) => {
				frontmatter.status = 'processed';
			}),
			service.updateFrontmatter(file, (frontmatter) => {
				frontmatter.reviewed = true;
			}),
		]);

		const content = app.vault.peek(VALID_NOTE) ?? '';
		expect(content).toContain('status: processed');
		expect(content).toContain('reviewed: true');
		expect(content).toContain('Body text that must survive every write.');
	});
});

describe('setStatus, setType and setProperties', () => {
	let app: App;
	let service: MetadataService;

	beforeEach(() => {
		app = makeVault();
		service = new MetadataService(asApp(app), new Logger('silent'));
	});

	it('sets the status without disturbing the other properties', async () => {
		await service.setStatus(fileAt(app, VALID_NOTE), 'archived');
		const content = app.vault.peek(VALID_NOTE) ?? '';
		expect(content).toContain('status: archived');
		expect(content).toContain('tags:\n  - work');
	});

	it('accepts a custom status value, since the set is open', async () => {
		await service.setStatus(fileAt(app, VALID_NOTE), '  waiting-on-client  ');
		expect(app.vault.peek(VALID_NOTE)).toContain('status: waiting-on-client');
	});

	it('removes the status key when the value is blank', async () => {
		await service.setStatus(fileAt(app, VALID_NOTE), '   ');
		expect(app.vault.peek(VALID_NOTE)).not.toContain('status:');
	});

	it('sets the type on a note that had no frontmatter at all', async () => {
		await service.setType(fileAt(app, NO_FRONTMATTER_NOTE), 'reference');
		expect(app.vault.peek(NO_FRONTMATTER_NOTE)).toContain('type: reference');
	});

	it('refuses to set a type on a corrupted note', async () => {
		await expect(service.setType(fileAt(app, CORRUPT_NOTE), 'note')).rejects.toBeInstanceOf(
			MetadataWriteError,
		);
		expect(app.vault.peek(CORRUPT_NOTE)).toBe(CORRUPT_CONTENT);
	});

	it('merges several properties at once', async () => {
		await service.setProperties(fileAt(app, VALID_NOTE), {
			project: 'Alpha',
			priority: 2,
			reviewed: false,
		});

		const content = app.vault.peek(VALID_NOTE) ?? '';
		expect(content).toContain('project: Alpha');
		expect(content).toContain('priority: 2');
		expect(content).toContain('reviewed: false');
		expect(content).toContain('created: 2026-05-01');
	});

	it('deletes a property whose value is undefined', async () => {
		await service.setProperties(fileAt(app, VALID_NOTE), { status: undefined });
		expect(app.vault.peek(VALID_NOTE)).not.toContain('status:');
	});

	it('writes nothing when there are no properties to set', async () => {
		const file = fileAt(app, VALID_NOTE);
		const before = app.vault.peek(VALID_NOTE);
		const mtimeBefore = file.stat.mtime;

		await service.setProperties(file, {});

		expect(app.vault.peek(VALID_NOTE)).toBe(before);
		expect(file.stat.mtime).toBe(mtimeBefore);
	});

	it('round-trips unicode property values', async () => {
		const file = fileAt(app, VALID_NOTE);
		await service.setProperties(file, { title: '日本語のタイトル' });
		expect(service.readFrontmatter(file)?.title).toBe('日本語のタイトル');
	});
});

describe('addTag', () => {
	let app: App;
	let service: MetadataService;

	beforeEach(() => {
		app = makeVault();
		service = new MetadataService(asApp(app), new Logger('silent'));
	});

	it('appends to an existing list', async () => {
		const file = fileAt(app, VALID_NOTE);
		await service.addTag(file, 'ideas');
		expect(service.readFrontmatter(file)?.tags).toEqual(['work', 'ideas']);
	});

	it('creates the list when the note has no tags key', async () => {
		const app2 = buildVault([
			{ path: 'a.md', frontmatter: { type: 'note' }, content: 'body\n' },
		]);
		const service2 = new MetadataService(asApp(app2), new Logger('silent'));
		const file = fileAt(app2, 'a.md');

		await service2.addTag(file, 'inbox');
		expect(service2.readFrontmatter(file)?.tags).toEqual(['inbox']);
	});

	it('creates the whole block when the note has no frontmatter', async () => {
		const file = fileAt(app, NO_FRONTMATTER_NOTE);
		await service.addTag(file, 'inbox');

		expect(service.readFrontmatter(file)?.tags).toEqual(['inbox']);
		expect(app.vault.peek(NO_FRONTMATTER_NOTE)).toContain('# Plain');
	});

	it('converts a string tags value into a list', async () => {
		const app2 = buildVault([
			{ path: 'a.md', content: '---\ntags: work, ideas\n---\n\nbody\n' },
		]);
		const service2 = new MetadataService(asApp(app2), new Logger('silent'));
		const file = fileAt(app2, 'a.md');

		await service2.addTag(file, 'inbox');
		expect(service2.readFrontmatter(file)?.tags).toEqual(['work', 'ideas', 'inbox']);
	});

	it('normalises the leading hash and the casing', async () => {
		const file = fileAt(app, VALID_NOTE);
		await service.addTag(file, '  #Reading  ');
		expect(service.readFrontmatter(file)?.tags).toEqual(['work', 'reading']);
	});

	it('is a no-op when the tag is already there, in any casing', async () => {
		const app2 = buildVault([
			{ path: 'a.md', frontmatter: { tags: ['Work'] }, content: 'body\n' },
		]);
		const service2 = new MetadataService(asApp(app2), new Logger('silent'));
		const file = fileAt(app2, 'a.md');
		const before = app2.vault.peek('a.md');
		const mtimeBefore = file.stat.mtime;

		await service2.addTag(file, '#work');

		expect(app2.vault.peek('a.md')).toBe(before);
		expect(file.stat.mtime).toBe(mtimeBefore);
	});

	it('ignores a blank tag', async () => {
		const file = fileAt(app, VALID_NOTE);
		const before = app.vault.peek(VALID_NOTE);
		const mtimeBefore = file.stat.mtime;

		await service.addTag(file, '   #  ');

		expect(app.vault.peek(VALID_NOTE)).toBe(before);
		expect(file.stat.mtime).toBe(mtimeBefore);
		// Specifically: no empty entry was appended to the list.
		expect(service.readFrontmatter(file)?.tags).toEqual(['work']);
	});

	it('does not raise corruption for a blank tag, which asks for no write at all', async () => {
		// The guard runs before the "already present" no-op, but a blank tag never reaches the
		// note: there is nothing to write, so there is nothing to refuse.
		const file = fileAt(app, CORRUPT_NOTE);
		await expect(service.addTag(file, '  ')).resolves.toBeUndefined();
		await expect(service.removeTag(file, '#')).resolves.toBeUndefined();
		await expect(service.setProperties(file, {})).resolves.toBeUndefined();
		expect(app.vault.peek(CORRUPT_NOTE)).toBe(CORRUPT_CONTENT);
	});

	it('refuses to touch a corrupted note', async () => {
		await expect(service.addTag(fileAt(app, CORRUPT_NOTE), 'inbox')).rejects.toBeInstanceOf(
			MetadataWriteError,
		);
		expect(app.vault.peek(CORRUPT_NOTE)).toBe(CORRUPT_CONTENT);
	});

	it('tolerates a tag list holding values YAML did not parse as strings', async () => {
		const app2 = buildVault([
			{ path: 'a.md', content: '---\ntags:\n  - 2026\n  - ~\n  - work\n---\n\nbody\n' },
		]);
		const service2 = new MetadataService(asApp(app2), new Logger('silent'));
		const file = fileAt(app2, 'a.md');
		const before = app2.vault.peek('a.md');

		// The numeric entry still counts as the tag "2026", so adding it changes nothing.
		await service2.addTag(file, '2026');
		expect(app2.vault.peek('a.md')).toBe(before);

		await service2.removeTag(file, 'work');
		expect(service2.readFrontmatter(file)?.tags).toEqual([2026, null]);
	});
});

describe('removeTag', () => {
	let app: App;
	let service: MetadataService;

	beforeEach(() => {
		app = makeVault();
		service = new MetadataService(asApp(app), new Logger('silent'));
	});

	it('removes one entry and keeps the rest', async () => {
		const app2 = buildVault([
			{ path: 'a.md', frontmatter: { tags: ['work', 'ideas', 'inbox'] }, content: 'body\n' },
		]);
		const service2 = new MetadataService(asApp(app2), new Logger('silent'));
		const file = fileAt(app2, 'a.md');

		await service2.removeTag(file, 'ideas');
		expect(service2.readFrontmatter(file)?.tags).toEqual(['work', 'inbox']);
	});

	it('matches regardless of casing or a leading hash', async () => {
		const app2 = buildVault([
			{ path: 'a.md', frontmatter: { tags: ['Work', 'ideas'] }, content: 'body\n' },
		]);
		const service2 = new MetadataService(asApp(app2), new Logger('silent'));
		const file = fileAt(app2, 'a.md');

		await service2.removeTag(file, '#WORK');
		expect(service2.readFrontmatter(file)?.tags).toEqual(['ideas']);
	});

	it('removes a tag from a string tags value', async () => {
		const app2 = buildVault([
			{ path: 'a.md', content: '---\ntags: work, ideas\n---\n\nbody\n' },
		]);
		const service2 = new MetadataService(asApp(app2), new Logger('silent'));
		const file = fileAt(app2, 'a.md');

		await service2.removeTag(file, 'work');
		expect(service2.readFrontmatter(file)?.tags).toEqual(['ideas']);
	});

	it('leaves an empty list rather than deleting the property', async () => {
		const file = fileAt(app, VALID_NOTE);
		await service.removeTag(file, 'work');

		expect(service.readFrontmatter(file)?.tags).toEqual([]);
		expect(app.vault.peek(VALID_NOTE)).toContain('tags: []');
	});

	it('writes nothing when the tag is not present', async () => {
		const file = fileAt(app, VALID_NOTE);
		const before = app.vault.peek(VALID_NOTE);
		const mtimeBefore = file.stat.mtime;

		await service.removeTag(file, 'absent');

		expect(app.vault.peek(VALID_NOTE)).toBe(before);
		expect(file.stat.mtime).toBe(mtimeBefore);
	});

	it('writes nothing when the note has no frontmatter', async () => {
		const file = fileAt(app, NO_FRONTMATTER_NOTE);
		const before = app.vault.peek(NO_FRONTMATTER_NOTE);
		const mtimeBefore = file.stat.mtime;

		await service.removeTag(file, 'work');
		await service.removeTag(file, '');

		expect(app.vault.peek(NO_FRONTMATTER_NOTE)).toBe(before);
		expect(file.stat.mtime).toBe(mtimeBefore);
		// No block was conjured up just to hold an empty list.
		expect(service.readFrontmatter(file)).toBeNull();
	});

	it('refuses to touch a corrupted note', async () => {
		await expect(service.removeTag(fileAt(app, CORRUPT_NOTE), 'test')).rejects.toBeInstanceOf(
			MetadataWriteError,
		);
		expect(app.vault.peek(CORRUPT_NOTE)).toBe(CORRUPT_CONTENT);
	});
});

describe('missingRequiredFields', () => {
	const service = new MetadataService(asApp(buildVault([])), new Logger('silent'));

	it('reports nothing when every field is filled in', () => {
		const record = recordWith({ created: '2026-01-01', type: 'note', tags: ['work'] });
		expect(service.missingRequiredFields(record, ['created', 'type', 'tags'])).toEqual([]);
	});

	it('treats absent, null, empty string and empty array as missing', () => {
		const record = recordWith({ type: null, status: '', tags: [] });
		expect(
			service.missingRequiredFields(record, ['created', 'type', 'status', 'tags']),
		).toEqual(['created', 'type', 'status', 'tags']);
	});

	it('treats a whitespace-only value as missing', () => {
		expect(service.missingRequiredFields(recordWith({ type: '   ' }), ['type'])).toEqual([
			'type',
		]);
	});

	it('counts false and zero as present answers', () => {
		const record = recordWith({ draft: false, revision: 0 });
		expect(service.missingRequiredFields(record, ['draft', 'revision'])).toEqual([]);
	});

	it('reports every field when the note has no parsed frontmatter', () => {
		expect(service.missingRequiredFields(recordWith(null), ['created', 'type'])).toEqual([
			'created',
			'type',
		]);
	});

	it('returns nothing when no fields are required', () => {
		expect(service.missingRequiredFields(recordWith(null), [])).toEqual([]);
	});

	it('ignores blank entries and reports a duplicate only once', () => {
		const record = recordWith({});
		expect(service.missingRequiredFields(record, ['type', ' ', ' type ', 'status'])).toEqual([
			'type',
			'status',
		]);
	});

	it('reads a unicode property name', () => {
		const record = recordWith({ タイトル: 'ノート' });
		expect(service.missingRequiredFields(record, ['タイトル', '著者'])).toEqual(['著者']);
	});
});

describe('ensureFrontmatterBlock', () => {
	let app: App;
	let logger: RecordingLogger;
	let service: MetadataService;

	beforeEach(() => {
		app = makeVault();
		logger = new RecordingLogger();
		service = new MetadataService(asApp(app), logger);
	});

	it('adds an empty block above the existing body', async () => {
		const file = fileAt(app, NO_FRONTMATTER_NOTE);
		await service.ensureFrontmatterBlock(file);

		expect(app.vault.peek(NO_FRONTMATTER_NOTE)).toBe(
			'---\n---\n# Plain\n\nNo properties here.\n',
		);
	});

	it('leaves a note that already has a block untouched', async () => {
		const file = fileAt(app, VALID_NOTE);
		const before = app.vault.peek(VALID_NOTE);
		const mtimeBefore = file.stat.mtime;

		await service.ensureFrontmatterBlock(file);

		expect(app.vault.peek(VALID_NOTE)).toBe(before);
		expect(file.stat.mtime).toBe(mtimeBefore);
	});

	it('leaves a corrupted block alone rather than stacking a second one on top', async () => {
		await service.ensureFrontmatterBlock(fileAt(app, CORRUPT_NOTE));
		expect(app.vault.peek(CORRUPT_NOTE)).toBe(CORRUPT_CONTENT);
	});

	it('works on an empty file', async () => {
		const app2 = buildVault([{ path: 'empty.md', content: '' }]);
		const service2 = new MetadataService(asApp(app2), new Logger('silent'));

		await service2.ensureFrontmatterBlock(fileAt(app2, 'empty.md'));
		expect(app2.vault.peek('empty.md')).toBe('---\n---\n');
	});

	it('makes the note ready for a property write', async () => {
		const file = fileAt(app, NO_FRONTMATTER_NOTE);
		await service.ensureFrontmatterBlock(file);
		await service.setStatus(file, 'inbox');

		expect(service.readFrontmatter(file)?.status).toBe('inbox');
	});

	it('makes the note ready for a property write before the cache catches up', async () => {
		// The sequence every bulk property edit runs, staged the way Obsidian behaves: the
		// cache still reports no frontmatter for the block that was just written. Refusing
		// here would fail the write on a note this service itself had just prepared.
		const file = fileAt(app, NO_FRONTMATTER_NOTE);
		await service.ensureFrontmatterBlock(file);
		blindCacheFor(app, NO_FRONTMATTER_NOTE);

		await service.setProperties(file, { type: 'note', status: 'inbox' });

		const content = app.vault.peek(NO_FRONTMATTER_NOTE) ?? '';
		expect(content).toContain('type: note');
		expect(content).toContain('status: inbox');
		expect(content).toContain('# Plain');
		expect(content.match(/^---$/gm)).toHaveLength(2);
	});

	it('keeps a CRLF note on CRLF instead of leaving mixed line endings', async () => {
		const app2 = buildVault([{ path: 'crlf.md', content: '# Plain\r\n\r\nBody\r\n' }]);
		const service2 = new MetadataService(asApp(app2), new Logger('silent'));

		await service2.ensureFrontmatterBlock(fileAt(app2, 'crlf.md'));

		expect(app2.vault.peek('crlf.md')).toBe('---\r\n---\r\n# Plain\r\n\r\nBody\r\n');
	});

	it('reports a read failure instead of assuming the note is empty', async () => {
		const file = fileAt(app, NO_FRONTMATTER_NOTE);
		app.vault.read = async (): Promise<string> => {
			throw new Error('EIO: unreadable');
		};

		await expect(service.ensureFrontmatterBlock(file)).rejects.toThrow(/Could not read/);
		expect(logger.errors.join(' ')).toContain('Could not read');
	});

	it('reports a write failure on a read-only vault', async () => {
		const file = fileAt(app, NO_FRONTMATTER_NOTE);
		app.vault.readOnly = true;

		await expect(service.ensureFrontmatterBlock(file)).rejects.toBeInstanceOf(
			MetadataWriteError,
		);
		expect(logger.errors.join(' ')).toContain('frontmatter block');
	});
});

describe('against the on-disk fixture vault', () => {
	let app: App;
	let service: MetadataService;

	beforeEach(() => {
		app = loadVaultFromDisk();
		service = new MetadataService(asApp(app), new Logger('silent'));
	});

	it('processes an inbox capture without losing its body or source key', async () => {
		const file = fileAt(app, '00-Inbox/2026-06-07 capture - shower thought.md');
		await service.setStatus(file, 'processed');

		const content = app.vault.peek(file.path) ?? '';
		expect(content).toContain('status: processed');
		expect(content).toContain('type: capture');
		expect(content).toContain('The best note-taking app is the one you actually use.');
	});

	it('adds a tag to a note whose name contains special characters', async () => {
		const file = fileAt(app, 'Problem Notes/special chars - @#$%.md');
		await service.addTag(file, '#Triaged');
		expect(service.readFrontmatter(file)?.tags).toEqual(['test', 'triaged']);
	});

	it('rewrites properties on a unicode note without mangling the content', async () => {
		const file = fileAt(app, 'Problem Notes/unicode-note-日本語.md');
		await service.setStatus(file, 'processed');

		const content = app.vault.peek(file.path) ?? '';
		expect(content).toContain('このノートはユニコード文字をテストします。');
		expect(content).toContain('status: processed');
	});

	it('never rewrites the corrupted fixture note', async () => {
		const file = fileAt(app, 'Problem Notes/corrupted-frontmatter.md');
		const before = app.vault.peek(file.path);

		await expect(service.setStatus(file, 'processed')).rejects.toBeInstanceOf(
			MetadataWriteError,
		);
		expect(app.vault.peek(file.path)).toBe(before);
	});

	it('adds properties to the fixture note that has none', async () => {
		const file = fileAt(app, 'Problem Notes/missing metadata note.md');
		await service.setProperties(file, { created: '2026-06-15', type: 'note' });

		const content = app.vault.peek(file.path) ?? '';
		expect(content.startsWith('---\ncreated: 2026-06-15\ntype: note\n---\n')).toBe(true);
		expect(content).toContain('# Missing Metadata Note');
	});

	it('edits a note larger than 100KB without touching the body', async () => {
		const file = fileAt(app, 'Problem Notes/very-long-note.md');
		const before = app.vault.peek(file.path) ?? '';
		expect(before.length).toBeGreaterThan(100_000);

		await service.setStatus(file, 'processed');

		const after = app.vault.peek(file.path) ?? '';
		expect(after).toContain('# Very Long Note');
		expect(after).toContain('status: processed');
		expect(after.length).toBeGreaterThan(100_000);
		expect(after.slice(-200)).toBe(before.slice(-200));
	});
});

describe('a vault with a single, freshly created note', () => {
	it('reads and writes a note created after the vault was empty', async () => {
		const app = buildVault([]);
		const service = new MetadataService(asApp(app), new Logger('silent'));
		expect(app.vault.getMarkdownFiles()).toHaveLength(0);

		const created: TFile = await app.vault.create('only.md', '# Only note\n');
		const file = asFile(created);
		await service.setType(file, 'capture');
		await service.addTag(file, 'inbox');

		expect(service.readFrontmatter(file)).toEqual({ type: 'capture', tags: ['inbox'] });
		expect(app.vault.peek('only.md')).toContain('# Only note');
	});
});
