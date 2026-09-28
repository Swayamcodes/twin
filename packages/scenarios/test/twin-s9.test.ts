import childProcess from "node:child_process";
import fsp from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { ActionGate, failureLine, forbidChildApi, ProofFailure, proveTwinS9, repository, restoreAll,
  successLine, type Fault, type LaunchState, type Proof } from "./support/twin-s9.js";

const proofs: Proof[] = [];
let pureForwards = 0;
async function proof(fault: Fault = "none", fails = false): Promise<Proof> {
  const spawn = childProcess.spawn, exec = childProcess.exec;
  let value: Proof;
  try {
    value = await proveTwinS9(fault);
    expect(fails, "Expected injected failure").toBe(false);
  } catch (error: unknown) {
    if (!(error instanceof ProofFailure)) throw error;
    if (!fails) throw error;
    expect(error.cause).toBe(error.errors[0]);
    value = error.proof;
  }
  proofs.push(value);
  expect(childProcess.spawn).toBe(spawn); expect(childProcess.exec).toBe(exec);
  expect(value.acquired.every(entry => entry.status === "removed")).toBe(true);
  expect(value.afterRoots).toEqual(value.beforeRoots);
  expect(value.remainingScratch).toEqual([]);
  expect(value.registeredSupports).toBe(0);
  expect(value.registeredOriginals).toBe(0);
  expect(value.registeredHomes).toBe(0);
  return value;
}
function counts(value: Proof, sessions: number, actions: number): void {
  expect(value.supports).toBe(1); expect(value.originals).toBe(1); expect(value.homes).toBe(1);
  expect(value.twins).toBe(1); expect(value.acquired).toHaveLength(4);
  expect(value.sessions).toBe(sessions); expect(value.realActions).toBe(actions);
}
function ordered(value: Proof, ...events: string[]): void {
  const positions = events.map(event => { expect(value.events).toContain(event); return value.events.indexOf(event); });
  for (let index = 1; index < positions.length; index++) expect(positions[index]!).toBeGreaterThan(positions[index - 1]!);
}
describe("2.5R-5 fixed fake-home boundary demonstration", () => {
  it("observes only fake-home mutation while original and Twin projects remain unchanged", async () => {
    const value = await proof(); counts(value, 1, 1);
    expect(value.actionSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(value.result?.stdout.bytes).toEqual(new TextEncoder().encode(successLine));
    expect(value.result?.stderr.bytes).toEqual(new Uint8Array());
    ordered(value, "original-baseline", "fake-home-baseline", "session-returned", "twin-pre-state",
      "action-returned", "twin-post-state", "original-after-action", "fake-home-after-action",
      "twin-discard", "twin-removed", "fake-home-after-discard", "fake-home-cleanup", "support-cleanup");
  }, 30_000);
  it("missing fake-home dotfile makes the same real action fail without additional effects", async () => {
    const value = await proof("missing-note"); counts(value, 1, 1);
    expect(value.result?.exitCode).toBe(1);
    expect(value.result?.stdout.bytes).toEqual(new Uint8Array());
    expect(value.result?.stderr.bytes).toEqual(new TextEncoder().encode(failureLine));
    ordered(value, "twin-pre-state", "negative-pre-state", "action-returned", "fake-home-after-action",
      "twin-removed", "fake-home-after-discard", "fake-home-cleanup");
  }, 30_000);
  it("changed fake-home authority rejects before native forwarding", async () => {
    const value = await proof("changed-authority", true); counts(value, 1, 0);
    expect(value.rejectedAttempts).toBe(1);
    expect(value.result).toMatchObject({ outcome: "spawn-failed", started: false, directChildSettled: true });
    ordered(value, "action-returned", "known-home-mode-restored", "fake-home-after-action", "fake-home-cleanup");
  }, 30_000);
  it("replaced single-link note rejects at the prelaunch identity gate", async () => {
    const value = await proof("replaced-note", true); counts(value, 1, 0);
    expect(value.rejectedAttempts).toBe(1);
    expect(value.result).toMatchObject({ outcome: "spawn-failed", started: false,
      directChildSettled: true, spawnError: "Prelaunch note identity changed" });
    ordered(value, "fake-home-baseline", "session-returned", "twin-pre-state", "known-note-replaced",
      "action-returned", "known-note-restored", "fake-home-after-action", "twin-removed",
      "original-cleanup", "fake-home-cleanup", "support-cleanup");
  }, 30_000);
  it.each(["repository", "default-state", "configured-state"] as const)("rejects forbidden %s base before allocation", async kind => {
    const allocation = vi.spyOn(fsp, "mkdtemp");
    vi.stubEnv("XDG_STATE_HOME", join(homedir(), ".twin-s9-unused-state"));
    vi.stubEnv("TMPDIR", kind === "repository" ? repository : kind === "default-state"
      ? join(homedir(), ".local/state/twin", "..capture-temp") : join(process.env.XDG_STATE_HOME!, "twin", "child"));
    try {
      const value = await proof("none", true);
      expect(value.acquired).toEqual([]); expect(value.realActions).toBe(0);
      expect(allocation).not.toHaveBeenCalled();
    } finally { allocation.mockRestore(); vi.unstubAllEnvs(); }
  });
  it.each(["token", "preparation"] as const)("%s failure precedes allocation", async fault => {
    const allocation = vi.spyOn(fsp, "mkdtemp");
    try {
      const value = await proof(fault, true);
      expect(value.acquired).toEqual([]); expect(value.realActions).toBe(0);
      expect(allocation).not.toHaveBeenCalled();
    } finally { allocation.mockRestore(); }
  });
  it("asset mismatch allocates support only and launches nothing", async () => {
    const value = await proof("asset-mismatch", true);
    expect(value.supports).toBe(1); expect(value.originals).toBe(0); expect(value.homes).toBe(0);
    expect(value.twins).toBe(0); expect(value.sessions).toBe(0); expect(value.realActions).toBe(0);
    expect(value.acquired).toHaveLength(1);
  });
  it("copy failure records a Twin allocation without returning a session", async () => {
    const value = await proof("copy", true); counts(value, 0, 0);
    expect(value.events).not.toContain("session-returned");
  }, 30_000);
  it("failure after session return launches no action", async () => {
    const value = await proof("before-action", true); counts(value, 1, 0);
    ordered(value, "session-returned", "twin-post-state", "twin-removed", "fake-home-cleanup");
  }, 30_000);
  it("post-state observation failure still observes and cleans the other authorities", async () => {
    const value = await proof("observation", true); counts(value, 1, 1);
    ordered(value, "twin-post-state", "original-after-action", "fake-home-after-action",
      "twin-removed", "fake-home-after-discard", "fake-home-cleanup");
  }, 30_000);
  it.each(["twin-refusal", "original-refusal", "home-refusal", "support-refusal"] as const)(
    "%s keeps independent cleanup and releases only its known preflight cause", async fault => {
      const value = await proof(fault, true); counts(value, 1, 1);
      const release = fault === "twin-refusal" ? "known-twin-release"
        : fault === "original-refusal" ? "known-original-release"
          : fault === "home-refusal" ? "known-home-release" : "known-support-release";
      expect(value.events).toContain(release);
      expect(value.events).toContain("original-cleanup");
      expect(value.events).toContain("fake-home-cleanup");
      expect(value.events).toContain("support-cleanup");
    }, 30_000);
  it("injected launch rejection forwards no native child", async () => {
    const value = await proof("launch-reject", true); counts(value, 1, 0);
    expect(value.rejectedAttempts).toBe(1);
    expect(value.result).toMatchObject({ outcome: "spawn-failed", started: false, directChildSettled: true });
  }, 30_000);
});

// These placeholders exist only in memory; the destination is a spy, never spawn.
function synthetic() {
  const node = "/synthetic/node", asset = "/synthetic/support/append-fake-home.mjs";
  const cwd = "/synthetic/twin/workspace", home = "/synthetic/fake-home/home";
  const state: LaunchState = { installed: true, dispatch: true, baselines: true, sessionState: "running" };
  const input = { command: node as unknown, argv: [asset], options: { cwd, shell: false, detached: false,
    stdio: ["ignore", "pipe", "pipe"], env: { LANG: "C", LC_ALL: "C", TZ: "UTC", HOME: home } as Record<string, string> } };
  const gate = new ActionGate(node, asset, cwd, home);
  const destination = vi.fn<() => void>(() => { pureForwards++; });
  const forward = (afterCapture: () => void = () => {}) => {
    const admitted = gate.admit(input.command, input.argv, input.options, state);
    afterCapture(); destination(); return admitted;
  };
  return { input, state, destination, forward };
}
describe("S9 pure launch guard, no native process", () => {
  it("rejects original, support, allocation, descendant and other cwd", () => {
    for (const cwd of ["/synthetic/original", "/synthetic/support", "/synthetic/twin",
      "/synthetic/twin/workspace/child", "/synthetic/elsewhere"]) {
      const s = synthetic(); s.input.options.cwd = cwd;
      expect(s.forward).toThrow(); expect(s.destination).not.toHaveBeenCalled();
    }
  });
  it("rejects redirected HOME including synthetic protected placeholders", () => {
    for (const home of ["/synthetic/real-home", "/synthetic/repository", "/synthetic/support",
      "/synthetic/original", "/synthetic/twin", "/synthetic/state/twin"]) {
      const s = synthetic(); s.input.options.env.HOME = home;
      expect(s.forward).toThrow(); expect(s.destination).not.toHaveBeenCalled();
    }
  });
  it("rejects Git and alternate executable", () => {
    for (const command of ["git", "/synthetic/git", "/synthetic/other-node"]) {
      const s = synthetic(); s.input.command = command;
      expect(s.forward).toThrow(); expect(s.destination).not.toHaveBeenCalled();
    }
  });
  it("rejects additional argv and Node flags", () => {
    for (const argv of [["/synthetic/support/append-fake-home.mjs", "extra"], ["-e", "bad"]]) {
      const s = synthetic(); s.input.argv = argv;
      expect(s.forward).toThrow(); expect(s.destination).not.toHaveBeenCalled();
    }
  });
  it("rejects alternate action module", () => {
    const s = synthetic(); s.input.argv[0] = "/synthetic/other.mjs";
    expect(s.forward).toThrow(); expect(s.destination).not.toHaveBeenCalled();
  });
  it("rejects missing, changed and extra environment", () => {
    for (const kind of ["missing", "changed", "PATH", "NODE_OPTIONS"]) {
      const s = synthetic();
      if (kind === "missing") delete s.input.options.env.LANG;
      else if (kind === "changed") s.input.options.env.LANG = "other";
      else s.input.options.env[kind] = "forbidden";
      expect(s.forward).toThrow(); expect(s.destination).not.toHaveBeenCalled();
    }
  });
  it("rejects lifecycle, shell, detached, stdio and extra options", () => {
    for (const kind of ["dispatch", "baselines", "session", "shell", "detached", "stdio", "extra"]) {
      const s = synthetic();
      if (kind === "dispatch") s.state.dispatch = false;
      else if (kind === "baselines") s.state.baselines = false;
      else if (kind === "session") s.state.sessionState = "ready";
      else if (kind === "shell") s.input.options.shell = true;
      else if (kind === "detached") s.input.options.detached = true;
      else if (kind === "stdio") s.input.options.stdio[0] = "inherit";
      else Object.defineProperty(s.input.options, "uid", { value: 0 });
      expect(s.forward).toThrow(); expect(s.destination).not.toHaveBeenCalled();
    }
  });
  it("rejects proxies, accessors, custom iterators and throwing input", () => {
    const proxy = synthetic(); proxy.input.options.env = new Proxy(proxy.input.options.env, {});
    expect(proxy.forward).toThrow(); expect(proxy.destination).not.toHaveBeenCalled();
    const accessor = synthetic();
    Object.defineProperty(accessor.input.options, "cwd", { get: () => accessor.input.options.env.HOME });
    expect(accessor.forward).toThrow(); expect(accessor.destination).not.toHaveBeenCalled();
    const iterator = synthetic();
    Object.defineProperty(iterator.input.argv, Symbol.iterator, { value: function* () { yield iterator.input.argv[0]; } });
    expect(iterator.forward).toThrow(); expect(iterator.destination).not.toHaveBeenCalled();
    const inheritedIterator = synthetic();
    Object.setPrototypeOf(inheritedIterator.input.argv, { [Symbol.iterator]: function* () { yield "alternate"; } });
    expect(inheritedIterator.forward).toThrow(); expect(inheritedIterator.destination).not.toHaveBeenCalled();
    const throwing = synthetic();
    Object.defineProperty(throwing.input.options, "env", { get: () => { throw new Error("synthetic getter"); } });
    expect(throwing.forward).toThrow(); expect(throwing.destination).not.toHaveBeenCalled();
  });
  it("forwards one fresh plain snapshot despite later mutation and rejects a second action", () => {
    const s = synthetic();
    const admitted = s.forward(() => {
      s.input.argv[0] = "changed"; s.input.options.cwd = "changed";
      s.input.options.env.HOME = "changed"; s.input.options.stdio[0] = "inherit";
    });
    expect(admitted.argv).toEqual(["/synthetic/support/append-fake-home.mjs"]);
    expect(admitted.options.cwd).toBe("/synthetic/twin/workspace");
    expect(admitted.options.env.HOME).toBe("/synthetic/fake-home/home");
    expect(admitted.argv).not.toBe(s.input.argv);
    expect(admitted.options).not.toBe(s.input.options);
    expect(admitted.options.env).not.toBe(s.input.options.env);
    expect(Object.getPrototypeOf(admitted.options)).toBe(Object.prototype);
    expect(() => s.forward()).toThrow("Only one S9 action");
    expect(s.destination).toHaveBeenCalledTimes(1);
  });
  it("rejects alternate child APIs before any native execution", () => {
    for (const method of ["exec", "execFile", "fork", "execSync", "execFileSync", "spawnSync"] as const) {
      const spy = vi.spyOn(childProcess, method).mockImplementation(forbidChildApi);
      try { expect(() => (childProcess[method] as () => unknown)()).toThrow("S9 forbids alternate child APIs"); }
      finally { spy.mockRestore(); }
    }
  });
});
it("restoration failure preserves earlier errors and attempts every later restoration", () => {
  const primary = new Error("primary"), injected = new Error("restore");
  const errors: unknown[] = [primary], calls: string[] = [];
  const oldSpawn = childProcess.spawn, oldExec = childProcess.exec;
  const spawn = vi.spyOn(childProcess, "spawn").mockImplementation(forbidChildApi);
  const exec = vi.spyOn(childProcess, "exec").mockImplementation(forbidChildApi);
  try {
    syncBuiltinESMExports();
    restoreAll([() => { calls.push("spawn"); spawn.mockRestore(); throw injected; },
      () => { calls.push("exec"); exec.mockRestore(); }], errors,
    () => { calls.push("sync"); syncBuiltinESMExports(); });
    expect(calls).toEqual(["spawn", "exec", "sync"]);
    expect(errors).toEqual([primary, injected]);
    expect(childProcess.spawn).toBe(oldSpawn); expect(childProcess.exec).toBe(oldExec);
  } finally { spawn.mockRestore(); exec.mockRestore(); syncBuiltinESMExports(); }
});
afterAll(() => {
  const sum = (value: (proof: Proof) => number): number => proofs.reduce((total, item) => total + value(item), 0);
  console.log(`TWIN S9 TOTAL ${JSON.stringify({ cases: proofs.length, supports: sum(p => p.supports),
    originals: sum(p => p.originals), homes: sum(p => p.homes), twins: sum(p => p.twins),
    sessions: sum(p => p.sessions), realActions: sum(p => p.realActions),
    rejectedAttempts: sum(p => p.rejectedAttempts), pureForwards,
    removed: sum(p => p.acquired.filter(value => value.status === "removed").length),
    retained: sum(p => p.acquired.filter(value => value.status === "retained").length),
    unknown: sum(p => p.acquired.filter(value => value.status === "unknown").length),
    actionDigests: [...new Set(proofs.map(p => p.actionSha256).filter(value => value !== null))] })}`);
});
