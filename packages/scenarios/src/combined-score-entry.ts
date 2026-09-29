import { constants } from "node:fs";
import { write } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { combineScores, incompleteCombinedScore, CombinedScoreResultSchema, type CombinedScoreResult } from "./contract/combined-score.js";

const maxBytes = 8 * 1024 * 1024;

async function readResult(handle: FileHandle, size: number): Promise<unknown> {
  const bytes = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const read = await handle.read(bytes, offset, size - offset, offset);
    if (read.bytesRead === 0) throw new Error("invalid-input");
    offset += read.bytesRead;
  }
  const extra = Buffer.alloc(1);
  if ((await handle.read(extra, 0, 1, size)).bytesRead !== 0) throw new Error("invalid-input");
  const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  if (text.charCodeAt(0) === 0xfeff || !text.startsWith("{") || !text.endsWith("}\n")) throw new Error("invalid-input");
  const body = text.slice(0, -1);
  const parsed: unknown = JSON.parse(body);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed) || JSON.stringify(parsed) !== body)
    throw new Error("invalid-input");
  return parsed;
}

/** Reads bounded, distinct regular files. No producer or child process is used. */
export async function readCombinedScoreFiles(args: readonly string[]): Promise<CombinedScoreResult> {
  if (args.length !== 2) return incompleteCombinedScore("invalid-input");
  const handles: FileHandle[] = [];
  try {
    for (const path of args) handles.push(await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK));
    const stats = await Promise.all(handles.map(handle => handle.stat()));
    if (stats.some(stat => !stat.isFile() || stat.size < 1 || stat.size > maxBytes)
      || stats[0]!.dev === stats[1]!.dev && stats[0]!.ino === stats[1]!.ino)
      return incompleteCombinedScore("invalid-input");
    const values: unknown[] = [];
    for (let i = 0; i < 2; i++) values.push(await readResult(handles[i]!, stats[i]!.size));
    const after = await Promise.all(handles.map(handle => handle.stat()));
    if (after.some((stat, i) => stat.dev !== stats[i]!.dev || stat.ino !== stats[i]!.ino
      || stat.size !== stats[i]!.size || stat.mtimeMs !== stats[i]!.mtimeMs || stat.ctimeMs !== stats[i]!.ctimeMs))
      return incompleteCombinedScore("invalid-input");
    return combineScores(values[0], values[1]);
  } catch {
    return incompleteCombinedScore("invalid-input");
  } finally {
    await Promise.allSettled(handles.map(handle => handle.close()));
  }
}

export function renderCombinedScoreLine(result: CombinedScoreResult): string {
  return `${JSON.stringify(CombinedScoreResultSchema.parse(result))}\n`;
}

async function output(line: string): Promise<void> {
  const bytes = Buffer.from(line, "utf8");
  for (let offset = 0; offset < bytes.length;) {
    const count = await new Promise<number>((resolve, reject) => write(1, bytes, offset, bytes.length - offset, null,
      (error, written) => error ? reject(error) : resolve(written)));
    if (!Number.isSafeInteger(count) || count <= 0 || count > bytes.length - offset) throw new Error("output-failed");
    offset += count;
  }
}

export async function main(args: readonly string[]): Promise<number> {
  const result = await readCombinedScoreFiles(args);
  try { await output(renderCombinedScoreLine(result)); } catch { return 1; }
  return result.status === "complete" ? 0 : 1;
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
