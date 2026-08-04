/**
 * Quick Capture modal and its command wiring.
 *
 * Everything is driven through real DOM — real clicks, real keydowns, real input events — so
 * the tests fail if the markup the user actually interacts with regresses, not merely if an
 * internal method changes. The failure paths get the most attention: a capture that is lost
 * because the modal closed on an error is the worst bug this module can ship.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { App as ObsidianApp, Plugin as ObsidianPlugin } from 'obsidian';
import {
	App as MockApp,
	Plugin as MockPlugin,
	noticeLog,
	openModals,
	type PluginManifest,
} from '../../mocks/obsidian';
import { buildVault, type FixtureFile } from '../../helpers/vault-fixture';
import { COMMAND_IDS, PLUGIN_ID, PLUGIN_NAME } from '../../../src/core/constants';
import { Logger } from '../../../src/core/logger';
import { structuredCloneSafe } from '../../../src/core/settings';
import { STRINGS } from '../../../src/core/strings';
import { CaptureService } from '../../../src/services/capture-service';
import { TagService } from '../../../src/services/tag-service';
import { VaultIndex } from '../../../src/services/vault-index';
import type { CaptureResult } from '../../../src/types/note';
import { DEFAULT_SETTINGS, type JemzSettings } from '../../../src/types/settings';
import {
	openQuickCapture,
	registerCaptureCommands,
	type CaptureCommandDeps,
} from '../../../src/modules/capture/capture-commands';
import {
	MAX_TITLE_LENGTH,
	QuickCaptureModal,
} from '../../../src/modules/capture/quick-capture-modal';

/** The mock implements the slice of the API the modal uses, but is not the real class. */
function asApp(app: MockApp): ObsidianApp {
	return app as unknown as ObsidianApp;
}

function asPlugin(plugin: MockPlugin): ObsidianPlugin {
	return plugin as unknown as ObsidianPlugin;
}

const MANIFEST: PluginManifest = {
	id: PLUGIN_ID,
	name: PLUGIN_NAME,
	version: '1.0.0',
	minAppVersion: '1.4.0',
	description: 'test',
	author: 'test',
};

/** Fixed clock, so generated file names are deterministic. 2026-06-15 09:30 local. */
const NOW = new Date(2026, 5, 15, 9, 30, 0).getTime();
const TODAY = '2026-06-15';

/** A vault with an existing inbox, two project notes, and a few tags to autocomplete. */
function defaultFiles(): FixtureFile[] {
	return [
		{
			path: '00-Inbox/2026-06-01 capture - Existing.md',
			frontmatter: { created: '2026-06-01', type: 'capture', status: 'inbox' },
			content: 'Already here.\n',
		},
		{
			path: '01-Projects/Project Alpha.md',
			frontmatter: { type: 'project' },
			content: 'Alpha.\n',
		},
		{
			path: '01-Projects/Project Beta.md',
			frontmatter: { type: 'project' },
			content: 'Beta.\n',
		},
		{
			path: 'Notes/Reading list.md',
			frontmatter: { type: 'note', tags: ['reading', 'ideas'] },
			content: 'Books.\n',
		},
	];
}

interface Harness {
	readonly app: MockApp;
	readonly settings: JemzSettings;
	readonly deps: CaptureCommandDeps;
	readonly captured: CaptureResult[];
	/** Open the modal and return it. Call after mutating `settings`. */
	open(): QuickCaptureModal;
}

function createHarness(files: readonly FixtureFile[] = defaultFiles()): Harness {
	const app = buildVault(files);
	const settings = structuredCloneSafe(DEFAULT_SETTINGS);
	const logger = new Logger('silent');
	const index = new VaultIndex(asApp(app), logger);
	index.build();
	const tags = new TagService(asApp(app), index, logger);
	const capture = new CaptureService(
		asApp(app),
		() => settings,
		logger,
		() => NOW,
	);
	const captured: CaptureResult[] = [];

	const deps: CaptureCommandDeps = {
		app: asApp(app),
		capture,
		index,
		tags,
		logger,
		getSettings: () => settings,
		onCaptured: (result) => captured.push(result),
	};

	return {
		app,
		settings,
		deps,
		captured,
		open(): QuickCaptureModal {
			const modal = new QuickCaptureModal(deps);
			modal.open();
			return modal;
		},
	};
}

/* ------------------------------------------------------------------- helpers -- */

function $<T extends Element>(root: ParentNode, selector: string): T {
	const el = root.querySelector<T>(selector);
	if (!el) throw new Error(`No element matching "${selector}"`);
	return el;
}

function labels(root: ParentNode): string[] {
	return Array.from(root.querySelectorAll('.jva-field__label')).map((el) => el.textContent ?? '');
}

function clickButton(root: ParentNode, label: string): void {
	const button = Array.from(root.querySelectorAll<HTMLButtonElement>('.jva-button')).find(
		(candidate) => candidate.getAttribute('aria-label') === label,
	);
	if (!button) throw new Error(`No button labelled "${label}"`);
	button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

function setValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
	el.value = value;
	el.dispatchEvent(new Event('input', { bubbles: true }));
}

function select(el: HTMLSelectElement, value: string): void {
	el.value = value;
	el.dispatchEvent(new Event('change', { bubbles: true }));
}

function addTag(root: ParentNode, tag: string): void {
	const input = $<HTMLInputElement>(root, '.jva-tag-input__field');
	input.value = tag;
	input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
}

/** Let the submit chain (several awaits deep) settle. */
async function flush(): Promise<void> {
	for (let i = 0; i < 4; i++) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
}

function capturedPaths(app: MockApp): string[] {
	return app.vault
		.getFiles()
		.map((file) => file.path)
		.filter((path) => path.startsWith('00-Inbox/') && !path.includes('Existing'));
}

/* --------------------------------------------------------------------- render -- */

describe('QuickCaptureModal rendering', () => {
	let harness: Harness;

	beforeEach(() => {
		harness = createHarness();
	});

	it('renders every field from the wireframe, in order', () => {
		const modal = harness.open();
		const container = modal.contentEl;

		expect($(container, '.jva-modal__title').textContent).toBe(STRINGS.capture.modalTitle);
		expect(labels(container)).toEqual([
			STRINGS.capture.titleLabel,
			STRINGS.capture.bodyLabel,
			STRINGS.capture.tagsLabel,
			STRINGS.capture.typeLabel,
			STRINGS.capture.sourceLabel,
			STRINGS.capture.projectLabel,
		]);

		// Tags, type and source share one row on desktop, as the wireframe shows.
		const row = $(container, '.jva-row');
		expect(row.querySelectorAll('.jva-field')).toHaveLength(3);

		expect(container.querySelector('.jva-capture__title')).not.toBeNull();
		expect(container.querySelector('.jva-capture__body')).not.toBeNull();
		expect(container.querySelector('.jva-tag-input')).not.toBeNull();
		expect(container.querySelector('.jva-capture__type')).not.toBeNull();
		expect(container.querySelector('.jva-capture__source')).not.toBeNull();
		expect(container.querySelector('.jva-capture__project')).not.toBeNull();

		const footer = $(container, '.jva-modal__footer');
		expect(
			Array.from(footer.querySelectorAll('.jva-button')).map((el) =>
				el.getAttribute('aria-label'),
			),
		).toEqual([STRINGS.common.cancel, STRINGS.capture.submit]);
	});

	it('autofocuses the title input and caps it at 200 characters', () => {
		const modal = harness.open();
		const title = $<HTMLInputElement>(modal.contentEl, '.jva-capture__title');

		expect(document.activeElement).toBe(title);
		expect(title.getAttribute('maxlength')).toBe(String(MAX_TITLE_LENGTH));
		expect(MAX_TITLE_LENGTH).toBe(200);
	});

	it('binds every label to its control', () => {
		const modal = harness.open();
		for (const label of modal.contentEl.querySelectorAll('.jva-field__label')) {
			const id = label.getAttribute('for');
			expect(id).toBeTruthy();
			expect(modal.contentEl.querySelector(`#${id}`)).not.toBeNull();
		}
	});

	it('offers the capture note types with the configured default selected', () => {
		harness.settings.capture.defaultType = 'idea';
		const modal = harness.open();
		const type = $<HTMLSelectElement>(modal.contentEl, '.jva-capture__type');

		expect(Array.from(type.options).map((option) => option.value)).toEqual([
			'capture',
			'idea',
			'task',
			'reference',
			'meeting',
		]);
		expect(type.value).toBe('idea');
	});

	it('keeps a custom default type instead of silently capturing as something else', () => {
		harness.settings.capture.defaultType = 'sketch';
		const modal = harness.open();
		const type = $<HTMLSelectElement>(modal.contentEl, '.jva-capture__type');

		expect(Array.from(type.options).map((option) => option.value)).toContain('sketch');
		expect(type.value).toBe('sketch');
	});

	it('populates the project dropdown from notes with type project', () => {
		const modal = harness.open();
		const project = $<HTMLSelectElement>(modal.contentEl, '.jva-capture__project');

		expect(Array.from(project.options).map((option) => option.text)).toEqual([
			STRINGS.capture.projectNone,
			'Project Alpha',
			'Project Beta',
		]);
		expect(project.value).toBe('');
	});

	it('shows only the no-project option when the vault has no project notes', () => {
		const empty = createHarness([{ path: '00-Inbox/Seed.md', content: 'seed\n' }]);
		const modal = empty.open();
		const project = $<HTMLSelectElement>(modal.contentEl, '.jva-capture__project');

		expect(Array.from(project.options)).toHaveLength(1);
		expect(project.options[0]?.text).toBe(STRINGS.capture.projectNone);
	});

	it('seeds tag autocomplete from the tags already in the vault', () => {
		const modal = harness.open();
		const input = $<HTMLInputElement>(modal.contentEl, '.jva-tag-input__field');

		setValue(input, 'read');
		const suggestions = Array.from(
			modal.contentEl.querySelectorAll('.jva-tag-input__suggestion'),
		).map((el) => el.textContent);
		expect(suggestions).toContain('#reading');
	});
});

/* ----------------------------------------------------------------- validation -- */

describe('QuickCaptureModal source validation', () => {
	let harness: Harness;

	beforeEach(() => {
		harness = createHarness();
	});

	it('blocks submit and shows the error while the source is not a URL', async () => {
		const modal = harness.open();
		const container = modal.contentEl;
		const source = $<HTMLInputElement>(container, '.jva-capture__source');
		const sourceField = source.closest('.jva-field');

		setValue(source, 'not a url');

		expect(sourceField?.querySelector('.jva-field__error')?.textContent).toBe(
			STRINGS.capture.invalidUrl,
		);
		expect(source.getAttribute('aria-invalid')).toBe('true');
		expect($(container, '.jva-capture__submit').hasAttribute('disabled')).toBe(true);

		clickButton(container, STRINGS.capture.submit);
		await flush();

		expect(capturedPaths(harness.app)).toEqual([]);
		expect(noticeLog).toEqual([]);
		expect(openModals).toHaveLength(1);
	});

	it('clears the error once the source parses, and allows an empty source', () => {
		const modal = harness.open();
		const container = modal.contentEl;
		const source = $<HTMLInputElement>(container, '.jva-capture__source');

		setValue(source, 'nope');
		expect(container.querySelector('.jva-field__error')).not.toBeNull();

		setValue(source, 'https://example.com/docs');
		expect(container.querySelector('.jva-field__error')).toBeNull();
		expect($(container, '.jva-capture__submit').hasAttribute('disabled')).toBe(false);

		setValue(source, '');
		expect(container.querySelector('.jva-field__error')).toBeNull();
		expect($(container, '.jva-capture__submit').hasAttribute('disabled')).toBe(false);
	});
});

/* --------------------------------------------------------------------- submit -- */

describe('QuickCaptureModal submit', () => {
	let harness: Harness;

	beforeEach(() => {
		harness = createHarness();
	});

	it('captures with an empty title, generating an Untitled name', async () => {
		const modal = harness.open();
		clickButton(modal.contentEl, STRINGS.capture.submit);
		await flush();

		expect(capturedPaths(harness.app)).toEqual([
			`00-Inbox/${TODAY} capture - ${STRINGS.capture.untitledPrefix} ${TODAY} 09-30.md`,
		]);
		expect(noticeLog).toContain(STRINGS.capture.success);
		expect(openModals).toHaveLength(0);
		expect(harness.captured).toHaveLength(1);
	});

	it('writes the file into the inbox with the frontmatter contract', async () => {
		const modal = harness.open();
		const container = modal.contentEl;

		setValue($<HTMLInputElement>(container, '.jva-capture__title'), 'Read the docs');
		setValue($<HTMLTextAreaElement>(container, '.jva-capture__body'), 'Some **markdown**.');
		addTag(container, 'reading');
		select($<HTMLSelectElement>(container, '.jva-capture__type'), 'idea');
		setValue($<HTMLInputElement>(container, '.jva-capture__source'), 'https://example.com/x');
		select(
			$<HTMLSelectElement>(container, '.jva-capture__project'),
			'01-Projects/Project Alpha.md',
		);

		clickButton(container, STRINGS.capture.submit);
		await flush();

		const path = `00-Inbox/${TODAY} idea - Read the docs.md`;
		expect(capturedPaths(harness.app)).toEqual([path]);

		const content = harness.app.vault.peek(path) ?? '';
		expect(content).toContain(`created: ${TODAY}`);
		expect(content).toContain('type: idea');
		expect(content).toContain('status: inbox');
		expect(content).toContain('source: "https://example.com/x"');
		expect(content).toContain('tags:\n  - inbox\n  - reading');
		// The readable title is stored, not the path, so the value survives the note moving.
		expect(content).toContain('project: Project Alpha');
		expect(content).toContain('Some **markdown**.');

		expect(harness.captured[0]?.path).toBe(path);
	});

	it('submits on Cmd/Ctrl+Enter as well as the button', async () => {
		const modal = harness.open();
		const title = $<HTMLInputElement>(modal.contentEl, '.jva-capture__title');
		setValue(title, 'Keyboard capture');

		title.dispatchEvent(
			new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true }),
		);
		await flush();

		expect(capturedPaths(harness.app)).toEqual([
			`00-Inbox/${TODAY} capture - Keyboard capture.md`,
		]);
		expect(noticeLog).toContain(STRINGS.capture.success);
	});

	it('disables the button and shows a spinner while the write is in flight', () => {
		const modal = harness.open();
		const container = modal.contentEl;

		clickButton(container, STRINGS.capture.submit);

		const submit = $<HTMLButtonElement>(container, '.jva-capture__submit');
		expect(submit.hasAttribute('disabled')).toBe(true);
		expect(submit.querySelector('.jva-loading__spinner')).not.toBeNull();
	});

	it('cancels without writing anything', async () => {
		const modal = harness.open();
		setValue($<HTMLInputElement>(modal.contentEl, '.jva-capture__title'), 'Never saved');

		clickButton(modal.contentEl, STRINGS.common.cancel);
		await flush();

		expect(capturedPaths(harness.app)).toEqual([]);
		expect(openModals).toHaveLength(0);
		expect(harness.captured).toHaveLength(0);
	});
});

/* -------------------------------------------------------------------- failure -- */

describe('QuickCaptureModal failure handling', () => {
	it('keeps the modal open with the typed content when the vault is read-only', async () => {
		const harness = createHarness();
		const modal = harness.open();
		const container = modal.contentEl;

		setValue($<HTMLInputElement>(container, '.jva-capture__title'), 'Precious thought');
		setValue(
			$<HTMLTextAreaElement>(container, '.jva-capture__body'),
			'The body I do not want to retype.',
		);
		harness.app.vault.readOnly = true;

		clickButton(container, STRINGS.capture.submit);
		await flush();

		expect(noticeLog).toContain(STRINGS.capture.readOnly);
		expect(capturedPaths(harness.app)).toEqual([]);
		expect(harness.captured).toHaveLength(0);

		// The modal is still open and nothing the user typed was thrown away.
		expect(openModals).toHaveLength(1);
		expect($<HTMLInputElement>(container, '.jva-capture__title').value).toBe(
			'Precious thought',
		);
		expect($<HTMLTextAreaElement>(container, '.jva-capture__body').value).toBe(
			'The body I do not want to retype.',
		);

		// Failure state plus its recovery action: the reason stays on screen next to a Capture
		// button that works again.
		const footer = $(container, '.jva-modal__footer');
		expect(footer.querySelector('.jva-field__error')?.textContent).toBe(
			STRINGS.capture.readOnly,
		);
		const submit = $<HTMLButtonElement>(container, '.jva-capture__submit');
		expect(submit.hasAttribute('disabled')).toBe(false);
		expect(submit.querySelector('.jva-loading__spinner')).toBeNull();
	});

	it('retries successfully after the failure is fixed, clearing the banner', async () => {
		const harness = createHarness();
		const modal = harness.open();
		const container = modal.contentEl;
		setValue($<HTMLInputElement>(container, '.jva-capture__title'), 'Second attempt');

		harness.app.vault.readOnly = true;
		clickButton(container, STRINGS.capture.submit);
		await flush();
		expect(
			$(container, '.jva-modal__footer').querySelector('.jva-field__error'),
		).not.toBeNull();

		harness.app.vault.readOnly = false;
		clickButton(container, STRINGS.capture.submit);
		await flush();

		expect(capturedPaths(harness.app)).toEqual([
			`00-Inbox/${TODAY} capture - Second attempt.md`,
		]);
		expect(openModals).toHaveLength(0);
	});
});

/* ------------------------------------------------------- missing inbox folder -- */

describe('QuickCaptureModal inbox folder creation', () => {
	/** A vault where nothing lives in the configured inbox folder yet. */
	function withoutInbox(): Harness {
		return createHarness([{ path: 'Notes/Something.md', content: 'hi\n' }]);
	}

	function confirmDialog(): HTMLElement {
		return $<HTMLElement>(document.body, '.jva-confirm');
	}

	it('asks before creating the inbox folder, and writes nothing when declined', async () => {
		const harness = withoutInbox();
		const modal = harness.open();

		clickButton(modal.contentEl, STRINGS.capture.submit);
		await flush();

		const dialog = confirmDialog();
		expect(dialog.textContent).toContain(
			STRINGS.capture.folderMissingBody(harness.settings.capture.inboxFolder),
		);

		clickButton(dialog, STRINGS.common.cancel);
		await flush();

		expect(harness.app.vault.getFolderByPath('00-Inbox')).toBeNull();
		expect(capturedPaths(harness.app)).toEqual([]);
		// The capture is still recoverable: the modal stayed open and Capture works again.
		expect(openModals).toHaveLength(1);
		expect(
			$<HTMLButtonElement>(modal.contentEl, '.jva-capture__submit').hasAttribute('disabled'),
		).toBe(false);
	});

	it('creates the folder and captures once confirmed', async () => {
		const harness = withoutInbox();
		const modal = harness.open();

		clickButton(modal.contentEl, STRINGS.capture.submit);
		await flush();
		clickButton(confirmDialog(), STRINGS.common.create);
		await flush();

		expect(harness.app.vault.getFolderByPath('00-Inbox')).not.toBeNull();
		expect(capturedPaths(harness.app)).toHaveLength(1);
		expect(noticeLog).toContain(STRINGS.capture.success);
	});

	it('does not ask when the confirmation is turned off', async () => {
		const harness = withoutInbox();
		harness.settings.capture.confirmFolderCreation = false;
		const modal = harness.open();

		clickButton(modal.contentEl, STRINGS.capture.submit);
		await flush();

		expect(document.body.querySelector('.jva-confirm')).toBeNull();
		expect(capturedPaths(harness.app)).toHaveLength(1);
		expect(modal.contentEl.childElementCount).toBe(0);
	});
});

/* ------------------------------------------------------------------- teardown -- */

describe('QuickCaptureModal teardown', () => {
	it('removes every listener and empties the modal on close', async () => {
		const harness = createHarness();
		const modal = harness.open();
		const container = modal.contentEl;
		const source = $<HTMLInputElement>(container, '.jva-capture__source');

		modal.close();

		expect(container.childElementCount).toBe(0);
		expect(openModals).toHaveLength(0);

		// The chord that used to submit, and the input that used to validate, are both inert.
		container.dispatchEvent(
			new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true }),
		);
		setValue(source, 'still not a url');
		await flush();

		expect(capturedPaths(harness.app)).toEqual([]);
		expect(noticeLog).toEqual([]);
		expect(container.querySelector('.jva-field__error')).toBeNull();
	});

	it('can be reopened after closing without duplicating handlers', async () => {
		const harness = createHarness();
		const modal = harness.open();
		modal.close();

		modal.open();
		setValue($<HTMLInputElement>(modal.contentEl, '.jva-capture__title'), 'Reopened');
		modal.contentEl.dispatchEvent(
			new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }),
		);
		await flush();

		// Exactly one capture, not one per registration.
		expect(capturedPaths(harness.app)).toEqual([`00-Inbox/${TODAY} capture - Reopened.md`]);
		expect(noticeLog.filter((message) => message === STRINGS.capture.success)).toHaveLength(1);
	});
});

/* ------------------------------------------------------------------ commands -- */

describe('registerCaptureCommands', () => {
	function makePlugin(harness: Harness): MockPlugin {
		return new MockPlugin(harness.app, MANIFEST);
	}

	it('registers the quick capture command and opens the modal', async () => {
		const harness = createHarness();
		const plugin = makePlugin(harness);

		expect(registerCaptureCommands(asPlugin(plugin), harness.deps)).toBe(true);

		const command = plugin.commands.get(`${PLUGIN_ID}:${COMMAND_IDS.quickCapture}`);
		expect(command?.name).toBe(STRINGS.commands.quickCapture);

		await plugin.runCommand(COMMAND_IDS.quickCapture);
		expect(openModals).toHaveLength(1);
		expect(document.body.querySelector('.jva-capture .jva-modal__title')?.textContent).toBe(
			STRINGS.capture.modalTitle,
		);
	});

	it('registers nothing while the capture module is off', () => {
		const harness = createHarness();
		harness.settings.general.modules.capture = false;
		const plugin = makePlugin(harness);

		expect(registerCaptureCommands(asPlugin(plugin), harness.deps)).toBe(false);
		expect(plugin.commands.size).toBe(0);
	});
});

describe('openQuickCapture', () => {
	it('opens a modal the ribbon and status bar can share', async () => {
		const harness = createHarness();
		const modal = openQuickCapture(harness.deps);

		expect(openModals).toContain(modal);
		clickButton(modal.contentEl, STRINGS.capture.submit);
		await flush();

		expect(harness.captured).toHaveLength(1);
	});
});
