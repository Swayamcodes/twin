import { join } from "node:path";
import childProcess, { ChildProcess } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { fixtureTest, nodeOptions } from "./support.js";

describe("direct execution", () => {
  it.each(["env-mutation", "executable-getter", "argv-getter", "element-getter", "after-snapshot"] as const)("executes only the single-read snapshot: %s", async behavior => fixtureTest(async f => {
    const session = await f.create();
    const base = nodeOptions("echo", ["a b", "", "*", "--flag"], { VALUE: "original" });
    const expectedArgv = [...base.argv];
    const options = { executable: base.executable, argv: [...base.argv], env: { VALUE: "original" }, timeoutMs: 5000 };
    let reads = 0;
    if (behavior === "env-mutation") Object.defineProperty(options.env, "VALUE", { enumerable: true, get: () => {
      reads++; options.executable = "relative-replacement"; options.argv[0] = "replacement"; return "original";
    } });
    if (behavior === "executable-getter") Object.defineProperty(options, "executable", { get: () => ++reads === 1 ? process.execPath : "relative-replacement" });
    if (behavior === "argv-getter") Object.defineProperty(options, "argv", { get: () => ++reads === 1 ? expectedArgv : "replacement" });
    if (behavior === "element-getter") Object.defineProperty(options.argv, "0", { get: () => ++reads === 1 ? expectedArgv[0] : "replacement" });
    const child = new ChildProcess();
    let launched!: () => void;
    const launch = new Promise<void>(resolve => { launched = resolve; });
    const spawn = vi.spyOn(childProcess, "spawn").mockImplementation(() => { launched(); return child; });
    syncBuiltinESMExports();
    try {
      const running = session.run(options);
      expect(spawn).not.toHaveBeenCalled();
      if (behavior === "after-snapshot") {
        options.executable = "relative-replacement";
        options.argv.fill("replacement");
        options.env.VALUE = "replacement";
        options.timeoutMs = 0;
      }
      await launch;
      expect(spawn).toHaveBeenCalledExactlyOnceWith(process.execPath, expectedArgv, {
        cwd: session.workspacePath, env: { VALUE: "original" }, shell: false, detached: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
      if (behavior !== "after-snapshot") expect(reads).toBe(1);
      child.emit("spawn"); child.emit("exit", 0, null); child.emit("close", 0, null);
      expect((await running).directChildSettled).toBe(true);
      await expect(session.run(nodeOptions("echo"))).rejects.toThrow("Cannot run");
    } finally {
      child.emit("exit", 0, null); child.emit("close", 0, null);
      spawn.mockRestore(); syncBuiltinESMExports();
    }
  }));
  it("reads every top-level property once without freezing caller input", async () => fixtureTest(async f => {
    const session = await f.create();
    const base = nodeOptions("echo");
    const reads = { executable: 0, argv: 0, env: 0, timeoutMs: 0 };
    const options = {
      get executable() { reads.executable++; return base.executable; },
      get argv() { reads.argv++; return base.argv; },
      get env() { reads.env++; return base.env; },
      get timeoutMs() { reads.timeoutMs++; return 5000; },
    };
    expect((await session.run(options)).exitCode).toBe(0);
    expect(reads).toEqual({ executable: 1, argv: 1, env: 1, timeoutMs: 1 });
    expect(Object.isFrozen(options)).toBe(false);
    expect(Object.isFrozen(base.argv)).toBe(false);
    expect(Object.isFrozen(base.env)).toBe(false);
  }));
  it.each(["property-throw", "element-throw", "iterator-throw", "env-throw", "element-nonstring", "element-nul", "iterator-nul", "relative-first", "array-like"] as const)("restores ready after invalid or throwing input: %s", async behavior => fixtureTest(async f => {
    const session = await f.create();
    const base = nodeOptions("echo");
    const options = { ...base, argv: [...base.argv], env: {} };
    const fail = (): never => { throw new Error("synthetic input exception"); };
    if (behavior === "property-throw") Object.defineProperty(options, "executable", { get: fail });
    if (behavior === "element-throw") Object.defineProperty(options.argv, "0", { get: fail });
    if (behavior === "iterator-throw") Object.defineProperty(options.argv, Symbol.iterator, { value: fail });
    if (behavior === "env-throw") Object.defineProperty(options.env, "VALUE", { enumerable: true, get: fail });
    if (behavior === "element-nonstring") Object.defineProperty(options.argv, "0", { get: () => 17 });
    if (behavior === "element-nul") Object.defineProperty(options.argv, "0", { get: () => "\0" });
    if (behavior === "iterator-nul") Object.defineProperty(options.argv, Symbol.iterator, { value: function* () { yield "\0"; } });
    if (behavior === "relative-first") {
      let reads = 0;
      Object.defineProperty(options, "executable", { get: () => ++reads === 1 ? "node" : process.execPath });
    }
    if (behavior === "array-like") Object.defineProperty(options, "argv", { get: () => ({ 0: "argument", length: 1 }) });
    const spawn = vi.spyOn(childProcess, "spawn");
    syncBuiltinESMExports();
    try {
      const attempt = session.run(options);
      if (behavior.endsWith("throw")) await expect(attempt).rejects.toMatchObject({
        message: "Cannot snapshot command options", cause: { message: "synthetic input exception" },
      });
      else await expect(attempt).rejects.toThrow();
      expect(spawn).not.toHaveBeenCalled();
      expect(session.inspect().state).toBe("ready");
      expect((await session.run(nodeOptions("echo"))).exitCode).toBe(0);
      expect(spawn).toHaveBeenCalledTimes(1);
    } finally { spawn.mockRestore(); syncBuiltinESMExports(); }
  }));
  it.each([
    ["run", false], ["discard", false], ["run", true], ["discard", true],
  ] as const)("locks before reentrant %s; throwing getter=%s", async (operation, throws) => fixtureTest(async f => {
    const session = await f.create();
    const child = new ChildProcess();
    const kill = vi.spyOn(child, "kill").mockReturnValue(true);
    let launched!: () => void;
    const launch = new Promise<void>(resolve => { launched = resolve; });
    const spawn = vi.spyOn(childProcess, "spawn").mockImplementation(() => { launched(); return child; });
    syncBuiltinESMExports();
    vi.useFakeTimers();
    const nested: Promise<void>[] = [];
    const options = { ...nodeOptions("wait"), timeoutMs: 100, env: {
      get VALUE() {
        expect(session.inspect().state).toBe("running");
        expect(spawn).not.toHaveBeenCalled();
        nested.push(expect(operation === "run" ? session.run(nodeOptions("echo")) : session.discard()).rejects.toThrow("Cannot"));
        if (throws) throw new Error("synthetic reentrant input failure");
        return "fixed";
      },
    } };
    try {
      let running = session.run(options);
      if (throws) {
        await expect(running).rejects.toThrow("Cannot snapshot command options");
        expect(session.inspect().state).toBe("ready");
        expect(spawn).not.toHaveBeenCalled();
        running = session.run({ ...nodeOptions("wait"), timeoutMs: 100 });
      }
      await Promise.all(nested);
      await launch;
      expect(spawn).toHaveBeenCalledTimes(1);
      child.emit("spawn");
      await expect(session.discard()).rejects.toThrow("Cannot discard");
      await vi.advanceTimersByTimeAsync(6100);
      expect((await running).directChildSettled).toBe(false);
      expect(session.inspect().state).toBe("child-unsettled");
      expect((await session.discard()).status).toBe("refused");
      child.emit("exit", null, "SIGKILL");
      expect(session.inspect().state).toBe("finished");
      expect(child.listenerCount("exit")).toBe(0);
      expect(child.listenerCount("error")).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
      await expect(session.run(nodeOptions("echo"))).rejects.toThrow("Cannot run");
      expect((await session.discard()).status).toBe("removed");
    } finally {
      child.emit("exit", null, "SIGKILL"); child.emit("close", null, "SIGKILL");
      vi.useRealTimers(); kill.mockRestore(); spawn.mockRestore(); syncBuiltinESMExports();
    }
  }));
  it("rejects sparse argv before spawn without consuming the attempt", async () => fixtureTest(async f => {
    const session = await f.create();
    const spawn = vi.spyOn(childProcess, "spawn");
    syncBuiltinESMExports();
    try {
      await expect(session.run({ ...nodeOptions("echo"), argv: new Array<string>(1) })).rejects.toThrow("Invalid command arguments");
      expect(spawn).not.toHaveBeenCalled();
      expect(session.inspect().state).toBe("ready");
      expect((await session.run(nodeOptions("echo"))).exitCode).toBe(0);
      expect(spawn).toHaveBeenCalledTimes(1);
    } finally { spawn.mockRestore(); syncBuiltinESMExports(); }
  }));
  it.each(["normal", "failed-spawn", "drain-expiry", "unsettled"] as const)("disposes listeners and timers: %s", async behavior => fixtureTest(async f => {
    const session = await f.create();
    const child = new ChildProcess();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    child.stdout = stdout;
    child.stderr = stderr;
    const streamsClosed = Promise.all([stdout, stderr].map(stream => new Promise<void>(resolve => stream.once("close", resolve))));
    const kill = vi.spyOn(child, "kill").mockReturnValue(true);
    let launched!: () => void;
    const launch = new Promise<void>(resolve => { launched = resolve; });
    const spawn = vi.spyOn(childProcess, "spawn").mockImplementation(() => { launched(); return child; });
    syncBuiltinESMExports();
    vi.useFakeTimers();
    try {
      const running = session.run({ ...nodeOptions("wait"), timeoutMs: 100 });
      await launch;
      if (behavior === "failed-spawn") child.emit("error", new Error("synthetic spawn failure"));
      else {
        child.emit("spawn");
        if (behavior === "normal") {
          const ended = Promise.all([stdout, stderr].map(stream => new Promise<void>(resolve => stream.once("end", resolve))));
          stdout.end(Buffer.from([0, 255]));
          stderr.end();
          await ended;
          child.emit("exit", 0, null);
          child.emit("close", 0, null);
        } else if (behavior === "drain-expiry") child.emit("exit", 0, null);
      }
      if (behavior === "drain-expiry" || behavior === "unsettled") await vi.advanceTimersByTimeAsync(behavior === "unsettled" ? 6100 : 1000);
      const result = await running;
      await streamsClosed;
      expect(vi.getTimerCount()).toBe(0);
      for (const stream of [stdout, stderr]) {
        for (const event of ["data", "end", "error", "close"]) expect(stream.listenerCount(event)).toBe(0);
      }
      expect(result.stdout.complete).toBe(behavior === "normal");
      expect(result.directChildSettled).toBe(behavior !== "unsettled");
      expect(child.listenerCount("spawn")).toBe(0);
      expect(child.listenerCount("close")).toBe(0);
      if (behavior === "unsettled") {
        expect(child.listenerCount("exit")).toBe(1);
        expect(child.listenerCount("error")).toBe(1);
        expect((await session.discard()).status).toBe("refused");
        child.emit("error", new Error("late termination error"));
        child.emit("exit", null, "SIGKILL");
        expect(session.inspect().state).toBe("finished");
        expect(result.directChildSettled).toBe(false);
      }
      expect(child.listenerCount("exit")).toBe(0);
      expect(child.listenerCount("error")).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
      expect((await session.discard()).status).toBe("removed");
    } finally {
      child.emit("exit", null, "SIGKILL");
      stdout.destroy(); stderr.destroy();
      vi.useRealTimers();
      spawn.mockRestore(); kill.mockRestore(); syncBuiltinESMExports();
    }
  }));
  it("passes exact argv, clone cwd and only explicit environment", async () => fixtureTest(async f => {
    const session = await f.create();
    const argv = ["a b", "$(touch forbidden)", "; echo x", "*", "", "--flag"];
    const result = await session.run(nodeOptions("echo", argv, { TWIN_VALUE: "explicit" }));
    expect(result.outcome).toBe("exited");
    expect(result.exitCode).toBe(0);
    expect(result.started).toBe(true);
    expect(result.directChildSettled).toBe(true);
    expect(result.stdout.complete).toBe(true);
    expect(JSON.parse(Buffer.from(result.stdout.bytes).toString())).toEqual({ argv, cwd: session.workspacePath, env: { TWIN_VALUE: "explicit" } });
  }));
  it("inherits stdio when explicitly selected and reports no captured output", async () => fixtureTest(async f => {
    const session = await f.create();
    const child = new ChildProcess();
    let launched!: () => void;
    const launch = new Promise<void>(resolve => { launched = resolve; });
    const spawn = vi.spyOn(childProcess, "spawn").mockImplementation(() => { launched(); return child; });
    syncBuiltinESMExports();
    try {
      const running = session.run({ ...nodeOptions("echo"), stdio: "inherit" });
      await launch;
      expect(spawn).toHaveBeenCalledWith(process.execPath, expect.any(Array), expect.objectContaining({
        cwd: session.workspacePath, shell: false, detached: false, stdio: ["inherit", "inherit", "inherit"],
      }));
      child.emit("spawn"); child.emit("exit", 0, null); child.emit("close", 0, null);
      const result = await running;
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toEqual({ bytes: new Uint8Array(), complete: false, truncated: false, error: null });
      expect(result.stderr).toEqual({ bytes: new Uint8Array(), complete: false, truncated: false, error: null });
    } finally {
      child.emit("exit", 0, null); child.emit("close", 0, null);
      spawn.mockRestore(); syncBuiltinESMExports();
    }
  }));
  it.each(["exit", "signal"] as const)("records %s", async behavior => fixtureTest(async f => {
    const result = await (await f.create()).run(nodeOptions(behavior));
    expect(result.outcome).toBe("exited");
    expect(result.exitCode).toBe(behavior === "exit" ? 7 : null);
    expect(result.signal).toBe(behavior === "signal" ? "SIGTERM" : null);
    expect(result.directChildSettled).toBe(true);
  }));
  it("records spawn failure without fabricating complete output", async () => fixtureTest(async f => {
    const session = await f.create();
    const result = await session.run({ executable: join(f.path, "missing-executable"), argv: [], env: {} });
    expect(result.outcome).toBe("spawn-failed");
    expect(result.started).toBe(false);
    expect(result.spawnError).toContain("ENOENT");
    expect(result.stdout.complete).toBe(false);
    expect(result.directChildSettled).toBe(true);
    await expect(session.run(nodeOptions("echo"))).rejects.toThrow("Cannot run");
  }));
  it("bounds binary output while draining; exact cap is complete", async () => fixtureTest(async f => {
    const result = await (await f.create()).run(nodeOptions("binary"));
    expect(result.exitCode).toBe(0);
    expect(result.stdout.bytes.length).toBe(65536);
    expect(result.stdout.bytes.every(byte => byte === 255)).toBe(true);
    expect(result.stderr.bytes.length).toBe(65536);
    expect(result.stderr.bytes.every(byte => byte === 128)).toBe(true);
    expect(result.stdout.truncated).toBe(true);
    expect(result.stdout.complete).toBe(false);
    expect(result.stderr.truncated).toBe(false);
    expect(result.stderr.complete).toBe(true);
  }));
  it.each(["wait", "stubborn"] as const)("times out and settles direct child: %s", async behavior => fixtureTest(async f => {
    const session = await f.create();
    const result = await session.run({ ...nodeOptions(behavior), timeoutMs: 500 });
    expect(result.outcome).toBe("timed-out");
    expect(result.signal).toBe(behavior === "stubborn" ? "SIGKILL" : "SIGTERM");
    expect(result.directChildSettled).toBe(true);
    if (behavior === "stubborn") expect(Buffer.from(result.stdout.bytes).toString()).toBe("ready");
    expect(session.inspect().state).toBe("finished");
  }));
  it("rejects invalid input without consuming the execution attempt", async () => fixtureTest(async f => {
    const session = await f.create();
    for (const options of [
      { ...nodeOptions("echo"), executable: "node" },
      { ...nodeOptions("echo"), timeoutMs: 0 },
      { ...nodeOptions("echo"), timeoutMs: 3600001 },
      { ...nodeOptions("echo"), argv: ["\0"] },
      { ...nodeOptions("echo"), env: { "BAD=KEY": "value" } },
    ]) await expect(session.run(options)).rejects.toThrow();
    expect(session.inspect().state).toBe("ready");
    expect((await session.run(nodeOptions("echo"))).exitCode).toBe(0);
  }));
  it.each(["unsettled", "open-pipes"] as const)("bounds %s without inventing settlement or completeness", async behavior => fixtureTest(async f => {
    const session = await f.create();
    // No OS process: exercise impossible-to-force settlement/pipe event order.
    const child = new ChildProcess();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    const kill = vi.spyOn(child, "kill").mockReturnValue(true);
    let launched!: () => void;
    const launch = new Promise<void>(resolve => { launched = resolve; });
    const spawn = vi.spyOn(childProcess, "spawn").mockImplementation(() => { launched(); return child; });
    syncBuiltinESMExports();
    vi.useFakeTimers();
    try {
      const running = session.run({ ...nodeOptions("wait"), timeoutMs: 100 });
      await launch;
      child.emit("spawn");
      if (behavior === "open-pipes") child.emit("exit", 0, null);
      await vi.advanceTimersByTimeAsync(behavior === "unsettled" ? 6100 : 1000);
      const result = await running;
      expect(result.stdout.complete).toBe(false);
      if (behavior === "unsettled") {
        expect(kill.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]]);
        expect(result.directChildSettled).toBe(false);
        expect(session.inspect().state).toBe("child-unsettled");
        expect((await session.discard()).status).toBe("refused");
        child.emit("exit", null, "SIGKILL");
        expect(session.inspect().state).toBe("finished");
      } else {
        expect(result.directChildSettled).toBe(true);
        expect(result.exitCode).toBe(0);
        expect(kill).not.toHaveBeenCalled();
      }
    } finally {
      child.emit("exit", null, "SIGKILL");
      vi.useRealTimers();
      spawn.mockRestore();
      kill.mockRestore();
      syncBuiltinESMExports();
    }
  }));
});
