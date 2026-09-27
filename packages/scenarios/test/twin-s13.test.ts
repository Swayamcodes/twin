import childProcess from "node:child_process";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { actionGuard, failureLine, forbidChildApi, ProofFailure, proveTwinS13, repository, restoreAll,
  successLine, type Fault, type Proof } from "./support/twin-s13.js";

const proofs: Proof[] = [];
let pureForwards = 0;
async function proof(fault: Fault = "none", fails = false): Promise<Proof> {
  const spawn = childProcess.spawn, exec = childProcess.exec, path = process.env.PATH;
  let value: Proof;
  try {
    value = await proveTwinS13(fault);
    expect(fails, "Expected injected failure").toBe(false);
  } catch (error: unknown) {
    if (!(error instanceof ProofFailure)) throw error;
    expect(fails, "Unexpected proof failure").toBe(true);
    expect(error.cause).toBe(error.errors[0]);
    expect(error.errors).toHaveLength(1);
    value = error.proof;
    const expected = fault === "none" ? "Forbidden supplied temporary base"
      : fault === "asset-mismatch" ? "S13 action byte mismatch"
      : fault === "copy" ? "Twin copy failed"
      : fault === "twin-refusal" ? "Twin discard refused"
      : fault === "original-refusal" ? "Original cleanup refused" : `Injected ${fault}`;
    expect(String(error.errors[0])).toContain(expected);
  }
  proofs.push(value);
  expect(childProcess.spawn).toBe(spawn);
  expect(childProcess.exec).toBe(exec);
  expect(process.env.PATH).toBe(path);
  expect(value.dispositions).toEqual(value.allocations.map(path => ({ path, state: "removed" })));
  expect(value.afterRoots).toEqual(value.beforeRoots);
  expect(value.remainingScratch).toEqual([]);
  expect(value.registeredSupports).toEqual([]);
  return value;
}
function accounted(value: Proof, sessions: number, actions: number): void {
  expect(value.supports).toHaveLength(1);
  expect(value.originals).toHaveLength(1);
  expect(value.twins).toHaveLength(1);
  expect(value.allocations).toHaveLength(3);
  expect(value.sessions).toHaveLength(sessions);
  expect(value.setupLaunches).toBe(7);
  expect(value.actions).toBe(actions);
  expect(value.events).toContain("original-after-action");
  expect(value.events).toContain("original-after-discard");
  expect(value.events).toContain("original-cleanup");
  expect(value.events).toContain("support-cleanup");
}
function ordered(value: Proof, ...events: string[]): void {
  const positions = events.map(event => { expect(value.events).toContain(event); return value.events.indexOf(event); });
  for (let i = 1; i < positions.length; i++) expect(positions[i]!).toBeGreaterThan(positions[i - 1]!);
}

describe("2.5R-3 fixed ignored-input usability through Twin", () => {
  it("consumes both pinned ignored inputs with no workspace changes", async () => {
    const value = await proof();
    accounted(value, 1, 1);
    expect(value.actionSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(value.result?.stdout.bytes).toEqual(new TextEncoder().encode(successLine));
    expect(value.result?.stderr.bytes.byteLength).toBe(0);
    ordered(value, "original-baseline", "session-returned", "twin-pre-state", "action-returned",
      "twin-unchanged", "original-after-action", "twin-discard", "twin-removed", "original-after-discard",
      "original-cleanup", "support-cleanup", "root-accounting");
  }, 30_000);

  it.each(["missing-env", "missing-dependency", "changed-env", "changed-dependency"] as const)(
    "%s makes the same real action fail without additional effects", async fault => {
      const value = await proof(fault);
      accounted(value, 1, 1);
      expect(value.result?.exitCode).toBe(1);
      expect(value.result?.stdout.bytes.byteLength).toBe(0);
      expect(value.result?.stderr.bytes).toEqual(new TextEncoder().encode(failureLine));
      ordered(value, "twin-pre-state", "negative-pre-state", "action-returned", "twin-unchanged",
        "original-after-action", "twin-removed", "original-after-discard");
    }, 30_000);

  it.each(["repository", "default-state", "configured-state"] as const)("rejects forbidden %s base before allocation", async kind => {
    const allocation = vi.spyOn(fs, "mkdtemp");
    vi.stubEnv("XDG_STATE_HOME", join(homedir(), ".twin-s13-unused-state"));
    vi.stubEnv("TMPDIR", kind === "repository" ? repository : kind === "default-state"
      ? join(homedir(), ".local/state/twin", "..capture-temp") : join(process.env.XDG_STATE_HOME!, "twin", "child"));
    try {
      const value = await proof("none", true);
      expect(value.allocations).toEqual([]);
      expect(value.setupLaunches + value.actions).toBe(0);
      expect(allocation).not.toHaveBeenCalled();
    } finally { allocation.mockRestore(); vi.unstubAllEnvs(); }
  });

  it.each(["trusted-git", "token", "preparation"] as const)("%s failure precedes allocation", async fault => {
    const allocation = vi.spyOn(fs, "mkdtemp");
    try {
      const value = await proof(fault, true);
      expect(value.allocations).toEqual([]);
      expect(value.setupLaunches + value.actions).toBe(0);
      expect(allocation).not.toHaveBeenCalled();
    } finally { allocation.mockRestore(); }
  });

  it("rejects changed action bytes before creating an original and cleans owned support", async () => {
    const value = await proof("asset-mismatch", true);
    expect(value.allocations).toHaveLength(1);
    expect(value.supports).toHaveLength(1);
    expect(value.originals).toEqual([]);
    expect(value.sessions).toEqual([]);
    expect(value.setupLaunches + value.actions).toBe(0);
  });

  it("accounts for copy failure without a returned session or action", async () => {
    const value = await proof("copy", true);
    accounted(value, 0, 0);
    expect(value.events).not.toContain("session-returned");
  }, 30_000);
  it("retains session authority when failure precedes action", async () => {
    const value = await proof("before-action", true);
    accounted(value, 1, 0);
    ordered(value, "session-returned", "twin-unchanged", "twin-removed", "original-cleanup");
  }, 30_000);
  it("post-state observation failure preserves independent original checks and cleanup", async () => {
    const value = await proof("observation", true);
    accounted(value, 1, 1);
    expect(value.events).not.toContain("twin-unchanged");
    ordered(value, "twin-post-state", "original-after-action", "twin-removed", "original-after-discard", "original-cleanup");
  }, 30_000);
  it("Twin discard refusal preserves original cleanup before controlled release", async () => {
    const value = await proof("twin-refusal", true);
    accounted(value, 1, 1);
    ordered(value, "twin-discard", "original-cleanup", "injected-twin-retention", "twin-removed", "support-cleanup");
  }, 30_000);
  it("original cleanup refusal preserves Twin accounting and requires fresh observation", async () => {
    const value = await proof("original-refusal", true);
    accounted(value, 1, 1);
    ordered(value, "twin-removed", "original-cleanup", "injected-original-retention", "scratch-accounting", "support-cleanup");
  }, 30_000);
});

// Pure guard destinations are in-memory spies; these paths are never opened.
function guard() {
  const node = "/synthetic/node", asset = "/synthetic/support/action.mjs", cwd = "/synthetic/twin/workspace";
  const input = { node, argv: [asset], options: { cwd, shell: false, detached: false,
    env: { LANG: "C", LC_ALL: "C", TZ: "UTC" } as Record<string, string>, stdio: ["ignore", "pipe", "pipe"] } };
  const admit = actionGuard(node, asset, cwd);
  const destination = vi.fn<() => void>(() => { pureForwards++; });
  const forward = (): void => { admit(input.node, input.argv, input.options); destination(); };
  return { input, forward, destination };
}
describe("S13 critical guard checks without native children", () => {
  it.each(["original", "descendant"])("rejects %s cwd", kind => {
    const s = guard(); s.input.options.cwd = kind === "original" ? "/synthetic/original" : `${s.input.options.cwd}/child`;
    expect(s.forward).toThrow(); expect(s.destination).not.toHaveBeenCalled();
  });
  it.each(["extra", "node-flag"])("rejects %s argv", kind => {
    const s = guard(); if (kind === "extra") s.input.argv.push("extra"); else s.input.argv.unshift("-e");
    expect(s.forward).toThrow(); expect(s.destination).not.toHaveBeenCalled();
  });
  it.each(["executable", "asset"])("rejects alternate %s", kind => {
    const s = guard(); if (kind === "executable") s.input.node = "/synthetic/other-node"; else s.input.argv[0] = "/synthetic/other.mjs";
    expect(s.forward).toThrow(); expect(s.destination).not.toHaveBeenCalled();
  });
  it.each(["changed", "extra"])("rejects %s environment", kind => {
    const s = guard(); if (kind === "changed") s.input.options.env.LANG = "changed"; else s.input.options.env.NODE_OPTIONS = "forbidden";
    expect(s.forward).toThrow(); expect(s.destination).not.toHaveBeenCalled();
  });
  it("allows only one synthetic forward", () => {
    const s = guard(); s.forward(); expect(s.forward).toThrow("Only one S13 action");
    expect(s.destination).toHaveBeenCalledTimes(1);
  });
  it("rejects an alternate child API before native execution", () => {
    const native = vi.spyOn(childProcess, "exec").mockImplementation(forbidChildApi);
    try { expect(() => childProcess.exec("synthetic-never-executed")).toThrow("S13 forbids alternate child APIs"); }
    finally { native.mockRestore(); }
  });
  it("restoration failure cannot skip later restores or replace the primary error", () => {
    const primary = new Error("primary"), failure = new Error("restore");
    const errors: unknown[] = [primary], calls: string[] = [];
    const oldSpawn = childProcess.spawn, oldExec = childProcess.exec;
    const spawn = vi.spyOn(childProcess, "spawn").mockImplementation(forbidChildApi);
    const exec = vi.spyOn(childProcess, "exec").mockImplementation(forbidChildApi);
    try {
      syncBuiltinESMExports();
      restoreAll([() => { calls.push("spawn"); spawn.mockRestore(); throw failure; },
        () => { calls.push("exec"); exec.mockRestore(); }], errors,
      () => { calls.push("sync"); syncBuiltinESMExports(); });
      expect(calls).toEqual(["spawn", "exec", "sync"]);
      expect(errors).toEqual([primary, failure]);
      expect(childProcess.spawn).toBe(oldSpawn); expect(childProcess.exec).toBe(oldExec);
    } finally { spawn.mockRestore(); exec.mockRestore(); syncBuiltinESMExports(); }
  });
});

afterAll(() => {
  const sum = (value: (p: Proof) => number): number => proofs.reduce((total, p) => total + value(p), 0);
  console.log(`TWIN S13 TOTAL ${JSON.stringify({ cases: proofs.length, setupLaunches: sum(p => p.setupLaunches),
    actualNodeActions: sum(p => p.actions), syntheticChildForwards: 0, pureGuardForwards: pureForwards,
    supportRoots: sum(p => p.supports.length), originalRoots: sum(p => p.originals.length),
    twinAllocations: sum(p => p.twins.length), sessions: sum(p => p.sessions.length),
    removed: sum(p => p.dispositions.filter(d => d.state === "removed").length),
    retained: sum(p => p.dispositions.filter(d => d.state !== "removed").length),
    actionDigests: [...new Set(proofs.map(p => p.actionSha256).filter(value => value !== null))] })}`);
});
