/** Global test setup: install Obsidian's DOM helpers and reset shared state per test. */

import { afterEach, beforeEach } from 'vitest';
import { installObsidianDom } from './mocks/dom';
import { noticeLog, openModals } from './mocks/obsidian';

installObsidianDom(globalThis as unknown as Window & typeof globalThis);

beforeEach(() => {
	noticeLog.length = 0;
	openModals.length = 0;
	document.body.innerHTML = '';
});

afterEach(() => {
	// Close anything a test left open so modals never leak between cases.
	for (const modal of [...openModals]) modal.close();
	openModals.length = 0;
});
