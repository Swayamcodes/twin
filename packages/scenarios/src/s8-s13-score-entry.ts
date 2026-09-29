import { write } from "node:fs";
import { produceS8S13Score } from "./s8-s13-score-producer.js";
import { S8S13ResultSchema, type S8S13Result } from "./contract/s8-s13-score.js";

async function line(value: S8S13Result): Promise<void> {
  const bytes = Buffer.from(JSON.stringify(S8S13ResultSchema.parse(value)) + "\n");
  for (let offset = 0; offset < bytes.length;) {
    const count = await new Promise<number>((resolve, reject) => write(1, bytes, offset, bytes.length - offset, null,
      (error, written) => error ? reject(error) : resolve(written)));
    if (count <= 0 || count > bytes.length - offset) throw new Error("output-failed");
    offset += count;
  }
}
export async function main(args: readonly string[]): Promise<number> {
  const id = args[0] === "S8" || args[0] === "S13" || args[0] === "S9" ? args[0] : "S8";
  let value: S8S13Result;
  if (args.length !== 2 || args[0] !== id) value = { schemaVersion: 1, resultVersion: 1, status: "incomplete", scenarioId: id,
    stage: "preflight", roots: { original: "not-allocated", support: "not-allocated", twin: "not-allocated", artifact: "not-allocated",
      ...(id === "S9" ? { home: "not-allocated" as const } : {}) }, identities: {}, attemptId: null,
    process: { directChild: "not-launched", descendants: "not-established" } };
  else value = await produceS8S13Score(id, args[1]!);
  try { await line(value); } catch { return 1; }
  return value.status === "complete" ? 0 : 1;
}
if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
