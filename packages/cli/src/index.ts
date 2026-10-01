#!/usr/bin/env node
/// <reference types="node" />

import { tmpdir } from "node:os";
import { realpathSync } from "node:fs";
import { mkdtemp, rmdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createTwin, unavailableProcessReceipt, type CommandReceipt, type MinimalReceipt, type ProcessReceipt, type WatchId } from "@twin-cli/core";
import { renderReceiptText } from "./receipt-text.js";

const help = `Usage: twin run [--interactive] [--receipt=text] -- <executable> [args...]

Twin runs commands in a disposable project copy. It is not an OS sandbox.
--interactive inherits stdin, stdout and stderr; command output is not captured.
--receipt=text prints a bounded human receipt on stderr instead of the default JSON frame.
`;

const WATCH_IDS: readonly WatchId[] = [
  ".gitconfig", ".npmrc", ".bashrc", ".zshrc",
  ".codex/config.toml", ".claude/settings.json", ".gemini/settings.json",
];

function fallbackCommand(ready: boolean): CommandReceipt {
  return { coverage: "top-level-only", nestedCommands: "not-observed", admitted: ready ? false : null,
    processStart: ready ? "not-confirmed" : "unknown", executable: { status: "omitted" },
    arguments: { status: "omitted", count: null, capped: false },
    disposition: ready ? "not-attempted" : "observation-unavailable",
    timeoutObserved: ready ? false : null, directChildSettled: null, exitCode: null, signal: null };
}

function unavailableReceipt(reason: string, command: CommandReceipt, process: ProcessReceipt): MinimalReceipt {
  return {
    schemaVersion: 5,
    command, process,
    files: { coverage: "unavailable", issues: [{ reason }], changes: [] },
    dependencies: { declarations: { coverage: "unavailable", changes: [] }, lockfiles: { coverage: "unavailable", changes: [] },
      issues: [{ phase: "after", path: "package.json", reason }] },
    globalNpm: { coverage: "unavailable", source: "unavailable", changes: [], issues: [{ phase: "after", name: "", reason }] },
    watch: WATCH_IDS.map(id => ({
      id,
      before: { status: "unavailable", reason },
      after: { status: "unavailable", reason },
      comparison: "unknown",
    })),
  };
}

function write(stream: NodeJS.WriteStream, chunk: string | Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.write(chunk, error => error ? reject(error) : resolve());
  });
}

async function writeReceipt(receipt: MinimalReceipt, format: "json" | "text"): Promise<void> {
  const limit = 8 * 1024 * 1024;
  let estimatedBytes = 2048;
  for (const collection of [receipt.files.issues, receipt.files.changes, receipt.watch,
    receipt.dependencies.declarations.changes, receipt.dependencies.lockfiles.changes, receipt.dependencies.issues,
    receipt.globalNpm.changes, receipt.globalNpm.issues]) {
    for (const item of collection) {
      estimatedBytes += Buffer.byteLength(JSON.stringify(item), "utf8") + 1;
      if (estimatedBytes > limit) break;
    }
    if (estimatedBytes > limit) break;
  }
  let selected = estimatedBytes > limit ? unavailableReceipt("receipt-limit", receipt.command, receipt.process) : receipt;
  let payload = Buffer.from(JSON.stringify(selected), "utf8");
  if (payload.length > limit) {
    selected = unavailableReceipt("receipt-limit", receipt.command, receipt.process);
    payload = Buffer.from(JSON.stringify(selected), "utf8");
  }
  if (format === "text") { await write(process.stderr, renderReceiptText(selected)); return; }
  await write(process.stderr, Buffer.from(`\x1eTWIN-RECEIPT/1 ${payload.length}\n`, "ascii"));
  await write(process.stderr, payload);
  await write(process.stderr, "\n");
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) {
    process.stdout.write(help);
    return 0;
  }

  const separator = argv.indexOf("--", 1);
  const flags = argv.slice(1, separator < 0 ? undefined : separator);
  const interactive = flags.includes("--interactive");
  const format = flags.includes("--receipt=text") ? "text" : "json";
  if (argv[0] !== "run" || separator < 1 || flags.some(flag => flag !== "--interactive" && flag !== "--receipt=text")
      || flags.filter(flag => flag === "--interactive").length > 1
      || flags.filter(flag => flag === "--receipt=text").length > 1
      || argv.length < separator + 2 || !argv[separator + 1]) {
    process.stderr.write(help);
    return 2;
  }

  let session: Awaited<ReturnType<typeof createTwin>> | undefined;
  let scratchParent: string | undefined;
  let exitCode = 1;
  const interruption = new AbortController();
  const interrupt = (signal: "SIGINT" | "SIGTERM"): void => {
    if (!interruption.signal.aborted) interruption.abort(signal);
  };
  const onSigint = (): void => interrupt("SIGINT");
  const onSigterm = (): void => interrupt("SIGTERM");
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);

  try {
    try {
      scratchParent = await mkdtemp(join(tmpdir(), "twin-cli-"));
      session = await createTwin({ sourceDirectory: process.cwd(), scratchParent });
      const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
      if (interruption.signal.aborted) throw new Error("Interrupted before command launch");
      const result = await session.run({ executable: argv[separator + 1]!, argv: argv.slice(separator + 2), env,
        interruptSignal: interruption.signal,
        ...(interactive ? { stdio: "inherit" as const } : {}) });
      if (!interactive) {
        await write(process.stdout, result.stdout.bytes);
        await write(process.stderr, result.stderr.bytes);
      }
      exitCode = !interruption.signal.aborted && result.outcome === "exited" && result.started
        && result.directChildSettled && !result.lifecycleIssue && result.exitCode === 0
        && result.signal === null && result.spawnError === null && result.terminationError === null ? 0 : 1;
    } catch (error) {
      await write(process.stderr, `${error instanceof Error ? error.message : String(error)}\n`);
    } finally {
      if (session) {
        try {
          const inspection = session.inspect();
          await writeReceipt(inspection.receipt ?? unavailableReceipt("no-run", fallbackCommand(inspection.state === "ready"),
            unavailableProcessReceipt(inspection.state === "ready")), format);
        } catch {
          exitCode = 1;
        }
        try {
          const discarded = await session.discard();
          if (discarded.status === "refused" || discarded.status === "failed") {
            exitCode = 1;
            await write(process.stderr, `Twin discard ${discarded.status}: ${discarded.reason}\n`);
          }
        } catch (error) {
          await write(process.stderr, `${error instanceof Error ? error.message : String(error)}\n`);
          exitCode = 1;
        }
      }
      if (scratchParent) {
        try { await rmdir(scratchParent); }
        catch (error) {
          await write(process.stderr, `${error instanceof Error ? error.message : String(error)}\n`);
          exitCode = 1;
        }
      }
    }
  } finally {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
    if (interruption.signal.aborted) exitCode = 1;
  }

  return exitCode;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  process.exitCode = await main();
}
