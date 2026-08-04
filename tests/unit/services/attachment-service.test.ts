/**
 * Attachment inventory and archiving.
 *
 * The counts asserted against the on-disk fixture (9 attachments, 3 used, 6 unused) are the
 * same ones the health scan and the manual checklist depend on, so a regression here shows up
 * as a wrong "unused attachments" figure in the UI.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { App as ObsidianApp, TFile as ObsidianTFile } from 'obsidian';
import type { App, TFile, TFolder } from '../../mocks/obsidian';
import { buildVault, loadVaultFromDisk, requireFile } from '../../helpers/vault-fixture';
import { Logger } from '../../../src/core/logger';
import { STRINGS } from '../../../src/core/strings';
import { VaultIndex } from '../../../src/services/vault-index';
import {
	AttachmentArchiveError,
	AttachmentService,
} from '../../../src/services/attachment-service';

/** Records what the service logged without printing anything during the run. */
class RecordingLogger extends Logger {
	readonly errors: string[] = [];

	constructor() {
		super('silent', 'test');
	}

	override error(message: string, ...details: unknown[]): void {
		this.errors.push(message);
		super.error(message, ...details);
	}
}

/**
 * The services are typed against the real Obsidian declarations, while the tests drive the
 * in-memory mock. The mock implements every member these code paths touch, so the cast is
 * the seam between the two type worlds rather than a shortcut around type safety.
 */
function asApp(app: App): ObsidianApp {
	return app as unknown as ObsidianApp;
}

function asFile(file: TFile): ObsidianTFile {
	return file as unknown as ObsidianTFile;
}

interface Harness {
	app: App;
	index: VaultIndex;
	logger: RecordingLogger;
	service: AttachmentService;
}

function harnessFor(app: App): Harness {
	const logger = new RecordingLogger();
	const index = new VaultIndex(asApp(app), logger);
	index.build();
	return { app, index, logger, service: new AttachmentService(asApp(app), index, logger) };
}

/** A small vault: one used image, one unused image, one unused PDF. */
function inlineHarness(): Harness {
	return harnessFor(
		buildVault([
			{
				path: 'notes/note-a.md',
				frontmatter: { type: 'note' },
				content: 'Look: ![[used.png]] and again [[used.png]]\n',
			},
			{ path: 'notes/note-b.md', content: 'No attachments here.\n' },
			{ path: 'assets/used.png', content: 'binary', size: 100 },
			{ path: 'assets/orphan.png', content: 'binary', size: 250 },
			{ path: 'assets/report.pdf', content: 'binary', size: 4000 },
		]),
	);
}

describe('AttachmentService.all', () => {
	it('returns every non-markdown file', () => {
		const { service } = inlineHarness();
		expect(
			service
				.all()
				.map((record) => record.path)
				.sort(),
		).toEqual(['assets/orphan.png', 'assets/report.pdf', 'assets/used.png']);
	});

	it('returns nothing for an empty vault', () => {
		const { service } = harnessFor(buildVault([]));
		expect(service.all()).toEqual([]);
	});

	it('returns nothing for a vault holding a single note', () => {
		const { service } = harnessFor(buildVault([{ path: 'only.md', content: 'hello' }]));
		expect(service.all()).toEqual([]);
	});

	it('includes files whose extension is not a known attachment type', () => {
		const { service } = harnessFor(
			buildVault([{ path: 'archive/notes.zip', content: 'binary', size: 12 }]),
		);
		expect(service.all().map((record) => record.path)).toEqual(['archive/notes.zip']);
	});

	it('handles unicode and special characters in file names', () => {
		const { service } = harnessFor(
			buildVault([
				{ path: 'notes/日本語.md', content: '![[画像 テスト.png]]' },
				{ path: 'assets/画像 テスト.png', content: 'binary', size: 10 },
				{ path: 'assets/weird @$% (v2).png', content: 'binary', size: 10 },
			]),
		);
		expect(
			service
				.all()
				.map((record) => record.path)
				.sort(),
		).toEqual(['assets/weird @$% (v2).png', 'assets/画像 テスト.png']);
	});

	it('counts the nine attachments in the on-disk fixture', () => {
		const { service } = harnessFor(loadVaultFromDisk());
		expect(service.all()).toHaveLength(9);
	});

	it('keeps index order rather than sorting, which only unused() promises', () => {
		const { service } = harnessFor(
			buildVault([
				{ path: 'z.png', content: 'binary' },
				{ path: 'a.png', content: 'binary' },
				{ path: 'm.png', content: 'binary' },
			]),
		);
		expect(service.all().map((record) => record.path)).toEqual(['z.png', 'a.png', 'm.png']);
	});

	it('returns a fresh array a caller cannot use to corrupt the index', () => {
		const { service } = inlineHarness();
		const first = service.all();
		first.length = 0;
		first.push({ ...({} as (typeof first)[number]), path: 'injected.png' });
		expect(
			service
				.all()
				.map((record) => record.path)
				.sort(),
		).toEqual(['assets/orphan.png', 'assets/report.pdf', 'assets/used.png']);
	});

	it('lists a very large attachment like any other', () => {
		const { service } = harnessFor(
			buildVault([{ path: 'assets/huge.bin', content: 'x'.repeat(120_000) }]),
		);
		const [record] = service.all();
		expect(record?.path).toBe('assets/huge.bin');
		expect(record?.size).toBe(120_000);
	});
});

describe('AttachmentService.usage', () => {
	it('maps each attachment to the notes referencing it', () => {
		const { service } = inlineHarness();
		expect(service.usage()).toEqual(
			new Map([
				['assets/used.png', ['notes/note-a.md']],
				['assets/orphan.png', []],
				['assets/report.pdf', []],
			]),
		);
	});

	it('lists a note once even when it references the same file repeatedly', () => {
		const { service } = inlineHarness();
		expect(service.usage().get('assets/used.png')).toEqual(['notes/note-a.md']);
	});

	it('sorts the referencing notes', () => {
		const { service } = harnessFor(
			buildVault([
				{ path: 'z-note.md', content: '![[shared.png]]' },
				{ path: 'a-note.md', content: '![[shared.png]]' },
				{ path: 'm-note.md', content: '![[shared.png]]' },
				{ path: 'shared.png', content: 'binary' },
			]),
		);
		expect(service.usage().get('shared.png')).toEqual(['a-note.md', 'm-note.md', 'z-note.md']);
	});

	it('counts references from folders a health scan would exclude', () => {
		const { service } = harnessFor(
			buildVault([
				{ path: '04-Archive/old note.md', content: 'Still needs ![[keep.png]]' },
				{ path: 'assets/keep.png', content: 'binary' },
			]),
		);
		expect(service.usage().get('assets/keep.png')).toEqual(['04-Archive/old note.md']);
	});

	it('resolves bare filenames, full paths and markdown embeds alike', () => {
		const { service } = harnessFor(
			buildVault([
				{ path: 'notes/bare.md', content: '![[one.png]]' },
				{ path: 'notes/full.md', content: '![[assets/two.png]]' },
				{ path: 'notes/markdown.md', content: '![Three](assets/three.png)' },
				{ path: 'assets/one.png', content: 'binary' },
				{ path: 'assets/two.png', content: 'binary' },
				{ path: 'assets/three.png', content: 'binary' },
			]),
		);
		const usage = service.usage();
		expect(usage.get('assets/one.png')).toEqual(['notes/bare.md']);
		expect(usage.get('assets/two.png')).toEqual(['notes/full.md']);
		expect(usage.get('assets/three.png')).toEqual(['notes/markdown.md']);
	});

	it('still counts references from a note whose frontmatter is corrupt', () => {
		const { service } = harnessFor(
			buildVault([
				{ path: 'broken.md', content: '---\ntype note\n---\n\n![[img.png]]\n' },
				{ path: 'img.png', content: 'binary' },
			]),
		);
		expect(service.usage().get('img.png')).toEqual(['broken.md']);
	});

	it('ignores links that point at notes rather than attachments', () => {
		const { service } = harnessFor(
			buildVault([
				{ path: 'a.md', content: '[[b]]' },
				{ path: 'b.md', content: 'target' },
			]),
		);
		expect(service.usage().size).toBe(0);
	});

	it('returns an empty map for an empty vault', () => {
		const { service } = harnessFor(buildVault([]));
		expect(service.usage().size).toBe(0);
	});

	it('builds a fresh map each call, so a caller mutating it cannot poison the next', () => {
		const { service } = inlineHarness();
		const first = service.usage();
		first.get('assets/orphan.png')?.push('notes/fabricated.md');
		first.delete('assets/report.pdf');

		const second = service.usage();
		expect(second.get('assets/orphan.png')).toEqual([]);
		expect(second.has('assets/report.pdf')).toBe(true);
		// The derived view must not inherit the poisoning either.
		expect(service.unused().map((record) => record.path)).toEqual([
			'assets/orphan.png',
			'assets/report.pdf',
		]);
	});

	it('never reads file contents, so an unreadable file changes nothing', async () => {
		const { app, service } = inlineHarness();
		const unreadable = async (file: TFile): Promise<string> => {
			throw new Error(`EIO: ${file.path}`);
		};
		app.vault.read = unreadable;
		app.vault.cachedRead = unreadable;

		expect(service.usage().get('assets/used.png')).toEqual(['notes/note-a.md']);
		expect(service.unused().map((record) => record.path)).toEqual([
			'assets/orphan.png',
			'assets/report.pdf',
		]);
		await expect(app.vault.read(requireFile(app, 'notes/note-a.md'))).rejects.toThrow('EIO');
	});

	it('reports the on-disk fixture usage, including an excluded archive folder', () => {
		const { service } = harnessFor(loadVaultFromDisk());
		const usage = service.usage();

		expect(usage.size).toBe(9);
		expect(usage.get('99-Attachments/images/used-image-1.png')).toEqual([
			'02-Areas/Health/Workout Log.md',
		]);
		expect(usage.get('99-Attachments/images/used-image-2.jpg')).toEqual([
			'02-Areas/Health/Meal Planning.md',
		]);
		expect(usage.get('99-Attachments/documents/used-document.pdf')).toEqual([
			'01-Projects/Project Alpha/Alpha - Requirements.md',
		]);
		expect(usage.get('99-Attachments/audio/unused-recording.mp3')).toEqual([]);
	});
});

describe('AttachmentService.unused', () => {
	it('returns the six unused fixture attachments sorted by path', () => {
		const { service } = harnessFor(loadVaultFromDisk());
		expect(service.unused().map((record) => record.path)).toEqual([
			'99-Attachments/audio/unused-recording.mp3',
			'99-Attachments/documents/unused-document.pdf',
			'99-Attachments/images/unused-image-1.png',
			'99-Attachments/images/unused-image-2.jpg',
			'99-Attachments/images/unused-image-3.png',
			'99-Attachments/images/unused-screenshot.png',
		]);
	});

	it('returns nothing when every attachment is referenced', () => {
		const { service } = harnessFor(
			buildVault([
				{ path: 'note.md', content: '![[a.png]] ![[b.png]]' },
				{ path: 'a.png', content: 'binary' },
				{ path: 'b.png', content: 'binary' },
			]),
		);
		expect(service.unused()).toEqual([]);
	});

	it('returns nothing for an empty vault', () => {
		const { service } = harnessFor(buildVault([]));
		expect(service.unused()).toEqual([]);
	});

	it('sorts unicode and special-character paths deterministically', () => {
		const { service } = harnessFor(
			buildVault([
				// Inserted in an order that is neither sorted nor reverse sorted, so a service
				// that forgot to sort cannot pass by accident.
				{ path: 'assets/画像 テスト.png', content: 'binary' },
				{ path: 'assets/weird @$% (v2).png', content: 'binary' },
				{ path: 'assets/plain.png', content: 'binary' },
			]),
		);
		// Pinned literally rather than compared against a sorted copy of the result: asserting
		// `paths === [...paths].sort(sameComparator)` only proves the output is ordered, not
		// that it holds the right paths.
		expect(service.unused().map((record) => record.path)).toEqual([
			'assets/plain.png',
			'assets/weird @$% (v2).png',
			'assets/画像 テスト.png',
		]);
	});

	it('does not hand out the index’s own array', () => {
		const { service } = harnessFor(
			buildVault([
				{ path: 'a.png', content: 'binary' },
				{ path: 'b.png', content: 'binary' },
			]),
		);
		service.unused().length = 0;
		expect(service.unused().map((record) => record.path)).toEqual(['a.png', 'b.png']);
	});
});

describe('AttachmentService.isUsed', () => {
	it('answers for referenced and unreferenced attachments', () => {
		const { service } = inlineHarness();
		expect(service.isUsed('assets/used.png')).toBe(true);
		expect(service.isUsed('assets/orphan.png')).toBe(false);
	});

	it('normalises the path before comparing', () => {
		const { service } = inlineHarness();
		expect(service.isUsed('/assets//used.png')).toBe(true);
	});

	it('returns false for an unknown or blank path', () => {
		const { service } = inlineHarness();
		expect(service.isUsed('assets/ghost.png')).toBe(false);
		expect(service.isUsed('')).toBe(false);
		expect(service.isUsed('/')).toBe(false);
	});

	it('does not let a file count as its own user', () => {
		const { service } = harnessFor(
			buildVault([{ path: 'self.md', content: 'points at [[self]]' }]),
		);
		expect(service.isUsed('self.md')).toBe(false);
	});

	it('answers for markdown notes too, since links are links', () => {
		const { service } = harnessFor(
			buildVault([
				{ path: 'a.md', content: '[[b]]' },
				{ path: 'b.md', content: 'target' },
			]),
		);
		expect(service.isUsed('b.md')).toBe(true);
		expect(service.isUsed('a.md')).toBe(false);
	});
});

describe('AttachmentService.totalSize', () => {
	it('sums the sizes of the given records', () => {
		const { service } = inlineHarness();
		expect(service.totalSize(service.all())).toBe(4350);
	});

	it('returns zero for an empty list', () => {
		const { service } = inlineHarness();
		expect(service.totalSize([])).toBe(0);
	});

	it('skips a record whose size is not a finite number', () => {
		const { service } = inlineHarness();
		const records = service.all().map((record) => ({ ...record, size: Number.NaN }));
		expect(service.totalSize(records)).toBe(0);
	});

	it('skips an infinite size instead of returning Infinity', () => {
		const { service } = inlineHarness();
		const [first, ...rest] = service.all();
		expect(first).toBeDefined();
		const records = [{ ...first!, size: Number.POSITIVE_INFINITY }, ...rest];
		// The finite records still count; only the broken stat is dropped.
		expect(service.totalSize(records)).toBe(4350 - first!.size);
		expect(Number.isFinite(service.totalSize(records))).toBe(true);
	});

	it('keeps counting the healthy records around a broken one', () => {
		const { service } = inlineHarness();
		const records = service
			.all()
			.map((record) =>
				record.path === 'assets/report.pdf' ? { ...record, size: Number.NaN } : record,
			);
		expect(service.totalSize(records)).toBe(350);
	});

	it('handles a file larger than 100 KB', () => {
		const { service } = harnessFor(
			buildVault([
				{ path: 'assets/huge.bin', content: 'x'.repeat(120_000) },
				{ path: 'assets/small.bin', content: 'x'.repeat(500) },
			]),
		);
		expect(service.totalSize(service.all())).toBe(120_500);
	});
});

describe('AttachmentService.archive', () => {
	const ARCHIVE = '04-Archive/attachments';
	let harness: Harness;

	beforeEach(() => {
		harness = inlineHarness();
	});

	it('creates the archive folder and moves the file into it', async () => {
		const { app, service } = harness;
		const file = requireFile(app, 'assets/orphan.png');

		const target = await service.archive(asFile(file), ARCHIVE);

		expect(target).toBe('04-Archive/attachments/orphan.png');
		expect(app.vault.getFolderByPath(ARCHIVE)).not.toBeNull();
		expect(app.vault.getFileByPath(target)).not.toBeNull();
		expect(app.vault.getFileByPath('assets/orphan.png')).toBeNull();
	});

	it('reuses an archive folder that already exists', async () => {
		const { app, service } = harness;
		await app.vault.createFolder(ARCHIVE);
		const file = requireFile(app, 'assets/report.pdf');

		expect(await service.archive(asFile(file), ARCHIVE)).toBe(
			'04-Archive/attachments/report.pdf',
		);
	});

	it('normalises a folder written with stray slashes', async () => {
		const { app, service } = harness;
		const file = requireFile(app, 'assets/report.pdf');

		expect(await service.archive(asFile(file), '/04-Archive//attachments/')).toBe(
			'04-Archive/attachments/report.pdf',
		);
	});

	it('resolves a name collision instead of overwriting', async () => {
		const { app, service } = harnessFor(
			buildVault([
				{ path: 'assets/logo.png', content: 'binary' },
				{ path: 'other/logo.png', content: 'binary' },
				{ path: '04-Archive/attachments/logo.png', content: 'binary' },
			]),
		);

		const first = await service.archive(asFile(requireFile(app, 'assets/logo.png')), ARCHIVE);
		const second = await service.archive(asFile(requireFile(app, 'other/logo.png')), ARCHIVE);

		expect(first).toBe('04-Archive/attachments/logo 2.png');
		expect(second).toBe('04-Archive/attachments/logo 3.png');
		expect(app.vault.getFileByPath('04-Archive/attachments/logo.png')).not.toBeNull();
	});

	it('is a no-op when the file already sits in the archive folder', async () => {
		const { app, service } = harnessFor(
			buildVault([{ path: '04-Archive/attachments/logo.png', content: 'binary' }]),
		);
		const before = app.vault.getFiles().length;

		const target = await service.archive(
			asFile(requireFile(app, '04-Archive/attachments/logo.png')),
			ARCHIVE,
		);

		expect(target).toBe('04-Archive/attachments/logo.png');
		expect(app.vault.getFiles()).toHaveLength(before);
		expect(app.vault.getFileByPath('04-Archive/attachments/logo 2.png')).toBeNull();
	});

	it('archives unicode and special-character file names', async () => {
		const { app, service } = harnessFor(
			buildVault([
				{ path: 'assets/画像 テスト.png', content: 'binary' },
				{ path: 'assets/weird @$% (v2).png', content: 'binary' },
			]),
		);

		expect(
			await service.archive(asFile(requireFile(app, 'assets/画像 テスト.png')), ARCHIVE),
		).toBe('04-Archive/attachments/画像 テスト.png');
		expect(
			await service.archive(asFile(requireFile(app, 'assets/weird @$% (v2).png')), ARCHIVE),
		).toBe('04-Archive/attachments/weird @$% (v2).png');
	});

	it('archives a file larger than 100 KB', async () => {
		const { app, service } = harnessFor(
			buildVault([{ path: 'assets/huge.bin', content: 'x'.repeat(120_000) }]),
		);

		expect(await service.archive(asFile(requireFile(app, 'assets/huge.bin')), ARCHIVE)).toBe(
			'04-Archive/attachments/huge.bin',
		);
	});

	it('rejects a blank destination folder without touching the vault', async () => {
		const { app, logger, service } = harness;
		const file = requireFile(app, 'assets/orphan.png');

		const error = await service.archive(asFile(file), '').catch((caught: unknown) => caught);

		expect(error).toBeInstanceOf(AttachmentArchiveError);
		expect((error as AttachmentArchiveError).message).toBe(STRINGS.errors.folderNotFound(''));
		expect((error as AttachmentArchiveError).path).toBe('assets/orphan.png');
		expect((error as AttachmentArchiveError).reason).toBeNull();
		expect(app.vault.getFileByPath('assets/orphan.png')).not.toBeNull();
		expect(logger.errors).toHaveLength(1);
	});

	it('rejects a whitespace-only destination folder', async () => {
		const { app, service } = harness;
		const file = requireFile(app, 'assets/orphan.png');

		await expect(service.archive(asFile(file), '   ')).rejects.toBeInstanceOf(
			AttachmentArchiveError,
		);
		expect(app.vault.getFileByPath('assets/orphan.png')).not.toBeNull();
	});

	it('rejects a destination that is missing from persisted settings', async () => {
		const { app, logger, service } = harness;
		const file = requireFile(app, 'assets/orphan.png');
		// `mergeDefaults` only skips `undefined`, so a hand-edited or half-migrated data.json
		// can put a null through the `string` type and reach the service.
		const error = await service
			.archive(asFile(file), null as unknown as string)
			.catch((caught: unknown) => caught);

		// Must be the typed error callers catch, not a bare TypeError from `.trim()`.
		expect(error).toBeInstanceOf(AttachmentArchiveError);
		expect((error as AttachmentArchiveError).message).toBe(STRINGS.errors.folderNotFound(''));
		expect((error as AttachmentArchiveError).path).toBe('assets/orphan.png');
		expect(app.vault.getFileByPath('assets/orphan.png')).not.toBeNull();
		expect(logger.errors).toHaveLength(1);
	});

	it('rejects when a file already occupies the archive folder path', async () => {
		const { app, service } = harnessFor(
			buildVault([
				{ path: 'assets/logo.png', content: 'binary' },
				{ path: '04-Archive/attachments', content: 'a file, not a folder' },
			]),
		);
		// Obsidian refuses to create a folder over an existing file; the in-memory vault keeps
		// files and folders in separate maps, so model the real failure here.
		app.vault.createFolder = async (path: string): Promise<TFolder> => {
			throw new Error(`File already exists: ${path}`);
		};

		const error = await service
			.archive(asFile(requireFile(app, 'assets/logo.png')), ARCHIVE)
			.catch((caught: unknown) => caught);

		// The guard is `instanceof TFolder`: a plain `!== null` existence check would treat the
		// occupying file as the archive folder and report a bogus success.
		expect(error).toBeInstanceOf(AttachmentArchiveError);
		expect((error as AttachmentArchiveError).message).toBe(
			STRINGS.errors.folderNotFound(ARCHIVE),
		);
		expect(app.vault.getFileByPath('assets/logo.png')).not.toBeNull();
		expect(app.vault.getFileByPath('04-Archive/attachments/logo.png')).toBeNull();
	});

	it('rejects when the file was deleted after the caller looked it up', async () => {
		const { app, logger, service } = harness;
		const file = requireFile(app, 'assets/orphan.png');
		// Someone else removed it — the plugin's own deletions go through the file manager.
		await app.vault.trash(file, false);

		const error = await service
			.archive(asFile(file), ARCHIVE)
			.catch((caught: unknown) => caught);

		expect(error).toBeInstanceOf(AttachmentArchiveError);
		expect((error as AttachmentArchiveError).message).toBe(
			STRINGS.errors.fileNotFound('assets/orphan.png'),
		);
		expect(logger.errors).toHaveLength(1);
	});

	it('reports a failed move on a read-only vault', async () => {
		const { app, logger, service } = harness;
		await app.vault.createFolder(ARCHIVE);
		const file = requireFile(app, 'assets/orphan.png');
		app.vault.readOnly = true;

		const error = await service
			.archive(asFile(file), ARCHIVE)
			.catch((caught: unknown) => caught);

		expect(error).toBeInstanceOf(AttachmentArchiveError);
		expect((error as AttachmentArchiveError).message).toBe(
			STRINGS.errors.writeFailed('04-Archive/attachments/orphan.png'),
		);
		expect((error as AttachmentArchiveError).reason).toBeInstanceOf(Error);
		expect(logger.errors).toHaveLength(1);
		expect(app.vault.getFileByPath('assets/orphan.png')).not.toBeNull();
	});

	it('reports a folder that cannot be created', async () => {
		const { app, logger, service } = harness;
		const file = requireFile(app, 'assets/orphan.png');
		app.vault.readOnly = true;

		const error = await service
			.archive(asFile(file), ARCHIVE)
			.catch((caught: unknown) => caught);

		expect(error).toBeInstanceOf(AttachmentArchiveError);
		expect((error as AttachmentArchiveError).message).toBe(
			STRINGS.errors.folderNotFound(ARCHIVE),
		);
		// The cause survives for the console rather than being swallowed by the retry check.
		expect((error as AttachmentArchiveError).reason).toBeInstanceOf(Error);
		expect((error as AttachmentArchiveError).path).toBe('assets/orphan.png');
		expect(logger.errors).toHaveLength(1);
		expect(app.vault.getFileByPath('assets/orphan.png')).not.toBeNull();
	});

	it('survives the folder being created concurrently', async () => {
		const { app, service } = harness;
		const create = app.vault.createFolder.bind(app.vault);
		app.vault.createFolder = async (path: string): Promise<TFolder> => {
			// Simulate sync (or a second archive) winning the race: the folder exists by the
			// time Obsidian raises "already exists".
			await create(path);
			throw new Error(`Folder already exists: ${path}`);
		};
		const file = requireFile(app, 'assets/orphan.png');

		expect(await service.archive(asFile(file), ARCHIVE)).toBe(
			'04-Archive/attachments/orphan.png',
		);
	});

	it('leaves the attachment usable by a rebuilt index after archiving', async () => {
		const { app, index, service } = harness;
		const file = requireFile(app, 'assets/used.png');
		const oldPath = 'assets/used.png';

		const target = await service.archive(asFile(file), ARCHIVE);
		index.renameFile(asFile(file), oldPath);

		expect(service.all().map((record) => record.path)).toContain(target);
		expect(service.isUsed(target)).toBe(true);
		expect(service.isUsed(oldPath)).toBe(false);
		expect(service.usage().get(target)).toEqual(['notes/note-a.md']);
	});
});
