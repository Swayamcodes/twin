import { chmod, lstat, mkdir, readFile, readlink, readdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import { createServer } from "node:net";
import { describe, expect, it } from "vitest";
import { fixtureTest, fingerprint, put } from "./support.js";

describe("ordinary copying", () => {
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
