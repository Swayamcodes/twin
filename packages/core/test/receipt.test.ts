/// <reference types="node" />

import childProcess, { execFileSync } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { mkdir, open, readFile, symlink, unlink, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { fixtureTest, put } from "./support.js";
import type { MinimalReceipt } from "../src/index.js";
import * as manifests from "../src/manifest.js";
import { captureManifest } from "../src/manifest.js";
import { captureGitCategories } from "../src/git-classification.js";

const environment = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));

function command(script: string) {
  return { executable: process.execPath, argv: ["-e", script], env: environment };
}

function changes(receipt: MinimalReceipt) {
  return Object.fromEntries(receipt.files.changes.map(item => [item.path.value, { change: item.change, category: item.category }]));
}

async function mockedGitCategories(source: string, outputs: readonly Buffer[]) {
  let calls = 0;
  const argv: string[][] = [];
  const mock = vi.spyOn(childProcess, "execFile").mockImplementation(((...args: unknown[]) => {
    argv.push(args[1] as string[]);
    const callback = args[3] as (error: Error | null, stdout: Buffer, stderr: Buffer) => void;
    const stdout = calls++ === 0 ? Buffer.from(`${source}\n`) : outputs[calls - 2] ?? Buffer.alloc(0);
    queueMicrotask(() => callback(null, stdout, Buffer.alloc(0)));
    return {} as ReturnType<typeof childProcess.execFile>;
  }) as typeof childProcess.execFile);
  syncBuiltinESMExports();
  try { return { snapshot: await captureGitCategories(source, [source]), calls, argv }; }
  finally { mock.mockRestore(); syncBuiltinESMExports(); }
}

describe("minimal receipt", () => {
  it("classifies tracked, untracked and ignored changes and omits unchanged files", async () => fixtureTest(async f => {
    await put(f.source, ".gitignore", "ignored-*\n");
    await put(f.source, "tracked-mod", "original file contents");
    await put(f.source, "tracked-del", "before");
    await put(f.source, "tracked-same", "before");
    await put(f.source, "untracked-del", "before");
    await put(f.source, "ignored-del", "before");
    execFileSync("/usr/bin/git", ["init", "-q", f.source]);
    execFileSync("/usr/bin/git", ["-C", f.source, "add", ".gitignore", "tracked-mod", "tracked-del", "tracked-same"]);
    const session = await f.create();
    const script = `const fs=require('fs'); fs.writeFileSync('tracked-mod','after'); fs.rmSync('tracked-del'); fs.writeFileSync('untracked-add','after'); fs.rmSync('untracked-del'); fs.writeFileSync('ignored-add','after'); fs.rmSync('ignored-del');`;
    expect((await session.run(command(script))).exitCode).toBe(0);
    const receipt = session.inspect().receipt!;
    expect(receipt.files.coverage).toBe("complete");
    expect(changes(receipt)).toEqual({
      "tracked-mod": { change: "modified", category: "tracked" },
      "tracked-del": { change: "deleted", category: "tracked" },
      "untracked-add": { change: "added", category: "untracked" },
      "untracked-del": { change: "deleted", category: "untracked" },
      "ignored-add": { change: "added", category: "ignored" },
      "ignored-del": { change: "deleted", category: "ignored" },
    });
    expect(new Set(receipt.files.changes.map(item => item.path.value)).size).toBe(receipt.files.changes.length);
    expect(JSON.stringify(receipt)).not.toContain("original file contents");
    expect(JSON.stringify(receipt)).not.toContain(f.source);
    expect(Object.isFrozen(receipt)).toBe(true);
    expect(Object.isFrozen(receipt.files.changes)).toBe(true);
    await session.discard();
  }));

  it("reports a .git/config-only modification without publishing its contents", async () => fixtureTest(async f => {
    execFileSync("/usr/bin/git", ["init", "-q", f.source]);
    const session = await f.create();
    expect((await session.run(command("require('fs').appendFileSync('.git/config','\\n# private receipt marker\\n')"))).exitCode).toBe(0);
    const receipt = session.inspect().receipt!;
    expect(receipt.files.coverage).toBe("complete");
    expect(receipt.files.changes).toEqual([
      { path: { encoding: "utf8", value: ".git/config" }, change: "modified", category: "unclassified", categoryReason: "git-metadata" },
    ]);
    expect(JSON.stringify(receipt)).not.toContain("private receipt marker");
    expect(JSON.stringify(receipt)).not.toContain(f.source);
    await session.discard();
  }));

  it("reports an added empty nested Git directory but not an ordinary empty directory", async () => fixtureTest(async f => {
    execFileSync("/usr/bin/git", ["init", "-q", f.source]);
    const session = await f.create();
    expect((await session.run(command("const fs=require('fs'); fs.mkdirSync('.git/refs/new'); fs.mkdirSync('ordinary-empty')"))).exitCode).toBe(0);
    expect(session.inspect().receipt?.files).toMatchObject({
      coverage: "complete",
      changes: [{ path: { encoding: "utf8", value: ".git/refs/new" }, change: "added", category: "unclassified", categoryReason: "git-metadata" }],
    });
    await session.discard();
  }));

  it("reports deletion of an existing empty nested Git directory", async () => fixtureTest(async f => {
    execFileSync("/usr/bin/git", ["init", "-q", f.source]);
    await mkdir(join(f.source, ".git", "refs", "old"));
    const session = await f.create();
    expect((await session.run(command("require('fs').rmdirSync('.git/refs/old')"))).exitCode).toBe(0);
    expect(session.inspect().receipt?.files).toMatchObject({
      coverage: "complete",
      changes: [{ path: { encoding: "utf8", value: ".git/refs/old" }, change: "deleted", category: "unclassified", categoryReason: "git-metadata" }],
    });
    await session.discard();
  }));

  it("reports replacement of an empty nested Git directory", async () => fixtureTest(async f => {
    execFileSync("/usr/bin/git", ["init", "-q", f.source]);
    await mkdir(join(f.source, ".git", "refs", "replaced"));
    const session = await f.create();
    expect((await session.run(command("const fs=require('fs'); fs.rmdirSync('.git/refs/replaced'); fs.writeFileSync('.git/refs/replaced','now a file')"))).exitCode).toBe(0);
    expect(session.inspect().receipt?.files).toMatchObject({
      coverage: "complete",
      changes: [{ path: { encoding: "utf8", value: ".git/refs/replaced" }, change: "modified", category: "unclassified", categoryReason: "git-metadata" }],
    });
    await session.discard();
  }));

  it("reports changes in a non-Git project as unclassified", async () => fixtureTest(async f => {
    await put(f.source, "old", "old");
    const calls = vi.spyOn(childProcess, "execFile");
    syncBuiltinESMExports();
    try {
      const session = await f.create();
      expect((await session.run(command("require('fs').writeFileSync('old','new')"))).exitCode).toBe(0);
      expect(session.inspect().receipt?.files.changes).toEqual([
        expect.objectContaining({ category: "unclassified", categoryReason: "not-git", change: "modified" }),
      ]);
      expect(calls).not.toHaveBeenCalled();
      await session.discard();
    } finally { calls.mockRestore(); syncBuiltinESMExports(); }
  }));

  it("finishes observations before a nonzero run resolves and inspect stays synchronous", async () => fixtureTest(async f => {
    await put(f.source, "old", "old");
    const session = await f.create();
    expect((await session.run(command("require('fs').writeFileSync('old','new'); process.exit(7)"))).exitCode).toBe(7);
    const inspection = session.inspect();
    expect(inspection).not.toBeInstanceOf(Promise);
    expect(inspection.receipt?.files.changes).toEqual([
      expect.objectContaining({ path: { encoding: "utf8", value: "old" }, change: "modified" }),
    ]);
    expect(session.inspect().receipt).toBe(inspection.receipt);
    await session.discard();
  }));

  it("privately detects same-size watch edits and reports missing paths", async () => fixtureTest(async f => {
    const home = join(f.path, "home");
    await mkdir(home);
    await writeFile(join(home, ".gitconfig"), "abcd");
    const fixed = new Date("2001-01-01T00:00:00.000Z");
    await utimes(join(home, ".gitconfig"), fixed, fixed);
    await writeFile(join(home, ".bashrc"), "stable");
    const oldHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const session = await f.create();
      const script = `const fs=require('fs'); fs.writeFileSync(${JSON.stringify(join(home, ".gitconfig"))},'wxyz'); fs.utimesSync(${JSON.stringify(join(home, ".gitconfig"))},new Date('2001-01-01T00:00:00.000Z'),new Date('2001-01-01T00:00:00.000Z')); fs.writeFileSync(${JSON.stringify(join(home, ".zshrc"))},'new');`;
      expect((await session.run(command(script))).exitCode).toBe(0);
      const receipt = session.inspect().receipt!;
      const item = receipt.watch.find(entry => entry.id === ".gitconfig")!;
      expect(item.before.status).toBe("present");
      expect(item.after.status).toBe("present");
      expect(item.comparison).toBe("changed");
      if (item.before.status === "present" && item.after.status === "present") {
        expect(item.before.size).toBe(item.after.size);
        expect(item.before.mtimeNs).toBe(item.after.mtimeNs);
      }
      expect(receipt.watch.find(entry => entry.id === ".npmrc")).toMatchObject({
        before: { status: "missing" }, after: { status: "missing" }, comparison: "unchanged",
      });
      expect(receipt.watch.find(entry => entry.id === ".bashrc")).toMatchObject({
        before: { status: "present" }, after: { status: "present" }, comparison: "unchanged",
      });
      expect(receipt.watch.find(entry => entry.id === ".zshrc")).toMatchObject({
        before: { status: "missing" }, after: { status: "present" }, comparison: "changed",
      });
      const serialized = JSON.stringify(receipt);
      expect(serialized).not.toContain("abcd");
      expect(serialized).not.toContain("wxyz");
      expect(serialized).not.toContain(home);
      expect(await readFile(join(home, ".gitconfig"), "utf8")).toBe("wxyz");
      await session.discard();
    } finally { if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome; }
  }));

  it("refuses a symlink and marks oversized watch files unavailable", async () => fixtureTest(async f => {
    const home = join(f.path, "home");
    await mkdir(home);
    await writeFile(join(home, "target"), "safe");
    await symlink("target", join(home, ".gitconfig"));
    await writeFile(join(home, ".npmrc"), Buffer.alloc(1024 * 1024 + 1));
    await writeFile(join(home, ".bashrc"), Buffer.alloc(1024 * 1024));
    await mkdir(join(home, ".claude"));
    await mkdir(join(home, ".claude", "settings.json"));
    await symlink(".", join(home, ".codex"));
    const oldHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const session = await f.create();
      await session.run(command(""));
      const watch = session.inspect().receipt!.watch;
      expect(watch.find(item => item.id === ".gitconfig")).toMatchObject({
        before: { status: "refused", reason: "symlink" }, comparison: "unknown",
      });
      expect(watch.find(item => item.id === ".npmrc")).toMatchObject({
        before: { status: "unavailable", reason: "oversized" }, comparison: "unknown",
      });
      expect(watch.find(item => item.id === ".bashrc")).toMatchObject({
        before: { status: "present", size: String(1024 * 1024) }, comparison: "unchanged",
      });
      expect(watch.find(item => item.id === ".claude/settings.json")).toMatchObject({
        before: { status: "refused", reason: "special" }, comparison: "unknown",
      });
      expect(watch.find(item => item.id === ".codex/config.toml")).toMatchObject({
        before: { status: "refused", reason: "symlink" }, comparison: "unknown",
      });
      await session.discard();
    } finally { if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome; }
  }));

  it("refuses watch paths inside the project", async () => fixtureTest(async f => {
    await put(f.source, ".gitconfig", "secret");
    const oldHome = process.env.HOME;
    process.env.HOME = f.source;
    try {
      const session = await f.create();
      await session.run(command(""));
      expect(session.inspect().receipt?.watch[0]).toMatchObject({
        before: { status: "refused", reason: "inside-protected-root" }, comparison: "unknown",
      });
      await session.discard();
    } finally { if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome; }
  }));

  it("marks additions unclassified when the after Git view fails", async () => fixtureTest(async f => {
    await put(f.source, "tracked", "old");
    execFileSync("/usr/bin/git", ["init", "-q", f.source]);
    execFileSync("/usr/bin/git", ["-C", f.source, "add", "tracked"]);
    const session = await f.create();
    const script = `const fs=require('fs'); fs.writeFileSync('new-file','new'); fs.writeFileSync('.git/config','[bad');`;
    await session.run(command(script));
    expect(session.inspect().receipt?.files.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: { encoding: "utf8", value: "new-file" }, category: "unclassified", categoryReason: "git-failed" }),
      expect.objectContaining({ path: { encoding: "utf8", value: ".git/config" }, category: "unclassified", categoryReason: "git-metadata" }),
    ]));
    await session.discard();
  }));

  it("uses eight bounded fixed Git calls for a Git-backed run", async () => fixtureTest(async f => {
    await put(f.source, "tracked", "old");
    execFileSync("/usr/bin/git", ["init", "-q", f.source]);
    execFileSync("/usr/bin/git", ["-C", f.source, "add", "tracked"]);
    const calls = vi.spyOn(childProcess, "execFile");
    syncBuiltinESMExports();
    try {
      const session = await f.create();
      await session.run(command("require('fs').writeFileSync('tracked','new')"));
      expect(calls).toHaveBeenCalledTimes(8);
      for (const call of calls.mock.calls) {
        expect(call[0]).toBe("/usr/bin/git");
        expect(call[1]).toContain("--no-optional-locks");
        expect(call[2]).toMatchObject({
          cwd: session.workspacePath, shell: false, timeout: 5000, maxBuffer: 16 * 1024 * 1024,
        });
      }
      expect(calls.mock.calls.filter(call => (call[1] as string[]).includes("--cached"))).toHaveLength(2);
      for (const call of calls.mock.calls.filter(call => (call[1] as string[]).includes("--cached"))) {
        expect(call[1]).toContain("--deduplicate");
      }
      await session.discard();
    } finally { calls.mockRestore(); syncBuiltinESMExports(); }
  }));

  it("rejects malformed NUL-delimited Git output", async () => fixtureTest(async f => {
    execFileSync("/usr/bin/git", ["init", "-q", f.source]);
    expect(await captureGitCategories(f.source, ["/usr"])).toEqual({ status: "unavailable", reason: "git-unavailable" });
    let calls = 0;
    const mock = vi.spyOn(childProcess, "execFile").mockImplementation(((...args: unknown[]) => {
      const callback = args[3] as (error: Error | null, stdout: Buffer, stderr: Buffer) => void;
      const stdout = calls++ === 0 ? Buffer.from(`${f.source}\n`) : Buffer.from("not NUL terminated");
      queueMicrotask(() => callback(null, stdout, Buffer.alloc(0)));
      return {} as ReturnType<typeof childProcess.execFile>;
    }) as typeof childProcess.execFile);
    syncBuiltinESMExports();
    try {
      expect(await captureGitCategories(f.source, [f.source])).toEqual({ status: "unavailable", reason: "git-incomplete" });
      expect(calls).toBe(2);
    } finally { mock.mockRestore(); syncBuiltinESMExports(); }
  }));

  it.each([
    ["parent segment", Buffer.from("a/..\0")],
    ["leading current segment", Buffer.from("./a\0")],
    ["absolute path", Buffer.from("/a\0")],
    ["empty interior segment", Buffer.from("a//b\0")],
    ["trailing separator", Buffer.from("a/\0")],
    ["empty first entry", Buffer.from("\0")],
    ["empty later entry", Buffer.from("a\0\0")],
  ])("rejects %s in Git path output", async (_name, output) => fixtureTest(async f => {
    await mkdir(join(f.source, ".git"));
    const result = await mockedGitCategories(f.source, [output]);
    expect(result.snapshot).toEqual({ status: "unavailable", reason: "git-incomplete" });
    expect(result.calls).toBe(2);
  }));

  it.each(["tracked", "untracked", "ignored"])("rejects repeated %s entries", async category => fixtureTest(async f => {
    await mkdir(join(f.source, ".git"));
    const duplicate = Buffer.from("same\0same\0");
    const empty = Buffer.alloc(0);
    const outputs = category === "tracked" ? [duplicate]
      : category === "untracked" ? [empty, duplicate] : [empty, empty, duplicate];
    const result = await mockedGitCategories(f.source, outputs);
    expect(result.snapshot).toEqual({ status: "unavailable", reason: "git-incomplete" });
    expect(result.calls).toBe(category === "tracked" ? 2 : category === "untracked" ? 3 : 4);
    expect(result.argv[1]).toContain("--deduplicate");
  }));

  it.each([
    ["tracked/untracked", [Buffer.from("same\0"), Buffer.from("same\0"), Buffer.alloc(0)]],
    ["tracked/ignored", [Buffer.from("same\0"), Buffer.alloc(0), Buffer.from("same\0")]],
    ["untracked/ignored", [Buffer.alloc(0), Buffer.from("same\0"), Buffer.from("same\0")]],
  ])("rejects %s category overlap", async (_name, outputs) => fixtureTest(async f => {
    await mkdir(join(f.source, ".git"));
    const result = await mockedGitCategories(f.source, outputs);
    expect(result.snapshot).toEqual({ status: "unavailable", reason: "git-incomplete" });
  }));

  it("accepts unusual POSIX filename bytes without decoding collisions", async () => fixtureTest(async f => {
    await mkdir(join(f.source, ".git"));
    const names = [Buffer.from("-dash"), Buffer.from("with space"), Buffer.from("line\nbreak"),
      Buffer.from("back\\slash"), Buffer.from([0xff]), Buffer.from("a/.hidden"), Buffer.from("a/..."), Buffer.from("a/..x")];
    const output = Buffer.concat(names.flatMap(name => [name, Buffer.from([0])]));
    const result = await mockedGitCategories(f.source, [output]);
    expect(result.snapshot.status).toBe("available");
    if (result.snapshot.status === "available") {
      expect([...result.snapshot.categories.keys()]).toEqual(names.map(name => name.toString("base64")));
      for (const values of result.snapshot.categories.values()) expect([...values]).toEqual(["tracked"]);
    }
    expect(result.calls).toBe(4);
  }));

  it("marks a sparse file beyond the manifest hash cap partial", async () => fixtureTest(async f => {
    const handle = await open(join(f.source, "oversized"), "w");
    try { await handle.truncate(2 * 1024 * 1024 * 1024 + 1); }
    finally { await handle.close(); }
    const manifest = await captureManifest(f.source);
    expect(manifest.coverage).toBe("partial");
    expect(manifest.issues).toEqual(expect.arrayContaining([expect.objectContaining({ reason: "hash-limit" })]));
  }));

  it("bounds .git contents and never calls their incomplete scan complete", async () => fixtureTest(async f => {
    const git = join(f.source, ".git");
    await mkdir(git);
    await writeFile(join(git, "config"), "private metadata");
    const oversized = await open(join(git, "oversized"), "w");
    try { await oversized.truncate(2 * 1024 * 1024 * 1024 + 1); }
    finally { await oversized.close(); }
    let deep = git;
    for (let i = 0; i < 128; i++) {
      deep = join(deep, "x");
      await mkdir(deep);
    }
    await writeFile(join(deep, "beyond-depth"), "unscanned");
    const manifest = await captureManifest(f.source);
    expect(manifest.coverage).toBe("partial");
    expect([...manifest.entries.values()]).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: { encoding: "utf8", value: ".git" }, kind: "directory" }),
      expect.objectContaining({ path: { encoding: "utf8", value: ".git/x" }, kind: "directory" }),
      expect.objectContaining({ path: { encoding: "utf8", value: ".git/config" }, kind: "file" }),
    ]));
    expect(manifest.issues).toEqual(expect.arrayContaining([
      { reason: "hash-limit", path: { encoding: "utf8", value: ".git/oversized" } },
      expect.objectContaining({ reason: "depth-limit" }),
    ]));
    expect([...manifest.entries.values()].some(entry => entry.path.value === ".git/oversized")).toBe(false);
    expect([...manifest.entries.values()].some(entry => entry.path.value.endsWith("beyond-depth"))).toBe(false);
  }));

  it("does not claim complete receipt coverage after a nested Git directory hits the depth limit", async () => fixtureTest(async f => {
    execFileSync("/usr/bin/git", ["init", "-q", f.source]);
    const session = await f.create();
    const script = "const fs=require('fs'); let p='.git/refs'; for(let i=0;i<127;i++) p+='/x'; fs.mkdirSync(p,{recursive:true}); fs.writeFileSync(p+'/beyond-depth','unscanned')";
    expect((await session.run(command(script))).exitCode).toBe(0);
    expect(session.inspect().receipt?.files.coverage).toBe("partial");
    expect(session.inspect().receipt?.files.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ reason: "depth-limit", path: expect.objectContaining({ encoding: "utf8" }) }),
    ]));
    expect(session.inspect().receipt?.files.changes.some(change => change.path.value.endsWith("beyond-depth"))).toBe(false);
    await session.discard();
  }));

  it("encodes invalid UTF-8 filenames without collisions", async () => fixtureTest(async f => {
    const name = Buffer.concat([Buffer.from(f.source + "/"), Buffer.from([0xff, 0xfe])]);
    await writeFile(name, "secret bytes");
    try {
      const manifest = await captureManifest(f.source);
      expect(manifest.coverage).toBe("complete");
      expect([...manifest.entries.values()][0]?.path).toEqual({ encoding: "base64", value: Buffer.from([0xff, 0xfe]).toString("base64") });
    } finally { await unlink(name); }
  }));

  it("does not report creation remapping as an agent change", async () => fixtureTest(async f => {
    await put(f.source, "file", "original");
    await symlink(join(f.source, "file"), join(f.source, "link"));
    const session = await f.create();
    await session.run(command("require('fs').writeFileSync('link','copy')"));
    expect(session.inspect().receipt?.files.changes).toEqual([
      expect.objectContaining({ path: { encoding: "utf8", value: "file" }, change: "modified" }),
    ]);
    expect(await readFile(join(f.source, "file"), "utf8")).toBe("original");
  }));
  it("reports a changed symlink without following it", async () => fixtureTest(async f => {
    await put(f.source, "one", "one");
    await put(f.source, "two", "two");
    await symlink("one", join(f.source, "link"));
    const session = await f.create();
    await session.run(command("const fs=require('fs'); fs.rmSync('link'); fs.symlinkSync('two','link')"));
    expect(session.inspect().receipt?.files.changes).toEqual([
      expect.objectContaining({ path: { encoding: "utf8", value: "link" }, change: "modified", category: "unclassified" }),
    ]);
    await session.discard();
  }));
});


it("executes with a partial preparation receipt but never admits its partial apply baseline", async () => fixtureTest(async f => {
  await put(f.source, "file", "base");
  const real = manifests.captureManifestViews;
  const scan = vi.spyOn(manifests, "captureManifestViews").mockImplementation(async (...args) => {
    const result = await real(...args);
    const incomplete = (snapshot: manifests.ManifestSnapshot): manifests.ManifestSnapshot => ({ ...snapshot, coverage: "partial", issues: [{ reason: "scan-timeout" }] });
    return { raw: incomplete(result.raw), receipt: incomplete(result.receipt), apply: incomplete(result.apply) };
  });
  let session;
  try { session = await f.create(); } finally { scan.mockRestore(); }
  expect((await session.run(command('require("fs").writeFileSync("file","copy")'))).exitCode).toBe(0);
  expect(session.inspect().receipt?.files).toMatchObject({ coverage: "partial", issues: expect.arrayContaining([expect.objectContaining({ reason: "scan-timeout" })]) });
  expect(await session.apply()).toMatchObject({ status: "refused", reason: "Incomplete inventory" });
  expect(await readFile(join(f.source, "file"), "utf8")).toBe("base");
}));
