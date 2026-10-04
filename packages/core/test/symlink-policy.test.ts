import fsPromises, { lstat, mkdir, rename, rmdir, symlink } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { checkEntryPath, checkRelativeTarget, copyLinkTarget, directoryNames, discoverLinks, LINK_DISCOVERY_LIMITS } from "../src/symlink-policy.js";
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
  it("counts ordinary entries towards the discovery limit", async () => fixtureTest(async f => {
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
    try { await expect(discoverLinks(f.source)).rejects.toThrow("entry limit"); }
    finally { readSpy.mockRestore(); statSpy.mockRestore(); syncBuiltinESMExports(); }
  }));
  it("refuses a queued directory replaced with another ordinary directory", async () => fixtureTest(async f => {
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
    try { await expect(discoverLinks(f.source)).rejects.toThrow("directory changed"); expect(replaced).toBe(true); }
    finally {
      spy.mockRestore(); syncBuiltinESMExports();
      if (replaced) { await rmdir(path); await rename(saved, path); }
    }
  }));
});
