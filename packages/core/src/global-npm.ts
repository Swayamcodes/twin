import { lstat, opendir, realpath } from "node:fs/promises";
import { isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { readBounded, type DependencyCoverage } from "./dependencies.js";

const MAX_PACKAGES = 256;
const MAX_METADATA_BYTES = 4 * 1024 * 1024;
const packageName = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
type Stat = import("node:fs").BigIntStats;
export interface GlobalNpmIssue { readonly phase: "before" | "after"; readonly name: string; readonly reason: string }
export interface GlobalNpmChange {
  readonly name: string;
  readonly change: "added" | "removed" | "changed";
  readonly before: string | null;
  readonly after: string | null;
}
export interface GlobalNpmReceipt {
  readonly coverage: DependencyCoverage;
  readonly source: "env-prefix" | "unavailable";
  readonly changes: readonly GlobalNpmChange[];
  readonly issues: readonly GlobalNpmIssue[];
}
export interface GlobalNpmSelection { readonly root?: string; readonly reason?: string }
export interface GlobalNpmSnapshot {
  readonly versions: ReadonlyMap<string, string>;
  readonly coverage: DependencyCoverage;
  readonly reason?: string;
  readonly issues: readonly { readonly name: string; readonly reason: string }[];
}
function within(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}
function same(a: Stat, b: Stat): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.size === b.size
    && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}
export function selectGlobalNpmRoot(env: Readonly<Record<string, string>>, argv: readonly string[], protectedRoots: readonly string[]): GlobalNpmSelection {
  const upper = env.NPM_CONFIG_PREFIX;
  const lower = env.npm_config_prefix;
  if (!upper && !lower) return { reason: "prefix-unset" };
  if (upper && lower && upper !== lower) return { reason: "prefix-conflict" };
  const prefix = upper ?? lower!;
  if (!isAbsolute(prefix) || resolve(prefix) !== prefix) return { reason: "prefix-invalid" };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (token === "--prefix" && argv[i + 1] !== prefix) return { reason: "prefix-override" };
    if (token.startsWith("--prefix=") && token.slice(9) !== prefix) return { reason: "prefix-override" };
  }
  const root = join(prefix, "lib", "node_modules");
  if (protectedRoots.some(protectedRoot => within(root, resolve(protectedRoot)) || within(resolve(protectedRoot), prefix))) {
    return { reason: "inside-protected-root" };
  }
  return { root };
}
export function unavailableGlobalNpm(reason: string): GlobalNpmSnapshot {
  return { versions: new Map(), coverage: "unavailable", reason, issues: [] };
}
async function checkedDirectory(path: string, missingAllowed: boolean): Promise<{ status: "present"; stat: Stat } | { status: "missing" } | { status: "unavailable"; reason: string }> {
  const base = parse(path).root;
  let current = base;
  const parts = path.slice(base.length).split(sep).filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    current = join(current, parts[i]!);
    try {
      const stat = await lstat(current, { bigint: true });
      if (stat.isSymbolicLink() || !stat.isDirectory()) return { status: "unavailable", reason: "symlink-or-special" };
      if (i === parts.length - 1) {
        if (await realpath(path) !== path) return { status: "unavailable", reason: "replaced" };
        return { status: "present", stat };
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" && missingAllowed && i >= parts.length - 2) return { status: "missing" };
      return { status: "unavailable", reason: (error as NodeJS.ErrnoException).code === "ENOENT" ? "prefix-missing" : "unreadable" };
    }
  }
  return { status: "unavailable", reason: "prefix-invalid" };
}
function validMetadata(text: string, name: string): string | null {
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    return record.name === name && typeof record.version === "string"
      && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(record.version)
      && record.version.length <= 256 ? record.version : null;
  } catch { return null; }
}
export async function captureGlobalNpm(root: string): Promise<GlobalNpmSnapshot> {
  const versions = new Map<string, string>();
  const issues: { name: string; reason: string }[] = [];
  const budget = { remaining: MAX_METADATA_BYTES };
  const baseline = await checkedDirectory(root, true);
  if (baseline.status === "unavailable") return unavailableGlobalNpm(baseline.reason);
  if (baseline.status === "missing") return { versions, coverage: "complete", issues };
  let count = 0;
  const scan = async (directory: string, scope?: string): Promise<void> => {
    const first = await lstat(directory, { bigint: true });
    if (!first.isDirectory() || first.isSymbolicLink()) { issues.push({ name: scope ?? "", reason: "replaced" }); return; }
    const entries: import("node:fs").Dirent[] = [];
    const dir = await opendir(directory);
    try {
      for await (const entry of dir) {
        entries.push(entry);
        if (entries.length > MAX_PACKAGES + 2) { issues.push({ name: scope ?? "", reason: "inventory-limit" }); return; }
      }
    } finally { await dir.close().catch(() => undefined); }
    for (const entry of entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      if (!scope && (entry.name === ".bin" || entry.name === ".package-lock.json")) continue;
      count++;
      if (count > MAX_PACKAGES) { issues.push({ name: scope ?? "", reason: "inventory-limit" }); break; }
      const name = scope ? `${scope}/${entry.name}` : entry.name;
      if (!scope && entry.name.startsWith("@")) {
        if (!/^@[a-z0-9][a-z0-9._-]*$/.test(entry.name) || !entry.isDirectory()) { issues.push({ name, reason: "invalid-entry" }); continue; }
        await scan(join(directory, entry.name), entry.name);
        continue;
      }
      if (!packageName.test(name) || !entry.isDirectory()) { issues.push({ name, reason: "invalid-entry" }); continue; }
      const path = join(directory, entry.name);
      const stat = await lstat(path, { bigint: true });
      if (!stat.isDirectory() || stat.isSymbolicLink()) { issues.push({ name, reason: "replaced" }); continue; }
      const metadata = await readBounded(path, "package.json", budget);
      if (metadata.status !== "available") { issues.push({ name, reason: metadata.status === "missing" ? "metadata-missing" : metadata.reason }); continue; }
      const version = validMetadata(metadata.text, name);
      if (version === null) { issues.push({ name, reason: "malformed-metadata" }); continue; }
      const after = await lstat(path, { bigint: true });
      if (!same(stat, after)) { issues.push({ name, reason: "replaced" }); continue; }
      versions.set(name, version);
    }
    const last = await lstat(directory, { bigint: true });
    if (!same(first, last)) issues.push({ name: scope ?? "", reason: "replaced" });
  };
  try {
    await scan(root);
    const last = await checkedDirectory(root, false);
    if (last.status !== "present" || !same(baseline.stat, last.stat)) issues.push({ name: "", reason: "replaced" });
  } catch { issues.push({ name: "", reason: "unreadable" }); }
  return { versions, coverage: issues.length ? "incomplete" : "complete", issues };
}
export function compareGlobalNpm(selection: GlobalNpmSelection, before: GlobalNpmSnapshot, after: GlobalNpmSnapshot): GlobalNpmReceipt {
  const issues: GlobalNpmIssue[] = [
    ...before.issues.map(issue => ({ phase: "before" as const, ...issue })),
    ...after.issues.map(issue => ({ phase: "after" as const, ...issue })),
  ];
  if (selection.reason) issues.unshift({ phase: "before", name: "", reason: selection.reason });
  if (before.reason) issues.push({ phase: "before", name: "", reason: before.reason });
  if (after.reason) issues.push({ phase: "after", name: "", reason: after.reason });
  const coverage = before.coverage === "unavailable" || after.coverage === "unavailable" ? "unavailable"
    : before.coverage === "incomplete" || after.coverage === "incomplete" ? "incomplete" : "complete";
  const changes: GlobalNpmChange[] = [];
  if (coverage === "complete") for (const name of [...new Set([...before.versions.keys(), ...after.versions.keys()])].sort()) {
    const old = before.versions.get(name) ?? null;
    const next = after.versions.get(name) ?? null;
    if (old !== next) changes.push({ name, change: old === null ? "added" : next === null ? "removed" : "changed", before: old, after: next });
  }
  return { coverage, source: selection.root ? "env-prefix" : "unavailable", changes, issues };
}
