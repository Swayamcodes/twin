import { z } from "zod";
import { Buffer } from "node:buffer";
import type { ScenarioRunResult } from "../types.js";
import { PathKeySchema, Sha256Schema } from "../contract/evidence-refs.js";
import { OracleEvaluationContextSchema } from "../contract/oracle-schema.js";
import { ArtifactIdSchema, SegmentIdSchema, CaptureIdSchema, TimestampSchema, ExecutionSchema,
  OriginalStateObservationSchema, WorkspaceInputSchema, EvidenceAvailabilitySchema, KnownVersionSchema,
  ToolRunIdSchema } from "../contract/normalized-evidence-schema.js";
import { AttemptRequestSchema, RequestIdSchema, FixtureSetupObservationSchema, WorkspaceBindingObservationSchema,
  ToolBoundaryObservationSchema, WorkspaceStateObservationSchema, SourceBindingObservationSchema, AttemptDispositionSchema } from "../contract/attempt-protocol-schema.js";

/** Byte limits include JSON encoding overhead. No format accepts arbitrary extension bags. */
export const FILE_LIMITS = Object.freeze({ "reservation.json": 16_384, "capture.json": 2_097_152,
  "outcome.json": 32_768, "manifest.json": 4_096 });
export const LIMITS = Object.freeze({ outputBytes: 65_536, events: 64, observations: 128, fingerprints: 7,
  encodedBytes: 87_384, issues: 16, errorBytes: 4_096, privateStringBytes: 4_096, identifierBytes: 128, array: 256, depth: 32, nodes: 30_000 });
export const FileNameSchema = z.enum(["reservation.json", "capture.json", "outcome.json", "manifest.json"]);
export type FileName = z.infer<typeof FileNameSchema>;
const bytes = (max: number) => z.string().max(max).refine((s) => new TextEncoder().encode(s).length <= max);
const privateText = bytes(LIMITS.privateStringBytes), errorText = bytes(LIMITS.errorBytes);
const token = (prefix: string) => bytes(LIMITS.identifierBytes).regex(new RegExp(`^${prefix}:[A-Za-z0-9][A-Za-z0-9_-]{0,63}(?![\\s\\S])`));
const versions = { privateFormatVersion: z.literal(1), normalizerVersion: z.literal(1) };
const header = { ...versions, artifactId: ArtifactIdSchema };
const absent = z.strictObject({ status: z.literal("not-started"),
  reason: z.enum(["reference-invalid", "reference-indeterminate", "reservation-failed", "collector-failed", "not-requested"]) });
const signal = z.enum(["SIGABRT", "SIGALRM", "SIGBUS", "SIGCHLD", "SIGCONT", "SIGFPE", "SIGHUP", "SIGILL", "SIGINT",
  "SIGIO", "SIGIOT", "SIGKILL", "SIGPIPE", "SIGPOLL", "SIGPROF", "SIGPWR", "SIGQUIT", "SIGSEGV", "SIGSTKFLT",
  "SIGSTOP", "SIGSYS", "SIGTERM", "SIGTRAP", "SIGTSTP", "SIGTTIN", "SIGTTOU", "SIGUNUSED", "SIGURG", "SIGUSR1",
  "SIGUSR2", "SIGVTALRM", "SIGWINCH", "SIGXCPU", "SIGXFSZ", "SIGBREAK", "SIGLOST", "SIGINFO"]);
export const RawCommandSchema = z.strictObject({ command: z.strictObject({ executable: privateText,
  args: z.array(privateText).max(LIMITS.events) }), cwd: privateText,
  stdout: bytes(LIMITS.outputBytes), stderr: bytes(LIMITS.outputBytes), exitCode: z.number().int().nullable(),
  signal: signal.nullable(), spawnError: errorText.nullable(),
  streamErrors: z.array(z.strictObject({ stream: z.enum(["stdout", "stderr"]), error: errorText })).max(LIMITS.events),
  startedAt: z.iso.datetime(), endedAt: z.iso.datetime(), durationMs: z.number().finite().nonnegative() });
const path = z.enum(["notes.txt", "app.js", ".gitignore", "scratch.txt", ".env", "node_modules/lib.txt", "control-created.txt"]);
export const RawPathSchema = z.discriminatedUnion("state", [
  z.strictObject({ path, state: z.literal("absent") }), z.strictObject({ path, state: z.literal("error"), error: errorText }),
  z.strictObject({ path, state: z.literal("file"), sizeBytes: z.number().int().nonnegative(), sha256: Sha256Schema }),
]);
const snapshot = z.strictObject({ workspace: privateText.nullable(), observedAt: z.iso.datetime(), complete: z.boolean(),
  paths: z.array(RawPathSchema).max(LIMITS.observations) });
const presence = z.strictObject({ exists: z.boolean().nullable(), error: errorText.nullable() });
export const RawCleanupSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("removed"), scenarioRoot: privateText }),
  z.strictObject({ status: z.literal("refused"), scenarioRoot: privateText, reason: errorText }),
  z.strictObject({ status: z.literal("failed"), scenarioRoot: privateText, reason: errorText,
    partialDeletionPossible: z.literal(true), rootAfter: presence, markerAfter: presence }),
]);
export const PrivateRawReferenceSchema = z.strictObject({ schemaVersion: z.literal(1), scenarioId: z.enum(["S12", "S6"]),
  scenarioRoot: privateText, workspace: privateText.nullable(), setupCommands: z.array(RawCommandSchema).max(LIMITS.events),
  action: RawCommandSchema.nullable(), before: snapshot.nullable(), after: snapshot.nullable(), cleanup: RawCleanupSchema,
  issues: z.array(z.strictObject({ phase: z.enum(["setup", "before", "action", "after", "cleanup"]), message: errorText })).max(LIMITS.events) });
type Assert<T extends true> = T;
type ParsedRaw = z.infer<typeof PrivateRawReferenceSchema>;
type _FitsRaw = Assert<ParsedRaw extends ScenarioRunResult ? true : false>;
// Whole-object reverse assignment is blocked only by readonly production arrays.
// Scalar/union compatibility plus runtime coverage protects all raw variants.
type _FitsPaths = Assert<NonNullable<ScenarioRunResult["before"]>["paths"][number] extends z.infer<typeof RawPathSchema> ? true : false>;
type _FitsCleanup = Assert<ScenarioRunResult["cleanup"] extends z.infer<typeof RawCleanupSchema> ? true : false>;
type _FitsSignal = Assert<NonNullable<ScenarioRunResult["action"]>["signal"] extends z.infer<typeof signal> | null ? true : false>;

/** Bounds before nested Zod traversal, including reused public record components. */
function boundedTree(value: unknown): boolean {
  let nodes = 0, stringBytes = 0;
  const seen = new Set<object>();
  function visit(item: unknown, depth: number): boolean {
    if (++nodes > LIMITS.nodes || depth > LIMITS.depth) return false;
    if (typeof item === "string") {
      if (item.length > LIMITS.encodedBytes) return false;
      const size = new TextEncoder().encode(item).length;
      stringBytes += size;
      return size <= LIMITS.encodedBytes && stringBytes <= FILE_LIMITS["capture.json"];
    }
    if (item === null || typeof item !== "object") return typeof item !== "undefined";
    if (seen.has(item)) return false;
    seen.add(item);
    const values = Array.isArray(item) ? item : Object.values(item);
    const valid = values.length <= LIMITS.array && values.every((child) => visit(child, depth + 1));
    seen.delete(item);
    return valid;
  }
  return visit(value, 0);
}
const bounded = <T extends z.ZodType>(schema: T) => z.unknown().refine(boundedTree).pipe(schema);
const request = AttemptRequestSchema.refine((v) => v.scenarioId === "S12" && v.action.actionId === "create-control-file");
export const ReservationSchema = bounded(z.strictObject({ ...header, referenceId: token("reference"),
  attempt: z.discriminatedUnion("status", [absent, z.strictObject({ status: z.literal("reserved"), request })]) }));
export const StreamBytesSchema = z.strictObject({ encoding: z.literal("base64"),
  data: z.string().max(LIMITS.encodedBytes).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?(?![\s\S])/),
  decodedBytes: z.number().int().nonnegative().max(LIMITS.outputBytes),
}).superRefine((value, ctx) => {
  if (value.data.length > LIMITS.encodedBytes) return;
  const decoded = Buffer.from(value.data, "base64");
  if (decoded.length !== value.decodedBytes || decoded.length > LIMITS.outputBytes || decoded.toString("base64") !== value.data) {
    ctx.addIssue({ code: "custom", message: "Invalid bounded canonical bytes" });
  }
});
export const StreamSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("complete"), bytes: StreamBytesSchema, captureId: CaptureIdSchema, segmentId: SegmentIdSchema }),
  z.strictObject({ status: z.literal("partial"), bytes: StreamBytesSchema, reason: z.enum(["capture-incomplete", "collector-failed"]),
    captureId: CaptureIdSchema, segmentId: SegmentIdSchema }),
  z.strictObject({ status: z.literal("unavailable"), reason: z.enum(["not-captured", "collector-failed"]),
    captureId: CaptureIdSchema, segmentId: SegmentIdSchema }),
]);
const observations = <T extends z.ZodType>(schema: T) => z.array(schema).max(LIMITS.observations);
/** Recorded components, not an authoritative normalized evidence or protocol envelope. */
export const AttemptCaptureSchema = bounded(z.strictObject({ request, toolVersion: KnownVersionSchema,
  observerSegmentId: SegmentIdSchema, startedAt: TimestampSchema, endedAt: TimestampSchema,
  stdout: StreamSchema, stderr: StreamSchema, availability: EvidenceAvailabilitySchema,
  events: z.array(ExecutionSchema).max(LIMITS.events), originalStates: observations(OriginalStateObservationSchema),
  workspaceInputs: observations(WorkspaceInputSchema),
  setup: observations(FixtureSetupObservationSchema.extend({ paths: z.array(FixtureSetupObservationSchema.shape.paths.element).max(7) })),
  workspaceBindings: observations(WorkspaceBindingObservationSchema), toolBoundaries: observations(ToolBoundaryObservationSchema),
  workspaceStates: observations(WorkspaceStateObservationSchema), sourceBindings: observations(SourceBindingObservationSchema),
  fingerprints: z.array(z.strictObject({ pathKey: PathKeySchema, sha256: Sha256Schema,
    sizeBytes: z.number().int().nonnegative() })).max(LIMITS.fingerprints),
}).superRefine((value, ctx) => {
  const facts = [...value.events, ...value.originalStates, ...value.workspaceInputs];
  const protocol = [...value.setup, ...value.workspaceBindings, ...value.toolBoundaries, ...value.workspaceStates, ...value.sourceBindings];
  const unique = (ids: string[]) => new Set(ids).size === ids.length;
  if (!unique(facts.map((v) => v.factId)) || !unique(protocol.map((v) => v.observationId))
    || !unique([value.stdout.captureId, value.stderr.captureId])
    || !unique([value.observerSegmentId, value.stdout.segmentId, value.stderr.segmentId])) {
    ctx.addIssue({ code: "custom", message: "Duplicate private identity" });
  }
  for (const item of [...facts, ...protocol]) {
    if (item.toolRunId !== value.request.toolRunId || item.scenarioId !== value.request.scenarioId
      || "requestId" in item && item.requestId !== value.request.requestId) ctx.addIssue({ code: "custom", message: "Private ownership mismatch" });
    if (item.provenance.kind !== "independent" || item.provenance.evidenceRefs.some((ref) => ref.segmentId !== value.observerSegmentId)) {
      ctx.addIssue({ code: "custom", message: "Unresolved private observer" });
    }
  }
  for (const setup of value.setup) for (const entry of setup.paths) {
    if (!value.originalStates.some((v) => v.factId === entry.originalFactId && v.pathKey === entry.pathKey && v.stage === "before")) {
      ctx.addIssue({ code: "custom", message: "Unresolved original observation" });
    }
  }
  for (const boundary of value.toolBoundaries) if (boundary.actionObservation.status === "known") {
    const id = boundary.actionObservation.factId;
    if (!value.events.some((v) => v.factId === id)) ctx.addIssue({ code: "custom", message: "Unresolved action observation" });
  }
}));
const reference = z.strictObject({ referenceId: token("reference"), raw: PrivateRawReferenceSchema,
  context: OracleEvaluationContextSchema }).refine((v) => v.raw.scenarioId === v.context.scenarioId)
  .refine((v) => v.context.scenarioId !== "S12" || [v.context.s12Action.executable, v.context.s12Action.scriptPath]
    .every((s) => new TextEncoder().encode(s).length <= LIMITS.privateStringBytes));
export const CaptureSchema = bounded(z.strictObject({ ...header, reference,
  attempt: z.discriminatedUnion("status", [absent, z.strictObject({ status: z.literal("captured"), record: AttemptCaptureSchema })]) }).superRefine((value, ctx) => {
  if (value.attempt.status !== "captured") return;
  const a = value.attempt.record;
  for (const item of [...a.events, ...a.originalStates, ...a.workspaceInputs, ...a.setup, ...a.workspaceBindings, ...a.toolBoundaries, ...a.workspaceStates, ...a.sourceBindings]) {
    if (item.provenance.evidenceRefs.some((ref) => ref.artifactId !== value.artifactId)) ctx.addIssue({ code: "custom", message: "Private artifact ownership mismatch" });
  }
}));
export const OutcomeSchema = bounded(z.strictObject({ ...header,
  attempt: z.discriminatedUnion("status", [absent, z.strictObject({ status: z.literal("collected"), toolRunId: ToolRunIdSchema,
    requestId: RequestIdSchema, cleanup: AttemptDispositionSchema.shape.cleanup })]),
  errors: z.array(z.strictObject({ phase: z.enum(["reference", "attempt", "collection"]), message: errorText })).max(LIMITS.events) }));
export const ManifestSchema = bounded(z.strictObject({ ...header,
  artifactKind: z.enum(["reference-only-failure", "reference-plus-attempt"]), completeness: z.literal("complete"),
  inventory: z.array(z.strictObject({ name: z.enum(["reservation.json", "capture.json", "outcome.json"]),
    sizeBytes: z.number().int().positive(), sha256: Sha256Schema })).length(3),
}).superRefine((v, ctx) => {
  if (new Set(v.inventory.map((entry) => entry.name)).size !== 3
    || v.inventory.some((entry) => entry.sizeBytes > FILE_LIMITS[entry.name])) ctx.addIssue({ code: "custom", message: "Invalid inventory" });
}));
const complete = { reservation: ReservationSchema, capture: CaptureSchema, outcome: OutcomeSchema };
const consistent = (v: { reservation: Reservation; capture: Capture; outcome: Outcome }): boolean => {
  if (v.reservation.artifactId !== v.capture.artifactId || v.capture.artifactId !== v.outcome.artifactId
    || v.reservation.referenceId !== v.capture.reference.referenceId) return false;
  const a = v.reservation.attempt, b = v.capture.attempt, c = v.outcome.attempt;
  if (b.status === "not-started") return c.status === "not-started" && b.reason === c.reason
    && (a.status === "reserved" || a.reason === b.reason);
  return a.status === "reserved" && c.status === "collected" && a.request.toolRunId === b.record.request.toolRunId
    && a.request.requestId === b.record.request.requestId && c.toolRunId === a.request.toolRunId && c.requestId === a.request.requestId
    && v.capture.reference.raw.scenarioId === "S12"
    && c.cleanup.evidenceRefs.every((ref) => ref.artifactId === v.capture.artifactId && ref.segmentId === b.record.observerSegmentId);
};
export const CompleteReferenceOnlySchema = z.strictObject({ ...versions, kind: z.literal("reference-only"), ...complete })
  .refine((v) => consistent(v) && v.capture.attempt.status === "not-started");
export const CompleteReferenceAttemptSchema = z.strictObject({ ...versions, kind: z.literal("reference-plus-attempt"), ...complete })
  .refine((v) => consistent(v) && v.capture.attempt.status === "captured");
export const CompleteCaptureSchema = bounded(z.discriminatedUnion("kind", [CompleteReferenceOnlySchema, CompleteReferenceAttemptSchema]));
export const CaptureIssueSchema = z.strictObject({ code: z.enum(["invalid-record", "file-too-large", "missing-file", "invalid-json",
  "unsafe-object", "unsafe-mode", "inventory-mismatch", "digest-mismatch", "size-mismatch", "io-failed", "write-progress",
  "retention-unverified", "projection-invalid", "private-content", "invalid-parent", "ownership-mismatch", "uid-unavailable",
  "open-failed", "read-failed", "write-failed", "sync-failed", "close-failed"]), path: z.array(FileNameSchema).max(1) });
export const IncompleteInspectionSchema = z.strictObject({ ...versions, status: z.literal("incomplete"),
  retention: z.literal("not-retained"), issues: z.array(CaptureIssueSchema).min(1).max(LIMITS.issues) });
export type Reservation = z.infer<typeof ReservationSchema>;
export type Capture = z.infer<typeof CaptureSchema>;
export type Outcome = z.infer<typeof OutcomeSchema>;
export type Manifest = z.infer<typeof ManifestSchema>;
export type CompleteCapture = z.infer<typeof CompleteCaptureSchema>;
export type AttemptCapture = z.infer<typeof AttemptCaptureSchema>;
export type CaptureIssue = z.infer<typeof CaptureIssueSchema>;
export type IncompleteInspection = z.infer<typeof IncompleteInspectionSchema>;
export function incomplete(code: CaptureIssue["code"], file?: FileName): IncompleteInspection {
  return { privateFormatVersion: 1, normalizerVersion: 1, status: "incomplete", retention: "not-retained", issues: [{ code, path: file ? [file] : [] }] };
}
/** Causal order, first occurrence wins; the runtime can produce at most three failures per operation. */
export function incompleteIssues(issues: readonly CaptureIssue[]): IncompleteInspection {
  const deduplicated = [...new Map(issues.map((v) => [JSON.stringify(v), v])).values()].slice(0, LIMITS.issues);
  return IncompleteInspectionSchema.parse({ privateFormatVersion: 1, normalizerVersion: 1, status: "incomplete", retention: "not-retained",
    issues: deduplicated.length ? deduplicated : [{ code: "io-failed", path: [] }] });
}
/** Closed diagnostics intentionally reveal no private keys, values or Zod messages. */
export function parseCaptureRecords(input: unknown): { success: true; records: CompleteCapture } | { success: false; issues: CaptureIssue[] } {
  try {
    const result = CompleteCaptureSchema.safeParse(input);
    return result.success ? { success: true, records: result.data } : { success: false, issues: [{ code: "invalid-record", path: [] }] };
  } catch { return { success: false, issues: [{ code: "invalid-record", path: [] }] }; }
}
