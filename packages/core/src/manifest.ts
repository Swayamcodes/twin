import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, readlink } from "node:fs/promises";
import type { ReceiptPath } from "./receipt.js";

const MAX_ENTRIES = 100_000;
const MAX_HASH_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_PATH_BYTES = 4096;
const MAX_DEPTH = 128;
const MAX_SCAN_MS = 30_000;

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

export async function captureManifest(workspace: string | Buffer, includeDirectories = false): Promise<ManifestSnapshot> {
  const entries = new Map<string, ManifestEntry>();
  const issues: ManifestSnapshot["issues"] = [];
  const deadline = Date.now() + MAX_SCAN_MS;
  let count = 0;
  let hashedBytes = 0;
  let coverage: ManifestSnapshot["coverage"] = "complete";
  const modeMask = includeDirectories ? 0o777n : 0o7777n;
  const mark = (reason: string, path?: ReceiptPath): void => { coverage = "partial"; issues.push(path ? { reason, path } : { reason }); };
  const slash = Buffer.from("/");
  const gitRoot = Buffer.from(".git");
  const gitPrefix = Buffer.from(".git/");
  const stack: Array<{ abs: Buffer; rel: Buffer; depth: number }> = [{ abs: Buffer.from(workspace), rel: Buffer.alloc(0), depth: 0 }];

  try {
    while (stack.length > 0) {
      if (Date.now() > deadline) { mark("scan-timeout"); break; }
      const directory = stack.pop()!;
      let children: Awaited<ReturnType<typeof readdir>>;
      try { children = await readdir(directory.abs, { withFileTypes: true, encoding: "buffer" }); }
      catch { mark("directory-unavailable", directory.rel.length ? receiptPath(directory.rel) : undefined); continue; }
      for (const child of children) {
        if (Date.now() > deadline) { mark("scan-timeout"); stack.length = 0; break; }
        const name = Buffer.isBuffer(child.name) ? child.name : Buffer.from(child.name);
        const rel = directory.rel.length ? Buffer.concat([directory.rel, slash, name]) : name;
        if (rel.length > MAX_PATH_BYTES) { mark("path-limit"); continue; }
        if (++count > MAX_ENTRIES) { mark("entry-limit"); stack.length = 0; break; }
        const path = receiptPath(rel);
        const abs = Buffer.concat([directory.abs, slash, name]);
        try {
          const before = await lstat(abs, { bigint: true });
          if (before.isDirectory()) {
            if (includeDirectories || rel.equals(gitRoot) || rel.subarray(0, gitPrefix.length).equals(gitPrefix)) {
              entries.set(rel.toString("base64"), { path, kind: "directory", mode: Number(before.mode & modeMask), digest: "" });
            }
            if (directory.depth + 1 > MAX_DEPTH) mark("depth-limit", path);
            else stack.push({ abs, rel, depth: directory.depth + 1 });
            const after = await lstat(abs, { bigint: true });
            if (!sameIdentity(before, after)) mark("entry-changed-during-scan", path);
            continue;
          }
          let digest: string;
          let kind: ManifestEntry["kind"];
          if (before.isSymbolicLink()) {
            const target = await readlink(abs, { encoding: "buffer" });
            const after = await lstat(abs, { bigint: true });
            if (!sameIdentity(before, after)) { mark("entry-changed-during-scan", path); continue; }
            digest = createHash("sha256").update(target).digest("hex");
            kind = "symlink";
          } else if (before.isFile()) {
            if (typeof constants.O_NOFOLLOW !== "number") { mark("no-follow-unavailable", path); continue; }
            if (before.size > BigInt(MAX_HASH_BYTES - hashedBytes)) { mark("hash-limit", path); continue; }
            const handle = await open(abs, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
            try {
              const opened = await handle.stat({ bigint: true });
              if (!opened.isFile() || !sameIdentity(before, opened)) { mark("entry-changed-during-scan", path); continue; }
              const hash = createHash("sha256");
              const buffer = Buffer.allocUnsafe(64 * 1024);
              let readBytes = 0;
              for (;;) {
                if (Date.now() > deadline) { mark("scan-timeout", path); break; }
                const read = await handle.read(buffer, 0, buffer.length, null);
                if (read.bytesRead === 0) break;
                readBytes += read.bytesRead;
                if (readBytes > MAX_HASH_BYTES - hashedBytes) { mark("hash-limit", path); break; }
                hash.update(buffer.subarray(0, read.bytesRead));
              }
              const after = await handle.stat({ bigint: true });
              if (!sameIdentity(opened, after) || BigInt(readBytes) !== opened.size) { mark("entry-changed-during-scan", path); continue; }
              if (Date.now() > deadline || readBytes > MAX_HASH_BYTES - hashedBytes) continue;
              hashedBytes += readBytes;
              digest = hash.digest("hex");
              kind = "file";
            } finally { await handle.close(); }
          } else { mark("special-file", path); continue; }
          entries.set(rel.toString("base64"), { path, kind, mode: Number(before.mode & modeMask), digest });
        } catch { mark("entry-unavailable", path); }
      }
    }
  } catch { coverage = "unavailable"; issues.push({ reason: "scan-unavailable" }); }
  return { coverage, entries, issues };
}

export function unavailableManifest(reason: string): ManifestSnapshot {
  return { coverage: "unavailable", entries: new Map(), issues: [{ reason }] };
}
