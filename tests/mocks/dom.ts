/**
 * Obsidian's DOM prototype extensions.
 *
 * Obsidian augments `Node`, `Element` and `HTMLElement` with helpers like `createEl` and
 * `addClass`. Plugin UI code uses them everywhere, so the test environment installs
 * equivalents before any module under test runs.
 */

export interface DomElementInfo {
	cls?: string | string[];
	text?: string | DocumentFragment;
	attr?: Record<string, string | number | boolean | null>;
	title?: string;
	parent?: Node;
	value?: string;
	type?: string;
	placeholder?: string;
	href?: string;
	prepend?: boolean;
}

function applyInfo(el: HTMLElement, info?: DomElementInfo): void {
	if (!info) return;
	if (info.cls) {
		const classes = Array.isArray(info.cls) ? info.cls : info.cls.split(/\s+/);
		for (const cls of classes) if (cls.length > 0) el.classList.add(cls);
	}
	if (typeof info.text === 'string') el.textContent = info.text;
	else if (info.text) el.appendChild(info.text);
	if (info.attr) {
		for (const [key, value] of Object.entries(info.attr)) {
			if (value === null || value === false) continue;
			el.setAttribute(key, String(value));
		}
	}
	if (info.title !== undefined) el.setAttribute('title', info.title);
	if (info.value !== undefined) (el as HTMLInputElement).value = info.value;
	if (info.type !== undefined) el.setAttribute('type', info.type);
	if (info.placeholder !== undefined) el.setAttribute('placeholder', info.placeholder);
	if (info.href !== undefined) el.setAttribute('href', info.href);
}

function createElement(
	owner: Document,
	tag: string,
	info?: DomElementInfo,
	callback?: (el: HTMLElement) => void,
): HTMLElement {
	const el = owner.createElement(tag);
	applyInfo(el, info);
	callback?.(el);
	return el;
}

/** Install the helpers onto the given window's prototypes. Safe to call repeatedly. */
export function installObsidianDom(target: Window & typeof globalThis): void {
	const elementProto = target.HTMLElement.prototype as unknown as Record<string, unknown>;
	const nodeProto = target.Node.prototype as unknown as Record<string, unknown>;
	const documentProto = target.Document.prototype as unknown as Record<string, unknown>;
	const fragmentProto = target.DocumentFragment.prototype as unknown as Record<string, unknown>;

	if (elementProto.__jemzDomInstalled) return;
	elementProto.__jemzDomInstalled = true;

	function define(proto: Record<string, unknown>, name: string, value: unknown): void {
		Object.defineProperty(proto, name, {
			value,
			writable: true,
			configurable: true,
			enumerable: false,
		});
	}

	const createElOn = function (
		this: HTMLElement | DocumentFragment | Document,
		tag: string,
		info?: DomElementInfo,
		callback?: (el: HTMLElement) => void,
	): HTMLElement {
		const owner = (this as Node).ownerDocument ?? (this as Document);
		const el = createElement(owner, tag, info, callback);
		const parent = info?.parent ?? (this as Node);
		if (parent instanceof target.Document) parent.body.appendChild(el);
		else if (info?.prepend && (parent as Node).firstChild)
			(parent as Node).insertBefore(el, (parent as Node).firstChild);
		else (parent as Node).appendChild(el);
		return el;
	};

	for (const proto of [elementProto, fragmentProto, documentProto]) {
		define(proto, 'createEl', createElOn);
		define(
			proto,
			'createDiv',
			function (
				this: HTMLElement,
				info?: DomElementInfo | string,
				cb?: (el: HTMLElement) => void,
			) {
				const resolved = typeof info === 'string' ? { cls: info } : info;
				return createElOn.call(this, 'div', resolved, cb);
			},
		);
		define(
			proto,
			'createSpan',
			function (
				this: HTMLElement,
				info?: DomElementInfo | string,
				cb?: (el: HTMLElement) => void,
			) {
				const resolved = typeof info === 'string' ? { cls: info } : info;
				return createElOn.call(this, 'span', resolved, cb);
			},
		);
	}

	define(nodeProto, 'empty', function (this: Node) {
		while (this.firstChild) this.removeChild(this.firstChild);
		return this;
	});
	define(nodeProto, 'detach', function (this: Node) {
		this.parentNode?.removeChild(this);
		return this;
	});
	define(nodeProto, 'appendText', function (this: Node, text: string) {
		this.appendChild((this.ownerDocument ?? target.document).createTextNode(text));
		return this;
	});
	define(nodeProto, 'setText', function (this: Node, text: string | DocumentFragment) {
		if (typeof text === 'string') this.textContent = text;
		else {
			(this as unknown as { empty(): void }).empty();
			this.appendChild(text);
		}
		return this;
	});

	define(elementProto, 'addClass', function (this: HTMLElement, ...classes: string[]) {
		for (const cls of classes) if (cls) this.classList.add(cls);
		return this;
	});
	define(elementProto, 'addClasses', function (this: HTMLElement, classes: string[]) {
		for (const cls of classes) if (cls) this.classList.add(cls);
		return this;
	});
	define(elementProto, 'removeClass', function (this: HTMLElement, ...classes: string[]) {
		for (const cls of classes) if (cls) this.classList.remove(cls);
		return this;
	});
	define(elementProto, 'removeClasses', function (this: HTMLElement, classes: string[]) {
		for (const cls of classes) if (cls) this.classList.remove(cls);
		return this;
	});
	define(
		elementProto,
		'toggleClass',
		function (this: HTMLElement, classes: string | string[], value: boolean) {
			const list = Array.isArray(classes) ? classes : [classes];
			for (const cls of list) {
				if (!cls) continue;
				if (value) this.classList.add(cls);
				else this.classList.remove(cls);
			}
			return this;
		},
	);
	define(elementProto, 'hasClass', function (this: HTMLElement, cls: string) {
		return this.classList.contains(cls);
	});
	define(
		elementProto,
		'setAttr',
		function (this: HTMLElement, name: string, value: string | number | boolean | null) {
			if (value === null || value === false) this.removeAttribute(name);
			else this.setAttribute(name, String(value));
			return this;
		},
	);
	define(
		elementProto,
		'setAttrs',
		function (this: HTMLElement, attrs: Record<string, string | number | boolean | null>) {
			for (const [key, value] of Object.entries(attrs)) {
				if (value === null || value === false) this.removeAttribute(key);
				else this.setAttribute(key, String(value));
			}
			return this;
		},
	);
	define(elementProto, 'getAttr', function (this: HTMLElement, name: string) {
		return this.getAttribute(name);
	});
	define(elementProto, 'show', function (this: HTMLElement) {
		this.style.display = '';
		return this;
	});
	define(elementProto, 'hide', function (this: HTMLElement) {
		this.style.display = 'none';
		return this;
	});
	define(elementProto, 'toggle', function (this: HTMLElement, show: boolean) {
		this.style.display = show ? '' : 'none';
		return this;
	});
	define(elementProto, 'isShown', function (this: HTMLElement) {
		return this.style.display !== 'none';
	});
	define(elementProto, 'toggleVisibility', function (this: HTMLElement, visible: boolean) {
		this.style.visibility = visible ? '' : 'hidden';
		return this;
	});
	define(
		elementProto,
		'onClickEvent',
		function (this: HTMLElement, listener: (event: MouseEvent) => void) {
			this.addEventListener('click', listener as EventListener);
			return this;
		},
	);
	define(
		elementProto,
		'setCssStyles',
		function (this: HTMLElement, styles: Record<string, string>) {
			for (const [key, value] of Object.entries(styles)) {
				this.style.setProperty(
					key.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`),
					value,
				);
			}
			return this;
		},
	);
}
