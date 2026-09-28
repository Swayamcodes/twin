#!/usr/bin/env node
/// <reference types="node" />

import { tmpdir } from "node:os";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createTwin } from "@twin-cli/core";

const help = `Usage: twin run -- <executable> [args...]

Twin runs commands in a disposable project copy. It is not an OS sandbox.
`;

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
    process.stdout.write(result.stdout.bytes);
    process.stderr.write(result.stderr.bytes);
    await session.inspect();
    exitCode = result.exitCode === 0 ? 0 : 1;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  } finally {
    if (session) {
      try {
        await session.discard();
      } catch (error) {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        exitCode = 1;
      }
    }
  }

  return exitCode;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  process.exitCode = await main();
}
