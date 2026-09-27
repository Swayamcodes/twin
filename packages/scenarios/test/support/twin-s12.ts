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
}
interface AdmittedSpawn {
  executable: string;
  argv: string[];
  options: { cwd: string; shell: false; env: Record<string, string>; detached: false;
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
  assert(detached === undefined || detached === false, "Detached execution forbidden");
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
const compiledAction = 'import { writeFile } from "node:fs/promises";\n'
  + 'await writeFile("control-created.txt", "S12 control file.\\n", { flag: "wx" });\n';

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
  const errors: unknown[] = [];
  const restorationErrors: unknown[] = [];
  const primary = new Error(`Injected ${fault}`);
  let base: string | undefined, support: SupportRoot | undefined, original: OwnedScenarioRoot | undefined;
  let session: TwinSession | undefined, workspace: string | undefined, actionPath: string | undefined;
  let before: Snapshot | undefined, sourceInventory: Entry[] | undefined;
  let trusted: ReturnType<typeof resolveTrustedSystemGit> | undefined;
  let phase: "closed" | "setup" | "action" = "closed";
  let setupIndex = 0, actionCalls = 0;
  let scratchReady = false, twinRefusalInjected = false, originalRefusalInjected = false;
  const oldPath = process.env.PATH;
  const nodeExecutable = process.execPath;
  const originalSpawn = childProcess.spawn;
  const restores: (() => void)[] = [];
  const attempt = async (event: string, body: () => Promise<void>): Promise<void> => {
    proof.events.push(event);
    try { await body(); } catch (error: unknown) { errors.push(error); }
  };
  try {
    try {
      // Guard all direct child_process entry points for this serial test's lifetime.
      for (const method of ["exec", "execFile", "fork", "execSync", "execFileSync", "spawnSync"] as const) {
        const spy = vi.spyOn(childProcess, method).mockImplementation(() => { throw new Error("S12 proof forbids this launch API"); });
        restores.push(() => spy.mockRestore());
      }
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
            cwd: session.workspacePath, env: actionEnv });
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
      try {
        syncBuiltinESMExports();
        session = await createTwin({ sourceDirectory: workspace, scratchParent: scratch });
        proof.sessions.push(session.workspacePath); // First operation after return.
        proof.twinRoots.push(dirname(session.workspacePath));
      } finally { restoreAll([restoreCopy], restorationErrors, syncBuiltinESMExports); }
      proof.events.push("session-returned");
      const twinRoot = dirname(session.workspacePath);
      assert.equal(dirname(twinRoot), scratch);
      assert.equal(session.workspacePath, join(twinRoot, "workspace"));
      assert.deepEqual(session.inspect(), { state: "ready", workspacePath: session.workspacePath });
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
      try {
        proof.result = await session.run({ executable: nodeExecutable, argv: [actionPath], env: actionEnv, timeoutMs: 5000 });
      } finally { phase = "closed"; }
      proof.events.push("action-returned");
      assert.equal(actionCalls, 1);
      assert.deepEqual(proof.result, { schemaVersion: 1, outcome: "exited", started: true, directChildSettled: true,
        exitCode: 0, signal: null, spawnError: null, terminationError: null,
        stdout: { bytes: new Uint8Array(), complete: true, truncated: false, error: null },
        stderr: { bytes: new Uint8Array(), complete: true, truncated: false, error: null } });
      assert.deepEqual(session.inspect(), { state: "finished", workspacePath: session.workspacePath });
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
      assert.deepEqual(session!.inspect(), { state: "discarded", workspacePath: session!.workspacePath });
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
    actionLaunches: proof.launches.filter(item => item.phase === "action").length,
    before: proof.beforeRoots, after: proof.afterRoots, remainingTwinRoots: proof.remainingTwinRoots,
    registeredSupports: proof.registeredSupports })}`);
  return completeProof(proof, errors);
}
