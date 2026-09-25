import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { assertNoScenarioRootLeak, assertNoTestRootLeak, createTestRoot, removeTestRoot, runNode,
  scenarioEntry, scenarioRoots, testRoots, withPreservedCleanup } from "./support/harness.js";

describe("scenario entry point without valid scenario arguments", () => {
  it("captures a child process stderr diagnostic", async () => {
    const before = await scenarioRoots();
    const outerBefore = await testRoots();
    const outer = await createTestRoot();
    await withPreservedCleanup(async () => {
      const result = await runNode(outer, ["-e", "require('node:fs').writeSync(2, 'capture probe\\n'); process.exitCode = 2"]);
      expect(result).toEqual({ code: 2, signal: null, stdout: "", stderr: "capture probe\n", error: null });
    }, [() => removeTestRoot(outer), () => assertNoScenarioRootLeak(before),
      () => assertNoTestRootLeak(outerBefore)], [outer.path]);
  });

  it("imports without output, failing exit code, or a scenario root", async () => {
    const before = await scenarioRoots();
    const outerBefore = await testRoots();
    const outer = await createTestRoot();
    await withPreservedCleanup(async () => {
      const statement = `await import(${JSON.stringify(pathToFileURL(scenarioEntry).href)})`;
      const result = await runNode(outer, ["--input-type=module", "-e", statement]);
      expect(result).toEqual({ code: 0, signal: null, stdout: "", stderr: "", error: null });
    }, [() => removeTestRoot(outer), () => assertNoScenarioRootLeak(before),
      () => assertNoTestRootLeak(outerBefore)], [outer.path]);
  });

  it.each([
    ["missing argument", []],
    ["unknown ID", ["UNKNOWN"]],
    ["unknown ID with extra argument", ["UNKNOWN", "extra"]],
    ["unknown ID with proposed cwd", ["UNKNOWN", "--cwd", "/tmp"]],
  ])("rejects %s before creating a fixture", async (_name, args) => {
    const before = await scenarioRoots();
    const outerBefore = await testRoots();
    const outer = await createTestRoot();
    await withPreservedCleanup(async () => {
      const result = await runNode(outer, [scenarioEntry, ...args]);
      expect(result.code).toBe(2);
      expect(result.signal).toBeNull();
      expect(result.error).toBeNull();
      expect(result.stdout).toBe("");
      expect(result.stderr, JSON.stringify(result)).toContain("Usage:");
      expect(result.stderr).not.toContain("scenarioRoot");
    }, [() => removeTestRoot(outer), () => assertNoScenarioRootLeak(before),
      () => assertNoTestRootLeak(outerBefore)], [outer.path]);
  });
});
