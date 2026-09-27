import { constants, type Stats } from "node:fs";
import { lstat, mkdir, open, opendir, realpath, type FileHandle } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { dirname, isAbsolute, join, normalize } from "node:path";
import process from "node:process";
import { CaptureSchema, CompleteCaptureSchema, FILE_LIMITS, LIMITS, ManifestSchema, OutcomeSchema, ReservationSchema,
  incomplete, incompleteIssues, type CaptureIssue, type CompleteCapture, type FileName, type Manifest } from "./records.js";
import { projectCapture } from "./project.js";
import { ToolAttemptBundleSchema } from "../contract/attempt-protocol-schema.js";
import { validateToolAttemptBundle } from "../contract/attempt-protocol-validation.js";

const prerequisites = ["reservation.json", "capture.json", "outcome.json"] as const;
const names = [...prerequisites, "manifest.json"] as const;
type Failure = { issue: CaptureIssue; cause: unknown };
class PersistenceFailure extends AggregateError {
  constructor(readonly failures: readonly Failure[]) { super(failures.map((v) => v.cause), "Persistence failed"); }
}
function fail(code: CaptureIssue["code"], file?: FileName, cause?: unknown): never {
  throw new PersistenceFailure([{ issue: { code, path: file ? [file] : [] }, cause }]);
}
function failures(error: unknown): readonly Failure[] {
  return error instanceof PersistenceFailure ? error.failures : [{ issue: { code: "io-failed", path: [] }, cause: error }];
}
function failure(error: unknown) { return incompleteIssues(failures(error).map((v) => v.issue)); }
const ioCode = (error: unknown): string | undefined => error !== null && typeof error === "object" && "code" in error
  && typeof error.code === "string" ? error.code : undefined;
const digest = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");
async function operation<T>(code: CaptureIssue["code"], file: FileName | undefined, body: () => Promise<T>): Promise<T> {
  try { return await body(); } catch (error) { if (error instanceof PersistenceFailure) throw error; return fail(code, file, error); }
}
/** Each acquired descriptor is closed exactly once by its owning scope. */
async function scoped<T>(handle: FileHandle, file: FileName | undefined, body: () => Promise<T>): Promise<T> {
  let result: { value: T } | undefined;
  const errors: Failure[] = [];
  try { result = { value: await body() }; } catch (error) { errors.push(...failures(error)); }
  try { await handle.close(); } catch (error) { errors.push({ issue: { code: "close-failed", path: file ? [file] : [] }, cause: error }); }
  if (errors.length) throw new PersistenceFailure(errors);
  return result!.value;
}
function currentUid(): number {
  if (typeof process.getuid !== "function") return fail("uid-unavailable");
  const uid = process.getuid();
  if (!Number.isSafeInteger(uid) || uid < 0) return fail("uid-unavailable");
  return uid;
}
function owned(stat: Stats, uid: number, file?: FileName): void {
  if (stat.uid !== uid) fail("ownership-mismatch", file);
}
function directory(stat: Stats, uid: number, privateMode: boolean): void {
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail("unsafe-object");
  owned(stat, uid);
  if (privateMode && (stat.mode & 0o7777) !== 0o700) fail("unsafe-mode");
}
async function destination(path: string, uid: number): Promise<Stats> {
  if (!path || path.length > LIMITS.privateStringBytes || !isAbsolute(path) || normalize(path) !== path) fail("invalid-parent");
  let stat: Stats;
  try {
    stat = await lstat(path);
    if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(path) !== path) fail("invalid-parent");
  } catch (error) { if (error instanceof PersistenceFailure) throw error; return fail("invalid-parent", undefined, error); }
  owned(stat, uid);
  return stat;
}
async function withDirectory<T>(path: string, uid: number, body: (handle: FileHandle) => Promise<T>): Promise<T> {
  const before = await operation("read-failed", undefined, () => lstat(path));
  directory(before, uid, true);
  const handle = await operation("open-failed", undefined, () => open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW));
  return scoped(handle, undefined, async () => {
    const stat = await operation("read-failed", undefined, () => handle.stat());
    directory(stat, uid, true);
    if (stat.dev !== before.dev || stat.ino !== before.ino) fail("unsafe-object");
    return body(handle);
  });
}
async function checkDirectory(path: string, handle: FileHandle, uid: number): Promise<void> {
  const current = await operation("read-failed", undefined, () => lstat(path));
  const opened = await operation("read-failed", undefined, () => handle.stat());
  directory(current, uid, true); directory(opened, uid, true);
  if (current.dev !== opened.dev || current.ino !== opened.ino) fail("unsafe-object");
}
function regular(stat: Stats, uid: number, file: FileName): void {
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) fail("unsafe-object", file);
  owned(stat, uid, file);
  if ((stat.mode & 0o7777) !== 0o600) fail("unsafe-mode", file);
  if (stat.size > FILE_LIMITS[file]) fail("file-too-large", file);
}
async function readBounded(path: string, file: FileName, uid: number): Promise<Uint8Array> {
  const location = join(path, file);
  let before: Stats;
  try { before = await lstat(location); } catch (error) { return fail(ioCode(error) === "ENOENT" ? "missing-file" : "read-failed", file, error); }
  regular(before, uid, file);
  const handle = await operation("open-failed", file, () => open(location, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK));
  return scoped(handle, file, async () => {
    const stat = await operation("read-failed", file, () => handle.stat()); regular(stat, uid, file);
    if (stat.dev !== before.dev || stat.ino !== before.ino) fail("unsafe-object", file);
    const bytes = new Uint8Array(stat.size);
    for (let offset = 0; offset < bytes.length;) {
      const { bytesRead } = await operation("read-failed", file, () => handle.read(bytes, offset, bytes.length - offset, offset));
      if (!Number.isSafeInteger(bytesRead) || bytesRead <= 0 || bytesRead > bytes.length - offset) fail("size-mismatch", file);
      offset += bytesRead;
    }
    if ((await operation("read-failed", file, () => handle.read(new Uint8Array(1), 0, 1, bytes.length))).bytesRead !== 0) fail("size-mismatch", file);
    const after = await operation("read-failed", file, () => handle.stat());
    const named = await operation("read-failed", file, () => lstat(location));
    regular(after, uid, file); regular(named, uid, file);
    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs
      || named.dev !== stat.dev || named.ino !== stat.ino) fail("size-mismatch", file);
    return bytes;
  });
}
function json(file: FileName, bytes: Uint8Array): unknown {
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown; }
  catch (error) { return fail("invalid-json", file, error); }
}
async function inventory(path: string): Promise<void> {
  const entries = await operation("open-failed", undefined, () => opendir(path));
  const errors: Failure[] = [], seen = new Set<string>();
  try {
    for (;;) {
      const entry = await operation("read-failed", undefined, () => entries.read());
      if (!entry) break;
      if (!(names as readonly string[]).includes(entry.name) || seen.has(entry.name)) fail("inventory-mismatch");
      seen.add(entry.name);
    }
    for (const file of names) if (!seen.has(file)) fail("missing-file", file);
  } catch (error) { errors.push(...failures(error)); }
  try { await entries.close(); } catch (error) { errors.push({ issue: { code: "close-failed", path: [] }, cause: error }); }
  if (errors.length) throw new PersistenceFailure(errors);
}
/** Non-exported: called only with the exact records reopened and verified below. */
function finalize(records: CompleteCapture) {
  const projected = projectCapture(records);
  if (projected.status !== "projected") return projected;
  if (projected.kind === "reference-only") return { ...projected, status: "complete" as const, retention: "retained" as const };
  const bundle = ToolAttemptBundleSchema.parse({ ...projected.bundle, protocolObservations: { ...projected.bundle.protocolObservations,
    disposition: { ...projected.bundle.protocolObservations.disposition,
      artifacts: { ...projected.bundle.protocolObservations.disposition.artifacts, status: "retained", reason: "private-only" } } } });
  const checked = validateToolAttemptBundle(bundle);
  if (!checked.success || checked.result.attemptValidity !== projected.protocol.attemptValidity
    || checked.result.scoreReadiness !== projected.protocol.scoreReadiness) return incomplete("projection-invalid");
  return { ...projected, status: "complete" as const, retention: "retained" as const, bundle, protocol: checked.result };
}
/** Sole retention authority. No records, capability objects, or I/O dependencies are accepted. */
export async function inspectArtifact(path: string) {
  try {
    const uid = currentUid();
    await destination(dirname(path), uid);
    if (!path || !isAbsolute(path) || normalize(path) !== path) fail("invalid-parent");
    const records = await withDirectory(path, uid, async (handle) => {
      if (await operation("read-failed", undefined, () => realpath(path)) !== path) fail("unsafe-object");
      await inventory(path);
      const manifestBytes = await readBounded(path, "manifest.json", uid);
      const parsedManifest = ManifestSchema.safeParse(json("manifest.json", manifestBytes));
      if (!parsedManifest.success) fail("invalid-record", "manifest.json");
      const manifest = parsedManifest.data, bodies: Partial<Record<FileName, unknown>> = {};
      for (const file of prerequisites) {
        const bytes = await readBounded(path, file, uid), entry = manifest.inventory.find((v) => v.name === file)!;
        if (bytes.length !== entry.sizeBytes) fail("size-mismatch", file);
        if (digest(bytes) !== entry.sha256) fail("digest-mismatch", file);
        bodies[file] = json(file, bytes);
      }
      const reservation = ReservationSchema.safeParse(bodies["reservation.json"]), capture = CaptureSchema.safeParse(bodies["capture.json"]),
        outcome = OutcomeSchema.safeParse(bodies["outcome.json"]);
      if (!reservation.success) fail("invalid-record", "reservation.json");
      if (!capture.success) fail("invalid-record", "capture.json");
      if (!outcome.success) fail("invalid-record", "outcome.json");
      const kind = capture.data.attempt.status === "captured" ? "reference-plus-attempt" : "reference-only";
      const parsed = CompleteCaptureSchema.safeParse({ privateFormatVersion: 1, normalizerVersion: 1, kind,
        reservation: reservation.data, capture: capture.data, outcome: outcome.data });
      if (!parsed.success || manifest.artifactId !== reservation.data.artifactId) fail("invalid-record");
      if (manifest.artifactKind !== (kind === "reference-only" ? "reference-only-failure" : kind)) fail("invalid-record", "manifest.json");
      if (digest(await readBounded(path, "manifest.json", uid)) !== digest(manifestBytes)) fail("digest-mismatch", "manifest.json");
      await inventory(path); await checkDirectory(path, handle, uid);
      return parsed.data;
    });
    return finalize(records);
  } catch (error) { return failure(error); }
}
export type ArtifactInspection = Awaited<ReturnType<typeof inspectArtifact>>;
export async function writeAll(bytes: Uint8Array, write: (offset: number, length: number) => Promise<number>): Promise<void> {
  for (let offset = 0; offset < bytes.length;) {
    const count = await write(offset, bytes.length - offset);
    if (!Number.isSafeInteger(count) || count <= 0 || count > bytes.length - offset) fail("write-progress");
    offset += count;
  }
}
function encode(file: FileName, value: unknown): Uint8Array {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  if (bytes.length > FILE_LIMITS[file]) fail("file-too-large", file);
  return bytes;
}
async function syncDirectory(handle: FileHandle): Promise<void> {
  try { await handle.sync(); } catch (error) {
    if (!["EINVAL", "ENOTSUP", "EOPNOTSUPP"].includes(ioCode(error) ?? "")) fail("sync-failed", undefined, error);
  }
}
async function writeExclusive(path: string, file: FileName, bytes: Uint8Array, uid: number): Promise<void> {
  const handle = await operation("open-failed", file, () => open(join(path, file), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600));
  await scoped(handle, file, async () => {
    regular(await operation("read-failed", file, () => handle.stat()), uid, file);
    try {
      await writeAll(bytes, async (offset, length) => (await operation("write-failed", file, () => handle.write(bytes, offset, length, offset))).bytesWritten);
    } catch (error) {
      if (error instanceof PersistenceFailure) throw new PersistenceFailure(error.failures.map((entry) => ({ ...entry,
        issue: { ...entry.issue, path: entry.issue.path.length ? entry.issue.path : [file] } })));
      throw error;
    }
    await operation("sync-failed", file, () => handle.sync());
  });
}
/** Private locator only; all retained public output is obtained by strict reopen. */
export async function retainArtifact(parent: string, input: CompleteCapture) {
  let path: string | undefined;
  try {
    const uid = currentUid(), parentBefore = await destination(parent, uid);
    const parsed = CompleteCaptureSchema.safeParse(input);
    if (!parsed.success) return { inspection: incomplete("invalid-record") };
    const records = parsed.data, bodies = { "reservation.json": encode("reservation.json", records.reservation),
      "capture.json": encode("capture.json", records.capture), "outcome.json": encode("outcome.json", records.outcome) };
    const manifest: Manifest = { privateFormatVersion: 1, normalizerVersion: 1, artifactId: records.reservation.artifactId,
      artifactKind: records.kind === "reference-only" ? "reference-only-failure" : "reference-plus-attempt", completeness: "complete",
      inventory: prerequisites.map((name) => ({ name, sizeBytes: bodies[name].length, sha256: digest(bodies[name]) })) };
    const manifestBytes = encode("manifest.json", ManifestSchema.parse(manifest));
    const parentNow = await destination(parent, uid);
    if (parentBefore.dev !== parentNow.dev || parentBefore.ino !== parentNow.ino) fail("invalid-parent");
    path = join(parent, `capture-${randomUUID()}`);
    await operation("write-failed", undefined, () => mkdir(path!, { mode: 0o700 }));
    const allocated = path;
    await withDirectory(allocated, uid, async (handle) => {
      for (const file of prerequisites) { await checkDirectory(allocated, handle, uid); await writeExclusive(allocated, file, bodies[file], uid); }
      await syncDirectory(handle); await checkDirectory(allocated, handle, uid);
      await writeExclusive(allocated, "manifest.json", manifestBytes, uid); await syncDirectory(handle);
    });
    return { directory: allocated, inspection: await inspectArtifact(allocated) };
  } catch (error) { return { ...(path ? { directory: path } : {}), inspection: failure(error) }; }
}
