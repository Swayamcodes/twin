import { createHash, randomBytes } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { chmod, lstat, mkdir, open, realpath, rename, rmdir, unlink } from "node:fs/promises";
import { diagnosticStage } from "./io-pool.js";
import { receiptPath, type ManifestEntry, type ManifestScanOptions, type ManifestSnapshot } from "./manifest.js";
import type { ReceiptPath } from "./receipt.js";
import { assertRootAuthority, sameIdentity, type OwnedRoot } from "./safety.js";
import { verifyManifestLinks, type BaselineLinks } from "./symlink-policy.js";
import { AffectedFault, AffectedObserver, absolute, ancestors, bytesOf, depthOf, equalEntry, fault, rawStable, statOrAbsent,
  type AffectedReasonCode, type Observation } from "./apply-affected-observer.js";

export type AffectedApplyPhase = "admission" | "preflight" | "before-write" | "mutation" | "final-verification" | "temporary-cleanup" | "complete";
interface PathDiagnostics { readonly paths: readonly ReceiptPath[]; readonly pathCount: number; readonly pathsTruncated: boolean }
export interface AffectedApplySecondaryFailure extends PathDiagnostics { readonly phase: AffectedApplyPhase; readonly reasonCode: AffectedReasonCode }
interface AffectedApplyScope extends PathDiagnostics {
  readonly scope: "affected-paths"; readonly outsideScope: "not-rechecked"; readonly phase: AffectedApplyPhase;
  readonly plannedTargets: number | null; readonly verifiedTargets: number; readonly destructiveSubtrees: number;
  readonly scopeCoverage: "complete" | "incomplete" | "not-observed";
  readonly secondaryFailures: readonly AffectedApplySecondaryFailure[]; readonly secondaryFailuresTruncated: boolean;
}
export type AffectedApplyResult = AffectedApplyScope & (
  | { readonly status: "applied"; readonly changes: number }
  | { readonly status: "conflict" | "refused"; readonly reasonCode: AffectedReasonCode; readonly reason: string }
  | { readonly status: "failed"; readonly reasonCode: AffectedReasonCode; readonly reason: string; readonly partialApplicationPossible: true });
const paths = (keys: readonly string[]): PathDiagnostics => {
  const unique = [...new Set(keys)]; return { paths: unique.slice(0, 64).map(key => receiptPath(bytesOf(key))), pathCount: unique.length, pathsTruncated: unique.length > 64 };
};
export function affectedAdmissionRefusal(): AffectedApplyResult {
  return { scope: "affected-paths", outsideScope: "not-rechecked", phase: "admission", plannedTargets: null,
    verifiedTargets: 0, destructiveSubtrees: 0, scopeCoverage: "not-observed", ...paths([]), secondaryFailures: [],
    secondaryFailuresTruncated: false, status: "refused", reasonCode: "settlement-uncertain", reason: "Command settlement or session state uncertain" };
}
interface Change { readonly key: string; readonly before: ManifestEntry | undefined; readonly final: ManifestEntry | undefined }
interface Temporary { readonly path: Buffer; readonly key: string; readonly parent: Buffer; readonly parentStat: BigIntStats; readonly stat: BigIntStats }
const complete = (...snapshots: ManifestSnapshot[]): boolean => snapshots.every(snapshot => snapshot.coverage === "complete" && !snapshot.issues.length);
const conflictCodes = new Set<AffectedReasonCode>(["original-conflict", "original-changed-before-write", "unplanned-subtree-child"]);

/** Explicit narrower contract. Whole-tree applyCopy is deliberately independent. */
export async function applyAffectedCopy(root: OwnedRoot, sourceIdentity: BigIntStats, before: ManifestSnapshot,
  copyBaseline: ManifestSnapshot, settled: ManifestSnapshot, links: BaselineLinks, options: ManifestScanOptions): Promise<AffectedApplyResult> {
  let phase: AffectedApplyPhase = "admission", started = false, mutationAttempted = false, planned: number | null = null, verified = 0;
  let destructive: string[] = []; const performed = new Set<string>();
  const secondary: AffectedApplySecondaryFailure[] = []; let secondaryTruncated = false;
  const temps = new Set<Temporary>();
  const addSecondary = (error: AffectedFault, at: AffectedApplyPhase): void => {
    if (secondary.length < 4) secondary.push({ phase: error.code === "temporary-cleanup-refused" ? "temporary-cleanup" : at, reasonCode: error.code, ...paths(error.keys) }); else secondaryTruncated = true;
    for (const nested of error.secondary) addSecondary(nested, at);
  };
  const resultScope = (at: AffectedApplyPhase, coverage: AffectedApplyScope["scopeCoverage"], keys: readonly string[]): AffectedApplyScope => ({
    scope: "affected-paths", outsideScope: "not-rechecked", phase: at, plannedTargets: planned, verifiedTargets: verified,
    destructiveSubtrees: destructive.length, scopeCoverage: coverage, ...paths(keys), secondaryFailures: secondary,
    secondaryFailuresTruncated: secondaryTruncated });
  const check = (): void => { if (options.signal?.aborted) throw new AffectedFault("scan-cancelled"); };
  const roots = async (cancellable = true): Promise<void> => {
    if (cancellable) check();
    try {
      await assertRootAuthority(root);
      const actual = await lstat(root.source, { bigint: true });
      if (!actual.isDirectory() || !sameIdentity(actual, sourceIdentity) || await realpath(root.source) !== root.source) throw new Error("Original root authority changed");
    } catch (error: unknown) { throw new AffectedFault("root-authority", [], error); }
    if (cancellable) check();
  };
  const mutate = async <T>(operation: () => Promise<T>): Promise<T> => { check(); mutationAttempted = true; const value = await operation(); check(); return value; };
  const cleanup = async (temp: Temporary): Promise<void> => {
    await roots(false);
    // Unaborted cleanup checks authority without hashing or relying on a stopped observer.
    for (const key of ancestors(temp.key)) {
      const expected = sourcePins.get(key)?.stat, actual = await lstat(absolute(root.source, key), { bigint: true });
      if (!expected || !actual.isDirectory() || !sameIdentity(expected, actual)) throw new AffectedFault("temporary-cleanup-refused", [temp.key]);
    }
    const parent = await lstat(temp.parent, { bigint: true });
    if (!parent.isDirectory() || !sameIdentity(parent, temp.parentStat)) throw new AffectedFault("temporary-cleanup-refused", [temp.key]);
    const actual = await statOrAbsent(temp.path);
    if (actual) {
      if (!actual.isFile() || !sameIdentity(actual, temp.stat) || actual.uid !== temp.stat.uid || actual.nlink !== 1n) throw new AffectedFault("temporary-cleanup-refused", [temp.key]);
      mutationAttempted = true; await unlink(temp.path);
    }
    temps.delete(temp);
  };
  let sourcePins = new Map<string, Observation>(), copyPins = new Map<string, Observation>();
  const expectedSource = new Map<string, ManifestEntry | undefined>();
  let failure: AffectedFault | undefined, failurePhase: AffectedApplyPhase = "admission";
  try {
    check(); await roots();
    options.diagnostics?.guard("apply.affected", [["original-baseline", before], ["copy-baseline", copyBaseline], ["settled-copy", settled], ["fresh-copy", undefined], ["fresh-original", undefined]]);
    if (!complete(before, copyBaseline, settled)) throw new AffectedFault("baseline-incomplete");
    try { verifyManifestLinks(before, links, "original"); verifyManifestLinks(copyBaseline, links, "copied"); verifyManifestLinks(settled, links, "copied"); }
    catch (error: unknown) { throw new AffectedFault("historical-link-change", [], error); }
    const baselineKeys = new Set([...before.entries.keys(), ...copyBaseline.entries.keys()]);
    for (const key of baselineKeys) { check(); if (!links.has(key) && !equalEntry(before.entries.get(key), copyBaseline.entries.get(key))) throw new AffectedFault("baseline-incomplete", [key]); }
    const changes: Change[] = [];
    for (const key of new Set([...copyBaseline.entries.keys(), ...settled.entries.keys()])) {
      check();
      if (!links.has(key) && !equalEntry(copyBaseline.entries.get(key), settled.entries.get(key))) {
        absolute(root.source, key); changes.push({ key, before: before.entries.get(key), final: settled.entries.get(key) });
      }
    }
    planned = changes.length; const keys = changes.map(change => change.key), targetSet = new Set(keys);
    const candidates = changes.filter(change => change.before?.kind === "directory" && change.final?.kind !== "directory").map(change => change.key).sort((a, b) => depthOf(a) - depthOf(b));
    const destructiveCandidates = new Set(candidates);
    destructive = candidates.filter(key => { check(); return !ancestors(key).some(parent => destructiveCandidates.has(parent)); });
    const requiredAncestors = new Set(keys.flatMap(ancestors));
    const validateAncestors = (observations: ReadonlyMap<string, Observation>): void => {
      for (const key of requiredAncestors) if (!targetSet.has(key) && observations.get(key)?.entry?.kind !== "directory") throw new AffectedFault("unsafe-ancestor", [key]);
    };
    const validateCopy = (observations: ReadonlyMap<string, Observation>): void => {
      for (const [key, observation] of observations) {
        if (!equalEntry(observation.entry, settled.entries.get(key))) {
          // Ancestor directories can change only through reviewed D transitions; all copy observations match F.
          throw new AffectedFault("copy-target-changed", [key]);
        }
      }
    };
    const observePhase = async (stage: "apply.affected.preflight" | "apply.affected.before-write" | "apply.affected.final", final = false): Promise<void> => {
      await diagnosticStage(options.diagnostics, stage, async () => {
        await roots();
        const copy = new AffectedObserver(root.workspace, options, phase === "preflight" ? undefined : copyPins);
        // Drain each observer before returning. Separate observers have separate configured inventory budgets.
        await copy.targets(keys); validateCopy(copy.observations); validateAncestors(copy.observations);
        const source = new AffectedObserver(root.source, options, phase === "preflight" ? undefined : sourcePins);
        await source.targets(keys); validateAncestors(source.observations);
        for (const key of destructive) {
          const subtree = await source.subtree(key);
          for (const [child, observation] of subtree) if (child !== key && observation.entry && !before.entries.has(child) && !settled.entries.has(child)) throw new AffectedFault("unplanned-subtree-child", [child]);
        }
        if (phase === "preflight") {
          const conflicts: string[] = [];
          for (const change of changes) {
            const current = source.observations.get(change.key)?.entry;
            if (!equalEntry(current, change.before) && !equalEntry(current, change.final)) conflicts.push(change.key);
          }
          if (conflicts.length) throw new AffectedFault("original-conflict", conflicts);
          sourcePins = source.observations; copyPins = copy.observations;
          for (const [key, observation] of sourcePins) expectedSource.set(key, observation.entry);
        } else {
          for (const [key, observed] of source.observations) {
            const expected = final && targetSet.has(key) ? settled.entries.get(key) : expectedSource.get(key);
            if (!equalEntry(observed.entry, expected)) throw new AffectedFault(final ? "final-state-mismatch" : "original-changed-before-write", [key]);
          }
          if (final) { for (const key of keys) { if (!source.observations.has(key) || !copy.observations.has(key)) throw new AffectedFault("final-state-mismatch", [key]); verified++; } }
        }
        await roots();
      }, "both");
    };
    phase = "preflight"; started = true; await observePhase("apply.affected.preflight");
    phase = "before-write"; await observePhase("apply.affected.before-write");
    const active = changes.filter(change => !equalEntry(expectedSource.get(change.key), change.final));
    const verify = async (key: string): Promise<{ source: Observation; copy: Observation }> => diagnosticStage(options.diagnostics, "apply.affected.verify", async () => {
      await roots();
      const copy = new AffectedObserver(root.workspace, options, copyPins);
      const copied = await copy.observe(key); validateCopy(copy.observations);
      const source = new AffectedObserver(root.source, options, sourcePins);
      const current = await source.observe(key);
      for (const [observedKey, observation] of source.observations) if (!equalEntry(observation.entry, expectedSource.get(observedKey))) throw new AffectedFault("original-changed-before-write", [observedKey]);
      await roots(); return { source: current, copy: copied };
    }, "both");
    const pinNew = async (key: string, owned?: BigIntStats): Promise<void> => {
      await roots(); const observed = await lstat(absolute(root.source, key), { bigint: true }); check();
      if (observed.isSymbolicLink() || (!observed.isDirectory() && !observed.isFile()) || (owned && !sameIdentity(observed, owned))) throw new AffectedFault("target-identity-changed", [key]);
      sourcePins.set(key, { stat: observed, entry: expectedSource.get(key) });
    };
    phase = "mutation";
    const removals = active.filter(change => expectedSource.get(change.key) && expectedSource.get(change.key)?.kind !== change.final?.kind).sort((a, b) => depthOf(b.key) - depthOf(a.key));
    for (const change of removals) {
      const current = (await verify(change.key)).source;
      if (current.entry?.kind === "directory") {
        const observer = new AffectedObserver(root.source, options, sourcePins); const subtree = await observer.subtree(change.key);
        const children = [...subtree].filter(([key, value]) => key !== change.key && value.entry);
        if (children.length) throw new AffectedFault("unplanned-subtree-child", children.map(([key]) => key));
      }
      await roots(); await mutate(() => current.entry?.kind === "directory" ? rmdir(absolute(root.source, change.key)) : unlink(absolute(root.source, change.key)));
      sourcePins.set(change.key, { entry: undefined, stat: undefined }); expectedSource.set(change.key, undefined); performed.add(change.key);
    }
    const directories = active.filter(change => change.final?.kind === "directory" && expectedSource.get(change.key)?.kind !== "directory").sort((a, b) => depthOf(a.key) - depthOf(b.key));
    for (const change of directories) {
      await verify(change.key); await roots(); await mutate(() => mkdir(absolute(root.source, change.key), { mode: 0o700 }));
      expectedSource.set(change.key, { ...change.final!, mode: 0o700 }); await pinNew(change.key); performed.add(change.key);
    }
    const files = active.filter(change => change.final?.kind === "file").sort((a, b) => depthOf(a.key) - depthOf(b.key));
    for (const change of files) {
      const observed = await verify(change.key);
      const sourceStat = observed.copy.stat;
      if (!sourceStat?.isFile()) throw new AffectedFault("unsafe-target", [change.key]);
      const target = absolute(root.source, change.key), parent = target.subarray(0, target.lastIndexOf(47));
      const temporaryPath = Buffer.concat([parent, Buffer.from(`/.twin-apply-${randomBytes(16).toString("hex")}`)]);
      let input: Awaited<ReturnType<typeof open>> | undefined, output: Awaited<ReturnType<typeof open>> | undefined, ownedTemp: Temporary | undefined, transferFailure: AffectedFault | undefined;
      try {
        await diagnosticStage(options.diagnostics, "apply.affected.transfer", async () => {
          const budget = new AffectedObserver(root.workspace, options);
          budget.check(); input = await open(absolute(root.workspace, change.key), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); budget.check();
          const opened = await budget.io("metadata", () => input!.stat({ bigint: true }));
          if (!opened.isFile() || !rawStable(opened, sourceStat)) throw new AffectedFault("target-identity-changed", [change.key]);
          await roots();
          for (const ancestor of ancestors(change.key)) {
            const expected = sourcePins.get(ancestor)?.stat, actual = await budget.io("ancestors", () => lstat(absolute(root.source, ancestor), { bigint: true }));
            if (!expected || !actual.isDirectory() || !sameIdentity(expected, actual) || actual.mode !== expected.mode) throw new AffectedFault("unsafe-ancestor", [ancestor]);
          }
          const parentStat = await budget.io("metadata", () => lstat(parent, { bigint: true }));
          const parentKey = ancestors(change.key).at(-1), expectedParent = parentKey ? sourcePins.get(parentKey)?.stat : sourceIdentity;
          if (!expectedParent || !parentStat.isDirectory() || !sameIdentity(parentStat, expectedParent)) throw new AffectedFault("unsafe-ancestor", [change.key]);
          // Do not check cancellation after issued exclusive open before registering its owned descriptor identity.
          budget.check(); check(); mutationAttempted = true; output = await open(temporaryPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
          const tempStat = await output.stat({ bigint: true });
          if (!tempStat.isFile() || tempStat.nlink !== 1n) throw new AffectedFault("unsafe-target", [change.key]);
          ownedTemp = { path: temporaryPath, key: change.key, parent, parentStat, stat: tempStat }; temps.add(ownedTemp); budget.check();
          const hash = createHash("sha256"), buffer = Buffer.allocUnsafe(65536); let bytes = 0n;
          for (;;) {
            const read = await budget.io("read", () => input!.read(buffer, 0, Math.min(buffer.length, Number(opened.size - bytes) + 1), null));
            if (!read.bytesRead) break;
            bytes += BigInt(read.bytesRead); if (bytes > opened.size) throw new AffectedFault("file-read-incomplete", [change.key]);
            hash.update(buffer.subarray(0, read.bytesRead)); let written = 0;
            while (written < read.bytesRead) {
              budget.check(); const part = await mutate(() => output!.write(buffer, written, read.bytesRead - written, null));
              if (!part.bytesWritten) throw new AffectedFault("io-unavailable", [change.key]); written += part.bytesWritten;
            }
          }
          const after = await budget.io("metadata", () => input!.stat({ bigint: true }));
          if (!rawStable(opened, after)) throw new AffectedFault("target-identity-changed", [change.key]);
          if (bytes !== opened.size || hash.digest("hex") !== change.final!.digest) throw new AffectedFault("file-read-incomplete", [change.key]);
          budget.check(); await mutate(() => output!.chmod(change.final!.mode)); budget.check();
          const permissionStat = await budget.io("metadata", () => output!.stat({ bigint: true }));
          if (!permissionStat.isFile() || !sameIdentity(permissionStat, ownedTemp.stat) || permissionStat.nlink !== 1n) throw new AffectedFault("target-identity-changed", [change.key]);
          if (Number(permissionStat.mode & 0o777n) !== change.final!.mode) throw new AffectedFault("mode-not-preserved", [change.key]);
        }, "both");
      } catch (error: unknown) { transferFailure = fault(error); }
      finally {
        if (input && transferFailure) {
          try {
            const endpoint = await input.stat({ bigint: true }), pathEndpoint = await lstat(absolute(root.workspace, change.key), { bigint: true });
            if (!rawStable(sourceStat, endpoint) || !rawStable(sourceStat, pathEndpoint)) transferFailure.secondary.push(new AffectedFault("target-identity-changed", [change.key]));
          } catch (error: unknown) { transferFailure.secondary.push(fault(error)); }
        }
        if (output && !ownedTemp) {
          const unowned = new AffectedFault("temporary-cleanup-refused", [change.key]);
          if (transferFailure) transferFailure.secondary.push(unowned); else transferFailure = unowned;
        }
        for (const handle of [output, input]) if (handle) try { await handle.close(); } catch (error: unknown) { if (transferFailure) transferFailure.secondary.push(fault(error)); else transferFailure = fault(error); }
      }
      if (transferFailure) throw transferFailure;
      await verify(change.key); await roots();
      const currentTemp = await statOrAbsent(temporaryPath);
      if (!ownedTemp || !currentTemp?.isFile() || !sameIdentity(currentTemp, ownedTemp.stat) || currentTemp.nlink !== 1n) throw new AffectedFault("target-identity-changed", [change.key]);
      if (Number(currentTemp.mode & 0o777n) !== change.final!.mode) throw new AffectedFault("mode-not-preserved", [change.key]);
      await mutate(() => rename(temporaryPath, target));
      expectedSource.set(change.key, change.final); await pinNew(change.key, ownedTemp.stat); performed.add(change.key);
      phase = "temporary-cleanup";
      try { await diagnosticStage(options.diagnostics, "apply.affected.cleanup", () => cleanup(ownedTemp!), "source"); }
      catch (error: unknown) { throw new AffectedFault("temporary-cleanup-refused", [change.key], error); }
      phase = "mutation";
    }
    for (const change of active.filter(change => change.final?.kind === "directory").sort((a, b) => depthOf(b.key) - depthOf(a.key))) {
      await verify(change.key); await roots(); await mutate(() => chmod(absolute(root.source, change.key), change.final!.mode));
      expectedSource.set(change.key, change.final); await pinNew(change.key, sourcePins.get(change.key)?.stat); performed.add(change.key);
    }
    phase = "final-verification"; await observePhase("apply.affected.final", true); check();
  } catch (error: unknown) { failure = fault(error); failurePhase = phase; for (const nested of failure.secondary) addSecondary(nested, phase); }
  // Cleanup never replaces an earlier failure and is independent of an aborted scan signal.
  for (const temp of temps) {
    try { await diagnosticStage(options.diagnostics, "apply.affected.cleanup", () => cleanup(temp), "source"); }
    catch (error: unknown) {
      const cleanFailure = new AffectedFault("temporary-cleanup-refused", [temp.key], error);
      if (failure) addSecondary(cleanFailure, "temporary-cleanup"); else { failure = cleanFailure; failurePhase = "temporary-cleanup"; }
    }
  }
  if (failure) {
    const base = { ...resultScope(failurePhase, started ? "incomplete" : "not-observed", failure.keys), reasonCode: failure.code, reason: failure.message };
    return mutationAttempted ? { ...base, status: "failed", partialApplicationPossible: true } : { ...base, status: conflictCodes.has(failure.code) ? "conflict" : "refused" };
  }
  return { ...resultScope("complete", "complete", []), status: "applied", changes: performed.size };
}
