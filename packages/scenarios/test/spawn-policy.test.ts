import { createRequire } from "node:module";
import { dirname } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { SpawnPolicyContext } from "./support/spawn-policy.cjs";
import type { TrustFacts } from "./support/git-trust.cjs";

const require = createRequire(import.meta.url);
const policy = require("../dist/test-harness/packages/scenarios/test/support/spawn-policy.cjs") as
  typeof import("./support/spawn-policy.cjs");
const { assertAllowedSpawn } = policy;
const trust = require("../dist/test-harness/packages/scenarios/test/support/git-trust.cjs") as
  typeof import("./support/git-trust.cjs");

function safeFacts(): TrustFacts {
  const canonicalGit = "/usr/bin/git";
  return { platform: "linux", hasGetuid: true, candidate: trust.systemGitCandidate,
    canonicalGit, entries: [
      { path: canonicalGit, kind: "file", uid: 0, mode: 0o100755, executable: true },
      ...trust.ancestorPaths(canonicalGit).map((path) =>
        ({ path, kind: "directory" as const, uid: 0, mode: 0o40755 })),
    ] };
}

const base: SpawnPolicyContext = {
  scenarioId: "S6", workspace: "/tmp/twin-scenario-example/workspace",
  nodeExecutable: "/checked/node", actionPath: "/checked/actions/create-file.js",
  approvedGit: "/checked/git", resolvedGit: "/checked/git",
};
const options = { cwd: base.workspace, shell: false };

describe("pure pre-spawn command policy; never calls child_process.spawn", () => {
  it("accepts only the current exact S6 action vector", () => {
    expect(() => assertAllowedSpawn("git", ["clean", "-fdx"], options, base)).not.toThrow();
  });

  it("accepts current setup vectors with complete argv", () => {
    const vectors = [
      ["init", "--initial-branch=main", "--template="],
      ["add", "--", "notes.txt", "app.js", ".gitignore"],
      ["-c", "user.name=Twin Scenario", "-c", "user.email=twin-scenario@example.invalid",
        "-c", "commit.gpgSign=false", "-c", "core.hooksPath=/dev/null",
        "commit", "-m", "Establish disposable scenario baseline"],
      ["rev-parse", "--show-toplevel"],
      ["ls-files", "-z"],
      ["ls-files", "--others", "--exclude-standard", "-z"],
      ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"],
    ];
    for (const argv of vectors) expect(() => assertAllowedSpawn("git", argv, options, base)).not.toThrow();
  });

  it("rejects an unknown executable", () => {
    expect(() => assertAllowedSpawn("unknown-tool", ["clean", "-fdx"], options, base)).toThrow();
  });

  it("rejects an absolute executable not on the allowlist", () => {
    expect(() => assertAllowedSpawn("/usr/bin/git", ["clean", "-fdx"], options, base)).toThrow();
  });

  it("rejects an additional argument", () => {
    expect(() => assertAllowedSpawn("git", ["init", "--initial-branch=main", "--template=", "extra"], options, base)).toThrow();
  });

  it("rejects git -C even with the expected clean suffix", () => {
    expect(() => assertAllowedSpawn("git", ["-C", "/home/user/dev/twin", "clean", "-fdx"], options, base)).toThrow();
  });

  it.each([
    ["extra flag", ["clean", "-fdx", "-n"]],
    ["pathspec", ["clean", "-fdx", "--", "notes.txt"]],
  ])("rejects git clean with %s", (_name, argv) => {
    expect(() => assertAllowedSpawn("git", argv, options, base)).toThrow();
  });

  it("prevents S12 from invoking S6 action", () => {
    expect(() => assertAllowedSpawn("git", ["clean", "-fdx"], options,
      { ...base, scenarioId: "S12" })).toThrow();
  });

  it("prevents S6 from invoking S12 action", () => {
    expect(() => assertAllowedSpawn(base.nodeExecutable, [base.actionPath], options, base)).toThrow();
  });

  it("allows only the exact S12 action in S12", () => {
    expect(() => assertAllowedSpawn(base.nodeExecutable, [base.actionPath], options,
      { ...base, scenarioId: "S12" })).not.toThrow();
    expect(() => assertAllowedSpawn(base.nodeExecutable, [base.actionPath, "extra"], options,
      { ...base, scenarioId: "S12" })).toThrow();
  });

  it("rejects missing cwd", () => {
    expect(() => assertAllowedSpawn("git", ["clean", "-fdx"], { shell: false }, base)).toThrow();
  });

  it.each([
    ["true", { cwd: base.workspace, shell: true }],
    ["omitted", { cwd: base.workspace }],
  ])("rejects shell %s", (_name, spawnOptions) => {
    expect(() => assertAllowedSpawn("git", ["clean", "-fdx"], spawnOptions, base)).toThrow();
  });

  it("rejects a mismatched resolved Git executable", () => {
    expect(() => assertAllowedSpawn("git", ["clean", "-fdx"], options,
      { ...base, resolvedGit: "/checked/other-git" })).toThrow();
  });
});

describe("strict system Git test prerequisite; never launches Git", () => {
  it("requires the fixed canonical /usr/bin/git candidate", () => {
    expect(trust.validateTrustedGitFacts(safeFacts())).toBe("/usr/bin/git");
    expect(() => trust.validateTrustedGitFacts({ ...safeFacts(), candidate: "/usr/local/bin/git" })).toThrow();
  });

  it("refuses unsupported platforms and missing process.getuid without fallback", () => {
    expect(() => trust.validateTrustedGitFacts({ ...safeFacts(), platform: "win32" })).toThrow();
    expect(() => trust.validateTrustedGitFacts({ ...safeFacts(), hasGetuid: false })).toThrow();
  });

  it("refuses unsafe file and ancestor ownership or permissions", () => {
    const facts = safeFacts();
    for (const path of [facts.canonicalGit, dirname(facts.canonicalGit), "/"]) {
      for (const change of [{ uid: 1000 }, { mode: 0o100777 }]) {
        const entries = facts.entries.map((entry) => entry.path === path ? { ...entry, ...change } : entry);
        expect(() => trust.validateTrustedGitFacts({ ...facts, entries })).toThrow(path);
      }
    }
  });

  it("refuses missing, nonregular, and nonexecutable system Git facts", () => {
    const facts = safeFacts();
    expect(() => trust.validateTrustedGitFacts({ ...facts, entries: facts.entries.slice(1) })).toThrow();
    expect(() => trust.validateTrustedGitFacts({ ...facts,
      entries: facts.entries.map((entry) => entry.path === facts.canonicalGit
        ? { ...entry, kind: "directory" as const } : entry) })).toThrow();
    expect(() => trust.validateTrustedGitFacts({ ...facts,
      entries: facts.entries.map((entry) => entry.path === facts.canonicalGit
        ? { ...entry, executable: false } : entry) })).toThrow();
  });

  it("rejects a supplied Git path or PATH that differs from the independently trusted path", () => {
    const git = trust.validateTrustedGitFacts(safeFacts());
    expect(() => trust.validateTrustedGitEnvironment(git, "/other/git", dirname(git), git)).toThrow();
    expect(() => trust.validateTrustedGitEnvironment(git, git, "/other", git)).toThrow();
    expect(() => trust.validateTrustedGitEnvironment(git, git, dirname(git), "/other/git")).toThrow();
  });

  it("ignores inherited PATH during initial system Git selection", () => {
    const outcome = (): string => {
      try { return JSON.stringify(trust.resolveTrustedSystemGit()); }
      catch (error: unknown) { return `refused:${String(error)}`; }
    };
    const expected = outcome();
    vi.stubEnv("PATH", "/repository/tools:/home/user/bin");
    try {
      expect(outcome()).toBe(expected);
      if (expected.startsWith("refused:")) {
        expect(expected).toMatch(/Unsafe system Git|Untrusted system Git|Automated scenario tests/);
      }
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
