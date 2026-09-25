# Phase 2 build log

This log separates observations made during manual verification from planned or
automated checks. The scenario runner currently emits raw command and filesystem
evidence; it does not calculate a safety score or perform recovery.

## Research that shaped the scenarios

The Step 1.3 AgentTX v0.3.0 investigation recorded in [SPEC.md](../SPEC.md)
found that clone isolation preserved the original repository during an S6-style
`git clean -fdx`, but its clone omitted ignored files. Its report could say
"0 files changed, LOW risk" even though those ignored files were unavailable
inside the clone. An outside-project dotfile write was neither detected nor
rolled back, and a directory without a Git repository could not be run. These
findings narrowed Twin's intended differentiator to ignored/non-Git coverage
and an accurate account of what was observed and what was outside the boundary.

## Manual scenario verification and checkpoint

- S12, the harmless new-file control, passed manual verification. The
  checkpoint commit `b6f2232` was created **after S12 passed and before S6
  was executed**.
- An accidental `git clean -fdx` was run at the real repository root. It
  deleted untracked implementation files and ignored dependency/build
  directories. Those files were reconstructed from the active Codex session's
  implementation history. **Twin did not recover them.** The incident shows
  that uncommitted, untracked work is outside Git recovery. It is not evidence
  that Twin can restore a real repository after this command.
- S12 was successfully repeated after reconstruction.
- S6 was manually run successfully after `b6f2232` in
  `/tmp/twin-scenario-3qlMpf/workspace`, not in the real repository. It removed
  the fixture `.env`, `node_modules/`, and `scratch.txt`. The independent
  verifier confirmed that tracked fixture files stayed byte-identical, the
  ignored and untracked files became absent, cleanup removed the generated
  scenario root, `issues` was empty, and the real repository stayed clean.

No unretained file hashes, timestamps, or command transcript are inferred here.
The accidental repository-level `git clean` happened before the automated
protections described below existed.

## Step 2.3 implementation and verification

The regression suite uses Vitest 5.0.1 and strict test TypeScript compilation.
The package script compiles first, runs safety prerequisites in one Vitest
process, then starts the runner tests in a separate process only if the
prerequisites pass. A preload permits exact executable and full-argv vectors
for setup and the scenario-specific S12 or S6 action on the current
`child_process.spawn` route. Automated scenario tests require the canonical
`/usr/bin/git` on Linux or macOS: the Git file and every ancestor directory
through filesystem root must be owned by uid 0 and must not be group- or
world-writable. Unsupported layouts are refused. These checks are defense in
depth, not an OS sandbox.

Invalid-input tests exposed an environment in which `process.stdout` and
`process.stderr` acknowledged writes while emitting zero bytes; direct writes
to standard file descriptors worked. The CLI now writes explicit UTF-8 bytes
to fd 1 or fd 2, retries partial writes, and rejects zero progress or invalid
write counts. The tests retained their original usage-text assertion.

An initial independent safety audit found an overly permissive preload policy,
no guaranteed prerequisite ordering, Git selected from inherited `PATH`,
cleanup and leak-accounting gaps, and special filesystem types collapsed into
one category. Corrections added exact full-argv allowlists, scenario-specific
action permissions, trusted system-Git validation, a separate prerequisite
process, preserved cleanup-error aggregation, exact root leak accounting, and
distinct filesystem object types. The final independent audit verdict was
**SAFE TO RUN AUTOMATED S12/S6**.

In normal WSL, `pnpm run test:scenarios` completed successfully: the
prerequisite process passed 5 files and 35 tests; the runner process passed
1 file and 3 tests, for 6 files and 38 tests total. The automated runner
verified that extra arguments were rejected before allocation, S12 created
only its control file in a disposable workspace, and S6 removed only
disposable untracked and ignored files. Independent observations confirmed
tracked files remained unchanged. The real repository fingerprint remained
unchanged, generated scenario and test roots were removed, and
`pnpm-lock.yaml` remained unchanged. A post-run search found no
`twin-scenario-*` or `twin-test-*` roots under `/tmp`.

## Current boundaries and deferred work

The scenario root is a runner-generated direct child of the canonical OS
temporary directory, with a separate `workspace` child and an ownership marker
outside that workspace. Path, marker, and filesystem identity checks guard
against accidental misuse at validation time. They do not pin objects against
concurrent same-user replacement and are not an OS sandbox. The in-process
registry and test preload guard are also integrity/defense-in-depth measures,
not security boundaries. Native Windows remains out of scope; Linux, macOS,
and WSL2 are the target hosts.

The current runner covers only S12 and S6 and records raw before/after
observations, command evidence, issues, and cleanup outcomes. Recursive cleanup
is non-atomic: a failure after deletion begins can leave partial contents.
Process crashes can retain roots before they can be reported. The current
preload covers `child_process.spawn` only, and concurrent same-user replacement
is outside the test model. The trusted automated Git layout requires canonical
`/usr/bin/git` on Linux or macOS and safely refuses unsupported layouts.
Automatic recovery-tool scoring, recovery, adapters, watch lists, process monitoring, a general
manifest, and the clone/cage core are deferred. The tests do not claim to prove
race-proof containment or arbitrary future process-launch behavior, and they
do not make Twin an OS sandbox.

## Step 2.4: versioned oracle and scoring contract

Step 2.4 added a pure S12/S6 oracle and a separate dimension-specific
`ToolScore` schema. The oracle validates the existing raw `ScenarioRunResult`
shape at runtime, compares fixture observations against independently pinned
version-1 bytes, checks the intended command and operational errors, and
derives validity and score eligibility. Cleanup disposition remains separate.
Its `sourceRunId` hashes canonical raw evidence, including run-specific paths
and timestamps. The direct runner is still not Twin and still does not score
recovery tools. A successful S6 deletion is a valid accident, not a safety
pass.

The audit corrections make missing setup records unknown/indeterminate, while
recorded wrong or failed setup commands remain invalid. The strict version-1
evaluation context is scenario-discriminated and must match the raw run. S12
supplies nonblank expected executable and script-path strings, preserving
their exact values. S6 supplies no S12 identity. Context comes from the
interpreter of the captured run, not the evaluator's own process or
installation; it is not independent attestation of the binary executed. It is
excluded from `sourceRunId`, which identifies canonical raw evidence only.
Canonical string ordering uses JavaScript code units, not locale collation.
If cleanup names a different root, cleanup disposition is unknown without
changing semantic checks or validity. The oracle still sees only seven named
fixture paths. Semantic validity requires a syntactically absolute POSIX
scenario root and its exact workspace child under the supported POSIX, WSL,
and macOS model; this does not attest to filesystem existence, safety, or
provenance. Setup references identify exact command vectors regardless of
array position. Ambiguous duplicates do not resolve, and a `scenario-run`
reference names the complete enclosing raw result when no narrower reference
is truthful.
For these corrections, production no-emit typechecking, production compilation,
and test TypeScript compilation passed. The permitted prerequisite Vitest run
passed **7 files and 84 tests**. The runner tests and scenario actions were not
run for this correction pass.
Final correction verification passed production no-emit typechecking,
production compilation, and test TypeScript compilation. The same seven
permitted prerequisite files passed **101 tests**. No scenario runner test,
S12 action, S6 action, or complete package test script ran for these final
corrections.

The score contract records factual outcomes with reasons, typed references,
and evaluation methods. Structural validation enforces the version, outcome
vocabulary, required evidence, applicable rubric rules for `not-applicable`,
and manual-review references. It does not prove that future tool evidence
exists or supports a claim. A test-private synthetic registry exercises those
future cross-evidence rules without publishing an adapter format. Private raw
tool artifacts, normalized adapter evidence, adapters, automatic scoring,
redaction, renderers, and core integration remain deferred.

Verification in this implementation turn compiled the scenarios production
and test TypeScript projects. Static inspection found no runner, fixture,
child-process, or test-harness execution imports in the new tests. Only the
seven permitted prerequisite Vitest files ran: **7 files and 71 tests passed**.
`runner.test.ts`, S12, S6, and the complete `test:scenarios` script were not
run. The previously recorded 38-test result remains the Step 2.3 checkpoint,
not a claim about this turn's complete suite.

## Final Step 2.4 verification run

The production no-emit TypeScript check passed. `pnpm run test:scenarios`
completed successfully: the prerequisite process passed **7 files and 101
tests**, and the separately gated runner process passed **1 file and 3 tests**,
for **8 files and 104 tests total**. The runner cases verified extra-argument
rejection before allocation, S12, and S6.

`git diff --cached --check` passed, and `pnpm-lock.yaml` remained unchanged.
The post-run `/tmp` search printed no `twin-scenario-*` or `twin-test-*` roots.
Git status contained only the staged 11-file Step 2.4 slice. This verification
does not extend the oracle beyond its seven observed paths or establish
executable attestation, adapters, or automated tool scoring.
