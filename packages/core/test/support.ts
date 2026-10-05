import { randomBytes } from "node:crypto";
import { type BigIntStats } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rmdir, unlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createTwin, type RunOptions, type TwinSession } from "../src/index.js";

// Independent fixture authority; do not use production cleanup to erase fixtures.
const registered = new Map<string, { token: string; identity: BigIntStats | null }>();
const repository = fileURLToPath(new URL("../../..", import.meta.url));
function inside(parent: string, path: string): boolean {
  const suffix = relative(parent, path);
  return suffix === "" || (!isAbsolute(suffix) && suffix !== ".." && !suffix.startsWith(`..${sep}`));
}
async function canonicalEvenIfMissing(path: string): Promise<string> {
  try { return await realpath(path); }
  catch (error: unknown) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    const parent = dirname(path);
    if (parent === path) throw error;
    return join(await canonicalEvenIfMissing(parent), path.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)));
  }
}
async function checkedBase(): Promise<string> {
  const supplied = resolve(tmpdir());
  const base = await realpath(supplied);
  const excluded = [repository, join(homedir(), ".local/state/twin")];
  if (process.env.XDG_STATE_HOME) excluded.push(resolve(process.env.XDG_STATE_HOME, "twin"));
  for (const path of excluded) {
    const canonical = await canonicalEvenIfMissing(resolve(path));
    if ([supplied, base].some(candidate => inside(resolve(path), candidate) || inside(canonical, candidate))) {
      throw new Error(`Refusing test allocation base ${base}`);
    }
  }
  return base;
}
async function roots(base: string): Promise<string[]> {
  return (await readdir(base)).filter(name => name.startsWith("twin-core-test-")).sort();
}
async function removeFixture(path: string): Promise<void> {
  const entry = registered.get(path);
  const stat = await lstat(path, { bigint: true });
  if (!entry?.identity || stat.ino !== entry.identity.ino || stat.dev !== entry.identity.dev
      || !stat.isDirectory() || await realpath(path) !== path || stat.uid !== BigInt(process.getuid!())) {
    throw new Error(`Fixture authority mismatch: ${path}`);
  }
  const marker = join(path, ".fixture-owner");
  const markerStat = await lstat(marker);
  if (!markerStat.isFile() || markerStat.isSymbolicLink() || await readFile(marker, "utf8") !== entry.token) {
    throw new Error(`Fixture marker mismatch: ${path}`);
  }
  const childPath = (parent: Buffer, name: Buffer): Buffer => Buffer.concat([parent, Buffer.from("/"), name]);
  const remove = async (target: Buffer): Promise<void> => {
    const before = await lstat(target, { bigint: true });
    if (before.uid !== stat.uid || before.dev !== stat.dev) throw new Error(`Foreign fixture entry: ${target}`);
    if (before.isDirectory()) {
      for (const name of await readdir(target, { encoding: "buffer" })) await remove(childPath(target, name));
      const after = await lstat(target, { bigint: true });
      if (!after.isDirectory() || after.ino !== before.ino || after.dev !== before.dev) throw new Error("Fixture directory changed");
      await rmdir(target);
    } else if (before.isFile() || before.isSymbolicLink()) await unlink(target);
    else throw new Error(`Unsupported fixture cleanup entry: ${target}`);
  };
  const rootBytes = Buffer.from(path), markerBytes = Buffer.from(".fixture-owner");
  for (const name of await readdir(rootBytes, { encoding: "buffer" }))
    if (!name.equals(markerBytes)) await remove(childPath(rootBytes, name));
  await unlink(marker);
  await rmdir(path);
  registered.delete(path);
}
export interface Fixture {
  readonly path: string;
  readonly source: string;
  readonly scratch: string;
  readonly sessions: TwinSession[];
  create(): Promise<TwinSession>;
}
export async function fixtureTest(body: (fixture: Fixture) => Promise<void>): Promise<void> {
  const base = await checkedBase();
  const before = await roots(base);
  const path = await mkdtemp(join(base, "twin-core-test-"));
  const entry = { token: randomBytes(32).toString("hex"), identity: null as BigIntStats | null };
  registered.set(path, entry); // Before chmod, marker or child-directory mutation.
  const sessions: TwinSession[] = [];
  const source = join(path, "source");
  const scratch = join(path, "scratch");
  const errors: unknown[] = [];
  let initialized = false;
  try {
    entry.identity = await lstat(path, { bigint: true });
    await chmod(path, 0o700);
    await writeFile(join(path, ".fixture-owner"), entry.token, { flag: "wx", mode: 0o600 });
    await mkdir(source, { mode: 0o700 });
    await mkdir(scratch, { mode: 0o700 });
    initialized = true;
    await body({ path, source, scratch, sessions, create: async () => {
      const session = await createTwin({ sourceDirectory: source, scratchParent: scratch });
      sessions.push(session);
      return session;
    } });
  } catch (error: unknown) { errors.push(error); }
  for (const session of sessions) {
    try {
      const result = await session.discard();
      if (result.status !== "removed" && result.status !== "already-removed") throw new Error(JSON.stringify(result));
    } catch (error: unknown) { errors.push(error); }
  }
  let remaining: string[] = ["initialization incomplete"];
  if (initialized) remaining = await readdir(scratch);
  // Never sweep leaked Twin roots with fixture cleanup.
  if (remaining.length === 0) {
    try { await removeFixture(path); } catch (error: unknown) { errors.push(error); }
  } else errors.push(new Error(`Retained Twin allocations at ${scratch}: ${JSON.stringify(remaining)}`));
  const after = await roots(base);
  console.log(`ROOT ACCOUNTING ${JSON.stringify({ fixture: path, before, after,
    twinRoots: sessions.map(session => dirname(session.workspacePath)), remainingTwinRoots: remaining,
    registeredFixtures: [...registered.keys()] })}`);
  if (JSON.stringify(before) !== JSON.stringify(after)) errors.push(new Error("Test root set changed"));
  if (errors.length) throw new AggregateError(errors, `Fixture test failed: ${path}`);
}
export async function put(source: string, name: string, bytes: string | Uint8Array, mode = 0o644): Promise<void> {
  const path = join(source, name);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, bytes, { flag: "wx", mode });
  await chmod(path, mode);
}
export async function fingerprint(path: string): Promise<string> {
  const entries: string[] = [];
  const visit = async (current: string): Promise<void> => {
    const stat = await lstat(current);
    const name = relative(path, current);
    if (stat.isSymbolicLink()) entries.push(`${name}:link:${await readlink(current)}`);
    else if (stat.isDirectory()) { entries.push(`${name}:dir:${stat.mode & 0o777}`); for (const item of (await readdir(current)).sort()) await visit(join(current, item)); }
    else entries.push(`${name}:${stat.mode & 0o777}:${(await readFile(current)).toString("base64")}`);
  };
  await visit(path);
  return JSON.stringify(entries);
}
// The only executable used by tests is this process's Node. Behaviors are fixed.
const programs = {
  echo: 'process.stdout.write(JSON.stringify({argv:process.argv.slice(1),cwd:process.cwd(),env:process.env}));',
  exit: 'process.exitCode=7;',
  signal: 'process.kill(process.pid,"SIGTERM");',
  binary: 'process.stdout.write(Buffer.alloc(70000,255));process.stderr.write(Buffer.alloc(65536,128));',
  wait: 'setInterval(()=>{},1000);',
  stubborn: 'process.on("SIGTERM",()=>{});process.stdout.write("ready");setInterval(()=>{},1000);',
  edit: 'const fs=require("node:fs");fs.writeFileSync("file","changed");fs.unlinkSync("delete-me");fs.writeFileSync("new","new");',
  externalLink: 'require("node:fs").symlinkSync(process.env.TARGET,"external-link");',
} as const;
export function nodeOptions(program: keyof typeof programs, argv: readonly string[] = [], env: Record<string, string> = {}): RunOptions {
  return { executable: process.execPath, argv: ["-e", programs[program], "--", ...argv], env, timeoutMs: 5000 };
}
