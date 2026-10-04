#!/usr/bin/env node
/// <reference types="node" />

import { tmpdir } from "node:os";
import { realpathSync } from "node:fs";
import { mkdtemp, rmdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { createTwin, DEFAULT_SCAN_TIMEOUT_MS, validScanTimeoutMs, unavailableProcessReceipt, type CommandReceipt, type MinimalReceipt, type ProcessReceipt, type WatchId } from "@twin-cli/core";
import { renderReceiptText, renderCompactReceipt, safeTerminalValue } from "./receipt-text.js";
import { exportReceiptHtml } from "./receipt-html.js";
import { resolveExecutable } from "./executable.js";
import { preparationErrorDiagnostic } from "./error-diagnostics.js";
import { initConfig, loadConfig, validTimeout } from "./config.js";
import { askTerminal, chooseTerminal, preparation, renderLogo, terminalColors, terminalOutput, terminalPrompts } from "./terminal-ui.js";

const help = `Usage: twin run [--interactive] [--timeout-ms=<integer>] [--scan-timeout-ms=<integer>] [--receipt=text] [--receipt-html=<file>] [--review] -- <executable> [args...]

twin init saves project-root twin.config.json without launching a command.
Bare twin and commandless twin run use that config.
Aliases: -i = --interactive, -r = --review, -t text = --receipt=text.
--no-interactive and --no-review override saved true values; conflicting flags are rejected.
Explicit options override config; a command after -- replaces the saved command.
Twin runs commands in a disposable project copy. It is not an OS sandbox.
Use a bare executable name (node) or an absolute executable path (/usr/bin/node).
Bare names use the command's PATH in order; missing PATH has no candidates.
Empty/relative PATH entries use the copy's working directory; executable symlinks are followed.
--interactive inherits stdin, stdout and stderr; command output is not captured.
--timeout-ms=<integer> sets the command deadline (1–3600000 ms); defaults: captured 60000 ms, interactive 3600000 ms.
--scan-timeout-ms=<integer> sets each inventory's independent elapsed-time budget (1–3600000 ms; default 30000 ms).
--receipt=text prints a bounded human receipt on stderr instead of the default JSON frame.
--receipt-html=<file> also exports a bounded standalone HTML receipt without overwriting a file.
--review prints the receipt, then asks on stdin to apply, discard, or cancel and retain in this invocation.
EOF, interruption, or another answer retains the copy for manual inspection.
Retained copies cannot be applied by a later twin CLI invocation.
`;

type ReviewChoice = "apply" | "discard" | "cancel" | "other" | "eof" | "interrupted";

async function reviewChoice(signal: AbortSignal): Promise<ReviewChoice> {
  if (terminalPrompts()) {
    const choice = await chooseTerminal({ message: "Twin review", choices: [
      { name: "Apply changes", value: "apply" }, { name: "Discard copy", value: "discard" },
      { name: "Cancel and retain copy", value: "cancel" },
    ], default: "cancel" }, signal);
    return signal.aborted ? "interrupted" : choice === "apply" || choice === "discard" ? choice : "cancel";
  }
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
      finish(choice === "apply" || choice === "discard" || choice === "cancel" ? choice : "other");
    });
    lines.once("close", () => finish("eof"));
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) finish("interrupted");
    else void write(process.stderr, "Twin review: type apply or discard, then Enter, or cancel to retain (EOF or another answer retains copy): ").catch(() => finish("other"));
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
  if (format === "text") {
    await write(process.stderr, terminalOutput() ? renderCompactReceipt(receipt, terminalColors()) : renderReceiptText(receipt));
    return;
  }
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

  if (argv[0] === "init" && argv.length === 1) {
    const tty = terminalPrompts();
    const lines = tty ? undefined : createInterface({ input: process.stdin, terminal: false });
    const iterator = lines?.[Symbol.asyncIterator]();
    const cancellation = new AbortController();
    const cancel = (): void => { cancellation.abort(); lines?.close(); };
    process.on("SIGINT", cancel);
    process.on("SIGTERM", cancel);
    try {
      if (tty) await write(process.stderr, renderLogo(process.stderr.columns || 80, terminalColors()));
      await initConfig(process.cwd(), async prompt => {
        if (tty) return askTerminal(prompt, cancellation.signal);
        await write(process.stderr, prompt);
        const next = await iterator!.next();
        if (cancellation.signal.aborted) throw new Error("Twin init cancelled: interrupted; no config published.");
        if (next.done) throw new Error("Twin init cancelled: input ended; no config saved.");
        return next.value;
      }, cancellation.signal, tty ? menu => chooseTerminal(menu, cancellation.signal) : undefined);
      await write(process.stdout, "Saved twin.config.json. Run twin from this project directory. Saved one-shot tasks repeat unless a command after -- overrides them.\n");
      return 0;
    } catch (error) {
      await write(process.stderr, `${errorText(error)}\n`);
      return 2;
    } finally {
      lines?.close();
      process.off("SIGINT", cancel);
      process.off("SIGTERM", cancel);
    }
  }

  let interactive: boolean;
  let review: boolean;
  let format: "json" | "text";
  let timeoutMs: number;
  let scanTimeoutMs: number;
  let htmlDestination: string | undefined;
  let command: readonly string[];
  try {
    const input = argv[0] === "run" ? argv.slice(1) : argv;
    const separator = input.indexOf("--");
    const flags = input.slice(0, separator < 0 ? undefined : separator);
    const options: { interactive?: boolean; review?: boolean; receipt?: "json" | "text"; timeoutMs?: number; scanTimeoutMs?: number } = {};
    const seen = new Set<string>();
    for (let i = 0; i < flags.length; i++) {
      const flag = flags[i]!;
      let key: string;
      if (flag === "--interactive" || flag === "-i" || flag === "--no-interactive") { key = "interactive"; options.interactive = flag !== "--no-interactive"; }
      else if (flag === "--review" || flag === "-r" || flag === "--no-review") { key = "review"; options.review = flag !== "--no-review"; }
      else if (flag === "--receipt=text" || flag === "--receipt=json" || flag === "-t") {
        key = "receipt";
        const value = flag === "-t" ? flags[++i] : flag.slice("--receipt=".length);
        if (value !== "text" && value !== "json") throw new Error("Invalid Twin receipt option.");
        options.receipt = value;
      } else if (flag.startsWith("--timeout-ms=")) {
        key = "timeout";
        const value = flag.slice("--timeout-ms=".length);
        if (!/^[0-9]+$/.test(value) || !validTimeout(Number(value))) throw new Error("Invalid Twin timeout.");
        options.timeoutMs = Number(value);
      } else if (flag.startsWith("--scan-timeout-ms=")) {
        key = "scan-timeout";
        const value = flag.slice("--scan-timeout-ms=".length);
        if (!/^[0-9]+$/.test(value) || !validScanTimeoutMs(Number(value))) throw new Error("Invalid Twin scan timeout.");
        options.scanTimeoutMs = Number(value);
      } else if (flag.startsWith("--receipt-html=")) {
        key = "html"; htmlDestination = flag.slice("--receipt-html=".length);
        if (!htmlDestination) throw new Error("Invalid Twin HTML destination.");
      } else throw new Error("Invalid Twin arguments.");
      if (seen.has(key)) throw new Error("Invalid Twin arguments: duplicate option.");
      seen.add(key);
    }
    const config = await loadConfig(process.cwd());
    command = separator < 0 ? config?.command ?? [] : input.slice(separator + 1);
    if (!command.length || !command[0]) throw new Error("No command selected. Run twin init or twin run -- <executable> [args...].");
    interactive = options.interactive ?? config?.interactive ?? false;
    review = options.review ?? config?.review ?? false;
    format = options.receipt ?? config?.receipt ?? "json";
    timeoutMs = options.timeoutMs ?? config?.timeoutMs ?? (interactive ? 3600000 : 60000);
    scanTimeoutMs = options.scanTimeoutMs ?? config?.scanTimeoutMs ?? DEFAULT_SCAN_TIMEOUT_MS;
  } catch (error) {
    await write(process.stderr, `${errorText(error)}\n`);
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
    const feedback = preparation(format);
    let phase: "preparation" | "execution" = "preparation";
    try {
      scratchParent = await mkdtemp(join(tmpdir(), "twin-cli-"));
      session = await createTwin({ sourceDirectory: process.cwd(), scratchParent, scanTimeoutMs, scanSignal: interruption.signal });
      phase = "execution";
      const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
      const executable = await resolveExecutable(command[0]!, env, session.workspacePath);
      feedback.stop();
      if (interruption.signal.aborted) throw new Error("Interrupted before command launch");
      const result = await session.run({ executable, argv: command.slice(1), env, timeoutMs,
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
      await write(process.stderr, phase === "preparation" ? preparationErrorDiagnostic(error) : `${errorText(error)}\n`);
    } finally {
      feedback.stop();
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
          } else if (review && format === "text") {
            await write(process.stderr, "Twin discard removed: project copy cleaned up. Outside-project recovery is not established.\n");
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
