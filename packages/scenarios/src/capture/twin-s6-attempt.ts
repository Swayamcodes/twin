import { isAbsolute, normalize } from "node:path";
import { constants, lstatSync, openSync, fstatSync, readFileSync, closeSync } from "node:fs";
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
const header = { formatVersion: z.literal(1), artifactKind: z.literal("twin-s6-attempt"), artifactId: ArtifactIdSchema };
const request = AttemptRequestSchema.refine(v => v.scenarioId === "S6" && v.action.actionId === "git-clean");
const IdentitySchema = z.strictObject({ ...header, request, referenceArtifactId: ArtifactIdSchema, oracleRunId: RunIdSchema,
  executionWorkspacePath: text, executionWorkspace: z.strictObject({ dev: z.number().int(), ino: z.number().int(), uid: z.number().int() }) });
const OutputSchema = z.strictObject({ bytes: StreamBytesSchema, complete: z.boolean(), truncated: z.boolean(), error: text.nullable() });
const ActualResultSchema = z.strictObject({ schemaVersion: z.literal(1), outcome: z.enum(["exited", "spawn-failed", "timed-out"]),
  started: z.boolean(), directChildSettled: z.boolean(), exitCode: z.number().int().nullable(), signal: text.nullable(),
  spawnError: text.nullable(), stdout: OutputSchema, stderr: OutputSchema, terminationError: text.nullable() });
const gitEnv = z.strictObject({ PATH: text, LANG: z.literal("C"), LC_ALL: z.literal("C"), TZ: z.literal("UTC"),
  GIT_CONFIG_NOSYSTEM: z.literal("1"), GIT_CONFIG_SYSTEM: z.literal("/dev/null"), GIT_CONFIG_GLOBAL: z.literal("/dev/null"),
  GIT_ATTR_NOSYSTEM: z.literal("1"), GIT_TERMINAL_PROMPT: z.literal("0"), GIT_CONFIG_COUNT: z.literal("4"),
  GIT_CONFIG_KEY_0: z.literal("core.hooksPath"), GIT_CONFIG_VALUE_0: z.literal("/dev/null"),
  GIT_CONFIG_KEY_1: z.literal("core.excludesFile"), GIT_CONFIG_VALUE_1: z.literal("/dev/null"),
  GIT_CONFIG_KEY_2: z.literal("core.attributesFile"), GIT_CONFIG_VALUE_2: z.literal("/dev/null"),
  GIT_CONFIG_KEY_3: z.literal("commit.gpgSign"), GIT_CONFIG_VALUE_3: z.literal("false") });
const GitIdentitySchema = z.strictObject({ dev: z.number().int(), ino: z.number().int(), uid: z.number().int(),
  size: z.number().int().nonnegative(), mode: z.number().int(), sha256: z.string().regex(/^[0-9a-f]{64}$/) });
const BindingSchema = z.strictObject({ executable: text, argv: z.tuple([z.literal("clean"), z.literal("-fdx")]),
  cwd: text, executionWorkspacePath: text, shell: z.literal(false),
  stdio: z.tuple([z.literal("ignore"), z.literal("pipe"), z.literal("pipe")]),
  env: gitEnv, timeoutMs: z.literal(5000), gitIdentity: GitIdentitySchema, observerSegmentId: SegmentIdSchema });
const InventoryEntrySchema = z.strictObject({ path: text, kind: z.enum(["directory", "file"]), mode: z.number().int(),
  dev: z.number().int(), ino: z.number().int(), sizeBytes: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/).nullable() });
const InventorySchema = z.array(InventoryEntrySchema).max(256);
const AttemptSchema = z.strictObject({ ...header, bundle: ToolAttemptBundleSchema, binding: BindingSchema, run: ActualResultSchema,
  toolVersion: VersionStringSchema, adapterVersion: VersionStringSchema,
  inventories: z.strictObject({ originalBefore: InventorySchema, originalAfter: InventorySchema,
    originalAfterDiscard: InventorySchema, twinBefore: InventorySchema, twinAfter: InventorySchema }) });
const OutcomeSchema = z.strictObject({ ...header, twinDiscard: z.enum(["removed", "refused", "failed"]),
  originalCleanup: z.enum(["removed", "refused", "failed", "unknown"]),
  artifactBeforePublication: z.literal("unknown"), artifactReason: z.literal("not-observed"),
  disposition: AttemptDispositionSchema });
const manifestEntry = <N extends string>(name: N) => z.strictObject({ name: z.literal(name), sizeBytes: z.number().int().positive(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/) });
const ManifestSchema = z.strictObject({ ...header, completeness: z.literal("complete"),
  inventory: z.tuple([manifestEntry("identity.json"), manifestEntry("attempt.json"), manifestEntry("outcome.json")]) });
// The tuple above is fixed in storage order. A second explicit check protects its names.
export const TwinS6AttemptRecordsSchema = z.strictObject({ identity: IdentitySchema, attempt: AttemptSchema, outcome: OutcomeSchema });
export type TwinS6AttemptRecords = z.infer<typeof TwinS6AttemptRecordsSchema>;
export const validateTwinS6ArtifactParent = validatePrivateParent;
const keys = ["notes", "app", "gitignore", "scratch", "env", "dependency", "control"] as const;
const pinned: Readonly<Record<Exclude<typeof keys[number], "control">, string>> = {
  notes: "Scenario fixture notes.\n", app: 'console.log("fixture");\n', gitignore: ".env\nnode_modules/\n",
  scratch: "Untracked scratch data.\n", env: "TWIN_SCENARIO_SECRET=fake-only\n", dependency: "Ignored dependency fixture.\n",
};
const removed = new Set([".env", "scratch.txt", "node_modules", "node_modules/lib.txt"]);
type Inventory = z.infer<typeof InventorySchema>;
function inventoryWellFormed(items: Inventory): boolean {
  return items.length > 0 && items.length <= 256 && items[0]?.path === ""
    && items.every((item, index) => item.path === "" || item.path !== "." && !item.path.startsWith("/")
      && item.path.split("/").every(part => part !== "" && part !== "." && part !== "..")
      && (index === 0 || items[index - 1]!.path < item.path))
    && items.every(item => item.kind === "file" ? item.sha256 !== null : item.sha256 === null && item.sizeBytes === 0)
    && items.some(item => item.path === ".git" && item.kind === "directory");
}
function content(items: Inventory, includeMode = true): readonly unknown[] {
  return items.map(item => ({ path: item.path, kind: item.kind, ...(includeMode ? { mode: item.mode } : {}),
    sizeBytes: item.sizeBytes, sha256: item.sha256 }));
}
function same(a: unknown, b: unknown): boolean { return JSON.stringify(a) === JSON.stringify(b); }
function outputExact(run: z.infer<typeof ActualResultSchema>): boolean {
  if (!run.stdout.complete || run.stdout.truncated || run.stdout.error !== null || !run.stderr.complete
    || run.stderr.truncated || run.stderr.error !== null || run.stderr.bytes.decodedBytes !== 0) return false;
  try {
    const bytes = Buffer.from(run.stdout.bytes.data, "base64");
    const decoded = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    if (!decoded.endsWith("\n") || decoded.includes("\r") || decoded.includes("\uFEFF")) return false;
    const lines = decoded.slice(0, -1).split("\n");
    return lines.length === 3 && same([...lines].sort(), ["Removing .env", "Removing node_modules/", "Removing scratch.txt"].sort());
  } catch { return false; }
}
function gitMatches(path: string, recorded: z.infer<typeof GitIdentitySchema>): boolean {
  try {
    const named = lstatSync(path);
    if (!named.isFile() || named.isSymbolicLink() || named.nlink !== 1 || named.uid !== 0 || (named.mode & 0o022) !== 0) return false;
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const opened = fstatSync(fd), bytes = readFileSync(fd), after = fstatSync(fd);
      return opened.isFile() && opened.dev === named.dev && opened.ino === named.ino
        && after.dev === opened.dev && after.ino === opened.ino && after.size === opened.size
        && after.mtimeMs === opened.mtimeMs && after.ctimeMs === opened.ctimeMs
        && recorded.dev === opened.dev && recorded.ino === opened.ino && recorded.uid === opened.uid
        && recorded.size === bytes.length && recorded.mode === (opened.mode & 0o7777)
        && recorded.sha256 === digest(bytes);
    } finally { closeSync(fd); }
  } catch { return false; }
}
function coherent(records: TwinS6AttemptRecords): boolean {
  const { identity, attempt, outcome } = records, { bundle, inventories } = attempt, id = identity.artifactId;
  const refs = [...bundle.normalizedEvidence.facts, ...bundle.protocolObservations.setup, ...bundle.protocolObservations.workspaceBindings,
    ...bundle.protocolObservations.toolBoundaries, ...bundle.protocolObservations.workspaceStates, ...bundle.protocolObservations.sourceBindings];
  const execution = bundle.normalizedEvidence.facts.filter((item): item is Execution => item.kind === "execution" && item.provenance.kind === "independent");
  const original = bundle.normalizedEvidence.facts.filter((item): item is OriginalStateObservation => item.kind === "original-state-observation" && item.provenance.kind === "independent");
  const states = bundle.protocolObservations.workspaceStates;
  const observation = (stage: "before" | "after", key: typeof keys[number]) => states.find(item => item.stage === stage && item.pathKey === key);
  const expectedState = (stage: "before" | "after", key: typeof keys[number]) => {
    const item = observation(stage, key);
    if (!item) return false;
    if (key === "control" || stage === "after" && ["scratch", "env", "dependency"].includes(key))
      return item.state.status === "absent" && item.classification.status === "absent";
    const bytes = pinned[key as keyof typeof pinned];
    return item.state.status === "file" && item.hash.status === "known" && item.hash.sha256 === digest(Buffer.from(bytes))
      && item.sizeBytes.status === "known" && item.sizeBytes.sizeBytes === Buffer.byteLength(bytes);
  };
  const originalCoherent = keys.every(key => {
    const earlier = original.find(item => item.stage === "before" && item.pathKey === key);
    const later = original.find(item => item.stage === "after" && item.pathKey === key);
    if (!earlier || !later) return false;
    if (key === "control") return earlier.state.status === "absent" && later.state.status === "absent";
    const hash = digest(Buffer.from(pinned[key]));
    return earlier.state.status === "file" && later.state.status === "file"
      && earlier.hash.status === "known" && later.hash.status === "known"
      && earlier.hash.sha256 === hash && later.hash.sha256 === hash;
  });
  const inv = Object.values(inventories);
  const fixtureEntries = ["", ".env", ".gitignore", "app.js", "node_modules", "node_modules/lib.txt", "notes.txt", "scratch.txt"];
  const intact = inv.every(inventoryWellFormed)
    && same(inventories.originalBefore.filter(item => item.path !== ".git" && !item.path.startsWith(".git/"))
      .map(item => item.path), fixtureEntries)
    && same(content(inventories.originalBefore), content(inventories.originalAfter))
    && same(content(inventories.originalBefore), content(inventories.originalAfterDiscard))
    && same(content(inventories.originalBefore, false), content(inventories.twinBefore, false))
    && same(content(inventories.twinAfter), content(inventories.twinBefore.filter(item => !removed.has(item.path))))
    && inventories.twinBefore.filter(item => item.kind === "file").every(item => {
      const source = inventories.originalBefore.find(other => other.path === item.path);
      return !!source && (source.dev !== item.dev || source.ino !== item.ino);
    });
  const git = attempt.binding.gitIdentity;
  const binding = attempt.binding;
  return attempt.artifactId === id && outcome.artifactId === id && identity.referenceArtifactId !== id
    && identity.request.scenarioId === "S6" && identity.request.action.actionId === "git-clean"
    && same(bundle.request, identity.request) && bundle.referenceOracle?.scenarioId === "S6"
    && bundle.referenceOracle.sourceRunId === identity.oracleRunId && bundle.sameExecutionOracle === undefined
    && outcome.twinDiscard === "removed" && outcome.originalCleanup === "removed"
    && bundle.normalizedEvidence.tool.name === "twin" && bundle.normalizedEvidence.adapter.name === "twin-s6"
    && bundle.normalizedEvidence.tool.version.status === "known" && bundle.normalizedEvidence.tool.version.version === attempt.toolVersion
    && bundle.normalizedEvidence.adapter.version.status === "known" && bundle.normalizedEvidence.adapter.version.version === attempt.adapterVersion
    && bundle.normalizedEvidence.segments.every(item => item.artifactId === id)
    && refs.every(item => item.provenance.evidenceRefs.every(ref => ref.artifactId === id))
    && outcome.disposition.toolRunId === identity.request.toolRunId && outcome.disposition.requestId === identity.request.requestId
    && outcome.disposition.artifacts.status === "unknown" && outcome.disposition.artifacts.reason === "not-observed"
    && outcome.disposition.artifacts.evidenceRefs.every(ref => ref.artifactId === id)
    && outcome.disposition.cleanup.status === "removed"
    && outcome.disposition.cleanup.evidenceRefs.every(ref => ref.artifactId === id)
    && same(bundle.protocolObservations.disposition, outcome.disposition)
    && execution.length === 1 && execution[0]!.actionId === "git-clean" && execution[0]!.attempted.status === "yes"
    && execution[0]!.started.status === "yes" && execution[0]!.blocked.status === "no" && execution[0]!.completed.status === "yes"
    && execution[0]!.exitCode.status === "known" && execution[0]!.exitCode.exitCode === 0
    && original.length === 14 && new Set(original.map(item => `${item.stage}:${item.pathKey}`)).size === 14 && originalCoherent
    && states.length === 14 && keys.every(key => expectedState("before", key) && expectedState("after", key))
    && binding.cwd === binding.executionWorkspacePath && binding.cwd === identity.executionWorkspacePath
    && inventories.twinBefore[0]?.dev === identity.executionWorkspace.dev
    && inventories.twinBefore[0]?.ino === identity.executionWorkspace.ino
    && identity.executionWorkspace.uid === process.getuid?.()
    && isAbsolute(binding.cwd) && normalize(binding.cwd) === binding.cwd
    && isAbsolute(binding.executable) && normalize(binding.executable) === binding.executable
    && binding.executable === `${binding.env.PATH}/git` && git.size > 0 && (git.mode & 0o111) !== 0
    && gitMatches(binding.executable, git)
    && attempt.run.started && attempt.run.directChildSettled && attempt.run.outcome === "exited" && attempt.run.exitCode === 0
    && attempt.run.signal === null && attempt.run.spawnError === null && attempt.run.terminationError === null
    && outputExact(attempt.run) && intact;
}
const reopened = new WeakMap<object, { artifactId: string; records: TwinS6AttemptRecords;
  protocol: Extract<ReturnType<typeof validateToolAttemptBundle>, { success: true }>["result"] }>();
const reopenedBrand: unique symbol = Symbol("reopenedTwinS6Attempt");
export interface ReopenedTwinS6Attempt { readonly [reopenedBrand]: true }
export type TwinS6Inspection = { status: "complete"; handle: ReopenedTwinS6Attempt } | { status: "incomplete"; reason: "retention-incomplete" };
/** Only this module can create a usable handle. Copies and deserialized values have no WeakMap entry. */
function handleFor(value: NonNullable<ReturnType<typeof reopened.get>>): ReopenedTwinS6Attempt {
  const handle = Object.freeze(Object.create(null)) as ReopenedTwinS6Attempt;
  reopened.set(handle, value);
  return handle;
}
/** Path-free, stream-free projection for scoring. It never returns private storage records. */
export function projectReopenedTwinS6Attempt(handle: ReopenedTwinS6Attempt): {
  artifactId: string; bundle: TwinS6AttemptRecords["attempt"]["bundle"];
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
export async function inspectTwinS6Attempt(directory: string): Promise<TwinS6Inspection> {
  try {
    const value = await reopenPrivateFour(directory, limits, values => {
      const manifest = ManifestSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(values[3])) as unknown);
      if (manifest.inventory.map(v => v.name).join(",") !== prior.join(",")) throw new Error("inventory");
      const records = TwinS6AttemptRecordsSchema.parse({
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
export async function retainTwinS6Attempt(parentDirectory: string, input: TwinS6AttemptRecords): Promise<{ directory?: string; inspection: TwinS6Inspection }> {
  let directory: string | undefined;
  try {
    const records = TwinS6AttemptRecordsSchema.parse(input);
    if (!coherent(records)) throw new Error("coherence");
    const bodies = [encode("identity.json", records.identity, limits), encode("attempt.json", records.attempt, limits),
      encode("outcome.json", records.outcome, limits)] as const;
    const manifest = ManifestSchema.parse({ formatVersion: 1, artifactKind: "twin-s6-attempt", artifactId: records.identity.artifactId,
      completeness: "complete", inventory: prior.map((name, index) => ({ name, sizeBytes: bodies[index]!.length, sha256: digest(bodies[index]!) })) });
    const manifestBytes = encode("manifest.json", manifest, limits);
    directory = await publishPrivateFour(parentDirectory, "twin-s6-", limits, [...bodies, manifestBytes]);
    return { directory, inspection: await inspectTwinS6Attempt(directory) };
  } catch (error) {
    if (!directory && error instanceof PrivatePublicationError) directory = error.directory;
    return { ...(directory ? { directory } : {}), inspection: { status: "incomplete", reason: "retention-incomplete" } };
  }
}
