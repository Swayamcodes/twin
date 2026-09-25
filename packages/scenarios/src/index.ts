import { write } from "node:fs";
import { errorMessage } from "./fixture.js";
import { runScenario } from "./runner.js";
import type { ScenarioRunResult } from "./types.js";

async function writeOutput(fd: 1 | 2, text: string): Promise<void> {
  const bytes = Buffer.from(text, "utf8");
  let offset = 0;
  while (offset < bytes.length) {
    const remaining = bytes.length - offset;
    const bytesWritten = await new Promise<number>((resolve, reject) => {
      write(fd, bytes, offset, remaining, null, (error, written) => {
        if (error) reject(error);
        else resolve(written);
      });
    });
    if (!Number.isInteger(bytesWritten) || bytesWritten < 0 || bytesWritten > remaining) {
      throw new Error(`Output write reported invalid byte count: ${bytesWritten}`);
    }
    if (bytesWritten === 0) throw new Error(`Output write made no progress on fd ${fd}`);
    offset += bytesWritten;
  }
}

async function reportError(message: string): Promise<void> {
  try {
    await writeOutput(2, message + "\n");
  } catch {
    // Delivery cannot be guaranteed if stderr is unavailable too.
  }
}

export async function main(args: readonly string[]): Promise<number> {
  const id = args[0];
  if (args.length !== 1 || (id !== "S12" && id !== "S6")) {
    await reportError("Usage: node packages/scenarios/dist/index.js <S12|S6>");
    return 2;
  }
  let result: ScenarioRunResult;
  try {
    result = await runScenario(id);
  } catch (error: unknown) {
    // Allocation/pre-allocation failures have no generated root to report.
    await reportError(JSON.stringify({ error: errorMessage(error) }));
    return 1;
  }
  // Lifecycle evidence and cleanup are complete before output delivery starts.
  try {
    await writeOutput(1, JSON.stringify(result, null, 2) + "\n");
  } catch (error: unknown) {
    await reportError(`JSON delivery failed: ${errorMessage(error)}; scenarioRoot=${result.scenarioRoot}; cleanup=${result.cleanup.status}`);
    return 1;
  }
  // Operational status only; S6 normally exits 0 despite observed deletions.
  return result.issues.length === 0 ? 0 : 1;
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}
