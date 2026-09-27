import { randomBytes } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, open, readdir, realpath, rmdir, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { CreateTwinOptions, DiscardResult } from "./twin.js";

const markerName = ".twin-core-root";
const owned = new WeakSet<OwnedRoot>();
export interface OwnedRoot {
  readonly source: string;
  readonly parent: string;
  readonly path: string;
  readonly workspace: string;
  readonly token: string;
  readonly uid: bigint;
  readonly parentIdentity: BigIntStats;
  readonly forbidden: readonly string[];
  identity: BigIntStats | null;
  workspaceIdentity: BigIntStats | null;
  markerIdentity: BigIntStats | null;
}
export function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
export function contains(parent: string, child: string): boolean {
  const suffix = relative(parent, child);
  return suffix === "" || (!isAbsolute(suffix) && suffix !== ".." && !suffix.startsWith(`..${sep}`));
}
export function sameIdentity(a: BigIntStats, b: BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino && (a.mode & 0o170000n) === (b.mode & 0o170000n);
}
async function verifyDirectory(path: string, expected: BigIntStats, uid: bigint): Promise<void> {
  const stat = await lstat(path, { bigint: true });
  if (!stat.isDirectory() || !sameIdentity(stat, expected) || stat.uid !== uid
      || (stat.mode & 0o777n) !== 0o700n || await realpath(path) !== path) {
    throw new Error(`Directory authority mismatch: ${path}`);
  }
}
export async function allocateRoot(options: CreateTwinOptions): Promise<OwnedRoot> {
  if ((process.platform !== "linux" && process.platform !== "darwin") || !process.getuid) {
    throw new Error("Twin requires Linux/macOS with POSIX UID support");
  }
  for (const value of [options.sourceDirectory, options.scratchParent]) {
    if (typeof value !== "string" || !value || value.includes("\0")) throw new Error("Invalid directory path");
    if (!(await lstat(resolve(value))).isDirectory()) throw new Error(`Expected ordinary directory: ${value}`);
  }
  const source = await realpath(options.sourceDirectory);
  const parent = await realpath(options.scratchParent);
  const uid = BigInt(process.getuid());
  const parentIdentity = await lstat(parent, { bigint: true });
  await verifyDirectory(parent, parentIdentity, uid);
  if (contains(source, parent)) throw new Error("Scratch parent must be outside source");
  const forbidden = [source, await realpath(process.cwd()), await realpath(homedir())];
  const path = await mkdtemp(join(parent, "twin-core-"));
  const root: OwnedRoot = { source, parent, path, workspace: join(path, "workspace"),
    uid, parentIdentity, forbidden, token: randomBytes(32).toString("hex") + "\n",
    identity: null, workspaceIdentity: null, markerIdentity: null };
  owned.add(root); // Register before any further mutation.
  try {
    root.identity = await lstat(path, { bigint: true });
    await chmod(path, 0o700);
    await writeFile(join(path, markerName), root.token, { flag: "wx", mode: 0o600 });
    root.markerIdentity = await lstat(join(path, markerName), { bigint: true });
    await mkdir(root.workspace, { mode: 0o700 });
    root.workspaceIdentity = await lstat(root.workspace, { bigint: true });
    await chmod(root.workspace, 0o700);
    await assertRootAuthority(root);
    return root;
  } catch (error: unknown) {
    const cleanup = await discardRoot(root);
    throw new Error(`Twin allocation failed; cleanup=${JSON.stringify(cleanup)}; allocation=${path}`, { cause: error });
  }
}
export async function assertRootAuthority(root: OwnedRoot): Promise<void> {
  if (!owned.has(root) || dirname(root.path) !== root.parent || root.workspace !== join(root.path, "workspace")
      || contains(root.source, root.path) || root.forbidden.some(path => contains(root.path, path))
      || root.identity === null || root.markerIdentity === null) throw new Error("Root authority unavailable");
  await verifyDirectory(root.parent, root.parentIdentity, root.uid);
  await verifyDirectory(root.path, root.identity, root.uid);
  const markerPath = join(root.path, markerName);
  const markerBefore = await lstat(markerPath, { bigint: true });
  if (!markerBefore.isFile() || !sameIdentity(markerBefore, root.markerIdentity)) {
    throw new Error("Marker type or identity mismatch");
  }
  const marker = await open(markerPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await marker.stat({ bigint: true });
    if (!stat.isFile() || !sameIdentity(stat, root.markerIdentity) || stat.uid !== root.uid
        || stat.nlink !== 1n || (stat.mode & 0o777n) !== 0o600n || stat.size !== BigInt(root.token.length)) {
      throw new Error("Marker authority mismatch");
    }
    const bytes = Buffer.alloc(root.token.length + 1);
    const { bytesRead } = await marker.read(bytes, 0, bytes.length, 0);
    if (bytesRead !== root.token.length || bytes.subarray(0, bytesRead).toString() !== root.token) {
      throw new Error("Marker contents mismatch");
    }
  } finally { await marker.close(); }
  if (root.workspaceIdentity) await verifyDirectory(root.workspace, root.workspaceIdentity, root.uid);
  const entries = await readdir(root.path);
  if (entries.some(name => name !== markerName && (name !== "workspace" || !root.workspaceIdentity))) {
    throw new Error("Unexpected allocation entry");
  }
}
interface Entry { path: string; stat: BigIntStats; children: Entry[] }
export async function discardRoot(root: OwnedRoot): Promise<DiscardResult> {
  let tree: Entry | null = null;
  try {
    await assertRootAuthority(root);
    const preflight = async (path: string): Promise<Entry> => {
      const stat = await lstat(path, { bigint: true });
      if (stat.uid !== root.uid || stat.dev !== root.identity?.dev
          || !(stat.isDirectory() || stat.isFile() || stat.isSymbolicLink())) throw new Error(`Unsafe cleanup entry: ${path}`);
      const children: Entry[] = [];
      if (stat.isDirectory()) for (const name of await readdir(path)) children.push(await preflight(join(path, name)));
      return { path, stat, children };
    };
    if (root.workspaceIdentity) tree = await preflight(root.workspace);
    await assertRootAuthority(root);
  } catch (error: unknown) { return { status: "refused", reason: message(error) }; }
  try {
    const remove = async (entry: Entry): Promise<void> => {
      const stat = await lstat(entry.path, { bigint: true });
      if (!sameIdentity(stat, entry.stat) || stat.uid !== root.uid) throw new Error(`Cleanup entry changed: ${entry.path}`);
      if (stat.isDirectory()) {
        for (const child of entry.children) await remove(child);
        if (!sameIdentity(await lstat(entry.path, { bigint: true }), entry.stat)) throw new Error("Cleanup directory changed");
        await rmdir(entry.path);
      } else await unlink(entry.path); // Includes symlinks; never follow their targets.
    };
    if (tree) await remove(tree);
    root.workspaceIdentity = null;
    await assertRootAuthority(root);
    await unlink(join(root.path, markerName));
    await rmdir(root.path);
    owned.delete(root);
    return { status: "removed" };
  } catch (error: unknown) {
    return { status: "failed", reason: message(error), partialDeletionPossible: true };
  }
}
