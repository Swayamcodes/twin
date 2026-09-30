import assert from "node:assert/strict";
import childProcess, { type SpawnOptions } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { constants, accessSync, lstatSync, realpathSync, readFileSync, openSync, closeSync, fstatSync } from "node:fs";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createTwin, type TwinSession, type RunResult } from "@twin-cli/core";
import { createScenarioRoot, initializeScenarioRoot, initializeFixture, cleanupScenarioRoot, verifyWorkspace,
  type OwnedScenarioRoot } from "./fixture.js";
import { runScenarioWithRegisteredRootObserver, observePaths } from "./runner.js";
import type { RegisteredScenarioRootAttestation } from "./fixture.js";
import { getCommand, getScenario, fixtureContents } from "./scenarios.js";
import { evaluateScenarioOracle } from "./oracle.js";
import { retainArtifact, inspectArtifact } from "./capture/artifact.js";
import { retainTwinS12Attempt, inspectTwinS12Attempt, projectReopenedTwinS12Attempt, validateTwinS12ArtifactParent,
  type TwinS12AttemptRecords } from "./capture/twin-s12-attempt.js";
import { deriveS12ScoreSupport, validateS12ScoreSupport, S12ScoreResultSchema,
  type S12ScoreResult, type S12FailureStage, type S12FailureReason } from "./contract/s12-score-support.js";
import { validateNormalizedToolEvidence } from "./contract/normalized-evidence-validation.js";
import { validateToolAttemptBundle, AttemptRequestSchema, type ToolAttemptBundle, type AttemptRequest, type Position,
  type WorkspaceStateObservation, type OriginalStateObservation, type NormalizedToolEvidence,
  type ToolAttemptProtocolResult } from "./contract/index.js";
import { VersionStringSchema } from "./contract/normalized-evidence-schema.js";
import type { OracleResult } from "./contract/oracle-schema.js";
import type { Snapshot, CommandEvidence } from "./types.js";

const actionBody = 'import { writeFile } from "node:fs/promises";\n'
  + 'await writeFile("control-created.txt", "S12 control file.\\n", { flag: "wx" });\n';
const actionEnv = Object.freeze({ LANG: "C", LC_ALL: "C", TZ: "UTC" });
const setupVectors = [
  ["init", "--initial-branch=main", "--template="], ["add", "--", "notes.txt", "app.js", ".gitignore"],
  ["-c", "user.name=Twin Scenario", "-c", "user.email=twin-scenario@example.invalid", "-c", "commit.gpgSign=false",
    "-c", "core.hooksPath=/dev/null", "commit", "-m", "Establish disposable scenario baseline"],
  ["rev-parse", "--show-toplevel"], ["ls-files", "-z"], ["ls-files", "--others", "--exclude-standard", "-z"],
  ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"],
] as const;
const receiptVectors = [
  ["rev-parse", "--show-toplevel"],
  ["ls-files", "-z", "--full-name", "--cached", "--deduplicate", "--"],
  ["ls-files", "-z", "--full-name", "--others", "--exclude-standard", "--"],
  ["ls-files", "-z", "--full-name", "--others", "--ignored", "--exclude-standard", "--"],
] as const;
const pathKeys = ["notes", "app", "gitignore", "scratch", "env", "dependency", "control"] as const;
const pathByKey = { notes: "notes.txt", app: "app.js", gitignore: ".gitignore", scratch: "scratch.txt", env: ".env",
  dependency: "node_modules/lib.txt", control: "control-created.txt" } as const;
const classification = { notes: "tracked", app: "tracked", gitignore: "tracked", scratch: "untracked",
  env: "ignored", dependency: "ignored", control: "absent" } as const;
export const CORE_FINGERPRINT_MODULES = ["index.js", "twin.js", "copy.js", "run.js", "safety.js",
  "manifest.js", "git-classification.js", "watch.js", "dependencies.js", "global-npm.js", "receipt.js"] as const;
export const ADAPTER_FINGERPRINT_MODULES = ["s12-score-producer.js", "s12-score-entry.js", "runner.js", "fixture.js",
  "scenarios.js", "oracle.js", "capture/artifact.js", "capture/project.js", "capture/records.js",
  "capture/twin-s12-attempt.js", "capture/private-four-file.js", "contract/index.js", "contract/evidence-refs.js",
  "contract/oracle-schema.js", "contract/score-schema.js", "contract/normalized-evidence-schema.js",
  "contract/attempt-protocol-schema.js", "contract/s12-score-support.js", "contract/s6-score-support.js",
  "contract/normalized-evidence-validation.js", "contract/attempt-protocol-validation.js"] as const;
const coreDist = fileURLToPath(new URL("../../core/dist/", import.meta.url));
const adapterDist = fileURLToPath(new URL("../dist/", import.meta.url));
/** Fixed-order, labeled, length-delimited exact compiled bytes. */
export async function fingerprintS12LabeledFiles(base: string, labels: readonly string[]): Promise<string> {
  const hash = createHash("sha256");
  for (const label of labels) {
    const path = join(base, label), before = await fs.lstat(path);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) throw new Error("version-unavailable");
    const handle = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let bytes: Buffer;
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.nlink !== 1 || before.dev !== opened.dev || before.ino !== opened.ino) throw new Error("version-changed");
      bytes = await handle.readFile();
      const after = await handle.stat(), named = await fs.lstat(path);
      if (opened.dev !== after.dev || opened.ino !== after.ino || opened.size !== bytes.length
        || opened.mtimeMs !== after.mtimeMs || opened.ctimeMs !== after.ctimeMs
        || named.dev !== opened.dev || named.ino !== opened.ino || named.mtimeMs !== opened.mtimeMs)
        throw new Error("version-changed");
    } finally { await handle.close(); }
    const name = Buffer.from(label, "utf8"), length = Buffer.alloc(8), nameLength = Buffer.alloc(4);
    nameLength.writeUInt32BE(name.length); length.writeBigUInt64BE(BigInt(bytes.length));
    hash.update(nameLength).update(name).update(length).update(bytes);
  }
  return VersionStringSchema.parse(`fp-${hash.digest("hex")}`);
}
export async function fingerprintCompiled(kind: "core" | "adapter"): Promise<string> {
  return kind === "core" ? fingerprintS12LabeledFiles(coreDist, CORE_FINGERPRINT_MODULES)
    : fingerprintS12LabeledFiles(adapterDist, ADAPTER_FINGERPRINT_MODULES);
}
const sha = (bytes: Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");
type EventName = "fixtureReady" | "offered" | "received" | "binding" | "executionPre" | "attempted" | "started"
  | "completed" | "settled" | "executionPost" | "originalPost" | "discarded" | "originalCleanup";
/** Coordinates are assigned only when the corresponding runtime event occurs. */
export class S12RuntimeEvents {
  readonly #positions = new Map<EventName, Position>();
  #next = 0;
  #receipt: Readonly<{ requestId: string; toolRunId: string; route: "through-tool"; delivery: "received"; requestBinding: "match" }> | undefined;
  #workspace: Readonly<{ path: string; dev: number; ino: number; uid: number }> | undefined;
  record(name: EventName): Position {
    if (this.#positions.has(name)) throw new Error("duplicate-runtime-event");
    const value: Position = Object.freeze({ timestamp: Object.freeze({ status: "unknown", reason: "clock-unreliable" }),
      order: Object.freeze({ status: "known", sequence: this.#next++ }) });
    this.#positions.set(name, value);
    return value;
  }
  require(name: EventName): Position {
    const value = this.#positions.get(name);
    if (!value) throw new Error("missing-runtime-event");
    return value;
  }
  has(name: EventName): boolean { return this.#positions.has(name); }
  receive(request: AttemptRequest, offered: AttemptRequest): void {
    if (!this.has("offered") || !Object.isFrozen(request) || !Object.isFrozen(request.action) || request !== offered)
      throw new Error("request-binding-mismatch");
    this.record("received");
    this.#receipt = Object.freeze({ requestId: request.requestId, toolRunId: request.toolRunId,
      route: "through-tool", delivery: "received", requestBinding: "match" });
  }
  receipt(request: AttemptRequest) {
    if (!this.#receipt || this.#receipt.requestId !== request.requestId || this.#receipt.toolRunId !== request.toolRunId)
      throw new Error("missing-receipt");
    return this.#receipt;
  }
  bindWorkspace(path: string, identity: { dev: number; ino: number; uid: number }): void {
    this.record("binding");
    this.#workspace = Object.freeze({ path, dev: identity.dev, ino: identity.ino, uid: identity.uid });
  }
  workspace(path: string): void {
    if (!this.#workspace || this.#workspace.path !== path) throw new Error("missing-workspace-binding");
  }
}
async function deliverTwinS12Request(request: AttemptRequest, offered: AttemptRequest, events: S12RuntimeEvents,
  sourceDirectory: string, scratchParent: string): Promise<TwinSession> {
  events.receive(request, offered);
  return createTwin({ sourceDirectory, scratchParent });
}
type RootName = "direct" | "original" | "support" | "twin";
type RootState = "allocated" | "registered" | "removed" | "retained-for-investigation" | "unknown";
/** Ledger entries are never deleted or silently inferred from directory listings. */
export class S12AllocationLedger {
  readonly #states = new Map<RootName, RootState>();
  acquire(name: RootName): void {
    if (this.#states.has(name)) throw new Error("duplicate-allocation");
    this.#states.set(name, "allocated");
  }
  advance(name: RootName, state: Exclude<RootState, "allocated">): void {
    const before = this.#states.get(name);
    if (!before || !["allocated", "registered"].includes(before)) throw new Error("invalid-allocation-transition");
    if (state === "registered" && before !== "allocated") throw new Error("duplicate-registration");
    this.#states.set(name, state);
  }
  state(name: RootName): RootState | undefined { return this.#states.get(name); }
  settled(): boolean { return [...this.#states.values()].every(state => !["allocated", "registered"].includes(state)); }
  complete(): boolean { return (["direct", "original", "support", "twin"] as const).every(name => this.#states.get(name) === "removed"); }
}
const unavailable = { status: "unknown" as const, reason: "not-applicable" as const };
const yes = { status: "yes" as const }, no = { status: "no" as const };
const segment = (artifactId: string) => ({ kind: "private-artifact-segment" as const, artifactId, segmentId: "segment:observer" });
const independent = <M extends "filesystem-observation" | "process-observation">(artifactId: string, method: M) =>
  ({ kind: "independent" as const, collector: "harness" as const, method, evidenceRefs: [segment(artifactId)] });
const artifactId = () => `artifact:${randomBytes(16).toString("hex")}`;
const token = (prefix: string) => `${prefix}:${randomBytes(16).toString("hex")}`;
function ensureSnapshot(snapshot: Snapshot): void {
  assert(snapshot.complete && snapshot.paths.length === 7);
  for (const key of pathKeys) {
    const item = snapshot.paths.find(item => item.path === pathByKey[key]);
    if (key === "control") assert(item?.state === "absent");
    else { assert(item?.state === "file"); assert.equal(item.sha256, sha(fixtureContents[pathByKey[key]])); }
  }
}
async function observeWorkspace(workspace: string): Promise<Snapshot> {
  const paths: Snapshot["paths"][number][] = [];
  for (const key of pathKeys) {
    const name = pathByKey[key], path = join(workspace, name);
    try {
      const components = name.split("/"); let parent = workspace;
      for (const component of components.slice(0, -1)) { parent = join(parent, component); const s = await fs.lstat(parent); assert(s.isDirectory() && !s.isSymbolicLink()); }
      const stat = await fs.lstat(path); assert(stat.isFile() && !stat.isSymbolicLink());
      const bytes = await fs.readFile(path);
      paths.push({ path: name, state: "file", sizeBytes: bytes.length, sha256: sha(bytes) });
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") paths.push({ path: name, state: "absent" });
      else throw error;
    }
  }
  return { workspace, observedAt: new Date().toISOString(), complete: true, paths };
}
function exactEffect(before: Snapshot, after: Snapshot): void {
  ensureSnapshot(before);
  for (const key of pathKeys) {
    const a = after.paths.find(item => item.path === pathByKey[key]);
    if (key === "control") { assert(a?.state === "file"); assert.equal(a.sha256, sha("S12 control file.\n")); }
    else assert.deepEqual(a, before.paths.find(item => item.path === pathByKey[key]));
  }
}
function inside(parent: string, path: string): boolean {
  const diff = relative(parent, path); return diff === "" || (!isAbsolute(diff) && diff !== ".." && !diff.startsWith(`..${sep}`));
}
function trustedGit(): { git: string; directory: string } {
  assert(process.platform === "linux" || process.platform === "darwin"); assert(typeof process.getuid === "function");
  const git = realpathSync("/usr/bin/git"), required = new Set<string>([git]);
  for (const start of ["/usr/bin/git", git]) for (let current = dirname(start); ; current = dirname(current)) {
    required.add(current); if (current === dirname(current)) break;
  }
  for (const path of required) {
    const stat = lstatSync(path); assert.equal(stat.uid, 0); assert.equal(stat.mode & 0o022, 0);
    assert(path === git ? stat.isFile() : stat.isDirectory());
    if (path === git) { assert.equal(realpathSync(path), git); accessSync(path, constants.X_OK); }
  }
  const directory = dirname(git); assert.equal(realpathSync(join(directory, "git")), git);
  return { git, directory };
}
function setupEnv(directory: string): Record<string, string> { return { PATH: directory, ...actionEnv, GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_GLOBAL: "/dev/null", GIT_ATTR_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0",
  GIT_CONFIG_COUNT: "4", GIT_CONFIG_KEY_0: "core.hooksPath", GIT_CONFIG_VALUE_0: "/dev/null", GIT_CONFIG_KEY_1: "core.excludesFile",
  GIT_CONFIG_VALUE_1: "/dev/null", GIT_CONFIG_KEY_2: "core.attributesFile", GIT_CONFIG_VALUE_2: "/dev/null",
  GIT_CONFIG_KEY_3: "commit.gpgSign", GIT_CONFIG_VALUE_3: "false" }; }
interface Gate { phase: "closed" | "reference" | "setup" | "action"; setupIndex: number; directIndex: number; actionCount: number;
  receiptPhase: "closed" | "before" | "after"; receiptCount: number; twinAllocations: number; scratch?: string; expectedTwin?: string;
  original?: string; twin?: string; actionPath?: string; actionIdentity?: { dev: number; ino: number; uid: number };
  events: S12RuntimeEvents; directAdmission?: S12DirectAdmission; }
function assertActionAsset(path: string, expected: { dev: number; ino: number; uid: number }): void {
  const named = lstatSync(path);
  assert(named.isFile() && !named.isSymbolicLink() && named.nlink === 1 && (named.mode & 0o7777) === 0o600);
  assert.equal(named.dev, expected.dev); assert.equal(named.ino, expected.ino); assert.equal(named.uid, expected.uid);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd);
    assert(opened.isFile() && opened.nlink === 1 && opened.dev === named.dev && opened.ino === named.ino);
    assert.equal(readFileSync(fd, "utf8"), actionBody);
  } finally { closeSync(fd); }
}
interface CompiledIdentity { dev: number; ino: number; uid: number; size: number; sha256: string; mode: number }
function compiledActionIdentity(path: string, expected?: CompiledIdentity): CompiledIdentity {
  const named = lstatSync(path);
  assert(named.isFile() && !named.isSymbolicLink() && named.nlink === 1 && (named.mode & 0o022) === 0);
  assert.equal(named.uid, process.getuid?.());
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd);
    assert(opened.isFile() && opened.nlink === 1 && opened.dev === named.dev && opened.ino === named.ino);
    const bytes = readFileSync(fd);
    const after = fstatSync(fd);
    assert.equal(after.dev, opened.dev); assert.equal(after.ino, opened.ino);
    assert.equal(after.size, opened.size); assert.equal(after.mtimeMs, opened.mtimeMs); assert.equal(after.ctimeMs, opened.ctimeMs);
    assert.equal(bytes.toString("utf8"), actionBody);
    const identity = { dev: opened.dev, ino: opened.ino, uid: opened.uid, size: opened.size,
      sha256: sha(bytes), mode: opened.mode & 0o7777 };
    if (expected) assert.deepEqual(identity, expected);
    return identity;
  } finally { closeSync(fd); }
}
function directCwd(attestation: RegisteredScenarioRootAttestation | undefined, cwd: string): void {
  assert(attestation, "missing-registered-fixture-attestation");
  assert.equal(attestation.attestationVersion, 1); assert.equal(attestation.type, "directory");
  assert.equal(cwd, attestation.workspacePath);
  const base = realpathSync(tmpdir()), root = dirname(cwd);
  assert.equal(dirname(root), base); assert(basename(root).startsWith("twin-scenario-"));
  assert.equal(basename(cwd), "workspace");
  assert.equal(realpathSync(root), root); assert.equal(realpathSync(cwd), cwd);
  const rootStat = lstatSync(root), current = lstatSync(cwd), markerPath = join(root, ".twin-scenario-root");
  const marker = lstatSync(markerPath);
  assert(rootStat.isDirectory() && !rootStat.isSymbolicLink() && current.isDirectory() && !current.isSymbolicLink());
  assert.equal(rootStat.dev, attestation.rootDev); assert.equal(rootStat.ino, attestation.rootIno);
  assert.equal(current.dev, attestation.dev); assert.equal(current.ino, attestation.ino);
  assert.equal(rootStat.uid, attestation.uid); assert.equal(current.uid, attestation.uid);
  assert.equal(attestation.uid, process.getuid?.());
  assert(marker.isFile() && !marker.isSymbolicLink() && marker.nlink === 1 && (marker.mode & 0o7777) === 0o600);
  assert.equal(marker.uid, attestation.uid); assert.equal(marker.dev, attestation.markerDev); assert.equal(marker.ino, attestation.markerIno);
  const fd = openSync(markerPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd);
    assert(opened.isFile() && opened.nlink === 1 && (opened.mode & 0o7777) === 0o600);
    assert.equal(opened.dev, marker.dev); assert.equal(opened.ino, marker.ino); assert.equal(opened.uid, attestation.uid);
    assert.equal(sha(readFileSync(fd)), attestation.markerSha256);
  } finally { closeSync(fd); }
}
/** Narrow admission state shared by the real guard and synthetic no-child controls. */
export class S12DirectAdmission {
  #attestation: RegisteredScenarioRootAttestation | undefined;
  readonly #assetPath: string;
  readonly #identity: CompiledIdentity;
  #used = false;
  constructor(assetPath: string) { this.#assetPath = assetPath; this.#identity = compiledActionIdentity(assetPath); }
  get boundCwd(): string | undefined { return this.#attestation?.workspacePath; }
  arm(attestation: RegisteredScenarioRootAttestation): void {
    if (this.#attestation) throw new Error("duplicate-registered-fixture-attestation");
    if (!Object.isFrozen(attestation) || Reflect.ownKeys(attestation).length !== 11) throw new Error("invalid-fixture-attestation");
    directCwd(attestation, attestation.workspacePath);
    this.#attestation = attestation;
  }
  firstSetup(cwd: string): void { directCwd(this.#attestation, cwd); }
  laterSetup(cwd: string): void { directCwd(this.#attestation, cwd); }
  action(cwd: string): void {
    if (this.#used) throw new Error("repeat-direct-action");
    directCwd(this.#attestation, cwd);
    compiledActionIdentity(this.#assetPath, this.#identity);
    this.#used = true;
  }
}
function installGate(state: Gate, git: { git: string; directory: string }, compiledActionPath: string): () => void {
  const originalSpawn = childProcess.spawn;
  const originalExecFile = childProcess.execFile, originalMkdtemp = fs.mkdtemp;
  const saved = new Map<string, unknown>();
  for (const name of ["exec", "execFile", "fork", "execSync", "execFileSync", "spawnSync"]) {
    saved.set(name, Reflect.get(childProcess, name));
    Reflect.set(childProcess, name, () => { throw new Error("alternate-child-api"); });
  }
  Reflect.set(fs, "mkdtemp", async (...args: Parameters<typeof fs.mkdtemp>) => {
    if (state.scratch && args[0] === join(state.scratch, "twin-core-")) {
      assert.equal(state.twinAllocations, 0, "Only one Twin allocation permitted");
      const root = await originalMkdtemp(...args);
      state.expectedTwin = join(root, "workspace"); state.twinAllocations++;
      return root;
    }
    return originalMkdtemp(...args);
  });
  Reflect.set(childProcess, "execFile", (file: unknown, argv: unknown, options: unknown, callback: unknown) => {
    const ordinal = state.receiptCount;
    assert(ordinal < 8 && state.receiptPhase === (ordinal < 4 ? "before" : "after"), "Receipt Git outside fixed phase");
    if (state.receiptPhase === "after") assert.equal(state.actionCount, 1);
    assert.equal(file, "/usr/bin/git"); assert.equal(git.git, file);
    assert(Array.isArray(argv) && Object.getPrototypeOf(argv) === Array.prototype);
    const expectedArgv = ["--no-optional-locks", "-c", "core.fsmonitor=false", ...receiptVectors[ordinal % 4]!];
    assert.deepEqual(argv, expectedArgv);
    assert(options && typeof options === "object" && Object.getPrototypeOf(options) === Object.prototype);
    const actual = options as Record<string, unknown>;
    assert.deepEqual(Reflect.ownKeys(actual).sort(), ["cwd", "encoding", "env", "maxBuffer", "shell", "timeout", "windowsHide"]);
    assert(state.expectedTwin); assert.equal(actual.cwd, state.expectedTwin);
    const environment = { PATH: "", HOME: "/nonexistent", LC_ALL: "C", GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null", GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0",
      GIT_CEILING_DIRECTORIES: dirname(state.expectedTwin) };
    assert(actual.env && typeof actual.env === "object" && Object.getPrototypeOf(actual.env) === Object.prototype);
    assert.deepEqual(actual.env, environment);
    assert.equal(actual.encoding, "buffer"); assert.equal(actual.maxBuffer, 16 * 1024 * 1024);
    assert.equal(actual.timeout, 5000); assert.equal(actual.shell, false); assert.equal(actual.windowsHide, true);
    assert.equal(typeof callback, "function");
    const child = Reflect.apply(originalExecFile, childProcess, [file, expectedArgv, {
      cwd: state.expectedTwin, env: environment, encoding: "buffer", maxBuffer: 16 * 1024 * 1024,
      timeout: 5000, shell: false, windowsHide: true }, callback]);
    state.receiptCount++;
    return child;
  });
  Reflect.set(childProcess, "spawn", (command: unknown, argv: unknown, options: unknown) => {
    assert(typeof command === "string" && Array.isArray(argv) && options && typeof options === "object");
    const args = [...argv]; assert(args.every(arg => typeof arg === "string"));
    const object = options as Record<string, unknown>;
    assert(Reflect.ownKeys(object).every(key => typeof key === "string" && ["cwd", "shell", "env", "stdio", "detached"].includes(key)));
    const cwd = object.cwd, shell = object.shell, detached = object.detached;
    const env = object.env; assert(env && typeof env === "object" && !Array.isArray(env));
    const copiedEnv = Object.fromEntries(Object.entries(env));
    const stdio = object.stdio; assert(Array.isArray(stdio) && JSON.stringify([...stdio]) === JSON.stringify(["ignore", "pipe", "pipe"]));
    assert(shell === false && (detached === false || detached === undefined) && typeof cwd === "string");
    const setup = state.phase === "reference" || state.phase === "setup";
    if (setup && command === "git") {
      const index = state.phase === "reference" ? state.directIndex++ : state.setupIndex++;
      assert.deepEqual(args, setupVectors[index]);
      if (state.phase === "setup") assert.equal(cwd, state.original);
      else if (index === 0) state.directAdmission!.firstSetup(cwd);
      else state.directAdmission!.laterSetup(cwd);
      assert.deepEqual(copiedEnv, setupEnv(git.directory));
      command = git.git;
    } else if (state.phase === "reference") {
      assert.equal(command, process.execPath); assert.deepEqual(args, [compiledActionPath]); assert.equal(state.directIndex++, 7);
      assert.deepEqual(copiedEnv, setupEnv(git.directory));
      state.directAdmission!.action(cwd);
    } else {
      assert.equal(state.phase, "action"); assert.equal(command, process.execPath); assert.deepEqual(args, [state.actionPath]);
      assert.equal(cwd, state.twin); assert.deepEqual(copiedEnv, actionEnv); assert.equal(state.actionCount++, 0);
      assertActionAsset(state.actionPath!, state.actionIdentity!);
    }
    if (state.phase === "action") state.events.record("attempted");
    const child = originalSpawn(command as string, [...args], { cwd, shell: false, detached: false,
      env: { ...copiedEnv } as Record<string, string>, stdio: ["ignore", "pipe", "pipe"] });
    if (state.phase === "action") child.once("spawn", () => { state.events.record("started"); });
    return child;
  });
  syncBuiltinESMExports();
  return () => { Reflect.set(childProcess, "spawn", originalSpawn); for (const [name, value] of saved) Reflect.set(childProcess, name, value);
    Reflect.set(fs, "mkdtemp", originalMkdtemp); syncBuiltinESMExports(); };
}
function fact(snapshot: Snapshot, stage: "before" | "after", key: typeof pathKeys[number], id: string, artifact: string, at: Position): OriginalStateObservation {
  const item = snapshot.paths.find(value => value.path === pathByKey[key]); assert(item);
  return { toolRunId: id, scenarioId: "S12", factId: `fact:original_${stage}_${key}`, kind: "original-state-observation", pathKey: key,
    stage, position: at, state: { status: item.state === "file" ? "file" : "absent" },
    hash: item.state === "file" ? { status: "known", sha256: item.sha256 } : unavailable,
    provenance: independent(artifact, "filesystem-observation") };
}
function workspaceFact(snapshot: Snapshot, stage: "before" | "after", key: typeof pathKeys[number], id: string,
  requestId: string, workspaceId: string, artifact: string, at: Position): WorkspaceStateObservation {
  const item = snapshot.paths.find(value => value.path === pathByKey[key]); assert(item);
  return { toolRunId: id, scenarioId: "S12", requestId, observationId: `observation:workspace_${stage}_${key}`, workspaceId,
    stage, position: at, pathKey: key, state: { status: item.state === "file" ? "file" : "absent" },
    hash: item.state === "file" ? { status: "known", sha256: item.sha256 } : unavailable,
    sizeBytes: item.state === "file" ? { status: "known", sizeBytes: item.sizeBytes } : unavailable,
    classification: item.state === "file" ? { status: key === "control" ? "untracked" : classification[key] } : { status: "absent" },
    provenance: independent(artifact, "filesystem-observation") };
}
function buildBundle(input: { reference: NonNullable<Extract<Awaited<ReturnType<typeof inspectArtifact>>, { status: "complete" }>["referenceOracle"]>;
  artifactId: string; toolRunId: string; requestId: string; originalBefore: Snapshot; originalAfter: Snapshot;
  twinBefore: Snapshot; twinAfter: Snapshot; result: RunResult; toolVersion: string; adapterVersion: string;
  request: AttemptRequest; events: S12RuntimeEvents; executionWorkspacePath: string; }): ToolAttemptBundle {
  const { reference, artifactId: aid, toolRunId: id, requestId, result } = input;
  const at = (name: EventName) => input.events.require(name);
  const originalId = "workspace:original", twinId = "workspace:twin", observer = segment(aid);
  const tool = { name: "twin", version: { status: "known" as const, version: input.toolVersion } };
  const adapter = { name: "twin-s12", version: { status: "known" as const, version: input.adapterVersion } };
  const request = input.request;
  const receipt = input.events.receipt(request);
  input.events.workspace(input.executionWorkspacePath);
  const originals = [...pathKeys.map(key => fact(input.originalBefore, "before", key, id, aid, at("fixtureReady"))),
    ...pathKeys.map(key => fact(input.originalAfter, "after", key, id, aid, at("originalPost")))];
  const execution = { toolRunId: id, scenarioId: "S12" as const, factId: "fact:action", kind: "execution" as const,
    actionId: "create-control-file" as const, attempted: yes, started: yes, blocked: no, completed: yes,
    attemptedAt: at("attempted"), startedAt: at("started"), blockedAt: { timestamp: unavailable, order: unavailable },
    completedAt: at("completed"), exitCode: { status: "known" as const, exitCode: result.exitCode }, signal: { status: "known" as const, signal: null },
    provenance: independent(aid, "process-observation") };
  const states = [...pathKeys.map(key => workspaceFact(input.twinBefore, "before", key, id, requestId, twinId, aid, at("executionPre"))),
    ...pathKeys.map(key => workspaceFact(input.twinAfter, "after", key, id, requestId, twinId, aid, at("executionPost")))];
  const setup = { toolRunId: id, scenarioId: "S12" as const, requestId, observationId: "observation:setup", position: at("fixtureReady"),
    fixtureId: "s12-s6-fixture-v1" as const, originalWorkspaceId: originalId, repository: yes, nonBare: yes, rootMatches: yes,
    baselineCommit: yes, indexMatches: yes, trackedTreeMatches: yes, noExtraEntries: yes,
    paths: pathKeys.map(key => ({ pathKey: key, originalFactId: `fact:original_before_${key}`,
      sizeBytes: key === "control" ? unavailable : { status: "known" as const, sizeBytes: Buffer.byteLength(fixtureContents[pathByKey[key]]) },
      classification: { status: classification[key] } })), provenance: independent(aid, "filesystem-observation") };
  const binding = { toolRunId: id, scenarioId: "S12" as const, requestId, observationId: "observation:binding", position: at("binding"),
    originalWorkspaceId: originalId, executionWorkspace: { status: "identified" as const, workspaceId: twinId },
    relationship: { status: "tool-prepared-workspace" as const }, preparation: { status: "tool" as const }, repository: yes,
    nonBare: yes, rootMatches: yes, provenance: independent(aid, "filesystem-observation") };
  const boundary = { toolRunId: id, scenarioId: "S12" as const, requestId, observationId: "observation:boundary",
    tool, adapter, offeredAt: at("offered"), receivedAt: at("received"), settledAt: at("settled"),
    route: { status: receipt.route }, delivery: { status: receipt.delivery }, requestBinding: { status: receipt.requestBinding },
    wrapperLaunch: { status: "not-required" as const }, response: { status: "accepted" as const }, responseReason: { status: "none" as const },
    actionObservation: { status: "known" as const, factId: "fact:action" }, coverage: { status: "complete" as const },
    provenance: independent(aid, "process-observation") };
  const disposition = { toolRunId: id, scenarioId: "S12" as const, requestId,
    cleanup: { status: "removed" as const, reason: "cleanup-completed" as const, position: at("originalCleanup"), evidenceRefs: [observer] },
    artifacts: { status: "unknown" as const, reason: "not-observed" as const, evidenceRefs: [observer] } };
  const capture = (channel: "stdout" | "stderr") => ({ toolRunId: id, scenarioId: "S12" as const,
    captureId: `capture:${channel}`, channel, capture: { status: "complete" as const },
    interpretation: { status: "not-performed" as const, reason: "not-captured" as const } });
  const segmentFor = (channel: "observer-record" | "stdout" | "stderr") => ({ toolRunId: id, scenarioId: "S12" as const,
    artifactId: aid, segmentId: `segment:${channel === "observer-record" ? "observer" : channel}`, channel,
    capture: channel === "observer-record" ? { kind: "none" as const } : { kind: "capture" as const, captureId: `capture:${channel}` },
    privateReference: yes, redaction: { status: "withheld" as const, reason: "private-only" as const },
    publicVerifiability: { status: "not-publicly-verifiable" as const, reason: "private-only" as const } });
  const normalizedEvidence: NormalizedToolEvidence = { schemaVersion: 1, toolRunId: id, scenarioId: "S12",
    sources: { referenceAccident: { status: "declared", relationship: "reference-accident", scenarioId: "S12",
      sourceRunId: reference.sourceRunId, oracleVersion: 1 }, sameExecution: { status: "none", reason: "not-captured" } },
    tool, adapter, startedAt: { status: "unknown", reason: "clock-unreliable" }, endedAt: { status: "unknown", reason: "clock-unreliable" },
    facts: [...originals, execution], declaredCapabilities: [], reporting: { stdout: { status: "applicable", captureId: "capture:stdout" },
      stderr: { status: "applicable", captureId: "capture:stderr" }, log: { status: "unknown", reason: "not-observed" },
      receipt: { status: "unknown", reason: "not-observed" } }, reportCaptures: [capture("stdout"), capture("stderr")],
    segments: [segmentFor("observer-record"), segmentFor("stdout"), segmentFor("stderr")],
    availability: { originalState: { status: "available" }, reportedEvents: { status: "unavailable", reason: "not-captured" },
      execution: { status: "available" }, workspaceInputs: { status: "unavailable", reason: "not-applicable" },
      boundaryObservations: { status: "unavailable", reason: "not-captured" }, declaredCapabilities: { status: "unavailable", reason: "not-captured" } } };
  return { schemaVersion: 1, protocolVersion: 1, request, referenceOracle: reference, normalizedEvidence,
    protocolObservations: { setup: [setup], workspaceBindings: [binding], toolBoundaries: [boundary], workspaceStates: states,
      sourceBindings: [], disposition } };
}
function incomplete(stage: S12FailureStage, reason: S12FailureReason): S12ScoreResult {
  return S12ScoreResultSchema.parse({ schemaVersion: 1, resultVersion: 1, status: "incomplete", scenarioId: "S12", stage, reason, identities: {} });
}
export function s12ReferenceFailure(oracle: Pick<OracleResult, "validity" | "scoreEligibility">,
  cleanupStatus: string, issueCount: number): S12FailureReason | null {
  if (oracle.validity !== "valid") return "reference-invalid";
  if (oracle.scoreEligibility !== "eligible" || cleanupStatus !== "removed" || issueCount !== 0) return "reference-ineligible";
  return null;
}
export function finalizeS12ScoreCandidate(candidate: S12ScoreResult | undefined, ledger: S12AllocationLedger,
  errorCount: number, stage: S12FailureStage, reason: S12FailureReason): S12ScoreResult {
  if (candidate?.status === "complete" && !ledger.complete()) return incomplete("accounting", "accounting-incomplete");
  return errorCount || !candidate ? incomplete(stage, reason) : candidate;
}
/** One serial, fixed-action S12 comparison. Artifacts are retained; fixture roots are removed. */
export async function produceTwinS12Score(options: Readonly<{ artifactParentDirectory: string }>): Promise<S12ScoreResult> {
  let stage: S12FailureStage = "preflight", failure: S12FailureReason = "operation-failed";
  let original: OwnedScenarioRoot | undefined, originalBefore: Snapshot | undefined, originalAfter: Snapshot | undefined;
  let session: TwinSession | undefined, support: string | undefined, supportMarker: string | undefined;
  let restoreGate: (() => void) | undefined, priorPath: string | undefined, pathChanged = false;
  let supportIdentity: { dev: number; ino: number; uid: number } | undefined;
  let complete: S12ScoreResult | undefined;
  const errors: unknown[] = [];
  const events = new S12RuntimeEvents(), ledger = new S12AllocationLedger();
  const gate: Gate = { phase: "closed", setupIndex: 0, directIndex: 0, actionCount: 0,
    receiptPhase: "closed", receiptCount: 0, twinAllocations: 0, events };
  try {
    if (!await validateTwinS12ArtifactParent(options.artifactParentDirectory)) { failure = "unsafe-destination"; throw new Error(); }
    const repo = realpathSync(fileURLToPath(new URL("../../../", import.meta.url)));
    const parent = realpathSync(options.artifactParentDirectory);
    if (inside(repo, parent) || inside(realpathSync(homedir()), parent)) { failure = "unsafe-destination"; throw new Error(); }
    const git = trustedGit(), compiledAction = fileURLToPath(new URL("../dist/actions/create-file.js", import.meta.url));
    gate.directAdmission = new S12DirectAdmission(compiledAction);
    const initialCoreVersion = await fingerprintCompiled("core"), initialAdapterVersion = await fingerprintCompiled("adapter");
    const oldPath = process.env.PATH; priorPath = oldPath; process.env.PATH = git.directory; pathChanged = true;
    restoreGate = installGate(gate, git, compiledAction);
    stage = "reference-execution"; gate.phase = "reference"; ledger.acquire("direct");
    const raw = await runScenarioWithRegisteredRootObserver("S12", attestation => {
      assert.equal(gate.phase, "reference"); assert.equal(gate.directIndex, 0);
      gate.directAdmission!.arm(attestation);
    }); gate.phase = "closed";
    ledger.advance("direct", raw.cleanup.status === "removed" ? "removed" : "unknown");
    assert.equal(gate.directIndex, 8);
    assert.equal(raw.workspace, gate.directAdmission?.boundCwd);
    assert.equal(raw.scenarioRoot, dirname(gate.directAdmission!.boundCwd!));
    stage = "reference-oracle";
    const oracle = evaluateScenarioOracle(raw, { schemaVersion: 1, scenarioId: "S12",
      s12Action: { executable: process.execPath, scriptPath: compiledAction } });
    const referenceFailure = s12ReferenceFailure(oracle, raw.cleanup.status, raw.issues.length);
    if (referenceFailure) { failure = referenceFailure; throw new Error(); }
    stage = "reference-retention";
    const refArtifactId = artifactId(), referenceId = token("reference"), absent = { status: "not-started" as const, reason: "not-requested" as const };
    const reference = await retainArtifact(parent, { privateFormatVersion: 1, normalizerVersion: 1, kind: "reference-only",
      reservation: { privateFormatVersion: 1, normalizerVersion: 1, artifactId: refArtifactId, referenceId, attempt: absent },
      capture: { privateFormatVersion: 1, normalizerVersion: 1, artifactId: refArtifactId,
        reference: { referenceId, raw: { ...raw, setupCommands: raw.setupCommands.map(item => ({ ...item,
          command: { executable: item.command.executable, args: [...item.command.args] }, streamErrors: [...item.streamErrors] })),
          action: raw.action && { ...raw.action, command: { executable: raw.action.command.executable,
            args: [...raw.action.command.args] }, streamErrors: [...raw.action.streamErrors] },
          before: raw.before && { ...raw.before, paths: [...raw.before.paths] },
          after: raw.after && { ...raw.after, paths: [...raw.after.paths] }, issues: [...raw.issues] },
          context: { schemaVersion: 1, scenarioId: "S12", s12Action: { executable: process.execPath, scriptPath: compiledAction } } }, attempt: absent },
      outcome: { privateFormatVersion: 1, normalizerVersion: 1, artifactId: refArtifactId, attempt: absent, errors: [] } });
    if (!reference.directory || reference.inspection.status !== "complete") { failure = "retention-incomplete"; throw new Error(); }
    stage = "reference-reopen";
    const refOpen = await inspectArtifact(reference.directory);
    if (refOpen.status !== "complete" || refOpen.kind !== "reference-only" || refOpen.referenceOracle.validity !== "valid"
      || refOpen.referenceOracle.scoreEligibility !== "eligible") { failure = "retention-incomplete"; throw new Error(); }
    const reopenedOracle = refOpen.referenceOracle;
    stage = "attempt-setup";
    const base = realpathSync(tmpdir());
    support = await fs.mkdtemp(join(base, "twin-test-s12-score-")); ledger.acquire("support");
    supportMarker = randomBytes(32).toString("hex");
    const registered = await fs.lstat(support); supportIdentity = { dev: registered.dev, ino: registered.ino, uid: registered.uid };
    ledger.advance("support", "registered");
    await fs.chmod(support, 0o700); await fs.writeFile(join(support, ".owner"), supportMarker, { flag: "wx", mode: 0o600 });
    await fs.mkdir(join(support, "scratch"), { mode: 0o700 }); await fs.mkdir(join(support, "actions"), { mode: 0o700 });
    const actionPath = join(support, "actions/create-file.mjs"); await fs.writeFile(actionPath, actionBody, { flag: "wx", mode: 0o600 });
    const actionStat = await fs.lstat(actionPath); gate.actionIdentity = { dev: actionStat.dev, ino: actionStat.ino, uid: actionStat.uid };
    assertActionAsset(actionPath, gate.actionIdentity);
    original = await createScenarioRoot(); ledger.acquire("original");
    const originalStat = await fs.lstat(original.scenarioRoot);
    assert(originalStat.isDirectory() && !originalStat.isSymbolicLink() && originalStat.uid === process.getuid?.());
    ledger.advance("original", "registered");
    await initializeScenarioRoot(original);
    const workspace = (await verifyWorkspace(original)).workspace; gate.original = workspace;
    gate.phase = "setup"; const setup: CommandEvidence[] = []; await initializeFixture(original, setup); gate.phase = "closed";
    assert.equal(gate.setupIndex, 7); originalBefore = await observePaths(original, getScenario("S12").observedPaths); ensureSnapshot(originalBefore);
    events.record("fixtureReady");
    const twinArtifactId = artifactId(), toolRunId = token("toolrun"), requestId = token("request");
    const toolVersion = await fingerprintCompiled("core"), adapterVersion = await fingerprintCompiled("adapter");
    assert.equal(toolVersion, initialCoreVersion); assert.equal(adapterVersion, initialAdapterVersion);
    const request = AttemptRequestSchema.parse({ schemaVersion: 1, requestVersion: 1, toolRunId, scenarioId: "S12", requestId,
      fixtureId: "s12-s6-fixture-v1", action: { actionId: "create-control-file", actionVersion: 1,
        target: "control", purpose: "harmless-control", operation: "exclusive-create", contentId: "s12-control-bytes-v1" } });
    Object.freeze(request.action); Object.freeze(request);
    events.record("offered");
    ledger.acquire("twin");
    gate.scratch = join(support, "scratch"); gate.receiptPhase = "before";
    try { session = await deliverTwinS12Request(request, request, events, workspace, gate.scratch); }
    finally { gate.receiptPhase = "closed"; }
    assert.equal(gate.twinAllocations, 1); assert.equal(gate.receiptCount, 4);
    assert.equal(session.workspacePath, gate.expectedTwin);
    gate.twin = session.workspacePath; gate.actionPath = actionPath;
    const twinStat = await fs.lstat(session.workspacePath);
    assert(twinStat.isDirectory() && !twinStat.isSymbolicLink() && await fs.realpath(session.workspacePath) === session.workspacePath);
    ledger.advance("twin", "registered");
    events.bindWorkspace(session.workspacePath, { dev: twinStat.dev, ino: twinStat.ino, uid: twinStat.uid });
    const twinBefore = await observeWorkspace(session.workspacePath); ensureSnapshot(twinBefore); events.record("executionPre");
    stage = "attempt-execution"; gate.phase = "action"; gate.receiptPhase = "after";
    let result: RunResult;
    try { result = await session.run({ executable: process.execPath, argv: [actionPath], env: actionEnv, timeoutMs: 5000 }); }
    finally { gate.phase = "closed"; gate.receiptPhase = "closed"; }
    assert.equal(gate.actionCount, 1); assert.equal(gate.receiptCount, 8);
    assert(result.outcome === "exited" && result.started && result.directChildSettled && result.exitCode === 0
      && result.signal === null && result.spawnError === null && result.terminationError === null
      && result.stdout.complete && result.stderr.complete && !result.stdout.truncated && !result.stderr.truncated
      && result.stdout.error === null && result.stderr.error === null && result.stdout.bytes.length === 0 && result.stderr.bytes.length === 0);
    if (!events.has("started")) { failure = "action-incomplete"; throw new Error(); }
    events.record("completed"); events.record("settled");
    const twinAfter = await observeWorkspace(session.workspacePath); exactEffect(twinBefore, twinAfter); events.record("executionPost");
    originalAfter = await observePaths(original, getScenario("S12").observedPaths); ensureSnapshot(originalAfter); events.record("originalPost");
    assert.deepEqual(originalAfter.paths, originalBefore.paths);
    const endingSession = session; session = undefined;
    const discard = await endingSession.discard();
    ledger.advance("twin", discard.status === "removed" ? "removed" : "unknown");
    assert.equal(discard.status, "removed"); events.record("discarded");
    const endingOriginal = original; original = undefined;
    const originalCleanup = await cleanupScenarioRoot(endingOriginal, originalAfter);
    ledger.advance("original", originalCleanup.status === "removed" ? "removed" : "unknown");
    assert.equal(originalCleanup.status, "removed"); events.record("originalCleanup");
    stage = "attempt-validation";
    const bundle = buildBundle({ reference: reopenedOracle, artifactId: twinArtifactId, toolRunId, requestId,
      originalBefore, originalAfter, twinBefore, twinAfter, result, toolVersion, adapterVersion,
      request, events, executionWorkspacePath: gate.twin! });
    const normalized = validateNormalizedToolEvidence(bundle.normalizedEvidence), protocol = validateToolAttemptBundle(bundle);
    if (!normalized.success) { failure = "normalized-invalid"; throw new Error(); }
    if (!protocol.success || protocol.result.attemptValidity !== "valid" || protocol.result.scoreReadiness !== "ready") {
      failure = protocol.success && protocol.result.attemptValidity === "valid" ? "attempt-not-ready" : "attempt-invalid"; throw new Error();
    }
    stage = "attempt-retention";
    if (await fingerprintCompiled("core") !== toolVersion || await fingerprintCompiled("adapter") !== adapterVersion) {
      failure = "identity-mismatch"; throw new Error();
    }
    const bytes = (value: Uint8Array) => ({ encoding: "base64" as const, data: Buffer.from(value).toString("base64"), decodedBytes: value.length });
    const records: TwinS12AttemptRecords = { identity: { formatVersion: 1, artifactKind: "twin-s12-attempt", artifactId: twinArtifactId,
      request: bundle.request, referenceArtifactId: refArtifactId, oracleRunId: reopenedOracle.sourceRunId,
      executionWorkspacePath: gate.twin!, fixedActionPath: actionPath },
      attempt: { formatVersion: 1, artifactKind: "twin-s12-attempt", artifactId: twinArtifactId, bundle,
        binding: { executable: process.execPath, argv: [actionPath], actionPath, cwd: gate.twin,
          executionWorkspacePath: gate.twin, shell: false,
          stdio: ["ignore", "pipe", "pipe"], env: actionEnv, timeoutMs: 5000, actionSha256: sha(actionBody), observerSegmentId: "segment:observer" },
        run: { ...result, stdout: { ...result.stdout, bytes: bytes(result.stdout.bytes) },
          stderr: { ...result.stderr, bytes: bytes(result.stderr.bytes) } }, toolVersion, adapterVersion },
      outcome: { formatVersion: 1, artifactKind: "twin-s12-attempt", artifactId: twinArtifactId,
        twinDiscard: "removed", originalCleanup: "removed", artifactBeforePublication: "unknown", artifactReason: "not-observed",
        disposition: bundle.protocolObservations.disposition } };
    const retained = await retainTwinS12Attempt(parent, records);
    if (!retained.directory || retained.inspection.status !== "complete") { failure = "retention-incomplete"; throw new Error(); }
    stage = "attempt-reopen"; const reopened = await inspectTwinS12Attempt(retained.directory);
    const projection = reopened.status === "complete" ? projectReopenedTwinS12Attempt(reopened.handle) : null;
    if (!projection || projection.protocol.attemptValidity !== "valid" || projection.protocol.scoreReadiness !== "ready") {
      failure = "retention-incomplete"; throw new Error();
    }
    stage = "score-support";
    const source = { reference: reopenedOracle, referenceArtifactId: refArtifactId, attemptArtifactId: twinArtifactId,
      bundle: projection.bundle, protocol: projection.protocol };
    const supportScore = deriveS12ScoreSupport(source), checked = validateS12ScoreSupport(supportScore, source);
    if (!checked.success) { failure = "support-unresolved"; throw new Error(); }
    complete = S12ScoreResultSchema.parse({ schemaVersion: 1, resultVersion: 1, status: "complete", scenarioId: "S12",
      reference: { artifactId: refArtifactId, oracleRunId: reopenedOracle.sourceRunId, oracleVersion: 1,
        validity: "valid", scoreEligibility: "eligible", retention: "retained" },
      attempt: { artifactId: twinArtifactId, toolRunId, requestId, protocolVersion: 1,
        attemptValidity: "valid", scoreReadiness: "ready", retention: "retained" },
      tool: bundle.normalizedEvidence.tool, adapter: bundle.normalizedEvidence.adapter, scoreSupport: checked.support });
  } catch (error) { errors.push(error); }
  finally {
    gate.phase = "closed"; gate.receiptPhase = "closed";
    if (session) try {
      const endingSession = session; session = undefined;
      const result = await endingSession.discard();
      ledger.advance("twin", result.status === "removed" ? "removed" : "unknown");
      if (result.status !== "removed") { stage = "cleanup"; failure = "cleanup-incomplete"; errors.push(new Error()); }
    } catch (error) { ledger.advance("twin", "unknown"); stage = "cleanup"; failure = "cleanup-incomplete"; errors.push(error); }
    if (original) try {
      const endingOriginal = original; original = undefined;
      const fresh = await observePaths(endingOriginal, getScenario("S12").observedPaths);
      const result = await cleanupScenarioRoot(endingOriginal, fresh);
      ledger.advance("original", result.status === "removed" ? "removed" : "unknown");
      if (result.status !== "removed") { stage = "cleanup"; failure = "cleanup-incomplete"; errors.push(new Error()); }
    } catch (error) { ledger.advance("original", "unknown"); stage = "cleanup"; failure = "cleanup-incomplete"; errors.push(error); }
    if (support) try {
      if (!supportIdentity) throw new Error("unregistered-support-root");
      const current = await fs.lstat(support); assert(current.isDirectory() && !current.isSymbolicLink());
      assert.equal(current.dev, supportIdentity?.dev); assert.equal(current.ino, supportIdentity?.ino); assert.equal(current.uid, supportIdentity?.uid);
      assert.equal(await fs.realpath(support), support); assert.equal(current.mode & 0o7777, 0o700);
      const ownerFile = await fs.lstat(join(support, ".owner"));
      assert(ownerFile.isFile() && !ownerFile.isSymbolicLink() && ownerFile.nlink === 1 && (ownerFile.mode & 0o7777) === 0o600);
      assert.equal(await fs.readFile(join(support, ".owner"), "utf8"), supportMarker);
      assert.deepEqual(await fs.readdir(join(support, "scratch")), []);
      assert.deepEqual(await fs.readdir(join(support, "actions")), ["create-file.mjs"]);
      for (const name of ["scratch", "actions"]) {
        const childStat: import("node:fs").Stats = await fs.lstat(join(support, name)); assert(childStat.isDirectory() && !childStat.isSymbolicLink());
        assert.equal(childStat.uid, supportIdentity?.uid); assert.equal(childStat.mode & 0o7777, 0o700);
      }
      assertActionAsset(join(support, "actions/create-file.mjs"), gate.actionIdentity!);
      await fs.unlink(join(support, "actions/create-file.mjs")); await fs.rmdir(join(support, "actions"));
      await fs.rmdir(join(support, "scratch")); await fs.unlink(join(support, ".owner")); await fs.rmdir(support);
      ledger.advance("support", "removed");
    } catch (error) { ledger.advance("support", "unknown"); stage = "cleanup"; failure = "cleanup-incomplete"; errors.push(error); }
    try { restoreGate?.(); if (pathChanged) { if (priorPath !== undefined) process.env.PATH = priorPath; else delete process.env.PATH; } }
    catch (error) { stage = "accounting"; failure = "accounting-incomplete"; errors.push(error); }
    for (const name of ["direct", "original", "support", "twin"] as const) {
      if (["allocated", "registered"].includes(ledger.state(name) ?? "")) ledger.advance(name, "unknown");
    }
    if (!ledger.settled() || complete && !ledger.complete()) {
      stage = "accounting"; failure = "accounting-incomplete"; errors.push(new Error());
    }
  }
  return finalizeS12ScoreCandidate(complete, ledger, errors.length, stage, failure);
}
