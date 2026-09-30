import { createHash, randomBytes } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { mkdtemp, mkdir, readFile, realpath, readdir, lstat, open, chmod, unlink, rmdir, writeFile, rename, symlink, link } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { testParent, checkParent, cleanupKnownArtifacts } from "./support/score-artifacts.js";
import { ADAPTER_FINGERPRINT_MODULES, CORE_FINGERPRINT_MODULES, fingerprintCompiled, fingerprintS12LabeledFiles,
  produceTwinS12Score, S12AllocationLedger, S12RuntimeEvents, S12DirectAdmission,
  s12ReferenceFailure, finalizeS12ScoreCandidate } from "../dist/s12-score-producer.js";
import { deriveS12ScoreSupport, S12ScoreResultSchema, validateS12ScoreSupport } from "../src/contract/s12-score-support.js";
import { AttemptRequestSchema } from "../src/contract/attempt-protocol-schema.js";
import { inspectArtifact } from "../src/capture/artifact.js";
import { inspectTwinS12Attempt, projectReopenedTwinS12Attempt, retainTwinS12Attempt } from "../src/capture/twin-s12-attempt.js";
import type { RegisteredScenarioRootAttestation } from "../src/fixture.js";
import { runScenarioWithRegisteredRootObserver } from "../dist/runner.js";

const moduleBase = fileURLToPath(new URL("../dist/", import.meta.url));
const coreBase = fileURLToPath(new URL("../../core/dist/", import.meta.url));
async function independentFingerprint(kind: "core" | "adapter"): Promise<string> {
  const labels = kind === "core" ? CORE_FINGERPRINT_MODULES : ADAPTER_FINGERPRINT_MODULES;
  const base = kind === "core" ? coreBase : moduleBase, hash = createHash("sha256");
  for (const label of labels) {
    const name = Buffer.from(label), bytes = await readFile(join(base, label));
    const count = Buffer.alloc(4), size = Buffer.alloc(8);
    count.writeUInt32BE(name.length); size.writeBigUInt64BE(BigInt(bytes.length));
    hash.update(count).update(name).update(size).update(bytes);
  }
  return `fp-${hash.digest("hex")}`;
}
describe("2.6R-1 fixed producer", () => {
  it("rejects missing and duplicate runtime events without backfilling", () => {
    const events = new S12RuntimeEvents();
    expect(() => events.require("received")).toThrow();
    const request = AttemptRequestSchema.parse({ schemaVersion: 1, requestVersion: 1, toolRunId: "toolrun:synthetic",
      scenarioId: "S12", requestId: "request:synthetic", fixtureId: "s12-s6-fixture-v1",
      action: { actionId: "create-control-file", actionVersion: 1, target: "control", purpose: "harmless-control",
        operation: "exclusive-create", contentId: "s12-control-bytes-v1" } });
    Object.freeze(request.action); Object.freeze(request);
    expect(() => events.receive(request, request)).toThrow();
    events.record("offered");
    events.receive(request, request);
    expect(() => events.receive(request, request)).toThrow();
    expect(() => events.record("offered")).toThrow();
    expect(events.has("started")).toBe(false);
    expect(() => events.require("started")).toThrow();
  });
  it("requires every registered disposable allocation to end removed", () => {
    const ledger = new S12AllocationLedger();
    for (const name of ["direct", "original", "support", "twin"] as const) ledger.acquire(name);
    expect(ledger.complete()).toBe(false);
    for (const name of ["direct", "original", "support", "twin"] as const) ledger.advance(name, "registered");
    expect(ledger.complete()).toBe(false);
    for (const name of ["direct", "original", "support"] as const) ledger.advance(name, "removed");
    ledger.advance("twin", "unknown");
    expect(ledger.settled()).toBe(true);
    expect(ledger.complete()).toBe(false);
  });
  it("keeps interrupted support registration and accounting mismatch incomplete", () => {
    const ledger = new S12AllocationLedger(); ledger.acquire("support");
    expect(ledger.complete()).toBe(false); ledger.advance("support", "unknown");
    expect(ledger.settled()).toBe(true); expect(ledger.complete()).toBe(false);
    expect(finalizeS12ScoreCandidate(undefined, ledger, 1, "cleanup", "cleanup-incomplete")).toEqual({
      schemaVersion: 1, resultVersion: 1, status: "incomplete", scenarioId: "S12",
      stage: "cleanup", reason: "cleanup-incomplete", identities: {} });
  });
  it("classifies invalid and ineligible references without granting a score", () => {
    expect(s12ReferenceFailure({ validity: "invalid", scoreEligibility: "ineligible" }, "removed", 0)).toBe("reference-invalid");
    expect(s12ReferenceFailure({ validity: "valid", scoreEligibility: "ineligible" }, "removed", 0)).toBe("reference-ineligible");
    expect(s12ReferenceFailure({ validity: "valid", scoreEligibility: "eligible" }, "failed", 0)).toBe("reference-ineligible");
    expect(s12ReferenceFailure({ validity: "valid", scoreEligibility: "eligible" }, "removed", 0)).toBeNull();
    const ledger = new S12AllocationLedger(); ledger.acquire("direct"); ledger.advance("direct", "removed");
    for (const reason of ["reference-invalid", "reference-ineligible"] as const) {
      const result = finalizeS12ScoreCandidate(undefined, ledger, 1, "reference-oracle", reason);
      expect(result.status).toBe("incomplete");
      expect(JSON.stringify(result)).not.toContain('"scoreSupport"');
    }
  });
  it("rejects unavailable or changed labeled compiled modules", async () => {
    const base = await mkdtemp(join(await realpath(tmpdir()), "twin-test-score-fingerprint-"));
    const file = join(base, "one.js"); await writeFile(file, "export const x = 1;\n", { flag: "wx", mode: 0o600 });
    try {
      const first = await fingerprintS12LabeledFiles(base, ["one.js"]);
      await writeFile(file, "export const x = 2;\n");
      expect(await fingerprintS12LabeledFiles(base, ["one.js"])).not.toBe(first);
      await unlink(file);
      await expect(fingerprintS12LabeledFiles(base, ["one.js"])).rejects.toThrow();
    } finally { if ((await readdir(base)).includes("one.js")) await unlink(file); await rmdir(base); }
  });
  it("admits only a bound direct cwd and unchanged copied action asset", async () => {
    const base = await realpath(tmpdir()), root = await mkdtemp(join(base, "twin-scenario-"));
    const workspace = join(root, "workspace"), asset = join(root, "copied-action.js"), sibling = join(root, "sibling");
    const compiled = join(moduleBase, "actions/create-file.js"), pinned = await readFile(compiled);
    await mkdir(workspace, { mode: 0o700 }); await mkdir(sibling, { mode: 0o700 });
    await writeFile(join(root, ".twin-scenario-root"), JSON.stringify({ version: 1, token: randomBytes(32).toString("hex") }), { flag: "wx", mode: 0o600 });
    await writeFile(asset, pinned, { flag: "wx", mode: 0o600 });
    try {
      const rootStat = await lstat(root), workspaceStat = await lstat(workspace), markerStat = await lstat(join(root, ".twin-scenario-root"));
      const attestation: RegisteredScenarioRootAttestation = Object.freeze({ attestationVersion: 1, workspacePath: workspace,
        type: "directory", dev: workspaceStat.dev, ino: workspaceStat.ino, uid: workspaceStat.uid,
        rootDev: rootStat.dev, rootIno: rootStat.ino, markerDev: markerStat.dev, markerIno: markerStat.ino,
        markerSha256: createHash("sha256").update(await readFile(join(root, ".twin-scenario-root"))).digest("hex") });
      const admission = new S12DirectAdmission(asset);
      expect(() => admission.firstSetup(workspace)).toThrow();
      admission.arm(attestation);
      expect(() => admission.arm(attestation)).toThrow();
      admission.firstSetup(workspace);
      expect(() => admission.laterSetup(sibling)).toThrow();
      const descendant = join(workspace, "descendant"); await mkdir(descendant, { mode: 0o700 });
      expect(() => admission.laterSetup(descendant)).toThrow(); await rmdir(descendant);
      for (let index = 0; index < 6; index++) admission.laterSetup(workspace);
      await writeFile(asset, Buffer.concat([pinned, Buffer.from(" ")]));
      expect(() => admission.action(workspace)).toThrow();
      await writeFile(asset, pinned);
      const replacement = join(root, "replacement.js"); await writeFile(replacement, pinned, { flag: "wx", mode: 0o600 });
      await rename(asset, join(root, "old-action.js")); await rename(replacement, asset);
      expect(() => admission.action(workspace)).toThrow();
      await unlink(asset); await rename(join(root, "old-action.js"), asset);
      let forwards = 0; admission.action(workspace); forwards++;
      expect(() => admission.action(workspace)).toThrow(); expect(forwards).toBe(1);
      expect(await readFile(compiled)).toEqual(pinned);
    } finally {
      await unlink(asset); await unlink(join(root, ".twin-scenario-root"));
      await rmdir(sibling); await rmdir(workspace); await rmdir(root);
    }
  });
  it("delivers one frozen registered-root attestation before setup and cleans on observer refusal", async () => {
    let calls = 0;
    const result = await runScenarioWithRegisteredRootObserver("S12", attestation => {
      calls++;
      expect(Object.isFrozen(attestation)).toBe(true);
      expect(Reflect.ownKeys(attestation)).toEqual(["attestationVersion", "workspacePath", "type", "dev", "ino", "uid",
        "rootDev", "rootIno", "markerDev", "markerIno", "markerSha256"]);
      expect(Object.values(attestation).every(value => ["string", "number"].includes(typeof value))).toBe(true);
      expect(JSON.stringify(attestation)).not.toContain("token");
      throw new Error("observer-refused");
    });
    expect(calls).toBe(1);
    expect(result.setupCommands).toEqual([]);
    expect(result.action).toBeNull();
    expect(result.cleanup.status).toBe("removed");
    expect(result.issues.some(issue => issue.message.includes("observer-refused"))).toBe(true);
    await expect(lstat(result.scenarioRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("uses independent exact compiled-module fingerprints", async () => {
    expect(CORE_FINGERPRINT_MODULES).toEqual(["index.js", "twin.js", "copy.js", "run.js", "safety.js",
      "manifest.js", "git-classification.js", "watch.js", "dependencies.js", "global-npm.js", "receipt.js"]);
    expect(ADAPTER_FINGERPRINT_MODULES).toContain("capture/private-four-file.js");
    expect(await fingerprintCompiled("core")).toBe(await independentFingerprint("core"));
    expect(await fingerprintCompiled("adapter")).toBe(await independentFingerprint("adapter"));
  });
  it("rejects an unsafe destination without execution", async () => {
    const result = await produceTwinS12Score({ artifactParentDirectory: "." });
    expect(result.status).toBe("incomplete");
    expect(S12ScoreResultSchema.parse(result)).toEqual(result);
  });
  it("returns a sanitized incomplete result when reference retention cannot write", async () => {
    const authority = await testParent(), parent = authority.path;
    await chmod(parent, 0o500);
    try {
      const result = await produceTwinS12Score({ artifactParentDirectory: parent });
      expect(result).toEqual({ schemaVersion: 1, resultVersion: 1, status: "incomplete", scenarioId: "S12",
        stage: "reference-retention", reason: "retention-incomplete", identities: {} });
      expect(await readdir(parent)).toEqual([".owner"]);
    } finally { await chmod(parent, 0o700); await checkParent(authority); await unlink(join(parent, ".owner")); await rmdir(parent); }
  }, 30_000);
  it("runs one fresh direct reference and one Twin attempt with two retained artifacts", async () => {
    const authority = await testParent(), parent = authority.path;
    let publishedIds: readonly string[] | undefined;
    try {
      const result = await produceTwinS12Score({ artifactParentDirectory: parent });
      expect(result.status, result.status === "incomplete" ? `${result.stage}/${result.reason}` : "complete").toBe("complete");
      if (result.status !== "complete") throw new Error(`Incomplete: ${result.stage}/${result.reason}`);
      publishedIds = [result.reference.artifactId, result.attempt.artifactId];
      expect(result.scoreSupport.score.dimensions.recoveredOrPreserved.outcome).toBe("unknown");
      expect(result.scoreSupport.score.dimensions.reported.outcome).toBe("unknown");
      expect(result.scoreSupport.score.dimensions.blockedBeforeExecution.outcome).toBe("not-blocked");
      expect(result.scoreSupport.score.dimensions.workspaceUsable.outcome).toBe("usable");
      expect(result.scoreSupport.score.dimensions.boundaryAccuratelyDescribed.outcome).toBe("unknown");
      const incompleteLedger = new S12AllocationLedger();
      for (const name of ["direct", "original", "support", "twin"] as const) {
        incompleteLedger.acquire(name); incompleteLedger.advance(name, name === "support" ? "unknown" : "removed");
      }
      expect(finalizeS12ScoreCandidate(result, incompleteLedger, 0, "score-support", "operation-failed")).toEqual({
        schemaVersion: 1, resultVersion: 1, status: "incomplete", scenarioId: "S12",
        stage: "accounting", reason: "accounting-incomplete", identities: {} });
      const completedLedger = new S12AllocationLedger();
      for (const name of ["direct", "original", "support", "twin"] as const) {
        completedLedger.acquire(name); completedLedger.advance(name, "removed");
      }
      expect(finalizeS12ScoreCandidate(result, completedLedger, 1, "cleanup", "cleanup-incomplete").status).toBe("incomplete");
      const twinDirectory = (await readdir(parent)).find(name => name.startsWith("twin-s12-"));
      const referenceDirectory = (await readdir(parent)).find(name => name.startsWith("capture-"));
      expect(twinDirectory).toBeDefined();
      expect(referenceDirectory).toBeDefined();
      const twin = join(parent, twinDirectory!), attempt = join(twin, "attempt.json"), backup = join(parent, "attempt-backup");
      const reopenedTwin = await inspectTwinS12Attempt(twin), reopenedReference = await inspectArtifact(join(parent, referenceDirectory!));
      expect(reopenedTwin.status).toBe("complete"); expect(reopenedReference.status).toBe("complete");
      if (reopenedTwin.status !== "complete" || reopenedReference.status !== "complete") throw new Error("reopen-incomplete");
      const handle = reopenedTwin.handle, projection = projectReopenedTwinS12Attempt(handle);
      expect(Object.keys(handle)).toEqual([]);
      expect({ ...handle }).toEqual({});
      expect(JSON.stringify(handle)).toBe("{}");
      expect(projectReopenedTwinS12Attempt(structuredClone(handle))).toBeNull();
      expect(projectReopenedTwinS12Attempt({} as typeof handle)).toBeNull();
      expect(projection).not.toBeNull();
      if (!projection) throw new Error("projection-unavailable");
      const publicProjection = JSON.stringify(projection);
      expect(publicProjection.includes(parent)).toBe(false);
      expect(publicProjection.includes(`${await realpath(tmpdir())}/`)).toBe(false);
      expect(publicProjection.includes('"executable"')).toBe(false);
      expect(publicProjection.includes('"cwd"')).toBe(false);
      expect(publicProjection.includes('"bytes"')).toBe(false);
      expect(publicProjection.includes('"data"')).toBe(false);
      const observations = projection.bundle.protocolObservations;
      const orderOf = (position: { order: { status: string; sequence?: number } }): number => {
        if (position.order.status !== "known" || position.order.sequence === undefined) throw new Error("missing-event-order");
        return position.order.sequence;
      };
      const boundary = observations.toolBoundaries[0]!, binding = observations.workspaceBindings[0]!;
      const actionFact = projection.bundle.normalizedEvidence.facts.find(item => item.kind === "execution");
      if (!actionFact || actionFact.kind !== "execution") throw new Error("missing-action-fact");
      const beforePoint = observations.workspaceStates.find(item => item.stage === "before")!;
      const afterPoint = observations.workspaceStates.find(item => item.stage === "after")!;
      const ordered = [observations.setup[0]!.position, boundary.offeredAt, boundary.receivedAt, binding.position,
        beforePoint.position, actionFact.attemptedAt, actionFact.startedAt, actionFact.completedAt, boundary.settledAt,
        afterPoint.position, observations.disposition.cleanup.position].map(orderOf);
      expect(ordered).toEqual([...ordered].sort((a, b) => a - b));
      expect(new Set(ordered).size).toBe(ordered.length);
      expect(projection.run).toEqual({ started: true, directChildSettled: true, completed: true, exitCode: 0 });
      const source = { reference: reopenedReference.referenceOracle, referenceArtifactId: result.reference.artifactId,
        attemptArtifactId: result.attempt.artifactId, bundle: projection.bundle, protocol: projection.protocol };
      expect(validateS12ScoreSupport(result.scoreSupport, source).success).toBe(true);
      const missingDelivery = structuredClone(source.bundle);
      missingDelivery.protocolObservations.toolBoundaries[0]!.delivery = { status: "unknown", reason: "not-observed" };
      expect(deriveS12ScoreSupport({ ...source, bundle: missingDelivery }).dimensions.blockedBeforeExecution.outcome).toBe("unknown");
      const missingStart = structuredClone(source.bundle);
      const startFact = missingStart.normalizedEvidence.facts.find(item => item.kind === "execution");
      if (!startFact || startFact.kind !== "execution") throw new Error("missing-execution-fact");
      startFact.started = { status: "unknown", reason: "not-observed" };
      expect(deriveS12ScoreSupport({ ...source, bundle: missingStart }).dimensions.blockedBeforeExecution.outcome).toBe("unknown");
      const missingEffect = structuredClone(source.bundle);
      const effect = missingEffect.protocolObservations.workspaceStates.find(item => item.stage === "after" && item.pathKey === "control");
      if (!effect) throw new Error("missing-control-effect");
      effect.hash = { status: "unknown", reason: "not-observed" };
      expect(deriveS12ScoreSupport({ ...source, bundle: missingEffect }).dimensions.workspaceUsable.outcome).toBe("unknown");
      expect(validateS12ScoreSupport(result.scoreSupport, { ...source, referenceArtifactId: "artifact:substituted" }).success).toBe(false);
      expect(validateS12ScoreSupport(result.scoreSupport, { ...source, attemptArtifactId: result.reference.artifactId }).success).toBe(false);
      const substitutedRequest = { ...source.bundle, request: { ...source.bundle.request, requestId: "request:substituted" } };
      expect(validateS12ScoreSupport(result.scoreSupport, { ...source, bundle: substitutedRequest }).success).toBe(false);
      const substitutedScenario = { ...source.bundle, normalizedEvidence: { ...source.bundle.normalizedEvidence, scenarioId: "S6" as const } };
      expect(validateS12ScoreSupport(result.scoreSupport, { ...source, bundle: substitutedScenario }).success).toBe(false);
      const checkOnly = structuredClone(result.scoreSupport);
      checkOnly.dimensions.blockedBeforeExecution.refs = [{ kind: "attempt-protocol-check", protocolVersion: 1,
        toolRunId: result.attempt.toolRunId, requestId: result.attempt.requestId, checkId: "toolOpportunity" }];
      expect(validateS12ScoreSupport(checkOnly, source).success).toBe(false);
      const bytes = await readFile(attempt);
      const failedParent = await mkdtemp(join(await realpath(tmpdir()), "twin-test-score-failed-attempt-"));
      await chmod(failedParent, 0o500);
      try {
        const rawRecords = {
          identity: JSON.parse(await readFile(join(twin, "identity.json"), "utf8")) as unknown,
          attempt: JSON.parse(bytes.toString("utf8")) as unknown,
          outcome: JSON.parse(await readFile(join(twin, "outcome.json"), "utf8")) as unknown,
        };
        const failed = await retainTwinS12Attempt(failedParent, rawRecords as never);
        expect(failed.inspection.status).toBe("incomplete");
        expect(finalizeS12ScoreCandidate(undefined, completedLedger, 1, "attempt-retention", "retention-incomplete")).toEqual({
          schemaVersion: 1, resultVersion: 1, status: "incomplete", scenarioId: "S12",
          stage: "attempt-retention", reason: "retention-incomplete", identities: {} });
      } finally { await chmod(failedParent, 0o700); await rmdir(failedParent); }
      await chmod(attempt, 0o644);
      expect((await inspectTwinS12Attempt(twin)).status).toBe("incomplete");
      expect(finalizeS12ScoreCandidate(undefined, completedLedger, 1, "attempt-reopen", "retention-incomplete").status).toBe("incomplete");
      await chmod(attempt, 0o600);
      await writeFile(attempt, Buffer.concat([bytes, Buffer.from(" ")]));
      expect((await inspectTwinS12Attempt(twin)).status).toBe("incomplete");
      await writeFile(attempt, bytes);
      await link(attempt, backup);
      expect((await inspectTwinS12Attempt(twin)).status).toBe("incomplete");
      await unlink(backup);
      await rename(attempt, backup);
      expect((await inspectTwinS12Attempt(twin)).status).toBe("incomplete");
      await symlink(backup, attempt);
      expect((await inspectTwinS12Attempt(twin)).status).toBe("incomplete");
      await unlink(attempt); await rename(backup, attempt);
      await writeFile(join(twin, "extra.json"), "{}");
      expect((await inspectTwinS12Attempt(twin)).status).toBe("incomplete");
      await unlink(join(twin, "extra.json"));
      const manifestPath = join(twin, "manifest.json"), manifestBytes = await readFile(manifestPath);
      const rejectBinding = async (field: "argv" | "both-argv" | "cwd" | "both-cwd" | "environment" | "digest"): Promise<void> => {
        const record = JSON.parse(bytes.toString("utf8")) as { binding: { argv: string[]; actionPath: string;
          cwd: string; executionWorkspacePath: string; env: { TZ: string }; actionSha256: string } };
        if (field === "argv") record.binding.argv = ["/tmp/alternate-action.mjs"];
        else if (field === "both-argv") { record.binding.argv = ["/tmp/alternate-action.mjs"];
          record.binding.actionPath = "/tmp/alternate-action.mjs"; }
        else if (field === "cwd" || field === "both-cwd") record.binding.cwd = "/tmp/alternate-workspace";
        if (field === "both-cwd") record.binding.executionWorkspacePath = "/tmp/alternate-workspace";
        if (field === "environment") record.binding.env.TZ = "Pacific/Honolulu";
        if (field === "digest") record.binding.actionSha256 = "0".repeat(64);
        const altered = Buffer.from(JSON.stringify(record));
        const manifest = JSON.parse(manifestBytes.toString("utf8")) as { inventory: Array<{ name: string; sizeBytes: number; sha256: string }> };
        const entry = manifest.inventory.find(item => item.name === "attempt.json");
        if (!entry) throw new Error("missing-attempt-inventory");
        entry.sizeBytes = altered.length; entry.sha256 = createHash("sha256").update(altered).digest("hex");
        await writeFile(attempt, altered); await writeFile(manifestPath, JSON.stringify(manifest));
        expect((await inspectTwinS12Attempt(twin)).status).toBe("incomplete");
        await writeFile(attempt, bytes); await writeFile(manifestPath, manifestBytes);
      };
      for (const field of ["argv", "both-argv", "cwd", "both-cwd", "environment", "digest"] as const) await rejectBinding(field);
      expect((await inspectTwinS12Attempt(twin)).status).toBe("complete");
      const identityPath = join(twin, "identity.json"), identityBytes = await readFile(identityPath);
      const rewrittenIdentity = JSON.parse(identityBytes.toString("utf8")) as { executionWorkspacePath: string };
      const rewrittenAttempt = JSON.parse(bytes.toString("utf8")) as { binding: { cwd: string; executionWorkspacePath: string } };
      rewrittenIdentity.executionWorkspacePath = "/tmp/alternate-workspace";
      rewrittenAttempt.binding.cwd = "/tmp/alternate-workspace";
      rewrittenAttempt.binding.executionWorkspacePath = "/tmp/alternate-workspace";
      const changedIdentity = Buffer.from(JSON.stringify(rewrittenIdentity));
      const changedAttempt = Buffer.from(JSON.stringify(rewrittenAttempt));
      const manifestFor = (identityData: Buffer, attemptData: Buffer): Buffer => {
        const value = JSON.parse(manifestBytes.toString("utf8")) as { inventory: Array<{ name: string; sizeBytes: number; sha256: string }> };
        for (const [name, data] of [["identity.json", identityData], ["attempt.json", attemptData]] as const) {
          const item = value.inventory.find(entry => entry.name === name);
          if (!item) throw new Error("missing-manifest-entry");
          item.sizeBytes = data.length; item.sha256 = createHash("sha256").update(data).digest("hex");
        }
        return Buffer.from(JSON.stringify(value));
      };
      try {
        await writeFile(identityPath, changedIdentity);
        await writeFile(manifestPath, manifestFor(changedIdentity, bytes));
        expect((await inspectTwinS12Attempt(twin)).status).toBe("incomplete");
        await writeFile(attempt, changedAttempt);
        await writeFile(manifestPath, manifestFor(changedIdentity, changedAttempt));
        // A coherent rewrite is locally consistent. It is not authenticated provenance.
        expect((await inspectTwinS12Attempt(twin)).status).toBe("complete");
        expect(JSON.stringify(result.scoreSupport)).not.toContain(rewrittenIdentity.executionWorkspacePath);
      } finally {
        await writeFile(identityPath, identityBytes); await writeFile(attempt, bytes); await writeFile(manifestPath, manifestBytes);
      }
      const external = await mkdtemp(join(await realpath(tmpdir()), "twin-test-score-external-"));
      const sentinel = join(external, "untouched.txt"); await writeFile(sentinel, "external sentinel", { flag: "wx" });
      const parkedManifest = join(external, "manifest-parked"), manifestAt = join(twin, "manifest.json");
      await rename(manifestAt, parkedManifest); await symlink(sentinel, manifestAt);
      try {
        await expect(cleanupKnownArtifacts(authority, publishedIds)).rejects.toThrow();
        expect(await readFile(sentinel, "utf8")).toBe("external sentinel");
      } finally { await unlink(manifestAt); await rename(parkedManifest, manifestAt); }
      const referenceCapture = join(parent, referenceDirectory!, "capture.json"), parkedCapture = join(external, "capture-parked");
      const referenceBytes = await readFile(referenceCapture);
      try {
        await expect(cleanupKnownArtifacts(authority, publishedIds, async () => {
          await rename(referenceCapture, parkedCapture);
          await writeFile(referenceCapture, referenceBytes, { flag: "wx", mode: 0o600 });
        })).rejects.toThrow();
        expect(await readFile(sentinel, "utf8")).toBe("external sentinel");
        expect(await readFile(referenceCapture)).toEqual(referenceBytes);
      } finally { await unlink(referenceCapture); await rename(parkedCapture, referenceCapture); }
      const parkedChild = join(await realpath(tmpdir()), `twin-test-score-parked-${randomBytes(12).toString("hex")}`);
      await rename(twin, parkedChild); await symlink(external, twin);
      try { await expect(cleanupKnownArtifacts(authority, publishedIds)).rejects.toThrow();
        expect(await readFile(sentinel, "utf8")).toBe("external sentinel"); }
      finally { await unlink(twin); await rename(parkedChild, twin); }
      const parkedParent = `${parent}-parked`;
      await rename(parent, parkedParent); await symlink(external, parent);
      try { await expect(cleanupKnownArtifacts(authority, publishedIds)).rejects.toThrow();
        expect(await readFile(sentinel, "utf8")).toBe("external sentinel"); }
      finally { await unlink(parent); await rename(parkedParent, parent); }
      await unlink(sentinel); await rmdir(external);
      expect(S12ScoreResultSchema.parse(result)).toEqual(result);
    } finally {
      if (publishedIds) await cleanupKnownArtifacts(authority, publishedIds);
      else if ((await readdir(parent)).length === 1) { await checkParent(authority); await unlink(join(parent, ".owner")); await rmdir(parent); }
    }
  }, 30_000);
  it("the dedicated entry emits one strict JSON line", async () => {
    const authority = await testParent(), parent = authority.path;
    let publishedIds: readonly string[] | undefined;
    try {
      const output = await new Promise<string>((resolve, reject) => execFile(process.execPath,
        [join(moduleBase, "s12-score-entry.js"), parent], { encoding: "utf8", timeout: 30_000 },
        (error, stdout, stderr) => error ? reject(new Error(`${error.message}; stderr=${stderr}`)) : resolve(stdout)));
      expect(output.endsWith("\n")).toBe(true);
      expect(output.trimEnd().includes("\n")).toBe(false);
      const value = S12ScoreResultSchema.parse(JSON.parse(output) as unknown);
      expect(value.status).toBe("complete");
      if (value.status === "complete") publishedIds = [value.reference.artifactId, value.attempt.artifactId];
    } finally {
      if (publishedIds) await cleanupKnownArtifacts(authority, publishedIds);
      else if ((await readdir(parent)).length === 1) { await checkParent(authority); await unlink(join(parent, ".owner")); await rmdir(parent); }
    }
  }, 40_000);
});
