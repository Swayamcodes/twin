import { createHash, randomBytes } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { chmod, lstat, mkdir, open, realpath, rename, rmdir, unlink } from "node:fs/promises";
import { captureManifest, type ManifestEntry, type ManifestSnapshot } from "./manifest.js";
import { assertRootAuthority, sameIdentity, type OwnedRoot } from "./safety.js";

export type ApplyResult =
  | { readonly status: "applied"; readonly changes: number }
  | { readonly status: "conflict" | "refused"; readonly paths: readonly string[]; readonly reason: string }
  | { readonly status: "failed"; readonly reason: string; readonly partialApplicationPossible: true };

type Entry = ManifestEntry | undefined;
interface Change { key: string; before: Entry; current: Entry; final: Entry }
const equal = (a: Entry, b: Entry): boolean => a === b || (!!a && !!b && a.kind === b.kind && a.mode === b.mode && a.digest === b.digest);
const pathOf = (key: string): string => {
  const raw = Buffer.from(key, "base64");
  const decoded = raw.toString("utf8");
  return Buffer.from(decoded).equals(raw) ? decoded : `base64:${key}`;
};
const bytesOf = (key: string): Buffer => Buffer.from(key, "base64");
const depth = (key: string): number => bytesOf(key).filter(byte => byte === 47).length;
const stableFile = (a: BigIntStats, b: BigIntStats): boolean => sameIdentity(a, b) && a.size === b.size
  && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
function parentOf(path: Buffer): Buffer { return path.subarray(0, path.lastIndexOf(47)); }
function absolute(root: string, key: string): Buffer {
  const rel = bytesOf(key);
  if (!rel.length || rel[0] === 47 || rel.includes(0)
      || rel.toString("latin1").split("/").some(part => !part || part === "." || part === "..")) {
    throw new Error("Unsupported apply path");
  }
  return Buffer.concat([Buffer.from(root), Buffer.from("/"), rel]);
}
function complete(...snapshots: ManifestSnapshot[]): boolean {
  return snapshots.every(snapshot => snapshot.coverage === "complete" && snapshot.issues.length === 0
    && [...snapshot.entries.values()].every(entry => entry.kind !== "symlink"));
}
async function verifyRoot(root: OwnedRoot, sourceIdentity: BigIntStats): Promise<void> {
  await assertRootAuthority(root);
  const stat = await lstat(root.source, { bigint: true });
  if (!stat.isDirectory() || !sameIdentity(stat, sourceIdentity) || await realpath(root.source) !== root.source) {
    throw new Error("Original root identity changed");
  }
}
async function verifyPath(root: string, key: string, expected: Entry): Promise<void> {
  const parts = bytesOf(key).toString("latin1").split("/").map(part => Buffer.from(part, "latin1"));
  let parent = Buffer.from(root);
  for (const part of parts.slice(0, -1)) {
    parent = Buffer.concat([parent, Buffer.from("/"), part]);
    const stat = await lstat(parent);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Apply parent changed: ${pathOf(key)}`);
  }
  const path = absolute(root, key);
  const snapshot = await captureManifest(parentOf(path), true);
  if (snapshot.coverage !== "complete") throw new Error(`Apply path observation incomplete: ${pathOf(key)}`);
  const name = parts.at(-1)!.toString("base64");
  if (!equal(snapshot.entries.get(name), expected)) throw new Error(`Apply path changed: ${pathOf(key)}`);
}
async function copyVerifiedFile(source: Buffer, destination: Buffer, expected: BigIntStats, entry: ManifestEntry): Promise<void> {
  const input = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await input.stat({ bigint: true });
    if (!before.isFile() || !stableFile(before, expected)) throw new Error("Copy file identity changed");
    const output = await open(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      const hash = createHash("sha256");
      const buffer = Buffer.allocUnsafe(65536);
      let bytes = 0n;
      for (;;) {
        const read = await input.read(buffer, 0, buffer.length, null);
        if (!read.bytesRead) break;
        bytes += BigInt(read.bytesRead);
        hash.update(buffer.subarray(0, read.bytesRead));
        let written = 0;
        while (written < read.bytesRead) {
          const part = await output.write(buffer, written, read.bytesRead - written, null);
          if (!part.bytesWritten) throw new Error("Apply copy write made no progress");
          written += part.bytesWritten;
        }
      }
      const after = await input.stat({ bigint: true });
      if (!stableFile(before, after) || bytes !== before.size || hash.digest("hex") !== entry.digest) {
        throw new Error("Copy file changed during apply");
      }
      await output.chmod(entry.mode);
    } finally { await output.close(); }
  } finally { await input.close(); }
}
function conflicts(before: ManifestSnapshot, current: ManifestSnapshot, final: ManifestSnapshot): Change[] {
  const all = new Set([...before.entries.keys(), ...current.entries.keys(), ...final.entries.keys()]);
  const result: Change[] = [];
  for (const key of all) {
    const b = before.entries.get(key), c = current.entries.get(key), f = final.entries.get(key);
    if (!equal(b, f) && !equal(c, f)) result.push({ key, before: b, current: c, final: f });
  }
  return result;
}
export async function applyCopy(root: OwnedRoot, sourceIdentity: BigIntStats, before: ManifestSnapshot,
  copyBaseline: ManifestSnapshot, settled: ManifestSnapshot): Promise<ApplyResult> {
  try {
    await verifyRoot(root, sourceIdentity);
    const final = await captureManifest(root.workspace, true);
    const current = await captureManifest(root.source, true);
    if (!complete(before, copyBaseline, settled, final, current)) {
      return { status: "refused", paths: [], reason: "Incomplete inventory or symlink" };
    }
    const settledKeys = new Set([...settled.entries.keys(), ...final.entries.keys()]);
    if ([...settledKeys].some(key => !equal(settled.entries.get(key), final.entries.get(key)))) {
      return { status: "refused", paths: [], reason: "Copy baseline or settled copy changed" };
    }
    const baselineKeys = new Set([...before.entries.keys(), ...copyBaseline.entries.keys()]);
    if ([...baselineKeys].some(key => !equal(before.entries.get(key), copyBaseline.entries.get(key)))) {
      return { status: "refused", paths: [], reason: "Original and copy baseline differ" };
    }
    const changes = conflicts(before, current, final);
    const incompatible = changes.filter(change => !equal(change.current, change.before));
    // A removed/replaced directory may contain unrelated new original children.
    for (const change of changes) if (change.before?.kind === "directory" && change.final?.kind !== "directory") {
      const prefix = Buffer.concat([bytesOf(change.key), Buffer.from("/")]);
      if ([...current.entries.keys()].some(key => bytesOf(key).subarray(0, prefix.length).equals(prefix)
          && !before.entries.has(key))) incompatible.push(change);
    }
    if (incompatible.length) return { status: "conflict", paths: [...new Set(incompatible.map(change => pathOf(change.key)))], reason: "Original changed incompatibly" };
    const removals = changes.filter(change => !!change.current && change.final?.kind !== change.current.kind)
      .sort((a, b) => depth(b.key) - depth(a.key));
    const directories = changes.filter(change => change.final?.kind === "directory" && change.current?.kind !== "directory")
      .sort((a, b) => depth(a.key) - depth(b.key));
    const files = changes.filter(change => change.final?.kind === "file").sort((a, b) => depth(a.key) - depth(b.key));
    const dirModes = changes.filter(change => change.final?.kind === "directory").sort((a, b) => depth(b.key) - depth(a.key));
    await verifyRoot(root, sourceIdentity);
    const justBefore = await captureManifest(root.source, true);
    if (!complete(justBefore) || [...new Set([...current.entries.keys(), ...justBefore.entries.keys()])]
      .some(key => !equal(current.entries.get(key), justBefore.entries.get(key)))) {
      return { status: "conflict", paths: [], reason: "Original changed after preflight" };
    }
    const sourceIdentities = new Map<string, BigIntStats | undefined>();
    const copyIdentities = new Map<string, BigIntStats>();
    const relevant = new Set<string>();
    for (const change of changes) {
      const raw = bytesOf(change.key);
      relevant.add(change.key);
      for (let offset = 0; offset < raw.length; offset++) if (raw[offset] === 47) relevant.add(raw.subarray(0, offset).toString("base64"));
      if (change.final?.kind === "file") copyIdentities.set(change.key, await lstat(absolute(root.workspace, change.key), { bigint: true }));
    }
    for (const key of relevant) if (current.entries.has(key)) {
      sourceIdentities.set(key, await lstat(absolute(root.source, key), { bigint: true }));
    } else sourceIdentities.set(key, undefined);
    const identity = async (base: string, key: string, expected: BigIntStats | undefined): Promise<void> => {
      const path = absolute(base, key);
      const actual = await lstat(path, { bigint: true }).catch((error: unknown) => {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
        throw error;
      });
      if (!expected ? actual !== undefined : !actual || !sameIdentity(actual, expected) || actual.isSymbolicLink()) {
        throw new Error(`Apply path identity changed: ${pathOf(key)}`);
      }
    };
    const check = async (key: string): Promise<void> => {
      const raw = bytesOf(key);
      for (let offset = 0; offset < raw.length; offset++) if (raw[offset] === 47) {
        const parentKey = raw.subarray(0, offset).toString("base64");
        await identity(root.source, parentKey, sourceIdentities.get(parentKey));
      }
      await identity(root.source, key, sourceIdentities.get(key));
    };
    try {
      for (const change of removals) {
        await verifyRoot(root, sourceIdentity);
        await check(change.key);
        await verifyPath(root.source, change.key, change.current);
        const path = absolute(root.source, change.key);
        if (change.current?.kind === "directory") await rmdir(path);
        else await unlink(path);
        sourceIdentities.set(change.key, undefined);
      }
      for (const change of directories) {
        await verifyRoot(root, sourceIdentity);
        await check(change.key);
        await verifyPath(root.source, change.key, undefined);
        await mkdir(absolute(root.source, change.key), { mode: 0o700 });
        sourceIdentities.set(change.key, await lstat(absolute(root.source, change.key), { bigint: true }));
      }
      for (const change of files) {
        await verifyRoot(root, sourceIdentity);
        await check(change.key);
        await identity(root.workspace, change.key, copyIdentities.get(change.key));
        await verifyPath(root.workspace, change.key, change.final);
        await verifyPath(root.source, change.key, change.current?.kind === "file" ? change.current : undefined);
        const target = absolute(root.source, change.key);
        const temp = Buffer.concat([parentOf(target), Buffer.from(`/.twin-apply-${randomBytes(16).toString("hex")}`)]);
        try {
          await copyVerifiedFile(absolute(root.workspace, change.key), temp, copyIdentities.get(change.key)!, change.final!);
          await verifyPath(root.workspace, change.key, change.final);
          await identity(root.workspace, change.key, copyIdentities.get(change.key));
          await check(change.key);
          await verifyPath(root.source, change.key, change.current?.kind === "file" ? change.current : undefined);
          await verifyRoot(root, sourceIdentity);
          await rename(temp, target);
          sourceIdentities.set(change.key, await lstat(target, { bigint: true }));
        } finally {
          try { await unlink(temp); }
          catch (error: unknown) {
            if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
              throw new Error("Apply temporary cleanup failed", { cause: error });
            }
          }
        }
      }
      for (const change of dirModes) {
        await verifyRoot(root, sourceIdentity);
        await check(change.key);
        const target = absolute(root.source, change.key);
        const stat = await lstat(target);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Apply directory changed: ${pathOf(change.key)}`);
        const expectedMode = change.current?.kind === "directory" ? change.current.mode
          : Number(sourceIdentities.get(change.key)!.mode & 0o777n);
        if ((stat.mode & 0o777) !== expectedMode) throw new Error(`Apply directory mode changed: ${pathOf(change.key)}`);
        await chmod(target, change.final!.mode);
      }
      return { status: "applied", changes: changes.length };
    } catch (error) {
      return { status: "failed", reason: error instanceof Error ? error.message : String(error), partialApplicationPossible: true };
    }
  } catch (error) {
    return { status: "refused", paths: [], reason: error instanceof Error ? error.message : String(error) };
  }
}
