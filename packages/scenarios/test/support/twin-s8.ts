import assert from "node:assert/strict";
import childProcess, { type SpawnOptions } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs, { constants, type BigIntStats } from "node:fs";
import fsp from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { isProxy } from "node:util/types";
import { vi } from "vitest";
import { createTwin, type RunResult, type TwinSession } from "@twin-cli/core";

export const repository = fileURLToPath(new URL("../../../..", import.meta.url));
export const fixtureIdentity = "twin-s8-nongit-v1";
export const actionIdentity = "twin-s8-delete-v1";
export const successLine = "TWIN_S8_DELETE_OK\n";
export const failureLine = "TWIN_S8_DELETE_FAILURE\n";
const markerName = ".twin-s8-owner";
const actionName = "delete-one-file.mjs";
const environment = Object.freeze({ LANG: "C", LC_ALL: "C", TZ: "UTC" });
const fixtureFiles = Object.freeze({
  "delete-me.txt": "S8 disposable target.\n",
  ".control": "S8 dotfile control.\n",
  "controls/keep.txt": "S8 nested control.\n",
});
const moduleSource = `import { lstatSync, unlinkSync } from "node:fs";
let deleted = false;
try {
  if (process.argv.length !== 2) throw new Error("arguments forbidden");
  const target = lstatSync("delete-me.txt");
  if (!target.isFile()) throw new Error("target is not a regular file");
  unlinkSync("delete-me.txt");
  deleted = true;
} catch {
  process.stderr.write("TWIN_S8_DELETE_FAILURE\\n");
  process.exitCode = 1;
}
if (deleted) process.stdout.write("TWIN_S8_DELETE_OK\\n");
`;
const fixedBytes = Buffer.from(moduleSource, "utf8");

type Disposition = "removed" | "retained" | "unknown";
interface Acquired { path: string; state: Disposition }
interface Registration {
  path: string;
  parent: string;
  token: string;
  identity: BigIntStats | null;
  parentIdentity: BigIntStats;
  marker: BigIntStats | null;
  entries: Map<string, BigIntStats>;
  deletionStarted: boolean;
  removed: boolean;
}
interface Entry { path: string; kind: "file" | "directory"; bytes: Buffer; mode: bigint; dev: bigint; ino: bigint }
const supports = new Set<Registration>();
const originals = new Set<Registration>();
function same(a: BigIntStats, b: BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino && (a.mode & 0o170000n) === (b.mode & 0o170000n);
}
function inside(parent: string, child: string): boolean {
  const suffix = relative(parent, child);
  return suffix === "" || (!isAbsolute(suffix) && suffix !== ".." && !suffix.startsWith(`..${sep}`));
}
async function canonicalMissing(path: string): Promise<string> {
  try { return await fsp.realpath(path); }
  catch (error: unknown) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT") || dirname(path) === path) throw error;
    return join(await canonicalMissing(dirname(path)), relative(dirname(path), path));
  }
}
export async function checkedBase(): Promise<string> {
  const supplied = resolve(tmpdir());
  const excluded = [repository, join(homedir(), ".local/state/twin")];
  if (process.env.XDG_STATE_HOME) excluded.push(resolve(process.env.XDG_STATE_HOME, "twin"));
  for (const path of excluded) assert(!inside(resolve(path), supplied), "Forbidden supplied temporary base");
  const base = await fsp.realpath(supplied);
  for (const path of excluded) {
    const canonical = await canonicalMissing(resolve(path));
    assert(!inside(canonical, base) && !inside(canonical, supplied), "Forbidden canonical temporary base");
  }
  assert(!inside(base, repository) && !inside(base, homedir()), "Temporary base contains protected tree");
  return base;
}
async function rootNames(base: string): Promise<string[]> {
  return (await fsp.readdir(base)).filter(name => name.startsWith("twin-test-s8-") || name.startsWith("twin-core-")).sort();
}
function statFixed(path: string, expected: BigIntStats, directory: boolean): BigIntStats {
  const actual = fs.lstatSync(path, { bigint: true });
  assert(same(actual, expected) && actual.uid === BigInt(process.getuid!()), "Registered identity or owner changed");
  assert(directory ? actual.isDirectory() : actual.isFile(), "Registered entry type changed");
  assert.equal(actual.mode & 0o777n, directory ? 0o700n : 0o600n, "Registered mode changed");
  if (directory) assert.equal(fs.realpathSync(path), path, "Registered directory is not canonical");
  else assert.equal(actual.nlink, 1n, "Registered file link count changed");
  return actual;
}
function verify(reg: Registration, registry: Set<Registration>): void {
  assert(registry.has(reg) && !reg.removed && reg.identity, "Registration unavailable");
  assert.equal(dirname(reg.path), reg.parent);
  const parent = fs.lstatSync(reg.parent, { bigint: true });
  assert(parent.isDirectory() && same(parent, reg.parentIdentity) && fs.realpathSync(reg.parent) === reg.parent,
    "Temporary parent identity changed");
  statFixed(reg.path, reg.identity, true);
  if (reg.marker) {
    const markerPath = join(reg.path, markerName);
    statFixed(markerPath, reg.marker, false);
    const handle = fs.openSync(markerPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      assert(same(fs.fstatSync(handle, { bigint: true }), reg.marker));
      assert(fs.readFileSync(handle).equals(Buffer.from(reg.token)), "Marker bytes changed");
    } finally { fs.closeSync(handle); }
  }
}
async function acquire(base: string, prefix: string, token: string, registry: Set<Registration>, acquired: Acquired[]): Promise<Registration> {
  const parentIdentity = await fsp.lstat(base, { bigint: true });
  assert(parentIdentity.isDirectory() && await fsp.realpath(base) === base);
  const path = await fsp.mkdtemp(join(base, prefix));
  acquired.push({ path, state: "unknown" }); // Before registration or mutation.
  const reg: Registration = { path, parent: base, token, parentIdentity, identity: null,
    marker: null, entries: new Map(), deletionStarted: false, removed: false };
  registry.add(reg);
  reg.identity = await fsp.lstat(path, { bigint: true });
  await fsp.chmod(path, 0o700);
  const marker = join(path, markerName);
  await fsp.writeFile(marker, token, { flag: "wx", mode: 0o600 });
  await fsp.chmod(marker, 0o600);
  reg.marker = await fsp.lstat(marker, { bigint: true });
  verify(reg, registry);
  return reg;
}
async function directory(reg: Registration, name: string): Promise<void> {
  const path = join(reg.path, name);
  await fsp.mkdir(path, { mode: 0o700 });
  await fsp.chmod(path, 0o700);
  reg.entries.set(name, await fsp.lstat(path, { bigint: true }));
}
async function file(reg: Registration, name: string, bytes: Buffer): Promise<void> {
  const path = join(reg.path, name);
  await fsp.writeFile(path, bytes, { flag: "wx", mode: 0o600 });
  await fsp.chmod(path, 0o600);
  reg.entries.set(name, await fsp.lstat(path, { bigint: true }));
}
function exactNames(path: string, names: readonly string[]): void {
  assert.deepEqual(fs.readdirSync(path).sort(), [...names].sort(), `Unexpected owned entry: ${path}`);
}
export function verifyAsset(reg: Registration): string {
  verify(reg, supports);
  const actions = reg.entries.get("actions"), asset = reg.entries.get(`actions/${actionName}`);
  assert(actions && asset, "Action ownership incomplete");
  const directoryPath = join(reg.path, "actions"), path = join(directoryPath, actionName);
  statFixed(directoryPath, actions, true);
  assert(inside(reg.path, path) && !inside(repository, path), "Action containment mismatch");
  assert.equal(fs.realpathSync(path), path, "Action is not canonical");
  statFixed(path, asset, false);
  const descriptor = fs.openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    assert(same(fs.fstatSync(descriptor, { bigint: true }), asset), "Action descriptor identity changed");
    const actual = fs.readFileSync(descriptor);
    assert(actual.equals(fixedBytes), "S8 action byte mismatch");
    assert(same(fs.lstatSync(path, { bigint: true }), asset), "Action identity changed during read");
    return createHash("sha256").update(actual).digest("hex");
  } finally { fs.closeSync(descriptor); }
}
function gitFree(entries: readonly Entry[]): void {
  for (const entry of entries) {
    const parts = entry.path.split("/");
    assert(!parts.some(part => [".git", ".gitmodules"].includes(part.toLowerCase())), "Git metadata entry found");
  }
  // Refuse the recognizable bare-repository inventory at every directory depth.
  for (const directory of entries.filter(entry => entry.kind === "directory")) {
    const path = directory.path === "" ? "" : `${directory.path}/`;
    const immediate = new Set(entries.filter(entry => entry.path.startsWith(path)
      && !entry.path.slice(path.length).includes("/")).map(entry => entry.path.slice(path.length).toLowerCase()));
    assert(!["head", "objects", "refs"].every(name => immediate.has(name)), "Bare Git inventory found");
  }
}
async function inventory(root: string): Promise<Entry[]> {
  const found: Entry[] = [];
  const visit = async (path: string): Promise<void> => {
    const stat = await fsp.lstat(path, { bigint: true });
    assert(stat.isDirectory() || stat.isFile(), "Unsupported inventory entry");
    if (stat.isFile()) assert.equal(stat.nlink, 1n, "Fixture file has multiple links");
    const entry: Entry = { path: relative(root, path), kind: stat.isDirectory() ? "directory" : "file",
      bytes: stat.isFile() ? await fsp.readFile(path) : Buffer.alloc(0), mode: stat.mode & 0o777n,
      dev: stat.dev, ino: stat.ino };
    found.push(entry);
    if (stat.isDirectory()) for (const name of (await fsp.readdir(path)).sort()) await visit(join(path, name));
  };
  await visit(root);
  gitFree(found);
  return found;
}
function content(entries: readonly Entry[]): readonly (readonly [string, string, bigint, string])[] {
  return entries.map(e => [e.path, e.kind, e.mode, e.bytes.toString("hex")] as const);
}
function exactFixture(entries: readonly Entry[]): void {
  assert.deepEqual(entries.map(e => [e.path, e.kind, e.mode]), [
    ["", "directory", 0o700n], [".control", "file", 0o600n],
    ["controls", "directory", 0o700n], ["controls/keep.txt", "file", 0o600n],
    ["delete-me.txt", "file", 0o600n],
  ]);
  for (const [name, text] of Object.entries(fixtureFiles)) {
    assert(entries.find(e => e.path === name)?.bytes.equals(Buffer.from(text)), `Fixture bytes changed: ${name}`);
  }
}
function sameContent(actual: readonly Entry[], expected: readonly Entry[]): void {
  assert.deepEqual(content(actual), content(expected), "Complete inventory differs");
}
function sameInventory(actual: readonly Entry[], expected: readonly Entry[]): void {
  sameContent(actual, expected);
  assert.deepEqual(actual.map(e => [e.path, e.dev, e.ino]), expected.map(e => [e.path, e.dev, e.ino]),
    "Inventory identity differs");
}
async function originalInventory(reg: Registration, baseline: readonly Entry[]): Promise<void> {
  verify(reg, originals);
  assert.equal(fs.readdirSync(reg.path).sort().join("\0"), [markerName, "workspace"].sort().join("\0"));
  const workspace = reg.entries.get("workspace");
  assert(workspace);
  statFixed(join(reg.path, "workspace"), workspace, true);
  sameInventory(await inventory(join(reg.path, "workspace")), baseline);
}
function removeRegisteredEntry(reg: Registration, name: string, directoryEntry: boolean): void {
  const expected = reg.entries.get(name);
  assert(expected, `Unregistered cleanup entry: ${name}`);
  const path = join(reg.path, name);
  statFixed(path, expected, directoryEntry);
  reg.deletionStarted = true;
  if (directoryEntry) fs.rmdirSync(path); else fs.unlinkSync(path);
}
function finishRoot(reg: Registration, registry: Set<Registration>): void {
  verify(reg, registry);
  assert(reg.marker);
  statFixed(join(reg.path, markerName), reg.marker, false);
  reg.deletionStarted = true;
  fs.unlinkSync(join(reg.path, markerName));
  statFixed(reg.path, reg.identity!, true);
  fs.rmdirSync(reg.path);
  reg.removed = true;
  registry.delete(reg);
}
function cleanupOriginal(reg: Registration, baseline: readonly Entry[] | null): void {
  assert(!reg.deletionStarted, "Partial original deletion cannot be retried");
  assert(baseline, "Original cleanup refused: missing fresh observation");
  verify(reg, originals);
  assert(reg.entries.size === 1 + Object.keys(fixtureFiles).length + 1, "Original registration incomplete");
  // The fresh recursive observation is the deletion prerequisite.
  const workspace = join(reg.path, "workspace");
  const current = fs.readdirSync(workspace).sort();
  assert.deepEqual(current, [".control", "controls", "delete-me.txt"].sort());
  exactNames(join(workspace, "controls"), ["keep.txt"]);
  sameInventory(syncInventory(workspace), baseline);
  for (const name of ["workspace/.control", "workspace/controls/keep.txt", "workspace/delete-me.txt"]) removeRegisteredEntry(reg, name, false);
  removeRegisteredEntry(reg, "workspace/controls", true);
  removeRegisteredEntry(reg, "workspace", true);
  finishRoot(reg, originals);
}
function syncInventory(root: string): Entry[] {
  const found: Entry[] = [];
  const visit = (path: string): void => {
    const stat = fs.lstatSync(path, { bigint: true });
    assert(stat.isDirectory() || stat.isFile(), "Unsupported inventory entry");
    if (stat.isFile()) assert.equal(stat.nlink, 1n, "Fixture file has multiple links");
    found.push({ path: relative(root, path), kind: stat.isDirectory() ? "directory" : "file",
      bytes: stat.isFile() ? fs.readFileSync(path) : Buffer.alloc(0), mode: stat.mode & 0o777n,
      dev: stat.dev, ino: stat.ino });
    if (stat.isDirectory()) for (const name of fs.readdirSync(path).sort()) visit(join(path, name));
  };
  visit(root); gitFree(found); return found;
}
function cleanupSupport(reg: Registration): void {
  assert(!reg.deletionStarted, "Partial support deletion cannot be retried");
  verify(reg, supports);
  exactNames(reg.path, [markerName, "actions", "scratch"]);
  exactNames(join(reg.path, "actions"), [actionName]);
  exactNames(join(reg.path, "scratch"), []);
  assert(reg.entries.size === 3, "Support registration incomplete");
  for (const name of ["actions", "scratch"]) statFixed(join(reg.path, name), reg.entries.get(name)!, true);
  statFixed(join(reg.path, `actions/${actionName}`), reg.entries.get(`actions/${actionName}`)!, false);
  removeRegisteredEntry(reg, `actions/${actionName}`, false);
  removeRegisteredEntry(reg, "actions", true);
  removeRegisteredEntry(reg, "scratch", true);
  finishRoot(reg, supports);
}

export interface LaunchState { installed: boolean; dispatch: boolean; preState: boolean; sessionState: string | null }
export interface Admitted {
  executable: string;
  argv: string[];
  options: { cwd: string; shell: false; detached: true; stdio: ["ignore", "pipe", "pipe"]; env: Record<string, string> };
}
function data(object: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  assert(descriptor && "value" in descriptor, `Accessor or missing ${key} rejected`);
  return descriptor.value;
}
function plain(object: unknown): asserts object is Record<string, unknown> {
  assert(object && typeof object === "object" && (Object.getPrototypeOf(object) === Object.prototype
    || Object.getPrototypeOf(object) === null), "Expected plain object");
}
export class ActionGate {
  private consumed = false;
  constructor(private readonly node: string, private readonly asset: string, private readonly cwd: string) {}
  admit(command: unknown, inputArgv: unknown, inputOptions: unknown, state: LaunchState): Admitted {
    assert(!this.consumed, "Only one S8 action permitted");
    this.consumed = true; // Before caller-controlled reflection or iteration.
    assert(state.installed && state.dispatch && state.preState && state.sessionState === "running", "Action lifecycle closed");
    assert(!isProxy(inputArgv), "Proxy argv rejected");
    assert(Array.isArray(inputArgv) && !Object.hasOwn(inputArgv, Symbol.iterator), "Custom argv iterator rejected");
    assert.deepEqual(Reflect.ownKeys(inputArgv), ["0", "length"], "Argv must be one dense element");
    const argv = [data(inputArgv, "0")];
    assert(!isProxy(inputOptions), "Proxy options rejected");
    plain(inputOptions);
    assert.deepEqual(Reflect.ownKeys(inputOptions).sort(), ["cwd", "shell", "detached", "stdio", "env"].sort());
    const cwd = data(inputOptions, "cwd"), shell = data(inputOptions, "shell");
    const detached = data(inputOptions, "detached"), inputStdio = data(inputOptions, "stdio");
    const inputEnv = data(inputOptions, "env");
    assert(!isProxy(inputStdio), "Proxy stdio rejected");
    assert(Array.isArray(inputStdio) && !Object.hasOwn(inputStdio, Symbol.iterator), "Custom stdio iterator rejected");
    assert.deepEqual(Reflect.ownKeys(inputStdio), ["0", "1", "2", "length"]);
    const stdio = [data(inputStdio, "0"), data(inputStdio, "1"), data(inputStdio, "2")];
    assert(!isProxy(inputEnv), "Proxy environment rejected");
    plain(inputEnv);
    assert.deepEqual(Reflect.ownKeys(inputEnv).sort(), ["LANG", "LC_ALL", "TZ"].sort());
    const env: Record<string, string> = { LANG: data(inputEnv, "LANG") as string,
      LC_ALL: data(inputEnv, "LC_ALL") as string, TZ: data(inputEnv, "TZ") as string };
    assert.equal(command, this.node);
    assert(isAbsolute(this.node) && !this.node.includes("\0"));
    assert.deepEqual(argv, [this.asset]);
    assert.equal(cwd, this.cwd);
    assert.equal(shell, false); assert.equal(detached, true);
    assert.deepEqual(stdio, ["ignore", "pipe", "pipe"]);
    assert.deepEqual(env, environment);
    return { executable: this.node, argv: [this.asset], options: { cwd: this.cwd, shell: false,
      detached: true, stdio: ["ignore", "pipe", "pipe"], env: { ...environment } } };
  }
}
export function forbidChildApi(): never { throw new Error("S8 forbids alternate child APIs"); }
export function restoreAll(restores: readonly (() => void)[], errors: unknown[], synchronize: () => void): void {
  for (const restore of restores) try { restore(); } catch (error: unknown) { errors.push(error); }
  try { synchronize(); } catch (error: unknown) { errors.push(error); }
}
export type Fault = "none" | "token" | "preparation" | "asset-mismatch" | "hardlink" | "copy" | "before-action"
  | "missing-target" | "launch-reject" | "observation" | "twin-refusal" | "original-refusal";
export interface Proof {
  readonly fault: Fault;
  readonly events: string[];
  readonly acquired: Acquired[];
  readonly supports: string[];
  readonly originals: string[];
  readonly twins: string[];
  readonly sessions: string[];
  readonly beforeRoots: string[];
  readonly afterRoots: string[];
  readonly remainingScratch: string[];
  readonly registeredSupports: string[];
  readonly registeredOriginals: string[];
  readonly realActions: number;
  readonly rejectedAttempts: number;
  readonly actionSha256: string | null;
  readonly result: RunResult | null;
}
export class ProofFailure extends AggregateError {
  constructor(errors: readonly unknown[], readonly proof: Proof) { super(errors, `S8 proof failed: ${proof.fault}`, { cause: errors[0] }); }
}
let active = false, unsafeFailure = false;
export async function proveTwinS8(fault: Fault = "none"): Promise<Proof> {
  assert(!active && !unsafeFailure, "S8 worker requires restored serial execution");
  active = true;
  const acquired: Acquired[] = [], supportsAcquired: string[] = [], originalsAcquired: string[] = [];
  const twins: string[] = [], sessions: string[] = [], events: string[] = [], beforeRoots: string[] = [];
  let afterRoots: string[] = [], remainingScratch: string[] = [], registeredSupports: string[] = [], registeredOriginals: string[] = [];
  let realActions = 0, rejectedAttempts = 0, actionSha256: string | null = null, result: RunResult | null = null;
  const errors: unknown[] = [], restorationErrors: unknown[] = [], restores: (() => void)[] = [];
  const primary = new Error(`Injected ${fault}`), nativeSpawn = childProcess.spawn, node = process.execPath;
  let base: string | undefined, support: Registration | undefined, original: Registration | undefined;
  let workspace: string | undefined, scratch: string | undefined, session: TwinSession | undefined;
  let originalBefore: Entry[] | undefined, twinBefore: Entry[] | undefined, twinWorkspace: string | undefined;
  let twinIdentity: BigIntStats | undefined, dispatch = false, preState = false, installed = false;
  let gate: ActionGate | undefined;
  const attempt = async (event: string, work: () => Promise<void>): Promise<void> => {
    events.push(event); try { await work(); } catch (error: unknown) { errors.push(error); }
  };
  const checkOriginal = async (): Promise<void> => {
    assert(original && originalBefore);
    await originalInventory(original, originalBefore);
  };
  try {
    try {
      for (const method of ["exec", "execFile", "fork", "execSync", "execFileSync", "spawnSync"] as const) {
        const spy = vi.spyOn(childProcess, method).mockImplementation(forbidChildApi);
        restores.push(() => spy.mockRestore());
      }
      const guarded = ((command: string, argv: readonly string[], options: SpawnOptions) => {
        assert(installed && childProcess.spawn === guardedSpawn, "S8 guard absent");
        assert(gate && session && twinWorkspace && twinIdentity && support && scratch);
        const admitted = gate.admit(command, argv, options, { installed, dispatch, preState, sessionState: session.inspect().state });
        assert(dispatch && preState && session.inspect().state === "running", "Action dispatch changed");
        assert.equal(session.workspacePath, twinWorkspace);
        assert.equal(dirname(dirname(twinWorkspace)), scratch);
        statFixed(twinWorkspace, twinIdentity, true);
        assert.equal(admitted.options.cwd, twinWorkspace);
        assert.equal(verifyAsset(support), actionSha256);
        if (fault === "launch-reject") { rejectedAttempts++; throw primary; }
        realActions++;
        return nativeSpawn(admitted.executable, [...admitted.argv], { ...admitted.options,
          env: { ...admitted.options.env }, stdio: ["ignore", "pipe", "pipe"] });
      }) as typeof childProcess.spawn;
      const spawnSpy = vi.spyOn(childProcess, "spawn").mockImplementation(guarded);
      const guardedSpawn = childProcess.spawn;
      restores.push(() => spawnSpy.mockRestore());
      syncBuiltinESMExports(); installed = true;
      base = await checkedBase(); beforeRoots.push(...await rootNames(base));
      if (fault === "token") throw primary;
      const supportToken = randomBytes(32).toString("hex") + "\n";
      const originalToken = randomBytes(32).toString("hex") + "\n";
      if (fault === "preparation") throw primary;
      assert(fixedBytes.length > 0 && Object.keys(fixtureFiles).length === 3);
      const allocated = fsp.mkdtemp;
      const allocationSpy = vi.spyOn(fsp, "mkdtemp").mockImplementation(async (...args: Parameters<typeof fsp.mkdtemp>) => {
        const path = await allocated(...args);
        if (scratch && dirname(path) === scratch) { twins.push(path); acquired.push({ path, state: "unknown" }); }
        return path;
      });
      restores.push(() => allocationSpy.mockRestore()); syncBuiltinESMExports();
      support = await acquire(base, "twin-test-s8-support-", supportToken, supports, acquired);
      supportsAcquired.push(support.path);
      await directory(support, "actions"); await directory(support, "scratch");
      scratch = join(support.path, "scratch");
      await file(support, `actions/${actionName}`, fixedBytes);
      actionSha256 = verifyAsset(support);
      if (fault === "asset-mismatch") {
        await fsp.writeFile(join(support.path, "actions", actionName), "changed\n");
        verifyAsset(support); throw new Error("Asset mismatch was accepted");
      }
      original = await acquire(base, "twin-test-s8-original-", originalToken, originals, acquired);
      originalsAcquired.push(original.path);
      await directory(original, "workspace");
      await directory(original, "workspace/controls");
      for (const [name, value] of Object.entries(fixtureFiles)) await file(original, `workspace/${name}`, Buffer.from(value));
      workspace = join(original.path, "workspace");
      originalBefore = await inventory(workspace); exactFixture(originalBefore);
      if (fault === "hardlink") {
        const target = join(workspace, "delete-me.txt");
        await fsp.unlink(target);
        await fsp.link(join(workspace, ".control"), target);
        try {
          await assert.rejects(inventory(workspace), /Fixture file has multiple links/);
          events.push("hardlink-rejected");
        } finally {
          await fsp.unlink(target);
          await file(original, "workspace/delete-me.txt", Buffer.from(fixtureFiles["delete-me.txt"]));
        }
        originalBefore = await inventory(workspace); exactFixture(originalBefore);
        throw primary;
      }
      events.push("original-baseline");
      const open = fsp.open;
      const copySpy = fault === "copy" ? vi.spyOn(fsp, "open").mockImplementation(async (...args: Parameters<typeof fsp.open>) => {
        if (args[0] === join(workspace!, "delete-me.txt")) throw primary;
        return open(...args);
      }) : undefined;
      let copyRestored = false;
      const restoreCopy = (): void => { if (!copyRestored) { copySpy?.mockRestore(); copyRestored = true; } };
      restores.push(restoreCopy);
      try {
        syncBuiltinESMExports();
        session = await createTwin({ sourceDirectory: workspace, scratchParent: scratch });
        sessions.push(session.workspacePath); // First operation after return.
        twinWorkspace = session.workspacePath;
      } finally { restoreAll([restoreCopy], restorationErrors, syncBuiltinESMExports); }
      assert.equal(restorationErrors.length, 0, "Copy instrumentation restoration failed");
      events.push("session-returned");
      assert.deepEqual(session.inspect(), { workspacePath: twinWorkspace, state: "ready" });
      assert.equal(dirname(dirname(twinWorkspace)), scratch);
      assert.deepEqual(twins, [dirname(twinWorkspace)]);
      twinIdentity = await fsp.lstat(twinWorkspace, { bigint: true });
      twinBefore = await inventory(twinWorkspace);
      sameContent(twinBefore, originalBefore); exactFixture(twinBefore);
      for (const copied of twinBefore.filter(e => e.kind === "file")) {
        const source: Entry | undefined = originalBefore.find(e => e.path === copied.path);
        assert(source && (copied.dev !== source.dev || copied.ino !== source.ino), "Shared regular file identity");
      }
      events.push("twin-pre-state");
      if (fault === "before-action") throw primary;
      if (fault === "missing-target") {
        await fsp.unlink(join(twinWorkspace, "delete-me.txt"));
        twinBefore = await inventory(twinWorkspace);
        sameContent(twinBefore, originalBefore.filter(e => e.path !== "delete-me.txt"));
        events.push("negative-pre-state");
      }
      preState = true; gate = new ActionGate(node, join(support.path, "actions", actionName), twinWorkspace);
      dispatch = true;
      try { result = await session.run({ executable: node, argv: [join(support.path, "actions", actionName)],
        env: environment, timeoutMs: 5000 }); }
      finally { dispatch = false; }
      events.push("action-returned");
      if (fault === "launch-reject") {
        assert.equal(realActions, 0);
        assert.equal(result.outcome, "spawn-failed");
        assert.equal(result.started, false);
        assert.equal(result.directChildSettled, true);
        assert.equal(result.spawnError, primary.message);
        throw primary;
      }
      try { assertResult(result, fault === "missing-target"); }
      catch (error: unknown) { unsafeFailure = true; throw error; }
      assert.equal(session.inspect().state, "finished");
    } catch (error: unknown) { errors.push(error); }
    dispatch = false; preState = false;
    if (session && twinWorkspace && twinBefore) await attempt("twin-post-state", async () => {
      if (fault === "observation") throw primary;
      assert.notEqual(session!.inspect().state, "child-unsettled");
      const expected = realActions && fault !== "missing-target"
        ? twinBefore!.filter(e => e.path !== "delete-me.txt") : twinBefore!;
      sameInventory(await inventory(twinWorkspace!), expected);
    });
    if (original && originalBefore) await attempt("original-after-action", checkOriginal);
    let knownTwinRefusal = false, knownOriginalRefusal = false;
    if (session) await attempt("twin-discard", async () => {
      if (fault === "twin-refusal") await fsp.chmod(scratch!, 0o755);
      const outcome = await session!.discard();
      knownTwinRefusal = fault === "twin-refusal" && outcome.status === "refused";
      assert.equal(outcome.status, "removed", `Twin discard ${outcome.status}`);
      await confirmTwinRemoved(session!);
      events.push("twin-removed");
    });
    if (original && originalBefore) {
      await attempt("original-after-discard", checkOriginal);
      await attempt("original-cleanup", async () => {
        if (fault === "original-refusal") {
          const before = original!.deletionStarted;
          try { cleanupOriginal(original!, null); }
          catch (error: unknown) { knownOriginalRefusal = true; assert.equal(original!.deletionStarted, before); throw error; }
          throw new Error("Missing original observation was accepted");
        }
        cleanupOriginal(original!, originalBefore!);
        await absent(original!.path);
      });
    }
    if (knownTwinRefusal) await attempt("injected-twin-release", async () => {
      assert(session && scratch && twinWorkspace);
      assert.deepEqual(await fsp.readdir(scratch), [relative(scratch, dirname(twinWorkspace))]);
      await fsp.chmod(scratch, 0o700);
      assert.equal((await session.discard()).status, "removed");
      await confirmTwinRemoved(session);
      events.push("twin-removed");
    });
    if (knownOriginalRefusal) await attempt("injected-original-release", async () => {
      assert(original && originalBefore);
      await originalInventory(original, originalBefore);
      cleanupOriginal(original, originalBefore);
      await absent(original.path);
    });
    if (support) {
      await attempt("scratch-accounting", async () => {
        remainingScratch = (await fsp.readdir(join(support!.path, "scratch"))).sort();
        assert.deepEqual(remainingScratch, []);
      });
      await attempt("support-cleanup", async () => { cleanupSupport(support!); await absent(support!.path); });
    }
  } catch (error: unknown) { errors.push(error); }
  finally {
    dispatch = false; preState = false; installed = false;
    restoreAll(restores.toReversed(), restorationErrors, syncBuiltinESMExports);
    errors.push(...restorationErrors);
    for (const entry of acquired) {
      try { await fsp.lstat(entry.path); entry.state = "retained"; }
      catch (error: unknown) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") entry.state = "removed";
        else { entry.state = "unknown"; errors.push(error); }
      }
    }
    if (base) try { afterRoots = await rootNames(base); } catch (error: unknown) { errors.push(error); }
    registeredSupports = [...supports].map(value => value.path);
    registeredOriginals = [...originals].map(value => value.path);
    if (JSON.stringify(beforeRoots) !== JSON.stringify(afterRoots)) errors.push(new Error("Temporary root set changed"));
    if (acquired.some(value => value.state !== "removed") || registeredSupports.length || registeredOriginals.length) {
      errors.push(new Error("Acquired roots retained or unknown")); unsafeFailure = true;
    }
    if (restorationErrors.length || (realActions && errors.length && fault === "none")) unsafeFailure = true;
    active = false;
  }
  const proof: Proof = { fault, events, acquired, supports: supportsAcquired, originals: originalsAcquired,
    twins, sessions, beforeRoots, afterRoots, remainingScratch, registeredSupports, registeredOriginals,
    realActions, rejectedAttempts, actionSha256, result };
  console.log(`TWIN S8 ACCOUNTING ${JSON.stringify({ fault, fixtureIdentity, actionIdentity, actionSha256,
    supports: supportsAcquired.length, originals: originalsAcquired.length, twins: twins.length,
    sessions: sessions.length, realActions, rejectedAttempts, acquired, remainingScratch,
    registeredSupports, registeredOriginals, beforeRoots, afterRoots })}`);
  if (errors.length) throw new ProofFailure(errors, proof);
  return proof;
}
async function absent(path: string): Promise<void> { await assert.rejects(fsp.lstat(path), { code: "ENOENT" }); }
async function confirmTwinRemoved(session: TwinSession): Promise<void> {
  assert.equal(session.inspect().state, "discarded");
  await absent(dirname(session.workspacePath));
  assert.deepEqual(await session.discard(), { status: "already-removed" });
}
function assertResult(result: RunResult, failure: boolean): void {
  assert.equal(result.schemaVersion, 1); assert.equal(result.outcome, "exited");
  assert.equal(result.started, true); assert.equal(result.directChildSettled, true);
  assert.equal(result.exitCode, failure ? 1 : 0); assert.equal(result.signal, null);
  assert.equal(result.spawnError, null); assert.equal(result.terminationError, null);
  for (const stream of [result.stdout, result.stderr]) {
    assert.equal(stream.complete, true); assert.equal(stream.truncated, false); assert.equal(stream.error, null);
  }
  assert(Buffer.from(result.stdout.bytes).equals(Buffer.from(failure ? "" : successLine)));
  assert(Buffer.from(result.stderr.bytes).equals(Buffer.from(failure ? failureLine : "")));
}
