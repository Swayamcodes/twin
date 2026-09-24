import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  cleanupScenarioRoot, createdWorkspace, createScenarioRoot, errorMessage,
  executeCommand, initializeFixture, initializeScenarioRoot, verifyWorkspace,
} from "./fixture.js";
import type { OwnedScenarioRoot } from "./fixture.js";
import { fixtureContents, getScenario } from "./scenarios.js";
import type { CommandEvidence, ObservedPath, PathObservation, RunIssue, ScenarioId, ScenarioRunResult, Snapshot } from "./types.js";

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function observePaths(root: OwnedScenarioRoot, paths: readonly ObservedPath[]): Promise<Snapshot> {
  let workspace: string | null = null;
  try {
    workspace = createdWorkspace(root);
    workspace = (await verifyWorkspace(root)).workspace;
  } catch (error: unknown) {
    // A failed workspace guard makes every path unsafe to inspect, not absent.
    return {
      workspace, observedAt: new Date().toISOString(), complete: false,
      paths: paths.map((path) => ({ path, state: "error", error: errorMessage(error) })),
    };
  }
  const observations: PathObservation[] = [];
  for (const path of paths) {
    try {
      // Check intermediate components too: lstat(file) alone follows parent links.
      const components = path.split("/");
      let current = workspace;
      for (const component of components.slice(0, -1)) {
        current = join(current, component);
        const stat = await lstat(current);
        if (stat.isSymbolicLink() || !stat.isDirectory()) {
          throw new Error(`Unexpected observed parent type: ${current}`);
        }
      }
      const absolute = join(workspace, path);
      const stat = await lstat(absolute);
      if (stat.isSymbolicLink() || !stat.isFile()) {
        throw new Error(`Unexpected observed file type: ${absolute}`);
      }
      const bytes = await readFile(absolute);
      observations.push({ path, state: "file", sizeBytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex") });
    } catch (error: unknown) {
      observations.push(isMissing(error)
        ? { path, state: "absent" }
        : { path, state: "error", error: errorMessage(error) });
    }
  }
  return {
    workspace, observedAt: new Date().toISOString(), paths: observations,
    complete: observations.every((observation) => observation.state !== "error"),
  };
}

function verifyInitialContents(snapshot: Snapshot): void {
  if (!snapshot.complete) throw new Error("Before-state observation is incomplete; action skipped");
  for (const observation of snapshot.paths) {
    if (observation.path === "control-created.txt") {
      if (observation.state !== "absent") throw new Error("Control file already exists");
    } else {
      const contents = fixtureContents[observation.path];
      const expectedHash = createHash("sha256").update(contents).digest("hex");
      if (observation.state !== "file" || observation.sha256 !== expectedHash) {
        throw new Error(`Initial fixture content mismatch: ${observation.path}`);
      }
    }
  }
}

export async function runScenario(id: ScenarioId): Promise<ScenarioRunResult> {
  const scenario = getScenario(id);
  const setupCommands: CommandEvidence[] = [];
  const issues: RunIssue[] = [];
  let workspace: string | null = null;
  let before: Snapshot | null = null;
  let after: Snapshot | null = null;
  let action: CommandEvidence | null = null;
  let phase: RunIssue["phase"] = "setup";
  const root = await createScenarioRoot();
  // No filesystem operation after allocation escapes the lifecycle boundary.
  try {
    await initializeScenarioRoot(root);
    await initializeFixture(root, setupCommands);
    phase = "before";
    before = await observePaths(root, scenario.observedPaths);
    recordObservationIssues(before, "before", issues);
    verifyInitialContents(before);
    phase = "action";
    action = await executeCommand(root, scenario.actionId);
    if (action.spawnError !== null || action.signal !== null || action.exitCode !== 0) {
      issues.push({ phase, message: `Action did not exit normally with code 0: ${action.spawnError ?? action.signal ?? action.exitCode}` });
    }
    for (const failure of action.streamErrors) {
      issues.push({ phase, message: `${failure.stream}: ${failure.error}` });
    }
  } catch (error: unknown) {
    issues.push({ phase, message: errorMessage(error) });
  }
  // Always attempt observation after setup/action, including nonzero child exits.
  try {
    workspace = createdWorkspace(root);
    after = await observePaths(root, scenario.observedPaths);
    recordObservationIssues(after, "after", issues);
  } catch (error: unknown) {
    issues.push({ phase: "after", message: errorMessage(error) });
  }
  // Cleanup first rejects incomplete observations without touching the tree.
  const cleanup = await cleanupScenarioRoot(root, after);
  if (cleanup.status !== "removed") issues.push({ phase: "cleanup", message: cleanup.reason });
  return { schemaVersion: 1, scenarioId: id, scenarioRoot: root.scenarioRoot, workspace,
    setupCommands, action, before, after, cleanup, issues };
}

function recordObservationIssues(snapshot: Snapshot, phase: "before" | "after", issues: RunIssue[]): void {
  for (const observation of snapshot.paths) {
    if (observation.state === "error") {
      issues.push({ phase, message: `${observation.path}: ${observation.error}` });
    }
  }
}
