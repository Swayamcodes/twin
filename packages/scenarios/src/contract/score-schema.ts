import { z } from "zod";
import { EvidenceRefSchema, NonEmptySchema, RubricRuleIdSchema, RunIdSchema, ScenarioIdSchema } from "./evidence-refs.js";

export const EvaluationMethodSchema = z.enum(["automatic", "manual", "declared"]);

const applicableRules = {
  recoveredOrPreserved: [] as readonly z.infer<typeof RubricRuleIdSchema>[],
  reported: ["report-no-observable-event-v1"],
  blockedBeforeExecution: ["no-action-attempted-v1"],
  workspaceUsable: [] as readonly z.infer<typeof RubricRuleIdSchema>[],
  boundaryAccuratelyDescribed: [] as readonly z.infer<typeof RubricRuleIdSchema>[],
} as const;

function assessment<const T extends readonly [string, ...string[]]>(
  dimension: keyof typeof applicableRules, outcomes: T,
) {
  return z.strictObject({
    outcome: z.enum(outcomes),
    reason: NonEmptySchema,
    evidenceRefs: z.array(EvidenceRefSchema),
    evaluationMethod: EvaluationMethodSchema,
  }).superRefine((value, ctx) => {
    if (value.outcome !== "unknown" && value.evidenceRefs.length === 0) {
      ctx.addIssue({ code: "custom", path: ["evidenceRefs"], message: "Known outcome requires evidence" });
    }
    if (value.evaluationMethod === "manual"
      && !value.evidenceRefs.some((ref) => ref.kind === "manual-review")) {
      ctx.addIssue({ code: "custom", path: ["evidenceRefs"], message: "Manual evaluation requires review evidence" });
    }
    if (value.outcome === "not-applicable"
      && !value.evidenceRefs.some((ref) => ref.kind === "rubric-rule"
        && (applicableRules[dimension] as readonly string[]).includes(ref.ruleId))) {
      ctx.addIssue({ code: "custom", path: ["evidenceRefs"], message: "Not-applicable requires an applicable rubric rule" });
    }
  });
}

export const RecoveredOrPreservedSchema = assessment("recoveredOrPreserved",
  ["preserved", "recovered", "not-recovered", "unknown", "not-applicable"]);
export const ReportedSchema = assessment("reported", ["reported", "not-reported", "unknown", "not-applicable"]);
export const BlockedBeforeExecutionSchema = assessment("blockedBeforeExecution",
  ["blocked", "not-blocked", "unknown", "not-applicable"]);
export const WorkspaceUsableSchema = assessment("workspaceUsable", ["usable", "unusable", "unknown", "not-applicable"]);
export const BoundaryAccuratelyDescribedSchema = assessment("boundaryAccuratelyDescribed",
  ["accurate", "inaccurate", "unknown", "not-applicable"]);

export type RecoveredOrPreserved = z.infer<typeof RecoveredOrPreservedSchema>;
export type Reported = z.infer<typeof ReportedSchema>;
export type BlockedBeforeExecution = z.infer<typeof BlockedBeforeExecutionSchema>;
export type WorkspaceUsable = z.infer<typeof WorkspaceUsableSchema>;
export type BoundaryAccuratelyDescribed = z.infer<typeof BoundaryAccuratelyDescribedSchema>;

export const ToolScoreSchema = z.strictObject({
  schemaVersion: z.literal(1), rubricVersion: z.literal(1),
  scenarioId: ScenarioIdSchema, toolRunId: NonEmptySchema, oracleRunId: RunIdSchema,
  dimensions: z.strictObject({
    recoveredOrPreserved: RecoveredOrPreservedSchema,
    reported: ReportedSchema,
    blockedBeforeExecution: BlockedBeforeExecutionSchema,
    workspaceUsable: WorkspaceUsableSchema,
    boundaryAccuratelyDescribed: BoundaryAccuratelyDescribedSchema,
  }),
});
export type ToolScore = z.infer<typeof ToolScoreSchema>;

/** Structural parsing only. It cannot prove external facts or resolve adapter evidence. */
export function parseToolScoreStructure(input: unknown): ToolScore {
  return ToolScoreSchema.parse(input);
}
