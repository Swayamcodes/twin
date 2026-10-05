import fsPromises, { chmod, lstat, mkdir, readFile, readdir, rename, rmdir, symlink, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { fixtureTest, nodeOptions, put } from "./support.js";
import { allocateRoot, discardRoot } from "../src/safety.js";
import { copySource } from "../src/copy.js";

describe("guarded discard", () => {
  it("drains a delayed worker close after another copy worker fails before creation cleanup starts", async () => fixtureTest(async f => {
    await put(f.source, "a", "fail"); await put(f.source, "b", "delayed");
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let opened!: () => void;
    const secondOpened = new Promise<void>(resolve => { opened = resolve; });
    let closing = false, closed = false, finished = false;
    const firstFailure = new Error("deliberate copy read failure");
    const realOpen = fsPromises.open;
    const openSpy = vi.spyOn(fsPromises, "open").mockImplementation(async (...args) => {
      const handle = await realOpen(...args);
      if (args[0] === join(f.source, "a")) {
        vi.spyOn(handle, "read").mockImplementationOnce(async () => { await secondOpened; throw firstFailure; });
      }
      if (args[0] === join(f.source, "b")) {
        opened();
        const close = handle.close.bind(handle);
        vi.spyOn(handle, "close").mockImplementationOnce(async () => { closing = true; await gate; await close(); closed = true; });
      }
      return handle;
    });
    const unlinkSpy = vi.spyOn(fsPromises, "unlink");
    syncBuiltinESMExports();
    const pending = f.create().then(session => { finished = true; return { session }; }, error => { finished = true; return { error: error as unknown }; });
    try {
      await vi.waitFor(() => expect(closing).toBe(true));
      expect(closed).toBe(false);
      expect(finished).toBe(false);
      expect(unlinkSpy.mock.calls.filter(([path]) => typeof path === "string" && path.startsWith(`${f.scratch}/`))).toEqual([]);
      expect((await readdir(f.scratch)).length).toBe(1);
      release();
      const outcome = await pending;
      expect(outcome).toMatchObject({ error: { cause: firstFailure, message: expect.stringContaining('cleanup={"status":"removed"}') } });
      expect(closed).toBe(true);
      expect(await readdir(f.scratch)).toEqual([]);
    } finally {
      release(); await pending;
      openSpy.mockRestore(); unlinkSpy.mockRestore(); syncBuiltinESMExports();
    }
  }));

  it("awaits an in-flight native copy read and its handle close after cancellation before guarded cleanup", async () => fixtureTest(async f => {
    await put(f.source, "slow", "bytes");
    const root = await allocateRoot({ sourceDirectory: f.source, scratchParent: f.scratch });
    const cancellation = new AbortController();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let reading = false, closed = false, cleanupStarted = false;
    const realOpen = fsPromises.open;
    const spy = vi.spyOn(fsPromises, "open").mockImplementation(async (...args) => {
      const handle = await realOpen(...args);
      if (args[0] === join(f.source, "slow")) {
        const read = handle.read.bind(handle), close = handle.close.bind(handle);
        vi.spyOn(handle, "read").mockImplementationOnce(async (...readArgs) => { reading = true; await gate; return read(...readArgs); });
        vi.spyOn(handle, "close").mockImplementationOnce(async () => { await close(); closed = true; });
      }
      return handle;
    });
    syncBuiltinESMExports();
    const pending = copySource(root, { signal: cancellation.signal }).then(() => ({ copied: true }), async (error: unknown) => {
      cleanupStarted = true;
      expect(closed).toBe(true);
      return { error, cleanup: await discardRoot(root) };
    });
    try {
      await vi.waitFor(() => expect(reading).toBe(true));
      cancellation.abort();
      await Promise.resolve();
      expect(cleanupStarted).toBe(false);
      expect(closed).toBe(false);
      expect((await lstat(root.workspace)).isDirectory()).toBe(true);
      release();
      expect(await pending).toMatchObject({ error: { message: "Scan cancelled" }, cleanup: { status: "removed" } });
      expect(await readdir(f.scratch)).toEqual([]);
    } finally {
      release(); await pending;
      spy.mockRestore(); syncBuiltinESMExports();
    }
  }));

  it("unlinks copied links and command-created external links, leaving targets untouched", async () => fixtureTest(async f => {
    await put(f.source, "dir/file", "source bytes");
    await symlink("dir", join(f.source, "copied-link"));
    await symlink("missing", join(f.source, "dangling"));
    await symlink(join(f.source, "dir"), join(f.source, "absolute-remapped"));
    await put(f.path, "outside/precious", "outside bytes");
    const session = await f.create();
    expect((await session.run(nodeOptions("externalLink", [], { TARGET: join(f.path, "outside") }))).exitCode).toBe(0);
    expect(await session.discard()).toEqual({ status: "removed" });
    expect(await readFile(join(f.path, "outside/precious"), "utf8")).toBe("outside bytes");
    expect(await readFile(join(f.source, "dir/file"), "utf8")).toBe("source bytes");
    expect(await session.discard()).toEqual({ status: "already-removed" });
    await expect(lstat(dirname(session.workspacePath))).rejects.toMatchObject({ code: "ENOENT" });
  }));
  it("refuses modified marker contents without deleting workspace", async () => fixtureTest(async f => {
    await put(f.source, "file", "keep");
    const session = await f.create();
    const marker = join(dirname(session.workspacePath), ".twin-core-root");
    const original = await readFile(marker);
    try {
      await writeFile(marker, Buffer.alloc(original.length, 120));
      expect((await session.discard()).status).toBe("refused");
      expect(await readFile(join(session.workspacePath, "file"), "utf8")).toBe("keep");
    } finally { await writeFile(marker, original); }
  }));
  it.each(["root", "workspace", "marker"] as const)("refuses replaced %s identity", async kind => fixtureTest(async f => {
    const session = await f.create();
    const root = dirname(session.workspacePath);
    const path = kind === "root" ? root : kind === "workspace" ? session.workspacePath : join(root, ".twin-core-root");
    const backup = join(f.path, `saved-${kind}`);
    const marker = kind === "marker" ? await readFile(path) : null;
    await rename(path, backup);
    try {
      if (marker) await writeFile(path, marker, { flag: "wx", mode: 0o600 });
      else await mkdir(path, { mode: 0o700 });
      if (kind === "root") {
        // Preserve the actual marker/workspace identities: only the root differs.
        await rename(join(backup, ".twin-core-root"), join(path, ".twin-core-root"));
        await rename(join(backup, "workspace"), join(path, "workspace"));
      }
      expect(await session.discard()).toMatchObject({ status: "refused", reason: kind === "marker"
        ? "Marker type or identity mismatch" : `Directory authority mismatch: ${path}` });
    } finally {
      if (kind === "root") {
        await rename(join(path, ".twin-core-root"), join(backup, ".twin-core-root"));
        await rename(join(path, "workspace"), join(backup, "workspace"));
      }
      // Move the test-created replacement inside the independently owned fixture.
      await rename(path, join(f.path, `replacement-${kind}`));
      await rename(backup, path);
    }
  }));
  it("refuses a workspace symlink instead of entering its target", async () => fixtureTest(async f => {
    const session = await f.create();
    const saved = join(f.path, "saved-workspace");
    await rename(session.workspacePath, saved);
    try {
      await symlink(f.source, session.workspacePath);
      expect((await session.discard()).status).toBe("refused");
    } finally {
      await rename(session.workspacePath, join(f.path, "replacement-link"));
      await rename(saved, session.workspacePath);
    }
  }));
  it("refuses an altered private parent and unexpected root sibling", async () => fixtureTest(async f => {
    const session = await f.create();
    try {
      await chmod(f.scratch, 0o755);
      expect((await session.discard()).status).toBe("refused");
    } finally { await chmod(f.scratch, 0o700); }
    const sibling = join(dirname(session.workspacePath), "unexpected");
    await mkdir(sibling);
    try { expect((await session.discard()).status).toBe("refused"); }
    finally { await rmdir(sibling); }
  }));
});


const byteNameCases = (["file", "directory", "symlink"] as const)
  .flatMap(kind => [false, true].map(fails => ({ kind, fails })));
describe("test-fixture byte-preserving teardown", () => {
  it.each(byteNameCases)("cleans $kind byte names after body failure=$fails", async ({ kind, fails }) => fixtureTest(async outer => {
    await put(outer.source, "precious", "outer target survives inner teardown");
    const bodyFailure = new Error("deliberate fixture body failure");
    let innerPath: string | undefined, outcome: unknown;
    try {
      await fixtureTest(async inner => {
        innerPath = inner.path;
        const rawChild = (parent: string | Buffer, byte: number): Buffer =>
          Buffer.concat([Buffer.isBuffer(parent) ? parent : Buffer.from(parent), Buffer.from([47, byte])]);
        const createEntry = async (path: Buffer): Promise<void> => {
          if (kind === "file") await writeFile(path, "raw file bytes", { flag: "wx", mode: 0o600 });
          else if (kind === "directory") {
            await mkdir(path, { mode: 0o700 });
            await writeFile(rawChild(path, 0x80), "nested raw bytes", { flag: "wx", mode: 0o600 });
          } else await symlink(outer.source, path);
        };
        // Exercise both root marker exclusion and recursive byte-path traversal.
        await createEntry(rawChild(inner.path, 0xff));
        const nested = join(inner.source, "ordinary"); await mkdir(nested, { mode: 0o700 });
        await createEntry(rawChild(nested, 0xfe));
        if (fails) throw bodyFailure;
      });
    } catch (error: unknown) { outcome = error; }
    if (fails) {
      expect(outcome).toBeInstanceOf(AggregateError);
      if (!(outcome instanceof AggregateError)) throw new Error("Expected only the deliberate body failure");
      expect(outcome.errors).toEqual([bodyFailure]);
    } else expect(outcome).toBeUndefined();
    expect(innerPath).toBeDefined();
    if (!innerPath) throw new Error("Inner fixture was not allocated");
    await expect(lstat(innerPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(outer.source, "precious"), "utf8")).toBe("outer target survives inner teardown");
  }));
});
