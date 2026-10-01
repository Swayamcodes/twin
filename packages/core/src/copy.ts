import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, readlink, symlink } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { assertRootAuthority, contains, sameIdentity, type OwnedRoot } from "./safety.js";

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
async function directoryEntries(path: string, inGit: boolean): Promise<string[]> {
  const names = await readdir(path);
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
    }
  }
}
export async function copySource(root: OwnedRoot): Promise<void> {
  await assertRootAuthority(root);
  const visit = async (source: string, destination: string, relativePath: string): Promise<void> => {
    const stat = await lstat(source, { bigint: true });
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
      const target = await readlink(source);
      if (inGit || isAbsolute(target) || !contains(root.source, resolve(dirname(source), target))) {
        throw new Error(`Unsupported symlink: ${relativePath}`);
      }
      await symlink(target, destination);
    } else if (stat.isDirectory()) {
      const names = await directoryEntries(source, relativePath === ".git");
      await mkdir(destination, { mode: 0o700 });
      await chmod(destination, 0o700);
      for (const name of names) await visit(join(source, name), join(destination, name), `${relativePath}/${name}`);
      await chmod(destination, Number(stat.mode & 0o777n));
    } else if (stat.isFile()) {
      const input = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        if (!sameIdentity(stat, await input.stat({ bigint: true }))) throw new Error("Source file changed");
        if (relativePath === ".git/config") {
          if (stat.size > 65536n) throw new Error("Git config exceeds conservative 64 KiB limit");
          const config = Buffer.alloc(65537);
          const { bytesRead } = await input.read(config, 0, config.length, 0);
          if (BigInt(bytesRead) !== stat.size) throw new Error("Git config changed or incomplete");
          checkGitConfig(new TextDecoder("utf-8", { fatal: true }).decode(config.subarray(0, bytesRead)), root.source);
        }
        const output = await open(destination, "wx", 0o600);
        try {
          const buffer = Buffer.alloc(65536);
          for (;;) {
            const { bytesRead } = await input.read(buffer, 0, buffer.length, null);
            if (bytesRead === 0) break;
            let offset = 0;
            while (offset < bytesRead) {
              const { bytesWritten } = await output.write(buffer, offset, bytesRead - offset, null);
              if (bytesWritten === 0) throw new Error("Copy write made no progress");
              offset += bytesWritten;
            }
          }
          await output.chmod(Number(stat.mode & 0o777n));
        } finally { await output.close(); }
      } finally { await input.close(); }
    } else throw new Error(`Unsupported source entry: ${relativePath}`);
  };
  for (const name of await directoryEntries(root.source, false)) await visit(join(root.source, name), join(root.workspace, name), name);
  await assertRootAuthority(root);
}
