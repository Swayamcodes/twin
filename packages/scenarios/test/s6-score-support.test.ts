import { describe, expect, it } from "vitest";
import { canonicalS6Refs, S6ScoreResultSchema, S6ScoreSupportSchema, s6ReasonText,
  validateS6ScoreSupport } from "../src/contract/s6-score-support.js";

const ref = (id: string) => ({ kind: "attempt-protocol-observation" as const,
  protocolVersion: 1 as const, toolRunId: "toolrun:one", observationId: `observation:${id}` });
describe("S6-only score support contract", () => {
  it("canonicalizes parsed scoped references by code-unit order and removes duplicates", () => {
    expect(canonicalS6Refs([ref("z"), ref("a"), ref("z")])).toEqual([ref("a"), ref("z")]);
  });
  it("fixes the seven reason texts without accepting arbitrary prose", () => {
    expect(s6ReasonText("twin-report-not-reviewed-v1")).toContain("Twin reporting");
    expect(s6ReasonText("delivered-git-clean-started-v1")).toContain("Git clean");
  });
  it("rejects a known result without decisive refs and more than 24 refs", () => {
    const base = { outcome: "not-blocked", reasonCode: "delivered-git-clean-started-v1", refs: [] };
    const dimensions = { recoveredOrPreserved: { outcome: "unknown", reasonCode: "preservation-not-established-v1", refs: [] },
      reported: { outcome: "unknown", reasonCode: "twin-report-not-reviewed-v1", refs: [] },
      blockedBeforeExecution: base, workspaceUsable: { outcome: "unknown", reasonCode: "fixed-clean-work-unresolved-v1", refs: [] },
      boundaryAccuratelyDescribed: { outcome: "unknown", reasonCode: "claim-not-reviewed-v1", refs: [] } };
    const support = { schemaVersion: 1, supportVersion: 1, scenarioId: "S6", toolRunId: "toolrun:one",
      requestId: "request:one", oracleRunId: `sha256:${"0".repeat(64)}`, referenceArtifactId: "artifact:reference",
      attemptArtifactId: "artifact:attempt", score: {}, dimensions };
    expect(S6ScoreSupportSchema.safeParse(support).success).toBe(false);
    expect(S6ScoreSupportSchema.safeParse({ ...support, dimensions: { ...dimensions,
      blockedBeforeExecution: { ...base, refs: Array.from({ length: 25 }, (_, i) => ref(String(i))) } } }).success).toBe(false);
  });
  it("keeps incomplete JSON free of score, support and arbitrary metadata", () => {
    const incomplete = { schemaVersion: 1, resultVersion: 1, status: "incomplete", scenarioId: "S6",
      stage: "preflight", reason: "unsafe-destination", identities: {} };
    expect(S6ScoreResultSchema.parse(incomplete)).toEqual(incomplete);
    expect(S6ScoreResultSchema.safeParse({ ...incomplete, scoreSupport: {} }).success).toBe(false);
    expect(S6ScoreResultSchema.safeParse({ ...incomplete, path: "/private" }).success).toBe(false);
    expect(typeof validateS6ScoreSupport).toBe("function");
  });
});
