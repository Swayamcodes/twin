import { spawn } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

async function within<T>(promise: Promise<T>, ms: number, description: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out waiting for ${description}`)), ms);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

async function actionPid(marker: string): Promise<number> {
  let value: string;
  try { value = (await readFile(marker, "utf8")).trim(); }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new Error("Action PID marker is missing", { cause: error });
    }
    throw error;
  }
  if (!/^\d+$/.test(value)) throw new Error("Action PID marker is invalid");
  const pid = Number(value);
  if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error("Action PID marker is invalid");
  return pid;
}

async function waitForActionExit(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    try { process.kill(pid, 0); }
    catch (error: unknown) {
      if (error instanceof Error && "code" in error && error.code === "ESRCH") return;
      throw error;
    }
    await delay(50);
  }
  throw new Error(`Action PID ${pid} is still present`);
}

async function removeSettledFixture(fixture: string, closed: boolean, pid: number | null): Promise<void> {
  if (!closed) throw new Error("CLI process did not stop");
  if (pid === null || !Number.isSafeInteger(pid) || pid <= 1) throw new Error("Action PID was not established");
  await waitForActionExit(pid);
  await rm(fixture, { recursive: true });
}

async function cleanupLaunchedFixture(fixture: string, marker: string, closed: boolean, pid: number | null): Promise<void> {
  const verifiedPid = pid ?? await actionPid(marker);
  await removeSettledFixture(fixture, closed, verifiedPid);
}

it("transports a global npm addition in the public CLI receipt frame", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "twin-cli-global-npm-test-"));
  const source = join(fixture, "source"), home = join(fixture, "home"), prefix = join(fixture, "prefix");
  const marker = join(fixture, "action-pid");
  let closed = false;
  let pid: number | null = null;
  let failure: unknown = null;
  let child: ReturnType<typeof spawn> | undefined;
  let close: Promise<number | null> | undefined;
  let launchError: Error | null = null;
  try {
    await mkdir(source); await mkdir(home); await mkdir(prefix);
    await writeFile(join(source, "package.json"), JSON.stringify({ name: "fixture", version: "1.0.0" }));
    await writeFile(join(home, ".npmrc"), "");
    await writeFile(join(home, "global.npmrc"), "");
    const cli = fileURLToPath(new URL("../dist/index.js", import.meta.url));
    const script = [
      'const fs=require("node:fs"); const path=require("node:path");',
      'fs.writeFileSync(process.argv[1],String(process.pid));',
      'const root=path.join(process.env.NPM_CONFIG_PREFIX,"lib/node_modules/probe");',
      'fs.mkdirSync(root,{recursive:true});',
      'fs.writeFileSync(path.join(root,"package.json"),JSON.stringify({name:"probe",version:"1.0.0"}));',
    ].join("\n");
    const env = { ...process.env, HOME: home, NPM_CONFIG_PREFIX: prefix, NPM_CONFIG_CACHE: join(fixture, "cache"),
      NPM_CONFIG_USERCONFIG: join(home, ".npmrc"), NPM_CONFIG_GLOBALCONFIG: join(home, "global.npmrc"),
      NPM_CONFIG_OFFLINE: "true", npm_config_prefix: undefined };
    const running = spawn(process.execPath, [cli, "run", "--", process.execPath, "-e", script, "--", marker],
      { cwd: source, env, stdio: ["ignore", "pipe", "pipe"] });
    child = running;
    running.on("error", error => { launchError = error; });
    close = new Promise(resolve => running.once("close", value => { closed = true; resolve(value); }));
    if (!running.stderr || !running.stdout) throw new Error("CLI output pipes unavailable");
    const stderr: Buffer[] = [];
    const stdout: Buffer[] = [];
    running.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    running.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    const code = await within(close, 6000, "CLI completion");
    if (launchError) throw launchError;
    expect(code).toBe(0);
    pid = await actionPid(marker);
    const bytes = Buffer.concat(stderr);
    const frameStart = bytes.lastIndexOf(Buffer.from("\x1eTWIN-RECEIPT/1 "));
    if (frameStart < 0) throw new Error(`Missing frame: stderr=${JSON.stringify(bytes.toString("utf8"))} stdout=${JSON.stringify(Buffer.concat(stdout).toString("utf8"))}`);
    const frame = bytes.subarray(frameStart);
    const match = /^\x1eTWIN-RECEIPT\/1 (\d+)\n/.exec(frame.toString("utf8"));
    expect(match).not.toBeNull();
    const header = Buffer.byteLength(match![0]);
    const length = Number(match![1]);
    expect(frame.length).toBe(header + length + 1);
    expect(frame.at(-1)).toBe(10);
    const receipt: unknown = JSON.parse(frame.subarray(header, header + length).toString("utf8"));
    expect(receipt).toMatchObject({ schemaVersion: 3, globalNpm: { coverage: "complete", source: "env-prefix",
      changes: [{ name: "probe", change: "added", before: null, after: "1.0.0" }] } });
  } catch (error) { failure = error; }
  let cleanupFailure: unknown = null;
  try {
    if (child) {
      if (!closed) child.kill("SIGKILL");
      if (!close) throw new Error("CLI completion was not observed");
      await within(close, 6000, "CLI close during cleanup");
      await cleanupLaunchedFixture(fixture, marker, closed, pid);
    } else await rm(fixture, { recursive: true }); // Setup failed before launch.
  } catch (error) { cleanupFailure = new Error(`Cleanup uncertain; retained ${fixture}`, { cause: error }); }
  if (failure && cleanupFailure) throw new AggregateError([failure, cleanupFailure], `Test and cleanup failed; retained ${fixture}`);
  if (cleanupFailure) throw cleanupFailure;
  if (failure) throw failure;
}, 25000);

it("bounds a CLI completion wait without launching a process", async () => {
  await expect(within(new Promise<never>(() => undefined), 10, "CLI completion"))
    .rejects.toThrow("Timed out waiting for CLI completion");
});

it("refuses cleanup without an action PID", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "twin-cli-global-npm-test-"));
  try {
    await expect(cleanupLaunchedFixture(fixture, join(fixture, "absent-pid"), true, null))
      .rejects.toThrow("Action PID marker is missing");
    expect((await lstat(fixture)).isDirectory()).toBe(true);
  } finally {
    // This case launches no process; remove its test-only fixture after proving refusal.
    await rm(fixture, { recursive: true });
  }
});

it("rejects invalid action PID markers", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "twin-cli-global-npm-test-"));
  const marker = join(fixture, "action-pid");
  try {
    for (const value of ["0", "1", "1.5", "9007199254740992", "unreadable"]) {
      await writeFile(marker, value);
      await expect(actionPid(marker)).rejects.toThrow("Action PID marker is invalid");
    }
  } finally { await rm(fixture, { recursive: true }); }
});
