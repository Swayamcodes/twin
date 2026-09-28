import { constants, type Stats } from "node:fs";
import { mkdir, open, opendir, lstat, realpath, type FileHandle } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { dirname, isAbsolute, join, normalize } from "node:path";
import { z } from "zod";
import { ArtifactIdSchema, SegmentIdSchema, VersionStringSchema,
  type Execution, type OriginalStateObservation } from "../contract/normalized-evidence-schema.js";
import { RunIdSchema } from "../contract/evidence-refs.js";
import { AttemptRequestSchema, ToolAttemptBundleSchema, AttemptDispositionSchema, RequestIdSchema } from "../contract/attempt-protocol-schema.js";
import { validateNormalizedToolEvidence } from "../contract/normalized-evidence-validation.js";
import { validateToolAttemptBundle } from "../contract/attempt-protocol-validation.js";
import { StreamBytesSchema } from "./records.js";

const names = ["identity.json", "attempt.json", "outcome.json", "manifest.json"] as const;
type Name = typeof names[number];
const prior = names.slice(0, 3);
const limits: Readonly<Record<Name, number>> = { "identity.json": 16_384, "attempt.json": 2_097_152,
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
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const encode = (name: Name, value: unknown): Uint8Array => {
  const bytes = Buffer.from(JSON.stringify(value), "utf8");
  if (bytes.length > limits[name]) throw new Error("too-large");
  return bytes;
};
const uid = (): number => { if (typeof process.getuid !== "function") throw new Error("uid-unavailable"); return process.getuid(); };
function safe(stat: Stats, owner: number, kind: "file" | "directory", name?: Name): void {
  if (stat.uid !== owner || stat.isSymbolicLink() || (kind === "file" ? !stat.isFile() || stat.nlink !== 1 : !stat.isDirectory())
    || (stat.mode & 0o7777) !== (kind === "file" ? 0o600 : 0o700) || name && stat.size > limits[name]) throw new Error("unsafe-object");
}
async function parent(path: string, owner: number): Promise<Stats> {
  if (!path || !isAbsolute(path) || normalize(path) !== path || path.length > 4096 || await realpath(path) !== path) throw new Error("invalid-parent");
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== owner) throw new Error("invalid-parent");
  return stat;
}
export async function validateTwinS12ArtifactParent(path: string): Promise<boolean> {
  try { await parent(path, uid()); return true; } catch { return false; }
}
async function syncDir(handle: FileHandle): Promise<void> {
  try { await handle.sync(); } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    if (code !== "EINVAL" && code !== "ENOTSUP" && code !== "EOPNOTSUPP") throw error;
  }
}
async function writeOne(path: string, name: Name, bytes: Uint8Array, owner: number): Promise<void> {
  const handle = await open(join(path, name), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  let problem: unknown;
  try {
    safe(await handle.stat(), owner, "file", name);
    for (let offset = 0; offset < bytes.length;) {
      const result = await handle.write(bytes, offset, bytes.length - offset, offset);
      if (!Number.isSafeInteger(result.bytesWritten) || result.bytesWritten <= 0 || result.bytesWritten > bytes.length - offset) throw new Error("write-progress");
      offset += result.bytesWritten;
    }
    await handle.sync();
  } catch (error) { problem = error; }
  try { await handle.close(); } catch (error) { if (problem === undefined) problem = error; }
  if (problem !== undefined) throw problem;
}
async function readOne(path: string, name: Name, owner: number): Promise<Uint8Array> {
  const location = join(path, name), before = await lstat(location); safe(before, owner, "file", name);
  const handle = await open(location, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = await handle.stat(); safe(opened, owner, "file", name);
    if (opened.dev !== before.dev || opened.ino !== before.ino) throw new Error("replaced");
    const bytes = new Uint8Array(opened.size);
    for (let offset = 0; offset < bytes.length;) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!Number.isSafeInteger(bytesRead) || bytesRead <= 0 || bytesRead > bytes.length - offset) throw new Error("short-read");
      offset += bytesRead;
    }
    if ((await handle.read(new Uint8Array(1), 0, 1, bytes.length)).bytesRead !== 0) throw new Error("grown");
    const after = await handle.stat(), named = await lstat(location); safe(after, owner, "file", name); safe(named, owner, "file", name);
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs
      || named.dev !== opened.dev || named.ino !== opened.ino) throw new Error("changed");
    return bytes;
  } finally { await handle.close(); }
}
async function exactInventory(path: string): Promise<void> {
  const dir = await opendir(path), seen = new Set<string>();
  try { for (;;) { const item = await dir.read(); if (!item) break; if (!names.includes(item.name as Name) || seen.has(item.name)) throw new Error("inventory"); seen.add(item.name); }
    if (names.some(name => !seen.has(name))) throw new Error("inventory");
  } finally { await dir.close(); }
}
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
    const owner = uid(); await parent(dirname(directory), owner);
    if (!isAbsolute(directory) || normalize(directory) !== directory || await realpath(directory) !== directory) throw new Error("path");
    const before = await lstat(directory); safe(before, owner, "directory");
    const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      const opened = await handle.stat(); safe(opened, owner, "directory");
      if (opened.dev !== before.dev || opened.ino !== before.ino) throw new Error("replaced");
      await exactInventory(directory);
      const manifestBytes = await readOne(directory, "manifest.json", owner);
      const manifest = ManifestSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes)) as unknown);
      if (manifest.inventory.map(v => v.name).join(",") !== prior.join(",")) throw new Error("inventory");
      const values: unknown[] = [];
      for (const item of manifest.inventory) {
        const name = item.name as Name, bytes = await readOne(directory, name, owner);
        if (item.sizeBytes !== bytes.length || item.sha256 !== digest(bytes)) throw new Error("digest");
        values.push(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown);
      }
      const records = TwinS12AttemptRecordsSchema.parse({ identity: values[0], attempt: values[1], outcome: values[2] });
      if (manifest.artifactId !== records.identity.artifactId || !coherent(records)) throw new Error("coherence");
      const normalized = validateNormalizedToolEvidence(records.attempt.bundle.normalizedEvidence);
      const protocol = validateToolAttemptBundle(records.attempt.bundle);
      if (!normalized.success || !protocol.success) throw new Error("validation");
      if (digest(await readOne(directory, "manifest.json", owner)) !== digest(manifestBytes)) throw new Error("manifest-replaced");
      await exactInventory(directory);
      const named = await lstat(directory), after = await handle.stat(); safe(named, owner, "directory"); safe(after, owner, "directory");
      if (named.dev !== opened.dev || named.ino !== opened.ino || after.dev !== opened.dev || after.ino !== opened.ino) throw new Error("changed");
      return { status: "complete", handle: handleFor({ artifactId: records.identity.artifactId, records, protocol: protocol.result }) };
    } finally { await handle.close(); }
  } catch { return { status: "incomplete", reason: "retention-incomplete" }; }
}
export async function retainTwinS12Attempt(parentDirectory: string, input: TwinS12AttemptRecords): Promise<{ directory?: string; inspection: TwinS12Inspection }> {
  let directory: string | undefined;
  try {
    const owner = uid(), before = await parent(parentDirectory, owner), records = TwinS12AttemptRecordsSchema.parse(input);
    if (!coherent(records)) throw new Error("coherence");
    const bodies = [encode("identity.json", records.identity), encode("attempt.json", records.attempt), encode("outcome.json", records.outcome)];
    const manifest = ManifestSchema.parse({ formatVersion: 1, artifactKind: "twin-s12-attempt", artifactId: records.identity.artifactId,
      completeness: "complete", inventory: prior.map((name, index) => ({ name, sizeBytes: bodies[index]!.length, sha256: digest(bodies[index]!) })) });
    const manifestBytes = encode("manifest.json", manifest), now = await parent(parentDirectory, owner);
    if (now.dev !== before.dev || now.ino !== before.ino) throw new Error("parent-changed");
    directory = join(parentDirectory, `twin-s12-${randomUUID()}`); await mkdir(directory, { mode: 0o700 });
    const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      safe(await handle.stat(), owner, "directory");
      for (let i = 0; i < prior.length; i++) await writeOne(directory, prior[i] as Name, bodies[i]!, owner);
      await syncDir(handle); await writeOne(directory, "manifest.json", manifestBytes, owner); await syncDir(handle);
    } finally { await handle.close(); }
    return { directory, inspection: await inspectTwinS12Attempt(directory) };
  } catch { return { ...(directory ? { directory } : {}), inspection: { status: "incomplete", reason: "retention-incomplete" } }; }
}
