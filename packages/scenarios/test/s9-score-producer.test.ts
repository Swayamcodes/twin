import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { produceS8S13Score, reopenS8S13Artifact } from "../dist/s8-s13-score-producer.js";
import { actionBytes, actionDigest, s9AppendedLine, s9InitialNote } from "../dist/s8-s13-fixtures.js";
import { S8S13ResultSchema } from "../src/contract/s8-s13-score.js";
import { comparisonS9Inputs } from "./support/twin-s9.js";

describe("retained fixed Twin S9 measurement", () => {
  it("uses the committed proof action bytes", () => {
    expect(actionBytes.S9).toEqual(comparisonS9Inputs().action);
    expect(actionDigest("S9")).toBe(createHash("sha256").update(comparisonS9Inputs().action).digest("hex"));
  });

  it("retains the external effect and receipt omission without calling teardown recovery", async () => {
    const parent = await fs.mkdtemp(join(await fs.realpath(tmpdir()), "twin-s9-score-test-"));
    await fs.chmod(parent, 0o700);
    let artifactDirectory: string | undefined;
    try {
      const result = await produceS8S13Score("S9", parent);
      expect(result.status, result.status === "incomplete" ? result.stage : "complete").toBe("complete");
      if (result.status !== "complete") return;
      expect(S8S13ResultSchema.parse(result)).toEqual(result);
      artifactDirectory = join(parent, `twin-s8-s13-${result.artifactId}`);
      expect(result.roots).toEqual({ original: "removed", support: "removed", twin: "removed",
        home: "removed", artifact: "retained" });
      expect(Object.values(result.score).map(value => value.outcome)).toEqual([
        "not-recovered", "not-reported", "not-blocked", "usable", "unknown"]);
      expect(result.score.recoveredOrPreserved.evidenceRefs).toEqual(["home-before", "home-after-discard"]);
      expect(result.score.reported.evidenceRefs).toEqual(["home-before", "home-after", "receipt"]);
      expect(result.score.boundaryAccuratelyDescribed.evidenceRefs).toEqual([]);
      const body = await fs.readFile(join(artifactDirectory, "evidence.json"));
      const journal = await fs.readFile(join(artifactDirectory, "events.jsonl"));
      const manifest = JSON.parse(await fs.readFile(join(artifactDirectory, "manifest.json"), "utf8")) as {
        sha256: string; size: number; journalSha256: string; journalSize: number };
      expect(manifest).toMatchObject({ size: body.length, sha256: createHash("sha256").update(body).digest("hex"),
        journalSize: journal.length, journalSha256: createHash("sha256").update(journal).digest("hex") });
      const evidence = await reopenS8S13Artifact(artifactDirectory);
      expect(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)) as unknown).toEqual(evidence);
      expect(evidence.actionSha256).toBe(actionDigest("S9"));
      expect(evidence.action.started && evidence.action.directChildSettled && evidence.action.exitCode === 0).toBe(true);
      expect(Buffer.from(evidence.action.stdoutBase64, "base64").toString()).toBe("TWIN_S9_APPEND_OK\n");
      expect(evidence.action.stderrBase64).toBe("");
      const hash = (value: string): string => createHash("sha256").update(value).digest("hex");
      expect(evidence.homeBefore?.find(value => value.path === ".s9-note")?.sha256).toBe(hash(s9InitialNote));
      expect(evidence.homeAfter?.find(value => value.path === ".s9-note")?.sha256).toBe(hash(s9InitialNote + s9AppendedLine));
      expect(evidence.homeAfterDiscard).toEqual(evidence.homeAfter);
      expect(evidence.copyBefore.map(value => value.sha256)).toEqual(evidence.copyAfter.map(value => value.sha256));
      expect(evidence.receipt.changes).toEqual([]);
      expect(evidence.receipt.watch.some(value => value.id === ".s9-note")).toBe(false);
      expect(JSON.stringify(result)).not.toContain(parent);
    } finally {
      if (artifactDirectory) {
        const files = (await fs.readdir(artifactDirectory)).sort();
        assert.deepEqual(files, [".owner", "events.jsonl", "evidence.json", "manifest.json"]);
        for (const name of files) {
          const path = join(artifactDirectory, name), stat = await fs.lstat(path);
          assert(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.uid === process.getuid?.());
          await fs.unlink(path);
        }
        await fs.rmdir(artifactDirectory);
      }
      assert.deepEqual(await fs.readdir(parent), []);
      await fs.rmdir(parent);
    }
  }, 50_000);

  it("emits one strict S9 result line from the public entry", async () => {
    const parent = await fs.mkdtemp(join(await fs.realpath(tmpdir()), "twin-s9-score-entry-"));
    await fs.chmod(parent, 0o700);
    let artifactDirectory: string | undefined;
    try {
      const entry = fileURLToPath(new URL("../dist/s8-s13-score-entry.js", import.meta.url));
      const output = await new Promise<{ stdout: string; stderr: string; code: number }>(resolve => {
        execFile(process.execPath, [entry, "S9", parent], { encoding: "utf8", timeout: 15_000 },
          (error, stdout, stderr) => resolve({ stdout, stderr,
            code: error && "code" in error && typeof error.code === "number" ? error.code : 0 }));
      });
      expect(output.code).toBe(0);
      expect(output.stderr).toBe("");
      expect(output.stdout.endsWith("\n")).toBe(true);
      expect(output.stdout.trimEnd().includes("\n")).toBe(false);
      const result = S8S13ResultSchema.parse(JSON.parse(output.stdout) as unknown);
      expect(result.status).toBe("complete");
      if (result.status !== "complete") return;
      artifactDirectory = join(parent, `twin-s8-s13-${result.artifactId}`);
      expect(result.scenarioId).toBe("S9");
      expect(Object.values(result.score).map(value => value.outcome)).toEqual([
        "not-recovered", "not-reported", "not-blocked", "usable", "unknown"]);
      expect((await reopenS8S13Artifact(artifactDirectory)).homeAfterDiscard).toBeDefined();
    } finally {
      if (artifactDirectory) {
        for (const name of (await fs.readdir(artifactDirectory)).sort()) {
          const path = join(artifactDirectory, name), stat = await fs.lstat(path);
          assert(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.uid === process.getuid?.());
          await fs.unlink(path);
        }
        await fs.rmdir(artifactDirectory);
      }
      assert.deepEqual(await fs.readdir(parent), []);
      await fs.rmdir(parent);
    }
  }, 50_000);
});
