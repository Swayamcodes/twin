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
      if (!Array.isArray(inputArgv) || !inputEnv || typeof inputEnv !== "object" || Array.isArray(inputEnv)) {
        throw new Error("Expected argv array and environment object");
      }
      const argv: unknown[] = [...inputArgv];
      const entries: [string, unknown][] = Object.entries(inputEnv);
      return { executable, argv, entries, timeoutMs };
    } catch (error: unknown) {
      throw new Error("Cannot snapshot command options", { cause: error });
    }
  })();
  const { executable, argv, entries, timeoutMs } = snapshot;
  if (typeof executable !== "string" || !isAbsolute(executable) || executable.includes("\0")) throw new Error("Invalid command options");
  if (!argv.every((arg): arg is string => typeof arg === "string" && !arg.includes("\0"))) throw new Error("Invalid command arguments");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3600000) throw new Error("Invalid timeout");
  const env: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [key, value] of entries) {
    if (!key || /[=\0]/.test(key) || typeof value !== "string" || value.includes("\0")) throw new Error("Invalid environment");
    env[key] = value;
  }
  return { executable, argv, env, timeoutMs };
}
function capture(stream: Readable): { result: (started: boolean) => CapturedOutput; dispose: () => void } {
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
  return { dispose: () => {
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
    let settled = false;
    let finished = false;
    let timedOut = false;
    let exitCode: number | null = null;
    let signal: NodeJS.Signals | null = null;
    let spawnError: string | null = null;
    let terminationError: string | null = null;
    const timers: ReturnType<typeof setTimeout>[] = [];
    let child: ChildProcess | undefined;
    let stdout: ReturnType<typeof capture> | undefined;
    let stderr: ReturnType<typeof capture> | undefined;
    const markSettled = (): void => {
      if (!settled) { settled = true; onSettled(); }
    };
    const disposeChild = (): void => {
      child?.off("spawn", onSpawn);
      child?.off("close", onClose);
      if (settled) {
        child?.off("exit", onExit);
        child?.off("error", onError);
      }
    };
    const onSpawn = (): void => { started = true; };
    const onError = (error: Error): void => {
      if (!started) { spawnError = error.message; markSettled(); finish(); }
      else terminationError = error.message;
    };
    const onExit = (code: number | null, exitSignal: NodeJS.Signals | null): void => {
      exitCode = code;
      signal = exitSignal;
      markSettled();
      for (const timer of timers) clearTimeout(timer);
      if (!finished) timers.push(setTimeout(finish, 1000));
      else disposeChild();
    };
    const onClose = (): void => { if (settled) finish(); };
    const finish = (): void => {
      if (finished) return;
      finished = true;
      for (const timer of timers) clearTimeout(timer);
      const empty: CapturedOutput = { bytes: new Uint8Array(), complete: false, truncated: false, error: null };
      const result: RunResult = { schemaVersion: 1, outcome: timedOut ? "timed-out" : spawnError ? "spawn-failed" : "exited",
        started, directChildSettled: settled, exitCode, signal, spawnError,
        stdout: stdout?.result(started) ?? empty, stderr: stderr?.result(started) ?? empty, terminationError };
      stdout?.dispose();
      stderr?.dispose();
      disposeChild();
      // Keep the exit listener for late settlement; never claim an unobserved exit.
      if (!settled) child?.unref();
      resolve(result);
    };
    const kill = (requested: NodeJS.Signals): void => {
      if (settled) return;
      try {
        if (!child?.kill(requested)) terminationError = `Could not deliver ${requested}`;
      } catch (error: unknown) { terminationError = message(error); }
    };
    try {
      child = spawn(options.executable, [...options.argv], {
        cwd, env: { ...options.env }, shell: false, detached: false, stdio: ["ignore", "pipe", "pipe"],
      });
      if (child.stdout) stdout = capture(child.stdout);
      if (child.stderr) stderr = capture(child.stderr);
      child.once("spawn", onSpawn);
      child.on("error", onError);
      child.once("exit", onExit);
      child.once("close", onClose);
      timers.push(setTimeout(() => {
        if (settled) return;
        timedOut = true;
        kill("SIGTERM");
        timers.push(setTimeout(() => {
          if (settled) return;
          kill("SIGKILL");
          timers.push(setTimeout(() => {
            if (!settled) terminationError ??= "Direct child exit remains unconfirmed";
            finish();
          }, 5000));
        }, 1000));
      }, options.timeoutMs ?? 60000));
    } catch (error: unknown) {
      spawnError = message(error);
      markSettled();
      finish();
    }
  });
}
