import childProcess from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { admitSpawn, completeProof, ProofFailure, proveTwinS12, repository, restoreAll,
  type Fault, type Proof } from "./support/twin-s12.js";

function accounted(proof: Proof, sessions: number, actions: number): void {
  expect(proof.roots).toHaveLength(2);
  expect(proof.acquiredSupportPath).toBe(proof.roots[0]);
  expect(proof.sessions).toHaveLength(sessions);
  expect(proof.twinRoots).toHaveLength(1);
  expect(proof.launches.filter(item => item.phase === "setup")).toHaveLength(7);
  expect(proof.launches.filter(item => item.phase === "action")).toHaveLength(actions);
  expect(proof.afterRoots).toEqual(proof.beforeRoots);
  expect(proof.remainingTwinRoots).toEqual([]);
  expect(proof.registeredSupports).toEqual([]);
  expect(proof.events).toContain("support-cleanup");
  expect(proof.events.at(-1)).toBe("root-accounting");
}
async function failure(fault: Fault): Promise<ProofFailure> {
  try { await proveTwinS12(fault); }
  catch (error: unknown) {
    expect(error).toBeInstanceOf(ProofFailure);
    if (error instanceof ProofFailure) return error;
    throw error;
  }
  throw new Error(`Expected injected ${fault} failure`);
}
function ordered(proof: Proof, ...events: string[]): void {
  const positions = events.map(event => {
    expect(proof.events).toContain(event);
    return proof.events.indexOf(event);
  });
  expect(positions).toEqual([...positions].sort((a, b) => a - b));
}

describe("2.5R-1 real Twin S12 product proof", () => {
  it("copies the complete fixture, runs only in Twin, and independently removes both roots", async () => {
    const oldSpawn = childProcess.spawn;
    const oldExec = childProcess.exec;
    const oldPath = process.env.PATH;
    const oldNodeOptions = process.env.NODE_OPTIONS;
    const proof = await proveTwinS12();
    accounted(proof, 1, 1);
    ordered(proof, "original-baseline", "session-returned", "twin-pre-state", "action-returned", "post-state",
      "twin-discard", "twin-removed", "original-observe", "original-cleanup", "original-removed", "support-cleanup");
    expect(proof.result?.stdout.bytes).toEqual(new Uint8Array());
    expect(proof.result?.stderr.bytes).toEqual(new Uint8Array());
    const action = proof.launches.find(item => item.phase === "action")!;
    expect(action.executable).toBe(process.execPath);
    expect(action.argv).toEqual([join(proof.roots[0]!, "actions/create-file.mjs")]);
    expect(action.cwd).toBe(proof.sessions[0]);
    expect(action.shell).toBe(false);
    expect(childProcess.spawn).toBe(oldSpawn);
    expect(childProcess.exec).toBe(oldExec);
    expect(process.env.PATH).toBe(oldPath);
    expect(process.env.NODE_OPTIONS).toBe(oldNodeOptions);
  }, 30_000);

  it.each(["repository", "default-state", "configured-state"] as const)("rejects %s prerequisites before allocation or launch", async kind => {
    const allocation = vi.spyOn(fs, "mkdtemp");
    const spawn = vi.spyOn(childProcess, "spawn");
    vi.stubEnv("XDG_STATE_HOME", join(homedir(), ".twin-s12-unused-state"));
    const forbidden = kind === "repository" ? repository : kind === "default-state"
      ? join(homedir(), ".local/state/twin", "..capture-temp") : join(process.env.XDG_STATE_HOME!, "twin", "child");
    vi.stubEnv("TMPDIR", forbidden);
    try {
      const rejected = await failure("none");
      expect(rejected.errors).toHaveLength(1);
      expect(String(rejected.errors[0])).toContain("Forbidden supplied temporary base");
      expect(rejected.proof.roots).toEqual([]);
      expect(rejected.proof.sessions).toEqual([]);
      expect(rejected.proof.launches).toEqual([]);
      expect(allocation).not.toHaveBeenCalled();
      expect(spawn).not.toHaveBeenCalled();
    } finally { allocation.mockRestore(); spawn.mockRestore(); vi.unstubAllEnvs(); }
  });

  it("copy failure returns no session and launches no action", async () => {
    const rejected = await failure("copy");
    accounted(rejected.proof, 0, 0);
    expect(rejected.errors).toHaveLength(1);
    expect(rejected.errors[0]).toMatchObject({ message: expect.stringContaining("Twin copy failed"),
      cause: { message: "Injected copy" } });
    expect(rejected.proof.events).not.toContain("session-returned");
    expect(rejected.proof.events).not.toContain("twin-discard");
    expect(rejected.proof.events).toContain("original-removed");
  }, 30_000);

  it.each(["before-run", "after-run"] as const)("%s failure still discards and tears down the original", async fault => {
    const oldSpawn = childProcess.spawn;
    const oldPath = process.env.PATH;
    const rejected = await failure(fault);
    accounted(rejected.proof, 1, fault === "before-run" ? 0 : 1);
    expect(rejected.errors).toHaveLength(1);
    expect(rejected.errors[0]).toMatchObject({ message: `Injected ${fault}` });
    expect(rejected.cause).toBe(rejected.errors[0]);
    ordered(rejected.proof, "session-returned", "twin-discard", "twin-removed", "original-observe", "original-cleanup", "original-removed");
    expect(childProcess.spawn).toBe(oldSpawn);
    expect(process.env.PATH).toBe(oldPath);
  }, 30_000);

  it("Twin discard refusal preserves the primary error and does not prevent original cleanup", async () => {
    const rejected = await failure("twin-cleanup");
    accounted(rejected.proof, 1, 1);
    expect(rejected.errors).toHaveLength(2);
    expect(rejected.errors[0]).toMatchObject({ message: "Injected twin-cleanup" });
    expect(String(rejected.errors[1])).toContain('"status":"refused"');
    ordered(rejected.proof, "twin-discard", "original-cleanup", "original-removed", "scratch-accounting",
      "injected-twin-retention-accounted", "injected-twin-released", "support-cleanup");
  }, 30_000);

  it("original cleanup refusal preserves the primary error and Twin cleanup/accounting", async () => {
    const rejected = await failure("original-cleanup");
    accounted(rejected.proof, 1, 1);
    expect(rejected.errors).toHaveLength(2);
    expect(rejected.errors[0]).toMatchObject({ message: "Injected original-cleanup" });
    expect(String(rejected.errors[1])).toContain('"status":"refused"');
    ordered(rejected.proof, "twin-removed", "original-cleanup", "scratch-accounting", "injected-original-release", "root-accounting");
  }, 30_000);

  it("secondary observation failure retains causal order and still attempts both cleanup paths", async () => {
    const rejected = await failure("observation");
    accounted(rejected.proof, 1, 1);
    expect(rejected.errors).toHaveLength(3);
    expect(rejected.errors[0]).toMatchObject({ message: "Injected observation" });
    expect(rejected.errors[1]).toMatchObject({ message: "Injected final observation failure" });
    expect(String(rejected.errors[2])).toContain('"status":"refused"');
    ordered(rejected.proof, "twin-removed", "original-observe", "original-cleanup", "injected-original-release", "root-accounting");
  }, 30_000);

  it.each(["missing-snapshot", "incomplete-snapshot", "wrong-workspace"] as const)("%s cannot authorize original deletion", async fault => {
    const proof = await proveTwinS12(fault);
    accounted(proof, 1, 1);
    ordered(proof, "snapshot-refused", "twin-removed", "original-observe", "original-cleanup", "original-removed");
  }, 30_000);
});

// These tests never use child_process to forward inputs. The mock is the entire
// synthetic destination; none of these placeholder paths is opened or executed.
function syntheticGuard() {
  const policy = { executable: "/synthetic/node", argv: ["/synthetic/action.mjs"], cwd: "/synthetic/workspace",
    env: { LANG: "C", LC_ALL: "C", TZ: "UTC" }, requireDetached: true };
  const input = { command: policy.executable as unknown, argv: [...policy.argv],
    options: { cwd: policy.cwd, shell: false, env: { ...policy.env } as Record<string, string>,
      detached: true, stdio: ["ignore", "pipe", "pipe"] } };
  const native = vi.fn<(command: string, argv: string[], options: ReturnType<typeof admitSpawn>["options"]) => void>();
  const forward = (afterCapture: () => void = () => {}): ReturnType<typeof admitSpawn> => {
    const captured = admitSpawn(input.command, input.argv, input.options, policy);
    afterCapture();
    native(captured.executable, captured.argv, captured.options);
    return captured;
  };
  return { policy, input, native, forward };
}

describe("S12 guard snapshots without native execution", () => {
  it("reconstructs only owned plain options, argv, stdio and environment", () => {
    const s = syntheticGuard();
    const captured = s.forward();
    expect(s.native).toHaveBeenCalledExactlyOnceWith(s.policy.executable, s.policy.argv,
      { cwd: s.policy.cwd, shell: false, env: s.policy.env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    expect(captured.argv).not.toBe(s.input.argv);
    expect(captured.options).not.toBe(s.input.options);
    expect(captured.options.env).not.toBe(s.input.options.env);
    expect(captured.options.stdio).not.toBe(s.input.options.stdio);
    expect(Object.getPrototypeOf(captured.options)).toBe(Object.prototype);
    expect(Object.getPrototypeOf(captured.options.env)).toBe(Object.prototype);
  });

  it.each([true, false])("consumes a changing argv iterator once (first valid: %s)", valid => {
    const s = syntheticGuard();
    let calls = 0;
    Object.defineProperty(s.input.argv, Symbol.iterator, { value: () => {
      calls++;
      return (calls === 1 && valid ? [...s.policy.argv] : ["changed"])[Symbol.iterator]();
    } });
    if (valid) {
      s.forward();
      expect(s.native).toHaveBeenCalledTimes(1);
      expect(s.native.mock.calls[0]?.[1]).toEqual(s.policy.argv);
    } else { expect(() => s.forward()).toThrow(); expect(s.native).not.toHaveBeenCalled(); }
    expect(calls).toBe(1);
  });

  it.each(["cwd", "shell", "env"] as const)("reads changing %s only once", key => {
    const s = syntheticGuard();
    const good = s.input.options[key];
    let reads = 0;
    Object.defineProperty(s.input.options, key, { get: () => {
      reads++;
      return reads === 1 ? good : key === "shell" ? true : key === "cwd" ? "/synthetic/changed" : { NODE_OPTIONS: "changed" };
    } });
    const captured = s.forward();
    expect(reads).toBe(1);
    expect(captured.options).toEqual({ cwd: s.policy.cwd, shell: false, env: s.policy.env,
      detached: true, stdio: ["ignore", "pipe", "pipe"] });
    expect(s.native).toHaveBeenCalledTimes(1);
  });

  it.each(["getter", "proxy"] as const)("materializes environment %s values once", kind => {
    const s = syntheticGuard();
    const reads = new Map<string, number>();
    if (kind === "getter") {
      Object.defineProperty(s.input.options.env, "LANG", { enumerable: true, get: () => {
        const count = (reads.get("LANG") ?? 0) + 1;
        reads.set("LANG", count);
        return count === 1 ? "C" : "changed";
      } });
    } else {
      s.input.options.env = new Proxy(s.input.options.env, { get: (target, key) => {
        if (typeof key !== "string") return undefined;
        const count = (reads.get(key) ?? 0) + 1;
        reads.set(key, count);
        return count === 1 ? target[key] : "changed";
      } });
    }
    expect(s.forward().options.env).toEqual(s.policy.env);
    expect([...reads.values()].every(count => count === 1)).toBe(true);
    expect(reads.get("LANG")).toBe(1);
    expect(s.native).toHaveBeenCalledTimes(1);
  });

  it("caller mutation after validation cannot change the forwarded snapshot", () => {
    const s = syntheticGuard();
    const captured = s.forward(() => {
      s.input.command = "changed";
      s.input.argv.splice(0, 1, "changed");
      s.input.options.cwd = "/synthetic/changed";
      s.input.options.shell = true;
      s.input.options.env.LANG = "changed";
      s.input.options.env.NODE_OPTIONS = "changed";
      s.input.options.stdio[0] = "inherit";
    });
    expect(s.native).toHaveBeenCalledExactlyOnceWith(s.policy.executable, s.policy.argv,
      { cwd: s.policy.cwd, shell: false, env: s.policy.env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    expect(captured.argv).toEqual(s.policy.argv);
  });

  it.each(["argv", "cwd", "env-entry", "env-proxy", "stdio"] as const)("%s exception rejects before forwarding", site => {
    const s = syntheticGuard();
    const injected = new Error(`Synthetic ${site} failure`);
    const fail = (): never => { throw injected; };
    if (site === "argv") Object.defineProperty(s.input.argv, Symbol.iterator, { value: fail });
    else if (site === "env-entry") Object.defineProperty(s.input.options.env, "LANG", { get: fail });
    else if (site === "env-proxy") s.input.options.env = new Proxy(s.input.options.env, { ownKeys: fail });
    else Object.defineProperty(s.input.options, site, { get: fail });
    expect(() => s.forward()).toThrow(injected);
    expect(s.native).not.toHaveBeenCalled();
  });

  it.each(["command", "argv", "cwd", "shell", "env", "detached", "missing-detached", "extra", "sparse"] as const)("rejects invalid captured %s without forwarding", site => {
    const s = syntheticGuard();
    let coerced = 0;
    if (site === "command") s.input.command = { toString: () => { coerced++; return s.policy.executable; } };
    else if (site === "argv") s.input.argv.push("changed");
    else if (site === "cwd") s.input.options.cwd = "/synthetic/changed";
    else if (site === "shell") s.input.options.shell = true;
    else if (site === "env") s.input.options.env.NODE_OPTIONS = "changed";
    else if (site === "detached") s.input.options.detached = false;
    else if (site === "missing-detached") Reflect.deleteProperty(s.input.options, "detached");
    else if (site === "extra") Object.defineProperty(s.input.options, "uid", { value: 0 });
    else s.input.argv = new Array<string>(1);
    expect(() => s.forward()).toThrow();
    expect(s.native).not.toHaveBeenCalled();
    expect(coerced).toBe(0);
  });
});

describe("S12 acquisition and restoration regressions", () => {
  it("token generation failure precedes allocation and every child launch", async () => {
    const injected = new Error("Injected support token failure");
    const random = vi.spyOn(crypto, "randomBytes").mockImplementation(() => { throw injected; });
    const allocation = vi.spyOn(fs, "mkdtemp");
    const oldPath = process.env.PATH;
    const oldSpawn = childProcess.spawn;
    try {
      syncBuiltinESMExports();
      const rejected = await failure("none");
      expect(rejected.errors).toEqual([injected]);
      expect(allocation).not.toHaveBeenCalled();
      expect(rejected.proof.acquiredSupportPath).toBeNull();
      expect(rejected.proof.roots).toEqual([]);
      expect(rejected.proof.twinRoots).toEqual([]);
      expect(rejected.proof.sessions).toEqual([]);
      expect(rejected.proof.launches).toEqual([]);
      expect(rejected.proof.afterRoots).toEqual(rejected.proof.beforeRoots);
      expect(rejected.proof.registeredSupports).toEqual([]);
      expect(childProcess.spawn).toBe(oldSpawn);
      expect(process.env.PATH).toBe(oldPath);
    } finally { random.mockRestore(); allocation.mockRestore(); syncBuiltinESMExports(); }
  });

  it.each([true, false])("exhaustive restoration preserves earlier errors (existing failures: %s)", priorFailures => {
    const primary = new Error("Synthetic primary"), cleanup = new Error("Synthetic cleanup"), accounting = new Error("Synthetic accounting");
    const earlyRestore = new Error("Synthetic early restore"), syncError = new Error("Synthetic synchronization result");
    const errors: unknown[] = priorFailures ? [primary, cleanup, accounting] : [];
    const calls: string[] = [];
    const oldSpawn = childProcess.spawn, oldExec = childProcess.exec, oldPath = process.env.PATH;
    const spawn = vi.spyOn(childProcess, "spawn").mockImplementation(() => { throw new Error("Synthetic test never launches"); });
    const exec = vi.spyOn(childProcess, "exec").mockImplementation(() => { throw new Error("Synthetic test never launches"); });
    const restorePath = (): void => { if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath; };
    try {
      process.env.PATH = "/synthetic/restoration-only";
      syncBuiltinESMExports();
      try {
        // No real proof or command is run: exercise the same restoration/finalization functions.
      } finally {
        restoreAll([
          () => { calls.push("spawn"); spawn.mockRestore(); throw earlyRestore; },
          () => { calls.push("exec"); exec.mockRestore(); },
          () => { calls.push("PATH"); restorePath(); },
        ], errors, () => { calls.push("sync"); syncBuiltinESMExports(); throw syncError; });
      }
      expect(calls).toEqual(["spawn", "exec", "PATH", "sync"]);
      expect(errors).toEqual(priorFailures ? [primary, cleanup, accounting, earlyRestore, syncError] : [earlyRestore, syncError]);
      expect(childProcess.spawn).toBe(oldSpawn);
      expect(childProcess.exec).toBe(oldExec);
      expect(process.env.PATH).toBe(oldPath);
      const proof: Proof = { fault: "none", events: [], roots: [], acquiredSupportPath: null, twinRoots: [], sessions: [], launches: [],
        beforeRoots: [], afterRoots: [], remainingTwinRoots: [], registeredSupports: [], result: null };
      try { completeProof(proof, errors); throw new Error("Expected restoration failure"); }
      catch (error: unknown) {
        expect(error).toBeInstanceOf(ProofFailure);
        if (!(error instanceof ProofFailure)) throw error;
        expect(error.errors).toEqual(errors);
        expect(error.cause).toBe(priorFailures ? primary : earlyRestore);
      }
    } finally {
      // Failures are injected only after the real restoration; this backup also
      // protects the worker if a test assertion fails before that sequence.
      spawn.mockRestore(); exec.mockRestore(); restorePath(); syncBuiltinESMExports();
    }
  });
});
