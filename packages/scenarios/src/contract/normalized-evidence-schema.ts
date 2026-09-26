import { z } from "zod";
import { PathKeySchema, RunIdSchema, ScenarioIdSchema, Sha256Schema } from "./evidence-refs.js";

export const ToolRunIdSchema = z.string().regex(/^toolrun:[A-Za-z0-9][A-Za-z0-9_-]{0,63}(?![\s\S])/);
export const FactIdSchema = z.string().regex(/^fact:[A-Za-z0-9][A-Za-z0-9_-]{0,63}(?![\s\S])/);
export const CaptureIdSchema = z.string().regex(/^capture:[A-Za-z0-9][A-Za-z0-9_-]{0,63}(?![\s\S])/);
export const CapabilityIdSchema = z.string().regex(/^capability:[A-Za-z0-9][A-Za-z0-9_-]{0,63}(?![\s\S])/);
export const ArtifactIdSchema = z.string().regex(/^artifact:[A-Za-z0-9][A-Za-z0-9_-]{0,63}(?![\s\S])/);
export const SegmentIdSchema = z.string().regex(/^segment:[A-Za-z0-9][A-Za-z0-9_-]{0,63}(?![\s\S])/);
export const StatementIdSchema = z.string().regex(/^statement:[A-Za-z0-9][A-Za-z0-9_-]{0,63}:v[1-9][0-9]*(?![\s\S])/);
export const ToolNameSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}(?![\s\S])/);
export const AdapterNameSchema = ToolNameSchema;
export const VersionStringSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}(?![\s\S])/);
export const ReasonCodeSchema = z.enum(["not-observed", "not-captured", "capture-incomplete",
  "interpretation-incomplete", "unsupported-source", "parse-failed", "redacted", "private-only",
  "clock-unreliable", "order-unavailable", "not-applicable", "insufficient-evidence",
  "reference-not-supplied", "not-retained", "collector-failed", "version-unavailable"]);
export const ActionIdSchema = z.enum(["create-control-file", "git-clean"]);
export const ArtifactChannelSchema = z.enum(["stdout", "stderr", "log", "receipt", "documentation", "observer-record"]);
export const ReportChannelSchema = z.enum(["stdout", "stderr", "log", "receipt"]);
export const BoundaryScopeSchema = z.enum(["tracked", "untracked", "ignored", "outside-project", "non-git"]);
export const BoundaryAspectSchema = z.enum(["workspace-inclusion", "reporting"]);
export const BoundaryBehaviorSchema = z.enum(["included", "excluded", "reported", "unreported", "unknown"]);
export const EventTypeSchema = z.enum(["created", "modified", "deleted", "blocked-action", "other"]);
export const EventDispositionSchema = z.enum(["mentioned", "explicitly-denied"]);
export const WorkspaceRequirementSchema = z.enum(["readable-file", "executable-file", "writable-directory"]);
export const StageSchema = z.enum(["before", "during", "after"]);
export const CaptureStatusSchema = z.enum(["complete", "partial", "unavailable", "unknown"]);
export const InterpretationStatusSchema = z.enum(["complete", "partial", "not-performed", "unknown"]);
export const AvailabilityStatusSchema = z.enum(["available", "partial", "unavailable", "unknown"]);
export const RedactionStatusSchema = z.enum(["withheld", "semantic-redaction", "not-required", "unknown"]);
export const PublicVerifiabilityStatusSchema = z.enum(["not-publicly-verifiable", "unknown"]);
export const IndependentCollectorSchema = z.enum(["harness", "external-observer", "manual-observer"]);
export const IndependentMethodSchema = z.enum(["filesystem-observation", "process-observation"]);
export const UnknownSchema = z.strictObject({ status: z.literal("unknown"), reason: ReasonCodeSchema });
export const KnownVersionSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("known"), version: VersionStringSchema }), UnknownSchema]);
export const IsoUtcTimestampSchema = z.string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z(?![\s\S])/)
  .refine((value) => {
    const epoch = Date.parse(value);
    return Number.isFinite(epoch) && new Date(epoch).toISOString() === value;
  }, { message: "Exact valid UTC millisecond timestamp required" });
export const TimestampSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("known"), timestamp: IsoUtcTimestampSchema }), UnknownSchema]);
export const OrderSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("known"), sequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) }), UnknownSchema]);
export const PositionSchema = z.strictObject({ timestamp: TimestampSchema, order: OrderSchema });
export const YesNoUnknownSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("yes") }), z.strictObject({ status: z.literal("no") }), UnknownSchema]);
export const HashSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("known"), sha256: Sha256Schema }), UnknownSchema]);
export const ExitCodeSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("known"), exitCode: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable() }), UnknownSchema]);
export const SignalSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("known"), signal: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable() }), UnknownSchema]);
export const SegmentRefSchema = z.strictObject({ kind: z.literal("private-artifact-segment"),
  artifactId: ArtifactIdSchema, segmentId: SegmentIdSchema });
const refs = z.array(SegmentRefSchema).min(1).superRefine((items, ctx) => {
  const seen = new Set<string>();
  items.forEach((item, index) => {
    const key = `${item.artifactId}/${item.segmentId}`;
    if (seen.has(key)) ctx.addIssue({ code: "custom", path: [index], message: "Duplicate reference" });
    seen.add(key);
  });
});
export const IndependentProvenanceSchema = z.strictObject({ kind: z.literal("independent"),
  collector: IndependentCollectorSchema, method: IndependentMethodSchema, evidenceRefs: refs });
export const ToolClaimProvenanceSchema = z.strictObject({ kind: z.literal("tool-claimed"),
  collector: z.literal("tool-output"), method: z.literal("report-interpretation"), evidenceRefs: refs });
export const DeclarationProvenanceSchema = z.strictObject({ kind: z.literal("tool-claimed"),
  collector: z.literal("tool-documentation"), method: z.literal("document-interpretation"), evidenceRefs: refs });
export const ObservationProvenanceSchema = z.discriminatedUnion("kind", [IndependentProvenanceSchema, ToolClaimProvenanceSchema]);
export const RunIdentitySchema = z.strictObject({ toolRunId: ToolRunIdSchema, scenarioId: ScenarioIdSchema });
const fact = { ...RunIdentitySchema.shape, factId: FactIdSchema };
export const TargetSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("path"), pathKey: PathKeySchema }), z.strictObject({ kind: z.literal("none") })]);
export const OriginalStateSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("file") }), z.strictObject({ status: z.literal("absent") }), UnknownSchema]);
export const OriginalStateObservationSchema = z.strictObject({ ...fact, kind: z.literal("original-state-observation"),
  pathKey: PathKeySchema, stage: StageSchema, position: PositionSchema, state: OriginalStateSchema,
  hash: HashSchema, provenance: ObservationProvenanceSchema }).superRefine((value, ctx) => {
  if (value.state.status === "absent" && !(value.hash.status === "unknown" && value.hash.reason === "not-applicable")
    || value.state.status === "unknown" && value.hash.status === "known") {
    ctx.addIssue({ code: "custom", path: ["hash"], message: "Incompatible state and hash" });
  }
  if (value.provenance.kind === "independent" && value.provenance.method !== "filesystem-observation") {
    ctx.addIssue({ code: "custom", path: ["provenance", "method"], message: "Filesystem observation required" });
  }
});
export const ReportedEventSchema = z.strictObject({ ...fact, kind: z.literal("reported-event"),
  eventType: EventTypeSchema, target: TargetSchema, disposition: EventDispositionSchema,
  captureId: CaptureIdSchema, segmentRef: SegmentRefSchema, position: PositionSchema,
  provenance: ToolClaimProvenanceSchema }).superRefine((value, ctx) => {
  if (["created", "modified", "deleted"].includes(value.eventType) && value.target.kind !== "path") {
    ctx.addIssue({ code: "custom", path: ["target"], message: "Path target required" });
  }
  if (!value.provenance.evidenceRefs.some((ref) => ref.artifactId === value.segmentRef.artifactId && ref.segmentId === value.segmentRef.segmentId)) {
    ctx.addIssue({ code: "custom", path: ["segmentRef"], message: "Provenance must include segment" });
  }
});
export const ExecutionSchema = z.strictObject({ ...fact, kind: z.literal("execution"), actionId: ActionIdSchema,
  attempted: YesNoUnknownSchema, started: YesNoUnknownSchema, blocked: YesNoUnknownSchema, completed: YesNoUnknownSchema,
  attemptedAt: PositionSchema, startedAt: PositionSchema, blockedAt: PositionSchema, completedAt: PositionSchema,
  exitCode: ExitCodeSchema, signal: SignalSchema, provenance: ObservationProvenanceSchema }).superRefine((value, ctx) => {
  if (value.actionId !== (value.scenarioId === "S6" ? "git-clean" : "create-control-file")) {
    ctx.addIssue({ code: "custom", path: ["actionId"], message: "Scenario action mismatch" });
  }
  if (value.started.status === "yes" && value.attempted.status !== "yes"
    || value.completed.status === "yes" && (value.started.status !== "yes" || value.attempted.status !== "yes")
    || value.blocked.status === "yes" && (value.attempted.status !== "yes" || value.started.status !== "no" || value.completed.status !== "no")
    || value.attempted.status === "no" && [value.started, value.blocked, value.completed].some((item) => item.status !== "no")) {
    ctx.addIssue({ code: "custom", message: "Contradictory milestones" });
  }
  for (const name of ["attempted", "started", "blocked", "completed"] as const) {
    const position = value[`${name}At`];
    for (const component of ["timestamp", "order"] as const) {
      const point = position[component];
      if (value[name].status !== "yes" && (point.status === "known"
        || value[name].status === "no" && point.status === "unknown" && point.reason !== "not-applicable")) {
        ctx.addIssue({ code: "custom", path: [`${name}At`, component], message: "Milestone position mismatch" });
      }
    }
  }
  if (value.completed.status !== "yes" && (value.exitCode.status === "known" || value.signal.status === "known")
    || value.exitCode.status === "known" && value.exitCode.exitCode !== null && value.signal.status === "known" && value.signal.signal !== null) {
    ctx.addIssue({ code: "custom", path: ["exitCode"], message: "Termination mismatch" });
  }
  if (value.provenance.kind === "independent" && value.provenance.method !== "process-observation") {
    ctx.addIssue({ code: "custom", path: ["provenance", "method"], message: "Process observation required" });
  }
});
export const PresenceSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("present") }), z.strictObject({ status: z.literal("missing") }), UnknownSchema]);
export const UsabilitySchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("usable") }), z.strictObject({ status: z.literal("unusable") }), UnknownSchema]);
export const WorkspaceInputSchema = z.strictObject({ ...fact, kind: z.literal("workspace-input"), pathKey: PathKeySchema,
  actionId: ActionIdSchema, phase: z.literal("pre-action"), requirement: WorkspaceRequirementSchema,
  presence: PresenceSchema, usability: UsabilitySchema, position: PositionSchema, provenance: ObservationProvenanceSchema
}).superRefine((value, ctx) => {
  if (value.actionId !== (value.scenarioId === "S6" ? "git-clean" : "create-control-file")) {
    ctx.addIssue({ code: "custom", path: ["actionId"], message: "Scenario action mismatch" });
  }
  if (value.usability.status === "usable" && value.presence.status !== "present") {
    ctx.addIssue({ code: "custom", path: ["usability"], message: "Usable input must be present" });
  }
  if (value.provenance.kind === "independent" && value.provenance.method !== "filesystem-observation") {
    ctx.addIssue({ code: "custom", path: ["provenance", "method"], message: "Filesystem observation required" });
  }
});
export const BehaviorSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("included") }), z.strictObject({ status: z.literal("excluded") }),
  z.strictObject({ status: z.literal("reported") }), z.strictObject({ status: z.literal("unreported") }), UnknownSchema]);
export const BoundaryObservationSchema = z.strictObject({ ...fact, kind: z.literal("boundary-observation"),
  scope: BoundaryScopeSchema, aspect: BoundaryAspectSchema, target: TargetSchema, behavior: BehaviorSchema,
  position: PositionSchema, captureIds: z.array(CaptureIdSchema), provenance: ObservationProvenanceSchema
}).superRefine((value, ctx) => {
  const allowed = value.aspect === "workspace-inclusion" ? ["included", "excluded", "unknown"] : ["reported", "unreported", "unknown"];
  if (!allowed.includes(value.behavior.status)) ctx.addIssue({ code: "custom", path: ["behavior"], message: "Aspect mismatch" });
  if (new Set(value.captureIds).size !== value.captureIds.length
    || value.aspect === "workspace-inclusion" && value.captureIds.length !== 0
    || value.aspect === "reporting" && value.behavior.status !== "unknown" && value.captureIds.length === 0) {
    ctx.addIssue({ code: "custom", path: ["captureIds"], message: "Capture mismatch" });
  }
  if (value.provenance.kind === "independent" && (value.aspect === "reporting" || value.provenance.method !== "filesystem-observation")) {
    ctx.addIssue({ code: "custom", path: ["provenance"], message: "Provenance mismatch" });
  }
});
export const NormalizedFactSchema = z.discriminatedUnion("kind", [OriginalStateObservationSchema, ReportedEventSchema,
  ExecutionSchema, WorkspaceInputSchema, BoundaryObservationSchema]);
export const DeclaredCapabilitySchema = z.strictObject({ ...RunIdentitySchema.shape, capabilityId: CapabilityIdSchema,
  statementId: StatementIdSchema, scope: BoundaryScopeSchema, aspect: BoundaryAspectSchema, target: TargetSchema,
  claim: z.enum(["included", "excluded", "reported", "unreported"]), documentationVersion: KnownVersionSchema,
  appliesToToolVersion: KnownVersionSchema, provenance: DeclarationProvenanceSchema }).superRefine((value, ctx) => {
  if (!(value.aspect === "workspace-inclusion" ? ["included", "excluded"] : ["reported", "unreported"]).includes(value.claim)) {
    ctx.addIssue({ code: "custom", path: ["claim"], message: "Aspect mismatch" });
  }
});
export const ReferenceAccidentLinkSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("declared"), relationship: z.literal("reference-accident"), scenarioId: ScenarioIdSchema,
    sourceRunId: RunIdSchema, oracleVersion: z.literal(1) }), UnknownSchema]);
export const SameExecutionOracleLinkSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("declared"), oracleVersion: z.literal(1) }), UnknownSchema]);
export const SameExecutionLinkSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("declared"), relationship: z.literal("same-execution-additional-evidence"),
    scenarioId: ScenarioIdSchema, sourceRunId: RunIdSchema, oracle: SameExecutionOracleLinkSchema }),
  z.strictObject({ status: z.literal("none"), reason: ReasonCodeSchema })]);
export const SourcesSchema = z.strictObject({ referenceAccident: ReferenceAccidentLinkSchema, sameExecution: SameExecutionLinkSchema });
export const ChannelApplicabilitySchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("applicable"), captureId: CaptureIdSchema }),
  z.strictObject({ status: z.literal("not-applicable"), reason: ReasonCodeSchema }), UnknownSchema]);
export const ReportingInventorySchema = z.strictObject({ stdout: ChannelApplicabilitySchema, stderr: ChannelApplicabilitySchema,
  log: ChannelApplicabilitySchema, receipt: ChannelApplicabilitySchema });
export const CaptureCompletenessSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("complete") }), z.strictObject({ status: z.literal("partial"), reason: ReasonCodeSchema }),
  z.strictObject({ status: z.literal("unavailable"), reason: ReasonCodeSchema }), UnknownSchema]);
export const InterpretationCompletenessSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("complete") }), z.strictObject({ status: z.literal("partial"), reason: ReasonCodeSchema }),
  z.strictObject({ status: z.literal("not-performed"), reason: ReasonCodeSchema }), UnknownSchema]);
export const ReportCaptureSchema = z.strictObject({ ...RunIdentitySchema.shape, captureId: CaptureIdSchema, channel: ReportChannelSchema,
  capture: CaptureCompletenessSchema, interpretation: InterpretationCompletenessSchema }).superRefine((value, ctx) => {
  if (value.interpretation.status === "complete" && value.capture.status !== "complete"
    || value.capture.status === "unavailable" && !["not-performed", "unknown"].includes(value.interpretation.status)) {
    ctx.addIssue({ code: "custom", path: ["interpretation"], message: "Completeness mismatch" });
  }
});
export const CaptureLinkSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("capture"), captureId: CaptureIdSchema }), z.strictObject({ kind: z.literal("none") })]);
export const RedactionSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("withheld"), reason: ReasonCodeSchema }),
  z.strictObject({ status: z.literal("semantic-redaction"), policyVersion: z.literal(1) }),
  z.strictObject({ status: z.literal("not-required") }), UnknownSchema]);
export const PublicVerifiabilitySchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("not-publicly-verifiable"), reason: z.enum(["private-only", "redacted", "not-retained", "not-captured"]) }), UnknownSchema]);
export const PublicSegmentSchema = z.strictObject({ ...RunIdentitySchema.shape, artifactId: ArtifactIdSchema, segmentId: SegmentIdSchema,
  channel: ArtifactChannelSchema, capture: CaptureLinkSchema, privateReference: YesNoUnknownSchema,
  redaction: RedactionSchema, publicVerifiability: PublicVerifiabilitySchema }).superRefine((value, ctx) => {
  const report = value.channel !== "documentation" && value.channel !== "observer-record";
  if (report !== (value.capture.kind === "capture")) ctx.addIssue({ code: "custom", path: ["capture"], message: "Channel mismatch" });
});
export const AvailabilitySchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("available") }), z.strictObject({ status: z.literal("partial"), reason: ReasonCodeSchema }),
  z.strictObject({ status: z.literal("unavailable"), reason: ReasonCodeSchema }), UnknownSchema]);
export const EvidenceAvailabilitySchema = z.strictObject({ originalState: AvailabilitySchema, reportedEvents: AvailabilitySchema,
  execution: AvailabilitySchema, workspaceInputs: AvailabilitySchema, boundaryObservations: AvailabilitySchema, declaredCapabilities: AvailabilitySchema });
export const ToolIdentitySchema = z.strictObject({ name: ToolNameSchema, version: KnownVersionSchema });
export const AdapterIdentitySchema = z.strictObject({ name: AdapterNameSchema, version: KnownVersionSchema });
export const NormalizedToolEvidenceSchema = z.strictObject({ schemaVersion: z.literal(1), ...RunIdentitySchema.shape,
  sources: SourcesSchema, tool: ToolIdentitySchema, adapter: AdapterIdentitySchema, startedAt: TimestampSchema, endedAt: TimestampSchema,
  facts: z.array(NormalizedFactSchema), declaredCapabilities: z.array(DeclaredCapabilitySchema), reporting: ReportingInventorySchema,
  reportCaptures: z.array(ReportCaptureSchema), segments: z.array(PublicSegmentSchema), availability: EvidenceAvailabilitySchema });

export type ToolRunId = z.infer<typeof ToolRunIdSchema>;
export type FactId = z.infer<typeof FactIdSchema>;
export type CaptureId = z.infer<typeof CaptureIdSchema>;
export type CapabilityId = z.infer<typeof CapabilityIdSchema>;
export type ArtifactId = z.infer<typeof ArtifactIdSchema>;
export type SegmentId = z.infer<typeof SegmentIdSchema>;
export type StatementId = z.infer<typeof StatementIdSchema>;
export type ToolName = z.infer<typeof ToolNameSchema>;
export type AdapterName = z.infer<typeof AdapterNameSchema>;
export type VersionString = z.infer<typeof VersionStringSchema>;
export type ReasonCode = z.infer<typeof ReasonCodeSchema>;
export type ActionId = z.infer<typeof ActionIdSchema>;
export type ArtifactChannel = z.infer<typeof ArtifactChannelSchema>;
export type ReportChannel = z.infer<typeof ReportChannelSchema>;
export type BoundaryScope = z.infer<typeof BoundaryScopeSchema>;
export type BoundaryAspect = z.infer<typeof BoundaryAspectSchema>;
export type BoundaryBehavior = z.infer<typeof BoundaryBehaviorSchema>;
export type EventType = z.infer<typeof EventTypeSchema>;
export type EventDisposition = z.infer<typeof EventDispositionSchema>;
export type WorkspaceRequirement = z.infer<typeof WorkspaceRequirementSchema>;
export type Stage = z.infer<typeof StageSchema>;
export type CaptureStatus = z.infer<typeof CaptureStatusSchema>;
export type InterpretationStatus = z.infer<typeof InterpretationStatusSchema>;
export type AvailabilityStatus = z.infer<typeof AvailabilityStatusSchema>;
export type RedactionStatus = z.infer<typeof RedactionStatusSchema>;
export type PublicVerifiabilityStatus = z.infer<typeof PublicVerifiabilityStatusSchema>;
export type IndependentCollector = z.infer<typeof IndependentCollectorSchema>;
export type IndependentMethod = z.infer<typeof IndependentMethodSchema>;
export type Unknown = z.infer<typeof UnknownSchema>;
export type KnownVersion = z.infer<typeof KnownVersionSchema>;
export type IsoUtcTimestamp = z.infer<typeof IsoUtcTimestampSchema>;
export type Timestamp = z.infer<typeof TimestampSchema>;
export type Order = z.infer<typeof OrderSchema>;
export type Position = z.infer<typeof PositionSchema>;
export type YesNoUnknown = z.infer<typeof YesNoUnknownSchema>;
export type Hash = z.infer<typeof HashSchema>;
export type ExitCode = z.infer<typeof ExitCodeSchema>;
export type Signal = z.infer<typeof SignalSchema>;
export type SegmentRef = z.infer<typeof SegmentRefSchema>;
export type IndependentProvenance = z.infer<typeof IndependentProvenanceSchema>;
export type ToolClaimProvenance = z.infer<typeof ToolClaimProvenanceSchema>;
export type DeclarationProvenance = z.infer<typeof DeclarationProvenanceSchema>;
export type ObservationProvenance = z.infer<typeof ObservationProvenanceSchema>;
export type RunIdentity = z.infer<typeof RunIdentitySchema>;
export type Target = z.infer<typeof TargetSchema>;
export type OriginalState = z.infer<typeof OriginalStateSchema>;
export type OriginalStateObservation = z.infer<typeof OriginalStateObservationSchema>;
export type ReportedEvent = z.infer<typeof ReportedEventSchema>;
export type Execution = z.infer<typeof ExecutionSchema>;
export type Presence = z.infer<typeof PresenceSchema>;
export type Usability = z.infer<typeof UsabilitySchema>;
export type WorkspaceInput = z.infer<typeof WorkspaceInputSchema>;
export type Behavior = z.infer<typeof BehaviorSchema>;
export type BoundaryObservation = z.infer<typeof BoundaryObservationSchema>;
export type NormalizedFact = z.infer<typeof NormalizedFactSchema>;
export type DeclaredCapability = z.infer<typeof DeclaredCapabilitySchema>;
export type ReferenceAccidentLink = z.infer<typeof ReferenceAccidentLinkSchema>;
export type SameExecutionOracleLink = z.infer<typeof SameExecutionOracleLinkSchema>;
export type SameExecutionLink = z.infer<typeof SameExecutionLinkSchema>;
export type Sources = z.infer<typeof SourcesSchema>;
export type ChannelApplicability = z.infer<typeof ChannelApplicabilitySchema>;
export type ReportingInventory = z.infer<typeof ReportingInventorySchema>;
export type CaptureCompleteness = z.infer<typeof CaptureCompletenessSchema>;
export type InterpretationCompleteness = z.infer<typeof InterpretationCompletenessSchema>;
export type ReportCapture = z.infer<typeof ReportCaptureSchema>;
export type CaptureLink = z.infer<typeof CaptureLinkSchema>;
export type Redaction = z.infer<typeof RedactionSchema>;
export type PublicVerifiability = z.infer<typeof PublicVerifiabilitySchema>;
export type PublicSegment = z.infer<typeof PublicSegmentSchema>;
export type Availability = z.infer<typeof AvailabilitySchema>;
export type EvidenceAvailability = z.infer<typeof EvidenceAvailabilitySchema>;
export type ToolIdentity = z.infer<typeof ToolIdentitySchema>;
export type AdapterIdentity = z.infer<typeof AdapterIdentitySchema>;
export type NormalizedToolEvidence = z.infer<typeof NormalizedToolEvidenceSchema>;
