import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdtemp, readFile, readdir, readlink, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, parse } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const markerName = ".twin-test-root";
const owned = new WeakMap<TestRoot, { path: string; parent: string; token: string }>();

export interface TestRoot { readonly path: string }
export interface ProcessResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly error: string | null;
}
export type Fingerprint = ReadonlyMap<string, string>;

export const repositoryRoot = fileURLToPath(new URL("../../../../", import.meta.url));
export const scenarioEntry = fileURLToPath(new URL("../../dist/index.js", import.meta.url));
export const spawnGuard = fileURLToPath(new URL("../../dist/test-harness/packages/scenarios/test/support/spawn-guard.cjs", import.meta.url));
const require = createRequire(import.meta.url);
const { resolveTrustedSystemGit } = require("../../dist/test-harness/packages/scenarios/test/support/git-trust.cjs") as
  typeof import("./git-trust.cjs");

export async function scenarioRoots(): Promise<readonly string[]> {
  const parent = await realpath(tmpdir());
  return (await readdir(parent)).filter((name) => name.startsWith("twin-scenario-"))
    .map((name) => join(parent, name)).sort();
}

export async function testRoots(): Promise<readonly string[]> {
  const parent = await realpath(tmpdir());
  return (await readdir(parent)).filter((name) => name.startsWith("twin-test-"))
    .map((name) => join(parent, name)).sort();
}

export async function assertNoTestRootLeak(before: readonly string[]): Promise<void> {
  const previous = new Set(before);
  const current = await testRoots();
  const now = new Set(current);
  const added = current.filter((path) => !previous.has(path));
  const removed = before.filter((path) => !now.has(path));
  if (added.length || removed.length) {
    throw new Error(`Outer test root set changed; added=${JSON.stringify(added)}, removed=${JSON.stringify(removed)}; no automatic cleanup`);
  }
}

export async function assertNoScenarioRootLeak(before: readonly string[]): Promise<void> {
  const previous = new Set(before);
  const current = await scenarioRoots();
  const now = new Set(current);
  const added = current.filter((path) => !previous.has(path));
  const removed = before.filter((path) => !now.has(path));
  if (added.length || removed.length) {
    throw new Error(`Scenario root set changed; added=${JSON.stringify(added)}, removed=${JSON.stringify(removed)}; no automatic cleanup`);
  }
}

export async function withPreservedCleanup<T>(
  body: () => Promise<T>,
  cleanups: readonly (() => Promise<void>)[],
  knownRoots: readonly string[],
): Promise<T> {
  const errors: unknown[] = [];
  let result: T | undefined;
  try { result = await body(); } catch (error: unknown) { errors.push(error); }
  for (const cleanup of cleanups) {
    try { await cleanup(); } catch (error: unknown) { errors.push(error); }
  }
  if (errors.length) {
    throw new AggregateError(errors, `Test operation/cleanup failed; known roots: ${knownRoots.join(", ")}`);
  }
  return result as T;
}

export async function createTestRoot(): Promise<TestRoot> {
  const parent = await realpath(tmpdir());
  const path = await mkdtemp(join(parent, "twin-test-"));
  const token = randomBytes(32).toString("hex");
  const root = Object.freeze({ path });
  owned.set(root, { path, parent, token });
  try {
    await writeFile(join(path, markerName), token, { flag: "wx", mode: 0o600 });
    return root;
  } catch (error: unknown) {
    throw new Error(`Test root retained at ${path}: ${String(error)}`);
  }
}

async function verifyTestRoot(root: TestRoot): Promise<{ path: string; parent: string; token: string }> {
  const entry = owned.get(root);
  if (!entry || root.path !== entry.path || dirname(entry.path) !== entry.parent
      || entry.path === entry.parent || entry.path === parse(entry.path).root) {
    throw new Error(`Test root cleanup refused: ${root.path}`);
  }
  try {
    if (await realpath(tmpdir()) !== entry.parent) throw new Error("Temporary parent changed");
    const rootStat = await lstat(entry.path);
    const markerStat = await lstat(join(entry.path, markerName));
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()
        || !markerStat.isFile() || markerStat.isSymbolicLink()
        || await readFile(join(entry.path, markerName), "utf8") !== entry.token) {
      throw new Error("Test root or marker identity mismatch");
    }
  } catch (error: unknown) {
    throw new Error(`Test root validation refused; retained path ${entry.path}: ${String(error)}`);
  }
  return entry;
}

export async function removeTestRoot(root: TestRoot): Promise<void> {
  const entry = await verifyTestRoot(root);
  try {
    await rm(entry.path, { recursive: true, force: false });
    owned.delete(root);
  } catch (error: unknown) {
    throw new Error(`Test root deletion failed; exact target ${entry.path}; partial deletion possible: ${String(error)}`);
  }
}

export async function runNode(cwd: TestRoot, argv: readonly string[]): Promise<ProcessResult> {
  await verifyTestRoot(cwd);
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? "/usr/bin:/bin",
    LANG: "C", LC_ALL: "C", TZ: "UTC" };
  const entryIndex = argv.indexOf(scenarioEntry);
  const id = entryIndex >= 0 ? argv[entryIndex + 1] : undefined;
  if (id === "S12" || id === "S6") {
    if (argv[0] !== "--require" || argv[1] !== spawnGuard || argv[2] !== scenarioEntry) {
      throw new Error("Valid scenario CLI requires the test spawn preload");
    }
    const checked = resolveTrustedSystemGit();
    env.PATH = checked.directory;
    env.TWIN_TEST_GIT_PATH = checked.git;
  }
  return await new Promise<ProcessResult>((resolve) => {
    let stdout = "";
    let stderr = "";
    let error: string | null = null;
    const child = spawn(process.execPath, [...argv], { cwd: cwd.path, shell: false,
      env, stdio: ["ignore", "pipe", "pipe"] });
    const watchdog = setTimeout(() => {
      error = "Test child exceeded 60 seconds";
      child.kill("SIGTERM");
    }, 60_000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.stdout.on("error", (failure: Error) => { error = failure.message; });
    child.stderr.on("error", (failure: Error) => { error = failure.message; });
    child.on("error", (failure: Error) => { error = failure.message; });
    child.once("close", (code, signal) => {
      clearTimeout(watchdog);
      resolve({ code, signal, stdout, stderr, error });
    });
  });
}

export async function repositoryFingerprint(): Promise<Fingerprint> {
  const result = new Map<string, string>();
  const visit = async (absolute: string, name: string): Promise<void> => {
    const stat = await lstat(absolute);
    if (stat.isSymbolicLink()) {
      result.set(name, `link:${await readlink(absolute)}`);
    } else if (stat.isFile()) {
      result.set(name, `file:${createHash("sha256").update(await readFile(absolute)).digest("hex")}`);
    } else if (stat.isDirectory()) {
      const entries = (await readdir(absolute)).sort();
      result.set(name, `directory:${JSON.stringify(entries)}`);
      for (const entry of entries) await visit(join(absolute, entry), name ? `${name}/${entry}` : entry);
    } else {
      const kind = stat.isFIFO() ? "fifo" : stat.isSocket() ? "socket"
        : stat.isBlockDevice() ? "block-device" : stat.isCharacterDevice() ? "character-device" : null;
      if (kind === null) throw new Error(`Unsupported filesystem object type: ${absolute}`);
      result.set(name, kind);
    }
  };
  await visit(repositoryRoot, "");
  return result;
}

export function changedFingerprintPaths(before: Fingerprint, after: Fingerprint): readonly string[] {
  const names = new Set([...before.keys(), ...after.keys()]);
  return [...names].filter((name) => before.get(name) !== after.get(name)).sort();
}
