import fsPromises, { type FileHandle } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IoPool } from "../src/io-pool.js";
import { captureManifestViews, captureManifest, DEFAULT_SCAN_TIMEOUT_MS, normalizeScanOptions, validScanTimeoutMs } from "../src/manifest.js";
import { fixtureTest, put } from "./support.js";

afterEach(() => { vi.restoreAllMocks(); syncBuiltinESMExports(); });
function interceptOpen(hook: (handle: FileHandle, path: string) => void): void {
  const original = fsPromises.open;
  vi.spyOn(fsPromises, "open").mockImplementation(async (...args) => {
    const handle = await original(...args); hook(handle, String(args[0])); return handle;
  });
  syncBuiltinESMExports();
}
function readHook(handle: FileHandle, hook: (bytes: number) => Promise<void> | void, eof = false): void {
  const original = handle.read.bind(handle);
  Object.defineProperty(handle, "read", { value: async (...args: Parameters<typeof original>) => {
    const result = await original(...args); await hook(result.bytesRead);
    return eof ? { ...result, bytesRead: 0 } : result;
  } });
}
describe("bounded manifest scans", () => {
  it.each([0, -1, 1.5, 3_600_001, NaN, Infinity, null, "30000"])("rejects invalid budget %s", value => {
    expect(validScanTimeoutMs(value)).toBe(false);
    expect(() => normalizeScanOptions({ timeoutMs: value as number })).toThrow("Invalid Twin scan timeout");
  });
  it("retains the 30-second default and freezes normalized scalar policy", () => {
    const options = { timeoutMs: 123 };
    const policy = normalizeScanOptions(options); options.timeoutMs = 456;
    expect(policy.timeoutMs).toBe(123); expect(Object.isFrozen(policy)).toBe(true);
    expect(normalizeScanOptions({}).timeoutMs).toBe(DEFAULT_SCAN_TIMEOUT_MS);
  });
  it.each(["timeout", "cancel"])("does not complete after the final empty readdir: %s", async kind => fixtureTest(async f => {
    let clock = 0; const controller = new AbortController();
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    const original = fsPromises.readdir;
    vi.spyOn(fsPromises, "readdir").mockImplementation(async (...args) => {
      const result = await original(...args); if (kind === "timeout") clock = 10; else controller.abort(); return result;
    }); syncBuiltinESMExports();
    const result = await captureManifest(f.source, true, { timeoutMs: 10, signal: controller.signal });
    expect(result.coverage).toBe("partial"); expect(result.issues).toEqual([{ reason: kind === "timeout" ? "scan-timeout" : "scan-cancelled" }]);
  }));
  it.each(["timeout", "cancel", "mutation-timeout"])("closes an interrupted read without inventing metadata changes: %s", async kind => fixtureTest(async f => {
    await put(f.source, "file", "unchanged"); let clock = 0; const controller = new AbortController(); let closes = 0;
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    interceptOpen(handle => {
      const close = handle.close.bind(handle);
      Object.defineProperty(handle, "close", { value: async () => { closes++; await close(); } });
      readHook(handle, async () => {
        if (kind === "mutation-timeout") await fsPromises.writeFile(join(f.source, "file"), "changed and longer");
        if (kind === "cancel") controller.abort(); else clock = 10;
      });
    });
    const result = await captureManifest(f.source, false, { timeoutMs: 10, signal: controller.signal });
    expect(result.coverage).toBe("partial"); expect(result.entries.size).toBe(0); expect(closes).toBe(1);
    expect(result.issues.filter(x => x.reason === (kind === "cancel" ? "scan-cancelled" : "scan-timeout"))).toHaveLength(1);
    expect(result.issues.some(x => x.reason === "entry-changed-during-scan")).toBe(kind === "mutation-timeout");
    expect(result.issues.some(x => x.reason === "file-read-incomplete")).toBe(false);
  }));
  it("reports stable short EOF as an unfinished read, with no digest", async () => fixtureTest(async f => {
    await put(f.source, "file", "unchanged");
    interceptOpen(handle => readHook(handle, () => {}, true));
    const result = await captureManifest(f.source);
    expect(result.coverage).toBe("partial"); expect(result.entries.size).toBe(0);
    expect(result.issues).toEqual([{ reason: "file-read-incomplete", path: { encoding: "utf8", value: "file" } }]);
  }));
  it.each(["timeout", "cancel"])("checks the final descriptor close: %s", async kind => fixtureTest(async f => {
    await put(f.source, "file", "unchanged"); let clock = 0; const controller = new AbortController();
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    interceptOpen(handle => {
      const close = handle.close.bind(handle);
      Object.defineProperty(handle, "close", { value: async () => { await close(); if (kind === "timeout") clock = 10; else controller.abort(); } });
    });
    const result = await captureManifest(f.source, true, { timeoutMs: 10, signal: controller.signal });
    expect(result.coverage).toBe("partial"); expect(result.entries.size).toBe(0);
    expect(result.issues.map(x => x.reason)).toEqual([kind === "timeout" ? "scan-timeout" : "scan-cancelled"]);
  }));
  it("uses a fresh monotonic deadline on every invocation, independently of wall time", async () => fixtureTest(async f => {
    await put(f.source, "file", "unchanged"); let clock = 0;
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    vi.spyOn(Date, "now").mockImplementation(() => 10 ** 15);
    const original = fsPromises.readdir;
    vi.spyOn(fsPromises, "readdir").mockImplementation(async (...args) => { const result = await original(...args); clock += 6; return result; }); syncBuiltinESMExports();
    expect((await captureManifest(f.source, true, { timeoutMs: 10 })).coverage).toBe("complete");
    expect((await captureManifest(f.source, true, { timeoutMs: 10 })).coverage).toBe("complete");
  }));
  it("pre-aborted scans perform no filesystem observations", async () => {
    const controller = new AbortController(); controller.abort(); const calls = vi.spyOn(fsPromises, "readdir"); syncBuiltinESMExports();
    const result = await captureManifest("/unused", false, { signal: controller.signal });
    expect(result.issues).toEqual([{ reason: "scan-cancelled" }]); expect(calls).not.toHaveBeenCalled();
  });
});

it("preserves unavailable coverage while appending a late cancellation reason", async () => fixtureTest(async f => {
  const controller = new AbortController();
  const readdir = vi.spyOn(fsPromises, "readdir").mockImplementation(async () => {
    return [{ get name(): Buffer { controller.abort(); throw new Error("broken native result"); } }] as unknown as Awaited<ReturnType<typeof fsPromises.readdir>>;
  }); syncBuiltinESMExports();
  try {
    const result = await captureManifest(f.source, false, { signal: controller.signal });
    expect(result.coverage).toBe("unavailable");
    expect(result.issues.map(x => x.reason)).toEqual(["scan-unavailable", "scan-cancelled"]);
  } finally { readdir.mockRestore(); syncBuiltinESMExports(); }
}));

it("never hashes a read prefix when the read exceeds the hash budget", async () => fixtureTest(async f => {
  await put(f.source, "file", "stable");
  interceptOpen(handle => {
    const original = handle.read.bind(handle);
    Object.defineProperty(handle, "read", { value: async (...args: Parameters<typeof original>) => {
      const result = await original(...args); return { ...result, bytesRead: 2 * 1024 * 1024 * 1024 + 1 };
    } });
  });
  const result = await captureManifest(f.source);
  expect(result.coverage).toBe("partial"); expect(result.entries.size).toBe(0);
  expect(result.issues).toEqual([{ reason: "hash-limit", path: { encoding: "utf8", value: "file" } }]);
}));

it("projects fresh raw modes, ordinary/Git directories and identical incomplete coverage", async () => fixtureTest(async f => {
  await put(f.source, "file", "bytes", 0o6751); await fsPromises.mkdir(join(f.source, "ordinary")); await fsPromises.chmod(join(f.source, "ordinary"), 0o2755);
  await fsPromises.mkdir(join(f.source, ".git"));
  const invalidGit = Buffer.concat([Buffer.from(join(f.source, ".git") + "/"), Buffer.from([255])]); await fsPromises.mkdir(invalidGit);
  try {
  const views = await captureManifestViews(f.source);
  const key = Buffer.from("file").toString("base64"), dir = Buffer.from("ordinary").toString("base64");
  expect(views.raw.entries.get(key)?.mode).toBe(0o6751); expect(views.receipt.entries.get(key)?.mode).toBe(0o6751); expect(views.apply.entries.get(key)?.mode).toBe(0o751);
  expect(views.receipt.entries.has(dir)).toBe(false); expect(views.apply.entries.get(dir)?.mode).toBe(0o755);
  expect([...views.receipt.entries.values()].filter(x => x.kind === "directory")).toHaveLength(2);
  expect(views.receipt).toEqual(await captureManifest(f.source)); expect(views.apply).toEqual(await captureManifest(f.source, true));
  const controller = new AbortController(); controller.abort(); const partial = await captureManifestViews(f.source, { signal: controller.signal });
  expect(partial.raw.coverage).toBe("partial"); expect(partial.receipt.issues).toEqual(partial.raw.issues); expect(partial.apply.issues).toEqual(partial.raw.issues);
  } finally { await fsPromises.rmdir(invalidGit); }
}));
it("commits identical static output with one, two and four workers despite delayed reads", async () => fixtureTest(async f => {
  for (let i = 0; i < 24; i++) await put(f.source, `file-${String(i).padStart(2, "0")}`, `bytes-${i}`);
  const serial = await captureManifestViews(f.source, { pool: new IoPool(1) });
  for (const workers of [2, 4]) expect(await captureManifestViews(f.source, { pool: new IoPool(workers) })).toEqual(serial);
}));

it("drains an out-of-order slow descriptor before returning cancellation and admits no new readers", async () => fixtureTest(async f => {
  for (let i = 0; i < 24; i++) await put(f.source, `f${String(i).padStart(2, "0")}`, "bytes");
  const controller = new AbortController(), pool = new IoPool();
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void; const ready = new Promise<void>(resolve => { entered = resolve; });
  let opened = 0, closed = 0, finished = false;
  interceptOpen((handle, path) => {
    opened++; const close = handle.close.bind(handle);
    Object.defineProperty(handle, "close", { value: async () => { await close(); closed++; } });
    if (path.endsWith("/f00")) readHook(handle, async () => { entered(); await gate; });
  });
  const pending = captureManifestViews(f.source, { pool, signal: controller.signal }).finally(() => { finished = true; });
  try {
    await ready; controller.abort(); await new Promise<void>(resolve => setTimeout(resolve, 20));
    expect(finished).toBe(false); const admissions = opened;
    release(); const result = await pending;
    expect(opened).toBe(admissions); expect(closed).toBe(opened); expect(result.raw.coverage).toBe("partial");
    expect(result.raw.issues.filter(x => x.reason === "scan-cancelled")).toHaveLength(1);
    expect(result.raw.entries.has(Buffer.from("f00").toString("base64"))).toBe(false);
    expect(pool.inspect()).toMatchObject({ active: 0, queued: 0, waiters: 0 });
  } finally { release(); await pending; }
}));

it("resolves stalled, failed reservations before admitting a later hash without holding a permit", async () => fixtureTest(async f => {
  for (const name of ["a", "b", "c"]) await put(f.source, name, "small");
  const fake = (stat: import("node:fs").BigIntStats): import("node:fs").BigIntStats => Object.defineProperty(Object.create(stat) as import("node:fs").BigIntStats, "size", { value: 1024n * 1024n * 1024n });
  const real = fsPromises.lstat;
  const stats = vi.spyOn(fsPromises, "lstat").mockImplementation(async (...args) => {
    const result = await real(...args); return String(args[0]).startsWith(f.source + "/") && result.isFile() ? fake(result as import("node:fs").BigIntStats) : result;
  }); syncBuiltinESMExports();
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void; const ready = new Promise<void>(resolve => { entered = resolve; });
  const opened: string[] = []; let closed = 0; const pool = new IoPool();
  interceptOpen((handle, path) => {
    opened.push(path); const stat = handle.stat.bind(handle), close = handle.close.bind(handle);
    Object.defineProperty(handle, "stat", { value: async (...args: Parameters<typeof stat>) => fake(await stat(...args) as import("node:fs").BigIntStats) });
    Object.defineProperty(handle, "close", { value: async () => { await close(); closed++; } });
    if (path.endsWith("/a")) readHook(handle, async () => { entered(); await gate; });
  });
  const pending = captureManifestViews(f.source, { pool });
  try {
    await ready; await new Promise<void>(resolve => setTimeout(resolve, 20));
    expect(opened).not.toContain(join(f.source, "c")); expect(pool.inspect().active).toBeLessThanOrEqual(2);
    release(); const result = await pending;
    expect(opened).toHaveLength(3); expect(closed).toBe(3); expect(result.raw.entries.size).toBe(0);
    expect(result.raw.issues.map(x => x.reason)).toEqual(["file-read-incomplete", "file-read-incomplete", "file-read-incomplete"]);
    expect(pool.inspect()).toMatchObject({ active: 0, queued: 0, waiters: 0 });
  } finally { release(); await pending; stats.mockRestore(); syncBuiltinESMExports(); }
}));
it.each(["growth", "shrink"])("rejects %s without committing a hash prefix", async kind => fixtureTest(async f => {
  await put(f.source, "file", "stable"); let changed = false;
  interceptOpen(handle => readHook(handle, async bytes => {
    if (!changed && bytes) { changed = true; await fsPromises.writeFile(join(f.source, "file"), kind === "growth" ? "longer contents" : "x"); }
  }));
  const result = await captureManifestViews(f.source);
  expect(result.raw.coverage).toBe("partial"); expect(result.raw.entries.size).toBe(0);
  expect(result.raw.issues).toEqual([expect.objectContaining({ reason: "entry-changed-during-scan" })]);
}));

it("keeps completed hash bytes charged when later reservations reach the exact cap", async () => fixtureTest(async f => {
  for (const name of ["a", "b", "c"]) await put(f.source, name, "small");
  // Synthetic byte counts exercise accounting without allocating/hashing 2 GiB.
  // This test does not certify byte digests for its mocked native read results.
  const size = (path: string): bigint => path.endsWith("/c") ? 1n : 1024n * 1024n * 1024n;
  const fake = (stat: import("node:fs").BigIntStats, path: string): import("node:fs").BigIntStats =>
    Object.defineProperty(Object.create(stat) as import("node:fs").BigIntStats, "size", { value: size(path) });
  const real = fsPromises.lstat;
  vi.spyOn(fsPromises, "lstat").mockImplementation(async (...args) => {
    const result = await real(...args), path = String(args[0]);
    return path.startsWith(f.source + "/") && result.isFile() ? fake(result as import("node:fs").BigIntStats, path) : result;
  }); syncBuiltinESMExports();
  const opened: string[] = []; let closed = 0;
  interceptOpen((handle, path) => {
    opened.push(path); const stat = handle.stat.bind(handle), close = handle.close.bind(handle);
    Object.defineProperty(handle, "stat", { value: async (...args: Parameters<typeof stat>) => fake(await stat(...args) as import("node:fs").BigIntStats, path) });
    let reads = 0;
    Object.defineProperty(handle, "read", { value: async (buffer: Buffer) => {
      buffer.fill(1); return { buffer, bytesRead: reads++ === 0 ? Number(size(path)) : 0 };
    } });
    Object.defineProperty(handle, "close", { value: async () => { await close(); closed++; } });
  });
  const result = await captureManifestViews(f.source);
  expect(opened.sort()).toEqual([join(f.source, "a"), join(f.source, "b")]); expect(closed).toBe(2);
  expect(result.raw.entries.size).toBe(2); expect(result.raw.coverage).toBe("partial");
  expect(result.raw.issues).toEqual([{ reason: "hash-limit", path: { encoding: "utf8", value: "c" } }]);
}));

it("isolates simultaneous growing and shrinking readers from stable worker results", async () => fixtureTest(async f => {
  for (let i = 0; i < 4; i++) await put(f.source, `f${i}`, "stable");
  let entered = 0, release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  let closed = 0; const pool = new IoPool();
  interceptOpen((handle, path) => {
    const close = handle.close.bind(handle); let first = true;
    Object.defineProperty(handle, "close", { value: async () => { await close(); closed++; } });
    readHook(handle, async () => {
      if (!first) return; first = false; if (++entered === 4) release(); await gate;
      if (path.endsWith("/f0")) await fsPromises.writeFile(path, "longer contents");
      if (path.endsWith("/f1")) await fsPromises.writeFile(path, "x");
    });
  });
  const result = await captureManifestViews(f.source, { pool });
  expect(closed).toBe(4); expect(result.raw.coverage).toBe("partial");
  expect([...result.raw.entries.values()].map(x => x.path)).toEqual([{ encoding: "utf8", value: "f2" }, { encoding: "utf8", value: "f3" }]);
  expect(result.raw.issues).toEqual([0, 1].map(i => ({ reason: "entry-changed-during-scan", path: { encoding: "utf8", value: `f${i}` } })));
  expect(pool.inspect()).toMatchObject({ active: 0, queued: 0, waiters: 0, peakActive: 4 });
}));
