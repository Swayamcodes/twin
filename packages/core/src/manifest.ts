import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { performance } from "node:perf_hooks";
import { lstat, open, readdir, readlink } from "node:fs/promises";
import { IoOperation, IoPool, IO_WINDOW, measured, type Diagnostics, type DiagnosticStage, type DiagnosticRole } from "./io-pool.js";
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
  readonly pool?: IoPool | undefined;
  readonly diagnostics?: Diagnostics | undefined;
  readonly diagnosticStage?: DiagnosticStage | undefined;
  readonly diagnosticRole?: DiagnosticRole | undefined;
}
export function normalizeScanOptions(options: ManifestScanOptions) {
  const requestedTimeout = options.timeoutMs;
  const timeoutMs = requestedTimeout === undefined ? DEFAULT_SCAN_TIMEOUT_MS : requestedTimeout;
  const signal = options.signal;
  if (!validScanTimeoutMs(timeoutMs)) throw new Error("Invalid Twin scan timeout: expected integer 1–3600000 ms.");
  if (signal !== undefined && !(signal instanceof AbortSignal)) throw new Error("Invalid Twin scan signal.");
  return Object.freeze({ timeoutMs, signal, ...(options.pool ? { pool: options.pool } : {}), ...(options.diagnostics ? { diagnostics: options.diagnostics } : {}), ...(options.diagnosticStage ? { diagnosticStage: options.diagnosticStage } : {}), ...(options.diagnosticRole ? { diagnosticRole: options.diagnosticRole } : {}) });
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

interface ScanViews { readonly raw: ManifestSnapshot; readonly receipt: ManifestSnapshot; readonly apply: ManifestSnapshot }
function project(snapshot: ManifestSnapshot, apply: boolean): ManifestSnapshot {
  return { coverage: snapshot.coverage, issues: snapshot.issues.map(issue => ({ ...issue })),
    entries: new Map([...snapshot.entries].filter(([key, entry]) => {
      const path = Buffer.from(key, "base64");
      return apply || entry.kind !== "directory" || path.equals(Buffer.from(".git")) || path.subarray(0, 5).equals(Buffer.from(".git/"));
    })
      .map(([key, entry]) => [key, apply ? { ...entry, mode: entry.mode & 0o777 } : { ...entry }])) };
}
export async function captureManifestViews(workspace: string | Buffer, options: ManifestScanOptions = {}): Promise<ScanViews> {
  const raw = await captureRaw(workspace, options);
  const receipt = project(raw, false), apply = project(raw, true);
  options.diagnostics?.project(raw, receipt); options.diagnostics?.project(raw, apply);
  return { raw, receipt, apply };
}
export async function captureManifest(workspace: string | Buffer, includeDirectories = false, options: ManifestScanOptions = {}): Promise<ManifestSnapshot> {
  const raw = await captureRaw(workspace, options), view = project(raw, includeDirectories);
  options.diagnostics?.project(raw, view); return view;
}
async function captureRaw(workspace: string | Buffer, options: ManifestScanOptions): Promise<ManifestSnapshot> {
  const entries = new Map<string, ManifestEntry>();
  const issues: ManifestSnapshot["issues"] = [];
  const policy = normalizeScanOptions(options), pool = policy.pool ?? new IoPool();
  const span = policy.diagnostics?.start(policy.diagnosticStage ?? "inventory", policy.diagnosticRole ?? "none");
  let readBytes = 0; let terminationKind: "none" | "cancelled" | "deadline" = "none";
  const deadline = performance.now() + policy.timeoutMs;
  let count = 0, committedBytes = 0, reservedBytes = 0;
  let coverage: ManifestSnapshot["coverage"] = "complete";
  const mark = (reason: string, path?: ReceiptPath): void => {
    if (coverage === "complete") coverage = "partial";
    issues.push(path ? { reason, path } : { reason });
  };
  let terminated = false;
  const termination = new Error("Inventory terminated");
  const stopped = (path?: ReceiptPath): boolean => {
    if (terminated) return true;
    const reason = policy.signal?.aborted ? "scan-cancelled" : performance.now() >= deadline ? "scan-timeout" : undefined;
    if (reason) { mark(reason, path); terminated = true; terminationKind = reason === "scan-cancelled" ? "cancelled" : "deadline"; }
    return terminated;
  };
  const check = (): void => { if (stopped()) throw termination; };
  type Directory = { abs: Buffer; rel: Buffer; depth: number };
  type Candidate = { abs: Buffer; rel: Buffer; path: ReceiptPath; before?: import("node:fs").BigIntStats; unavailable?: true };
  type Result = { candidate: Candidate; entry?: ManifestEntry; directory?: Directory; issues: string[]; bytes: number };
  const stack: Directory[] = [{ abs: Buffer.from(workspace), rel: Buffer.alloc(0), depth: 0 }];
  const observe = async (candidate: Candidate, depth: number): Promise<Result> => {
    const result: Result = { candidate, issues: [], bytes: 0 };
    const { abs, rel, path, before } = candidate;
    if (!before) { result.issues.push("entry-unavailable"); return result; }
    try {
      if (before.isDirectory()) {
        result.entry = { path, kind: "directory", mode: Number(before.mode & 0o7777n), digest: "" };
        if (depth + 1 > MAX_DEPTH) result.issues.push("depth-limit");
        else result.directory = { abs, rel, depth: depth + 1 };
        const after = await measured(span, "metadata", () => lstat(abs, { bigint: true }));
        if (!sameIdentity(before, after)) result.issues.push("entry-changed-during-scan");
        stopped(path); return result;
      }
      if (before.isSymbolicLink()) {
        const target = await measured(span, "metadata", () => readlink(abs, { encoding: "buffer" }));
        const after = await measured(span, "metadata", () => lstat(abs, { bigint: true }));
        if (!sameIdentity(before, after)) result.issues.push("entry-changed-during-scan");
        if (!stopped(path) && !result.issues.length) result.entry = { path, kind: "symlink", mode: Number(before.mode & 0o7777n), digest: createHash("sha256").update(target).digest("hex") };
        return result;
      }
      if (!before.isFile()) { result.issues.push("special-file"); return result; }
      if (typeof constants.O_NOFOLLOW !== "number") { result.issues.push("no-follow-unavailable"); return result; }
      const handle = await measured(span, "open", () => open(abs, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK));
      let digest: string | undefined;
      try {
        if (stopped(path)) return result;
        const opened = await measured(span, "metadata", () => handle.stat({ bigint: true }));
        if (!opened.isFile() || !sameIdentity(before, opened)) { result.issues.push("entry-changed-during-scan"); return result; }
        const hash = createHash("sha256"), buffer = Buffer.allocUnsafe(65536);
        let bytes = 0, eof = false, exceeded = false;
        for (;;) {
          if (stopped(path)) break;
          const read = await measured(span, "read", () => handle.read(buffer, 0, Math.min(buffer.length, Number(opened.size) - bytes + 1), null));
          bytes += read.bytesRead; readBytes += read.bytesRead;
          if (stopped(path)) break;
          if (!read.bytesRead) { eof = true; break; }
          if (BigInt(bytes) > opened.size) { exceeded = true; if (bytes > MAX_HASH_BYTES) result.issues.push("hash-limit"); break; }
          if (span) span.sync("hash", () => hash.update(buffer.subarray(0, read.bytesRead)));
          else hash.update(buffer.subarray(0, read.bytesRead));
        }
        const after = await measured(span, "metadata", () => handle.stat({ bigint: true }));
        const changed = !sameIdentity(opened, after);
        if (changed) result.issues.push("entry-changed-during-scan");
        if (stopped(path) || changed) return result;
        if (!eof || exceeded || BigInt(bytes) !== opened.size) { if (!result.issues.includes("hash-limit")) result.issues.push("file-read-incomplete"); return result; }
        digest = hash.digest("hex"); result.bytes = bytes;
      } finally { await measured(span, "close", () => handle.close()); }
      if (!stopped(path) && digest !== undefined) result.entry = { path, kind: "file", mode: Number(before.mode & 0o7777n), digest };
      else result.bytes = 0;
    } catch { result.bytes = 0; result.issues.push("entry-unavailable"); }
    return result;
  };
  try {
    scan: while (stack.length) {
      if (stopped()) break;
      const directory = stack.pop()!;
      let children: Awaited<ReturnType<typeof readdir>>;
      try { children = await measured(span, "enumeration", () => readdir(directory.abs, { withFileTypes: true, encoding: "buffer" })); }
      catch { mark("directory-unavailable", directory.rel.length ? receiptPath(directory.rel) : undefined); continue; }
      if (stopped(directory.rel.length ? receiptPath(directory.rel) : undefined)) break;
      // Metadata and hashing are separate stages: no worker waits for byte allowance.
      for (let offset = 0; offset < children.length; offset += IO_WINDOW) {
        const candidates: Candidate[] = [];
        let metadataError: unknown;
        const metadata = new IoOperation<Candidate>(pool, outcome => { if (outcome.ok) candidates.push(outcome.value); }, check, span);
        try {
          for (const child of children.slice(offset, offset + IO_WINDOW)) {
            if (stopped()) break;
            const name = Buffer.isBuffer(child.name) ? child.name : Buffer.from(child.name);
            const rel = directory.rel.length ? Buffer.concat([directory.rel, Buffer.from("/"), name]) : name;
            if (rel.length > MAX_PATH_BYTES) { mark("path-limit"); continue; }
            if (++count > MAX_ENTRIES) { mark("entry-limit"); stack.length = 0; break; }
            const candidate: Candidate = { abs: Buffer.concat([directory.abs, Buffer.from("/"), name]), rel, path: receiptPath(rel) };
            await metadata.enqueue(async () => {
              try { const before = await measured(span, "metadata", () => lstat(candidate.abs, { bigint: true })); stopped(candidate.path); return { ...candidate, before }; }
              catch { return { ...candidate, unavailable: true }; }
            });
          }
        } catch (error: unknown) { metadataError = error; metadata.stop(error); }
        try { await metadata.drain(); } catch (error: unknown) { metadataError ??= error; }
        if (metadataError !== undefined && metadataError !== termination) throw metadataError;
        if (stopped()) break scan;
        const reservations = new Map<Candidate, number>();
        let observationError: unknown;
        const observations = new IoOperation<Result>(pool, outcome => {
          if (!outcome.ok) return;
          const result = outcome.value;
          const reservation = reservations.get(result.candidate) ?? 0;
          reservedBytes -= reservation; reservations.delete(result.candidate);
          if (result.entry) { entries.set(result.candidate.rel.toString("base64"), result.entry); committedBytes += result.bytes; }
          if (result.directory) stack.push(result.directory);
          for (const reason of result.issues) mark(reason, result.candidate.path);
        }, check, span);
        try {
          for (const candidate of candidates) {
            check();
            const size = candidate.before?.isFile() ? candidate.before.size : 0n;
            while (size > BigInt(MAX_HASH_BYTES - committedBytes - reservedBytes) && reservations.size) {
              await observations.flushOne(); check();
            }
            if (size > BigInt(MAX_HASH_BYTES - committedBytes - reservedBytes)) { mark("hash-limit", candidate.path); continue; }
            const reservation = Number(size);
            reservations.set(candidate, reservation); reservedBytes += reservation;
            try { await observations.enqueue(() => observe(candidate, directory.depth)); }
            catch (error: unknown) { reservedBytes -= reservation; reservations.delete(candidate); throw error; }
          }
        } catch (error: unknown) { observationError = error; observations.stop(error); }
        try { await observations.drain(); } catch (error: unknown) { observationError ??= error; }
        // Queued jobs skipped after termination have no hash to commit.
        for (const reservation of reservations.values()) reservedBytes -= reservation;
        if (observationError !== undefined && observationError !== termination) throw observationError;
        if (stopped()) break scan;
        if (count > MAX_ENTRIES) break scan;
      }
    }
  } catch { coverage = "unavailable"; issues.push({ reason: "scan-unavailable" }); }
  stopped();
  const result = { coverage, entries, issues };
  if (span) { policy.diagnostics?.inventory(result, span, { budgetMs: policy.timeoutMs, discovered: count, acceptedHashBytes: committedBytes, readBytes, termination: terminationKind, entries: entries.size }); span.end(coverage === "complete" ? "complete" : "failed", true); }
  return result;
}

export function unavailableManifest(reason: string): ManifestSnapshot {
  return { coverage: "unavailable", entries: new Map(), issues: [{ reason }] };
}
