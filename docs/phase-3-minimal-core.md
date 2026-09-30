# Early Phase 3.0 — minimal Twin core

`@twin-cli/core` now provides a dependency-free copy/run/inspect/discard session.
This is an early slice, not completion of Phase 3 or evidence of scenario scores.
Existing scenario, contract, capture, CLI and adapter infrastructure is frozen.

## API and lifecycle

```ts
interface CreateTwinOptions {
  readonly sourceDirectory: string;
  readonly scratchParent: string;
}
interface TwinSession {
  readonly workspacePath: string;
  run(options: RunOptions): Promise<RunResult>;
  inspect(): TwinInspection;
  discard(): Promise<DiscardResult>;
}
function createTwin(options: CreateTwinOptions): Promise<TwinSession>;
```

Both directories must exist. The scratch parent must be current-UID-owned, mode
0700, outside the canonical source. Linux and macOS with POSIX UID support are
accepted; native Windows is unsupported. Final directory components cannot be
symlinks. The factory allocates an exclusive private root and fully copies before
returning. Creation failure rejects, attempts guarded cleanup, and includes the
allocation path and cleanup disposition in its local error; no runnable session
is returned. An allocation whose authority could not be established is retained.

The frozen session exposes only its workspace path and three methods. `inspect()`
returns state and path, without scanning files. States are ready, running, finished,
child-unsettled, discarding, discarded and discard-failed. Inspect files directly
while ready or finished. `run()` permits one execution attempt, including a failed
spawn. Invalid input or failed prelaunch authority checks do not consume it.
The ready-to-running lock is acquired before any caller-controlled property,
getter, iterator or value is accessed. Reentrant run/discard calls reject during
input access. Snapshot/validation failures restore ready and preserve the attempt.
Sparse argv arrays are invalid input and are rejected before spawn without consuming
the attempt. Concurrent run/discard operations reject. Explicit discard is allowed before run
or after verified run settlement. There are no finalizers or exit-time cleanup.

## Copy boundary

Filesystem traversal copies all regular files, including dotfiles, ignored and
untracked contents and dependency storage. It does not invoke Git or filter using
ignore rules. Regular files receive independent buffered byte copies, never hard
links, reflinks or CoW. Ordinary permission bits (0777), including executable bits,
are preserved; special permission bits are cleared. Directories become 0700.
Ownership, timestamps, ACLs, extended attributes and sparse allocation are not
preserved. Source reads can update access times. A quiescent source is required;
this is not an atomic snapshot or an exhaustive source-mutation proof.

Only relative symlinks whose lexical target remains in the canonical source tree
are accepted, including pnpm-style links and in-tree dangling targets. Exact link
text is preserved. Targets are never dereferenced during copy or discard. Absolute
and escaping relative links fail creation. Containment uses path components.
These lexical checks do not prove containment of arbitrary runtime path resolution.
External-link copying, broader policy and reporting remain deferred.

Devices, sockets, FIFOs and other special entries are rejected explicitly.

## Git boundary

Root `.git` must be absent or an ordinary directory. Root `.git` files/symlinks,
nested `.git` entries, `.gitmodules`, and symlinks within `.git` are refused.
Within root `.git`, the following sentinels are refused: `commondir`, `gitdir`,
`worktrees`, `modules`, `objects/info/alternates`, `objects/info/http-alternates`,
and `config.worktree`.

Before copying source-root entries, a directory inventory containing `HEAD`,
`objects` and `refs` (case-folded) is conservatively refused as a bare Git layout;
`config` need not be present. The same inventory is refused in nested directories,
except the supported root `.git` directory. Outside `.git`, paths ending in
`objects/info/alternates` or `objects/info/http-alternates` are refused independently
of that inventory. Ordinary directories with those signatures can therefore be
refused too; this is not a general Git-layout parser and never invokes Git.

Noncanonical case variants of `.git`, `.gitmodules`, and reserved root-Git paths
(`HEAD`, `config`, `refs`, the sentinel paths and their directory prefixes) are
refused even on case-sensitive filesystems. This is conservative alias protection,
not complete filesystem alias detection. Canonical supported layouts still work.

The config check has a narrow accepted grammar, not general Git compatibility:
ASCII section/key names, optional simple quoted subsection names, and unquoted
single-line `key = value` assignments. Blank lines and whole-line comments work.
Relevant names are case-insensitive. Includes/includeIf, extensions.worktreeConfig,
core.bare other than explicit false, and external core.worktree are refused.
Absolute core.worktree values are also refused because they cannot relocate safely.
Relative core.worktree is interpreted from `.git` and must remain inside the source.
Continuations, escapes, quoted values, inline comments, malformed/ambiguous syntax,
invalid UTF-8 and config files over 64 KiB are refused. Metadata is never rewritten.
Hooks, filters, aliases and repository programs are not certified safe.

## Execution, output and timeout

RunOptions requires an absolute executable, exact string argv, and an explicit
complete string environment map; timeoutMs and interruptSignal are optional. Each
top-level option is
read once. Argv is materialized into an independent array and environment entries
are captured before value validation; only that validated snapshot reaches spawn.
Getter/iterator exceptions reject as snapshot failures, preserving their cause.
Snapshotting is sequential, not atomic against code running inside accessors; the
values captured are validated, and caller-owned objects are neither frozen nor
mutated. Later changes to caller input do not change the admitted command.
No environment is inherited
implicitly and no selected-executable PATH search occurs. Spawn uses shell:false,
workspace cwd and detached:true on supported macOS/Linux platforms, placing
the direct child in a new process group. The default captured mode ignores stdin and
pipes stdout/stderr into the bounded result. `stdio: "inherit"` explicitly passes
the caller's stdin, stdout and stderr descriptors to the direct child. This lets
an interactive command read input and emit output immediately; `RunResult` then
contains empty, incomplete stdout/stderr captures. The CLI selects this mode with
`twin run --interactive -- <absolute-executable> [args...]`; ordinary `twin run --`
keeps captured mode and prints its bounded output after completion. The receipt
is still generated after the command and framed on CLI stderr. Inherited stdio
does not allocate a PTY or establish terminal compatibility; terminal-only agents
may still require a separate PTY implementation and verification. Callers remain
responsible for executable trust, environment and command policy.

RunResult schemaVersion 1 reports exited/spawn-failed/timed-out, actual launch,
exit code, signal, spawn error, termination error, direct-child settlement and an
optional lifecycle issue when group or pipe settlement is unconfirmed.
Each output retains at most 65,536 raw bytes while excess bytes continue draining.
Truncation, stream errors or missing stream end make capture incomplete. An empty
stream from a command that never started is not complete output. Results are local
and may contain secrets; they are not receipts or sanitized publication artifacts.

The default timeout is 60 seconds, configurable from 1 ms through one hour.
Timeout and caller interruption signal the new process group with SIGTERM or
SIGINT, then SIGKILL after one second if members remain. A direct child that exits
while its group remains active starts the same SIGTERM/SIGKILL shutdown. After
SIGKILL, settlement is bounded by five seconds. Captured pipes drain for at most
one second after the group is absent. Run completion is verified only when direct
child exit, group absence, and captured pipe closure are observed. Otherwise the
result names a lifecycle issue, the receipt uses unavailable post-run evidence,
and discard is refused. A later observed exit or pipe/group closure may permit
discard; signal delivery alone does not. The 65,536-byte capture bound remains.

The CLI listens for SIGINT and SIGTERM from before copy creation through receipt
and cleanup. A signal before command launch prevents the run; the CLI waits for
copy creation to finish, then discards through the ordinary session rules. During
execution, the first signal is sent to the command's process group. Repeated caller
signals
are ignored while settlement proceeds. If group members remain after one
second, the existing termination path sends SIGKILL and waits up to five more
seconds for observed exit. A previously started timeout keeps its own termination
sequence. Signal listeners are removed after CLI cleanup. The CLI returns nonzero
for an interrupted run even if the child handles the signal and exits zero.
Receipt creation and discard use the same lifecycle checks as an ordinary run.
Group signaling reaches ordinary descendants that stay in the group, including
writers holding captured pipes open. A descendant can escape with `setsid` or
similar calls; group absence cannot prove such a process stopped. An escaped
process retaining a captured pipe makes capture incomplete and cleanup refuse,
but one that closes its pipes may remain unseen. Process-group ID reuse and
concurrent process mutation remain limits of a process-group check. This is not
OS containment; broader descendant discovery and integration acceptance remain
outstanding, so Phase 3 is not complete.

Result finalization clears bounded timers and removes handlers after verified
settlement. Unsettled runs retain the necessary late exit/close handlers and an
unrefed group probe until settlement becomes observable. Open captured streams
continue bounded draining with their parent read handles unrefed; destroying those
read handles would make a later close event unreliable as proof of writer exit.
Stream data/end handlers are
removed at disposal; an error handler remains through pipe close to handle queued
destruction errors, then all capture handlers are removed.

## Cleanup authority

A private in-memory registration holds root/workspace/parent identities and an
unpredictable exclusively created marker outside workspace. Cleanup accepts no
caller path and adopts no abandoned roots. It verifies canonical containment,
identities, UID, private root/parent modes and marker type, identity, mode and bytes.
Unexpected root siblings or replaced/missing authority cause refusal.

An lstat preflight accepts owned regular files, directories and symlinks on the
root device. Deletion rechecks identities, unlinks files/links without following
targets, removes directories bottom-up and removes the marker last. A symlink
created by the command may point outside; discard removes only that link. There
is no recursive forced fallback. Failure after deletion begins reports possible
partial deletion and prevents blind retry. Repeated confirmed discard returns
already-removed. Concurrent same-user replacement/mount manipulation is unsupported;
these are checks at particular times, not an OS sandbox.

## Focused verification history

On 2026-09-27, production no-emit checking, production compilation and core test
TypeScript compilation passed. The final focused run passed 56 tests in four files
(4.50 seconds). Exact accounting: 56 fixture roots, 23 returned session roots;
every fixture's before/after root sets were `[]`, remaining Twin allocations were
`[]`, and the fixture registry was `[]` after teardown. Refused creations also
left empty scratch parents. No scenario, adapter or workspace-wide suite ran.

The initial sandboxed test run had socket EPERM and empty child-output captures;
its test spy also needed Node's configurable export. After correcting the spy,
the approved unsandboxed run passed all 53 then-existing tests. The final run
included the marker pre-open type guard, a root-Git socket case, and simulated
unsettled-child/open-pipe cases (no OS descendants). Successful-test accounting
was made visible. pnpm's initial automatic dependency verification needed an
approved network retry; the production scripts explicitly select Node types for
TypeScript 6 without changing the shared configuration.

Only the four core test files were executed. Tests use registered private fixtures, fixed Node behaviors
and process.execPath; repository and default/configured Twin state locations are
excluded from allocation. Each fixture reports exact before/after root sets, known
session roots and remaining allocations. Unexpected retained Twin roots are never
swept by test teardown. Git fixtures contain representative metadata; Git itself
is not invoked. These checks do not implement or claim S8/S13 coverage.

Audit-correction verification on 2026-09-27: production no-emit checking,
production build and test TypeScript compilation passed. The sandboxed run
passed 75/80 tests; two fixture sockets failed with EPERM and three output
assertions received empty child captures. The approved unsandboxed rerun passed
all 80 tests in four files (6.33 seconds). Accounting showed 80 fixture roots and
28 returned session roots; every before/after root set, remaining-allocation list
and final fixture registry was empty. The added cases isolate bare inventories,
alternates, reserved-name case variants, sparse argv and listener/timer disposal
(including late exit). Empty-directory copying and root-identity refusal now have
direct assertions. Test imports and fixed command bodies were inspected before
Vitest; no scenario runner, adapter, CLI or shell harness was imported or run.

Command-input correction verification on 2026-09-27: production no-emit checking,
production build and test TypeScript compilation passed. The approved unsandboxed
focused run passed 99 tests in four files (7.75 seconds), including 19 new cases
for single-read snapshots, changing/throwing accessors and iterators, input
mutation, and reentrant run/discard attempts. Accounting showed 99 fixture roots
and 47 returned session roots; all before/after root sets, remaining-allocation
lists and final fixture registries were empty. Affected tests and shared command
helpers were inspected before Vitest; only the focused core suite ran. Earlier
verification counts above remain historical records.

## Deferrals

No diff, receipt, apply/merge, reflink/CoW, outside-project monitoring/recovery,
dependency analysis, cancellation API, complete descendant discovery and acceptance,
AgentTX integration, CLI integration, scoring, normalized evidence, attempt
protocol, retention/archive or A/B readiness integration. Crashes can leave roots;
automatic scavenging is deferred. Absolute paths and command behavior can modify
originals or other external state: a copy is not an OS sandbox.

## Final Phase 3.0 verification

Supplied final results: production core typecheck and build passed; the focused
core suite passed all 99 tests in four files in 5.44 seconds, after all
command-input, Git-policy and listener-lifecycle corrections. All 18 approved
Phase 3.0 files were staged before this documentation update. Both
`git diff --check` and `git diff --cached --check` passed; `git diff --name-only`
and `git ls-files --others --exclude-standard` were empty.

No scenario suite, adapter, evidence pipeline, CLI integration or scoring
execution occurred. The core remains an early Phase 3.0 clone/run/inspect/discard
slice, not an OS sandbox or completion of Phase 3. Existing verification history
and limitations above remain applicable. These results are supplied history;
no tests were rerun for this documentation update.
