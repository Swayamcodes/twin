import { z } from "zod";
import { EvidenceRefSchema, NonEmptySchema, RunIdSchema, ScenarioIdSchema } from "./evidence-refs.js";

export const OracleCheckSchema = z.strictObject({
  status: z.enum(["pass", "fail", "unknown"]),
  reason: NonEmptySchema,
  evidenceRefs: z.array(EvidenceRefSchema),
}).superRefine((check, ctx) => {
  if (check.status !== "unknown" && check.evidenceRefs.length === 0) {
    ctx.addIssue({ code: "custom", message: "Conclusive oracle checks require evidence" });
  }
});
export type OracleCheck = z.infer<typeof OracleCheckSchema>;

/** Expected S12 identity is interpretation input, not executable attestation. */
export const S12OracleEvaluationContextSchema = z.strictObject({
  schemaVersion: z.literal(1),
  scenarioId: z.literal("S12"),
  s12Action: z.strictObject({
    executable: z.string().refine((value) => value.trim().length > 0),
    scriptPath: z.string().refine((value) => value.trim().length > 0),
  }),
});
export const S6OracleEvaluationContextSchema = z.strictObject({
  schemaVersion: z.literal(1),
  scenarioId: z.literal("S6"),
});
export const OracleEvaluationContextSchema = z.discriminatedUnion("scenarioId", [
  S12OracleEvaluationContextSchema, S6OracleEvaluationContextSchema,
]);
export type S12OracleEvaluationContext = z.infer<typeof S12OracleEvaluationContextSchema>;
export type S6OracleEvaluationContext = z.infer<typeof S6OracleEvaluationContextSchema>;
export type OracleEvaluationContext = z.infer<typeof OracleEvaluationContextSchema>;

export function deriveOracleValidity(checks: readonly OracleCheck[]): "valid" | "invalid" | "indeterminate" {
  if (checks.some((check) => check.status === "fail")) return "invalid";
  if (checks.some((check) => check.status === "unknown")) return "indeterminate";
  return "valid";
}

export const OracleResultSchema = z.strictObject({
  schemaVersion: z.literal(1),
  oracleVersion: z.literal(1),
  scenarioId: ScenarioIdSchema,
  sourceRunId: RunIdSchema,
  checks: z.strictObject({
    preconditions: OracleCheckSchema,
    intendedAction: OracleCheckSchema,
    filesystemEffect: OracleCheckSchema,
    observation: OracleCheckSchema,
  }),
  validity: z.enum(["valid", "invalid", "indeterminate"]),
  scoreEligibility: z.enum(["eligible", "ineligible"]),
  cleanup: z.strictObject({
    status: z.enum(["removed", "refused", "failed"]),
    rootDisposition: z.enum(["removed", "retained", "unknown"]),
    reason: NonEmptySchema,
    evidenceRefs: z.array(EvidenceRefSchema).min(1),
  }),
}).superRefine((result, ctx) => {
  const expected = deriveOracleValidity(Object.values(result.checks));
  if (result.validity !== expected) ctx.addIssue({ code: "custom", path: ["validity"], message: "Contradicts oracle checks" });
  if (result.scoreEligibility !== (expected === "valid" ? "eligible" : "ineligible")) {
    ctx.addIssue({ code: "custom", path: ["scoreEligibility"], message: "Contradicts oracle validity" });
  }
  if (result.cleanup.status === "removed" && result.cleanup.rootDisposition === "retained") {
    ctx.addIssue({ code: "custom", path: ["cleanup", "rootDisposition"], message: "Removed cleanup cannot prove retention" });
  }
  if (result.cleanup.status !== "removed" && result.cleanup.rootDisposition === "removed") {
    ctx.addIssue({ code: "custom", path: ["cleanup", "rootDisposition"], message: "Unsuccessful cleanup cannot claim removal" });
  }
});
export type OracleResult = z.infer<typeof OracleResultSchema>;
