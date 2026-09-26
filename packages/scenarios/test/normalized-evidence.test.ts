import * as contract from "@twin-cli/scenarios/contract";
import { describe, expect, it } from "vitest";
import { NormalizedToolEvidenceSchema, NormalizedFactSchema, DeclaredCapabilitySchema, ExecutionSchema,
  OriginalStateObservationSchema, ReportedEventSchema, WorkspaceInputSchema, BoundaryObservationSchema,
  ReportCaptureSchema, PublicSegmentSchema, UnknownSchema, PositionSchema, SignalSchema, ExitCodeSchema,
  validateNormalizedToolEvidence, type NormalizedToolEvidence, type NormalizedFact, type Execution,
  type Position, type PublicSegment, type DeclaredCapability } from "@twin-cli/scenarios/contract";

// Hand-authored synthetic data only. No source producer, runner, or filesystem imports.
function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
const identity = { toolRunId: "toolrun:synthetic", scenarioId: "S6" } as const;
const unknown = { status: "unknown", reason: "not-observed" } as const;
const na = { status: "unknown", reason: "not-applicable" } as const;
const noPosition: Position = freeze({ timestamp: na, order: na });
function point(n: number): Position {
  return freeze({ timestamp: { status: "known", timestamp: `2026-09-25T00:00:0${n}.000Z` }, order: { status: "known", sequence: n } });
}
const observerRef = { kind: "private-artifact-segment", artifactId: "artifact:observer", segmentId: "segment:one" } as const;
const reportRef = { kind: "private-artifact-segment", artifactId: "artifact:report", segmentId: "segment:one" } as const;
const docRef = { kind: "private-artifact-segment", artifactId: "artifact:doc", segmentId: "segment:one" } as const;
const independent = freeze({ kind: "independent", collector: "harness", method: "filesystem-observation", evidenceRefs: [observerRef] } as const);
const claimed = freeze({ kind: "tool-claimed", collector: "tool-output", method: "report-interpretation", evidenceRefs: [reportRef] } as const);
function original(): NormalizedFact & { kind: "original-state-observation" } {
  return freeze({ ...identity, kind: "original-state-observation", factId: "fact:original", pathKey: "env", stage: "before",
    position: point(1), state: { status: "file" }, hash: { status: "known", sha256: "a".repeat(64) },
    provenance: { ...independent, evidenceRefs: [observerRef] } });
}
function execution(): Execution {
  return freeze({ ...identity, kind: "execution", factId: "fact:execution", actionId: "git-clean",
    attempted: { status: "yes" }, started: { status: "no" }, blocked: { status: "yes" }, completed: { status: "no" },
    attemptedAt: point(2), startedAt: noPosition, blockedAt: point(3), completedAt: noPosition,
    exitCode: na, signal: na, provenance: { ...independent, method: "process-observation", evidenceRefs: [observerRef] } });
}
function running(): Execution {
  return freeze({ ...execution(), started: { status: "yes" }, blocked: { status: "no" }, completed: { status: "yes" },
    startedAt: point(3), blockedAt: noPosition, completedAt: point(4), exitCode: { status: "known", exitCode: 0 }, signal: { status: "known", signal: null } });
}
function reported(): NormalizedFact & { kind: "reported-event" } {
  return freeze({ ...identity, kind: "reported-event", factId: "fact:report", eventType: "blocked-action", target: { kind: "none" },
    disposition: "mentioned", captureId: "capture:stdout", segmentRef: reportRef, position: point(4),
    provenance: { ...claimed, evidenceRefs: [reportRef] } });
}
function workspace(): NormalizedFact & { kind: "workspace-input" } {
  return freeze({ ...identity, kind: "workspace-input", factId: "fact:input", pathKey: "env", actionId: "git-clean", phase: "pre-action",
    requirement: "readable-file", presence: { status: "present" }, usability: { status: "usable" }, position: point(1),
    provenance: { ...independent, evidenceRefs: [observerRef] } });
}
function boundary(): NormalizedFact & { kind: "boundary-observation" } {
  return freeze({ ...identity, kind: "boundary-observation", factId: "fact:boundary", scope: "ignored", aspect: "reporting",
    target: { kind: "path", pathKey: "env" }, behavior: { status: "unreported" }, position: point(5), captureIds: ["capture:stdout"],
    provenance: { ...claimed, evidenceRefs: [reportRef] } });
}
function capability(): DeclaredCapability {
  return freeze({ ...identity, capabilityId: "capability:one", statementId: "statement:ignored:v1", scope: "ignored",
    aspect: "workspace-inclusion", target: { kind: "none" }, claim: "included", documentationVersion: { status: "known", version: "1.0" },
    appliesToToolVersion: unknown, provenance: { kind: "tool-claimed", collector: "tool-documentation", method: "document-interpretation", evidenceRefs: [docRef] } });
}
function segment(channel: PublicSegment["channel"], artifactId: string): PublicSegment {
  return freeze({ ...identity, artifactId, segmentId: "segment:one", channel,
    capture: channel === "stdout" ? { kind: "capture", captureId: "capture:stdout" } : { kind: "none" },
    privateReference: { status: "yes" }, redaction: { status: "withheld", reason: "private-only" },
    publicVerifiability: { status: "not-publicly-verifiable", reason: "private-only" } });
}
function bundle(facts: NormalizedFact[] = [execution()]): NormalizedToolEvidence {
  return freeze({ schemaVersion: 1, ...identity,
    sources: { referenceAccident: { status: "unknown", reason: "reference-not-supplied" }, sameExecution: { status: "none", reason: "not-captured" } },
    tool: { name: "synthetic", version: unknown }, adapter: { name: "synthetic", version: { status: "known", version: "1" } },
    startedAt: { status: "known", timestamp: "2026-09-25T00:00:00.000Z" }, endedAt: { status: "known", timestamp: "2026-09-25T00:00:09.000Z" },
    facts, declaredCapabilities: [capability()], reporting: { stdout: { status: "applicable", captureId: "capture:stdout" },
      stderr: { status: "not-applicable", reason: "not-applicable" }, log: { status: "not-applicable", reason: "not-applicable" },
      receipt: { status: "not-applicable", reason: "not-applicable" } },
    reportCaptures: [{ ...identity, captureId: "capture:stdout", channel: "stdout", capture: { status: "complete" }, interpretation: { status: "complete" } }],
    segments: [segment("observer-record", "artifact:observer"), segment("stdout", "artifact:report"), segment("documentation", "artifact:doc")],
    availability: { originalState: { status: "available" }, reportedEvents: { status: "available" }, execution: { status: "available" },
      workspaceInputs: { status: "available" }, boundaryObservations: { status: "available" }, declaredCapabilities: { status: "available" } } });
}
function parses(value: unknown): boolean { return NormalizedToolEvidenceSchema.safeParse(freeze(value)).success; }

// End synthetic builders.
describe("normalized shape parsing", () => {
  it("parses each of the five normalized fact variants", () => {
    for (const value of [original(), reported(), execution(), workspace(), boundary()]) expect(NormalizedFactSchema.safeParse(value).success).toBe(true);
    expect(parses(bundle([original(), reported(), execution(), workspace(), boundary()]))).toBe(true);
  });
  it("parses declared capabilities with capability identity only", () => {
    expect(DeclaredCapabilitySchema.safeParse(capability()).success).toBe(true);
    expect(DeclaredCapabilitySchema.safeParse(freeze({ ...capability(), factId: "fact:extra" })).success).toBe(false);
  });
  it("parses declared and unknown reference-accident links", () => {
    const base = bundle();
    expect(parses(base)).toBe(true);
    expect(parses({ ...base, sources: { ...base.sources, referenceAccident: { status: "declared", relationship: "reference-accident",
      scenarioId: "S6", sourceRunId: `sha256:${"a".repeat(64)}`, oracleVersion: 1 } } })).toBe(true);
  });
  it("parses absent and declared same-execution additional links", () => {
    const base = bundle();
    expect(parses(base)).toBe(true);
    for (const oracle of [unknown, { status: "declared", oracleVersion: 1 }]) expect(parses({ ...base, sources: { ...base.sources,
      sameExecution: { status: "declared", relationship: "same-execution-additional-evidence", scenarioId: "S6", sourceRunId: `sha256:${"b".repeat(64)}`, oracle } } })).toBe(true);
  });
  it("parses unknown evidence fields with explicit reasons", () => {
    expect(parses(bundle([{ ...original(), state: unknown, hash: unknown, position: { timestamp: unknown, order: unknown } }]))).toBe(true);
  });
  it("rejects omitted required fields", () => {
    for (const key of Object.keys(bundle())) {
      const variant = Object.fromEntries(Object.entries(bundle()).filter(([name]) => name !== key));
      expect(parses(variant), key).toBe(false);
    }
  });
  it("rejects unknown properties at every object boundary", () => {
    const base = bundle([original(), reported(), execution(), workspace(), boundary()]);
    function variants(value: unknown): unknown[] {
      if (Array.isArray(value)) return value.flatMap((child, index) => variants(child).map((change) => value.map((item, i) => i === index ? change : item)));
      if (value === null || typeof value !== "object") return [];
      const entries = Object.entries(value);
      return [{ ...value, forbidden: true }, ...entries.flatMap(([key, child]) => variants(child).map((change) => Object.fromEntries(entries.map(([name, item]) => [name, name === key ? change : item]))))];
    }
    for (const variant of variants(base)) expect(parses(variant)).toBe(false);
  });
  it("rejects unsupported schema and linked oracle versions", () => {
    const base = bundle();
    expect(parses({ ...base, schemaVersion: 2 })).toBe(false);
    expect(parses({ ...base, sources: { ...base.sources, referenceAccident: { status: "declared", relationship: "reference-accident",
      scenarioId: "S6", sourceRunId: `sha256:${"a".repeat(64)}`, oracleVersion: 2 } } })).toBe(false);
  });
  it("rejects invalid identifier namespaces", () => {
    expect(parses({ ...bundle(), toolRunId: "other:run" })).toBe(false);
    expect(parses(bundle([{ ...original(), factId: "capture:wrong" }]))).toBe(false);
    expect(DeclaredCapabilitySchema.safeParse(freeze({ ...capability(), statementId: "unversioned" })).success).toBe(false);
  });
  it("rejects declared capabilities inside the facts array", () => { expect(parses({ ...bundle(), facts: [capability()] })).toBe(false); });
  it("rejects generic metadata and raw payload fields", () => {
    for (const key of ["metadata", "value", "stdout", "raw", "excerpt"]) expect(parses({ ...bundle(), [key]: "secret" })).toBe(false);
  });
});
describe("local semantic refinements", () => {
  it("rejects absent original state with a known hash", () => {
    expect(OriginalStateObservationSchema.safeParse(freeze({ ...original(), state: { status: "absent" } })).success).toBe(false);
    expect(OriginalStateObservationSchema.safeParse(freeze({ ...original(), state: { status: "absent" }, hash: na })).success).toBe(true);
  });
  it("rejects unknown original state with a known hash", () => { expect(OriginalStateObservationSchema.safeParse(freeze({ ...original(), state: unknown })).success).toBe(false); });
  it("rejects file events without a semantic path", () => {
    for (const eventType of ["created", "modified", "deleted"]) expect(ReportedEventSchema.safeParse(freeze({ ...reported(), eventType })).success).toBe(false);
  });
  it("preserves explicit denials as reported claims", () => {
    const value = freeze({ ...reported(), disposition: "explicitly-denied" });
    expect(ReportedEventSchema.parse(value)).toEqual(value);
  });
  it("rejects contradictory execution milestone states", () => {
    for (const change of [{ attempted: { status: "no" } }, { started: { status: "yes" } }, { completed: { status: "yes" } }]) {
      expect(ExecutionSchema.safeParse(freeze({ ...execution(), ...change })).success).toBe(false);
    }
    expect(ExecutionSchema.safeParse(running()).success).toBe(true);
    expect(ExecutionSchema.safeParse(freeze({ ...running(), attempted: unknown })).success).toBe(false);
  });
  it("rejects known positions for absent or unknown execution milestones", () => {
    expect(ExecutionSchema.safeParse(freeze({ ...execution(), startedAt: point(3) })).success).toBe(false);
    const base = freeze({ ...execution(), attempted: unknown, attemptedAt: { timestamp: unknown, order: unknown },
      blocked: { status: "no" as const }, blockedAt: noPosition });
    expect(ExecutionSchema.safeParse(base).success).toBe(true);
    const result = ExecutionSchema.safeParse(freeze({ ...base, attemptedAt: point(2) }));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues.map((issue) => issue.path)).toEqual([
      ["attemptedAt", "timestamp"], ["attemptedAt", "order"],
    ]);
    expect(ExecutionSchema.safeParse(freeze({ ...execution(), completedAt: { timestamp: unknown, order: unknown } })).success).toBe(false);
  });
  it("rejects incompatible exit-code and signal evidence", () => {
    expect(ExecutionSchema.safeParse(freeze({ ...running(), signal: { status: "known", signal: 15 } })).success).toBe(false);
    expect(ExecutionSchema.safeParse(freeze({ ...execution(), exitCode: { status: "known", exitCode: null } })).success).toBe(false);
    for (const exitCode of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1]) expect(ExitCodeSchema.safeParse(freeze({ status: "known", exitCode })).success).toBe(false);
    expect(SignalSchema.safeParse(freeze({ status: "known", signal: 0 })).success).toBe(false);
  });
  it("rejects scenario and action mismatches", () => {
    expect(ExecutionSchema.safeParse(freeze({ ...execution(), scenarioId: "S12" })).success).toBe(false);
    expect(WorkspaceInputSchema.safeParse(freeze({ ...workspace(), actionId: "create-control-file" })).success).toBe(false);
  });
  it("rejects usable workspace inputs that are not present", () => {
    for (const presence of [{ status: "missing" }, unknown]) expect(WorkspaceInputSchema.safeParse(freeze({ ...workspace(), presence })).success).toBe(false);
  });
  it("rejects incompatible boundary aspects and behaviors", () => {
    expect(BoundaryObservationSchema.safeParse(freeze({ ...boundary(), behavior: { status: "included" } })).success).toBe(false);
    expect(BoundaryObservationSchema.safeParse(freeze({ ...boundary(), captureIds: [] })).success).toBe(false);
    expect(BoundaryObservationSchema.safeParse(freeze({ ...boundary(), captureIds: ["capture:stdout", "capture:stdout"] })).success).toBe(false);
  });
  it("rejects incompatible capability aspects and claims", () => { expect(DeclaredCapabilitySchema.safeParse(freeze({ ...capability(), claim: "reported" })).success).toBe(false); });
  it("requires reasons for every unknown union arm", () => {
    for (const reason of [undefined, "", "  ", "arbitrary error text"]) expect(UnknownSchema.safeParse(freeze({ status: "unknown", reason })).success).toBe(false);
    expect(PositionSchema.safeParse(freeze({ timestamp: { status: "unknown" }, order: unknown })).success).toBe(false);
  });
  it("rejects duplicate evidence reference pairs inside provenance", () => {
    expect(OriginalStateObservationSchema.safeParse(freeze({ ...original(), provenance: { ...independent, evidenceRefs: [observerRef, observerRef] } })).success).toBe(false);
  });
  it("keeps final matching points free of recovery and preservation claims", () => {
    const value = bundle([original(), { ...original(), factId: "fact:final", stage: "after", position: point(5) }]);
    const result = validateNormalizedToolEvidence(value);
    expect(result).toEqual({ success: true, evidence: value });
    expect(JSON.stringify(result)).not.toMatch(/preserved|recovered|neverLost|coverage/);
  });
});

describe("absolute public token boundaries", () => {
  const families = [
    ["tool run", contract.ToolRunIdSchema, `toolrun:${"a".repeat(64)}`, `toolrun:${"a".repeat(65)}`],
    ["fact", contract.FactIdSchema, `fact:${"a".repeat(64)}`, `fact:${"a".repeat(65)}`],
    ["capture", contract.CaptureIdSchema, `capture:${"a".repeat(64)}`, `capture:${"a".repeat(65)}`],
    ["capability", contract.CapabilityIdSchema, `capability:${"a".repeat(64)}`, `capability:${"a".repeat(65)}`],
    ["artifact", contract.ArtifactIdSchema, `artifact:${"a".repeat(64)}`, `artifact:${"a".repeat(65)}`],
    ["segment", contract.SegmentIdSchema, `segment:${"a".repeat(64)}`, `segment:${"a".repeat(65)}`],
    ["statement name", contract.StatementIdSchema, `statement:${"a".repeat(64)}:v1`, `statement:${"a".repeat(65)}:v1`],
    ["tool name", contract.ToolNameSchema, "a".repeat(64), "a".repeat(65)],
    ["adapter name", contract.AdapterNameSchema, "a".repeat(64), "a".repeat(65)],
    ["version", contract.VersionStringSchema, "a".repeat(128), "a".repeat(129)],
    ["source run", contract.RunIdSchema, `sha256:${"a".repeat(64)}`, `sha256:${"a".repeat(65)}`],
    ["sha256", contract.Sha256Schema, "a".repeat(64), "a".repeat(65)],
    ["timestamp", contract.IsoUtcTimestampSchema, "2026-09-25T00:00:00.000Z", "2026-09-25T00:00:00.0000Z"],
  ] as const;
  it.each(families)("enforces the %s length and absolute end", (_name, schema, maximum, tooLong) => {
    expect(schema.safeParse(maximum).success).toBe(true);
    const long = schema.safeParse(tooLong);
    expect(long.success).toBe(false);
    if (!long.success) expect(long.error.issues.every((issue) => issue.path.length === 0)).toBe(true);
    for (const suffix of ["\n", "\r", "\r\n", "\u2028", "\u2029"]) {
      const result = schema.safeParse(maximum + suffix);
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.issues.every((issue) => issue.path.length === 0)).toBe(true);
    }
  });
  it("rejects trailing terminators on message hashes and source links", () => {
    const base = freeze({ kind: "scenario-issue-group", phase: "action", messageSha256: "a".repeat(64), occurrenceCount: 1 });
    expect(contract.EvidenceRefSchema.safeParse(base).success).toBe(true);
    const link = freeze({ status: "declared", relationship: "reference-accident", scenarioId: "S6",
      sourceRunId: `sha256:${"a".repeat(64)}`, oracleVersion: 1 });
    expect(contract.ReferenceAccidentLinkSchema.safeParse(link).success).toBe(true);
    for (const suffix of ["\n", "\r", "\r\n", "\u2028", "\u2029"]) {
      const message = contract.EvidenceRefSchema.safeParse(freeze({ ...base, messageSha256: base.messageSha256 + suffix }));
      expect(message.success).toBe(false);
      if (!message.success) expect(message.error.issues.map((issue) => issue.path)).toEqual([["messageSha256"]]);
      const source = contract.ReferenceAccidentLinkSchema.safeParse(freeze({ ...link, sourceRunId: link.sourceRunId + suffix }));
      expect(source.success).toBe(false);
      if (!source.success) expect(source.error.issues.map((issue) => issue.path)).toEqual([["sourceRunId"]]);
    }
  });
  it("requires real finite UTC dates with exactly millisecond precision", () => {
    for (const value of ["2024-02-29T00:00:00.000Z", "2000-02-29T23:59:59.999Z", "0000-01-01T00:00:00.000Z"]) {
      expect(contract.IsoUtcTimestampSchema.safeParse(value).success).toBe(true);
    }
    for (const value of ["2026-02-29T00:00:00.000Z", "1900-02-29T00:00:00.000Z", "2026-04-31T00:00:00.000Z",
      "2026-13-01T00:00:00.000Z", "2026-01-01T24:00:00.000Z", "2026-01-01T00:00:60.000Z",
      "2026-01-01T00:00:00Z", "2026-01-01T00:00:00.000+00:00", "invalid"]) {
      const result = contract.TimestampSchema.safeParse(freeze({ status: "known", timestamp: value }));
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.issues.every((issue) => JSON.stringify(issue.path) === '["timestamp"]')).toBe(true);
    }
  });
  it("accepts public version identifiers and rejects paths and command output", () => {
    for (const version of ["1.2.3", "v1.2.3", "1.2.3-beta.1", "build+abc"]) {
      expect(contract.KnownVersionSchema.safeParse(freeze({ status: "known", version })).success).toBe(true);
    }
    for (const version of ["/home/user/tool", "home/user/private-token", "C:\\tool\\version", "home\\tool", "1.2.3\nextra output"]) {
      const result = contract.KnownVersionSchema.safeParse(freeze({ status: "known", version }));
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.issues.map((issue) => issue.path)).toEqual([["version"]]);
    }
    expect(contract.KnownVersionSchema.safeParse(freeze({ status: "unknown", reason: "version-unavailable" })).success).toBe(true);
  });
});
