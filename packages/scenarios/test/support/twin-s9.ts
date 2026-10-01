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
export const fixtureIdentity = "twin-s9-nongit-project-v1";
export const actionIdentity = "twin-s9-append-fake-home-v1";
export const initialNote = "S9 fake-home baseline.\n";
export const appendedLine = "S9 fixed appended line.\n";
export const successLine = "TWIN_S9_APPEND_OK\n";
export const failureLine = "TWIN_S9_APPEND_FAILURE\n";
const markerName = ".twin-s9-owner";
const actionName = "append-fake-home.mjs";
const projectFiles = Object.freeze({ "project.txt": "S9 project control.\n", ".project-control": "S9 copied dotfile.\n" });
const moduleSource = `import { constants, lstatSync, openSync, fstatSync, writeSync, closeSync } from "node:fs";
import { isAbsolute, join } from "node:path";
const home = process.env.HOME;
try {
  if (process.argv.length !== 2 || !home || !isAbsolute(home) || home.includes("\\0")) throw new Error("invalid input");
  const path = join(home, ".s9-note");
  const before = lstatSync(path);
  if (!before.isFile() || before.nlink !== 1) throw new Error("invalid target");
  const descriptor = openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== before.dev || opened.ino !== before.ino) throw new Error("target changed");
    const bytes = Buffer.from("S9 fixed appended line.\\n", "utf8");
    let offset = 0;
    while (offset < bytes.length) {
      const written = writeSync(descriptor, bytes, offset, bytes.length - offset);
      if (written <= 0) throw new Error("write made no progress");
      offset += written;
    }
  } finally { closeSync(descriptor); }
  process.stdout.write("TWIN_S9_APPEND_OK\\n");
} catch {
  process.stderr.write("TWIN_S9_APPEND_FAILURE\\n");
  process.exitCode = 1;
}
`;
const actionBytes = Buffer.from(moduleSource, "utf8");

/** Fixed non-Git inputs for the public-CLI comparison. */
export function comparisonS9Inputs(): { action: Buffer; project: Record<string, string> } {
  return { action: Buffer.from(actionBytes), project: { ...projectFiles } };
}
type Disposition = "removed" | "retained" | "unknown";
interface Acquired { path: string; kind: "support" | "original" | "home" | "twin"; status: Disposition }
interface Registration {
  path: string; parent: string; token: string; parentIdentity: BigIntStats;
  identity: BigIntStats | null; marker: BigIntStats | null;
  entries: Map<string, BigIntStats>; deletionStarted: boolean; removed: boolean;
}
interface Entry { path: string; kind: "file" | "directory"; bytes: Buffer; mode: bigint; dev: bigint; ino: bigint }
const supportRegistry = new Set<Registration>();
const originalRegistry = new Set<Registration>();
const homeRegistry = new Set<Registration>();
function inside(parent: string, child: string): boolean {
  const suffix = relative(parent, child);
  return suffix === "" || (!isAbsolute(suffix) && suffix !== ".." && !suffix.startsWith(`..${sep}`));
}
function disjoint(a: string, b: string): boolean { return !inside(a, b) && !inside(b, a); }
async function canonicalMissing(path: string): Promise<string> {
  try { return await fsp.realpath(path); }
  catch (error: unknown) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT") || dirname(path) === path) {
      throw new Error("Protected path canonicalization failed");
    }
    return join(await canonicalMissing(dirname(path)), relative(dirname(path), path));
  }
}
function protectedPaths(): string[] {
  const homes = [homedir(), process.env.HOME].filter((value): value is string => typeof value === "string" && value.length > 0);
  const paths = [repository, ...homes, ...homes.map(value => join(value, ".local/state/twin"))];
  if (process.env.XDG_STATE_HOME) paths.push(resolve(process.env.XDG_STATE_HOME, "twin"));
  return paths.map(value => resolve(value));
}
async function checkedBase(): Promise<{ base: string; forbidden: string[] }> {
  const supplied = resolve(tmpdir()), protectedSupplied = protectedPaths();
  for (const value of protectedSupplied) assert(disjoint(value, supplied), "Forbidden supplied temporary base");
  const base = await fsp.realpath(supplied);
  const forbidden: string[] = [];
  for (const value of protectedSupplied) {
    const canonical = await canonicalMissing(value);
    assert(disjoint(value, base) && disjoint(canonical, base) && disjoint(canonical, supplied),
      "Forbidden canonical temporary base");
    forbidden.push(value, canonical);
  }
  return { base, forbidden };
}
function checkRootLocation(path: string, forbidden: readonly string[], otherRoots: readonly string[]): void {
  assert(forbidden.every(value => disjoint(value, path)), "Root overlaps protected tree");
  assert(otherRoots.every(value => disjoint(value, path)), "Owned roots overlap");
}
function same(a: BigIntStats, b: BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino && (a.mode & 0o170000n) === (b.mode & 0o170000n);
}
function statFixed(path: string, expected: BigIntStats, directory: boolean): BigIntStats {
  const actual = fs.lstatSync(path, { bigint: true });
  assert(same(actual, expected) && actual.uid === BigInt(process.getuid!()), "Registered identity or owner changed");
  assert(directory ? actual.isDirectory() : actual.isFile(), "Registered type changed");
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
    const path = join(reg.path, markerName);
    statFixed(path, reg.marker, false);
    const descriptor = fs.openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      assert(same(fs.fstatSync(descriptor, { bigint: true }), reg.marker), "Marker descriptor changed");
      assert(fs.readFileSync(descriptor).equals(Buffer.from(reg.token)), "Marker bytes changed");
    } finally { fs.closeSync(descriptor); }
  }
}
async function acquire(base: string, prefix: string, kind: Acquired["kind"], token: string,
  registry: Set<Registration>, acquired: Acquired[], forbidden: readonly string[], siblings: readonly string[]): Promise<Registration> {
  const parentIdentity = await fsp.lstat(base, { bigint: true });
  assert(parentIdentity.isDirectory() && await fsp.realpath(base) === base);
  const path = await fsp.mkdtemp(join(base, prefix));
  acquired.push({ path, kind, status: "unknown" }); // First operation after acquisition.
  const reg: Registration = { path, parent: base, token, parentIdentity, identity: null,
    marker: null, entries: new Map(), deletionStarted: false, removed: false };
  registry.add(reg);
  checkRootLocation(path, forbidden, siblings);
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
  await fsp.mkdir(path, { mode: 0o700 }); await fsp.chmod(path, 0o700);
  reg.entries.set(name, await fsp.lstat(path, { bigint: true }));
}
async function file(reg: Registration, name: string, bytes: string | Buffer): Promise<void> {
  const path = join(reg.path, name);
  await fsp.writeFile(path, bytes, { flag: "wx", mode: 0o600 }); await fsp.chmod(path, 0o600);
  reg.entries.set(name, await fsp.lstat(path, { bigint: true }));
}
function exactNames(path: string, names: readonly string[]): void {
  assert.deepEqual(fs.readdirSync(path).sort(), [...names].sort(), "Unexpected owned entry");
}
function verifyAsset(reg: Registration): string {
  verify(reg, supportRegistry);
  const directoryPath = join(reg.path, "actions"), path = join(directoryPath, actionName);
  assert(reg.entries.has("actions") && reg.entries.has(`actions/${actionName}`), "Action registration incomplete");
  statFixed(directoryPath, reg.entries.get("actions")!, true);
  assert(inside(reg.path, path) && fs.realpathSync(path) === path, "Action containment changed");
  const expected = reg.entries.get(`actions/${actionName}`)!;
  statFixed(path, expected, false);
  const descriptor = fs.openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    assert(same(fs.fstatSync(descriptor, { bigint: true }), expected), "Action descriptor changed");
    const actual = fs.readFileSync(descriptor);
    assert(actual.equals(actionBytes), "S9 action byte mismatch");
    assert(same(fs.lstatSync(path, { bigint: true }), expected), "Action changed during read");
    return createHash("sha256").update(actual).digest("hex");
  } finally { fs.closeSync(descriptor); }
}
function gitFree(entries: readonly Entry[]): void {
  for (const entry of entries) {
    assert(!entry.path.split("/").some(part => [".git", ".gitmodules"].includes(part.toLowerCase())), "Git metadata entry found");
  }
  for (const directory of entries.filter(entry => entry.kind === "directory")) {
    const prefix = directory.path === "" ? "" : `${directory.path}/`;
    const names = new Set(entries.filter(entry => entry.path.startsWith(prefix)
      && !entry.path.slice(prefix.length).includes("/")).map(entry => entry.path.slice(prefix.length).toLowerCase()));
    assert(!["head", "objects", "refs"].every(name => names.has(name)), "Bare Git inventory found");
  }
}
function inventory(root: string): Entry[] {
  const entries: Entry[] = [];
  const visit = (path: string): void => {
    const stat = fs.lstatSync(path, { bigint: true });
    assert(stat.isDirectory() || stat.isFile(), "Unsupported inventory type");
    if (stat.isFile()) assert.equal(stat.nlink, 1n, "Unexpected file link count");
    entries.push({ path: relative(root, path), kind: stat.isFile() ? "file" : "directory",
      bytes: stat.isFile() ? fs.readFileSync(path) : Buffer.alloc(0), mode: stat.mode & 0o777n,
      dev: stat.dev, ino: stat.ino });
    if (stat.isDirectory()) for (const name of fs.readdirSync(path).sort()) visit(join(path, name));
  };
  visit(root); gitFree(entries); return entries;
}
function content(entries: readonly Entry[]): readonly (readonly [string, string, bigint, string])[] {
  return entries.map(value => [value.path, value.kind, value.mode, value.bytes.toString("hex")] as const);
}
function equalContent(actual: readonly Entry[], expected: readonly Entry[]): void {
  assert.deepEqual(content(actual), content(expected), "Complete inventory differs");
}
function equalInventory(actual: readonly Entry[], expected: readonly Entry[]): void {
  equalContent(actual, expected);
  assert.deepEqual(actual.map(value => [value.path, value.dev, value.ino]),
    expected.map(value => [value.path, value.dev, value.ino]), "Inventory identity differs");
}
function expectedProject(entries: readonly Entry[]): void {
  assert.deepEqual(entries.map(value => [value.path, value.kind, value.mode]), [
    ["", "directory", 0o700n], [".project-control", "file", 0o600n], ["project.txt", "file", 0o600n],
  ]);
  for (const [name, bytes] of Object.entries(projectFiles)) {
    assert(entries.find(value => value.path === name)?.bytes.equals(Buffer.from(bytes)), "Project fixture changed");
  }
}
function expectedHome(entries: readonly Entry[]): void {
  assert.deepEqual(entries.map(value => [value.path, value.kind, value.mode]), [
    ["", "directory", 0o700n], [".s9-note", "file", 0o600n],
  ]);
  assert(entries[1]?.bytes.equals(Buffer.from(initialNote)), "Fake-home baseline changed");
}
function observeOriginal(reg: Registration, baseline: readonly Entry[]): void {
  verify(reg, originalRegistry); exactNames(reg.path, [markerName, "workspace"]);
  statFixed(join(reg.path, "workspace"), reg.entries.get("workspace")!, true);
  equalInventory(inventory(join(reg.path, "workspace")), baseline);
}
function observeHome(reg: Registration, expected: readonly Entry[]): void {
  verify(reg, homeRegistry); exactNames(reg.path, [markerName, "home"]);
  statFixed(join(reg.path, "home"), reg.entries.get("home")!, true);
  equalInventory(inventory(join(reg.path, "home")), expected);
}
type ExpectedHome =
  | { readonly kind: "baseline-note"; readonly inventory: readonly Entry[] }
  | { readonly kind: "missing-note"; readonly inventory: readonly Entry[] };
function checkPrelaunchHome(reg: Registration, expected: ExpectedHome): void {
  verify(reg, homeRegistry);
  exactNames(reg.path, [markerName, "home"]);
  const home = join(reg.path, "home");
  statFixed(home, reg.entries.get("home")!, true);
  const note = join(home, ".s9-note");
  if (expected.kind === "baseline-note") {
    const registered = reg.entries.get("home/.s9-note");
    assert(registered, "Prelaunch note registration missing");
    const current = fs.lstatSync(note, { bigint: true });
    assert(same(current, registered), "Prelaunch note identity changed");
    statFixed(note, registered, false);
    assert.equal(current.size, BigInt(Buffer.byteLength(initialNote)), "Prelaunch note size changed");
    const descriptor = fs.openSync(note, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const opened = fs.fstatSync(descriptor, { bigint: true });
      assert(same(opened, registered) && opened.uid === BigInt(process.getuid!())
        && opened.isFile() && opened.nlink === 1n && (opened.mode & 0o777n) === 0o600n
        && opened.size === BigInt(Buffer.byteLength(initialNote)), "Prelaunch note descriptor changed");
      assert(fs.readFileSync(descriptor).equals(Buffer.from(initialNote)), "Prelaunch note bytes changed");
      assert(same(fs.lstatSync(note, { bigint: true }), registered), "Prelaunch note path changed");
    } finally { fs.closeSync(descriptor); }
  } else {
    exactNames(home, []);
  }
  equalInventory(inventory(home), expected.inventory);
}
function remove(reg: Registration, name: string, directoryEntry: boolean): void {
  const expected = reg.entries.get(name);
  assert(expected, "Unregistered cleanup entry");
  const path = join(reg.path, name);
  statFixed(path, expected, directoryEntry);
  reg.deletionStarted = true;
  if (directoryEntry) fs.rmdirSync(path); else fs.unlinkSync(path);
}
function finish(reg: Registration, registry: Set<Registration>): void {
  verify(reg, registry); assert(reg.marker);
  statFixed(join(reg.path, markerName), reg.marker, false);
  reg.deletionStarted = true;
  fs.unlinkSync(join(reg.path, markerName));
  statFixed(reg.path, reg.identity!, true); fs.rmdirSync(reg.path);
  reg.removed = true; registry.delete(reg);
}
function cleanupOriginal(reg: Registration, baseline: readonly Entry[] | null): void {
  assert(!reg.deletionStarted, "Partial original deletion cannot be retried");
  assert(baseline, "Original cleanup refused: missing fresh observation");
  observeOriginal(reg, baseline);
  assert.equal(reg.entries.size, 3, "Original registration incomplete");
  exactNames(join(reg.path, "workspace"), [".project-control", "project.txt"]);
  remove(reg, "workspace/.project-control", false);
  remove(reg, "workspace/project.txt", false);
  remove(reg, "workspace", true); finish(reg, originalRegistry);
}
function cleanupHome(reg: Registration, expected: readonly Entry[] | null, allowMissing: boolean): void {
  assert(!reg.deletionStarted, "Partial fake-home deletion cannot be retried");
  assert(expected, "Fake-home cleanup refused: missing fresh observation");
  observeHome(reg, expected);
  assert.equal(reg.entries.size, 2, "Fake-home registration incomplete");
  exactNames(join(reg.path, "home"), allowMissing ? [] : [".s9-note"]);
  if (!allowMissing) remove(reg, "home/.s9-note", false);
  remove(reg, "home", true); finish(reg, homeRegistry);
}
function cleanupSupport(reg: Registration): void {
  assert(!reg.deletionStarted, "Partial support deletion cannot be retried");
  verify(reg, supportRegistry);
  exactNames(reg.path, [markerName, "actions", "scratch"]);
  assert.equal(reg.entries.size, 3, "Support registration incomplete");
  statFixed(join(reg.path, "actions"), reg.entries.get("actions")!, true);
  statFixed(join(reg.path, "scratch"), reg.entries.get("scratch")!, true);
  statFixed(join(reg.path, "actions", actionName), reg.entries.get(`actions/${actionName}`)!, false);
  exactNames(join(reg.path, "actions"), [actionName]);
  exactNames(join(reg.path, "scratch"), []);
  remove(reg, `actions/${actionName}`, false);
  remove(reg, "actions", true); remove(reg, "scratch", true); finish(reg, supportRegistry);
}
export interface LaunchState { installed: boolean; dispatch: boolean; baselines: boolean; sessionState: string | null }
export interface Admitted {
  executable: string; argv: string[];
  options: { cwd: string; shell: false; detached: true; stdio: ["ignore", "pipe", "pipe"]; env: Record<string, string> };
}
function plain(value: unknown): asserts value is Record<string, unknown> {
  assert(value && typeof value === "object" && !isProxy(value), "Proxy or non-object rejected");
  const prototype = Object.getPrototypeOf(value);
  assert(prototype === Object.prototype || prototype === null, "Non-plain object rejected");
}
function data(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  assert(descriptor && "value" in descriptor, "Accessor or missing value rejected");
  return descriptor.value;
}
export class ActionGate {
  private consumed = false;
  constructor(private readonly node: string, private readonly asset: string, private readonly cwd: string,
    private readonly home: string) {}
  admit(command: unknown, inputArgv: unknown, inputOptions: unknown, state: LaunchState): Admitted {
    assert(!this.consumed, "Only one S9 action permitted");
    this.consumed = true; // Before caller-controlled reflection.
    assert(state.installed && state.dispatch && state.baselines && state.sessionState === "running", "Action lifecycle closed");
    assert(Array.isArray(inputArgv) && !isProxy(inputArgv)
      && Object.getPrototypeOf(inputArgv) === Array.prototype && !Object.hasOwn(inputArgv, Symbol.iterator),
    "Argv proxy/iterator rejected");
    assert.deepEqual(Reflect.ownKeys(inputArgv), ["0", "length"]);
    const argv = [data(inputArgv, "0")];
    plain(inputOptions);
    assert.deepEqual(Reflect.ownKeys(inputOptions).sort(), ["cwd", "shell", "detached", "stdio", "env"].sort());
    const cwd = data(inputOptions, "cwd"), shell = data(inputOptions, "shell");
    const detached = data(inputOptions, "detached"), inputStdio = data(inputOptions, "stdio");
    const inputEnv = data(inputOptions, "env");
    assert(Array.isArray(inputStdio) && !isProxy(inputStdio)
      && Object.getPrototypeOf(inputStdio) === Array.prototype && !Object.hasOwn(inputStdio, Symbol.iterator),
    "Stdio proxy/iterator rejected");
    assert.deepEqual(Reflect.ownKeys(inputStdio), ["0", "1", "2", "length"]);
    const stdio = [data(inputStdio, "0"), data(inputStdio, "1"), data(inputStdio, "2")];
    plain(inputEnv);
    assert.deepEqual(Reflect.ownKeys(inputEnv).sort(), ["LANG", "LC_ALL", "TZ", "HOME"].sort());
    const env = { LANG: data(inputEnv, "LANG"), LC_ALL: data(inputEnv, "LC_ALL"),
      TZ: data(inputEnv, "TZ"), HOME: data(inputEnv, "HOME") };
    assert.equal(command, this.node); assert(isAbsolute(this.node) && !this.node.includes("\0"));
    assert.deepEqual(argv, [this.asset]); assert.equal(cwd, this.cwd);
    assert.equal(shell, false); assert.equal(detached, true);
    assert.deepEqual(stdio, ["ignore", "pipe", "pipe"]);
    assert.deepEqual(env, { LANG: "C", LC_ALL: "C", TZ: "UTC", HOME: this.home });
    return { executable: this.node, argv: [this.asset], options: { cwd: this.cwd, shell: false,
      detached: true, stdio: ["ignore", "pipe", "pipe"],
      env: { LANG: "C", LC_ALL: "C", TZ: "UTC", HOME: this.home } } };
  }
}
export function forbidChildApi(): never { throw new Error("S9 forbids alternate child APIs"); }
export function restoreAll(restores: readonly (() => void)[], errors: unknown[], synchronize: () => void): void {
  for (const restore of restores) try { restore(); } catch (error: unknown) { errors.push(error); }
  try { synchronize(); } catch (error: unknown) { errors.push(error); }
}
export type Fault = "none" | "token" | "preparation" | "asset-mismatch" | "copy" | "before-action"
  | "missing-note" | "changed-authority" | "replaced-note" | "launch-reject" | "observation"
  | "twin-refusal" | "original-refusal" | "home-refusal" | "support-refusal";
export interface Proof {
  fault: Fault; events: string[]; acquired: Acquired[];
  supports: number; originals: number; homes: number; twins: number; sessions: number;
  realActions: number; rejectedAttempts: number; actionSha256: string | null;
  beforeRoots: string[]; afterRoots: string[]; remainingScratch: string[];
  registeredSupports: number; registeredOriginals: number; registeredHomes: number;
  result: RunResult | null;
}
export class ProofFailure extends AggregateError {
  constructor(errors: readonly unknown[], readonly proof: Proof) { super(errors, `S9 proof failed: ${proof.fault}`, { cause: errors[0] }); }
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
  assert(Buffer.from(result.stdout.bytes).equals(Buffer.from(failure ? "" : successLine)), "Action stdout differs");
  assert(Buffer.from(result.stderr.bytes).equals(Buffer.from(failure ? failureLine : "")), "Action stderr differs");
}
let active = false, unsafeFailure = false;
export async function proveTwinS9(fault: Fault = "none"): Promise<Proof> {
  assert(!active && !unsafeFailure, "S9 requires restored serial execution"); active = true;
  const proof: Proof = { fault, events: [], acquired: [], supports: 0, originals: 0, homes: 0, twins: 0,
    sessions: 0, realActions: 0, rejectedAttempts: 0, actionSha256: null,
    beforeRoots: [], afterRoots: [], remainingScratch: [], registeredSupports: 0,
    registeredOriginals: 0, registeredHomes: 0, result: null };
  const errors: unknown[] = [], restorationErrors: unknown[] = [], restores: (() => void)[] = [];
  const primary = new Error(`Injected ${fault}`), node = process.execPath, nativeSpawn = childProcess.spawn;
  let base: string | undefined, forbidden: string[] = [];
  let support: Registration | undefined, original: Registration | undefined, fake: Registration | undefined;
  let scratch: string | undefined, originalWorkspace: string | undefined, fakeHome: string | undefined;
  let session: TwinSession | undefined, twinWorkspace: string | undefined, twinIdentity: BigIntStats | undefined;
  let projectBaseline: Entry[] | undefined, twinBaseline: Entry[] | undefined;
  let fakeBaseline: Entry[] | undefined, fakeExpected: Entry[] | undefined;
  let prelaunchHome: ExpectedHome | undefined;
  let gate: ActionGate | undefined, installed = false, dispatch = false, baselines = false;
  let changedMode = false, knownTwinRefusal = false, knownOriginalRefusal = false;
  let knownHomeRefusal = false, knownSupportRefusal = false;
  let replacementIdentity: BigIntStats | undefined;
  const attempt = async (event: string, work: () => Promise<void>): Promise<void> => {
    proof.events.push(event); try { await work(); } catch (error: unknown) { errors.push(error); }
  };
  const checkProject = async (): Promise<void> => { assert(original && projectBaseline); observeOriginal(original, projectBaseline); };
  const checkFake = async (): Promise<void> => { assert(fake && fakeExpected); observeHome(fake, fakeExpected); };
  try {
    try {
      for (const method of ["exec", "execFile", "fork", "execSync", "execFileSync", "spawnSync"] as const) {
        const spy = vi.spyOn(childProcess, method).mockImplementation(forbidChildApi);
        restores.push(() => spy.mockRestore());
      }
      const guarded = ((command: string, argv: readonly string[], options: SpawnOptions) => {
        try {
          assert(installed && childProcess.spawn === guardedSpawn, "S9 guard absent");
          assert(gate && session && twinWorkspace && twinIdentity && fake && fakeHome && support && scratch && prelaunchHome);
          const admitted = gate.admit(command, argv, options,
            { installed, dispatch, baselines, sessionState: session.inspect().state });
          assert(dispatch && baselines && session.inspect().state === "running", "S9 dispatch changed");
          assert.equal(session.workspacePath, twinWorkspace);
          assert.equal(dirname(dirname(twinWorkspace)), scratch);
          statFixed(twinWorkspace, twinIdentity, true);
          assert.equal(admitted.options.cwd, twinWorkspace);
          checkPrelaunchHome(fake, prelaunchHome);
          assert.equal(admitted.options.env.HOME, fakeHome);
          assert(disjoint(fakeHome, twinWorkspace) && disjoint(fakeHome, originalWorkspace!)
            && disjoint(fakeHome, support.path) && forbidden.every(value => disjoint(value, fakeHome!)),
            "HOME containment changed");
          assert.equal(verifyAsset(support), proof.actionSha256);
          if (fault === "launch-reject") throw primary;
          proof.realActions++;
          return nativeSpawn(admitted.executable, [...admitted.argv], { ...admitted.options,
            env: { ...admitted.options.env }, stdio: ["ignore", "pipe", "pipe"] });
        } catch (error: unknown) { proof.rejectedAttempts++; throw error; }
      }) as typeof childProcess.spawn;
      const spawnSpy = vi.spyOn(childProcess, "spawn").mockImplementation(guarded);
      const guardedSpawn = childProcess.spawn;
      restores.push(() => spawnSpy.mockRestore()); syncBuiltinESMExports(); installed = true;
      const checked = await checkedBase(); base = checked.base; forbidden = checked.forbidden;
      proof.beforeRoots = (await fsp.readdir(base)).filter(name => name.startsWith("twin-test-s9-")).sort();
      if (fault === "token") throw primary;
      const supportToken = randomBytes(32).toString("hex") + "\n";
      const originalToken = randomBytes(32).toString("hex") + "\n";
      const homeToken = randomBytes(32).toString("hex") + "\n";
      if (fault === "preparation") throw primary;
      assert(actionBytes.length > 0 && Object.keys(projectFiles).length === 2);
      const allocated = fsp.mkdtemp;
      const allocationSpy = vi.spyOn(fsp, "mkdtemp").mockImplementation(async (...args: Parameters<typeof fsp.mkdtemp>) => {
        const path = await allocated(...args);
        if (scratch && dirname(path) === scratch) { proof.acquired.push({ path, kind: "twin", status: "unknown" }); proof.twins++; }
        return path;
      });
      restores.push(() => allocationSpy.mockRestore()); syncBuiltinESMExports();
      support = await acquire(base, "twin-test-s9-support-", "support", supportToken, supportRegistry,
        proof.acquired, forbidden, []); proof.supports++;
      await directory(support, "actions"); await directory(support, "scratch");
      scratch = join(support.path, "scratch");
      await file(support, `actions/${actionName}`, actionBytes);
      proof.actionSha256 = verifyAsset(support);
      if (fault === "asset-mismatch") {
        await fsp.writeFile(join(support.path, "actions", actionName), "changed\n");
        verifyAsset(support); throw new Error("Action mismatch was accepted");
      }
      original = await acquire(base, "twin-test-s9-original-", "original", originalToken, originalRegistry,
        proof.acquired, forbidden, [support.path]); proof.originals++;
      await directory(original, "workspace");
      for (const [name, bytes] of Object.entries(projectFiles)) await file(original, `workspace/${name}`, bytes);
      originalWorkspace = join(original.path, "workspace");
      projectBaseline = inventory(originalWorkspace); expectedProject(projectBaseline);
      proof.events.push("original-baseline");
      fake = await acquire(base, "twin-test-s9-home-", "home", homeToken, homeRegistry,
        proof.acquired, forbidden, [support.path, original.path]); proof.homes++;
      await directory(fake, "home"); await file(fake, "home/.s9-note", initialNote);
      fakeHome = join(fake.path, "home");
      assert(disjoint(fakeHome, support.path) && disjoint(fakeHome, original.path));
      fakeBaseline = inventory(fakeHome); expectedHome(fakeBaseline); fakeExpected = fakeBaseline;
      proof.events.push("fake-home-baseline");
      const open = fsp.open;
      const copySpy = fault === "copy" ? vi.spyOn(fsp, "open").mockImplementation(async (...args: Parameters<typeof fsp.open>) => {
        if (args[0] === join(originalWorkspace!, "project.txt")) throw primary;
        return open(...args);
      }) : undefined;
      let copyRestored = false;
      const restoreCopy = (): void => { if (!copyRestored) { copySpy?.mockRestore(); copyRestored = true; } };
      restores.push(restoreCopy);
      try {
        syncBuiltinESMExports();
        session = await createTwin({ sourceDirectory: originalWorkspace, scratchParent: scratch });
        proof.sessions++; twinWorkspace = session.workspacePath; // First operations after return.
      } finally { restoreAll([restoreCopy], restorationErrors, syncBuiltinESMExports); }
      assert.equal(restorationErrors.length, 0, "Copy instrumentation restoration failed");
      proof.events.push("session-returned");
      assert.deepEqual(session.inspect(), { workspacePath: twinWorkspace, state: "ready" });
      assert.equal(dirname(dirname(twinWorkspace)), scratch);
      twinIdentity = await fsp.lstat(twinWorkspace, { bigint: true });
      twinBaseline = inventory(twinWorkspace);
      equalContent(twinBaseline, projectBaseline); expectedProject(twinBaseline);
      for (const copied of twinBaseline.filter(value => value.kind === "file")) {
        const source: Entry | undefined = projectBaseline.find(value => value.path === copied.path);
        assert(source && (copied.dev !== source.dev || copied.ino !== source.ino), "Shared copied file identity");
      }
      proof.events.push("twin-pre-state");
      if (fault === "before-action") throw primary;
      if (fault === "missing-note") {
        await fsp.unlink(join(fakeHome, ".s9-note"));
        fakeExpected = fakeBaseline.filter(value => value.path !== ".s9-note");
        equalInventory(inventory(fakeHome), fakeExpected);
        proof.events.push("negative-pre-state");
      }
      prelaunchHome = fault === "missing-note"
        ? { kind: "missing-note", inventory: fakeExpected! }
        : { kind: "baseline-note", inventory: fakeBaseline };
      if (fault === "replaced-note") {
        const note = join(fakeHome, ".s9-note"), backup = join(scratch, ".s9-original-note");
        await fsp.rename(note, backup);
        await fsp.writeFile(note, initialNote, { flag: "wx", mode: 0o600 });
        await fsp.chmod(note, 0o600);
        replacementIdentity = await fsp.lstat(note, { bigint: true });
        assert(replacementIdentity.isFile() && replacementIdentity.nlink === 1n
          && replacementIdentity.uid === BigInt(process.getuid!())
          && (replacementIdentity.mode & 0o777n) === 0o600n
          && !same(replacementIdentity, fake.entries.get("home/.s9-note")!), "Replacement setup invalid");
        equalContent(inventory(fakeHome), fakeBaseline);
        proof.events.push("known-note-replaced");
      }
      baselines = true; gate = new ActionGate(node, join(support.path, "actions", actionName), twinWorkspace, fakeHome);
      if (fault === "changed-authority") { await fsp.chmod(fakeHome, 0o755); changedMode = true; }
      dispatch = true;
      try { proof.result = await session.run({ executable: node, argv: [join(support.path, "actions", actionName)],
        env: { LANG: "C", LC_ALL: "C", TZ: "UTC", HOME: fakeHome }, timeoutMs: 5000 }); }
      finally { dispatch = false; }
      proof.events.push("action-returned");
      if (changedMode) { await fsp.chmod(fakeHome, 0o700); changedMode = false; proof.events.push("known-home-mode-restored"); }
      if (replacementIdentity) {
        const note = join(fakeHome, ".s9-note"), backup = join(scratch, ".s9-original-note");
        statFixed(note, replacementIdentity, false);
        statFixed(backup, fake.entries.get("home/.s9-note")!, false);
        assert(fs.readFileSync(note).equals(Buffer.from(initialNote)), "Replacement changed before restoration");
        await fsp.unlink(note); await fsp.rename(backup, note);
        replacementIdentity = undefined; proof.events.push("known-note-restored");
      }
      if (fault === "changed-authority" || fault === "replaced-note" || fault === "launch-reject") {
        assert.equal(proof.realActions, 0); assert.equal(proof.rejectedAttempts, 1);
        assert.equal(proof.result.outcome, "spawn-failed"); assert.equal(proof.result.started, false);
        assert.equal(proof.result.directChildSettled, true);
        if (fault === "replaced-note") assert.equal(proof.result.spawnError, "Prelaunch note identity changed");
        throw primary;
      }
      try { assertResult(proof.result, fault === "missing-note"); }
      catch (error: unknown) { unsafeFailure = true; throw error; }
      assert.equal(session.inspect().state, "finished");
    } catch (error: unknown) { errors.push(error); }
    dispatch = false; baselines = false;
    if (changedMode && fakeHome) await attempt("restore-known-home-mode", async () => {
      await fsp.chmod(fakeHome!, 0o700); changedMode = false;
    });
    if (replacementIdentity && fake && fakeHome && scratch) await attempt("restore-known-note", async () => {
      const note = join(fakeHome!, ".s9-note"), backup = join(scratch!, ".s9-original-note");
      statFixed(note, replacementIdentity!, false);
      statFixed(backup, fake!.entries.get("home/.s9-note")!, false);
      assert(fs.readFileSync(note).equals(Buffer.from(initialNote)), "Replacement changed before restoration");
      await fsp.unlink(note); await fsp.rename(backup, note);
      replacementIdentity = undefined; proof.events.push("known-note-restored");
    });
    if (session && twinWorkspace && twinBaseline) await attempt("twin-post-state", async () => {
      if (fault === "observation") throw primary;
      assert.notEqual(session!.inspect().state, "child-unsettled");
      equalInventory(inventory(twinWorkspace!), twinBaseline!);
    });
    if (original && projectBaseline) await attempt("original-after-action", checkProject);
    if (fake && fakeBaseline && fakeHome) await attempt("fake-home-after-action", async () => {
      if (proof.realActions && fault !== "missing-note") {
        fakeExpected = fakeBaseline!.map(value => value.path === ".s9-note"
          ? { ...value, bytes: Buffer.from(initialNote + appendedLine) } : value);
      }
      await checkFake();
    });
    if (session) await attempt("twin-discard", async () => {
      if (fault === "twin-refusal") await fsp.chmod(scratch!, 0o755);
      const result = await session!.discard();
      knownTwinRefusal = fault === "twin-refusal" && result.status === "refused";
      assert.equal(result.status, "removed", "Twin discard refused or failed");
      await confirmTwinRemoved(session!); proof.events.push("twin-removed");
    });
    if (original && projectBaseline) await attempt("original-after-discard", checkProject);
    if (fake && fakeExpected) await attempt("fake-home-after-discard", checkFake);
    if (original && projectBaseline) await attempt("original-cleanup", async () => {
      if (fault === "original-refusal") {
        try { cleanupOriginal(original!, null); }
        catch (error: unknown) { knownOriginalRefusal = true; throw error; }
        throw new Error("Missing original observation was accepted");
      }
      cleanupOriginal(original!, projectBaseline!); await absent(original!.path);
    });
    if (fake && fakeExpected) await attempt("fake-home-cleanup", async () => {
      if (fault === "home-refusal") {
        try { cleanupHome(fake!, null, false); }
        catch (error: unknown) { knownHomeRefusal = true; throw error; }
        throw new Error("Missing fake-home observation was accepted");
      }
      cleanupHome(fake!, fakeExpected!, fault === "missing-note"); await absent(fake!.path);
    });
    if (knownTwinRefusal) await attempt("known-twin-release", async () => {
      assert(session && scratch && twinWorkspace);
      exactNames(scratch, [relative(scratch, dirname(twinWorkspace))]);
      await fsp.chmod(scratch, 0o700);
      assert.equal((await session.discard()).status, "removed");
      await confirmTwinRemoved(session); proof.events.push("twin-removed");
    });
    if (support) await attempt("support-cleanup", async () => {
      if (fault === "support-refusal") {
        await fsp.chmod(join(support!.path, "actions"), 0o755);
        try { cleanupSupport(support!); }
        catch (error: unknown) { knownSupportRefusal = true; throw error; }
        throw new Error("Changed support authority was accepted");
      }
      cleanupSupport(support!); await absent(support!.path);
    });
    if (knownOriginalRefusal) await attempt("known-original-release", async () => {
      assert(original && projectBaseline); observeOriginal(original, projectBaseline);
      cleanupOriginal(original, projectBaseline); await absent(original.path);
    });
    if (knownHomeRefusal) await attempt("known-home-release", async () => {
      assert(fake && fakeExpected); observeHome(fake, fakeExpected);
      cleanupHome(fake, fakeExpected, false); await absent(fake.path);
    });
    if (knownSupportRefusal) await attempt("known-support-release", async () => {
      assert(support); await fsp.chmod(join(support.path, "actions"), 0o700);
      cleanupSupport(support); await absent(support.path);
    });
    if (support?.entries.has("scratch")) await attempt("scratch-accounting", async () => {
      if (support && !support.removed) proof.remainingScratch = (await fsp.readdir(join(support.path, "scratch"))).sort();
      assert.deepEqual(proof.remainingScratch, []);
    });
  } catch (error: unknown) { errors.push(error); }
  finally {
    installed = false; dispatch = false; baselines = false;
    restoreAll(restores.toReversed(), restorationErrors, syncBuiltinESMExports);
    errors.push(...restorationErrors);
    for (const value of proof.acquired) {
      try { await fsp.lstat(value.path); value.status = "retained"; }
      catch (error: unknown) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") value.status = "removed";
        else { value.status = "unknown"; errors.push(error); }
      }
    }
    if (base) try {
      proof.afterRoots = (await fsp.readdir(base)).filter(name => name.startsWith("twin-test-s9-")).sort();
    } catch (error: unknown) { errors.push(error); }
    proof.registeredSupports = supportRegistry.size; proof.registeredOriginals = originalRegistry.size;
    proof.registeredHomes = homeRegistry.size;
    if (JSON.stringify(proof.beforeRoots) !== JSON.stringify(proof.afterRoots)) errors.push(new Error("Temporary root set changed"));
    if (proof.acquired.some(value => value.status !== "removed") || supportRegistry.size || originalRegistry.size || homeRegistry.size) {
      errors.push(new Error("Acquired roots retained or unknown")); unsafeFailure = true;
    }
    if (restorationErrors.length || (proof.realActions && fault === "none" && errors.length)) unsafeFailure = true;
    active = false;
  }
  // No real paths or fake-home contents in the accounting line.
  console.log(`TWIN S9 ACCOUNTING ${JSON.stringify({ fault, fixtureIdentity, actionIdentity,
    actionSha256: proof.actionSha256, supports: proof.supports, originals: proof.originals,
    homes: proof.homes, twins: proof.twins, sessions: proof.sessions, realActions: proof.realActions,
    rejectedAttempts: proof.rejectedAttempts, removed: proof.acquired.filter(value => value.status === "removed").length,
    retained: proof.acquired.filter(value => value.status === "retained").length,
    unknown: proof.acquired.filter(value => value.status === "unknown").length,
    remainingScratch: proof.remainingScratch.length, registeredSupports: proof.registeredSupports,
    registeredOriginals: proof.registeredOriginals, registeredHomes: proof.registeredHomes,
    beforeRoots: proof.beforeRoots.length, afterRoots: proof.afterRoots.length })}`);
  if (errors.length) throw new ProofFailure(errors, proof);
  return proof;
}
