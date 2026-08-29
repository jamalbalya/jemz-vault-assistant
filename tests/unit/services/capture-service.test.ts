/**
 * Capture writes the only frontmatter in the plugin that is assembled as text rather than
 * handed to Obsidian's YAML writer, so the serialisation contract is what these tests are
 * about: every value that reaches the block came from a human typing into a form, and a
 * value that changes meaning when YAML reads it back produces a note the app cannot parse.
 *
 * That failure is quiet and permanent. Obsidian reports no properties at all for a note whose
 * block is broken, the health scan reports it as corrupted frontmatter, and
 * `MetadataService` then refuses to write to it — correctly, since repairing YAML is a manual
 * edit. So the capture that created it is the last chance to get it right.
 */

import { describe, expect, it } from 'vitest';
import type { App as ObsidianApp } from 'obsidian';
import { CaptureService } from '../../../src/services/capture-service';
import { Logger } from '../../../src/core/logger';
import { DEFAULT_SETTINGS, type JemzSettings } from '../../../src/types/settings';
import type { CaptureInput } from '../../../src/types/note';
import { splitFrontmatter } from '../../../src/utils/string';
import type { App } from '../../mocks/obsidian';
import { buildVault } from '../../helpers/vault-fixture';

const AT = new Date(2026, 5, 15, 9, 30, 0).getTime();

function serviceFor(overrides: (settings: JemzSettings) => void = () => undefined): {
	service: CaptureService;
	app: App;
} {
	const app = buildVault([{ path: '00-Inbox/.keep.md', content: 'x' }]);
	const settings = structuredClone(DEFAULT_SETTINGS);
	overrides(settings);
	const service = new CaptureService(
		app as unknown as ObsidianApp,
		() => settings,
		new Logger('silent'),
		() => AT,
	);
	return { service, app };
}

function input(overrides: Partial<CaptureInput> = {}): CaptureInput {
	return {
		title: 'A thought',
		body: 'Something worth keeping.',
		tags: [],
		type: 'capture',
		source: '',
		project: null,
		...overrides,
	};
}

/** The frontmatter block of a capture, as `key: value` lines. */
function frontmatterLines(content: string): string[] {
	const { raw, hasBlock } = splitFrontmatter(content);
	expect(hasBlock).toBe(true);
	return (raw ?? '').split('\n');
}

/** The single line introducing `key`. */
function lineFor(content: string, key: string): string {
	const line = frontmatterLines(content).find((entry) => entry.startsWith(`${key}:`));
	expect(line, `no "${key}" line in:\n${content}`).toBeDefined();
	return line as string;
}

describe('capture frontmatter, ordinary values', () => {
	it('writes the contract keys plainly', () => {
		const { service } = serviceFor();
		const content = service.buildContent(input(), AT);

		expect(lineFor(content, 'created')).toBe('created: 2026-06-15');
		expect(lineFor(content, 'type')).toBe('type: capture');
		expect(lineFor(content, 'status')).toBe('status: inbox');
		expect(content).toContain('  - inbox');
		expect(content).toContain('Something worth keeping.');
	});

	it('quotes a value holding a colon, so a URL source survives', () => {
		const { service } = serviceFor();
		const content = service.buildContent(input({ source: 'https://example.com/a' }), AT);

		expect(lineFor(content, 'source')).toBe('source: "https://example.com/a"');
	});

	it('writes an empty value as an empty string rather than a bare key', () => {
		const { service } = serviceFor();
		expect(lineFor(service.buildContent(input(), AT), 'source')).toBe('source: ""');
	});
});

describe('capture frontmatter, values that would change meaning', () => {
	// Each of these is what a person actually types, and each one parses as something other
	// than the text they typed — or does not parse at all.
	const hazards: { label: string; value: string }[] = [
		{ label: 'a flow sequence', value: '[1] Deep Work' },
		{ label: 'a comment', value: '#Roadmap' },
		{ label: 'a block sequence entry', value: '- a dash' },
		{ label: 'a flow mapping', value: '{draft}' },
		{ label: 'an anchor', value: '&anchor' },
		{ label: 'an alias', value: '*star' },
		{ label: 'a tag shorthand', value: '!important' },
		{ label: 'a block scalar', value: '| pipe' },
		{ label: 'a folded scalar', value: '> quote' },
		{ label: 'a directive', value: '%doc' },
		{ label: 'a single quote', value: "'quoted'" },
		{ label: 'a double quote', value: '"quoted"' },
		{ label: 'a question mark key', value: '? complex' },
		{ label: 'a trailing comment', value: 'note # not a comment' },
	];

	for (const { label, value } of hazards) {
		it(`quotes ${label}`, () => {
			const { service } = serviceFor();
			const line = lineFor(service.buildContent(input({ source: value }), AT), 'source');

			expect(line).toBe(`source: ${JSON.stringify(value)}`);
		});
	}

	it('quotes a reserved word so it stays text rather than becoming a boolean', () => {
		const { service } = serviceFor();
		for (const value of ['yes', 'No', 'true', 'off', 'null', '~']) {
			expect(lineFor(service.buildContent(input({ source: value }), AT), 'source')).toBe(
				`source: ${JSON.stringify(value)}`,
			);
		}
	});

	it('escapes a quote and a backslash inside a quoted value', () => {
		const { service } = serviceFor();
		const content = service.buildContent(input({ source: '[a] say "hi" \\ back' }), AT);

		expect(lineFor(content, 'source')).toBe('source: "[a] say \\"hi\\" \\\\ back"');
	});

	it('quotes a project note whose name opens a flow sequence', () => {
		const { service } = serviceFor();
		const content = service.buildContent(input({ project: '[Draft] Roadmap' }), AT);

		expect(lineFor(content, 'project')).toBe('project: "[Draft] Roadmap"');
	});

	it('quotes a template value whose padding would otherwise be lost', () => {
		// `source` is trimmed before it is serialised, but a template value is not — it is
		// written exactly as configured, and YAML strips the padding from a plain scalar.
		const { service } = serviceFor((settings) => {
			settings.capture.frontmatterTemplate = { indent: '  padded' };
		});

		expect(frontmatterLines(service.buildContent(input(), AT))).toContain('indent: "  padded"');
	});

	it('quotes a template key and value the user configured', () => {
		const { service } = serviceFor((settings) => {
			settings.capture.frontmatterTemplate = { 'odd: key': '#value' };
		});
		const content = service.buildContent(input(), AT);

		expect(frontmatterLines(content)).toContain('"odd: key": "#value"');
	});

	it('quotes a hazardous tag without touching an ordinary one', () => {
		const { service } = serviceFor((settings) => {
			settings.capture.defaultTags = ['inbox'];
		});
		const content = service.buildContent(input({ tags: ['*star'] }), AT);

		expect(content).toContain('  - inbox');
		expect(content).toContain('  - "*star"');
	});
});
