import { randomBytes } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { mkdtemp, readFile, realpath, readdir, lstat, open, chmod, unlink, rmdir, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";

export interface ParentAuthority { path: string; dev: number; ino: number; uid: number; token: string }
function contains(parent: string, child: string): boolean {
  const diff = relative(parent, child);
  return diff === "" || (!isAbsolute(diff) && diff !== ".." && !diff.startsWith(`..${sep}`));
}
async function canonicalMissing(path: string): Promise<string> {
  try { return await realpath(path); }
  catch (error: unknown) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    return join(await canonicalMissing(dirname(path)), path.slice(dirname(path).length + 1));
  }
}
export async function testParent(): Promise<ParentAuthority> {
  const base = await realpath(tmpdir());
  const repository = await realpath(fileURLToPath(new URL("../../../", import.meta.url)));
  const protectedPaths = [repository, join(homedir(), ".local/state/twin")];
  if (process.env.XDG_STATE_HOME) protectedPaths.push(resolve(process.env.XDG_STATE_HOME, "twin"));
  for (const path of protectedPaths) {
    const canonical = await canonicalMissing(resolve(path));
    if (contains(resolve(path), base) || contains(canonical, base)) throw new Error("artifact-parent-inside-protected-tree");
  }
  const path = await mkdtemp(join(base, "twin-test-score-artifacts-"));
  await chmod(path, 0o700);
  const token = randomBytes(32).toString("hex");
  await writeFile(join(path, ".owner"), token, { flag: "wx", mode: 0o600 });
  const stat = await lstat(path);
  return { path, dev: stat.dev, ino: stat.ino, uid: stat.uid, token };
}
export async function checkParent(authority: ParentAuthority): Promise<void> {
  const stat = await lstat(authority.path);
  expect(stat.isDirectory() && !stat.isSymbolicLink() && (stat.mode & 0o7777) === 0o700).toBe(true);
  expect([stat.dev, stat.ino, stat.uid]).toEqual([authority.dev, authority.ino, authority.uid]);
  expect(await realpath(authority.path)).toBe(authority.path);
  expect(dirname(authority.path)).toBe(await realpath(tmpdir()));
  const marker = await lstat(join(authority.path, ".owner"));
  expect(marker.isFile() && !marker.isSymbolicLink() && marker.nlink === 1 && marker.uid === authority.uid
    && (marker.mode & 0o7777) === 0o600).toBe(true);
  const descriptor = await open(join(authority.path, ".owner"), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await descriptor.stat(); expect([opened.dev, opened.ino]).toEqual([marker.dev, marker.ino]);
    expect(await descriptor.readFile("utf8")).toBe(authority.token);
  } finally { await descriptor.close(); }
}
interface FileIdentity { type: "file"; dev: number; ino: number; uid: number; mode: number; nlink: number; size: number }
function fileIdentity(stat: Stats): FileIdentity {
  return { type: "file", dev: stat.dev, ino: stat.ino, uid: stat.uid, mode: stat.mode & 0o7777, nlink: stat.nlink, size: stat.size };
}
async function safeArtifactFile(path: string, uid: number): Promise<{ identity: FileIdentity; bytes: Buffer }> {
  const named = await lstat(path);
  expect(named.isFile() && !named.isSymbolicLink() && named.uid === uid && named.nlink === 1
    && (named.mode & 0o7777) === 0o600).toBe(true);
  const descriptor = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await descriptor.stat();
    expect(opened.isFile() && !opened.isSymbolicLink() && opened.uid === uid && opened.nlink === 1
      && (opened.mode & 0o7777) === 0o600).toBe(true);
    expect(fileIdentity(opened)).toEqual(fileIdentity(named));
    const bytes = await descriptor.readFile();
    expect((await descriptor.stat()).size).toBe(bytes.length);
    return { identity: fileIdentity(named), bytes };
  } finally { await descriptor.close(); }
}
export async function cleanupKnownArtifacts(authority: ParentAuthority, ids: readonly string[], beforeDelete?: () => Promise<void>): Promise<void> {
  await checkParent(authority);
  const entries = (await readdir(authority.path)).filter(name => name !== ".owner").sort();
  expect(entries).toHaveLength(2);
  const remaining = new Set(ids);
  const directories = new Map<string, { type: "directory"; dev: number; ino: number; uid: number; mode: number }>();
  const files = new Map<string, Map<string, FileIdentity>>();
  for (const name of entries) {
    expect(name.startsWith("capture-") || name.startsWith("twin-s12-") || name.startsWith("twin-s6-")).toBe(true);
    const directory = join(authority.path, name), difference = relative(authority.path, directory);
    expect(difference !== "" && difference !== ".." && !difference.startsWith(`..${sep}`) && !difference.includes(sep)).toBe(true);
    const dirStat = await lstat(directory);
    expect(dirStat.isDirectory() && !dirStat.isSymbolicLink() && dirStat.uid === authority.uid && (dirStat.mode & 0o7777) === 0o700).toBe(true);
    expect(await realpath(directory)).toBe(directory);
    directories.set(name, { type: "directory", dev: dirStat.dev, ino: dirStat.ino, uid: dirStat.uid, mode: dirStat.mode & 0o7777 });
    const names = (await readdir(directory)).sort();
    const expected = name.startsWith("capture-") ? ["capture.json", "manifest.json", "outcome.json", "reservation.json"]
      : ["attempt.json", "identity.json", "manifest.json", "outcome.json"];
    expect(names).toEqual(expected);
    const children = new Map<string, FileIdentity>();
    let manifestBytes: Buffer | undefined;
    for (const file of expected) {
      const childPath = join(directory, file);
      const childRelative = relative(authority.path, childPath);
      expect(childRelative.startsWith(`${name}${sep}`) && !childRelative.includes("..") && childRelative.split(sep).length === 2).toBe(true);
      const checked = await safeArtifactFile(childPath, authority.uid);
      children.set(file, checked.identity);
      if (file === "manifest.json") manifestBytes = checked.bytes;
    }
    files.set(name, children);
    if (!manifestBytes) throw new Error("missing-checked-manifest");
    const manifest = JSON.parse(manifestBytes.toString("utf8")) as { artifactId?: unknown };
    expect(typeof manifest.artifactId).toBe("string");
    expect(remaining.delete(manifest.artifactId as string)).toBe(true);
  }
  expect(remaining.size).toBe(0);
  await beforeDelete?.();
  for (const name of entries) {
    await checkParent(authority);
    const directory = join(authority.path, name);
    const dirStat = await lstat(directory), expectedIdentity = directories.get(name);
    if (!expectedIdentity) throw new Error("missing-registered-artifact-child");
    expect(dirStat.isDirectory() && !dirStat.isSymbolicLink() && dirStat.dev === expectedIdentity.dev
      && dirStat.ino === expectedIdentity.ino && dirStat.uid === expectedIdentity.uid
      && (dirStat.mode & 0o7777) === expectedIdentity.mode).toBe(true);
    const authorized = files.get(name);
    if (!authorized) throw new Error("missing-authorized-artifact-files");
    expect((await readdir(directory)).sort()).toEqual([...authorized.keys()].sort());
    for (const file of authorized.keys()) {
      await checkParent(authority);
      const currentDir = await lstat(directory), child = await lstat(join(directory, file));
      expect(currentDir.isDirectory() && !currentDir.isSymbolicLink() && currentDir.dev === expectedIdentity.dev
        && currentDir.ino === expectedIdentity.ino && currentDir.uid === expectedIdentity.uid
        && (currentDir.mode & 0o7777) === expectedIdentity.mode).toBe(true);
      expect(child.isFile() && !child.isSymbolicLink()).toBe(true);
      expect(fileIdentity(child)).toEqual(authorized.get(file));
      await unlink(join(directory, file));
    }
    await checkParent(authority);
    const beforeRemove = await lstat(directory);
    expect(beforeRemove.isDirectory() && !beforeRemove.isSymbolicLink() && beforeRemove.dev === expectedIdentity.dev
      && beforeRemove.ino === expectedIdentity.ino && beforeRemove.uid === expectedIdentity.uid
      && (beforeRemove.mode & 0o7777) === expectedIdentity.mode).toBe(true);
    expect(await readdir(directory)).toEqual([]);
    await rmdir(directory);
  }
  await checkParent(authority);
  await unlink(join(authority.path, ".owner")); await rmdir(authority.path);
}
