import type { Writable } from "node:stream";
import { errorMessage } from "./fixture.js";
import { runScenario } from "./runner.js";
import type { ScenarioRunResult } from "./types.js";

function writeOutput(stream: Writable, text: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const detach = (): void => {
      stream.off("error", onError);
      stream.off("close", onClose);
    };
    const onError = (error: Error): void => {
      if (settled) return;
      settled = true;
      reject(error);
      // A failed write callback can precede the error event. Keep its handler
      // until close so that the later error cannot become unhandled.
    };
    const onClose = (): void => {
      onError(new Error("Output stream closed before delivery completed"));
      detach();
    };
    stream.on("error", onError);
    stream.once("close", onClose);
    try {
      stream.write(text, (error: Error | null | undefined) => {
        if (error) {
          onError(error);
        } else if (!settled) {
          settled = true;
          detach();
          resolve();
        }
      });
    } catch (error: unknown) {
      onError(error instanceof Error ? error : new Error(errorMessage(error)));
    }
  });
}

async function reportError(message: string): Promise<void> {
  try {
    await writeOutput(process.stderr, message + "\n");
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
    await writeOutput(process.stdout, JSON.stringify(result, null, 2) + "\n");
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
