import fsPromises, { type FileHandle } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { captureManifest, DEFAULT_SCAN_TIMEOUT_MS, normalizeScanOptions, validScanTimeoutMs } from "../src/manifest.js";
import { fixtureTest, put } from "./support.js";

afterEach(() => { vi.restoreAllMocks(); syncBuiltinESMExports(); });
function interceptOpen(hook: (handle: FileHandle) => void): void {
  const original = fsPromises.open;
  vi.spyOn(fsPromises, "open").mockImplementation(async (...args) => {
    const handle = await original(...args); hook(handle); return handle;
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
    return { [Symbol.iterator](): Iterator<never> { controller.abort(); throw new Error("broken native result"); } } as unknown as Awaited<ReturnType<typeof fsPromises.readdir>>;
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
