import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { OwnedScenarioRoot } from "../dist/fixture.js";
import type { Snapshot } from "../dist/types.js";
import { assertNoScenarioRootLeak, scenarioRoots, withPreservedCleanup } from "./support/harness.js";

describe("non-atomic cleanup evidence", () => {
  it("preserves the deletion error and reports possible partial removal before guarded final cleanup", async () => {
    const baseline = await scenarioRoots();
    const injected = new Error("injected second-file unlink failure");
    let target: string | null = null;
    let inject = true;
    let root: OwnedScenarioRoot | null = null;
    let fixture: typeof import("../dist/fixture.js") | null = null;
    const knownRoots: string[] = [];

    vi.doMock("node:fs/promises", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:fs/promises")>();
      return {
        ...actual,
        unlink: async (path: string): Promise<void> => {
          if (inject && path === target) throw injected;
          await actual.unlink(path);
        },
      };
    });
    await withPreservedCleanup(async () => {
      // This exact module instance owns the WeakMap registration for both cleanup calls.
      fixture = await import("../dist/fixture.js");
      root = await fixture.createScenarioRoot();
      knownRoots.push(root.scenarioRoot);
      await fixture.initializeScenarioRoot(root);
      const workspace = join(root.scenarioRoot, "workspace");
      await writeFile(join(workspace, "one.txt"), "first\n", { flag: "wx" });
      target = join(workspace, "two.txt");
      await writeFile(target, "second\n", { flag: "wx" });
      const after: Snapshot = { workspace, observedAt: new Date().toISOString(), complete: true, paths: [] };
      const result = await fixture.cleanupScenarioRoot(root, after);
      expect(result).toMatchObject({ status: "failed", scenarioRoot: root.scenarioRoot,
        reason: injected.message, partialDeletionPossible: true,
        rootAfter: { exists: true }, markerAfter: { exists: true } });
      expect(result.status === "failed" && result.reason).toBe(injected.message);

    }, [async () => {
      inject = false;
      vi.doUnmock("node:fs/promises");
    }, async () => {
      if (root !== null && fixture !== null) {
        const after: Snapshot = { workspace: join(root.scenarioRoot, "workspace"),
          observedAt: new Date().toISOString(), complete: true, paths: [] };
        const final = await fixture.cleanupScenarioRoot(root, after);
        if (final.status !== "removed") {
          throw new Error(`Test-owned root retained at ${root.scenarioRoot}: ${JSON.stringify(final)}`);
        }
        root = null;
      }
    }, () => assertNoScenarioRootLeak(baseline)], knownRoots);
  });
});
