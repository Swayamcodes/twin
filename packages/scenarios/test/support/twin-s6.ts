import assert from "node:assert/strict";
import childProcess, { type SpawnOptions } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { type BigIntStats, lstatSync, realpathSync } from "node:fs";
import fs from "node:fs/promises";
import { PassThrough } from "node:stream";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { vi } from "vitest";
import { createTwin, type DiscardResult, type MinimalReceipt, type RunResult, type TwinSession } from "@twin-cli/core";
import { cleanupScenarioRoot, createScenarioRoot, initializeFixture, initializeScenarioRoot,
  verifyWorkspace, type OwnedScenarioRoot } from "../../dist/fixture.js";
import { observePaths } from "../../dist/runner.js";
import { fixtureContents, getCommand, getScenario } from "../../dist/scenarios.js";
import { admitReceiptGit, rejectReceiptGitVariants } from "./twin-s12.js";
import type { CleanupEvidence, CommandEvidence, Snapshot } from "../../dist/types.js";

const require = createRequire(import.meta.url);
const { resolveTrustedSystemGit } = require("../../dist/test-harness/packages/scenarios/test/support/git-trust.cjs") as
  typeof import("./git-trust.cjs");
export const repository = fileURLToPath(new URL("../../../..", import.meta.url));
const markerName = ".twin-s6-test-owner";
const localeEnv = Object.freeze({ LANG: "C", LC_ALL: "C", TZ: "UTC" });
export function gitEnvironment(directory: string): Record<string, string> {
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
  options: { cwd: string; shell: false; env: Record<string, string>; detached: boolean;
    stdio: ["ignore", "pipe", "pipe"] };
}
/** Pure test seam: never launches. The real guard forwards only this owned snapshot. */
export function admitSpawn(inputCommand: unknown, inputArgv: unknown, inputOptions: unknown, policy: SpawnPolicy): AdmittedSpawn {
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
  assert(policy.requireDetached ? detached === true : detached === undefined || detached === false,
    "Unexpected detached setting");
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
  return { executable, argv, options: { cwd, shell: false, env, detached: policy.requireDetached === true,
    stdio: ["ignore", "pipe", "pipe"] } };
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
const removedPaths = Object.freeze([".env", "scratch.txt", "node_modules/lib.txt", "node_modules"]);
const actionArgv = Object.freeze(["clean", "-fdx"]);

function assertS6Receipt(receipt: MinimalReceipt): void {
  assert.deepEqual(Object.keys(receipt).sort(), ["command", "dependencies", "files", "globalNpm", "process", "schemaVersion", "watch"]);
  assert.equal(receipt.schemaVersion, 5);
  assert.equal(receipt.command.coverage, "top-level-only");
  assert.equal(receipt.command.nestedCommands, "not-observed");
  assert.equal(receipt.dependencies.declarations.coverage, "incomplete");
  assert.deepEqual(receipt.dependencies.declarations.changes, []);
  assert.equal(receipt.globalNpm.coverage, "unavailable");
  assert.deepEqual(Object.keys(receipt.files).sort(), ["changes", "coverage", "issues"]);
  assert.equal(receipt.files.coverage, "complete");
  assert.deepEqual(receipt.files.issues, []);
  const changes = [...receipt.files.changes].sort((a, b) => a.path.value < b.path.value ? -1 : 1);
  assert.deepEqual(changes, [
    { path: { encoding: "utf8", value: ".env" }, change: "deleted", category: "ignored", categoryReason: null },
    { path: { encoding: "utf8", value: "node_modules/lib.txt" }, change: "deleted", category: "ignored", categoryReason: null },
    { path: { encoding: "utf8", value: "scratch.txt" }, change: "deleted", category: "untracked", categoryReason: null },
  ]);
  assert.deepEqual(receipt.watch.map(item => item.id), [".gitconfig", ".npmrc", ".bashrc", ".zshrc",
    ".codex/config.toml", ".claude/settings.json", ".gemini/settings.json"]);
  for (const item of receipt.watch) {
    assert.deepEqual(Object.keys(item).sort(), ["after", "before", "comparison", "id"]);
    assert(Object.isFrozen(item) && Object.isFrozen(item.before) && Object.isFrozen(item.after));
  }
  assert(Object.isFrozen(receipt) && Object.isFrozen(receipt.files)
    && Object.isFrozen(receipt.files.issues) && Object.isFrozen(receipt.files.changes)
    && receipt.files.changes.every(change => Object.isFrozen(change) && Object.isFrozen(change.path))
    && Object.isFrozen(receipt.watch));
}

/** Fixed inputs for the public-CLI comparison; never an alternate action selector. */
export function comparisonS6Inputs(): { git: string; directory: string; fixture: Record<string, string>;
  setup: string[][]; actionArgv: string[] } {
  const trusted = resolveTrustedSystemGit();
  return { git: trusted.git, directory: trusted.directory, fixture: { ...pinnedContents },
    setup: setupVectors.map(vector => [...vector]), actionArgv: [...actionArgv] };
}

interface SupportRoot {
  readonly path: string;
  readonly token: string;
  identity: BigIntStats | null;
  scratchIdentity: BigIntStats | null;
  markerIdentity: BigIntStats | null;
}
const supports = new Set<SupportRoot>();
interface Entry { path: string; kind: "directory" | "file"; bytes: string; dev: bigint; ino: bigint }
export type Fault = "none" | "trusted-git" | "token" | "copy" | "before-run" | "guard-reject"
  | "nonzero" | "spawn-failure" | "unsettled" | "twin-observation" | "original-observation"
  | "twin-refusal" | "original-refusal";
export interface Proof {
  fault: Fault;
  events: string[];
  roots: string[];
  acquiredSupportPath: string | null;
  allocations: string[];
  twinRoots: string[];
  sessions: string[];
  launches: { phase: "setup" | "action"; requestedExecutable: string; executable: string;
    argv: string[]; cwd: string; shell: false; env: Record<string, string>; native: boolean }[];
  actionAttempts: number;
  beforeRoots: string[];
  afterRoots: string[];
  remainingTwinRoots: string[];
  registeredSupports: string[];
  dispositions: { path: string; state: "removed" | "retained" | "unknown" }[];
  twinCleanup: DiscardResult[];
  originalCleanup: CleanupEvidence[];
  result: RunResult | null;
}
export class ProofFailure extends AggregateError {
  constructor(errors: readonly unknown[], readonly proof: Proof) {
    super(errors, `Twin S6 proof failed (${proof.fault}); roots=${JSON.stringify(proof.roots)}`, { cause: errors[0] });
  }
}
export function completeProof(proof: Proof, errors: readonly unknown[]): Proof {
  if (errors.length) throw new ProofFailure(errors, proof);
  return proof;
}
function inside(parent: string, path: string): boolean {
  const suffix = relative(parent, path);
  return suffix === "" || (!isAbsolute(suffix) && suffix !== ".." && !suffix.startsWith(`..${sep}`));
}
async function canonicalMissing(path: string): Promise<string> {
  try { return await fs.realpath(path); }
  catch (error: unknown) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    const parent = dirname(path);
    if (parent === path) throw error;
    return join(await canonicalMissing(parent), relative(parent, path));
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
async function verifySupport(root: SupportRoot): Promise<void> {
  assert(supports.has(root) && root.identity, "Support registration unavailable");
  const stat = await fs.lstat(root.path, { bigint: true });
  assert(stat.isDirectory() && sameIdentity(stat, root.identity), "Support identity changed");
  assert.equal(stat.uid, BigInt(process.getuid!()));
  assert.equal(stat.mode & 0o777n, 0o700n);
  assert.equal(await fs.realpath(root.path), root.path);
  const marker = join(root.path, markerName);
  const markerStat = await fs.lstat(marker, { bigint: true });
  assert(root.markerIdentity && markerStat.isFile() && sameIdentity(markerStat, root.markerIdentity));
  assert.equal(markerStat.uid, stat.uid);
  assert.equal(markerStat.nlink, 1n);
  assert.equal(markerStat.mode & 0o777n, 0o600n);
  assert.equal(await fs.readFile(marker, "utf8"), root.token);
}
async function removeSupport(root: SupportRoot): Promise<void> {
  await verifySupport(root);
  assert.deepEqual((await fs.readdir(root.path)).sort(), [markerName, "scratch"].sort());
  const scratch = join(root.path, "scratch");
  const stat = await fs.lstat(scratch, { bigint: true });
  assert(root.scratchIdentity && stat.isDirectory() && sameIdentity(stat, root.scratchIdentity));
  assert.equal(stat.uid, root.identity!.uid);
  assert.equal(stat.mode & 0o777n, 0o700n);
  assert.equal(await fs.realpath(scratch), scratch);
  // No recursive cleanup: retained or unknown Twin allocations are never swept.
  assert.deepEqual(await fs.readdir(scratch), [], "Retained Twin allocation; support retained");
  await verifySupport(root);
  assert(sameIdentity(stat, await fs.lstat(scratch, { bigint: true })));
  await fs.rmdir(scratch);
  await verifySupport(root);
  await fs.unlink(join(root.path, markerName));
  await fs.rmdir(root.path);
  supports.delete(root);
}
async function inventory(root: string): Promise<Entry[]> {
  const entries: Entry[] = [];
  const visit = async (path: string): Promise<void> => {
    const stat = await fs.lstat(path, { bigint: true });
    assert(stat.isDirectory() || stat.isFile(), `Unexpected inventory type: ${path}`);
    entries.push({ path: relative(root, path), kind: stat.isDirectory() ? "directory" : "file",
      bytes: stat.isFile() ? (await fs.readFile(path)).toString("base64") : "", dev: stat.dev, ino: stat.ino });
    if (stat.isDirectory()) for (const name of (await fs.readdir(path)).sort()) await visit(join(path, name));
  };
  await visit(root);
  return entries;
}
function contents(entries: readonly Entry[]) {
  return entries.map(({ path, kind, bytes }) => ({ path, kind, bytes })).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}
function baseline(snapshot: Snapshot): void {
  assert(snapshot.complete);
  assert.deepEqual(snapshot.paths.map(item => item.path).sort(), [...Object.keys(pinnedContents), "control-created.txt"].sort());
  for (const item of snapshot.paths) {
    if (item.path === "control-created.txt") assert.deepEqual(item, { path: item.path, state: "absent" });
    else {
      const bytes = Buffer.from(pinnedContents[item.path]);
      assert.deepEqual(item, { path: item.path, state: "file", sizeBytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex") });
    }
  }
}
async function absent(path: string): Promise<void> {
  await assert.rejects(fs.lstat(path), { code: "ENOENT" });
}


export interface ActionGateState {
  installed: boolean;
  phase: "closed" | "setup" | "action" | "restoring";
  dispatched: boolean;
  preStateComplete: boolean;
  sessionState: string | null;
}
/** Admission only. This seam cannot execute a command or acquire deletion authority. */
export class S6ActionGate {
  private consumed = false;
  admit(command: unknown, argv: unknown, options: unknown, policy: SpawnPolicy, state: ActionGateState): AdmittedSpawn {
    assert(state.installed && state.phase === "action" && state.dispatched && state.preStateComplete
      && state.sessionState === "running", "S6 action is not armed through a returned running session");
    assert(!this.consumed, "Only one S6 action permitted");
    const captured = admitSpawn(command, argv, options, { ...policy, argv: actionArgv, requireDetached: true });
    this.consumed = true; // A failed native spawn still consumes the allowance.
    return captured;
  }
}

/** Each authority is attempted independently; callbacks never receive discovered paths. */
export async function cleanupS6(steps: {
  discardTwin: () => Promise<void>;
  observeOriginal: () => Promise<void>;
  cleanupOriginal: () => Promise<void>;
  accountScratch: () => Promise<void>;
  cleanupSupport: () => Promise<void>;
}, events: string[], errors: unknown[]): Promise<void> {
  for (const name of ["discardTwin", "observeOriginal", "cleanupOriginal", "accountScratch", "cleanupSupport"] as const) {
    events.push(name);
    try { await steps[name](); } catch (error: unknown) { errors.push(error); }
  }
}

/** Pure output validation: preserve framing before allowing line-order differences. */
export function assertS6Stdout(stdout: string): void {
  assert(stdout.endsWith("\n"), "Git stdout must end with LF");
  const lines = stdout.slice(0, -1).split("\n");
  assert.equal(lines.length, 3, "Expected exactly three Git removal lines");
  assert(lines.every(line => line.length > 0), "Empty Git removal line");
  assert.deepEqual(lines.sort(), ["Removing .env", "Removing node_modules/", "Removing scratch.txt"].sort(),
    `Unexpected Git stdout: ${JSON.stringify(stdout)}`);
}

export function assertSuccessfulResult(result: RunResult): void {
  assert.equal(result.outcome, "exited");
  assert.equal(result.started, true);
  assert.equal(result.directChildSettled, true);
  assert.equal(result.exitCode, 0);
  assert.equal(result.signal, null);
  assert.equal(result.spawnError, null);
  assert.equal(result.terminationError, null);
  for (const stream of [result.stdout, result.stderr]) {
    assert.equal(stream.complete, true);
    assert.equal(stream.truncated, false);
    assert.equal(stream.error, null);
  }
  const stdout = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(result.stdout.bytes);
  const stderr = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(result.stderr.bytes);
  assert.equal(result.stderr.bytes.length, 0, "Git stderr must contain zero bytes");
  assert.equal(stderr, "", `Unexpected Git stderr: ${JSON.stringify(stderr)}`);
  assertS6Stdout(stdout);
}

let active = false;
// After an unexpected real result, later cases cannot silently continue destructive execution.
let realActionFailure: unknown;

/** One fixed experiment; faults select injections, never command inputs. */
export async function proveTwinS6(fault: Fault = "none"): Promise<Proof> {
  assert(!active, "S6 proof must remain serialized");
  assert(realActionFailure === undefined, "Earlier real S6 result failed; stop focused execution");
  active = true;
  const proof: Proof = { fault, events: [], roots: [], acquiredSupportPath: null, allocations: [], twinRoots: [], sessions: [],
    launches: [], actionAttempts: 0, beforeRoots: [], afterRoots: [], remainingTwinRoots: [], registeredSupports: [],
    dispositions: [], twinCleanup: [], originalCleanup: [], result: null };
  const errors: unknown[] = [], restorationErrors: unknown[] = [];
  const receiptGitCalls: { phase: "before" | "after"; argv: string[]; cwd: string }[] = [];
  const restores: (() => void)[] = [];
  const primary = new Error(`Injected ${fault}`);
  const oldPath = process.env.PATH;
  const nativeSpawn = childProcess.spawn;
  const nativeExecFile = childProcess.execFile;
  let base: string | undefined, support: SupportRoot | undefined, original: OwnedScenarioRoot | undefined;
  let workspace: string | undefined, scratch: string | undefined, session: TwinSession | undefined;
  let twinWorkspace: string | undefined, twinIdentity: BigIntStats | undefined, originalIdentity: BigIntStats | undefined;
  let before: Snapshot | undefined, sourceInventory: Entry[] | undefined, twinBefore: Entry[] | undefined;
  let trusted: ReturnType<typeof resolveTrustedSystemGit> | undefined;
  let env: Readonly<Record<string, string>> | undefined;
  let phase: ActionGateState["phase"] = "closed", installed = false, dispatched = false, preStateComplete = false;
  let receiptPhase: "closed" | "before" | "after" = "closed", expectedTwinWorkspace: string | undefined;
  let setupIndex = 0, syntheticChild: childProcess.ChildProcess | undefined;
  let twinRefusal = false, originalRefusal = false, unsettledRefusal = false;
  let settledReceipt: MinimalReceipt | undefined, receiptBeforeDiscard: MinimalReceipt | undefined;
  const gate = new S6ActionGate();
  const attempt = async (event: string, body: () => Promise<void>): Promise<void> => {
    proof.events.push(event);
    try { await body(); } catch (error: unknown) { errors.push(error); }
  };
  const checkOriginal = async (): Promise<Snapshot> => {
    assert(original);
    const observed = await observePaths(original, getScenario("S6").observedPaths);
    if (before) { baseline(observed); assert.deepEqual(observed.paths, before.paths); }
    if (workspace && sourceInventory) assert.deepEqual(contents(await inventory(workspace)), contents(sourceInventory));
    return observed;
  };
  const confirmDiscard = async (): Promise<void> => {
    assert(session && twinWorkspace && support);
    const discardedInspection = session.inspect();
    const { receipt: discardedReceipt, ...discardedFields } = discardedInspection;
    assert.deepEqual(discardedFields, { state: "discarded", workspacePath: twinWorkspace });
    assert(Object.isFrozen(discardedInspection));
    assert.strictEqual(discardedReceipt, receiptBeforeDiscard);
    if (settledReceipt) assert.strictEqual(discardedReceipt, settledReceipt);
    if (discardedReceipt) {
      assert(Object.isFrozen(discardedReceipt) && Object.isFrozen(discardedReceipt.files)
        && Object.isFrozen(discardedReceipt.files.issues) && Object.isFrozen(discardedReceipt.files.changes)
        && Object.isFrozen(discardedReceipt.watch)
        && discardedReceipt.files.changes.every(change => Object.isFrozen(change) && Object.isFrozen(change.path))
        && discardedReceipt.watch.every(item => Object.isFrozen(item) && Object.isFrozen(item.before) && Object.isFrozen(item.after)));
      if (proof.result?.exitCode === 0 && proof.launches.some(item => item.phase === "action" && item.native)) {
        assertS6Receipt(discardedReceipt);
      }
    }
    await absent(dirname(twinWorkspace));
    assert.deepEqual(await session.discard(), { status: "already-removed" });
    await verifySupport(support);
    proof.events.push("twin-removed");
  };
  try {
    try {
      for (const method of ["exec", "fork", "execSync", "execFileSync", "spawnSync"] as const) {
        const spy = vi.spyOn(childProcess, method).mockImplementation(() => { throw new Error("S6 forbids this launch API"); });
        restores.push(() => spy.mockRestore());
      }
      const receiptExecFile = ((file: unknown, argv: unknown, options: unknown, callback: unknown) => {
        assert(installed && trusted && expectedTwinWorkspace);
        const ordinal = receiptGitCalls.length;
        assert(receiptPhase === (ordinal < 4 ? "before" : "after"), "Receipt Git outside fixed phase");
        if (receiptPhase === "after") assert(dispatched && proof.actionAttempts === 1);
        const admitted = admitReceiptGit(file, argv, options, callback, expectedTwinWorkspace, ordinal);
        assert.equal(trusted.git, admitted.file);
        const child = Reflect.apply(nativeExecFile, childProcess,
          [admitted.file, admitted.argv, admitted.options, admitted.callback]) as ReturnType<typeof childProcess.execFile>;
        receiptGitCalls.push({ phase: receiptPhase, argv: [...admitted.argv], cwd: admitted.options.cwd });
        return child;
      }) as typeof childProcess.execFile;
      const execFileSpy = vi.spyOn(childProcess, "execFile").mockImplementation(receiptExecFile);
      restores.push(() => execFileSpy.mockRestore());
      const guarded = ((command: string, argv: readonly string[], options: SpawnOptions) => {
        assert(installed && childProcess.spawn === guardedSpy, "S6 guard not installed");
        assert(trusted && env);
        let admitted: AdmittedSpawn;
        let requestedExecutable: string;
        if (phase === "setup") {
          assert(original && workspace && originalIdentity);
          const expected = setupVectors[setupIndex];
          assert(expected, "Only seven ordered setup commands permitted");
          admitted = admitSpawn(command, argv, options, { executable: "git", argv: expected, cwd: workspace, env });
          requestedExecutable = admitted.executable;
          assert.equal(realpathSync(workspace), workspace);
          assert(sameIdentity(lstatSync(workspace, { bigint: true }), originalIdentity));
          assert.equal(realpathSync(join(trusted.directory, "git")), trusted.git);
          admitted.executable = trusted.git; // Only the validated setup semantic request is normalized.
          setupIndex++;
        } else {
          proof.actionAttempts++;
          admitted = gate.admit(command, argv, options, { executable: trusted.git, argv: actionArgv,
            cwd: twinWorkspace ?? "", env }, { installed, phase, dispatched, preStateComplete,
            sessionState: session?.inspect().state ?? null });
          requestedExecutable = admitted.executable;
          assert(session && twinWorkspace && twinIdentity && scratch && support);
          assert.equal(session.workspacePath, twinWorkspace);
          assert.equal(realpathSync(twinWorkspace), twinWorkspace);
          const stat = lstatSync(twinWorkspace, { bigint: true });
          assert(stat.isDirectory() && sameIdentity(stat, twinIdentity));
          assert.equal(dirname(dirname(twinWorkspace)), scratch);
          for (const forbidden of [workspace, repository, support.path, scratch, dirname(twinWorkspace)]) {
            assert.notEqual(admitted.options.cwd, forbidden);
          }
          if (fault === "guard-reject") throw primary;
        }
        const synthetic = phase === "action" && ["nonzero", "spawn-failure", "unsettled"].includes(fault);
        proof.launches.push({ phase: phase === "setup" ? "setup" : "action", requestedExecutable,
          executable: admitted.executable, argv: [...admitted.argv], cwd: admitted.options.cwd,
          shell: false, env: { ...admitted.options.env }, native: !synthetic });
        if (synthetic) {
          // This object has no OS child and never invokes a spawn method.
          const child = new childProcess.ChildProcess();
          const syntheticPid = 1000000;
          Object.defineProperty(child, "pid", { value: syntheticPid });
          const nativeKill = process.kill;
          const groupProbe = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
            if (pid !== -syntheticPid) return nativeKill(pid, signal);
            if (signal === 0) throw Object.assign(new Error("synthetic group absent"), { code: "ESRCH" });
            return true;
          });
          restores.push(() => groupProbe.mockRestore());
          const stdout = new PassThrough(), stderr = new PassThrough();
          Object.defineProperties(child, { stdout: { value: stdout }, stderr: { value: stderr },
            kill: { value: () => true }, unref: { value: () => {} } });
          syntheticChild = child;
          queueMicrotask(() => {
            if (fault === "spawn-failure") { child.emit("error", primary); return; }
            child.emit("spawn");
            if (fault === "unsettled") return;
            stdout.end(); stderr.end();
            child.emit("exit", 17, null);
            setImmediate(() => child.emit("close", 17, null));
          });
          return child;
        }
        return nativeSpawn(admitted.executable, [...admitted.argv], { ...admitted.options,
          env: { ...admitted.options.env }, stdio: ["ignore", "pipe", "pipe"] });
      }) as typeof childProcess.spawn;
      const spawnSpy = vi.spyOn(childProcess, "spawn").mockImplementation(guarded);
      const guardedSpy = childProcess.spawn;
      restores.push(() => spawnSpy.mockRestore());
      syncBuiltinESMExports();
      installed = true;
      base = await checkedBase();
      proof.beforeRoots = await rootNames(base);
      if (fault === "trusted-git") throw primary;
      trusted = Object.freeze(resolveTrustedSystemGit());
      env = Object.freeze(gitEnvironment(trusted.directory));
      if (fault === "token") throw primary;
      const token = randomBytes(32).toString("hex");
      assert.deepEqual(fixtureContents, pinnedContents);
      assert.equal(getScenario("S6").actionId, "git-clean");
      assert.deepEqual(getCommand("git-clean"), { executable: "git", args: ["clean", "-fdx"] });
      process.env.PATH = trusted.directory;

      // Observe allocation returns even if the factory later fails before returning authority.
      // Diagnostic paths never authorize cleanup.
      const mkdtemp = fs.mkdtemp;
      const allocationSpy = vi.spyOn(fs, "mkdtemp").mockImplementation(async (...args: Parameters<typeof fs.mkdtemp>) => {
        const path = await mkdtemp(...args);
        assert(typeof path === "string");
        proof.allocations.push(path);
        if (scratch && dirname(path) === scratch) {
          assert.equal(expectedTwinWorkspace, undefined, "Only one Twin allocation permitted");
          expectedTwinWorkspace = join(path, "workspace");
          proof.twinRoots.push(path);
        }
        return path;
      });
      restores.push(() => allocationSpy.mockRestore());
      syncBuiltinESMExports();
      const supportPath = await fs.mkdtemp(join(base, "twin-test-s6-"));
      proof.acquiredSupportPath = supportPath;
      proof.roots.push(supportPath);
      support = { path: supportPath, token, identity: null, scratchIdentity: null, markerIdentity: null };
      supports.add(support);
      support.identity = await fs.lstat(supportPath, { bigint: true });
      await fs.chmod(supportPath, 0o700);
      await fs.writeFile(join(supportPath, markerName), token, { flag: "wx", mode: 0o600 });
      support.markerIdentity = await fs.lstat(join(supportPath, markerName), { bigint: true });
      scratch = join(supportPath, "scratch");
      await fs.mkdir(scratch, { mode: 0o700 });
      await fs.chmod(scratch, 0o700);
      support.scratchIdentity = await fs.lstat(scratch, { bigint: true });
      await verifySupport(support);
      original = await createScenarioRoot();
      proof.roots.push(original.scenarioRoot);
      await initializeScenarioRoot(original);
      workspace = (await verifyWorkspace(original)).workspace;
      originalIdentity = await fs.lstat(workspace, { bigint: true });
      const setup: CommandEvidence[] = [];
      phase = "setup";
      try { await initializeFixture(original, setup); } finally { phase = "closed"; }
      assert.equal(setupIndex, 7);
      assert.deepEqual(setup.map(item => item.command.args), setupVectors);
      assert(setup.every(item => item.cwd === workspace));
      before = await observePaths(original, getScenario("S6").observedPaths);
      baseline(before);
      sourceInventory = await inventory(workspace);
      proof.events.push("original-baseline");
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
        receiptPhase = "before";
        session = await createTwin({ sourceDirectory: workspace, scratchParent: scratch });
        proof.sessions.push(session.workspacePath);
        twinWorkspace = session.workspacePath;
      } finally { receiptPhase = "closed"; restoreAll([restoreCopy], restorationErrors, syncBuiltinESMExports); }
      assert.equal(restorationErrors.length, 0, "Copy instrumentation restoration failed; action forbidden");
      proof.events.push("session-returned");
      assert.equal(twinWorkspace, expectedTwinWorkspace);
      assert.equal(receiptGitCalls.length, 4);
      rejectReceiptGitVariants(twinWorkspace);
      assert.throws(() => childProcess.execFile("/usr/bin/git", ["--version"],
        { cwd: twinWorkspace }, () => {}), "Unrelated execFile call must remain blocked");
      assert.equal(dirname(dirname(twinWorkspace)), scratch);
      assert.equal(twinWorkspace, join(dirname(twinWorkspace), "workspace"));
      assert.deepEqual(proof.twinRoots, [dirname(twinWorkspace)]);
      const readyInspection = session.inspect();
      const { receipt: readyReceipt, ...readyFields } = readyInspection;
      assert.deepEqual(readyFields, { state: "ready", workspacePath: twinWorkspace });
      assert.equal(readyReceipt, undefined);
      twinIdentity = await fs.lstat(twinWorkspace, { bigint: true });
      twinBefore = await inventory(twinWorkspace);
      assert.deepEqual(contents(twinBefore), contents(sourceInventory));
      assert(twinBefore.some(item => item.path === ".git" && item.kind === "directory"));
      for (const entry of twinBefore) if (entry.kind === "file") {
        const source: Entry | undefined = sourceInventory.find(item => item.path === entry.path);
        assert(source && (entry.dev !== source.dev || entry.ino !== source.ino), `Shared identity: ${entry.path}`);
      }
      preStateComplete = true;
      proof.events.push("twin-pre-state");
      if (fault === "before-run") throw primary;
      assert(installed && childProcess.spawn === guardedSpy);
      phase = "action";
      dispatched = true;
      receiptPhase = "after";
      try {
        proof.result = await session.run({ executable: trusted.git, argv: [...actionArgv], env, timeoutMs: 5000 });
      } finally { phase = "closed"; dispatched = false; receiptPhase = "closed"; }
      proof.events.push("action-returned");
      settledReceipt = session.inspect().receipt;
      assert.equal(receiptGitCalls.length, proof.result.directChildSettled ? 8 : 4);
      try { assertSuccessfulResult(proof.result); }
      catch (error: unknown) {
        if (proof.launches.some(item => item.phase === "action" && item.native)) realActionFailure = error;
        throw error;
      }
      const finishedInspection = session.inspect();
      const { receipt: finishedReceipt, ...finishedFields } = finishedInspection;
      assert.deepEqual(finishedFields, { state: "finished", workspacePath: twinWorkspace });
      assert(finishedReceipt, "Settled S6 run must have a receipt");
      assert(Object.isFrozen(finishedInspection));
      assertS6Receipt(finishedReceipt);
      assert.strictEqual(finishedReceipt, settledReceipt);
    } catch (error: unknown) { errors.push(error); }
    phase = "closed"; dispatched = false;
    // Observations are independent of result assertions and of each other.
    if (session && twinWorkspace && twinBefore) await attempt("twin-post-state", async () => {
      if (fault === "twin-observation") throw primary;
      if (session!.inspect().state === "child-unsettled") {
        proof.events.push("twin-observation-deferred-unsettled");
        return;
      }
      const actual = await inventory(twinWorkspace!);
      const realAction = proof.launches.some(item => item.phase === "action" && item.native);
      const expected = realAction ? twinBefore!.filter(item => !removedPaths.includes(item.path)) : twinBefore!;
      assert.deepEqual(contents(actual), contents(expected));
      proof.events.push("twin-post-state-verified");
    });
    if (original) await attempt("original-after-action", async () => { await checkOriginal(); });
    let cleanupSnapshot: Snapshot | null = null;
    await cleanupS6({
      discardTwin: async () => {
        if (!session) return;
        if (fault === "twin-refusal") await fs.chmod(scratch!, 0o755);
        receiptBeforeDiscard = session.inspect().receipt;
        const result = await session.discard();
        proof.twinCleanup.push(result);
        twinRefusal = fault === "twin-refusal" && result.status === "refused"
          && result.reason === `Directory authority mismatch: ${scratch}`;
        unsettledRefusal = fault === "unsettled" && result.status === "refused"
          && result.reason === "direct child exit remains unconfirmed";
        assert.equal(result.status, "removed", JSON.stringify(result));
        await confirmDiscard();
      },
      observeOriginal: async () => {
        if (!original) return;
        if (fault === "original-observation") throw primary;
        cleanupSnapshot = await checkOriginal();
        proof.events.push("original-after-discard-verified");
      },
      cleanupOriginal: async () => {
        if (!original) return;
        if (fault === "original-refusal") cleanupSnapshot = null;
        const result = await cleanupScenarioRoot(original, cleanupSnapshot);
        proof.originalCleanup.push(result);
        originalRefusal = ["original-refusal", "original-observation"].includes(fault) && result.status === "refused";
        assert.equal(result.status, "removed", JSON.stringify(result));
        await absent(original.scenarioRoot);
        proof.events.push("original-removed");
      },
      accountScratch: async () => {
        if (scratch && support?.scratchIdentity) {
          proof.remainingTwinRoots = (await fs.readdir(scratch)).sort();
          if (twinRefusal || unsettledRefusal) {
            assert(session && twinWorkspace);
            assert.deepEqual(proof.remainingTwinRoots, [relative(scratch, dirname(twinWorkspace))]);
            proof.events.push("injected-twin-retention-accounted");
            if (twinRefusal) await fs.chmod(scratch, 0o700);
            else {
              assert(syntheticChild, "Only the known synthetic child may be settled here");
              syntheticChild.emit("exit", 0, null);
              syntheticChild.emit("close", 0, null);
              assert.equal(session.inspect().state, "finished");
              proof.events.push("synthetic-late-settlement");
            }
            receiptBeforeDiscard = session.inspect().receipt;
            const result = await session.discard();
            proof.twinCleanup.push(result);
            assert.equal(result.status, "removed", JSON.stringify(result));
            await confirmDiscard();
            proof.events.push("injected-twin-released");
          }
          proof.remainingTwinRoots = (await fs.readdir(scratch)).sort();
          assert.deepEqual(proof.remainingTwinRoots, []);
        }
        if (original && originalRefusal) {
          proof.events.push("injected-original-retention-accounted");
          const fresh = await checkOriginal();
          assert(fresh.complete);
          const result = await cleanupScenarioRoot(original, fresh);
          proof.originalCleanup.push(result);
          assert.equal(result.status, "removed", JSON.stringify(result));
          await absent(original.scenarioRoot);
          proof.events.push("injected-original-released");
        }
      },
      cleanupSupport: async () => { if (support) { await removeSupport(support); await absent(support.path); } },
    }, proof.events, errors);
  } catch (error: unknown) { errors.push(error); }
  finally {
    phase = "restoring"; dispatched = false; installed = false;
    restoreAll([() => { if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath; },
      ...restores.toReversed()], restorationErrors, syncBuiltinESMExports);
    errors.push(...restorationErrors);
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
      assert(proof.dispositions.every(item => item.state === "removed"), "Acquired roots remain; no sweep attempted");
      assert.deepEqual(proof.afterRoots, proof.beforeRoots);
      assert.deepEqual(proof.registeredSupports, []);
      assert.equal(receiptGitCalls.length, session ? (proof.result?.directChildSettled ? 8 : 4) : 0);
    });
    active = false;
  }
  console.log(`TWIN S6 ACCOUNTING ${JSON.stringify({ fault, roots: proof.roots, allocations: proof.allocations,
    twinRoots: proof.twinRoots, sessions: proof.sessions, dispositions: proof.dispositions,
    setupLaunches: proof.launches.filter(item => item.phase === "setup" && item.native).length,
    receiptGitLaunches: receiptGitCalls.length,
    realActions: proof.launches.filter(item => item.phase === "action" && item.native).length,
    syntheticActions: proof.launches.filter(item => item.phase === "action" && !item.native).length,
    actionAttempts: proof.actionAttempts, before: proof.beforeRoots, after: proof.afterRoots,
    remainingTwinRoots: proof.remainingTwinRoots, registeredSupports: proof.registeredSupports,
    twinCleanup: proof.twinCleanup, originalCleanup: proof.originalCleanup,
    git: trusted?.git, stdout: proof.result ? Buffer.from(proof.result.stdout.bytes).toString("utf8") : null,
    stderr: proof.result ? Buffer.from(proof.result.stderr.bytes).toString("utf8") : null })}`);
  return completeProof(proof, errors);
}
