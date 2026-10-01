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
const RootAccountingSchema = z.strictObject({
  allocated: z.number().int().nonnegative(), removed: z.number().int().nonnegative(),
  retained: z.number().int().nonnegative(),
}).superRefine((value, ctx) => {
  if (value.allocated !== value.removed + value.retained)
    ctx.addIssue({ code: "custom", message: "Root accounting does not balance" });
});
const DigestSchema = z.string().regex(/^[0-9a-f]{64}$/);
const VersionSchema = z.string().min(1).max(100).regex(/^[A-Za-z0-9 .+_-]+$/);
const BuildDigestSchema = z.strictObject({ sha256: DigestSchema, fileCount: z.number().int().positive() });
export const ComparisonExecutionMetadataSchema = z.strictObject({
  metadataVersion: z.literal(1),
  source: z.strictObject({ commit: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/),
    workingTree: z.enum(["clean", "dirty"]), statusSha256: DigestSchema }),
  versions: z.strictObject({ node: VersionSchema, git: VersionSchema, agenttx: VersionSchema }),
  executables: z.strictObject({ nodeSha256: DigestSchema, gitSha256: DigestSchema,
    agenttxEntrySha256: DigestSchema, npmEntrySha256: DigestSchema }),
  builds: z.strictObject({ core: BuildDigestSchema, scenarios: BuildDigestSchema, agenttx: BuildDigestSchema }),
  actions: z.array(z.strictObject({ scenarioId: z.enum(["S1", "S2", "S3", "S4", "S5", "S6", "S7", "S8", "S9", "S10", "S11", "S12", "S13"]),
    kind: z.enum(["script", "command"]), sha256: DigestSchema })).length(13),
  s11WorkerSha256: DigestSchema,
}).superRefine((value, ctx) => {
  value.actions.forEach((action, index) => {
    const expected = `S${index + 1}`;
    if (action.scenarioId !== expected || action.kind !== (["S4", "S6", "S10"].includes(expected) ? "command" : "script"))
      ctx.addIssue({ code: "custom", path: ["actions", index], message: "Action identity is out of fixed order" });
  });
});
export type ComparisonExecutionMetadata = z.infer<typeof ComparisonExecutionMetadataSchema>;
export const ComparisonResultSchema = z.strictObject({
  schemaVersion: z.literal(1), comparisonVersion: z.literal(1),
  gitRecoveryRecipe: z.literal("git restore --source=HEAD --worktree -- .; no git clean or harness restoration"),
  rootAccounting: RootAccountingSchema.optional(),
  executionMetadata: ComparisonExecutionMetadataSchema.optional(),
  rows: z.array(ComparisonRowSchema).length(39),
}).superRefine((value, ctx) => {
  const ids = new Set(value.rows.map(row => `${row.scenarioId}:${row.tool}`));
  if (ids.size !== 39) ctx.addIssue({ code: "custom", message: "Each scenario/tool pair must occur once" });
  if (value.rootAccounting && (value.rootAccounting.allocated !== 40 || value.rootAccounting.removed !== 40))
    ctx.addIssue({ code: "custom", message: "Complete suite must settle all 40 roots" });
});
export type ComparisonRow = z.infer<typeof ComparisonRowSchema>;
export type ComparisonResult = z.infer<typeof ComparisonResultSchema>;
export type ScenarioId = ComparisonRow["scenarioId"];
export type ToolId = ComparisonRow["tool"];
export const comparisonSequence = (["S1", "S2", "S3", "S4", "S5", "S6", "S7", "S8", "S9", "S10", "S11", "S12", "S13"] as const)
  .flatMap(scenarioId => (["twin", "agenttx", "plain-git"] as const).map(tool => ({ scenarioId, tool })));

export const IncompleteComparisonSchema = z.strictObject({
  schemaVersion: z.literal(1), comparisonVersion: z.literal(1), status: z.literal("incomplete"),
  reason: z.enum(["prerequisite-failed", "attempt-failed"]),
  failureStage: z.enum(["prerequisite", "allocation", "setup", "launch", "observation", "recovery", "settlement", "cleanup"]),
  prerequisiteCode: z.enum(["agenttx-unavailable", "agenttx-version-mismatch", "probe-settlement-uncertain", "other"]).nullable(),
  rootDisposition: z.enum(["not-allocated", "removed", "retained", "unknown"]),
  rootAccounting: RootAccountingSchema,
  executionMetadata: ComparisonExecutionMetadataSchema.optional(),
  completedRows: z.array(ComparisonRowSchema).max(38),
  failedAttempt: z.strictObject({ scenarioId: scenario, tool }).nullable(),
}).superRefine((value, ctx) => {
  if (value.reason === "prerequisite-failed" && (value.completedRows.length !== 0 || value.failedAttempt !== null))
    ctx.addIssue({ code: "custom", message: "Prerequisite failure precedes all attempts" });
  if (value.reason === "attempt-failed" && value.failedAttempt === null)
    ctx.addIssue({ code: "custom", message: "Attempt failure needs an identity" });
  if (value.reason === "prerequisite-failed" && value.failureStage !== "prerequisite")
    ctx.addIssue({ code: "custom", message: "Prerequisite failure precedes attempt launch" });
  if (value.reason === "attempt-failed" && value.prerequisiteCode !== null)
    ctx.addIssue({ code: "custom", message: "Attempt failure has no prerequisite code" });
  value.completedRows.forEach((row, index) => {
    const expected = comparisonSequence[index];
    if (row.scenarioId !== expected?.scenarioId || row.tool !== expected.tool)
      ctx.addIssue({ code: "custom", path: ["completedRows", index], message: "Completed rows must be the ordered suite prefix" });
  });
  const next = comparisonSequence[value.completedRows.length];
  if (value.reason === "attempt-failed" && (value.failedAttempt?.scenarioId !== next?.scenarioId
    || value.failedAttempt?.tool !== next?.tool))
    ctx.addIssue({ code: "custom", path: ["failedAttempt"], message: "Failed attempt must be the next suite pair" });
  const settledRoots = value.reason === "attempt-failed" ? value.completedRows.length + 1 : 0;
  const { allocated, removed, retained } = value.rootAccounting;
  const disposition = value.rootDisposition;
  const consistent = disposition === "not-allocated"
    ? allocated === settledRoots && removed === settledRoots && retained === 0
    : disposition === "removed"
      ? allocated === settledRoots + 1 && removed === settledRoots + 1 && retained === 0
      : allocated === settledRoots + 1 && removed === settledRoots && retained === 1;
  if (!consistent)
    ctx.addIssue({ code: "custom", path: ["rootDisposition"], message: "Root disposition disagrees with allocation/removal accounting" });
});
export type IncompleteComparison = z.infer<typeof IncompleteComparisonSchema>;
export const ComparisonArtifactSchema = z.union([ComparisonResultSchema, IncompleteComparisonSchema]);
export type ComparisonArtifact = z.infer<typeof ComparisonArtifactSchema>;

export function renderComparisonArtifact(result: ComparisonArtifact): string {
  if (!("status" in result)) return renderComparison(result);
  const parsed = IncompleteComparisonSchema.parse(result);
  const where = parsed.failedAttempt ? `${parsed.failedAttempt.scenarioId} / ${parsed.failedAttempt.tool}` : "prerequisites";
  const identity = parsed.executionMetadata
    ? `\nSource commit: \`${parsed.executionMetadata.source.commit}\`; working tree: ${parsed.executionMetadata.source.workingTree}; metadata version ${parsed.executionMetadata.metadataVersion}.\n`
    : "";
  return `# Incomplete fixed-action comparison\n\nSchema version 1; comparison version 1. ${parsed.completedRows.length} of 39 attempts completed. Failure at ${where}: ${parsed.reason} (${parsed.prerequisiteCode ?? parsed.failureStage}); root ${parsed.rootDisposition}. Roots: ${parsed.rootAccounting.allocated} allocated, ${parsed.rootAccounting.removed} removed, ${parsed.rootAccounting.retained} retained. No complete-suite claim is made.\n${identity}\nCompleted rows are retained in the JSON artifact with row-local evidence. A failed attempt has no scored row.\n`;
}

export function renderComparison(result: ComparisonResult): string {
  ComparisonResultSchema.parse(result);
  const lines = [result.executionMetadata ? "# Fresh fixed-action comparison" : "# Phase 2 measured comparison", "", "Schema version 1; comparison version 1. Each row is one fresh disposable attempt. `unknown` means the evidence does not support a stronger outcome.", "", `Plain Git recovery recipe: \`${result.gitRecoveryRecipe}\`. Harness cleanup is excluded from recovery.`, "", "| Scenario | Tool | Version | Action | Exit | Recovery | Compatibility | Recovered/preserved | Reported | Blocked | Workspace usable | Boundary accurate | Evidence |", "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |"];
  for (const row of result.rows) {
    const fields = Object.values(row.score);
    const refs = [...new Set(fields.flatMap(field => field.evidenceRefs))].sort().join(", ");
    lines.push(`| ${row.scenarioId} | ${row.tool} | ${row.toolVersion} | ${row.action} | ${row.actionExitCode ?? "unknown"} | ${row.recovery} | ${row.compatibility.join(", ") || "none"} | ${fields.map(field => `${field.outcome}: ${field.reason.replaceAll("|", "\\|")}`).join(" | ")} | ${refs} |`);
  }
  lines.push("", "Evidence references resolve to named fields in the same sanitized row. Action output is separate from the tool report.", "");
  if (result.rootAccounting) lines.push(`Roots: ${result.rootAccounting.allocated} allocated, ${result.rootAccounting.removed} removed, ${result.rootAccounting.retained} retained.`, "");
  if (result.executionMetadata) {
    const meta = result.executionMetadata;
    lines.push("## Execution identity", "", `Metadata version ${meta.metadataVersion}. Source commit: \`${meta.source.commit}\`; working tree: ${meta.source.workingTree}; status digest: \`${meta.source.statusSha256}\`.`, "", "| Component | Version | SHA-256 |", "| --- | --- | --- |", `| Node executable | ${meta.versions.node} | ${meta.executables.nodeSha256} |`, `| Git executable | ${meta.versions.git} | ${meta.executables.gitSha256} |`, `| AgentTX entry | ${meta.versions.agenttx} | ${meta.executables.agenttxEntrySha256} |`, `| npm entry | — | ${meta.executables.npmEntrySha256} |`, `| Twin core build (${meta.builds.core.fileCount} files) | — | ${meta.builds.core.sha256} |`, `| Scenarios build (${meta.builds.scenarios.fileCount} files) | — | ${meta.builds.scenarios.sha256} |`, `| AgentTX build (${meta.builds.agenttx.fileCount} files) | — | ${meta.builds.agenttx.sha256} |`, "", "Fixed actions (SHA-256 of script bytes or command recipe with fixed inputs):", "", ...meta.actions.map(action => `- ${action.scenarioId} ${action.kind}: \`${action.sha256}\``), `- S11 worker: \`${meta.s11WorkerSha256}\``, "", "These local identities support reproduction; they are not authenticated provenance or a guarantee of identical outcomes.", "");
  }
  return lines.join("\n");
}
