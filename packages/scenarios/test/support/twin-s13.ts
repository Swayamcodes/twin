import assert from "node:assert/strict";
import childProcess, { type SpawnOptions } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { type BigIntStats, lstatSync, readFileSync, realpathSync } from "node:fs";
import fs from "node:fs/promises";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { vi } from "vitest";
import { createTwin, type RunResult, type TwinSession } from "@twin-cli/core";
import { cleanupScenarioRoot, createScenarioRoot, initializeFixture, initializeScenarioRoot,
  verifyWorkspace, type OwnedScenarioRoot } from "../../dist/fixture.js";
import { observePaths } from "../../dist/runner.js";
import { fixtureContents } from "../../dist/scenarios.js";
import type { CommandEvidence, ObservedPath, Snapshot } from "../../dist/types.js";

const require = createRequire(import.meta.url);
const { resolveTrustedSystemGit } = require("../../dist/test-harness/packages/scenarios/test/support/git-trust.cjs") as
  typeof import("./git-trust.cjs");
export const repository = fileURLToPath(new URL("../../../..", import.meta.url));
const markerName = ".twin-s13-test-owner";
const localeEnv = Object.freeze({ LANG: "C", LC_ALL: "C", TZ: "UTC" });
function gitEnvironment(directory: string): Record<string, string> {
  return { PATH: directory, ...localeEnv,
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_ATTR_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_COUNT: "4",
    GIT_CONFIG_KEY_0: "core.hooksPath", GIT_CONFIG_VALUE_0: "/dev/null",
    GIT_CONFIG_KEY_1: "core.excludesFile", GIT_CONFIG_VALUE_1: "/dev/null",
    GIT_CONFIG_KEY_2: "core.attributesFile", GIT_CONFIG_VALUE_2: "/dev/null",
    GIT_CONFIG_KEY_3: "commit.gpgSign", GIT_CONFIG_VALUE_3: "false" };
}

interface SpawnPolicy {
  readonly executable: string;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly requireDetached?: boolean;
}
interface AdmittedSpawn {
  executable: string;
  argv: string[];
  options: { cwd: string; shell: false; env: Record<string, string>; detached: false;
    stdio: ["ignore", "pipe", "pipe"] };
}
/** Pure test seam: never launches. The real guard forwards only this owned snapshot. */
function admitSpawn(inputCommand: unknown, inputArgv: unknown, inputOptions: unknown, policy: SpawnPolicy): AdmittedSpawn {
  const executable = inputCommand;
  assert(Array.isArray(inputArgv), "Expected argv array");
  const argv: unknown[] = [...inputArgv]; // Consume a caller iterator exactly once, including holes.
  assert(inputOptions !== null && typeof inputOptions === "object", "Expected spawn options");
  const options = inputOptions as Record<string, unknown>;
  assert(Reflect.ownKeys(options).every(key => typeof key === "string"
    && ["cwd", "shell", "env", "detached", "stdio"].includes(key)), "Unexpected spawn option");
  const cwd = options.cwd;
  const shell = options.shell;
  const inputEnv = options.env;
  const detached = options.detached;
  const inputStdio = options.stdio;
  assert(inputEnv !== null && typeof inputEnv === "object" && !Array.isArray(inputEnv), "Expected explicit environment");
  const envEntries: [string, unknown][] = Object.entries(inputEnv);
  assert(Array.isArray(inputStdio), "Expected stdio array");
  const stdio: unknown[] = [...inputStdio];
  assert(typeof executable === "string", "Expected executable string");
  assert(argv.every((arg): arg is string => typeof arg === "string"), "Expected dense string argv");
  assert(typeof cwd === "string", "Expected cwd string");
  assert(shell === false, "Explicit shell:false required");
  assert(policy.requireDetached ? detached === false : detached === undefined || detached === false, "Detached execution forbidden");
  assert(stdio.every(value => typeof value === "string"), "Expected string stdio");
  assert.deepEqual(stdio, ["ignore", "pipe", "pipe"]);
  const env: Record<string, string> = {};
  for (const [key, value] of envEntries) {
    assert(key !== "" && !/[=\0]/.test(key) && typeof value === "string" && !value.includes("\0"), "Invalid environment entry");
    // Define data properties even for special names; never invoke Object.prototype setters.
    Object.defineProperty(env, key, { value, enumerable: true, writable: true, configurable: true });
  }
  assert.equal(executable, policy.executable);
  assert.deepEqual(argv, policy.argv);
  assert.equal(cwd, policy.cwd);
  assert.deepEqual(env, policy.env);
  return { executable, argv, options: { cwd, shell: false, env, detached: false, stdio: ["ignore", "pipe", "pipe"] } };
}

/** Synchronous restorations are independent; even failed restores cannot skip synchronization. */
export function restoreAll(restores: readonly (() => void)[], errors: unknown[], synchronize: () => void): void {
  for (const restore of restores) {
    try { restore(); } catch (error: unknown) { errors.push(error); }
  }
  try { synchronize(); } catch (error: unknown) { errors.push(error); }
}
// Independent literals: changes to production command definitions fail closed.
const setupVectors: readonly (readonly string[])[] = [
  ["init", "--initial-branch=main", "--template="],
  ["add", "--", "notes.txt", "app.js", ".gitignore"],
  ["-c", "user.name=Twin Scenario", "-c", "user.email=twin-scenario@example.invalid",
    "-c", "commit.gpgSign=false", "-c", "core.hooksPath=/dev/null",
    "commit", "-m", "Establish disposable scenario baseline"],
  ["rev-parse", "--show-toplevel"], ["ls-files", "-z"],
  ["ls-files", "--others", "--exclude-standard", "-z"],
  ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"],
];
for (const vector of setupVectors) Object.freeze(vector);
Object.freeze(setupVectors);
const pinnedContents = Object.freeze({
  "notes.txt": "Scenario fixture notes.\n",
  "app.js": 'console.log("fixture");\n',
  ".gitignore": ".env\nnode_modules/\n",
  "scratch.txt": "Untracked scratch data.\n",
  ".env": "TWIN_SCENARIO_SECRET=fake-only\n",
  "node_modules/lib.txt": "Ignored dependency fixture.\n",
});
const paths: readonly ObservedPath[] = Object.freeze([
  "notes.txt", "app.js", ".gitignore", "scratch.txt", ".env", "node_modules/lib.txt", "control-created.txt",
]);
export const successLine = '{"action":"twin-s13-inputs-v1","env":true,"dependency":true}\n';
export const failureLine = "TWIN_S13_INPUT_FAILURE\n";
// A fixed test asset, not an action template or caller-supplied program.
const moduleSource = String.raw`import { readFileSync } from "node:fs";
let valid = process.argv.length === 2;
for (const [path, expected] of [
  [".env", "TWIN_SCENARIO_SECRET=fake-only\n"],
  ["node_modules/lib.txt", "Ignored dependency fixture.\n"],
]) {
  try {
    const bytes = readFileSync(path);
    if (!bytes.equals(Buffer.from(expected, "utf8"))) valid = false;
  } catch {
    valid = false;
  }
}
if (valid) {
  process.stdout.write('{"action":"twin-s13-inputs-v1","env":true,"dependency":true}\n');
} else {
  process.stderr.write("TWIN_S13_INPUT_FAILURE\n");
  process.exitCode = 1;
}
`;
const hash = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
export function forbidChildApi(): never { throw new Error("S13 forbids alternate child APIs"); }

/** Fixed action admission only; the pure test destination never launches a child. */
export function actionGuard(executable: string, asset: string, cwd: string) {
  const policy = Object.freeze({ executable, argv: Object.freeze([asset]), cwd, env: localeEnv, requireDetached: true });
  let consumed = false;
  return (command: unknown, argv: unknown, options: unknown): AdmittedSpawn => {
    assert(!consumed, "Only one S13 action attempt permitted");
    consumed = true;
    return admitSpawn(command, argv, options, policy);
  };
}

interface Support {
  readonly path: string;
  readonly token: string;
  identity: BigIntStats | null;
  marker: BigIntStats | null;
  actions: BigIntStats | null;
  scratch: BigIntStats | null;
  asset: BigIntStats | null;
}
const supports = new Set<Support>();
interface Entry { path: string; kind: "file" | "directory"; bytes: Buffer; dev: bigint; ino: bigint }
export type Fault = "none" | "missing-env" | "missing-dependency" | "changed-env" | "changed-dependency"
  | "trusted-git" | "token" | "preparation" | "asset-mismatch" | "copy" | "before-action"
  | "observation" | "twin-refusal" | "original-refusal";
export interface Proof {
  fault: Fault;
  events: string[];
  allocations: string[];
  supports: string[];
  originals: string[];
  twins: string[];
  sessions: string[];
  dispositions: { path: string; state: "removed" | "retained" | "unknown" }[];
  setupLaunches: number;
  actions: number;
  beforeRoots: string[];
  afterRoots: string[];
  remainingScratch: string[];
  registeredSupports: string[];
  actionSha256: string | null;
  git: string | null;
  result: RunResult | null;
}
export class ProofFailure extends AggregateError {
  constructor(errors: readonly unknown[], readonly proof: Proof) {
    super(errors, `S13 proof failed: ${proof.fault}`, { cause: errors[0] });
  }
}
function inside(parent: string, path: string): boolean {
  const suffix = relative(parent, path);
  return suffix === "" || (!isAbsolute(suffix) && suffix !== ".." && !suffix.startsWith(`..${sep}`));
}
async function canonicalMissing(path: string): Promise<string> {
  try { return await fs.realpath(path); }
  catch (error: unknown) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT") || dirname(path) === path) throw error;
    return join(await canonicalMissing(dirname(path)), relative(dirname(path), path));
  }
}
async function checkedBase(): Promise<string> {
  const supplied = resolve(tmpdir());
  const excluded = [repository, join(homedir(), ".local/state/twin")];
  if (process.env.XDG_STATE_HOME) excluded.push(resolve(process.env.XDG_STATE_HOME, "twin"));
  for (const path of excluded) assert(!inside(resolve(path), supplied), "Forbidden supplied temporary base");
  const base = await fs.realpath(supplied);
  for (const path of excluded) {
    const canonical = await canonicalMissing(resolve(path));
    assert(!inside(canonical, base) && !inside(canonical, supplied), "Forbidden canonical temporary base");
  }
  return base;
}
async function rootNames(base: string): Promise<string[]> {
  return (await fs.readdir(base)).filter(name => name.startsWith("twin-test-") || name.startsWith("twin-scenario-"))
    .sort().map(name => join(base, name));
}
function sameIdentity(a: BigIntStats, b: BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino && (a.mode & 0o170000n) === (b.mode & 0o170000n);
}
function verifySupport(root: Support): void {
  assert(supports.has(root) && root.identity, "Support is not registered");
  const stat = lstatSync(root.path, { bigint: true });
  assert(stat.isDirectory() && sameIdentity(stat, root.identity), "Support identity changed");
  assert.equal(stat.uid, BigInt(process.getuid!()));
  assert.equal(stat.mode & 0o777n, 0o700n);
  assert.equal(realpathSync(root.path), root.path);
  const marker = lstatSync(join(root.path, markerName), { bigint: true });
  assert(root.marker && marker.isFile() && sameIdentity(marker, root.marker), "Support marker changed");
  assert.equal(marker.uid, stat.uid);
  assert.equal(marker.nlink, 1n);
  assert.equal(marker.mode & 0o777n, 0o600n);
  assert(readFileSync(join(root.path, markerName)).equals(Buffer.from(root.token)), "Support marker mismatch");
}
function verifyAsset(root: Support, bytes: Buffer): string {
  verifySupport(root);
  const directory = join(root.path, "actions"), path = join(directory, "read-ignored-inputs.mjs");
  const parent = lstatSync(directory, { bigint: true });
  assert(root.actions && parent.isDirectory() && sameIdentity(parent, root.actions), "Action directory changed");
  assert.equal(realpathSync(directory), directory);
  const stat = lstatSync(path, { bigint: true });
  assert(root.asset && stat.isFile() && sameIdentity(stat, root.asset), "Action identity changed");
  assert.equal(stat.uid, root.identity!.uid);
  assert.equal(stat.nlink, 1n);
  assert.equal(stat.mode & 0o777n, 0o600n);
  const actual = readFileSync(path);
  assert(actual.equals(bytes), "S13 action byte mismatch");
  return hash(actual);
}
async function removeSupport(root: Support): Promise<void> {
  verifySupport(root);
  // Exact owned entries only. No recursion or adoption of discovered Twin roots.
  assert.deepEqual((await fs.readdir(root.path)).sort(), [markerName, "actions", "scratch"].sort());
  for (const name of ["actions", "scratch"] as const) {
    const path = join(root.path, name), stat = await fs.lstat(path, { bigint: true });
    const identity = root[name];
    assert(identity && stat.isDirectory() && sameIdentity(stat, identity), "Support child changed");
    assert.equal(stat.uid, root.identity!.uid);
    assert.equal(stat.mode & 0o777n, 0o700n);
    assert.equal(await fs.realpath(path), path);
  }
  assert.deepEqual(await fs.readdir(join(root.path, "scratch")), [], "Retained Twin; support retained");
  assert.deepEqual(await fs.readdir(join(root.path, "actions")), ["read-ignored-inputs.mjs"]);
  const asset = join(root.path, "actions/read-ignored-inputs.mjs");
  assert(root.asset && sameIdentity(await fs.lstat(asset, { bigint: true }), root.asset), "Asset identity changed");
  verifySupport(root);
  // A byte mismatch does not invalidate registered ownership of this exact file.
  await fs.unlink(asset);
  await fs.rmdir(join(root.path, "actions"));
  await fs.rmdir(join(root.path, "scratch"));
  verifySupport(root);
  await fs.unlink(join(root.path, markerName));
  await fs.rmdir(root.path);
  supports.delete(root);
}
async function inventory(root: string): Promise<Entry[]> {
  const entries: Entry[] = [];
  const visit = async (path: string): Promise<void> => {
    const stat = await fs.lstat(path, { bigint: true });
    assert(stat.isDirectory() || stat.isFile(), "Unsupported inventory entry");
    entries.push({ path: relative(root, path), kind: stat.isFile() ? "file" : "directory",
      bytes: stat.isFile() ? await fs.readFile(path) : Buffer.alloc(0), dev: stat.dev, ino: stat.ino });
    if (stat.isDirectory()) for (const name of (await fs.readdir(path)).sort()) await visit(join(path, name));
  };
  await visit(root);
  return entries;
}
function equalInventory(actual: readonly Entry[], expected: readonly Entry[]): void {
  assert.deepEqual(actual.map(e => [e.path, e.kind]), expected.map(e => [e.path, e.kind]), "Inventory paths/types differ");
  for (let i = 0; i < actual.length; i++) {
    // Boolean assertion: never expose ignored bytes, even on a failed comparison.
    assert(actual[i]!.bytes.equals(expected[i]!.bytes), `Inventory bytes differ: ${actual[i]!.path}`);
  }
}
function baseline(snapshot: Snapshot): void {
  assert(snapshot.complete, "Incomplete original snapshot");
  assert.deepEqual(snapshot.paths.map(item => item.path).sort(), [...paths].sort());
  for (const item of snapshot.paths) {
    if (item.path === "control-created.txt") assert.equal(item.state, "absent");
    else {
      const bytes = Buffer.from(pinnedContents[item.path]);
      assert.deepEqual(item, { path: item.path, state: "file", sizeBytes: bytes.length, sha256: hash(bytes) });
    }
  }
}
function pinnedInventory(entries: readonly Entry[]): void {
  for (const [path, value] of Object.entries(pinnedContents)) {
    const entry = entries.find(item => item.path === path);
    assert(entry?.kind === "file" && entry.bytes.equals(Buffer.from(value)), `Pinned input mismatch: ${path}`);
  }
  assert(!entries.some(item => item.path === "control-created.txt"));
  assert(entries.some(item => item.path === ".git" && item.kind === "directory"));
}
async function absent(path: string): Promise<void> { await assert.rejects(fs.lstat(path), { code: "ENOENT" }); }
function assertResult(result: RunResult, negative: boolean): void {
  assert.equal(result.schemaVersion, 1);
  assert.equal(result.outcome, "exited");
  assert.equal(result.started, true);
  assert.equal(result.directChildSettled, true);
  assert.equal(result.exitCode, negative ? 1 : 0);
  assert.equal(result.signal, null);
  assert.equal(result.spawnError, null);
  assert.equal(result.terminationError, null);
  for (const stream of [result.stdout, result.stderr]) {
    assert(stream.complete && !stream.truncated && stream.error === null, "Incomplete action output");
  }
  assert(Buffer.from(result.stdout.bytes).equals(Buffer.from(negative ? "" : successLine)), "Unexpected S13 stdout bytes");
  assert(Buffer.from(result.stderr.bytes).equals(Buffer.from(negative ? failureLine : "")), "Unexpected S13 stderr bytes");
}
let active = false;
let priorUnexpectedFailure = false;

/** Closed fault selectors only: never accepts a command, path, or arbitrary callback. */
export async function proveTwinS13(fault: Fault = "none"): Promise<Proof> {
  assert(!active && !priorUnexpectedFailure, "S13 requires a restored, serialized worker");
  active = true;
  const proof: Proof = { fault, events: [], allocations: [], supports: [], originals: [], twins: [], sessions: [],
    dispositions: [], setupLaunches: 0, actions: 0, beforeRoots: [], afterRoots: [], remainingScratch: [],
    registeredSupports: [], actionSha256: null, git: null, result: null };
  const errors: unknown[] = [], restorationErrors: unknown[] = [], restores: (() => void)[] = [];
  const primary = new Error(`Injected ${fault}`);
  const oldPath = process.env.PATH, node = process.execPath, nativeSpawn = childProcess.spawn;
  let base: string | undefined, support: Support | undefined, original: OwnedScenarioRoot | undefined;
  let workspace: string | undefined, scratch: string | undefined, session: TwinSession | undefined;
  let source: Entry[] | undefined, twinBefore: Entry[] | undefined, originalIdentity: BigIntStats | undefined;
  let twinIdentity: BigIntStats | undefined, twinWorkspace: string | undefined, asset: string | undefined;
  let trusted: ReturnType<typeof resolveTrustedSystemGit> | undefined, setupEnv: Readonly<Record<string, string>> | undefined;
  let moduleBytes: Buffer | undefined, gate: ReturnType<typeof actionGuard> | undefined;
  let phase: "closed" | "setup" | "action" = "closed", installed = false, dispatch = false, preState = false;
  let setupIndex = 0;
  const negative = ["missing-env", "missing-dependency", "changed-env", "changed-dependency"].includes(fault);
  const attempt = async (event: string, body: () => Promise<void>): Promise<void> => {
    proof.events.push(event);
    try { await body(); } catch (error: unknown) { errors.push(error); }
  };
  const checkOriginal = async (): Promise<Snapshot> => {
    assert(original && workspace);
    const snapshot = await observePaths(original, paths);
    if (source) { baseline(snapshot); equalInventory(await inventory(workspace), source); }
    return snapshot;
  };
  const confirmDiscard = async (): Promise<void> => {
    assert(session && twinWorkspace);
    assert.equal(session.inspect().state, "discarded");
    await absent(dirname(twinWorkspace));
    assert.deepEqual(await session.discard(), { status: "already-removed" });
    proof.events.push("twin-removed");
  };
  try {
    try {
      for (const method of ["exec", "execFile", "fork", "execSync", "execFileSync", "spawnSync"] as const) {
        const spy = vi.spyOn(childProcess, method).mockImplementation(forbidChildApi);
        restores.push(() => spy.mockRestore());
      }
      const guarded = ((command: string, argv: readonly string[], options: SpawnOptions) => {
        assert(installed && childProcess.spawn === spawnSpy, "S13 guard absent");
        let admitted: AdmittedSpawn;
        if (phase === "setup") {
          assert(original && workspace && originalIdentity && trusted && setupEnv);
          const expected = setupVectors[setupIndex];
          assert(expected, "Only seven ordered Git commands permitted");
          admitted = admitSpawn(command, argv, options, { executable: "git", argv: expected, cwd: workspace, env: setupEnv });
          assert.equal(realpathSync(workspace), workspace);
          assert(sameIdentity(lstatSync(workspace, { bigint: true }), originalIdentity));
          assert.equal(realpathSync(join(trusted.directory, "git")), trusted.git);
          admitted.executable = trusted.git;
          setupIndex++; proof.setupLaunches++;
        } else {
          assert(phase === "action" && dispatch && preState && gate && session && twinWorkspace && twinIdentity);
          assert.equal(session.inspect().state, "running");
          assert.equal(session.workspacePath, twinWorkspace);
          assert.equal(realpathSync(twinWorkspace), twinWorkspace);
          assert(sameIdentity(lstatSync(twinWorkspace, { bigint: true }), twinIdentity));
          assert.equal(dirname(dirname(twinWorkspace)), scratch);
          assert(support && moduleBytes);
          assert.equal(verifyAsset(support, moduleBytes), proof.actionSha256);
          admitted = gate(command, argv, options);
          proof.actions++;
        }
        return nativeSpawn(admitted.executable, [...admitted.argv], { ...admitted.options,
          env: { ...admitted.options.env }, stdio: ["ignore", "pipe", "pipe"] });
      }) as typeof childProcess.spawn;
      const spy = vi.spyOn(childProcess, "spawn").mockImplementation(guarded);
      const spawnSpy = childProcess.spawn;
      restores.push(() => spy.mockRestore());
      syncBuiltinESMExports(); installed = true;
      base = await checkedBase(); proof.beforeRoots = await rootNames(base);
      if (fault === "trusted-git") throw primary;
      trusted = Object.freeze(resolveTrustedSystemGit()); proof.git = trusted.git;
      setupEnv = Object.freeze(gitEnvironment(trusted.directory));
      assert(isAbsolute(node) && !inside(repository, await fs.realpath(node)));
      if (fault === "token") throw primary;
      const token = randomBytes(32).toString("hex");
      if (fault === "preparation") throw primary;
      moduleBytes = Buffer.from(moduleSource, "utf8");
      for (const path of Object.keys(pinnedContents) as (keyof typeof pinnedContents)[]) {
        assert(fixtureContents[path] === pinnedContents[path], `Production fixture drift: ${path}`);
      }
      process.env.PATH = trusted.directory;
      const mkdtemp = fs.mkdtemp;
      const allocationSpy = vi.spyOn(fs, "mkdtemp").mockImplementation(async (...args: Parameters<typeof fs.mkdtemp>) => {
        const path = await mkdtemp(...args);
        assert(typeof path === "string");
        proof.allocations.push(path); // Diagnostic acquisition, never deletion authority.
        if (scratch && dirname(path) === scratch) proof.twins.push(path);
        return path;
      });
      restores.push(() => allocationSpy.mockRestore()); syncBuiltinESMExports();
      const supportPath = await fs.mkdtemp(join(base, "twin-test-s13-"));
      proof.supports.push(supportPath);
      support = { path: supportPath, token, identity: null,
        marker: null, actions: null, scratch: null, asset: null };
      supports.add(support);
      support.identity = await fs.lstat(supportPath, { bigint: true });
      await fs.chmod(supportPath, 0o700);
      await fs.writeFile(join(supportPath, markerName), token, { flag: "wx", mode: 0o600 });
      support.marker = await fs.lstat(join(supportPath, markerName), { bigint: true });
      for (const name of ["actions", "scratch"] as const) {
        await fs.mkdir(join(supportPath, name), { mode: 0o700 });
        support[name] = await fs.lstat(join(supportPath, name), { bigint: true });
      }
      scratch = join(supportPath, "scratch"); asset = join(supportPath, "actions/read-ignored-inputs.mjs");
      await fs.writeFile(asset, moduleBytes, { flag: "wx", mode: 0o600 });
      support.asset = await fs.lstat(asset, { bigint: true });
      proof.actionSha256 = verifyAsset(support, moduleBytes);
      if (fault === "asset-mismatch") {
        await fs.writeFile(asset, "fixed test mismatch\n");
        verifyAsset(support, moduleBytes);
        throw new Error("Asset mismatch was not rejected");
      }
      original = await createScenarioRoot(); proof.originals.push(original.scenarioRoot);
      await initializeScenarioRoot(original); workspace = (await verifyWorkspace(original)).workspace;
      originalIdentity = await fs.lstat(workspace, { bigint: true });
      const setup: CommandEvidence[] = [];
      phase = "setup";
      try { await initializeFixture(original, setup); } finally { phase = "closed"; }
      assert.equal(setupIndex, 7);
      assert.deepEqual(setup.map(item => item.command.args), setupVectors);
      baseline(await observePaths(original, paths));
      source = await inventory(workspace); pinnedInventory(source); proof.events.push("original-baseline");
      const open = fs.open;
      const copySpy = fault === "copy" ? vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
        if (args[0] === join(workspace!, "app.js")) throw primary;
        return open(...args);
      }) : undefined;
      let copyRestored = false;
      const restoreCopy = (): void => { if (!copyRestored) { copySpy?.mockRestore(); copyRestored = true; } };
      restores.push(restoreCopy);
      try {
        syncBuiltinESMExports();
        session = await createTwin({ sourceDirectory: workspace, scratchParent: scratch });
        proof.sessions.push(session.workspacePath); // Immediately retain returned authority.
        twinWorkspace = session.workspacePath;
      } finally { restoreAll([restoreCopy], restorationErrors, syncBuiltinESMExports); }
      assert.equal(restorationErrors.length, 0, "Copy restoration failed");
      proof.events.push("session-returned");
      assert.deepEqual(session.inspect(), { state: "ready", workspacePath: twinWorkspace });
      assert.equal(twinWorkspace, join(dirname(twinWorkspace), "workspace"));
      assert.deepEqual(proof.twins, [dirname(twinWorkspace)]);
      twinIdentity = await fs.lstat(twinWorkspace, { bigint: true });
      twinBefore = await inventory(twinWorkspace);
      equalInventory(twinBefore, source); pinnedInventory(twinBefore);
      for (const entry of twinBefore) if (entry.kind === "file") {
        const originalEntry: Entry | undefined = source.find(item => item.path === entry.path);
        assert(originalEntry && (entry.dev !== originalEntry.dev || entry.ino !== originalEntry.ino), "Shared copied file identity");
      }
      proof.events.push("twin-pre-state");
      if (fault === "before-action") throw primary;
      if (negative) {
        assert.equal(phase, "closed");
        const path = fault.endsWith("env") ? ".env" : "node_modules/lib.txt";
        const expected = twinBefore.filter(entry => !fault.startsWith("missing") || entry.path !== path)
          .map(entry => entry.path === path ? { ...entry, bytes: Buffer.from("S13 fixed changed input.\n") } : entry);
        if (fault.startsWith("missing")) await fs.unlink(join(twinWorkspace, path));
        else await fs.writeFile(join(twinWorkspace, path), "S13 fixed changed input.\n");
        twinBefore = await inventory(twinWorkspace);
        equalInventory(twinBefore, expected);
        proof.events.push("negative-pre-state");
      }
      preState = true; gate = actionGuard(node, asset, twinWorkspace);
      phase = "action"; dispatch = true;
      try { proof.result = await session.run({ executable: node, argv: [asset], env: localeEnv, timeoutMs: 5000 }); }
      finally { phase = "closed"; dispatch = false; }
      proof.events.push("action-returned");
      try { assertResult(proof.result, negative); }
      catch (error: unknown) { priorUnexpectedFailure = true; throw error; }
      assert.equal(session.inspect().state, "finished");
    } catch (error: unknown) { errors.push(error); }
    phase = "closed"; dispatch = false;
    if (session && twinWorkspace && twinBefore) await attempt("twin-post-state", async () => {
      if (fault === "observation") throw primary;
      assert(session!.inspect().state !== "child-unsettled", "Cannot verify unsettled Twin");
      equalInventory(await inventory(twinWorkspace!), twinBefore!);
      proof.events.push("twin-unchanged");
    });
    if (original) await attempt("original-after-action", async () => { await checkOriginal(); });
    let twinRefusal = false, originalRefusal = false;
    if (session) await attempt("twin-discard", async () => {
      if (fault === "twin-refusal") await fs.chmod(scratch!, 0o755);
      const result = await session!.discard();
      twinRefusal = fault === "twin-refusal" && result.status === "refused"
        && result.reason === `Directory authority mismatch: ${scratch}`;
      assert.equal(result.status, "removed", "Twin discard refused or failed; allocation retained");
      await confirmDiscard();
    });
    let cleanupSnapshot: Snapshot | null = null;
    if (original) {
      await attempt("original-after-discard", async () => { cleanupSnapshot = await checkOriginal(); });
      await attempt("original-cleanup", async () => {
        const result = await cleanupScenarioRoot(original!, fault === "original-refusal" ? null : cleanupSnapshot);
        originalRefusal = fault === "original-refusal" && result.status === "refused";
        assert.equal(result.status, "removed", "Original cleanup refused or failed; root retained");
        await absent(original!.scenarioRoot);
      });
    }
    // Release only known injected preflight refusals, after recording retention.
    if (twinRefusal) await attempt("injected-twin-retention", async () => {
      assert(session && scratch && twinWorkspace);
      assert.deepEqual(await fs.readdir(scratch), [relative(scratch, dirname(twinWorkspace))]);
      await fs.chmod(scratch, 0o700);
      assert.equal((await session.discard()).status, "removed"); await confirmDiscard();
    });
    if (originalRefusal) await attempt("injected-original-retention", async () => {
      assert(original); await fs.lstat(original.scenarioRoot);
      const fresh = await checkOriginal();
      assert.equal((await cleanupScenarioRoot(original, fresh)).status, "removed");
      await absent(original.scenarioRoot);
    });
    if (support) {
      await attempt("scratch-accounting", async () => {
        proof.remainingScratch = (await fs.readdir(join(support!.path, "scratch"))).sort();
        assert.deepEqual(proof.remainingScratch, []);
      });
      await attempt("support-cleanup", async () => { await removeSupport(support!); await absent(support!.path); });
    }
  } catch (error: unknown) { errors.push(error); }
  finally {
    phase = "closed"; dispatch = false; installed = false;
    restoreAll([() => { if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath; },
      ...restores.toReversed()], restorationErrors, syncBuiltinESMExports);
    await attempt("root-accounting", async () => {
      for (const path of proof.allocations) {
        try { await fs.lstat(path); proof.dispositions.push({ path, state: "retained" }); }
        catch (error: unknown) {
          if (error instanceof Error && "code" in error && error.code === "ENOENT") proof.dispositions.push({ path, state: "removed" });
          else { proof.dispositions.push({ path, state: "unknown" }); errors.push(error); }
        }
      }
      if (base) proof.afterRoots = await rootNames(base);
      proof.registeredSupports = [...supports].map(root => root.path);
      assert(proof.dispositions.every(item => item.state === "removed"), "Acquired roots retained; no sweep");
      assert.deepEqual(proof.afterRoots, proof.beforeRoots);
      assert.deepEqual(proof.registeredSupports, []);
    });
    errors.push(...restorationErrors);
    if (restorationErrors.length || proof.dispositions.some(item => item.state !== "removed")) priorUnexpectedFailure = true;
    active = false;
  }
  // Only allowlisted identities/accounting; never output streams, inventories or input bytes.
  const { result: _privateResult, ...accounting } = proof;
  console.log(`TWIN S13 ACCOUNTING ${JSON.stringify(accounting)}`);
  if (errors.length) throw new ProofFailure(errors, proof);
  return proof;
}
