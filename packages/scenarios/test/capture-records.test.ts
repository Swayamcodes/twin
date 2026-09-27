import { describe, expect, it } from "vitest";
import { AttemptCaptureSchema, CaptureSchema, CompleteCaptureSchema, CompleteReferenceOnlySchema,
  CompleteReferenceAttemptSchema, IncompleteInspectionSchema, LIMITS, ManifestSchema, OutcomeSchema,
  PrivateRawReferenceSchema, RawCommandSchema, RawCleanupSchema, RawPathSchema, ReservationSchema, StreamSchema,
  incomplete, incompleteIssues, parseCaptureRecords, StreamBytesSchema, type CompleteCapture, type AttemptCapture } from "../src/capture/records.js";
import type { ScenarioRunResult } from "../src/types.js";

function freeze<T>(value: T): T { if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }
const header = { privateFormatVersion: 1, normalizerVersion: 1, artifactId: "artifact:test" } as const;
const absent = { status: "not-started", reason: "reference-invalid" } as const;
const command = { command: { executable: "", args: [""] }, cwd: "", stdout: "", stderr: "", exitCode: null,
  signal: null, spawnError: "", streamErrors: [{ stream: "stdout", error: "" }, { stream: "stderr", error: "" }],
  startedAt: "2026-09-27T00:00:02.000Z", endedAt: "2026-09-27T00:00:01.000Z", durationMs: 0 } as const;
const raw: ScenarioRunResult = freeze({ schemaVersion: 1, scenarioId: "S12", scenarioRoot: "", workspace: null,
  setupCommands: [command], action: command, before: null, after: null, cleanup: { status: "removed", scenarioRoot: "" },
  issues: [{ phase: "action", message: "" }] });
const reservation = { ...header, referenceId: "reference:A", attempt: absent };
const capture = { ...header, reference: { referenceId: "reference:A", raw,
  context: { schemaVersion: 1, scenarioId: "S12", s12Action: { executable: "/private/node", scriptPath: "/private/action" } } }, attempt: absent };
const outcome = { ...header, attempt: absent, errors: [] };
const complete = freeze({ privateFormatVersion: 1, normalizerVersion: 1, kind: "reference-only", reservation, capture, outcome });
function attemptRecord(): CompleteCapture {
  const unknown = { status: "unknown", reason: "not-observed" } as const, na = { status: "unknown", reason: "not-applicable" } as const;
  const position = { timestamp: unknown, order: unknown };
  const scope = { toolRunId: "toolrun:B", requestId: "request:B", scenarioId: "S12" } as const;
  const observer = { kind: "private-artifact-segment", artifactId: header.artifactId, segmentId: "segment:observer" } as const;
  const fs = { kind: "independent", collector: "external-observer", method: "filesystem-observation", evidenceRefs: [observer] } as const;
  const proc = { ...fs, method: "process-observation" } as const;
  const request = { ...scope, schemaVersion: 1 as const, requestVersion: 1 as const, fixtureId: "s12-s6-fixture-v1" as const,
    action: { actionId: "create-control-file" as const, actionVersion: 1 as const, target: "control" as const, purpose: "harmless-control" as const,
      operation: "exclusive-create" as const, contentId: "s12-control-bytes-v1" as const } };
  const record = { request, toolVersion: unknown, observerSegmentId: observer.segmentId, startedAt: unknown, endedAt: unknown,
    stdout: { status: "complete", bytes: { encoding: "base64", data: "", decodedBytes: 0 }, captureId: "capture:stdout", segmentId: "segment:stdout" },
    stderr: { status: "unavailable", reason: "not-captured", captureId: "capture:stderr", segmentId: "segment:stderr" },
    availability: Object.fromEntries(["originalState", "execution", "workspaceInputs", "reportedEvents", "boundaryObservations", "declaredCapabilities"]
      .map((key) => [key, { status: "unavailable", reason: "not-captured" }])),
    events: [{ toolRunId: scope.toolRunId, scenarioId: "S12", factId: "fact:action", kind: "execution", actionId: "create-control-file",
      attempted: { status: "no" }, started: { status: "no" }, completed: { status: "no" }, blocked: { status: "no" },
      attemptedAt: { timestamp: na, order: na }, startedAt: { timestamp: na, order: na }, completedAt: { timestamp: na, order: na },
      blockedAt: { timestamp: na, order: na }, exitCode: na, signal: na, provenance: proc }],
    originalStates: [{ toolRunId: scope.toolRunId, scenarioId: "S12", factId: "fact:original", kind: "original-state-observation",
      pathKey: "env", stage: "before", position, state: { status: "file" }, hash: { status: "known", sha256: "a".repeat(64) }, provenance: fs }],
    workspaceInputs: [], fingerprints: [],
    setup: [{ ...scope, observationId: "observation:setup", position, fixtureId: "s12-s6-fixture-v1", originalWorkspaceId: "workspace:B",
      repository: unknown, nonBare: unknown, rootMatches: unknown, baselineCommit: unknown, indexMatches: unknown, trackedTreeMatches: unknown,
      noExtraEntries: unknown, paths: [{ pathKey: "env", originalFactId: "fact:original", sizeBytes: unknown, classification: unknown }], provenance: fs }],
    workspaceBindings: [{ ...scope, observationId: "observation:binding", position, originalWorkspaceId: "workspace:B", executionWorkspace: unknown,
      relationship: unknown, preparation: unknown, repository: unknown, nonBare: unknown, rootMatches: unknown, provenance: fs }],
    toolBoundaries: [{ ...scope, observationId: "observation:boundary", tool: { name: "direct-baseline", version: unknown },
      adapter: { name: "direct-baseline", version: unknown }, offeredAt: position, receivedAt: position, settledAt: position, route: unknown,
      delivery: unknown, requestBinding: unknown, wrapperLaunch: unknown, response: unknown, responseReason: unknown,
      actionObservation: { status: "known", factId: "fact:action" }, coverage: unknown, provenance: proc }],
    workspaceStates: [{ ...scope, observationId: "observation:workspace", workspaceId: "workspace:B", stage: "during", position,
      pathKey: "env", state: unknown, hash: unknown, sizeBytes: unknown, classification: unknown, provenance: fs }],
    sourceBindings: [{ ...scope, observationId: "observation:source", position, sourceRunId: `sha256:${"a".repeat(64)}`,
      relationship: "same-execution-additional-evidence", provenance: proc }],
  };
  return CompleteCaptureSchema.parse({ ...complete, kind: "reference-plus-attempt",
    reservation: { ...reservation, attempt: { status: "reserved", request } },
    capture: { ...capture, attempt: { status: "captured", record } },
    outcome: { ...outcome, attempt: { status: "collected", toolRunId: scope.toolRunId, requestId: scope.requestId,
      cleanup: { status: "unknown", reason: "not-observed", position, evidenceRefs: [observer] } } } });
}
function record(value: CompleteCapture): AttemptCapture {
  if (value.capture.attempt.status !== "captured") throw new Error("Expected synthetic attempt");
  return value.capture.attempt.record;
}

describe("private retained capture records", () => {
  it("accepts complete reference-only failure records without fabricating an attempt", () => {
    expect(CompleteReferenceOnlySchema.safeParse(complete).success).toBe(true);
    expect(CompleteReferenceAttemptSchema.safeParse(complete).success).toBe(false);
  });
  it("preserves raw empty text, nullability, and reversed wall-clock evidence", () => {
    expect(PrivateRawReferenceSchema.parse(raw)).toEqual(raw);
    expect(RawCommandSchema.parse(command)).toEqual(command);
  });
  it.each(["S12", "S6"])("accepts the raw %s union", (scenarioId) => {
    expect(PrivateRawReferenceSchema.safeParse(freeze({ ...raw, scenarioId, action: null })).success).toBe(true);
  });
  it.each(["removed", "refused", "failed"] as const)("accepts raw cleanup %s and edge values", (status) => {
    const cleanup = status === "removed" ? { status, scenarioRoot: "" } : status === "refused"
      ? { status, scenarioRoot: "", reason: "" } : { status, scenarioRoot: "", reason: "", partialDeletionPossible: true,
        rootAfter: { exists: null, error: "" }, markerAfter: { exists: false, error: null } };
    expect(RawCleanupSchema.safeParse(freeze(cleanup)).success).toBe(true);
    expect(PrivateRawReferenceSchema.safeParse(freeze({ ...raw, cleanup })).success).toBe(true);
  });
  it.each(["absent", "error", "file"] as const)("accepts raw path %s including empty errors and zero size", (state) => {
    const path = state === "file" ? { path: ".env", state, sizeBytes: 0, sha256: "a".repeat(64) }
      : state === "error" ? { path: ".env", state, error: "" } : { path: ".env", state };
    expect(RawPathSchema.safeParse(freeze(path)).success).toBe(true);
    for (const workspace of [null, ""]) for (const isComplete of [false, true]) {
      const snapshot = { workspace, observedAt: command.endedAt, complete: isComplete, paths: [path] };
      expect(PrivateRawReferenceSchema.safeParse(freeze({ ...raw, before: snapshot, after: snapshot })).success).toBe(true);
    }
  });
  it.each(RawCommandSchema.shape.signal.unwrap().options)("accepts raw signal %s", (signal) => {
    expect(RawCommandSchema.safeParse(freeze({ ...command, signal, spawnError: null, exitCode: null })).success).toBe(true);
  });
  it.each([-1, 0, 255])("preserves raw numeric exit %s without narrowing evidence", (exitCode) => {
    expect(RawCommandSchema.safeParse(freeze({ ...command, exitCode, streamErrors: [] })).success).toBe(true);
  });
  it.each(["setup", "before", "action", "after", "cleanup"])("accepts raw issue phase %s with empty text", (phase) => {
    expect(PrivateRawReferenceSchema.safeParse(freeze({ ...raw, issues: [{ phase, message: "" }] })).success).toBe(true);
  });
  it.each(["stdout", "stderr"] as const)("bounds %s UTF-8 byte captures including multibyte text", (channel) => {
    expect(RawCommandSchema.safeParse({ ...command, [channel]: "x".repeat(LIMITS.outputBytes) }).success).toBe(true);
    expect(RawCommandSchema.safeParse({ ...command, [channel]: "x".repeat(LIMITS.outputBytes + 1) }).success).toBe(false);
    expect(RawCommandSchema.safeParse({ ...command, [channel]: "é".repeat(LIMITS.outputBytes) }).success).toBe(false);
  });
  it("bounds error text and private path-like strings while permitting empty strings", () => {
    expect(RawCommandSchema.safeParse({ ...command, cwd: "x".repeat(LIMITS.privateStringBytes + 1) }).success).toBe(false);
    expect(RawCommandSchema.safeParse({ ...command, spawnError: "x".repeat(LIMITS.errorBytes + 1) }).success).toBe(false);
    expect(RawCommandSchema.safeParse({ ...command, spawnError: "x".repeat(LIMITS.errorBytes) }).success).toBe(true);
  });
  it("bounds raw events, observations, argv, stream errors, and outcome errors", () => {
    const invalid = [ { ...raw, setupCommands: Array(LIMITS.events + 1).fill(command) },
      { ...raw, issues: Array(LIMITS.events + 1).fill({ phase: "action", message: "" }) },
      { ...raw, before: { workspace: null, observedAt: command.startedAt, complete: true,
        paths: Array(LIMITS.observations + 1).fill({ path: ".env", state: "absent" }) } } ];
    invalid.forEach((value) => expect(PrivateRawReferenceSchema.safeParse(value).success).toBe(false));
    expect(RawCommandSchema.safeParse({ ...command, command: { executable: "", args: Array(65).fill("") } }).success).toBe(false);
    expect(RawCommandSchema.safeParse({ ...command, streamErrors: Array(65).fill({ stream: "stdout", error: "" }) }).success).toBe(false);
    expect(OutcomeSchema.safeParse({ ...outcome, errors: Array(65).fill({ phase: "reference", message: "" }) }).success).toBe(false);
  });
  it("rejects unsupported versions, unknown fields, and unbounded identifiers", () => {
    for (const [schema, value] of [[ReservationSchema, reservation], [CaptureSchema, capture], [OutcomeSchema, outcome]] as const) {
      for (const addition of [{ privateFormatVersion: 2 }, { normalizerVersion: 2 }, { storagePath: "/private" }, { artifactId: "artifact:" + "x".repeat(129) }]) {
        expect(schema.safeParse({ ...value, ...addition }).success).toBe(false);
      }
    }
  });
  it("rejects identity and variant substitution across the three records", () => {
    expect(CompleteCaptureSchema.safeParse({ ...complete, outcome: { ...outcome, artifactId: "artifact:other" } }).success).toBe(false);
    expect(CompleteCaptureSchema.safeParse({ ...complete, capture: { ...capture, reference: { ...capture.reference, referenceId: "reference:other" } } }).success).toBe(false);
    expect(CompleteCaptureSchema.safeParse({ ...complete, kind: "reference-plus-attempt" }).success).toBe(false);
  });
  it("accepts only closed, bounded stream availability variants", () => {
    for (const value of [{ status: "complete", bytes: { encoding: "base64", data: "", decodedBytes: 0 } },
      { status: "partial", bytes: { encoding: "base64", data: "", decodedBytes: 0 }, reason: "collector-failed" },
      { status: "unavailable", reason: "not-captured" }]) {
      expect(StreamSchema.safeParse({ ...value, captureId: "capture:stdout", segmentId: "segment:stdout" }).success).toBe(true);
    }
    expect(StreamSchema.safeParse({ status: "unavailable", reason: "PRIVATE", captureId: "capture:stdout", segmentId: "segment:stdout" }).success).toBe(false);
  });
  it("requires an exact bounded manifest inventory without duplicate or substituted filenames", () => {
    const inventory = (["reservation.json", "capture.json", "outcome.json"] as const).map((name) => ({ name, sizeBytes: 1, sha256: "a".repeat(64) }));
    const manifestHeader = { ...header, artifactKind: "reference-only-failure", completeness: "complete" };
    expect(ManifestSchema.safeParse({ ...manifestHeader, inventory }).success).toBe(true);
    for (const name of ["reservation.json", "../capture.json", "/capture.json", "other.json"]) {
      expect(ManifestSchema.safeParse({ ...manifestHeader, inventory: [inventory[0], { ...inventory[1], name }, inventory[2]] }).success).toBe(false);
    }
  });
  it("returns only closed sanitized incomplete inspection codes and paths", () => {
    expect(IncompleteInspectionSchema.parse(incomplete("invalid-json", "capture.json"))).toEqual({ privateFormatVersion: 1, normalizerVersion: 1,
      status: "incomplete", retention: "not-retained", issues: [{ code: "invalid-json", path: ["capture.json"] }] });
    expect(IncompleteInspectionSchema.safeParse({ ...incomplete("invalid-record"), rawError: "PRIVATE" }).success).toBe(false);
  });
  it("rejects cyclic envelopes before recursive schema traversal", () => {
    const cycle: { attempt: unknown } = structuredClone(reservation);
    expect(ReservationSchema.safeParse(cycle).success).toBe(true);
    cycle.attempt = cycle;
    const result = ReservationSchema.safeParse(cycle);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues.map(({ code, path }) => ({ code, path })))
      .toEqual([{ code: "custom", path: [] }]);
  });
  it("does not accept authoritative normalized or protocol envelopes as attempt records", () => {
    const value = record(attemptRecord());
    expect(AttemptCaptureSchema.safeParse(freeze(value)).success).toBe(true);
    for (const addition of [{ normalizedEvidence: {} }, { bundle: {} }]) {
      const result = AttemptCaptureSchema.safeParse({ ...value, ...addition });
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.issues.map(({ code, path }) => ({ code, path })))
        .toEqual([{ code: "unrecognized_keys", path: [] }]);
    }
  });
});

describe("private ownership, uniqueness and byte integrity", () => {
  const changes: [string, (a: AttemptCapture) => void][] = [
    ["fact IDs", (a) => {
      a.originalStates[0]!.factId = a.events[0]!.factId;
      a.setup[0]!.paths[0]!.originalFactId = a.originalStates[0]!.factId;
    }],
    ["capture IDs", (a) => { a.stderr.captureId = a.stdout.captureId; }],
    ["segment IDs", (a) => { a.stderr.segmentId = a.observerSegmentId; }],
    ["cross-collection observation IDs", (a) => { a.workspaceStates[0]!.observationId = a.setup[0]!.observationId; }],
    ["tool ownership", (a) => { a.events[0]!.toolRunId = "toolrun:other"; }],
    ["request ownership", (a) => { a.workspaceStates[0]!.requestId = "request:other"; }],
    ["scenario ownership", (a) => { a.originalStates[0]!.scenarioId = "S6"; }],
    ["missing action reference", (a) => { a.toolBoundaries[0]!.actionObservation = { status: "known", factId: "fact:missing" }; }],
    ["missing original reference", (a) => { a.setup[0]!.paths[0]!.originalFactId = "fact:missing"; }],
    ["missing observer reference", (a) => { a.events[0]!.provenance.evidenceRefs[0]!.segmentId = "segment:missing"; }],
    ["artifact ownership", (a) => { a.events[0]!.provenance.evidenceRefs[0]!.artifactId = "artifact:other"; }],
  ];
  it.each(changes)("rejects malformed %s with exact sanitized diagnostics", (_name, mutate) => {
    const value = attemptRecord(); expect(parseCaptureRecords(freeze(structuredClone(value))).success).toBe(true);
    mutate(record(value));
    expect(parseCaptureRecords(freeze(value))).toEqual({ success: false, issues: [{ code: "invalid-record", path: [] }] });
  });
  it.each(["setup", "workspaceBindings", "toolBoundaries", "workspaceStates", "sourceBindings"] as const)
  ("rejects duplicate %s IDs", (key) => {
    const value = attemptRecord(), a = record(value);
    const changed = { ...a, [key]: [...a[key], a[key][0]] };
    if (value.capture.attempt.status === "captured") value.capture.attempt.record = changed;
    expect(parseCaptureRecords(freeze(value))).toEqual({ success: false, issues: [{ code: "invalid-record", path: [] }] });
  });
  it("does not reject duplicate raw A observations intended for oracle interpretation", () => {
    const value = attemptRecord(); value.capture.reference.raw.before = { workspace: null, observedAt: command.startedAt,
      complete: true, paths: [{ path: ".env", state: "absent" }, { path: ".env", state: "error", error: "" }] };
    expect(parseCaptureRecords(freeze(value)).success).toBe(true);
  });
  it("keeps semantic tool bypass failures structurally representable", () => {
    const value = attemptRecord(); record(value).toolBoundaries[0]!.route = { status: "bypassed" };
    expect(parseCaptureRecords(freeze(value)).success).toBe(true);
  });
  it.each([Buffer.alloc(0), Buffer.from("é🙂"), Buffer.from([0, 255, 128, 1, 13, 10]), Buffer.alloc(LIMITS.outputBytes, 255)])
  ("losslessly accepts canonical bounded binary streams %#", (data) => {
    const value = { encoding: "base64", data: data.toString("base64"), decodedBytes: data.length };
    const parsed = StreamBytesSchema.parse(freeze(value)); expect(Buffer.from(parsed.data, "base64")).toEqual(data);
  });
  it("rejects decoded and encoded limit plus one", () => {
    const data = Buffer.alloc(LIMITS.outputBytes + 1);
    const encoded = data.toString("base64");
    expect(encoded.length).toBeLessThanOrEqual(LIMITS.encodedBytes);
    // The declaration is in range; the actual canonical payload exceeds the ceiling.
    // Its exact-length mismatch is necessarily also present with an in-range declaration.
    expect(StreamBytesSchema.safeParse({ encoding: "base64", data: encoded, decodedBytes: LIMITS.outputBytes }).success).toBe(false);
    expect(StreamBytesSchema.safeParse({ encoding: "base64", data: "A".repeat(LIMITS.encodedBytes + 1), decodedBytes: 0 }).success).toBe(false);
  });
  it.each(["Zg", "Zg=", "Zg===", "Zg==\n", "Zg== ", "_w==", "Zh==", "Zm9=", "AA=A", "====", "é==="])
  ("rejects invalid or noncanonical base64 %#", (data) => {
    if (data === "Zm9=") expect(StreamBytesSchema.safeParse({ encoding: "base64", data: "Zm8=", decodedBytes: 2 }).success).toBe(true);
    expect(StreamBytesSchema.safeParse({ encoding: "base64", data, decodedBytes: data === "Zm9=" ? 2 : 1 }).success).toBe(false);
  });
  it("rejects inconsistent decoded size", () => {
    expect(StreamBytesSchema.safeParse({ encoding: "base64", data: "Zg==", decodedBytes: 0 }).success).toBe(false);
  });
  it("bounds issues and deduplicates causal diagnostics deterministically", () => {
    const issue = { code: "write-failed" as const, path: ["capture.json" as const] }, close = { code: "close-failed" as const, path: ["capture.json" as const] };
    expect(incompleteIssues([issue, close, issue]).issues).toEqual([issue, close]);
    expect(IncompleteInspectionSchema.safeParse({ ...incomplete("io-failed"), issues: Array(LIMITS.issues).fill(issue) }).success).toBe(true);
    expect(IncompleteInspectionSchema.safeParse({ ...incomplete("io-failed"), issues: Array(LIMITS.issues + 1).fill(issue) }).success).toBe(false);
  });
});
