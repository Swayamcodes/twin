import { evaluateScenarioOracle } from "../oracle.js";
import { sha256, type PathKey } from "../contract/evidence-refs.js";
import { OracleResultSchema, type OracleResult } from "../contract/oracle-schema.js";
import { NormalizedToolEvidenceSchema, type NormalizedToolEvidence } from "../contract/normalized-evidence-schema.js";
import { validateNormalizedToolEvidence } from "../contract/normalized-evidence-validation.js";
import { ToolAttemptBundleSchema } from "../contract/attempt-protocol-schema.js";
import { validateToolAttemptBundle } from "../contract/attempt-protocol-validation.js";
import { parseCaptureRecords, incomplete } from "./records.js";
const pinnedBytes: Readonly<Record<PathKey, string>> = Object.freeze({ notes: "Scenario fixture notes.\n",
  app: 'console.log("fixture");\n', gitignore: ".env\nnode_modules/\n", scratch: "Untracked scratch data.\n",
  env: "TWIN_SCENARIO_SECRET=fake-only\n", dependency: "Ignored dependency fixture.\n", control: "S12 control file.\n" });
/** Oracle issue-message digests are private too. Use a resolvable whole-run ref. */
function publicOracle(value: OracleResult): OracleResult {
  return OracleResultSchema.parse({ ...value,
    checks: Object.fromEntries(Object.entries(value.checks).map(([key, check]) => [key, { ...check,
      reason: `reference-${check.status}`, evidenceRefs: check.evidenceRefs.map((ref) =>
        ref.kind === "scenario-issue-group" ? { kind: "scenario-run" as const } : ref) }])),
    cleanup: { ...value.cleanup, reason: `reference-cleanup-${value.cleanup.status}` } });
}

/** Pure replay. No IDs, timestamps, observations, or reference-to-attempt state are invented. */
export function projectCapture(records: unknown) {
  try {
    const parsed = parseCaptureRecords(records);
    if (!parsed.success) return incomplete("invalid-record");
    const value = parsed.records;
    const referenceOracle = evaluateScenarioOracle(value.capture.reference.raw, value.capture.reference.context);
    if (value.capture.attempt.status === "not-started") return {
      privateFormatVersion: 1 as const, normalizerVersion: 1 as const, status: "projected" as const, retention: "unverified" as const,
      kind: "reference-only" as const, referenceOracle: publicOracle(referenceOracle), attempt: { status: "not-started" as const, reason: value.capture.attempt.reason },
    };
    if (value.outcome.attempt.status !== "collected") return incomplete("invalid-record");
    const attempt = value.capture.attempt.record;
    const identity = { toolRunId: attempt.request.toolRunId, scenarioId: attempt.request.scenarioId };
    const artifactId = value.reservation.artifactId;
    const observer = { kind: "private-artifact-segment" as const, artifactId, segmentId: attempt.observerSegmentId };
    const channels = ["stdout", "stderr"] as const;
    const normalizedEvidence: NormalizedToolEvidence = NormalizedToolEvidenceSchema.parse({ schemaVersion: 1, ...identity,
      tool: { name: "direct-baseline", version: attempt.toolVersion }, adapter: { name: "direct-baseline", version: attempt.toolVersion },
      sources: { referenceAccident: { status: "declared", relationship: "reference-accident", scenarioId: referenceOracle.scenarioId,
        sourceRunId: referenceOracle.sourceRunId, oracleVersion: 1 }, sameExecution: { status: "none", reason: "not-captured" } },
      startedAt: attempt.startedAt, endedAt: attempt.endedAt,
      facts: [...attempt.originalStates, ...attempt.events, ...attempt.workspaceInputs], declaredCapabilities: [], availability: attempt.availability,
      reporting: { stdout: { status: "applicable", captureId: attempt.stdout.captureId },
        stderr: { status: "applicable", captureId: attempt.stderr.captureId },
        log: { status: "not-applicable", reason: "not-applicable" }, receipt: { status: "not-applicable", reason: "not-applicable" } },
      reportCaptures: channels.map((channel) => ({ ...identity, channel, captureId: attempt[channel].captureId,
        capture: attempt[channel].status === "complete" ? { status: "complete" }
          : { status: attempt[channel].status, reason: "reason" in attempt[channel] ? attempt[channel].reason : "not-captured" },
        interpretation: { status: "not-performed", reason: "not-captured" } })),
      segments: [{ ...identity, artifactId, segmentId: attempt.observerSegmentId, channel: "observer-record", capture: { kind: "none" },
        privateReference: { status: "yes" }, redaction: { status: "withheld", reason: "private-only" },
        publicVerifiability: { status: "not-publicly-verifiable", reason: "private-only" } },
      ...channels.map((channel) => ({ ...identity, artifactId, segmentId: attempt[channel].segmentId, channel,
        capture: { kind: "capture", captureId: attempt[channel].captureId }, privateReference: { status: "yes" },
        redaction: { status: "withheld", reason: "private-only" }, publicVerifiability: { status: "not-publicly-verifiable", reason: "private-only" } }))],
    });
    const normalizedValidation = validateNormalizedToolEvidence(normalizedEvidence);
    const bundle = ToolAttemptBundleSchema.parse({ schemaVersion: 1, protocolVersion: 1, request: attempt.request,
      referenceOracle, normalizedEvidence,
      protocolObservations: { setup: attempt.setup, workspaceBindings: attempt.workspaceBindings, toolBoundaries: attempt.toolBoundaries,
        workspaceStates: attempt.workspaceStates, sourceBindings: attempt.sourceBindings,
        disposition: { ...identity, requestId: attempt.request.requestId, cleanup: value.outcome.attempt.cleanup,
          artifacts: { status: "unknown", reason: "not-observed", evidenceRefs: [observer] } } },
    });
    const validation = validateToolAttemptBundle(bundle);
    // Both validators see actual private states/hashes first. Version 1 refuses
    // all unexpected known content hashes rather than erasing decisive evidence.
    if ([...attempt.originalStates, ...attempt.workspaceStates].some((item) => item.hash.status === "known"
      && item.hash.sha256 !== sha256(pinnedBytes[item.pathKey]))) return incomplete("private-content");
    if (!normalizedValidation.success || !validation.success) return incomplete("projection-invalid");
    const sanitizedOracle = publicOracle(referenceOracle);
    return { privateFormatVersion: 1 as const, normalizerVersion: 1 as const, status: "projected" as const, retention: "unverified" as const,
      kind: "reference-plus-attempt" as const, referenceOracle: sanitizedOracle, normalizedEvidence,
      bundle: { ...bundle, referenceOracle: sanitizedOracle }, protocol: validation.result };
  } catch {
    return incomplete("projection-invalid");
  }
}
export type CaptureProjection = ReturnType<typeof projectCapture>;
