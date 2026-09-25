import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { evaluateScenarioOracle, OracleEvaluationContextSchema, OracleResultSchema } from "@twin-cli/scenarios/contract";
import type { OracleEvaluationContext, S12OracleEvaluationContext, S6OracleEvaluationContext } from "@twin-cli/scenarios/contract";
import { scenarioRefResolves } from "../dist/contract/evidence-refs.js";
import type { CommandEvidence, ObservedPath, PathObservation, ScenarioRunResult, Snapshot } from "../dist/types.js";

// Independent version-1 fixture literals: no import from fixture-producing code.
const contents = {
  "notes.txt": "Scenario fixture notes.\n",
  "app.js": 'console.log("fixture");\n',
  ".gitignore": ".env\nnode_modules/\n",
  "scratch.txt": "Untracked scratch data.\n",
  ".env": "TWIN_SCENARIO_SECRET=fake-only\n",
  "node_modules/lib.txt": "Ignored dependency fixture.\n",
} as const;
const paths = [...Object.keys(contents), "control-created.txt"] as ObservedPath[];
const root = "/tmp/twin-scenario-synthetic";
const workspace = `${root}/workspace`;
const startedAt = "2026-09-25T00:00:00.000Z";
const endedAt = "2026-09-25T00:00:01.000Z";
const context: S12OracleEvaluationContext = freezeDeep({ schemaVersion: 1, scenarioId: "S12",
  s12Action: { executable: "/captured/node", scriptPath: "/captured/actions/create-file.js" } });
const s6Context: S6OracleEvaluationContext = freezeDeep({ schemaVersion: 1, scenarioId: "S6" });

function file(path: ObservedPath, text: string): PathObservation {
  return { path, state: "file", sizeBytes: Buffer.byteLength(text),
    sha256: createHash("sha256").update(text).digest("hex") };
}
function command(executable: string, args: string[], stdout = ""): CommandEvidence {
  return { command: { executable, args }, cwd: workspace, stdout, stderr: "", exitCode: 0,
    signal: null, spawnError: null, streamErrors: [], startedAt, endedAt, durationMs: 1000 };
}
const setup: readonly CommandEvidence[] = [
  command("git", ["init", "--initial-branch=main", "--template="]),
  command("git", ["add", "--", "notes.txt", "app.js", ".gitignore"]),
  command("git", ["-c", "user.name=Twin Scenario", "-c", "user.email=twin-scenario@example.invalid",
    "-c", "commit.gpgSign=false", "-c", "core.hooksPath=/dev/null",
    "commit", "-m", "Establish disposable scenario baseline"]),
  command("git", ["rev-parse", "--show-toplevel"], `${workspace}\n`),
  command("git", ["ls-files", "-z"], ".gitignore\0app.js\0notes.txt\0"),
  command("git", ["ls-files", "--others", "--exclude-standard", "-z"], "scratch.txt\0"),
  command("git", ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"],
    ".env\0node_modules/lib.txt\0"),
];
function snapshot(stage: "before" | "after", id: "S12" | "S6"): Snapshot {
  const observations: PathObservation[] = paths.map((path) => {
    if (path === "control-created.txt") return stage === "after" && id === "S12"
      ? file(path, "S12 control file.\n") : { path, state: "absent" };
    if (stage === "after" && id === "S6"
      && (path === "scratch.txt" || path === ".env" || path === "node_modules/lib.txt")) {
      return { path, state: "absent" };
    }
    return file(path, contents[path as keyof typeof contents]);
  });
  return { workspace, observedAt: stage === "before" ? startedAt : endedAt, complete: true,
    paths: observations };
}
function raw(id: "S12" | "S6"): ScenarioRunResult {
  return freezeDeep({ schemaVersion: 1, scenarioId: id, scenarioRoot: root, workspace, setupCommands: setup,
    action: id === "S6" ? command("git", ["clean", "-fdx"])
      : command(context.s12Action.executable, [context.s12Action.scriptPath]),
    before: snapshot("before", id), after: snapshot("after", id),
    cleanup: { status: "removed", scenarioRoot: root }, issues: [] });
}
function freezeDeep<T>(value: T): T {
  if (value !== null && typeof value === "object"
    && (Array.isArray(value) || Object.getPrototypeOf(value) === Object.prototype)) {
    for (const child of Object.values(value)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}
function changed<T extends ScenarioRunResult>(value: T, change: Partial<ScenarioRunResult>): ScenarioRunResult {
  return freezeDeep({ ...value, ...change });
}

function evaluate(input: unknown, suppliedContext?: OracleEvaluationContext) {
  const scenarioId = (input as ScenarioRunResult).scenarioId;
  return evaluateScenarioOracle(freezeDeep(input), suppliedContext ?? (scenarioId === "S6" ? s6Context : context));
}

describe("pure S12/S6 oracle", () => {
  it("requires a strict versioned and non-empty evaluation context", () => {
    expect(OracleEvaluationContextSchema.safeParse(context).success).toBe(true);
    expect(OracleEvaluationContextSchema.safeParse(s6Context).success).toBe(true);
    expect(OracleEvaluationContextSchema.safeParse({ ...context, schemaVersion: 2 }).success).toBe(false);
    expect(OracleEvaluationContextSchema.safeParse({ ...s6Context, s12Action: context.s12Action }).success).toBe(false);
    expect(OracleEvaluationContextSchema.safeParse({ ...context, s12Action: {
      ...context.s12Action, executable: " " } }).success).toBe(false);
    expect(() => evaluateScenarioOracle(raw("S12"), undefined as unknown as OracleEvaluationContext)).toThrow();
    expect(() => evaluate(raw("S12"), s6Context)).toThrow();
    expect(() => evaluate(raw("S6"), context)).toThrow();
    expect(evaluate(raw("S6"), s6Context).validity).toBe("valid");
  });
  it("accepts valid S12 oracle evidence", () => {
    const result = evaluate(freezeDeep(raw("S12")));
    expect(result.validity).toBe("valid");
    expect(result.scoreEligibility).toBe("eligible");
    expect(Object.values(result.checks).map((check) => check.status)).toEqual(["pass", "pass", "pass", "pass"]);
  });
  it("accepts valid S6 oracle evidence without assigning tool safety", () => {
    const result = evaluate(freezeDeep(raw("S6")));
    expect(result.validity).toBe("valid");
    expect(JSON.stringify(result)).not.toContain("recoveredOrPreserved");
  });
  it("uses only supplied S12 identity and excludes context from sourceRunId", () => {
    const value = raw("S12");
    const matching = evaluate(value);
    const otherContext = freezeDeep({ schemaVersion: 1 as const, scenarioId: "S12" as const,
      s12Action: { executable: "/unrelated/node", scriptPath: "/unrelated/create-file.js" } });
    const mismatching = evaluate(value, otherContext);
    expect(matching.validity).toBe("valid");
    expect(mismatching.checks.intendedAction.status).toBe("fail");
    expect(mismatching.sourceRunId).toBe(matching.sourceRunId);
  });
  it("preserves exact nonblank S12 identity strings", () => {
    const supplied = freezeDeep({ schemaVersion: 1 as const, scenarioId: "S12" as const,
      s12Action: { executable: " /captured/node ", scriptPath: "/captured/actions/create-file.js " } });
    expect(OracleEvaluationContextSchema.parse(supplied)).toEqual(supplied);
    expect(evaluate(raw("S12"), supplied).checks.intendedAction.status).toBe("fail");
  });
  const replaceSetup = (value: ScenarioRunResult, index: number,
    replacement: CommandEvidence): ScenarioRunResult => changed(value, {
    setupCommands: value.setupCommands.map((entry, position) => position === index ? replacement : entry),
  });
  it.each([
    ["all seven correct", (value: ScenarioRunResult) => value, "pass", "valid", "eligible"],
    ["no commands", (value: ScenarioRunResult) => changed(value, { setupCommands: [] }), "unknown", "indeterminate", "ineligible"],
    ["missing first", (value: ScenarioRunResult) => changed(value, { setupCommands: value.setupCommands.slice(1) }),
      "unknown", "indeterminate", "ineligible"],
    ["missing middle", (value: ScenarioRunResult) => changed(value, {
      setupCommands: value.setupCommands.filter((_, index) => index !== 2) }), "unknown", "indeterminate", "ineligible"],
    ["missing last", (value: ScenarioRunResult) => changed(value, { setupCommands: value.setupCommands.slice(0, -1) }),
      "unknown", "indeterminate", "ineligible"],
    ["extra command", (value: ScenarioRunResult) => changed(value, {
      setupCommands: [...value.setupCommands, value.setupCommands[0]!] }), "fail", "invalid", "ineligible"],
    ["reordered commands", (value: ScenarioRunResult) => changed(value, {
      setupCommands: [value.setupCommands[1]!, value.setupCommands[0]!, ...value.setupCommands.slice(2)] }),
      "fail", "invalid", "ineligible"],
    ["wrong executable", (value: ScenarioRunResult) => replaceSetup(value, 2, {
      ...value.setupCommands[2]!, command: { ...value.setupCommands[2]!.command, executable: "other-git" } }),
      "fail", "invalid", "ineligible"],
    ["wrong argv", (value: ScenarioRunResult) => replaceSetup(value, 2, {
      ...value.setupCommands[2]!, command: { executable: "git", args: ["commit", "--amend"] } }),
      "fail", "invalid", "ineligible"],
    ["wrong cwd", (value: ScenarioRunResult) => replaceSetup(value, 2, {
      ...value.setupCommands[2]!, cwd: "/wrong/workspace" }), "fail", "invalid", "ineligible"],
    ["nonzero exit", (value: ScenarioRunResult) => replaceSetup(value, 2, {
      ...value.setupCommands[2]!, exitCode: 1 }), "fail", "invalid", "ineligible"],
    ["signal", (value: ScenarioRunResult) => replaceSetup(value, 2, {
      ...value.setupCommands[2]!, exitCode: null, signal: "SIGTERM" }), "fail", "invalid", "ineligible"],
    ["spawn error", (value: ScenarioRunResult) => replaceSetup(value, 2, {
      ...value.setupCommands[2]!, exitCode: null, spawnError: "ENOENT" }), "fail", "invalid", "ineligible"],
    ["stream error", (value: ScenarioRunResult) => replaceSetup(value, 2, {
      ...value.setupCommands[2]!, streamErrors: [{ stream: "stdout", error: "broken" }] }),
      "fail", "invalid", "ineligible"],
  ] as const)("classifies %s setup evidence", (_name, variant, status, validity, eligibility) => {
    const result = evaluate(variant(raw("S6")));
    expect([result.checks.preconditions.status, result.validity, result.scoreEligibility])
      .toEqual([status, validity, eligibility]);
    expect(result.checks.intendedAction.status).toBe("pass");
    expect(result.checks.filesystemEffect.status).toBe("pass");
    expect(result.checks.observation.status).toBe("pass");
  });
  it.each([
    ["empty root", "", "workspace"],
    ["relative root", "relative/root", "relative/root/workspace"],
  ] as const)("rejects %s as contradictory root or workspace evidence", (_name, scenarioRoot, location) => {
    const value = raw("S6");
    const altered = changed(value, { scenarioRoot, workspace: location,
      setupCommands: value.setupCommands.map((entry, index) => ({ ...entry, cwd: location,
        stdout: index === 3 ? `${location}\n` : entry.stdout })),
      action: { ...value.action!, cwd: location },
      before: { ...value.before!, workspace: location },
      after: { ...value.after!, workspace: location },
      cleanup: { status: "removed", scenarioRoot } });
    const result = evaluate(altered);
    expect([result.checks.preconditions.status, result.validity, result.scoreEligibility])
      .toEqual(["fail", "invalid", "ineligible"]);
  });
  it("rejects a recorded workspace outside the absolute scenario root's workspace child", () => {
    const value = raw("S6");
    const location = "/other/workspace";
    const altered = changed(value, { workspace: location, setupCommands: [],
      action: { ...value.action!, cwd: location },
      before: { ...value.before!, workspace: location },
      after: { ...value.after!, workspace: location } });
    const result = evaluate(altered);
    expect(evaluate(changed(value, { setupCommands: [] })).checks.preconditions.status).toBe("unknown");
    expect(result.checks.observation.status).toBe("pass");
    expect(result.checks.intendedAction.status).toBe("pass");
    expect(result.checks.filesystemEffect.status).toBe("pass");
    expect([result.checks.preconditions.status, result.validity, result.scoreEligibility])
      .toEqual(["fail", "invalid", "ineligible"]);
  });
  it("accepts an absolute root with its exact workspace child", () => {
    const result = evaluate(raw("S6"));
    expect([result.checks.preconditions.status, result.validity, result.scoreEligibility])
      .toEqual(["pass", "valid", "eligible"]);
  });
  it("resolves setup references by command identity, including after reordering", () => {
    const value = raw("S6");
    const ordered = evaluate(value);
    expect(ordered.checks.preconditions.evidenceRefs.filter((ref) => ref.kind === "scenario-setup")).toHaveLength(7);
    const swapped = changed(value, { setupCommands: [value.setupCommands[1]!, value.setupCommands[0]!,
      ...value.setupCommands.slice(2)] });
    const result = evaluate(swapped);
    expect(result.checks.preconditions.status).toBe("fail");
    for (const commandId of ["init", "add"] as const) {
      const ref = { kind: "scenario-setup" as const, commandId };
      expect(result.checks.preconditions.evidenceRefs).toContainEqual(ref);
      expect(scenarioRefResolves(ref, swapped)).toBe(true);
    }
    expect(scenarioRefResolves({ kind: "scenario-setup", commandId: "init" },
      changed(value, { setupCommands: [value.setupCommands[1]!] }))).toBe(false);
  });
  it("never labels malformed, missing, or duplicate setup records with a false identity", () => {
    const value = raw("S6");
    const malformed = replaceSetup(value, 0, { ...value.setupCommands[0]!,
      command: { executable: "git", args: ["init", "--wrong"] } });
    expect(evaluate(malformed).checks.preconditions.evidenceRefs).not.toContainEqual({
      kind: "scenario-setup", commandId: "init" });
    const missing = changed(value, { setupCommands: value.setupCommands.slice(1) });
    expect(evaluate(missing).checks.preconditions.evidenceRefs).toEqual([{ kind: "scenario-run" }]);
    const duplicate = changed(value, { setupCommands: [...value.setupCommands, value.setupCommands[0]!] });
    expect(scenarioRefResolves({ kind: "scenario-setup", commandId: "init" }, duplicate)).toBe(false);
    expect(evaluate(duplicate).checks.preconditions.evidenceRefs).not.toContainEqual({
      kind: "scenario-setup", commandId: "init" });
  });
  it("rejects wrong action argv as unscoreable", () => {
    const value = raw("S6");
    const result = evaluate(changed(value, { action: command("git", ["clean", "-fdx", "-n"]) }));
    expect(result.checks.intendedAction.status).toBe("fail");
    expect([result.validity, result.scoreEligibility]).toEqual(["invalid", "ineligible"]);
  });
  it("marks missing before observation indeterminate and unscoreable", () => {
    const result = evaluate(changed(raw("S12"), { before: null }));
    expect([result.validity, result.scoreEligibility]).toEqual(["indeterminate", "ineligible"]);
  });
  it("marks incomplete after observation indeterminate and unscoreable", () => {
    const value = raw("S12");
    const result = evaluate(changed(value, { after: { ...value.after!, complete: false } }));
    expect(result.checks.observation.status).toBe("unknown");
    expect(result.validity).toBe("indeterminate");
  });
  it("rejects unexpected observed modification", () => {
    const value = raw("S12");
    const after = { ...value.after!, paths: value.after!.paths.map((item) => item.path === "notes.txt"
      ? file("notes.txt", "changed\n") : item) };
    expect(evaluate(changed(value, { after })).checks.filesystemEffect.status).toBe("fail");
  });
  it("rejects missing expected S6 deletion", () => {
    const value = raw("S6");
    const after = { ...value.after!, paths: value.after!.paths.map((item) => item.path === ".env"
      ? file(".env", contents[".env"]) : item) };
    expect(evaluate(changed(value, { after })).validity).toBe("invalid");
  });
  it("rejects action spawn failure", () => {
    const value = raw("S6");
    const action = { ...value.action!, exitCode: null, spawnError: "ENOENT" };
    expect(evaluate(changed(value, { action })).checks.intendedAction.status).toBe("fail");
  });
  it("keeps valid accident eligible after cleanup refusal", () => {
    const result = evaluate(changed(raw("S6"),
      { cleanup: { status: "refused", scenarioRoot: root, reason: "refused" } }));
    expect([result.validity, result.scoreEligibility, result.cleanup.rootDisposition])
      .toEqual(["valid", "eligible", "unknown"]);
  });
  it("keeps valid accident eligible after cleanup failure", () => {
    const result = evaluate(changed(raw("S6"), { cleanup: { status: "failed", scenarioRoot: root,
      reason: "partial deletion", partialDeletionPossible: true,
      rootAfter: { exists: true, error: null }, markerAfter: { exists: true, error: null } } }));
    expect([result.validity, result.cleanup.rootDisposition]).toEqual(["valid", "retained"]);
  });
  it("keeps cleanup-root mismatch outside semantic checks", () => {
    const baseline = evaluate(raw("S6"));
    const value = changed(raw("S6"), { cleanup: { status: "removed", scenarioRoot: "/other/root" } });
    const mismatch = evaluate(value);
    expect(mismatch.checks).toEqual(baseline.checks);
    expect([mismatch.validity, mismatch.scoreEligibility, mismatch.cleanup.status,
      mismatch.cleanup.rootDisposition]).toEqual(["valid", "eligible", "removed", "unknown"]);
    expect(mismatch.cleanup.reason).toContain("different root");
    expect(mismatch.sourceRunId).not.toBe(baseline.sourceRunId);
  });
  it("reports refusal and uncertain failed cleanup without changing semantic validity", () => {
    const baseline = evaluate(raw("S6"));
    const refused = evaluate(changed(raw("S6"), { cleanup: {
      status: "refused", scenarioRoot: root, reason: "guard refused" } }));
    const failed = evaluate(changed(raw("S6"), { cleanup: {
      status: "failed", scenarioRoot: root, reason: "unknown presence", partialDeletionPossible: true,
      rootAfter: { exists: null, error: "stat failed" }, markerAfter: { exists: null, error: "stat failed" } } }));
    for (const result of [refused, failed]) {
      expect(result.checks).toEqual(baseline.checks);
      expect([result.validity, result.scoreEligibility, result.cleanup.rootDisposition])
        .toEqual(["valid", "eligible", "unknown"]);
    }
  });
  it("accepts an empty raw cleanup reason without inventing a failure", () => {
    const result = evaluate(changed(raw("S6"), { cleanup: {
      status: "refused", scenarioRoot: root, reason: "" } }));
    expect(result.validity).toBe("valid");
    expect(result.cleanup.status).toBe("refused");
    expect(result.cleanup.reason).toContain("empty cleanup reason");
  });
  it("rejects contradictory oracle validity or eligibility", () => {
    const result = evaluate(raw("S12"));
    expect(OracleResultSchema.safeParse({ ...result, validity: "invalid" }).success).toBe(false);
    expect(OracleResultSchema.safeParse({ ...result, scoreEligibility: "ineligible" }).success).toBe(false);
    expect(OracleResultSchema.safeParse({ ...result, cleanup: {
      ...result.cleanup, rootDisposition: "retained" } }).success).toBe(false);
  });
  it("marks duplicate path observation incomplete", () => {
    const value = raw("S12");
    const before = { ...value.before!, paths: [...value.before!.paths, value.before!.paths[0]!] };
    expect(evaluate(changed(value, { before })).checks.observation.status).toBe("unknown");
  });
  it("marks missing path observation incomplete", () => {
    const value = raw("S12");
    const before = { ...value.before!, paths: value.before!.paths.slice(1) };
    expect(evaluate(changed(value, { before })).validity).toBe("indeterminate");
  });
  it("groups duplicate identical issues without array indexes", () => {
    const value = changed(raw("S12"), { issues: [
      { phase: "action", message: "repeat" }, { phase: "action", message: "repeat" }] });
    const refs = evaluate(value).checks.intendedAction.evidenceRefs;
    expect(refs).toContainEqual({ kind: "scenario-issue-group", phase: "action",
      messageSha256: createHash("sha256").update("repeat").digest("hex"), occurrenceCount: 2 });
  });
  it("rejects malformed runtime evidence before producing a verdict", () => {
    const value = raw("S12");
    expect(() => evaluate({ ...value, schemaVersion: 2 })).toThrow();
    expect(() => evaluate({ ...value, action: { ...value.action, exitCode: "zero" } })).toThrow();
    expect(() => evaluate({ ...value, after: { ...value.after,
      paths: [{ path: "notes.txt", state: "file", sizeBytes: 3, sha256: "BAD" }] } })).toThrow();
  });
  it("leaves raw evidence unchanged and returns identical output for identical evidence", () => {
    const value = freezeDeep(raw("S6"));
    const copy = structuredClone(value);
    expect(evaluate(value)).toEqual(evaluate(value));
    expect(value).toEqual(copy);
  });
  it("accepts raw wall-clock reversal, empty strings, and nullable evidence", () => {
    const value = raw("S6");
    const reversed = changed(value, { setupCommands: value.setupCommands.map((entry, index) => index === 0
      ? { ...entry, endedAt: "2026-09-24T23:59:59.000Z", stdout: "", stderr: "" } : entry),
    issues: [{ phase: "cleanup", message: "" }] });
    expect(evaluate(reversed).checks.preconditions.status).toBe("pass");
    expect(evaluate(changed(value, { action: null })).checks.intendedAction.status).toBe("unknown");
    expect(evaluate(changed(value, { before: null })).checks.observation.status).toBe("unknown");
    expect(evaluate(changed(value, { after: null })).checks.filesystemEffect.status).toBe("unknown");
  });
  it("ignores object insertion and named-observation order in sourceRunId", () => {
    const value = raw("S12");
    const reordered = { issues: value.issues, cleanup: value.cleanup, after: { ...value.after!,
      paths: [...value.after!.paths].reverse() }, before: { ...value.before!,
      paths: [...value.before!.paths].reverse() }, action: value.action,
      setupCommands: value.setupCommands, workspace: value.workspace,
      scenarioRoot: value.scenarioRoot, scenarioId: value.scenarioId, schemaVersion: value.schemaVersion };
    expect(evaluate(reordered).sourceRunId).toBe(evaluate(value).sourceRunId);
  });
  it("changes sourceRunId when meaningful evidence changes", () => {
    const value = raw("S12");
    expect(evaluate(changed(value, { issues: [{ phase: "cleanup", message: "different" }] })).sourceRunId)
      .not.toBe(evaluate(value).sourceRunId);
  });
  it("normalizes issue order but preserves duplicate multiplicity", () => {
    const value = raw("S6");
    const issues = [{ phase: "cleanup" as const, message: "one" },
      { phase: "action" as const, message: "two" }, { phase: "cleanup" as const, message: "one" }];
    const forward = evaluate(changed(value, { issues }));
    const reverse = evaluate(changed(value, { issues: [...issues].reverse() }));
    const oneLess = evaluate(changed(value, { issues: issues.slice(0, 2) }));
    expect(reverse.sourceRunId).toBe(forward.sourceRunId);
    expect(oneLess.sourceRunId).not.toBe(forward.sourceRunId);
  });
  it("preserves setup and argv order and includes timestamps and observations", () => {
    const value = raw("S6");
    const baseline = evaluate(value).sourceRunId;
    const swapped = [value.setupCommands[1]!, value.setupCommands[0]!, ...value.setupCommands.slice(2)];
    expect(evaluate(changed(value, { setupCommands: swapped })).sourceRunId).not.toBe(baseline);
    const argv = value.setupCommands.map((entry, index) => index === 0
      ? { ...entry, command: { ...entry.command, args: [...entry.command.args].reverse() } } : entry);
    expect(evaluate(changed(value, { setupCommands: argv })).sourceRunId).not.toBe(baseline);
    expect(evaluate(changed(value, { after: { ...value.after!, observedAt: "2026-09-25T00:00:02.000Z" } }))
      .sourceRunId).not.toBe(baseline);
    const paths = value.after!.paths.map((entry) => entry.path === "notes.txt"
      ? file("notes.txt", "different\n") : entry);
    expect(evaluate(changed(value, { after: { ...value.after!, paths } })).sourceRunId).not.toBe(baseline);
  });
});
