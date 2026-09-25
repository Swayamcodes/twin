import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { fixtureContents } from "../dist/scenarios.js";
import type { ObservedPath, PathObservation, ScenarioRunResult, Snapshot } from "../dist/types.js";
import { assertNoScenarioRootLeak, changedFingerprintPaths, createTestRoot,
  removeTestRoot, repositoryFingerprint, repositoryRoot, runNode, scenarioEntry,
  scenarioRoots, spawnGuard, withPreservedCleanup } from "./support/harness.js";

function observation(snapshot: Snapshot, path: ObservedPath): PathObservation {
  const found = snapshot.paths.find((item) => item.path === path);
  if (!found) throw new Error(`Missing observation for ${path}`);
  return found;
}

function assertOriginalBytes(snapshot: Snapshot, paths: readonly (keyof typeof fixtureContents)[]): void {
  for (const path of paths) {
    const bytes = Buffer.from(fixtureContents[path]);
    expect(observation(snapshot, path)).toEqual({ path, state: "file", sizeBytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex") });
  }
}

async function assertRemoved(path: string): Promise<void> {
  await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
}

async function execute(id: "S12" | "S6"): Promise<ScenarioRunResult> {
  const baseline = await scenarioRoots();
  const outer = await createTestRoot();
  const knownRoots = [outer.path];
  return await withPreservedCleanup(async () => {
    const result = await runNode(outer, ["--require", spawnGuard, scenarioEntry, id]);
    expect(result.error).toBeNull();
    expect(result.signal).toBeNull();
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    const evidence = JSON.parse(result.stdout) as ScenarioRunResult;
    knownRoots.push(evidence.scenarioRoot);
    expect(evidence.scenarioId).toBe(id);
    const parent = await realpath(tmpdir());
    expect(dirname(evidence.scenarioRoot)).toBe(parent);
    expect(evidence.scenarioRoot.startsWith(join(parent, "twin-scenario-"))).toBe(true);
    expect(evidence.workspace).toBe(join(evidence.scenarioRoot, "workspace"));
    expect(evidence.action?.cwd).toBe(evidence.workspace);
    expect(evidence.action?.cwd).not.toBe(repositoryRoot);
    expect(evidence.setupCommands.length).toBeGreaterThan(0);
    expect(evidence.setupCommands.every((command) => command.cwd === evidence.workspace)).toBe(true);
    expect(evidence.before?.complete).toBe(true);
    expect(evidence.after?.complete).toBe(true);
    expect(evidence.cleanup).toEqual({ status: "removed", scenarioRoot: evidence.scenarioRoot });
    expect(evidence.issues).toEqual([]);
    await assertRemoved(evidence.scenarioRoot);
    return evidence;
  }, [() => removeTestRoot(outer), () => assertNoScenarioRootLeak(baseline)], knownRoots);
}

describe("manually verified scenario behavior", () => {
  it("rejects a valid scenario ID followed by an extra argument before allocation", async () => {
    const baseline = await scenarioRoots();
    const outer = await createTestRoot();
    await withPreservedCleanup(async () => {
      const result = await runNode(outer, ["--require", spawnGuard, scenarioEntry, "S12", "extra"]);
      expect(result.code).toBe(2);
      expect(result.signal).toBeNull();
      expect(result.error).toBeNull();
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("Usage:");
    }, [() => removeTestRoot(outer), () => assertNoScenarioRootLeak(baseline)], [outer.path]);
  });

  it("S12 creates only the control file in its disposable workspace and removes the root", async () => {
    const evidence = await execute("S12");
    const before = evidence.before;
    const after = evidence.after;
    if (!before || !after || !evidence.action) throw new Error("Incomplete S12 evidence");
    const originals = Object.keys(fixtureContents) as (keyof typeof fixtureContents)[];
    assertOriginalBytes(before, originals);
    assertOriginalBytes(after, originals);
    expect(observation(before, "control-created.txt")).toEqual({ path: "control-created.txt", state: "absent" });
    const bytes = Buffer.from("S12 control file.\n");
    expect(observation(after, "control-created.txt")).toEqual({ path: "control-created.txt", state: "file",
      sizeBytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
    expect(evidence.action.command.executable).toBe(process.execPath);
    expect(evidence.action.command.args).toEqual([join(dirname(scenarioEntry), "actions", "create-file.js")]);
    expect(evidence.action.exitCode).toBe(0);
    expect(evidence.action.signal).toBeNull();
    expect(evidence.action.spawnError).toBeNull();
    expect(evidence.action.streamErrors).toEqual([]);
  }, 120_000);

  it("S6 removes only disposable untracked and ignored files with independent observations", async () => {
    const repositoryBefore = await repositoryFingerprint();
    await withPreservedCleanup(async () => {
      const evidence = await execute("S6");
      const before = evidence.before;
      const after = evidence.after;
      if (!before || !after || !evidence.action) throw new Error("Incomplete S6 evidence");
      expect(evidence.action.command).toEqual({ executable: "git", args: ["clean", "-fdx"] });
      expect(evidence.action.cwd).toBe(evidence.workspace);
      expect(evidence.action.cwd).not.toBe(repositoryRoot);
      expect(evidence.action.exitCode).toBe(0);
      expect(evidence.action.signal).toBeNull();
      expect(evidence.action.spawnError).toBeNull();
      expect(evidence.action.streamErrors).toEqual([]);
      // The assertions below use hashes and presence, never Git's human-readable stdout.
      const tracked = ["notes.txt", "app.js", ".gitignore"] as const;
      assertOriginalBytes(before, tracked);
      assertOriginalBytes(after, tracked);
      const removed = ["scratch.txt", ".env", "node_modules/lib.txt"] as const;
      assertOriginalBytes(before, removed);
      for (const path of removed) expect(observation(after, path)).toEqual({ path, state: "absent" });
      expect(observation(before, "control-created.txt")).toEqual({ path: "control-created.txt", state: "absent" });
      expect(observation(after, "control-created.txt")).toEqual({ path: "control-created.txt", state: "absent" });
    }, [async () => {
      const repositoryAfter = await repositoryFingerprint();
      const changed = changedFingerprintPaths(repositoryBefore, repositoryAfter);
      if (changed.length) throw new Error(`Real repository changed; no repair attempted: ${changed.join(", ")}`);
    }], [repositoryRoot]);
  }, 180_000);
});
