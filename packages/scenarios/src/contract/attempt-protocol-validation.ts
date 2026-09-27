import { pathKeys, sha256, type PathKey } from "./evidence-refs.js";
import { validateNormalizedToolEvidence } from "./normalized-evidence-validation.js";
import type { Execution, NormalizedFact, OriginalStateObservation, Position, SegmentRef, WorkspaceInput } from "./normalized-evidence-schema.js";
import { AttemptCheckIdSchema, AttemptDiagnosticPathKeySchema, ToolAttemptBundleSchema,
  ToolAttemptValidationResponseSchema, deriveAttemptScoreReadiness, deriveAttemptValidity,
  type AttemptCheck, type AttemptCheckId, type AttemptChecks, type AttemptEvidenceRef, type AttemptInputIssue,
  type AttemptReasonCode, type ToolAttemptBundle, type ToolAttemptValidationResponse } from "./attempt-protocol-schema.js";

// Independently pinned protocol-v1 fixture, never imported from a producer.
const bytes: Readonly<Record<Exclude<PathKey, "control">, string>> = {
  notes: "Scenario fixture notes.\n", app: 'console.log("fixture");\n', gitignore: ".env\nnode_modules/\n",
  scratch: "Untracked scratch data.\n", env: "TWIN_SCENARIO_SECRET=fake-only\n", dependency: "Ignored dependency fixture.\n",
};
const classification: Readonly<Record<PathKey, string>> = {
  notes: "tracked", app: "tracked", gitignore: "tracked", scratch: "untracked", env: "ignored", dependency: "ignored", control: "absent",
};
const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => compare(a, b))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
function uniqueSorted<T>(values: readonly T[]): T[] {
  const byKey = new Map(values.map((value) => [canonical(value), value]));
  return [...byKey.entries()].sort(([a], [b]) => compare(a, b)).map(([, value]) => value);
}
/** Relative order from supplied positions only. Equal batches are not strict order. */
function ordering(a: Position, b: Position, strict: boolean): "pass" | "fail" | "unknown" {
  const signs: number[] = [];
  if (a.order.status === "known" && b.order.status === "known") signs.push(Math.sign(a.order.sequence - b.order.sequence));
  if (a.timestamp.status === "known" && b.timestamp.status === "known") signs.push(compare(a.timestamp.timestamp, b.timestamp.timestamp));
  if (signs.some((sign) => sign > 0)) return "fail";
  return signs.some((sign) => sign < 0) || !strict && signs.length > 0 ? "pass" : "unknown";
}
/** Shared known coordinates establish a point; unknown reason labels do not. */
function samePoint(a: Position, b: Position): boolean {
  const matches: boolean[] = [];
  if (a.order.status === "known" && b.order.status === "known") matches.push(a.order.sequence === b.order.sequence);
  if (a.timestamp.status === "known" && b.timestamp.status === "known") matches.push(a.timestamp.timestamp === b.timestamp.timestamp);
  return matches.length > 0 && matches.every(Boolean);
}

const orderingRoles = ["baseline", "originalBefore", "setup", "offered", "received", "binding", "preparedBinding", "unresolvedBinding",
  "executionPre", "attempted", "started", "blocked", "completed", "settled", "originalPost", "executionPost",
  "noncreation", "cleanup", "during", "executionDuring"] as const;
type OrderingRole = typeof orderingRoles[number];
type OrderingPoint = { position: Position; refs: AttemptEvidenceRef[] };
type OrderingPoints = Record<OrderingRole, OrderingPoint[]>;
// Fixed semantic edges: 1 permits equality, 2 requires strict precedence.
// Roles without records still participate in closure; no positions are invented.
// Direct/shared workspaces can predate receipt, unlike tool-prepared workspaces.
const orderingEdges: readonly (readonly [OrderingRole, OrderingRole, 1 | 2])[] = [
  ["baseline", "setup", 1], ["originalBefore", "offered", 2], ["setup", "offered", 2],
  ["setup", "binding", 2], ["setup", "preparedBinding", 2], ["setup", "unresolvedBinding", 2], ["setup", "noncreation", 2],
  ["offered", "received", 1], ["received", "preparedBinding", 1],
  ["binding", "executionPre", 1], ["preparedBinding", "executionPre", 1],
  ["received", "attempted", 1], ["received", "started", 1], ["received", "blocked", 1], ["received", "completed", 1],
  ["received", "settled", 1], ["executionPre", "attempted", 2], ["executionPre", "started", 2],
  ["executionPre", "blocked", 2], ["executionPre", "completed", 2], ["executionPre", "settled", 2],
  ["attempted", "started", 1], ["attempted", "blocked", 1], ["started", "completed", 1],
  ["attempted", "settled", 1], ["started", "settled", 1], ["blocked", "settled", 1], ["completed", "settled", 1],
  ["settled", "originalPost", 2], ["settled", "executionPost", 2], ["settled", "noncreation", 1],
  ["originalPost", "cleanup", 2], ["executionPost", "cleanup", 2], ["noncreation", "cleanup", 2],
  ["offered", "during", 1], ["during", "settled", 1],
  ["offered", "executionDuring", 1], ["executionDuring", "settled", 1],
  ["binding", "executionDuring", 1], ["preparedBinding", "executionDuring", 1],
];
function checkSemanticOrdering(points: OrderingPoints,
  check: (a: Position, b: Position, strict: boolean, refs: AttemptEvidenceRef[]) => void): void {
  const closure = orderingRoles.map(() => orderingRoles.map(() => 0));
  for (const [from, to, strength] of orderingEdges) {
    // This branch applies only to an identified tool-prepared workspace, not a
    // direct workspace or a blocked-before-creation attempt. Unknown coordinates
    // do not disable it; only the workspace's semantic binding selects the branch.
    if (from === "received" && to === "preparedBinding" && points.preparedBinding.length === 0) continue;
    closure[orderingRoles.indexOf(from)]![orderingRoles.indexOf(to)] = strength;
  }
  // A path is strict if any edge is strict. Keep the strongest implied constraint.
  for (let via = 0; via < orderingRoles.length; via++) for (let from = 0; from < orderingRoles.length; from++) {
    for (let to = 0; to < orderingRoles.length; to++) {
      const left = closure[from]![via]!, right = closure[via]![to]!;
      if (left && right) closure[from]![to] = Math.max(closure[from]![to]!, left, right);
    }
  }
  for (const [from, fromRole] of orderingRoles.entries()) for (const [to, toRole] of orderingRoles.entries()) {
    const strength = closure[from]![to]!;
    if (!strength) continue;
    for (const a of points[fromRole]) for (const b of points[toRole]) check(a.position, b.position, strength === 2, [...a.refs, ...b.refs]);
  }
}

/** Public diagnostics intentionally identify only approved envelope fields. */
export function validateToolAttemptBundle(input: unknown): ToolAttemptValidationResponse {
  try {
    const parsed = ToolAttemptBundleSchema.safeParse(input);
    if (!parsed.success) {
      const issues: AttemptInputIssue[] = parsed.error.issues.map((issue) => {
        const key = AttemptDiagnosticPathKeySchema.safeParse(issue.path[0]);
        return { code: "invalid-shape", path: key.success ? [key.data] : [] };
      });
      return { schemaVersion: 1, success: false, issues: uniqueSorted(issues) };
    }
    return ToolAttemptValidationResponseSchema.parse({ schemaVersion: 1, success: true, result: validateParsed(parsed.data) });
  } catch {
    return { schemaVersion: 1, success: false, issues: [{ code: "invalid-shape", path: [] }] };
  }
}

function validateParsed(bundle: ToolAttemptBundle) {
  const { request, normalizedEvidence: evidence, protocolObservations: observations } = bundle;
  const scope = { protocolVersion: 1 as const, toolRunId: request.toolRunId };
  const requestRef: AttemptEvidenceRef = { kind: "attempt-request", ...scope, requestId: request.requestId };
  const observationRef = (observationId: string): AttemptEvidenceRef => ({ kind: "attempt-protocol-observation", ...scope, observationId });
  const factRef = (factId: string): AttemptEvidenceRef => ({ kind: "attempt-normalized-evidence", ...scope,
    ref: { kind: "normalized-fact", factId } });
  const checks = Object.fromEntries(AttemptCheckIdSchema.options.map((key) => [key,
    { status: "pass", reasons: ["requirements-established"], evidenceRefs: [requestRef] }])) as AttemptChecks;
  const add = (key: AttemptCheckId, status: AttemptCheck["status"], reason: AttemptReasonCode,
    refs: AttemptEvidenceRef[] = [requestRef]): void => {
    const check = checks[key];
    if (status === "fail" || status === "unknown" && check.status === "pass") check.status = status;
    if (reason !== "requirements-established") check.reasons = check.reasons.filter((item) => item !== "requirements-established");
    check.reasons.push(reason);
    check.evidenceRefs.push(...refs);
  };
  const needOrder = (a: Position, b: Position, strict = true, refs: AttemptEvidenceRef[] = [requestRef]): void => {
    checks.ordering.evidenceRefs.push(...refs);
    const status = ordering(a, b, strict);
    if (status !== "pass") add("ordering", status, status === "fail" ? "ordering-violation" : "ordering-insufficient", refs);
  };
  const requireKnown = (value: { status: string }, check: AttemptCheckId, refs: AttemptEvidenceRef[]): void => {
    if (value.status === "unknown") add(check, "unknown", "coverage-incomplete", refs);
  };
  const intrinsicConflict = (reason: AttemptReasonCode, refs: AttemptEvidenceRef[]): void => add("bundleRelationships", "fail", reason, refs);
  const support = (key: AttemptCheckId, refs: AttemptEvidenceRef[]): void => { checks[key].evidenceRefs.push(...refs); };
  const sameIdentity = (item: { toolRunId: string; scenarioId: string; requestId?: string }, refs: AttemptEvidenceRef[]): void => {
    if (item.toolRunId !== request.toolRunId || item.scenarioId !== request.scenarioId
      || item.requestId !== undefined && item.requestId !== request.requestId) {
      add("identities", "fail", "identity-mismatch", refs);
      intrinsicConflict("identity-mismatch", refs);
    }
  };
  sameIdentity(evidence, [requestRef]);
  sameIdentity(observations.disposition, [{ kind: "attempt-disposition", ...scope, requestId: request.requestId }]);
  const normalized = validateNormalizedToolEvidence(evidence);
  support("normalizedConsistency", evidence.facts.map((fact) => factRef(fact.factId)));
  support("reportingMetadata", evidence.reportCaptures.map((capture) => ({ kind: "attempt-normalized-evidence", ...scope,
    ref: { kind: "report-capture", captureId: capture.captureId } })));
  if (!normalized.success) {
    // A reference-link scenario mismatch is readiness-only, even when the
    // independent normalized validator also diagnoses that source declaration.
    const intrinsic = normalized.issues.filter((issue) => !(issue.path[0] === "sources" && issue.path[1] === "referenceAccident"));
    if (intrinsic.length) add("normalizedConsistency", "fail", "normalized-inconsistent");
    if (intrinsic.some((issue) => issue.code === "identity-mismatch")) {
      add("identities", "fail", "identity-mismatch");
      intrinsicConflict("identity-mismatch", [requestRef]);
    }
    const reportingFact = (item: NormalizedFact): boolean => item.kind === "reported-event" || item.provenance.kind === "tool-claimed"
      || item.kind === "boundary-observation" && item.aspect === "reporting";
    const reportingIssues = intrinsic.filter((issue) => {
      if (issue.code === "chronology-conflict") return false;
      const [collection, index] = issue.path;
      if (collection === "reporting" || collection === "reportCaptures") return true;
      if (collection === "segments" && typeof index === "number") {
        const item = evidence.segments[index];
        return item !== undefined && evidence.segments.some((other) => other.artifactId === item.artifactId
          && other.segmentId === item.segmentId && other.capture.kind === "capture");
      }
      if (collection === "facts" && typeof index === "number") {
        const item = evidence.facts[index];
        return item !== undefined && (reportingFact(item) || issue.code === "duplicate-id"
          && evidence.facts.some((other) => other.factId === item.factId && reportingFact(other)));
      }
      return collection === "availability" && (index === "reportedEvents"
        || index === "boundaryObservations" && evidence.facts.some((item) => item.kind === "boundary-observation" && item.aspect === "reporting"));
    });
    if (reportingIssues.length) add("reportingMetadata", "fail", "normalized-inconsistent");
  }
  if (request.action.actionId !== (request.scenarioId === "S12" ? "create-control-file" : "git-clean")) {
    add("requestIdentity", "fail", "request-mismatch");
  }
  const all = [...observations.setup, ...observations.workspaceBindings, ...observations.toolBoundaries,
    ...observations.workspaceStates, ...observations.sourceBindings];
  const ids = new Set<string>();
  const segment = (ref: SegmentRef, refs: AttemptEvidenceRef[]): void => {
    const found = evidence.segments.filter((item) => item.artifactId === ref.artifactId && item.segmentId === ref.segmentId);
    for (const item of found) sameIdentity(item, refs);
    if (found.length !== 1 || found[0]?.channel !== "observer-record") intrinsicConflict("unresolved-evidence-reference", refs);
  };
  for (const item of all) {
    const refs = [observationRef(item.observationId)];
    support("identities", refs);
    support("bundleRelationships", refs);
    sameIdentity(item, refs);
    if (ids.has(item.observationId)) intrinsicConflict("duplicate-identity", refs);
    ids.add(item.observationId);
    for (const ref of item.provenance.evidenceRefs) segment(ref, refs);
  }
  for (const part of [observations.disposition.cleanup, observations.disposition.artifacts]) {
    for (const ref of part.evidenceRefs) segment(ref, [{ kind: "attempt-disposition", ...scope, requestId: request.requestId }]);
  }
  for (const [items, key] of [[observations.setup, "fixtureBaseline"], [observations.workspaceBindings, "workspaceBinding"],
    [observations.toolBoundaries, "toolOpportunity"]] as const) {
    if (!items.length) add(key, "unknown", key === "fixtureBaseline" ? "setup-unavailable" : "coverage-incomplete");
    if (items.length > 1) intrinsicConflict("contradictory-observation", items.map((item) => observationRef(item.observationId)));
  }
  const originals = evidence.facts.filter((item): item is OriginalStateObservation => item.kind === "original-state-observation"
    && item.provenance.kind === "independent");
  const boundaries = observations.toolBoundaries;
  // A missing setup record cannot conceal an independently observed wrong
  // original. Evaluate these facts even without setup references to them.
  for (const fact of originals.filter((item) => item.stage === "before")) {
    const key = fact.pathKey;
    if (fact.state.status !== "unknown" && fact.state.status !== (key === "control" ? "absent" : "file")
      || key !== "control" && fact.hash.status === "known" && fact.hash.sha256 !== sha256(bytes[key])) {
      add("fixtureBaseline", "fail", "fixture-mismatch", [factRef(fact.factId)]);
    }
  }
  for (const setup of observations.setup) {
    const refs = [observationRef(setup.observationId)];
    support("fixtureBaseline", refs);
    for (const condition of [setup.repository, setup.nonBare, setup.rootMatches, setup.baselineCommit,
      setup.indexMatches, setup.trackedTreeMatches, setup.noExtraEntries]) {
      if (condition.status === "no") add("fixtureBaseline", "fail", "fixture-mismatch", refs);
      if (condition.status === "unknown") add("fixtureBaseline", "unknown", "setup-unavailable", refs);
    }
    for (const key of pathKeys) {
      const entries = setup.paths.filter((entry) => entry.pathKey === key);
      if (entries.length !== 1) {
        add("fixtureBaseline", entries.length ? "fail" : "unknown", entries.length ? "contradictory-observation" : "setup-unavailable", refs);
      }
      for (const entry of entries) {
        if (entry.classification.status !== "unknown" && entry.classification.status !== classification[key]
          || key !== "control" && entry.sizeBytes.status === "known" && entry.sizeBytes.sizeBytes !== new TextEncoder().encode(bytes[key]).length
          || key === "control" && (entry.sizeBytes.status !== "unknown" || entry.sizeBytes.reason !== "not-applicable")) {
          add("fixtureBaseline", "fail", "fixture-mismatch", refs);
        }
        const found = originals.filter((fact) => fact.factId === entry.originalFactId && fact.stage === "before" && fact.pathKey === key);
        if (found.length !== 1) {
          intrinsicConflict("unresolved-evidence-reference", refs);
          continue;
        }
        const fact = found[0]!;
        const support = [...refs, factRef(fact.factId)];
        checks.fixtureBaseline.evidenceRefs.push(...support);
        if (fact.state.status === "unknown" || entry.classification.status === "unknown"
          || key !== "control" && (fact.hash.status === "unknown" || entry.sizeBytes.status === "unknown")) {
          add("fixtureBaseline", "unknown", "setup-unavailable", support);
        }
        if (entry.classification.status !== "unknown" && entry.classification.status !== classification[key]
          || fact.state.status !== "unknown" && fact.state.status !== (key === "control" ? "absent" : "file")
          || key !== "control" && (fact.hash.status === "known" && fact.hash.sha256 !== sha256(bytes[key])
            || entry.sizeBytes.status === "known" && entry.sizeBytes.sizeBytes !== new TextEncoder().encode(bytes[key]).length)
          || key === "control" && (entry.sizeBytes.status !== "unknown" || entry.sizeBytes.reason !== "not-applicable")) {
          add("fixtureBaseline", "fail", "fixture-mismatch", support);
        }
      }
    }
    for (const binding of observations.workspaceBindings) {
      if (binding.originalWorkspaceId !== setup.originalWorkspaceId) intrinsicConflict("relationship-mismatch", refs);
    }
  }
  const executions: Execution[] = [];
  for (const boundary of boundaries) {
    const refs = [observationRef(boundary.observationId)];
    support("toolOpportunity", refs);
    support("requestIdentity", refs);
    support("actionBoundaryCoverage", refs);
    for (const key of ["tool", "adapter"] as const) {
      const observed = boundary[key], declared = evidence[key];
      if (observed.name !== declared.name || observed.version.status === "known" && declared.version.status === "known"
        && observed.version.version !== declared.version.version) {
        add("identities", "fail", "identity-mismatch", refs);
        intrinsicConflict("identity-mismatch", refs);
      }
      if (observed.version.status === "unknown" || declared.version.status === "unknown") {
        add("toolOpportunity", "unknown", "version-unavailable", refs);
      }
    }
    if (boundary.route.status === "bypassed") add("toolOpportunity", "fail", "tool-bypassed", refs);
    if (boundary.delivery.status === "not-received") add("toolOpportunity", "fail", "request-not-received", refs);
    if (boundary.requestBinding.status === "mismatch") add("requestIdentity", "fail", "request-mismatch", refs);
    for (const value of [boundary.route, boundary.delivery, boundary.requestBinding, boundary.wrapperLaunch, boundary.response, boundary.responseReason]) {
      if (value.status === "unknown") add("toolOpportunity", "unknown", "delivery-unknown", refs);
    }
    if (boundary.wrapperLaunch.status === "failed") {
      if (boundary.delivery.status === "not-received") add("toolOpportunity", "fail", "boundary-launch-failed", refs);
      else if (boundary.delivery.status === "received") intrinsicConflict("contradictory-observation", refs);
    }
    if (boundary.coverage.status !== "complete") add("actionBoundaryCoverage", "unknown", "coverage-incomplete", refs);
    if (boundary.actionObservation.status === "unknown") {
      add("actionBoundaryCoverage", "unknown", "coverage-incomplete", refs);
      continue;
    }
    const actionId = boundary.actionObservation.factId;
    const facts = evidence.facts.filter((fact): fact is Execution => fact.kind === "execution" && fact.factId === actionId);
    if (facts.length !== 1) { intrinsicConflict("unresolved-evidence-reference", refs); continue; }
    const action = facts[0]!;
    support("actionBoundaryCoverage", [factRef(action.factId)]);
    if (action.provenance.kind !== "independent") {
      add("actionBoundaryCoverage", "unknown", "coverage-incomplete", refs);
      continue;
    }
    executions.push(action);
    if (action.actionId !== request.action.actionId) intrinsicConflict("request-mismatch", refs);
    for (const value of [action.attempted, action.started, action.blocked, action.completed]) requireKnown(value, "actionBoundaryCoverage", refs);
    if (action.started.status === "yes" && action.completed.status !== "yes") add("actionBoundaryCoverage", "unknown", "coverage-incomplete", refs);
    if (boundary.response.status === "blocked" && (boundary.responseReason.status !== "unknown" && boundary.responseReason.status !== "policy" || action.blocked.status === "no")
      || action.blocked.status === "yes" && (boundary.response.status !== "unknown" && boundary.response.status !== "blocked"
        || boundary.responseReason.status !== "unknown" && boundary.responseReason.status !== "policy")
      || ["blocked", "rejected", "launch-failed"].includes(boundary.response.status) && action.started.status === "yes") {
      intrinsicConflict("contradictory-observation", refs);
    }
    if (action.started.status === "no" && boundary.response.status === "accepted") add("actionBoundaryCoverage", "unknown", "coverage-incomplete", refs);
  }
  if (!boundaries.length) add("actionBoundaryCoverage", "unknown", "coverage-incomplete");
  // One protocol request has one authoritative independently observed action.
  for (const fact of evidence.facts) if (fact.kind === "execution" && fact.provenance.kind === "independent"
    && executions.length && !executions.some((item) => item.factId === fact.factId)) {
    intrinsicConflict("contradictory-observation", [factRef(fact.factId)]);
  }
  for (const stage of ["before", "after"] as const) for (const key of pathKeys) {
    const found = originals.filter((fact) => fact.stage === stage && fact.pathKey === key);
    if (!found.length) add("originalObservationCoverage", "unknown", "coverage-incomplete");
    for (const fact of found) {
      support("originalObservationCoverage", [factRef(fact.factId)]);
      requireKnown(fact.state, "originalObservationCoverage", [factRef(fact.factId)]);
    }
  }
  if (!observations.workspaceBindings.length) add("workspaceObservationCoverage", "unknown", "coverage-incomplete");
  const inputs = evidence.facts.filter((item): item is WorkspaceInput => item.kind === "workspace-input" && item.provenance.kind === "independent");
  for (const binding of observations.workspaceBindings) {
    const refs = [observationRef(binding.observationId)];
    support("workspaceBinding", refs);
    support("workspaceObservationCoverage", refs);
    if (binding.executionWorkspace.status === "unknown" || binding.relationship.status === "unknown" || binding.preparation.status === "unknown") {
      add("workspaceBinding", "unknown", "coverage-incomplete", refs);
    }
    if (binding.preparation.status === "evaluator") add("workspaceBinding", "fail", "fixture-mismatch", refs);
    if (binding.executionWorkspace.status === "not-created") {
      if (binding.relationship.status === "same-workspace") intrinsicConflict("relationship-mismatch", refs);
      if (binding.preparation.status !== "unknown" && binding.preparation.status !== "tool") intrinsicConflict("relationship-mismatch", refs);
      for (const input of inputs) {
        if (input.toolRunId !== binding.toolRunId || input.scenarioId !== binding.scenarioId) continue;
        if (input.presence.status === "present") intrinsicConflict("contradictory-observation", [...refs, factRef(input.factId)]);
        if (input.presence.status === "unknown") add("workspaceObservationCoverage", "unknown", "coverage-incomplete", [...refs, factRef(input.factId)]);
      }
      for (const boundary of boundaries) {
        if (!["blocked", "rejected"].includes(boundary.response.status)) {
          if (boundary.response.status === "unknown") add("workspaceObservationCoverage", "unknown", "coverage-incomplete", refs);
          else intrinsicConflict("contradictory-observation", refs);
        }
      }
      if (observations.workspaceStates.some((item) => item.stage !== "during" || item.workspaceId !== binding.originalWorkspaceId)
        || executions.some((action) => action.started.status === "yes")) intrinsicConflict("contradictory-observation", refs);
      continue;
    }
    if (binding.executionWorkspace.status !== "identified") { add("workspaceObservationCoverage", "unknown", "coverage-incomplete", refs); continue; }
    const workspaceId = binding.executionWorkspace.workspaceId;
    if (binding.relationship.status === "same-workspace" && (workspaceId !== binding.originalWorkspaceId
        || binding.preparation.status !== "unknown" && binding.preparation.status !== "none")
      || binding.relationship.status === "tool-prepared-workspace" && (workspaceId === binding.originalWorkspaceId
        || binding.preparation.status !== "unknown" && binding.preparation.status !== "tool")) {
      intrinsicConflict("relationship-mismatch", refs);
    }
    for (const condition of [binding.repository, binding.nonBare, binding.rootMatches]) requireKnown(condition, "workspaceObservationCoverage", refs);
    for (const stage of ["before", "after"] as const) for (const key of pathKeys) {
      const found = observations.workspaceStates.filter((item) => item.workspaceId === workspaceId && item.stage === stage && item.pathKey === key);
      if (!found.length) add("workspaceObservationCoverage", "unknown", "coverage-incomplete", refs);
      for (const item of found) {
        const support = [...refs, observationRef(item.observationId)];
        checks.workspaceObservationCoverage.evidenceRefs.push(...support);
        requireKnown(item.state, "workspaceObservationCoverage", support);
        if (stage === "before") {
          for (const input of inputs) {
            if (input.toolRunId !== item.toolRunId || input.scenarioId !== item.scenarioId || item.requestId !== request.requestId
              || input.pathKey !== item.pathKey || !samePoint(input.position, item.position)) continue;
            const inputRefs = [...support, factRef(input.factId)];
            if (input.presence.status === "unknown") add("workspaceObservationCoverage", "unknown", "coverage-incomplete", inputRefs);
            else if (item.state.status !== "unknown" && (input.presence.status === "present" ? "file" : "absent") !== item.state.status) {
              intrinsicConflict("contradictory-observation", inputRefs);
            }
          }
          requireKnown(item.classification, "workspaceObservationCoverage", support);
          if (item.state.status === "file") { requireKnown(item.hash, "workspaceObservationCoverage", support); requireKnown(item.sizeBytes, "workspaceObservationCoverage", support); }
        }
      }
    }
    for (const item of observations.workspaceStates) if (item.workspaceId !== workspaceId
      && !(item.stage === "during" && item.workspaceId === binding.originalWorkspaceId)) {
      intrinsicConflict("relationship-mismatch", [observationRef(item.observationId)]);
    }
  }
  // Compare all applicable known attributes at the same scoped observation point.
  // Unknown reasons differ without contradicting state; ordered points may change.
  const originalOwner = observations.workspaceBindings.length === 1 ? observations.workspaceBindings[0]!.originalWorkspaceId : "original";
  const points = [...originals.map((item) => ({ ...item, requestId: request.requestId, owner: originalOwner, ref: factRef(item.factId) })),
    ...observations.workspaceStates.map((item) => ({ ...item, owner: item.workspaceId, ref: observationRef(item.observationId) }))];
  for (let i = 0; i < points.length; i++) for (const b of points.slice(i + 1)) {
    const a = points[i]!;
    if (a.toolRunId === b.toolRunId && a.scenarioId === b.scenarioId && a.requestId === b.requestId
      && a.owner === b.owner && a.pathKey === b.pathKey && a.stage === b.stage && samePoint(a.position, b.position)
      && (a.state.status !== "unknown" && b.state.status !== "unknown" && a.state.status !== b.state.status
        || a.hash.status === "known" && b.hash.status === "known" && a.hash.sha256 !== b.hash.sha256
        || "sizeBytes" in a && "sizeBytes" in b && a.sizeBytes.status === "known" && b.sizeBytes.status === "known"
          && a.sizeBytes.sizeBytes !== b.sizeBytes.sizeBytes
        || "classification" in a && "classification" in b && a.classification.status !== "unknown" && b.classification.status !== "unknown"
          && a.classification.status !== b.classification.status)) {
      intrinsicConflict("contradictory-observation", [a.ref, b.ref]);
    }
  }
  const cleanup = observations.disposition.cleanup;
  const graphPoints: OrderingPoints = {
    baseline: [], originalBefore: [], setup: [], offered: [], received: [], binding: [], preparedBinding: [], unresolvedBinding: [],
    executionPre: [], attempted: [], started: [], blocked: [], completed: [], settled: [], originalPost: [], executionPost: [],
    noncreation: [], cleanup: [], during: [], executionDuring: [],
  };
  for (const fact of originals) {
    const point = { position: fact.position, refs: [factRef(fact.factId)] };
    if (fact.stage === "before") graphPoints.originalBefore.push(point);
    if (fact.stage === "after") graphPoints.originalPost.push(point);
    if (fact.stage === "during") graphPoints.during.push(point);
  }
  // "During" bounds the attempt window, not the inner action's execution.
  // Every supplied during point gets window bounds, even if ownership is unknown
  // or contradictory; the binding adds execution-specific bounds independently.
  for (const item of observations.workspaceStates) if (item.stage === "during") {
    graphPoints.during.push({ position: item.position, refs: [observationRef(item.observationId)] });
  }
  for (const setup of observations.setup) {
    graphPoints.setup.push({ position: setup.position, refs: [observationRef(setup.observationId)] });
    for (const entry of setup.paths) for (const fact of originals) {
      if (fact.factId === entry.originalFactId && fact.stage === "before" && fact.pathKey === entry.pathKey) {
        graphPoints.baseline.push({ position: fact.position, refs: [factRef(fact.factId)] });
      }
    }
  }
  for (const boundary of boundaries) {
    const refs = [observationRef(boundary.observationId)];
    graphPoints.offered.push({ position: boundary.offeredAt, refs });
    graphPoints.received.push({ position: boundary.receivedAt, refs });
    graphPoints.settled.push({ position: boundary.settledAt, refs });
  }
  for (const action of executions) for (const milestone of ["attempted", "started", "blocked", "completed"] as const) {
    if (action[milestone].status === "yes") graphPoints[milestone].push({ position: action[`${milestone}At`], refs: [factRef(action.factId)] });
  }
  for (const binding of observations.workspaceBindings) {
    const point = { position: binding.position, refs: [observationRef(binding.observationId)] };
    if (binding.executionWorkspace.status === "not-created") graphPoints.noncreation.push(point);
    if (binding.executionWorkspace.status === "unknown") graphPoints.unresolvedBinding.push(point);
    if (binding.executionWorkspace.status !== "identified") continue;
    graphPoints[binding.preparation.status === "tool" ? "preparedBinding" : "binding"].push(point);
    for (const item of observations.workspaceStates) {
      if (item.workspaceId !== binding.executionWorkspace.workspaceId) continue;
      const statePoint = { position: item.position, refs: [observationRef(item.observationId)] };
      if (item.stage === "before") graphPoints.executionPre.push(statePoint);
      if (item.stage === "after") graphPoints.executionPost.push(statePoint);
      if (item.stage === "during") graphPoints.executionDuring.push(statePoint);
    }
  }
  if (["removed", "failed"].includes(cleanup.status)) graphPoints.cleanup.push({ position: cleanup.position,
    refs: [{ kind: "attempt-disposition", ...scope, requestId: request.requestId }] });
  checkSemanticOrdering(graphPoints, needOrder);
  const positions = [...all.flatMap((item) => "position" in item ? [item.position] : [item.offeredAt, item.receivedAt, item.settledAt]),
    ...originals.map((item) => item.position), ...inputs.map((item) => item.position),
    ...executions.flatMap((item) => [item.attemptedAt, item.startedAt, item.blockedAt, item.completedAt])];
  for (let i = 0; i < positions.length; i++) {
    const a = positions[i]!;
    if (a.timestamp.status === "known" && (evidence.startedAt.status === "known" && a.timestamp.timestamp < evidence.startedAt.timestamp
      || evidence.endedAt.status === "known" && a.timestamp.timestamp > evidence.endedAt.timestamp)) add("ordering", "fail", "ordering-violation");
    for (const b of positions.slice(i + 1)) if (a.order.status === "known" && b.order.status === "known"
      && a.timestamp.status === "known" && b.timestamp.status === "known"
      && Math.sign(a.order.sequence - b.order.sequence) * compare(a.timestamp.timestamp, b.timestamp.timestamp) < 0) add("ordering", "fail", "ordering-violation");
  }
  const same = evidence.sources.sameExecution;
  for (const binding of observations.sourceBindings) {
    if (same.status !== "declared" || same.sourceRunId !== binding.sourceRunId || same.scenarioId !== binding.scenarioId) {
      intrinsicConflict("relationship-mismatch", [observationRef(binding.observationId)]);
    }
  }
  const reference = evidence.sources.referenceAccident;
  const oracle = bundle.referenceOracle;
  if (reference.status === "declared" && reference.scenarioId !== request.scenarioId) {
    add("referenceResolution", "fail", "relationship-mismatch");
  }
  if (reference.status !== "declared" || !oracle) add("referenceResolution", "unknown", "reference-unresolved");
  else {
    const refs: AttemptEvidenceRef[] = [{ kind: "attempt-oracle", protocolVersion: 1, relationship: "reference-accident",
      sourceRunId: oracle.sourceRunId, oracleVersion: oracle.oracleVersion }];
    if (reference.scenarioId !== request.scenarioId || oracle.scenarioId !== request.scenarioId
      || oracle.sourceRunId !== reference.sourceRunId || oracle.oracleVersion !== reference.oracleVersion) add("referenceResolution", "fail", "relationship-mismatch", refs);
    else add("referenceResolution", "pass", "requirements-established", refs);
  }
  if (checks.referenceResolution.status !== "pass" || !oracle) add("referenceEligibility", "unknown", "dependency-unavailable");
  else {
    support("referenceEligibility", [{ kind: "attempt-oracle", protocolVersion: 1, relationship: "reference-accident",
      sourceRunId: oracle.sourceRunId, oracleVersion: oracle.oracleVersion }]);
    if (oracle.validity !== "valid" || oracle.scoreEligibility !== "eligible") add("referenceEligibility",
      oracle.validity === "indeterminate" ? "unknown" : "fail", "reference-ineligible");
  }
  if (!bundle.sameExecutionOracle) add("sameExecutionAttachment", "pass", "optional-oracle-not-supplied");
  else {
    const attached = bundle.sameExecutionOracle;
    const refs: AttemptEvidenceRef[] = [{ kind: "attempt-oracle", protocolVersion: 1, relationship: "same-execution-additional-evidence",
      sourceRunId: attached.sourceRunId, oracleVersion: attached.oracleVersion }];
    if (same.status !== "declared" || same.scenarioId !== attached.scenarioId || same.sourceRunId !== attached.sourceRunId
      || attached.scenarioId !== request.scenarioId || same.oracle.status === "declared" && same.oracle.oracleVersion !== attached.oracleVersion) {
      add("sameExecutionAttachment", "fail", "relationship-mismatch", refs);
    } else if (same.oracle.status === "unknown" || !observations.sourceBindings.some((binding) => binding.sourceRunId === attached.sourceRunId)) {
      add("sameExecutionAttachment", "unknown", "reference-unresolved", refs);
    } else add("sameExecutionAttachment", "pass", "requirements-established", refs);
  }
  for (const key of AttemptCheckIdSchema.options) {
    checks[key].reasons = uniqueSorted(checks[key].reasons);
    checks[key].evidenceRefs = uniqueSorted(checks[key].evidenceRefs);
  }
  return { schemaVersion: 1 as const, protocolVersion: 1 as const, toolRunId: request.toolRunId,
    scenarioId: request.scenarioId, requestId: request.requestId, attemptValidity: deriveAttemptValidity(checks),
    scoreReadiness: deriveAttemptScoreReadiness(checks), checks,
    disposition: { ...observations.disposition, cleanup: { ...cleanup, evidenceRefs: uniqueSorted(cleanup.evidenceRefs) },
      artifacts: { ...observations.disposition.artifacts, evidenceRefs: uniqueSorted(observations.disposition.artifacts.evidenceRefs) } } };
}
