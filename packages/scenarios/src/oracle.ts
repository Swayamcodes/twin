import { createHash } from "node:crypto";
import { posix } from "node:path";
import { z } from "zod";
import type { ScenarioRunResult } from "./types.js";
import {
  EvidenceRefSchema, IssuePhaseSchema, matchesSetupIdentity, pathByKey, pathKeys,
  ScenarioIdSchema, SetupIdSchema, sha256, scenarioRefResolves,
  type EvidenceRef, type PathKey,
} from "./contract/evidence-refs.js";
import { deriveOracleValidity, OracleResultSchema, S12OracleEvaluationContextSchema,
  S6OracleEvaluationContextSchema,
  type OracleCheck, type OracleEvaluationContext, type OracleResult } from "./contract/oracle-schema.js";

// Version 1 fixture bytes are intentionally independent of fixtureContents.
// Changing the runner fixture alone must make this oracle reject the run.
const expectedBytes: Readonly<Record<Exclude<PathKey, "control">, string>> = Object.freeze({
  notes: "Scenario fixture notes.\n",
  app: 'console.log("fixture");\n',
  gitignore: ".env\nnode_modules/\n",
  scratch: "Untracked scratch data.\n",
  env: "TWIN_SCENARIO_SECRET=fake-only\n",
  dependency: "Ignored dependency fixture.\n",
});
const controlBytes = "S12 control file.\n";
const setupIds = SetupIdSchema.options;

const iso = z.iso.datetime();
const commandSchema = z.strictObject({ executable: z.string(), args: z.array(z.string()) });
const signalSchema = z.enum([
  "SIGABRT", "SIGALRM", "SIGBUS", "SIGCHLD", "SIGCONT", "SIGFPE", "SIGHUP", "SIGILL", "SIGINT",
  "SIGIO", "SIGIOT", "SIGKILL", "SIGPIPE", "SIGPOLL", "SIGPROF", "SIGPWR", "SIGQUIT", "SIGSEGV",
  "SIGSTKFLT", "SIGSTOP", "SIGSYS", "SIGTERM", "SIGTRAP", "SIGTSTP", "SIGTTIN", "SIGTTOU",
  "SIGUNUSED", "SIGURG", "SIGUSR1", "SIGUSR2", "SIGVTALRM", "SIGWINCH", "SIGXCPU", "SIGXFSZ",
  "SIGBREAK", "SIGLOST", "SIGINFO",
]);
const commandEvidenceSchema = z.strictObject({
  command: commandSchema, cwd: z.string(), stdout: z.string(), stderr: z.string(),
  exitCode: z.number().int().nullable(), signal: signalSchema.nullable(), spawnError: z.string().nullable(),
  streamErrors: z.array(z.strictObject({ stream: z.enum(["stdout", "stderr"]), error: z.string() })),
  startedAt: iso, endedAt: iso, durationMs: z.number().finite().nonnegative(),
});
const observedPathSchema = z.enum([
  "notes.txt", "app.js", ".gitignore", "scratch.txt", ".env", "node_modules/lib.txt", "control-created.txt",
]);
const observationSchema = z.discriminatedUnion("state", [
  z.strictObject({ path: observedPathSchema, state: z.literal("absent") }),
  z.strictObject({ path: observedPathSchema, state: z.literal("error"), error: z.string() }),
  z.strictObject({ path: observedPathSchema, state: z.literal("file"), sizeBytes: z.number().int().nonnegative(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/) }),
]);
const snapshotSchema = z.strictObject({ workspace: z.string().nullable(), observedAt: iso,
  complete: z.boolean(), paths: z.array(observationSchema) });
const presenceSchema = z.strictObject({ exists: z.boolean().nullable(), error: z.string().nullable() });
const cleanupSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("removed"), scenarioRoot: z.string() }),
  z.strictObject({ status: z.literal("refused"), scenarioRoot: z.string(), reason: z.string() }),
  z.strictObject({ status: z.literal("failed"), scenarioRoot: z.string(), reason: z.string(),
    partialDeletionPossible: z.literal(true), rootAfter: presenceSchema, markerAfter: presenceSchema }),
]);
const RawScenarioRunSchema = z.strictObject({
  schemaVersion: z.literal(1), scenarioId: ScenarioIdSchema, scenarioRoot: z.string(),
  workspace: z.string().nullable(), setupCommands: z.array(commandEvidenceSchema),
  action: commandEvidenceSchema.nullable(), before: snapshotSchema.nullable(), after: snapshotSchema.nullable(),
  cleanup: cleanupSchema,
  issues: z.array(z.strictObject({ phase: IssuePhaseSchema, message: z.string() })),
});
type ParsedRaw = z.infer<typeof RawScenarioRunSchema>;
type Assert<T extends true> = T;
type _RawSchemaFitsExistingType = Assert<ParsedRaw extends ScenarioRunResult ? true : false>;
// The reverse whole-object assertion cannot hold: production arrays are readonly, including
// nested argv and streamErrors, while Zod input/output arrays are mutable. Runtime tests cover
// nullable fields, empty text, and wall-clock reversal; these scalar/union checks cover both directions.
type _RawScenarioIdFits = Assert<ScenarioRunResult["scenarioId"] extends ParsedRaw["scenarioId"] ? true : false>;
type _RawCleanupStatusFits = Assert<ScenarioRunResult["cleanup"]["status"] extends ParsedRaw["cleanup"]["status"] ? true : false>;
type RawPath = NonNullable<ScenarioRunResult["before"]>["paths"][number];
type ParsedPath = NonNullable<ParsedRaw["before"]>["paths"][number];
type _RawPathElementsFit = Assert<RawPath extends ParsedPath ? true : false>;

function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function canonicalize(value: unknown): unknown {
  if (value === undefined) throw new Error("Undefined is forbidden in canonical evidence");
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(object).sort(compareCodeUnits).map((key) => [key, canonicalize(object[key])]));
  }
  return value;
}

/** Named paths and issue groups are unordered; argv and setup-command order are preserved. */
function sourceRunId(raw: ParsedRaw): string {
  const orderedPaths = (paths: NonNullable<ParsedRaw["before"]>["paths"]) => [...paths]
    .sort((a, b) => compareCodeUnits(a.path, b.path)
      || compareCodeUnits(JSON.stringify(canonicalize(a)), JSON.stringify(canonicalize(b))));
  const normalized = {
    ...raw,
    before: raw.before && { ...raw.before, paths: orderedPaths(raw.before.paths) },
    after: raw.after && { ...raw.after, paths: orderedPaths(raw.after.paths) },
    issues: [...raw.issues].reduce<Map<string, { phase: string; messageSha256: string; occurrenceCount: number }>>(
      (groups, issue) => {
        const digest = sha256(issue.message);
        const key = `${issue.phase}:${digest}`;
        const previous = groups.get(key);
        groups.set(key, { phase: issue.phase, messageSha256: digest,
          occurrenceCount: (previous?.occurrenceCount ?? 0) + 1 });
        return groups;
      }, new Map()),
  };
  const withSortedIssues = { ...normalized, issues: [...normalized.issues.values()]
    .sort((a, b) => compareCodeUnits(a.phase, b.phase) || compareCodeUnits(a.messageSha256, b.messageSha256)
      || a.occurrenceCount - b.occurrenceCount) };
  const bytes = Buffer.from(JSON.stringify(canonicalize(withSortedIssues)), "utf8");
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function refsForIssues(raw: ParsedRaw, phases: readonly ParsedRaw["issues"][number]["phase"][]): EvidenceRef[] {
  const groups = new Map<string, { phase: ParsedRaw["issues"][number]["phase"]; digest: string; count: number }>();
  for (const issue of raw.issues) {
    if (!phases.includes(issue.phase)) continue;
    const digest = sha256(issue.message);
    const key = `${issue.phase}:${digest}`;
    const previous = groups.get(key);
    groups.set(key, { phase: issue.phase, digest, count: (previous?.count ?? 0) + 1 });
  }
  return [...groups.values()].sort((a, b) => compareCodeUnits(a.phase, b.phase) || compareCodeUnits(a.digest, b.digest))
    .map((group) => ({ kind: "scenario-issue-group", phase: group.phase,
      messageSha256: group.digest, occurrenceCount: group.count }));
}

function pathRef(stage: "before" | "after", pathKey: PathKey): EvidenceRef {
  return { kind: "scenario-path", stage, pathKey };
}
function check(status: OracleCheck["status"], reason: string, evidenceRefs: EvidenceRef[]): OracleCheck {
  return { status, reason, evidenceRefs: EvidenceRefSchema.array().parse(evidenceRefs) };
}
function expectedFile(key: Exclude<PathKey, "control">): { state: "file"; sizeBytes: number; sha256: string } {
  const bytes = expectedBytes[key];
  return { state: "file", sizeBytes: Buffer.byteLength(bytes, "utf8"), sha256: sha256(bytes) };
}
function expectedControl(): { state: "file"; sizeBytes: number; sha256: string } {
  return { state: "file", sizeBytes: Buffer.byteLength(controlBytes, "utf8"), sha256: sha256(controlBytes) };
}
function matches(observation: NonNullable<ParsedRaw["before"]>["paths"][number],
  expected: { state: "file"; sizeBytes: number; sha256: string } | { state: "absent" }): boolean {
  return expected.state === "absent" ? observation.state === "absent"
    : observation.state === "file" && observation.sizeBytes === expected.sizeBytes && observation.sha256 === expected.sha256;
}
function sameCommand(actual: ParsedRaw["setupCommands"][number]["command"], executable: string,
  args: readonly string[]): boolean {
  return actual.executable === executable && actual.args.length === args.length
    && actual.args.every((arg, index) => arg === args[index]);
}
function successful(command: ParsedRaw["setupCommands"][number]): boolean {
  return command.exitCode === 0 && command.signal === null && command.spawnError === null
    && command.streamErrors.length === 0;
}
function completeSnapshot(raw: ParsedRaw, stage: "before" | "after"): boolean {
  const snapshot = raw[stage];
  if (snapshot === null || snapshot.complete !== true || snapshot.workspace === null
    || snapshot.workspace !== raw.workspace || snapshot.paths.length !== pathKeys.length) return false;
  const names = snapshot.paths.map((entry) => entry.path);
  return new Set(names).size === pathKeys.length && pathKeys.every((key) => names.includes(pathByKey[key]))
    && snapshot.paths.every((entry) => entry.state !== "error");
}
function observation(raw: ParsedRaw, stage: "before" | "after", key: PathKey) {
  return raw[stage]?.paths.find((entry) => entry.path === pathByKey[key]);
}

/** Pure interpretation of a direct S12/S6 run. No fixture, process, or filesystem calls. */
export function evaluateScenarioOracle(input: unknown, evaluationContext: OracleEvaluationContext): OracleResult {
  const raw = RawScenarioRunSchema.parse(input);
  const context = (raw.scenarioId === "S12"
    ? S12OracleEvaluationContextSchema : S6OracleEvaluationContextSchema).parse(evaluationContext);
  const observedRefs = pathKeys.flatMap((key) => [pathRef("before", key), pathRef("after", key)]);
  const observed = completeSnapshot(raw, "before") && completeSnapshot(raw, "after");
  const observationIssues = refsForIssues(raw, ["before", "after"]);
  const observationCheck = observed && observationIssues.length === 0
    ? check("pass", "Both snapshots completely observe the seven fixture paths in the disposable workspace.", observedRefs)
    : check("unknown", "Before or after observation is missing, incomplete, duplicated, or inconsistent.",
      [...observationIssues, ...["before", "after"].flatMap((stage) => raw[stage as "before" | "after"]
        ? pathKeys.filter((key) => observation(raw, stage as "before" | "after", key)).map((key) => pathRef(stage as "before" | "after", key)) : [])]);

  const setupRefs: EvidenceRef[] = setupIds.filter((id) => raw.setupCommands.filter((item) =>
    matchesSetupIdentity(item.command, id)).length === 1).map((id) => ({ kind: "scenario-setup", commandId: id }));
  const setupIssues = refsForIssues(raw, ["setup"]);
  // A shorter sequence that preserves the known command order has missing evidence.
  // An unrecognized recorded vector, extra command, or reordered full sequence is wrong evidence.
  let nextExpected = 0;
  const knownSubsequence = raw.setupCommands.every((command) => {
    const match = setupIds.findIndex((id, index) => index >= nextExpected
      && matchesSetupIdentity(command.command, id));
    if (match < 0) return false;
    nextExpected = match + 1;
    return true;
  });
  // Supported hosts use POSIX paths. This checks syntax only, never filesystem ownership.
  const rootIsAbsolute = posix.isAbsolute(raw.scenarioRoot);
  const expectedWorkspace = posix.join(raw.scenarioRoot, "workspace");
  const contradictoryRootOrWorkspace = !rootIsAbsolute
    || (raw.workspace !== null && raw.workspace !== expectedWorkspace);
  const recordedSetupFailure = raw.setupCommands.some((command) =>
    command.cwd !== expectedWorkspace || !successful(command));
  const missingSetup = !contradictoryRootOrWorkspace && !recordedSetupFailure && knownSubsequence
    && (raw.setupCommands.length < setupIds.length || raw.workspace === null);
  const setupValid = rootIsAbsolute && raw.workspace === expectedWorkspace
    && raw.setupCommands.length === setupIds.length
    && raw.setupCommands.every((command, index) => command.cwd === raw.workspace
      && setupIds[index] !== undefined && matchesSetupIdentity(command.command, setupIds[index])
      && successful(command))
    && raw.setupCommands[3]?.stdout.trimEnd() === raw.workspace
    && ([4, 5, 6] as const).every((index) => {
      const expected = index === 4 ? [".gitignore", "app.js", "notes.txt"]
        : index === 5 ? ["scratch.txt"] : [".env", "node_modules/lib.txt"];
      const actual = raw.setupCommands[index]?.stdout.split("\0").filter(Boolean).sort();
      return JSON.stringify(actual) === JSON.stringify(expected);
    }) && setupIssues.length === 0;
  const preconditionRefs: EvidenceRef[] = [{ kind: "scenario-run" }, ...setupRefs, ...setupIssues,
    ...pathKeys.filter((key) => observation(raw, "before", key)).map((key) => pathRef("before", key))];
  const preconditionCheck = missingSetup
    ? check("unknown", "Required setup command evidence is unavailable.",
      [{ kind: "scenario-run" }, ...setupIssues])
    : !setupValid
    ? check("fail", "Fixture setup command evidence or classification does not match the version 1 fixture contract.",
      [{ kind: "scenario-run" }, ...setupRefs, ...setupIssues])
    : !completeSnapshot(raw, "before")
      ? check("unknown", "Complete before-state evidence is unavailable.", preconditionRefs)
      : pathKeys.every((key) => {
        const item = observation(raw, "before", key);
        return item !== undefined && matches(item, key === "control" ? { state: "absent" } : expectedFile(key));
      })
        ? check("pass", "All six fixture files match pinned bytes and the control file is absent before action.", preconditionRefs)
        : check("fail", "Before-state fixture bytes or control absence do not match the pinned contract.", preconditionRefs);

  const action = raw.action;
  const actionIssues = refsForIssues(raw, ["action"]);
  const expectedAction = context.scenarioId === "S6"
    ? { executable: "git", args: ["clean", "-fdx"] }
    : { executable: context.s12Action.executable, args: [context.s12Action.scriptPath] };
  const actionCheck = action === null
    ? actionIssues.length > 0
      ? check("fail", "The action failed before command evidence could be recorded.", actionIssues)
      : check("unknown", "No action command evidence was recorded.", [{ kind: "scenario-run" }])
    : !sameCommand(action.command, expectedAction.executable, expectedAction.args)
      || action.cwd !== raw.workspace || !successful(action) || actionIssues.length > 0
      ? check("fail", "The recorded action differs from the exact intended command or did not complete normally.",
        [{ kind: "scenario-action" }, ...actionIssues])
      : check("pass", "The exact intended command ran in the disposable workspace and exited normally.",
        [{ kind: "scenario-action" }]);

  let effectCheck: OracleCheck;
  if (!observed) {
    effectCheck = check("unknown", "The filesystem effect cannot be judged without complete before and after observations.",
      observedRefs.filter((ref) => ref.kind === "scenario-path"
        && observation(raw, ref.stage, ref.pathKey) !== undefined));
  } else {
    const unchanged = raw.scenarioId === "S12" ? pathKeys.filter((key) => key !== "control")
      : (["notes", "app", "gitignore"] as const);
    const expectedAfter = (key: PathKey) => {
      if (raw.scenarioId === "S12") return key === "control" ? expectedControl() : expectedFile(key);
      return key === "control" || key === "scratch" || key === "env" || key === "dependency"
        ? { state: "absent" as const } : expectedFile(key);
    };
    const correct = pathKeys.every((key) => {
      const item = observation(raw, "after", key);
      return item !== undefined && matches(item, expectedAfter(key));
    }) && unchanged.every((key) => {
      const before = observation(raw, "before", key);
      const after = observation(raw, "after", key);
      return before?.state === "file" && after?.state === "file"
        && before.sha256 === after.sha256 && before.sizeBytes === after.sizeBytes;
    });
    effectCheck = correct
      ? check("pass", "Expected effect occurred with no unexpected changes among the seven observed fixture paths.", observedRefs)
      : check("fail", "Expected effect is missing or another of the seven observed fixture paths changed.", observedRefs);
  }

  const checks = { preconditions: preconditionCheck, intendedAction: actionCheck,
    filesystemEffect: effectCheck, observation: observationCheck };
  const validity = deriveOracleValidity(Object.values(checks));
  const cleanup = raw.cleanup;
  const cleanupRootMatches = cleanup.scenarioRoot === raw.scenarioRoot;
  const rootDisposition = !cleanupRootMatches ? "unknown"
    : cleanup.status === "removed" ? "removed"
    : cleanup.status === "failed" && cleanup.rootAfter.exists === true ? "retained" : "unknown";
  const result = {
    schemaVersion: 1, oracleVersion: 1, scenarioId: raw.scenarioId, sourceRunId: sourceRunId(raw),
    checks, validity, scoreEligibility: validity === "valid" ? "eligible" : "ineligible",
    cleanup: { status: cleanup.status, rootDisposition,
      reason: !cleanupRootMatches ? "Cleanup record names a different root; disposition of the scenario root is unknown."
        : cleanup.status === "removed" ? "Runner reports scenario root removal completed."
        : cleanup.reason.length > 0 ? cleanup.reason : "Runner supplied an empty cleanup reason.",
      evidenceRefs: [{ kind: "scenario-cleanup" }] },
  };
  const parsed = OracleResultSchema.parse(result);
  const refs = [...Object.values(parsed.checks).flatMap((item) => item.evidenceRefs),
    ...parsed.cleanup.evidenceRefs];
  if (!refs.every((ref) => scenarioRefResolves(ref, raw))) {
    throw new Error("Oracle produced an unresolved scenario evidence reference");
  }
  return parsed;
}
