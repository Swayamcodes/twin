import childProcess from "node:child_process";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { RunResult } from "@twin-cli/core";
import { admitSpawn, assertS6Stdout, assertSuccessfulResult, cleanupS6, completeProof, gitEnvironment, ProofFailure, proveTwinS6,
  repository, restoreAll, S6ActionGate, type ActionGateState, type Fault, type Proof } from "./support/twin-s6.js";

async function failure(fault: Fault): Promise<ProofFailure> {
  try { await proveTwinS6(fault); }
  catch (error: unknown) {
    expect(error).toBeInstanceOf(ProofFailure);
    if (error instanceof ProofFailure) return error;
    throw error;
  }
  throw new Error(`Expected ${fault} failure`);
}
function accounted(proof: Proof, sessions: number, nativeActions: number, syntheticActions = 0): void {
  expect(proof.roots).toHaveLength(2);
  expect(proof.allocations).toHaveLength(3);
  expect(proof.acquiredSupportPath).toBe(proof.roots[0]);
  expect(proof.sessions).toHaveLength(sessions);
  expect(proof.twinRoots).toHaveLength(1);
  expect(proof.launches.filter(item => item.phase === "setup")).toHaveLength(7);
  expect(proof.launches.filter(item => item.phase === "action" && item.native)).toHaveLength(nativeActions);
  expect(proof.launches.filter(item => item.phase === "action" && !item.native)).toHaveLength(syntheticActions);
  expect(proof.dispositions).toEqual(proof.allocations.map(path => ({ path, state: "removed" })));
  expect(proof.afterRoots).toEqual(proof.beforeRoots);
  expect(proof.remainingTwinRoots).toEqual([]);
  expect(proof.registeredSupports).toEqual([]);
  expect(proof.events.at(-1)).toBe("root-accounting");
}
function ordered(proof: Proof, ...events: string[]): void {
  const positions = events.map(event => { expect(proof.events).toContain(event); return proof.events.indexOf(event); });
  expect(positions).toEqual([...positions].sort((a, b) => a - b));
}

describe("2.5R-2 fixed Twin S6 product proof", () => {
  it("runs trusted clean only in the complete independent Twin and leaves the original unchanged", async () => {
    const spawn = childProcess.spawn, exec = childProcess.exec, oldPath = process.env.PATH;
    const proof = await proveTwinS6();
    accounted(proof, 1, 1);
    expect(proof.actionAttempts).toBe(1);
    ordered(proof, "original-baseline", "session-returned", "twin-pre-state", "action-returned",
      "twin-post-state-verified", "original-after-action", "discardTwin", "twin-removed",
      "original-after-discard-verified", "cleanupOriginal", "original-removed", "cleanupSupport", "root-accounting");
    expect(proof.result).not.toBeNull();
    assertSuccessfulResult(proof.result!);
    const action = proof.launches.find(item => item.phase === "action")!;
    expect(action.executable.startsWith("/")).toBe(true);
    expect(action.requestedExecutable).toBe(action.executable);
    expect(action.argv).toEqual(["clean", "-fdx"]);
    expect(action.cwd).toBe(proof.sessions[0]);
    expect(action.shell).toBe(false);
    expect(action.env).toEqual(gitEnvironment(action.env.PATH!));
    for (const setup of proof.launches.filter(item => item.phase === "setup")) {
      expect(setup.requestedExecutable).toBe("git");
      expect(setup.executable).toBe(action.executable);
      expect(setup.cwd).toBe(join(proof.roots[1]!, "workspace"));
      expect(setup.env).toEqual(action.env);
    }
    expect(childProcess.spawn).toBe(spawn);
    expect(childProcess.exec).toBe(exec);
    expect(process.env.PATH).toBe(oldPath);
  }, 30_000);

  it.each(["repository", "default-state", "configured-state"] as const)("rejects %s base before allocation", async kind => {
    const allocation = vi.spyOn(fs, "mkdtemp");
    vi.stubEnv("XDG_STATE_HOME", join(homedir(), ".twin-s6-unused-state"));
    vi.stubEnv("TMPDIR", kind === "repository" ? repository : kind === "default-state"
      ? join(homedir(), ".local/state/twin", "..capture-temp") : join(process.env.XDG_STATE_HOME!, "twin", "child"));
    try {
      const rejected = await failure("none");
      expect(String(rejected.errors[0])).toContain("Forbidden supplied temporary base");
      expect(rejected.proof.allocations).toEqual([]);
      expect(rejected.proof.launches).toEqual([]);
      expect(allocation).not.toHaveBeenCalled();
    } finally { allocation.mockRestore(); vi.unstubAllEnvs(); }
  });
  it.each(["trusted-git", "token"] as const)("%s failure precedes allocation and launch", async fault => {
    const allocation = vi.spyOn(fs, "mkdtemp");
    try {
      const rejected = await failure(fault);
      expect(rejected.errors).toHaveLength(1);
      expect(rejected.errors[0]).toMatchObject({ message: `Injected ${fault}` });
      expect(rejected.proof.allocations).toEqual([]);
      expect(rejected.proof.launches).toEqual([]);
      expect(rejected.proof.sessions).toEqual([]);
      expect(allocation).not.toHaveBeenCalled();
    } finally { allocation.mockRestore(); }
  });
  it("copy failure returns no session or action and accounts for the factory allocation", async () => {
    const rejected = await failure("copy");
    accounted(rejected.proof, 0, 0);
    expect(rejected.errors).toHaveLength(1);
    expect(rejected.errors[0]).toMatchObject({ message: expect.stringContaining("Twin copy failed"), cause: { message: "Injected copy" } });
    expect(rejected.proof.events).not.toContain("session-returned");
    expect(rejected.proof.events).toContain("original-removed");
  }, 30_000);
  it("failure after return and before action still discards and checks the original", async () => {
    const rejected = await failure("before-run");
    accounted(rejected.proof, 1, 0);
    expect(rejected.errors).toHaveLength(1);
    expect(rejected.cause).toBe(rejected.errors[0]);
    ordered(rejected.proof, "session-returned", "twin-post-state-verified", "original-after-action",
      "twin-removed", "original-after-discard-verified", "original-removed");
  }, 30_000);
  it("a guard-injected rejection reports spawn failure with zero native destructive forwards", async () => {
    const rejected = await failure("guard-reject");
    accounted(rejected.proof, 1, 0);
    expect(rejected.errors).toHaveLength(1);
    expect(rejected.proof.actionAttempts).toBe(1);
    expect(rejected.proof.result).toMatchObject({ outcome: "spawn-failed", started: false,
      directChildSettled: true, spawnError: "Injected guard-reject" });
    ordered(rejected.proof, "action-returned", "twin-post-state-verified", "original-after-action", "twin-removed", "original-removed");
  }, 30_000);
  it.each(["nonzero", "spawn-failure"] as const)("synthetic %s remains honest and attempts both cleanup paths", async fault => {
    const rejected = await failure(fault);
    accounted(rejected.proof, 1, 0, 1);
    expect(rejected.errors).toHaveLength(1);
    expect(rejected.proof.result).toMatchObject(fault === "nonzero"
      ? { outcome: "exited", started: true, directChildSettled: true, exitCode: 17 }
      : { outcome: "spawn-failed", started: false, directChildSettled: true, spawnError: "Injected spawn-failure" });
    ordered(rejected.proof, "action-returned", "twin-post-state-verified", "original-after-action", "twin-removed", "original-removed");
  }, 30_000);
  it("synthetic unsettled child refuses discard, retains/accounted root, then permits observed late settlement", async () => {
    const rejected = await failure("unsettled");
    accounted(rejected.proof, 1, 0, 1);
    expect(rejected.errors).toHaveLength(2);
    expect(rejected.proof.result).toMatchObject({ outcome: "timed-out", started: true, directChildSettled: false });
    expect(rejected.proof.twinCleanup[0]).toEqual({ status: "refused", reason: "Cannot discard Twin in state child-unsettled" });
    ordered(rejected.proof, "twin-observation-deferred-unsettled", "discardTwin", "original-removed",
      "injected-twin-retention-accounted", "synthetic-late-settlement", "twin-removed", "cleanupSupport");
  }, 30_000);
  it("Twin observation failure cannot skip original checks or either cleanup", async () => {
    const rejected = await failure("twin-observation");
    accounted(rejected.proof, 1, 1);
    expect(rejected.errors).toHaveLength(1);
    expect(rejected.errors[0]).toMatchObject({ message: "Injected twin-observation" });
    ordered(rejected.proof, "twin-post-state", "original-after-action", "twin-removed", "original-after-discard-verified", "original-removed");
  }, 30_000);
  it("original final-observation failure refuses deletion until a fresh real observation", async () => {
    const rejected = await failure("original-observation");
    accounted(rejected.proof, 1, 1);
    expect(rejected.errors).toHaveLength(2);
    expect(rejected.errors[0]).toMatchObject({ message: "Injected original-observation" });
    expect(rejected.proof.originalCleanup[0]?.status).toBe("refused");
    ordered(rejected.proof, "twin-removed", "observeOriginal", "cleanupOriginal",
      "injected-original-retention-accounted", "injected-original-released");
  }, 30_000);
  it("Twin authority refusal preserves independent original cleanup before controlled release", async () => {
    const rejected = await failure("twin-refusal");
    accounted(rejected.proof, 1, 1);
    expect(rejected.errors).toHaveLength(1);
    expect(rejected.proof.twinCleanup[0]?.status).toBe("refused");
    ordered(rejected.proof, "discardTwin", "original-removed", "injected-twin-retention-accounted", "injected-twin-released", "cleanupSupport");
  }, 30_000);
  it("original cleanup refusal preserves Twin accounting and requires a fresh observation", async () => {
    const rejected = await failure("original-refusal");
    accounted(rejected.proof, 1, 1);
    expect(rejected.errors).toHaveLength(1);
    expect(rejected.proof.originalCleanup[0]?.status).toBe("refused");
    ordered(rejected.proof, "twin-removed", "cleanupOriginal", "accountScratch", "injected-original-released", "root-accounting");
  }, 30_000);
});

// All values below are synthetic. The only forwarding destination is a vi.fn.
function syntheticGuard() {
  const policy = Object.freeze({ executable: "/synthetic/git", argv: Object.freeze(["clean", "-fdx"]),
    cwd: "/synthetic/twin/workspace", env: Object.freeze(gitEnvironment("/synthetic")) });
  const input = { command: policy.executable as unknown, argv: [...policy.argv], options: {
    cwd: policy.cwd as string, shell: false, env: { ...policy.env }, detached: false, stdio: ["ignore", "pipe", "pipe"] } };
  const state: ActionGateState = { installed: true, phase: "action", dispatched: true, preStateComplete: true, sessionState: "running" };
  const gate = new S6ActionGate();
  const native = vi.fn<(command: string, argv: string[], options: ReturnType<typeof admitSpawn>["options"]) => void>();
  const forward = (afterCapture: () => void = () => {}) => {
    const captured = gate.admit(input.command, input.argv, input.options, policy, state);
    afterCapture();
    native(captured.executable, captured.argv, captured.options);
    return captured;
  };
  return { policy, input, state, native, forward };
}
describe("S6 synthetic admission, no native execution", () => {
  it("forwards fresh plain snapshots and rejects a second action", () => {
    const s = syntheticGuard();
    const captured = s.forward();
    expect(captured.argv).not.toBe(s.input.argv);
    expect(captured.options).not.toBe(s.input.options);
    expect(captured.options.env).not.toBe(s.input.options.env);
    expect(captured.options.stdio).not.toBe(s.input.options.stdio);
    expect(Object.getPrototypeOf(captured.options)).toBe(Object.prototype);
    expect(Object.getPrototypeOf(captured.options.env)).toBe(Object.prototype);
    expect(() => s.forward()).toThrow("Only one S6 action");
    expect(s.native).toHaveBeenCalledTimes(1);
  });
  it.each(["original", "repository", "support", "scratch", "allocation", "outside", "descendant"])("rejects %s action cwd", name => {
    const s = syntheticGuard();
    s.input.options.cwd = name === "descendant" ? `${s.policy.cwd}/child` : `/synthetic/${name}`;
    expect(() => s.forward()).toThrow();
    expect(s.native).not.toHaveBeenCalled();
  });
  it.each(["flag", "pathspec", "-C", "alternate", "bare-git", "shell", "detached", "stdio", "extra-option", "sparse"])("rejects %s", kind => {
    const s = syntheticGuard();
    if (kind === "flag") s.input.argv.push("-n");
    if (kind === "pathspec") s.input.argv.push("scratch.txt");
    if (kind === "-C") s.input.argv.unshift("-C", s.policy.cwd);
    if (kind === "alternate") s.input.command = "/other/git";
    if (kind === "bare-git") s.input.command = "git";
    if (kind === "shell") s.input.options.shell = true;
    if (kind === "detached") s.input.options.detached = true;
    if (kind === "stdio") s.input.options.stdio[0] = "inherit";
    if (kind === "extra-option") Object.defineProperty(s.input.options, "uid", { value: 0 });
    if (kind === "sparse") s.input.argv = new Array<string>(2);
    expect(() => s.forward()).toThrow(); expect(s.native).not.toHaveBeenCalled();
  });
  it.each(["HOME", "XDG_CONFIG_HOME", "NODE_OPTIONS", "GIT_DIR", "GIT_WORK_TREE", "LD_PRELOAD", "missing", "changed"])("rejects environment %s", key => {
    const s = syntheticGuard();
    if (key === "missing") delete s.input.options.env.LANG;
    else if (key === "changed") s.input.options.env.LANG = "changed";
    else s.input.options.env[key] = "forbidden";
    expect(() => s.forward()).toThrow(); expect(s.native).not.toHaveBeenCalled();
  });
  it.each(["absent", "closed", "setup", "restoring", "no-dispatch", "no-pre-state", "no-session", "ready"])("rejects %s lifecycle", kind => {
    const s = syntheticGuard();
    if (kind === "absent") s.state.installed = false;
    if (kind === "closed" || kind === "setup" || kind === "restoring") s.state.phase = kind;
    if (kind === "no-dispatch") s.state.dispatched = false;
    if (kind === "no-pre-state") s.state.preStateComplete = false;
    if (kind === "no-session") s.state.sessionState = null;
    if (kind === "ready") s.state.sessionState = "ready";
    expect(() => s.forward()).toThrow(); expect(s.native).not.toHaveBeenCalled();
  });
  it.each([true, false])("captures changing argv once, first valid=%s", valid => {
    const s = syntheticGuard(); let reads = 0;
    Object.defineProperty(s.input.argv, Symbol.iterator, { value: () => {
      reads++; return (reads === 1 && valid ? [...s.policy.argv] : ["clean", "-fdx", "bad"])[Symbol.iterator]();
    } });
    if (valid) { s.forward(); expect(s.native.mock.calls[0]?.[1]).toEqual(s.policy.argv); }
    else { expect(() => s.forward()).toThrow(); expect(s.native).not.toHaveBeenCalled(); }
    expect(reads).toBe(1);
  });
  it.each(["cwd", "shell", "env", "detached", "stdio"] as const)("captures changing %s getter once", key => {
    const s = syntheticGuard(); let reads = 0; const good = s.input.options[key];
    Object.defineProperty(s.input.options, key, { get: () => { reads++; return reads === 1 ? good : "changed"; } });
    s.forward(); expect(reads).toBe(1); expect(s.native).toHaveBeenCalledTimes(1);
  });
  it("materializes environment proxies once and ignores later caller mutation", () => {
    const s = syntheticGuard(); const reads = new Map<string, number>();
    s.input.options.env = new Proxy(s.input.options.env, { get: (target, key) => {
      if (typeof key !== "string") return undefined;
      reads.set(key, (reads.get(key) ?? 0) + 1);
      return reads.get(key) === 1 ? target[key] : "changed";
    } });
    const captured = s.forward(() => {
      s.input.command = "/changed/git"; s.input.argv.push("bad"); s.input.options.cwd = "/changed";
      s.input.options.env.NODE_OPTIONS = "bad"; s.input.options.stdio[0] = "inherit";
    });
    expect([...reads.values()].every(count => count === 1)).toBe(true);
    expect(captured.options.env).toEqual(s.policy.env);
    expect(captured.argv).toEqual(s.policy.argv);
    expect(captured.options.cwd).toBe(s.policy.cwd);
  });
  it.each(["argv", "cwd", "env", "env-proxy", "env-entry", "stdio"])("throwing %s rejects without forwarding", site => {
    const s = syntheticGuard(); const injected = new Error("Synthetic accessor failure"); const fail = (): never => { throw injected; };
    if (site === "argv") Object.defineProperty(s.input.argv, Symbol.iterator, { value: fail });
    else if (site === "env-proxy") s.input.options.env = new Proxy(s.input.options.env, { ownKeys: fail });
    else if (site === "env-entry") Object.defineProperty(s.input.options.env, "LANG", { enumerable: true, get: fail });
    else Object.defineProperty(s.input.options, site, { get: fail });
    expect(() => s.forward()).toThrow(injected); expect(s.native).not.toHaveBeenCalled();
  });
});

describe("S6 pure stdout framing, no execution or allocations", () => {
  const env = "Removing .env", modules = "Removing node_modules/", scratch = "Removing scratch.txt";
  const valid = `${env}\n${modules}\n${scratch}\n`;
  it.each([
    [env, modules, scratch], [env, scratch, modules],
    [modules, env, scratch], [modules, scratch, env],
    [scratch, env, modules], [scratch, modules, env],
  ])("accepts exact permutation %s / %s / %s", (first, second, third) => {
    expect(() => assertS6Stdout(`${first}\n${second}\n${third}\n`)).not.toThrow();
  });
  it.each([
    ["missing terminal LF", valid.slice(0, -1)],
    ["extra terminal LF", `${valid}\n`],
    ["blank beginning", `\n${valid}`],
    ["blank middle", `${env}\n\n${modules}\n${scratch}\n`],
    ["blank end", `${env}\n${modules}\n\n`],
    ["duplicate expected line", `${env}\n${modules}\n${modules}\n`],
    ["missing expected line", `${env}\n${modules}\n`],
    ["unexpected extra line", `${valid}Removing other.txt\n`],
    ["leading space", ` ${valid}`],
    ["trailing space", `${env} \n${modules}\n${scratch}\n`],
    ["CRLF", valid.replaceAll("\n", "\r\n")],
    ["stray CR", `${env}\r\n${modules}\n${scratch}\n`],
    ["unterminated final removal line", `${modules}\n${scratch}\n${env}`],
    ["previously accepted malformed framing", "Removing .env\n\nRemoving node_modules/\nRemoving scratch.txt"],
    ["prefix", `unexpected ${valid}`],
    ["suffix", `${env}\n${modules}\n${scratch} unexpected\n`],
    ["partial match", `${env}\n${modules}\nRemoving scratch\n`],
    ["empty output", ""],
  ])("rejects %s", (_name, stdout) => {
    expect(() => assertS6Stdout(stdout)).toThrow();
  });
});

describe("S6 pure RunResult byte decoding, no execution or allocations", () => {
  function result(stdout: Uint8Array, stderr = new Uint8Array()): RunResult {
    return { schemaVersion: 1, outcome: "exited", started: true, directChildSettled: true,
      exitCode: 0, signal: null, spawnError: null, terminationError: null,
      stdout: { bytes: stdout, complete: true, truncated: false, error: null },
      stderr: { bytes: stderr, complete: true, truncated: false, error: null } };
  }
  const valid = new TextEncoder().encode("Removing .env\nRemoving node_modules/\nRemoving scratch.txt\n");
  it("accepts exact stdout bytes and zero-byte stderr", () => {
    expect(() => assertSuccessfulResult(result(valid))).not.toThrow();
  });
  it("rejects BOM-prefixed stdout through exact removal-line comparison", () => {
    const stdout = new Uint8Array([0xef, 0xbb, 0xbf, ...valid]);
    expect(() => assertSuccessfulResult(result(stdout))).toThrow("Unexpected Git stdout");
  });
  it("rejects BOM-only stderr through byte-emptiness assertion", () => {
    expect(() => assertSuccessfulResult(result(valid, new Uint8Array([0xef, 0xbb, 0xbf]))))
      .toThrow("Git stderr must contain zero bytes");
  });
  it("rejects malformed UTF-8 fatally through normal result decoding", () => {
    const stdout = new Uint8Array([0xc3, 0x28, ...valid]);
    expect(() => assertSuccessfulResult(result(stdout))).toThrow(TypeError);
  });
});

describe("S6 synthetic cleanup and restoration failures, no allocations", () => {
  it.each(["discardTwin", "cleanupOriginal"] as const)("%s failure does not skip independent authorities or retry", async failed => {
    const primary = new Error("primary"), secondary = new Error("failed cleanup; partial deletion possible");
    const errors: unknown[] = [primary], events: string[] = [], called: string[] = [];
    const step = (name: string) => async () => { called.push(name); if (name === failed) throw secondary; };
    await cleanupS6({ discardTwin: step("discardTwin"), observeOriginal: step("observeOriginal"),
      cleanupOriginal: step("cleanupOriginal"), accountScratch: step("accountScratch"), cleanupSupport: step("cleanupSupport") }, events, errors);
    expect(called).toEqual(["discardTwin", "observeOriginal", "cleanupOriginal", "accountScratch", "cleanupSupport"]);
    expect(events).toEqual(called); expect(errors).toEqual([primary, secondary]);
  });
  it("restoration errors preserve primary failure and every later restoration/synchronization", () => {
    const primary = new Error("primary"), restoreError = new Error("restore"), syncError = new Error("sync");
    const errors: unknown[] = [primary], calls: string[] = [];
    const originalSpawn = childProcess.spawn, originalExec = childProcess.exec;
    const spawn = vi.spyOn(childProcess, "spawn").mockImplementation(() => { throw new Error("No native execution"); });
    const exec = vi.spyOn(childProcess, "exec").mockImplementation(() => { throw new Error("No native execution"); });
    try {
      syncBuiltinESMExports();
      restoreAll([() => { calls.push("spawn"); spawn.mockRestore(); throw restoreError; },
        () => { calls.push("exec"); exec.mockRestore(); }], errors,
      () => { calls.push("sync"); syncBuiltinESMExports(); throw syncError; });
      expect(calls).toEqual(["spawn", "exec", "sync"]);
      expect(errors).toEqual([primary, restoreError, syncError]);
      expect(childProcess.spawn).toBe(originalSpawn); expect(childProcess.exec).toBe(originalExec);
      const proof = { fault: "none", roots: [] } as unknown as Proof;
      try { completeProof(proof, errors); throw new Error("Expected failure"); }
      catch (error: unknown) {
        expect(error).toBeInstanceOf(ProofFailure);
        if (!(error instanceof ProofFailure)) throw error;
        expect(error.cause).toBe(primary); expect(error.errors).toEqual(errors);
      }
    } finally { spawn.mockRestore(); exec.mockRestore(); syncBuiltinESMExports(); }
  });
});
