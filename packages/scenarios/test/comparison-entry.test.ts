import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runComparisonEntry } from "../src/comparison-entry.js";
import { ComparisonAttemptFailure, ComparisonPrerequisiteFailure, digestActionBytes, digestBuildTree,
  digestRegularFile, finishPrerequisiteRoot, prerequisiteProbeState } from "../src/comparison-runner.js";
import { ComparisonArtifactSchema, ComparisonExecutionMetadataSchema, ComparisonResultSchema,
  IncompleteComparisonSchema, renderComparison, renderComparisonArtifact,
  type ComparisonExecutionMetadata } from "../src/comparison-result.js";

const historical = fileURLToPath(new URL("../../../docs/phase-2-comparison.json", import.meta.url));
const retained = fileURLToPath(new URL("../../../docs/phase-6-results-2297bf07/comparison.json", import.meta.url));
async function fixture() { return ComparisonResultSchema.parse(JSON.parse(await fs.readFile(historical, "utf8") as string) as unknown); }
const digest = "a".repeat(64);
function metadata(): ComparisonExecutionMetadata {
  return ComparisonExecutionMetadataSchema.parse({ metadataVersion: 1,
    source: { commit: "b".repeat(40), workingTree: "dirty", statusSha256: digest },
    versions: { node: "v24.21.0", git: "git version 2.39.5", agenttx: "0.3.0" },
    executables: { nodeSha256: digest, gitSha256: digest, agenttxEntrySha256: digest, npmEntrySha256: digest },
    builds: { core: { sha256: digest, fileCount: 1 }, scenarios: { sha256: digest, fileCount: 2 },
      agenttx: { sha256: digest, fileCount: 3 } },
    actions: Array.from({ length: 13 }, (_, index) => { const scenarioId = `S${index + 1}`;
      return { scenarioId, kind: ["S4", "S6", "S10"].includes(scenarioId) ? "command" : "script", sha256: digest }; }),
    s11WorkerSha256: digest });
}
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
    const result = ComparisonResultSchema.parse({ ...await fixture(), executionMetadata: metadata() });
    const directory = join(root, "complete");
    const code = await runComparisonEntry(["--output-dir", directory], async onRow => {
      for (const row of result.rows) onRow?.(row);
      return result;
    });
    expect(code).toBe(0);
    const parsed = ComparisonArtifactSchema.parse(JSON.parse(await fs.readFile(join(directory, "comparison.json"), "utf8") as string) as unknown);
    assert(!("status" in parsed));
    expect(parsed.rows).toHaveLength(39);
    expect(parsed.executionMetadata).toEqual(metadata());
    expect(await fs.readFile(join(directory, "comparison.md"), "utf8")).toBe(renderComparisonArtifact(parsed));
  }));

  it("accepts historical result without execution metadata and preserves its Markdown", async () => {
    const result = await fixture();
    expect(result.executionMetadata).toBeUndefined();
    expect(renderComparison(result)).toBe(await fs.readFile(fileURLToPath(new URL("../../../docs/phase-2-comparison.md", import.meta.url)), "utf8"));
  });

  it("reopens the retained fresh pair with exact Markdown and redacted metadata", async () => {
    const bytes = await fs.readFile(retained, "utf8");
    const result = ComparisonArtifactSchema.parse(JSON.parse(bytes) as unknown);
    assert(!("status" in result));
    expect(result.executionMetadata?.source.commit).toBe("2297bf07e523045079130c2c505f2172fb458307");
    expect(result.executionMetadata?.actions).toHaveLength(13);
    expect(bytes).not.toMatch(/\/tmp\/|\/home\/|SECRET=|AGENTTX_HOME=|TWIN_S11_TOKEN=/);
    expect(await fs.readFile(retained.replace(/\.json$/, ".md"), "utf8")).toBe(renderComparisonArtifact(result));
  });

  it("validates versioned metadata and fixed action order", () => {
    const valid = metadata();
    expect(ComparisonExecutionMetadataSchema.safeParse(valid).success).toBe(true);
    expect(ComparisonExecutionMetadataSchema.safeParse({ ...valid, metadataVersion: 2 }).success).toBe(false);
    expect(ComparisonExecutionMetadataSchema.safeParse({ ...valid,
      source: { ...valid.source, commit: "short" } }).success).toBe(false);
    expect(ComparisonExecutionMetadataSchema.safeParse({ ...valid,
      executables: { ...valid.executables, nodeSha256: "wrong" } }).success).toBe(false);
    expect(ComparisonExecutionMetadataSchema.safeParse({ ...valid,
      actions: [valid.actions[1], valid.actions[0], ...valid.actions.slice(2)] }).success).toBe(false);
  });

  it("changes executable, build, and action digests when their bytes change", async () => owned(async root => {
    const executable = join(root, "executable");
    await fs.writeFile(executable, "version one");
    const firstExecutable = await digestRegularFile(executable);
    await fs.writeFile(executable, "version two");
    expect(await digestRegularFile(executable)).not.toBe(firstExecutable);
    const build = join(root, "build");
    await fs.mkdir(build);
    await fs.writeFile(join(build, "module.js"), "export const value = 1;\n");
    const firstBuild = await digestBuildTree(build);
    await fs.writeFile(join(build, "module.js"), "export const value = 2;\n");
    expect((await digestBuildTree(build)).sha256).not.toBe(firstBuild.sha256);
    expect(digestActionBytes(Buffer.from("first action"))).not.toBe(digestActionBytes(Buffer.from("changed action")));
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
