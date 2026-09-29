import { constants, write } from "node:fs";
import { open } from "node:fs/promises";
import { CombinedScoreResultSchema } from "./contract/combined-score.js";
import { renderMarkdownReport } from "./markdown-report.js";

const maxBytes = 8 * 1024 * 1024;
type ErrorCode = "REPORT_INVALID_INPUT" | "REPORT_INCOMPLETE" | "REPORT_OUTPUT_FAILED";

function fail(code: ErrorCode): number {
  try { process.stderr.write(`${code}\n`); } catch { /* A closed error cannot be delivered to a broken stderr. */ }
  return 1;
}

async function output(bytes: Buffer): Promise<void> {
  const written = await new Promise<number>((resolve, reject) => write(1, bytes, 0, bytes.length, null,
    (error, count) => error ? reject(error) : resolve(count)));
  if (written !== bytes.length) throw new Error("output-failed");
}

/** Reads one bounded regular file through a final-component no-follow descriptor. */
export async function readCombinedResult(path: string): Promise<unknown> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size < 2 || before.size > maxBytes) throw new Error("invalid-input");
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead <= 0) throw new Error("invalid-input");
      offset += bytesRead;
    }
    if ((await handle.read(Buffer.alloc(1), 0, 1, bytes.length)).bytesRead !== 0) throw new Error("invalid-input");
    const after = await handle.stat();
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error("invalid-input");
    const decoded = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    if (decoded.charCodeAt(0) === 0xfeff || !decoded.startsWith("{") || !decoded.endsWith("}\n"))
      throw new Error("invalid-input");
    const value: unknown = JSON.parse(decoded.slice(0, -1));
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid-input");
    return value;
  } finally { await handle.close(); }
}

export async function main(args: readonly string[]): Promise<number> {
  if (args.length !== 1) return fail("REPORT_INVALID_INPUT");
  let value: unknown;
  try { value = await readCombinedResult(args[0]!); } catch { return fail("REPORT_INVALID_INPUT"); }
  const parsed = CombinedScoreResultSchema.safeParse(value);
  if (!parsed.success) return fail("REPORT_INVALID_INPUT");
  if (parsed.data.status !== "complete") return fail("REPORT_INCOMPLETE");
  let markdown: string;
  try { markdown = renderMarkdownReport(value); } catch { return fail("REPORT_INVALID_INPUT"); }
  try { await output(Buffer.from(markdown, "utf8")); } catch { return fail("REPORT_OUTPUT_FAILED"); }
  return 0;
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
