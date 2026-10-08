import { describe, expect, it } from "vitest";
import { IoOperation, IoPool, IO_QUEUE, IO_WINDOW, PREPARATION_LINK_WORKERS } from "../src/io-pool.js";
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
const turn = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
describe("bounded ordered IO", () => {
  it.each([4, PREPARATION_LINK_WORKERS])("bounds active, queued and completed-but-uncommitted work behind a stalled oldest job at %s workers", async workers => {
    const pool = new IoPool(workers); const gate = deferred(); const output: number[] = []; let admitted = 0;
    const operation = new IoOperation<number>(pool, outcome => { if (outcome.ok) output.push(outcome.value); });
    const producer = (async () => { for (let i = 0; i < 1000; i++) { await operation.enqueue(async () => { if (i === 0) await gate.promise; return i; }); admitted++; } })();
    await turn(); await turn();
    expect(admitted).toBeLessThanOrEqual(IO_WINDOW); expect(operation.inspect().uncommitted).toBeLessThanOrEqual(IO_WINDOW);
    expect(output).toEqual([]); gate.resolve(); await producer; await operation.drain();
    expect(output).toEqual(Array.from({ length: 1000 }, (_, i) => i));
    expect(pool.inspect()).toMatchObject({ active: 0, queued: 0, waiters: 0 });
    expect(pool.inspect().peakActive).toBeLessThanOrEqual(workers); expect(pool.inspect().peakQueued).toBeLessThanOrEqual(IO_QUEUE);
    expect(operation.inspect().peakWindow).toBe(IO_WINDOW);
  });
  it.each([4, PREPARATION_LINK_WORKERS].flatMap(workers => ["failure", "cancel"].map(kind => ({ workers, kind }))))("drains delayed workers and closes resources after $kind at $workers workers", async ({ workers, kind }) => {
    const pool = new IoPool(workers), gate = deferred(), controller = new AbortController(); const failure = new Error(kind);
    let started = 0, closed = 0;
    const operation = new IoOperation<number>(pool, () => {}, () => { if (controller.signal.aborted) throw failure; });
    for (let i = 0; i < IO_WINDOW; i++) await operation.enqueue(async () => {
      started++; try { await gate.promise; if (kind === "failure" && i === 1) throw failure; return i; } finally { closed++; }
    });
    expect(pool.inspect()).toMatchObject({ active: workers, queued: IO_WINDOW - workers });
    if (kind === "cancel") controller.abort();
    let settled = false; const drain = operation.drain().finally(() => { settled = true; });
    const assertion = expect(drain).rejects.toBe(failure);
    await turn(); expect(settled).toBe(false); expect(closed).toBe(0);
    gate.resolve(); await assertion; expect(closed).toBe(started); expect(started).toBe(workers);
    expect(pool.inspect()).toMatchObject({ active: 0, queued: 0, waiters: 0 });
  });
  it("shares a four-worker pool without poisoning another operation", async () => {
    const pool = new IoPool(), gate = deferred(), failure = new Error("first operation failed"); const values: number[] = [];
    const first = new IoOperation<number>(pool, () => {}), second = new IoOperation<number>(pool, r => { if (r.ok) values.push(r.value); });
    const produce = async (operation: IoOperation<number>) => { try { for (let i = 0; i < 24; i++) await operation.enqueue(async () => { await gate.promise; return i; }); } catch { /* first operation stops */ } };
    const producers = [produce(first), produce(second)]; await turn();
    expect(pool.inspect().active).toBe(4); expect(pool.inspect().queued).toBe(8); expect(pool.inspect().waiters).toBeLessThanOrEqual(2);
    first.stop(failure); gate.resolve(); await Promise.all(producers);
    await expect(first.drain()).rejects.toBe(failure); await second.drain();
    expect(values).toEqual(Array.from({ length: 24 }, (_, i) => i));
    expect(pool.inspect()).toMatchObject({ active: 0, queued: 0, waiters: 0 });
  });
});

describe("observational diagnostics", () => {
  it("contains throws, rejected native promises and hostile non-native thenables", async () => {
    const { Diagnostics } = await import("../src/io-pool.js");
    let getterReads = 0;
    const hostile = { get then(): never { getterReads++; throw new Error("must not inspect then"); } };
    for (const listener of [() => { throw new Error("observer failed"); }, () => Promise.reject(new Error("async observer failed")), () => hostile]) {
      const diagnostics = Diagnostics.capture({ onDiagnostic: listener });
      const span = diagnostics?.start("inventory");
      expect(await span?.measure("metadata", async () => "unchanged result")).toBe("unchanged result");
      span?.end("complete", true);
    }
    await turn(); expect(getterReads).toBe(0);
    expect(Diagnostics.capture({ get onDiagnostic(): never { throw new Error("getter failed"); } })).toBeUndefined();
  });
  it("freezes detached records, bounds output, and waits for delayed work before reporting drain", async () => {
    const { Diagnostics } = await import("../src/io-pool.js");
    const records: import("../src/io-pool.js").DiagnosticEvent[] = [];
    const diagnostics = new Diagnostics(event => { records.push(event); });
    const span = diagnostics.start("preparation.copy", "both")!;
    const gate = deferred(), pool = new IoPool();
    const operation = new IoOperation<number>(pool, () => {}, undefined, span);
    await operation.enqueue(() => span.measure("read", async () => { await gate.promise; return 1; }));
    const drain = operation.drain().then(() => span.end("complete", true));
    await turn(); expect(records.some(event => event.kind === "drained")).toBe(false);
    gate.resolve(); await drain;
    const terminal = records.find(event => event.kind === "drained")!;
    expect(terminal.metrics?.every(metric => metric.inflight === 0)).toBe(true);
    expect(Object.isFrozen(terminal)).toBe(true); expect(Object.isFrozen(terminal.metrics)).toBe(true);
    expect(() => Object.assign(terminal, { stage: "secret" })).toThrow();
    for (let i = 0; i < 2000; i++) diagnostics.start("inventory")?.end("complete", true);
    expect(records.length).toBeLessThanOrEqual(1024);
    expect(records.every(event => Buffer.byteLength(JSON.stringify(event)) <= 4096)).toBe(true);
    expect(records.reduce((sum, event) => sum + Buffer.byteLength(JSON.stringify(event)), 0)).toBeLessThanOrEqual(262144);
  });
});

it("forwards the latest five bounded guard dispositions after the ordinary observation cap", async () => {
  const { Diagnostics } = await import("../src/io-pool.js");
  const records: import("../src/io-pool.js").DiagnosticEvent[] = [];
  const diagnostics = new Diagnostics(event => { records.push(event); });
  for (let i = 0; i < 1200; i++) diagnostics.start("inventory")?.end("complete");
  const complete = { coverage: "complete" as const, issues: [] };
  diagnostics.guard("apply", [["original-baseline", complete], ["copy-baseline", complete], ["settled-copy", complete], ["fresh-copy", complete], ["fresh-original", complete]]);
  const partial = { coverage: "partial" as const, issues: [{ reason: "scan-cancelled" }] };
  diagnostics.guard("apply", [["original-baseline", complete], ["copy-baseline", complete], ["settled-copy", complete], ["fresh-copy", partial], ["fresh-original", undefined]]);
  expect(records.at(-1)?.snapshots?.slice(3)).toEqual([
    { name: "fresh-copy", identity: null, coverage: "partial", issueCount: 1 },
    { name: "fresh-original", identity: null, coverage: "not-observed", issueCount: 0 },
  ]);
  expect(Buffer.byteLength(JSON.stringify(records.at(-1)))).toBeLessThanOrEqual(4096);
});


it("bounds the shared eight-worker queue across two operation windows", async () => {
  const pool = new IoPool(PREPARATION_LINK_WORKERS), gate = deferred();
  const operations = [new IoOperation<number>(pool, () => {}), new IoOperation<number>(pool, () => {})];
  const producers = operations.map(async operation => { for (let i = 0; i < 24; i++) await operation.enqueue(async () => { await gate.promise; return i; }); });
  try {
    await turn(); await turn();
    expect(pool.inspect()).toMatchObject({ active: 8, queued: 8 });
    expect(pool.inspect().waiters).toBeLessThanOrEqual(2);
    for (const operation of operations) expect(operation.inspect().uncommitted).toBeLessThanOrEqual(IO_WINDOW);
  } finally { gate.resolve(); await Promise.all(producers); await Promise.all(operations.map(operation => operation.drain())); }
  expect(pool.inspect()).toMatchObject({ active: 0, queued: 0, waiters: 0, peakActive: 8, peakQueued: 8 });
});

it("keeps the default at four and rejects invalid private profiles", () => {
  expect(new IoPool().workers).toBe(4);
  expect(new IoPool(PREPARATION_LINK_WORKERS).workers).toBe(8);
  for (const workers of [0, -1, 1.5, 9, Number.NaN, Number.POSITIVE_INFINITY]) expect(() => new IoPool(workers)).toThrow("Invalid private IO worker count");
});
