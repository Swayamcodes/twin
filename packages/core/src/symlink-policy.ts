import { IoOperation, IoPool, checkIo, measured, diagnosticStage, type IoOptions } from "./io-pool.js";
import { createHash } from "node:crypto";
import type { BigIntStats } from "node:fs";
import { lstat, readdir, readlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ManifestSnapshot } from "./manifest.js";
import { sameIdentity } from "./safety.js";

export const LINK_DISCOVERY_LIMITS = Object.freeze({ entries: 100_000, depth: 128, pathBytes: 4096, targetBytes: 4096 });
export interface LinkState { readonly target: Buffer; readonly digest: string; readonly stat: BigIntStats }
export interface BaselineLink { readonly original: LinkState; readonly copied: LinkState }
export type BaselineLinks = ReadonlyMap<string, BaselineLink>;
const components = (value: Buffer): Buffer[] => value.toString("latin1").split("/").map(part => Buffer.from(part, "latin1"));
const dot = Buffer.from(".");
const parent = Buffer.from("..");
export function checkEntryPath(path: string): void {
  if (Buffer.byteLength(path) > LINK_DISCOVERY_LIMITS.pathBytes) throw new Error(`Copy path limit: ${path}`);
  if (path.split("/").length > LINK_DISCOVERY_LIMITS.depth) throw new Error(`Copy depth limit: ${path}`);
}
function checkTarget(target: Buffer): void {
  if (!target.length || target.includes(0) || target.length > LINK_DISCOVERY_LIMITS.targetBytes) {
    throw new Error("Unsupported symlink target bytes or target limit");
  }
}
export function checkRelativeTarget(target: Buffer, depth: number): void {
  checkTarget(target);
  if (target[0] === 47) throw new Error("Expected relative target");
  let named = false;
  for (const part of components(target)) {
    if (!part.length || part.equals(dot)) continue;
    if (part.equals(parent)) {
      if (named) throw new Error("Parent component after named target component");
      if (--depth < 0) throw new Error("Target escapes source root");
    } else named = true;
  }
}
export function copyLinkTarget(sourceRoot: string, relativePath: string, target: Buffer): Buffer {
  checkTarget(target);
  const from = dirname(relativePath) === "." ? [] : components(Buffer.from(dirname(relativePath)));
  if (target[0] !== 47) {
    checkRelativeTarget(target, from.length);
    return Buffer.from(target);
  }
  const root = Buffer.from(sourceRoot);
  if (target[1] === 47 || !target.subarray(0, root.length).equals(root)
      || (target.length !== root.length && target[root.length] !== 47)) throw new Error("Absolute target outside canonical source spelling");
  const to = components(target.subarray(root.length)).filter(part => part.length);
  if (to.some(part => part.equals(dot) || part.equals(parent))) throw new Error("Dot component in absolute target");
  let common = 0;
  while (common < from.length && common < to.length && from[common]!.equals(to[common]!)) common++;
  const parts = [...from.slice(common).map(() => parent), ...to.slice(common)];
  let copied = parts.length ? Buffer.concat(parts.flatMap((part, index) => index ? [Buffer.from("/"), part] : [part])) : Buffer.from(".");
  if (target.at(-1) === 47) copied = Buffer.concat([copied, Buffer.from("/")]);
  checkRelativeTarget(copied, from.length);
  return copied;
}
export async function directoryNames(path: string, remaining: number = LINK_DISCOVERY_LIMITS.entries): Promise<string[]> {
  const names = await readdir(path, { encoding: "buffer" });
  if (names.length > remaining) throw new Error("Copy/link discovery entry limit");
  return names.map(name => {
    const decoded = name.toString("utf8");
    if (!Buffer.from(decoded).equals(name)) throw new Error(`Unsupported non-UTF-8 entry name at ${path}: base64:${name.toString("base64")}`);
    return decoded;
  });
}
const stable = (a: BigIntStats, b: BigIntStats): boolean => sameIdentity(a, b) && a.mode === b.mode
  && a.ctimeNs === b.ctimeNs && a.mtimeNs === b.mtimeNs && a.size === b.size;
export async function readLinkState(path: string, expected?: BigIntStats): Promise<LinkState> {
  const before = await lstat(path, { bigint: true });
  if (!before.isSymbolicLink() || (expected && !stable(before, expected))) throw new Error(`Baseline link changed: ${path}`);
  const target = await readlink(path, { encoding: "buffer" });
  checkTarget(target);
  if (!stable(before, await lstat(path, { bigint: true }))) throw new Error(`Baseline link changed: ${path}`);
  return Object.freeze({ target, digest: createHash("sha256").update(target).digest("hex"), stat: before });
}
export async function discoverLinks(root: string, options: IoOptions = {}): Promise<ReadonlyMap<string, LinkState>> {
  const span = options.diagnostics?.start(options.diagnosticStage ?? "links.source", options.diagnosticRole ?? "none");
  try {
  const links = new Map<string, LinkState>();
  const pool = options.pool ?? new IoPool();
  const check = (): void => checkIo(options);
  check();
  interface Directory { path: string; relative: string; expected: BigIntStats; ancestors: readonly { path: string; stat: BigIntStats }[] }
  const stack: Directory[] = [{ path: root, relative: "", expected: await measured(span, "metadata", () => lstat(root, { bigint: true })), ancestors: [] }];
  const checkAncestors = async (ancestors: Directory["ancestors"]): Promise<void> => {
    for (const ancestor of ancestors) {
      const actual = await measured(span, "metadata", () => lstat(ancestor.path, { bigint: true }));
      if (!actual.isDirectory() || !sameIdentity(actual, ancestor.stat)) throw new Error(`Link discovery ancestor changed: ${ancestor.path}`);
    }
  };
  let count = 0;
  while (stack.length) {
    check();
    const directory = stack.pop()!;
    await measured(span, "ancestors", () => checkAncestors(directory.ancestors));
    const before = await measured(span, "metadata", () => lstat(directory.path, { bigint: true }));
    if (!before.isDirectory() || !stable(before, directory.expected)) throw new Error(`Link discovery directory changed: ${directory.path}`);
    const ancestors = [...directory.ancestors, { path: directory.path, stat: before }];
    type Found = { key?: string; link?: LinkState; directory?: Directory };
    const operation = new IoOperation<Found>(pool, outcome => {
      if (!outcome.ok) return;
      if (outcome.value.key && outcome.value.link) links.set(outcome.value.key, outcome.value.link);
      if (outcome.value.directory) stack.push(outcome.value.directory);
    }, check, span);
    try {
      for (const name of await measured(span, "enumeration", () => directoryNames(directory.path, LINK_DISCOVERY_LIMITS.entries - count))) {
        check();
        if (++count > LINK_DISCOVERY_LIMITS.entries) throw new Error("Link discovery entry limit");
        const relative = directory.relative ? `${directory.relative}/${name}` : name;
        checkEntryPath(relative);
        const path = join(directory.path, name);
        await operation.enqueue(async () => {
          await measured(span, "ancestors", () => checkAncestors(ancestors));
          check();
          const stat = await measured(span, "metadata", () => lstat(path, { bigint: true }));
          check();
          if (stat.isSymbolicLink()) return { key: Buffer.from(relative).toString("base64"), link: await measured(span, "metadata", () => readLinkState(path, stat)) };
          if (stat.isDirectory()) return { directory: { path, relative, expected: stat, ancestors } };
          if (!stat.isFile()) throw new Error(`Unsupported link discovery entry: ${relative}`);
          return {};
        });
      }
    } catch (error: unknown) { operation.stop(error); }
    await operation.drain();
    check();
    if (!stable(before, await measured(span, "metadata", () => lstat(directory.path, { bigint: true })))) throw new Error(`Link discovery directory changed: ${directory.path}`);
  }
  span?.end("complete", true); return links;
  } catch (error: unknown) { span?.end("failed", true); throw error; }
}
export async function verifyBaselineLinks(source: string, workspace: string, ledger: BaselineLinks, options: IoOptions = {}): Promise<void> {
  return diagnosticStage(options.diagnostics, options.diagnosticStage ?? "preparation.links", async () => {
  const pool = options.pool ?? new IoPool();
  let failed = false; let failure: unknown;
  const policy: IoOptions = { ...options, pool, check: () => { checkIo(options); if (failed) throw failure; } };
  const observed = await Promise.allSettled([source, workspace].map(root => discoverLinks(root, { ...policy, diagnosticStage: root === source ? "links.source" : "links.copy", diagnosticRole: root === source ? "source" : "copy" }).catch((error: unknown) => {
    if (!failed) { failed = true; failure = error; }
    throw error;
  })));
  if (failed) throw failure;
  for (let index = 0; index < observed.length; index++) {
    const result = observed[index]!;
    if (result.status === "rejected") throw result.reason;
    const side = index === 0 ? "original" : "copied";
    if (result.value.size !== ledger.size) throw new Error("Baseline symlink set changed");
    for (const [key, pair] of ledger) {
      const actual = result.value.get(key), expected = pair[side];
      if (!actual || !stable(actual.stat, expected.stat) || !actual.target.equals(expected.target)) throw new Error(`Baseline symlink changed: ${Buffer.from(key, "base64").toString("utf8")}`);
    }
  }
  }, "both");
}
export function verifyManifestLinks(snapshot: ManifestSnapshot, ledger: BaselineLinks, side: "original" | "copied"): void {
  if (snapshot.coverage !== "complete" || snapshot.issues.length) throw new Error("Incomplete inventory");
  const links = [...snapshot.entries].filter(([, entry]) => entry.kind === "symlink");
  if (links.length !== ledger.size) throw new Error("Baseline symlink set changed");
  for (const [key, entry] of links) {
    const expected = ledger.get(key)?.[side];
    if (!expected || entry.digest !== expected.digest || entry.mode !== Number(expected.stat.mode & 0o777n)) throw new Error("Baseline symlink changed");
  }
}
