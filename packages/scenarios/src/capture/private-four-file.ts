import { constants, type Stats } from "node:fs";
import { mkdir, open, opendir, lstat, realpath, type FileHandle } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { dirname, isAbsolute, join, normalize } from "node:path";

export const fileNames = ["identity.json", "attempt.json", "outcome.json", "manifest.json"] as const;
export type FileName = typeof fileNames[number];
export type FileLimits = Readonly<Record<FileName, number>>;
const prior = fileNames.slice(0, 3);
export const digest = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const uid = (): number => { if (typeof process.getuid !== "function") throw new Error("uid-unavailable"); return process.getuid(); };
function safe(stat: Stats, owner: number, kind: "file" | "directory", limits: FileLimits, name?: FileName): void {
  if (stat.uid !== owner || stat.isSymbolicLink() || (kind === "file" ? !stat.isFile() || stat.nlink !== 1 : !stat.isDirectory())
    || (stat.mode & 0o7777) !== (kind === "file" ? 0o600 : 0o700) || name && stat.size > limits[name]) throw new Error("unsafe-object");
}
async function parent(path: string, owner: number): Promise<Stats> {
  if (!path || !isAbsolute(path) || normalize(path) !== path || path.length > 4096 || await realpath(path) !== path) throw new Error("invalid-parent");
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== owner) throw new Error("invalid-parent");
  return stat;
}
export async function validatePrivateParent(path: string): Promise<boolean> {
  try { await parent(path, uid()); return true; } catch { return false; }
}
async function syncDir(handle: FileHandle): Promise<void> {
  try { await handle.sync(); } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    if (code !== "EINVAL" && code !== "ENOTSUP" && code !== "EOPNOTSUPP") throw error;
  }
}
async function writeOne(path: string, name: FileName, bytes: Uint8Array, owner: number, limits: FileLimits): Promise<void> {
  const handle = await open(join(path, name), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  let problem: unknown;
  try {
    safe(await handle.stat(), owner, "file", limits, name);
    for (let offset = 0; offset < bytes.length;) {
      const result = await handle.write(bytes, offset, bytes.length - offset, offset);
      if (!Number.isSafeInteger(result.bytesWritten) || result.bytesWritten <= 0 || result.bytesWritten > bytes.length - offset) throw new Error("write-progress");
      offset += result.bytesWritten;
    }
    await handle.sync();
  } catch (error) { problem = error; }
  try { await handle.close(); } catch (error) { if (problem === undefined) problem = error; }
  if (problem !== undefined) throw problem;
}
async function readOne(path: string, name: FileName, owner: number, limits: FileLimits): Promise<Uint8Array> {
  const location = join(path, name), before = await lstat(location); safe(before, owner, "file", limits, name);
  const handle = await open(location, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = await handle.stat(); safe(opened, owner, "file", limits, name);
    if (opened.dev !== before.dev || opened.ino !== before.ino) throw new Error("replaced");
    const bytes = new Uint8Array(opened.size);
    for (let offset = 0; offset < bytes.length;) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!Number.isSafeInteger(bytesRead) || bytesRead <= 0 || bytesRead > bytes.length - offset) throw new Error("short-read");
      offset += bytesRead;
    }
    if ((await handle.read(new Uint8Array(1), 0, 1, bytes.length)).bytesRead !== 0) throw new Error("grown");
    const after = await handle.stat(), named = await lstat(location); safe(after, owner, "file", limits, name); safe(named, owner, "file", limits, name);
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs
      || named.dev !== opened.dev || named.ino !== opened.ino) throw new Error("changed");
    return bytes;
  } finally { await handle.close(); }
}
async function exactInventory(path: string): Promise<void> {
  const dir = await opendir(path), seen = new Set<string>();
  try { for (;;) { const item = await dir.read(); if (!item) break; if (!fileNames.includes(item.name as FileName) || seen.has(item.name)) throw new Error("inventory"); seen.add(item.name); }
    if (fileNames.some(name => !seen.has(name))) throw new Error("inventory");
  } finally { await dir.close(); }
}
export function encode(name: FileName, value: unknown, limits: FileLimits): Uint8Array {
  const bytes = Buffer.from(JSON.stringify(value), "utf8");
  if (bytes.length > limits[name]) throw new Error("too-large");
  return bytes;
}
export class PrivatePublicationError extends Error {
  constructor(readonly directory: string | undefined, cause: unknown) { super("private-publication-failed", { cause }); }
}
export async function publishPrivateFour(parentDirectory: string, prefix: "twin-s12-" | "twin-s6-", limits: FileLimits,
  bodies: readonly [Uint8Array, Uint8Array, Uint8Array, Uint8Array]): Promise<string> {
  let directory: string | undefined;
  try {
    const owner = uid(), before = await parent(parentDirectory, owner);
    const now = await parent(parentDirectory, owner);
    if (now.dev !== before.dev || now.ino !== before.ino) throw new Error("parent-changed");
    directory = join(parentDirectory, `${prefix}${randomUUID()}`);
    await mkdir(directory, { mode: 0o700 });
    const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      safe(await handle.stat(), owner, "directory", limits);
      for (let i = 0; i < prior.length; i++) await writeOne(directory, prior[i] as FileName, bodies[i]!, owner, limits);
      await syncDir(handle); await writeOne(directory, "manifest.json", bodies[3], owner, limits); await syncDir(handle);
    } finally { await handle.close(); }
    return directory;
  } catch (error) { throw new PrivatePublicationError(directory, error); }
}
export async function reopenPrivateFour<T>(directory: string, limits: FileLimits,
  inspect: (values: readonly [Uint8Array, Uint8Array, Uint8Array, Uint8Array]) => T): Promise<T> {
  const owner = uid(); await parent(dirname(directory), owner);
  if (!isAbsolute(directory) || normalize(directory) !== directory || await realpath(directory) !== directory) throw new Error("path");
  const before = await lstat(directory); safe(before, owner, "directory", limits);
  const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat(); safe(opened, owner, "directory", limits);
    if (opened.dev !== before.dev || opened.ino !== before.ino) throw new Error("replaced");
    await exactInventory(directory);
    const manifestBytes = await readOne(directory, "manifest.json", owner, limits);
    const manifest = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes)) as unknown;
    if (!manifest || typeof manifest !== "object" || !("inventory" in manifest) || !Array.isArray(manifest.inventory)
      || manifest.inventory.length !== 3) throw new Error("manifest");
    const entries = manifest.inventory as unknown[];
    const values: Uint8Array[] = [];
    for (let i = 0; i < prior.length; i++) {
      const item = entries[i];
      if (!item || typeof item !== "object" || !("name" in item) || item.name !== prior[i]
        || !("sizeBytes" in item) || !("sha256" in item)) throw new Error("manifest");
      const bytes = await readOne(directory, prior[i] as FileName, owner, limits);
      if (item.sizeBytes !== bytes.length || item.sha256 !== digest(bytes)) throw new Error("digest");
      values.push(bytes);
    }
    const inspected = inspect([values[0]!, values[1]!, values[2]!, manifestBytes]);
    if (digest(await readOne(directory, "manifest.json", owner, limits)) !== digest(manifestBytes)) throw new Error("manifest-replaced");
    await exactInventory(directory);
    const named = await lstat(directory), after = await handle.stat(); safe(named, owner, "directory", limits); safe(after, owner, "directory", limits);
    if (named.dev !== opened.dev || named.ino !== opened.ino || after.dev !== opened.dev || after.ino !== opened.ino) throw new Error("changed");
    return inspected;
  } finally { await handle.close(); }
}
