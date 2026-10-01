/// <reference types="node" />

import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
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

async function waitForActionExit(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    try { process.kill(pid, 0); }
    catch (error: unknown) {
      if (error instanceof Error && "code" in error && error.code === "ESRCH") return;
      throw error;
    }
    await delay(50);
  }
  throw new Error(`Test action PID ${pid} is still present`);
}

it.each(["json", "text"] as const)("delivers stdin and streams output before command completion with %s receipt", async format => {
  const source = await mkdtemp(join(tmpdir(), "twin-cli-interactive-test-"));
  const cli = fileURLToPath(new URL("../dist/index.js", import.meta.url));
  const script = [
    'process.stdout.write(`ready:${process.pid}\\n`);',
    'const deadline = setTimeout(() => process.exit(2), 3000);',
    'process.stdin.once("data", chunk => {',
    '  clearTimeout(deadline);',
    '  process.stdin.pause();',
    '  process.stdout.write(`got:${chunk.toString()}`);',
    '  process.stderr.write("child-stderr\\n");',
    '});',
  ].join("\n");
  const child = spawn(process.execPath, [cli, "run", "--interactive", ...(format === "text" ? ["--receipt=text"] : []),
    "--", process.execPath, "-e", script], {
    cwd: source, stdio: ["pipe", "pipe", "pipe"],
  });
  let launchError: Error | null = null;
  child.on("error", error => { launchError = error; });
  let closed = false;
  const close = new Promise<number | null>(resolve => child.once("close", code => { closed = true; resolve(code); }));
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  let actionPid: number | null = null;
  let failure: unknown = null;
  let cleanupFailure: unknown = null;
  try {
    actionPid = await within(new Promise<number>(resolve => {
      const onData = (): void => {
        const match = /^ready:(\d+)\n/.exec(Buffer.concat(stdout).toString());
        if (!match) return;
        child.stdout.off("data", onData);
        resolve(Number(match[1]));
      };
      child.stdout.on("data", onData);
      onData();
    }), 6000, "live output");
    expect(child.exitCode).toBeNull();
    child.stdin.end("input\n");
    const code = await within(close, 6000, "CLI close");
    expect(code).toBe(0);
    expect(Buffer.concat(stdout).toString()).toBe(`ready:${actionPid}\ngot:input\n`);
    const output = Buffer.concat(stderr).toString();
    if (format === "text") {
      expect(output).toMatch(/^child-stderr\nTwin receipt \(schema 5\)/);
      expect(output).toContain("Captured pipes: not-captured");
      expect(output).not.toContain("TWIN-RECEIPT/1");
    } else expect(output).toMatch(/^child-stderr\n\x1eTWIN-RECEIPT\/1 /);
  } catch (error: unknown) { failure = launchError ?? error; }
  try {
    if (failure !== null && !closed) child.kill("SIGKILL");
    await within(close, 6000, "CLI close during cleanup");
    if (actionPid === null || !Number.isSafeInteger(actionPid) || actionPid <= 1) throw new Error("Test action PID was not observed");
    await waitForActionExit(actionPid);
    await rm(source, { recursive: true });
  } catch (error: unknown) { cleanupFailure = new Error(`Cleanup failed; retained ${source}`, { cause: error }); }
  if (failure !== null && cleanupFailure !== null) throw new AggregateError([failure, cleanupFailure], "Interactive test and cleanup failed");
  if (cleanupFailure !== null) throw cleanupFailure;
  if (failure !== null) throw failure;
}, 25000);
