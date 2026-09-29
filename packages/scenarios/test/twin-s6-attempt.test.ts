import { chmod, readFile, readdir, writeFile, unlink, rmdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { produceTwinS6Score } from "../dist/s6-score-producer.js";
import { inspectTwinS6Attempt, projectReopenedTwinS6Attempt, retainTwinS6Attempt,
  validateTwinS6ArtifactParent } from "../src/capture/twin-s6-attempt.js";
import { checkParent, cleanupKnownArtifacts, testParent } from "./support/score-artifacts.js";

describe("private Twin S6 attempt", () => {
  it("rejects unsafe parent and malformed records before publication", async () => {
    expect(await validateTwinS6ArtifactParent(".")).toBe(false);
    const authority = await testParent();
    try {
      const result = await retainTwinS6Attempt(authority.path, {} as never);
      expect(result.inspection.status).toBe("incomplete");
      expect(result.directory).toBeUndefined();
      expect(await readdir(authority.path)).toEqual([".owner"]);
    } finally { await checkParent(authority); await unlink(join(authority.path, ".owner")); await rmdir(authority.path); }
  });
  it("rejects mode, byte and extra-file tampering while a copied handle has no authority", async () => {
    const authority = await testParent(); let ids: readonly string[] | undefined;
    try {
      const result = await produceTwinS6Score({ artifactParentDirectory: authority.path });
      expect(result.status, result.status === "incomplete" ? `${result.stage}/${result.reason}` : "complete").toBe("complete");
      if (result.status !== "complete") throw new Error("incomplete-result");
      ids = [result.reference.artifactId, result.attempt.artifactId];
      const name = (await readdir(authority.path)).find(item => item.startsWith("twin-s6-"));
      expect(name).toBeDefined();
      const directory = join(authority.path, name!), attempt = join(directory, "attempt.json");
      const opened = await inspectTwinS6Attempt(directory);
      expect(opened.status).toBe("complete");
      if (opened.status !== "complete") throw new Error("not-reopened");
      expect(projectReopenedTwinS6Attempt({} as typeof opened.handle)).toBeNull();
      expect(projectReopenedTwinS6Attempt(structuredClone(opened.handle))).toBeNull();
      const original = await readFile(attempt);
      await chmod(attempt, 0o644);
      expect((await inspectTwinS6Attempt(directory)).status).toBe("incomplete");
      await chmod(attempt, 0o600);
      await writeFile(attempt, Buffer.concat([original, Buffer.from(" ")]));
      expect((await inspectTwinS6Attempt(directory)).status).toBe("incomplete");
      await writeFile(attempt, original);
      await writeFile(join(directory, "extra.json"), "{}", { flag: "wx", mode: 0o600 });
      expect((await inspectTwinS6Attempt(directory)).status).toBe("incomplete");
      await unlink(join(directory, "extra.json"));
      expect((await inspectTwinS6Attempt(directory)).status).toBe("complete");
    } finally {
      if (ids) await cleanupKnownArtifacts(authority, ids);
      else if ((await readdir(authority.path)).length === 1) { await checkParent(authority); await unlink(join(authority.path, ".owner")); await rmdir(authority.path); }
    }
  }, 40_000);
  it("does not grant an opaque handle from ordinary objects", () => {
    expect(projectReopenedTwinS6Attempt({} as never)).toBeNull();
  });
});
