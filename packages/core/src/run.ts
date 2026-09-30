import { spawn, type ChildProcess } from "node:child_process";
import { isAbsolute } from "node:path";
import type { Readable } from "node:stream";
import { message } from "./safety.js";
import type { CapturedOutput, RunOptions, RunResult } from "./twin.js";

export function validateRunOptions(options: RunOptions): RunOptions {
  const snapshot = (() => {
    try {
      // Read caller properties once; later accessors may mutate the originals.
      const executable = options.executable;
      const inputArgv = options.argv;
      const inputEnv = options.env;
      const timeoutMs = options.timeoutMs ?? 60000;
      const stdio = options.stdio;
      const interruptSignal = options.interruptSignal;
      if (!Array.isArray(inputArgv) || !inputEnv || typeof inputEnv !== "object" || Array.isArray(inputEnv)) {
        throw new Error("Expected argv array and environment object");
      }
      const argv: unknown[] = [...inputArgv];
      const entries: [string, unknown][] = Object.entries(inputEnv);
      return { executable, argv, entries, timeoutMs, stdio, interruptSignal };
    } catch (error: unknown) {
      throw new Error("Cannot snapshot command options", { cause: error });
    }
  })();
  const { executable, argv, entries, timeoutMs, stdio, interruptSignal } = snapshot;
  if (typeof executable !== "string" || !isAbsolute(executable) || executable.includes("\0")) throw new Error("Invalid command options");
  if (!argv.every((arg): arg is string => typeof arg === "string" && !arg.includes("\0"))) throw new Error("Invalid command arguments");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3600000) throw new Error("Invalid timeout");
  if (stdio !== undefined && stdio !== "inherit") throw new Error("Invalid stdio mode");
  if (interruptSignal !== undefined && !(interruptSignal instanceof AbortSignal)) throw new Error("Invalid interrupt signal");
  const env: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [key, value] of entries) {
    if (!key || /[=\0]/.test(key) || typeof value !== "string" || value.includes("\0")) throw new Error("Invalid environment");
    env[key] = value;
  }
  return { executable, argv, env, timeoutMs, ...(stdio === "inherit" ? { stdio } : {}),
    ...(interruptSignal ? { interruptSignal } : {}) };
}
function capture(stream: Readable): { result: (started: boolean) => CapturedOutput; dispose: () => void; unref: () => void } {
  const bytes = Buffer.alloc(65536);
  let used = 0;
  let truncated = false;
  let ended = false;
  let error: string | null = null;
  const onData = (chunk: Buffer): void => {
    const retained = Math.min(chunk.length, bytes.length - used);
    chunk.copy(bytes, used, 0, retained);
    used += retained;
    if (retained < chunk.length) truncated = true;
  };
  const onEnd = (): void => { ended = true; };
  const onError = (failure: Error): void => { error = failure.message; };
  const onClose = (): void => {
    stream.off("data", onData);
    stream.off("end", onEnd);
    stream.off("error", onError);
  };
  stream.on("data", onData);
  stream.once("end", onEnd);
  stream.on("error", onError);
  stream.once("close", onClose);
  return { unref: () => {
    if ("unref" in stream && typeof stream.unref === "function") stream.unref();
  }, dispose: () => {
    stream.off("data", onData);
    stream.off("end", onEnd);
    // Destruction can deliver an already queued error before close.
    stream.destroy();
  }, result: started => ({ bytes: Uint8Array.from(bytes.subarray(0, used)), truncated,
    complete: started && ended && !truncated && error === null, error }) };
}
export async function runCommand(cwd: string, options: RunOptions, onSettled: () => void): Promise<RunResult> {
  return await new Promise<RunResult>(resolve => {
    let started = false;
    let directSettled = false;
    let finished = false;
    let timedOut = false;
    let terminating = false;
    let pipesClosed = false;
    let exitCode: number | null = null;
    let signal: NodeJS.Signals | null = null;
    let spawnError: string | null = null;
    let terminationError: string | null = null;
    const timers: ReturnType<typeof setTimeout>[] = [];
    let child: ChildProcess | undefined;
    let stdout: ReturnType<typeof capture> | undefined;
    let stderr: ReturnType<typeof capture> | undefined;
    const interruptSignal = options.interruptSignal;
    let poll: ReturnType<typeof setInterval> | undefined;
    let drainTimer: ReturnType<typeof setTimeout> | undefined;
    let safeNotified = false;
    const markSafe = (): void => {
      if (!safeNotified) { safeNotified = true; onSettled(); }
    };
    const groupStatus = (): "absent" | "present" | "unknown" => {
      if (!started || !child?.pid) return "absent";
      try { process.kill(-child.pid, 0); return "present"; }
      catch (error: unknown) {
        if (error instanceof Error && "code" in error && error.code === "ESRCH") return "absent";
        return "unknown";
      }
    };
    const disposeChild = (retainLate = false): void => {
      child?.off("spawn", onSpawn);
      if (!retainLate) child?.off("close", onClose);
      if (!retainLate) {
        child?.off("exit", onExit);
        child?.off("error", onError);
      }
    };
    const clearTimers = (): void => {
      for (const timer of timers) clearTimeout(timer);
      if (poll) clearInterval(poll);
      if (drainTimer) clearTimeout(drainTimer);
    };
    const onSpawn = (): void => { started = true; };
    const onError = (error: Error): void => {
      if (!started) { spawnError = error.message; directSettled = true; markSafe(); finish(); }
      else terminationError = error.message;
    };
    const onExit = (code: number | null, exitSignal: NodeJS.Signals | null): void => {
      exitCode = code;
      signal = exitSignal;
      directSettled = true;
      if (!finished) checkLifecycle();
      else {
        checkLate();
      }
    };
    const onClose = (): void => {
      pipesClosed = true;
      if (finished) checkLate();
      else checkLifecycle();
    };
    const checkLate = (): void => {
      if (!finished || !directSettled || !pipesClosed || groupStatus() !== "absent") return;
      markSafe();
      if (poll) clearInterval(poll);
      poll = undefined;
      stdout?.dispose();
      stderr?.dispose();
      disposeChild();
    };
    const finish = (): void => {
      if (finished) return;
      finished = true;
      clearTimers();
      interruptSignal?.removeEventListener("abort", onAbort);
      const group = groupStatus();
      const lifecycleIssue = !directSettled ? "direct child exit remains unconfirmed"
        : group !== "absent" ? `process group ${group}`
          : !pipesClosed && started ? "stdio pipes remain open" : null;
      if (lifecycleIssue === null) markSafe();
      const empty: CapturedOutput = { bytes: new Uint8Array(), complete: false, truncated: false, error: null };
      const result: RunResult = { schemaVersion: 1, outcome: timedOut ? "timed-out" : spawnError ? "spawn-failed" : "exited",
        started, directChildSettled: directSettled, exitCode, signal, spawnError,
        stdout: stdout?.result(started) ?? empty, stderr: stderr?.result(started) ?? empty, terminationError,
        ...(lifecycleIssue ? { lifecycleIssue } : {}) };
      if (lifecycleIssue === null) { stdout?.dispose(); stderr?.dispose(); }
      else { stdout?.unref(); stderr?.unref(); }
      disposeChild(lifecycleIssue !== null);
      // Keep the exit listener for late settlement; never claim an unobserved exit.
      if (!directSettled) child?.unref();
      if (lifecycleIssue !== null) {
        poll = setInterval(checkLate, 100);
        poll.unref();
      }
      resolve(result);
    };
    const kill = (requested: NodeJS.Signals): void => {
      if (finished || groupStatus() === "absent" && directSettled) return;
      try {
        if (started && child?.pid) process.kill(-child.pid, requested);
        else if (!child?.kill(requested)) terminationError = `Could not deliver ${requested}`;
      } catch (error: unknown) { terminationError = message(error); }
    };
    const beginTermination = (requested: NodeJS.Signals, timeout: boolean): void => {
      if (finished || terminating) return;
      terminating = true;
      timedOut = timeout;
      for (const timer of timers) clearTimeout(timer);
      kill(requested);
      timers.push(setTimeout(() => {
        if (groupStatus() === "absent" && directSettled) return;
        kill("SIGKILL");
        timers.push(setTimeout(() => {
          if (!directSettled) terminationError ??= "Direct child exit remains unconfirmed";
          finish();
        }, 5000));
      }, 1000));
    };
    const checkLifecycle = (): void => {
      if (finished || !directSettled) return;
      const group = groupStatus();
      if (group !== "absent") {
        if (!terminating) beginTermination("SIGTERM", false);
        poll ??= setInterval(checkLifecycle, 50);
        return;
      }
      if (pipesClosed || !started) { finish(); return; }
      drainTimer ??= setTimeout(finish, 1000);
    };
    const onAbort = (): void => {
      const requested = interruptSignal?.reason === "SIGINT" ? "SIGINT" : "SIGTERM";
      beginTermination(requested, false);
    };
    try {
      child = spawn(options.executable, [...options.argv], {
        cwd, env: { ...options.env }, shell: false, detached: true,
        stdio: options.stdio === "inherit" ? ["inherit", "inherit", "inherit"] : ["ignore", "pipe", "pipe"],
      });
      pipesClosed = !child.stdout && !child.stderr;
      if (child.stdout) stdout = capture(child.stdout);
      if (child.stderr) stderr = capture(child.stderr);
      child.once("spawn", onSpawn);
      child.on("error", onError);
      child.once("exit", onExit);
      child.once("close", onClose);
      timers.push(setTimeout(() => beginTermination("SIGTERM", true), options.timeoutMs ?? 60000));
      interruptSignal?.addEventListener("abort", onAbort, { once: true });
      if (interruptSignal?.aborted) onAbort();
    } catch (error: unknown) {
      spawnError = message(error);
      directSettled = true;
      markSafe();
      finish();
    }
  });
}
