# Phase 5 v1 acceptance review

**Decision: accepted for the approved v1 scope at `2937b78`, with the CLI
polish in this working tree.** This is a source and test acceptance decision,
not a commit or a new funded agent run. The [compatibility matrix](compatibility-matrix.md)
continues to mark Claude model-backed work unverified.

| Requirement | Decision and evidence |
| --- | --- |
| Three-state apply | Accepted. `TwinSession.apply()` compares creation-time original, current original, and settled copy inventories. The [core apply tests](../packages/core/test/apply.test.ts) cover copy-only changes, unrelated original edits, already-identical changes, Git-ignored and non-Git files, additions, deletions, modes, and file/directory transitions. |
| Conflict and incomplete-state refusal | Accepted. The apply tests cover same-path and deletion conflicts without any planned write, changed roots and settled copies, symlinks, incomplete observations, and unsettled commands. Preflight plans the full change set before mutation; per-path and root checks run again during mutation. |
| Failure limits | Accepted with explicit limits. The apply tests cover a write failure that retains the copy and may leave earlier paths changed. Multi-path apply is not atomic and does not roll back. A same-user concurrent writer can still win a check/write race; neither the tests nor this decision claim otherwise. |
| Same-invocation CLI review | Accepted. `twin run --review -- ...` emits the existing JSON or bounded text receipt before taking one stdin choice. Live [review tests](../packages/cli/test/review.test.ts) cover apply, discard, conflict, EOF, another answer, and interruption at the prompt. EOF, interruption, failed apply, and uncertain settlement retain the copy. The [CLI usage guide](cli-usage.md) explains that a later invocation cannot apply or discard the retained session. Default `run` still discards after confirmed settlement. |
| CLI output and lifecycle | Accepted. [CLI tests](../packages/cli/test/run.test.ts) cover exact argument tokens after `--`, help and argument errors, captured and inherited stdio, JSON frame and text receipt, bounded control-safe error/conflict details, and failed discard retention. The [signal tests](../packages/cli/test/signals.test.ts) cover bounded SIGINT/SIGTERM handling and settled child cleanup. Raw command output remains the command's own output. |
| v1 agent compatibility | Accepted to the approved evidence boundary. The published [matrix](compatibility-matrix.md) links each Codex and Claude finding to its committed checkpoint. Codex `codex exec` editing, ignored-input use, review/apply, discard, and tested interruption are verified for its recorded version and platform. Claude launch, receipt, settlement, and discard are verified; model-backed edit is unverified because API credit was insufficient. The funded rerun is on optional indefinite budget hold. OpenCode, Aider, Gemini CLI, and Cursor CLI are deferred. |

## Verification and review

The full core suite passed (9 files, 172 tests) and the full CLI suite passed
(6 files, 57 tests). Strict core production and test TypeScript checks, strict
CLI production and test TypeScript checks, and core and CLI builds passed.
The initial sandboxed full suites hit `EPERM` on Git subprocesses and Unix
sockets, so both suites were rerun outside that restriction. No core API or
original-writing implementation changed in this polish checkpoint; scenario
consumers and frozen score contracts were not changed.

The Tier A review followed the original-writing path from the CLI's explicit
`apply` choice into the existing core preflight and per-mutation checks. The
CLI checks interruption again before calling apply, keeps the copy on conflict,
refusal, or failure, and warns when earlier paths may already have changed.
Its default cleanup calls `discard()` only after the run receipt and, in review
mode, a settled choice. Refused discard retains the scratch root; failed or
thrown discard leaves cleanup uncertain. Both report the path even without
`--review`. Review EOF and interruption do
not trigger apply. CLI diagnostics escape terminal controls and cap untrusted
values; the JSON receipt protocol and captured command bytes remain unchanged.

All live CLI tests used owned disposable fixtures. Tests awaited CLI closure
before fixture removal; signal tests also checked their action process exit.
Three retained review fixtures from a failed test-path assertion, one retained
review interruption fixture from the sandbox-blocked pipe check, two interactive
fixtures from the sandbox-blocked run, and four empty mock scratch directories
were inspected and removed after process settlement. The passing
suites reported no retained fixture roots. No paid agent task ran for this
acceptance review.

## Remaining limits

Twin does not provide a persistent reviewed session, live file-access tracing,
an OS sandbox, or a PTY for full terminal UIs. Process-group settlement does
not prove the absence of escaped descendants. Outside-project changes are
reported within the watch boundary, not rolled back. These limits and the
unverified Claude model-backed cells remain visible in the architecture and
compatibility records; they are not additional Phase 5 acceptance gates.
