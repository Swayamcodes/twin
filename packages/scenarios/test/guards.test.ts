import { rename, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cleanupScenarioRoot, createScenarioRoot, executeCommand,
  initializeScenarioRoot, verifyWorkspace } from "../dist/fixture.js";
import type { OwnedScenarioRoot } from "../dist/fixture.js";
import type { Snapshot } from "../dist/types.js";
import { assertNoScenarioRootLeak, createTestRoot, removeTestRoot, scenarioRoots,
  withPreservedCleanup } from "./support/harness.js";

function complete(root: OwnedScenarioRoot): Snapshot {
  return { workspace: join(root.scenarioRoot, "workspace"), observedAt: new Date().toISOString(),
    complete: true, paths: [] };
}

async function finish(root: OwnedScenarioRoot): Promise<void> {
  const outcome = await cleanupScenarioRoot(root, complete(root));
  if (outcome.status !== "removed") {
    throw new Error(`Test-owned scenario root retained at ${root.scenarioRoot}: ${JSON.stringify(outcome)}`);
  }
}

describe("root and marker integrity guards", () => {
  it("refuses an unregistered fabricated root for execution and cleanup", async () => {
    const before = await scenarioRoots();
    const outer = await createTestRoot();
    await withPreservedCleanup(async () => {
      const fake = { scenarioRoot: join(outer.path, "fabricated") } as OwnedScenarioRoot;
      await expect(executeCommand(fake, "top-level")).rejects.toThrow("Unregistered scenario root");
      expect(await cleanupScenarioRoot(fake, complete(fake))).toMatchObject({ status: "refused", scenarioRoot: fake.scenarioRoot });
    }, [() => removeTestRoot(outer), () => assertNoScenarioRootLeak(before)], [outer.path]);
  });

  it.each(["incorrect", "missing"] as const)("refuses an %s marker without deletion", async (mode) => {
    const before = await scenarioRoots();
    const root = await createScenarioRoot();
    const marker = join(root.scenarioRoot, ".twin-scenario-root");
    let original: string | null = null;
    await withPreservedCleanup(async () => {
      await initializeScenarioRoot(root);
      original = await (await import("node:fs/promises")).readFile(marker, "utf8");
      if (mode === "incorrect") await writeFile(marker, "wrong marker\n");
      else await unlink(marker);
      await expect(verifyWorkspace(root)).rejects.toThrow();
      await expect(executeCommand(root, "top-level")).rejects.toThrow();
      expect(await cleanupScenarioRoot(root, complete(root))).toMatchObject({ status: "refused", scenarioRoot: root.scenarioRoot });
    }, [async () => { if (original !== null) await writeFile(marker, original); },
      () => finish(root), () => assertNoScenarioRootLeak(before)], [root.scenarioRoot]);
  });

  it("rejects a substituted workspace symlink", async () => {
    const before = await scenarioRoots();
    const root = await createScenarioRoot();
    const workspace = join(root.scenarioRoot, "workspace");
    const moved = join(root.scenarioRoot, "workspace-original");
    let movedWorkspace = false;
    let linkedWorkspace = false;
    await withPreservedCleanup(async () => {
      await initializeScenarioRoot(root);
      await rename(workspace, moved);
      movedWorkspace = true;
      await symlink(moved, workspace, "dir");
      linkedWorkspace = true;
      await expect(verifyWorkspace(root)).rejects.toThrow();
      await expect(executeCommand(root, "top-level")).rejects.toThrow();
      expect(await cleanupScenarioRoot(root, complete(root))).toMatchObject({ status: "refused", scenarioRoot: root.scenarioRoot });
    }, [async () => { if (linkedWorkspace) { await unlink(workspace); linkedWorkspace = false; } },
      async () => { if (movedWorkspace && !linkedWorkspace) await rename(moved, workspace); },
      () => finish(root), () => assertNoScenarioRootLeak(before)], [root.scenarioRoot]);
  });

  it("refuses cleanup after an incomplete after-observation", async () => {
    const before = await scenarioRoots();
    const root = await createScenarioRoot();
    await withPreservedCleanup(async () => {
      await initializeScenarioRoot(root);
      const incomplete: Snapshot = { ...complete(root), complete: false,
        paths: [{ path: "notes.txt", state: "error", error: "injected observation error" }] };
      expect(await cleanupScenarioRoot(root, incomplete)).toMatchObject({ status: "refused", scenarioRoot: root.scenarioRoot });
      await expect(verifyWorkspace(root)).resolves.toMatchObject({ workspace: join(root.scenarioRoot, "workspace") });
    }, [() => finish(root), () => assertNoScenarioRootLeak(before)], [root.scenarioRoot]);
  });
});
