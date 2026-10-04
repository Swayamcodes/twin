import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { performance } from "node:perf_hooks";
import { lstat, open, readdir, readlink } from "node:fs/promises";
import type { ReceiptPath } from "./receipt.js";

const MAX_ENTRIES = 100_000;
const MAX_HASH_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_PATH_BYTES = 4096;
const MAX_DEPTH = 128;
export const DEFAULT_SCAN_TIMEOUT_MS = 30_000;
export const MAX_SCAN_TIMEOUT_MS = 3_600_000;
export function validScanTimeoutMs(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= MAX_SCAN_TIMEOUT_MS;
}
export interface ManifestScanOptions {
  readonly timeoutMs?: number | undefined;
  readonly signal?: AbortSignal | undefined;
}
export function normalizeScanOptions(options: ManifestScanOptions) {
  const requestedTimeout = options.timeoutMs;
  const timeoutMs = requestedTimeout === undefined ? DEFAULT_SCAN_TIMEOUT_MS : requestedTimeout;
  const signal = options.signal;
  if (!validScanTimeoutMs(timeoutMs)) throw new Error("Invalid Twin scan timeout: expected integer 1–3600000 ms.");
  if (signal !== undefined && !(signal instanceof AbortSignal)) throw new Error("Invalid Twin scan signal.");
  return Object.freeze({ timeoutMs, signal });
}
export class ScanCancelledError extends Error {
  constructor() { super("Scan cancelled"); }
}
export function checkScanCancellation(options: ManifestScanOptions): void {
  if (options.signal?.aborted) throw new ScanCancelledError();
}

export interface ManifestEntry {
  readonly path: ReceiptPath;
  readonly kind: "file" | "symlink" | "directory";
  readonly mode: number;
  readonly digest: string;
}
export interface ManifestSnapshot {
  readonly coverage: "complete" | "partial" | "unavailable";
  readonly entries: Map<string, ManifestEntry>;
  readonly issues: Array<{ reason: string; path?: ReceiptPath }>;
}

export function receiptPath(raw: Buffer): ReceiptPath {
  const value = raw.toString("utf8");
  return Buffer.from(value, "utf8").equals(raw)
    ? { encoding: "utf8", value }
    : { encoding: "base64", value: raw.toString("base64") };
}

function sameIdentity(a: import("node:fs").BigIntStats, b: import("node:fs").BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.mode === b.mode
    && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}

export async function captureManifest(workspace: string | Buffer, includeDirectories = false, options: ManifestScanOptions = {}): Promise<ManifestSnapshot> {
  const entries = new Map<string, ManifestEntry>();
  const issues: ManifestSnapshot["issues"] = [];
  const policy = normalizeScanOptions(options);
  const deadline = performance.now() + policy.timeoutMs;
  let count = 0;
  let hashedBytes = 0;
  let coverage: ManifestSnapshot["coverage"] = "complete";
  const modeMask = includeDirectories ? 0o777n : 0o7777n;
  const mark = (reason: string, path?: ReceiptPath): void => { if (coverage === "complete") coverage = "partial"; issues.push(path ? { reason, path } : { reason }); };
  let terminated = false;
  const stopped = (path?: ReceiptPath): boolean => {
    if (terminated) return true;
    const reason = policy.signal?.aborted ? "scan-cancelled" : performance.now() >= deadline ? "scan-timeout" : undefined;
    if (reason) { mark(reason, path); terminated = true; }
    return terminated;
  };
  const slash = Buffer.from("/");
  const gitRoot = Buffer.from(".git");
  const gitPrefix = Buffer.from(".git/");
  const stack: Array<{ abs: Buffer; rel: Buffer; depth: number }> = [{ abs: Buffer.from(workspace), rel: Buffer.alloc(0), depth: 0 }];

  try {
    scan: while (stack.length > 0) {
      if (stopped()) break;
      const directory = stack.pop()!;
      let children: Awaited<ReturnType<typeof readdir>>;
      try { children = await readdir(directory.abs, { withFileTypes: true, encoding: "buffer" }); }
      catch { mark("directory-unavailable", directory.rel.length ? receiptPath(directory.rel) : undefined); continue; }
      if (stopped(directory.rel.length ? receiptPath(directory.rel) : undefined)) break;
      for (const child of children) {
        if (stopped()) break scan;
        const name = Buffer.isBuffer(child.name) ? child.name : Buffer.from(child.name);
        const rel = directory.rel.length ? Buffer.concat([directory.rel, slash, name]) : name;
        if (rel.length > MAX_PATH_BYTES) { mark("path-limit"); continue; }
        if (++count > MAX_ENTRIES) { mark("entry-limit"); stack.length = 0; break; }
        const path = receiptPath(rel);
        const abs = Buffer.concat([directory.abs, slash, name]);
        try {
          const before = await lstat(abs, { bigint: true });
          if (stopped(path)) break scan;
          if (before.isDirectory()) {
            if (includeDirectories || rel.equals(gitRoot) || rel.subarray(0, gitPrefix.length).equals(gitPrefix)) {
              entries.set(rel.toString("base64"), { path, kind: "directory", mode: Number(before.mode & modeMask), digest: "" });
            }
            if (directory.depth + 1 > MAX_DEPTH) mark("depth-limit", path);
            else stack.push({ abs, rel, depth: directory.depth + 1 });
            const after = await lstat(abs, { bigint: true });
            if (!sameIdentity(before, after)) mark("entry-changed-during-scan", path);
            if (stopped(path)) break scan;
            continue;
          }
          let digest: string;
          let kind: ManifestEntry["kind"];
          if (before.isSymbolicLink()) {
            const target = await readlink(abs, { encoding: "buffer" });
            const after = await lstat(abs, { bigint: true });
            if (!sameIdentity(before, after)) { mark("entry-changed-during-scan", path); continue; }
            if (stopped(path)) break scan;
            digest = createHash("sha256").update(target).digest("hex");
            kind = "symlink";
          } else if (before.isFile()) {
            if (typeof constants.O_NOFOLLOW !== "number") { mark("no-follow-unavailable", path); continue; }
            if (before.size > BigInt(MAX_HASH_BYTES - hashedBytes)) { mark("hash-limit", path); continue; }
            const handle = await open(abs, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
            try {
              if (stopped(path)) break scan;
              const opened = await handle.stat({ bigint: true });
              if (!opened.isFile() || !sameIdentity(before, opened)) { mark("entry-changed-during-scan", path); continue; }
              const hash = createHash("sha256");
              const buffer = Buffer.allocUnsafe(64 * 1024);
              let readBytes = 0;
              let eof = false;
              let hashLimit = false;
              for (;;) {
                if (stopped(path)) break;
                const read = await handle.read(buffer, 0, buffer.length, null);
                readBytes += read.bytesRead;
                if (stopped(path)) break;
                if (read.bytesRead === 0) { eof = true; break; }
                if (readBytes > MAX_HASH_BYTES - hashedBytes) { mark("hash-limit", path); hashLimit = true; break; }
                hash.update(buffer.subarray(0, read.bytesRead));
              }
              const after = await handle.stat({ bigint: true });
              const changed = !sameIdentity(opened, after);
              if (changed) mark("entry-changed-during-scan", path);
              if (stopped(path)) break scan;
              if (changed || hashLimit) continue;
              if (!eof || BigInt(readBytes) !== opened.size) { mark("file-read-incomplete", path); continue; }
              hashedBytes += readBytes;
              digest = hash.digest("hex");
              kind = "file";
            } finally { await handle.close(); }
          } else { mark("special-file", path); continue; }
          if (stopped(path)) break scan;
          entries.set(rel.toString("base64"), { path, kind, mode: Number(before.mode & modeMask), digest });
        } catch { mark("entry-unavailable", path); }
      }
    }
  } catch { coverage = "unavailable"; issues.push({ reason: "scan-unavailable" }); }
  stopped(); // Includes a late abort/deadline in the last awaited operation or close.
  return { coverage, entries, issues };
}

export function unavailableManifest(reason: string): ManifestSnapshot {
  return { coverage: "unavailable", entries: new Map(), issues: [{ reason }] };
}
