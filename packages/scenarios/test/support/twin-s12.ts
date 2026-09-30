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
import { createTwin, type MinimalReceipt, type RunResult, type TwinSession } from "@twin-cli/core";
import { cleanupScenarioRoot, createScenarioRoot, initializeFixture, initializeScenarioRoot,
  verifyWorkspace, type OwnedScenarioRoot } from "../../dist/fixture.js";
import { observePaths } from "../../dist/runner.js";
import { fixtureContents, getCommand, getScenario } from "../../dist/scenarios.js";
import type { CommandEvidence, Snapshot } from "../../dist/types.js";

const require = createRequire(import.meta.url);
const { resolveTrustedSystemGit } = require("../../dist/test-harness/packages/scenarios/test/support/git-trust.cjs") as
  typeof import("./git-trust.cjs");
export const repository = fileURLToPath(new URL("../../../..", import.meta.url));
const markerName = ".twin-s12-test-owner";
const actionEnv = Object.freeze({ LANG: "C", LC_ALL: "C", TZ: "UTC" });
function setupEnvironment(directory: string): Record<string, string> {
  return { PATH: directory, ...actionEnv,
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
const compiledAction = 'import { writeFile } from "node:fs/promises";\n'
  + 'await writeFile("control-created.txt", "S12 control file.\\n", { flag: "wx" });\n';

const receiptQueries = Object.freeze([
  ["rev-parse", "--show-toplevel"],
  ["ls-files", "-z", "--full-name", "--cached", "--deduplicate", "--"],
  ["ls-files", "-z", "--full-name", "--others", "--exclude-standard", "--"],
  ["ls-files", "-z", "--full-name", "--others", "--ignored", "--exclude-standard", "--"],
] as const);
function receiptEnvironment(workspace: string): Record<string, string> {
  return { PATH: "", HOME: "/nonexistent", LC_ALL: "C", GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null", GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0",
    GIT_CEILING_DIRECTORIES: dirname(workspace) };
}
/** Pure admission for one core receipt Git call. It never launches a process. */
export function admitReceiptGit(file: unknown, argv: unknown, inputOptions: unknown, callback: unknown,
  workspace: string, ordinal: number): { file: string; argv: string[]; options: {
    cwd: string; env: Record<string, string>; encoding: "buffer"; maxBuffer: number;
    timeout: number; shell: false; windowsHide: true }; callback: (...args: unknown[]) => unknown } {
  assert(Number.isInteger(ordinal) && ordinal >= 0 && ordinal < 8, "Only four before and four after receipt calls permitted");
  assert.equal(file, "/usr/bin/git");
  assert(Array.isArray(argv) && Object.getPrototypeOf(argv) === Array.prototype);
  const expectedArgv = ["--no-optional-locks", "-c", "core.fsmonitor=false", ...receiptQueries[ordinal % 4]!];
  assert.deepEqual(argv, expectedArgv);
  assert(inputOptions && typeof inputOptions === "object" && Object.getPrototypeOf(inputOptions) === Object.prototype);
  const options = inputOptions as Record<string, unknown>;
  assert.deepEqual(Object.keys(options).sort(), ["cwd", "encoding", "env", "maxBuffer", "shell", "timeout", "windowsHide"]);
  assert.equal(options.cwd, workspace);
  assert(isAbsolute(workspace) && !workspace.includes("\0"));
  assert(options.env && typeof options.env === "object" && Object.getPrototypeOf(options.env) === Object.prototype);
  assert.deepEqual(Object.keys(options.env).sort(), Object.keys(receiptEnvironment(workspace)).sort());
  assert.deepEqual(options.env, receiptEnvironment(workspace));
  assert.equal(options.encoding, "buffer");
  assert.equal(options.maxBuffer, 16 * 1024 * 1024);
  assert.equal(options.timeout, 5000);
  assert.equal(options.shell, false);
  assert.equal(options.windowsHide, true);
  assert.equal(typeof callback, "function");
  return { file: "/usr/bin/git", argv: expectedArgv, options: { cwd: workspace,
    env: receiptEnvironment(workspace), encoding: "buffer", maxBuffer: 16 * 1024 * 1024,
    timeout: 5000, shell: false, windowsHide: true }, callback: callback as (...args: unknown[]) => unknown };
}
function receiptGitVariants(workspace: string) {
  const argv = ["--no-optional-locks", "-c", "core.fsmonitor=false", "rev-parse", "--show-toplevel"];
  const options = { cwd: workspace, env: receiptEnvironment(workspace), encoding: "buffer", maxBuffer: 16 * 1024 * 1024,
    timeout: 5000, shell: false, windowsHide: true };
  const callback = (): void => {};
  return { callback, variants: [
    ["/bin/sh", argv, options, 0],
    ["/usr/bin/git", [...argv, "-C", "/tmp"], options, 0],
    ["/usr/bin/git", [...argv, "--", "pathspec"], options, 0],
    ["/usr/bin/git", ["--no-optional-locks", "-c", "core.fsmonitor=true", ...argv.slice(3)], options, 0],
    ["/usr/bin/git", argv, { ...options, cwd: dirname(workspace) }, 0],
    ["/usr/bin/git", argv, { ...options, env: { ...options.env, HOME: "/tmp" } }, 0],
    ["/usr/bin/git", argv, { ...options, timeout: 0 }, 0],
    ["/usr/bin/git", argv, { ...options, shell: true }, 0],
    ["/usr/bin/git", argv, { ...options, encoding: "utf8" }, 0],
    ["/usr/bin/git", argv, { ...options, maxBuffer: 1 }, 0],
    ["/usr/bin/git", argv, { ...options, extra: true }, 0],
    ["/usr/bin/git", argv, options, 8],
  ] as const };
}
/** Negative admission controls use only inert values and never forward to native execFile. */
export function rejectReceiptGitVariants(workspace: string): void {
  const { callback, variants } = receiptGitVariants(workspace);
  for (const [file, args, changed, ordinal] of variants) {
    assert.throws(() => admitReceiptGit(file, args, changed, callback, workspace, ordinal));
  }
}
function makeReceiptExecFileGuard(
  state: () => { trustedGit: string; workspace: string; ordinal: number; phase: "closed" | "before" | "after"; actionCalls: number },
  forward: typeof childProcess.execFile,
  record: (admitted: ReturnType<typeof admitReceiptGit>, phase: "before" | "after") => void,
): typeof childProcess.execFile {
  return ((file: unknown, argv: unknown, options: unknown, callback: unknown) => {
    const { trustedGit, workspace, ordinal, phase, actionCalls } = state();
    assert(phase === (ordinal < 4 ? "before" : "after"), "Receipt Git outside fixed phase");
    if (phase === "after") assert.equal(actionCalls, 1);
    const admitted = admitReceiptGit(file, argv, options, callback, workspace, ordinal);
    assert.equal(trustedGit, admitted.file);
    const child = Reflect.apply(forward, childProcess,
      [admitted.file, admitted.argv, admitted.options, admitted.callback]) as ReturnType<typeof childProcess.execFile>;
    record(admitted, phase);
    return child;
  }) as typeof childProcess.execFile;
}
function assertS12Receipt(receipt: MinimalReceipt): void {
  assert.deepEqual(Object.keys(receipt).sort(), ["dependencies", "files", "globalNpm", "schemaVersion", "watch"]);
  assert.equal(receipt.schemaVersion, 3);
  assert.equal(receipt.dependencies.declarations.coverage, "incomplete");
  assert.deepEqual(receipt.dependencies.declarations.changes, []);
  assert.equal(receipt.globalNpm.coverage, "unavailable");
  assert.deepEqual(receipt.files, { coverage: "complete", issues: [], changes: [{
    path: { encoding: "utf8", value: "control-created.txt" }, change: "added",
    category: "untracked", categoryReason: null,
  }] });
  assert.deepEqual(receipt.watch.map(item => item.id), [".gitconfig", ".npmrc", ".bashrc", ".zshrc",
    ".codex/config.toml", ".claude/settings.json", ".gemini/settings.json"]);
  for (const item of receipt.watch) {
    assert.deepEqual(Object.keys(item).sort(), ["after", "before", "comparison", "id"]);
    assert(Object.isFrozen(item) && Object.isFrozen(item.before) && Object.isFrozen(item.after));
  }
  assert(Object.isFrozen(receipt) && Object.isFrozen(receipt.files)
    && Object.isFrozen(receipt.files.issues) && Object.isFrozen(receipt.files.changes)
    && Object.isFrozen(receipt.files.changes[0]) && Object.isFrozen(receipt.files.changes[0]?.path)
    && Object.isFrozen(receipt.watch));
}

/** Fixed inputs for the public-CLI comparison; the historical proof remains independent. */
export function comparisonS12Inputs(): { action: Buffer; fixture: Record<string, string>;
  setup: string[][] } {
  return { action: Buffer.from(compiledAction), fixture: { ...fixtureContents },
    setup: setupVectors.map(vector => [...vector]) };
}

interface SupportRoot { readonly path: string; readonly token: string; identity: BigIntStats | null }
const supports = new Set<SupportRoot>();
interface Entry { path: string; kind: "directory" | "file"; bytes: string; dev: bigint; ino: bigint }
export type Fault = "none" | "copy" | "before-run" | "after-run" | "twin-cleanup"
  | "original-cleanup" | "observation" | "missing-snapshot" | "incomplete-snapshot" | "wrong-workspace";
export interface Proof {
  fault: Fault;
  events: string[];
  roots: string[];
  acquiredSupportPath: string | null;
  twinRoots: string[];
  sessions: string[];
  launches: { phase: "setup" | "action"; executable: string; argv: string[]; cwd: string; shell: false }[];
  beforeRoots: string[];
  afterRoots: string[];
  remainingTwinRoots: string[];
  registeredSupports: string[];
  result: RunResult | null;
}
export class ProofFailure extends AggregateError {
  constructor(errors: readonly unknown[], readonly proof: Proof) {
    super(errors, `Twin S12 proof failed (${proof.fault}); roots=${JSON.stringify(proof.roots)}`, { cause: errors[0] });
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
  assert((await fs.lstat(marker)).isFile(), "Support marker is not regular");
  assert.equal(await fs.readFile(marker, "utf8"), root.token);
}
async function removeSupport(root: SupportRoot): Promise<void> {
  await verifySupport(root);
  assert.deepEqual((await fs.readdir(root.path)).sort(), [markerName, "actions", "scratch"].sort(), "Unexpected support entry");
  for (const name of ["actions", "scratch"]) {
    assert((await fs.lstat(join(root.path, name))).isDirectory(), "Support child is not an ordinary directory");
  }
  assert.deepEqual(await fs.readdir(join(root.path, "actions")), ["create-file.mjs"], "Unexpected action asset");
  // Discovery never grants deletion authority. In particular, never sweep Twin.
  assert.deepEqual(await fs.readdir(join(root.path, "scratch")), [], "Retained Twin allocation; support retained");
  const entries: { path: string; stat: BigIntStats }[] = [];
  const preflight = async (path: string): Promise<void> => {
    const stat = await fs.lstat(path, { bigint: true });
    assert.equal(stat.uid, root.identity!.uid);
    assert.equal(stat.dev, root.identity!.dev);
    assert(stat.isFile() || stat.isDirectory(), "Unsupported support entry");
    if (stat.isDirectory()) for (const name of await fs.readdir(path)) await preflight(join(path, name));
    entries.push({ path, stat });
  };
  for (const name of await fs.readdir(root.path)) if (name !== markerName) await preflight(join(root.path, name));
  await verifySupport(root);
  for (const entry of entries) {
    assert(sameIdentity(entry.stat, await fs.lstat(entry.path, { bigint: true })), "Support entry changed");
    if (entry.stat.isDirectory()) await fs.rmdir(entry.path);
    else await fs.unlink(entry.path);
  }
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
  assert.deepEqual(snapshot.paths.map(item => item.path).sort(), [...getScenario("S12").observedPaths].sort());
  for (const item of snapshot.paths) {
    if (item.path === "control-created.txt") assert.deepEqual(item, { path: item.path, state: "absent" });
    else {
      const bytes = Buffer.from(fixtureContents[item.path]);
      assert.deepEqual(item, { path: item.path, state: "file", sizeBytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex") });
    }
  }
}
async function absent(path: string): Promise<void> {
  await assert.rejects(fs.lstat(path), { code: "ENOENT" });
}

/** One fixed experiment. Fault names select test-only injections, never commands or paths. */
export async function proveTwinS12(fault: Fault = "none"): Promise<Proof> {
  const proof: Proof = { fault, events: [], roots: [], acquiredSupportPath: null, twinRoots: [], sessions: [], launches: [], beforeRoots: [], afterRoots: [],
    remainingTwinRoots: [], registeredSupports: [], result: null };
  const receiptGitCalls: { phase: "before" | "after"; argv: string[]; cwd: string }[] = [];
  const errors: unknown[] = [];
  const restorationErrors: unknown[] = [];
  const primary = new Error(`Injected ${fault}`);
  let base: string | undefined, support: SupportRoot | undefined, original: OwnedScenarioRoot | undefined;
  let session: TwinSession | undefined, workspace: string | undefined, actionPath: string | undefined;
  let settledReceipt: MinimalReceipt | undefined;
  let before: Snapshot | undefined, sourceInventory: Entry[] | undefined;
  let trusted: ReturnType<typeof resolveTrustedSystemGit> | undefined;
  let phase: "closed" | "setup" | "action" = "closed";
  let receiptPhase: "closed" | "before" | "after" = "closed", expectedTwinWorkspace: string | undefined;
  let setupIndex = 0, actionCalls = 0;
  let scratchReady = false, twinRefusalInjected = false, originalRefusalInjected = false;
  const oldPath = process.env.PATH;
  const nodeExecutable = process.execPath;
  const originalSpawn = childProcess.spawn;
  const nativeExecFile = childProcess.execFile;
  const restores: (() => void)[] = [];
  const attempt = async (event: string, body: () => Promise<void>): Promise<void> => {
    proof.events.push(event);
    try { await body(); } catch (error: unknown) { errors.push(error); }
  };
  try {
    try {
      // Guard all direct child_process entry points for this serial test's lifetime.
      for (const method of ["exec", "fork", "execSync", "execFileSync", "spawnSync"] as const) {
        const spy = vi.spyOn(childProcess, method).mockImplementation(() => { throw new Error("S12 proof forbids this launch API"); });
        restores.push(() => spy.mockRestore());
      }
      const receiptExecFile = makeReceiptExecFileGuard(() => {
        assert(trusted && expectedTwinWorkspace);
        return { trustedGit: trusted.git, workspace: expectedTwinWorkspace, ordinal: receiptGitCalls.length,
          phase: receiptPhase, actionCalls };
      }, nativeExecFile, (admitted, currentPhase) => {
        receiptGitCalls.push({ phase: currentPhase, argv: [...admitted.argv], cwd: admitted.options.cwd });
      });
      const execFileSpy = vi.spyOn(childProcess, "execFile").mockImplementation(receiptExecFile);
      restores.push(() => execFileSpy.mockRestore());
      const guarded = ((command: string, argv: readonly string[], options: SpawnOptions) => {
        let admitted: AdmittedSpawn;
        if (phase === "setup") {
          assert(original && workspace && trusted);
          const expectedArgv = setupVectors[setupIndex];
          assert(expectedArgv, "Only seven setup invocations permitted");
          admitted = admitSpawn(command, argv, options, { executable: "git", argv: expectedArgv,
            cwd: workspace, env: setupEnvironment(trusted.directory) });
          assert.equal(realpathSync(workspace), workspace);
          assert.equal(realpathSync(join(trusted.directory, "git")), trusted.git);
          setupIndex++;
        } else {
          assert(phase === "action", "Launch outside approved phase");
          assert(session && actionPath && support);
          admitted = admitSpawn(command, argv, options, { executable: nodeExecutable, argv: [actionPath],
            cwd: session.workspacePath, env: actionEnv, requireDetached: true });
          assert.equal(session.inspect().state, "running", "Action must be dispatched through session.run");
          assert.notEqual(admitted.options.cwd, workspace);
          assert.equal(realpathSync(session.workspacePath), session.workspacePath);
          assert(lstatSync(actionPath).isFile());
          assert.equal(readFileSync(actionPath, "utf8"), compiledAction);
          assert.equal(actionCalls++, 0, "Only one action launch permitted");
        }
        proof.launches.push({ phase, executable: admitted.executable, argv: [...admitted.argv], cwd: admitted.options.cwd, shell: false });
        return originalSpawn(admitted.executable, admitted.argv, admitted.options);
      }) as typeof childProcess.spawn;
      const spawnSpy = vi.spyOn(childProcess, "spawn").mockImplementation(guarded);
      restores.push(() => spawnSpy.mockRestore());
      syncBuiltinESMExports();
      base = await checkedBase();
      proof.beforeRoots = await rootNames(base);
      const supportToken = randomBytes(32).toString("hex"); // All fallible marker material precedes allocation.
      trusted = resolveTrustedSystemGit();
      assert(isAbsolute(nodeExecutable) && !inside(repository, await fs.realpath(nodeExecutable)));
      process.env.PATH = trusted.directory;
      const definition = getScenario("S12");
      assert.equal(definition.actionId, "create-control-file");
      const command = getCommand(definition.actionId);
      assert.equal(command.executable, nodeExecutable);
      const compiledPath = fileURLToPath(new URL("../../dist/actions/create-file.js", import.meta.url));
      assert.deepEqual(command.args, [compiledPath]);
      const actionBytes = await fs.readFile(compiledPath);
      assert.equal(actionBytes.toString("utf8"), compiledAction);

      const supportPath = await fs.mkdtemp(join(base, "twin-test-s12-"));
      proof.acquiredSupportPath = supportPath;
      proof.roots.push(supportPath);
      support = { path: supportPath, token: supportToken, identity: null };
      supports.add(support); // Failure retains the recorded path without inventing authority.
      support.identity = await fs.lstat(supportPath, { bigint: true });
      await fs.chmod(supportPath, 0o700);
      await fs.writeFile(join(supportPath, markerName), support.token, { flag: "wx", mode: 0o600 });
      const scratch = join(supportPath, "scratch");
      await fs.mkdir(scratch, { mode: 0o700 });
      await fs.chmod(scratch, 0o700);
      scratchReady = true;
      await fs.mkdir(join(supportPath, "actions"), { mode: 0o700 });
      actionPath = join(supportPath, "actions/create-file.mjs");
      await fs.writeFile(actionPath, actionBytes, { flag: "wx", mode: 0o600 });
      assert.deepEqual(await fs.readFile(actionPath), actionBytes);
      await verifySupport(support);

      original = await createScenarioRoot();
      proof.roots.push(original.scenarioRoot);
      await initializeScenarioRoot(original);
      workspace = (await verifyWorkspace(original)).workspace;
      phase = "setup";
      const setup: CommandEvidence[] = [];
      await initializeFixture(original, setup);
      phase = "closed";
      assert.equal(setupIndex, 7);
      assert.deepEqual(setup.map(item => item.command.args), setupVectors);
      assert(setup.every(item => item.cwd === workspace));
      before = await observePaths(original, definition.observedPaths);
      baseline(before);
      sourceInventory = await inventory(workspace);
      proof.events.push("original-baseline");
      // Inject only a copy read failure. The real factory still allocates and cleans.
      const open = fs.open;
      const copySpy = fault === "copy" ? vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
        if (args[0] === join(workspace!, "app.js")) {
          // Diagnostics only: these names never authorize deletion.
          proof.twinRoots = (await fs.readdir(scratch)).map(name => join(scratch, name));
          assert.equal(proof.twinRoots.length, 1);
          throw primary;
        }
        return open(...args);
      }) : undefined;
      let copyRestored = false;
      const restoreCopy = (): void => {
        if (!copyRestored) { copySpy?.mockRestore(); copyRestored = true; }
      };
      restores.push(restoreCopy);
      const allocate = fs.mkdtemp;
      const allocationSpy = vi.spyOn(fs, "mkdtemp").mockImplementation(async (...args: Parameters<typeof fs.mkdtemp>) => {
        const path = await allocate(...args);
        if (args[0] === join(scratch, "twin-core-")) {
          assert.equal(expectedTwinWorkspace, undefined, "Only one Twin allocation permitted");
          expectedTwinWorkspace = join(path, "workspace");
        }
        return path;
      });
      restores.push(() => allocationSpy.mockRestore());
      try {
        syncBuiltinESMExports();
        receiptPhase = "before";
        session = await createTwin({ sourceDirectory: workspace, scratchParent: scratch });
        proof.sessions.push(session.workspacePath); // First operation after return.
        proof.twinRoots.push(dirname(session.workspacePath));
      } finally { receiptPhase = "closed"; restoreAll([restoreCopy], restorationErrors, syncBuiltinESMExports); }
      proof.events.push("session-returned");
      assert.equal(session.workspacePath, expectedTwinWorkspace);
      assert.equal(receiptGitCalls.length, 4);
      rejectReceiptGitVariants(session.workspacePath);
      const { callback: rejectedCallback, variants: rejectedVariants } = receiptGitVariants(session.workspacePath);
      let rejectedForwards = 0;
      const forwardingStub = ((_file: unknown, _argv: unknown, _options: unknown, _callback: unknown) => {
        rejectedForwards++;
        throw new Error("Rejected receipt Git call reached forwarding");
      }) as unknown as typeof childProcess.execFile;
      try {
        for (const [file, argv, options, ordinal] of rejectedVariants) {
          execFileSpy.mockImplementation(makeReceiptExecFileGuard(
            () => ({ trustedGit: trusted!.git, workspace: session!.workspacePath, ordinal,
              phase: ordinal < 4 ? "before" : "after", actionCalls: 1 }),
            forwardingStub, () => { throw new Error("Rejected receipt Git call was recorded"); },
          ));
          assert.throws(() => Reflect.apply(childProcess.execFile, childProcess,
            [file, argv, options, rejectedCallback]));
          assert.equal(rejectedForwards, 0, "Rejected receipt Git call forwarded");
        }
        execFileSpy.mockImplementation(makeReceiptExecFileGuard(
          () => ({ trustedGit: trusted!.git, workspace: session!.workspacePath,
            ordinal: receiptGitCalls.length, phase: receiptPhase, actionCalls }),
          forwardingStub, () => { throw new Error("Closed receipt Git call was recorded"); },
        ));
        assert.throws(() => childProcess.execFile("/usr/bin/git", ["--version"],
          { cwd: session!.workspacePath }, () => {}), "Unrelated execFile call must remain blocked");
        assert.equal(rejectedForwards, 0, "Closed receipt Git call forwarded");
      } finally { execFileSpy.mockImplementation(receiptExecFile); }
      assert.equal(receiptGitCalls.length, 4);
      const twinRoot = dirname(session.workspacePath);
      assert.equal(dirname(twinRoot), scratch);
      assert.equal(session.workspacePath, join(twinRoot, "workspace"));
      const readyInspection = session.inspect();
      const { receipt: readyReceipt, ...readyFields } = readyInspection;
      assert.deepEqual(readyFields, { state: "ready", workspacePath: session.workspacePath });
      assert.equal(readyReceipt, undefined);
      const twinBefore = await inventory(session.workspacePath);
      assert.deepEqual(contents(twinBefore), contents(sourceInventory));
      for (const entry of twinBefore) if (entry.kind === "file") {
        const source: Entry | undefined = sourceInventory.find(item => item.path === entry.path);
        assert(source);
        assert(entry.dev !== source.dev || entry.ino !== source.ino, `Shared file identity: ${entry.path}`);
      }
      for (const path of [".git", ".env", "node_modules/lib.txt", "scratch.txt"]) assert(twinBefore.some(item => item.path === path));
      proof.events.push("twin-pre-state");
      if (fault === "before-run") throw primary;
      phase = "action";
      receiptPhase = "after";
      try {
        proof.result = await session.run({ executable: nodeExecutable, argv: [actionPath], env: actionEnv, timeoutMs: 5000 });
      } finally { phase = "closed"; receiptPhase = "closed"; }
      proof.events.push("action-returned");
      assert.equal(receiptGitCalls.length, 8);
      assert.equal(actionCalls, 1);
      assert.deepEqual(proof.result, { schemaVersion: 1, outcome: "exited", started: true, directChildSettled: true,
        exitCode: 0, signal: null, spawnError: null, terminationError: null,
        stdout: { bytes: new Uint8Array(), complete: true, truncated: false, error: null },
        stderr: { bytes: new Uint8Array(), complete: true, truncated: false, error: null } });
      const finishedInspection = session.inspect();
      const { receipt: finishedReceipt, ...finishedFields } = finishedInspection;
      assert.deepEqual(finishedFields, { state: "finished", workspacePath: session.workspacePath });
      assert(finishedReceipt, "Settled S12 run must have a receipt");
      assert(Object.isFrozen(finishedInspection));
      settledReceipt = finishedReceipt;
      assertS12Receipt(finishedReceipt);
      const twinAfter = await inventory(session.workspacePath);
      assert.deepEqual(contents(twinAfter), contents([...twinBefore, { path: "control-created.txt", kind: "file",
        bytes: Buffer.from("S12 control file.\n").toString("base64"), dev: 0n, ino: 0n }]));
      const after = await observePaths(original, definition.observedPaths);
      baseline(after);
      assert.deepEqual(after.paths, before.paths);
      assert.deepEqual(contents(await inventory(workspace)), contents(sourceInventory));
      proof.events.push("post-state");
      if (["after-run", "twin-cleanup", "original-cleanup", "observation"].includes(fault)) throw primary;
      if (["missing-snapshot", "incomplete-snapshot", "wrong-workspace"].includes(fault)) {
        const rejected = fault === "missing-snapshot" ? null : fault === "incomplete-snapshot"
          ? { ...after, complete: false } : { ...after, workspace: session.workspacePath };
        assert.equal((await cleanupScenarioRoot(original, rejected)).status, "refused");
        assert.deepEqual(contents(await inventory(workspace)), contents(sourceInventory));
        proof.events.push("snapshot-refused");
      }
    } catch (error: unknown) { errors.push(error); }
    phase = "closed";
    // Each cleanup/observation is independent; secondary failures never replace primary.
    if (session) await attempt("twin-discard", async () => {
      if (fault === "twin-cleanup") {
        // Real preflight refusal, no deletion: restore this test-owned mode later.
        await fs.chmod(join(support!.path, "scratch"), 0o755);
      }
      const result = await session!.discard();
      twinRefusalInjected = fault === "twin-cleanup" && result.status === "refused"
        && result.reason === `Directory authority mismatch: ${join(support!.path, "scratch")}`;
      assert.equal(result.status, "removed", JSON.stringify(result));
      const discardedInspection = session!.inspect();
      const { receipt: discardedReceipt, ...discardedFields } = discardedInspection;
      assert.deepEqual(discardedFields, { state: "discarded", workspacePath: session!.workspacePath });
      assert(Object.isFrozen(discardedInspection));
      assert.strictEqual(discardedReceipt, settledReceipt);
      if (settledReceipt) assertS12Receipt(settledReceipt);
      else assert.equal(discardedReceipt, undefined);
      await absent(dirname(session!.workspacePath));
      assert.deepEqual(await session!.discard(), { status: "already-removed" });
      await verifySupport(support!);
      assert.equal(await fs.readFile(actionPath!, "utf8"), compiledAction);
      proof.events.push("twin-removed");
    });
    let cleanupSnapshot: Snapshot | null = null;
    if (original) {
      await attempt("original-observe", async () => {
        if (fault === "observation") throw new Error("Injected final observation failure");
        cleanupSnapshot = await observePaths(original!, getScenario("S12").observedPaths);
        if (before) { baseline(cleanupSnapshot); assert.deepEqual(cleanupSnapshot.paths, before.paths); }
        if (workspace && sourceInventory) assert.deepEqual(contents(await inventory(workspace)), contents(sourceInventory));
      });
      await attempt("original-cleanup", async () => {
        if (fault === "original-cleanup") cleanupSnapshot = null;
        const result = await cleanupScenarioRoot(original!, cleanupSnapshot);
        originalRefusalInjected = (fault === "original-cleanup" || fault === "observation") && result.status === "refused";
        assert.equal(result.status, "removed", JSON.stringify(result));
        await absent(original!.scenarioRoot);
        proof.events.push("original-removed");
      });
    }
    // Account for synthetic refusals before releasing their known cause. Never retry
    // partial deletion or an unexplained refusal, and never adopt discovered roots.
    if (support && scratchReady) await attempt("scratch-accounting", async () => {
      proof.remainingTwinRoots = (await fs.readdir(join(support!.path, "scratch"))).sort();
      if (twinRefusalInjected) {
        assert(session);
        assert.deepEqual(proof.remainingTwinRoots, [relative(join(support!.path, "scratch"), dirname(session.workspacePath))]);
        proof.events.push("injected-twin-retention-accounted");
        await fs.chmod(join(support!.path, "scratch"), 0o700);
        const result = await session.discard();
        assert.equal(result.status, "removed", JSON.stringify(result));
        proof.events.push("injected-twin-released");
      }
      proof.remainingTwinRoots = (await fs.readdir(join(support!.path, "scratch"))).sort();
      assert.deepEqual(proof.remainingTwinRoots, []);
    });
    if (original && originalRefusalInjected) await attempt("injected-original-release", async () => {
      const fresh = await observePaths(original!, getScenario("S12").observedPaths);
      assert(fresh.complete);
      const result = await cleanupScenarioRoot(original!, fresh);
      assert.equal(result.status, "removed", JSON.stringify(result));
      await absent(original!.scenarioRoot);
    });
    if (support) await attempt("support-cleanup", async () => { await removeSupport(support!); await absent(support!.path); });
    await attempt("root-accounting", async () => {
      if (base) proof.afterRoots = await rootNames(base);
      proof.registeredSupports = [...supports].map(root => root.path);
      assert.deepEqual(proof.afterRoots, proof.beforeRoots);
      assert.deepEqual(proof.registeredSupports, []);
      assert.equal(receiptGitCalls.length, session ? (proof.result ? 8 : 4) : 0);
    });
  } catch (error: unknown) { errors.push(error); }
  finally {
    restoreAll([() => {
      if (oldPath === undefined) delete process.env.PATH;
      else process.env.PATH = oldPath;
    }, ...restores.toReversed()], restorationErrors, syncBuiltinESMExports);
    errors.push(...restorationErrors);
  }
  console.log(`TWIN S12 ACCOUNTING ${JSON.stringify({ fault, acquiredSupportPath: proof.acquiredSupportPath, roots: proof.roots, twinRoots: proof.twinRoots,
    sessions: proof.sessions, setupLaunches: proof.launches.filter(item => item.phase === "setup").length,
    actionLaunches: proof.launches.filter(item => item.phase === "action").length, receiptGitLaunches: receiptGitCalls.length,
    before: proof.beforeRoots, after: proof.afterRoots, remainingTwinRoots: proof.remainingTwinRoots,
    registeredSupports: proof.registeredSupports })}`);
  return completeProof(proof, errors);
}
