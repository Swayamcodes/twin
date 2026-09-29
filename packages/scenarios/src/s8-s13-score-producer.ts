import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createTwin, type RunResult, type TwinSession } from "@twin-cli/core";
import { cleanupScenarioRoot, createScenarioRoot, initializeFixture, initializeScenarioRoot, verifyWorkspace,
  type OwnedScenarioRoot } from "./fixture.js";
import type { Snapshot } from "./types.js";
import { fixtureContents } from "./scenarios.js";
import { actionBytes, actionDigest, actionName, content, environment, exactFile, inventory, requireInputs,
  s8Files, s13Files, s9Files, s9InitialNote, s9AppendedLine, success, type Entry, type MeasuredScenario } from "./s8-s13-fixtures.js";
import { S8S13CompleteSchema, S8S13ResultSchema, type S8S13Incomplete, type S8S13Result } from "./contract/s8-s13-score.js";

type RootName = "original" | "support" | "twin" | "artifact" | "home";
type RootState = "not-allocated" | "removed" | "retained" | "unknown";
type Stage = S8S13Incomplete["stage"];
const sha = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const repository = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const coreModules = ["index.js", "twin.js", "copy.js", "run.js", "safety.js", "manifest.js",
  "git-classification.js", "watch.js", "receipt.js"] as const;
const adapterModules = ["s8-s13-fixtures.js", "s8-s13-score-producer.js", "s8-s13-score-entry.js",
  "contract/s8-s13-score.js", "fixture.js", "runner.js", "scenarios.js"] as const;
async function fingerprint(base: string, names: readonly string[]): Promise<string> {
  const hash = createHash("sha256");
  for (const name of names) {
    const path = join(base, name), before = await fs.lstat(path);
    assert(before.isFile() && !before.isSymbolicLink() && before.nlink === 1 && before.size <= 1024 * 1024);
    const file = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const opened = await file.stat();
      assert(opened.dev === before.dev && opened.ino === before.ino && opened.size === before.size);
      const bytes = await file.readFile(), after = await file.stat();
      assert(bytes.length === before.size && after.mtimeMs === before.mtimeMs && after.ctimeMs === before.ctimeMs);
      const label = Buffer.from(name), length = Buffer.alloc(8), labelLength = Buffer.alloc(4);
      labelLength.writeUInt32BE(label.length); length.writeBigUInt64BE(BigInt(bytes.length));
      hash.update(labelLength).update(label).update(length).update(bytes);
    } finally { await file.close(); }
  }
  return `fp-${hash.digest("hex")}`;
}
function within(parent: string, child: string): boolean {
  const suffix = relative(parent, child);
  return suffix === "" || (!isAbsolute(suffix) && suffix !== ".." && !suffix.startsWith(`..${sep}`));
}
export function safeDestination(path: string): boolean {
  if (!isAbsolute(path) || normalize(path) !== path) return false;
  const home = resolve(homedir()), target = resolve(path);
  return !within(repository, target) && !within(home, target) && target !== "/";
}
async function parentReady(path: string): Promise<boolean> {
  if (!safeDestination(path)) return false;
  try {
    assert(typeof process.getuid === "function");
    const stat = await fs.lstat(path);
    return stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === process.getuid()
      && (stat.mode & 0o777) === 0o700 && await fs.realpath(path) === path;
  } catch { return false; }
}
function emptyRoots(): Record<RootName, RootState> {
  return { original: "not-allocated", support: "not-allocated", twin: "not-allocated", artifact: "not-allocated", home: "not-allocated" };
}
function publicRoots(id: MeasuredScenario, roots: Record<RootName, RootState>): S8S13Incomplete["roots"] {
  const { original, support, twin, artifact, home } = roots;
  return id === "S9" ? { original, support, twin, artifact, home } : { original, support, twin, artifact };
}
function incomplete(id: MeasuredScenario, stage: Stage, roots: Record<RootName, RootState>,
  directChild: S8S13Incomplete["process"]["directChild"] = "not-launched", attemptId: string | null = null): S8S13Incomplete {
  return { schemaVersion: 1, resultVersion: 1, status: "incomplete", scenarioId: id, stage,
    roots: publicRoots(id, roots), identities: {}, attemptId, process: { directChild, descendants: "not-established" } };
}
type AllocatedRoot = "original" | "support" | "twin" | "home";
interface RootIdentity {
  path: string; rootDev: number; rootIno: number; workspaceDev: number; workspaceIno: number;
  markerDev: number; markerIno: number; markerSha256: string; uid: number;
}
interface JournalEvent {
  kind: "opened" | "allocation-intent" | "allocated" | "registered" | "copy-validated" | "launch-intent" | "settlement" | "evidence-complete" | "disposition" | "failure";
  root?: RootName; identity?: RootIdentity; path?: string; dev?: number; ino?: number;
  disposition?: RootState; process?: S8S13Incomplete["process"]["directChild"];
  outcome?: string; started?: boolean; exitCode?: number | null; signal?: string | null;
  stdoutComplete?: boolean; stderrComplete?: boolean; executable?: string; actionSha256?: string;
  attemptId?: string; owner?: string; parentDev?: number; parentIno?: number; stage?: Stage;
}
interface AttemptJournal { id: string; directory: string; owner: string; append(event: JournalEvent): Promise<void> }
async function writeExclusive(path: string, bytes: Buffer): Promise<void> {
  const file = await fs.open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
}
async function openJournal(parent: string, id: string): Promise<AttemptJournal> {
  assert(await parentReady(parent));
  const directory = join(parent, `twin-s8-s13-${id}`), owner = randomBytes(32).toString("hex");
  const parentStat = await fs.lstat(parent);
  await fs.mkdir(directory, { mode: 0o700 });
  const directoryHandle = await fs.open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    await writeExclusive(join(directory, ".owner"), Buffer.from(`${owner}\n`));
    await writeExclusive(join(directory, "events.jsonl"), Buffer.alloc(0));
    await directoryHandle.sync();
  } finally { await directoryHandle.close(); }
  let sequence = 0;
  const append = async (event: JournalEvent): Promise<void> => {
    const file = await fs.open(join(directory, "events.jsonl"), constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW);
    try { await file.writeFile(Buffer.from(JSON.stringify({ sequence: ++sequence, ...event }) + "\n")); await file.sync(); }
    finally { await file.close(); }
  };
  await append({ kind: "opened", attemptId: id, owner, parentDev: parentStat.dev, parentIno: parentStat.ino });
  return { id, directory, owner, append };
}
async function rootIdentity(path: string, markerName: string): Promise<RootIdentity> {
  assert(typeof process.getuid === "function");
  const root = await fs.lstat(path), workspace = await fs.lstat(join(path, "workspace"));
  const markerPath = join(path, markerName), marker = await fs.lstat(markerPath);
  assert(root.isDirectory() && workspace.isDirectory() && !root.isSymbolicLink() && !workspace.isSymbolicLink()
    && marker.isFile() && !marker.isSymbolicLink() && marker.nlink === 1 && marker.size <= 4096
    && root.uid === process.getuid() && workspace.uid === root.uid && marker.uid === root.uid
    && (root.mode & 0o777) === 0o700 && (workspace.mode & 0o777) === 0o700
    && (marker.mode & 0o777) === 0o600 && await fs.realpath(path) === path);
  const file = await fs.open(markerPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let markerSha256: string;
  try {
    const opened = await file.stat();
    assert(opened.dev === marker.dev && opened.ino === marker.ino && opened.size === marker.size);
    markerSha256 = sha(await file.readFile());
  } finally { await file.close(); }
  return { path, rootDev: root.dev, rootIno: root.ino, workspaceDev: workspace.dev,
    workspaceIno: workspace.ino, markerDev: marker.dev, markerIno: marker.ino, markerSha256, uid: root.uid };
}
async function registerRoot(journal: AttemptJournal, root: AllocatedRoot, path: string): Promise<void> {
  const identity = await rootIdentity(path, root === "twin" ? ".twin-core-root" : ".twin-scenario-root");
  await journal.append({ kind: "registered", root, identity });
}
export async function admitS8S13Cleanup(directory: string, roots: readonly AllocatedRoot[]): Promise<boolean> {
  try {
    assert(typeof process.getuid === "function");
    const uid = process.getuid();
    const stat = await fs.lstat(directory);
    assert(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === uid
      && (stat.mode & 0o777) === 0o700 && await fs.realpath(directory) === directory);
    const ownerPath = join(directory, ".owner"), eventPath = join(directory, "events.jsonl");
    const read = async (path: string, cap: number): Promise<Buffer> => {
      const before = await fs.lstat(path);
      assert(before.isFile() && !before.isSymbolicLink() && before.nlink === 1 && before.uid === uid
        && (before.mode & 0o777) === 0o600 && before.size <= cap);
      const handle = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try { const opened = await handle.stat(); assert(opened.dev === before.dev && opened.ino === before.ino);
        const bytes = await handle.readFile(); assert(bytes.length === before.size); return bytes; }
      finally { await handle.close(); }
    };
    const owner = (await read(ownerPath, 100)).toString("utf8").trim();
    assert(/^[a-f0-9]{64}$/.test(owner));
    const lines = (await read(eventPath, 1024 * 1024)).toString("utf8");
    assert(lines.endsWith("\n"));
    const events = lines.trimEnd().split("\n").map(line => JSON.parse(line) as JournalEvent & { sequence: number });
    assert(events[0]?.kind === "opened" && events[0].owner === owner
      && join(dirname(directory), `twin-s8-s13-${events[0].attemptId}`) === directory);
    const parent = await fs.lstat(dirname(directory));
    assert(parent.dev === events[0].parentDev && parent.ino === events[0].parentIno);
    for (let i = 0; i < events.length; i++) assert(events[i]?.sequence === i + 1);
    assert(!events.some(event => event.kind === "failure"));
    const copyIndex = events.findIndex(event => event.kind === "copy-validated");
    const launchIndex = events.findIndex(event => event.kind === "launch-intent");
    const settlementIndex = events.findIndex(event => event.kind === "settlement");
    const evidenceIndex = events.findIndex(event => event.kind === "evidence-complete");
    assert(copyIndex > 0 && launchIndex > copyIndex && settlementIndex > launchIndex && evidenceIndex > settlementIndex
      && events.filter(event => event.kind === "copy-validated").length === 1
      && events.filter(event => event.kind === "evidence-complete").length === 1);
    const launches = events.filter(event => event.kind === "launch-intent");
    const settlements = events.filter(event => event.kind === "settlement");
    assert(launches.length === 1 && settlements.length === 1);
    assert(settlements[0]?.process === "settled"
      && settlements[0].outcome === "exited" && settlements[0].started
      && settlements[0].exitCode === 0 && settlements[0].signal === null
      && settlements[0].stdoutComplete && settlements[0].stderrComplete);
    for (const name of roots) {
      assert(events.filter(event => event.kind === "allocation-intent" && event.root === name).length === 1);
      const registrations = events.filter(event => event.kind === "registered" && event.root === name);
      assert(registrations.length === 1 && registrations[0]?.identity);
      assert(events.indexOf(registrations[0]) < copyIndex);
      const expected = registrations[0].identity!;
      const allocated = events.filter(event => event.kind === "allocated" && event.root === name);
      assert(allocated.length === 1 && allocated[0]?.path === expected.path
        && allocated[0].dev === expected.rootDev && allocated[0].ino === expected.rootIno);
      const actual = await rootIdentity(expected.path, name === "twin" ? ".twin-core-root" : ".twin-scenario-root");
      assert.deepEqual(actual, expected);
    }
    return true;
  } catch { return false; }
}
async function exactS8(entries: readonly Entry[]): Promise<void> {
  assert.deepEqual(entries.map(value => [value.path, value.kind, value.mode]), [
    ["", "directory", 0o700], [".control", "file", 0o600], ["controls", "directory", 0o700],
    ["controls/keep.txt", "file", 0o600], ["delete-me.txt", "file", 0o600]]);
}
function exactS9(entries: readonly Entry[]): void {
  assert.deepEqual(entries.map(value => [value.path, value.kind, value.mode]), [
    ["", "directory", 0o700], [".project-control", "file", 0o600], ["project.txt", "file", 0o600]]);
}
function exactHome(entries: readonly Entry[], changed: boolean): void {
  assert.deepEqual(entries.map(value => [value.path, value.kind, value.mode, value.sha256 ?? null]), [
    ["", "directory", 0o700, null], [".s9-note", "file", 0o600,
      sha(Buffer.from(s9InitialNote + (changed ? s9AppendedLine : "")))]]);
}
async function freshCleanupSnapshot(root: OwnedScenarioRoot): Promise<Snapshot> {
  const { workspace } = await verifyWorkspace(root);
  await inventory(workspace); // Complete recursive observation; Snapshot's path union only covers S12/S6.
  return { workspace, observedAt: new Date().toISOString(), complete: true, paths: [] };
}
function same(a: readonly Entry[], b: readonly Entry[]): void { assert.deepEqual(content(a), content(b)); }
function sameIdentity(a: readonly Entry[], b: readonly Entry[]): void {
  assert.deepEqual(a.map(value => [value.path, value.dev, value.ino]),
    b.map(value => [value.path, value.dev, value.ino]));
}
function copied(a: readonly Entry[], b: readonly Entry[]): void {
  // Core copies directory contents and file modes; its newly made Git subdirectories may use 0755.
  assert.deepEqual(a.map(value => [value.path, value.kind, value.kind === "file" ? value.mode : null, value.sha256 ?? null]),
    b.map(value => [value.path, value.kind, value.kind === "file" ? value.mode : null, value.sha256 ?? null]));
}
function noSharedFiles(a: readonly Entry[], b: readonly Entry[]): void {
  for (const item of a.filter(value => value.kind === "file")) {
    const other = b.find(value => value.path === item.path);
    assert(other && (item.dev !== other.dev || item.ino !== other.ino), `Shared file: ${item.path}`);
  }
}
function resultReady(result: RunResult, id: MeasuredScenario): void {
  assert(result.outcome === "exited" && result.started && result.directChildSettled && result.exitCode === 0
    && result.signal === null && result.spawnError === null && result.terminationError === null);
  assert(result.stdout.complete && !result.stdout.truncated && result.stdout.error === null);
  assert(result.stderr.complete && !result.stderr.truncated && result.stderr.error === null);
  assert(Buffer.from(result.stdout.bytes).equals(Buffer.from(success[id])));
  assert.equal(result.stderr.bytes.length, 0);
}
interface Evidence {
  schemaVersion: 1; scenarioId: MeasuredScenario; actionSha256: string; attemptId: string;
  toolVersion: string; adapterVersion: string;
  originalBefore: readonly Entry[]; copyBefore: readonly Entry[]; copyAfter: readonly Entry[];
  originalAfter: readonly Entry[]; originalAfterDiscard: readonly Entry[];
  homeBefore?: readonly Entry[]; homeAfter?: readonly Entry[]; homeAfterDiscard?: readonly Entry[];
  action: { started: boolean; directChildSettled: boolean; exitCode: number | null;
    stdoutBase64: string; stderrBase64: string; stdoutComplete: boolean; stderrComplete: boolean };
  receipt: { coverage: string; changes: readonly { path: string; change: string; category: string }[];
    watch: readonly { id: string; comparison: string }[] };
  rootsAtCapture: Record<RootName, RootState>;
}
function decodeReceipt(session: TwinSession, id: MeasuredScenario): Evidence["receipt"] {
  const receipt = session.inspect().receipt;
  assert(receipt && receipt.files.coverage === "complete" && receipt.files.issues.length === 0);
  const changes = receipt.files.changes.map(item => ({ path: item.path.encoding === "utf8" ? item.path.value : "<encoded>",
    change: item.change, category: item.category }));
  if (id === "S8") assert.deepEqual(changes, [{ path: "delete-me.txt", change: "deleted", category: "unclassified" }]);
  else assert.deepEqual(changes, []);
  const watch = receipt.watch.map(item => ({ id: item.id, comparison: item.comparison }));
  if (id === "S9") assert(!watch.some(item => String(item.id) === ".s9-note"));
  return { coverage: receipt.files.coverage, changes, watch };
}
function assess(id: MeasuredScenario) {
  const unknown = (reason: string) => ({ outcome: "unknown" as const, reason, evidenceRefs: [] });
  return {
    recoveredOrPreserved: id === "S9" ? { outcome: "not-recovered" as const,
      reason: "The fake-home dotfile remained changed after Twin discard; harness teardown is separate.",
      evidenceRefs: ["home-before" as const, "home-after-discard" as const] }
      : unknown("Observed original endpoints do not establish continuous preservation or recovery."),
    reported: id === "S8" ? { outcome: "reported" as const, reason: "Twin receipt identifies the copied target deletion.",
      evidenceRefs: ["receipt" as const] } : id === "S9" ? { outcome: "not-reported" as const,
      reason: "The retained receipt omits the observed fake-home dotfile change.",
      evidenceRefs: ["home-before" as const, "home-after" as const, "receipt" as const] }
      : unknown("A read-only action creates no file-change report; read reporting was not established."),
    blockedBeforeExecution: { outcome: "not-blocked" as const, reason: "The fixed action started and completed in Twin.",
      evidenceRefs: ["action" as const] },
    workspaceUsable: { outcome: "usable" as const, reason: id === "S8" ? "The copied target was deleted by the fixed action."
      : id === "S9" ? "The fixed action ran from the copied project and appended to fake home."
        : "The fixed action consumed both ignored inputs in Twin.",
      evidenceRefs: id === "S9" ? ["copy-before" as const, "action" as const, "home-after" as const]
        : ["copy-before" as const, "action" as const, "copy-after" as const] },
    boundaryAccuratelyDescribed: unknown("No version-matched documentation claim was reviewed."),
  };
}
async function writeArtifact(journal: AttemptJournal, evidence: Evidence): Promise<{ id: string; directory: string }> {
  const { id, directory } = journal;
  const body = Buffer.from(JSON.stringify(evidence));
  assert(body.length <= 4 * 1024 * 1024);
  try {
    await writeExclusive(join(directory, "evidence.json"), body);
    return { id, directory };
  } catch (error) { throw new Error("retention-failed", { cause: error }); }
}
async function sealArtifact(journal: AttemptJournal, evidence: Evidence): Promise<void> {
  const body = await fs.readFile(join(journal.directory, "evidence.json"));
  assert.deepEqual(JSON.parse(body.toString()) as unknown, evidence);
  const events = await fs.readFile(join(journal.directory, "events.jsonl"));
  const manifest = Buffer.from(JSON.stringify({ schemaVersion: 1, sha256: sha(body), size: body.length,
    journalSha256: sha(events), journalSize: events.length }));
  await writeExclusive(join(journal.directory, "manifest.json"), manifest);
  assert.deepEqual(await reopenS8S13Artifact(journal.directory), evidence);
}
export async function reopenS8S13Artifact(directory: string): Promise<Evidence> {
  assert(typeof process.getuid === "function");
  const uid = process.getuid();
  assert(isAbsolute(directory) && normalize(directory) === directory && await fs.realpath(directory) === directory);
  const dir = await fs.lstat(directory);
  assert(dir.isDirectory() && !dir.isSymbolicLink() && dir.uid === uid && (dir.mode & 0o777) === 0o700);
  assert.deepEqual((await fs.readdir(directory)).sort(), [".owner", "events.jsonl", "evidence.json", "manifest.json"]);
  const read = async (name: string, cap: number): Promise<Buffer> => {
    const path = join(directory, name), before = await fs.lstat(path);
    assert(before.isFile() && !before.isSymbolicLink() && before.nlink === 1 && before.uid === uid
      && (before.mode & 0o777) === 0o600 && before.size <= cap);
    const file = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const opened = await file.stat();
      assert(opened.dev === before.dev && opened.ino === before.ino && opened.size === before.size);
      const bytes = await file.readFile(), after = await file.stat(), named = await fs.lstat(path);
      assert(bytes.length === before.size && after.mtimeMs === before.mtimeMs && after.ctimeMs === before.ctimeMs
        && named.dev === before.dev && named.ino === before.ino);
      return bytes;
    } finally { await file.close(); }
  };
  const body = await read("evidence.json", 4 * 1024 * 1024), events = await read("events.jsonl", 1024 * 1024);
  const manifest = JSON.parse((await read("manifest.json", 1024)).toString()) as unknown;
  assert(manifest && typeof manifest === "object" && "sha256" in manifest && "size" in manifest
    && "journalSha256" in manifest && "journalSize" in manifest
    && manifest.sha256 === sha(body) && manifest.size === body.length
    && manifest.journalSha256 === sha(events) && manifest.journalSize === events.length);
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)) as Evidence;
}
export async function produceS8S13Score(id: MeasuredScenario, artifactParentDirectory: string): Promise<S8S13Result> {
  const roots = emptyRoots();
  if (!await parentReady(artifactParentDirectory)) return incomplete(id, "preflight", roots);
  let stage: Stage = "fixture", original: OwnedScenarioRoot | undefined, support: OwnedScenarioRoot | undefined;
  let home: OwnedScenarioRoot | undefined, homeBefore: Entry[] | undefined, homeAfter: Entry[] | undefined;
  let homeAfterDiscard: Entry[] | undefined, homeWorkspace: string | undefined;
  let session: TwinSession | undefined, originalBefore: Entry[] | undefined, copyBefore: Entry[] | undefined;
  let copyAfter: Entry[] | undefined, originalAfter: Entry[] | undefined, originalAfterDiscard: Entry[] | undefined;
  let run: RunResult | undefined, receipt: Evidence["receipt"] | undefined;
  let directChild: S8S13Incomplete["process"]["directChild"] = "not-launched";
  let journal: AttemptJournal | undefined, attemptId: string | null = null;
  try {
    assert(id === "S8" || id === "S13" || id === "S9");
    assert(process.execPath.startsWith("/"));
    attemptId = randomUUID();
    const toolVersion = await fingerprint(fileURLToPath(new URL("../../core/dist/", import.meta.url)), coreModules);
    const adapterVersion = await fingerprint(fileURLToPath(new URL("../dist/", import.meta.url)), adapterModules);
    if (id === "S13") for (const [name, value] of Object.entries(s13Files)) assert.equal(fixtureContents[name as keyof typeof fixtureContents], value);
    journal = await openJournal(artifactParentDirectory, attemptId); roots.artifact = "retained";
    await journal.append({ kind: "disposition", root: "artifact", disposition: "retained" });
    await journal.append({ kind: "allocation-intent", root: "support" });
    roots.support = "unknown";
    support = await createScenarioRoot(); roots.support = "retained";
    { const stat = await fs.lstat(support.scenarioRoot);
      await journal.append({ kind: "allocated", root: "support", path: support.scenarioRoot, dev: stat.dev, ino: stat.ino }); }
    await initializeScenarioRoot(support);
    await registerRoot(journal, "support", support.scenarioRoot);
    await journal.append({ kind: "disposition", root: "support", disposition: "retained" });
    const supportWorkspace = (await verifyWorkspace(support)).workspace;
    const asset = join(supportWorkspace, actionName[id]);
    await fs.writeFile(asset, actionBytes[id], { flag: "wx", mode: 0o600 });
    await fs.chmod(asset, 0o600);
    await exactFile(supportWorkspace, actionName[id], actionBytes[id], 0o600);
    const scratch = join(supportWorkspace, "scratch");
    await fs.mkdir(scratch, { mode: 0o700 });
    await fs.chmod(scratch, 0o700);
    await journal.append({ kind: "allocation-intent", root: "original" }); roots.original = "unknown";
    original = await createScenarioRoot(); roots.original = "retained";
    { const stat = await fs.lstat(original.scenarioRoot);
      await journal.append({ kind: "allocated", root: "original", path: original.scenarioRoot, dev: stat.dev, ino: stat.ino }); }
    await initializeScenarioRoot(original);
    await registerRoot(journal, "original", original.scenarioRoot);
    await journal.append({ kind: "disposition", root: "original", disposition: "retained" });
    const source = (await verifyWorkspace(original)).workspace;
    if (id === "S8") {
      await fs.mkdir(join(source, "controls"), { mode: 0o700 });
      await fs.chmod(join(source, "controls"), 0o700);
      for (const [name, value] of Object.entries(s8Files)) {
        await fs.writeFile(join(source, name), value, { flag: "wx", mode: 0o600 });
        await fs.chmod(join(source, name), 0o600);
      }
    } else if (id === "S13") { await initializeFixture(original, []); }
    else {
      for (const [name, value] of Object.entries(s9Files)) {
        await fs.writeFile(join(source, name), value, { flag: "wx", mode: 0o600 });
        await fs.chmod(join(source, name), 0o600);
      }
    }
    originalBefore = await inventory(source);
    if (id === "S8") await exactS8(originalBefore);
    if (id === "S9") exactS9(originalBefore);
    await requireInputs(id, source, originalBefore);
    if (id === "S9") {
      await journal.append({ kind: "allocation-intent", root: "home" }); roots.home = "unknown";
      home = await createScenarioRoot(); roots.home = "retained";
      { const stat = await fs.lstat(home.scenarioRoot);
        await journal.append({ kind: "allocated", root: "home", path: home.scenarioRoot, dev: stat.dev, ino: stat.ino }); }
      await initializeScenarioRoot(home);
      await registerRoot(journal, "home", home.scenarioRoot);
      await journal.append({ kind: "disposition", root: "home", disposition: "retained" });
      homeWorkspace = (await verifyWorkspace(home)).workspace;
      assert(!within(source, homeWorkspace) && !within(homeWorkspace, source));
      await fs.writeFile(join(homeWorkspace, ".s9-note"), s9InitialNote, { flag: "wx", mode: 0o600 });
      await fs.chmod(join(homeWorkspace, ".s9-note"), 0o600);
      homeBefore = await inventory(homeWorkspace); exactHome(homeBefore, false);
      await exactFile(homeWorkspace, ".s9-note", Buffer.from(s9InitialNote), 0o600);
    }
    stage = "copy";
    await journal.append({ kind: "allocation-intent", root: "twin" }); roots.twin = "unknown";
    session = await createTwin({ sourceDirectory: source, scratchParent: scratch }); roots.twin = "retained";
    { const path = dirname(session.workspacePath), stat = await fs.lstat(path);
      await journal.append({ kind: "allocated", root: "twin", path, dev: stat.dev, ino: stat.ino });
      await registerRoot(journal, "twin", path);
      await journal.append({ kind: "disposition", root: "twin", disposition: "retained" }); }
    assert(session.inspect().state === "ready");
    copyBefore = await inventory(session.workspacePath);
    copied(originalBefore, copyBefore); noSharedFiles(originalBefore, copyBefore);
    await requireInputs(id, session.workspacePath, copyBefore);
    if (id === "S9") assert(home && homeWorkspace && homeBefore && !within(session.workspacePath, homeWorkspace));
    await journal.append({ kind: "copy-validated" });
    assert.equal((await verifyWorkspace(original)).workspace, source);
    assert.equal((await verifyWorkspace(support)).workspace, supportWorkspace);
    await exactFile(supportWorkspace, actionName[id], actionBytes[id], 0o600);
    if (id === "S9") {
      assert(home && homeWorkspace && homeBefore);
      assert.equal((await verifyWorkspace(home)).workspace, homeWorkspace);
      const beforeLaunch = await inventory(homeWorkspace); same(homeBefore, beforeLaunch);
      sameIdentity(homeBefore, beforeLaunch);
    }
    stage = "action";
    await journal.append({ kind: "launch-intent", executable: process.execPath, actionSha256: actionDigest(id) });
    directChild = "unknown";
    run = await session.run({ executable: process.execPath, argv: [asset],
      env: id === "S9" ? { ...environment, HOME: homeWorkspace! } : environment, timeoutMs: 5000 });
    directChild = run.directChildSettled ? "settled" : "unsettled";
    await journal.append({ kind: "settlement", process: directChild, outcome: run.outcome, started: run.started,
      exitCode: run.exitCode, signal: run.signal, stdoutComplete: run.stdout.complete && !run.stdout.truncated,
      stderrComplete: run.stderr.complete && !run.stderr.truncated });
    if (!run.directChildSettled || run.outcome === "timed-out") { stage = "settlement"; throw new Error("unsettled-action"); }
    resultReady(run, id);
    stage = "observation";
    copyAfter = await inventory(session.workspacePath);
    originalAfter = await inventory(source);
    same(originalBefore, originalAfter);
    sameIdentity(originalBefore, originalAfter);
    if (id === "S9") {
      assert(homeWorkspace && homeBefore);
      homeAfter = await inventory(homeWorkspace); exactHome(homeAfter, true);
      sameIdentity(homeBefore, homeAfter);
      assert.deepEqual(homeBefore.map(value => value.path), homeAfter.map(value => value.path));
      await exactFile(homeWorkspace, ".s9-note", Buffer.from(s9InitialNote + s9AppendedLine), 0o600);
    }
    if (id === "S8") {
      const remaining = copyBefore.filter(value => value.path !== "delete-me.txt");
      same(remaining, copyAfter); sameIdentity(remaining, copyAfter);
    } else { same(copyBefore, copyAfter); sameIdentity(copyBefore, copyAfter); }
    receipt = decodeReceipt(session, id);
    await journal.append({ kind: "evidence-complete" });
    stage = "cleanup";
    assert(await admitS8S13Cleanup(journal.directory, id === "S9"
      ? ["original", "support", "twin", "home"] : ["original", "support", "twin"]));
    const discarded = await session.discard();
    assert(discarded.status === "removed"); roots.twin = "removed";
    await journal.append({ kind: "disposition", root: "twin", disposition: "removed" });
    originalAfterDiscard = await inventory(source); same(originalBefore, originalAfterDiscard);
    sameIdentity(originalBefore, originalAfterDiscard);
    if (id === "S9") {
      assert(homeWorkspace && homeBefore && homeAfter);
      homeAfterDiscard = await inventory(homeWorkspace); exactHome(homeAfterDiscard, true);
      same(homeAfter, homeAfterDiscard); sameIdentity(homeAfter, homeAfterDiscard);
    }
    stage = "retention";
    if (id === "S9") assert(homeBefore && homeAfter && homeAfterDiscard);
    const evidence: Evidence = { schemaVersion: 1, scenarioId: id, actionSha256: actionDigest(id), attemptId,
      toolVersion, adapterVersion,
      originalBefore, copyBefore, copyAfter, originalAfter, originalAfterDiscard,
      ...(id === "S9" ? { homeBefore: homeBefore!, homeAfter: homeAfter!, homeAfterDiscard: homeAfterDiscard! } : {}),
      action: { started: run.started, directChildSettled: run.directChildSettled, exitCode: run.exitCode,
        stdoutBase64: Buffer.from(run.stdout.bytes).toString("base64"), stderrBase64: Buffer.from(run.stderr.bytes).toString("base64"),
        stdoutComplete: run.stdout.complete, stderrComplete: run.stderr.complete }, receipt, rootsAtCapture: { ...roots } };
    const artifact = await writeArtifact(journal, evidence);
    stage = "cleanup";
    assert(await admitS8S13Cleanup(journal.directory, id === "S9"
      ? ["original", "support", "home"] : ["original", "support"]));
    if (id === "S9") {
      assert(home && homeWorkspace && homeAfterDiscard);
      const homeSnapshot = await freshCleanupSnapshot(home);
      assert(homeSnapshot.complete);
      const homeCleanup = await cleanupScenarioRoot(home, homeSnapshot);
      assert(homeCleanup.status === "removed"); roots.home = "removed";
      await journal.append({ kind: "disposition", root: "home", disposition: "removed" });
    }
    const originalSnapshot = await freshCleanupSnapshot(original);
    assert(originalSnapshot.complete);
    const originalCleanup = await cleanupScenarioRoot(original, originalSnapshot);
    assert(originalCleanup.status === "removed"); roots.original = "removed";
    await journal.append({ kind: "disposition", root: "original", disposition: "removed" });
    assert(await admitS8S13Cleanup(journal.directory, ["support"]));
    const supportSnapshot = await freshCleanupSnapshot(support);
    assert(supportSnapshot.complete && (await fs.readdir(scratch)).length === 0);
    const supportCleanup = await cleanupScenarioRoot(support, supportSnapshot);
    assert(supportCleanup.status === "removed"); roots.support = "removed";
    await journal.append({ kind: "disposition", root: "support", disposition: "removed" });
    await sealArtifact(journal, evidence);
    const complete = S8S13CompleteSchema.parse({ schemaVersion: 1, resultVersion: 1, status: "complete", scenarioId: id,
      tool: "Twin", actionSha256: actionDigest(id), artifactId: artifact.id, roots: publicRoots(id, roots),
      attemptId, toolVersion, adapterVersion,
      process: { directChild: "exited", descendants: "not-established" }, score: assess(id) });
    return S8S13ResultSchema.parse(complete);
  } catch {
    if (journal) {
      try {
        await journal.append({ kind: "failure", stage, process: directChild });
        for (const root of ["support", "original", "twin", "home", "artifact"] as const)
          await journal.append({ kind: "disposition", root, disposition: roots[root] });
      }
      catch { roots.artifact = "unknown"; }
    }
    return incomplete(id, stage, roots, directChild, attemptId);
  }
}
