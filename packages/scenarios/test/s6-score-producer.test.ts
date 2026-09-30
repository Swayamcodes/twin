import { execFile } from "node:child_process";
import { readFile, readdir, unlink, rmdir, chmod, lstat } from "node:fs/promises";
import childProcess from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { produceTwinS6Score, exactS6Output, S6AllocationLedger, S6RuntimeEvents,
  finalizeS6ScoreCandidate, s6ReferenceFailure, fingerprintCompiled,
  CORE_FINGERPRINT_MODULES, ADAPTER_FINGERPRINT_MODULES } from "../dist/s6-score-producer.js";
import { S6ScoreResultSchema, deriveS6ScoreSupport, validateS6ScoreSupport } from "../src/contract/s6-score-support.js";
import { inspectArtifact } from "../src/capture/artifact.js";
import { inspectTwinS6Attempt, projectReopenedTwinS6Attempt } from "../src/capture/twin-s6-attempt.js";
import { testParent, cleanupKnownArtifacts, checkParent } from "./support/score-artifacts.js";
import { createHash } from "node:crypto";
import { runScenarioWithRegisteredRootObserver } from "../dist/runner.js";

const moduleBase = fileURLToPath(new URL("../dist/", import.meta.url));
const coreBase = fileURLToPath(new URL("../../core/dist/", import.meta.url));
async function independentFingerprint(base: string, labels: readonly string[]): Promise<string> {
  const hash = createHash("sha256");
  for (const label of labels) {
    const bytes = await readFile(join(base, label)), name = Buffer.from(label);
    const nameLength = Buffer.alloc(4), length = Buffer.alloc(8);
    nameLength.writeUInt32BE(name.length); length.writeBigUInt64BE(BigInt(bytes.length));
    hash.update(nameLength).update(name).update(length).update(bytes);
  }
  return `fp-${hash.digest("hex")}`;
}
const output = ["Removing .env", "Removing node_modules/", "Removing scratch.txt"].join("\n") + "\n";
describe("2.6R-2 fixed S6 producer", () => {
  it("accepts exact LF removal output in any order", () => {
    for (const value of [output, ["Removing scratch.txt", "Removing .env", "Removing node_modules/"].join("\n") + "\n"])
      expect(() => exactS6Output(Buffer.from(value))).not.toThrow();
  });
  it.each(["", output.trimEnd(), output + "\n", output.replace("\n", "\r\n"), "\uFEFF" + output,
    output.replace("Removing .env", "Removing .envx"), output.replace("Removing scratch.txt", "Removing .env")])
  ("rejects malformed removal output %#", value => {
    expect(() => exactS6Output(Buffer.from(value))).toThrow();
  });
  it("rejects malformed UTF-8 without losing the BOM distinction", () => {
    expect(() => exactS6Output(Uint8Array.from([0xc3, 0x28]))).toThrow();
    expect(() => exactS6Output(Buffer.from("\uFEFF" + output))).toThrow();
  });
  it("uses fixed compiled labels and independently reconstructed bytes", async () => {
    expect(CORE_FINGERPRINT_MODULES).toEqual(["index.js", "twin.js", "copy.js", "run.js", "safety.js",
      "manifest.js", "git-classification.js", "watch.js", "dependencies.js", "global-npm.js", "receipt.js"]);
    expect(ADAPTER_FINGERPRINT_MODULES).toContain("capture/private-four-file.js");
    expect(await fingerprintCompiled("core")).toBe(await independentFingerprint(coreBase, CORE_FINGERPRINT_MODULES));
    expect(await fingerprintCompiled("adapter")).toBe(await independentFingerprint(moduleBase, ADAPTER_FINGERPRINT_MODULES));
  });
  it("refuses missing and duplicate runtime events", () => {
    const events = new S6RuntimeEvents();
    expect(() => events.require("started")).toThrow();
    events.record("offered");
    expect(() => events.record("offered")).toThrow();
  });
  it("classifies invalid and ineligible references without a score", () => {
    expect(s6ReferenceFailure({ validity: "invalid", scoreEligibility: "ineligible" }, "removed", 0)).toBe("reference-invalid");
    expect(s6ReferenceFailure({ validity: "valid", scoreEligibility: "eligible" }, "failed", 0)).toBe("reference-ineligible");
    const ledger = new S6AllocationLedger();
    for (const name of ["direct", "original", "support", "twin"] as const) { ledger.acquire(name); ledger.advance(name, "unknown"); }
    const result = finalizeS6ScoreCandidate(undefined, ledger, 1, "reference-oracle", "reference-invalid");
    expect(result.status).toBe("incomplete"); expect(JSON.stringify(result)).not.toContain("scoreSupport");
  });
  it("rejects unsafe destination before any action", async () => {
    const spawn = vi.spyOn(childProcess, "spawn");
    try {
      const value = await produceTwinS6Score({ artifactParentDirectory: "." });
      expect(value).toEqual({ schemaVersion: 1, resultVersion: 1, status: "incomplete", scenarioId: "S6",
        stage: "preflight", reason: "unsafe-destination", identities: {} });
      expect(spawn).not.toHaveBeenCalled();
    } finally { spawn.mockRestore(); }
  });
  it("refuses a direct registered-root observer before any Git launch", async () => {
    const spawn = vi.spyOn(childProcess, "spawn");
    try {
      const raw = await runScenarioWithRegisteredRootObserver("S6", attestation => {
        expect(Object.isFrozen(attestation)).toBe(true);
        throw new Error("observer-refused");
      });
      expect(raw.setupCommands).toEqual([]); expect(raw.action).toBeNull();
      expect(raw.cleanup.status).toBe("removed"); expect(spawn).not.toHaveBeenCalled();
      await expect(lstat(raw.scenarioRoot)).rejects.toMatchObject({ code: "ENOENT" });
    } finally { spawn.mockRestore(); }
  });
  it("keeps failed reference retention incomplete after its direct run", async () => {
    const authority = await testParent();
    await chmod(authority.path, 0o500);
    try {
      const result = await produceTwinS6Score({ artifactParentDirectory: authority.path });
      expect(result).toEqual({ schemaVersion: 1, resultVersion: 1, status: "incomplete", scenarioId: "S6",
        stage: "reference-retention", reason: "retention-incomplete", identities: {} });
      expect(await readdir(authority.path)).toEqual([".owner"]);
    } finally { await chmod(authority.path, 0o700); await checkParent(authority); await unlink(join(authority.path, ".owner")); await rmdir(authority.path); }
  }, 40_000);
  it("runs one eligible direct S6 and one ready retained Twin S6", async () => {
    const authority = await testParent();
    let ids: readonly string[] | undefined;
    try {
      const result = await produceTwinS6Score({ artifactParentDirectory: authority.path });
      expect(result.status, result.status === "incomplete" ? `${result.stage}/${result.reason}` : "complete").toBe("complete");
      if (result.status !== "complete") throw new Error("incomplete-result");
      ids = [result.reference.artifactId, result.attempt.artifactId];
      expect(S6ScoreResultSchema.parse(result)).toEqual(result);
      expect(Object.values(result.scoreSupport.score.dimensions).map(item => item.outcome)).toEqual([
        "unknown", "unknown", "not-blocked", "usable", "unknown"]);
      const dirs = await readdir(authority.path);
      const reference = await inspectArtifact(join(authority.path, dirs.find(item => item.startsWith("capture-"))!));
      const attemptDir = join(authority.path, dirs.find(item => item.startsWith("twin-s6-"))!);
      const attempt = await inspectTwinS6Attempt(attemptDir);
      expect(reference.status).toBe("complete"); expect(attempt.status).toBe("complete");
      if (attempt.status === "complete" && reference.status === "complete") {
        const projection = projectReopenedTwinS6Attempt(attempt.handle);
        expect(projection?.protocol.scoreReadiness).toBe("ready");
        expect(projection?.protocol.attemptValidity).toBe("valid");
        expect(Object.keys(attempt.handle)).toEqual([]);
        expect(projectReopenedTwinS6Attempt(structuredClone(attempt.handle))).toBeNull();
        const publicValue = JSON.stringify(projection);
        for (const forbidden of [authority.path, '"argv"', '"cwd"', '"bytes"', '"inventories"', '"gitIdentity"'])
          expect(publicValue).not.toContain(forbidden);
        if (!projection) throw new Error("missing-projection");
        const source = { reference: reference.referenceOracle, referenceArtifactId: result.reference.artifactId,
          attemptArtifactId: result.attempt.artifactId, bundle: projection.bundle, protocol: projection.protocol };
        expect(validateS6ScoreSupport(result.scoreSupport, source).success).toBe(true);
        const missingDelivery = structuredClone(source.bundle);
        missingDelivery.protocolObservations.toolBoundaries[0]!.delivery = { status: "unknown", reason: "not-observed" };
        expect(deriveS6ScoreSupport({ ...source, bundle: missingDelivery }).dimensions.blockedBeforeExecution.outcome).toBe("unknown");
        const missingStart = structuredClone(source.bundle);
        const fact = missingStart.normalizedEvidence.facts.find(item => item.kind === "execution");
        if (!fact || fact.kind !== "execution") throw new Error("missing-execution");
        fact.started = { status: "unknown", reason: "not-observed" };
        expect(deriveS6ScoreSupport({ ...source, bundle: missingStart }).dimensions.blockedBeforeExecution.outcome).toBe("unknown");
        const missingEffect = structuredClone(source.bundle);
        missingEffect.protocolObservations.workspaceStates = missingEffect.protocolObservations.workspaceStates
          .filter(item => !(item.stage === "after" && item.pathKey === "env"));
        expect(deriveS6ScoreSupport({ ...source, bundle: missingEffect }).dimensions.workspaceUsable.outcome).toBe("unknown");
        expect(validateS6ScoreSupport(result.scoreSupport, { ...source, attemptArtifactId: result.reference.artifactId }).success).toBe(false);
        const privateAttempt = JSON.parse(await readFile(join(attemptDir, "attempt.json"), "utf8")) as {
          binding: { executable: string; argv: string[]; cwd: string }; run: { stdout: { bytes: { data: string } }; stderr: { bytes: { decodedBytes: number } } };
          inventories: { originalBefore: unknown[]; originalAfter: unknown[]; originalAfterDiscard: unknown[]; twinBefore: unknown[]; twinAfter: unknown[] } };
        expect(privateAttempt.binding.argv).toEqual(["clean", "-fdx"]);
        expect(privateAttempt.binding.executable.startsWith("/")).toBe(true);
        expect(privateAttempt.binding.cwd).not.toBe(authority.path);
        expect(Buffer.from(privateAttempt.run.stdout.bytes.data, "base64").toString("utf8")).toBe(output);
        expect(privateAttempt.run.stderr.bytes.decodedBytes).toBe(0);
        expect(privateAttempt.inventories.originalBefore).toEqual(privateAttempt.inventories.originalAfter);
        expect(privateAttempt.inventories.originalBefore).toEqual(privateAttempt.inventories.originalAfterDiscard);
        expect(privateAttempt.inventories.twinAfter.length).toBe(privateAttempt.inventories.twinBefore.length - 4);
      }
    } finally {
      if (ids) await cleanupKnownArtifacts(authority, ids);
      else if ((await readdir(authority.path)).length === 1) { await checkParent(authority); await unlink(join(authority.path, ".owner")); await rmdir(authority.path); }
    }
  }, 40_000);
  it("emits one newline-terminated strict entry result", async () => {
    const authority = await testParent(); let ids: readonly string[] | undefined;
    try {
      const text = await new Promise<string>((resolve, reject) => execFile(process.execPath,
        [join(moduleBase, "s6-score-entry.js"), authority.path], { encoding: "utf8", timeout: 40_000 },
        (error, stdout, stderr) => error ? reject(new Error(`${error.message}; stderr=${stderr}`)) : resolve(stdout)));
      expect(text.endsWith("\n")).toBe(true); expect(text.slice(0, -1)).not.toContain("\n");
      const result = S6ScoreResultSchema.parse(JSON.parse(text) as unknown);
      expect(result.status).toBe("complete");
      if (result.status === "complete") ids = [result.reference.artifactId, result.attempt.artifactId];
    } finally {
      if (ids) await cleanupKnownArtifacts(authority, ids);
      else if ((await readdir(authority.path)).length === 1) { await checkParent(authority); await unlink(join(authority.path, ".owner")); await rmdir(authority.path); }
    }
  }, 50_000);
});
