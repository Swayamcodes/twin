// Independent test policy: keep these vectors literal so production changes
// fail closed until this review list is deliberately updated.
export type TestScenarioId = "S12" | "S6";

export interface SpawnPolicyContext {
  readonly scenarioId: TestScenarioId;
  readonly workspace: string;
  readonly nodeExecutable: string;
  readonly actionPath: string;
  readonly approvedGit: string;
  readonly resolvedGit: string;
}

const setupGitArgs: readonly (readonly string[])[] = [
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

function exact(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && actual.every((value, index) => value === expected[index]);
}

export function assertAllowedSpawn(
  command: unknown,
  args: unknown,
  options: { readonly cwd?: unknown; readonly shell?: unknown } | null | undefined,
  context: SpawnPolicyContext,
): void {
  if (!Array.isArray(args) || !args.every((value: unknown) => typeof value === "string")
      || options?.shell !== false || options.cwd !== context.workspace) {
    throw new Error("Test spawn policy requires explicit string argv, verified cwd, and shell:false");
  }
  const argv: readonly string[] = args;
  if (command === "git") {
    if (context.resolvedGit !== context.approvedGit) {
      throw new Error("Test spawn policy rejected mismatched Git executable");
    }
    if (setupGitArgs.some((expected) => exact(argv, expected))
        || (context.scenarioId === "S6" && exact(argv, ["clean", "-fdx"]))) return;
  }
  if (context.scenarioId === "S12" && command === context.nodeExecutable
      && exact(argv, [context.actionPath])) return;
  throw new Error("Test spawn policy rejected unapproved executable or argv");
}
