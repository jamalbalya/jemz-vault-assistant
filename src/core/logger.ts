/**
 * Levelled console logger.
 *
 * Every catch block in the plugin logs here with full detail while showing the user a short
 * Notice, so failures are diagnosable without leaking stack traces into the UI.
 */

import type { LogLevel } from '../types/settings';
import { PLUGIN_NAME } from './constants';

const LEVEL_ORDER: Record<LogLevel, number> = {
	silent: 0,
	error: 1,
	warn: 2,
	info: 3,
	debug: 4,
};

export class Logger {
	private level: LogLevel;
	private readonly scope: string;

	constructor(level: LogLevel = 'warn', scope = PLUGIN_NAME) {
		this.level = level;
		this.scope = scope;
	}

	/** Change the active level, usually when settings load or change. */
	setLevel(level: LogLevel): void {
		this.level = level;
	}

	/** Current level. */
	getLevel(): LogLevel {
		return this.level;
	}

	/** A logger that prefixes messages with an extra component name. */
	child(scope: string): Logger {
		return new Logger(this.level, `${this.scope}:${scope}`);
	}

	private enabled(level: Exclude<LogLevel, 'silent'>): boolean {
		return LEVEL_ORDER[this.level] >= LEVEL_ORDER[level];
	}

	private prefix(): string {
		return `[${this.scope}]`;
	}

	debug(message: string, ...details: unknown[]): void {
		if (this.enabled('debug')) console.debug(this.prefix(), message, ...details);
	}

	info(message: string, ...details: unknown[]): void {
		if (this.enabled('info')) console.info(this.prefix(), message, ...details);
	}

	warn(message: string, ...details: unknown[]): void {
		if (this.enabled('warn')) console.warn(this.prefix(), message, ...details);
	}

	error(message: string, ...details: unknown[]): void {
		if (this.enabled('error')) console.error(this.prefix(), message, ...details);
	}
}

/** Normalise anything thrown into a readable message. */
export function errorMessage(error: unknown): string {
	if (error instanceof Error) return error.message;
	if (typeof error === 'string') return error;
	try {
		return JSON.stringify(error);
	} catch {
		return String(error);
	}
}
