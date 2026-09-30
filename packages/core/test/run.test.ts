import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import childProcess, { ChildProcess } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { getEventListeners } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { fixtureTest, nodeOptions, type Fixture } from "./support.js";

async function waitForTestFile(path: string, limitMs = 2500): Promise<string> {
  for (let elapsed = 0; elapsed < limitMs; elapsed += 25) {
    try { return await readFile(path, "utf8"); }
    catch (error: unknown) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    await delay(25);
  }
  throw new Error(`Test process did not become ready: ${path}`);
}

async function waitForTestProcessStop(pid: number, limitMs = 8500): Promise<void> {
  for (let elapsed = 0; elapsed < limitMs; elapsed += 25) {
    try { process.kill(pid, 0); }
    catch (error: unknown) {
      if (error instanceof Error && "code" in error && error.code === "ESRCH") return;
      throw error;
    }
    await delay(25);
  }
  throw new Error(`Test process ${pid} did not stop; retaining its fixture`);
}

async function finishLifecycleTest(f: Fixture, session: Fixture["sessions"][number], running: Promise<unknown>): Promise<void> {
  try {
    await Promise.race([running, delay(9000, undefined, { ref: false }).then(() => { throw new Error("Runner did not settle"); })]);
    const pid = Number(await readFile(join(session.workspacePath, "descendant.pid"), "utf8"));
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("Descendant PID is missing or invalid");
    await waitForTestProcessStop(pid);
  } catch (error: unknown) {
    const index = f.sessions.indexOf(session);
    if (index >= 0) f.sessions.splice(index, 1); // Leave the Twin root for inspection when process settlement is uncertain.
    throw new Error(`Lifecycle test cleanup could not verify stopped processes; retained fixture ${f.path}`, { cause: error });
  }
}

function mockAbsentGroup(child: ChildProcess): ReturnType<typeof vi.spyOn> {
  Object.defineProperty(child, "pid", { value: 1000000 });
  return vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
    expect(pid).toBe(-1000000);
    if (signal === 0) throw Object.assign(new Error("gone"), { code: "ESRCH" });
    return true;
  });
}

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
    const group = mockAbsentGroup(child);
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
        cwd: session.workspacePath, env: { VALUE: "original" }, shell: false, detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      if (behavior !== "after-snapshot") expect(reads).toBe(1);
      child.emit("spawn"); child.emit("exit", 0, null); child.emit("close", 0, null);
      expect((await running).directChildSettled).toBe(true);
      expect(session.inspect().receipt?.command).toMatchObject({ admitted: true, processStart: "confirmed",
        executable: { status: "allowlisted-basename", value: "node" },
        arguments: { status: "omitted", count: expectedArgv.length, capped: false } });
      expect(session.inspect().receipt?.process).toEqual({ coverage: "top-level-process-group", escapedDescendants: "not-observed",
        directChild: { start: "confirmed", settlement: "observed" }, groupAfterDirectExit: "absent",
        termination: [], finalGroup: "absent", capturedPipes: "closed" });
      await expect(session.run(nodeOptions("echo"))).rejects.toThrow("Cannot run");
    } finally {
      child.emit("exit", 0, null); child.emit("close", 0, null);
      spawn.mockRestore(); group.mockRestore(); syncBuiltinESMExports();
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
    const group = mockAbsentGroup(child);
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
      vi.useRealTimers(); kill.mockRestore(); spawn.mockRestore(); group.mockRestore(); syncBuiltinESMExports();
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
    const group = mockAbsentGroup(child);
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
      if (behavior === "drain-expiry") {
        expect((await session.discard()).status).toBe("refused");
        stdout.end(); stderr.end();
        await streamsClosed;
        child.emit("close", 0, null);
      }
      if (behavior === "unsettled") {
        stdout.end(); stderr.end();
        await streamsClosed;
      }
      if (behavior === "normal" || behavior === "failed-spawn") await streamsClosed;
      for (const stream of [stdout, stderr]) {
        for (const event of ["data", "end", "error", "close"]) expect(stream.listenerCount(event)).toBe(0);
      }
      expect(result.stdout.complete).toBe(behavior === "normal");
      expect(result.directChildSettled).toBe(behavior !== "unsettled");
      expect(child.listenerCount("spawn")).toBe(0);
      expect(child.listenerCount("close")).toBe(behavior === "unsettled" ? 1 : 0);
      if (behavior === "unsettled") {
        expect(child.listenerCount("exit")).toBe(1);
        expect(child.listenerCount("error")).toBe(1);
        expect((await session.discard()).status).toBe("refused");
        child.emit("error", new Error("late termination error"));
        child.emit("exit", null, "SIGKILL");
        child.emit("close", null, "SIGKILL");
        expect(session.inspect().state).toBe("finished");
        expect(result.directChildSettled).toBe(false);
      }
      expect(child.listenerCount("exit")).toBe(0);
      expect(child.listenerCount("error")).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
      expect((await session.discard()).status).toBe("removed");
    } finally {
      stdout.end(); stderr.end();
      child.emit("exit", null, "SIGKILL"); child.emit("close", null, "SIGKILL");
      stdout.destroy(); stderr.destroy();
      vi.useRealTimers();
      spawn.mockRestore(); kill.mockRestore(); group.mockRestore(); syncBuiltinESMExports();
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
  it.each(["cooperative", "stubborn"] as const)("settles an ordinary %s descendant holding captured pipes", async behavior => fixtureTest(async f => {
    const session = await f.create();
    const descendantScript = [
      'const fs=require("node:fs");',
      ...(behavior === "stubborn" ? ['process.on("SIGTERM",()=>fs.writeFileSync("descendant.term","1"));'] : []),
      'setTimeout(()=>{fs.writeFileSync("descendant.self-exit","1");process.exit(3)},7000);',
      'fs.writeFileSync("descendant.ready",String(process.pid));',
    ].join("");
    const script = [
      'const fs=require("node:fs");const {spawn}=require("node:child_process");',
      `const descendant=spawn(process.execPath,["-e",${JSON.stringify(descendantScript)}],{stdio:["ignore","inherit","inherit"]});`,
      'fs.writeFileSync("descendant.pid",String(descendant.pid));',
      'descendant.unref();const deadline=Date.now()+2000;',
      'const ready=()=>{if(fs.existsSync("descendant.ready")){process.stdout.write("direct\\n");return}',
      'if(Date.now()>deadline)process.exit(4);else setTimeout(ready,10)};ready();',
    ].join("");
    const running = session.run({ executable: process.execPath, argv: ["-e", script], env: {}, timeoutMs: 4000 });
    try {
      const pid = Number(await waitForTestFile(join(session.workspacePath, "descendant.ready")));
      const result = await running;
      expect(result.directChildSettled).toBe(true);
      expect(result.lifecycleIssue).toBeUndefined();
      expect(result.stdout.complete).toBe(true);
      expect(Buffer.from(result.stdout.bytes).toString()).toBe("direct\n");
      if (behavior === "stubborn") {
        expect(await readFile(join(session.workspacePath, "descendant.term"), "utf8")).toBe("1");
        await expect(readFile(join(session.workspacePath, "descendant.self-exit"))).rejects.toMatchObject({ code: "ENOENT" });
      }
      expect(session.inspect().receipt?.process).toMatchObject({
        directChild: { start: "confirmed", settlement: "observed" }, groupAfterDirectExit: "present",
        finalGroup: "absent", capturedPipes: "closed",
        termination: behavior === "stubborn"
          ? [{ signal: "SIGTERM", target: "process-group", delivery: "sent" },
            { signal: "SIGKILL", target: "process-group", delivery: "sent" }]
          : [{ signal: "SIGTERM", target: "process-group", delivery: "sent" }],
      });
      await waitForTestProcessStop(pid);
    } finally {
      await finishLifecycleTest(f, session, running);
    }
  }), 25000);
  it.each(["timeout", "interrupt"] as const)("escalates %s across an ordinary process group", async behavior => fixtureTest(async f => {
    const session = await f.create();
    const controller = new AbortController();
    const stubborn = [
      'const fs=require("node:fs");',
      'process.on("SIGTERM",()=>fs.writeFileSync("descendant.term","1"));',
      'setTimeout(()=>{fs.writeFileSync("descendant.self-exit","1");process.exit(3)},7000);',
      'fs.writeFileSync("descendant.ready",String(process.pid));',
    ].join("");
    const script = [
      'const fs=require("node:fs");const {spawn}=require("node:child_process");',
      `const descendant=spawn(process.execPath,["-e",${JSON.stringify(stubborn)}],{stdio:["ignore","inherit","inherit"]});`,
      'fs.writeFileSync("descendant.pid",String(descendant.pid));descendant.unref();',
      'process.on("SIGTERM",()=>fs.writeFileSync("parent.term","1"));',
      'setTimeout(()=>{fs.writeFileSync("parent.self-exit","1");process.exit(3)},7000);',
      'const deadline=Date.now()+2000;',
      'const ready=()=>{if(fs.existsSync("descendant.ready")){fs.writeFileSync("parent.ready","1");return}',
      'if(Date.now()>deadline)process.exit(4);else setTimeout(ready,10)};ready();',
    ].join("");
    const running = session.run({ executable: process.execPath, argv: ["-e", script], env: {}, timeoutMs: behavior === "timeout" ? 1500 : 5000,
      interruptSignal: controller.signal });
    try {
      await waitForTestFile(join(session.workspacePath, "descendant.ready"));
      await waitForTestFile(join(session.workspacePath, "parent.ready"));
      if (behavior === "interrupt") controller.abort("SIGTERM");
      const result = await running;
      const pid = Number(await readFile(join(session.workspacePath, "descendant.pid"), "utf8"));
      expect(result.outcome).toBe(behavior === "timeout" ? "timed-out" : "exited");
      expect(result.directChildSettled).toBe(true);
      expect(result.signal).toBe("SIGKILL");
      expect(result.exitCode).toBeNull();
      expect(result.lifecycleIssue).toBeUndefined();
      expect(session.inspect().receipt?.process).toMatchObject({
        directChild: { start: "confirmed", settlement: "observed" }, finalGroup: "absent",
        termination: [{ signal: "SIGTERM", target: "process-group", delivery: "sent" },
          { signal: "SIGKILL", target: "process-group", delivery: "sent" }],
      });
      expect(result.stdout.complete).toBe(true);
      expect(await readFile(join(session.workspacePath, "parent.term"), "utf8")).toBe("1");
      expect(await readFile(join(session.workspacePath, "descendant.term"), "utf8")).toBe("1");
      await expect(readFile(join(session.workspacePath, "parent.self-exit"))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(readFile(join(session.workspacePath, "descendant.self-exit"))).rejects.toMatchObject({ code: "ENOENT" });
      await waitForTestProcessStop(pid);
    } finally {
      controller.abort("SIGTERM");
      await finishLifecycleTest(f, session, running);
    }
  }), 25000);
  it("retains an escaped writer's workspace until its captured pipe closes", async () => fixtureTest(async f => {
    const session = await f.create();
    const script = [
      'const fs=require("node:fs");const {spawn}=require("node:child_process");',
      'const descendant=spawn(process.execPath,["-e","setTimeout(()=>process.exit(0),2500)"],',
      '{detached:true,stdio:["ignore","inherit","inherit"]});',
      'fs.writeFileSync("descendant.pid",String(descendant.pid));descendant.unref();',
      'process.stdout.write("direct\\n");',
    ].join("");
    const result = await session.run({ executable: process.execPath, argv: ["-e", script], env: {}, timeoutMs: 5000 });
    const pid = Number(await readFile(join(session.workspacePath, "descendant.pid"), "utf8"));
    expect(result.directChildSettled).toBe(true);
    expect(result.lifecycleIssue).toBe("stdio pipes remain open");
    expect(session.inspect().receipt?.process).toMatchObject({ groupAfterDirectExit: "absent",
      finalGroup: "absent", capturedPipes: "open", termination: [] });
    expect(result.stdout.complete).toBe(false);
    expect(session.inspect().state).toBe("child-unsettled");
    expect((await session.discard()).status).toBe("refused");
    let stopped = false;
    for (let attempt = 0; attempt < 120; attempt++) {
      try { process.kill(pid, 0); }
      catch (error: unknown) {
        if (error instanceof Error && "code" in error && error.code === "ESRCH") { stopped = true; break; }
        throw error;
      }
      await delay(50);
    }
    expect(stopped).toBe(true);
    for (let attempt = 0; attempt < 40 && session.inspect().state !== "finished"; attempt++) await delay(50);
    expect(session.inspect().state).toBe("finished");
    expect((await session.discard()).status).toBe("removed");
  }));
  it.each(["present", "unknown", "failed-delivery"] as const)("retains the workspace while process-group check is %s", async groupCheck => fixtureTest(async f => {
    const session = await f.create();
    const child = new ChildProcess();
    Object.defineProperty(child, "pid", { value: 1000000 });
    let groupPresent = true;
    const probe = vi.spyOn(process, "kill").mockImplementation((pid, requested) => {
      expect(pid).toBe(-1000000);
      if (requested === 0 && !groupPresent) throw Object.assign(new Error("gone"), { code: "ESRCH" });
      if (requested === 0 && groupCheck === "unknown") throw Object.assign(new Error("unreadable"), { code: "EPERM" });
      if (requested !== 0 && groupCheck === "failed-delivery") throw Object.assign(new Error("refused signal"), { code: "EPERM" });
      return true;
    });
    let launched!: () => void;
    const launch = new Promise<void>(resolve => { launched = resolve; });
    const spawn = vi.spyOn(childProcess, "spawn").mockImplementation(() => { launched(); return child; });
    syncBuiltinESMExports();
    vi.useFakeTimers();
    try {
      const running = session.run(nodeOptions("wait"));
      await launch;
      child.emit("spawn"); child.emit("exit", 0, null); child.emit("close", 0, null);
      await vi.advanceTimersByTimeAsync(6000);
      const result = await running;
      expect(result.lifecycleIssue).toBe(`process group ${groupCheck === "failed-delivery" ? "present" : groupCheck}`);
      if (groupCheck === "failed-delivery") expect(result.terminationError).toBe("refused signal");
      expect(session.inspect().receipt?.command).toMatchObject({ admitted: true, processStart: "confirmed",
        disposition: "settlement-uncertain", directChildSettled: true, exitCode: 0 });
      expect(session.inspect().receipt?.process).toMatchObject({
        groupAfterDirectExit: groupCheck === "failed-delivery" ? "present" : groupCheck,
        finalGroup: groupCheck === "failed-delivery" ? "present" : groupCheck,
        termination: [{ signal: "SIGTERM", target: "process-group", delivery: groupCheck === "failed-delivery" ? "failed" : "sent" },
          { signal: "SIGKILL", target: "process-group", delivery: groupCheck === "failed-delivery" ? "failed" : "sent" }] });
      expect(session.inspect().state).toBe("child-unsettled");
      expect((await session.discard()).status).toBe("refused");
      groupPresent = false;
      await vi.advanceTimersByTimeAsync(100);
      expect(session.inspect().state).toBe("finished");
      expect((await session.discard()).status).toBe("removed");
    } finally {
      groupPresent = false;
      child.emit("exit", 0, null); child.emit("close", 0, null);
      vi.useRealTimers(); spawn.mockRestore(); probe.mockRestore(); syncBuiltinESMExports();
    }
  }));
  it("inherits stdio when explicitly selected and reports no captured output", async () => fixtureTest(async f => {
    const session = await f.create();
    const child = new ChildProcess();
    const group = mockAbsentGroup(child);
    let launched!: () => void;
    const launch = new Promise<void>(resolve => { launched = resolve; });
    const spawn = vi.spyOn(childProcess, "spawn").mockImplementation(() => { launched(); return child; });
    syncBuiltinESMExports();
    try {
      const running = session.run({ ...nodeOptions("echo"), stdio: "inherit" });
      await launch;
      expect(spawn).toHaveBeenCalledWith(process.execPath, expect.any(Array), expect.objectContaining({
        cwd: session.workspacePath, shell: false, detached: true, stdio: ["inherit", "inherit", "inherit"],
      }));
      child.emit("spawn"); child.emit("exit", 0, null); child.emit("close", 0, null);
      const result = await running;
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toEqual({ bytes: new Uint8Array(), complete: false, truncated: false, error: null });
      expect(result.stderr).toEqual({ bytes: new Uint8Array(), complete: false, truncated: false, error: null });
      expect(session.inspect().receipt?.process.capturedPipes).toBe("not-captured");
    } finally {
      child.emit("exit", 0, null); child.emit("close", 0, null);
      spawn.mockRestore(); group.mockRestore(); syncBuiltinESMExports();
    }
  }));
  it.each(["SIGINT", "SIGTERM"] as const)("forwards %s and releases the abort listener", async requested => fixtureTest(async f => {
    const session = await f.create();
    const controller = new AbortController();
    const child = new ChildProcess();
    const group = mockAbsentGroup(child);
    const kill = vi.spyOn(child, "kill").mockReturnValue(true);
    let launched!: () => void;
    const launch = new Promise<void>(resolve => { launched = resolve; });
    const spawn = vi.spyOn(childProcess, "spawn").mockImplementation(() => { launched(); return child; });
    syncBuiltinESMExports();
    try {
      const running = session.run({ ...nodeOptions("wait"), interruptSignal: controller.signal });
      await launch;
      child.emit("spawn");
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(1);
      controller.abort(requested);
      expect(group.mock.calls.filter((call: [number, number | NodeJS.Signals]) => call[1] !== 0)).toEqual([[-1000000, requested]]);
      child.emit("exit", null, requested); child.emit("close", null, requested);
      const result = await running;
      expect(result.signal).toBe(requested);
      expect(result.directChildSettled).toBe(true);
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
      expect((await session.discard()).status).toBe("removed");
    } finally {
      child.emit("exit", null, requested); child.emit("close", null, requested);
      spawn.mockRestore(); kill.mockRestore(); group.mockRestore(); syncBuiltinESMExports();
    }
  }));
  it("does not launch a command interrupted before startup", async () => fixtureTest(async f => {
    const session = await f.create();
    const controller = new AbortController();
    controller.abort("SIGINT");
    const spawn = vi.spyOn(childProcess, "spawn");
    syncBuiltinESMExports();
    try {
      await expect(session.run({ ...nodeOptions("echo"), interruptSignal: controller.signal })).rejects.toThrow("Interrupted before command launch");
      expect(spawn).not.toHaveBeenCalled();
      expect(session.inspect().state).toBe("ready");
    } finally { spawn.mockRestore(); syncBuiltinESMExports(); }
  }));
  it("escalates an uncooperative interrupted child once", async () => fixtureTest(async f => {
    const session = await f.create();
    const controller = new AbortController();
    const child = new ChildProcess();
    const group = mockAbsentGroup(child);
    const kill = vi.spyOn(child, "kill").mockReturnValue(true);
    let launched!: () => void;
    const launch = new Promise<void>(resolve => { launched = resolve; });
    const spawn = vi.spyOn(childProcess, "spawn").mockImplementation(() => { launched(); return child; });
    syncBuiltinESMExports();
    vi.useFakeTimers();
    try {
      const running = session.run({ ...nodeOptions("wait"), interruptSignal: controller.signal });
      await launch;
      child.emit("spawn");
      controller.abort("SIGTERM");
      controller.abort("SIGINT");
      expect(group.mock.calls.filter((call: [number, number | NodeJS.Signals]) => call[1] !== 0)).toEqual([[-1000000, "SIGTERM"]]);
      await vi.advanceTimersByTimeAsync(1000);
      expect(group.mock.calls.filter((call: [number, number | NodeJS.Signals]) => call[1] !== 0)).toEqual([[-1000000, "SIGTERM"], [-1000000, "SIGKILL"]]);
      child.emit("exit", null, "SIGKILL"); child.emit("close", null, "SIGKILL");
      expect((await running).directChildSettled).toBe(true);
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      child.emit("exit", null, "SIGKILL"); child.emit("close", null, "SIGKILL");
      vi.useRealTimers(); spawn.mockRestore(); kill.mockRestore(); group.mockRestore(); syncBuiltinESMExports();
    }
  }));
  it("refuses discard until interrupted child settlement is observed", async () => fixtureTest(async f => {
    const session = await f.create();
    const controller = new AbortController();
    const child = new ChildProcess();
    const group = mockAbsentGroup(child);
    const kill = vi.spyOn(child, "kill").mockReturnValue(true);
    let launched!: () => void;
    const launch = new Promise<void>(resolve => { launched = resolve; });
    const spawn = vi.spyOn(childProcess, "spawn").mockImplementation(() => { launched(); return child; });
    syncBuiltinESMExports();
    vi.useFakeTimers();
    try {
      const running = session.run({ ...nodeOptions("wait"), interruptSignal: controller.signal });
      await launch;
      child.emit("spawn");
      controller.abort("SIGINT");
      await vi.advanceTimersByTimeAsync(6000);
      const result = await running;
      expect(result.directChildSettled).toBe(false);
      expect(result.terminationError).toBe("Direct child exit remains unconfirmed");
      expect(session.inspect().state).toBe("child-unsettled");
      expect((await session.discard()).status).toBe("refused");
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
      child.emit("exit", null, "SIGKILL");
      expect(session.inspect().state).toBe("finished");
      expect((await session.discard()).status).toBe("removed");
    } finally {
      child.emit("exit", null, "SIGKILL"); child.emit("close", null, "SIGKILL");
      vi.useRealTimers(); spawn.mockRestore(); kill.mockRestore(); group.mockRestore(); syncBuiltinESMExports();
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
    expect(session.inspect().receipt?.process).toMatchObject({ directChild: { start: "not-confirmed", settlement: "not-applicable" },
      groupAfterDirectExit: "not-observed", termination: [], finalGroup: "not-applicable", capturedPipes: "not-applicable" });
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
    const group = mockAbsentGroup(child);
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    child.stdout = stdout;
    child.stderr = stderr;
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
        expect(session.inspect().receipt?.process).toMatchObject({ directChild: { start: "confirmed", settlement: "unconfirmed" },
          groupAfterDirectExit: "not-observed", finalGroup: "absent", capturedPipes: "open",
          termination: [{ signal: "SIGTERM", target: "process-group", delivery: "sent" },
            { signal: "SIGKILL", target: "process-group", delivery: "sent" }] });
        expect(session.inspect().receipt?.command).toMatchObject({ disposition: "settlement-uncertain",
          processStart: "confirmed", directChildSettled: false, timeoutObserved: true });
        expect(group.mock.calls.filter((call: [number, number | NodeJS.Signals]) => call[1] !== 0)).toEqual([[-1000000, "SIGTERM"], [-1000000, "SIGKILL"]]);
        expect(result.directChildSettled).toBe(false);
        expect(session.inspect().state).toBe("child-unsettled");
        expect((await session.discard()).status).toBe("refused");
        stdout.end(); stderr.end();
        child.emit("exit", null, "SIGKILL");
        child.emit("close", null, "SIGKILL");
        expect(session.inspect().state).toBe("finished");
      } else {
        expect(session.inspect().receipt?.process).toMatchObject({ groupAfterDirectExit: "absent",
          finalGroup: "absent", capturedPipes: "open", termination: [] });
        expect(result.directChildSettled).toBe(true);
        expect(result.exitCode).toBe(0);
        expect(kill).not.toHaveBeenCalled();
        expect((await session.discard()).status).toBe("refused");
        stdout.end(); stderr.end();
        child.emit("close", 0, null);
        expect(session.inspect().state).toBe("finished");
      }
    } finally {
      stdout.end(); stderr.end();
      child.emit("exit", null, "SIGKILL"); child.emit("close", null, "SIGKILL");
      vi.useRealTimers();
      spawn.mockRestore();
      kill.mockRestore();
      group.mockRestore();
      syncBuiltinESMExports();
    }
  }));
});
