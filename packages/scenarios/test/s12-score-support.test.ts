import { describe, expect, it } from "vitest";
import { canonicalS12Refs, S12ScoreIncompleteSchema, S12ScoreSupportSchema, validateS12ScoreSupport } from "../src/contract/s12-score-support.js";

describe("2.6R-1 S12 score-support boundary", () => {
  it("keeps the incomplete result free of a ToolScore", () => {
    const result = { schemaVersion: 1, resultVersion: 1, status: "incomplete", scenarioId: "S12", stage: "attempt-validation",
      reason: "attempt-not-ready", identities: {} };
    expect(S12ScoreIncompleteSchema.parse(result)).toEqual(result);
    expect(S12ScoreIncompleteSchema.safeParse({ ...result, score: {} }).success).toBe(false);
  });
  it("requires five closed dimension entries and one score", () => {
    expect(S12ScoreSupportSchema.safeParse({ schemaVersion: 1, supportVersion: 1 }).success).toBe(false);
    expect(S12ScoreSupportSchema.safeParse({ schemaVersion: 1, supportVersion: 1, dimensions: { extra: true } }).success).toBe(false);
  });
  it("sorts and deduplicates refs by parsed-key-order JSON code units", () => {
    const a = { kind: "attempt-protocol-observation" as const, protocolVersion: 1 as const,
      toolRunId: "toolrun:a", observationId: "observation:a" };
    const b = { ...a, observationId: "observation:b" };
    expect(canonicalS12Refs([b, a, b])).toEqual([a, b]);
  });
  it("rejects a malformed or substituted public support without exposing input", () => {
    const source = { reference: { sourceRunId: `sha256:${"a".repeat(64)}` }, referenceArtifactId: "artifact:a",
      attemptArtifactId: "artifact:b", bundle: { request: { toolRunId: "toolrun:a" } }, protocol: {} };
    expect(validateS12ScoreSupport({ privatePath: "/secret" }, source as never)).toEqual({ success: false, reason: "support-unresolved" });
  });
});
