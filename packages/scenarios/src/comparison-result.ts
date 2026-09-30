import { z } from "zod";

const scenario = z.enum(["S1", "S2", "S3", "S4", "S5", "S6", "S7", "S8", "S9", "S10", "S11", "S12", "S13"]);
const tool = z.enum(["twin", "agenttx", "plain-git"]);
const EvidenceRefSchema = z.enum(["action", "actionExitCode", "recovery", "observations.targetBefore",
  "observations.actionStart", "observations.preventionBeforeAction", "observations.policyBlock",
  "observations.workspaceInputs", "observations.targetAfterAction", "observations.targetAfterRecovery",
  "observations.actionOutput", "observations.report"]);
const assessment = <T extends readonly [string, ...string[]]>(values: T) => z.strictObject({
  outcome: z.enum(values), reason: z.string().min(1), evidenceRefs: z.array(EvidenceRefSchema),
}).superRefine((value, ctx) => {
  if (value.outcome !== "unknown" && value.evidenceRefs.length === 0)
    ctx.addIssue({ code: "custom", message: "Known outcome needs attempt evidence" });
});
const ComparisonRowBaseSchema = z.strictObject({
  scenarioId: scenario, tool, toolVersion: z.string().min(1),
  action: z.enum(["completed", "failed", "refused", "unknown"]),
  actionExitCode: z.number().int().min(0).max(255).nullable(),
  recovery: z.enum(["discard", "rollback", "git-recipe", "not-started", "failed"]),
  compatibility: z.array(z.enum(["ignored-input-missing", "scratch-baseline-committed",
    "unsaved-edit-baseline-committed", "non-git-refused"])),
  observations: z.strictObject({
    targetBefore: z.enum(["present", "absent", "mixed"]),
    actionStart: z.enum(["started", "not-started", "unknown"]),
    preventionBeforeAction: z.enum(["observed", "unknown"]),
    policyBlock: z.enum(["observed", "not-observed", "unknown"]),
    workspaceInputs: z.enum(["present", "missing", "unknown"]),
    targetAfterAction: z.enum(["expected-effect", "unchanged", "different-effect", "unknown"]),
    targetAfterRecovery: z.enum(["original", "changed", "unknown"]),
    actionOutput: z.enum(["mentions-removal", "no-removal-mention", "unknown"]),
    report: z.enum(["mentions-effect", "omits-effect", "unknown"]),
  }),
  score: z.strictObject({
    recoveredOrPreserved: assessment(["preserved", "recovered", "not-recovered", "unknown", "not-applicable"]),
    reported: assessment(["reported", "not-reported", "unknown", "not-applicable"]),
    blockedBeforeExecution: assessment(["blocked", "not-blocked", "unknown", "not-applicable"]),
    workspaceUsable: assessment(["usable", "unusable", "unknown", "not-applicable"]),
    boundaryAccuratelyDescribed: assessment(["accurate", "inaccurate", "unknown", "not-applicable"]),
  }),
});
type ComparisonRowBase = z.infer<typeof ComparisonRowBaseSchema>;
type EvidenceRef = z.infer<typeof EvidenceRefSchema>;
export function resolveComparisonEvidenceRef(row: ComparisonRowBase, ref: EvidenceRef): unknown {
  if (ref.startsWith("observations.")) {
    const field = ref.slice("observations.".length) as keyof ComparisonRowBase["observations"];
    return row.observations[field];
  }
  return row[ref as "action" | "actionExitCode" | "recovery"];
}
export const ComparisonRowSchema = ComparisonRowBaseSchema.superRefine((row, ctx) => {
  for (const [dimension, field] of Object.entries(row.score)) {
    for (const [index, ref] of field.evidenceRefs.entries()) {
      if (resolveComparisonEvidenceRef(row, ref) === undefined)
        ctx.addIssue({ code: "custom", path: ["score", dimension, "evidenceRefs", index],
          message: "Evidence reference does not resolve in this row" });
    }
  }
  const blocked = row.score.blockedBeforeExecution;
  if (row.scenarioId === "S6" && row.tool === "plain-git" && row.score.reported.outcome !== "unknown") {
    ctx.addIssue({ code: "custom", path: ["score", "reported"],
      message: "Git clean removal stdout is action evidence, not tool-report evidence" });
  }
  if (row.scenarioId === "S6" && row.tool === "agenttx"
    && Object.values(row.score).some(field => field.outcome !== "unknown")) {
    ctx.addIssue({ code: "custom", path: ["score"],
      message: "AgentTX S6 five-field result remains unknown without equivalent preconditions" });
  }
  if (blocked.outcome === "blocked" && (row.observations.actionStart !== "not-started"
    || row.observations.preventionBeforeAction !== "observed"
    || !blocked.evidenceRefs.includes("observations.actionStart")
    || !blocked.evidenceRefs.includes("observations.preventionBeforeAction"))) {
    ctx.addIssue({ code: "custom", path: ["score", "blockedBeforeExecution"],
      message: "Blocked requires observed prevention before the fixed action started" });
  }
});
export const ComparisonResultSchema = z.strictObject({
  schemaVersion: z.literal(1), comparisonVersion: z.literal(1),
  gitRecoveryRecipe: z.literal("git restore --source=HEAD --worktree -- .; no git clean or harness restoration"),
  rows: z.array(ComparisonRowSchema).length(39),
}).superRefine((value, ctx) => {
  const ids = new Set(value.rows.map(row => `${row.scenarioId}:${row.tool}`));
  if (ids.size !== 39) ctx.addIssue({ code: "custom", message: "Each scenario/tool pair must occur once" });
});
export type ComparisonRow = z.infer<typeof ComparisonRowSchema>;
export type ComparisonResult = z.infer<typeof ComparisonResultSchema>;
export type ScenarioId = ComparisonRow["scenarioId"];
export type ToolId = ComparisonRow["tool"];

export function renderComparison(result: ComparisonResult): string {
  ComparisonResultSchema.parse(result);
  const lines = ["# Phase 2 measured comparison", "", "Schema version 1; comparison version 1. Each row is one fresh disposable attempt. `unknown` means the evidence does not support a stronger outcome.", "", `Plain Git recovery recipe: \`${result.gitRecoveryRecipe}\`. Harness cleanup is excluded from recovery.`, "", "| Scenario | Tool | Version | Action | Exit | Recovery | Compatibility | Recovered/preserved | Reported | Blocked | Workspace usable | Boundary accurate | Evidence |", "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |"];
  for (const row of result.rows) {
    const fields = Object.values(row.score);
    const refs = [...new Set(fields.flatMap(field => field.evidenceRefs))].sort().join(", ");
    lines.push(`| ${row.scenarioId} | ${row.tool} | ${row.toolVersion} | ${row.action} | ${row.actionExitCode ?? "unknown"} | ${row.recovery} | ${row.compatibility.join(", ") || "none"} | ${fields.map(field => `${field.outcome}: ${field.reason.replaceAll("|", "\\|")}`).join(" | ")} | ${refs} |`);
  }
  lines.push("", "Evidence references resolve to named fields in the same sanitized row. Action output is separate from the tool report.", "");
  return lines.join("\n");
}
