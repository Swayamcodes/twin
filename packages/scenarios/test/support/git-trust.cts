// Strict prerequisite for automated scenario tests, not production Git discovery.
import { accessSync, constants, lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, parse } from "node:path";

export const systemGitCandidate = "/usr/bin/git";

export interface TrustEntry {
  readonly path: string;
  readonly kind: "file" | "directory";
  readonly uid: number;
  readonly mode: number;
  readonly executable?: boolean;
}

export interface TrustFacts {
  readonly platform: string;
  readonly hasGetuid: boolean;
  readonly candidate: string;
  readonly canonicalGit: string;
  readonly entries: readonly TrustEntry[];
}

export function ancestorPaths(path: string): readonly string[] {
  const paths: string[] = [];
  for (let current = dirname(path); ; current = dirname(current)) {
    paths.push(current);
    if (current === parse(current).root) return paths;
  }
}

export function validateTrustedGitFacts(facts: TrustFacts): string {
  if ((facts.platform !== "linux" && facts.platform !== "darwin") || !facts.hasGetuid) {
    throw new Error("Automated scenario tests require Linux or macOS with process.getuid");
  }
  if (facts.candidate !== systemGitCandidate || !isAbsolute(facts.canonicalGit)) {
    throw new Error("Automated scenario tests require canonical /usr/bin/git");
  }
  const required = new Map<string, "file" | "directory">([[facts.canonicalGit, "file"]]);
  for (const path of [...ancestorPaths(facts.candidate), ...ancestorPaths(facts.canonicalGit)]) {
    required.set(path, "directory");
  }
  for (const [path, kind] of required) {
    const matching = facts.entries.filter((entry) => entry.path === path);
    if (matching.length !== 1 || matching[0]?.kind !== kind) {
      throw new Error(`Untrusted system Git object at ${path}`);
    }
    const entry = matching[0];
    if (entry.uid !== 0 || (entry.mode & 0o022) !== 0 || (kind === "file" && entry.executable !== true)) {
      throw new Error(`Unsafe system Git ownership or permissions at ${path}`);
    }
  }
  return facts.canonicalGit;
}

export function validateTrustedGitEnvironment(
  canonicalGit: string, suppliedGit: string | undefined, pathValue: string | undefined,
  resolvedFromPath: string | undefined,
): void {
  if (suppliedGit !== canonicalGit || pathValue !== dirname(canonicalGit)
      || resolvedFromPath !== canonicalGit) {
    throw new Error("Test Git environment differs from independently trusted /usr/bin/git");
  }
}

export function resolveTrustedSystemGit(): { git: string; directory: string } {
  if ((process.platform !== "linux" && process.platform !== "darwin")
      || typeof process.getuid !== "function") {
    throw new Error("Automated scenario tests require Linux or macOS with process.getuid");
  }
  const git = realpathSync(systemGitCandidate);
  if (realpathSync(git) !== git) throw new Error(`Noncanonical system Git: ${git}`);
  const paths = new Set([git, ...ancestorPaths(systemGitCandidate), ...ancestorPaths(git)]);
  const entries: TrustEntry[] = [...paths].map((path) => {
    const stat = lstatSync(path);
    const kind = path === git ? "file" : "directory";
    if (kind === "file" ? !stat.isFile() : !stat.isDirectory()) {
      throw new Error(`Untrusted system Git object at ${path}`);
    }
    if (kind === "file") accessSync(path, constants.X_OK);
    return { path, kind, uid: stat.uid, mode: stat.mode, executable: kind === "file" };
  });
  validateTrustedGitFacts({ platform: process.platform, hasGetuid: true,
    candidate: systemGitCandidate, canonicalGit: git, entries });
  const directory = dirname(git);
  const resolvedFromPath = realpathSync(join(directory, "git"));
  validateTrustedGitEnvironment(git, git, directory, resolvedFromPath);
  return { git, directory };
}
