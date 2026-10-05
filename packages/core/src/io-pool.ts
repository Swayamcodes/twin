/** Private job coordinator. No worker may await another permit or descendant. */
export const IO_WORKERS = 4;
export const IO_QUEUE = 8;
export const IO_WINDOW = 12;
export type IoOutcome<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown };
interface Ticket<T> { readonly result: Promise<IoOutcome<T>> }
interface Job { readonly execute: () => Promise<void> }
export class IoPool {
  readonly #queue: Job[] = [];
  readonly #waiters = new Map<object, () => void>();
  #active = 0;
  #peakActive = 0;
  #peakQueued = 0;
  constructor(readonly workers = IO_WORKERS) {
    if (!Number.isInteger(workers) || workers < 1 || workers > IO_WORKERS) throw new Error("Invalid private IO worker count");
  }
  inspect() { return Object.freeze({ active: this.#active, queued: this.#queue.length, waiters: this.#waiters.size,
    peakActive: this.#peakActive, peakQueued: this.#peakQueued }); }
  wake(): void { for (const wake of this.#waiters.values()) wake(); this.#waiters.clear(); }
  async admit<T>(owner: object, work: () => Promise<T>, check: () => void): Promise<Ticket<T>> {
    check();
    while (this.#active >= this.workers && this.#queue.length >= IO_QUEUE) {
      if (this.#waiters.has(owner)) throw new Error("Concurrent IO admission waiter");
      await new Promise<void>(resolve => this.#waiters.set(owner, resolve));
      check();
    }
    let resolve!: (outcome: IoOutcome<T>) => void;
    const result = new Promise<IoOutcome<T>>(done => { resolve = done; });
    const job: Job = { execute: async () => {
      try { check(); resolve({ ok: true, value: await work() }); }
      catch (error: unknown) { resolve({ ok: false, error }); }
    } };
    this.#queue.push(job);
    this.#pump();
    this.#peakQueued = Math.max(this.#peakQueued, this.#queue.length);
    return { result };
  }
  #pump(): void {
    while (this.#active < this.workers && this.#queue.length) {
      const job = this.#queue.shift()!;
      this.#active++; this.#peakActive = Math.max(this.#peakActive, this.#active);
      void job.execute().finally(() => { this.#active--; this.#pump(); this.wake(); });
    }
  }
}
export interface IoOptions { readonly pool?: IoPool | undefined; readonly signal?: AbortSignal | undefined; readonly check?: (() => void) | undefined }
export function checkIo(options: IoOptions): void {
  options.check?.();
  if (options.signal?.aborted) throw new Error("Scan cancelled");
}
/** One serial producer, bounded ordered commit (including completed results). */
export class IoOperation<T> {
  readonly #pending: Ticket<T>[] = [];
  #stopped = false;
  #error: unknown;
  #admitting = false;
  #peakWindow = 0;
  constructor(readonly pool: IoPool, readonly commit: (outcome: IoOutcome<T>) => void, readonly check: () => void = () => {}) {}
  inspect() { return Object.freeze({ uncommitted: this.#pending.length, peakWindow: this.#peakWindow, stopped: this.#stopped }); }
  stop(error: unknown): void { if (!this.#stopped) { this.#error = error; this.#stopped = true; this.pool.wake(); } }
  #check = (): void => {
    if (this.#stopped) throw this.#error;
    try { this.check(); } catch (error: unknown) { this.stop(error); throw error; }
  };
  async enqueue(work: () => Promise<T>): Promise<void> {
    if (this.#admitting) throw new Error("Concurrent operation producer");
    this.#admitting = true;
    try {
      this.#check();
      if (this.#pending.length >= IO_WINDOW) await this.flushOne();
      this.#check();
      const ticket = await this.pool.admit(this, async () => {
        try { return await work(); } catch (error: unknown) { this.stop(error); throw error; }
      }, this.#check);
      this.#pending.push(ticket); this.#peakWindow = Math.max(this.#peakWindow, this.#pending.length);
    } finally { this.#admitting = false; }
  }
  async flushOne(): Promise<void> {
    const ticket = this.#pending[0];
    if (!ticket) return;
    const outcome = await ticket.result;
    try { this.commit(outcome); } catch (error: unknown) { this.stop(error); }
    this.#pending.shift();
  }
  async drain(): Promise<void> {
    while (this.#pending.length) await this.flushOne();
    if (this.#stopped) throw this.#error;
  }
}
