import { chmod, lstat, mkdir, readFile, rename, rmdir, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { fixtureTest, nodeOptions, put } from "./support.js";

describe("guarded discard", () => {
  it("unlinks copied links and command-created external links, leaving targets untouched", async () => fixtureTest(async f => {
    await put(f.source, "dir/file", "source bytes");
    await symlink("dir", join(f.source, "copied-link"));
    await symlink("missing", join(f.source, "dangling"));
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
