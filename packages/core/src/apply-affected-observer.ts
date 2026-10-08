import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { IoOperation, IoPool, measured, type DiagnosticSpan } from "./io-pool.js";
import { normalizeScanOptions, receiptPath, type ManifestEntry, type ManifestScanOptions } from "./manifest.js";
import { sameIdentity } from "./safety.js";

export type AffectedReasonCode = "settlement-uncertain" | "baseline-incomplete" | "historical-link-change"
  | "root-authority" | "unsafe-ancestor" | "unsafe-target" | "copy-target-changed" | "original-conflict"
  | "original-changed-before-write" | "target-identity-changed" | "unplanned-subtree-child" | "scan-timeout"
  | "scan-cancelled" | "file-read-incomplete" | "scope-limit" | "io-unavailable" | "final-state-mismatch"
  | "temporary-cleanup-refused" | "mode-not-preserved";
export class AffectedFault extends Error {
  readonly secondary: AffectedFault[] = [];
  constructor(readonly code: AffectedReasonCode, readonly keys: readonly string[] = [], cause?: unknown) {
    super(code, cause === undefined ? undefined : { cause });
  }
}
export const fault = (error: unknown): AffectedFault => error instanceof AffectedFault ? error : new AffectedFault("io-unavailable", [], error);
export interface Observation { readonly entry: ManifestEntry | undefined; readonly stat: BigIntStats | undefined }
export const equalEntry = (a: ManifestEntry | undefined, b: ManifestEntry | undefined): boolean => a === b || (!!a && !!b && a.kind === b.kind && a.mode === b.mode && a.digest === b.digest);
export const rawStable = (a: BigIntStats, b: BigIntStats): boolean => sameIdentity(a, b) && a.mode === b.mode
  && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs && a.uid === b.uid && a.gid === b.gid && a.nlink === b.nlink;
export const bytesOf = (key: string): Buffer => Buffer.from(key, "base64");
export const depthOf = (key: string): number => bytesOf(key).filter(byte => byte === 47).length + 1;
export function absolute(root: string, key: string): Buffer {
  const rel = bytesOf(key);
  if (!rel.length || rel.length > 4096 || depthOf(key) > 128 || rel[0] === 47 || rel.includes(0)
      || rel.toString("latin1").split("/").some(part => !part || part === "." || part === "..") || rel.toString("base64") !== key) {
    throw new AffectedFault("scope-limit", [key]);
  }
  return Buffer.concat([Buffer.from(root), Buffer.from("/"), rel]);
}
export function ancestors(key: string): string[] {
  const raw = bytesOf(key), result: string[] = [];
  for (let i = 0; i < raw.length; i++) if (raw[i] === 47) result.push(raw.subarray(0, i).toString("base64"));
  return result;
}
export const below = (key: string, parent: string): boolean => bytesOf(key).subarray(0, bytesOf(parent).length + 1).equals(Buffer.concat([bytesOf(parent), Buffer.from("/")]));
const missing = (error: unknown): boolean => error instanceof Error && "code" in error && error.code === "ENOENT";
export async function statOrAbsent(path: Buffer): Promise<BigIntStats | undefined> {
  try { return await lstat(path, { bigint: true }); } catch (error: unknown) { if (missing(error)) return undefined; throw error; }
}
/** One fresh phase. No live observations are reused between phases or operations. */
export class AffectedObserver {
  readonly #deadline: number;
  readonly #policy: ReturnType<typeof normalizeScanOptions>;
  readonly #seen = new Set<string>();
  #reserved = 0;
  #committed = 0;
  readonly observations = new Map<string, Observation>();
  constructor(readonly root: string, options: ManifestScanOptions, readonly pins?: ReadonlyMap<string, Observation>, readonly span?: DiagnosticSpan) {
    this.#policy = normalizeScanOptions(options); this.#deadline = performance.now() + this.#policy.timeoutMs;
  }
  check = (): void => {
    if (this.#policy.signal?.aborted) throw new AffectedFault("scan-cancelled");
    if (performance.now() >= this.#deadline) throw new AffectedFault("scan-timeout");
  };
  async io<T>(name: Parameters<typeof measured>[1], work: () => Promise<T>): Promise<T> {
    this.check(); const result = await measured(this.span, name, work); this.check(); return result;
  }
  #count(key: string): void {
    absolute(this.root, key);
    if (!this.#seen.has(key)) { this.#seen.add(key); if (this.#seen.size > 100_000) throw new AffectedFault("scope-limit", [key]); }
  }
  #pin(key: string, observed: Observation): void {
    const expected = this.pins?.get(key);
    if (this.pins?.has(key) && (expected?.stat ? !observed.stat || !sameIdentity(expected.stat, observed.stat) : !!observed.stat)) {
      throw new AffectedFault("target-identity-changed", [key]);
    }
    const previous = this.observations.get(key);
    if (previous && (previous.stat ? !observed.stat || !sameIdentity(previous.stat, observed.stat) : !!observed.stat)) throw new AffectedFault("target-identity-changed", [key]);
    this.observations.set(key, observed);
  }
  async #direct(key: string, ancestor: boolean): Promise<Observation> {
    this.#count(key); const path = absolute(this.root, key);
    const before = await this.io("metadata", () => statOrAbsent(path));
    if (!before) { const result = { entry: undefined, stat: undefined }; this.#pin(key, result); return result; }
    if (before.isSymbolicLink() || (!before.isDirectory() && !before.isFile())) throw new AffectedFault(ancestor ? "unsafe-ancestor" : "unsafe-target", [key]);
    let entry: ManifestEntry;
    if (before.isDirectory()) {
      const after = await this.io("metadata", () => lstat(path, { bigint: true }));
      // Incidental sibling churn may change directory timestamps. Identity/type/mode must remain stable.
      if (!sameIdentity(before, after) || before.mode !== after.mode) throw new AffectedFault("target-identity-changed", [key]);
      entry = { path: receiptPath(bytesOf(key)), kind: "directory", mode: Number(before.mode & 0o777n), digest: "" };
    } else {
      if (before.size > BigInt(2 * 1024 * 1024 * 1024 - this.#reserved - this.#committed)) throw new AffectedFault("scope-limit", [key]);
      const reserved = Number(before.size); this.#reserved += reserved;
      let accepted = false;
      let primary: AffectedFault | undefined;
      let handle: Awaited<ReturnType<typeof open>> | undefined;
      let digest: string | undefined;
      let opened: BigIntStats | undefined;
      try {
        // A cancelled open must still close its admitted descriptor.
        this.check(); handle = await measured(this.span, "open", () => open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)); this.check();
        opened = await this.io("metadata", () => handle!.stat({ bigint: true }));
        if (!opened.isFile() || !rawStable(before, opened)) throw new AffectedFault("target-identity-changed", [key]);
        const hash = createHash("sha256"), buffer = Buffer.allocUnsafe(65536); let bytes = 0;
        for (;;) {
          const read = await this.io("read", () => handle!.read(buffer, 0, Math.min(buffer.length, reserved - bytes + 1), null));
          if (!read.bytesRead) break;
          bytes += read.bytesRead;
          if (bytes > reserved) throw new AffectedFault("file-read-incomplete", [key]);
          hash.update(buffer.subarray(0, read.bytesRead));
        }
        const after = await this.io("metadata", () => handle!.stat({ bigint: true }));
        const finalPath = await this.io("metadata", () => lstat(path, { bigint: true }));
        if (!rawStable(opened, after) || !rawStable(before, finalPath)) throw new AffectedFault("target-identity-changed", [key]);
        if (bytes !== reserved) throw new AffectedFault("file-read-incomplete", [key]);
        digest = hash.digest("hex"); accepted = true;
      } catch (error: unknown) { primary = fault(error); }
      finally {
        if (handle && primary) {
          // Interrupted admitted reads still observe endpoint metadata without the stopped signal.
          try {
            const endpoint = await measured(this.span, "metadata", () => handle!.stat({ bigint: true }));
            const pathEndpoint = await measured(this.span, "metadata", () => lstat(path, { bigint: true }));
            if ((opened && !rawStable(opened, endpoint)) || !rawStable(before, pathEndpoint)) primary.secondary.push(new AffectedFault("target-identity-changed", [key]));
          } catch (error: unknown) { primary.secondary.push(fault(error)); }
        }
        if (handle) try { await measured(this.span, "close", () => handle!.close()); } catch (error: unknown) { if (primary) primary.secondary.push(fault(error)); else primary = fault(error); }
        this.#reserved -= reserved; if (accepted && !primary) this.#committed += reserved;
      }
      if (primary) throw primary;
      entry = { path: receiptPath(bytesOf(key)), kind: "file", mode: Number(before.mode & 0o777n), digest: digest! };
    }
    const result = { entry, stat: before }; this.#pin(key, result); return result;
  }
  async observe(key: string): Promise<Observation> {
    this.check(); absolute(this.root, key);
    const chain: { key: string; stat: BigIntStats }[] = [];
    for (const parent of ancestors(key)) {
      const observed = await this.#direct(parent, true);
      if (!observed.stat || observed.entry?.kind === "file") {
        // Logical absence is established by this freshly pinned ordinary obstacle, never arbitrary ENOTDIR.
        const result = { entry: undefined, stat: undefined }; this.#count(key); this.#pin(key, result);
        for (const previous of chain) {
          const actual = await this.io("ancestors", () => lstat(absolute(this.root, previous.key), { bigint: true }));
          if (!actual.isDirectory() || !sameIdentity(previous.stat, actual) || actual.mode !== previous.stat.mode) throw new AffectedFault("unsafe-ancestor", [previous.key]);
        }
        return result;
      }
      chain.push({ key: parent, stat: observed.stat });
    }
    const result = await this.#direct(key, false);
    for (const parent of chain) {
      const actual = await this.io("ancestors", () => lstat(absolute(this.root, parent.key), { bigint: true }));
      if (!actual.isDirectory() || !sameIdentity(parent.stat, actual) || actual.mode !== parent.stat.mode) throw new AffectedFault("unsafe-ancestor", [parent.key]);
    }
    return result;
  }
  async targets(keys: readonly string[]): Promise<Map<string, Observation>> {
    const operation = new IoOperation<readonly [string, Observation]>(this.#policy.pool ?? new IoPool(), outcome => {
      if (!outcome.ok) throw outcome.error;
      this.observations.set(...outcome.value);
    }, this.check, this.span);
    try { for (const key of keys) await operation.enqueue(async () => [key, await this.observe(key)] as const); }
    catch (error: unknown) { operation.stop(error); }
    await operation.drain(); this.check(); return this.observations;
  }
  async subtree(key: string): Promise<Map<string, Observation>> {
    const stack = [key]; const found = new Map<string, Observation>();
    while (stack.length) {
      const current = stack.pop()!, observed = await this.observe(current); found.set(current, observed);
      if (observed.entry?.kind !== "directory") continue;
      const before = await this.io("metadata", () => lstat(absolute(this.root, current), { bigint: true }));
      if (!observed.stat || !sameIdentity(observed.stat, before)) throw new AffectedFault("target-identity-changed", [current]);
      const names = await this.io("enumeration", () => readdir(absolute(this.root, current), { encoding: "buffer" }));
      const children = names.map(name => Buffer.concat([bytesOf(current), Buffer.from("/"), name]).toString("base64"));
      for (const child of children) this.#count(child);
      for (const child of children) { const childObservation = await this.observe(child); found.set(child, childObservation); if (childObservation.entry?.kind === "directory") stack.push(child); }
      const after = await this.io("metadata", () => lstat(absolute(this.root, current), { bigint: true }));
      if (!rawStable(before, after)) throw new AffectedFault("target-identity-changed", [current]);
    }
    return found;
  }
}
