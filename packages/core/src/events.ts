/** The result of a change that a handler could cancel or defer. */
export type ChangeResult = boolean | Promise<boolean>;

/**
 * Sent before a change is applied. A handler can cancel it straight away with `preventDefault()`,
 * or pass a promise to `waitUntil()`, for example an async dialog. The change is then cancelled
 * if the promise resolves to `false`, and applied once all such promises have resolved otherwise.
 */
export class ChangingEvent<T> {
  readonly detail: T;
  #canceled = false;
  readonly #pending: Promise<unknown>[] = [];

  constructor(detail: T) {
    this.detail = detail;
  }

  get canceled(): boolean {
    return this.#canceled;
  }

  preventDefault(): void {
    this.#canceled = true;
  }

  waitUntil(decision: Promise<unknown>): void {
    this.#pending.push(decision);
  }

  /**
   * Applies the change once the handlers have decided. `apply` returns false if the change no
   * longer makes sense by then, such as when its row has gone. A rejected promise leaves the
   * change unapplied and rejects the returned promise.
   */
  settle(apply: () => boolean): ChangeResult {
    if (this.#canceled) return false;
    if (this.#pending.length === 0) return apply();
    return Promise.all(this.#pending).then((decisions) => {
      if (this.#canceled || decisions.some((decision) => decision === false)) return false;
      return apply();
    });
  }
}

/** A small typed event emitter. Every listener runs even if an earlier one throws. */
export class Emitter<Events extends object> {
  readonly #listeners = new Map<keyof Events, Set<(event: never) => void>>();

  on<K extends keyof Events>(type: K, listener: (event: Events[K]) => void): () => void {
    let set = this.#listeners.get(type);
    if (!set) {
      set = new Set();
      this.#listeners.set(type, set);
    }
    set.add(listener as (event: never) => void);
    return () => set.delete(listener as (event: never) => void);
  }

  has(type: keyof Events): boolean {
    return (this.#listeners.get(type)?.size ?? 0) > 0;
  }

  emit<K extends keyof Events>(type: K, event: Events[K]): void {
    const set = this.#listeners.get(type);
    if (!set) return;
    const errors: unknown[] = [];
    for (const listener of [...set]) {
      try {
        (listener as (event: Events[K]) => void)(event);
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, `${errors.length} listeners failed on "${String(type)}"`);
  }
}
