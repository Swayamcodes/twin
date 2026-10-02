#!/usr/bin/env node
/// <reference types="node" />

import { tmpdir } from "node:os";
import { realpathSync } from "node:fs";
import { mkdtemp, rmdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { createTwin, unavailableProcessReceipt, type CommandReceipt, type MinimalReceipt, type ProcessReceipt, type WatchId } from "@twin-cli/core";
import { renderReceiptText, safeTerminalValue } from "./receipt-text.js";
import { exportReceiptHtml } from "./receipt-html.js";

const help = `Usage: twin run [--interactive] [--receipt=text] [--receipt-html=<file>] [--review] -- <executable> [args...]

Twin runs commands in a disposable project copy. It is not an OS sandbox.
--interactive inherits stdin, stdout and stderr; command output is not captured.
--receipt=text prints a bounded human receipt on stderr instead of the default JSON frame.
--receipt-html=<file> also exports a bounded standalone HTML receipt without overwriting a file.
--review prints the receipt, then asks on stdin to apply or discard in this invocation.
EOF, interruption, or another answer retains the copy for manual inspection.
Retained copies cannot be applied by a later twin CLI invocation.
`;

type ReviewChoice = "apply" | "discard" | "other" | "eof" | "interrupted";

async function reviewChoice(signal: AbortSignal): Promise<ReviewChoice> {
  const lines = createInterface({ input: process.stdin, terminal: false });
  return new Promise(resolve => {
    let settled = false;
    const finish = (value: ReviewChoice): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      lines.close();
      resolve(value);
    };
    const onAbort = (): void => finish("interrupted");
    lines.once("line", line => {
      const choice = line.trim();
      finish(choice === "apply" || choice === "discard" ? choice : "other");
    });
    lines.once("close", () => finish("eof"));
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) finish("interrupted");
    else void write(process.stderr, "Twin review: type apply or discard, then Enter (EOF or another answer retains copy): ").catch(() => finish("other"));
  });
}

function errorText(error: unknown): string {
  return safeTerminalValue(error instanceof Error ? error.message : String(error), 512);
}

function copyLocationMessage(path: string, cleanupUncertain = false): string {
  const location = safeTerminalValue(path, 1024);
  return cleanupUncertain
    ? `Twin copy cleanup uncertain at: ${location}\nIf present, inspect it manually. Twin cannot resume this session in a later CLI invocation.\n`
    : `Twin copy retained: ${location}\nInspect it manually. Twin can apply or discard only during the same --review invocation; rerun the command with --review for a new copy.\n`;
}

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

function selectedReceipt(receipt: MinimalReceipt): MinimalReceipt {
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
  const selected = estimatedBytes > limit ? unavailableReceipt("receipt-limit", receipt.command, receipt.process) : receipt;
  return Buffer.byteLength(JSON.stringify(selected), "utf8") > limit
    ? unavailableReceipt("receipt-limit", receipt.command, receipt.process) : selected;
}

async function writeReceipt(receipt: MinimalReceipt, format: "json" | "text"): Promise<void> {
  if (format === "text") { await write(process.stderr, renderReceiptText(receipt)); return; }
  const payload = Buffer.from(JSON.stringify(receipt), "utf8");
  await write(process.stderr, Buffer.from(`\x1eTWIN-RECEIPT/1 ${payload.length}\n`, "ascii"));
  await write(process.stderr, payload);
  await write(process.stderr, "\n");
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  if ((argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h"))
      || (argv.length === 2 && argv[0] === "run" && (argv[1] === "--help" || argv[1] === "-h"))) {
    process.stdout.write(help);
    return 0;
  }

  const separator = argv.indexOf("--", 1);
  const flags = argv.slice(1, separator < 0 ? undefined : separator);
  const interactive = flags.includes("--interactive");
  const review = flags.includes("--review");
  const format = flags.includes("--receipt=text") ? "text" : "json";
  const htmlFlags = flags.filter(flag => flag.startsWith("--receipt-html="));
  const htmlDestination = htmlFlags[0]?.slice("--receipt-html=".length);
  if (argv[0] !== "run" || separator < 1 || flags.some(flag => flag !== "--interactive" && flag !== "--receipt=text" && flag !== "--review" && !flag.startsWith("--receipt-html="))
      || flags.filter(flag => flag === "--interactive").length > 1
      || flags.filter(flag => flag === "--review").length > 1
      || flags.filter(flag => flag === "--receipt=text").length > 1
      || htmlFlags.length > 1 || (htmlFlags.length === 1 && !htmlDestination)
      || argv.length < separator + 2 || !argv[separator + 1]) {
    process.stderr.write("Invalid Twin arguments. Expected one command after --.\n");
    process.stderr.write(help);
    return 2;
  }

  let session: Awaited<ReturnType<typeof createTwin>> | undefined;
  let scratchParent: string | undefined;
  let exitCode = 1;
  let retainCopy = false;
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
      await write(process.stderr, `${errorText(error)}\n`);
    } finally {
      if (session) {
        try {
          const inspection = session.inspect();
          const receipt = selectedReceipt(inspection.receipt ?? unavailableReceipt("no-run", fallbackCommand(inspection.state === "ready"),
            unavailableProcessReceipt(inspection.state === "ready")));
          await writeReceipt(receipt, format);
          if (htmlDestination) {
            try { await exportReceiptHtml(receipt, htmlDestination); }
            catch (error) {
              exitCode = 1;
              await write(process.stderr, `Twin HTML export failed: ${errorText(error)}\n`);
            }
          }
          if (review && inspection.state === "finished" && !interruption.signal.aborted) {
            const choice = await reviewChoice(interruption.signal);
            if (choice === "apply" && !interruption.signal.aborted) {
              const applied = await session.apply();
              const paths = "paths" in applied ? applied.paths : [];
              await write(process.stderr, `Twin apply ${applied.status}${applied.status === "applied" ? `: ${applied.changes} changes`
                : `: ${JSON.stringify({ reason: safeTerminalValue(applied.reason, 512), paths: paths.slice(0, 20).map(path => safeTerminalValue(path, 128)), omitted: Math.max(0, paths.length - 20) })}`}\n`);
              if (applied.status !== "applied") {
                retainCopy = true; exitCode = 1;
                if (applied.status === "failed") await write(process.stderr, "Twin apply may have changed earlier paths; inspect both original and retained copy.\n");
              }
            } else if (choice === "discard" && !interruption.signal.aborted) {
              // Discard below after the receipt and review prompt have settled.
            } else {
              retainCopy = true; exitCode = 1;
              await write(process.stderr, `Twin review ${interruption.signal.aborted ? "interrupted" : choice}; no apply or discard requested.\n`);
            }
          } else if (review) {
            retainCopy = true; exitCode = 1;
            await write(process.stderr, "Twin review unavailable: command or process settlement is uncertain, or execution was interrupted.\n");
          }
        } catch (error) {
          exitCode = 1;
          if (review) retainCopy = true;
          if (review) await write(process.stderr, `Twin review failed: ${errorText(error)}\n`);
        }
        if (retainCopy) await write(process.stderr, copyLocationMessage(session.workspacePath));
        else try {
          const discarded = await session.discard();
          if (discarded.status === "refused" || discarded.status === "failed") {
            exitCode = 1;
            retainCopy = true;
            await write(process.stderr, `Twin discard ${discarded.status}: ${safeTerminalValue(discarded.reason, 512)}\n`);
            await write(process.stderr, copyLocationMessage(session.workspacePath, discarded.status === "failed"));
          }
        } catch (error) {
          retainCopy = true;
          await write(process.stderr, `Twin discard failed: ${errorText(error)}\n`);
          await write(process.stderr, copyLocationMessage(session.workspacePath, true));
          exitCode = 1;
        }
      }
      if (scratchParent && !retainCopy) {
        try { await rmdir(scratchParent); }
        catch (error) {
          await write(process.stderr, `${errorText(error)}\n`);
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
