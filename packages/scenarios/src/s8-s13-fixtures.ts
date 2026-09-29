import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";

export type MeasuredScenario = "S8" | "S13" | "S9";
export const environment = Object.freeze({ LANG: "C", LC_ALL: "C", TZ: "UTC" });
export const s8Files = Object.freeze({
  "delete-me.txt": "S8 disposable target.\n",
  ".control": "S8 dotfile control.\n",
  "controls/keep.txt": "S8 nested control.\n",
});
export const s13Files = Object.freeze({
  "notes.txt": "Scenario fixture notes.\n",
  "app.js": 'console.log("fixture");\n',
  ".gitignore": ".env\nnode_modules/\n",
  "scratch.txt": "Untracked scratch data.\n",
  ".env": "TWIN_SCENARIO_SECRET=fake-only\n",
  "node_modules/lib.txt": "Ignored dependency fixture.\n",
});
export const s9Files = Object.freeze({ "project.txt": "S9 project control.\n",
  ".project-control": "S9 copied dotfile.\n" });
export const s9InitialNote = "S9 fake-home baseline.\n";
export const s9AppendedLine = "S9 fixed appended line.\n";
export const success = Object.freeze({ S8: "TWIN_S8_DELETE_OK\n",
  S13: '{"action":"twin-s13-inputs-v1","env":true,"dependency":true}\n', S9: "TWIN_S9_APPEND_OK\n" });
// Exact bytes from the committed 2.5R-4 proof.
const s8Source = `import { lstatSync, unlinkSync } from "node:fs";
let deleted = false;
try {
  if (process.argv.length !== 2) throw new Error("arguments forbidden");
  const target = lstatSync("delete-me.txt");
  if (!target.isFile()) throw new Error("target is not a regular file");
  unlinkSync("delete-me.txt");
  deleted = true;
} catch {
  process.stderr.write("TWIN_S8_DELETE_FAILURE\\n");
  process.exitCode = 1;
}
if (deleted) process.stdout.write("TWIN_S8_DELETE_OK\\n");
`;
// Exact bytes from the committed 2.5R-3 proof.
const s13Source = String.raw`import { readFileSync } from "node:fs";
let valid = process.argv.length === 2;
for (const [path, expected] of [
  [".env", "TWIN_SCENARIO_SECRET=fake-only\n"],
  ["node_modules/lib.txt", "Ignored dependency fixture.\n"],
]) {
  try {
    const bytes = readFileSync(path);
    if (!bytes.equals(Buffer.from(expected, "utf8"))) valid = false;
  } catch {
    valid = false;
  }
}
if (valid) {
  process.stdout.write('{"action":"twin-s13-inputs-v1","env":true,"dependency":true}\n');
} else {
  process.stderr.write("TWIN_S13_INPUT_FAILURE\n");
  process.exitCode = 1;
}
`;
// Exact bytes from the committed 2.5R-5 S9 proof action.
const s9Source = `import { constants, lstatSync, openSync, fstatSync, writeSync, closeSync } from "node:fs";
import { isAbsolute, join } from "node:path";
const home = process.env.HOME;
try {
  if (process.argv.length !== 2 || !home || !isAbsolute(home) || home.includes("\\0")) throw new Error("invalid input");
  const path = join(home, ".s9-note");
  const before = lstatSync(path);
  if (!before.isFile() || before.nlink !== 1) throw new Error("invalid target");
  const descriptor = openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== before.dev || opened.ino !== before.ino) throw new Error("target changed");
    const bytes = Buffer.from("S9 fixed appended line.\\n", "utf8");
    let offset = 0;
    while (offset < bytes.length) {
      const written = writeSync(descriptor, bytes, offset, bytes.length - offset);
      if (written <= 0) throw new Error("write made no progress");
      offset += written;
    }
  } finally { closeSync(descriptor); }
  process.stdout.write("TWIN_S9_APPEND_OK\\n");
} catch {
  process.stderr.write("TWIN_S9_APPEND_FAILURE\\n");
  process.exitCode = 1;
}
`;
export const actionBytes = Object.freeze({ S8: Buffer.from(s8Source), S13: Buffer.from(s13Source), S9: Buffer.from(s9Source) });
export const actionName = Object.freeze({ S8: "delete-one-file.mjs", S13: "read-ignored-inputs.mjs", S9: "append-fake-home.mjs" });
export const actionDigest = (id: MeasuredScenario): string => createHash("sha256").update(actionBytes[id]).digest("hex");

export interface Entry { readonly path: string; readonly kind: "file" | "directory";
  readonly mode: number; readonly sha256?: string; readonly dev: number; readonly ino: number }
export async function inventory(root: string): Promise<Entry[]> {
  const found: Entry[] = [];
  async function visit(path: string): Promise<void> {
    const stat = await lstat(path);
    assert(!stat.isSymbolicLink() && (stat.isFile() || stat.isDirectory()));
    if (stat.isFile()) assert.equal(stat.nlink, 1);
    const name = relative(root, path);
    assert(!name.startsWith(".."));
    found.push({ path: name, kind: stat.isDirectory() ? "directory" : "file", mode: stat.mode & 0o7777,
      ...(stat.isFile() ? { sha256: createHash("sha256").update(await readFile(path)).digest("hex") } : {}),
      dev: stat.dev, ino: stat.ino });
    if (stat.isDirectory()) for (const child of (await readdir(path)).sort()) await visit(join(path, child));
  }
  await visit(root);
  return found;
}
export function content(entries: readonly Entry[]): readonly unknown[] {
  return entries.map(({ path, kind, mode, sha256 }) => [path, kind, mode, sha256 ?? null]);
}
export async function exactFile(root: string, name: string, bytes: Uint8Array, expectedMode?: number): Promise<void> {
  const path = join(root, name), before = await lstat(path);
  assert(typeof process.getuid === "function");
  assert(before.isFile() && !before.isSymbolicLink() && before.nlink === 1 && before.uid === process.getuid());
  if (expectedMode !== undefined) assert.equal(before.mode & 0o7777, expectedMode);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    assert(opened.isFile() && opened.dev === before.dev && opened.ino === before.ino && opened.nlink === 1);
    const actual = await handle.readFile();
    assert(actual.equals(Buffer.from(bytes)), `Fixed file differs: ${name}`);
    const after = await handle.stat(), named = await lstat(path);
    assert(after.dev === before.dev && after.ino === before.ino && after.size === before.size
      && after.mtimeMs === before.mtimeMs && after.ctimeMs === before.ctimeMs
      && named.dev === before.dev && named.ino === before.ino);
  } finally { await handle.close(); }
}
export async function requireInputs(id: MeasuredScenario, root: string, entries: readonly Entry[]): Promise<void> {
  const files = id === "S8" ? s8Files : id === "S13" ? s13Files : s9Files;
  for (const [name, value] of Object.entries(files)) {
    assert(entries.some(entry => entry.path === name && entry.kind === "file"
      && entry.sha256 === createHash("sha256").update(value).digest("hex")), `Missing fixed input: ${name}`);
    await exactFile(root, name, Buffer.from(value), id === "S8" ? 0o600 : undefined);
  }
  if (id === "S8") assert(!entries.some(entry => entry.path.toLowerCase() === ".git" || entry.path.toLowerCase().startsWith(".git/")));
  else if (id === "S13") assert(entries.some(entry => entry.path === ".git" && entry.kind === "directory"));
  else assert(!entries.some(entry => entry.path.toLowerCase() === ".git" || entry.path.toLowerCase().startsWith(".git/")));
}
