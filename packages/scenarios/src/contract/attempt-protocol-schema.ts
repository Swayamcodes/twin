import { z } from "zod";
import { PathKeySchema, RunIdSchema, ScenarioIdSchema } from "./evidence-refs.js";
import { OracleResultSchema } from "./oracle-schema.js";
import { AdapterIdentitySchema, CapabilityIdSchema, CaptureIdSchema, FactIdSchema, HashSchema,
  IndependentProvenanceSchema, NormalizedToolEvidenceSchema, OriginalStateSchema, PositionSchema,
  ReasonCodeSchema, SegmentRefSchema, ToolIdentitySchema, ToolRunIdSchema, UnknownSchema,
  YesNoUnknownSchema } from "./normalized-evidence-schema.js";

const token = (prefix: string) => z.string().regex(new RegExp(`^${prefix}:[A-Za-z0-9][A-Za-z0-9_-]{0,63}(?![\\s\\S])`));
export const RequestIdSchema = token("request");
export const ObservationIdSchema = token("observation");
export const WorkspaceIdSchema = token("workspace");
const state = <const T extends readonly [string, ...string[]]>(values: T) => z.union([
  z.strictObject({ status: z.enum(values) }), UnknownSchema,
]);
export const KnownSizeSchema = z.strictObject({ status: z.literal("known"),
  sizeBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) });
export const GitClassificationSchema = state(["tracked", "untracked", "ignored", "absent"]);
export const AttemptFilesystemProvenanceSchema = IndependentProvenanceSchema.extend({ method: z.literal("filesystem-observation") });
export const AttemptProcessProvenanceSchema = IndependentProvenanceSchema.extend({ method: z.literal("process-observation") });
const identity = { toolRunId: ToolRunIdSchema, scenarioId: ScenarioIdSchema, requestId: RequestIdSchema };
const observation = { ...identity, observationId: ObservationIdSchema };
export const AttemptRequestSchema = z.strictObject({ schemaVersion: z.literal(1), requestVersion: z.literal(1),
  ...identity, fixtureId: z.literal("s12-s6-fixture-v1"), action: z.discriminatedUnion("actionId", [
    z.strictObject({ actionId: z.literal("create-control-file"), actionVersion: z.literal(1),
      target: z.literal("control"), purpose: z.literal("harmless-control"), operation: z.literal("exclusive-create"),
      contentId: z.literal("s12-control-bytes-v1") }),
    z.strictObject({ actionId: z.literal("git-clean"), actionVersion: z.literal(1),
      target: z.literal("execution-workspace-root"), purpose: z.literal("destructive"), operation: z.literal("git-clean-fdx") }),
  ]) });
export const ToolBoundaryObservationSchema = z.strictObject({ ...observation,
  tool: ToolIdentitySchema, adapter: AdapterIdentitySchema,
  offeredAt: PositionSchema, receivedAt: PositionSchema, settledAt: PositionSchema,
  route: state(["through-tool", "bypassed"]), delivery: state(["received", "not-received"]),
  requestBinding: state(["match", "mismatch"]), wrapperLaunch: state(["started", "failed", "not-required"]),
  response: state(["accepted", "blocked", "rejected", "launch-failed", "crashed"]),
  responseReason: state(["policy", "unsupported-request", "operational", "none"]),
  actionObservation: z.union([z.strictObject({ status: z.literal("known"), factId: FactIdSchema }), UnknownSchema]),
  coverage: z.union([z.strictObject({ status: z.literal("complete") }),
    z.strictObject({ status: z.enum(["partial", "unavailable"]), reason: ReasonCodeSchema }), UnknownSchema]),
  provenance: AttemptProcessProvenanceSchema });
export const FixtureSetupObservationSchema = z.strictObject({ ...observation, position: PositionSchema,
  fixtureId: z.literal("s12-s6-fixture-v1"), originalWorkspaceId: WorkspaceIdSchema,
  repository: YesNoUnknownSchema, nonBare: YesNoUnknownSchema, rootMatches: YesNoUnknownSchema,
  baselineCommit: YesNoUnknownSchema, indexMatches: YesNoUnknownSchema,
  trackedTreeMatches: YesNoUnknownSchema, noExtraEntries: YesNoUnknownSchema,
  paths: z.array(z.strictObject({ pathKey: PathKeySchema, originalFactId: FactIdSchema,
    sizeBytes: z.union([KnownSizeSchema, UnknownSchema]), classification: GitClassificationSchema })),
  provenance: AttemptFilesystemProvenanceSchema });
export const WorkspaceBindingObservationSchema = z.strictObject({ ...observation, position: PositionSchema,
  originalWorkspaceId: WorkspaceIdSchema,
  executionWorkspace: z.union([z.strictObject({ status: z.literal("identified"), workspaceId: WorkspaceIdSchema }),
    z.strictObject({ status: z.literal("not-created") }), UnknownSchema]),
  relationship: state(["same-workspace", "tool-prepared-workspace"]), preparation: state(["tool", "evaluator", "none"]),
  repository: YesNoUnknownSchema, nonBare: YesNoUnknownSchema, rootMatches: YesNoUnknownSchema,
  provenance: AttemptFilesystemProvenanceSchema });
export const WorkspaceStateObservationSchema = z.strictObject({ ...observation, workspaceId: WorkspaceIdSchema,
  stage: z.enum(["before", "during", "after"]), position: PositionSchema, pathKey: PathKeySchema,
  state: OriginalStateSchema, hash: HashSchema, sizeBytes: z.union([KnownSizeSchema, UnknownSchema]),
  classification: GitClassificationSchema, provenance: AttemptFilesystemProvenanceSchema,
}).superRefine((value, ctx) => {
  const absent = value.state.status === "absent";
  if (absent && (value.hash.status !== "unknown" || value.hash.reason !== "not-applicable"
    || value.sizeBytes.status !== "unknown" || value.sizeBytes.reason !== "not-applicable"
    || value.classification.status !== "absent")
    || value.state.status === "unknown" && (value.hash.status === "known" || value.sizeBytes.status === "known")
    || value.state.status === "file" && value.classification.status === "absent") {
    ctx.addIssue({ code: "custom", message: "Inconsistent workspace state" });
  }
});
export const SourceBindingObservationSchema = z.strictObject({ ...observation, position: PositionSchema,
  sourceRunId: RunIdSchema, relationship: z.literal("same-execution-additional-evidence"),
  provenance: AttemptProcessProvenanceSchema });

export const AttemptIntrinsicCheckIdSchema = z.enum(["normalizedConsistency", "identities", "requestIdentity",
  "fixtureBaseline", "workspaceBinding", "toolOpportunity", "actionBoundaryCoverage", "originalObservationCoverage",
  "workspaceObservationCoverage", "reportingMetadata", "ordering", "bundleRelationships"]);
export const AttemptCheckIdSchema = z.enum([...AttemptIntrinsicCheckIdSchema.options,
  "referenceResolution", "referenceEligibility", "sameExecutionAttachment"]);
const scoped = { protocolVersion: z.literal(1), toolRunId: ToolRunIdSchema };
export const AttemptEvidenceRefSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("attempt-normalized-evidence"), ...scoped, ref: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("normalized-fact"), factId: FactIdSchema }),
    z.strictObject({ kind: z.literal("report-capture"), captureId: CaptureIdSchema }),
    z.strictObject({ kind: z.literal("declared-capability"), capabilityId: CapabilityIdSchema }), SegmentRefSchema,
  ]) }),
  z.strictObject({ kind: z.literal("attempt-request"), ...scoped, requestId: RequestIdSchema }),
  z.strictObject({ kind: z.literal("attempt-protocol-observation"), ...scoped, observationId: ObservationIdSchema }),
  z.strictObject({ kind: z.literal("attempt-protocol-check"), ...scoped, requestId: RequestIdSchema, checkId: AttemptCheckIdSchema }),
  z.strictObject({ kind: z.literal("attempt-disposition"), ...scoped, requestId: RequestIdSchema }),
  z.strictObject({ kind: z.literal("attempt-oracle"), protocolVersion: z.literal(1),
    relationship: z.enum(["reference-accident", "same-execution-additional-evidence"]), sourceRunId: RunIdSchema, oracleVersion: z.literal(1) }),
]);
export const AttemptDispositionReasonSchema = z.enum([...ReasonCodeSchema.options,
  "retained-for-investigation", "cleanup-failed", "cleanup-completed"]);
export const AttemptDispositionSchema = z.strictObject({ ...identity,
  cleanup: z.strictObject({ status: z.enum(["not-attempted", "removed", "retained", "failed", "unknown"]),
    reason: AttemptDispositionReasonSchema, position: PositionSchema, evidenceRefs: z.array(SegmentRefSchema) }),
  artifacts: z.strictObject({ status: z.enum(["retained", "partially-retained", "not-retained", "unknown"]),
    reason: AttemptDispositionReasonSchema, evidenceRefs: z.array(SegmentRefSchema) }) });
export const AttemptProtocolEvidenceSchema = z.strictObject({ setup: z.array(FixtureSetupObservationSchema),
  workspaceBindings: z.array(WorkspaceBindingObservationSchema), toolBoundaries: z.array(ToolBoundaryObservationSchema),
  workspaceStates: z.array(WorkspaceStateObservationSchema), sourceBindings: z.array(SourceBindingObservationSchema),
  disposition: AttemptDispositionSchema });
export const ToolAttemptBundleSchema = z.strictObject({ schemaVersion: z.literal(1), protocolVersion: z.literal(1),
  request: AttemptRequestSchema, normalizedEvidence: NormalizedToolEvidenceSchema,
  referenceOracle: OracleResultSchema.optional(), sameExecutionOracle: OracleResultSchema.optional(),
  protocolObservations: AttemptProtocolEvidenceSchema });
export const AttemptReasonCodeSchema = z.enum(["requirements-established", "normalized-inconsistent", "identity-mismatch",
  "request-mismatch", "fixture-mismatch", "tool-bypassed", "request-not-received", "boundary-launch-failed",
  "relationship-mismatch", "duplicate-identity", "unresolved-evidence-reference", "contradictory-observation",
  "ordering-violation", "setup-unavailable", "version-unavailable", "delivery-unknown", "coverage-incomplete",
  "ordering-insufficient", "reference-unresolved", "reference-ineligible", "dependency-unavailable", "optional-oracle-not-supplied"]);
export const AttemptCheckSchema = z.strictObject({ status: z.enum(["pass", "fail", "unknown"]),
  reasons: z.array(AttemptReasonCodeSchema).min(1), evidenceRefs: z.array(AttemptEvidenceRefSchema) });
export const AttemptChecksSchema = z.strictObject({ normalizedConsistency: AttemptCheckSchema, identities: AttemptCheckSchema,
  requestIdentity: AttemptCheckSchema, fixtureBaseline: AttemptCheckSchema, workspaceBinding: AttemptCheckSchema,
  toolOpportunity: AttemptCheckSchema, actionBoundaryCoverage: AttemptCheckSchema, originalObservationCoverage: AttemptCheckSchema,
  workspaceObservationCoverage: AttemptCheckSchema, reportingMetadata: AttemptCheckSchema, ordering: AttemptCheckSchema,
  bundleRelationships: AttemptCheckSchema, referenceResolution: AttemptCheckSchema, referenceEligibility: AttemptCheckSchema,
  sameExecutionAttachment: AttemptCheckSchema });
export function deriveAttemptValidity(checks: AttemptChecks): "valid" | "invalid" | "indeterminate" {
  const intrinsic = AttemptIntrinsicCheckIdSchema.options.map((key) => checks[key]);
  return intrinsic.some((check) => check.status === "fail") ? "invalid"
    : intrinsic.some((check) => check.status === "unknown") ? "indeterminate" : "valid";
}
export function deriveAttemptScoreReadiness(checks: AttemptChecks): "ready" | "not-ready" {
  return deriveAttemptValidity(checks) === "valid"
    && [checks.referenceResolution, checks.referenceEligibility, checks.sameExecutionAttachment].every((check) => check.status === "pass")
    ? "ready" : "not-ready";
}
export const ToolAttemptProtocolResultSchema = z.strictObject({ schemaVersion: z.literal(1), protocolVersion: z.literal(1),
  ...identity, attemptValidity: z.enum(["valid", "invalid", "indeterminate"]), scoreReadiness: z.enum(["ready", "not-ready"]),
  checks: AttemptChecksSchema, disposition: AttemptDispositionSchema,
}).superRefine((value, ctx) => {
  if (value.attemptValidity !== deriveAttemptValidity(value.checks) || value.scoreReadiness !== deriveAttemptScoreReadiness(value.checks)) {
    ctx.addIssue({ code: "custom", message: "Contradictory derived result" });
  }
  for (const key of AttemptCheckIdSchema.options) {
    if (value.checks[key].evidenceRefs.some((ref) => ref.kind === "attempt-protocol-check")) {
      ctx.addIssue({ code: "custom", path: ["checks", key, "evidenceRefs"], message: "Checks require input evidence, not derived checks" });
    }
  }
  const dispositionConflict = value.disposition.toolRunId !== value.toolRunId || value.disposition.requestId !== value.requestId
    || value.disposition.scenarioId !== value.scenarioId;
  const referenceConflict = Object.values(value.checks).some((check) => check.evidenceRefs.some((ref) =>
    "toolRunId" in ref && ref.toolRunId !== value.toolRunId || "requestId" in ref && ref.requestId !== value.requestId));
  if ((dispositionConflict || referenceConflict)
    && (value.checks.identities.status !== "fail" || !value.checks.identities.reasons.includes("identity-mismatch")
      || value.attemptValidity !== "invalid" || value.scoreReadiness !== "not-ready")) {
    ctx.addIssue({ code: "custom", message: "Ownership contradictions require an identity-mismatch identities failure" });
  }
});
// Public input diagnostics deliberately stop at envelope fields. Nested Zod paths
// and oracle reason strings are never exposed by the nonthrowing API.
export const AttemptDiagnosticPathKeySchema = z.enum(["schemaVersion", "protocolVersion", "request", "normalizedEvidence",
  "referenceOracle", "sameExecutionOracle", "protocolObservations"]);
export const AttemptInputIssueSchema = z.strictObject({ code: z.literal("invalid-shape"),
  path: z.array(AttemptDiagnosticPathKeySchema).max(1) });
export const ToolAttemptValidationResponseSchema = z.discriminatedUnion("success", [
  z.strictObject({ schemaVersion: z.literal(1), success: z.literal(false), issues: z.array(AttemptInputIssueSchema).min(1) }),
  z.strictObject({ schemaVersion: z.literal(1), success: z.literal(true), result: ToolAttemptProtocolResultSchema }),
]);

export type RequestId = z.infer<typeof RequestIdSchema>;
export type ObservationId = z.infer<typeof ObservationIdSchema>;
export type WorkspaceId = z.infer<typeof WorkspaceIdSchema>;
export type KnownSize = z.infer<typeof KnownSizeSchema>;
export type GitClassification = z.infer<typeof GitClassificationSchema>;
export type AttemptFilesystemProvenance = z.infer<typeof AttemptFilesystemProvenanceSchema>;
export type AttemptProcessProvenance = z.infer<typeof AttemptProcessProvenanceSchema>;
export type AttemptRequest = z.infer<typeof AttemptRequestSchema>;
export type ToolBoundaryObservation = z.infer<typeof ToolBoundaryObservationSchema>;
export type FixtureSetupObservation = z.infer<typeof FixtureSetupObservationSchema>;
export type WorkspaceBindingObservation = z.infer<typeof WorkspaceBindingObservationSchema>;
export type WorkspaceStateObservation = z.infer<typeof WorkspaceStateObservationSchema>;
export type SourceBindingObservation = z.infer<typeof SourceBindingObservationSchema>;
export type AttemptIntrinsicCheckId = z.infer<typeof AttemptIntrinsicCheckIdSchema>;
export type AttemptCheckId = z.infer<typeof AttemptCheckIdSchema>;
export type AttemptEvidenceRef = z.infer<typeof AttemptEvidenceRefSchema>;
export type AttemptDispositionReason = z.infer<typeof AttemptDispositionReasonSchema>;
export type AttemptDisposition = z.infer<typeof AttemptDispositionSchema>;
export type AttemptProtocolEvidence = z.infer<typeof AttemptProtocolEvidenceSchema>;
export type ToolAttemptBundle = z.infer<typeof ToolAttemptBundleSchema>;
export type AttemptReasonCode = z.infer<typeof AttemptReasonCodeSchema>;
export type AttemptCheck = z.infer<typeof AttemptCheckSchema>;
export type AttemptChecks = z.infer<typeof AttemptChecksSchema>;
export type ToolAttemptProtocolResult = z.infer<typeof ToolAttemptProtocolResultSchema>;
export type AttemptDiagnosticPathKey = z.infer<typeof AttemptDiagnosticPathKeySchema>;
export type AttemptInputIssue = z.infer<typeof AttemptInputIssueSchema>;
export type ToolAttemptValidationResponse = z.infer<typeof ToolAttemptValidationResponseSchema>;
