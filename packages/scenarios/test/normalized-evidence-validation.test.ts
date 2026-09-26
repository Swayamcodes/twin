import { DiagnosticPathKeySchema, NormalizedEvidenceValidationIssueSchema } from "@twin-cli/scenarios/contract";
import { describe, expect, it } from "vitest";
import { z } from "zod";
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

function validate(value: unknown) { return validateNormalizedToolEvidence(freeze(value)); }
function valid(value: unknown): boolean { return validate(value).success; }
function captureVariant(capture: unknown, interpretation: unknown): unknown {
  return freeze({ ...bundle(), reportCaptures: [{ ...bundle().reportCaptures[0]!, capture, interpretation }] });
}
describe("identity and reference validation", () => {
  it("accepts blocked S6 evidence with unknown accident linkage", () => { expect(validate(bundle())).toEqual({ success: true, evidence: bundle() }); });
  it("accepts same-execution linkage without requiring an oracle verdict", () => {
    const base = bundle();
    expect(valid({ ...base, sources: { ...base.sources, sameExecution: { status: "declared", relationship: "same-execution-additional-evidence",
      scenarioId: "S6", sourceRunId: `sha256:${"b".repeat(64)}`, oracle: unknown } } })).toBe(true);
  });
  it("rejects nested records belonging to another tool run", () => {
    expect(valid(bundle([{ ...original(), toolRunId: "toolrun:other" }]))).toBe(false);
    expect(valid({ ...bundle(), segments: [{ ...bundle().segments[0]!, toolRunId: "toolrun:other" }, ...bundle().segments.slice(1)] })).toBe(false);
    expect(valid({ ...bundle(), declaredCapabilities: [{ ...capability(), toolRunId: "toolrun:other" }] })).toBe(false);
    expect(valid({ ...bundle(), reportCaptures: [{ ...bundle().reportCaptures[0]!, toolRunId: "toolrun:other" }] })).toBe(false);
  });
  it("rejects nested records and source links belonging to another scenario", () => {
    expect(valid(bundle([{ ...original(), scenarioId: "S12" }]))).toBe(false);
    expect(valid({ ...bundle(), sources: { ...bundle().sources, referenceAccident: { status: "declared", relationship: "reference-accident",
      scenarioId: "S12", sourceRunId: `sha256:${"a".repeat(64)}`, oracleVersion: 1 } } })).toBe(false);
  });
  it("rejects duplicate fact capability and capture identities", () => {
    expect(valid(bundle([original(), original()]))).toBe(false);
    expect(valid({ ...bundle(), declaredCapabilities: [capability(), capability()] })).toBe(false);
    expect(valid({ ...bundle(), reportCaptures: [...bundle().reportCaptures, ...bundle().reportCaptures] })).toBe(false);
  });
  it("rejects duplicate artifact and segment pairs", () => { expect(valid({ ...bundle(), segments: [...bundle().segments, bundle().segments[0]!] })).toBe(false); });
  it("allows distinct segments within one artifact", () => {
    expect(valid({ ...bundle(), segments: [...bundle().segments, { ...bundle().segments[0]!, segmentId: "segment:two" }] })).toBe(true);
  });
  it("rejects unresolved segment and capture references", () => {
    expect(valid({ ...bundle(), segments: bundle().segments.slice(1) })).toBe(false);
    expect(valid({ ...bundle(), reportCaptures: [] })).toBe(false);
  });
  it("rejects report segments linked to another capture", () => {
    const base = withStderr(bundle([reported()]));
    expect(valid(base)).toBe(true);
    // The event names another existing, complete, inventory-owned capture.
    expect(validate({ ...base, facts: [{ ...reported(), captureId: "capture:stderr" }] })).toEqual({ success: false,
      issues: [{ code: "capture-mismatch", path: ["facts", 0, "segmentRef"] }] });
  });
  it("rejects inventory and capture channel mismatches", () => {
    expect(valid({ ...bundle(), reportCaptures: [{ ...bundle().reportCaptures[0]!, channel: "stderr" }] })).toBe(false);
  });
  it("resolves capabilities independently of normalized facts", () => {
    expect(valid(bundle([]))).toBe(true);
    expect(valid({ ...bundle([]), segments: bundle().segments.filter((item) => item.channel !== "documentation") })).toBe(false);
  });
});
describe("chronology validation", () => {
  it("rejects reversed known run timestamps", () => { expect(valid({ ...bundle(), endedAt: { status: "known", timestamp: "2026-09-24T00:00:00.000Z" } })).toBe(false); });
  it("rejects known observation timestamps outside run bounds", () => {
    expect(valid(bundle([{ ...original(), position: { ...point(1), timestamp: { status: "known", timestamp: "2026-09-24T00:00:00.000Z" } } }]))).toBe(false);
  });
  it("rejects reversed execution milestone timestamps", () => {
    expect(valid(bundle([{ ...running(), startedAt: { ...point(3), timestamp: point(1).timestamp } }]))).toBe(false);
  });
  it("rejects reversed execution milestone sequence ordering", () => {
    expect(valid(bundle([{ ...running(), completedAt: { ...point(4), order: { status: "known", sequence: 1 } } }]))).toBe(false);
  });
  it("rejects contradictory timestamp and sequence ordering", () => {
    expect(valid(bundle([original(), { ...original(), factId: "fact:second", position: { timestamp: point(2).timestamp, order: { status: "known", sequence: 0 } } }]))).toBe(false);
  });
  it("rejects known workspace observations after action start", () => {
    expect(valid(bundle([running(), { ...workspace(), position: point(4) }]))).toBe(false);
    expect(valid(bundle([execution(), { ...workspace(), position: point(4) }]))).toBe(false);
  });
  it("retains unknown ordering without inventing chronology", () => {
    const value = bundle([running(), { ...workspace(), position: { timestamp: unknown, order: unknown } }]);
    expect(validate(value)).toEqual({ success: true, evidence: value });
  });
  it("does not infer chronology from array position", () => {
    expect(valid(bundle([running(), workspace(), original()]))).toBe(true);
    expect(valid(bundle([original(), workspace(), running()]))).toBe(true);
  });
  it("accepts multiple ordered during observations for one path", () => {
    expect(valid(bundle([original(), { ...original(), factId: "fact:damage", stage: "during", state: { status: "absent" }, hash: na, position: point(3) },
      { ...original(), factId: "fact:restored", stage: "during", position: point(4) }]))).toBe(true);
  });
});
describe("capture and interpretation completeness", () => {
  it("accepts a captured mention from a partially captured channel", () => {
    const base = bundle([reported()]);
    expect(valid({ ...base, reportCaptures: [{ ...base.reportCaptures[0]!, capture: { status: "partial", reason: "capture-incomplete" },
      interpretation: { status: "partial", reason: "interpretation-incomplete" } }] })).toBe(true);
  });
  it("requires complete capture before complete interpretation", () => {
    for (const status of ["partial", "unavailable", "unknown"]) expect(valid(captureVariant({ status, reason: "capture-incomplete" }, { status: "complete" }))).toBe(false);
  });
  it("requires segment metadata for complete capture including empty streams", () => {
    expect(valid({ ...bundle(), segments: bundle().segments.filter((item) => item.channel !== "stdout") })).toBe(false);
    expect(valid(bundle([]))).toBe(true);
  });
  it("rejects interpreted content in an unavailable capture", () => {
    expect(valid(captureVariant({ status: "unavailable", reason: "not-captured" }, { status: "partial", reason: "interpretation-incomplete" }))).toBe(false);
    const base = bundle([reported()]);
    expect(valid({ ...base, reportCaptures: [{ ...base.reportCaptures[0]!, capture: { status: "unavailable", reason: "not-captured" },
      interpretation: { status: "not-performed", reason: "not-captured" } }] })).toBe(false);
  });
  it("requires every capture to match an applicable inventory entry", () => {
    expect(valid({ ...bundle(), reporting: { ...bundle().reporting, stdout: unknown } })).toBe(false);
  });
  it("retains unknown reporting-channel applicability", () => {
    const value = freeze({ ...bundle(), reporting: { ...bundle().reporting, log: unknown } });
    expect(validate(value)).toEqual({ success: true, evidence: value });
  });
  it("rejects unreported boundary assertions with incomplete applicable capture", () => {
    const base = bundle([boundary()]);
    expect(valid(base)).toBe(true);
    expect(valid({ ...base, reporting: { ...base.reporting, log: unknown } })).toBe(false);
    expect(valid({ ...base, reportCaptures: [{ ...base.reportCaptures[0]!, capture: { status: "partial", reason: "capture-incomplete" },
      interpretation: { status: "partial", reason: "interpretation-incomplete" } }] })).toBe(false);
  });
  it("rejects unreported boundary assertions with incomplete interpretation", () => {
    const base = bundle([boundary()]);
    expect(valid({ ...base, reportCaptures: [{ ...base.reportCaptures[0]!, interpretation: { status: "partial", reason: "interpretation-incomplete" } }] })).toBe(false);
  });
  it("does not manufacture reported events from an empty fact collection", () => {
    const value = bundle([]);
    expect(validate(value)).toEqual({ success: true, evidence: value });
  });
  it("rejects availability states that contradict supplied collections", () => {
    const base = bundle([original(), reported(), execution(), workspace(), boundary()]);
    for (const key of Object.keys(base.availability)) for (const status of ["unknown", "unavailable"]) {
      expect(valid({ ...base, availability: { ...base.availability, [key]: { status, reason: "not-observed" } } })).toBe(false);
    }
    expect(valid({ ...bundle([]), declaredCapabilities: [], availability: { originalState: unknown, reportedEvents: unknown,
      execution: unknown, workspaceInputs: unknown, boundaryObservations: unknown, declaredCapabilities: unknown } })).toBe(true);
  });
});
describe("provenance restrictions", () => {
  it("requires filesystem provenance for independent state and input observations", () => {
    for (const fact of [original(), workspace()]) expect(valid(bundle([{ ...fact, provenance: { ...fact.provenance, method: "process-observation" } } as NormalizedFact]))).toBe(false);
  });
  it("requires process provenance for independent execution observations", () => {
    expect(valid(bundle([{ ...execution(), provenance: { ...independent, evidenceRefs: [observerRef] } }]))).toBe(false);
  });
  it("requires tool-output provenance for reported events", () => { expect(valid({ ...bundle(), facts: [{ ...reported(), provenance: independent }] })).toBe(false); });
  it("requires documentation provenance for declared capabilities", () => {
    expect(valid({ ...bundle(), declaredCapabilities: [{ ...capability(), provenance: claimed }] })).toBe(false);
  });
  it("rejects provenance references to incompatible segment channels", () => {
    expect(valid(bundle([{ ...original(), provenance: { ...independent, evidenceRefs: [reportRef] } }]))).toBe(false);
    expect(valid({ ...bundle(), declaredCapabilities: [{ ...capability(), provenance: { ...capability().provenance, evidenceRefs: [observerRef] } }] })).toBe(false);
    expect(valid(bundle([{ ...reported(), segmentRef: docRef, provenance: { ...claimed, evidenceRefs: [docRef] } }]))).toBe(false);
  });
  it("preserves disagreement between tool claims and independent observations", () => {
    const value = bundle([original(), { ...original(), factId: "fact:claim", state: { status: "absent" }, hash: na,
      provenance: { ...claimed, evidenceRefs: [reportRef] } }]);
    expect(validate(value)).toEqual({ success: true, evidence: value });
  });
  it("does not reject normalized evidence merely because observations are tool-claimed", () => {
    expect(valid(bundle([{ ...workspace(), provenance: { ...claimed, evidenceRefs: [reportRef] } }]))).toBe(true);
  });
});
describe("determinism and immutability", () => {
  it("validates deeply frozen input without mutation", () => {
    const value = bundle();
    const before = JSON.stringify(value);
    expect(valid(value)).toBe(true);
    expect(Object.isFrozen(value.facts[0])).toBe(true);
    expect(JSON.stringify(value)).toBe(before);
  });
  it("returns identical output for identical frozen input", () => { expect(validate(bundle())).toEqual(validate(bundle())); });
  it("returns deterministic issue ordering for invalid frozen input", () => {
    const base = bundle([original(), { ...original(), toolRunId: "toolrun:other" }]);
    const value = freeze({ ...base, endedAt: { status: "known", timestamp: "2026-09-24T00:00:00.000Z" } });
    const result = validate(value);
    expect(result).toEqual(validate(value));
    expect(result).toMatchObject({ success: false, issues: [
      { code: "identity-mismatch", path: ["facts", 1, "toolRunId"] },
      { code: "duplicate-id", path: ["facts", 1, "factId"] },
      { code: "chronology-conflict", path: ["endedAt"] },
      { code: "chronology-conflict", path: ["facts", 0, "position"] },
      { code: "chronology-conflict", path: ["facts", 1, "position"] },
    ] });
  });
  it("keeps source identities independent of fact array order", () => {
    const a = validate(bundle([original(), running()]));
    const b = validate(bundle([running(), original()]));
    if (!a.success || !b.success) throw new Error("Expected synthetic evidence");
    expect(a.evidence.sources).toEqual(b.evidence.sources);
  });
});
describe("public and private boundary", () => {
  it("parses flat private-segment metadata without raw content", () => { expect(PublicSegmentSchema.parse(bundle().segments[0])).toEqual(bundle().segments[0]); });
  it("requires a policy version for semantic-redaction metadata", () => {
    expect(PublicSegmentSchema.safeParse(freeze({ ...bundle().segments[0], redaction: { status: "semantic-redaction" } })).success).toBe(false);
    expect(PublicSegmentSchema.safeParse(freeze({ ...bundle().segments[0], redaction: { status: "semantic-redaction", policyVersion: 1 } })).success).toBe(true);
  });
  it("does not equate private-reference existence with public verification", () => {
    for (const privateReference of [{ status: "yes" }, { status: "no" }, unknown]) {
      const value = freeze({ ...bundle(), segments: bundle().segments.map((item) => ({ ...item, privateReference })) });
      expect(validate(value)).toEqual({ success: true, evidence: value });
    }
  });
  it("rejects publicly verified source claims in version one", () => {
    const base = bundle();
    expect(valid(base)).toBe(true);
    const value = freeze({ ...base, segments: base.segments.map((item, index) => index === 0
      ? { ...item, publicVerifiability: { status: "verified", reason: "private-only" } } : item) });
    const parsed = NormalizedToolEvidenceSchema.safeParse(value);
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.error.issues.map((issue) => issue.path)).toEqual([
      ["segments", 0, "publicVerifiability", "status"],
    ]);
    expect(validate(value)).toEqual({ success: false, issues: [{ code: "invalid-shape",
      path: ["segments", 0, "publicVerifiability", "status"] }] });
  });
  it("rejects raw excerpts storage locations offsets commands and content digests", () => {
    for (const key of ["raw", "excerpt", "storageLocation", "byteOffset", "command", "sha256", "path", "exception", "stack"]) {
      expect(PublicSegmentSchema.safeParse(freeze({ ...bundle().segments[0], [key]: "SECRET" })).success).toBe(false);
    }
  });
  it("does not echo secret-bearing rejected values or property names in validation diagnostics", () => {
    const secret = "SECRET_PRIVATE_/home/person/token";
    for (const value of [{ ...bundle(), [secret]: secret }, { ...bundle(), toolRunId: secret },
      { ...bundle(), facts: [{ ...original(), provenance: { ...independent, [secret]: secret } }] },
      { ...bundle(), sources: { referenceAccident: { status: secret }, sameExecution: secret } }]) {
      const result = validate(value);
      expect(result.success).toBe(false);
      expect(JSON.stringify(result)).not.toContain(secret);
      if (!result.success) for (const issue of result.issues) expect(Object.keys(issue).sort()).toEqual(["code", "path"]);
    }
    const bad = Object.freeze({ get schemaVersion(): never { throw new Error(secret); } });
    expect(validateNormalizedToolEvidence(bad)).toEqual({ success: false, issues: [{ code: "invalid-shape", path: [] }] });
  });
  it("returns normalized evidence without embedding oracle or raw scenario objects", () => {
    const result = validate(bundle());
    expect(result).toEqual({ success: true, evidence: bundle() });
    for (const key of ["raw", "oracleResult", "evaluationContext"]) expect(valid({ ...bundle(), [key]: {} })).toBe(false);
  });
});

function withStderr(base: NormalizedToolEvidence): NormalizedToolEvidence {
  return freeze({ ...base, reporting: { ...base.reporting, stderr: { status: "applicable", captureId: "capture:stderr" } },
    reportCaptures: [...base.reportCaptures, { ...identity, captureId: "capture:stderr", channel: "stderr",
      capture: { status: "complete" }, interpretation: { status: "complete" } }],
    segments: [...base.segments, { ...segment("stdout", "artifact:stderr"), channel: "stderr",
      capture: { kind: "capture", captureId: "capture:stderr" } }] });
}
function interpretedFact(kind: NormalizedFact["kind"]): NormalizedFact {
  const provenance = { ...claimed, evidenceRefs: [reportRef] };
  switch (kind) {
    case "original-state-observation": return freeze({ ...original(), provenance });
    case "execution": return freeze({ ...execution(), provenance });
    case "workspace-input": return freeze({ ...workspace(), provenance });
    case "boundary-observation": return freeze({ ...boundary(), behavior: { status: "reported" }, provenance });
    case "reported-event": return reported();
  }
}
describe("interpreted provenance capture integrity", () => {
  const kinds = ["original-state-observation", "execution", "workspace-input", "boundary-observation", "reported-event"] as const;
  it.each(kinds)("rejects unavailable material for %s", (kind) => {
    const base = bundle([interpretedFact(kind)]);
    expect(valid(base)).toBe(true);
    // Unavailable material must also mark interpretation not performed to remain
    // locally coherent. The only bundle failure is its use as interpretation evidence.
    const value = freeze({ ...base, reportCaptures: [{ ...base.reportCaptures[0]!,
      capture: { status: "unavailable", reason: "not-captured" },
      interpretation: { status: "not-performed", reason: "not-captured" } }] });
    expect(NormalizedToolEvidenceSchema.safeParse(value).success).toBe(true);
    expect(validate(value)).toEqual({ success: false, issues: [
      { code: "completeness-conflict", path: ["facts", 0, "provenance", "evidenceRefs", 0] },
    ] });
  });
  it.each(kinds)("rejects not-performed interpretation for %s", (kind) => {
    const base = bundle([interpretedFact(kind)]);
    expect(valid(base)).toBe(true);
    expect(validate({ ...base, reportCaptures: [{ ...base.reportCaptures[0]!,
      interpretation: { status: "not-performed", reason: "not-observed" } }] })).toEqual({ success: false, issues: [
      { code: "completeness-conflict", path: ["facts", 0, "provenance", "evidenceRefs", 0] },
    ] });
  });
  it.each(kinds)("accepts partial capture and partial interpretation for %s", (kind) => {
    const base = bundle([interpretedFact(kind)]);
    expect(valid(base)).toBe(true);
    expect(valid({ ...base, reportCaptures: [{ ...base.reportCaptures[0]!, capture: { status: "partial", reason: "capture-incomplete" },
      interpretation: { status: "partial", reason: "interpretation-incomplete" } }] })).toBe(true);
  });
  it.each(kinds)("rejects unknown capture or interpretation for %s", (kind) => {
    const complete = bundle([interpretedFact(kind)]);
    const base = freeze({ ...complete, reportCaptures: [{ ...complete.reportCaptures[0]!,
      interpretation: { status: "partial" as const, reason: "interpretation-incomplete" as const } }] });
    expect(valid(base)).toBe(true);
    for (const capture of [{ ...base.reportCaptures[0]!, capture: unknown }, { ...base.reportCaptures[0]!, interpretation: unknown }]) {
      expect(validate({ ...base, reportCaptures: [capture] })).toEqual({ success: false, issues: [
        { code: "completeness-conflict", path: ["facts", 0, "provenance", "evidenceRefs", 0] },
      ] });
    }
  });
  it("requires positive boundary provenance to name a listed capture", () => {
    const base = withStderr(bundle([interpretedFact("boundary-observation")]));
    expect(valid(base)).toBe(true);
    expect(validate({ ...base, facts: [{ ...boundary(), behavior: { status: "reported" }, captureIds: ["capture:stderr"] }] }))
      .toEqual({ success: false, issues: [{ code: "capture-mismatch", path: ["facts", 0, "captureIds"] }] });
  });
  it("accepts positive boundary reporting with a named supporting capture", () => {
    const base = withStderr(bundle([interpretedFact("boundary-observation")]));
    // Another applicable channel need not be interpreted for this positive claim.
    expect(valid({ ...base, reportCaptures: base.reportCaptures.map((item) => item.channel === "stderr"
      ? { ...item, interpretation: { status: "not-performed", reason: "not-observed" } } : item) })).toBe(true);
  });
  it("checks every provenance segment rather than only the first", () => {
    const ref = { kind: "private-artifact-segment" as const, artifactId: "artifact:stderr", segmentId: "segment:one" };
    const base = withStderr(bundle([{ ...original(), provenance: { ...claimed, evidenceRefs: [reportRef, ref] } }]));
    expect(valid(base)).toBe(true);
    expect(validate({ ...base, reportCaptures: base.reportCaptures.map((item) => item.channel === "stderr"
      ? { ...item, interpretation: { status: "not-performed", reason: "not-observed" } } : item) })).toEqual({ success: false, issues: [
      { code: "completeness-conflict", path: ["facts", 0, "provenance", "evidenceRefs", 1] },
    ] });
  });
});

// Timestamp-only points isolate milestone-order checks from independent sequence checks.
const unknownPosition: Position = freeze({ timestamp: unknown, order: unknown });
function timeOnly(n: number): Position { return freeze({ timestamp: point(n).timestamp, order: unknown }); }
function timeExecution(): Execution {
  return freeze({ ...running(), attemptedAt: timeOnly(2), startedAt: timeOnly(3), completedAt: timeOnly(4) });
}
describe("transitive chronology and equal batches", () => {
  it("rejects completion before attempt with an unknown start position", () => {
    const base = freeze({ ...timeExecution(), startedAt: unknownPosition });
    expect(valid(bundle([base]))).toBe(true);
    expect(validate(bundle([{ ...base, completedAt: timeOnly(1) }]))).toEqual({ success: false, issues: [
      { code: "chronology-conflict", path: ["facts", 0, "completedAt"] },
    ] });
  });
  it("rejects workspace observation after completion with unknown start and attempt positions", () => {
    const execution = freeze({ ...timeExecution(), attemptedAt: unknownPosition, startedAt: unknownPosition });
    const base = bundle([execution, { ...workspace(), position: timeOnly(1) }]);
    expect(valid(base)).toBe(true);
    expect(validate(bundle([execution, { ...workspace(), position: timeOnly(5) }]))).toEqual({ success: false, issues: [
      { code: "chronology-conflict", path: ["facts", 1, "position"] },
    ] });
  });
  it("accepts coherent endpoints around an unknown intermediate position", () => {
    const value = bundle([{ ...timeExecution(), startedAt: unknownPosition }]);
    expect(validate(value)).toEqual({ success: true, evidence: value });
  });
  it.each([
    ["attempt to start", "attemptedAt", "startedAt"],
    ["attempt to completion", "attemptedAt", "completedAt"],
    ["start to completion", "startedAt", "completedAt"],
  ] as const)("checks the isolated %s relationship", (_label, earlier, later) => {
    const base = freeze({ ...timeExecution(), attemptedAt: unknownPosition, startedAt: unknownPosition, completedAt: unknownPosition,
      [earlier]: timeOnly(2), [later]: timeOnly(3) });
    expect(valid(bundle([base]))).toBe(true);
    expect(validate(bundle([{ ...base, [later]: timeOnly(1) }]))).toEqual({ success: false, issues: [
      { code: "chronology-conflict", path: ["facts", 0, later] },
    ] });
  });
  it.each(["attempted", "started", "blocked", "completed"] as const)("checks workspace against the isolated %s boundary", (milestone) => {
    const template = milestone === "blocked" ? execution() : running();
    const action = freeze({ ...template, attemptedAt: unknownPosition, startedAt: template.started.status === "yes" ? unknownPosition : noPosition,
      blockedAt: template.blocked.status === "yes" ? unknownPosition : noPosition, completedAt: template.completed.status === "yes" ? unknownPosition : noPosition,
      [`${milestone}At`]: timeOnly(3) });
    expect(valid(bundle([action, { ...workspace(), position: timeOnly(2) }]))).toBe(true);
    expect(validate(bundle([action, { ...workspace(), position: timeOnly(4) }]))).toEqual({ success: false, issues: [
      { code: "chronology-conflict", path: ["facts", 1, "position"] },
    ] });
  });
  it("accepts earlier workspace timestamps with equal start sequence", () => {
    const action = freeze({ ...running(), attemptedAt: unknownPosition, completedAt: unknownPosition });
    expect(valid(bundle([action, { ...workspace(), position: { timestamp: point(1).timestamp, order: point(3).order } }]))).toBe(true);
  });
  it("retains unknown timestamps with equal sequences without claiming strict precedence", () => {
    const sameBatch: Position = freeze({ timestamp: unknown, order: { status: "known", sequence: 3 } });
    const value = bundle([{ ...running(), attemptedAt: sameBatch, startedAt: sameBatch, completedAt: sameBatch },
      { ...workspace(), position: sameBatch }]);
    expect(validate(value)).toEqual({ success: true, evidence: value });
  });
  it("rejects a greater workspace sequence than the start sequence", () => {
    const action = freeze({ ...running(), attemptedAt: unknownPosition, completedAt: unknownPosition,
      startedAt: { timestamp: unknown, order: point(3).order } });
    expect(valid(bundle([action, { ...workspace(), position: { timestamp: unknown, order: point(2).order } }]))).toBe(true);
    expect(validate(bundle([action, { ...workspace(), position: { timestamp: unknown, order: point(4).order } }]))).toEqual({ success: false, issues: [
      { code: "chronology-conflict", path: ["facts", 1, "position"] },
    ] });
  });
  it("accepts equal execution milestone sequences", () => {
    expect(valid(bundle([{ ...running(), attemptedAt: { ...point(2), order: point(3).order },
      completedAt: { ...point(4), order: point(3).order } }]))).toBe(true);
  });
  it("rejects strictly opposing timestamp and sequence directions", () => {
    const base = bundle([original(), { ...original(), factId: "fact:later", position: point(2) }]);
    expect(valid(base)).toBe(true);
    expect(validate(bundle([original(), { ...original(), factId: "fact:later",
      position: { timestamp: point(2).timestamp, order: { status: "known", sequence: 0 } } }]))).toEqual({ success: false, issues: [
      { code: "chronology-conflict", path: ["facts", 1, "position"] },
    ] });
  });
});

describe("closed diagnostic path schema", () => {
  it("keeps diagnostic keys exactly aligned with reachable schema properties", () => {
    // Inspect schema structure only, never fixture values. Unsupported conversion
    // must throw rather than silently replace an object arm with an empty schema.
    const root = z.toJSONSchema(NormalizedToolEvidenceSchema, {
      target: "draft-2020-12", io: "input", reused: "ref", unrepresentable: "throw",
    });
    const keys = new Set<string>();
    const visited = new Set<object>();
    function object(value: unknown): Record<string, unknown> {
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("Expected a JSON Schema object");
      }
      return value as Record<string, unknown>;
    }
    function resolve(ref: string): unknown {
      if (ref === "#") return root;
      if (!ref.startsWith("#/")) throw new Error("Expected a local JSON Schema reference");
      let target: unknown = root;
      for (const token of decodeURIComponent(ref.slice(2)).split("/")) {
        const key = token.replace(/~1/g, "/").replace(/~0/g, "~");
        const container = object(target);
        if (!Object.hasOwn(container, key)) throw new Error("Unresolved local JSON Schema reference");
        target = container[key];
      }
      return target;
    }
    function visit(value: unknown): void {
      if (typeof value === "boolean") return;
      const schema = object(value);
      if (visited.has(schema)) return;
      visited.add(schema);
      if (schema.$ref !== undefined) {
        if (typeof schema.$ref !== "string") throw new Error("Expected a JSON Schema reference string");
        visit(resolve(schema.$ref));
      }
      if (schema.properties !== undefined) {
        for (const [key, child] of Object.entries(object(schema.properties))) {
          keys.add(key);
          visit(child);
        }
      }
      if (schema.items !== undefined) {
        if (Array.isArray(schema.items)) schema.items.forEach(visit);
        else visit(schema.items);
      }
      for (const keyword of ["prefixItems", "anyOf", "oneOf", "allOf"] as const) {
        const children = schema[keyword];
        if (children === undefined) continue;
        if (!Array.isArray(children)) throw new Error("Expected a JSON Schema branch array");
        children.forEach(visit);
      }
      if (schema.$defs !== undefined) Object.values(object(schema.$defs)).forEach(visit);
    }
    visit(root);
    // No validator-only string keys: semantic diagnostics use evidence properties.
    const validatorOnlyKeys: readonly string[] = [];
    const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
    expect([...new Set([...keys, ...validatorOnlyKeys])].sort(compare),
      "Schema property keys must exactly match approved diagnostic keys")
      .toEqual([...DiagnosticPathKeySchema.options].sort(compare));
  });
  it("accepts approved keys and nonnegative safe indexes", () => {
    for (const key of DiagnosticPathKeySchema.options) {
      expect(NormalizedEvidenceValidationIssueSchema.safeParse(freeze({ code: "invalid-shape", path: [key, 0, Number.MAX_SAFE_INTEGER] })).success).toBe(true);
    }
  });
  it("rejects arbitrary strings and unsafe indexes in diagnostic paths", () => {
    for (const part of ["/home/user/SECRET", "SECRET_TOKEN", "rejectedUnknownProperty", -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
      const result = NormalizedEvidenceValidationIssueSchema.safeParse(freeze({ code: "invalid-shape", path: ["facts", part] }));
      expect(result.success).toBe(false);
      if (!result.success) expect([...new Set(result.error.issues.map((issue) => JSON.stringify(issue.path)))])
        .toEqual([JSON.stringify(["path", 1])]);
    }
  });
  it("returns only paths accepted by the exported diagnostic schema", () => {
    const base = bundle();
    expect(valid(base)).toBe(true);
    const cases = freeze([
      [{ ...base, SECRET_TOKEN: "hidden" }, []],
      [{ ...base, facts: [{ ...execution(), SECRET_TOKEN: "hidden" }] }, ["facts", 0]],
      [{ ...base, tool: { ...base.tool, version: { status: "known", version: "home/user/SECRET" } } }, ["tool", "version", "version"]],
    ] as const);
    for (const [value, path] of cases) {
      const result = validate(value);
      expect(result).toEqual({ success: false, issues: [{ code: "invalid-shape", path }] });
      if (!result.success) for (const issue of result.issues) expect(NormalizedEvidenceValidationIssueSchema.safeParse(issue).success).toBe(true);
      expect(JSON.stringify(result)).not.toContain("SECRET");
    }
  });
});
