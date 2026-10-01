import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runComparisonEntry } from "../src/comparison-entry.js";
import { ComparisonAttemptFailure, ComparisonPrerequisiteFailure, finishPrerequisiteRoot,
  prerequisiteProbeState } from "../src/comparison-runner.js";
import { ComparisonArtifactSchema, ComparisonResultSchema, IncompleteComparisonSchema,
  renderComparisonArtifact } from "../src/comparison-result.js";

const historical = fileURLToPath(new URL("../../../docs/phase-2-comparison.json", import.meta.url));
async function fixture() { return ComparisonResultSchema.parse(JSON.parse(await fs.readFile(historical, "utf8") as string) as unknown); }
async function owned<T>(work: (root: string) => Promise<T>): Promise<T> {
  const root = await fs.mkdtemp(join(await fs.realpath(tmpdir()), "twin-comparison-entry-test-"));
  try { return await work(root); }
  finally { await fs.rm(root, { recursive: true }); }
}

describe("fixed comparison entry", () => {
  it("refuses missing, relative, and existing output directories before running", async () => owned(async root => {
    let called = false;
    const run: typeof import("../src/comparison-runner.js").produceComparison = async () => { called = true; return await fixture(); };
    await expect(runComparisonEntry([], run)).rejects.toThrow("Usage");
    await expect(runComparisonEntry(["--output-dir", "relative"], run)).rejects.toThrow("Usage");
    await expect(runComparisonEntry(["--output-dir", root], run)).rejects.toThrow();
    expect(called).toBe(false);
    expect(await fs.readdir(root)).toEqual([]);
  }));

  it("publishes a complete result and reopens exact deterministic Markdown", async () => owned(async root => {
    const result = await fixture();
    const directory = join(root, "complete");
    const code = await runComparisonEntry(["--output-dir", directory], async onRow => {
      for (const row of result.rows) onRow?.(row);
      return result;
    });
    expect(code).toBe(0);
    const parsed = ComparisonArtifactSchema.parse(JSON.parse(await fs.readFile(join(directory, "comparison.json"), "utf8") as string) as unknown);
    assert(!("status" in parsed));
    expect(parsed.rows).toHaveLength(39);
    expect(await fs.readFile(join(directory, "comparison.md"), "utf8")).toBe(renderComparisonArtifact(parsed));
  }));

  it("records prerequisite refusal without claiming an attempt", async () => owned(async root => {
    const directory = join(root, "prerequisite");
    const code = await runComparisonEntry(["--output-dir", directory], async () => { throw new Error("unavailable"); });
    expect(code).toBe(1);
    const parsed = ComparisonArtifactSchema.parse(JSON.parse(await fs.readFile(join(directory, "comparison.json"), "utf8") as string) as unknown);
    assert("status" in parsed);
    expect(parsed).toMatchObject({ status: "incomplete", reason: "prerequisite-failed", completedRows: [], failedAttempt: null });
    expect(await fs.readFile(join(directory, "comparison.md"), "utf8")).toBe(renderComparisonArtifact(parsed));
  }));

  it("identifies an AgentTX mismatch before launching an action", async () => owned(async root => {
    const directory = join(root, "mismatch");
    const code = await runComparisonEntry(["--output-dir", directory], async () => {
      throw new ComparisonPrerequisiteFailure("agenttx-version-mismatch");
    });
    expect(code).toBe(1);
    const parsed = ComparisonArtifactSchema.parse(JSON.parse(await fs.readFile(join(directory, "comparison.json"), "utf8") as string) as unknown);
    assert("status" in parsed);
    expect(parsed).toMatchObject({ reason: "prerequisite-failed", prerequisiteCode: "agenttx-version-mismatch",
      completedRows: [], failedAttempt: null });
  }));

  it("refuses prerequisite cleanup when launched probes have uncertain settlement", async () => owned(async root => {
    let cleanupCalled = false;
    const probeState = prerequisiteProbeState([{ code: null, signal: null, stdout: "", stderr: "",
      timedOut: true, error: null }]);
    expect(probeState).toBe("uncertain");
    await expect(finishPrerequisiteRoot(probeState, async () => { cleanupCalled = true; }))
      .rejects.toMatchObject({ code: "probe-settlement-uncertain" });
    expect(cleanupCalled).toBe(false);
    const directory = join(root, "uncertain-prerequisite");
    const code = await runComparisonEntry(["--output-dir", directory], async (_onRow, _onReady, accounting) => {
      assert(accounting);
      accounting.allocated = 1;
      await finishPrerequisiteRoot(probeState, async () => { cleanupCalled = true; accounting.removed++; });
      throw new Error("unreachable");
    });
    expect(code).toBe(1);
    expect(cleanupCalled).toBe(false);
    const parsed = ComparisonArtifactSchema.parse(JSON.parse(await fs.readFile(join(directory, "comparison.json"), "utf8") as string) as unknown);
    assert("status" in parsed);
    expect(parsed).toMatchObject({ reason: "prerequisite-failed", prerequisiteCode: "probe-settlement-uncertain",
      rootDisposition: "retained", rootAccounting: { allocated: 1, removed: 0, retained: 1 }, completedRows: [] });
  }));

  it("keeps completed rows and a closed failure stage after an interrupted attempt", async () => owned(async root => {
    const result = await fixture();
    const directory = join(root, "interrupted");
    const code = await runComparisonEntry(["--output-dir", directory], async (onRow, onReady, accounting) => {
      assert(accounting);
      onReady?.();
      onRow?.(result.rows[0]!);
      accounting.allocated = 3;
      accounting.removed = 2;
      throw new ComparisonAttemptFailure("settlement", "retained");
    });
    expect(code).toBe(1);
    const parsed = ComparisonArtifactSchema.parse(JSON.parse(await fs.readFile(join(directory, "comparison.json"), "utf8") as string) as unknown);
    assert("status" in parsed);
    expect(parsed).toMatchObject({ status: "incomplete", reason: "attempt-failed", failureStage: "settlement",
      rootDisposition: "retained", failedAttempt: { scenarioId: "S1", tool: "agenttx" } });
    expect(parsed.completedRows).toHaveLength(1);
    expect(await fs.readFile(join(directory, "comparison.md"), "utf8")).toBe(renderComparisonArtifact(parsed));
  }));

  it("rejects duplicate or out-of-order completed rows and the wrong next pair", async () => {
    const result = await fixture();
    const base = { schemaVersion: 1, comparisonVersion: 1, status: "incomplete", reason: "attempt-failed",
      failureStage: "observation", prerequisiteCode: null, rootDisposition: "removed",
      rootAccounting: { allocated: 4, removed: 4, retained: 0 },
      completedRows: result.rows.slice(0, 2), failedAttempt: { scenarioId: "S1", tool: "plain-git" } };
    expect(IncompleteComparisonSchema.safeParse(base).success).toBe(true);
    expect(IncompleteComparisonSchema.safeParse({ ...base, completedRows: [result.rows[0]!, result.rows[0]!] }).success).toBe(false);
    expect(IncompleteComparisonSchema.safeParse({ ...base, completedRows: [result.rows[1]!, result.rows[0]!] }).success).toBe(false);
    expect(IncompleteComparisonSchema.safeParse({ ...base,
      failedAttempt: { scenarioId: "S2", tool: "twin" } }).success).toBe(false);
  });

  it("rejects a retained-root claim when accounting has no retained allocation", async () => {
    const base = { schemaVersion: 1, comparisonVersion: 1, status: "incomplete", reason: "attempt-failed",
      failureStage: "settlement", prerequisiteCode: null, rootDisposition: "retained",
      rootAccounting: { allocated: 2, removed: 2, retained: 0 },
      completedRows: [], failedAttempt: { scenarioId: "S1", tool: "twin" } };
    expect(IncompleteComparisonSchema.safeParse(base).success).toBe(false);
    expect(IncompleteComparisonSchema.safeParse({ ...base, rootDisposition: "removed" }).success).toBe(true);
  });
});
