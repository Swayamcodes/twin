import fsPromises, { chmod, link, mkdir, readFile, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { fixtureTest, put } from "./support.js";

const command = (script: string) => ({ executable: process.execPath, argv: ["-e", script], env: {}, timeoutMs: 5000 });
const edit = 'const f=require("node:fs");f.writeFileSync("file","copy");f.writeFileSync("added","new");f.unlinkSync("gone");';

describe("three-state apply", () => {
  it("applies copy edits, modes, ignored-style files and non-Git folders while keeping unrelated original edits", async () => fixtureTest(async f => {
    await put(f.source, "file", "base");
    await put(f.source, "gone", "old");
    await put(f.source, ".env", "secret");
    const session = await f.create();
    await session.run(command(`${edit}f.writeFileSync(".env","changed-secret");f.chmodSync("file",0o755);`));
    await put(f.source, "unrelated", "local");
    expect(await session.apply()).toMatchObject({ status: "applied" });
    expect(await readFile(join(f.source, "file"), "utf8")).toBe("copy");
    expect((await stat(join(f.source, "file"))).mode & 0o777).toBe(0o755);
    expect(await readFile(join(f.source, ".env"), "utf8")).toBe("changed-secret");
    expect(await readFile(join(f.source, "unrelated"), "utf8")).toBe("local");
    await expect(readFile(join(f.source, "gone"))).rejects.toThrow();
    expect(await session.apply()).toMatchObject({ status: "applied", changes: 0 });
  }));
  it("reports same-path and deletion conflicts without writing any planned path", async () => fixtureTest(async f => {
    await put(f.source, "file", "base");
    await put(f.source, "gone", "old");
    const session = await f.create();
    await session.run(command(edit));
    await writeFile(join(f.source, "gone"), "local");
    await writeFile(join(f.source, "file"), "local");
    expect(await session.apply()).toMatchObject({ status: "conflict" });
    expect(await readFile(join(f.source, "file"), "utf8")).toBe("local");
    expect(await readFile(join(f.source, "gone"), "utf8")).toBe("local");
    await expect(readFile(join(f.source, "added"))).rejects.toThrow();
    expect(await readFile(join(session.workspacePath, "file"), "utf8")).toBe("copy");
  }));
  it("accepts already identical changes", async () => fixtureTest(async f => {
    await put(f.source, "file", "base");
    await put(f.source, "gone", "old");
    const session = await f.create();
    await session.run(command('const f=require("node:fs");f.writeFileSync("file","copy");f.writeFileSync("added","new");f.unlinkSync("gone")'));
    await writeFile(join(f.source, "file"), "copy");
    await writeFile(join(f.source, "added"), "new");
    await rm(join(f.source, "gone"));
    expect(await session.apply()).toMatchObject({ status: "applied", changes: 0 });
  }));
  it("applies an actually Git-ignored file", async () => fixtureTest(async f => {
    await put(f.source, ".gitignore", ".env\n");
    await put(f.source, ".env", "old");
    execFileSync("/usr/bin/git", ["init", "-q", f.source]);
    const session = await f.create();
    await session.run(command('require("node:fs").writeFileSync(".env","new")'));
    expect(session.inspect().receipt?.files.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: { encoding: "utf8", value: ".env" }, category: "ignored" }),
    ]));
    expect(await session.apply()).toMatchObject({ status: "applied" });
    expect(await readFile(join(f.source, ".env"), "utf8")).toBe("new");
  }));
  it("refuses an incomplete original observation", async () => fixtureTest(async f => {
    await put(f.source, "file", "base");
    await put(f.source, "unreadable", "old");
    const session = await f.create();
    await session.run(command('require("node:fs").writeFileSync("file","copy")'));
    await chmod(join(f.source, "unreadable"), 0o000);
    try { if (process.getuid?.() !== 0) expect(await session.apply()).toMatchObject({ status: "refused" }); }
    finally { await chmod(join(f.source, "unreadable"), 0o644); }
    expect(await readFile(join(f.source, "file"), "utf8")).toBe("base");
  }));
  it("handles file/directory transitions", async () => fixtureTest(async f => {
    await put(f.source, "to-dir", "old");
    await put(f.source, "to-file/child", "old");
    const session = await f.create();
    await session.run(command('const f=require("node:fs");f.unlinkSync("to-dir");f.mkdirSync("to-dir");f.writeFileSync("to-dir/child","new");f.chmodSync("to-dir",0o750);f.rmSync("to-file",{recursive:true});f.writeFileSync("to-file","new");'));
    expect(await session.apply()).toMatchObject({ status: "applied" });
    expect(await readFile(join(f.source, "to-dir/child"), "utf8")).toBe("new");
    expect((await stat(join(f.source, "to-dir"))).mode & 0o777).toBe(0o750);
    expect(await readFile(join(f.source, "to-file"), "utf8")).toBe("new");
  }));
  it("refuses changed roots, symlinks, and changed settled copies", async () => fixtureTest(async f => {
    await put(f.source, "file", "base");
    const session = await f.create();
    await session.run(command('require("node:fs").writeFileSync("file","copy")'));
    await writeFile(join(session.workspacePath, "file"), "later");
    expect(await session.apply()).toMatchObject({ status: "refused" });
    await writeFile(join(session.workspacePath, "file"), "copy");
    await symlink("file", join(f.source, "link"));
    expect(await session.apply()).toMatchObject({ status: "refused" });
    await rm(join(f.source, "link"));
    const moved = join(f.path, "moved-source");
    await rename(f.source, moved);
    await mkdir(f.source);
    expect(await session.apply()).toMatchObject({ status: "refused" });
    await rm(f.source, { recursive: true });
    await rename(moved, f.source);
  }));
  it.each(["original", "copy"] as const)("rechecks %s root authority after the temporary file is copied", async kind => fixtureTest(async f => {
    await put(f.source, "file", "base");
    const session = await f.create();
    await session.run(command('require("node:fs").writeFileSync("file","copy")'));
    const active = kind === "original" ? f.source : session.workspacePath;
    const moved = join(f.path, `moved-${kind}`);
    const realOpen = fsPromises.open;
    let replaced = false;
    const spy = vi.spyOn(fsPromises, "open").mockImplementation(async (...args) => {
      const handle = await realOpen(...args);
      if (!replaced && String(args[0]).includes("/.twin-apply-")) {
        replaced = true;
        await rename(active, moved);
        await mkdir(active, { mode: 0o700 });
        await link(join(moved, "file"), join(active, "file"));
      }
      return handle;
    });
    syncBuiltinESMExports();
    try {
      expect(await session.apply()).toMatchObject({ status: "failed", partialApplicationPossible: true });
      expect(replaced).toBe(true);
      expect(await readFile(join(f.source, "file"), "utf8")).toBe("base");
      expect(await readFile(join(session.workspacePath, "file"), "utf8")).toBe("copy");
    } finally {
      spy.mockRestore();
      syncBuiltinESMExports();
      if (replaced) {
        await rm(active, { recursive: true });
        await rename(moved, active);
      }
    }
  }));
  it.each(["existing", "new"] as const)("refuses a changed %s directory mode just before chmod", async kind => fixtureTest(async f => {
    if (kind === "existing") {
      await mkdir(join(f.source, "folder"));
      await chmod(join(f.source, "folder"), 0o700);
    }
    const session = await f.create();
    await session.run(command(`const f=require("node:fs");${kind === "new" ? 'f.mkdirSync("folder");' : ""}f.chmodSync("folder",0o750)`));
    const target = join(f.source, "folder");
    const realLstat = fsPromises.lstat;
    let changed = false;
    const spy = vi.spyOn(fsPromises, "lstat").mockImplementation(async (...args) => {
      if (!changed && String(args[0]) === target && args.length === 1) {
        changed = true;
        await chmod(target, 0o711);
      }
      return realLstat(...args);
    });
    syncBuiltinESMExports();
    try {
      expect(await session.apply()).toMatchObject({ status: "failed", partialApplicationPossible: true });
      expect(changed).toBe(true);
      expect((await stat(target)).mode & 0o777).toBe(0o711);
      expect((await stat(join(session.workspacePath, "folder"))).mode & 0o777).toBe(0o750);
    } finally { spy.mockRestore(); syncBuiltinESMExports(); }
  }));
  it("refuses unsettled commands and retains the copy", async () => fixtureTest(async f => {
    await put(f.source, "file", "base");
    const session = await f.create();
    const running = session.run(command('require("node:fs").writeFileSync("file","copy");setInterval(()=>{},1000)'));
    expect(await session.apply()).toMatchObject({ status: "refused" });
    await running;
    expect(await readFile(join(session.workspacePath, "file"), "utf8")).toBe("copy");
  }));
  it("reports an application failure and retains the copy", async () => fixtureTest(async f => {
    await put(f.source, "locked/existing", "old");
    await chmod(join(f.source, "locked"), 0o500);
    const session = await f.create();
    await session.run(command('const f=require("node:fs");f.writeFileSync("a-good","first");f.chmodSync("locked",0o700);f.writeFileSync("locked/new","copy");f.chmodSync("locked",0o500);'));
    const result = await session.apply();
    if (process.getuid?.() !== 0) expect(result).toMatchObject({ status: "failed", partialApplicationPossible: true });
    if (process.getuid?.() !== 0) expect(await readFile(join(f.source, "a-good"), "utf8")).toBe("first");
    expect(await readFile(join(session.workspacePath, "locked/new"), "utf8")).toBe("copy");
    await chmod(join(f.source, "locked"), 0o700);
    await chmod(join(session.workspacePath, "locked"), 0o700);
  }));
});
