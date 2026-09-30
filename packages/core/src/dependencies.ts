import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { join } from "node:path";

const MAX_INPUT_BYTES = 1024 * 1024;
const MAX_TOTAL_BYTES = 4 * 1024 * 1024;
const LOCKFILES = ["package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml"] as const;
const FIELDS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"] as const;
export type DependencyField = typeof FIELDS[number];
export type DependencyCoverage = "complete" | "incomplete" | "unavailable";
export interface DependencyIssue { readonly phase: "before" | "after"; readonly path: string; readonly reason: string }
export interface DependencyChange {
  readonly field: DependencyField;
  readonly name: string;
  readonly change: "added" | "removed" | "changed";
  readonly before: string | null;
  readonly after: string | null;
}
export interface LockfileChange { readonly path: typeof LOCKFILES[number]; readonly change: "added" | "removed" | "changed"; readonly beforeDigest: string | null; readonly afterDigest: string | null }
export interface DependencyReceipt {
  readonly declarations: { readonly coverage: DependencyCoverage; readonly changes: readonly DependencyChange[] };
  readonly lockfiles: { readonly coverage: DependencyCoverage; readonly changes: readonly LockfileChange[] };
  readonly issues: readonly DependencyIssue[];
}
type ReadResult = { readonly status: "missing" } | { readonly status: "available"; readonly text: string; readonly digest: string } | { readonly status: "unavailable"; readonly reason: string };
export interface DependencySnapshot {
  readonly declarations: ReadonlyMap<DependencyField, ReadonlyMap<string, string>> | null;
  readonly manifestStatus: ReadResult["status"];
  readonly locks: ReadonlyMap<typeof LOCKFILES[number], ReadResult>;
  readonly issues: readonly { readonly path: string; readonly reason: string }[];
  readonly unavailable: boolean;
}
function same(a: import("node:fs").BigIntStats, b: import("node:fs").BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}
export async function readBounded(root: string, name: string, budget: { remaining: number }): Promise<ReadResult> {
  const path = join(root, name);
  let first: import("node:fs").BigIntStats;
  try { first = await lstat(path, { bigint: true }); }
  catch (error: unknown) { return (error as NodeJS.ErrnoException).code === "ENOENT" ? { status: "missing" } : { status: "unavailable", reason: "unreadable" }; }
  if (!first.isFile() || first.nlink !== 1n) return { status: "unavailable", reason: "replaced" };
  if (first.size > BigInt(MAX_INPUT_BYTES) || first.size > BigInt(budget.remaining)) return { status: "unavailable", reason: "oversized" };
  if (typeof constants.O_NOFOLLOW !== "number") return { status: "unavailable", reason: "no-follow-unavailable" };
  try {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const opened = await handle.stat({ bigint: true });
      if (!opened.isFile() || !same(first, opened)) return { status: "unavailable", reason: "replaced" };
      const bytes = Buffer.alloc(Number(opened.size));
      let offset = 0;
      while (offset < bytes.length) {
        const result = await handle.read(bytes, offset, bytes.length - offset, offset);
        if (result.bytesRead === 0) return { status: "unavailable", reason: "changed-during-read" };
        offset += result.bytesRead;
      }
      const last = await handle.stat({ bigint: true });
      if (!same(opened, last)) return { status: "unavailable", reason: "changed-during-read" };
      let pathname: import("node:fs").BigIntStats;
      try { pathname = await lstat(path, { bigint: true }); }
      catch (error: unknown) {
        return { status: "unavailable", reason: (error as NodeJS.ErrnoException).code === "ENOENT" ? "replaced" : "unreadable" };
      }
      if (!pathname.isFile() || pathname.nlink !== 1n || pathname.dev !== opened.dev || pathname.ino !== opened.ino) {
        return { status: "unavailable", reason: "replaced" };
      }
      if (!same(opened, pathname)) return { status: "unavailable", reason: "changed-during-read" };
      budget.remaining -= bytes.length;
      try { return { status: "available", text: new TextDecoder("utf-8", { fatal: true }).decode(bytes), digest: createHash("sha256").update(bytes).digest("hex") }; }
      catch { return { status: "unavailable", reason: "malformed-utf8" }; }
    } finally { await handle.close(); }
  } catch { return { status: "unavailable", reason: "unreadable" }; }
}
function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function declarations(text: string): ReadonlyMap<DependencyField, ReadonlyMap<string, string>> | null {
  try {
    const value: unknown = JSON.parse(text);
    if (!record(value)) return null;
    const result = new Map<DependencyField, ReadonlyMap<string, string>>();
    for (const field of FIELDS) {
      const section = value[field];
      if (section === undefined) continue;
      if (!record(section)) return null;
      const entries = Object.entries(section);
      if (entries.some(([name, version]) => !name || typeof version !== "string")) return null;
      result.set(field, new Map(entries as [string, string][]));
    }
    return result;
  } catch { return null; }
}
function validLock(name: string, text: string): boolean {
  if (name === "pnpm-lock.yaml") return /^lockfileVersion:\s*['"]?\d+(?:\.\d+)?['"]?\s*(?:\r?\n|$)/.test(text);
  try { const parsed: unknown = JSON.parse(text); return record(parsed) && (typeof parsed.lockfileVersion === "number" || typeof parsed.lockfileVersion === "string"); }
  catch { return false; }
}
export async function captureDependencies(root: string): Promise<DependencySnapshot> {
  const issues: { path: string; reason: string }[] = [];
  const budget = { remaining: MAX_TOTAL_BYTES };
  const manifest = await readBounded(root, "package.json", budget);
  let parsed: DependencySnapshot["declarations"] = null;
  if (manifest.status === "available") {
    parsed = declarations(manifest.text);
    if (!parsed) issues.push({ path: "package.json", reason: "malformed" });
  } else issues.push({ path: "package.json", reason: manifest.status === "missing" ? "missing" : manifest.reason });
  const locks = new Map<typeof LOCKFILES[number], ReadResult>();
  for (const name of LOCKFILES) {
    const entry = await readBounded(root, name, budget);
    if (entry.status === "available" && !validLock(name, entry.text)) {
      locks.set(name, { status: "unavailable", reason: "malformed" });
      issues.push({ path: name, reason: "malformed" });
    } else {
      locks.set(name, entry);
      if (entry.status === "unavailable") issues.push({ path: name, reason: entry.reason });
    }
  }
  return { declarations: parsed, manifestStatus: manifest.status, locks, issues, unavailable: false };
}
export function unavailableDependencies(reason: string): DependencySnapshot {
  return { declarations: null, manifestStatus: "unavailable", locks: new Map(), issues: [{ path: "package.json", reason }], unavailable: true };
}
export function compareDependencies(before: DependencySnapshot, after: DependencySnapshot): DependencyReceipt {
  const issues: DependencyIssue[] = [
    ...before.issues.map(issue => ({ phase: "before" as const, ...issue })),
    ...after.issues.map(issue => ({ phase: "after" as const, ...issue })),
  ];
  const declarationChanges: DependencyChange[] = [];
  if (before.declarations && after.declarations) for (const field of FIELDS) {
    const old = before.declarations.get(field) ?? new Map<string, string>();
    const next = after.declarations.get(field) ?? new Map<string, string>();
    for (const name of [...new Set([...old.keys(), ...next.keys()])].sort()) {
      const a = old.get(name) ?? null;
      const b = next.get(name) ?? null;
      if (a !== b) declarationChanges.push({ field, name, change: a === null ? "added" : b === null ? "removed" : "changed", before: a, after: b });
    }
  }
  const lockChanges: LockfileChange[] = [];
  for (const name of LOCKFILES) {
    const a = before.locks.get(name);
    const b = after.locks.get(name);
    if (!a || !b || a.status === "unavailable" || b.status === "unavailable") continue;
    if (a.status === "missing" && b.status === "missing") continue;
    if (a.status === "available" && b.status === "available" && a.digest === b.digest) continue;
    lockChanges.push({ path: name, change: a.status === "missing" ? "added" : b.status === "missing" ? "removed" : "changed", beforeDigest: a.status === "available" ? a.digest : null, afterDigest: b.status === "available" ? b.digest : null });
    if (a.status === "available" && b.status === "missing") issues.push({ phase: "after", path: name, reason: "missing" });
  }
  const coverage = (problem: boolean): DependencyCoverage => before.unavailable || after.unavailable ? "unavailable" : problem ? "incomplete" : "complete";
  return {
    declarations: { coverage: coverage(!before.declarations || !after.declarations), changes: declarationChanges },
    lockfiles: { coverage: coverage(issues.some(issue => LOCKFILES.some(name => name === issue.path))), changes: lockChanges },
    issues,
  };
}
