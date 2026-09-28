import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { comparisonS12Inputs } from "./support/twin-s12.js";
import { assertS6Stdout, comparisonS6Inputs, gitEnvironment } from "./support/twin-s6.js";
import { appendedLine, comparisonS9Inputs, failureLine, initialNote, successLine } from "./support/twin-s9.js";

type Scenario = "S12" | "S6" | "S9";
type Kind = "file" | "directory";
interface Entry { path: string; kind: Kind; mode: number; sha256?: string; bytes?: string }
interface Result { stdout: Buffer; stderr: Buffer; exitCode: number | null; signal: NodeJS.Signals | null;
  timedOut: boolean; spawnError: string | null }
interface Root { path: string; dev: number; ino: number; token: string; removed: boolean }
interface Receipt { schemaVersion: number; files: { coverage: string; issues: unknown[];
  changes: { path: { encoding: string; value: string }; change: string; category: string }[] };
  watch: { id: string; comparison: string }[] }
interface Comparison { scenario: Scenario; originalBefore: Entry[]; originalAfter: Entry[];
  baselineBefore: Entry[]; baselineAfter: Entry[]; twin: Result; direct: Result;
  receipt: Receipt; launches: { setup: number; cli: number; baseline: number };
  twinHomeBefore?: Entry[]; twinHomeAfter?: Entry[];
  baselineHomeBefore?: Entry[]; baselineHomeAfter?: Entry[] }

const marker = ".twin-cli-comparison-owner";
const prefix = "twin-cli-compare-";
const cli = fileURLToPath(new URL("../../cli/dist/index.js", import.meta.url));
const forbidden = [resolve(homedir()), resolve(fileURLToPath(new URL("../../..", import.meta.url)))];
const watchIds = [".gitconfig", ".npmrc", ".bashrc", ".zshrc", ".codex/config.toml",
  ".claude/settings.json", ".gemini/settings.json"];
const gitInputs = comparisonS6Inputs();

function within(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`));
}
function demandAction(scenario: Scenario, executable: string, argv: readonly string[], cwd: string,
  expectedCwd: string, expectedArgv: readonly string[], asset?: Buffer): void {
  assert.equal(cwd, expectedCwd);
  assert(isAbsolute(executable));
  assert.deepEqual(argv, expectedArgv);
  if (scenario === "S6") { assert.equal(executable, gitInputs.git); assert.deepEqual(argv, ["clean", "-fdx"]); }
  else {
    assert.equal(executable, process.execPath);
    assert.equal(argv.length, 1);
    assert(isAbsolute(argv[0]!));
    assert(asset && asset.length > 0);
  }
}
async function inventory(root: string): Promise<Entry[]> {
  const entries: Entry[] = [];
  async function visit(path: string, name: string): Promise<void> {
    const stat = await fs.lstat(path);
    assert.equal(stat.isSymbolicLink(), false, "Inventory refuses links");
    if (stat.isDirectory()) {
      entries.push({ path: name, kind: "directory", mode: stat.mode & 0o7777 });
      for (const child of (await fs.readdir(path)).sort()) await visit(join(path, child), name ? `${name}/${child}` : child);
    } else {
      assert(stat.isFile(), "Inventory refuses special entries");
      const bytes = await fs.readFile(path);
      entries.push({ path: name, kind: "file", mode: stat.mode & 0o7777,
        sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.toString("base64") });
    }
  }
  await visit(root, "");
  return entries;
}
function entry(entries: readonly Entry[], path: string): Entry | undefined { return entries.find(item => item.path === path); }
function assertBaselineEffect(scenario: Scenario, before: readonly Entry[], after: readonly Entry[]): void {
  if (scenario === "S12") {
    assert.equal(entry(before, "control-created.txt"), undefined);
    assert.equal(entry(after, "control-created.txt")?.bytes, Buffer.from("S12 control file.\n").toString("base64"));
    assert.deepEqual(after.filter(value => value.path !== "control-created.txt"), before);
  } else if (scenario === "S6") {
    const removed = [".env", "scratch.txt", "node_modules", "node_modules/lib.txt"];
    for (const path of removed) { assert(entry(before, path)); assert.equal(entry(after, path), undefined); }
    assert.deepEqual(after, before.filter(value => !removed.includes(value.path)));
    assert.deepEqual(after.filter(value => value.path.startsWith(".git/")),
      before.filter(value => value.path.startsWith(".git/")));
  } else assert.deepEqual(after, before);
}
function assertS9Omission(receipt: Receipt): void {
  assert.deepEqual(receipt.files.changes, []);
  assert.deepEqual(receipt.watch.map(value => value.id), watchIds);
  assert.equal(receipt.watch.some(value => value.id === ".s9-note"), false);
  assert(receipt.watch.every(value => value.comparison === "unchanged"));
}
function assertS9HomeEffect(before: readonly Entry[], after: readonly Entry[]): void {
  assert.equal(entry(before, ".s9-note")?.bytes, Buffer.from(initialNote).toString("base64"));
  assert.equal(entry(after, ".s9-note")?.bytes, Buffer.from(initialNote + appendedLine).toString("base64"));
  assert.deepEqual(after.filter(value => value.path !== ".s9-note"),
    before.filter(value => value.path !== ".s9-note"));
}
async function allocate(base: string, roots: Root[]): Promise<Root> {
  const token = randomBytes(32).toString("hex");
  const path = await fs.mkdtemp(join(base, prefix));
  const stat = await fs.lstat(path);
  const root = { path, dev: stat.dev, ino: stat.ino, token, removed: false };
  roots.push(root); // Authority is recorded before further writes.
  await fs.chmod(path, 0o700);
  await fs.writeFile(join(path, marker), token, { flag: "wx", mode: 0o600 });
  return root;
}
async function verify(root: Root): Promise<void> {
  const stat = await fs.lstat(root.path);
  assert(stat.isDirectory() && !stat.isSymbolicLink() && stat.dev === root.dev && stat.ino === root.ino);
  assert.equal(await fs.realpath(root.path), root.path);
  assert.equal(stat.uid, process.getuid?.());
  assert.equal(stat.mode & 0o777, 0o700);
  const owner = await fs.lstat(join(root.path, marker));
  assert(owner.isFile() && !owner.isSymbolicLink() && owner.nlink === 1);
  assert.equal(await fs.readFile(join(root.path, marker), "utf8"), root.token);
}
async function cleanup(root: Root, expected: readonly Entry[] | null): Promise<void> {
  await verify(root);
  assert(expected, "Fresh complete observation required");
  const current = await inventory(root.path);
  assert.deepEqual(current, expected, "Root changed after cleanup observation");
  const files = current.filter(item => item.kind === "file" && item.path !== marker)
    .map(item => item.path);
  const dirs = current.filter(item => item.kind === "directory" && item.path !== "")
    .map(item => item.path).sort((a, b) => b.length - a.length);
  for (const path of files) await fs.unlink(join(root.path, path));
  for (const path of dirs) await fs.rmdir(join(root.path, path));
  await fs.unlink(join(root.path, marker));
  await fs.rmdir(root.path);
  root.removed = true;
}
async function run(executable: string, argv: readonly string[], cwd: string, env: Record<string, string>,
  timeoutMs = 20_000): Promise<Result> {
  assert(isAbsolute(executable) && isAbsolute(cwd));
  return await new Promise(resolveResult => {
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    let timedOut = false, spawnError: string | null = null;
    const child = spawn(executable, [...argv], { cwd, env, shell: false, detached: false,
      stdio: ["ignore", "pipe", "pipe"] });
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutMs);
    child.stdout.on("data", (bytes: Buffer) => stdout.push(Buffer.from(bytes)));
    child.stderr.on("data", (bytes: Buffer) => stderr.push(Buffer.from(bytes)));
    child.on("error", error => { spawnError = error.message; });
    child.on("close", (exitCode, signal) => {
      clearTimeout(timer);
      resolveResult({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), exitCode, signal,
        timedOut, spawnError });
    });
  });
}
function framed(stderr: Buffer, actionStderr: Buffer): Receipt {
  assert(stderr.subarray(0, actionStderr.length).equals(actionStderr), "Action stderr differs");
  const frame = stderr.subarray(actionStderr.length);
  const prefixBytes = Buffer.from("\x1eTWIN-RECEIPT/1 ", "ascii");
  assert(frame.subarray(0, prefixBytes.length).equals(prefixBytes), "Receipt prefix differs");
  const newline = frame.indexOf(10, prefixBytes.length);
  assert(newline > prefixBytes.length, "Receipt length missing");
  const lengthBytes = frame.subarray(prefixBytes.length, newline);
  assert(lengthBytes.every(byte => byte >= 0x30 && byte <= 0x39), "Receipt length must use ASCII digits");
  const lengthText = lengthBytes.toString("ascii");
  assert(/^(0|[1-9][0-9]*)$/.test(lengthText), "Receipt length malformed");
  const length = Number(lengthText);
  assert(Number.isSafeInteger(length) && length <= 8 * 1024 * 1024, "Receipt length out of bounds");
  assert.equal(frame.length, newline + 1 + length + 1, "Receipt frame has extra or missing bytes");
  assert.equal(frame.at(-1), 10, "Receipt final LF missing");
  const payload = frame.subarray(newline + 1, newline + 1 + length);
  const receipt: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payload));
  assert(receipt && typeof receipt === "object");
  const typed = receipt as Receipt;
  assert.equal(typed.schemaVersion, 1);
  assert(Array.isArray(typed.files?.changes) && Array.isArray(typed.files.issues));
  assert(Array.isArray(typed.watch));
  assert.deepEqual(typed.watch.map(value => value.id), watchIds);
  return typed;
}
function assertSuccess(result: Result, stdout: Buffer, stderr: Buffer): void {
  assert.equal(result.spawnError, null); assert.equal(result.timedOut, false);
  assert.equal(result.exitCode, 0); assert.equal(result.signal, null);
  assert(result.stdout.equals(stdout)); assert(result.stderr.equals(stderr));
}
async function gitFixture(root: Root, fixture: Record<string, string>, setup: readonly string[][],
  launches: Comparison["launches"]): Promise<string> {
  const workspace = join(root.path, "workspace");
  await fs.mkdir(workspace, { mode: 0o700 });
  await fs.mkdir(join(workspace, "node_modules"), { mode: 0o700 });
  for (const [path, value] of Object.entries(fixture)) await fs.writeFile(join(workspace, path), value, { flag: "wx" });
  for (const argv of setup) {
    launches.setup++;
    const result = await run(gitInputs.git, argv, workspace, gitEnvironment(gitInputs.directory));
    assertSuccessState(result);
  }
  return workspace;
}
function assertSuccessState(result: Result): void {
  assert.equal(result.spawnError, null); assert.equal(result.timedOut, false);
  assert.equal(result.exitCode, 0); assert.equal(result.signal, null);
  assert.equal(result.stderr.length, 0);
}
function separated(paths: readonly string[]): void {
  for (let left = 0; left < paths.length; left++) {
    for (let right = left + 1; right < paths.length; right++) {
      assert(!within(paths[left]!, paths[right]!) && !within(paths[right]!, paths[left]!),
        "Disposable roots overlap");
    }
  }
}
function environment(scratch: Root, home: string): Record<string, string> {
  return { ...gitEnvironment(gitInputs.directory), HOME: home, TMPDIR: scratch.path };
}
async function comparison(scenario: Scenario): Promise<{ record: Comparison; roots: Root[]; beforeNames: string[]; afterNames: string[] }> {
  const base = await fs.realpath(tmpdir());
  assert(forbidden.every(path => !within(path, base) && !within(base, path)));
  const beforeNames = (await fs.readdir(base)).filter(name => name.startsWith(prefix)).sort();
  const roots: Root[] = [];
  const scratchRoots = new Set<Root>();
  const launches = { setup: 0, cli: 0, baseline: 0 };
  let record: Comparison | undefined;
  let primary: unknown;
  let unsettled = false;
  try {
    const support = await allocate(base, roots), original = await allocate(base, roots);
    const baseline = await allocate(base, roots), scratch = await allocate(base, roots);
    const baselineScratch = await allocate(base, roots);
    scratchRoots.add(scratch); scratchRoots.add(baselineScratch);
    const twinHome = await allocate(base, roots), baselineHome = await allocate(base, roots);
    await fs.mkdir(join(twinHome.path, "home"), { mode: 0o700 });
    await fs.mkdir(join(baselineHome.path, "home"), { mode: 0o700 });
    separated(roots.map(root => root.path));
    let actionExecutable: string, actionArgv: string[], originalCwd: string, baselineCwd: string;
    let actionBytes: Buffer | undefined;
    if (scenario === "S9") {
      const inputs = comparisonS9Inputs();
      originalCwd = join(original.path, "workspace"); baselineCwd = join(baseline.path, "workspace");
      for (const cwd of [originalCwd, baselineCwd]) {
        await fs.mkdir(cwd, { mode: 0o700 });
        for (const [path, bytes] of Object.entries(inputs.project)) await fs.writeFile(join(cwd, path), bytes, { flag: "wx", mode: 0o600 });
      }
      for (const root of [twinHome, baselineHome]) await fs.writeFile(join(root.path, "home/.s9-note"), initialNote,
        { flag: "wx", mode: 0o600 });
      actionBytes = inputs.action;
      await fs.mkdir(join(support.path, "actions"), { mode: 0o700 });
      const action = join(support.path, "actions/append-fake-home.mjs");
      await fs.writeFile(action, actionBytes, { flag: "wx", mode: 0o600 });
      actionExecutable = process.execPath; actionArgv = [action];
    } else {
      const inputs = scenario === "S12" ? comparisonS12Inputs() : gitInputs;
      originalCwd = await gitFixture(original, inputs.fixture, inputs.setup, launches);
      baselineCwd = await gitFixture(baseline, inputs.fixture, inputs.setup, launches);
      if (scenario === "S12") {
        actionBytes = comparisonS12Inputs().action;
        await fs.mkdir(join(support.path, "actions"), { mode: 0o700 });
        const action = join(support.path, "actions/create-file.mjs");
        await fs.writeFile(action, actionBytes, { flag: "wx", mode: 0o600 });
        actionExecutable = process.execPath; actionArgv = [action];
      } else { actionExecutable = gitInputs.git; actionArgv = [...gitInputs.actionArgv]; }
    }
    if (actionBytes) assert((await fs.readFile(actionArgv[0]!)).equals(actionBytes));
    const fixedArgv = scenario === "S6" ? ["clean", "-fdx"]
      : [join(support.path, "actions", scenario === "S12" ? "create-file.mjs" : "append-fake-home.mjs")];
    demandAction(scenario, actionExecutable, actionArgv, originalCwd, join(original.path, "workspace"), fixedArgv, actionBytes);
    demandAction(scenario, actionExecutable, actionArgv, baselineCwd, join(baseline.path, "workspace"), fixedArgv, actionBytes);
    const originalBefore = await inventory(originalCwd), baselineBefore = await inventory(baselineCwd);
    const twinHomeBefore = await inventory(join(twinHome.path, "home"));
    const baselineHomeBefore = await inventory(join(baselineHome.path, "home"));
    launches.cli++;
    const twin = await run(process.execPath, [cli, "run", "--", actionExecutable, ...actionArgv], originalCwd,
      environment(scratch, join(twinHome.path, "home")));
    unsettled = twin.timedOut || twin.signal !== null || twin.spawnError !== null;
    assert.equal(unsettled, false, "CLI process did not settle normally; roots retained");
    launches.baseline++;
    const direct = await run(actionExecutable, actionArgv, baselineCwd,
      environment(baselineScratch, join(baselineHome.path, "home")));
    unsettled = direct.timedOut || direct.signal !== null || direct.spawnError !== null;
    assert.equal(unsettled, false, "Baseline process did not settle normally; roots retained");
    const originalAfter = await inventory(originalCwd), baselineAfter = await inventory(baselineCwd);
    const twinHomeAfter = await inventory(join(twinHome.path, "home"));
    const baselineHomeAfter = await inventory(join(baselineHome.path, "home"));
    assert.deepEqual(originalAfter, originalBefore);
    assertBaselineEffect(scenario, baselineBefore, baselineAfter);
    const actionStderr = Buffer.alloc(0);
    const receipt = framed(twin.stderr, actionStderr);
    record = { scenario, originalBefore, originalAfter, baselineBefore, baselineAfter, twin, direct, launches,
      receipt, twinHomeBefore, twinHomeAfter, baselineHomeBefore, baselineHomeAfter };
    assertSuccessState({ ...twin, stderr: actionStderr });
    assertSuccessState(direct);
    assert(twin.stdout.equals(direct.stdout), "CLI action stdout differs from direct action");
    assert.deepEqual((await fs.readdir(scratch.path)).sort(), [marker], "CLI Twin allocation remains after discard");
    assert.deepEqual((await fs.readdir(baselineScratch.path)).sort(), [marker]);
  } catch (error: unknown) { primary = error; }
  const cleanupErrors: unknown[] = [];
  for (const root of unsettled ? [] : roots.toReversed()) {
    try {
      if (scratchRoots.has(root)) assert.deepEqual((await fs.readdir(root.path)).sort(), [marker],
        "Scratch contains a retained CLI allocation; cleanup refused");
      await cleanup(root, await inventory(root.path));
    }
    catch (error: unknown) { cleanupErrors.push(error); }
  }
  const afterNames = (await fs.readdir(base)).filter(name => name.startsWith(prefix)).sort();
  if (primary || cleanupErrors.length || !record || JSON.stringify(beforeNames) !== JSON.stringify(afterNames)
    || roots.some(root => !root.removed)) {
    throw new AggregateError([...(primary ? [primary] : []), ...cleanupErrors],
      `Comparison ${scenario} failed; roots=${roots.length}, removed=${roots.filter(root => root.removed).length}`);
  }
  return { record, roots, beforeNames, afterNames };
}

describe("public Twin CLI against independent plain-Git fixtures", () => {
  it.each(["S12", "S6", "S9"] as const)("measures %s with a framed receipt and complete external inventories", async scenario => {
    const { record, roots, beforeNames, afterNames } = await comparison(scenario);
    expect(roots).toHaveLength(7); expect(roots.every(root => root.removed)).toBe(true);
    expect(record.launches).toEqual({ setup: scenario === "S9" ? 0 : 14, cli: 1, baseline: 1 });
    expect(afterNames).toEqual(beforeNames);
    expect(record.originalAfter).toEqual(record.originalBefore);
    expect(record.receipt.files.coverage).toBe("complete");
    expect(record.receipt.files.issues).toEqual([]);
    if (scenario === "S12") {
      expect(record.twin.stdout).toEqual(Buffer.alloc(0));
      expect(entry(record.baselineBefore, "control-created.txt")).toBeUndefined();
      expect(entry(record.baselineAfter, "control-created.txt")?.bytes).toBe(Buffer.from("S12 control file.\n").toString("base64"));
      expect(record.receipt.files.changes).toEqual([expect.objectContaining({
        path: { encoding: "utf8", value: "control-created.txt" }, change: "added", category: "untracked" })]);
    } else if (scenario === "S6") {
      assertS6Stdout(record.direct.stdout.toString("utf8"));
      expect(record.twin.stdout).toEqual(record.direct.stdout);
      for (const path of [".env", "scratch.txt", "node_modules", "node_modules/lib.txt"]) {
        expect(entry(record.baselineBefore, path)).toBeDefined();
        expect(entry(record.baselineAfter, path)).toBeUndefined();
      }
      expect(record.receipt.files.changes.map(value => [value.path.value, value.change, value.category]).sort())
        .toEqual([[".env", "deleted", "ignored"], ["node_modules/lib.txt", "deleted", "ignored"],
          ["scratch.txt", "deleted", "untracked"]]);
      expect(entry(record.baselineAfter, ".git")).toEqual(entry(record.baselineBefore, ".git"));
    } else {
      expect(record.twin.stdout.toString("utf8")).toBe(successLine);
      assert(record.twinHomeBefore && record.twinHomeAfter && record.baselineHomeBefore && record.baselineHomeAfter);
      assertS9HomeEffect(record.twinHomeBefore, record.twinHomeAfter);
      assertS9HomeEffect(record.baselineHomeBefore, record.baselineHomeAfter);
      assertS9Omission(record.receipt);
    }
  }, 60_000);

  it("rejects altered action identity before execution", () => {
    expect(() => demandAction("S6", gitInputs.git, ["clean", "-fd"], "/tmp/fixture", "/tmp/fixture",
      ["clean", "-fdx"])).toThrow();
    expect(() => demandAction("S12", process.execPath, ["/tmp/other.mjs"], "/tmp/fixture", "/tmp/fixture",
      ["/tmp/action.mjs"], comparisonS12Inputs().action)).toThrow();
  });
  it("rejects overlapping fixture roots", () => {
    expect(() => separated(["/tmp/a", "/tmp/a/b"])).toThrow("Disposable roots overlap");
  });
  it("rejects incomplete baseline effects and a claimed S9 watch", () => {
    const base: Entry[] = [{ path: "", kind: "directory", mode: 0o700 }];
    expect(() => assertBaselineEffect("S12", base, base)).toThrow();
    expect(() => assertBaselineEffect("S6", base, base)).toThrow();
    const home: Entry[] = [...base, { path: ".s9-note", kind: "file", mode: 0o600,
      bytes: Buffer.from(initialNote).toString("base64") }];
    expect(() => assertS9HomeEffect(home, home)).toThrow();
    const claimed: Receipt = { schemaVersion: 1, files: { coverage: "complete", issues: [], changes: [] },
      watch: [...watchIds.map(id => ({ id, comparison: "unchanged" })), { id: ".s9-note", comparison: "changed" }] };
    expect(() => assertS9Omission(claimed)).toThrow();
    expect(() => assertS9Omission({ ...claimed, watch: watchIds.map(id => ({ id,
      comparison: id === ".npmrc" ? "changed" : "unchanged" })) })).toThrow();
  });
  it("rejects malformed, truncated, extra and unframed receipt bytes", () => {
    const payload = Buffer.from(JSON.stringify({ schemaVersion: 1, files: { coverage: "complete", issues: [], changes: [] },
      watch: watchIds.map(id => ({ id, comparison: "unchanged" })) }));
    const good = Buffer.concat([Buffer.from(`\x1eTWIN-RECEIPT/1 ${payload.length}\n`), payload, Buffer.from("\n")]);
    expect(framed(good, Buffer.alloc(0)).files.changes).toEqual([]);
    const lengthOffset = Buffer.from("\x1eTWIN-RECEIPT/1 ").length;
    for (const byte of [0xb1, 0xc3, 0x2b, 0x20, 0x0d]) {
      const bad = Buffer.from(good);
      bad[lengthOffset] = byte;
      expect(() => framed(bad, Buffer.alloc(0))).toThrow();
    }
    for (const [offset, byte] of [[lengthOffset - 1, 0x09], [good.indexOf(10, lengthOffset), 0x0d]] as const) {
      const bad = Buffer.from(good);
      bad[offset] = byte;
      expect(() => framed(bad, Buffer.alloc(0))).toThrow();
    }
    for (const bad of [good.subarray(0, -1), Buffer.concat([good, Buffer.from("x")]),
      Buffer.from(good.toString().replace(` ${payload.length}\n`, " 1\n")), payload]) {
      expect(() => framed(bad, Buffer.alloc(0))).toThrow();
    }
  });
  it("refuses cleanup without a fresh observation or matching authority", async () => {
    const base = await fs.realpath(tmpdir()), roots: Root[] = [];
    const root = await allocate(base, roots);
    try {
      await expect(cleanup(root, null)).rejects.toThrow();
      await expect(cleanup({ ...root, ino: root.ino + 1 }, await inventory(root.path))).rejects.toThrow();
      expect(await fs.readFile(join(root.path, marker), "utf8")).toBe(root.token);
    } finally { await cleanup(root, await inventory(root.path)); }
    expect(root.removed).toBe(true);
  });
  it("records the fixed S9 command failure without modifying its registered fake HOME", async () => {
    const base = await fs.realpath(tmpdir()), roots: Root[] = [];
    try {
      const support = await allocate(base, roots), project = await allocate(base, roots), home = await allocate(base, roots);
      const action = join(support.path, "append-fake-home.mjs");
      await fs.writeFile(action, comparisonS9Inputs().action, { flag: "wx", mode: 0o600 });
      await fs.mkdir(join(project.path, "workspace"), { mode: 0o700 });
      await fs.mkdir(join(home.path, "home"), { mode: 0o700 });
      const before = await inventory(join(home.path, "home"));
      const result = await run(process.execPath, [action], join(project.path, "workspace"),
        environment(home, join(home.path, "home")));
      expect(result.spawnError).toBeNull(); expect(result.timedOut).toBe(false);
      expect(result.exitCode).toBe(1); expect(result.signal).toBeNull();
      expect(result.stdout).toEqual(Buffer.alloc(0)); expect(result.stderr).toEqual(Buffer.from(failureLine));
      expect(await inventory(join(home.path, "home"))).toEqual(before);
    } finally {
      for (const root of roots.toReversed()) await cleanup(root, await inventory(root.path));
    }
    expect(roots.every(root => root.removed)).toBe(true);
  });
});
