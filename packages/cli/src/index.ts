#!/usr/bin/env node
/// <reference types="node" />

import { tmpdir } from "node:os";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createTwin, type MinimalReceipt, type WatchId } from "@twin-cli/core";

const help = `Usage: twin run -- <executable> [args...]

Twin runs commands in a disposable project copy. It is not an OS sandbox.
`;

const WATCH_IDS: readonly WatchId[] = [
  ".gitconfig", ".npmrc", ".bashrc", ".zshrc",
  ".codex/config.toml", ".claude/settings.json", ".gemini/settings.json",
];

function unavailableReceipt(reason: string): MinimalReceipt {
  return {
    schemaVersion: 1,
    files: { coverage: "unavailable", issues: [{ reason }], changes: [] },
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

async function writeReceipt(receipt: MinimalReceipt): Promise<void> {
  const limit = 8 * 1024 * 1024;
  let estimatedBytes = 2048;
  for (const collection of [receipt.files.issues, receipt.files.changes, receipt.watch]) {
    for (const item of collection) {
      estimatedBytes += Buffer.byteLength(JSON.stringify(item), "utf8") + 1;
      if (estimatedBytes > limit) break;
    }
    if (estimatedBytes > limit) break;
  }
  let payload = Buffer.from(JSON.stringify(estimatedBytes > limit ? unavailableReceipt("receipt-limit") : receipt), "utf8");
  if (payload.length > limit) payload = Buffer.from(JSON.stringify(unavailableReceipt("receipt-limit")), "utf8");
  await write(process.stderr, Buffer.from(`\x1eTWIN-RECEIPT/1 ${payload.length}\n`, "ascii"));
  await write(process.stderr, payload);
  await write(process.stderr, "\n");
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) {
    process.stdout.write(help);
    return 0;
  }

  if (argv[0] !== "run" || argv[1] !== "--" || argv.length < 3 || !argv[2]) {
    process.stderr.write(help);
    return 2;
  }

  let session: Awaited<ReturnType<typeof createTwin>> | undefined;
  let exitCode = 1;

  try {
    session = await createTwin({ sourceDirectory: process.cwd(), scratchParent: tmpdir() });
    const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
    const result = await session.run({ executable: argv[2], argv: argv.slice(3), env });
    await write(process.stdout, result.stdout.bytes);
    await write(process.stderr, result.stderr.bytes);
    exitCode = result.exitCode === 0 ? 0 : 1;
  } catch (error) {
    await write(process.stderr, `${error instanceof Error ? error.message : String(error)}\n`);
  } finally {
    if (session) {
      try {
        await writeReceipt(session.inspect().receipt ?? unavailableReceipt("no-run"));
      } catch {
        exitCode = 1;
      }
      try {
        const discarded = await session.discard();
        if (discarded.status === "refused" || discarded.status === "failed") {
          exitCode = 1;
          await write(process.stderr, `Twin discard ${discarded.status}\n`);
        }
      } catch (error) {
        await write(process.stderr, `${error instanceof Error ? error.message : String(error)}\n`);
        exitCode = 1;
      }
    }
  }

  return exitCode;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  process.exitCode = await main();
}
