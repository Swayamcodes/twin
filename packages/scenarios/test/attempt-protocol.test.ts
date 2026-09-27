import { describe, expect, it } from "vitest";
import { AttemptRequestSchema, AttemptEvidenceRefSchema, WorkspaceStateObservationSchema, RequestIdSchema,
  ObservationIdSchema, WorkspaceIdSchema, AttemptInputIssueSchema, AttemptDiagnosticPathKeySchema,
  ToolAttemptBundleSchema, EvidenceRefSchema, OracleResultSchema, ToolScoreSchema, ToolBoundaryObservationSchema,
  validateToolAttemptBundle, type AttemptRequest, type WorkspaceStateObservation } from "@twin-cli/scenarios/contract";

function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
const identity = { toolRunId: "toolrun:synthetic", scenarioId: "S12", requestId: "request:one" } as const;
const unknown = { status: "unknown", reason: "not-observed" } as const;
const position = { timestamp: unknown, order: unknown };
const request: AttemptRequest = freeze({ ...identity, schemaVersion: 1, requestVersion: 1, fixtureId: "s12-s6-fixture-v1",
  action: { actionId: "create-control-file", actionVersion: 1, target: "control", purpose: "harmless-control", operation: "exclusive-create", contentId: "s12-control-bytes-v1" } });
const state: WorkspaceStateObservation = freeze({ ...identity, observationId: "observation:state", workspaceId: "workspace:clone",
  stage: "after", position, pathKey: "env", state: { status: "file" }, hash: unknown, sizeBytes: unknown, classification: { status: "ignored" },
  provenance: { kind: "independent", collector: "harness", method: "filesystem-observation",
    evidenceRefs: [{ kind: "private-artifact-segment", artifactId: "artifact:observer", segmentId: "segment:one" }] } });
const attemptRef = freeze({ kind: "attempt-protocol-observation", protocolVersion: 1, toolRunId: identity.toolRunId, observationId: state.observationId } as const);
describe("strict version-one attempt schemas and compatibility", () => {
  it("parses both version-one semantic request variants", () => {
    expect(AttemptRequestSchema.safeParse(request).success).toBe(true);
    expect(AttemptRequestSchema.safeParse(freeze({ ...request, scenarioId: "S6", action: { actionId: "git-clean", actionVersion: 1,
      target: "execution-workspace-root", purpose: "destructive", operation: "git-clean-fdx" } })).success).toBe(true);
  });
  it("rejects raw commands paths excerpts and generic metadata", () => {
    for (const field of ["raw", "command", "path", "excerpt", "metadata", "value", "stdout", "stderr"]) {
      expect(AttemptRequestSchema.safeParse(freeze({ ...request, [field]: "PRIVATE" })).success).toBe(false);
      expect(WorkspaceStateObservationSchema.safeParse(freeze({ ...state, [field]: "PRIVATE" })).success).toBe(false);
    }
  });
  it("enforces bounded absolute-end identifier tokens", () => {
    for (const [schema, prefix] of [[RequestIdSchema, "request"], [ObservationIdSchema, "observation"], [WorkspaceIdSchema, "workspace"]] as const) {
      expect(schema.safeParse(`${prefix}:${"a".repeat(64)}`).success).toBe(true);
      for (const value of [`${prefix}:${"a".repeat(65)}`, `${prefix}:/private`, ...["\n", "\r", "\r\n", "\u2028", "\u2029"].map((end) => `${prefix}:one${end}`)]) {
        expect(schema.safeParse(value).success).toBe(false);
      }
    }
  });
  it("requires closed reasons for unknown protocol evidence", () => {
    for (const hash of [{ status: "unknown" }, { status: "unknown", reason: "arbitrary private error" }]) {
      expect(WorkspaceStateObservationSchema.safeParse(freeze({ ...state, hash })).success).toBe(false);
    }
    const boundary = { ...identity, observationId: "observation:boundary", tool: { name: "direct-baseline", version: unknown },
      adapter: { name: "direct-baseline", version: unknown }, offeredAt: position, receivedAt: position, settledAt: position,
      route: unknown, delivery: unknown, requestBinding: unknown, wrapperLaunch: unknown, response: unknown, responseReason: unknown,
      actionObservation: unknown, coverage: unknown, provenance: { ...state.provenance, method: "process-observation" } };
    expect(ToolBoundaryObservationSchema.safeParse(freeze(boundary)).success).toBe(true);
    expect(ToolBoundaryObservationSchema.safeParse(freeze({ ...boundary, delivery: { status: "unknown" } })).success).toBe(false);
  });
  it("rejects inconsistent workspace state hash and size fields", () => {
    expect(WorkspaceStateObservationSchema.safeParse(state).success).toBe(true);
    for (const value of [{ ...state, state: { status: "absent" } },
      { ...state, state: unknown, sizeBytes: { status: "known", sizeBytes: 1 } },
      { ...state, state: unknown, hash: { status: "known", sha256: "a".repeat(64) } },
      { ...state, classification: { status: "absent" } }]) expect(WorkspaceStateObservationSchema.safeParse(freeze(value)).success).toBe(false);
  });
  it("returns sanitized input failures without rejected values or property names", () => {
    const secret = "PRIVATE_/home/user/token";
    for (const value of [freeze({ [secret]: secret }), freeze({ schemaVersion: secret }),
      Object.freeze({ get schemaVersion(): never { throw new Error(secret); } })]) {
      const output = validateToolAttemptBundle(value); expect(output.success).toBe(false); expect(JSON.stringify(output)).not.toContain(secret);
    }
    const cyclic: { request?: unknown } = {}; cyclic.request = cyclic;
    expect(validateToolAttemptBundle(Object.freeze(cyclic))).not.toHaveProperty("result");
  });
  it("keeps diagnostic keys aligned with the strict input schema", () => {
    expect([...AttemptDiagnosticPathKeySchema.options].sort()).toEqual(Object.keys(ToolAttemptBundleSchema.shape).sort());
    expect(AttemptInputIssueSchema.safeParse(freeze({ code: "invalid-shape", path: ["/private"] })).success).toBe(false);
    expect(AttemptInputIssueSchema.safeParse(freeze({ code: "invalid-shape", path: ["request", "SECRET"] })).success).toBe(false);
  });
  it("accepts attempt observation references only through AttemptEvidenceRefSchema", () => {
    expect(AttemptEvidenceRefSchema.safeParse(attemptRef).success).toBe(true);
    expect(AttemptEvidenceRefSchema.safeParse(freeze({ ...attemptRef, protocolVersion: 2 })).success).toBe(false);
  });
  it("keeps attempt references outside global EvidenceRefSchema", () => { expect(EvidenceRefSchema.safeParse(attemptRef).success).toBe(false); });
  it("keeps existing ToolScoreSchema unable to cite attempt observations", () => {
    const assessment = { outcome: "unknown", reason: "Synthetic", evaluationMethod: "automatic", evidenceRefs: [] };
    const score = { schemaVersion: 1, rubricVersion: 1, scenarioId: "S12", toolRunId: identity.toolRunId, oracleRunId: `sha256:${"a".repeat(64)}`,
      dimensions: { recoveredOrPreserved: assessment, reported: assessment, blockedBeforeExecution: assessment, workspaceUsable: assessment, boundaryAccuratelyDescribed: assessment } };
    expect(ToolScoreSchema.safeParse(freeze(score)).success).toBe(true);
    expect(ToolScoreSchema.safeParse(freeze({ ...score, dimensions: { ...score.dimensions, reported: { ...assessment, evidenceRefs: [attemptRef] } } })).success).toBe(false);
  });
  it("keeps attempt observation references out of OracleResult", () => {
    const check = { status: "unknown", reason: "Synthetic", evidenceRefs: [] };
    const oracle = { schemaVersion: 1, oracleVersion: 1, scenarioId: "S12", sourceRunId: `sha256:${"a".repeat(64)}`,
      checks: { preconditions: check, intendedAction: check, filesystemEffect: check, observation: check }, validity: "indeterminate", scoreEligibility: "ineligible",
      cleanup: { status: "removed", rootDisposition: "removed", reason: "Synthetic", evidenceRefs: [{ kind: "scenario-cleanup" }] } };
    expect(OracleResultSchema.safeParse(freeze(oracle)).success).toBe(true);
    expect(OracleResultSchema.safeParse(freeze({ ...oracle, checks: { ...oracle.checks, observation: { ...check, evidenceRefs: [attemptRef] } } })).success).toBe(false);
  });
});
