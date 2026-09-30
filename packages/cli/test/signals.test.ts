/// <reference types="node" />

import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

async function bounded<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("CLI close timed out")), ms);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

async function stopped(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt++) {
    try { process.kill(pid, 0); }
    catch (error: unknown) {
      if (error instanceof Error && "code" in error && error.code === "ESRCH") return;
      throw error;
    }
    await delay(50);
  }
  throw new Error(`Action PID ${pid} remains present`);
}

async function exercise(signal: "SIGINT" | "SIGTERM", interactive: boolean, uncooperative = false): Promise<void> {
  const fixture = await mkdtemp(join(tmpdir(), "twin-cli-signal-test-"));
  const source = join(fixture, "source");
  await mkdir(source);
  const marker = join(fixture, "action-pid");
  const cli = fileURLToPath(new URL("../dist/index.js", import.meta.url));
  const script = [
    'const fs = require("node:fs");',
    'const deadline = setTimeout(() => process.exit(3), 7000);',
    'for (const name of ["SIGINT", "SIGTERM"]) process.on(name, () => {',
    '  if (process.argv[2] === "stubborn") return;',
    '  clearTimeout(deadline);',
    '  process.stderr.write(`caught:${name}\\n`);',
    '  process.exit(0);',
    '});',
    'fs.writeFileSync(process.argv[1], String(process.pid));',
  ].join("\n");
  const args = [cli, "run", ...(interactive ? ["--interactive"] : []), "--", process.execPath,
    "-e", script, "--", marker, uncooperative ? "stubborn" : "cooperative"];
  const cliProcess = spawn(process.execPath, args, { cwd: source, stdio: ["pipe", "pipe", "pipe"] });
  let closed = false;
  const close = new Promise<number | null>(resolve => cliProcess.once("close", code => { closed = true; resolve(code); }));
  let launchError: Error | null = null;
  cliProcess.on("error", error => { launchError = error; });
  const stderr: Buffer[] = [];
  cliProcess.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  let pid: number | null = null;
  let failure: unknown = null;
  let cleanupFailure: unknown = null;
  try {
    for (let attempt = 0; attempt < 120; attempt++) {
      try { pid = Number(await readFile(marker, "utf8")); break; }
      catch (error: unknown) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      }
      await delay(50);
    }
    if (!pid || !Number.isSafeInteger(pid)) throw new Error(`No action PID; ${String(launchError ?? "startup incomplete")}`);
    expect(cliProcess.exitCode).toBeNull();
    expect(cliProcess.kill(signal)).toBe(true);
    cliProcess.kill(signal); // Repeated caller signal must not restart termination.
    const code = await bounded(close, uncooperative ? 4000 : 8000);
    expect(code).toBe(1);
    const output = Buffer.concat(stderr).toString();
    expect(output).toContain("TWIN-RECEIPT/1");
    expect(output).not.toContain("Twin discard refused");
    if (uncooperative) expect(output).not.toContain("caught:SIGTERM");
    else expect(output).toContain(`caught:${signal}`);
  } catch (error: unknown) { failure = error; }
  try {
    if (failure !== null && !closed) cliProcess.kill("SIGKILL");
    await bounded(close, 8000);
    if (pid === null) throw new Error("Action PID was not observed");
    await stopped(pid);
    await rm(fixture, { recursive: true });
  } catch (error: unknown) { cleanupFailure = new Error(`Cleanup failed; retained ${fixture}`, { cause: error }); }
  if (failure !== null && cleanupFailure !== null) throw new AggregateError([failure, cleanupFailure], "Signal test and cleanup failed");
  if (cleanupFailure !== null) throw cleanupFailure;
  if (failure !== null) throw failure;
}

it.each([
  ["SIGINT", false], ["SIGTERM", false], ["SIGINT", true], ["SIGTERM", true],
] as const)("forwards %s in interactive=%s and emits a receipt", async (signal, interactive) => {
  await exercise(signal, interactive);
}, 25000);

it("escalates an uncooperative fixed child", async () => {
  await exercise("SIGTERM", true, true);
}, 25000);
