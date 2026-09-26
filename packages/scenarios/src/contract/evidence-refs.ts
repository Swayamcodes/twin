import { createHash } from "node:crypto";
import { z } from "zod";
import type { ScenarioRunResult } from "../types.js";

export const NonEmptySchema = z.string().trim().min(1);
export const Sha256Schema = z.string().regex(/^[0-9a-f]{64}(?![\s\S])/);
export const RunIdSchema = z.string().regex(/^sha256:[0-9a-f]{64}(?![\s\S])/);
export const ScenarioIdSchema = z.enum(["S12", "S6"]);
export const PathKeySchema = z.enum(["notes", "app", "gitignore", "scratch", "env", "dependency", "control"]);
export const SetupIdSchema = z.enum(["init", "add", "commit", "top-level", "tracked", "untracked", "ignored"]);
export const IssuePhaseSchema = z.enum(["setup", "before", "action", "after", "cleanup"]);
export const RubricRuleIdSchema = z.enum([
  "s12-blocking-observed-not-required-v1",
  "no-action-attempted-v1",
  "report-block-or-effect-v1",
  "report-no-observable-event-v1",
  "required-workspace-inputs-v1",
  "boundary-claim-required-v1",
]);

export const pathByKey = {
  notes: "notes.txt", app: "app.js", gitignore: ".gitignore", scratch: "scratch.txt",
  env: ".env", dependency: "node_modules/lib.txt", control: "control-created.txt",
} as const;
export type PathKey = z.infer<typeof PathKeySchema>;
export type SetupId = z.infer<typeof SetupIdSchema>;
export const pathKeys = PathKeySchema.options;

// Version-1 semantic setup identities, independent of their position in raw evidence.
const setupCommandById: Readonly<Record<SetupId, { executable: "git"; args: readonly string[] }>> = {
  init: { executable: "git", args: ["init", "--initial-branch=main", "--template="] },
  add: { executable: "git", args: ["add", "--", "notes.txt", "app.js", ".gitignore"] },
  commit: { executable: "git", args: ["-c", "user.name=Twin Scenario", "-c", "user.email=twin-scenario@example.invalid",
    "-c", "commit.gpgSign=false", "-c", "core.hooksPath=/dev/null",
    "commit", "-m", "Establish disposable scenario baseline"] },
  "top-level": { executable: "git", args: ["rev-parse", "--show-toplevel"] },
  tracked: { executable: "git", args: ["ls-files", "-z"] },
  untracked: { executable: "git", args: ["ls-files", "--others", "--exclude-standard", "-z"] },
  ignored: { executable: "git", args: ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"] },
};
export function matchesSetupIdentity(command: ScenarioRunResult["setupCommands"][number]["command"], id: SetupId): boolean {
  const expected = setupCommandById[id];
  return command.executable === expected.executable && command.args.length === expected.args.length
    && command.args.every((arg, index) => arg === expected.args[index]);
}

export const EvidenceRefSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("scenario-run") }),
  z.strictObject({ kind: z.literal("scenario-path"), stage: z.enum(["before", "after"]), pathKey: PathKeySchema }),
  z.strictObject({ kind: z.literal("scenario-action") }),
  z.strictObject({ kind: z.literal("scenario-setup"), commandId: SetupIdSchema }),
  z.strictObject({ kind: z.literal("scenario-cleanup") }),
  z.strictObject({ kind: z.literal("scenario-issue-group"), phase: IssuePhaseSchema,
    messageSha256: Sha256Schema, occurrenceCount: z.number().int().positive() }),
  z.strictObject({ kind: z.literal("normalized-fact"), factId: NonEmptySchema }),
  z.strictObject({ kind: z.literal("report-capture"), captureId: NonEmptySchema }),
  z.strictObject({ kind: z.literal("declared-capability"), capabilityId: NonEmptySchema }),
  z.strictObject({ kind: z.literal("manual-review"), reviewId: NonEmptySchema }),
  z.strictObject({ kind: z.literal("private-artifact-segment"), artifactId: NonEmptySchema, segmentId: NonEmptySchema }),
  z.strictObject({ kind: z.literal("rubric-rule"), ruleId: RubricRuleIdSchema }),
]);
export type EvidenceRef = z.infer<typeof EvidenceRefSchema>;
export type RubricRuleId = z.infer<typeof RubricRuleIdSchema>;

export function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Resolve only references backed by the unchanged direct-run evidence.
 * scenario-run refers to the complete enclosing raw run, not independent attestation. */
export function scenarioRefResolves(ref: EvidenceRef, raw: ScenarioRunResult): boolean {
  switch (ref.kind) {
    case "scenario-run": return true;
    case "scenario-path": {
      const snapshot = raw[ref.stage];
      return snapshot !== null && snapshot.paths.some((item) => item.path === pathByKey[ref.pathKey]);
    }
    case "scenario-action": return raw.action !== null;
    case "scenario-setup": return raw.setupCommands.filter((item) =>
      matchesSetupIdentity(item.command, ref.commandId)).length === 1;
    case "scenario-cleanup": return true;
    case "scenario-issue-group": {
      const count = raw.issues.filter((issue) => issue.phase === ref.phase
        && sha256(issue.message) === ref.messageSha256).length;
      return count === ref.occurrenceCount;
    }
    case "rubric-rule": return true;
    default: return false;
  }
}
