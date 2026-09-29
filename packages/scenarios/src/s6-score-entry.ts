import { write } from "node:fs";
import { produceTwinS6Score } from "./s6-score-producer.js";
import { S6ScoreResultSchema, type S6ScoreResult } from "./contract/s6-score-support.js";

const invalid: S6ScoreResult = { schemaVersion: 1, resultVersion: 1, status: "incomplete", scenarioId: "S6",
  stage: "preflight", reason: "unsafe-destination", identities: {} };
async function line(value: S6ScoreResult): Promise<void> {
  const bytes = Buffer.from(JSON.stringify(S6ScoreResultSchema.parse(value)) + "\n", "utf8");
  for (let offset = 0; offset < bytes.length;) {
    const written = await new Promise<number>((resolve, reject) => write(1, bytes, offset, bytes.length - offset, null,
      (error, count) => error ? reject(error) : resolve(count)));
    if (!Number.isSafeInteger(written) || written <= 0 || written > bytes.length - offset) throw new Error("output-failed");
    offset += written;
  }
}
/** 0: complete; 1: incomplete or output failure; 2: wrong argument count. */
export async function main(args: readonly string[]): Promise<number> {
  if (args.length !== 1) { await line(invalid); return 2; }
  let result: S6ScoreResult;
  try { result = await produceTwinS6Score({ artifactParentDirectory: args[0]! }); }
  catch { result = { schemaVersion: 1, resultVersion: 1, status: "incomplete", scenarioId: "S6", stage: "preflight",
    reason: "operation-failed", identities: {} }; }
  try { await line(result); } catch { return 1; }
  return result.status === "complete" ? 0 : 1;
}
if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
