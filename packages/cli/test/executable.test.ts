import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { resolveExecutable } from "../src/executable.js";

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "twin-executable-test-")); });
afterEach(async () => { await rm(root, { recursive: true }); });

async function candidate(directory: string, mode = 0o700): Promise<string> {
  await mkdir(directory, { recursive: true });
  const path = join(directory, "tool");
  await writeFile(path, "fixed fixture\n", { mode });
  return path;
}

it("preserves absolute paths without imposing new filesystem admission", async () => {
  const path = join(root, "not-created");
  expect(await resolveExecutable(path, { PATH: "" }, root)).toBe(path);
});

it("selects the first executable regular file in PATH order", async () => {
  const first = join(root, "first"), second = join(root, "second");
  const a = await candidate(first), b = await candidate(second);
  expect(await resolveExecutable("tool", { PATH: [first, second].join(delimiter) }, root)).toBe(a);
  expect(await resolveExecutable("tool", { PATH: [second, first].join(delimiter) }, root)).toBe(b);
});

it("skips absent, non-executable, and directory candidates", async () => {
  const absent = join(root, "absent"), blocked = join(root, "blocked"), directory = join(root, "directory"), valid = join(root, "valid");
  await candidate(blocked, 0o600);
  await mkdir(join(directory, "tool"), { recursive: true });
  const expected = await candidate(valid);
  expect(await resolveExecutable("tool", { PATH: [absent, blocked, directory, valid].join(delimiter) }, root)).toBe(expected);
});

it("uses the command working directory for empty and relative PATH entries", async () => {
  const local = await candidate(root), relative = await candidate(join(root, "bin"));
  expect(await resolveExecutable("tool", { PATH: "" }, root)).toBe(local);
  expect(await resolveExecutable("tool", { PATH: "bin" }, root)).toBe(relative);
  expect(await resolveExecutable("tool", { PATH: ["absent", ""].join(delimiter) }, root)).toBe(local);
});

it("follows executable file symlinks and skips broken or directory symlinks", async () => {
  const broken = join(root, "broken"), directory = join(root, "directory"), valid = join(root, "valid");
  for (const path of [broken, directory, valid]) await mkdir(path);
  await symlink(join(root, "missing"), join(broken, "tool"));
  await symlink(root, join(directory, "tool"));
  await symlink(process.execPath, join(valid, "tool"));
  expect(await resolveExecutable("tool", { PATH: [broken, directory, valid].join(delimiter) }, root)).toBe(join(valid, "tool"));
});

it("rejects a name with no executable candidate", async () => {
  await candidate(root, 0o600);
  await expect(resolveExecutable("tool", { PATH: root }, root)).rejects.toThrow("Executable not found on PATH");
});

it("does not invent a search path when PATH is missing", async () => {
  await candidate(root);
  await expect(resolveExecutable("tool", {}, root)).rejects.toThrow("Executable not found on PATH");
});

it.each(["./tool", "bin/tool", "tool\0suffix"])("rejects a non-bare relative executable %j", async executable => {
  await expect(resolveExecutable(executable, { PATH: root }, root)).rejects.toThrow("Expected a bare executable name or an absolute path");
});
