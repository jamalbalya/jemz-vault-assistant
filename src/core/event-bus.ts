/**
 * Typed in-process event bus.
 *
 * Views subscribe to state changes without holding references to the services that produce
 * them. Every `on` returns an unsubscribe function so callers can register it with
 * `Plugin.register` and leak nothing on unload.
 */

import type { JemzEventHandler, JemzEventMap, JemzEventName } from '../types/events';

export class EventBus {
	private readonly handlers = new Map<JemzEventName, Set<(payload: never) => void>>();

	/**
	 * Subscribe to an event.
	 *
	 * @returns A function that removes this subscription.
	 */
	on<K extends JemzEventName>(event: K, handler: JemzEventHandler<K>): () => void {
		let set = this.handlers.get(event);
		if (!set) {
			set = new Set();
			this.handlers.set(event, set);
		}
		set.add(handler);
		return () => this.off(event, handler);
	}

	/** Subscribe and automatically unsubscribe after the first delivery. */
	once<K extends JemzEventName>(event: K, handler: JemzEventHandler<K>): () => void {
		const unsubscribe = this.on(event, (payload) => {
			unsubscribe();
			handler(payload);
		});
		return unsubscribe;
	}

	/** Remove a subscription. */
	off<K extends JemzEventName>(event: K, handler: JemzEventHandler<K>): void {
		const set = this.handlers.get(event);
		if (!set) return;
		set.delete(handler);
		if (set.size === 0) this.handlers.delete(event);
	}

	/**
	 * Deliver an event to every subscriber.
	 *
	 * Handlers are copied before iteration so a handler may unsubscribe itself, and a
	 * throwing handler never prevents the others from running.
	 */
	emit<K extends JemzEventName>(event: K, payload: JemzEventMap[K]): void {
		const set = this.handlers.get(event);
		if (!set || set.size === 0) return;
		for (const handler of Array.from(set)) {
			try {
				(handler as JemzEventHandler<K>)(payload);
			} catch (error) {
				console.error(`[Jemz Vault Assistant] event handler for "${event}" threw`, error);
			}
		}
	}

	/** Number of subscribers for an event, used by tests and teardown assertions. */
	listenerCount(event: JemzEventName): number {
		return this.handlers.get(event)?.size ?? 0;
	}

	/** Drop every subscription. Called on plugin unload. */
	clear(): void {
		this.handlers.clear();
	}
}
