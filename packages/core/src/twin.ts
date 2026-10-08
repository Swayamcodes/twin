/// <reference types="node" />

import { IoPool, PREPARATION_LINK_WORKERS, Diagnostics, diagnosticStage, type DiagnosticListener } from "./io-pool.js";
import { copySource } from "./copy.js";
import { lstat, realpath } from "node:fs/promises";
import type { BigIntStats } from "node:fs";
import { applyCopy, type ApplyResult } from "./apply.js";
import { applyAffectedCopy, affectedAdmissionRefusal, type AffectedApplyResult } from "./apply-affected.js";
import { runCommand, validateRunOptions } from "./run.js";
import { allocateRoot, assertRootAuthority, discardRoot, sameIdentity } from "./safety.js";
import { captureManifest, captureManifestViews, unavailableManifest, normalizeScanOptions, checkScanCancellation, type ManifestSnapshot } from "./manifest.js";
import { captureGitCategories, unavailableGit, type GitSnapshot } from "./git-classification.js";
import { captureWatches, unavailableWatches, type WatchCapture } from "./watch.js";
import { buildCommandReceipt, buildReceipt, unavailableProcessReceipt, type MinimalReceipt, type ProcessReceipt } from "./receipt.js";
import { captureDependencies, unavailableDependencies, type DependencySnapshot } from "./dependencies.js";
import { captureGlobalNpm, selectGlobalNpmRoot, unavailableGlobalNpm } from "./global-npm.js";
import { verifyBaselineLinks, type BaselineLinks } from "./symlink-policy.js";

export interface CreateTwinOptions {
  /** Optional bounded observations; callback failures do not participate in validation. */
  readonly onDiagnostic?: DiagnosticListener | undefined;
  readonly sourceDirectory: string;
  readonly scratchParent: string;
  /** Budget for each individual inventory; independent of command timeout. */
  readonly scanTimeoutMs?: number;
  /** Cooperative inventory cancellation; does not itself terminate a running command. */
  readonly scanSignal?: AbortSignal;
}
export interface RunOptions {
  readonly executable: string;
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
  /** Abort with SIGINT or SIGTERM to interrupt the command process group. */
  readonly interruptSignal?: AbortSignal;
  /** Inherit the caller's three stdio descriptors; output is not captured. */
  readonly stdio?: "inherit";
}
export interface CapturedOutput {
  readonly bytes: Uint8Array;
  readonly truncated: boolean;
  readonly complete: boolean;
  readonly error: string | null;
}
export interface RunResult {
  readonly schemaVersion: 1;
  readonly outcome: "exited" | "spawn-failed" | "timed-out";
  readonly started: boolean;
  readonly directChildSettled: boolean;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly spawnError: string | null;
  readonly stdout: CapturedOutput;
  readonly stderr: CapturedOutput;
  readonly terminationError: string | null;
  readonly lifecycleIssue?: string;
}
export type DiscardResult =
  | { readonly status: "removed" | "already-removed" }
  | { readonly status: "refused"; readonly reason: string }
  | { readonly status: "failed"; readonly reason: string; readonly partialDeletionPossible: true };
export interface TwinInspection {
  readonly workspacePath: string;
  readonly state: "ready" | "running" | "finished" | "applying" | "child-unsettled" | "discarding" | "discarded" | "discard-failed";
  readonly receipt?: MinimalReceipt;
}
export interface TwinSession {
  readonly workspacePath: string;
  run(options: RunOptions): Promise<RunResult>;
  inspect(): TwinInspection;
  apply(): Promise<ApplyResult>;
  /** Explicit affected-path contract; paths come only from the settled private delta. */
  applyAffected(): Promise<AffectedApplyResult>;
  discard(): Promise<DiscardResult>;
}
export async function createTwin(options: CreateTwinOptions): Promise<TwinSession> {
  const diagnostics = Diagnostics.capture(options);
  const scanOptions = normalizeScanOptions({ diagnostics, timeoutMs: options.scanTimeoutMs, signal: options.scanSignal, pool: new IoPool() });
  checkScanCancellation(scanOptions);
  const home = process.env.HOME;
  const root = await diagnosticStage(diagnostics, "preparation.allocate", () => allocateRoot(options));
  const preparationSpan = diagnostics?.start("preparation", "both");
  let sourceIdentity: BigIntStats;
  let links: BaselineLinks;
  let state: TwinInspection["state"] = "ready";
  let childSettled = true;
  let lifecycleIssue: string | null = null;
  let receipt: MinimalReceipt | undefined;
  const protectedRoots = [options.sourceDirectory, root.path, root.workspace];
  const captureProjectDependencies = async (): Promise<DependencySnapshot> => {
    await assertRootAuthority(root);
    return captureDependencies(root.workspace);
  };
  let captureBefore: Awaited<ReturnType<typeof preparationSnapshots>>;
  let originalBefore: ManifestSnapshot;
  let copyBefore: ManifestSnapshot;
  let preparationFiles: ManifestSnapshot;
  async function preparationSnapshots() {
    return Promise.allSettled([
      diagnosticStage(diagnostics, "preparation.git", () => captureGitCategories(root.workspace, protectedRoots)),
      diagnosticStage(diagnostics, "preparation.watch", () => captureWatches(home, protectedRoots)),
      diagnosticStage(diagnostics, "preparation.dependencies", captureProjectDependencies),
    ] as const);
  }
  try {
    sourceIdentity = await lstat(root.source, { bigint: true });
    checkScanCancellation(scanOptions);
    links = await copySource(root, scanOptions);
    checkScanCancellation(scanOptions);
    captureBefore = await preparationSnapshots();
    checkScanCancellation(scanOptions);
    originalBefore = await captureManifest(root.source, true, { ...scanOptions, diagnosticStage: "preparation.original", diagnosticRole: "source" });
    checkScanCancellation(scanOptions);
    const copyViews = await captureManifestViews(root.workspace, { ...scanOptions, diagnosticStage: "preparation.copy-inventory", diagnosticRole: "copy" });
    copyBefore = copyViews.apply;
    preparationFiles = copyViews.receipt;
    checkScanCancellation(scanOptions);
    await verifyBaselineLinks(root.source, root.workspace, links, { ...scanOptions, pool: new IoPool(PREPARATION_LINK_WORKERS) });
    const sourceAfter = await lstat(root.source, { bigint: true });
    if (!sourceAfter.isDirectory() || !sameIdentity(sourceIdentity, sourceAfter) || await realpath(root.source) !== root.source) {
      throw new Error("Original root identity changed during preparation");
    }
    await assertRootAuthority(root);
    checkScanCancellation(scanOptions);
  } catch (error: unknown) {
    let cleanup: DiscardResult;
    try { cleanup = await diagnosticStage(diagnostics, "preparation.cleanup", () => discardRoot(root)); }
    finally { preparationSpan?.end("failed"); diagnostics?.checkpoint("preparation.cleanup"); }
    throw new Error(`Twin copy failed; cleanup=${JSON.stringify(cleanup)}; allocation=${root.path}`, { cause: error });
  }
  preparationSpan?.end("complete");
  const before = preparationFiles;
  const beforeGit: GitSnapshot = captureBefore[0].status === "fulfilled" ? captureBefore[0].value : unavailableGit("git-incomplete");
  let beforeWatch: WatchCapture[] = captureBefore[1].status === "fulfilled" ? captureBefore[1].value : unavailableWatches("observation-failed");
  let settledManifest: ManifestSnapshot | undefined;
  const beforeDependencies: DependencySnapshot = captureBefore[2].status === "fulfilled" ? captureBefore[2].value : unavailableDependencies("observation-failed");
  return Object.freeze({
    workspacePath: root.workspace,
    inspect: (): TwinInspection => Object.freeze(receipt
      ? { workspacePath: root.workspace, state, receipt }
      : { workspacePath: root.workspace, state }),
    run: async (options: RunOptions): Promise<RunResult> => {
      if (state !== "ready") throw new Error(`Cannot run Twin in state ${state}`);
      state = "running"; // Lock before getters, iterators, validation or awaits.
      const runSpan = diagnostics?.start("execution.run");
      try {
      let command: RunOptions;
      try {
        checkScanCancellation(scanOptions);
        command = validateRunOptions(options);
        await assertRootAuthority(root);
        if (command.interruptSignal?.aborted) throw new Error("Interrupted before command launch");
      }
      catch (error: unknown) { state = "ready"; runSpan?.end("failed"); throw error; }
      lifecycleIssue = null;
      const globalSelection = selectGlobalNpmRoot(command.env, command.argv, protectedRoots);
      const beforeGlobal = globalSelection.root
        ? await diagnosticStage(diagnostics, "execution.global-before", () => captureGlobalNpm(globalSelection.root!)).catch(() => unavailableGlobalNpm("observation-failed"))
        : unavailableGlobalNpm(globalSelection.reason ?? "prefix-unavailable");
      try {
        checkScanCancellation(scanOptions);
        if (command.interruptSignal?.aborted) throw new Error("Interrupted before command launch");
      }
      catch (error: unknown) { state = "ready"; runSpan?.end("failed"); throw error; }
      let result: RunResult | undefined;
      let processReceipt: ProcessReceipt = unavailableProcessReceipt(false);
      let failure: unknown;
      let didThrow = false;
      try {
        childSettled = false;
        result = await diagnosticStage(diagnostics, "execution.command", () => runCommand(root.workspace, command, () => {
          childSettled = true;
          if (state === "child-unsettled") state = "finished";
        }, observation => { processReceipt = observation; }));
      } catch (error: unknown) {
        failure = error;
        didThrow = true;
      }
      state = childSettled ? "finished" : "child-unsettled";
      lifecycleIssue = result?.lifecycleIssue ?? null;
      const captureAfter = childSettled ? await Promise.allSettled([
        captureManifestViews(root.workspace, { ...scanOptions, diagnosticStage: "after.inventory", diagnosticRole: "copy" }),
        diagnosticStage(diagnostics, "after.git", () => captureGitCategories(root.workspace, protectedRoots)),
        diagnosticStage(diagnostics, "after.watch", () => captureWatches(home, protectedRoots)),
        diagnosticStage(diagnostics, "after.dependencies", captureProjectDependencies),
      ]) : null;
      const after: ManifestSnapshot = captureAfter?.[0].status === "fulfilled"
        ? captureAfter[0].value.receipt : unavailableManifest(childSettled ? "scan-unavailable" : "child-unsettled");
      settledManifest = captureAfter?.[0].status === "fulfilled" ? captureAfter[0].value.apply
        : unavailableManifest(childSettled ? "scan-unavailable" : "child-unsettled");
      const afterGit: GitSnapshot = captureAfter?.[1].status === "fulfilled"
        ? captureAfter[1].value : unavailableGit("git-incomplete");
      const afterWatch: WatchCapture[] = captureAfter?.[2].status === "fulfilled"
        ? captureAfter[2].value : unavailableWatches(childSettled ? "observation-failed" : "child-unsettled");
      const afterDependencies: DependencySnapshot = captureAfter?.[3].status === "fulfilled"
        ? captureAfter[3].value : unavailableDependencies(childSettled ? "observation-failed" : "child-unsettled");
      const afterGlobal = childSettled && globalSelection.root
        ? await assertRootAuthority(root).then(() => diagnosticStage(diagnostics, "after.global", () => captureGlobalNpm(globalSelection.root!))).catch(() => unavailableGlobalNpm("observation-failed"))
        : unavailableGlobalNpm(childSettled ? globalSelection.reason ?? "prefix-unavailable" : "child-unsettled");
      const commandReceipt = buildCommandReceipt(command, result);
      try {
        receipt = buildReceipt(before, after, beforeGit, afterGit, beforeWatch, afterWatch, beforeDependencies, afterDependencies,
          globalSelection, beforeGlobal, afterGlobal, commandReceipt, processReceipt);
      } catch {
        receipt = buildReceipt(
          unavailableManifest("receipt-unavailable"), unavailableManifest("receipt-unavailable"),
          unavailableGit("git-incomplete"), unavailableGit("git-incomplete"),
          unavailableWatches("receipt-unavailable"), unavailableWatches("receipt-unavailable"),
          unavailableDependencies("receipt-unavailable"), unavailableDependencies("receipt-unavailable"),
          { reason: "receipt-unavailable" }, unavailableGlobalNpm("receipt-unavailable"), unavailableGlobalNpm("receipt-unavailable"),
          commandReceipt, processReceipt,
        );
      } finally {
        beforeWatch = unavailableWatches("consumed");
      }
      runSpan?.end(didThrow ? "failed" : "complete");
      if (didThrow) throw failure;
      return result!;
      } finally { runSpan?.end("failed"); diagnostics?.checkpoint("execution.run"); }
    },
    apply: async (): Promise<ApplyResult> => {
      if (state !== "finished" || !childSettled || lifecycleIssue || !receipt || !settledManifest
          || receipt.command.disposition === "settlement-uncertain" || receipt.command.disposition === "observation-unavailable"
          || receipt.process.finalGroup === "present" || receipt.process.finalGroup === "unknown"
          || receipt.process.directChild.settlement === "unconfirmed" || receipt.process.directChild.settlement === "unknown") {
        diagnostics?.guard("apply", [["original-baseline", originalBefore], ["copy-baseline", copyBefore], ["settled-copy", settledManifest], ["fresh-copy", undefined], ["fresh-original", undefined]]);
        return { status: "refused", paths: [], reason: "Command settlement or session state uncertain" };
      }
      state = "applying";
      try { return await diagnosticStage(diagnostics, "apply", () => applyCopy(root, sourceIdentity, originalBefore, copyBefore, settledManifest!, links, scanOptions), "both"); }
      finally { diagnostics?.checkpoint("apply"); state = "finished"; }
    },
    applyAffected: async (): Promise<AffectedApplyResult> => {
      if (state !== "finished" || !childSettled || lifecycleIssue || !receipt || !settledManifest
          || receipt.command.disposition === "settlement-uncertain" || receipt.command.disposition === "observation-unavailable"
          || receipt.process.finalGroup === "present" || receipt.process.finalGroup === "unknown"
          || receipt.process.directChild.settlement === "unconfirmed" || receipt.process.directChild.settlement === "unknown") {
        diagnostics?.guard("apply.affected", [["original-baseline", originalBefore], ["copy-baseline", copyBefore], ["settled-copy", settledManifest], ["fresh-copy", undefined], ["fresh-original", undefined]]);
        return affectedAdmissionRefusal();
      }
      state = "applying";
      try { return await diagnosticStage(diagnostics, "apply.affected", () => applyAffectedCopy(root, sourceIdentity, originalBefore, copyBefore, settledManifest!, links, scanOptions), "both"); }
      finally { diagnostics?.checkpoint("apply.affected"); state = "finished"; }
    },
    discard: async (): Promise<DiscardResult> => {
      if (state === "discarded") return { status: "already-removed" };
      if (state === "running" || state === "applying" || state === "discarding") throw new Error(`Cannot discard Twin in state ${state}`);
      if (!childSettled || state === "discard-failed") return { status: "refused", reason: lifecycleIssue ?? `Cannot discard Twin in state ${state}` };
      const previous = state;
      state = "discarding";
      const result = await diagnosticStage(diagnostics, "discard", () => discardRoot(root));
      diagnostics?.checkpoint("discard");
      state = result.status === "removed" ? "discarded" : result.status === "failed" ? "discard-failed" : previous;
      return result;
    },
  });
}
