import { mkdir, rmdir, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fixtureTest } from "./support.js";
import { captureGlobalNpm, compareGlobalNpm, selectGlobalNpmRoot } from "../src/global-npm.js";

async function packageAt(root: string, name: string, version: string): Promise<void> {
  const path = join(root, name);
  await mkdir(path, { recursive: true });
  await writeFile(join(path, "package.json"), JSON.stringify({ name, version }));
}

describe("global npm inventory", () => {
  it("reports add, remove, version change and unchanged scoped packages", async () => fixtureTest(async f => {
    const prefix = join(f.path, "prefix");
    const root = join(prefix, "lib/node_modules");
    await mkdir(root, { recursive: true });
    await packageAt(root, "removed", "1.0.0");
    await packageAt(root, "changed", "1.0.0");
    await packageAt(root, "@scope/same", "2.0.0");
    const selected = selectGlobalNpmRoot({ NPM_CONFIG_PREFIX: prefix }, [], [f.source, f.scratch]);
    expect(selected).toEqual({ root });
    const before = await captureGlobalNpm(root);
    await unlink(join(root, "removed/package.json"));
    await rmdir(join(root, "removed"));
    await writeFile(join(root, "changed/package.json"), JSON.stringify({ name: "changed", version: "1.1.0" }));
    await packageAt(root, "@scope/added", "3.0.0");
    const after = await captureGlobalNpm(root);
    expect(compareGlobalNpm(selected, before, after)).toEqual({ coverage: "complete", source: "env-prefix", issues: [], changes: [
      { name: "@scope/added", change: "added", before: null, after: "3.0.0" },
      { name: "changed", change: "changed", before: "1.0.0", after: "1.1.0" },
      { name: "removed", change: "removed", before: "1.0.0", after: null },
    ] });
    expect(compareGlobalNpm(selected, after, after).changes).toEqual([]);
  }));

  it("treats absent node_modules as empty and rejects missing prefixes and overrides", async () => fixtureTest(async f => {
    const prefix = join(f.path, "prefix");
    await mkdir(prefix);
    expect((await captureGlobalNpm(join(prefix, "lib/node_modules"))).coverage).toBe("complete");
    expect((await captureGlobalNpm(join(f.path, "absent/lib/node_modules"))).reason).toBe("prefix-missing");
    expect(selectGlobalNpmRoot({}, [], [f.source]).reason).toBe("prefix-unset");
    expect(selectGlobalNpmRoot({ NPM_CONFIG_PREFIX: prefix, npm_config_prefix: f.source }, [], [f.source]).reason).toBe("prefix-conflict");
    expect(selectGlobalNpmRoot({ NPM_CONFIG_PREFIX: prefix }, ["--prefix", f.source], [f.source]).reason).toBe("prefix-override");
    expect(selectGlobalNpmRoot({ NPM_CONFIG_PREFIX: f.source }, [], [f.source]).reason).toBe("inside-protected-root");
  }));

  it("closes coverage for symlinks, malformed and unreadable metadata, and inventory limits", async () => fixtureTest(async f => {
    const root = join(f.path, "prefix/lib/node_modules");
    await mkdir(root, { recursive: true });
    await packageAt(root, "valid", "1.0.0");
    await mkdir(join(root, "bad"));
    await writeFile(join(root, "bad/package.json"), "{");
    await mkdir(join(root, "missing"));
    await mkdir(join(root, "linked-metadata"));
    await symlink(join(root, "valid/package.json"), join(root, "linked-metadata/package.json"));
    await symlink("valid", join(root, "link"));
    const partial = await captureGlobalNpm(root);
    expect(partial.coverage).toBe("incomplete");
    expect(partial.issues).toEqual(expect.arrayContaining([
      { name: "bad", reason: "malformed-metadata" }, { name: "link", reason: "invalid-entry" },
      { name: "missing", reason: "metadata-missing" }, { name: "linked-metadata", reason: "replaced" },
    ]));
    expect(compareGlobalNpm({ root }, partial, partial)).toMatchObject({ coverage: "incomplete", changes: [] });
    for (let i = 0; i < 260; i++) await mkdir(join(root, `extra${i}`));
    expect((await captureGlobalNpm(root)).issues).toContainEqual({ name: "", reason: "inventory-limit" });
    const linked = join(f.path, "linked");
    await symlink(join(f.path, "prefix"), linked);
    expect((await captureGlobalNpm(join(linked, "lib/node_modules"))).reason).toBe("symlink-or-special");
  }));
});
