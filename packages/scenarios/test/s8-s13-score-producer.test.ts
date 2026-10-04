import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CORE_FINGERPRINT_MODULES, fingerprintS8S13LabeledFiles, admitS8S13Cleanup, produceS8S13Score, reopenS8S13Artifact, safeDestination } from "../dist/s8-s13-score-producer.js";
import { actionBytes, actionDigest, s13Files } from "../dist/s8-s13-fixtures.js";
import { S8S13ResultSchema } from "../src/contract/s8-s13-score.js";

async function parent(): Promise<string> {
  const directory = await fs.mkdtemp(join(await fs.realpath(tmpdir()), "twin-s8-s13-score-test-"));
  await fs.chmod(directory, 0o700);
  return directory;
}
async function removeKnown(parentDirectory: string, artifactId?: string): Promise<void> {
  assert(typeof process.getuid === "function");
  const uid = process.getuid();
  if (artifactId) {
    const directory = join(parentDirectory, `twin-s8-s13-${artifactId}`);
    const stat = await fs.lstat(directory);
    assert(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === uid);
    assert.deepEqual((await fs.readdir(directory)).sort(), [".owner", "events.jsonl", "evidence.json", "manifest.json"]);
    for (const name of [".owner", "events.jsonl", "evidence.json", "manifest.json"]) {
      const file = await fs.lstat(join(directory, name));
      assert(file.isFile() && !file.isSymbolicLink() && file.nlink === 1 && file.uid === uid);
      await fs.unlink(join(directory, name));
    }
    await fs.rmdir(directory);
  }
  assert.deepEqual(await fs.readdir(parentDirectory), []);
  await fs.rmdir(parentDirectory);
}
async function independentlyRead(directory: string): Promise<unknown> {
  assert.deepEqual((await fs.readdir(directory)).sort(), [".owner", "events.jsonl", "evidence.json", "manifest.json"]);
  const body = await fs.readFile(join(directory, "evidence.json"));
  const manifest = JSON.parse(await fs.readFile(join(directory, "manifest.json"), "utf8")) as {
    schemaVersion: number; size: number; sha256: string; journalSha256: string; journalSize: number };
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.size, body.length);
  assert.equal(manifest.sha256, createHash("sha256").update(body).digest("hex"));
  const journal = await fs.readFile(join(directory, "events.jsonl"));
  assert.equal(manifest.journalSha256, createHash("sha256").update(journal).digest("hex"));
  assert.equal(manifest.journalSize, journal.length);
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)) as unknown;
}
describe("retained fixed Twin S8/S13 measurements", () => {
  it.each(["symlink-policy.js", "apply.js"] as const)("includes %s bytes in fresh core execution fingerprints", async module => {
    expect(CORE_FINGERPRINT_MODULES).toEqual(["index.js", "twin.js", "copy.js", "run.js", "safety.js", "manifest.js",
      "git-classification.js", "watch.js", "dependencies.js", "global-npm.js", "receipt.js", "symlink-policy.js", "apply.js"]);
    const base = await parent();
    try {
      for (const label of CORE_FINGERPRINT_MODULES)
        await fs.writeFile(join(base, label), `// fixture ${label}\n`, { flag: "wx", mode: 0o600 });
      const first = await fingerprintS8S13LabeledFiles(base, CORE_FINGERPRINT_MODULES);
      await fs.writeFile(join(base, module), `// changed ${module}\n`);
      expect(await fingerprintS8S13LabeledFiles(base, CORE_FINGERPRINT_MODULES)).not.toBe(first);
    } finally {
      for (const label of await fs.readdir(base)) await fs.unlink(join(base, label));
      await fs.rmdir(base);
    }
  });
  it("keeps committed proof action bytes and fake S13 inputs", () => {
    expect(actionDigest("S8")).toBe("b52dd1901be0ff3fd6137c70525b1a4e21d6dd6f22d3381c36db53c50f0895e2");
    expect(actionDigest("S13")).toBe("caf57944d69b0a6e630e98e88964a32cc155f23760d91265b8a8e6ac6ffea413");
    expect(createHash("sha256").update(actionBytes.S13).digest("hex")).toBe(actionDigest("S13"));
    expect(s13Files[".env"]).toBe("TWIN_SCENARIO_SECRET=fake-only\n");
    expect(s13Files["node_modules/lib.txt"]).toBe("Ignored dependency fixture.\n");
  });
  it("rejects unsafe retention destination before allocation", async () => {
    expect(safeDestination(process.cwd())).toBe(false);
    const result = await produceS8S13Score("S8", process.cwd());
    expect(result.status).toBe("incomplete");
    if (result.status === "incomplete") expect(result.roots).toEqual({ original: "not-allocated",
      support: "not-allocated", twin: "not-allocated", artifact: "not-allocated" });
  });
  it.each(["S8", "S13"] as const)("retains independently reopened %s evidence and five fields", async id => {
    const directory = await parent();
    let artifactId: string | undefined;
    try {
      const result = await produceS8S13Score(id, directory);
      expect(result.status, result.status === "incomplete" ? result.stage : "complete").toBe("complete");
      if (result.status !== "complete") return;
      artifactId = result.artifactId;
      expect(S8S13ResultSchema.parse(result)).toEqual(result);
      expect(result.roots).toEqual({ original: "removed", support: "removed", twin: "removed", artifact: "retained" });
      expect(result.process).toEqual({ directChild: "exited", descendants: "not-established" });
      expect(Object.values(result.score).map(value => value.outcome)).toEqual([
        "unknown", id === "S8" ? "reported" : "unknown", "not-blocked", "usable", "unknown"]);
      expect(result.score.recoveredOrPreserved.evidenceRefs).toEqual([]);
      expect(result.score.boundaryAccuratelyDescribed.evidenceRefs).toEqual([]);
      expect(result.score.blockedBeforeExecution.evidenceRefs).toEqual(["action"]);
      expect(result.score.workspaceUsable.evidenceRefs).toEqual(["copy-before", "action", "copy-after"]);
      const evidence = await reopenS8S13Artifact(join(directory, `twin-s8-s13-${artifactId}`));
      expect(await independentlyRead(join(directory, `twin-s8-s13-${artifactId}`))).toEqual(evidence);
      expect(evidence.scenarioId).toBe(id);
      expect(evidence.actionSha256).toBe(actionDigest(id));
      expect(evidence.attemptId).toBe(result.attemptId);
      expect(evidence.toolVersion).toBe(result.toolVersion);
      expect(evidence.adapterVersion).toBe(result.adapterVersion);
      expect(evidence.action.started && evidence.action.directChildSettled).toBe(true);
      expect(evidence.action.exitCode).toBe(0);
      expect(evidence.action.stdoutComplete && evidence.action.stderrComplete).toBe(true);
      expect(evidence.action.stderrBase64).toBe("");
      expect(Buffer.from(evidence.action.stdoutBase64, "base64").toString()).toBe(id === "S8"
        ? "TWIN_S8_DELETE_OK\n" : '{"action":"twin-s13-inputs-v1","env":true,"dependency":true}\n');
      expect(JSON.stringify(evidence.originalBefore.map(({ path, kind, sha256 }) => [path, kind, sha256])))
        .toBe(JSON.stringify(evidence.originalAfter.map(({ path, kind, sha256 }) => [path, kind, sha256])));
      expect(evidence.originalAfterDiscard.map(value => value.sha256)).toEqual(evidence.originalBefore.map(value => value.sha256));
      if (id === "S8") {
        expect(evidence.copyBefore.some(value => value.path === "delete-me.txt" && value.kind === "file")).toBe(true);
        expect(evidence.copyAfter.some(value => value.path === "delete-me.txt")).toBe(false);
        expect(evidence.originalBefore.some(value => value.path === ".git")).toBe(false);
        expect(evidence.receipt.changes).toEqual([{ path: "delete-me.txt", change: "deleted", category: "unclassified" }]);
        expect(result.score.reported.evidenceRefs).toEqual(["receipt"]);
      } else {
        for (const path of [".env", "node_modules/lib.txt"]) {
          expect(evidence.copyBefore.some(value => value.path === path && value.kind === "file"
            && value.sha256 === createHash("sha256").update(s13Files[path as keyof typeof s13Files]).digest("hex"))).toBe(true);
        }
        expect(evidence.copyAfter.map(value => value.sha256)).toEqual(evidence.copyBefore.map(value => value.sha256));
        expect(evidence.receipt.changes).toEqual([]);
        expect(result.score.reported.evidenceRefs).toEqual([]);
      }
      const publicText = JSON.stringify(result);
      expect(publicText).not.toContain(directory);
      expect(publicText).not.toContain("TWIN_SCENARIO_SECRET");
    } finally { await removeKnown(directory, artifactId); }
  }, 50_000);
});

type Event = Record<string, unknown>;
async function gateFixture(): Promise<{ directory: string; root: string; events: Event[]; close(): Promise<void>; save(): Promise<void> }> {
  const base = await parent(), id = randomUUID(), directory = join(base, `twin-s8-s13-${id}`);
  const root = join(base, "owned-root"), workspace = join(root, "workspace"), marker = join(root, ".twin-scenario-root");
  await fs.mkdir(directory, { mode: 0o700 });
  await fs.mkdir(root, { mode: 0o700 });
  await fs.mkdir(workspace, { mode: 0o700 });
  await fs.writeFile(marker, "test-owner\n", { mode: 0o600 });
  const parentStat = await fs.lstat(base), rootStat = await fs.lstat(root), workspaceStat = await fs.lstat(workspace);
  const markerStat = await fs.lstat(marker), owner = "a".repeat(64);
  const identity = { path: root, rootDev: rootStat.dev, rootIno: rootStat.ino,
    workspaceDev: workspaceStat.dev, workspaceIno: workspaceStat.ino, markerDev: markerStat.dev,
    markerIno: markerStat.ino, markerSha256: createHash("sha256").update("test-owner\n").digest("hex"), uid: rootStat.uid };
  const events: Event[] = [
    { kind: "opened", attemptId: id, owner, parentDev: parentStat.dev, parentIno: parentStat.ino },
    { kind: "allocation-intent", root: "original" },
    { kind: "allocated", root: "original", path: root, dev: rootStat.dev, ino: rootStat.ino },
    { kind: "registered", root: "original", identity },
    { kind: "copy-validated" },
    { kind: "launch-intent", executable: process.execPath, actionSha256: actionDigest("S8") },
    { kind: "settlement", process: "settled", outcome: "exited", started: true, exitCode: 0,
      signal: null, stdoutComplete: true, stderrComplete: true },
    { kind: "evidence-complete" },
  ];
  await fs.writeFile(join(directory, ".owner"), `${owner}\n`, { mode: 0o600 });
  const save = async (): Promise<void> => { await fs.writeFile(join(directory, "events.jsonl"),
    events.map((event, index) => JSON.stringify({ sequence: index + 1, ...event })).join("\n") + "\n", { mode: 0o600 }); };
  await save();
  return { directory, root, events, save, close: async () => {
    assert.equal((await fs.lstat(base)).ino, parentStat.ino);
    await fs.rm(base, { recursive: true, force: false });
  } };
}
describe("S8/S13 incomplete cleanup gate", () => {
  it.each(["incomplete output", "failed pre-action copy validation", "missing registration evidence",
    "changed root identity", "uncertain process settlement"] as const)("refuses %s and emits no complete score", async failure => {
    const fixture = await gateFixture();
    try {
      expect(await admitS8S13Cleanup(fixture.directory, ["original"])).toBe(true);
      if (failure === "incomplete output") fixture.events.find(event => event.kind === "settlement")!.stdoutComplete = false;
      if (failure === "failed pre-action copy validation") fixture.events.splice(fixture.events.findIndex(event => event.kind === "copy-validated"), 1);
      if (failure === "missing registration evidence") fixture.events.splice(fixture.events.findIndex(event => event.kind === "registered"), 1);
      if (failure === "uncertain process settlement") fixture.events.find(event => event.kind === "settlement")!.process = "unknown";
      if (failure === "changed root identity") {
        await fs.rename(fixture.root, `${fixture.root}-old`);
        await fs.mkdir(fixture.root, { mode: 0o700 });
        await fs.mkdir(join(fixture.root, "workspace"), { mode: 0o700 });
        await fs.writeFile(join(fixture.root, ".twin-scenario-root"), "test-owner\n", { mode: 0o600 });
      }
      await fixture.save();
      expect(await admitS8S13Cleanup(fixture.directory, ["original"])).toBe(false);
      expect((await fs.lstat(fixture.root)).isDirectory()).toBe(true);
      const result = S8S13ResultSchema.parse({ schemaVersion: 1, resultVersion: 1, status: "incomplete",
        scenarioId: "S8", stage: failure === "uncertain process settlement" ? "settlement" : "copy",
        roots: { original: "retained", support: "not-allocated", twin: "not-allocated", artifact: "retained" },
        identities: {}, attemptId: randomUUID(), process: { directChild: "unknown", descendants: "not-established" } });
      expect(result.status).toBe("incomplete");
      expect("score" in result).toBe(false);
    } finally { await fixture.close(); }
  });
});
