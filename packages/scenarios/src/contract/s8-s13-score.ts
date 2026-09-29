import { z } from "zod";

export const MeasuredScenarioSchema = z.enum(["S8", "S13", "S9"]);
const reason = z.enum(["preflight", "fixture", "copy", "action", "settlement", "observation", "root-authority", "retention", "cleanup"]);
const disposition = z.enum(["not-allocated", "removed", "retained", "unknown"]);
const roots = z.strictObject({ original: disposition, support: disposition, twin: disposition, artifact: disposition,
  home: disposition.optional() });
const reference = z.enum(["original-before", "copy-before", "action", "copy-after", "original-after",
  "receipt", "original-after-discard", "home-before", "home-after", "home-after-discard", "documentation-review"]);
const assessment = <T extends readonly [string, ...string[]]>(values: T) => z.strictObject({
  outcome: z.enum(values), reason: z.string().min(1).max(160), evidenceRefs: z.array(reference).max(8),
}).superRefine((value, ctx) => {
  if (value.outcome !== "unknown" && value.evidenceRefs.length === 0)
    ctx.addIssue({ code: "custom", message: "Known outcome needs evidence" });
});
export const S8S13ScoreSchema = z.strictObject({
  recoveredOrPreserved: assessment(["preserved", "recovered", "not-recovered", "unknown"]),
  reported: assessment(["reported", "not-reported", "unknown"]),
  blockedBeforeExecution: assessment(["blocked", "not-blocked", "unknown"]),
  workspaceUsable: assessment(["usable", "unusable", "unknown"]),
  boundaryAccuratelyDescribed: assessment(["accurate", "inaccurate", "unknown"]),
});
export const S8S13CompleteSchema = z.strictObject({
  schemaVersion: z.literal(1), resultVersion: z.literal(1), status: z.literal("complete"),
  scenarioId: MeasuredScenarioSchema, tool: z.literal("Twin"),
  actionSha256: z.string().regex(/^[a-f0-9]{64}$/), artifactId: z.string().uuid(), attemptId: z.string().uuid(),
  toolVersion: z.string().regex(/^fp-[a-f0-9]{64}$/), adapterVersion: z.string().regex(/^fp-[a-f0-9]{64}$/),
  roots, process: z.strictObject({ directChild: z.literal("exited"), descendants: z.literal("not-established") }),
  score: S8S13ScoreSchema,
}).superRefine((value, ctx) => {
  if ((value.scenarioId === "S9") !== (value.roots.home !== undefined))
    ctx.addIssue({ code: "custom", message: "Fake-home disposition mismatch" });
});
export const S8S13IncompleteSchema = z.strictObject({
  schemaVersion: z.literal(1), resultVersion: z.literal(1), status: z.literal("incomplete"),
  scenarioId: MeasuredScenarioSchema, stage: reason, roots, identities: z.strictObject({}), attemptId: z.string().uuid().nullable(),
  process: z.strictObject({ directChild: z.enum(["not-launched", "settled", "unsettled", "unknown"]),
    descendants: z.literal("not-established") }),
}).superRefine((value, ctx) => {
  if ((value.scenarioId === "S9") !== (value.roots.home !== undefined))
    ctx.addIssue({ code: "custom", message: "Fake-home disposition mismatch" });
});
export const S8S13ResultSchema = z.discriminatedUnion("status", [S8S13CompleteSchema, S8S13IncompleteSchema]);
export type S8S13Result = z.infer<typeof S8S13ResultSchema>;
export type S8S13Incomplete = z.infer<typeof S8S13IncompleteSchema>;
