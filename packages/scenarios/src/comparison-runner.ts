import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createTwin, type TwinSession } from "@twin-cli/core";
import { fixtureContents } from "./scenarios.js";
import { s8Files, s9Files, s9InitialNote, s9AppendedLine } from "./s8-s13-fixtures.js";
import { fixedAction, s11Worker } from "./comparison-actions.js";
import { ComparisonResultSchema, type ComparisonResult, type ComparisonRow, type ScenarioId, type ToolId } from "./comparison-result.js";

const ids: readonly ScenarioId[] = ["S1", "S2", "S3", "S4", "S5", "S6", "S7", "S8", "S9", "S10", "S11", "S12", "S13"];
const tools: readonly ToolId[] = ["twin", "agenttx", "plain-git"];
const git = "/usr/bin/git";
const marker = ".twin-phase2-comparison-owner";
const recipe = ["restore", "--source=HEAD", "--worktree", "--", "."];
const repo = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const within = (parent: string, child: string): boolean => {
  const tail = relative(parent, child);
  return tail === "" || (!isAbsolute(tail) && tail !== ".." && !tail.startsWith(`..${sep}`));
};
interface CommandResult { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string;
  timedOut: boolean; error: string | null }
interface Root { path: string; token: string; dev: number; ino: number }
export interface ComparisonRootAccounting { allocated: number; removed: number }
interface State { readonly [name: string]: string | null }
const hash = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
async function command(executable: string, argv: readonly string[], cwd: string, env: Record<string, string>,
  timeout = 20_000): Promise<CommandResult> {
  assert(isAbsolute(executable) && isAbsolute(cwd) && timeout <= 30_000);
  return await new Promise(resolveResult => {
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    let size = 0, timedOut = false, error: string | null = null;
    const child = spawn(executable, [...argv], { cwd, env, shell: false, detached: false,
      stdio: ["ignore", "pipe", "pipe"] });
    const stop = (): void => {
      timedOut = true;
      child.kill("SIGKILL");
      child.stdout.destroy();
      child.stderr.destroy();
    };
    const timer = setTimeout(stop, timeout);
    const collect = (chunks: Buffer[], bytes: Buffer): void => {
      size += bytes.length;
      if (size > 1024 * 1024) stop();
      else chunks.push(Buffer.from(bytes));
    };
    child.stdout.on("data", (bytes: Buffer) => collect(stdout, bytes));
    child.stderr.on("data", (bytes: Buffer) => collect(stderr, bytes));
    child.on("error", value => { error = value.message; });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolveResult({ code, signal, stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"), timedOut, error });
    });
  });
}
function settled(result: CommandResult): void {
  assert(!result.timedOut && result.signal === null && result.error === null && result.code !== null,
    "Child settlement uncertain; root retained");
}
export function prerequisiteProbeState(results: readonly CommandResult[]): "settled" | "uncertain" {
  return results.every(result => !result.timedOut && result.signal === null
    && result.error === null && result.code !== null) ? "settled" : "uncertain";
}
export async function finishPrerequisiteRoot(
  probeState: "not-started" | "settled" | "uncertain", remove: () => Promise<void>,
): Promise<void> {
  if (probeState === "uncertain") throw new ComparisonPrerequisiteFailure("probe-settlement-uncertain");
  await remove();
}
async function allocate(accounting?: ComparisonRootAccounting): Promise<Root> {
  const base = await fs.realpath(tmpdir());
  assert(!within(repo, base) && !within(resolve(homedir()), base) && base !== "/");
  const path = await fs.mkdtemp(join(base, "twin-phase2-comparison-"));
  if (accounting) accounting.allocated++;
  const stat = await fs.lstat(path), token = randomBytes(32).toString("hex");
  const root = { path, token, dev: stat.dev, ino: stat.ino };
  await fs.chmod(path, 0o700);
  await fs.writeFile(join(path, marker), token, { flag: "wx", mode: 0o600 });
  return root;
}
async function verifyRoot(root: Root): Promise<void> {
  const stat = await fs.lstat(root.path), owner = await fs.lstat(join(root.path, marker));
  assert(stat.isDirectory() && !stat.isSymbolicLink() && stat.dev === root.dev && stat.ino === root.ino
    && stat.uid === process.getuid?.() && (stat.mode & 0o777) === 0o700);
  assert(await fs.realpath(root.path) === root.path && owner.isFile() && !owner.isSymbolicLink()
    && owner.nlink === 1 && (owner.mode & 0o777) === 0o600);
  assert.equal(await fs.readFile(join(root.path, marker), "utf8"), root.token);
}
async function cleanup(root: Root, accounting?: ComparisonRootAccounting): Promise<void> {
  await verifyRoot(root);
  // The only recursively removed path is the freshly registered, marker-checked root.
  await fs.rm(root.path, { recursive: true });
  await assert.rejects(fs.lstat(root.path), { code: "ENOENT" });
  if (accounting) accounting.removed++;
}
const config = (root: Root): Record<string, string> => ({
  HOME: join(root.path, "home"), AGENTTX_HOME: join(root.path, "store"),
  XDG_CONFIG_HOME: join(root.path, "config"), XDG_CACHE_HOME: join(root.path, "cache"),
  TMPDIR: join(root.path, "tmp"), PATH: `${dirname(process.execPath)}:/usr/bin`,
  LANG: "C", LC_ALL: "C", TZ: "UTC", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null", GIT_ATTR_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0",
  NPM_CONFIG_PREFIX: join(root.path, "prefix"), NPM_CONFIG_CACHE: join(root.path, "cache"),
  NPM_CONFIG_USERCONFIG: join(root.path, "home", ".npmrc"),
  NPM_CONFIG_GLOBALCONFIG: join(root.path, "home", "global.npmrc"),
  NPM_CONFIG_OFFLINE: "true", NPM_CONFIG_IGNORE_SCRIPTS: "true", NPM_CONFIG_AUDIT: "false",
  NPM_CONFIG_FUND: "false", NPM_CONFIG_UPDATE_NOTIFIER: "false", NPM_CONFIG_LOGLEVEL: "error",
});
async function setup(root: Root, id: ScenarioId, env: Record<string, string>): Promise<{ project: string; action: string[] }> {
  for (const name of ["home", "store", "config", "cache", "tmp", "prefix", "support", "scratch", "project"])
    await fs.mkdir(join(root.path, name), { mode: 0o700 });
  await fs.writeFile(join(root.path, "home", ".npmrc"), "", { flag: "wx", mode: 0o600 });
  await fs.writeFile(join(root.path, "home", "global.npmrc"), "", { flag: "wx", mode: 0o600 });
  const project = join(root.path, "project");
  const files: Record<string, string> = id === "S8" ? { ...s8Files } : id === "S9" ? { ...s9Files }
    : { ...fixtureContents, ...(id === "S3" || id === "S7" ? { ".env": "SECRET=123" } : {}) };
  for (const [name, value] of Object.entries(files)) {
    const path = join(project, name);
    await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await fs.writeFile(path, value, { flag: "wx", mode: 0o600 });
  }
  if (id !== "S8") {
    for (const argv of [["init", "--initial-branch=main", "--template="],
      ["add", "--", ...(id === "S9" ? Object.keys(s9Files) : ["notes.txt", "app.js", ".gitignore"])],
      ["-c", "user.name=Twin Scenario", "-c", "user.email=twin-scenario@example.invalid", "-c", "commit.gpgSign=false",
        "-c", "core.hooksPath=/dev/null", "commit", "-m", "Establish disposable scenario baseline"]]) {
      const result = await command(git, argv, project, env); settled(result); assert.equal(result.code, 0, result.stderr);
    }
  }
  if (id === "S4") await fs.writeFile(join(project, "app.js"), 'console.log("unsaved edit");\n');
  if (id === "S5") await fs.writeFile(join(project, "notes.txt"), "Unsaved edited notes.\n");
  if (id === "S9") await fs.writeFile(join(root.path, "home", ".s9-note"), s9InitialNote, { flag: "wx", mode: 0o600 });
  if (id === "S11") {
    await fs.writeFile(join(root.path, "support", "s11-worker.mjs"), s11Worker, { flag: "wx", mode: 0o600 });
    env.TWIN_S11_MARKER = join(root.path, "support", "worker-marker.json");
    env.TWIN_S11_TOKEN = randomBytes(24).toString("hex");
  }
  if (id === "S10") {
    const packageDir = join(root.path, "support", "package");
    await fs.mkdir(packageDir, { mode: 0o700 });
    await fs.writeFile(join(packageDir, "package.json"), '{"name":"twin-s10-offline-probe","version":"1.0.0","main":"index.js"}\n');
    await fs.writeFile(join(packageDir, "index.js"), "module.exports = 10;\n");
    const npm = await fs.realpath(join(dirname(process.execPath), "npm"));
    const packed = await command(process.execPath, [npm, "pack", packageDir, "--pack-destination", join(root.path, "support"),
      "--offline", "--ignore-scripts", "--no-audit", "--no-fund"], packageDir, env);
    settled(packed); assert.equal(packed.code, 0, packed.stderr);
    assert.equal(packed.stdout.trim(), "twin-s10-offline-probe-1.0.0.tgz");
  }
  const asset = id === "S12" ? { name: "create-file.mjs",
    bytes: await fs.readFile(fileURLToPath(new URL("./actions/create-file.js", import.meta.url))) } : fixedAction[id];
  if (asset) {
    const path = join(root.path, "support", asset.name);
    await fs.writeFile(path, asset.bytes, { flag: "wx", mode: 0o600 });
    assert((await fs.readFile(path)).equals(asset.bytes));
  }
  const action = id === "S6" ? [git, "clean", "-fdx"] : id === "S4" ? [git, "reset", "--hard"]
    : id === "S10" ? [process.execPath, await fs.realpath(join(dirname(process.execPath), "npm")), "install", "-g",
      "--prefix", join(root.path, "prefix"), "--offline", "--ignore-scripts", "--no-audit", "--no-fund",
      join(root.path, "support", "twin-s10-offline-probe-1.0.0.tgz")]
      : [process.execPath, join(root.path, "support", asset!.name)];
  assert(action[0] === git || action[0] === process.execPath);
  return { project, action };
}
async function state(root: Root, project: string, id: ScenarioId): Promise<State> {
  const target = id === "S1" || id === "S5" ? ["notes.txt"] : id === "S2" ? ["scratch.txt"]
    : id === "S3" || id === "S7" ? [".env"] : id === "S4" ? ["app.js"]
      : id === "S6" ? ["scratch.txt", ".env", "node_modules/lib.txt"] : id === "S8" ? ["delete-me.txt"]
        : id === "S9" ? ["home/.s9-note"] : id === "S10" ? ["prefix/lib/node_modules/twin-s10-offline-probe/package.json"]
          : id === "S11" ? ["worker"] : id === "S12" ? ["control-created.txt"]
            : [".env", "node_modules/lib.txt"];
  const result: Record<string, string | null> = {};
  for (const name of target) {
    if (name === "worker") {
      const pid = await workerPid(root);
      if (pid === null) { result[name] = null; continue; }
      try {
        const stat = await fs.readFile(`/proc/${pid}/stat`, "utf8");
        const fields = stat.slice(stat.lastIndexOf(") ") + 2).split(" ");
        if (fields[0] === "Z" || fields[0] === "X") { result[name] = null; continue; }
        const args = (await fs.readFile(`/proc/${pid}/cmdline`)).toString().split("\0").filter(Boolean);
        if (args.length === 0) {
          const later = await fs.readFile(`/proc/${pid}/stat`, "utf8");
          const laterFields = later.slice(later.lastIndexOf(") ") + 2).split(" ");
          if (laterFields[0] === "Z" || laterFields[0] === "X") { result[name] = null; continue; }
        }
        assert.deepEqual(args, [process.execPath, join(root.path, "support", "s11-worker.mjs"),
          join(root.path, "support", "worker-marker.json"),
          await fs.readFile(join(root.path, "support", "worker-token"), "utf8")]);
        result[name] = "running";
      } catch (error: unknown) {
        if (error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ESRCH")) result[name] = null;
        else throw error;
      }
      continue;
    }
    const path = name.startsWith("home/") || name.startsWith("prefix/") || name.startsWith("support/")
      ? join(root.path, name) : join(project, name);
    try {
      const item = await fs.lstat(path);
      assert(item.isFile() && !item.isSymbolicLink() && item.nlink === 1);
      result[name] = hash(await fs.readFile(path));
    } catch (error: unknown) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") result[name] = null;
      else throw error;
    }
  }
  return result;
}
function targetEffect(id: ScenarioId, before: State, after: State, actionSucceeded: boolean): ComparisonRow["observations"]["targetAfterAction"] {
  if (!actionSucceeded) return "unknown";
  const keys = Object.keys(before);
  if (id === "S13") return keys.every(key => before[key] === after[key] && after[key] !== null) ? "expected-effect" : "different-effect";
  if (id === "S6") return keys.every(key => before[key] !== null && after[key] === null) ? "expected-effect" : "different-effect";
  if (id === "S1" || id === "S2" || id === "S3" || id === "S5" || id === "S8")
    return before[keys[0]!] !== null && after[keys[0]!] === null ? "expected-effect" : "different-effect";
  if (id === "S12" || id === "S10" || id === "S11")
    return before[keys[0]!] === null && after[keys[0]!] !== null ? "expected-effect" : "different-effect";
  if (id === "S9") return after["home/.s9-note"] === hash(Buffer.from(s9InitialNote + s9AppendedLine))
    ? "expected-effect" : "different-effect";
  return keys.some(key => before[key] !== after[key]) ? "expected-effect" : "unchanged";
}
function workspaceInputs(id: ScenarioId, values: State): ComparisonRow["observations"]["workspaceInputs"] {
  if (id === "S6" || id === "S13") return values[".env"] && values["node_modules/lib.txt"] ? "present" : "missing";
  const key = Object.keys(values)[0];
  if (id === "S12" || id === "S10" || id === "S11") return "present";
  return key && values[key] ? "present" : "missing";
}
function reportTargets(id: ScenarioId): readonly string[] {
  switch (id) {
    case "S1": case "S5": return ["notes.txt"];
    case "S2": return ["scratch.txt"];
    case "S3": case "S7": return [".env"];
    case "S4": return ["app.js"];
    case "S6": return ["scratch.txt", ".env", "node_modules/lib.txt"];
    case "S8": return ["delete-me.txt"];
    case "S9": return [".s9-note"];
    case "S10": case "S11": case "S13": return [];
    case "S12": return ["control-created.txt"];
  }
}
async function workerPid(root: Root): Promise<number | null> {
  try {
    const value: unknown = JSON.parse(await fs.readFile(join(root.path, "support", "worker-marker.json"), "utf8"));
    assert(value && typeof value === "object" && "pid" in value && "token" in value);
    assert.equal(value.token, (await fs.readFile(join(root.path, "support", "worker-token"), "utf8")));
    assert(typeof value.pid === "number" && Number.isSafeInteger(value.pid) && value.pid > 1);
    return value.pid;
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}
async function stopWorker(root: Root, worker: string, token: string): Promise<void> {
  const markerPath = join(root.path, "support", "worker-marker.json");
  let pid: number;
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(markerPath, "utf8"));
    assert(parsed && typeof parsed === "object" && "pid" in parsed && "token" in parsed);
    assert.equal(parsed.token, token);
    assert(typeof parsed.pid === "number" && Number.isSafeInteger(parsed.pid) && parsed.pid > 1);
    pid = parsed.pid;
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
  const alive = async (): Promise<boolean> => {
    for (let n = 0; n < 100; n++) {
      let line: string, args: Buffer;
      try {
        line = await fs.readFile(`/proc/${pid}/stat`, "utf8");
        args = await fs.readFile(`/proc/${pid}/cmdline`);
      } catch (error: unknown) {
        if (error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ESRCH")) return false;
        throw error;
      }
      const tail = line.slice(line.lastIndexOf(") ") + 2).split(" ");
      if (tail[0] === "Z" || tail[0] === "X") return false;
      const values = args.toString().split("\0").filter(Boolean);
      if (values.length === 0) {
        await new Promise(done => setTimeout(done, 25));
        continue;
      }
      assert.deepEqual(values, [process.execPath, worker, markerPath, token]);
      assert.equal((await fs.stat(`/proc/${pid}`)).uid, process.getuid?.());
      return true;
    }
    throw new Error("Worker identity uncertain; root retained");
  };
  if (!await alive()) return;
  try { process.kill(pid, "SIGTERM"); }
  catch (error: unknown) { if (error instanceof Error && "code" in error && error.code === "ESRCH") return; throw error; }
  for (let n = 0; n < 100; n++) {
    if (!await alive()) return;
    await new Promise(done => setTimeout(done, 25));
  }
  throw new Error("S11 worker did not stop; root retained");
}
type EvidenceRef = ComparisonRow["score"]["reported"]["evidenceRefs"][number];
export type ComparisonFailureStage = "allocation" | "setup" | "launch" | "observation" | "recovery" | "settlement" | "cleanup";
export class ComparisonAttemptFailure extends Error {
  constructor(readonly stage: ComparisonFailureStage, readonly rootDisposition: "removed" | "retained" | "unknown") {
    super(`Comparison attempt ${stage} failed; root ${rootDisposition}`);
  }
}
export class ComparisonPrerequisiteFailure extends Error {
  constructor(readonly code: "agenttx-unavailable" | "agenttx-version-mismatch" | "probe-settlement-uncertain") {
    super(code);
  }
}
const a = <T extends string>(outcome: T, reason: string, ...evidenceRefs: EvidenceRef[]) => ({ outcome, reason, evidenceRefs });
export function evaluateComparisonScore(id: ScenarioId, tool: ToolId, action: ComparisonRow["action"],
  observations: ComparisonRow["observations"]): ComparisonRow["score"] {
  if (id === "S6" && tool === "agenttx") return {
    recoveredOrPreserved: a("unknown", "The AgentTX S6 workspace did not establish equivalent deletion preconditions."),
    reported: a("unknown", "The fixed deletion effect was not established in this AgentTX attempt."),
    blockedBeforeExecution: a("unknown", "The fixed action's start or prevention boundary was not established."),
    workspaceUsable: a("unknown", "Pre-action ignored-input presence was not independently observed."),
    boundaryAccuratelyDescribed: a("unknown", "No version-matched documentation claim was evaluated."),
  };
  const after = observations.targetAfterRecovery;
  const recovery = tool === "plain-git" && observations.targetAfterAction === "expected-effect" && after === "original"
    && id === "S1";
  return {
    recoveredOrPreserved: recovery ? a("recovered", "Git restored the committed tracked file after observed deletion.", "observations.targetAfterAction", "observations.targetAfterRecovery", "recovery")
      : after === "changed" && id !== "S12" ? a("not-recovered", "The target remained changed after the tool recovery step.", "observations.targetBefore", "observations.targetAfterRecovery", "recovery")
        : a("unknown", "Endpoint equality does not establish continuous preservation or tool recovery."),
    reported: id === "S6" && tool === "plain-git"
      ? a("unknown", "Git clean removal stdout is action output; no separate tool report was observed.")
      : observations.report === "mentions-effect" ? a("reported", "The tool report identified the observed effect.", "observations.report", "observations.targetAfterAction")
      : observations.report === "omits-effect" ? a("not-reported", "The observed tool report omitted the effect.", "observations.report", "observations.targetAfterAction")
        : a("unknown", "Report evidence is incomplete or the action effect was not established."),
    blockedBeforeExecution: observations.preventionBeforeAction === "observed"
      && observations.actionStart === "not-started"
      ? a("blocked", "Prevention was observed before the fixed action started.",
        "observations.preventionBeforeAction", "observations.actionStart")
      : observations.actionStart === "started" && action === "completed"
      ? a("not-blocked", "The fixed action ran in the tool workspace.", "observations.actionStart", "action")
      : a("unknown", "A failed or refused command does not establish the action-start or policy-block boundary."),
    workspaceUsable: observations.workspaceInputs === "present" && action === "completed"
      ? a("usable", "Required fixed inputs were available and the action completed.", "observations.workspaceInputs", "action")
      : observations.workspaceInputs === "missing" ? a("unusable", "Required fixed inputs were absent from the execution workspace.", "observations.workspaceInputs")
        : a("unknown", "The actual execution workspace or successful work was not established."),
    boundaryAccuratelyDescribed: a("unknown", "No version-matched claim was evaluated against this exact attempt."),
  };
}
async function attempt(id: ScenarioId, tool: ToolId, versions: Record<ToolId, string>,
  accounting: ComparisonRootAccounting): Promise<ComparisonRow> {
  let root: Root;
  try { root = await allocate(accounting); }
  catch { throw new ComparisonAttemptFailure("allocation", "unknown"); }
  const env = config(root);
  let session: TwinSession | undefined, safeCleanup = true;
  let stage: ComparisonFailureStage = "setup";
  let action: ComparisonRow["action"] = "unknown", recovery: ComparisonRow["recovery"] = "not-started";
  let actionExitCode: number | null = null;
  let workInputs: ComparisonRow["observations"]["workspaceInputs"] = "unknown";
  let effect: ComparisonRow["observations"]["targetAfterAction"] = "unknown";
  let report: ComparisonRow["observations"]["report"] = "unknown";
  let actionOutput: ComparisonRow["observations"]["actionOutput"] = "unknown";
  let policyBlock: ComparisonRow["observations"]["policyBlock"] = "unknown";
  let actionStart: ComparisonRow["observations"]["actionStart"] = "unknown";
  const preventionBeforeAction: ComparisonRow["observations"]["preventionBeforeAction"] = "unknown";
  const compatibility: ComparisonRow["compatibility"] = [];
  let before: State = {}, afterRecovery: State = {}, afterAction: State = {};
  try {
    const { project, action: argv } = await setup(root, id, env);
    const worker = join(root.path, "support", "s11-worker.mjs");
    if (id === "S11") await fs.writeFile(join(root.path, "support", "worker-token"), env.TWIN_S11_TOKEN!, { flag: "wx" });
    assert(argv[0] === git || argv[0] === process.execPath);
    before = await state(root, project, id);
    stage = "launch";
    if (tool === "plain-git") {
      workInputs = workspaceInputs(id, before);
      const result = await command(argv[0]!, argv.slice(1), project, env); settled(result);
      stage = "observation";
      actionExitCode = result.code;
      action = result.code === 0 ? "completed" : "failed";
      actionStart = "started";
      policyBlock = "not-observed";
      if (id === "S11") for (let n = 0; n < 100 && (await state(root, project, id)).worker === null; n++)
        await new Promise(done => setTimeout(done, 25));
      afterAction = await state(root, project, id);
      effect = targetEffect(id, before, afterAction, action === "completed");
      if (id === "S6") actionOutput = result.stdout.includes("Removing .env")
        ? "mentions-removal" : "no-removal-mention";
      report = effect === "expected-effect" && id !== "S13" && id !== "S6" ? "omits-effect" : "unknown";
      if (id !== "S8") {
        stage = "recovery";
        const restored = await command(git, recipe, project, env); settled(restored);
        recovery = restored.code === 0 ? "git-recipe" : "failed";
      }
      afterRecovery = await state(root, project, id);
    } else if (tool === "twin") {
      session = await createTwin({ sourceDirectory: project, scratchParent: join(root.path, "scratch") });
      assert(within(join(root.path, "scratch"), session.workspacePath));
      workInputs = workspaceInputs(id, await state(root, session.workspacePath, id));
      const result = await session.run({ executable: argv[0]!, argv: argv.slice(1), env, timeoutMs: 15_000 });
      assert(result.directChildSettled && result.outcome === "exited", "Twin child unsettled; root retained");
      stage = "observation";
      actionExitCode = result.exitCode;
      action = result.exitCode === 0 ? "completed" : "failed";
      actionStart = result.started ? "started" : "unknown";
      policyBlock = "not-observed";
      if (id === "S11") for (let n = 0; n < 100 && (await state(root, project, id)).worker === null; n++)
        await new Promise(done => setTimeout(done, 25));
      afterAction = await state(root, session.workspacePath, id);
      effect = targetEffect(id, before, afterAction, action === "completed");
      const receipt = session.inspect().receipt;
      assert(receipt && receipt.files.coverage === "complete");
      const paths = receipt.files.changes.map(item => item.path.encoding === "utf8" ? item.path.value : "");
      const watchedS9 = id === "S9" && receipt.watch.some(item => String(item.id) === ".s9-note" && item.comparison === "changed");
      report = effect === "expected-effect" && id !== "S13"
        ? paths.some(path => reportTargets(id).includes(path)) || watchedS9 ? "mentions-effect" : "omits-effect" : "unknown";
      stage = "recovery";
      const discarded = await session.discard();
      recovery = discarded.status === "removed" ? "discard" : "failed";
      assert.equal(discarded.status, "removed");
      afterRecovery = await state(root, project, id);
    } else {
      const agenttx = join(dirname(process.execPath), "agenttx");
      const result = await command(agenttx, ["run", "--", ...argv], project, env, 30_000); settled(result);
      stage = "observation";
      const matches = [...`${result.stdout}\n${result.stderr}`.matchAll(/atx_[0-9]{8}_[0-9]{6}_[a-z0-9]+/g)]
        .map(value => value[0]);
      const idsFound = [...new Set(matches)];
      if (idsFound.length === 0) {
        actionExitCode = result.code;
        action = result.code === 0 ? "unknown" : "refused";
        if (id === "S8" && action === "refused") compatibility.push("non-git-refused");
        afterAction = await state(root, project, id);
        afterRecovery = afterAction;
      } else {
        assert.equal(idsFound.length, 1);
        const transaction = idsFound[0]!;
        const inspected = await command(agenttx, ["inspect", transaction, "--json"], project, env);
        settled(inspected); assert.equal(inspected.code, 0);
        const parsed: unknown = JSON.parse(inspected.stdout);
        assert(parsed && typeof parsed === "object" && "metadata" in parsed && "diff" in parsed
          && "sideEffects" in parsed && Array.isArray(parsed.sideEffects));
        const metadata = parsed.metadata;
        assert(metadata && typeof metadata === "object" && "worktree" in metadata && "exitCode" in metadata
          && "baselineCommit" in metadata);
        assert(typeof metadata.worktree === "string" && within(join(root.path, "store"), metadata.worktree));
        assert(typeof metadata.baselineCommit === "string" && /^[0-9a-f]{40,64}$/.test(metadata.baselineCommit));
        if (id === "S6") {
          const tree = await command(git, ["ls-tree", "-r", "--name-only", metadata.baselineCommit], metadata.worktree, env);
          settled(tree); assert.equal(tree.code, 0);
          if (tree.stdout.split("\n").includes("scratch.txt")) compatibility.push("scratch-baseline-committed");
        }
        if (id === "S4") {
          const baseline = await command(git, ["show", `${metadata.baselineCommit}:app.js`], metadata.worktree, env);
          settled(baseline); assert.equal(baseline.code, 0);
          if (baseline.stdout === 'console.log("unsaved edit");\n') compatibility.push("unsaved-edit-baseline-committed");
        }
        action = metadata.exitCode === 0 ? "completed" : typeof metadata.exitCode === "number" ? "failed" : "unknown";
        actionExitCode = typeof metadata.exitCode === "number" ? metadata.exitCode : null;
        if (action === "completed") actionStart = "started";
        policyBlock = parsed.sideEffects.some((entry: unknown) => {
          if (typeof entry !== "object" || entry === null) return false;
          if ("blocked" in entry && entry.blocked === true) return true;
          if ("finding" in entry && typeof entry.finding === "object" && entry.finding !== null
            && "blocked" in entry.finding && entry.finding.blocked === true) return true;
          return false;
        }) ? "observed" : "not-observed";
        workInputs = workspaceInputs(id, await state(root, metadata.worktree, id));
        if (id === "S4") workInputs = "unknown";
        if (id === "S6") workInputs = "unknown"; // A post-clean inventory cannot prove pre-clean ignored inputs.
        if (id === "S7") workInputs = "unknown";
        if ((id === "S3" || id === "S13") && workInputs === "missing") compatibility.push("ignored-input-missing");
        if (id === "S11") for (let n = 0; n < 100 && (await state(root, project, id)).worker === null; n++)
          await new Promise(done => setTimeout(done, 25));
        afterAction = await state(root, metadata.worktree, id);
        effect = targetEffect(id, before, afterAction, action === "completed");
        if (effect === "expected-effect" && id !== "S6" && id !== "S13" && id !== "S4" && id !== "S7") workInputs = "present";
        const diff = parsed.diff;
        assert(diff && typeof diff === "object" && "files" in diff && Array.isArray(diff.files));
        const reportedPaths = diff.files.filter((file: unknown): file is { path: string } =>
          typeof file === "object" && file !== null && "path" in file && typeof file.path === "string")
          .map(file => file.path);
        report = effect === "expected-effect" && id !== "S13"
          ? reportedPaths.some(path => reportTargets(id).includes(path)) ? "mentions-effect"
            : parsed.sideEffects.length === 0 ? "omits-effect" : "unknown" : "unknown";
        stage = "recovery";
        const rolled = await command(agenttx, ["rollback", transaction], project, env);
        settled(rolled); recovery = rolled.code === 0 ? "rollback" : "failed";
        afterRecovery = await state(root, project, id);
      }
    }
    if (id === "S11") { stage = "settlement"; await stopWorker(root, worker, env.TWIN_S11_TOKEN!); }
    const final = Object.keys(before).every(key => before[key] === afterRecovery[key]) ? "original" : "changed";
    const present = Object.values(before).filter(value => value !== null).length;
    const targetBefore = present === 0 ? "absent" : present === Object.keys(before).length ? "present" : "mixed";
    const observations = { targetBefore, actionStart, preventionBeforeAction, policyBlock,
      workspaceInputs: workInputs, targetAfterAction: effect, targetAfterRecovery: final,
      actionOutput, report } as const;
    return { scenarioId: id, tool, toolVersion: versions[tool], action, actionExitCode, recovery, compatibility, observations,
      score: evaluateComparisonScore(id, tool, action, observations) };
  } catch (error: unknown) {
    if (error instanceof Error && /unsettled|uncertain|did not stop/.test(error.message)) { safeCleanup = false; stage = "settlement"; }
    throw new ComparisonAttemptFailure(stage, safeCleanup ? "removed" : "retained");
  } finally {
    if (safeCleanup) {
      try {
        if (id === "S11") await stopWorker(root, join(root.path, "support", "s11-worker.mjs"), env.TWIN_S11_TOKEN ?? "");
        if (session && session.inspect().state !== "discarded") {
          const discarded = await session.discard(); assert.equal(discarded.status, "removed");
        }
        await cleanup(root, accounting);
      } catch {
        throw new ComparisonAttemptFailure("cleanup", "unknown");
      }
    }
  }
}
export async function produceComparison(onRow?: (row: ComparisonRow) => void, onReady?: () => void,
  accounting: ComparisonRootAccounting = { allocated: 0, removed: 0 }): Promise<ComparisonResult> {
  const gitStat = await fs.lstat(git);
  assert(gitStat.isFile() && !gitStat.isSymbolicLink() && gitStat.uid === 0 && (gitStat.mode & 0o111) !== 0
    && (gitStat.mode & 0o022) === 0, "Git executable is not an admitted system file");
  const root = await allocate(accounting), env = config(root);
  let versions: Record<ToolId, string>;
  let probeState: "not-started" | "settled" | "uncertain" = "not-started";
  try {
    for (const name of ["home", "store", "config", "cache", "tmp", "prefix"])
      await fs.mkdir(join(root.path, name), { mode: 0o700 });
    const agenttx = join(dirname(process.execPath), "agenttx");
    let agenttxTarget: string;
    try { agenttxTarget = await fs.realpath(agenttx); }
    catch { throw new ComparisonPrerequisiteFailure("agenttx-unavailable"); }
    if (!agenttxTarget.endsWith("/agenttx/dist/src/cli.js"))
      throw new ComparisonPrerequisiteFailure("agenttx-version-mismatch");
    probeState = "uncertain";
    const [gitVersion, agentVersion, coreHead] = await Promise.all([
      command(git, ["--version"], root.path, env), command(agenttx, ["--version"], root.path, env),
      command(git, ["rev-parse", "--short=12", "HEAD"], repo, env),
    ]);
    probeState = prerequisiteProbeState([gitVersion, agentVersion, coreHead]);
    if (probeState === "uncertain")
      throw new ComparisonPrerequisiteFailure("probe-settlement-uncertain");
    settled(gitVersion); settled(coreHead);
    assert.equal(gitVersion.code, 0);
    assert.equal(coreHead.code, 0);
    assert(/^[0-9a-f]{12}$/.test(coreHead.stdout.trim()), "Core HEAD identity is unavailable");
    if (agentVersion.code !== 0)
      throw new ComparisonPrerequisiteFailure("agenttx-unavailable");
    if (agentVersion.stdout.trim() !== "0.3.0")
      throw new ComparisonPrerequisiteFailure("agenttx-version-mismatch");
    versions = { twin: `${coreHead.stdout.trim()}-core`, agenttx: "0.3.0", "plain-git": gitVersion.stdout.trim() };
  } finally { await finishPrerequisiteRoot(probeState, () => cleanup(root, accounting)); }
  onReady?.();
  const rows: ComparisonRow[] = [];
  for (const id of ids) for (const tool of tools) {
    const row = await attempt(id, tool, versions, accounting);
    rows.push(row);
    onRow?.(row);
  }
  return ComparisonResultSchema.parse({ schemaVersion: 1, comparisonVersion: 1,
    gitRecoveryRecipe: "git restore --source=HEAD --worktree -- .; no git clean or harness restoration",
    rootAccounting: { allocated: accounting.allocated, removed: accounting.removed,
      retained: accounting.allocated - accounting.removed }, rows });
}
