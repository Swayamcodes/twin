import { execFile } from "node:child_process";
import { lstat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

type KnownCategory = "tracked" | "untracked" | "ignored";
export type GitSnapshot =
  | { readonly status: "available"; readonly categories: Map<string, Set<KnownCategory>> }
  | { readonly status: "unavailable"; readonly reason: "not-git" | "git-unavailable" | "git-failed" | "git-incomplete" };

const GIT = "/usr/bin/git";
const MAX_OUTPUT = 16 * 1024 * 1024;
const TIMEOUT_MS = 5_000;

function within(path: string, root: string): boolean {
  const rel = relative(resolve(root), path);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

async function trustedGit(protectedRoots: readonly string[]): Promise<boolean> {
  if (protectedRoots.some(root => within(GIT, root))) return false;
  try {
    for (const path of ["/", "/usr", "/usr/bin", GIT]) {
      const stat = await lstat(path);
      if (stat.uid !== 0 || (stat.mode & 0o022) !== 0) return false;
      if (path === GIT ? !stat.isFile() : !stat.isDirectory()) return false;
    }
    return true;
  } catch { return false; }
}

function callGit(workspace: string, args: readonly string[]): Promise<Buffer> {
  const env: NodeJS.ProcessEnv = {
    PATH: "",
    HOME: "/nonexistent",
    LC_ALL: "C",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
    GIT_CEILING_DIRECTORIES: dirname(workspace),
  };
  return new Promise((fulfill, reject) => {
    execFile(GIT, ["--no-optional-locks", "-c", "core.fsmonitor=false", ...args], {
      cwd: workspace,
      env,
      encoding: "buffer",
      maxBuffer: MAX_OUTPUT,
      timeout: TIMEOUT_MS,
      shell: false,
      windowsHide: true,
    }, (error, stdout) => {
      if (error) reject(error);
      else fulfill(Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout));
    });
  });
}

function parsePaths(data: Buffer): string[] | null {
  if (data.length && data[data.length - 1] !== 0) return null;
  const paths: string[] = [];
  let start = 0;
  for (let i = 0; i < data.length; i++) {
    if (data[i] !== 0) continue;
    const path = data.subarray(start, i);
    if (path.length === 0 || path[0] === 47) return null;
    let segmentStart = 0;
    for (let j = 0; j <= path.length; j++) {
      if (j !== path.length && path[j] !== 47) continue;
      const segment = path.subarray(segmentStart, j);
      if (segment.length === 0 || segment.equals(Buffer.from(".")) || segment.equals(Buffer.from(".."))) return null;
      segmentStart = j + 1;
    }
    paths.push(path.toString("base64"));
    start = i + 1;
  }
  return paths;
}

export async function captureGitCategories(workspace: string, protectedRoots: readonly string[]): Promise<GitSnapshot> {
  try {
    const metadata = await lstat(resolve(workspace, ".git"));
    if (!metadata.isDirectory()) return { status: "unavailable", reason: "git-unavailable" };
  } catch (error) {
    return { status: "unavailable", reason: (error as NodeJS.ErrnoException).code === "ENOENT" ? "not-git" : "git-unavailable" };
  }
  if (!await trustedGit(protectedRoots)) return { status: "unavailable", reason: "git-unavailable" };
  try {
    const top = (await callGit(workspace, ["rev-parse", "--show-toplevel"])).toString("utf8").trimEnd();
    if (resolve(top) !== resolve(workspace)) return { status: "unavailable", reason: "git-unavailable" };
    const categories = new Map<string, Set<KnownCategory>>();
    const queries: Array<{ name: KnownCategory; argv: string[] }> = [
      { name: "tracked", argv: ["ls-files", "-z", "--full-name", "--cached", "--deduplicate", "--"] },
      { name: "untracked", argv: ["ls-files", "-z", "--full-name", "--others", "--exclude-standard", "--"] },
      { name: "ignored", argv: ["ls-files", "-z", "--full-name", "--others", "--ignored", "--exclude-standard", "--"] },
    ];
    for (const query of queries) {
      const paths = parsePaths(await callGit(workspace, query.argv));
      if (!paths) return { status: "unavailable", reason: "git-incomplete" };
      const seen = new Set<string>();
      for (const path of paths) {
        if (seen.has(path) || categories.has(path)) return { status: "unavailable", reason: "git-incomplete" };
        seen.add(path);
        const set = categories.get(path) ?? new Set<KnownCategory>();
        set.add(query.name);
        categories.set(path, set);
      }
    }
    return { status: "available", categories };
  } catch { return { status: "unavailable", reason: "git-failed" }; }
}

export function unavailableGit(reason: "git-incomplete"): GitSnapshot {
  return { status: "unavailable", reason };
}
