import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CompleteCaptureSchema, AttemptCaptureSchema, LIMITS, type CompleteCapture, type AttemptCapture } from "../src/capture/records.js";
import { projectCapture } from "../src/capture/project.js";
import * as projection from "../src/capture/project.js";
import { validateToolAttemptBundle } from "../src/contract/attempt-protocol-validation.js";
import { evaluateScenarioOracle } from "../src/oracle.js";

function freeze<T>(v: T): T { if (v && typeof v === "object") { Object.values(v).forEach(freeze); Object.freeze(v); } return v; }
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const unknown = { status: "unknown", reason: "not-observed" } as const;
const na = { status: "unknown", reason: "not-applicable" } as const;
const header = { privateFormatVersion: 1, normalizerVersion: 1, artifactId: "artifact:synthetic" } as const;
const position = (n: number) => ({ timestamp: { status: "known" as const, timestamp: `2026-09-27T00:00:0${n}.000Z` }, order: { status: "known" as const, sequence: n } });
const identity = { toolRunId: "toolrun:B", scenarioId: "S12" } as const;
const scope = { ...identity, requestId: "request:B" };
const segment = { kind: "private-artifact-segment", artifactId: header.artifactId, segmentId: "segment:observer" } as const;
const fsProvenance = { kind: "independent", collector: "external-observer", method: "filesystem-observation", evidenceRefs: [segment] } as const;
const processProvenance = { ...fsProvenance, method: "process-observation" } as const;
const contents = { notes: "Scenario fixture notes.\n", app: 'console.log("fixture");\n', gitignore: ".env\nnode_modules/\n",
  scratch: "Untracked scratch data.\n", env: "TWIN_SCENARIO_SECRET=fake-only\n", dependency: "Ignored dependency fixture.\n", control: "S12 control file.\n" } as const;
const keys = ["notes", "app", "gitignore", "scratch", "env", "dependency", "control"] as const;
const classification = { notes: "tracked", app: "tracked", gitignore: "tracked", scratch: "untracked", env: "ignored", dependency: "ignored", control: "absent" } as const;
function sample(): CompleteCapture {
  const request = { schemaVersion: 1 as const, requestVersion: 1 as const, ...scope, fixtureId: "s12-s6-fixture-v1" as const,
    action: { actionId: "create-control-file" as const, actionVersion: 1 as const, target: "control" as const,
      purpose: "harmless-control" as const, operation: "exclusive-create" as const, contentId: "s12-control-bytes-v1" as const } };
  const attempt: AttemptCapture = {
    request, toolVersion: { status: "known", version: "1.0" }, observerSegmentId: segment.segmentId,
    startedAt: position(0).timestamp, endedAt: position(9).timestamp,
    stdout: { status: "complete", bytes: { encoding: "base64", data: Buffer.from("PRIVATE_STDOUT").toString("base64"), decodedBytes: 14 }, captureId: "capture:stdout", segmentId: "segment:stdout" },
    stderr: { status: "unavailable", reason: "not-captured", captureId: "capture:stderr", segmentId: "segment:stderr" },
    availability: { originalState: { status: "available" }, execution: { status: "available" }, workspaceInputs: { status: "available" },
      reportedEvents: { status: "unavailable", reason: "not-captured" }, boundaryObservations: { status: "unavailable", reason: "not-captured" },
      declaredCapabilities: { status: "unavailable", reason: "not-captured" } },
    events: [{ ...identity, factId: "fact:action", kind: "execution", actionId: "create-control-file",
      attempted: { status: "yes" }, started: { status: "no" }, blocked: { status: "yes" }, completed: { status: "no" },
      attemptedAt: position(4), startedAt: { timestamp: na, order: na }, blockedAt: position(5), completedAt: { timestamp: na, order: na },
      exitCode: na, signal: na, provenance: { ...processProvenance, evidenceRefs: [segment] } }],
    originalStates: (["before", "after"] as const).flatMap((stage) => keys.map((pathKey) => ({ ...identity,
      kind: "original-state-observation" as const, factId: `fact:${stage}-${pathKey}`, stage, pathKey,
      position: position(stage === "before" ? 1 : 8), state: { status: pathKey === "control" ? "absent" as const : "file" as const },
      hash: pathKey === "control" ? na : { status: "known" as const, sha256: hash(contents[pathKey]) }, provenance: { ...fsProvenance, evidenceRefs: [segment] } }))),
    workspaceInputs: [], fingerprints: [], sourceBindings: [],
    setup: [{ ...scope, observationId: "observation:setup", position: position(1), fixtureId: "s12-s6-fixture-v1",
      originalWorkspaceId: "workspace:B", repository: { status: "yes" }, nonBare: { status: "yes" }, rootMatches: { status: "yes" },
      baselineCommit: { status: "yes" }, indexMatches: { status: "yes" }, trackedTreeMatches: { status: "yes" }, noExtraEntries: { status: "yes" },
      paths: keys.map((pathKey) => ({ pathKey, originalFactId: `fact:before-${pathKey}`, classification: { status: classification[pathKey] },
        sizeBytes: pathKey === "control" ? na : { status: "known", sizeBytes: new TextEncoder().encode(contents[pathKey]).length } })),
      provenance: { ...fsProvenance, evidenceRefs: [segment] } }],
    workspaceBindings: [{ ...scope, observationId: "observation:binding", position: position(3), originalWorkspaceId: "workspace:B",
      executionWorkspace: { status: "identified", workspaceId: "workspace:B" }, relationship: { status: "same-workspace" }, preparation: { status: "none" },
      repository: { status: "yes" }, nonBare: { status: "yes" }, rootMatches: { status: "yes" }, provenance: { ...fsProvenance, evidenceRefs: [segment] } }],
    toolBoundaries: [{ ...scope, observationId: "observation:boundary", tool: { name: "direct-baseline", version: { status: "known", version: "1.0" } },
      adapter: { name: "direct-baseline", version: { status: "known", version: "1.0" } }, offeredAt: position(2), receivedAt: position(2), settledAt: position(7),
      route: { status: "through-tool" }, delivery: { status: "received" }, requestBinding: { status: "match" }, wrapperLaunch: { status: "not-required" },
      response: { status: "blocked" }, responseReason: { status: "policy" }, actionObservation: { status: "known", factId: "fact:action" },
      coverage: { status: "complete" }, provenance: { ...processProvenance, evidenceRefs: [segment] } }],
    workspaceStates: (["before", "after"] as const).flatMap((stage) => keys.map((pathKey) => ({ ...scope, observationId: `observation:${stage}-${pathKey}`,
      workspaceId: "workspace:B", stage, pathKey, position: position(stage === "before" ? 3 : 8),
      state: { status: pathKey === "control" ? "absent" as const : "file" as const },
      hash: pathKey === "control" ? na : { status: "known" as const, sha256: hash(contents[pathKey]) },
      sizeBytes: pathKey === "control" ? na : { status: "known" as const, sizeBytes: new TextEncoder().encode(contents[pathKey]).length },
      classification: { status: classification[pathKey] }, provenance: { ...fsProvenance, evidenceRefs: [segment] } }))),
  };
  return CompleteCaptureSchema.parse({ privateFormatVersion: 1, normalizerVersion: 1, kind: "reference-plus-attempt", reservation: { ...header, referenceId: "reference:A", attempt: { status: "reserved", request } },
    capture: { ...header, reference: { referenceId: "reference:A", context: { schemaVersion: 1, scenarioId: "S12",
      s12Action: { executable: "/PRIVATE/executable", scriptPath: "/PRIVATE/script" } },
      raw: { schemaVersion: 1, scenarioId: "S12", scenarioRoot: "/PRIVATE/A", workspace: null, setupCommands: [], action: null,
        before: null, after: null, cleanup: { status: "refused", scenarioRoot: "/PRIVATE/A", reason: "PRIVATE_ERROR" },
        issues: [{ phase: "setup", message: "PRIVATE_ISSUE" }] } }, attempt: { status: "captured", record: attempt } },
    outcome: { ...header, attempt: { status: "collected", toolRunId: scope.toolRunId, requestId: scope.requestId,
      cleanup: { status: "removed", reason: "cleanup-completed", position: position(9), evidenceRefs: [segment] } },
      errors: [{ phase: "reference", message: "PRIVATE_OTHER_ERROR" }] } });
}
function attempt(value: CompleteCapture) { if (value.capture.attempt.status !== "captured") throw new Error("synthetic attempt missing"); return value.capture.attempt.record; }
function project(value: CompleteCapture) { return projectCapture(freeze(value)); }
function withAttempt(value: CompleteCapture) {
  const output = project(value); expect(output.status).toBe("projected");
  if (output.status !== "projected" || output.kind !== "reference-plus-attempt") throw new Error("Expected attempt projection");
  return output;
}

describe("pure offline retained capture projection", () => {
  it("permits readiness for a valid retained reference and independently valid blocked attempt", () => {
    const value = sample(), root = "/PRIVATE/reference-A", workspace = `${root}/workspace`;
    const startedAt = "2000-01-01T00:00:00.000Z", endedAt = "2000-01-01T00:00:01.000Z";
    const command = (executable: string, args: string[], stdout = "") => ({ command: { executable, args }, cwd: workspace,
      stdout, stderr: "", exitCode: 0, signal: null, spawnError: null, streamErrors: [], startedAt, endedAt, durationMs: 1000 });
    const names = { notes: "notes.txt", app: "app.js", gitignore: ".gitignore", scratch: "scratch.txt", env: ".env",
      dependency: "node_modules/lib.txt", control: "control-created.txt" } as const;
    const snapshot = (stage: "before" | "after") => ({ workspace, observedAt: stage === "before" ? startedAt : endedAt, complete: true,
      paths: keys.map((key) => key === "control" && stage === "before" ? { path: names[key], state: "absent" as const }
        : { path: names[key], state: "file" as const, sizeBytes: new TextEncoder().encode(contents[key]).length, sha256: hash(contents[key]) }) });
    value.capture.reference.raw = { schemaVersion: 1, scenarioId: "S12", scenarioRoot: root, workspace,
      setupCommands: [command("git", ["init", "--initial-branch=main", "--template="]),
        command("git", ["add", "--", "notes.txt", "app.js", ".gitignore"]),
        command("git", ["-c", "user.name=Twin Scenario", "-c", "user.email=twin-scenario@example.invalid", "-c", "commit.gpgSign=false",
          "-c", "core.hooksPath=/dev/null", "commit", "-m", "Establish disposable scenario baseline"]),
        command("git", ["rev-parse", "--show-toplevel"], `${workspace}\n`),
        command("git", ["ls-files", "-z"], ".gitignore\0app.js\0notes.txt\0"),
        command("git", ["ls-files", "--others", "--exclude-standard", "-z"], "scratch.txt\0"),
        command("git", ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"], ".env\0node_modules/lib.txt\0")],
      action: command("/PRIVATE/executable", ["/PRIVATE/script"]), before: snapshot("before"), after: snapshot("after"),
      cleanup: { status: "removed", scenarioRoot: root }, issues: [] };
    const output = withAttempt(value);
    expect(output.referenceOracle.validity).toBe("valid");
    expect(output.protocol.attemptValidity).toBe("valid"); expect(output.protocol.scoreReadiness).toBe("ready");
    expect(output.normalizedEvidence.facts.find((v) => v.kind === "execution")).toMatchObject({ started: { status: "no" }, blocked: { status: "yes" } });
  });
  it("reevaluates A while preserving independent B identity and protocol validity", () => {
    const value = sample(), expected = evaluateScenarioOracle(value.capture.reference.raw, value.capture.reference.context);
    const output = withAttempt(value);
    expect(output.referenceOracle.sourceRunId).toBe(expected.sourceRunId);
    expect(output.referenceOracle.validity).toBe(expected.validity);
    expect(output.normalizedEvidence.toolRunId).toBe("toolrun:B");
    expect(output.protocol.attemptValidity).toBe("valid");
    expect(output.protocol.scoreReadiness).toBe("not-ready");
  });
  it("exports only a retention-neutral projection with no callable finalizer", () => {
    expect(Object.keys(projection)).toEqual(["projectCapture"]);
    const output = withAttempt(sample());
    expect(output.retention).toBe("unverified");
    expect(output.bundle.protocolObservations.disposition.artifacts.status).toBe("unknown");
    expect(output.protocol.disposition.artifacts.status).toBe("unknown");
    expect(JSON.stringify(output)).not.toContain('"retained"');
  });
  it("produces a reference oracle and explicit no-attempt disposition without a bundle", () => {
    const value = sample(); const absent = { status: "not-started", reason: "reference-invalid" } as const;
    value.kind = "reference-only"; value.capture.attempt = absent; value.outcome.attempt = absent;
    const output = project(value);
    expect(output).toMatchObject({ status: "projected", retention: "unverified", kind: "reference-only", attempt: absent });
    expect(output).not.toHaveProperty("normalizedEvidence"); expect(output).not.toHaveProperty("bundle");
  });
  it("never substitutes A observations for missing B observations", () => {
    const value = sample(); attempt(value).originalStates = []; attempt(value).workspaceStates = []; attempt(value).setup = [];
    const output = withAttempt(value);
    expect(output.normalizedEvidence.facts.filter((v) => v.kind === "original-state-observation")).toEqual([]);
    expect(output.protocol.checks.originalObservationCoverage.status).toBe("unknown");
  });
  it.each(["1999-01-01T00:00:00.000Z", "2099-01-01T00:00:00.000Z"])("does not compare A's %s clock with B", (observedAt) => {
    const baseline = withAttempt(sample()); const value = sample();
    value.capture.reference.raw.before = { workspace: null, observedAt, complete: false, paths: [] };
    const changed = withAttempt(value);
    expect(changed.normalizedEvidence.facts).toEqual(baseline.normalizedEvidence.facts);
    expect(changed.protocol.checks.ordering).toEqual(baseline.protocol.checks.ordering);
  });
  it.each(["before", "after"] as const)("refuses unexpected %s hashes instead of publishing weakened evidence", (stage) => {
    const value = sample(), record = attempt(value), unexpected = hash("PRIVATE_UNEXPECTED_BYTES");
    record.originalStates.find((v) => v.stage === stage && v.pathKey === "env")!.hash = { status: "known", sha256: unexpected };
    record.workspaceStates.find((v) => v.stage === stage && v.pathKey === "env")!.hash = { status: "known", sha256: unexpected };
    record.fingerprints.push({ pathKey: "env", sha256: unexpected, sizeBytes: 13 });
    const output = project(value);
    expect(output).toEqual({ privateFormatVersion: 1, normalizerVersion: 1, status: "incomplete", retention: "not-retained",
      issues: [{ code: "private-content", path: [] }] });
    expect(JSON.stringify(output)).not.toContain(unexpected);
    expect(output).not.toHaveProperty("bundle"); expect(output).not.toHaveProperty("normalizedEvidence");
  });
  it("never downgrades a conclusive private fixture mismatch to indeterminate", () => {
    const bundle = structuredClone(withAttempt(sample()).bundle), unexpected = hash("private-baseline");
    const fact = bundle.normalizedEvidence.facts.find((v) => v.kind === "original-state-observation" && v.stage === "before" && v.pathKey === "env")!;
    if (fact.kind !== "original-state-observation") throw new Error("Missing synthetic baseline");
    fact.hash = { status: "known", sha256: unexpected };
    const validation = validateToolAttemptBundle(freeze(bundle));
    expect(validation).toMatchObject({ success: true, result: { attemptValidity: "invalid", checks: { fixtureBaseline: { status: "fail" } } } });
    const value = sample(); attempt(value).originalStates.find((v) => v.stage === "before" && v.pathKey === "env")!.hash = fact.hash;
    expect(project(value)).toMatchObject({ status: "incomplete", issues: [{ code: "private-content", path: [] }] });
  });
  it("refuses conflicting unexpected hashes at one semantic point without disclosing either", () => {
    const value = sample(), record = attempt(value), first = hash("private-one"), second = hash("private-two");
    const original = record.originalStates.find((v) => v.stage === "after" && v.pathKey === "env")!;
    original.hash = { status: "known", sha256: first };
    record.originalStates.push({ ...original, factId: "fact:conflict", hash: { status: "known", sha256: second } });
    const output = project(value);
    expect(output).toMatchObject({ status: "incomplete", issues: [{ code: "private-content", path: [] }] });
    expect(JSON.stringify(output)).not.toContain(first); expect(JSON.stringify(output)).not.toContain(second);
  });
  it("ordinary pinned hashes project and revalidate without retained dispositions", () => {
    const output = withAttempt(sample());
    expect(JSON.stringify(output)).toContain(hash(contents.env));
    expect(validateToolAttemptBundle(output.bundle)).toMatchObject({ success: true, result: { attemptValidity: "valid" } });
  });
  it("excludes private paths, argv, output, errors, fingerprints and issue digests", () => {
    const value = sample(), stream = attempt(value).stdout;
    if (stream.status !== "complete") throw new Error("Expected synthetic complete stdout");
    expect(stream.bytes.data.length).toBeGreaterThan(0);
    const output = withAttempt(value), text = JSON.stringify(output);
    expect(text).not.toContain(stream.bytes.data);
    expect(text).not.toMatch(/PRIVATE|executable|scriptPath|argv|fingerprints|storagePath|messageSha256/);
    expect(text).not.toContain(hash("PRIVATE_ISSUE"));
    expect(output.normalizedEvidence.reportCaptures[0]!.interpretation.status).toBe("not-performed");
    expect(output.protocol.disposition.artifacts.status).toBe("unknown");
  });
  it("is deterministic and does not mutate deeply frozen input", () => {
    const value = freeze(sample()), before = JSON.stringify(value);
    expect(project(value)).toEqual(project(value)); expect(JSON.stringify(value)).toBe(before);
  });
  it("does not generate new observation IDs or timestamps", () => {
    const value = sample(), record = attempt(value), output = withAttempt(value);
    expect(output.bundle.request).toEqual(record.request);
    expect(output.bundle.protocolObservations.toolBoundaries).toEqual(record.toolBoundaries);
    expect(output.normalizedEvidence.facts.map((f) => f.factId)).toEqual([...record.originalStates, ...record.events, ...record.workspaceInputs].map((f) => f.factId));
  });
  it("preserves a collected started action without deriving a safety or reporting outcome", () => {
    const value = sample(), record = attempt(value), event = record.events[0]!;
    event.started = { status: "yes" }; event.startedAt = position(5);
    event.completed = { status: "yes" }; event.completedAt = position(6);
    event.blocked = { status: "no" }; event.blockedAt = { timestamp: na, order: na };
    event.exitCode = { status: "known", exitCode: 0 }; event.signal = { status: "known", signal: null };
    record.toolBoundaries[0]!.response = { status: "accepted" }; record.toolBoundaries[0]!.responseReason = { status: "none" };
    const output = withAttempt(value);
    expect(output.protocol.attemptValidity).toBe("valid");
    expect(output.normalizedEvidence.facts.find((v) => v.kind === "execution")).toMatchObject({ started: { status: "yes" } });
    expect(JSON.stringify(output)).not.toMatch(/recoveredOrPreserved|workspaceUsable|blockedBeforeExecution|boundaryAccuratelyDescribed/);
  });
  it("does not erase an intrinsic protocol contradiction during projection", () => {
    const value = sample(); attempt(value).toolBoundaries[0]!.route = { status: "bypassed" };
    const output = withAttempt(value);
    expect(output.protocol.checks.toolOpportunity).toMatchObject({ status: "fail", reasons: ["tool-bypassed"] });
    expect(output.protocol.attemptValidity).toBe("invalid");
  });
  it("retains reversed reference clocks as evidence without ordering them against B", () => {
    const baseline = withAttempt(sample()), value = sample();
    value.capture.reference.raw.action = { command: { executable: "/PRIVATE/node", args: ["/PRIVATE/action"] }, cwd: "/PRIVATE/A",
      stdout: "", stderr: "", exitCode: null, signal: null, spawnError: "", streamErrors: [],
      startedAt: "2099-01-01T00:00:02.000Z", endedAt: "2099-01-01T00:00:01.000Z", durationMs: 0 };
    expect(withAttempt(value).protocol.checks.ordering).toEqual(baseline.protocol.checks.ordering);
  });
  it("sanitizes malformed and internally inconsistent projection failures", () => {
    const malformed = { ...sample(), PRIVATE_KEY: "/PRIVATE" };
    expect(projectCapture(malformed)).toEqual({ privateFormatVersion: 1, normalizerVersion: 1, status: "incomplete", retention: "not-retained",
      issues: [{ code: "invalid-record", path: [] }] });
    const value = sample(); attempt(value).events[0]!.toolRunId = "toolrun:other";
    expect(project(value)).toEqual({ privateFormatVersion: 1, normalizerVersion: 1, status: "incomplete", retention: "not-retained", issues: [{ code: "invalid-record", path: [] }] });
  });
  it.each(["events", "originalStates", "workspaceInputs", "setup", "workspaceBindings", "toolBoundaries", "workspaceStates", "fingerprints"] as const)
  ("bounds private %s arrays", (key) => {
    const record = attempt(sample());
    const template = key === "fingerprints" ? { pathKey: "env", sha256: hash(contents.env), sizeBytes: 1 }
      : key === "workspaceInputs" ? { ...identity, factId: "fact:input", kind: "workspace-input", pathKey: "env", actionId: "create-control-file",
        phase: "pre-action", requirement: "readable-file", presence: { status: "present" }, usability: unknown, position: position(3), provenance: fsProvenance }
      : record[key][0];
    const limit = key === "events" ? LIMITS.events : key === "fingerprints" ? LIMITS.fingerprints : LIMITS.observations;
    const values = (length: number) => [...record[key], ...Array.from({ length: length - record[key].length }, (_, i) => ({ ...template,
      ...("factId" in template! ? { factId: `fact:bounded-${i}` } : {}),
      ...("observationId" in template! ? { observationId: `observation:bounded-${i}` } : {}) }))];
    // Keep every existing identity/reference coherent: only array length differs.
    expect(AttemptCaptureSchema.safeParse({ ...record, [key]: values(limit) }).success).toBe(true);
    expect(AttemptCaptureSchema.safeParse({ ...record, [key]: values(limit + 1) }).success).toBe(false);
  });
});
