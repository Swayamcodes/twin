import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ComparisonResultSchema, ComparisonRowSchema, renderComparison,
  resolveComparisonEvidenceRef } from "../src/comparison-result.js";
import { evaluateComparisonScore } from "../src/comparison-runner.js";

const jsonPath = fileURLToPath(new URL("../../../docs/phase-2-comparison.json", import.meta.url));
const markdownPath = fileURLToPath(new URL("../../../docs/phase-2-comparison.md", import.meta.url));
const scenarios = Array.from({ length: 13 }, (_, index) => `S${index + 1}`);
const tools = ["twin", "agenttx", "plain-git"];

describe("published Phase 2 comparison", () => {
  it("has every scenario/tool attempt once, five evidenced fields and no private paths", async () => {
    const bytes = await fs.readFile(jsonPath, "utf8");
    expect(bytes.endsWith("\n")).toBe(true);
    expect(bytes.slice(0, -1)).not.toContain("\n");
    expect(bytes).not.toMatch(/\/tmp\/|\/home\/|SECRET=|AGENTTX_HOME=|TWIN_S11_TOKEN=/);
    const result = ComparisonResultSchema.parse(JSON.parse(bytes) as unknown);
    expect(result.rows.map(row => `${row.scenarioId}:${row.tool}`)).toEqual(
      scenarios.flatMap(id => tools.map(tool => `${id}:${tool}`)));
    expect(result.rows.every(row => Object.keys(row.score).length === 5)).toBe(true);
    for (const row of result.rows) for (const field of Object.values(row.score)) {
      expect(field.reason.length).toBeGreaterThan(0);
      if (field.outcome !== "unknown") expect(field.evidenceRefs.length).toBeGreaterThan(0);
      for (const ref of field.evidenceRefs)
        expect(resolveComparisonEvidenceRef(row, ref)).not.toBeUndefined();
    }
    for (const row of result.rows) {
      if (row.action === "completed") expect(row.actionExitCode).toBe(0);
      if (row.score.blockedBeforeExecution.outcome === "blocked") {
        expect(row.observations.actionStart).toBe("not-started");
        expect(row.observations.preventionBeforeAction).toBe("observed");
      }
      if (row.score.reported.outcome === "reported") expect(row.observations.report).toBe("mentions-effect");
      if (row.score.recoveredOrPreserved.outcome === "not-recovered")
        expect(row.observations.targetAfterRecovery).toBe("changed");
      if (row.recovery === "git-recipe") expect(row.tool).toBe("plain-git");
    }
    expect(await fs.readFile(markdownPath, "utf8")).toBe(renderComparison(result));
  });

  it("keeps same-attempt compatibility and Git recovery findings distinct", async () => {
    const result = ComparisonResultSchema.parse(JSON.parse(await fs.readFile(jsonPath, "utf8") as string) as unknown);
    const row = (id: string, tool: string) => {
      const found = result.rows.find(item => item.scenarioId === id && item.tool === tool);
      assert(found); return found;
    };
    expect(row("S1", "plain-git").score.recoveredOrPreserved.outcome).toBe("recovered");
    for (const id of ["S2", "S3", "S4", "S5", "S6", "S7", "S8", "S9", "S10", "S11"])
      expect(row(id, "plain-git").score.recoveredOrPreserved.outcome).toBe("not-recovered");
    expect(row("S12", "plain-git").score.recoveredOrPreserved.outcome).toBe("unknown");
    expect(row("S6", "agenttx").compatibility).toContain("scratch-baseline-committed");
    expect(row("S4", "agenttx").compatibility).toContain("unsaved-edit-baseline-committed");
    expect(row("S8", "agenttx").compatibility).toContain("non-git-refused");
    expect(row("S13", "agenttx").compatibility).toContain("ignored-input-missing");
    expect(Object.values(row("S6", "agenttx").score).map(field => field.outcome))
      .toEqual(["unknown", "unknown", "unknown", "unknown", "unknown"]);
    expect(row("S6", "plain-git").observations.actionOutput).toBe("mentions-removal");
    expect(row("S6", "plain-git").score.reported.outcome).toBe("unknown");
    for (const id of ["S9", "S10", "S11"])
      expect(row(id, "twin").score.recoveredOrPreserved.outcome).toBe("not-recovered");
  });

  it("rejects unresolved row-local evidence references", async () => {
    const result = ComparisonResultSchema.parse(JSON.parse(await fs.readFile(jsonPath, "utf8") as string) as unknown);
    const row = result.rows[0]!;
    const unresolved = { ...row, score: { ...row.score,
      reported: { ...row.score.reported, evidenceRefs: ["observations.missing"] } } };
    expect(ComparisonRowSchema.safeParse(unresolved).success).toBe(false);
    const absentField = { ...row, observations: { ...row.observations, report: undefined } };
    expect(ComparisonRowSchema.safeParse(absentField).success).toBe(false);
  });

  it("does not turn Git S6 action stdout into tool-report credit", async () => {
    const result = ComparisonResultSchema.parse(JSON.parse(await fs.readFile(jsonPath, "utf8") as string) as unknown);
    const row = result.rows.find(item => item.scenarioId === "S6" && item.tool === "plain-git");
    assert(row);
    const observations = { ...row.observations, actionOutput: "mentions-removal" as const,
      report: "mentions-effect" as const };
    expect(evaluateComparisonScore("S6", "plain-git", "completed", observations).reported.outcome).toBe("unknown");
    const falseCredit = { ...row, observations, score: { ...row.score,
      reported: { outcome: "reported", reason: "Removal stdout", evidenceRefs: ["observations.actionOutput"] } } };
    expect(ComparisonRowSchema.safeParse(falseCredit).success).toBe(false);
  });

  it("rejects blocked when only a policy flag and null exit exist", async () => {
    const result = ComparisonResultSchema.parse(JSON.parse(await fs.readFile(jsonPath, "utf8") as string) as unknown);
    const row = result.rows.find(item => item.scenarioId === "S8" && item.tool === "agenttx");
    assert(row);
    const observations = { ...row.observations, policyBlock: "observed" as const,
      actionStart: "unknown" as const, preventionBeforeAction: "unknown" as const };
    expect(evaluateComparisonScore("S8", "agenttx", "unknown", observations)
      .blockedBeforeExecution.outcome).toBe("unknown");
    const unsupported = { ...row, actionExitCode: null, observations,
      score: { ...row.score, blockedBeforeExecution: { outcome: "blocked", reason: "Policy flag only",
        evidenceRefs: ["observations.policyBlock", "actionExitCode"] } } };
    expect(ComparisonRowSchema.safeParse(unsupported).success).toBe(false);
  });
});
