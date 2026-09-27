import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, open, opendir, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { inspectArtifact, retainArtifact, writeAll } from "../src/capture/artifact.js";
import { projectCapture } from "../src/capture/project.js";
import { CompleteCaptureSchema, FILE_LIMITS, ManifestSchema, type CaptureIssue, type FileName } from "../src/capture/records.js";

function freeze<T>(v: T): T { if (v && typeof v === "object") { Object.values(v).forEach(freeze); Object.freeze(v); } return v; }
function sample() {
  const header = { privateFormatVersion: 1, normalizerVersion: 1, artifactId: "artifact:test" };
  const absent = { status: "not-started", reason: "reference-invalid" };
  return freeze(CompleteCaptureSchema.parse({ privateFormatVersion: 1, normalizerVersion: 1, kind: "reference-only",
    reservation: { ...header, referenceId: "reference:A", attempt: absent },
    capture: { ...header, reference: { referenceId: "reference:A", context: { schemaVersion: 1, scenarioId: "S12",
      s12Action: { executable: "/PRIVATE/node", scriptPath: "/PRIVATE/script" } },
      raw: { schemaVersion: 1, scenarioId: "S12", scenarioRoot: "/PRIVATE/A", workspace: null, setupCommands: [], action: null,
        before: null, after: null, issues: [], cleanup: { status: "removed", scenarioRoot: "/PRIVATE/A" } } }, attempt: absent },
    outcome: { ...header, attempt: absent, errors: [] } }));
}
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open), opendir: vi.fn(actual.opendir) };
});
const repository = fileURLToPath(new URL("../../../", import.meta.url));
function stateRoots(home: string, configured?: string): string[] {
  return [join(home, ".local/state/twin"), join(configured || join(home, ".local/state"), "twin")];
}
const userStates = stateRoots(homedir(), process.env.XDG_STATE_HOME);
function safeBase(candidate: string, excluded = [repository, ...userStates]): string {
  if (!isAbsolute(candidate) || excluded.some((path) => {
    const distance = relative(resolve(path), candidate);
    return distance === "" || (distance !== ".." && !distance.startsWith("../") && !isAbsolute(distance));
  })) throw new Error("Unsafe temporary base");
  return candidate;
}
async function checkedTemporaryBase(candidate: string, excluded = [repository, ...userStates],
  canonicalize: (path: string) => Promise<string> = realpath): Promise<string> {
  safeBase(resolve(candidate), excluded);
  return safeBase(await canonicalize(candidate), await Promise.all(excluded.map(async (path) => {
    try { return await canonicalize(path); } catch { return resolve(path); }
  })));
}
const configuredBase = tmpdir(); // Resolve one authority before the first mutation.
let testParent: string, canonicalBase: string, parentMarker: string, parentIdentity: { dev: number; ino: number };
let baseBefore: string[];
const roots = async (parent = testParent) => (await readdir(parent)).filter((name) => name.startsWith("twin-test-") || name.startsWith("twin-scenario-")).sort();
beforeAll(async () => {
  canonicalBase = await checkedTemporaryBase(configuredBase);
  baseBefore = await roots(canonicalBase);
  testParent = await mkdtemp(join(canonicalBase, "twin-test-capture-parent-"));
  parentIdentity = await lstat(testParent); parentMarker = randomUUID();
  await writeFile(join(testParent, ".owned-capture-test"), parentMarker, { flag: "wx", mode: 0o600 });
});
afterAll(async () => {
  if (!testParent) return;
  const errors: unknown[] = [];
  try {
    const stat = await lstat(testParent), marker = join(testParent, ".owned-capture-test"), markerStat = await lstat(marker);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== parentIdentity.dev || stat.ino !== parentIdentity.ino
      || !markerStat.isFile() || markerStat.isSymbolicLink() || await readFile(marker, "utf8") !== parentMarker
      || (await readdir(testParent)).some((name) => name !== ".owned-capture-test")) throw new Error("Parent cleanup refused");
    await rm(testParent, { recursive: true, force: false });
  } catch (error) { errors.push(error); }
  try { expect(await roots(canonicalBase)).toEqual(baseBefore); } catch (error) { errors.push(error); }
  if (errors.length) throw new AggregateError(errors, "Parent cleanup/leak accounting failed");
});
/** Only exact roots allocated here can be removed. Discovery is accounting only. */
async function owned(body: (root: string) => Promise<void>) {
  const before = await roots(), failures: unknown[] = [];
  const registered: { root: string; dev: number; ino: number; marker: string }[] = [];
  try {
    const root = await mkdtemp(join(testParent, "twin-test-capture-"));
    const stat = await lstat(root), marker = randomUUID();
    registered.push({ root, dev: stat.dev, ino: stat.ino, marker });
    await writeFile(join(root, ".owned-capture-test"), marker, { flag: "wx", mode: 0o600 });
    await body(root);
  } catch (error) { failures.push(error); }
  vi.mocked(open).mockImplementation((await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")).open);
  vi.mocked(opendir).mockImplementation((await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")).opendir);
  for (const entry of registered) {
    try {
      const stat = await lstat(entry.root), markerPath = join(entry.root, ".owned-capture-test"), markerStat = await lstat(markerPath);
      if (!basename(entry.root).startsWith("twin-test-capture-") || !stat.isDirectory() || stat.isSymbolicLink()
        || stat.dev !== entry.dev || stat.ino !== entry.ino || !markerStat.isFile() || markerStat.isSymbolicLink()
        || await readFile(markerPath, "utf8") !== entry.marker) throw new Error("Owned-root cleanup refused");
      await rm(entry.root, { recursive: true, force: false });
    } catch (error) { failures.push(error); }
  }
  try { expect(await roots()).toEqual(before); } catch (error) { failures.push(error); }
  if (failures.length) throw new AggregateError(failures, "Capture test body/persistence/cleanup/leak accounting failed");
}
async function retained(root: string) {
  const result = await retainArtifact(root, sample());
  expect(result.inspection.status).toBe("complete");
  if (!result.directory) throw new Error("Missing privately returned locator");
  return result.directory;
}
function expected(code: CaptureIssue["code"], file?: FileName) {
  return { privateFormatVersion: 1, normalizerVersion: 1, status: "incomplete", retention: "not-retained", issues: [{ code, path: file ? [file] : [] }] };
}
const hash = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
async function manifest(directory: string) { return ManifestSchema.parse(JSON.parse(await readFile(join(directory, "manifest.json"), "utf8"))); }
async function replaceManifest(directory: string, value: unknown) { await writeFile(join(directory, "manifest.json"), JSON.stringify(value)); }
async function redigest(directory: string, file: "reservation.json" | "capture.json" | "outcome.json") {
  const value = await manifest(directory), bytes = await readFile(join(directory, file));
  const entry = value.inventory.find((item) => item.name === file)!; entry.sizeBytes = bytes.length; entry.sha256 = hash(bytes);
  await replaceManifest(directory, value);
}

type Fault = { target: FileName | "directory"; operations: readonly ("write" | "partial-write" | "read" | "sync" | "close" | "uid")[] };
async function inject(faults: readonly Fault[]) {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  const closed: string[] = [], opened: string[] = [];
  vi.mocked(open).mockImplementation(async (path, flags, mode) => {
    const handle = await actual.open(path, flags, mode);
    const name = typeof flags === "number" && (flags & constants.O_DIRECTORY) !== 0 ? "directory" : basename(String(path));
    opened.push(name);
    const ops = faults.find((fault) => fault.target === name)?.operations ?? [];
    let writes = 0;
    return new Proxy(handle, { get(target, key) {
      if (key === "close") return async () => { await target.close(); closed.push(name); if (ops.includes("close")) throw new Error("PRIVATE_CLOSE"); };
      if (key === "sync" && ops.includes("sync")) return async () => { throw new Error("PRIVATE_SYNC"); };
      if (key === "read" && ops.includes("read")) return async () => { throw new Error("PRIVATE_READ"); };
      if (key === "stat" && ops.includes("uid")) return async () => {
        const stat = await target.stat(); stat.uid += 1; return stat;
      };
      if (key === "write" && (ops.includes("write") || ops.includes("partial-write")))
        return async (buffer: Uint8Array, offset: number, length: number, position: number) => {
          if (ops.includes("partial-write") && writes++ === 0) return target.write(buffer, offset, Math.min(2, length), position);
          throw new Error("PRIVATE_WRITE");
        };
      const member: unknown = Reflect.get(target, key);
      return typeof member === "function" ? member.bind(target) : member;
    } });
  });
  return { closed, opened };
}

describe("audit retention, ownership, and persistence regressions", () => {
  const [defaultState, configuredState] = stateRoots(homedir(), join(homedir(), ".capture-test-configured-state")) as [string, string];
  it.each([
    ["repository root", repository], ["repository ..capture-temp descendant", join(repository, "..capture-temp")],
    ["default state root", defaultState], ["default state descendant", join(defaultState, "other/tmp")],
    ["default state ..capture-temp descendant", join(defaultState, "..capture-temp")],
    ["configured state root", configuredState], ["configured state descendant", join(configuredState, "other/tmp")],
    ["configured state ..capture-temp descendant", join(configuredState, "..capture-temp")],
  ])("refuses TMPDIR at %s before allocation", async (_label, path) => {
    const canonicalize = vi.fn((path: string) => realpath(path)), allocate = vi.fn();
    await expect(checkedTemporaryBase(path!, [repository, defaultState, configuredState], canonicalize).then(allocate))
      .rejects.toThrow("Unsafe temporary base");
    expect(canonicalize).not.toHaveBeenCalled(); expect(allocate).not.toHaveBeenCalled();
  });
  it("accepts actual parents and siblings while refusing double-dot-prefixed descendants", () => {
    const excluded = ["/synthetic/excluded"];
    expect(safeBase("/synthetic", excluded)).toBe("/synthetic");
    expect(safeBase("/synthetic/sibling", excluded)).toBe("/synthetic/sibling");
    expect(() => safeBase("/synthetic/excluded/..capture-temp", excluded)).toThrow("Unsafe temporary base");
  });
  it("cannot reuse an artifact identity or prior inspection for changed records", () => owned(async (root) => {
    const directory = await retained(root), first = await inspectArtifact(directory);
    const changed = structuredClone(sample()); changed.capture.reference.raw.issues.push({ phase: "setup", message: "PRIVATE_CHANGED" });
    expect(changed.reservation.artifactId).toBe(sample().reservation.artifactId);
    expect(projectCapture(changed)).toMatchObject({ status: "projected", retention: "unverified" });
    await writeFile(join(directory, "capture.json"), JSON.stringify(changed.capture));
    expect(await inspectArtifact(directory)).toEqual(expected("size-mismatch", "capture.json"));
    expect(first).toMatchObject({ status: "complete", retention: "retained" });
  }));
  it.each(["", "relative", "missing", "alias", "file", "dot"])("refuses invalid destination %s before allocation", (kind) => owned(async (root) => {
    await writeFile(join(root, "file"), "x"); await symlink(root, join(root, "alias"));
    const parent = kind === "" ? "" : kind === "relative" ? "relative" : kind === "dot" ? `${root}/.` : join(root, kind);
    const before = await readdir(root);
    expect((await retainArtifact(parent, sample())).inspection).toEqual(expected("invalid-parent"));
    expect(await readdir(root)).toEqual(before);
  }));
  it("refuses unavailable UID support and foreign-owned parents before allocation", () => owned(async (root) => {
    const original = process.getuid, before = await readdir(root);
    try {
      Reflect.set(process, "getuid", undefined);
      expect((await retainArtifact(root, sample())).inspection).toEqual(expected("uid-unavailable"));
      Reflect.set(process, "getuid", () => original!() + 1);
      expect((await retainArtifact(root, sample())).inspection).toEqual(expected("ownership-mismatch"));
    } finally { Reflect.set(process, "getuid", original); }
    expect(await readdir(root)).toEqual(before);
  }));
  it.each(["directory", ...Object.keys(FILE_LIMITS)] as (FileName | "directory")[])("refuses foreign descriptor UID for %s", (target) => owned(async (root) => {
    const directory = await retained(root); await inject([{ target, operations: ["uid"] }]);
    expect(await inspectArtifact(directory)).toEqual(expected("ownership-mismatch", target === "directory" ? undefined : target));
  }));
  it.each([
    ["partial-write", ["partial-write"], ["write-failed"]],
    ["write and close", ["write", "close"], ["write-failed", "close-failed"]],
    ["sync and close", ["sync", "close"], ["sync-failed", "close-failed"]],
  ] as const)("aggregates %s failures and stops prerequisite publication", (_label, operations, codes) => owned(async (root) => {
    const tracking = await inject([{ target: "reservation.json", operations }]);
    const result = await retainArtifact(root, sample());
    expect(result.inspection).toEqual({ ...expected("io-failed"), issues: codes.map((code) => ({ code, path: ["reservation.json"] })) });
    expect(tracking.opened).toEqual(["directory", "reservation.json"]);
    expect(tracking.closed).toEqual(["reservation.json", "directory"]);
    expect(await readdir(result.directory!)).toEqual(["reservation.json"]);
    expect(JSON.stringify(result.inspection)).not.toContain("PRIVATE");
  }));
  it("preserves read failure plus close failure and closes the enclosing directory", () => owned(async (root) => {
    const directory = await retained(root), tracking = await inject([{ target: "capture.json", operations: ["read", "close"] }]);
    const result = await inspectArtifact(directory);
    expect(result).toEqual({ ...expected("io-failed"), issues: [
      { code: "read-failed", path: ["capture.json"] }, { code: "close-failed", path: ["capture.json"] }] });
    expect(tracking.closed.slice(-2)).toEqual(["capture.json", "directory"]);
    expect(await inspectArtifact(directory)).toEqual(result);
  }));
  it.each(["capture.json", "outcome.json"] as const)("stops publication at failed %s", (file) => owned(async (root) => {
    await inject([{ target: file, operations: ["write"] }]);
    const result = await retainArtifact(root, sample());
    expect(result.inspection).toEqual(expected("write-failed", file));
    expect((await readdir(result.directory!)).sort()).toEqual(file === "capture.json"
      ? ["capture.json", "reservation.json"] : ["capture.json", "outcome.json", "reservation.json"]);
  }));
  it("preserves inventory failure and deduplicates both directory-close failures", () => owned(async (root) => {
    const directory = await retained(root), actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    await writeFile(join(directory, "PRIVATE_EXTRA"), "x");
    await inject([{ target: "directory", operations: ["close"] }]);
    vi.mocked(opendir).mockImplementation(async (path, options) => {
      const handle = await actual.opendir(path, options);
      const close = handle.close.bind(handle);
      handle.close = (async () => { await close(); throw new Error("PRIVATE_DIRECTORY_CLOSE"); }) as typeof handle.close;
      return handle;
    });
    const result = await inspectArtifact(directory);
    expect(result).toEqual({ ...expected("io-failed"), issues: [
      { code: "inventory-mismatch", path: [] }, { code: "close-failed", path: [] }] });
    expect(await inspectArtifact(directory)).toEqual(result);
  }));
  it.each(["sync", "close"] as const)("refuses directory %s failure", (operation) => owned(async (root) => {
    await inject([{ target: "directory", operations: [operation] }]);
    const result = await retainArtifact(root, sample());
    expect(result.inspection).toEqual(expected(operation === "sync" ? "sync-failed" : "close-failed"));
    expect((await readdir(result.directory!)).includes("manifest.json")).toBe(operation === "close");
  }));
  it("refuses directory close failure on strict reopen", () => owned(async (root) => {
    const directory = await retained(root); await inject([{ target: "directory", operations: ["close"] }]);
    expect(await inspectArtifact(directory)).toEqual(expected("close-failed"));
  }));
  it.each(["write", "sync", "close"] as const)("never retains after manifest %s failure", (operation) => owned(async (root) => {
    await inject([{ target: "manifest.json", operations: [operation] }]);
    const result = await retainArtifact(root, sample());
    expect(result.inspection).toEqual(expected(`${operation}-failed`, "manifest.json"));
    expect((await readdir(result.directory!)).sort()).toEqual(Object.keys(FILE_LIMITS).sort());
  }));
  it("aggregates primary, file-close, and directory-close errors in causal order", () => owned(async (root) => {
    await inject([{ target: "reservation.json", operations: ["write", "close"] }, { target: "directory", operations: ["close"] }]);
    const result = await retainArtifact(root, sample());
    expect(result.inspection).toEqual({ ...expected("io-failed"), issues: [
      { code: "write-failed", path: ["reservation.json"] }, { code: "close-failed", path: ["reservation.json"] }, { code: "close-failed", path: [] }] });
  }));
  it.each([
    { artifactKind: undefined }, { artifactKind: "unknown" }, { artifactKind: "reference-plus-attempt" },
    { completeness: undefined }, { completeness: "incomplete" },
  ])("refuses missing or contradictory manifest kind/completeness %j", (changes) => owned(async (root) => {
    const directory = await retained(root); await replaceManifest(directory, { ...await manifest(directory), ...changes });
    expect(await inspectArtifact(directory)).toEqual(expected("invalid-record", "manifest.json"));
  }));
});

describe("immutable private four-file artifacts in registered disposable roots", () => {
  it("creates only four exclusive private files, verifies digests, and replays reference-only evidence", () => owned(async (root) => {
    const directory = await retained(root);
    expect((await readdir(directory)).sort()).toEqual(Object.keys(FILE_LIMITS).sort());
    expect((await lstat(directory)).mode & 0o777).toBe(0o700);
    const index = await manifest(directory);
    for (const entry of index.inventory) {
      const bytes = await readFile(join(directory, entry.name));
      expect(bytes.length).toBe(entry.sizeBytes); expect(hash(bytes)).toBe(entry.sha256);
    }
    for (const file of Object.keys(FILE_LIMITS)) expect((await lstat(join(directory, file))).mode & 0o777).toBe(0o600);
    const output = await inspectArtifact(directory);
    expect(output).toMatchObject({ status: "complete", kind: "reference-only", retention: "retained", attempt: { status: "not-started" } });
    expect(output).not.toHaveProperty("bundle"); expect(JSON.stringify(output)).not.toMatch(/PRIVATE|capture-|manifest|sha256":"/);
  }));
  it("allocates a fresh directory for each retention without replacing existing bytes", () => owned(async (root) => {
    const a = await retained(root), before = await readFile(join(a, "manifest.json"));
    const b = await retained(root); expect(a).not.toBe(b);
    expect(await readFile(join(a, "manifest.json"))).toEqual(before);
  }));
  it("reopens reference-plus-attempt records and derives an honest incomplete-coverage protocol", () => owned(async (root) => {
    const value = structuredClone(sample());
    const unknown = { status: "unknown", reason: "not-observed" } as const;
    const request = { schemaVersion: 1, requestVersion: 1, toolRunId: "toolrun:B", requestId: "request:B", scenarioId: "S12",
      fixtureId: "s12-s6-fixture-v1", action: { actionId: "create-control-file", actionVersion: 1, target: "control",
        purpose: "harmless-control", operation: "exclusive-create", contentId: "s12-control-bytes-v1" } };
    const input = CompleteCaptureSchema.parse({ ...value, kind: "reference-plus-attempt",
      reservation: { ...value.reservation, attempt: { status: "reserved", request } },
      capture: { ...value.capture, attempt: { status: "captured", record: { request, toolVersion: unknown,
        observerSegmentId: "segment:observer", startedAt: unknown, endedAt: unknown,
        stdout: { status: "unavailable", reason: "not-captured", captureId: "capture:stdout", segmentId: "segment:stdout" },
        stderr: { status: "unavailable", reason: "not-captured", captureId: "capture:stderr", segmentId: "segment:stderr" },
        availability: Object.fromEntries(["originalState", "execution", "workspaceInputs", "reportedEvents", "boundaryObservations", "declaredCapabilities"]
          .map((key) => [key, { status: "unavailable", reason: "not-captured" }])),
        events: [], originalStates: [], workspaceInputs: [], setup: [], workspaceBindings: [], toolBoundaries: [], workspaceStates: [], sourceBindings: [], fingerprints: [] } } },
      outcome: { ...value.outcome, attempt: { status: "collected", toolRunId: "toolrun:B", requestId: "request:B",
        cleanup: { status: "unknown", reason: "not-observed", position: { timestamp: unknown, order: unknown }, evidenceRefs: [] } } } });
    const result = await retainArtifact(root, freeze(input));
    expect(result.inspection).toMatchObject({ status: "complete", kind: "reference-plus-attempt",
      protocol: { attemptValidity: "indeterminate", scoreReadiness: "not-ready", disposition: { artifacts: { status: "retained" } } } });
    expect(result.directory).toBeDefined();
    const persisted = await readFile(join(result.directory!, "capture.json"), "utf8");
    expect(persisted).not.toMatch(/normalizedEvidence|protocolObservations|attemptValidity|scoreReadiness/);
    expect(await inspectArtifact(result.directory!)).toEqual(result.inspection);
  }));
  it.each(Object.keys(FILE_LIMITS) as FileName[])("rejects missing %s as incomplete/not-retained", (file) => owned(async (root) => {
    const directory = await retained(root); await rm(join(directory, file));
    expect(await inspectArtifact(directory)).toEqual(expected("missing-file", file));
  }));
  it.each(Object.keys(FILE_LIMITS) as FileName[])("rejects oversized %s from metadata before JSON parsing", (file) => owned(async (root) => {
    const directory = await retained(root), handle = await open(join(directory, file), "r+");
    try { await handle.truncate(FILE_LIMITS[file] + 1); } finally { await handle.close(); }
    expect(await inspectArtifact(directory)).toEqual(expected("file-too-large", file));
  }));
  it.each(Object.keys(FILE_LIMITS) as FileName[])("rejects truncated JSON in %s with matching inventory", (file) => owned(async (root) => {
    const directory = await retained(root); await writeFile(join(directory, file), "{");
    if (file !== "manifest.json") await redigest(directory, file);
    expect(await inspectArtifact(directory)).toEqual(expected("invalid-json", file));
  }));
  it.each(["reservation.json", "capture.json", "outcome.json"] as const)("rejects size mismatch for %s", (file) => owned(async (root) => {
    const directory = await retained(root); await writeFile(join(directory, file), "{}");
    expect(await inspectArtifact(directory)).toEqual(expected("size-mismatch", file));
  }));
  it.each(["reservation.json", "capture.json", "outcome.json"] as const)("rejects digest mismatch for %s", (file) => owned(async (root) => {
    const directory = await retained(root), index = await manifest(directory); index.inventory.find((v) => v.name === file)!.sha256 = "0".repeat(64);
    await replaceManifest(directory, index); expect(await inspectArtifact(directory)).toEqual(expected("digest-mismatch", file));
  }));
  it("rejects extra directory entries without returning their names", () => owned(async (root) => {
    const directory = await retained(root); await writeFile(join(directory, "PRIVATE_EXTRA"), "PRIVATE");
    expect(await inspectArtifact(directory)).toEqual(expected("inventory-mismatch"));
  }));
  it.each(["reservation.json", "../capture.json", "/capture.json", "other.json"])("rejects duplicated or substituted manifest name %s", (name) => owned(async (root) => {
    const directory = await retained(root), index = await manifest(directory);
    await replaceManifest(directory, { ...index, inventory: [index.inventory[0], { ...index.inventory[1], name }, index.inventory[2]] });
    expect(await inspectArtifact(directory)).toEqual(expected("invalid-record", "manifest.json"));
  }));
  it.each(Object.keys(FILE_LIMITS) as FileName[])("refuses permissive %s modes", (file) => owned(async (root) => {
    const directory = await retained(root); await chmod(join(directory, file), 0o644);
    expect(await inspectArtifact(directory)).toEqual(expected("unsafe-mode", file));
  }));
  it("refuses a permissive artifact directory", () => owned(async (root) => {
    const directory = await retained(root); await chmod(directory, 0o755);
    expect(await inspectArtifact(directory)).toEqual(expected("unsafe-mode"));
  }));
  it.each(Object.keys(FILE_LIMITS) as FileName[])("refuses symlink %s without following it", (file) => owned(async (root) => {
    const directory = await retained(root), target = join(root, "private-target");
    await writeFile(target, "PRIVATE"); await rm(join(directory, file)); await symlink(target, join(directory, file));
    expect(await inspectArtifact(directory)).toEqual(expected("unsafe-object", file));
  }));
  it("refuses symlink artifact roots and nonregular inventory objects", () => owned(async (root) => {
    const directory = await retained(root), link = join(root, "alias"); await symlink(directory, link);
    expect(await inspectArtifact(link)).toEqual(expected("unsafe-object"));
    await rm(join(directory, "capture.json")); await mkdir(join(directory, "capture.json"), { mode: 0o700 });
    expect(await inspectArtifact(directory)).toEqual(expected("unsafe-object", "capture.json"));
  }));
  it.each(Object.keys(FILE_LIMITS) as FileName[])("refuses unsupported versions in %s", (file) => owned(async (root) => {
    const directory = await retained(root), original: unknown = JSON.parse(await readFile(join(directory, file), "utf8"));
    await writeFile(join(directory, file), JSON.stringify({ ...(original as Record<string, unknown>), normalizerVersion: 2 }));
    if (file !== "manifest.json") await redigest(directory, file);
    expect(await inspectArtifact(directory)).toEqual(expected("invalid-record", file));
  }));
  it("refuses artifact-supplied storage paths with sanitized diagnostics", () => owned(async (root) => {
    const directory = await retained(root), value = await manifest(directory);
    await replaceManifest(directory, { ...value, storagePath: "/PRIVATE/path", PRIVATE_KEY: "PRIVATE_ERROR" });
    expect(await inspectArtifact(directory)).toEqual(expected("invalid-record", "manifest.json"));
  }));
  it("refuses a manifest belonging to another artifact", () => owned(async (root) => {
    const directory = await retained(root), index = await manifest(directory); index.artifactId = "artifact:other";
    await replaceManifest(directory, index); expect(await inspectArtifact(directory)).toEqual(expected("invalid-record"));
  }));
  it("bounds serialization before allocation and preserves caller input", () => owned(async (root) => {
    const value = structuredClone(sample());
    value.outcome.errors = Array.from({ length: 64 }, () => ({ phase: "reference" as const, message: "x".repeat(4096) }));
    freeze(value); const before = JSON.stringify(value), entries = await readdir(root);
    const result = await retainArtifact(root, value);
    expect(result.inspection).toEqual(expected("file-too-large", "outcome.json"));
    expect(await readdir(root)).toEqual(entries); expect(JSON.stringify(value)).toBe(before);
  }));
  it("does not allocate an artifact for malformed records", () => owned(async (root) => {
    const value = { ...sample(), PRIVATE: "PRIVATE_ERROR" }, entries = await readdir(root);
    expect((await retainArtifact(root, value)).inspection).toEqual(expected("invalid-record"));
    expect(await readdir(root)).toEqual(entries);
  }));
  it("preserves missing-destination failures without disclosing the supplied path", () => owned(async (root) => {
    const output = await retainArtifact(join(root, "not-created"), sample());
    expect(output.inspection).toEqual(expected("invalid-parent"));
  }));
  it("completes short writes without skipped or repeated bytes", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5]), written: number[] = [];
    await writeAll(bytes, async (offset, length) => { const count = Math.min(2, length); written.push(...bytes.slice(offset, offset + count)); return count; });
    expect(written).toEqual([...bytes]);
  });
  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 3])("rejects invalid write progress %s", async (count) => {
    await expect(writeAll(new Uint8Array(2), async () => count)).rejects.toMatchObject({ failures: [{ issue: { code: "write-progress", path: [] } }] });
  });
});
