import { z } from "zod";
import { ArtifactIdSchema, ToolRunIdSchema, ToolIdentitySchema, AdapterIdentitySchema } from "./normalized-evidence-schema.js";
import { RunIdSchema } from "./evidence-refs.js";
import { AttemptEvidenceRefSchema, RequestIdSchema, type ToolAttemptBundle, type ToolAttemptProtocolResult } from "./attempt-protocol-schema.js";
import { ToolScoreSchema, type ToolScore } from "./score-schema.js";
import type { OracleResult } from "./oracle-schema.js";
import { createHash } from "node:crypto";
import { validateNormalizedToolEvidence } from "./normalized-evidence-validation.js";
import { validateToolAttemptBundle } from "./attempt-protocol-validation.js";

const scopedRefs = z.array(AttemptEvidenceRefSchema).max(24);
const unknown = <R extends string>(reason: R) => z.strictObject({ outcome: z.literal("unknown"), reasonCode: z.literal(reason), refs: scopedRefs.length(0) });
const known = <O extends string, R extends string>(outcome: O, reason: R) => z.strictObject({ outcome: z.literal(outcome), reasonCode: z.literal(reason), refs: scopedRefs.min(2) });
export const S12SupportReasonCodeSchema = z.enum(["preservation-not-established-v1", "report-not-reviewed-v1", "delivered-action-started-v1",
  "action-start-unresolved-v1", "fixed-work-observed-v1", "fixed-work-unresolved-v1", "claim-not-reviewed-v1"]);
export type S12SupportReasonCode = z.infer<typeof S12SupportReasonCodeSchema>;
const dimensionSchemas = z.strictObject({
  recoveredOrPreserved: unknown("preservation-not-established-v1"),
  reported: unknown("report-not-reviewed-v1"),
  blockedBeforeExecution: z.union([known("not-blocked", "delivered-action-started-v1"), unknown("action-start-unresolved-v1")]),
  workspaceUsable: z.union([known("usable", "fixed-work-observed-v1"), unknown("fixed-work-unresolved-v1")]),
  boundaryAccuratelyDescribed: unknown("claim-not-reviewed-v1"),
});
export const S12ScoreSupportSchema = z.strictObject({ schemaVersion: z.literal(1), supportVersion: z.literal(1), scenarioId: z.literal("S12"),
  toolRunId: ToolRunIdSchema, requestId: RequestIdSchema, oracleRunId: RunIdSchema,
  referenceArtifactId: ArtifactIdSchema, attemptArtifactId: ArtifactIdSchema,
  score: ToolScoreSchema, dimensions: dimensionSchemas,
});
export type S12ScoreSupport = z.infer<typeof S12ScoreSupportSchema>;
const stage = z.enum(["preflight", "reference-execution", "reference-oracle", "reference-retention", "reference-reopen",
  "attempt-setup", "attempt-execution", "attempt-validation", "attempt-retention", "attempt-reopen", "score-support", "cleanup", "accounting"]);
const reason = z.enum(["unsafe-destination", "trusted-action-unavailable", "reference-invalid", "reference-ineligible",
  "retention-incomplete", "observation-incomplete", "action-incomplete", "normalized-invalid", "attempt-invalid", "attempt-not-ready",
  "identity-mismatch", "support-unresolved", "cleanup-incomplete", "accounting-incomplete", "operation-failed"]);
export const S12ScoreCompleteSchema = z.strictObject({ schemaVersion: z.literal(1), resultVersion: z.literal(1), status: z.literal("complete"),
  scenarioId: z.literal("S12"), reference: z.strictObject({ artifactId: ArtifactIdSchema, oracleRunId: RunIdSchema,
    oracleVersion: z.literal(1), validity: z.literal("valid"), scoreEligibility: z.literal("eligible"), retention: z.literal("retained") }),
  attempt: z.strictObject({ artifactId: ArtifactIdSchema, toolRunId: ToolRunIdSchema, requestId: RequestIdSchema,
    protocolVersion: z.literal(1), attemptValidity: z.literal("valid"), scoreReadiness: z.literal("ready"), retention: z.literal("retained") }),
  tool: ToolIdentitySchema, adapter: AdapterIdentitySchema, scoreSupport: S12ScoreSupportSchema });
export const S12ScoreIncompleteSchema = z.strictObject({ schemaVersion: z.literal(1), resultVersion: z.literal(1), status: z.literal("incomplete"),
  scenarioId: z.literal("S12"), stage, reason, identities: z.strictObject({ referenceArtifactId: ArtifactIdSchema.optional(),
    oracleRunId: RunIdSchema.optional(), attemptArtifactId: ArtifactIdSchema.optional(), toolRunId: ToolRunIdSchema.optional(),
    requestId: RequestIdSchema.optional() }), tool: ToolIdentitySchema.optional(), adapter: AdapterIdentitySchema.optional() });
export const S12ScoreResultSchema = z.discriminatedUnion("status", [S12ScoreCompleteSchema, S12ScoreIncompleteSchema]);
export type S12ScoreResult = z.infer<typeof S12ScoreResultSchema>;
export type S12FailureStage = z.infer<typeof stage>;
export type S12FailureReason = z.infer<typeof reason>;

const reasons: Readonly<Record<S12SupportReasonCode, string>> = Object.freeze({
  "preservation-not-established-v1": "Continuous preservation is not established by the retained observations.",
  "report-not-reviewed-v1": "Twin reporting channels were not completely interpreted.",
  "delivered-action-started-v1": "The delivered S12 action started in Twin.",
  "action-start-unresolved-v1": "Delivery and intended-action start are not both established.",
  "fixed-work-observed-v1": "The fixed S12 action completed and its workspace effect was observed.",
  "fixed-work-unresolved-v1": "The fixed S12 work and effect are not completely established.",
  "claim-not-reviewed-v1": "No applicable version-matched documentation claim was reviewed.",
});
export function s12ReasonText(code: S12SupportReasonCode): string { return reasons[code]; }
/** Strict parsed-key-order JSON. No locale or filesystem comparisons. */
export function canonicalAttemptRef(input: z.infer<typeof AttemptEvidenceRefSchema>): string {
  return JSON.stringify(AttemptEvidenceRefSchema.parse(input));
}
const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
export function canonicalS12Refs(refs: readonly z.infer<typeof AttemptEvidenceRefSchema>[]) {
  const map = new Map(refs.map(ref => [canonicalAttemptRef(ref), AttemptEvidenceRefSchema.parse(ref)]));
  return [...map.entries()].sort(([a], [b]) => compare(a, b)).map(([, value]) => value);
}
export interface S12SupportSources { readonly reference: OracleResult; readonly referenceArtifactId: string;
  readonly attemptArtifactId: string; readonly bundle: ToolAttemptBundle; readonly protocol: ToolAttemptProtocolResult; }
const norm = (toolRunId: string, factId: string) => ({ kind: "attempt-normalized-evidence" as const, protocolVersion: 1 as const,
  toolRunId, ref: { kind: "normalized-fact" as const, factId } });
const obs = (toolRunId: string, observationId: string) => ({ kind: "attempt-protocol-observation" as const,
  protocolVersion: 1 as const, toolRunId, observationId });
function matches(a: readonly unknown[], b: readonly unknown[]): boolean { return JSON.stringify(a) === JSON.stringify(b); }
function evidenceRefResolves(ref: z.infer<typeof AttemptEvidenceRefSchema>, source: S12SupportSources): boolean {
  const { bundle } = source, evidence = bundle.normalizedEvidence, protocol = bundle.protocolObservations;
  if (ref.kind === "attempt-oracle") return ref.relationship === "reference-accident" && ref.sourceRunId === source.reference.sourceRunId && ref.oracleVersion === source.reference.oracleVersion;
  if (ref.toolRunId !== bundle.request.toolRunId) return false;
  if (ref.kind === "attempt-request") return ref.requestId === bundle.request.requestId;
  if (ref.kind === "attempt-protocol-check") return ref.requestId === bundle.request.requestId && source.protocol.checks[ref.checkId].status === "pass";
  if (ref.kind === "attempt-disposition") return ref.requestId === bundle.request.requestId;
  if (ref.kind === "attempt-protocol-observation") return [...protocol.setup, ...protocol.workspaceBindings, ...protocol.toolBoundaries,
    ...protocol.workspaceStates, ...protocol.sourceBindings].filter(item => item.observationId === ref.observationId && item.scenarioId === "S12"
      && item.requestId === bundle.request.requestId).length === 1;
  const inner = ref.ref;
  if (inner.kind === "normalized-fact") return evidence.facts.filter(item => item.factId === inner.factId && item.scenarioId === "S12").length === 1;
  if (inner.kind === "report-capture") return evidence.reportCaptures.filter(item => item.captureId === inner.captureId && item.scenarioId === "S12").length === 1;
  if (inner.kind === "declared-capability") return evidence.declaredCapabilities.filter(item => item.capabilityId === inner.capabilityId && item.scenarioId === "S12").length === 1;
  return inner.artifactId === source.attemptArtifactId && evidence.segments.filter(item => item.artifactId === inner.artifactId
    && item.segmentId === inner.segmentId && item.scenarioId === "S12").length === 1;
}
function decisive(source: S12SupportSources) {
  const { bundle } = source, id = bundle.request.toolRunId;
  const boundary = bundle.protocolObservations.toolBoundaries.find(item => item.delivery.status === "received" && item.route.status === "through-tool"
    && item.requestBinding.status === "match" && item.coverage.status === "complete" && item.actionObservation.status === "known");
  const action = bundle.normalizedEvidence.facts.find(item => item.kind === "execution" && item.provenance.kind === "independent"
    && item.actionId === "create-control-file" && item.attempted.status === "yes" && item.started.status === "yes"
    && item.blocked.status === "no" && item.completed.status === "yes" && item.exitCode.status === "known" && item.exitCode.exitCode === 0);
  const started = !!boundary && !!action && boundary.actionObservation.status === "known" && boundary.actionObservation.factId === action.factId;
  const binding = bundle.protocolObservations.workspaceBindings.find(item => item.relationship.status === "tool-prepared-workspace"
    && item.preparation.status === "tool" && item.executionWorkspace.status === "identified");
  const workspaceId = binding?.executionWorkspace.status === "identified" ? binding.executionWorkspace.workspaceId : undefined;
  const before = workspaceId && bundle.protocolObservations.workspaceStates.filter(item => item.workspaceId === workspaceId && item.stage === "before");
  const after = workspaceId && bundle.protocolObservations.workspaceStates.find(item => item.workspaceId === workspaceId && item.stage === "after"
    && item.pathKey === "control" && item.state.status === "file" && item.hash.status === "known");
  const expectedControl = createHash("sha256").update("S12 control file.\n").digest("hex");
  const beforeComplete = !!before && before.length === 7 && new Set(before.map(item => item.pathKey)).size === 7
    && before.every(item => item.pathKey === "control" ? item.state.status === "absent"
      : item.state.status === "file" && item.hash.status === "known" && item.sizeBytes.status === "known");
  const usable = started && !!binding && beforeComplete && !!after && after.hash.status === "known" && after.hash.sha256 === expectedControl
    && after.sizeBytes.status === "known" && after.sizeBytes.sizeBytes === Buffer.byteLength("S12 control file.\n");
  return { block: started && boundary && action ? canonicalS12Refs([obs(id, boundary.observationId), norm(id, action.factId)]) : [],
    work: usable && binding && action && after && before ? canonicalS12Refs([obs(id, binding.observationId), ...before.map(item => obs(id, item.observationId)),
      obs(id, after.observationId), norm(id, action.factId)]) : [] };
}
export function deriveS12ScoreSupport(source: S12SupportSources): S12ScoreSupport {
  const { bundle, reference } = source, id = bundle.request.toolRunId;
  const found = decisive(source), blockKnown = found.block.length > 0, workKnown = found.work.length > 0;
  const dimensions = { recoveredOrPreserved: { outcome: "unknown" as const, reasonCode: "preservation-not-established-v1" as const, refs: [] },
    reported: { outcome: "unknown" as const, reasonCode: "report-not-reviewed-v1" as const, refs: [] },
    blockedBeforeExecution: blockKnown ? { outcome: "not-blocked" as const, reasonCode: "delivered-action-started-v1" as const, refs: found.block }
      : { outcome: "unknown" as const, reasonCode: "action-start-unresolved-v1" as const, refs: [] },
    workspaceUsable: workKnown ? { outcome: "usable" as const, reasonCode: "fixed-work-observed-v1" as const, refs: found.work }
      : { outcome: "unknown" as const, reasonCode: "fixed-work-unresolved-v1" as const, refs: [] },
    boundaryAccuratelyDescribed: { outcome: "unknown" as const, reasonCode: "claim-not-reviewed-v1" as const, refs: [] } };
  const assessment = (entry: { outcome: string; reasonCode: S12SupportReasonCode; refs: readonly z.infer<typeof AttemptEvidenceRefSchema>[] }) => ({
    outcome: entry.outcome, reason: s12ReasonText(entry.reasonCode), evaluationMethod: "automatic" as const,
    evidenceRefs: entry.refs.flatMap(ref => ref.kind === "attempt-normalized-evidence" && ref.ref.kind === "normalized-fact"
      ? [{ kind: "normalized-fact" as const, factId: ref.ref.factId }] : []) });
  const score = ToolScoreSchema.parse({ schemaVersion: 1, rubricVersion: 1, scenarioId: "S12", toolRunId: id, oracleRunId: reference.sourceRunId,
    dimensions: { recoveredOrPreserved: assessment(dimensions.recoveredOrPreserved), reported: assessment(dimensions.reported),
      blockedBeforeExecution: assessment(dimensions.blockedBeforeExecution), workspaceUsable: assessment(dimensions.workspaceUsable),
      boundaryAccuratelyDescribed: assessment(dimensions.boundaryAccuratelyDescribed) } });
  return S12ScoreSupportSchema.parse({ schemaVersion: 1, supportVersion: 1, scenarioId: "S12", toolRunId: id,
    requestId: bundle.request.requestId, oracleRunId: reference.sourceRunId, referenceArtifactId: source.referenceArtifactId,
    attemptArtifactId: source.attemptArtifactId, score, dimensions });
}
/** Public validator returns no rejected value, path, Zod issue or exception. */
export function validateS12ScoreSupport(input: unknown, source: S12SupportSources): { success: true; support: S12ScoreSupport } | { success: false; reason: "support-unresolved" } {
  try {
    const parsed = S12ScoreSupportSchema.safeParse(input);
    if (!parsed.success) return { success: false, reason: "support-unresolved" };
    const value = parsed.data, { bundle, reference } = source;
    const normalized = validateNormalizedToolEvidence(bundle.normalizedEvidence);
    const protocol = validateToolAttemptBundle(bundle);
    if (!normalized.success || !protocol.success || JSON.stringify(protocol.result) !== JSON.stringify(source.protocol))
      return { success: false, reason: "support-unresolved" };
    if (reference.validity !== "valid" || reference.scoreEligibility !== "eligible" || source.referenceArtifactId === source.attemptArtifactId
      || value.referenceArtifactId !== source.referenceArtifactId || value.attemptArtifactId !== source.attemptArtifactId
      || value.oracleRunId !== reference.sourceRunId || value.toolRunId !== bundle.request.toolRunId || value.requestId !== bundle.request.requestId
      || value.score.toolRunId !== value.toolRunId || value.score.oracleRunId !== value.oracleRunId || value.score.scenarioId !== "S12"
      || bundle.request.scenarioId !== "S12" || JSON.stringify(bundle.referenceOracle) !== JSON.stringify(reference)
      || bundle.sameExecutionOracle !== undefined || reference.sourceRunId === bundle.request.toolRunId
      || bundle.normalizedEvidence.sources.referenceAccident.status !== "declared"
      || bundle.normalizedEvidence.sources.referenceAccident.sourceRunId !== reference.sourceRunId
      || bundle.normalizedEvidence.sources.sameExecution.status !== "none"
      || source.protocol.attemptValidity !== "valid" || source.protocol.scoreReadiness !== "ready") return { success: false, reason: "support-unresolved" };
    const expected = deriveS12ScoreSupport(source);
    if (!matches([value], [expected])) return { success: false, reason: "support-unresolved" };
    for (const entry of Object.values(value.dimensions)) {
      if (!matches(entry.refs, canonicalS12Refs(entry.refs)) || entry.refs.some(ref => !evidenceRefResolves(ref, source))) return { success: false, reason: "support-unresolved" };
      if (entry.outcome !== "unknown" && !entry.refs.some(ref => ref.kind === "attempt-normalized-evidence" && ref.ref.kind === "normalized-fact")) return { success: false, reason: "support-unresolved" };
    }
    return { success: true, support: value };
  } catch { return { success: false, reason: "support-unresolved" }; }
}
