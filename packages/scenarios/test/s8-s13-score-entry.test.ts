import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { S8S13ResultSchema } from "../src/contract/s8-s13-score.js";

const entry = fileURLToPath(new URL("../dist/s8-s13-score-entry.js", import.meta.url));
describe("S8/S13 strict entry", () => {
  it("emits one closed incomplete line for invalid arguments without allocating", async () => {
    const output = await new Promise<{ stdout: string; code: number }>((resolve, reject) => {
      execFile(process.execPath, [entry, "bad"], { encoding: "utf8", timeout: 10_000 }, (error, stdout, stderr) => {
        if (stderr) reject(new Error("unexpected-stderr"));
        else resolve({ stdout, code: error && "code" in error && typeof error.code === "number" ? error.code : 0 });
      });
    });
    expect(output.code).toBe(1);
    expect(output.stdout.endsWith("\n")).toBe(true);
    expect(output.stdout.trimEnd().includes("\n")).toBe(false);
    const result = S8S13ResultSchema.parse(JSON.parse(output.stdout) as unknown);
    expect(result.status).toBe("incomplete");
    expect(output.stdout).not.toContain(process.cwd());
  });
});
