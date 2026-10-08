import fsPromises, { chmod, link, lstat, mkdir, readFile, readdir, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createTwin, type AffectedApplyResult } from "../src/index.js";
import { AffectedObserver } from "../src/apply-affected-observer.js";
import { IoPool } from "../src/io-pool.js";
import * as manifests from "../src/manifest.js";
import { fixtureTest, put } from "./support.js";
const execute = promisify(execFile);
const command = (script: string) => ({ executable: process.execPath, argv: ["-e", script], env: {}, timeoutMs: 5000 });
const edited = 'require("node:fs").writeFileSync("file","copy")';
const key = (path: string): string => Buffer.from(path).toString("base64");
const partial = (result: AffectedApplyResult): void => {
  expect(result).toMatchObject({ status: "failed", partialApplicationPossible: true, scope: "affected-paths", outsideScope: "not-rechecked", scopeCoverage: "incomplete" });
  expect(result).not.toHaveProperty("changes");
};

describe("explicit affected-path Apply", () => {
  it("retains admission gates and an explicit unobserved result", async () => fixtureTest(async f => {
    const session = await f.create(); expect(await session.applyAffected()).toMatchObject({ status: "refused", phase: "admission", reasonCode: "settlement-uncertain", plannedTargets: null, verifiedTargets: 0, scopeCoverage: "not-observed" });
  }));
  it("applies add/update/delete/mode and repeated no-ops while preserving unrelated original edits", async () => fixtureTest(async f => {
    await put(f.source, "file", "base"); await put(f.source, "gone", "base"); await put(f.source, ".env", "base");
    const session = await f.create(); await session.run(command('const f=require("node:fs");f.writeFileSync("file","copy");f.chmodSync("file",0o755);f.writeFileSync("added","new");f.unlinkSync("gone");f.writeFileSync(".env","copy")'));
    await put(f.source, "unrelated", "local");
    expect(await session.applyAffected()).toMatchObject({ status: "applied", changes: 4, plannedTargets: 4, verifiedTargets: 4, scopeCoverage: "complete", scope: "affected-paths", outsideScope: "not-rechecked" });
    expect(await readFile(join(f.source, "file"), "utf8")).toBe("copy"); expect(Number((await lstat(join(f.source, "file"), { bigint: true })).mode & 0o777n)).toBe(0o755);
    expect(await readFile(join(f.source, "unrelated"), "utf8")).toBe("local");
    expect(await session.applyAffected()).toMatchObject({ status: "applied", changes: 0, plannedTargets: 4, verifiedTargets: 4 });
  }));
  it("discovers all known conflicts before issuing any write", async () => fixtureTest(async f => {
    await put(f.source, "file", "base"); const session = await f.create(); await session.run(command(`${edited};require("node:fs").writeFileSync("added","new")`));
    await writeFile(join(f.source, "file"), "local"); expect(await session.applyAffected()).toMatchObject({ status: "conflict", reasonCode: "original-conflict", verifiedTargets: 0, pathCount: 1 });
    await expect(lstat(join(f.source, "added"))).rejects.toThrow(); expect(await readFile(join(f.source, "file"), "utf8")).toBe("local");
  }));
  it("validates an empty scope without fresh unrelated traversal", async () => fixtureTest(async f => {
    await put(f.source, "file", "base"); const session = await f.create(); await session.run(command("process.exitCode=0"));
    await symlink("file", join(f.source, "late")); await symlink("file", join(session.workspacePath, "late"));
    expect(await session.applyAffected()).toMatchObject({ status: "applied", changes: 0, plannedTargets: 0, verifiedTargets: 0, scopeCoverage: "complete" });
    expect(await session.apply()).toMatchObject({ status: "refused" });
  }));
  it("applies ignored and .git paths without category filtering", async () => fixtureTest(async f => {
    await put(f.source, ".gitignore", ".env\n"); await put(f.source, ".env", "base"); await execute("/usr/bin/git", ["init", "-q", f.source]);
    const session = await f.create(); await session.run(command('const f=require("node:fs");f.writeFileSync(".env","copy");f.writeFileSync(".git/custom","copy")'));
    expect(await session.applyAffected()).toMatchObject({ status: "applied", changes: 2 }); expect(await readFile(join(f.source, ".git/custom"), "utf8")).toBe("copy");
  }));
  it("preserves original special mode bits when ordinary modes are a no-op", async () => fixtureTest(async f => {
    await put(f.source, "file", "base", 0o6751); const session = await f.create(); await session.run(command('require("node:fs").chmodSync("file",0o4751)'));
    expect(await session.applyAffected()).toMatchObject({ status: "applied", changes: 0, plannedTargets: 0 }); expect(Number((await lstat(join(f.source, "file"), { bigint: true })).mode & 0o7777n)).toBe(0o6751);
  }));
  it("accepts late unrelated copy edits and original links but refuses changed planned copy targets", async () => fixtureTest(async f => {
    await put(f.source, "file", "base"); await put(f.source, "unrelated", "base"); const session = await f.create(); await session.run(command(edited));
    await writeFile(join(session.workspacePath, "unrelated"), "late"); await symlink("file", join(f.source, "late-link"));
    expect(await session.applyAffected()).toMatchObject({ status: "applied", changes: 1 }); expect(await readFile(join(f.source, "unrelated"), "utf8")).toBe("base");
    await writeFile(join(session.workspacePath, "file"), "late"); expect(await session.applyAffected()).toMatchObject({ status: "refused", reasonCode: "copy-target-changed" });
  }));
  it("does not enumerate ordinary file siblings including unrelated FIFO", async () => fixtureTest(async f => {
    await put(f.source, "folder/file", "base"); const session = await f.create(); await session.run(command('require("node:fs").writeFileSync("folder/file","copy")'));
    const fifo = join(f.source, "folder/fifo");
    try { await execute("/usr/bin/mkfifo", [fifo]); expect(await session.applyAffected()).toMatchObject({ status: "applied", changes: 1 }); } finally { await unlink(fifo); }
  }));
  it("never writes through a preexisting destination hardlink", async () => fixtureTest(async f => {
    await put(f.source, "file", "base"); const session = await f.create(); await session.run(command(edited));
    const saved = join(f.source, "saved"); await link(join(f.source, "file"), saved);
    expect(await session.applyAffected()).toMatchObject({ status: "applied" }); expect(await readFile(saved, "utf8")).toBe("base"); expect((await lstat(saved)).ino).not.toBe((await lstat(join(f.source, "file"))).ino);
  }));
  it("supports byte-safe filenames", async () => fixtureTest(async f => {
    const name = Buffer.from([0x66, 0xff]), path = Buffer.concat([Buffer.from(f.source), Buffer.from("/"), name]);
    const session = await f.create(); await session.run(command('require("node:fs").writeFileSync(Buffer.from([0x66,0xff]),"copy")'));
    expect(await session.applyAffected()).toMatchObject({ status: "applied", changes: 1 }); expect(await readFile(path, "utf8")).toBe("copy");
    // Current guarded discard uses UTF-8 names: remove only this independently known byte path before discard.
    await unlink(Buffer.concat([Buffer.from(session.workspacePath), Buffer.from("/"), name]));
  }));
  it("refuses partial historical baselines even when the partial path is unrelated", async () => fixtureTest(async f => {
    await put(f.source, "file", "base"); const real = manifests.captureManifest;
    const spy = vi.spyOn(manifests, "captureManifest").mockImplementation(async (...args) => { const result = await real(...args); return { ...result, coverage: "partial", issues: [{ reason: "scan-timeout" }] }; });
    let session; try { session = await f.create(); } finally { spy.mockRestore(); }
    await session.run(command(edited)); expect(await session.applyAffected()).toMatchObject({ status: "refused", reasonCode: "baseline-incomplete", plannedTargets: null });
  }));
});

describe("affected destructive scope and scoped links", () => {
  it("handles file/directory transitions and directory modes", async () => fixtureTest(async f => {
    await put(f.source, "to-dir", "old"); await put(f.source, "to-file/child", "old");
    const session = await f.create(); await session.run(command('const f=require("node:fs");f.unlinkSync("to-dir");f.mkdirSync("to-dir");f.writeFileSync("to-dir/child","new");f.chmodSync("to-dir",0o750);f.rmSync("to-file",{recursive:true});f.writeFileSync("to-file","new")'));
    expect(await session.applyAffected()).toMatchObject({ status: "applied", destructiveSubtrees: 1 }); expect(await readFile(join(f.source, "to-file"), "utf8")).toBe("new"); expect(await readFile(join(f.source, "to-dir/child"), "utf8")).toBe("new");
  }));
  it("does not include unrelated children of mode-only directories", async () => fixtureTest(async f => {
    await put(f.source, "folder/file", "base"); const session = await f.create(); await session.run(command('require("node:fs").chmodSync("folder",0o750)'));
    await put(f.source, "folder/local", "local"); expect(await session.applyAffected()).toMatchObject({ status: "applied", destructiveSubtrees: 0 }); expect(await readFile(join(f.source, "folder/local"), "utf8")).toBe("local");
  }));
  it("refuses unknown destructive children before any planned write", async () => fixtureTest(async f => {
    await put(f.source, "folder/file", "base"); const session = await f.create(); await session.run(command('const f=require("node:fs");f.rmSync("folder",{recursive:true});f.writeFileSync("added","new")'));
    await put(f.source, "folder/local", "local"); expect(await session.applyAffected()).toMatchObject({ status: "conflict", reasonCode: "unplanned-subtree-child" }); await expect(lstat(join(f.source, "added"))).rejects.toThrow(); expect(await readFile(join(f.source, "folder/local"), "utf8")).toBe("local");
  }));
  it.each(["original", "copy"] as const)("rejects a scoped %s symlink target", async side => fixtureTest(async f => {
    await put(f.source, "file", "base"); const session = await f.create(); await session.run(command(edited)); const root = side === "original" ? f.source : session.workspacePath;
    await unlink(join(root, "file")); await symlink("missing", join(root, "file")); expect(await session.applyAffected()).toMatchObject({ status: "refused", reasonCode: "unsafe-target" });
  }));
  it.each(["add", "delete", "retarget"] as const)("rejects historical reviewed link %s even outside D", async mutation => fixtureTest(async f => {
    await put(f.source, "file", "base"); await symlink("file", join(f.source, "alias")); const session = await f.create();
    await session.run(command(`${edited};const f=require("node:fs");${mutation === "add" ? 'f.symlinkSync("file","new-link")' : mutation === "delete" ? 'f.unlinkSync("alias")' : 'f.unlinkSync("alias");f.symlinkSync("missing","alias")'}`));
    expect(await session.applyAffected()).toMatchObject({ status: "refused", reasonCode: "historical-link-change", plannedTargets: null }); expect(await readFile(join(f.source, "file"), "utf8")).toBe("base");
  }));
  it("applies physical paths reached through unchanged contained baseline aliases", async () => fixtureTest(async f => {
    await put(f.source, "folder/file", "base"); await symlink(join(f.source, "folder"), join(f.source, "alias")); const session = await f.create(); await session.run(command('require("node:fs").writeFileSync("alias/file","copy")'));
    expect(await session.applyAffected()).toMatchObject({ status: "applied", changes: 1 }); expect(await readFile(join(f.source, "folder/file"), "utf8")).toBe("copy");
  }));
});

describe("affected late changes and partial outcomes", () => {
  it.each(["original", "copy"] as const)("fails a %s parent replacement with retained hardlinked target", async side => fixtureTest(async f => {
    await put(f.source, "folder/file", "base"); const session = await f.create(); await session.run(command('require("node:fs").writeFileSync("folder/file","copy")'));
    const root = side === "original" ? f.source : session.workspacePath, parent = join(root, "folder"), saved = join(f.path, `saved-${side}`); let replaced = false;
    const real = fsPromises.open, spy = vi.spyOn(fsPromises, "open").mockImplementation(async (...args) => {
      const handle = await real(...args); if (!replaced && String(args[0]).includes("/.twin-apply-")) { replaced = true; await rename(parent, saved); await mkdir(parent); await link(join(saved, "file"), join(parent, "file")); } return handle;
    }); syncBuiltinESMExports();
    try { partial(await session.applyAffected()); expect(replaced).toBe(true); expect(await readFile(join(f.source, "folder/file"), "utf8")).toBe("base"); }
    finally { spy.mockRestore(); syncBuiltinESMExports(); if (replaced) { await rm(parent, { recursive: true }); await rename(saved, parent); } }
  }));
  it.each(["original", "copy"] as const)("fails late substituted %s ancestors without traversing aliases", async side => fixtureTest(async f => {
    await put(f.source, "folder/file", "base"); const session = await f.create(); await session.run(command('require("node:fs").writeFileSync("folder/file","copy")'));
    const root = side === "original" ? f.source : session.workspacePath, parent = join(root, "folder"), saved = join(f.path, `saved-${side}`); let replaced = false;
    const real = fsPromises.open, spy = vi.spyOn(fsPromises, "open").mockImplementation(async (...args) => { const handle = await real(...args); if (!replaced && String(args[0]).includes("/.twin-apply-")) { replaced = true; await rename(parent, saved); await symlink(saved, parent); } return handle; }); syncBuiltinESMExports();
    try { partial(await session.applyAffected()); expect(await readFile(join(f.source, "folder/file"), "utf8")).toBe("base"); }
    finally { spy.mockRestore(); syncBuiltinESMExports(); if (replaced) { await unlink(parent); await rename(saved, parent); } }
  }));
  it.each(["before", "after-open", "issued-open", "after-rename"] as const)("classifies cancellation %s by mutation attempts", async kind => fixtureTest(async f => {
    await put(f.source, "file", "base"); const controller = new AbortController(); const session = await createTwin({ sourceDirectory: f.source, scratchParent: f.scratch, scanSignal: controller.signal }); f.sessions.push(session); await session.run(command(edited));
    if (kind === "before") controller.abort(); const realOpen = fsPromises.open, realRename = fsPromises.rename;
    const openSpy = vi.spyOn(fsPromises, "open").mockImplementation(async (...args) => { if (String(args[0]).includes("/.twin-apply-") && kind === "issued-open") { controller.abort(); throw new Error("issued open failed"); } const handle = await realOpen(...args); if (String(args[0]).includes("/.twin-apply-") && kind === "after-open") controller.abort(); return handle; });
    const renameSpy = vi.spyOn(fsPromises, "rename").mockImplementation(async (...args) => { await realRename(...args); if (String(args[0]).includes("/.twin-apply-") && kind === "after-rename") controller.abort(); }); syncBuiltinESMExports();
    try { const result = await session.applyAffected(); if (kind === "before") expect(result).toMatchObject({ status: "refused", reasonCode: "scan-cancelled" }); else partial(result); expect((await readdir(f.source)).filter(name => name.startsWith(".twin-apply-"))).toEqual([]); }
    finally { openSpy.mockRestore(); renameSpy.mockRestore(); syncBuiltinESMExports(); }
  }));
  it("reports final target modification after rename as partial", async () => fixtureTest(async f => {
    await put(f.source, "file", "base"); const session = await f.create(); await session.run(command(edited)); const real = fsPromises.rename;
    const spy = vi.spyOn(fsPromises, "rename").mockImplementation(async (...args) => { await real(...args); if (String(args[0]).includes("/.twin-apply-")) await writeFile(join(f.source, "file"), "late"); }); syncBuiltinESMExports();
    try { const result = await session.applyAffected(); partial(result); expect(result).toMatchObject({ phase: "final-verification", reasonCode: "final-state-mismatch", verifiedTargets: 0 }); }
    finally { spy.mockRestore(); syncBuiltinESMExports(); }
  }));
  it("preserves primary transfer failure and refuses to unlink replaced owned temp", async () => fixtureTest(async f => {
    await put(f.source, "file", "base"); const session = await f.create(); await session.run(command(edited)); const real = fsPromises.open; let temp = "", saved = "";
    const spy = vi.spyOn(fsPromises, "open").mockImplementation(async (...args) => { const handle = await real(...args); if (String(args[0]).includes("/.twin-apply-")) {
      temp = String(args[0]); saved = temp + "-saved"; await rename(temp, saved); await writeFile(temp, "foreign"); const write = handle.write.bind(handle);
      Object.defineProperty(handle, "write", { value: async (...values: Parameters<typeof write>) => { await write(...values); throw new Error("primary transfer error"); } });
    } return handle; }); syncBuiltinESMExports();
    try { const result = await session.applyAffected(); partial(result); expect(result).toMatchObject({ phase: "mutation", reasonCode: "io-unavailable", secondaryFailures: [expect.objectContaining({ phase: "temporary-cleanup", reasonCode: "temporary-cleanup-refused" })] }); expect(await readFile(temp, "utf8")).toBe("foreign"); expect(await readFile(join(f.source, "file"), "utf8")).toBe("base"); }
    finally { spy.mockRestore(); syncBuiltinESMExports(); if (temp) await unlink(temp); if (saved) await unlink(saved); }
  }));
});

describe("bounded scoped observer", () => {
  it("drains bounded coordinator work and refuses expired or cancelled phases", async () => fixtureTest(async f => {
    for (let i = 0; i < 25; i++) await put(f.source, `file-${i}`, "bytes");
    const pool = new IoPool(), observer = new AffectedObserver(f.source, { pool }); await observer.targets(Array.from({ length: 25 }, (_, i) => key(`file-${i}`)));
    expect(pool.inspect()).toMatchObject({ active: 0, queued: 0, waiters: 0 }); expect(pool.inspect().peakActive).toBeLessThanOrEqual(4); expect(pool.inspect().peakQueued).toBeLessThanOrEqual(8);
    const expired = new AffectedObserver(f.source, { timeoutMs: 1 }); await new Promise(resolve => setTimeout(resolve, 5)); await expect(expired.targets([key("file-0")])).rejects.toMatchObject({ code: "scan-timeout" });
    const controller = new AbortController(); const cancelled = new AffectedObserver(f.source, { signal: controller.signal, pool }); controller.abort(); await expect(cancelled.targets([key("file-0")])).rejects.toMatchObject({ code: "scan-cancelled" }); expect(pool.inspect()).toMatchObject({ active: 0, queued: 0, waiters: 0 });
  }));
  it.each(["short", "growth", "raw-mode"] as const)("refuses %s during exact scoped reads", async kind => fixtureTest(async f => {
    await put(f.source, "file", "base"); const real = fsPromises.open; let touched = false;
    const spy = vi.spyOn(fsPromises, "open").mockImplementation(async (...args) => { const handle = await real(...args); if (String(args[0]) === join(f.source, "file")) {
      const read = handle.read.bind(handle); Object.defineProperty(handle, "read", { value: async (...values: Parameters<typeof read>) => {
        if (kind === "short") return { bytesRead: 0, buffer: values[0] };
        const result = await read(...values); if (!touched) { touched = true; if (kind === "growth") await writeFile(join(f.source, "file"), "grown bytes"); else await chmod(join(f.source, "file"), 0o4644); } return result;
      } });
    } return handle; }); syncBuiltinESMExports();
    try { await expect(new AffectedObserver(f.source, {}).observe(key("file"))).rejects.toMatchObject({ code: kind === "short" ? "file-read-incomplete" : kind === "growth" ? "file-read-incomplete" : "target-identity-changed" }); }
    finally { spy.mockRestore(); syncBuiltinESMExports(); }
  }));
  it("refuses path, depth and hash byte bounds without accepting partial evidence", async () => fixtureTest(async f => {
    const observer = new AffectedObserver(f.source, {}); await expect(observer.observe(key("a".repeat(4097)))).rejects.toMatchObject({ code: "scope-limit" }); await expect(observer.observe(key(Array.from({ length: 129 }, () => "a").join("/")))).rejects.toMatchObject({ code: "scope-limit" });
    const sparse = await fsPromises.open(join(f.source, "large"), "wx"); try { await sparse.truncate(2 * 1024 * 1024 * 1024 + 1); } finally { await sparse.close(); }
    await expect(observer.observe(key("large"))).rejects.toMatchObject({ code: "scope-limit" });
  }));
});

describe("affected observation boundaries", () => {
  it.each(["original-before-write", "noop-final", "copy-final"] as const)("freshly checks %s without reusing phase observations", async kind => fixtureTest(async f => {
    await put(f.source, "file", "base"); let enabled = false, changed = false, workspace = "";
    const session = await createTwin({ sourceDirectory: f.source, scratchParent: f.scratch, onDiagnostic: event => {
      const stage = kind === "original-before-write" ? "apply.affected.before-write" : "apply.affected.final";
      if (enabled && !changed && event.kind === "begin" && event.stage === stage) { changed = true; writeFileSync(join(kind === "copy-final" ? workspace : f.source, "file"), "late"); }
    } }); f.sessions.push(session); workspace = session.workspacePath; await session.run(command(edited));
    if (kind === "noop-final") await writeFile(join(f.source, "file"), "copy"); enabled = true;
    const result = await session.applyAffected(); expect(changed).toBe(true);
    if (kind === "copy-final") { partial(result); expect(result).toMatchObject({ phase: "final-verification", reasonCode: "copy-target-changed" }); }
    else { expect(result).toMatchObject({ status: kind === "original-before-write" ? "conflict" : "refused", phase: kind === "original-before-write" ? "before-write" : "final-verification", scopeCoverage: "incomplete", verifiedTargets: 0 }); expect(result).not.toHaveProperty("partialApplicationPossible"); }
  }));
  it("rechecks no-op original and copy targets before writes", async () => fixtureTest(async f => {
    await put(f.source, "file", "base"); let enabled = false, workspace = "";
    const session = await createTwin({ sourceDirectory: f.source, scratchParent: f.scratch, onDiagnostic: event => {
      if (enabled && event.kind === "begin" && event.stage === "apply.affected.before-write") writeFileSync(join(workspace, "file"), "late");
    } }); f.sessions.push(session); workspace = session.workspacePath; await session.run(command(edited)); await writeFile(join(f.source, "file"), "copy"); enabled = true;
    expect(await session.applyAffected()).toMatchObject({ status: "refused", phase: "before-write", reasonCode: "copy-target-changed", plannedTargets: 1, verifiedTargets: 0 });
  }));
  it("retains unplanned child arriving after destructive removal has started", async () => fixtureTest(async f => {
    await put(f.source, "folder/file", "base"); const session = await f.create(); await session.run(command('require("node:fs").rmSync("folder",{recursive:true})'));
    const real = fsPromises.unlink; let changed = false;
    const spy = vi.spyOn(fsPromises, "unlink").mockImplementation(async (...args) => { await real(...args); if (String(args[0]) === join(f.source, "folder/file")) { changed = true; await writeFile(join(f.source, "folder/new-child"), "local"); } }); syncBuiltinESMExports();
    try { const result = await session.applyAffected(); partial(result); expect(result).toMatchObject({ reasonCode: "unplanned-subtree-child" }); expect(changed).toBe(true); expect(await readFile(join(f.source, "folder/new-child"), "utf8")).toBe("local"); }
    finally { spy.mockRestore(); syncBuiltinESMExports(); }
  }));
  it("rejects an observed substituted source parent before exclusive temp open", async () => fixtureTest(async f => {
    await put(f.source, "folder/file", "base"); const session = await f.create(); await session.run(command('require("node:fs").writeFileSync("folder/file","copy")'));
    const parent = join(f.source, "folder"), saved = join(f.path, "saved-pretemp"), real = fsPromises.open; let reads = 0, replaced = false, tempOpens = 0;
    const spy = vi.spyOn(fsPromises, "open").mockImplementation(async (...args) => {
      if (String(args[0]).includes("/.twin-apply-")) tempOpens++;
      const handle = await real(...args);
      // Preflight, before-write, verification, then independent transfer source reader.
      if (String(args[0]) === join(session.workspacePath, "folder/file") && ++reads === 4) { replaced = true; await rename(parent, saved); await symlink(saved, parent); }
      return handle;
    }); syncBuiltinESMExports();
    try { expect(await session.applyAffected()).toMatchObject({ status: "refused", phase: "mutation", reasonCode: "unsafe-ancestor" }); expect(replaced).toBe(true); expect(tempOpens).toBe(0); }
    finally { spy.mockRestore(); syncBuiltinESMExports(); if (replaced) { await unlink(parent); await rename(saved, parent); } }
  }));
  it("reports descriptor registration failure and retains unowned temporary entry", async () => fixtureTest(async f => {
    await put(f.source, "file", "base"); const session = await f.create(); await session.run(command(edited)); const real = fsPromises.open; let temp = "";
    const spy = vi.spyOn(fsPromises, "open").mockImplementation(async (...args) => {
      const handle = await real(...args); if (String(args[0]).includes("/.twin-apply-")) { temp = String(args[0]); Object.defineProperty(handle, "stat", { value: async () => { throw new Error("registration failure"); } }); } return handle;
    }); syncBuiltinESMExports();
    try { const result = await session.applyAffected(); partial(result); expect(result).toMatchObject({ reasonCode: "io-unavailable", secondaryFailures: [expect.objectContaining({ phase: "temporary-cleanup", reasonCode: "temporary-cleanup-refused" })] }); expect((await lstat(temp)).isFile()).toBe(true); }
    finally { spy.mockRestore(); syncBuiltinESMExports(); if (temp) await unlink(temp); }
  }));
  it("reports cleanup-only failure and never unlinks a same-name replacement", async () => fixtureTest(async f => {
    await put(f.source, "file", "base"); const session = await f.create(); await session.run(command(edited)); const real = fsPromises.rename; let temp = "";
    const spy = vi.spyOn(fsPromises, "rename").mockImplementation(async (...args) => { await real(...args); if (String(args[0]).includes("/.twin-apply-")) { temp = String(args[0]); await writeFile(temp, "foreign"); } }); syncBuiltinESMExports();
    try { const result = await session.applyAffected(); partial(result); expect(result).toMatchObject({ phase: "temporary-cleanup", reasonCode: "temporary-cleanup-refused" }); expect(await readFile(temp, "utf8")).toBe("foreign"); expect(await readFile(join(f.source, "file"), "utf8")).toBe("copy"); }
    finally { spy.mockRestore(); syncBuiltinESMExports(); if (temp) await unlink(temp); }
  }));
  it("refuses scoped FIFO targets without blocking or accepting absent state", async () => fixtureTest(async f => {
    await put(f.source, "file", "base"); const session = await f.create(); await session.run(command(edited)); await unlink(join(f.source, "file"));
    const fifo = join(f.source, "file"); try { await execute("/usr/bin/mkfifo", [fifo]); expect(await session.applyAffected()).toMatchObject({ status: "refused", reasonCode: "unsafe-target" }); } finally { await unlink(fifo); }
  }));
  it.each(["original", "copy"] as const)("retains copy and reports root %s substitution after temp creation", async side => fixtureTest(async f => {
    await put(f.source, "file", "base"); const session = await f.create(); await session.run(command(edited)); const root = side === "original" ? f.source : session.workspacePath, saved = join(f.path, `root-${side}`); const real = fsPromises.open; let replaced = false;
    const spy = vi.spyOn(fsPromises, "open").mockImplementation(async (...args) => { const handle = await real(...args); if (!replaced && String(args[0]).includes("/.twin-apply-")) { replaced = true; await rename(root, saved); await mkdir(root, { mode: 0o700 }); await link(join(saved, "file"), join(root, "file")); } return handle; }); syncBuiltinESMExports();
    try { partial(await session.applyAffected()); expect(replaced).toBe(true); expect(await readFile(join(root, "file"), "utf8")).toBe(side === "original" ? "base" : "copy"); }
    finally { spy.mockRestore(); syncBuiltinESMExports(); if (replaced) { await rm(root, { recursive: true }); await rename(saved, root); } }
  }));
  it("preserves interrupted-read metadata and close errors as secondary failures", async () => fixtureTest(async f => {
    await put(f.source, "file", "base"); const controller = new AbortController(), real = fsPromises.open; let closed = false;
    const spy = vi.spyOn(fsPromises, "open").mockImplementation(async (...args) => { const handle = await real(...args); if (String(args[0]) === join(f.source, "file")) {
      const read = handle.read.bind(handle), close = handle.close.bind(handle); Object.defineProperty(handle, "read", { value: async (...values: Parameters<typeof read>) => { const result = await read(...values); controller.abort(); await chmod(join(f.source, "file"), 0o4644); return result; } });
      Object.defineProperty(handle, "close", { value: async () => { await close(); closed = true; throw new Error("close failure"); } });
    } return handle; }); syncBuiltinESMExports();
    try { await expect(new AffectedObserver(f.source, { signal: controller.signal }).observe(key("file"))).rejects.toMatchObject({ code: "scan-cancelled", secondary: [expect.objectContaining({ code: "target-identity-changed" }), expect.objectContaining({ code: "io-unavailable" })] }); expect(closed).toBe(true); }
    finally { spy.mockRestore(); syncBuiltinESMExports(); }
  }));
});

it("shares session locks and settlement gates without weakening default Apply", async () => fixtureTest(async f => {
  await put(f.source, "file", "base"); const session = await f.create();
  const running = session.run(command(`${edited};setTimeout(()=>{},100)`)); expect(await session.applyAffected()).toMatchObject({ status: "refused", reasonCode: "settlement-uncertain" }); await running;
  const applying = session.applyAffected(); expect(await session.applyAffected()).toMatchObject({ status: "refused", phase: "admission" }); expect(await session.apply()).toMatchObject({ status: "refused" });
  await expect(session.discard()).rejects.toThrow("Cannot discard Twin in state applying"); expect(await applying).toMatchObject({ status: "applied", changes: 1 }); expect(session.inspect().state).toBe("finished");
}));

it.each([false, true])("collapses nested destructive roots without omitting operations, unknownChild=%s", async unknown => fixtureTest(async f => {
  await put(f.source, "outer/inner/file", "base"); const session = await f.create(); await session.run(command('require("node:fs").rmSync("outer",{recursive:true})'));
  if (unknown) await put(f.source, "outer/inner/local", "local");
  const result = await session.applyAffected(); expect(result).toMatchObject({ plannedTargets: 3, destructiveSubtrees: 1 });
  if (unknown) { expect(result).toMatchObject({ status: "conflict", reasonCode: "unplanned-subtree-child", verifiedTargets: 0 }); expect(await readFile(join(f.source, "outer/inner/file"), "utf8")).toBe("base"); expect(await readFile(join(f.source, "outer/inner/local"), "utf8")).toBe("local"); }
  else { expect(result).toMatchObject({ status: "applied", changes: 3, verifiedTargets: 3 }); await expect(lstat(join(f.source, "outer"))).rejects.toThrow(); }
}));


describe("affected temporary permission verification", () => {
  it.each([0o644, 0o755].flatMap(mode => [false, true].map(replacement => ({ mode, replacement }))))("preserves mode $mode, replacement=$replacement", async ({ mode, replacement }) => fixtureTest(async f => {
    if (replacement) await put(f.source, "file", "base");
    const session = await f.create(); await session.run(command(`${edited};require("node:fs").chmodSync("file",${mode})`));
    expect(await session.applyAffected()).toMatchObject({ status: "applied", verifiedTargets: 1 });
    expect((await lstat(join(f.source, "file"))).mode & 0o777).toBe(mode);
    expect(await readFile(join(f.source, "file"), "utf8")).toBe("copy");
  }));
  it.each([false, true])("blocks ineffective successful chmod, replacement=%s", async replacement => fixtureTest(async f => {
    if (replacement) await put(f.source, "file", "base");
    const session = await f.create(); await session.run(command(edited)); const real = fsPromises.open; let temp = "";
    const spy = vi.spyOn(fsPromises, "open").mockImplementation(async (...args) => {
      const handle = await real(...args); if (String(args[0]).includes("/.twin-apply-")) { temp = String(args[0]); Object.defineProperty(handle, "chmod", { value: async () => {} }); } return handle;
    }); syncBuiltinESMExports();
    try {
      const result = await session.applyAffected(); partial(result); expect(result).toMatchObject({ reasonCode: "mode-not-preserved", phase: "mutation", verifiedTargets: 0 });
      if (replacement) expect(await readFile(join(f.source, "file"), "utf8")).toBe("base"); else await expect(lstat(join(f.source, "file"))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(lstat(temp)).rejects.toMatchObject({ code: "ENOENT" }); expect((await lstat(session.workspacePath)).isDirectory()).toBe(true);
    } finally { spy.mockRestore(); syncBuiltinESMExports(); }
  }));
  it.each(["identity", "type", "links"] as const)("revalidates descriptor %s after chmod", async kind => fixtureTest(async f => {
    const session = await f.create(); await session.run(command(edited)); const real = fsPromises.open;
    const spy = vi.spyOn(fsPromises, "open").mockImplementation(async (...args) => {
      const handle = await real(...args); if (String(args[0]).includes("/.twin-apply-")) {
        const stat = handle.stat.bind(handle); let calls = 0;
        Object.defineProperty(handle, "stat", { value: async () => { const result = await stat({ bigint: true }); if (++calls === 2) { if (kind === "identity") result.ino += 1n; else if (kind === "links") result.nlink = 2n; else result.mode = 0o40644n; } return result; } });
      } return handle;
    }); syncBuiltinESMExports();
    try { const result = await session.applyAffected(); partial(result); expect(result).toMatchObject({ reasonCode: "target-identity-changed", phase: "mutation" }); await expect(lstat(join(f.source, "file"))).rejects.toMatchObject({ code: "ENOENT" }); }
    finally { spy.mockRestore(); syncBuiltinESMExports(); }
  }));
  it("blocks fresh path mode disagreement after a truthful descriptor readback", async () => fixtureTest(async f => {
    const session = await f.create(); await session.run(command(edited)); const real = fsPromises.open; let temp = "";
    const spy = vi.spyOn(fsPromises, "open").mockImplementation(async (...args) => {
      const handle = await real(...args); if (String(args[0]).includes("/.twin-apply-")) { temp = String(args[0]); const close = handle.close.bind(handle); Object.defineProperty(handle, "close", { value: async () => { await close(); await chmod(temp, 0o600); } }); } return handle;
    }); syncBuiltinESMExports();
    try { const result = await session.applyAffected(); partial(result); expect(result).toMatchObject({ reasonCode: "mode-not-preserved", phase: "mutation" }); await expect(lstat(join(f.source, "file"))).rejects.toMatchObject({ code: "ENOENT" }); await expect(lstat(temp)).rejects.toMatchObject({ code: "ENOENT" }); }
    finally { spy.mockRestore(); syncBuiltinESMExports(); }
  }));
  it.each(["unlink-error", "replacement", "close-error"] as const)("preserves primary mode failure with %s", async kind => fixtureTest(async f => {
    await put(f.source, "file", "base"); const session = await f.create(); await session.run(command(edited));
    const realOpen = fsPromises.open, realUnlink = fsPromises.unlink; let temp = "", saved = "";
    const openSpy = vi.spyOn(fsPromises, "open").mockImplementation(async (...args) => {
      const handle = await realOpen(...args); if (String(args[0]).includes("/.twin-apply-")) {
        temp = String(args[0]); Object.defineProperty(handle, "chmod", { value: async () => { if (kind === "replacement") { saved = join(f.source, "saved-temp"); await rename(temp, saved); await writeFile(temp, "foreign"); } } });
        if (kind === "close-error") { const close = handle.close.bind(handle); Object.defineProperty(handle, "close", { value: async () => { await close(); throw new Error("close failure"); } }); }
      } return handle;
    });
    const unlinkSpy = vi.spyOn(fsPromises, "unlink").mockImplementation(async (...args) => { if (kind === "unlink-error" && String(args[0]) === temp) throw new Error("cleanup failure"); await realUnlink(...args); }); syncBuiltinESMExports();
    try {
      const result = await session.applyAffected(); partial(result); expect(result).toMatchObject({ reasonCode: "mode-not-preserved", phase: "mutation", secondaryFailures: [expect.objectContaining({ reasonCode: kind === "close-error" ? "io-unavailable" : "temporary-cleanup-refused" })] });
      expect(await readFile(join(f.source, "file"), "utf8")).toBe("base"); expect((await lstat(session.workspacePath)).isDirectory()).toBe(true);
      if (kind === "replacement") expect(await readFile(temp, "utf8")).toBe("foreign");
    } finally { openSpy.mockRestore(); unlinkSpy.mockRestore(); syncBuiltinESMExports(); if (kind !== "close-error" && temp) await unlink(temp); if (saved) await unlink(saved); }
  }));
  it("still rejects post-rename mode drift in final verification", async () => fixtureTest(async f => {
    const session = await f.create(); await session.run(command(edited)); const real = fsPromises.rename;
    const spy = vi.spyOn(fsPromises, "rename").mockImplementation(async (...args) => { await real(...args); if (String(args[0]).includes("/.twin-apply-")) await chmod(args[1], 0o600); }); syncBuiltinESMExports();
    try { const result = await session.applyAffected(); partial(result); expect(result).toMatchObject({ reasonCode: "final-state-mismatch", phase: "final-verification", verifiedTargets: 0 }); expect(await readFile(join(f.source, "file"), "utf8")).toBe("copy"); expect((await lstat(join(f.source, "file"))).mode & 0o777).toBe(0o600); }
    finally { spy.mockRestore(); syncBuiltinESMExports(); }
  }));
});
