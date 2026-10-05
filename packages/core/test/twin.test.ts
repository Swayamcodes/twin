import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import fsPromises, { chmod, mkdir, readdir, readFile, rename, symlink, unlink } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createTwin, type TwinSession } from "../src/index.js";
import * as globalNpm from "../src/global-npm.js";
import * as manifests from "../src/manifest.js";
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


describe("inventory policy and cancellation", () => {
  it("captures one policy for every preparation, receipt and apply inventory", async () => fixtureTest(async f => {
    await put(f.source, "file", "base");
    const controller = new AbortController();
    const options = { sourceDirectory: f.source, scratchParent: f.scratch, scanTimeoutMs: 45678, scanSignal: controller.signal };
    const scan = vi.spyOn(manifests, "captureManifest");
    const views = vi.spyOn(manifests, "captureManifestViews");
    try {
      const session = await createTwin(options); f.sessions.push(session);
      options.scanTimeoutMs = 1;
      await session.run(nodeOptions("edit"));
      expect(await session.apply()).toMatchObject({ status: "applied" });
      expect(scan.mock.calls.length + views.mock.calls.length).toBeGreaterThanOrEqual(10);
      expect(views).toHaveBeenCalledTimes(2);
      for (const call of views.mock.calls) expect(call[1]).toMatchObject({ timeoutMs: 45678, signal: controller.signal });
      for (const call of scan.mock.calls) expect(call[2]).toMatchObject({ timeoutMs: 45678, signal: controller.signal });
    } finally { views.mockRestore(); scan.mockRestore(); }
  }));
  it("rejects invalid budgets and pre-aborted preparation before allocation", async () => fixtureTest(async f => {
    const controller = new AbortController(); controller.abort();
    await expect(createTwin({ sourceDirectory: f.source, scratchParent: f.scratch, scanTimeoutMs: 0 })).rejects.toThrow("Invalid Twin scan timeout");
    await expect(createTwin({ sourceDirectory: f.source, scratchParent: f.scratch, scanSignal: controller.signal })).rejects.toThrow("Scan cancelled");
    await expect(createTwin({ sourceDirectory: f.source, scratchParent: f.scratch, scanSignal: { aborted: false } as AbortSignal })).rejects.toThrow("Invalid Twin scan signal");
    expect(await readdir(f.scratch)).toEqual([]);
  }));
  it("settles preparation and guarded cleanup after cancellation during inventory", async () => fixtureTest(async f => {
    await put(f.source, "file", "base");
    const controller = new AbortController(); const real = manifests.captureManifest;
    const scan = vi.spyOn(manifests, "captureManifest").mockImplementation(async (...args) => {
      const result = await real(...args); controller.abort(); return result;
    });
    try {
      await expect(createTwin({ sourceDirectory: f.source, scratchParent: f.scratch, scanSignal: controller.signal })).rejects.toThrow('cleanup={"status":"removed"}');
      expect(await readdir(f.scratch)).toEqual([]);
    } finally { scan.mockRestore(); }
  }));
  it("pre-handoff scan cancellation leaves the child settled and permits discard", async () => fixtureTest(async f => {
    const controller = new AbortController();
    const session = await createTwin({ sourceDirectory: f.source, scratchParent: f.scratch, scanSignal: controller.signal }); f.sessions.push(session);
    controller.abort();
    await expect(session.run(nodeOptions("echo"))).rejects.toThrow("Scan cancelled");
    expect(session.inspect().state).toBe("ready");
    expect(await session.discard()).toMatchObject({ status: "removed" });
  }));
});

it.each(["scan", "command"])("rechecks %s interruption after the pre-launch observer", async kind => fixtureTest(async f => {
  const controller = new AbortController();
  const session = await createTwin({ sourceDirectory: f.source, scratchParent: f.scratch, ...(kind === "scan" ? { scanSignal: controller.signal } : {}) }); f.sessions.push(session);
  const observer = vi.spyOn(globalNpm, "captureGlobalNpm").mockImplementation(async () => {
    controller.abort(); return { versions: new Map(), coverage: "complete", issues: [] };
  });
  const spawn = vi.spyOn(childProcess, "spawn"); syncBuiltinESMExports();
  try {
    await expect(session.run({ ...nodeOptions("echo"), env: { NPM_CONFIG_PREFIX: join(f.path, "prefix") }, ...(kind === "command" ? { interruptSignal: controller.signal } : {}) })).rejects.toThrow(kind === "scan" ? "Scan cancelled" : "Interrupted before command launch");
    expect(observer).toHaveBeenCalledOnce(); expect(spawn).not.toHaveBeenCalled();
    expect(session.inspect().state).toBe("ready");
    expect(await session.discard()).toMatchObject({ status: "removed" });
  } finally { observer.mockRestore(); spawn.mockRestore(); syncBuiltinESMExports(); }
}));
it("scan-only cancellation after handoff preserves independent command execution", async () => fixtureTest(async f => {
  const controller = new AbortController();
  const session = await createTwin({ sourceDirectory: f.source, scratchParent: f.scratch, scanSignal: controller.signal }); f.sessions.push(session);
  const spawnReal = childProcess.spawn;
  const spawn = vi.spyOn(childProcess, "spawn").mockImplementation((...args: Parameters<typeof spawnReal>) => {
    const child = spawnReal(...args); controller.abort(); return child;
  }); syncBuiltinESMExports();
  try {
    expect((await session.run(nodeOptions("echo"))).exitCode).toBe(0);
    expect(session.inspect().state).toBe("finished");
    expect(session.inspect().receipt?.files).toMatchObject({ coverage: "partial", issues: expect.arrayContaining([expect.objectContaining({ reason: "scan-cancelled" })]) });
    expect(await session.apply()).toMatchObject({ status: "refused" });
    expect(await session.discard()).toMatchObject({ status: "removed" });
  } finally { spawn.mockRestore(); syncBuiltinESMExports(); }
}));

it("uses the later preparation boundary and fresh views after the action, with fresh original/apply reads", async () => fixtureTest(async f => {
  await put(f.source, "file", "base");
  const original = manifests.captureManifest, full = manifests.captureManifestViews;
  const reads: string[] = []; let late = false;
  const scan = vi.spyOn(manifests, "captureManifest").mockImplementation(async (...args) => {
    reads.push(String(args[0])); const result = await original(...args);
    if (!late && String(args[0]) === f.source) {
      late = true; const allocation = (await readdir(f.scratch))[0]!;
      await fsPromises.writeFile(join(f.scratch, allocation, "workspace/file"), "late baseline");
    }
    return result;
  });
  const views = vi.spyOn(manifests, "captureManifestViews");
  try {
    const session = await f.create();
    expect(views).toHaveBeenCalledOnce(); expect(reads).toEqual([f.source]);
    expect((await session.run({ executable: process.execPath, argv: ["-e", "require('fs').writeFileSync('file','agent edit')"], env: {} })).exitCode).toBe(0);
    expect(views).toHaveBeenCalledTimes(2);
    expect(session.inspect().receipt?.files.changes).toEqual([expect.objectContaining({ change: "modified", path: { encoding: "utf8", value: "file" } })]);
    expect(await session.apply()).toMatchObject({ status: "refused", reason: "Original and copy baseline differ" });
    expect(reads.filter(x => x === f.source)).toHaveLength(2);
    expect(await readFile(join(f.source, "file"), "utf8")).toBe("base");
    expect(full).toBeDefined();
  } finally { scan.mockRestore(); views.mockRestore(); }
}));
