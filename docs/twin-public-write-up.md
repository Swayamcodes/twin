# Twin: run a command in a project copy, then review the changes

Coding commands can delete ignored inputs, overwrite unsaved work, or write
outside a project. Git helps with committed files, but cannot restore bytes
it never recorded. In the documented S6 attempt, `git clean -fdx` removed
ignored and untracked inputs that the tested Git recovery recipe did not
restore.

Twin copies the project, including Git-ignored files, and runs the command
inside that copy. Projects without Git work too. Git supplies receipt labels;
it does not select the files copied. The aim is usable project copies and
receipts that expose observation limits. The [specification](../SPEC.md)
explains the problem and scope.

## Install, run, review

The MIT-licensed `@twin-cli/cli@0.1.0` and reusable `@twin-cli/core@0.1.0`
are published on npm. Use Node.js 24.2 or later:

```sh
npm install --global @twin-cli/cli@0.1.0
twin --help
# From a project containing script.js:
twin run --receipt=text --review -- node script.js
# Help without a global install:
npx --package=@twin-cli/cli@0.1.0 twin --help
```

Twin resolves bare executable names through the command's PATH; absolute
executable paths are also supported. It clones, runs, and prints a receipt
of observed file differences, dependency declarations and lockfiles, global
npm metadata, watched paths, and command/process lifecycle. Incomplete
coverage stays explicit. Default output is framed JSON; `--receipt=text`
selects text. `--receipt-html=/path/to/new-receipt.html` additionally exports
a standalone HTML document without overwriting an existing file.

With `--review`, type `apply` or `discard` at the prompt. Apply compares the
baseline, current original, and settled copy before writing. Discard removes
the copy. Without review, Twin discards after confirmed settlement. EOF,
interruption, or another review answer retains the copy for manual inspection;
a later CLI invocation cannot resume that session. See the
[CLI guide](cli-usage.md) and [release record](npm-release.md).

## What the comparisons establish

The retained [Phase 6 JSON](phase-6-results-2297bf07/comparison.json) and
[Markdown](phase-6-results-2297bf07/comparison.md) contain 39 fixed-action
attempts: S1–S13 through Twin, AgentTX **0.3.0**, and plain Git. Recorded
source identity is `2297bf07` with a dirty working tree; metadata includes
tool versions and execution digests. These observations belong to those
attempts, not every version or invocation of a tool.

- **Ignored inputs, S3/S13:** Twin's required copied inputs were present.
  AgentTX 0.3.0's fixed actions failed with inputs missing; their workspace
  usability was `unusable`.
- **Non-Git folder, S8:** Twin completed the deletion action in its copy.
  AgentTX 0.3.0 refused the project. Its action-start and blocking fields
  remain `unknown`; refusal alone does not prove prevention before execution.
- **Outside-project write, S9:** The fake-home file remained changed after
  Twin discard, AgentTX 0.3.0 rollback, and the plain-Git recovery step.
  None of these attempts reported the effect. Harness teardown is not recovery.
- **Different preconditions, S6:** All five AgentTX 0.3.0 fields remain
  `unknown`: equivalent deletion preconditions were not established.
  The older [hand test](phase-2-build-log.md#agenttx-030-s12s6s9-hand-test-checkpoint)
  reported zero changes and LOW risk, but its clone omitted ignored targets
  and committed the scratch file into its baseline. That report is not
  evidence of equivalent recovery.

The [Phase 2 result](phase-2-comparison.json) at the `c4a4dc1` core baseline
is historical evidence. The later [hosted Phase 6 observation](phase-6-acceptance.md)
at `22985f4` is separate again: its AgentTX S6 action exited zero with a
different effect, yet all five scores stayed unknown. Neither result replaces
the retained Phase 6 rows. Earlier Twin S10/S11 observations also must not be
carried into newer rows: the retained Phase 6 S11 recovery/reporting fields
are unknown. See the [checkpoint comparison](measured-comparison.md) for
the receipt and process changes.

Each row has five independent fields:

1. Recovered or preserved?
2. Reported?
3. Blocked before execution?
4. Workspace usable?
5. Boundary accurately described?

There is no aggregate ranking or winner. `unknown` means insufficient
evidence, not success or failure. Equal original endpoints do not establish
continuous preservation; action stdout is not automatically a tool report.
Read each row's reasons and evidence references alongside the
[scenario definitions](scenario-catalog.md). The [results page's source and
checkout instructions](../README.md#landing-and-results-pages) identify the
retained dataset it displays.

## Replay a real scripted run

The [demo](phase-7-demo/README.md) uses the published CLI, an unpaid fixed Node
command, and a disposable project: read an ignored input, edit a tracked file,
inspect the receipt, then apply. **It is scripted; no AI agent runs.**
The original remained `before\n` through review and became `after\n` after
apply; exit and settlement checks passed.

From this checkout, replay with Python 3 and no recording dependencies:

```sh
python3 docs/phase-7-demo/demo.py --replay docs/phase-7-demo/demo.cast
```

Add `--static` for reduced motion. The demo includes a
[plain transcript](phase-7-demo/transcript.txt), byte/cleanup verification,
and reproduction instructions. It demonstrates one conflict-free apply.

## Boundaries and compatibility

**This is project-copy isolation, not an OS sandbox.** Commands retain the
caller's permissions and can reach the original through absolute paths.
Receipts compare before/after state: reads and changes reverted during the
run are unobserved. Outside-project watches are bounded, global npm
observations require an explicit prefix, and external changes are not rolled
back. S9 external files and S10 global packages are outside project recovery.
An absent observed process group does not prove escaped descendants stopped.

Apply refuses conflicting or unsupported plans, including symlinks and
incomplete inventories. Multi-path apply is not atomic: an I/O failure may
leave earlier paths changed. Same-user check/write races remain possible.
See the [apply boundary](../ARCHITECTURE.md#phase-5-apply-boundary).

The [compatibility matrix](compatibility-matrix.md) records Codex CLI
**0.159.3** headless runs with ignored input, Git apply, non-Git discard, and
interruption. Claude Code **2.1.286** launch, receipt, settlement, and discard
were verified for failed commands; insufficient API credit left model-backed
editing, apply after an edit, and interruption during model work unverified.
The optional funded rerun is on indefinite budget hold. Full terminal UIs
remain untested. Website visual polish is deferred to a separate checkpoint.
