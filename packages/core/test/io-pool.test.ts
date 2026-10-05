import { describe, expect, it } from "vitest";
import { IoOperation, IoPool, IO_QUEUE, IO_WINDOW } from "../src/io-pool.js";
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
const turn = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
describe("bounded ordered IO", () => {
  it("bounds active, queued and completed-but-uncommitted work behind a stalled oldest job", async () => {
    const pool = new IoPool(); const gate = deferred(); const output: number[] = []; let admitted = 0;
    const operation = new IoOperation<number>(pool, outcome => { if (outcome.ok) output.push(outcome.value); });
    const producer = (async () => { for (let i = 0; i < 1000; i++) { await operation.enqueue(async () => { if (i === 0) await gate.promise; return i; }); admitted++; } })();
    await turn(); await turn();
    expect(admitted).toBeLessThanOrEqual(IO_WINDOW); expect(operation.inspect().uncommitted).toBeLessThanOrEqual(IO_WINDOW);
    expect(output).toEqual([]); gate.resolve(); await producer; await operation.drain();
    expect(output).toEqual(Array.from({ length: 1000 }, (_, i) => i));
    expect(pool.inspect()).toMatchObject({ active: 0, queued: 0, waiters: 0 });
    expect(pool.inspect().peakActive).toBeLessThanOrEqual(4); expect(pool.inspect().peakQueued).toBeLessThanOrEqual(IO_QUEUE);
    expect(operation.inspect().peakWindow).toBe(IO_WINDOW);
  });
  it.each(["failure", "cancel"])("drains delayed workers and closes resources after %s", async kind => {
    const pool = new IoPool(), gate = deferred(), controller = new AbortController(); const failure = new Error(kind);
    let started = 0, closed = 0;
    const operation = new IoOperation<number>(pool, () => {}, () => { if (controller.signal.aborted) throw failure; });
    for (let i = 0; i < IO_WINDOW; i++) await operation.enqueue(async () => {
      started++; try { await gate.promise; if (kind === "failure" && i === 1) throw failure; return i; } finally { closed++; }
    });
    expect(pool.inspect()).toMatchObject({ active: 4, queued: 8 });
    if (kind === "cancel") controller.abort();
    let settled = false; const drain = operation.drain().finally(() => { settled = true; });
    const assertion = expect(drain).rejects.toBe(failure);
    await turn(); expect(settled).toBe(false); expect(closed).toBe(0);
    gate.resolve(); await assertion; expect(closed).toBe(started); expect(started).toBe(4);
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
