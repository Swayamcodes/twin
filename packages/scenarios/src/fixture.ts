import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rmdir, unlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, parse, relative, sep } from "node:path";
import { performance } from "node:perf_hooks";
import { fixtureContents, getCommand } from "./scenarios.js";
import type { CommandId } from "./scenarios.js";
import type { CleanupEvidence, CommandEvidence, PresenceEvidence, Snapshot } from "./types.js";

const markerName = ".twin-scenario-root";
const ownedRootBrand: unique symbol = Symbol("ownedScenarioRoot");
export interface OwnedScenarioRoot {
  readonly [ownedRootBrand]: true;
  readonly scenarioRoot: string;
}
interface Identity { readonly dev: number; readonly ino: number }
interface Registration {
  readonly scenarioRoot: string;
  readonly workspace: string;
  readonly tempParent: string;
  readonly forbidden: readonly string[];
  readonly marker: string;
  identity: Identity | null;
  workspaceCreated: boolean;
  workspaceIdentity: Identity | null;
  gitIdentity: Identity | null;
}

// Integrity guards against accidental path misuse, not a security boundary.
// Checks describe state at validation time; concurrent root mutation is unsupported.
const registrations = new WeakMap<OwnedScenarioRoot, Registration>();

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function registration(root: OwnedScenarioRoot): Registration {
  const entry = registrations.get(root);
  if (!entry) throw new Error("Unregistered scenario root");
  return entry;
}

function contains(parent: string, child: string): boolean {
  const suffix = relative(parent, child);
  return suffix === "" || (!isAbsolute(suffix) && suffix !== ".." && !suffix.startsWith(`..${sep}`));
}

function checkPaths(entry: Pick<Registration, "scenarioRoot" | "workspace" | "tempParent" | "forbidden">): void {
  const { scenarioRoot, workspace, tempParent, forbidden } = entry;
  if (dirname(scenarioRoot) !== tempParent || scenarioRoot === tempParent
      || workspace !== join(scenarioRoot, "workspace")) {
    throw new Error("Scenario root/workspace containment mismatch");
  }
  for (const path of forbidden) {
    if (scenarioRoot === path || workspace === path || contains(scenarioRoot, path)) {
      throw new Error(`Refusing protected path: ${path}`);
    }
  }
}

async function verifyDirectory(path: string, expected: Identity): Promise<void> {
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== expected.dev
      || stat.ino !== expected.ino || await realpath(path) !== path) {
    throw new Error(`Directory identity mismatch: ${path}`);
  }
}

export async function createScenarioRoot(): Promise<OwnedScenarioRoot> {
  if (process.platform === "win32") throw new Error("Native Windows is out of scope");
  const invocationCwd = await realpath(process.cwd());
  const home = await realpath(homedir());
  const tempParent = await realpath(tmpdir());
  const forbidden = [invocationCwd, home, parse(tempParent).root];
  const marker = JSON.stringify({ version: 1, token: randomBytes(32).toString("hex") }) + "\n";
  const scenarioRoot = await mkdtemp(join(tempParent, "twin-scenario-"));
  // Register immediately. All subsequent filesystem work belongs to the runner's
  // lifecycle error boundary, including marker and workspace initialization.
  const root: OwnedScenarioRoot = Object.freeze({ [ownedRootBrand]: true as const, scenarioRoot });
  registrations.set(root, {
    scenarioRoot, workspace: join(scenarioRoot, "workspace"), tempParent, forbidden, marker,
    identity: null, workspaceCreated: false, workspaceIdentity: null, gitIdentity: null,
  });
  return root;
}

export function createdWorkspace(root: OwnedScenarioRoot): string | null {
  const entry = registration(root);
  return entry.workspaceCreated ? entry.workspace : null;
}

export async function initializeScenarioRoot(root: OwnedScenarioRoot): Promise<void> {
  const entry = registration(root);
  checkPaths(entry);
  entry.identity = await lstat(entry.scenarioRoot);
  await verifyDirectory(entry.scenarioRoot, entry.identity);
  await writeFile(join(entry.scenarioRoot, markerName), entry.marker, { flag: "wx", mode: 0o600 });
  await mkdir(entry.workspace, { mode: 0o700 });
  entry.workspaceCreated = true;
  entry.workspaceIdentity = await lstat(entry.workspace);
  await verifyWorkspace(root);
}

export async function verifyWorkspace(root: OwnedScenarioRoot): Promise<{ scenarioRoot: string; workspace: string }> {
  const entry = registration(root);
  checkPaths(entry);
  if (entry.identity === null || entry.workspaceIdentity === null) {
    throw new Error("Scenario root/workspace initialization is incomplete");
  }
  if (await realpath(entry.tempParent) !== entry.tempParent) throw new Error("Temporary parent changed");
  await verifyDirectory(entry.scenarioRoot, entry.identity);
  const markerPath = join(entry.scenarioRoot, markerName);
  const markerStat = await lstat(markerPath);
  if (!markerStat.isFile() || markerStat.isSymbolicLink()
      || await readFile(markerPath, "utf8") !== entry.marker) {
    throw new Error(`Scenario marker mismatch: ${markerPath}`);
  }
  await verifyDirectory(entry.workspace, entry.workspaceIdentity);
  if (entry.gitIdentity) await verifyDirectory(join(entry.workspace, ".git"), entry.gitIdentity);
  return { scenarioRoot: entry.scenarioRoot, workspace: entry.workspace };
}

function childEnvironment(): NodeJS.ProcessEnv {
  // Do not inherit GIT_*, NODE_OPTIONS, identity, template, or config overrides.
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    LANG: "C", LC_ALL: "C", TZ: "UTC",
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_GLOBAL: "/dev/null", GIT_ATTR_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: "4",
    GIT_CONFIG_KEY_0: "core.hooksPath", GIT_CONFIG_VALUE_0: "/dev/null",
    GIT_CONFIG_KEY_1: "core.excludesFile", GIT_CONFIG_VALUE_1: "/dev/null",
    GIT_CONFIG_KEY_2: "core.attributesFile", GIT_CONFIG_VALUE_2: "/dev/null",
    GIT_CONFIG_KEY_3: "commit.gpgSign", GIT_CONFIG_VALUE_3: "false",
  };
}

export async function executeCommand(root: OwnedScenarioRoot, id: CommandId): Promise<CommandEvidence> {
  const command = getCommand(id);
  const { workspace } = await verifyWorkspace(root);
  if (id !== "init" && registration(root).gitIdentity === null) {
    throw new Error("Command requires an initialized disposable Git repository");
  }
  const startedAt = new Date().toISOString();
  const start = performance.now();
  return await new Promise<CommandEvidence>((resolve) => {
    let stdout = "";
    let stderr = "";
    let spawnError: string | null = null;
    const streamErrors: { stream: "stdout" | "stderr"; error: string }[] = [];
    let settled = false;
    const finish = (exitCode: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return;
      settled = true;
      resolve({ command, cwd: workspace, stdout, stderr, exitCode, signal, spawnError, streamErrors,
        startedAt, endedAt: new Date().toISOString(), durationMs: performance.now() - start });
    };
    try {
      const child = spawn(command.executable, [...command.args], {
        cwd: workspace, shell: false, env: childEnvironment(), stdio: ["ignore", "pipe", "pipe"],
      });
      child.on("error", (error: Error) => { spawnError = error.message; });
      child.once("close", finish);
      for (const name of ["stdout", "stderr"] as const) {
        const stream = child[name];
        stream.on("error", (error: Error) => {
          streamErrors.push({ stream: name, error: error.message });
        });
        stream.setEncoding("utf8");
        let collectionFailed = false;
        stream.on("data", (chunk: string) => {
          if (collectionFailed) return;
          try {
            if (name === "stdout") stdout += chunk;
            else stderr += chunk;
          } catch (error: unknown) {
            collectionFailed = true;
            streamErrors.push({ stream: name, error: errorMessage(error) });
          }
        });
      }
    } catch (error: unknown) {
      spawnError = errorMessage(error);
      finish(null, null);
    }
  });
}

export async function initializeFixture(root: OwnedScenarioRoot, evidence: CommandEvidence[]): Promise<void> {
  const { workspace } = await verifyWorkspace(root);
  await mkdir(join(workspace, "node_modules"));
  for (const [path, contents] of Object.entries(fixtureContents)) {
    await writeFile(join(workspace, path), contents, { flag: "wx" });
  }
  for (const id of ["init", "add", "commit", "top-level", "tracked", "untracked", "ignored"] as const) {
    const result = await executeCommand(root, id);
    evidence.push(result);
    if (result.exitCode !== 0 || result.spawnError !== null || result.signal !== null
        || result.streamErrors.length > 0) {
      const streamDetails = result.streamErrors.map((failure) => `${failure.stream}: ${failure.error}`).join("; ");
      throw new Error(`Git setup command ${id} failed: ${result.spawnError ?? (streamDetails || result.stderr || result.signal || String(result.exitCode))}`);
    }
    if (id === "init") {
      const gitPath = join(workspace, ".git");
      const identity = await lstat(gitPath);
      await verifyDirectory(gitPath, identity);
      registration(root).gitIdentity = identity;
    } else if (id === "top-level") {
      if (await realpath(result.stdout.replace(/\n$/, "")) !== workspace) {
        throw new Error("Git top-level is not the disposable workspace");
      }
    } else if (id === "tracked" || id === "untracked" || id === "ignored") {
      const expected = id === "tracked" ? [".gitignore", "app.js", "notes.txt"]
        : id === "untracked" ? ["scratch.txt"] : [".env", "node_modules/lib.txt"];
      const actual = result.stdout.split("\0").filter((path) => path !== "").sort();
      if (JSON.stringify(actual) !== JSON.stringify(expected.sort())) {
        throw new Error(`Unexpected ${id} fixture paths`);
      }
    }
  }
}

async function inspectPresence(path: string): Promise<PresenceEvidence> {
  try {
    await lstat(path);
    return { exists: true, error: null };
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return { exists: false, error: null };
    }
    return { exists: null, error: errorMessage(error) };
  }
}

export async function cleanupScenarioRoot(root: OwnedScenarioRoot, after: Snapshot | null): Promise<CleanupEvidence> {
  const { scenarioRoot } = root;
  const files: string[] = [];
  const directories: string[] = [];
  try {
    const entry = registration(root);
    if (scenarioRoot !== entry.scenarioRoot) throw new Error("Registered root path mismatch");
    if (after === null || !after.complete || after.paths.some((path) => path.state === "error")) {
      throw new Error("After-state observation is incomplete; no deletion attempted");
    }
    if (after.workspace !== entry.workspace) throw new Error("After-state workspace mismatch");
    await verifyWorkspace(root);
    // Preflight the complete owned tree before deleting anything. Reject links.
    const inspect = async (directory: string): Promise<void> => {
      for (const name of await readdir(directory)) {
        const path = join(directory, name);
        if (path === join(scenarioRoot, markerName)) continue;
        const stat = await lstat(path);
        if (stat.isSymbolicLink()) throw new Error(`Cleanup refuses symlink: ${path}`);
        if (stat.isDirectory()) { await inspect(path); directories.push(path); }
        else if (stat.isFile()) files.push(path);
        else throw new Error(`Cleanup refuses unexpected file type: ${path}`);
      }
    };
    await inspect(scenarioRoot);
    await verifyWorkspace(root);
  } catch (error: unknown) {
    return { status: "refused", scenarioRoot, reason: errorMessage(error) };
  }
  try {
    for (const path of files) await unlink(path);
    for (const path of directories) await rmdir(path);
    await unlink(join(scenarioRoot, markerName));
    await rmdir(scenarioRoot);
    registrations.delete(root);
    return { status: "removed", scenarioRoot };
  } catch (error: unknown) {
    // Deletion is not atomic. Inspect only; never restore the marker or contents.
    const reason = errorMessage(error);
    const rootAfter = await inspectPresence(scenarioRoot);
    const markerAfter = await inspectPresence(join(scenarioRoot, markerName));
    return { status: "failed", scenarioRoot, reason, partialDeletionPossible: true,
      rootAfter, markerAfter };
  }
}
