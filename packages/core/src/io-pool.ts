import { performance } from "node:perf_hooks";
import { isPromise } from "node:util/types";
/** Private job coordinator. No worker may await another permit or descendant. */
export const IO_WORKERS = 4;
export const PREPARATION_LINK_WORKERS = 8;
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
    if (!Number.isInteger(workers) || workers < 1 || workers > PREPARATION_LINK_WORKERS) throw new Error("Invalid private IO worker count");
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
export interface IoOptions { readonly pool?: IoPool | undefined; readonly signal?: AbortSignal | undefined; readonly check?: (() => void) | undefined; readonly diagnostics?: Diagnostics | undefined; readonly diagnosticStage?: DiagnosticStage | undefined; readonly diagnosticRole?: DiagnosticRole | undefined }
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
  constructor(readonly pool: IoPool, readonly commit: (outcome: IoOutcome<T>) => void, readonly check: () => void = () => {}, readonly diagnostic?: DiagnosticSpan) {}
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
      const ticket = await measured(this.diagnostic, "queue", () => this.pool.admit(this, async () => {
        try { return await work(); } catch (error: unknown) { this.stop(error); throw error; }
      }, this.#check));
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
    await measured(this.diagnostic, "drain", async () => { while (this.#pending.length) await this.flushOne(); });
    if (this.#stopped) throw this.#error;
  }
}

/** Optional observations; never part of admission, validation or cancellation. */
export const DIAGNOSTIC_STAGES = ["inventory", "preparation", "preparation.allocate", "preparation.copy", "preparation.original", "preparation.copy-inventory", "preparation.links", "preparation.git", "preparation.watch", "preparation.dependencies", "execution.resolve", "execution.run", "execution.global-before", "execution.command", "after.inventory", "after.git", "after.watch", "after.dependencies", "after.global", "review", "apply", "apply.final-copy", "apply.current-original", "apply.original-before-write", "apply.copy-before-write", "apply.links", "apply.verify-copy", "apply.verify-original", "apply.transfer", "apply.affected", "apply.affected.preflight", "apply.affected.before-write", "apply.affected.final", "apply.affected.verify", "apply.affected.transfer", "apply.affected.cleanup", "discard", "preparation.cleanup", "links.source", "links.copy"] as const;
export type DiagnosticStage = typeof DIAGNOSTIC_STAGES[number];
export type DiagnosticRole = "source" | "copy" | "both" | "none";
export const DIAGNOSTIC_METRICS = ["enumeration", "metadata", "ancestors", "open", "close", "read", "write", "hash", "queue", "drain"] as const;
export type DiagnosticMetric = typeof DIAGNOSTIC_METRICS[number];
const issueReasons = ["scan-cancelled", "scan-timeout", "entry-unavailable", "entry-changed-during-scan", "depth-limit", "special-file", "no-follow-unavailable", "hash-limit", "file-read-incomplete", "directory-unavailable", "path-limit", "entry-limit", "scan-unavailable", "other"] as const;
export interface InventoryDiagnostic {
  readonly identity: number | null;
  readonly coverage: "complete" | "partial" | "unavailable" | "not-observed";
  readonly reasons: readonly { readonly reason: string; readonly count: number }[];
}
export interface DiagnosticEvent {
  readonly schema: 1;
  readonly sequence: number;
  readonly identity: number;
  readonly stage: DiagnosticStage;
  readonly role: DiagnosticRole;
  readonly kind: "begin" | "progress" | "end" | "inventory" | "drained" | "guard" | "summary";
  readonly elapsedMs: number;
  readonly outcome?: "complete" | "failed";
  readonly budgetMs?: number;
  readonly coverage?: InventoryDiagnostic["coverage"];
  readonly reasons?: InventoryDiagnostic["reasons"];
  readonly termination?: "none" | "cancelled" | "deadline";
  readonly entries?: number;
  readonly discovered?: number;
  readonly acceptedHashBytes?: number;
  readonly readBytes?: number;
  readonly omitted?: number;
  readonly metrics?: readonly { readonly name: DiagnosticMetric; readonly count: number; readonly elapsedMs: number; readonly inflight: number }[];
  readonly snapshots?: readonly { readonly name: "original-baseline" | "copy-baseline" | "settled-copy" | "fresh-copy" | "fresh-original"; readonly identity: number | null; readonly coverage: InventoryDiagnostic["coverage"]; readonly issueCount: number }[];
}
export type DiagnosticListener = (event: DiagnosticEvent) => void;
const intrinsicThen = Promise.prototype.then;
const cleanNumber = (value: number): number => Number.isFinite(value) ? Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Math.round(value * 1000) / 1000)) : 0;
interface DiagnosticSnapshot { readonly coverage: "complete" | "partial" | "unavailable"; readonly issues: readonly { readonly reason: string }[] }
export class Diagnostics {
  readonly #summaries = new WeakMap<object, InventoryDiagnostic>();
  #identity = 0; #sequence = 0; #bytes = 0; #omitted = 0; #active = 0; #delivering = false;
  #lastGuard: DiagnosticEvent["snapshots"];
  constructor(readonly listener: DiagnosticListener) {}
  static capture(options: { readonly onDiagnostic?: DiagnosticListener | undefined }): Diagnostics | undefined {
    try { const listener = options.onDiagnostic; return typeof listener === "function" ? new Diagnostics(listener) : undefined; } catch { return undefined; }
  }
  start(stage: DiagnosticStage, role: DiagnosticRole = "none"): DiagnosticSpan | undefined {
    if (this.#active >= 16) { this.#omitted++; return undefined; }
    this.#active++;
    return new DiagnosticSpan(this, ++this.#identity, DIAGNOSTIC_STAGES.includes(stage) ? stage : "inventory", role);
  }
  released(): void { this.#active--; }
  emit(event: Omit<DiagnosticEvent, "schema" | "sequence" | "omitted">): void {
    if (this.#delivering) { this.#omitted++; return; }
    try {
      const critical = event.kind !== "progress" && event.kind !== "begin";
      const detached = Object.freeze({ schema: 1 as const, sequence: this.#sequence + 1, omitted: this.#omitted, ...event });
      const bytes = Buffer.byteLength(JSON.stringify(detached));
      if (bytes > 4096 || (event.kind !== "guard" && event.kind !== "summary" && (this.#sequence >= (critical ? 1024 : 896) || this.#bytes + bytes > (critical ? 262144 : 196608)))) { this.#omitted++; return; }
      // Guard and terminal summary notifications are bounded snapshots, forwarded even
      // after ordinary observations stop. The CLI still caps persisted records.
      this.#sequence++; this.#bytes += bytes;
      let returned: unknown;
      this.#delivering = true;
      try { returned = this.listener(detached); } finally { this.#delivering = false; }
      if (isPromise(returned)) {
        try { void intrinsicThen.call(returned, () => undefined, () => undefined); } catch { /* Unsupported malicious promise species is not a sandbox boundary. */ }
      }
    } catch { /* Observations cannot affect safety/control flow. */ }
  }
  inventory(snapshot: DiagnosticSnapshot, span: DiagnosticSpan, data: { readonly budgetMs: number; readonly discovered: number; readonly acceptedHashBytes: number; readonly readBytes: number; readonly termination: "none" | "cancelled" | "deadline"; readonly entries: number }): void {
    const counts = new Map<string, number>();
    for (const issue of snapshot.issues) { const reason = issueReasons.includes(issue.reason as typeof issueReasons[number]) ? issue.reason : "other"; counts.set(reason, (counts.get(reason) ?? 0) + 1); }
    const reasons = Object.freeze([...counts].map(([reason, count]) => Object.freeze({ reason, count })));
    this.#summaries.set(snapshot, Object.freeze({ identity: span.identity, coverage: snapshot.coverage, reasons }));
    span.record("inventory", { ...data, coverage: snapshot.coverage, reasons });
  }
  project(raw: object, view: object): void { const summary = this.#summaries.get(raw); if (summary) this.#summaries.set(view, summary); }
  guard(stage: DiagnosticStage, snapshots: readonly (readonly [NonNullable<DiagnosticEvent["snapshots"]>[number]["name"], DiagnosticSnapshot | undefined])[]): void {
    if (this.#delivering) { this.#omitted++; return; }
    const span = this.start(stage, "both");
    if (!span) return;
    const detached = Object.freeze(snapshots.slice(0, 5).map(([name, snapshot]) => {
      const summary = snapshot ? this.#summaries.get(snapshot) : undefined;
      return Object.freeze({ name, identity: summary?.identity ?? null, coverage: snapshot?.coverage ?? "not-observed" as const, issueCount: snapshot?.issues.length ?? 0 });
    }));
    this.#lastGuard = detached;
    span.record("guard", { snapshots: detached }); span.end("complete");
  }
  checkpoint(stage: DiagnosticStage): void {
    this.emit({ identity: ++this.#identity, stage, role: "both", kind: "summary", elapsedMs: 0, ...(this.#lastGuard ? { snapshots: this.#lastGuard } : {}) });
  }
}
export class DiagnosticSpan {
  readonly #started = performance.now();
  readonly #metrics = new Map<DiagnosticMetric, { count: number; elapsedMs: number; inflight: number }>();
  readonly #timer: ReturnType<typeof setInterval>;
  #ended = false;
  constructor(readonly owner: Diagnostics, readonly identity: number, readonly stage: DiagnosticStage, readonly role: DiagnosticRole) {
    this.record("begin"); this.#timer = setInterval(() => this.record("progress"), 5000); this.#timer.unref();
  }
  record(kind: DiagnosticEvent["kind"], detail: Partial<Pick<DiagnosticEvent, "outcome" | "budgetMs" | "coverage" | "reasons" | "termination" | "entries" | "discovered" | "acceptedHashBytes" | "readBytes" | "snapshots">> = {}): void {
    if (this.#ended) return;
    this.owner.emit({ identity: this.identity, stage: this.stage, role: this.role, kind, elapsedMs: cleanNumber(performance.now() - this.#started),
      metrics: Object.freeze([...this.#metrics].map(([name, metric]) => Object.freeze({ name, count: metric.count, elapsedMs: cleanNumber(metric.elapsedMs), inflight: metric.inflight }))), ...detail });
  }
  async measure<T>(name: DiagnosticMetric, work: () => Promise<T>): Promise<T> {
    const metric = this.#metrics.get(name) ?? { count: 0, elapsedMs: 0, inflight: 0 }; this.#metrics.set(name, metric);
    metric.count++; metric.inflight++; const start = performance.now();
    try { return await work(); } finally { metric.inflight--; metric.elapsedMs += performance.now() - start; }
  }
  sync<T>(name: DiagnosticMetric, work: () => T): T {
    const metric = this.#metrics.get(name) ?? { count: 0, elapsedMs: 0, inflight: 0 }; this.#metrics.set(name, metric); metric.count++;
    const start = performance.now(); try { return work(); } finally { metric.elapsedMs += performance.now() - start; }
  }
  end(outcome: "complete" | "failed", drained = false): void {
    if (this.#ended) return;
    if (drained) this.record("drained"); this.record("end", { outcome });
    this.#ended = true; clearInterval(this.#timer); this.owner.released();
  }
}
export const measured = <T>(span: DiagnosticSpan | undefined, name: DiagnosticMetric, work: () => Promise<T>): Promise<T> => span ? span.measure(name, work) : work();
export async function diagnosticStage<T>(diagnostics: Diagnostics | undefined, stage: DiagnosticStage, work: () => Promise<T>, role: DiagnosticRole = "none"): Promise<T> {
  const span = diagnostics?.start(stage, role);
  try { const value = await work(); span?.end("complete"); return value; } catch (error: unknown) { span?.end("failed"); throw error; }
}
