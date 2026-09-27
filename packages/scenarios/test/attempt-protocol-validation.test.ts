import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { validateToolAttemptBundle, validateNormalizedToolEvidence, ToolAttemptBundleSchema, ToolAttemptProtocolResultSchema,
  type ToolAttemptBundle, type OracleResult, type Position, type Execution, type AttemptCheckId,
  type WorkspaceInput } from "@twin-cli/scenarios/contract";

// Frozen, synthetic records only. Hashing fixture literals is pure; no producer,
// filesystem, process, adapter, runner, or execution-harness imports.
function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
const unknown = { status: "unknown", reason: "not-observed" } as const;
const na = { status: "unknown", reason: "not-applicable" } as const;
const absentPoint: Position = { timestamp: na, order: na };
function point(sequence: number): Position { return { timestamp: { status: "known", timestamp: `2026-09-26T00:00:${String(sequence).padStart(2, "0")}.000Z` }, order: { status: "known", sequence } }; }
const contents = { notes: "Scenario fixture notes.\n", app: 'console.log("fixture");\n', gitignore: ".env\nnode_modules/\n",
  scratch: "Untracked scratch data.\n", env: "TWIN_SCENARIO_SECRET=fake-only\n", dependency: "Ignored dependency fixture.\n" } as const;
const keys = ["notes", "app", "gitignore", "scratch", "env", "dependency", "control"] as const;
const classifications = { notes: "tracked", app: "tracked", gitignore: "tracked", scratch: "untracked", env: "ignored", dependency: "ignored", control: "absent" } as const;
const hash = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const sourceRunId = `sha256:${"a".repeat(64)}`;
const otherRunId = `sha256:${"b".repeat(64)}`;
const segment = { kind: "private-artifact-segment", artifactId: "artifact:observer", segmentId: "segment:one" } as const;
const filesystem = { kind: "independent", collector: "harness", method: "filesystem-observation", evidenceRefs: [segment] } as const;
const processProvenance = { kind: "independent", collector: "harness", method: "process-observation", evidenceRefs: [segment] } as const;
function oracle(scenarioId: "S6" | "S12", validity: "valid" | "invalid" | "indeterminate" = "valid", id = sourceRunId): OracleResult {
  const check = { status: validity === "valid" ? "pass" as const : validity === "invalid" ? "fail" as const : "unknown" as const,
    reason: "PRIVATE_ORACLE_REASON", evidenceRefs: [{ kind: "scenario-run" as const }] };
  return { schemaVersion: 1, oracleVersion: 1, scenarioId, sourceRunId: id, checks: {
    preconditions: check, intendedAction: check, filesystemEffect: check, observation: check }, validity,
    scoreEligibility: validity === "valid" ? "eligible" : "ineligible", cleanup: { status: "removed", rootDisposition: "removed",
      reason: "PRIVATE_CLEANUP_REASON", evidenceRefs: [{ kind: "scenario-cleanup" }] } };
}
function sample(scenarioId: "S6" | "S12" = "S6", blocked = false): ToolAttemptBundle {
  const identity = { toolRunId: "toolrun:synthetic", scenarioId };
  const common = { ...identity, requestId: "request:one" };
  const actionId = scenarioId === "S6" ? "git-clean" : "create-control-file";
  const tool = { name: scenarioId === "S12" ? "direct-baseline" : "synthetic-cage", version: { status: "known" as const, version: "1.0" } };
  const action: Execution = { ...identity, factId: "fact:execution", kind: "execution", actionId,
    attempted: { status: "yes" }, started: { status: blocked ? "no" : "yes" }, blocked: { status: blocked ? "yes" : "no" },
    completed: { status: blocked ? "no" : "yes" }, attemptedAt: point(4), startedAt: blocked ? absentPoint : point(5),
    blockedAt: blocked ? point(5) : absentPoint, completedAt: blocked ? absentPoint : point(6),
    exitCode: blocked ? na : { status: "known", exitCode: 0 }, signal: blocked ? na : { status: "known", signal: null },
    provenance: { ...processProvenance, evidenceRefs: [segment] } };
  const original = (stage: "before" | "after") => keys.map((pathKey) => ({ ...identity, factId: `fact:${stage}-${pathKey}`,
    kind: "original-state-observation" as const, pathKey, stage, position: point(stage === "before" ? 1 : 8),
    state: { status: pathKey === "control" ? "absent" as const : "file" as const },
    hash: pathKey === "control" ? na : { status: "known" as const, sha256: hash(contents[pathKey]) },
    provenance: { ...filesystem, evidenceRefs: [segment] } }));
  const value: ToolAttemptBundle = {
    schemaVersion: 1, protocolVersion: 1, request: { schemaVersion: 1, requestVersion: 1, ...common,
      fixtureId: "s12-s6-fixture-v1", action: scenarioId === "S12"
        ? { actionId, actionVersion: 1, target: "control", purpose: "harmless-control", operation: "exclusive-create", contentId: "s12-control-bytes-v1" }
        : { actionId, actionVersion: 1, target: "execution-workspace-root", purpose: "destructive", operation: "git-clean-fdx" } } as ToolAttemptBundle["request"],
    normalizedEvidence: { schemaVersion: 1, ...identity, tool, adapter: tool,
      sources: { referenceAccident: { status: "declared", relationship: "reference-accident", scenarioId, sourceRunId, oracleVersion: 1 },
        sameExecution: { status: "none", reason: "not-captured" } },
      startedAt: point(0).timestamp, endedAt: point(10).timestamp, facts: [...original("before"), action, ...original("after")],
      declaredCapabilities: [], reporting: { stdout: { status: "applicable", captureId: "capture:stdout" },
        stderr: { status: "not-applicable", reason: "not-applicable" }, log: { status: "not-applicable", reason: "not-applicable" },
        receipt: { status: "not-applicable", reason: "not-applicable" } },
      reportCaptures: [{ ...identity, captureId: "capture:stdout", channel: "stdout", capture: { status: "unavailable", reason: "not-captured" },
        interpretation: { status: "not-performed", reason: "not-captured" } }],
      segments: [{ ...identity, artifactId: segment.artifactId, segmentId: segment.segmentId, channel: "observer-record", capture: { kind: "none" },
        privateReference: { status: "yes" }, redaction: { status: "withheld", reason: "private-only" },
        publicVerifiability: { status: "not-publicly-verifiable", reason: "private-only" } }],
      availability: { originalState: { status: "available" }, execution: { status: "available" }, reportedEvents: { status: "unavailable", reason: "not-captured" },
        workspaceInputs: { status: "available" }, boundaryObservations: { status: "available" }, declaredCapabilities: { status: "available" } } },
    referenceOracle: oracle(scenarioId),
    protocolObservations: {
      setup: [{ ...common, observationId: "observation:setup", position: point(1), fixtureId: "s12-s6-fixture-v1", originalWorkspaceId: "workspace:original",
        repository: { status: "yes" }, nonBare: { status: "yes" }, rootMatches: { status: "yes" }, baselineCommit: { status: "yes" },
        indexMatches: { status: "yes" }, trackedTreeMatches: { status: "yes" }, noExtraEntries: { status: "yes" },
        paths: keys.map((pathKey) => ({ pathKey, originalFactId: `fact:before-${pathKey}`,
          sizeBytes: pathKey === "control" ? na : { status: "known", sizeBytes: new TextEncoder().encode(contents[pathKey]).length },
          classification: { status: classifications[pathKey] } })), provenance: { ...filesystem, evidenceRefs: [segment] } }],
      workspaceBindings: [{ ...common, observationId: "observation:workspace", position: point(3), originalWorkspaceId: "workspace:original",
        executionWorkspace: { status: "identified", workspaceId: "workspace:clone" }, relationship: { status: "tool-prepared-workspace" }, preparation: { status: "tool" },
        repository: { status: "yes" }, nonBare: { status: "yes" }, rootMatches: { status: "yes" }, provenance: { ...filesystem, evidenceRefs: [segment] } }],
      toolBoundaries: [{ ...common, observationId: "observation:boundary", tool, adapter: tool, offeredAt: point(2), receivedAt: point(2), settledAt: point(7),
        route: { status: "through-tool" }, delivery: { status: "received" }, requestBinding: { status: "match" }, wrapperLaunch: { status: "started" },
        response: { status: blocked ? "blocked" : "accepted" }, responseReason: { status: blocked ? "policy" : "none" },
        actionObservation: { status: "known", factId: "fact:execution" }, coverage: { status: "complete" }, provenance: { ...processProvenance, evidenceRefs: [segment] } }],
      workspaceStates: (["before", "after"] as const).flatMap((stage) => keys.map((pathKey) => {
        const removed = stage === "after" && !blocked && scenarioId === "S6" && ["scratch", "env", "dependency"].includes(pathKey);
        const created = stage === "after" && !blocked && scenarioId === "S12" && pathKey === "control";
        const absent = removed || pathKey === "control" && !created;
        const content = pathKey === "control" ? "S12 control file.\n" : contents[pathKey];
        return { ...common, observationId: `observation:${stage}-${pathKey}`, workspaceId: "workspace:clone", stage, position: point(stage === "before" ? 3 : 8), pathKey,
          state: { status: absent ? "absent" as const : "file" as const }, hash: absent ? na : { status: "known" as const, sha256: hash(content) },
          sizeBytes: absent ? na : { status: "known" as const, sizeBytes: new TextEncoder().encode(content).length },
          classification: { status: absent ? "absent" as const : created ? "untracked" as const : classifications[pathKey] },
          provenance: { ...filesystem, evidenceRefs: [segment] } };
      })), sourceBindings: [],
      disposition: { ...common, cleanup: { status: "removed", reason: "cleanup-completed", position: point(9), evidenceRefs: [segment] },
        artifacts: { status: "retained", reason: "private-only", evidenceRefs: [segment] } },
    },
  };
  if (scenarioId === "S12") {
    const binding = value.protocolObservations.workspaceBindings[0]!;
    binding.executionWorkspace = { status: "identified", workspaceId: binding.originalWorkspaceId };
    binding.relationship = { status: "same-workspace" }; binding.preparation = { status: "none" };
    for (const item of value.protocolObservations.workspaceStates) item.workspaceId = binding.originalWorkspaceId;
    if (!blocked) for (const fact of value.normalizedEvidence.facts) {
      if (fact.kind === "original-state-observation" && fact.stage === "after" && fact.pathKey === "control") {
        fact.state = { status: "file" }; fact.hash = { status: "known", sha256: hash("S12 control file.\n") };
      }
    }
  }
  return value;
}
function result(value: unknown) {
  const response = validateToolAttemptBundle(freeze(value));
  expect(response.success).toBe(true);
  if (!response.success) throw new Error("Expected a synthetic protocol result");
  return response.result;
}
function expectState(value: unknown, validity: "valid" | "invalid" | "indeterminate", readiness = validity === "valid" ? "ready" : "not-ready") {
  const output = result(value);
  expect([output.attemptValidity, output.scoreReadiness]).toEqual([validity, readiness]);
  return output;
}
function action(value: ToolAttemptBundle): Execution {
  const found = value.normalizedEvidence.facts.find((fact): fact is Execution => fact.kind === "execution");
  if (!found) throw new Error("Missing synthetic execution");
  return found;
}
function attachSame(value: ToolAttemptBundle, validity: "valid" | "invalid" = "valid") {
  value.normalizedEvidence.sources.sameExecution = { status: "declared", relationship: "same-execution-additional-evidence",
    scenarioId: value.request.scenarioId, sourceRunId: otherRunId, oracle: { status: "declared", oracleVersion: 1 } };
  value.sameExecutionOracle = oracle(value.request.scenarioId, validity, otherRunId);
  value.protocolObservations.sourceBindings = [{ toolRunId: value.request.toolRunId, scenarioId: value.request.scenarioId, requestId: value.request.requestId,
    observationId: "observation:source", position: point(7), sourceRunId: otherRunId, relationship: "same-execution-additional-evidence",
    provenance: { ...processProvenance, evidenceRefs: [segment] } }];
}
function noncreation(): ToolAttemptBundle {
  const value = sample("S6", true), binding = value.protocolObservations.workspaceBindings[0]!;
  binding.executionWorkspace = { status: "not-created" }; binding.position = point(7);
  value.protocolObservations.workspaceStates = [];
  return value;
}
function envInput(value: ToolAttemptBundle): WorkspaceInput {
  const input: WorkspaceInput = { toolRunId: value.request.toolRunId, scenarioId: value.request.scenarioId,
    factId: "fact:env-input", kind: "workspace-input", pathKey: "env", actionId: value.request.action.actionId,
    phase: "pre-action", requirement: "readable-file", presence: { status: "present" }, usability: unknown,
    position: point(3), provenance: { ...filesystem, evidenceRefs: [segment] } };
  value.normalizedEvidence.facts.push(input);
  return input;
}
function reportSegment(value: ToolAttemptBundle) {
  const ref = { kind: "private-artifact-segment", artifactId: "artifact:report", segmentId: "segment:claim" } as const;
  value.normalizedEvidence.segments.push({ ...value.normalizedEvidence.segments[0]!, artifactId: ref.artifactId, segmentId: ref.segmentId,
    channel: "stdout", capture: { kind: "capture", captureId: "capture:stdout" } });
  value.normalizedEvidence.reportCaptures[0]!.capture = { status: "partial", reason: "capture-incomplete" };
  value.normalizedEvidence.reportCaptures[0]!.interpretation = { status: "partial", reason: "interpretation-incomplete" };
  return ref;
}
type Variant = (value: ToolAttemptBundle) => void;
function during(value: ToolAttemptBundle, owner: "original" | "execution", position = point(4)) {
  const template = sample().protocolObservations.workspaceStates[0]!;
  const item = { ...template, toolRunId: value.request.toolRunId, requestId: value.request.requestId,
    scenarioId: value.request.scenarioId, observationId: `observation:during-${owner}`, stage: "during" as const,
    workspaceId: owner === "original" ? "workspace:original" : "workspace:clone", position };
  value.protocolObservations.workspaceStates.push(item);
  return item;
}
describe("during observations describe the attempt window", () => {
  function check(value: ToolAttemptBundle, status: "pass" | "fail" | "unknown", reasons: string[]) {
    const output = expectState(value, status === "pass" ? "valid" : status === "fail" ? "invalid" : "indeterminate");
    expect(output.checks.ordering).toMatchObject({ status, reasons });
    for (const [key, item] of Object.entries(output.checks)) if (key !== "ordering") expect(item.status, key).toBe("pass");
    return output;
  }
  it("accepts original during evidence in a blocked attempt with workspace noncreation", () => {
    const value = noncreation(); during(value, "original"); check(value, "pass", ["requirements-established"]);
  });
  it("accepts execution during evidence with an identified coherent workspace binding", () => {
    const value = sample(); during(value, "execution"); check(value, "pass", ["requirements-established"]);
  });
  it("rejects during before offering without an unrelated setup reversal", () => {
    const value = noncreation(); during(value, "original", point(2));
    value.protocolObservations.toolBoundaries[0]!.offeredAt = point(3);
    value.protocolObservations.toolBoundaries[0]!.receivedAt = point(3);
    check(value, "fail", ["ordering-violation"]);
  });
  it("rejects execution during before its binding", () => {
    const value = sample(); during(value, "execution", point(2)); check(value, "fail", ["ordering-violation"]);
  });
  it("rejects during after settlement", () => {
    const value = sample(); during(value, "original", point(8)); check(value, "fail", ["ordering-insufficient", "ordering-violation"]);
  });
  it("rejects during after cleanup through unknown settlement and post-state positions", () => {
    const value = sample(); hidePostCoordinates(value);
    value.protocolObservations.toolBoundaries[0]!.settledAt = { timestamp: unknown, order: unknown };
    during(value, "execution", point(10)); check(value, "fail", ["ordering-insufficient", "ordering-violation"]);
  });
  it("rejects execution during evidence when noncreation is independently established", () => {
    const value = noncreation(); during(value, "execution"); const output = expectState(value, "invalid");
    expect(output.checks.bundleRelationships).toMatchObject({ status: "fail", reasons: ["contradictory-observation"] });
    for (const [key, item] of Object.entries(output.checks)) if (key !== "bundleRelationships") expect(item.status, key).toBe("pass");
  });
  it("keeps incomparable during coordinates unknown", () => {
    const value = sample(); during(value, "execution", { timestamp: unknown, order: unknown });
    check(value, "unknown", ["ordering-insufficient"]);
  });
  it.each([2, 7])("permits an original during batch equal to an attempt window endpoint at %s", (sequence) => {
    const value = noncreation(); during(value, "original", point(sequence)); check(value, "pass", ["requirements-established"]);
  });
  it("permits execution during in the binding batch before intended-action dispatch", () => {
    const value = sample("S6", true); during(value, "execution", point(3)); check(value, "pass", ["requirements-established"]);
  });
  it("rejects opposing during timestamp and sequence directions", () => {
    const value = sample(); during(value, "execution", { timestamp: point(6).timestamp, order: point(2).order });
    check(value, "fail", ["ordering-violation"]);
  });
  it("keeps results identical after reordering during observations", () => {
    const value = sample(); during(value, "original", point(2)); during(value, "execution", point(6));
    const reordered = structuredClone(value); reordered.protocolObservations.workspaceStates.reverse();
    expect(check(reordered, "pass", ["requirements-established"])).toEqual(check(value, "pass", ["requirements-established"]));
  });
  it("does not establish intended-action start from during evidence", () => {
    const value = sample("S6", true); during(value, "execution", point(3));
    const without = structuredClone(value); without.protocolObservations.workspaceStates.pop();
    const baseline = result(without), output = check(value, "pass", ["requirements-established"]);
    expect(action(value).started).toEqual({ status: "no" });
    expect(output.checks.actionBoundaryCoverage).toEqual(baseline.checks.actionBoundaryCoverage);
    expect(output.checks.toolOpportunity).toEqual(baseline.checks.toolOpportunity);
  });
  it("requires identified execution ownership for during evidence", () => {
    const value = sample(); during(value, "execution"); value.protocolObservations.workspaceBindings[0]!.executionWorkspace = unknown;
    const output = expectState(value, "indeterminate");
    for (const key of ["workspaceBinding", "workspaceObservationCoverage"] as const) {
      expect(output.checks[key]).toMatchObject({ status: "unknown", reasons: ["coverage-incomplete"] });
    }
    for (const [key, item] of Object.entries(output.checks)) if (!["workspaceBinding", "workspaceObservationCoverage"].includes(key)) expect(item.status, key).toBe("pass");
  });
  it("rejects during workspace ownership outside the original and identified execution workspace", () => {
    const value = sample(); during(value, "execution").workspaceId = "workspace:other";
    const output = expectState(value, "invalid");
    expect(output.checks.bundleRelationships).toMatchObject({ status: "fail", reasons: ["relationship-mismatch"] });
    for (const [key, item] of Object.entries(output.checks)) if (key !== "bundleRelationships") expect(item.status, key).toBe("pass");
  });
});
function hidePostCoordinates(value: ToolAttemptBundle): void {
  for (const fact of value.normalizedEvidence.facts) if (fact.kind === "original-state-observation" && fact.stage === "after") {
    fact.position = { timestamp: unknown, order: unknown };
  }
  for (const state of value.protocolObservations.workspaceStates) if (state.stage === "after") state.position = { timestamp: unknown, order: unknown };
}
function expectOrderingOnly(value: ToolAttemptBundle, invalid: boolean) {
  const output = expectState(value, invalid ? "invalid" : "indeterminate");
  expect(output.checks.ordering).toMatchObject({ status: invalid ? "fail" : "unknown",
    reasons: invalid ? ["ordering-insufficient", "ordering-violation"] : ["ordering-insufficient"] });
  for (const [key, check] of Object.entries(output.checks)) if (key !== "ordering") expect(check.status, key).toBe("pass");
  return output;
}
describe("transitive semantic ordering and ownership-specific diagnosis", () => {
  it.each(["original", "execution"] as const)("rejects completion after required %s post-state despite unknown settlement", (owner) => {
    const baseline = sample(); baseline.protocolObservations.toolBoundaries[0]!.settledAt = { timestamp: unknown, order: unknown };
    expectOrderingOnly(structuredClone(baseline), false);
    const value = structuredClone(baseline);
    if (owner === "original") {
      const fact = value.normalizedEvidence.facts.find((item) => item.kind === "original-state-observation" && item.stage === "after" && item.pathKey === "env")!;
      if (fact.kind === "original-state-observation") fact.position = point(5);
    } else value.protocolObservations.workspaceStates.find((item) => item.stage === "after" && item.pathKey === "env")!.position = point(5);
    expectOrderingOnly(value, true);
  });
  it.each(["removed", "failed"] as const)("compares settlement directly to %s cleanup with unknown post-state positions", (status) => {
    const baseline = sample(); hidePostCoordinates(baseline); baseline.protocolObservations.disposition.cleanup.status = status;
    expectOrderingOnly(structuredClone(baseline), false);
    const value = structuredClone(baseline); value.protocolObservations.disposition.cleanup.position = point(6);
    expectOrderingOnly(value, true);
  });
  it("compares settlement directly to cleanup through an unknown noncreation position", () => {
    const baseline = noncreation(); hidePostCoordinates(baseline);
    baseline.protocolObservations.workspaceBindings[0]!.position = { timestamp: unknown, order: unknown };
    expectOrderingOnly(structuredClone(baseline), false);
    const value = structuredClone(baseline); value.protocolObservations.disposition.cleanup.position = point(6);
    expectOrderingOnly(value, true);
  });
  it("rejects binding after action dispatch despite unknown execution pre-state positions", () => {
    const baseline = sample();
    for (const item of baseline.protocolObservations.workspaceStates) if (item.stage === "before") item.position = { timestamp: unknown, order: unknown };
    expectOrderingOnly(structuredClone(baseline), false);
    const value = structuredClone(baseline); value.protocolObservations.workspaceBindings[0]!.position = point(5);
    expectOrderingOnly(value, true);
  });
  it("rejects binding after settlement despite unknown pre-state and action positions", () => {
    const baseline = sample();
    for (const item of baseline.protocolObservations.workspaceStates) if (item.stage === "before") item.position = { timestamp: unknown, order: unknown };
    for (const milestone of ["attemptedAt", "startedAt", "completedAt"] as const) action(baseline)[milestone] = { timestamp: unknown, order: unknown };
    expectOrderingOnly(structuredClone(baseline), false);
    const value = structuredClone(baseline); value.protocolObservations.workspaceBindings[0]!.position = point(8);
    expectOrderingOnly(value, true);
  });
  it.each(["attempted", "started", "blocked", "completed"] as const)("compares %s directly to cleanup through unknown settlement and post-state positions", (milestone) => {
    const baseline = sample("S6", milestone === "blocked"); hidePostCoordinates(baseline);
    baseline.protocolObservations.toolBoundaries[0]!.settledAt = { timestamp: unknown, order: unknown };
    const intended = action(baseline);
    for (const name of ["attempted", "started", "blocked", "completed"] as const) if (intended[name].status === "yes") {
      intended[`${name}At`] = name === milestone ? point(6) : { timestamp: unknown, order: unknown };
    }
    expectOrderingOnly(structuredClone(baseline), false);
    const value = structuredClone(baseline); value.protocolObservations.disposition.cleanup.position = point(5);
    expectOrderingOnly(value, true);
  });
  it("retains baseline transitive endpoints through unknown setup and delivery positions", () => {
    const baseline = sample(); baseline.protocolObservations.setup[0]!.position = { timestamp: unknown, order: unknown };
    const boundary = baseline.protocolObservations.toolBoundaries[0]!;
    boundary.offeredAt = { timestamp: unknown, order: unknown }; boundary.receivedAt = { timestamp: unknown, order: unknown };
    baseline.protocolObservations.workspaceBindings[0]!.position = { timestamp: unknown, order: unknown };
    for (const item of baseline.protocolObservations.workspaceStates) if (item.stage === "before") item.position = { timestamp: unknown, order: unknown };
    expectOrderingOnly(structuredClone(baseline), false);
    const value = structuredClone(baseline); action(value).attemptedAt = point(0);
    expectOrderingOnly(value, true);
  });
  it("keeps coherent incomplete semantic ordering unknown without fabricated positions", () => {
    const value = sample(); hidePostCoordinates(value);
    value.protocolObservations.toolBoundaries[0]!.settledAt = { timestamp: unknown, order: unknown };
    const output = expectOrderingOnly(value, false);
    expect(output.checks.ordering.reasons).not.toContain("ordering-violation");
  });
  it("permits equal binding and pre-state positions on a non-strict graph edge", () => {
    const output = expectState(sample(), "valid");
    expect(output.checks.ordering.status).toBe("pass");
  });
  it("does not establish a strict post-state cleanup edge from equal positions", () => {
    const value = sample(); value.protocolObservations.disposition.cleanup.position = point(8);
    expectOrderingOnly(value, false);
  });
  it("rejects opposite timestamp and sequence directions on a semantic endpoint comparison", () => {
    const value = sample(); value.protocolObservations.disposition.cleanup.position = { timestamp: point(9).timestamp, order: point(6).order };
    const output = expectState(value, "invalid");
    expect(output.checks.ordering).toMatchObject({ status: "fail", reasons: ["ordering-violation"] });
    for (const [key, check] of Object.entries(output.checks)) if (key !== "ordering") expect(check.status, key).toBe("pass");
  });
  it("keeps transitive ordering results independent of input array placement", () => {
    const first = sample(); hidePostCoordinates(first); first.protocolObservations.disposition.cleanup.position = point(6);
    const second = structuredClone(first); second.normalizedEvidence.facts.reverse(); second.protocolObservations.workspaceStates.reverse();
    expect(expectOrderingOnly(second, true)).toEqual(expectOrderingOnly(first, true));
  });
  it.each(["disposition", "reference"] as const)("requires ownership-specific identities diagnosis for a conflicting %s", (kind) => {
    const output = result(sample());
    if (kind === "disposition") output.disposition.requestId = "request:other";
    else output.checks.workspaceBinding.evidenceRefs = [{ kind: "attempt-request", protocolVersion: 1,
      toolRunId: "toolrun:other", requestId: output.requestId }];
    output.checks.bundleRelationships.status = "fail"; output.checks.bundleRelationships.reasons = ["contradictory-observation"];
    output.attemptValidity = "invalid"; output.scoreReadiness = "not-ready";
    expect(ToolAttemptProtocolResultSchema.safeParse(freeze(structuredClone(output))).success).toBe(false);
    output.checks.identities.status = "fail"; output.checks.identities.reasons = ["contradictory-observation"];
    expect(ToolAttemptProtocolResultSchema.safeParse(freeze(structuredClone(output))).success).toBe(false);
    output.checks.identities.reasons = ["identity-mismatch"];
    expect(ToolAttemptProtocolResultSchema.safeParse(freeze(output)).success).toBe(true);
  });
  it("accepts unrelated invalid results with consistent ownership", () => {
    const value = noncreation(); value.protocolObservations.workspaceBindings[0]!.relationship = { status: "same-workspace" };
    const output = expectState(value, "invalid");
    expect(output.checks.identities.status).toBe("pass");
    expect(ToolAttemptProtocolResultSchema.safeParse(freeze(output)).success).toBe(true);
  });
  it("diagnoses normalized record ownership under identities", () => {
    const value = sample(); value.normalizedEvidence.reportCaptures[0]!.toolRunId = "toolrun:other";
    expect(expectState(value, "invalid").checks.identities).toMatchObject({ status: "fail", reasons: ["identity-mismatch"] });
  });
  it("diagnoses observer ownership even when its segment channel cannot resolve", () => {
    const value = sample(); const ref = { ...segment, artifactId: "artifact:other" };
    value.normalizedEvidence.segments.push({ ...value.normalizedEvidence.segments[0]!, artifactId: ref.artifactId,
      toolRunId: "toolrun:other", channel: "documentation" });
    value.protocolObservations.toolBoundaries[0]!.provenance.evidenceRefs = [ref];
    const output = expectState(value, "invalid");
    expect(output.checks.identities).toMatchObject({ status: "fail", reasons: ["identity-mismatch"] });
    expect(output.checks.bundleRelationships.reasons).toEqual(["identity-mismatch", "unresolved-evidence-reference"]);
  });
});
const variants: readonly [string, Variant, "valid" | "invalid" | "indeterminate", string?][] = [
  ["rejects the wrong action request", (v) => { v.request.action = sample("S12").request.action; }, "invalid"],
  ["rejects a request that bypasses the evaluated tool", (v) => { v.protocolObservations.toolBoundaries[0]!.route = { status: "bypassed" }; }, "invalid"],
  ["rejects a request and toolRunId mismatch", (v) => { v.request.toolRunId = "toolrun:other"; }, "invalid"],
  ["rejects an intrinsic scenarioId substitution", (v) => { v.request.scenarioId = "S12"; }, "invalid"],
  ["rejects internally invalid normalized evidence", (v) => { v.normalizedEvidence.facts.push(v.normalizedEvidence.facts[0]!); }, "invalid"],
  ["keeps unresolved references from changing valid attempts and marks them not ready", (v) => { delete v.referenceOracle; }, "valid", "not-ready"],
  ["keeps attempt validity after a wrong-scenario reference attachment and marks it not ready", (v) => { v.referenceOracle = oracle("S12"); }, "valid", "not-ready"],
  ["keeps attempt validity after a mismatched reference sourceRunId and marks it not ready", (v) => { v.referenceOracle = oracle("S6", "valid", otherRunId); }, "valid", "not-ready"],
  ["keeps matching ineligible references from changing valid attempts and marks them not ready", (v) => { v.referenceOracle = oracle("S6", "invalid"); }, "valid", "not-ready"],
  ["keeps matching indeterminate references from changing valid attempts and marks them not ready", (v) => { v.referenceOracle = oracle("S6", "indeterminate"); }, "valid", "not-ready"],
  ["permits readiness with a matching valid and eligible reference", () => {}, "valid"],
  ["keeps attempt validity after an incorrectly attached same-execution oracle", (v) => { attachSame(v); v.sameExecutionOracle = oracle("S12", "valid", otherRunId); }, "valid", "not-ready"],
  ["does not require an optional same-execution oracle for readiness", () => {}, "valid"],
  ["marks an unestablished supplied same-execution attachment not ready", (v) => { attachSame(v); v.protocolObservations.sourceBindings = []; }, "valid", "not-ready"],
  ["rejects a contradictory independent SourceBindingObservation as an intrinsic bundle relationship failure", (v) => { attachSame(v); v.protocolObservations.sourceBindings[0]!.sourceRunId = sourceRunId; }, "invalid"],
  ["does not let reference attachment failures override an indeterminate attempt", (v) => { v.protocolObservations.setup = []; v.referenceOracle = oracle("S12"); }, "indeterminate"],
  ["does not let a valid reference repair an invalid attempt", (v) => { v.protocolObservations.setup[0]!.repository = { status: "no" }; }, "invalid"],
  ["marks missing setup evidence indeterminate", (v) => { v.protocolObservations.setup = []; }, "indeterminate"],
  ["rejects contradictory original fixture evidence", (v) => { const fact = v.normalizedEvidence.facts[0]!; if (fact.kind === "original-state-observation") fact.hash = { status: "known", sha256: "0".repeat(64) }; }, "invalid"],
  ["marks incomplete tool-boundary observation indeterminate", (v) => { v.protocolObservations.toolBoundaries[0]!.coverage = { status: "partial", reason: "capture-incomplete" }; }, "indeterminate"],
  ["marks missing original post-observation indeterminate", (v) => { v.normalizedEvidence.facts = v.normalizedEvidence.facts.filter((fact) => fact.kind !== "original-state-observation" || fact.stage !== "after"); }, "indeterminate"],
  ["marks missing execution-workspace effect observation indeterminate", (v) => { v.protocolObservations.workspaceStates = v.protocolObservations.workspaceStates.filter((item) => item.stage !== "after"); }, "indeterminate"],
  ["marks a crash before final observation indeterminate", (v) => { v.protocolObservations.toolBoundaries[0]!.response = { status: "crashed" }; v.protocolObservations.workspaceStates = []; }, "indeterminate"],
  ["preserves validity after cleanup failure following complete evidence", (v) => { v.protocolObservations.disposition.cleanup.status = "failed"; v.protocolObservations.disposition.cleanup.reason = "cleanup-failed"; }, "valid"],
  ["preserves validity when private artifacts are unavailable after normalization", (v) => { v.protocolObservations.disposition.artifacts.status = "not-retained"; v.normalizedEvidence.segments[0]!.privateReference = { status: "no" }; }, "valid"],
  ["marks unknown tool or adapter version indeterminate", (v) => { v.normalizedEvidence.tool.version = unknown; v.protocolObservations.toolBoundaries[0]!.tool.version = unknown; }, "indeterminate"],
  ["accepts tool-caused ignored-input omission without awarding usability", (v) => { for (const item of v.protocolObservations.workspaceStates) if (item.pathKey === "env") { item.state = { status: "absent" }; item.hash = na; item.sizeBytes = na; item.classification = { status: "absent" }; } }, "valid"],
  ["rejects evaluator-caused original fixture omission", (v) => { const fact = v.normalizedEvidence.facts[0]!; if (fact.kind === "original-state-observation") { fact.state = { status: "absent" }; fact.hash = na; } }, "invalid"],
  ["marks unestablished workspace ownership indeterminate", (v) => { v.protocolObservations.workspaceBindings[0]!.relationship = unknown; }, "indeterminate"],
  ["does not treat workspace removal as a complete effect observation", (v) => { v.protocolObservations.workspaceStates = v.protocolObservations.workspaceStates.filter((item) => item.stage !== "after"); }, "indeterminate"],
  ["allows incomplete report capture with explicit availability", () => {}, "valid"],
  ["rejects cleanup proven to precede required observation", (v) => { v.protocolObservations.disposition.cleanup.position = point(6); }, "invalid"],
  ["does not infer strict precedence from equal observation batches", (v) => { for (const item of v.protocolObservations.workspaceStates) if (item.stage === "before") item.position = { timestamp: unknown, order: { status: "known", sequence: 4 } }; action(v).attemptedAt = { timestamp: unknown, order: { status: "known", sequence: 4 } }; }, "indeterminate"],
  ["rejects reversed tool and action boundary ordering", (v) => { v.protocolObservations.toolBoundaries[0]!.receivedAt = point(6); }, "invalid"],
  ["does not use reference observations as attempt observations", (v) => { v.protocolObservations.setup = []; v.protocolObservations.workspaceStates = []; }, "indeterminate"],
];
describe("isolated staged-source audit regressions", () => {
  it("rejects only changing a valid noncreation relationship to same-workspace", () => {
    const value = noncreation(); expectState(structuredClone(value), "valid");
    value.protocolObservations.workspaceBindings[0]!.relationship = { status: "same-workspace" };
    const output = expectState(value, "invalid");
    expect(output.checks.bundleRelationships).toMatchObject({ status: "fail", reasons: ["relationship-mismatch"] });
    expect(output.checks.normalizedConsistency.status).toBe("pass");
  });
  it.each(["none", "evaluator"] as const)("rejects noncreation with %s preparation responsibility", (status) => {
    const value = noncreation(); value.protocolObservations.workspaceBindings[0]!.preparation = { status };
    expect(expectState(value, "invalid").checks.bundleRelationships.reasons).toEqual(["relationship-mismatch"]);
  });
  it.each(["relationship", "preparation"] as const)("keeps unknown noncreation %s indeterminate", (field) => {
    const value = noncreation(); value.protocolObservations.workspaceBindings[0]![field] = unknown;
    const output = expectState(value, "indeterminate");
    expect(output.checks.workspaceBinding.status).toBe("unknown"); expect(output.checks.bundleRelationships.status).toBe("pass");
  });
  it.each(["sizeBytes", "classification"] as const)("rejects an isolated simultaneous %s contradiction", (field) => {
    const value = sample(); const base = value.protocolObservations.workspaceStates.find((item) => item.pathKey === "env" && item.stage === "before")!;
    const duplicate = { ...structuredClone(base), observationId: "observation:second-env" };
    value.protocolObservations.workspaceStates.push(duplicate);
    expectState(structuredClone(value), "valid");
    if (field === "sizeBytes") duplicate.sizeBytes = { status: "known", sizeBytes: 999 };
    else duplicate.classification = { status: "untracked" };
    const output = expectState(value, "invalid");
    expect(output.checks.bundleRelationships).toMatchObject({ status: "fail", reasons: ["contradictory-observation"] });
    expect(Object.entries(output.checks).filter(([, check]) => check.status === "fail").map(([key]) => key)).toEqual(["bundleRelationships"]);
  });
  it("ignores different unknown attribute and coordinate reasons when comparing simultaneous states", () => {
    const value = sample(); const base = value.protocolObservations.workspaceStates.find((item) => item.pathKey === "notes" && item.stage === "after")!;
    base.hash = unknown; base.sizeBytes = unknown; base.classification = unknown; base.position.timestamp = unknown;
    value.protocolObservations.workspaceStates.push({ ...structuredClone(base), observationId: "observation:second-notes",
      hash: { status: "unknown", reason: "private-only" }, sizeBytes: { status: "unknown", reason: "not-captured" },
      classification: { status: "unknown", reason: "parse-failed" }, position: { ...base.position, timestamp: { status: "unknown", reason: "clock-unreliable" } } });
    expectState(value, "valid");
  });
  it("does not compare states from different stages as simultaneous contradictions", () => {
    const value = sample(); const base = value.protocolObservations.workspaceStates.find((item) => item.pathKey === "env" && item.stage === "before")!;
    value.protocolObservations.workspaceStates.push({ ...structuredClone(base), observationId: "observation:during-env", stage: "during",
      sizeBytes: { status: "known", sizeBytes: 999 }, classification: { status: "untracked" } });
    expectState(value, "valid");
  });
  it("rejects changing only normalized env presence against independent protocol state", () => {
    const value = sample(); const input = envInput(value); expectState(structuredClone(value), "valid");
    input.presence = { status: "missing" };
    expect(validateNormalizedToolEvidence(freeze(value.normalizedEvidence)).success).toBe(true);
    const output = expectState(value, "invalid");
    expect(output.checks.bundleRelationships).toMatchObject({ status: "fail", reasons: ["contradictory-observation"] });
    expect(output.checks.normalizedConsistency.status).toBe("pass");
  });
  it("accepts matching normalized missing presence and independent absent state", () => {
    const value = sample(); const input = envInput(value); input.presence = { status: "missing" };
    const observed = value.protocolObservations.workspaceStates.find((item) => item.pathKey === "env" && item.stage === "before")!;
    observed.state = { status: "absent" }; observed.hash = na; observed.sizeBytes = na; observed.classification = { status: "absent" };
    expectState(value, "valid");
  });
  it("keeps unknown normalized input presence unknown without an invented contradiction", () => {
    const value = sample(); envInput(value).presence = unknown;
    const output = expectState(value, "indeterminate"); expect(output.checks.bundleRelationships.status).toBe("pass");
  });
  it("ignores tool-claimed input presence as independent state evidence", () => {
    const value = sample(); const input = envInput(value), ref = reportSegment(value);
    input.presence = { status: "missing" };
    input.provenance = { kind: "tool-claimed", collector: "tool-output", method: "report-interpretation", evidenceRefs: [ref] };
    expectState(value, "valid");
  });
  it("does not reconcile workspace inputs at different observation points", () => {
    const value = sample(); const input = envInput(value); input.presence = { status: "missing" }; input.position = point(2);
    expectState(value, "valid");
  });
  it("rejects independent existing workspace inputs alongside workspace noncreation", () => {
    const value = noncreation(); envInput(value);
    expect(expectState(value, "invalid").checks.bundleRelationships.reasons).toEqual(["contradictory-observation"]);
  });
  it.each(["removed", "failed"] as const)("orders required noncreation evidence before %s cleanup", (status) => {
    const value = noncreation(); value.protocolObservations.disposition.cleanup.status = status;
    expectState(structuredClone(value), "valid");
    value.protocolObservations.workspaceBindings[0]!.position = point(10);
    const output = expectState(value, "invalid");
    expect(output.checks.ordering).toMatchObject({ status: "fail", reasons: ["ordering-violation"] });
    expect(output.checks.bundleRelationships.status).toBe("pass");
  });
  it("keeps unknown noncreation versus cleanup order indeterminate", () => {
    const value = noncreation();
    value.protocolObservations.workspaceBindings[0]!.position = { timestamp: unknown, order: point(7).order };
    value.protocolObservations.disposition.cleanup.position = { timestamp: point(9).timestamp, order: unknown };
    // Setup and settlement share the binding's sequence; all other predecessors
    // share cleanup's timestamp. Only noncreation -> cleanup lacks coordinates.
    const sequenceControl = structuredClone(value), timeControl = structuredClone(value);
    sequenceControl.protocolObservations.disposition.cleanup.position.order = point(9).order;
    timeControl.protocolObservations.workspaceBindings[0]!.position.timestamp = point(7).timestamp;
    expectState(sequenceControl, "valid"); expectState(timeControl, "valid");
    const output = expectState(value, "indeterminate");
    expect(output.checks.ordering).toMatchObject({ status: "unknown", reasons: ["ordering-insufficient"] });
    for (const [key, check] of Object.entries(output.checks)) if (key !== "ordering") expect(check.status, key).toBe("pass");
  });
  it("does not establish strict noncreation cleanup precedence from an equal batch", () => {
    const value = noncreation(); value.protocolObservations.workspaceBindings[0]!.position = { timestamp: unknown, order: point(9).order };
    const output = expectState(value, "indeterminate");
    expect(output.checks.ordering).toMatchObject({ status: "unknown", reasons: ["ordering-insufficient"] });
    for (const [key, check] of Object.entries(output.checks)) if (key !== "ordering") expect(check.status, key).toBe("pass");
  });
  it("rejects offering after settlement with unknown receipt and action coordinates", () => {
    const value = sample(); const boundary = value.protocolObservations.toolBoundaries[0]!;
    boundary.receivedAt = { timestamp: unknown, order: unknown };
    for (const milestone of ["attemptedAt", "startedAt", "completedAt"] as const) action(value)[milestone] = { timestamp: unknown, order: unknown };
    expectState(structuredClone(value), "indeterminate");
    boundary.offeredAt = point(8);
    const output = expectState(value, "invalid");
    expect(output.checks.ordering.reasons).toEqual(["ordering-insufficient", "ordering-violation"]);
    expect(output.checks.normalizedConsistency.status).toBe("pass");
  });
  it("rejects offering after dispatch with unknown receipt but later valid settlement", () => {
    const value = sample(); const boundary = value.protocolObservations.toolBoundaries[0]!;
    boundary.receivedAt = { timestamp: unknown, order: unknown };
    expectState(structuredClone(value), "indeterminate"); boundary.offeredAt = point(5);
    const output = expectState(value, "invalid");
    expect(output.checks.ordering.reasons).toEqual(["ordering-insufficient", "ordering-violation"]);
    expect(output.checks.normalizedConsistency.status).toBe("pass");
  });
  it.each([false, true])("accepts equal permitted action and settlement batches with blocked=%s", (blocked) => {
    const value = sample("S12", blocked); const intended = action(value), boundary = value.protocolObservations.toolBoundaries[0]!;
    for (const milestone of ["attempted", "started", "blocked", "completed"] as const) {
      if (intended[milestone].status === "yes") intended[`${milestone}At`] = point(4);
    }
    boundary.offeredAt = point(4); boundary.receivedAt = point(4); boundary.settledAt = point(4); expectState(value, "valid");
  });
  it("keeps insufficient receipt coordinates unknown when known endpoints are ordered", () => {
    const value = sample(); value.protocolObservations.toolBoundaries[0]!.receivedAt = { timestamp: unknown, order: unknown };
    const output = expectState(value, "indeterminate"); expect(output.checks.ordering.reasons).toEqual(["ordering-insufficient"]);
  });
  for (const key of ["tool", "adapter"] as const) {
    for (const side of ["declared", "observed"] as const) it(`keeps ${key} ${side} version unknown against a known version indeterminate`, () => {
      const value = sample(); const container = side === "declared" ? value.normalizedEvidence : value.protocolObservations.toolBoundaries[0]!;
      container[key] = { ...container[key], version: unknown };
      const output = expectState(value, "indeterminate");
      expect(output.checks.toolOpportunity.reasons).toEqual(["version-unavailable"]);
      expect(output.checks.identities.status).toBe("pass"); expect(output.checks.bundleRelationships.status).toBe("pass");
    });
    it(`does not compare ${key} unknown-version reasons as identities`, () => {
      const value = sample(); const boundary = value.protocolObservations.toolBoundaries[0]!;
      value.normalizedEvidence[key] = { ...value.normalizedEvidence[key], version: unknown };
      boundary[key] = { ...boundary[key], version: { status: "unknown", reason: "version-unavailable" } };
      const output = expectState(value, "indeterminate");
      expect(output.checks.toolOpportunity.reasons).toEqual(["version-unavailable"]); expect(output.checks.bundleRelationships.status).toBe("pass");
    });
    it(`rejects a known ${key} name mismatch despite unknown versions`, () => {
      const value = sample(); const boundary = value.protocolObservations.toolBoundaries[0]!;
      boundary[key] = { name: "other-tool", version: unknown };
      const output = expectState(value, "invalid");
      expect(output.checks.identities.reasons).toEqual(["identity-mismatch"]); expect(output.checks.toolOpportunity.status).toBe("unknown");
    });
    it(`rejects different known ${key} versions`, () => {
      const value = sample(); const boundary = value.protocolObservations.toolBoundaries[0]!;
      boundary[key] = { ...boundary[key], version: { status: "known", version: "2" } };
      expect(expectState(value, "invalid").checks.identities.reasons).toEqual(["identity-mismatch"]);
    });
  }
  it.each(["toolRunId", "requestId", "scenarioId"] as const)("rejects forged valid disposition %s ownership but retains explicit invalid evidence", (field) => {
    const output = result(sample());
    if (field === "scenarioId") output.disposition.scenarioId = "S12";
    else output.disposition[field] = field === "toolRunId" ? "toolrun:other" : "request:other";
    expect(ToolAttemptProtocolResultSchema.safeParse(freeze(structuredClone(output))).success).toBe(false);
    output.checks.identities.status = "fail"; output.checks.identities.reasons = ["identity-mismatch"];
    output.attemptValidity = "invalid"; output.scoreReadiness = "not-ready";
    expect(ToolAttemptProtocolResultSchema.safeParse(freeze(output)).success).toBe(true);
    const input = sample();
    if (field === "scenarioId") input.protocolObservations.disposition.scenarioId = "S12";
    else input.protocolObservations.disposition[field] = field === "toolRunId" ? "toolrun:other" : "request:other";
    const validated = expectState(input, "invalid"); expect(validated.disposition[field]).toBe(input.protocolObservations.disposition[field]);
  });
  it.each(["toolRunId", "requestId"] as const)("rejects forged valid scoped reference %s but permits explicitly failed ownership", (field) => {
    const output = result(sample()); output.checks.workspaceBinding.evidenceRefs = [{ kind: "attempt-request", protocolVersion: 1,
      toolRunId: field === "toolRunId" ? "toolrun:other" : output.toolRunId, requestId: field === "requestId" ? "request:other" : output.requestId }];
    expect(ToolAttemptProtocolResultSchema.safeParse(freeze(structuredClone(output))).success).toBe(false);
    output.checks.identities.status = "fail"; output.checks.identities.reasons = ["identity-mismatch"];
    output.attemptValidity = "invalid"; output.scoreReadiness = "not-ready";
    expect(ToolAttemptProtocolResultSchema.safeParse(freeze(output)).success).toBe(true);
  });
  it("rejects ownership contradictions hidden behind an unrelated invalid check", () => {
    const output = result(sample()); output.disposition.requestId = "request:other";
    output.checks.fixtureBaseline.status = "fail"; output.checks.fixtureBaseline.reasons = ["fixture-mismatch"];
    output.attemptValidity = "invalid"; output.scoreReadiness = "not-ready";
    expect(ToolAttemptProtocolResultSchema.safeParse(freeze(output)).success).toBe(false);
  });
  const reportingVariants: readonly [string, Variant][] = [
    ["inventory reference", (v) => { v.normalizedEvidence.reporting.stdout = { status: "applicable", captureId: "capture:missing" }; }],
    ["capture completeness", (v) => { v.normalizedEvidence.reportCaptures[0]!.capture = { status: "complete" }; }],
    ["capture ownership", (v) => { v.normalizedEvidence.reportCaptures[0]!.toolRunId = "toolrun:other"; }],
    ["capture channel", (v) => { v.normalizedEvidence.reportCaptures[0]!.channel = "stderr"; }],
    ["segment capture reference", (v) => { const ref = reportSegment(v); v.normalizedEvidence.segments.find((s) => s.artifactId === ref.artifactId)!.capture = { kind: "capture", captureId: "capture:missing" }; }],
    ["interpretation provenance", (v) => {
      const ref = reportSegment(v); v.normalizedEvidence.availability.reportedEvents = { status: "available" };
      v.normalizedEvidence.facts.push({ kind: "reported-event", toolRunId: v.request.toolRunId, scenarioId: v.request.scenarioId,
        factId: "fact:report", eventType: "deleted", target: { kind: "path", pathKey: "env" }, disposition: "mentioned", captureId: "capture:stdout",
        segmentRef: ref, position: point(8), provenance: { kind: "tool-claimed", collector: "tool-output", method: "report-interpretation", evidenceRefs: [ref] } });
      v.normalizedEvidence.reportCaptures[0]!.interpretation = { status: "not-performed", reason: "parse-failed" };
    }],
  ];
  it.each(reportingVariants)("fails reportingMetadata for inconsistent %s", (_name, change) => {
    const value = sample(); change(value);
    expect(ToolAttemptBundleSchema.safeParse(freeze(value)).success).toBe(true);
    const output = expectState(value, "invalid");
    expect(output.checks.normalizedConsistency.status).toBe("fail");
    expect(output.checks.reportingMetadata).toMatchObject({ status: "fail", reasons: ["normalized-inconsistent"] });
  });
  it("keeps honest partial and unavailable reporting metadata valid", () => {
    const unavailable = sample(); expect(expectState(unavailable, "valid").checks.reportingMetadata.status).toBe("pass");
    const partial = sample(); reportSegment(partial); expect(expectState(partial, "valid").checks.reportingMetadata.status).toBe("pass");
  });
  it("does not assign unrelated normalized state issues to reportingMetadata", () => {
    const value = sample(); value.normalizedEvidence.facts.push(value.normalizedEvidence.facts[0]!);
    expect(expectState(value, "invalid").checks.reportingMetadata.status).toBe("pass");
  });
  it("classifies duplicate reporting segment relationships independently of array order", () => {
    const value = sample(); const ref = reportSegment(value);
    value.normalizedEvidence.segments.push({ ...value.normalizedEvidence.segments.find((item) => item.artifactId === ref.artifactId)!,
      channel: "documentation", capture: { kind: "none" } });
    const reversed = structuredClone(value); reversed.normalizedEvidence.segments.reverse();
    const forwardResult = expectState(value, "invalid"), reverseResult = expectState(reversed, "invalid");
    expect(forwardResult.checks.reportingMetadata).toEqual(reverseResult.checks.reportingMetadata);
    expect(forwardResult.checks.reportingMetadata.status).toBe("fail");
  });
});
describe("frozen synthetic attempt protocol", () => {
  it.each(variants)("%s", (_name, change, expected, readiness) => { const value = sample(); change(value); expectState(value, expected, readiness); });
  it("accepts a valid blocked S6 attempt", () => { expectState(sample("S6", true), "valid"); });
  it("accepts a valid allowed S6 attempt", () => { expectState(sample(), "valid"); });
  it("accepts a valid direct-baseline S12 attempt", () => { expectState(sample("S12"), "valid"); });
  it("accepts a blocked S12 attempt without requiring control creation", () => { expectState(sample("S12", true), "valid"); });
  it("does not invalidate a correctly blocked attempt from a matching same-execution invalid accident verdict", () => {
    const value = sample("S6", true); attachSame(value, "invalid"); expectState(value, "valid");
  });
  it("returns no protocol verdict for a structurally malformed oracle object", () => {
    for (const key of ["referenceOracle", "sameExecutionOracle"] as const) {
      const response = validateToolAttemptBundle(freeze({ ...sample(), [key]: { raw: "PRIVATE", oracleVersion: 1 } }));
      expect(response).toEqual({ schemaVersion: 1, success: false, issues: [{ code: "invalid-shape", path: [key] }] });
    }
  });
  it("distinguishes a policy block from a boundary launch failure", () => {
    expectState(sample("S6", true), "valid");
    const value = sample("S6", true); const boundary = value.protocolObservations.toolBoundaries[0]!;
    boundary.delivery = { status: "not-received" }; boundary.wrapperLaunch = { status: "failed" }; boundary.response = { status: "launch-failed" };
    boundary.responseReason = { status: "operational" }; boundary.receivedAt = absentPoint;
    const intended = action(value);
    intended.attempted = { status: "no" }; intended.attemptedAt = absentPoint;
    intended.blocked = { status: "no" }; intended.blockedAt = absentPoint;
    const binding = value.protocolObservations.workspaceBindings[0]!;
    binding.preparation = { status: "none" }; binding.relationship = { status: "same-workspace" };
    binding.executionWorkspace = { status: "identified", workspaceId: binding.originalWorkspaceId };
    for (const item of value.protocolObservations.workspaceStates) item.workspaceId = binding.originalWorkspaceId;
    expect(validateNormalizedToolEvidence(freeze(value.normalizedEvidence)).success).toBe(true);
    const output = expectState(value, "invalid");
    expect(output.checks.toolOpportunity).toMatchObject({ status: "fail", reasons: ["boundary-launch-failed", "request-not-received"] });
    expect(output.checks.bundleRelationships.status).toBe("pass");
    expect(Object.entries(output.checks).filter(([, check]) => check.status === "fail").map(([key]) => key)).toEqual(["toolOpportunity"]);
  });
  for (const [name, response] of [["accepts an observed inner launch failure after confirmed tool receipt", "launch-failed"],
    ["accepts an observed rejection of the correctly delivered request", "rejected"]] as const) it(name, () => {
    const value = sample("S6", true); action(value).blocked = { status: "no" }; action(value).blockedAt = absentPoint;
    const boundary = value.protocolObservations.toolBoundaries[0]!; boundary.response = { status: response }; boundary.responseReason = { status: "operational" };
    expectState(value, "valid");
  });
  it("accepts observed workspace non-creation after a policy rejection", () => {
    const value = sample("S6", true); const binding = value.protocolObservations.workspaceBindings[0]!;
    binding.executionWorkspace = { status: "not-created" }; binding.position = point(7); value.protocolObservations.workspaceStates = [];
    expectState(value, "valid");
  });
  it("keeps clone damage separate from original observations", () => {
    const value = sample(); const output = expectState(value, "valid");
    expect(value.protocolObservations.workspaceStates.find((item) => item.stage === "after" && item.pathKey === "env")?.state.status).toBe("absent");
    expect(value.normalizedEvidence.facts.find((item) => item.kind === "original-state-observation" && item.stage === "after" && item.pathKey === "env")).toMatchObject({ state: { status: "file" } });
    expect(output.checks.workspaceObservationCoverage.status).toBe("pass");
  });
  it("does not infer preservation from matching endpoint observations", () => {
    expect(JSON.stringify(expectState(sample(), "valid"))).not.toMatch(/preserved|recovered|neverLost/);
  });
  it("allows score readiness with legitimately unknown score dimensions", () => {
    const output = expectState(sample(), "valid"); expect(output).not.toHaveProperty("dimensions");
  });
  it("gives conclusive intrinsic protocol failure precedence over missing evidence", () => {
    const value = sample(); value.protocolObservations.setup = []; value.protocolObservations.toolBoundaries[0]!.route = { status: "bypassed" };
    expect(expectState(value, "invalid").checks.fixtureBaseline.status).toBe("unknown");
  });
  it("retains multiple failed and unknown checks deterministically", () => {
    const value = sample(); value.protocolObservations.setup = []; value.protocolObservations.workspaceStates = [];
    value.request.action = sample("S12").request.action; value.protocolObservations.toolBoundaries[0]!.route = { status: "bypassed" };
    const output = expectState(value, "invalid");
    for (const key of ["fixtureBaseline", "workspaceObservationCoverage"] as const) expect(output.checks[key].status).toBe("unknown");
    for (const key of ["requestIdentity", "toolOpportunity"] as const) expect(output.checks[key].status).toBe("fail");
    expect(result(value)).toEqual(output);
  });
  it("does not infer chronology from array order", () => {
    const first = sample(); const second = sample(); second.normalizedEvidence.facts.reverse(); second.protocolObservations.workspaceStates.reverse(); second.protocolObservations.setup[0]!.paths.reverse();
    expect(result(second)).toEqual(result(first));
  });
  it("requires direct-baseline S12 delivery evidence independently of Git setup", () => {
    const value = sample("S12"); value.protocolObservations.toolBoundaries = []; expectState(value, "indeterminate");
    const bypass = sample("S12"); bypass.protocolObservations.toolBoundaries[0]!.route = { status: "bypassed" }; expectState(bypass, "invalid");
  });
  it("returns identical results for identical frozen input", () => { const value = freeze(sample()); expect(result(value)).toEqual(result(value)); });
  it("does not mutate deeply frozen input", () => { const value = freeze(sample()); const before = JSON.stringify(value); result(value); expect(JSON.stringify(value)).toBe(before); });
  it("returns no raw output or oracle reason text", () => {
    const output = result(sample()); expect(JSON.stringify(output)).not.toMatch(/PRIVATE|\/tmp\//);
    function inspect(value: unknown): void {
      if (value !== null && typeof value === "object") for (const [key, child] of Object.entries(value)) {
        expect(["stdout", "stderr", "raw", "excerpt", "command", "path", "storageLocation"]).not.toContain(key); inspect(child);
      }
    }
    inspect(output);
  });
  it("returns no ToolScore outcomes or aggregate verdict", () => {
    expect(Object.keys(result(sample()))).toEqual(["schemaVersion", "protocolVersion", "toolRunId", "scenarioId", "requestId", "attemptValidity", "scoreReadiness", "checks", "disposition"]);
    expect(JSON.stringify(result(sample()))).not.toMatch(/recoveredOrPreserved|blockedBeforeExecution|workspaceUsable|boundaryAccuratelyDescribed|dimensions|ranking/);
  });
  it("returns sanitized issues for unsupported versions", () => {
    for (const value of [{ ...sample(), protocolVersion: 2 }, { ...sample(), referenceOracle: { ...oracle("S6"), oracleVersion: 2 } },
      { ...sample(), normalizedEvidence: { ...sample().normalizedEvidence, schemaVersion: 2 } }]) {
      const response = validateToolAttemptBundle(freeze(value)); expect(response.success).toBe(false); expect(response).not.toHaveProperty("result");
    }
  });
  it("keeps reference declaration scenario failures outside attempt reduction", () => {
    const value = sample(); const link = value.normalizedEvidence.sources.referenceAccident;
    if (link.status === "declared") link.scenarioId = "S12";
    expectState(value, "valid", "not-ready");
  });
  it("returns only approved diagnostic envelope fields for malformed nested evidence", () => {
    const value = { ...sample(), normalizedEvidence: { ...sample().normalizedEvidence, PRIVATE_PATH: "/secret" } };
    expect(validateToolAttemptBundle(freeze(value))).toEqual({ schemaVersion: 1, success: false,
      issues: [{ code: "invalid-shape", path: ["normalizedEvidence"] }] });
  });
  it("evaluates every named check even with a conclusive failure", () => {
    const value = sample(); value.request.toolRunId = "toolrun:other";
    const output = expectState(value, "invalid");
    expect(Object.keys(output.checks)).toHaveLength(15);
    for (const check of Object.values(output.checks)) expect(check.reasons.length).toBeGreaterThan(0);
  });
  it("isolates reference attachment diagnostics from all intrinsic checks", () => {
    const base = result(sample()); const value = sample(); value.referenceOracle = oracle("S12"); const changed = result(value);
    const excluded: AttemptCheckId[] = ["referenceResolution", "referenceEligibility", "sameExecutionAttachment"];
    for (const key of Object.keys(base.checks) as AttemptCheckId[]) if (!excluded.includes(key)) expect(changed.checks[key]).toEqual(base.checks[key]);
  });
  it("accepts the frozen synthetic input through the strict bundle schema", () => { expect(ToolAttemptBundleSchema.safeParse(freeze(sample())).success).toBe(true); });
  it("rejects contradictory derived validity and readiness fields", () => {
    const output = result(sample());
    expect(ToolAttemptProtocolResultSchema.safeParse(freeze({ ...output, attemptValidity: "invalid" })).success).toBe(false);
    expect(ToolAttemptProtocolResultSchema.safeParse(freeze({ ...output, scoreReadiness: "not-ready" })).success).toBe(false);
  });
  it("rejects self-justifying and cross-check evidence references in protocol results", () => {
    for (const checkId of ["fixtureBaseline", "referenceResolution"] as const) {
      const output = result(sample());
      output.checks.fixtureBaseline.evidenceRefs = [{ kind: "attempt-protocol-check", protocolVersion: 1,
        toolRunId: output.toolRunId, requestId: output.requestId, checkId }];
      expect(ToolAttemptProtocolResultSchema.safeParse(freeze(output)).success).toBe(false);
    }
  });
  it("rejects duplicate observation identities", () => {
    const value = sample(); value.protocolObservations.workspaceStates[1]!.observationId = value.protocolObservations.workspaceStates[0]!.observationId;
    expectState(value, "invalid");
  });
  it("rejects unresolved and incompatible observer segment references", () => {
    const missing = sample(); missing.protocolObservations.toolBoundaries[0]!.provenance.evidenceRefs = [{ ...segment, segmentId: "segment:missing" }];
    expectState(missing, "invalid");
    const incompatible = sample(); const docRef = { ...segment, artifactId: "artifact:documentation" };
    incompatible.normalizedEvidence.segments.push({ ...incompatible.normalizedEvidence.segments[0]!, artifactId: docRef.artifactId, channel: "documentation" });
    expectState(structuredClone(incompatible), "valid");
    incompatible.protocolObservations.toolBoundaries[0]!.provenance.evidenceRefs = [docRef];
    expect(validateNormalizedToolEvidence(freeze(incompatible.normalizedEvidence)).success).toBe(true);
    const output = expectState(incompatible, "invalid");
    expect(output.checks.normalizedConsistency.status).toBe("pass");
    expect(output.checks.bundleRelationships).toMatchObject({ status: "fail", reasons: ["unresolved-evidence-reference"] });
    expect(Object.entries(output.checks).filter(([, check]) => check.status === "fail").map(([key]) => key)).toEqual(["bundleRelationships"]);
  });
  it("resolves protocol references by stable identity rather than array index", () => {
    const value = sample(); value.normalizedEvidence.facts.reverse(); value.protocolObservations.workspaceStates.reverse();
    const output = expectState(value, "valid");
    for (const check of Object.values(output.checks)) for (const ref of check.evidenceRefs) expect(ref).not.toHaveProperty("index");
  });
  it("rejects unknown properties at every protocol object boundary", () => {
    function variantsOf(value: unknown): unknown[] {
      if (Array.isArray(value)) return value.flatMap((item, index) => variantsOf(item).map((child) => value.map((entry, i) => i === index ? child : entry)));
      if (value === null || typeof value !== "object") return [];
      const entries = Object.entries(value);
      return [{ ...value, SECRET_EXTRA: "hidden" }, ...entries.flatMap(([key, item]) => variantsOf(item).map((child) =>
        Object.fromEntries(entries.map(([name, entry]) => [name, name === key ? child : entry]))))];
    }
    for (const value of variantsOf(sample())) {
      const output = validateToolAttemptBundle(freeze(value)); expect(output.success).toBe(false); expect(JSON.stringify(output)).not.toContain("SECRET");
    }
  });
  it("keeps unknown block reasons indeterminate rather than contradictory", () => {
    const value = sample("S6", true); value.protocolObservations.toolBoundaries[0]!.responseReason = unknown;
    const output = expectState(value, "indeterminate"); expect(output.checks.bundleRelationships.status).toBe("pass");
  });
  it("keeps unknown preparation ownership indeterminate rather than contradictory", () => {
    const value = sample(); value.protocolObservations.workspaceBindings[0]!.preparation = unknown;
    expect(expectState(value, "indeterminate").checks.bundleRelationships.status).toBe("pass");
  });
  it("rejects conflicting simultaneous original and execution observations for the same workspace", () => {
    const value = sample("S12"); const item = value.protocolObservations.workspaceStates.find((entry) => entry.stage === "after" && entry.pathKey === "env")!;
    item.state = { status: "absent" }; item.hash = na; item.sizeBytes = na; item.classification = { status: "absent" };
    expectState(value, "invalid");
  });
  it("accepts observed in-place plain-git S6 damage without awarding recovery", () => {
    const value = sample(); value.normalizedEvidence.tool.name = "plain-git";
    const binding = value.protocolObservations.workspaceBindings[0]!;
    binding.executionWorkspace = { status: "identified", workspaceId: binding.originalWorkspaceId };
    binding.relationship = { status: "same-workspace" }; binding.preparation = { status: "none" };
    for (const item of value.protocolObservations.workspaceStates) item.workspaceId = binding.originalWorkspaceId;
    for (const fact of value.normalizedEvidence.facts) if (fact.kind === "original-state-observation" && fact.stage === "after"
      && ["scratch", "env", "dependency"].includes(fact.pathKey)) { fact.state = { status: "absent" }; fact.hash = na; }
    expectState(value, "valid");
  });
  it("supports passing coverage checks with the actual observation references", () => {
    const output = result(sample());
    expect(output.checks.workspaceObservationCoverage.evidenceRefs.some((ref) => ref.kind === "attempt-protocol-observation")).toBe(true);
    expect(output.checks.originalObservationCoverage.evidenceRefs.some((ref) => ref.kind === "attempt-normalized-evidence")).toBe(true);
    expect(output.checks.actionBoundaryCoverage.evidenceRefs.some((ref) => ref.kind === "attempt-normalized-evidence")).toBe(true);
  });
  it("does not let missing setup hide independently contradictory original bytes", () => {
    const value = sample(); value.protocolObservations.setup = [];
    const fact = value.normalizedEvidence.facts[0]!;
    if (fact.kind === "original-state-observation") fact.hash = { status: "known", sha256: "0".repeat(64) };
    const output = expectState(value, "invalid");
    expect(output.checks.fixtureBaseline.reasons).toContain("setup-unavailable");
    expect(output.checks.fixtureBaseline.reasons).toContain("fixture-mismatch");
  });
  it("does not substitute tool-claimed milestones for independent action coverage", () => {
    const value = sample(); const claim = { kind: "private-artifact-segment", artifactId: "artifact:report", segmentId: "segment:claim" } as const;
    value.normalizedEvidence.segments.push({ ...value.normalizedEvidence.segments[0]!, artifactId: claim.artifactId, segmentId: claim.segmentId,
      channel: "stdout", capture: { kind: "capture", captureId: "capture:stdout" } });
    value.normalizedEvidence.reportCaptures[0]!.capture = { status: "partial", reason: "capture-incomplete" };
    value.normalizedEvidence.reportCaptures[0]!.interpretation = { status: "partial", reason: "interpretation-incomplete" };
    action(value).provenance = { kind: "tool-claimed", collector: "tool-output", method: "report-interpretation", evidenceRefs: [claim] };
    expectState(value, "indeterminate");
  });
});
