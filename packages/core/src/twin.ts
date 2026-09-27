import { copySource } from "./copy.js";
import { runCommand, validateRunOptions } from "./run.js";
import { allocateRoot, assertRootAuthority, discardRoot } from "./safety.js";

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
}
export interface TwinSession {
  readonly workspacePath: string;
  run(options: RunOptions): Promise<RunResult>;
  inspect(): TwinInspection;
  discard(): Promise<DiscardResult>;
}
export async function createTwin(options: CreateTwinOptions): Promise<TwinSession> {
  const root = await allocateRoot(options);
  try { await copySource(root); }
  catch (error: unknown) {
    const cleanup = await discardRoot(root);
    throw new Error(`Twin copy failed; cleanup=${JSON.stringify(cleanup)}; allocation=${root.path}`, { cause: error });
  }
  let state: TwinInspection["state"] = "ready";
  let childSettled = true;
  return Object.freeze({
    workspacePath: root.workspace,
    inspect: (): TwinInspection => Object.freeze({ workspacePath: root.workspace, state }),
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
      try {
        const result = await runCommand(root.workspace, command, () => {
          childSettled = true;
          if (state === "child-unsettled") state = "finished";
        });
        state = childSettled ? "finished" : "child-unsettled";
        return result;
      } catch (error: unknown) {
        state = childSettled ? "finished" : "child-unsettled";
        throw error;
      }
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
