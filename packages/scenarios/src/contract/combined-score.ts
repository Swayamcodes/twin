import { z } from "zod";
import { S12ScoreCompleteSchema, S12ScoreResultSchema, s12ReasonText, type S12ScoreResult } from "./s12-score-support.js";
import { S6ScoreResultSchema, s6ReasonText, type S6ScoreResult } from "./s6-score-support.js";
import { ToolScoreSchema } from "./score-schema.js";

const projection = <S extends "S12" | "S6">(scenarioId: S) => z.strictObject({ scenarioId: z.literal(scenarioId),
  reference: S12ScoreCompleteSchema.shape.reference, attempt: S12ScoreCompleteSchema.shape.attempt,
  tool: S12ScoreCompleteSchema.shape.tool, adapter: S12ScoreCompleteSchema.shape.adapter, score: ToolScoreSchema });
export const CombinedScoreCompleteSchema = z.strictObject({ schemaVersion: z.literal(1), resultVersion: z.literal(1),
  status: z.literal("complete"), results: z.tuple([projection("S12"), projection("S6")]) });
export const CombinedScoreIncompleteSchema = z.strictObject({ schemaVersion: z.literal(1), resultVersion: z.literal(1),
  status: z.literal("incomplete"), reason: z.enum(["invalid-input", "incomplete-input", "identity-conflict"]) });
export const CombinedScoreResultSchema = z.discriminatedUnion("status", [CombinedScoreCompleteSchema, CombinedScoreIncompleteSchema]);
export type CombinedScoreResult = z.infer<typeof CombinedScoreResultSchema>;
export type CombinedScoreReason = z.infer<typeof CombinedScoreIncompleteSchema>["reason"];

export function incompleteCombinedScore(reason: CombinedScoreReason): CombinedScoreResult {
  return { schemaVersion: 1, resultVersion: 1, status: "incomplete", reason };
}

function agrees(result: Extract<S12ScoreResult | S6ScoreResult, { status: "complete" }>): boolean {
  const { scoreSupport: support, reference: ref, attempt: att, scenarioId } = result;
  const dimensions = ["recoveredOrPreserved", "reported", "blockedBeforeExecution", "workspaceUsable", "boundaryAccuratelyDescribed"] as const;
  for (const name of dimensions) {
    const record = support.dimensions[name], score = support.score.dimensions[name];
    const reason = scenarioId === "S12" ? s12ReasonText(record.reasonCode as Parameters<typeof s12ReasonText>[0])
      : s6ReasonText(record.reasonCode as Parameters<typeof s6ReasonText>[0]);
    const refs = record.refs.flatMap(item => item.kind === "attempt-normalized-evidence" && item.ref.kind === "normalized-fact"
      ? [{ kind: "normalized-fact", factId: item.ref.factId }] : []);
    if (score.outcome !== record.outcome || score.reason !== reason || score.evaluationMethod !== "automatic"
      || JSON.stringify(score.evidenceRefs) !== JSON.stringify(refs)) return false;
  }
  return support.scenarioId === scenarioId && support.score.scenarioId === scenarioId
    && support.referenceArtifactId === ref.artifactId && support.attemptArtifactId === att.artifactId
    && support.oracleRunId === ref.oracleRunId && support.toolRunId === att.toolRunId
    && support.requestId === att.requestId && support.score.oracleRunId === ref.oracleRunId
    && support.score.toolRunId === att.toolRunId && ref.artifactId !== att.artifactId;
}

/** Pure structural combination of two already produced public result objects. */
export function combineScores(first: unknown, second: unknown): CombinedScoreResult {
  const inputs = [first, second];
  const ids = inputs.map(value => value && typeof value === "object" && "scenarioId" in value ? value.scenarioId : undefined);
  if (!(ids.includes("S12") && ids.includes("S6"))) return incompleteCombinedScore("invalid-input");
  const s12 = S12ScoreResultSchema.safeParse(inputs[ids.indexOf("S12")]);
  const s6 = S6ScoreResultSchema.safeParse(inputs[ids.indexOf("S6")]);
  if (!s12.success || !s6.success) return incompleteCombinedScore("invalid-input");
  if (JSON.stringify(s12.data) !== JSON.stringify(inputs[ids.indexOf("S12")])
    || JSON.stringify(s6.data) !== JSON.stringify(inputs[ids.indexOf("S6")]))
    return incompleteCombinedScore("invalid-input");
  if (s12.data.status !== "complete" || s6.data.status !== "complete") return incompleteCombinedScore("incomplete-input");
  if (!agrees(s12.data) || !agrees(s6.data)) return incompleteCombinedScore("invalid-input");
  const a = s12.data, b = s6.data;
  if (a.reference.oracleRunId === b.reference.oracleRunId || a.attempt.toolRunId === b.attempt.toolRunId
    || a.attempt.requestId === b.attempt.requestId
    || new Set([a.reference.artifactId, a.attempt.artifactId, b.reference.artifactId, b.attempt.artifactId]).size !== 4)
    return incompleteCombinedScore("identity-conflict");
  return CombinedScoreCompleteSchema.parse({ schemaVersion: 1, resultVersion: 1, status: "complete", results: [
    { scenarioId: a.scenarioId, reference: a.reference, attempt: a.attempt, tool: a.tool, adapter: a.adapter, score: a.scoreSupport.score },
    { scenarioId: b.scenarioId, reference: b.reference, attempt: b.attempt, tool: b.tool, adapter: b.adapter, score: b.scoreSupport.score },
  ] });
}
