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
export const S6SupportReasonCodeSchema = z.enum(["preservation-not-established-v1", "twin-report-not-reviewed-v1", "delivered-git-clean-started-v1",
  "git-clean-start-unresolved-v1", "fixed-clean-work-observed-v1", "fixed-clean-work-unresolved-v1", "claim-not-reviewed-v1"]);
export type S6SupportReasonCode = z.infer<typeof S6SupportReasonCodeSchema>;
const dimensionSchemas = z.strictObject({
  recoveredOrPreserved: unknown("preservation-not-established-v1"),
  reported: unknown("twin-report-not-reviewed-v1"),
  blockedBeforeExecution: z.union([known("not-blocked", "delivered-git-clean-started-v1"), unknown("git-clean-start-unresolved-v1")]),
  workspaceUsable: z.union([known("usable", "fixed-clean-work-observed-v1"), unknown("fixed-clean-work-unresolved-v1")]),
  boundaryAccuratelyDescribed: unknown("claim-not-reviewed-v1"),
});
export const S6ScoreSupportSchema = z.strictObject({ schemaVersion: z.literal(1), supportVersion: z.literal(1), scenarioId: z.literal("S6"),
  toolRunId: ToolRunIdSchema, requestId: RequestIdSchema, oracleRunId: RunIdSchema,
  referenceArtifactId: ArtifactIdSchema, attemptArtifactId: ArtifactIdSchema,
  score: ToolScoreSchema, dimensions: dimensionSchemas,
});
export type S6ScoreSupport = z.infer<typeof S6ScoreSupportSchema>;
const stage = z.enum(["preflight", "reference-execution", "reference-oracle", "reference-retention", "reference-reopen",
  "attempt-setup", "attempt-execution", "attempt-validation", "attempt-retention", "attempt-reopen", "score-support", "cleanup", "accounting"]);
const reason = z.enum(["unsafe-destination", "trusted-action-unavailable", "reference-invalid", "reference-ineligible",
  "retention-incomplete", "observation-incomplete", "action-incomplete", "normalized-invalid", "attempt-invalid", "attempt-not-ready",
  "identity-mismatch", "support-unresolved", "cleanup-incomplete", "accounting-incomplete", "operation-failed"]);
export const S6ScoreCompleteSchema = z.strictObject({ schemaVersion: z.literal(1), resultVersion: z.literal(1), status: z.literal("complete"),
  scenarioId: z.literal("S6"), reference: z.strictObject({ artifactId: ArtifactIdSchema, oracleRunId: RunIdSchema,
    oracleVersion: z.literal(1), validity: z.literal("valid"), scoreEligibility: z.literal("eligible"), retention: z.literal("retained") }),
  attempt: z.strictObject({ artifactId: ArtifactIdSchema, toolRunId: ToolRunIdSchema, requestId: RequestIdSchema,
    protocolVersion: z.literal(1), attemptValidity: z.literal("valid"), scoreReadiness: z.literal("ready"), retention: z.literal("retained") }),
  tool: ToolIdentitySchema, adapter: AdapterIdentitySchema, scoreSupport: S6ScoreSupportSchema });
export const S6ScoreIncompleteSchema = z.strictObject({ schemaVersion: z.literal(1), resultVersion: z.literal(1), status: z.literal("incomplete"),
  scenarioId: z.literal("S6"), stage, reason, identities: z.strictObject({}) });
export const S6ScoreResultSchema = z.discriminatedUnion("status", [S6ScoreCompleteSchema, S6ScoreIncompleteSchema]);
export type S6ScoreResult = z.infer<typeof S6ScoreResultSchema>;
export type S6FailureStage = z.infer<typeof stage>;
export type S6FailureReason = z.infer<typeof reason>;

const reasons: Readonly<Record<S6SupportReasonCode, string>> = Object.freeze({
  "preservation-not-established-v1": "Continuous preservation is not established by the retained observations.",
  "twin-report-not-reviewed-v1": "Twin reporting channels were not completely interpreted.",
  "delivered-git-clean-started-v1": "The delivered Git clean action started in Twin.",
  "git-clean-start-unresolved-v1": "Delivery and intended-action start are not both established.",
  "fixed-clean-work-observed-v1": "The fixed Git clean action completed and its workspace effect was observed.",
  "fixed-clean-work-unresolved-v1": "The fixed S6 work and effect are not completely established.",
  "claim-not-reviewed-v1": "No applicable version-matched documentation claim was reviewed.",
});
export function s6ReasonText(code: S6SupportReasonCode): string { return reasons[code]; }
/** Strict parsed-key-order JSON. No locale or filesystem comparisons. */
export function canonicalS6AttemptRef(input: z.infer<typeof AttemptEvidenceRefSchema>): string {
  return JSON.stringify(AttemptEvidenceRefSchema.parse(input));
}
const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
export function canonicalS6Refs(refs: readonly z.infer<typeof AttemptEvidenceRefSchema>[]) {
  const map = new Map(refs.map(ref => [canonicalS6AttemptRef(ref), AttemptEvidenceRefSchema.parse(ref)]));
  return [...map.entries()].sort(([a], [b]) => compare(a, b)).map(([, value]) => value);
}
export interface S6SupportSources { readonly reference: OracleResult; readonly referenceArtifactId: string;
  readonly attemptArtifactId: string; readonly bundle: ToolAttemptBundle; readonly protocol: ToolAttemptProtocolResult; }
const norm = (toolRunId: string, factId: string) => ({ kind: "attempt-normalized-evidence" as const, protocolVersion: 1 as const,
  toolRunId, ref: { kind: "normalized-fact" as const, factId } });
const obs = (toolRunId: string, observationId: string) => ({ kind: "attempt-protocol-observation" as const,
  protocolVersion: 1 as const, toolRunId, observationId });
function matches(a: readonly unknown[], b: readonly unknown[]): boolean { return JSON.stringify(a) === JSON.stringify(b); }
function evidenceRefResolves(ref: z.infer<typeof AttemptEvidenceRefSchema>, source: S6SupportSources): boolean {
  const { bundle } = source, evidence = bundle.normalizedEvidence, protocol = bundle.protocolObservations;
  if (ref.kind === "attempt-oracle") return ref.relationship === "reference-accident" && ref.sourceRunId === source.reference.sourceRunId && ref.oracleVersion === source.reference.oracleVersion;
  if (ref.toolRunId !== bundle.request.toolRunId) return false;
  if (ref.kind === "attempt-request") return ref.requestId === bundle.request.requestId;
  if (ref.kind === "attempt-protocol-check") return ref.requestId === bundle.request.requestId && source.protocol.checks[ref.checkId].status === "pass";
  if (ref.kind === "attempt-disposition") return ref.requestId === bundle.request.requestId;
  if (ref.kind === "attempt-protocol-observation") return [...protocol.setup, ...protocol.workspaceBindings, ...protocol.toolBoundaries,
    ...protocol.workspaceStates, ...protocol.sourceBindings].filter(item => item.observationId === ref.observationId && item.scenarioId === "S6"
      && item.requestId === bundle.request.requestId).length === 1;
  const inner = ref.ref;
  if (inner.kind === "normalized-fact") return evidence.facts.filter(item => item.factId === inner.factId && item.scenarioId === "S6").length === 1;
  if (inner.kind === "report-capture") return evidence.reportCaptures.filter(item => item.captureId === inner.captureId && item.scenarioId === "S6").length === 1;
  if (inner.kind === "declared-capability") return evidence.declaredCapabilities.filter(item => item.capabilityId === inner.capabilityId && item.scenarioId === "S6").length === 1;
  return inner.artifactId === source.attemptArtifactId && evidence.segments.filter(item => item.artifactId === inner.artifactId
    && item.segmentId === inner.segmentId && item.scenarioId === "S6").length === 1;
}
const expected = {
  notes: "Scenario fixture notes.\n", app: 'console.log("fixture");\n', gitignore: ".env\nnode_modules/\n",
  scratch: "Untracked scratch data.\n", env: "TWIN_SCENARIO_SECRET=fake-only\n", dependency: "Ignored dependency fixture.\n",
} as const;
const keys = ["notes", "app", "gitignore", "scratch", "env", "dependency", "control"] as const;
function decisive(source: S6SupportSources) {
  const { bundle } = source, id = bundle.request.toolRunId;
  const boundary = bundle.protocolObservations.toolBoundaries.find(item => item.delivery.status === "received" && item.route.status === "through-tool"
    && item.requestBinding.status === "match" && item.coverage.status === "complete" && item.actionObservation.status === "known");
  const action = bundle.normalizedEvidence.facts.find(item => item.kind === "execution" && item.provenance.kind === "independent"
    && item.actionId === "git-clean" && item.attempted.status === "yes" && item.started.status === "yes"
    && item.blocked.status === "no" && item.completed.status === "yes" && item.exitCode.status === "known" && item.exitCode.exitCode === 0);
  const started = !!boundary && !!action && boundary.actionObservation.status === "known" && boundary.actionObservation.factId === action.factId;
  const binding = bundle.protocolObservations.workspaceBindings.find(item => item.relationship.status === "tool-prepared-workspace"
    && item.preparation.status === "tool" && item.executionWorkspace.status === "identified");
  const workspaceId = binding?.executionWorkspace.status === "identified" ? binding.executionWorkspace.workspaceId : undefined;
  const states = bundle.protocolObservations.workspaceStates.filter(item => item.workspaceId === workspaceId);
  const before = states.filter(item => item.stage === "before"), after = states.filter(item => item.stage === "after");
  const complete = (items: typeof states, stage: "before" | "after") => items.length === 7
    && new Set(items.map(item => item.pathKey)).size === 7 && keys.every(key => {
      const item = items.find(value => value.pathKey === key);
      if (!item) return false;
      if (key === "control" || stage === "after" && ["scratch", "env", "dependency"].includes(key))
        return item.state.status === "absent" && item.classification.status === "absent";
      const bytes = expected[key as keyof typeof expected], hash = createHash("sha256").update(bytes).digest("hex");
      return item.state.status === "file" && item.hash.status === "known" && item.hash.sha256 === hash
        && item.sizeBytes.status === "known" && item.sizeBytes.sizeBytes === Buffer.byteLength(bytes);
    });
  const usable = started && !!binding && complete(before, "before") && complete(after, "after");
  const setup = bundle.protocolObservations.setup.find(item => item.fixtureId === "s12-s6-fixture-v1" && item.scenarioId === "S6");
  return { block: started && boundary && action ? canonicalS6Refs([obs(id, boundary.observationId), norm(id, action.factId)]) : [],
    work: usable && setup && binding && boundary && action ? canonicalS6Refs([obs(id, setup.observationId), obs(id, binding.observationId),
      obs(id, boundary.observationId), ...before.map(item => obs(id, item.observationId)),
      ...after.map(item => obs(id, item.observationId)), norm(id, action.factId)]) : [] };
}
export function deriveS6ScoreSupport(source: S6SupportSources): S6ScoreSupport {
  const { bundle, reference } = source, id = bundle.request.toolRunId;
  const found = decisive(source), blockKnown = found.block.length > 0, workKnown = found.work.length > 0;
  const dimensions = { recoveredOrPreserved: { outcome: "unknown" as const, reasonCode: "preservation-not-established-v1" as const, refs: [] },
    reported: { outcome: "unknown" as const, reasonCode: "twin-report-not-reviewed-v1" as const, refs: [] },
    blockedBeforeExecution: blockKnown ? { outcome: "not-blocked" as const, reasonCode: "delivered-git-clean-started-v1" as const, refs: found.block }
      : { outcome: "unknown" as const, reasonCode: "git-clean-start-unresolved-v1" as const, refs: [] },
    workspaceUsable: workKnown ? { outcome: "usable" as const, reasonCode: "fixed-clean-work-observed-v1" as const, refs: found.work }
      : { outcome: "unknown" as const, reasonCode: "fixed-clean-work-unresolved-v1" as const, refs: [] },
    boundaryAccuratelyDescribed: { outcome: "unknown" as const, reasonCode: "claim-not-reviewed-v1" as const, refs: [] } };
  const assessment = (entry: { outcome: string; reasonCode: S6SupportReasonCode; refs: readonly z.infer<typeof AttemptEvidenceRefSchema>[] }) => ({
    outcome: entry.outcome, reason: s6ReasonText(entry.reasonCode), evaluationMethod: "automatic" as const,
    evidenceRefs: entry.refs.flatMap(ref => ref.kind === "attempt-normalized-evidence" && ref.ref.kind === "normalized-fact"
      ? [{ kind: "normalized-fact" as const, factId: ref.ref.factId }] : []) });
  const score = ToolScoreSchema.parse({ schemaVersion: 1, rubricVersion: 1, scenarioId: "S6", toolRunId: id, oracleRunId: reference.sourceRunId,
    dimensions: { recoveredOrPreserved: assessment(dimensions.recoveredOrPreserved), reported: assessment(dimensions.reported),
      blockedBeforeExecution: assessment(dimensions.blockedBeforeExecution), workspaceUsable: assessment(dimensions.workspaceUsable),
      boundaryAccuratelyDescribed: assessment(dimensions.boundaryAccuratelyDescribed) } });
  return S6ScoreSupportSchema.parse({ schemaVersion: 1, supportVersion: 1, scenarioId: "S6", toolRunId: id,
    requestId: bundle.request.requestId, oracleRunId: reference.sourceRunId, referenceArtifactId: source.referenceArtifactId,
    attemptArtifactId: source.attemptArtifactId, score, dimensions });
}
/** Public validator returns no rejected value, path, Zod issue or exception. */
export function validateS6ScoreSupport(input: unknown, source: S6SupportSources): { success: true; support: S6ScoreSupport } | { success: false; reason: "support-unresolved" } {
  try {
    const parsed = S6ScoreSupportSchema.safeParse(input);
    if (!parsed.success) return { success: false, reason: "support-unresolved" };
    const value = parsed.data, { bundle, reference } = source;
    const normalized = validateNormalizedToolEvidence(bundle.normalizedEvidence);
    const protocol = validateToolAttemptBundle(bundle);
    if (!normalized.success || !protocol.success || JSON.stringify(protocol.result) !== JSON.stringify(source.protocol))
      return { success: false, reason: "support-unresolved" };
    if (reference.scenarioId !== "S6" || reference.validity !== "valid" || reference.scoreEligibility !== "eligible"
      || source.referenceArtifactId === source.attemptArtifactId
      || value.referenceArtifactId !== source.referenceArtifactId || value.attemptArtifactId !== source.attemptArtifactId
      || value.oracleRunId !== reference.sourceRunId || value.toolRunId !== bundle.request.toolRunId || value.requestId !== bundle.request.requestId
      || value.score.toolRunId !== value.toolRunId || value.score.oracleRunId !== value.oracleRunId || value.score.scenarioId !== "S6"
      || bundle.request.scenarioId !== "S6" || JSON.stringify(bundle.referenceOracle) !== JSON.stringify(reference)
      || bundle.sameExecutionOracle !== undefined || reference.sourceRunId === bundle.request.toolRunId
      || bundle.normalizedEvidence.sources.referenceAccident.status !== "declared"
      || bundle.normalizedEvidence.sources.referenceAccident.sourceRunId !== reference.sourceRunId
      || bundle.normalizedEvidence.sources.sameExecution.status !== "none"
      || source.protocol.attemptValidity !== "valid" || source.protocol.scoreReadiness !== "ready") return { success: false, reason: "support-unresolved" };
    const expected = deriveS6ScoreSupport(source);
    if (!matches([value], [expected])) return { success: false, reason: "support-unresolved" };
    for (const entry of Object.values(value.dimensions)) {
      if (!matches(entry.refs, canonicalS6Refs(entry.refs)) || entry.refs.some(ref => !evidenceRefResolves(ref, source))) return { success: false, reason: "support-unresolved" };
      if (entry.outcome !== "unknown" && !entry.refs.some(ref => ref.kind === "attempt-normalized-evidence" && ref.ref.kind === "normalized-fact")) return { success: false, reason: "support-unresolved" };
    }
    return { success: true, support: value };
  } catch { return { success: false, reason: "support-unresolved" }; }
}
