import { z } from "zod";
import { NormalizedToolEvidenceSchema, ReportChannelSchema, type NormalizedToolEvidence,
  type Position, type SegmentRef, type Timestamp } from "./normalized-evidence-schema.js";

export const NormalizedEvidenceValidationIssueCodeSchema = z.enum(["invalid-shape", "identity-mismatch", "duplicate-id",
  "unresolved-reference", "reference-kind-mismatch", "capture-mismatch", "chronology-conflict",
  "availability-conflict", "completeness-conflict", "provenance-conflict"]);
export const DiagnosticPathKeySchema = z.enum([
  "schemaVersion", "toolRunId", "scenarioId", "sources", "referenceAccident", "sameExecution", "status", "relationship",
  "sourceRunId", "oracleVersion", "oracle", "reason", "tool", "adapter", "name", "version", "startedAt", "endedAt",
  "facts", "declaredCapabilities", "reporting", "reportCaptures", "segments", "availability", "factId", "kind", "pathKey",
  "stage", "position", "timestamp", "order", "sequence", "state", "hash", "sha256", "provenance", "collector", "method",
  "evidenceRefs", "artifactId", "segmentId", "eventType", "target", "disposition", "captureId", "segmentRef", "actionId",
  "attempted", "started", "blocked", "completed", "attemptedAt", "blockedAt", "completedAt", "exitCode", "signal", "phase",
  "requirement", "presence", "usability", "scope", "aspect", "behavior", "captureIds", "capabilityId", "statementId", "claim",
  "documentationVersion", "appliesToToolVersion", "stdout", "stderr", "log", "receipt", "channel", "capture", "interpretation",
  "privateReference", "redaction", "policyVersion", "publicVerifiability", "originalState", "reportedEvents", "execution",
  "workspaceInputs", "boundaryObservations",
]);
export type DiagnosticPathKey = z.infer<typeof DiagnosticPathKeySchema>;
export const NormalizedEvidenceValidationIssueSchema = z.strictObject({ code: NormalizedEvidenceValidationIssueCodeSchema,
  path: z.array(z.union([DiagnosticPathKeySchema, z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)])) });
export type NormalizedEvidenceValidationIssueCode = z.infer<typeof NormalizedEvidenceValidationIssueCodeSchema>;
export type NormalizedEvidenceValidationIssue = z.infer<typeof NormalizedEvidenceValidationIssueSchema>;
export type NormalizedEvidenceValidationResult =
  | { success: true; evidence: NormalizedToolEvidence }
  | { success: false; issues: NormalizedEvidenceValidationIssue[] };
type Path = NormalizedEvidenceValidationIssue["path"];

function comparePaths(a: Path, b: Path): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (x === y) continue;
    if (typeof x === "number" && typeof y === "number") return x - y;
    if (typeof x !== typeof y) return typeof x === "number" ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return a.length - b.length;
}
function failure(issues: NormalizedEvidenceValidationIssue[]): NormalizedEvidenceValidationResult {
  const codes = NormalizedEvidenceValidationIssueCodeSchema.options;
  issues.sort((a, b) => codes.indexOf(a.code) - codes.indexOf(b.code) || comparePaths(a.path, b.path));
  return { success: false, issues: issues.filter((item, i) => i === 0
    || item.code !== issues[i - 1]!.code || comparePaths(item.path, issues[i - 1]!.path) !== 0) };
}
// Zod paths from these strict, fixed-key schemas contain only schema keys and array
// indices. Unknown keys live in issue.keys, which is deliberately never inspected.
// Keep a fixed allowlist as a second boundary; do not echo input-derived properties.

function safePath(path: readonly PropertyKey[]): Path {
  const result: Path = [];
  for (const part of path) {
    if (typeof part === "number" && Number.isSafeInteger(part) && part >= 0) result.push(part);
    else if (typeof part === "string" && DiagnosticPathKeySchema.safeParse(part).success) result.push(DiagnosticPathKeySchema.parse(part));
    else break;
  }
  return result;
}
function millis(time: Timestamp): number | undefined {
  return time.status === "known" ? Date.parse(time.timestamp) : undefined;
}
const segmentKey = (ref: { artifactId: string; segmentId: string }): string => `${ref.artifactId}/${ref.segmentId}`;

/** Pure internal validation. No oracle resolution, attempt verdict, or score. */
export function validateNormalizedToolEvidence(input: unknown): NormalizedEvidenceValidationResult {
  try {
    const parsed = NormalizedToolEvidenceSchema.safeParse(input);
    if (!parsed.success) return failure(parsed.error.issues.map((issue) => ({ code: "invalid-shape", path: safePath(issue.path) })));
    return validateParsed(parsed.data);
  } catch {
    // Malformed non-JSON inputs (for example throwing accessors or cyclic data)
    // must not leak implementation errors or caller-provided exception text.
    return failure([{ code: "invalid-shape", path: [] }]);
  }
}
function validateParsed(evidence: NormalizedToolEvidence): NormalizedEvidenceValidationResult {
  const issues: NormalizedEvidenceValidationIssue[] = [];
  const add = (code: NormalizedEvidenceValidationIssueCode, path: Path): void => { issues.push({ code, path }); };
  const identity = (item: { toolRunId: string; scenarioId: string }, path: Path): void => {
    if (item.toolRunId !== evidence.toolRunId) add("identity-mismatch", [...path, "toolRunId"]);
    if (item.scenarioId !== evidence.scenarioId) add("identity-mismatch", [...path, "scenarioId"]);
  };
  const unique = (ids: string[], path: Path, field: DiagnosticPathKey): void => {
    const seen = new Set<string>();
    ids.forEach((id, index) => {
      if (seen.has(id)) add("duplicate-id", [...path, index, field]);
      seen.add(id);
    });
  };
  unique(evidence.facts.map((item) => item.factId), ["facts"], "factId");
  unique(evidence.declaredCapabilities.map((item) => item.capabilityId), ["declaredCapabilities"], "capabilityId");
  unique(evidence.reportCaptures.map((item) => item.captureId), ["reportCaptures"], "captureId");
  unique(evidence.segments.map(segmentKey), ["segments"], "segmentId");
  for (const key of ["referenceAccident", "sameExecution"] as const) {
    const link = evidence.sources[key];
    if (link.status === "declared" && link.scenarioId !== evidence.scenarioId) add("identity-mismatch", ["sources", key, "scenarioId"]);
  }
  const segments = new Map(evidence.segments.map((item) => [segmentKey(item), item]));
  const captures = new Map(evidence.reportCaptures.map((item) => [item.captureId, item]));
  const resolveSegment = (ref: SegmentRef, path: Path) => {
    const found = segments.get(segmentKey(ref));
    if (!found) add("unresolved-reference", path);
    return found;
  };
  const resolveCapture = (id: string, path: Path) => {
    const found = captures.get(id);
    if (!found) add("unresolved-reference", path);
    return found;
  };
  evidence.segments.forEach((segment, index) => {
    const path: Path = ["segments", index];
    identity(segment, path);
    if (segment.capture.kind === "capture") {
      const capture = resolveCapture(segment.capture.captureId, [...path, "capture"]);
      if (capture && capture.channel !== segment.channel) add("capture-mismatch", [...path, "capture"]);
    }
  });
  for (const channel of ReportChannelSchema.options) {
    const entry = evidence.reporting[channel];
    if (entry.status === "applicable") {
      const capture = resolveCapture(entry.captureId, ["reporting", channel, "captureId"]);
      if (capture && capture.channel !== channel) add("capture-mismatch", ["reporting", channel]);
    }
  }
  evidence.reportCaptures.forEach((capture, index) => {
    const path: Path = ["reportCaptures", index];
    identity(capture, path);
    const owners = ReportChannelSchema.options.filter((channel) => {
      const entry = evidence.reporting[channel];
      return entry.status === "applicable" && entry.captureId === capture.captureId && channel === capture.channel;
    });
    if (owners.length !== 1) add("capture-mismatch", path);
    if (capture.capture.status === "complete" && !evidence.segments.some((segment) => segment.capture.kind === "capture"
      && segment.capture.captureId === capture.captureId && segment.channel === capture.channel)) {
      add("completeness-conflict", [...path, "capture"]);
    }
  });
  const allReportsComplete = (): boolean => {
    let applicable = 0;
    for (const channel of ReportChannelSchema.options) {
      const entry = evidence.reporting[channel];
      if (entry.status === "unknown") return false;
      if (entry.status === "applicable") {
        applicable++;
        const capture = captures.get(entry.captureId);
        if (!capture || capture.capture.status !== "complete" || capture.interpretation.status !== "complete") return false;
      }
    }
    return applicable > 0;
  };
  const positions: { position: Position; path: Path }[] = [];
  const start = millis(evidence.startedAt);
  const end = millis(evidence.endedAt);
  if (start !== undefined && end !== undefined && start > end) add("chronology-conflict", ["endedAt"]);
  const position = (point: Position, path: Path): void => {
    positions.push({ position: point, path });
    const time = millis(point.timestamp);
    if (time !== undefined && (start !== undefined && time < start || end !== undefined && time > end)) {
      add("chronology-conflict", path);
    }
  };
  const before = (a: Position, b: Position, path: Path): void => {
    const x = millis(a.timestamp), y = millis(b.timestamp);
    const seqA = a.order.status === "known" ? a.order.sequence : undefined;
    const seqB = b.order.status === "known" ? b.order.sequence : undefined;
    if (x !== undefined && y !== undefined && x > y
      || seqA !== undefined && seqB !== undefined && seqA > seqB) {
      add("chronology-conflict", path);
    }
  };
  const provenance = (item: NormalizedToolEvidence["facts"][number] | NormalizedToolEvidence["declaredCapabilities"][number], path: Path): void => {
    item.provenance.evidenceRefs.forEach((ref, index) => {
      const refPath: Path = [...path, "provenance", "evidenceRefs", index];
      const segment = resolveSegment(ref, refPath);
      if (!segment) return;
      const expected = item.provenance.kind === "independent" ? "observer-record"
        : item.provenance.collector === "tool-documentation" ? "documentation" : "report";
      if (expected === "report" ? segment.channel === "documentation" || segment.channel === "observer-record" : segment.channel !== expected) {
        add("provenance-conflict", refPath);
        return;
      }
      if (expected === "report") {
        if (segment.capture.kind !== "capture") {
          add("capture-mismatch", refPath);
          return;
        }
        const capture = resolveCapture(segment.capture.captureId, refPath);
        if (!capture) return;
        const owner = evidence.reporting[capture.channel];
        if (capture.channel !== segment.channel || owner.status !== "applicable" || owner.captureId !== capture.captureId) {
          add("capture-mismatch", refPath);
        }
        if (!["complete", "partial"].includes(capture.capture.status)
          || !["complete", "partial"].includes(capture.interpretation.status)) {
          add("completeness-conflict", refPath);
        }
      }
    });
  };
  evidence.declaredCapabilities.forEach((item, index) => {
    identity(item, ["declaredCapabilities", index]);
    provenance(item, ["declaredCapabilities", index]);
  });
  evidence.facts.forEach((item, index) => {
    const path: Path = ["facts", index];
    identity(item, path);
    provenance(item, path);
    if (item.kind === "execution") {
      for (const key of ["attemptedAt", "startedAt", "blockedAt", "completedAt"] as const) position(item[key], [...path, key]);
      for (const [earlier, later] of [["attempted", "started"], ["attempted", "blocked"],
        ["attempted", "completed"], ["started", "completed"]] as const) {
        if (item[earlier].status === "yes" && item[later].status === "yes") {
          before(item[`${earlier}At`], item[`${later}At`], [...path, `${later}At`]);
        }
      }
    } else position(item.position, [...path, "position"]);
    if (item.kind === "reported-event") {
      resolveCapture(item.captureId, [...path, "captureId"]);
      const segment = resolveSegment(item.segmentRef, [...path, "segmentRef"]);
      if (segment && (segment.capture.kind !== "capture" || segment.capture.captureId !== item.captureId)) {
        add("capture-mismatch", [...path, "segmentRef"]);
      }
    }
    if (item.kind === "boundary-observation") {
      item.captureIds.forEach((id, i) => { resolveCapture(id, [...path, "captureIds", i]); });
      if (item.aspect === "reporting" && item.behavior.status === "reported"
        && !item.provenance.evidenceRefs.some((ref) => {
          const segment = segments.get(segmentKey(ref));
          return segment?.capture.kind === "capture" && item.captureIds.includes(segment.capture.captureId);
        })) add("capture-mismatch", [...path, "captureIds"]);
      if (item.behavior.status === "unreported") {
        const applicableIds = ReportChannelSchema.options.flatMap((channel) => {
          const entry = evidence.reporting[channel];
          return entry.status === "applicable" ? [entry.captureId] : [];
        });
        if (!allReportsComplete() || applicableIds.some((id) => !item.captureIds.includes(id))) {
          add("completeness-conflict", [...path, "captureIds"]);
        }
      }
    }
    if (item.kind === "workspace-input") {
      evidence.facts.forEach((execution) => {
        if (execution.kind !== "execution" || execution.actionId !== item.actionId) return;
        for (const milestone of ["attempted", "started", "blocked", "completed"] as const) {
          if (execution[milestone].status === "yes") before(item.position, execution[`${milestone}At`], [...path, "position"]);
        }
      });
    }
  });
  // Compare only explicit ordering evidence; array order carries no chronology.
  positions.forEach((a, index) => {
    for (const b of positions.slice(index + 1)) {
      const x = millis(a.position.timestamp), y = millis(b.position.timestamp);
      if (x !== undefined && y !== undefined && a.position.order.status === "known" && b.position.order.status === "known"
        && (x - y) * Math.sign(a.position.order.sequence - b.position.order.sequence) < 0) {
        add("chronology-conflict", b.path);
      }
    }
  });
  const classes = [
    ["originalState", "original-state-observation"], ["reportedEvents", "reported-event"], ["execution", "execution"],
    ["workspaceInputs", "workspace-input"], ["boundaryObservations", "boundary-observation"],
  ] as const;
  for (const [key, kind] of classes) {
    const status = evidence.availability[key].status;
    if ((status === "unknown" || status === "unavailable") && evidence.facts.some((item) => item.kind === kind)) {
      add("availability-conflict", ["availability", key]);
    }
  }
  if (["unknown", "unavailable"].includes(evidence.availability.declaredCapabilities.status) && evidence.declaredCapabilities.length) {
    add("availability-conflict", ["availability", "declaredCapabilities"]);
  }
  return issues.length ? failure(issues) : { success: true, evidence };
}
