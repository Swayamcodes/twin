import fsPromises, { mkdir, rename, writeFile, unlink, symlink } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { fixtureTest, put } from "./support.js";
import { captureDependencies, compareDependencies, unavailableDependencies } from "../src/dependencies.js";

const manifest = (dependencies: Record<string, string> = {}): string => JSON.stringify({ dependencies });
const lock = (version: string): string => JSON.stringify({ name: "fixture", lockfileVersion: 3, packages: { "": { version } } });

describe("project dependency receipt", () => {
  it("rejects a pathname replaced during a valid descriptor read", async () => fixtureTest(async f => {
    const original = manifest({ alpha: "1" });
    const replacement = manifest({ bravo: "2" });
    expect(Buffer.byteLength(replacement)).toBe(Buffer.byteLength(original));
    await put(f.source, "package.json", original);
    const path = join(f.source, "package.json");
    const realOpen = fsPromises.open;
    let opened: Awaited<ReturnType<typeof realOpen>> | undefined;
    let replaced = false;
    const spy = vi.spyOn(fsPromises, "open").mockImplementation(async (...args) => {
      const handle = await realOpen(...args);
      if (String(args[0]) === path) {
        opened = handle;
        const realRead = handle.read.bind(handle);
        vi.spyOn(handle, "read").mockImplementation((async (buffer: Buffer, offset: number, length: number, position: number | null) => {
          if (!replaced) {
            replaced = true;
            await rename(f.source, join(f.path, "moved-source"));
            await mkdir(f.source);
            await writeFile(path, replacement, { flag: "wx" });
          }
          return realRead(buffer, offset, length, position);
        }) as typeof handle.read);
      }
      return handle;
    });
    syncBuiltinESMExports();
    try {
      const snapshot = await captureDependencies(f.source);
      expect(replaced).toBe(true);
      expect(snapshot.declarations).toBeNull();
      expect(snapshot.issues).toContainEqual({ path: "package.json", reason: "replaced" });
      expect(compareDependencies(snapshot, snapshot).declarations).toEqual({ coverage: "incomplete", changes: [] });
      expect(opened).toBeDefined();
      await expect(opened!.stat()).rejects.toThrow();
    } finally { spy.mockRestore(); syncBuiltinESMExports(); }
  }));

  it("captures declarations through a settled Twin run without changing file or watch reporting", async () => fixtureTest(async f => {
    await put(f.source, "package.json", manifest({ old: "1" }));
    const session = await f.create();
    const script = `require('node:fs').writeFileSync('package.json', ${JSON.stringify(manifest({ next: "2" }))})`;
    const result = await session.run({ executable: process.execPath, argv: ["-e", script], env: {} });
    expect(result.exitCode).toBe(0);
    const receipt = session.inspect().receipt!;
    expect(receipt.schemaVersion).toBe(3);
    expect(receipt.dependencies.declarations.changes).toEqual([
      { field: "dependencies", name: "next", change: "added", before: null, after: "2" },
      { field: "dependencies", name: "old", change: "removed", before: "1", after: null },
    ]);
    expect(receipt.files.changes).toEqual([expect.objectContaining({ path: { encoding: "utf8", value: "package.json" }, change: "modified" })]);
    expect(receipt.watch).toHaveLength(7);
    expect(Object.isFrozen(receipt.dependencies)).toBe(true);
  }));

  it("reports additions, removals, version changes and unchanged declarations", async () => fixtureTest(async f => {
    await put(f.source, "package.json", manifest({ removed: "1", changed: "^1", same: "2" }));
    const before = await captureDependencies(f.source);
    await writeFile(join(f.source, "package.json"), manifest({ added: "3", changed: "^2", same: "2" }));
    const receipt = compareDependencies(before, await captureDependencies(f.source));
    expect(receipt.declarations).toEqual({ coverage: "complete", changes: [
      { field: "dependencies", name: "added", change: "added", before: null, after: "3" },
      { field: "dependencies", name: "changed", change: "changed", before: "^1", after: "^2" },
      { field: "dependencies", name: "removed", change: "removed", before: "1", after: null },
    ] });
    expect(receipt.lockfiles).toEqual({ coverage: "complete", changes: [] });
    expect("installed" in receipt).toBe(false);
  }));

  it("separates lockfile-only changes from declarations and unchanged inputs", async () => fixtureTest(async f => {
    await put(f.source, "package.json", manifest({ stable: "1" }));
    await put(f.source, "package-lock.json", lock("1"));
    await put(f.source, "pnpm-lock.yaml", "lockfileVersion: '9.0'\nimporters: {}\n");
    const first = await captureDependencies(f.source);
    expect(compareDependencies(first, await captureDependencies(f.source))).toMatchObject({
      declarations: { coverage: "complete", changes: [] }, lockfiles: { coverage: "complete", changes: [] }, issues: [],
    });
    await writeFile(join(f.source, "package-lock.json"), lock("2"));
    const receipt = compareDependencies(first, await captureDependencies(f.source));
    expect(receipt.declarations.changes).toEqual([]);
    expect(receipt.lockfiles.changes).toEqual([expect.objectContaining({ path: "package-lock.json", change: "changed" })]);
  }));

  it("marks malformed, oversized and replaced inputs incomplete", async () => fixtureTest(async f => {
    await put(f.source, "package.json", "{");
    await put(f.source, "package-lock.json", "not json");
    await put(f.source, "pnpm-lock.yaml", "not yaml");
    const bad = compareDependencies(await captureDependencies(f.source), await captureDependencies(f.source));
    expect(bad.declarations.coverage).toBe("incomplete");
    expect(bad.lockfiles.coverage).toBe("incomplete");
    expect(bad.issues).toEqual(expect.arrayContaining([
      { phase: "before", path: "package.json", reason: "malformed" },
      { phase: "after", path: "package-lock.json", reason: "malformed" },
      { phase: "after", path: "pnpm-lock.yaml", reason: "malformed" },
    ]));
    await writeFile(join(f.source, "package.json"), "x".repeat(1024 * 1024 + 1));
    await unlink(join(f.source, "package-lock.json"));
    await symlink("package.json", join(f.source, "package-lock.json"));
    const unavailable = compareDependencies(await captureDependencies(f.source), await captureDependencies(f.source));
    expect(unavailable.issues).toEqual(expect.arrayContaining([
      { phase: "before", path: "package.json", reason: "oversized" },
      { phase: "after", path: "package-lock.json", reason: "replaced" },
    ]));
  }));

  it("closes coverage on missing post-run and unavailable observations", async () => fixtureTest(async f => {
    await put(f.source, "package.json", manifest({ gone: "1" }));
    await put(f.source, "package-lock.json", lock("1"));
    const before = await captureDependencies(f.source);
    await unlink(join(f.source, "package.json"));
    await unlink(join(f.source, "package-lock.json"));
    const missing = compareDependencies(before, await captureDependencies(f.source));
    expect(missing.declarations).toEqual({ coverage: "incomplete", changes: [] });
    expect(missing.lockfiles).toMatchObject({ coverage: "incomplete", changes: [{ path: "package-lock.json", change: "removed" }] });
    expect(missing.issues).toEqual(expect.arrayContaining([
      { phase: "after", path: "package.json", reason: "missing" },
      { phase: "after", path: "package-lock.json", reason: "missing" },
    ]));
    const unavailable = compareDependencies(before, unavailableDependencies("child-unsettled"));
    expect(unavailable.declarations.coverage).toBe("unavailable");
    expect(unavailable.lockfiles.coverage).toBe("unavailable");
    expect(unavailable.issues).toContainEqual({ phase: "after", path: "package.json", reason: "child-unsettled" });
  }));
});
