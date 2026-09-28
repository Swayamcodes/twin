import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import type { WatchId, WatchObservation } from "./receipt.js";

const MAX_WATCH_BYTES = 1024 * 1024;
const IDS: readonly WatchId[] = [
  ".gitconfig", ".npmrc", ".bashrc", ".zshrc",
  ".codex/config.toml", ".claude/settings.json", ".gemini/settings.json",
];

export interface WatchCapture {
  readonly id: WatchId;
  readonly observation: WatchObservation;
  readonly digest?: string; // Private; never copied into the public receipt.
}

function within(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function same(a: import("node:fs").BigIntStats, b: import("node:fs").BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.mode === b.mode
    && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}

async function checkComponents(path: string): Promise<"ok" | "missing" | "symlink" | "special" | "unavailable"> {
  const root = parse(path).root;
  const parts = path.slice(root.length).split(sep).filter(Boolean);
  let current = root;
  for (let i = 0; i < parts.length; i++) {
    current = join(current, parts[i]!);
    try {
      const stat = await lstat(current, { bigint: true });
      if (stat.isSymbolicLink()) return "symlink";
      if (i < parts.length - 1 && !stat.isDirectory()) return "special";
      if (i === parts.length - 1 && !stat.isFile()) return "special";
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
      return "unavailable";
    }
  }
  return "ok";
}

async function captureOne(id: WatchId, home: string | undefined, roots: readonly string[]): Promise<WatchCapture> {
  const fail = (status: "refused" | "unavailable", reason: string): WatchCapture => ({ id, observation: { status, reason } });
  if (!home || !isAbsolute(home)) return fail("unavailable", "home-unavailable");
  const path = resolve(home, id);
  if (roots.some(root => within(path, root))) return fail("refused", "inside-protected-root");
  const components = await checkComponents(path);
  if (components === "missing") return { id, observation: { status: "missing" } };
  if (components === "symlink" || components === "special") return fail("refused", components);
  if (components !== "ok") return fail("unavailable", "path-unavailable");
  try {
    const canonical = await realpath(path);
    if (roots.some(root => within(canonical, root))) return fail("refused", "inside-protected-root");
    if (canonical !== path) return fail("refused", "symlink");
    if (typeof constants.O_NOFOLLOW !== "number") return fail("unavailable", "no-follow-unavailable");
    const before = await lstat(path, { bigint: true });
    if (!before.isFile()) return fail("refused", "special");
    if (before.size > BigInt(MAX_WATCH_BYTES)) return fail("unavailable", "oversized");
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const opened = await handle.stat({ bigint: true });
      if (!opened.isFile() || !same(before, opened)) return fail("unavailable", "replaced");
      const hash = createHash("sha256");
      const buffer = Buffer.allocUnsafe(64 * 1024);
      let bytes = 0;
      for (;;) {
        const result = await handle.read(buffer, 0, Math.min(buffer.length, MAX_WATCH_BYTES + 1 - bytes), null);
        if (result.bytesRead === 0) break;
        bytes += result.bytesRead;
        if (bytes > MAX_WATCH_BYTES) return fail("unavailable", "oversized");
        hash.update(buffer.subarray(0, result.bytesRead));
      }
      const after = await handle.stat({ bigint: true });
      const pathAfter = await lstat(path, { bigint: true });
      if (!same(opened, after) || !same(after, pathAfter) || BigInt(bytes) !== opened.size
        || await checkComponents(path) !== "ok" || await realpath(path) !== path) {
        return fail("unavailable", "replaced");
      }
      return {
        id,
        observation: { status: "present", size: String(opened.size), mode: Number(opened.mode & 0o7777n), mtimeNs: String(opened.mtimeNs) },
        digest: hash.digest("hex"),
      };
    } finally { await handle.close(); }
  } catch { return fail("unavailable", "read-failed"); }
}

export async function captureWatches(home: string | undefined, roots: readonly string[]): Promise<WatchCapture[]> {
  const canonicalRoots = await Promise.all(roots.map(async root => {
    try { return await realpath(root); } catch { return resolve(root); }
  }));
  const result: WatchCapture[] = [];
  for (const id of IDS) result.push(await captureOne(id, home, canonicalRoots));
  return result;
}

export function unavailableWatches(reason: string): WatchCapture[] {
  return IDS.map(id => ({ id, observation: { status: "unavailable", reason } }));
}
