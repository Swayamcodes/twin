/// <reference types="node" />

import { copySource } from "./copy.js";
import { runCommand, validateRunOptions } from "./run.js";
import { allocateRoot, assertRootAuthority, discardRoot } from "./safety.js";
import { captureManifest, unavailableManifest, type ManifestSnapshot } from "./manifest.js";
import { captureGitCategories, unavailableGit, type GitSnapshot } from "./git-classification.js";
import { captureWatches, unavailableWatches, type WatchCapture } from "./watch.js";
import { buildReceipt, type MinimalReceipt } from "./receipt.js";

export interface CreateTwinOptions {
  readonly sourceDirectory: string;
  readonly scratchParent: string;
}
export interface RunOptions {
  readonly executable: string;
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
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
}
export type DiscardResult =
  | { readonly status: "removed" | "already-removed" }
  | { readonly status: "refused"; readonly reason: string }
  | { readonly status: "failed"; readonly reason: string; readonly partialDeletionPossible: true };
export interface TwinInspection {
  readonly workspacePath: string;
  readonly state: "ready" | "running" | "finished" | "child-unsettled" | "discarding" | "discarded" | "discard-failed";
  readonly receipt?: MinimalReceipt;
}
export interface TwinSession {
  readonly workspacePath: string;
  run(options: RunOptions): Promise<RunResult>;
  inspect(): TwinInspection;
  discard(): Promise<DiscardResult>;
}
export async function createTwin(options: CreateTwinOptions): Promise<TwinSession> {
  const home = process.env.HOME;
  const root = await allocateRoot(options);
  try { await copySource(root); }
  catch (error: unknown) {
    const cleanup = await discardRoot(root);
    throw new Error(`Twin copy failed; cleanup=${JSON.stringify(cleanup)}; allocation=${root.path}`, { cause: error });
  }
  let state: TwinInspection["state"] = "ready";
  let childSettled = true;
  let receipt: MinimalReceipt | undefined;
  const protectedRoots = [options.sourceDirectory, root.path, root.workspace];
  const captureBefore = await Promise.allSettled([
    captureManifest(root.workspace),
    captureGitCategories(root.workspace, protectedRoots),
    captureWatches(home, protectedRoots),
  ]);
  const before: ManifestSnapshot = captureBefore[0].status === "fulfilled" ? captureBefore[0].value : unavailableManifest("scan-unavailable");
  const beforeGit: GitSnapshot = captureBefore[1].status === "fulfilled" ? captureBefore[1].value : unavailableGit("git-incomplete");
  let beforeWatch: WatchCapture[] = captureBefore[2].status === "fulfilled" ? captureBefore[2].value : unavailableWatches("observation-failed");
  return Object.freeze({
    workspacePath: root.workspace,
    inspect: (): TwinInspection => Object.freeze(receipt
      ? { workspacePath: root.workspace, state, receipt }
      : { workspacePath: root.workspace, state }),
    run: async (options: RunOptions): Promise<RunResult> => {
      if (state !== "ready") throw new Error(`Cannot run Twin in state ${state}`);
      state = "running"; // Lock before getters, iterators, validation or awaits.
      let command: RunOptions;
      try {
        command = validateRunOptions(options);
        await assertRootAuthority(root);
      }
      catch (error: unknown) { state = "ready"; throw error; }
      childSettled = false;
      let result: RunResult | undefined;
      let failure: unknown;
      let didThrow = false;
      try {
        result = await runCommand(root.workspace, command, () => {
          childSettled = true;
          if (state === "child-unsettled") state = "finished";
        });
      } catch (error: unknown) {
        failure = error;
        didThrow = true;
      }
      state = childSettled ? "finished" : "child-unsettled";
      const captureAfter = childSettled ? await Promise.allSettled([
        captureManifest(root.workspace),
        captureGitCategories(root.workspace, protectedRoots),
        captureWatches(home, protectedRoots),
      ]) : null;
      const after: ManifestSnapshot = captureAfter?.[0].status === "fulfilled"
        ? captureAfter[0].value : unavailableManifest(childSettled ? "scan-unavailable" : "child-unsettled");
      const afterGit: GitSnapshot = captureAfter?.[1].status === "fulfilled"
        ? captureAfter[1].value : unavailableGit("git-incomplete");
      const afterWatch: WatchCapture[] = captureAfter?.[2].status === "fulfilled"
        ? captureAfter[2].value : unavailableWatches(childSettled ? "observation-failed" : "child-unsettled");
      try {
        receipt = buildReceipt(before, after, beforeGit, afterGit, beforeWatch, afterWatch);
      } catch {
        receipt = buildReceipt(
          unavailableManifest("receipt-unavailable"), unavailableManifest("receipt-unavailable"),
          unavailableGit("git-incomplete"), unavailableGit("git-incomplete"),
          unavailableWatches("receipt-unavailable"), unavailableWatches("receipt-unavailable"),
        );
      } finally {
        beforeWatch = unavailableWatches("consumed");
      }
      if (didThrow) throw failure;
      return result!;
    },
    discard: async (): Promise<DiscardResult> => {
      if (state === "discarded") return { status: "already-removed" };
      if (state === "running" || state === "discarding") throw new Error(`Cannot discard Twin in state ${state}`);
      if (!childSettled || state === "discard-failed") return { status: "refused", reason: `Cannot discard Twin in state ${state}` };
      const previous = state;
      state = "discarding";
      const result = await discardRoot(root);
      state = result.status === "removed" ? "discarded" : result.status === "failed" ? "discard-failed" : previous;
      return result;
    },
  });
}
