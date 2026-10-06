import fsPromises, { chmod, lstat, mkdir, readFile, readlink, readdir, symlink, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { createServer } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { fixtureTest, fingerprint, put } from "./support.js";
import { allocateRoot, discardRoot } from "../src/safety.js";
import { copySource } from "../src/copy.js";
import { IoPool } from "../src/io-pool.js";

describe("ordinary copying", () => {
  it("bounds independent regular-file workers and restores directory modes after all file handles close", async () => fixtureTest(async f => {
    for (let index = 0; index < 24; index++) await put(f.source, `nested/file-${String(index).padStart(2, "0")}`, "independent bytes");
    await chmod(join(f.source, "nested"), 0o755);
    const root = await allocateRoot({ sourceDirectory: f.source, scratchParent: f.scratch });
    const pool = new IoPool();
    let active = 0, peak = 0;
    const realOpen = fsPromises.open;
    const spy = vi.spyOn(fsPromises, "open").mockImplementation(async (...args) => {
      const handle = await realOpen(...args);
      if (typeof args[0] === "string" && args[0].startsWith(`${f.source}/nested/`)) {
        active++; peak = Math.max(peak, active);
        const close = handle.close.bind(handle);
        vi.spyOn(handle, "close").mockImplementationOnce(async () => { await close(); active--; });
      }
      return handle;
    });
    const realChmod = fsPromises.chmod;
    const modes = vi.spyOn(fsPromises, "chmod").mockImplementation(async (...args) => {
      if (args[0] === join(root.workspace, "nested") && args[1] === 0o755) expect(active).toBe(0);
      return realChmod(...args);
    });
    syncBuiltinESMExports();
    try {
      await copySource(root, { pool });
      expect(peak).toBeGreaterThan(1);
      expect(peak).toBeLessThanOrEqual(4);
      expect(active).toBe(0);
      expect(pool.inspect()).toMatchObject({ active: 0, queued: 0, waiters: 0 });
      expect(pool.inspect().peakQueued).toBeLessThanOrEqual(8);
      expect((await lstat(join(root.workspace, "nested"))).mode & 0o777).toBe(0o755);
      for (let index = 0; index < 24; index++) expect(await readFile(join(root.workspace, `nested/file-${String(index).padStart(2, "0")}`), "utf8")).toBe("independent bytes");
    } finally {
      spy.mockRestore(); modes.mockRestore(); syncBuiltinESMExports();
      expect(await discardRoot(root)).toEqual({ status: "removed" });
    }
  }));

  it("rejects source metadata changes after transfer before accepting the file", async () => fixtureTest(async f => {
    await put(f.source, "changing", "original bytes");
    const source = join(f.source, "changing");
    const realOpen = fsPromises.open;
    let changed = false;
    const spy = vi.spyOn(fsPromises, "open").mockImplementation(async (...args) => {
      const handle = await realOpen(...args);
      if (args[0] === source) {
        const realStat = handle.stat.bind(handle);
        vi.spyOn(handle, "stat").mockImplementation(async (...statArgs) => {
          if (!changed) changed = true;
          else await writeFile(source, "changed bytes!");
          return realStat(...statArgs);
        });
      }
      return handle;
    });
    syncBuiltinESMExports();
    try {
      await expect(f.create()).rejects.toMatchObject({ cause: { message: "Source file changed: changing" } });
      expect(await readdir(f.scratch)).toEqual([]);
    } finally { spy.mockRestore(); syncBuiltinESMExports(); }
  }));

  it("copies Git configuration from its single bounded validated data read", async () => fixtureTest(async f => {
    const config = "[core]\nbare = false\nworktree = ..\n";
    await put(f.source, ".git/config", config);
    const root = await allocateRoot({ sourceDirectory: f.source, scratchParent: f.scratch });
    const realOpen = fsPromises.open;
    let reads = 0;
    const spy = vi.spyOn(fsPromises, "open").mockImplementation(async (...args) => {
      const handle = await realOpen(...args);
      if (args[0] === join(f.source, ".git/config")) {
        const read = handle.read.bind(handle);
        vi.spyOn(handle, "read").mockImplementation(async (...readArgs) => { reads++; return read(...readArgs); });
      }
      return handle;
    });
    syncBuiltinESMExports();
    try {
      await copySource(root);
      expect(reads).toBe(2); // One data read and one EOF probe; no second transfer read.
      expect(await readFile(join(root.workspace, ".git/config"), "utf8")).toBe(config);
    } finally { spy.mockRestore(); syncBuiltinESMExports(); expect(await discardRoot(root)).toEqual({ status: "removed" }); }
  }));

  it.each(["entries", "entry-name", "depth"])("cleans up refused source discovery: %s", async kind => fixtureTest(async f => {
    if (kind === "depth") {
      let path = f.source;
      for (let index = 0; index < 129; index++) { path = join(path, "x"); await mkdir(path); }
    }
    const realRead = fsPromises.readdir;
    const spy = vi.spyOn(fsPromises, "readdir").mockImplementation(async (...args) => {
      if (args[0] === f.source && kind !== "depth") {
        const names = kind === "entry-name" ? [Buffer.from([0xff])]
          : Array.from({ length: 100001 }, () => Buffer.from("file"));
        return names as unknown as Awaited<ReturnType<typeof realRead>>;
      }
      return realRead(...args);
    });
    syncBuiltinESMExports();
    try {
      await expect(f.create()).rejects.toMatchObject({ message: expect.stringContaining('cleanup={"status":"removed"}') });
      expect(f.sessions).toEqual([]);
      expect(await readdir(f.scratch)).toEqual([]);
    } finally { spy.mockRestore(); syncBuiltinESMExports(); }
  }));
  it.each([false, true])("copies every file independently; Git=%s", async git => fixtureTest(async f => {
    const files = ["tracked", "untracked", ".env", ".gitignore", ".hidden/file", "node_modules/.pnpm/pkg/index.js"];
    for (const name of files) await put(f.source, name, Buffer.from([0, 255, 128, 10]), 0o751);
    await mkdir(join(f.source, "empty"));
    if (git) {
      await put(f.source, ".git/config", '[core]\nrepositoryformatversion = 0\nfilemode = true\nbare = false\nworktree = ..\n[remote "origin"]\nurl = https://example.invalid/repo\n');
      await put(f.source, ".git/HEAD", "ref: refs/heads/main\n");
      await mkdir(join(f.source, ".git/objects"));
      await mkdir(join(f.source, ".git/refs/heads"), { recursive: true });
    }
    const before = await fingerprint(f.source);
    const session = await f.create();
    expect((await lstat(join(session.workspacePath, "empty"))).isDirectory()).toBe(true);
    expect(await readdir(join(session.workspacePath, "empty"))).toEqual([]);
    for (const name of files) {
      expect(await readFile(join(session.workspacePath, name))).toEqual(await readFile(join(f.source, name)));
      expect((await lstat(join(session.workspacePath, name))).mode & 0o777).toBe(0o751);
      expect((await lstat(join(session.workspacePath, name))).ino).not.toBe((await lstat(join(f.source, name))).ino);
    }
    if (git) expect(await readFile(join(session.workspacePath, ".git/config"))).toEqual(await readFile(join(f.source, ".git/config")));
    expect((await lstat(join(session.workspacePath, "node_modules"))).mode & 0o777).toBe(0o700);
    expect(await fingerprint(f.source)).toBe(before);
  }));
  it("preserves relative pnpm, parent and dangling link text", async () => fixtureTest(async f => {
    await put(f.source, "node_modules/.pnpm/pkg/node_modules/pkg/index.js", "dependency");
    await symlink(".pnpm/pkg/node_modules/pkg", join(f.source, "node_modules/pkg"));
    await symlink("../missing", join(f.source, "node_modules/dangling"));
    await symlink("../node_modules/.pnpm/pkg", join(f.source, "node_modules/parent"));
    const session = await f.create();
    for (const name of ["pkg", "dangling", "parent"]) {
      const copied = join(session.workspacePath, "node_modules", name);
      expect((await lstat(copied)).isSymbolicLink()).toBe(true);
      expect(await readlink(copied)).toBe(await readlink(join(f.source, "node_modules", name)));
    }
  }));
  it("remaps absolute links including chains, root and dangling targets without touching originals", async () => fixtureTest(async f => {
    await put(f.source, "data/file", "original");
    await mkdir(join(f.source, "links"));
    const targets = { file: join(f.source, "data/file"), directory: `${join(f.source, "data")}/`, root: f.source,
      dangling: join(f.source, "missing"), chain: join(f.source, "links/file") };
    for (const [name, target] of Object.entries(targets)) await symlink(target, join(f.source, "links", name));
    await symlink("cycle-b", join(f.source, "cycle-a"));
    await symlink("cycle-a", join(f.source, "cycle-b"));
    await symlink(Buffer.from([0xff, 47, 0xfe]), join(f.source, "raw-dangling"));
    const before = await fingerprint(f.source);
    const session = await f.create();
    expect(await readlink(join(session.workspacePath, "links/file"))).toBe("../data/file");
    expect(await readlink(join(session.workspacePath, "links/directory"))).toBe("../data/");
    expect(await readlink(join(session.workspacePath, "links/root"))).toBe("..");
    expect(await readlink(join(session.workspacePath, "links/dangling"))).toBe("../missing");
    expect(await readlink(join(session.workspacePath, "links/chain"))).toBe("file");
    expect(await readFile(join(session.workspacePath, "links/chain"), "utf8")).toBe("original");
    expect(await readlink(join(session.workspacePath, "raw-dangling"), { encoding: "buffer" })).toEqual(Buffer.from([0xff, 47, 0xfe]));
    expect(await fingerprint(f.source)).toBe(before);
  }));
  it.each(["commondir", "gitdir", "worktrees", "modules", "objects/info/alternates", "objects/info/http-alternates", "config.worktree"])("refuses Git sentinel %s", async name => fixtureTest(async f => {
    await put(f.source, `.git/${name}`, "external");
    await expect(f.create()).rejects.toMatchObject({ cause: { message: `Unsupported Git layout: .git/${name}` } });
    expect(await readdir(f.scratch)).toEqual([]);
  }));
  it.each([".git", "nested/.git", ".gitmodules", "nested/.gitmodules"])("refuses Git pointer/layout %s", async name => fixtureTest(async f => {
    await put(f.source, name, "gitdir: /outside\n");
    await expect(f.create()).rejects.toMatchObject({ cause: { message: name === ".git"
      ? "Root .git must be an ordinary directory" : `Unsupported Git layout: ${name}` } });
  }));
  it.each([".git", ".git/HEAD"])("refuses metadata link %s", async name => fixtureTest(async f => {
    if (name !== ".git") await mkdir(join(f.source, ".git"));
    await symlink("missing", join(f.source, name));
    await expect(f.create()).rejects.toMatchObject({ cause: { message: name === ".git"
      ? "Root .git must be an ordinary directory" : `Unsupported symlink: ${name}` } });
  }));
  it.each([
    ['[InClUdE]\npath = other\n', "Unsupported Git include"],
    ['[includeIf "gitdir:foo"]\npath = other\n', "Unsupported Git include"],
    ['[CORE]\nWORKTREE = ../../elsewhere\n', "Unsupported external Git worktree"],
    ['[core]\nworktree = /absolute\n', "Unsupported external Git worktree"],
    ['[core]\nworktree = ../alias/../outside\n', "Unsupported external Git worktree"],
    ['[core]\nbare = TRUE\n', "Unsupported bare configuration"],
    ['[extensions]\nworktreeConfig = false\n', "Unsupported worktree configuration"],
    ['[core]\nworktree = ' + String.fromCharCode(92) + '\n..\n', "Ambiguous Git configuration"],
    ['[core]\nbare\n', "Malformed Git configuration"],
    ['[core]\nbare = "false"\n', "Ambiguous Git value"],
    ['[core.worktree]\nx = y\n', "Malformed Git configuration"],
    ['x = y\n', "Malformed Git configuration"],
    ['[core]\nworktree = .. # comment\n', "Ambiguous Git value"],
  ])("refuses unsupported/ambiguous config %j", async (config, reason) => fixtureTest(async f => {
    await put(f.source, ".git/config", config);
    await expect(f.create()).rejects.toMatchObject({ cause: { message: reason } });
  }));
  it.each(["socket", ".git"])("rejects socket %s without attempting to read it", async name => fixtureTest(async f => {
    const socketPath = join(f.source, name);
    const server = createServer();
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });
    try { await expect(f.create()).rejects.toThrow("Twin copy failed"); }
    finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  }));
  it("copies read-only file bytes without retaining special permission bits", async () => fixtureTest(async f => {
    await put(f.source, "readonly", "bytes", 0o444);
    await chmod(join(f.source, "readonly"), 0o2444);
    const session = await f.create();
    expect((await lstat(join(session.workspacePath, "readonly"))).mode & 0o7777).toBe(0o444);
  }));
  it.each(["", "nested/repository"])("refuses bare inventory at %j", async prefix => fixtureTest(async f => {
    const directory = join(f.source, prefix);
    await put(directory, "HEAD", "ref: refs/heads/main\n");
    await put(directory, "config", "[core]\nbare = true\n");
    await mkdir(join(directory, "objects"));
    await mkdir(join(directory, "refs"));
    await expect(f.create()).rejects.toMatchObject({ cause: { message: "Unsupported bare Git layout" } });
    expect(await readdir(f.scratch)).toEqual([]);
  }));
  it.each(["objects/info/alternates", "objects/info/http-alternates", "nested/objects/info/alternates"])("refuses bare alternate metadata %s independently of inventory", async name => fixtureTest(async f => {
    await put(f.source, name, "/outside\n");
    await expect(f.create()).rejects.toMatchObject({ cause: { message: `Unsupported bare Git alternates: ${name}` } });
    expect(await readdir(f.scratch)).toEqual([]);
  }));
  it.each([".GIT", "nested/.GIT", ".GITMODULES", "nested/.GITMODULES", ".git/CONFIG",
    ".git/COMMONDIR", ".git/GITDIR", ".git/WORKTREES", ".git/MODULES", ".git/CONFIG.WORKTREE",
    ".git/objects/info/ALTERNATES", ".git/objects/info/HTTP-ALTERNATES", ".git/OBJECTS", ".git/objects/INFO",
  ])("refuses case alias %s without filesystem case assumptions", async name => fixtureTest(async f => {
    await put(f.source, name, "[core]\nworktree = /outside\n");
    await expect(f.create()).rejects.toMatchObject({ cause: { message: `Noncanonical Git name: ${name}` } });
    expect(await readdir(f.scratch)).toEqual([]);
  }));
});

it.each(["success", "failure", "cancel"] as const)("reports copy drain only after files and handles settle: %s", async kind => fixtureTest(async f => {
  const { Diagnostics } = await import("../src/io-pool.js");
  const events: import("../src/io-pool.js").DiagnosticEvent[] = [];
  const diagnostics = new Diagnostics(event => { events.push(event); });
  await put(f.source, "file", "original");
  await put(f.source, "z-fail", "second");
  const controller = new AbortController(), failure = new Error("injected copy failure");
  const root = await allocateRoot({ sourceDirectory: f.source, scratchParent: f.scratch });
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  let opened!: () => void; const started = new Promise<void>(resolve => { opened = resolve; });
  const realOpen = fsPromises.open;
  const spy = vi.spyOn(fsPromises, "open").mockImplementation(async (...args) => {
    if (kind === "failure" && String(args[0]) === join(f.source, "z-fail")) { await started; throw failure; }
    const handle = await realOpen(...args);
    if (String(args[0]) === join(f.source, "file")) {
      const close = handle.close.bind(handle);
      Object.defineProperty(handle, "close", { value: async () => { opened(); await gate; await close(); } });
    }
    return handle;
  }); syncBuiltinESMExports();
  const copying = copySource(root, { diagnostics, signal: controller.signal });
  const outcome = copying.then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error: error as unknown }));
  try {
    await started; expect(events.some(event => event.kind === "drained")).toBe(false);
    if (kind === "cancel") controller.abort();
    release(); const result = await outcome;
    expect(result.ok).toBe(kind === "success");
    if (!result.ok && kind === "failure") expect(result.error).toBe(failure);
    expect(events.at(-2)).toMatchObject({ kind: "drained", stage: "preparation.copy" });
    expect(events.at(-2)?.metrics?.every(metric => metric.inflight === 0)).toBe(true);
    if (kind === "success") await writeFile(join(root.workspace, "file"), "copy edit");
    expect(await readFile(join(f.source, "file"), "utf8")).toBe("original");
  } finally {
    release(); await outcome; spy.mockRestore(); syncBuiltinESMExports();
    expect(await discardRoot(root)).toEqual({ status: "removed" });
  }
}));
