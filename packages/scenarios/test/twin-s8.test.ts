import childProcess from "node:child_process";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { ActionGate, failureLine, forbidChildApi, ProofFailure, proveTwinS8, repository, restoreAll,
  successLine, type Fault, type LaunchState, type Proof } from "./support/twin-s8.js";

const proofs: Proof[] = [];
let pureForwards = 0;
async function proof(fault: Fault = "none", fails = false): Promise<Proof> {
  const spawn = childProcess.spawn, exec = childProcess.exec;
  let value: Proof;
  try {
    value = await proveTwinS8(fault);
    expect(fails).toBe(false);
  } catch (error: unknown) {
    if (!(error instanceof ProofFailure)) throw error;
    if (!fails) throw error;
    expect(fails).toBe(true);
    expect(error.cause).toBe(error.errors[0]);
    value = error.proof;
  }
  proofs.push(value);
  expect(childProcess.spawn).toBe(spawn);
  expect(childProcess.exec).toBe(exec);
  expect(value.acquired.every(entry => entry.state === "removed")).toBe(true);
  expect(value.afterRoots).toEqual(value.beforeRoots);
  expect(value.remainingScratch).toEqual([]);
  expect(value.registeredSupports).toEqual([]);
  expect(value.registeredOriginals).toEqual([]);
  return value;
}
function counts(value: Proof, sessions: number, actions: number): void {
  expect(value.supports).toHaveLength(1);
  expect(value.originals).toHaveLength(1);
  expect(value.twins).toHaveLength(1);
  expect(value.acquired).toHaveLength(3);
  expect(value.sessions).toHaveLength(sessions);
  expect(value.realActions).toBe(actions);
}
function ordered(value: Proof, ...events: string[]): void {
  const positions = events.map(event => { expect(value.events).toContain(event); return value.events.indexOf(event); });
  for (let i = 1; i < positions.length; i++) expect(positions[i]!).toBeGreaterThan(positions[i - 1]!);
}
describe("2.5R-4 fixed non-Git destructive isolation through Twin", () => {
  it("deletes one file in Twin, preserves the non-Git original and discards Twin", async () => {
    const value = await proof(); counts(value, 1, 1);
    expect(value.actionSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(value.result?.stdout.bytes).toEqual(new TextEncoder().encode(successLine));
    expect(value.result?.stderr.bytes).toEqual(new Uint8Array());
    ordered(value, "original-baseline", "session-returned", "twin-pre-state", "action-returned",
      "twin-post-state", "original-after-action", "twin-discard", "twin-removed",
      "original-after-discard", "original-cleanup", "support-cleanup");
  }, 30_000);

  it.each(["repository", "default-state", "configured-state"] as const)("rejects forbidden %s base before allocation", async kind => {
    const allocation = vi.spyOn(fs, "mkdtemp");
    vi.stubEnv("XDG_STATE_HOME", join(homedir(), ".twin-s8-unused-state"));
    vi.stubEnv("TMPDIR", kind === "repository" ? repository : kind === "default-state"
      ? join(homedir(), ".local/state/twin", "..capture-temp") : join(process.env.XDG_STATE_HOME!, "twin", "child"));
    try {
      const value = await proof("none", true);
      expect(value.acquired).toEqual([]); expect(value.realActions).toBe(0);
      expect(allocation).not.toHaveBeenCalled();
    } finally { allocation.mockRestore(); vi.unstubAllEnvs(); }
  });

  it.each(["token", "preparation"] as const)("%s failure precedes allocation", async fault => {
    const allocation = vi.spyOn(fs, "mkdtemp");
    try {
      const value = await proof(fault, true);
      expect(value.acquired).toEqual([]); expect(value.realActions).toBe(0);
      expect(allocation).not.toHaveBeenCalled();
    } finally { allocation.mockRestore(); }
  });
  it("action byte mismatch retains no root and launches nothing", async () => {
    const value = await proof("asset-mismatch", true);
    expect(value.supports).toHaveLength(1); expect(value.originals).toEqual([]);
    expect(value.twins).toEqual([]); expect(value.sessions).toEqual([]);
    expect(value.acquired).toHaveLength(1); expect(value.realActions).toBe(0);
  });
  it("rejects a hard-linked fixture file before action and cleans both registered roots", async () => {
    const value = await proof("hardlink", true);
    expect(value.events).toContain("hardlink-rejected");
    expect(value.supports).toHaveLength(1); expect(value.originals).toHaveLength(1);
    expect(value.twins).toEqual([]); expect(value.sessions).toEqual([]);
    expect(value.acquired).toHaveLength(2); expect(value.realActions).toBe(0);
    ordered(value, "hardlink-rejected", "original-after-action", "original-cleanup", "support-cleanup");
  });
  it("factory copy failure records its allocation without a session", async () => {
    const value = await proof("copy", true); counts(value, 0, 0);
    expect(value.events).not.toContain("session-returned");
  }, 30_000);
  it("failure after session return launches no action", async () => {
    const value = await proof("before-action", true); counts(value, 1, 0);
    ordered(value, "session-returned", "twin-post-state", "twin-removed", "original-cleanup");
  }, 30_000);
  it("missing Twin target makes the same real action fail without further changes", async () => {
    const value = await proof("missing-target"); counts(value, 1, 1);
    expect(value.result?.exitCode).toBe(1);
    expect(value.result?.stdout.bytes).toEqual(new Uint8Array());
    expect(value.result?.stderr.bytes).toEqual(new TextEncoder().encode(failureLine));
    ordered(value, "twin-pre-state", "negative-pre-state", "action-returned", "twin-post-state", "twin-removed");
  }, 30_000);
  it("launch rejection forwards no native action", async () => {
    const value = await proof("launch-reject", true); counts(value, 1, 0);
    expect(value.rejectedAttempts).toBe(1);
    expect(value.result).toMatchObject({ outcome: "spawn-failed", started: false, directChildSettled: true });
  }, 30_000);
  it("post-state observation failure still checks and cleans the original", async () => {
    const value = await proof("observation", true); counts(value, 1, 1);
    ordered(value, "twin-post-state", "original-after-action", "twin-removed", "original-after-discard", "original-cleanup");
  }, 30_000);
  it("Twin discard refusal leaves original cleanup independent before controlled release", async () => {
    const value = await proof("twin-refusal", true); counts(value, 1, 1);
    ordered(value, "twin-discard", "original-cleanup", "injected-twin-release", "twin-removed", "support-cleanup");
  }, 30_000);
  it("original cleanup refusal retains Twin accounting and takes a fresh observation", async () => {
    const value = await proof("original-refusal", true); counts(value, 1, 1);
    ordered(value, "twin-removed", "original-cleanup", "injected-original-release", "scratch-accounting");
  }, 30_000);
});

// In-memory destination only: no native command, fixture or allocation.
function synthetic() {
  const node = "/synthetic/node", asset = "/synthetic/support/delete-one-file.mjs", cwd = "/synthetic/twin/workspace";
  const state: LaunchState = { installed: true, dispatch: true, preState: true, sessionState: "running" };
  const input = { command: node as unknown, argv: [asset], options: { cwd, shell: false, detached: true,
    stdio: ["ignore", "pipe", "pipe"], env: { LANG: "C", LC_ALL: "C", TZ: "UTC" } as Record<string, string> } };
  const gate = new ActionGate(node, asset, cwd);
  const destination = vi.fn<() => void>(() => { pureForwards++; });
  const forward = (afterCapture: () => void = () => {}) => {
    const admitted = gate.admit(input.command, input.argv, input.options, state);
    afterCapture(); destination(); return admitted;
  };
  return { input, state, destination, forward };
}
describe("S8 pure action admission, no native child", () => {
  it.each(["argv", "options", "stdio", "environment"] as const)("rejects transparent %s proxy before forwarding", kind => {
    const s = synthetic();
    if (kind === "argv") s.input.argv = new Proxy(s.input.argv, {});
    if (kind === "options") s.input.options = new Proxy(s.input.options, {});
    if (kind === "stdio") s.input.options.stdio = new Proxy(s.input.options.stdio, {});
    if (kind === "environment") s.input.options.env = new Proxy(s.input.options.env, {});
    expect(s.forward).toThrow(/Proxy/);
    expect(s.destination).not.toHaveBeenCalled();
  });
  it("rejects wrong cwd categories including original and workspace descendant", () => {
    for (const cwd of ["/synthetic/original", "/synthetic/repository", "/synthetic/support",
      "/synthetic/support/scratch", "/synthetic/twin", "/synthetic/twin/workspace/child"]) {
      const s = synthetic(); s.input.options.cwd = cwd;
      expect(s.forward).toThrow(); expect(s.destination).not.toHaveBeenCalled();
    }
  });
  it("rejects extra argv and Node flags", () => {
    for (const argv of [["/synthetic/support/delete-one-file.mjs", "extra"], ["-e", "bad"]]) {
      const s = synthetic(); s.input.argv = argv;
      expect(s.forward).toThrow(); expect(s.destination).not.toHaveBeenCalled();
    }
  });
  it("rejects alternate executable including Git", () => {
    for (const command of ["git", "/usr/bin/git", "/synthetic/other-node"]) {
      const s = synthetic(); s.input.command = command;
      expect(s.forward).toThrow(); expect(s.destination).not.toHaveBeenCalled();
    }
  });
  it("rejects alternate action module", () => {
    const s = synthetic(); s.input.argv[0] = "/synthetic/other.mjs";
    expect(s.forward).toThrow(); expect(s.destination).not.toHaveBeenCalled();
  });
  it("rejects changed, missing and extra environment", () => {
    for (const kind of ["changed", "missing", "NODE_OPTIONS", "PATH"]) {
      const s = synthetic();
      if (kind === "changed") s.input.options.env.LANG = "other";
      else if (kind === "missing") delete s.input.options.env.LANG;
      else s.input.options.env[kind] = "forbidden";
      expect(s.forward).toThrow(); expect(s.destination).not.toHaveBeenCalled();
    }
  });
  it("forwards fresh plain values once and rejects a second action", () => {
    const s = synthetic();
    const admitted = s.forward(() => {
      s.input.argv[0] = "changed"; s.input.options.cwd = "changed"; s.input.options.env.LANG = "changed";
    });
    expect(admitted.argv).toEqual(["/synthetic/support/delete-one-file.mjs"]);
    expect(admitted.options.cwd).toBe("/synthetic/twin/workspace");
    expect(admitted.options.detached).toBe(true);
    expect(admitted.options.env).toEqual({ LANG: "C", LC_ALL: "C", TZ: "UTC" });
    expect(admitted.argv).not.toBe(s.input.argv);
    expect(admitted.options).not.toBe(s.input.options);
    expect(admitted.options.env).not.toBe(s.input.options.env);
    expect(() => s.forward()).toThrow("Only one S8 action");
    expect(s.destination).toHaveBeenCalledTimes(1);
  });
  it.each(["false", "missing"])("rejects %s detached setting before forwarding", kind => {
    const s = synthetic();
    if (kind === "false") s.input.options.detached = false;
    else Reflect.deleteProperty(s.input.options, "detached");
    expect(s.forward).toThrow();
    expect(s.destination).not.toHaveBeenCalled();
  });
  it("rejects alternate launch APIs", () => {
    for (const method of ["exec", "execFile", "fork", "execSync", "execFileSync", "spawnSync"] as const) {
      const spy = vi.spyOn(childProcess, method).mockImplementation(forbidChildApi);
      try { expect(() => (childProcess[method] as () => unknown)()).toThrow("S8 forbids alternate child APIs"); }
      finally { spy.mockRestore(); }
    }
  });
  it("rejects accessors and custom iterators without forwarding", () => {
    const accessor = synthetic();
    Object.defineProperty(accessor.input.options, "cwd", { get: () => "/synthetic/twin/workspace" });
    expect(accessor.forward).toThrow(); expect(accessor.destination).not.toHaveBeenCalled();
    const iterator = synthetic();
    Object.defineProperty(iterator.input.argv, Symbol.iterator, { value: function* () { yield iterator.input.argv[0]; } });
    expect(iterator.forward).toThrow(); expect(iterator.destination).not.toHaveBeenCalled();
  });
  it("throwing input reflection rejects before forwarding", () => {
    const s = synthetic();
    const injected = new Error("synthetic reflection failure");
    Object.defineProperty(s.input.options, "env", { get: () => { throw injected; } });
    expect(s.forward).toThrow(); expect(s.destination).not.toHaveBeenCalled();
  });
  it("requires lifecycle and fixed shell and stdio", () => {
    for (const kind of ["dispatch", "preState", "running", "shell", "stdio"]) {
      const s = synthetic();
      if (kind === "dispatch") s.state.dispatch = false;
      if (kind === "preState") s.state.preState = false;
      if (kind === "running") s.state.sessionState = "ready";
      if (kind === "shell") s.input.options.shell = true;
      if (kind === "stdio") s.input.options.stdio[0] = "inherit";
      expect(s.forward).toThrow(); expect(s.destination).not.toHaveBeenCalled();
    }
  });
});
it("restoration failure preserves the primary error and attempts every later restore", () => {
  const primary = new Error("primary"), injected = new Error("restore");
  const errors: unknown[] = [primary], calls: string[] = [];
  const originalSpawn = childProcess.spawn, originalExec = childProcess.exec;
  const spawn = vi.spyOn(childProcess, "spawn").mockImplementation(forbidChildApi);
  const exec = vi.spyOn(childProcess, "exec").mockImplementation(forbidChildApi);
  try {
    syncBuiltinESMExports();
    restoreAll([() => { calls.push("spawn"); spawn.mockRestore(); throw injected; },
      () => { calls.push("exec"); exec.mockRestore(); }], errors,
    () => { calls.push("sync"); syncBuiltinESMExports(); });
    expect(calls).toEqual(["spawn", "exec", "sync"]);
    expect(errors).toEqual([primary, injected]);
    expect(childProcess.spawn).toBe(originalSpawn); expect(childProcess.exec).toBe(originalExec);
  } finally { spawn.mockRestore(); exec.mockRestore(); syncBuiltinESMExports(); }
});
afterAll(() => {
  const sum = (value: (p: Proof) => number): number => proofs.reduce((total, item) => total + value(item), 0);
  console.log(`TWIN S8 TOTAL ${JSON.stringify({ cases: proofs.length, supportRoots: sum(p => p.supports.length),
    originalRoots: sum(p => p.originals.length), twinAllocations: sum(p => p.twins.length),
    sessions: sum(p => p.sessions.length), realActions: sum(p => p.realActions),
    rejectedAttempts: sum(p => p.rejectedAttempts), pureForwards,
    removed: sum(p => p.acquired.filter(e => e.state === "removed").length),
    retainedOrUnknown: sum(p => p.acquired.filter(e => e.state !== "removed").length),
    actionDigests: [...new Set(proofs.map(p => p.actionSha256).filter(value => value !== null))] })}`);
});
