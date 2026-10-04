import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import fsPromises, { chmod, mkdir, readdir, readFile, rename, symlink, unlink } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createTwin, type TwinSession } from "../src/index.js";
import { fixtureTest, fingerprint, nodeOptions, put } from "./support.js";

describe("session", () => {
  it("returns a complete copy, preserves source and permits both inspection windows", async () => fixtureTest(async f => {
    await put(f.source, "file", "original", 0o751);
    await put(f.source, "delete-me", "keep", 0o640);
    const before = await fingerprint(f.source);
    const session = await f.create();
    expect(session.inspect()).toEqual({ state: "ready", workspacePath: session.workspacePath });
    expect(await readFile(join(session.workspacePath, "file"), "utf8")).toBe("original");
    expect((await session.run(nodeOptions("edit"))).exitCode).toBe(0);
    expect(session.inspect().state).toBe("finished");
    expect(session.inspect().receipt?.files.coverage).toBe("complete");
    expect(session.inspect().receipt?.files.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: { encoding: "utf8", value: "file" }, change: "modified" }),
    ]));
    expect(Object.isFrozen(session.inspect().receipt)).toBe(true);
    expect(await readFile(join(session.workspacePath, "file"), "utf8")).toBe("changed");
    await expect(session.run(nodeOptions("echo"))).rejects.toThrow("Cannot run");
    expect(await fingerprint(f.source)).toBe(before);
    await session.discard();
    expect(await fingerprint(f.source)).toBe(before);
  }));
  it.each(["absolute-external", "escape", "prefix-trap", "dangling-escape", "structural-escape"])("fails creation with no session or launch: %s", async kind => fixtureTest(async f => {
    await put(f.source, "first", "copy before failure");
    const target = kind === "absolute-external" ? join(f.path, "outside")
      : kind === "structural-escape" ? "alias/../outside"
      : kind === "prefix-trap" ? "../source-other/file" : kind === "escape" ? "../outside" : "../../missing";
    await symlink(target, join(f.source, "link"));
    if (kind === "structural-escape") await symlink(".", join(f.source, "alias"));
    const spawn = vi.spyOn(childProcess, "spawn");
    syncBuiltinESMExports();
    let returned: TwinSession | undefined;
    try {
      await expect(f.create().then(session => { returned = session; })).rejects.toThrow("Twin copy failed");
      expect(returned).toBeUndefined();
      expect(spawn).not.toHaveBeenCalled();
      expect(await readdir(f.scratch)).toEqual([]);
    } finally { spawn.mockRestore(); syncBuiltinESMExports(); }
  }));
  it.each(["original-added", "copy-added", "original-recreated", "copy-recreated", "source-root"])("guards late preparation failure and cleanup: %s", async kind => fixtureTest(async f => {
    await put(f.source, "file", "keep");
    await symlink("file", join(f.source, "link"));
    const realRead = fsPromises.readdir;
    let changed = false;
    const saved = join(f.path, "saved-source");
    const spy = vi.spyOn(fsPromises, "readdir").mockImplementation(async (...args) => {
      const names = await realRead(...args);
      const options = args[1];
      if (!changed && String(args[0]) === f.source && typeof options === "object" && options?.withFileTypes) {
        changed = true;
        if (kind === "source-root") { await rename(f.source, saved); await mkdir(f.source); }
        else {
          const allocation = (await readdir(f.scratch))[0]!;
          const root = kind.startsWith("original") ? f.source : join(f.scratch, allocation, "workspace");
          if (kind.endsWith("recreated")) await unlink(join(root, "link"));
          await symlink("file", join(root, kind.endsWith("added") ? "added-link" : "link"));
        }
      }
      return names;
    });
    syncBuiltinESMExports();
    try {
      await expect(f.create()).rejects.toMatchObject({ message: expect.stringContaining('cleanup={"status":"removed"}'), cause: expect.any(Error) });
      expect(changed).toBe(true);
      expect(f.sessions).toEqual([]);
      expect(await readdir(f.scratch)).toEqual([]);
    } finally {
      spy.mockRestore(); syncBuiltinESMExports();
      if (kind === "source-root" && changed) { await rename(f.source, join(f.path, "replacement-source")); await rename(saved, f.source); }
    }
  }));
  it("rejects concurrent run/discard and subsequent runs", async () => fixtureTest(async f => {
    const session = await f.create();
    const running = session.run({ ...nodeOptions("wait"), timeoutMs: 100 });
    try {
      await expect(session.run(nodeOptions("echo"))).rejects.toThrow("Cannot run");
      await expect(session.discard()).rejects.toThrow("Cannot discard");
    } finally { await running; }
    const discarding = session.discard();
    await expect(session.discard()).rejects.toThrow("Cannot discard");
    expect((await discarding).status).toBe("removed");
  }));
  it("requires existing private scratch outside source", async () => fixtureTest(async f => {
    const nested = join(f.source, "scratch");
    await mkdir(nested, { mode: 0o700 });
    await expect(createTwin({ sourceDirectory: f.source, scratchParent: nested })).rejects.toThrow("outside source");
    await expect(createTwin({ sourceDirectory: f.source, scratchParent: f.source })).rejects.toThrow("outside source");
    await expect(createTwin({ sourceDirectory: f.source, scratchParent: join(f.path, "missing") })).rejects.toThrow();
    try {
      await chmod(f.scratch, 0o755);
      await expect(f.create()).rejects.toThrow("authority mismatch");
    } finally { await chmod(f.scratch, 0o700); }
    await symlink(f.source, join(f.path, "source-link"));
    await expect(createTwin({ sourceDirectory: join(f.path, "source-link"), scratchParent: f.scratch })).rejects.toThrow("ordinary directory");
  }));
});
