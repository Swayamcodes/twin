// Test-only defense in depth for the current child_process.spawn route.
// This is not an OS sandbox or a guard for arbitrary future launch APIs.
import { syncBuiltinESMExports } from "node:module";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import type { SpawnOptions } from "node:child_process";
import type { SpawnPolicyContext, TestScenarioId } from "./spawn-policy.cjs";

const childProcess = require("node:child_process") as typeof import("node:child_process");
const { assertAllowedSpawn } = require("./spawn-policy.cjs") as typeof import("./spawn-policy.cjs");
const { resolveTrustedSystemGit, validateTrustedGitEnvironment } = require("./git-trust.cjs") as
  typeof import("./git-trust.cjs");
const originalSpawn = childProcess.spawn;

function inside(parent: string, child: string): boolean {
  const suffix = relative(parent, child);
  return suffix === "" || (!isAbsolute(suffix) && suffix !== ".." && !suffix.startsWith(`..${sep}`));
}

const entry = process.argv[1];
const scenarioId = process.argv[2];
if (!entry || (scenarioId !== "S12" && scenarioId !== "S6")) {
  throw new Error("Test spawn guard requires a direct S12 or S6 CLI entry");
}
const canonicalEntry = realpathSync(entry);
const repositoryRoot = realpathSync(resolve(dirname(canonicalEntry), "../../.."));
if (canonicalEntry !== join(repositoryRoot, "packages/scenarios/dist/index.js")) {
  throw new Error("Test spawn guard refused unexpected CLI entry");
}
const outerRoot = realpathSync(process.cwd());
const tempParent = realpathSync(tmpdir());
const home = realpathSync(homedir());
const approvedValue = process.env.TWIN_TEST_GIT_PATH;
const pathValue = process.env.PATH;
const trusted = resolveTrustedSystemGit();
const approvedGit = trusted.git;
const gitDirectory = trusted.directory;
const resolvedGit = pathValue === gitDirectory ? realpathSync(join(pathValue, "git")) : undefined;
validateTrustedGitEnvironment(approvedGit, approvedValue, pathValue, resolvedGit);
for (const forbidden of [repositoryRoot, outerRoot, home, tempParent]) {
  if (inside(forbidden, approvedGit)) {
    throw new Error(`Test spawn guard refused Git inside protected directory: ${forbidden}`);
  }
}

const guardedSpawn = ((command: string, args: readonly string[], options: SpawnOptions) => {
  const cwd = options?.cwd;
  if (typeof cwd !== "string") throw new Error("Test spawn guard requires explicit workspace cwd");
  const childPath = options.env?.PATH;
  if (childPath !== gitDirectory) {
    throw new Error("Test spawn guard refused child PATH different from approved Git directory");
  }
  const root = dirname(cwd);
  if (cwd !== join(root, "workspace") || dirname(root) !== tempParent
      || !basename(root).startsWith("twin-scenario-") || root === parse(root).root) {
    throw new Error(`Test spawn guard refused cwd ${cwd}`);
  }
  const rootStat = lstatSync(root);
  const workspaceStat = lstatSync(cwd);
  const markerPath = join(root, ".twin-scenario-root");
  const markerStat = lstatSync(markerPath);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || realpathSync(root) !== root
      || !workspaceStat.isDirectory() || workspaceStat.isSymbolicLink()
      || !markerStat.isFile() || markerStat.isSymbolicLink()
      || realpathSync(cwd) !== cwd
      || !/^\{"version":1,"token":"[0-9a-f]{64}"\}\n$/.test(readFileSync(markerPath, "utf8"))) {
    throw new Error(`Test spawn guard refused filesystem state at ${cwd}`);
  }
  const context: SpawnPolicyContext = {
    scenarioId: scenarioId as TestScenarioId, workspace: cwd,
    nodeExecutable: process.execPath,
    actionPath: join(dirname(canonicalEntry), "actions", "create-file.js"),
    approvedGit, resolvedGit: realpathSync(join(childPath, "git")),
  };
  assertAllowedSpawn(command, args, options, context);
  return originalSpawn(command, [...args], options);
}) as typeof childProcess.spawn;

childProcess.spawn = guardedSpawn;
syncBuiltinESMExports();
