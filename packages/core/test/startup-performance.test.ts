import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createTwin } from "../src/index.js";
import { captureManifestViews } from "../src/manifest.js";
import { IoPool } from "../src/io-pool.js";
import { fixtureTest, put } from "./support.js";

it("bounds a representative mixed startup and preserves independently writable file bytes", async () => fixtureTest(async f => {
  for (let directory = 0; directory < 8; directory++)
    for (let file = 0; file < 16; file++) await put(f.source, `d${directory}/a/b/c/d/f${file}`, "x".repeat(4096));
  const serial = await captureManifestViews(f.source, { pool: new IoPool(1) });
  const parallelPool = new IoPool();
  expect(await captureManifestViews(f.source, { pool: parallelPool })).toEqual(serial);
  expect(parallelPool.inspect().peakActive).toBeLessThanOrEqual(4);
  expect(parallelPool.inspect().peakQueued).toBeLessThanOrEqual(8);
  expect(parallelPool.inspect()).toMatchObject({ active: 0, queued: 0, waiters: 0 });
  const session = await createTwin({ sourceDirectory: f.source, scratchParent: f.scratch }); f.sessions.push(session);
  const path = "d0/a/b/c/d/f0";
  expect((await stat(join(f.source, path))).ino).not.toBe((await stat(join(session.workspacePath, path))).ino);
  expect((await session.run({ executable: process.execPath, argv: ["-e", `require('fs').writeFileSync('${path}','copy only')`], env: {} })).exitCode).toBe(0);
  expect(await readFile(join(f.source, path), "utf8")).toBe("x".repeat(4096));
  expect(session.inspect().receipt?.files).toMatchObject({ coverage: "complete", changes: [expect.objectContaining({ change: "modified" })] });
  expect(await session.discard()).toMatchObject({ status: "removed" });
}));
