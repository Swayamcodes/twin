import fsPromises, { lstat, mkdir, rename, rmdir, symlink } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { IoPool, PREPARATION_LINK_WORKERS } from "../src/io-pool.js";
import { verifyBaselineLinks, checkEntryPath, checkRelativeTarget, copyLinkTarget, directoryNames, discoverLinks, LINK_DISCOVERY_LIMITS } from "../src/symlink-policy.js";
import { fixtureTest, put } from "./support.js";

describe("structural link policy", () => {
  it.each(["../../core", "./../core", ".pnpm/pkg", "missing/child", ".", "../"])("preserves safe relative bytes: %s", target => {
    expect(copyLinkTarget("/source", "node_modules/pkg/link", Buffer.from(target))).toEqual(Buffer.from(target));
  });
  it.each(["a/../outside", "a/./../outside", "a//../outside", "../a/../outside", "../../../outside"])("rejects structural escape: %s", target => {
    expect(() => checkRelativeTarget(Buffer.from(target), 2)).toThrow();
  });
  it.each([
    ["/source/file", "../../file"], ["/source/dir/", "../../dir/"], ["/source", "../.."],
    ["/source/node_modules/pkg/file", "file"], ["/source/missing", "../../missing"],
  ])("remaps %s to %s", (target, expected) => {
    expect(copyLinkTarget("/source", "node_modules/pkg/link", Buffer.from(target)).toString()).toBe(expected);
  });
  it.each(["/source-other/file", "/alias/source/file", "//source/file", "/source/./file", "/source/dir/../file"])("rejects unsupported absolute spelling: %s", target => {
    expect(() => copyLinkTarget("/source", "link", Buffer.from(target))).toThrow();
  });
  it("preserves undecodable relative target bytes, rejects NUL, and bounds emitted bytes", () => {
    const raw = Buffer.from([0xff, 0x2f, 0xfe]);
    expect(copyLinkTarget("/source", "link", raw)).toEqual(raw);
    expect(() => copyLinkTarget("/source", "link", Buffer.from([0]))).toThrow();
    expect(() => copyLinkTarget("/source", "link", Buffer.alloc(4097, 120))).toThrow();
    const absolute = Buffer.from(`/s/${"x".repeat(4093)}`);
    expect(() => copyLinkTarget("/s", "a/b/link", absolute)).toThrow();
  });
  it("bounds UTF-8 path bytes and physical component depth", () => {
    expect(() => checkEntryPath("é".repeat(2049))).toThrow("path limit");
    expect(() => checkEntryPath(Array.from({ length: 129 }, () => "a").join("/"))).toThrow("depth limit");
    expect(() => checkEntryPath(Array.from({ length: 128 }, () => "a").join("/"))).not.toThrow();
  });
  it("discovers cyclic and dangling link objects without resolving targets", async () => fixtureTest(async f => {
    await symlink("b", join(f.source, "a"));
    await symlink("a", join(f.source, "b"));
    await symlink(Buffer.from([0xff]), join(f.source, "dangling"));
    const links = await discoverLinks(f.source);
    expect(links.size).toBe(3);
    expect(links.get(Buffer.from("dangling").toString("base64"))?.target).toEqual(Buffer.from([0xff]));
  }));
  it("refuses lossy source entry names", async () => fixtureTest(async f => {
    const real = fsPromises.readdir;
    const spy = vi.spyOn(fsPromises, "readdir").mockImplementation(async (...args) => {
      if (args[0] === f.source) return [Buffer.from([0xff])] as unknown as Awaited<ReturnType<typeof real>>;
      return real(...args);
    });
    syncBuiltinESMExports();
    try { await expect(directoryNames(f.source)).rejects.toThrow("non-UTF-8"); }
    finally { spy.mockRestore(); syncBuiltinESMExports(); }
  }));
  it.each([4, PREPARATION_LINK_WORKERS])("counts ordinary entries towards the discovery limit at %s workers", async workers => fixtureTest(async f => {
    await put(f.source, "file", "bytes");
    const fileStat = await lstat(join(f.source, "file"), { bigint: true });
    const realRead = fsPromises.readdir, realStat = fsPromises.lstat;
    const readSpy = vi.spyOn(fsPromises, "readdir").mockImplementation(async (...args) => {
      if (args[0] === f.source) return Array.from({ length: LINK_DISCOVERY_LIMITS.entries + 1 }, () => Buffer.from("file")) as unknown as Awaited<ReturnType<typeof realRead>>;
      return realRead(...args);
    });
    const statSpy = vi.spyOn(fsPromises, "lstat").mockImplementation(async (...args) => {
      if (args[0] === join(f.source, "file")) return fileStat as unknown as Awaited<ReturnType<typeof realStat>>;
      return realStat(...args);
    });
    syncBuiltinESMExports();
    try { await expect(discoverLinks(f.source, { pool: new IoPool(workers) })).rejects.toThrow("entry limit"); }
    finally { readSpy.mockRestore(); statSpy.mockRestore(); syncBuiltinESMExports(); }
  }));
  it.each([4, PREPARATION_LINK_WORKERS])("refuses a queued directory replaced with another ordinary directory at %s workers", async workers => fixtureTest(async f => {
    await put(f.source, "folder/file", "bytes");
    const path = join(f.source, "folder"), saved = join(f.path, "saved-folder");
    const realStat = fsPromises.lstat;
    let calls = 0, replaced = false;
    const spy = vi.spyOn(fsPromises, "lstat").mockImplementation(async (...args) => {
      if (args[0] === path && ++calls === 2) {
        await rename(path, saved); await mkdir(path); replaced = true;
      }
      return realStat(...args);
    });
    syncBuiltinESMExports();
    try { await expect(discoverLinks(f.source, { pool: new IoPool(workers) })).rejects.toThrow("directory changed"); expect(replaced).toBe(true); }
    finally {
      spy.mockRestore(); syncBuiltinESMExports();
      if (replaced) { await rmdir(path); await rename(saved, path); }
    }
  }));
});

it.each([4, PREPARATION_LINK_WORKERS])("waits for the other tree's delayed checks after a link discovery failure at %s workers", async workers => fixtureTest(async f => {
  const copy = join(f.path, "copy");
  for (let i = 0; i < 16; i++) { await put(f.source, `f${i}`, "source"); await put(copy, `f${i}`, "copy"); }
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void; const ready = new Promise<void>(resolve => { entered = resolve; });
  const failure = new Error("copy discovery failure"), pool = new IoPool(workers);
  const real = fsPromises.lstat; let finished = false;
  const spy = vi.spyOn(fsPromises, "lstat").mockImplementation(async (...args) => {
    if (String(args[0]) === join(f.source, "f0")) { entered(); await gate; }
    if (String(args[0]) === join(copy, "f0")) { await ready; throw failure; }
    return real(...args);
  }); syncBuiltinESMExports();
  const pending = verifyBaselineLinks(f.source, copy, new Map(), { pool }).then(() => undefined, error => error as unknown).finally(() => { finished = true; });
  try {
    await ready; await new Promise<void>(resolve => setTimeout(resolve, 20)); expect(finished).toBe(false);
    release(); expect(await pending).toBe(failure);
    expect(pool.inspect()).toMatchObject({ active: 0, queued: 0, waiters: 0 }); expect(pool.inspect().peakActive).toBeLessThanOrEqual(workers);
  } finally { release(); await pending; spy.mockRestore(); syncBuiltinESMExports(); }
}));

it("keeps paired link discovery non-dereferencing and drains both roots with a failing observer", async () => fixtureTest(async f => {
  const { Diagnostics } = await import("../src/io-pool.js");
  const events: import("../src/io-pool.js").DiagnosticEvent[] = [];
  const diagnostics = new Diagnostics(event => { events.push(event); throw new Error("observer failure"); });
  await symlink("missing", join(f.source, "link"));
  const session = await f.create();
  const links = await discoverLinks(f.source);
  // Creation records contain physical identities for both trees; use the authorized baseline.
  const { copySource } = await import("../src/copy.js");
  const { allocateRoot, discardRoot } = await import("../src/safety.js");
  const root = await allocateRoot({ sourceDirectory: f.source, scratchParent: f.scratch });
  try {
    const baseline = await copySource(root);
    await verifyBaselineLinks(f.source, root.workspace, baseline, { diagnostics, pool: new IoPool(PREPARATION_LINK_WORKERS) });
    expect(links.size).toBe(1);
    expect(events.filter(event => event.kind === "drained").map(event => event.role).sort()).toEqual(["copy", "source"]);
    expect(events.at(-1)).toMatchObject({ kind: "end", stage: "preparation.links", outcome: "complete" });
  } finally { expect(await discardRoot(root)).toEqual({ status: "removed" }); }
  expect(session.inspect().state).toBe("ready");
}));
