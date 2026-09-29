import { isAbsolute, normalize } from "node:path";
import { digest, encode, publishPrivateFour, reopenPrivateFour, validatePrivateParent, PrivatePublicationError, type FileName } from "./private-four-file.js";
import { z } from "zod";
import { ArtifactIdSchema, SegmentIdSchema, VersionStringSchema,
  type Execution, type OriginalStateObservation } from "../contract/normalized-evidence-schema.js";
import { RunIdSchema } from "../contract/evidence-refs.js";
import { AttemptRequestSchema, ToolAttemptBundleSchema, AttemptDispositionSchema, RequestIdSchema } from "../contract/attempt-protocol-schema.js";
import { validateNormalizedToolEvidence } from "../contract/normalized-evidence-validation.js";
import { validateToolAttemptBundle } from "../contract/attempt-protocol-validation.js";
import { StreamBytesSchema } from "./records.js";

const prior = ["identity.json", "attempt.json", "outcome.json"] as const;
const limits: Readonly<Record<FileName, number>> = { "identity.json": 16_384, "attempt.json": 2_097_152,
  "outcome.json": 32_768, "manifest.json": 4_096 };
const text = z.string().max(4096).refine(v => Buffer.byteLength(v) <= 4096);
const header = { formatVersion: z.literal(1), artifactKind: z.literal("twin-s12-attempt"), artifactId: ArtifactIdSchema };
const request = AttemptRequestSchema.refine(v => v.scenarioId === "S12" && v.action.actionId === "create-control-file");
const IdentitySchema = z.strictObject({ ...header, request, referenceArtifactId: ArtifactIdSchema, oracleRunId: RunIdSchema,
  executionWorkspacePath: text, fixedActionPath: text });
const OutputSchema = z.strictObject({ bytes: StreamBytesSchema, complete: z.boolean(), truncated: z.boolean(), error: text.nullable() });
const ActualResultSchema = z.strictObject({ schemaVersion: z.literal(1), outcome: z.enum(["exited", "spawn-failed", "timed-out"]),
  started: z.boolean(), directChildSettled: z.boolean(), exitCode: z.number().int().nullable(), signal: text.nullable(),
  spawnError: text.nullable(), stdout: OutputSchema, stderr: OutputSchema, terminationError: text.nullable() });
const BindingSchema = z.strictObject({ executable: text, argv: z.tuple([text]), actionPath: text,
  cwd: text, executionWorkspacePath: text, shell: z.literal(false),
  stdio: z.tuple([z.literal("ignore"), z.literal("pipe"), z.literal("pipe")]),
  env: z.strictObject({ LANG: z.literal("C"), LC_ALL: z.literal("C"), TZ: z.literal("UTC") }),
  timeoutMs: z.literal(5000), actionSha256: z.string().regex(/^[0-9a-f]{64}$/), observerSegmentId: SegmentIdSchema });
const AttemptSchema = z.strictObject({ ...header, bundle: ToolAttemptBundleSchema, binding: BindingSchema, run: ActualResultSchema,
  toolVersion: VersionStringSchema, adapterVersion: VersionStringSchema });
const OutcomeSchema = z.strictObject({ ...header, twinDiscard: z.enum(["removed", "refused", "failed"]),
  originalCleanup: z.enum(["removed", "refused", "failed", "unknown"]),
  artifactBeforePublication: z.literal("unknown"), artifactReason: z.literal("not-observed"),
  disposition: AttemptDispositionSchema });
const manifestEntry = <N extends string>(name: N) => z.strictObject({ name: z.literal(name), sizeBytes: z.number().int().positive(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/) });
const ManifestSchema = z.strictObject({ ...header, completeness: z.literal("complete"),
  inventory: z.tuple([manifestEntry("identity.json"), manifestEntry("attempt.json"), manifestEntry("outcome.json")]) });
// The tuple above is fixed in storage order. A second explicit check protects its names.
export const TwinS12AttemptRecordsSchema = z.strictObject({ identity: IdentitySchema, attempt: AttemptSchema, outcome: OutcomeSchema });
export type TwinS12AttemptRecords = z.infer<typeof TwinS12AttemptRecordsSchema>;
export const validateTwinS12ArtifactParent = validatePrivateParent;
function coherent(records: TwinS12AttemptRecords): boolean {
  const { identity, attempt, outcome } = records, { bundle } = attempt, id = identity.artifactId;
  const refs = [...bundle.normalizedEvidence.facts, ...bundle.protocolObservations.setup, ...bundle.protocolObservations.workspaceBindings,
    ...bundle.protocolObservations.toolBoundaries, ...bundle.protocolObservations.workspaceStates, ...bundle.protocolObservations.sourceBindings];
  const execution = bundle.normalizedEvidence.facts.filter((item): item is Execution => item.kind === "execution" && item.provenance.kind === "independent");
  const original = bundle.normalizedEvidence.facts.filter((item): item is OriginalStateObservation => item.kind === "original-state-observation" && item.provenance.kind === "independent");
  const states = bundle.protocolObservations.workspaceStates;
  const controlBefore = states.find(item => item.stage === "before" && item.pathKey === "control");
  const controlAfter = states.find(item => item.stage === "after" && item.pathKey === "control");
  const expectedControl = digest(Buffer.from("S12 control file.\n"));
  const expectedInput: Readonly<Record<string, string>> = {
    notes: digest(Buffer.from("Scenario fixture notes.\n")), app: digest(Buffer.from('console.log("fixture");\n')),
    gitignore: digest(Buffer.from(".env\nnode_modules/\n")), scratch: digest(Buffer.from("Untracked scratch data.\n")),
    env: digest(Buffer.from("TWIN_SCENARIO_SECRET=fake-only\n")), dependency: digest(Buffer.from("Ignored dependency fixture.\n")),
  };
  const originalCoherent = ["notes", "app", "gitignore", "scratch", "env", "dependency", "control"].every(key => {
    const earlier = original.find(item => item.stage === "before" && item.pathKey === key);
    const later = original.find(item => item.stage === "after" && item.pathKey === key);
    if (!earlier || !later || earlier.state.status !== later.state.status) return false;
    return key === "control" ? earlier.state.status === "absent" : earlier.state.status === "file"
      && earlier.hash.status === "known" && later.hash.status === "known"
      && earlier.hash.sha256 === expectedInput[key] && later.hash.sha256 === expectedInput[key];
  });
  const workspaceCoherent = ["notes", "app", "gitignore", "scratch", "env", "dependency", "control"].every(key => {
    const earlier = states.find(item => item.stage === "before" && item.pathKey === key);
    const later = states.find(item => item.stage === "after" && item.pathKey === key);
    if (!earlier || !later) return false;
    return key === "control" ? earlier.state.status === "absent" && later.state.status === "file"
      && later.hash.status === "known" && later.hash.sha256 === expectedControl
      : earlier.state.status === "file" && later.state.status === "file" && earlier.hash.status === "known"
        && later.hash.status === "known" && earlier.hash.sha256 === expectedInput[key] && later.hash.sha256 === expectedInput[key];
  });
  const expectedAction = digest(Buffer.from('import { writeFile } from "node:fs/promises";\n'
    + 'await writeFile("control-created.txt", "S12 control file.\\n", { flag: "wx" });\n'));
  return attempt.artifactId === id && outcome.artifactId === id && identity.referenceArtifactId !== id
    && JSON.stringify(bundle.request) === JSON.stringify(identity.request)
    && outcome.twinDiscard === "removed" && outcome.originalCleanup === "removed"
    && bundle.request.scenarioId === "S12" && bundle.referenceOracle?.sourceRunId === identity.oracleRunId
    && bundle.normalizedEvidence.tool.name === "twin" && bundle.normalizedEvidence.adapter.name === "twin-s12"
    && bundle.normalizedEvidence.tool.version.status === "known" && bundle.normalizedEvidence.tool.version.version === attempt.toolVersion
    && bundle.normalizedEvidence.adapter.version.status === "known" && bundle.normalizedEvidence.adapter.version.version === attempt.adapterVersion
    && bundle.normalizedEvidence.segments.every(item => item.artifactId === id)
    && refs.every(item => item.provenance.evidenceRefs.every(ref => ref.artifactId === id))
    && outcome.disposition.toolRunId === identity.request.toolRunId && outcome.disposition.requestId === identity.request.requestId
    && outcome.disposition.artifacts.status === "unknown" && outcome.disposition.artifacts.reason === "not-observed"
    && outcome.disposition.artifacts.evidenceRefs.every(ref => ref.artifactId === id)
    && outcome.disposition.cleanup.status === (outcome.twinDiscard === "removed" ? "removed" : outcome.twinDiscard === "failed" ? "failed" : "retained")
    && outcome.disposition.cleanup.evidenceRefs.every(ref => ref.artifactId === id)
    && JSON.stringify(bundle.protocolObservations.disposition) === JSON.stringify(outcome.disposition)
    && execution.length === 1 && execution[0]!.actionId === "create-control-file" && execution[0]!.started.status === "yes"
    && execution[0]!.completed.status === "yes" && execution[0]!.exitCode.status === "known" && execution[0]!.exitCode.exitCode === attempt.run.exitCode
    && original.length === 14 && new Set(original.map(item => `${item.stage}:${item.pathKey}`)).size === 14 && originalCoherent && workspaceCoherent
    && controlBefore?.state.status === "absent" && controlAfter?.state.status === "file"
    && controlAfter.hash.status === "known" && controlAfter.hash.sha256 === expectedControl
    && attempt.binding.actionSha256 === expectedAction
    && attempt.binding.argv[0] === attempt.binding.actionPath
    && attempt.binding.cwd === attempt.binding.executionWorkspacePath
    && attempt.binding.actionPath === identity.fixedActionPath
    && attempt.binding.executionWorkspacePath === identity.executionWorkspacePath
    && isAbsolute(attempt.binding.actionPath) && normalize(attempt.binding.actionPath) === attempt.binding.actionPath
    && isAbsolute(attempt.binding.executionWorkspacePath)
    && normalize(attempt.binding.executionWorkspacePath) === attempt.binding.executionWorkspacePath
    && attempt.run.started && attempt.run.directChildSettled && attempt.run.outcome === "exited" && attempt.run.exitCode === 0
    && attempt.run.signal === null && attempt.run.spawnError === null && attempt.run.terminationError === null
    && [attempt.run.stdout, attempt.run.stderr].every(stream => stream.complete && !stream.truncated && stream.error === null && stream.bytes.decodedBytes === 0)
    && attempt.binding.executable === process.execPath && attempt.binding.env.LANG === "C" && attempt.binding.argv.length === 1;
}
const reopened = new WeakMap<object, { artifactId: string; records: TwinS12AttemptRecords;
  protocol: Extract<ReturnType<typeof validateToolAttemptBundle>, { success: true }>["result"] }>();
const reopenedBrand: unique symbol = Symbol("reopenedTwinS12Attempt");
export interface ReopenedTwinS12Attempt { readonly [reopenedBrand]: true }
export type TwinS12Inspection = { status: "complete"; handle: ReopenedTwinS12Attempt } | { status: "incomplete"; reason: "retention-incomplete" };
/** Only this module can create a usable handle. Copies and deserialized values have no WeakMap entry. */
function handleFor(value: NonNullable<ReturnType<typeof reopened.get>>): ReopenedTwinS12Attempt {
  const handle = Object.freeze(Object.create(null)) as ReopenedTwinS12Attempt;
  reopened.set(handle, value);
  return handle;
}
/** Path-free, stream-free projection for scoring. It never returns private storage records. */
export function projectReopenedTwinS12Attempt(handle: ReopenedTwinS12Attempt): {
  artifactId: string; bundle: TwinS12AttemptRecords["attempt"]["bundle"];
  protocol: Extract<ReturnType<typeof validateToolAttemptBundle>, { success: true }>["result"];
  run: { started: boolean; directChildSettled: boolean; completed: boolean; exitCode: number | null };
} | null {
  const value = reopened.get(handle);
  if (!value) return null;
  const run = value.records.attempt.run;
  const bundle = ToolAttemptBundleSchema.parse(value.records.attempt.bundle);
  const fresh = validateToolAttemptBundle(bundle);
  if (!fresh.success) return null;
  return { artifactId: value.artifactId,
    bundle, protocol: fresh.result,
    run: { started: run.started, directChildSettled: run.directChildSettled,
      completed: run.outcome === "exited" && run.directChildSettled, exitCode: run.exitCode } };
}
/** Private result contains only an opaque, property-free handle. */
export async function inspectTwinS12Attempt(directory: string): Promise<TwinS12Inspection> {
  try {
    const value = await reopenPrivateFour(directory, limits, values => {
      const manifest = ManifestSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(values[3])) as unknown);
      if (manifest.inventory.map(v => v.name).join(",") !== prior.join(",")) throw new Error("inventory");
      const records = TwinS12AttemptRecordsSchema.parse({
        identity: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(values[0])) as unknown,
        attempt: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(values[1])) as unknown,
        outcome: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(values[2])) as unknown,
      });
      if (manifest.artifactId !== records.identity.artifactId || !coherent(records)) throw new Error("coherence");
      const normalized = validateNormalizedToolEvidence(records.attempt.bundle.normalizedEvidence);
      const protocol = validateToolAttemptBundle(records.attempt.bundle);
      if (!normalized.success || !protocol.success) throw new Error("validation");
      return { artifactId: records.identity.artifactId, records, protocol: protocol.result };
    });
    return { status: "complete", handle: handleFor(value) };
  } catch { return { status: "incomplete", reason: "retention-incomplete" }; }
}
export async function retainTwinS12Attempt(parentDirectory: string, input: TwinS12AttemptRecords): Promise<{ directory?: string; inspection: TwinS12Inspection }> {
  let directory: string | undefined;
  try {
    const records = TwinS12AttemptRecordsSchema.parse(input);
    if (!coherent(records)) throw new Error("coherence");
    const bodies = [encode("identity.json", records.identity, limits), encode("attempt.json", records.attempt, limits),
      encode("outcome.json", records.outcome, limits)] as const;
    const manifest = ManifestSchema.parse({ formatVersion: 1, artifactKind: "twin-s12-attempt", artifactId: records.identity.artifactId,
      completeness: "complete", inventory: prior.map((name, index) => ({ name, sizeBytes: bodies[index]!.length, sha256: digest(bodies[index]!) })) });
    const manifestBytes = encode("manifest.json", manifest, limits);
    directory = await publishPrivateFour(parentDirectory, "twin-s12-", limits, [...bodies, manifestBytes]);
    return { directory, inspection: await inspectTwinS12Attempt(directory) };
  } catch (error) {
    if (!directory && error instanceof PrivatePublicationError) directory = error.directory;
    return { ...(directory ? { directory } : {}), inspection: { status: "incomplete", reason: "retention-incomplete" } };
  }
}
