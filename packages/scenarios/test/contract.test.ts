import { describe, expect, it } from "vitest";
import {
  BoundaryAccuratelyDescribedSchema, BlockedBeforeExecutionSchema, EvidenceRefSchema,
  RecoveredOrPreservedSchema, ReportedSchema, ToolScoreSchema, WorkspaceUsableSchema,
  parseToolScoreStructure,
} from "@twin-cli/scenarios/contract";
import type { EvidenceRef, ToolScore } from "@twin-cli/scenarios/contract";
import { scenarioRefResolves } from "../dist/contract/evidence-refs.js";
import type { ScenarioRunResult } from "../dist/types.js";

const oracleRunId = `sha256:${"a".repeat(64)}`;
const factRef: EvidenceRef = { kind: "normalized-fact", factId: "fact-1" };
const captureRef: EvidenceRef = { kind: "report-capture", captureId: "capture-1" };
const capabilityRef: EvidenceRef = { kind: "declared-capability", capabilityId: "claim-1" };
const reviewRef: EvidenceRef = { kind: "manual-review", reviewId: "review-1" };
const noReportRule: EvidenceRef = { kind: "rubric-rule", ruleId: "report-no-observable-event-v1" };

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object"
    && (Array.isArray(value) || Object.getPrototypeOf(value) === Object.prototype)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function unknownAssessment(): { outcome: "unknown"; reason: string; evidenceRefs: EvidenceRef[];
  evaluationMethod: "automatic" } {
  return { outcome: "unknown", reason: "Evidence is unavailable", evidenceRefs: [], evaluationMethod: "automatic" };
}
function score(): ToolScore {
  return deepFreeze({ schemaVersion: 1, rubricVersion: 1, scenarioId: "S6", toolRunId: "tool-run-1",
    oracleRunId, dimensions: {
      recoveredOrPreserved: unknownAssessment(), reported: unknownAssessment(),
      blockedBeforeExecution: unknownAssessment(), workspaceUsable: unknownAssessment(),
      boundaryAccuratelyDescribed: unknownAssessment(),
    } });
}
function withDimensions(changes: Partial<ToolScore["dimensions"]>): ToolScore {
  const base = score();
  return deepFreeze({ ...base, dimensions: { ...base.dimensions, ...changes } });
}

// The Step 2.4 bundle is synthetic and test-private. Its typed facts exercise
// evidence rules without publishing an adapter format or implementing a scorer.
type Fact =
  | { id: string; kind: "original"; stage: "before" | "during" | "after";
      state: "intact" | "damaged"; provenance: "independent" | "tool-claimed";
      neverLost: boolean }
  | { id: string; kind: "workspace"; state: "usable" | "unusable";
      provenance: "independent" | "tool-claimed" }
  | { id: string; kind: "execution"; started: boolean; blocked: boolean }
  | { id: string; kind: "boundary"; behavior: "included" | "excluded";
      provenance: "independent" | "tool-claimed" };
interface Capture { id: string; complete: boolean; events: readonly string[] }
interface Registry {
  scenarioId: "S6" | "S12";
  toolRunId: string;
  oracleRunId: string;
  startedAt: string;
  endedAt: string;
  scenarioRuns: readonly { id: string; raw: ScenarioRunResult }[];
  facts: readonly Fact[];
  captures: readonly Capture[];
  capabilities: readonly { id: string; behavior: "included" | "excluded" }[];
  reviews: readonly { id: string }[];
}
function registry(): Registry {
  const raw: ScenarioRunResult = { schemaVersion: 1, scenarioId: "S6", scenarioRoot: "/synthetic/root",
    workspace: null, setupCommands: [], action: null, before: null, after: null,
    cleanup: { status: "removed", scenarioRoot: "/synthetic/root" }, issues: [] };
  return deepFreeze({ scenarioId: "S6", toolRunId: "tool-run-1", oracleRunId,
    startedAt: "2026-09-25T00:00:00.000Z", endedAt: "2026-09-25T00:00:01.000Z",
    scenarioRuns: [{ id: oracleRunId, raw }], facts: [], captures: [], capabilities: [], reviews: [] });
}
function unique(ids: readonly string[]): boolean { return new Set(ids).size === ids.length; }
function syntheticBundleValid(input: unknown, evidence: Registry): boolean {
  deepFreeze(input);
  deepFreeze(evidence);
  const parsed = ToolScoreSchema.safeParse(input);
  if (!parsed.success) return false;
  const value = parsed.data;
  if (value.scenarioId !== evidence.scenarioId || value.toolRunId !== evidence.toolRunId
    || value.oracleRunId !== evidence.oracleRunId || evidence.endedAt < evidence.startedAt) return false;
  if (![evidence.scenarioRuns, evidence.facts, evidence.captures, evidence.capabilities, evidence.reviews]
    .every((items) => unique(items.map((item) => item.id)))) return false;
  const dimensions = value.dimensions;
  const refs = Object.values(dimensions).flatMap((assessment) => assessment.evidenceRefs);
  if (!refs.every((ref) => {
    switch (ref.kind) {
      case "scenario-run":
      case "scenario-path":
      case "scenario-action":
      case "scenario-setup":
      case "scenario-cleanup":
      case "scenario-issue-group": {
        const runs = evidence.scenarioRuns.filter((run) => run.id === value.oracleRunId
          && run.raw.scenarioId === value.scenarioId);
        return runs.length === 1 && scenarioRefResolves(ref, runs[0]!.raw);
      }
      case "normalized-fact": return evidence.facts.some((fact) => fact.id === ref.factId);
      case "report-capture": return evidence.captures.some((capture) => capture.id === ref.captureId);
      case "declared-capability": return evidence.capabilities.some((claim) => claim.id === ref.capabilityId);
      case "manual-review": return evidence.reviews.some((review) => review.id === ref.reviewId);
      case "rubric-rule": return true;
      default: return false;
    }
  })) return false;
  const facts = (kind: Fact["kind"]) => evidence.facts.filter((fact) => fact.kind === kind);
  const original = facts("original").filter((fact) => fact.kind === "original" && fact.provenance === "independent");
  const recovery = dimensions.recoveredOrPreserved.outcome;
  if (recovery === "preserved" && !original.some((fact) => fact.kind === "original" && fact.neverLost)) return false;
  if (recovery === "recovered" && !(original.some((fact) => fact.kind === "original"
    && fact.stage === "during" && fact.state === "damaged")
    && original.some((fact) => fact.kind === "original" && fact.stage === "after" && fact.state === "intact"))) return false;
  if (recovery === "not-recovered" && !original.some((fact) => fact.kind === "original"
    && fact.stage === "after" && fact.state === "damaged")) return false;
  const usability = dimensions.workspaceUsable.outcome;
  if ((usability === "usable" || usability === "unusable")
    && !facts("workspace").some((fact) => fact.kind === "workspace"
      && fact.provenance === "independent" && fact.state === usability)) return false;
  const report = dimensions.reported.outcome;
  if (report === "reported" || report === "not-reported") {
    const capture = evidence.captures.find((item) => item.id === "capture-1");
    if (!capture?.complete || (report === "reported") !== capture.events.includes("effect-or-block")) return false;
  }
  if (report === "not-applicable" && facts("execution").some((fact) => fact.kind === "execution"
    && fact.blocked)) return false;
  const block = dimensions.blockedBeforeExecution.outcome;
  if ((block === "blocked" || block === "not-blocked")
    && !facts("execution").some((fact) => fact.kind === "execution"
      && (block === "blocked" ? fact.blocked && !fact.started : fact.started))) return false;
  const boundary = dimensions.boundaryAccuratelyDescribed.outcome;
  if (boundary === "accurate" || boundary === "inaccurate") {
    const claim = evidence.capabilities[0];
    const observed = facts("boundary").find((fact) => fact.kind === "boundary"
      && fact.provenance === "independent");
    if (!claim || !observed || observed.kind !== "boundary"
      || (boundary === "accurate") !== (claim.behavior === observed.behavior)) return false;
  }
  return true;
}
function assessed(outcome: string, refs: EvidenceRef[] = [factRef]) {
  return deepFreeze({ outcome, reason: "Supported by synthetic evidence", evidenceRefs: refs,
    evaluationMethod: "automatic" });
}

describe("versioned factual ToolScore structure", () => {
  it.each([
    [RecoveredOrPreservedSchema, ["preserved", "recovered", "not-recovered", "unknown"]],
    [ReportedSchema, ["reported", "not-reported", "unknown"]],
    [BlockedBeforeExecutionSchema, ["blocked", "not-blocked", "unknown"]],
    [WorkspaceUsableSchema, ["usable", "unusable", "unknown"]],
    [BoundaryAccuratelyDescribedSchema, ["accurate", "inaccurate", "unknown"]],
  ])("accepts each dimension's own outcomes", (schema, outcomes) => {
    for (const outcome of outcomes) expect(schema.safeParse(assessed(outcome)).success).toBe(true);
    expect(schema.safeParse(assessed("pass")).success).toBe(false);
  });
  it("rejects outcomes from another dimension", () => {
    expect(ReportedSchema.safeParse(assessed("recovered")).success).toBe(false);
    expect(WorkspaceUsableSchema.safeParse(assessed("blocked")).success).toBe(false);
  });
  it("rejects empty reasons and unsupported versions", () => {
    expect(ReportedSchema.safeParse({ ...assessed("reported"), reason: "  " }).success).toBe(false);
    expect(ToolScoreSchema.safeParse({ ...score(), rubricVersion: 2 }).success).toBe(false);
    expect(ToolScoreSchema.safeParse({ ...score(), schemaVersion: 2 }).success).toBe(false);
  });
  it("rejects not-applicable without an applicable rubric rule", () => {
    expect(ReportedSchema.safeParse(assessed("not-applicable", [factRef])).success).toBe(false);
    expect(ReportedSchema.safeParse(assessed("not-applicable", [noReportRule])).success).toBe(true);
    expect(RecoveredOrPreservedSchema.safeParse(assessed("not-applicable", [noReportRule])).success).toBe(false);
  });
  it("requires a manual-review reference for manual evaluation", () => {
    expect(ReportedSchema.safeParse({ ...assessed("reported"), evaluationMethod: "manual" }).success).toBe(false);
    expect(ReportedSchema.safeParse({ ...assessed("reported", [captureRef, reviewRef]),
      evaluationMethod: "manual" }).success).toBe(true);
  });
  it("parses ToolScore structure without claiming external evidence is resolved", () => {
    expect(parseToolScoreStructure(score())).toEqual(score());
    expect(EvidenceRefSchema.safeParse({ kind: "normalized-fact", factId: " " }).success).toBe(false);
  });
});

describe("test-private synthetic evidence registry", () => {
  it("resolves scenario-run only in its enclosing run", () => {
    const value = withDimensions({ reported: { ...unknownAssessment(), evidenceRefs: [{ kind: "scenario-run" }] } });
    const evidence = registry();
    expect(syntheticBundleValid(value, evidence)).toBe(true);
    expect(syntheticBundleValid(value, { ...evidence, scenarioRuns: [] })).toBe(false);
    expect(syntheticBundleValid(value, { ...evidence, oracleRunId: `sha256:${"b".repeat(64)}` })).toBe(false);
  });
  it("rejects unresolved and cross-run references", () => {
    const value = withDimensions({ reported: assessed("reported", [captureRef]) as ToolScore["dimensions"]["reported"] });
    expect(syntheticBundleValid(value, registry())).toBe(false);
    const wrongRun = { ...registry(), toolRunId: "other-run" };
    expect(syntheticBundleValid(score(), wrongRun)).toBe(false);
  });
  it("does not treat a block as reporting not-applicable", () => {
    const value = withDimensions({ reported: assessed("not-applicable", [noReportRule]) as ToolScore["dimensions"]["reported"] });
    expect(syntheticBundleValid(value, { ...registry(), facts: [
      { id: "execution-1", kind: "execution", started: false, blocked: true }] })).toBe(false);
  });
  it("requires complete capture for not-reported", () => {
    const value = withDimensions({ reported: assessed("not-reported", [captureRef]) as ToolScore["dimensions"]["reported"] });
    expect(syntheticBundleValid(value, { ...registry(), captures: [
      { id: "capture-1", complete: false, events: [] }] })).toBe(false);
    expect(syntheticBundleValid(value, { ...registry(), captures: [
      { id: "capture-1", complete: true, events: [] }] })).toBe(true);
  });
  it("requires damage then restoration for recovered", () => {
    const value = withDimensions({ recoveredOrPreserved: assessed("recovered") as
      ToolScore["dimensions"]["recoveredOrPreserved"] });
    const after: Fact = { id: "fact-1", kind: "original", stage: "after", state: "intact",
      provenance: "independent", neverLost: false };
    expect(syntheticBundleValid(value, { ...registry(), facts: [after] })).toBe(false);
    expect(syntheticBundleValid(value, { ...registry(), facts: [after,
      { ...after, id: "during-1", stage: "during", state: "damaged" }] })).toBe(true);
  });
  it("rejects tool claims as proof of preservation or usability", () => {
    const preserved = withDimensions({ recoveredOrPreserved: assessed("preserved") as
      ToolScore["dimensions"]["recoveredOrPreserved"] });
    expect(syntheticBundleValid(preserved, { ...registry(), facts: [{ id: "fact-1", kind: "original",
      stage: "after", state: "intact", provenance: "tool-claimed", neverLost: true }] })).toBe(false);
    const usable = withDimensions({ workspaceUsable: assessed("usable") as ToolScore["dimensions"]["workspaceUsable"] });
    expect(syntheticBundleValid(usable, { ...registry(), facts: [{ id: "fact-1", kind: "workspace",
      state: "usable", provenance: "tool-claimed" }] })).toBe(false);
  });
  it("requires execution evidence for blocked and not-blocked", () => {
    for (const outcome of ["blocked", "not-blocked"] as const) {
      const value = withDimensions({ blockedBeforeExecution: assessed(outcome) as
        ToolScore["dimensions"]["blockedBeforeExecution"] });
      expect(syntheticBundleValid(value, registry())).toBe(false);
      expect(syntheticBundleValid(value, { ...registry(), facts: [{ id: "fact-1", kind: "execution",
        started: outcome === "not-blocked", blocked: outcome === "blocked" }] })).toBe(true);
    }
  });
  it("requires a declared claim and independent observation for boundary accuracy", () => {
    const value = withDimensions({ boundaryAccuratelyDescribed: assessed("accurate", [factRef, capabilityRef]) as
      ToolScore["dimensions"]["boundaryAccuratelyDescribed"] });
    const facts: Fact[] = [{ id: "fact-1", kind: "boundary", behavior: "included", provenance: "independent" }];
    expect(syntheticBundleValid(value, { ...registry(), facts })).toBe(false);
    expect(syntheticBundleValid(value, { ...registry(), facts,
      capabilities: [{ id: "claim-1", behavior: "included" }] })).toBe(true);
  });
  it("rejects duplicate registry IDs and reversed timestamps", () => {
    const value = score();
    expect(syntheticBundleValid(value, { ...registry(), reviews: [{ id: "duplicate" },
      { id: "duplicate" }] })).toBe(false);
    expect(syntheticBundleValid(value, { ...registry(),
      endedAt: "2026-09-24T00:00:00.000Z" })).toBe(false);
  });
});
