import { constants, type BigIntStats } from "node:fs";
import { chmod, lstat, mkdir, open, symlink, type FileHandle } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { assertRootAuthority, contains, sameIdentity, type OwnedRoot } from "./safety.js";
import { checkEntryPath, checkRelativeTarget, copyLinkTarget, directoryNames, LINK_DISCOVERY_LIMITS, readLinkState, type BaselineLink, type BaselineLinks } from "./symlink-policy.js";
import { checkIo, measured, IoOperation, IoPool, type IoOptions } from "./io-pool.js";

const gitSentinels = new Set(["commondir", "gitdir", "worktrees", "modules", "config.worktree",
  "objects/info/alternates", "objects/info/http-alternates"]);
const gitNames = new Map<string, string>();
for (const path of ["HEAD", "config", "refs", ...gitSentinels]) {
  const parts = path.split("/");
  for (let length = 1; length <= parts.length; length++) {
    const prefix = parts.slice(0, length).join("/");
    gitNames.set(prefix.toLowerCase(), prefix);
  }
}
async function directoryEntries(path: string, inGit: boolean, remaining: number): Promise<string[]> {
  const names = await directoryNames(path, remaining);
  // Deliberately reject the recognizable inventory, without interpreting Git.
  const folded = new Set(names.map(name => name.toLowerCase()));
  if (!inGit && ["head", "objects", "refs"].every(name => folded.has(name))) {
    throw new Error("Unsupported bare Git layout");
  }
  return names;
}

// Deliberately a small accepted grammar, not a Git configuration parser.
function checkGitConfig(text: string, source: string): void {
  let section = "";
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || /^[#;]/.test(line)) continue;
    if (/[\\\x00-\x08\x0b-\x1f\x7f]/.test(line)) throw new Error("Ambiguous Git configuration");
    const header = /^\[([A-Za-z][A-Za-z0-9-]*)(?: "[^"\\]+")?\]$/.exec(line);
    if (header) {
      section = (header[1] ?? "").toLowerCase();
      if (section === "include" || section === "includeif") throw new Error("Unsupported Git include");
      if ((section === "core" || section === "extensions") && line.includes('"')) throw new Error("Ambiguous Git section");
      continue;
    }
    const assignment = /^([A-Za-z][A-Za-z0-9-]*)\s*=\s*(.*)$/.exec(line);
    if (!section || !assignment) throw new Error("Malformed Git configuration");
    const key = (assignment[1] ?? "").toLowerCase();
    const value = assignment[2] ?? "";
    if (/["#;]/.test(value)) throw new Error("Ambiguous Git value");
    if (section === "extensions" && key === "worktreeconfig") throw new Error("Unsupported worktree configuration");
    if (section === "core" && key === "bare" && value.toLowerCase() !== "false") throw new Error("Unsupported bare configuration");
    if (section === "core" && key === "worktree") {
      // Absolute paths cannot relocate safely even when they name the original.
      if (!value || isAbsolute(value) || value.startsWith("~") || !contains(source, resolve(source, ".git", value))) {
        throw new Error("Unsupported external Git worktree");
      }
      try { checkRelativeTarget(Buffer.from(value), 1); }
      catch { throw new Error("Unsupported external Git worktree"); }
    }
  }
}
const stableFile = (a: BigIntStats, b: BigIntStats): boolean => sameIdentity(a, b) && a.mode === b.mode
  && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;

export async function copySource(root: OwnedRoot, options: IoOptions = {}): Promise<BaselineLinks> {
  const span = options.diagnostics?.start("preparation.copy", "both");
  const links = new Map<string, BaselineLink>();
  const directories: { destination: string; mode: number }[] = [];
  let failed = false;
  let firstError: unknown;
  const stop = (error: unknown): void => { if (!failed) { failed = true; firstError = error; } };
  const check = (): void => {
    if (failed) throw firstError;
    try { checkIo(options); } catch (error: unknown) { stop(error); throw error; }
  };
  const operation = new IoOperation<void>(options.pool ?? new IoPool(), outcome => {
    if (!outcome.ok) { stop(outcome.error); throw outcome.error; }
  }, check, span);
  const copyFile = async (source: string, destination: string, relativePath: string, before: BigIntStats): Promise<void> => {
    let input: FileHandle | undefined;
    let output: FileHandle | undefined;
    let incomplete = false;
    let error: unknown;
    try {
      check();
      input = await measured(span, "open", () => open(source, constants.O_RDONLY | constants.O_NOFOLLOW));
      check();
      if (!stableFile(before, await measured(span, "metadata", () => input!.stat({ bigint: true })))) throw new Error(`Source file changed: ${relativePath}`);
      let config: Buffer | undefined;
      if (relativePath === ".git/config") {
        if (before.size > 65536n) throw new Error("Git config exceeds conservative 64 KiB limit");
        config = Buffer.alloc(Number(before.size));
        let offset = 0;
        while (offset < config.length) {
          check();
          const { bytesRead } = await measured(span, "read", () => input!.read(config!, offset, config!.length - offset, null));
          if (bytesRead === 0) throw new Error("Git config changed or incomplete");
          offset += bytesRead;
        }
        check();
        const probe = Buffer.alloc(1);
        if ((await measured(span, "read", () => input!.read(probe, 0, 1, null))).bytesRead !== 0) throw new Error("Git config changed or incomplete");
        if (!stableFile(before, await measured(span, "metadata", () => input!.stat({ bigint: true }))) || !stableFile(before, await measured(span, "metadata", () => lstat(source, { bigint: true })))) {
          throw new Error(`Source file changed: ${relativePath}`);
        }
        checkGitConfig(new TextDecoder("utf-8", { fatal: true }).decode(config), root.source);
      }
      check();
      output = await measured(span, "open", () => open(destination, "wx", 0o600));
      const buffer = config ?? Buffer.alloc(65536);
      let transferred = 0n;
      while (transferred < before.size) {
        check();
        let bytesRead: number;
        if (config) bytesRead = config.length;
        else {
          const remaining = before.size - transferred;
          const length = Number(remaining < BigInt(buffer.length) ? remaining : BigInt(buffer.length));
          bytesRead = (await measured(span, "read", () => input!.read(buffer, 0, length, null))).bytesRead;
        }
        if (bytesRead === 0) throw new Error(`Source file changed or incomplete: ${relativePath}`);
        let offset = 0;
        while (offset < bytesRead) {
          check();
          const { bytesWritten } = await measured(span, "write", () => output!.write(buffer, offset, bytesRead - offset, null));
          if (bytesWritten === 0) throw new Error("Copy write made no progress");
          offset += bytesWritten;
        }
        transferred += BigInt(bytesRead);
      }
      check();
      if (!config && (await measured(span, "read", () => input!.read(buffer, 0, 1, null))).bytesRead !== 0) throw new Error(`Source file changed: ${relativePath}`);
      if (transferred !== before.size || !stableFile(before, await measured(span, "metadata", () => input!.stat({ bigint: true })))
          || !stableFile(before, await measured(span, "metadata", () => lstat(source, { bigint: true })))) throw new Error(`Source file changed: ${relativePath}`);
      check();
      await measured(span, "metadata", () => output!.chmod(Number(before.mode & 0o777n)));
    } catch (caught: unknown) {
      incomplete = true; error = caught;
      stop(caught); operation.stop(firstError);
    }
    finally {
      // Every admitted worker closes both handles before its failure can settle.
      for (const handle of [output, input]) if (handle) {
        try { await measured(span, "close", () => handle.close()); }
        catch (caught: unknown) {
          if (!incomplete) { incomplete = true; error = caught; }
          stop(caught); operation.stop(firstError);
        }
      }
    }
    if (incomplete) { stop(error); throw error; }
  };
  let count = 0;
  const visit = async (source: string, destination: string, relativePath: string): Promise<void> => {
    check();
    if (++count > LINK_DISCOVERY_LIMITS.entries) throw new Error("Copy entry limit");
    checkEntryPath(relativePath);
    const stat = await measured(span, "metadata", () => lstat(source, { bigint: true }));
    check();
    const parts = relativePath.split("/");
    const inGit = parts[0] === ".git";
    const name = parts.at(-1) ?? "";
    const canonical = inGit ? gitNames.get(parts.slice(1).join("/").toLowerCase()) : undefined;
    if (([".git", ".gitmodules"].includes(name.toLowerCase()) && name !== name.toLowerCase())
        || (canonical !== undefined && parts.slice(1).join("/") !== canonical)) {
      throw new Error(`Noncanonical Git name: ${relativePath}`);
    }
    if (!inGit && ["objects/info/alternates", "objects/info/http-alternates"].includes(parts.slice(-3).join("/").toLowerCase())) {
      throw new Error(`Unsupported bare Git alternates: ${relativePath}`);
    }
    if (parts.at(-1) === ".gitmodules" || (parts.at(-1) === ".git" && relativePath !== ".git")
        || (inGit && gitSentinels.has(parts.slice(1).join("/")))) throw new Error(`Unsupported Git layout: ${relativePath}`);
    if (relativePath === ".git" && !stat.isDirectory()) throw new Error("Root .git must be an ordinary directory");
    if (relativePath === ".git/config" && !stat.isFile()) throw new Error("Git config must be a regular file");
    if (stat.isSymbolicLink()) {
      if (inGit) throw new Error(`Unsupported symlink: ${relativePath}`);
      const original = await measured(span, "metadata", () => readLinkState(source, stat));
      check();
      let target: Buffer;
      try { target = copyLinkTarget(root.source, relativePath, original.target); }
      catch (error: unknown) { throw new Error(`Unsupported symlink: ${relativePath}`, { cause: error }); }
      await measured(span, "write", () => symlink(target, destination));
      check();
      const copied = await measured(span, "metadata", () => readLinkState(destination));
      if (!copied.target.equals(target)) throw new Error(`Copied link changed: ${relativePath}`);
      links.set(Buffer.from(relativePath).toString("base64"), Object.freeze({ original, copied }));
    } else if (stat.isDirectory()) {
      const names = await measured(span, "enumeration", () => directoryEntries(source, relativePath === ".git", LINK_DISCOVERY_LIMITS.entries - count));
      check();
      await measured(span, "write", () => mkdir(destination, { mode: 0o700 }));
      await measured(span, "metadata", () => chmod(destination, 0o700));
      for (const name of names) await visit(join(source, name), join(destination, name), `${relativePath}/${name}`);
      directories.push({ destination, mode: Number(stat.mode & 0o777n) });
    } else if (stat.isFile()) {
      if (relativePath === ".git/config") await operation.drain();
      await operation.enqueue(() => copyFile(source, destination, relativePath, stat));
      if (relativePath === ".git/config") await operation.drain();
    } else throw new Error(`Unsupported source entry: ${relativePath}`);
  };
  try {
    check();
    await assertRootAuthority(root);
    for (const name of await measured(span, "enumeration", () => directoryEntries(root.source, false, LINK_DISCOVERY_LIMITS.entries))) await visit(join(root.source, name), join(root.workspace, name), name);
    await operation.drain();
    for (const directory of directories) { check(); await measured(span, "metadata", () => chmod(directory.destination, directory.mode)); }
    check();
    await assertRootAuthority(root);
    span?.end("complete", true);
    return links;
  } catch (error: unknown) {
    stop(error);
    operation.stop(firstError);
    try { await operation.drain(); } finally { span?.end("failed", true); }
    throw firstError;
  }
}
